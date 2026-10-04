import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { checkHealthDatabaseRoundTrip } from "../src/services/healthDbRoundTrip.js";

test("health sentinel round trip preserves no-CREATE runtime permissions and qualified cleanup", { timeout: 30_000 }, async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "health round-trip integration requires its coordinated local owner fixture");
  const target = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "health proof refuses non-loopback databases");
  assert.ok(target.pathname === "/sptest" || /^\/schoolpilot_health_component_[a-f0-9]{12}$/.test(target.pathname),
    "health proof requires the CI fixture or the exact owned local component namespace");
  const suffix = randomBytes(8).toString("hex");
  const role = `health_probe_${suffix}`, shadow = `health_shadow_${suffix}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Transactional owner-only fixture changes roll back any original sentinel,
    // public ACL and temporary probe role. No application pool is imported.
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query("DROP TABLE IF EXISTS public._health_sentinel");
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    const roleState = async () => {
      const result = await client.query("SELECT rolsuper, rolbypassrls, has_schema_privilege(current_user, 'public', 'CREATE') AS can_create FROM pg_roles WHERE rolname=current_user");
      assert.deepEqual(result.rows, [{ rolsuper: false, rolbypassrls: false, can_create: false }]);
    };
    const count = async () => Number((await client.query("SELECT COUNT(*) AS count FROM public._health_sentinel")).rows[0].count);
    const expectPermissionFailure = async (name: string, operation: () => Promise<unknown>) => {
      await client.query(`SAVEPOINT ${name}`);
      await assert.rejects(operation, (error: unknown) => (error as { code?: string }).code === "42501");
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    };

    await t.test("restricted missing-table bootstrap still fails without granting CREATE", async () => {
      await client.query(`SET LOCAL ROLE ${role}`);
      await roleState();
      await expectPermissionFailure("missing_sentinel", () => checkHealthDatabaseRoundTrip(client));
      assert.equal((await client.query("SELECT to_regclass('public._health_sentinel') AS relation")).rows[0].relation, null);
      await roleState();
      await client.query("RESET ROLE");
    });
    await t.test("owner bootstrap retains the persistent public sentinel and removes its own row", async () => {
      const result = await checkHealthDatabaseRoundTrip(client);
      assert.equal(result.ok, true);
      assert.ok(result.latencyMs >= 0);
      assert.equal((await client.query("SELECT to_regclass('public._health_sentinel')::text AS relation")).rows[0].relation, "_health_sentinel");
      assert.equal(await count(), 0);
      await client.query(`GRANT SELECT,INSERT,DELETE ON public._health_sentinel TO ${role}`);
      await client.query(`GRANT USAGE,SELECT ON SEQUENCE public._health_sentinel_id_seq TO ${role}`);
    });
    await t.test("existing sentinel works without CREATE despite the old IF NOT EXISTS rejection", async () => {
      await client.query(`CREATE SCHEMA ${shadow}`);
      await client.query(`CREATE TABLE ${shadow}._health_sentinel(id integer PRIMARY KEY,created_at timestamptz)`);
      await client.query(`INSERT INTO ${shadow}._health_sentinel VALUES(999,NOW()-INTERVAL '2 hours')`);
      await client.query(`GRANT USAGE ON SCHEMA ${shadow} TO ${role}`);
      await client.query(`SET LOCAL search_path TO ${shadow},pg_catalog`);
      await client.query(`SET LOCAL ROLE ${role}`);
      await roleState();
      // Native PostgreSQL checks namespace CREATE before accepting an existing
      // relation's IF NOT EXISTS. This is the old monitor's failing operation.
      await expectPermissionFailure("old_unconditional_create", () => client.query("CREATE TABLE IF NOT EXISTS public._health_sentinel(id SERIAL PRIMARY KEY,created_at timestamptz DEFAULT NOW())"));
      for (let iteration = 0; iteration < 3; iteration++) assert.equal((await checkHealthDatabaseRoundTrip(client)).ok, true);
      assert.equal(await count(), 0);
      await roleState();
      await client.query("RESET ROLE");
      assert.equal((await client.query(`SELECT COUNT(*)::int AS count FROM ${shadow}._health_sentinel`)).rows[0].count, 1, "public-qualified DML cannot touch a search-path shadow");
    });
    await t.test("round-trip cleanup removes only the probe and old sentinel rows", async () => {
      await client.query("INSERT INTO public._health_sentinel(created_at) VALUES(NOW()-INTERVAL '2 hours'),(NOW())");
      await client.query(`SET LOCAL ROLE ${role}`);
      assert.equal((await checkHealthDatabaseRoundTrip(client)).ok, true);
      assert.equal(await count(), 1);
      await roleState();
      await client.query("RESET ROLE");
      await client.query("DELETE FROM public._health_sentinel");
      assert.equal(await count(), 0);
    });
    await t.test("real DML permission failure remains a health failure", async () => {
      await client.query(`REVOKE INSERT ON public._health_sentinel FROM ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      await expectPermissionFailure("denied_sentinel_insert", () => checkHealthDatabaseRoundTrip(client));
      assert.equal(await count(), 0);
      await roleState();
    });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
