import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  index,
  unique,
  uniqueIndex,
  check,
  foreignKey,
  primaryKey,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import { students } from "./students.js";

// PassPilot issuance-rule vocabulary (PASSPILOT_RULES_MODE). The SQL CHECK
// constraints in src/db/passpilotRulesMigration.ts use the same literals.
export const PASSPILOT_RULE_CODES = [
  "PASSPILOT_RULE_DAILY_LIMIT",
  "PASSPILOT_RULE_PERIOD_LIMIT",
  "PASSPILOT_RULE_DESTINATION_CAPACITY",
  "PASSPILOT_RULE_ENCOUNTER",
] as const;
export type PasspilotRuleCode = (typeof PASSPILOT_RULE_CODES)[number];
// Capacity applies to the enumerated destinations only; a free-text custom
// destination has no shared room to fill.
export const PASSPILOT_RULE_DESTINATIONS = [
  "bathroom",
  "nurse",
  "office",
  "counselor",
  "other_classroom",
] as const;
export type PasspilotRuleDestination = (typeof PASSPILOT_RULE_DESTINATIONS)[number];

// ============================================================================
// Grades (classes / periods) - PassPilot
// ============================================================================
export const grades = pgTable(
  "grades",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    name: text("name").notNull(),
    displayOrder: integer("display_order").notNull().default(0),
    classpilotGroupId: text("classpilot_group_id"),
    migrationState: text("migration_state")
      .notNull()
      .default("pending")
      .$type<"pending" | "auto_linked" | "confirmed" | "history_only">(),
    mappingRevision: integer("mapping_revision").notNull().default(0),
    mappingMethod: text("mapping_method"),
    mappingReviewerId: text("mapping_reviewer_id"),
    mappedAt: timestamp("mapped_at", { withTimezone: true }),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("grades_school_id_idx").on(table.schoolId),
    unique("grades_school_id_id_unique").on(table.schoolId, table.id),
    index("grades_school_classpilot_group_idx").on(
      table.schoolId,
      table.classpilotGroupId
    ),
    index("grades_school_migration_state_idx").on(
      table.schoolId,
      table.migrationState
    ),
    check(
      "grades_migration_state_check",
      sql`${table.migrationState} IN ('pending', 'auto_linked', 'confirmed', 'history_only')`
    ),
    check(
      "grades_mapping_revision_check",
      sql`${table.mappingRevision} >= 0`
    ),
  ]
);

export type Grade = typeof grades.$inferSelect;
export type InsertGrade = typeof grades.$inferInsert;

// ============================================================================
// Teacher-Grade assignments - PassPilot
// ============================================================================
export const teacherGrades = pgTable(
  "teacher_grades",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    teacherId: text("teacher_id").notNull(),
    gradeId: text("grade_id").notNull(),
    assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("teacher_grades_unique").on(table.teacherId, table.gradeId),
  ]
);

export type TeacherGrade = typeof teacherGrades.$inferSelect;
export type InsertTeacherGrade = typeof teacherGrades.$inferInsert;

// ============================================================================
// Student-Class memberships - PassPilot legacy/standalone class model
// ============================================================================
// `students.grade_id` remains as a deprecated single-class compatibility
// projection. This tenant-scoped junction is the source of truth for new
// legacy-mode roster operations and permits a student to belong to many
// PassPilot classes without affecting canonical ClassPilot group rosters.
export const passpilotGradeStudents = pgTable(
  "passpilot_grade_students",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    gradeId: text("grade_id").notNull(),
    studentId: text("student_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    unique("passpilot_grade_students_school_grade_student_unique").on(
      table.schoolId,
      table.gradeId,
      table.studentId
    ),
    index("passpilot_grade_students_school_grade_idx").on(
      table.schoolId,
      table.gradeId
    ),
    index("passpilot_grade_students_school_student_idx").on(
      table.schoolId,
      table.studentId
    ),
    foreignKey({
      columns: [table.schoolId, table.gradeId],
      foreignColumns: [grades.schoolId, grades.id],
      name: "passpilot_grade_students_grade_school_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.schoolId, table.studentId],
      foreignColumns: [students.schoolId, students.id],
      name: "passpilot_grade_students_student_school_fk",
    }).onDelete("cascade"),
  ]
);

