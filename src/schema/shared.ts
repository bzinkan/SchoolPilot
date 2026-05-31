import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  index,
  unique,
  uniqueIndex,
  jsonb,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================================================
// Settings - School-wide settings (from ClassPilot, extended for all products)
// ============================================================================
export const settings = pgTable("settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().unique(),
  schoolName: text("school_name").notNull(),
  wsSharedKey: text("ws_shared_key").notNull(),
  retentionHours: text("retention_hours").notNull().default("720"),
  blockedDomains: text("blocked_domains")
    .array()
    .default(sql`'{}'::text[]`),
  allowedDomains: text("allowed_domains")
    .array()
    .default(sql`'{}'::text[]`),
  ipAllowlist: text("ip_allowlist")
    .array()
    .default(sql`'{}'::text[]`),
  gradeLevels: text("grade_levels")
    .array()
    .default(sql`'{6,7,8,9,10,11,12}'::text[]`),
  maxTabsPerStudent: text("max_tabs_per_student"),
  activeFlightPathId: text("active_flight_path_id"),
  enableTrackingHours: boolean("enable_tracking_hours").default(false),
  trackingStartTime: text("tracking_start_time").default("08:00"),
  trackingEndTime: text("tracking_end_time").default("15:00"),
  schoolTimezone: text("school_timezone").default("America/New_York"),
  trackingDays: text("tracking_days")
    .array()
    .default(
      sql`'{Monday,Tuesday,Wednesday,Thursday,Friday}'::text[]`
    ),
  afterHoursMode: text("after_hours_mode")
    .notNull()
    .default("off")
    .$type<"off" | "limited" | "full">(),
  handRaisingEnabled: boolean("hand_raising_enabled").default(true),
  studentMessagingEnabled: boolean("student_messaging_enabled").default(true),
  aiSafetyEmailsEnabled: boolean("ai_safety_emails_enabled").default(true),
  autoBlockUnsafeUrls: boolean("auto_block_unsafe_urls").default(true),
});

export type Settings = typeof settings.$inferSelect;
export type InsertSettings = typeof settings.$inferInsert;

