import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateClasspilotCommandPayload } from "../src/services/classpilotCommandValidation.js";
import { publicClasspilotCommand } from "../src/services/classpilotCommandPublic.js";
import { negotiateClasspilotProtocol } from "../src/services/classpilotProtocol.js";
import { applyClasspilotControlCommand, emptyClasspilotRestrictions, normalizeClasspilotRestrictions,
  serializeClasspilotStudentControlStateForDelivery } from "../src/services/classpilotClassroomState.js";
import { assertExactFocusTargetScope, focusRecord, focusServerOrigin, focusStatusChanged,
  focusStatusSchema, withoutClasspilotFocus, type ClasspilotFocusAssignment, type ClasspilotFocusRestriction } from "../src/services/classpilotFocus.js";
import { classpilotControlStateAckRequired } from "../src/services/classpilotControlStateAckGate.js";
import { classpilotFocusCleanupFrame } from "../src/services/classpilotFocusCleanup.js";
import type { ClasspilotStudentControlState } from "../src/schema/classpilot.js";

const now = new Date("2026-09-30T12:00:00.000Z");
const row = { studentId: "student", tabRef: "opaque-tab", observedRevision: 9 };
const binding = { schoolId: "school", studentId: "student", studentSessionId: "session", deviceId: "device" };
const focus: ClasspilotFocusRestriction = { active: true, assignmentId: "assignment", tabRef: row.tabRef,
  observedRevision: row.observedRevision, targetKind: "snapshot", source: "teacher", setAt: now.toISOString() };
const assignment: ClasspilotFocusAssignment = { version: 1, assignmentId: "assignment", ...binding,
  serverOrigin: focusServerOrigin(), teachingSessionId: "class", supervisionContextId: null, ownerId: "teacher",
  contextAuthorityRevision: null, sourceCommandId: "command", sourceTargetId: "target", revisionAtAssignment: 8 };
function state(desiredState: unknown = { restrictions: { ...emptyClasspilotRestrictions(), focus }, focusAssignmentV1: assignment }): ClasspilotStudentControlState {
  return { id: "state", schoolId: binding.schoolId, studentId: binding.studentId,
    teachingSessionId: "class", supervisionContextId: null, revision: 8, desiredState, sourceCommandId: "command",
    scheduledEndAt: new Date(now.getTime() + 60_000), hardExpiresAt: new Date(now.getTime() + 120_000),
    enforcementHealth: "pending", appliedRevision: null, lastOutcome: null, lastError: null,
    lastAcknowledgedAt: null, createdAt: now, updatedAt: now };
}
const capable = ["scopedAuthorityChecksV1", "focusTabV1"];

