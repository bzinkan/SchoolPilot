import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
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
const ADVISORY_LOCK_WAIT_TIMEOUT_MS = 60_000;
const ADVISORY_LOCK_STATEMENT_TIMEOUT_MS =
  ADVISORY_LOCK_WAIT_TIMEOUT_MS + 5_000;
const TRANSACTIONAL_PLAN_SCENARIO_VERSION =
  "transactional-plan-scenarios-v2" as const;
const TRANSACTIONAL_PLAN_BASE_PREFLIGHT_VERSION =
  "classpilot-tile-auth-plan-base-preflight-v1" as const;
export const CLASSPILOT_TILE_AUTHORIZATION_PLAN_BASE_FUNNEL_VERSION =
  "classpilot-tile-auth-plan-base-funnel-v1" as const;
const TRANSACTIONAL_PLAN_ADVISORY_LOCK_KEY =
  "classpilot-tile-authorization-plan-gate-v1";
const TRANSACTIONAL_PLAN_REQUIRED_SESSION_PAIRS =
  CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE * 2;

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

type TransactionalPlanBase = {
  schoolId: string;
  groupId: string;
  primaryTeacherId: string;
  coTeacherId: string;
  officeStaffId: string;
  teacherStudentIds: string[];
  teacherDeviceIds: string[];
  officeStudentIds: string[];
  officeDeviceIds: string[];
};

type TransactionalPlanSeedIds = {
  groupTeacherId: string;
  teachingSessionId: string;
  supervisionContextId: string;
  supervisionStudentIds: string[];
  studentSessionIds: string[];
};

type TransactionalPlanSeedCounts = {
  groupTeachers: number;
  teachingSessions: number;
  supervisionContexts: number;
  supervisionStudents: number;
  studentSessions: number;
  total: number;
};

export type ClasspilotTransactionalPlanScenariosLifecycleEvent = {
  version: typeof TRANSACTIONAL_PLAN_SCENARIO_VERSION;
  requiredSessionPairs: number;
  reusedActiveSessionPairs: number;
  insertedSessionPairs: number;
  seededRows: TransactionalPlanSeedCounts;
  rollback: {
    attempted: boolean;
    completed: boolean;
  };
  residue: {
    checked: boolean;
    count: number | null;
    passed: boolean;
  };
};

export type ClasspilotTransactionalPlanScenariosLifecycleListener = (
  event: ClasspilotTransactionalPlanScenariosLifecycleEvent
) => void | Promise<void>;

export type ClasspilotTileAuthorizationPlanBasePreflightReport = {
  version: typeof TRANSACTIONAL_PLAN_BASE_PREFLIGHT_VERSION;
  status: "passed";
  eligibleBases: 1;
  requiredSessionPairs: number;
  reusedActiveSessionPairs: number;
  missingSessionPairs: number;
  conflictingSessionPairs: 0;
};

export type ClasspilotTileAuthorizationPlanBaseFunnelCounts = {
  syntheticDescribedGroups: number;
  syntheticSchoolGroups: number;
  primaryTeacherGroups: number;
  licensedGroups: number;
  activeRosterStudents: number;
  canonicalMappedRosterStudents: number;
  unsupervisedRosterStudents: number;
  noCoTeacherGroups: number;
  exactCohortGroups: number;
  eligibleGroupSchools: number;
  activeOfficeMemberships: number;
  uniqueOfficeMembershipSchools: number;
  activeOfficeStudents: number;
  canonicalMappedOfficeStudents: number;
  unrosteredOfficeStudents: number;
  unsupervisedOfficeStudents: number;
  officeCohortReadySchools: number;
  alternateTeacherReadySchools: number;
  eligibleSchools: number;
  selectedSchools: number;
  selectedGroups: number;
  selectedCoTeachers: number;
  selectedOfficeStaff: number;
  selectedOfficeCohorts: number;
  finalBases: number;
};

export type ClasspilotTileAuthorizationPlanBaseFunnelStage =
  | keyof ClasspilotTileAuthorizationPlanBaseFunnelCounts
  | "none";

