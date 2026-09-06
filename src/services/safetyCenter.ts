import { sql } from "drizzle-orm";
import db from "../db.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { canonicalSafetyUrl, safetyUrlFingerprint, safetyAlertFingerprint, SAFETY_URL_VERSION, websiteFromSafetyUrl } from "./safetyUrl.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { zonedDayStartUtc } from "../util/dailyUsageRollup.js";
import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";

type Database = typeof db;
type Executor = Pick<Database,"execute">;
type Row = Record<string, any>;
const rows = async (conn: Executor, query: Parameters<Executor["execute"]>[0]): Promise<Row[]> => (await conn.execute(query)).rows as Row[];
const error = (status:number,message:string) => Object.assign(new Error(message),{status});
const bounded = (value:unknown,length=500):string|null => typeof value==="string" ? value.slice(0,length) : null;
const severityOrder = ['low','medium','high','critical'];
function highestSeverity(first:unknown,second:unknown):string {
  return severityOrder[Math.max(0,severityOrder.indexOf(String(first)),severityOrder.indexOf(String(second)))]!;
}

export async function isSafetyUrlSuppressed(schoolId:string, value:unknown, conn:Executor=db):Promise<boolean> {
  const url=canonicalSafetyUrl(value);
  if (!url) return false;
  const match=await rows(conn,sql`SELECT id FROM safety_url_exceptions WHERE school_id=${schoolId} AND fingerprint=${safetyUrlFingerprint(schoolId,url)} AND revoked_at IS NULL LIMIT 1`);
  if (match.length) recordRuntimePerformanceCounter("safetyExceptionsApplied");
  return match.length>0;
}
export async function safetyAdministrators(schoolId:string,conn:Executor=db) {
  return rows(conn,sql`SELECT DISTINCT u.id,u.first_name,u.last_name,lower(trim(u.email)) AS email
    FROM school_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.school_id=${schoolId} AND m.status='active' AND m.role IN ('admin','school_admin') AND trim(u.email)<>''`);
}
async function assertAdministrator(schoolId:string,actorId:string,conn:Executor) {
  const memberships=await rows(conn,sql`SELECT id FROM school_memberships WHERE school_id=${schoolId} AND user_id=${actorId}
    AND status='active' AND role IN ('admin','school_admin') FOR SHARE`);
  if(!memberships.length) throw error(403,"An active administrator in this school is required");
}
async function audit(conn:Executor,schoolId:string,caseId:string,actorId:string|null,kind:string,alertId:string|null=null,note:string|null=null,metadata:Record<string,unknown>={}) {
  await conn.execute(sql`INSERT INTO student_safety_case_events(school_id,case_id,actor_id,kind,alert_id,note,metadata)
    VALUES(${schoolId},${caseId},${actorId},${kind},${alertId},${note},${JSON.stringify(metadata)}::jsonb)`);
}
export type SafetyObservation = {
 schoolId:string;studentId:string;sourceType:string;sourceId:string;url?:string|null;title?:string|null;
 safetyAlert:string;severity?:string;classificationSource?:string|null;matchedTerm?:string|null;reason?:string|null;
 rulesetVersion?:string|null;modelVersion?:string|null;confidence?:number|null;occurredAt?:Date;
 heartbeatId?:string|null;teachingSessionId?:string|null;decisionId?:string|null;
};
export async function recordSafetyAlert(input:SafetyObservation, dbInstance:Database=db) {
  const severity=severityOrder.includes(input.severity||'')?input.severity!:'medium';
  const url=canonicalSafetyUrl(input.url);
  const urlFingerprint=url?safetyUrlFingerprint(input.schoolId,url):null;
  const outcome = await dbInstance.transaction(async tx=>{
    const conn=tx as unknown as Database;
    await assertClasspilotEntitled(input.schoolId,conn,{lock:true});
    // Rule creation takes the same URL lock. School scope prevents cross-tenant interference.
    if(urlFingerprint) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`safety-url:${input.schoolId}:${urlFingerprint}`},0))`);
    if(url && await isSafetyUrlSuppressed(input.schoolId,url,conn)) return {suppressed:true,created:false,caseId:null,alertId:null};
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`safety-student:${input.schoolId}:${input.studentId}`},0))`);
    const student=await rows(conn,sql`SELECT id FROM students WHERE school_id=${input.schoolId} AND id=${input.studentId}`);
    if(!student.length) throw error(404,"Student not found in this school");
    let [safetyCase]=await rows(conn,sql`SELECT * FROM student_safety_cases WHERE school_id=${input.schoolId} AND student_id=${input.studentId} AND status='open' FOR UPDATE`);
    if(!safetyCase) {
      [safetyCase]=await rows(conn,sql`INSERT INTO student_safety_cases(school_id,student_id,title,severity,status,metadata)
        VALUES(${input.schoolId},${input.studentId},'Student safety report',${severity},'open','{"workflow":"review-first-v1"}'::jsonb) RETURNING *`);
      if (!safetyCase) throw error(500,"Could not create safety report");
      await audit(conn,input.schoolId,safetyCase.id,null,"case_opened");
    }
    if (!safetyCase) throw error(500,"Could not resolve safety report");
    const [revokedRule]=urlFingerprint?await rows(conn,sql`SELECT id FROM safety_url_exceptions WHERE school_id=${input.schoolId} AND fingerprint=${urlFingerprint} AND revoked_at IS NOT NULL ORDER BY revoked_at DESC,id DESC LIMIT 1`):[];
    const fingerprint=safetyAlertFingerprint(input.schoolId,`${input.sourceType}:${revokedRule?.id||'original'}`,input.safetyAlert,url,input.sourceId);
    const at=input.occurredAt??new Date();
    const caseSeverity=highestSeverity(safetyCase.severity,severity);
    const [existing]=await rows(conn,sql`SELECT id,severity FROM student_safety_alerts WHERE school_id=${input.schoolId} AND case_id=${safetyCase.id} AND fingerprint=${fingerprint}`);
    if(existing) {
      await tx.execute(sql`UPDATE student_safety_alerts SET observation_count=observation_count+1,last_seen_at=GREATEST(last_seen_at,${at}),url_ciphertext=${url?encryptSecret(url):null},severity=${highestSeverity(existing.severity,severity)}
        WHERE school_id=${input.schoolId} AND id=${existing.id}`);
      if(caseSeverity!==safetyCase.severity) await tx.execute(sql`UPDATE student_safety_cases SET severity=${caseSeverity},revision=revision+1 WHERE school_id=${input.schoolId} AND id=${safetyCase.id}`);
      return {suppressed:false,created:false,caseId:String(safetyCase.id),alertId:String(existing.id)};
    }
    const [alert]=await rows(conn,sql`INSERT INTO student_safety_alerts(school_id,student_id,case_id,fingerprint,url_fingerprint,url_ciphertext,source_type,source_id,
      concern,severity,classification_source,matched_term,reason,ruleset_version,model_version,confidence,heartbeat_id,teaching_session_id,decision_id,first_seen_at,last_seen_at)
      VALUES(${input.schoolId},${input.studentId},${safetyCase.id},${fingerprint},${urlFingerprint},${url?encryptSecret(url):null},${input.sourceType},${input.sourceId},
      ${bounded(input.safetyAlert,100)},${severity},${bounded(input.classificationSource,100)},${bounded(input.matchedTerm,160)},${bounded(input.reason)},
      ${bounded(input.rulesetVersion,100)},${bounded(input.modelVersion,100)},${input.confidence??null},${input.heartbeatId??null},${input.teachingSessionId??null},${input.decisionId??null},${at},${at}) RETURNING *`);
    if (!alert) throw error(500,"Could not create safety alert");
    await tx.execute(sql`UPDATE student_safety_cases SET revision=revision+1,severity=${caseSeverity},acknowledged_at=NULL,acknowledged_by=NULL WHERE school_id=${input.schoolId} AND id=${safetyCase.id}`);
    const recipients=[...new Set((await safetyAdministrators(input.schoolId,conn)).map(admin=>String(admin.email)))];
    for(const recipient of recipients) {
      await tx.execute(sql`INSERT INTO safety_notification_outbox(school_id,case_id,alert_id,recipient,kind,alert_revision,due_at)
        VALUES(${input.schoolId},${safetyCase.id},${alert.id},${recipient},'initial',0,now()),
        (${input.schoolId},${safetyCase.id},${alert.id},${recipient},'followup',0,now()+interval '15 minutes') ON CONFLICT DO NOTHING`);
    }
    await audit(conn,input.schoolId,safetyCase.id,null,"alert_created",alert.id,null,{sourceType:input.sourceType,concern:input.safetyAlert,recipientCount:recipients.length});
    return {suppressed:false,created:true,caseId:String(safetyCase.id),alertId:String(alert.id)};
  });
  if (!outcome.suppressed) recordRuntimePerformanceCounter(outcome.created ? "safetyAlertsCreated" : "safetyObservationsMerged");
  return outcome;
}
export async function listSafetyCases(schoolId:string,query:{status?:string;review?:string;studentId?:string;student?:string;from?:string;to?:string;cursor?:string;limit?:number}) {
  const limit=Math.min(100,Math.max(1,query.limit||50));
  const [settings]=await rows(db,sql`SELECT school_timezone FROM schools WHERE id=${schoolId}`);
  const timezone=settings?.school_timezone||'America/New_York';
  const start=query.from?zonedDayStartUtc(query.from,timezone):null;
  const end=query.to?zonedDayStartUtc(new Date(Date.parse(`${query.to}T12:00:00Z`)+86400000).toISOString().slice(0,10),timezone):null;
  if(start&&end&&start>=end) throw error(400,"Invalid date range");
  let cursor:{at:string;id:string}|null=null;
  if(query.cursor) {try { cursor=JSON.parse(Buffer.from(query.cursor,"base64url").toString()); if(!cursor?.id||!Number.isFinite(Date.parse(cursor.at))) throw new Error(); } catch {throw error(400,"Invalid cursor");}}
  const where=sql`c.school_id=${schoolId} AND c.merged_into IS NULL
    ${query.status?sql`AND c.status=${query.status}`:sql``}
    ${query.studentId?sql`AND c.student_id=${query.studentId}`:sql``}
    ${query.student?sql`AND concat_ws(' ',s.first_name,s.last_name) ILIKE ${`%${query.student.replace(/[\\%_]/g,'\\$&')}%`}`:sql``}
    ${start?sql`AND c.opened_at>=${start}`:sql``}
    ${end?sql`AND c.opened_at<${end}`:sql``}
    ${query.review==='unreviewed'?sql`AND EXISTS(SELECT 1 FROM student_safety_alerts a WHERE a.school_id=c.school_id AND a.case_id=c.id AND a.reviewed_at IS NULL)`:sql``}
    ${query.review==='reviewed'?sql`AND NOT EXISTS(SELECT 1 FROM student_safety_alerts a WHERE a.school_id=c.school_id AND a.case_id=c.id AND a.reviewed_at IS NULL)`:sql``}
    ${cursor?sql`AND (c.opened_at,c.id)<(${cursor.at}::timestamp,${cursor.id})`:sql``}`;
  const result=await rows(db,sql`SELECT c.id,c.student_id,c.title,c.severity,c.status,c.opened_at,c.closed_at,c.revision,c.assigned_to,c.acknowledged_at,
    to_char(c.opened_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at,
    s.first_name,s.last_name,(SELECT count(*)::int FROM student_safety_alerts a WHERE a.school_id=c.school_id AND a.case_id=c.id AND a.reviewed_at IS NULL) AS unreviewed_count
    FROM student_safety_cases c JOIN students s ON s.school_id=c.school_id AND s.id=c.student_id WHERE ${where} ORDER BY c.opened_at DESC,c.id DESC LIMIT ${limit+1}`);
  const page=result.slice(0,limit);const last=page.at(-1);
  const items=page.map(({cursor_at,...item})=>item);
  return {items,nextCursor:result.length>limit&&last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id})).toString("base64url"):null};
}
export async function safetyUnreviewedCount(schoolId:string) {
  const [row]=await rows(db,sql`SELECT count(*)::int AS count FROM student_safety_alerts a JOIN student_safety_cases c ON c.school_id=a.school_id AND c.id=a.case_id WHERE a.school_id=${schoolId} AND a.reviewed_at IS NULL AND c.status='open'`);
  return row?.count??0;
}
function decryptRetainedUrl(ciphertext:unknown):string|null {
  if(typeof ciphertext!=="string") return null;
  try{return canonicalSafetyUrl(decryptSecret(ciphertext));}catch{return null;}
}
export async function getSafetyReport(schoolId:string,caseId:string,query:{alertCursor?:string;eventCursor?:string;limit?:number}={}) {
  let [safetyCase]=await rows(db,sql`SELECT c.*,s.first_name,s.last_name FROM student_safety_cases c JOIN students s ON s.school_id=c.school_id AND s.id=c.student_id WHERE c.school_id=${schoolId} AND c.id=${caseId}`);
  if(!safetyCase) throw error(404,"Report not found");
  if(safetyCase.merged_into) return {redirectCaseId:safetyCase.merged_into};
  const limit=Math.max(1,Math.min(200,query.limit??100));
  const decodeCursor=(value:string|undefined,kind:string):{at:string;id:string}|null=>{
    if(!value)return null;
    try {
      const cursor=JSON.parse(Buffer.from(value,"base64url").toString());
      if(cursor.schoolId!==schoolId||cursor.caseId!==caseId||cursor.kind!==kind||typeof cursor.id!=="string"||cursor.id.length>128||!Number.isFinite(Date.parse(cursor.at)))throw new Error();
      return cursor;
    }catch{throw error(400,"Invalid report cursor");}
  };
  const alertCursor=decodeCursor(query.alertCursor,"alerts"),eventCursor=decodeCursor(query.eventCursor,"events");
  const alertScope=sql`a.school_id=${schoolId} AND a.case_id=${caseId}
    ${alertCursor?sql`AND (a.first_seen_at,a.id)<(${alertCursor.at}::timestamptz,${alertCursor.id})`:sql``}`;
  const nextCursor=(items:Record<string,any>[],kind:string)=>items.length>limit
    ?Buffer.from(JSON.stringify({schoolId,caseId,kind,at:items[limit-1]!.cursor_at,id:items[limit-1]!.id})).toString("base64url"):null;
  const [alerts,events,notifications,settings,administrators,evidence]=await Promise.all([
    rows(db,sql`SELECT a.*,to_char(a.first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
      EXISTS(SELECT 1 FROM safety_url_exceptions e WHERE e.school_id=a.school_id AND e.fingerprint=a.url_fingerprint AND e.revoked_at IS NULL) AS suppressed
      FROM student_safety_alerts a WHERE ${alertScope} ORDER BY a.first_seen_at DESC,a.id DESC LIMIT ${limit+1}`),
    rows(db,sql`SELECT id,alert_id,actor_id,kind,note,metadata,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM student_safety_case_events WHERE school_id=${schoolId} AND case_id=${caseId}
      ${eventCursor?sql`AND (created_at,id)<(${eventCursor.at}::timestamptz,${eventCursor.id})`:sql``}
      ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`),
    rows(db,sql`SELECT alert_id,recipient,kind,status,due_at,attempts,completed_at,error_code FROM safety_notification_outbox WHERE school_id=${schoolId} AND case_id=${caseId}
      AND alert_id IN(SELECT a.id FROM student_safety_alerts a WHERE ${alertScope} ORDER BY a.first_seen_at DESC,a.id DESC LIMIT ${limit}) ORDER BY due_at DESC`),
    rows(db,sql`SELECT school_timezone AS timezone FROM schools WHERE id=${schoolId} LIMIT 1`),safetyAdministrators(schoolId),
    rows(db,sql`SELECT id,source_id,artifact_type,status,label,captured_at FROM evidence_artifacts WHERE school_id=${schoolId} AND student_id=${safetyCase.student_id} AND case_id=${caseId} ORDER BY captured_at DESC,id DESC LIMIT 100`),
  ]);
  const {getSchoolWebsitePolicyStatus,schoolWebsiteRuleApplies}=await import("./classpilotSchoolWebsitePolicy.js");
  const websitePolicy=await getSchoolWebsitePolicyStatus(schoolId,"");
  const safeAlerts=alerts.slice(0,limit).map(alert=>{
    const {url_ciphertext,fingerprint,url_fingerprint,cursor_at,...safe}=alert;
    const url=decryptRetainedUrl(url_ciphertext); const domain=websiteFromSafetyUrl(url);
    return {...safe,id:String(alert.id),url,domain,websitePolicy:domain?{...websitePolicy,
      blocked:websitePolicy.blockedDomains.some(rule=>schoolWebsiteRuleApplies(domain,rule))}:null};
  });
  // Legacy summary/metadata can carry unretained URL contents. Only expose bounded case provenance.
  const {summary,metadata,...safeCase}=safetyCase;
  return {case:safeCase,alerts:safeAlerts,events:events.slice(0,limit).map(({cursor_at,...event})=>event),
    alertPage:{nextCursor:nextCursor(alerts,"alerts")},eventPage:{nextCursor:nextCursor(events,"events")},
    notifications,administrators,evidence,timezone:settings[0]?.timezone||"America/New_York"};
}
export async function reviewSafetyAlert(input:{schoolId:string;alertId:string;actorId:string;revision:number;note?:string;action:"review"|"suppress"}) {
  return db.transaction(async tx=>{
    const conn=tx as unknown as Database;
    await assertAdministrator(input.schoolId,input.actorId,conn);
    // Read fingerprint before row lock so every writer takes URL lock before case/alert locks.
    const [candidate]=await rows(conn,sql`SELECT url_fingerprint,case_id FROM student_safety_alerts WHERE school_id=${input.schoolId} AND id=${input.alertId}`);
    if(!candidate) throw error(404,"Alert not found");
    if(candidate.url_fingerprint) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`safety-url:${input.schoolId}:${candidate.url_fingerprint}`},0))`);
    await tx.execute(sql`SELECT id FROM student_safety_cases WHERE school_id=${input.schoolId} AND id=${candidate.case_id} FOR UPDATE`);
    const [alert]=await rows(conn,sql`SELECT * FROM student_safety_alerts WHERE school_id=${input.schoolId} AND id=${input.alertId} FOR UPDATE`);
    if (!alert) throw error(404,"Alert not found");
    if(alert.revision!==input.revision) throw error(409,"Alert changed. Refresh the report and try again.");
    let ruleId:string|null=null;
    if(input.action==='suppress') {
      const url=decryptRetainedUrl(alert.url_ciphertext);
      if(!url) throw error(409,"The retained browser URL is unavailable");
      const [rule]=await rows(conn,sql`INSERT INTO safety_url_exceptions(school_id,fingerprint,url_ciphertext,canonicalizer_version,created_from_alert_id,created_by)
        VALUES(${input.schoolId},${safetyUrlFingerprint(input.schoolId,url)},${encryptSecret(url)},${SAFETY_URL_VERSION},${alert.id},${input.actorId})
        ON CONFLICT(school_id,fingerprint) WHERE revoked_at IS NULL DO UPDATE SET fingerprint=excluded.fingerprint RETURNING id`);
      if (!rule) throw error(500,"Could not save URL approval");
      ruleId=rule.id;
      await tx.execute(sql`UPDATE safety_notification_outbox o SET status='cancelled',completed_at=now() FROM student_safety_alerts a
        WHERE o.school_id=${input.schoolId} AND a.school_id=o.school_id AND a.id=o.alert_id AND a.url_fingerprint=${alert.url_fingerprint}
        AND (o.status='pending' OR (o.status='sending' AND o.submission_started_at IS NULL))`);
    }
    await tx.execute(sql`UPDATE student_safety_alerts SET reviewed_at=now(),reviewed_by=${input.actorId},review_note=${bounded(input.note,2000)},revision=revision+1 WHERE school_id=${input.schoolId} AND id=${input.alertId}`);
    await tx.execute(sql`UPDATE safety_notification_outbox SET status='cancelled',completed_at=now() WHERE school_id=${input.schoolId} AND alert_id=${input.alertId}
      AND (status='pending' OR (status='sending' AND submission_started_at IS NULL))`);
    await tx.execute(sql`UPDATE student_safety_cases SET revision=revision+1 WHERE school_id=${input.schoolId} AND id=${alert.case_id}`);
    await audit(conn,input.schoolId,alert.case_id,input.actorId,input.action==='suppress'?'url_approved':'alert_reviewed',input.alertId,bounded(input.note,2000),ruleId?{ruleId}:{});
    return {ruleId};
  });
}
export async function updateSafetyCase(input:{schoolId:string;caseId:string;actorId:string;revision:number;action:"acknowledge"|"assign"|"close"|"note";assignedTo?:string|null;note?:string}) {
  return db.transaction(async tx=>{
    const conn=tx as unknown as Database;
    await assertAdministrator(input.schoolId,input.actorId,conn);
    const [safetyCase]=await rows(conn,sql`SELECT * FROM student_safety_cases WHERE school_id=${input.schoolId} AND id=${input.caseId} FOR UPDATE`);
    if(!safetyCase) throw error(404,"Report not found");
    if(safetyCase.revision!==input.revision) throw error(409,"Report changed. Refresh and try again.");
    if(input.action==='close' && !input.note?.trim()) throw error(400,"A resolution note is required");
    if(input.action==='assign'&&input.assignedTo) await assertAdministrator(input.schoolId,input.assignedTo,conn);
    if(input.action==='acknowledge') {
      await tx.execute(sql`UPDATE student_safety_alerts SET acknowledged_at=now(),acknowledged_by=${input.actorId},revision=revision+1
        WHERE school_id=${input.schoolId} AND case_id=${input.caseId} AND reviewed_at IS NULL AND acknowledged_at IS NULL`);
      await tx.execute(sql`UPDATE safety_notification_outbox SET status='cancelled',completed_at=now()
        WHERE school_id=${input.schoolId} AND case_id=${input.caseId} AND kind='followup'
        AND (status='pending' OR (status='sending' AND submission_started_at IS NULL))`);
    }
    if(input.action==='close') {
      await tx.execute(sql`UPDATE student_safety_alerts SET reviewed_at=COALESCE(reviewed_at,now()),reviewed_by=COALESCE(reviewed_by,${input.actorId}),revision=revision+1 WHERE school_id=${input.schoolId} AND case_id=${input.caseId} AND reviewed_at IS NULL`);
      await tx.execute(sql`UPDATE safety_notification_outbox SET status='cancelled',completed_at=now() WHERE school_id=${input.schoolId} AND case_id=${input.caseId}
        AND (status='pending' OR (status='sending' AND submission_started_at IS NULL))`);
    }
    await tx.execute(sql`UPDATE student_safety_cases SET revision=revision+1
      ${input.action==='close'?sql`,status='closed',closed_at=now(),closed_by=${input.actorId},resolution_note=${bounded(input.note,2000)}`:sql``}
      ${input.action==='acknowledge'?sql`,acknowledged_at=now(),acknowledged_by=${input.actorId}`:sql``}
      ${input.action==='assign'?sql`,assigned_to=${input.assignedTo||null}`:sql``}
      WHERE school_id=${input.schoolId} AND id=${input.caseId}`);
    await audit(conn,input.schoolId,input.caseId,input.actorId,`case_${input.action}`,null,bounded(input.note,2000),input.action==='assign'?{assignedTo:input.assignedTo??null}:{});
    return {ok:true};
  });
}
export async function listSafetyUrlExceptions(schoolId:string,cursorValue?:string) {
  let cursor:{at:string;id:string}|null=null;
  if(cursorValue){try{cursor=JSON.parse(Buffer.from(cursorValue,'base64url').toString());if(!cursor?.id||!Number.isFinite(Date.parse(cursor.at)))throw new Error();}catch{throw error(400,'Invalid approval cursor');}}
  const rules=await rows(db,sql`SELECT id,url_ciphertext,created_by,created_at,revoked_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM safety_url_exceptions WHERE school_id=${schoolId} AND revoked_at IS NULL
    ${cursor?sql`AND (created_at,id)<(${cursor.at}::timestamptz,${cursor.id})`:sql``} ORDER BY created_at DESC,id DESC LIMIT 101`);
  const items=rules.slice(0,100).map(rule=>({id:String(rule.id),created_by:String(rule.created_by),
    created_at:rule.created_at,revoked_at:rule.revoked_at,url:decryptRetainedUrl(rule.url_ciphertext)}));
  const last=rules[99];
  return {items,nextCursor:rules.length>100&&last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id})).toString('base64url'):null};
}
export async function revokeSafetyUrlException(schoolId:string,id:string,actorId:string) {
  await db.transaction(async tx=>{
    const conn=tx as unknown as Database;await assertAdministrator(schoolId,actorId,conn);
    const [rule]=await rows(conn,sql`SELECT * FROM safety_url_exceptions WHERE school_id=${schoolId} AND id=${id}`);
    if(!rule) throw error(404,"Approved URL not found");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`safety-url:${schoolId}:${rule.fingerprint}`},0))`);
    // Retention deletes case -> alert -> rule provenance. Take parent locks
    // before updating the rule so revocation cannot invert that delete order.
    const [source]=await rows(conn,sql`SELECT case_id FROM student_safety_alerts WHERE school_id=${schoolId} AND id=${rule.created_from_alert_id}`);
    if(source) await tx.execute(sql`SELECT id FROM student_safety_cases WHERE school_id=${schoolId} AND id=${source.case_id} FOR KEY SHARE`);
    const [alert]=await rows(conn,sql`SELECT case_id FROM student_safety_alerts WHERE school_id=${schoolId} AND id=${rule.created_from_alert_id} FOR KEY SHARE`);
    const changed=await rows(conn,sql`UPDATE safety_url_exceptions SET revoked_at=now(),revoked_by=${actorId}
      WHERE school_id=${schoolId} AND id=${id} AND revoked_at IS NULL RETURNING id`);
    if(!changed.length)return;
    if(alert) await audit(conn,schoolId,alert.case_id,actorId,"url_approval_revoked",null,null,{ruleId:id});
    // Configuration can outlive its source report. This strict write shares the
    // revocation transaction and retains only rule/actor IDs, never the URL.
    await tx.execute(sql`INSERT INTO audit_logs(school_id,user_id,action,entity_type,entity_id,metadata)
      VALUES(${schoolId},${actorId},'url_approval_revoked','safety_url_exception',${id},${JSON.stringify({sourceCaseAvailable:Boolean(alert)})}::jsonb)`);
  });
}
export async function blockSafetyWebsite(input:{schoolId:string;alertId:string;actorId:string;revision:number;policyRevision:number;note?:string}) {
  // Website mutation owns its school-policy transaction. Review is recorded only after it succeeds.
  await assertAdministrator(input.schoolId,input.actorId,db);
  const [alert]=await rows(db,sql`SELECT * FROM student_safety_alerts WHERE school_id=${input.schoolId} AND id=${input.alertId}`);
  if(!alert) throw error(404,"Alert not found");
  if(alert.revision!==input.revision) throw error(409,"Alert changed. Refresh and try again.");
  const domain=websiteFromSafetyUrl(decryptRetainedUrl(alert.url_ciphertext));
  if(!domain) throw error(409,"The retained browser URL is unavailable");
  const {addSchoolBlockedWebsite}=await import("./classpilotSchoolWebsitePolicy.js");
  const policy=await addSchoolBlockedWebsite({schoolId:input.schoolId,domain,expectedRevision:input.policyRevision,actorId:input.actorId,
    afterSave: async (conn) => {
      await conn.execute(sql`SELECT id FROM student_safety_cases WHERE school_id=${input.schoolId} AND id=${alert.case_id} FOR UPDATE`);
      const [current]=await rows(conn,sql`SELECT * FROM student_safety_alerts WHERE school_id=${input.schoolId} AND id=${input.alertId} FOR UPDATE`);
      if (!current || current.revision!==input.revision || websiteFromSafetyUrl(decryptRetainedUrl(current.url_ciphertext))!==domain) throw error(409,"Alert changed. Refresh and try again.");
      await conn.execute(sql`UPDATE student_safety_alerts SET reviewed_at=now(),reviewed_by=${input.actorId},review_note=${bounded(input.note,2000)},revision=revision+1 WHERE school_id=${input.schoolId} AND id=${input.alertId}`);
      await conn.execute(sql`UPDATE safety_notification_outbox SET status='cancelled',completed_at=now() WHERE school_id=${input.schoolId} AND alert_id=${input.alertId}
        AND (status='pending' OR (status='sending' AND submission_started_at IS NULL))`);
      await conn.execute(sql`UPDATE student_safety_cases SET revision=revision+1 WHERE school_id=${input.schoolId} AND id=${alert.case_id}`);
      await audit(conn,input.schoolId,alert.case_id,input.actorId,"website_blocked",input.alertId,bounded(input.note,2000),{domain});
    },
  });
  return policy;
}
