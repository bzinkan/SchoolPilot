import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import {
  DEVICES_SCHOOL_INDEX_NAME,
  HEARTBEAT_INDEX_PIVOT_RESTORE_STATEMENTS,
  REDUNDANT_HEARTBEAT_INDEX_NAMES,
  applyHeartbeatIndexPivotOnline,
  type OnlineIndexCatalogState,
} from "../src/db/heartbeatIndexPivot.js";

type StateOptions = Partial<OnlineIndexCatalogState>;

function exactState(
  name: string,
  table: "devices" | "heartbeats",
  keyColumns: string[],
  keyDescending: boolean[],
  options: StateOptions = {}
): OnlineIndexCatalogState {
  const unique = options.indisunique ?? name === "heartbeats_pkey";
  const keySql = keyColumns
    .map(
      (column, index) =>
        `${column === "timestamp" ? '"timestamp"' : column}${keyDescending[index] ? " DESC" : ""}`
    )
    .join(", ");
  return {
    access_method: "btree",
    current_user_can_manage: true,
    index_definition: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON public.${table} USING btree (${keySql})`,
    index_name: name,
    index_owner: "schoolpilot",
    index_schema: "public",
    indislive: true,
    indisprimary: name === "heartbeats_pkey",
    indisready: true,
    indisunique: unique,
    indisvalid: true,
    indisexclusion: false,
    indnullsnotdistinct: false,
    is_constraint_owned: name === "heartbeats_pkey",
    is_plain: true,
    key_columns: keyColumns,
    key_count: keyColumns.length,
    key_descending: keyDescending,
    key_nulls_first: keyDescending.map(Boolean),
    owner_matches_table: true,
    table_name: table,
    table_owner: "schoolpilot",
    table_schema: "public",
    total_column_count: keyColumns.length,
    ...options,
  };
}

const survivorStates = (): OnlineIndexCatalogState[] => [
  exactState("heartbeats_pkey", "heartbeats", ["id"], [false]),
  exactState(
    "heartbeats_student_timestamp_idx",
    "heartbeats",
    ["student_id", "timestamp"],
    [false, false]
  ),
  exactState(
    "heartbeats_school_timestamp_idx",
    "heartbeats",
    ["school_id", "timestamp"],
    [false, true]
  ),
  exactState(
    "heartbeats_school_device_timestamp_idx",
    "heartbeats",
    ["school_id", "device_id", "timestamp"],
    [false, false, true]
  ),
];

const redundantStates = (): OnlineIndexCatalogState[] => [
  exactState("heartbeats_timestamp_idx", "heartbeats", ["timestamp"], [false]),
  exactState("heartbeats_student_id_idx", "heartbeats", ["student_id"], [false]),
  exactState(
    "heartbeats_student_email_idx",
    "heartbeats",
    ["student_email"],
    [false]
  ),
  exactState("heartbeats_device_id_idx", "heartbeats", ["device_id"], [false]),
  exactState(
    "heartbeats_email_timestamp_idx",
    "heartbeats",
    ["student_email", "timestamp"],
    [false, false]
  ),
  exactState(
    "heartbeats_school_email_idx",
    "heartbeats",
    ["school_id", "student_email"],
    [false, false]
  ),
];

const deviceSchoolState = (
  options: StateOptions = {}
): OnlineIndexCatalogState =>
  exactState(
    DEVICES_SCHOOL_INDEX_NAME,
    "devices",
    ["school_id"],
    [false],
    options
  );

class FakePivotClient {
  readonly states = new Map<string, OnlineIndexCatalogState>();
  readonly statements: string[] = [];
  readonly ignoredDrops = new Set<string>();
  advisoryLockAcquired = true;
  failOncePattern: RegExp | undefined;
  makeCreatedDeviceIndexInvalid = false;
  statementTimeout = "15s";
  lockTimeout = "0";
  lockHeld = false;

  seed(states: OnlineIndexCatalogState[]): this {
    for (const state of states) this.states.set(state.index_name, state);
    return this;
  }

  async query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.statements.push(normalized);

    if (this.failOncePattern?.test(normalized)) {
      this.failOncePattern = undefined;
      throw new Error("canceling statement due to statement timeout");
    }
    if (normalized === "SHOW statement_timeout") {
      return { rows: [{ statement_timeout: this.statementTimeout }] };
    }
    if (normalized === "SHOW lock_timeout") {
      return { rows: [{ lock_timeout: this.lockTimeout }] };
    }
    if (normalized.startsWith("SELECT pg_try_advisory_lock")) {
      this.lockHeld = this.advisoryLockAcquired;
      return { rows: [{ acquired: this.advisoryLockAcquired }] };
    }
    if (normalized.startsWith("SELECT pg_advisory_unlock")) {
      const unlocked = this.lockHeld;
      this.lockHeld = false;
      return { rows: [{ unlocked }] };
    }
    if (normalized.startsWith("SELECT set_config('statement_timeout'")) {
      this.statementTimeout = String(params?.[0]);
      return { rows: [{ set_config: this.statementTimeout }] };
    }
    if (normalized.startsWith("SELECT set_config('lock_timeout'")) {
      this.lockTimeout = String(params?.[0]);
      return { rows: [{ set_config: this.lockTimeout }] };
    }
    if (normalized.includes("pg_get_indexdef(i.indexrelid)")) {
      const state = this.states.get(String(params?.[0]));
      return { rows: state ? [state] : [] };
    }
    if (
      normalized ===
      `CREATE INDEX CONCURRENTLY ${DEVICES_SCHOOL_INDEX_NAME} ON public.devices USING btree (school_id)`
    ) {
      this.states.set(
        DEVICES_SCHOOL_INDEX_NAME,
        deviceSchoolState(
          this.makeCreatedDeviceIndexInvalid ? { indisvalid: false } : {}
        )
      );
      return { rows: [] };
    }
    if (normalized.startsWith("DROP INDEX CONCURRENTLY IF EXISTS public.")) {
      const name = normalized.slice(normalized.lastIndexOf(".") + 1);
      if (!this.ignoredDrops.has(name)) this.states.delete(name);
      return { rows: [] };
    }
    return { rows: [] };
  }
}

const asPoolClient = (client: FakePivotClient): PoolClient =>
  client as unknown as PoolClient;

const ddlStatements = (client: FakePivotClient): string[] =>
  client.statements.filter((statement) =>
    /^(?:CREATE|DROP|ANALYZE)\b/.test(statement)
  );

describe("heartbeat index pivot contract", () => {
  it("keeps schema declarations aligned with the post-pivot catalog", () => {
    const schema = readFileSync(
      new URL("../src/schema/classpilot.ts", import.meta.url),
      "utf8"
    );
    for (const name of REDUNDANT_HEARTBEAT_INDEX_NAMES) {
      assert.doesNotMatch(schema, new RegExp(`index\\("${name}"\\)`));
    }
    assert.match(
      schema,
      /index\("devices_school_id_idx"\)\.on\(table\.schoolId\)/
    );
    assert.match(
      schema,
      /index\("heartbeats_student_timestamp_idx"\)\.on\([\s\S]*table\.studentId,[\s\S]*table\.timestamp/
    );
    assert.match(
      schema,
      /index\("heartbeats_school_timestamp_idx"\)\.on\([\s\S]*table\.schoolId,[\s\S]*table\.timestamp\.desc\(\)\.nullsFirst\(\)/
    );
    assert.match(
      schema,
      /index\("heartbeats_school_device_timestamp_idx"\)\.on\([\s\S]*table\.schoolId,[\s\S]*table\.deviceId,[\s\S]*table\.timestamp\.desc\(\)\.nullsFirst\(\)/
    );
  });

  it("wires the pivot only inside the one-off migrations-only branch", () => {
    const source = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8"
    );
    const sectionStart = source.indexOf(
      "// Teacher tile history requires the exact mixed-order index"
    );
    const sectionEnd = source.indexOf(
      "// Teacher tiles authorize by device id",
      sectionStart
    );
    assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
    const section = source.slice(sectionStart, sectionEnd);
    assert.match(
      section,
      /if \(migrationsOnly\(\)\) \{[\s\S]*ensureHeartbeatHistoryIndexOnline\(heartbeatIndexClient\)[\s\S]*applyHeartbeatIndexPivotOnline\(heartbeatIndexClient\)/
    );
    assert.equal(
      (source.match(/applyHeartbeatIndexPivotOnline\(/g) ?? []).length,
      1
    );
    assert.doesNotMatch(
      source,
      /CREATE INDEX(?: CONCURRENTLY)? IF NOT EXISTS heartbeats_school_timestamp_idx/
    );
  });

  it("uses catalog validation, bounded concurrent DDL, and no blocking fallback", () => {
    const source = readFileSync(
      new URL("../src/db/heartbeatIndexPivot.ts", import.meta.url),
      "utf8"
    );
    assert.match(source, /pg_get_indexdef\(i\.indexrelid\)/);
    assert.match(source, /i\.indisvalid/);
    assert.match(source, /i\.indisready/);
    assert.match(source, /i\.indislive/);
    assert.match(source, /index_constraint\.conindid = i\.indexrelid/);
    assert.match(source, /idx\.relowner = table_class\.relowner/);
    assert.match(source, /pg_has_role\(current_user, idx\.relowner, 'USAGE'\)/);
    assert.match(source, /ONLINE_DDL_STATEMENT_TIMEOUT = "8min"/);
    assert.match(source, /ONLINE_DDL_LOCK_TIMEOUT = "30s"/);
    assert.match(source, /pg_try_advisory_lock\(hashtext\(\$1\)\)/);
    assert.match(
      source,
      /CREATE INDEX CONCURRENTLY \$\{DEVICES_SCHOOL_INDEX_NAME\} ON public\.devices USING btree \(school_id\)/
    );
    assert.match(
      source,
      /DROP INDEX CONCURRENTLY IF EXISTS public\.\$\{indexName\}/
    );
    assert.doesNotMatch(
      source,
      /CREATE INDEX(?: IF NOT EXISTS)? devices_school_id_idx/
    );
    assert.doesNotMatch(source, /DROP INDEX IF EXISTS public\.heartbeats_/);
  });

  it("fails before DDL when a required survivor is missing or invalid", async () => {
    for (const mutate of [
      (client: FakePivotClient) =>
        client.states.delete("heartbeats_student_timestamp_idx"),
      (client: FakePivotClient) =>
        client.states.delete("heartbeats_school_timestamp_idx"),
      (client: FakePivotClient) => {
        const state = client.states.get("heartbeats_school_timestamp_idx");
        assert.ok(state);
        state.indisvalid = false;
      },
      (client: FakePivotClient) => {
        const state = client.states.get(
          "heartbeats_school_device_timestamp_idx"
        );
        assert.ok(state);
        state.key_descending = [false, false, false];
      },
      (client: FakePivotClient) => {
        const state = client.states.get("heartbeats_school_timestamp_idx");
        assert.ok(state);
        state.key_nulls_first = [false, false];
      },
    ]) {
      const client = new FakePivotClient().seed([
        ...survivorStates(),
        ...redundantStates(),
      ]);
      mutate(client);
      await assert.rejects(
        applyHeartbeatIndexPivotOnline(asPoolClient(client)),
        /required survivor .* missing, invalid, or structurally unexpected/
      );
      assert.deepEqual(ddlStatements(client), []);
      assert.equal(client.statementTimeout, "15s");
      assert.equal(client.lockTimeout, "0");
      assert.equal(client.lockHeld, false);
    }
  });

  it("refuses wrong-table, constraint-owned, or ownership-anomalous candidates", async () => {
    const cases: Array<[StateOptions, RegExp]> = [
      [
        {
          table_name: "devices",
          table_owner: "schoolpilot",
          index_definition:
            "CREATE INDEX heartbeats_timestamp_idx ON public.devices USING btree (timestamp)",
        },
        /belongs to public\.devices, not public\.heartbeats/,
      ],
      [{ is_constraint_owned: true }, /constraint-owned/],
      [
        {
          index_owner: "unexpected_owner",
          owner_matches_table: false,
        },
        /owner unexpected_owner does not match/,
      ],
      [{ current_user_can_manage: false }, /cannot manage/],
    ];

    for (const [change, expectedError] of cases) {
      const client = new FakePivotClient().seed([
        ...survivorStates(),
        ...redundantStates(),
      ]);
      Object.assign(client.states.get("heartbeats_timestamp_idx")!, change);
      await assert.rejects(
        applyHeartbeatIndexPivotOnline(asPoolClient(client)),
        expectedError
      );
      assert.deepEqual(ddlStatements(client), []);
    }
  });

  it("converges the post-schema catalog with six separate drops and both analyses", async () => {
    const client = new FakePivotClient().seed([
      ...survivorStates(),
      ...redundantStates(),
    ]);

    await applyHeartbeatIndexPivotOnline(asPoolClient(client));

    for (const name of REDUNDANT_HEARTBEAT_INDEX_NAMES) {
      assert.equal(client.states.has(name), false);
    }
    assert.ok(client.states.has(DEVICES_SCHOOL_INDEX_NAME));
    const drops = client.statements.filter((statement) =>
      statement.startsWith(
        "DROP INDEX CONCURRENTLY IF EXISTS public.heartbeats_"
      )
    );
    assert.equal(drops.length, 6);
    assert.equal(new Set(drops).size, 6);
    assert.ok(
      client.statements.includes("ANALYZE public.heartbeats") &&
        client.statements.includes("ANALYZE public.devices")
    );
    assert.equal(client.statementTimeout, "15s");
    assert.equal(client.lockTimeout, "0");
    assert.equal(client.lockHeld, false);
  });

  it("converges a fresh post-pivot schema without creating or repairing indexes", async () => {
    const client = new FakePivotClient().seed([
      ...survivorStates(),
      deviceSchoolState(),
    ]);

    await applyHeartbeatIndexPivotOnline(asPoolClient(client));

    assert.equal(
      client.statements.some((statement) =>
        statement.startsWith("CREATE INDEX")
      ),
      false
    );
    const drops = client.statements.filter((statement) =>
      statement.startsWith(
        "DROP INDEX CONCURRENTLY IF EXISTS public.heartbeats_"
      )
    );
    assert.equal(drops.length, 6);
    assert.equal(new Set(drops).size, 6);
    for (const survivor of survivorStates()) {
      assert.ok(client.states.has(survivor.index_name));
    }
    assert.ok(client.states.has(DEVICES_SCHOOL_INDEX_NAME));
    assert.ok(client.statements.includes("ANALYZE public.heartbeats"));
    assert.ok(client.statements.includes("ANALYZE public.devices"));
  });

  it("resumes a partial run without rebuilding an already exact device index", async () => {
    const remaining = redundantStates().slice(3);
    const client = new FakePivotClient().seed([
      ...survivorStates(),
      ...remaining,
      deviceSchoolState(),
    ]);

    await applyHeartbeatIndexPivotOnline(asPoolClient(client));

    assert.equal(
      client.statements.some((statement) =>
        statement.startsWith("CREATE INDEX CONCURRENTLY")
      ),
      false
    );
    for (const name of REDUNDANT_HEARTBEAT_INDEX_NAMES) {
      assert.equal(client.states.has(name), false);
    }
    assert.ok(client.statements.includes("ANALYZE public.heartbeats"));
  });

  it("resumes an interrupted concurrent drop whose exact target is invalid", async () => {
    const interruptedTarget = redundantStates();
    interruptedTarget[2]!.indisvalid = false;
    interruptedTarget[2]!.indisready = false;
    const client = new FakePivotClient().seed([
      ...survivorStates(),
      ...interruptedTarget,
      deviceSchoolState(),
    ]);

    await applyHeartbeatIndexPivotOnline(asPoolClient(client));

    for (const name of REDUNDANT_HEARTBEAT_INDEX_NAMES) {
      assert.equal(client.states.has(name), false);
    }
    assert.equal(client.statementTimeout, "15s");
    assert.equal(client.lockTimeout, "0");
  });

  it("replaces an invalid interrupted device build but rejects a wrong shape", async () => {
    const interrupted = new FakePivotClient().seed([
      ...survivorStates(),
      ...redundantStates(),
      deviceSchoolState({ indisvalid: false }),
    ]);
    await applyHeartbeatIndexPivotOnline(asPoolClient(interrupted));
    const dropPosition = interrupted.statements.indexOf(
      `DROP INDEX CONCURRENTLY IF EXISTS public.${DEVICES_SCHOOL_INDEX_NAME}`
    );
    const createPosition = interrupted.statements.indexOf(
      `CREATE INDEX CONCURRENTLY ${DEVICES_SCHOOL_INDEX_NAME} ON public.devices USING btree (school_id)`
    );
    assert.ok(dropPosition >= 0 && createPosition > dropPosition);

    const wrongShape = new FakePivotClient().seed([
      ...survivorStates(),
      ...redundantStates(),
      exactState(
        DEVICES_SCHOOL_INDEX_NAME,
        "devices",
        ["class_id"],
        [false]
      ),
    ]);
    await assert.rejects(
      applyHeartbeatIndexPivotOnline(asPoolClient(wrongShape)),
      /devices_school_id_idx is structurally unexpected/
    );
    assert.deepEqual(ddlStatements(wrongShape), []);
  });

  it("restores session state after a timeout and converges on retry", async () => {
    const client = new FakePivotClient().seed([
      ...survivorStates(),
      ...redundantStates(),
    ]);
    client.failOncePattern =
      /DROP INDEX CONCURRENTLY IF EXISTS public\.heartbeats_student_email_idx/;

    await assert.rejects(
      applyHeartbeatIndexPivotOnline(asPoolClient(client)),
      /statement timeout/
    );
    assert.equal(client.statementTimeout, "15s");
    assert.equal(client.lockTimeout, "0");
    assert.equal(client.lockHeld, false);
    assert.equal(client.states.has("heartbeats_timestamp_idx"), false);
    assert.equal(client.states.has("heartbeats_student_id_idx"), false);
    assert.equal(client.states.has("heartbeats_student_email_idx"), true);

    await applyHeartbeatIndexPivotOnline(asPoolClient(client));
    for (const name of REDUNDANT_HEARTBEAT_INDEX_NAMES) {
      assert.equal(client.states.has(name), false);
    }
  });

  it("fails final absence and device-validity postconditions", async () => {
    const ignoredDrop = new FakePivotClient().seed([
      ...survivorStates(),
      ...redundantStates(),
    ]);
    ignoredDrop.ignoredDrops.add("heartbeats_school_email_idx");
    await assert.rejects(
      applyHeartbeatIndexPivotOnline(asPoolClient(ignoredDrop)),
      /heartbeats_school_email_idx still exists/
    );

    const invalidCreate = new FakePivotClient().seed([
      ...survivorStates(),
      ...redundantStates(),
    ]);
    invalidCreate.makeCreatedDeviceIndexInvalid = true;
    await assert.rejects(
      applyHeartbeatIndexPivotOnline(asPoolClient(invalidCreate)),
      /devices_school_id_idx is missing or invalid after concurrent creation/
    );
    assert.equal(
      invalidCreate.states.has("heartbeats_timestamp_idx"),
      true,
      "heartbeat indexes must remain until the device index verifies"
    );
  });

  it("exports exact one-index-at-a-time concurrent restoration SQL", () => {
    assert.deepEqual(HEARTBEAT_INDEX_PIVOT_RESTORE_STATEMENTS, [
      "CREATE INDEX CONCURRENTLY heartbeats_timestamp_idx ON public.heartbeats USING btree (timestamp)",
      "CREATE INDEX CONCURRENTLY heartbeats_student_id_idx ON public.heartbeats USING btree (student_id)",
      "CREATE INDEX CONCURRENTLY heartbeats_student_email_idx ON public.heartbeats USING btree (student_email)",
      "CREATE INDEX CONCURRENTLY heartbeats_device_id_idx ON public.heartbeats USING btree (device_id)",
      "CREATE INDEX CONCURRENTLY heartbeats_email_timestamp_idx ON public.heartbeats USING btree (student_email, timestamp)",
      "CREATE INDEX CONCURRENTLY heartbeats_school_email_idx ON public.heartbeats USING btree (school_id, student_email)",
    ]);
    assert.equal(HEARTBEAT_INDEX_PIVOT_RESTORE_STATEMENTS.length, 6);
    for (const statement of HEARTBEAT_INDEX_PIVOT_RESTORE_STATEMENTS) {
      assert.match(statement, /^CREATE INDEX CONCURRENTLY /);
      assert.doesNotMatch(statement, /IF NOT EXISTS|;/);
    }
    const runbook = readFileSync(
      new URL("../docs/HEARTBEAT_INDEX_PIVOT.md", import.meta.url),
      "utf8"
    );
    for (const statement of HEARTBEAT_INDEX_PIVOT_RESTORE_STATEMENTS) {
      assert.ok(
        runbook.includes(`${statement};`),
        `runbook must include exact restoration statement: ${statement}`
      );
    }
    assert.match(runbook, /stats_reset/);
    assert.match(runbook, /indexrelid AS index_oid/);
    assert.match(runbook, /exactly six candidate rows/);
    assert.match(runbook, /name-to-index-OID mapping/);
    assert.match(runbook, /counter decrease/);
    assert.match(runbook, /pg_stat_reset_single_table_counters/);
    assert.match(runbook, /n_tup_hot_upd/);
    assert.match(runbook, /normal school traffic/);
    assert.match(runbook, /heartbeat\s+purge/);
    assert.match(runbook, /school-local `02:00` rollup/);
  });
});