export type ClasspilotTileAuthorizationPlanBaseFunnelEvidence = {
  version:
    typeof CLASSPILOT_TILE_AUTHORIZATION_PLAN_BASE_FUNNEL_VERSION;
  failureStage: "base_funnel" | "base_shape" | "session_posture";
  firstEmptyStage: ClasspilotTileAuthorizationPlanBaseFunnelStage;
  cohortSize: typeof CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE;
  counts: ClasspilotTileAuthorizationPlanBaseFunnelCounts;
  sessionPosture: {
    requiredSessionPairs: number;
    reusedActiveSessionPairs: number;
    missingSessionPairs: number;
    conflictingSessionPairs: number;
  } | null;
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
      | "base_funnel_evidence_invalid"
      | "invalid_explain_document"
      | "history_fallback_query_identity_invalid"
      | "transactional_scenario_lifecycle_failed",
    readonly labels: ClasspilotTilePlanScenarioLabel[] = [],
    readonly invalidCount = 0,
    readonly funnelEvidence?:
      ClasspilotTileAuthorizationPlanBaseFunnelEvidence
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

const TRANSACTIONAL_PLAN_BASE_SQL = `
  /* transactional_plan_base_v2 */
  WITH described_groups AS MATERIALIZED (
    SELECT
      class_group.id AS group_id,
      class_group.school_id,
      class_group.teacher_id AS primary_teacher_id,
      class_group.description,
      substring(
        class_group.description
        FROM '^synthetic-load-fixture:([a-z0-9][a-z0-9-]{2,40}):class:[0-9]{2}$'
      ) AS fixture_id
    FROM groups AS class_group
    WHERE class_group.status = 'active'
      AND class_group.schedule_enabled = false
  ),
  synthetic_described_groups AS MATERIALIZED (
    SELECT described.*
    FROM described_groups AS described
    WHERE described.fixture_id IS NOT NULL
  ),
  synthetic_school_groups AS MATERIALIZED (
    SELECT described.*
    FROM synthetic_described_groups AS described
    INNER JOIN schools AS school
      ON school.id = described.school_id
     AND school.status = 'active'
     AND school.is_active = true
     AND school.deleted_at IS NULL
     AND school.disabled_at IS NULL
     AND school.stripe_customer_id IS NULL
     AND school.stripe_subscription_id IS NULL
     AND school.total_paid = 0
     AND school.name LIKE '%[SYNTHETIC LOAD TEST - NON-BILLABLE]%'
     AND position(lower(described.fixture_id) IN lower(school.name)) > 0
  ),
  primary_teacher_groups AS MATERIALIZED (
    SELECT described.*
    FROM synthetic_school_groups AS described
    INNER JOIN school_memberships AS primary_membership
      ON primary_membership.user_id = described.primary_teacher_id
     AND primary_membership.school_id = described.school_id
     AND primary_membership.role = 'teacher'
     AND primary_membership.status = 'active'
  ),
  licensed_groups AS MATERIALIZED (
    SELECT described.*
    FROM primary_teacher_groups AS described
    WHERE EXISTS (
      SELECT 1
      FROM product_licenses AS classpilot_license
      WHERE classpilot_license.school_id = described.school_id
        AND classpilot_license.product = 'CLASSPILOT'
        AND classpilot_license.status = 'active'
        AND (
          classpilot_license.expires_at IS NULL
          OR classpilot_license.expires_at > now()
        )
    )
  ),
  marked_groups AS MATERIALIZED (
    SELECT licensed.*
    FROM licensed_groups AS licensed
  ),
  active_roster_students AS MATERIALIZED (
    SELECT
      marked.group_id,
      marked.school_id,
      marked.primary_teacher_id,
      marked.description,
      marked.fixture_id,
      roster.student_id,
      student.student_id_number
    FROM marked_groups AS marked
    INNER JOIN group_students AS roster
      ON roster.group_id = marked.group_id
    INNER JOIN students AS student
      ON student.id = roster.student_id
     AND student.school_id = marked.school_id
     AND student.status = 'active'
     AND upper(student.student_id_number)
       ~ ('^' || upper(marked.fixture_id) || '-P-[0-9]{4}$')
  ),
  canonical_mapped_roster_students AS MATERIALIZED (
    SELECT
      roster.group_id,
      roster.school_id,
      roster.primary_teacher_id,
      roster.description,
      roster.fixture_id,
      roster.student_id,
      historical_device.device_id
    FROM active_roster_students AS roster
    INNER JOIN student_devices AS historical_mapping
      ON historical_mapping.student_id = roster.student_id
     AND historical_mapping.device_id =
       roster.fixture_id || '-primary-' ||
       right(roster.student_id_number, 4)
    INNER JOIN devices AS historical_device
      ON historical_device.device_id = historical_mapping.device_id
     AND historical_device.school_id = roster.school_id
  ),
  qualified_group_students AS MATERIALIZED (
    SELECT
      roster.group_id,
      roster.school_id,
      roster.primary_teacher_id,
      roster.description,
      roster.fixture_id,
      roster.student_id,
      roster.device_id
    FROM canonical_mapped_roster_students AS roster
    WHERE NOT EXISTS (
        SELECT 1
        FROM classpilot_supervision_students AS supervised
        INNER JOIN classpilot_supervision_contexts AS context
          ON context.id = supervised.context_id
         AND context.school_id = roster.school_id
         AND context.status = 'active'
         AND context.ends_at > now()
        WHERE supervised.school_id = roster.school_id
          AND supervised.student_id = roster.student_id
          AND supervised.released_at IS NULL
      )
  ),
  no_co_teacher_group_students AS MATERIALIZED (
    SELECT qualified.*
    FROM qualified_group_students AS qualified
    WHERE NOT EXISTS (
      SELECT 1
      FROM group_teachers AS existing_co_teacher
      WHERE existing_co_teacher.group_id = qualified.group_id
    )
  ),
  eligible_groups AS MATERIALIZED (
    SELECT
      qualified.group_id,
      qualified.school_id,
      qualified.primary_teacher_id,
      qualified.description,
      qualified.fixture_id,
      array_agg(qualified.student_id ORDER BY qualified.student_id)
        AS teacher_student_ids,
      array_agg(qualified.device_id ORDER BY qualified.student_id)
        AS teacher_device_ids
    FROM no_co_teacher_group_students AS qualified
    GROUP BY
      qualified.group_id,
      qualified.school_id,
      qualified.primary_teacher_id,
      qualified.description,
      qualified.fixture_id
    HAVING count(*) = $1
       AND (
         SELECT count(*)
         FROM group_students AS complete_roster
         WHERE complete_roster.group_id = qualified.group_id
       ) = $1
  ),
  eligible_group_schools AS MATERIALIZED (
    SELECT DISTINCT
      eligible.school_id,
      eligible.fixture_id
    FROM eligible_groups AS eligible
  ),
  office_memberships AS MATERIALIZED (
    SELECT
      membership.school_id,
      membership.user_id,
      count(*) OVER (PARTITION BY membership.school_id) AS membership_count
    FROM school_memberships AS membership
    INNER JOIN eligible_group_schools AS eligible_school
      ON eligible_school.school_id = membership.school_id
    WHERE membership.role = 'office_staff'
      AND membership.status = 'active'
  ),
  active_office_students AS MATERIALIZED (
    SELECT
      eligible_school.school_id,
      eligible_school.fixture_id,
      student.id AS student_id,
      student.student_id_number
    FROM eligible_group_schools AS eligible_school
    INNER JOIN students AS student
      ON student.school_id = eligible_school.school_id
     AND student.status = 'active'
     AND upper(student.student_id_number)
       ~ ('^' || upper(eligible_school.fixture_id) || '-P-[0-9]{4}$')
  ),
  canonical_mapped_office_students AS MATERIALIZED (
    SELECT
      student.school_id,
      student.fixture_id,
      student.student_id,
      historical_device.device_id
    FROM active_office_students AS student
    INNER JOIN student_devices AS historical_mapping
      ON historical_mapping.student_id = student.student_id
     AND historical_mapping.device_id =
       student.fixture_id || '-primary-' ||
       right(student.student_id_number, 4)
    INNER JOIN devices AS historical_device
      ON historical_device.device_id = historical_mapping.device_id
     AND historical_device.school_id = student.school_id
  ),
  unrostered_office_students AS MATERIALIZED (
    SELECT student.*
    FROM canonical_mapped_office_students AS student
    WHERE NOT EXISTS (
      SELECT 1
      FROM group_students AS any_roster
      WHERE any_roster.student_id = student.student_id
    )
  ),
  office_candidates AS MATERIALIZED (
    SELECT
      student.school_id,
      student.fixture_id,
      student.student_id,
      student.device_id,
      row_number() OVER (
        PARTITION BY student.school_id
        ORDER BY student.student_id
      ) AS student_rank,
      count(*) OVER (
        PARTITION BY student.school_id
    ) AS cohort_count
    FROM unrostered_office_students AS student
    WHERE NOT EXISTS (
      SELECT 1
      FROM classpilot_supervision_students AS supervised
      WHERE supervised.school_id = student.school_id
        AND supervised.student_id = student.student_id
        AND supervised.released_at IS NULL
    )
  ),
  unique_office_membership_schools AS MATERIALIZED (
    SELECT eligible_school.*
    FROM eligible_group_schools AS eligible_school
    WHERE (
      SELECT count(*)
      FROM office_memberships AS office
      WHERE office.school_id = eligible_school.school_id
        AND office.membership_count = 1
    ) = 1
  ),
  office_cohort_ready_schools AS MATERIALIZED (
    SELECT eligible_school.*
    FROM eligible_group_schools AS eligible_school
    WHERE (
      SELECT max(office.cohort_count)
      FROM office_candidates AS office
      WHERE office.school_id = eligible_school.school_id
    ) >= $1
  ),
  alternate_teacher_ready_schools AS MATERIALIZED (
    SELECT eligible_school.*
    FROM eligible_group_schools AS eligible_school
    WHERE EXISTS (
      SELECT 1
      FROM marked_groups AS other_group
      INNER JOIN school_memberships AS other_teacher_membership
        ON other_teacher_membership.user_id = other_group.primary_teacher_id
       AND other_teacher_membership.school_id = other_group.school_id
       AND other_teacher_membership.role = 'teacher'
       AND other_teacher_membership.status = 'active'
      INNER JOIN eligible_groups AS eligible_group
        ON eligible_group.school_id = other_group.school_id
       AND eligible_group.fixture_id = other_group.fixture_id
      WHERE other_group.school_id = eligible_school.school_id
        AND other_group.fixture_id = eligible_school.fixture_id
        AND other_group.primary_teacher_id
          <> eligible_group.primary_teacher_id
    )
  ),
  eligible_schools AS MATERIALIZED (
    SELECT eligible_school.*
    FROM eligible_group_schools AS eligible_school
    WHERE (
      SELECT count(*)
      FROM office_memberships AS office
      WHERE office.school_id = eligible_school.school_id
        AND office.membership_count = 1
    ) = 1
      AND (
        SELECT max(office.cohort_count)
        FROM office_candidates AS office
        WHERE office.school_id = eligible_school.school_id
      ) >= $1
      AND EXISTS (
        SELECT 1
        FROM marked_groups AS other_group
        INNER JOIN school_memberships AS other_teacher_membership
          ON other_teacher_membership.user_id = other_group.primary_teacher_id
         AND other_teacher_membership.school_id = other_group.school_id
         AND other_teacher_membership.role = 'teacher'
         AND other_teacher_membership.status = 'active'
        INNER JOIN eligible_groups AS eligible_group
          ON eligible_group.school_id = other_group.school_id
         AND eligible_group.fixture_id = other_group.fixture_id
        WHERE other_group.school_id = eligible_school.school_id
          AND other_group.fixture_id = eligible_school.fixture_id
          AND other_group.primary_teacher_id
            <> eligible_group.primary_teacher_id
      )
  ),
  selected_school AS MATERIALIZED (
    SELECT eligible.*
    FROM eligible_schools AS eligible
    WHERE (SELECT count(*) FROM eligible_schools) = 1
  ),
  selected_group AS MATERIALIZED (
    SELECT eligible.*
    FROM eligible_groups AS eligible
    INNER JOIN selected_school AS selected
      ON selected.school_id = eligible.school_id
     AND selected.fixture_id = eligible.fixture_id
    ORDER BY eligible.description, eligible.group_id
    LIMIT 1
  ),
  selected_co_teacher AS MATERIALIZED (
    SELECT other_group.primary_teacher_id AS co_teacher_id
    FROM marked_groups AS other_group
    INNER JOIN school_memberships AS active_teacher_membership
      ON active_teacher_membership.user_id = other_group.primary_teacher_id
     AND active_teacher_membership.school_id = other_group.school_id
     AND active_teacher_membership.role = 'teacher'
     AND active_teacher_membership.status = 'active'
    INNER JOIN selected_group AS selected
      ON selected.school_id = other_group.school_id
     AND selected.fixture_id = other_group.fixture_id
    WHERE other_group.primary_teacher_id <> selected.primary_teacher_id
    ORDER BY other_group.description, other_group.primary_teacher_id
    LIMIT 1
  ),
  selected_office_staff AS MATERIALIZED (
    SELECT office.user_id AS office_staff_id
    FROM office_memberships AS office
    INNER JOIN selected_school AS selected
      ON selected.school_id = office.school_id
    WHERE office.membership_count = 1
  ),
  selected_office_cohort AS MATERIALIZED (
    SELECT
      office.school_id,
      array_agg(office.student_id ORDER BY office.student_rank)
        AS office_student_ids,
      array_agg(office.device_id ORDER BY office.student_rank)
        AS office_device_ids
    FROM office_candidates AS office
    INNER JOIN selected_school AS selected
      ON selected.school_id = office.school_id
    WHERE office.student_rank <= $1
      AND office.cohort_count >= $1
    GROUP BY office.school_id
  ),
  final_bases AS MATERIALIZED (
    SELECT
      selected.school_id,
      selected.group_id,
      selected.primary_teacher_id,
      co_teacher.co_teacher_id,
      office_staff.office_staff_id,
      selected.teacher_student_ids,
      selected.teacher_device_ids,
      office_cohort.office_student_ids,
      office_cohort.office_device_ids
    FROM selected_group AS selected
    CROSS JOIN selected_co_teacher AS co_teacher
    CROSS JOIN selected_office_staff AS office_staff
    INNER JOIN selected_office_cohort AS office_cohort
      ON office_cohort.school_id = selected.school_id
  )
  SELECT
    final.school_id,
    final.group_id,
    final.primary_teacher_id,
    final.co_teacher_id,
    final.office_staff_id,
    final.teacher_student_ids,
    final.teacher_device_ids,
    final.office_student_ids,
    final.office_device_ids,
    (SELECT count(*)::integer FROM synthetic_described_groups)
      AS synthetic_described_groups,
    (SELECT count(*)::integer FROM synthetic_school_groups)
      AS synthetic_school_groups,
    (SELECT count(*)::integer FROM primary_teacher_groups)
      AS primary_teacher_groups,
    (SELECT count(*)::integer FROM licensed_groups)
      AS licensed_groups,
    (SELECT count(*)::integer FROM active_roster_students)
      AS active_roster_students,
    (SELECT count(*)::integer FROM canonical_mapped_roster_students)
      AS canonical_mapped_roster_students,
    (SELECT count(*)::integer FROM qualified_group_students)
      AS unsupervised_roster_students,
    (
      SELECT count(DISTINCT no_co_teacher.group_id)::integer
      FROM no_co_teacher_group_students AS no_co_teacher
    ) AS no_co_teacher_groups,
    (SELECT count(*)::integer FROM eligible_groups)
      AS exact_cohort_groups,
    (SELECT count(*)::integer FROM eligible_group_schools)
      AS eligible_group_schools,
    (SELECT count(*)::integer FROM office_memberships)
      AS active_office_memberships,
    (SELECT count(*)::integer FROM unique_office_membership_schools)
      AS unique_office_membership_schools,
    (SELECT count(*)::integer FROM active_office_students)
      AS active_office_students,
    (SELECT count(*)::integer FROM canonical_mapped_office_students)
      AS canonical_mapped_office_students,
    (SELECT count(*)::integer FROM unrostered_office_students)
      AS unrostered_office_students,
    (SELECT count(*)::integer FROM office_candidates)
      AS unsupervised_office_students,
    (SELECT count(*)::integer FROM office_cohort_ready_schools)
      AS office_cohort_ready_schools,
    (SELECT count(*)::integer FROM alternate_teacher_ready_schools)
      AS alternate_teacher_ready_schools,
    (SELECT count(*)::integer FROM eligible_schools)
      AS eligible_schools,
    (SELECT count(*)::integer FROM selected_school)
      AS selected_schools,
    (SELECT count(*)::integer FROM selected_group)
      AS selected_groups,
    (SELECT count(*)::integer FROM selected_co_teacher)
      AS selected_co_teachers,
    (SELECT count(*)::integer FROM selected_office_staff)
      AS selected_office_staff,
    (SELECT count(*)::integer FROM selected_office_cohort)
      AS selected_office_cohorts,
    (SELECT count(*)::integer FROM final_bases)
      AS final_bases
  FROM (SELECT 1) AS singleton
  LEFT JOIN LATERAL (
    SELECT *
    FROM final_bases
    WHERE (SELECT count(*) FROM final_bases) = 1
    LIMIT 1
  ) AS final ON true
`;

const TRANSACTIONAL_PLAN_SESSION_POSTURE_SQL = `
  /* transactional_plan_session_posture_v1 */
  WITH requested AS MATERIALIZED (
    SELECT student_id, device_id
    FROM unnest($1::text[], $2::text[])
      AS requested(student_id, device_id)
  ),
  classified AS MATERIALIZED (
    SELECT
      requested.student_id,
      requested.device_id,
      EXISTS (
        SELECT 1
        FROM student_sessions AS active_session
        WHERE active_session.is_active = true
          AND active_session.student_id = requested.student_id
          AND active_session.device_id = requested.device_id
      ) AS exact_pair_exists,
      EXISTS (
        SELECT 1
        FROM student_sessions AS active_session
        WHERE active_session.is_active = true
          AND (
            (
              active_session.student_id = requested.student_id
              AND active_session.device_id <> requested.device_id
            )
            OR (
              active_session.device_id = requested.device_id
              AND active_session.student_id <> requested.student_id
            )
          )
      ) AS conflicting_pair_exists
    FROM requested
  )
  SELECT
    count(*)::integer AS required_count,
    count(*) FILTER (
      WHERE exact_pair_exists AND NOT conflicting_pair_exists
    )::integer AS reused_count,
    count(*) FILTER (
      WHERE NOT exact_pair_exists AND NOT conflicting_pair_exists
    )::integer AS missing_count,
    count(*) FILTER (
      WHERE conflicting_pair_exists
    )::integer AS conflicting_count
  FROM classified
`;

const SEED_STUDENT_SESSIONS_SQL = `
  /* transactional_plan_seed_student_sessions_v1 */
  WITH requested AS MATERIALIZED (
    SELECT seed_id, student_id, device_id
    FROM unnest($1::text[], $2::text[], $3::text[])
      AS requested(seed_id, student_id, device_id)
  ),
  classified AS MATERIALIZED (
    SELECT
      requested.*,
      EXISTS (
        SELECT 1
        FROM student_sessions AS active_session
        WHERE active_session.is_active = true
          AND active_session.student_id = requested.student_id
          AND active_session.device_id = requested.device_id
      ) AS exact_pair_exists,
      EXISTS (
        SELECT 1
        FROM student_sessions AS active_session
        WHERE active_session.is_active = true
          AND (
            (
              active_session.student_id = requested.student_id
              AND active_session.device_id <> requested.device_id
            )
            OR (
              active_session.device_id = requested.device_id
              AND active_session.student_id <> requested.student_id
            )
          )
      ) AS conflicting_pair_exists
    FROM requested
  ),
  inserted AS (
    INSERT INTO student_sessions (
      id,
      student_id,
      device_id,
      started_at,
      last_seen_at,
      ended_at,
      is_active
    )
    SELECT
      classified.seed_id,
      classified.student_id,
      classified.device_id,
      now(),
      now(),
      NULL,
      true
    FROM classified
    WHERE classified.exact_pair_exists = false
      AND classified.conflicting_pair_exists = false
    RETURNING 1
  )
  SELECT
    (SELECT count(*)::integer FROM classified) AS required_count,
    (
      SELECT count(*)::integer
      FROM classified
      WHERE exact_pair_exists = true
        AND conflicting_pair_exists = false
    ) AS reused_count,
    (
      SELECT count(*)::integer
      FROM classified
      WHERE conflicting_pair_exists = true
    ) AS conflicting_count,
    (SELECT count(*)::integer FROM inserted) AS inserted_count
`;

const SEED_GROUP_TEACHER_SQL = `
  /* transactional_plan_seed_group_teacher_v1 */
  WITH inserted AS (
    INSERT INTO group_teachers (
      id,
      group_id,
      teacher_id,
      role,
      assigned_at
    )
    VALUES ($1, $2, $3, 'co-teacher', now())
    RETURNING 1
  )
  SELECT count(*)::integer AS inserted_count FROM inserted
`;

const SEED_TEACHING_SESSION_SQL = `
  /* transactional_plan_seed_teaching_session_v1 */
  WITH inserted AS (
    INSERT INTO teaching_sessions (
      id,
      group_id,
      teacher_id,
      school_id,
      start_time,
      session_mode,
      end_time,
      created_at
    )
    VALUES ($1, $2, $3, $4, now() - interval '1 minute', 'live', NULL, now())
    RETURNING 1
  )
  SELECT count(*)::integer AS inserted_count FROM inserted
`;

const SEED_SUPERVISION_CONTEXT_SQL = `
  /* transactional_plan_seed_supervision_context_v1 */
  WITH inserted AS (
    INSERT INTO classpilot_supervision_contexts (
      id,
      school_id,
      context_type,
      name,
      status,
      assigned_staff_id,
      created_by,
      starts_at,
      ends_at,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      'office',
      'synthetic authorization plan gate',
      'active',
      $3,
      $3,
      now() - interval '1 minute',
      now() + interval '1 hour',
      now(),
      now()
    )
    RETURNING 1
  )
  SELECT count(*)::integer AS inserted_count FROM inserted
`;

const SEED_SUPERVISION_STUDENTS_SQL = `
  /* transactional_plan_seed_supervision_students_v1 */
  WITH requested AS (
    SELECT seed_id, student_id
    FROM unnest($4::text[], $5::text[]) AS requested(seed_id, student_id)
  ),
  inserted AS (
    INSERT INTO classpilot_supervision_students (
      id,
      school_id,
      context_id,
      student_id,
      source,
      assigned_by,
      assigned_at
    )
    SELECT
      requested.seed_id,
      $1,
      $2,
      requested.student_id,
      'authorization_plan_gate',
      $3,
      now()
    FROM requested
    RETURNING 1
  )
  SELECT count(*)::integer AS inserted_count FROM inserted
`;

const TRANSACTIONAL_PLAN_RESIDUE_SQL = `
  /* transactional_plan_residue_v2 */
  SELECT (
    (SELECT count(*) FROM group_teachers WHERE id = $1)
    + (SELECT count(*) FROM teaching_sessions WHERE id = $2)
    + (SELECT count(*) FROM classpilot_supervision_contexts WHERE id = $3)
    + (
      SELECT count(*)
      FROM classpilot_supervision_students
      WHERE context_id = $3
         OR id = ANY($4::text[])
    )
    + (
      SELECT count(*)
      FROM student_sessions
      WHERE id = ANY($5::text[])
    )
  )::integer AS residue_count
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
      WHERE session.id = $5
        AND session.session_mode = 'live'
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
      WHERE session.id = $5
        AND co_teacher.id = $6
        AND session.session_mode = 'live'
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
    WHERE context.id = $5
      AND context.status = 'active'
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
      WHERE candidate.school_id = $2
        AND candidate.staff_id = $3
        AND candidate.student_id = ANY($4::text[])
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

async function configureTransaction(
  client: ClasspilotTilePlanQueryClient
): Promise<void> {
  await client.query(
    "SELECT set_config('statement_timeout', $1, true)",
    [`${STATEMENT_TIMEOUT_MS}ms`]
  );
  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${LOCK_TIMEOUT_MS}ms`]
  );
}

