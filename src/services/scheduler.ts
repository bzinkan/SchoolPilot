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
  getActiveTeachingSession,
  endTeachingSession,
  createTeachingSession,
  getUserById,
} from "./storage.js";
import { buildAndSendSessionSummary } from "../routes/classpilot/sessions.js";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { runSecurityChecks } from "./securityMonitor.js";
import db from "../db.js";
import { schedulerDb, schedulerPool } from "./schedulerDb.js";
import { schools, productLicenses } from "../schema/core.js";
import { heartbeats, dailyUsage, teachingSessions, groups } from "../schema/classpilot.js";
import { dismissalSessions } from "../schema/gopilot.js";
import { eq, and, isNotNull, isNull, sql } from "drizzle-orm";
import {
  getWatchesDueForRenewal,
  upsertMailpilotWatch,
  updateMailpilotWatchError,
} from "./storage.js";
import { startWatch, isMailpilotConfigured } from "./mailpilotGmail.js";

let io: SocketServer | null = null;
let intervalId: NodeJS.Timeout | null = null;
let lastRollupHour = -1;
let lastPurgeHour = -1;
let heavyJobRunning = false; // Mutex: prevent rollup and purge from running concurrently

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
    }
  } finally {
    heavyJobRunning = false;
  }
}

let tickCount = 0;

