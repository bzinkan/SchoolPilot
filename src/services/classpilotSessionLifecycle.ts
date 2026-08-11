import { randomUUID } from "node:crypto";
import type db from "../db.js";
import type { TeachingSession } from "../schema/classpilot.js";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { sendSessionSummaryEmailWithResult } from "./email.js";
import errorMonitor from "./errorMonitor.js";
import {
  claimDueSessionSummaryDeliveries,
  aggregateClasspilotSessionUsage,
  completeSessionSummaryDelivery,
  createTeachingSession,
  countOverdueSessionSummaryDeliveries,
  finalizeTeachingSession,
  getCentralEmailRecipientForSchool,
  getClasspilotSessionStudentRoster,
  getGroupByIdAndSchool,
  getHeartbeatsForStudentsInRange,
  getSchoolById,
  getTeachingSessionByIdAndSchool,
  getActiveTeachingSessionForSchool,
  getUserById,
  markSessionSummarySubmissionStarted,
  recoverExpiredSessionSummaryLeases,
  withTeachingSessionStartLock,
  type TeachingSessionFinalizationReason,
  type FinalizeTeachingSessionResult,
} from "./storage.js";

export async function startManualClasspilotSession(options: {
  schoolId: string;
  teacherId: string;
  groupId: string;
  dbInstance?: typeof db;
  afterReplacement?: () => Promise<void>;
}): Promise<{
  session: TeachingSession;
  replacedSessionId?: string;
  replacementFinalization?: FinalizeTeachingSessionResult;
}> {
  const outcome = await withTeachingSessionStartLock(
    options.schoolId,
    options.teacherId,
    async (lockedDb) => {
      const existing = await getActiveTeachingSessionForSchool(
        options.teacherId,
        options.schoolId,
        lockedDb
      );
      const finalized = existing
        ? await finalizeClasspilotSession({
            schoolId: options.schoolId,
            sessionId: existing.id,
            reason: "replacement_start",
            dbInstance: lockedDb,
            deferSideEffects: true,
          })
        : undefined;
      if (finalized) await options.afterReplacement?.();
      const session = await createTeachingSession({
        groupId: options.groupId,
        teacherId: options.teacherId,
      }, lockedDb);
      return {
        session,
        replacedSessionId: existing?.id,
        replacementFinalization: finalized,
      };
    },
    options.dbInstance
  );
  if (outcome.replacementFinalization) {
    runClasspilotFinalizationSideEffects(outcome.replacementFinalization, {
      schoolId: options.schoolId,
      reason: "replacement_start",
      dbInstance: options.dbInstance,
    });
  }
  return outcome;
}

export type ClasspilotSessionLifecycle = {
  kind: "manual" | "scheduled";
  state: "active" | "finalized" | "skipped";
};

export function serializeClasspilotSession(session: TeachingSession) {
  const scheduled = !!session.scheduledDate;
  const state: ClasspilotSessionLifecycle["state"] = scheduled
    ? (session.scheduledState as ClasspilotSessionLifecycle["state"] || (session.endTime ? "finalized" : "active"))
    : session.endTime
      ? "finalized"
      : "active";
  const manuallyFinalized = ["manual_end", "teacher_end", "admin_end", "replacement_start"].includes(
    session.scheduledFinalizationReason || ""
  );
  return {
    ...session,
    lifecycle: {
      kind: scheduled ? "scheduled" as const : "manual" as const,
      state,
    },
    summaryTrigger: scheduled && !manuallyFinalized ? "scheduled_end" as const : "manual_end" as const,
    summaryExpectedAt: state === "active" && scheduled ? session.scheduledEndAt : null,
  };
}

function displayName(user: any, fallback: string): string {
  return user?.displayName
    || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim()
    || user?.email
    || fallback;
}

function emitLifecycleMetric(
  metricName: string,
  value: number,
  dimensions: Record<string, string> = {},
  unit: "Count" | "Milliseconds" = "Count"
) {
  const dimensionNames = ["Environment", ...Object.keys(dimensions)];
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot",
        Dimensions: [dimensionNames],
        Metrics: [{ Name: metricName, Unit: unit }],
      }],
    },
    Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    ...dimensions,
    [metricName]: value,
  }));
}

