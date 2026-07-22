import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ClasspilotHistoryFallbackSqlIdentityError,
  CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
  createClasspilotHistoryFallbackQueryIdentifierSha256,
  createClasspilotHistoryFallbackSchemaIdentitySha256,
  createClasspilotHistoryFallbackSqlShapeIdentity,
  parseClasspilotHistoryFallbackQueryIdentifier,
  requireStableClasspilotHistoryFallbackSchemaIdentity,
  requireStableClasspilotHistoryFallbackQueryIdentifier,
  type ClasspilotHistoryFallbackSchemaMetadata,
  type ClasspilotHistoryFallbackSqlShapeIdentity,
} from "./classpilotHistoryFallbackSqlIdentity.js";

export const CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES = 20;
export const CLASSPILOT_TILE_AUTHORIZATION_PLAN_WARMUPS = 2;
export const CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE = 40;
export const CLASSPILOT_TILE_AUTHORIZATION_PLAN_P95_MS = 50;
export const CLASSPILOT_TILE_AUTHORIZATION_PLAN_MAX_MS = 100;
export const CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT = 10;
export const CLASSPILOT_TILE_HISTORY_FALLBACK_MAX_ROWS =
  CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE *
  CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT;
export const CLASSPILOT_TILE_HISTORY_FALLBACK_INDEX =
  "heartbeats_school_device_student_timestamp_idx";

const MAX_SAMPLES = 100;
const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 1_000;

export type ClasspilotTilePlanScenarioLabel =
  | "teacher.live"
  | "teacher.history"
  | "co_teacher.live"
  | "co_teacher.history"
  | "office_staff.live"
  | "office_staff.history";

type ClasspilotTilePlanScenarioKind =
  | "teacher"
  | "co_teacher"
  | "office_staff";

type ClasspilotTilePlanMode = "live" | "history";

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
};

export type ClasspilotTilePlanQueryClient = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
};

export type ClasspilotTileAuthorizationQueryBuilder = (
  options: {
    schoolId: string;
    staffId: string;
    role: "teacher" | "office_staff";
  },
  accessMode: ClasspilotTilePlanMode,
  studentIds: readonly string[]
) => SQL;

export type ClasspilotTileHistoryFallbackAccess = {
  studentId: string;
  deviceId: string;
  schoolId: string;
  studentSessionId: string | null;
};

export type ClasspilotTileHistoryFallbackQueryBuilder = (
  schoolId: string,
  accesses: readonly ClasspilotTileHistoryFallbackAccess[],
  limit: number
) => SQL;

type DiscoveredScenario = {
  label: ClasspilotTilePlanScenarioLabel;
  kind: ClasspilotTilePlanScenarioKind;
  mode: ClasspilotTilePlanMode;
  schoolId: string;
  staffId: string;
  studentIds: string[];
};

export type ClasspilotTilePlanEvidence = {
  executionMs: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  subPlanNodes: number;
};

export type ClasspilotTilePlanScenarioSummary = {
  label: ClasspilotTilePlanScenarioLabel;
  cohortSize: number;
  samples: number;
  p95Ms: number;
  maxMs: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  subPlanNodes: number;
  passed: boolean;
};

export type ClasspilotTileHistoryFallbackPlanEvidence =
  ClasspilotTilePlanEvidence & {
    windowAggNodes: number;
    heartbeatSequentialScanNodes: number;
    returnedRows: number;
    perPairIndexLimit: boolean;
  };

export type ClasspilotTileHistoryFallbackPlanSummary = {
  label: "history_fallback";
  cohortSize: number;
  historyLimit: number;
  samples: number;
  p95Ms: number;
  maxMs: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  subPlanNodes: number;
  windowAggNodes: number;
  heartbeatSequentialScanNodes: number;
  maxReturnedRows: number;
  perPairIndexLimit: boolean;
  passed: boolean;
};

export type ClasspilotTileHistoryFallbackSqlIdentity = {
  version: typeof CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION;
  queryIdentifier: string;
  queryIdentifierSha256: string;
  compiledSqlSha256: string;
  parameterTypeSignatureSha256: string;
  engineVersion: string;
  schemaIdentitySha256: string;
  trackIoTiming: true;
};

export type ClasspilotTileAuthorizationPlanReport = {
  status: "passed" | "failed";
  precheck: {
    invalidTeachingSessionSchools: number;
  };
  samples: number;
  warmups: number;
  cohortSize: number;
  thresholds: {
    p95Ms: number;
    maxMs: number;
    tempReadBlocks: 0;
    tempWrittenBlocks: 0;
    subPlanNodes: 0;
    windowAggNodes: 0;
    heartbeatSequentialScanNodes: 0;
    maxHeartbeatRows: number;
    perPairIndexLimit: true;
  };
  scenarios: ClasspilotTilePlanScenarioSummary[];
  historyFallback: ClasspilotTileHistoryFallbackPlanSummary;
  historyFallbackSqlIdentity: ClasspilotTileHistoryFallbackSqlIdentity;
};

