import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeScheduleDraftReviewDefinition, projectScheduleDraftReview, type DraftReviewFacts } from "../src/services/classpilotScheduleDraftReview.js";
import { normalizeScheduleProfileDefinition, type ScheduleProfileDefinition } from "../src/services/classpilotScheduleProfileModel.js";
import { defaultClassScheduleRule, emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";

const proctor = { id: "zinkan", name: "Mr. Zinkan" }, teacher = { id: "burba", name: "Mr. Burba" };
const homeroom = { id: "homeroom", name: "Grade 5 Homeroom", gradeLevel: "5", staff: [proctor], studentIds: ["pupil-a", "pupil-b"],
  scheduleEnabled: true, blockStartTime: "08:30", blockEndTime: "09:10", scheduleRule: defaultClassScheduleRule() };
const first = { ...homeroom, id: "first", name: "First period", blockStartTime: "09:15", blockEndTime: "09:55", staff: [teacher] };
const group = { id: "map", name: "MAP group", studentIds: ["pupil-a"], inactiveStudents: 0, staffIds: [proctor.id, teacher.id] };
const block = { id: "testing", name: "MAP", coverageGroupId: "map", assignedStaffId: proctor.id, startTime: "09:00", endTime: "10:45" };
const draft = (): ScheduleProfileDefinition => ({ name: "Testing day", grades: ["5"], classIds: [], classRules: [], testingBlocks: [block] });
const facts = (): DraftReviewFacts => ({ referenceDate: "2026-09-01", revision: 9, schoolTimezone: "America/New_York", config: emptySchoolSchedulingConfig(), calendar: {},
  tracking: { enableTrackingHours: false, afterHoursMode: "off", schoolTimezone: "America/New_York", trackingStartTime: null, trackingEndTime: null, trackingDays: null }, classes: [homeroom, first], supervisionGroups: [group], staff: [proctor, teacher] });

describe("Reference-day draft review", () => {
  it("shows unchanged regular meetings and differentiates a proctor conflict from student supervision", () => {
    const result = projectScheduleDraftReview(draft(), facts());
    assert.equal(result.complete, true);
    assert.deepEqual(result.counts, { conflicts: 1, overlaps: 1, incomplete: 0 });
    assert.deepEqual(result.classes[0]?.regularWindow, { startTime: "08:30", endTime: "09:10" });
    assert.deepEqual(result.classes[0]?.proposedWindow, result.classes[0]?.regularWindow);
    assert.equal(result.classes[0]?.action, "keep");
    assert.deepEqual(result.testingBlocks[0]?.classParticipation, [{ classId: "homeroom", count: 1, total: 2 }, { classId: "first", count: 1, total: 2 }]);
    const conflict = result.issues.find((issue) => issue.kind === "conflict")!;
    assert.deepEqual(conflict.classIds, ["homeroom"]);
    assert.deepEqual(conflict.staffIds, [proctor.id]);
    assert.equal(conflict.code, "SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT");
    assert.doesNotMatch(JSON.stringify(result), /pupil-a|pupil-b|studentIds|deviceId/);
  });
  it("evaluates all proposed edits together without shifting other periods or changing the input", () => {
    const data = facts(), definition = { ...draft(), classRules: [{ classId: "homeroom", action: "time" as const, startTime: "08:30", endTime: "09:00" }, { classId: "first", action: "skip" as const }] };
    const before = structuredClone(data), original = structuredClone(definition);
    const result = projectScheduleDraftReview(definition, data);
    assert.deepEqual(result.counts, { conflicts: 0, overlaps: 0, incomplete: 0 });
    assert.deepEqual(result.classes[0]?.proposedWindow, { startTime: "08:30", endTime: "09:00" });
    assert.equal(result.classes[1]?.proposedWindow, null);
    assert.deepEqual(result.classes[1]?.regularWindow, { startTime: "09:15", endTime: "09:55" });
    assert.equal(result.classes[1]?.action, "skip");
    assert.deepEqual(data, before); assert.deepEqual(definition, original);
  });
  it("allows whole-class testing, preserves unrelated proctor obligations and catches co-teachers", () => {
    const data = facts(); data.supervisionGroups = [{ ...group, studentIds: ["pupil-a", "pupil-b"] }];
    assert.deepEqual(projectScheduleDraftReview(draft(), data).counts, { conflicts: 0, overlaps: 2, incomplete: 0 });
    data.classes.push({ ...homeroom, id: "outside", gradeLevel: "6", staff: [teacher, proctor], studentIds: ["other-pupil"] });
    const result = projectScheduleDraftReview(draft(), data);
    assert.equal(result.counts.conflicts, 2); // regular class/class and proctor/testing
    assert.equal(result.classes.find((row) => row.classId === "outside")?.selected, false);
    assert.ok(result.issues.some((issue) => issue.code === "SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT" && issue.classIds.includes("outside")));
  });
  it("checks student and staff testing collisions while permitting touching endpoints", () => {
    const data = facts(); data.classes = [];
    const definition = draft(); definition.testingBlocks.push({ ...block, id: "second", assignedStaffId: teacher.id });
    assert.equal(projectScheduleDraftReview(definition, data).counts.conflicts, 1);
    definition.testingBlocks[1] = { ...definition.testingBlocks[1]!, startTime: "10:45", endTime: "11:30" };
    assert.equal(projectScheduleDraftReview(definition, data).counts.conflicts, 0);
    data.supervisionGroups.push({ ...group, id: "other", studentIds: ["other-pupil"] });
    definition.testingBlocks[1] = { ...block, id: "second", coverageGroupId: "other" };
    assert.equal(projectScheduleDraftReview(definition, data).counts.conflicts, 1);
  });
  it("retains valid feedback while incomplete blocks and class times remain unchecked", () => {
    const definition = normalizeScheduleDraftReviewDefinition({ ...draft(), name: "", testingBlocks: [block, { id: "unfinished", name: "", coverageGroupId: "", assignedStaffId: "", startTime: "09:", endTime: "" }],
      classRules: [{ classId: "first", action: "time", startTime: "", endTime: "" }] });
    const result = projectScheduleDraftReview(definition, facts());
    assert.equal(result.complete, false);
    assert.equal(result.counts.conflicts, 1);
    assert.equal(result.counts.incomplete, 3);
    assert.equal(result.testingBlocks.find((row) => row.blockId === "unfinished")?.status, "incomplete");
    assert.equal(result.classes.find((row) => row.classId === "first")?.proposedWindow, null);
    assert.equal(result.classes.find((row) => row.classId === "first")?.proposedStatus, "incomplete");
    assert.throws(() => normalizeScheduleProfileDefinition(definition));
  });
  it("respects reference eligibility and never invents period clocks, even for custom rules", () => {
    const data = facts(); data.classes = [{ ...homeroom, scheduleRule: { ...defaultClassScheduleRule(), periodId: "missing" } }];
    const definition = { ...draft(), classRules: [{ classId: "homeroom", action: "time" as const, startTime: "08:30", endTime: "09:00" }] };
    const unavailable = projectScheduleDraftReview(definition, data);
    assert.equal(unavailable.complete, false); assert.equal(unavailable.classes[0]?.status, "unavailable"); assert.equal(unavailable.classes[0]?.proposedWindow, null);
    data.classes = [homeroom]; data.calendar = { "2026-09": { nonInstructionalDates: [data.referenceDate] } };
    const closed = projectScheduleDraftReview(definition, data);
    assert.equal(closed.complete, false); assert.equal(closed.counts.conflicts, 0); assert.equal(closed.classes[0]?.proposedWindow, null);
    assert.ok(closed.issues.some((issue) => issue.code === "SCHEDULE_DRAFT_REFERENCE_CLOSED"));
    data.calendar = {}; data.referenceDate = "2026-09-05";
    data.config.dateOverrides[data.referenceDate] = { instructional: true, meetingWeekday: 1 };
    assert.equal(projectScheduleDraftReview(definition, data).classes[0]?.proposedWindow?.endTime, "09:00");
  });
  it("marks unavailable groups and incomplete reference facts without an apparently clean review", () => {
    for (const changedGroup of [{ ...group, studentIds: [] }, { ...group, inactiveStudents: 1 }, { ...group, staffIds: [] }, { ...group, studentIds: Array.from({ length: 501 }, (_, i) => `pupil-${i}`) }]) {
      const result = projectScheduleDraftReview(draft(), { ...facts(), supervisionGroups: [changedGroup] });
      assert.equal(result.complete, false); assert.equal(result.testingBlocks[0]?.status, "unavailable");
    }
    const data = facts(); data.tracking = undefined;
    assert.ok(projectScheduleDraftReview(draft(), data).issues.some((issue) => issue.code === "SCHEDULE_PROFILE_MONITORING_NOT_FULL"));
  });
  it("rejects malformed shapes and bounded references while allowing empty in-progress fields", () => {
    for (const bad of [{ ...draft(), extra: true }, { ...draft(), grades: {} }, { ...draft(), classIds: ["constructor"] }, { ...draft(), classIds: Array.from({ length: 501 }, (_, i) => `class-${i}`) },
      { ...draft(), testingBlocks: Array(31).fill(block) }, { ...draft(), testingBlocks: [block, block] }, { ...draft(), testingBlocks: [{ ...block, studentIds: ["pupil"] }] }, { ...draft(), name: "a\nsecret" }]) assert.throws(() => normalizeScheduleDraftReviewDefinition(bad));
    assert.throws(() => projectScheduleDraftReview(draft(), { ...facts(), referenceDate: "2026-02-30" }), { code: "INVALID_REFERENCE_DATE" });
  });
  it("never presents empty selections, unknown staff or a truncated conflict list as fully checked", () => {
    const definition = { ...draft(), grades: [], testingBlocks: [] };
    assert.equal(projectScheduleDraftReview(definition, facts()).complete, false);
    const missingStaff = projectScheduleDraftReview(draft(), { ...facts(), classes: [{ ...homeroom, staff: [], unavailableStaff: true }] });
    assert.ok(missingStaff.issues.some((issue) => issue.code === "SCHEDULE_DRAFT_STAFF_UNAVAILABLE"));
    const crowded = { ...facts(), classes: Array.from({ length: 48 }, (_, i) => ({ ...homeroom, id: `class-${i}` })) };
    const truncated = projectScheduleDraftReview({ ...draft(), testingBlocks: [] }, crowded);
    assert.equal(truncated.complete, false);
    assert.ok(truncated.issues.some((issue) => issue.code === "SCHEDULE_DRAFT_REVIEW_LIMIT"));
  });
  it("retains grade selections above 500 when only a few classes have explicit rules", () => {
    const data = { ...facts(), classes: Array.from({ length: 501 }, (_, i) => ({ ...homeroom, id: `class-${i}`, staff: [{ id: `teacher-${i}`, name: "Teacher" }] })) };
    const result = projectScheduleDraftReview({ ...draft(), testingBlocks: [] }, data);
    assert.equal(result.complete, true); assert.equal(result.classes.filter((row) => row.selected).length, 501);
  });
});