export async function finalizeClasspilotSession(
  options: {
    schoolId: string;
    sessionId: string;
    reason: TeachingSessionFinalizationReason;
    finalizedAt?: Date;
    dbInstance?: typeof db;
    deferSideEffects?: boolean;
  }
) {
  const dbInstance = options.dbInstance;
  const session = await getTeachingSessionByIdAndSchool(options.sessionId, options.schoolId, dbInstance);
  if (!session) return undefined;

  const teacher = session.scheduledDate && session.scheduledTeacherEmail
    ? undefined
    : await getUserById(session.teacherId, dbInstance);
  const central = await getCentralEmailRecipientForSchool(options.schoolId, dbInstance);
  const teacherEmail = (session.scheduledDate ? session.scheduledTeacherEmail : teacher?.email)?.trim();
  const teacherName = session.scheduledDate
    ? session.scheduledTeacherName || "Teacher"
    : displayName(teacher, "Teacher");
  const centralEmail = central?.email?.trim();
  const recipients = [] as Array<{ kind: "teacher" | "central"; email: string; name: string }>;
  if (teacherEmail) {
    recipients.push({ kind: "teacher", email: teacherEmail, name: teacherName });
  }
  if (centralEmail && centralEmail.toLowerCase() !== teacherEmail?.toLowerCase()) {
    recipients.push({ kind: "central", email: centralEmail, name: displayName(central, "School Team") });
  }

  const result = await finalizeTeachingSession({
    schoolId: options.schoolId,
    sessionId: options.sessionId,
    reason: options.reason,
    finalizedAt: options.finalizedAt,
    recipients,
  }, dbInstance);
  if (result?.finalized && !options.deferSideEffects) {
    runClasspilotFinalizationSideEffects(result, {
      schoolId: options.schoolId,
      reason: options.reason,
      dbInstance,
    });
  }
  return result;
}

export function runClasspilotFinalizationSideEffects(
  result: FinalizeTeachingSessionResult,
  options: {
    schoolId: string;
    reason: TeachingSessionFinalizationReason;
    dbInstance?: typeof db;
  }
): void {
  if (result.finalized) {
    // Derived usage is rebuildable and deliberately detached only after the
    // lifecycle transaction (and any outer start lock transaction) commits.
    void runWithTenantContext({ schoolId: options.schoolId }, () =>
      aggregateClasspilotSessionUsage(result.session.id)
    ).catch((err) => {
      console.warn(`[ClassPilot] Session usage aggregation failed for ${result.session.id}:`, err);
    });
    emitLifecycleMetric("SessionFinalized", 1, {
      LifecycleKind: result.session.scheduledDate ? "scheduled" : "manual",
      FinalizationReason: options.reason,
    });
    for (const conflictId of result.resolvedConflictIds) {
      const update = { type: "scheduled-class-conflict-updated", conflictId };
      broadcastToTeachersLocal(options.schoolId, update);
      void publishWS({ kind: "staff", schoolId: options.schoolId }, update);
    }
  }
}

type SessionSummaryData = {
  teacherName: string;
  className: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: string;
  studentCount: number;
  students: Array<{
    name: string;
    totalMinutes: number;
    topDomains: Array<{ domain: string; minutes: number }>;
    offTaskCount: number;
    safetyAlerts: string[];
    safetyUrls: string[];
  }>;
  hasActivity: boolean;
};