// ============================================================================
// Google OAuth Tokens - Shared across products
// ============================================================================
export const googleOAuthTokens = pgTable("google_oauth_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull().unique(),
  refreshToken: text("refresh_token").notNull(), // Encrypted
  scope: text("scope"),
  tokenType: text("token_type"),
  expiryDate: timestamp("expiry_date"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export type GoogleOAuthToken = typeof googleOAuthTokens.$inferSelect;
export type InsertGoogleOAuthToken = typeof googleOAuthTokens.$inferInsert;

// ============================================================================
// Classroom Courses - Google Classroom sync
// ============================================================================
export const classroomCourses = pgTable(
  "classroom_courses",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    googleCourseId: text("google_course_id").notNull(),
    name: text("name").notNull(),
    section: text("section"),
    room: text("room"),
    descriptionHeading: text("description_heading"),
    ownerId: text("owner_id"),
    gradeId: text("grade_id"), // FK to grades if mapped to a local class
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classroom_courses_school_id_idx").on(table.schoolId),
    uniqueIndex("classroom_courses_school_google_unique").on(
      table.schoolId,
      table.googleCourseId
    ),
  ]
);

export type ClassroomCourse = typeof classroomCourses.$inferSelect;
export type InsertClassroomCourse = typeof classroomCourses.$inferInsert;

// ============================================================================
// Classroom Course Students - Enrollment tracking
// ============================================================================
export const classroomCourseStudents = pgTable(
  "classroom_course_students",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    courseId: text("course_id").notNull(),
    studentId: text("student_id").notNull(),
    googleUserId: text("google_user_id"),
    studentEmailLc: text("student_email_lc"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("classroom_course_students_enrollment_unique").on(
      table.schoolId,
      table.courseId,
      table.studentId
    ),
    index("classroom_course_students_school_course_idx").on(
      table.schoolId,
      table.courseId
    ),
    index("classroom_course_students_school_student_idx").on(
      table.schoolId,
      table.studentId
    ),
  ]
);

export type ClassroomCourseStudent =
  typeof classroomCourseStudents.$inferSelect;
export type InsertClassroomCourseStudent =
  typeof classroomCourseStudents.$inferInsert;

// ============================================================================
// Audit Logs - Unified across all products (from ClassPilot)
// ============================================================================
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Nullable: system-level events like failed-login-for-unknown-user
    // don't belong to a specific school.
    schoolId: text("school_id"),
    // Nullable: failed-login attempts may not have a user record.
    userId: text("user_id"),
    userEmail: text("user_email"),
    userRole: text("user_role"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    entityName: text("entity_name"),
    changes: jsonb("changes"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("audit_logs_school_id_idx").on(table.schoolId),
    index("audit_logs_created_at_idx").on(table.createdAt),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_user_id_idx").on(table.userId),
  ]
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ============================================================================
// Security Events - Breach detection monitor findings
// Populated by the security monitor (runs every 5 min). Any detection here
// should be reviewed by a human — automatic actions are intentionally limited.
// ============================================================================
export const securityEvents = pgTable(
  "security_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Detection metadata
    detectedAt: timestamp("detected_at").notNull().default(sql`now()`),
    eventType: text("event_type").notNull(),
    // "failed_auth_spike" | "cross_school_access" | "bulk_export" |
    // "off_hours_admin" | "pii_in_error_log" | "unusual_student_query" | "rate_limit_abuse"
    severity: text("severity").notNull(), // "low" | "medium" | "high" | "critical"
    // What triggered it
    schoolId: text("school_id"),
    userId: text("user_id"),
    userEmail: text("user_email"),
    ipAddress: text("ip_address"),
    // Evidence / context
    summary: text("summary").notNull(),
    details: jsonb("details"), // { count, threshold, sampleQuery, etc. }
    // Response tracking
    status: text("status").notNull().default("open"), // open | investigating | resolved | false_positive
    resolvedAt: timestamp("resolved_at"),
    resolvedBy: text("resolved_by"),
    resolutionNotes: text("resolution_notes"),
    // Alerting state
    alertSent: boolean("alert_sent").notNull().default(false),
  },
  (table) => [
    index("security_events_detected_at_idx").on(table.detectedAt),
    index("security_events_event_type_idx").on(table.eventType),
    index("security_events_severity_idx").on(table.severity),
    index("security_events_status_idx").on(table.status),
    index("security_events_school_id_idx").on(table.schoolId),
  ]
);

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type InsertSecurityEvent = typeof securityEvents.$inferInsert;

// ============================================================================
// Error Logs - Durable record of every error the ErrorMonitor sees.
// The ErrorMonitor keeps only a 5-minute in-memory window for alerting; this
// table is the persistent, queryable copy so a developer can pinpoint exactly
// which request / user / school / line failed long after it happened.
// Lives in the school's own database (not a third-party) — same FERPA posture
// as audit_logs. Purged on a retention schedule by the scheduler.
// ============================================================================
export const errorLogs = pgTable(
  "error_logs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    category: text("category").notNull(), // ErrorCategory: api_error, uncaught_exception, etc.
    message: text("message").notNull(),
    stack: text("stack"),
    // Request correlation — ties this error to a specific request + actor
    requestId: text("request_id"),
    method: text("method"),
    path: text("path"),
    statusCode: integer("status_code"),
    schoolId: text("school_id"),
    userId: text("user_id"),
    // Any extra context passed to trackError() (job name, recipient, etc.)
    context: jsonb("context"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("error_logs_created_at_idx").on(table.createdAt),
    index("error_logs_category_idx").on(table.category),
    index("error_logs_request_id_idx").on(table.requestId),
    index("error_logs_school_id_idx").on(table.schoolId),
  ]
);

export type ErrorLog = typeof errorLogs.$inferSelect;
export type InsertErrorLog = typeof errorLogs.$inferInsert;

// ============================================================================
// Trial Requests - Unified (superset of all three projects)
// ============================================================================
export const trialRequests = pgTable(
  "trial_requests",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolName: text("school_name").notNull(),
    domain: text("domain"),
    contactName: text("contact_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    adminPhone: text("admin_phone"),
    estimatedStudents: text("estimated_students"),
    estimatedTeachers: text("estimated_teachers"),
    message: text("message"),
    zipCode: text("zip_code"),
    product: text("product"), // Which product they're requesting: PASSPILOT | GOPILOT | CLASSPILOT | null (all)
    status: text("status").notNull().default("pending"), // pending | contacted | converted | declined
    notes: text("notes"),
    schoolId: text("school_id"), // FK once provisioned
    schoolStartTime: text("school_start_time"), // e.g. "08:00"
    schoolEndTime: text("school_end_time"), // e.g. "16:00"
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    processedAt: timestamp("processed_at"),
    processedBy: text("processed_by"),
  },
  (table) => [
    index("trial_requests_status_idx").on(table.status),
    index("trial_requests_email_idx").on(table.contactEmail),
  ]
);

export type TrialRequest = typeof trialRequests.$inferSelect;
export type InsertTrialRequest = typeof trialRequests.$inferInsert;

// ============================================================================
// Express Sessions - For connect-pg-simple session store
// ============================================================================
export const expressSessions = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("session_expire_idx").on(table.expire)]
);
