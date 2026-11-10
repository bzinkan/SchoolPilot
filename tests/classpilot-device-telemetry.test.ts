import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  parseDeviceTelemetryFrame, heartbeatTelemetryIdentity, DeviceTelemetryDelivery,
  createDeviceTelemetryDispatcher, createDeviceTelemetryLanes,
  deviceTelemetrySourceIp,
} from "../src/services/classpilotDeviceTelemetry.js";
import { negotiateClasspilotProtocol } from "../src/services/classpilotProtocol.js";

const binding = { schoolId: "school-a", deviceId: "device-a", studentId: "student-a", studentSessionId: "session-a" };
const frame = (extra = {}) => ({ type: "device-telemetry", operationId: randomUUID(), kind: "heartbeat",
  studentToken: "synthetic-token", payload: { activeTabUrl: "https://example.invalid/", activeTabTitle: "Lesson" }, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("a shared school NAT permits the 2000-student cadence with bounded recovery headroom", async () => {
  const policy = await import("../src/services/classpilotDeviceTelemetry.js");
  assert.equal(Reflect.get(policy, "DEVICE_TELEMETRY_IP_WINDOW_MS"), 300_000);
  const exceeded = Reflect.get(policy, "deviceTelemetryIpRateExceeded");
  assert.equal(typeof exceeded, "function", "the production limiter must use the reviewed shared-NAT bound");
  assert.equal(exceeded(2_000 * 90), false);
  assert.equal(exceeded(300_000), false);
  assert.equal(exceeded(300_001), true);
});

test("telemetry frame is bounded, strictly typed and never selects a server route", () => {
  assert.ok(parseDeviceTelemetryFrame(frame()));
  for (const value of [frame({ operationId: "not-a-uuid" }), frame({ kind: "delete-school" }),
    frame({ payload: [] }), frame({ studentToken: "" }), frame({ path: "/admin" }),
    frame({ payload: { oversized: "x".repeat(256 * 1024) } })]) {
    assert.equal(parseDeviceTelemetryFrame(value), null);
  }
});

test("transport and image-reference capabilities default off and require their exact parents", () => {
  const capabilities = ["scopedAuthorityChecksV1", "screenshotTrackingWindowLeaseV1", "deviceTelemetryTransportV1", "scopedScreenshotReferencesV1"];
  const accepted = (env: NodeJS.ProcessEnv, advertised = capabilities) => negotiateClasspilotProtocol({
    clientProtocolVersion: 3, advertisedCapabilities: advertised, scope: { schoolId: binding.schoolId }, env,
  }).acceptedCapabilities;
  const base = { CLASSPILOT_PROTOCOL_V3_ENABLED: "true", CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1: "true" };
  assert.ok(!accepted(base).includes("deviceTelemetryTransportV1"));
  const enabled = { ...base, CLASSPILOT_CAP_DEVICE_TELEMETRY_TRANSPORT_V1: "true", CLASSPILOT_CAP_SCOPED_SCREENSHOT_REFERENCES_V1: "true" };
  assert.ok(accepted(enabled).includes("deviceTelemetryTransportV1"));
  assert.ok(accepted(enabled).includes("scopedScreenshotReferencesV1"));
  for (const parent of capabilities.slice(0, 3)) assert.ok(!accepted(enabled, capabilities.filter(value => value !== parent)).includes("scopedScreenshotReferencesV1"));
});

test("upgrade source IP uses the same trusted-proxy depth and ignores malformed chains", () => {
  const request = { socket: { remoteAddress: "192.0.2.1" }, headers: { "x-forwarded-for": "203.0.113.4, 198.51.100.2" } };
  assert.equal(deviceTelemetrySourceIp(request, 2), "203.0.113.4");
  assert.equal(deviceTelemetrySourceIp(request, 1), "198.51.100.2");
  assert.equal(deviceTelemetrySourceIp({ ...request, headers: { "x-forwarded-for": "spoof" } }, 2), "192.0.2.1");
});

test("stable heartbeat primary identity is scoped; payload hash ignores only recovery transport metadata", () => {
  const operationId = randomUUID();
  const first = heartbeatTelemetryIdentity(binding, operationId, { b: [1, 2], a: { y: true, x: 3 } });
  const fallback = heartbeatTelemetryIdentity(binding, operationId, { a: { x: 3, y: true }, b: [1, 2], telemetryOperationId: operationId });
  assert.deepEqual(first, fallback);
  assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.match(first.payloadHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.id, heartbeatTelemetryIdentity({ ...binding, studentSessionId: "replacement" }, operationId, {}).id);
  assert.notEqual(first.payloadHash, heartbeatTelemetryIdentity(binding, operationId, { b: [2, 1] }).payloadHash);
  assert.equal(first.id, heartbeatTelemetryIdentity(binding, operationId, { different: true }).id);
});

test("delivery tracks actual transport finish and never converts a closed delivery to success", () => {
  const delivered = new DeviceTelemetryDelivery(); let count = 0;
  delivered.onFinished(() => count++); delivered.finish(); delivered.finish();
  assert.equal(count, 1); assert.equal(delivered.finished, true);
  const closed = new DeviceTelemetryDelivery(); closed.close(); closed.finish();
  assert.equal(closed.finished, false); assert.equal(closed.closed, true);
});

test("dispatcher verifies every operation and exact socket binding before execution", async () => {
  let verifications = 0, executions = 0;
  const dispatcher = createDeviceTelemetryDispatcher({
    verifyToken: () => { verifications++; return { ...binding, sessionId: binding.studentSessionId }; },
    allowed: () => true,
    execute: async (_kind, context) => { executions++; return context.reply(200, { ok: true }); },
  });
  const invoke = (raw: unknown, scope = binding) => dispatcher(raw, { binding: scope, sourceIp: "203.0.113.4",
    delivery: new DeviceTelemetryDelivery(), reply: outcome => outcome });
  assert.equal((await invoke(frame())).status, 200);
  assert.equal((await invoke(frame())).status, 200);
  assert.equal(verifications, 2); assert.equal(executions, 2);
  assert.equal((await invoke(frame(), { ...binding, deviceId: "foreign" })).status, 403);
  assert.equal(executions, 2);
});

test("disabled negotiation and expired JWT cannot execute; source IP is server-derived", async () => {
  let executed = false;
  const disabled = createDeviceTelemetryDispatcher({ verifyToken: () => ({ ...binding, sessionId: binding.studentSessionId }),
    allowed: () => false, execute: async () => { executed = true; throw new Error("must not execute"); } });
  const scope = { binding, sourceIp: "203.0.113.4", delivery: new DeviceTelemetryDelivery(), reply: (value: any) => value };
  assert.equal((await disabled(frame(), scope)).body.code, "DEVICE_TELEMETRY_UNAVAILABLE");
  const expired = createDeviceTelemetryDispatcher({ verifyToken: () => { throw Object.assign(new Error("expired"), { status: 401 }); },
    allowed: () => true, execute: async () => { executed = true; throw new Error("must not execute"); } });
  assert.equal((await expired(frame(), scope)).status, 401); assert.equal(executed, false);
  const ordinary = createDeviceTelemetryDispatcher({ verifyToken: () => ({ ...binding, sessionId: binding.studentSessionId }),
    allowed: () => true, execute: async (_kind, context) => context.reply(200, { sourceIp: context.sourceIp }) });
  assert.equal((await ordinary(frame({ payload: { sourceIp: "attacker", schoolId: "foreign" } }), scope)).body.sourceIp, scope.sourceIp);
});

test("separate telemetry lanes reject duplicate work and do not wait for each other or controls", async () => {
  const lanes = createDeviceTelemetryLanes(); let release!: () => void, controls = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const heartbeat = lanes.run("heartbeat", async () => { await blocked; return "heartbeat"; });
  await tick();
  assert.equal(await lanes.run("heartbeat", async () => "must not run"), null);
  assert.equal(await lanes.run("screenshot", async () => "screenshot"), "screenshot");
  await Promise.resolve().then(() => { controls++; }); assert.equal(controls, 1);
  lanes.stop(); assert.equal(await lanes.run("screenshot", async () => "stopped"), null);
  release(); assert.equal(await heartbeat, "heartbeat"); await lanes.drain();
});
