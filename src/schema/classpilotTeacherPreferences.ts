import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import type { DashboardTheme } from "../services/classpilotThemes.js";

/**
 * Personal classroom-control defaults. Null means inherit this school's value;
 * the presentation-only dashboard theme is null for the default look.
 */
export const classpilotTeacherPreferences = pgTable("classpilot_teacher_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().references(() => schools.id),
  teacherId: text("teacher_id").notNull().references(() => users.id),
  maxTabsPerStudent: integer("max_tabs_per_student"),
  dashboardTheme: jsonb("dashboard_theme").$type<DashboardTheme | null>(),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("classpilot_teacher_preferences_owner").on(table.schoolId, table.teacherId),
  check("classpilot_teacher_preferences_bounds", sql`${table.revision} > 0 AND (${table.maxTabsPerStudent} IS NULL OR ${table.maxTabsPerStudent} BETWEEN 1 AND 100)`),
  check("classpilot_teacher_preferences_dashboard_theme_object", sql`${table.dashboardTheme} IS NULL OR jsonb_typeof(${table.dashboardTheme}) = 'object'`),
]);
