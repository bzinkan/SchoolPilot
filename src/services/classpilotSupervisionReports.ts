import { randomUUID } from "node:crypto";
import { and, eq, gt, gte, inArray, isNull, lt, lte, ne, not, sql, desc } from "drizzle-orm";
import db from "../db.js";
import {
  classpilotAiDecisions, classpilotEvidenceCaptureRequests, classpilotMonitoringEvents,
  evidenceArtifacts, heartbeats, schoolMemberships, schools, students, studentSessions, users,
} from "../schema/index.js";
import {
  classpilotSupervisionReportSegments as reports,
  classpilotSupervisionStudentReports as details,
  classpilotSupervisionSummaryDeliveries as deliveries,
} from "../schema/classpilotSupervisionReports.js";
import {
  materializeV2Students, serverTrackingDisabledIntervals,
  type ClasspilotActivityReportInput, type ClasspilotActivityReportWindow,
} from "./classpilotMonitoringReports.js";
import { subtractCoverageIntervals, trackingPolicyDisabledIntervals, type CoverageInterval } from "./classpilotHeartbeatCoverage.js";
import { type MaterializedClasspilotStudentReport } from "./storage.js";
import { emailProviderConfigured, sendSessionSummaryEmailWithResult, type SessionSummaryEmailOptions } from "./email.js";
import errorMonitor from "./errorMonitor.js";
import { supervisionCurrentRetentionExpired } from "./classpilotSupervisionReportLifecycle.js";

type Report = typeof reports.$inferSelect;
type Delivery = typeof deliveries.$inferSelect;
type StudentDetail = typeof details.$inferSelect;
type WorkerOptions = { dbInstance?: typeof db; schoolId?: string; now?: Date; clock?: () => Date; limit?: number };
type FrozenSummary = Omit<SessionSummaryEmailOptions, "to" | "deliveryId">;
const RETRY_MINUTES = [1, 5, 15, 60, 180] as const;
const LEASE_MS = 5 * 60_000;

function workerClock(options: WorkerOptions): () => Date {
  // `now` selects a candidate batch only. Retention/submission fences must use
  // advancing wall time; tests that simulate history inject an explicit clock.
  return options.clock || (() => new Date());
}
function scope(schoolId?: string) { return schoolId ? eq(reports.schoolId, schoolId) : undefined; }
function deliveryScope(schoolId?: string) { return schoolId ? eq(deliveries.schoolId, schoolId) : undefined; }
function monitor(code: string, category: "email_failure" | "scheduler_failure" = "scheduler_failure") {
  errorMonitor.trackError(category, new Error(`Supervision activity summary: ${code}`), {
    job: "classpilot_supervision_summaries", errorCode: code,
  }, { priority: "high" });
}

/** Clip assignment snapshots at the immutable staff-tenure boundary. */
export function supervisionParticipationIntervals(
  report: ClasspilotActivityReportWindow,
  intervals: Array<{ start: string; end: string | null }>,
): CoverageInterval[] {
  if (!Array.isArray(intervals) || intervals.some((interval) => !interval || !interval.start
    || !Number.isFinite(new Date(interval.start).getTime())
    || (interval.end !== null && !Number.isFinite(new Date(interval.end).getTime())))) {
    throw new Error("SUPERVISION_PARTICIPATION_INPUT_INVALID");
  }
  return subtractCoverageIntervals(intervals.map((interval) => ({
    start: new Date(Math.max(report.windowStart.getTime(), new Date(interval.start).getTime())),
    end: new Date(Math.min(report.windowEnd.getTime(), interval.end ? new Date(interval.end).getTime() : report.windowEnd.getTime())),
  })).filter((interval) => Number.isFinite(interval.start.getTime())
    && Number.isFinite(interval.end.getTime()) && interval.end > interval.start), []);
}

