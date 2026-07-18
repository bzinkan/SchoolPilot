import type { PoolClient } from "pg";

export const HEARTBEAT_HISTORY_INDEX_NAME =
  "heartbeats_school_device_timestamp_idx";
export const HEARTBEAT_HISTORY_BUILD_INDEX_NAME =
  "heartbeats_school_device_timestamp_desc_build_idx";
export const HEARTBEAT_STUDENT_HISTORY_INDEX_NAME =
  "heartbeats_school_device_student_timestamp_idx";
export const HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME =
  "heartbeats_school_device_student_timestamp_build_idx";

const HEARTBEAT_HISTORY_INDEX_LOCK =
  "schoolpilot:heartbeats_school_device_timestamp_desc_idx";
// Bound every catalog/DDL statement independently. The deploy controller
// observes the entire migration task for up to one hour, so a slow concurrent
// build, cleanup, or ANALYZE remains authoritative without any one statement
// being allowed to run indefinitely.
const HEARTBEAT_HISTORY_BUILD_TIMEOUT = "8min";

export type HeartbeatHistoryIndexState = {
  access_method: string;
  index_definition: string;
  indislive: boolean;
  indisready: boolean;
  indisunique: boolean;
  indisvalid: boolean;
  is_constraint_owned: boolean;
  is_plain: boolean;
  key_columns: string[];
  key_descending: boolean[];
  key_count: number;
  total_column_count: number;
  table_name: string;
};

type HeartbeatHistoryIndexSpec = {
  buildName: string;
  canonicalName: string;
  createColumnsSql: string;
  definitionKeysPattern: RegExp;
  keyColumns: string[];
  keyDescending: boolean[];
  label: string;
};

const HEARTBEAT_HISTORY_INDEX_SPEC: HeartbeatHistoryIndexSpec = {
  buildName: HEARTBEAT_HISTORY_BUILD_INDEX_NAME,
  canonicalName: HEARTBEAT_HISTORY_INDEX_NAME,
  createColumnsSql: "school_id, device_id, timestamp DESC",
  definitionKeysPattern:
    /\bUSING btree \(school_id, device_id, "?timestamp"? DESC(?: NULLS FIRST)?\)$/i,
  keyColumns: ["school_id", "device_id", "timestamp"],
  keyDescending: [false, false, true],
  label: "heartbeat history",
};

const HEARTBEAT_STUDENT_HISTORY_INDEX_SPEC: HeartbeatHistoryIndexSpec = {
  buildName: HEARTBEAT_STUDENT_HISTORY_BUILD_INDEX_NAME,
  canonicalName: HEARTBEAT_STUDENT_HISTORY_INDEX_NAME,
  createColumnsSql: "school_id, device_id, student_id, timestamp DESC",
  definitionKeysPattern:
    /\bUSING btree \(school_id, device_id, student_id, "?timestamp"? DESC(?: NULLS FIRST)?\)$/i,
  keyColumns: ["school_id", "device_id", "student_id", "timestamp"],
  keyDescending: [false, false, false, true],
  label: "student-scoped heartbeat history",
};

const HEARTBEAT_HISTORY_INDEX_SPECS = [
  HEARTBEAT_HISTORY_INDEX_SPEC,
  HEARTBEAT_STUDENT_HISTORY_INDEX_SPEC,
] as const;

const normalizeIndexDefinition = (definition: string): string =>
  definition.replace(/\s+/g, " ").trim();

/**
 * The catalog fields are the authority for structure and validity. The
 * pg_get_indexdef check is intentionally additional: it makes the migration
 * fail closed if PostgreSQL reports a definition that contradicts pg_index.
 */
function isExpectedHeartbeatIndex(
  state: HeartbeatHistoryIndexState | undefined,
  spec: HeartbeatHistoryIndexSpec
): boolean {
  if (!state) return false;

  const definition = normalizeIndexDefinition(state.index_definition);

  return (
    state.indisready === true &&
    state.indisvalid === true &&
    state.indislive === true &&
    state.indisunique === false &&
    state.is_constraint_owned === false &&
    state.is_plain === true &&
    state.access_method === "btree" &&
    state.table_name === "heartbeats" &&
    state.key_count === spec.keyColumns.length &&
    state.total_column_count === spec.keyColumns.length &&
    state.key_columns.length === spec.keyColumns.length &&
    state.key_columns.every(
      (column, index) => column === spec.keyColumns[index]
    ) &&
    state.key_descending.length === spec.keyDescending.length &&
    state.key_descending.every(
      (descending, index) => descending === spec.keyDescending[index]
    ) &&
    spec.definitionKeysPattern.test(definition)
  );
}

