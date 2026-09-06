import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { SAFETY_CENTER_SQL } from "../src/db/safetyCenterMigration.js";
import { MAILPILOT_SAFETY_DURABILITY_SQL } from "../src/db/mailpilotSafetyDurabilityMigration.js";
import { mailpilotSafetySourceId, processMailpilotHistoryBatch } from "../src/services/mailpilotNotification.js";
import type { InsertEmailAlert, MailpilotWatch } from "../src/schema/mailpilot.js";

process.env.REDIS_URL="";
process.env.SCHEDULER_ENABLED="false";
const schoolA=randomUUID(),schoolB=randomUUID(),studentA=randomUUID(),studentB=randomUUID(),admin=randomUUID();
let pool:import("pg").Pool,database:typeof import("../src/db.js").default;
let tenant:typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let persistence:typeof import("../src/services/mailpilotSafetyPersistence.js");
let storage:typeof import("../src/services/storage.js");
let safety:typeof import("../src/services/safetyCenter.js");
const email=(studentId:string)=>`${studentId}@mailpilot.example.test`;
const scoped=<T>(schoolId:string,fn:()=>Promise<T>)=>tenant({schoolId},fn);
const identity=(messageId:string,schoolId=schoolA,studentId=studentA)=>({schoolId,studentId,studentEmail:email(studentId),gmailMessageId:messageId});
const payload=(messageId:string,schoolId=schoolA,studentId=studentA):InsertEmailAlert=>({...identity(messageId,schoolId,studentId),direction:"inbound",subject:"Synthetic fixture",snippet:"Fixture mail content",safetyAlert:"bullying",bullying:"true",severity:"low",confidence:72,reasoning:"Synthetic classification",messageDate:new Date("2026-09-01T12:00:00Z")});

before(async()=>{
  assert.ok(["localhost","127.0.0.1","::1"].includes(new URL(process.env.DATABASE_URL||"").hostname),"MailPilot durability tests require a local fixture database.");
  const module=await import("../src/db.js");pool=module.pool;database=module.default;
  ({runWithTenantContext:tenant}=await import("../src/middleware/tenantContext.js"));
  persistence=await import("../src/services/mailpilotSafetyPersistence.js");storage=await import("../src/services/storage.js");safety=await import("../src/services/safetyCenter.js");
  await pool.query(SAFETY_CENTER_SQL);await pool.query(MAILPILOT_SAFETY_DURABILITY_SQL);await pool.query(MAILPILOT_SAFETY_DURABILITY_SQL);
  for(const schoolId of [schoolA,schoolB]){
    await pool.query("INSERT INTO schools(id,name,domain,mailpilot_entitled,classpilot_email_monitoring) VALUES($1,$2,'mailpilot.example.test',true,true)",[schoolId,`MailPilot synthetic fixture ${schoolId}`]);
    await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')",[schoolId]);
  }
  await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Administrator')",[admin,`${admin}@mailpilot.example.test`]);
  await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'admin','active'),($3,$2,'school_admin','active')",[schoolA,admin,schoolB]);
  for(const [studentId,schoolId] of [[studentA,schoolA],[studentB,schoolB]])await pool.query("INSERT INTO students(id,school_id,first_name,last_name,email,email_lc,status) VALUES($1,$2,'Synthetic','Student',$3,$3,'active')",[studentId,schoolId,email(studentId!)]);
  // This failure is confined to the invoking transaction by a local GUC. No
  // provider or notification transport is called by this test suite.
  await pool.query(`CREATE OR REPLACE FUNCTION mailpilot_durability_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('app.mailpilot_fixture_fail',true)='on' THEN RAISE EXCEPTION 'synthetic outbox write failure'; END IF; RETURN NEW; END $$;
    DROP TRIGGER IF EXISTS mailpilot_durability_fixture_failure ON safety_notification_outbox;
    CREATE TRIGGER mailpilot_durability_fixture_failure BEFORE INSERT ON safety_notification_outbox FOR EACH ROW EXECUTE FUNCTION mailpilot_durability_fixture_failure();`);
});

