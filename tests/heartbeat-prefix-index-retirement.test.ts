import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { retireHeartbeatPrefixIndexesOnline as retire } from "../src/db/heartbeatPrefixIndexRetirement.js";
import { heartbeatPrefixIndexRetirementMigration } from "../src/db/heartbeatPrefixIndexRetirementMigration.js";
import { runSchoolPilotMigrationLedger } from "../src/db/migrationLedger.js";

type Executor = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
const candidates = ["heartbeats_student_id_idx", "heartbeats_student_email_idx"];
const replacements = ["heartbeats_student_timestamp_idx", "heartbeats_email_timestamp_idx"];
const protectedIndex = "heartbeats_school_device_student_timestamp_idx";
const layouts: Record<string, string[]> = {
  heartbeats_student_id_idx: ["student_id"], heartbeats_student_email_idx: ["student_email"],
  heartbeats_student_timestamp_idx: ["student_id", "timestamp"], heartbeats_email_timestamp_idx: ["student_email", "timestamp"],
};

function catalogRow(name: string, oid: string): Record<string, unknown> {
  const columns = layouts[name]; assert.ok(columns);
  return {
    index_name: name, index_schema: "public", index_oid: oid, relation_kind: "i", table_kind: "r",
    table_schema: "public", table_name: "heartbeats", table_oid: "41", expected_table_oid: "41",
    access_method: "btree", index_definition: `CREATE INDEX ${name} ON public.heartbeats USING btree (${columns.map(value => value === "timestamp" ? '"timestamp"' : value).join(", ")})`,
    indislive: true, indisready: true, indisvalid: true, indisunique: false, indisprimary: false, indisexclusion: false,
    is_constraint_owned: false, is_plain: true, key_count: columns.length, total_column_count: columns.length,
    key_columns: [...columns], key_types: columns.map(value => value === "timestamp" ? "timestamp without time zone" : "text"),
    key_opclasses: columns.map(value => value === "timestamp" ? "pg_catalog.timestamp_ops" : "pg_catalog.text_ops"),
    key_default_opclasses: columns.map(() => true), key_default_collations: columns.map(() => true), key_options: columns.map(() => 0),
  };
}

class FakeCatalog implements Executor {
  readonly states = new Map<string, Record<string, unknown>>();
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];
  readonly drops: string[] = [];
  readonly dropSettings: Array<{ statement: string; lock: string }> = [];
  statementTimeout = "15s";
  lockTimeout = "0";
  lockHeld = false;
  acquired = true;
  released = true;
  catalogReads = 0;
  beforeCatalog?: (count: number) => void;
  fail?: (text: string, values?: unknown[]) => Error | undefined;

  constructor() {
    [...candidates, ...replacements].forEach((name, index) => this.states.set(name, catalogRow(name, String(100 + index))));
    this.states.set(protectedIndex, { index_name: protectedIndex, protected: true });
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push({ text: sql, values });
    const failure = this.fail?.(sql, values); if (failure) throw failure;
    if (sql === "SHOW statement_timeout") return { rows: [{ statement_timeout: this.statementTimeout }] };
    if (sql === "SHOW lock_timeout") return { rows: [{ lock_timeout: this.lockTimeout }] };
    if (sql.startsWith("SELECT pg_try_advisory_lock")) { this.lockHeld = this.acquired; return { rows: [{ acquired: this.acquired }] }; }
    if (sql.startsWith("SELECT pg_advisory_unlock")) { if (this.released) this.lockHeld = false; return { rows: [{ released: this.released }] }; }
    if (sql.startsWith("SELECT set_config('statement_timeout'")) { this.statementTimeout = String(values?.[0]); return { rows: [] }; }
    if (sql.startsWith("SELECT set_config('lock_timeout'")) { this.lockTimeout = String(values?.[0]); return { rows: [] }; }
    if (sql.includes("heartbeat_prefix_index_retirement_v1_catalog")) {
      this.beforeCatalog?.(++this.catalogReads);
      const names = values?.[0]; assert.ok(Array.isArray(names));
      return { rows: [...this.states.entries()].filter(([name]) => names.includes(name)).map(([, row]) => structuredClone(row)) };
    }
    const drop = /^DROP INDEX CONCURRENTLY IF EXISTS public\.([a-z0-9_]+)$/.exec(sql);
    if (drop?.[1]) {
      this.dropSettings.push({ statement: this.statementTimeout, lock: this.lockTimeout });
      this.drops.push(drop[1]); this.states.delete(drop[1]); return { rows: [] };
    }
    throw new Error(`Unexpected fake query: ${sql}`);
  }
}