async function configureAdvisoryLockWait(
  client: ClasspilotTilePlanQueryClient
): Promise<void> {
  await client.query(
    "SELECT set_config('statement_timeout', $1, true)",
    [`${ADVISORY_LOCK_STATEMENT_TIMEOUT_MS}ms`]
  );
  await client.query(
    "SELECT set_config('lock_timeout', $1, true)",
    [`${ADVISORY_LOCK_WAIT_TIMEOUT_MS}ms`]
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
  base: TransactionalPlanBase,
  seedIds: TransactionalPlanSeedIds,
  cohortSize: number
): Promise<DiscoveredScenario[]> {
  const discovered: DiscoveredScenario[] = [];
  const missing: ClasspilotTilePlanScenarioLabel[] = [];
  for (const scenario of SCENARIOS) {
    const staffId =
      scenario.kind === "teacher"
        ? base.primaryTeacherId
        : scenario.kind === "co_teacher"
          ? base.coTeacherId
          : base.officeStaffId;
    const studentIds =
      scenario.kind === "office_staff"
        ? base.officeStudentIds
        : base.teacherStudentIds;
    const boundScenarioIds =
      scenario.kind === "teacher"
        ? [seedIds.teachingSessionId]
        : scenario.kind === "co_teacher"
          ? [seedIds.teachingSessionId, seedIds.groupTeacherId]
          : [seedIds.supervisionContextId];
    const result = await client.query<{
      school_id: string;
      staff_id: string;
      student_ids: string[];
    }>(discoverySql(scenario.kind, scenario.mode), [
      cohortSize,
      base.schoolId,
      staffId,
      studentIds,
      ...boundScenarioIds,
    ]);
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      row.school_id !== base.schoolId ||
      row.staff_id !== staffId ||
      !Array.isArray(row.student_ids) ||
      row.student_ids.length !== cohortSize ||
      row.student_ids.some((studentId) => typeof studentId !== "string") ||
      row.student_ids.some((studentId) => !studentIds.includes(studentId)) ||
      new Set(row.student_ids).size !== cohortSize
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
  return discovered;
}

function baseFunnelEvidenceInvalid(): never {
  throw new ClasspilotTileAuthorizationPlanCheckError(
    "base_funnel_evidence_invalid"
  );
}

const BASE_FUNNEL_COUNT_KEYS = [
  "syntheticDescribedGroups",
  "syntheticSchoolGroups",
  "primaryTeacherGroups",
  "licensedGroups",
  "activeRosterStudents",
  "canonicalMappedRosterStudents",
  "unsupervisedRosterStudents",
  "noCoTeacherGroups",
  "exactCohortGroups",
  "eligibleGroupSchools",
  "activeOfficeMemberships",
  "uniqueOfficeMembershipSchools",
  "activeOfficeStudents",
  "canonicalMappedOfficeStudents",
  "unrosteredOfficeStudents",
  "unsupervisedOfficeStudents",
  "officeCohortReadySchools",
  "alternateTeacherReadySchools",
  "eligibleSchools",
  "selectedSchools",
  "selectedGroups",
  "selectedCoTeachers",
  "selectedOfficeStaff",
  "selectedOfficeCohorts",
  "finalBases",
] as const satisfies readonly (
  keyof ClasspilotTileAuthorizationPlanBaseFunnelCounts
)[];

const BASE_FUNNEL_DATABASE_COLUMNS = {
  syntheticDescribedGroups: "synthetic_described_groups",
  syntheticSchoolGroups: "synthetic_school_groups",
  primaryTeacherGroups: "primary_teacher_groups",
  licensedGroups: "licensed_groups",
  activeRosterStudents: "active_roster_students",
  canonicalMappedRosterStudents: "canonical_mapped_roster_students",
  unsupervisedRosterStudents: "unsupervised_roster_students",
  noCoTeacherGroups: "no_co_teacher_groups",
  exactCohortGroups: "exact_cohort_groups",
  eligibleGroupSchools: "eligible_group_schools",
  activeOfficeMemberships: "active_office_memberships",
  uniqueOfficeMembershipSchools: "unique_office_membership_schools",
  activeOfficeStudents: "active_office_students",
  canonicalMappedOfficeStudents: "canonical_mapped_office_students",
  unrosteredOfficeStudents: "unrostered_office_students",
  unsupervisedOfficeStudents: "unsupervised_office_students",
  officeCohortReadySchools: "office_cohort_ready_schools",
  alternateTeacherReadySchools: "alternate_teacher_ready_schools",
  eligibleSchools: "eligible_schools",
  selectedSchools: "selected_schools",
  selectedGroups: "selected_groups",
  selectedCoTeachers: "selected_co_teachers",
  selectedOfficeStaff: "selected_office_staff",
  selectedOfficeCohorts: "selected_office_cohorts",
  finalBases: "final_bases",
} as const satisfies Record<
  keyof ClasspilotTileAuthorizationPlanBaseFunnelCounts,
  string
>;

const BASE_FUNNEL_MAX_COUNT = 1_000_000;

function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactRecordKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    isPlainRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function firstEmptyBaseFunnelStage(
  counts: ClasspilotTileAuthorizationPlanBaseFunnelCounts
): ClasspilotTileAuthorizationPlanBaseFunnelStage {
  return (
    BASE_FUNNEL_COUNT_KEYS.find((key) => counts[key] === 0) ??
    "none"
  );
}

function hasValidBaseFunnelCountRelationships(
  counts: ClasspilotTileAuthorizationPlanBaseFunnelCounts
): boolean {
  return (
    counts.syntheticSchoolGroups <= counts.syntheticDescribedGroups &&
    counts.primaryTeacherGroups <= counts.syntheticSchoolGroups &&
    counts.licensedGroups <= counts.primaryTeacherGroups &&
    counts.canonicalMappedRosterStudents <= counts.activeRosterStudents &&
    counts.unsupervisedRosterStudents <=
      counts.canonicalMappedRosterStudents &&
    counts.noCoTeacherGroups <= counts.licensedGroups &&
    counts.exactCohortGroups <= counts.noCoTeacherGroups &&
    counts.eligibleGroupSchools <= counts.exactCohortGroups &&
    counts.exactCohortGroups *
        CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE <=
      counts.unsupervisedRosterStudents &&
    counts.uniqueOfficeMembershipSchools <= counts.eligibleGroupSchools &&
    counts.uniqueOfficeMembershipSchools <=
      counts.activeOfficeMemberships &&
    counts.canonicalMappedOfficeStudents <= counts.activeOfficeStudents &&
    counts.unrosteredOfficeStudents <=
      counts.canonicalMappedOfficeStudents &&
    counts.unsupervisedOfficeStudents <= counts.unrosteredOfficeStudents &&
    counts.officeCohortReadySchools <= counts.eligibleGroupSchools &&
    counts.alternateTeacherReadySchools <= counts.eligibleGroupSchools &&
    counts.eligibleSchools <= counts.uniqueOfficeMembershipSchools &&
    counts.eligibleSchools <= counts.officeCohortReadySchools &&
    counts.eligibleSchools <= counts.alternateTeacherReadySchools &&
    counts.selectedSchools <= 1 &&
    counts.selectedSchools <= counts.eligibleSchools &&
    counts.selectedGroups <= 1 &&
    counts.selectedGroups <= counts.selectedSchools &&
    counts.selectedCoTeachers <= 1 &&
    counts.selectedCoTeachers <= counts.selectedGroups &&
    counts.selectedOfficeStaff <= 1 &&
    counts.selectedOfficeStaff <= counts.selectedSchools &&
    counts.selectedOfficeCohorts <= 1 &&
    counts.selectedOfficeCohorts <= counts.selectedSchools &&
    counts.finalBases <= 1 &&
    counts.finalBases <= counts.selectedGroups &&
    counts.finalBases <= counts.selectedCoTeachers &&
    counts.finalBases <= counts.selectedOfficeStaff &&
    counts.finalBases <= counts.selectedOfficeCohorts
  );
}

export function validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(
  value: unknown
): ClasspilotTileAuthorizationPlanBaseFunnelEvidence {
  const rootKeys = [
    "cohortSize",
    "counts",
    "failureStage",
    "firstEmptyStage",
    "sessionPosture",
    "version",
  ] as const;
  if (
    !hasExactRecordKeys(value, rootKeys) ||
    value.version !==
      CLASSPILOT_TILE_AUTHORIZATION_PLAN_BASE_FUNNEL_VERSION ||
    typeof value.failureStage !== "string" ||
    !["base_funnel", "base_shape", "session_posture"].includes(
      value.failureStage
    ) ||
    value.cohortSize !== CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE ||
    !hasExactRecordKeys(value.counts, BASE_FUNNEL_COUNT_KEYS)
  ) {
    throw new Error(
      "classpilot_tile_authorization_plan_base_funnel_invalid"
    );
  }

  const countsRecord = value.counts as Record<string, unknown>;
  const counts = Object.fromEntries(
    BASE_FUNNEL_COUNT_KEYS.map((key) => [key, countsRecord[key]])
  ) as ClasspilotTileAuthorizationPlanBaseFunnelCounts;
  if (
    BASE_FUNNEL_COUNT_KEYS.some(
      (key) =>
        !Number.isInteger(counts[key]) ||
        counts[key] < 0 ||
        counts[key] > BASE_FUNNEL_MAX_COUNT
    ) ||
    !hasValidBaseFunnelCountRelationships(counts)
  ) {
    throw new Error(
      "classpilot_tile_authorization_plan_base_funnel_invalid"
    );
  }

  const failureStage = value.failureStage as
    ClasspilotTileAuthorizationPlanBaseFunnelEvidence["failureStage"];
  const expectedFirstEmptyStage = firstEmptyBaseFunnelStage(counts);
  const firstEmptyStage = value.firstEmptyStage;
  if (
    typeof firstEmptyStage !== "string" ||
    ![...BASE_FUNNEL_COUNT_KEYS, "none"].includes(
      firstEmptyStage as ClasspilotTileAuthorizationPlanBaseFunnelStage
    ) ||
    firstEmptyStage !== expectedFirstEmptyStage
  ) {
    throw new Error(
      "classpilot_tile_authorization_plan_base_funnel_invalid"
    );
  }

  let sessionPosture:
    ClasspilotTileAuthorizationPlanBaseFunnelEvidence["sessionPosture"] =
      null;
  if (value.sessionPosture !== null) {
    const sessionKeys = [
      "conflictingSessionPairs",
      "missingSessionPairs",
      "requiredSessionPairs",
      "reusedActiveSessionPairs",
    ] as const;
    if (!hasExactRecordKeys(value.sessionPosture, sessionKeys)) {
      throw new Error(
        "classpilot_tile_authorization_plan_base_funnel_invalid"
      );
    }
    const posture = value.sessionPosture as Record<string, unknown>;
    const requiredSessionPairs = posture.requiredSessionPairs;
    const reusedActiveSessionPairs =
      posture.reusedActiveSessionPairs;
    const missingSessionPairs = posture.missingSessionPairs;
    const conflictingSessionPairs =
      posture.conflictingSessionPairs;
    if (
      !isNonnegativeInteger(requiredSessionPairs) ||
      !isNonnegativeInteger(reusedActiveSessionPairs) ||
      !isNonnegativeInteger(missingSessionPairs) ||
      !isNonnegativeInteger(conflictingSessionPairs) ||
      requiredSessionPairs !== TRANSACTIONAL_PLAN_REQUIRED_SESSION_PAIRS ||
      reusedActiveSessionPairs +
          missingSessionPairs +
          conflictingSessionPairs !==
        requiredSessionPairs
    ) {
      throw new Error(
        "classpilot_tile_authorization_plan_base_funnel_invalid"
      );
    }
    sessionPosture = {
      requiredSessionPairs,
      reusedActiveSessionPairs,
      missingSessionPairs,
      conflictingSessionPairs,
    };
  }

  if (
    (failureStage === "base_funnel" &&
      (counts.finalBases !== 0 ||
        expectedFirstEmptyStage === "none" ||
        sessionPosture !== null)) ||
    (failureStage === "base_shape" &&
      (counts.finalBases !== 1 ||
        expectedFirstEmptyStage !== "none" ||
        sessionPosture !== null)) ||
    (failureStage === "session_posture" &&
      (counts.finalBases !== 1 ||
        expectedFirstEmptyStage !== "none" ||
        sessionPosture === null ||
        sessionPosture.conflictingSessionPairs === 0))
  ) {
    throw new Error(
      "classpilot_tile_authorization_plan_base_funnel_invalid"
    );
  }

  return {
    version: CLASSPILOT_TILE_AUTHORIZATION_PLAN_BASE_FUNNEL_VERSION,
    failureStage,
    firstEmptyStage: expectedFirstEmptyStage,
    cohortSize: CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE,
    counts,
    sessionPosture,
  };
}

function readBaseFunnelCounts(
  row: Record<string, unknown>
): ClasspilotTileAuthorizationPlanBaseFunnelCounts {
  const counts = Object.fromEntries(
    BASE_FUNNEL_COUNT_KEYS.map((key) => [
      key,
      row[BASE_FUNNEL_DATABASE_COLUMNS[key]],
    ])
  ) as ClasspilotTileAuthorizationPlanBaseFunnelCounts;
  if (
    BASE_FUNNEL_COUNT_KEYS.some(
      (key) =>
        !Number.isInteger(counts[key]) ||
        counts[key] < 0 ||
        counts[key] > BASE_FUNNEL_MAX_COUNT
    ) ||
    !hasValidBaseFunnelCountRelationships(counts)
  ) {
    baseFunnelEvidenceInvalid();
  }
  return counts;
}

function createBaseFunnelEvidence(
  counts: ClasspilotTileAuthorizationPlanBaseFunnelCounts,
  failureStage:
    ClasspilotTileAuthorizationPlanBaseFunnelEvidence["failureStage"],
  sessionPosture:
    ClasspilotTileAuthorizationPlanBaseFunnelEvidence["sessionPosture"] =
      null
): ClasspilotTileAuthorizationPlanBaseFunnelEvidence {
  return validateClasspilotTileAuthorizationPlanBaseFunnelEvidence({
    version: CLASSPILOT_TILE_AUTHORIZATION_PLAN_BASE_FUNNEL_VERSION,
    failureStage,
    firstEmptyStage: firstEmptyBaseFunnelStage(counts),
    cohortSize: CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE,
    counts,
    sessionPosture,
  });
}

function baseFunnelFailure(
  counts: ClasspilotTileAuthorizationPlanBaseFunnelCounts,
  failureStage:
    ClasspilotTileAuthorizationPlanBaseFunnelEvidence["failureStage"],
  sessionPosture:
    ClasspilotTileAuthorizationPlanBaseFunnelEvidence["sessionPosture"] =
      null
): never {
  throw new ClasspilotTileAuthorizationPlanCheckError(
    "representative_scenario_missing",
    [],
    0,
    createBaseFunnelEvidence(counts, failureStage, sessionPosture)
  );
}

function requireUniqueStringArray(
  value: unknown,
  expectedLength: number,
  counts: ClasspilotTileAuthorizationPlanBaseFunnelCounts
): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== expectedLength ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    new Set(value).size !== expectedLength
  ) {
    baseFunnelFailure(counts, "base_shape");
  }
  return value;
}

