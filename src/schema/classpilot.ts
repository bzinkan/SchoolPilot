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
  check,
  jsonb,
  foreignKey,
} from "drizzle-orm/pg-core";
import { students } from "./students.js";

// ============================================================================
// Devices - ClassPilot Chromebook registration
// ============================================================================
export const devices = pgTable("devices", {
  deviceId: varchar("device_id").primaryKey(),
  deviceName: text("device_name"),
  schoolId: text("school_id").notNull(),
  classId: text("class_id").notNull(),
  extensionVersion: text("extension_version"),
  chromeVersion: text("chrome_version"),
  lastScreenshotHealth: jsonb("last_screenshot_health"),
  lastSeenAt: timestamp("last_seen_at"),
  registeredAt: timestamp("registered_at").notNull().default(sql`now()`),
});

export type Device = typeof devices.$inferSelect;
export type InsertDevice = typeof devices.$inferInsert;

// ============================================================================
// Student Devices - Multi-device join table
// ============================================================================
export const studentDevices = pgTable(
  "student_devices",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    studentId: text("student_id").notNull(),
    deviceId: text("device_id").notNull(),
    firstSeenAt: timestamp("first_seen_at").notNull().default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("student_devices_unique").on(table.studentId, table.deviceId),
    index("student_devices_device_student_idx").on(table.deviceId, table.studentId),
  ]
);

export type StudentDevice = typeof studentDevices.$inferSelect;
export type InsertStudentDevice = typeof studentDevices.$inferInsert;

// ============================================================================
// Student Sessions - Active device tracking
// ============================================================================
export const studentSessions = pgTable(
  "student_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    studentId: text("student_id").notNull(),
    deviceId: text("device_id").notNull(),
    startedAt: timestamp("started_at").notNull().default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at").notNull().default(sql`now()`),
    endedAt: timestamp("ended_at"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("student_sessions_active_student_unique")
      .on(table.studentId)
      .where(sql`is_active = true`),
    uniqueIndex("student_sessions_active_device_unique")
      .on(table.deviceId)
      .where(sql`is_active = true`),
    index("student_sessions_student_device_active_idx").on(
      table.studentId,
      table.deviceId,
      table.isActive
    ),
    index("student_sessions_last_seen_active_idx").on(
      table.lastSeenAt,
      table.isActive
    ),
  ]
);

export type StudentSession = typeof studentSessions.$inferSelect;
export type InsertStudentSession = typeof studentSessions.$inferInsert;

// ============================================================================
// Heartbeats - Real-time monitoring data
// ============================================================================
export const heartbeats = pgTable(
  "heartbeats",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    deviceId: text("device_id").notNull(),
    studentId: text("student_id"),
    studentEmail: text("student_email"),
    schoolId: text("school_id"),
    activeTabTitle: text("active_tab_title").notNull(),
    activeTabUrl: text("active_tab_url"),
    favicon: text("favicon"),
    screenLocked: boolean("screen_locked").default(false),
    flightPathActive: boolean("flight_path_active").default(false),
    activeFlightPathName: text("active_flight_path_name"),
    isSharing: boolean("is_sharing").default(false),
    cameraActive: boolean("camera_active").default(false),
    aiCategory: text("ai_category"),
    safetyAlert: text("safety_alert"),
    extensionVersion: text("extension_version"),
    chromeVersion: text("chrome_version"),
    screenshotHealth: jsonb("screenshot_health"),
    timestamp: timestamp("timestamp").notNull().default(sql`now()`),
  },
  (table) => [
    index("heartbeats_timestamp_idx").on(table.timestamp),
    index("heartbeats_student_id_idx").on(table.studentId),
    index("heartbeats_student_email_idx").on(table.studentEmail),
    index("heartbeats_device_id_idx").on(table.deviceId),
    index("heartbeats_student_timestamp_idx").on(
      table.studentId,
      table.timestamp
    ),
    index("heartbeats_email_timestamp_idx").on(
      table.studentEmail,
      table.timestamp
    ),
    index("heartbeats_school_email_idx").on(
      table.schoolId,
      table.studentEmail
    ),
    index("heartbeats_school_device_timestamp_idx").on(
      table.schoolId,
      table.deviceId,
      table.timestamp.desc()
    ),
    index("heartbeats_school_device_student_timestamp_idx").on(
      table.schoolId,
      table.deviceId,
      table.studentId,
      table.timestamp.desc()
    ),
  ]
);

export type Heartbeat = typeof heartbeats.$inferSelect;
export type InsertHeartbeat = typeof heartbeats.$inferInsert;

// ============================================================================
// Daily Usage - Pre-aggregated daily screen time per student
// ============================================================================
export const dailyUsage = pgTable(
  "daily_usage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id").notNull(),
    date: text("date").notNull(), // "YYYY-MM-DD" in school timezone
    totalSeconds: integer("total_seconds").notNull().default(0),
    heartbeatCount: integer("heartbeat_count").notNull().default(0),
    topDomains: jsonb("top_domains"), // [{domain, seconds, visits}]
    firstSeen: timestamp("first_seen"),
    lastSeen: timestamp("last_seen"),
    computedAt: timestamp("computed_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("daily_usage_school_date_idx").on(table.schoolId, table.date),
    uniqueIndex("daily_usage_student_date_unique").on(
      table.studentId,
      table.date
    ),
    index("daily_usage_school_student_date_idx").on(
      table.schoolId,
      table.studentId,
      table.date
    ),
  ]
);

export type DailyUsage = typeof dailyUsage.$inferSelect;
export type InsertDailyUsage = typeof dailyUsage.$inferInsert;

// ============================================================================
// Events - Audit events for student activity
// ============================================================================
export const events = pgTable(
  "events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    deviceId: text("device_id").notNull(),
    studentId: text("student_id"),
    eventType: text("event_type").notNull(), // tab_change | consent_granted | consent_revoked | blocked_domain | student_switched
    metadata: jsonb("metadata"),
    timestamp: timestamp("timestamp").notNull().default(sql`now()`),
  },
  (table) => [
    index("events_device_id_idx").on(table.deviceId),
    index("events_timestamp_idx").on(table.timestamp),
  ]
);

export type EventRecord = typeof events.$inferSelect;
export type InsertEvent = typeof events.$inferInsert;

// ============================================================================
// Rosters - Class rosters
// ============================================================================
export const rosters = pgTable("rosters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  classId: text("class_id").notNull(),
  className: text("class_name").notNull(),
  deviceIds: text("device_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  uploadedAt: timestamp("uploaded_at").notNull().default(sql`now()`),
});

export type Roster = typeof rosters.$inferSelect;
export type InsertRoster = typeof rosters.$inferInsert;