/** All metrics, including embedded safety, are calculated over the same ownership. */
export function materializeSupervisionStudents(
  report: ClasspilotActivityReportWindow,
  input: ClasspilotActivityReportInput,
  participation: ReadonlyMap<string, CoverageInterval[]>,
): MaterializedClasspilotStudentReport[] {
  const ownedInput: ClasspilotActivityReportInput = {
    ...input,
    exclusions: [...input.exclusions, ...input.roster.flatMap((student) => subtractCoverageIntervals(
      [{ start: report.windowStart, end: report.windowEnd }],
      participation.get(student.studentId) || [],
    ).map((interval) => ({ ...interval, studentId: student.studentId, source: "delegated_supervision" as const })))],
  };
  const policyDisabled = trackingPolicyDisabledIntervals(input.trackingPolicy, report.windowStart, report.windowEnd);
  return materializeV2Students(report, ownedInput).map((student) => {
    const expected = subtractCoverageIntervals(participation.get(student.studentId) || [], [
      ...policyDisabled,
      ...serverTrackingDisabledIntervals(input, student.studentId, report.windowStart, report.windowEnd),
    ]);
    // No authenticated session is missing evidence, not proof monitoring was off.
    if (student.status === "not_expected" && expected.length > 0) {
      return { ...student, status: "unavailable", coveragePercent: null };
    }
    return student;
  });
}