export function isExpectedHeartbeatHistoryIndex(
  state: HeartbeatHistoryIndexState | undefined
): boolean {
  return isExpectedHeartbeatIndex(state, HEARTBEAT_HISTORY_INDEX_SPEC);
}

export function isExpectedHeartbeatStudentHistoryIndex(
  state: HeartbeatHistoryIndexState | undefined
): boolean {
  return isExpectedHeartbeatIndex(state, HEARTBEAT_STUDENT_HISTORY_INDEX_SPEC);
}

async function inspectHeartbeatHistoryIndex(
  client: PoolClient,
  indexName: string
): Promise<HeartbeatHistoryIndexState | undefined> {
  const result = await client.query<HeartbeatHistoryIndexState>(
    `
      SELECT
        access_method.amname AS access_method,
        pg_get_indexdef(i.indexrelid) AS index_definition,
        i.indislive,
        i.indisready,
        i.indisunique,
        i.indisvalid,
        EXISTS (
          SELECT 1
          FROM pg_constraint AS index_constraint
          WHERE index_constraint.conindid = i.indexrelid
        ) AS is_constraint_owned,
        i.indpred IS NULL AND i.indexprs IS NULL AS is_plain,
        i.indnkeyatts::integer AS key_count,
        i.indnatts::integer AS total_column_count,
        table_class.relname AS table_name,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
          INNER JOIN pg_attribute AS attribute
            ON attribute.attrelid = i.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.position <= i.indnkeyatts
          ORDER BY key_column.position
        ) AS key_columns,
        ARRAY(
          SELECT (sort_option.option & 1) = 1
          FROM unnest(i.indoption::smallint[]) WITH ORDINALITY AS sort_option(option, position)
          WHERE sort_option.position <= i.indnkeyatts
          ORDER BY sort_option.position
        ) AS key_descending
      FROM pg_class AS idx
      INNER JOIN pg_index AS i ON i.indexrelid = idx.oid
      INNER JOIN pg_class AS table_class ON table_class.oid = i.indrelid
      INNER JOIN pg_am AS access_method ON access_method.oid = idx.relam
      INNER JOIN pg_namespace AS n ON n.oid = idx.relnamespace
      WHERE n.nspname = 'public'
        AND idx.relname = $1
    `,
    [indexName]
  );
  return result.rows[0];
}

function assertHeartbeatIndexOwnership(
  state: HeartbeatHistoryIndexState | undefined,
  indexName: string
): void {
  if (!state) return;
  if (state.table_name !== "heartbeats") {
    throw new Error(
      `${indexName} belongs to public.${state.table_name}, not public.heartbeats; refusing online replacement`
    );
  }
  if (state.is_constraint_owned) {
    throw new Error(
      `${indexName} is owned by a database constraint; refusing online replacement`
    );
  }
  if (state.indisunique) {
    throw new Error(
      `${indexName} enforces uniqueness; refusing online replacement`
    );
  }
}

