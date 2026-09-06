import { test } from "node:test";
import assert from "node:assert/strict";
import { decideMonitoringInterruption, monitoringDigestWindow, monitoringDigestWindowForDate } from "../src/services/classpilotMonitoringInterruptionRules.js";
import type { ClasspilotRealtimeStatus } from "../src/services/classpilotRealtimeStatus.js";
const now = Date.parse("2026-09-08T15:00:00Z");
const snapshot: ClasspilotRealtimeStatus = { schemaVersion: 2, state: "active", schoolId: "school", studentId: "student", studentSessionId: "session", deviceId: "device", heartbeatId: "heartbeat", revision: 1, observedAt: now - 10_000, activeTabUrl: "", activeTabTitle: "", allOpenTabs: [], openTabCount: 0, tabsTruncated: false, activityState: "active", classroomControls: { screenLocked: false, flightPathActive: false, isSharing: false, cameraActive: false }, classificationPending: false };
const base = { now, scopeStartedAt: now - 600_000, fullMonitoring: true };
test("never infers an interruption from authentication presence or a never-observed scope", () => {
  assert.equal(decideMonitoringInterruption({ ...base, reading: { status: "miss" } }).state, "unseen");
  assert.equal(decideMonitoringInterruption({ ...base, scopeStartedAt: now, reading: { status: "hit", snapshot } }).state, "unseen");
});
test("opens after 60 seconds and preserves evidence after realtime expiry", () => {
  assert.equal(decideMonitoringInterruption({ ...base, previousLastObservedAt: now - 60_000, reading: { status: "miss" } }).state, "observed");
  assert.equal(decideMonitoringInterruption({ ...base, previousLastObservedAt: now - 60_001, reading: { status: "miss" } }).state, "gap");
  assert.equal(decideMonitoringInterruption({ ...base, previousLastObservedAt: now - 400_000, reading: { status: "expired" } }).state, "gap");
});
test("Redis failure and binding mismatch are uncertainty, never evidence of student silence", () => {
  for (const status of ["unavailable", "mismatch", "rejected"] as const) assert.equal(decideMonitoringInterruption({ ...base, previousLastObservedAt: now - 120_000, reading: { status } }).state, "uncertain");
});
test("nonfull policy, privacy off, and signed-out state end the expectation", () => {
  assert.equal(decideMonitoringInterruption({ ...base, fullMonitoring: false, reading: { status: "hit", snapshot } }).reason, "monitoring_off");
  assert.equal(decideMonitoringInterruption({ ...base, reading: { status: "hit", snapshot: { ...snapshot, activityState: "off" } } }).reason, "privacy_off");
  assert.equal(decideMonitoringInterruption({ ...base, reading: { status: "hit", snapshot: { ...snapshot, state: "signed_out" } } }).reason, "binding_ended");
});
test("fresh exact telemetry can recover an expectation while future timestamps cannot", () => {
  assert.equal(decideMonitoringInterruption({ ...base, previousLastObservedAt: now - 180_000, reading: { status: "hit", snapshot } }).state, "observed");
  assert.equal(decideMonitoringInterruption({ ...base, reading: { status: "hit", snapshot: { ...snapshot, observedAt: now + 30_000 } } }).state, "uncertain");
});
const dayPolicy = { schoolTimezone: "America/New_York", trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: ["Tuesday"] };
test("digest becomes due 30 minutes after school-local tracking end", () => {
  assert.equal(monitoringDigestWindow(new Date("2026-09-08T19:29:59Z"), dayPolicy), null);
  const due = monitoringDigestWindow(new Date("2026-09-08T19:30:00Z"), dayPolicy);
  assert.equal(due?.localDate, "2026-09-08");
  assert.equal(due?.dueAt.toISOString(), "2026-09-08T19:30:00.000Z");
});
test("overnight digest belongs to its tracking-start day and invalid windows are not scheduled", () => {
  const policy = { ...dayPolicy, trackingStartTime: "20:00", trackingEndTime: "02:00", trackingDays: ["Monday"] };
  const due = monitoringDigestWindow(new Date("2026-09-08T06:30:00Z"), policy);
  assert.equal(due?.localDate, "2026-09-07");
  assert.equal(monitoringDigestWindow(new Date("2026-09-08T06:29:00Z"), policy), null);
  assert.equal(monitoringDigestWindow(new Date(), { ...dayPolicy, trackingEndTime: "99:00" }), null);
});

test("Saturday makeup follows its assigned Monday tracking day at the exact digest boundary", () => {
  const policy = { ...dayPolicy, trackingDays: ["Monday"], schedulingDateOverrides: { "2026-09-12": { instructional: true, meetingWeekday: 1 } } };
  assert.equal(monitoringDigestWindow(new Date("2026-09-12T19:29:59Z"), policy), null);
  const due = monitoringDigestWindow(new Date("2026-09-12T19:30:00Z"), policy);
  assert.equal(due?.localDate, "2026-09-12");
  assert.equal(due?.dueAt.toISOString(), "2026-09-12T19:30:00.000Z");
  assert.equal(monitoringDigestWindowForDate("2026-09-12", { ...policy, schedulingDateOverrides: {} }), null);
  assert.equal(monitoringDigestWindowForDate("2026-09-12", { ...policy, trackingDays: ["Tuesday"] }), null);
});

test("calendar closures exclude digest dates while explicit instructional overrides take precedence", () => {
  const policy = { ...dayPolicy, instructionalCalendar: { "2026-09": { revision: 1, nonInstructionalDates: ["2026-09-08"] } } };
  assert.equal(monitoringDigestWindow(new Date("2026-09-08T19:30:00Z"), policy), null);
  assert.equal(monitoringDigestWindowForDate("2026-09-08", policy), null, "pending deliveries recheck closure before submission");
  assert.equal(monitoringDigestWindowForDate("2026-09-08", { ...policy, schedulingDateOverrides: { "2026-09-08": { instructional: true } } })?.localDate, "2026-09-08");
});

test("overnight weekend makeup digest belongs to its instructional start date, not the closed next day", () => {
  const policy = { ...dayPolicy, trackingStartTime: "22:00", trackingEndTime: "02:00", trackingDays: ["Monday"], schedulingDateOverrides: { "2026-09-12": { instructional: true, meetingWeekday: 1 } } };
  assert.equal(monitoringDigestWindow(new Date("2026-09-13T06:29:59Z"), policy), null);
  const due = monitoringDigestWindow(new Date("2026-09-13T06:30:00Z"), policy);
  assert.equal(due?.localDate, "2026-09-12");
  assert.equal(due?.endAt.toISOString(), "2026-09-13T06:00:00.000Z");
  assert.equal(monitoringDigestWindow(new Date("2026-09-13T06:30:00Z"), { ...policy, schedulingDateOverrides: { "2026-09-12": { instructional: false } } }), null);
});
