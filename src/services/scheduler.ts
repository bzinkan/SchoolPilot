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
import db from "../db.js";
import { schedulerDb } from "./schedulerDb.js";
import { schools, productLicenses } from "../schema/core.js";
import { heartbeats, dailyUsage } from "../schema/classpilot.js";
import { dismissalSessions } from "../schema/gopilot.js";
import { eq, and, isNotNull, sql } from "drizzle-orm";

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

export function startScheduler(socketIo: SocketServer) {
  io = socketIo;
  console.log("Dismissal scheduler started (checking every 60s)");
  intervalId = setInterval(() => {
    checkDismissalTimes();
    autoCompleteStaleGoPilotSessions();
    autoStartClassBlocks();
    autoEndClassBlocks();
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

      const result = await schedulerDb
        .delete(heartbeats)
        .where(
          and(
            eq(heartbeats.schoolId, school.id),
            sql`${heartbeats.timestamp} < ${cutoff}`
          )
        )
        .returning({ id: heartbeats.id });
      const deleted = result.length;
      if (deleted > 0) {
        console.log(`[ClassPilot] Purged ${deleted} expired heartbeats for school ${school.id} (retention: ${retentionHours}h)`);
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

      const readyGroups = await getScheduledGroupsReadyToStart(school.id, currentTimeHHMM, todayDate);

      for (const group of readyGroups) {
        // Check if session already exists for this group
        const alreadyActive = await hasActiveSessionForGroup(group.id);
        if (alreadyActive) continue;

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
