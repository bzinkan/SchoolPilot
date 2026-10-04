import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import session from "express-session";
import pg from "pg";
import { sql } from "drizzle-orm";

// Runs in ordinary and restricted-role lanes. Fixtures are isolated schools;
// the latter lane enforces the existing FORCE RLS schema and CRUD-only role.
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = [process.env.RLS_ENABLED_TABLES,
  "classpilot_usage_rollups", "classpilot_usage_rollup_days"].filter(Boolean).join(",");
process.env.CLASSPILOT_USAGE_ROLLUP_MODE = "on";
process.env.CLASSPILOT_DIGITAL_USAGE_MODE = "on";

let system: pg.Pool;
let pools: typeof import("../src/db.js");
let admission: typeof import("../src/services/classpilotUsageAdmission.js");
let execution: typeof import("../src/services/classpilotUsageExecution.js");
let tenant: typeof import("../src/db/tenantContext.js");
let sign: typeof import("../src/services/jwt.js").signUserToken;
let server: Server;
let baseUrl: string;
const fixtures: Array<{ schoolId: string; userId: string; email: string }> = [];

async function fixture() {
  const schoolId = randomUUID(), userId = randomUUID(), email = `usage-admission-${randomUUID()}@example.test`;
  await system.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Usage admission','active',true,'active','America/New_York')", [schoolId]);
  await system.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Usage','Admin')", [userId,email]);
  await system.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'school_admin','active')", [schoolId,userId]);
  await system.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  const value = { schoolId, userId, email };
  fixtures.push(value);
  return value;
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5_000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, "bounded native fixture wait expired");
    await delay(5);
  }
}

