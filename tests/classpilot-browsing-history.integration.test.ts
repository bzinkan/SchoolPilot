import { before,after,describe,it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CLASSPILOT_SUPERVISION_REPORTS_SQL } from "../src/db/classpilotSupervisionReportsMigration.js";
process.env.REDIS_URL="";
const schoolId=randomUUID(),otherSchoolId=randomUUID(),studentId=randomUUID(),teacherId=randomUUID(),otherTeacherId=randomUUID(),groupId=randomUUID(),sessionId=randomUUID(),contextId=randomUUID();
const now=new Date("2026-09-01T18:00:00Z");
let pool:import("pg").Pool, database:typeof import("../src/db.js").default;
let tenant:typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let history:typeof import("../src/services/classpilotBrowsingHistory.js");
let lookup:typeof import("../src/services/classpilotBrowsingHistoryLookup.js");
const scoped=<T>(fn:()=>Promise<T>)=>tenant({schoolId},fn);
const request={schoolId,studentId,actorId:teacherId,role:"admin" as const,startDate:"2026-09-01",endDate:"2026-09-01",now};
before(async()=>{
  assert.ok(["localhost","127.0.0.1","::1"].includes(new URL(process.env.DATABASE_URL||"").hostname),"History integration tests require local fixtures.");
  const module=await import("../src/db.js");pool=module.pool;database=module.default;
  ({runWithTenantContext:tenant}=await import("../src/middleware/tenantContext.js"));history=await import("../src/services/classpilotBrowsingHistory.js");
  lookup=await import("../src/services/classpilotBrowsingHistoryLookup.js");
  // Drizzle-only CI omits these migration-owned tables. Install the exact
  // reporting contract before fixtures and cleanup, independently of test order.
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(connectionString);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(connectionString).hostname));
  const fixture = new pg.Client({ connectionString });
  await fixture.connect();
  try {
    if (!(await fixture.query("SELECT to_regclass('public.classpilot_supervision_report_segments') AS table_name")).rows[0].table_name) {
      await fixture.query(CLASSPILOT_SUPERVISION_REPORTS_SQL);
      const role = (await pool.query("SELECT current_user AS role")).rows[0].role;
      assert.match(role, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
      await fixture.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON classpilot_supervision_report_segments,classpilot_supervision_student_reports,classpilot_supervision_summary_deliveries TO "${role}"`);
    }
  } finally { await fixture.end(); }
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
  if(!pool)return;await tenant({isSuper:true},async()=>{const {sql}=await import("drizzle-orm");await database.execute(sql`DELETE FROM group_students WHERE group_id IN(SELECT id FROM groups WHERE school_id=${schoolId})`);for(const table of ["heartbeats","daily_usage","classpilot_supervision_student_reports","classpilot_supervision_report_segments","classpilot_supervision_students","classpilot_supervision_contexts","classpilot_session_usage","classpilot_session_staff","classpilot_session_students","classpilot_session_reports","teaching_sessions","groups","students","settings"])await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${schoolId}`);await database.execute(sql`DELETE FROM students WHERE school_id=${otherSchoolId}`);});
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1",[schoolId]);await pool.query("DELETE FROM users WHERE id IN($1,$2)",[teacherId,otherTeacherId]);await pool.query("DELETE FROM schools WHERE id IN($1,$2)",[schoolId,otherSchoolId]);const {sessionPool}=await import("../src/db.js");await Promise.all([pool.end(),sessionPool.end()]);
});