export type PasspilotGradeStudent = typeof passpilotGradeStudents.$inferSelect;
export type InsertPasspilotGradeStudent = typeof passpilotGradeStudents.$inferInsert;

// ============================================================================
// Passes - PassPilot hall passes
// ============================================================================
export const passes = pgTable(
  "passes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id").notNull(),
    teacherId: text("teacher_id"), // Null for kiosk self-checkout
    gradeId: text("grade_id"),
    classpilotGroupId: text("classpilot_group_id"),
    classNameSnapshot: text("class_name_snapshot"),
    supervisionContextId: text("supervision_context_id"),
    activityKind: text("activity_kind").$type<"testing" | "coverage" | null>(),
    activityNameSnapshot: text("activity_name_snapshot"),
    issuingKioskSessionId: text("issuing_kiosk_session_id"),
    destination: text("destination").notNull(), // bathroom | nurse | office | counselor | other_classroom | custom
    customDestination: text("custom_destination"),
    // `expired` is retained for historical rows only. Runtime passes remain
    // active past their threshold until explicitly returned or canceled.
    status: text("status").notNull().default("active"), // active | returned | expired | canceled
    issuedAt: timestamp("issued_at").notNull().default(sql`now()`),
    duration: integer("duration").notNull().default(5), // overdue threshold in minutes
    expiresAt: timestamp("expires_at").notNull(), // derived overdue threshold; not an automatic transition
    returnedAt: timestamp("returned_at"),
    issuedVia: text("issued_via").notNull().default("teacher"), // teacher | kiosk
    notes: text("notes"),
    // Set only when an administrator overrode exactly one issuance rule.
    ruleOverrideCode: text("rule_override_code").$type<PasspilotRuleCode>(),
  },
  (table) => [
    index("passes_kiosk_teacher_active_idx").on(table.schoolId, table.teacherId).where(sql`${table.status}='active' AND ${table.issuedVia}='kiosk'`),
    check("passes_activity_shape_check", sql`(${table.supervisionContextId} IS NULL AND ${table.activityKind} IS NULL AND ${table.activityNameSnapshot} IS NULL)
      OR (${table.supervisionContextId} IS NOT NULL AND ${table.activityKind} IS NOT NULL AND ${table.activityKind} IN ('testing','coverage')
        AND ${table.activityNameSnapshot} IS NOT NULL AND ${table.gradeId} IS NULL AND ${table.classpilotGroupId} IS NULL)`),
    index("passes_school_id_idx").on(table.schoolId),
    index("passes_student_id_idx").on(table.studentId),
    unique("passes_school_student_id_unique").on(table.schoolId, table.studentId, table.id),
    index("passes_teacher_id_idx").on(table.teacherId),
    index("passes_status_idx").on(table.status),
    uniqueIndex("passes_one_active_per_student")
      .on(table.studentId, table.schoolId)
      .where(sql`${table.status} = 'active'`),
    index("passes_issued_at_idx").on(table.issuedAt),
    index("passes_school_classpilot_group_status_idx").on(
      table.schoolId,
      table.classpilotGroupId,
      table.status
    ),
    index("passes_school_classpilot_group_issued_idx").on(
      table.schoolId,
      table.classpilotGroupId,
      table.issuedAt
    ),
    check(
      "passes_single_class_source_check",
      sql`NOT (${table.gradeId} IS NOT NULL AND ${table.classpilotGroupId} IS NOT NULL)`
    ),
    // Issuance-rule counting reads: per-student daily/period counts and
    // per-destination active capacity. Production builds both CONCURRENTLY
    // (passpilotRulesIndexesMigration); the names must match that migration.
    index("passes_school_student_issued_idx").on(
      table.schoolId,
      table.studentId,
      table.issuedAt
    ),
    index("passes_school_destination_active_idx")
      .on(table.schoolId, table.destination)
      .where(sql`${table.status} = 'active'`),
    check(
      "passes_rule_override_code_check",
      sql`${table.ruleOverrideCode} IS NULL OR ${table.ruleOverrideCode} IN ('PASSPILOT_RULE_DAILY_LIMIT','PASSPILOT_RULE_PERIOD_LIMIT','PASSPILOT_RULE_DESTINATION_CAPACITY','PASSPILOT_RULE_ENCOUNTER')`
    ),
  ]
);

