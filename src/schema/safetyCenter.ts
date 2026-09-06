import { sql } from "drizzle-orm";
import { pgTable, varchar, text, integer, timestamp, jsonb, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { schools } from "./core.js";
import { students } from "./students.js";
import { studentSafetyCases } from "./shared.js";

const id = () => varchar("id").primaryKey().default(sql`gen_random_uuid()`);
export const studentSafetyAlerts = pgTable("student_safety_alerts", {
 id:id(),schoolId:text("school_id").notNull(),studentId:text("student_id").notNull(),caseId:text("case_id").notNull(),
 fingerprint:text("fingerprint").notNull(),urlFingerprint:text("url_fingerprint"),urlCiphertext:text("url_ciphertext"),
 sourceType:text("source_type").notNull(),sourceId:text("source_id").notNull(),concern:text("concern").notNull(),severity:text("severity").notNull(),
 classificationSource:text("classification_source"),matchedTerm:text("matched_term"),reason:text("reason"),rulesetVersion:text("ruleset_version"),
 modelVersion:text("model_version"),confidence:integer("confidence"),decisionId:text("decision_id"),heartbeatId:text("heartbeat_id"),teachingSessionId:text("teaching_session_id"),
 firstSeenAt:timestamp("first_seen_at",{withTimezone:true}).notNull(),lastSeenAt:timestamp("last_seen_at",{withTimezone:true}).notNull(),
 observationCount:integer("observation_count").notNull().default(1),revision:integer("revision").notNull().default(0),
 acknowledgedAt:timestamp("acknowledged_at",{withTimezone:true}),acknowledgedBy:text("acknowledged_by"),
 reviewedAt:timestamp("reviewed_at",{withTimezone:true}),reviewedBy:text("reviewed_by"),reviewNote:text("review_note"),
}, table=>[
 unique("safety_alert_school_id_unique").on(table.schoolId,table.id),
 unique("safety_alert_case_id_unique").on(table.schoolId,table.caseId,table.id),
 unique("safety_alert_observation_unique").on(table.schoolId,table.caseId,table.fingerprint),
 foreignKey({name:"safety_alert_case_parent",columns:[table.schoolId,table.caseId,table.studentId],foreignColumns:[studentSafetyCases.schoolId,studentSafetyCases.id,studentSafetyCases.studentId]}).onDelete("cascade"),
 foreignKey({name:"safety_alert_student_parent",columns:[table.schoolId,table.studentId],foreignColumns:[students.schoolId,students.id]}).onDelete("cascade"),
 index("safety_alert_review_idx").on(table.schoolId,table.reviewedAt,table.lastSeenAt,table.id),
]);
export const studentSafetyCaseEvents = pgTable("student_safety_case_events",{
 id:id(),schoolId:text("school_id").notNull(),caseId:text("case_id").notNull(),alertId:text("alert_id"),actorId:text("actor_id"),
 kind:text("kind").notNull(),note:text("note"),metadata:jsonb("metadata").notNull().default({}),createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},table=>[
 foreignKey({name:"safety_case_event_parent",columns:[table.schoolId,table.caseId],foreignColumns:[studentSafetyCases.schoolId,studentSafetyCases.id]}).onDelete("cascade"),
 foreignKey({name:"safety_case_event_alert_parent",columns:[table.schoolId,table.caseId,table.alertId],foreignColumns:[studentSafetyAlerts.schoolId,studentSafetyAlerts.caseId,studentSafetyAlerts.id]}).onDelete("cascade"),
 index("safety_case_events_case_idx").on(table.schoolId,table.caseId,table.createdAt,table.id),
]);
export const safetyUrlExceptions = pgTable("safety_url_exceptions",{
 id:id(),schoolId:text("school_id").notNull(),fingerprint:text("fingerprint").notNull(),canonicalizerVersion:integer("canonicalizer_version").notNull().default(1),
 urlCiphertext:text("url_ciphertext").notNull(),createdFromAlertId:text("created_from_alert_id"),createdBy:text("created_by").notNull(),
 createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),revokedAt:timestamp("revoked_at",{withTimezone:true}),revokedBy:text("revoked_by"),
},table=>[
 foreignKey({name:"safety_url_exception_alert_parent",columns:[table.schoolId,table.createdFromAlertId],foreignColumns:[studentSafetyAlerts.schoolId,studentSafetyAlerts.id]}),
 foreignKey({name:"safety_url_exception_school_parent",columns:[table.schoolId],foreignColumns:[schools.id]}).onDelete("cascade"),
 uniqueIndex("safety_active_url_exception_idx").on(table.schoolId,table.fingerprint).where(sql`${table.revokedAt} IS NULL`),
]);
export const safetyNotificationOutbox = pgTable("safety_notification_outbox",{
 id:id(),schoolId:text("school_id").notNull(),caseId:text("case_id").notNull(),alertId:text("alert_id").notNull(),recipient:text("recipient").notNull(),
 kind:text("kind").notNull(),alertRevision:integer("alert_revision").notNull(),dueAt:timestamp("due_at",{withTimezone:true}).notNull(),
 status:text("status").notNull().default("pending"),attempts:integer("attempts").notNull().default(0),claimedAt:timestamp("claimed_at",{withTimezone:true}),
 submissionStartedAt:timestamp("submission_started_at",{withTimezone:true}),
 completedAt:timestamp("completed_at",{withTimezone:true}),providerMessageId:text("provider_message_id"),errorCode:text("error_code"),
},table=>[
 unique("safety_outbox_alert_recipient_kind_unique").on(table.schoolId,table.alertId,table.recipient,table.kind),
 foreignKey({name:"safety_outbox_case_alert_parent",columns:[table.schoolId,table.caseId,table.alertId],foreignColumns:[studentSafetyAlerts.schoolId,studentSafetyAlerts.caseId,studentSafetyAlerts.id]}).onDelete("cascade"),
 check("safety_outbox_kind_check",sql`${table.kind} IN ('initial','followup')`),
 check("safety_outbox_status_check",sql`${table.status} IN ('pending','sending','sent','cancelled','failed','unknown')`),
 index("safety_notification_due_idx").on(table.status,table.dueAt),
]);
