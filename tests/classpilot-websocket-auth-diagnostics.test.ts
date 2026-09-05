import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";
import ts from "typescript";
import { type ErrorMonitor } from "../src/services/errorMonitor.js";
import {
  reportStudentWebSocketAuthenticationFailure,
  type StudentWebSocketAuthStage,
} from "../src/services/classpilotWebSocketAuthDiagnostics.js";

// Execute the real production branch with controlled I/O. The stage assignment,
// token/denial branches, transaction callbacks and failure catch all come from
// websocket.ts rather than a parallel implementation or a supplied stage value.
const source = readFileSync(new URL("../src/realtime/websocket.ts", import.meta.url), "utf8");
const start = source.indexOf('if (message.role === "student" && message.deviceId) {');
const end = source.indexOf("// Staff auth via userToken", start);
assert.ok(start > 0 && end > start);
const executable = ts.transpileModule(`async function bootstrap() { ${source.slice(start, end)} }; bootstrap;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function bootstrapScenario(failure?: StudentWebSocketAuthStage | "invalid_token" | "inactive_session" | "not_entitled" | "peer_closed") {
  const messages: Array<{ type: string; message?: string }> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const diagnostics: string[] = [];
  const alerts: Array<Parameters<ErrorMonitor["trackError"]>> = [];
  const counters = new Map<string, number>();
  let removed = 0;
  let controlReads = 0;
  class InvalidTokenError extends Error {}
  class TokenExpiredError extends Error {}
  const fail = (stage: StudentWebSocketAuthStage) => {
    if (failure === stage) {
      throw new Error("private SQL params student@example.edu school-private", {
        cause: Object.assign(new Error("private driver error"), { code: "ECONNRESET" }),
      });
    }
  };
  const payload = { schoolId: "school-fixture", deviceId: "device-fixture", studentId: "student-fixture", sessionId: "session-fixture" };
  const ws = {
    readyState: failure === "peer_closed" ? 3 : 1,
    send: (data: string) => { messages.push(JSON.parse(data)); },
    close: (code?: number, reason?: string) => { closes.push({ code, reason }); },
  };
  const context = {
    message: { role: "student", deviceId: payload.deviceId, studentToken: "signed-fixture-token" },
    ws,
    WebSocket: { OPEN: 1 },
    performance,
    InvalidTokenError,
    TokenExpiredError,
    process: { env: {} },
    activity: { studentAuthenticated: 0 },
    webSocketWork: { canStart: () => true },
    recordRuntimePerformanceCounter: (name: string) => { counters.set(name, (counters.get(name) ?? 0) + 1); },
    recordRuntimePerformanceTiming: () => {},
    recordHeartbeatHotPathCounter: () => {},
    verifyStudentToken: () => {
      if (failure === "invalid_token") throw new InvalidTokenError("invalid token");
      return payload;
    },
    runWithTenantContext: async (_scope: unknown, work: () => Promise<unknown>) => {
      fail("tenant_checkout");
      return work();
    },
    resolveActiveStudentTokenSession: async () => {
      fail("session_resolution");
      return failure === "inactive_session" ? null : { id: payload.sessionId };
    },
    resolveClasspilotEntitlement: async () => {
      fail("entitlement");
      return { entitled: failure !== "not_entitled" };
    },
    getSettingsForSchool: async () => { fail("settings_protocol"); return {}; },
    negotiateClasspilotSurfaceProtocol: () => ({ acceptedCapabilities: ["screenshotActiveObservationCadenceV1"] }),
    getClasspilotStudentControlState: async () => {
      if (++controlReads === 1) fail("observation_hint");
      return { teachingSessionId: "class-fixture", revision: 1 };
    },
    classpilotObservationStatus: async () => ({ status: "observed", expiresInSeconds: 120 }),
    withClasspilotStudentWebSocketBootstrapAuthority: async (
      _binding: unknown,
      prepare: (db: object) => Promise<unknown>,
      deliver: (messages: unknown[], prepared: unknown) => void,
    ) => {
      fail("authority_lock");
      const prepared = await prepare({});
      deliver([], prepared);
      fail("transaction_completion");
      return { authorized: true };
    },
    lockClasspilotSsoPolicyDeliveryAuthority: async () => { fail("bootstrap_projection"); },
    buildStudentFabState: async () => ({}),
    getClasspilotSsoPolicyForSchool: async () => ({ policy: {}, revision: 1 }),
    getClasspilotScreenshotAuthorityProjection: async () => ({}),
    serializeClasspilotStudentControlStateForDelivery: () => ({ classroomState: { revision: 1 }, withheld: false }),
    isClasspilotCapabilityActive: () => true,
    resolveClasspilotScreenshotPolicy: async () => ({}),
    classpilotScreenshotAuthorityForDeliveredControl: () => ({}),
    classpilotControlStateExactBinding: () => ({}),
    clearStaffPresence: () => {},
    authenticateWsClient: () => failure === "socket_delivery" ? false : {},
    removeWsClient: () => { removed += 1; },
    reportStudentWebSocketAuthenticationFailure: (error: unknown, stage: StudentWebSocketAuthStage, job: "studentWebSocketAuth") =>
      reportStudentWebSocketAuthenticationFailure(error, stage, job, {
        sink: (line) => { diagnostics.push(line); },
        monitor: { trackError: (...args: Parameters<ErrorMonitor["trackError"]>) => { alerts.push(args); } },
      }),
  };
  const bootstrap = runInNewContext(executable, context) as () => Promise<void>;
  await bootstrap();
  return { messages, closes, diagnostics, alerts, counters, removed };
}

describe("student WebSocket bootstrap operational diagnostics", () => {
  for (const stage of [
    "tenant_checkout", "session_resolution", "entitlement", "settings_protocol", "observation_hint",
    "authority_lock", "bootstrap_projection", "socket_delivery", "transaction_completion",
  ] as const) {
    it(`reports the actual ${stage} failure and preserves the service-unavailable response`, async () => {
      const result = await bootstrapScenario(stage);
      assert.equal(result.diagnostics.length, 1);
      const event = JSON.parse(result.diagnostics[0]!);
      assert.equal(event.stage, stage);
      assert.equal(event.cause, stage === "socket_delivery" ? "registration_unavailable" : "connection_reset");
      assert.equal(result.messages.at(-1)?.message, "Authentication service unavailable");
      assert.deepEqual(result.closes.at(-1), { code: 1013, reason: "Authentication service unavailable" });
      assert.equal(result.counters.get("studentWebSocketAuthAttempt"), 1);
      assert.equal(result.counters.get("studentWebSocketAuthSuccess") ?? 0, 0);
      assert.equal(result.counters.get("studentWebSocketAuthDenied") ?? 0, 0);
      assert.equal(result.removed, stage === "transaction_completion" ? 1 : 0);
      assert.doesNotMatch(result.diagnostics.join("\n"), /school-fixture|device-fixture|student-fixture|session-fixture|student@example|private SQL|params|school-private/);
      assert.equal(result.alerts[0]?.[3]?.persist, false);
    });
  }

  it("keeps invalid credentials and inactive entitlement out of operational failures", async () => {
    for (const failure of ["invalid_token", "inactive_session", "not_entitled"] as const) {
      const result = await bootstrapScenario(failure);
      assert.equal(result.diagnostics.length, 0);
      assert.equal(result.alerts.length, 0);
      assert.equal(result.counters.get("studentWebSocketAuthDenied"), 1);
      assert.equal(result.messages.at(-1)?.message,
        failure === "invalid_token" ? "Invalid token" : "Student session is no longer active");
    }
  });

  it("counts an ordinary peer closure without a database alert", async () => {
    const result = await bootstrapScenario("peer_closed");
    assert.equal(JSON.parse(result.diagnostics[0]!).cause, "socket_closed");
    assert.equal(result.alerts.length, 0);
    assert.equal(result.messages.length, 0);
  });

  it("records success only after the authoritative transaction completed", async () => {
    const result = await bootstrapScenario();
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.messages[0]?.type, "auth-success");
    assert.equal(result.counters.get("studentWebSocketAuthAttempt"), 1);
    assert.equal(result.counters.get("studentWebSocketAuthSuccess"), 1);
    assert.equal(result.closes.length, 0);
  });
});
