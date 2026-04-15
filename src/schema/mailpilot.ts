import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  integer,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";

// ============================================================================
// MailPilot Watches — one row per student mailbox under active Gmail watch
// ============================================================================
export const mailpilotWatches = pgTable(
  "mailpilot_watches",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id").notNull(),
    studentEmail: text("student_email").notNull(),
    historyId: text("history_id"), // Gmail historyId cursor
    expiresAt: timestamp("expires_at").notNull(),
    startedAt: timestamp("started_at").notNull().default(sql`now()`),
    lastRenewedAt: timestamp("last_renewed_at").notNull().default(sql`now()`),
    lastPollAt: timestamp("last_poll_at"),
    status: text("status").notNull().default("active"), // active | stopped | error
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("mailpilot_watches_email_unique").on(table.studentEmail),
    index("mailpilot_watches_school_idx").on(table.schoolId),
    index("mailpilot_watches_expires_idx").on(table.expiresAt),
  ]
);

export type MailpilotWatch = typeof mailpilotWatches.$inferSelect;
export type InsertMailpilotWatch = typeof mailpilotWatches.$inferInsert;

// ============================================================================
// Email Alerts — AI-flagged messages awaiting admin review
// ============================================================================
export const emailAlerts = pgTable(
  "email_alerts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id").notNull(),
    studentEmail: text("student_email").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id"),
    direction: text("direction").notNull(), // inbound | outbound
    sender: text("sender"),
    recipients: jsonb("recipients"), // string[]
    subject: text("subject"),
    snippet: text("snippet"), // first ~500 chars, for display
    category: text("category"), // educational | non-educational | unknown
    safetyAlert: text("safety_alert"), // self-harm | violence | sexual | drugs | bullying | null
    bullying: text("bullying"), // "true" | "false" (text for flexibility)
    confidence: integer("confidence"), // 0-100
    severity: text("severity").notNull().default("medium"), // low | medium | high | critical
    reasoning: text("reasoning"), // short AI rationale
    messageDate: timestamp("message_date"),
    alertedAt: timestamp("alerted_at").notNull().default(sql`now()`),
    reviewedAt: timestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewStatus: text("review_status"), // null | confirmed | dismissed | escalated
    reviewNote: text("review_note"),
  },
  (table) => [
    uniqueIndex("email_alerts_gmail_message_unique").on(table.gmailMessageId),
    index("email_alerts_school_alerted_idx").on(table.schoolId, table.alertedAt),
    index("email_alerts_student_alerted_idx").on(table.studentId, table.alertedAt),
    index("email_alerts_school_review_idx").on(table.schoolId, table.reviewStatus),
  ]
);

export type EmailAlert = typeof emailAlerts.$inferSelect;
export type InsertEmailAlert = typeof emailAlerts.$inferInsert;

// ============================================================================
// Email Scan Log — lightweight daily stats for debugging / dashboards
// ============================================================================
export const emailScanLog = pgTable(
  "email_scan_log",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD in school timezone
    messagesScanned: integer("messages_scanned").notNull().default(0),
    alertsRaised: integer("alerts_raised").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("email_scan_log_school_date_unique").on(table.schoolId, table.date),
    index("email_scan_log_school_idx").on(table.schoolId),
  ]
);

export type EmailScanLogEntry = typeof emailScanLog.$inferSelect;
export type InsertEmailScanLogEntry = typeof emailScanLog.$inferInsert;