after(async()=>{
  if(!pool)return;
  try{
    await pool.query("DROP TRIGGER IF EXISTS mailpilot_durability_fixture_failure ON safety_notification_outbox; DROP FUNCTION IF EXISTS mailpilot_durability_fixture_failure()");
    for(const table of ["email_alerts","mailpilot_watches","email_scan_log","audit_logs","student_timeline_events","student_safety_cases","school_memberships","product_licenses","students"])await pool.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`,[[schoolA,schoolB]]);
    await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])",[[schoolA,schoolB]]);await pool.query("DELETE FROM users WHERE id=$1",[admin]);
  }finally{
    const {sessionPool}=await import("../src/db.js");const {schedulerPool,schedulerLockPool}=await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(),sessionPool.end(),schedulerPool.end(),schedulerLockPool.end()]);
  }
});

test("an outbox failure rolls back raw email, shared alert, case and events; retry commits them together",async()=>{
  const messageId=randomUUID();
  await assert.rejects(scoped(schoolA,()=>database.transaction(async tx=>{
    await tx.execute(sql`SELECT set_config('app.mailpilot_fixture_fail','on',true)`);
    return persistence.persistMailpilotSafetyAlert(identity(messageId),payload(messageId),tx);
  })),error=>{
    let current:unknown=error;
    for(let depth=0;depth<6&&current;depth++){
      if(current instanceof Error&&current.message.includes("synthetic outbox write failure"))return true;
      current=(current as {cause?:unknown}).cause;
    }
    return false;
  });
  for(const table of ["email_alerts","student_safety_alerts","student_safety_cases","student_safety_case_events","safety_notification_outbox"]){
    const count=await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE school_id=$1`,[schoolA]);assert.equal(count.rows[0].count,0,`${table} must roll back`);
  }
  const result=await scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(messageId),payload(messageId)));assert.equal(result?.created,true);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM safety_notification_outbox WHERE school_id=$1",[schoolA])).rows[0].count,2);
});

test("concurrent identical mail and replay after review/closure never increment or reopen an incident",async()=>{
  const messageId=randomUUID();const results=await Promise.all(Array.from({length:4},()=>scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(messageId),payload(messageId)))));
  assert.equal(results.filter(row=>row?.created).length,1);assert.equal(new Set(results.map(row=>row?.alertId)).size,1);
  const result=results[0]!;assert.ok(result?.alertId&&result.caseId);
  await scoped(schoolA,()=>safety.reviewSafetyAlert({schoolId:schoolA,alertId:result.alertId!,actorId:admin,revision:0,action:"review"}));
  const revision=(await pool.query("SELECT revision FROM student_safety_cases WHERE id=$1",[result.caseId])).rows[0].revision;
  await scoped(schoolA,()=>safety.updateSafetyCase({schoolId:schoolA,caseId:result.caseId!,actorId:admin,revision,action:"close",note:"Synthetic review complete"}));
  const retained=(await pool.query("SELECT * FROM email_alerts WHERE school_id=$1 AND gmail_message_id=$2",[schoolA,messageId])).rows[0];
  assert.ok(retained.reviewed_at);assert.equal(retained.reviewed_by,admin);assert.equal(retained.review_status,null,"shared review must not invent a classification verdict");
  assert.equal(retained.safety_source_id,mailpilotSafetySourceId(identity(messageId)));
  const outboxBefore=(await pool.query("SELECT count(*)::int AS count FROM safety_notification_outbox WHERE school_id=$1",[schoolA])).rows[0].count;
  const retry=await scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(messageId),payload(messageId)));assert.equal(retry?.created,false);assert.equal(retry?.caseId,result.caseId);
  assert.equal((await pool.query("SELECT observation_count FROM student_safety_alerts WHERE id=$1",[result.alertId])).rows[0].observation_count,1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM student_safety_cases WHERE school_id=$1 AND status='open'",[schoolA])).rows[0].count,0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM safety_notification_outbox WHERE school_id=$1",[schoolA])).rows[0].count,outboxBefore);
  await pool.query("DELETE FROM email_alerts WHERE id=$1",[retained.id]);
  assert.equal((await scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(messageId),payload(messageId))))?.created,false);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM email_alerts WHERE school_id=$1 AND gmail_message_id=$2",[schoolA,messageId])).rows[0].count,0,"provider replay must not restore retained-away mail content");
});

