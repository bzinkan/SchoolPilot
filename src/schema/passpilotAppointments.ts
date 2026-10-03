import { sql } from "drizzle-orm";
import { pgTable, text, varchar, uuid, timestamp, integer, check, foreignKey, unique, index } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import { students } from "./students.js";
import { passes } from "./passpilot.js";

export const PASSPILOT_APPOINTMENT_STATUSES = ["scheduled", "activated", "completed", "cancelled", "missed"] as const;
export type PasspilotAppointmentStatus = typeof PASSPILOT_APPOINTMENT_STATUSES[number];

/** Notification delivery is separate; scheduling itself never issues a pass. */
export const passpilotAppointments = pgTable("passpilot_appointments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().references(() => schools.id, { onDelete: "cascade" }),
  studentId: varchar("student_id").notNull(),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
  activatedBy: varchar("activated_by").references(() => users.id, { onDelete: "set null" }),
  createRequestId: uuid("create_request_id").notNull(),
  createFingerprint: text("create_fingerprint").notNull(),
  destination: text("destination").notNull(),
  customDestination: text("custom_destination"),
  staffNotes: text("staff_notes"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  schoolTimezone: text("school_timezone").notNull(),
  retainedUntil: timestamp("retained_until", { withTimezone: true }).notNull(),
  duration: integer("duration").notNull().default(5),
  status: text("status").notNull().default("scheduled").$type<PasspilotAppointmentStatus>(),
  revision: integer("revision").notNull().default(1),
  passId: varchar("pass_id"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  missedAt: timestamp("missed_at", { withTimezone: true }),
  notesScrubbedAt: timestamp("notes_scrubbed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
}, (table) => [
  unique("pp_appointments_school_id_unique").on(table.schoolId, table.id),
  unique("pp_appointments_create_request_unique").on(table.schoolId, table.createdBy, table.createRequestId),
  unique("pp_appointments_pass_unique").on(table.schoolId, table.passId),
  index("pp_appointments_school_window_idx").on(table.schoolId, table.startsAt, table.id),
  index("pp_appointments_school_student_window_idx").on(table.schoolId, table.studentId, table.startsAt, table.id),
  index("pp_appointments_pending_end_idx").on(table.endsAt).where(sql`${table.status} = 'scheduled'`),
  index("pp_appointments_retention_idx").on(table.retainedUntil),
  foreignKey({ columns: [table.schoolId, table.studentId], foreignColumns: [students.schoolId, students.id], name: "pp_appointments_student_school_fk" }).onDelete("cascade"),
  // The ledger installs column-specific SET NULL (pass_id), preserving tenant
  // and student identity after an explicit retained-pass deletion. db:push must
  // not replace this composite FK's action with an all-column SET NULL.
  foreignKey({ columns: [table.schoolId, table.studentId, table.passId], foreignColumns: [passes.schoolId, passes.studentId, passes.id], name: "pp_appointments_pass_student_school_fk" }),
  check("pp_appointments_status_check", sql`${table.status} IN ('scheduled','activated','completed','cancelled','missed')`),
  check("pp_appointments_bounds_check", sql`${table.revision}>0 AND ${table.duration} BETWEEN 1 AND 120 AND ${table.startsAt}<${table.endsAt} AND ${table.endsAt}<=${table.retainedUntil} AND char_length(${table.schoolTimezone}) BETWEEN 1 AND 128 AND ${table.createFingerprint} ~ '^[a-f0-9]{64}$' AND (${table.staffNotes} IS NULL OR char_length(${table.staffNotes})<=2000)`),
  check("pp_appointments_destination_check", sql`${table.destination} IN ('bathroom','nurse','office','counselor','other_classroom','custom') AND ((${table.destination}='custom' AND ${table.customDestination} IS NOT NULL AND char_length(${table.customDestination}) BETWEEN 1 AND 200) OR (${table.destination}<>'custom' AND ${table.customDestination} IS NULL))`),
]);

export type PasspilotAppointment = typeof passpilotAppointments.$inferSelect;