async function loadReportInput(report: Report, children: StudentDetail[], dbInstance: typeof db): Promise<ClasspilotActivityReportInput> {
  if (!report.windowEnd || !report.trackingPolicy) throw new Error("SUPERVISION_FROZEN_INPUT_MISSING");
  const windowEnd = report.windowEnd;
  const studentIds = children.map((student) => student.studentId);
  const base: ClasspilotActivityReportInput = {
    roster: children.map((student) => ({ studentId: student.studentId,
      studentName: student.studentNameSnapshot, capturedAt: report.windowStart })),
    authenticatedSessions: [], heartbeats: [], aiDecisions: [], evidenceArtifacts: [],
    exclusions: [], monitoringEvents: [], trackingPolicy: {
      enableTrackingHours: report.trackingPolicy.enableTrackingHours === true,
      trackingStartTime: report.trackingPolicy.trackingStartTime || null,
      trackingEndTime: report.trackingPolicy.trackingEndTime || null,
      trackingDays: report.trackingPolicy.trackingDays || [],
      schoolTimezone: report.trackingPolicy.schoolTimezone || report.timezone,
      afterHoursMode: report.trackingPolicy.afterHoursMode || "off",
    },
  };
  if (!studentIds.length) return base;
  const heartbeatScope = and(eq(heartbeats.schoolId, report.schoolId), inArray(heartbeats.studentId, studentIds),
    sql`${heartbeats.timestamp} >= ${report.windowStart.toISOString()}`, sql`${heartbeats.timestamp} < ${windowEnd.toISOString()}`);
  const heartbeatIdsQuery = dbInstance.select({ id: heartbeats.id }).from(heartbeats).where(heartbeatScope);
  const [authenticatedSessions, heartbeatRows, monitoringEvents, priorPolicyEvents] = await Promise.all([
    dbInstance.select({ id: studentSessions.id, studentId: studentSessions.studentId,
      startedAt: studentSessions.startedAt, endedAt: studentSessions.endedAt, lastSeenAt: studentSessions.lastSeenAt })
      .from(studentSessions).innerJoin(students, and(eq(students.id, studentSessions.studentId), eq(students.schoolId, report.schoolId)))
      .where(and(inArray(studentSessions.studentId, studentIds), sql`${studentSessions.startedAt} < ${windowEnd.toISOString()}`,
        sql`coalesce(${studentSessions.endedAt}, ${windowEnd.toISOString()}) > ${report.windowStart.toISOString()}`)),
    dbInstance.select({ id: heartbeats.id, studentId: heartbeats.studentId, timestamp: heartbeats.timestamp,
      activeTabUrl: heartbeats.activeTabUrl, aiCategory: heartbeats.aiCategory, contentCategory: heartbeats.contentCategory,
      teacherIntentSource: heartbeats.teacherIntentSource, safetyAlert: heartbeats.safetyAlert,
    }).from(heartbeats).where(heartbeatScope).orderBy(heartbeats.studentId, heartbeats.timestamp),
    dbInstance.select().from(classpilotMonitoringEvents).where(and(
      eq(classpilotMonitoringEvents.schoolId, report.schoolId), inArray(classpilotMonitoringEvents.studentId, studentIds),
      gte(classpilotMonitoringEvents.occurredAt, report.windowStart), lt(classpilotMonitoringEvents.occurredAt, windowEnd),
      ne(classpilotMonitoringEvents.eventType, "monitoring_gap"),
    )),
    // Carry the last server policy state across the report's opening boundary.
    dbInstance.selectDistinctOn([classpilotMonitoringEvents.studentId]).from(classpilotMonitoringEvents).where(and(
      eq(classpilotMonitoringEvents.schoolId, report.schoolId), inArray(classpilotMonitoringEvents.studentId, studentIds),
      eq(classpilotMonitoringEvents.origin, "server"), eq(classpilotMonitoringEvents.eventType, "monitoring_state_changed"),
      lt(classpilotMonitoringEvents.occurredAt, report.windowStart),
    )).orderBy(classpilotMonitoringEvents.studentId, desc(classpilotMonitoringEvents.occurredAt), desc(classpilotMonitoringEvents.id)),
  ]);
  // A bounded student/time subquery avoids PostgreSQL's parameter ceiling for
  // long blocks with tens of thousands of heartbeats; no observations truncate.
  const [aiDecisions, ambientArtifacts, capturedArtifacts] = heartbeatRows.length ? await Promise.all([
    dbInstance.select({ id: classpilotAiDecisions.id, heartbeatId: classpilotAiDecisions.heartbeatId,
      studentId: classpilotAiDecisions.studentId, domain: classpilotAiDecisions.domain, category: classpilotAiDecisions.category,
      safetyAlert: classpilotAiDecisions.safetyAlert, teacherIntentSource: classpilotAiDecisions.teacherIntentSource,
      reviewStatus: classpilotAiDecisions.reviewStatus, createdAt: classpilotAiDecisions.createdAt })
      .from(classpilotAiDecisions).where(and(eq(classpilotAiDecisions.schoolId, report.schoolId), inArray(classpilotAiDecisions.heartbeatId, heartbeatIdsQuery)))
      .orderBy(classpilotAiDecisions.heartbeatId, desc(classpilotAiDecisions.createdAt), desc(classpilotAiDecisions.id)),
    dbInstance.select({ studentId: evidenceArtifacts.studentId, studentSessionId: evidenceArtifacts.studentSessionId,
      sourceId: evidenceArtifacts.sourceId, status: evidenceArtifacts.status }).from(evidenceArtifacts).where(and(
        eq(evidenceArtifacts.schoolId, report.schoolId), eq(evidenceArtifacts.sourceType, "classpilot_screenshot"), inArray(evidenceArtifacts.sourceId, heartbeatIdsQuery))),
    dbInstance.select({ studentId: evidenceArtifacts.studentId, studentSessionId: evidenceArtifacts.studentSessionId,
      sourceId: classpilotEvidenceCaptureRequests.heartbeatId, status: evidenceArtifacts.status })
      .from(classpilotEvidenceCaptureRequests).innerJoin(evidenceArtifacts, and(
        eq(evidenceArtifacts.id, classpilotEvidenceCaptureRequests.artifactId),
        eq(evidenceArtifacts.schoolId, classpilotEvidenceCaptureRequests.schoolId),
        eq(evidenceArtifacts.studentId, classpilotEvidenceCaptureRequests.studentId),
        eq(evidenceArtifacts.studentSessionId, classpilotEvidenceCaptureRequests.studentSessionId),
        eq(evidenceArtifacts.deviceId, classpilotEvidenceCaptureRequests.deviceId),
        eq(evidenceArtifacts.sourceType, "classpilot_safety_capture"), eq(evidenceArtifacts.sourceId, classpilotEvidenceCaptureRequests.id),
      )).where(and(eq(classpilotEvidenceCaptureRequests.schoolId, report.schoolId), inArray(classpilotEvidenceCaptureRequests.heartbeatId, heartbeatIdsQuery))),
  ]) : [[], [], []];
  return { ...base, authenticatedSessions, heartbeats: heartbeatRows, aiDecisions,
    evidenceArtifacts: [...ambientArtifacts, ...capturedArtifacts], monitoringEvents: [...priorPolicyEvents, ...monitoringEvents] };
}

