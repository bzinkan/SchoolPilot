import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, it } from "node:test";
import { createStudentSignInDiagnostics, STUDENT_SIGN_IN_REASON_COUNTERS } from "../src/services/classpilotStudentSignInDiagnostics.js";
import type { RuntimePerformanceCounter } from "../src/services/runtimePerformanceMetrics.js";
import { markTenantPoolAcquisitionFailureReported } from "../src/util/operationalErrors.js";

type Counts = Partial<Record<RuntimePerformanceCounter, number>>;
function harness(options: { sinkThrows?: boolean; countersThrow?: boolean } = {}) {
  let wall = 0;
  let elapsed = 0;
  let id = 0;
  const lines: string[] = [];
  const updates: Counts[] = [];
  const diagnostics = createStudentSignInDiagnostics({
    now: () => wall,
    elapsedNow: () => elapsed,
    randomId: () => "00000000-0000-4000-8000-" + String(++id).padStart(12, "0"),
    sink(line) {
      if (options.sinkThrows) throw new Error("private sink failure");
      lines.push(line);
    },
    recordCounters(counts) {
      if (options.countersThrow) throw new Error("private metrics sink failure");
      updates.push({ ...counts });
    },
  });
  function request(path = "/api/extension/student-login", method = "POST") {
    const req: Partial<Request> = { path, method, requestId: "student-secret-token", headers: { "x-request-id": "student-secret-token" } };
    const response = Object.assign(new EventEmitter(), { statusCode: 401 });
    let nextCalls = 0;
    const observe = () => diagnostics.studentSignInDiagnostics(req as Request, response as Response, () => { nextCalls += 1; });
    observe();
    return { req, response, observe, nextCalls: () => nextCalls };
  }
  const total = (name: RuntimePerformanceCounter) => updates.reduce((n, counts) => n + (counts[name] ?? 0), 0);
  return { diagnostics, request, lines, updates, total, setWall: (value: number) => { wall = value; }, setElapsed: (value: number) => { elapsed = value; } };
}

