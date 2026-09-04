import type { Server as SocketServer } from "socket.io";
import errorMonitor from "./errorMonitor.js";
import {
  getGroupByIdAndSchool,
  getOrCreateSession,
  updateSessionStatus,
  getSettingsForSchool,
  getInstructionalDateStatus,
  withInstructionalCalendarDateLock,
  getClasspilotScheduleChangeNotificationContext,
  backfillOpenTeachingSessionRosterSnapshots,
  listScheduledSessionsReadyToFinalize,
  listScheduledReportSessionsDueNow,
  reconcileLegacyOpenScheduledSessions,
  releaseExpiredClasspilotSupervisionContexts,
  expireClasspilotTransientCommandTargets,
} from "./storage.js";
import {
  expireScheduledClassConflictsForSchool,
  getClasspilotGroupsReadyAtEffectiveWindow,
  processScheduledClassAutoStart,
} from "./classpilotScheduledStart.js";
import {
  broadcastClasspilotScheduleChangeUpdate,
  emitClasspilotScheduleChangeMetric,
  expirePendingClasspilotScheduleChangesForSchool,
  listPendingClasspilotScheduleChangeDatesForSchool,
  sendClasspilotScheduleChangeEmails,
} from "./classpilotScheduleChanges.js";
import {
  drainDueClasspilotSessionSummaries,
  finalizeClasspilotSession,
} from "./classpilotSessionLifecycle.js";
import { materializeDueClasspilotSessionReports } from "./classpilotMonitoringReports.js";
import { syncClasspilotControlStatesToActiveDevices } from "./classpilotControlStateDelivery.js";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { broadcastGoPilot } from "../realtime/socketio.js";
import { runSecurityChecks } from "./securityMonitor.js";
import {
  getStaffIdentityIntegrityScanIntervalMinutes,
  runStaffIdentityIntegrityScan,
  STAFF_IDENTITY_INTEGRITY_SCAN_JOB,
} from "./staffIdentityMonitoring.js";
import { schedulerDb, schedulerLockPool, schedulerPool } from "./schedulerDb.js";
import { schools, productLicenses } from "../schema/core.js";
import {
  heartbeats,
  dailyUsage,
  teachingSessions,
  groups,
  classpilotScheduleChanges,
} from "../schema/classpilot.js";
import { activityLog, dismissalQueue, dismissalSessions } from "../schema/gopilot.js";
import { students } from "../schema/students.js";
import { eq, and, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  getWatchesDueForRenewal,
  upsertMailpilotWatch,
  updateMailpilotWatchError,
} from "./storage.js";
import { startWatch, isMailpilotConfigured } from "./mailpilotGmail.js";
import { coerceSchedulerTimestamp } from "../util/schedulerTimestamp.js";
import { localDateInTimeZone } from "../util/schoolTime.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import {
  DailyUsageRollupMarkers,
  dailyUsageRollupWindow,
  type DailyUsageRollupWindow,
} from "../util/dailyUsageRollup.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import { isWithinTrackingWindow } from "./schoolHours.js";
import {
  gopilotLicenseEntitlementPredicate,
  gopilotSchoolEntitlementPredicate,
  resolveGopilotEntitlement,
} from "./gopilotEntitlement.js";
import {
  dailyUsageAggregatesEqual,
  readSetBasedDailyUsageCandidate,
  upsertSetBasedDailyUsage,
  type DailyUsageAggregate,
} from "./classpilotDailyUsageRollup.js";
import { reapExpiredManualStudentSessions } from "./classpilotStudentSessionLifecycle.js";
import { flushClasspilotLifecyclePushes } from "./classpilotLifecyclePushes.js";

let io: SocketServer | null = null;
let intervalId: NodeJS.Timeout | null = null;
let schedulerStopping = false;
const pendingSchedulerJobs = new Set<Promise<void>>();
let lastRollupHour = -1;
let lastPurgeHour = -1;
let heavyJobRunning = false; // Mutex: prevent rollup and purge from running concurrently
const dailyUsageRollupMarkers = new DailyUsageRollupMarkers();
const reportedAutomaticScheduleSkips = new Map<string, number>();
const AUTOMATIC_SCHEDULE_SKIP_DEDUPE_MS = 36 * 60 * 60 * 1000;
const MAX_REPORTED_AUTOMATIC_SCHEDULE_SKIPS = 4_096;
const DAILY_USAGE_SCHOOL_BATCH_SIZE = 25;
const DAILY_USAGE_SCHOOL_CONCURRENCY = 2;

function recordAutomaticScheduleSkips(options: {
  schoolId: string;
  scheduledDate: string;
  groupIds: string[];
  now: Date;
}) {
  const nowMs = options.now.getTime();
  for (const [key, reportedAt] of reportedAutomaticScheduleSkips) {
    if (nowMs - reportedAt > AUTOMATIC_SCHEDULE_SKIP_DEDUPE_MS) {
      reportedAutomaticScheduleSkips.delete(key);
    }
  }

  let newlySkipped = 0;
  for (const groupId of options.groupIds) {
    const key = `${options.schoolId}:${options.scheduledDate}:${groupId}`;
    if (reportedAutomaticScheduleSkips.has(key)) continue;
    reportedAutomaticScheduleSkips.set(key, nowMs);
    while (reportedAutomaticScheduleSkips.size > MAX_REPORTED_AUTOMATIC_SCHEDULE_SKIPS) {
      const oldest = reportedAutomaticScheduleSkips.keys().next().value;
      if (!oldest) break;
      reportedAutomaticScheduleSkips.delete(oldest);
    }
    newlySkipped += 1;
  }
  if (newlySkipped === 0) return;

  console.log(JSON.stringify({
    _aws: {
      Timestamp: nowMs,
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot",
        Dimensions: [["Environment", "Reason"]],
        Metrics: [{ Name: "AutomaticScheduleSkipped", Unit: "Count" }],
      }],
    },
    Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    Reason: "non_instructional_day",
    AutomaticScheduleSkipped: newlySkipped,
  }));
}

export type SchedulerLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false };

export async function runWithSchedulerLock<T>(
  jobName: string,
  fn: () => Promise<T>
): Promise<SchedulerLockResult<T>> {
  const client = await schedulerLockPool.connect();
  let locked = false;
  try {
    const lockKey = `schoolpilot:scheduler:${jobName}`;
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey]
    );
    locked = !!result.rows[0]?.locked;
    if (!locked) {
      console.log(`[Scheduler] Skipping ${jobName}; another task holds the lock`);
      return { acquired: false };
    }
    return { acquired: true, result: await fn() };
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [`schoolpilot:scheduler:${jobName}`])
        .catch(() => console.warn(`[Scheduler] Failed to unlock ${jobName}`));
    }
    client.release();
  }
}

function scheduleLockedJob(jobName: string, fn: () => Promise<void>) {
  if (schedulerStopping) return;
  const pending = runWithSchedulerLock(jobName, async () => {
    if (!schedulerStopping) await fn();
  }).then(() => undefined, (err) => {
    console.error(`[Scheduler] ${jobName} failed outside handler`);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: jobName });
  });
  pendingSchedulerJobs.add(pending);
  void pending.then(() => pendingSchedulerJobs.delete(pending));
}

async function publishGoPilotEvent(room: string, event: string, data: unknown) {
  await broadcastGoPilot(room, event, data);
}

async function runHeavyJobsSerially() {
  if (heavyJobRunning) {
    console.log("[Scheduler] Heavy job already running, skipping this tick");
    return;
  }
  heavyJobRunning = true;
  try {
    const currentHour = new Date().getUTCHours();
    // Rollup at top of hour
    if (currentHour !== lastRollupHour) {
      lastRollupHour = currentHour;
      await rollupDailyUsage();
      await renewMailpilotWatches();
    }
    // Purge at 30min past the hour (staggered to avoid overlap with rollup)
    const currentMinute = new Date().getUTCMinutes();
    if (currentMinute >= 30 && currentHour !== lastPurgeHour) {
      lastPurgeHour = currentHour;
      await purgeExpiredHeartbeats();
      await purgeClasspilotSafetySpineRetention();
      await purgeExpiredEvidenceArtifactContent();
      await purgeMailpilotRetention();
      await purgeOldErrorLogs();
      await purgeOldImportRuns();
    }
  } finally {
    heavyJobRunning = false;
  }
}

let tickCount = 0;

