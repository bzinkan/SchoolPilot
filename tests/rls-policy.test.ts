import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Validates the EXACT RLS policy SQL the app emits (imported from the compiled
// rlsPolicies module) against a standalone probe table — proving deny-by-default,
// per-school scoping, the super-admin bypass, and WITH CHECK on writes.
//
// CI connects as the `postgres` SUPERUSER, which always bypasses RLS. So the
// probe table is owned by a dedicated NON-superuser role and every assertion runs
// under SET ROLE to that role. With FORCE ROW LEVEL SECURITY this mirrors prod
// exactly: a non-superuser app role that owns its own tables and is therefore
// subject to its policies. A standalone table (not an app table) keeps the test
// hermetic and leaves the app schema untouched for the cross-tenant suite.
import { RLS_POLICY_NAME, policySqlFor } from "../dist/db/rlsPolicies.js";
import { pool } from "../dist/db.js";

const PROBE = "rls_probe";
const ROLE = "rls_probe_owner";
let client: any;

async function rowCount(): Promise<number> {
  const r = await client.query(`SELECT count(*)::int AS n FROM ${PROBE}`);
  return r.rows[0].n;
}

before(async () => {
  client = await pool.connect();
  await client.query(`DROP TABLE IF EXISTS ${PROBE}`);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} NOSUPERUSER NOLOGIN;
      END IF;
    END $$;
  `);
  await client.query(`CREATE TABLE ${PROBE} (id serial PRIMARY KEY, school_id text, val text)`);
  // Owned by the non-superuser role → FORCE RLS subjects it to the policy.
  await client.query(`ALTER TABLE ${PROBE} OWNER TO ${ROLE}`);
  for (const stmt of policySqlFor(PROBE)) await client.query(stmt);
  await client.query(`ALTER TABLE ${PROBE} ENABLE ROW LEVEL SECURITY`);
  // Seed as the superuser (bypasses RLS) so both schools have rows.
  await client.query(`INSERT INTO ${PROBE} (school_id, val) VALUES ('A','a1'),('A','a2'),('B','b1')`);
});

after(async () => {
  try {
    await client.query("RESET ROLE");
    await client.query(`DROP TABLE IF EXISTS ${PROBE}`);
    await client.query(`DROP ROLE IF EXISTS ${ROLE}`);
  } catch {
    /* ignore */
  }
  client.release();
  await pool.end();
});

describe("RLS tenant-isolation policy (deny-by-default)", () => {
  it("the tenant_isolation policy exists on the probe table", async () => {
    const r = await client.query(
      `SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = $2`,
      [PROBE, RLS_POLICY_NAME],
    );
    assert.equal(r.rowCount, 1);
  });

  it("no GUC set → zero rows (deny-by-default)", async () => {
    await client.query(`SET ROLE ${ROLE}`);
    try {
      await client.query("SELECT set_config('app.school_id','',false)");
      await client.query("SELECT set_config('app.is_super','',false)");
      assert.equal(await rowCount(), 0);
    } finally {
      await client.query("RESET ROLE");
    }
  });

  it("app.school_id = A → only A's rows; = B → only B's", async () => {
    await client.query(`SET ROLE ${ROLE}`);
    try {
      await client.query("SELECT set_config('app.school_id','A',false)");
      assert.equal(await rowCount(), 2);
      await client.query("SELECT set_config('app.school_id','B',false)");
      assert.equal(await rowCount(), 1);
    } finally {
      await client.query("SELECT set_config('app.school_id','',false)");
      await client.query("RESET ROLE");
    }
  });

  it("app.is_super = on → bypass (all rows visible)", async () => {
    await client.query(`SET ROLE ${ROLE}`);
    try {
      await client.query("SELECT set_config('app.school_id','',false)");
      await client.query("SELECT set_config('app.is_super','on',false)");
      assert.equal(await rowCount(), 3);
    } finally {
      await client.query("SELECT set_config('app.is_super','',false)");
      await client.query("RESET ROLE");
    }
  });

  it("WITH CHECK blocks an INSERT for another school; allows own school", async () => {
    await client.query(`SET ROLE ${ROLE}`);
    try {
      await client.query("SELECT set_config('app.school_id','A',false)");
      await client.query("SELECT set_config('app.is_super','',false)");
      await assert.rejects(
        () => client.query(`INSERT INTO ${PROBE} (school_id, val) VALUES ('B','nope')`),
        /row-level security|policy/i,
      );
      await client.query(`INSERT INTO ${PROBE} (school_id, val) VALUES ('A','yes')`);
      assert.equal(await rowCount(), 3); // a1, a2, yes (B's row hidden)
    } finally {
      await client.query("SELECT set_config('app.school_id','',false)");
      await client.query("RESET ROLE");
    }
  });
});
