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
} from "drizzle-orm/pg-core";
import { students } from "./students.js";

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
    destination: text("destination").notNull(), // bathroom | nurse | office | counselor | other_classroom | custom
    customDestination: text("custom_destination"),
    status: text("status").notNull().default("active"), // active | returned | expired | canceled
    issuedAt: timestamp("issued_at").notNull().default(sql`now()`),
    duration: integer("duration").notNull().default(5), // minutes
    expiresAt: timestamp("expires_at").notNull(),
    returnedAt: timestamp("returned_at"),
    issuedVia: text("issued_via").notNull().default("teacher"), // teacher | kiosk
    notes: text("notes"),
  },
  (table) => [
    index("passes_school_id_idx").on(table.schoolId),
    index("passes_student_id_idx").on(table.studentId),
    index("passes_teacher_id_idx").on(table.teacherId),
    index("passes_status_idx").on(table.status),
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
    revision: integer("revision").notNull().default(0),
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
