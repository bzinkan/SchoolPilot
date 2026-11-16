import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  applyClasspilotControlCommand,
  emptyClasspilotRestrictions,
  normalizeClasspilotRestrictions,
  serializeClasspilotStudentControlStateForDelivery,
} from "../src/services/classpilotClassroomState.js";
import { negotiateClasspilotProtocol } from "../src/services/classpilotProtocol.js";
import { CLASSPILOT_PROTOCOL_V3_CAPABILITIES } from "../src/services/classpilotProtocol.js";
import { classpilotManagedDevicePreflightRequestSchema } from "../src/services/classpilotManagedDeviceContinuity.js";
import { classpilotKioskLaunchTicketRequestSchema, classpilotKioskLaunchTicketPreflightSchema } from "../src/services/classpilotKioskLaunchTicket.js";
import { validateClasspilotCommandPayload } from "../src/services/classpilotCommandValidation.js";
import type { ClasspilotStudentControlState } from "../src/schema/classpilot.js";
import { validateClassroomFocusScope, classroomFocusScopeAllowsUrl } from "../src/services/classroomFocusScope.js";
import { clearPreciseRestrictionsFromDesiredState } from "../src/services/classpilotPreciseRestrictionRollback.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/classroom-focus-scope-cases.json", import.meta.url), "utf8"));
const scope = fixture.scope;
const restrictions = () => ({ ...emptyClasspilotRestrictions(), screenLock: {
  active: true, url: "https://classroom.google.com", domain: "classroom.google.com", classroomScope: scope,
} });
const now = new Date("2026-11-16T19:00:00Z");
function control(): ClasspilotStudentControlState {
  return {
    id: "scope-control", schoolId: "scope-school", studentId: "scope-student",
    teachingSessionId: "scope-class", supervisionContextId: null, revision: 7,
    desiredState: { restrictions: restrictions() }, sourceCommandId: "scope-command",
    scheduledEndAt: new Date(now.getTime() + 60_000), hardExpiresAt: new Date(now.getTime() + 120_000),
    enforcementHealth: "synced", appliedRevision: 7, lastOutcome: "applied", lastError: null,
    lastAcknowledgedAt: now, createdAt: now, updatedAt: now,
  };
}
const exactBinding = { schoolId: "scope-school", studentId: "scope-student", studentSessionId: "scope-session", deviceId: "scope-device" };
const parents = ["scopedAuthorityChecksV1", "preciseRestrictionResourcesV1"];

