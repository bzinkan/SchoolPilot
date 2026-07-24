import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeTransactionalPlanScenariosLifecycleEvent } from "../src/cli/checkClasspilotTileAuthorizationPlans.ts";

function validLifecycle() {
  return {
    version: "transactional-plan-scenarios-v1",
    seededRows: {
      groupTeachers: 1,
      teachingSessions: 1,
      supervisionContexts: 1,
      supervisionStudents: 40,
      total: 43,
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
      /school|staff|teacherId|studentId|deviceId|SELECT|INSERT/i
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
        total: 2,
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
      { ...validLifecycle(), staffId: "staff-secret" },
      { ...validLifecycle(), rawSql: "INSERT INTO secret" },
      {
        ...validLifecycle(),
        seededRows: {
          ...validLifecycle().seededRows,
          supervisionStudents: 41,
          total: 44,
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
});
