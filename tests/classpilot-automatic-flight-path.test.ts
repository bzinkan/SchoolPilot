import assert from "node:assert/strict";
import { test } from "node:test";
import {
  automaticFlightPathDesiredState,
  automaticFlightPathPolicyDto,
  automaticFlightPathStateDto,
  emptyAutomaticFlightPathState,
  normalizeAutomaticFlightPathPolicy,
  normalizeAutomaticFlightPathState,
  readAutomaticFlightPathOrigin,
  removeAutomaticFlightPathFromDesiredState,
  withoutAutomaticFlightPathOrigin,
  type AutomaticFlightPathState,
} from "../src/services/classpilotAutomaticFlightPath.js";
import { normalizeClasspilotRestrictions } from "../src/services/classpilotClassroomState.js";
import { normalizePreciseWaypointResource } from "../src/services/restrictionResources.js";

const state = (overrides: Partial<AutomaticFlightPathState> = {}): AutomaticFlightPathState => ({
  ...emptyAutomaticFlightPathState(), revision: 1, status: "active", assignmentId: "automatic-assignment",
  flightPathId: "prepared-path", sourcePolicyRevision: 2, flightPathUpdatedAt: "2026-10-27T12:00:00.000Z", name: "Prepared lesson",
  payload: { flightPathId: "prepared-path", flightPathName: "Prepared lesson", allowedDomains: ["example.org"] },
  eligibleStudentIds: ["student-a", "student-b"], ...overrides,
});
const project = (desiredState: unknown, automaticState: unknown = state(), studentId = "student-a", allowApply = true) =>
  automaticFlightPathDesiredState({ desiredState, state: automaticState, studentId, teachingSessionId: "class-a", allowApply });
const restrictions = (desired: Record<string, unknown>) => normalizeClasspilotRestrictions(desired.restrictions);

test("missing, future, and malformed saved configuration stay disabled", () => {
  for (const value of [undefined, null, {}, { schemaVersion: 2, revision: 1, enabled: true },
    { schemaVersion: 1, revision: 1, enabled: true, flightPathId: null, updatedBy: "teacher" },
    { schemaVersion: 1, revision: -1, enabled: true, flightPathId: "path", updatedBy: "teacher" }]) {
    assert.equal(normalizeAutomaticFlightPathPolicy(value).enabled, false);
  }
  assert.equal(normalizeAutomaticFlightPathState({ ...state(), payload: { ...state().payload, allowedDomains: [], resources: [] } }).status, "inactive");
  assert.equal(normalizeAutomaticFlightPathState({ ...state(), assignmentId: null }).status, "inactive");
  assert.equal(normalizeAutomaticFlightPathState({ ...state(), schemaVersion: 2 }).status, "inactive");
});

test("automatic application is scoped, replay-safe, and does not mutate its inputs", () => {
  const previous = { restrictions: { blockList: { active: true, blockedDomains: ["games.example"] }, tabLimit: 5 }, unrelated: "preserved" };
  const before = structuredClone(previous);
  const applied = project(previous);
  assert.equal(restrictions(applied).flightPath.active, true);
  assert.equal(restrictions(applied).blockList.active, true);
  assert.equal(restrictions(applied).tabLimit, 5);
  assert.equal(applied.unrelated, "preserved");
  assert.deepEqual(project(applied), applied);
  assert.deepEqual(previous, before);
  assert.deepEqual(readAutomaticFlightPathOrigin(applied), { schemaVersion: 1, assignmentId: "automatic-assignment", teachingSessionId: "class-a" });
  assert.deepEqual(project(previous, state(), "not-in-frozen-roster"), previous);
  assert.deepEqual(project(previous, state(), "student-a", false), previous);
});

test("automatic application never displaces an existing Waypoint, Focus, or manual Flight Path", () => {
  for (const existing of [
    { screenLock: { active: true, url: "https://waypoint.example/" } },
    { focus: { active: true, assignmentId: "manual-focus" } },
    { flightPath: { active: true, allowedDomains: ["manual.example"], name: "Manual path" } },
  ]) {
    const desired = { restrictions: existing };
    assert.deepEqual(project(desired), desired);
    assert.equal(readAutomaticFlightPathOrigin(project(desired)), null);
  }
});

