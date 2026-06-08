// PostgreSQL Row-Level Security policy definitions for per-school tenant
// isolation. A single "tenant_isolation" policy per table restricts every row to
// the request's school (the `app.school_id` GUC bound by the tenant-context
// middleware), with an explicit super-admin / system bypass via `app.is_super`.
//
// Deny-by-default: when neither GUC is set, current_setting(..., true) returns
// NULL, so `school_id = NULL` evaluates to NULL (not true) and zero rows are
// visible. school_id columns are TEXT, so the comparison is text = text — no
// `::uuid` cast that would error on an empty GUC.

export const RLS_POLICY_NAME = "tenant_isolation";

/** SQL boolean predicate shared by USING (reads) and WITH CHECK (writes). */
export const TENANT_PREDICATE =
  "(school_id = current_setting('app.school_id', true) " +
  "OR current_setting('app.is_super', true) = 'on')";

/**
 * Tables that must NEVER get RLS: auth/bootstrap and cross-school registries that
 * are read before a school context exists (login, membership lookup, super-admin
 * billing) or that intentionally span schools. RLS here would break the auth
 * bootstrap chicken-and-egg. `trial_requests` is a public, pre-tenant sales
 * intake (nullable school_id, written by an unauthenticated flow and reviewed
 * cross-tenant by the super-admin) — deny-by-default would reject submissions.
 */
export const RLS_GLOBAL_TABLES: ReadonlySet<string> = new Set([
  "users",
  "session",
  "schools",
  "school_memberships",
  "product_licenses",
  "trial_requests",
]);

/** Parse the comma-separated RLS_ENABLED_TABLES allowlist into a Set. */
export function parseRlsEnabledTables(
  raw: string | undefined = process.env.RLS_ENABLED_TABLES,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

/** Conservative identifier guard for table names sourced from the catalog. */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(name);
}

/**
 * Idempotent statements that (re)create the tenant-isolation policy and turn on
 * FORCE ROW LEVEL SECURITY for a table. These do NOT enable RLS — a table stays
 * inert until `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` runs (gated by the
 * RLS_ENABLED_TABLES allowlist). Drop-then-create keeps it re-runnable since
 * Postgres has no CREATE POLICY IF NOT EXISTS. FORCE makes the (non-superuser)
 * table-owning app role subject to the policy too, so the app cannot bypass it.
 */
export function policySqlFor(table: string): string[] {
  if (!isSafeIdentifier(table)) {
    throw new Error(`unsafe RLS table identifier: ${table}`);
  }
  return [
    `DROP POLICY IF EXISTS ${RLS_POLICY_NAME} ON ${table}`,
    `CREATE POLICY ${RLS_POLICY_NAME} ON ${table} ` +
      `USING ${TENANT_PREDICATE} WITH CHECK ${TENANT_PREDICATE}`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
  ];
}
