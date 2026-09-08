import { and, eq, inArray, sql } from "drizzle-orm";
import { classpilotCoverageGroupCategories } from "../schema/classpilot.js";
import type { StaffAssignmentLifecycleLockDb } from "./staffAssignmentLifecycleLock.js";

/** Caller holds the school lifecycle lock. Category review includes its usage set. */
export async function touchCoverageCategories(tx: StaffAssignmentLifecycleLockDb, schoolId: string, categoryIds: Array<string | null | undefined>) {
  const ids = [...new Set(categoryIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return;
  await tx.update(classpilotCoverageGroupCategories).set({
    updatedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), ${classpilotCoverageGroupCategories.updatedAt} + interval '1 millisecond')`,
  }).where(and(eq(classpilotCoverageGroupCategories.schoolId, schoolId), inArray(classpilotCoverageGroupCategories.id, ids)));
}
