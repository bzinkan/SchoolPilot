import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearAutomaticClassroomFlightPathPolicy,
  clearAutomaticClassroomFlightPathState,
  preciseRestrictionClearProof,
  PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL,
} from "../src/services/classpilotPreciseRestrictionRollback.js";
import { automaticFlightPathDesiredState, emptyAutomaticFlightPathState } from "../src/services/classpilotAutomaticFlightPath.js";

test("rollback removes frozen student scopes and disables only Classroom automatic policies", () => {
  const state = { ...emptyAutomaticFlightPathState(), schemaVersion: 2, status: "active", revision: 4,
    assignmentId: "assignment-a", flightPathId: "path-a", payload: { allowedDomains: ["classroom.google.com"] },
    perStudentPayloads: { "student-a": { allowedDomains: ["classroom.google.com", "assigned.example"] } }, eligibleStudentIds: ["student-a"] };
  const policy = { schemaVersion: 2, revision: 8, enabled: true, flightPathId: "path-a", updatedBy: "teacher-a", classroomAccess: { approvalKey: "private" } };
  const clearedState = clearAutomaticClassroomFlightPathState(state);
  const clearedPolicy = clearAutomaticClassroomFlightPathPolicy(policy);
  assert.ok(clearedState.changed, "schema-2 frozen snapshots must be removed");
  assert.ok(clearedPolicy.changed, "schema-2 approvals must be removed");
  assert.equal(clearedState.state.status, "off");
  assert.equal(clearedState.state.revision, 5);
  assert.equal(clearedPolicy.policy.enabled, false);
  assert.equal(clearedPolicy.policy.revision, 9);
  assert.doesNotMatch(JSON.stringify(clearedState.state), /perStudentPayloads|assigned.example|classroomMaterials/);
  assert.doesNotMatch(JSON.stringify(clearedPolicy.policy), /classroomAccess|approvalKey|private/);
  const desired = { restrictions: { tabLimit: 3 } };
  assert.deepEqual(automaticFlightPathDesiredState({ desiredState: desired, state: clearedState.state,
    studentId: "student-a", teachingSessionId: "session-a" }), desired, "reconciliation cannot resurrect a compiled path");
  assert.equal(state.schemaVersion, 2, "the frozen input is not mutated");
  for (const ordinary of [null, {}, { schemaVersion: 1, revision: 3, enabled: true, flightPathId: "ordinary", updatedBy: null }]) {
    assert.equal(clearAutomaticClassroomFlightPathPolicy(ordinary).changed, false);
    assert.equal(clearAutomaticClassroomFlightPathState(ordinary).changed, false);
  }
  assert.equal(clearAutomaticClassroomFlightPathState(clearedState.state).changed, false);
  assert.equal(clearAutomaticClassroomFlightPathPolicy(clearedPolicy.policy).changed, false);
});

test("automatic rollback dry-run proofs bind complete policy and frozen scope JSON", () => {
  const base = { schoolId: "school-a", controlStates: [], classroomStateIds: [],
    automaticSessionStates: [{ id: "session-a", state: { schemaVersion: 2, revision: 1, perStudentPayloads: { a: { allowedDomains: ["a.example"] } } } }],
    automaticGroupPolicies: [{ id: "group-a", policy: { schemaVersion: 2, revision: 2, classroomAccess: { approvalKey: "a" } } }] };
  const proof = preciseRestrictionClearProof(base);
  assert.equal(preciseRestrictionClearProof({ ...base, automaticSessionStates: [{ id: "session-a", state: {
    perStudentPayloads: { a: { allowedDomains: ["a.example"] } }, revision: 1, schemaVersion: 2 } }] }), proof,
  "JSONB object key order does not affect the proof");
  assert.notEqual(preciseRestrictionClearProof({ ...base, automaticSessionStates: [{ id: "session-a", state: {
    ...base.automaticSessionStates[0]!.state, perStudentPayloads: { a: { allowedDomains: ["b.example"] } } } }] }), proof);
  assert.notEqual(preciseRestrictionClearProof({ ...base, automaticGroupPolicies: [{ id: "group-a", policy: {
    ...base.automaticGroupPolicies[0]!.policy, classroomAccess: { approvalKey: "b" } } }] }), proof);
  assert.match(PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL, /FROM teaching_sessions/);
  assert.match(PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL, /FROM groups/);
});
