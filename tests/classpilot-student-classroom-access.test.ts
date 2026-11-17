import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isGoogleSearchHostname } from "../src/services/classroomFocusScope.js";

const scope = JSON.parse(readFileSync(new URL("./fixtures/classroom-focus-scope-cases.json", import.meta.url), "utf8")).scope;
const source = { studentId: "student-a", scope, courseCount: 2, itemCount: 3, linkCount: 4, approvalKey: "a".repeat(64) };
const path = { id: "path-a", flightPathName: "Classroom", allowedDomains: ["classroom.google.com"],
  resources: [], updatedAt: new Date("2026-11-16T20:00:00Z") };
const identity = { schoolId: "school-a", actorId: "teacher-a", authority: { teachingSessionId: "class-a" }, targets: ["student-a"] };
async function implementation() {
  const modulePath = "../src/services/classpilotStudentClassroomAccess.js";
  const candidate = await import(modulePath).catch(() => ({}));
  assert.equal(typeof candidate.createStudentClassroomAccessReview, "function", "all-courses review must exist");
  return candidate;
}

test("student Classroom proof binds mode, exact source map, identity and expiry", async () => {
  const api = await implementation();
  const deps = { signingSecret: "student-classroom-test-only", now: () => 10_000 };
  const review = api.createStudentClassroomAccessReview({ identity, mode: "focus", sources: [source] }, deps);
  assert.equal(review.purpose, "student-classroom-access");
  assert.equal(review.studentCount, 1);
  assert.equal(review.courseCount, 2);
  const searchReview = api.createStudentClassroomAccessReview({ identity, mode: "focus", sources: [{ ...source, blockedSearchLinkCount: 2 }] }, deps);
  assert.equal(searchReview.warnings.some((warning: { code: string; count?: number }) => warning.code === "GOOGLE_SEARCH_BLOCKED" && warning.count === 2), true);
  assert.equal(JSON.stringify(review).includes("student-a"), false, "public review must not include per-student source identities");
  assert.equal(api.verifyStudentClassroomAccessReview({ identity, mode: "focus", sources: [source], reviewToken: review.reviewToken }, deps).expiresAt, 130_000);
  for (const change of [{ mode: "flight-path" }, { identity: { ...identity, actorId: "other" } },
    { sources: [{ ...source, scope: { ...scope, sourceRevision: "b".repeat(64) } }] }, { sources: [{ ...source, approvalKey: "b".repeat(64) }] }]) {
    assert.throws(() => api.verifyStudentClassroomAccessReview({ identity, mode: "focus", sources: [source], reviewToken: review.reviewToken, ...change }, deps));
  }
  assert.throws(() => api.verifyStudentClassroomAccessReview({ identity, mode: "focus", sources: [source], reviewToken: review.reviewToken }, { ...deps, now: () => 130_000 }));
  assert.throws(() => api.verifyStudentClassroomAccessReview({ identity, mode: "focus", reviewToken: review.reviewToken.split(".")[0] + "." + "é".repeat(43) }, deps));
});

