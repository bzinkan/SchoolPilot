import { before,after,describe,it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.REDIS_URL="";
const schoolId=randomUUID(),otherSchoolId=randomUUID(),studentId=randomUUID(),teacherId=randomUUID(),otherTeacherId=randomUUID(),groupId=randomUUID(),sessionId=randomUUID(),contextId=randomUUID();
const now=new Date("2026-09-01T18:00:00Z");
let pool:import("pg").Pool, database:typeof import("../src/db.js").default;
let tenant:typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let history:typeof import("../src/services/classpilotBrowsingHistory.js");
const scoped=<T>(fn:()=>Promise<T>)=>tenant({schoolId},fn);
const request={schoolId,studentId,actorId:teacherId,role:"admin" as const,startDate:"2026-09-01",endDate:"2026-09-01",now};
before(async()=>{
  assert.ok(["localhost","127.0.0.1","::1"].includes(new URL(process.env.DATABASE_URL||"").hostname),"History integration tests require local fixtures.");
  const module=await import("../src/db.js");pool=module.pool;database=module.default;
  ({runWithTenantContext:tenant}=await import("../src/middleware/tenantContext.js"));history=await import("../src/services/classpilotBrowsingHistory.js");
  await pool.query("INSERT INTO schools(id,name,school_timezone) VALUES($1,'History fixture','America/New_York'),($2,'Other history fixture','America/New_York')",[schoolId,otherSchoolId]);
  await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'History','Teacher'),($3,$4,'Coverage','Teacher')",[teacherId,`${teacherId}@example.edu`,otherTeacherId,`${otherTeacherId}@example.edu`]);
  await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active'),($1,$3,'teacher','active')",[schoolId,teacherId,otherTeacherId]);
  await scoped(async()=>{const {sql}=await import("drizzle-orm");
    await database.execute(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,retention_hours,school_timezone) VALUES(${schoolId},'History fixture','fixture-key','720','America/Chicago')`);
    await database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name) VALUES(${studentId},${schoolId},'History','Student')`);
    await database.execute(sql`INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES(${groupId},${schoolId},${otherTeacherId},'Reassigned class','admin_class','active')`);
    await database.execute(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,session_mode,start_time,end_time,roster_snapshot_completed_at) VALUES(${sessionId},${schoolId},${groupId},${teacherId},'live','2026-09-01 13:00:00','2026-09-01 14:00:00','2026-09-01 13:00:00Z')`);
    await database.execute(sql`INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role,captured_at) VALUES(${schoolId},${sessionId},${teacherId},'primary','2026-09-01 13:00:00Z')`);
    await database.execute(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES(${schoolId},${sessionId},${groupId},${studentId},'2026-09-01 13:00:00Z')`);
    await database.execute(sql`INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,status,assigned_staff_id,created_by,starts_at,ends_at,ended_at) VALUES(${contextId},${schoolId},'coverage','Coverage','ended',${otherTeacherId},${otherTeacherId},'2026-09-01 13:15:00','2026-09-01 13:30:00','2026-09-01 13:30:00')`);
    await database.execute(sql`INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by,assigned_at,released_at) VALUES(${schoolId},${contextId},${studentId},${otherTeacherId},'2026-09-01 13:15:00','2026-09-01 13:30:00')`);
    for(const [suffix,timestamp] of [["before","2026-09-01 12:59:59"],["one","2026-09-01 13:10:00.123456"],["two","2026-09-01 13:10:05.123456"],["covered","2026-09-01 13:20:00"],["after","2026-09-01 13:40:00"],["end","2026-09-01 14:00:00"]])await database.execute(sql`INSERT INTO heartbeats(id,school_id,student_id,device_id,active_tab_title,active_tab_url,timestamp) VALUES(${studentId+suffix},${schoolId},${studentId},'history-device','Fixture observation','https://example.edu',${timestamp}::timestamp)`);
    await database.execute(sql`INSERT INTO daily_usage(school_id,student_id,date,total_seconds,top_domains) VALUES(${schoolId},${studentId},'2026-09-01',90,'[{"domain":"example.edu","seconds":90}]'::jsonb)`);
  });
});
after(async()=>{
  if(!pool)return;await tenant({isSuper:true},async()=>{const {sql}=await import("drizzle-orm");for(const table of ["heartbeats","daily_usage","classpilot_supervision_students","classpilot_supervision_contexts","classpilot_session_usage","classpilot_session_staff","classpilot_session_students","classpilot_session_reports","teaching_sessions","groups","students","settings"])await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${schoolId}`);});
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1",[schoolId]);await pool.query("DELETE FROM users WHERE id IN($1,$2)",[teacherId,otherTeacherId]);await pool.query("DELETE FROM schools WHERE id IN($1,$2)",[schoolId,otherSchoolId]);const {sessionPool}=await import("../src/db.js");await Promise.all([pool.end(),sessionPool.end()]);
});
describe("Student browsing history authorization and pagination",()=>{
  it("paginates stable microsecond timestamps without device IDs or invented tail durations",async()=>{
    let cursor:string|null=null;const seen:string[]=[];let pages=0;do{const page=await scoped(()=>history.getStudentBrowsingHistory({...request,limit:2,...(cursor?{cursor}:{})}));seen.push(...page.entries.map(row=>row.id));assert(page.entries.every(row=>!("deviceId" in row)));cursor=page.nextCursor;pages++;assert(pages<10);}while(cursor);
    assert.equal(seen.length,6);assert.equal(new Set(seen).size,6);
    const all=await scoped(()=>history.getStudentBrowsingHistory(request));assert.equal(all.timeZone,"America/New_York","The canonical school timezone wins over legacy settings");assert.equal(all.entries.find(row=>row.id===studentId+"one")?.estimatedSeconds,5);assert.equal(all.entries.find(row=>row.id===studentId+"end")?.estimatedSeconds,0);
  });
  it("uses frozen historical staff after reassignment and removes another teacher's supervision",async()=>{
    const owner=await scoped(()=>history.getStudentBrowsingHistory({...request,role:"teacher"}));assert.deepEqual(owner.entries.map(row=>row.id),["after","two","one"].map(suffix=>studentId+suffix));
    const coverage=await scoped(()=>history.getStudentBrowsingHistory({...request,role:"teacher",actorId:otherTeacherId}));assert.deepEqual(coverage.entries.map(row=>row.id),[studentId+"covered"]);
    const {sql}=await import("drizzle-orm");await scoped(()=>database.execute(sql`UPDATE teaching_sessions SET session_mode='scheduled_report' WHERE id=${sessionId}`));
    await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...request,role:"teacher"})),{code:"HISTORY_DENIED"});
    await scoped(()=>database.execute(sql`UPDATE teaching_sessions SET session_mode='live' WHERE id=${sessionId}`));
  });
  it("distinguishes retention expiry, empty days and cross-school denial without teacher daily totals",async()=>{
    const expired=await scoped(()=>history.getStudentBrowsingHistory({...request,startDate:"2026-01-01",endDate:"2026-01-01"}));assert.equal(expired.state,"expired");
    const empty=await scoped(()=>history.getStudentBrowsingHistory({...request,startDate:"2026-08-31",endDate:"2026-08-31"}));assert.equal(empty.state,"empty");
    await assert.rejects(tenant({schoolId:otherSchoolId},()=>history.getStudentBrowsingHistory({...request,schoolId:otherSchoolId})),{code:"HISTORY_DENIED"});
    const admin=await scoped(()=>history.getStudentBrowsingDomains(request));assert.equal(admin.days[0]?.domains[0]?.seconds,90);
    const teacher=await scoped(()=>history.getStudentBrowsingDomains({...request,role:"teacher"}));assert.deepEqual(teacher.days,[]);assert.equal(teacher.state,"unavailable");
  });
  it("never releases whole-session domains across delegated gaps, late captures or clipped retention",async()=>{
    const {sql}=await import("drizzle-orm");
    await scoped(()=>database.execute(sql`INSERT INTO classpilot_session_usage(school_id,teaching_session_id,group_id,student_id,local_date,total_seconds,top_domains) VALUES(${schoolId},${sessionId},${groupId},${studentId},'2026-09-01',3600,'[{"domain":"excluded-domain.example","seconds":3600}]'::jsonb)`));
    const gap=await scoped(()=>history.getStudentBrowsingDomains({...request,role:"teacher"}));assert.deepEqual(gap.days,[]);assert.equal(gap.partial,true);
    try{
      await scoped(()=>database.execute(sql`UPDATE classpilot_supervision_students SET assigned_at='2026-09-01 14:15:00',released_at='2026-09-01 14:30:00' WHERE context_id=${contextId}`));
      await scoped(()=>database.execute(sql`UPDATE classpilot_supervision_contexts SET starts_at='2026-09-01 14:15:00',ends_at='2026-09-01 14:30:00',ended_at='2026-09-01 14:30:00' WHERE id=${contextId}`));
      const full=await scoped(()=>history.getStudentBrowsingDomains({...request,role:"teacher"}));assert.equal(full.days[0]?.domains[0]?.domain,"excluded-domain.example");
      await scoped(()=>database.execute(sql`UPDATE classpilot_session_students SET captured_at='2026-09-01 13:10:00Z' WHERE teaching_session_id=${sessionId}`));
      const lateRoster=await scoped(()=>history.getStudentBrowsingDomains({...request,role:"teacher"}));assert.deepEqual(lateRoster.days,[]);assert.equal(lateRoster.partial,true);
      await scoped(()=>database.execute(sql`UPDATE classpilot_session_students SET captured_at='2026-09-01 13:00:00Z' WHERE teaching_session_id=${sessionId}`));
      await scoped(()=>database.execute(sql`UPDATE classpilot_session_staff SET captured_at='2026-09-01 13:05:00Z' WHERE teaching_session_id=${sessionId}`));
      const lateStaff=await scoped(()=>history.getStudentBrowsingDomains({...request,role:"teacher"}));assert.deepEqual(lateStaff.days,[]);
      await scoped(()=>database.execute(sql`UPDATE classpilot_session_staff SET captured_at='2026-09-01 13:00:00Z' WHERE teaching_session_id=${sessionId}`));
      const retainedSlice=await scoped(()=>history.getStudentBrowsingDomains({...request,role:"teacher",now:new Date('2026-10-01T13:15:00Z')}));assert.deepEqual(retainedSlice.days,[]);assert.equal(retainedSlice.partial,true);
    }finally{
      await scoped(()=>database.execute(sql`UPDATE classpilot_session_students SET captured_at='2026-09-01 13:00:00Z' WHERE teaching_session_id=${sessionId}`));
      await scoped(()=>database.execute(sql`UPDATE classpilot_session_staff SET captured_at='2026-09-01 13:00:00Z' WHERE teaching_session_id=${sessionId}`));
      await scoped(()=>database.execute(sql`UPDATE classpilot_supervision_students SET assigned_at='2026-09-01 13:15:00',released_at='2026-09-01 13:30:00' WHERE context_id=${contextId}`));
      await scoped(()=>database.execute(sql`UPDATE classpilot_supervision_contexts SET starts_at='2026-09-01 13:15:00',ends_at='2026-09-01 13:30:00',ended_at='2026-09-01 13:30:00' WHERE id=${contextId}`));
    }
  });
  it("keeps a live session cursor stable across real advancing request time",async()=>{
    const {sql}=await import("drizzle-orm");const liveId=randomUUID();const started=new Date(Date.now()-30000).toISOString();
    await scoped(async()=>{
      await database.execute(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,session_mode,start_time,roster_snapshot_completed_at) VALUES(${liveId},${schoolId},${groupId},${teacherId},'live',${started}::timestamp,${started}::timestamptz)`);
      await database.execute(sql`INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role,captured_at) VALUES(${schoolId},${liveId},${teacherId},'primary',${started}::timestamptz)`);
      await database.execute(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES(${schoolId},${liveId},${groupId},${studentId},${started}::timestamptz)`);
      for(const offset of [10,15,20])await database.execute(sql`INSERT INTO heartbeats(id,school_id,student_id,device_id,active_tab_title,active_tab_url,timestamp) VALUES(${liveId+offset},${schoolId},${studentId},'history-live-device','Live fixture','https://example.edu',${new Date(Date.parse(started)+offset*1000).toISOString()}::timestamp)`);
    });
    const liveRequest={schoolId,studentId,actorId:teacherId,role:"teacher" as const};
    const first=await scoped(()=>history.getStudentBrowsingHistory({...liveRequest,limit:1}));assert(first.nextCursor);
    await new Promise(resolve=>setTimeout(resolve,30));
    await scoped(()=>database.execute(sql`INSERT INTO heartbeats(id,school_id,student_id,device_id,active_tab_title,active_tab_url,timestamp) VALUES(${liveId+'new'},${schoolId},${studentId},'history-live-device','Newer fixture','https://example.edu',clock_timestamp() AT TIME ZONE 'UTC')`));
    const second=await scoped(()=>history.getStudentBrowsingHistory({...liveRequest,limit:2,cursor:first.nextCursor}));
    assert.equal(second.asOf,first.asOf);assert.equal(second.startDate,first.startDate);assert(second.entries.every(row=>row.id!==liveId+'new'));assert(second.entries.some(row=>row.id===liveId+'10'));
  });
});
