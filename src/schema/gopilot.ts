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
  date,
  time,
} from "drizzle-orm/pg-core";

// ============================================================================
// Homerooms - GoPilot
// ============================================================================
export const homerooms = pgTable(
  "homerooms",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    teacherId: text("teacher_id"), // FK to users
    name: text("name").notNull(),
    grade: text("grade").notNull(),
    room: text("room"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("homerooms_school_id_idx").on(table.schoolId),
    index("homerooms_teacher_id_idx").on(table.teacherId),
  ]
);

export type Homeroom = typeof homerooms.$inferSelect;
export type InsertHomeroom = typeof homerooms.$inferInsert;

// ============================================================================
// Parent-Student relationships - GoPilot
// ============================================================================
export const parentStudent = pgTable(
  "parent_student",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    parentId: text("parent_id").notNull(), // FK to users
    studentId: text("student_id").notNull(), // FK to students
    relationship: text("relationship").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    status: text("status").notNull().default("approved"), // pending | approved
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("parent_student_unique").on(table.parentId, table.studentId),
    index("parent_student_parent_id_idx").on(table.parentId),
    index("parent_student_student_id_idx").on(table.studentId),
  ]
);

export type ParentStudent = typeof parentStudent.$inferSelect;
export type InsertParentStudent = typeof parentStudent.$inferInsert;

// ============================================================================
// Authorized Pickups - GoPilot
// ============================================================================
export const authorizedPickups = pgTable(
  "authorized_pickups",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    studentId: text("student_id").notNull(),
    addedBy: text("added_by").notNull(), // FK to users
    name: text("name").notNull(),
    relationship: text("relationship").notNull(),
    phone: text("phone"),
    photoUrl: text("photo_url"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("authorized_pickups_student_id_idx").on(table.studentId),
  ]
);

export type AuthorizedPickup = typeof authorizedPickups.$inferSelect;
export type InsertAuthorizedPickup = typeof authorizedPickups.$inferInsert;

// ============================================================================
// Custody Alerts - GoPilot
// ============================================================================
export const custodyAlerts = pgTable(
  "custody_alerts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    studentId: text("student_id").notNull(),
    personName: text("person_name").notNull(),
    alertType: text("alert_type").notNull(), // custody_restriction | court_order
    notes: text("notes"),
    courtOrder: text("court_order"),
    createdBy: text("created_by"), // FK to users
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("custody_alerts_student_id_idx").on(table.studentId),
  ]
);

export type CustodyAlert = typeof custodyAlerts.$inferSelect;
export type InsertCustodyAlert = typeof custodyAlerts.$inferInsert;

// ============================================================================
// Bus Routes - GoPilot
// ============================================================================
export const busRoutes = pgTable(
  "bus_routes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    routeNumber: text("route_number").notNull(),
    departureTime: text("departure_time"), // HH:MM format
    status: text("status").notNull().default("waiting"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [index("bus_routes_school_id_idx").on(table.schoolId)]
);

export type BusRoute = typeof busRoutes.$inferSelect;
export type InsertBusRoute = typeof busRoutes.$inferInsert;

// ============================================================================
// Walker Zones - GoPilot
// ============================================================================
export const walkerZones = pgTable(
  "walker_zones",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("closed"),
  },
  (table) => [index("walker_zones_school_id_idx").on(table.schoolId)]
);

export type WalkerZone = typeof walkerZones.$inferSelect;
export type InsertWalkerZone = typeof walkerZones.$inferInsert;

// ============================================================================
// Dismissal Sessions - GoPilot (one per school per day)
// ============================================================================
export const dismissalSessions = pgTable(
  "dismissal_sessions",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    date: date("date").notNull().default(sql`CURRENT_DATE`),
    status: text("status").notNull().default("pending"), // pending | active | paused | completed
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    stats: jsonb("stats").default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("dismissal_sessions_school_date_unique").on(
      table.schoolId,
      table.date
    ),
    index("dismissal_sessions_school_id_idx").on(table.schoolId),
  ]
);

export type DismissalSession = typeof dismissalSessions.$inferSelect;
export type InsertDismissalSession = typeof dismissalSessions.$inferInsert;

