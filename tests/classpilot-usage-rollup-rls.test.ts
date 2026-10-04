import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// RLS_SERIAL: meaningful only on the restricted, non-owner CI role with
// RLS_GUC_ENABLED=true and classpilot_usage_rollups in RLS_ENABLED_TABLES.
// In the ordinary DB lane (database owner) every case is skipped.
const RLS = process.env.RLS_GUC_ENABLED === "true";
const TABLE = "classpilot_usage_rollups";
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.CLASSPILOT_USAGE_ROLLUP_MODE = "on";
process.env.CLASSPILOT_DIGITAL_USAGE_MODE = "on";
// Force reuse in this serial isolation test, without increasing a pool ceiling.
process.env.DB_POOL_MAX = "1";

const TIME_ZONE = "America/New_York";
const TAG = `usage_rls_${Date.now()}`;
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
    // Ten 10-second observations: 9 x 10 s + 15 s for the last one.
    for (let beat = 0; beat < 10; beat += 1) {
      await run(
        `INSERT INTO heartbeats(device_id, student_id, school_id, active_tab_title, active_tab_url, ai_category, timestamp)
         VALUES ($1, $2, $3, 'fixture', $4, 'educational', $5::timestamp)`,
        [`${TAG}-${label}-${index}`, id, schoolId, `https://${domain}/lesson`, wall(dayStart + (10 * 3600 + index * 600 + beat * 10) * 1000)],
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
      for (const table of ["classpilot_usage_rollup_days", TABLE, "heartbeats", "audit_logs", "students", "settings", "school_memberships", "product_licenses"]) {
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

describe("Monitored Browser Time rollups under forced RLS", { skip: RLS ? false : "requires the RLS lane (RLS_GUC_ENABLED=true)" }, () => {
  it("runs as a role that cannot bypass the policy, with the table admitted and forced", async () => {
    const role = await system!.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
    assert.ok(new Set((process.env.RLS_ENABLED_TABLES ?? "").split(",")).has(TABLE));
    const forced = await system!.query("SELECT relname FROM pg_class WHERE relname = $1 AND relrowsecurity AND relforcerowsecurity", [TABLE]);
    assert.equal(forced.rowCount, 1);
    assert.ok(new Set((process.env.RLS_ENABLED_TABLES ?? "").split(",")).has("classpilot_usage_rollup_days"));
    assert.equal((await system!.query("SELECT 1 FROM pg_class WHERE relname='classpilot_usage_rollup_days' AND relrowsecurity AND relforcerowsecurity")).rowCount, 1);
  });

  it("never turns school B heartbeats into school A rows on the scheduler pool", async () => {
    const [a, b] = [await createTenant("A", "a.example.edu"), await createTenant("B", "b.example.edu")];
    assert.deepEqual(await rollupDay(a.schoolId), { rowCount: 2, seconds: 210, heartbeatCount: 20 });
    const aRows = await system!.query(`SELECT school_id, student_id, domain FROM ${TABLE} WHERE school_id = ANY($1::text[]) ORDER BY student_id`, [[a.schoolId, b.schoolId]]);
    assert.deepEqual(new Set(aRows.rows.map((row) => row.school_id)), new Set([a.schoolId]));
    assert.deepEqual(aRows.rows.map((row) => row.domain), ["a.example.edu", "a.example.edu"]);
    assert.ok(aRows.rows.every((row) => a.students.includes(row.student_id)));
    await rollupDay(b.schoolId);
    await rollupDay(b.schoolId);
    const aAfter = await system!.query(`SELECT count(*)::int AS count, SUM(seconds)::int AS seconds FROM ${TABLE} WHERE school_id = $1`, [a.schoolId]);
    assert.deepEqual(aAfter.rows[0], { count: 2, seconds: 210 }, "rewriting B never touches A");
  });

  it("scopes reads to the tenant context and denies reads without one", async () => {
    const [a, b] = tenants;
    const ids = [a!.schoolId, b!.schoolId];
    assert.deepEqual(await inSchool(a!.schoolId, () => readSchools(ids)), [a!.schoolId]);
    assert.deepEqual(await inSchool(b!.schoolId, () => readSchools(ids)), [b!.schoolId]);
    const unscoped = await pool.query(`SELECT count(*)::int AS count FROM ${TABLE} WHERE school_id = ANY($1::text[])`, [ids]);
    assert.equal(unscoped.rows[0].count, 0, "deny-by-default without a tenant GUC");

    const own = await inSchool(a!.schoolId, () => read.getClasspilotDigitalUsage({ schoolId: a!.schoolId, scope: "school", id: null, from: day, to: day }));
    assert.equal(own.totals.monitoredBrowserSeconds, 210);
    assert.equal(own.totals.activeMonitoredStudents, 2);
    const foreign = await inSchool(b!.schoolId, () => read.getClasspilotDigitalUsage({ schoolId: a!.schoolId, scope: "school", id: null, from: day, to: day }));
    assert.equal(foreign.dataState, "unavailable", "a request bound to B cannot read A's rollups by naming A");
    assert.equal(foreign.totals.monitoredBrowserSeconds, 0);
  });

  it("rejects cross-school writes WITH CHECK and never touches another school's rows", async () => {
    const [a, b] = tenants;
    await assert.rejects(
      inSchool(a!.schoolId, () => db.execute(sql`
        INSERT INTO classpilot_usage_rollups (school_id, usage_date, student_id, domain, classification, seconds, heartbeat_count)
        VALUES (${b!.schoolId}, ${day}::date, ${b!.students[0]!}, 'x.example.edu', 'educational', 1, 1)
      `)),
      rejectedByPolicy,
    );
    const updated: any = await inSchool(a!.schoolId, () => db.execute(sql`UPDATE classpilot_usage_rollups SET seconds = 0 WHERE school_id = ${b!.schoolId}`));
    assert.equal(updated.rowCount, 0);
    const deleted: any = await inSchool(a!.schoolId, () => db.execute(sql`DELETE FROM classpilot_usage_rollups WHERE school_id = ${b!.schoolId}`));
    assert.equal(deleted.rowCount, 0);
    const survived = await system!.query(`SELECT SUM(seconds)::int AS seconds FROM ${TABLE} WHERE school_id = $1`, [b!.schoolId]);
    assert.equal(survived.rows[0].seconds, 210);
    await assert.rejects(inSchool(a!.schoolId, () => db.execute(sql`
      INSERT INTO classpilot_usage_rollup_days(school_id,usage_date,day_start_at,day_end_at,processed_through)
      VALUES(${b!.schoolId}, '2026-09-01', '2026-09-01T04:00:00Z', '2026-09-02T04:00:00Z', '2026-09-01T05:00:00Z')
    `)), rejectedByPolicy);
    const coverage = await inSchool(a!.schoolId, () => db.execute(sql`SELECT school_id FROM classpilot_usage_rollup_days WHERE school_id=${b!.schoolId}`));
    assert.equal(coverage.rows.length, 0);
    const unchanged = await inSchool(a!.schoolId, () => db.execute(sql`DELETE FROM classpilot_usage_rollup_days WHERE school_id=${b!.schoolId}`));
    assert.equal(unchanged.rowCount, 0);
  });

  it("answers 404 for another school's student and school totals only for the caller's school over HTTP", async () => {
    const [a, b] = tenants;
    const get = (query: string) => fetch(`${baseUrl}/classpilot/admin/usage${query}`, {
      headers: {
        authorization: `Bearer ${signUserToken({ userId: a!.adminId, email: a!.adminEmail, isSuperAdmin: false })}`,
        "x-school-id": a!.schoolId,
      },
    });
    const foreign = await get(`?scope=student&id=${b!.students[0]}&from=${day}&to=${day}`);
    assert.equal(foreign.status, 404);
    assert.equal(((await foreign.json()) as { code: string }).code, "CLASSPILOT_USAGE_SCOPE_NOT_FOUND");
    const school = await get(`?from=${day}&to=${day}`);
    assert.equal(school.status, 200, await school.clone().text());
    const body = (await school.json()) as { totals: { monitoredBrowserSeconds: number; activeMonitoredStudents: number } };
    assert.deepEqual([body.totals.monitoredBrowserSeconds, body.totals.activeMonitoredStudents], [210, 2]);
    const own = await get(`?scope=student&id=${a!.students[0]}&from=${day}&to=${day}&format=csv`);
    assert.equal(own.status, 200);
    const audit = await system!.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id = $1 AND action = 'classpilot.usage.export'", [a!.schoolId]);
    assert.equal(audit.rows[0].count, 1, "the export audit is written on the request path under forced RLS");
  });

  it("matches frozen guard/report queries as a tenant role with nonempty AI, exclusions and foreign decisions", async () => {
    const [a, b] = tenants;
    const beat = (await system!.query("SELECT id FROM heartbeats WHERE school_id=$1 AND student_id=$2 ORDER BY timestamp,id LIMIT 1", [a!.schoolId,a!.students[0]])).rows[0].id;
    const at = dayStart + 10 * 3600_000, window = rollup.classpilotUsageRollupDay(day,TIME_ZONE);
    await system!.query(`INSERT INTO classpilot_ai_decisions(id,school_id,heartbeat_id,category,teacher_intent_source,created_at) VALUES
      ($1,$2,$3,'educational',NULL,$4::timestamp),($5,$2,$3,'non-educational',NULL,$4::timestamp),
      ($6,$7,$3,'educational',NULL,$8::timestamp),($9,$2,$3,'educational',NULL,$10::timestamp)`,
      [`a-${randomUUID()}`,a!.schoolId,beat,wall(at+60_000),`z-${randomUUID()}`,randomUUID(),b!.schoolId,wall(at+120_000),randomUUID(),wall(dayStart-1000)]);
    const reference = readFileSync(new URL("./fixtures/usage-before-fast-paths/attribution.sql",import.meta.url),"utf8");
    const reports = readFileSync(new URL("./fixtures/usage-before-fast-paths/report.sql",import.meta.url),"utf8");
    const candidate = rollup.CLASSPILOT_USAGE_ROLLUP_INSERT_SQL.split(",\nexisting_grains AS ")[0] + " SELECT $4::date AS usage_date,grains.* FROM grains ORDER BY student_id,COALESCE(class_id,''),COALESCE(session_id,''),domain,classification";
    const client = await pool.connect(), dialect = new PgDialect();
    const transaction = { execute(statement: SQL) { const query=dialect.sqlToQuery(statement); return client.query(query.sql,query.params); } };
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true)",[a!.schoolId]);
      for (const exclusions of [[],[{studentId:a!.students[0],start:wall(at+5000),end:wall(at+12_000)}],[{studentId:b!.students[0],start:wall(at),end:wall(at+120_000)}]]) {
        const values=[a!.schoolId,wall(window.dayStartUtc.getTime()),wall(window.dayEndUtc.getTime()),day,JSON.stringify(exclusions)];
        const expected=(await client.query(reference,values)).rows, actual=(await client.query(candidate,values)).rows;
        assert.deepEqual(actual,expected);
        assert.ok(actual.every(row=>a!.students.includes(row.student_id)));
        assert.equal(actual.reduce((sum,row)=>sum+row.seconds,0),exclusions[0]?.studentId===a!.students[0]?195:210);
      }
      const foreign=[b!.schoolId,wall(window.dayStartUtc.getTime()),wall(window.dayEndUtc.getTime()),day,'[]'];
      assert.deepEqual((await client.query(candidate,foreign)).rows,[],"guard CTEs cannot create rows for a school hidden by RLS");
      const legacy=(await client.query(reports,[a!.schoolId,day,day,10,null,null])).rows;
      const report=await read.getClasspilotDigitalUsage({schoolId:a!.schoolId,scope:"school",id:null,from:day,to:day,transaction:transaction as never});
      const total=legacy.find(row=>Number(row.total_row)===1);
      assert.deepEqual([report.totals.monitoredBrowserSeconds,report.totals.activeMonitoredStudents,report.totals.heartbeatCount],[Number(total.monitored),Number(total.students),Number(total.heartbeats)]);
      assert.deepEqual(report.topEducationalDomains,legacy.filter(row=>row.row_kind==='domain'&&row.classification==='educational').map(row=>({domain:row.domain,seconds:Number(row.seconds)})));
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("invalidates a direct tenant writer's own coverage without touching another school", async () => {
    const [a, b] = tenants;
    await inSchool(a!.schoolId, () => db.execute(sql`UPDATE classpilot_usage_rollups SET seconds=seconds WHERE school_id=${a!.schoolId}`));
    const own = await inSchool(a!.schoolId, () => read.getClasspilotDigitalUsage({ schoolId: a!.schoolId, scope: "school", id: null, from: day, to: day }));
    assert.equal(own.dataState, "unavailable");
    assert.deepEqual(own.range.unavailableDates, [day]);
    const other = await inSchool(b!.schoolId, () => read.getClasspilotDigitalUsage({ schoolId: b!.schoolId, scope: "school", id: null, from: day, to: day }));
    assert.equal(other.dataState, "final");
    assert.equal(other.totals.monitoredBrowserSeconds, 210);
  });

  it("cleanup removes only its authorized school's inputs and coverage with an atomic audit", async () => {
    const a = await createTenant("Cleanup C", "c.example.edu"), b = await createTenant("Cleanup D", "d.example.edu");
    await rollupDay(a.schoolId); await rollupDay(b.schoolId);
    // Cleanup's established authority is the legacy admin role, not school_admin.
    await system!.query("UPDATE school_memberships SET role='admin' WHERE school_id=$1 AND user_id=$2", [a.schoolId, a.adminId]);
    const foreign = (await system!.query("SELECT id,ctid::text,xmin::text,computed_at FROM classpilot_usage_rollups WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows;
    const foreignCoverage = (await system!.query("SELECT * FROM classpilot_usage_rollup_days WHERE school_id=$1", [b.schoolId])).rows;
    const response = await fetch(`${baseUrl}/admin/cleanup-students`, { method: "POST", headers: {
      authorization: `Bearer ${signUserToken({ userId: a.adminId, email: a.adminEmail, isSuperAdmin: false })}`,
      "x-school-id": a.schoolId,
    } });
    assert.equal(response.status, 200, await response.text());
    const own = await inSchool(a.schoolId, () => read.getClasspilotDigitalUsage({ schoolId: a.schoolId, scope: "school", id: null, from: day, to: day }));
    assert.equal(own.dataState, "unavailable"); assert.deepEqual(own.byDay, []); assert.deepEqual(own.range.unavailableDates, [day]);
    assert.equal((await system!.query("SELECT 1 FROM heartbeats WHERE school_id=$1", [a.schoolId])).rowCount, 0);
    assert.equal((await system!.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='students.cleanup'", [a.schoolId])).rows[0].count, 1);
    assert.deepEqual((await system!.query("SELECT id,ctid::text,xmin::text,computed_at FROM classpilot_usage_rollups WHERE school_id=$1 ORDER BY id", [b.schoolId])).rows, foreign);
    assert.deepEqual((await system!.query("SELECT * FROM classpilot_usage_rollup_days WHERE school_id=$1", [b.schoolId])).rows, foreignCoverage);
    assert.equal((await system!.query("SELECT count(*)::int AS count FROM heartbeats WHERE school_id=$1", [b.schoolId])).rows[0].count, 20);
  });

  it("holds an aborted cleanup's transaction through commit before second-school pooled reuse", async () => {
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
      await blocker.query("BEGIN"); await blocker.query(rollup.CLASSPILOT_USAGE_ROLLUP_LOCK_SQL, [a.schoolId]);
      request = fetch(`${baseUrl}/admin/cleanup-students`, { method: "POST", signal: abort.signal, headers: {
        authorization: `Bearer ${signUserToken({ userId: a.adminId, email: a.adminEmail, isSuperAdmin: false })}`, "x-school-id": a.schoolId,
      } }).catch(error => { assert.equal(error.name, "AbortError"); return undefined; });
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (!blocked && Date.now() < deadline) {
        blocked = (await system!.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%classpilot_usage_rollup%') AS blocked")).rows[0].blocked;
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
});
