import { sql } from "drizzle-orm";
import { pgTable, text, integer, jsonb, timestamp, check } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import type { SchoolSchedulingConfig } from "../services/classpilotSchedulingRules.js";

/** One revisioned document keeps profile/period/date references atomic. */
export const classpilotSchoolSchedules = pgTable("classpilot_school_schedules", {
  schoolId: text("school_id").primaryKey().references(() => schools.id),
  revision: integer("revision").notNull().default(0),
  config: jsonb("config").notNull().$type<SchoolSchedulingConfig>(),
  profileActivationOutcomes: jsonb("profile_activation_outcomes").notNull().default(sql`'{}'::jsonb`)
    .$type<Record<string, import("../services/classpilotScheduleProfileSupervision.js").ProfileSupervisionOutcome>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedBy: text("updated_by"),
}, (table) => [check("cp_schedule_profile_outcomes_object_check", sql`jsonb_typeof(${table.profileActivationOutcomes}) = 'object'`)]);
