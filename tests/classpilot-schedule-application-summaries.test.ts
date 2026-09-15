import { test } from "node:test";
import assert from "node:assert/strict";
import { applicationCancellation, applicationHistoryRemoval, createApplicationTimingResolver, summarizeScheduleApplications, type ApplicationHistorySupervision } from "../src/services/classpilotScheduleApplicationSummaries.js";
import type { ScheduleProfileApplication } from "../src/services/classpilotScheduleProfileModel.js";
import type { ProfileSupervisionStatus } from "../src/services/classpilotScheduleProfileSupervision.js";
import { defaultClassScheduleRule, emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";

const schoolTimezone = "America/New_York", date = "2026-09-14";
const now = new Date("2026-09-14T12:00:00Z");
const classes = [{ id: "math", scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: defaultClassScheduleRule() },
  { id: "reading", scheduleEnabled: true, blockStartTime: "10:00", blockEndTime: "10:50", scheduleRule: defaultClassScheduleRule() }];
const config = emptySchoolSchedulingConfig();
function present<T>(value: T | undefined): T { assert.ok(value !== undefined); return value; }
function application(overrides: Partial<ScheduleProfileApplication> = {}): ScheduleProfileApplication {
  return { id: "application", profileId: "profile", profileName: "MAP", profileRevision: 1, dates: [date],
    definition: { name: "MAP", classIds: ["math", "reading"], grades: [], classRules: [], testingBlocks: [] },
    classWindows: { [date]: { math: { startTime: "11:00", endTime: "11:50" }, reading: null } }, testingWindows: [],
    status: "scheduled", createdBy: "admin", createdAt: "2026-09-01T12:00:00Z", ...overrides };
}
const block = (id: string, blockDate = date) => ({ blockId: id, date: blockDate, name: id, coverageGroupId: "group", assignedStaffId: "teacher", studentIds: ["student"], startTime: "09:00", endTime: "10:45" });
const timing = (overrides: Partial<Parameters<typeof createApplicationTimingResolver>[0]> = {}) => createApplicationTimingResolver({ classes, config, calendar: {}, schoolTimezone, ...overrides });

test("history removal uses all dates and the school-local midnight boundary, including cancelled and no-change dates", () => {
  const app = application({ dates: ["2026-09-13", date], status: "cancelled", classWindows: {}, testingWindows: [] });
  const check = (checkedAt: string, value = app) => applicationHistoryRemoval({ application: value, testingStatuses: [], supervision: [], schoolTimezone, now: new Date(checkedAt) });
  assert.equal(check("2026-09-15T03:59:59Z").reason, "not_past");
  assert.deepEqual(check("2026-09-15T04:00:00Z"), { canRequest: true, reason: "available", checkedAt: "2026-09-15T04:00:00.000Z" });
  assert.equal(check("2026-09-15T04:00:00Z", { ...app, dates: [...app.dates, "2026-09-16"] }).reason, "not_past");
  assert.equal(check("2026-09-15T04:00:00Z", { ...app, historyHiddenAt: "2026-09-15T04:00:00Z", historyHiddenBy: "admin" }).reason, "hidden");
});

test("history removal requires terminal outcomes and independently resolved, released actual supervision", () => {
  const app = application({ testingWindows: [block("test")] });
  const checkedAt = new Date("2026-09-15T12:00:00Z");
  const ended: ApplicationHistorySupervision = { id: "context", applicationId: app.id, date, blockId: "test", status: "ended", endedAt: now, hasUnreleasedStudents: false };
  const status: ProfileSupervisionStatus = { applicationId: app.id, date, blockId: "test", status: "ended", code: "ENDED", contextId: ended.id };
  const check = (testingStatuses = [status], supervision: ApplicationHistorySupervision[] | undefined = [ended]) => applicationHistoryRemoval({ application: app, testingStatuses, supervision, schoolTimezone, now: checkedAt });
  assert.equal(check().reason, "available");
  for (const terminal of ["failed", "missed", "cancelled"] as const) assert.equal(check([{ ...status, status: terminal, contextId: undefined }], []).reason, "available");
  for (const pending of ["pending", "active", "releasing"] as const) assert.equal(check([{ ...status, status: pending }]).reason, "supervision_pending");
  assert.equal(check([], []).reason, "unavailable");
  assert.equal(check([status, status]).reason, "unavailable");
  assert.equal(check([status], []).reason, "unavailable", "an ended outcome cannot replace the actual context");
  for (const patch of [{ status: "active" }, { hasUnreleasedStudents: true }]) assert.equal(check([status], [{ ...ended, ...patch }]).reason, "supervision_pending");
  for (const patch of [{ status: "unknown" }, { endedAt: null }, { endedAt: new Date("2030-01-01") }, { applicationId: "other" }, { blockId: "unknown" }]) assert.equal(check([status], [{ ...ended, ...patch }]).reason, "unavailable");
  assert.equal(applicationHistoryRemoval({ application: app, testingStatuses: [status], supervision: [ended], unresolvedApplicationIds: [app.id], schoolTimezone, now: checkedAt }).reason, "unavailable");
  assert.equal(applicationHistoryRemoval({ application: { ...app, testingWindows: [] }, testingStatuses: [], supervision: [{ ...ended, status: "active" }], schoolTimezone, now: checkedAt }).reason, "supervision_pending", "unexpected actual contexts cannot be hidden by an empty snapshot");
});
function summaries(apps: ScheduleProfileApplication[], statuses: ProfileSupervisionStatus[] = [], checkedAt = now) {
  return summarizeScheduleApplications({ applications: apps, testingStatuses: statuses, timing: timing(), schoolTimezone, now: checkedAt });
}

test("summaries count actual per-date snapshots rather than selected classes or definition rules", () => {
  const app = application({ dates: [date, "2026-09-15", "2026-09-16", "2026-09-17"],
    classWindows: { [date]: { math: { startTime: "09:00", endTime: "09:50" }, reading: null }, "2026-09-15": {}, "2026-09-16": { math: null } },
    testingWindows: [block("today"), block("tomorrow", "2026-09-17")] });
  const original = structuredClone(app);
  const result = summaries([app], [{ applicationId: app.id, date, blockId: "today", status: "ended", code: "ENDED" },
    { applicationId: app.id, date: "2026-09-17", blockId: "tomorrow", status: "pending", code: "AWAITING_WINDOW" }]);
  const summary = present(result.applicationSummaries[app.id]);
  assert.deepEqual(summary.dates.map((row) => [row.date, row.phase, row.customTimeCount, row.skippedClassCount, row.testingBlockCount]), [
    [date, "today", 1, 1, 1], ["2026-09-15", "no_changes", 0, 0, 0], ["2026-09-16", "future", 0, 1, 0], ["2026-09-17", "future", 0, 0, 1],
  ]);
  assert.equal(summary.nextFutureDate, "2026-09-16");
  assert.equal(summary.appliedToday, true, "finished testing does not mark today's class rules completed");
  assert.equal(present(summary.dates[0]).testingOutcomes.ended, 1);
  assert.equal(result.summariesCheckedAt, now.toISOString());
  assert.equal(result.nextSchoolDateAt, "2026-09-15T04:00:00.000Z");
  assert.deepEqual(app, original, "read metadata never mutates application snapshots");
});

test("every testing outcome is counted per window; missing, duplicate and overdue pending data stay unknown", () => {
  const known = ["pending", "active", "ended", "failed", "missed", "cancelled", "releasing"] as const;
  const app = application({ testingWindows: [...known, "missing", "duplicate"].map((id) => block(id)) });
  const statuses: ProfileSupervisionStatus[] = known.map((status) => ({ applicationId: app.id, date, blockId: status, status, code: status }));
  statuses.push({ applicationId: app.id, date, blockId: "duplicate", status: "ended", code: "ENDED" }, { applicationId: app.id, date, blockId: "duplicate", status: "failed", code: "FAILED" });
  const before = present(present(summaries([app], statuses).applicationSummaries[app.id]).dates[0]).testingOutcomes;
  for (const state of known) assert.equal(before[state], 1, state);
  assert.equal(before.unknown, 2);
  const afterDate = present(present(summaries([app], statuses, new Date("2026-09-14T15:00:00Z")).applicationSummaries[app.id]).dates[0]);
  const after = afterDate.testingOutcomes;
  assert.equal(after.pending, 0);
  assert.equal(after.unknown, 3);
  assert.equal(after.missed, 1, "a missing worker receipt does not invent a missed transition");
  assert.deepEqual(afterDate.testingStatusByBlock, { pending: "unknown", active: "active", ended: "ended", failed: "failed", missed: "missed", cancelled: "cancelled", releasing: "releasing", missing: "unknown", duplicate: "unknown" });
});

test("cancellation cuts off at the earliest original, proposed, skipped or testing start across all dates", () => {
  const app = application({ dates: ["2026-09-15", date], testingWindows: [block("map", "2026-09-15")] });
  assert.deepEqual(applicationCancellation(app, timing()(app), now), { canRequest: true, cutoffAt: "2026-09-14T13:00:00.000Z", reason: null });
  assert.deepEqual(applicationCancellation(app, timing()(app), new Date("2026-09-14T13:00:00Z")), { canRequest: false, cutoffAt: "2026-09-14T13:00:00.000Z", reason: "started" });
  const earlier = application({ classWindows: { [date]: { math: { startTime: "08:30", endTime: "08:50" } } } });
  assert.equal(applicationCancellation(earlier, timing()(earlier), now).cutoffAt, "2026-09-14T12:30:00.000Z");
  const skipped = application({ classWindows: { [date]: { reading: null } } });
  assert.equal(applicationCancellation(skipped, timing()(skipped), now).cutoffAt, "2026-09-14T14:00:00.000Z");
});

test("missing, disabled and unresolved original class times prevent a false available cancellation", () => {
  const app = application();
  for (const resolver of [timing({ classes: [] }), timing({ classes: classes.map((row) => ({ ...row, scheduleEnabled: false })) }),
    timing({ classes: classes.map((row) => ({ ...row, scheduleRule: { ...row.scheduleRule, periodId: "missing" } })) }),
    timing({ config: { ...config, dateOverrides: { [date]: { instructional: false } } } })]) {
    assert.deepEqual(applicationCancellation(app, resolver(app), now), { canRequest: false, cutoffAt: null, reason: "unavailable" });
  }
  assert.equal(applicationCancellation(app, timing({ classes: [] })(app), new Date("2026-09-14T16:00:00Z")).reason, "started", "a known proposed start proves closure even with missing earlier timing");
});

test("date-specific bells and rotation determine the original cancellation cutoff", () => {
  const periods = { ...config, periods: [{ id: "period", name: "First" }], profiles: [
    { id: "regular", name: "Regular", periods: { period: { startTime: "09:00", endTime: "09:50" } } },
    { id: "early", name: "Early", periods: { period: { startTime: "08:15", endTime: "09:00" } } },
  ], defaultProfileId: "regular", dateOverrides: { [date]: { profileId: "early", cycleDay: "B" as const } } };
  const app = application({ classWindows: { [date]: { math: { startTime: "11:00", endTime: "11:50" } } } });
  const math = present(classes[0]);
  const resolve = timing({ config: periods, classes: [{ ...math, scheduleRule: { ...math.scheduleRule, periodId: "period", cycleDay: "B" } }] });
  assert.equal(applicationCancellation(app, resolve(app), now).cutoffAt, "2026-09-14T12:15:00.000Z");
});

test("one resolver reuses timezone conversions for repeated windows without leaking between school timezones", (t) => {
  const formatter = t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts");
  const resolve = timing();
  const first = application({ testingWindows: [block("first")] });
  const expected = resolve(first), callsAfterFirst = formatter.mock.callCount();
  assert.ok(callsAfterFirst > 0, "the first application resolves its school-local clock instants");
  for (let index = 0; index < 100; index++) {
    const repeated = application({ id: `repeat-${index}`, status: index % 2 ? "cancelled" : "scheduled", testingWindows: [block(`block-${index}`)] });
    assert.deepEqual(resolve(repeated), expected);
  }
  assert.equal(formatter.mock.callCount(), callsAfterFirst, "repeated class/testing clock instants require no additional timezone conversions");
  const pacific = timing({ schoolTimezone: "America/Los_Angeles" })(first);
  assert.equal(pacific.earliestKnownStart, present(expected.earliestKnownStart ?? undefined) + 3 * 60 * 60 * 1000);
  assert.ok(formatter.mock.callCount() > callsAfterFirst, "another school's resolver has its own timezone-bound cache");
});

test("cancelled and no-effect dates never imply a next scheduled date or applied today", () => {
  const cancelled = application({ status: "cancelled", dates: [date, "2026-09-15"] });
  const empty = application({ id: "empty", classWindows: {} });
  const result = summaries([cancelled, empty]).applicationSummaries;
  const cancelledSummary = present(result[cancelled.id]), emptySummary = present(result[empty.id]);
  assert.equal(cancelledSummary.nextFutureDate, null);
  assert.equal(cancelledSummary.appliedToday, false);
  assert.equal(cancelledSummary.cancellation.reason, "cancelled");
  assert.ok(cancelledSummary.dates.every((row) => row.phase === "cancelled"));
  assert.equal(present(emptySummary.dates[0]).phase, "no_changes");
  assert.equal(emptySummary.cancellation.reason, "no_changes");
  assert.equal(emptySummary.cancellation.canRequest, false);
});

test("school date boundaries follow timezone midnight and daylight saving changes", () => {
  const app = application({ dates: [date, "2026-09-15"], classWindows: { [date]: { math: null }, "2026-09-15": { math: null } } });
  assert.equal(present(summaries([app], [], new Date("2026-09-15T03:59:59Z")).applicationSummaries[app.id]).appliedToday, true);
  assert.equal(present(present(summaries([app], [], new Date("2026-09-15T04:00:00Z")).applicationSummaries[app.id]).dates[0]).phase, "past");
  assert.equal(summaries([], [], new Date("2026-11-01T04:00:00Z")).nextSchoolDateAt, "2026-11-02T05:00:00.000Z");
  assert.equal(summaries([], [], new Date("2026-03-08T05:00:00Z")).nextSchoolDateAt, "2026-03-09T04:00:00.000Z");
});
