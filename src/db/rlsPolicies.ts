import { createHash } from "node:crypto";
import rlsRegistry from "../config/rlsRegistry.json" with { type: "json" };

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

type RlsRegistryInventory = {
  count: number;
  sha256: string;
  tables: string[];
  addedSinceHistoricalObservation?: string[];
};

const historicalInventory: RlsRegistryInventory =
  rlsRegistry.inventories.historicalObservedProduction;
const postExpandInventory: RlsRegistryInventory =
  rlsRegistry.inventories.schoolPilot270PostExpand;

/** Exact audit snapshot; never rewrite this list to describe a future rollout. */
export const RLS_HISTORICAL_OBSERVED_PRODUCTION_TABLES: readonly string[] =
  Object.freeze([...historicalInventory.tables]);

/** Expected inventory once every SchoolPilot 2.7.0 additive table is admitted. */
export const RLS_POST_EXPAND_PRODUCTION_TABLES: readonly string[] =
  Object.freeze([...postExpandInventory.tables]);

export const RLS_REVIEWED_ENABLEMENT_REQUESTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(rlsRegistry.reviewedEnablementRequests).map(([name, tables]) => [
        name,
        Object.freeze([...tables]),
      ]),
    ),
  );

/** SQL boolean predicate shared by USING (reads) and WITH CHECK (writes). */
export const TENANT_PREDICATE =
  "(school_id = current_setting('app.school_id', true) " +
  "OR current_setting('app.is_super', true) = 'on')";

/**
 * Tables that must NEVER get RLS: auth/bootstrap and cross-school registries that
 * are read before a school context exists (login, membership lookup, super-admin
 * billing) or that intentionally span schools. RLS here would break the auth
 * bootstrap chicken-and-egg. `school_inquiries` is public, pre-tenant intake
 * written by an unauthenticated form and reviewed cross-tenant by super-admins.
 * The legacy `trial_requests` table is retained only as a migration source.
 */
export const RLS_GLOBAL_TABLES: ReadonlySet<string> = new Set(rlsRegistry.globalTables);

/**
 * A migration catalog assertion must use one complete reviewed request. This
 * prevents callers from bypassing a bundle by setting the environment variable
 * directly instead of using the deploy preflight.
 */
export function isReviewedRlsEnforcementRequest(tables: readonly string[]): boolean {
  const serialized = JSON.stringify(tables);
  return Object.values(RLS_REVIEWED_ENABLEMENT_REQUESTS).some(
    (request) => JSON.stringify(request) === serialized,
  );
}

/** Fail fast if the machine-readable registry loses its semantic invariants. */
export function assertRlsRegistryIntegrity(): void {
  const inventories = [historicalInventory, postExpandInventory];
  for (const inventory of inventories) {
    if (inventory.count !== inventory.tables.length) {
      throw new Error(
        `RLS registry count ${inventory.count} does not match ${inventory.tables.length} tables`,
      );
    }
    if (new Set(inventory.tables).size !== inventory.tables.length) {
      throw new Error("RLS registry inventory contains duplicate table names");
    }
    const digest = createHash("sha256").update(inventory.tables.join(",")).digest("hex");
    if (digest !== inventory.sha256) {
      throw new Error("RLS registry inventory checksum does not match its table sequence");
    }
    if (inventory.tables.some((table) => !isSafeIdentifier(table))) {
      throw new Error("RLS registry inventory contains an unsafe table name");
    }
  }

  const historical = new Set(historicalInventory.tables);
  const postExpand = new Set(postExpandInventory.tables);
  if ([...historical].some((table) => !postExpand.has(table))) {
    throw new Error("RLS post-expand inventory must retain every historical production table");
  }
  const actualAdditions = [...postExpand].filter((table) => !historical.has(table)).sort();
  const declaredAdditions = [...(postExpandInventory.addedSinceHistoricalObservation ?? [])].sort();
  if (JSON.stringify(actualAdditions) !== JSON.stringify(declaredAdditions)) {
    throw new Error("RLS post-expand inventory additions do not match the declared expansion");
  }

  for (const request of Object.values(RLS_REVIEWED_ENABLEMENT_REQUESTS)) {
    if (request.length === 0 || request.some((table) => !postExpand.has(table))) {
      throw new Error("RLS reviewed enablement request is empty or outside the post-expand inventory");
    }
  }

  const fabRequest = RLS_REVIEWED_ENABLEMENT_REQUESTS.classpilotFabReadmission ?? [];
  const fabException = rlsRegistry.semanticExceptions.classpilotFabReadmission
    .intentionallyExcludedTables;
  if (
    !fabException.includes("classpilot_active_hands") ||
    fabRequest.includes("classpilot_active_hands") ||
    !postExpand.has("classpilot_active_hands")
  ) {
    throw new Error("RLS ClassPilot FAB re-admission exception drifted");
  }
}

assertRlsRegistryIntegrity();

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

export function findUnknownRlsAllowlistEntries(
  allowlist: Iterable<string>,
  tenantTables: Iterable<string>,
): string[] {
  const tenantTableSet = new Set(tenantTables);
  return [...allowlist].filter((table) => !tenantTableSet.has(table)).sort();
}

export function findMissingRlsAllowlistEntries(
  allowlist: Iterable<string>,
  tenantTables: Iterable<string>,
): string[] {
  const allowlistSet = new Set(allowlist);
  return [...tenantTables].filter((table) => !allowlistSet.has(table)).sort();
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
