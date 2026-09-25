import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import { myDeskUpstreamErrorBoundary } from "../src/middleware/mydeskUpstreamErrorBoundary.js";

const canary = "Private meeting with student LavenderOtter123";
const downstreamErrors: unknown[] = [];
let server: Server, origin: string;

before(async () => {
  const app = express();
  // Same ordering as createApp: body parsing and upstream middleware precede routes and the scoped error boundary.
  app.use(express.json({ limit: "1kb" }));
  app.use((req, _res, next) => {
    if (req.path.endsWith("/upstream-failure")) return next(Object.assign(new Error(canary), { details: { body: canary }, status: 400 }));
    next();
  });
  app.post("/api/mydesk/notes", (_req, res) => { res.json({ ok: true }); });
  app.post("/api/other/notes", (_req, res) => { res.json({ ok: true }); });
  app.use("/api/mydesk", myDeskUpstreamErrorBoundary);
  const downstream: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    downstreamErrors.push(error); res.status(500).json({ code: "GLOBAL_ERROR_HANDLER" });
  };
  app.use(downstream);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function post(path: string, body: string) {
  return fetch(origin + path, { method: "POST", headers: { "content-type": "application/json" }, body });
}
async function assertPrivate(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const text = await response.text(); assert.ok(!text.includes(canary));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["code", "error"]);
  assert.equal(JSON.parse(text).code, code);
}

test("malformed My Desk JSON never forwards the parser error or private body to the global handler", async () => {
  const beforeCount = downstreamErrors.length;
  await assertPrivate(await post("/api/mydesk/notes", `{"body":"${canary}", broken}`), 400, "MYDESK_INVALID_REQUEST");
  assert.equal(downstreamErrors.length, beforeCount);
});

test("oversized My Desk JSON receives only a bounded private 413 response", async () => {
  const beforeCount = downstreamErrors.length;
  await assertPrivate(await post("/api/mydesk/notes", JSON.stringify({ body: canary.repeat(100) })), 413, "MYDESK_REQUEST_TOO_LARGE");
  assert.equal(downstreamErrors.length, beforeCount);
});

test("unexpected errors before the router emit only an operational code and a generic private 503", async t => {
  const beforeCount = downstreamErrors.length;
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...values: unknown[]) => { logs.push(values); });
  await assertPrivate(await post("/api/mydesk/upstream-failure", "{}"), 503, "MYDESK_UNAVAILABLE");
  assert.equal(downstreamErrors.length, beforeCount);
  assert.deepEqual(logs, [[JSON.stringify({ event: "mydesk_upstream_error", code: "MYDESK_UNAVAILABLE" })]]);
});

test("valid requests and unrelated or similarly prefixed API errors keep their existing routing", async () => {
  const successful = await post("/api/mydesk/notes", JSON.stringify({ body: canary }));
  assert.equal(successful.status, 200); assert.deepEqual(await successful.json(), { ok: true });
  const beforeCount = downstreamErrors.length;
  for (const path of ["/api/other/upstream-failure", "/api/mydesk-other/upstream-failure"]) {
    const response = await post(path, "{}"); assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { code: "GLOBAL_ERROR_HANDLER" });
  }
  assert.equal(downstreamErrors.length, beforeCount + 2);
  assert.ok(downstreamErrors.slice(beforeCount).every(error => error instanceof Error && error.message === canary));
  const malformed = await post("/api/other/notes", `{"body":"${canary}", broken}`);
  assert.equal(malformed.status, 500); assert.equal(downstreamErrors.length, beforeCount + 3);
});
