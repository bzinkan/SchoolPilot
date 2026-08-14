import { randomUUID } from "node:crypto";
import type db from "../db.js";
import type { ClasspilotSessionReport } from "../schema/classpilot.js";
import errorMonitor from "./errorMonitor.js";
import {
  claimDueClasspilotSessionReports,
  completeClasspilotSessionReport,
  failClasspilotSessionReport,
  getClasspilotSessionReportInput,
  type ClasspilotSessionReportInput,
  type MaterializedClasspilotStudentReport,
} from "./storage.js";
import {
  calculateHeartbeatCoverage,
  trackingPolicyDisabledIntervals,
  type CoverageInterval,
} from "./classpilotHeartbeatCoverage.js";

const REPORT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function serverTrackingDisabledIntervals(
  input: ClasspilotSessionReportInput,
  studentId: string,
  windowStart: Date,
  windowEnd: Date
): CoverageInterval[] {
  const transitions = input.monitoringEvents
    // Extension telemetry is useful evidence that a signal changed, but it is
    // not an authority for shrinking report eligibility. Only a server-authored
    // policy transition may exclude otherwise authenticated time.
    .filter((event) => event.studentId === studentId
      && event.eventType === "monitoring_state_changed"
      && event.origin === "server")
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const intervals: CoverageInterval[] = [];
  let disabledAt: Date | null = null;
  for (const event of transitions) {
    const state = String(metadataRecord(event.metadata).state || "").toLowerCase();
    const disabled = ["off", "disabled", "tracking_disabled"].includes(state);
    const enabled = ["active", "idle", "on", "enabled"].includes(state);
    if (disabled && !disabledAt) disabledAt = event.occurredAt < windowStart ? windowStart : event.occurredAt;
    if (enabled && disabledAt) {
      intervals.push({ start: disabledAt, end: event.occurredAt > windowEnd ? windowEnd : event.occurredAt });
      disabledAt = null;
    }
  }
  if (disabledAt) intervals.push({ start: disabledAt, end: windowEnd });
  return intervals.filter((interval) => interval.end > interval.start);
}

export function materializeStudents(
  report: ClasspilotSessionReport,
  input: ClasspilotSessionReportInput
): MaterializedClasspilotStudentReport[] {
  const policyDisabled = trackingPolicyDisabledIntervals(
    input.trackingPolicy,
    report.windowStart,
    report.windowEnd
  );
  return input.roster.map((rosterStudent) => {
    const sessions = input.authenticatedSessions.filter((session) => session.studentId === rosterStudent.studentId);
    const authenticatedIntervals: CoverageInterval[] = sessions.map((session) => ({
      start: new Date(Math.max(
        report.windowStart.getTime(),
        rosterStudent.capturedAt.getTime(),
        session.startedAt.getTime()
      )),
      end: session.endedAt || report.windowEnd,
      studentSessionId: session.id,
    }));
    const exclusions: CoverageInterval[] = [
      ...input.exclusions
        .filter((interval) => interval.studentId === rosterStudent.studentId)
        .map((interval) => ({ start: interval.start, end: interval.end })),
      ...serverTrackingDisabledIntervals(
        input,
        rosterStudent.studentId,
        report.windowStart,
        report.windowEnd
      ),
      ...policyDisabled,
    ];
    const coverage = calculateHeartbeatCoverage({
      windowStart: report.windowStart,
      windowEnd: report.windowEnd,
      authenticatedIntervals,
      excludedIntervals: exclusions,
      heartbeats: input.heartbeats
        .filter((heartbeat) => heartbeat.studentId === rosterStudent.studentId)
        .map((heartbeat) => ({ timestamp: heartbeat.timestamp, url: heartbeat.activeTabUrl })),
    });
    const eventCounts: Record<string, number> = {};
    for (const event of input.monitoringEvents) {
      if (event.studentId !== rosterStudent.studentId) continue;
      eventCounts[event.eventType] = (eventCounts[event.eventType] || 0) + 1;
    }
    if (coverage.gaps.length > 0) {
      eventCounts.monitoring_gap = coverage.gaps.length;
    }
    return {
      studentId: rosterStudent.studentId,
      studentNameSnapshot: rosterStudent.studentName,
      status: coverage.status,
      eligibleSeconds: coverage.eligibleSeconds,
      observedSeconds: coverage.observedSeconds,
      gapSeconds: coverage.gapSeconds,
      coveragePercent: coverage.coveragePercent,
      heartbeatCount: coverage.heartbeatCount,
      firstObservedAt: coverage.firstObservedAt,
      lastObservedAt: coverage.lastObservedAt,
      gapIntervals: coverage.gaps.flatMap((gap) => {
        const studentSessionId = gap.studentSessionId
          || sessions.find((session) => session.startedAt <= gap.start && (session.endedAt || report.windowEnd) >= gap.end)?.id
          || sessions[0]?.id;
        return studentSessionId ? [{
          start: gap.start.toISOString(),
          end: gap.end.toISOString(),
          durationSeconds: gap.durationSeconds,
          cause: "unknown" as const,
          studentSessionId,
        }] : [];
      }),
      eventCounts,
      topDomains: coverage.topDomains,
    };
  });
}