export function buildSupervisionSummary(
  report: Pick<Report, "windowStart" | "windowEnd" | "reportVersion" | "timezone" | "staffNameSnapshot" | "contextNameSnapshot" | "partialAdoption" | "closureReason">,
  materialized: MaterializedClasspilotStudentReport[], participation: ReadonlyMap<string, CoverageInterval[]>,
): FrozenSummary {
  if (!report.windowEnd) throw new Error("SUPERVISION_REPORT_NOT_CLOSED");
  const timeZone = report.timezone;
  const formatTime = (date: Date) => date.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  const notices = [`Activity covers only the students and times supervised by ${report.staffNameSnapshot || "the assigned teacher"}. School timezone: ${timeZone}.`];
  if (report.partialAdoption) notices.push("This first summary starts when supervision reporting was enabled. Earlier activity is not included.");
  if (materialized.some((student) => !["complete", "not_expected"].includes(student.status))) {
    notices.push("Observed browser telemetry was unavailable or incomplete for some students. Monitoring coverage shows measured gaps without assigning a cause.");
  }
  return {
    reportVersion: report.reportVersion, teacherName: report.staffNameSnapshot || "Teacher",
    className: report.contextNameSnapshot || "Supervision", date: report.windowStart.toLocaleDateString("en-US", {
      timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric",
    }), startTime: formatTime(report.windowStart), endTime: formatTime(report.windowEnd),
    duration: `${Math.max(0, Math.round((report.windowEnd.getTime() - report.windowStart.getTime()) / 60_000))} min`,
    studentCount: materialized.length, copyNotice: notices.join(" "),
    students: materialized.map((student) => ({
      name: student.studentNameSnapshot, totalMinutes: Math.round(student.observedSeconds / 60),
      topDomains: student.topDomains.slice(0, 5).map((domain) => ({ domain: domain.domain, minutes: Math.round(domain.seconds / 60) })),
      topActivities: student.topActivities.slice(0, 5).map((activity) => ({ kind: activity.kind, domain: activity.domain, minutes: Math.round(activity.seconds / 60) })),
      offTaskCount: student.offTaskEventCount, offTaskMinutes: Math.round(student.offTaskSeconds / 60),
      unclassifiedMinutes: Math.round(student.unclassifiedSeconds / 60),
      safetyAlerts: student.safetyAlerts.map((alert) => alert.category),
      safetyUrls: student.safetyAlerts.map((alert) => alert.domain || "Unavailable"),
      safetyReviewStatuses: student.safetyAlerts.map((alert) => alert.reviewStatus),
      coverageStatus: student.status, coveragePercent: student.coveragePercent, gapMinutes: Math.round(student.gapSeconds / 60),
      participationWindows: (participation.get(student.studentId) || []).map((interval) => ({ start: formatTime(interval.start), end: formatTime(interval.end) })),
    })),
  };
}

