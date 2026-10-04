import { sql, type SQL } from "drizzle-orm";

/** Same lock as the historical full-day rollup writer; no writer replacement. */
export const CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('classpilot_usage_rollup'), hashtext($1))";

export function classpilotUsageSchoolWriteLock(schoolId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext('classpilot_usage_rollup'), hashtext(${schoolId}))`;
}
