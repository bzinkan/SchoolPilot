import type { Server as SocketServer } from "socket.io";
import {
  getSchoolById,
  getOrCreateSession,
  updateSessionStatus,
  upsertDailyUsage,
  getSettingsForSchool,
  purgeOldHeartbeats,
} from "./storage.js";
import db from "../db.js";
import { schools, productLicenses } from "../schema/core.js";
import { heartbeats } from "../schema/classpilot.js";
import { dismissalSessions } from "../schema/gopilot.js";
import { eq, and, isNotNull, sql } from "drizzle-orm";

let io: SocketServer | null = null;
let intervalId: NodeJS.Timeout | null = null;
let lastRollupHour = -1;

export function startScheduler(socketIo: SocketServer) {
  io = socketIo;
  console.log("Dismissal scheduler started (checking every 60s)");
  intervalId = setInterval(() => {
    checkDismissalTimes();
    autoCompleteStaleGoPilotSessions();

    // Run rollup and purge once per hour (when the hour changes)
    const currentHour = new Date().getUTCHours();
    if (currentHour !== lastRollupHour) {
      lastRollupHour = currentHour;
      rollupDailyUsage();
      purgeExpiredHeartbeats();
    }
  }, 60 * 1000);
  checkDismissalTimes();
  autoCompleteStaleGoPilotSessions();
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function checkDismissalTimes() {
  try {
    // Find schools where dismissal_time matches current time in their timezone
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
          eq(schools.status, "active"),
          isNotNull(schools.dismissalTime),
          sql`TO_CHAR(NOW() AT TIME ZONE COALESCE(${schools.schoolTimezone}, 'America/New_York'), 'HH24:MI') = ${schools.dismissalTime}`
        )
      );

    for (const school of result) {
      await autoStartDismissal(school.id, school.name);
    }
  } catch (err) {
    console.error("Scheduler error:", err);
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
      io?.to(`school:${schoolId}:office`).emit("dismissal:started", {
        sessionId: session.id,
      });
    }
  } catch (err) {
    console.error(`Failed to auto-start dismissal for school ${schoolId}:`, err);
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
  }
}

// ============================================================================
// ClassPilot - Daily usage rollup
// ============================================================================

async function rollupDailyUsage() {
  try {
    // Find active schools with ClassPilot license
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
      .where(eq(schools.status, "active"));

    for (const school of activeSchools) {
      await rollupSchoolUsage(school.id, school.schoolTimezone || "America/New_York");
    }
  } catch (err) {
    console.error("[ClassPilot] Daily usage rollup error:", err);
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
    const studentTotals = await db
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
    const domainData = await db
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

    // Upsert daily usage for each student
    for (const row of studentTotals) {
      if (!row.studentId) continue;
      await upsertDailyUsage({
        schoolId,
        studentId: row.studentId,
        date: yesterdayStr,
        totalSeconds: row.totalSeconds,
        heartbeatCount: row.heartbeatCount,
        topDomains: studentDomains.get(row.studentId) || [],
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
      });
    }

    console.log(`[ClassPilot] Rolled up daily usage for school ${schoolId}: ${studentTotals.length} students (${yesterdayStr})`);
  } catch (err) {
    console.error(`[ClassPilot] Rollup failed for school ${schoolId}:`, err);
  }
}

// ============================================================================
// ClassPilot - Heartbeat purge (based on retentionHours setting)
// ============================================================================

async function purgeExpiredHeartbeats() {
  try {
    const activeSchools = await db
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

      const deleted = await purgeOldHeartbeats(school.id, cutoff);
      if (deleted > 0) {
        console.log(`[ClassPilot] Purged ${deleted} expired heartbeats for school ${school.id} (retention: ${retentionHours}h)`);
      }
    }
  } catch (err) {
    console.error("[ClassPilot] Heartbeat purge error:", err);
  }
}
