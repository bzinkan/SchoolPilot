import assert from "node:assert/strict";
import { test } from "node:test";
import { flightPathReviewedInstantMatches, restrictionPrerequisiteMatches, reviewedClassroomSourceKey } from "../src/services/classpilotLessonPrerequisites.js";
import { validateClasspilotCommandPayload } from "../src/services/classpilotCommandValidation.js";

const now = new Date("2026-09-30T10:00:00.123Z");
const request = { schoolId: "school", teacherId: "actor", teachingSessionId: null, supervisionContextId: "context" };
const target = { studentId: "student", studentSessionId: "login", deviceId: "device", status: "requested" as const };
const source = { ...request, id: "source", commandType: "apply-flight-path" };
const sourceTarget = { ...target, schoolId: "school", commandId: "source", status: "completed" as const,
  result: { outcome: "applied", appliedRevision: 7, scheduledContextAuthorityRevision: "3" } };
const current = { schoolId: "school", studentId: "student", teachingSessionId: null, supervisionContextId: "context",
  revision: 7, sourceCommandId: "source", appliedRevision: 7, lastOutcome: "applied", enforcementHealth: "synced",
  hardExpiresAt: new Date(now.getTime() + 60_000), scheduledEndAt: null };
const fixture = { request, target, source, sourceTarget, current, contextAuthorityRevision: "3", now };
test("lesson prerequisite requires the actual completed application for this exact recipient and desired revision", () => {
  assert.equal(restrictionPrerequisiteMatches(fixture), true);
  assert.equal(restrictionPrerequisiteMatches({ ...fixture, sourceTarget: { ...sourceTarget,
    result: { outcome: "applied", classroomStateRevision: 7, reconciliation: true, scheduledContextAuthorityRevision: "3" } } }), true);
  assert.equal(restrictionPrerequisiteMatches({ ...fixture, sourceTarget: { ...sourceTarget,
    result: { outcome: "applied", classroomStateRevision: 7, appliedRevision: 8, scheduledContextAuthorityRevision: "3" } } }), false);
  for (const status of ["requested", "sent", "received", "failed", "expired", "unavailable"] as const)
    assert.equal(restrictionPrerequisiteMatches({ ...fixture, sourceTarget: { ...sourceTarget, status } }), false, status);
  for (const result of [{}, { outcome: "pending", appliedRevision: 7 }, { outcome: "unsupported", appliedRevision: 7 },
    { outcome: "applied", appliedRevision: 6 }, { outcome: "applied", appliedRevision: 7, scheduledContextAuthorityRevision: "2" }])
    assert.equal(restrictionPrerequisiteMatches({ ...fixture, sourceTarget: { ...sourceTarget, result } }), false);
  for (const changed of [{ revision: 8 }, { sourceCommandId: "replacement" }, { lastOutcome: "failed" }, { enforcementHealth: "unsupported" },
    { appliedRevision: 6 }, { hardExpiresAt: now }, { scheduledEndAt: now }, { supervisionContextId: "replacement" }])
    assert.equal(restrictionPrerequisiteMatches({ ...fixture, current: { ...current, ...changed } }), false);
});

test("lesson proof cannot cross actor, tenant, class, student, login or device boundaries", () => {
  for (const changed of [{ schoolId: "other" }, { teacherId: "other" }, { supervisionContextId: "other" }, { commandType: "remove-flight-path" }])
    assert.equal(restrictionPrerequisiteMatches({ ...fixture, source: { ...source, ...changed } }), false);
  for (const changed of [{ schoolId: "other" }, { studentId: "other" }, { studentSessionId: "other" }, { deviceId: "other" }, { commandId: "other" }])
    assert.equal(restrictionPrerequisiteMatches({ ...fixture, sourceTarget: { ...sourceTarget, ...changed } }), false);
  assert.equal(restrictionPrerequisiteMatches({ ...fixture, target: { ...target, status: "unavailable" } }), false);
});

test("review pins are strict instants compared at public Date millisecond precision", () => {
  assert.equal(flightPathReviewedInstantMatches(now, "2026-09-30T10:00:00.123000Z"), true);
  assert.equal(flightPathReviewedInstantMatches(now, "2026-09-30T06:00:00.123-04:00"), true);
  assert.equal(flightPathReviewedInstantMatches(new Date(now.getTime() + 1), now.toISOString()), false);
  assert.deepEqual(validateClasspilotCommandPayload("apply-flight-path", { flightPathId: "path", expectedFlightPathUpdatedAt: now.toISOString() }),
    { flightPathId: "path", expectedFlightPathUpdatedAt: now.toISOString() });
  for (const expectedFlightPathUpdatedAt of [null, "2026-09-30", "invalid", 1])
    assert.throws(() => validateClasspilotCommandPayload("apply-flight-path", { flightPathId: "path", expectedFlightPathUpdatedAt }));
});

test("reviewed Classroom reuse compares canonical source and exact policy independent of ordering", () => {
  const path = { sourceCourseId: "course", sourceResourceIds: ["b", "a"], allowedDomains: ["b.test", "a.test"], resources: [], blockedDomains: [] };
  assert.equal(reviewedClassroomSourceKey(path), reviewedClassroomSourceKey({ ...path, sourceResourceIds: ["a", "b"], allowedDomains: ["a.test", "b.test"] }));
  for (const changed of [{ sourceCourseId: "other" }, { sourceResourceIds: ["a"] }, { allowedDomains: ["a.test"] }, { blockedDomains: ["b.test"] }])
    assert.notEqual(reviewedClassroomSourceKey(path), reviewedClassroomSourceKey({ ...path, ...changed }));
});