export async function materializeDueClasspilotSupervisionReports(options: WorkerOptions = {}) {
  const dbInstance = options.dbInstance || db;
  const clock = workerClock(options), now = options.now || clock();
  const leaseOwner = `${process.pid}:${randomUUID()}`;
  const claimed = await dbInstance.transaction(async (tx) => {
    const exhausted = await tx.update(reports).set({ state: "failed", leaseOwner: null, leaseExpiresAt: null,
      lastError: "Report generation exhausted its recovery attempts", updatedAt: now }).where(and(scope(options.schoolId),
      eq(reports.state, "materializing"), lte(reports.leaseExpiresAt, now), gte(reports.attemptCount, RETRY_MINUTES.length + 1))).returning({ id: reports.id });
    if (exhausted.length) monitor("SUPERVISION_REPORT_EXHAUSTED");
    await tx.update(deliveries).set({ state: "failed", lastError: "Immutable supervision report generation failed", updatedAt: now })
      .where(and(deliveryScope(options.schoolId), eq(deliveries.state, "waiting_report"),
        sql`EXISTS (SELECT 1 FROM ${reports} WHERE ${reports.id} = ${deliveries.reportId}
          AND ${reports.schoolId} = ${deliveries.schoolId} AND ${reports.state} = 'failed')`));
    await tx.update(reports).set({ state: "pending", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now, updatedAt: now })
      .where(and(scope(options.schoolId), eq(reports.state, "materializing"), lte(reports.leaseExpiresAt, now), lt(reports.attemptCount, RETRY_MINUTES.length + 1)));
    const rows = await tx.select({ id: reports.id }).from(reports).where(and(scope(options.schoolId),
      eq(reports.state, "pending"), lte(reports.settleAt, now), lte(reports.nextAttemptAt, now), gt(reports.expiresAt, now),
      not(supervisionCurrentRetentionExpired(now)), isNull(reports.detailExpiredAt)))
      .orderBy(reports.nextAttemptAt, reports.id).limit(Math.max(1, Math.min(options.limit || 25, 100))).for("update", { skipLocked: true });
    if (!rows.length) return [];
    return tx.update(reports).set({ state: "materializing", leaseOwner, leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      attemptCount: sql`${reports.attemptCount} + 1`, updatedAt: now }).where(inArray(reports.id, rows.map((row) => row.id))).returning();
  });
  const counts = { claimed: claimed.length, ready: 0, retry: 0, failed: 0 };
  for (const report of claimed) {
    try {
      if (!report.windowEnd) throw new Error("SUPERVISION_REPORT_NOT_CLOSED");
      const children = await dbInstance.select().from(details).where(and(eq(details.schoolId, report.schoolId), eq(details.reportId, report.id)));
      const window = { windowStart: report.windowStart, windowEnd: report.windowEnd, reportVersion: report.reportVersion };
      const participation = new Map(children.map((student) => [student.studentId, supervisionParticipationIntervals(window, student.participationIntervals)]));
      const materialized: MaterializedClasspilotStudentReport[] = [];
      // Keep only compact metric results between chunks. A school-wide testing
      // block must not retain every student's raw heartbeat history in memory.
      for (let offset = 0; offset < children.length; offset += 25) {
        const asOf = clock();
        if (!report.leaseExpiresAt || report.leaseExpiresAt <= asOf || !report.expiresAt || report.expiresAt <= asOf) {
          throw new Error("SUPERVISION_MATERIALIZATION_BOUNDARY_EXPIRED");
        }
        const calculated = await dbInstance.transaction(async (tx) => {
          const [eligible] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, report.id),
            eq(reports.schoolId, report.schoolId), eq(reports.state, "materializing"), eq(reports.leaseOwner, leaseOwner),
            gt(reports.leaseExpiresAt, asOf), gt(reports.expiresAt, asOf), isNull(reports.detailExpiredAt),
            not(supervisionCurrentRetentionExpired(asOf)))).limit(1);
          if (!eligible) throw new Error("SUPERVISION_MATERIALIZATION_BOUNDARY_EXPIRED");
          const input = await loadReportInput(report, children.slice(offset, offset + 25), tx as unknown as typeof db);
          return materializeSupervisionStudents(window, input, participation);
        }, { isolationLevel: "repeatable read", accessMode: "read only" });
        materialized.push(...calculated);
      }
      const summary = buildSupervisionSummary(report, materialized, participation);
      const completedAt = clock();
      const ready = await dbInstance.transaction(async (tx) => {
        const [locked] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.schoolId, report.schoolId), eq(reports.id, report.id),
          eq(reports.state, "materializing"), eq(reports.leaseOwner, leaseOwner), gt(reports.leaseExpiresAt, completedAt),
          gt(reports.expiresAt, completedAt), not(supervisionCurrentRetentionExpired(completedAt)), isNull(reports.detailExpiredAt))).for("update");
        if (!locked) return false;
        for (const student of materialized) await tx.update(details).set({ result: JSON.parse(JSON.stringify(student)), updatedAt: completedAt })
          .where(and(eq(details.schoolId, report.schoolId), eq(details.reportId, report.id), eq(details.studentId, student.studentId)));
        await tx.update(reports).set({ state: "ready", summary, materializedAt: completedAt, leaseOwner: null, leaseExpiresAt: null,
          lastError: null, updatedAt: completedAt }).where(and(eq(reports.schoolId, report.schoolId), eq(reports.id, report.id)));
        await tx.update(deliveries).set({ state: "queued", nextAttemptAt: completedAt, updatedAt: completedAt })
          .where(and(eq(deliveries.schoolId, report.schoolId), eq(deliveries.reportId, report.id), eq(deliveries.state, "waiting_report")));
        return true;
      });
      if (ready) counts.ready++;
    } catch {
      const failedAt = clock(), delay = RETRY_MINUTES[report.attemptCount - 1];
      const state = delay ? "pending" : "failed";
      await dbInstance.update(reports).set({ state, leaseOwner: null, leaseExpiresAt: null,
        nextAttemptAt: delay ? new Date(failedAt.getTime() + delay * 60_000) : null,
        lastError: "Supervision report materialization failed", updatedAt: failedAt }).where(and(eq(reports.id, report.id),
        eq(reports.schoolId, report.schoolId), eq(reports.state, "materializing"), eq(reports.leaseOwner, leaseOwner)));
      counts[delay ? "retry" : "failed"]++;
      if (!delay) monitor("SUPERVISION_REPORT_FAILED");
    }
  }
  return counts;
}

