import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeScheduleProfileApplication, normalizeScheduleProfileCollections,
  normalizeScheduleProfileDefinition, normalizeSavedScheduleProfile,
  type ScheduleProfileApplication, type ScheduleProfileDefinition,
} from "../src/services/classpilotScheduleProfileModel.js";
import {
  defaultClassScheduleRule, emptySchoolSchedulingConfig, findScheduleOverlap,
  normalizeSchoolSchedulingConfig, resolveClassBaseWindow,
} from "../src/services/classpilotSchedulingRules.js";

const time = { startTime: "10:00", endTime: "10:50" };
const fixed = { id: "math-1", scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50" };
const definition = (): ScheduleProfileDefinition => ({
  name: "NWEA • Fall", grades: ["1", "2"], classIds: ["math-1"],
  classRules: [{ classId: "math-1", action: "time", ...time }], testingBlocks: [],
});
function application(overrides: Partial<ScheduleProfileApplication> = {}): ScheduleProfileApplication {
  return { id: "application-1", profileId: "profile-1", profileName: "NWEA • Fall", profileRevision: 1,
    dates: ["2026-09-01"], definition: definition(), classWindows: { "2026-09-01": { "math-1": { ...time } } },
    testingWindows: [], status: "scheduled", createdBy: "admin-1", createdAt: "2026-08-01T12:00:00.000Z", ...overrides };
}
function config(applications: ScheduleProfileApplication[] = [application()]) {
  return normalizeSchoolSchedulingConfig({ ...emptySchoolSchedulingConfig(), profileApplications: applications });
}
function testingApplication(overrides: Partial<ScheduleProfileApplication> = {}) {
  const block = { id: "reading", name: "Grade 1 reading", coverageGroupId: "readers", assignedStaffId: "specialist", startTime: "08:00", endTime: "10:00" };
  return application({ definition: { ...definition(), testingBlocks: [block] },
    testingWindows: [{ date: "2026-09-01", blockId: block.id, name: block.name,
      coverageGroupId: block.coverageGroupId, assignedStaffId: block.assignedStaffId,
      startTime: block.startTime, endTime: block.endTime, studentIds: ["student-1", "student-2"] }], ...overrides });
}

describe("Reusable schedule profile contracts", () => {
  it("normalizes legacy version-one config with empty optional collections", () => {
    const { scheduleProfiles: _profiles, profileApplications: _applications, ...legacy } = emptySchoolSchedulingConfig();
    const result = normalizeSchoolSchedulingConfig(legacy);
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.scheduleProfiles, []);
    assert.deepEqual(result.profileApplications, []);
    assert.deepEqual(resolveClassBaseWindow(fixed, "2026-09-01", result, {}), { startTime: "09:00", endTime: "09:50" });
  });

  it("supports custom names and school grade labels while rejecting unsupported authority fields", () => {
    const result = normalizeScheduleProfileDefinition({ ...definition(), name: "  NWEA / Reading  ", grades: ["8", "K", "Pre-K"] });
    assert.equal(result.name, "NWEA / Reading");
    assert.deepEqual(result.grades, ["8", "K", "Pre-K"]);
    assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), schoolId: "other-school" }), /unsupported field/);
    assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), name: "\u0000Bad" }), /control characters/);
    assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), grades: ["1", " 1 "] }), /unique/);
    assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), classRules: [definition().classRules[0], definition().classRules[0]] }), /unique/);
  });

  it("rejects unsafe dictionary IDs and malformed class actions or clocks", () => {
    for (const id of ["__proto__", "prototype", "constructor", "bad/id", "a:b", "", "a".repeat(129)]) {
      assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), classIds: [id] }), /references need/);
    }
    const polluted = JSON.parse('{"2026-09-01":{"__proto__":null}}');
    assert.throws(() => normalizeScheduleProfileApplication(application({ classWindows: polluted })), /reserved object keys/);
    for (const rule of [
      { classId: "math-1", action: "broadcast" },
      { classId: "math-1", action: "skip", startTime: "10:00" },
      { classId: "math-1", action: "time", startTime: "10:00", endTime: "10:00" },
      { classId: "math-1", action: "time", startTime: "23:00", endTime: "01:00" },
      { classId: "math-1", action: "time", startTime: "25:00", endTime: "26:00" },
    ]) assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), classRules: [rule] }));
  });

  it("copies snapshot arrays and windows independently of a later catalog revision", () => {
    const input = testingApplication();
    const snapshot = normalizeScheduleProfileApplication(input);
    input.definition.classRules[0]!.startTime = "11:00";
    input.classWindows["2026-09-01"]!["math-1"]!.startTime = "11:00";
    input.testingWindows[0]!.studentIds.push("student-3");
    assert.equal(snapshot.definition.classRules[0]!.startTime, "10:00");
    assert.equal(snapshot.classWindows["2026-09-01"]!["math-1"]!.startTime, "10:00");
    assert.deepEqual(snapshot.testingWindows[0]!.studentIds, ["student-1", "student-2"]);
    const edited = normalizeSavedScheduleProfile({ id: "profile-1", revision: 2,
      definition: { ...definition(), name: "Spring MAP" }, updatedAt: "2026-09-01T12:00:00Z" });
    const result = normalizeScheduleProfileCollections([edited], [snapshot]);
    assert.equal(result.profileApplications[0]!.profileName, "NWEA • Fall");
    assert.equal(result.profileApplications[0]!.profileRevision, 1);
    assert.doesNotThrow(() => normalizeScheduleProfileCollections([], [snapshot]));
  });

  it("validates class-window dates, references and values against the applied definition", () => {
    assert.throws(() => normalizeScheduleProfileApplication(application({ dates: ["2026-02-30"] })), /real dates/);
    assert.throws(() => normalizeScheduleProfileApplication(application({ dates: ["2026-09-01", "2026-09-01"] })), /unique/);
    assert.throws(() => normalizeScheduleProfileApplication(application({ classWindows: { "2026-09-02": { "math-1": time } } })), /application date/);
    assert.throws(() => normalizeScheduleProfileApplication(application({ classWindows: { "2026-09-01": { "other-class": time } } })), /class rule/);
    assert.throws(() => normalizeScheduleProfileApplication(application({ classWindows: { "2026-09-01": { "math-1": null } } })), /match their definition/);
    assert.throws(() => normalizeScheduleProfileApplication(application({ classWindows: { "2026-09-01": { "math-1": { startTime: "10:10", endTime: "10:50" } } } })), /match their definition/);
    assert.throws(() => normalizeScheduleProfileApplication(application({ profileName: "Another profile" })), /name must match/);
    assert.throws(() => normalizeScheduleProfileApplication(application({ createdAt: "2026-09-01T24:00:00Z" })), /UTC ISO/);
    assert.throws(() => normalizeSavedScheduleProfile({ id: "profile-1", revision: 0, definition: definition(), updatedAt: "2026-09-01T00:00:00Z" }), /positive safe integers/);
  });

  it("retains exact testing students and rejects expanded or mismatched testing authority", () => {
    const input = testingApplication();
    const first = input.testingWindows[0]!;
    assert.deepEqual(normalizeScheduleProfileApplication(input).testingWindows[0]!.studentIds, first.studentIds);
    for (const patch of [
      { assignedStaffId: "other-teacher" }, { coverageGroupId: "other-group" },
      { date: "2026-09-02" }, { blockId: "other-block" }, { startTime: "07:00" },
      { studentIds: [] }, { studentIds: ["student-1", "student-1"] },
      { studentIds: Array.from({ length: 501 }, (_, i) => `student-${i}`) },
    ]) assert.throws(() => normalizeScheduleProfileApplication({ ...input, testingWindows: [{ ...first, ...patch }] }));
    assert.throws(() => normalizeScheduleProfileApplication({ ...input, testingWindows: [first, first] }), /unique/);
    assert.throws(() => normalizeScheduleProfileApplication({ ...input, testingWindows: [{ ...first, deviceId: "device-1" }] }), /unsupported field/);
  });

  it("reserves an active class/date even for a skip and frees it after cancellation", () => {
    const skip = application({ id: "skip-1", definition: { ...definition(), classRules: [{ classId: "math-1", action: "skip" }] }, classWindows: { "2026-09-01": { "math-1": null } } });
    assert.throws(() => config([application(), skip]), (error: any) => error.code === "SCHEDULE_PROFILE_APPLICATION_CONFLICT" && error.status === 409);
    assert.doesNotThrow(() => config([application(), { ...skip, status: "cancelled" }]));
    assert.throws(() => config([application(), application()]), /Application IDs must be unique/);
    assert.equal(resolveClassBaseWindow(fixed, "2026-09-01", config([skip]), {}), null);
  });

  it("bounds collections, dates, rules and blocks before accepting school config", () => {
    const saved = { id: "p", revision: 1, definition: definition(), updatedAt: "2026-09-01T00:00:00Z" };
    assert.throws(() => normalizeScheduleProfileCollections(Array.from({ length: 31 }, (_, i) => ({ ...saved, id: `p-${i}` }))), /at most 30/);
    assert.throws(() => config(Array.from({ length: 101 }, (_, i) => application({ id: `a-${i}`, status: "cancelled" }))), /at most 100/);
    assert.throws(() => normalizeScheduleProfileApplication({ ...application(), dates: Array(32).fill("2026-09-01") }), /at most 31/);
    assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), classRules: Array(501).fill(definition().classRules[0]) }), /at most 500/);
    assert.throws(() => normalizeScheduleProfileDefinition({ ...definition(), testingBlocks: Array(31).fill(testingApplication().definition.testingBlocks[0]) }), /at most 30/);
  });

  it("enforces the total school testing-window cap including retained cancelled applications", () => {
    const dates = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
    const blocks = Array.from({ length: 30 }, (_, i) => ({ id: `block-${i}`, name: `Testing ${i}`, coverageGroupId: "readers", assignedStaffId: "specialist", startTime: "08:00", endTime: "09:00" }));
    const testingWindows = dates.flatMap((date) => blocks.map(({ id, ...block }) => ({ ...block, blockId: id, date, studentIds: ["student-1"] })));
    const many = application({ dates, classWindows: {}, definition: { ...definition(), testingBlocks: blocks }, testingWindows, status: "cancelled" });
    assert.doesNotThrow(() => normalizeScheduleProfileCollections([], [{ ...many, id: "one" }, { ...many, id: "two" }]));
    assert.throws(() => normalizeScheduleProfileCollections([], [{ ...many, id: "one" }, { ...many, id: "two" }, { ...many, id: "three" }]), /2,000 testing windows/);
  });
});