export function startScheduler(socketIo: SocketServer) {
  io = socketIo;
  console.log("Dismissal scheduler started (checking every 60s)");
  intervalId = setInterval(() => {
    tickCount++;
    checkDismissalTimes();
    autoCompleteStaleGoPilotSessions();
    autoEndStaleClassPilotSessions();
    autoStartClassBlocks();
    autoEndClassBlocks();
    // Security monitor: run every 5 minutes (every 5th tick) — rule-based breach detection
    if (tickCount % 5 === 0) {
      runSecurityChecks().catch((err) =>
        console.error("[Scheduler] Security monitor error:", err)
      );
    }
    // Fire and forget — runs through the mutex and dedicated pool
    runHeavyJobsSerially().catch((err) =>
      console.error("[Scheduler] Heavy job error:", err)
    );
  }, 60 * 1000);
  checkDismissalTimes();
  autoCompleteStaleGoPilotSessions();
  autoStartClassBlocks();
  autoEndClassBlocks();
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
    const result = await db
      .select({
        id: schools.id,
        name: schools.name,
        dismissalTime: schools.dismissalTime,
        schoolTimezone: schools.schoolTimezone,
      })
      .from(schools)
      .where(
        and(
          sql`${schools.status} IN ('active', 'trial')`,
          isNotNull(schools.dismissalTime),
          sql`TO_CHAR(NOW() AT TIME ZONE COALESCE(${schools.schoolTimezone}, 'America/New_York'), 'HH24:MI') >= ${schools.dismissalTime}`
        )
      );

    // Filter out schools with auto-dismissal disabled
    const eligible = [];
    for (const school of result) {
      const fullSchool = await getSchoolById(school.id);
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
    const school = await getSchoolById(schoolId);
    const timezone = school?.schoolTimezone || "America/New_York";

    // Get today's date in school timezone
    const now = new Date();
    const localDate = now.toLocaleDateString("en-CA", { timeZone: timezone });

    const session = await getOrCreateSession(schoolId, localDate);

    if (session.status === "pending") {
      await updateSessionStatus(session.id, "active");
      console.log(`Auto-started dismissal for ${schoolName} (session ${session.id})`);
      const payload = { sessionId: session.id };
      io?.to(`school:${schoolId}:office`).emit("dismissal:started", payload);
      io?.to(`school:${schoolId}:parents`).emit("dismissal:started", payload);
    }
  } catch (err) {
    console.error(`Failed to auto-start dismissal for school ${schoolId}:`, err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoStartDismissal", schoolId });
  }
}

async function autoCompleteStaleGoPilotSessions() {
  try {
    // Find active sessions whose date is before today (stale from previous days)
    const staleSessions = await db
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
      await updateSessionStatus(session.id, "completed");
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
    const openSessions = await db
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
          const settings = await getSettingsForSchool(s.schoolId);
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
        const session = await endTeachingSession(s.sessionId);
        console.log(`[ClassPilot] Auto-ended stale session ${s.sessionId} for teacher ${s.teacherId} (${reason}, age: ${ageHours.toFixed(1)}h)`);

        // Send session summary email (same as manual/scheduled end)
        if (session?.startTime && session?.endTime) {
          const teacher = await getUserById(s.teacherId);
          if (teacher) {
            buildAndSendSessionSummary(session, {
              email: teacher.email,
              firstName: (teacher as any).firstName,
              lastName: (teacher as any).lastName,
            }).catch((err) =>
              console.error("[ClassPilot] Stale session summary email failed:", err)
            );
          }
        }

        // Notify teacher dashboard
        broadcastToTeachersLocal(s.schoolId, {
          type: "session-ended",
          sessionId: s.sessionId,
          reason: "auto-ended",
        });
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
        firstSeen: sql<Date>`MIN(${heartbeats.timestamp})`,
        lastSeen: sql<Date>`MAX(${heartbeats.timestamp})`,
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
      await schedulerDb
        .insert(dailyUsage)
        .values({
          schoolId,
          studentId: row.studentId,
          date: yesterdayStr,
          totalSeconds: row.totalSeconds,
          heartbeatCount: row.heartbeatCount,
          topDomains: studentDomains.get(row.studentId) || [],
          firstSeen: row.firstSeen,
          lastSeen: row.lastSeen,
        })
        .onConflictDoUpdate({
          target: [dailyUsage.studentId, dailyUsage.date],
          set: {
            totalSeconds: row.totalSeconds,
            heartbeatCount: row.heartbeatCount,
            topDomains: studentDomains.get(row.studentId) || [],
            firstSeen: row.firstSeen,
            lastSeen: row.lastSeen,
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
      const schoolSettings = await getSettingsForSchool(school.id);
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
    const activeSchools = await db
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
      .where(sql`${schools.status} IN ('active', 'trial')`);

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
      const allScheduledGroups = await db
        .select({ id: groups.id, name: groups.name, blockStartTime: groups.blockStartTime, blockEndTime: groups.blockEndTime, scheduleSkippedDate: groups.scheduleSkippedDate })
        .from(groups)
        .where(and(eq(groups.schoolId, school.id), eq(groups.scheduleEnabled, true)));
      if (allScheduledGroups.length > 0) {
        console.log(`[ClassPilot] Schedule tick: school=${school.id.slice(0,8)}, time=${currentTimeHHMM} ${tz}, date=${todayDate}, groups=${JSON.stringify(allScheduledGroups.map(g => ({ name: g.name, start: g.blockStartTime, end: g.blockEndTime, skipped: g.scheduleSkippedDate })))}`);
      }

      const readyGroups = await getScheduledGroupsReadyToStart(school.id, currentTimeHHMM, todayDate);
      if (readyGroups.length > 0) {
        console.log(`[ClassPilot] Auto-start: ${readyGroups.length} group(s) ready`);
      }

      for (const group of readyGroups) {
        // Check if session already exists for this group
        const alreadyActive = await hasActiveSessionForGroup(group.id);
        if (alreadyActive) {
          console.log(`[ClassPilot] Skipping "${group.name}" — session already active`);
          continue;
        }

        // End any existing active session for this teacher
        const existingSession = await getActiveTeachingSession(group.teacherId);
        if (existingSession) {
          await endTeachingSession(existingSession.id);
          console.log(`[ClassPilot] Auto-ended previous session for teacher ${group.teacherId} before starting "${group.name}"`);
        }

        // Create new session
        await createTeachingSession({ groupId: group.id, teacherId: group.teacherId });
        console.log(`[ClassPilot] Auto-started session for "${group.name}" (teacher ${group.teacherId}, school ${school.id})`);
      }
    }
  } catch (err) {
    console.error("[ClassPilot] Auto-start class blocks error:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "autoStartClassBlocks" });
  }
}

async function autoEndClassBlocks() {
  try {
    const activeSchools = await db
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
      .where(sql`${schools.status} IN ('active', 'trial')`);

    for (const school of activeSchools) {
      const tz = school.schoolTimezone || "America/New_York";
      const now = new Date();
      const currentTimeHHMM = now.toLocaleString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).replace(/^24:/, "00:");

      const readyGroups = await getScheduledGroupsReadyToEnd(school.id, currentTimeHHMM);

      for (const group of readyGroups) {
        const session = await endTeachingSession(group.sessionId);
        console.log(`[ClassPilot] Auto-ended session for "${group.name}" (teacher ${group.teacherId}, school ${school.id})`);

        // Send session summary email (same as manual end)
        if (session?.startTime && session?.endTime) {
          const teacher = await getUserById(group.teacherId);
          if (teacher) {
            buildAndSendSessionSummary(session, {
              email: teacher.email,
              firstName: (teacher as any).firstName,
              lastName: (teacher as any).lastName,
            }).catch((err) =>
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

async function renewMailpilotWatches() {
  if (!isMailpilotConfigured()) return;
  try {
    // Renew anything expiring within 24 hours
    const dueForRenewal = await getWatchesDueForRenewal(24 * 60 * 60 * 1000);
    if (dueForRenewal.length === 0) return;

    console.log(`[MailPilot] Renewing ${dueForRenewal.length} Gmail watch(es)`);
    let renewed = 0;
    let failed = 0;
    const concurrency = 5;
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
          });
          renewed++;
        } catch (err) {
          failed++;
          await updateMailpilotWatchError(w.id, (err as Error).message);
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
