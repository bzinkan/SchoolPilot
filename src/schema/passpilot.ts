import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";

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
