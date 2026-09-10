import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, type TestContext } from "node:test";
import express from "express";
import { requestId } from "../src/middleware/requestId.js";
import { apiLimiter } from "../src/middleware/rateLimiter.js";
import {
  studentSignInDiagnostics,
  markStudentSignInError,
  markStudentSignInFailure,
  markStudentSignInMethod,
} from "../src/services/classpilotStudentSignInDiagnostics.js";
import { snapshotRuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

type Event = { event: string; reason: string; diagnosticId: string; httpStatus: number | null };

function capture(t: TestContext): Event[] {
  const records: Event[] = [];
  t.mock.method(console, "log", (line: unknown) => {
    if (typeof line !== "string" || !line.startsWith("{")) return;
    const record = JSON.parse(line) as Event;
    if (typeof record.reason === "string") records.push(record);
  });
  return records;
}

async function serve(t: TestContext, app: express.Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("student sign-in ingress diagnostics", () => {
  it("covers aliases before body parsing and preserves generic responses and inbound request headers", async (t) => {
    const records = capture(t);
    const app = express();
    app.use(requestId, studentSignInDiagnostics, express.json());
    app.post(["/api/extension/student-login", "/api/classpilot/extension/student-login"], (req, res) => {
      markStudentSignInMethod(req, "name_pin");
      markStudentSignInFailure(req, "PIN_MISMATCH");
      res.status(401).json({ error: "Invalid student credentials" });
    });
    const base = await serve(t, app);
    const paths = ["/api/extension/student-login", "/api/classpilot/extension/student-login", "/API/CLASSPILOT/EXTENSION/STUDENT-LOGIN/"];
    for (const path of paths) {
      const response = await fetch(base + path + "?secret=private-query", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "private-reused-student-name" },
        body: JSON.stringify({ pin: "9876", studentId: "private-student", schoolId: "private-school" }),
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("x-request-id"), "private-reused-student-name");
      assert.deepEqual(await response.json(), { error: "Invalid student credentials" });
    }
    assert.equal(records.length, 3);
    assert.ok(records.every((record) => record.reason === "PIN_MISMATCH" && record.httpStatus === 401));
    assert.equal(new Set(records.map((record) => record.diagnosticId)).size, 3);
    assert.doesNotMatch(JSON.stringify(records), /private-|9876|secret|x-request-id/);
  });

  it("records malformed JSON before the route runs without exporting parser bodies or messages", async (t) => {
    const records = capture(t);
    const app = express();
    app.use(requestId, studentSignInDiagnostics, express.json());
    let routeCalls = 0;
    app.post("/api/extension/student-login", (_req, res) => { routeCalls++; res.sendStatus(204); });
    const handler: express.ErrorRequestHandler = (error: unknown, req, res, _next) => {
      markStudentSignInError(req, error);
      res.status(400).json({ error: "invalid json" });
    };
    app.use(handler);
    const base = await serve(t, app);
    const response = await fetch(base + "/api/extension/student-login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: '{"pin":"9876","student":"private-student",',
    });
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(routeCalls, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.httpStatus, 400);
    assert.equal(records[0]!.reason, "REQUEST_BODY_INVALID");
    assert.doesNotMatch(JSON.stringify(records), /private-student|9876|Unexpected|SyntaxError/);
  });

  it("distinguishes a real global limiter rejection and preserves its limit, headers and body", async (t) => {
    const records = capture(t);
    snapshotRuntimePerformanceMetrics({ reset: true });
    const app = express();
    app.set("trust proxy", 1);
    app.use(requestId, studentSignInDiagnostics, express.json());
    app.use("/api", apiLimiter);
    let routeCalls = 0;
    app.post("/api/extension/student-login", (_req, res) => { routeCalls++; res.json({ success: true }); });
    const base = await serve(t, app);
    const login = () => fetch(base + "/api/extension/student-login", {
      method: "POST", headers: { "x-forwarded-for": "192.0.2.81" },
    });
    for (let batch = 0; batch < 40; batch++) {
      const responses = await Promise.all(Array.from({ length: 25 }, login));
      for (const response of responses) {
        assert.equal(response.status, 200);
        await response.text();
      }
    }
    const denied = await login();
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("ratelimit-limit"), "1000");
    assert.equal(denied.headers.get("ratelimit-remaining"), "0");
    assert.ok(Number(denied.headers.get("retry-after")) > 0);
    assert.deepEqual(await denied.json(), { error: "Too many requests, please try again later" });
    assert.equal(routeCalls, 1000);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.reason, "GLOBAL_API_RATE_LIMIT");
    assert.equal(records[0]!.httpStatus, 429);
    assert.doesNotMatch(JSON.stringify(records), /192\.0\.2|forwarded|limiter.*key/i);
  });

  it("ignores non-login paths and is installed before parsers, limiters and the existing error handler", async (t) => {
    const records = capture(t);
    const app = express();
    app.use(studentSignInDiagnostics);
    app.all("*", (req, res) => {
      markStudentSignInFailure(req, "PIN_MISMATCH");
      res.sendStatus(401);
    });
    const base = await serve(t, app);
    for (const [method, path] of [["GET", "/api/extension/student-login"], ["POST", "/api/extension/student-login/other"], ["POST", "/api/auth/login"]]) {
      const response = await fetch(base + path, { method });
      await response.text();
    }
    assert.equal(records.length, 0);
    const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const install = source.indexOf("app.use(studentSignInDiagnostics)");
    assert.ok(install > source.indexOf("app.use(requestId)"));
    assert.ok(install < source.indexOf("express.json("));
    assert.ok(install < source.indexOf('app.use("/api", apiLimiter)'));
    const errorSource = readFileSync(new URL("../src/middleware/errorHandler.ts", import.meta.url), "utf8");
    assert.ok(errorSource.indexOf("markStudentSignInError(req, err)") < errorSource.indexOf('errorMonitor.trackError("api_error"'));
  });
});
