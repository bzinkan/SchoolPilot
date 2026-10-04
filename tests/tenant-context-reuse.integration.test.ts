import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

test("physical client metadata reuse preserves fresh school authority, RLS and transaction boundaries", async (t) => {
  const url = process.env.DATABASE_URL;
  assert.ok(url);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Native fixture must be local");
  process.env.NODE_ENV = "test";
  process.env.SCHEDULER_ENABLED = "false";
  process.env.DB_POOL_MAX = "1";
  process.env.RLS_GUC_ENABLED = "true";
  const { db, pool, sessionPool } = await import("../src/db.js");
  const { getTenantStore } = await import("../src/db/tenantContext.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const stores: NonNullable<ReturnType<typeof getTenantStore>>[] = [];
  const initial = await pool.connect();
  let initialReleased = false;
  try {
    const role = (await initial.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
    )).rows[0]!;
    const restricted = !role.rolsuper && !role.rolbypassrls;
    t.diagnostic(restricted ? "Restricted-role RLS enforcement" : "Owner connection plumbing; RLS enforcement verified separately");
    await initial.query("CREATE TEMP TABLE tenant_metadata_fixture (school_id text PRIMARY KEY, value integer NOT NULL)");
    await initial.query("INSERT INTO tenant_metadata_fixture VALUES ('school-A',1),('school-B',2)");
    await initial.query("ALTER TABLE tenant_metadata_fixture ENABLE ROW LEVEL SECURITY");
    await initial.query("ALTER TABLE tenant_metadata_fixture FORCE ROW LEVEL SECURITY");
    await initial.query("CREATE POLICY tenant_scope ON tenant_metadata_fixture USING (school_id=current_setting('app.school_id',true) OR current_setting('app.is_super',true)='on')");
    initial.release();
    initialReleased = true;

    for (const [schoolId, superAccess, expectedValue] of [["school-A", true, 1], ["school-B", false, 2]] as const) {
      await runWithTenantContext({ schoolId, isSuper: superAccess }, async () => {
        const store = getTenantStore();
        assert.ok(store);
        stores.push(store);
        assert.equal(store.client, initial, "the one-client pool must reuse the same physical connection");
        assert.equal(store.schoolId, schoolId);
        assert.equal(store.isSuper, superAccess);
        const guc = await db.execute(sql`SELECT current_setting('app.school_id') AS school, current_setting('app.is_super') AS super`);
        assert.deepEqual(guc.rows, [{ school: schoolId, super: superAccess ? "on" : "off" }]);
        const current = await db.execute(sql`SELECT value FROM tenant_metadata_fixture WHERE school_id=${schoolId}`);
        assert.deepEqual(current.rows, [{ value: expectedValue }]);
        if (restricted && !superAccess) {
          assert.deepEqual((await db.execute(sql`SELECT school_id FROM tenant_metadata_fixture`)).rows, [{ school_id: "school-B" }]);
        }
        if (schoolId === "school-A") {
          await db.execute(sql`UPDATE tenant_metadata_fixture SET value=9 WHERE school_id='school-B'`);
          await assert.rejects(db.transaction(async tx => {
            await tx.execute(sql`UPDATE tenant_metadata_fixture SET value=7 WHERE school_id='school-B'`);
            throw new Error("fixture rollback");
          }), /fixture rollback/);
          // A new read, including after a rolled-back transaction, sees real
          // committed state rather than retaining a query result or transaction.
          assert.deepEqual((await db.execute(sql`SELECT value FROM tenant_metadata_fixture WHERE school_id='school-B'`)).rows, [{ value: 9 }]);
          await db.execute(sql`UPDATE tenant_metadata_fixture SET value=2 WHERE school_id='school-B'`);
        }
      });
      assert.equal(getTenantStore(), undefined);
      const unbound = await pool.query("SELECT current_setting('app.school_id',true) AS school, current_setting('app.is_super',true) AS super");
      assert.deepEqual(unbound.rows, [{ school: "", super: "off" }]);
      if (restricted) assert.equal((await pool.query("SELECT * FROM tenant_metadata_fixture")).rowCount, 0);
    }
    assert.notEqual(stores[0], stores[1]);
    assert.equal(stores[0]!.db, stores[1]!.db, "ORM metadata alone survives release/reacquisition");
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.totalCount, pool.idleCount);
  } finally {
    // If setup failed before release, end the one owned connection without
    // waiting for a second pool checkout. The fixture table is connection-local.
    if (!initialReleased) initial.release();
    await drainTenantContextReleases();
    await Promise.all([pool.end(), sessionPool.end()]);
  }
});
