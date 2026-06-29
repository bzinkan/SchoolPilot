import type { Server as SocketServer } from "socket.io";
import errorMonitor from "./errorMonitor.js";
import {
  getSchoolById,
  getOrCreateSession,
  updateSessionStatus,
  getSettingsForSchool,
  getScheduledGroupsReadyToStart,
  getScheduledGroupsReadyToEnd,
  hasActiveSessionForGroup,
  endTeachingSession,
  getUserById,
  clearClasspilotActiveHandsForSession,
} from "./storage.js";
import { processScheduledClassAutoStart } from "./classpilotScheduledStart.js";
import { buildAndSendSessionSummary } from "../routes/classpilot/sessions.js";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { publishSocketIoRedis } from "../realtime/socketio-redis.js";
import { runSecurityChecks } from "./securityMonitor.js";
import { schedulerDb, schedulerLockPool, schedulerPool } from "./schedulerDb.js";
import { schools, productLicenses } from "../schema/core.js";
import { heartbeats, dailyUsage, teachingSessions, groups } from "../schema/classpilot.js";
import { dismissalQueue, dismissalSessions, parentStudent } from "../schema/gopilot.js";
import { passes } from "../schema/passpilot.js";
import { students } from "../schema/students.js";
import { users } from "../schema/core.js";
import { settings as schoolSettings } from "../schema/shared.js";
import { emailAlerts } from "../schema/mailpilot.js";
import { eq, and, desc, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  getWatchesDueForRenewal,
  upsertMailpilotWatch,
  updateMailpilotWatchError,
} from "./storage.js";
import { startWatch, isMailpilotConfigured } from "./mailpilotGmail.js";
import { sendEmail } from "./email.js";
import { coerceSchedulerTimestamp } from "../util/schedulerTimestamp.js";

let io: SocketServer | null = null;
let intervalId: NodeJS.Timeout | null = null;
let lastRollupHour = -1;
let lastPurgeHour = -1;
let heavyJobRunning = false; // Mutex: prevent rollup and purge from running concurrently

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
        .catch((err) => console.warn(`[Scheduler] Failed to unlock ${jobName}:`, err));
    }
    client.release();
  }
}

function scheduleLockedJob(jobName: string, fn: () => Promise<void>) {
  void runWithSchedulerLock(jobName, fn).catch((err) => {
    console.error(`[Scheduler] ${jobName} failed outside handler:`, err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: jobName });
  });
}

