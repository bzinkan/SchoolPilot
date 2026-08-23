import { randomUUID } from "node:crypto";
import { safeErrorMetadata } from "../util/safeLogging.js";
import type db from "../db.js";
import type { TeachingSession } from "../schema/classpilot.js";
import {
  broadcastToTeachersLocal,
  sendToDeviceLocal,
} from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { sendSessionSummaryEmailWithResult } from "./email.js";
import errorMonitor from "./errorMonitor.js";
import {
  claimDueSessionSummaryDeliveries,
  completeSessionSummaryDelivery,
  createTeachingSession,
  countOverdueSessionSummaryDeliveries,
  finalizeTeachingSession,
  getCentralEmailRecipientForSchool,
  getClasspilotSessionReportBySession,
  getClasspilotSessionStudentReports,
  getActiveSessionsForStudents,
  getClasspilotSessionStudents,
  getClasspilotStudentControlStates,
  getTeachingSessionByIdAndSchool,
  getActiveTeachingSessionForSchool,
  getUserById,
  markSessionSummarySubmissionStarted,
  recoverExpiredSessionSummaryLeases,
  withTeachingSessionStartLock,
  type TeachingSessionFinalizationReason,
  type FinalizeTeachingSessionResult,
} from "./storage.js";
import { serializeClasspilotStudentControlState } from "./classpilotClassroomState.js";
import { getSessionStudentBindings } from "./classpilotFab.js";
import { syncClasspilotControlStatesToActiveDevices } from "./classpilotControlStateDelivery.js";
import { stopActiveClasspilotLiveViewNegotiations } from "./classpilotLiveViewStop.js";

export async function publishClasspilotSessionFabStates(options: {
  schoolId: string;
  teachingSessionId: string;
  event: "started" | "ended";
  reason?: TeachingSessionFinalizationReason;
}): Promise<void> {
  // Starts use the frozen roster plus current owner/no-coverage authority.
  // Ends recompute the full state for the former frozen roster so a replacement
  // class remains present. A bare device `session-ended` event is deliberately
  // not emitted: legacy consumers translate it to an empty session list and
  // can race after this authoritative snapshot. Staff receive their separate
  // lifecycle event in runClasspilotFinalizationSideEffects.
  const roster = await getClasspilotSessionStudents(options.teachingSessionId);
  const frozenStudentIds = [...new Set(roster.map((row) => row.studentId))];
  const startBindings = options.event === "started"
    ? await getSessionStudentBindings(options.schoolId, options.teachingSessionId)
    : [];
  const studentIds = options.event === "started"
    ? startBindings.map((binding) => binding.studentId)
    : frozenStudentIds;
  await syncClasspilotControlStatesToActiveDevices(options.schoolId, studentIds);
}

async function publishControlStateRows(
  schoolId: string,
  states: Awaited<ReturnType<typeof getClasspilotStudentControlStates>>,
  teachingSessionIdOverride?: string
): Promise<void> {
  if (states.length === 0) return;
  const sessions = await getActiveSessionsForStudents(
    schoolId,
    states.map((state) => state.studentId)
  );
  const sessionByStudent = new Map(sessions.map((session) => [session.studentId, session]));
  await Promise.all(states.map(async (state) => {
    const studentSession = sessionByStudent.get(state.studentId);
    if (!studentSession) return;
    const classroomState = {
      ...serializeClasspilotStudentControlState(state),
      ...(teachingSessionIdOverride ? { teachingSessionId: teachingSessionIdOverride } : {}),
    };
    const message = {
      type: "classroom-state",
      studentId: state.studentId,
      studentSessionId: studentSession.id,
      classroomState,
    };
    sendToDeviceLocal(schoolId, studentSession.deviceId, message);
    await publishWS(
      { kind: "device", schoolId, deviceId: studentSession.deviceId },
      message
    );
  }));
}