export class ClasspilotTileAuthorizationPlanCheckError extends Error {
  constructor(
    readonly failureCode:
      | "invalid_configuration"
      | "teaching_session_school_integrity_failed"
      | "representative_scenario_missing"
      | "invalid_explain_document"
      | "history_fallback_query_identity_invalid",
    readonly labels: ClasspilotTilePlanScenarioLabel[] = [],
    readonly invalidCount = 0
  ) {
    super(failureCode);
    this.name = "ClasspilotTileAuthorizationPlanCheckError";
  }
}

const SCENARIOS: ReadonlyArray<{
  label: ClasspilotTilePlanScenarioLabel;
  kind: ClasspilotTilePlanScenarioKind;
  mode: ClasspilotTilePlanMode;
}> = [
  { label: "teacher.live", kind: "teacher", mode: "live" },
  { label: "teacher.history", kind: "teacher", mode: "history" },
  { label: "co_teacher.live", kind: "co_teacher", mode: "live" },
  { label: "co_teacher.history", kind: "co_teacher", mode: "history" },
  { label: "office_staff.live", kind: "office_staff", mode: "live" },
  { label: "office_staff.history", kind: "office_staff", mode: "history" },
];

const TEACHING_SESSION_SCHOOL_PRECHECK_SQL = `
  SELECT count(*)::integer AS invalid_count
  FROM teaching_sessions AS session
  LEFT JOIN groups AS class_group ON class_group.id = session.group_id
  WHERE session.school_id IS NULL
     OR class_group.id IS NULL
     OR session.school_id IS DISTINCT FROM class_group.school_id
`;

const HISTORY_FALLBACK_SCHEMA_IDENTITY_SQL = `
  WITH resolved AS (
    SELECT
      to_regclass('heartbeats') AS heartbeats_relation,
      to_regclass('heartbeats_school_device_student_timestamp_idx') AS history_index
  )
  SELECT
    current_setting('server_version') AS engine_version,
    current_database() AS database_name,
    current_schema() AS schema_name,
    current_setting('search_path') AS search_path,
    current_setting('track_io_timing') AS track_io_timing,
    resolved.heartbeats_relation::oid::text AS heartbeats_relation_oid,
    resolved.heartbeats_relation::text AS heartbeats_relation_name,
    (
      SELECT string_agg(
        concat_ws(
          ':',
          attribute.attnum::text,
          attribute.attname,
          format_type(attribute.atttypid, attribute.atttypmod),
          attribute.attnotnull::text
        ),
        E'\\n' ORDER BY attribute.attnum
      )
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid = resolved.heartbeats_relation::oid
        AND attribute.attnum > 0
        AND attribute.attisdropped = false
    ) AS heartbeats_column_signature,
    resolved.history_index::oid::text AS history_index_oid,
    resolved.history_index::text AS history_index_name,
    pg_get_indexdef(resolved.history_index::oid) AS history_index_definition
  FROM resolved
`;

function modeJoin(mode: ClasspilotTilePlanMode): string {
  if (mode === "live") {
    return `
      INNER JOIN student_sessions AS student_session
        ON student_session.student_id = candidate.student_id
       AND student_session.is_active = true
      INNER JOIN devices AS device
        ON device.device_id = student_session.device_id
       AND device.school_id = candidate.school_id
    `;
  }
  return `
    INNER JOIN student_devices AS student_device
      ON student_device.student_id = candidate.student_id
    INNER JOIN devices AS device
      ON device.device_id = student_device.device_id
     AND device.school_id = candidate.school_id
  `;
}