async function readTransactionalPlanBase(
  client: ClasspilotTilePlanQueryClient,
  cohortSize: number
): Promise<{
  base: TransactionalPlanBase;
  funnelCounts: ClasspilotTileAuthorizationPlanBaseFunnelCounts;
}> {
  const result = await client.query<Record<string, unknown>>(
    TRANSACTIONAL_PLAN_BASE_SQL,
    [cohortSize]
  );
  if (result.rows.length !== 1) baseFunnelEvidenceInvalid();
  const row = result.rows[0];
  if (!row) baseFunnelEvidenceInvalid();
  const funnelCounts = readBaseFunnelCounts(row);
  if (funnelCounts.finalBases !== 1) {
    baseFunnelFailure(funnelCounts, "base_funnel");
  }
  if (
    typeof row.school_id !== "string" ||
    row.school_id.length === 0 ||
    typeof row.group_id !== "string" ||
    row.group_id.length === 0 ||
    typeof row.primary_teacher_id !== "string" ||
    row.primary_teacher_id.length === 0 ||
    typeof row.co_teacher_id !== "string" ||
    row.co_teacher_id.length === 0 ||
    typeof row.office_staff_id !== "string" ||
    row.office_staff_id.length === 0 ||
    row.primary_teacher_id === row.co_teacher_id ||
    row.primary_teacher_id === row.office_staff_id ||
    row.co_teacher_id === row.office_staff_id
  ) {
    baseFunnelFailure(funnelCounts, "base_shape");
  }
  const teacherStudentIds = requireUniqueStringArray(
    row.teacher_student_ids,
    cohortSize,
    funnelCounts
  );
  const officeStudentIds = requireUniqueStringArray(
    row.office_student_ids,
    cohortSize,
    funnelCounts
  );
  const teacherDeviceIds = requireUniqueStringArray(
    row.teacher_device_ids,
    cohortSize,
    funnelCounts
  );
  const officeDeviceIds = requireUniqueStringArray(
    row.office_device_ids,
    cohortSize,
    funnelCounts
  );
  if (
    officeStudentIds.some((studentId) =>
      teacherStudentIds.includes(studentId)
    ) ||
    officeDeviceIds.some((deviceId) => teacherDeviceIds.includes(deviceId))
  ) {
    baseFunnelFailure(funnelCounts, "base_shape");
  }
  return {
    base: {
      schoolId: row.school_id,
      groupId: row.group_id,
      primaryTeacherId: row.primary_teacher_id,
      coTeacherId: row.co_teacher_id,
      officeStaffId: row.office_staff_id,
      teacherStudentIds,
      teacherDeviceIds,
      officeStudentIds,
      officeDeviceIds,
    },
    funnelCounts,
  };
}