export type ClasspilotReportMaterializationCounts = {
  claimed: number;
  ready: number;
  retry: number;
  failed: number;
};

export async function materializeDueClasspilotSessionReports(options: {
  dbInstance?: typeof db;
  now?: Date;
  clock?: () => Date;
  limit?: number;
  schoolId?: string;
  teachingSessionId?: string;
} = {}): Promise<ClasspilotReportMaterializationCounts> {
  const clock = options.clock || (options.now
    ? () => new Date(options.now!.getTime())
    : () => new Date());
  const claimNow = options.now || clock();
  const leaseOwner = `${process.pid}:${randomUUID()}`;
  const claimed = await claimDueClasspilotSessionReports({
    leaseOwner,
    now: claimNow,
    limit: options.limit || 25,
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
  }, options.dbInstance);
  const reports = claimed.reports;
  const counts = {
    claimed: reports.length,
    ready: 0,
    retry: 0,
    failed: claimed.exhaustedLeaseCount,
  };
  if (claimed.exhaustedLeaseCount > 0) {
    errorMonitor.trackError(
      "scheduler_failure",
      new Error("ClassPilot immutable session report generation exhausted retries after a worker lease expired"),
      { job: "classpilot_report_materialization", errorCode: "SESSION_REPORT_FAILED" },
      { priority: "high" }
    );
  }
  for (const report of reports) {
    try {
      const input = await getClasspilotSessionReportInput(report, options.dbInstance);
      if (!input) {
        const result = await failClasspilotSessionReport({
          reportId: report.id,
          leaseOwner,
          error: "Frozen finalized-session input was unavailable",
          failedAt: clock(),
        }, options.dbInstance);
        if (result === "failed") counts.failed += 1;
        if (result === "failed") {
          errorMonitor.trackError(
            "scheduler_failure",
            new Error("ClassPilot immutable report lacked its frozen roster or tracking policy"),
            { job: "classpilot_report_materialization", errorCode: "SESSION_REPORT_FROZEN_INPUT_MISSING" },
            { priority: "high" }
          );
        }
        continue;
      }
      const students = materializeStudents(report, input);
      const rosterIds = new Set(input.roster.map((student) => student.studentId));
      const isDelegatedAt = (studentId: string, occurredAt: Date) => input.exclusions.some(
        (interval) => interval.studentId === studentId
          && interval.start <= occurredAt
          && interval.end > occurredAt
      );
      const sessionBoundaryEvents = input.authenticatedSessions.flatMap((session) => {
        if (!rosterIds.has(session.studentId)) return [];
        const events: Array<{
          studentId: string;
          studentSessionId: string;
          eventType: "student_session_started" | "student_session_ended";
          occurredAt: Date;
        }> = [];
        if (
          session.startedAt >= report.windowStart
          && session.startedAt < report.windowEnd
          && !isDelegatedAt(session.studentId, session.startedAt)
        ) {
          events.push({
            studentId: session.studentId,
            studentSessionId: session.id,
            eventType: "student_session_started",
            occurredAt: session.startedAt,
          });
        }
        if (
          session.endedAt
          && session.endedAt >= report.windowStart
          && session.endedAt < report.windowEnd
          && !isDelegatedAt(session.studentId, session.endedAt)
        ) {
          events.push({
            studentId: session.studentId,
            studentSessionId: session.id,
            eventType: "student_session_ended",
            occurredAt: session.endedAt,
          });
        }
        return events;
      });
      const completedAt = clock();
      const ready = await completeClasspilotSessionReport({
        report,
        leaseOwner,
        students,
        sessionBoundaryEvents,
        completedAt,
      }, options.dbInstance);
      if (ready) counts.ready += 1;
    } catch (error) {
      const failedAt = clock();
      const retryDelay = REPORT_RETRY_DELAYS_MS[report.attemptCount - 1];
      const result = await failClasspilotSessionReport({
        reportId: report.id,
        leaseOwner,
        error: error instanceof Error ? error.message : "Session report materialization failed",
        retryAt: retryDelay ? new Date(failedAt.getTime() + retryDelay) : undefined,
        failedAt,
      }, options.dbInstance);
      if (result === "retry") counts.retry += 1;
      if (result === "failed") {
        counts.failed += 1;
        errorMonitor.trackError(
          "scheduler_failure",
          new Error("ClassPilot immutable session report generation exhausted retries"),
          { job: "classpilot_report_materialization", errorCode: "SESSION_REPORT_FAILED" },
          { priority: "high" }
        );
      }
    }
  }
  return counts;
}
