import { before,after,test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

process.env.SCHEDULER_ENABLED="true";
process.env.REDIS_URL="";
const {pool,sessionPool}=await import("../dist/db.js");
const {schedulerPool,schedulerLockPool}=await import("../dist/services/schedulerDb.js");
const {runWithTenantContext}=await import("../dist/middleware/tenantContext.js");
const safety=await import("../dist/services/safetyCenter.js");
const {dispatchSafetyNotifications}=await import("../dist/services/safetyNotifications.js");
const {SAFETY_CENTER_SQL}=await import("../dist/db/safetyCenterMigration.js");
const {CLASSPILOT_SCHOOL_WEBSITE_POLICY_SQL}=await import("../dist/db/classpilotSchoolWebsitePolicyMigration.js");
const schoolA=randomUUID(),schoolB=randomUUID(),studentA=randomUUID(),studentB=randomUUID(),studentOther=randomUUID();
const admin=randomUUID(),aliasAdmin=randomUUID(),teacher=randomUUID(),inactive=randomUUID(),otherAdmin=randomUUID();
const inSchool=<T>(id:string,fn:()=>Promise<T>)=>runWithTenantContext({schoolId:id},fn);
const observation=(studentId=studentA,url='https://example.test/search?q=one#first',concern='violence',schoolId=schoolA)=>({schoolId,studentId,sourceType:'browser',sourceId:randomUUID(),url,safetyAlert:concern,severity:'low',reason:'Reviewed deterministic rule matched.',classificationSource:'search',matchedTerm:'fixture-rule'});
let first:{caseId:string;alertId:string};
before(async()=>{
  await pool.query(SAFETY_CENTER_SQL);await pool.query(CLASSPILOT_SCHOOL_WEBSITE_POLICY_SQL);
  for(const id of [schoolA,schoolB]){
    await pool.query(`INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Safety synthetic fixture','active',true,'active','America/Chicago')`,[id]);
    await pool.query(`INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')`,[id]);
    await pool.query(`INSERT INTO settings(school_id,school_name,ws_shared_key,school_timezone) VALUES($1,'Safety synthetic fixture','fixture-only','America/Chicago')`,[id]);
  }
  for(const [id,role,schoolId,status] of [[admin,'admin',schoolA,'active'],[aliasAdmin,'school_admin',schoolA,'active'],[teacher,'teacher',schoolA,'active'],[inactive,'admin',schoolA,'inactive'],[otherAdmin,'admin',schoolB,'active']]){
    await pool.query(`INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Admin')`,[id,`${id}@example.test`]);
    await pool.query(`INSERT INTO school_memberships(user_id,school_id,role,status) VALUES($1,$2,$3,$4)`,[id,schoolId,role,status]);
  }
  await pool.query(`INSERT INTO school_memberships(user_id,school_id,role,status) VALUES($1,$2,'school_admin','active')`,[admin,schoolA]);
  for(const [id,schoolId] of [[studentA,schoolA],[studentB,schoolA],[studentOther,schoolB]])await pool.query(`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Student','active')`,[id,schoolId]);
});
after(async()=>{
  try{
    for(const table of ['audit_logs','safety_url_exceptions','student_safety_cases','classpilot_school_website_deliveries','classpilot_school_website_policies','settings','school_memberships','product_licenses','students'])await pool.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`,[[schoolA,schoolB]]);
    await pool.query(`DELETE FROM schools WHERE id=ANY($1::text[])`,[[schoolA,schoolB]]);
    await pool.query(`DELETE FROM users WHERE id=ANY($1::text[])`,[[admin,aliasAdmin,teacher,inactive,otherAdmin]]);
  }finally{await Promise.all([pool.end(),sessionPool.end(),schedulerPool.end(),schedulerLockPool.end()]);}
});
test("concurrent observations create one open case and one distinct alert, with both administrator roles deduplicated",async()=>{
  const results=await Promise.all(Array.from({length:8},()=>inSchool(schoolA,()=>safety.recordSafetyAlert(observation()))));
  assert.equal(results.filter(item=>item.created).length,1);
  assert.equal(new Set(results.map(item=>item.caseId)).size,1);
  const result=results[0];assert.ok(result?.caseId&&result.alertId);first={caseId:result.caseId,alertId:result.alertId};
  const alerts=await pool.query(`SELECT * FROM student_safety_alerts WHERE school_id=$1`,[schoolA]);
  assert.equal(alerts.rows.length,1);assert.equal(alerts.rows[0].observation_count,8);assert.equal(alerts.rows[0].confidence,null);
  const outbox=await pool.query(`SELECT recipient,kind FROM safety_notification_outbox WHERE school_id=$1`,[schoolA]);
  assert.equal(outbox.rows.length,4);
  assert.deepEqual([...new Set(outbox.rows.map(row=>row.recipient))].sort(),[`${admin}@example.test`,`${aliasAdmin}@example.test`].sort());
  const report=await inSchool(schoolA,()=>safety.getSafetyReport(schoolA,first.caseId));
  assert.equal(report.timezone,'America/Chicago');
  await assert.rejects(inSchool(schoolB,()=>safety.getSafetyReport(schoolB,first.caseId)),{status:404});
});
test("all severities send initial email; acknowledgment cancels the single follow-up and repeated observations preserve it",async()=>{
  const sent:Array<{to:string;text?:string}>=[];
  await dispatchSafetyNotifications({providerConfigured:true,send:async message=>{sent.push(message);return {status:'sent',providerMessageId:'fixture'};}});
  assert.equal(sent.length,2);assert.match(sent[0]?.text||'',/America\/Chicago/);assert.match(sent[0]?.text||'',/cases|case=/);
  const revision=(await pool.query(`SELECT revision FROM student_safety_cases WHERE id=$1`,[first.caseId])).rows[0].revision;
  await inSchool(schoolA,()=>safety.updateSafetyCase({schoolId:schoolA,caseId:first.caseId,actorId:admin,revision,action:'acknowledge'}));
  await inSchool(schoolA,()=>safety.recordSafetyAlert(observation()));
  await pool.query(`UPDATE safety_notification_outbox SET due_at=now()-interval '1 minute' WHERE school_id=$1`,[schoolA]);
  await dispatchSafetyNotifications({providerConfigured:true,send:async message=>{sent.push(message);return {status:'sent'};}});
  assert.equal(sent.length,2);
  const alerts=(await pool.query(`SELECT acknowledged_at,reviewed_at,observation_count FROM student_safety_alerts WHERE id=$1`,[first.alertId])).rows[0];
  assert.ok(alerts.acknowledged_at);assert.equal(alerts.reviewed_at,null);assert.equal(alerts.observation_count,9);
});
test("exact approval is school-wide, prunes queued mail, preserves other URLs and revocation enables future detections",async()=>{
  const url='https://example.test/search?q=two&x=1#first';
  const one=await inSchool(schoolA,()=>safety.recordSafetyAlert(observation(studentA,url)));
  await inSchool(schoolA,()=>safety.recordSafetyAlert(observation(studentB,url)));
  assert.ok(one.alertId);
  await assert.rejects(inSchool(schoolA,()=>safety.reviewSafetyAlert({schoolId:schoolA,alertId:one.alertId!,actorId:teacher,revision:0,action:'suppress'})),{status:403});
  const result=await inSchool(schoolA,()=>safety.reviewSafetyAlert({schoolId:schoolA,alertId:one.alertId!,actorId:aliasAdmin,revision:0,action:'suppress'}));
  assert.ok(result.ruleId);
  assert.equal((await inSchool(schoolA,()=>safety.recordSafetyAlert(observation(studentB,url)))).suppressed,true);
  assert.equal(await inSchool(schoolB,()=>safety.isSafetyUrlSuppressed(schoolB,url)),false);
  assert.equal(await inSchool(schoolA,()=>safety.isSafetyUrlSuppressed(schoolA,url.replace('#first','#second'))),false);
  const queued=await pool.query(`SELECT o.status FROM safety_notification_outbox o JOIN student_safety_alerts a ON a.id=o.alert_id WHERE a.school_id=$1 AND a.url_fingerprint=(SELECT url_fingerprint FROM student_safety_alerts WHERE id=$2)`,[schoolA,one.alertId]);
  assert.ok(queued.rows.every(row=>row.status==='cancelled'));
  await inSchool(schoolA,()=>safety.revokeSafetyUrlException(schoolA,result.ruleId!,admin));
  const future=await inSchool(schoolA,()=>safety.recordSafetyAlert(observation(studentA,url)));
  assert.equal(future.created,true);assert.notEqual(future.alertId,one.alertId);
});
test("blocking is revision checked and atomically records review while preserving unrelated policy",async()=>{
  const current=await inSchool(schoolA,()=>safety.recordSafetyAlert(observation(studentA,'https://blocked.example.test/a')));
  assert.ok(current.alertId);
  await inSchool(schoolA,()=>safety.blockSafetyWebsite({schoolId:schoolA,alertId:current.alertId!,actorId:admin,revision:0,policyRevision:0}));
  const settings=(await pool.query(`SELECT blocked_domains FROM settings WHERE school_id=$1`,[schoolA])).rows[0];
  assert.deepEqual(settings.blocked_domains,['blocked.example.test']);
  const alert=(await pool.query(`SELECT reviewed_at,revision FROM student_safety_alerts WHERE id=$1`,[current.alertId])).rows[0];assert.ok(alert.reviewed_at);
  await assert.rejects(inSchool(schoolA,()=>safety.blockSafetyWebsite({schoolId:schoolA,alertId:current.alertId!,actorId:admin,revision:0,policyRevision:1})),{status:409});
});
test("closing requires a resolution, and later activity starts a new case",async()=>{
  const revision=(await pool.query(`SELECT revision FROM student_safety_cases WHERE id=$1`,[first.caseId])).rows[0].revision;
  await assert.rejects(inSchool(schoolA,()=>safety.updateSafetyCase({schoolId:schoolA,caseId:first.caseId,actorId:admin,revision,action:'close'})),{status:400});
  await inSchool(schoolA,()=>safety.updateSafetyCase({schoolId:schoolA,caseId:first.caseId,actorId:admin,revision,action:'close',note:'Reviewed with the designated school team.'}));
  const next=await inSchool(schoolA,()=>safety.recordSafetyAlert(observation()));assert.notEqual(next.caseId,first.caseId);
});
test("unacknowledged alerts receive exactly one follow-up; ambiguous initial transport is not retried",async()=>{
  const item=await inSchool(schoolB,()=>safety.recordSafetyAlert(observation(studentOther,'https://followup.example.test/','violence',schoolB)));
  assert.ok(item.alertId);
  const delivered:string[]=[];
  const send=async(message:{to:string})=>{delivered.push(message.to);return {status:'sent' as const,providerMessageId:'accepted'};};
  await dispatchSafetyNotifications({providerConfigured:true,send});
  assert.equal(delivered.filter(to=>to===`${otherAdmin}@example.test`).length,1);
  await pool.query(`UPDATE safety_notification_outbox SET due_at=now()-interval '1 second' WHERE school_id=$1 AND kind='followup'`,[schoolB]);
  await dispatchSafetyNotifications({providerConfigured:true,send});
  await dispatchSafetyNotifications({providerConfigured:true,send});
  assert.equal(delivered.filter(to=>to===`${otherAdmin}@example.test`).length,2);
  await inSchool(schoolB,()=>safety.recordSafetyAlert(observation(studentOther,'https://ambiguous.example.test/','violence',schoolB)));
  let ambiguous=0;
  const unknown=async()=>{ambiguous++;return {status:'unknown' as const,error:'TRANSPORT_OUTCOME_UNKNOWN'};};
  await dispatchSafetyNotifications({providerConfigured:true,send:unknown});
  await dispatchSafetyNotifications({providerConfigured:true,send:unknown});
  assert.equal(ambiguous,1);
});

async function postponeExistingPendingMail() {
  await pool.query(`UPDATE safety_notification_outbox SET due_at=now()+interval '1 day' WHERE school_id=ANY($1::text[]) AND status='pending'`,[[schoolA,schoolB]]);
}

test('crashed reservations recover; only notifications authorized for submission become unknown',async()=>{
  await postponeExistingPendingMail();
  const reserved=await inSchool(schoolB,()=>safety.recordSafetyAlert(observation(studentOther,'https://reserved.example.test/','violence',schoolB)));
  const submitted=await inSchool(schoolB,()=>safety.recordSafetyAlert(observation(studentOther,'https://submitted.example.test/','violence',schoolB)));
  await pool.query(`UPDATE safety_notification_outbox SET status='sending',claimed_at=now()-interval '11 minutes',
    submission_started_at=CASE WHEN alert_id=$1 THEN now()-interval '11 minutes' ELSE NULL END,
    attempts=CASE WHEN alert_id=$1 THEN 1 ELSE 0 END WHERE alert_id=ANY($2::text[]) AND kind='initial'`,[submitted.alertId,[reserved.alertId,submitted.alertId]]);
  let calls=0;
  await dispatchSafetyNotifications({providerConfigured:true,send:async()=>{calls++;return {status:'sent'};}});
  assert.equal(calls,1);
  const items=(await pool.query(`SELECT alert_id,status,attempts FROM safety_notification_outbox WHERE alert_id=ANY($1::text[]) AND kind='initial'`,[[reserved.alertId,submitted.alertId]])).rows;
  assert.equal(items.find(item=>item.alert_id===reserved.alertId)?.status,'sent');
  assert.equal(items.find(item=>item.alert_id===reserved.alertId)?.attempts,1);
  assert.equal(items.find(item=>item.alert_id===submitted.alertId)?.status,'unknown');
});

test('review committed while the worker waits for its case lock cancels reserved email',async()=>{
  await postponeExistingPendingMail();
  const item=await inSchool(schoolB,()=>safety.recordSafetyAlert(observation(studentOther,'https://review-race.example.test/','violence',schoolB)));
  const reviewer=await pool.connect();
  let dispatch:Promise<void>|undefined;
  let calls=0;
  try {
    await reviewer.query('BEGIN');
    await reviewer.query(`SELECT id FROM student_safety_cases WHERE school_id=$1 AND id=$2 FOR UPDATE`,[schoolB,item.caseId]);
    dispatch=dispatchSafetyNotifications({providerConfigured:true,send:async()=>{calls++;return {status:'sent'};}});
    let reserved=false;
    for(let attempt=0;attempt<100;attempt++) {
      const row=(await pool.query(`SELECT status FROM safety_notification_outbox WHERE alert_id=$1 AND kind='initial'`,[item.alertId])).rows[0];
      if(row?.status==='sending'){reserved=true;break;}
      await delay(10);
    }
    assert.equal(reserved,true,'worker must have reserved the message before review commits');
    await reviewer.query(`UPDATE student_safety_alerts SET reviewed_at=now(),reviewed_by=$1,revision=revision+1 WHERE school_id=$2 AND id=$3`,[otherAdmin,schoolB,item.alertId]);
    await reviewer.query('COMMIT');
    await dispatch;
    assert.equal(calls,0);
    assert.equal((await pool.query(`SELECT status,submission_started_at FROM safety_notification_outbox WHERE alert_id=$1 AND kind='initial'`,[item.alertId])).rows[0].status,'cancelled');
  } finally {
    await reviewer.query('ROLLBACK');reviewer.release();await dispatch;
  }
});

test('provider submission holds no review lock; subsequent review preserves in-flight outcome and cancels follow-up',async()=>{
  await postponeExistingPendingMail();
  const item=await inSchool(schoolB,()=>safety.recordSafetyAlert(observation(studentOther,'https://in-flight.example.test/','violence',schoolB)));
  let calls=0;
  await dispatchSafetyNotifications({providerConfigured:true,send:async()=>{
    calls++;
    const outbox=(await pool.query(`SELECT submission_started_at FROM safety_notification_outbox WHERE alert_id=$1 AND kind='initial'`,[item.alertId])).rows[0];
    assert.ok(outbox.submission_started_at);
    await inSchool(schoolB,()=>safety.reviewSafetyAlert({schoolId:schoolB,alertId:item.alertId!,actorId:otherAdmin,revision:0,action:'review'}));
    return {status:'sent'};
  }});
  assert.equal(calls,1);
  const rows=(await pool.query(`SELECT kind,status FROM safety_notification_outbox WHERE alert_id=$1`,[item.alertId])).rows;
  assert.equal(rows.find(row=>row.kind==='initial')?.status,'sent');
  assert.equal(rows.find(row=>row.kind==='followup')?.status,'cancelled');
});

test('higher severity observations raise case severity without duplicating alerts or email',async()=>{
  const input=observation(studentOther,'https://severity.example.test/','violence',schoolB);
  const first=await inSchool(schoolB,()=>safety.recordSafetyAlert({...input,severity:'high'}));
  await inSchool(schoolB,()=>safety.recordSafetyAlert({...input,severity:'critical'}));
  await inSchool(schoolB,()=>safety.recordSafetyAlert({...input,severity:'low'}));
  const row=(await pool.query(`SELECT a.severity,a.observation_count,c.severity AS case_severity FROM student_safety_alerts a JOIN student_safety_cases c ON c.id=a.case_id WHERE a.id=$1`,[first.alertId])).rows[0];
  assert.equal(row.severity,'critical');assert.equal(row.case_severity,'critical');assert.equal(row.observation_count,3);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM safety_notification_outbox WHERE alert_id=$1 AND kind='initial'`,[first.alertId])).rows[0].count,1);
});

