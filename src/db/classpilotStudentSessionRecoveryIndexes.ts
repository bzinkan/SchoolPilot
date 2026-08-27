import type { PoolClient } from "pg";

export const CLASSPILOT_MANUAL_LEASE_INDEX_NAME =
  "student_sessions_manual_lease_expiry_idx";
export const CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME =
  "student_sessions_manual_lease_expiry_build_idx";
export const CLASSPILOT_RECOVERY_TOKEN_INDEX_NAME =
  "student_sessions_recovery_token_hash_unique";
export const CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME =
  "student_sessions_recovery_token_hash_build_idx";

const CLASSPILOT_RECOVERY_INDEX_LOCK =
  "schoolpilot:student_sessions_recovery_indexes";
const CLASSPILOT_RECOVERY_INDEX_STATEMENT_TIMEOUT = "10min";
const CLASSPILOT_RECOVERY_INDEX_LOCK_TIMEOUT = "15s";

export const CLASSPILOT_STUDENT_SESSION_RECOVERY_INDEXES_CONTRACT = `
student_sessions_manual_lease_expiry_idx:
  nonunique btree (manual_lease_expires_at)
  where auth_kind = 'manual_shared' and is_active = true and ended_at is null
student_sessions_recovery_token_hash_unique:
  unique btree (session_recovery_token_hash)
  where session_recovery_token_hash is not null
online-build: CREATE INDEX CONCURRENTLY
catalog-verification: table, access method, columns, predicate, uniqueness,
  constraint ownership, expression-free, indislive, indisready, indisvalid
`;

export type ClasspilotStudentSessionRecoveryIndexState = {
  access_method: string;
  index_definition: string;
  index_predicate: string | null;
  indislive: boolean;
  indisready: boolean;
  indisunique: boolean;
  indisvalid: boolean;
  is_constraint_owned: boolean;
  is_expression_free: boolean;
  key_columns: string[];
  key_count: number;
  table_name: string;
  total_column_count: number;
};

type RecoveryIndexSpec = {
  buildName: string;
  canonicalName: string;
  createSql: string;
  expectedPredicate: string;
  keyColumns: string[];
  label: string;
  unique: boolean;
};

const MANUAL_LEASE_INDEX_SPEC: RecoveryIndexSpec = {
  buildName: CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME,
  canonicalName: CLASSPILOT_MANUAL_LEASE_INDEX_NAME,
  createSql: `CREATE INDEX CONCURRENTLY ${CLASSPILOT_MANUAL_LEASE_BUILD_INDEX_NAME}
    ON public.student_sessions USING btree (manual_lease_expires_at)
    WHERE auth_kind = 'manual_shared'
      AND is_active = true
      AND ended_at IS NULL`,
  expectedPredicate: "auth_kind='manual_shared'andis_activeandended_atisnull",
  keyColumns: ["manual_lease_expires_at"],
  label: "manual-session lease expiry",
  unique: false,
};

const RECOVERY_TOKEN_INDEX_SPEC: RecoveryIndexSpec = {
  buildName: CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME,
  canonicalName: CLASSPILOT_RECOVERY_TOKEN_INDEX_NAME,
  createSql: `CREATE UNIQUE INDEX CONCURRENTLY ${CLASSPILOT_RECOVERY_TOKEN_BUILD_INDEX_NAME}
    ON public.student_sessions USING btree (session_recovery_token_hash)
    WHERE session_recovery_token_hash IS NOT NULL`,
  expectedPredicate: "session_recovery_token_hashisnotnull",
  keyColumns: ["session_recovery_token_hash"],
  label: "manual-session recovery token",
  unique: true,
};

const RECOVERY_INDEX_SPECS = [
  MANUAL_LEASE_INDEX_SPEC,
  RECOVERY_TOKEN_INDEX_SPEC,
] as const;

function normalizeIndexDefinition(value: string): string {
  return value.toLowerCase().replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function normalizePredicate(value: string | null): string {
  return String(value || "")
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/::(?:text|character varying)/g, "")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "")
    .replace(/is_active=true/g, "is_active");
}

