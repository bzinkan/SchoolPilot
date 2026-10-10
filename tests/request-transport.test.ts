import assert from "node:assert/strict";
import { createServer, request, type ClientRequest } from "node:http";
import { test, type TestContext } from "node:test";
import express, { type Request, type Response } from "express";
import session from "express-session";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requestId } from "../src/middleware/requestId.js";
import { createRequestBodyFailureDiagnostics, guardRequestTransportBeforeBody } from "../src/middleware/requestTransport.js";
import errorMonitor from "../src/services/errorMonitor.js";
import { snapshotRuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

const paths = ["/api/classpilot/tiles/screenshots", "/api/classpilot/tiles/history"];
const body = JSON.stringify({ students: ["synthetic-test-student"] });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, path: string, options: {
  omitGuard?: boolean; drain?: boolean; failAfterClose?: boolean; liveError?: Error;
} = {}) {
  const app = express(), store = new session.MemoryStore();
  const sessionEntered = deferred(), releaseSession = deferred(), sessionFinished = deferred();
  const parserEntered = deferred(), closed = deferred(), errorEntered = deferred(), routeEntered = deferred();
  let holdSession = false, routeCount = 0, observedRequest: Request | undefined, observedResponse: Response | undefined;
  const errors: unknown[] = [], logs: unknown[][] = [];
  const monitor = t.mock.method(errorMonitor, "trackError", () => {});
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  snapshotRuntimePerformanceMetrics({ reset: true });
  const get = store.get.bind(store);
  t.mock.method(store, "get", (id: string, callback: Parameters<typeof store.get>[1]) => {
    if (!holdSession) return get(id, callback);
    sessionEntered.resolve();
    void releaseSession.promise.then(() => get(id, (error, value) => {
      callback(error, value);
      sessionFinished.resolve();
    }));
  });
  app.use(requestId);
  app.use((req, res, next) => {
    if (req.path === path) {
      observedRequest = req; observedResponse = res;
      res.once("close", closed.resolve);
    }
    next();
  });
  app.use(session({ store, secret: "synthetic-request-transport-test", resave: false, saveUninitialized: false }));
  app.get("/login", (req, res) => { req.session.schoolId = "synthetic-session-school"; res.json({ ok: true }); });
  if (options.drain) app.use((req, _res, next) => {
    if (req.path !== path) return next();
    req.once("end", () => setImmediate(next));
    req.resume();
  });
  if (!options.omitGuard) app.use(guardRequestTransportBeforeBody);
  app.use((_req, _res, next) => { parserEntered.resolve(); next(); });
  app.use(express.json({ limit: "1mb", verify: (req, _res, buffer) => { (req as Request).rawBody = buffer; } }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.post(path, (req, res, next) => {
    routeCount++; routeEntered.resolve();
    if (options.liveError) return next(options.liveError);
    if (options.failAfterClose) {
      void closed.promise.then(() => next(new Error("Unrelated operation aborted unexpectedly")));
      return;
    }
    if (req.session.schoolId !== "synthetic-session-school") { res.status(401).end(); return; }
    res.json({ body: req.body, rawBody: req.rawBody?.toString("utf8") });
  });
  app.use((error: unknown, _req: Request, _res: Response, next: express.NextFunction) => {
    errors.push(error); errorEntered.resolve(); next(error);
  });
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    releaseSession.resolve(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    snapshotRuntimePerformanceMetrics({ reset: true });
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/login`); await login.text();
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  return {
    base, cookie, monitor, logs, errors, sessionEntered, sessionFinished, parserEntered, closed, errorEntered, routeEntered,
    get routeCount() { return routeCount; },
    get req() { assert.ok(observedRequest); return observedRequest; },
    get res() { assert.ok(observedResponse); return observedResponse; },
    holdSession() { holdSession = true; }, releaseSession: releaseSession.resolve,
    post(payload = body) {
      return fetch(`${base}${path}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: payload });
    },
    client(payload: string, complete = true): ClientRequest {
      const client = request(`${base}${path}`, { method: "POST", headers: {
        cookie, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
      } });
      client.on("error", () => {});
      if (complete) client.end(payload); else client.write(payload);
      return client;
    },
  };
}

