import { sql } from "drizzle-orm";
import {
  pgTable,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { schools, users } from "./core.js";
import { students } from "./students.js";
import type {
  ContactProfile,
  ContactChange,
} from "../services/studentInformationValidation.js";

const times = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
const owner = () => ({
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  schoolId: text("school_id")
    .notNull()
    .references(() => schools.id),
  authorId: varchar("author_id")
    .notNull()
    .references(() => users.id),
});
export type InformationReceipt = {
  id: string;
  fingerprint: string;
  revision: number;
  kind: string;
};
export const studentContactProfiles = pgTable(
  "student_contact_profiles",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    schoolId: text("school_id")
      .notNull()
      .references(() => schools.id),
    studentId: varchar("student_id"),
    filingStudentId: varchar("filing_student_id").notNull(),
    studentName: text("student_name").notNull(),
    data: jsonb("data")
      .$type<ContactProfile>()
      .notNull()
      .default({ contacts: [] }),
    mutationReceipts: jsonb("mutation_receipts")
      .$type<InformationReceipt[]>()
      .notNull()
      .default([]),
    revision: integer("revision").notNull().default(0),
    updatedBy: varchar("updated_by")
      .notNull()
      .references(() => users.id),
    updatedByName: text("updated_by_name").notNull(),
    ...times(),
  },
  (t) => [
    unique("student_contact_profiles_school_id").on(t.schoolId, t.id),
    uniqueIndex("student_contact_profiles_student").on(
      t.schoolId,
      t.filingStudentId,
    ),
    foreignKey({
      name: "student_contact_profiles_student_fk",
      columns: [t.schoolId, t.studentId],
      foreignColumns: [students.schoolId, students.id],
    }),
    check(
      "student_contact_profiles_bounds",
      sql`${t.revision}>=0 AND char_length(${t.studentName})<=500 AND octet_length(${t.data}::text)<=65536 AND jsonb_typeof(${t.data})='object'`,
    ),
    check(
      "student_contact_profiles_json",
      sql`CASE WHEN jsonb_typeof(${t.data}->'contacts')='array' THEN jsonb_array_length(${t.data}->'contacts')<=20 ELSE false END AND CASE WHEN jsonb_typeof(${t.mutationReceipts})='array' THEN jsonb_array_length(${t.mutationReceipts})<=100 AND octet_length(${t.mutationReceipts}::text)<=32768 ELSE false END`,
    ),
  ],
);
export const studentContactProfileVersions = pgTable(
  "student_contact_profile_versions",
  {
    ...owner(),
    profileId: varchar("profile_id").notNull(),
    revision: integer("revision").notNull(),
    requestId: uuid("request_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    data: jsonb("data").$type<ContactProfile>().notNull(),
    changes: jsonb("changes").$type<ContactChange[]>().notNull(),
    reason: text("reason").notNull(),
    authorName: text("author_name").notNull(),
    importId: varchar("import_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "student_contact_versions_profile_fk",
      columns: [t.schoolId, t.profileId],
      foreignColumns: [
        studentContactProfiles.schoolId,
        studentContactProfiles.id,
      ],
    }),
    uniqueIndex("student_contact_versions_revision").on(
      t.schoolId,
      t.profileId,
      t.revision,
    ),
    uniqueIndex("student_contact_versions_request").on(
      t.schoolId,
      t.authorId,
      t.requestId,
    ),
    check(
      "student_contact_versions_bounds",
      sql`${t.revision}>0 AND ${t.requestFingerprint} ~ '^[0-9a-f]{64}$' AND char_length(${t.reason}) BETWEEN 1 AND 500 AND octet_length(${t.data}::text)<=65536 AND octet_length(${t.changes}::text)<=65536`,
    ),
  ],
);
export type InformationStatus =
  | "uploading"
  | "queued"
  | "processing"
  | "review"
  | "failed"
  | "completed"
  | "cancelled"
  | "expired";
