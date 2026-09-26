import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { assertRequiredRlsEnforcement } from "../src/db/rlsEnforcement.js";
import { inspectMyDeskReadiness } from "../src/db/mydeskReadiness.js";
import { policySqlFor, RLS_REVIEWED_ENABLEMENT_REQUESTS } from "../src/db/rlsPolicies.js";
import { runSchoolPilotMigrationLedger, type SchoolPilotMigration } from "../src/db/migrationLedger.js";

const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
const database = `rls_gate_${suffix}`;
const role = `rls_gate_owner_${suffix}`;
const tables = RLS_REVIEWED_ENABLEMENT_REQUESTS.mydeskReconciliation!;
const environment = {
  REQUIRE_RLS_TABLE_ENFORCEMENT: tables.join(","),
  RLS_ENABLED_TABLES: tables.join(","),
  RLS_GUC_ENABLED: "true",
};
let admin: pg.Client;
let pool: pg.Pool;
let databaseCreated = false;
let roleCreated = false;
let applyCount = 0;
const migration: SchoolPilotMigration = {
  id: "test_mydesk_admission",
  checksum: createHash("sha256").update("hermetic My Desk admission fixture v2").digest("hex"),
  mode: "transactional",
  async apply(connection) {
    applyCount += 1;
    for (const table of tables) {
      await connection.query(`CREATE TABLE ${table} (
        id TEXT PRIMARY KEY, school_id TEXT NOT NULL, ${table === "mydesk_import_items" ? "extraction_status" : "status"} TEXT NOT NULL DEFAULT 'ready',
        deleted_at TIMESTAMPTZ, private_body TEXT)`);
      for (const statement of policySqlFor(table)) await connection.query(statement);
      await connection.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    await connection.query(`
      CREATE TABLE readiness_groups (school_id TEXT, id TEXT, PRIMARY KEY (school_id, id));
      CREATE TABLE readiness_students (school_id TEXT, id TEXT, PRIMARY KEY (school_id, id));
      ALTER TABLE mydesk_notes ADD COLUMN group_id TEXT, ADD COLUMN student_id TEXT;
      ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_group_fk
        FOREIGN KEY (school_id, group_id) REFERENCES readiness_groups (school_id, id)
        ON DELETE SET NULL (group_id);
      ALTER TABLE mydesk_notes ADD CONSTRAINT mydesk_notes_student_fk
        FOREIGN KEY (school_id, student_id) REFERENCES readiness_students (school_id, id)
        ON DELETE SET NULL (student_id);
    `);
  },
};

before(async () => {
  const url = new URL(process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname),
    "Hermetic catalog tests may only create a disposable local database");
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
  roleCreated = true;
  await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
  databaseCreated = true;
  url.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 3, options: `-c role=${role}` });
  await runSchoolPilotMigrationLedger({ pool, migrations: [migration] });
});

after(async () => {
  await pool?.end();
  if (databaseCreated) await admin.query(`DROP DATABASE ${database}`);
  if (roleCreated) await admin.query(`DROP ROLE ${role}`);
  await admin?.end();
});