export async function pushClasspilotSessionControlStates(
  schoolId: string,
  teachingSessionId: string
): Promise<void> {
  await runWithTenantContext({ schoolId }, async () => {
    await publishClasspilotSessionFabStates({
      schoolId,
      teachingSessionId,
      event: "started",
    });
  });
}

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
  void pushClasspilotSessionControlStates(options.schoolId, outcome.session.id).catch((err) => {
    console.warn(
      "[ClassPilot] Initial classroom-state push failed:",
      safeErrorMetadata(err)
    );
  });
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
    void stopActiveClasspilotLiveViewNegotiations({
      schoolId: options.schoolId,
      teachingSessionId: result.session.id,
      reason: "session-ended",
    }).catch((err) => {
      console.warn("[ClassPilot] Live-view cleanup failed:", safeErrorMetadata(err));
    });
    // Usage is frozen with the coverage rows and derived gap events by the
    // immutable report worker. Keeping that write inside one transaction is
    // what prevents email retries from observing a different raw heartbeat set.
    emitLifecycleMetric("SessionFinalized", 1, {
      LifecycleKind: result.session.scheduledDate ? "scheduled" : "manual",
      FinalizationReason: options.reason,
    });
    const endedUpdate = {
      type: "session-ended",
      sessionId: result.session.id,
      reason: options.reason,
      summaryDisposition: result.summaryDisposition,
    };
    broadcastToTeachersLocal(options.schoolId, endedUpdate);
    void publishWS({ kind: "staff", schoolId: options.schoolId }, endedUpdate);
    void runWithTenantContext({ schoolId: options.schoolId }, () =>
      publishClasspilotSessionFabStates({
        schoolId: options.schoolId,
        teachingSessionId: result.session.id,
        event: "ended",
        reason: options.reason,
      })
    ).catch((err) => {
      console.warn(
        "[ClassPilot] Student FAB finalization push failed:",
        safeErrorMetadata(err)
      );
    });
    for (const conflictId of result.resolvedConflictIds) {
      const update = { type: "scheduled-class-conflict-updated", conflictId };
      broadcastToTeachersLocal(options.schoolId, update);
      void publishWS({ kind: "staff", schoolId: options.schoolId }, update);
    }
    if (result.clearedControlStates.length > 0) {
      // The database rows are the reconnect authority. This post-commit push
      // only makes an already-connected extension clear immediately. Keep the
      // former session ID in the envelope so its retained event is scoped to
      // the class that ended; subsequent heartbeat reconciliation sees the
      // same higher revision with the stored null session.
      void runWithTenantContext({ schoolId: options.schoolId }, () =>
        publishControlStateRows(
          options.schoolId,
          result.clearedControlStates,
          result.session.id
        )
      ).catch((err) => {
        console.warn(
          "[ClassPilot] Final classroom-state clear push failed:",
          safeErrorMetadata(err)
        );
      });
    }
    if (result.restoredControlStates.length > 0) {
      void runWithTenantContext({ schoolId: options.schoolId }, () =>
        publishControlStateRows(options.schoolId, result.restoredControlStates)
      ).catch((err) => {
        console.warn(
          "[ClassPilot] Restored classroom-state push failed:",
          safeErrorMetadata(err)
        );
      });
    }
  }
}

type SessionSummaryData = {
  reportVersion: number;
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
    offTaskMinutes?: number;
    unclassifiedMinutes?: number;
    safetyAlerts: string[];
    safetyUrls: string[];
    safetyReviewStatuses?: string[];
    coverageStatus: "complete" | "partial" | "none" | "not_expected" | "unavailable";
    coveragePercent: number | null;
    gapMinutes: number;
  }>;
  hasActivity: boolean;
  monitoringCoverageAvailable: boolean;
};

async function buildSessionSummaryData(
  session: TeachingSession,
  schoolId: string,
  recipientName: string,
  dbInstance?: typeof db,
  asOf = new Date()
): Promise<SessionSummaryData> {
  const report = await getClasspilotSessionReportBySession(schoolId, session.id, dbInstance);
  if (!report
    || report.state !== "ready"
    || report.detailExpiredAt
    || report.expiresAt <= asOf) {
    throw new Error("Immutable ClassPilot session report is not ready");
  }
  const studentReports = await getClasspilotSessionStudentReports(schoolId, report.id, dbInstance);
  const endTime = report.windowEnd;
  const timeZone = report.timezone;
  const students = studentReports.map((student) => {
    const topDomains = Array.isArray(student.topDomains) ? student.topDomains as Array<any> : [];
    const safetyAlerts = report.reportVersion >= 2 && Array.isArray(student.safetyAlerts)
      ? student.safetyAlerts as Array<any>
      : [];
    return {
      name: student.studentNameSnapshot,
      totalMinutes: Math.round(student.observedSeconds / 60),
      topDomains: topDomains.slice(0, 5).map((domain) => ({
        domain: String(domain.domain || ""),
        minutes: Math.round(Number(domain.seconds || 0) / 60),
      })).filter((domain) => domain.domain),
      offTaskCount: report.reportVersion >= 2 ? student.offTaskEventCount : 0,
      safetyAlerts: safetyAlerts.map((alert) => String(alert.category || "")).filter(Boolean),
      // The immutable report stores normalized domains only. Query strings,
      // paths, and raw URLs never enter summary email content.
      safetyUrls: safetyAlerts.map((alert) => String(alert.domain || "")).filter(Boolean),
      ...(report.reportVersion >= 2 ? {
        offTaskMinutes: Math.round(student.offTaskSeconds / 60),
        unclassifiedMinutes: Math.round(student.unclassifiedSeconds / 60),
        safetyReviewStatuses: safetyAlerts.map((alert) => String(alert.reviewStatus || "Automated")),
      } : {}),
      coverageStatus: student.status as SessionSummaryData["students"][number]["coverageStatus"],
      coveragePercent: student.coveragePercent,
      gapMinutes: Math.round(student.gapSeconds / 60),
    };
  });
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
    reportVersion: report.reportVersion,
    teacherName: recipientName,
    className: session.classNameSnapshot || "Class",
    date: formatDate(session.startTime),
    startTime: formatTime(session.startTime),
    endTime: formatTime(endTime),
    duration: `${Math.max(0, Math.round((endTime.getTime() - session.startTime.getTime()) / 60_000))} min`,
    studentCount: report.rosterCount,
    students,
    hasActivity: studentReports.some((student) => student.heartbeatCount > 0),
    monitoringCoverageAvailable: studentReports.some((student) => student.status !== "not_expected" && student.status !== "unavailable"),
  };
}