describe("Offline student discovery for browsing history", () => {
  const ids = {
    inactive: randomUUID(), currentOnly: randomUUID(), unattended: randomUUID(),
    historical: randomUUID(), delegated: randomUUID(), ownSupervision: randomUUID(),
    expired: randomUUID(), foreign: randomUUID(), tenureStudent: randomUUID(),
    ownGroup: randomUUID(), unattendedSession: randomUUID(), expiredSession: randomUUID(),
    delegatedContext: randomUUID(), ownContext: randomUUID(), tenureContext: randomUUID(), segment: randomUUID(),
  };
  const weekend = new Date("2026-09-05T18:00:00Z");
  const searchRequest = { schoolId, actorId: teacherId, role: "teacher" as const, now: weekend, search: "Lookup" };

  before(async () => {
    const { sql } = await import("drizzle-orm");
    await scoped(async () => {
      for (const [key, label] of Object.entries({ inactive: "Inactive", currentOnly: "Current only", unattended: "Unattended", historical: "Historical", delegated: "Delegated", ownSupervision: "Supervision", expired: "Expired", tenureStudent: "Tenure" })) {
        const id = ids[key as keyof typeof ids];
        await database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name,email,status) VALUES(${id},${schoolId},'Lookup',${label},${`${id}@lookup.example.edu`},${key === "inactive" || key === "historical" ? "inactive" : "active"})`);
      }
      await database.execute(sql`INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES(${ids.ownGroup},${schoolId},${teacherId},'Current assignments do not authorize history','admin_class','active')`);
      await database.execute(sql`INSERT INTO group_students(group_id,student_id) VALUES(${ids.ownGroup},${ids.currentOnly})`);
      for (const id of [ids.historical, ids.delegated]) {
        await database.execute(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES(${schoolId},${sessionId},${groupId},${id},'2026-09-01 13:00:00Z')`);
      }
      for (const [id, student, date, mode] of [
        [ids.unattendedSession, ids.unattended, "2026-09-01", "scheduled_report"],
        [ids.expiredSession, ids.expired, "2026-07-01", "live"],
      ]) {
        await database.execute(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,session_mode,start_time,end_time,roster_snapshot_completed_at) VALUES(${id},${schoolId},${ids.ownGroup},${teacherId},${mode},${date + " 13:00:00"}::timestamp,${date + " 14:00:00"}::timestamp,${date + " 13:00:00Z"}::timestamptz)`);
        await database.execute(sql`INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role,captured_at) VALUES(${schoolId},${id},${teacherId},'primary',${date + " 13:00:00Z"}::timestamptz)`);
        await database.execute(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES(${schoolId},${id},${ids.ownGroup},${student},${date + " 13:00:00Z"}::timestamptz)`);
      }
      for (const [id, student, staff] of [
        [ids.delegatedContext, ids.delegated, otherTeacherId],
        [ids.ownContext, ids.ownSupervision, teacherId],
        [ids.tenureContext, ids.tenureStudent, otherTeacherId],
      ]) {
        await database.execute(sql`INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,status,assigned_staff_id,created_by,starts_at,ends_at,ended_at) VALUES(${id},${schoolId},'coverage','Lookup coverage','ended',${staff},${staff},'2026-09-01 13:00:00','2026-09-01 14:00:00','2026-09-01 14:00:00')`);
        await database.execute(sql`INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by,assigned_at,released_at) VALUES(${schoolId},${id},${student},${staff},'2026-09-01 13:00:00','2026-09-01 14:00:00')`);
      }
    });
    await tenant({ schoolId: otherSchoolId }, () => database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name) VALUES(${ids.foreign},${otherSchoolId},'Lookup','Foreign')`));
  });

  it("finds inactive/offline school students with bounded stable pagination and literal name/email search", async () => {
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const page = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, role: "admin", limit: 2, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.students.map(student => student.studentId));
      assert(page.students.every(student => Object.keys(student).sort().join(",") === "email,name,studentId"));
      cursor = page.nextCursor;
      assert(seen.length < 20);
    } while (cursor);
    assert.equal(seen.length, 8);
    assert.equal(new Set(seen).size, 8);
    assert(seen.includes(ids.inactive));
    assert(!seen.includes(ids.foreign));
    const byEmail = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, role: "school_admin", search: ids.inactive.toUpperCase() + "@lookup.example.edu" }));
    assert.deepEqual(byEmail.students.map(student => student.studentId), [ids.inactive]);
    const literal = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, role: "admin", search: "%" }));
    assert.deepEqual(literal.students, []);
  });

  it("uses retained frozen staff and own supervision while excluding current-only, unattended and fully delegated students", async () => {
    const page = await scoped(() => lookup.findStudentBrowsingHistory(searchRequest));
    assert.deepEqual(new Set(page.students.map(student => student.studentId)), new Set([ids.historical, ids.ownSupervision]));
    const first = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, limit: 1 }));
    assert(first.nextCursor);
    await assert.rejects(scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, actorId: otherTeacherId, cursor: first.nextCursor })), { code: "HISTORY_CURSOR_INVALID" });
    const { sql } = await import("drizzle-orm");
    try {
      await scoped(() => database.execute(sql`UPDATE settings SET retention_hours='24' WHERE school_id=${schoolId}`));
      const shortened = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, cursor: first.nextCursor }));
      assert.deepEqual(shortened.students, [], "Every next page reapplies current retention");
    } finally {
      await scoped(() => database.execute(sql`UPDATE settings SET retention_hours='720' WHERE school_id=${schoolId}`));
    }
    const foreign = await tenant({ schoolId: otherSchoolId }, () => lookup.findStudentBrowsingHistory({ ...searchRequest, schoolId: otherSchoolId }));
    assert.deepEqual(foreign.students, []);
  });

  it("keeps recorded staff tenures and expired tombstones authoritative after supervision reassignment", async () => {
    const previous = process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM;
    const { sql } = await import("drizzle-orm");
    process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = "2026-08-01T00:00:00Z";
    try {
      await scoped(async () => {
        await database.execute(sql`INSERT INTO classpilot_supervision_report_segments(id,school_id,context_id,staff_id,context_type,window_start,window_end,state,timezone,settle_at,expires_at) VALUES(${ids.segment},${schoolId},${ids.tenureContext},${teacherId},'coverage','2026-09-01 13:00:00Z','2026-09-01 13:30:00Z','ready','America/New_York','2026-09-01 13:30:30Z','2026-10-01 13:30:00Z')`);
        await database.execute(sql`INSERT INTO classpilot_supervision_student_reports(school_id,report_id,student_id,student_name_snapshot,participation_intervals) VALUES(${schoolId},${ids.segment},${ids.tenureStudent},'Lookup Tenure',${JSON.stringify([{ assignmentId: "tenure-assignment", start: "2026-09-01T13:10:00Z", end: "2026-09-01T13:20:00Z" }])}::jsonb)`);
      });
      const own = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, search: "Lookup Tenure" }));
      assert.deepEqual(own.students.map(student => student.studentId), [ids.tenureStudent]);
      const replacement = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, search: "Lookup Tenure", actorId: otherTeacherId }));
      assert.deepEqual(replacement.students, []);
      await scoped(() => database.execute(sql`UPDATE classpilot_supervision_report_segments SET state='expired',detail_expired_at=${weekend.toISOString()}::timestamptz WHERE id=${ids.segment}`));
      await scoped(() => database.execute(sql`UPDATE classpilot_supervision_contexts SET assigned_staff_id=${teacherId} WHERE id=${ids.tenureContext}`));
      const expired = await scoped(() => lookup.findStudentBrowsingHistory({ ...searchRequest, search: "Lookup Tenure" }));
      assert.deepEqual(expired.students, [], "A retained tombstone prevents falling back to the current owner");
    } finally {
      if (previous === undefined) delete process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM;
      else process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM = previous;
    }
  });
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
    const ownerPages=await scoped(()=>history.getStudentBrowsingHistory({...request,role:"teacher",view:"pages"}));assert.deepEqual(ownerPages.entries.map(row=>row.id),owner.entries.map(row=>row.id));
    const coveragePages=await scoped(()=>history.getStudentBrowsingHistory({...request,role:"teacher",actorId:otherTeacherId,view:"pages"}));assert.deepEqual(coveragePages.entries.map(row=>row.id),coverage.entries.map(row=>row.id));
    const {sql}=await import("drizzle-orm");await scoped(()=>database.execute(sql`UPDATE teaching_sessions SET session_mode='scheduled_report' WHERE id=${sessionId}`));
    await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...request,role:"teacher"})),{code:"HISTORY_DENIED"});
    await scoped(()=>database.execute(sql`UPDATE teaching_sessions SET session_mode='live' WHERE id=${sessionId}`));
  });
  it("distinguishes retention expiry, empty days and cross-school denial without teacher daily totals",async()=>{
    const expired=await scoped(()=>history.getStudentBrowsingHistory({...request,startDate:"2026-01-01",endDate:"2026-01-01"}));assert.equal(expired.state,"expired");
    const empty=await scoped(()=>history.getStudentBrowsingHistory({...request,startDate:"2026-08-31",endDate:"2026-08-31"}));assert.equal(empty.state,"empty");
    await assert.rejects(tenant({schoolId:otherSchoolId},()=>history.getStudentBrowsingHistory({...request,schoolId:otherSchoolId})),{code:"HISTORY_DENIED"});
    await assert.rejects(tenant({schoolId:otherSchoolId},()=>history.getStudentBrowsingHistory({...request,schoolId:otherSchoolId,view:"pages"})),{code:"HISTORY_DENIED"});
    const admin=await scoped(()=>history.getStudentBrowsingDomains(request));assert.equal(admin.days[0]?.domains[0]?.seconds,90);
    const teacher=await scoped(()=>history.getStudentBrowsingDomains({...request,role:"teacher"}));assert.deepEqual(teacher.days,[]);assert.equal(teacher.state,"unavailable");
  });
  it("filters before pagination without losing title-only pages or extending durations across unknown observations",async()=>{
    const {sql}=await import("drizzle-orm");const pageStudentId=randomUUID();
    const pageRequest={...request,studentId:pageStudentId};
    const observations:Array<{id:string;at:string;title:string;url:string|null}>=[
      {id:"first",at:"13:00:00.123456",title:"First page",url:"https://first.example.edu"},
      {id:"unknown-gap",at:"13:00:10.123456",title:"Unknown",url:null},
      {id:"second",at:"13:00:50.123456",title:"Second page",url:"https://second.example.edu"},
      {id:"signing-in",at:"13:01:00",title:"Signing in",url:null},
      {id:"assigned",at:"13:01:05",title:"Assigned page",url:null},
      {id:"internal",at:"13:01:10",title:"Unknown",url:"chrome://newtab/"},
      {id:"whitespace",at:"13:01:20",title:"  Unknown \t",url:" \t\n"},
      {id:"untitled",at:"13:01:30",title:"Unknown",url:"https://untitled.example.edu"},
      {id:"blank-title",at:"13:01:40",title:" \t\n",url:null},
      {id:"no-details",at:"13:01:50",title:" No Page Details ",url:null},
      {id:"unavailable",at:"13:02:00",title:"PAGE DETAILS UNAVAILABLE",url:null},
      {id:"generic",at:"13:02:10",title:"Browser observation",url:null},
      {id:"empty-title",at:"13:02:20",title:"",url:null},
    ];
    try{
      await scoped(async()=>{
        await database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name) VALUES(${pageStudentId},${schoolId},'Page','Fixture')`);
        for(const row of observations)await database.execute(sql`INSERT INTO heartbeats(id,school_id,student_id,device_id,active_tab_title,active_tab_url,timestamp) VALUES(${pageStudentId+row.id},${schoolId},${pageStudentId},'page-fixture-device',${row.title},${row.url},${'2026-09-01 '+row.at}::timestamp)`);
        await database.execute(sql`INSERT INTO heartbeats(id,school_id,student_id,device_id,active_tab_title,timestamp) SELECT ${pageStudentId}||'presence-'||n,${schoolId},${pageStudentId},'page-fixture-device','Unknown','2026-09-01 14:00:00'::timestamp+n*interval '10 seconds' FROM generate_series(1,125) n`);
      });
      const raw=await scoped(()=>history.getStudentBrowsingHistory(pageRequest));
      assert.equal(raw.view,"all");assert.equal(raw.entries.length,100);assert(raw.hasMore);assert(raw.entries.every(row=>row.activeTabUrl===null&&row.activeTabTitle==="Unknown"));
      const explicitAll=await scoped(()=>history.getStudentBrowsingHistory({...pageRequest,view:"all"}));assert.deepEqual(explicitAll.entries,raw.entries);
      let cursor:string|null=null;const seen:string[]=[];let firstCursor:string|null=null;let firstEstimate:number|undefined;let pages=0;
      do{
        const page=await scoped(()=>history.getStudentBrowsingHistory({...pageRequest,view:"pages",limit:2,...(cursor?{cursor}:{})}));
        assert.equal(page.view,"pages");assert.equal(page.state,"available");assert(page.entries.every(row=>!("deviceId" in row)));
        seen.push(...page.entries.map(row=>row.id));
        firstEstimate=page.entries.find(row=>row.id===pageStudentId+"first")?.estimatedSeconds??firstEstimate;
        cursor=page.nextCursor;if(!pages)firstCursor=cursor;pages++;assert(pages<5);
      }while(cursor);
      assert.deepEqual(seen,["untitled","internal","assigned","signing-in","second","first"].map(id=>pageStudentId+id));
      assert.equal(firstEstimate,10,"The hidden unknown heartbeat ends the previous page's estimate");
      assert(firstCursor);assert(raw.nextCursor);
      await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...pageRequest,view:"all",cursor:firstCursor})),{code:"HISTORY_CURSOR_INVALID"});
      await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...pageRequest,view:"pages",cursor:raw.nextCursor})),{code:"HISTORY_CURSOR_INVALID"});
      const {encodeHistoryCursor,historyScopeHash}=await import("../src/services/classpilotBrowsingHistoryModel.js");
      const legacyCursor=encodeHistoryCursor({timestamp:raw.entries.at(-1)!.timestamp,id:raw.entries.at(-1)!.id,anchor:raw.asOf,scope:historyScopeHash([schoolId,pageStudentId,teacherId,"admin",request.startDate,request.endDate]),startDate:request.startDate,endDate:request.endDate});
      const continued=await scoped(()=>history.getStudentBrowsingHistory({...pageRequest,view:"all",cursor:legacyCursor}));assert(continued.entries.length>0);
    }finally{
      await scoped(async()=>{
        await database.execute(sql`DELETE FROM heartbeats WHERE school_id=${schoolId} AND student_id=${pageStudentId}`);
        await database.execute(sql`DELETE FROM students WHERE school_id=${schoolId} AND id=${pageStudentId}`);
      });
    }
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