async function publishGoPilotEvent(room: string, event: string, data: unknown) {
  io?.to(room).emit(event, data);
  await publishSocketIoRedis({ room, event, data });
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
      await sendParentTransparencyDigests();
    }
    // Purge at 30min past the hour (staggered to avoid overlap with rollup)
    const currentMinute = new Date().getUTCMinutes();
    if (currentMinute >= 30 && currentHour !== lastPurgeHour) {
      lastPurgeHour = currentHour;
      await purgeExpiredHeartbeats();
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
  io = socketIo;
  console.log("Dismissal scheduler started (checking every 60s)");
  intervalId = setInterval(() => {
    tickCount++;
    scheduleLockedJob("checkDismissalTimes", checkDismissalTimes);
    scheduleLockedJob("autoCompleteStaleGoPilotSessions", autoCompleteStaleGoPilotSessions);
    scheduleLockedJob("autoEndStaleClassPilotSessions", autoEndStaleClassPilotSessions);
    scheduleLockedJob("autoStartClassBlocks", autoStartClassBlocks);
    scheduleLockedJob("autoEndClassBlocks", autoEndClassBlocks);
    // Security monitor: run every 5 minutes (every 5th tick) — rule-based breach detection
    if (tickCount % 5 === 0) {
      scheduleLockedJob("runSecurityChecks", async () => {
        await runSecurityChecks();
      });
    }
    // Fire and forget — runs through the mutex and dedicated pool
    scheduleLockedJob("runHeavyJobsSerially", runHeavyJobsSerially);
  }, 60 * 1000);
  scheduleLockedJob("checkDismissalTimes", checkDismissalTimes);
  scheduleLockedJob("autoCompleteStaleGoPilotSessions", autoCompleteStaleGoPilotSessions);
  scheduleLockedJob("autoStartClassBlocks", autoStartClassBlocks);
  scheduleLockedJob("autoEndClassBlocks", autoEndClassBlocks);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function checkDismissalTimes() {
  try {

    // Find schools where current time >= dismissal_time (catches exact match + late starts after deploys)
    const result = await schedulerDb
      .select({
        id: schools.id,
        name: schools.name,
        dismissalTime: schools.dismissalTime,
        schoolTimezone: schools.schoolTimezone,
      })
      .from(schools)
      .where(
        and(
          eq(schools.status, "active"),
          isNotNull(schools.dismissalTime),
          sql`TO_CHAR(NOW() AT TIME ZONE COALESCE(${schools.schoolTimezone}, 'America/New_York'), 'HH24:MI') >= ${schools.dismissalTime}`
        )
      );

    // Filter out schools with auto-dismissal disabled
    const eligible = [];
    for (const school of result) {
      const fullSchool = await getSchoolById(school.id, schedulerDb);
      const schoolSettings = fullSchool?.settings ? JSON.parse(fullSchool.settings) : {};
      if (schoolSettings.autoDismissalEnabled === false) continue;
      eligible.push(school);
    }

    if (eligible.length > 0) {
      console.log(`[Scheduler] Found ${eligible.length} school(s) ready for dismissal:`, eligible.map(s => `${s.name} (${s.dismissalTime} ${s.schoolTimezone})`));
    }
    for (const school of eligible) {
      await autoStartDismissal(school.id, school.name);
    }
  } catch (err) {
    console.error("Scheduler error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "checkDismissalTimes" });
  }
}

async function autoStartDismissal(schoolId: string, schoolName: string) {
  try {
    const school = await getSchoolById(schoolId, schedulerDb);
    const timezone = school?.schoolTimezone || "America/New_York";

    // Get today's date in school timezone
    const now = new Date();
    const localDate = now.toLocaleDateString("en-CA", { timeZone: timezone });

    const session = await getOrCreateSession(schoolId, localDate, schedulerDb);

    if (session.status === "pending") {
      await updateSessionStatus(session.id, "active", schedulerDb);
      console.log(`Auto-started dismissal for ${schoolName} (session ${session.id})`);
      const payload = { sessionId: session.id };
      await Promise.all([
        publishGoPilotEvent(`school:${schoolId}`, "dismissal:status", { ...payload, status: "active" }),
        publishGoPilotEvent(`school:${schoolId}`, "dismissal:started", payload),
        publishGoPilotEvent(`school:${schoolId}:office`, "dismissal:started", payload),
        publishGoPilotEvent(`school:${schoolId}:parents`, "dismissal:started", payload),
      ]);
    }
  } catch (err) {
    console.error(`Failed to auto-start dismissal for school ${schoolId}:`, err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoStartDismissal", schoolId });
  }
}

async function autoCompleteStaleGoPilotSessions() {
  try {
    // Find active sessions whose date is before today (stale from previous days)
    const staleSessions = await schedulerDb
      .select({
        id: dismissalSessions.id,
        schoolId: dismissalSessions.schoolId,
        date: dismissalSessions.date,
      })
      .from(dismissalSessions)
      .innerJoin(schools, eq(dismissalSessions.schoolId, schools.id))
      .where(
        and(
          eq(dismissalSessions.status, "active"),
          sql`${dismissalSessions.date} < (NOW() AT TIME ZONE COALESCE(${schools.schoolTimezone}, 'America/New_York'))::date`
        )
      );

    for (const session of staleSessions) {
      await updateSessionStatus(session.id, "completed", schedulerDb);
      console.log(`[GoPilot] Auto-completed stale session for school ${session.schoolId} (date: ${session.date})`);
    }
  } catch (err) {
    console.error("[GoPilot] Failed to auto-complete stale sessions:", err);
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

async function autoEndStaleClassPilotSessions() {
  try {
    // Find all open teaching sessions across all schools
    const openSessions = await schedulerDb
      .select({
        sessionId: teachingSessions.id,
        teacherId: teachingSessions.teacherId,
        groupId: teachingSessions.groupId,
        startTime: teachingSessions.startTime,
        schoolId: schools.id,
        schoolTimezone: schools.schoolTimezone,
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
        // After school hours check
        try {
          const settings = await getSettingsForSchool(s.schoolId, schedulerDb);
          if (settings?.enableTrackingHours && settings.trackingEndTime) {
            const tz = s.schoolTimezone || "America/New_York";
            const localTimeStr = now.toLocaleString("en-US", {
              timeZone: tz,
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).replace(/^24:/, "00:");
            if (localTimeStr >= settings.trackingEndTime) {
              shouldEnd = true;
              reason = "school hours ended";
            }
          }
        } catch { /* settings lookup failed, skip after-hours check */ }
      }

      if (shouldEnd) {
        const session = await endTeachingSession(s.sessionId, schedulerDb);
        await clearClasspilotActiveHandsForSession(s.schoolId, s.sessionId, schedulerDb);
        console.log(`[ClassPilot] Auto-ended stale session ${s.sessionId} for teacher ${s.teacherId} (${reason}, age: ${ageHours.toFixed(1)}h)`);

        // Send session summary email (same as manual/scheduled end)
        if (session?.startTime && session?.endTime) {
          const teacher = await getUserById(s.teacherId);
          if (teacher) {
            buildAndSendSessionSummary(session, {
              email: teacher.email,
              firstName: (teacher as any).firstName,
              lastName: (teacher as any).lastName,
            }, schedulerDb).catch((err) =>
              console.error("[ClassPilot] Stale session summary email failed:", err)
            );
          }
        }

        // Notify teacher dashboard
        const update = {
          type: "session-ended",
          sessionId: s.sessionId,
          reason: "auto-ended",
        };
        broadcastToTeachersLocal(s.schoolId, update);
        void publishWS({ kind: "staff", schoolId: s.schoolId }, update);
      }
    }
  } catch (err) {
    console.error("[ClassPilot] Auto-end stale sessions error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoEndStaleClassPilotSessions" });
  }
}

// ============================================================================
// ClassPilot - Daily usage rollup
// ============================================================================

async function rollupDailyUsage() {
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
      .where(eq(schools.status, "active"));

    for (const school of activeSchools) {
      await rollupSchoolUsage(school.id, school.schoolTimezone || "America/New_York");
      // Small yield between schools so other scheduler ticks can run
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (err) {
    console.error("[ClassPilot] Daily usage rollup error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "rollupDailyUsage" });
  }
}

async function rollupSchoolUsage(schoolId: string, timezone: string) {
  try {
    // Compute yesterday's date in the school's timezone
    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: timezone });
    const yesterday = new Date(todayStr);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    // Compute UTC boundaries for "yesterday" in the school's timezone
    // yesterdayStr at 00:00 in the school's timezone → UTC
    // todayStr at 00:00 in the school's timezone → UTC
    const dayStartUtc = new Date(
      new Date().toLocaleString("en-US", { timeZone: timezone }).replace(/.*/, `${yesterdayStr}T00:00:00`)
    );
    const dayEndUtc = new Date(
      new Date().toLocaleString("en-US", { timeZone: timezone }).replace(/.*/, `${todayStr}T00:00:00`)
    );

    // Aggregate heartbeats per student for yesterday (use SQL timezone conversion for accuracy)
    // All scheduler queries go through schedulerDb (dedicated pool, isolated from API requests)
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
          sql`(${heartbeats.timestamp} AT TIME ZONE ${timezone})::date = ${yesterdayStr}::date`
        )
      )
      .groupBy(heartbeats.studentId);

    if (studentTotals.length === 0) return;

    // Get top domains per student
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
          sql`(${heartbeats.timestamp} AT TIME ZONE ${timezone})::date = ${yesterdayStr}::date`,
          sql`${heartbeats.activeTabUrl} IS NOT NULL`
        )
      )
      .groupBy(heartbeats.studentId, sql`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)')`)
      .orderBy(sql`COUNT(*) DESC`);

    // Group domains by student and take top 5
    const studentDomains = new Map<string, { domain: string; seconds: number; visits: number }[]>();
    for (const row of domainData) {
      if (!row.studentId || !row.domain) continue;
      const list = studentDomains.get(row.studentId) || [];
      if (list.length < 5) {
        list.push({ domain: row.domain, seconds: row.seconds, visits: row.visits });
      }
      studentDomains.set(row.studentId, list);
    }

    // Upsert daily usage for each student (through scheduler pool)
    for (const row of studentTotals) {
      if (!row.studentId) continue;
      const firstSeen = coerceSchedulerTimestamp(row.firstSeen);
      const lastSeen = coerceSchedulerTimestamp(row.lastSeen);
      await schedulerDb
        .insert(dailyUsage)
        .values({
          schoolId,
          studentId: row.studentId,
          date: yesterdayStr,
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
    }

    console.log(`[ClassPilot] Rolled up daily usage for school ${schoolId}: ${studentTotals.length} students (${yesterdayStr})`);
  } catch (err) {
    console.error(`[ClassPilot] Rollup failed for school ${schoolId}:`, err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "rollupSchoolUsage", schoolId });
  }
}

// ============================================================================
// ClassPilot - Parent transparency digest
// Opt-in weekly digest using approved GoPilot parent-child links only.
// ============================================================================

function localDateParts(timeZone: string) {
  const now = new Date();
  return {
    date: now.toLocaleDateString("en-CA", { timeZone }),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now),
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]!));
}