test("turning an occurrence off removes only its automatic path and preserves independent controls", () => {
  const applied = project({ restrictions: { blockList: { active: true, blockedDomains: ["games.example"] }, tabLimit: 5 } });
  const desired = { ...applied, restrictions: { ...restrictions(applied), screenLock: { active: true, url: "https://waypoint.example" },
    focus: { active: true, assignmentId: "manual-focus" } } };
  const stopped = project(desired, state({ status: "off", revision: 2 }));
  assert.equal(restrictions(stopped).flightPath.active, false);
  assert.equal(restrictions(stopped).screenLock.active, true);
  assert.equal(restrictions(stopped).focus?.active, true);
  assert.equal(restrictions(stopped).blockList.active, true);
  assert.equal(restrictions(stopped).tabLimit, 5);
  assert.equal(readAutomaticFlightPathOrigin(stopped), null);
  assert.deepEqual(project(stopped, state({ status: "off", revision: 2 })), stopped);
});

test("an explicit manual path retains ownership even when it matches the automatic path", () => {
  const applied = project({ restrictions: {} });
  const manual = withoutAutomaticFlightPathOrigin(applied);
  const off = state({ status: "off", revision: 2, manualOverrideStudentIds: ["student-a"] });
  assert.equal(readAutomaticFlightPathOrigin(manual), null);
  assert.deepEqual(project(manual, off), manual);
  assert.deepEqual(removeAutomaticFlightPathFromDesiredState(manual, "automatic-assignment", "class-a"), manual);
  assert.equal(restrictions(project(manual, off)).flightPath.active, true);
});

test("temporary supervision cleanup reaches the saved class path without clearing the current supervisor's path", () => {
  const saved = project({ restrictions: { tabLimit: 5 } });
  const delegated = { restrictions: { flightPath: { active: true, allowedDomains: ["supervisor.example"] } },
    restorableClassState: { teachingSessionId: "class-a", desiredState: saved, sourceCommandId: "old-command" } };
  const cleared = removeAutomaticFlightPathFromDesiredState(delegated, "automatic-assignment", "class-a");
  assert.deepEqual(cleared.restrictions, delegated.restrictions);
  const restorable = cleared.restorableClassState as { desiredState: Record<string, unknown>; sourceCommandId: string };
  assert.equal(restrictions(restorable.desiredState).flightPath.active, false);
  assert.equal(restrictions(restorable.desiredState).tabLimit, 5);
  assert.equal(restorable.sourceCommandId, "old-command");
  assert.deepEqual(project(restorable.desiredState, state({ status: "off", revision: 2 })), restorable.desiredState);
  assert.equal(restrictions(saved).flightPath.active, true, "cleanup must not mutate the captured source object");
});

test("late cleanup from a previous assignment or class cannot clear its replacement", () => {
  const applied = project({ restrictions: {} });
  assert.deepEqual(removeAutomaticFlightPathFromDesiredState(applied, "old-assignment", "class-a"), applied);
  assert.deepEqual(removeAutomaticFlightPathFromDesiredState(applied, "automatic-assignment", "previous-class"), applied);
  const otherClassSaved = { restorableClassState: { teachingSessionId: "next-class", desiredState: applied } };
  assert.deepEqual(removeAutomaticFlightPathFromDesiredState(otherClassSaved, "automatic-assignment", "class-a"), otherClassSaved);
});

test("precise entries survive exactly and ineligible students never receive broader domain access", () => {
  const resource = normalizePreciseWaypointResource("https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit");
  const precise = state({ payload: { flightPathId: "prepared-path", flightPathName: "One document", allowedDomains: [], resources: [resource] },
    eligibleStudentIds: ["student-a"], unavailableStudentIds: ["student-b"],
    unavailableReasons: { "student-b": "AUTOMATIC_FLIGHT_PATH_PRECISE_CAPABILITY_REQUIRED" } });
  const applied = project({ restrictions: {} }, precise);
  assert.deepEqual(restrictions(applied).flightPath.resources, [resource]);
  assert.deepEqual(restrictions(applied).flightPath.allowedDomains, []);
  assert.equal(restrictions(project({ restrictions: {} }, precise, "student-b")).flightPath.active, false);
});

test("teacher DTOs expose counts without internal assignment, author, or student identifiers", () => {
  const dto = automaticFlightPathStateDto(state({ unavailableStudentIds: ["student-c"] }));
  assert.equal(dto.eligibleCount, 2);
  assert.equal(dto.unavailableCount, 1);
  assert.doesNotMatch(JSON.stringify(dto), /student-a|student-b|student-c|automatic-assignment|manualOverrideStudentIds|payload/);
  const policy = automaticFlightPathPolicyDto({ schemaVersion: 1, revision: 3, enabled: true, flightPathId: "prepared-path", updatedBy: "private-author" });
  assert.doesNotMatch(JSON.stringify(policy), /private-author|updatedBy/);
});
