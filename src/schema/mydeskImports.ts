import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import type { MyDeskPreferencesSnapshot } from "./mydeskPreferences.js";

export type ImportRegion = { assetId: string; x: number; y: number; width: number; height: number; rotation: 0 | 90 | 180 | 270 };
export type ImportReceipt = { id: string; fingerprint: string; kind: string; revision: number };
export type ImportCommitReceipt = { requestId: string; fingerprint: string; notes: Array<{ itemId: string; noteId: string }> };
export type ImportQuotaUsage = { date: string; pages: number };
export type ImportStatus = "uploading" | "queued" | "processing" | "review" | "failed" | "completed" | "cancelled" | "expired";
export type ImportAssetStatus = "pending" | "uploading" | "ready" | "promoted" | "delete_pending" | "deleted";
const owner = () => ({ id: varchar("id").primaryKey().default(sql`gen_random_uuid()`), schoolId: text("school_id").notNull().references(() => schools.id), authorId: varchar("author_id").notNull().references(() => users.id) });
const times = () => ({ createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), deletedAt: timestamp("deleted_at", { withTimezone: true }) });
export const mydeskImports = pgTable("mydesk_imports", {
  ...owner(), ...times(), clientRequestId: uuid("client_request_id").notNull(), requestFingerprint: text("request_fingerprint").notNull(),
  status: text("status").$type<ImportStatus>().notNull().default("uploading"), revision: integer("revision").notNull().default(1),
  expectedSourceCount: integer("expected_source_count").notNull(),
  selectedGroupIds: jsonb("selected_group_ids").$type<string[]>().notNull().default([]),
  preferencesSnapshot: jsonb("preferences_snapshot").$type<MyDeskPreferencesSnapshot>().notNull().default({ revision: 0, preferredClasses: {} }),
  sourceNoteId: varchar("source_note_id"), sourceAttachmentId: varchar("source_attachment_id"),
  pageDecisions: jsonb("page_decisions").$type<Array<{ assetId: string; excluded: boolean }>>().notNull().default([]),
  mutationReceipts: jsonb("mutation_receipts").$type<ImportReceipt[]>().notNull().default([]), commitReceipt: jsonb("commit_receipt").$type<ImportCommitReceipt>(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }).notNull(),
  leaseId: uuid("lease_id"), leaseUntil: timestamp("lease_until", { withTimezone: true }), nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0), pageCount: integer("page_count").notNull().default(0), quotaDate: date("quota_date", { mode: "string" }), lastErrorCode: text("last_error_code"),
  quotaUsage: jsonb("quota_usage").$type<ImportQuotaUsage[]>().notNull().default([]), modelVersion: text("model_version"), promptVersion: text("prompt_version"),
}, t => [unique("mydesk_imports_owner_id").on(t.schoolId,t.authorId,t.id), uniqueIndex("mydesk_imports_request").on(t.schoolId,t.authorId,t.clientRequestId),
  index("mydesk_imports_queue").on(t.status,t.nextAttemptAt,t.leaseUntil), index("mydesk_imports_owner").on(t.schoolId,t.authorId,t.createdAt), index("mydesk_imports_quota").on(t.schoolId,t.quotaDate),
  check("mydesk_imports_state", sql`${t.status} IN ('uploading','queued','processing','review','failed','completed','cancelled','expired')`),
  check("mydesk_imports_workspace_snapshot", sql`jsonb_typeof(${t.preferencesSnapshot})='object' AND octet_length(${t.preferencesSnapshot}::text)<=12288 AND ((${t.sourceNoteId} IS NULL)=(${t.sourceAttachmentId} IS NULL)) AND (${t.sourceNoteId} IS NULL OR char_length(${t.sourceNoteId}) BETWEEN 1 AND 128) AND (${t.sourceAttachmentId} IS NULL OR char_length(${t.sourceAttachmentId}) BETWEEN 1 AND 128)`),
  check("mydesk_imports_bounds", sql`${t.revision}>0 AND ${t.expectedSourceCount} BETWEEN 1 AND 5 AND ${t.attempts}>=0 AND ${t.pageCount} BETWEEN 0 AND 20 AND ${t.requestFingerprint} ~ '^[0-9a-f]{64}$' AND (${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[A-Za-z0-9_]{1,64}$') AND ((${t.leaseId} IS NULL)=(${t.leaseUntil} IS NULL))`),
  check("mydesk_imports_provenance", sql`(${t.modelVersion} IS NULL OR ${t.modelVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$') AND (${t.promptVersion} IS NULL OR ${t.promptVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$')`),
  check("mydesk_imports_json", sql`
    CASE WHEN jsonb_typeof(${t.selectedGroupIds})='array' THEN jsonb_array_length(${t.selectedGroupIds})<=20 AND octet_length(${t.selectedGroupIds}::text)<=8192 ELSE false END
    AND CASE WHEN jsonb_typeof(${t.pageDecisions})='array' THEN jsonb_array_length(${t.pageDecisions})<=20 AND octet_length(${t.pageDecisions}::text)<=8192 ELSE false END
    AND CASE WHEN jsonb_typeof(${t.mutationReceipts})='array' THEN jsonb_array_length(${t.mutationReceipts})<=100 AND octet_length(${t.mutationReceipts}::text)<=32768 ELSE false END
    AND CASE WHEN jsonb_typeof(${t.quotaUsage})='array' THEN jsonb_array_length(${t.quotaUsage})<=8 AND octet_length(${t.quotaUsage}::text)<=4096 ELSE false END
    AND (${t.commitReceipt} IS NULL OR (jsonb_typeof(${t.commitReceipt})='object' AND octet_length(${t.commitReceipt}::text)<=16384))`),
]);
export const mydeskImportItems = pgTable("mydesk_import_items", {
  ...owner(), ...times(), importId: varchar("import_id").notNull(), clientRequestId: uuid("client_request_id").notNull(), ordinal: integer("ordinal").notNull(), revision: integer("revision").notNull().default(1),
  regions: jsonb("regions").$type<ImportRegion[]>().notNull().default([]), subjectNames: jsonb("subject_names").$type<string[]>().notNull().default([]),
  groupId: varchar("group_id"), studentId: varchar("student_id"), rosterRevision: text("roster_revision"), category: text("category").notNull().default("note"), title: text("title").notNull().default(""), body: text("body").notNull().default(""), entryDate: date("entry_date",{mode:"string"}),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]), reviewed: boolean("reviewed").notNull().default(false), excluded: boolean("excluded").notNull().default(false), reviewFingerprint: text("review_fingerprint"),
  approvedAssetId: varchar("approved_asset_id"), extractionStatus: text("extraction_status").$type<"pending"|"ready"|"failed">().notNull().default("pending"), extractRequested: boolean("extract_requested").notNull().default(true), noteId: varchar("note_id"),
},t=>[unique("mydesk_import_items_owner_id").on(t.schoolId,t.authorId,t.importId,t.id), uniqueIndex("mydesk_import_items_request").on(t.schoolId,t.authorId,t.importId,t.clientRequestId),
  foreignKey({name:"mydesk_import_items_run_fk",columns:[t.schoolId,t.authorId,t.importId],foreignColumns:[mydeskImports.schoolId,mydeskImports.authorId,mydeskImports.id]}),
  foreignKey({name:"mydesk_import_items_approved_fk",columns:[t.schoolId,t.authorId,t.importId,t.approvedAssetId],foreignColumns:[mydeskImportAssets.schoolId,mydeskImportAssets.authorId,mydeskImportAssets.importId,mydeskImportAssets.id]}),
  index("mydesk_import_items_run").on(t.schoolId,t.authorId,t.importId,t.ordinal),
  check("mydesk_import_items_bounds", sql`
    ${t.ordinal} BETWEEN 0 AND 49 AND ${t.revision}>0 AND char_length(${t.title})<=160 AND char_length(${t.body})<=5000
    AND ${t.category} IN ('note','detention','referral','uniform','positive','parent_contact','other')
    AND (${t.groupId} IS NULL OR char_length(${t.groupId}) BETWEEN 1 AND 128)
    AND (${t.studentId} IS NULL OR char_length(${t.studentId}) BETWEEN 1 AND 128)
    AND (${t.rosterRevision} IS NULL OR ${t.rosterRevision} ~ '^[0-9a-f]{64}$')
    AND (${t.reviewFingerprint} IS NULL OR ${t.reviewFingerprint} ~ '^[0-9a-f]{64}$')
    AND ${t.extractionStatus} IN ('pending','ready','failed')`),
  check("mydesk_import_items_json", sql`
    CASE WHEN jsonb_typeof(${t.regions})='array' THEN jsonb_array_length(${t.regions})<=20 AND octet_length(${t.regions}::text)<=65536 ELSE false END
    AND CASE WHEN jsonb_typeof(${t.subjectNames})='array' THEN jsonb_array_length(${t.subjectNames})<=20 AND octet_length(${t.subjectNames}::text)<=16384 ELSE false END
    AND CASE WHEN jsonb_typeof(${t.warnings})='array' THEN jsonb_array_length(${t.warnings})<=20 AND octet_length(${t.warnings}::text)<=16384 ELSE false END`),
]);
export const mydeskImportAssets = pgTable("mydesk_import_assets", {
  ...owner(), ...times(), importId: varchar("import_id").notNull(), kind: text("kind").$type<"source"|"page"|"approved">().notNull(), parentAssetId: varchar("parent_asset_id"), pageNumber: integer("page_number"),
  clientRequestId: uuid("client_request_id").notNull(), requestFingerprint: text("request_fingerprint").notNull(), storageKey: text("storage_key").notNull(), originalFilename: text("original_filename").notNull().default(""), contentType: text("content_type"), inputSha256: text("input_sha256"), sha256: text("sha256"), byteSize: integer("byte_size"), width: integer("width"), height: integer("height"), pageCount: integer("page_count"),
  status: text("status").$type<ImportAssetStatus>().notNull().default("pending"), leaseId: uuid("lease_id"), leaseUntil: timestamp("lease_until",{withTimezone:true}), nextCleanupAt: timestamp("next_cleanup_at",{withTimezone:true}), cleanupAttempts: integer("cleanup_attempts").notNull().default(0), lastErrorCode: text("last_error_code"), attachmentId: varchar("attachment_id"), processedAt: timestamp("processed_at",{withTimezone:true}),
},t=>[unique("mydesk_import_assets_owner_id").on(t.schoolId,t.authorId,t.importId,t.id), uniqueIndex("mydesk_import_assets_request").on(t.schoolId,t.authorId,t.importId,t.clientRequestId),uniqueIndex("mydesk_import_assets_key").on(t.storageKey),
  foreignKey({name:"mydesk_import_assets_run_fk",columns:[t.schoolId,t.authorId,t.importId],foreignColumns:[mydeskImports.schoolId,mydeskImports.authorId,mydeskImports.id]}),
  foreignKey({name:"mydesk_import_assets_parent_fk",columns:[t.schoolId,t.authorId,t.importId,t.parentAssetId],foreignColumns:[t.schoolId,t.authorId,t.importId,t.id]}),
  index("mydesk_import_assets_cleanup").on(t.status,t.nextCleanupAt),index("mydesk_import_assets_run").on(t.schoolId,t.authorId,t.importId),
  check("mydesk_import_assets_state", sql`${t.kind} IN ('source','page','approved') AND ${t.status} IN ('pending','uploading','ready','promoted','delete_pending','deleted')`),
  check("mydesk_import_assets_bounds", sql`
    ${t.requestFingerprint} ~ '^[0-9a-f]{64}$' AND char_length(${t.originalFilename})<=255
    AND (${t.inputSha256} IS NULL OR ${t.inputSha256} ~ '^[0-9a-f]{64}$') AND (${t.sha256} IS NULL OR ${t.sha256} ~ '^[0-9a-f]{64}$')
    AND (${t.byteSize} IS NULL OR ${t.byteSize} BETWEEN 1 AND 10485760)
    AND (${t.contentType} IS NULL OR ${t.contentType} IN ('image/jpeg','image/png','image/webp','application/pdf'))
    AND (${t.width} IS NULL OR ${t.width} BETWEEN 1 AND 4096) AND (${t.height} IS NULL OR ${t.height} BETWEEN 1 AND 4096)
    AND (${t.pageNumber} IS NULL OR ${t.pageNumber} BETWEEN 1 AND 20) AND (${t.pageCount} IS NULL OR ${t.pageCount} BETWEEN 1 AND 20)
    AND ${t.cleanupAttempts}>=0 AND (${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[A-Za-z0-9_]{1,64}$')
    AND ((${t.leaseId} IS NULL)=(${t.leaseUntil} IS NULL))
    AND (${t.status} NOT IN ('ready','promoted') OR (${t.contentType} IS NOT NULL AND ${t.byteSize} IS NOT NULL AND ${t.sha256} IS NOT NULL))
    AND (${t.status}<>'promoted' OR (${t.kind}='approved' AND ${t.attachmentId} IS NOT NULL AND ${t.leaseId} IS NULL))`),
]);
export type MyDeskImport = typeof mydeskImports.$inferSelect;
export type MyDeskImportItem = typeof mydeskImportItems.$inferSelect;
export type MyDeskImportAsset = typeof mydeskImportAssets.$inferSelect;