// ============================================================================
// Groups - Class rosters (enhanced)
// ============================================================================
export const groups = pgTable(
  "groups",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    periodLabel: text("period_label"),
    gradeLevel: text("grade_level"),
    groupType: text("group_type").notNull().default("teacher_created"), // admin_class | teacher_small_group | teacher_created
    parentGroupId: text("parent_group_id"), // FK to groups for nested small groups
    status: text("status").notNull().default("active"), // active | archived
    archivedAt: timestamp("archived_at"),
    schoolYear: text("school_year"),
    term: text("term"),
    googleClassroomCourseId: text("google_classroom_course_id"),
    scheduleEnabled: boolean("schedule_enabled").notNull().default(false),
    blockStartTime: text("block_start_time"), // HH:MM 24h format, e.g. "10:10"
    blockEndTime: text("block_end_time"),     // HH:MM 24h format, e.g. "10:55"
    scheduleSkippedDate: text("schedule_skipped_date"), // YYYY-MM-DD, set when teacher manually ends early
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("groups_school_id_idx").on(table.schoolId),
    // This must be an inline constraint so Drizzle can create tenant FKs on an
    // empty database. Startup migrations retain the legacy standalone index.
    unique("groups_school_id_id_fk_key").on(table.schoolId, table.id),
    index("groups_teacher_id_idx").on(table.teacherId),
    index("groups_status_idx").on(table.status),
    uniqueIndex("groups_school_google_course_unique")
      .on(table.schoolId, table.googleClassroomCourseId)
      .where(sql`${table.googleClassroomCourseId} IS NOT NULL`),
  ]
);

export type Group = typeof groups.$inferSelect;
export type InsertGroup = typeof groups.$inferInsert;

// ============================================================================
// Schedule Changes - one-day exchanges of two recurring class windows
// ============================================================================
export const classpilotScheduleChangePairs = pgTable(
  "classpilot_schedule_change_pairs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    // Stored in stable lexical order so A/B and B/A can never coexist.
    firstGroupId: text("first_group_id").notNull(),
    secondGroupId: text("second_group_id").notNull(),
    status: text("status").notNull().default("active"),
    revision: integer("revision").notNull().default(0),
    createdBy: text("created_by").notNull(),
    archivedBy: text("archived_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_schedule_change_pairs_school_groups_unique").on(
      table.schoolId,
      table.firstGroupId,
      table.secondGroupId
    ),
    unique("cp_schedule_change_pairs_school_id_fk_key").on(
      table.schoolId,
      table.id
    ),
    index("cp_schedule_change_pairs_school_status_idx").on(
      table.schoolId,
      table.status
    ),
    check(
      "cp_schedule_change_pairs_group_order_check",
      sql`${table.firstGroupId} < ${table.secondGroupId}`
    ),
    check(
      "cp_schedule_change_pairs_status_check",
      sql`${table.status} IN ('active', 'archived')`
    ),
    check(
      "cp_schedule_change_pairs_revision_check",
      sql`${table.revision} >= 0`
    ),
    foreignKey({
      columns: [table.schoolId, table.firstGroupId],
      foreignColumns: [groups.schoolId, groups.id],
      name: "cp_schedule_change_pairs_first_group_school_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.schoolId, table.secondGroupId],
      foreignColumns: [groups.schoolId, groups.id],
      name: "cp_schedule_change_pairs_second_group_school_fk",
    }).onDelete("restrict"),
  ]
);

export type ClasspilotScheduleChangePair =
  typeof classpilotScheduleChangePairs.$inferSelect;
export type InsertClasspilotScheduleChangePair =
  typeof classpilotScheduleChangePairs.$inferInsert;

export const classpilotScheduleChanges = pgTable(
  "classpilot_schedule_changes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    pairId: varchar("pair_id").notNull(),
    scheduledDate: text("scheduled_date").notNull(),
    timezoneSnapshot: text("timezone_snapshot").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    requesterGroupId: text("requester_group_id"),
    counterpartTeacherId: text("counterpart_teacher_id"),
    requestedByRole: text("requested_by_role").notNull(),
    requiresAdminApproval: boolean("requires_admin_approval").notNull(),
    reservationActive: boolean("reservation_active").notNull().default(true),
    revision: integer("revision").notNull().default(0),
    acceptedByUserId: text("accepted_by_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    terminalByUserId: text("terminal_by_user_id"),
    terminalReason: text("terminal_reason"),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_schedule_changes_school_id_unique").on(
      table.schoolId,
      table.id
    ),
    unique("cp_schedule_changes_school_id_date_fk_key").on(
      table.schoolId,
      table.id,
      table.scheduledDate
    ),
    index("cp_schedule_changes_school_date_status_idx").on(
      table.schoolId,
      table.scheduledDate,
      table.status
    ),
    index("cp_schedule_changes_school_requester_idx").on(
      table.schoolId,
      table.requestedByUserId
    ),
    check(
      "cp_schedule_changes_status_check",
      sql`${table.status} IN ('pending_counterpart', 'pending_admin', 'approved', 'declined', 'denied', 'cancelled', 'expired', 'superseded')`
    ),
    check(
      "cp_schedule_changes_reason_check",
      sql`length(btrim(${table.reason})) BETWEEN 1 AND 500`
    ),
    check(
      "cp_schedule_changes_date_check",
      sql`${table.scheduledDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
    ),
    check(
      "cp_schedule_changes_revision_check",
      sql`${table.revision} >= 0`
    ),
    check(
      "cp_schedule_changes_reservation_check",
      sql`(${table.status} IN ('pending_counterpart', 'pending_admin', 'approved')) = ${table.reservationActive}`
    ),
    foreignKey({
      columns: [table.schoolId, table.pairId],
      foreignColumns: [
        classpilotScheduleChangePairs.schoolId,
        classpilotScheduleChangePairs.id,
      ],
      name: "cp_schedule_changes_pair_school_fk",
    }).onDelete("restrict"),
  ]
);

export type ClasspilotScheduleChange =
  typeof classpilotScheduleChanges.$inferSelect;
export type InsertClasspilotScheduleChange =
  typeof classpilotScheduleChanges.$inferInsert;

export const classpilotScheduleChangeLegs = pgTable(
  "classpilot_schedule_change_legs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    scheduleChangeId: varchar("schedule_change_id").notNull(),
    scheduledDate: text("scheduled_date").notNull(),
    legOrder: integer("leg_order").notNull(),
    groupId: text("group_id").notNull(),
    primaryTeacherIdSnapshot: text("primary_teacher_id_snapshot").notNull(),
    classNameSnapshot: text("class_name_snapshot").notNull(),
    originalStartTime: text("original_start_time").notNull(),
    originalEndTime: text("original_end_time").notNull(),
    effectiveStartTime: text("effective_start_time").notNull(),
    effectiveEndTime: text("effective_end_time").notNull(),
    reservationActive: boolean("reservation_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_schedule_change_legs_change_order_unique").on(
      table.scheduleChangeId,
      table.legOrder
    ),
    uniqueIndex("cp_schedule_change_legs_change_group_unique").on(
      table.scheduleChangeId,
      table.groupId
    ),
    uniqueIndex("cp_schedule_change_legs_active_group_date_unique")
      .on(table.schoolId, table.scheduledDate, table.groupId)
      .where(sql`${table.reservationActive} = true`),
    index("cp_schedule_change_legs_school_change_idx").on(
      table.schoolId,
      table.scheduleChangeId
    ),
    index("cp_schedule_change_legs_school_group_date_idx").on(
      table.schoolId,
      table.groupId,
      table.scheduledDate
    ),
    check(
      "cp_schedule_change_legs_order_check",
      sql`${table.legOrder} IN (1, 2)`
    ),
    check(
      "cp_schedule_change_legs_date_check",
      sql`${table.scheduledDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
    ),
    check(
      "cp_schedule_change_legs_window_check",
      sql`${table.originalStartTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND ${table.originalEndTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND ${table.effectiveStartTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND ${table.effectiveEndTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND ${table.originalStartTime} < ${table.originalEndTime}
        AND ${table.effectiveStartTime} < ${table.effectiveEndTime}`
    ),
    foreignKey({
      columns: [table.schoolId, table.scheduleChangeId, table.scheduledDate],
      foreignColumns: [
        classpilotScheduleChanges.schoolId,
        classpilotScheduleChanges.id,
        classpilotScheduleChanges.scheduledDate,
      ],
      name: "cp_schedule_change_legs_change_school_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.schoolId, table.groupId],
      foreignColumns: [groups.schoolId, groups.id],
      name: "cp_schedule_change_legs_group_school_fk",
    }).onDelete("restrict"),
  ]
);

