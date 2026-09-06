import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, integer, index, uniqueIndex, check, foreignKey } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import { students } from "./students.js";
import { devices, studentSessions, teachingSessions, classpilotSupervisionContexts } from "./classpilot.js";

// Internal binding fields never enter the staff-facing projection. Expectations
// outlive Redis snapshots; incidents are independent of regenerated reports.
export const classpilotMonitoringExpectations = pgTable("classpilot_monitoring_expectations", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  schoolId: text("school_id").notNull(), studentId: text("student_id").notNull(),
  studentSessionId: text("student_session_id").notNull(), deviceId: text("device_id").notNull(),
  scopeType: text("scope_type").notNull(), scopeId: text("scope_id").notNull(), scopeName: text("scope_name").notNull(),
  teachingSessionId: text("teaching_session_id").generatedAlwaysAs(sql`CASE WHEN scope_type='teaching_session' THEN scope_id END`),
  supervisionContextId: text("supervision_context_id").generatedAlwaysAs(sql`CASE WHEN scope_type='supervision_context' THEN scope_id END`),
  scopeStartedAt: timestamp("scope_started_at", { withTimezone: true }).notNull(),
  scopeEndsAt: timestamp("scope_ends_at", { withTimezone: true }),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
  uncertainSince: timestamp("uncertain_since", { withTimezone: true }),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("cp_monitoring_expectation_student_unique").on(table.schoolId, table.studentId), index("cp_monitoring_expectation_retention_idx").on(table.retentionExpiresAt),
  foreignKey({ name: "cp_monitoring_expectation_student_fk", columns: [table.schoolId, table.studentId], foreignColumns: [students.schoolId, students.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_expectation_school_fk", columns: [table.schoolId], foreignColumns: [schools.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_expectation_session_fk", columns: [table.studentSessionId, table.studentId, table.deviceId], foreignColumns: [studentSessions.id, studentSessions.studentId, studentSessions.deviceId] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_expectation_device_fk", columns: [table.schoolId, table.deviceId], foreignColumns: [devices.schoolId, devices.deviceId] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_expectation_class_fk", columns: [table.schoolId, table.teachingSessionId], foreignColumns: [teachingSessions.schoolId, teachingSessions.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_expectation_coverage_fk", columns: [table.schoolId, table.supervisionContextId], foreignColumns: [classpilotSupervisionContexts.schoolId, classpilotSupervisionContexts.id] }).onDelete("cascade"),
  check("cp_monitoring_expectation_scope_check", sql`${table.scopeType} IN ('teaching_session','supervision_context')`)]);

export const classpilotMonitoringInterruptions = pgTable("classpilot_monitoring_interruptions", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
  expectationId: text("expectation_id").notNull(), schoolId: text("school_id").notNull(), studentId: text("student_id").notNull(),
  studentSessionId: text("student_session_id").notNull(), deviceId: text("device_id").notNull(),
  scopeType: text("scope_type").notNull(), scopeId: text("scope_id").notNull(), scopeName: text("scope_name").notNull(),
  teachingSessionId: text("teaching_session_id").generatedAlwaysAs(sql`CASE WHEN scope_type='teaching_session' THEN scope_id END`),
  supervisionContextId: text("supervision_context_id").generatedAlwaysAs(sql`CASE WHEN scope_type='supervision_context' THEN scope_id END`),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  recoveredAt: timestamp("recovered_at", { withTimezone: true }), endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"), uncertainSince: timestamp("uncertain_since", { withTimezone: true }),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("cp_monitoring_interruption_open_unique").on(table.expectationId).where(sql`${table.endedAt} IS NULL`),
  index("cp_monitoring_interruption_school_time_idx").on(table.schoolId, table.detectedAt), index("cp_monitoring_interruption_retention_idx").on(table.retentionExpiresAt),
  foreignKey({ name: "cp_monitoring_interruption_student_fk", columns: [table.schoolId, table.studentId], foreignColumns: [students.schoolId, students.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_interruption_school_fk", columns: [table.schoolId], foreignColumns: [schools.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_interruption_session_fk", columns: [table.studentSessionId, table.studentId, table.deviceId], foreignColumns: [studentSessions.id, studentSessions.studentId, studentSessions.deviceId] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_interruption_device_fk", columns: [table.schoolId, table.deviceId], foreignColumns: [devices.schoolId, devices.deviceId] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_interruption_class_fk", columns: [table.schoolId, table.teachingSessionId], foreignColumns: [teachingSessions.schoolId, teachingSessions.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_interruption_coverage_fk", columns: [table.schoolId, table.supervisionContextId], foreignColumns: [classpilotSupervisionContexts.schoolId, classpilotSupervisionContexts.id] }).onDelete("cascade"),
  check("cp_monitoring_interruption_scope_check", sql`${table.scopeType} IN ('teaching_session','supervision_context')`),
  check("cp_monitoring_interruption_end_check", sql`(${table.endedAt} IS NULL AND ${table.endReason} IS NULL) OR (${table.endedAt} IS NOT NULL AND ${table.endReason} IS NOT NULL)`),
  check("cp_monitoring_interruption_recovery_check", sql`${table.recoveredAt} IS NULL OR (${table.endedAt} IS NOT NULL AND ${table.endReason}='telemetry_resumed')`)]);

export const classpilotMonitoringInterruptionSettings = pgTable("classpilot_monitoring_interruption_settings", {
  schoolId: text("school_id").primaryKey(), digestEnabled: boolean("digest_enabled").notNull().default(false),
  revision: integer("revision").notNull().default(0), updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }), lastHealthyAt: timestamp("last_healthy_at", { withTimezone: true }),
  scanStatus: text("scan_status").notNull().default("unknown"),
}, (table) => [foreignKey({ name: "cp_monitoring_interruption_settings_school_fk", columns: [table.schoolId], foreignColumns: [schools.id] }).onDelete("cascade"), check("cp_monitoring_interruption_settings_revision_check", sql`${table.revision}>=0`), check("cp_monitoring_interruption_settings_status_check", sql`${table.scanStatus} IN ('healthy','uncertain','not_expected','unknown')`)]);

export const classpilotMonitoringInterruptionDigests = pgTable("classpilot_monitoring_interruption_digests", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()::text`), schoolId: text("school_id").notNull(),
  localDate: text("local_date").notNull(), recipientUserId: text("recipient_user_id").notNull(),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(), claimedAt: timestamp("claimed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }), errorCode: text("error_code"),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("cp_monitoring_digest_daily_recipient_unique").on(table.schoolId, table.localDate, table.recipientUserId),
  index("cp_monitoring_digest_due_idx").on(table.status, table.dueAt), index("cp_monitoring_digest_retention_idx").on(table.retentionExpiresAt),
  foreignKey({ name: "cp_monitoring_digest_school_fk", columns: [table.schoolId], foreignColumns: [schools.id] }).onDelete("cascade"),
  foreignKey({ name: "cp_monitoring_digest_recipient_fk", columns: [table.recipientUserId], foreignColumns: [users.id] }).onDelete("cascade"),
  check("cp_monitoring_digest_status_check", sql`${table.status} IN ('pending','sending','sent','unknown','failed','cancelled')`)]);