async function buildSessionSummaryData(
  session: TeachingSession,
  schoolId: string,
  recipientName: string,
  dbInstance?: typeof db
): Promise<SessionSummaryData> {
  const endTime = session.endTime || session.scheduledEndAt || new Date();
  const group = await getGroupByIdAndSchool(session.groupId, schoolId, dbInstance);
  const school = await getSchoolById(schoolId, dbInstance);
  const timeZone = session.scheduledTimezone || school?.schoolTimezone || "America/New_York";
  const roster = await getClasspilotSessionStudentRoster(schoolId, session.id, dbInstance);
  const studentIds = roster.map((row) => row.studentId);
  const heartbeatRows = await getHeartbeatsForStudentsInRange(
    schoolId,
    studentIds,
    session.startTime,
    endTime,
    dbInstance
  );

  const studentMap = new Map<string, {
    name: string;
    domainSeconds: Map<string, number>;
    count: number;
    offTaskCount: number;
    safetyAlerts: string[];
    safetyUrls: string[];
  }>();
  for (const row of roster) {
    const name = [row.student.firstName, row.student.lastName].filter(Boolean).join(" ")
      || row.student.email
      || "Unknown";
    studentMap.set(row.studentId, {
      name,
      domainSeconds: new Map(),
      count: 0,
      offTaskCount: 0,
      safetyAlerts: [],
      safetyUrls: [],
    });
  }

  for (const heartbeat of heartbeatRows) {
    if (!heartbeat.studentId) continue;
    const entry = studentMap.get(heartbeat.studentId);
    if (!entry) continue;
    entry.count += 1;
    if (heartbeat.aiCategory === "non-educational") entry.offTaskCount += 1;
    if (heartbeat.safetyAlert) {
      entry.safetyAlerts.push(heartbeat.safetyAlert);
      if (heartbeat.activeTabUrl) {
        try { entry.safetyUrls.push(new URL(heartbeat.activeTabUrl).hostname.replace(/^www\./, "")); } catch { /* invalid URL */ }
      }
    }
    if (heartbeat.activeTabUrl) {
      try {
        const domain = new URL(heartbeat.activeTabUrl).hostname.replace(/^www\./, "");
        entry.domainSeconds.set(domain, (entry.domainSeconds.get(domain) || 0) + 10);
      } catch { /* invalid URL */ }
    }
  }

  const students = Array.from(studentMap.values()).map((student) => ({
    name: student.name,
    totalMinutes: Math.round((student.count * 10) / 60),
    topDomains: Array.from(student.domainSeconds.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([domain, seconds]) => ({ domain, minutes: Math.round(seconds / 60) })),
    offTaskCount: student.offTaskCount,
    safetyAlerts: [...new Set(student.safetyAlerts)],
    safetyUrls: [...new Set(student.safetyUrls)],
  }));
  const formatTime = (date: Date) => date.toLocaleString("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const formatDate = (date: Date) => date.toLocaleDateString("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return {
    teacherName: recipientName,
    className: session.classNameSnapshot || group?.name || "Class",
    date: formatDate(session.startTime),
    startTime: formatTime(session.startTime),
    endTime: formatTime(endTime),
    duration: `${Math.max(0, Math.round((endTime.getTime() - session.startTime.getTime()) / 60_000))} min`,
    studentCount: roster.length,
    students,
    hasActivity: heartbeatRows.length > 0,
  };
}

function deliveryNotice(session: TeachingSession, recipientKind: string, hasActivity: boolean): string | undefined {
  const notices: string[] = [];
  if (session.scheduledDate) {
    if (["teacher_end", "admin_end"].includes(session.scheduledFinalizationReason || "")) {
      notices.push("This scheduled class was ended early. The summary covers the scheduled start through the early end time.");
    } else if (session.scheduledFinalizationReason === "replacement_start") {
      notices.push("This scheduled class ended early when another class session started. The summary covers the scheduled start through that replacement time.");
    } else if (session.scheduledFinalizationReason === "safety_timeout") {
      notices.push("This scheduled class was finalized by the session safety timeout. The summary covers the recorded session window.");
    } else if (session.sessionMode === "scheduled_report") {
      notices.push("This scheduled class ended automatically. No live ClassPilot session was opened; scheduled reporting remained active for the block.");
    } else {
      notices.push("This scheduled class ended automatically at its configured end time.");
    }
  }
  if (!hasActivity) notices.push("No student activity was recorded during this session window.");
  if (recipientKind === "central") notices.push("This is the configured Central Email Copy.");
  return notices.length ? notices.join(" ") : undefined;
}

const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 180] as const;