function deliveryNotice(
  session: TeachingSession,
  recipientKind: string,
  hasActivity: boolean,
  monitoringCoverageAvailable: boolean
): string | undefined {
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
  if (!hasActivity || !monitoringCoverageAvailable) {
    notices.push("Observed browser telemetry was unavailable or incomplete for this session; Monitoring coverage shows the measured gaps without assigning a cause.");
  }
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
  clock?: () => Date;
  transport?: SessionSummaryTransport;
} = {}): Promise<SessionSummaryDispatchCounts> {
  const dbInstance = options.dbInstance;
  const clock = options.clock || (options.now
    ? () => new Date(options.now!.getTime())
    : () => new Date());
  const claimNow = options.now || clock();
  const transport = options.transport || sendSessionSummaryEmailWithResult;
  const recovered = await recoverExpiredSessionSummaryLeases(claimNow, dbInstance, options.schoolId);
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
    now: claimNow,
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
          completedAt: clock(),
        }, dbInstance);
        counts.failed += 1;
        return;
      }

      const summary = await buildSessionSummaryData(
        session,
        delivery.schoolId,
        delivery.recipientName || "Teacher",
        dbInstance,
        clock()
      );
      const submittedDelivery = await markSessionSummarySubmissionStarted(
        delivery.id,
        leaseOwner,
        clock(),
        dbInstance
      );
      if (!submittedDelivery) return;
      submissionStarted = true;
      const sendResult = await transport({
        reportVersion: summary.reportVersion,
        to: delivery.recipientEmail,
        teacherName: summary.teacherName,
        className: summary.className,
        date: summary.date,
        startTime: summary.startTime,
        endTime: summary.endTime,
        duration: summary.duration,
        studentCount: summary.studentCount,
        students: summary.students,
        copyNotice: deliveryNotice(
          session,
          delivery.recipientKind,
          summary.hasActivity,
          summary.monitoringCoverageAvailable
        ),
        deliveryId: delivery.id,
      });

      if (sendResult.status === "sent") {
        const completedAt = clock();
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "sent",
          providerMessageId: sendResult.providerMessageId,
          completedAt,
        }, dbInstance);
        counts.sent += 1;
        emitLifecycleMetric("SummaryDeliveryLatency", completedAt.getTime() - delivery.createdAt.getTime(), {
          RecipientKind: delivery.recipientKind,
        }, "Milliseconds");
        return;
      }

      if (sendResult.status === "unknown") {
        const completedAt = clock();
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "unknown",
          error: sendResult.error,
          completedAt,
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
      const completedAt = clock();
      if (canRetry) {
        const nextAttemptAt = new Date(completedAt.getTime() + RETRY_DELAYS_MINUTES[retryIndex]! * 60_000);
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "retry",
          error: sendResult.error,
          nextAttemptAt,
          completedAt,
        }, dbInstance);
        counts.retry += 1;
        emitLifecycleMetric("SummaryDeliveryRetry", 1, { RecipientKind: delivery.recipientKind });
      } else {
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "failed",
          error: sendResult.error,
          completedAt,
        }, dbInstance);
        counts.failed += 1;
        emitLifecycleMetric("SummaryDeliveryFailed", 1, { RecipientKind: delivery.recipientKind });
      }
    } catch (error) {
      const completedAt = clock();
      if (submissionStarted) {
        await completeSessionSummaryDelivery({
          deliveryId: delivery.id,
          leaseOwner,
          state: "unknown",
          error: "Unexpected failure after provider submission began",
          completedAt,
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
          ? new Date(completedAt.getTime() + RETRY_DELAYS_MINUTES[retryIndex]! * 60_000)
          : undefined,
        completedAt,
        incrementAttempt: true,
      }, dbInstance).catch(() => undefined);
      counts[canRetry ? "retry" : "failed"] += 1;
      console.error(
        "[SessionSummary] Delivery preparation failed:",
        safeErrorMetadata(error)
      );
    }
    }));
  }

  const overdue = await countOverdueSessionSummaryDeliveries(
    new Date(clock().getTime() - 10 * 60_000),
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
