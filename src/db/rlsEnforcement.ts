import type { PoolClient } from "pg";
import {
  isReviewedRlsEnforcementRequest,
  parseRlsEnabledTables,
} from "./rlsPolicies.js";

type QueryConnection = Pick<PoolClient, "query">;

export type RlsCatalogEntry = {
  tableName: string;
  enabled: boolean;
  forced: boolean;
  policies: Array<{
    name: string;
    command: string;
    permissive: boolean;
    publicRole: boolean;
    usingExpression: string | null;
    checkExpression: string | null;
  }>;
};

// pg_get_expr's canonical representation of the TEXT school_id predicate in
// policySqlFor. Keep parentheses: removing them could accept a different
// Boolean expression. An unfamiliar deparser representation fails closed.
const CATALOG_TENANT_PREDICATE =
  "((school_id = current_setting('app.school_id'::text, true)) OR " +
  "(current_setting('app.is_super'::text, true) = 'on'::text))";

export async function readRlsCatalog(
  connection: QueryConnection,
  tables: readonly string[],
): Promise<RlsCatalogEntry[]> {
  const result = await connection.query<RlsCatalogEntry>(`
    SELECT relation.relname AS "tableName",
      relation.relrowsecurity AS enabled,
      relation.relforcerowsecurity AS forced,
      COALESCE((
        SELECT json_agg(json_build_object(
          'name', policy.polname,
          'command', policy.polcmd,
          'permissive', policy.polpermissive,
          'publicRole', policy.polroles = ARRAY[0::oid],
          'usingExpression', pg_get_expr(policy.polqual, policy.polrelid),
          'checkExpression', pg_get_expr(policy.polwithcheck, policy.polrelid)
        ) ORDER BY policy.polname)
        FROM pg_policy policy WHERE policy.polrelid = relation.oid
      ), '[]'::json) AS policies
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
      AND relation.relname = ANY($1::text[])
    ORDER BY relation.relname
  `, [tables]);
  return result.rows;
}

export function hasCanonicalTenantPolicy(entry: RlsCatalogEntry): boolean {
  const policy = entry.policies[0];
  return entry.enabled && entry.forced && entry.policies.length === 1 &&
    policy?.name === "tenant_isolation" && policy.command === "*" &&
    policy.permissive === true && policy.publicRole === true &&
    policy.usingExpression === CATALOG_TENANT_PREDICATE &&
    policy.checkExpression === CATALOG_TENANT_PREDICATE;
}

export async function readRlsDatabaseRole(connection: QueryConnection): Promise<{
  name: string;
  superuser: boolean;
  bypassRls: boolean;
}> {
  const result = await connection.query<{
    name: string; superuser: boolean; bypassRls: boolean;
  }>(`SELECT rolname AS name, rolsuper AS superuser, rolbypassrls AS "bypassRls"
      FROM pg_roles WHERE rolname = current_user`);
  const role = result.rows[0];
  if (!role) throw new Error("Required RLS enforcement failed: database role unavailable");
  return role;
}

/** Read-only, fail-closed postcondition for a reviewed one-off admission. */
export async function assertRequiredRlsEnforcement(
  connection: QueryConnection,
  environment: NodeJS.ProcessEnv = process.env,
  options: { allowNonProductionBootstrapRole?: boolean } = {},
): Promise<void> {
  const raw = environment.REQUIRE_RLS_TABLE_ENFORCEMENT ?? "";
  if (raw.trim() === "") return;
  const tables = raw.split(",").map((table) => table.trim());
  if (new Set(tables).size !== tables.length || !isReviewedRlsEnforcementRequest(tables)) {
    throw new Error("Unsupported required RLS enforcement table list");
  }
  const fail = () => new Error(`Required RLS enforcement failed for ${tables.join(",")}`);
  const enabled = parseRlsEnabledTables(environment.RLS_ENABLED_TABLES);
  if (environment.RLS_GUC_ENABLED !== "true" || tables.some((table) => !enabled.has(table))) {
    throw fail();
  }
  const role = await readRlsDatabaseRole(connection);
  // Disposable legacy bootstrap creates schema as an administrator before CI
  // grants a restricted application role. Only that guarded caller opts in;
  // production ledger admission must reject roles that bypass these policies.
  const bootstrapRoleAllowed = options.allowNonProductionBootstrapRole === true &&
    environment.NODE_ENV !== "production";
  if ((role.superuser || role.bypassRls) && !bootstrapRoleAllowed) throw fail();
  const catalog = await readRlsCatalog(connection, tables);
  if (catalog.length !== tables.length || tables.some((table) => {
    const entry = catalog.find((candidate) => candidate.tableName === table);
    return !entry || !hasCanonicalTenantPolicy(entry);
  })) {
    throw fail();
  }
}
