import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, jsonb, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import { students } from "./students.js";
import { classpilotNativeInstallations } from "./classpilotNative.js";

const instant = (name: string) => timestamp(name, { withTimezone: true });
// A Windows owner is independent of the capture UI and of legacy Chromebook
// sessions. Each browser gets a different credential and exact transport identity.
export const classpilotWindowsGuards = pgTable("classpilot_windows_guards", {
  id: text("id").primaryKey(), schoolId: text("school_id").notNull().references(() => schools.id),
  installationId: text("installation_id").notNull(), studentId: text("student_id").notNull(),
  credentialHash: text("credential_hash").notNull(), osSessionNonce: text("os_session_nonce").notNull(),
  studentCredentialFingerprint: text("student_credential_fingerprint").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(), lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
  expiresAt: instant("expires_at").notNull(), absoluteExpiresAt: instant("absolute_expires_at").notNull(),
  endedAt: instant("ended_at"), endReason: text("end_reason"),
}, t => [unique("cp_windows_guard_school_id_unique").on(t.schoolId,t.id),unique("cp_windows_guard_school_id_student_unique").on(t.schoolId,t.id,t.studentId),
  foreignKey({name:"cp_windows_guard_installation_fk",columns:[t.schoolId,t.installationId],foreignColumns:[classpilotNativeInstallations.schoolId,classpilotNativeInstallations.id]}),
  foreignKey({name:"cp_windows_guard_student_fk",columns:[t.schoolId,t.studentId],foreignColumns:[students.schoolId,students.id]}),
  uniqueIndex("cp_windows_guard_active_student_unique").on(t.schoolId,t.studentId).where(sql`${t.endedAt} IS NULL`),
  uniqueIndex("cp_windows_guard_active_installation_unique").on(t.installationId).where(sql`${t.endedAt} IS NULL`),
  check("cp_windows_guard_hash_check",sql`${t.credentialHash} ~ '^[a-f0-9]{64}$' AND ${t.studentCredentialFingerprint} ~ '^[a-f0-9]{64}$'`),
  check("cp_windows_guard_expiry_check",sql`${t.expiresAt} <= ${t.absoluteExpiresAt} AND ${t.absoluteExpiresAt} > ${t.createdAt}`)]);

export const classpilotWindowsBrowsers = pgTable("classpilot_windows_browsers", {
  id:text("id").primaryKey(),schoolId:text("school_id").notNull().references(()=>schools.id),
  guardId:text("guard_id").notNull(), studentId:text("student_id").notNull(),
  browserFamily:text("browser_family").notNull(),profileId:text("profile_id").notNull(),
  credentialHash:text("credential_hash").notNull(),sourceRef:text("source_ref").notNull(),
  bindingRevision:integer("binding_revision").notNull().default(1),
  clientProtocolVersion:integer("client_protocol_version").notNull(),extensionVersion:text("extension_version").notNull(),
  acceptedCapabilities:jsonb("accepted_capabilities").$type<string[]>().notNull(),
  extensionCapabilities:jsonb("extension_capabilities").$type<string[]>().notNull().default([]),
  capabilityBlockedRevision:integer("capability_blocked_revision"),
  restrictionOverride:jsonb("restriction_override").$type<{controlRevision:number;screenLock:{active:boolean;url?:string|null}}>(),
  schoolPolicyAck:jsonb("school_policy_ack").$type<Record<string,unknown>>(),
  createdAt:instant("created_at").notNull().defaultNow(),lastSeenAt:instant("last_seen_at").notNull().defaultNow(),endedAt:instant("ended_at"),
},t=>[unique("cp_windows_browser_school_id_unique").on(t.schoolId,t.id),unique("cp_windows_browser_school_id_student_unique").on(t.schoolId,t.id,t.studentId),unique("cp_windows_browser_source_unique").on(t.sourceRef),
  foreignKey({name:"cp_windows_browser_guard_fk",columns:[t.schoolId,t.guardId,t.studentId],foreignColumns:[classpilotWindowsGuards.schoolId,classpilotWindowsGuards.id,classpilotWindowsGuards.studentId]}),
  foreignKey({name:"cp_windows_browser_student_fk",columns:[t.schoolId,t.studentId],foreignColumns:[students.schoolId,students.id]}),
  uniqueIndex("cp_windows_browser_active_family_unique").on(t.guardId,t.browserFamily).where(sql`${t.endedAt} IS NULL`),
  check("cp_windows_browser_family_check",sql`${t.browserFamily} IN ('chrome','edge')`),
  check("cp_windows_browser_hash_check",sql`${t.credentialHash} ~ '^[a-f0-9]{64}$'`),
  check("cp_windows_browser_revision_check",sql`${t.bindingRevision} > 0`)]);

