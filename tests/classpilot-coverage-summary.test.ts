import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classpilotCoverageSummaryRevision, ownActiveSupervisionContexts, ownScheduledTestingContexts } from "../src/services/classpilotCoverageSummary.js";

describe("ClassPilot coverage summary", () => {
  it("includes every personally owned supervision type and removes released, expired and transferred ownership", () => {
    const now = new Date("2026-09-14T15:30:00Z");
    const base = {
      schoolId: "school-a", name: "Other", assignedStaffId: "viewer", status: "active" as const,
      startsAt: new Date("2026-09-14T15:00:00Z"), endsAt: new Date("2026-09-14T16:00:00Z"),
    };
    const contexts = [
      { ...base, id: "manual", contextType: "other" },
      { ...base, id: "group", contextType: "intervention" },
      { ...base, id: "scheduled", contextType: "state_testing" },
      { ...base, id: "class-coverage", contextType: "other" },
      { ...base, id: "other-teacher", contextType: "other", assignedStaffId: "someone-else" },
      { ...base, id: "foreign", contextType: "other", schoolId: "school-b" },
      { ...base, id: "expired", contextType: "other", endsAt: now },
      { ...base, id: "future", contextType: "other", startsAt: new Date("2026-09-14T15:31:00Z") },
      { ...base, id: "ended", contextType: "other", status: "ended" as const },
      { ...base, id: "empty", contextType: "other" },
    ];
    const activeStudents = contexts.filter((context) => context.id !== "empty").map((context) => ({
      schoolId: context.schoolId, contextId: context.id, studentId: `${context.id}-student`,
    }));
    activeStudents.push(activeStudents[0]!, { schoolId: "school-b", contextId: "manual", studentId: "foreign-student" });
    const options = { schoolId: "school-a", viewerId: "viewer", contexts, activeStudents, now };
    const result = ownActiveSupervisionContexts(options);
    assert.deepEqual(result.map((context) => context.id), ["class-coverage", "group", "manual", "scheduled"]);
    assert.equal(result.find((context) => context.id === "manual")?.activeStudentCount, 1);
    assert.deepEqual(Object.keys(result[0]!).sort(), ["activeStudentCount", "contextType", "endsAt", "id", "name", "startsAt"]);
    assert.doesNotMatch(JSON.stringify(result), /student|viewer/);
    assert.deepEqual(ownActiveSupervisionContexts({ ...options, activeStudents: [] }), []);
    assert.deepEqual(ownActiveSupervisionContexts({ ...options, viewerId: "new-teacher" }), []);
    const handoff = contexts.map((context) => context.id === "manual" ? { ...context, assignedStaffId: "new-teacher" } : context);
    assert.deepEqual(ownActiveSupervisionContexts({ ...options, contexts: handoff, viewerId: "new-teacher" }).map((context) => context.id), ["manual"]);
  });
  it("is deterministic across query insertion order", () => {
    const first = classpilotCoverageSummaryRevision({
      availableStudentIds: ["student-b", "student-a"],
      claimedStudentIds: ["student-c", "student-c"],
      contexts: [
        { id: "context-b", updatedAt: "2026-08-22T12:00:00.000Z" },
        { id: "context-a", updatedAt: "2026-08-22T11:00:00.000Z" },
      ],
    });
    const reversed = classpilotCoverageSummaryRevision({
      availableStudentIds: ["student-a", "student-b"],
      claimedStudentIds: ["student-c"],
      contexts: [
        { id: "context-a", updatedAt: "2026-08-22T11:00:00.000Z" },
        { id: "context-b", updatedAt: "2026-08-22T12:00:00.000Z" },
      ],
    });
    assert.equal(first, reversed);
    assert.match(first, /^coverage-v1:[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(first, /student|context/);
  });

  it("lists only the viewer's own scheduled testing, even from an administrator's school-wide contexts", () => {
    const now = new Date("2026-09-14T14:00:00.000Z");
    const base = {
      schoolId: "school-a", name: "MAP testing", assignedStaffId: "admin-a", status: "active" as const,
      startsAt: new Date("2026-09-14T13:00:00.000Z"), endsAt: new Date("2026-09-14T15:00:00.000Z"),
      scheduleProfileApplicationId: "application-a", scheduleProfileDate: "2026-09-14", scheduleProfileBlockId: "block-a",
    };
    const contexts = [
      { ...base, id: "own-testing" },
      { ...base, id: "other-staff", assignedStaffId: "teacher-b" },
      { ...base, id: "other-school", schoolId: "school-b" },
      { ...base, id: "manual", scheduleProfileApplicationId: null, scheduleProfileDate: null, scheduleProfileBlockId: null },
      { ...base, id: "incomplete-origin", scheduleProfileBlockId: null },
      { ...base, id: "ended", status: "ended" as const },
      { ...base, id: "expired", endsAt: now },
      { ...base, id: "future", startsAt: new Date("2026-09-14T14:01:00.000Z") },
      { ...base, id: "empty" },
    ];
    const activeStudents = contexts.filter(({ id }) => id !== "empty").map((context) => ({
      schoolId: context.schoolId, contextId: context.id, studentId: `${context.id}-student`,
    }));
    activeStudents.push(activeStudents[0]!, { schoolId: "school-a", contextId: "own-testing", studentId: "second-student" },
      { schoolId: "school-b", contextId: "own-testing", studentId: "foreign-student" });
    assert.deepEqual(ownScheduledTestingContexts({ schoolId: "school-a", viewerId: "admin-a", contexts, activeStudents, now }), [
      { id: "own-testing", name: "MAP testing", endsAt: "2026-09-14T15:00:00.000Z", activeStudentCount: 2 },
    ]);
    assert.deepEqual(ownScheduledTestingContexts({ schoolId: "school-a", viewerId: "teacher-b", contexts, activeStudents, now }), [
      { id: "other-staff", name: "MAP testing", endsAt: "2026-09-14T15:00:00.000Z", activeStudentCount: 1 },
    ]);
    assert.deepEqual(ownScheduledTestingContexts({ schoolId: "school-a", viewerId: "unassigned-admin", contexts, activeStudents, now }), []);
  });

  it("removes released testing membership without exposing student or staff identities", () => {
    const context = {
      id: "testing", schoolId: "school", name: "Testing", assignedStaffId: "viewer", status: "active" as const,
      startsAt: new Date("2026-09-14T13:00:00.000Z"), endsAt: new Date("2026-09-14T15:00:00.000Z"),
      scheduleProfileApplicationId: "profile", scheduleProfileDate: "2026-09-14", scheduleProfileBlockId: "block",
    };
    const options = { schoolId: "school", viewerId: "viewer", contexts: [context], now: new Date("2026-09-14T14:00:00.000Z") };
    const result = ownScheduledTestingContexts({ ...options, activeStudents: [{ schoolId: "school", contextId: "testing", studentId: "private-student" }] });
    assert.deepEqual(Object.keys(result[0]!).sort(), ["activeStudentCount", "endsAt", "id", "name"]);
    assert.doesNotMatch(JSON.stringify(result), /private-student|viewer|profile|block/);
    assert.deepEqual(ownScheduledTestingContexts({ ...options, activeStudents: [] }), []);
  });
});
