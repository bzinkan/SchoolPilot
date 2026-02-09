import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ============================================================================
// Students - Unified across all products
// ============================================================================
export const students = pgTable(
  "students",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    emailLc: text("email_lc"), // Lowercase for case-insensitive lookups
    googleUserId: text("google_user_id"),
    photoUrl: text("photo_url"),
    gradeLevel: text("grade_level"), // K, 1, 2, ..., 12

    // PassPilot fields
    studentIdNumber: text("student_id_number"), // Badge/barcode ID
    gradeId: text("grade_id"), // FK to grades (PassPilot class assignment)

    // GoPilot fields
    homeroomId: text("homeroom_id"), // FK to homerooms
    dismissalType: text("dismissal_type").default("car"), // car | bus | walker
    busRoute: text("bus_route"),
    studentCode: text("student_code"), // GoPilot numeric car-rider code
    externalId: text("external_id"), // SIS integration ID

    // ClassPilot fields
    deviceId: text("device_id"), // Legacy FK to devices (ClassPilot)
    studentStatus: text("student_status"), // ClassPilot-specific status

    // Common
    status: text("status").notNull().default("active"), // active | inactive
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("students_school_id_idx").on(table.schoolId),
    index("students_grade_id_idx").on(table.gradeId),
    index("students_homeroom_id_idx").on(table.homeroomId),
    index("students_school_email_idx").on(table.schoolId, table.emailLc),
    index("students_last_first_idx").on(table.lastName, table.firstName),
    uniqueIndex("students_school_id_number_unique")
      .on(table.schoolId, table.studentIdNumber)
      .where(sql`student_id_number IS NOT NULL`),
    uniqueIndex("students_school_code_unique")
      .on(table.schoolId, table.studentCode)
      .where(sql`student_code IS NOT NULL`),
    uniqueIndex("students_school_email_unique")
      .on(table.schoolId, table.emailLc)
      .where(sql`email_lc IS NOT NULL`),
  ]
);

export type Student = typeof students.$inferSelect;
export type InsertStudent = typeof students.$inferInsert;
