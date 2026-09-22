import { and, eq, isNull, sql } from "drizzle-orm";
import type { db } from "../db.js";
import { classpilotTimers, classpilotLessonActivities, classpilotQuestions, classpilotPickerRounds, classpilotRoutineRuns } from "../schema/classpilotTools.js";

/** Called inside the existing parent-finalization transaction, regardless of rollout. */
export async function finalizeClassTools(database: typeof db, schoolId: string, authority: { teachingSessionId?: string; supervisionContextId?: string }, now: Date) {
  for (const table of [classpilotTimers, classpilotLessonActivities, classpilotQuestions, classpilotPickerRounds, classpilotRoutineRuns]) {
    await database.update(table).set({ endedAt: now, updatedAt: now, revision: sql`${table.revision}+1` }).where(and(eq(table.schoolId, schoolId),
      authority.teachingSessionId ? eq(table.teachingSessionId, authority.teachingSessionId) : eq(table.supervisionContextId, authority.supervisionContextId!), isNull(table.endedAt)));
  }
}