describe("Consecutive browsing history visits",()=>{
  type Observation={at:string;url?:string|null;title?:string;device?:string;category?:string|null;contentCategory?:string|null;intent?:string|null;locked?:boolean;camera?:boolean};
  const start=Date.parse("2026-09-01T13:00:00Z");
  const at=(seconds:number)=>new Date(start+seconds*1000).toISOString();
  async function fixture(observations:Observation[]){
    const {sql}=await import("drizzle-orm"),id=randomUUID();
    await scoped(async()=>{
      await database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name) VALUES(${id},${schoolId},'Visit','Fixture')`);
      await database.execute(sql`INSERT INTO heartbeats(id,school_id,student_id,device_id,active_tab_title,active_tab_url,timestamp,ai_category,content_category,teacher_intent_source,screen_locked,camera_active) VALUES ${sql.join(observations.map((row,index)=>sql`(${id+'-'+String(index).padStart(4,'0')},${schoolId},${id},${row.device||'visit-device'},${row.title??'Visit page'},${row.url===undefined?'https://example.edu/page':row.url},${row.at}::timestamp,${row.category??null},${row.contentCategory??null},${row.intent??null},${row.locked??false},${row.camera??false})`),sql`,`)}`);
    });
    return {...request,studentId:id,grouping:"visits",view:"pages"};
  }

  it("returns a long same-page stay as one complete visit across page limits and ignores title updates",async()=>{
    const input=await fixture([...Array.from({length:130},(_,i)=>({at:at(i*10),title:i===129?'Updated page title':'Original title'})),{at:at(1300),url:"https://example.edu/next"}]);
    const first=await scoped(()=>history.getStudentBrowsingHistory({...input,limit:1}));
    assert.equal(first.entries.length,1);assert.equal(first.entries[0]!.observationCount,1);assert.equal(first.entries[0]!.estimatedSeconds,0);assert(first.nextCursor);
    const second=await scoped(()=>history.getStudentBrowsingHistory({...input,limit:1,cursor:first.nextCursor}));
    const visit=second.entries[0]!;
    assert.equal(visit.observationCount,130);assert.equal(visit.estimatedSeconds,1300);
    assert.equal(visit.activeTabTitle,"Updated page title");assert.equal(visit.startedAt,"2026-09-01T13:00:00.000000Z");
    assert.equal(visit.timestamp,"2026-09-01T13:21:30.000000Z");assert.equal(visit.endedAt,"2026-09-01T13:21:40.000000Z");
    assert.equal(second.nextCursor,null);assert.equal(second.hasMore,false);assert.equal(second.asOf,first.asOf);
    assert(!("deviceId" in visit));assert(!("device_id" in visit));
    const raw=await scoped(()=>history.getStudentBrowsingHistory({...input,grouping:undefined,limit:500}));
    assert.equal(raw.entries.length,131,"Legacy callers retain every observation");
    await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...input,grouping:"observations",cursor:first.nextCursor})),{code:"HISTORY_CURSOR_INVALID"});
    await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...input,view:"all",cursor:first.nextCursor})),{code:"HISTORY_CURSOR_INVALID"});
    await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...input,actorId:otherTeacherId,cursor:first.nextCursor})),{code:"HISTORY_CURSOR_INVALID"});
    await assert.rejects(scoped(()=>history.getStudentBrowsingHistory({...input,startDate:"2026-08-31",cursor:first.nextCursor})),{code:"HISTORY_CURSOR_INVALID"});
    await assert.rejects(tenant({schoolId:otherSchoolId},()=>history.getStudentBrowsingHistory({...input,schoolId:otherSchoolId})),{code:"HISTORY_DENIED"});
  });

  it("keeps A-B-A visits and exact query/fragment changes separate",async()=>{
    const a="https://example.edu/page?q=1#one",b="https://example.edu/other";
    const input=await fixture([{at:at(0),url:a},{at:at(10),url:a},{at:at(20),url:b},{at:at(30),url:a},{at:at(40),url:a},{at:at(50),url:"https://example.edu/page?q=2#one"},{at:at(60),url:"https://example.edu/page?q=2#two"}]);
    const page=await scoped(()=>history.getStudentBrowsingHistory(input));
    assert.deepEqual(page.entries.map(row=>[row.activeTabUrl,row.observationCount,row.estimatedSeconds]),[
      ["https://example.edu/page?q=2#two",1,0],["https://example.edu/page?q=2#one",1,10],[a,2,20],[b,1,10],[a,2,20],
    ]);
  });

  it("breaks visits at hidden missing-page observations before filtering and keeps blanks individual in all view",async()=>{
    const input=await fixture([{at:at(0)},{at:at(10)},{at:at(20),url:null,title:"Unknown"},{at:at(30),url:" ",title:" Browser observation "},{at:at(40)},{at:at(50)}]);
    const pages=await scoped(()=>history.getStudentBrowsingHistory({...input,limit:1}));assert(pages.nextCursor);
    assert.equal(pages.entries[0]!.observationCount,2);assert.equal(pages.entries[0]!.estimatedSeconds,10);
    const older=await scoped(()=>history.getStudentBrowsingHistory({...input,limit:1,cursor:pages.nextCursor}));
    assert.equal(older.entries[0]!.observationCount,2);assert.equal(older.entries[0]!.estimatedSeconds,20);assert.equal(older.hasMore,false);
    const all=await scoped(()=>history.getStudentBrowsingHistory({...input,view:"all"}));
    assert.deepEqual(all.entries.map(row=>row.observationCount),[2,1,1,2]);
    assert.equal(all.entries.at(-1)!.endedAt,"2026-09-01T13:00:20.000000Z","Only the interval ending at the first unknown observation is credited");
  });

  it("groups meaningful title-only pages while retaining missing-page placeholders as boundaries",async()=>{
    const input=await fixture([{at:at(0),url:null,title:" Signing in "},{at:at(10),url:null,title:"Signing in"},{at:at(20),url:null,title:"Unknown"},{at:at(30),url:null,title:"Signing in"},{at:at(40),url:"chrome://settings",title:"Unknown"}]);
    const page=await scoped(()=>history.getStudentBrowsingHistory(input));
    assert.deepEqual(page.entries.map(row=>[row.activeTabUrl,row.observationCount,row.estimatedSeconds]),[["chrome://settings",1,0],[null,1,10],[null,2,20]]);
  });

  it("does not bridge long connection gaps or intervening device observations",async()=>{
    const gap=await fixture([{at:at(0)},{at:at(10)},{at:at(71)},{at:at(81)}]);
    const page=await scoped(()=>history.getStudentBrowsingHistory(gap));
    assert.deepEqual(page.entries.map(row=>[row.observationCount,row.estimatedSeconds]),[[2,10],[2,10]]);
    assert.equal(page.entries[1]!.endedAt,"2026-09-01T13:00:10.000000Z");
    const devices=await fixture([{at:at(0),device:"one"},{at:at(10),device:"two"},{at:at(20),device:"one"},{at:at(30),device:"one"}]);
    const switched=await scoped(()=>history.getStudentBrowsingHistory(devices));
    assert.deepEqual(switched.entries.map(row=>[row.observationCount,row.estimatedSeconds]),[[2,10],[1,0],[1,0]]);
  });

  it("keeps equal-time ordering stable and never invents time for a final observation",async()=>{
    const input=await fixture([{at:"2026-09-01T13:00:00.123456Z"},{at:"2026-09-01T13:00:00.123456Z"},{at:"2026-09-01T13:00:05.123456Z"}]);
    const page=await scoped(()=>history.getStudentBrowsingHistory(input));
    assert.equal(page.entries.length,1);assert.equal(page.entries[0]!.observationCount,3);assert.equal(page.entries[0]!.estimatedSeconds,5);
    assert.equal(page.entries[0]!.endedAt,"2026-09-01T13:00:05.123456Z");assert(page.entries[0]!.id.endsWith("0002"));
  });

  it("separates school-local days and clips selected dates, retention and the initial cursor horizon",async()=>{
    const input=await fixture([{at:"2026-09-01T03:59:50Z"},{at:"2026-09-01T04:00:00Z"},{at:"2026-09-01T04:00:10Z"}]);
    const both=await scoped(()=>history.getStudentBrowsingHistory({...input,startDate:"2026-08-31"}));
    assert.deepEqual(both.entries.map(row=>[row.observationCount,row.estimatedSeconds]),[[2,10],[1,0]]);
    const day=await scoped(()=>history.getStudentBrowsingHistory(input));assert.equal(day.entries.length,1);assert.equal(day.entries[0]!.observationCount,2);
    const {sql}=await import("drizzle-orm");
    try{
      await scoped(()=>database.execute(sql`UPDATE settings SET retention_hours='24' WHERE school_id=${schoolId}`));
      const clipped=await scoped(()=>history.getStudentBrowsingHistory({...input,startDate:"2026-08-31",now:new Date("2026-09-02T04:00:05Z")}));
      assert.equal(clipped.entries.length,1);assert.equal(clipped.entries[0]!.observationCount,1);assert.equal(clipped.entries[0]!.estimatedSeconds,0);
    }finally{await scoped(()=>database.execute(sql`UPDATE settings SET retention_hours='720' WHERE school_id=${schoolId}`));}
    const horizon=await fixture([{at:at(0)},{at:at(10),url:"https://example.edu/b"},{at:at(20),url:"https://example.edu/c"}]);
    const first=await scoped(()=>history.getStudentBrowsingHistory({...horizon,limit:1}));assert(first.nextCursor);
    await scoped(()=>database.execute(sql`INSERT INTO heartbeats(id,school_id,student_id,device_id,active_tab_title,active_tab_url,timestamp) VALUES(${horizon.studentId+'future'},${schoolId},${horizon.studentId},'visit-device','Future','https://example.edu/future','2026-09-01 18:00:01')`));
    const next=await scoped(()=>history.getStudentBrowsingHistory({...horizon,now:new Date("2026-09-01T18:01:00Z"),limit:2,cursor:first.nextCursor}));
    assert.equal(next.asOf,first.asOf);assert.equal(next.entries.length,2);assert(next.entries.every(row=>!row.id.endsWith('future')));
  });

  it("reapplies teacher authority before grouping and never joins across a delegated interval",async()=>{
    const {sql}=await import("drizzle-orm");
    const input=await fixture([{at:"2026-09-01T13:14:40Z"},{at:"2026-09-01T13:14:50Z"},{at:"2026-09-01T13:15:00Z"},{at:"2026-09-01T13:29:50Z"},{at:"2026-09-01T13:30:00Z"},{at:"2026-09-01T13:30:10Z"}]);
    await scoped(async()=>{
      await database.execute(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES(${schoolId},${sessionId},${groupId},${input.studentId},'2026-09-01 13:00:00Z')`);
      await database.execute(sql`INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by,assigned_at,released_at) VALUES(${schoolId},${contextId},${input.studentId},${otherTeacherId},'2026-09-01 13:15:00','2026-09-01 13:30:00')`);
    });
    const owner=await scoped(()=>history.getStudentBrowsingHistory({...input,role:"teacher"}));
    assert.deepEqual(owner.entries.map(row=>[row.observationCount,row.estimatedSeconds]),[[2,10],[2,10]]);
    assert.equal(owner.entries[1]!.endedAt,"2026-09-01T13:14:50.000000Z");
    const coverage=await scoped(()=>history.getStudentBrowsingHistory({...input,role:"teacher",actorId:otherTeacherId}));
    assert.deepEqual(coverage.entries.map(row=>row.observationCount),[1,1]);
  });

  it("keeps monitoring labels conservative and preserves off-task evidence within a mixed visit",async()=>{
    const input=await fixture([{at:at(0),category:"educational",contentCategory:"Productivity",intent:"teacher",locked:true,camera:true},{at:at(10),category:"non-educational",contentCategory:"Gaming",intent:null,locked:false,camera:true}]);
    const page=await scoped(()=>history.getStudentBrowsingHistory(input));const visit=page.entries[0]!;
    assert.equal(visit.observationCount,2);assert.equal(visit.aiCategory,null);assert.equal(visit.contentCategory,null);assert.equal(visit.teacherIntentSource,null);
    assert.equal(visit.screenLocked,false);assert.equal(visit.cameraActive,true);assert.equal(visit.hasOffTaskObservation,true);
    const uniform=await fixture([{at:at(0),category:"educational",contentCategory:"Productivity",intent:"teacher",locked:true},{at:at(10),category:"educational",contentCategory:"Productivity",intent:"teacher",locked:true}]);
    const retained=(await scoped(()=>history.getStudentBrowsingHistory(uniform))).entries[0]!;
    assert.equal(retained.aiCategory,"educational");assert.equal(retained.contentCategory,"Productivity");assert.equal(retained.teacherIntentSource,"teacher");assert.equal(retained.screenLocked,true);assert.equal(retained.hasOffTaskObservation,false);
  });
});
