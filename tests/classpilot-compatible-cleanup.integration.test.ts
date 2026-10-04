import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { sql } from "drizzle-orm";

// RLS_SERIAL: actual compatible HTTP cleanup under a restricted runtime role.
// Usage remains off; direct writer/read services seed and inspect retained state.
// In the ordinary DB lane these forced-RLS cases are skipped.
const RLS = process.env.RLS_GUC_ENABLED === "true";
const TABLE = "classpilot_usage_rollups";
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.CLASSPILOT_USAGE_ROLLUP_MODE = "off";
process.env.CLASSPILOT_DIGITAL_USAGE_MODE = "off";
// Test-only single pooled connection proves actual reuse after response closure.
process.env.DB_POOL_MAX = "1";

const TIME_ZONE = "America/New_York";
const TAG = `fallback_cleanup_${Date.now()}`;
let system: pg.Pool | undefined;
let db: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let sessionPool: typeof import("../src/db.js").sessionPool;
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let rollup: typeof import("../src/services/classpilotUsageRollup.js");
let read: typeof import("../src/services/classpilotUsageRead.js");
let schoolTime: typeof import("../src/util/schoolTime.js");
let server: Server | undefined;
let baseUrl = "";

type Tenant = { schoolId: string; adminId: string; adminEmail: string; students: string[] };
const tenants: Tenant[] = [];
const userIds: string[] = [];
let day = "";
let dayStart = 0;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function rejectedByPolicy(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const { message, cause } = current as { message?: unknown; cause?: unknown };
    if (/row-level security|policy/i.test(String(message ?? ""))) return true;
    current = cause;
  }
  return false;
}

function wall(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

async function createTenant(label: string, domain: string): Promise<Tenant> {
  const schoolId = randomUUID(), adminId = randomUUID();
  const adminEmail = `${TAG}-${adminId.slice(0, 8)}@example.test`;
  const run = (text: string, values: unknown[]) => system!.query(text, values);
  await run(`INSERT INTO schools(id, name, status, is_active, plan_status, school_timezone) VALUES ($1, $2, 'active', true, 'active', $3)`, [schoolId, `${TAG} ${label}`, TIME_ZONE]);
  await run("INSERT INTO product_licenses(school_id, product, status) VALUES ($1, 'CLASSPILOT', 'active')", [schoolId]);
  await run(`INSERT INTO settings(school_id, school_name, ws_shared_key, retention_hours, enable_tracking_hours, instructional_calendar)
    VALUES ($1, $2, 'fixture', '720', false, '{}')`, [schoolId, `${TAG} ${label}`]);
  userIds.push(adminId);
  await run("INSERT INTO users(id, email, first_name, last_name) VALUES ($1, $2, 'Rls', 'Usage')", [adminId, adminEmail]);
  await run("INSERT INTO school_memberships(school_id, user_id, role, status) VALUES ($1, $2, 'school_admin', 'active')", [schoolId, adminId]);
  const students: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const id = randomUUID();
    await run("INSERT INTO students(id, school_id, first_name, last_name, status, grade_level) VALUES ($1, $2, $3, 'Student', 'active', '6')", [id, schoolId, `${label}${index}`]);
    students.push(id);
    await run("INSERT INTO devices(device_id,school_id,class_id) VALUES($1,$2,'fixture-class')", [`${TAG}-${schoolId}-${index}`,schoolId]);
    await run("INSERT INTO daily_usage(school_id,student_id,date,total_seconds,heartbeat_count) VALUES($1,$2,$3,100,10)", [schoolId,id,day]);
    // Ten 10-second observations: 9 x 10 s + 15 s for the last one.
    for (let beat = 0; beat < 10; beat += 1) {
      await run(
        `INSERT INTO heartbeats(device_id, student_id, school_id, active_tab_title, active_tab_url, ai_category, timestamp)
         VALUES ($1, $2, $3, 'fixture', $4, 'educational', $5::timestamp)`,
        [`${TAG}-${schoolId}-${index}`, id, schoolId, `https://${domain}/lesson`, wall(dayStart + (10 * 3600 + index * 600 + beat * 10) * 1000)],
      );
    }
  }
  const tenant = { schoolId, adminId, adminEmail, students };
  tenants.push(tenant);
  return tenant;
}

