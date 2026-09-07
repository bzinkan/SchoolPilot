import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectClasspilotRegularSchedule, regularScheduleReferenceDate } from "../src/services/classpilotRegularSchedule.js";
import { defaultClassScheduleRule, emptySchoolSchedulingConfig, type SchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";
import type { ScheduleProfileApplication } from "../src/services/classpilotScheduleProfileModel.js";

const config: SchoolSchedulingConfig = {
  ...emptySchoolSchedulingConfig(), yearStart: "2026-09-01", yearEnd: "2027-06-30", cycleAnchorDate: "2026-09-01",
  periods: [{ id: "p1", name: "Period 1" }], defaultProfileId: "regular",
  profiles: [
    { id: "regular", name: "Regular", periods: { p1: { startTime: "09:00", endTime: "09:50" } } },
    { id: "early", name: "Early Release", periods: { p1: { startTime: "08:00", endTime: "08:30" } } },
  ], weekdayProfiles: { "3": "early" },
};
const fixed = { id: "fixed", scheduleEnabled: true, blockStartTime: "10:00", blockEndTime: "10:50", scheduleRule: defaultClassScheduleRule() };
const period = { ...fixed, id: "period", scheduleRule: { ...defaultClassScheduleRule(), periodId: "p1" } };
const project = (overrides: Partial<Parameters<typeof projectClasspilotRegularSchedule>[0]> = {}) => projectClasspilotRegularSchedule({
  referenceDate: "2026-09-02", revision: 7, schoolTimezone: "America/New_York", config, calendar: {}, classes: [fixed, period], ...overrides,
});

describe("Regular schedule reference projection", () => {
  it("requires a scalar real date and permits reading earlier dates without a start cutoff", () => {
    for (const value of [undefined, null, ["2026-09-02"], { date: "2026-09-02" }, "2026-9-02", "2026-02-30", "2026-09-02T00:00:00Z", " 2026-09-02"]) {
      assert.throws(() => regularScheduleReferenceDate(value), { code: "INVALID_REFERENCE_DATE", status: 400 });
    }
    assert.equal(regularScheduleReferenceDate("2024-02-29"), "2024-02-29");
    assert.equal(project({ referenceDate: "2024-09-02" }).classes[0]?.status, "meets");
  });

  it("resolves weekday bells instead of raw period-class clocks and returns only the public projection", () => {
    const result = project();
    assert.deepEqual(result, {
      referenceDate: "2026-09-02", revision: 7, schoolTimezone: "America/New_York",
      day: { instructional: true, meetingWeekday: 3, cycleDay: "B", bellProfile: { id: "early", name: "Early Release" }, overridden: false },
      classes: [
        { classId: "fixed", status: "meets", window: { startTime: "10:00", endTime: "10:50" } },
        { classId: "period", status: "meets", window: { startTime: "08:00", endTime: "08:30" } },
      ],
    });
    assert.deepEqual(project({ referenceDate: "2026-09-03" }).classes[1]?.window, { startTime: "09:00", endTime: "09:50" });
  });

  it("omits existing applied time/skip overlays without mutating the saved application", () => {
    const application: ScheduleProfileApplication = {
      id: "testing", profileId: "testing-template", profileName: "Testing", profileRevision: 1,
      dates: ["2026-09-02"], definition: { name: "Testing", grades: [], classIds: ["fixed", "period"],
        classRules: [{ classId: "fixed", action: "skip" }, { classId: "period", action: "time", startTime: "13:00", endTime: "14:00" }], testingBlocks: [] },
      classWindows: { "2026-09-02": { fixed: null, period: { startTime: "13:00", endTime: "14:00" } } },
      testingWindows: [], status: "scheduled", createdBy: "admin", createdAt: "2026-08-31T12:00:00Z",
    };
    const withApplication = { ...config, profileApplications: [application] };
    const before = structuredClone(withApplication);
    assert.deepEqual(project({ config: withApplication }), project());
    assert.deepEqual(withApplication, before);
  });

  it("keeps date eligibility and schedule-off outcomes separate", () => {
    const classes = [fixed, { ...fixed, id: "off", scheduleEnabled: false },
      { ...fixed, id: "monday", scheduleRule: { ...fixed.scheduleRule, weekdays: [1] } },
      { ...fixed, id: "term", scheduleRule: { ...fixed.scheduleRule, startsOn: "2026-09-03" } },
      { ...fixed, id: "a", scheduleRule: { ...fixed.scheduleRule, cycleDay: "A" as const } }];
    assert.deepEqual(project({ classes }).classes.map((row) => row.status), ["meets", "schedule_off", "not_scheduled", "not_scheduled", "not_scheduled"]);
    const closed = project({ classes, calendar: { "2026-09": { nonInstructionalDates: ["2026-09-02"] } } });
    assert.equal(closed.day.instructional, false);
    assert.deepEqual(closed.classes.map((row) => row.status), ["not_scheduled", "schedule_off", "not_scheduled", "not_scheduled", "not_scheduled"]);
    const inclusive = { ...fixed, scheduleRule: { ...fixed.scheduleRule, startsOn: "2026-09-02", endsOn: "2026-09-02" } };
    assert.equal(project({ classes: [inclusive] }).classes[0]?.status, "meets");
    assert.equal(project({ referenceDate: "2027-09-01", classes: [classes[4]!] }).classes[0]?.status, "not_scheduled");
  });

  it("preserves A/B closure reflow, explicit bells and a weekend's mapped weekday", () => {
    const calendar = { "2026-09": { nonInstructionalDates: ["2026-09-07"] } };
    assert.equal(project({ referenceDate: "2026-09-08", calendar }).day.cycleDay, "A");
    const dated: SchoolSchedulingConfig = { ...config, dateOverrides: {
      "2026-09-05": { instructional: true, meetingWeekday: 1, cycleDay: "B", profileId: "early" },
      "2026-09-07": { instructional: true },
    } };
    const monday = { ...period, scheduleRule: { ...period.scheduleRule, weekdays: [1] } };
    const result = project({ referenceDate: "2026-09-05", config: dated, calendar, classes: [monday] });
    assert.deepEqual(result.day, { instructional: true, meetingWeekday: 1, cycleDay: "B", bellProfile: { id: "early", name: "Early Release" }, overridden: true });
    assert.deepEqual(result.classes[0]?.window, { startTime: "08:00", endTime: "08:30" });
    assert.equal(project({ referenceDate: "2026-09-07", config: dated, calendar }).day.instructional, true);
    assert.equal(project({ referenceDate: "2026-09-06", config: dated }).day.instructional, false);
  });

  it("reports invalid/missing mappings without inventing fallback class times", () => {
    const unavailable = project({ config: { ...config, defaultProfileId: null, weekdayProfiles: {} }, classes: [period] }).classes[0];
    assert.equal(unavailable?.status, "unavailable");
    assert.equal(unavailable?.code, "SCHEDULE_PERIOD_UNAVAILABLE");
    assert.equal(unavailable?.window, null);
    assert.equal(project({ classes: [{ ...fixed, blockEndTime: "25:00" }] }).classes[0]?.code, "SCHEDULE_WINDOW_UNAVAILABLE");
    assert.equal(project({ classes: [{ ...fixed, scheduleRule: { ...fixed.scheduleRule, weekdays: [] } }] }).classes[0]?.code, "INVALID_SCHEDULING_CONFIG");
  });

  it("marks eligible incomplete fixed clocks unavailable while preserving no-meeting days", () => {
    for (const missing of [{ blockStartTime: null }, { blockEndTime: null }, { blockStartTime: "", blockEndTime: "" }]) {
      const classes = [{ ...fixed, ...missing }];
      assert.deepEqual(project({ classes }).classes[0], {
        classId: fixed.id, status: "unavailable", window: null, code: "SCHEDULE_WINDOW_UNAVAILABLE",
        message: "This class needs valid regular start and end times.",
      });
      assert.equal(project({ classes, referenceDate: "2026-09-06" }).classes[0]?.status, "not_scheduled");
      assert.equal(project({ classes, calendar: { "2026-09": { nonInstructionalDates: ["2026-09-02"] } } }).classes[0]?.status, "not_scheduled");
      const monday = { ...classes[0]!, scheduleRule: { ...fixed.scheduleRule, weekdays: [1] } };
      assert.equal(project({ classes: [monday] }).classes[0]?.status, "not_scheduled");
      const aDay = { ...classes[0]!, scheduleRule: { ...fixed.scheduleRule, cycleDay: "A" as const } };
      assert.equal(project({ classes: [aDay] }).classes[0]?.status, "not_scheduled");
      const laterTerm = { ...classes[0]!, scheduleRule: { ...fixed.scheduleRule, startsOn: "2026-09-03" } };
      assert.equal(project({ classes: [laterTerm] }).classes[0]?.status, "not_scheduled");
    }
  });

  it("returns more than 500 classes intact so copying limits cannot silently omit meetings", () => {
    const classes = Array.from({ length: 501 }, (_, i) => ({ ...fixed, id: `class-${i}` }));
    const result = project({ classes });
    assert.equal(result.classes.length, 501);
    assert.equal(result.classes[500]?.classId, "class-500");
  });
});
