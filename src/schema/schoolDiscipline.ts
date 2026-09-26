import { sql } from "drizzle-orm";
import { pgTable, varchar, text, integer, timestamp, jsonb, boolean, unique, uniqueIndex, index, foreignKey, check, uuid } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";

export type DisciplineSnapshot = { studentId: string; studentName: string; classId: string | null; className: string | null;
  category: string; title: string; body: string; entryDate: string; schemaVersion?: 2; gradeLevel?: string | null; schoolYear?: string | null;
  referralRecorded?: boolean; detentionAssigned?: boolean; detentionDates?: string[] };
export type DisciplineReceipt = { id: string; fingerprint: string; revision: number; recordId?: string; versionId?: string };
export const schoolDisciplineRecords = pgTable("school_discipline_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull().references(() => schools.id),
  submittedBy: varchar("submitted_by").notNull().references(() => users.id), submittedByName: text("submitted_by_name").notNull(),
  clientRequestId: uuid("client_request_id").notNull(), requestFingerprint: text("request_fingerprint").notNull(),
  sourceNoteId: varchar("source_note_id"), status: text("status").notNull().default("pending"),
  draftRevision: integer("draft_revision").notNull().default(1),
  draftReceipts: jsonb("draft_receipts").$type<DisciplineReceipt[]>().notNull().default([]),
  revision: integer("revision").notNull().default(0), currentVersionId: varchar("current_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique("school_discipline_records_school_id").on(t.schoolId, t.id),
  unique("school_discipline_records_request").on(t.schoolId, t.submittedBy, t.clientRequestId),
  check("school_discipline_records_status", sql`${t.status} IN ('pending','submitted','withdrawn','abandoned')`),
  check("school_discipline_records_revision", sql`${t.revision} >= 0`),
  check("school_discipline_records_draft", sql`${t.draftRevision}>0 AND jsonb_typeof(${t.draftReceipts})='array' AND jsonb_array_length(${t.draftReceipts})<=100`),
  index("school_discipline_records_owner_page").on(t.schoolId, t.submittedBy, t.createdAt.desc(), t.id),
  index("school_discipline_records_school_page").on(t.schoolId, t.createdAt.desc(), t.id),
]);
export const schoolDisciplineVersions = pgTable("school_discipline_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull(), recordId: varchar("record_id").notNull(),
  number: integer("number").notNull(), kind: text("kind").notNull(), state: text("state").notNull().default("preparing"),
  clientRequestId: uuid("client_request_id").notNull(), requestFingerprint: text("request_fingerprint").notNull(),
  reason: text("reason"), snapshot: jsonb("snapshot").$type<DisciplineSnapshot>().notNull(),
  createdBy: varchar("created_by"),
  sourceNoteId: varchar("source_note_id"), sourceNoteRevision: integer("source_note_revision"), sourceFingerprint: text("source_fingerprint"),
  leaseId: uuid("lease_id"), leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), publishedAt: timestamp("published_at", { withTimezone: true }),
}, t => [unique("school_discipline_versions_school_id").on(t.schoolId, t.id),
  unique("school_discipline_versions_request").on(t.schoolId, t.recordId, t.clientRequestId),
  foreignKey({ name: "school_discipline_versions_parent", columns: [t.schoolId, t.recordId], foreignColumns: [schoolDisciplineRecords.schoolId, schoolDisciplineRecords.id] }),
  check("school_discipline_versions_state", sql`${t.state} IN ('preparing','published','abandoned')`),
  check("school_discipline_versions_kind", sql`${t.kind} IN ('submission','correction','withdrawal')`),
  check("school_discipline_versions_number", sql`${t.number} > 0`),
  check("school_discipline_versions_snapshot", sql`jsonb_typeof(${t.snapshot})='object' AND octet_length(${t.snapshot}::text)<=20000`),
  index("school_discipline_versions_record").on(t.schoolId, t.recordId, t.number),
  uniqueIndex("school_discipline_versions_published_number").on(t.schoolId, t.recordId, t.number).where(sql`${t.state}='published'`),
]);
export const schoolDisciplineAttachments = pgTable("school_discipline_attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull(), versionId: varchar("version_id").notNull(),
  storageKey: text("storage_key").notNull(), sourceStorageKey: text("source_storage_key"), sourceAttachmentId: varchar("source_attachment_id"),
  filename: text("filename").notNull().default(""), contentType: text("content_type").notNull(), byteSize: integer("byte_size").notNull(), sha256: text("sha256").notNull(),
  status: text("status").notNull().default("pending"), leaseUntil: timestamp("lease_until", { withTimezone: true }),
  clientRequestId: uuid("client_request_id"), inputSha256: text("input_sha256"),
  inputContentType: text("input_content_type"), inputByteSize: integer("input_byte_size"), uploadLeaseId: uuid("upload_lease_id"),
  nextCleanupAt: timestamp("next_cleanup_at", { withTimezone: true }), cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
  lastErrorCode: text("last_error_code"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ name: "school_discipline_attachments_parent", columns: [t.schoolId, t.versionId], foreignColumns: [schoolDisciplineVersions.schoolId, schoolDisciplineVersions.id] }),
  unique("school_discipline_attachments_key").on(t.storageKey),
  check("school_discipline_attachments_status", sql`${t.status} IN ('pending','uploading','ready','committed','delete_pending','deleted')`),
  unique("school_discipline_attachments_request").on(t.schoolId, t.versionId, t.clientRequestId),
  check("school_discipline_attachments_size", sql`${t.byteSize} > 0 AND ${t.byteSize} <= 10485760`),
  check("school_discipline_attachments_hash", sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  index("school_discipline_attachments_version").on(t.schoolId, t.versionId),
  index("school_discipline_attachments_cleanup").on(t.status, t.nextCleanupAt),
]);
export const schoolDisciplineAccess = pgTable("school_discipline_access", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull().references(() => schools.id),
  userId: varchar("user_id").notNull().references(() => users.id), enabled: boolean("enabled").notNull().default(false),
  revision: integer("revision").notNull().default(0), updatedBy: varchar("updated_by"),
  mutationReceipts: jsonb("mutation_receipts").$type<DisciplineReceipt[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique("school_discipline_access_owner").on(t.schoolId, t.userId),
  check("school_discipline_access_revision", sql`${t.revision} >= 0`),
  check("school_discipline_access_receipts", sql`jsonb_typeof(${t.mutationReceipts})='array' AND jsonb_array_length(${t.mutationReceipts})<=100`),
]);
