import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeScheduleStudents, type StudentAnalysisClass, type StudentAnalysisTesting } from "../src/services/classpilotScheduleStudentAnalysis.js";

const staff = (id: string) => [{ id, name: `Teacher ${id}` }];
const meeting = (classId: string, start: number, end: number, studentIds: string[] | null = ["pupil"]): StudentAnalysisClass =>
  ({ classId, name: classId, window: { start, end }, studentIds, staff: staff(classId) });
const testing = (blockId: string, start: number, end: number, studentIds: string[] | null = ["pupil"]): StudentAnalysisTesting =>
  ({ blockId, name: blockId, window: { start, end }, studentIds, staff: staff(blockId), validForPrecedence: true });
const analyze = (baselineClasses: StudentAnalysisClass[], classes = baselineClasses, blocks: StudentAnalysisTesting[] = []) =>
  analyzeScheduleStudents({ baselineClasses, classes, testing: blocks });

describe("Shared-student schedule analysis", () => {
  it("compares student/class pairs against exact baseline spans with half-open boundaries", () => {
    const baseline = [meeting("A", 10, 20), meeting("B", 20, 30)];
    assert.deepEqual(analyze(baseline).overlaps, []);
    const moved = analyze(baseline, [baseline[0]!, meeting("B", 15, 25)]);
    assert.deepEqual(moved.overlaps, [{ classIds: ["A", "B"], staffIds: ["A", "B"], window: { start: 15, end: 20 }, studentCount: 1, newStudentCount: 1, change: "new" }]);
    assert.doesNotMatch(JSON.stringify(moved), /pupil|studentIds/);
  });
  it("keeps existing and reduced overlaps visible and catches moved or expanded legacy overlap", () => {
    const baseline = [meeting("A", 10, 30), meeting("B", 20, 40)];
    assert.equal(analyze(baseline).overlaps[0]?.change, "existing");
    assert.equal(analyze(baseline, [baseline[0]!, meeting("B", 25, 40)]).overlaps[0]?.change, "reduced");
    const moved = analyze(baseline, [meeting("A", 0, 20), meeting("B", 10, 30)]);
    assert.equal(moved.overlaps[0]?.change, "worsened");
    assert.equal(moved.overlaps[0]?.newStudentCount, 1); // same duration, different span
    const expanded = analyze(baseline, [baseline[0]!, meeting("B", 15, 40)]);
    assert.deepEqual(expanded.overlaps.map((row) => [row.window, row.newStudentCount]), [[{ start: 15, end: 20 }, 1], [{ start: 20, end: 30 }, 0]]);
  });
  it("compares each student independently and deduplicates roster and occurrence copies", () => {
    const baseline = [meeting("A", 10, 30, ["one"]), meeting("B", 20, 40, ["one", "two"])];
    const result = analyze(baseline, [meeting("A", 10, 30, ["one", "one", "two"]), meeting("A", 15, 25, ["one", "two"]), baseline[1]!]);
    assert.equal(result.overlaps.length, 1);
    assert.equal(result.overlaps[0]?.studentCount, 2); assert.equal(result.overlaps[0]?.newStudentCount, 1);
    assert.equal(analyze([meeting("A", 0, 10), meeting("A", 0, 10)]).overlaps.length, 0);
  });
  it("subtracts only exact valid testing spans for participating students", () => {
    const classes = [meeting("A", 10, 30, ["one", "two"]), meeting("B", 10, 30, ["one", "two"])];
    const block = testing("test", 15, 25, ["one"]);
    const result = analyze([], classes, [block]);
    assert.deepEqual(result.overlaps.map((row) => [row.window, row.studentCount]), [[{ start: 10, end: 15 }, 2], [{ start: 15, end: 25 }, 1], [{ start: 25, end: 30 }, 2]]);
    for (const invalid of [{ ...block, validForPrecedence: false }, { ...block, studentIds: null }, { ...block, studentIds: [] }, { ...block, window: { start: 25, end: 15 } }]) {
      assert.equal(analyze([], classes, [invalid]).overlaps[0]?.studentCount, 2);
    }
  });
  it("retains membership transition boundaries even when adjacent student counts match", () => {
    const result = analyze([], [meeting("A", 0, 10, ["one"]), meeting("A", 10, 20, ["two"]), meeting("B", 0, 20, ["one", "two"])]);
    assert.deepEqual(result.overlaps.map((row) => [row.window, row.studentCount]), [[{ start: 0, end: 10 }, 1], [{ start: 10, end: 20 }, 1]]);
  });
  it("never lets overlapping testing assignments establish precedence", () => {
    const classes = [meeting("A", 0, 30), meeting("B", 0, 30)];
    for (const other of [testing("second", 5, 15), { ...testing("second", 5, 15, ["other"]), staff: staff("first") }]) {
      const result = analyze([], classes, [testing("first", 0, 20), other]);
      assert.deepEqual(result.overlaps[0]?.window, { start: 0, end: 30 });
      assert.ok(result.afterTesting.every((row) => row.status === "unavailable"));
    }
  });
  it("compares against baseline testing too, so removing protection can add conflicts", () => {
    const classes = [meeting("A", 10, 30), meeting("B", 10, 30)];
    const result = analyzeScheduleStudents({ baselineClasses: classes, classes, baselineTesting: [testing("old", 10, 30)], testing: [] });
    assert.equal(result.overlaps[0]?.change, "new"); assert.equal(result.overlaps[0]?.newStudentCount, 1);
  });
  it("partitions mixed testing rosters exclusively at the exact end", () => {
    const block = testing("test", 0, 10, ["class", "multiple", "gap", "none", "continuing"]);
    const classes = [meeting("A", 10, 20, ["class", "multiple"]), meeting("B", 10, 30, ["multiple"]), meeting("C", 15, 20, ["gap"])];
    const result = analyze(classes, classes, [block, testing("next", 10, 20, ["continuing"])]);
    const returned = result.afterTesting[0]!;
    assert.equal(returned.status, "ready"); assert.equal(returned.studentCount, 5);
    assert.equal(returned.allocations.reduce((count, row) => count + row.studentCount, 0), 5);
    assert.deepEqual(new Set(returned.allocations.map((row) => row.kind)), new Set(["class", "multiple", "gap", "none", "continuing_testing"]));
    assert.equal(returned.allocations.find((row) => row.kind === "gap")?.at, 15);
    assert.deepEqual(returned.allocations.find((row) => row.kind === "multiple")?.classIds, ["A", "B"]);
    assert.deepEqual(returned.allocations.find((row) => row.kind === "continuing_testing")?.blockIds, ["next"]);
  });
  it("does not treat ended classes or same-class copies as ambiguous destinations", () => {
    const classes = [meeting("old", 0, 10), meeting("A", 10, 20), meeting("A", 10, 20)];
    const result = analyze(classes, classes, [testing("test", 0, 10)]);
    assert.deepEqual(result.afterTesting[0]?.allocations[0]?.classIds, ["A"]);
    assert.equal(result.afterTesting[0]?.allocations[0]?.kind, "class");
    assert.equal(result.afterTesting[0]?.allocations[0]?.studentCount, 1);
  });
  it("marks all occurrences of an unavailable class uncertain despite different manual and current rosters", () => {
    const manual = { ...meeting("A", 0, 30, ["captured"]), unavailable: true };
    const regular = meeting("A", 10, 20, ["captured", "added-later"]);
    const result = analyze([manual, regular], undefined, [testing("test", 0, 10, ["added-later"])]);
    assert.equal(result.complete, false);
    assert.deepEqual(result.unavailableClassIds, ["A"]);
    assert.equal(result.afterTesting[0]?.status, "unavailable");
    assert.deepEqual(result.afterTesting[0]?.allocations, [
      { kind: "unavailable", studentCount: 1, classIds: [], blockIds: [], staff: [], at: null },
    ]);
  });
  it("distinguishes competing future destinations from a gap before one next class", () => {
    const classes = [meeting("A", 15, 25), meeting("B", 15, 30), meeting("later", 20, 35)];
    const result = analyze(classes, classes, [testing("test", 0, 10)]);
    assert.deepEqual(result.afterTesting[0]?.allocations, [
      { kind: "multiple", studentCount: 1, classIds: ["A", "B"], blockIds: [], staff: [...staff("A"), ...staff("B")], at: 15 },
    ]);
    const oneClass = [meeting("A", 15, 25), meeting("A", 15, 30)];
    assert.equal(analyze(oneClass, oneClass, [testing("test", 0, 10)]).afterTesting[0]?.allocations[0]?.kind, "gap");
  });
  it("distinguishes known empty from unavailable rosters and fails uncertain facts closed", () => {
    const block = testing("test", 0, 10);
    assert.equal(analyze([meeting("empty", 10, 20, [])], undefined, [block]).afterTesting[0]?.allocations[0]?.kind, "none");
    const unknown = analyze([meeting("unknown", 10, 20, null)], undefined, [block]);
    assert.equal(unknown.complete, false); assert.deepEqual(unknown.unavailableClassIds, ["unknown"]);
    assert.equal(unknown.afterTesting[0]?.allocations[0]?.kind, "unavailable");
    const unfinished = { ...meeting("unfinished", 0, 20), window: null, unavailable: true };
    assert.equal(analyze([unfinished], undefined, [block]).afterTesting[0]?.status, "unavailable");
    const missingTesting = analyze([], [], [testing("missing", 0, 10, null)]).afterTesting[0]!;
    assert.equal(missingTesting.studentCount, null); assert.deepEqual(missingTesting.allocations, []);
    assert.equal(analyze([], [], [testing("empty", 0, 10, [])]).afterTesting[0]?.studentCount, 0);
  });
  it("supports epoch intervals without changing their precision or timezone", () => {
    const instant = Date.parse("2026-11-02T15:00:00Z"), classes = [meeting("A", instant, instant + 60000)];
    const result = analyze(classes, classes, [testing("test", instant - 60000, instant)]);
    assert.equal(result.afterTesting[0]?.allocations[0]?.at, instant);
  });
  it("reports bounded analysis failure without partial clean results and leaves inputs unchanged", () => {
    const classes = [meeting("A", 0, 30), meeting("B", 0, 30)], blocks = [testing("test", 0, 10)];
    const before = structuredClone({ classes, blocks });
    for (const limits of [{ operations: 0 }, { relationships: 1 }, { classes: 1 }, { testing: 0 }, { overlaps: 0 }]) {
      const result = analyzeScheduleStudents({ baselineClasses: [], classes, testing: blocks, limits });
      assert.equal(result.complete, false); assert.equal(result.limitReached, true); assert.deepEqual(result.overlaps, []);
      assert.equal(result.afterTesting[0]?.status, "unavailable");
    }
    assert.deepEqual({ classes, blocks }, before);
  });
});