function authorizedCandidateSql(kind: ClasspilotTilePlanScenarioKind): string {
  if (kind === "teacher") {
    return `
      SELECT DISTINCT
        class_group.school_id,
        session.teacher_id AS staff_id,
        roster.student_id
      FROM teaching_sessions AS session
      INNER JOIN groups AS class_group
        ON class_group.id = session.group_id
       AND class_group.school_id = session.school_id
      INNER JOIN school_memberships AS staff_membership
        ON staff_membership.user_id = session.teacher_id
       AND staff_membership.school_id = class_group.school_id
       AND staff_membership.role = 'teacher'
       AND staff_membership.status = 'active'
      INNER JOIN group_students AS roster ON roster.group_id = session.group_id
      INNER JOIN students AS student
        ON student.id = roster.student_id
       AND student.school_id = class_group.school_id
      WHERE session.session_mode = 'live'
        AND session.end_time IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM classpilot_supervision_students AS supervised
          INNER JOIN classpilot_supervision_contexts AS context
            ON context.id = supervised.context_id
           AND context.school_id = class_group.school_id
           AND context.status = 'active'
           AND context.ends_at > now()
          WHERE supervised.school_id = class_group.school_id
            AND supervised.student_id = roster.student_id
            AND supervised.released_at IS NULL
            AND context.assigned_staff_id <> session.teacher_id
        )
    `;
  }
  if (kind === "co_teacher") {
    return `
      SELECT DISTINCT
        class_group.school_id,
        co_teacher.teacher_id AS staff_id,
        roster.student_id
      FROM teaching_sessions AS session
      INNER JOIN groups AS class_group
        ON class_group.id = session.group_id
       AND class_group.school_id = session.school_id
      INNER JOIN group_teachers AS co_teacher
        ON co_teacher.group_id = session.group_id
       AND co_teacher.teacher_id <> session.teacher_id
       AND co_teacher.role IN ('co-teacher', 'co_teacher')
      INNER JOIN school_memberships AS staff_membership
        ON staff_membership.user_id = co_teacher.teacher_id
       AND staff_membership.school_id = class_group.school_id
       AND staff_membership.role = 'teacher'
       AND staff_membership.status = 'active'
      INNER JOIN group_students AS roster ON roster.group_id = session.group_id
      INNER JOIN students AS student
        ON student.id = roster.student_id
       AND student.school_id = class_group.school_id
      WHERE session.session_mode = 'live'
        AND session.end_time IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM classpilot_supervision_students AS supervised
          INNER JOIN classpilot_supervision_contexts AS context
            ON context.id = supervised.context_id
           AND context.school_id = class_group.school_id
           AND context.status = 'active'
           AND context.ends_at > now()
          WHERE supervised.school_id = class_group.school_id
            AND supervised.student_id = roster.student_id
            AND supervised.released_at IS NULL
            AND context.assigned_staff_id <> co_teacher.teacher_id
        )
    `;
  }
  return `
    SELECT DISTINCT
      context.school_id,
      context.assigned_staff_id AS staff_id,
      supervised.student_id
    FROM classpilot_supervision_contexts AS context
    INNER JOIN classpilot_supervision_students AS supervised
      ON supervised.context_id = context.id
     AND supervised.school_id = context.school_id
     AND supervised.released_at IS NULL
    INNER JOIN students AS student
      ON student.id = supervised.student_id
     AND student.school_id = context.school_id
    INNER JOIN school_memberships AS staff_membership
      ON staff_membership.user_id = context.assigned_staff_id
     AND staff_membership.school_id = context.school_id
     AND staff_membership.role = 'office_staff'
     AND staff_membership.status = 'active'
    WHERE context.status = 'active'
      AND context.ends_at > now()
  `;
}

function discoverySql(
  kind: ClasspilotTilePlanScenarioKind,
  mode: ClasspilotTilePlanMode
): string {
  return `
    WITH authorized_candidate AS MATERIALIZED (
      ${authorizedCandidateSql(kind)}
    ),
    accessible_candidate AS MATERIALIZED (
      SELECT DISTINCT candidate.school_id, candidate.staff_id, candidate.student_id
      FROM authorized_candidate AS candidate
      ${modeJoin(mode)}
    ),
    ranked_candidate AS (
      SELECT
        candidate.*,
        row_number() OVER (
          PARTITION BY candidate.school_id, candidate.staff_id
          ORDER BY candidate.student_id
        ) AS student_rank,
        count(*) OVER (
          PARTITION BY candidate.school_id, candidate.staff_id
        ) AS cohort_count
      FROM accessible_candidate AS candidate
    )
    SELECT
      school_id,
      staff_id,
      array_agg(student_id ORDER BY student_rank) AS student_ids
    FROM ranked_candidate
    WHERE student_rank <= $1
      AND cohort_count >= $1
    GROUP BY school_id, staff_id, cohort_count
    ORDER BY cohort_count DESC
    LIMIT 1
  `;
}