describe("Dated profile schedule resolution", () => {
  it("overrides only the exact class/date and restores ordinary scheduling outside that application", () => {
    const schedule = config();
    assert.deepEqual(resolveClassBaseWindow(fixed, "2026-09-01", schedule, {}), time);
    assert.deepEqual(resolveClassBaseWindow(fixed, "2026-09-02", schedule, {}), { startTime: "09:00", endTime: "09:50" });
    assert.deepEqual(resolveClassBaseWindow({ ...fixed, id: "math-2" }, "2026-09-01", schedule, {}), { startTime: "09:00", endTime: "09:50" });
    assert.deepEqual(resolveClassBaseWindow({ ...fixed, id: undefined }, "2026-09-01", schedule, {}), { startTime: "09:00", endTime: "09:50" });
    assert.deepEqual(resolveClassBaseWindow(fixed, "2026-09-01", config([application({ status: "cancelled" })]), {}), { startTime: "09:00", endTime: "09:50" });
  });

  it("cannot create occurrences outside instructional, class-date, weekday, A/B or enabled boundaries", () => {
    const schedule = normalizeSchoolSchedulingConfig({ ...config(), yearStart: "2026-09-01", yearEnd: "2027-06-30", cycleAnchorDate: "2026-09-01" });
    assert.equal(resolveClassBaseWindow(fixed, "2026-09-01", schedule, { "2026-09": { nonInstructionalDates: ["2026-09-01"] } }), null);
    assert.equal(resolveClassBaseWindow({ ...fixed, scheduleEnabled: false }, "2026-09-01", schedule, {}), null);
    assert.equal(resolveClassBaseWindow({ ...fixed, blockStartTime: null }, "2026-09-01", schedule, {}), null);
    for (const rule of [{ weekdays: [1] }, { startsOn: "2026-09-02" }, { endsOn: "2026-08-31" }, { cycleDay: "B" as const }]) {
      assert.equal(resolveClassBaseWindow({ ...fixed, scheduleRule: { ...defaultClassScheduleRule(), ...rule } }, "2026-09-01", schedule, {}), null);
    }
    assert.deepEqual(resolveClassBaseWindow({ ...fixed, scheduleRule: { ...defaultClassScheduleRule(), cycleDay: "A" } }, "2026-09-01", schedule, {}), time);
  });

  it("uses the chosen weekday for a weekend makeup date before applying exact class times", () => {
    const weekend = application({ dates: ["2026-09-05"], classWindows: { "2026-09-05": { "math-1": time } } });
    const monday = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), weekdays: [1] } };
    assert.equal(resolveClassBaseWindow(monday, "2026-09-05", config([weekend]), {}), null);
    const makeup = normalizeSchoolSchedulingConfig({ ...config([weekend]), dateOverrides: { "2026-09-05": { instructional: true, meetingWeekday: 1 } } });
    assert.deepEqual(resolveClassBaseWindow(monday, "2026-09-05", makeup, {}), time);
  });

  it("changes a valid period occurrence without concealing a missing bell mapping", () => {
    const group = { ...fixed, scheduleRule: { ...defaultClassScheduleRule(), periodId: "p1" } };
    assert.throws(() => resolveClassBaseWindow(group, "2026-09-01", config(), {}), /period is missing/);
    const schedule = normalizeSchoolSchedulingConfig({ ...config(), periods: [{ id: "p1", name: "Period 1" }],
      profiles: [{ id: "regular", name: "Regular", periods: { p1: { startTime: "08:00", endTime: "08:50" } } }], defaultProfileId: "regular" });
    assert.deepEqual(resolveClassBaseWindow(group, "2026-09-01", schedule, {}), time);
  });

  it("checks profile-induced teacher collisions even beyond the recurring schedule horizon", () => {
    const future = application({ dates: ["2030-09-03"], classWindows: { "2030-09-03": { "math-1": time } } });
    const other = { ...fixed, id: "math-2", blockStartTime: "10:10", blockEndTime: "11:00" };
    assert.equal(findScheduleOverlap(fixed, other, config([]), {}, "2026-09-01"), null);
    assert.equal(findScheduleOverlap(fixed, other, config([future]), {}, "2026-09-01"), "2030-09-03");
    assert.equal(findScheduleOverlap(fixed, { ...other, blockStartTime: "10:50" }, config([future]), {}, "2026-09-01"), null);
  });

  it("fails closed if a caller passes conflicting unnormalized applications", () => {
    assert.throws(() => resolveClassBaseWindow(fixed, "2026-09-01", { ...emptySchoolSchedulingConfig(), profileApplications: [application(), application({ id: "second" })] }, {}), /same class on the same date/);
  });
});
