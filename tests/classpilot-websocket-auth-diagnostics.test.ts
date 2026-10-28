import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";
import ts from "typescript";
import { z } from "zod";
import { type ErrorMonitor } from "../src/services/errorMonitor.js";
import { resolveClasspilotMonitoringPolicy } from "../src/services/classpilotMonitoringPolicy.js";
import { classpilotControlAuthorityRevisionForDelivery } from "../src/services/classpilotClassroomState.js";
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

type WithheldReason = Parameters<typeof classpilotControlAuthorityRevisionForDelivery>[0]["delivery"]["withheldReason"];
async function bootstrapScenario(failure?: StudentWebSocketAuthStage | "invalid_token" | "inactive_session" | "not_entitled" | "peer_closed" | "retirement",
  delivery: { withheldReason?: WithheldReason; supervision?: boolean } = {}) {
  const messages: Array<{ type: string; message?: string }> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const diagnostics: string[] = [];
  const alerts: Array<Parameters<ErrorMonitor["trackError"]>> = [];
  const counters = new Map<string, number>();
  let removed = 0;
  let controlReads = 0;
  let authorityHeld = false;
  let retirementFinished = false;
  const transactionDb = {};
  const scope = delivery.supervision
    ? { teachingSessionId: null, supervisionContextId: "context-fixture" }
    : { teachingSessionId: "class-fixture", supervisionContextId: null };
  const storedControlState = { ...scope, revision: 1 };
  const retiredControlState = { ...storedControlState, revision: 2 };
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
    getHeartbeatTrackingSettingsForSchool: async () => { fail("settings_protocol"); return { enableTrackingHours: false }; },
    resolveClasspilotMonitoringPolicy,
    getSchoolWebsitePolicy: async () => ({ policyRevision: 0, blockedDomains: [] }),
    negotiateClasspilotSurfaceProtocol: () => ({ acceptedCapabilities: ["screenshotActiveObservationCadenceV1"] }),
    getClasspilotStudentControlState: async (schoolId: string, studentId: string, database?: object) => {
      if (++controlReads === 1) fail("observation_hint");
      else {
        assert.equal(authorityHeld, true);
        assert.equal(database, transactionDb);
        assert.equal(schoolId, payload.schoolId);
        assert.equal(studentId, payload.studentId);
      }
      return storedControlState;
    },
    classpilotObservationStatus: async () => ({ status: "observed", expiresInSeconds: 120 }),
    withClasspilotStudentWebSocketBootstrapAuthority: async (
      binding: { freezeSsoPolicy?: boolean },
      prepare: (db: object) => Promise<unknown>,
      deliver: (messages: unknown[], prepared: unknown) => void,
    ) => {
      assert.equal(binding.freezeSsoPolicy, true, "The real bootstrap adapter must request the pre-claim SSO fence");
      fail("authority_lock");
      authorityHeld = true;
      try {
        const prepared = await prepare(transactionDb);
        assert.equal(retirementFinished, true, "Retirement finishes before registration or socket delivery");
        deliver([], prepared);
        fail("transaction_completion");
        return { authorized: true };
      } finally {
        authorityHeld = false;
      }
    },
    buildStudentFabState: async () => { fail("bootstrap_projection"); return { ...scope, ownershipRevision: 1,
      activeSessionIds: delivery.supervision ? [] : ["class-fixture"],
      activeContexts: [delivery.supervision ? { supervisionContextId: "context-fixture" } : { teachingSessionId: "class-fixture" }] }; },
    getClasspilotSsoPolicyForSchool: async () => ({ policy: {}, revision: 1 }),
    retireLegacyTabFocusForStudentLocked: async (database: object, options: {
      schoolId: string; studentId: string; state: object; reason: string;
    }) => {
      assert.equal(database, transactionDb);
      assert.equal(authorityHeld, true);
      assert.equal(controlReads, 2, "Retirement follows the authoritative control read");
      assert.equal(options.schoolId, payload.schoolId);
      assert.equal(options.studentId, payload.studentId);
      assert.equal(options.state, storedControlState);
      assert.equal(options.reason, "reconnect");
      if (failure === "retirement") throw Object.assign(new Error("private retirement failure"), { code: "ECONNRESET" });
      retirementFinished = true;
      return retiredControlState;
    },
    getClasspilotScreenshotAuthorityProjection: async () => {
      assert.equal(retirementFinished, true);
      return {};
    },
    serializeClasspilotStudentControlStateForDelivery: (options: { state: object }) => {
      assert.equal(authorityHeld, true);
      assert.equal(retirementFinished, true);
      assert.equal(options.state, retiredControlState);
      return delivery.withheldReason
        ? { classroomState: null, withheld: true, withheldReason: delivery.withheldReason }
        : { classroomState: { revision: retiredControlState.revision }, withheld: false };
    },
    classpilotControlAuthorityRevisionForDelivery,
    prepareClasspilotFocusCleanupFrame: async () => null,
    isClasspilotCapabilityActive: () => true,
    resolveClasspilotScreenshotPolicy: async () => ({}),
    classpilotScreenshotAuthorityForDeliveredControl: () => ({}),
    classpilotControlStateExactBinding: (value: object) => value,
    clearStaffPresence: () => {},
    classpilotTransientReplayOnAuthEnabled: () => true,
    prepareClasspilotTransientCommandReplay: async () => [{ type: "remote-control", _msgId: "replayed-fixture" }],
    authenticateWsClient: () => {
      assert.equal(authorityHeld, true);
      assert.equal(retirementFinished, true);
      return failure === "socket_delivery" ? false : {};
    },
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
      assert.equal(result.counters.get("transientCommandReplayedOnAuth") ?? 0, 0,
        "a replay queued inside a transaction that did not complete is never counted");
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
    const bootstrap = z.object({
      type: z.literal("auth-success"),
      classroomState: z.object({ revision: z.number().int() }),
      settings: z.object({ fab: z.object({ ownershipRevision: z.number().int() }) }),
    }).parse(result.messages[0]);
    assert.equal(bootstrap.classroomState.revision, 2);
    assert.equal(bootstrap.settings.fab.ownershipRevision, 2, "FAB matches the post-retirement state delivered in the same bootstrap");
    assert.equal(result.counters.get("studentWebSocketAuthAttempt"), 1);
    assert.equal(result.counters.get("studentWebSocketAuthSuccess"), 1);
    assert.equal(result.closes.length, 0);
  });

  it("reports retirement failure as bootstrap projection and never registers or sends stale state", async () => {
    const result = await bootstrapScenario("retirement");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(JSON.parse(result.diagnostics[0]!).stage, "bootstrap_projection");
    assert.equal(JSON.parse(result.diagnostics[0]!).cause, "connection_reset");
    assert.equal(result.messages.some(message => message.type === "auth-success"), false);
    assert.equal(result.messages.at(-1)?.message, "Authentication service unavailable");
    assert.deepEqual(result.closes.at(-1), { code: 1013, reason: "Authentication service unavailable" });
    assert.equal(result.counters.get("studentWebSocketAuthSuccess") ?? 0, 0);
    assert.equal(result.counters.get("transientCommandReplayedOnAuth") ?? 0, 0);
    assert.equal(result.removed, 0);
    assert.doesNotMatch(result.diagnostics.join("\n"), /private retirement/);
  });

  it("retains exact FAB ownership when a restriction-only capability withholds the snapshot", async () => {
    for (const withheldReason of ["restriction_auth_update_required", "precise_restriction_capability_required", "focus_tab_capability_required"] as const) {
      for (const supervision of [false, true]) {
        const result = await bootstrapScenario(undefined, { withheldReason, supervision });
        assert.deepEqual(result.diagnostics, []);
        const bootstrap = z.object({
          type: z.literal("auth-success"), classroomState: z.null(),
          exactBinding: z.object({ controlRevision: z.number().int() }),
          settings: z.object({ fab: z.object({ ownershipRevision: z.number().int(), activeContexts: z.array(z.unknown()) }) }),
        }).parse(result.messages[0]);
        assert.equal(bootstrap.exactBinding.controlRevision, 2);
        assert.equal(bootstrap.settings.fab.ownershipRevision, 2, `${withheldReason} preserves the retired canonical revision`);
        assert.deepEqual(bootstrap.settings.fab.activeContexts, [supervision
          ? { supervisionContextId: "context-fixture" } : { teachingSessionId: "class-fixture" }]);
      }
    }
  });

  it("keeps the entire deferred-origin revision hidden during WebSocket bootstrap", async () => {
    const result = await bootstrapScenario(undefined, { withheldReason: "late_sign_in_capability_required" });
    const bootstrap = z.object({
      classroomState: z.null(), exactBinding: z.object({ controlRevision: z.number().int() }),
      settings: z.object({ fab: z.object({ ownershipRevision: z.number().int() }) }),
    }).parse(result.messages[0]);
    assert.equal(bootstrap.exactBinding.controlRevision, 0);
    assert.equal(bootstrap.settings.fab.ownershipRevision, 0);
  });

  it("sends replayed transient frames after auth-success and counts them once the transaction completed", async () => {
    const result = await bootstrapScenario();
    assert.deepEqual(
      result.messages.map((message) => message.type),
      ["auth-success", "remote-control"],
      "the replay follows the authoritative bootstrap inside the same synchronous delivery callback",
    );
    assert.equal((result.messages[1] as { _msgId?: string })._msgId, "replayed-fixture");
    assert.equal(result.counters.get("transientCommandReplayedOnAuth"), 1);
  });
});
