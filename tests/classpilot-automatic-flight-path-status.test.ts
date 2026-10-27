import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClasspilotStudentControlState } from "../src/schema/classpilot.js";
import { summarizeAutomaticFlightPathSession } from "../src/services/classpilotAutomaticFlightPathStatus.js";

const now = new Date("2026-10-27T14:15:00Z");
const startedAt = new Date("2026-10-27T14:00:00Z");
const deadline = new Date("2026-10-27T14:45:00Z");
const assignment = {
  schemaVersion: 1, revision: 1, status: "active", assignmentId: "assignment",
  sourcePolicyRevision: 3, flightPathId: "path", flightPathUpdatedAt: startedAt.toISOString(), name: "Math",
  payload: { flightPathId: "path", flightPathName: "Math", allowedDomains: ["example.org"] },
  reasonCode: null, manualOverrideStudentIds: [], eligibleStudentIds: ["student"], unavailableStudentIds: [],
  unavailableReasons: {}, deferredStudentIds: [],
};
function control(overrides: Partial<ClasspilotStudentControlState> = {}): ClasspilotStudentControlState {
  return {
    id: "state", schoolId: "school", studentId: "student", teachingSessionId: "session", supervisionContextId: null,
    revision: 4, desiredState: {
      restrictions: { flightPath: { active: true, allowedDomains: ["example.org"], name: "Math" } },
      automaticFlightPath: { schemaVersion: 1, assignmentId: "assignment", teachingSessionId: "session" },
    }, sourceCommandId: null, scheduledEndAt: deadline, hardExpiresAt: deadline,
    enforcementHealth: "pending", appliedRevision: null, lastOutcome: null, lastError: null,
    lastAcknowledgedAt: null, createdAt: startedAt, updatedAt: startedAt, ...overrides,
  };
}
function summarize(row: ClasspilotStudentControlState, state: unknown = assignment, clock = now) {
  return summarizeAutomaticFlightPathSession({
    session: { id: "session", automaticFlightPathState: state, endTime: null, scheduledEndAt: deadline },
    studentIds: ["student"], controls: [row], activeSessions: [{ studentId: "student", startedAt }], now: clock,
  });
}

test("automatic Flight Path status confirms only the current revision and current sign-in", () => {
  assert.equal(summarize(control()).students[0]?.status, "pending");
  const applied = control({ enforcementHealth: "synced", appliedRevision: 4, lastAcknowledgedAt: now });
  assert.equal(summarize(applied).students[0]?.status, "applied");
  assert.equal(summarize({ ...applied, appliedRevision: 3 }).students[0]?.status, "pending");
  assert.equal(summarize({ ...applied, lastAcknowledgedAt: new Date(startedAt.getTime() - 1) }).students[0]?.status, "pending");
});

test("manual choices and replacement ownership are never reported as the automatic preset applying", () => {
  const manual = control({ desiredState: { restrictions: { flightPath: { active: true, allowedDomains: ["manual.example.org"] } } } });
  assert.equal(summarize(manual).students[0]?.status, "unavailable");
  assert.equal(summarize(manual, { ...assignment, manualOverrideStudentIds: ["student"] }).students[0]?.status, "overridden");
  const replacement = control({ teachingSessionId: "new-class", enforcementHealth: "synced", appliedRevision: 4, lastAcknowledgedAt: now });
  assert.equal(summarize(replacement).students[0]?.status, "unavailable");
  assert.equal(summarize(replacement).students[0]?.automatic, false);
});

test("off stays visible while removal is pending and expires at the class boundary", () => {
  const cleared = control({ desiredState: { restrictions: { flightPath: { active: false, allowedDomains: [] } } } });
  const off = { ...assignment, status: "off", revision: 2 };
  const pending = summarize(cleared, off);
  assert.equal(pending.automaticFlightPath.status, "off");
  assert.equal(pending.summary.pending, 1);
  assert.equal(summarize({ ...cleared, enforcementHealth: "synced", appliedRevision: 4, lastAcknowledgedAt: now }, off).summary.off, 1);
  const expired = summarize(control(), assignment, deadline);
  assert.equal(expired.automaticFlightPath.status, "inactive");
  assert.equal(expired.students[0]?.status, "off");
  assert.equal(expired.students[0]?.automatic, false);
});

test("unconfigured classes get no automatic badges and private provenance is excluded from the DTO", () => {
  assert.deepEqual(summarize(control(), null).students, []);
  const dto = JSON.stringify(summarize(control()));
  for (const privateKey of ["payload", "assignmentId", "eligibleStudentIds", "manualOverrideStudentIds", "deviceId", "studentSessionId"])
    assert.equal(dto.includes(`"${privateKey}"`), false, privateKey);
});