function createTransactionalPlanSeedIds(
  cohortSize: number,
  requiredSessionPairs = cohortSize * 2
): TransactionalPlanSeedIds {
  return {
    groupTeacherId: randomUUID(),
    teachingSessionId: randomUUID(),
    supervisionContextId: randomUUID(),
    supervisionStudentIds: Array.from(
      { length: cohortSize },
      () => randomUUID()
    ),
    studentSessionIds: Array.from(
      { length: requiredSessionPairs },
      () => randomUUID()
    ),
  };
}

type TransactionalPlanSessionPosture = {
  required: number;
  reused: number;
  missing: number;
  conflicting: number;
};

function transactionalPlanPairs(base: TransactionalPlanBase): {
  studentIds: string[];
  deviceIds: string[];
} {
  return {
    studentIds: [...base.teacherStudentIds, ...base.officeStudentIds],
    deviceIds: [...base.teacherDeviceIds, ...base.officeDeviceIds],
  };
}

function parseSessionPostureResult(
  result: QueryResult<{
    required_count: number | string;
    reused_count: number | string;
    missing_count: number | string;
    conflicting_count: number | string;
  }>,
  funnelCounts: ClasspilotTileAuthorizationPlanBaseFunnelCounts
): TransactionalPlanSessionPosture {
  const required = Number(result.rows[0]?.required_count);
  const reused = Number(result.rows[0]?.reused_count);
  const missing = Number(result.rows[0]?.missing_count);
  const conflicting = Number(result.rows[0]?.conflicting_count);
  if (
    result.rows.length !== 1 ||
    ![required, reused, missing, conflicting].every(
      (value) => Number.isInteger(value) && value >= 0
    ) ||
    required !== TRANSACTIONAL_PLAN_REQUIRED_SESSION_PAIRS ||
    reused + missing + conflicting !== required
  ) {
    baseFunnelEvidenceInvalid();
  }
  if (conflicting !== 0) {
    baseFunnelFailure(funnelCounts, "session_posture", {
      requiredSessionPairs: required,
      reusedActiveSessionPairs: reused,
      missingSessionPairs: missing,
      conflictingSessionPairs: conflicting,
    });
  }
  return { required, reused, missing, conflicting };
}