export function startScheduler(socketIo: SocketServer | null = null) {
  schedulerStopping = false;
  io = socketIo;
  const staffIdentityScanEveryTicks =
    getStaffIdentityIntegrityScanIntervalMinutes();
  console.log("Dismissal scheduler started (checking every 60s)");
  intervalId = setInterval(() => {
    tickCount++;
    scheduleLockedJob("checkDismissalTimes", checkDismissalTimes);
    scheduleLockedJob("autoCompleteStaleGoPilotSessions", autoCompleteStaleGoPilotSessions);
    scheduleLockedJob("autoEndStaleClassPilotSessions", autoEndStaleClassPilotSessions);
    scheduleLockedJob("expireClasspilotSupervisionContexts", expireClasspilotSupervisionContexts);
    scheduleLockedJob("expireClasspilotTransientCommands", expireClasspilotTransientCommands);
    scheduleLockedJob("expireClasspilotManualStudentSessions", expireClasspilotManualStudentSessions);
    scheduleLockedJob("expireClasspilotEvidenceCaptureRequests", expireClasspilotEvidenceCaptureRequests);
    scheduleLockedJob("reconcileClasspilotScheduledSessions", reconcileClasspilotScheduledSessions);
    // Security monitor: run every 5 minutes (every 5th tick) — rule-based breach detection
    if (tickCount % 5 === 0) {
      scheduleLockedJob("runSecurityChecks", async () => {
        await runSecurityChecks();
      });
    }
    if (tickCount % staffIdentityScanEveryTicks === 0) {
      scheduleLockedJob(
        STAFF_IDENTITY_INTEGRITY_SCAN_JOB,
        async () => {
          await runStaffIdentityIntegrityScan();
        }
      );
    }
    // Fire and forget — runs through the mutex and dedicated pool
    scheduleLockedJob("runHeavyJobsSerially", runHeavyJobsSerially);
  }, 60 * 1000);
  scheduleLockedJob("checkDismissalTimes", checkDismissalTimes);
  scheduleLockedJob("autoCompleteStaleGoPilotSessions", autoCompleteStaleGoPilotSessions);
  scheduleLockedJob("expireClasspilotSupervisionContexts", expireClasspilotSupervisionContexts);
  scheduleLockedJob("expireClasspilotTransientCommands", expireClasspilotTransientCommands);
  scheduleLockedJob("expireClasspilotManualStudentSessions", expireClasspilotManualStudentSessions);
  scheduleLockedJob("expireClasspilotEvidenceCaptureRequests", expireClasspilotEvidenceCaptureRequests);
  scheduleLockedJob("reconcileClasspilotScheduledSessions", reconcileClasspilotScheduledSessions);
  // Run the read-only aggregate scan at worker startup, then at its bounded
  // configured cadence. The scheduler advisory lock and the scanner's local
  // gate prevent overlap across or within worker processes.
  scheduleLockedJob(
    STAFF_IDENTITY_INTEGRITY_SCAN_JOB,
    async () => {
      await runStaffIdentityIntegrityScan();
    }
  );
  // Run heavy jobs immediately so a worker restart after 02:00 local time
  // catches up yesterday's usage without waiting for the next hourly boundary.
  scheduleLockedJob("runHeavyJobsSerially", runHeavyJobsSerially);
}

export function stopScheduler() {
  schedulerStopping = true;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export async function drainSchedulerJobs(): Promise<void> {
  while (pendingSchedulerJobs.size) await Promise.all([...pendingSchedulerJobs]);
}

export function snapshotSchedulerJobs() {
  return { pending: pendingSchedulerJobs.size, stopping: schedulerStopping };
}

async function checkDismissalTimes() {
  try {
    // Auto-start is explicit and license-gated. Clock validation is isolated
    // per school so one malformed legacy timezone/time cannot abort all schools.
    const entitlementNow = new Date();
    const result = await schedulerDb
      .select({
        id: schools.id,
        name: schools.name,
        dismissalTime: schools.dismissalTime,
        schoolTimezone: schools.schoolTimezone,
      })
      .from(schools)
      .innerJoin(
        productLicenses,
        and(
          eq(productLicenses.schoolId, schools.id),
          gopilotLicenseEntitlementPredicate(entitlementNow)
        )
      )
      .where(
        and(
          gopilotSchoolEntitlementPredicate(entitlementNow),
          eq(schools.gopilotAutoStartEnabled, true),
          isNotNull(schools.dismissalTime)
        )
      );

    const now = new Date();
    const eligible: Array<(typeof result)[number] & { localDate: string }> = [];
    for (const school of result) {
      const clock = evaluateGoPilotAutoStartClock(
        now,
        school.schoolTimezone || "America/New_York",
        school.dismissalTime || ""
      );
      if (!clock.ready) {
        if (clock.reason !== "before_dismissal_time") {
          emitGoPilotSchedulerMetric("AutoStartSkipped", clock.reason);
        }
        continue;
      }
      try {
        const instructional = await getInstructionalDateStatus(school.id, clock.localDate, schedulerDb);
        if (!instructional.instructional) {
          emitGoPilotSchedulerMetric("AutoStartSkipped", instructional.reason);
          continue;
        }
      } catch (error) {
        // Missing/corrupt instructional settings fail closed for student safety;
        // one school's bad legacy data must not abort unrelated schools.
        emitGoPilotSchedulerMetric("AutoStartSkipped", "calendar_unavailable");
        errorMonitor.trackError("scheduler_failure", error as Error, {
          job: "checkDismissalTimes",
          errorCode: (error as { code?: string }).code ?? "GOPILOT_CALENDAR_UNAVAILABLE",
        });
        continue;
      }
      eligible.push({ ...school, localDate: clock.localDate });
    }

    if (eligible.length > 0) {
      console.log(`[Scheduler] Found ${eligible.length} tenant(s) ready for dismissal`);
    }
    for (const school of eligible) {
      await autoStartDismissal(school.id, school.name, school.localDate);
    }
  } catch (err) {
    console.error("[Scheduler] Dismissal scan failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "checkDismissalTimes" });
  }
}

export type GoPilotAutoStartClock =
  | { ready: true; localDate: string; localTime: string }
  | { ready: false; reason: "invalid_timezone" | "invalid_dismissal_time" | "before_dismissal_time" };

export function evaluateGoPilotAutoStartClock(
  now: Date,
  timeZone: string,
  dismissalTime: string
): GoPilotAutoStartClock {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dismissalTime)) {
    return { ready: false, reason: "invalid_dismissal_time" };
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value ?? "";
    const localDate = `${part("year")}-${part("month")}-${part("day")}`;
    const localTime = `${part("hour")}:${part("minute")}`;
    if (localTime < dismissalTime) {
      return { ready: false, reason: "before_dismissal_time" };
    }
    return { ready: true, localDate, localTime };
  } catch {
    return { ready: false, reason: "invalid_timezone" };
  }
}

function emitGoPilotSchedulerMetric(
  metric: "AutoStartStarted" | "AutoStartSkipped" | "StaleSessionPaused",
  reason: string
) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/GoPilot",
        Dimensions: [["Environment", "Reason"]],
        Metrics: [{ Name: metric, Unit: "Count" }],
      }],
    },
    Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    Reason: reason,
    [metric]: 1,
  }));
}

async function autoStartDismissal(schoolId: string, schoolName: string, expectedLocalDate: string) {
  try {
    const startedSession = await schedulerDb.transaction(async (tx) => {
      const transactionDb = tx as unknown as typeof schedulerDb;
      const lifecycleLocked = await lockStaffAssignmentLifecycleSchool(
        tx as unknown as Parameters<typeof lockStaffAssignmentLifecycleSchool>[0],
        schoolId
      );
      if (!lifecycleLocked) return null;
      return withInstructionalCalendarDateLock(
        schoolId,
        expectedLocalDate,
        async (lockedDb) => {
        const entitlement = await resolveGopilotEntitlement(
          schoolId,
          lockedDb,
          { lock: "update" }
        );
        if (!entitlement.entitled) {
          emitGoPilotSchedulerMetric("AutoStartSkipped", entitlement.reason);
          return null;
        }
        const [school] = await lockedDb
          .select({
            id: schools.id,
            schoolTimezone: schools.schoolTimezone,
            dismissalTime: schools.dismissalTime,
          })
          .from(schools)
          .where(
            and(
              eq(schools.id, schoolId),
              eq(schools.gopilotAutoStartEnabled, true)
            )
          )
          .limit(1)
          .for("update", { of: schools });
        if (!school) return null;
        const currentClock = evaluateGoPilotAutoStartClock(
          new Date(),
          school.schoolTimezone || "America/New_York",
          school.dismissalTime || ""
        );
        if (!currentClock.ready || currentClock.localDate !== expectedLocalDate) return null;
        const instructional = await getInstructionalDateStatus(
          schoolId,
          currentClock.localDate,
          lockedDb
        );
        if (!instructional.instructional) return null;
        const session = await getOrCreateSession(schoolId, currentClock.localDate, lockedDb);
        if (session.status !== "pending") return null;
        const updated = await updateSessionStatus(session.id, "active", lockedDb);
        await lockedDb.insert(activityLog).values({
          schoolId,
          sessionId: session.id,
          action: "session.auto_started",
          entityType: "dismissal_session",
          entityId: session.id,
          details: { localDate: currentClock.localDate },
        });
        return updated ?? session;
        },
        transactionDb
      );
    });

    if (startedSession) {
      console.log("[Scheduler] Auto-started one dismissal session");
      emitGoPilotSchedulerMetric("AutoStartStarted", "scheduled_time_reached");
      const payload = { sessionId: startedSession.id };
      await Promise.all([
        publishGoPilotEvent(`school:${schoolId}`, "dismissal:status", { ...payload, status: "active" }),
        publishGoPilotEvent(`school:${schoolId}`, "dismissal:started", payload),
      ]);
    }
  } catch (err) {
    console.error("[Scheduler] Failed to auto-start dismissal");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoStartDismissal" });
  }
}

