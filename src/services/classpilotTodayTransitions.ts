import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { classpilotTodayOccurrences, classpilotSessionStudents, groupStudents, groups } from "../schema/classpilot.js";
import { createOrReuseScheduledReportSession, getUserById, lockClasspilotStudentControlAuthorities,
  promoteScheduledReportSessionToLive, type FinalizeTeachingSessionResult } from "./storage.js";
import { finalizeClasspilotSession } from "./classpilotSessionLifecycle.js";
import { canonicalTodayOccurrenceId } from "./classpilotTodayOccurrences.js";

/** Caller holds the reviewed school/date/class locks and publishes only after its outer commit. */
export async function applyClasspilotTodayTransitions(options: {
  schoolId: string; occurrenceIds: string[]; outgoingSessionIds: string[]; liveTeacherIds: string[];
  cutoverAt: Date; dbInstance: typeof db;
}): Promise<{ finalizations: FinalizeTeachingSessionResult[]; startedSessionIds: string[] }> {
  const database = options.dbInstance;
  const rows = options.occurrenceIds.length ? await database.select().from(classpilotTodayOccurrences).where(and(
    eq(classpilotTodayOccurrences.schoolId, options.schoolId), inArray(classpilotTodayOccurrences.id, options.occurrenceIds))) : [];
  if (rows.length !== new Set(options.occurrenceIds).size) throw new Error("TODAY_SCHEDULE_OCCURRENCE_MISSING");
  const groupIds = [...new Set(rows.map(row => row.groupId))];
  const [incomingStudents, outgoingStudents] = await Promise.all([
    groupIds.length ? database.select({ studentId: groupStudents.studentId }).from(groupStudents)
      .innerJoin(groups, and(eq(groups.id, groupStudents.groupId), eq(groups.schoolId, options.schoolId)))
      .where(inArray(groupStudents.groupId, groupIds)) : [],
    options.outgoingSessionIds.length ? database.select({ studentId: classpilotSessionStudents.studentId }).from(classpilotSessionStudents)
      .where(and(eq(classpilotSessionStudents.schoolId, options.schoolId),
        inArray(classpilotSessionStudents.teachingSessionId, options.outgoingSessionIds))) : [],
  ]);
  await lockClasspilotStudentControlAuthorities(options.schoolId,
    [...new Set([...incomingStudents, ...outgoingStudents].map(row => row.studentId))].sort(), database);
  const finalizations: FinalizeTeachingSessionResult[] = [];
  for (const sessionId of [...new Set(options.outgoingSessionIds)].sort()) {
    const result = await finalizeClasspilotSession({ schoolId: options.schoolId, sessionId,
      reason: "replacement_start", finalizedAt: options.cutoverAt, dbInstance: database, deferSideEffects: true });
    if (result) finalizations.push(result);
  }
  const startedSessionIds: string[] = [];
  for (const row of rows) {
    // Carried meetings keep their original session and control/Flight Path decisions.
    if (row.source.preservedOccurrenceId || row.source.preservedLegacySessionId) continue;
    if (row.kind !== "meeting" || !row.scheduledStartAt || !row.scheduledEndAt
      || row.scheduledStartAt > options.cutoverAt || row.scheduledEndAt <= options.cutoverAt) continue;
    const teacher = await getUserById(row.primaryTeacherIdSnapshot, database);
    const session = await createOrReuseScheduledReportSession({ schoolId: options.schoolId, groupId: row.groupId,
      teacherId: row.primaryTeacherIdSnapshot, scheduledOccurrenceId: canonicalTodayOccurrenceId(row), scheduledDate: row.scheduledDate,
      scheduledTimezone: row.timezoneSnapshot, scheduledStartAt: row.scheduledStartAt, scheduledEndAt: row.scheduledEndAt,
      scheduledTeacherEmail: teacher?.email, scheduledTeacherName: teacher?.displayName || teacher?.email }, database);
    if (options.liveTeacherIds.includes(row.primaryTeacherIdSnapshot)) {
      if (session.sessionMode === "live" && !session.endTime) continue;
      if (session.endTime && row.source.preservedOccurrenceId) continue;
      const live = await promoteScheduledReportSessionToLive({ schoolId: options.schoolId, sessionId: session.id }, database);
      if (!live) throw Object.assign(new Error("The replacement class could not start. Review today's schedule again."), {
        status: 409, code: "TODAY_SCHEDULE_START_FAILED",
      });
      startedSessionIds.push(live.id);
    }
  }
  return { finalizations, startedSessionIds };
}
