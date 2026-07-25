import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sanitizeClasspilotTileAuthorizationPlanBasePreflight,
  sanitizeTransactionalPlanScenariosLifecycleEvent,
} from "../src/cli/checkClasspilotTileAuthorizationPlans.ts";

function validLifecycle() {
  return {
    version: "transactional-plan-scenarios-v2",
    requiredSessionPairs: 80,
    reusedActiveSessionPairs: 0,
    insertedSessionPairs: 80,
    seededRows: {
      groupTeachers: 1,
      teachingSessions: 1,
      supervisionContexts: 1,
      supervisionStudents: 40,
      studentSessions: 80,
      total: 123,
    },
    rollback: {
      attempted: true,
      completed: true,
    },
    residue: {
      checked: true,
      count: 0,
      passed: true,
    },
  };
}

describe("ClassPilot tile authorization plan lifecycle CLI evidence", () => {
  it("rebuilds the fixed aggregate-only lifecycle contract", () => {
    const sanitized =
      sanitizeTransactionalPlanScenariosLifecycleEvent(validLifecycle());
    assert.deepEqual(sanitized, validLifecycle());
    const serialized = JSON.stringify(sanitized);
    assert.doesNotMatch(
      serialized,
      /schoolId|staffId|teacherId|studentId|deviceId|rawSql|SELECT\s/i
    );
  });

  it("preserves a sanitized failed cleanup status without exposing details", () => {
    const failedLifecycle = {
      ...validLifecycle(),
      seededRows: {
        groupTeachers: 1,
        teachingSessions: 1,
        supervisionContexts: 0,
        supervisionStudents: 0,
        studentSessions: 80,
        total: 82,
      },
      rollback: { attempted: true, completed: false },
      residue: { checked: false, count: null, passed: false },
    };
    assert.deepEqual(
      sanitizeTransactionalPlanScenariosLifecycleEvent(failedLifecycle),
      failedLifecycle
    );
  });

  it("rejects counts, cleanup state, and unexpected identifier or SQL fields", () => {
    const cases = [
      { ...validLifecycle(), version: "transactional-plan-scenarios-v0" },
      { ...validLifecycle(), version: "transactional-plan-scenarios-v1" },
      { ...validLifecycle(), staffId: "staff-secret" },
      { ...validLifecycle(), rawSql: "INSERT INTO secret" },
      {
        ...validLifecycle(),
        seededRows: {
          ...validLifecycle().seededRows,
          supervisionStudents: 41,
          total: 124,
        },
      },
      {
        ...validLifecycle(),
        rollback: { attempted: false, completed: true },
      },
      {
        ...validLifecycle(),
        residue: { checked: false, count: 0, passed: false },
      },
      {
        ...validLifecycle(),
        residue: { checked: true, count: 1, passed: true },
      },
    ];
    for (const event of cases) {
      assert.throws(
        () => sanitizeTransactionalPlanScenariosLifecycleEvent(event),
        /transactional_plan_scenarios_lifecycle_invalid/
      );
    }
  });

  it("rebuilds the aggregate-only base preflight contract", () => {
    const valid = {
      version: "classpilot-tile-auth-plan-base-preflight-v1",
      status: "passed",
      eligibleBases: 1,
      requiredSessionPairs: 80,
      reusedActiveSessionPairs: 25,
      missingSessionPairs: 55,
      conflictingSessionPairs: 0,
    };
    assert.deepEqual(
      sanitizeClasspilotTileAuthorizationPlanBasePreflight(valid),
      valid
    );
    for (const invalid of [
      { ...valid, version: "classpilot-tile-auth-plan-base-preflight-v0" },
      { ...valid, eligibleBases: 2 },
      { ...valid, missingSessionPairs: 54 },
      { ...valid, conflictingSessionPairs: 1 },
      { ...valid, schoolId: "secret" },
    ]) {
      assert.throws(
        () => sanitizeClasspilotTileAuthorizationPlanBasePreflight(invalid),
        /classpilot_tile_auth_plan_base_preflight_invalid/
      );
    }
  });
});
