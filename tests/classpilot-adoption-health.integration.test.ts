import { after, before, test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import pg from "pg";
import { sql } from "drizzle-orm";
import db, { pool, sessionPool } from "../src/db.js";
import { runWithTenantContext } from "../src/middleware/tenantContext.js";
import { signUserToken } from "../src/services/jwt.js";
import { MICROSOFT_SIGN_IN_EXPAND_SQL } from "../src/db/microsoftSignInMigration.js";
import { policySqlFor } from "../src/db/rlsPolicies.js";

const school = randomUUID(), otherSchool = randomUUID();
const teacher = randomUUID(), scheduledTeacher = randomUUID(), admin = randomUUID(), outsider = randomUUID();
const students = [randomUUID(), randomUUID()];
const groups = { math: randomUUID(), pending: randomUUID(), failed: randomUUID(), empty: randomUUID(), archived: randomUUID() };
const devices = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const now = new Date("2026-11-01T18:00:00.000Z");
const fixture = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
let service: typeof import("../src/services/classpilotAdoptionHealth.js");
let server: Server | undefined;
let base = "";
const sessions: Record<string, string> = {};
const scoped = <T>(action: () => Promise<T>) => runWithTenantContext({ schoolId: school }, action);

async function addSession(key: string, groupId: string, state: string | null, options: {
  mode?: string; teacherId?: string; end?: string | null; expired?: boolean; skipped?: boolean;
  observed?: number; eligible?: number; partial?: number; none?: number; notExpected?: number;
  unavailable?: number; attempts?: number;
} = {}) {
  const id = randomUUID();
  const end = options.end === undefined ? "2026-10-29 14:45:00" : options.end;
  const start = end ? new Date(new Date(end.replace(" ","T") + "Z").getTime() - 45 * 60_000).toISOString().slice(0,19).replace("T"," ") : "2026-10-29 14:00:00";
  sessions[key] = id;
  await fixture.query(`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time,session_mode,class_name_snapshot,timezone_snapshot,roster_snapshot_completed_at)
    VALUES($1,$2,$3,$4,$5::timestamp,$6::timestamp,$7,'Frozen class label','America/New_York',$5::timestamp AT TIME ZONE 'UTC')`, [id,school,groupId,options.teacherId || teacher,start,end,options.mode || "live"]);
  if (options.skipped) await fixture.query("UPDATE teaching_sessions SET scheduled_state='skipped',scheduled_date='2026-10-29',scheduled_timezone='America/New_York',scheduled_start_at=$2,scheduled_end_at=$3 WHERE id=$1",[id,"2026-10-29T14:00:00Z","2026-10-29T14:45:00Z"]);
  await fixture.query("INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role,staff_name_snapshot) VALUES($1,$2,$3,'primary','Frozen teacher label')",[school,id,options.teacherId || teacher]);
  for (const student of students) await fixture.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES($1,$2,$3,$4,$5)",[school,id,groupId,student,"2026-10-29T14:00:00Z"]);
  if (state) await fixture.query(`INSERT INTO classpilot_session_reports(id,school_id,teaching_session_id,state,window_start,window_end,timezone,authorization_marker,settle_at,next_attempt_at,expires_at,attempt_count,last_error,
    total_eligible_seconds,total_observed_seconds,total_gap_seconds,partial_count,none_count,not_expected_count,unavailable_count)
    VALUES($1,$2,$3,$4,$5,$6,'America/New_York',$7,$6,$6,$8,$9,$10,$11,$12,$11::int-$12::int,$13,$14,$15,$16)`,
    [randomUUID(),school,id,state,start.replace(" ","T") + "Z",end ? end.replace(" ","T") + "Z" : "2026-10-29T14:45:00Z",
      JSON.stringify({version:1,salt:"test-authorization-salt-20261101",digests:[]}),options.expired ? "2026-10-31T12:00:00Z" : "2026-11-28T12:00:00Z",options.attempts ?? 1,
      state === "failed" ? "INTERNAL SECRET ERROR SHOULD NEVER LEAVE SERVER" : null,options.eligible ?? 0,options.observed ?? 0,options.partial ?? 0,options.none ?? 0,options.notExpected ?? 0,options.unavailable ?? 0]);
  return id;
}

before(async () => {
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(new URL(process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || "").hostname),"Use the disposable local fixture database only");
  mock.timers.enable({ apis: ["setInterval"] });
  const setup = await fixture.connect();
  try {
    await setup.query("BEGIN"); await setup.query(MICROSOFT_SIGN_IN_EXPAND_SQL);
    if (process.env.RLS_GUC_ENABLED === "true") {
      for (const table of ["groups","students","teaching_sessions","classpilot_session_reports","classpilot_session_staff","classpilot_session_usage","classpilot_commands","heartbeats","devices","classpilot_session_students","settings"]) {
        for (const statement of policySqlFor(table)) await setup.query(statement);
        await setup.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
        await setup.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      }
    }
    await setup.query("COMMIT");
  }
  finally { setup.release(); }
  await fixture.query("INSERT INTO schools(id,name,school_timezone) VALUES($1,'Adoption school','America/New_York'),($2,'Other adoption school','America/New_York')",[school,otherSchool]);
  for (const id of [teacher,scheduledTeacher,admin,outsider]) await fixture.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Fixture','Staff')",[id,`${id}@adoption.example.edu`]);
  for (const [userId,role,schoolId] of [[teacher,"teacher",school],[scheduledTeacher,"teacher",school],[admin,"admin",school],[outsider,"admin",otherSchool]]) await fixture.query("INSERT INTO school_memberships(user_id,school_id,role,status) VALUES($1,$2,$3,'active')",[userId,schoolId,role]);
  for (const id of [school,otherSchool]) {
    await fixture.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')",[id]);
    await fixture.query("INSERT INTO settings(school_id,school_name,ws_shared_key,retention_hours) VALUES($1,'Adoption school','synthetic-only','720')",[id]);
  }
  for (const id of students) await fixture.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Fixture','Student','active')",[id,school]);
  for (const [name,id] of Object.entries(groups)) await fixture.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,$4,'admin_class',$5)",[id,school,teacher,name,name === "archived" ? "archived" : "active"]);
  await addSession("readyA",groups.math,"ready",{eligible:100,observed:90,partial:1,notExpected:1,unavailable:1});
  await addSession("readyB",groups.math,"ready",{mode:"scheduled_report",teacherId:scheduledTeacher,end:"2026-10-29 14:46:00",eligible:900,observed:450,partial:1,none:1});
  await fixture.query("INSERT INTO classpilot_session_summary_deliveries(school_id,teaching_session_id,recipient_kind,recipient_email,state) VALUES($1,$2,'teacher','fixture@adoption.example.edu','failed')",[school,sessions.readyA]);
  await addSession("failed",groups.failed,"failed",{attempts:5});
  await addSession("archived",groups.archived,"failed",{attempts:1});
  await addSession("pending",groups.pending,"pending",{mode:"scheduled_report",teacherId:scheduledTeacher});
  await addSession("missing",groups.math,null);
  await addSession("expired",groups.math,"failed",{expired:true,attempts:5});
  await addSession("unfinished",groups.math,null,{end:null});
  await addSession("skipped",groups.math,null,{skipped:true});
  await addSession("outside",groups.math,null,{end:"2026-10-25 03:00:00"});
  for (const [key,seconds] of [["readyA",90],["readyB",450]] as const) await fixture.query(`INSERT INTO classpilot_session_usage(school_id,teaching_session_id,group_id,student_id,local_date,total_seconds,heartbeat_count,first_seen,last_seen)
    VALUES($1,$2,$3,$4,'2026-10-29',$5,2,'2026-10-29T14:01:00Z','2026-10-29T14:40:00Z')`,[school,sessions[key],groups.math,students[0],seconds]);
  // A newer observation from an unfinished lesson must never enter completed-session adoption.
  await fixture.query("INSERT INTO classpilot_session_usage(school_id,teaching_session_id,group_id,student_id,local_date,total_seconds,heartbeat_count) VALUES($1,$2,$3,$4,'2026-10-29',200,20)",[school,sessions.unfinished,groups.math,students[1]]);
  for (const [index,id] of devices.entries()) {
    await fixture.query("INSERT INTO devices(device_id,school_id,class_id,device_name) VALUES($1,$2,$2,'Fixture client')",[id,school]);
    for (const [minute,version] of index === 0 ? [[5,"2.9.6"],[6,"2.9.7"]] : [[index === 2 ? 50 : 7,"2.9.6"]]) await fixture.query("INSERT INTO heartbeats(device_id,student_id,school_id,active_tab_title,extension_version,timestamp) VALUES($1,$2,$3,'Fixture',$4,$5)",[id,index === 3 ? null : students[0],school,version,`2026-10-29 14:${minute}:00`]);
  }
  for (const targets of [25,5]) await fixture.query("INSERT INTO classpilot_commands(school_id,teaching_session_id,teacher_id,target_scope,command_type,requested_count,created_at) VALUES($1,$2,$3,'class','open-tab',$4,'2026-10-29 14:10:00')",[school,sessions.readyA,teacher,targets]);
  service = await import("../src/services/classpilotAdoptionHealth.js");
  const { createApp } = await import("../src/app.js");
  server = createServer(createApp());
  await new Promise<void>(resolve => server!.listen(0,"127.0.0.1",resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/admin/analytics/adoption-health`;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await Promise.all([fixture.end(),pool.end(),sessionPool.end()]);
});

test("adoption endpoints require an administrator in the active school",async () => {
  const auth = (userId: string, schoolId: string) => ({authorization:`Bearer ${signUserToken({userId,email:`${userId}@adoption.example.edu`,isSuperAdmin:false})}`,"x-school-id":schoolId});
  for (const section of ["overview","failures","availability","tools","clients"]) {
    assert.equal((await fetch(`${base}/${section}`,{headers:auth(admin,school)})).status,200,section);
    assert.equal((await fetch(`${base}/${section}`)).status,401,section);
    assert.equal((await fetch(`${base}/${section}`,{headers:auth(teacher,school)})).status,403,section);
    assert.equal((await fetch(`${base}/${section}`,{headers:auth(outsider,school)})).status,403,section);
  }
  assert.equal((await fetch(`${base}/overview?period=all`,{headers:auth(admin,school)})).status,400);
  assert.equal((await fetch(`${base}/failures?page=-1`,{headers:auth(admin,school)})).status,400);
  service = await import("../src/services/classpilotAdoptionHealth.js");
});

test("completed official-class adoption deduplicates students, excludes scheduled-only teachers, and includes unused classes",async () => {
  const value = await scoped(() => service.getClasspilotAdoptionOverview(school,"7d",{now}));
  assert.equal(value.summary.totalClasses,4);
  assert.equal(value.summary.classesWithObservations,1);
  assert.equal(value.summary.studentsObserved,1);
  assert.equal(value.summary.teachersWithLiveSessions,1);
  const empty = value.classes.find(row => row.groupId === groups.empty)!;
  assert.equal(empty.sessionCount,0); assert.equal(empty.daysWithObservations,0); assert.equal(empty.lastObservedAt,null);
  const pending = value.classes.find(row => row.groupId === groups.pending)!;
  assert.equal(pending.daysWithObservations,null,"An unprepared summary cannot establish zero observations");
  assert.equal(value.reportCounts.ready,2); assert.equal(value.reportCounts.preparing,1); assert.equal(value.reportCounts.failed,2); assert.equal(value.reportCounts.unavailable,2);
  assert.equal(value.dataState,"partial");
});

test("only terminal retained generation failures appear, with actual attempts and frozen safe labels",async () => {
  const value = await scoped(() => service.getClasspilotAdoptionFailures(school,"7d",{now}));
  assert.equal(value.total,2); assert.equal(value.pageSize,20);
  assert.deepEqual(value.failures.map(row => row.attemptCount).sort(),[1,5]);
  assert.ok(value.failures.some(row => row.teachingSessionId === sessions.archived));
  assert.ok(value.failures.every(row => row.className === "Frozen class label" && row.teacherName === "Frozen teacher label"));
  assert.doesNotMatch(JSON.stringify(value),/SECRET|lastError|deviceId|studentSessionId|authorizationMarker/);
});

test("reporting availability weights stored seconds and keeps missing, unavailable, and not-expected records distinct",async () => {
  const value = await scoped(() => service.getClasspilotReportingAvailability(school,"7d",{now}));
  assert.equal(value.coveragePercent,54);
  assert.equal(value.summariesWithMissingObservations,2);
  assert.equal(value.notExpectedStudentRecords,1); assert.equal(value.unavailableStudentRecords,1);
  assert.equal(value.classes.find(row => row.groupId === groups.math)?.coveragePercent,54);
  assert.equal(value.classes.find(row => row.groupId === groups.math)?.latestReadySessionId,sessions.readyB);
});

test("classroom actions count once per command and observed clients use their latest in-window version",async () => {
  const tools = await scoped(() => service.getClasspilotAdoptionTools(school,"7d",{now}));
  assert.equal(tools.totalActions,2); assert.deepEqual(tools.tools,[{commandType:"open-tab",count:2}]);
  const clients = await scoped(() => service.getClasspilotAdoptionClients(school,"7d",{now}));
  assert.equal(clients.totalClients,2);
  assert.deepEqual(clients.versions,[{version:"2.9.6",count:1},{version:"2.9.7",count:1}]);
  assert.doesNotMatch(JSON.stringify(clients),/deviceId|studentId|studentSessionId/);
});

test("empty periods and cross-school reads cannot expose another school's records",async () => {
  const empty = await scoped(() => service.getClasspilotAdoptionOverview(school,"today",{now}));
  assert.equal(empty.dataState,"empty"); assert.equal(empty.summary.studentsObserved,0);
  const other = await runWithTenantContext({schoolId:otherSchool},() => service.getClasspilotAdoptionFailures(otherSchool,"7d",{now}));
  assert.equal(other.total,0);
  if (process.env.RLS_GUC_ENABLED === "true") {
    const mismatched = await runWithTenantContext({schoolId:otherSchool},() => service.getClasspilotAdoptionOverview(school,"7d",{now}));
    assert.equal(mismatched.classes.length,0,"RLS must protect even a mismatched service argument");
    assert.equal(mismatched.reportCounts.completed,0);
  }
  assert.equal(empty.range.timeZone,"America/New_York");
  assert.equal(empty.period.rangeStartUtc.toISOString(),"2026-11-01T04:00:00.000Z");
});

test("short retention is disclosed without treating expired summaries as confirmed failures",async () => {
  await fixture.query("UPDATE settings SET retention_hours='24' WHERE school_id=$1",[school]);
  try {
    const value = await scoped(() => service.getClasspilotAdoptionOverview(school,"30d",{now}));
    assert.equal(value.range.partiallyRetained,true); assert.equal(value.summary.studentsObserved,null,"Expired history cannot establish zero observations for the selected range");
    assert.equal(value.reportCounts.failed,0);
  } finally { await fixture.query("UPDATE settings SET retention_hours='720' WHERE school_id=$1",[school]); }
});

test("failure pagination has accurate totals and nonoverlapping pages of twenty",async () => {
  for (let index=0;index<21;index++) await addSession(`page${index}`,groups.archived,"failed",{attempts:2});
  const first = await scoped(() => service.getClasspilotAdoptionFailures(school,"7d",{now,page:1}));
  const second = await scoped(() => service.getClasspilotAdoptionFailures(school,"7d",{now,page:2}));
  assert.equal(first.total,23); assert.equal(first.failures.length,20); assert.equal(second.failures.length,3);
  assert.equal(new Set([...first.failures,...second.failures].map(row => row.teachingSessionId)).size,23);
});

test("both repeated school-local hours on the fall-back day belong to Today exactly once",async () => {
  const ends = ["2026-11-01 05:30:00","2026-11-01 06:30:00"];
  for (const [index,end] of ends.entries()) {
    const id = await addSession(`dst${index}`,groups.math,"ready",{end,eligible:100,observed:100});
    await fixture.query("INSERT INTO classpilot_session_usage(school_id,teaching_session_id,group_id,student_id,local_date,total_seconds,heartbeat_count,first_seen,last_seen) VALUES($1,$2,$3,$4,'2026-11-01',100,10,$5,$5)",[school,id,groups.math,students[index],end.replace(" ","T")+"Z"]);
  }
  const value = await scoped(() => service.getClasspilotAdoptionOverview(school,"today",{now}));
  assert.equal(value.summary.completedSessions,2); assert.equal(value.summary.studentsObserved,2);
  assert.equal(value.classes.find(row=>row.groupId===groups.math)?.daysWithObservations,1);
  assert.equal(value.period.rangeStartUtc.toISOString(),"2026-11-01T04:00:00.000Z");
});