function isExpectedRecoveryIndex(
  state: ClasspilotStudentSessionRecoveryIndexState | undefined,
  spec: RecoveryIndexSpec
): boolean {
  if (!state) return false;

  const definition = normalizeIndexDefinition(state.index_definition);
  const expectedDefinitionTail =
    `using btree (${spec.keyColumns.join(", ")}) where`;

  return (
    state.table_name === "student_sessions"
    && state.access_method === "btree"
    && state.indislive === true
    && state.indisready === true
    && state.indisvalid === true
    && state.indisunique === spec.unique
    && state.is_constraint_owned === false
    && state.is_expression_free === true
    && state.key_count === spec.keyColumns.length
    && state.total_column_count === spec.keyColumns.length
    && state.key_columns.length === spec.keyColumns.length
    && state.key_columns.every((column, index) => column === spec.keyColumns[index])
    && normalizePredicate(state.index_predicate) === spec.expectedPredicate
    && definition.includes(expectedDefinitionTail)
  );
}

export function isExpectedClasspilotManualLeaseIndex(
  state: ClasspilotStudentSessionRecoveryIndexState | undefined
): boolean {
  return isExpectedRecoveryIndex(state, MANUAL_LEASE_INDEX_SPEC);
}

export function isExpectedClasspilotRecoveryTokenIndex(
  state: ClasspilotStudentSessionRecoveryIndexState | undefined
): boolean {
  return isExpectedRecoveryIndex(state, RECOVERY_TOKEN_INDEX_SPEC);
}

async function inspectRecoveryIndex(
  client: Pick<PoolClient, "query">,
  indexName: string
): Promise<ClasspilotStudentSessionRecoveryIndexState | undefined> {
  const result = await client.query<ClasspilotStudentSessionRecoveryIndexState>(
    `
      SELECT
        access_method.amname AS access_method,
        pg_get_indexdef(index_state.indexrelid) AS index_definition,
        pg_get_expr(index_state.indpred, index_state.indrelid) AS index_predicate,
        index_state.indislive,
        index_state.indisready,
        index_state.indisunique,
        index_state.indisvalid,
        EXISTS (
          SELECT 1
          FROM pg_constraint AS index_constraint
          WHERE index_constraint.conindid = index_state.indexrelid
        ) AS is_constraint_owned,
        index_state.indexprs IS NULL AS is_expression_free,
        index_state.indnkeyatts::integer AS key_count,
        index_state.indnatts::integer AS total_column_count,
        table_class.relname AS table_name,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(index_state.indkey::smallint[])
            WITH ORDINALITY AS key_column(attnum, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = index_state.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.position <= index_state.indnkeyatts
          ORDER BY key_column.position
        ) AS key_columns
      FROM pg_class AS index_class
      INNER JOIN pg_index AS index_state
        ON index_state.indexrelid = index_class.oid
      INNER JOIN pg_class AS table_class
        ON table_class.oid = index_state.indrelid
      INNER JOIN pg_am AS access_method
        ON access_method.oid = index_class.relam
      INNER JOIN pg_namespace AS namespace
        ON namespace.oid = index_class.relnamespace
      WHERE namespace.nspname = 'public'
        AND index_class.relname = $1
    `,
    [indexName]
  );
  return result.rows[0];
}

function assertReplaceableIndex(
  state: ClasspilotStudentSessionRecoveryIndexState | undefined,
  indexName: string
): void {
  if (!state) return;
  if (state.table_name !== "student_sessions") {
    throw new Error(
      `${indexName} belongs to public.${state.table_name}, not public.student_sessions`
    );
  }
  if (state.is_constraint_owned) {
    throw new Error(
      `${indexName} is constraint-owned; refusing online replacement`
    );
  }
}