export type Pass = typeof passes.$inferSelect;
export type InsertPass = typeof passes.$inferInsert;

// ============================================================================
// Kiosk sessions - PassPilot (per-device, teacher-bound)
// ============================================================================
// Replaces the school-global kiosk slot (schools.kiosk_grade_id /
// kiosk_classpilot_group_id) with one row per kiosk device. A kiosk boots
// unclaimed with a 6-digit claim code; a teacher claims it from their
// authenticated session, binding (teacher, class). No FKs to
// grades/groups/users — sessions are ephemeral device bindings; class and
// teacher liveness are validated at claim/read time.
export const passpilotKioskSessions = pgTable(
  "passpilot_kiosk_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    claimCode: text("claim_code").notNull(),
    teacherId: text("teacher_id"),
    classSource: text("class_source").$type<
      "legacy_grades" | "classpilot_groups" | null
    >(),
    gradeId: text("grade_id"),
    classpilotGroupId: text("classpilot_group_id"),
    status: text("status")
      .notNull()
      .default("unclaimed")
      .$type<"unclaimed" | "active" | "released">(),
    // Durable kiosk-device identity presented via X-Kiosk-Device. Nullable —
    // old clients never send one. Links the ephemeral session to the durable
    // passpilot_kiosk_devices binding so teacher-side claims/retargets know
    // which device to remember.
    deviceId: text("device_id"),
    revision: integer("revision").notNull().default(0),
    overrideStartedAt: timestamp("override_started_at", { withTimezone: true }),
    overrideExpiresAt: timestamp("override_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    unique("pp_kiosk_sessions_school_id_fk_key").on(table.schoolId, table.id),
    uniqueIndex("pp_kiosk_sessions_school_claim_code_unique")
      .on(table.schoolId, table.claimCode)
      .where(sql`${table.status} <> 'released'`),
    index("pp_kiosk_sessions_school_teacher_status_idx").on(
      table.schoolId,
      table.teacherId,
      table.status
    ),
    index("pp_kiosk_sessions_school_status_last_seen_idx").on(
      table.schoolId,
      table.status,
      table.lastSeenAt
    ),
    index("pp_kiosk_sessions_school_device_idx")
      .on(table.schoolId, table.deviceId)
      .where(sql`${table.deviceId} IS NOT NULL`),
    check(
      "pp_kiosk_sessions_status_check",
      sql`${table.status} IN ('unclaimed', 'active', 'released')`
    ),
    check("pp_kiosk_sessions_revision_check", sql`${table.revision} >= 0`),
    check(
      "pp_kiosk_sessions_class_source_check",
      sql`${table.classSource} IS NULL OR ${table.classSource} IN ('legacy_grades', 'classpilot_groups')`
    ),
    check(
      "pp_kiosk_sessions_single_class_check",
      sql`NOT (${table.gradeId} IS NOT NULL AND ${table.classpilotGroupId} IS NOT NULL)`
    ),
    check(
      "pp_kiosk_sessions_unclaimed_shape_check",
      sql`${table.status} <> 'unclaimed' OR (${table.teacherId} IS NULL AND ${table.classSource} IS NULL AND ${table.gradeId} IS NULL AND ${table.classpilotGroupId} IS NULL)`
    ),
    check(
      "pp_kiosk_sessions_active_shape_check",
      sql`${table.status} <> 'active' OR (${table.teacherId} IS NOT NULL AND ((${table.classSource} IS NULL AND ${table.gradeId} IS NULL AND ${table.classpilotGroupId} IS NULL) OR (${table.classSource} = 'legacy_grades' AND ${table.gradeId} IS NOT NULL AND ${table.classpilotGroupId} IS NULL) OR (${table.classSource} = 'classpilot_groups' AND ${table.classpilotGroupId} IS NOT NULL AND ${table.gradeId} IS NULL)))`
    ),
  ]
);