describe("private student sign-in terminal diagnostics", () => {
  it("matches only exact POST aliases, including Express case/trailing-slash variants", () => {
    const h = harness();
    for (const path of ["/api/extension/student-login", "/api/classpilot/extension/student-login/", "/API/ClassPilot/Extension/Student-Login"]) {
      h.request(path).response.emit("finish");
    }
    for (const [path, method] of [
      ["/api/extension/student-login-else", "POST"],
      ["/api/extension/student-login/extra", "POST"],
      ["/api/other/extension/student-login", "POST"],
      ["/api/extension/student-login", "GET"],
    ]) h.request(path, method).response.emit("finish");
    assert.equal(h.lines.length, 3);
    assert.equal(h.total("studentSignInFailure"), 3);
    assert.ok(h.lines.every(line => JSON.parse(line).reason === "UNCLASSIFIED_HTTP_FAILURE"));
  });

  it("records once despite duplicate observation, finish, close and late marks", () => {
    const h = harness();
    const r = h.request();
    r.observe();
    h.diagnostics.markStudentSignInStage(r.req, "credential_check");
    h.diagnostics.markStudentSignInMethod(r.req, "name_pin");
    h.diagnostics.markStudentSignInFailure(r.req, "PIN_MISMATCH");
    h.setElapsed(12.6);
    r.response.emit("finish");
    h.diagnostics.markStudentSignInFailure(r.req, "PIN_LOCKOUT");
    r.response.emit("finish");
    r.response.emit("close");
    assert.equal(r.nextCalls(), 2);
    assert.equal(h.updates.length, 1);
    assert.deepEqual(h.updates[0], {
      studentSignInCompleted: 1, studentSignInFailure: 1, studentSignInReasonPinMismatch: 1,
    });
    assert.deepEqual(Object.keys(JSON.parse(h.lines[0]!)).sort(), [
      "Environment", "InstanceId", "Release", "Service", "diagnosticId", "elapsedMs",
      "event", "httpStatus", "method", "reason", "route", "schemaVersion", "stage", "timestampUtc",
    ].sort());
    assert.equal(JSON.parse(h.lines[0]!).elapsedMs, 13);
    assert.equal(JSON.parse(h.lines[0]!).stage, "credential_check");
  });

  it("counts only completed 2xx as success and emits no detailed success", () => {
    const h = harness();
    const r = h.request();
    h.diagnostics.markStudentSignInFailure(r.req, "PIN_MISMATCH");
    r.response.statusCode = 200;
    r.response.emit("finish");
    r.response.emit("close");
    assert.deepEqual(h.updates, [{ studentSignInCompleted: 1, studentSignInSuccess: 1 }]);
    assert.equal(h.lines.length, 0);
    const aborted = h.request();
    aborted.response.statusCode = 200;
    h.diagnostics.markStudentSignInFailure(aborted.req, "PIN_LOCKOUT");
    aborted.response.emit("close");
    aborted.response.emit("finish");
    const event = JSON.parse(h.lines[0]!);
    assert.equal(event.reason, "REQUEST_INTERRUPTED");
    assert.equal(event.httpStatus, null);
    assert.equal(h.total("studentSignInCompleted"), 2);
    assert.equal(h.total("studentSignInFailure"), 1);
  });

  it("never reads request credentials, inbound IDs, error messages, stacks or arbitrary values", () => {
    const h = harness();
    const a = h.request(), b = h.request();
    for (const r of [a, b]) {
      for (const field of ["body", "headers", "requestId", "originalUrl", "ip"]) {
        Object.defineProperty(r.req, field, { get() { throw new Error("private " + field); } });
      }
      const secret = Object.defineProperties({}, {
        code: { value: "private-school-secret" },
        message: { get() { throw new Error("private message"); } },
        stack: { get() { throw new Error("private stack"); } },
      });
      h.diagnostics.markStudentSignInError(r.req, secret);
      r.response.statusCode = 500;
      r.response.emit("finish");
    }
    assert.equal(h.lines.length, 2);
    assert.notEqual(JSON.parse(h.lines[0]!).diagnosticId, JSON.parse(h.lines[1]!).diagnosticId);
    assert.ok(h.lines.every(line => JSON.parse(line).reason === "INTERNAL_ERROR"));
    assert.doesNotMatch(JSON.stringify(h.updates) + h.lines.join(""), /private|school-secret|student-secret|token/i);
    const hostile = h.request();
    h.diagnostics.markStudentSignInError(hostile.req, Object.defineProperties({}, {
      code: { get() { throw new Error("private code"); } },
      type: { get() { throw new Error("private parser type"); } },
      cause: { get() { throw new Error("private cause"); } },
    }));
    hostile.response.emit("finish");
    assert.equal(JSON.parse(h.lines.at(-1)!).reason, "INTERNAL_ERROR");
  });

  it("maps only fixed issuance/parser/operational errors and handles bounded cause cycles", () => {
    const h = harness();
    const poolError = new Error("private SQL");
    markTenantPoolAcquisitionFailureReported(poolError);
    const cycle: { cause?: object; code: string } = { code: "ECONNRESET" };
    cycle.cause = cycle;
    for (const [error, expected] of [
      [{ code: "CLASSPILOT_NOT_ENTITLED" }, "ENTITLEMENT_DENIED"],
      [{ code: "STUDENT_SESSION_ACTIVE" }, "STUDENT_SESSION_ACTIVE"],
      [{ code: "STUDENT_DEVICE_UNAVAILABLE" }, "STUDENT_DEVICE_UNAVAILABLE"],
      [{ type: "entity.parse.failed" }, "REQUEST_BODY_INVALID"],
      [{ type: "entity.too.large" }, "REQUEST_BODY_TOO_LARGE"],
      [{ type: "encoding.unsupported" }, "REQUEST_ENCODING_UNSUPPORTED"],
      [new Error("private wrapper", { cause: poolError }), "POOL_ACQUISITION_FAILED"],
      [{ code: "57014" }, "QUERY_CANCELLED"],
      [{ code: "55P03" }, "AUTHORITY_CONTENTION"],
      [cycle, "CONNECTION_RESET"],
      [{ code: "__proto__" }, "INTERNAL_ERROR"],
      [{ code: "57014-private" }, "INTERNAL_ERROR"],
    ] as const) {
      const r = h.request();
      h.diagnostics.markStudentSignInError(r.req, error);
      r.response.emit("finish");
      assert.equal(JSON.parse(h.lines.at(-1)!).reason, expected);
    }
    let wrapped: Error = Object.assign(new Error("private leaf"), { code: "STUDENT_SESSION_ACTIVE" });
    for (let i = 0; i < 4; i += 1) wrapped = new Error("private wrapper", { cause: wrapped });
    const r = h.request();
    h.diagnostics.markStudentSignInError(r.req, wrapped);
    r.response.emit("finish");
    assert.equal(JSON.parse(h.lines.at(-1)!).reason, "INTERNAL_ERROR");
  });

  it("keeps 121 failures unsampled while capping detail at 120 and resists clock rollback", () => {
    const h = harness();
    const fail = () => {
      const r = h.request();
      h.diagnostics.markStudentSignInFailure(r.req, "STUDENT_LOGIN_RATE_LIMIT");
      r.response.statusCode = 429;
      r.response.emit("finish");
    };
    for (let i = 0; i < 121; i += 1) fail();
    assert.equal(h.lines.length, 120);
    assert.equal(h.total("studentSignInCompleted"), 121);
    assert.equal(h.total("studentSignInReasonStudentLoginRateLimit"), 121);
    assert.equal(h.total("studentSignInDiagnosticSuppressed"), 1);
    h.setWall(-60_000);
    fail();
    assert.equal(h.lines.length, 120);
    assert.equal(h.total("studentSignInDiagnosticSuppressed"), 2);
    h.setWall(60_000);
    fail();
    assert.equal(h.lines.length, 121);
    assert.equal(h.total("studentSignInFailure"), 123);
  });

  it("isolates detail and counter sink failures without alerting or changing response state", () => {
    const h = harness({ sinkThrows: true });
    for (let i = 0; i < 121; i += 1) {
      const r = h.request();
      assert.doesNotThrow(() => r.response.emit("finish"));
      assert.equal(r.response.statusCode, 401);
    }
    assert.equal(h.total("studentSignInFailure"), 121);
    assert.equal(h.total("studentSignInDiagnosticSinkFailure"), 120);
    assert.equal(h.total("studentSignInDiagnosticSuppressed"), 1);
    const unavailable = harness({ countersThrow: true, sinkThrows: true });
    assert.doesNotThrow(() => unavailable.request().response.emit("finish"));
  });

  it("validates runtime label inputs and preserves once-only behavior across marker races", () => {
    const h = harness(), r = h.request();
    Reflect.apply(h.diagnostics.markStudentSignInStage, null, [r.req, "private-stage"]);
    Reflect.apply(h.diagnostics.markStudentSignInMethod, null, [r.req, "private-method"]);
    Reflect.apply(h.diagnostics.markStudentSignInFailure, null, [r.req, "private-reason"]);
    h.diagnostics.markStudentSignInFailure(r.req, "PIN_MISMATCH");
    h.diagnostics.markStudentSignInError(r.req, new Error("post-decision failure"));
    h.setElapsed(-10);
    r.response.statusCode = 500;
    r.response.emit("finish");
    assert.equal(JSON.parse(h.lines[0]!).reason, "INTERNAL_ERROR");
    assert.equal(JSON.parse(h.lines[0]!).stage, "ingress");
    assert.equal(JSON.parse(h.lines[0]!).method, "unknown");
    assert.equal(JSON.parse(h.lines[0]!).elapsedMs, 0);
    assert.equal(h.total("studentSignInFailure"), 1);
    const reasonSum = Object.values(STUDENT_SIGN_IN_REASON_COUNTERS).reduce((sum, key) => sum + h.total(key), 0);
    assert.equal(reasonSum, h.total("studentSignInFailure"));
    assert.doesNotThrow(() => Reflect.apply(h.diagnostics.markStudentSignInError, null, [null, new Error()]));
  });
});
