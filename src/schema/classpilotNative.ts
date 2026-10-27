import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import { students } from "./students.js";

// Native identities deliberately do not participate in browser device/session tables.
export const classpilotNativeEnrollmentTokens = pgTable("classpilot_native_enrollment_tokens", {
  id: text("id").primaryKey(),
  schoolId: text("school_id").notNull().references(() => schools.id),
  tokenHash: text("token_hash").notNull(),
  issuedBy: text("issued_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, table => [unique("cp_native_enrollment_school_id_unique").on(table.schoolId, table.id),
  check("cp_native_enrollment_hash_check", sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`)]);

export const classpilotNativeInstallations = pgTable("classpilot_native_installations", {
  id: text("id").primaryKey(),
  schoolId: text("school_id").notNull().references(() => schools.id),
  credentialHash: text("credential_hash").notNull(),
  enrollmentTokenId: text("enrollment_token_id").notNull(),
  clientVersion: text("client_version").notNull(),
  platform: text("platform").notNull().default("windows"),
  bindingRevision: integer("binding_revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, table => [unique("cp_native_installation_school_id_unique").on(table.schoolId, table.id),
  unique("cp_native_installation_enrollment_unique").on(table.enrollmentTokenId),
  foreignKey({ name: "cp_native_installation_enrollment_fk", columns: [table.schoolId, table.enrollmentTokenId],
    foreignColumns: [classpilotNativeEnrollmentTokens.schoolId, classpilotNativeEnrollmentTokens.id] }),
  check("cp_native_installation_hash_check", sql`${table.credentialHash} ~ '^[a-f0-9]{64}$'`),
  check("cp_native_installation_revision_check", sql`${table.bindingRevision} >= 0`),
  check("cp_native_installation_platform_check", sql`${table.platform} = 'windows'`)]);

export const classpilotNativeSessions = pgTable("classpilot_native_sessions", {
  id: text("id").primaryKey(),
  schoolId: text("school_id").notNull().references(() => schools.id),
  installationId: text("installation_id").notNull(),
  studentId: text("student_id").notNull(),
  credentialHash: text("credential_hash").notNull(),
  osSessionNonce: text("os_session_nonce").notNull(),
  studentCredentialFingerprint: text("student_credential_fingerprint").notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  sourceRef: text("source_ref").notNull(),
  sourceGeneration: text("source_generation"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
}, table => [unique("cp_native_session_school_id_unique").on(table.schoolId, table.id),
  unique("cp_native_session_source_ref_unique").on(table.sourceRef),
  foreignKey({ name: "cp_native_session_installation_fk", columns: [table.schoolId, table.installationId],
    foreignColumns: [classpilotNativeInstallations.schoolId, classpilotNativeInstallations.id] }),
  foreignKey({ name: "cp_native_session_student_fk", columns: [table.schoolId, table.studentId],
    foreignColumns: [students.schoolId, students.id] }),
  uniqueIndex("cp_native_session_active_installation_unique").on(table.installationId).where(sql`${table.endedAt} IS NULL`),
  uniqueIndex("cp_native_session_active_student_unique").on(table.schoolId, table.studentId).where(sql`${table.endedAt} IS NULL`),
  check("cp_native_session_hash_check", sql`${table.credentialHash} ~ '^[a-f0-9]{64}$'`),
  check("cp_native_session_student_fingerprint_check", sql`${table.studentCredentialFingerprint} ~ '^[a-f0-9]{64}$'`),
  check("cp_native_session_revision_check", sql`${table.bindingRevision} > 0`),
  check("cp_native_session_expiry_check", sql`${table.expiresAt} <= ${table.absoluteExpiresAt} AND ${table.absoluteExpiresAt} > ${table.createdAt}`)]);

export type ClasspilotNativeSession = typeof classpilotNativeSessions.$inferSelect;