test("legacy partial records are repaired; previously reviewed legacy mail remains closed to new incidents",async()=>{
  const messageId=randomUUID(),reviewedMessage=randomUUID();
  const legacy=await scoped(schoolA,()=>storage.createEmailAlert(payload(messageId)));assert.ok(legacy);
  const repaired=await scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(messageId)));assert.equal(repaired?.created,true);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM email_alerts WHERE school_id=$1 AND gmail_message_id=$2",[schoolA,messageId])).rows[0].count,1);
  await scoped(schoolA,()=>storage.createEmailAlert({...payload(reviewedMessage),reviewedAt:new Date(),reviewedBy:admin,reviewStatus:"dismissed"}));
  const reviewed=await scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(reviewedMessage)));assert.equal(reviewed?.created,false);assert.equal(reviewed?.caseId,null);
  const rawId=legacy!.id;
  // Legacy Safety Center source IDs used the raw email row ID. Review copying
  // remains scoped even for those pre-migration records.
  await pool.query("UPDATE student_safety_alerts SET source_id=$1 WHERE id=$2",[rawId,repaired!.alertId]);
  await scoped(schoolA,()=>safety.reviewSafetyAlert({schoolId:schoolA,alertId:repaired!.alertId!,actorId:admin,revision:0,action:"review"}));
  assert.ok((await pool.query("SELECT reviewed_at FROM email_alerts WHERE id=$1",[rawId])).rows[0].reviewed_at);
  await pool.query("UPDATE email_alerts SET safety_source_id=NULL,reviewed_at=NULL,reviewed_by=NULL WHERE id=$1",[rawId]);
  await pool.query(MAILPILOT_SAFETY_DURABILITY_SQL);
  const backfilled=(await pool.query("SELECT safety_source_id,reviewed_at,reviewed_by FROM email_alerts WHERE id=$1",[rawId])).rows[0];
  assert.equal(backfilled.safety_source_id,mailpilotSafetySourceId(identity(messageId)),"SQL migration and runtime must produce the identical stable source key");
  assert.ok(backfilled.reviewed_at);assert.equal(backfilled.reviewed_by,admin);
  assert.equal((await pool.query("SELECT source_id FROM student_safety_alerts WHERE id=$1",[repaired!.alertId])).rows[0].source_id,backfilled.safety_source_id);
  const caseId=repaired!.caseId;await pool.query("DELETE FROM student_safety_cases WHERE school_id=$1 AND id=$2",[schoolA,caseId]);
  const retained=(await pool.query("SELECT reviewed_at,review_status FROM email_alerts WHERE id=$1",[rawId])).rows[0];assert.ok(retained.reviewed_at);assert.equal(retained.review_status,null,"review retention eligibility survives case deletion");
});

