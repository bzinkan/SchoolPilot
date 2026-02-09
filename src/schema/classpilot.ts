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
} from "drizzle-orm/pg-core";

// ============================================================================
// Devices - ClassPilot Chromebook registration
// ============================================================================
export const devices = pgTable("devices", {
  deviceId: varchar("device_id").primaryKey(),
  deviceName: text("device_name"),
  schoolId: text("school_id").notNull(),
  classId: text("class_id").notNull(),
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
      table.timestamp
    ),
  ]
);

export type Heartbeat = typeof heartbeats.$inferSelect;
export type InsertHeartbeat = typeof heartbeats.$inferInsert;

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
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("groups_school_id_idx").on(table.schoolId),
    index("groups_teacher_id_idx").on(table.teacherId),
  ]
);

export type Group = typeof groups.$inferSelect;
export type InsertGroup = typeof groups.$inferInsert;

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
    startTime: timestamp("start_time").notNull().default(sql`now()`),
    endTime: timestamp("end_time"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("teaching_sessions_group_id_idx").on(table.groupId),
    index("teaching_sessions_teacher_id_idx").on(table.teacherId),
  ]
);

export type TeachingSession = typeof teachingSessions.$inferSelect;
export type InsertTeachingSession = typeof teachingSessions.$inferInsert;

// ============================================================================
// Session Settings - Per-session feature toggles
// ============================================================================
export const sessionSettings = pgTable("session_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull().unique(),
  chatEnabled: boolean("chat_enabled").default(true),
  raiseHandEnabled: boolean("raise_hand_enabled").default(true),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export type SessionSetting = typeof sessionSettings.$inferSelect;
export type InsertSessionSetting = typeof sessionSettings.$inferInsert;

// ============================================================================
// Chat Messages - Session-scoped messaging
// ============================================================================
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: varchar("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    senderType: text("sender_type").notNull().$type<"teacher" | "student">(),
    recipientId: text("recipient_id"), // null = broadcast
    content: text("content").notNull(),
    messageType: text("message_type")
      .notNull()
      .$type<"message" | "raise_hand" | "question">(),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("chat_messages_session_id_idx").on(table.sessionId),
  ]
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = typeof chatMessages.$inferInsert;

// ============================================================================
// Polls - Quick pulse checks
// ============================================================================
export const polls = pgTable(
  "polls",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: varchar("session_id").notNull(),
    teacherId: text("teacher_id").notNull(),
    question: text("question").notNull(),
    options: text("options").array().notNull(),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    closedAt: timestamp("closed_at"),
  },
  (table) => [
    index("polls_session_id_idx").on(table.sessionId),
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
    pollId: varchar("poll_id").notNull(),
    studentId: text("student_id").notNull(),
    deviceId: text("device_id"),
    selectedOption: integer("selected_option").notNull(),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("poll_responses_poll_id_idx").on(table.pollId),
  ]
);

export type PollResponse = typeof pollResponses.$inferSelect;
export type InsertPollResponse = typeof pollResponses.$inferInsert;

// ============================================================================
// Subgroups - Within-class differentiation
// ============================================================================
export const subgroups = pgTable("subgroups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  groupId: varchar("group_id").notNull(),
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
  message: text("message").notNull(),
  isAnnouncement: boolean("is_announcement").default(false),
  timestamp: timestamp("timestamp").notNull().default(sql`now()`),
});

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
  assignedAt: timestamp("assigned_at").notNull().default(sql`now()`),
});

export type TeacherStudent = typeof teacherStudents.$inferSelect;
export type InsertTeacherStudent = typeof teacherStudents.$inferInsert;