function digestHtml(options: {
  schoolName: string;
  studentName: string;
  periodStart: string;
  periodEnd: string;
  totalSeconds: number;
  topDomains: Array<{ domain: string; seconds: number }>;
  passCount: number;
  dismissalCount: number;
  safetyNotes: Array<{ safetyAlert: string | null; severity: string; reviewNote: string | null }>;
}) {
  const hours = Math.round((options.totalSeconds / 3600) * 10) / 10;
  const domains = options.topDomains.length
    ? options.topDomains.map((d) => `<li>${escapeHtml(d.domain)} (${Math.round(d.seconds / 60)} min)</li>`).join("")
    : "<li>No ClassPilot browsing rollup available for this period.</li>";
  const safety = options.safetyNotes.length
    ? options.safetyNotes.map((n) => `<li>${escapeHtml(n.safetyAlert || "reviewed concern")} (${escapeHtml(n.severity)})${n.reviewNote ? `: ${escapeHtml(n.reviewNote)}` : ""}</li>`).join("")
    : "<li>No staff-approved safety notes for this period.</li>";

  return `
    <h2>${escapeHtml(options.schoolName)} weekly student digest</h2>
    <p><strong>Student:</strong> ${escapeHtml(options.studentName)}</p>
    <p><strong>Period:</strong> ${escapeHtml(options.periodStart)} to ${escapeHtml(options.periodEnd)}</p>
    <h3>Learning activity</h3>
    <p>ClassPilot recorded about ${hours} hour(s) of Chromebook learning activity.</p>
    <ul>${domains}</ul>
    <h3>School day context</h3>
    <p>Hall passes issued: ${options.passCount}</p>
    <p>Dismissal events: ${options.dismissalCount}</p>
    <h3>Staff-approved safety notes</h3>
    <ul>${safety}</ul>
    <p>No screenshots, raw browsing timelines, or raw email content are included in this digest.</p>
  `;
}