describe("Focus and Bring Forward public and desired-state contract", () => {
  it("strictly accepts one safe exact row per student and rejects private receipt fields", () => {
    for (const command of ["focus-tab", "activate-tab"]) {
      assert.deepEqual(validateClasspilotCommandPayload(command, { tabTargets: [row] }), { tabTargets: [row] });
      for (const payload of [{ tabTargets: [row, row] }, { tabTargets: [{ ...row, openTabCommandId: "proof" }] },
        { tabTargets: [{ ...row, observedRevision: Number.MAX_SAFE_INTEGER + 1 }] }, { tabTargets: [], url: "https://example.org" },
        { tabTargets: [row], targetKind: "open_receipt" }]) assert.throws(() => validateClasspilotCommandPayload(command, payload));
    }
    assert.deepEqual(validateClasspilotCommandPayload("stop-focus", {}), {});
    assert.throws(() => validateClasspilotCommandPayload("stop-focus", { assignmentId: "assignment" }));
  });
  it("keeps normal open identical and makes literal true the only continuation option", () => {
    assert.deepEqual(validateClasspilotCommandPayload("open-tab", { url: "example.org" }), { url: "https://example.org/" });
    assert.deepEqual(validateClasspilotCommandPayload("open-tab", { url: "example.org", focusAfterOpen: true }),
      { url: "https://example.org/", focusAfterOpen: true });
    assert.throws(() => validateClasspilotCommandPayload("open-tab", { url: "example.org", focusAfterOpen: false }));
  });
  it("requires explicit, nonduplicate student IDs exactly equal to target rows", () => {
    assert.doesNotThrow(() => assertExactFocusTargetScope("focus-tab", "students", [row.studentId], [row]));
    for (const [scope, ids] of [["class", [row.studentId]], ["students", []], ["students", [row.studentId, row.studentId]],
      ["students", ["different"]]] as const) assert.throws(() => assertExactFocusTargetScope("focus-tab", scope, ids, [row]));
  });
  it("negotiates only with the default-off flag and repaired scoped authority", () => {
    const env = { CLASSPILOT_PROTOCOL_V3_ENABLED: "true", CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true" };
    assert.deepEqual(negotiateClasspilotProtocol({ clientProtocolVersion: 3, advertisedCapabilities: capable, env }).acceptedCapabilities,
      ["scopedAuthorityChecksV1"]);
    assert.deepEqual(negotiateClasspilotProtocol({ clientProtocolVersion: 3, advertisedCapabilities: capable,
      env: { ...env, CLASSPILOT_CAP_FOCUS_TAB_V1: "true" } }).acceptedCapabilities, capable);
    assert.deepEqual(negotiateClasspilotProtocol({ clientProtocolVersion: 3, advertisedCapabilities: ["focusTabV1"],
      env: { ...env, CLASSPILOT_CAP_FOCUS_TAB_V1: "true" } }).acceptedCapabilities, []);
  });
  it("does not change the legacy empty snapshot and preserves Focus through unrelated restriction edits", () => {
    assert.equal(Object.hasOwn(normalizeClasspilotRestrictions({}), "focus"), false);
    assert.deepEqual(applyClasspilotControlCommand({ ...emptyClasspilotRestrictions(), focus }, "attention-mode", { active: true }, now).focus, focus);
  });
  it("delivers only an exact private assignment and an accepted capable binding", () => {
    const send = (exactBinding = binding, acceptedCapabilities = capable, desiredState = state().desiredState) =>
      serializeClasspilotStudentControlStateForDelivery({ state: state(desiredState), now, gateActive: false, exactBinding, acceptedCapabilities });
    assert.deepEqual(send().classroomState?.restrictions.focus, focus);
    for (const key of ["schoolId", "studentId", "studentSessionId", "deviceId"])
      assert.equal(send({ ...binding, [key]: "different" }).classroomState, null);
    assert.equal(send(binding, []).classroomState, null);
    assert.equal(send(binding, capable, { restrictions: { focus } }).classroomState, null);
    assert.equal(send(binding, capable, { restrictions: { focus: { ...focus, targetKind: "url" } }, focusAssignmentV1: assignment }).classroomState, null);
  });
  it("allows inactive and expired cleanup without the feature capability", () => {
    const clear = serializeClasspilotStudentControlStateForDelivery({ state: state({ restrictions: { focus: { active: false } } }),
      now, gateActive: false, exactBinding: binding, acceptedCapabilities: [] });
    assert.deepEqual(clear.classroomState?.restrictions.focus, { active: false });
    const expired = serializeClasspilotStudentControlStateForDelivery({ state: state(),
      now: new Date(now.getTime() + 180_000), gateActive: false, exactBinding: binding, acceptedCapabilities: [] });
    assert.deepEqual(expired.classroomState?.restrictions, emptyClasspilotRestrictions());
  });
  it("retires active/private/saved Focus together and preserves unrelated restrictions", () => {
    const original = state().desiredState;
    const cleaned = withoutClasspilotFocus({ ...focusRecord(original), restorableClassState: { teachingSessionId: "old",
      desiredState: { ...focusRecord(original), restrictions: { focus, blockList: { active: true, blockedDomains: ["example.org"] } } } } });
    assert.equal(Object.hasOwn(cleaned, "focusAssignmentV1"), false);
    assert.equal(Object.hasOwn(focusRecord(cleaned.restrictions), "focus"), false);
    const saved = focusRecord(focusRecord(cleaned.restorableClassState).desiredState);
    assert.equal(Object.hasOwn(saved, "focusAssignmentV1"), false);
    assert.deepEqual(focusRecord(saved.restrictions).blockList, { active: true, blockedDomains: ["example.org"] });
  });
  it("projects the entire private intent into bounded public follow-up status", () => {
    const intent = { version: 1, assignmentId: "assignment", childCommandId: "child", deadline: now.toISOString(),
      state: "committed", binding: assignment, childRevision: 8 };
    const projected = publicClasspilotCommand({ commandType: "open-tab", targets: [{ studentId: "student",
      result: { focusOpenIntentV1: intent, focusExactAuthorityV1: assignment, focusCleanupV1: assignment,
        nested: { focusAssignmentV1: assignment, focusCleanupV1: assignment } } }] });
    assert.deepEqual(projected.targets[0].result, { followUp: { kind: "focus", state: "committed", commandId: "child" }, nested: {} });
    assert.doesNotMatch(JSON.stringify(projected), /device|session|serverOrigin|ownerId|revisionAtAssignment/);
  });
  it("derives committed and refused follow-up status independently of forged client fields and key order", () => {
    for (const state of ["committed", "refused"] as const) {
      const intent = { version: 1, assignmentId: "assignment", childCommandId: "trusted-child", deadline: now.toISOString(),
        state, binding: assignment, ...(state === "committed" ? { childRevision: 8 } : { errorCode: "FOCUS_RECEIPT_INVALID" }) };
      const forged = { kind: "focus", state: state === "committed" ? "refused" : "committed", commandId: "forged-child" };
      for (const result of [{ focusOpenIntentV1: intent, followUp: forged }, { followUp: forged, focusOpenIntentV1: intent }]) {
        const projected = publicClasspilotCommand({ targets: [{ result }] });
        assert.deepEqual(projected.targets[0].result.followUp, { kind: "focus", state,
          ...(state === "committed" ? { commandId: "trusted-child" } : { errorCode: "FOCUS_RECEIPT_INVALID" }) });
      }
    }
    assert.deepEqual(publicClasspilotCommand({ targets: [{ result: { followUp: { state: "committed" } } }] }).targets[0].result, {});
  });
  it("emits a bounded empty bare stop on capability withdrawal without projecting remaining restrictions", () => {
    const cleaned = state({ restrictions: { flightPath: { active: true, resources: [{ provider: "google_docs", resourceId: "private" }] } },
      focusCleanupV1: assignment });
    const build = (row = cleaned, exact = binding, acceptedCapabilities = ["scopedAuthorityChecksV1"], authorityCurrent = true) =>
      classpilotFocusCleanupFrame({ state: row, binding: exact, acceptedCapabilities, authorityCurrent, now });
    const frame = build(); assert.ok(frame);
    assert.deepEqual(frame.command.data, {});
    assert.equal(frame.exactBinding.controlRevision, cleaned.revision);
    assert.equal(frame.command.expiresAt, cleaned.scheduledEndAt?.toISOString());
    assert.equal(Object.hasOwn(frame, "classroomState"), false);
    assert.doesNotMatch(JSON.stringify(frame), /resources|flightPath|google_docs|focusCleanupV1/);
    assert.equal(build(state()), null, "a replacement assignment removes prior cleanup authority");
    assert.equal(build(cleaned, { ...binding, studentSessionId: "replacement" }), null);
    assert.equal(build(cleaned, binding, []), null);
    assert.equal(build(cleaned, binding, ["scopedAuthorityChecksV1"], false), null);
    assert.equal(build({ ...cleaned, scheduledEndAt: now }), null);
  });
  it("does not skip a same-revision suspension/invalidation status transition", () => {
    const current = { ...state(), appliedRevision: 8, enforcementHealth: "synced" };
    const status = { assignmentId: "assignment", state: "suspended", reason: "authentication" };
    assert.equal(focusStatusChanged(current.desiredState, status), true);
    assert.equal(classpilotControlStateAckRequired({ controlState: current, appliedRevision: 8, outcome: "applied",
      lateSignInOriginPending: false, restrictionAuthRevisionMismatch: false, focusStatusChanged: true }), true);
    assert.equal(focusStatusSchema.safeParse({ ...status, deviceId: "private" }).success, false);
  });
});
