import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classpilotScreenshotPolicyRefreshClaimDigest } from
  "../src/services/classpilotScreenshotPolicyRefreshClaim.js";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("screenshot refresh coalescing is scoped to the exact sorted target set", () => {
  const base = {
    schoolId: "school-1",
    teachingSessionId: "session-1",
    reason: "scope_changed" as const,
  };
  const first = classpilotScreenshotPolicyRefreshClaimDigest({
    ...base,
    studentIds: ["student-b", "student-a", "student-a"],
  });
  assert.equal(classpilotScreenshotPolicyRefreshClaimDigest({
    ...base,
    studentIds: ["student-a", "student-b"],
  }), first, "the same target set may coalesce regardless of input order");
  assert.notEqual(classpilotScreenshotPolicyRefreshClaimDigest({
    ...base,
    studentIds: ["student-c"],
  }), first, "a disjoint target set must receive an independent refresh claim");
});

test("observation changes publish one coalesced, authority-free session nudge", async () => {
  const [refresh, routes, redis, leases] = await Promise.all([
    source("src/services/classpilotScreenshotPolicyRefresh.ts"),
    source("src/routes/classpilot/monitoringEvents.ts"),
    source("src/realtime/ws-redis.ts"),
    source("src/services/classpilotObservationLease.ts"),
  ]);
  assert.match(refresh, /executeRealtimeRedisCommand/);
  assert.match(refresh, /SCREENSHOT_POLICY_REFRESH_COALESCE_MS/);
  assert.match(refresh, /getActiveSessionsForStudents/);
  assert.match(refresh, /kind: "students"/);
  assert.match(refresh, /targetDeviceIds/);
  assert.match(refresh, /type: "screenshot-policy-refresh"/);
  const frame = refresh.slice(
    refresh.indexOf("const message ="),
    refresh.indexOf("broadcastToStudentsLocal", refresh.indexOf("const message ="))
  );
  assert.doesNotMatch(frame, /deviceId/);
  assert.doesNotMatch(frame, /studentId|studentSessionId|controlRevision/);
  assert.doesNotMatch(refresh, /Promise\.all\(cohort\.map|withClasspilotStudentControlDeliveryAuthority/);
  assert.match(redis, /"screenshotActiveObservationCadenceV1"/);
  assert.match(routes, /lease\.activated \|\| \(!lease\.created && lease\.changed\)[\s\S]*nudgeClasspilotScreenshotPolicyRefresh/);
  assert.match(routes, /lease\.activated[\s\S]*studentIds: rosterStudentIds/);
  assert.match(routes, /reason: lease\.activated \? "activated" : "scope_changed"/);
  assert.match(routes, /releaseClasspilotObservationLeaseWithState[\s\S]*release\.deactivated[\s\S]*nudgeClasspilotScreenshotPolicyRefresh/);
  assert.match(routes, /reason: "released"/);
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
  assert.match(upload, /activeCadenceRolloutActive = isClasspilotCapabilityActive\([\s\S]*"screenshotActiveObservationCadenceV1"/);
  assert.match(upload, /activeCadenceNegotiated = activeCadenceRolloutActive[\s\S]*acceptedHeartbeatCapabilities\.has\("screenshotActiveObservationCadenceV1"\)/);
  assert.match(upload, /acceptedScreenshotCapabilities = \[\.\.\.acceptedHeartbeatCapabilities\]\.filter/);
  assert.match(upload, /resolveClasspilotScreenshotPolicy\([\s\S]*acceptedCapabilities: acceptedScreenshotCapabilities/);
  assert.doesNotMatch(upload, /acceptedCapabilities: \[\.\.\.acceptedHeartbeatCapabilities\]/);
  assert.match(upload, /retained: true,[\s\S]*screenshotPolicy: strictValue\.screenshotPolicy/);
  // "background" is issued both for "nobody is watching" and for "we could not
  // find out". Only the first may suppress the announcement.
  assert.match(upload, /strictCaptureCadence\?\.mode === "background"[\s\S]{0,200}status === "unobserved"/);
  assert.match(websocket, /resolveClasspilotScreenshotPolicy\([\s\S]*acceptedCapabilities: protocol\.acceptedCapabilities/);
});

test("the screenshot upload limiter clears the five-second cadence and names its 429", async () => {
  const devices = await source("src/routes/classpilot/devices.ts");
  const limiter = devices.slice(
    devices.indexOf("const deviceScreenshotLimiter = rateLimit({"),
    devices.indexOf("const extensionTelemetryLimiter")
  );
  assert.match(limiter, /windowMs: 60 \* 1000,/);
  // Twelve to thirteen uploads a minute at the active cadence, and from 2.8.2 a
  // navigation capture rides its own 1200ms gap rather than the cadence gap.
  // An app 429 here is a hard scale-readiness gate failure, so the ceiling must
  // stay well above both lanes.
  const max = Number(limiter.match(/max: ([0-9]+),/)?.[1]);
  assert.ok(max >= 40, `screenshot upload ceiling ${max} leaves no cadence headroom`);
  // Keep the justifying comment anchored to the client constant it cites.
  assert.match(limiter, /1200ms/);
  // The only rejection on this route that the extension used to receive with
  // no code at all: without one it can only back off blind.
  assert.match(limiter, /code: "SCREENSHOT_UPLOAD_RATE_LIMITED"/);
  assert.doesNotMatch(limiter, /screenshotPolicy/);
});