async function sendParentTransparencyDigests() {
  try {
    const eligible = await schedulerDb
      .select({ settings: schoolSettings, school: schools })
      .from(schoolSettings)
      .innerJoin(schools, eq(schoolSettings.schoolId, schools.id))
      .innerJoin(
        productLicenses,
        and(
          eq(productLicenses.schoolId, schools.id),
          eq(productLicenses.product, "CLASSPILOT"),
          eq(productLicenses.status, "active")
        )
      )
      .where(and(eq(schoolSettings.parentTransparencyEnabled, true), eq(schools.status, "active")));

    for (const row of eligible) {
      const timeZone = row.school.schoolTimezone || row.settings.schoolTimezone || "America/New_York";
      const local = localDateParts(timeZone);
      if (local.weekday !== "Mon") continue;
      const lastSentDate = row.settings.parentDigestLastSentAt
        ? row.settings.parentDigestLastSentAt.toLocaleDateString("en-CA", { timeZone })
        : null;
      if (lastSentDate === local.date) continue;
      if (row.settings.parentDigestLastSentAt && Date.now() - row.settings.parentDigestLastSentAt.getTime() < 6 * 24 * 60 * 60 * 1000) {
        continue;
      }

      const end = new Date();
      const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
      const startDate = start.toISOString().slice(0, 10);
      const endDate = end.toISOString().slice(0, 10);

      const links = await schedulerDb
        .select({ link: parentStudent, parent: users, student: students })
        .from(parentStudent)
        .innerJoin(users, eq(parentStudent.parentId, users.id))
        .innerJoin(students, eq(parentStudent.studentId, students.id))
        .where(and(eq(students.schoolId, row.school.id), eq(parentStudent.status, "approved")));

      for (const item of links) {
        if (!item.parent.email) continue;
        const [usage, passRows, dismissalRows, safetyRows] = await Promise.all([
          schedulerDb
            .select()
            .from(dailyUsage)
            .where(and(eq(dailyUsage.schoolId, row.school.id), eq(dailyUsage.studentId, item.student.id), sql`${dailyUsage.date} >= ${startDate}`, sql`${dailyUsage.date} <= ${endDate}`)),
          row.settings.parentDigestIncludesPassDismissal !== false
            ? schedulerDb.select().from(passes).where(and(eq(passes.schoolId, row.school.id), eq(passes.studentId, item.student.id), gte(passes.issuedAt, start)))
            : Promise.resolve([]),
          row.settings.parentDigestIncludesPassDismissal !== false
            ? schedulerDb
                .select({ queue: dismissalQueue })
                .from(dismissalQueue)
                .innerJoin(dismissalSessions, eq(dismissalQueue.sessionId, dismissalSessions.id))
                .where(and(eq(dismissalSessions.schoolId, row.school.id), eq(dismissalQueue.studentId, item.student.id), sql`${dismissalSessions.date} >= ${startDate}`))
            : Promise.resolve([]),
          row.settings.parentDigestIncludesSafety
            ? schedulerDb
                .select()
                .from(emailAlerts)
                .where(and(eq(emailAlerts.schoolId, row.school.id), eq(emailAlerts.studentId, item.student.id), gte(emailAlerts.alertedAt, start), sql`${emailAlerts.reviewStatus} IN ('confirmed','escalated')`))
                .orderBy(desc(emailAlerts.alertedAt))
                .limit(10)
            : Promise.resolve([]),
        ]);

        const domainTotals = new Map<string, number>();
        for (const day of usage) {
          for (const domain of ((day.topDomains as any[]) || [])) {
            if (!domain?.domain) continue;
            domainTotals.set(domain.domain, (domainTotals.get(domain.domain) || 0) + (domain.seconds || 0));
          }
        }
        const topDomains = [...domainTotals.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([domain, seconds]) => ({ domain, seconds }));
        const studentName = `${item.student.firstName || ""} ${item.student.lastName || ""}`.trim() || item.student.email || "Student";

        await sendEmail({
          to: item.parent.email,
          subject: `${row.school.name} weekly digest for ${studentName}`,
          html: digestHtml({
            schoolName: row.school.name,
            studentName,
            periodStart: startDate,
            periodEnd: endDate,
            totalSeconds: usage.reduce((sum, day) => sum + day.totalSeconds, 0),
            topDomains,
            passCount: passRows.length,
            dismissalCount: dismissalRows.length,
            safetyNotes: safetyRows.map((alert) => ({
              safetyAlert: alert.safetyAlert,
              severity: alert.severity,
              reviewNote: alert.reviewNote,
            })),
          }),
        });
      }

      await schedulerDb
        .update(schoolSettings)
        .set({ parentDigestLastSentAt: new Date() })
        .where(eq(schoolSettings.schoolId, row.school.id));
      console.log(`[ClassPilot] Parent transparency digests sent for ${row.school.name}`);
    }
  } catch (err) {
    console.error("[ClassPilot] Parent transparency digest error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "sendParentTransparencyDigests" });
  }
}

// ============================================================================
// ClassPilot - Heartbeat purge (based on retentionHours setting)
// ============================================================================

async function purgeExpiredHeartbeats() {
  try {
    // Uses dedicated scheduler pool — cannot starve API requests
    const activeSchools = await schedulerDb
      .select({
        id: schools.id,
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
      .where(eq(schools.status, "active"));

    for (const school of activeSchools) {
      const schoolSettings = await getSettingsForSchool(school.id, schedulerDb);
      const retentionHours = parseInt(schoolSettings?.retentionHours as string || "720", 10);
      const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);

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
        console.log(`[ClassPilot] Purged ${totalDeleted} expired heartbeats for school ${school.id} (retention: ${retentionHours}h)`);
      }
      // Yield between schools
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch (err) {
    console.error("[ClassPilot] Heartbeat purge error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeExpiredHeartbeats" });
  }
}

// ============================================================================
// ClassPilot - Automatic class block scheduling
// ============================================================================

async function autoStartClassBlocks() {
  try {
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
      .where(eq(schools.status, "active"));

    for (const school of activeSchools) {
      const tz = school.schoolTimezone || "America/New_York";
      const now = new Date();

      // Skip weekends (Saturday, Sunday)
      const localDayStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
      if (localDayStr === "Sat" || localDayStr === "Sun") continue;

      const currentTimeHHMM = now.toLocaleString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).replace(/^24:/, "00:");
      const todayDate = now.toLocaleDateString("en-CA", { timeZone: tz });

      // Debug: log every scheduled group check to diagnose auto-start failures
      const allScheduledGroups = await schedulerDb
        .select({ id: groups.id, name: groups.name, blockStartTime: groups.blockStartTime, blockEndTime: groups.blockEndTime, scheduleSkippedDate: groups.scheduleSkippedDate })
        .from(groups)
        .where(and(eq(groups.schoolId, school.id), eq(groups.scheduleEnabled, true)));
      if (allScheduledGroups.length > 0) {
        console.log(`[ClassPilot] Schedule tick: school=${school.id.slice(0,8)}, time=${currentTimeHHMM} ${tz}, date=${todayDate}, groups=${JSON.stringify(allScheduledGroups.map(g => ({ name: g.name, start: g.blockStartTime, end: g.blockEndTime, skipped: g.scheduleSkippedDate })))}`);
      }

      const readyGroups = await getScheduledGroupsReadyToStart(school.id, currentTimeHHMM, todayDate, schedulerDb);
      if (readyGroups.length > 0) {
        console.log(`[ClassPilot] Auto-start: ${readyGroups.length} group(s) ready`);
      }

      for (const group of readyGroups) {
        // Check if session already exists for this group
        const alreadyActive = await hasActiveSessionForGroup(group.id, schedulerDb);
        if (alreadyActive) {
          console.log(`[ClassPilot] Skipping "${group.name}" — session already active`);
          continue;
        }

        const result = await processScheduledClassAutoStart({
          group,
          scheduledDate: todayDate,
          dbInstance: schedulerDb,
        });
        if (result.status === "started") {
          console.log(`[ClassPilot] Auto-started session for "${group.name}" (teacher ${group.teacherId}, school ${school.id})`);
        } else if (result.status === "coverage_needed") {
          console.log(`[ClassPilot] Scheduled coverage needed for "${group.name}" (request ${result.conflictId})`);
        } else if (result.status === "claimed") {
          console.log(`[ClassPilot] Scheduled coverage already claimed for "${group.name}" (request ${result.conflictId})`);
        } else {
          console.log(`[ClassPilot] Skipped scheduled start for "${group.name}" (${result.reason})`);
        }
      }
    }
  } catch (err) {
    console.error("[ClassPilot] Auto-start class blocks error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoStartClassBlocks" });
  }
}