before(async () => {
  assert.ok(["localhost","127.0.0.1","::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only a local fixture database is permitted");
  system = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c app.is_super=on", max: 2 });
  pools = await import("../src/db.js");
  admission = await import("../src/services/classpilotUsageAdmission.js");
  execution = await import("../src/services/classpilotUsageExecution.js");
  tenant = await import("../src/db/tenantContext.js");
  ({ signUserToken: sign } = await import("../src/services/jwt.js"));
  const { default: router } = await import("../src/routes/classpilot/adminUsage.js");
  const app = express();
  app.use(session({ secret: randomUUID(), resave: false, saveUninitialized: false }));
  app.post("/fixture-session/:userId", (req, res) => {
    const owner = fixtures.find(value => value.userId === req.params.userId);
    assert.ok(owner);
    req.session.userId = owner.userId;
    req.session.schoolId = owner.schoolId;
    req.session.role = "school_admin";
    req.session.authVersion = 1;
    req.session.schoolSessionVersion = 1;
    res.status(204).end();
  });
  app.use("/usage", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : "Error" });
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}/usage`;
});

after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  // The current staff contract retains schools/users; remove only fixture
  // relations allowed by that contract and leave no outbox/usage data behind.
  if (system) for (const row of fixtures) {
    for (const table of ["audit_logs", "classpilot_usage_rollup_days", "classpilot_usage_rollups", "school_memberships", "product_licenses"]) {
      await system.query(`DELETE FROM ${table} WHERE school_id=$1`, [row.schoolId]).catch(() => undefined);
    }
  }
  await Promise.allSettled([system?.end(), pools?.pool.end(), pools?.sessionPool.end()]);
});

describe("Usage admission and scoped execution (native PostgreSQL)", { concurrency: false }, () => {
  for (const mutation of ["membership", "role", "school", "license", "credential"] as const) {
    it(`rechecks ${mutation} after queue admission and holds no database lease while queued`, async () => {
      const owner = await fixture();
      const release = await admission.classpilotUsageAdmission.acquire(owner.schoolId, new AbortController().signal);
      const response = fetch(`${baseUrl}?format=csv`, { headers: {
        authorization: `Bearer ${sign({ userId: owner.userId, email: owner.email })}`,
        "x-school-id": owner.schoolId,
      } });
      try {
        await until(() => admission.classpilotUsageAdmission.snapshot().queued === 1);
        assert.equal(pools.pool.totalCount - pools.pool.idleCount, 0, "queued reports must not own a database client");
        if (mutation === "membership") await system.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1", [owner.schoolId]);
        if (mutation === "role") await system.query("UPDATE school_memberships SET role='teacher' WHERE school_id=$1", [owner.schoolId]);
        if (mutation === "school") await system.query("UPDATE schools SET status='suspended' WHERE id=$1", [owner.schoolId]);
        if (mutation === "license") await system.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1", [owner.schoolId]);
        if (mutation === "credential") await system.query("UPDATE users SET auth_version=auth_version+1 WHERE id=$1", [owner.userId]);
        release();
        const result = await response;
        assert.equal(result.status, mutation === "credential" ? 401 : 403, await result.clone().text());
        assert.equal(result.headers.get("content-type"), "application/json; charset=utf-8");
        await result.text();
        assert.equal((await system.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [owner.schoolId])).rows[0].count, 0);
      } finally { release(); await response.then(value => value.arrayBuffer()).catch(() => {}); }
      assert.deepEqual(admission.classpilotUsageAdmission.snapshot(), { active: 0, queued: 0 });
    });
  }

  it("serves audited CSV and unavailable JSON through the same narrow lease", async () => {
    const owner = await fixture();
    const headers = { authorization: `Bearer ${sign({ userId: owner.userId, email: owner.email })}`, "x-school-id": owner.schoolId };
    const csv = await fetch(`${baseUrl}?format=csv`, { headers });
    assert.equal(csv.status, 200, await csv.clone().text());
    assert.match(await csv.text(), /Monitored Browser Time/);
    const json = await fetch(baseUrl, { headers });
    assert.equal(json.status, 200, await json.clone().text());
    const body = await json.json() as { dataState: string; byDay: unknown[] };
    assert.equal(body.dataState, "unavailable");
    assert.deepEqual(body.byDay, []);
    assert.equal((await system.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [owner.schoolId])).rows[0].count, 1);
    assert.equal(pools.pool.totalCount - pools.pool.idleCount, 0);
  });

  it("never sends CSV when its strict audit write fails", async t => {
    const owner = await fixture();
    const wrapped = new WeakSet<pg.PoolClient>();
    const intercept = (client: pg.PoolClient) => {
      if (wrapped.has(client)) return;
      wrapped.add(client);
      const original = client.query;
      t.mock.method(client, "query", (query: string | { text: string }, ...args: unknown[]) => {
        const text = typeof query === "string" ? query : query.text;
        if (/^insert into "audit_logs"/i.test(text.trim())) throw new Error("Synthetic strict audit failure");
        return Reflect.apply(original, client, [query, ...args]);
      });
    };
    pools.pool.on("acquire", intercept);
    t.after(() => pools.pool.off("acquire", intercept));
    const response = await fetch(`${baseUrl}?format=csv`, { headers: {
      authorization: `Bearer ${sign({ userId: owner.userId, email: owner.email })}`,
      "x-school-id": owner.schoolId,
    } });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), null);
    await response.text();
    assert.equal((await system.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [owner.schoolId])).rows[0].count, 0);
    assert.equal(pools.pool.totalCount - pools.pool.idleCount, 0);
    assert.deepEqual(admission.classpilotUsageAdmission.snapshot(), { active: 0, queued: 0 });
  });

  it("preserves the original cookie-session version and expires a session revoked while queued", async () => {
    const owner = await fixture();
    const login = await fetch(new URL(`/fixture-session/${owner.userId}`, baseUrl), { method: "POST" });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const headers = { cookie, "x-school-id": owner.schoolId };
    const unchanged = await fetch(baseUrl, { headers });
    assert.equal(unchanged.status, 200, await unchanged.clone().text());
    await unchanged.text();
    const release = await admission.classpilotUsageAdmission.acquire(owner.schoolId, new AbortController().signal);
    const pending = fetch(`${baseUrl}?format=csv`, { headers });
    try {
      await until(() => admission.classpilotUsageAdmission.snapshot().queued === 1);
      await system.query("UPDATE schools SET school_session_version=school_session_version+1 WHERE id=$1", [owner.schoolId]);
      release();
      const denied = await pending;
      assert.equal(denied.status, 401, await denied.clone().text());
      assert.equal((await denied.json() as { code: string }).code, "SESSION_INVALIDATED");
      assert.equal((await system.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [owner.schoolId])).rows[0].count, 0);
      const retry = await fetch(baseUrl, { headers });
      assert.equal(retry.status, 401, "a resolver refresh must not revive an invalidated cookie session");
      await retry.text();
    } finally { release(); await pending.then(value => value.arrayBuffer()).catch(() => {}); }
  });

  it("selects an authorized second school with a different epoch, then detects its queued revocation", async () => {
    const [a, b] = [await fixture(), await fixture()];
    await system.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'school_admin','active')", [b.schoolId,a.userId]);
    await system.query("UPDATE schools SET school_session_version=5 WHERE id=$1", [b.schoolId]);
    const login = async () => {
      const response = await fetch(new URL(`/fixture-session/${a.userId}`, baseUrl), { method: "POST" });
      await response.text();
      const cookie = response.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie); return cookie;
    };
    const unchanged = await fetch(baseUrl, { headers: { cookie: await login(), "x-school-id": b.schoolId } });
    assert.equal(unchanged.status, 200, await unchanged.clone().text()); await unchanged.text();
    const release = await admission.classpilotUsageAdmission.acquire(b.schoolId, new AbortController().signal);
    const pending = fetch(`${baseUrl}?format=csv`, { headers: { cookie: await login(), "x-school-id": b.schoolId } });
    try {
      await until(() => admission.classpilotUsageAdmission.snapshot().queued === 1);
      await system.query("UPDATE schools SET school_session_version=6 WHERE id=$1", [b.schoolId]);
      release(); const denied = await pending;
      assert.equal(denied.status, 401, await denied.clone().text());
      assert.equal((await denied.json() as { code: string }).code, "SESSION_INVALIDATED");
      assert.equal((await system.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [b.schoolId])).rows[0].count, 0);
    } finally { release(); await pending.then(value => value.arrayBuffer()).catch(() => {}); }
  });

  for (const stage of ["get", "save"] as const) {
    it(`full app bounds delayed PostgreSQL session ${stage} before sending report bytes`, async t => {
      const owner = await fixture(), sid = randomUUID();
      const secret = process.env.SESSION_SECRET || randomUUID(); process.env.SESSION_SECRET = secret;
      const { createApp } = await import("../src/app.js");
      const appServer = createServer(createApp());
      let finishes = 0, responseErrors = 0;
      appServer.on("request", (_req, res) => { res.on("finish", () => finishes++); res.on("error", () => responseErrors++); });
      await new Promise<void>(resolve => appServer.listen(0, "127.0.0.1", resolve));
      const address = appServer.address(); assert.ok(address && typeof address !== "string");
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      t.after(async () => { release(); await delay(25); appServer.closeAllConnections(); await new Promise<void>(resolve => appServer.close(() => resolve())); await system.query('DELETE FROM "session" WHERE sid=$1', [sid]); });
      const value = { cookie: { originalMaxAge: 86_400_000, expires: new Date(Date.now() + 86_400_000).toISOString(), httpOnly: true, path: "/", secure: false, sameSite: "lax" },
        userId: owner.userId, schoolId: owner.schoolId, role: "school_admin", authVersion: 1, schoolSessionVersion: 1, lastActivityAt: Date.now() };
      const writeSession = () => system.query('INSERT INTO "session"(sid,sess,expire) VALUES($1,$2,$3) ON CONFLICT(sid) DO UPDATE SET sess=EXCLUDED.sess,expire=EXCLUDED.expire', [sid, JSON.stringify(value), new Date(Date.now()+86_400_000)]);
      await writeSession();
      const signed = `s:${sid}.${createHmac("sha256", secret).update(sid).digest("base64").replace(/=+$/, "")}`;
      const headers = { cookie: `schoolpilot.sid=${encodeURIComponent(signed)}`, "x-school-id": owner.schoolId };
      const url = `http://127.0.0.1:${address.port}/api/classpilot/admin/usage`;
      const valid = await fetch(url, { headers }); assert.equal(valid.status, 200, await valid.clone().text()); await valid.text();
      assert.ok(valid.headers.get("set-cookie"), "ordinary session rolling cookie remains available");
      if (stage === "save") { value.lastActivityAt = Date.now()-120_000; await writeSession(); }
      const original = pools.sessionPool.query.bind(pools.sessionPool);
      let delayed = false;
      t.mock.method(pools.sessionPool, "query", async (query: string, values: unknown[]) => {
        const result = await original(query, values);
        if (stage === "get" ? values?.[0] === sid && query.startsWith("SELECT sess")
          : values?.[2] === sid && /^INSERT INTO .*"session"/.test(query)) {
          delayed = true; await blocked;
        }
        return result;
      });
      const started = performance.now();
      const response = await fetch(`${url}?format=csv`, { headers });
      assert.equal(response.status, 503, await response.clone().text());
      const body = await response.text(); assert.equal(JSON.parse(body).code, "CLASSPILOT_USAGE_BUSY");
      assert.ok(delayed, "the actual PostgreSQL-backed store continuation was delayed");
      assert.ok(performance.now()-started >= 19_000 && performance.now()-started < 23_000, "the production20s ingress deadline bounds the complete response");
      assert.equal(response.headers.get("retry-after"), "1");
      assert.match(response.headers.get("content-type")!, /^application\/json/);
      assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(body));
      assert.equal(response.headers.get("content-disposition"), null);
      assert.equal(response.headers.get("set-cookie"), null);
      release(); await delay(50);
      assert.equal(finishes, 2, "one successful and one busy response, no late duplicate finish");
      assert.equal(responseErrors, 0);
      assert.equal((await system.query("SELECT count(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [owner.schoolId])).rows[0].count, stage === "get" ? 0 : 1);
      assert.deepEqual(admission.classpilotUsageAdmission.snapshot(), { active: 0, queued: 0 });
      assert.equal(pools.pool.totalCount-pools.pool.idleCount, 0);
      assert.equal(pools.sessionPool.totalCount-pools.sessionPool.idleCount, 0);
    });
  }

  it("cancels active PostgreSQL work, drains ownership, and binds a subsequent tenant correctly", async () => {
    const [a, b] = [await fixture(), await fixture()];
    const controller = new AbortController();
    let pid = 0;
    const running = execution.runClasspilotUsageExecution({ schoolId: a.schoolId, signal: controller.signal, deadlineAt: performance.now() + 20_000 }, async () => {
      pid = Number((await tenant.getTenantStore()!.client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await pools.db.execute(sql`SELECT pg_sleep(5)`);
      throw new Error("Cancelled query continued");
    });
    const rejection = assert.rejects(running, admission.ClasspilotUsageBusyError);
    await until(async () => pid > 0 && (await system.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid])).rowCount === 1);
    const started = performance.now();
    controller.abort(new admission.ClasspilotUsageBusyError());
    await rejection;
    assert.ok(performance.now() - started < 2_000, "cancellation must interrupt the native query, not wait for its sleep");
    assert.equal(pools.pool.totalCount - pools.pool.idleCount, 0);
    await execution.runClasspilotUsageExecution({ schoolId: b.schoolId, signal: new AbortController().signal, deadlineAt: performance.now() + 20_000 }, async () => {
      const result = await tenant.getTenantStore()!.client.query("SELECT current_setting('app.school_id') AS school, current_setting('app.is_super') AS super");
      assert.deepEqual(result.rows[0], { school: b.schoolId, super: "off" });
    });
  });
});
