import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("observation changes nudge only exact capable student bindings", async () => {
  const [refresh, routes, redis, leases] = await Promise.all([
    source("src/services/classpilotScreenshotPolicyRefresh.ts"),
    source("src/routes/classpilot/monitoringEvents.ts"),
    source("src/realtime/ws-redis.ts"),
    source("src/services/classpilotObservationLease.ts"),
  ]);
  assert.match(refresh, /withClasspilotStudentControlDeliveryAuthority/);
  assert.match(refresh, /getClasspilotScreenshotAuthorityProjection/);
  assert.match(refresh, /authority\.authority\.teachingSessionId !== options\.teachingSessionId/);
  assert.match(refresh, /requiredCapability: SCREENSHOT_POLICY_REFRESH_CAPABILITY/);
  assert.match(refresh, /type: "screenshot-policy-refresh"/);
  assert.match(refresh, /studentSessionId: session\.id/);
  const frame = refresh.slice(
    refresh.indexOf("const message ="),
    refresh.indexOf("sendToStudentBindingLocal", refresh.indexOf("const message ="))
  );
  assert.doesNotMatch(frame, /deviceId/);
  assert.match(redis, /"screenshotActiveObservationCadenceV1"/);
  assert.match(routes, /lease\.changed[\s\S]*nudgeClasspilotScreenshotPolicyRefresh/);
  assert.match(routes, /lease\.changed[\s\S]*studentIds: rosterStudentIds/);
  assert.match(routes, /releaseClasspilotObservationLease[\s\S]*nudgeClasspilotScreenshotPolicyRefresh/);
  assert.match(leases, /scopeKey[\s\S]*changed/);
});

test("heartbeat, websocket auth, and screenshot upload share cadence policy resolution", async () => {
  const [devices, websocket] = await Promise.all([
    source("src/routes/classpilot/devices.ts"),
    source("src/realtime/websocket.ts"),
  ]);
  const heartbeat = devices.slice(
    devices.indexOf('router.post("/device/heartbeat"'),
    devices.indexOf('router.post("/device/screenshot"')
  );
  const upload = devices.slice(
    devices.indexOf('router.post("/device/screenshot"'),
    devices.indexOf('router.post("/tiles/screenshots"')
  );
  assert.match(heartbeat, /resolveClasspilotScreenshotPolicy\([\s\S]*acceptedCapabilities: protocol\.acceptedCapabilities/);
  assert.match(upload, /resolveClasspilotScreenshotPolicy\([\s\S]*acceptedCapabilities: \[\.\.\.acceptedHeartbeatCapabilities\]/);
  assert.match(upload, /retained: true,[\s\S]*screenshotPolicy: strictValue\.screenshotPolicy/);
  assert.match(websocket, /resolveClasspilotScreenshotPolicy\([\s\S]*acceptedCapabilities: protocol\.acceptedCapabilities/);
});