export type SessionSummaryTransport = typeof sendSessionSummaryEmailWithResult;
export type SessionSummaryDispatchCounts = {
  claimed: number;
  sent: number;
  retry: number;
  failed: number;
  unknown: number;
};

export async function dispatchDueClasspilotSessionSummaries(options: {
  dbInstance?: typeof db;
  schoolId?: string;
  teachingSessionId?: string;
  limit?: number;
  now?: Date;
  transport?: SessionSummaryTransport;
} = {}): Promise<SessionSummaryDispatchCounts> {
  const dbInstance = options.dbInstance;
  const now = options.now || new Date();
  const transport = options.transport || sendSessionSummaryEmailWithResult;
  const recovered = await recoverExpiredSessionSummaryLeases(now, dbInstance, options.schoolId);
  if (recovered.quarantined > 0) {
    emitLifecycleMetric("SummaryDeliveryUnknown", recovered.quarantined);
    errorMonitor.trackError(
      "email_failure",
      new Error("ClassPilot summary worker lease expired after provider submission began"),
      { job: "classpilot_summary_dispatch", errorCode: "AMBIGUOUS_EXPIRED_LEASE" },
      { priority: "high" }
    );
  }

  const leaseOwner = `${process.pid}:${randomUUID()}`;
  const deliveries = await claimDueSessionSummaryDeliveries({
    leaseOwner,
    now,
    limit: options.limit,
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
  }, dbInstance);
  const counts = { claimed: deliveries.length, sent: 0, retry: 0, failed: 0, unknown: recovered.quarantined };

  const deliveryConcurrency = 10;
  for (let offset = 0; offset < deliveries.length; offset += deliveryConcurrency) {
    const batch = deliveries.slice(offset, offset + deliveryConcurrency);
    await Promise.all(batch.map(async (delivery) => {
    let submissionStarted = false;
    try {
      const session = await getTeachingSessionByIdAndSchool(
        delivery.teachingSessionId,
        delivery.schoolId,
        dbInstance
      );
      if (!session?.endTime) {
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "failed",
          error: "Finalized teaching session not found",
          completedAt: now,
        }, dbInstance);
        counts.failed += 1;
        return;
      }

      const summary = await buildSessionSummaryData(
        session,
        delivery.schoolId,
        delivery.recipientName || "Teacher",
        dbInstance
      );
      const submittedDelivery = await markSessionSummarySubmissionStarted(delivery.id, leaseOwner, now, dbInstance);
      if (!submittedDelivery) return;
      submissionStarted = true;
      const sendResult = await transport({
        to: delivery.recipientEmail,
        teacherName: summary.teacherName,
        className: summary.className,
        date: summary.date,
        startTime: summary.startTime,
        endTime: summary.endTime,
        duration: summary.duration,
        studentCount: summary.studentCount,
        students: summary.students,
        copyNotice: deliveryNotice(session, delivery.recipientKind, summary.hasActivity),
        deliveryId: delivery.id,
      });

      if (sendResult.status === "sent") {
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "sent",
          providerMessageId: sendResult.providerMessageId,
          completedAt: now,
        }, dbInstance);
        counts.sent += 1;
        emitLifecycleMetric("SummaryDeliveryLatency", now.getTime() - delivery.createdAt.getTime(), {
          RecipientKind: delivery.recipientKind,
        }, "Milliseconds");
        return;
      }

      if (sendResult.status === "unknown") {
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "unknown",
          error: sendResult.error,
          completedAt: now,
        }, dbInstance);
        counts.unknown += 1;
        emitLifecycleMetric("SummaryDeliveryUnknown", 1, { RecipientKind: delivery.recipientKind });
        errorMonitor.trackError(
          "email_failure",
          new Error("ClassPilot summary delivery outcome is unknown"),
          { job: "classpilot_summary_dispatch", errorCode: sendResult.providerCode || "AMBIGUOUS_PROVIDER_RESULT" },
          { priority: "high" }
        );
        return;
      }

      const retryIndex = submittedDelivery.attemptCount - 1;
      const canRetry = sendResult.status === "transient_failure" && retryIndex < RETRY_DELAYS_MINUTES.length;
      if (canRetry) {
        const nextAttemptAt = new Date(now.getTime() + RETRY_DELAYS_MINUTES[retryIndex]! * 60_000);
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "retry",
          error: sendResult.error,
          nextAttemptAt,
          completedAt: now,
        }, dbInstance);
        counts.retry += 1;
        emitLifecycleMetric("SummaryDeliveryRetry", 1, { RecipientKind: delivery.recipientKind });
      } else {
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "failed",
          error: sendResult.error,
          completedAt: now,
        }, dbInstance);
        counts.failed += 1;
        emitLifecycleMetric("SummaryDeliveryFailed", 1, { RecipientKind: delivery.recipientKind });
      }
    } catch (error) {
      if (submissionStarted) {
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "unknown",
          error: "Unexpected failure after provider submission began",
          completedAt: now,
        }, dbInstance).catch(() => undefined);
        counts.unknown += 1;
        emitLifecycleMetric("SummaryDeliveryUnknown", 1, { RecipientKind: delivery.recipientKind });
        errorMonitor.trackError(
          "email_failure",
          new Error("ClassPilot summary failed after provider submission began"),
          { job: "classpilot_summary_dispatch", errorCode: "POST_SUBMISSION_FAILURE" },
          { priority: "high" }
        );
        return;
      }

      // Preparation failed before submissionStartedAt was written. It is safe
      // to retry, but each observed failure advances the bounded schedule.
      const retryIndex = Math.max(0, delivery.attemptCount);
      const canRetry = retryIndex < RETRY_DELAYS_MINUTES.length;
      await completeSessionSummaryDelivery({
        deliveryId: delivery.id,
        leaseOwner,
        state: canRetry ? "retry" : "failed",
        error: "Session summary preparation failed",
        nextAttemptAt: canRetry
          ? new Date(now.getTime() + RETRY_DELAYS_MINUTES[retryIndex]! * 60_000)
          : undefined,
        completedAt: now,
        incrementAttempt: true,
      }, dbInstance).catch(() => undefined);
      counts[canRetry ? "retry" : "failed"] += 1;
      console.error(`[SessionSummary] Delivery ${delivery.id} preparation failed:`, error);
    }
    }));
  }

  const overdue = await countOverdueSessionSummaryDeliveries(
    new Date(now.getTime() - 10 * 60_000),
    dbInstance,
    options.schoolId
  );
  if (overdue > 0) {
    errorMonitor.trackError(
      "email_failure",
      new Error("ClassPilot summary deliveries have remained queued for more than ten minutes"),
      { job: "classpilot_summary_dispatch", errorCode: "SUMMARY_QUEUE_OVERDUE" },
      { priority: "high" }
    );
  }
  return counts;
}