export type SupervisionSummaryTransport = typeof sendSessionSummaryEmailWithResult;
export type SupervisionSummaryDispatchCounts = { claimed: number; sent: number; retry: number; failed: number; unknown: number };

export function supervisionSummarySendingEnabled(): boolean {
  return process.env.CLASSPILOT_SUPERVISION_SUMMARY_EMAIL_ENABLED === "true";
}

export async function dispatchDueClasspilotSupervisionSummaries(options: WorkerOptions & { transport?: SupervisionSummaryTransport } = {}): Promise<SupervisionSummaryDispatchCounts> {
  const counts = { claimed: 0, sent: 0, retry: 0, failed: 0, unknown: 0 };
  if (!options.transport && !supervisionSummarySendingEnabled()) return counts;
  const dbInstance = options.dbInstance || db, clock = workerClock(options), now = options.now || clock();
  const leaseOwner = `${process.pid}:${randomUUID()}`, transport = options.transport || sendSessionSummaryEmailWithResult;
  const claimed = await dbInstance.transaction(async (tx) => {
    const ambiguous = await tx.update(deliveries).set({ state: "unknown", leaseOwner: null, leaseExpiresAt: null,
      lastError: "Worker stopped after provider submission began; delivery outcome is unknown", updatedAt: now })
      .where(and(deliveryScope(options.schoolId), eq(deliveries.state, "leased"), lte(deliveries.leaseExpiresAt, now),
        sql`${deliveries.submissionStartedAt} IS NOT NULL`)).returning({ id: deliveries.id });
    counts.unknown += ambiguous.length;
    await tx.update(deliveries).set({ state: "failed", leaseOwner: null, leaseExpiresAt: null,
      lastError: "Delivery preparation exhausted recovery attempts", updatedAt: now })
      .where(and(deliveryScope(options.schoolId), eq(deliveries.state, "leased"), lte(deliveries.leaseExpiresAt, now),
        isNull(deliveries.submissionStartedAt), gte(deliveries.attemptCount, RETRY_MINUTES.length)));
    await tx.update(deliveries).set({ state: "retry", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now,
      attemptCount: sql`${deliveries.attemptCount} + 1`, updatedAt: now })
      .where(and(deliveryScope(options.schoolId), eq(deliveries.state, "leased"), lte(deliveries.leaseExpiresAt, now),
        isNull(deliveries.submissionStartedAt), lt(deliveries.attemptCount, RETRY_MINUTES.length)));
    const rows = await tx.select({ id: deliveries.id }).from(deliveries).innerJoin(reports, and(eq(reports.id, deliveries.reportId), eq(reports.schoolId, deliveries.schoolId)))
      .where(and(deliveryScope(options.schoolId), inArray(deliveries.state, ["queued", "retry"]), lte(deliveries.nextAttemptAt, now),
        eq(reports.state, "ready"), gt(reports.expiresAt, now), not(supervisionCurrentRetentionExpired(now)), isNull(reports.detailExpiredAt)))
      .orderBy(deliveries.nextAttemptAt, deliveries.id).limit(Math.max(1, Math.min(options.limit || 50, 100))).for("update", { of: deliveries, skipLocked: true });
    if (!rows.length) return [];
    return tx.update(deliveries).set({ state: "leased", leaseOwner, leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      submissionStartedAt: null, updatedAt: now }).where(inArray(deliveries.id, rows.map((row) => row.id))).returning();
  });
  counts.claimed = claimed.length;
  if (counts.unknown) monitor("SUPERVISION_SUMMARY_UNKNOWN", "email_failure");
  async function complete(delivery: Delivery, state: "sent" | "retry" | "failed" | "unknown", options: { error?: string; providerMessageId?: string; nextAttemptAt?: Date; preparationAttempt?: boolean } = {}) {
    const completedAt = clock();
    const updated = await dbInstance.update(deliveries).set({ state, leaseOwner: null, leaseExpiresAt: null,
      lastError: options.error || null, providerMessageId: options.providerMessageId || null,
      ...(state === "sent" ? { sentAt: completedAt } : {}),
      ...(options.nextAttemptAt ? { nextAttemptAt: options.nextAttemptAt } : {}),
      ...(options.preparationAttempt ? { attemptCount: sql`${deliveries.attemptCount} + 1` } : {}), updatedAt: completedAt,
    }).where(and(eq(deliveries.id, delivery.id), eq(deliveries.schoolId, delivery.schoolId),
      eq(deliveries.state, "leased"), eq(deliveries.leaseOwner, leaseOwner))).returning({ id: deliveries.id });
    if (updated.length) counts[state]++;
  }
  // Bounded transport concurrency keeps a large group from saturating worker sockets.
  for (let offset = 0; offset < claimed.length; offset += 5) await Promise.all(claimed.slice(offset, offset + 5).map(async (delivery) => {
    let submitted = false;
    try {
      const [report] = await dbInstance.select().from(reports).where(and(eq(reports.schoolId, delivery.schoolId), eq(reports.id, delivery.reportId),
        eq(reports.state, "ready"), gt(reports.expiresAt, clock()), not(supervisionCurrentRetentionExpired(clock())), isNull(reports.detailExpiredAt))).limit(1);
      if (!report?.summary) { await complete(delivery, "failed", { error: "Immutable supervision report unavailable or expired" }); return; }
      if (!delivery.recipientStaffId || !delivery.recipientEmail) { await complete(delivery, "failed", { error: "Intended recipient is unavailable" }); return; }
      const [recipient] = await dbInstance.select({ email: users.email }).from(users)
        .innerJoin(schoolMemberships, and(eq(schoolMemberships.userId, users.id), eq(schoolMemberships.schoolId, delivery.schoolId),
          eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, ["admin", "school_admin", "teacher", "office_staff"])))
        .innerJoin(schools, and(eq(schools.id, delivery.schoolId), eq(schools.isActive, true), eq(schools.status, "active"),
          isNull(schools.deletedAt), isNull(schools.disabledAt)))
        .where(eq(users.id, delivery.recipientStaffId)).limit(1);
      if (!recipient || recipient.email.trim().toLowerCase() !== delivery.recipientEmail.trim().toLowerCase()) {
        await complete(delivery, "failed", { error: "Intended recipient is inactive or their address changed" }); return;
      }
      if (!options.transport && !emailProviderConfigured()) { await complete(delivery, "failed", { error: "Email provider is not configured" }); monitor("SUPERVISION_EMAIL_NOT_CONFIGURED", "email_failure"); return; }
      const submissionAt = clock();
      const [started] = await dbInstance.update(deliveries).set({ submissionStartedAt: submissionAt,
        attemptCount: sql`${deliveries.attemptCount} + 1`, updatedAt: submissionAt }).where(and(eq(deliveries.id, delivery.id),
        eq(deliveries.schoolId, delivery.schoolId), eq(deliveries.state, "leased"), eq(deliveries.leaseOwner, leaseOwner),
        gt(deliveries.leaseExpiresAt, submissionAt), isNull(deliveries.submissionStartedAt),
        sql`EXISTS (SELECT 1 FROM ${reports} WHERE ${reports.id} = ${delivery.reportId} AND ${reports.schoolId} = ${delivery.schoolId}
          AND ${reports.state} = 'ready' AND ${reports.expiresAt} > ${submissionAt} AND ${reports.detailExpiredAt} IS NULL
          AND NOT (${supervisionCurrentRetentionExpired(submissionAt)}))`,
        sql`EXISTS (SELECT 1 FROM ${users} INNER JOIN ${schoolMemberships} ON ${schoolMemberships.userId} = ${users.id}
          INNER JOIN ${schools} ON ${schools.id} = ${schoolMemberships.schoolId}
          WHERE ${users.id} = ${delivery.recipientStaffId} AND lower(btrim(${users.email})) = ${delivery.recipientEmail.trim().toLowerCase()}
            AND ${schoolMemberships.schoolId} = ${delivery.schoolId} AND ${schoolMemberships.status} = 'active'
            AND ${schoolMemberships.role} IN ('admin','school_admin','teacher','office_staff')
            AND ${schools.isActive} = true AND ${schools.status} = 'active' AND ${schools.deletedAt} IS NULL AND ${schools.disabledAt} IS NULL)`)).returning();
      if (!started) return;
      submitted = true;
      const summary = report.summary as FrozenSummary;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        transport({ ...summary, to: delivery.recipientEmail, deliveryId: delivery.id,
          copyNotice: [summary.copyNotice, delivery.recipientKind === "central" ? "This is the configured Central Email Copy." : ""].filter(Boolean).join(" "),
        }),
        new Promise<Awaited<ReturnType<SupervisionSummaryTransport>>>((resolve) => {
          timeout = setTimeout(() => resolve({ status: "unknown", error: "Provider submission exceeded its deadline" }), 15_000);
        }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      if (result.status === "sent" && result.providerMessageId !== "development-noop") {
        await complete(delivery, "sent", { providerMessageId: result.providerMessageId });
      } else if (result.status === "unknown") {
        await complete(delivery, "unknown", { error: "Provider submission outcome is unknown" }); monitor("SUPERVISION_SUMMARY_UNKNOWN", "email_failure");
      } else {
        const delay = result.status === "transient_failure" ? RETRY_MINUTES[started.attemptCount - 1] : undefined;
        await complete(delivery, delay ? "retry" : "failed", { error: result.status === "sent" ? "Email provider returned a development no-op" : result.error,
          nextAttemptAt: delay ? new Date(clock().getTime() + delay * 60_000) : undefined });
        if (!delay) monitor("SUPERVISION_SUMMARY_FAILED", "email_failure");
      }
    } catch {
      const delay = submitted ? undefined : RETRY_MINUTES[delivery.attemptCount];
      await complete(delivery, submitted ? "unknown" : delay ? "retry" : "failed", {
        error: submitted ? "Unexpected failure after provider submission began" : "Summary preparation failed",
        nextAttemptAt: delay ? new Date(clock().getTime() + delay * 60_000) : undefined, preparationAttempt: !submitted,
      }).catch(() => undefined);
      if (submitted || !delay) monitor(submitted ? "SUPERVISION_SUMMARY_UNKNOWN" : "SUPERVISION_SUMMARY_FAILED", "email_failure");
    }
  }));
  const overdueAt = clock();
  const [overdue] = await dbInstance.select({ id: deliveries.id }).from(deliveries)
    .innerJoin(reports, and(eq(reports.id, deliveries.reportId), eq(reports.schoolId, deliveries.schoolId)))
    .where(and(deliveryScope(options.schoolId), inArray(deliveries.state, ["queued", "retry", "waiting_report"]),
      lt(deliveries.nextAttemptAt, new Date(overdueAt.getTime() - 10 * 60_000)), gt(reports.expiresAt, overdueAt),
      not(supervisionCurrentRetentionExpired(overdueAt)), isNull(reports.detailExpiredAt))).limit(1);
  if (overdue) monitor("SUPERVISION_SUMMARY_QUEUE_OVERDUE", "email_failure");
  return counts;
}
