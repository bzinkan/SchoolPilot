import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWindowsScreenshotPolicy } from "../src/services/classpilotWindowsScreenshotPolicy.js";

const now = Date.parse("2026-10-29T14:00:00Z");
const base = {
  schoolId: "school", studentId: "student", now,
  acceptedCapabilities: ["scopedAuthorityChecksV1", "screenshotTrackingWindowLeaseV1", "screenshotActiveObservationCadenceV1"],
  trackingSettings: { enableTrackingHours: false, trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: ["Thursday"], schoolTimezone: "UTC", afterHoursMode: "off" as const },
  authority: { kind: "teaching_session" as const, teachingSessionId: "class", controlRevision: 7 },
  authorityStartedAt: new Date(now - 60_000), expiresAt: now + 120_000,
};

test("Windows active browser cadence uses the exact class lease and the earlier guard deadline", async () => {
  let calls = 0;
  const policy = await resolveWindowsScreenshotPolicy({ ...base, expiresAt: now + 21_900,
    observationStatus: async input => {
      calls++; assert.equal(input.schoolId, "school"); assert.equal(input.studentId, "student"); assert.equal(input.teachingSessionId, "class");
      return { status: "observed", expiresInSeconds: 84 };
    } });
  assert.equal(calls, 1); assert.equal(policy.captureAllowed, true); assert.equal(policy.expiresInSeconds, 21);
  assert.deepEqual(policy.captureCadence, { mode: "active_view", intervalSeconds: 5, expiresInSeconds: 21 });
  assert.deepEqual(policy.authority, base.authority);
});

test("missing, expired, unavailable or failed browser observation returns ordinary thirty-second monitoring", async () => {
  const statuses = [async () => ({ status: "unobserved" as const, expiresInSeconds: 0 }),
    async () => ({ status: "observed" as const, expiresInSeconds: 0 }),
    async () => ({ status: "unavailable" as const, expiresInSeconds: 0 as const }),
    async () => { throw new Error("Synthetic Redis outage"); }];
  for (const observationStatus of statuses) {
    const policy = await resolveWindowsScreenshotPolicy({ ...base, observationStatus });
    assert.equal(policy.captureAllowed, true); assert.equal(policy.expiresInSeconds, 45);
    assert.deepEqual(policy.captureCadence, { mode: "background", intervalSeconds: 30, expiresInSeconds: 45 });
  }
});

test("disabled tracking capability, expired authority and missing school policy never fall back to legacy capture", async () => {
  for (const changes of [{ acceptedCapabilities: [] }, { expiresAt: now }, { trackingSettings: undefined }]) {
    const policy = await resolveWindowsScreenshotPolicy({ ...base, ...changes });
    assert.equal(policy.mode, "tracking_window_lease"); assert.equal(policy.captureAllowed, false); assert.equal(policy.expiresInSeconds, 0);
  }
});

test("a student without classroom authority remains background-only even with an observation for another class", async () => {
  let calls = 0;
  const policy = await resolveWindowsScreenshotPolicy({ ...base, authority: { kind: "student_session", controlRevision: 0 },
    observationStatus: async () => { calls++; return { status: "observed", expiresInSeconds: 84 }; } });
  assert.equal(calls, 0); assert.equal(policy.captureAllowed, true);
  assert.deepEqual(policy.captureCadence, { mode: "background", intervalSeconds: 30, expiresInSeconds: 45 });
});

test("an observation response delayed beyond the guard deadline cannot renew browser capture", async context => {
  let clock = now;
  context.mock.method(Date, "now", () => clock);
  const policy = await resolveWindowsScreenshotPolicy({ ...base, now: undefined, expiresAt: now + 1_100,
    observationStatus: async () => { clock += 1_200; return { status: "observed", expiresInSeconds: 84 }; } });
  assert.equal(policy.captureAllowed, false); assert.equal(policy.expiresInSeconds, 0);
  assert.equal(policy.serverTime, new Date(clock).toISOString());
});