async function readTransactionalPlanSessionPosture(
  client: ClasspilotTilePlanQueryClient,
  base: TransactionalPlanBase,
  funnelCounts: ClasspilotTileAuthorizationPlanBaseFunnelCounts
): Promise<TransactionalPlanSessionPosture> {
  const pairs = transactionalPlanPairs(base);
  return parseSessionPostureResult(
    await client.query<{
      required_count: number | string;
      reused_count: number | string;
      missing_count: number | string;
      conflicting_count: number | string;
    }>(TRANSACTIONAL_PLAN_SESSION_POSTURE_SQL, [
      pairs.studentIds,
      pairs.deviceIds,
    ]),
    funnelCounts
  );
}

function requireInsertedCount(
  result: QueryResult<{ inserted_count: number | string }>,
  expected: number
): number {
  const insertedCount = Number(result.rows[0]?.inserted_count);
  if (
    result.rows.length !== 1 ||
    !Number.isInteger(insertedCount) ||
    insertedCount !== expected
  ) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "transactional_scenario_lifecycle_failed"
    );
  }
  return insertedCount;
}

async function seedTransactionalPlanScenarios(
  client: ClasspilotTilePlanQueryClient,
  base: TransactionalPlanBase,
  seedIds: TransactionalPlanSeedIds,
  counts: TransactionalPlanSeedCounts,
  expectedSessionPosture: TransactionalPlanSessionPosture
): Promise<number> {
  const pairs = transactionalPlanPairs(base);
  const sessionResult = await client.query<{
    required_count: number | string;
    reused_count: number | string;
    conflicting_count: number | string;
    inserted_count: number | string;
  }>(SEED_STUDENT_SESSIONS_SQL, [
    seedIds.studentSessionIds,
    pairs.studentIds,
    pairs.deviceIds,
  ]);
  const requiredSessionPairs = Number(
    sessionResult.rows[0]?.required_count
  );
  const reusedActiveSessionPairs = Number(
    sessionResult.rows[0]?.reused_count
  );
  const conflictingSessionPairs = Number(
    sessionResult.rows[0]?.conflicting_count
  );
  const insertedSessionPairs = Number(
    sessionResult.rows[0]?.inserted_count
  );
  if (
    sessionResult.rows.length !== 1 ||
    ![
      requiredSessionPairs,
      reusedActiveSessionPairs,
      conflictingSessionPairs,
      insertedSessionPairs,
    ].every((value) => Number.isInteger(value) && value >= 0) ||
    requiredSessionPairs !== TRANSACTIONAL_PLAN_REQUIRED_SESSION_PAIRS ||
    reusedActiveSessionPairs !== expectedSessionPosture.reused ||
    insertedSessionPairs !== expectedSessionPosture.missing ||
    conflictingSessionPairs !== 0 ||
    reusedActiveSessionPairs + insertedSessionPairs !== requiredSessionPairs
  ) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "transactional_scenario_lifecycle_failed"
    );
  }
  counts.studentSessions = insertedSessionPairs;
  counts.total += counts.studentSessions;

  counts.groupTeachers = requireInsertedCount(
    await client.query<{ inserted_count: number | string }>(
      SEED_GROUP_TEACHER_SQL,
      [seedIds.groupTeacherId, base.groupId, base.coTeacherId]
    ),
    1
  );
  counts.total += counts.groupTeachers;

  counts.teachingSessions = requireInsertedCount(
    await client.query<{ inserted_count: number | string }>(
      SEED_TEACHING_SESSION_SQL,
      [
        seedIds.teachingSessionId,
        base.groupId,
        base.primaryTeacherId,
        base.schoolId,
      ]
    ),
    1
  );
  counts.total += counts.teachingSessions;

  counts.supervisionContexts = requireInsertedCount(
    await client.query<{ inserted_count: number | string }>(
      SEED_SUPERVISION_CONTEXT_SQL,
      [
        seedIds.supervisionContextId,
        base.schoolId,
        base.officeStaffId,
      ]
    ),
    1
  );
  counts.total += counts.supervisionContexts;

  counts.supervisionStudents = requireInsertedCount(
    await client.query<{ inserted_count: number | string }>(
      SEED_SUPERVISION_STUDENTS_SQL,
      [
        base.schoolId,
        seedIds.supervisionContextId,
        base.officeStaffId,
        seedIds.supervisionStudentIds,
        base.officeStudentIds,
      ]
    ),
    CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE
  );
  counts.total += counts.supervisionStudents;
  if (counts.total !== 43 + insertedSessionPairs) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "transactional_scenario_lifecycle_failed"
    );
  }
  return reusedActiveSessionPairs;
}

