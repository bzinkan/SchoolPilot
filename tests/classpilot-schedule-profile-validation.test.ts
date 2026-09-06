import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateScheduleProfileTestingWindows, scheduleProfileWindowHasFullMonitoring,
  type ScheduleProfileValidationFacts } from "../src/services/classpilotScheduleProfileValidation.js";
import { emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";
import type { ScheduleProfileTestingWindow } from "../src/services/classpilotScheduleProfileModel.js";
import type { HeartbeatTrackingSettings } from "../src/services/storage.js";

const tracking = (): HeartbeatTrackingSettings => ({ enableTrackingHours: true, trackingStartTime: "08:00", trackingEndTime: "15:00",
  trackingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], schoolTimezone: "America/New_York", afterHoursMode: "limited", instructionalCalendar: {}, schedulingDateOverrides: {} });
const testing = (): ScheduleProfileTestingWindow => ({ date: "2026-09-01", blockId: "reading", name: "MAP reading", coverageGroupId: "readers", assignedStaffId: "proctor", studentIds: ["student-1"], startTime: "10:00", endTime: "11:00" });
const group = (): ScheduleProfileValidationFacts["groups"][number] => ({ id: "math", name: "Math", scheduleEnabled: true, blockStartTime: "08:00", blockEndTime: "09:00", staffIds: ["proctor"], studentIds: ["student-1", "student-2"] });
const frozen = (): ScheduleProfileValidationFacts["sessions"][number] => ({ id: "session-1", groupId: "math", name: "Frozen Math", date: "2026-09-01", scheduledState: "active", startAt: "2026-09-01T14:00:00.000Z", endAt: "2026-09-01T15:00:00.000Z", rosterComplete: true, staffIds: ["proctor"], studentIds: ["student-1", "student-2"] });
const facts = (patch: Partial<ScheduleProfileValidationFacts> = {}): ScheduleProfileValidationFacts => ({ schoolTimezone: "America/New_York", tracking: tracking(), config: emptySchoolSchedulingConfig(), calendar: {}, groups: [group()], sessions: [], approved: [], today: "2026-09-01", ...patch });
const codes = (data: ScheduleProfileValidationFacts, windows = [testing()]) => evaluateScheduleProfileTestingWindows(windows, data).blockers.map((b) => b.code);

describe("Testing full-monitoring boundaries", () => {
  it("rejects a known late tracking start and any off/safety-only portion before expiry", () => {
    assert.equal(scheduleProfileWindowHasFullMonitoring(testing(), tracking()), true);
    assert.equal(scheduleProfileWindowHasFullMonitoring(testing(), { ...tracking(), trackingStartTime: "10:30" }), false);
    assert.equal(scheduleProfileWindowHasFullMonitoring(testing(), { ...tracking(), trackingEndTime: "10:30" }), false);
    assert.equal(scheduleProfileWindowHasFullMonitoring(testing(), { ...tracking(), trackingEndTime: "10:30", afterHoursMode: "full" }), true);
    assert.equal(scheduleProfileWindowHasFullMonitoring(testing(), undefined), false);
  });
  it("preserves the canonical inclusive final tracking minute and exclusive testing end", () => {
    assert.equal(scheduleProfileWindowHasFullMonitoring({ ...testing(), startTime: "15:00", endTime: "15:01" }, tracking()), true);
    assert.equal(scheduleProfileWindowHasFullMonitoring({ ...testing(), startTime: "15:00", endTime: "15:02" }, tracking()), false);
    assert.equal(scheduleProfileWindowHasFullMonitoring({ ...testing(), startTime: "14:00", endTime: "15:00" }, tracking()), true);
  });
  it("catches the middle daytime gap when both endpoints fall inside overnight hours", () => {
    const policy = { ...tracking(), trackingStartTime: "22:00", trackingEndTime: "06:00" };
    assert.equal(scheduleProfileWindowHasFullMonitoring({ ...testing(), startTime: "05:00", endTime: "23:00" }, policy), false);
    assert.equal(scheduleProfileWindowHasFullMonitoring({ ...testing(), startTime: "05:00", endTime: "06:00" }, policy), true);
    assert.equal(scheduleProfileWindowHasFullMonitoring({ ...testing(), startTime: "22:00", endTime: "23:00" }, policy), true);
  });
  it("honors makeup weekdays and blocks closed dates even when after-hours monitoring is full", () => {
    const weekend = { ...testing(), date: "2026-09-05" };
    assert.equal(scheduleProfileWindowHasFullMonitoring(weekend, tracking()), false);
    assert.equal(scheduleProfileWindowHasFullMonitoring(weekend, { ...tracking(), trackingDays: ["Monday"], schedulingDateOverrides: { "2026-09-05": { instructional: true, meetingWeekday: 1 } } }), true);
    assert.equal(scheduleProfileWindowHasFullMonitoring(testing(), { ...tracking(), afterHoursMode: "full", instructionalCalendar: { "2026-09": { nonInstructionalDates: [testing().date] } } }), false);
  });
});