async function autoCompleteStaleGoPilotSessions() {
  try {
    // Stale sessions with outstanding students are paused for staff review;
    // empty/completed queues may be closed automatically.
    const staleSessions = await schedulerDb
      .select({
        id: dismissalSessions.id,
        schoolId: dismissalSessions.schoolId,
        date: dismissalSessions.date,
        schoolTimezone: schools.schoolTimezone,
      })
      .from(dismissalSessions)
      .innerJoin(schools, eq(dismissalSessions.schoolId, schools.id))
      .where(
        inArray(dismissalSessions.status, ["active", "paused"])
      );

    for (const session of staleSessions) {
      let currentLocalDate: string;
      try {
        currentLocalDate = localDateInTimeZone(
          new Date(),
          session.schoolTimezone || "America/New_York"
        );
      } catch (error) {
        errorMonitor.trackError("scheduler_failure", error as Error, {
          job: "autoCompleteStaleGoPilotSessions",
          schoolId: session.schoolId,
          errorCode: "GOPILOT_INVALID_TIMEZONE",
        });
        continue;
      }
      if (session.date >= currentLocalDate) continue;
      const outcome = await schedulerDb.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(dismissalSessions)
          .where(
            and(
              eq(dismissalSessions.id, session.id),
              eq(dismissalSessions.schoolId, session.schoolId)
            )
          )
          .limit(1)
          .for("update");
        if (!current || !["active", "paused"].includes(current.status)) return null;
        const [stats] = await tx
          .select({
            outstanding: sql<number>`COUNT(*) FILTER (WHERE ${dismissalQueue.status} <> 'dismissed')::int`,
          })
          .from(dismissalQueue)
          .innerJoin(
            students,
            and(
              eq(students.id, dismissalQueue.studentId),
              eq(students.schoolId, session.schoolId),
              eq(students.status, "active")
            )
          )
          .where(
            and(
              eq(dismissalQueue.schoolId, session.schoolId),
              eq(dismissalQueue.sessionId, session.id)
            )
          );
        const outstanding = Number(stats?.outstanding ?? 0);
        const nextStatus = outstanding > 0 ? "paused" : "completed";
        if (current.status === nextStatus) return null;
        const [updated] = await tx
          .update(dismissalSessions)
          .set({
            status: nextStatus,
            ...(nextStatus === "completed" ? { endedAt: new Date() } : {}),
          })
          .where(
            and(
              eq(dismissalSessions.id, session.id),
              eq(dismissalSessions.schoolId, session.schoolId),
              eq(dismissalSessions.status, current.status)
            )
          )
          .returning({ id: dismissalSessions.id });
        if (!updated) return null;
        await tx.insert(activityLog).values({
          schoolId: session.schoolId,
          sessionId: session.id,
          action: outstanding > 0 ? "session.stale_paused" : "session.stale_completed",
          entityType: "dismissal_session",
          entityId: session.id,
          details: { outstanding },
        });
        return { outstanding, nextStatus };
      });
      if (!outcome) continue;
      const { outstanding, nextStatus } = outcome;
      if (outstanding > 0) emitGoPilotSchedulerMetric("StaleSessionPaused", "outstanding_queue");
      await publishGoPilotEvent(`school:${session.schoolId}`, "dismissal:status", {
        sessionId: session.id,
        status: nextStatus,
        outstanding,
      });
      console.log(`[GoPilot] Stale session moved to ${nextStatus}; outstanding=${outstanding}`);
    }
  } catch (err) {
    console.error("[GoPilot] Failed to auto-complete stale sessions");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoCompleteStaleGoPilotSessions" });
  }
}

// ============================================================================
// ClassPilot - Auto-end stale teaching sessions
// Safety net for teachers who forget to click "End Class" without scheduling.
// Two triggers: (1) after school hours + running ≥ 1h, (2) hard 12-hour cap.
// ============================================================================

const MAX_SESSION_HOURS = 12;
const MIN_AGE_FOR_AFTER_HOURS_END = 1; // hours — don't cut off teachers who just started

async function expireClasspilotSupervisionContexts() {
  try {
    const released = await releaseExpiredClasspilotSupervisionContexts({}, schedulerDb);
    const studentsBySchool = new Map<string, Set<string>>();
    for (const assignment of released) {
      const studentIds = studentsBySchool.get(assignment.schoolId) || new Set<string>();
      studentIds.add(assignment.studentId);
      studentsBySchool.set(assignment.schoolId, studentIds);
    }
    await Promise.all([...studentsBySchool].map(([schoolId, studentIds]) =>
      syncClasspilotControlStatesToActiveDevices(schoolId, [...studentIds])
    ));
  } catch (err) {
    console.error("[ClassPilot] Failed to expire supervision contexts");
    errorMonitor.trackError("scheduler_failure", err as Error, {
      job: "expireClasspilotSupervisionContexts",
    });
  }
}

async function expireClasspilotTransientCommands() {
  try {
    await expireClasspilotTransientCommandTargets({}, schedulerDb);
  } catch (err) {
    console.error("[ClassPilot] Failed to expire transient commands");
    errorMonitor.trackError("scheduler_failure", err as Error, {
      job: "expireClasspilotTransientCommands",
    });
  }
}

async function autoEndStaleClassPilotSessions() {
  try {
    // Find all open teaching sessions across all schools
    const openSessions = await schedulerDb
      .select({
        sessionId: teachingSessions.id,
        teacherId: teachingSessions.teacherId,
        groupId: teachingSessions.groupId,
        startTime: teachingSessions.startTime,
        sessionMode: teachingSessions.sessionMode,
        scheduledState: teachingSessions.scheduledState,
        scheduledConflictId: teachingSessions.scheduledConflictId,
        schoolId: schools.id,
        schoolTimezone: schools.schoolTimezone,
        scheduleEnabled: groups.scheduleEnabled,
      })
      .from(teachingSessions)
      .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
      .innerJoin(schools, eq(groups.schoolId, schools.id))
      .where(isNull(teachingSessions.endTime));

    if (openSessions.length === 0) return;

    const now = new Date();

    for (const s of openSessions) {
      const ageMs = now.getTime() - new Date(s.startTime).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);

      let shouldEnd = false;
      let reason = "";

      // Hard cap: 12 hours regardless of anything
      if (ageHours >= MAX_SESSION_HOURS) {
        shouldEnd = true;
        reason = `exceeded ${MAX_SESSION_HOURS}-hour maximum`;
      } else if (ageHours >= MIN_AGE_FOR_AFTER_HOURS_END) {
        // A scheduled occurrence owns its frozen end timestamp. Generic
        // after-hours cleanup must not truncate it; only the hard safety cap
        // above may intervene, through the same finalizer.
        if (
          s.sessionMode === "scheduled_report"
          || s.scheduledState === "active"
          || !!s.scheduledConflictId
        ) continue;
        // After school hours check
        try {
          const settings = await getSettingsForSchool(s.schoolId, schedulerDb);
          if (settings?.enableTrackingHours && settings.trackingEndTime) {
            if (!isWithinTrackingWindow({
              enableTrackingHours: settings.enableTrackingHours,
              trackingStartTime: settings.trackingStartTime,
              trackingEndTime: settings.trackingEndTime,
              trackingDays: settings.trackingDays,
              schoolTimezone: settings.schoolTimezone || s.schoolTimezone,
            }, now)) {
              shouldEnd = true;
              reason = "school hours ended";
            }
          }
        } catch { /* settings lookup failed, skip after-hours check */ }
      }

      if (shouldEnd) {
        const result = await finalizeClasspilotSession({
          schoolId: s.schoolId,
          sessionId: s.sessionId,
          reason: "safety_timeout",
          dbInstance: schedulerDb,
        });
        if (!result?.finalized) continue;
        console.log(`[ClassPilot] Auto-ended one stale session (${reason}, age: ${ageHours.toFixed(1)}h)`);

      }
    }
  } catch (err) {
    console.error("[ClassPilot] Auto-end stale sessions failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoEndStaleClassPilotSessions" });
  }
}

// ============================================================================
// ClassPilot - Daily usage rollup
// ============================================================================