test('revoking an approval after source expiry retains one atomic audit without a raw URL',async()=>{
  const studentId=randomUUID();const url='https://retained-approval.example.test/private?q=sensitive';
  await pool.query(`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Expiry','active')`,[studentId,schoolB]);
  const item=await inSchool(schoolB,()=>safety.recordSafetyAlert(observation(studentId,url,'violence',schoolB)));
  const approval=await inSchool(schoolB,()=>safety.reviewSafetyAlert({schoolId:schoolB,alertId:item.alertId!,actorId:otherAdmin,revision:0,action:'suppress'}));
  await pool.query(`DELETE FROM student_safety_cases WHERE school_id=$1 AND id=$2`,[schoolB,item.caseId]);
  assert.equal((await pool.query(`SELECT created_from_alert_id FROM safety_url_exceptions WHERE id=$1`,[approval.ruleId])).rows[0].created_from_alert_id,null);
  await inSchool(schoolB,()=>safety.revokeSafetyUrlException(schoolB,approval.ruleId!,otherAdmin));
  await inSchool(schoolB,()=>safety.revokeSafetyUrlException(schoolB,approval.ruleId!,otherAdmin));
  const audits=(await pool.query(`SELECT user_id,metadata,entity_id FROM audit_logs WHERE school_id=$1 AND action='url_approval_revoked' AND entity_id=$2`,[schoolB,approval.ruleId])).rows;
  assert.equal(audits.length,1);assert.equal(audits[0].user_id,otherAdmin);
  assert.deepEqual(audits[0].metadata,{sourceCaseAvailable:false});
  assert.equal(JSON.stringify(audits).includes(url),false);
  assert.equal(await inSchool(schoolB,()=>safety.isSafetyUrlSuppressed(schoolB,url)),false);
});

