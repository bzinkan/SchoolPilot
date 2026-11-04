import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchClasspilotSafetyClose } from "../src/services/classpilotSafetyClose.js";
import { resolveCurrentClasspilotSafetyAction } from "../src/services/classpilotSafetyAction.js";
import type { ClasspilotRealtimeStatus } from "../src/services/classpilotRealtimeStatus.js";

const binding = { schoolId: "school", studentId: "student", studentSessionId: "session", deviceId: "device" };
const url = "https://www.google.com/search?q=xxx";
function input() {
  const snapshot: ClasspilotRealtimeStatus = {
    schemaVersion: 2, state: "active", ...binding, heartbeatId: "heartbeat", revision: 9,
    observedAt: Date.now(), activeTabUrl: url, activeTabTitle: "Search", activityState: "active",
    classificationPending: false, tabSnapshotRevision: 7, activeTabRef: "unsafe-tab",
    allOpenTabs: [{ tabRef: "unsafe-tab", url, title: "Search" }], openTabCount: 1, tabsTruncated: false,
    classroomControls: { screenLocked: false, flightPathActive: false, isSharing: false, cameraActive: false },
    clientProtocolVersion: 3, acceptedCapabilities: ["scopedAuthorityChecksV1", "exactTabCloseV2"],
  };
  const action = resolveCurrentClasspilotSafetyAction({
    ...binding, heartbeatId: "heartbeat", activeTabUrl: url,
    classification: { category: "non-educational", safetyAlert: "sexual", domain: "search:xxx", source: "search", classifiedAt: Date.now() },
    realtimeMutation: { status: "stored", snapshot },
  });
  assert.ok(action);
  return { ...binding, action, expectedControlRevision: 12, deliveredControlRevision: 4 };
}

function fixture(options: { denied?: boolean; local?: boolean; remote?: boolean; localFails?: boolean; remoteFails?: boolean } = {}) {
  const calls: Array<{ target: unknown; frame: any }> = [];
  let locked = false;
  return { calls, dependencies: {
    async withAuthority(_input: unknown, send: (binding: { controlRevision: number }) => void) {
      if (options.denied) return;
      locked = true;
      try { send({ controlRevision: 4 }); } finally { locked = false; }
    },
    sendLocal(target: unknown, frame: unknown) {
      assert.equal(locked, true, "local send retains authority lock");
      calls.push({ target, frame });
      if (options.localFails) throw new Error("synthetic local failure");
      return options.local ?? true;
    },
    async publishRemote(target: unknown, frame: unknown) {
      assert.equal(locked, true, "relay initiation retains authority lock");
      calls.push({ target, frame });
      if (options.remoteFails) throw new Error("synthetic relay failure");
      return options.remote ?? true;
    },
  } };
}

test("sexual search sends one transient exact-tab school-policy request on both exact-binding transports", async () => {
  const f = fixture(), before = Date.now();
  assert.equal(await dispatchClasspilotSafetyClose(input(), f.dependencies), true);
  assert.equal(f.calls.length, 2);
  const { frame, target } = f.calls[0]!;
  assert.deepEqual(target, { kind: "student-binding", ...binding });
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(frame.type, "remote-control");
  assert.equal(frame.command.type, "close-tab");
  assert.deepEqual(frame.command.authority, { kind: "school_policy", schoolId: "school", source: "ai_safety" });
  assert.deepEqual(frame.command.data, { tabRefs: ["unsafe-tab"], snapshotRevision: 7, studentId: "student", studentSessionId: "session" });
  assert.deepEqual(frame.exactBinding, { bindingVersion: 2, ...binding, controlRevision: 4 });
  assert.deepEqual(frame.command.exactBinding, frame.exactBinding);
  assert.equal(frame.command.studentSessionId, "session");
  assert.equal(frame.deliveryPolicy, "transient_action");
  assert.equal(frame.command.expiresAt, frame.expiresAt);
  assert.ok(Date.parse(frame.expiresAt) >= before + 15_000);
  assert.ok(Date.parse(frame.expiresAt) <= Date.now() + 15_000);
  assert.equal("commandId" in frame, false, "request is not a fabricated durable teacher command");
});

test("denied authority and mismatched or missing target never send", async () => {
  const f = fixture({ denied: true });
  assert.equal(await dispatchClasspilotSafetyClose(input(), f.dependencies), false);
  assert.equal(f.calls.length, 0);
  const allowed = fixture();
  const missing = input(); missing.action.closeTabData = null;
  assert.equal(await dispatchClasspilotSafetyClose(missing, allowed.dependencies), false);
  assert.equal(await dispatchClasspilotSafetyClose({ ...input(), studentSessionId: "replacement" }, allowed.dependencies), false);
  assert.equal(await dispatchClasspilotSafetyClose({ ...input(), expectedControlRevision: -1 }, allowed.dependencies), false);
  assert.equal(allowed.calls.length, 0);
});

test("each observation closes independently and transport failure never causes a broad fallback", async () => {
  const f = fixture({ local: false, remote: false });
  assert.equal(await dispatchClasspilotSafetyClose(input(), f.dependencies), false);
  assert.equal(await dispatchClasspilotSafetyClose(input(), f.dependencies), false);
  assert.equal(f.calls.length, 4);
  assert.notEqual(f.calls[0]!.frame._msgId, f.calls[2]!.frame._msgId);
  const remoteOnly = fixture({ localFails: true });
  assert.equal(await dispatchClasspilotSafetyClose(input(), remoteOnly.dependencies), true);
  const localOnly = fixture({ remoteFails: true });
  assert.equal(await dispatchClasspilotSafetyClose(input(), localOnly.dependencies), true);
  const neither = fixture({ localFails: true, remoteFails: true });
  assert.equal(await dispatchClasspilotSafetyClose(input(), neither.dependencies), false);
});

test("protocol-2 exact refs and unique legacy URLs retain the same narrow school-policy target", async () => {
  for (const version of [1, null] as const) {
    const request = input(), f = fixture();
    request.action.exactTabCloseVersion = version;
    request.action.closeTabData = version === 1
      ? { tabRefs: ["unsafe-tab"], snapshotRevision: 7 } : { specificUrls: [url] };
    assert.equal(await dispatchClasspilotSafetyClose(request, f.dependencies), true);
    assert.equal("exactBinding" in f.calls[0]!.frame, false);
    assert.deepEqual(f.calls[0]!.frame.command.data, {
      ...request.action.closeTabData, studentId: "student", studentSessionId: "session",
    });
    assert.deepEqual(f.calls[0]!.target, { kind: "student-binding", ...binding });
  }
});