export type KioskSession = typeof passpilotKioskSessions.$inferSelect;
export type InsertKioskSession = typeof passpilotKioskSessions.$inferInsert;

// ============================================================================
// Kiosk device bindings - PassPilot (durable device → teacher memory)
// ============================================================================
// One row per physical kiosk device: remembers which teacher (and class) last
// ran a kiosk there so the device can offer a one-tap PIN-gated resume the
// next morning, instead of a fresh claim code. The id is CLIENT-generated
// (crypto.randomUUID in localStorage) — hence the composite primary key: ids
// are scoped per school so a hostile client can never squat another tenant's
// device id. Non-authoritative memory only: teacher membership and class
// authorization are re-validated on every resume; no FKs by design.
export const passpilotKioskDevices = pgTable(
  "passpilot_kiosk_devices",
  {
    id: varchar("id").notNull(),
    schoolId: text("school_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    classSource: text("class_source").$type<
      "legacy_grades" | "classpilot_groups" | null
    >(),
    gradeId: text("grade_id"),
    classpilotGroupId: text("classpilot_group_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    primaryKey({
      name: "pp_kiosk_devices_pkey",
      columns: [table.schoolId, table.id],
    }),
    index("pp_kiosk_devices_school_last_used_idx").on(
      table.schoolId,
      table.lastUsedAt
    ),
    check(
      "pp_kiosk_devices_class_source_check",
      sql`${table.classSource} IS NULL OR ${table.classSource} IN ('legacy_grades', 'classpilot_groups')`
    ),
    check(
      "pp_kiosk_devices_class_shape_check",
      sql`(${table.classSource} IS NULL AND ${table.gradeId} IS NULL AND ${table.classpilotGroupId} IS NULL) OR (${table.classSource} = 'legacy_grades' AND ${table.gradeId} IS NOT NULL AND ${table.classpilotGroupId} IS NULL) OR (${table.classSource} = 'classpilot_groups' AND ${table.classpilotGroupId} IS NOT NULL AND ${table.gradeId} IS NULL)`
    ),
  ]
);

export type KioskDeviceBinding = typeof passpilotKioskDevices.$inferSelect;
export type InsertKioskDeviceBinding = typeof passpilotKioskDevices.$inferInsert;

