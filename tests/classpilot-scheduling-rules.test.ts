import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultClassScheduleRule, emptySchoolSchedulingConfig, findScheduleOverlap,
  normalizeClassScheduleRule, normalizeSchoolSchedulingConfig,
  resolveClassBaseWindow, resolveSchoolScheduleDay,
} from "../src/services/classpilotSchedulingRules.js";

const config = normalizeSchoolSchedulingConfig({ ...emptySchoolSchedulingConfig(),
  yearStart: "2026-09-01", yearEnd: "2027-06-30", cycleAnchorDate: "2026-09-01", cycleAnchorDay: "A",
  periods: [{ id: "p1", name: "Period 1" }, { id: "p2", name: "Period 2" }],
  profiles: [
    { id: "regular", name: "Regular", periods: { p1: { startTime: "08:00", endTime: "08:50" }, p2: { startTime: "09:00", endTime: "09:50" } } },
    { id: "early", name: "Early Release", periods: { p1: { startTime: "08:00", endTime: "08:30" }, p2: { startTime: "08:35", endTime: "09:05" } } },
  ], defaultProfileId: "regular", weekdayProfiles: { "3": "early" }, dateOverrides: {},
});
const fixed = { scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50" };
const period = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), periodId: "p2" } };

describe("School scheduling rules", () => {
  it("preserves fixed schedules and treats class end dates as inclusive", () => {
    assert.deepEqual(resolveClassBaseWindow(fixed, "2026-09-02", config, {}), { startTime: "09:00", endTime: "09:50" });
    const group = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), startsOn: "2026-09-02", endsOn: "2026-09-03" } };
    assert.equal(resolveClassBaseWindow(group, "2026-09-01", config, {}), null);
    assert.ok(resolveClassBaseWindow(group, "2026-09-03", config, {}));
    assert.equal(resolveClassBaseWindow(group, "2026-09-04", config, {}), null);
  });
  it("advances A/B only on instructional days and shifts future days after a closure", () => {
    assert.equal(resolveSchoolScheduleDay("2026-09-07", config, {}).cycleDay, "A");
    const closures = { "2026-09": { nonInstructionalDates: ["2026-09-07"] } };
    assert.equal(resolveSchoolScheduleDay("2026-09-07", config, closures).cycleDay, null);
    assert.equal(resolveSchoolScheduleDay("2026-09-08", config, closures).cycleDay, "A");
    assert.equal(resolveSchoolScheduleDay("2026-09-08", config, {}).cycleDay, "B");
    assert.equal(resolveSchoolScheduleDay("2026-09-06", config, {}).cycleDay, null);
  });
  it("preserves explicit A/B overrides and independently applies an early-release profile", () => {
    const overrides = { ...config, dateOverrides: { "2026-09-08": { cycleDay: "B" as const, profileId: "early" } } };
    const closures = { "2026-09": { nonInstructionalDates: ["2026-09-07"] } };
    assert.equal(resolveSchoolScheduleDay("2026-09-08", overrides, closures).cycleDay, "B");
    assert.deepEqual(resolveClassBaseWindow(period, "2026-09-08", overrides, closures), { startTime: "08:35", endTime: "09:05" });
    assert.equal(resolveSchoolScheduleDay("2026-09-09", overrides, closures).cycleDay, "B");
  });
  it("opens an explicit weekend makeup date, follows its selected weekday and advances A/B", () => {
    const makeup = normalizeSchoolSchedulingConfig({ ...config,
      weekdayProfiles: { "1": "early" },
      dateOverrides: { "2026-09-05": { instructional: true, meetingWeekday: 1 } },
    });
    const monday = { ...period, scheduleRule: { ...period.scheduleRule, weekdays: [1] } };
    const saturday = resolveSchoolScheduleDay("2026-09-05", makeup, {});
    assert.equal(saturday.instructional, true);
    assert.equal(saturday.cycleDay, "A");
    assert.equal(saturday.meetingWeekday, 1);
    assert.deepEqual(resolveClassBaseWindow(monday, "2026-09-05", makeup, {}), { startTime: "08:35", endTime: "09:05" });
    assert.equal(resolveClassBaseWindow({ ...monday, scheduleRule: { ...monday.scheduleRule, weekdays: [2] } }, "2026-09-05", makeup, {}), null);
    assert.equal(resolveSchoolScheduleDay("2026-09-07", makeup, {}).cycleDay, "B");
    assert.equal(resolveSchoolScheduleDay("2026-09-07", config, {}).cycleDay, "A");
    assert.equal(resolveSchoolScheduleDay("2026-09-06", makeup, {}).instructional, false);
    const explicitSaturday = normalizeSchoolSchedulingConfig({ ...makeup, dateOverrides: { "2026-09-05": { instructional: true } } });
    assert.ok(resolveClassBaseWindow({ ...fixed, scheduleRule: { ...defaultClassScheduleRule(), weekdays: [6] } }, "2026-09-05", explicitSaturday, {}));
    assert.equal(resolveClassBaseWindow(monday, "2026-09-05", explicitSaturday, {}), null);
    assert.throws(() => normalizeSchoolSchedulingConfig({ ...config, dateOverrides: { "2026-09-05": { meetingWeekday: 1 } } }), /explicit instructional/);
  });
  it("lets explicit ClassPilot open and closed dates override shared weekday closures", () => {
    const calendar = { "2026-09": { nonInstructionalDates: ["2026-09-07"] } };
    const changed = normalizeSchoolSchedulingConfig({ ...config, dateOverrides: {
      "2026-09-07": { instructional: true }, "2026-09-08": { instructional: false },
    } });
    assert.equal(resolveSchoolScheduleDay("2026-09-07", changed, calendar).instructional, true);
    assert.equal(resolveSchoolScheduleDay("2026-09-08", changed, calendar).instructional, false);
    assert.equal(resolveSchoolScheduleDay("2026-09-09", changed, calendar).cycleDay, "B");
  });
  it("uses Wednesday profiles for every period while fixed-time classes retain their explicit times", () => {
    assert.deepEqual(resolveClassBaseWindow(period, "2026-09-02", config, {}), { startTime: "08:35", endTime: "09:05" });
    assert.deepEqual(resolveClassBaseWindow(period, "2026-09-03", config, {}), { startTime: "09:00", endTime: "09:50" });
    assert.equal(resolveClassBaseWindow(period, "2026-09-05", config, {}), null);
  });
  it("accepts disjoint weekdays, date ranges, and A/B days but detects actual overlap", () => {
    const mwf = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), weekdays: [1, 3, 5] } };
    const tth = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), weekdays: [2, 4] } };
    assert.equal(findScheduleOverlap(mwf, tth, config, {}, "2026-09-01"), null);
    assert.equal(findScheduleOverlap(mwf, fixed, config, {}, "2026-09-01"), "2026-09-02");
    const a = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), cycleDay: "A" as const } };
    const b = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), cycleDay: "B" as const } };
    assert.equal(findScheduleOverlap(a, b, config, {}, "2026-09-01"), null);
    assert.equal(findScheduleOverlap({ ...fixed, scheduleRule: { ...defaultClassScheduleRule(), endsOn: "2026-09-02" } }, { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), startsOn: "2026-09-03" } }, config, {}, "2026-09-01"), null);
  });
  it("detects a collision introduced by early-release period times and allows touching endpoints", () => {
    const custom = { ...fixed, blockStartTime: "08:40", blockEndTime: "08:50" };
    assert.equal(findScheduleOverlap(period, custom, config, {}, "2026-09-01"), "2026-09-02");
    assert.equal(findScheduleOverlap(fixed, { ...fixed, blockStartTime: "09:50", blockEndTime: "10:00" }, config, {}, "2026-09-01"), null);
  });
  it("checks explicit bell exceptions beyond the repeating weekday preview horizon", () => {
    const future = { ...config, weekdayProfiles: {}, dateOverrides: { "2030-09-03": { profileId: "early" } } };
    const custom = { ...fixed, blockStartTime: "08:40", blockEndTime: "08:50" };
    assert.equal(findScheduleOverlap(period, custom, future, {}, "2026-09-01"), "2030-09-03");
  });
  it("fails closed on missing period mapping and invalid references without falling back to fixed times", () => {
    assert.throws(() => resolveClassBaseWindow(period, "2026-09-01", { ...config, defaultProfileId: null }, {}), /period is missing/);
    assert.throws(() => normalizeSchoolSchedulingConfig({ ...config, defaultProfileId: "another-school-profile" }), /belonging to this school/);
    assert.throws(() => normalizeClassScheduleRule({ ...defaultClassScheduleRule(), weekdays: [] }), /weekdays/);
    assert.throws(() => normalizeClassScheduleRule({ ...defaultClassScheduleRule(), endsOn: "2026-02-30" }), /real date/);
    assert.throws(() => normalizeClassScheduleRule({ ...defaultClassScheduleRule(), deviceId: "forbidden" }), /unsupported field/);
    assert.throws(() => normalizeSchoolSchedulingConfig({ ...config, periods: [{ id: "__proto__", name: "Bad" }] }), /reserved/);
  });
  it("does not start A/B classes outside the configured school year", () => {
    const a = { ...period, scheduleRule: { ...period.scheduleRule, cycleDay: "A" as const } };
    assert.equal(resolveClassBaseWindow(a, "2027-09-01", config, {}), null);
  });
});
