import type { Server as SocketServer } from "socket.io";
import {
  getSchoolById,
  getOrCreateSession,
  updateSessionStatus,
} from "./storage.js";
import db from "../db.js";
import { schools } from "../schema/core.js";
import { dismissalSessions } from "../schema/gopilot.js";
import { eq, and, isNotNull, sql } from "drizzle-orm";

let io: SocketServer | null = null;
let intervalId: NodeJS.Timeout | null = null;

export function startScheduler(socketIo: SocketServer) {
  io = socketIo;
  console.log("Dismissal scheduler started (checking every 60s)");
  intervalId = setInterval(checkDismissalTimes, 60 * 1000);
  checkDismissalTimes();
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