export type ClasspilotScheduleChangeLeg =
  typeof classpilotScheduleChangeLegs.$inferSelect;
export type InsertClasspilotScheduleChangeLeg =
  typeof classpilotScheduleChangeLegs.$inferInsert;

// ============================================================================
// Group Students - Many-to-many
// ============================================================================
export const groupStudents = pgTable(
  "group_students",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    groupId: text("group_id").notNull(),
    studentId: text("student_id").notNull(),
    assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("group_students_unique").on(table.groupId, table.studentId),
    index("group_students_group_id_idx").on(table.groupId),
    index("group_students_student_id_idx").on(table.studentId),
  ]
);

export type GroupStudent = typeof groupStudents.$inferSelect;
export type InsertGroupStudent = typeof groupStudents.$inferInsert;

// ============================================================================
// Teaching Sessions - Bell-to-bell classroom sessions
// ============================================================================
export const teachingSessions = pgTable(
  "teaching_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    groupId: text("group_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    // Derived from the parent group's school; backfilled + set on insert. Nullable
    // for legacy rows. Basis for the per-school RLS policy.
    schoolId: text("school_id"),
    startTime: timestamp("start_time").notNull().default(sql`now()`),
    controlUpdatedAt: timestamp("control_updated_at"),
    sessionMode: text("session_mode").notNull().default("live"),
    scheduledConflictId: text("scheduled_conflict_id"),
    // Frozen occurrence metadata. These fields are populated together for an
    // automatically scheduled class and remain NULL for manual sessions.
    scheduledDate: text("scheduled_date"), // YYYY-MM-DD in scheduledTimezone
    scheduledTimezone: text("scheduled_timezone"),
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
    scheduledTeacherEmail: text("scheduled_teacher_email"),
    scheduledTeacherName: text("scheduled_teacher_name"),
    // Frozen display label used by durable summary delivery. A class can be
    // renamed or archived while a delivery is retrying, so rendering must not
    // depend on the mutable groups row.
    classNameSnapshot: text("class_name_snapshot"),
    // Frozen IANA timezone used by coverage/report calculations. School
    // settings can change after a class ends, so reports never reread them.
    timezoneSnapshot: text("timezone_snapshot"),
    // Marks that the immutable session roster snapshot was completed, even
    // when the class legitimately had zero students at the time it started.
    rosterSnapshotCompletedAt: timestamp("roster_snapshot_completed_at", { withTimezone: true }),
    scheduledState: text("scheduled_state"), // active | finalized | skipped
    scheduledFinalizationReason: text("scheduled_finalization_reason"),
    endTime: timestamp("end_time"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("teaching_sessions_group_id_idx").on(table.groupId),
    index("teaching_sessions_teacher_id_idx").on(table.teacherId),
    index("teaching_sessions_session_mode_idx").on(table.sessionMode),
    index("teaching_sessions_scheduled_conflict_idx").on(table.scheduledConflictId),
    uniqueIndex("teaching_sessions_scheduled_occurrence_unique")
      .on(table.schoolId, table.groupId, table.scheduledDate)
      .where(sql`${table.scheduledDate} IS NOT NULL`),
    index("teaching_sessions_scheduled_due_idx").on(
      table.scheduledState,
      table.scheduledEndAt
    ),
    check(
      "teaching_sessions_scheduled_state_check",
      sql`${table.scheduledState} IS NULL OR ${table.scheduledState} IN ('active', 'finalized', 'skipped')`
    ),
    check(
      "teaching_sessions_scheduled_window_check",
      sql`${table.scheduledStartAt} IS NULL OR ${table.scheduledEndAt} IS NULL OR ${table.scheduledEndAt} > ${table.scheduledStartAt}`
    ),
    check(
      "teaching_sessions_scheduled_metadata_check",
      sql`(
        ${table.scheduledDate} IS NULL
        AND ${table.scheduledTimezone} IS NULL
        AND ${table.scheduledStartAt} IS NULL
        AND ${table.scheduledEndAt} IS NULL
        AND ${table.scheduledState} IS NULL
      ) OR (
        ${table.scheduledDate} IS NOT NULL
        AND ${table.scheduledTimezone} IS NOT NULL
        AND ${table.scheduledStartAt} IS NOT NULL
        AND ${table.scheduledEndAt} IS NOT NULL
        AND ${table.scheduledState} IS NOT NULL
      )`
    ),
  ]
);

export type TeachingSession = typeof teachingSessions.$inferSelect;
export type InsertTeachingSession = typeof teachingSessions.$inferInsert;

// ============================================================================
// Session Summary Deliveries - durable, idempotent per-recipient outbox
// ============================================================================
export const classpilotSessionSummaryDeliveries = pgTable(
  "classpilot_session_summary_deliveries",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    recipientKind: text("recipient_kind").notNull(), // teacher | central
    recipientEmail: text("recipient_email").notNull(),
    recipientName: text("recipient_name"),
    state: text("state").notNull().default("waiting_report"), // waiting_report | queued | leased | retry | sent | failed | unknown
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    submissionStartedAt: timestamp("submission_started_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_summary_delivery_session_kind_unique").on(
      table.teachingSessionId,
      table.recipientKind
    ),
    uniqueIndex("cp_summary_delivery_session_email_unique").on(
      table.teachingSessionId,
      sql`lower(btrim(${table.recipientEmail}))`
    ),
    index("cp_summary_delivery_school_session_idx").on(
      table.schoolId,
      table.teachingSessionId
    ),
    index("cp_summary_delivery_due_idx").on(table.state, table.nextAttemptAt),
    index("cp_summary_delivery_lease_idx").on(table.state, table.leaseExpiresAt),
    check(
      "cp_summary_delivery_recipient_kind_check",
      sql`${table.recipientKind} IN ('teacher', 'central')`
    ),
    check(
      "cp_summary_delivery_state_check",
      sql`${table.state} IN ('waiting_report', 'queued', 'leased', 'retry', 'sent', 'failed', 'unknown')`
    ),
    check("cp_summary_delivery_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("cp_summary_delivery_email_check", sql`btrim(${table.recipientEmail}) <> ''`),
  ]
);

export type ClasspilotSessionSummaryDelivery =
  typeof classpilotSessionSummaryDeliveries.$inferSelect;