test("compiled student Flight Path validates its provenance and never adds Google Search", async () => {
  const api = await implementation();
  const compiled = api.compileStudentClassroomFlightPath({ schoolId: "school-a", flightPath: path, source });
  const legacyWebsite = api.compileStudentClassroomFlightPath({ schoolId: "school-a", flightPath: { ...path, allowedDomains: [],
    resources: [{ type: "website", hostname: "classroom.google.com", includeSubdomains: true }] }, source });
  assert.deepEqual(legacyWebsite.allowedDomains, compiled.allowedDomains);
  assert.equal(compiled.allowedDomains.includes("google.com"), false);
  assert.equal(compiled.allowedDomains.includes("docs.google.com"), true);
  assert.equal(api.validateStudentClassroomFlightPath(compiled), true);
  assert.equal(api.validateStudentClassroomFlightPath({ ...compiled, allowedDomains: [...compiled.allowedDomains, "google.com"] }), false);
  assert.throws(() => api.compileStudentClassroomFlightPath({ schoolId: "school-a", flightPath: { ...path, allowedDomains: ["classroom.google.com", "google.com"] }, source }));
  for (const searchHost of ["google.co.uk", "google.ca", "google.cat", "encrypted.google.com", "search.google.com",
    "images.google.com", "www.images.google.com", "image.google.ca", "video.google.co.uk", "videos.google.cat"]) {
    assert.throws(() => api.compileStudentClassroomFlightPath({ schoolId: "school-a", flightPath: { ...path, allowedDomains: ["classroom.google.com", searchHost] }, source }), searchHost);
    assert.throws(() => api.createStudentClassroomFocusPayload("school-a", { ...source, scope: { ...scope, allowedDomains: [...scope.allowedDomains, searchHost] } }), searchHost);
  }
  for (const assignedHost of ["google.org", "google.dev", "google.zz", "docs.google.com", "drive.google.com", "maps.google.com"]) {
    assert.equal(isGoogleSearchHostname(assignedHost), false, `${assignedHost} is not a supported Google Search root`);
    assert.equal(api.createStudentClassroomFocusPayload("school-a", { ...source,
      scope: { ...scope, allowedDomains: [...new Set([...scope.allowedDomains, assignedHost])] } }).classroomScope.allowedDomains.includes(assignedHost), true);
  }
  const other = api.compileStudentClassroomFlightPath({ schoolId: "school-a", flightPath: path,
    source: { ...source, studentId: "student-b", scope: { ...scope, sourceRevision: "c".repeat(64),
      allowedDomains: scope.allowedDomains.filter((host: string) => host.endsWith("google.com") || host === "forms.gle") } } });
  assert.notDeepEqual(compiled.allowedDomains, other.allowedDomains);
  assert.notEqual(api.classroomFlightPathBasePolicyHash(path), api.classroomFlightPathBasePolicyHash({ ...path, updatedAt: new Date("2026-11-16T20:01:00Z") }));
});

test("private per-student command scopes are selected exactly and absent from public history/wire", async () => {
  const api = await implementation();
  const payloadA = { url: "https://classroom.google.com/", classroomScope: scope };
  const payloadB = { url: "https://classroom.google.com/", classroomScope: { ...scope, sourceRevision: "d".repeat(64) } };
  const payload = { url: "https://classroom.google.com/", classroomAccessV1: api.createStudentClassroomAccessEnvelope({ mode: "focus", payloadByStudent: { "student-a": payloadA, "student-b": payloadB } }) };
  assert.deepEqual(api.studentClassroomCommandPayloadForTarget(payload, "student-a"), payloadA);
  assert.deepEqual(api.studentClassroomCommandPayloadForTarget(payload, "student-b"), payloadB);
  assert.equal(api.studentClassroomCommandPayloadForTarget(payload, "other"), null);
  const { publicClasspilotCommand } = await import("../src/services/classpilotCommandPublic.js");
  assert.equal(JSON.stringify(publicClasspilotCommand({ commandPayload: payload })).includes("student-b"), false);
});

test("manual all-course review binds the saved path and exact students and strips the proof", async () => {
  const api = await implementation();
  const request = { schoolId: "school-a", actorId: "teacher-a", mode: "flight-path", authority: { teachingSessionId: "class-a" },
    targetStudentIds: ["student-a"], flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString() };
  const deps = { enabled: true, signingSecret: "manual-test-only", now: () => 10_000,
    resolveSources: async () => [source], loadFlightPath: async () => path };
  const review = await api.previewStudentClassroomAccess(request, deps);
  const context = { schoolId: request.schoolId, actorId: request.actorId, teachingSessionId: "class-a", targetScope: "students", targetStudentIds: request.targetStudentIds };
  const command = { flightPathId: path.id, expectedFlightPathUpdatedAt: request.expectedFlightPathUpdatedAt, classroomAccess: { reviewToken: review.reviewToken } };
  const prepared = await api.prepareStudentClassroomAccessCommand(context, "apply-flight-path", command, deps);
  assert.equal(JSON.stringify(prepared).includes(review.reviewToken), false);
  assert.equal(prepared.classroomAccessV1.payloadByStudent["student-a"].classroomMaterials.studentId, "student-a");
  await assert.rejects(api.prepareStudentClassroomAccessCommand(context, "lock-screen", { url: "https://classroom.google.com/", classroomAccess: command.classroomAccess }, deps));
  await assert.rejects(api.prepareStudentClassroomAccessCommand(context, "apply-flight-path", command,
    { ...deps, loadFlightPath: async () => ({ ...path, updatedAt: new Date("2026-11-16T20:01:00Z") }) }));
  await assert.rejects(api.previewStudentClassroomAccess(request, { ...deps, resolveSources: async () => [{ ...source, studentId: "other-student" }] }));
});

