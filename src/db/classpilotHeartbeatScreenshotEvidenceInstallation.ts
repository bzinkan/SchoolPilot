import type { PoolClient } from "pg";
import {
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_BODY as expectedBody,
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SIGNATURE as signature,
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_SQL as definition,
  CLASSPILOT_HEARTBEAT_SCREENSHOT_EVIDENCE_REVOKE_SQL as revokePublic,
} from "./classpilotHeartbeatScreenshotEvidenceDefinition.js";

type Connection = Pick<PoolClient, "query">;
type Catalog = {
  body: string; language: string; volatility: string; securityDefiner: boolean;
  parallel: string; kind: string; returnsSet: boolean; strict: boolean; leakproof: boolean; defaultArguments: number;
  resultType: string; configuration: string[] | null; argumentNames: string[];
  executable: boolean; publicExecute: boolean;
};

async function readCatalog(connection: Connection): Promise<Catalog | undefined> {
  const result = await connection.query<Catalog>(`
    SELECT p.prosrc AS body, l.lanname AS language, p.provolatile AS volatility,
      p.prosecdef AS "securityDefiner", p.proparallel AS parallel, p.prokind AS kind,
      p.proretset AS "returnsSet", p.proisstrict AS strict, p.proleakproof AS leakproof,
      p.pronargdefaults AS "defaultArguments",
      pg_catalog.format_type(p.prorettype, NULL) AS "resultType",
      p.proconfig AS configuration, p.proargnames AS "argumentNames",
      pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE') AS executable,
      EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "publicExecute"
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = pg_catalog.to_regprocedure($1)
  `, [signature]);
  return result.rows[0];
}

function assertDefinition(row: Catalog | undefined): asserts row is Catalog {
  if (!row || row.body !== expectedBody || row.language !== "plpgsql" ||
      row.volatility !== "v" || row.securityDefiner !== false || row.parallel !== "u" ||
      row.kind !== "f" || row.returnsSet !== false || row.strict !== false || row.leakproof !== false ||
      row.defaultArguments !== 0 || row.resultType !== "jsonb" ||
      JSON.stringify(row.configuration) !== JSON.stringify(["search_path=pg_catalog"]) ||
      JSON.stringify(row.argumentNames) !== JSON.stringify(["p_school_id", "p_student_id", "p_session_id", "p_device_id"])) {
    throw new Error("ClassPilot screenshot evidence function is missing or differs from the immutable v1 contract");
  }
}

/** Read-only assertion through the actual runtime connection, once before serving. */
export async function assertClasspilotHeartbeatScreenshotEvidence(connection: Connection): Promise<void> {
  const row = await readCatalog(connection);
  assertDefinition(row);
  if (!row.executable || row.publicExecute) {
    throw new Error("ClassPilot screenshot evidence requires scoped runtime EXECUTE and no PUBLIC EXECUTE");
  }
}

/** Migration/fixture owner only. An existing incompatible function is never replaced. */
export async function installClasspilotHeartbeatScreenshotEvidence(connection: Connection): Promise<void> {
  const existing = await readCatalog(connection);
  if (existing) assertDefinition(existing);
  else await connection.query(definition);
  await connection.query(revokePublic);
  await assertClasspilotHeartbeatScreenshotEvidence(connection);
}

/** Explicit fixture role only; does not discover or infer production login roles. */
export async function grantClasspilotHeartbeatScreenshotEvidence(connection: Connection, roleName: string): Promise<void> {
  if (!roleName || roleName.includes("\0")) throw new Error("An existing exact fixture role is required");
  const role = await connection.query<{ rolname: string }>(
    "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = $1", [roleName],
  );
  if (role.rows.length !== 1) throw new Error("An existing exact fixture role is required");
  assertDefinition(await readCatalog(connection));
  const quotedRole = `"${roleName.replace(/"/g, '""')}"`;
  await connection.query(revokePublic);
  await connection.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${quotedRole}`);
}
