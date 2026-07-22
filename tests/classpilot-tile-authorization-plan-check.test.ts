import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { parseClasspilotTilePlanCliArgs } from "../src/cli/checkClasspilotTileAuthorizationPlans.ts";
import {
  assertClasspilotHistoryFallbackPiStatementDiscoverable,
  CLASSPILOT_HISTORY_FALLBACK_PI_STATEMENT_PREVIEW_CHARACTERS,
  CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
  createClasspilotHistoryFallbackQueryIdentifierSha256,
  createClasspilotHistoryFallbackSchemaIdentitySha256,
  createClasspilotHistoryFallbackSqlShapeIdentity,
  parseClasspilotHistoryFallbackQueryIdentifier,
  requireStableClasspilotHistoryFallbackQueryIdentifier,
  requireStableClasspilotHistoryFallbackSchemaIdentity,
} from "../src/services/classpilotHistoryFallbackSqlIdentity.ts";
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

const PLAN_CONTROL_QUERIES = new Set([
  "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY",
  "COMMIT",
  "ROLLBACK",
  "SELECT set_config('statement_timeout', $1, true)",
  "SELECT set_config('lock_timeout', $1, true)",
  "SELECT set_config('app.is_super', 'on', true)",
  "SELECT set_config('app.is_super', 'off', true)",
  "SELECT set_config('app.school_id', $1, true)",
]);

function createQueryIdGateHarness(options: {
  settingRows?: Record<string, unknown>[];
  identityExplainRows?: Record<string, unknown>[][];
} = {}) {
  const schoolId = "school-sensitive-fixture";
  const studentIds = Array.from(
    { length: 40 },
    (_, index) => `student-sensitive-${index + 1}`
  );
  const deviceIds = studentIds.map(
    (_, index) => `device-sensitive-${index + 1}`
  );
  const settingRows = options.settingRows ?? [{ compute_query_id: "auto" }];
  const identityExplainRows = options.identityExplainRows ?? [
    [
      { "QUERY PLAN": "Result" },
      { "QUERY PLAN": "Query Identifier: -9223372036854775808" },
    ],
    [
      { "QUERY PLAN": "Result" },
      { "QUERY PLAN": "Query Identifier: -9223372036854775808" },
    ],
  ];
  let discoveryCalls = 0;
  let settingCalls = 0;
  let identityExplainCalls = 0;
  let computeQueryIdMutationAttempts = 0;

  const client = {
    async query(text: string, values?: readonly unknown[]) {
      if (text.includes("set_config('compute_query_id'")) {
        computeQueryIdMutationAttempts += 1;
        throw new Error("permission_denied");
      }
      if (PLAN_CONTROL_QUERIES.has(text)) return { rows: [] };
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
        return {
          rows: studentIds.map((studentId, index) => ({
            school_id: schoolId,
            student_id: studentId,
            device_id: deviceIds[index],
          })),
        };
      }
      if (
        text ===
        "SELECT current_setting('compute_query_id', true) AS compute_query_id"
      ) {
        settingCalls += 1;
        return { rows: settingRows };
      }
      if (
        text.includes("heartbeats_column_signature") &&
        text.includes("pg_get_indexdef")
      ) {
        return {
          rows: [
            {
              engine_version: "16.4",
              database_name: "schoolpilot",
              schema_name: "public",
              search_path: '"$user", public',
              track_io_timing: "on",
              heartbeats_relation_oid: "12345",
              heartbeats_relation_name: "heartbeats",
              heartbeats_column_signature: "1:id:text:true",
              history_index_oid: "12346",
              history_index_name:
                "heartbeats_school_device_student_timestamp_idx",
              history_index_definition:
                "CREATE INDEX heartbeats_school_device_student_timestamp_idx ON public.heartbeats USING btree (school_id, device_id, student_id, timestamp DESC)",
            },
          ],
        };
      }
      if (
        text.startsWith("EXPLAIN (VERBOSE, FORMAT TEXT)") &&
        text.includes("'history_fallback'")
      ) {
        const rows = identityExplainRows[identityExplainCalls] ?? [];
        identityExplainCalls += 1;
        return { rows };
      }
      if (
        text.startsWith(
          "EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)"
        ) &&
        text.includes("'history_fallback'")
      ) {
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
      throw new Error("unexpected_plan_check_query");
    },
  };

  return {
    client,
    buildQuery: (_options: unknown, accessMode: "live" | "history") =>
      sql.raw(`SELECT 'authorization_${accessMode}' AS marker`),
    buildHistoryQuery: (
      historySchoolId: string,
      accesses: readonly { studentId: string; deviceId: string }[],
      limit: number
    ) => sql`
      SELECT 'history_fallback' AS marker
      WHERE ${sql.param(accesses.map((access) => access.studentId))}::text[] IS NOT NULL
        AND ${sql.param(accesses.map((access) => access.deviceId))}::text[] IS NOT NULL
        AND ${historySchoolId}::text IS NOT NULL
        AND ${limit}::integer > 0
    `,
    getSettingCalls: () => settingCalls,
    getIdentityExplainCalls: () => identityExplainCalls,
    getComputeQueryIdMutationAttempts: () =>
      computeQueryIdMutationAttempts,
  };
}

