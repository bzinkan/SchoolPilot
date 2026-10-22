import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectAvailableTestingGroups, type AvailableTestingContext } from "../src/services/classpilotAvailableTestingGroups.js";
import type { ScheduleProfileApplication, ScheduleProfileTestingWindow } from "../src/services/classpilotScheduleProfileModel.js";

const now = new Date("2026-10-22T14:30:00.000Z");
const timeZone = "America/New_York";
const visibleStudentGroups = new Map([
  ["student-1", new Set(["test-a", "test-b"])],
  ["student-2", new Set(["test-a"])],
  ["student-3", new Set(["test-b"])],
]);
function application(overrides: Partial<ScheduleProfileApplication> = {}, windowOverrides: Partial<ScheduleProfileTestingWindow> = {}): ScheduleProfileApplication {
  const window = { date: "2026-10-22", blockId: "reading-a", name: "Applied Test A", coverageGroupId: "test-a",
    assignedStaffId: "teacher-a", startTime: "10:00", endTime: "11:00", studentIds: ["student-1", "student-2"], ...windowOverrides };
  return { id: "application-a", profileId: "profile-a", profileName: "MAP", profileRevision: 1,
    dates: [window.date], definition: { name: "MAP", grades: [], classIds: [], classRules: [], testingBlocks: [] },
    testingWindows: [window], classWindows: {}, status: "scheduled", createdBy: "admin", createdAt: "2026-10-01T12:00:00.000Z", ...overrides };
}
function project(overrides: Partial<Parameters<typeof projectAvailableTestingGroups>[0]> = {}) {
  return projectAvailableTestingGroups({ applications: [application()], outcomes: {}, contexts: [], visibleStudentGroups, timeZone, now, ...overrides });
}
function context(overrides: Partial<AvailableTestingContext> = {}): AvailableTestingContext {
  return { applicationId: "application-a", date: "2026-10-22", blockId: "reading-a", status: "active", inWindow: true,
    studentIds: ["student-1", "student-2"], ...overrides };
}
const receiptKey = "application-a:2026-10-22:reading-a";

describe("Available student testing labels", () => {
  it("shows only the exact applied test despite multiple saved group memberships", () => {
    const result = project();
    assert.deepEqual(result.activeTestingGroups.get("student-1"), { groupId: "test-a", name: "Applied Test A",
      applicationId: "application-a", blockId: "reading-a", date: "2026-10-22",
      startsAt: "2026-10-22T14:00:00.000Z", endsAt: "2026-10-22T15:00:00.000Z" });
    assert.equal(result.activeTestingGroups.size, 2);
    assert.equal(result.testingNextBoundaryAt, "2026-10-22T15:00:00.000Z");
    assert.equal(result.serverTime, now.toISOString());
    assert.deepEqual([...visibleStudentGroups.get("student-1")!], ["test-a", "test-b"]);
  });

  it("does not infer testing from saved memberships without an applied schedule", () => {
    const result = project({ applications: [] });
    assert.equal(result.activeTestingGroups.size, 0);
    assert.equal(result.testingNextBoundaryAt, null);
  });

  it("requires both the frozen applied roster and a visible saved-group membership", () => {
    const result = project({ applications: [application({}, { studentIds: ["student-1", "student-3", "hidden-student"] })] });
    assert.deepEqual([...result.activeTestingGroups.keys()], ["student-1"]);
    assert.equal(project({ visibleStudentGroups: new Map() }).testingNextBoundaryAt, null);
  });

  it("uses school-local dates and half-open testing windows", () => {
    assert.equal(project({ now: new Date("2026-10-22T13:59:59.999Z") }).activeTestingGroups.size, 0);
    assert.equal(project({ now: new Date("2026-10-22T14:00:00.000Z") }).activeTestingGroups.size, 2);
    assert.equal(project({ now: new Date("2026-10-22T15:00:00.000Z") }).activeTestingGroups.size, 0);
    assert.equal(project({ now: new Date("2026-10-23T02:30:00.000Z"),
      applications: [application({}, { startTime: "22:00", endTime: "23:00" })] }).activeTestingGroups.size, 2);
  });

  it("hides past/future tests but returns the next relevant future boundary", () => {
    assert.equal(project({ applications: [application({}, { date: "2026-10-21" })] }).testingNextBoundaryAt, null);
    const future = project({ applications: [application({}, { date: "2026-10-23" })] });
    assert.equal(future.activeTestingGroups.size, 0);
    assert.equal(future.testingNextBoundaryAt, "2026-10-23T14:00:00.000Z");
    assert.equal(project({ now: new Date("2026-10-22T13:00:00.000Z") }).testingNextBoundaryAt, "2026-10-22T14:00:00.000Z");
  });

  it("excludes cancelled applications and individually cancelled blocks", () => {
    for (const cancelled of [application({ status: "cancelled" }), application({ cancelledBlocks: [
      { date: "2026-10-22", blockId: "reading-a", cancelledAt: now.toISOString(), cancelledBy: "admin" },
    ] })]) {
      const result = project({ applications: [cancelled], contexts: [context()] });
      assert.equal(result.activeTestingGroups.size, 0);
      assert.equal(result.testingNextBoundaryAt, null);
    }
  });

  it("excludes failed, missed and cancelled activation outcomes", () => {
    for (const status of ["failed", "missed", "cancelled"] as const) {
      const result = project({ outcomes: { [receiptKey]: { status } } });
      assert.equal(result.activeTestingGroups.size, 0);
      assert.equal(result.testingNextBoundaryAt, null);
    }
  });

  it("does not revive finished or early-released testing before its original end", () => {
    const outcomes = { [receiptKey]: { status: "started" as const } };
    assert.equal(project({ outcomes }).activeTestingGroups.size, 0);
    assert.equal(project({ outcomes, contexts: [context({ status: "ended" })] }).activeTestingGroups.size, 0);
    assert.equal(project({ outcomes, contexts: [context({ inWindow: false })] }).activeTestingGroups.size, 0);
    const active = project({ outcomes, contexts: [context({ studentIds: ["student-2"] })] });
    assert.deepEqual([...active.activeTestingGroups.keys()], ["student-2"]);
  });

  it("does not guess a test when concurrent applied snapshots conflict", () => {
    const result = project({ applications: [application(), application({ id: "application-b" },
      { blockId: "reading-b", coverageGroupId: "test-b", name: "Applied Test B" })] });
    assert.equal(result.activeTestingGroups.has("student-1"), false);
    assert.equal(result.activeTestingGroups.get("student-2")?.groupId, "test-a");
    assert.equal(result.testingNextBoundaryAt, "2026-10-22T15:00:00.000Z");
  });
});