async function rollupDailyUsage() {
  const startedAt = performance.now();
  let processedSchools = 0;
  let failedSchools = 0;
  let shadowMismatches = 0;
  try {
    // Find active schools with ClassPilot license (uses dedicated scheduler pool)
    const activeSchools = await schedulerDb
      .select({
        id: schools.id,
        schoolTimezone: schools.schoolTimezone,
      })
      .from(schools)
      .innerJoin(
        productLicenses,
        and(
          eq(productLicenses.schoolId, schools.id),
          eq(productLicenses.product, "CLASSPILOT"),
          eq(productLicenses.status, "active")
        )
      )
      .where(and(
        eq(schools.status, "active"),
        eq(schools.isActive, true),
        isNull(schools.disabledAt),
        isNull(schools.deletedAt),
        sql`${schools.planStatus} <> 'canceled'`,
        or(isNull(schools.activeUntil), gt(schools.activeUntil, sql`now()`)),
        or(isNull(productLicenses.expiresAt), gt(productLicenses.expiresAt, sql`now()`))
      ));

    const now = new Date();
    for (let offset = 0; offset < activeSchools.length; offset += DAILY_USAGE_SCHOOL_BATCH_SIZE) {
      const batch = activeSchools.slice(offset, offset + DAILY_USAGE_SCHOOL_BATCH_SIZE);
      let next = 0;
      const workers = Array.from(
        { length: Math.min(DAILY_USAGE_SCHOOL_CONCURRENCY, batch.length) },
        async () => {
          while (next < batch.length) {
            const school = batch[next++];
            if (!school) return;
            try {
              const window = dailyUsageRollupWindow(
                now,
                school.schoolTimezone || "America/New_York"
              );
              if (!window) continue;
              if (await dailyUsageRollupMarkers.isComplete(school.id, window.date)) continue;
              const outcome = await rollupSchoolUsage(school.id, window);
              processedSchools += 1;
              if (outcome.shadowMismatch) shadowMismatches += 1;
              await dailyUsageRollupMarkers.markComplete(school.id, window.date);
            } catch (err) {
              failedSchools += 1;
              errorMonitor.trackError("scheduler_failure", err as Error, {
                job: "rollupSchoolUsage",
              });
            }
          }
        }
      );
      await Promise.all(workers);
      // Yield between fixed-size batches so other worker jobs can acquire the pool.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (err) {
    console.error("[ClassPilot] Daily usage rollup failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "rollupDailyUsage" });
    failedSchools += 1;
  } finally {
    console.log(JSON.stringify({
      event: "classpilot_daily_usage_rollup",
      processedSchools,
      failedSchools,
      shadowMismatches,
      durationMs: Math.round(performance.now() - startedAt),
      batchSize: DAILY_USAGE_SCHOOL_BATCH_SIZE,
      concurrency: DAILY_USAGE_SCHOOL_CONCURRENCY,
    }));
  }
}

type DailyUsageRollupMode = "legacy" | "shadow" | "set_based";

function dailyUsageRollupMode(): DailyUsageRollupMode {
  const configured = String(process.env.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE || "shadow")
    .trim()
    .toLowerCase();
  if (configured === "set_based") return "set_based";
  if (configured === "legacy") return "legacy";
  return "shadow";
}

async function rollupSchoolUsage(
  schoolId: string,
  window: DailyUsageRollupWindow
): Promise<{ rowCount: number; shadowMismatch: boolean }> {
  const mode = dailyUsageRollupMode();
  const parameters = {
    schoolId,
    date: window.date,
    dayStartUtc: window.dayStartUtc,
    dayEndUtc: window.dayEndUtc,
  };
  if (mode === "set_based") {
    const rows = await upsertSetBasedDailyUsage(schedulerPool, parameters);
    return { rowCount: rows.length, shadowMismatch: false };
  }

  const legacy = await rollupSchoolUsageLegacy(schoolId, window);
  if (mode === "legacy") return { rowCount: legacy.length, shadowMismatch: false };
  const candidate = await readSetBasedDailyUsageCandidate(schedulerPool, parameters);
  return {
    rowCount: legacy.length,
    shadowMismatch: !dailyUsageAggregatesEqual(legacy, candidate),
  };
}

async function rollupSchoolUsageLegacy(
  schoolId: string,
  window: DailyUsageRollupWindow
): Promise<DailyUsageAggregate[]> {
  // Aggregate heartbeats per student using raw, indexed timestamp comparisons.
  // All scheduler queries go through schedulerDb (dedicated pool, isolated from API requests).
  const studentTotals = await schedulerDb
    .select({
      studentId: heartbeats.studentId,
      heartbeatCount: sql<number>`COUNT(*)::int`,
      totalSeconds: sql<number>`(COUNT(*) * 10)::int`,
      firstSeen: sql<string | null>`MIN(${heartbeats.timestamp})::text`,
      lastSeen: sql<string | null>`MAX(${heartbeats.timestamp})::text`,
    })
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        gte(heartbeats.timestamp, window.dayStartUtc),
        lt(heartbeats.timestamp, window.dayEndUtc)
      )
    )
    .groupBy(heartbeats.studentId);

  if (studentTotals.length === 0) {
    return [];
  }

  // Get top domains per student from the same half-open UTC window.
  const domainData = await schedulerDb
    .select({
      studentId: heartbeats.studentId,
      domain: sql<string>`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)')`,
      seconds: sql<number>`(COUNT(*) * 10)::int`,
      visits: sql<number>`COUNT(*)::int`,
    })
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        gte(heartbeats.timestamp, window.dayStartUtc),
        lt(heartbeats.timestamp, window.dayEndUtc),
        sql`${heartbeats.activeTabUrl} IS NOT NULL`
      )
    )
    .groupBy(heartbeats.studentId, sql`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)')`)
    .orderBy(sql`COUNT(*) DESC`, sql`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)') ASC`);

  // Group domains by student and take top 5.
  const studentDomains = new Map<string, { domain: string; seconds: number; visits: number }[]>();
  for (const row of domainData) {
    if (!row.studentId || !row.domain) continue;
    const list = studentDomains.get(row.studentId) || [];
    if (list.length < 5) {
      list.push({ domain: row.domain, seconds: row.seconds, visits: row.visits });
    }
    studentDomains.set(row.studentId, list);
  }

  // Upsert daily usage for each student (through scheduler pool). If a worker
  // stops partway through, the next run safely recomputes and overwrites rows.
  const aggregates: DailyUsageAggregate[] = [];
  for (const row of studentTotals) {
    if (!row.studentId) continue;
    const firstSeen = coerceSchedulerTimestamp(row.firstSeen);
    const lastSeen = coerceSchedulerTimestamp(row.lastSeen);
    await schedulerDb
      .insert(dailyUsage)
      .values({
        schoolId,
        studentId: row.studentId,
        date: window.date,
        totalSeconds: row.totalSeconds,
        heartbeatCount: row.heartbeatCount,
        topDomains: studentDomains.get(row.studentId) || [],
        firstSeen,
        lastSeen,
      })
      .onConflictDoUpdate({
        target: [dailyUsage.studentId, dailyUsage.date],
        set: {
          totalSeconds: row.totalSeconds,
          heartbeatCount: row.heartbeatCount,
          topDomains: studentDomains.get(row.studentId) || [],
          firstSeen,
          lastSeen,
          computedAt: sql`now()`,
        },
      });
    aggregates.push({
      studentId: row.studentId,
      totalSeconds: row.totalSeconds,
      heartbeatCount: row.heartbeatCount,
      topDomains: studentDomains.get(row.studentId) || [],
      firstSeen,
      lastSeen,
    });
  }
  return aggregates;
}

// ============================================================================
// ClassPilot - Heartbeat purge (based on retentionHours setting)
// ============================================================================

