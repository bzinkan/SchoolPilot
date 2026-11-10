import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveClasspilotScreenshotPolicy } from "../src/services/classpilotScreenshotPolicy.js";
import { detailPreviewBindingVersion, detailPreviewStatus, renewDetailPreview, releaseDetailPreview,
  readDetailPreview, writeDetailPreview } from "../src/services/classpilotDetailPreview.js";

const now = Date.parse("2026-11-10T15:00:00Z");
const binding = { schoolId: "detail-school", studentId: "detail-student", studentSessionId: "detail-login", deviceId: "private-device" };
const options = {
  ...binding, now, teachingSessionId: "detail-class",
  acceptedCapabilities: ["scopedAuthorityChecksV1", "screenshotTrackingWindowLeaseV1", "screenshotActiveObservationCadenceV1"],
  trackingSettings: { enableTrackingHours: false, trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: ["Tuesday"], schoolTimezone: "UTC", afterHoursMode: "off" as const },
  trackingAuthority: { authority: { kind: "teaching_session" as const, teachingSessionId: "detail-class", controlRevision: 7 }, authorityStartedAt: new Date(now - 60_000), authorityExpiresAt: null },
  observationStatus: async () => ({ status: "observed" as const, expiresInSeconds: 84 }),
  detailPreviewStatus: async () => ({ leaseId: "abcdefghijklmnopqrstuvwx12345678", startedAt: now - 100, expiresAt: now + 20_000 }),
};

test("a selected exact browser binding receives a short high-quality policy only within active observation", async context => {
  context.mock.method(Date, "now", () => now);
  const policy = await resolveClasspilotScreenshotPolicy(options);
  assert.equal(policy.mode, "tracking_window_lease");
  assert.deepEqual("detailPreview" in policy ? policy.detailPreview : undefined, {
    mode: "selected_student", leaseId: "abcdefghijklmnopqrstuvwx12345678", expiresInSeconds: 20,
    intervalSeconds: 5, maxWidth: 1920, jpegQuality: 90,
  });
});

const detailBinding = { ...binding, teachingSessionId: "detail-class", controlRevision: 7 };
const viewer = { schoolId: binding.schoolId, viewerUserId: "teacher", viewerInstanceId: "visible-drawer" };
function image(at: number, selected = detailBinding) {
  return { screenshot: "data:image/jpeg;base64,/9j/2Q==", timestamp: at, capturedAt: new Date(at).toISOString(),
    bindingVersion: detailPreviewBindingVersion(selected), resolution: "detail" as const, captureCadenceMode: "active_view" as const };
}
test("coalesced viewers retain detail only while their own current exact selection is leased", async () => {
  const first = await renewDetailPreview({ ...viewer, binding: detailBinding, now });
  const other = { ...viewer, viewerUserId: "observer" };
  const second = await renewDetailPreview({ ...other, binding: detailBinding, now: now + 100 });
  assert.equal(first.leaseId, second.leaseId);
  assert.equal(await writeDetailPreview({ binding: detailBinding, leaseId: first.leaseId, image: image(now + 200), now: now + 200 }), "stored");
  assert.deepEqual(await readDetailPreview({ ...viewer, binding: detailBinding, now: now + 300 }), image(now + 200));
  assert.equal(await readDetailPreview({ ...viewer, binding: { ...detailBinding, controlRevision: 8 }, now: now + 300 }), null);
  assert.equal(await readDetailPreview({ ...viewer, viewerUserId: "unauthorized", binding: detailBinding, now: now + 300 }), null);
  assert.equal(await releaseDetailPreview({ ...viewer, leaseId: first.leaseId, now: now + 400 }), true);
  assert.equal(await readDetailPreview({ ...viewer, binding: detailBinding, now: now + 400 }), null);
  assert.deepEqual(await readDetailPreview({ ...other, binding: detailBinding, now: now + 400 }), image(now + 200));
  assert.equal(await releaseDetailPreview({ ...other, leaseId: first.leaseId, now: now + 500 }), true);
  assert.equal(await detailPreviewStatus({ binding: detailBinding, now: now + 500 }), null);
  assert.equal(await writeDetailPreview({ binding: detailBinding, leaseId: first.leaseId, image: image(now + 600), now: now + 600 }), "stale");
});