export const classpilotWindowsPairingProofs = pgTable("classpilot_windows_pairing_proofs", {
  id:text("id").primaryKey(),schoolId:text("school_id").notNull().references(()=>schools.id),guardId:text("guard_id").notNull(),
  browserFamily:text("browser_family").notNull(),profileId:text("profile_id").notNull(),challenge:text("challenge").notNull(),
  tokenHash:text("token_hash").notNull(),createdAt:instant("created_at").notNull().defaultNow(),expiresAt:instant("expires_at").notNull(),consumedAt:instant("consumed_at"),
},t=>[foreignKey({name:"cp_windows_proof_guard_fk",columns:[t.schoolId,t.guardId],foreignColumns:[classpilotWindowsGuards.schoolId,classpilotWindowsGuards.id]}),
  check("cp_windows_proof_family_check",sql`${t.browserFamily} IN ('chrome','edge')`),
  check("cp_windows_proof_hash_check",sql`${t.tokenHash} ~ '^[a-f0-9]{64}$'`),
  check("cp_windows_proof_expiry_check",sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '60 seconds'`)]);

export const classpilotWindowsCommands = pgTable("classpilot_windows_commands", {
  id:text("id").primaryKey(),schoolId:text("school_id").notNull().references(()=>schools.id),actorId:text("actor_id").notNull(),
  teachingSessionId:text("teaching_session_id"),supervisionContextId:text("supervision_context_id"),contextAuthorityRevision:text("context_authority_revision"),
  commandType:text("command_type").notNull(),payload:jsonb("payload").$type<Record<string,unknown>>().notNull(),
  createdAt:instant("created_at").notNull().defaultNow(),expiresAt:instant("expires_at").notNull(),
},t=>[unique("cp_windows_command_school_id_unique").on(t.schoolId,t.id),
  check("cp_windows_command_context_check",sql`num_nonnulls(${t.teachingSessionId},${t.supervisionContextId})=1`)]);

export const classpilotWindowsCommandTargets = pgTable("classpilot_windows_command_targets", {
  id:text("id").primaryKey(),schoolId:text("school_id").notNull().references(()=>schools.id),commandId:text("command_id").notNull(),
  browserId:text("browser_id").notNull(),studentId:text("student_id").notNull(),sourceRef:text("source_ref").notNull(),
  bindingRevision:integer("binding_revision").notNull(),controlRevision:integer("control_revision").notNull(),
  status:text("status").notNull().default("pending"),result:jsonb("result").$type<Record<string,unknown>>(),
  deliveredAt:instant("delivered_at"),ackedAt:instant("acked_at"),
},t=>[foreignKey({name:"cp_windows_target_command_fk",columns:[t.schoolId,t.commandId],foreignColumns:[classpilotWindowsCommands.schoolId,classpilotWindowsCommands.id]}),
  foreignKey({name:"cp_windows_target_browser_fk",columns:[t.schoolId,t.browserId,t.studentId],foreignColumns:[classpilotWindowsBrowsers.schoolId,classpilotWindowsBrowsers.id,classpilotWindowsBrowsers.studentId]}),
  foreignKey({name:"cp_windows_target_student_fk",columns:[t.schoolId,t.studentId],foreignColumns:[students.schoolId,students.id]}),
  unique("cp_windows_target_command_browser_unique").on(t.commandId,t.browserId),
  check("cp_windows_target_status_check",sql`${t.status} IN ('pending','delivered','succeeded','failed','expired','stale')`)]);

export type WindowsGuard = typeof classpilotWindowsGuards.$inferSelect;
export type WindowsBrowser = typeof classpilotWindowsBrowsers.$inferSelect;