async function purgeExpiredHeartbeats() {
  try {
    // Retention applies to every school, including inactive, suspended, and
    // unlicensed tenants. Licensing must never become a data-retention bypass.
    const allSchools = await schedulerDb
      .select({ id: schools.id, timezone: schools.schoolTimezone })
      .from(schools);

    for (const school of allSchools) {
      try {
      const schoolSettings = await getSettingsForSchool(school.id, schedulerDb);
      const retentionDays = parseClasspilotRetentionDays(schoolSettings?.retentionHours);
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      let cutoffLocalDate: string;
      try {
        cutoffLocalDate = localDateInTimeZone(
          cutoff,
          school.timezone || "America/New_York"
        );
      } catch {
        // A malformed legacy timezone must not become a privacy-retention
        // bypass. Timestamped detail still purges normally; UTC is the safest
        // deterministic fallback for date-bucket rollups.
        cutoffLocalDate = localDateInTimeZone(cutoff, "UTC");
      }

      // Batch delete in chunks of 5000 to avoid long table locks and memory bloat.
      // Uses raw SQL with row count instead of .returning() which loads all IDs into memory.
      let totalDeleted = 0;
      let batchDeleted = 0;
      do {
        const result = await schedulerPool.query(
          `DELETE FROM heartbeats WHERE id IN (
            SELECT id FROM heartbeats WHERE school_id = $1 AND timestamp < $2 LIMIT 5000
          )`,
          [school.id, cutoff]
        );
        batchDeleted = result.rowCount || 0;
        totalDeleted += batchDeleted;
        if (batchDeleted > 0) {
          // Yield between batches so other queries can run
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } while (batchDeleted >= 5000);

      if (totalDeleted > 0) {
        console.log(`[ClassPilot] Purged ${totalDeleted} expired heartbeats for one tenant (retention: ${retentionDays}d)`);
      }

      // Session-linked derived data follows the same school setting. Report
      // parents become non-detail expiration markers so reads return 410 rather
      // than a misleading empty report.
      await schedulerPool.query(`
        WITH expired_reports AS MATERIALIZED (
          SELECT report.id, report.teaching_session_id
          FROM classpilot_session_reports AS report
          WHERE report.school_id = $1
            AND report.authorization_marker IS NOT NULL
            AND (report.expires_at <= NOW() OR report.window_end < $2)
            AND (
              report.detail_expired_at IS NULL
              OR EXISTS (
                SELECT 1 FROM classpilot_session_student_reports AS detail
                WHERE detail.school_id = $1 AND detail.report_id = report.id
              )
              OR EXISTS (
                SELECT 1 FROM classpilot_session_students AS roster
                WHERE roster.school_id = $1
                  AND roster.teaching_session_id = report.teaching_session_id
              )
              OR EXISTS (
                SELECT 1 FROM classpilot_session_staff AS staff
                WHERE staff.school_id = $1
                  AND staff.teaching_session_id = report.teaching_session_id
              )
              OR EXISTS (
                SELECT 1 FROM classpilot_session_summary_deliveries AS delivery
                WHERE delivery.school_id = $1
                  AND delivery.teaching_session_id = report.teaching_session_id
                  AND (
                    delivery.recipient_email NOT LIKE 'expired+%@invalid.local'
                    OR delivery.recipient_name IS NOT NULL
                    OR delivery.provider_message_id IS NOT NULL
                    OR delivery.last_error IS NOT NULL
                )
              )
            )
          FOR UPDATE OF report SKIP LOCKED
        ), deleted_students AS (
          DELETE FROM classpilot_session_student_reports
          WHERE school_id = $1 AND report_id IN (SELECT id FROM expired_reports)
        ), deleted_rosters AS (
          DELETE FROM classpilot_session_students
          WHERE school_id = $1
            AND teaching_session_id IN (
              SELECT teaching_session_id FROM expired_reports
            )
        ), deleted_staff AS (
          DELETE FROM classpilot_session_staff
          WHERE school_id = $1
            AND teaching_session_id IN (
              SELECT teaching_session_id FROM expired_reports
            )
        ), redacted_deliveries AS (
          UPDATE classpilot_session_summary_deliveries
          SET recipient_email = CONCAT('expired+', id, '@invalid.local'),
              recipient_name = NULL,
              provider_message_id = NULL,
              last_error = NULL,
              updated_at = NOW()
          WHERE school_id = $1
            AND teaching_session_id IN (
              SELECT teaching_session_id FROM expired_reports
            )
        )
        UPDATE classpilot_session_reports
        SET state = 'expired', detail_expired_at = NOW(),
            roster_count = 0, eligible_student_count = 0,
            complete_count = 0, partial_count = 0, none_count = 0,
            not_expected_count = 0, unavailable_count = 0,
            total_eligible_seconds = 0, total_observed_seconds = 0,
            total_gap_seconds = 0, lease_owner = NULL,
            lease_expires_at = NULL, last_error = NULL, updated_at = NOW()
        WHERE id IN (SELECT id FROM expired_reports)
      `, [school.id, cutoff]);
      await schedulerPool.query(`
        DELETE FROM classpilot_monitoring_events
        WHERE school_id = $1
          AND (retention_expires_at <= NOW() OR occurred_at < $2)
      `, [school.id, cutoff]);
      await schedulerPool.query(`DELETE FROM classpilot_session_usage WHERE school_id = $1 AND local_date < $2`, [school.id, cutoffLocalDate]);
      await schedulerPool.query(`DELETE FROM daily_usage WHERE school_id = $1 AND date < $2`, [school.id, cutoffLocalDate]);
      await schedulerPool.query(`
        DELETE FROM events AS legacy
        USING devices AS device
        WHERE legacy.device_id = device.device_id
          AND device.school_id = $1
          AND legacy.timestamp < $2
      `, [school.id, cutoff]);
      // Pre-report delivery rows can exist from an older release. They have no
      // immutable report parent to drive the CTE above, but their recipient
      // identity is subject to the same tenant retention period.
      await schedulerPool.query(`
        UPDATE classpilot_session_summary_deliveries AS delivery
        SET recipient_email = CONCAT('expired+', delivery.id, '@invalid.local'),
            recipient_name = NULL,
            provider_message_id = NULL,
            last_error = NULL,
            state = CASE
              WHEN delivery.state IN ('waiting_report', 'queued', 'leased', 'retry') THEN 'failed'
              ELSE delivery.state
            END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        FROM teaching_sessions AS session
        WHERE delivery.school_id = $1
          AND session.id = delivery.teaching_session_id
          AND session.school_id = $1
          AND session.end_time < $2
          AND NOT EXISTS (
            SELECT 1 FROM classpilot_session_reports AS report
            WHERE report.school_id = $1
              AND report.teaching_session_id = delivery.teaching_session_id
          )
          AND (
            delivery.recipient_email NOT LIKE 'expired+%@invalid.local'
            OR delivery.recipient_name IS NOT NULL
            OR delivery.provider_message_id IS NOT NULL
            OR delivery.last_error IS NOT NULL
          )
      `, [school.id, cutoff]);
      // Yield between schools
      await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (schoolError) {
        // Isolate tenant failures so one damaged or transiently locked school
        // cannot prevent retention from running for every later tenant.
        console.error("[ClassPilot] Retention purge failed for one tenant");
        errorMonitor.trackError("scheduler_failure", schoolError as Error, {
          job: "purgeExpiredHeartbeats",
        });
      }
    }

    // The legacy events table has no session boundary and must never be
    // exposed as monitoring history. Rows whose device can no longer identify
    // a tenant are orphans and use the documented 30-day default.
    await schedulerPool.query(`
      DELETE FROM events AS legacy
      WHERE legacy.timestamp < NOW() - INTERVAL '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM devices AS device WHERE device.device_id = legacy.device_id
        )
    `);
  } catch (err) {
    console.error("[ClassPilot] Heartbeat purge failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeExpiredHeartbeats" });
  }
}

// ============================================================================
// ClassPilot - Automatic class block scheduling
// ============================================================================

async function expireDueClasspilotScheduleChanges(options: {
  schoolId: string;
  throughDate: string;
  now: Date;
}): Promise<void> {
  // Keep every reconciliation tick bounded while allowing repeated ticks to
  // drain older dates after an outage. Dates are returned oldest-first, so a
  // long backlog always makes progress without starving today's approvals.
  const backlogDates = await listPendingClasspilotScheduleChangeDatesForSchool({
    schoolId: options.schoolId,
    throughDate: options.throughDate,
    limit: 30,
    dbInstance: schedulerDb,
  });
  const pendingDates = Array.from(new Set([...backlogDates, options.throughDate]));
  for (const scheduledDate of pendingDates) {
    try {
      const expired = await expirePendingClasspilotScheduleChangesForSchool({
        schoolId: options.schoolId,
        scheduledDate,
        now: options.now,
        dbInstance: schedulerDb,
      });
      if (expired.expiredIds.length === 0) continue;
      for (const _expiredId of expired.expiredIds) {
        emitClasspilotScheduleChangeMetric("ScheduleChangeExpired", {
          Outcome: "approval_incomplete_at_bell",
        });
      }
      console.log(
        `[ClassPilot] Expired ${expired.expiredIds.length} pending schedule change(s)`
      );
      await Promise.allSettled(expired.expiredIds.map((changeId) =>
        broadcastClasspilotScheduleChangeUpdate({
          schoolId: options.schoolId,
          changeId,
          status: "expired",
          scheduledDate,
        })
      ));
      await Promise.allSettled(expired.expiredIds.map(async (changeId) => {
        const notification = await getClasspilotScheduleChangeNotificationContext({
          schoolId: options.schoolId,
          changeId,
          dbInstance: schedulerDb,
        });
        if (notification) sendClasspilotScheduleChangeEmails(notification);
      }));
    } catch (error) {
      // A damaged historical row must not keep newer dates reserved forever.
      // Report only a fixed error code; the monitor receives no tenant or row
      // identifiers from this recovery loop.
      console.error("[ClassPilot] Pending schedule-change expiry failed");
      errorMonitor.trackError("scheduler_failure", error as Error, {
        job: "reconcileClasspilotScheduledSessions",
        errorCode: "SCHEDULE_CHANGE_EXPIRY_FAILED",
      });
    }
  }
}

export async function reconcileClasspilotScheduledSessions(now = new Date(), schoolId?: string) {
  try {
    const backfilledSnapshots = await backfillOpenTeachingSessionRosterSnapshots(schedulerDb, schoolId);
    if (backfilledSnapshots > 0) {
      console.log(`[ClassPilot] Backfilled immutable rosters for ${backfilledSnapshots} open session(s)`);
    }
    await reconcileLegacyOpenScheduledSessions(now, schedulerDb, schoolId);
    // 1. Finalize frozen occurrences first. This catches delayed ticks and
    // prior-date rows after worker restarts without consulting mutable groups.
    const dueSessions = await listScheduledSessionsReadyToFinalize(now, schedulerDb, schoolId);
    const finalizationConcurrency = 10;
    for (let offset = 0; offset < dueSessions.length; offset += finalizationConcurrency) {
      if (schedulerStopping) break;
      await Promise.all(dueSessions.slice(offset, offset + finalizationConcurrency).map(async (session) => {
        try {
        const result = await finalizeClasspilotSession({
          schoolId: session.schoolId!,
          sessionId: session.id,
          reason: "scheduled_end",
          finalizedAt: session.scheduledEndAt || now,
          dbInstance: schedulerDb,
        });
        // Finalization owns the single session-ended publication.
        } catch (error) {
          console.error("[ClassPilot] Failed to finalize a scheduled occurrence");
          errorMonitor.trackError("scheduler_failure", error as Error, {
            job: "reconcileClasspilotScheduledSessions",
            errorCode: "OCCURRENCE_FINALIZE_FAILED",
          });
        }
      }));
      // Commit the bounded scheduler DB batch first, then drain its best-effort
      // tenant delivery work before producing another batch of pushes.
      await flushClasspilotLifecyclePushes();
    }

    // Pending lifecycle cleanup must continue after a license or school
    // entitlement expires so reservations cannot remain stuck. Enumerate that
    // bounded work separately from the stricter occurrence-execution set.
    const pendingLifecycleConditions = [
      inArray(classpilotScheduleChanges.status, ["pending_counterpart", "pending_admin"]),
      eq(classpilotScheduleChanges.reservationActive, true),
      isNull(schools.deletedAt),
    ];
    if (schoolId) pendingLifecycleConditions.push(eq(schools.id, schoolId));
    const lifecycleSchools = await schedulerDb
      .selectDistinct({ id: schools.id, schoolTimezone: schools.schoolTimezone })
      .from(classpilotScheduleChanges)
      .innerJoin(schools, eq(schools.id, classpilotScheduleChanges.schoolId))
      .where(and(...pendingLifecycleConditions));
    for (const school of lifecycleSchools) {
      const timezone = school.schoolTimezone || "America/New_York";
      const throughDate = localDateInTimeZone(now, timezone);
      try {
        await expireDueClasspilotScheduleChanges({
          schoolId: school.id,
          throughDate,
          now,
        });
      } catch (error) {
        console.error("[ClassPilot] Failed to expire pending schedule changes for one tenant");
        errorMonitor.trackError("scheduler_failure", error as Error, {
          job: "reconcileClasspilotScheduledSessions",
          errorCode: "SCHEDULE_CHANGE_EXPIRY_FAILED",
        });
      }
    }

    // Keep candidate discovery aligned with the authoritative entitlement
    // check used again under the occurrence-creation lock. This prevents an
    // expired or disabled tenant from reaching the effective-window overlay
    // merely because its legacy status/license rows still say "active".
    const activeSchoolConditions = [
      eq(schools.status, "active"),
      eq(schools.isActive, true),
      isNull(schools.deletedAt),
      isNull(schools.disabledAt),
      or(isNull(schools.planStatus), sql`${schools.planStatus} <> 'canceled'`),
      or(isNull(schools.activeUntil), gt(schools.activeUntil, now)),
    ];
    if (schoolId) activeSchoolConditions.push(eq(schools.id, schoolId));
    const activeSchools = await schedulerDb
      .select({
        id: schools.id,
        schoolTimezone: schools.schoolTimezone,
      })
      .from(schools)
      .innerJoin(
        productLicenses,
        and(
          eq(productLicenses.schoolId, schools.id),
          eq(productLicenses.product, "CLASSPILOT"),
          eq(productLicenses.status, "active"),
          or(isNull(productLicenses.expiresAt), gt(productLicenses.expiresAt, now))
        )
      )
      .where(and(...activeSchoolConditions));

    for (const school of activeSchools) {
      try {
        const tz = school.schoolTimezone || "America/New_York";
      const currentTimeHHMM = now.toLocaleString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).replace(/^24:/, "00:");
      const todayDate = now.toLocaleDateString("en-CA", { timeZone: tz });

      // 2. Release/resolve due coverage after occurrences have finalized.
      const expiredConflicts = await expireScheduledClassConflictsForSchool({
        schoolId: school.id,
        scheduledDate: todayDate,
        currentTimeHHMM,
        dbInstance: schedulerDb,
      });
      if (expiredConflicts.length > 0) {
        console.log(`[ClassPilot] Expired ${expiredConflicts.length} scheduled coverage request(s)`);
      }

      // A canonical occurrence frozen at the bell remains authoritative even
      // if an administrator closes the instructional date or edits the group's
      // future schedule before this worker tick. Reconcile these before the
      // new-occurrence calendar gate.
      const frozenDueSessions = await listScheduledReportSessionsDueNow(
        now,
        schedulerDb,
        school.id
      );
      const frozenGroupIds = new Set<string>();
      for (const frozenSession of frozenDueSessions) {
        frozenGroupIds.add(frozenSession.groupId);
        const frozenGroup = await getGroupByIdAndSchool(
          frozenSession.groupId,
          school.id,
          schedulerDb
        );
        if (!frozenGroup || !frozenSession.scheduledDate) continue;
        try {
          await processScheduledClassAutoStart({
            group: frozenGroup,
            scheduledDate: frozenSession.scheduledDate,
            dbInstance: schedulerDb,
            now,
          });
        } catch (error) {
          console.error("[ClassPilot] Failed to reconcile a frozen occurrence");
          errorMonitor.trackError("scheduler_failure", error as Error, {
            job: "reconcileClasspilotScheduledSessions",
            errorCode: "FROZEN_OCCURRENCE_RECONCILE_FAILED",
          });
        }
      }

      // Count-only diagnostics preserve scheduling observability without
      // emitting tenant, group, teacher, or schedule identifiers.
      const allScheduledGroups = await schedulerDb
        .select({ id: groups.id, name: groups.name, blockStartTime: groups.blockStartTime, blockEndTime: groups.blockEndTime, scheduleSkippedDate: groups.scheduleSkippedDate })
        .from(groups)
        .where(and(eq(groups.schoolId, school.id), eq(groups.scheduleEnabled, true)));
      if (allScheduledGroups.length > 0) {
        console.log(`[ClassPilot] Schedule tick evaluated ${allScheduledGroups.length} scheduled group(s)`);
      }

      // 3. Create/promote each currently due canonical occurrence.
      const readyGroups = (await getClasspilotGroupsReadyAtEffectiveWindow({
        schoolId: school.id,
        currentTimeHHMM,
        scheduledDate: todayDate,
        dbInstance: schedulerDb,
      })).filter((group) => !frozenGroupIds.has(group.id));
      if (readyGroups.length > 0) {
        console.log(`[ClassPilot] Auto-start: ${readyGroups.length} group(s) ready`);
      }

      // This is the school-level fail-fast gate. The create path repeats the
      // authoritative read under the shared school/date transaction lock, so a
      // calendar save racing this tick still has one deterministic winner.
      if (readyGroups.length > 0) {
        const calendarStatus = await getInstructionalDateStatus(
          school.id,
          todayDate,
          schedulerDb
        );
        if (!calendarStatus.instructional) {
          recordAutomaticScheduleSkips({
            schoolId: school.id,
            scheduledDate: todayDate,
            groupIds: readyGroups.map((group) => group.id),
            now,
          });
          console.log(
            `[ClassPilot] Skipped ${readyGroups.length} automatic class start(s) (non_instructional_day)`
          );
          continue;
        }
      }

        for (const group of readyGroups) {
        try {
          const result = await processScheduledClassAutoStart({
            group,
            scheduledDate: todayDate,
            dbInstance: schedulerDb,
            now,
          });
          if (result.status === "started") {
            console.log("[ClassPilot] Auto-started one scheduled session");
          } else if (result.status === "already_live") {
            // Steady state for every live occurrence on every tick: nothing to log.
          } else if (result.status === "coverage_needed") {
            console.log("[ClassPilot] Scheduled coverage is needed for one occurrence");
          } else if (result.status === "claimed") {
            console.log("[ClassPilot] Scheduled coverage was already claimed for one occurrence");
          } else {
            console.log(`[ClassPilot] Skipped one scheduled start (${result.reason})`);
          }
        } catch (error) {
          console.error("[ClassPilot] Failed to reconcile one scheduled group");
          errorMonitor.trackError("scheduler_failure", error as Error, {
            job: "reconcileClasspilotScheduledSessions",
            errorCode: "GROUP_RECONCILE_FAILED",
          });
        }
        }
      } catch (error) {
        console.error("[ClassPilot] Failed to reconcile scheduled work for one tenant");
        errorMonitor.trackError("scheduler_failure", error as Error, {
          job: "reconcileClasspilotScheduledSessions",
          errorCode: "SCHOOL_RECONCILE_FAILED",
        });
      }
    }

  } catch (err) {
    console.error("[ClassPilot] Scheduled session reconciliation failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "reconcileClasspilotScheduledSessions" });
  } finally {
    // 4. Freeze coverage after the 30-second settlement window, then dispatch
    // only deliveries whose immutable report is ready. A poison report or
    // scheduling row must not hold unrelated summaries hostage.
    await materializeDueClasspilotSessionReports({
      dbInstance: schedulerDb,
      now,
      limit: 100,
      schoolId,
    }).catch((error) => {
      console.error("[ClassPilot] Session report materialization failed");
      errorMonitor.trackError("scheduler_failure", error as Error, {
        job: "reconcileClasspilotScheduledSessions",
        errorCode: "REPORT_MATERIALIZATION_FAILED",
      });
    });
    await drainDueClasspilotSessionSummaries({
      dbInstance: schedulerDb,
      now,
      schoolId,
      batchLimit: 100,
      maxBatches: 5,
      maxDurationMs: 45_000,
    }).catch((error) => {
      console.error("[ClassPilot] Scheduled summary dispatch failed");
      errorMonitor.trackError("scheduler_failure", error as Error, {
        job: "reconcileClasspilotScheduledSessions",
        errorCode: "SUMMARY_DISPATCH_FAILED",
      });
    });
  }
}

// ============================================================================
// MailPilot - Gmail watch renewal (watches expire after 7 days)
// ============================================================================

/**
 * Delete reviewed email alerts and scan logs older than the retention window.
 * Unreviewed alerts are NEVER auto-deleted (admins must resolve them).
 * Window defaults to 90 days, override via MAILPILOT_RETENTION_DAYS.
 * Uses schedulerDb (dedicated pool) and batched deletes to avoid long locks.
 */
async function purgeMailpilotRetention() {
  try {
    const retentionDays = Math.max(1, parseInt(process.env.MAILPILOT_RETENTION_DAYS || "90", 10));
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Delete reviewed alerts older than cutoff, in batches
    let totalAlerts = 0;
    let batchDeleted = 0;
    do {
      const result = await schedulerPool.query(
        `DELETE FROM email_alerts WHERE id IN (
          SELECT id FROM email_alerts
          WHERE review_status IS NOT NULL AND alerted_at < $1
          LIMIT 2000
        )`,
        [cutoff]
      );
      batchDeleted = result.rowCount || 0;
      totalAlerts += batchDeleted;
      if (batchDeleted > 0) await new Promise((r) => setTimeout(r, 100));
    } while (batchDeleted >= 2000);

    // Scan log is small, single delete is fine
    const scanLogResult = await schedulerPool.query(
      `DELETE FROM email_scan_log WHERE date < TO_CHAR($1::date, 'YYYY-MM-DD')`,
      [cutoff]
    );

    if (totalAlerts > 0 || (scanLogResult.rowCount || 0) > 0) {
      console.log(
        `[MailPilot] Retention purge (>${retentionDays}d): ${totalAlerts} reviewed alerts, ${scanLogResult.rowCount || 0} scan logs`
      );
    }
  } catch (err) {
    console.error("[MailPilot] Retention purge failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeMailpilotRetention" });
  }
}

