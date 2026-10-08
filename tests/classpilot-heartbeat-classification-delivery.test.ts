import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolveCurrentClasspilotSafetyAction } from "../src/services/classpilotSafetyAction.js";

const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const start = source.indexOf("    const completedHeartbeatTileCacheWrite = Promise.resolve(");
const end = source.indexOf("    // --- Deliver any missed messages", start);
assert.ok(start >= 0 && end > start);
const executable = ts.transpileModule(`async function heartbeatAfterPersistence() { let finishForegroundTelemetry = () => {}; try { ${source.slice(start, end)}\n return { continued: true }; } finally { finishForegroundTelemetry(); } }\nheartbeatAfterPersistence;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
type Fields = Record<string, unknown>;
function fixture(options: { staleAtWrite?: boolean; staleAtClassification?: boolean; failPublish?: "student-update" | "ai-classification"; safety?: boolean; delayedClassification?: boolean; delayedForeground?: boolean; failBeforeForeground?: boolean; denied?: boolean; persistedImmediate?: boolean; nullClassification?: boolean; observedUrl?: string; classificationResult?: Awaited<ReturnType<typeof import("../src/services/aiClassification.js").classifyUrl>> } = {}) {
  const order: string[] = [], historical: Fields[] = [], published: Fields[] = [], tracked: Promise<unknown>[] = [];
  let releaseClassification!: () => void;
  let releaseForeground!: () => void;
  const classificationReady = options.delayedClassification ? new Promise<void>(resolve => { releaseClassification = resolve; }) : Promise.resolve();
  const foregroundReady = options.delayedForeground ? new Promise<void>(resolve => { releaseForeground = resolve; }) : Promise.resolve();
  const counters: string[] = [];
  const phaseCounters: Array<{ counter: string; operation: string }> = [];
  const snapshot = { revision: 3, observedAt: 1000, activeTabUrl: options.observedUrl ?? "https://www.ixl.com/math", heartbeatId: "heartbeat",
    state: "active", schoolId: "school", studentId: "student", studentSessionId: "login", deviceId: "device",
    allOpenTabs: [], classroomState: { teachingSessionId: "class" } };
  const classification = options.classificationResult ?? { category: "educational", contentCategory: "education", safetyAlert: options.safety ? "violence" : null, domain: "www.ixl.com" };
  const context = {
    Promise, Date, trackingWindowScreenshotLeaseNegotiated: false, schoolId: "school", studentId: "student", studentSessionId: "login", deviceId: "device", studentEmail: "synthetic@example.invalid",
    school: { domain: "example.invalid", planStatus: "active" }, heartbeat: { id: "heartbeat" }, controlState: { revision: 3 },
    persistedImmediateClassification: options.persistedImmediate ? classification : null, heartbeatTileCacheWritten: true, fabSyncPending: true, protocol: { acceptedCapabilities: [] },
    realtimeStatusMutation: options.staleAtWrite ? { status: "stale", snapshot: null } : { status: "updated", snapshot },
    activeTabUrl: snapshot.activeTabUrl, activeTabTitle: "Synthetic lesson", favicon: undefined, allOpenTabs: [], screenshotHealth: undefined,
    extensionVersion: "2.9.7", chromeVersion: "120", screenLocked: false, flightPathActive: false, activeFlightPathName: undefined,
    isScreenSharing: false, isScreenRecording: false, cameraActive: false, visibilityState: "visible", trackingStatus: "active",
    restrictionAuthStateByDevice: new Map(), MAX_DEVICE_HEARTBEAT_ENTRIES: 100, classroomState: { restrictions: {} },
    setBoundedMap(map: Map<string, unknown>, key: string, value: unknown) { map.set(key, value); },
    classpilotRestrictionAuthTransitionMetric() { return null; }, recordHeartbeatHotPathCounter(counter: string) { counters.push(counter); },
    recordUsageCapacityCounter(counter: string, operation: string) { phaseCounters.push({ counter, operation }); },
    updateDeviceStatus() { if (options.failBeforeForeground) throw new Error("Synthetic pre-publication failure"); },
    publicRealtimeFields(value: Fields) { return { revision: value.revision, activeTabUrl: value.activeTabUrl, allOpenTabs: [], acceptedCapabilities: ["scopedAuthorityChecksV1"] }; },
    realtimeControlAuthority() { return { teachingSessionId: "class", revision: 3 }; },
    async markClasspilotFabSyncPending() {}, res: { json(value: Fields) { return value; } },
    async classifyUrl() { order.push("classification-start"); await classificationReady; return options.nullClassification ? null : classification; },
    trackHeartbeatClassificationProducer(producer: Promise<unknown>) { order.push("producer-tracked"); tracked.push(producer); return producer; },
    async persistHeartbeatClassification(value: Fields) { order.push("historical-persist"); historical.push(value); },
    async patchHeartbeatTileCacheClassifications() { order.push("tile-classification"); return true; }, async invalidateHeartbeatTileCaches() {},
    async patchClasspilotRealtimeClassification() { order.push("realtime-classification"); return options.staleAtClassification
      ? { status: "stale", snapshot: null } : { status: "updated", snapshot: { ...snapshot, revision: 4 } }; },
    updateDeviceClassification() { order.push("memory-classification"); },
    async isSafetyUrlSuppressed() { return false; },
    async runWithTenantContext(_scope: Fields, action: () => Promise<unknown>) { return action(); },
    async publishRevisionedRealtimeUpdate(_snapshot: Fields, message: Fields) {
      order.push(`authority:${message.type}`);
      if (message.type === "student-update") await foregroundReady;
      if (options.failPublish === message.type) throw new Error("Synthetic authority checkout failure");
      if (!options.denied) published.push(message);
    },
    resolveCurrentClasspilotSafetyAction(input: Parameters<typeof resolveCurrentClasspilotSafetyAction>[0]) {
      order.push("safety-fence");
      return resolveCurrentClasspilotSafetyAction(input);
    },
    async loadClasspilotSafetyContext() { return { studentName: "Synthetic student" }; }, describeClasspilotSafetyReason() { return "Synthetic reason"; },
    async recordBrowserSafetyTimeline() { order.push("safety-timeline"); return { created: true }; },
    broadcastToStaffSessionLocal() { order.push("safety-local-alert"); }, async publishWS() { order.push("safety-remote-alert"); return true; },
  };
  const run: () => Promise<unknown> = runInNewContext(executable, context);
  return { run, order, historical, published, tracked, counters, phaseCounters, release: () => releaseClassification?.(), releaseForeground: () => releaseForeground?.(),
    drain: async () => { await Promise.allSettled(tracked); } };
}

test("heartbeat registers historical classification before a failed foreground authority checkout", async () => {
  const f = fixture({ failPublish: "student-update", delayedClassification: true });
  try {
    await assert.doesNotReject(f.run());
    assert.equal(f.tracked.length, 1);
    assert.ok(f.order.indexOf("producer-tracked") < f.order.indexOf("authority:student-update"));
    assert.equal(f.historical.length, 0, "slow classification remains tracked for drain");
  } finally { f.release(); await f.drain(); }
  assert.equal(f.historical.length, 1);
  assert.equal(f.historical[0]?.heartbeatId, "heartbeat");
  assert.deepEqual(f.counters, ["heartbeatOptionalTelemetryFailures"]);
  assert.deepEqual(f.phaseCounters, [{ counter: "heartbeatOptionalTelemetryFailures", operation: "heartbeat_background" }]);
});

test("failed classification publication does not suppress current safety handling", async () => {
  const f = fixture({ failPublish: "ai-classification", safety: true });
  await f.run(); await f.drain();
  assert.equal(f.historical.length, 1);
  for (const step of ["safety-fence", "safety-timeline", "safety-local-alert", "safety-remote-alert"]) assert.ok(f.order.includes(step), step);
  assert.ok(f.order.indexOf("historical-persist") < f.order.indexOf("authority:ai-classification"));
  assert.deepEqual(f.counters, ["heartbeatOptionalTelemetryFailures"]);
  assert.deepEqual(f.phaseCounters, [{ counter: "heartbeatOptionalTelemetryFailures", operation: "heartbeat_background" }]);
});

test("null classification publication failure is also retained in phase diagnostics", async () => {
  const f = fixture({ nullClassification: true, failPublish: "ai-classification" });
  await f.run(); await f.drain();
  assert.deepEqual(f.counters, ["heartbeatOptionalTelemetryFailures"]);
  assert.deepEqual(f.phaseCounters, [{ counter: "heartbeatOptionalTelemetryFailures", operation: "heartbeat_background" }]);
});

test("stale accepted heartbeat keeps historical classification without current realtime or safety effects", async () => {
  const f = fixture({ staleAtWrite: true, safety: true });
  await f.run(); await f.drain();
  assert.equal(f.tracked.length, 1);
  assert.equal(f.historical.length, 1);
  assert.equal(f.historical[0]?.heartbeatId, "heartbeat");
  assert.equal(f.published.length, 0);
  for (const step of ["realtime-classification", "memory-classification", "safety-fence", "safety-timeline", "safety-local-alert"]) assert.equal(f.order.includes(step), false, step);
});

test("classification that loses the current heartbeat race cannot create a safety event", async () => {
  const f = fixture({ staleAtClassification: true, safety: true });
  await f.run(); await f.drain();
  assert.equal(f.historical.length, 1);
  assert.equal(f.order.includes("safety-timeline"), false);
  assert.equal(f.published.some(row => row.type === "ai-classification"), false);
});

test("telemetry authority denial stays fail-closed while historical work finishes", async () => {
  const f = fixture({ denied: true });
  await f.run(); await f.drain();
  assert.equal(f.historical.length, 1);
  assert.equal(f.published.length, 0);
  assert.ok(f.order.includes("authority:student-update") && f.order.includes("authority:ai-classification"));
});

test("classification history proceeds while foreground is blocked, then actual client retains full metadata before newer classification", async () => {
  const f = fixture({ delayedForeground: true });
  const running = f.run();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.historical.length, 1);
    assert.equal(f.order.includes("realtime-classification"), false);
    assert.equal(f.published.length, 0);
  } finally { f.releaseForeground(); await running; await f.drain(); }
  assert.deepEqual(f.published.map(frame => frame.type), ["student-update", "ai-classification"]);
  const client = await import(new URL("../schoolpilot-app/src/products/classpilot/lib/studentRealtimeCache.js", import.meta.url).href);
  let rows = [{ id: "student", studentId: "student", activeTabUrl: "https://old.example", realtimeRevision: 2 }];
  rows = client.applyStudentRealtimeEvents(rows, f.published);
  const row = rows[0]; assert.ok(row);
  assert.equal(Reflect.get(row, "activeTabUrl"), "https://www.ixl.com/math");
  assert.equal(Reflect.get(row, "fabSyncPending"), true);
  assert.equal(Reflect.get(row, "realtimeRevision"), 4);
  assert.equal(Reflect.get(row, "aiCategory"), "educational");
});

test("a synchronous failure before foreground publication releases tracked classification work without current-only publication", async () => {
  const f = fixture({ failBeforeForeground: true, safety: true });
  await assert.rejects(f.run(), /Synthetic pre-publication failure/);
  await f.drain();
  assert.equal(f.historical.length, 1);
  assert.equal(f.published.length, 0);
  assert.ok(f.order.includes("safety-timeline"));
});

test("a confirmed initial classification needs no producer, historical UPDATE or second fan-out", async () => {
  const f = fixture({ persistedImmediate: true });
  await f.run(); await f.drain();
  assert.equal(f.tracked.length, 0);
  assert.equal(f.historical.length, 0);
  assert.equal(f.order.includes("classification-start"), false);
  assert.equal(f.order.includes("realtime-classification"), false);
  assert.deepEqual(f.published.map(frame => frame.type), ["student-update"]);
});

test("null-classification completion also waits for foreground metadata and drains after failure", async () => {
  const f = fixture({ nullClassification: true, delayedForeground: true, failPublish: "student-update" });
  const running = f.run();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.order.includes("tile-classification"), false);
    assert.equal(f.order.includes("realtime-classification"), false);
  } finally { f.releaseForeground(); await running; await f.drain(); }
  assert.ok(f.order.includes("realtime-classification"));
  assert.equal(f.published.length, 0);
  assert.deepEqual(f.counters, ["heartbeatOptionalTelemetryFailures"]);
});

test("privacy-unavailable classification completes heartbeat history and realtime without safety effects", async () => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const priorFetch = globalThis.fetch;
  let providerCalls = 0;
  process.env.GEMINI_API_KEY = "synthetic-delivery-provider-key";
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("Privacy denial must precede fetch"); };
  try {
    const { classifyUrl } = await import("../src/services/aiClassification.js");
    const observedUrl = "https://privacy-delivery.test/lesson?token=SYNTHETIC_DELIVERY_CREDENTIAL";
    const result = await classifyUrl(observedUrl, "Synthetic lesson");
    assert.equal(result?.source, "unknown");
    assert.equal(result?.category, "unknown");
    assert.equal(result?.safetyAlert, null);
    assert.equal(providerCalls, 0);
    const f = fixture({ observedUrl, classificationResult: result });
    await f.run(); await f.drain();
    assert.equal(f.historical.length, 1);
    assert.equal(f.historical[0]?.aiCategory, "unknown");
    assert.equal(f.historical[0]?.safetyAlert, null);
    assert.ok(f.order.includes("realtime-classification"));
    assert.ok(f.order.includes("memory-classification"));
    const completion = f.published.find(frame => frame.type === "ai-classification");
    assert.ok(completion, "normal completion clears the existing client pending state");
    assert.equal(completion.classifiedUrl, observedUrl, "the provider projection never replaces local navigation");
    assert.deepEqual(completion.classification, result);
    for (const step of ["safety-timeline", "safety-local-alert", "safety-remote-alert"]) assert.equal(f.order.includes(step), false, step);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
    if (priorAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAnthropicKey;
  }
});
