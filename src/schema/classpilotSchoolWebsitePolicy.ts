import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, uniqueIndex, index, foreignKey, check } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import { students } from "./students.js";
import { studentSessions } from "./classpilot.js";

export const classpilotSchoolWebsitePolicies = pgTable("classpilot_school_website_policies", {
  schoolId: text("school_id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
}, (table) => [
  foreignKey({name:"classpilot_school_website_policies_school_id_fkey",columns:[table.schoolId],foreignColumns:[schools.id]}).onDelete("cascade"),
  check("classpilot_school_website_policies_revision_check", sql`${table.revision} >= 0`),
]);

export const classpilotSchoolWebsiteDeliveries = pgTable("classpilot_school_website_deliveries", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  schoolId: text("school_id").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  studentId: text("student_id").notNull(),
  studentSessionId: text("student_session_id").notNull(),
  deviceId: text("device_id").notNull(),
  status: text("status").notNull().default("pending"),
  closedTabCount: integer("closed_tab_count").notNull().default(0),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("cp_school_website_delivery_exact_idx").on(table.schoolId, table.policyRevision, table.studentSessionId),
  index("cp_school_website_delivery_status_idx").on(table.schoolId, table.policyRevision, table.status),
  foreignKey({name:"classpilot_school_website_deliveries_school_id_fkey",columns:[table.schoolId],foreignColumns:[schools.id]}).onDelete("cascade"),
  foreignKey({name:"classpilot_school_website_deliveries_student_id_fkey",columns:[table.studentId],foreignColumns:[students.id]}).onDelete("cascade"),
  foreignKey({name:"classpilot_school_website_deliveries_student_session_id_fkey",columns:[table.studentSessionId],foreignColumns:[studentSessions.id]}).onDelete("cascade"),
  check("classpilot_school_website_deliveries_policy_revision_check", sql`${table.policyRevision} >= 0`),
  check("classpilot_school_website_deliveries_status_check", sql`${table.status} IN ('pending','applied','failed')`),
  check("classpilot_school_website_deliveries_closed_tab_count_check", sql`${table.closedTabCount} BETWEEN 0 AND 1000`),
]);