async function expectHistoryFallbackIdentityFailure(
  promise: Promise<unknown>
): Promise<void> {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof ClasspilotTileAuthorizationPlanCheckError &&
      error.failureCode === "history_fallback_query_identity_invalid"
  );
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

  it("binds the exact SQL shape and parses signed PostgreSQL query identifiers without number coercion", () => {
    const params = [["student"], ["device"], "school", 10] as const;
    const shape = createClasspilotHistoryFallbackSqlShapeIdentity(
      "SELECT $1::text[], $2::text[], $3::text, $4::integer",
      params
    );
    assert.equal(
      shape.version,
      CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION
    );
    assert.match(shape.compiledSqlSha256, /^[a-f0-9]{64}$/);
    assert.match(shape.parameterTypeSignatureSha256, /^[a-f0-9]{64}$/);

    assert.doesNotThrow(() =>
      assertClasspilotHistoryFallbackPiStatementDiscoverable(
        "WITH requested_tiles AS (SELECT 1) SELECT * FROM requested_tiles " +
          "CROSS JOIN LATERAL (SELECT * FROM heartbeats LIMIT 10) AS heartbeat"
      )
    );
    assert.throws(
      () =>
        assertClasspilotHistoryFallbackPiStatementDiscoverable(
          `${" ".repeat(
            CLASSPILOT_HISTORY_FALLBACK_PI_STATEMENT_PREVIEW_CHARACTERS
          )} requested_tiles heartbeats lateral`
        ),
      /history_fallback_query_identity_invalid/
    );

    for (const identifier of [
      "1",
      "9223372036854775807",
      "-9223372036854775808",
    ]) {
      assert.equal(
        parseClasspilotHistoryFallbackQueryIdentifier([
          { "QUERY PLAN": "Nested Loop" },
          { "QUERY PLAN": `Query Identifier: ${identifier}` },
        ]),
        identifier
      );
      assert.match(
        createClasspilotHistoryFallbackQueryIdentifierSha256(identifier),
        /^[a-f0-9]{64}$/
      );
    }

    for (const rows of [
      [] as Record<string, unknown>[],
      [{ "QUERY PLAN": "Query Identifier: 0" }],
      [{ "QUERY PLAN": "Query Identifier: 01" }],
      [{ "QUERY PLAN": "Query Identifier: +1" }],
      [{ "QUERY PLAN": "Query Identifier: 9223372036854775808" }],
      [
        { "QUERY PLAN": "Query Identifier: 1" },
        { "QUERY PLAN": "Query Identifier: 1" },
      ],
    ]) {
      assert.throws(
        () => parseClasspilotHistoryFallbackQueryIdentifier(rows),
        /history_fallback_query_identity_invalid/
      );
    }
    assert.throws(
      () =>
        createClasspilotHistoryFallbackSqlShapeIdentity("SELECT $1", [
          ["student"],
        ]),
      /history_fallback_query_identity_invalid/
    );
    assert.equal(
      requireStableClasspilotHistoryFallbackQueryIdentifier("-1", "-1"),
      "-1"
    );
    assert.throws(
      () => requireStableClasspilotHistoryFallbackQueryIdentifier("-1", "1"),
      /history_fallback_query_identity_invalid/
    );
    const stableSchema = {
      engineVersion: "16.4",
      schemaIdentitySha256: "a".repeat(64),
      trackIoTiming: true as const,
    };
    assert.deepEqual(
      requireStableClasspilotHistoryFallbackSchemaIdentity(
        stableSchema,
        stableSchema
      ),
      stableSchema
    );
    assert.throws(
      () =>
        requireStableClasspilotHistoryFallbackSchemaIdentity(stableSchema, {
          ...stableSchema,
          schemaIdentitySha256: "b".repeat(64),
        }),
      /history_fallback_query_identity_invalid/
    );
    assert.throws(
      () =>
        requireStableClasspilotHistoryFallbackSchemaIdentity(stableSchema, {
          ...stableSchema,
          trackIoTiming: false,
        } as never),
      /history_fallback_query_identity_invalid/
    );
  });

  it("accepts read-only auto and on query-ID modes without attempting a privileged mutation", async () => {
    for (const setting of ["auto", "on"] as const) {
      const harness = createQueryIdGateHarness({
        settingRows: [{ compute_query_id: setting }],
      });
      const report = await runClasspilotTileAuthorizationPlanCheck({
        client: harness.client,
        buildQuery: harness.buildQuery,
        buildHistoryQuery: harness.buildHistoryQuery,
      });
      assert.equal(report.status, "passed");
      assert.equal(harness.getSettingCalls(), 1);
      assert.equal(harness.getIdentityExplainCalls(), 2);
      assert.equal(harness.getComputeQueryIdMutationAttempts(), 0);
    }
  });

  it("fails closed for missing, malformed, off, or regress query-ID modes", async () => {
    for (const settingRows of [
      [] as Record<string, unknown>[],
      [{}],
      [{ compute_query_id: null }],
      [{ compute_query_id: "off" }],
      [{ compute_query_id: "regress" }],
      [{ compute_query_id: "ON" }],
    ]) {
      const harness = createQueryIdGateHarness({ settingRows });
      await expectHistoryFallbackIdentityFailure(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
        })
      );
      assert.equal(harness.getSettingCalls(), 1);
      assert.equal(harness.getIdentityExplainCalls(), 0);
      assert.equal(harness.getComputeQueryIdMutationAttempts(), 0);
    }
  });

  it("fails closed when auto mode does not produce two identical nonzero query identifiers", async () => {
    const cases: Record<string, unknown>[][][] = [
      [
        [{ "QUERY PLAN": "Result" }],
        [{ "QUERY PLAN": "Query Identifier: -1" }],
      ],
      [
        [{ "QUERY PLAN": "Query Identifier: 0" }],
        [{ "QUERY PLAN": "Query Identifier: 0" }],
      ],
      [
        [
          { "QUERY PLAN": "Query Identifier: -1" },
          { "QUERY PLAN": "Query Identifier: 1" },
        ],
        [{ "QUERY PLAN": "Query Identifier: -1" }],
      ],
      [
        [{ "QUERY PLAN": "Query Identifier: -1" }],
        [{ "QUERY PLAN": "Query Identifier: 1" }],
      ],
    ];

    for (const identityExplainRows of cases) {
      const harness = createQueryIdGateHarness({ identityExplainRows });
      await expectHistoryFallbackIdentityFailure(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
        })
      );
      assert.equal(harness.getComputeQueryIdMutationAttempts(), 0);
    }
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
    let historyIdentityExplainCalls = 0;
    let historySchemaIdentityCalls = 0;
    let computeQueryIdSettingCalls = 0;
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
          text ===
          "SELECT current_setting('compute_query_id', true) AS compute_query_id"
        ) {
          computeQueryIdSettingCalls += 1;
          return { rows: [{ compute_query_id: "auto" }] };
        }
        if (text.includes("heartbeats_column_signature") &&
            text.includes("pg_get_indexdef")) {
          historySchemaIdentityCalls += 1;
          return {
            rows: [{
              engine_version: "16.4",
              database_name: "schoolpilot",
              schema_name: "public",
              search_path: '"$user", public',
              track_io_timing: "on",
              heartbeats_relation_oid: "12345",
              heartbeats_relation_name: "heartbeats",
              heartbeats_column_signature: "1:id:text:true",
              history_index_oid: "12346",
              history_index_name:
                "heartbeats_school_device_student_timestamp_idx",
              history_index_definition:
                "CREATE INDEX heartbeats_school_device_student_timestamp_idx ON public.heartbeats USING btree (school_id, device_id, student_id, timestamp DESC)",
            }],
          };
        }
        if (
          text.startsWith("EXPLAIN (VERBOSE, FORMAT TEXT)") &&
          text.includes("'history_fallback'")
        ) {
          historyIdentityExplainCalls += 1;
          return {
            rows: [
              { "QUERY PLAN": "Result" },
              { "QUERY PLAN": "Query Identifier: -9223372036854775808" },
            ],
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
        if (
          text ===
            "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY" ||
          text === "COMMIT" ||
          text === "ROLLBACK" ||
          text === "SELECT set_config('statement_timeout', $1, true)" ||
          text === "SELECT set_config('lock_timeout', $1, true)" ||
          text === "SELECT set_config('app.is_super', 'on', true)" ||
          text === "SELECT set_config('app.is_super', 'off', true)" ||
          text === "SELECT set_config('app.school_id', $1, true)"
        ) {
          return { rows: [] };
        }
        throw new Error("unexpected_plan_check_query");
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
        return sql`
          SELECT 'history_fallback' AS marker
          WHERE ${sql.param(accesses.map((access) => access.studentId))}::text[] IS NOT NULL
            AND ${sql.param(accesses.map((access) => access.deviceId))}::text[] IS NOT NULL
            AND ${historySchoolId}::text IS NOT NULL
            AND ${limit}::integer > 0
        `;
      },
    });

    assert.equal(discoveryCalls, 6);
    assert.equal(authorizationResultCalls, 1);
    assert.equal(historyBuilderCalls, 1);
    assert.equal(historyExplainCalls, 22);
    assert.equal(historyIdentityExplainCalls, 2);
    assert.equal(historySchemaIdentityCalls, 2);
    assert.equal(computeQueryIdSettingCalls, 1);
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
    assert.deepEqual(report.historyFallbackSqlIdentity, {
      version: "history-fallback-queryid-v1",
      queryIdentifier: "-9223372036854775808",
      queryIdentifierSha256:
        createClasspilotHistoryFallbackQueryIdentifierSha256(
          "-9223372036854775808"
        ),
      compiledSqlSha256:
        report.historyFallbackSqlIdentity.compiledSqlSha256,
      parameterTypeSignatureSha256:
        report.historyFallbackSqlIdentity.parameterTypeSignatureSha256,
      engineVersion: "16.4",
      schemaIdentitySha256:
        createClasspilotHistoryFallbackSchemaIdentitySha256({
          trackIoTiming: true,
          engineVersion: "16.4",
          databaseName: "schoolpilot",
          schemaName: "public",
          searchPath: '"$user", public',
          heartbeatsRelationOid: "12345",
          heartbeatsRelationName: "heartbeats",
          heartbeatsColumnSignature: "1:id:text:true",
          historyIndexOid: "12346",
          historyIndexName:
            "heartbeats_school_device_student_timestamp_idx",
          historyIndexDefinition:
            "CREATE INDEX heartbeats_school_device_student_timestamp_idx ON public.heartbeats USING btree (school_id, device_id, student_id, timestamp DESC)",
        }),
      trackIoTiming: true,
    });
    assert.match(
      report.historyFallbackSqlIdentity.compiledSqlSha256,
      /^[a-f0-9]{64}$/
    );
    assert.match(
      report.historyFallbackSqlIdentity.parameterTypeSignatureSha256,
      /^[a-f0-9]{64}$/
    );
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
    assert.match(
      service,
      /current_setting\('compute_query_id', true\) AS compute_query_id/
    );
    assert.doesNotMatch(service, /set_config\('compute_query_id'/);
    assert.match(service, /current_setting\('track_io_timing'\)/);
    assert.match(service, /EXPLAIN \(ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON\)/);
    assert.match(service, /EXPLAIN \(VERBOSE, FORMAT TEXT\)/);
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
