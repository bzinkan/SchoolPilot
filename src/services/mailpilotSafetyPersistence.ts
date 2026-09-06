import { and, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { emailAlerts, mailpilotWatches, type InsertEmailAlert, type MailpilotWatch } from "../schema/mailpilot.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { recordSafetyAlert } from "./safetyCenter.js";
import { mailpilotHistoryCovered, mailpilotRetryError, mailpilotSafetySourceId, validMailpilotHistoryId, type MailpilotMessageIdentity } from "./mailpilotNotification.js";

type Database=typeof db;
type Transaction=Parameters<Parameters<Database["transaction"]>[0]>[0];
type Result={created:boolean;caseId:string|null;alertId:string|null};

/** Canonical school/license locks precede the source and student/case locks. */
async function assertMailpilotPersistenceAuthority(tx:Transaction,identity:Pick<MailpilotMessageIdentity,"schoolId"|"studentId"|"studentEmail">) {
  await assertClasspilotEntitled(identity.schoolId,tx as unknown as Database,{lock:true});
  const enabled=await tx.execute(sql`SELECT id FROM schools WHERE id=${identity.schoolId}
    AND mailpilot_entitled=true AND classpilot_email_monitoring=true`);
  if(!enabled.rows.length) throw mailpilotRetryError("MAILPILOT_MONITORING_DISABLED");
  const student=await tx.execute(sql`SELECT id FROM students WHERE school_id=${identity.schoolId} AND id=${identity.studentId}
    AND status='active' AND email_lc=${identity.studentEmail.toLowerCase()} FOR SHARE`);
  if(!student.rows.length) throw mailpilotRetryError("MAILPILOT_STUDENT_CHANGED");
}

/**
 * No payload means replay/legacy repair only; null means Gmail classification is still needed.
 * The source lock and all inserts share the outer transaction, including Safety Center's savepoint.
 */
export async function persistMailpilotSafetyAlert(identity:MailpilotMessageIdentity, payload?:InsertEmailAlert, database:Database|Transaction=db):Promise<Result|null> {
  if(payload&&(payload.schoolId!==identity.schoolId||payload.studentId!==identity.studentId||payload.gmailMessageId!==identity.gmailMessageId||payload.studentEmail.toLowerCase()!==identity.studentEmail.toLowerCase())) {
    throw mailpilotRetryError("MAILPILOT_SOURCE_MISMATCH");
  }
  const sourceId=mailpilotSafetySourceId(identity);
  return database.transaction(async tx=>{
    await assertMailpilotPersistenceAuthority(tx,identity);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mailpilot-source:${sourceId}`},0))`);
    const [retained]=await tx.select().from(emailAlerts).where(and(eq(emailAlerts.schoolId,identity.schoolId),eq(emailAlerts.studentId,identity.studentId),eq(emailAlerts.gmailMessageId,identity.gmailMessageId))).limit(1);
    // Search all cases, including closed/merged/reviewed cases. Replayed mail is
    // one observation, never a new incident and never a reminder-count increment.
    const prior=await tx.execute<{id:string;case_id:string}>(sql`SELECT id,case_id FROM student_safety_alerts
      WHERE school_id=${identity.schoolId} AND student_id=${identity.studentId} AND source_type='mailpilot'
      AND (source_id=${sourceId} ${retained?sql`OR source_id=${retained.id}`:sql``}) LIMIT 1`);
    if(prior.rows[0]) return {created:false,caseId:prior.rows[0].case_id,alertId:prior.rows[0].id};
    if(retained?.reviewedAt||retained?.reviewStatus) return {created:false,caseId:null,alertId:null};
    if(!retained&&!payload) return null;
    const [inserted]=retained?[]:await tx.insert(emailAlerts).values({...payload!,safetySourceId:sourceId}).returning();
    const alert=retained??inserted;
    if(!alert) throw mailpilotRetryError("MAILPILOT_ALERT_NOT_PERSISTED");
    const concern=alert.safetyAlert||(alert.bullying==="true"?"bullying":null);
    if(!concern) throw mailpilotRetryError("MAILPILOT_ALERT_CONCERN_MISSING");
    const shared=await recordSafetyAlert({
      schoolId:identity.schoolId,studentId:identity.studentId,sourceType:"mailpilot",sourceId,
      safetyAlert:concern,severity:alert.severity,classificationSource:"mailpilot",reason:alert.reasoning,
      confidence:alert.confidence,occurredAt:alert.messageDate??alert.alertedAt,
    },tx as unknown as Database);
    if(retained) await tx.update(emailAlerts).set({safetySourceId:sourceId}).where(and(eq(emailAlerts.id,retained.id),eq(emailAlerts.schoolId,identity.schoolId)));
    return {created:shared.created,caseId:shared.caseId,alertId:shared.alertId};
  });
}

/** Compare-and-swap prevents an older notification from replacing a newer completed cursor. */
export async function completeMailpilotHistoryCursor(watch:MailpilotWatch,newHistoryId:string,database:Database=db):Promise<void> {
  if(!validMailpilotHistoryId(newHistoryId)||!validMailpilotHistoryId(watch.historyId)||BigInt(newHistoryId)<BigInt(watch.historyId)) throw mailpilotRetryError("MAILPILOT_HISTORY_INVALID");
  await database.transaction(async tx=>{
    await assertMailpilotPersistenceAuthority(tx,{schoolId:watch.schoolId,studentId:watch.studentId,studentEmail:watch.studentEmail});
    const [current]=await tx.select().from(mailpilotWatches).where(and(eq(mailpilotWatches.id,watch.id),eq(mailpilotWatches.schoolId,watch.schoolId),eq(mailpilotWatches.studentId,watch.studentId),eq(mailpilotWatches.studentEmail,watch.studentEmail))).for("update");
    if(!current||current.status!=="active") throw mailpilotRetryError("MAILPILOT_WATCH_CHANGED");
    if(current.historyId!==watch.historyId) {
      if(mailpilotHistoryCovered(current.historyId,newHistoryId)) return;
      throw mailpilotRetryError("MAILPILOT_CURSOR_CHANGED");
    }
    await tx.update(mailpilotWatches).set({historyId:newHistoryId,lastPollAt:new Date(),lastError:null}).where(and(eq(mailpilotWatches.id,watch.id),eq(mailpilotWatches.schoolId,watch.schoolId)));
  });
}

export async function noteMailpilotProcessingFailure(watch:MailpilotWatch,code:string,database:Database=db):Promise<void> {
  // A transient failure must not set status=error: that would make the next
  // provider retry skip this watch and acknowledge the unprocessed range.
  await database.update(mailpilotWatches).set({lastError:code.slice(0,100)}).where(and(eq(mailpilotWatches.id,watch.id),eq(mailpilotWatches.schoolId,watch.schoolId),eq(mailpilotWatches.studentId,watch.studentId),eq(mailpilotWatches.status,"active")));
}