// ============================================================================
// ClassPilot - Safety spine / messaging retention
// ============================================================================
//
// The safety spine (AI decisions, student timeline, safety cases) and the
// teacher-student messaging tables follow the same per-school retention
// setting as heartbeats. Closed safety cases keep a 90-day floor so a case
// record never disappears sooner than a quarter after it closed; open cases
// are never purged. The job ships in count mode: it evaluates the exact
// delete predicates as SELECT count(*) and logs identifier-free totals so a
// full day of numbers can be reviewed before the task definition flips the
// mode to delete.

const CLOSED_SAFETY_CASE_RETENTION_FLOOR_DAYS = 90;
const RETENTION_BATCH_SIZE = 5000;
const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

export type ClasspilotRetentionPurgeSpineMode = "count" | "delete";

// Read at call time so a task-definition revision takes effect on the next
// hourly run. Anything other than the exact string "delete" stays in count mode.
export function retentionPurgeSpineMode(): ClasspilotRetentionPurgeSpineMode {
  return process.env.CLASSPILOT_RETENTION_PURGE_SPINE_MODE === "delete" ? "delete" : "count";
}

export type ClasspilotSafetySpineRetentionTotals = {
  aiDecisions: number;
  timelineEvents: number;
  closedCases: number;
  messages: number;
  chatDeliveries: number;
};

