import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { parseClasspilotTilePlanCliArgs } from "../src/cli/checkClasspilotTileAuthorizationPlans.ts";
import {
  ClasspilotTileAuthorizationPlanCheckError,
  inspectClasspilotTileExplainDocument,
  inspectClasspilotTileHistoryFallbackExplainDocument,
  runClasspilotTileAuthorizationPlanCheck,
  summarizeClasspilotTileHistoryFallbackPlan,
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

function historySample(overrides: Partial<{
  executionMs: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  subPlanNodes: number;
  windowAggNodes: number;
  heartbeatSequentialScanNodes: number;
  returnedRows: number;
  perPairIndexLimit: boolean;
}> = {}) {
  return {
    ...sample(),
    windowAggNodes: 0,
    heartbeatSequentialScanNodes: 0,
    returnedRows: 400,
    perPairIndexLimit: true,
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

  it("requires the per-pair composite-index Limit for the exact history fallback", () => {
    const evidence = inspectClasspilotTileHistoryFallbackExplainDocument([
      {
        Plan: {
          "Node Type": "Nested Loop",
          "Actual Rows": 400,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "CTE Scan",
              "CTE Name": "requested_tiles",
              "Actual Rows": 40,
              "Actual Loops": 1,
            },
            {
              "Node Type": "Limit",
              "Plan Rows": 10,
              "Actual Rows": 10,
              "Actual Loops": 40,
              Plans: [
                {
                  "Node Type": "Index Scan",
                  "Relation Name": "heartbeats",
                  "Index Name": "heartbeats_school_device_student_timestamp_idx",
                  "Actual Rows": 10,
                  "Actual Loops": 40,
                },
              ],
            },
          ],
        },
        "Execution Time": 12.345,
      },
    ]);
    assert.deepEqual(evidence, {
      executionMs: 12.345,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      returnedRows: 400,
      perPairIndexLimit: true,
    });

    const forbidden = inspectClasspilotTileHistoryFallbackExplainDocument([
      {
        Plan: {
          "Node Type": "WindowAgg",
          "Actual Rows": 401,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "heartbeats",
              "Actual Rows": 401,
              "Actual Loops": 1,
            },
          ],
        },
        "Execution Time": 1,
      },
    ]);
    assert.equal(forbidden.windowAggNodes, 1);
    assert.equal(forbidden.heartbeatSequentialScanNodes, 1);
    assert.equal(forbidden.returnedRows, 401);
    assert.equal(forbidden.perPairIndexLimit, false);
  });

  it("fails history fallback evidence for slow, unbounded, spilling, or oversized plans", () => {
    const passing = Array.from({ length: 20 }, (_, index) =>
      historySample({ executionMs: index + 1 })
    );
    assert.deepEqual(summarizeClasspilotTileHistoryFallbackPlan(40, 10, passing), {
      label: "history_fallback",
      cohortSize: 40,
      historyLimit: 10,
      samples: 20,
      p95Ms: 19,
      maxMs: 20,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxReturnedRows: 400,
      perPairIndexLimit: true,
      passed: true,
    });

    for (const rejected of [
      historySample({ executionMs: 101 }),
      historySample({ tempWrittenBlocks: 1 }),
      historySample({ subPlanNodes: 1 }),
      historySample({ windowAggNodes: 1 }),
      historySample({ heartbeatSequentialScanNodes: 1 }),
      historySample({ returnedRows: 401 }),
      historySample({ perPairIndexLimit: false }),
    ]) {
      const samples = passing.map((entry) => ({ ...entry }));
      samples[19] = rejected;
      assert.equal(
        summarizeClasspilotTileHistoryFallbackPlan(40, 10, samples).passed,
        false
      );
    }
  });

  it("orchestrates the retained authorization scenarios and one exact history fallback cohort", async () => {
    const schoolId = "school-sensitive-fixture";
    const studentIds = Array.from(
      { length: 40 },
      (_, index) => `student-sensitive-${index + 1}`
    );
    const deviceIds = studentIds.map(
      (_, index) => `device-sensitive-${index + 1}`
    );
    let discoveryCalls = 0;
    let authorizationResultCalls = 0;
    let historyExplainCalls = 0;
    let historyBuilderCalls = 0;
    let capturedHistoryCohort:
      | {
          schoolId: string;
          studentIds: string[];
          deviceIds: string[];
          limit: number;
        }
      | undefined;

    const client = {
      async query(text: string, values?: readonly unknown[]) {
        if (text.includes("count(*)::integer AS invalid_count")) {
          return { rows: [{ invalid_count: 0 }] };
        }
        if (text.includes("array_agg(student_id ORDER BY student_rank)")) {
          discoveryCalls += 1;
          assert.deepEqual(values, [40]);
          return {
            rows: [
              {
                school_id: schoolId,
                staff_id: `staff-sensitive-${discoveryCalls}`,
                student_ids: studentIds,
              },
            ],
          };
        }
        if (text === "SELECT 'authorization_history' AS marker") {
          authorizationResultCalls += 1;
          return {
            rows: studentIds.map((studentId, index) => ({
              school_id: schoolId,
              student_id: studentId,
              device_id: deviceIds[index],
            })),
          };
        }
        if (
          text.startsWith(
            "EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)"
          ) &&
          text.includes("'history_fallback'")
        ) {
          historyExplainCalls += 1;
          return {
            rows: [
              {
                "QUERY PLAN": [
                  {
                    Plan: {
                      "Node Type": "Nested Loop",
                      "Actual Rows": 400,
                      "Actual Loops": 1,
                      Plans: [
                        {
                          "Node Type": "Values Scan",
                          "Actual Rows": 40,
                          "Actual Loops": 1,
                        },
                        {
                          "Node Type": "Limit",
                          "Plan Rows": 10,
                          "Actual Rows": 10,
                          "Actual Loops": 40,
                          Plans: [
                            {
                              "Node Type": "Index Scan",
                              "Relation Name": "heartbeats",
                              "Index Name":
                                "heartbeats_school_device_student_timestamp_idx",
                              "Actual Rows": 10,
                              "Actual Loops": 40,
                            },
                          ],
                        },
                      ],
                    },
                    "Execution Time": 10,
                  },
                ],
              },
            ],
          };
        }
        if (
          text.startsWith(
            "EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)"
          )
        ) {
          return {
            rows: [
              {
                "QUERY PLAN": [
                  {
                    Plan: { "Node Type": "Result" },
                    "Execution Time": 10,
                  },
                ],
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const report = await runClasspilotTileAuthorizationPlanCheck({
      client,
      buildQuery: (_options, accessMode) =>
        sql.raw(`SELECT 'authorization_${accessMode}' AS marker`),
      buildHistoryQuery: (historySchoolId, accesses, limit) => {
        historyBuilderCalls += 1;
        capturedHistoryCohort = {
          schoolId: historySchoolId,
          studentIds: accesses.map((access) => access.studentId),
          deviceIds: accesses.map((access) => access.deviceId),
          limit,
        };
        return sql.raw("SELECT 'history_fallback' AS marker");
      },
    });

    assert.equal(discoveryCalls, 6);
    assert.equal(authorizationResultCalls, 1);
    assert.equal(historyBuilderCalls, 1);
    assert.equal(historyExplainCalls, 22);
    assert.deepEqual(capturedHistoryCohort, {
      schoolId,
      studentIds,
      deviceIds,
      limit: 10,
    });
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.label),
      [
        "teacher.live",
        "teacher.history",
        "co_teacher.live",
        "co_teacher.history",
        "office_staff.live",
        "office_staff.history",
      ]
    );
    assert.equal(report.status, "passed");
    assert.equal(report.historyFallback.passed, true);
    assert.equal(report.historyFallback.samples, 20);
    assert.equal(report.historyFallback.maxReturnedRows, 400);
    assert.equal(report.historyFallback.perPairIndexLimit, true);
    const serializedReport = JSON.stringify(report);
    assert.doesNotMatch(serializedReport, /sensitive/);
    assert.doesNotMatch(serializedReport, /school_id|student_id|device_id/);
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
    assert.match(service, /heartbeats_school_device_student_timestamp_idx/);
    assert.match(service, /nodeType === "Limit"/);
    assert.match(service, /nodeType === "WindowAgg"/);
    assert.match(service, /node\["Relation Name"\] === "heartbeats"/);
    assert.match(cli, /buildHeartbeatTileHistoryBatchQuery/);
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
