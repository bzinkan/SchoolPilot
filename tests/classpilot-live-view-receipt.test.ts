import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the production request branch with controlled I/O so the receipt is
// the actual emitted frame, rather than a second fixture copy of its contract.
const source = readFileSync(new URL("../src/realtime/websocket.ts", import.meta.url), "utf8");
const start = source.indexOf("// --- Remote control: request-stream ---");
const end = source.indexOf("// --- Remote control: stop-share ---", start);
assert.ok(start > 0 && end > start);
const executable = ts.transpileModule(`async function request() { ${source.slice(start, end)} }; request;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function requestScenario(supervision: boolean, authorityCurrent = true) {
  const target = {
    schoolId: "school", studentId: "student", studentSessionId: "browser-session", deviceId: "device",
    requesterUserId: "teacher", controlRevision: 9,
    ...(supervision ? { supervisionContextId: "testing", contextAuthorityRevision: "2" }
      : { teachingSessionId: "class" }),
  };
  const receipts: Array<Record<string, unknown>> = [];
  const deviceFrames: Array<Record<string, unknown>> = [];
  const lockedOptions: Array<Record<string, unknown>> = [];
  const releases: unknown[] = [];
  const withAuthority = async (options: Record<string, unknown>, callback: () => Promise<unknown>) => {
    lockedOptions.push(options);
    return authorityCurrent ? callback() : undefined;
  };
  const context = {
    message: { type: "request-stream" }, client: { role: "teacher", schoolId: "school", userId: "teacher" },
    resolveLiveTarget: async () => target,
    withClasspilotSupervisionTelemetryAuthority: withAuthority,
    withClasspilotTeachingTelemetryAuthority: withAuthority,
    runWithTenantContext: async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    claimClasspilotLiveViewNegotiation: async () => ({ status: "claimed", negotiationId: "signed-negotiation", expiresAt: Date.now() + 60_000 }),
    ownedLiveViewNegotiations: new Map(),
    ws: { readyState: 1, send: (frame: string) => receipts.push(JSON.parse(frame)) },
    WebSocket: { OPEN: 1 },
    getHeartbeatTrackingSettingsForSchool: async () => ({}),
    classpilotFullMonitoringDeadline: (_settings: unknown, _now: number, expiry: number) => expiry,
    CLASSPILOT_LIVE_VIEW_SETUP_TTL_MS: 90_000,
    sendToDeviceLocal: (_school: string, _device: string, frame: Record<string, unknown>) => {
      deviceFrames.push(frame); return true;
    },
    publishWS: async () => true,
    releaseClasspilotLiveViewNegotiation: async (...args: unknown[]) => { releases.push(args); },
    forgetOwnedLiveView: () => undefined,
    stopOwnedLiveViews: (reason: string) => { releases.push(reason); },
  };
  await runInNewContext(executable, context)();
  return { receipts, deviceFrames, lockedOptions, releases };
}

test("scheduled Live View receipt preserves the validated context tenure required by the Dashboard", async () => {
  const { receipts, deviceFrames, lockedOptions, releases } = await requestScenario(true);
  assert.equal(lockedOptions[0]?.contextAuthorityRevision, "2");
  assert.equal(lockedOptions[0]?.scheduledClassroomOnly, true);
  assert.equal(receipts.length, 1);
  const receipt = receipts[0]!;
  assert.equal(receipt.type, "live-view-requested");
  assert.equal(receipt.supervisionContextId, "testing");
  assert.equal(receipt.contextAuthorityRevision, "2");
  assert.equal(receipt.controlRevision, 9);
  assert.equal(receipt.negotiationId, "signed-negotiation");
  assert.equal(receipt.teachingSessionId, undefined);
  assert.equal(receipt.deviceId, undefined);
  assert.equal(receipt.studentSessionId, undefined);
  assert.equal(deviceFrames[0]?.supervisionContextId, "testing");
  assert.equal(deviceFrames[0]?.controlRevision, 9);
  assert.equal(deviceFrames[0]?.teachingSessionId, undefined);
  assert.deepEqual(releases, []);
});

test("teaching Live View preserves its real parent and does not acquire a supervision tenure", async () => {
  const { receipts, deviceFrames } = await requestScenario(false);
  assert.equal(receipts[0]?.teachingSessionId, "class");
  assert.equal(receipts[0]?.supervisionContextId, undefined);
  assert.equal(receipts[0]?.contextAuthorityRevision, undefined);
  assert.equal(deviceFrames[0]?.teachingSessionId, "class");
});

test("authority lost at the final lock emits neither a capture request nor a successful receipt", async () => {
  const { receipts, deviceFrames } = await requestScenario(true, false);
  assert.deepEqual(receipts, []);
  assert.deepEqual(deviceFrames, []);
});
