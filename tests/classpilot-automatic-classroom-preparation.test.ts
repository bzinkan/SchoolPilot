import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmAutomaticClassroomAccessReview, prepareAutomaticClassroomAccess,
  previewAutomaticClassroomAccessReview, validateAutomaticClassroomPreparation,
} from "../src/services/classpilotAutomaticClassroomAccess.js";
import { CLASSROOM_FOCUS_BASE_DOMAINS } from "../src/services/classroomFocusScope.js";
import { automaticFlightPathDesiredState, emptyAutomaticFlightPathState, removeAutomaticFlightPathFromDesiredState } from "../src/services/classpilotAutomaticFlightPath.js";
import { applyClasspilotControlCommand, normalizeClasspilotRestrictions } from "../src/services/classpilotClassroomState.js";

const now = Date.parse("2026-11-16T21:00:00.000Z");
const context = () => ({ schoolId: "school-a", actorId: "teacher-a", groupId: "class-a", primaryTeacherId: "teacher-a",
  policyRevision: 4, flightPath: { id: "path-a", schoolId: "school-a", flightPathName: "Classroom",
    allowedDomains: ["classroom.google.com"], resources: [], updatedAt: new Date(now - 1_000) },
  studentIds: ["student-a", "student-b"] });
const policy = () => ({ schemaVersion: 2 as const, revision: 4, enabled: true, flightPathId: "path-a", updatedBy: "teacher-a",
  classroomAccess: { schemaVersion: 1 as const, mode: "student-courses" as const, groupId: "class-a", flightPathId: "path-a",
    primaryTeacherId: "teacher-a", approvedBy: "teacher-a", approvedAt: new Date(now - 60_000).toISOString(), approvalKey: "a".repeat(64) } });
const sources = () => ["student-a", "student-b"].map((studentId, index) => ({ studentId, approvalKey: "a".repeat(64), courseCount: 2, itemCount: 3, linkCount: 1,
  scope: { schemaVersion: 1 as const, sourceRevision: String(index + 1).repeat(64),
    allowedDomains: [...CLASSROOM_FOCUS_BASE_DOMAINS, index ? "beta.example.org" : "alpha.example.org"], resources: [] } }));
const dependencies = { now: () => now, signingSecret: "automatic-classroom-unit-only", enabled: true,
  resolveSources: async () => sources() };

test("automatic review binds class, teacher, policy, roster and exact saved path", async () => {
  const review = await previewAutomaticClassroomAccessReview(context(), dependencies);
  assert.equal(review.mode, "automatic-flight-path");
  assert.equal(review.studentCount, 2);
  const confirmed = await confirmAutomaticClassroomAccessReview(context(), review.reviewToken, dependencies);
  assert.equal(confirmed.approval.mode, "student-courses");
  assert.equal(confirmed.approval.groupId, "class-a");
  for (const changed of [
    { groupId: "other-class" }, { actorId: "other-teacher" }, { primaryTeacherId: "other-teacher" },
    { policyRevision: 5 }, { studentIds: ["student-a"] },
    { flightPath: { ...context().flightPath, allowedDomains: ["classroom.google.com", "different.example.org"] } },
    { flightPath: { ...context().flightPath, updatedAt: new Date(now) } },
  ]) await assert.rejects(confirmAutomaticClassroomAccessReview({ ...context(), ...changed }, review.reviewToken, dependencies));
  await assert.rejects(confirmAutomaticClassroomAccessReview(context(), review.reviewToken,
    { ...dependencies, resolveSources: async () => sources().map(source => ({ ...source,
      scope: { ...source.scope, sourceRevision: "a".repeat(64) } })) }));
});

test("automatic preparation freezes separate student permissions and local validation performs no provider calls", async () => {
  let providerCalls = 0;
  const prepared = await prepareAutomaticClassroomAccess({ ...context(), policy: policy() }, {
    ...dependencies, resolveSources: async () => { providerCalls++; return sources(); },
  });
  assert.equal(prepared?.status, "ready");
  assert.ok(prepared?.perStudentPayloads?.["student-a"]?.allowedDomains.includes("alpha.example.org"));
  assert.equal(prepared?.perStudentPayloads?.["student-a"]?.allowedDomains.includes("beta.example.org"), false);
  assert.ok(prepared?.perStudentPayloads?.["student-b"]?.allowedDomains.includes("beta.example.org"));
  assert.equal(prepared?.perStudentPayloads?.["student-b"]?.allowedDomains.includes("alpha.example.org"), false);
  assert.equal(validateAutomaticClassroomPreparation({ ...context(), policy: policy() }, prepared, now).status, "ready");
  for (const changed of [{ policy: { ...policy(), revision: 5 } }, { primaryTeacherId: "other-teacher" },
    { policy: { ...policy(), classroomAccess: { ...policy().classroomAccess, groupId: "other-class" } } },
    { studentIds: ["student-a"] }, { flightPath: { ...context().flightPath, updatedAt: new Date(now) } }]) {
    assert.equal(validateAutomaticClassroomPreparation({ ...context(), policy: policy(), ...changed }, prepared, now).status, "unavailable");
  }
  assert.equal(validateAutomaticClassroomPreparation({ ...context(), policy: policy() }, prepared, now + 60_001).status, "unavailable");
  assert.equal(providerCalls, 1);
});