function restored(client: FakeCatalog) {
  assert.equal(client.statementTimeout, "15s"); assert.equal(client.lockTimeout, "0"); assert.equal(client.lockHeld, false);
}

test("retires only both covered single-column indexes and leaves every access-path replacement intact", async () => {
  const client = new FakeCatalog();
  await retire(client);
  assert.deepEqual(client.drops, candidates);
  for (const name of [...replacements, protectedIndex]) assert.ok(client.states.has(name));
  for (const name of candidates) assert.equal(client.states.has(name), false);
  assert.ok(client.dropSettings.every(value => value.statement !== "0" && value.lock !== "0"));
  assert.ok(client.statements.every(value => !/^(BEGIN|COMMIT|UPDATE|DELETE|ALTER TABLE|DROP TABLE)/i.test(value.text)));
  restored(client);
  await retire(client);
  assert.deepEqual(client.drops, candidates, "a repeat with valid replacements performs no additional DDL");
  restored(client);
});

test("validates both replacement access paths even if candidates are already absent", async () => {
  for (const name of replacements) {
    const client = new FakeCatalog(); candidates.forEach(candidate => client.states.delete(candidate)); client.states.delete(name);
    await assert.rejects(retire(client), /replacement|missing/i);
    assert.deepEqual(client.drops, []); restored(client);
  }
});

const malformed: Array<[string, Record<string, unknown>]> = [
  ["different table", { table_name: "another_table" }], ["different table namespace", { table_schema: "private" }],
  ["different table identity", { table_oid: "42" }], ["partitioned table", { table_kind: "p" }],
  ["same-named table", { relation_kind: "r" }], ["same-named view", { relation_kind: "v" }],
  ["partitioned index", { relation_kind: "I" }], ["different namespace", { index_schema: "private" }],
  ["unique", { indisunique: true }], ["primary", { indisprimary: true }], ["exclusion", { indisexclusion: true }],
  ["constraint owned", { is_constraint_owned: true }], ["expression or predicate", { is_plain: false }],
  ["different access method", { access_method: "hash" }], ["INCLUDE", { total_column_count: 3 }],
  ["wrong key count", { key_count: 3 }], ["wrong key order", { key_columns: ["timestamp", "student_id"] }],
  ["nondefault opclass", { key_default_opclasses: [false, true] }],
  ["different opclass", { key_opclasses: ["pg_catalog.text_pattern_ops", "pg_catalog.timestamp_ops"] }],
  ["different collation", { key_default_collations: [false, true] }], ["DESC", { key_options: [1, 0] }],
  ["NULLS FIRST", { key_options: [2, 0] }], ["wrong type", { key_types: ["character varying", "timestamp without time zone"] }],
  ["contradictory definition", { index_definition: "CREATE INDEX wrong ON public.heartbeats USING btree (student_id) WHERE student_id IS NOT NULL" }],
];

for (const [label, change] of malformed) {
  test(`refuses ${label} in a replacement before any candidate drop`, async () => {
    const client = new FakeCatalog(), name = replacements[1]!;
    client.states.set(name, { ...client.states.get(name), ...change });
    await assert.rejects(retire(client)); assert.deepEqual(client.drops, []); restored(client);
  });
  test(`refuses ${label} in the second candidate before dropping the first`, async () => {
    const client = new FakeCatalog(), name = candidates[1]!;
    client.states.set(name, { ...client.states.get(name), ...change });
    await assert.rejects(retire(client)); assert.deepEqual(client.drops, []); restored(client);
  });
}

for (const property of ["indislive", "indisready", "indisvalid"]) {
  test(`requires ${property} on every replacement`, async () => {
    const client = new FakeCatalog(), name = replacements[1]!;
    client.states.set(name, { ...client.states.get(name), [property]: false });
    await assert.rejects(retire(client)); assert.deepEqual(client.drops, []); restored(client);
  });
}

test("an interrupted concurrent DROP can resume only for the same exact expendable index", async () => {
  const client = new FakeCatalog(), cancellation = new Error("synthetic DROP timeout");
  client.fail = sql => {
    if (!sql.startsWith("DROP INDEX")) return;
    const row = client.states.get(candidates[0]!); assert.ok(row);
    Object.assign(row, { indisvalid: false, indisready: false, indislive: false });
    return cancellation;
  };
  await assert.rejects(retire(client), error => error === cancellation);
  restored(client); client.fail = undefined;
  await retire(client);
  assert.deepEqual(client.drops, candidates); restored(client);
});