async function runTeachingSessionSchoolPrecheck(
  client: ClasspilotTilePlanQueryClient
): Promise<number> {
  const integrity = await client.query<{ invalid_count: number | string }>(
    TEACHING_SESSION_SCHOOL_PRECHECK_SQL
  );
  const invalidTeachingSessionSchools = Number(
    integrity.rows[0]?.invalid_count
  );
  if (
    integrity.rows.length !== 1 ||
    !Number.isInteger(invalidTeachingSessionSchools) ||
    invalidTeachingSessionSchools < 0
  ) {
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
  return invalidTeachingSessionSchools;
}

async function rollbackRequired(
  client: ClasspilotTilePlanQueryClient
): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

async function verifyTransactionalPlanResidue(
  client: ClasspilotTilePlanQueryClient,
  seedIds: TransactionalPlanSeedIds
): Promise<number> {
  let transactionStarted = false;
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED READ ONLY"
    );
    transactionStarted = true;
    await configureTransaction(client);
    await client.query("SELECT set_config('app.is_super', 'on', true)");
    const result = await client.query<{
      residue_count: number | string;
    }>(TRANSACTIONAL_PLAN_RESIDUE_SQL, [
      seedIds.groupTeacherId,
      seedIds.teachingSessionId,
      seedIds.supervisionContextId,
      seedIds.supervisionStudentIds,
      seedIds.studentSessionIds,
    ]);
    const residueCount = Number(result.rows[0]?.residue_count);
    if (
      result.rows.length !== 1 ||
      !Number.isInteger(residueCount) ||
      residueCount < 0
    ) {
      throw new ClasspilotTileAuthorizationPlanCheckError(
        "transactional_scenario_lifecycle_failed"
      );
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return residueCount;
  } catch (error) {
    if (transactionStarted) await rollbackQuietly(client);
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
  return summarizeClasspilotTilePlanScenario(
    scenario.label,
    scenario.studentIds.length,
    evidence
  );
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
}

export async function runClasspilotTileAuthorizationPlanBasePreflight(options: {
  client: ClasspilotTilePlanQueryClient;
}): Promise<ClasspilotTileAuthorizationPlanBasePreflightReport> {
  let transactionStarted = false;
  let report: ClasspilotTileAuthorizationPlanBasePreflightReport | undefined;
  let primaryError: unknown;
  try {
    await options.client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
    );
    transactionStarted = true;
    await configureTransaction(options.client);
    await options.client.query(
      "SELECT set_config('app.is_super', 'on', true)"
    );
    await runTeachingSessionSchoolPrecheck(options.client);
    const baseEvaluation = await readTransactionalPlanBase(
      options.client,
      CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE
    );
    const posture = await readTransactionalPlanSessionPosture(
      options.client,
      baseEvaluation.base,
      baseEvaluation.funnelCounts
    );
    report = {
      version: TRANSACTIONAL_PLAN_BASE_PREFLIGHT_VERSION,
      status: "passed",
      eligibleBases: 1,
      requiredSessionPairs: posture.required,
      reusedActiveSessionPairs: posture.reused,
      missingSessionPairs: posture.missing,
      conflictingSessionPairs: 0,
    };
  } catch (error) {
    primaryError = error;
  }

  const rollbackCompleted = transactionStarted
    ? await rollbackRequired(options.client)
    : false;
  if (!transactionStarted || !rollbackCompleted) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "transactional_scenario_lifecycle_failed"
    );
  }
  if (primaryError) throw primaryError;
  if (!report) {
    baseFunnelEvidenceInvalid();
  }
  return report;
}