async function readSchools(schoolIds: string[]): Promise<string[]> {
  const ids = sql.join(schoolIds.map((id) => sql`${id}`), sql`, `);
  const result: any = await db.execute(sql`SELECT school_id FROM classpilot_usage_rollups WHERE school_id IN (${ids}) ORDER BY school_id`);
  return [...new Set<string>(result.rows.map((row: { school_id: string }) => row.school_id))];
}

async function rollupDay(schoolId: string) {
  const window = rollup.classpilotUsageRollupDay(day, TIME_ZONE);
  return rollup.rollupClasspilotUsageDay(system!, { schoolId, day: window, windowEndUtc: window.dayEndUtc, exclusions: [] });
}

before(async () => {
  if (!RLS) return;
  // The scheduler pool's session setting (src/services/schedulerDb.ts).
  system = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c app.is_super=on", max: 2 });
  const dbModule = await import("../src/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  ({ runWithTenantContext } = await import("../src/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../src/services/jwt.js"));
  rollup = await import("../src/services/classpilotUsageRollup.js");
  read = await import("../src/services/classpilotUsageRead.js");
  schoolTime = await import("../src/util/schoolTime.js");
  day = schoolTime.addLocalDays(schoolTime.localDateInTimeZone(new Date(), TIME_ZONE), -2);
  dayStart = schoolTime.localDateStartUtc(day, TIME_ZONE).getTime();
  const { createApp } = await import("../src/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  if (!RLS) return;
  try {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    const schoolIds = tenants.map((tenant) => tenant.schoolId);
    // Best effort: once the staff-identity contract is installed, users and
    // schools are retained records that cannot be hard-deleted.
    const bestEffort = (text: string, values: unknown[]) => system!.query(text, values).catch(() => undefined);
    if (system && schoolIds.length) {
      for (const table of ["classpilot_usage_rollup_days", TABLE, "heartbeats", "daily_usage", "devices", "audit_logs", "students", "settings", "school_memberships", "product_licenses"]) {
        await bestEffort(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
      }
      await bestEffort("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
      await bestEffort("DELETE FROM schools WHERE id = ANY($1::text[])", [schoolIds]);
    }
  } finally {
    await system?.end().catch(() => undefined);
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.allSettled([pool?.end(), sessionPool?.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});

describe("Compatible fallback cleanup with Usage off", { skip: RLS ? false : "requires restricted RLS lane" }, () => {

  it("keeps the fallback dark and runs under a forced, non-bypass tenant role", async () => {
    assert.equal(process.env.CLASSPILOT_USAGE_ROLLUP_MODE, "off");
    assert.equal(process.env.CLASSPILOT_DIGITAL_USAGE_MODE, "off");
    const role = await system!.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows, [{ rolsuper: false, rolbypassrls: false }]);
    const forced = await system!.query("SELECT count(*)::int AS count FROM pg_class WHERE relname=ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity", [["heartbeats","audit_logs","classpilot_usage_rollups","classpilot_usage_rollup_days"]]);
    assert.equal(forced.rows[0].count, 4);
  });

  it("rolls every cleanup delete back when the required audit cannot be persisted", async () => {
    const tenant = await createTenant("Audit fail", "audit-fail.example.edu");
    await system!.query("UPDATE school_memberships SET role='admin' WHERE school_id=$1 AND user_id=$2", [tenant.schoolId,tenant.adminId]);
    await rollupDay(tenant.schoolId);
    const tables = ["heartbeats", "daily_usage", "devices", "classpilot_usage_rollups", "classpilot_usage_rollup_days"];
    const beforeRows = await Promise.all(tables.map(async table => (await system!.query(`SELECT * FROM ${table} WHERE school_id=$1 ORDER BY 1`, [tenant.schoolId])).rows));
    const admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 1 });
    const functionName = `${TAG}_audit_fail`, triggerName = `${TAG}_audit_trigger`;
    try {
      await admin.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.school_id='${tenant.schoolId}' AND NEW.action='students.cleanup' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      const response = await fetch(`${baseUrl}/admin/cleanup-students`, { method: "POST", headers: {
        authorization: `Bearer ${signUserToken({ userId:tenant.adminId,email:tenant.adminEmail,isSuperAdmin:false })}`, "x-school-id":tenant.schoolId,
      } });
      assert.equal(response.status, 500, await response.text());
      const afterRows = await Promise.all(tables.map(async table => (await system!.query(`SELECT * FROM ${table} WHERE school_id=$1 ORDER BY 1`, [tenant.schoolId])).rows));
      assert.deepEqual(afterRows, beforeRows, "raw input, aggregates and coverage all survive a failed audit");
      assert.equal((await system!.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='students.cleanup'", [tenant.schoolId])).rows[0].count, 0);
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_logs`);
      await admin.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await admin.end();
    }
  });
  it("cleanup removes only its authorized school's inputs and coverage with an atomic audit", async () => {
    const a = await createTenant("Cleanup C", "c.example.edu"), b = await createTenant("Cleanup D", "d.example.edu");
    await rollupDay(a.schoolId); await rollupDay(b.schoolId);
    // Cleanup's established authority is the legacy admin role, not school_admin.
    await system!.query("UPDATE school_memberships SET role='admin' WHERE school_id=$1 AND user_id=$2", [a.schoolId, a.adminId]);
    const foreign = (await system!.query("SELECT id,ctid::text,xmin::text,computed_at FROM classpilot_usage_rollups WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows;
    const foreignCoverage = (await system!.query("SELECT * FROM classpilot_usage_rollup_days WHERE school_id=$1", [b.schoolId])).rows;
    const foreignDevices = (await system!.query("SELECT * FROM devices WHERE school_id=$1 ORDER BY device_id", [b.schoolId])).rows;
    const foreignDaily = (await system!.query("SELECT * FROM daily_usage WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows;
    const response = await fetch(`${baseUrl}/admin/cleanup-students`, { method: "POST", headers: {
      authorization: `Bearer ${signUserToken({ userId: a.adminId, email: a.adminEmail, isSuperAdmin: false })}`,
      "x-school-id": a.schoolId,
    } });
    assert.equal(response.status, 200, await response.text());
    const own = await inSchool(a.schoolId, () => read.getClasspilotDigitalUsage({ schoolId: a.schoolId, scope: "school", id: null, from: day, to: day }));
    assert.equal(own.dataState, "unavailable"); assert.deepEqual(own.byDay, []); assert.deepEqual(own.range.unavailableDates, [day]);
    assert.equal((await system!.query("SELECT 1 FROM heartbeats WHERE school_id=$1", [a.schoolId])).rowCount, 0);
    assert.equal((await system!.query("SELECT 1 FROM devices WHERE school_id=$1", [a.schoolId])).rowCount, 0);
    assert.equal((await system!.query("SELECT 1 FROM daily_usage WHERE school_id=$1", [a.schoolId])).rowCount, 0);
    assert.equal((await system!.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='students.cleanup'", [a.schoolId])).rows[0].count, 1);
    assert.deepEqual((await system!.query("SELECT id,ctid::text,xmin::text,computed_at FROM classpilot_usage_rollups WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows, foreign);
    assert.deepEqual((await system!.query("SELECT * FROM classpilot_usage_rollup_days WHERE school_id=$1", [b.schoolId])).rows, foreignCoverage);
    assert.deepEqual((await system!.query("SELECT * FROM devices WHERE school_id=$1 ORDER BY device_id", [b.schoolId])).rows, foreignDevices);
    assert.deepEqual((await system!.query("SELECT * FROM daily_usage WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows, foreignDaily);
    assert.equal((await system!.query("SELECT count(*)::int AS count FROM heartbeats WHERE school_id=$1", [b.schoolId])).rows[0].count, 20);
  });

  for (const blockedOn of ["school advisory lock", "raw-input row lock"]) {
  it(`holds an aborted cleanup at ${blockedOn} through commit before second-school pooled reuse`, async () => {
    const a = await createTenant("Abort C", "abort-c.example.edu"), b = await createTenant("Abort D", "abort-d.example.edu");
    await system!.query("UPDATE school_memberships SET role='admin' WHERE school_id=$1 AND user_id=$2", [a.schoolId, a.adminId]);
    await rollupDay(a.schoolId); await rollupDay(b.schoolId);
    const foreign = (await system!.query("SELECT * FROM classpilot_usage_rollups WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows;
    const blocker = await system!.connect();
    const trace: Array<{ kind: "query" | "release"; statement?: string }> = [];
    let observed: pg.PoolClient | undefined;
    let originalQuery: pg.PoolClient["query"] | undefined;
    const acquire = (client: pg.PoolClient) => {
      if (observed) { assert.equal(client, observed, "the second school must reuse the actual cleanup connection"); return; }
      observed = client; originalQuery = client.query;
      Object.defineProperty(client, "query", { configurable: true, writable: true, value: function (...args: unknown[]) {
        const first = args[0];
        const statement = typeof first === "string" ? first : first && typeof first === "object" && "text" in first ? String(first.text) : "";
        const pending: unknown = Reflect.apply(originalQuery!, client, args);
        if (pending && typeof pending === "object" && "then" in pending && typeof pending.then === "function") {
          return Promise.resolve(pending).then(result => { trace.push({ kind: "query", statement }); return result; });
        }
        // pool.query uses the callback overload, whose undefined return must
        // remain untouched. The transaction statements use Promise queries.
        return pending;
      } });
    };
    const released = (_error: Error | undefined, client: pg.PoolClient) => {
      if (client === observed) trace.push({ kind: "release" });
    };
    let closed!: () => void;
    const responseClosed = new Promise<void>(resolve => { closed = resolve; });
    const observeRequest = (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
      // Express may already have stripped the mount path before this server
      // listener runs. This unique fixture school identifies the request.
      if (request.headers["x-school-id"] === a.schoolId) response.once("close", closed);
    };
    const abort = new AbortController();
    let request: Promise<Response | undefined> | undefined;
    let reuse: Promise<unknown> | undefined;
    pool.on("acquire", acquire); pool.on("release", released); server!.on("request", observeRequest);
    try {
      await blocker.query("BEGIN");
      if (blockedOn === "school advisory lock") await blocker.query(rollup.CLASSPILOT_USAGE_ROLLUP_LOCK_SQL, [a.schoolId]);
      else await blocker.query("SELECT id FROM heartbeats WHERE school_id=$1 FOR UPDATE", [a.schoolId]);
      request = fetch(`${baseUrl}/admin/cleanup-students`, { method: "POST", signal: abort.signal, headers: {
        authorization: `Bearer ${signUserToken({ userId: a.adminId, email: a.adminEmail, isSuperAdmin: false })}`, "x-school-id": a.schoolId,
      } }).catch(error => { assert.equal(error.name, "AbortError"); return undefined; });
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (!blocked && Date.now() < deadline) {
        const pattern = blockedOn === "school advisory lock" ? "%classpilot_usage_rollup%" : '%delete from "heartbeats"%';
        blocked = (await system!.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS blocked", [pattern])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true); assert.ok(observed); trace.length = 0;
      abort.abort(); await request; await responseClosed;
      reuse = inSchool(b.schoolId, async () => {
        const scope = await db.execute(sql`SELECT current_setting('app.school_id') AS school, current_setting('app.is_super') AS is_super`);
        assert.deepEqual(scope.rows, [{ school: b.schoolId, is_super: "off" }]);
        assert.deepEqual(await readSchools([a.schoolId, b.schoolId]), [b.schoolId]);
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(pool.waitingCount, 1, "the closed response must not give the still-running transaction's client away");
      await blocker.query("COMMIT"); await reuse;
      const firstRelease = trace.findIndex(event => event.kind === "release");
      const committed = trace.findIndex(event => event.kind === "query" && event.statement?.trim().toUpperCase() === "COMMIT");
      assert.ok(committed >= 0 && firstRelease > committed, "SQL and COMMIT settle before RESET/release, even after disconnect");
      assert.equal(trace.filter(event => event.kind === "release").length, 2, "cleanup and second-school leases each release once");
      assert.equal((await system!.query("SELECT 1 FROM heartbeats WHERE school_id=$1", [a.schoolId])).rowCount, 0);
      assert.equal((await system!.query("SELECT 1 FROM classpilot_usage_rollup_days WHERE school_id=$1", [a.schoolId])).rowCount, 0);
      assert.equal((await system!.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='students.cleanup'", [a.schoolId])).rows[0].count, 1);
      assert.deepEqual((await system!.query("SELECT * FROM classpilot_usage_rollups WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows, foreign);
      const reset = await pool.query("SELECT current_setting('app.school_id') AS school,current_setting('app.is_super') AS is_super");
      assert.deepEqual(reset.rows, [{ school: "", is_super: "off" }]);
    } finally {
      abort.abort(); await blocker.query("ROLLBACK"); blocker.release();
      await Promise.allSettled([request, reuse]);
      pool.off("acquire", acquire); pool.off("release", released); server!.off("request", observeRequest);
      if (observed && originalQuery) Object.defineProperty(observed, "query", { configurable: true, writable: true, value: originalQuery });
    }
  });
  }
});
