import assert from "node:assert/strict";
import { test } from "node:test";
import express, { type RequestHandler, type Response } from "express";
import session from "express-session";
import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { beginClasspilotUsageRequest, beginClasspilotUsageIngress, classpilotUsageRequest, guardClasspilotUsageMiddleware, guardClasspilotUsageIngressMiddleware } from "../src/services/classpilotUsageRequest.js";

for (const late of ["next", "deny", "throw"] as const) {
  test(`Usage deadline includes delayed authentication and suppresses late ${late}`, async t => {
    const app = express();
    let reached = false, errors = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const auth: RequestHandler = async (_req, res, next) => {
      await blocked;
      if (late === "next") return next();
      if (late === "deny") return res.status(403).json({ error: "late denial" });
      throw new Error("late authentication failure");
    };
    app.get("/", beginClasspilotUsageRequest(40), guardClasspilotUsageMiddleware(auth), (_req, res) => {
      reached = true; res.json({ ok: true });
    });
    app.use((_error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
      errors++; res.status(500).json({ error: "unexpected" });
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal((await response.json() as { code: string }).code, "CLASSPILOT_USAGE_BUSY");
    release();
    await delay(10);
    assert.equal(reached, false);
    assert.equal(errors, 0);
  });
}

test("Usage auth denial cleans the request deadline without later abort", async t => {
  const app = express();
  let signal: AbortSignal | undefined;
  let responseOwner: Response | undefined;
  app.get("/", beginClasspilotUsageRequest(40), (_req, res, next) => {
    responseOwner = res;
    signal = classpilotUsageRequest(res).controller.signal;
    next();
  }, guardClasspilotUsageMiddleware((_req, res) => {
    res.status(401).json({ error: "Sign in" });
  }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 401);
  await response.text();
  await delay(60);
  assert.equal(signal?.aborted, false);
  assert.ok(responseOwner);
  assert.throws(() => classpilotUsageRequest(responseOwner!), /deadline is missing/);
});

for (const mode of ["get", "save", "save-error", "save-late-sync", "normal"] as const) {
  test(`Usage ingress fences real session ${mode} and never emits a partial response`, async t => {
    const app = express(), store = new session.MemoryStore();
    let reached = 0, errors = 0, release!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    app.use((req, res, next) => req.path === "/usage"
      ? beginClasspilotUsageRequest(80, true)(req, res, next) : next());
    app.use(guardClasspilotUsageIngressMiddleware(session({ store, secret: "synthetic-usage-deadline-test", rolling: true, resave: false, saveUninitialized: false })));
    app.get("/login", (req, res) => { req.session.schoolId = "original-school"; req.session.schoolSessionVersion = 7; res.json({ ok: true }); });
    app.get("/usage", beginClasspilotUsageRequest(10_000), (req, res) => {
      reached++;
      assert.equal(classpilotUsageRequest(res).sessionSchoolVersion, 7);
      assert.equal(classpilotUsageRequest(res).sessionSchoolId, "original-school");
      req.session.lastActivityAt = Date.now();
      res.set("Content-Disposition", "attachment; filename=report.csv");
      res.json({ report: "whole response" });
    });
    app.use((_error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => { errors++; res.status(500).json({ error: "unexpected" }); });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { release(); await delay(10); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/login`); await login.text();
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    if (mode === "get") {
      const original = store.get.bind(store);
      t.mock.method(store, "get", (id: string, callback: Parameters<typeof store.get>[1]) => {
        void blocked.then(() => original(id, callback));
      });
    } else if (mode !== "normal") {
      const original = store.set.bind(store);
      t.mock.method(store, "set", (id: string, value: session.SessionData, callback: Parameters<typeof store.set>[2]) => {
        entered();
        void blocked.then(() => mode === "save-error" ? callback?.(new Error("synthetic late store failure"))
          : mode === "save-late-sync" ? callback?.() : original(id, value, callback));
      });
    }
    const response = fetch(`${base}/usage`, { headers: { cookie } });
    if (mode === "save-late-sync") {
      await saving;
      const until = performance.now()+100;
      while (performance.now() < until) { /* Force a save continuation before overdue timers get their turn. */ }
      release();
    }
    const result = await response;
    if (mode === "normal") {
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { report: "whole response" });
      assert.ok(result.headers.get("set-cookie"), "normal rolling session cookie must survive buffering");
    } else {
      assert.equal(result.status, 503);
      assert.equal((await result.json() as { code: string }).code, "CLASSPILOT_USAGE_BUSY");
      assert.equal(result.headers.get("retry-after"), "1");
      assert.match(result.headers.get("content-type")!, /^application\/json/);
      assert.equal(result.headers.get("content-disposition"), null);
      assert.equal(result.headers.get("set-cookie"), null);
      assert.equal(result.headers.get("etag"), null);
    }
    release(); await delay(20);
    assert.equal(reached, mode === "get" ? 0 : 1);
    assert.equal(errors, 0, "late session-store errors must not re-enter the error handler");
  });
}

test("Usage ingress matches only the active canonical GET/HEAD route, including Express case and slash variants", async t => {
  const keys = ["RLS_GUC_ENABLED", "RLS_ENABLED_TABLES", "CLASSPILOT_USAGE_ROLLUP_MODE", "CLASSPILOT_DIGITAL_USAGE_MODE"];
  const saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key,index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
  process.env.RLS_GUC_ENABLED = "true";
  process.env.RLS_ENABLED_TABLES = "classpilot_usage_rollups,classpilot_usage_rollup_days";
  process.env.CLASSPILOT_USAGE_ROLLUP_MODE = "on"; process.env.CLASSPILOT_DIGITAL_USAGE_MODE = "on";
  const app = express(); app.use(beginClasspilotUsageIngress());
  app.use((_req,res) => {
    let scoped = false; try { scoped = !!classpilotUsageRequest(res); } catch { /* Unrelated/dark request. */ }
    res.set("X-Usage-Deadline", String(scoped)).json({ ok: true });
  });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  for (const [method,path,expected] of [["GET","/api/classpilot/admin/usage",true],["HEAD","/API/CLASSPILOT/ADMIN/USAGE/",true],
    ["GET","/api/classpilot/admin/usage/?format=csv",true],["POST","/api/classpilot/admin/usage",false],
    ["GET","/api/classpilot/admin/usage/extra",false],["GET","/api/admin/usage",false]] as const) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
    assert.equal(response.headers.get("x-usage-deadline"), String(expected)); await response.text();
  }
  process.env.CLASSPILOT_DIGITAL_USAGE_MODE = "off";
  const dark = await fetch(`http://127.0.0.1:${address.port}/api/classpilot/admin/usage`);
  assert.equal(dark.headers.get("x-usage-deadline"), "false"); await dark.text();
});

test("Usage ingress suppresses a body-parser continuation after a delayed GET body", async t => {
  const app = express(); let reached = false, errors = 0;
  app.use(beginClasspilotUsageRequest(60, true));
  app.use(guardClasspilotUsageIngressMiddleware(express.json()));
  app.use((_req,res) => { reached = true; res.json({ report: "late" }); });
  app.use((_error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => { errors++; res.status(500).end(); });
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const result = new Promise<number | undefined>((resolve,reject) => {
    const client = request(`http://127.0.0.1:${address.port}/`, { method: "GET", headers: { "Content-Type":"application/json", "Content-Length":"10" } }, response => {
      response.resume(); response.on("end", () => { client.end("true}"); resolve(response.statusCode); });
    });
    client.on("error",reject); client.write('{"v":');
  });
  assert.equal(await result, 503); await delay(20);
  assert.equal(reached,false); assert.equal(errors,0);
});

test("Usage response buffer overflow produces bounded Busy instead of partial report bytes", async t => {
  const app = express(); app.use(beginClasspilotUsageRequest(500, true));
  app.use((_req,res) => res.json({ report: "x".repeat(2*1024*1024) }));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status,503);
  const body = await response.text(); assert.equal(JSON.parse(body).code,"CLASSPILOT_USAGE_BUSY");
  assert.equal(Number(response.headers.get("content-length")),Buffer.byteLength(body));
});
