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
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE",
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
  baseRows?: Record<string, unknown>[];
  residueRows?: Record<string, unknown>[];
  seedCounts?: Partial<Record<
    | "group_teacher"
    | "teaching_session"
    | "supervision_context"
    | "supervision_students",
    number
  >>;
  failQueryMarker?: string;
  failError?: Error;
  failRollback?: boolean;
  onQuery?: (
    text: string,
    values: readonly unknown[]
  ) => void | Promise<void>;
  advisoryLock?: {
    acquire(): void | Promise<void>;
    release(): void | Promise<void>;
  };
} = {}) {
  const schoolId = "school-sensitive-fixture";
  const studentIds = Array.from(
    { length: 40 },
    (_, index) => `student-sensitive-${index + 1}`
  );
  const officeStudentIds = Array.from(
    { length: 40 },
    (_, index) => `office-student-sensitive-${index + 1}`
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
  let authorizationResultCalls = 0;
  let historyExplainCalls = 0;
  let historySchemaIdentityCalls = 0;
  const queryLog: { text: string; values: readonly unknown[] }[] = [];
  const seedQueries: {
    marker: string;
    values: readonly unknown[];
  }[] = [];
  const seedCounts = {
    group_teacher: 1,
    teaching_session: 1,
    supervision_context: 1,
    supervision_students: 40,
    ...options.seedCounts,
  };
  const defaultBaseRow = {
    school_id: schoolId,
    group_id: "group-sensitive-fixture",
    primary_teacher_id: "primary-teacher-sensitive-fixture",
    co_teacher_id: "co-teacher-sensitive-fixture",
    office_staff_id: "office-staff-sensitive-fixture",
    teacher_student_ids: studentIds,
    office_student_ids: officeStudentIds,
  };

  const client = {
    async query(text: string, values?: readonly unknown[]) {
      const capturedValues = values ?? [];
      queryLog.push({ text, values: capturedValues });
      await options.onQuery?.(text, capturedValues);
      if (options.failQueryMarker && text.includes(options.failQueryMarker)) {
        throw options.failError ?? new Error("injected_plan_check_failure");
      }
      if (text === "ROLLBACK" && options.failRollback) {
        throw new Error("injected_rollback_failure");
      }
      if (text === "ROLLBACK") {
        await options.advisoryLock?.release();
        return { rows: [] };
      }
      if (text.includes("set_config('compute_query_id'")) {
        computeQueryIdMutationAttempts += 1;
        throw new Error("permission_denied");
      }
      if (PLAN_CONTROL_QUERIES.has(text)) return { rows: [] };
      if (
        text ===
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))"
      ) {
        assert.equal(capturedValues.length, 1);
        assert.equal(typeof capturedValues[0], "string");
        await options.advisoryLock?.acquire();
        return { rows: [{}] };
      }
      if (text.includes("count(*)::integer AS invalid_count")) {
        return { rows: [{ invalid_count: 0 }] };
      }
      if (text.includes("/* transactional_plan_base_v1 */")) {
        return { rows: options.baseRows ?? [defaultBaseRow] };
      }
      const seedMarkers = [
        ["transactional_plan_seed_group_teacher_v1", "group_teacher"],
        ["transactional_plan_seed_teaching_session_v1", "teaching_session"],
        [
          "transactional_plan_seed_supervision_context_v1",
          "supervision_context",
        ],
        [
          "transactional_plan_seed_supervision_students_v1",
          "supervision_students",
        ],
      ] as const;
      for (const [marker, countKey] of seedMarkers) {
        if (text.includes(`/* ${marker} */`)) {
          seedQueries.push({ marker, values: capturedValues });
          return { rows: [{ inserted_count: seedCounts[countKey] }] };
        }
      }
      if (text.includes("/* transactional_plan_residue_v1 */")) {
        return { rows: options.residueRows ?? [{ residue_count: 0 }] };
      }
      if (text.includes("array_agg(student_id ORDER BY student_rank)")) {
        discoveryCalls += 1;
        assert.equal(capturedValues[0], 40);
        assert.equal(capturedValues[1], schoolId);
        assert.equal(typeof capturedValues[2], "string");
        assert.ok(Array.isArray(capturedValues[3]));
        assert.equal(capturedValues[3].length, 40);
        const groupTeacherId = seedQueries.find(
          ({ marker }) =>
            marker === "transactional_plan_seed_group_teacher_v1"
        )?.values[0];
        const teachingSessionId = seedQueries.find(
          ({ marker }) =>
            marker === "transactional_plan_seed_teaching_session_v1"
        )?.values[0];
        const supervisionContextId = seedQueries.find(
          ({ marker }) =>
            marker === "transactional_plan_seed_supervision_context_v1"
        )?.values[0];
        if (text.includes("co_teacher.id = $6")) {
          assert.equal(capturedValues.length, 6);
          assert.equal(capturedValues[4], teachingSessionId);
          assert.equal(capturedValues[5], groupTeacherId);
        } else if (text.includes("context.id = $5")) {
          assert.equal(capturedValues.length, 5);
          assert.equal(capturedValues[4], supervisionContextId);
        } else {
          assert.match(text, /session\.id = \$5/);
          assert.equal(capturedValues.length, 5);
          assert.equal(capturedValues[4], teachingSessionId);
        }
        return {
          rows: [
            {
              school_id: capturedValues[1],
              staff_id: capturedValues[2],
              student_ids: capturedValues[3],
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
        settingCalls += 1;
        return { rows: settingRows };
      }
      if (
        text.includes("heartbeats_column_signature") &&
        text.includes("pg_get_indexdef")
      ) {
        historySchemaIdentityCalls += 1;
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
    getDiscoveryCalls: () => discoveryCalls,
    getIdentityExplainCalls: () => identityExplainCalls,
    getComputeQueryIdMutationAttempts: () =>
      computeQueryIdMutationAttempts,
    getAuthorizationResultCalls: () => authorizationResultCalls,
    getHistoryExplainCalls: () => historyExplainCalls,
    getHistorySchemaIdentityCalls: () => historySchemaIdentityCalls,
    getQueryLog: () => [...queryLog],
    getSeedQueries: () => [...seedQueries],
    fixture: {
      schoolId,
      studentIds,
      officeStudentIds,
      deviceIds,
      baseRow: defaultBaseRow,
    },
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

function assertWriteTransactionRolledBackWithoutCommit(
  queryLog: readonly { text: string }[]
): void {
  const writeBegin = queryLog.findIndex(
    ({ text }) =>
      text ===
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE"
  );
  const rollback = queryLog.findIndex(
    ({ text }, index) => index > writeBegin && text === "ROLLBACK"
  );
  assert.ok(writeBegin >= 0, "write transaction did not begin");
  assert.ok(rollback > writeBegin, "write transaction did not roll back");
  assert.equal(
    queryLog
      .slice(writeBegin, rollback)
      .filter(({ text }) => text === "COMMIT").length,
    0,
    "write transaction committed"
  );
}

function assertSanitizedLifecycleEvents(events: readonly unknown[]): void {
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events);
  assert.match(serialized, /transactional-plan-scenarios-v1/);
  assert.doesNotMatch(serialized, /sensitive/);
  assert.doesNotMatch(
    serialized,
    /school_id|student_id|device_id|staff_id|@/i
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
      const lifecycleEvents: unknown[] = [];
      await expectHistoryFallbackIdentityFailure(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
          onLifecycleEvent: (event) => lifecycleEvents.push(event),
        })
      );
      assert.equal(harness.getComputeQueryIdMutationAttempts(), 0);
      assertWriteTransactionRolledBackWithoutCommit(harness.getQueryLog());
      assertSanitizedLifecycleEvents(lifecycleEvents);
    }
  });

  it("fails closed for missing or ambiguous owned synthetic base fixtures", async () => {
    const canonical = createQueryIdGateHarness();
    const cases = [
      [] as Record<string, unknown>[],
      [
        canonical.fixture.baseRow,
        {
          ...canonical.fixture.baseRow,
          group_id: "second-sensitive-fixture-group",
        },
      ],
    ];

    for (const baseRows of cases) {
      const harness = createQueryIdGateHarness({ baseRows });
      const lifecycleEvents: unknown[] = [];
      await assert.rejects(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
          onLifecycleEvent: (event) => lifecycleEvents.push(event),
        }),
        (error) => error instanceof ClasspilotTileAuthorizationPlanCheckError
      );
      assert.equal(harness.getSeedQueries().length, 0);
      assertWriteTransactionRolledBackWithoutCommit(harness.getQueryLog());
      assertSanitizedLifecycleEvents(lifecycleEvents);
    }
  });

  it("rejects incomplete, overlapping, or cross-school-conflicted synthetic bases", async () => {
    const canonical = createQueryIdGateHarness();
    const base = canonical.fixture.baseRow;
    const cases: Record<string, unknown>[][] = [
      [
        {
          ...base,
          teacher_student_ids:
            canonical.fixture.studentIds.slice(0, 39),
        },
      ],
      [
        {
          ...base,
          office_student_ids: [...canonical.fixture.studentIds],
        },
      ],
      [
        base,
        {
          ...base,
          school_id: "cross-school-sensitive-fixture",
          group_id: "cross-school-sensitive-group",
        },
      ],
    ];

    for (const baseRows of cases) {
      const harness = createQueryIdGateHarness({ baseRows });
      await assert.rejects(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
        }),
        (error) => error instanceof ClasspilotTileAuthorizationPlanCheckError
      );
      assert.equal(harness.getSeedQueries().length, 0);
      assertWriteTransactionRolledBackWithoutCommit(harness.getQueryLog());
    }
  });

  it("requires the exact one, one, one, forty seed cardinalities and never commits a failed seed", async () => {
    const cases = [
      { group_teacher: 0 },
      { teaching_session: 0 },
      { supervision_context: 0 },
      { supervision_students: 39 },
      { supervision_students: 41 },
    ] as const;

    for (const seedCounts of cases) {
      const harness = createQueryIdGateHarness({ seedCounts });
      const lifecycleEvents: unknown[] = [];
      await assert.rejects(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
          onLifecycleEvent: (event) => lifecycleEvents.push(event),
        }),
        (error) => error instanceof ClasspilotTileAuthorizationPlanCheckError
      );
      const queryLog = harness.getQueryLog();
      assertWriteTransactionRolledBackWithoutCommit(queryLog);
      assertSanitizedLifecycleEvents(lifecycleEvents);
    }
  });

  it("stops before measurement when tenant context or seed privileges are denied", async () => {
    for (const failQueryMarker of [
      "SELECT set_config('app.is_super', 'on', true)",
      "/* transactional_plan_seed_group_teacher_v1 */",
    ]) {
      const harness = createQueryIdGateHarness({ failQueryMarker });
      await assert.rejects(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
        })
      );
      const queryLog = harness.getQueryLog();
      assert.equal(
        queryLog.some(({ text }) =>
          text.startsWith(
            "EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)"
          )
        ),
        false
      );
      assertWriteTransactionRolledBackWithoutCommit(queryLog);
    }
  });

  it("fails closed when rollback cannot be proven and emits sanitized incomplete lifecycle evidence", async () => {
    const harness = createQueryIdGateHarness({ failRollback: true });
    const lifecycleEvents: unknown[] = [];
    await assert.rejects(
      runClasspilotTileAuthorizationPlanCheck({
        client: harness.client,
        buildQuery: harness.buildQuery,
        buildHistoryQuery: harness.buildHistoryQuery,
        onLifecycleEvent: (event) => lifecycleEvents.push(event),
      }),
      (error) => error instanceof ClasspilotTileAuthorizationPlanCheckError
    );
    const queryLog = harness.getQueryLog();
    assert.equal(
      queryLog.filter(({ text }) => text === "ROLLBACK").length,
      1
    );
    assert.equal(
      queryLog.filter(({ text }) =>
        text.includes("/* transactional_plan_residue_v1 */")
      ).length,
      0
    );
    assert.equal(
      queryLog.filter(({ text }) => text === "COMMIT").length,
      0
    );
    assertSanitizedLifecycleEvents(lifecycleEvents);
    assert.deepEqual(
      (lifecycleEvents[0] as { rollback: unknown; residue: unknown }),
      {
        ...(lifecycleEvents[0] as Record<string, unknown>),
        rollback: { attempted: true, completed: false },
        residue: { checked: false, count: null, passed: false },
      }
    );
  });

  it("rolls back seeded rows when an authorization EXPLAIN fails", async () => {
    const harness = createQueryIdGateHarness({
      failQueryMarker:
        "EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)",
    });
    const lifecycleEvents: unknown[] = [];
    await assert.rejects(
      runClasspilotTileAuthorizationPlanCheck({
        client: harness.client,
        buildQuery: harness.buildQuery,
        buildHistoryQuery: harness.buildHistoryQuery,
        onLifecycleEvent: (event) => lifecycleEvents.push(event),
      })
    );
    const queryLog = harness.getQueryLog();
    assert.equal(harness.getSeedQueries().length, 4);
    assertWriteTransactionRolledBackWithoutCommit(queryLog);
    assertSanitizedLifecycleEvents(lifecycleEvents);
  });

  it("fails closed at every transactional phase without committing or emitting success", async () => {
    const phases = [
      "SELECT pg_advisory_xact_lock",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('lock_timeout', $1, true)",
      "SELECT set_config('app.is_super', 'on', true)",
      "count(*)::integer AS invalid_count",
      "/* transactional_plan_base_v1 */",
      "/* transactional_plan_seed_group_teacher_v1 */",
      "/* transactional_plan_seed_teaching_session_v1 */",
      "/* transactional_plan_seed_supervision_context_v1 */",
      "/* transactional_plan_seed_supervision_students_v1 */",
      "array_agg(student_id ORDER BY student_rank)",
      "EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)",
      "SELECT 'authorization_history' AS marker",
      "SELECT current_setting('compute_query_id', true) AS compute_query_id",
      "heartbeats_column_signature",
      "EXPLAIN (VERBOSE, FORMAT TEXT)",
      "/* transactional_plan_residue_v1 */",
    ];

    for (const failQueryMarker of phases) {
      const harness = createQueryIdGateHarness({
        failQueryMarker,
        failError: new Error(
          failQueryMarker.includes("EXPLAIN")
            ? "statement_timeout"
            : "operation_interrupted"
        ),
      });
      const lifecycleEvents: unknown[] = [];
      await assert.rejects(
        runClasspilotTileAuthorizationPlanCheck({
          client: harness.client,
          buildQuery: harness.buildQuery,
          buildHistoryQuery: harness.buildHistoryQuery,
          onLifecycleEvent: (event) => lifecycleEvents.push(event),
        })
      );
      const queryLog = harness.getQueryLog();
      assert.ok(
        queryLog.some(({ text }) => text.includes(failQueryMarker)),
        `phase was not exercised: ${failQueryMarker}`
      );
      assertWriteTransactionRolledBackWithoutCommit(queryLog);
      assertSanitizedLifecycleEvents(lifecycleEvents);
    }
  });

  it("checks zero residue after rollback and fails without a passing report when residue remains", async () => {
    const harness = createQueryIdGateHarness({
      residueRows: [{ residue_count: 1 }],
    });
    const lifecycleEvents: unknown[] = [];
    await assert.rejects(
      runClasspilotTileAuthorizationPlanCheck({
        client: harness.client,
        buildQuery: harness.buildQuery,
        buildHistoryQuery: harness.buildHistoryQuery,
        onLifecycleEvent: (event) => lifecycleEvents.push(event),
      }),
      (error) => error instanceof ClasspilotTileAuthorizationPlanCheckError
    );
    const queryLog = harness.getQueryLog();
    const rollback = queryLog.findIndex(({ text }) => text === "ROLLBACK");
    const residue = queryLog.findIndex(({ text }) =>
      text.includes("/* transactional_plan_residue_v1 */")
    );
    assert.ok(rollback >= 0);
    assert.ok(residue > rollback);
    assertSanitizedLifecycleEvents(lifecycleEvents);
    assert.deepEqual(
      (lifecycleEvents[0] as { residue: unknown }).residue,
      { checked: true, count: 1, passed: false }
    );
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

  it("self-provisions all six seed-bound scenarios despite ambient live sessions", async () => {
    const harness = createQueryIdGateHarness();
    let historyBuilderCalls = 0;
    let capturedHistoryCohort:
      | {
          schoolId: string;
          studentIds: string[];
          deviceIds: string[];
          limit: number;
        }
      | undefined;
    const terminalOrder: string[] = [];
    let lifecycleEvent: unknown;
    const report = await runClasspilotTileAuthorizationPlanCheck({
      client: harness.client,
      buildQuery: harness.buildQuery,
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
      onLifecycleEvent: (event) => {
        lifecycleEvent = event;
        terminalOrder.push("lifecycle");
      },
    });
    terminalOrder.push("report");

    assert.equal(harness.getDiscoveryCalls(), 6);
    assert.equal(harness.getAuthorizationResultCalls(), 1);
    assert.equal(historyBuilderCalls, 1);
    assert.equal(harness.getHistoryExplainCalls(), 22);
    assert.equal(harness.getIdentityExplainCalls(), 2);
    assert.equal(harness.getHistorySchemaIdentityCalls(), 2);
    assert.equal(harness.getSettingCalls(), 1);
    assert.deepEqual(capturedHistoryCohort, {
      schoolId: harness.fixture.schoolId,
      studentIds: harness.fixture.studentIds,
      deviceIds: harness.fixture.deviceIds,
      limit: 10,
    });
    assert.deepEqual(lifecycleEvent, {
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
    });
    assert.deepEqual(terminalOrder, ["lifecycle", "report"]);

    const seedQueries = harness.getSeedQueries();
    assert.deepEqual(
      seedQueries.map((entry) => entry.marker),
      [
        "transactional_plan_seed_group_teacher_v1",
        "transactional_plan_seed_teaching_session_v1",
        "transactional_plan_seed_supervision_context_v1",
        "transactional_plan_seed_supervision_students_v1",
      ]
    );
    assert.ok(
      seedQueries.every(
        ({ values }) =>
          values.length > 0 &&
          values.every((value) => value !== null && value !== undefined)
      )
    );
    const supervisionStudentSeed = seedQueries[3]?.values ?? [];
    assert.equal(
      supervisionStudentSeed.filter(
        (value) => Array.isArray(value) && value.length === 40
      ).length,
      2
    );

    const queryLog = harness.getQueryLog();
    const writeBegin = queryLog.findIndex(
      ({ text }) =>
        text ===
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE"
    );
    const rollback = queryLog.findIndex(({ text }) => text === "ROLLBACK");
    const residueBegin = queryLog.findIndex(
      ({ text }, index) =>
        index > rollback &&
        text === "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY"
    );
    const residue = queryLog.findIndex(({ text }) =>
      text.includes("/* transactional_plan_residue_v1 */")
    );
    const residueCommit = queryLog.findIndex(
      ({ text }, index) => index > residue && text === "COMMIT"
    );
    assert.ok(writeBegin >= 0);
    assert.ok(rollback > writeBegin);
    assert.equal(
      queryLog
        .slice(writeBegin, rollback)
        .filter(({ text }) => text === "COMMIT").length,
      0
    );
    assert.ok(residueBegin > rollback);
    assert.ok(residue > residueBegin);
    assert.ok(residueCommit > residue);
    assert.equal(
      queryLog.filter(({ text }) => text === "ROLLBACK").length,
      1
    );
    assert.equal(
      queryLog.filter(({ text }) => text === "COMMIT").length,
      1
    );
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
    const serializedReport = JSON.stringify({ report, lifecycleEvent });
    assert.doesNotMatch(serializedReport, /sensitive/);
    assert.doesNotMatch(serializedReport, /school_id|student_id|device_id/);
  });

  it("keeps transient seed rows invisible to an observer and leaves zero rows after rollback", async () => {
    let pendingRows = 0;
    let committedRows = 0;
    let maximumPendingRows = 0;
    const observerReads: number[] = [];
    const markerCounts = new Map([
      ["transactional_plan_seed_group_teacher_v1", 1],
      ["transactional_plan_seed_teaching_session_v1", 1],
      ["transactional_plan_seed_supervision_context_v1", 1],
      ["transactional_plan_seed_supervision_students_v1", 40],
    ]);
    const harness = createQueryIdGateHarness({
      onQuery: (text) => {
        for (const [marker, count] of markerCounts) {
          if (text.includes(marker)) {
            pendingRows += count;
            maximumPendingRows = Math.max(maximumPendingRows, pendingRows);
            // A separate connection sees only committed state while the gate's
            // write transaction can see its own pending rows.
            observerReads.push(committedRows);
          }
        }
        if (text === "ROLLBACK") pendingRows = 0;
        if (text === "COMMIT" && pendingRows > 0) {
          committedRows += pendingRows;
          pendingRows = 0;
        }
      },
    });

    const report = await runClasspilotTileAuthorizationPlanCheck({
      client: harness.client,
      buildQuery: harness.buildQuery,
      buildHistoryQuery: harness.buildHistoryQuery,
    });

    assert.equal(report.status, "passed");
    assert.equal(maximumPendingRows, 43);
    assert.deepEqual(observerReads, [0, 0, 0, 0]);
    assert.equal(pendingRows, 0);
    assert.equal(committedRows, 0);
  });

  it("serializes concurrent gate invocations through the transaction advisory lock", async () => {
    let activeOwner: string | undefined;
    let maxConcurrentOwners = 0;
    const waiters: Array<() => void> = [];
    const events: string[] = [];

    function participant(name: string) {
      let acquired = false;
      return {
        async acquire() {
          events.push(`${name}:requested`);
          while (activeOwner !== undefined) {
            events.push(`${name}:waiting`);
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          activeOwner = name;
          acquired = true;
          maxConcurrentOwners = Math.max(
            maxConcurrentOwners,
            activeOwner === undefined ? 0 : 1
          );
          events.push(`${name}:acquired`);
        },
        release() {
          if (!acquired) return;
          assert.equal(activeOwner, name);
          acquired = false;
          activeOwner = undefined;
          events.push(`${name}:released`);
          waiters.shift()?.();
        },
      };
    }

    const first = createQueryIdGateHarness({
      advisoryLock: participant("first"),
    });
    const second = createQueryIdGateHarness({
      advisoryLock: participant("second"),
    });
    const [firstReport, secondReport] = await Promise.all([
      runClasspilotTileAuthorizationPlanCheck({
        client: first.client,
        buildQuery: first.buildQuery,
        buildHistoryQuery: first.buildHistoryQuery,
      }),
      runClasspilotTileAuthorizationPlanCheck({
        client: second.client,
        buildQuery: second.buildQuery,
        buildHistoryQuery: second.buildHistoryQuery,
      }),
    ]);

    assert.equal(firstReport.status, "passed");
    assert.equal(secondReport.status, "passed");
    assert.equal(maxConcurrentOwners, 1);
    assert.equal(events.filter((event) => event.endsWith(":waiting")).length, 1);
    const firstRelease = events.indexOf("first:released");
    const secondAcquire = events.indexOf("second:acquired");
    assert.ok(
      (firstRelease >= 0 && secondAcquire > firstRelease) ||
        (events.indexOf("second:released") >= 0 &&
          events.indexOf("first:acquired") >
            events.indexOf("second:released"))
    );
  });

  it("keeps rollback-only self-provisioning and EXPLAIN guarded, tenant-scoped, and sanitized", () => {
    const service = readFileSync(
      new URL("../src/services/classpilotTileAuthorizationPlanCheck.ts", import.meta.url),
      "utf8"
    );
    const cli = readFileSync(
      new URL("../src/cli/checkClasspilotTileAuthorizationPlans.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      service,
      /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE/
    );
    assert.match(
      service,
      /SELECT pg_advisory_xact_lock\(hashtextextended\(\$1::text, 0\)\)/
    );
    assert.match(service, /transactional_plan_base_v1/);
    assert.match(
      service,
      /\^synthetic-load-fixture:\(\[a-z0-9\]\[a-z0-9-\]\{2,40\}\):class:\[0-9\]\{2\}\$/
    );
    assert.match(service, /school\.name LIKE '%\[SYNTHETIC LOAD TEST - NON-BILLABLE\]%'/);
    assert.match(service, /existing_co_teacher/);
    assert.doesNotMatch(service, /FROM teaching_sessions AS existing_session/);
    assert.match(service, /WHERE session\.id = \$5/);
    assert.match(service, /AND co_teacher\.id = \$6/);
    assert.match(service, /WHERE context\.id = \$5/);
    assert.match(service, /group_students AS any_roster/);
    assert.match(service, /supervised\.released_at IS NULL/);
    assert.match(service, /transactional_plan_seed_group_teacher_v1/);
    assert.match(service, /transactional_plan_seed_teaching_session_v1/);
    assert.match(service, /transactional_plan_seed_supervision_context_v1/);
    assert.match(service, /transactional_plan_seed_supervision_students_v1/);
    assert.match(service, /transactional_plan_residue_v1/);
    assert.match(
      service,
      /BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY/
    );
    assert.match(service, /transactional-plan-scenarios-v1/);
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
    assert.match(service, /INSERT INTO group_teachers/);
    assert.match(service, /INSERT INTO teaching_sessions/);
    assert.match(service, /INSERT INTO classpilot_supervision_contexts/);
    assert.match(service, /INSERT INTO classpilot_supervision_students/);
    assert.doesNotMatch(service, /\bnextval\s*\(/);
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
