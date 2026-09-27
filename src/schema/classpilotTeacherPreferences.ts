import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";

/** Personal classroom-control defaults. Null means inherit this school's value. */
export const classpilotTeacherPreferences = pgTable("classpilot_teacher_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().references(() => schools.id),
  teacherId: text("teacher_id").notNull().references(() => users.id),
  maxTabsPerStudent: integer("max_tabs_per_student"),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("classpilot_teacher_preferences_owner").on(table.schoolId, table.teacherId),
  check("classpilot_teacher_preferences_bounds", sql`${table.revision} > 0 AND (${table.maxTabsPerStudent} IS NULL OR ${table.maxTabsPerStudent} BETWEEN 1 AND 100)`),
]);
