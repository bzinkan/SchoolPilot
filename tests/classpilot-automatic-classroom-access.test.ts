import assert from "node:assert/strict";
import { test } from "node:test";
import {
  automaticFlightPathDesiredState, automaticFlightPathPolicyDto,
  emptyAutomaticFlightPathState, normalizeAutomaticFlightPathPolicy,
  normalizeAutomaticFlightPathState,
  publicGroupAutomaticFlightPath,
} from "../src/services/classpilotAutomaticFlightPath.js";

const approval = {
  schemaVersion: 1, mode: "student-courses", groupId: "class-a", flightPathId: "path-a",
  primaryTeacherId: "teacher-a", approvedBy: "teacher-a", approvedAt: "2026-11-16T21:00:00.000Z", approvalKey: "a".repeat(64),
};

test("a saved all-course automatic approval survives normalization without exposing its private author", () => {
  const policy = normalizeAutomaticFlightPathPolicy({ schemaVersion: 2, revision: 3, enabled: true,
    flightPathId: "path-a", updatedBy: "teacher-a", classroomAccess: approval });
  assert.equal(policy.enabled, true);
  assert.equal(policy.schemaVersion, 2);
  assert.deepEqual(policy.classroomAccess, approval);
  const dto = automaticFlightPathPolicyDto(policy, approval.approvalKey);
  assert.deepEqual(dto.classroomAccess, { mode: "student-courses", approved: true });
  assert.doesNotMatch(JSON.stringify(dto), /teacher-a|approvedBy|primaryTeacherId|approvedAt/);
});

test("a class preset reports that review is needed after connector permission changes", () => {
  const policy = { schemaVersion: 2, revision: 3, enabled: true, flightPathId: "path-a", updatedBy: "teacher-a", classroomAccess: approval };
  assert.equal(automaticFlightPathPolicyDto(policy, "b".repeat(64)).classroomAccess?.approved, false);
  assert.equal(automaticFlightPathPolicyDto(policy, null).classroomAccess?.approved, false);
  assert.equal(automaticFlightPathPolicyDto(policy).classroomAccess?.approved, false);
});

test("automatic approval cannot move to another saved path or survive malformed authority", () => {
  for (const override of [
    { flightPathId: "different-path" }, { classroomAccess: { ...approval, primaryTeacherId: "" } },
    { classroomAccess: { ...approval, mode: "whole-internet" } }, { classroomAccess: { ...approval, unknown: true } },
  ]) {
    assert.equal(normalizeAutomaticFlightPathPolicy({ schemaVersion: 2, revision: 3, enabled: true,
      flightPathId: "path-a", updatedBy: "teacher-a", classroomAccess: approval, ...override }).enabled, false);
  }
});

test("ordinary group responses cannot expose the private automatic approval", () => {
  const group = { id: "class-a", name: "Class A", studentCount: 2,
    automaticFlightPathPolicy: { schemaVersion: 2, revision: 3, enabled: true,
      flightPathId: "path-a", updatedBy: "teacher-a", classroomAccess: approval } };
  const dto = publicGroupAutomaticFlightPath(group);
  assert.equal(dto.id, "class-a");
  assert.equal(dto.studentCount, 2);
  assert.doesNotMatch(JSON.stringify(dto), /approvedBy|approvedAt|approvalKey|primaryTeacherId|updatedBy/);
  assert.equal(group.automaticFlightPathPolicy.classroomAccess.approvalKey, approval.approvalKey);
  assert.deepEqual(publicGroupAutomaticFlightPath({ id: "class-b", automaticFlightPathPolicy: null }),
    { id: "class-b", automaticFlightPathPolicy: null });
});

test("a per-student automatic state never falls back to the shared base path", () => {
  const state = { ...emptyAutomaticFlightPathState(), schemaVersion: 2, revision: 1, status: "active",
    assignmentId: "automatic-a", flightPathId: "path-a", name: "Classroom", sourcePolicyRevision: 3,
    flightPathUpdatedAt: "2026-11-16T21:00:00.000Z",
    payload: { flightPathId: "path-a", flightPathName: "Classroom", allowedDomains: ["classroom.google.com"] },
    perStudentPayloads: {}, eligibleStudentIds: [], unavailableStudentIds: ["student-a"],
    unavailableReasons: { "student-a": "STUDENT_CLASSROOM_ACCESS_UNAVAILABLE" },
  };
  const normalized = normalizeAutomaticFlightPathState(state);
  assert.equal(normalized.status, "active");
  const desired = { restrictions: { tabLimit: 4 } };
  assert.deepEqual(automaticFlightPathDesiredState({ desiredState: desired, state,
    studentId: "student-a", teachingSessionId: "session-a" }), desired);
});

test("a malformed per-student snapshot cannot shed its private Classroom provenance", () => {
  const payload = { flightPathId: "path-a", flightPathName: "Classroom", allowedDomains: ["google.com"] };
  const state = { ...emptyAutomaticFlightPathState(), schemaVersion: 2, revision: 1, status: "active",
    assignmentId: "automatic-a", flightPathId: "path-a", name: "Classroom", sourcePolicyRevision: 3,
    payload, perStudentPayloads: { "student-a": payload }, eligibleStudentIds: ["student-a"] };
  assert.equal(normalizeAutomaticFlightPathState(state).status, "inactive");
  assert.equal(normalizeAutomaticFlightPathState({ ...state, perStudentPayloads: {}, eligibleStudentIds: ["toString"] }).status, "inactive");
});
