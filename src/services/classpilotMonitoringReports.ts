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
  calculateHeartbeatCoverageV1,
  trackingPolicyDisabledIntervals,
  type CoverageInterval,
} from "./classpilotHeartbeatCoverage.js";
import { classpilotSessionReportV2Mode } from "../config/classpilotSessionReportRollout.js";

const REPORT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function reportSafetyReviewStatus(
  value: string | null | undefined
): "Automated" | "Confirmed" | "Dismissed" | "Escalated" {
  if (value === "confirmed") return "Confirmed";
  if (value === "dismissed") return "Dismissed";
  if (value === "escalated") return "Escalated";
  return "Automated";
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

export function materializeV1Students(
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
    const coverage = calculateHeartbeatCoverageV1({
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
      // Kept on the strict in-memory shape so callers cannot accidentally
      // treat missing values as v2 evidence. completeClasspilotSessionReport
      // deliberately omits these columns when the stored reportVersion is 1.
      unclassifiedSeconds: 0,
      offTaskSeconds: 0,
      offTaskEventCount: 0,
      offTaskEvents: [],
      safetyAlerts: [],
    };
  });
}

export function materializeV2Students(
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
    const decisionByHeartbeatId = new Map<string, ClasspilotSessionReportInput["aiDecisions"][number]>();
    for (const decision of input.aiDecisions || []) {
      if (decision.studentId !== rosterStudent.studentId || !decision.heartbeatId) continue;
      // Input is newest-first, so the first decision is the immutable winner
      // if a legacy duplicate exists for one heartbeat.
      if (!decisionByHeartbeatId.has(decision.heartbeatId)) {
        decisionByHeartbeatId.set(decision.heartbeatId, decision);
      }
    }
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
        .map((heartbeat) => {
          const decision = decisionByHeartbeatId.get(heartbeat.id);
          return {
            timestamp: heartbeat.timestamp,
            url: heartbeat.activeTabUrl,
            category: decision?.category || heartbeat.aiCategory,
            // A teacher-intent classification is an explicit exemption from
            // off-task arithmetic. It does not suppress a safety alert.
            teacherIntentExempt: !!decision?.teacherIntentSource,
          };
        }),
    });
    const eventCounts: Record<string, number> = {};
    for (const event of input.monitoringEvents) {
      if (event.studentId !== rosterStudent.studentId) continue;
      eventCounts[event.eventType] = (eventCounts[event.eventType] || 0) + 1;
    }
    if (coverage.gaps.length > 0) {
      eventCounts.monitoring_gap = coverage.gaps.length;
    }
    const safetyCandidates = input.heartbeats
      .filter((heartbeat) => heartbeat.studentId === rosterStudent.studentId)
      .flatMap((heartbeat) => {
        const decision = decisionByHeartbeatId.get(heartbeat.id);
        const category = decision?.safetyAlert || heartbeat.safetyAlert;
        if (!category) return [];
        const exactSession = sessions.find((session) =>
          session.startedAt <= heartbeat.timestamp
          && (session.endedAt || report.windowEnd) > heartbeat.timestamp
        );
        const evidenceAvailable = !!exactSession && (input.evidenceArtifacts || []).some((artifact) =>
          artifact.studentId === rosterStudent.studentId
          && artifact.studentSessionId === exactSession.id
          && artifact.sourceId === heartbeat.id
          && artifact.status === "available"
        );
        return [{
          category,
          domain: normalizedDomain(decision?.domain || heartbeat.activeTabUrl),
          occurredAt: heartbeat.timestamp.toISOString(),
          evidenceAvailability: evidenceAvailable ? "available" as const : "unavailable" as const,
          reviewStatus: reportSafetyReviewStatus(decision?.reviewStatus),
        }];
      })
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)
        || a.category.localeCompare(b.category)
        || String(a.domain || "").localeCompare(String(b.domain || "")));
    // The live path deliberately suppresses duplicate notifications for the
    // same category/domain. Preserve that occurrence semantics in the frozen
    // report even if legacy heartbeat rows repeated the classification.
    const safetyAlerts = safetyCandidates.reduce<typeof safetyCandidates>((alerts, candidate) => {
      const previous = alerts.at(-1);
      if (previous
        && previous.category === candidate.category
        && previous.domain === candidate.domain
        && new Date(candidate.occurredAt).getTime() - new Date(previous.occurredAt).getTime() < 10 * 60_000) {
        if (previous.evidenceAvailability === "unavailable"
          && candidate.evidenceAvailability === "available") {
          previous.evidenceAvailability = "available";
        }
        if (previous.reviewStatus === "Automated" && candidate.reviewStatus !== "Automated") {
          previous.reviewStatus = candidate.reviewStatus;
        }
        return alerts;
      }
      alerts.push({ ...candidate });
      return alerts;
    }, []);
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
      unclassifiedSeconds: coverage.unclassifiedSeconds,
      offTaskSeconds: coverage.offTaskSeconds,
      offTaskEventCount: coverage.offTaskEventCount,
      offTaskEvents: coverage.offTaskEvents.map((event) => ({
        ...event,
        start: event.start.toISOString(),
        end: event.end.toISOString(),
      })),
      safetyAlerts,
    };
  });
}

