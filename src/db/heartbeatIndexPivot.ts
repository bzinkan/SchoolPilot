import type { PoolClient } from "pg";

export const REDUNDANT_HEARTBEAT_INDEX_NAMES = [
  "heartbeats_timestamp_idx",
  "heartbeats_student_id_idx",
  "heartbeats_student_email_idx",
  "heartbeats_device_id_idx",
  "heartbeats_email_timestamp_idx",
  "heartbeats_school_email_idx",
] as const;

export const DEVICES_SCHOOL_INDEX_NAME = "devices_school_id_idx";

export const HEARTBEAT_INDEX_PIVOT_RESTORE_STATEMENTS = [
  "CREATE INDEX CONCURRENTLY heartbeats_timestamp_idx ON public.heartbeats USING btree (timestamp)",
  "CREATE INDEX CONCURRENTLY heartbeats_student_id_idx ON public.heartbeats USING btree (student_id)",
  "CREATE INDEX CONCURRENTLY heartbeats_student_email_idx ON public.heartbeats USING btree (student_email)",
  "CREATE INDEX CONCURRENTLY heartbeats_device_id_idx ON public.heartbeats USING btree (device_id)",
  "CREATE INDEX CONCURRENTLY heartbeats_email_timestamp_idx ON public.heartbeats USING btree (student_email, timestamp)",
  "CREATE INDEX CONCURRENTLY heartbeats_school_email_idx ON public.heartbeats USING btree (school_id, student_email)",
] as const;

const HEARTBEAT_INDEX_PIVOT_LOCK =
  "schoolpilot:heartbeat-index-pivot-2026-07";
const ONLINE_DDL_STATEMENT_TIMEOUT = "8min";
const ONLINE_DDL_LOCK_TIMEOUT = "30s";

export type OnlineIndexCatalogState = {
  access_method: string;
  current_user_can_manage: boolean;
  index_definition: string;
  index_name: string;
  index_owner: string;
  index_schema: string;
  indislive: boolean;
  indisprimary: boolean;
  indisready: boolean;
  indisunique: boolean;
  indisvalid: boolean;
  indisexclusion: boolean;
  indnullsnotdistinct: boolean;
  is_constraint_owned: boolean;
  is_plain: boolean;
  key_columns: string[];
  key_count: number;
  key_descending: boolean[];
  key_nulls_first: boolean[];
  owner_matches_table: boolean;
  table_name: string;
  table_owner: string;
  table_schema: string;
  total_column_count: number;
};

type ExpectedIndex = {
  constraintOwned: boolean;
  keyColumns: readonly string[];
  keyDescending: readonly boolean[];
  name: string;
  primary: boolean;
  table: "devices" | "heartbeats";
  unique: boolean;
};