export async function runClasspilotTileAuthorizationPlanCheck(options: {
  client: ClasspilotTilePlanQueryClient;
  residueClient: ClasspilotTilePlanQueryClient;
  buildQuery: ClasspilotTileAuthorizationQueryBuilder;
  buildHistoryQuery: ClasspilotTileHistoryFallbackQueryBuilder;
  samples?: number;
  onLifecycleEvent?: ClasspilotTransactionalPlanScenariosLifecycleListener;
}): Promise<ClasspilotTileAuthorizationPlanReport> {
  if (options.residueClient === options.client) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "invalid_configuration"
    );
  }
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
  const seedIds = createTransactionalPlanSeedIds(
    CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE,
    TRANSACTIONAL_PLAN_REQUIRED_SESSION_PAIRS
  );
  const seededRows: TransactionalPlanSeedCounts = {
    groupTeachers: 0,
    teachingSessions: 0,
    supervisionContexts: 0,
    supervisionStudents: 0,
    studentSessions: 0,
    total: 0,
  };
  let reusedActiveSessionPairs = 0;
  let transactionStartAttempted = false;
  let primaryError: unknown;
  let report: ClasspilotTileAuthorizationPlanReport | undefined;

  try {
    transactionStartAttempted = true;
    await options.client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE"
    );
    // Bound the serialized wait explicitly rather than relying on the
    // connection's ambient role/session posture. Once ownership is acquired,
    // replace this wait budget with the much shorter measurement timeouts.
    await configureAdvisoryLockWait(options.client);
    await options.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [TRANSACTIONAL_PLAN_ADVISORY_LOCK_KEY]
    );
    await configureTransaction(options.client);
    await options.client.query(
      "SELECT set_config('app.is_super', 'on', true)"
    );
    const invalidTeachingSessionSchools =
      await runTeachingSessionSchoolPrecheck(options.client);
    const baseEvaluation = await readTransactionalPlanBase(
      options.client,
      CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE
    );
    const base = baseEvaluation.base;
    const sessionPosture = await readTransactionalPlanSessionPosture(
      options.client,
      base,
      baseEvaluation.funnelCounts
    );
    reusedActiveSessionPairs = sessionPosture.reused;
    reusedActiveSessionPairs = await seedTransactionalPlanScenarios(
      options.client,
      base,
      seedIds,
      seededRows,
      sessionPosture
    );
    const discoveredScenarios = await discoverScenarios(
      options.client,
      base,
      seedIds,
      CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE
    );
    const scenarios: ClasspilotTilePlanScenarioSummary[] = [];
    for (const scenario of discoveredScenarios) {
      scenarios.push(
        await measureScenario(
          options.client,
          options.buildQuery,
          scenario,
          samples
        )
      );
    }
    const historyScenario = discoveredScenarios.find(
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
    report = {
      status:
        scenarios.every((scenario) => scenario.passed) &&
        historyFallback.passed
          ? "passed"
          : "failed",
      precheck: {
        invalidTeachingSessionSchools,
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
  } catch (error) {
    primaryError = error;
  }

  const rollbackAttempted = transactionStartAttempted;
  const rollbackCompleted = transactionStartAttempted
    ? await rollbackRequired(options.client)
    : false;
  let residueChecked = false;
  let residueCount: number | null = null;
  let residueError: unknown;
  if (transactionStartAttempted) {
    try {
      residueCount = await verifyTransactionalPlanResidue(
        options.residueClient,
        seedIds
      );
      residueChecked = true;
    } catch (error) {
      residueError = error;
    }
  }
  const lifecycleEvent: ClasspilotTransactionalPlanScenariosLifecycleEvent = {
    version: TRANSACTIONAL_PLAN_SCENARIO_VERSION,
    requiredSessionPairs: TRANSACTIONAL_PLAN_REQUIRED_SESSION_PAIRS,
    reusedActiveSessionPairs,
    insertedSessionPairs: seededRows.studentSessions,
    seededRows: { ...seededRows },
    rollback: {
      attempted: rollbackAttempted,
      completed: rollbackCompleted,
    },
    residue: {
      checked: residueChecked,
      count: residueCount,
      passed: residueChecked && residueCount === 0,
    },
  };
  let listenerError: unknown;
  if (options.onLifecycleEvent) {
    try {
      await options.onLifecycleEvent(lifecycleEvent);
    } catch (error) {
      listenerError = error;
    }
  }

  if (
    (transactionStartAttempted && !rollbackCompleted) ||
    !residueChecked ||
    residueCount !== 0 ||
    residueError ||
    listenerError
  ) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "transactional_scenario_lifecycle_failed"
    );
  }
  if (primaryError) throw primaryError;
  if (
    !report ||
    seededRows.groupTeachers !== 1 ||
    seededRows.teachingSessions !== 1 ||
    seededRows.supervisionContexts !== 1 ||
    seededRows.supervisionStudents !==
      CLASSPILOT_TILE_AUTHORIZATION_PLAN_COHORT_SIZE ||
    reusedActiveSessionPairs + seededRows.studentSessions !==
      TRANSACTIONAL_PLAN_REQUIRED_SESSION_PAIRS ||
    seededRows.total !== 43 + seededRows.studentSessions
  ) {
    throw new ClasspilotTileAuthorizationPlanCheckError(
      "transactional_scenario_lifecycle_failed"
    );
  }
  return report;
}