/** Persisted materialization is selected only by the immutable row version. */
export function materializeStudents(
  report: ClasspilotSessionReport,
  input: ClasspilotSessionReportInput
): MaterializedClasspilotStudentReport[] {
  return report.reportVersion >= 2
    ? materializeV2Students(report, input)
    : materializeV1Students(report, input);
}

type ShadowAggregate = {
  roster: number;
  eligibleSeconds: number;
  observedSeconds: number;
  gapSeconds: number;
  heartbeatCount: number;
  topDomainSeconds: number;
};

function shadowAggregate(students: readonly MaterializedClasspilotStudentReport[]): ShadowAggregate {
  return students.reduce<ShadowAggregate>((total, student) => ({
    roster: total.roster + 1,
    eligibleSeconds: total.eligibleSeconds + student.eligibleSeconds,
    observedSeconds: total.observedSeconds + student.observedSeconds,
    gapSeconds: total.gapSeconds + student.gapSeconds,
    heartbeatCount: total.heartbeatCount + student.heartbeatCount,
    topDomainSeconds: total.topDomainSeconds
      + student.topDomains.reduce((sum, domain) => sum + domain.seconds, 0),
  }), {
    roster: 0,
    eligibleSeconds: 0,
    observedSeconds: 0,
    gapSeconds: 0,
    heartbeatCount: 0,
    topDomainSeconds: 0,
  });
}

export function classpilotReportV2ShadowComparison(
  v1Students: readonly MaterializedClasspilotStudentReport[],
  v2Students: readonly MaterializedClasspilotStudentReport[]
): { aggregateMismatch: boolean; invariantViolation: boolean } {
  const aggregateMismatch = JSON.stringify(shadowAggregate(v1Students))
    !== JSON.stringify(shadowAggregate(v2Students));
  const invariantViolation = v2Students.some((student) => {
    const unclassifiedSeconds = student.unclassifiedSeconds || 0;
    const offTaskSeconds = student.offTaskSeconds || 0;
    const domainSeconds = student.topDomains.reduce((sum, domain) => sum + domain.seconds, 0);
    return student.observedSeconds > student.eligibleSeconds
      || student.gapSeconds > student.eligibleSeconds
      || unclassifiedSeconds > student.observedSeconds
      || offTaskSeconds > student.observedSeconds
      || domainSeconds > student.observedSeconds;
  });
  return { aggregateMismatch, invariantViolation };
}

function emitClasspilotReportV2ShadowMetrics(options: {
  durationMs: number;
  aggregateMismatch: boolean;
  invariantViolation: boolean;
}) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot",
        Dimensions: [["Environment"]],
        Metrics: [
          { Name: "SessionReportV2ShadowDuration", Unit: "Milliseconds" },
          { Name: "SessionReportV2ShadowAggregateMismatch", Unit: "Count" },
          { Name: "SessionReportV2ShadowInvariantViolation", Unit: "Count" },
        ],
      }],
    },
    Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    SessionReportV2ShadowDuration: Math.max(0, Math.round(options.durationMs)),
    SessionReportV2ShadowAggregateMismatch: options.aggregateMismatch ? 1 : 0,
    SessionReportV2ShadowInvariantViolation: options.invariantViolation ? 1 : 0,
  }));
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
      if (report.reportVersion === 1 && classpilotSessionReportV2Mode() === "shadow") {
        const shadowStartedAt = Date.now();
        try {
          const v2Students = materializeV2Students(report, input);
          const comparison = classpilotReportV2ShadowComparison(students, v2Students);
          emitClasspilotReportV2ShadowMetrics({
            durationMs: Date.now() - shadowStartedAt,
            ...comparison,
          });
        } catch {
          // Shadow evaluation can never change, delay-retry, or fail the
          // authoritative v1 report. Its only output is identifier-free health
          // telemetry.
          emitClasspilotReportV2ShadowMetrics({
            durationMs: Date.now() - shadowStartedAt,
            aggregateMismatch: false,
            invariantViolation: true,
          });
        }
      }
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