export type InsertClasspilotSessionSummaryDelivery =
  typeof classpilotSessionSummaryDeliveries.$inferInsert;

// ============================================================================
// Immutable Session Reports - materialized once after the settlement window
// ============================================================================
export const classpilotSessionReports = pgTable(
  "classpilot_session_reports",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    state: text("state").notNull().default("pending"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    coverageAlgorithmVersion: text("coverage_algorithm_version")
      .notNull()
      .default("heartbeat-coverage-v1"),
    eventSchemaVersion: integer("event_schema_version").notNull().default(1),
    // Salted, one-way staff identifiers preserve the ability to return an
    // authorized 410 after detailed retention removes the immutable staff
    // rows. The marker never contains a raw staff identifier.
    authorizationMarker: jsonb("authorization_marker").$type<{
      version: 1;
      salt: string;
      digests: string[];
    }>().notNull(),
    // Frozen with the report at finalization so a settings edit during the
    // settlement window or a later retry cannot rewrite eligibility.
    trackingPolicy: jsonb("tracking_policy").$type<{
      enableTrackingHours: boolean;
      trackingStartTime: string | null;
      trackingEndTime: string | null;
      trackingDays: string[];
      schoolTimezone: string;
      afterHoursMode: "off" | "limited" | "full";
    }>(),
    rosterCount: integer("roster_count").notNull().default(0),
    eligibleStudentCount: integer("eligible_student_count").notNull().default(0),
    completeCount: integer("complete_count").notNull().default(0),
    partialCount: integer("partial_count").notNull().default(0),
    noneCount: integer("none_count").notNull().default(0),
    notExpectedCount: integer("not_expected_count").notNull().default(0),
    unavailableCount: integer("unavailable_count").notNull().default(0),
    totalEligibleSeconds: integer("total_eligible_seconds").notNull().default(0),
    totalObservedSeconds: integer("total_observed_seconds").notNull().default(0),
    totalGapSeconds: integer("total_gap_seconds").notNull().default(0),
    settleAt: timestamp("settle_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    materializedAt: timestamp("materialized_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Set only after the retention worker has deleted/redacted report detail.
    // `state = expired` or expiresAt alone means reads are blocked, not that
    // the underlying PII cleanup has already completed.
    detailExpiredAt: timestamp("detail_expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_session_reports_session_unique").on(table.teachingSessionId),
    index("cp_session_reports_school_session_idx").on(table.schoolId, table.teachingSessionId),
    index("cp_session_reports_due_idx").on(table.state, table.nextAttemptAt),
    index("cp_session_reports_expiry_idx").on(table.state, table.expiresAt),
    check(
      "cp_session_reports_state_check",
      sql`${table.state} IN ('pending', 'materializing', 'ready', 'failed', 'expired')`
    ),
    check("cp_session_reports_window_check", sql`${table.windowEnd} >= ${table.windowStart}`),
    check("cp_session_reports_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "cp_session_reports_authorization_marker_check",
      sql`jsonb_typeof(${table.authorizationMarker}) = 'object'
        AND ${table.authorizationMarker}->>'version' = '1'
        AND jsonb_typeof(${table.authorizationMarker}->'salt') = 'string'
        AND length(${table.authorizationMarker}->>'salt') BETWEEN 16 AND 128
        AND jsonb_typeof(${table.authorizationMarker}->'digests') = 'array'`
    ),
  ]
);

export type ClasspilotSessionReport = typeof classpilotSessionReports.$inferSelect;
export type InsertClasspilotSessionReport = typeof classpilotSessionReports.$inferInsert;

export const classpilotSessionStudentReports = pgTable(
  "classpilot_session_student_reports",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    reportId: varchar("report_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    studentId: text("student_id").notNull(),
    studentNameSnapshot: text("student_name_snapshot").notNull(),
    status: text("status").notNull(),
    eligibleSeconds: integer("eligible_seconds").notNull().default(0),
    observedSeconds: integer("observed_seconds").notNull().default(0),
    gapSeconds: integer("gap_seconds").notNull().default(0),
    coveragePercent: integer("coverage_percent"),
    heartbeatCount: integer("heartbeat_count").notNull().default(0),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    gapIntervals: jsonb("gap_intervals").notNull().default(sql`'[]'::jsonb`),
    eventCounts: jsonb("event_counts").notNull().default(sql`'{}'::jsonb`),
    topDomains: jsonb("top_domains").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_student_reports_report_student_unique").on(table.reportId, table.studentId),
    index("cp_student_reports_school_session_idx").on(table.schoolId, table.teachingSessionId),
    index("cp_student_reports_school_student_idx").on(table.schoolId, table.studentId),
    check(
      "cp_student_reports_status_check",
      sql`${table.status} IN ('complete', 'partial', 'none', 'not_expected', 'unavailable')`
    ),
    check(
      "cp_student_reports_coverage_check",
      sql`${table.coveragePercent} IS NULL OR (${table.coveragePercent} >= 0 AND ${table.coveragePercent} <= 100)`
    ),
  ]
);

export type ClasspilotSessionStudentReport = typeof classpilotSessionStudentReports.$inferSelect;
export type InsertClasspilotSessionStudentReport = typeof classpilotSessionStudentReports.$inferInsert;

export const classpilotSessionStaff = pgTable(
  "classpilot_session_staff",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    staffId: text("staff_id").notNull(),
    role: text("role").notNull(),
    staffNameSnapshot: text("staff_name_snapshot"),
    staffEmailSnapshot: text("staff_email_snapshot"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_session_staff_session_staff_unique").on(table.teachingSessionId, table.staffId),
    index("cp_session_staff_school_session_idx").on(table.schoolId, table.teachingSessionId),
    index("cp_session_staff_school_staff_idx").on(table.schoolId, table.staffId),
    check("cp_session_staff_role_check", sql`${table.role} IN ('primary', 'co_teacher')`),
  ]
);

export type ClasspilotSessionStaff = typeof classpilotSessionStaff.$inferSelect;
export type InsertClasspilotSessionStaff = typeof classpilotSessionStaff.$inferInsert;

// ============================================================================
// Per-student desired classroom controls - authoritative full snapshots
// ============================================================================
export const classpilotStudentControlStates = pgTable(
  "classpilot_student_control_states",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id").notNull(),
    teachingSessionId: varchar("teaching_session_id"),
    supervisionContextId: varchar("supervision_context_id"),
    revision: integer("revision").notNull().default(0),
    desiredState: jsonb("desired_state").notNull().default(sql`'{}'::jsonb`),
    sourceCommandId: varchar("source_command_id"),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
    hardExpiresAt: timestamp("hard_expires_at", { withTimezone: true }),
    enforcementHealth: text("enforcement_health").notNull().default("pending"),
    appliedRevision: integer("applied_revision"),
    lastOutcome: text("last_outcome"),
    lastError: text("last_error"),
    lastAcknowledgedAt: timestamp("last_acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("cp_student_control_states_school_student_unique").on(
      table.schoolId,
      table.studentId
    ),
    index("cp_student_control_states_session_idx").on(
      table.schoolId,
      table.teachingSessionId
    ),
    index("cp_student_control_states_context_idx").on(
      table.schoolId,
      table.supervisionContextId
    ),
    index("cp_student_control_states_expiry_idx").on(table.hardExpiresAt),
    check("cp_student_control_states_revision_check", sql`${table.revision} >= 0`),
    check(
      "cp_student_control_states_applied_revision_check",
      sql`${table.appliedRevision} IS NULL OR (${table.appliedRevision} >= 0 AND ${table.appliedRevision} <= ${table.revision})`
    ),
    check(
      "cp_student_control_states_health_check",
      sql`${table.enforcementHealth} IN ('synced', 'pending', 'failed', 'unsupported', 'expired')`
    ),
    check(
      "cp_student_control_states_session_expiry_check",
      sql`(
        num_nonnulls(${table.teachingSessionId}, ${table.supervisionContextId}) = 0
        AND ${table.scheduledEndAt} IS NULL
        AND ${table.hardExpiresAt} IS NULL
      ) OR (
        num_nonnulls(${table.teachingSessionId}, ${table.supervisionContextId}) = 1
        AND ${table.hardExpiresAt} IS NOT NULL
        AND (${table.scheduledEndAt} IS NULL OR ${table.scheduledEndAt} <= ${table.hardExpiresAt})
      )`
    ),
  ]
);

