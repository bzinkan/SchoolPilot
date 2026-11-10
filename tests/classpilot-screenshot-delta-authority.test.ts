import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseScreenshotImageRequest, uploadedScreenshotPixelBytes } from "../src/services/classpilotScreenshotImageRequest.js";
import { screenshotDeltaTargetByteLimit } from "../src/services/classpilotScreenshotDelta.js";

const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("devices.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = file.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "executeCanonicalScreenshot");
assert.ok(declaration, "Run the actual canonical upload handler");
const program = ts.transpileModule(`${declaration.getText(file).replace(/^export /, "")}\nexecuteCanonicalScreenshot;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture(options: { supervision?: boolean; denied?: boolean; capture?: string; allowed?: boolean;
  deltaEnabled?: boolean; status?: string } = {}) {
  const binding = { schoolId: "synthetic-school", studentId: "synthetic-student", deviceId: "synthetic-device",
    studentSessionId: "synthetic-login" };
  const capturedAt = new Date().toISOString();
  const delta = { codec: "cp-bit-copy-v1", baseImageId: "12345678-1234-4234-8234-123456789abc",
    data: Buffer.alloc(21).toString("base64"), targetBytes: 1024, uploadIntegrity: "a".repeat(64) };
  const order: string[] = [];
  let inAuthority = false;
  const writes: { binding: object; metadata: object; delta: object; limit: number }[] = [];
  const current = { authority: options.supervision
    ? { kind: "supervision_context", supervisionContextId: "synthetic-room", controlRevision: 2 }
    : { kind: "teaching_session", teachingSessionId: "synthetic-class", controlRevision: 2 },
    authorityStartedAt: new Date(0), authorityStartedAtSource: "control_updated", controlRevisionIssuedAt: new Date(0) };
  const policy = { mode: "tracking_window_lease", captureAllowed: options.allowed !== false };
  async function store(exact: object, metadata: object, received: object, limit: number) {
    assert.equal(inAuthority, true, "base lookup/decode/write must remain inside the fresh authority transaction");
    order.push("delta-store"); writes.push({ binding: exact, metadata, delta: received, limit });
    return options.status && options.status !== "stored" ? { status: options.status }
      : { status: "stored", imageId: "98765432-9876-4876-8876-987654321abc" };
  }
  const globals = {
    Buffer, parseScreenshotImageRequest, uploadedScreenshotPixelBytes, screenshotDeltaTargetByteLimit,
    isClasspilotCapabilityActive(capability: string) { return capability !== "scopedScreenshotDeltasV1" || options.deltaEnabled !== false; },
    classpilotRealtimeFresh() { return true; },
    async readClasspilotRealtimeStatusBatch() { return new Map([[binding.studentId, { status: "hit", snapshot: {
      acceptedCapabilities: ["screenshotTrackingWindowLeaseV1", "scopedScreenshotReferencesV1", "scopedScreenshotDeltasV1"],
    } }]]); },
    parseClasspilotScreenshotAuthority(value: unknown) { return value; },
    async runWithTenantContext(_scope: unknown, operation: () => Promise<unknown>) { return operation(); },
    async withClasspilotScreenshotUploadAuthority(_scope: unknown, operation: (input: object) => Promise<unknown>) {
      order.push("authority");
      if (options.denied) return { status: "superseded", current };
      inAuthority = true;
      try { return { status: "accepted", current, value: await operation({ current, trackingSettings: {} }) }; }
      finally { inAuthority = false; }
    },
    async resolveClasspilotScreenshotPolicy() { order.push("policy"); return policy; },
    validateClasspilotScreenshotCapturedAt() { order.push("capture"); return options.capture ?? "ok"; },
    classBoundScreenshotBindingVersion() { return "class-version"; },
    supervisionBoundScreenshotBindingVersion() { return "supervision-version"; },
    setClassBoundScreenshotDelta: store, setSupervisionBoundScreenshotDelta: store,
    setClassBoundScreenshotImage() { throw new Error("Delta must not reach full writer"); },
    setSupervisionBoundScreenshotImage() { throw new Error("Delta must not reach full writer"); },
    classpilotScreenshotStoreRequired() { return true; },
    recordHeartbeatHotPathCounter() {}, recordHeartbeatHotPathTiming() {}, recordScreenshotUpload() {},
    recordPreviewRefreshLatencyOnce() {},
    async publishLockedScreenshotAvailable() {},
  };
  const handler = runInNewContext(program, globals);
  const payload = { screenshotImageProtocolVersion: 1, screenshotDelta: delta, capturedAt,
    screenshotAuthority: { kind: "teaching_session", controlRevision: 2 }, tabTitle: "Synthetic lesson" };
  return { binding, payload, order, writes,
    run(extra: Record<string, unknown> = {}) { return handler({ binding, payload: { ...payload, ...extra },
      reply(status: number, body: object) { return { status, body }; } }); } };
}

for (const supervision of [false, true]) {
  test(`actual ${supervision ? "supervision" : "class"} delta upload reads pixels only after fresh policy and capture fences`, async () => {
    const f = fixture({ supervision }); const response = await f.run();
    assert.equal(response.status, 200); assert.equal(response.body.retained, true);
    assert.equal(response.body.imageId, "98765432-9876-4876-8876-987654321abc");
    assert.deepEqual(f.order, ["authority", "policy", "capture", "delta-store"]);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]!.limit, screenshotDeltaTargetByteLimit(f.payload));
    assert.ok(f.writes[0]!.limit < 262144, "compressed frames retain the original full logical bound");
    assert.equal(JSON.stringify(f.writes[0]!.metadata).includes("screenshotDelta"), false);
    assert.equal(JSON.stringify(response).includes("uploadIntegrity"), false);
  });
}

test("denied authority, paused policy and rejected capture never read/decode cached base pixels", async () => {
  for (const options of [{ denied: true }, { allowed: false }, { capture: "expired" }]) {
    const f = fixture(options); const response = await f.run();
    assert.equal(response.status, 409); assert.equal(f.writes.length, 0);
  }
});

test("delta rollout off and malformed/conflicting payloads recover through existing full-frame contract", async () => {
  const disabled = fixture({ deltaEnabled: false });
  assert.equal((await disabled.run()).body.code, "SCREENSHOT_IMAGE_REQUIRED");
  assert.equal(disabled.writes.length, 0); assert.deepEqual(disabled.order, []);
  const f = fixture();
  assert.equal((await f.run({ screenshot: "data:image/jpeg;base64,/9j/2Q==" })).status, 400);
  assert.equal((await f.run({ captureKind: "safety_evidence" })).status, 400);
  assert.equal(f.writes.length, 0);
});

test("expired or raced delta bases request the original full capture; unavailable storage stays unavailable", async () => {
  for (const status of ["need_full_frame", "unavailable", "superseded"]) {
    const f = fixture({ status }); const response = await f.run();
    assert.equal(response.status, status === "unavailable" ? 503 : status === "superseded" ? 200 : 409);
    if (status === "need_full_frame") assert.equal(response.body.code, "SCREENSHOT_IMAGE_REQUIRED");
    if (status === "superseded") assert.equal(response.body.retained, false);
    assert.equal(f.writes.length, 1);
  }
});
