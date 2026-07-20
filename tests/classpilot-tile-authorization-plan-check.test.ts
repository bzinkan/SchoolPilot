import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { parseClasspilotTilePlanCliArgs } from "../src/cli/checkClasspilotTileAuthorizationPlans.ts";
import {
  ClasspilotTileAuthorizationPlanCheckError,
  inspectClasspilotTileExplainDocument,
  summarizeClasspilotTilePlanScenario,
} from "../src/services/classpilotTileAuthorizationPlanCheck.ts";

function sample(overrides: Partial<{
  executionMs: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  subPlanNodes: number;
}> = {}) {
  return {
    executionMs: 10,
    tempReadBlocks: 0,
    tempWrittenBlocks: 0,
    subPlanNodes: 0,
    ...overrides,
  };
}

describe("ClassPilot tile authorization plan checker", () => {
  it("requires explicit execution and at least twenty measured samples", () => {
    assert.deepEqual(parseClasspilotTilePlanCliArgs(["--execute"]), {
      execute: true,
      help: false,
      samples: 20,
    });
    assert.deepEqual(
      parseClasspilotTilePlanCliArgs(["--execute", "--samples", "30"]),
      { execute: true, help: false, samples: 30 }
    );
    assert.throws(
      () => parseClasspilotTilePlanCliArgs(["--samples", "19"]),
      /invalid_arguments/
    );
    assert.throws(
      () => parseClasspilotTilePlanCliArgs(["--unknown"]),
      /invalid_arguments/
    );
  });

  it("extracts timing and rejects temporary IO or any SubPlan node", () => {
    const evidence = inspectClasspilotTileExplainDocument([
      {
        Plan: {
          "Node Type": "Nested Loop",
          "Temp Read Blocks": 2,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Parent Relationship": "SubPlan",
              "Subplan Name": "SubPlan 1",
              "Temp Written Blocks": 3,
            },
          ],
        },
        "Execution Time": 12.3456,
      },
    ]);
    assert.deepEqual(evidence, {
      executionMs: 12.3456,
      tempReadBlocks: 2,
      tempWrittenBlocks: 3,
      subPlanNodes: 1,
    });
    assert.throws(
      () => inspectClasspilotTileExplainDocument("not-json"),
      (error) =>
        error instanceof ClasspilotTileAuthorizationPlanCheckError &&
        error.failureCode === "invalid_explain_document"
    );

    const materializedCte = inspectClasspilotTileExplainDocument([
      {
        Plan: {
          "Node Type": "Result",
          Plans: [
            {
              "Node Type": "Values Scan",
              "Parent Relationship": "InitPlan",
              "Subplan Name": "CTE requested_students",
            },
          ],
        },
        "Execution Time": 1,
      },
    ]);
    assert.equal(materializedCte.subPlanNodes, 0);
  });

  it("applies the fixed p95, maximum, temp-file, and SubPlan gates", () => {
    const passing = Array.from({ length: 20 }, (_, index) =>
      sample({ executionMs: index + 1 })
    );
    assert.deepEqual(
      summarizeClasspilotTilePlanScenario("teacher.live", 40, passing),
      {
        label: "teacher.live",
        cohortSize: 40,
        samples: 20,
        p95Ms: 19,
        maxMs: 20,
        tempReadBlocks: 0,
        tempWrittenBlocks: 0,
        subPlanNodes: 0,
        passed: true,
      }
    );

    const slow = passing.map((entry) => ({ ...entry }));
    slow[18] = sample({ executionMs: 51 });
    slow[19] = sample({ executionMs: 101 });
    assert.equal(
      summarizeClasspilotTilePlanScenario("teacher.history", 40, slow).passed,
      false
    );
    const temp = passing.map((entry) => ({ ...entry }));
    temp[0] = sample({ tempWrittenBlocks: 1 });
    assert.equal(
      summarizeClasspilotTilePlanScenario("office_staff.live", 40, temp).passed,
      false
    );
  });

  it("keeps discovery and EXPLAIN guarded, tenant-scoped, and sanitized", () => {
    const service = readFileSync(
      new URL("../src/services/classpilotTileAuthorizationPlanCheck.ts", import.meta.url),
      "utf8"
    );
    const cli = readFileSync(
      new URL("../src/cli/checkClasspilotTileAuthorizationPlans.ts", import.meta.url),
      "utf8"
    );
    assert.match(service, /BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY/);
    assert.match(service, /set_config\('app\.is_super', 'on', true\)/);
    assert.match(service, /set_config\('app\.is_super', 'off', true\)/);
    assert.match(service, /set_config\('app\.school_id', \$1, true\)/);
    assert.match(service, /EXPLAIN \(ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON\)/);
    assert.match(service, /session\.school_id IS NULL/);
    assert.match(service, /class_group\.id IS NULL/);
    assert.match(service, /session\.school_id IS DISTINCT FROM class_group\.school_id/);
    assert.equal(
      service.match(/INNER JOIN school_memberships AS staff_membership/g)?.length,
      3
    );
    assert.equal(
      service.match(/staff_membership\.role = 'teacher'/g)?.length,
      2
    );
    assert.equal(
      service.match(/staff_membership\.role = 'office_staff'/g)?.length,
      1
    );
    assert.equal(
      service.match(/staff_membership\.status = 'active'/g)?.length,
      3
    );
    assert.match(service, /staff_membership\.school_id = class_group\.school_id/);
    assert.match(service, /staff_membership\.school_id = context\.school_id/);
    for (const label of [
      "teacher.live",
      "teacher.history",
      "co_teacher.live",
      "co_teacher.history",
      "office_staff.live",
      "office_staff.history",
    ]) {
      assert.match(service, new RegExp(`"${label.replace(".", "\\.")}"`));
    }
    assert.doesNotMatch(cli, /error\.message|error\.stack|schoolId|staffId|studentIds/);
  });
});
