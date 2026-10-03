import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const foregroundStart = source.indexOf("    const completedHeartbeatTileCacheWrite = Promise.resolve(");
const foregroundEnd = source.indexOf("    // --- Deliver any missed messages", foregroundStart);
const deliveryStart = source.indexOf("    const teacherReplyCheckKey = `${studentSessionId}:${deviceId}`;", foregroundEnd);
const deliveryEnd = source.indexOf("\n  } catch (err)", deliveryStart);
assert.ok(foregroundStart >= 0 && foregroundEnd > foregroundStart && deliveryStart > foregroundEnd && deliveryEnd > deliveryStart);
// Execute both actual route slices together. Only unrelated inbox discovery is
// omitted; final tenant ownership, fallback dispatch and the barrier stay intact.
const executable = ts.transpileModule(`async function heartbeat() {
  let finishForegroundTelemetry = () => {};
  try { ${source.slice(foregroundStart, foregroundEnd)}
    const pendingMessages = [];
    const shouldCheckPendingMessages = false;
    const commitPendingInbox = () => {};
    ${source.slice(deliveryStart, deliveryEnd)}
  } finally { finishForegroundTelemetry(); }
}\nheartbeat;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type Fields = Record<string, unknown>;
type Foreground = { publish: () => Promise<void>; onFailure: () => void };
type Mode = "fallback" | "published" | "partial" | "suppressed" | "unauthorized" | "prepare-throws" | "final-fence-throws";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(mode: Mode, options: { holdRelease?: boolean; holdPublication?: boolean; failFallback?: boolean; nullClassification?: boolean } = {}) {
  const order: string[] = [], frames: Fields[] = [], historical: Fields[] = [], tracked: Promise<unknown>[] = [];
  const counters: string[] = [], phaseCounters: Array<{ name: string; operation: string }> = [];
  const release = deferred(), publication = deferred(), authorityReady = deferred();
  let held = false, foregroundAttempts = 0, fallbackCalls = 0;
  const snapshot = { revision: 3, observedAt: 1000, activeTabUrl: "https://www.ixl.com/math", heartbeatId: "heartbeat",
    state: "active", schoolId: "school", studentId: "student", studentSessionId: "login", deviceId: "device" };
  const classification = { category: "educational", contentCategory: "education", safetyAlert: null, domain: "www.ixl.com" };
  const response = {
    status(code: number) { order.push(`http:${code}`); return response; },
    json(value: Fields) { order.push(value.ok ? "http:ok" : "http:denied"); return value; },
  };
  const context = {
    Promise, Date, trackingWindowScreenshotLeaseNegotiated: true,
    schoolId: "school", studentId: "student", studentSessionId: "login", deviceId: "device", studentEmail: "synthetic@example.invalid",
    school: { domain: "example.invalid", planStatus: "active" }, heartbeat: { id: "heartbeat" }, controlState: { revision: 3 },
    persistedImmediateClassification: null, heartbeatTileCacheWritten: true, fabSyncPending: true,
    protocol: { acceptedCapabilities: ["scopedAuthorityChecksV1"] }, realtimeStatusMutation: { status: "updated", snapshot },
    activeTabUrl: snapshot.activeTabUrl, activeTabTitle: "Synthetic lesson", favicon: undefined, allOpenTabs: [], screenshotHealth: undefined,
    extensionVersion: "2.9.7", chromeVersion: "120", screenLocked: false, flightPathActive: false, activeFlightPathName: undefined,
    isScreenSharing: false, isScreenRecording: false, cameraActive: false, visibilityState: "visible", trackingStatus: "active",
    restrictionAuthStateByDevice: new Map(), MAX_DEVICE_HEARTBEAT_ENTRIES: 100, classroomState: { restrictions: {} },
    setBoundedMap(map: Map<string, unknown>, key: string, value: unknown) { map.set(key, value); },
    classpilotRestrictionAuthTransitionMetric() { return null; }, updateDeviceStatus() {},
    recordHeartbeatHotPathCounter(name: string) { counters.push(name); },
    recordUsageCapacityCounter(name: string, operation: string) { phaseCounters.push({ name, operation }); },
    recordRuntimePerformanceCounter() {},
    publicRealtimeFields(value: Fields) { return { revision: value.revision, activeTabUrl: value.activeTabUrl, allOpenTabs: [], acceptedCapabilities: ["scopedAuthorityChecksV1"] }; },
    realtimeControlAuthority() { return { teachingSessionId: "class", revision: 3 }; },
    async markClasspilotFabSyncPending() {}, res: response,
    async classifyUrl() { return options.nullClassification ? null : classification; },
    trackHeartbeatClassificationProducer(producer: Promise<unknown>) { tracked.push(producer); return producer; },
    async persistHeartbeatClassification(value: Fields) { order.push("historical"); historical.push(value); },
    async patchHeartbeatTileCacheClassifications() { order.push("tile-classification"); return true; }, async invalidateHeartbeatTileCaches() {},
    async patchClasspilotRealtimeClassification() { order.push("realtime-classification"); return { status: "updated", snapshot: { ...snapshot, revision: 4 } }; },
    updateDeviceClassification() {}, resolveCurrentClasspilotSafetyAction() { return null; },
    async publishRevisionedRealtimeUpdate(_snapshot: Fields, frame: Fields) {
      assert.equal(held, false, "a separate telemetry lease must never nest in final delivery");
      if (frame.type === "student-update") {
        fallbackCalls++; order.push("fallback");
        if (options.failFallback) throw new Error("synthetic fallback failure");
      } else order.push("ai-publication");
      frames.push(frame);
    },
    classpilotRealtimeOrderingKey(schoolId: string, deviceId: string) { return `${schoolId}:${deviceId}`; },
    async publishOrderedRealtimeAudience(frame: Fields, revision: string, audience: { target: Fields; scopedOrderedKey: string; deliverLocal: () => void }) {
      assert.equal(held, true); foregroundAttempts++; order.push("foreground");
      assert.equal(revision, "3");
      assert.deepEqual(JSON.parse(JSON.stringify(audience.target)), { kind: "staff-session", schoolId: "school", sessionId: "class" });
      assert.equal(audience.scopedOrderedKey, "school:device:session:class");
      audience.deliverLocal();
      if (options.holdPublication) await publication.promise;
      if (mode === "partial") throw new Error("synthetic partial transport failure");
      assert.equal(frame.type, "student-update");
    },
    broadcastToStaffSessionLocal(schoolId: string, sessionId: string, frame: Fields) {
      assert.equal(held, true); assert.equal(schoolId, "school"); assert.equal(sessionId, "class"); frames.push(frame);
    },
    now: 1_000_000, pendingMessageRecoveryHeartbeat: false,
    teacherReplyLastCheck: new Map([["login:device", 1_000_000]]), MAX_TEACHER_REPLY_CHECKS: 100,
    async runWithTenantContext(scope: Fields, action: () => Promise<unknown>) {
      assert.equal(scope.operation, "heartbeat_final_delivery"); held = true; order.push("lease");
      try { return await action(); } finally {
        order.push("commit-reset");
        if (options.holdRelease) await release.promise;
        held = false; order.push("released");
      }
    },
    async withClasspilotHeartbeatDeliveryAuthority(binding: Fields, prepare: (db: object, read: () => Promise<Fields>) => Promise<Fields>,
      deliver: (rows: never[], prepared: Fields) => unknown, recovery: unknown, foreground: Foreground) {
      assert.equal(binding.freezeSsoPolicy, true); assert.equal(recovery, undefined);
      assert.ok(foreground, "negotiated ordinary teaching must reach the owned publication path");
      const prepared = await prepare({}, async () => ({ authority: { kind: "teaching_session", teachingSessionId: "class", controlRevision: 3 } }));
      authorityReady.resolve();
      if (mode === "unauthorized") return { authorized: false, foreground: { status: "suppressed" } };
      let result: { status: string; succeeded?: boolean } = { status: mode === "fallback" ? "fallback" : "suppressed" };
      if (mode === "published" || mode === "partial" || mode === "final-fence-throws") {
        try { await foreground.publish(); result = { status: "settled", succeeded: true }; }
        catch { foreground.onFailure(); result = { status: "settled", succeeded: false }; }
      }
      if (mode === "final-fence-throws") throw new Error("synthetic mandatory entitlement failure");
      return { authorized: true, value: deliver([], prepared), foreground: result };
    },
    async getClasspilotStudentControlDeliveryContext() { if (mode === "prepare-throws") throw new Error("synthetic required preparation failure"); return { controlState: { revision: 3, desiredState: {}, teachingSessionId: "class" }, ssoPolicy: { revision: 1, policy: {} } }; },
    serializeClasspilotStudentControlStateForDelivery() { return { classroomState: { revision: 3 }, withheld: false }; },
    isClasspilotCapabilityActive() { return true; }, async buildStudentFabState() { return { synthetic: true }; },
    async resolveClasspilotScreenshotPolicy() { return { enabled: false }; },
    classpilotScreenshotAuthorityForDeliveredControl(value: Fields) { return value; },
    trackingSettings: {}, heartbeatObservationStatus: "active", req: { body: {} },
    classpilotControlStateExactBinding(value: Fields) { return value; },
  };
  const run: () => Promise<unknown> = runInNewContext(executable, context);
  return { run, order, frames, historical, counters, phaseCounters, authorityReady: authorityReady.promise,
    release: release.resolve, releasePublication: publication.resolve,
    snapshot: () => ({ held, fallbackCalls, foregroundAttempts }), drain: async () => { await Promise.all(tracked); } };
}

test("unsupported foreground proof falls back only after COMMIT/RESET/tenant release", async () => {
  const f = fixture("fallback", { holdRelease: true });
  const running = f.run();
  try {
    await f.authorityReady; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.historical.length, 1);
    assert.equal(f.snapshot().held, true); assert.equal(f.snapshot().fallbackCalls, 0);
    assert.equal(f.order.includes("realtime-classification"), false);
  } finally { f.release(); await running; await f.drain(); }
  assert.equal(f.snapshot().fallbackCalls, 1); assert.equal(f.snapshot().foregroundAttempts, 0);
  assert.ok(f.order.indexOf("released") < f.order.indexOf("fallback"));
  assert.deepEqual(f.frames.map(frame => frame.type), ["student-update", "ai-classification"]);
});

for (const mode of ["suppressed", "unauthorized", "partial"] as const) test(`${mode} never falls back or emits a newer AI frame`, async () => {
  const f = fixture(mode); await f.run(); await f.drain();
  assert.equal(f.snapshot().fallbackCalls, 0); assert.equal(f.snapshot().held, false);
  assert.equal(f.historical.length, 1);
  assert.equal(f.frames.some(frame => frame.type === "ai-classification"), false);
  assert.equal(f.frames.length, mode === "partial" ? 1 : 0, "a partial local delivery must not be duplicated by fallback");
  assert.equal(f.order.includes("http:ok"), mode !== "unauthorized");
  assert.equal(f.order.includes("http:409"), mode === "unauthorized");
  assert.deepEqual(f.counters, mode === "partial" ? ["heartbeatOptionalTelemetryFailures"] : []);
});

for (const nullClassification of [false, true]) test(`owned foreground finishes before ${nullClassification ? "null" : "AI"} completion reaches the actual client reducer`, async () => {
  const f = fixture("published", { holdPublication: true, holdRelease: true, nullClassification });
  const running = f.run();
  try {
    await f.authorityReady; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.snapshot().foregroundAttempts, 1);
    assert.equal(f.historical.length, nullClassification ? 0 : 1);
    assert.equal(f.order.includes("realtime-classification"), false);
    f.releasePublication(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.snapshot().held, true);
    assert.equal(f.order.includes("realtime-classification"), false, "HTTP completion does not release the foreground barrier early");
  } finally { f.releasePublication(); f.release(); await running; await f.drain(); }
  assert.equal(f.snapshot().fallbackCalls, 0);
  assert.deepEqual(f.frames.map(frame => frame.type), ["student-update", "ai-classification"]);
  const client = await import(new URL("../schoolpilot-app/src/products/classpilot/lib/studentRealtimeCache.js", import.meta.url).href);
  const rows = client.applyStudentRealtimeEvents([{ id: "student", studentId: "student", activeTabUrl: "https://old.example", realtimeRevision: 2 }], f.frames);
  const row = rows[0]; assert.ok(row);
  assert.equal(Reflect.get(row, "activeTabUrl"), "https://www.ixl.com/math");
  assert.equal(Reflect.get(row, "fabSyncPending"), true);
  assert.equal(Reflect.get(row, "realtimeRevision"), 4);
  assert.equal(Reflect.get(row, "aiCategory"), nullClassification ? null : "educational");
});

test("fallback failure drains historical work and records both counters without AI publication", async () => {
  const f = fixture("fallback", { failFallback: true }); await f.run(); await f.drain();
  assert.equal(f.historical.length, 1); assert.equal(f.frames.length, 0); assert.equal(f.snapshot().held, false);
  assert.deepEqual(f.counters, ["heartbeatOptionalTelemetryFailures"]);
  assert.deepEqual(f.phaseCounters, [{ name: "heartbeatOptionalTelemetryFailures", operation: "heartbeat_background" }]);
});

for (const mode of ["prepare-throws", "final-fence-throws"] as const) test(`${mode} settles the actual outer barrier without fallback or newer AI publication`, async () => {
  const f = fixture(mode); await assert.rejects(f.run(), /synthetic (required preparation|mandatory entitlement) failure/); await f.drain();
  assert.equal(f.snapshot().held, false); assert.equal(f.snapshot().fallbackCalls, 0); assert.equal(f.historical.length, 1);
  assert.equal(f.frames.some(frame => frame.type === "ai-classification"), false);
  assert.equal(f.frames.length, mode === "final-fence-throws" ? 1 : 0);
  assert.equal(f.order.includes("http:ok"), false);
});
