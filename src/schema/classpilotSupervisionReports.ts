import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, boolean, jsonb, uniqueIndex, index, check, foreignKey } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import { classpilotSupervisionContexts } from "./classpilot.js";
import type { ClasspilotSessionReport } from "./classpilot.js";

export type SupervisionParticipationInterval = { assignmentId: string; start: string; end: string | null };

// A segment is an immutable staff tenure, not a teaching session. Active student
// intervals are accumulated here before the report is frozen at closure.
export const classpilotSupervisionReportSegments = pgTable("classpilot_supervision_report_segments", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  schoolId: text("school_id").notNull(), contextId: text("context_id").notNull(),
  staffId: text("staff_id"), staffNameSnapshot: text("staff_name_snapshot"),
  contextNameSnapshot: text("context_name_snapshot"), contextType: text("context_type").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }),
  state: text("state").notNull().default("active"), closureReason: text("closure_reason"),
  partialAdoption: boolean("partial_adoption").notNull().default(false),
  timezone: text("timezone").notNull(), trackingPolicy: jsonb("tracking_policy").$type<ClasspilotSessionReport["trackingPolicy"]>(),
  retentionHours: integer("retention_hours").notNull().default(720), reportVersion: integer("report_version").notNull().default(2),
  summary: jsonb("summary").$type<Record<string, unknown>>(),
  settleAt: timestamp("settle_at", { withTimezone: true }), nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0), leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), lastError: text("last_error"),
  materializedAt: timestamp("materialized_at", { withTimezone: true }), expiresAt: timestamp("expires_at", { withTimezone: true }),
  detailExpiredAt: timestamp("detail_expired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("cp_supervision_report_school_id_unique").on(table.schoolId, table.id),
  uniqueIndex("cp_supervision_report_active_context_unique").on(table.schoolId, table.contextId).where(sql`${table.state} = 'active'`),
  index("cp_supervision_report_context_idx").on(table.schoolId, table.contextId),
  index("cp_supervision_report_staff_idx").on(table.schoolId, table.staffId, table.windowStart),
  index("cp_supervision_report_due_idx").on(table.state, table.nextAttemptAt),
  index("cp_supervision_report_retention_idx").on(table.expiresAt),
  foreignKey({ name: "cp_supervision_report_school_fk", columns: [table.schoolId], foreignColumns: [schools.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_supervision_report_context_fk", columns: [table.schoolId, table.contextId], foreignColumns: [classpilotSupervisionContexts.schoolId, classpilotSupervisionContexts.id] }).onDelete("cascade"),
  check("cp_supervision_report_state_check", sql`${table.state} IN ('active','pending','materializing','ready','failed','expired')`),
  check("cp_supervision_report_window_check", sql`${table.windowEnd} IS NULL OR ${table.windowEnd} >= ${table.windowStart}`),
  check("cp_supervision_report_closed_check", sql`${table.state} = 'active' OR (${table.windowEnd} IS NOT NULL AND ${table.settleAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL)`),
  check("cp_supervision_report_attempt_check", sql`${table.attemptCount} >= 0 AND ${table.reportVersion} > 0 AND ${table.retentionHours} BETWEEN 24 AND 8760`),
]);

export const classpilotSupervisionStudentReports = pgTable("classpilot_supervision_student_reports", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  schoolId: text("school_id").notNull(), reportId: text("report_id").notNull(), studentId: text("student_id").notNull(),
  studentNameSnapshot: text("student_name_snapshot").notNull(),
  participationIntervals: jsonb("participation_intervals").$type<SupervisionParticipationInterval[]>().notNull().default(sql`'[]'::jsonb`),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("cp_supervision_student_report_unique").on(table.schoolId, table.reportId, table.studentId),
  index("cp_supervision_student_report_student_idx").on(table.schoolId, table.studentId),
  foreignKey({ name: "cp_supervision_student_report_parent_fk", columns: [table.schoolId, table.reportId], foreignColumns: [classpilotSupervisionReportSegments.schoolId, classpilotSupervisionReportSegments.id] }).onDelete("cascade"),
  // Migration validates the same-school student binding at capture without a
  // live-roster cascade that could erase the immutable report before retention.
  check("cp_supervision_student_report_intervals_check", sql`jsonb_typeof(${table.participationIntervals}) = 'array'`),
]);

export const classpilotSupervisionSummaryDeliveries = pgTable("classpilot_supervision_summary_deliveries", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`), schoolId: text("school_id").notNull(), reportId: text("report_id").notNull(),
  recipientStaffId: text("recipient_staff_id"), recipientKind: text("recipient_kind").notNull(),
  recipientEmail: text("recipient_email"), recipientName: text("recipient_name"),
  state: text("state").notNull().default("waiting_report"), attemptCount: integer("attempt_count").notNull().default(0),
  leaseOwner: text("lease_owner"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  submissionStartedAt: timestamp("submission_started_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().default(sql`now()`),
  providerMessageId: text("provider_message_id"), lastError: text("last_error"), sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  uniqueIndex("cp_supervision_delivery_kind_unique").on(table.schoolId, table.reportId, table.recipientKind),
  uniqueIndex("cp_supervision_delivery_email_unique").on(table.schoolId, table.reportId, sql`lower(btrim(${table.recipientEmail}))`),
  index("cp_supervision_delivery_due_idx").on(table.state, table.nextAttemptAt),
  index("cp_supervision_delivery_lease_idx").on(table.state, table.leaseExpiresAt),
  foreignKey({ name: "cp_supervision_delivery_report_fk", columns: [table.schoolId, table.reportId], foreignColumns: [classpilotSupervisionReportSegments.schoolId, classpilotSupervisionReportSegments.id] }).onDelete("cascade"),
  check("cp_supervision_delivery_kind_check", sql`${table.recipientKind} IN ('supervisor','central')`),
  check("cp_supervision_delivery_state_check", sql`${table.state} IN ('waiting_report','queued','leased','retry','sent','failed','unknown','expired')`),
  check("cp_supervision_delivery_attempt_check", sql`${table.attemptCount} >= 0`),
]);

export type ClasspilotSupervisionReportSegment = typeof classpilotSupervisionReportSegments.$inferSelect;
export type ClasspilotSupervisionStudentReport = typeof classpilotSupervisionStudentReports.$inferSelect;
export type ClasspilotSupervisionSummaryDelivery = typeof classpilotSupervisionSummaryDeliveries.$inferSelect;