export type ClasspilotStudentControlState = typeof classpilotStudentControlStates.$inferSelect;
export type InsertClasspilotStudentControlState = typeof classpilotStudentControlStates.$inferInsert;

// ============================================================================
// Scheduled Class Conflicts - coverage needed for unattended scheduled starts
// ============================================================================
export const classpilotScheduledConflicts = pgTable(
  "classpilot_scheduled_conflicts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    groupId: text("group_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    scheduledDate: text("scheduled_date").notNull(),
    blockStartTime: text("block_start_time").notNull(),
    blockEndTime: text("block_end_time"),
    status: text("status").notNull().default("coverage_needed"),
    conflictPayload: jsonb("conflict_payload").notNull().default(sql`'{}'::jsonb`),
    scheduledTeacherConnected: boolean("scheduled_teacher_connected").notNull().default(false),
    lastCheckedAt: timestamp("last_checked_at").notNull().default(sql`now()`),
    resolvedAt: timestamp("resolved_at"),
    resolvedBy: text("resolved_by"),
    resolution: text("resolution"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("classpilot_scheduled_conflicts_unique").on(
      table.schoolId,
      table.groupId,
      table.scheduledDate,
      table.blockStartTime
    ),
    index("classpilot_scheduled_conflicts_school_status_idx").on(table.schoolId, table.status),
    index("classpilot_scheduled_conflicts_teacher_idx").on(table.schoolId, table.teacherId),
  ]
);

export type ClasspilotScheduledConflict = typeof classpilotScheduledConflicts.$inferSelect;
export type InsertClasspilotScheduledConflict = typeof classpilotScheduledConflicts.$inferInsert;

// ============================================================================
// Session-attributed usage - forward-only class analytics
// ============================================================================
export const classpilotSessionStudents = pgTable(
  "classpilot_session_students",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    groupId: text("group_id").notNull(),
    studentId: text("student_id").notNull(),
    studentNameSnapshot: text("student_name_snapshot"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("classpilot_session_students_session_student_unique").on(
      table.teachingSessionId,
      table.studentId
    ),
    index("classpilot_session_students_school_session_idx").on(
      table.schoolId,
      table.teachingSessionId
    ),
    index("classpilot_session_students_school_group_idx").on(
      table.schoolId,
      table.groupId
    ),
    index("classpilot_session_students_school_student_idx").on(
      table.schoolId,
      table.studentId
    ),
  ]
);

export type ClasspilotSessionStudent = typeof classpilotSessionStudents.$inferSelect;
export type InsertClasspilotSessionStudent = typeof classpilotSessionStudents.$inferInsert;

export const classpilotSessionUsage = pgTable(
  "classpilot_session_usage",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    groupId: text("group_id").notNull(),
    studentId: text("student_id").notNull(),
    localDate: text("local_date").notNull(),
    totalSeconds: integer("total_seconds").notNull().default(0),
    heartbeatCount: integer("heartbeat_count").notNull().default(0),
    topDomains: jsonb("top_domains"),
    firstSeen: timestamp("first_seen", { withTimezone: true }),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("classpilot_session_usage_session_student_date_unique").on(
      table.teachingSessionId,
      table.studentId,
      table.localDate
    ),
    index("classpilot_session_usage_school_date_idx").on(
      table.schoolId,
      table.localDate
    ),
    index("classpilot_session_usage_school_group_date_idx").on(
      table.schoolId,
      table.groupId,
      table.localDate
    ),
    index("classpilot_session_usage_school_session_idx").on(
      table.schoolId,
      table.teachingSessionId
    ),
  ]
);

export type ClasspilotSessionUsage = typeof classpilotSessionUsage.$inferSelect;
export type InsertClasspilotSessionUsage = typeof classpilotSessionUsage.$inferInsert;

// ============================================================================
// Scoped classroom monitoring events - privacy-bounded extension telemetry
// ============================================================================
export const classpilotMonitoringEvents = pgTable(
  "classpilot_monitoring_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    studentId: text("student_id").notNull(),
    // Internal correlation fields. Teacher-facing reads and exports never
    // serialize either identifier.
    deviceId: text("device_id"),
    studentSessionId: varchar("student_session_id").notNull(),
    teachingSessionId: varchar("teaching_session_id"),
    supervisionContextId: varchar("supervision_context_id"),
    sourceEventId: varchar("source_event_id", { length: 128 }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    origin: text("origin").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().default(sql`now()`),
    normalizedDomain: text("normalized_domain"),
    sanitizedPath: text("sanitized_path"),
    title: text("title"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("cp_monitoring_events_source_unique").on(
      table.schoolId,
      table.studentSessionId,
      table.sourceEventId
    ),
    index("cp_monitoring_events_session_time_idx").on(
      table.schoolId,
      table.teachingSessionId,
      table.occurredAt.desc(),
      table.id
    ),
    index("cp_monitoring_events_context_time_idx").on(
      table.schoolId,
      table.supervisionContextId,
      table.occurredAt.desc(),
      table.id
    ),
    index("cp_monitoring_events_student_time_idx").on(
      table.schoolId,
      table.studentId,
      table.occurredAt.desc()
    ),
    index("cp_monitoring_events_retention_idx").on(table.retentionExpiresAt),
    check(
      "cp_monitoring_events_scope_xor_check",
      sql`num_nonnulls(${table.teachingSessionId}, ${table.supervisionContextId}) = 1`
    ),
    check("cp_monitoring_events_schema_check", sql`${table.schemaVersion} = 1`),
    check("cp_monitoring_events_origin_check", sql`${table.origin} IN ('extension', 'server')`),
    check(
      "cp_monitoring_events_type_check",
      sql`${table.eventType} IN (
        'tab_changed', 'navigation_changed', 'navigation_blocked',
        'monitoring_state_changed', 'restriction_state_applied',
        'restriction_state_failed', 'restriction_state_cleared',
        'student_session_started', 'student_session_ended', 'monitoring_gap'
      )`
    ),
  ]
);

export type ClasspilotMonitoringEvent = typeof classpilotMonitoringEvents.$inferSelect;
export type InsertClasspilotMonitoringEvent = typeof classpilotMonitoringEvents.$inferInsert;

// ============================================================================
// Session Settings - Per-session feature toggles
// ============================================================================
export const sessionSettings = pgTable("session_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull(),
  sessionId: varchar("session_id").notNull().unique(),
  chatEnabled: boolean("chat_enabled").default(true),
  raiseHandEnabled: boolean("raise_hand_enabled").default(true),
  lifecycleRevision: integer("lifecycle_revision").notNull().default(1),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  index("session_settings_school_session_idx").on(table.schoolId, table.sessionId),
  check("session_settings_revision_check", sql`${table.lifecycleRevision} > 0`),
]);