for (const path of paths) {
  test(`${path}: cancellation during session lookup stops before parsing`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, path); f.holdSession();
    const client = f.client(body); await f.sessionEntered.promise;
    client.destroy(); await f.closed.promise;
    f.releaseSession(); await f.sessionFinished.promise;
    assert.equal(f.req.complete, true, "even a completely transmitted request can lose its transport");
    assert.equal(f.routeCount, 0); assert.equal(f.errors.length, 0);
    assert.equal(f.monitor.mock.callCount(), 0); assert.equal(f.logs.length, 0);
    assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, { requestDisconnectedBeforeBodyParser: 1 });
  });

  test(`${path}: an unreadable parser race on a closed transport does not alert`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, path, { omitGuard: true }); f.holdSession();
    const client = f.client(body); await f.sessionEntered.promise;
    client.destroy(); await f.closed.promise;
    f.releaseSession(); await f.errorEntered.promise;
    assert.equal((f.errors[0] as { type: string }).type, "stream.not.readable");
    assert.equal(f.routeCount, 0); assert.equal(f.monitor.mock.callCount(), 0); assert.equal(f.logs.length, 0);
    assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, { requestBodyParserCancelled: 1 });
  });

  test(`${path}: cancellation while the parser reads remains quiet`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, path);
    const client = f.client(body.slice(0, 5), false); await f.parserEntered.promise;
    client.destroy(); await f.errorEntered.promise;
    assert.equal((f.errors[0] as { type: string }).type, "request.aborted");
    assert.equal(f.routeCount, 0); assert.equal(f.monitor.mock.callCount(), 0); assert.equal(f.logs.length, 0);
    assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, { requestBodyParserCancelled: 1 });
  });

  test(`${path}: normal delayed session preserves JSON, raw bytes, and authentication`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, path); f.holdSession();
    const pending = f.post(); await f.sessionEntered.promise; f.releaseSession();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { body: JSON.parse(body), rawBody: body });
    assert.equal(f.routeCount, 1); assert.equal(f.monitor.mock.callCount(), 0);
    assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, {});
    const unauthenticated = await fetch(`${f.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(unauthenticated.status, 401); await unauthenticated.text();
  });

  test(`${path}: a drained live request remains a monitored 500`, { timeout: 5_000 }, async t => {
    const f = await fixture(t, path, { drain: true });
    const result = await f.post(); assert.equal(result.status, 500); await result.text();
    assert.equal((f.errors[0] as { type: string }).type, "stream.not.readable");
    assert.equal(f.req.destroyed, true, "IncomingMessage.destroyed must not classify the live transport as cancelled");
    assert.equal(f.routeCount, 0); assert.equal(f.monitor.mock.callCount(), 1);
    assert.equal(f.monitor.mock.calls[0]!.arguments[0], "api_error");
    assert.equal(f.logs.filter(args => String(args[0]).includes('"event":"request_body_parser_live_unreadable"')).length, 1);
    assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, { requestBodyParserLiveUnreadable: 1 });
  });
}

test("malformed and oversized live JSON keep their monitored 400/413 responses", { timeout: 5_000 }, async t => {
  const f = await fixture(t, paths[0]!);
  for (const [payload, status] of [["{", 400], [JSON.stringify({ large: "x".repeat(1_048_576) }), 413]] as const) {
    const result = await f.post(payload); assert.equal(result.status, status); await result.text();
  }
  assert.equal(f.routeCount, 0); assert.equal(f.monitor.mock.callCount(), 2);
  assert.ok(f.monitor.mock.calls.every(call => call.arguments[0] === "client_error"));
  assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, {});
});

test("unrelated failures after disconnection still alert without writing the closed response", { timeout: 5_000 }, async t => {
  const f = await fixture(t, paths[0]!, { failAfterClose: true });
  const client = f.client(body); await f.routeEntered.promise;
  const responseJson = t.mock.method(f.res, "json", () => { throw new Error("write after disconnect"); });
  client.destroy(); await f.errorEntered.promise;
  assert.equal(f.monitor.mock.callCount(), 1); assert.equal(responseJson.mock.callCount(), 0);
  assert.equal(f.monitor.mock.calls[0]!.arguments[0], "api_error");
  assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, {});
});

test("live-stream diagnostics have a fixed field set and bounded per-minute volume", { timeout: 5_000 }, async t => {
  const f = await fixture(t, paths[0]!, { failAfterClose: true });
  const client = f.client(body); await f.routeEntered.promise;
  let now = 0;
  const lines: string[] = [];
  const diagnose = createRequestBodyFailureDiagnostics({ now: () => now, sink: line => { lines.push(line); } });
  assert.equal(f.req.socket.destroyed, false);
  for (let i = 0; i < 25; i++) assert.equal(diagnose({ type: "stream.not.readable", body: "sensitive", message: "sensitive" }, f.req, f.res), false);
  assert.equal(lines.length, 20);
  assert.ok(lines.every(line => !line.includes("sensitive") && !line.includes("synthetic-test-student")));
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!) as object).sort(), [
    "elapsedMs", "event", "requestAborted", "requestComplete", "requestDestroyed", "requestReadable", "requestReadableEnded",
    "responseDestroyed", "responseHeadersSent", "responseWritableEnded", "socketDestroyed", "surface",
  ].sort());
  now = 60_000; diagnose({ type: "stream.not.readable" }, f.req, f.res);
  assert.equal(lines.length, 21);
  client.destroy(); await f.errorEntered.promise;
});

test("a typed request.aborted error on a live transport retains client-error monitoring", { timeout: 5_000 }, async t => {
  const error = Object.assign(new Error("request aborted"), { type: "request.aborted", status: 400 });
  const f = await fixture(t, paths[0]!, { liveError: error });
  const result = await f.post(); assert.equal(result.status, 400); await result.text();
  assert.equal(f.monitor.mock.callCount(), 1);
  assert.equal(f.monitor.mock.calls[0]!.arguments[0], "client_error");
  assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, {});
});