async function changedCatalog(sql: string, check: (connection: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await check(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("the exact six-table admission passes on real forced tenant policies under a restricted owner", async () => {
  await assertRequiredRlsEnforcement(pool, environment);
  assert.equal(applyCount, 1);
});

test("admission fails closed on missing tables, disabled enforcement and missing FORCE", async () => {
  for (const sql of [
    "ALTER TABLE mydesk_notes RENAME TO hidden_notes",
    "ALTER TABLE mydesk_notes DISABLE ROW LEVEL SECURITY",
    "ALTER TABLE mydesk_notes NO FORCE ROW LEVEL SECURITY",
  ]) {
    await changedCatalog(sql, async (client) => {
      await assert.rejects(assertRequiredRlsEnforcement(client, environment), /Required RLS enforcement failed/);
    });
  }
});

test("a policy name alone cannot hide weakened reads, writes, command scope, roles or extra policies", async () => {
  for (const sql of [
    "DROP POLICY tenant_isolation ON mydesk_notes",
    "ALTER POLICY tenant_isolation ON mydesk_notes USING (true)",
    "ALTER POLICY tenant_isolation ON mydesk_notes WITH CHECK (true)",
    `ALTER POLICY tenant_isolation ON mydesk_notes TO ${role}`,
    "CREATE POLICY extra_access ON mydesk_notes USING (true) WITH CHECK (true)",
    "CREATE POLICY unexpected_restriction ON mydesk_notes AS RESTRICTIVE USING (true)",
    "DROP POLICY tenant_isolation ON mydesk_notes; CREATE POLICY tenant_isolation ON mydesk_notes FOR SELECT USING (school_id = current_setting('app.school_id', true) OR current_setting('app.is_super', true) = 'on')",
  ]) {
    await changedCatalog(sql, async (client) => {
      await assert.rejects(assertRequiredRlsEnforcement(client, environment), /Required RLS enforcement failed/);
    });
  }
});

test("a completed ledger is skipped but later admission still rejects catalog drift without rewriting data", async () => {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.is_super', 'on', false)");
    await client.query("INSERT INTO mydesk_notes(id,school_id,private_body) VALUES ('retained','school','private sentinel')");
    await client.query("ALTER TABLE mydesk_notes DISABLE ROW LEVEL SECURITY");
    const results = await runSchoolPilotMigrationLedger({ pool, migrations: [migration] });
    assert.equal(results[0]?.status, "skipped");
    assert.equal(applyCount, 1);
    await assert.rejects(assertRequiredRlsEnforcement(pool, environment), /Required RLS enforcement failed/);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM mydesk_notes WHERE id='retained'")).rows[0].n, 1);
    assert.equal((await client.query("SELECT checksum FROM schema_migrations WHERE id=$1", [migration.id])).rows[0].checksum, migration.checksum);
  } finally {
    await client.query("ALTER TABLE mydesk_notes ENABLE ROW LEVEL SECURITY");
    await client.query("SELECT set_config('app.is_super', '', false)");
    client.release();
  }
});

test("required admissions reject bypass roles, mode/allowlist drift and malformed bundles", async () => {
  await admin.query(`ALTER ROLE ${role} BYPASSRLS`);
  try {
    await assert.rejects(assertRequiredRlsEnforcement(pool, environment), /Required RLS enforcement failed/);
  } finally {
    await admin.query(`ALTER ROLE ${role} NOBYPASSRLS`);
  }
  for (const override of [
    { RLS_GUC_ENABLED: "false" },
    { RLS_ENABLED_TABLES: tables.slice(0, 5).join(",") },
    { REQUIRE_RLS_TABLE_ENFORCEMENT: [...tables].reverse().join(",") },
    { REQUIRE_RLS_TABLE_ENFORCEMENT: `${tables.join(",")},` },
    { REQUIRE_RLS_TABLE_ENFORCEMENT: `${tables.join(",")},mydesk_notes` },
  ]) {
    await assert.rejects(assertRequiredRlsEnforcement(pool, { ...environment, ...override }), /RLS enforcement/);
  }
  await assertRequiredRlsEnforcement(pool, {});
});

test("only explicit non-production bootstrap permits administrator roles and still verifies policies", async () => {
  const client = await pool.connect();
  try {
    // RESET ROLE returns to the connection's startup -c role option; NONE
    // restores the authenticated administrator used by this local fixture.
    await client.query("SET ROLE NONE");
    const env = { ...environment, NODE_ENV: "test" };
    const bootstrap = { allowNonProductionBootstrapRole: true };
    await assert.rejects(assertRequiredRlsEnforcement(client, env), /Required RLS enforcement failed/);
    await assertRequiredRlsEnforcement(client, env, bootstrap);
    await assert.rejects(assertRequiredRlsEnforcement(client, { ...env, NODE_ENV: "production" }, bootstrap),
      /Required RLS enforcement failed/);
    await assert.rejects(assertRequiredRlsEnforcement(client, { ...env, RLS_GUC_ENABLED: "false" }, bootstrap),
      /Required RLS enforcement failed/);
    await client.query("BEGIN");
    await client.query("ALTER TABLE mydesk_notes NO FORCE ROW LEVEL SECURITY");
    await assert.rejects(assertRequiredRlsEnforcement(client, env, bootstrap), /Required RLS enforcement failed/);
  } finally {
    await client.query("ROLLBACK");
    await client.query(`SET ROLE ${role}`);
    client.release();
  }
});

test("read-only inventory exposes aggregate state and catalog metadata without private content or changes", async () => {
  const client = await pool.connect();
  try {
    const report = await inspectMyDeskReadiness(client);
    assert.equal(report.mode, "read_only_inventory");
    assert.equal(report.requiresConstraintReview, true);
    assert.ok(report.tables.every((table) => table.canonicalPolicy));
    assert.equal(report.tables.find((table) => table.name === "mydesk_notes")?.counts?.total, "1");
    assert.ok(report.ledger.every((entry) => entry.status === "missing"));
    assert.equal(JSON.stringify(report).includes("private sentinel"), false);
    assert.equal(JSON.stringify(report).includes("retained"), false);
    assert.ok(report.indexes.every((index) => /^[a-f0-9]{64}$/.test(index.definitionSha256)));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, 1);
    assert.notEqual((await client.query("SELECT current_setting('app.is_super', true) AS setting")).rows[0].setting, "on",
      "Cross-school inspection scope must end with the read-only transaction");
  } finally {
    client.release();
  }
});

test("catalog delete-column metadata contains JSON arrays with exact column-specific SET NULL targets", async () => {
  const client = await pool.connect();
  try {
    const report = await inspectMyDeskReadiness(client);
    for (const constraint of report.constraints) {
      assert.ok(Array.isArray(constraint.deleteColumns),
        `${constraint.name} must have an array instead of an unparsed PostgreSQL name[] string`);
    }
    const group = report.constraints.find((constraint) => constraint.name === "mydesk_notes_group_fk");
    const student = report.constraints.find((constraint) => constraint.name === "mydesk_notes_student_fk");
    assert.equal(group?.deleteAction, "n");
    assert.deepEqual(group?.deleteColumns, ["group_id"]);
    assert.equal(student?.deleteAction, "n");
    assert.deepEqual(student?.deleteColumns, ["student_id"]);
    assert.deepEqual(report.constraints.find((constraint) => constraint.name === "mydesk_notes_pkey")?.deleteColumns, []);
  } finally {
    client.release();
  }
});