test("derived paths retain their own provenance under Focus and clear or withhold without widening", async () => {
  const api = await implementation();
  const { applyClasspilotControlCommand, emptyClasspilotRestrictions, serializeClasspilotStudentControlStateForDelivery } = await import("../src/services/classpilotClassroomState.js");
  const { clearPreciseRestrictionsFromDesiredState } = await import("../src/services/classpilotPreciseRestrictionRollback.js");
  const now = new Date("2026-11-16T20:00:00Z");
  const compiled = api.compileStudentClassroomFlightPath({ schoolId: "school-a", flightPath: path, source: { ...source, scope: { ...scope, resources: [] } } });
  const markedState = { schoolId: "school-a", desiredState: { restrictions: { flightPath: { active: true, ...compiled } } }, hardExpiresAt: new Date(Date.now() + 60_000) };
  assert.equal(api.studentClassroomAccessApprovalKeyForState(markedState), source.approvalKey);
  assert.equal(api.studentClassroomAccessApprovalKeyForState({ ...markedState, hardExpiresAt: new Date(Date.now() - 1) }), null,
    "an expired empty clear carries no source approval generation or derived publication capability requirement");
  let restrictions = applyClasspilotControlCommand(emptyClasspilotRestrictions(), "apply-flight-path", compiled, now);
  restrictions = applyClasspilotControlCommand(restrictions, "lock-screen", { url: "https://school.example/" }, now);
  restrictions = applyClasspilotControlCommand(restrictions, "unlock-screen", { screenOnly: true }, now);
  assert.deepEqual(restrictions.flightPath.classroomMaterials, compiled.classroomMaterials);
  const state = { id: "state-a", schoolId: "school-a", studentId: "student-a", teachingSessionId: "class-a", supervisionContextId: null,
    revision: 3, desiredState: { restrictions }, sourceCommandId: "command-a", scheduledEndAt: new Date(now.getTime() + 60_000), hardExpiresAt: new Date(now.getTime() + 120_000),
    enforcementHealth: "synced" as const, appliedRevision: 3, lastOutcome: "applied", lastError: null, lastAcknowledgedAt: now, createdAt: now, updatedAt: now };
  const options = { state, gateActive: true, classroomFocusScopeGateActive: true, studentClassroomAccessApproved: true,
    acceptedCapabilities: ["scopedAuthorityChecksV1", "preciseRestrictionResourcesV1", "classroomFocusScopeV1"], now,
    exactBinding: { schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a" } };
  const allowed = serializeClasspilotStudentControlStateForDelivery(options);
  assert.equal(allowed.withheld, false);
  assert.equal(JSON.stringify(allowed.classroomState).includes("classroomMaterials"), false);
  for (const change of [{ studentClassroomAccessApproved: false }, { classroomFocusScopeGateActive: false }, { acceptedCapabilities: ["scopedAuthorityChecksV1", "preciseRestrictionResourcesV1"] },
    { state: { ...state, studentId: "student-b" } }, { state: { ...state, desiredState: { restrictions: { ...restrictions, flightPath: { ...restrictions.flightPath, allowedDomains: [...restrictions.flightPath.allowedDomains, "google.com"] } } } } }]) {
    assert.equal(serializeClasspilotStudentControlStateForDelivery({ ...options, ...change }).withheld, true);
  }
  assert.equal(serializeClasspilotStudentControlStateForDelivery({ ...options, studentClassroomAccessApproved: false, now: new Date(now.getTime() + 120_000) }).withheld, false, "expiry clear survives approval withdrawal");
  const cleared = clearPreciseRestrictionsFromDesiredState({ restrictions, restorableClassState: { sourceCommandId: "prior", desiredState: { restrictions } } });
  assert.equal(cleared.clearedFlightPaths, 2);
  assert.equal(JSON.stringify(cleared.desiredState).includes("classroomMaterials"), false);
});