const survivorIndexes: readonly ExpectedIndex[] = [
  {
    name: "heartbeats_pkey",
    table: "heartbeats",
    keyColumns: ["id"],
    keyDescending: [false],
    unique: true,
    primary: true,
    constraintOwned: true,
  },
  {
    name: "heartbeats_student_timestamp_idx",
    table: "heartbeats",
    keyColumns: ["student_id", "timestamp"],
    keyDescending: [false, false],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
  {
    name: "heartbeats_school_timestamp_idx",
    table: "heartbeats",
    keyColumns: ["school_id", "timestamp"],
    keyDescending: [false, true],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
  {
    name: "heartbeats_school_device_timestamp_idx",
    table: "heartbeats",
    keyColumns: ["school_id", "device_id", "timestamp"],
    keyDescending: [false, false, true],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
];

const redundantIndexes: readonly ExpectedIndex[] = [
  {
    name: "heartbeats_timestamp_idx",
    table: "heartbeats",
    keyColumns: ["timestamp"],
    keyDescending: [false],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
  {
    name: "heartbeats_student_id_idx",
    table: "heartbeats",
    keyColumns: ["student_id"],
    keyDescending: [false],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
  {
    name: "heartbeats_student_email_idx",
    table: "heartbeats",
    keyColumns: ["student_email"],
    keyDescending: [false],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
  {
    name: "heartbeats_device_id_idx",
    table: "heartbeats",
    keyColumns: ["device_id"],
    keyDescending: [false],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
  {
    name: "heartbeats_email_timestamp_idx",
    table: "heartbeats",
    keyColumns: ["student_email", "timestamp"],
    keyDescending: [false, false],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
  {
    name: "heartbeats_school_email_idx",
    table: "heartbeats",
    keyColumns: ["school_id", "student_email"],
    keyDescending: [false, false],
    unique: false,
    primary: false,
    constraintOwned: false,
  },
];

const devicesSchoolIndex: ExpectedIndex = {
  name: DEVICES_SCHOOL_INDEX_NAME,
  table: "devices",
  keyColumns: ["school_id"],
  keyDescending: [false],
  unique: false,
  primary: false,
  constraintOwned: false,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function definitionMatches(
  state: OnlineIndexCatalogState,
  expected: ExpectedIndex
): boolean {
  const keys = expected.keyColumns
    .map((column, index) => {
      const quotedColumn = `"?${escapeRegExp(column)}"?`;
      return expected.keyDescending[index]
        ? `${quotedColumn} DESC(?: NULLS FIRST)?`
        : `${quotedColumn}(?: ASC)?(?: NULLS LAST)?`;
    })
    .join(",\\s*");
  const pattern = new RegExp(
    `^CREATE ${expected.unique ? "UNIQUE " : ""}INDEX "?${escapeRegExp(expected.name)}"? ON (?:ONLY )?"?public"?\\."?${escapeRegExp(expected.table)}"? USING btree \\(${keys}\\)$`,
    "i"
  );
  return pattern.test(state.index_definition.replace(/\s+/g, " ").trim());
}

function hasExpectedStructure(
  state: OnlineIndexCatalogState | undefined,
  expected: ExpectedIndex
): boolean {
  if (!state) return false;
  const expectedNullsFirst = expected.keyDescending.map(Boolean);
  return (
    state.index_name === expected.name &&
    state.index_schema === "public" &&
    state.table_schema === "public" &&
    state.table_name === expected.table &&
    state.access_method === "btree" &&
    state.indisunique === expected.unique &&
    state.indisprimary === expected.primary &&
    state.indisexclusion === false &&
    state.indnullsnotdistinct === false &&
    state.is_constraint_owned === expected.constraintOwned &&
    state.is_plain === true &&
    state.key_count === expected.keyColumns.length &&
    state.total_column_count === expected.keyColumns.length &&
    state.key_columns.length === expected.keyColumns.length &&
    state.key_columns.every(
      (column, index) => column === expected.keyColumns[index]
    ) &&
    state.key_descending.length === expected.keyDescending.length &&
    state.key_descending.every(
      (descending, index) => descending === expected.keyDescending[index]
    ) &&
    state.key_nulls_first.length === expectedNullsFirst.length &&
    state.key_nulls_first.every(
      (nullsFirst, index) => nullsFirst === expectedNullsFirst[index]
    ) &&
    definitionMatches(state, expected)
  );
}

function isExpectedHealthyIndex(
  state: OnlineIndexCatalogState | undefined,
  expected: ExpectedIndex
): boolean {
  return (
    hasExpectedStructure(state, expected) &&
    state?.indisready === true &&
    state.indisvalid === true &&
    state.indislive === true
  );
}

async function inspectIndex(
  client: PoolClient,
  indexName: string
): Promise<OnlineIndexCatalogState | undefined> {
  const result = await client.query<OnlineIndexCatalogState>(
    `
      SELECT
        access_method.amname AS access_method,
        pg_has_role(current_user, idx.relowner, 'USAGE') AS current_user_can_manage,
        pg_get_indexdef(i.indexrelid) AS index_definition,
        idx.relname AS index_name,
        pg_get_userbyid(idx.relowner) AS index_owner,
        index_namespace.nspname AS index_schema,
        i.indislive,
        i.indisprimary,
        i.indisready,
        i.indisunique,
        i.indisvalid,
        i.indisexclusion,
        i.indnullsnotdistinct,
        EXISTS (
          SELECT 1
          FROM pg_constraint AS index_constraint
          WHERE index_constraint.conindid = i.indexrelid
        ) AS is_constraint_owned,
        i.indpred IS NULL AND i.indexprs IS NULL AS is_plain,
        i.indnkeyatts::integer AS key_count,
        i.indnatts::integer AS total_column_count,
        table_class.relname AS table_name,
        pg_get_userbyid(table_class.relowner) AS table_owner,
        table_namespace.nspname AS table_schema,
        idx.relowner = table_class.relowner AS owner_matches_table,
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
        ) AS key_descending,
        ARRAY(
          SELECT (sort_option.option & 2) = 2
          FROM unnest(i.indoption::smallint[]) WITH ORDINALITY AS sort_option(option, position)
          WHERE sort_option.position <= i.indnkeyatts
          ORDER BY sort_option.position
        ) AS key_nulls_first
      FROM pg_class AS idx
      INNER JOIN pg_index AS i ON i.indexrelid = idx.oid
      INNER JOIN pg_class AS table_class ON table_class.oid = i.indrelid
      INNER JOIN pg_am AS access_method ON access_method.oid = idx.relam
      INNER JOIN pg_namespace AS index_namespace
        ON index_namespace.oid = idx.relnamespace
      INNER JOIN pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
      WHERE index_namespace.nspname = 'public'
        AND idx.relname = $1
    `,
    [indexName]
  );
  return result.rows[0];
}

function assertManagedTableIndex(
  state: OnlineIndexCatalogState,
  expected: ExpectedIndex
): void {
  if (
    state.index_schema !== "public" ||
    state.table_schema !== "public" ||
    state.table_name !== expected.table
  ) {
    throw new Error(
      `${expected.name} belongs to ${state.table_schema}.${state.table_name}, not public.${expected.table}; refusing index pivot`
    );
  }
  if (state.owner_matches_table !== true) {
    throw new Error(
      `${expected.name} owner ${state.index_owner} does not match public.${expected.table} owner ${state.table_owner}; refusing index pivot`
    );
  }
  if (state.current_user_can_manage !== true) {
    throw new Error(
      `current migration user cannot manage ${expected.name}; refusing index pivot`
    );
  }
}

async function assertSurvivors(client: PoolClient): Promise<void> {
  for (const expected of survivorIndexes) {
    const state = await inspectIndex(client, expected.name);
    if (state) assertManagedTableIndex(state, expected);
    if (!isExpectedHealthyIndex(state, expected)) {
      throw new Error(
        `required survivor ${expected.name} is missing, invalid, or structurally unexpected; refusing index pivot`
      );
    }
  }
}

/**
 * Remove the six verified-redundant heartbeat indexes and add the school lookup
 * index for devices without taking a table-wide index-build lock.
 *
 * This function is deliberately safe only for a one-off migrations-only
 * process. Every concurrent DDL statement is issued separately and there is no
 * regular CREATE/DROP fallback.
 */
export async function applyHeartbeatIndexPivotOnline(
  client: PoolClient
): Promise<void> {
  let lockHeld = false;
  let originalStatementTimeout: string | undefined;
  let originalLockTimeout: string | undefined;
  let statementTimeoutChanged = false;
  let lockTimeoutChanged = false;
  let operationFailed = false;

  try {
    const statementTimeout = await client.query<{ statement_timeout: string }>(
      "SHOW statement_timeout"
    );
    originalStatementTimeout = statementTimeout.rows[0]?.statement_timeout;
    if (!originalStatementTimeout) {
      throw new Error("could not capture migration statement_timeout");
    }
    const lockTimeout = await client.query<{ lock_timeout: string }>(
      "SHOW lock_timeout"
    );
    originalLockTimeout = lockTimeout.rows[0]?.lock_timeout;
    if (!originalLockTimeout) {
      throw new Error("could not capture migration lock_timeout");
    }

    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [HEARTBEAT_INDEX_PIVOT_LOCK]
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new Error(
        "heartbeat index pivot is already running on another session"
      );
    }
    lockHeld = true;

    await client.query("SELECT set_config('statement_timeout', $1, false)", [
      ONLINE_DDL_STATEMENT_TIMEOUT,
    ]);
    statementTimeoutChanged = true;
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      ONLINE_DDL_LOCK_TIMEOUT,
    ]);
    lockTimeoutChanged = true;

    // Validate every survivor and every removable name before the first DDL.
    // This prevents drift, a reused canonical name, or an incomplete schema
    // bootstrap from silently losing a useful or constraint-owned index.
    await assertSurvivors(client);
    for (const expected of redundantIndexes) {
      const state = await inspectIndex(client, expected.name);
      if (!state) continue;
      assertManagedTableIndex(state, expected);
      if (state.is_constraint_owned) {
        throw new Error(
          `${expected.name} is constraint-owned; refusing index pivot`
        );
      }
      // A timed-out DROP INDEX CONCURRENTLY can leave the exact target marked
      // invalid. Its exact table, owner, keys, and non-constraint relationship
      // are still sufficient to resume the requested drop safely.
      if (!hasExpectedStructure(state, expected)) {
        throw new Error(
          `${expected.name} is structurally unexpected; refusing index pivot`
        );
      }
    }

    let existingDeviceIndex = await inspectIndex(
      client,
      devicesSchoolIndex.name
    );
    if (existingDeviceIndex) {
      assertManagedTableIndex(existingDeviceIndex, devicesSchoolIndex);
      if (existingDeviceIndex.is_constraint_owned) {
        throw new Error(
          `${devicesSchoolIndex.name} is constraint-owned; refusing index pivot`
        );
      }
      if (!hasExpectedStructure(existingDeviceIndex, devicesSchoolIndex)) {
        throw new Error(
          `${devicesSchoolIndex.name} is structurally unexpected; refusing index pivot`
        );
      }
    }

    if (
      existingDeviceIndex &&
      !isExpectedHealthyIndex(existingDeviceIndex, devicesSchoolIndex)
    ) {
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS public.${DEVICES_SCHOOL_INDEX_NAME}`
      );
      existingDeviceIndex = undefined;
    }

    if (!existingDeviceIndex) {
      await client.query(
        `CREATE INDEX CONCURRENTLY ${DEVICES_SCHOOL_INDEX_NAME} ON public.devices USING btree (school_id)`
      );
      const createdDeviceIndex = await inspectIndex(
        client,
        devicesSchoolIndex.name
      );
      if (!isExpectedHealthyIndex(createdDeviceIndex, devicesSchoolIndex)) {
        throw new Error(
          `${devicesSchoolIndex.name} is missing or invalid after concurrent creation`
        );
      }
    }

    // PostgreSQL permits only one index name per DROP INDEX CONCURRENTLY. Keep
    // these as six independent statements so any timeout is resumable.
    for (const indexName of REDUNDANT_HEARTBEAT_INDEX_NAMES) {
      await client.query(
        `DROP INDEX CONCURRENTLY IF EXISTS public.${indexName}`
      );
    }

    for (const indexName of REDUNDANT_HEARTBEAT_INDEX_NAMES) {
      const remaining = await inspectIndex(client, indexName);
      if (remaining) {
        throw new Error(
          `${indexName} still exists after concurrent drop; refusing to mark index pivot complete`
        );
      }
    }
    const verifiedDeviceIndex = await inspectIndex(
      client,
      devicesSchoolIndex.name
    );
    if (!isExpectedHealthyIndex(verifiedDeviceIndex, devicesSchoolIndex)) {
      throw new Error(
        `${devicesSchoolIndex.name} is missing or invalid at final verification`
      );
    }
    await assertSurvivors(client);

    // Retried on a fully converged rerun if a previous task completed the DDL
    // but timed out while refreshing planner statistics.
    await client.query("ANALYZE public.heartbeats");
    await client.query("ANALYZE public.devices");
  } catch (err) {
    operationFailed = true;
    throw err;
  } finally {
    let cleanupFailure: Error | undefined;
    if (lockTimeoutChanged && originalLockTimeout) {
      try {
        await client.query("SELECT set_config('lock_timeout', $1, false)", [
          originalLockTimeout,
        ]);
      } catch (err) {
        cleanupFailure = new Error(
          `failed to restore heartbeat-index-pivot lock_timeout: ${(err as Error).message}`
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
          `failed to restore heartbeat-index-pivot statement_timeout: ${(err as Error).message}`
        );
      }
    }
    if (lockHeld) {
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtext($1)) AS unlocked",
          [HEARTBEAT_INDEX_PIVOT_LOCK]
        );
        if (unlock.rows[0]?.unlocked !== true) {
          throw new Error("session did not hold the advisory lock");
        }
      } catch (err) {
        cleanupFailure ??= new Error(
          `failed to release heartbeat-index-pivot advisory lock: ${(err as Error).message}`
        );
      }
    }
    if (cleanupFailure) {
      if (operationFailed) {
        console.error(
          "[migration] heartbeat-index-pivot session cleanup failed:",
          cleanupFailure.message
        );
      } else {
        throw cleanupFailure;
      }
    }
  }
}