export const studentInformationImports = pgTable(
  "student_information_imports",
  {
    ...owner(),
    ...times(),
    clientRequestId: uuid("client_request_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    expectedSourceCount: integer("expected_source_count").notNull(),
    status: text("status")
      .$type<InformationStatus>()
      .notNull()
      .default("uploading"),
    revision: integer("revision").notNull().default(1),
    selectedSectionIds: jsonb("selected_section_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    mutationReceipts: jsonb("mutation_receipts")
      .$type<InformationReceipt[]>()
      .notNull()
      .default([]),
    commitReceipt: jsonb("commit_receipt").$type<{
      requestId: string;
      fingerprint: string;
      profiles: Array<{ itemId: string; studentId: string; revision: number }>;
    }>(),
    quotaUsage: jsonb("quota_usage")
      .$type<Array<{ date: string; pages: number }>>()
      .notNull()
      .default([]),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version"),
    units: integer("units").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    leaseId: uuid("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    uploadExpiresAt: timestamp("upload_expires_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("student_information_imports_owner_id").on(
      t.schoolId,
      t.authorId,
      t.id,
    ),
    uniqueIndex("student_information_imports_request").on(
      t.schoolId,
      t.authorId,
      t.clientRequestId,
    ),
    index("student_information_imports_queue").on(t.status, t.nextAttemptAt),
    check(
      "student_information_imports_bounds",
      sql`${t.expectedSourceCount} BETWEEN 1 AND 5 AND ${t.revision}>0 AND ${t.units} BETWEEN 0 AND 20 AND ${t.attempts} BETWEEN 0 AND 3 AND ${t.status} IN ('uploading','queued','processing','review','failed','completed','cancelled','expired') AND ${t.requestFingerprint} ~ '^[0-9a-f]{64}$' AND ((${t.leaseId} IS NULL)=(${t.leaseUntil} IS NULL)) AND octet_length(${t.selectedSectionIds}::text)<=8192 AND octet_length(${t.mutationReceipts}::text)<=32768 AND octet_length(${t.quotaUsage}::text)<=4096 AND (${t.commitReceipt} IS NULL OR octet_length(${t.commitReceipt}::text)<=131072)`,
    ),
    check(
      "student_information_imports_json",
      sql`CASE WHEN jsonb_typeof(${t.selectedSectionIds})='array' THEN jsonb_array_length(${t.selectedSectionIds})<=100 ELSE false END AND CASE WHEN jsonb_typeof(${t.mutationReceipts})='array' THEN jsonb_array_length(${t.mutationReceipts})<=100 ELSE false END AND CASE WHEN jsonb_typeof(${t.quotaUsage})='array' THEN jsonb_array_length(${t.quotaUsage})<=8 ELSE false END AND (${t.modelVersion} IS NULL OR ${t.modelVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$') AND (${t.promptVersion} IS NULL OR ${t.promptVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$')`,
    ),
  ],
);
export const studentInformationImportAssets = pgTable(
  "student_information_import_assets",
  {
    ...owner(),
    ...times(),
    importId: varchar("import_id").notNull(),
    parentId: varchar("parent_id"),
    clientRequestId: uuid("client_request_id").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    kind: text("kind").$type<"source" | "section">().notNull(),
    status: text("status")
      .$type<"pending" | "uploading" | "ready" | "delete_pending" | "deleted">()
      .notNull()
      .default("pending"),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull().default(""),
    contentType: text("content_type").notNull(),
    inputSha256: text("input_sha256").notNull(),
    sha256: text("sha256"),
    byteSize: integer("byte_size").notNull(),
    label: text("label").notNull().default(""),
    ordinal: integer("ordinal").notNull().default(0),
    units: integer("units").notNull().default(0),
    hidden: boolean("hidden").notNull().default(false),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    stats: jsonb("stats")
      .$type<{
        pages: number;
        sheets: number;
        rows: number;
        columns: number;
        textBytes: number;
        sheetId?: string;
      }>()
      .notNull()
      .default({ pages: 0, sheets: 0, rows: 0, columns: 0, textBytes: 0 }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    leaseId: uuid("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextCleanupAt: timestamp("next_cleanup_at", { withTimezone: true }),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
  },
  (t) => [
    unique("student_information_assets_owner_id").on(
      t.schoolId,
      t.authorId,
      t.importId,
      t.id,
    ),
    foreignKey({
      name: "student_information_assets_import_fk",
      columns: [t.schoolId, t.authorId, t.importId],
      foreignColumns: [
        studentInformationImports.schoolId,
        studentInformationImports.authorId,
        studentInformationImports.id,
      ],
    }),
    foreignKey({
      name: "student_information_assets_parent_fk",
      columns: [t.schoolId, t.authorId, t.importId, t.parentId],
      foreignColumns: [t.schoolId, t.authorId, t.importId, t.id],
    }),
    uniqueIndex("student_information_assets_request").on(
      t.schoolId,
      t.authorId,
      t.importId,
      t.clientRequestId,
    ),
    uniqueIndex("student_information_assets_key").on(t.storageKey),
    index("student_information_assets_cleanup").on(t.status, t.nextCleanupAt),
    check(
      "student_information_assets_bounds",
      sql`${t.kind} IN ('source','section') AND ${t.status} IN ('pending','uploading','ready','delete_pending','deleted') AND ${t.byteSize} BETWEEN 1 AND 10485760 AND ${t.units} BETWEEN 0 AND 20 AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.inputSha256} ~ '^[a-f0-9]{64}$' AND (${t.sha256} IS NULL OR ${t.sha256} ~ '^[a-f0-9]{64}$') AND char_length(${t.filename})<=255 AND char_length(${t.label})<=200 AND octet_length(${t.warnings}::text)<=8192 AND ((${t.leaseId} IS NULL)=(${t.leaseUntil} IS NULL))`,
    ),
  ],
);
export const studentInformationImportItems = pgTable(
  "student_information_import_items",
  {
    ...owner(),
    ...times(),
    importId: varchar("import_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    revision: integer("revision").notNull().default(1),
    sourceSectionId: varchar("source_section_id").notNull(),
    studentName: text("student_name").notNull(),
    studentIdentifier: text("student_identifier"),
    studentId: varchar("student_id"),
    baseRevision: integer("base_revision").notNull().default(0),
    proposed: jsonb("proposed").$type<ContactProfile>().notNull(),
    changes: jsonb("changes").$type<ContactChange[]>().notNull().default([]),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    reviewed: boolean("reviewed").notNull().default(false),
    excluded: boolean("excluded").notNull().default(false),
    reviewFingerprint: text("review_fingerprint"),
  },
  (t) => [
    foreignKey({
      name: "student_information_items_import_fk",
      columns: [t.schoolId, t.authorId, t.importId],
      foreignColumns: [
        studentInformationImports.schoolId,
        studentInformationImports.authorId,
        studentInformationImports.id,
      ],
    }),
    foreignKey({
      name: "student_information_items_source_fk",
      columns: [t.schoolId, t.authorId, t.importId, t.sourceSectionId],
      foreignColumns: [
        studentInformationImportAssets.schoolId,
        studentInformationImportAssets.authorId,
        studentInformationImportAssets.importId,
        studentInformationImportAssets.id,
      ],
    }),
    index("student_information_items_import").on(
      t.schoolId,
      t.authorId,
      t.importId,
      t.ordinal,
    ),
    check(
      "student_information_items_bounds",
      sql`${t.ordinal} BETWEEN 0 AND 499 AND ${t.revision}>0 AND ${t.baseRevision}>=0 AND char_length(${t.studentName})<=200 AND octet_length(${t.proposed}::text)<=65536 AND octet_length(${t.changes}::text)<=65536 AND octet_length(${t.warnings}::text)<=8192`,
    ),
  ],
);