export type SessionSetting = typeof sessionSettings.$inferSelect;
export type InsertSessionSetting = typeof sessionSettings.$inferInsert;

// ============================================================================
// Chat Messages - Session-scoped messaging
// ============================================================================
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    sessionId: varchar("session_id").notNull(),
    studentId: text("student_id"),
    deviceId: text("device_id"),
    senderId: text("sender_id").notNull(),
    senderType: text("sender_type").notNull().$type<"teacher" | "student">(),
    recipientId: text("recipient_id"), // null = broadcast
    content: text("content").notNull(),
    messageType: text("message_type")
      .notNull()
      .$type<"message" | "raise_hand" | "question">(),
    deliveryStatus: text("delivery_status")
      .notNull()
      .default("sent")
      .$type<"sent" | "delivered" | "failed">(),
    deliveredAt: timestamp("delivered_at"),
    failedAt: timestamp("failed_at"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("chat_messages_session_id_idx").on(table.sessionId),
    index("chat_messages_school_session_idx").on(table.schoolId, table.sessionId),
    index("chat_messages_school_student_idx").on(table.schoolId, table.studentId),
  ]
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = typeof chatMessages.$inferInsert;

// ============================================================================
// Chat Deliveries - Durable teacher-to-student reply outbox
// ============================================================================
export const classpilotChatDeliveries = pgTable(
  "classpilot_chat_deliveries",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    chatMessageId: varchar("chat_message_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    studentId: text("student_id").notNull(),
    state: text("state")
      .notNull()
      .default("queued")
      .$type<"queued" | "leased" | "attempted" | "retry" | "delivered" | "failed" | "expired">(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().default(sql`now()`),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastAttemptStudentSessionId: varchar("last_attempt_student_session_id"),
    lastAttemptDeviceId: text("last_attempt_device_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    uniqueIndex("classpilot_chat_deliveries_message_unique").on(table.chatMessageId),
    index("classpilot_chat_deliveries_due_idx").on(table.state, table.nextAttemptAt),
    index("classpilot_chat_deliveries_school_student_idx").on(table.schoolId, table.studentId, table.state),
    check("classpilot_chat_deliveries_attempt_check", sql`${table.attemptCount} >= 0`),
    check(
      "classpilot_chat_deliveries_state_check",
      sql`${table.state} IN ('queued', 'leased', 'attempted', 'retry', 'delivered', 'failed', 'expired')`
    ),
  ]
);

export type ClasspilotChatDelivery = typeof classpilotChatDeliveries.$inferSelect;
export type InsertClasspilotChatDelivery = typeof classpilotChatDeliveries.$inferInsert;

// ============================================================================
// Active Hands - Recoverable per-session raised hand state
// ============================================================================
export const classpilotActiveHands = pgTable(
  "classpilot_active_hands",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    studentId: text("student_id").notNull(),
    deviceId: text("device_id").notNull(),
    raisedAt: timestamp("raised_at").notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at"),
    clearedAt: timestamp("cleared_at"),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_active_hands_session_idx").on(table.schoolId, table.teachingSessionId),
    index("classpilot_active_hands_student_idx").on(table.schoolId, table.studentId),
    uniqueIndex("classpilot_active_hands_active_unique")
      .on(table.teachingSessionId, table.studentId)
      .where(sql`cleared_at IS NULL`),
  ]
);

export type ClasspilotActiveHand = typeof classpilotActiveHands.$inferSelect;
export type InsertClasspilotActiveHand = typeof classpilotActiveHands.$inferInsert;

// ============================================================================
// Polls - Quick pulse checks
// ============================================================================
export const polls = pgTable(
  "polls",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    sessionId: varchar("session_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    startCommandId: varchar("start_command_id"),
    closeCommandId: varchar("close_command_id"),
    question: text("question").notNull(),
    options: text("options").array().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    closedAt: timestamp("closed_at"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => [
    index("polls_session_id_idx").on(table.sessionId),
    index("polls_school_session_idx").on(table.schoolId, table.sessionId),
    uniqueIndex("polls_active_session_unique")
      .on(table.schoolId, table.sessionId)
      .where(sql`is_active = true`),
    uniqueIndex("polls_start_command_unique")
      .on(table.startCommandId)
      .where(sql`start_command_id IS NOT NULL`),
    uniqueIndex("polls_close_command_unique")
      .on(table.closeCommandId)
      .where(sql`close_command_id IS NOT NULL`),
  ]
);

export type Poll = typeof polls.$inferSelect;
export type InsertPoll = typeof polls.$inferInsert;

// ============================================================================
// Poll Responses
// ============================================================================
export const pollResponses = pgTable(
  "poll_responses",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    pollId: varchar("poll_id").notNull(),
    studentId: text("student_id").notNull(),
    deviceId: text("device_id"),
    selectedOption: integer("selected_option").notNull(),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByResponseId: varchar("superseded_by_response_id"),
  },
  (table) => [
    index("poll_responses_poll_id_idx").on(table.pollId),
    index("poll_responses_school_poll_idx").on(table.schoolId, table.pollId),
    index("poll_responses_school_student_idx").on(table.schoolId, table.studentId),
    uniqueIndex("poll_responses_poll_student_active_unique")
      .on(table.pollId, table.studentId)
      .where(sql`superseded_at IS NULL`),
    foreignKey({
      columns: [table.schoolId, table.studentId],
      foreignColumns: [students.schoolId, students.id],
      name: "poll_responses_school_student_fk",
    }).onDelete("restrict"),
  ]
);

export type PollResponse = typeof pollResponses.$inferSelect;
export type InsertPollResponse = typeof pollResponses.$inferInsert;

// ============================================================================
// Teacher Commands - Explicit class-scoped command tracking
// ============================================================================
export const classpilotCommands = pgTable(
  "classpilot_commands",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id"),
    supervisionContextId: varchar("supervision_context_id"),
    teacherId: text("teacher_id").notNull(),
    targetScope: text("target_scope")
      .notNull()
      .$type<"class" | "subgroup" | "students" | "context">(),
    subgroupId: varchar("subgroup_id"),
    commandType: text("command_type").notNull(),
    commandPayload: jsonb("command_payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status")
      .notNull()
      .default("requested")
      .$type<"requested" | "sent" | "received" | "completed" | "failed" | "unavailable" | "expired">(),
    requestedCount: integer("requested_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    receivedCount: integer("received_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    unavailableCount: integer("unavailable_count").notNull().default(0),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_commands_school_session_idx").on(
      table.schoolId,
      table.teachingSessionId
    ),
    index("classpilot_commands_school_context_idx").on(
      table.schoolId,
      table.supervisionContextId
    ),
    index("classpilot_commands_teacher_created_idx").on(
      table.teacherId,
      table.createdAt
    ),
  ]
);

export type ClasspilotCommand = typeof classpilotCommands.$inferSelect;
export type InsertClasspilotCommand = typeof classpilotCommands.$inferInsert;

export const classpilotCommandTargets = pgTable(
  "classpilot_command_targets",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    commandId: varchar("command_id").notNull(),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id"),
    supervisionContextId: varchar("supervision_context_id"),
    studentId: text("student_id").notNull(),
    studentSessionId: varchar("student_session_id"),
    deviceId: text("device_id"),
    status: text("status")
      .notNull()
      .default("requested")
      .$type<"requested" | "sent" | "received" | "completed" | "failed" | "unavailable" | "expired">(),
    ackState: text("ack_state"),
    errorMessage: text("error_message"),
    result: jsonb("result"),
    sentAt: timestamp("sent_at"),
    receivedAt: timestamp("received_at"),
    completedAt: timestamp("completed_at"),
    failedAt: timestamp("failed_at"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_command_targets_command_idx").on(table.commandId),
    index("classpilot_command_targets_school_student_idx").on(
      table.schoolId,
      table.studentId
    ),
    index("classpilot_command_targets_school_context_idx").on(
      table.schoolId,
      table.supervisionContextId
    ),
    index("classpilot_command_targets_device_idx").on(table.deviceId),
  ]
);

export type ClasspilotCommandTarget = typeof classpilotCommandTargets.$inferSelect;
export type InsertClasspilotCommandTarget = typeof classpilotCommandTargets.$inferInsert;

export const classpilotClassroomStates = pgTable(
  "classpilot_classroom_states",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teachingSessionId: varchar("teaching_session_id").notNull(),
    studentId: text("student_id"),
    stateType: text("state_type").notNull(),
    stateKey: text("state_key").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    commandId: varchar("command_id"),
    appliedBy: text("applied_by").notNull(),
    appliedAt: timestamp("applied_at").notNull().default(sql`now()`),
    expiresAt: timestamp("expires_at"),
    clearedAt: timestamp("cleared_at"),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_classroom_states_session_idx").on(
      table.schoolId,
      table.teachingSessionId
    ),
    index("classpilot_classroom_states_student_idx").on(
      table.schoolId,
      table.studentId
    ),
    uniqueIndex("classpilot_classroom_states_active_unique")
      .on(table.teachingSessionId, table.studentId, table.stateType, table.stateKey)
      .where(sql`cleared_at IS NULL`),
  ]
);