export async function drainDueClasspilotSessionSummaries(options: {
  dbInstance?: typeof db;
  schoolId?: string;
  teachingSessionId?: string;
  now?: Date;
  transport?: SessionSummaryTransport;
  batchLimit?: number;
  maxBatches?: number;
  maxDurationMs?: number;
} = {}): Promise<SessionSummaryDispatchCounts> {
  const batchLimit = Math.max(1, Math.min(options.batchLimit || 100, 100));
  const maxBatches = Math.max(1, Math.min(options.maxBatches || 5, 20));
  const maxDurationMs = Math.max(1_000, options.maxDurationMs || 45_000);
  const startedAt = Date.now();
  const total: SessionSummaryDispatchCounts = {
    claimed: 0,
    sent: 0,
    retry: 0,
    failed: 0,
    unknown: 0,
  };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const counts = await dispatchDueClasspilotSessionSummaries({
      dbInstance: options.dbInstance,
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      now: options.now,
      transport: options.transport,
      limit: batchLimit,
    });
    total.claimed += counts.claimed;
    total.sent += counts.sent;
    total.retry += counts.retry;
    total.failed += counts.failed;
    total.unknown += counts.unknown;
    if (counts.claimed < batchLimit || Date.now() - startedAt >= maxDurationMs) break;
  }
  return total;
}