async function dropIndexConcurrently(
  client: Pick<PoolClient, "query">,
  indexName: string
): Promise<void> {
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${indexName}`);
}

async function ensureRecoveryIndexOnline(
  client: Pick<PoolClient, "query">,
  spec: RecoveryIndexSpec
): Promise<void> {
  const canonical = await inspectRecoveryIndex(client, spec.canonicalName);
  assertReplaceableIndex(canonical, spec.canonicalName);

  if (isExpectedRecoveryIndex(canonical, spec)) {
    const staleBuild = await inspectRecoveryIndex(client, spec.buildName);
    assertReplaceableIndex(staleBuild, spec.buildName);
    if (staleBuild) await dropIndexConcurrently(client, spec.buildName);
    return;
  }

  let build = await inspectRecoveryIndex(client, spec.buildName);
  assertReplaceableIndex(build, spec.buildName);
  if (build && !isExpectedRecoveryIndex(build, spec)) {
    await dropIndexConcurrently(client, spec.buildName);
    build = undefined;
  }

  if (!build) {
    await client.query(spec.createSql);
    build = await inspectRecoveryIndex(client, spec.buildName);
  }

  if (!isExpectedRecoveryIndex(build, spec)) {
    throw new Error(
      `${spec.label} build index is missing or invalid after concurrent creation`
    );
  }

  // Keep any usable canonical index in place until the replacement is fully
  // built and verified. If rename fails, the valid build remains for retry.
  if (canonical) await dropIndexConcurrently(client, spec.canonicalName);
  await client.query(
    `ALTER INDEX public.${spec.buildName} RENAME TO ${spec.canonicalName}`
  );

  const verified = await inspectRecoveryIndex(client, spec.canonicalName);
  if (!isExpectedRecoveryIndex(verified, spec)) {
    throw new Error(
      `${spec.label} index is missing or invalid after online replacement`
    );
  }
}

/**
 * Build the recovery indexes without blocking student_sessions writes. This
 * must run on one connection and outside a transaction; the migration ledger
 * supplies that contract for nontransactional migrations.
 */
export async function ensureClasspilotStudentSessionRecoveryIndexesOnline(
  client: Pick<PoolClient, "query">
): Promise<void> {
  let lockHeld = false;
  let operationFailed = false;
  let statementTimeout: string | undefined;
  let lockTimeout: string | undefined;
  try {
    const statementTimeoutResult = await client.query<{ statement_timeout: string }>(
      "SHOW statement_timeout"
    );
    statementTimeout = statementTimeoutResult.rows[0]?.statement_timeout;
    const lockTimeoutResult = await client.query<{ lock_timeout: string }>(
      "SHOW lock_timeout"
    );
    lockTimeout = lockTimeoutResult.rows[0]?.lock_timeout;
    if (!statementTimeout || lockTimeout === undefined) {
      throw new Error("could not capture recovery-index migration timeouts");
    }

    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [CLASSPILOT_RECOVERY_INDEX_LOCK]
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new Error("student-session recovery index migration is already running");
    }
    lockHeld = true;

    await client.query("SELECT set_config('statement_timeout', $1, false)", [
      CLASSPILOT_RECOVERY_INDEX_STATEMENT_TIMEOUT,
    ]);
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      CLASSPILOT_RECOVERY_INDEX_LOCK_TIMEOUT,
    ]);

    for (const spec of RECOVERY_INDEX_SPECS) {
      await ensureRecoveryIndexOnline(client, spec);
    }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    let cleanupError: Error | undefined;
    if (statementTimeout !== undefined) {
      try {
        await client.query("SELECT set_config('statement_timeout', $1, false)", [
          statementTimeout,
        ]);
      } catch (error) {
        cleanupError = new Error(
          `failed to restore statement_timeout: ${(error as Error).message}`
        );
      }
    }
    if (lockTimeout !== undefined) {
      try {
        await client.query("SELECT set_config('lock_timeout', $1, false)", [
          lockTimeout,
        ]);
      } catch (error) {
        cleanupError ??= new Error(
          `failed to restore lock_timeout: ${(error as Error).message}`
        );
      }
    }
    if (lockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          CLASSPILOT_RECOVERY_INDEX_LOCK,
        ]);
      } catch (error) {
        cleanupError ??= new Error(
          `failed to release recovery-index advisory lock: ${(error as Error).message}`
        );
      }
    }
    if (cleanupError) {
      if (operationFailed) {
        console.error("[migration] recovery-index cleanup failed:", cleanupError.message);
      } else {
        throw cleanupError;
      }
    }
  }
}