async function beginReadOnly(client: ClasspilotTilePlanQueryClient): Promise<void> {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY");
  await client.query(
    "SELECT set_config('statement_timeout', $1, true)",
    [`${STATEMENT_TIMEOUT_MS}ms`]
  );
  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${LOCK_TIMEOUT_MS}ms`]
  );
}

async function rollbackQuietly(client: ClasspilotTilePlanQueryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The caller reports only a sanitized failure code. Never print driver SQL.
  }
}

async function discoverScenarios(
  client: ClasspilotTilePlanQueryClient,
  cohortSize: number
): Promise<{
  invalidTeachingSessionSchools: number;
  scenarios: DiscoveredScenario[];
}> {
  await beginReadOnly(client);
  try {
    await client.query("SELECT set_config('app.is_super', 'on', true)");
    const integrity = await client.query<{ invalid_count: number | string }>(
      TEACHING_SESSION_SCHOOL_PRECHECK_SQL
    );
    const invalidTeachingSessionSchools = Number(
      integrity.rows[0]?.invalid_count ?? 0
    );
    if (!Number.isInteger(invalidTeachingSessionSchools)) {
      throw new ClasspilotTileAuthorizationPlanCheckError(
        "invalid_explain_document"
      );
    }
    if (invalidTeachingSessionSchools > 0) {
      throw new ClasspilotTileAuthorizationPlanCheckError(
        "teaching_session_school_integrity_failed",
        [],
        invalidTeachingSessionSchools
      );
    }

    const discovered: DiscoveredScenario[] = [];
    const missing: ClasspilotTilePlanScenarioLabel[] = [];
    for (const scenario of SCENARIOS) {
      const result = await client.query<{
        school_id: string;
        staff_id: string;
        student_ids: string[];
      }>(discoverySql(scenario.kind, scenario.mode), [cohortSize]);
      const row = result.rows[0];
      if (
        !row ||
        typeof row.school_id !== "string" ||
        typeof row.staff_id !== "string" ||
        !Array.isArray(row.student_ids) ||
        row.student_ids.length !== cohortSize ||
        row.student_ids.some((studentId) => typeof studentId !== "string")
      ) {
        missing.push(scenario.label);
        continue;
      }
      discovered.push({
        ...scenario,
        schoolId: row.school_id,
        staffId: row.staff_id,
        studentIds: row.student_ids,
      });
    }
    if (missing.length > 0) {
      throw new ClasspilotTileAuthorizationPlanCheckError(
        "representative_scenario_missing",
        missing
      );
    }
    await client.query("COMMIT");
    return { invalidTeachingSessionSchools, scenarios: discovered };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requiredNonNegativeNumericField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_explain_document"
    );
  }
  return value;
}

function parseExplainDocument(raw: unknown): {
  document: Record<string, unknown>;
  plan: Record<string, unknown>;
  executionMs: number;
} {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new ClasspilotTileAuthorizationPlanCheckError(
        "invalid_explain_document"
      );
    }
  }
  const document = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!document || typeof document !== "object") {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_explain_document"
    );
  }
  const record = document as Record<string, unknown>;
  const plan = record["Plan"];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_explain_document"
    );
  }
  const executionMs = numericField(record["Execution Time"]);
  if (executionMs <= 0) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_explain_document"
    );
  }
  return {
    document: record,
    plan: plan as Record<string, unknown>,
    executionMs,
  };
}

function traversePlan(value: unknown, evidence: ClasspilotTilePlanEvidence): void {
  if (Array.isArray(value)) {
    for (const child of value) traversePlan(child, evidence);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  evidence.tempReadBlocks = Math.max(
    evidence.tempReadBlocks,
    numericField(node["Temp Read Blocks"])
  );
  evidence.tempWrittenBlocks = Math.max(
    evidence.tempWrittenBlocks,
    numericField(node["Temp Written Blocks"])
  );
  if (
    node["Parent Relationship"] === "SubPlan" ||
    (typeof node["Subplan Name"] === "string" &&
      /^SubPlan\b/i.test(node["Subplan Name"]))
  ) {
    evidence.subPlanNodes += 1;
  }
  for (const child of Object.values(node)) traversePlan(child, evidence);
}

export function inspectClasspilotTileExplainDocument(
  raw: unknown
): ClasspilotTilePlanEvidence {
  const parsed = parseExplainDocument(raw);
  const evidence: ClasspilotTilePlanEvidence = {
    executionMs: parsed.executionMs,
    tempReadBlocks: 0,
    tempWrittenBlocks: 0,
    subPlanNodes: 0,
  };
  traversePlan(parsed.plan, evidence);
  return evidence;
}

function subtreeUsesHeartbeatHistoryIndex(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((child) => subtreeUsesHeartbeatHistoryIndex(child));
  }
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  const nodeType = node["Node Type"];
  if (
    (nodeType === "Index Scan" || nodeType === "Index Only Scan") &&
    node["Relation Name"] === "heartbeats" &&
    node["Index Name"] === CLASSPILOT_TILE_HISTORY_FALLBACK_INDEX
  ) {
    return true;
  }
  return Object.values(node).some((child) =>
    subtreeUsesHeartbeatHistoryIndex(child)
  );
}

function traverseHistoryFallbackPlan(
  value: unknown,
  evidence: ClasspilotTileHistoryFallbackPlanEvidence,
  cohortSize: number,
  historyLimit: number
): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      traverseHistoryFallbackPlan(child, evidence, cohortSize, historyLimit);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  const nodeType = node["Node Type"];
  if (nodeType === "WindowAgg") evidence.windowAggNodes += 1;
  if (
    typeof nodeType === "string" &&
    /Seq Scan$/.test(nodeType) &&
    node["Relation Name"] === "heartbeats"
  ) {
    evidence.heartbeatSequentialScanNodes += 1;
  }
  if (
    nodeType === "Limit" &&
    requiredNonNegativeNumericField(node["Actual Loops"]) === cohortSize &&
    requiredNonNegativeNumericField(node["Plan Rows"]) <= historyLimit &&
    requiredNonNegativeNumericField(node["Actual Rows"]) <= historyLimit &&
    subtreeUsesHeartbeatHistoryIndex(node)
  ) {
    evidence.perPairIndexLimit = true;
  }
  for (const child of Object.values(node)) {
    traverseHistoryFallbackPlan(child, evidence, cohortSize, historyLimit);
  }
}

export function inspectClasspilotTileHistoryFallbackExplainDocument(
  raw: unknown,
  cohortSize = CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE,
  historyLimit = CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT
): ClasspilotTileHistoryFallbackPlanEvidence {
  if (
    !Number.isInteger(cohortSize) ||
    cohortSize < 1 ||
    historyLimit !== CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT
  ) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_configuration"
    );
  }
  const parsed = parseExplainDocument(raw);
  const evidence: ClasspilotTileHistoryFallbackPlanEvidence = {
    executionMs: parsed.executionMs,
    tempReadBlocks: 0,
    tempWrittenBlocks: 0,
    subPlanNodes: 0,
    windowAggNodes: 0,
    heartbeatSequentialScanNodes: 0,
    returnedRows: requiredNonNegativeNumericField(parsed.plan["Actual Rows"]),
    perPairIndexLimit: false,
  };
  traversePlan(parsed.plan, evidence);
  traverseHistoryFallbackPlan(
    parsed.plan,
    evidence,
    cohortSize,
    historyLimit
  );
  return evidence;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizeClasspilotTilePlanScenario(
  label: ClasspilotTilePlanScenarioLabel,
  cohortSize: number,
  samples: readonly ClasspilotTilePlanEvidence[]
): ClasspilotTilePlanScenarioSummary {
  if (samples.length < CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_configuration"
    );
  }
  const timings = samples.map((sample) => sample.executionMs).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(timings.length * 0.95) - 1);
  const p95Ms = timings[p95Index] ?? Number.POSITIVE_INFINITY;
  const maxMs = timings[timings.length - 1] ?? Number.POSITIVE_INFINITY;
  const tempReadBlocks = Math.max(...samples.map((sample) => sample.tempReadBlocks));
  const tempWrittenBlocks = Math.max(...samples.map((sample) => sample.tempWrittenBlocks));
  const subPlanNodes = Math.max(...samples.map((sample) => sample.subPlanNodes));
  return {
    label,
    cohortSize,
    samples: samples.length,
    p95Ms: roundMilliseconds(p95Ms),
    maxMs: roundMilliseconds(maxMs),
    tempReadBlocks,
    tempWrittenBlocks,
    subPlanNodes,
    passed:
      p95Ms <= CLASSPILOT_TILE_AUTHORIZATION_PLAN_P95_MS &&
      maxMs <= CLASSPILOT_TILE_AUTHORIZATION_PLAN_MAX_MS &&
      tempReadBlocks === 0 &&
      tempWrittenBlocks === 0 &&
      subPlanNodes === 0,
  };
}

export function summarizeClasspilotTileHistoryFallbackPlan(
  cohortSize: number,
  historyLimit: number,
  samples: readonly ClasspilotTileHistoryFallbackPlanEvidence[]
): ClasspilotTileHistoryFallbackPlanSummary {
  if (
    cohortSize !== CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE ||
    historyLimit !== CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT ||
    samples.length < CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES
  ) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_configuration"
    );
  }
  const timings = samples
    .map((sample) => sample.executionMs)
    .sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(timings.length * 0.95) - 1);
  const p95Ms = timings[p95Index] ?? Number.POSITIVE_INFINITY;
  const maxMs = timings[timings.length - 1] ?? Number.POSITIVE_INFINITY;
  const tempReadBlocks = Math.max(
    ...samples.map((sample) => sample.tempReadBlocks)
  );
  const tempWrittenBlocks = Math.max(
    ...samples.map((sample) => sample.tempWrittenBlocks)
  );
  const subPlanNodes = Math.max(
    ...samples.map((sample) => sample.subPlanNodes)
  );
  const windowAggNodes = Math.max(
    ...samples.map((sample) => sample.windowAggNodes)
  );
  const heartbeatSequentialScanNodes = Math.max(
    ...samples.map((sample) => sample.heartbeatSequentialScanNodes)
  );
  const maxReturnedRows = Math.max(
    ...samples.map((sample) => sample.returnedRows)
  );
  const perPairIndexLimit = samples.every(
    (sample) => sample.perPairIndexLimit
  );
  return {
    label: "history_fallback",
    cohortSize,
    historyLimit,
    samples: samples.length,
    p95Ms: roundMilliseconds(p95Ms),
    maxMs: roundMilliseconds(maxMs),
    tempReadBlocks,
    tempWrittenBlocks,
    subPlanNodes,
    windowAggNodes,
    heartbeatSequentialScanNodes,
    maxReturnedRows,
    perPairIndexLimit,
    passed:
      p95Ms <= CLASSPILOT_TILE_AUTHORIZATION_PLAN_P95_MS &&
      maxMs <= CLASSPILOT_TILE_AUTHORIZATION_PLAN_MAX_MS &&
      tempReadBlocks === 0 &&
      tempWrittenBlocks === 0 &&
      subPlanNodes === 0 &&
      windowAggNodes === 0 &&
      heartbeatSequentialScanNodes === 0 &&
      Number.isInteger(maxReturnedRows) &&
      maxReturnedRows >= 0 &&
      maxReturnedRows <= CLASSPILOT_TILE_HISTORY_FALLBACK_MAX_ROWS &&
      perPairIndexLimit,
  };
}

type CompiledSqlQuery = { text: string; params: unknown[] };

function compileExplainFromQuery(compiled: CompiledSqlQuery): CompiledSqlQuery {
  return {
    text: `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON) ${compiled.text}`,
    params: compiled.params,
  };
}

function compileExplain(query: SQL): CompiledSqlQuery {
  return compileExplainFromQuery(compileQuery(query));
}

function compileQuery(query: SQL): CompiledSqlQuery {
  const compiled = new PgDialect().sqlToQuery(query);
  return { text: compiled.sql, params: compiled.params };
}

function compileIdentityExplain(compiled: CompiledSqlQuery): CompiledSqlQuery {
  return {
    text: `EXPLAIN (VERBOSE, FORMAT TEXT) ${compiled.text}`,
    params: compiled.params,
  };
}

function identityFailure(): never {
  throw new ClasspilotTileAuthorizationPlanCheckError(
    "history_fallback_query_identity_invalid"
  );
}

function requireMetadataString(value: unknown): string {
  if (typeof value !== "string") identityFailure();
  return value;
}

async function requireHistoryFallbackQueryIdentifierEnabled(
  client: ClasspilotTilePlanQueryClient
): Promise<void> {
  const result = await client.query<{ compute_query_id: unknown }>(
    "SELECT current_setting('compute_query_id', true) AS compute_query_id"
  );
  if (result.rows.length !== 1) identityFailure();
  const setting = result.rows[0]?.compute_query_id;
  if (setting !== "on" && setting !== "auto") identityFailure();
}

async function readHistoryFallbackQueryIdentifier(
  client: ClasspilotTilePlanQueryClient,
  explain: CompiledSqlQuery
): Promise<string> {
  try {
    const result = await client.query<Record<string, unknown>>(
      explain.text,
      explain.params
    );
    return parseClasspilotHistoryFallbackQueryIdentifier(result.rows);
  } catch (error) {
    if (error instanceof ClasspilotHistoryFallbackSqlIdentityError) {
      identityFailure();
    }
    throw error;
  }
}

async function readHistoryFallbackSchemaIdentity(
  client: ClasspilotTilePlanQueryClient
): Promise<{
  engineVersion: string;
  schemaIdentitySha256: string;
  trackIoTiming: true;
}> {
  const result = await client.query<Record<string, unknown>>(
    HISTORY_FALLBACK_SCHEMA_IDENTITY_SQL
  );
  if (result.rows.length !== 1) identityFailure();
  const row = result.rows[0];
  if (!row) identityFailure();
  try {
    if (row.track_io_timing !== "on") identityFailure();
    const metadata: ClasspilotHistoryFallbackSchemaMetadata = {
      trackIoTiming: true,
      engineVersion: requireMetadataString(row.engine_version),
      databaseName: requireMetadataString(row.database_name),
      schemaName: requireMetadataString(row.schema_name),
      searchPath: requireMetadataString(row.search_path),
      heartbeatsRelationOid: requireMetadataString(
        row.heartbeats_relation_oid
      ),
      heartbeatsRelationName: requireMetadataString(
        row.heartbeats_relation_name
      ),
      heartbeatsColumnSignature: requireMetadataString(
        row.heartbeats_column_signature
      ),
      historyIndexOid: requireMetadataString(row.history_index_oid),
      historyIndexName: requireMetadataString(row.history_index_name),
      historyIndexDefinition: requireMetadataString(
        row.history_index_definition
      ),
    };
    return {
      engineVersion: metadata.engineVersion,
      schemaIdentitySha256:
        createClasspilotHistoryFallbackSchemaIdentitySha256(metadata),
      trackIoTiming: true,
    };
  } catch (error) {
    if (
      error instanceof ClasspilotHistoryFallbackSqlIdentityError ||
      error instanceof ClasspilotTileAuthorizationPlanCheckError
    ) {
      identityFailure();
    }
    throw error;
  }
}

async function measureScenario(
  client: ClasspilotTilePlanQueryClient,
  buildQuery: ClasspilotTileAuthorizationQueryBuilder,
  scenario: DiscoveredScenario,
  samples: number
): Promise<ClasspilotTilePlanScenarioSummary> {
  await beginReadOnly(client);
  try {
    await client.query("SELECT set_config('app.is_super', 'off', true)");
    await client.query("SELECT set_config('app.school_id', $1, true)", [
      scenario.schoolId,
    ]);
    const query = buildQuery(
      {
        schoolId: scenario.schoolId,
        staffId: scenario.staffId,
        role: scenario.kind === "office_staff" ? "office_staff" : "teacher",
      },
      scenario.mode,
      scenario.studentIds
    );
    const explain = compileExplain(query);
    for (
      let warmup = 0;
      warmup < CLASSPILOT_TILE_AUTHORIZATION_PLAN_WARMUPS;
      warmup += 1
    ) {
      await client.query(explain.text, explain.params);
    }
    const evidence: ClasspilotTilePlanEvidence[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const result = await client.query<Record<string, unknown>>(
        explain.text,
        explain.params
      );
      evidence.push(
        inspectClasspilotTileExplainDocument(result.rows[0]?.["QUERY PLAN"])
      );
    }
    await client.query("COMMIT");
    return summarizeClasspilotTilePlanScenario(
      scenario.label,
      scenario.studentIds.length,
      evidence
    );
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function measureHistoryFallback(
  client: ClasspilotTilePlanQueryClient,
  buildAuthorizationQuery: ClasspilotTileAuthorizationQueryBuilder,
  buildHistoryQuery: ClasspilotTileHistoryFallbackQueryBuilder,
  scenario: DiscoveredScenario,
  samples: number
): Promise<{
  summary: ClasspilotTileHistoryFallbackPlanSummary;
  sqlIdentity: ClasspilotTileHistoryFallbackSqlIdentity;
}> {
  await beginReadOnly(client);
  try {
    await client.query("SELECT set_config('app.is_super', 'off', true)");
    await client.query("SELECT set_config('app.school_id', $1, true)", [
      scenario.schoolId,
    ]);
    // This gate must run with the same effective query-ID posture as the
    // restricted application role. Never mutate compute_query_id here: `auto`
    // is eligible only when the two real VERBOSE EXPLAIN probes below produce
    // the same nonzero identifier.
    await requireHistoryFallbackQueryIdentifierEnabled(client);

    const authorization = compileQuery(
      buildAuthorizationQuery(
        {
          schoolId: scenario.schoolId,
          staffId: scenario.staffId,
          role: "teacher",
        },
        "history",
        scenario.studentIds
      )
    );
    const authorized = await client.query<{
      student_id: unknown;
      device_id: unknown;
      school_id: unknown;
    }>(authorization.text, authorization.params);
    const accesses: ClasspilotTileHistoryFallbackAccess[] = [];
    const seenStudents = new Set<string>();
    for (const row of authorized.rows) {
      if (
        typeof row.student_id !== "string" ||
        typeof row.device_id !== "string" ||
        row.school_id !== scenario.schoolId ||
        seenStudents.has(row.student_id)
      ) {
        throw new ClasspilotTileAuthorizationPlanCheckError(
          "representative_scenario_missing",
          [scenario.label]
        );
      }
      seenStudents.add(row.student_id);
      accesses.push({
        studentId: row.student_id,
        deviceId: row.device_id,
        schoolId: scenario.schoolId,
        studentSessionId: null,
      });
    }
    if (
      accesses.length !== CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE ||
      accesses.some(
        (access) => !scenario.studentIds.includes(access.studentId)
      )
    ) {
      throw new ClasspilotTileAuthorizationPlanCheckError(
        "representative_scenario_missing",
        [scenario.label]
      );
    }

    const compiledHistoryQuery = compileQuery(
      buildHistoryQuery(
        scenario.schoolId,
        accesses,
        CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT
      )
    );
    let sqlShapeIdentity: ClasspilotHistoryFallbackSqlShapeIdentity;
    try {
      sqlShapeIdentity = createClasspilotHistoryFallbackSqlShapeIdentity(
        compiledHistoryQuery.text,
        compiledHistoryQuery.params
      );
    } catch (error) {
      if (error instanceof ClasspilotHistoryFallbackSqlIdentityError) {
        identityFailure();
      }
      throw error;
    }
    const schemaIdentityBefore = await readHistoryFallbackSchemaIdentity(client);
    const identityExplain = compileIdentityExplain(compiledHistoryQuery);
    const queryIdentifierBefore = await readHistoryFallbackQueryIdentifier(
      client,
      identityExplain
    );
    const explain = compileExplainFromQuery(compiledHistoryQuery);
    for (
      let warmup = 0;
      warmup < CLASSPILOT_TILE_AUTHORIZATION_PLAN_WARMUPS;
      warmup += 1
    ) {
      await client.query(explain.text, explain.params);
    }
    const evidence: ClasspilotTileHistoryFallbackPlanEvidence[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const result = await client.query<Record<string, unknown>>(
        explain.text,
        explain.params
      );
      evidence.push(
        inspectClasspilotTileHistoryFallbackExplainDocument(
          result.rows[0]?.["QUERY PLAN"],
          accesses.length,
          CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT
        )
      );
    }
    const queryIdentifierAfter = await readHistoryFallbackQueryIdentifier(
      client,
      identityExplain
    );
    try {
      requireStableClasspilotHistoryFallbackQueryIdentifier(
        queryIdentifierBefore,
        queryIdentifierAfter
      );
    } catch (error) {
      if (error instanceof ClasspilotHistoryFallbackSqlIdentityError) {
        identityFailure();
      }
      throw error;
    }
    const schemaIdentityAfter = await readHistoryFallbackSchemaIdentity(client);
    try {
      requireStableClasspilotHistoryFallbackSchemaIdentity(
        schemaIdentityBefore,
        schemaIdentityAfter
      );
    } catch (error) {
      if (error instanceof ClasspilotHistoryFallbackSqlIdentityError) {
        identityFailure();
      }
      throw error;
    }
    await client.query("COMMIT");
    return {
      summary: summarizeClasspilotTileHistoryFallbackPlan(
        accesses.length,
        CLASSPILOT_TILE_HISTORY_FALLBACK_LIMIT,
        evidence
      ),
      sqlIdentity: {
        ...sqlShapeIdentity,
        queryIdentifier: queryIdentifierBefore,
        queryIdentifierSha256:
          createClasspilotHistoryFallbackQueryIdentifierSha256(
            queryIdentifierBefore
          ),
        engineVersion: schemaIdentityBefore.engineVersion,
        schemaIdentitySha256: schemaIdentityBefore.schemaIdentitySha256,
        trackIoTiming: true,
      },
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

export async function runClasspilotTileAuthorizationPlanCheck(options: {
  client: ClasspilotTilePlanQueryClient;
  buildQuery: ClasspilotTileAuthorizationQueryBuilder;
  buildHistoryQuery: ClasspilotTileHistoryFallbackQueryBuilder;
  samples?: number;
}): Promise<ClasspilotTileAuthorizationPlanReport> {
  const samples = options.samples ?? CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES;
  if (
    !Number.isInteger(samples) ||
    samples < CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES ||
    samples > MAX_SAMPLES
  ) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_configuration"
    );
  }
  const discovery = await discoverScenarios(
    options.client,
    CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE
  );
  const scenarios: ClasspilotTilePlanScenarioSummary[] = [];
  for (const scenario of discovery.scenarios) {
    scenarios.push(
      await measureScenario(
        options.client,
        options.buildQuery,
        scenario,
        samples
      )
    );
  }
  const historyScenario = discovery.scenarios.find(
    (scenario) => scenario.label === "teacher.history"
  );
  if (!historyScenario) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "representative_scenario_missing",
      ["teacher.history"]
    );
  }
  const historyFallbackMeasurement = await measureHistoryFallback(
    options.client,
    options.buildQuery,
    options.buildHistoryQuery,
    historyScenario,
    samples
  );
  const historyFallback = historyFallbackMeasurement.summary;
  return {
    status:
      scenarios.every((scenario) => scenario.passed) && historyFallback.passed
        ? "passed"
        : "failed",
    precheck: {
      invalidTeachingSessionSchools:
        discovery.invalidTeachingSessionSchools,
    },
    samples,
    warmups: CLASSPILOT_TILE_AUTHORIZATION_PLAN_WARMUPS,
    cohortSize: CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE,
    thresholds: {
      p95Ms: CLASSPILOT_TILE_AUTHORIZATION_PLAN_P95_MS,
      maxMs: CLASSPILOT_TILE_AUTHORIZATION_PLAN_MAX_MS,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxHeartbeatRows: CLASSPILOT_TILE_HISTORY_FALLBACK_MAX_ROWS,
      perPairIndexLimit: true,
    },
    scenarios,
    historyFallback,
    historyFallbackSqlIdentity: historyFallbackMeasurement.sqlIdentity,
  };
}