test("stops on an index identity change after preflight", async () => {
  const client = new FakeCatalog();
  client.beforeCatalog = count => {
    if (count === 2) { const row = client.states.get(candidates[0]!); assert.ok(row); row.index_oid = "999"; }
  };
  await assert.rejects(retire(client), /identity|changed/i);
  assert.deepEqual(client.drops, []); restored(client);
});

test("missing or duplicate catalog rows fail closed", async () => {
  const client = new FakeCatalog();
  client.states.set("catalog-duplicate", { ...client.states.get(replacements[0]!), index_name: replacements[0] });
  const original = client.query.bind(client);
  client.query = async (text, values) => {
    const result = await original(text, values);
    if (text.includes("heartbeat_prefix_index_retirement_v1_catalog")) result.rows.push(catalogRow(replacements[0]!, "777"));
    return result;
  };
  await assert.rejects(retire(client), /duplicate|catalog/i); assert.deepEqual(client.drops, []); restored(client);
});

test("advisory contention cannot start catalog or DDL work", async () => {
  const client = new FakeCatalog(); client.acquired = false;
  await assert.rejects(retire(client), /running|lock/i);
  assert.deepEqual(client.drops, []); assert.equal(client.catalogReads, 0); restored(client);
});

test("catalog failure preserves its identity while restoring both timeouts and the lock", async () => {
  const client = new FakeCatalog(), failure = new Error("synthetic catalog failure");
  client.fail = sql => sql.includes("heartbeat_prefix_index_retirement_v1_catalog") ? failure : undefined;
  await assert.rejects(retire(client), error => error === failure);
  assert.deepEqual(client.drops, []); restored(client);
});

test("cleanup failure rejects an otherwise completed retirement and still attempts the other cleanup", async () => {
  const client = new FakeCatalog(), failure = new Error("synthetic lock timeout restore failure");
  client.fail = (sql, values) => sql.startsWith("SELECT set_config('lock_timeout'") && values?.[0] === "0" ? failure : undefined;
  await assert.rejects(retire(client), /restore|cleanup/i);
  assert.deepEqual(client.drops, candidates); assert.equal(client.statementTimeout, "15s"); assert.equal(client.lockHeld, false);
});

test("a failed timeout capture cannot modify indexes or session settings", async () => {
  const client = new FakeCatalog(), failure = new Error("synthetic capture failure");
  client.fail = sql => sql === "SHOW lock_timeout" ? failure : undefined;
  await assert.rejects(retire(client), error => error === failure);
  assert.deepEqual(client.drops, []); restored(client);
  assert.ok(client.statements.every(value => !value.text.startsWith("SELECT set_config")));
});

for (const outcome of ["success", "cleanup failure", "primary and cleanup failure"] as const) {
  test(`the real ledger ${outcome === "success" ? "reuses a clean" : "discards an unsafe"} retirement session after ${outcome}`, async t => {
    const catalog = new FakeCatalog(), primary = new Error("synthetic catalog failure");
    let destroyed: boolean | undefined, connections = 0, status: string | undefined;
    if (outcome !== "success") catalog.released = false;
    if (outcome === "primary and cleanup failure") {
      catalog.fail = sql => sql.includes("heartbeat_prefix_index_retirement_v1_catalog") ? primary : undefined;
      t.mock.method(console, "error", () => {});
    }
    const pool: Pool = Object.assign(Object.create(Pool.prototype), {
      query: async (sql: string) => {
        if (sql.includes("SET status = 'failed'")) status = "failed";
        if (sql.includes("SET status = 'complete'")) status = "complete";
        return {rows: []};
      },
      connect: async () => ++connections === 1
        ? {query: async () => ({rows: []}), release: () => {}}
        : {query: catalog.query.bind(catalog), release: (error?: Error | boolean) => {destroyed = Boolean(error);}},
    });
    const run = () => runSchoolPilotMigrationLedger({pool, migrations: [heartbeatPrefixIndexRetirementMigration]});
    if (outcome === "success") {
      assert.equal((await run())[0]?.status, "applied");
      assert.equal(destroyed, false); assert.equal(status, "complete"); restored(catalog);
    } else {
      await assert.rejects(run, error => outcome === "primary and cleanup failure" ? error === primary : error instanceof AggregateError);
      assert.equal(destroyed, true, "an unsafe session must be removed from the pool rather than reused");
      assert.equal(status, "failed");
    }
  });
}
