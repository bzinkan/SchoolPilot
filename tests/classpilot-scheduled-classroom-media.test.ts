import assert from "node:assert/strict";
import { test } from "node:test";
import { ClasspilotScreenshotFallbackStore } from "../src/services/classpilotScreenshotFallback.js";
import { parseClasspilotScreenshotAuthority, resolveClasspilotScreenshotPolicy, validateClasspilotScreenshotCapturedAt } from "../src/services/classpilotScreenshotPolicy.js";
import { classpilotScreenshotPolicyRefreshClaimDigest } from "../src/services/classpilotScreenshotPolicyRefreshClaim.js";
import { supervisionBoundScreenshotBindingVersion } from "../src/realtime/ws-redis.js";
import { renewClasspilotSupervisionObservationLease, resetClasspilotObservationLeasesForTests } from "../src/services/classpilotObservationLease.js";

const now = Date.parse("2026-09-15T13:11:05.000Z");
const binding = { schoolId: "scheduled-media-school", studentId: "student", deviceId: "device", studentSessionId: "student-session",
  supervisionContextId: "activity", controlRevision: 4 };
const authority = { authority: { kind: "supervision_context" as const, supervisionContextId: "activity", controlRevision: 4 },
  authorityStartedAt: new Date(now - 5_000), authorityExpiresAt: new Date(now + 55_000) };
const trackingSettings = { enableTrackingHours: false, trackingStartTime: "08:00", trackingEndTime: "16:00",
  trackingDays: ["Tuesday"], schoolTimezone: "America/New_York", afterHoursMode: "off" as const };

test("scheduled screenshot authority rejects mixed parents, extra keys and stale revisions", () => {
  assert.deepEqual(parseClasspilotScreenshotAuthority(authority.authority), authority.authority);
  for (const value of [{ ...authority.authority, teachingSessionId: "class" },
    { ...authority.authority, controlRevision: -1 }, { ...authority.authority, extra: true },
    { ...authority.authority, supervisionContextId: "" }]) assert.equal(parseClasspilotScreenshotAuthority(value), null);
});

test("fallback never substitutes a previous class or another supervision revision", () => {
  const store = new ClasspilotScreenshotFallbackStore(4096, 120_000, 8, () => now);
  const pixels = { ...binding, screenshot: "current", timestamp: now, capturedAt: new Date(now).toISOString(),
    bindingVersion: supervisionBoundScreenshotBindingVersion(binding) };
  assert.equal(store.setSupervisionBound(binding, pixels), true);
  assert.equal(store.getSupervisionBound(binding)?.screenshot, "current");
  assert.equal(store.getSupervisionBound({ ...binding, controlRevision: 5 }), null);
  assert.equal(store.getSupervisionBound({ ...binding, supervisionContextId: "next" }), null);
  const { supervisionContextId, ...exact } = binding;
  assert.equal(store.getClassBound({ ...exact, teachingSessionId: supervisionContextId }), null);
  assert.equal(store.get(exact), null);
});

test("old extensions cannot capture under a scheduled supervision authority", async () => {
  const policy = await resolveClasspilotScreenshotPolicy({ schoolId: binding.schoolId, studentId: binding.studentId,
    teachingSessionId: null, acceptedCapabilities: ["screenshotTrackingWindowLeaseV1"], trackingSettings, trackingAuthority: authority, now });
  assert.equal(policy.mode, "tracking_window_lease");
  if (policy.mode === "tracking_window_lease") { assert.equal(policy.captureAllowed, false); assert.equal(policy.authority.kind, "student_session"); }
});

test("scheduled observation accelerates capture only within the current authority lease", async () => {
  const previousRedis = process.env.REDIS_URL;
  process.env.REDIS_URL = "";
  resetClasspilotObservationLeasesForTests();
  try {
    await renewClasspilotSupervisionObservationLease({ schoolId: binding.schoolId, supervisionContextId: binding.supervisionContextId,
      viewerUserId: "teacher", viewerInstanceId: "viewer-instance", scope: { kind: "students", studentIds: [binding.studentId] }, now });
    const policy = await resolveClasspilotScreenshotPolicy({ schoolId: binding.schoolId, studentId: binding.studentId,
      teachingSessionId: null, acceptedCapabilities: ["scheduledClassroomV1", "screenshotTrackingWindowLeaseV1", "screenshotActiveObservationCadenceV1"],
      trackingSettings, trackingAuthority: authority, now });
    assert.equal(policy.mode, "tracking_window_lease");
    if (policy.mode === "tracking_window_lease") {
      assert.equal(policy.captureAllowed, true); assert.equal(policy.captureCadence?.intervalSeconds, 5);
      assert.ok(policy.expiresInSeconds <= 55); assert.ok((policy.captureCadence?.expiresInSeconds ?? Infinity) <= 55);
    }
    const expired = await resolveClasspilotScreenshotPolicy({ schoolId: binding.schoolId, studentId: binding.studentId, teachingSessionId: null,
      acceptedCapabilities: ["scheduledClassroomV1", "screenshotTrackingWindowLeaseV1"], trackingSettings, trackingAuthority: authority, now: now + 55_000 });
    assert.equal(expired.mode === "tracking_window_lease" && expired.captureAllowed, false);
  } finally { resetClasspilotObservationLeasesForTests(); if (previousRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousRedis; }
});

test("capture times and refresh namespaces cannot cross the handoff boundary", () => {
  assert.equal(validateClasspilotScreenshotCapturedAt({ capturedAt: new Date(now - 5_001), now, trackingSettings, trackingAuthority: authority }), "before_authority");
  assert.notEqual(validateClasspilotScreenshotCapturedAt({ capturedAt: new Date(now - 90_000), now, trackingSettings, trackingAuthority: authority }), "ok");
  const scope = { schoolId: binding.schoolId, studentIds: [binding.studentId], reason: "activated" as const };
  assert.notEqual(classpilotScreenshotPolicyRefreshClaimDigest({ ...scope, supervisionContextId: "activity" }),
    classpilotScreenshotPolicyRefreshClaimDigest({ ...scope, teachingSessionId: "activity" }));
  assert.throws(() => classpilotScreenshotPolicyRefreshClaimDigest({ ...scope, supervisionContextId: "activity", teachingSessionId: "class" }));
});