describe("Effective testing proctor obligations", () => {
  it("blocks approved swapped time while permitting the unchanged earlier base class", () => {
    assert.deepEqual(codes(facts()), []);
    const approved = [{ id: "leg-1", groupId: "math", date: "2026-09-01", startTime: "10:00", endTime: "11:00" }];
    assert.deepEqual(codes(facts({ approved })), ["SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"]);
    assert.deepEqual(codes(facts({ approved }), [{ ...testing(), studentIds: ["student-1", "student-2"] }]), []);
  });
  it("uses frozen times, teachers and students after the mutable class has changed", () => {
    const data = facts({ sessions: [frozen()], groups: [{ ...group(), staffIds: ["replacement-teacher"], studentIds: ["student-1"] }] });
    assert.deepEqual(codes(data), ["SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"]);
    assert.deepEqual(codes(data, [{ ...testing(), assignedStaffId: "replacement-teacher" }]), []);
    assert.deepEqual(codes({ ...data, sessions: [{ ...frozen(), staffIds: ["primary", "proctor"] }] }), ["SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"]);
  });
  it("gives frozen occurrences priority over approved and recurring windows", () => {
    const data = facts({ sessions: [{ ...frozen(), startAt: "2026-09-01T12:00:00.000Z", endAt: "2026-09-01T13:00:00.000Z" }],
      approved: [{ id: "leg-1", groupId: "math", date: "2026-09-01", startTime: "10:00", endTime: "11:00" }],
      groups: [{ ...group(), blockStartTime: "10:00", blockEndTime: "11:00" }] });
    assert.deepEqual(codes(data), []);
    assert.deepEqual(codes({ ...data, sessions: [{ ...frozen(), scheduledState: "skipped" }] }), []);
  });
  it("requires a complete immutable roster before allowing whole-class testing", () => {
    assert.deepEqual(codes(facts({ sessions: [{ ...frozen(), studentIds: [], rosterComplete: false }] })), ["SCHEDULE_PROFILE_FROZEN_ROSTER_UNAVAILABLE"]);
    assert.deepEqual(codes(facts({ sessions: [{ ...frozen(), studentIds: [], rosterComplete: true }] })), []);
    assert.deepEqual(codes(facts({ sessions: [frozen()] }), [{ ...testing(), studentIds: ["student-1", "student-2", "student-3"] }]), []);
  });
  it("checks an open manual session today even when it began yesterday, without blocking tomorrow's planning", () => {
    const manual = { ...frozen(), date: null, scheduledState: null, startAt: "2026-08-31T20:00:00.000Z", endAt: null };
    const data = facts({ groups: [], sessions: [manual] });
    assert.deepEqual(codes(data), ["SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"]);
    assert.deepEqual(codes(data, [{ ...testing(), date: "2026-09-02" }]), []);
    assert.deepEqual(codes({ ...data, today: "2026-09-02" }, [{ ...testing(), date: "2026-09-02" }]), ["SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"]);
  });
  it("uses canonical school timezone for frozen UTC windows and respects touching endpoints", () => {
    const data = facts({ tracking: { ...tracking(), schoolTimezone: "UTC" }, sessions: [frozen()] });
    assert.deepEqual(codes(data), ["SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT"]);
    assert.deepEqual(codes(data, [{ ...testing(), startTime: "11:00", endTime: "12:00" }]), []);
  });
  it("fingerprints mutable facts and the local date, without including a changing instant", () => {
    const original = evaluateScheduleProfileTestingWindows([testing()], facts()).fingerprint;
    assert.equal(evaluateScheduleProfileTestingWindows([testing()], facts()).fingerprint, original);
    assert.notEqual(evaluateScheduleProfileTestingWindows([testing()], facts({ today: "2026-09-02" })).fingerprint, original);
    assert.notEqual(evaluateScheduleProfileTestingWindows([testing()], facts({ tracking: { ...tracking(), trackingEndTime: "10:30" } })).fingerprint, original);
    assert.notEqual(evaluateScheduleProfileTestingWindows([testing()], facts({ groups: [{ ...group(), studentIds: ["student-1"] }] })).fingerprint, original);
    assert.notEqual(evaluateScheduleProfileTestingWindows([testing()], facts({ sessions: [frozen()] })).fingerprint, original);
  });
});