async function ensureHeartbeatIndexOnline(
  client: PoolClient,
  spec: HeartbeatHistoryIndexSpec
): Promise<void> {
  const canonical = await inspectHeartbeatHistoryIndex(
    client,
    spec.canonicalName
  );
  assertHeartbeatIndexOwnership(canonical, spec.canonicalName);
  if (isExpectedHeartbeatIndex(canonical, spec)) {
    const staleBuild = await inspectHeartbeatHistoryIndex(client, spec.buildName);
    assertHeartbeatIndexOwnership(staleBuild, spec.buildName);
    if (staleBuild) {
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS public.${spec.buildName}`
      );
    }
    return;
  }

  let build = await inspectHeartbeatHistoryIndex(client, spec.buildName);
  assertHeartbeatIndexOwnership(build, spec.buildName);
  if (build && !isExpectedHeartbeatIndex(build, spec)) {
    await client.query(
      `DROP INDEX CONCURRENTLY IF EXISTS public.${spec.buildName}`
    );
    build = undefined;
  }

  if (!build) {
    await client.query(
      `CREATE INDEX CONCURRENTLY ${spec.buildName} ON public.heartbeats USING btree (${spec.createColumnsSql})`
    );
    build = await inspectHeartbeatHistoryIndex(client, spec.buildName);
  }

  if (!isExpectedHeartbeatIndex(build, spec)) {
    throw new Error(
      `${spec.label} build index is missing or invalid after concurrent creation`
    );
  }

  // Only remove a malformed canonical index after the online replacement is
  // fully valid. If a later metadata rename fails, the valid build remains
  // available and the next migrations-only run can safely resume.
  if (canonical) {
    await client.query(
      `DROP INDEX CONCURRENTLY IF EXISTS public.${spec.canonicalName}`
    );
  }
  await client.query(
    `ALTER INDEX public.${spec.buildName} RENAME TO ${spec.canonicalName}`
  );

  const verified = await inspectHeartbeatHistoryIndex(
    client,
    spec.canonicalName
  );
  if (!isExpectedHeartbeatIndex(verified, spec)) {
    throw new Error(
      `${spec.label} index is missing or invalid after online replacement`
    );
  }
}

/**
 * Build and verify both teacher-tile heartbeat history indexes without taking
 * the table-wide lock used by a regular CREATE INDEX. Differently named build
 * indexes keep any existing canonical access path available until each
 * replacement has passed all catalog checks.
 *
 * This function must only be called by the one-off migrations-only process.
 * It deliberately has no non-concurrent fallback.
 */
export async function ensureHeartbeatHistoryIndexOnline(
  client: PoolClient
): Promise<void> {
  let lockHeld = false;
  let originalStatementTimeout: string | undefined;
  let operationFailed = false;
  let statementTimeoutChanged = false;
  try {
    const timeout = await client.query<{ statement_timeout: string }>(
      "SHOW statement_timeout"
    );
    originalStatementTimeout = timeout.rows[0]?.statement_timeout;
    if (!originalStatementTimeout) {
      throw new Error("could not capture the migration session statement_timeout");
    }

    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [HEARTBEAT_HISTORY_INDEX_LOCK]
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new Error(
        "heartbeat history index migration is already running on another session"
      );
    }
    lockHeld = true;
    await client.query("SELECT set_config('statement_timeout', $1, false)", [
      HEARTBEAT_HISTORY_BUILD_TIMEOUT,
    ]);
    statementTimeoutChanged = true;

    for (const spec of HEARTBEAT_HISTORY_INDEX_SPECS) {
      await ensureHeartbeatIndexOnline(client, spec);
    }

    // Run once only after both exact postconditions pass. A later rerun still
    // retries ANALYZE if an earlier task built both indexes but timed out here.
    await client.query("ANALYZE public.heartbeats");
  } catch (err) {
    operationFailed = true;
    throw err;
  } finally {
    let cleanupFailure: Error | undefined;
    if (lockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          HEARTBEAT_HISTORY_INDEX_LOCK,
        ]);
      } catch (err) {
        cleanupFailure = new Error(
          `failed to release heartbeat-index advisory lock: ${(err as Error).message}`
        );
      }
    }
    if (statementTimeoutChanged && originalStatementTimeout) {
      try {
        await client.query("SELECT set_config('statement_timeout', $1, false)", [
          originalStatementTimeout,
        ]);
      } catch (err) {
        cleanupFailure ??= new Error(
          `failed to restore heartbeat-index session statement_timeout: ${(err as Error).message}`
        );
      }
    }
    if (cleanupFailure) {
      // Preserve the primary migration error when one already exists. The
      // caller discards any client associated with a thrown migration error,
      // which also releases a stranded session advisory lock.
      if (operationFailed) {
        console.error(
          "[migration] heartbeat-index session cleanup failed:",
          cleanupFailure.message
        );
      } else {
        throw cleanupFailure;
      }
    }
  }
}