test('case and approval cursors preserve PostgreSQL microseconds without skipping adjacent rows',async()=>{
  const older=randomUUID(),newer=randomUUID();
  await pool.query(`INSERT INTO student_safety_cases(id,school_id,student_id,title,status,opened_at,closed_at)
    VALUES($1,$3,$4,'Older','closed','2099-01-01 12:00:00.000900','2099-01-01'),
          ($2,$3,$4,'Newer','closed','2099-01-01 12:00:00.000901','2099-01-01')`,[older,newer,schoolA,studentA]);
  const filters={studentId:studentA,status:'closed',from:'2099-01-01',to:'2099-01-01',limit:1};
  const firstPage=await inSchool(schoolA,()=>safety.listSafetyCases(schoolA,filters));
  assert.equal(firstPage.items[0]?.id,newer);assert.ok(firstPage.nextCursor);
  const next=await inSchool(schoolA,()=>safety.listSafetyCases(schoolA,{...filters,cursor:firstPage.nextCursor!}));
  assert.equal(next.items[0]?.id,older);assert.equal(next.nextCursor,null);
  const prefix=randomUUID();
  await pool.query(`INSERT INTO safety_url_exceptions(school_id,fingerprint,url_ciphertext,created_by,created_at)
    SELECT $1,$2||g::text,'encrypted-fixture',$3,'2099-01-01T12:00:00Z'::timestamptz+g*interval '1 microsecond'
    FROM generate_series(1,101) AS g`,[schoolA,prefix,admin]);
  const expected=(await pool.query(`SELECT id FROM safety_url_exceptions WHERE school_id=$1 AND fingerprint LIKE $2 ORDER BY created_at DESC,id DESC`,[schoolA,`${prefix}%`])).rows.map(row=>row.id);
  const rules=await inSchool(schoolA,()=>safety.listSafetyUrlExceptions(schoolA));
  assert.deepEqual(rules.items.map(row=>row.id),expected.slice(0,100));assert.ok(rules.nextCursor);
  const remaining=await inSchool(schoolA,()=>safety.listSafetyUrlExceptions(schoolA,rules.nextCursor!));
  assert.equal(remaining.items[0]?.id,expected[100]);
});