test("changing a viewer's selected student cancels only that viewer and stale releases cannot remove a replacement lease", async () => {
  const old = await renewDetailPreview({ ...viewer, binding: detailBinding, now });
  const replacement = { ...detailBinding, studentId: "other-student" };
  const next = await renewDetailPreview({ ...viewer, binding: replacement, now: now + 100 });
  assert.notEqual(old.leaseId, next.leaseId);
  assert.equal(await detailPreviewStatus({ binding: detailBinding, now: now + 100 }), null);
  assert.equal(await releaseDetailPreview({ ...viewer, leaseId: old.leaseId, now: now + 200 }), false);
  assert.equal((await detailPreviewStatus({ binding: replacement, now: now + 200 }))?.leaseId, next.leaseId);
});

test("detail uploads reject pre-lease, expired, future, old-generation and out-of-order frames", async () => {
  const own = { ...viewer, viewerInstanceId: "time-fences" };
  const selected = { ...detailBinding, studentId: "time-student" };
  const lease = await renewDetailPreview({ ...own, binding: selected, now });
  for (const captureAt of [now - 1, now + 1001, now - 20_001]) {
    assert.equal(await writeDetailPreview({ binding: selected, leaseId: lease.leaseId, image: image(captureAt, selected), now }), "stale");
  }
  assert.equal(await writeDetailPreview({ binding: selected, leaseId: lease.leaseId, image: image(now, selected), now }), "stored");
  assert.equal(await writeDetailPreview({ binding: selected, leaseId: lease.leaseId, image: image(now, selected), now: now + 100 }), "superseded");
  assert.equal(await detailPreviewStatus({ binding: selected, now: now + 20_000 }), null);
  const next = await renewDetailPreview({ ...own, binding: selected, now: now + 21_000 });
  assert.notEqual(next.leaseId, lease.leaseId);
  assert.equal(await writeDetailPreview({ binding: selected, leaseId: lease.leaseId, image: image(now + 21_000, selected), now: now + 21_000 }), "stale");
  assert.equal(await readDetailPreview({ ...own, binding: selected, now: now + 21_000 }), null);
});

test("detail grants are absent for hidden/unobserved, unsupported, student-only or delayed policies", async context => {
  context.mock.method(Date, "now", () => now);
  const cases = [
    { observationStatus: async () => ({ status: "unobserved" as const, expiresInSeconds: 0 }) },
    { acceptedCapabilities: ["scopedAuthorityChecksV1", "screenshotTrackingWindowLeaseV1"] },
    { acceptedCapabilities: ["screenshotTrackingWindowLeaseV1", "screenshotActiveObservationCadenceV1"] },
    { deviceId: undefined },
    { trackingAuthority: { ...options.trackingAuthority, authority: { kind: "student_session" as const, controlRevision: 7 } } },
    { acceptedCapabilities: [...options.acceptedCapabilities, "screenshotReadOnlyObservationV1"], trackingAuthority: {
      ...options.trackingAuthority, authority: { kind: "student_session" as const, controlRevision: 7 },
      reportingObservation: { teachingSessionId: "detail-class", startsAt: new Date(now - 60_000), expiresAt: new Date(now + 90_000) } } },
    { detailPreviewStatus: async () => { context.mock.method(Date, "now", () => now + 20_000); return { leaseId: "abcdefghijklmnopqrstuvwx12345678", startedAt: now, expiresAt: now + 20_000 }; } },
  ];
  for (const changes of cases) {
    const policy = await resolveClasspilotScreenshotPolicy({ ...options, ...changes });
    assert.equal("detailPreview" in policy, false);
  }
});

test("a required shared store outage cannot read local detail demand or pixels", async () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    await assert.rejects(() => detailPreviewStatus({ binding: detailBinding, now }), /storage unavailable/);
    await assert.rejects(() => readDetailPreview({ ...viewer, binding: detailBinding, now }), /storage unavailable/);
  } finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});
