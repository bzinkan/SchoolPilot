import { and, eq, isNull, sql } from "drizzle-orm";

import db from "../db.js";
import { schools } from "../schema/core.js";

export type StaffAssignmentLifecycleLockDb = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

/**
 * Canonical lock order for staff-owned live data:
 *
 *   school row -> staff-assignment advisory lock -> product-specific locks/rows
 *
 * Every writer that can create or move a live staff dependency must take this
 * lock before rechecking membership eligibility. The guided transition takes
 * the same lock before its impact snapshot, so a dependency cannot appear in
 * the gap between review and deactivation.
 */
export async function lockStaffAssignmentLifecycleSchool(
  dbInstance: StaffAssignmentLifecycleLockDb,
  schoolId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<boolean> {
  const conditions = [eq(schools.id, schoolId)];
  if (!options.includeDeleted) conditions.push(isNull(schools.deletedAt));
  const [school] = await dbInstance
    .select({ id: schools.id })
    .from(schools)
    .where(and(...conditions))
    .limit(1)
    .for("update");
  if (!school) return false;
  await dbInstance.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-assignment-lifecycle:${schoolId}`}, 0::bigint))`
  );
  return true;
}