export type ClasspilotClassroomState = typeof classpilotClassroomStates.$inferSelect;
export type InsertClasspilotClassroomState = typeof classpilotClassroomStates.$inferInsert;

// ============================================================================
// Supervision Coverage - Online unassigned + temporary coverage contexts
// ============================================================================
export const classpilotCoverageAssignments = pgTable(
  "classpilot_coverage_assignments",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    staffId: text("staff_id").notNull(),
    scopeType: text("scope_type")
      .notNull()
      .$type<"school" | "grade" | "group" | "students" | "coverage_group" | "setup">(),
    scopeValue: text("scope_value"),
    permissions: jsonb("permissions").notNull().default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_coverage_assignments_school_staff_idx").on(
      table.schoolId,
      table.staffId
    ),
    index("classpilot_coverage_assignments_scope_idx").on(
      table.schoolId,
      table.scopeType,
      table.scopeValue
    ),
  ]
);

export type ClasspilotCoverageAssignment = typeof classpilotCoverageAssignments.$inferSelect;
export type InsertClasspilotCoverageAssignment = typeof classpilotCoverageAssignments.$inferInsert;

export const classpilotCoverageScopeGroups = pgTable(
  "classpilot_coverage_scope_groups",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_coverage_scope_groups_school_idx").on(
      table.schoolId,
      table.active
    ),
  ]
);

export type ClasspilotCoverageScopeGroup = typeof classpilotCoverageScopeGroups.$inferSelect;
export type InsertClasspilotCoverageScopeGroup = typeof classpilotCoverageScopeGroups.$inferInsert;

export const classpilotCoverageScopeGroupMembers = pgTable(
  "classpilot_coverage_scope_group_members",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    coverageGroupId: varchar("coverage_group_id").notNull(),
    studentId: text("student_id").notNull(),
    assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_coverage_scope_group_members_group_idx").on(
      table.schoolId,
      table.coverageGroupId
    ),
    uniqueIndex("classpilot_coverage_scope_group_members_unique").on(
      table.schoolId,
      table.coverageGroupId,
      table.studentId
    ),
  ]
);

export type ClasspilotCoverageScopeGroupMember = typeof classpilotCoverageScopeGroupMembers.$inferSelect;
export type InsertClasspilotCoverageScopeGroupMember = typeof classpilotCoverageScopeGroupMembers.$inferInsert;

export const classpilotSupervisionContexts = pgTable(
  "classpilot_supervision_contexts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    contextType: text("context_type").notNull(),
    name: text("name").notNull(),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "ended">(),
    assignedStaffId: text("assigned_staff_id").notNull(),
    coverageGroupId: text("coverage_group_id"),
    scheduledConflictId: text("scheduled_conflict_id"),
    createdBy: text("created_by").notNull(),
    note: text("note"),
    startsAt: timestamp("starts_at").notNull().default(sql`now()`),
    endsAt: timestamp("ends_at").notNull(),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("classpilot_supervision_contexts_school_status_idx").on(
      table.schoolId,
      table.status
    ),
    index("classpilot_supervision_contexts_staff_idx").on(
      table.schoolId,
      table.assignedStaffId
    ),
    index("classpilot_supervision_contexts_coverage_group_idx").on(
      table.schoolId,
      table.coverageGroupId
    ),
    index("classpilot_supervision_contexts_scheduled_conflict_idx").on(
      table.schoolId,
      table.scheduledConflictId
    ),
  ]
);

export type ClasspilotSupervisionContext = typeof classpilotSupervisionContexts.$inferSelect;
export type InsertClasspilotSupervisionContext = typeof classpilotSupervisionContexts.$inferInsert;

export const classpilotSupervisionStudents = pgTable(
  "classpilot_supervision_students",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    contextId: varchar("context_id").notNull(),
    studentId: text("student_id").notNull(),
    source: text("source").notNull().default("manual"),
    assignedBy: text("assigned_by").notNull(),
    assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
    releasedAt: timestamp("released_at"),
    releaseReason: text("release_reason"),
  },
  (table) => [
    index("classpilot_supervision_students_context_idx").on(
      table.schoolId,
      table.contextId
    ),
    index("classpilot_supervision_students_student_idx").on(
      table.schoolId,
      table.studentId
    ),
    uniqueIndex("classpilot_supervision_students_active_unique")
      .on(table.schoolId, table.studentId)
      .where(sql`released_at IS NULL`),
  ]
);