test("same Gmail identifier stays independent across tenants and disabled or mismatched authority cannot write",async()=>{
  const messageId=randomUUID();
  const first=await scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(messageId),payload(messageId)));
  const other=await scoped(schoolB,()=>persistence.persistMailpilotSafetyAlert(identity(messageId,schoolB,studentB),payload(messageId,schoolB,studentB)));
  assert.ok(first?.created&&other?.created);assert.notEqual(first.alertId,other.alertId);
  await assert.rejects(scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(randomUUID(),schoolA,studentB),payload(randomUUID(),schoolA,studentB))),{code:"MAILPILOT_SOURCE_MISMATCH"});
  const wrong=randomUUID();await assert.rejects(scoped(schoolA,()=>persistence.persistMailpilotSafetyAlert(identity(wrong,schoolA,studentB),payload(wrong,schoolA,studentB))),{code:"MAILPILOT_STUDENT_CHANGED"});
  await pool.query("UPDATE schools SET classpilot_email_monitoring=false WHERE id=$1",[schoolB]);
  const blocked=randomUUID();await assert.rejects(scoped(schoolB,()=>persistence.persistMailpilotSafetyAlert(identity(blocked,schoolB,studentB),payload(blocked,schoolB,studentB))),{code:"MAILPILOT_MONITORING_DISABLED"});
  await pool.query("UPDATE schools SET classpilot_email_monitoring=true WHERE id=$1",[schoolB]);
  await pool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='CLASSPILOT'",[schoolB]);
  await assert.rejects(scoped(schoolB,()=>persistence.persistMailpilotSafetyAlert(identity(blocked,schoolB,studentB),payload(blocked,schoolB,studentB))),{code:"CLASSPILOT_NOT_ENTITLED"});
  await pool.query("UPDATE product_licenses SET status='active' WHERE school_id=$1 AND product='CLASSPILOT'",[schoolB]);
});

test("failed batches and watch renewal preserve the cursor, and stale concurrent completion cannot regress or skip it",async()=>{
  let watch=await scoped(schoolB,()=>storage.upsertMailpilotWatch({schoolId:schoolB,studentId:studentB,studentEmail:email(studentB),historyId:"100",expiresAt:new Date(Date.now()+86_400_000)}));
  await assert.rejects(scoped(schoolB,()=>processMailpilotHistoryBatch({messageIds:["failure"],processMessage:async()=>{throw new Error("synthetic processing failure");},recordStats:async()=>{},complete:()=>persistence.completeMailpilotHistoryCursor(watch,"200")})),{code:"MAILPILOT_MESSAGE_BATCH_INCOMPLETE"});
  await scoped(schoolB,()=>persistence.noteMailpilotProcessingFailure(watch,"MAILPILOT_MESSAGE_BATCH_INCOMPLETE"));
  let stored=(await pool.query("SELECT history_id,status,last_error FROM mailpilot_watches WHERE id=$1",[watch.id])).rows[0];assert.equal(stored.history_id,"100");assert.equal(stored.status,"active");
  await scoped(schoolB,()=>storage.upsertMailpilotWatch({...watch,historyId:"999",expiresAt:new Date(Date.now()+172_800_000)}));
  stored=(await pool.query("SELECT history_id,last_error FROM mailpilot_watches WHERE id=$1",[watch.id])).rows[0];assert.equal(stored.history_id,"100");assert.equal(stored.last_error,"MAILPILOT_MESSAGE_BATCH_INCOMPLETE");
  await scoped(schoolB,()=>persistence.completeMailpilotHistoryCursor(watch,"200"));
  await scoped(schoolB,()=>persistence.completeMailpilotHistoryCursor(watch,"150"));
  await assert.rejects(scoped(schoolB,()=>persistence.completeMailpilotHistoryCursor(watch,"250")),{code:"MAILPILOT_CURSOR_CHANGED"});
  stored=(await pool.query("SELECT history_id,last_error FROM mailpilot_watches WHERE id=$1",[watch.id])).rows[0];assert.equal(stored.history_id,"200");assert.equal(stored.last_error,null);
  watch=(await scoped(schoolB,()=>storage.getMailpilotWatchByEmail(email(studentB)))) as MailpilotWatch;
  await scoped(schoolB,()=>persistence.completeMailpilotHistoryCursor(watch,"250"));
  assert.equal((await pool.query("SELECT history_id FROM mailpilot_watches WHERE id=$1",[watch.id])).rows[0].history_id,"250");
});
