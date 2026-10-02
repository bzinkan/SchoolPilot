import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../src/schema/index.js";
import { resolveClasspilotEntitlement, assertClasspilotEntitled } from "../src/services/classpilotEntitlement.js";

const schoolId = randomUUID(), otherSchoolId = randomUUID();
const queries: string[] = [];
let admin: pg.Pool;
const native = (connection: pg.Pool | pg.PoolClient) => drizzle(connection, {
  schema, logger: { logQuery: query => { queries.push(query); } },
});

before(async () => {
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(process.env.ADMIN_DATABASE_URL || "").hostname));
  admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 4 });
  await admin.query("INSERT INTO schools(id,name,domain,status,is_active,plan_status) VALUES($1,'Uncached entitlement',$2,'active',true,'active'),($3,'Foreign entitlement',$4,'active',true,'active')",
    [schoolId, `${schoolId}.example.test`, otherSchoolId, `${otherSchoolId}.example.test`]);
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active'),($2,'CLASSPILOT','active')", [schoolId, otherSchoolId]);
});
beforeEach(async () => {
  await admin.query("UPDATE schools SET status='active',is_active=true,plan_status='active',active_until=NULL,disabled_at=NULL,deleted_at=NULL WHERE id=$1", [schoolId]);
  await admin.query("UPDATE product_licenses SET status='active',expires_at=NULL WHERE school_id=$1", [schoolId]);
  queries.length = 0;
});
after(async () => {
  const storage = await import("../src/services/storage.js");
  // Retire only these owned roots through the canonical lifecycle. Retention
  // remains intact even when the external helper keeps its isolated database.
  for (const id of [schoolId, otherSchoolId]) await storage.softDeleteSchool(id);
  await admin?.end();
  const pools = await import("../src/db.js");
  const scheduler = await import("../src/services/schedulerDb.js");
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  await Promise.all([pools.pool.end(), pools.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});

test("unlocked uncached entitlement uses one native statement and sees the next license revocation", async () => {
  assert.deepEqual(await resolveClasspilotEntitlement(schoolId, native(admin)), { schoolId, entitled: true, reason: "active" });
  assert.equal(queries.length, 1); assert.match(queries[0]!, /EXISTS/); assert.match(queries[0]!, /clock_timestamp\(\)/);
  assert.doesNotMatch(queries[0]!, /for share/i);
  await admin.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1", [schoolId]);
  assert.deepEqual(await resolveClasspilotEntitlement(schoolId, native(admin)), { schoolId, entitled: false, reason: "license_inactive" });
  assert.equal(queries.length, 2, "No process cache may retain the grant");
  await assert.rejects(assertClasspilotEntitled(schoolId, native(admin)), error =>
    error instanceof Error && "code" in error && error.code === "CLASSPILOT_NOT_ENTITLED"
    && "status" in error && error.status === 403 && "reason" in error && error.reason === "license_inactive");
});

test("the one-statement native path preserves missing, inactive and database-clock expiry decisions", async t => {
  const cases = [
    ["suspended", "UPDATE schools SET status='suspended' WHERE id=$1", "school_inactive"],
    ["inactive", "UPDATE schools SET is_active=false WHERE id=$1", "school_inactive"],
    ["canceled", "UPDATE schools SET plan_status='canceled' WHERE id=$1", "school_inactive"],
    ["disabled", "UPDATE schools SET disabled_at=now() WHERE id=$1", "school_inactive"],
    ["deleted", "UPDATE schools SET deleted_at=now() WHERE id=$1", "school_inactive"],
    ["school expired", "UPDATE schools SET active_until=now()-interval '1 second' WHERE id=$1", "school_inactive"],
    ["license inactive", "UPDATE product_licenses SET status='inactive' WHERE school_id=$1", "license_inactive"],
    ["license expired", "UPDATE product_licenses SET expires_at=clock_timestamp()-interval '1 second' WHERE school_id=$1", "license_inactive"],
  ] as const;
  for (const [name, statement, reason] of cases) await t.test(name, async () => {
    await admin.query(statement, [schoolId]); queries.length = 0;
    assert.deepEqual(await resolveClasspilotEntitlement(schoolId, native(admin)), { schoolId, entitled: false, reason });
    assert.equal(queries.length, 1);
    await admin.query("UPDATE schools SET status='active',is_active=true,plan_status='active',active_until=NULL,disabled_at=NULL,deleted_at=NULL WHERE id=$1", [schoolId]);
    await admin.query("UPDATE product_licenses SET status='active',expires_at=NULL WHERE school_id=$1", [schoolId]);
  });
  const missing = randomUUID(); queries.length = 0;
  assert.deepEqual(await resolveClasspilotEntitlement(missing, native(admin)), { schoolId: missing, entitled: false, reason: "school_missing" });
  assert.equal(queries.length, 1);
  await admin.query("DELETE FROM product_licenses WHERE school_id=$1", [schoolId]);
  assert.deepEqual(await resolveClasspilotEntitlement(schoolId, native(admin)), { schoolId, entitled: false, reason: "license_inactive" },
    "Another school's active license cannot grant this school");
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
});

test("locked native entitlement retains school, bridge, and fresh license order", async () => {
  const reader = await admin.connect();
  try {
    await reader.query("BEGIN");
    const outcome = await resolveClasspilotEntitlement(schoolId, native(reader), { lock: true, afterSchoolLockBeforeLicense: async () => {
      assert.equal(queries.length, 1); assert.match(queries[0]!, /from "schools"/); assert.match(queries[0]!, /for share/i);
      await admin.query("UPDATE product_licenses SET expires_at=clock_timestamp()-interval '1 second' WHERE school_id=$1", [schoolId]);
    } });
    assert.deepEqual(outcome, { schoolId, entitled: false, reason: "license_inactive" });
    assert.equal(queries.length, 2); assert.match(queries[1]!, /from "product_licenses"/); assert.match(queries[1]!, /for share/i);
    await reader.query("ROLLBACK");
  } finally { await reader.query("ROLLBACK"); reader.release(); }
  await assert.rejects(resolveClasspilotEntitlement(schoolId, native(admin), { afterSchoolLockBeforeLicense: async () => {} }), TypeError);
});

for (const target of ["school", "license"] as const) test(`locked native entitlement observes ${target} revocation after its actual row-lock wait`, async () => {
  const writer = await admin.connect(), reader = await admin.connect();
  let checking: ReturnType<typeof resolveClasspilotEntitlement> | undefined;
  try {
    await writer.query("BEGIN"); await reader.query("BEGIN");
    await writer.query(target === "school" ? "UPDATE schools SET is_active=false WHERE id=$1" : "UPDATE product_licenses SET status='inactive' WHERE school_id=$1", [schoolId]);
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let settled = false; checking = resolveClasspilotEntitlement(schoolId, native(reader), { lock: true });
    checking.then(() => { settled = true; }, () => { settled = true; });
    let blocked = false;
    for (const deadline = Date.now() + 5_000; !settled && Date.now() < deadline;) {
      blocked = (await admin.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [writerPid])).rows.length > 0;
      if (blocked) break; await pause(10);
    }
    assert.equal(blocked, true, "Use the real blocking relation, not a timing-only assertion");
    await writer.query("COMMIT");
    assert.deepEqual(await checking, { schoolId, entitled: false, reason: target === "school" ? "school_inactive" : "license_inactive" });
    await reader.query("COMMIT");
  } finally {
    await writer.query("ROLLBACK"); await Promise.allSettled([checking]); await reader.query("ROLLBACK"); writer.release(); reader.release();
  }
});