export const passpilotTeacherKioskSettings = pgTable("passpilot_teacher_kiosk_settings", {
  schoolId: text("school_id").notNull().references(() => schools.id),
  teacherId: text("teacher_id").notNull().references(() => users.id),
  mode: text("mode").notNull().default("manual").$type<import("../services/passpilotKioskSchedule.js").KioskMode>(),
  schedule: jsonb("schedule").notNull().default(sql`'{"blocks":[],"exceptions":[]}'::jsonb`)
    .$type<import("../services/passpilotKioskSchedule.js").KioskSchedule>(),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, table => [primaryKey({ columns: [table.schoolId, table.teacherId] }),
  check("pp_teacher_kiosk_schedule_check", sql`jsonb_typeof(${table.schedule}) = 'object'`),
  check("pp_teacher_kiosk_mode_check", sql`${table.mode} IN ('manual','passpilot','classpilot')`),
  check("pp_teacher_kiosk_revision_check", sql`${table.revision} >= 0`)]);

// ============================================================================
// Issuance rules - PassPilot (PASSPILOT_RULES_MODE, default off)
// ============================================================================
// Tenant tables created by src/db/passpilotRulesMigration.ts. The Drizzle
// declarations mirror every constraint and index by name because a pushed
// table turns the migration's CREATE TABLE IF NOT EXISTS into a no-op.

// One capacity policy per school and enumerated destination.
export const passpilotDestinationPolicies = pgTable(
  "passpilot_destination_policies",
  {
    schoolId: text("school_id").notNull(),
    destination: text("destination").notNull().$type<PasspilotRuleDestination>(),
    maxConcurrent: integer("max_concurrent").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    primaryKey({
      name: "passpilot_destination_policies_pkey",
      columns: [table.schoolId, table.destination],
    }),
    foreignKey({
      columns: [table.schoolId],
      foreignColumns: [schools.id],
      name: "pp_destination_policies_school_fk",
    }),
    check(
      "pp_destination_policies_destination_check",
      sql`${table.destination} IN ('bathroom','nurse','office','counselor','other_classroom')`
    ),
    check(
      "pp_destination_policies_max_concurrent_check",
      sql`${table.maxConcurrent} BETWEEN 1 AND 500`
    ),
  ]
);

export type PasspilotDestinationPolicy = typeof passpilotDestinationPolicies.$inferSelect;

// A NULL student_id row is the school default; a student row overrides the
// default field by field. At most one of each per school.
export const passpilotPassLimits = pgTable(
  "passpilot_pass_limits",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id"),
    dailyLimit: integer("daily_limit"),
    periodLimit: integer("period_limit"),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.schoolId],
      foreignColumns: [schools.id],
      name: "pp_pass_limits_school_fk",
    }),
    foreignKey({
      columns: [table.schoolId, table.studentId],
      foreignColumns: [students.schoolId, students.id],
      name: "pp_pass_limits_student_school_fk",
    }).onDelete("cascade"),
    check(
      "pp_pass_limits_daily_check",
      sql`${table.dailyLimit} IS NULL OR ${table.dailyLimit} BETWEEN 0 AND 50`
    ),
    check(
      "pp_pass_limits_period_check",
      sql`${table.periodLimit} IS NULL OR ${table.periodLimit} BETWEEN 0 AND 50`
    ),
    check(
      "pp_pass_limits_any_limit_check",
      sql`${table.dailyLimit} IS NOT NULL OR ${table.periodLimit} IS NOT NULL`
    ),
    uniqueIndex("pp_pass_limits_school_default_unique")
      .on(table.schoolId)
      .where(sql`${table.studentId} IS NULL`),
    uniqueIndex("pp_pass_limits_school_student_unique")
      .on(table.schoolId, table.studentId)
      .where(sql`${table.studentId} IS NOT NULL`),
  ]
);

export type PasspilotPassLimit = typeof passpilotPassLimits.$inferSelect;

// Student pairs that may not hold overlapping active passes. The pair is
// stored canonically (student_a_id < student_b_id under the C collation).
export const passpilotEncounterRestrictions = pgTable(
  "passpilot_encounter_restrictions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentAId: text("student_a_id").notNull(),
    studentBId: text("student_b_id").notNull(),
    reasonNote: text("reason_note"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.schoolId],
      foreignColumns: [schools.id],
      name: "pp_encounter_restrictions_school_fk",
    }),
    foreignKey({
      columns: [table.schoolId, table.studentAId],
      foreignColumns: [students.schoolId, students.id],
      name: "pp_encounter_restrictions_student_a_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.schoolId, table.studentBId],
      foreignColumns: [students.schoolId, students.id],
      name: "pp_encounter_restrictions_student_b_fk",
    }).onDelete("cascade"),
    unique("pp_encounter_restrictions_pair_unique").on(
      table.schoolId,
      table.studentAId,
      table.studentBId
    ),
    index("pp_encounter_restrictions_school_student_b_idx").on(
      table.schoolId,
      table.studentBId
    ),
    check(
      "pp_encounter_restrictions_pair_order_check",
      sql`${table.studentAId} COLLATE "C" < ${table.studentBId} COLLATE "C"`
    ),
    check(
      "pp_encounter_restrictions_note_check",
      sql`${table.reasonNote} IS NULL OR char_length(${table.reasonNote}) <= 500`
    ),
  ]
);