export type ClasspilotSupervisionStudent = typeof classpilotSupervisionStudents.$inferSelect;
export type InsertClasspilotSupervisionStudent = typeof classpilotSupervisionStudents.$inferInsert;

// ============================================================================
// Subgroups - Within-class differentiation
// ============================================================================
export const subgroups = pgTable("subgroups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  groupId: varchar("group_id").notNull(),
  // Derived from the parent group's school (backfilled + set on insert). Basis for RLS.
  schoolId: text("school_id"),
  name: text("name").notNull(),
  color: text("color"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export type Subgroup = typeof subgroups.$inferSelect;
export type InsertSubgroup = typeof subgroups.$inferInsert;

// ============================================================================
// Subgroup Members
// ============================================================================
export const subgroupMembers = pgTable("subgroup_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  subgroupId: varchar("subgroup_id").notNull(),
  studentId: text("student_id").notNull(),
  assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
});

export type SubgroupMember = typeof subgroupMembers.$inferSelect;
export type InsertSubgroupMember = typeof subgroupMembers.$inferInsert;

// ============================================================================
// Flight Paths - Activity-based browsing environments
// ============================================================================
export const flightPaths = pgTable(
  "flight_paths",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teacherId: text("teacher_id"),
    flightPathName: text("flight_path_name").notNull(),
    description: text("description"),
    allowedDomains: text("allowed_domains")
      .array()
      .default(sql`'{}'::text[]`),
    blockedDomains: text("blocked_domains")
      .array()
      .default(sql`'{}'::text[]`),
    isDefault: boolean("is_default").default(false),
    sourceType: text("source_type"),
    sourceCourseId: text("source_course_id"),
    sourceResourceIds: text("source_resource_ids")
      .array()
      .default(sql`'{}'::text[]`),
    sourceUpdatedAt: timestamp("source_updated_at"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("flight_paths_school_id_idx").on(table.schoolId),
    index("flight_paths_teacher_id_idx").on(table.teacherId),
  ]
);

export type FlightPath = typeof flightPaths.$inferSelect;
export type InsertFlightPath = typeof flightPaths.$inferInsert;

// ============================================================================
// Block Lists - Teacher-scoped website blocking
// ============================================================================
export const blockLists = pgTable(
  "block_lists",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    blockedDomains: text("blocked_domains")
      .array()
      .default(sql`'{}'::text[]`),
    isDefault: boolean("is_default").default(false),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("block_lists_school_id_idx").on(table.schoolId),
    index("block_lists_teacher_id_idx").on(table.teacherId),
  ]
);

export type BlockList = typeof blockLists.$inferSelect;
export type InsertBlockList = typeof blockLists.$inferInsert;

// ============================================================================
// Student Groups - Differentiated instruction groups
// ============================================================================
export const studentGroups = pgTable(
  "student_groups",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teacherId: text("teacher_id"),
    groupName: text("group_name").notNull(),
    description: text("description"),
    studentIds: text("student_ids")
      .array()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("student_groups_school_id_idx").on(table.schoolId),
  ]
);

export type StudentGroupRecord = typeof studentGroups.$inferSelect;
export type InsertStudentGroup = typeof studentGroups.$inferInsert;

// ============================================================================
// Messages - Teacher-student chat (legacy)
// ============================================================================
export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUserId: text("from_user_id"),
  toStudentId: text("to_student_id"),
  // Derived from the addressed student or active school context. Legacy rows may
  // be null and are hidden once RLS is enabled.
  schoolId: text("school_id"),
  commandId: varchar("command_id"),
  teachingSessionId: varchar("teaching_session_id"),
  supervisionContextId: varchar("supervision_context_id"),
  message: text("message").notNull(),
  isAnnouncement: boolean("is_announcement").default(false),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
}, (table) => [
  index("messages_school_id_idx").on(table.schoolId),
  uniqueIndex("messages_command_student_unique")
    .on(table.commandId, table.toStudentId)
    .where(sql`command_id IS NOT NULL AND to_student_id IS NOT NULL`),
]);

export type MessageRecord = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

// ============================================================================
// Check-ins - Student wellbeing polls
// ============================================================================
export const checkIns = pgTable("check_ins", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  studentId: text("student_id").notNull(),
  mood: text("mood").notNull(), // happy | neutral | sad | stressed
  message: text("message"),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
});

export type CheckIn = typeof checkIns.$inferSelect;
export type InsertCheckIn = typeof checkIns.$inferInsert;

// ============================================================================
// Dashboard Tabs - User-customizable filter tabs
// ============================================================================
export const dashboardTabs = pgTable("dashboard_tabs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherId: text("teacher_id").notNull(),
  // Set from res.locals.schoolId at create time. Partitions a multi-school
  // teacher's tabs by the school they're viewing (closes the deferred item).
  schoolId: text("school_id"),
  label: text("label").notNull(),
  filterType: text("filter_type").notNull(), // grade | group | status | multi-group | all
  filterValue: jsonb("filter_value"),
  order: text("order").notNull().default("0"),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export type DashboardTab = typeof dashboardTabs.$inferSelect;
export type InsertDashboardTab = typeof dashboardTabs.$inferInsert;

// ============================================================================
// Teacher Settings - Per-teacher overrides
// ============================================================================
export const teacherSettings = pgTable("teacher_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherId: text("teacher_id").notNull().unique(),
  maxTabsPerStudent: text("max_tabs_per_student"),
  allowedDomains: text("allowed_domains")
    .array()
    .default(sql`'{}'::text[]`),
  blockedDomains: text("blocked_domains")
    .array()
    .default(sql`'{}'::text[]`),
  defaultFlightPathId: text("default_flight_path_id"),
  handRaisingEnabled: boolean("hand_raising_enabled").notNull().default(true),
  studentMessagingEnabled: boolean("student_messaging_enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at").notNull().default(sql`now()`),
});

export type TeacherSettingRecord = typeof teacherSettings.$inferSelect;
export type InsertTeacherSetting = typeof teacherSettings.$inferInsert;

// ============================================================================
// Teacher Students - Co-teaching join table
// ============================================================================
export const teacherStudents = pgTable("teacher_students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  teacherId: text("teacher_id").notNull(),
  studentId: text("student_id").notNull(),
  // Derived from the assigned student's school (backfilled + set on insert). Basis for RLS.
  schoolId: text("school_id"),
  assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
});

export type TeacherStudent = typeof teacherStudents.$inferSelect;
export type InsertTeacherStudent = typeof teacherStudents.$inferInsert;

// ============================================================================
// Group Teachers - Co-teacher support (multiple teachers per group)
// ============================================================================
export const groupTeachers = pgTable(
  "group_teachers",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    groupId: text("group_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    role: text("role").notNull().default("primary"), // 'primary' | 'co-teacher'
    assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("group_teachers_unique").on(table.groupId, table.teacherId),
    index("group_teachers_group_id_idx").on(table.groupId),
    index("group_teachers_teacher_id_idx").on(table.teacherId),
  ]
);

export type GroupTeacher = typeof groupTeachers.$inferSelect;
export type InsertGroupTeacher = typeof groupTeachers.$inferInsert;
