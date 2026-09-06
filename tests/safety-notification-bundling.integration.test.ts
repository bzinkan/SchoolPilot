import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { EmailSendOptions } from "../src/services/email.js";

process.env.SCHEDULER_ENABLED="true";
process.env.REDIS_URL="";
for (const name of ["DATABASE_URL","DATABASE_URL_PRIVILEGED"]) if(process.env[name]) assert(["localhost","127.0.0.1","::1"].includes(new URL(process.env[name]!).hostname),"Bundling integration tests require local fixture databases.");
const {pool,sessionPool}=await import("../src/db.js");
const {schedulerPool,schedulerLockPool}=await import("../src/services/schedulerDb.js");
const {runWithTenantContext}=await import("../src/middleware/tenantContext.js");
const {recordSafetyAlert}=await import("../src/services/safetyCenter.js");
const {dispatchSafetyNotifications}=await import("../src/services/safetyNotifications.js");
const {SAFETY_CENTER_SQL}=await import("../src/db/safetyCenterMigration.js");
const schoolIds:string[]=[],userIds:string[]=[];
before(async()=>{await pool.query(SAFETY_CENTER_SQL);});
after(async()=>{
  try {
    for(const table of ["audit_logs","student_safety_cases","settings","school_memberships","product_licenses","students"]) await pool.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`,[schoolIds]);
    await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])",[schoolIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])",[userIds]);
  } finally {await Promise.all([pool.end(),sessionPool.end(),schedulerPool.end(),schedulerLockPool.end()]);}
});

async function fixture(adminCount=1,studentCount=1) {
  const schoolId=randomUUID();schoolIds.push(schoolId);
  await pool.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,$2,'active',true,'active','America/New_York')",[schoolId,`Bundling fixture ${schoolId}`]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')",[schoolId]);
  const recipients:string[]=[];
  for(let index=0;index<adminCount;index++) {
    const id=randomUUID();userIds.push(id);const email=`${id}@example.invalid`;recipients.push(email);
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Administrator')",[id,email]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')",[schoolId,id,index%2?"school_admin":"admin"]);
  }
  const students:string[]=[];
  for(let index=0;index<studentCount;index++){const id=randomUUID();students.push(id);await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic',$3,'active')",[id,schoolId,`Student ${index}`]);}
  return {schoolId,recipients,students};
}
async function observations(schoolId:string,studentId:string,count:number) {
  const result:Array<{alertId:string;caseId:string}>=[];
  for(let index=0;index<count;index++) {
    const item=await runWithTenantContext({schoolId},()=>recordSafetyAlert({schoolId,studentId,sourceType:"browser",sourceId:randomUUID(),url:`https://bundle.example.invalid/${randomUUID()}`,safetyAlert:"violence",severity:"medium",classificationSource:"search",reason:"Synthetic bounded notification fixture."}));
    assert(item.alertId&&item.caseId);result.push({alertId:item.alertId,caseId:item.caseId});
  }
  return result;
}
async function initialRows(schoolId:string) {return (await pool.query("SELECT recipient,case_id,status,attempts,provider_message_id,submission_started_at FROM safety_notification_outbox WHERE school_id=$1 AND kind='initial'",[schoolId])).rows;}

test("41 already-pending alerts for one student and recipient produce one bounded email across two drains",async()=>{
  const data=await fixture(),alerts=await observations(data.schoolId,data.students[0]!,41),sent:EmailSendOptions[]=[];
  const send=async(message:EmailSendOptions)=>{sent.push(message);return {status:"sent" as const,providerMessageId:"cohort-one"};};
  await dispatchSafetyNotifications({providerConfigured:true,send});await dispatchSafetyNotifications({providerConfigured:true,send});
  assert.equal(sent.length,1);assert.equal(sent[0]!.to,data.recipients[0]);assert.match(sent[0]!.text!,/41 safety alert\(s\)/);
  assert.equal((sent[0]!.text!.match(/^• /gm)||[]).length,20);assert.match(sent[0]!.text!,/21 additional alert\(s\) are included/);assert(sent[0]!.text!.includes(`case=${alerts[0]!.caseId}`));
  const rows=await initialRows(data.schoolId);assert.equal(rows.length,41);assert(rows.every(row=>row.status==="sent"&&row.attempts===1&&row.provider_message_id==="cohort-one"&&row.submission_started_at));
});

test("interleaved report and recipient rows reserve complete bundles without extra emails on the next drain",async()=>{
  const data=await fixture(2,2),sent:EmailSendOptions[]=[];
  for(let index=0;index<12;index++)for(const studentId of data.students)await observations(data.schoolId,studentId,1);
  const send=async(message:EmailSendOptions)=>{sent.push(message);return {status:"sent" as const,providerMessageId:`interleaved-${sent.length}`};};
  await dispatchSafetyNotifications({providerConfigured:true,send});assert.equal(sent.length,4);
  await dispatchSafetyNotifications({providerConfigured:true,send});assert.equal(sent.length,4);
  for(const recipient of data.recipients)assert.equal(sent.filter(message=>message.to===recipient).length,2);
  const rows=await initialRows(data.schoolId);assert.equal(rows.length,48);assert(rows.every(row=>row.status==="sent"&&row.attempts===1));
  for(const recipient of data.recipients)for(const caseId of new Set(rows.map(row=>row.case_id)))assert.equal(new Set(rows.filter(row=>row.recipient===recipient&&row.case_id===caseId).map(row=>row.provider_message_id)).size,1);
});

test("concurrent workers reserve one complete cohort and preserve its in-flight outcome",async()=>{
  const data=await fixture(),alerts=await observations(data.schoolId,data.students[0]!,25),sent:EmailSendOptions[]=[];
  let start!:(value?:unknown)=>void,release!:(value?:unknown)=>void;
  const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const send=async(message:EmailSendOptions)=>{sent.push(message);start();await gate;return {status:"sent" as const,providerMessageId:"concurrent-one"};};
  const workers=Array.from({length:3},()=>dispatchSafetyNotifications({providerConfigured:true,send}));
  try {
    await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Worker did not submit the fixture cohort")),5000).unref())]);
    const inFlight=await initialRows(data.schoolId);assert.equal(inFlight.length,25);assert(inFlight.every(row=>row.status==="sending"&&row.submission_started_at));
    assert(sent[0]!.text!.includes(`case=${alerts[0]!.caseId}`));
  } finally {release();await Promise.all(workers);}
  await dispatchSafetyNotifications({providerConfigured:true,send});assert.equal(sent.length,1);
  assert((await initialRows(data.schoolId)).every(row=>row.status==="sent"&&row.attempts===1&&row.provider_message_id==="concurrent-one"));
});

test("a locked pending row defers its whole bundle instead of sending the unlocked remainder",async()=>{
  const data=await fixture(),alerts=await observations(data.schoolId,data.students[0]!,23),client=await pool.connect();let calls=0;
  const send=async()=>{calls++;return {status:"sent" as const,providerMessageId:"after-unlock"};};
  try {
    await client.query("BEGIN");await client.query("SELECT id FROM safety_notification_outbox WHERE school_id=$1 AND alert_id=$2 AND kind='initial' FOR UPDATE",[data.schoolId,alerts[12]!.alertId]);
    await dispatchSafetyNotifications({providerConfigured:true,send});assert.equal(calls,0);assert((await initialRows(data.schoolId)).every(row=>row.status==="pending"));
  } finally {await client.query("ROLLBACK");client.release();}
  await dispatchSafetyNotifications({providerConfigured:true,send});assert.equal(calls,1);assert((await initialRows(data.schoolId)).every(row=>row.status==="sent"));
});

test("mixed retry attempts share one transport but retain their individual terminal/retry policy",async()=>{
  const data=await fixture(),alerts=await observations(data.schoolId,data.students[0]!,24);let calls=0;
  await pool.query("UPDATE safety_notification_outbox SET attempts=4 WHERE school_id=$1 AND kind='initial' AND alert_id=$2",[data.schoolId,alerts[0]!.alertId]);
  await dispatchSafetyNotifications({providerConfigured:true,send:async()=>{calls++;return {status:"transient_failure",error:"FIXTURE_RETRY"};}});assert.equal(calls,1);
  const rows=await initialRows(data.schoolId);assert.equal(rows.filter(row=>row.status==="failed"&&row.attempts===5).length,1);assert.equal(rows.filter(row=>row.status==="pending"&&row.attempts===1).length,23);
  await pool.query("UPDATE safety_notification_outbox SET due_at=now()-interval '1 second' WHERE school_id=$1 AND kind='initial' AND status='pending'",[data.schoolId]);
  await dispatchSafetyNotifications({providerConfigured:true,send:async()=>{calls++;return {status:"unknown",error:"FIXTURE_UNKNOWN"};}});
  await dispatchSafetyNotifications({providerConfigured:true,send:async()=>{calls++;return {status:"sent"};}});assert.equal(calls,2);
  assert.equal((await initialRows(data.schoolId)).filter(row=>row.status==="unknown"&&row.attempts===2).length,23);
});