test("source outages and invalid durable authority are visible rather than a broader path fallback", async () => {
  const prepared = await prepareAutomaticClassroomAccess({ ...context(), policy: policy() }, {
    ...dependencies, resolveSources: async () => { throw Object.assign(new Error("provider unavailable"), { code: "STUDENT_CLASSROOM_SOURCE_UNAVAILABLE" }); },
  });
  assert.equal(prepared?.status, "unavailable");
  assert.equal(prepared?.reasonCode, "STUDENT_CLASSROOM_SOURCE_UNAVAILABLE");
  let providerCalls = 0;
  const invalid = await prepareAutomaticClassroomAccess({ ...context(), primaryTeacherId: "replacement", policy: policy() }, {
    ...dependencies, resolveSources: async () => { providerCalls++; return sources(); },
  });
  assert.equal(invalid?.status, "unavailable");
  assert.equal(providerCalls, 0);
  assert.equal(await prepareAutomaticClassroomAccess({ ...context(), policy: policy(),
    flightPath: { ...context().flightPath, allowedDomains: ["lesson.example.org"] } }, dependencies), null);
});

test("a reapproved Google connection requires a new class approval before the next automatic start", async () => {
  const prepared = await prepareAutomaticClassroomAccess({ ...context(), policy: policy() }, { ...dependencies,
    resolveSources: async () => sources().map(source => ({ ...source, approvalKey: "b".repeat(64) })) });
  assert.equal(prepared?.status, "unavailable");
  assert.equal(prepared?.reasonCode, "STUDENT_CLASSROOM_ACCESS_REVIEW_REQUIRED");
  assert.deepEqual(prepared?.perStudentPayloads, {});
});

test("compiled automatic permissions survive Focus and clear only their own saved Coverage assignment", async () => {
  const prepared = await prepareAutomaticClassroomAccess({ ...context(), policy: policy() }, dependencies);
  assert.equal(prepared?.status, "ready");
  const state = { ...emptyAutomaticFlightPathState(), schemaVersion: 2, revision: 1, status: "active",
    assignmentId: "automatic-a", flightPathId: "path-a", name: "Classroom", sourcePolicyRevision: 4,
    payload: { flightPathId: "path-a", flightPathName: "Classroom", allowedDomains: ["classroom.google.com"] },
    perStudentPayloads: prepared.perStudentPayloads, eligibleStudentIds: ["student-a", "student-b"] };
  const desired = automaticFlightPathDesiredState({ desiredState: { restrictions: { tabLimit: 3 } }, state,
    studentId: "student-a", teachingSessionId: "session-a" });
  const original = normalizeClasspilotRestrictions(desired.restrictions);
  assert.ok(original.flightPath.allowedDomains.includes("alpha.example.org"));
  assert.equal(original.flightPath.allowedDomains.includes("beta.example.org"), false);
  const focused = applyClasspilotControlCommand(original, "lock-screen", { url: "https://focus.example.org" });
  const unfocused = applyClasspilotControlCommand(focused, "unlock-screen", { screenOnly: true });
  assert.deepEqual(unfocused.flightPath, original.flightPath);
  const delegated = { restrictions: { flightPath: { active: true, allowedDomains: ["supervisor.example.org"] } },
    restorableClassState: { teachingSessionId: "session-a", desiredState: desired } };
  const cleared = removeAutomaticFlightPathFromDesiredState(delegated, "automatic-a", "session-a");
  assert.deepEqual(cleared.restrictions, delegated.restrictions);
  const saved = cleared.restorableClassState as { desiredState: { restrictions: unknown } };
  const restored = normalizeClasspilotRestrictions(saved.desiredState.restrictions);
  assert.equal(restored.flightPath.active, false);
  assert.equal(restored.tabLimit, 3);
  assert.equal(Object.hasOwn(restored.flightPath, "classroomMaterials"), false);
});