// ============================================================================
// Dismissal Queue - GoPilot (students in today's dismissal)
// ============================================================================
export const dismissalQueue = pgTable(
  "dismissal_queue",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: text("session_id").notNull(), // FK to dismissalSessions
    studentId: text("student_id").notNull(), // FK to students
    guardianId: text("guardian_id"), // FK to users (parent)
    guardianName: text("guardian_name"),
    checkInTime: timestamp("check_in_time").default(sql`now()`),
    checkInMethod: text("check_in_method"), // app | car_number | bus_number | walker
    status: text("status").notNull().default("waiting"), // waiting | called | released | dismissed | held | delayed
    zone: text("zone"),
    calledAt: timestamp("called_at"),
    releasedAt: timestamp("released_at"),
    dismissedAt: timestamp("dismissed_at"),
    holdReason: text("hold_reason"),
    delayedUntil: timestamp("delayed_until"),
    position: integer("position"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("dismissal_queue_session_status_idx").on(
      table.sessionId,
      table.status
    ),
    index("dismissal_queue_student_id_idx").on(table.studentId),
  ]
);

export type DismissalQueueEntry = typeof dismissalQueue.$inferSelect;
export type InsertDismissalQueueEntry = typeof dismissalQueue.$inferInsert;

// ============================================================================
// Dismissal Changes - GoPilot (type change requests)
// ============================================================================
export const dismissalChanges = pgTable(
  "dismissal_changes",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: text("session_id").notNull(),
    studentId: text("student_id").notNull(),
    requestedBy: text("requested_by").notNull(), // FK to users
    fromType: text("from_type").notNull(),
    toType: text("to_type").notNull(),
    busRoute: text("bus_route"),
    note: text("note"),
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"), // FK to users
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
    reviewedAt: timestamp("reviewed_at"),
  },
  (table) => [
    index("dismissal_changes_session_id_idx").on(table.sessionId),
    index("dismissal_changes_student_id_idx").on(table.studentId),
  ]
);

export type DismissalChange = typeof dismissalChanges.$inferSelect;
export type InsertDismissalChange = typeof dismissalChanges.$inferInsert;

// ============================================================================
// Family Groups - GoPilot (no-app dismissal mode)
// ============================================================================
export const familyGroups = pgTable(
  "family_groups",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    schoolId: text("school_id").notNull(),
    carNumber: text("car_number").notNull(),
    familyName: text("family_name"),
    inviteToken: text("invite_token"),
    claimedByUserId: text("claimed_by_user_id"), // FK to users
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    unique("family_groups_school_car_unique").on(
      table.schoolId,
      table.carNumber
    ),
    uniqueIndex("family_groups_invite_token_unique")
      .on(table.inviteToken)
      .where(sql`invite_token IS NOT NULL`),
    index("family_groups_school_id_idx").on(table.schoolId),
  ]
);

export type FamilyGroup = typeof familyGroups.$inferSelect;
export type InsertFamilyGroup = typeof familyGroups.$inferInsert;

// ============================================================================
// Family Group Students - GoPilot join table
// ============================================================================
export const familyGroupStudents = pgTable(
  "family_group_students",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    familyGroupId: text("family_group_id").notNull(),
    studentId: text("student_id").notNull(),
  },
  (table) => [
    unique("family_group_students_unique").on(
      table.familyGroupId,
      table.studentId
    ),
  ]
);

export type FamilyGroupStudent = typeof familyGroupStudents.$inferSelect;
export type InsertFamilyGroupStudent = typeof familyGroupStudents.$inferInsert;

// ============================================================================
// Activity Log - GoPilot audit trail
// ============================================================================
export const activityLog = pgTable(
  "activity_log",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: text("session_id"), // FK to dismissalSessions
    schoolId: text("school_id").notNull(),
    actorId: text("actor_id"), // FK to users
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    details: jsonb("details"),
    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => [
    index("activity_log_session_id_idx").on(table.sessionId),
    index("activity_log_school_date_idx").on(
      table.schoolId,
      table.createdAt
    ),
  ]
);

export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type InsertActivityLogEntry = typeof activityLog.$inferInsert;
