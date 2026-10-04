import { sql, type SQL } from "drizzle-orm";

/** Shared by rollup computation and non-parent removal of its inputs/coverage. */
export const CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('classpilot_usage_rollup'), hashtext($1))";

export function classpilotUsageSchoolWriteLock(schoolId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext('classpilot_usage_rollup'), hashtext(${schoolId}))`;
}

type QueryClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  release(error?: Error | boolean): void;
};
type QueryPool = { connect(): Promise<QueryClient> };

/**
 * Retention owns one short transaction per existing batch. Acquire before any
 * raw-input or aggregate row lock, and release only after commit/rollback.
 * The scheduler's existing session scope and SQL limits remain unchanged.
 */
export async function withClasspilotUsageSchoolWrite<T>(
  pool: QueryPool,
  schoolId: string,
  operation: (client: QueryClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query(CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL, [schoolId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}