test("the shared Classroom scope fixture retains its reviewed byte identity", () => {
  const bytes = readFileSync(new URL("./fixtures/classroom-focus-scope-cases.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "4b04de889de92a89225d0e5b33bdf9d4f5b0ecce86c95cbe67d21b116bffa0f5");
});

test("full successor advertisements fit shared-device continuity and kiosk preflight without truncating Classroom support", () => {
  const capabilities = [...CLASSPILOT_PROTOCOL_V3_CAPABILITIES, "managedDeviceContinuityV1"];
  const request = { clientProtocolVersion: 3, capabilities };
  assert.deepEqual(classpilotManagedDevicePreflightRequestSchema.parse(request).capabilities, capabilities);
  assert.deepEqual(classpilotKioskLaunchTicketPreflightSchema.parse(request).capabilities, capabilities);
  assert.deepEqual(classpilotKioskLaunchTicketRequestSchema.parse({ ...request, directoryDeviceId: "synthetic-directory" }).capabilities, capabilities);
  assert.equal(classpilotKioskLaunchTicketPreflightSchema.safeParse({ ...request, capabilities: Array(65).fill("scopedAuthorityChecksV1") }).success, false);
});

test("reviewed Classroom websites admit assigned destinations without widening YouTube or sign-in", () => {
  for (const row of fixture.match) {
    assert.equal(classroomFocusScopeAllowsUrl(scope, row.url), row.allowed, row.url);
  }
  for (const hostname of ["youtube.com", "m.youtube.com", "accounts.google.com", "login.microsoftonline.com"]) {
    assert.equal(validateClassroomFocusScope({ ...scope, resources: [{ type: "section", hostname,
      includeSubdomains: false, pathPrefix: "/watch" }] }), null, hostname);
  }
});

test("rollback ends malformed Classroom scopes in live and restorable snapshots and preserves the Flight Path", () => {
  const flightPath = { active: true, allowedDomains: ["school.example"] };
  const desired = { restrictions: { ...restrictions(), flightPath }, restorableClassState: {
    sourceCommandId: "old-command", desiredState: { screenLock: { active: false, classroomScope: null } },
  } };
  const result = clearPreciseRestrictionsFromDesiredState(desired);
  assert.equal(result.changed, true);
  assert.equal(result.clearedScreenLocks, 2);
  assert.deepEqual(result.desiredState, { ...desired,
    restrictions: { ...desired.restrictions, screenLock: { active: false } },
    restorableClassState: { sourceCommandId: null, desiredState: { screenLock: { active: false } } },
  });
});

test("teacher Classroom Focus accepts only a reviewed source reference, never a supplied scope", () => {
  const reference = { courseId: "course-1", reviewToken: "opaque-review-token" };
  assert.deepEqual(validateClasspilotCommandPayload("lock-screen", { url: "https://classroom.google.com", classroomFocus: reference }),
    { url: "https://classroom.google.com/", classroomFocus: reference });
  assert.throws(() => validateClasspilotCommandPayload("lock-screen", { url: "https://classroom.google.com", classroomScope: scope }));
  assert.throws(() => validateClasspilotCommandPayload("lock-screen", { url: "https://other.example", classroomFocus: reference }));
  assert.throws(() => validateClasspilotCommandPayload("lock-screen", { url: "CURRENT_URL", classroomFocus: reference }));
});

test("Classroom Focus scope survives normalization and unrelated restriction changes", () => {
  const normalized = normalizeClasspilotRestrictions(restrictions());
  assert.deepEqual((normalized.screenLock as Record<string, unknown>).classroomScope, scope);
  const changed = applyClasspilotControlCommand(normalized, "attention-mode", { active: true });
  assert.deepEqual((changed.screenLock as Record<string, unknown>).classroomScope, scope);
});

test("malformed carried Classroom Focus scope is preserved for fail-closed delivery", () => {
  const malformed = { ...restrictions(), screenLock: { ...restrictions().screenLock, classroomScope: { invalid: true } } };
  const normalized = normalizeClasspilotRestrictions(malformed);
  assert.deepEqual((normalized.screenLock as Record<string, unknown>).classroomScope, { invalid: true });
  const projected = serializeClasspilotStudentControlStateForDelivery({ state: { ...control(), desiredState: { restrictions: malformed } },
    gateActive: true, exactBinding, acceptedCapabilities: [...parents, "classroomFocusScopeV1"], now });
  assert.equal(projected.withheld, true);
});

test("Classroom Focus never degrades to a single-host snapshot for an older client", () => {
  const projected = serializeClasspilotStudentControlStateForDelivery({ state: control(), gateActive: true,
    exactBinding, acceptedCapabilities: parents, now });
  assert.equal(projected.withheld, true);
  assert.equal(projected.classroomState, null);
});

test("exact capable Classroom Focus delivery carries the complete reviewed scope", () => {
  const projected = serializeClasspilotStudentControlStateForDelivery({ state: control(), gateActive: true,
    classroomFocusScopeGateActive: true, exactBinding, acceptedCapabilities: [...parents, "classroomFocusScopeV1"], now });
  assert.equal(projected.withheld, false);
  assert.deepEqual((projected.classroomState!.restrictions.screenLock as Record<string, unknown>).classroomScope, scope);
  const cleared = applyClasspilotControlCommand({ ...restrictions(), flightPath: { active: true, allowedDomains: ["school.example"] } },
    "unlock-screen", { screenOnly: true });
  assert.deepEqual(cleared.screenLock, { active: false });
  assert.deepEqual(cleared.flightPath.allowedDomains, ["school.example"]);
});

test("turning Classroom Focus off withholds cached accepted capability snapshots", () => {
  const projected = serializeClasspilotStudentControlStateForDelivery({ state: control(), gateActive: true,
    classroomFocusScopeGateActive: false, exactBinding, acceptedCapabilities: [...parents, "classroomFocusScopeV1"], now });
  assert.equal(projected.withheld, true);
  assert.equal(projected.classroomState, null);
});

test("Classroom Focus capability requires both repaired authority and precise-resource acceptance", () => {
  const env = { CLASSPILOT_PROTOCOL_V3_ENABLED: "true", CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
    CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1: "true", CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1: "true" };
  const negotiate = (advertisedCapabilities: string[]) => negotiateClasspilotProtocol({ clientProtocolVersion: 3,
    advertisedCapabilities, scope: { schoolId: "scope-school" }, env }).acceptedCapabilities as readonly string[];
  assert.ok(negotiate([...parents, "classroomFocusScopeV1"]).includes("classroomFocusScopeV1"));
  assert.equal(negotiate(["scopedAuthorityChecksV1", "classroomFocusScopeV1"]).includes("classroomFocusScopeV1"), false);
  assert.equal(negotiate(["preciseRestrictionResourcesV1", "classroomFocusScopeV1"]).includes("classroomFocusScopeV1"), false);
});