async function autoEndClassBlocks() {
  try {
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
      .where(eq(schools.status, "active"));

    for (const school of activeSchools) {
      const tz = school.schoolTimezone || "America/New_York";
      const now = new Date();
      const currentTimeHHMM = now.toLocaleString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).replace(/^24:/, "00:");

      const readyGroups = await getScheduledGroupsReadyToEnd(school.id, currentTimeHHMM, schedulerDb);

      for (const group of readyGroups) {
        const session = await endTeachingSession(group.sessionId, schedulerDb);
        await clearClasspilotActiveHandsForSession(school.id, group.sessionId, schedulerDb);
        console.log(`[ClassPilot] Auto-ended session for "${group.name}" (teacher ${group.teacherId}, school ${school.id})`);

        // Send session summary email (same as manual end)
        if (session?.startTime && session?.endTime) {
          const teacher = await getUserById(group.teacherId);
          if (teacher) {
            buildAndSendSessionSummary(session, {
              email: teacher.email,
              firstName: (teacher as any).firstName,
              lastName: (teacher as any).lastName,
            }, schedulerDb).catch((err) =>
              console.error("[ClassPilot] Auto-end session summary email failed:", err)
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("[ClassPilot] Auto-end class blocks error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoEndClassBlocks" });
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
    console.error("[MailPilot] Retention purge error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeMailpilotRetention" });
  }
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
    console.error("[ErrorLogs] Retention purge error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "purgeOldErrorLogs" });
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
    console.error("[ImportRuns] Retention purge error:", err);
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
    const dueForRenewal = allDueForRenewal.filter((watch) => entitledSchoolIds.has(watch.schoolId));
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
    console.error("[MailPilot] renewMailpilotWatches error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "renewMailpilotWatches" });
  }
}
