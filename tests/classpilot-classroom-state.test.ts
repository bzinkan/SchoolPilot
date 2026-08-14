import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyClasspilotControlCommand,
  emptyClasspilotRestrictions,
  effectiveClasspilotControlEnforcementHealth,
  normalizeClasspilotRestrictions,
  serializeClasspilotStudentControlState,
} from "../src/services/classpilotClassroomState.js";
import type { ClasspilotStudentControlState } from "../src/schema/classpilot.js";

function controlState(overrides: Partial<ClasspilotStudentControlState> = {}): ClasspilotStudentControlState {
  const now = new Date("2026-08-13T12:00:00.000Z");
  return {
    id: "control-1",
    schoolId: "school-1",
    studentId: "student-1",
    teachingSessionId: null,
    supervisionContextId: "coverage-1",
    revision: 8,
    desiredState: { restrictions: emptyClasspilotRestrictions() },
    sourceCommandId: null,
    scheduledEndAt: new Date(now.getTime() + 60_000),
    hardExpiresAt: new Date(now.getTime() + 120_000),
    enforcementHealth: "synced",
    appliedRevision: 8,
    lastOutcome: "applied",
    lastError: null,
    lastAcknowledgedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("ClassPilot full classroom state", () => {
  it("composes independent controls without losing existing state", () => {
    let state = applyClasspilotControlCommand(emptyClasspilotRestrictions(), "apply-block-list", {
      blockedDomains: ["Example.com"],
      blockListName: "Test",
    });
    state = applyClasspilotControlCommand(state, "attention-mode", { active: true, message: "Eyes up" });
    state = applyClasspilotControlCommand(state, "limit-tabs", { maxTabs: 2 });
    assert.deepEqual(state.blockList, { active: true, blockedDomains: ["example.com"], name: "Test" });
    assert.deepEqual(state.attentionMode, { active: true, message: "Eyes up" });
    assert.equal(state.tabLimit, 2);
  });

  it("screen unlock clears URL lock and Flight Path but retains independent controls", () => {
    const previous = normalizeClasspilotRestrictions({
      screenLock: { active: true, url: "https://example.test" },
      flightPath: { active: true, allowedDomains: ["example.test"] },
      blockList: { active: true, blockedDomains: ["chat.example"] },
      attentionMode: { active: true, message: "Focus" },
      tabLimit: 2,
    });
    const result = applyClasspilotControlCommand(previous, "unlock-screen", {});
    assert.equal(result.screenLock.active, false);
    assert.equal(result.flightPath.active, false);
    assert.equal(result.blockList.active, true);
    assert.equal(result.attentionMode.active, true);
    assert.equal(result.tabLimit, 2);
  });

  it("bounds temporary allows and supplies an expiry", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const result = applyClasspilotControlCommand(emptyClasspilotRestrictions(), "temp-unblock", {
      domain: "Example.com",
      durationMinutes: 5,
    }, now);
    assert.deepEqual(result.temporaryAllows, [{
      domain: "example.com",
      expiresAt: "2026-08-13T12:05:00.000Z",
    }]);
  });

  it("rejects oversized rule lists before applying a partial policy", () => {
    assert.throws(
      () => applyClasspilotControlCommand(emptyClasspilotRestrictions(), "apply-block-list", {
        blockedDomains: Array.from({ length: 1_001 }, (_, index) => `site-${index}.example`),
      }),
      (error: any) => error?.code === "CLASSROOM_RULE_LIMIT_EXCEEDED"
    );
    assert.throws(
      () => normalizeClasspilotRestrictions({
        flightPath: { active: true, allowedDomains: Array(1_001).fill("example.com") },
      }),
      (error: any) => error?.code === "CLASSROOM_RULE_LIMIT_EXCEEDED"
    );
  });

  it("serializes supervision as the exclusive canonical scope", () => {
    const snapshot = serializeClasspilotStudentControlState(controlState());
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.revision, 8);
    assert.equal(snapshot.teachingSessionId, null);
    assert.equal(snapshot.supervisionContextId, "coverage-1");
  });

  it("reports snapshot enforcement unsupported until version 2.6.0", () => {
    const state = controlState();
    const now = new Date("2026-08-13T12:00:00.000Z");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, undefined, now), "unsupported");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, "garbage", now), "unsupported");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, "2.5.99", now), "unsupported");
    assert.equal(effectiveClasspilotControlEnforcementHealth(state, "2.6.0", now), "synced");
  });
});