type SafetySpineRetentionStatement = {
  // Table the delete targets by primary key.
  table: string;
  // FROM clause (target table first, joins after) and predicate shared by the
  // count query and the batched delete so both modes evaluate identical rows.
  from: string;
  targetId: string;
  where: string;
};

function safetySpineCountSql(statement: SafetySpineRetentionStatement): string {
  return `SELECT count(*)::int AS total FROM ${statement.from} WHERE ${statement.where}`;
}

function safetySpineDeleteSql(statement: SafetySpineRetentionStatement): string {
  return `DELETE FROM ${statement.table} WHERE id IN (
    SELECT ${statement.targetId} FROM ${statement.from} WHERE ${statement.where} LIMIT ${RETENTION_BATCH_SIZE}
  )`;
}

// Batch delete in chunks to avoid long table locks and memory bloat. Uses raw
// SQL with row count instead of .returning() so no IDs are loaded into memory.
async function deleteInBatches(statement: string, params: unknown[]): Promise<number> {
  let total = 0;
  let batchDeleted = 0;
  do {
    const result = await schedulerPool.query(statement, params);
    batchDeleted = result.rowCount || 0;
    total += batchDeleted;
    if (batchDeleted > 0) {
      // Yield between batches so other queries can run
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } while (batchDeleted >= RETENTION_BATCH_SIZE);
  return total;
}

async function applySafetySpineRetentionStatement(
  mode: ClasspilotRetentionPurgeSpineMode,
  statement: SafetySpineRetentionStatement,
  params: unknown[]
): Promise<number> {
  if (mode === "delete") {
    return deleteInBatches(safetySpineDeleteSql(statement), params);
  }
  const result = await schedulerPool.query<{ total: number }>(safetySpineCountSql(statement), params);
  return result.rows[0]?.total ?? 0;
}

// Every statement is explicitly tenant-scoped ($1 = school id). Timestamp
// parameters are bound per statement because Postgres rejects unreferenced
// positional parameters, so the closed-case cutoff is $3 where the row cutoff
// is also used and $2 where it is the only timestamp.
export async function purgeClasspilotSafetySpineRetentionForSchool(input: {
  schoolId: string;
  cutoff: Date;
  closedCaseCutoff: Date;
  mode: ClasspilotRetentionPurgeSpineMode;
}): Promise<ClasspilotSafetySpineRetentionTotals> {
  const { schoolId, cutoff, closedCaseCutoff, mode } = input;

  const aiDecisions = await applySafetySpineRetentionStatement(
    mode,
    {
      table: "classpilot_ai_decisions",
      from: "classpilot_ai_decisions",
      targetId: "id",
      where: "school_id = $1 AND created_at < $2",
    },
    [schoolId, cutoff]
  );

  // Timeline rows follow their case: rows of a closed case purge with the
  // case's floor, case-less rows and rows whose case no longer resolves within
  // this tenant purge on the ordinary cutoff, and rows of an open case stay.
  // Runs before the case delete so the join can still see the closing date.
  const timelineEvents = await applySafetySpineRetentionStatement(
    mode,
    {
      table: "student_timeline_events",
      from: `student_timeline_events AS event
        LEFT JOIN student_safety_cases AS safety_case
          ON safety_case.id = event.case_id AND safety_case.school_id = $1`,
      targetId: "event.id",
      where: `event.school_id = $1
        AND (
          (event.case_id IS NULL AND event.occurred_at < $2)
          OR (
            safety_case.id IS NOT NULL
            AND safety_case.status <> 'open'
            AND COALESCE(safety_case.closed_at, safety_case.opened_at) < $3
          )
          OR (event.case_id IS NOT NULL AND safety_case.id IS NULL AND event.occurred_at < $2)
        )`,
    },
    [schoolId, cutoff, closedCaseCutoff]
  );

  // A closed case cited by a retained evidence artifact stays so the artifact
  // keeps its context; open cases never purge.
  const closedCases = await applySafetySpineRetentionStatement(
    mode,
    {
      table: "student_safety_cases",
      from: "student_safety_cases AS safety_case",
      targetId: "safety_case.id",
      where: `safety_case.school_id = $1
        AND safety_case.status <> 'open'
        AND COALESCE(safety_case.closed_at, safety_case.opened_at) < $2
        AND NOT EXISTS (SELECT 1 FROM evidence_artifacts AS artifact
          WHERE artifact.school_id = $1 AND artifact.case_id = safety_case.id)`,
    },
    [schoolId, closedCaseCutoff]
  );

  // Legacy messages with a NULL school_id are deliberately left alone here;
  // an orphan sweep is a separate policy decision.
  const messages = await applySafetySpineRetentionStatement(
    mode,
    {
      table: "messages",
      from: "messages",
      targetId: "id",
      where: `school_id = $1 AND "timestamp" < $2`,
    },
    [schoolId, cutoff]
  );

  // A delivery under a live lease belongs to a worker until the lease lapses.
  const chatDeliveries = await applySafetySpineRetentionStatement(
    mode,
    {
      table: "classpilot_chat_deliveries",
      from: "classpilot_chat_deliveries",
      targetId: "id",
      where: `school_id = $1
        AND expires_at < $2
        AND (state <> 'leased' OR lease_expires_at IS NULL OR lease_expires_at < $2)`,
    },
    [schoolId, cutoff]
  );

  return { aiDecisions, timelineEvents, closedCases, messages, chatDeliveries };
}

async function purgeClasspilotSafetySpineRetention() {
  const mode = retentionPurgeSpineMode();
  const totals: ClasspilotSafetySpineRetentionTotals = {
    aiDecisions: 0,
    timelineEvents: 0,
    closedCases: 0,
    messages: 0,
    chatDeliveries: 0,
  };
  let tenants = 0;
  let failedTenants = 0;
  try {
    // Retention applies to every school, including inactive, suspended, and
    // unlicensed tenants. Licensing must never become a data-retention bypass.
    const allSchools = await schedulerDb.select({ id: schools.id }).from(schools);

    for (const school of allSchools) {
      tenants += 1;
      try {
        const schoolSettings = await getSettingsForSchool(school.id, schedulerDb);
        const retentionDays = parseClasspilotRetentionDays(schoolSettings?.retentionHours);
        const now = Date.now();
        const cutoff = new Date(now - retentionDays * RETENTION_DAY_MS);
        const closedCaseCutoff = new Date(
          now - Math.max(retentionDays, CLOSED_SAFETY_CASE_RETENTION_FLOOR_DAYS) * RETENTION_DAY_MS
        );
        const schoolTotals = await purgeClasspilotSafetySpineRetentionForSchool({
          schoolId: school.id,
          cutoff,
          closedCaseCutoff,
          mode,
        });
        totals.aiDecisions += schoolTotals.aiDecisions;
        totals.timelineEvents += schoolTotals.timelineEvents;
        totals.closedCases += schoolTotals.closedCases;
        totals.messages += schoolTotals.messages;
        totals.chatDeliveries += schoolTotals.chatDeliveries;
        // Yield between schools
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (schoolError) {
        // Isolate tenant failures so one damaged or transiently locked school
        // cannot prevent retention from running for every later tenant.
        failedTenants += 1;
        console.error("[ClassPilot] Safety spine retention failed for one tenant");
        errorMonitor.trackError("scheduler_failure", schoolError as Error, {
          job: "purgeClasspilotSafetySpineRetention",
        });
      }
    }
  } catch (err) {
    console.error("[ClassPilot] Safety spine retention failed");
    errorMonitor.trackError("scheduler_failure", err as Error, {
      job: "purgeClasspilotSafetySpineRetention",
    });
  }
  // One identifier-free summary per run: mode, tenant counts, and totals only.
  console.log(
    `[ClassPilot] Safety spine retention mode=${mode} tenants=${tenants} failed=${failedTenants} ` +
      `aiDecisions=${totals.aiDecisions} timelineEvents=${totals.timelineEvents} ` +
      `closedCases=${totals.closedCases} messages=${totals.messages} chatDeliveries=${totals.chatDeliveries}`
  );
}

// Error logs retention — keep 30 days, then purge in batches. Uses the
// dedicated scheduler pool so it never starves the API connection pool.
async function purgeOldErrorLogs() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let batchDeleted = 0;
    let total = 0;
    do {
      const result = await schedulerPool.query(
        `DELETE FROM error_logs WHERE id IN (
          SELECT id FROM error_logs WHERE created_at < $1 LIMIT 5000
        )`,
        [cutoff]
      );
      batchDeleted = result.rowCount || 0;
      total += batchDeleted;
      if (batchDeleted > 0) await new Promise((r) => setTimeout(r, 100));
    } while (batchDeleted >= 5000);
    if (total > 0) console.log(`[ErrorLogs] Purged ${total} error logs older than 30 days`);
  } catch (err) {
    console.error("[ErrorLogs] Retention purge failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeOldErrorLogs" });
  }
}

