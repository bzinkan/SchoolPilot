import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import { groups } from "./classpilot.js";
import { students } from "./students.js";

export type MyDeskTargetKind = "general" | "class" | "student";
export type MyDeskNoteStatus = "pending" | "active" | "deleted";
export type MyDeskAttachmentStatus = "pending" | "uploading" | "ready" | "delete_pending" | "deleted";
const identity = () => ({
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  schoolId: text("school_id").notNull().references(() => schools.id),
  authorId: varchar("author_id").notNull().references(() => users.id),
  clientRequestId: uuid("client_request_id").notNull(),
});
const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const mydeskNotes = pgTable("mydesk_notes", {
  ...identity(), ...timestamps(),
  requestFingerprint: text("request_fingerprint").notNull(),
  targetKind: text("target_kind").$type<MyDeskTargetKind>().notNull().default("general"),
  groupId: varchar("group_id"),
  filingGroupId: varchar("filing_group_id"),
  groupName: text("group_name"),
  studentId: varchar("student_id"),
  filingStudentId: varchar("filing_student_id"),
  studentName: text("student_name"),
  category: text("category").notNull().default("note"),
  title: text("title").notNull().default(""),
  body: text("body").notNull().default(""),
  entryDate: date("entry_date", { mode: "string" }).notNull(),
  pinned: boolean("pinned").notNull().default(false),
  status: text("status").$type<MyDeskNoteStatus>().notNull().default("pending"),
  revision: integer("revision").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, table => [
  uniqueIndex("mydesk_notes_school_id").on(table.schoolId, table.id),
  // Referenced by the attachment FK; a table constraint exists before Drizzle adds FKs.
  unique("mydesk_notes_owner_id").on(table.schoolId, table.authorId, table.id),
  uniqueIndex("mydesk_notes_request").on(table.schoolId, table.authorId, table.clientRequestId),
  // The ledger migration uses ON DELETE SET NULL (group_id)/(student_id).
  // Drizzle does not represent the column-list form; never db:push these FKs.
  foreignKey({ name: "mydesk_notes_group_fk", columns: [table.schoolId, table.groupId], foreignColumns: [groups.schoolId, groups.id] }),
  foreignKey({ name: "mydesk_notes_student_fk", columns: [table.schoolId, table.studentId], foreignColumns: [students.schoolId, students.id] }),
  check("mydesk_notes_target_kind", sql`${table.targetKind} IN ('general','class','student')`),
  check("mydesk_notes_status", sql`${table.status} IN ('pending','active','deleted')`),
  check("mydesk_notes_revision", sql`${table.revision} > 0`),
  check("mydesk_notes_category", sql`${table.category} ~ '^[a-z][a-z0-9_]{0,31}$'`),
  check("mydesk_notes_fingerprint", sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("mydesk_notes_target_shape", sql`(
    (${table.targetKind} = 'general' AND ${table.filingGroupId} IS NULL AND ${table.filingStudentId} IS NULL AND ${table.groupId} IS NULL AND ${table.studentId} IS NULL)
    OR (${table.targetKind} = 'class' AND ${table.filingGroupId} IS NOT NULL AND ${table.groupName} IS NOT NULL AND ${table.filingStudentId} IS NULL AND ${table.studentId} IS NULL)
    OR (${table.targetKind} = 'student' AND ${table.filingGroupId} IS NOT NULL AND ${table.groupName} IS NOT NULL AND ${table.filingStudentId} IS NOT NULL AND ${table.studentName} IS NOT NULL)
  )`),
  index("mydesk_notes_page").on(table.schoolId, table.authorId, table.pinned, table.entryDate.desc(), table.createdAt.desc(), table.id).where(sql`${table.status} = 'active'`),
  index("mydesk_notes_class_page").on(table.schoolId, table.authorId, table.filingGroupId, table.entryDate.desc(), table.id).where(sql`${table.status} = 'active'`),
  index("mydesk_notes_student_page").on(table.schoolId, table.authorId, table.filingStudentId, table.entryDate.desc(), table.id).where(sql`${table.status} = 'active'`),
  index("mydesk_notes_pending_expiry").on(table.expiresAt, table.id).where(sql`${table.status} = 'pending'`),
]);

export const mydeskAttachments = pgTable("mydesk_attachments", {
  ...identity(), ...timestamps(),
  noteId: varchar("note_id").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  storageKey: text("storage_key").notNull(),
  originalFilename: text("original_filename").notNull().default(""),
  contentType: text("content_type"),
  inputSha256: text("input_sha256"),
  sha256: text("sha256"),
  byteSize: integer("byte_size"),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  status: text("status").$type<MyDeskAttachmentStatus>().notNull().default("pending"),
  uploadLeaseId: uuid("upload_lease_id"),
  uploadLeaseUntil: timestamp("upload_lease_until", { withTimezone: true }),
  nextCleanupAt: timestamp("next_cleanup_at", { withTimezone: true }),
  cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
  lastErrorCode: text("last_error_code"),
}, table => [
  uniqueIndex("mydesk_attachments_school_id").on(table.schoolId, table.id),
  uniqueIndex("mydesk_attachments_request").on(table.schoolId, table.authorId, table.noteId, table.clientRequestId),
  uniqueIndex("mydesk_attachments_storage_key").on(table.storageKey),
  foreignKey({ name: "mydesk_attachments_owner_note_fk", columns: [table.schoolId, table.authorId, table.noteId], foreignColumns: [mydeskNotes.schoolId, mydeskNotes.authorId, mydeskNotes.id] }),
  check("mydesk_attachments_status", sql`${table.status} IN ('pending','uploading','ready','delete_pending','deleted')`),
  check("mydesk_attachments_size", sql`${table.byteSize} BETWEEN 1 AND 10485760`),
  check("mydesk_attachments_content_type", sql`${table.contentType} IN ('image/jpeg','image/png','image/webp','application/pdf')`),
  check("mydesk_attachments_input_hash", sql`${table.inputSha256} ~ '^[0-9a-f]{64}$'`),
  check("mydesk_attachments_hash", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  check("mydesk_attachments_fingerprint", sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
  check("mydesk_attachments_ready", sql`${table.status} <> 'ready' OR (${table.contentType} IS NOT NULL AND ${table.byteSize} IS NOT NULL AND ${table.sha256} IS NOT NULL AND ${table.inputSha256} IS NOT NULL)`),
  check("mydesk_attachments_attempts", sql`${table.cleanupAttempts} >= 0`),
  index("mydesk_attachments_note").on(table.schoolId, table.authorId, table.noteId, table.createdAt, table.id),
  index("mydesk_attachments_cleanup").on(table.nextCleanupAt, table.id).where(sql`${table.status} IN ('delete_pending','deleted')`),
  index("mydesk_attachments_upload_lease").on(table.uploadLeaseUntil, table.id).where(sql`${table.status} = 'uploading'`),
  index("mydesk_attachments_staged_expiry").on(table.createdAt, table.id).where(sql`${table.committedAt} IS NULL AND ${table.status} IN ('pending','uploading','ready')`),
]);

export type MyDeskNote = typeof mydeskNotes.$inferSelect;
export type NewMyDeskNote = typeof mydeskNotes.$inferInsert;
export type MyDeskAttachment = typeof mydeskAttachments.$inferSelect;
export type NewMyDeskAttachment = typeof mydeskAttachments.$inferInsert;