export type PasspilotEncounterRestriction = typeof passpilotEncounterRestrictions.$inferSelect;

export type PasspilotRuleIssuanceChannel = "teacher" | "kiosk" | "ai";
export type PasspilotRuleWindowKind = "day" | "bell_period" | "class_window" | "kiosk_block";
// Counts and window labels only. Encounter denials store the restriction id,
// never the other student's id or name.
export type PasspilotRuleDenialDetails = {
  count?: number;
  limit?: number;
  windowLabel?: string | null;
  windowStartsAt?: string;
  windowEndsAt?: string;
  restrictionId?: string;
};

// Best-effort record of each rule denial (and of each administrator
// override). Attribution columns mirror passes so later reports can apply the
// pass-history scope. Purged after 400 days by purgePasspilotPassDenials.
export const passpilotPassDenials = pgTable(
  "passpilot_pass_denials",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id").notNull(),
    destination: text("destination").notNull(),
    ruleCode: text("rule_code").notNull().$type<PasspilotRuleCode>(),
    issuedVia: text("issued_via").notNull().$type<PasspilotRuleIssuanceChannel>(),
    actorUserId: text("actor_user_id"),
    teacherId: text("teacher_id"),
    classSource: text("class_source").$type<"legacy_grades" | "classpilot_groups" | null>(),
    gradeId: text("grade_id"),
    classpilotGroupId: text("classpilot_group_id"),
    supervisionContextId: text("supervision_context_id"),
    issuingKioskSessionId: text("issuing_kiosk_session_id"),
    windowKind: text("window_kind").$type<PasspilotRuleWindowKind | null>(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`).$type<PasspilotRuleDenialDetails>(),
    overridden: boolean("overridden").notNull().default(false),
    deniedAt: timestamp("denied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.schoolId],
      foreignColumns: [schools.id],
      name: "pp_pass_denials_school_fk",
    }),
    foreignKey({
      columns: [table.schoolId, table.studentId],
      foreignColumns: [students.schoolId, students.id],
      name: "pp_pass_denials_student_school_fk",
    }).onDelete("cascade"),
    index("pp_pass_denials_school_denied_idx").on(table.schoolId, table.deniedAt),
    index("pp_pass_denials_school_student_denied_idx").on(
      table.schoolId,
      table.studentId,
      table.deniedAt
    ),
    check(
      "pp_pass_denials_destination_check",
      sql`${table.destination} IN ('bathroom','nurse','office','counselor','other_classroom','custom')`
    ),
    check(
      "pp_pass_denials_rule_code_check",
      sql`${table.ruleCode} IN ('PASSPILOT_RULE_DAILY_LIMIT','PASSPILOT_RULE_PERIOD_LIMIT','PASSPILOT_RULE_DESTINATION_CAPACITY','PASSPILOT_RULE_ENCOUNTER')`
    ),
    check(
      "pp_pass_denials_issued_via_check",
      sql`${table.issuedVia} IN ('teacher','kiosk','ai')`
    ),
    check(
      "pp_pass_denials_class_source_check",
      sql`${table.classSource} IS NULL OR ${table.classSource} IN ('legacy_grades','classpilot_groups')`
    ),
    check(
      "pp_pass_denials_single_class_check",
      sql`NOT (${table.gradeId} IS NOT NULL AND ${table.classpilotGroupId} IS NOT NULL)`
    ),
    check(
      "pp_pass_denials_window_kind_check",
      sql`${table.windowKind} IS NULL OR ${table.windowKind} IN ('day','bell_period','class_window','kiosk_block')`
    ),
    check(
      "pp_pass_denials_details_check",
      sql`jsonb_typeof(${table.details}) = 'object'`
    ),
  ]
);

export type PasspilotPassDenial = typeof passpilotPassDenials.$inferSelect;
export type InsertPasspilotPassDenial = typeof passpilotPassDenials.$inferInsert;