function parseRetentionDays(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Evidence artifact retention — preserve artifact rows and metadata, but remove
// old screenshot payloads so base64 blobs cannot grow without bound.
async function purgeExpiredEvidenceArtifactContent() {
  try {
    const retentionDays = parseRetentionDays(process.env.EVIDENCE_ARTIFACT_CONTENT_RETENTION_DAYS, 30);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    let batchUpdated = 0;
    let total = 0;

    do {
      const result = await schedulerPool.query(
        `WITH expired AS (
          SELECT id FROM evidence_artifacts
          WHERE artifact_type = 'screenshot'
            AND content IS NOT NULL
            AND captured_at < $1
          LIMIT 1000
        )
        UPDATE evidence_artifacts AS artifact
        SET
          content = NULL,
          status = CASE WHEN artifact.status = 'available' THEN 'expired' ELSE artifact.status END,
          metadata = COALESCE(artifact.metadata, '{}'::jsonb)
            || jsonb_build_object('contentPurgedAt', NOW(), 'retentionDays', $2::int)
        FROM expired
        WHERE artifact.id = expired.id`,
        [cutoff, retentionDays]
      );
      batchUpdated = result.rowCount || 0;
      total += batchUpdated;
      if (batchUpdated > 0) await new Promise((r) => setTimeout(r, 100));
    } while (batchUpdated >= 1000);

    if (total > 0) {
      console.log(`[Evidence] Purged ${total} screenshot artifact payloads older than ${retentionDays} days`);
    }
  } catch (err) {
    console.error("[Evidence] Retention purge failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeExpiredEvidenceArtifactContent" });
  }
}

export async function expireClasspilotEvidenceCaptureRequests() {
  try {
    const result = await schedulerPool.query(`
      WITH due AS (
        SELECT request.*
        FROM classpilot_evidence_capture_requests AS request
        WHERE request.status = 'pending'
          AND request.expires_at <= now()
        ORDER BY request.expires_at, request.id
        LIMIT 500
        FOR UPDATE SKIP LOCKED
      ), artifacts AS (
        INSERT INTO evidence_artifacts (
          id, school_id, device_id, student_id, student_session_id, binding_version,
          case_id, source_type, source_id, artifact_type, status, label,
          content_type, content, metadata, captured_at
        )
        SELECT
          gen_random_uuid(),
          due.school_id,
          due.device_id,
          due.student_id,
          due.student_session_id,
          'v1:' || encode(sha256(
            convert_to(due.school_id, 'UTF8') || decode('00', 'hex')
              || convert_to(due.device_id, 'UTF8') || decode('00', 'hex')
              || convert_to(due.student_id, 'UTF8') || decode('00', 'hex')
              || convert_to(due.student_session_id, 'UTF8')
          ), 'hex'),
          due.case_id,
          'classpilot_safety_capture',
          due.id,
          'screenshot',
          'unavailable',
          'Safety screenshot unavailable',
          NULL,
          NULL,
          jsonb_build_object(
            'captureRequestId', due.id,
            'unavailableReason', 'expired'
          ),
          now()
        FROM due
        RETURNING id, source_id
      )
      UPDATE classpilot_evidence_capture_requests AS request
      SET status = 'expired', artifact_id = artifacts.id, completed_at = now()
      FROM artifacts
      WHERE request.id = artifacts.source_id
      RETURNING request.id
    `);
    if ((result.rowCount || 0) > 0) {
      console.log(JSON.stringify({
        event: "classpilot_evidence_capture_expiry",
        expiredCount: result.rowCount,
      }));
    }
  } catch (error) {
    // Mixed deploys may run a worker before the additive table exists. The
    // capability remains dark and the next minute retries after migration.
    const databaseError = error as { code?: string };
    if (databaseError.code === "42P01") return;
    errorMonitor.trackError(
      "scheduler_failure",
      error as Error,
      { job: "expireClasspilotEvidenceCaptureRequests" }
    );
  }
}

export async function expireClasspilotManualStudentSessions() {
  try {
    const result = await reapExpiredManualStudentSessions();
    if (result.publicationFailures > 0) {
      errorMonitor.trackError(
        "scheduler_failure",
        Object.assign(new Error("Manual student-session tombstone publication failed"), {
          code: "CLASSPILOT_MANUAL_SESSION_PUBLICATION_FAILED",
        }),
        {
          job: "expireClasspilotManualStudentSessions",
          errorCode: "CLASSPILOT_MANUAL_SESSION_PUBLICATION_FAILED",
        }
      );
    }
    if (result.ended > 0 || result.publicationFailures > 0 || result.backlog) {
      console.log(JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{
            Namespace: "SchoolPilot/ClassPilot",
            Dimensions: [["Environment"]],
            Metrics: [
              { Name: "ManualStudentSessionsExpired", Unit: "Count" },
              { Name: "ManualStudentSessionPublicationFailures", Unit: "Count" },
              { Name: "ManualStudentSessionExpiryBacklog", Unit: "Count" },
            ],
          }],
        },
        Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
        ManualStudentSessionsExpired: result.ended,
        ManualStudentSessionPublicationFailures: result.publicationFailures,
        ManualStudentSessionExpiryBacklog: result.backlog ? 1 : 0,
      }));
    }
  } catch (error) {
    errorMonitor.trackError(
      "scheduler_failure",
      error as Error,
      { job: "expireClasspilotManualStudentSessions" }
    );
  }
}

// Import-run history retention — keep 90 days (longer than error_logs since
// these are infrequent admin actions and useful for support look-back).
async function purgeOldImportRuns() {
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const result = await schedulerPool.query(
      `DELETE FROM import_runs WHERE created_at < $1`,
      [cutoff]
    );
    if ((result.rowCount || 0) > 0) {
      console.log(`[ImportRuns] Purged ${result.rowCount} import runs older than 90 days`);
    }
  } catch (err) {
    console.error("[ImportRuns] Retention purge failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeOldImportRuns" });
  }
}

async function renewMailpilotWatches() {
  if (!isMailpilotConfigured()) return;
  try {
    // Use schedulerDb (dedicated pool, max 3) — never the main API pool
    const allDueForRenewal = await getWatchesDueForRenewal(24 * 60 * 60 * 1000, schedulerDb);
    if (allDueForRenewal.length === 0) return;
    const schoolIds = Array.from(new Set(allDueForRenewal.map((w) => w.schoolId)));
    const entitledSchools = await schedulerDb
      .select({ id: schools.id })
      .from(schools)
      .where(
        and(
          inArray(schools.id, schoolIds),
          eq(schools.mailpilotEntitled, true),
          eq(schools.classpilotEmailMonitoring, true)
        )
      );
    const entitledSchoolIds = new Set(entitledSchools.map((school) => school.id));
    const studentIds = Array.from(new Set(allDueForRenewal.map((watch) => watch.studentId)));
    const activeStudents = await schedulerDb
      .select({ id: students.id, schoolId: students.schoolId, emailLc: students.emailLc })
      .from(students)
      .where(and(inArray(students.id, studentIds), eq(students.status, "active")));
    const activeStudentKeys = new Set(
      activeStudents.map((student) => `${student.schoolId}:${student.id}:${student.emailLc || ""}`)
    );
    const dueForRenewal = allDueForRenewal.filter(
      (watch) =>
        entitledSchoolIds.has(watch.schoolId) &&
        activeStudentKeys.has(`${watch.schoolId}:${watch.studentId}:${watch.studentEmail.toLowerCase()}`)
    );
    if (dueForRenewal.length === 0) return;

    console.log(`[MailPilot] Renewing ${dueForRenewal.length} Gmail watch(es)`);
    let renewed = 0;
    let failed = 0;
    const concurrency = Math.max(1, parseInt(process.env.MAILPILOT_RENEWAL_CONCURRENCY || "10", 10));
    const queue = [...dueForRenewal];
    async function worker() {
      while (queue.length > 0) {
        const w = queue.shift();
        if (!w) continue;
        try {
          const result = await startWatch(w.studentEmail);
          await upsertMailpilotWatch({
            schoolId: w.schoolId,
            studentId: w.studentId,
            studentEmail: w.studentEmail,
            historyId: result.historyId,
            expiresAt: result.expiration,
            status: "active",
          }, schedulerDb);
          renewed++;
        } catch (err) {
          failed++;
          await updateMailpilotWatchError(w.id, (err as Error).message, "error", schedulerDb);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    console.log(`[MailPilot] Watch renewal: ${renewed} renewed, ${failed} failed`);
  } catch (err) {
    console.error("[MailPilot] Watch renewal failed");
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "renewMailpilotWatches" });
  }
}
