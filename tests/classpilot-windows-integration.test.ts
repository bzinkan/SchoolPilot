import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Response } from "express";
import { Pool } from "pg";
import sharp from "sharp";
import { createClient } from "redis";
import { setTimeout as pause } from "node:timers/promises";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";


process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.COOKIE_NAME = "schoolpilot.sid";
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
assert.ok(process.env.ADMIN_DATABASE_URL && process.env.TEST_REDIS_URL, "Explicit isolated Postgres and Redis fixtures required");
for (const connection of [process.env.ADMIN_DATABASE_URL, process.env.TEST_REDIS_URL]) {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connection).hostname), "Native integration refuses remote services");
}
const tag = `windows-${Date.now()}-${randomUUID().slice(0, 8)}`;
process.env.REDIS_PREFIX = tag;
process.env.REDIS_URL = "";
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof originalSetInterval>) => {
  const timer = originalSetInterval(...args); timer.unref?.(); return timer;
}) as typeof setInterval;
await import("../dist/middleware/rateLimiter.js");
process.env.REDIS_URL = process.env.TEST_REDIS_URL;
const { default: db, pool, sessionPool } = await import("../dist/db.js");
const storage = await import("../dist/services/storage.js");
const { datePlusDays, emptySchoolSchedulingConfig } = await import("../dist/services/classpilotSchedulingRules.js");
const schema = await import("../dist/schema/index.js");
const { runWithTenantContext, getOwnedTenantStore } = await import("../dist/middleware/tenantContext.js");
const { createApp } = await import("../dist/app.js");
const { signUserToken } = await import("../dist/services/jwt.js");
const { hashClassPilotPin } = await import("../dist/services/classpilotPins.js");
const { subscribeWS, disposeWSRedis } = await import("../dist/realtime/ws-redis.js");
const { classpilotNativeStore, ClasspilotNativeStore } = await import("../dist/services/classpilotNativeStore.js");
const { ClasspilotNativeError } = await import("../dist/services/classpilotNativeProtocol.js");
const { schedulerPool, schedulerLockPool } = await import("../dist/services/schedulerDb.js");
const { default: errorMonitor } = await import("../dist/services/errorMonitor.js");
let lastApiFailure:Record<string,unknown>|undefined;
const trackError=errorMonitor.trackError.bind(errorMonitor);
mock.method(errorMonitor,"trackError",((category:string,error:any,...rest:any[])=>{
  if(category==="api_error")lastApiFailure={name:error?.name,code:error?.cause?.code??error?.code,constraint:error?.cause?.constraint??error?.constraint,
    transactionScopeEnded:error?.message==="Database transaction scope has ended",frames:String(error?.stack??"").split("\n").filter(line=>/^\s+at /.test(line)).slice(0,5)};
  return Reflect.apply(trackError,undefined,[category,error,...rest]);
}) as typeof errorMonitor.trackError);
const { CLASSPILOT_NATIVE_VISIBILITY_SQL } = await import("../dist/db/classpilotNativeVisibilityMigration.js");
const { CLASSPILOT_WINDOWS_BROWSER_SQL } = await import("../dist/db/classpilotWindowsBrowserMigration.js");
const { CLASSPILOT_WINDOWS_HISTORY_SQL } = await import("../dist/db/classpilotWindowsHistoryMigration.js");
const { CLASSPILOT_WINDOWS_ACTIVITY_PARENTS_SQL } = await import("../src/db/classpilotWindowsActivityParentsMigration.js");
const { CLASSPILOT_DASHBOARD_APPEARANCE_SQL } = await import("../dist/db/classpilotDashboardAppearanceMigration.js");
const { CLASSPILOT_TEACHER_PREFERENCES_SQL } = await import("../dist/db/classpilotTeacherPreferencesMigration.js");
const fixture = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
let server: Server | undefined;
let staffAssignmentGuardsInstalled = false;
let base = "", schoolId = "", otherSchoolId = "", studentId = "", secondStudentId = "", teachingSessionId = "";
let adminToken = "", teacherToken = "", otherTeacherToken = "", adminCookie = "", adminId = "", teacherId = "", teacherEmail = "";
const inSchool = <T>(action: () => Promise<T>) => runWithTenantContext({ schoolId }, action);
type Reply = { status: number; body: any; headers: Headers };
async function request(path: string, method = "GET", body?: unknown, token?: string, extras: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${base}/api/classpilot/windows${path}`, { method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extras },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  return { status: response.status, body: parsed, headers: response.headers };
}
const staffHeaders = () => ({ "X-School-Id": schoolId });
const tiles = (extra = {}) => request("/tiles", "POST", { teachingSessionId, studentIds: [studentId], ...extra }, teacherToken, staffHeaders());
async function installation() {
  const issued = await request("/enrollment-tokens", "POST", {}, adminToken, staffHeaders());
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const enrolled = await request("/enroll", "POST", { enrollmentToken: issued.body.enrollmentToken, clientVersion: "test-1" });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return { ...enrolled.body, enrollmentToken: issued.body.enrollmentToken };
}

before(async () => {
  await fixture.query(`BEGIN; ${CLASSPILOT_TEACHER_PREFERENCES_SQL} COMMIT;`);
  await fixture.query(`BEGIN; ${CLASSPILOT_DASHBOARD_APPEARANCE_SQL} COMMIT;`);
  await fixture.query(`BEGIN; ${CLASSPILOT_NATIVE_VISIBILITY_SQL} ${CLASSPILOT_WINDOWS_BROWSER_SQL} ${CLASSPILOT_WINDOWS_HISTORY_SQL} COMMIT;`);
  await fixture.query(`BEGIN; ${CLASSPILOT_WINDOWS_ACTIVITY_PARENTS_SQL} COMMIT;`);
  // The ordinary lane shares legacy fixtures; the RLS lane converges the
  // canonical staff contract before tests. Never migrate unrelated rows here.
  const staffGuards = await fixture.query(`SELECT t.tgname AS name,
    t.tgenabled IN ('O','A') AS enabled,
    t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred AS deferred_constraint,
    p.proname = 'schoolpilot_check_departing_staff_assignments' AND n.nspname = 'public' AS canonical_function
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE t.tgrelid='public.school_memberships'::regclass AND NOT t.tgisinternal
      AND t.tgname IN ('classpilot_staff_assignment_membership_delete','classpilot_staff_assignment_membership_update')
    ORDER BY t.tgname`);
  if (process.env.RLS_GUC_ENABLED === "true" || staffGuards.rows.length > 0) {
    assert.deepEqual(staffGuards.rows, ["delete", "update"].map(operation => ({
      name: `classpilot_staff_assignment_membership_${operation}`, enabled: true,
      deferred_constraint: true, canonical_function: true,
    })), "The RLS fixture requires both canonical staff membership guards; partial or disabled guards are never accepted");
    staffAssignmentGuardsInstalled = true;
  }
  const school = await storage.createSchool({ name: tag, slug: tag, domain: `${tag}.example.edu`, status: "active", planStatus: "active", schoolTimezone: "UTC" });
  schoolId = school.id;
  const other = await storage.createSchool({ name: `${tag}-other`, slug: `${tag}-other`, domain: `${tag}-other.example.edu`, status: "active", planStatus: "active" });
  otherSchoolId = other.id;
  process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE = "off";
  process.env.CLASSPILOT_WINDOWS_BROWSER_MODE = "on";
  process.env.CLASSPILOT_WINDOWS_BROWSER_SCHOOL_IDS = `${schoolId},${otherSchoolId}`;
  process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
  for(const name of ["SCOPED_AUTHORITY_CHECKS","AUTH_BOUND_TELEMETRY","EXACT_BINDING_ACK","EXACT_TAB_CLOSE","SCREENSHOT_TRACKING_WINDOW_LEASE","SCREENSHOT_ACTIVE_OBSERVATION_CADENCE","STUDENT_CHAT_IDEMPOTENCY","HELP_REQUESTS","QUESTION_PARKING","TIMER_CONTROLS","LESSON_ACTIVITIES","EXIT_TICKETS"]){process.env[`CLASSPILOT_CAP_${name}_${name.startsWith("EXACT_")?"V2":"V1"}`]="true";}
  process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON=JSON.stringify({[schoolId]:3});
  process.env.CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS = `${schoolId},${otherSchoolId}`;
  // Seven tracking weekdays do not make weekends instructional. Keep this
  // synthetic school's real-clock fixture open across a possible UTC midnight.
  const today = new Date().toISOString().slice(0, 10);
  const config = { ...emptySchoolSchedulingConfig(), dateOverrides: {
    [today]: { instructional: true }, [datePlusDays(today, 1)]: { instructional: true },
  } };
  await inSchool(() => db.insert(schema.classpilotSchoolSchedules).values({ schoolId, config })
    .onConflictDoUpdate({ target: schema.classpilotSchoolSchedules.schoolId, set: { config } }));
  await inSchool(() => storage.upsertSettings(schoolId, { schoolName: tag, schoolTimezone: "UTC", wsSharedKey: tag,
    enableTrackingHours: true, trackingStartTime: "00:00", trackingEndTime: "23:59",
    trackingDays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], afterHoursMode: "off" }));
  await storage.createProductLicense({ schoolId, product: "CLASSPILOT", status: "active" });
  await storage.createProductLicense({ schoolId: otherSchoolId, product: "CLASSPILOT", status: "active" });
  const admin = await storage.createUser({ email: `admin@${tag}.example.edu`, firstName: "Synthetic", lastName: "Admin" });
  adminId = admin.id;
  const teacher = await storage.createUser({ email: `teacher@${tag}.example.edu`, firstName: "Synthetic", lastName: "Teacher" });
  teacherId = teacher.id; teacherEmail = teacher.email;
  const outsider = await storage.createUser({ email: `outsider@${tag}-other.example.edu`, firstName: "Synthetic", lastName: "Outsider" });
  await inSchool(() => storage.createMembership({ userId: admin.id, schoolId, role: "school_admin", status: "active" }));
  await inSchool(() => storage.createMembership({ userId: teacher.id, schoolId, role: "teacher", status: "active" }));
  await runWithTenantContext({ schoolId: otherSchoolId }, () => storage.createMembership({ userId: outsider.id, schoolId: otherSchoolId, role: "teacher", status: "active" }));
  adminToken = signUserToken({ userId: admin.id, email: admin.email, authVersion: admin.authVersion });
  teacherToken = signUserToken({ userId: teacher.id, email: teacher.email, authVersion: teacher.authVersion });
  otherTeacherToken = signUserToken({ userId: outsider.id, email: outsider.email, authVersion: outsider.authVersion });
  const pinHash = await hashClassPilotPin("1234");
  const students = await inSchool(() => db.insert(schema.students).values([1, 2].map(n => ({ schoolId,
    email: `${tag}-${n}@example.edu`, firstName: "Synthetic", lastName: `Student ${n}`, classpilotPinHash: pinHash,
    status: "active", studentIdNumber: `${tag}-${n}` }))).returning());
  studentId = students[0]!.id; secondStudentId = students[1]!.id;
  const session = await inSchool(async () => {
    const group = await storage.createGroup({ schoolId, teacherId: teacher.id, name: tag, groupType: "admin_class", status: "active" });
    await db.insert(schema.groupStudents).values(students.map(s => ({ groupId: group.id, studentId: s.id })));
    return storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id, sessionMode: "live" });
  });
  teachingSessionId = session.id;
  const sid = randomUUID(), expires = new Date(Date.now() + 3_600_000);
  await fixture.query("INSERT INTO session(sid,sess,expire) VALUES($1,$2,(now() AT TIME ZONE 'UTC') + interval '1 hour')", [sid, JSON.stringify({
    userId: admin.id, authVersion: admin.authVersion, role: "school_admin", lastActivityAt: Date.now(), csrfToken: "synthetic-native-csrf",
    cookie: { originalMaxAge: 3_600_000, expires: expires.toISOString(), httpOnly: true, path: "/" } })]);
  adminCookie = `schoolpilot.sid=${encodeURIComponent(`s:${sid}.${createHmac("sha256", process.env.SESSION_SECRET!).update(sid).digest("base64").replace(/=+$/, "")}`)}`;
  await subscribeWS(() => undefined);
  server = createServer(createApp());
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
  await disposeWSRedis();
  await errorMonitor.disposeAndWait();
  // Retire this fixture's identities; no browser identities or production data exist in this database.
  if (schoolId) await fixture.query("UPDATE classpilot_windows_guards SET ended_at=now() WHERE school_id=$1",[schoolId]);
  if (schoolId) await fixture.query("UPDATE classpilot_native_sessions SET ended_at=now(),end_reason='test_cleanup' WHERE school_id=$1 AND ended_at IS NULL", [schoolId]);
  if (schoolId) await fixture.query("UPDATE classpilot_native_installations SET revoked_at=now() WHERE school_id=$1", [schoolId]);
  await fixture.end();
  await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  globalThis.setInterval = originalSetInterval;
});


const capabilities=["screenOnlyUnlockV1","scopedAuthorityChecksV1","authBoundTelemetryV1","exactBindingAckV2","exactTabCloseV2","screenshotTrackingWindowLeaseV1","screenshotActiveObservationCadenceV1","studentChatIdempotencyV1","helpRequestsV1","questionParkingV1","timerControlsV1","lessonActivitiesV1","exitTicketsV1"];
const source=(browser:any)=>({sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision});
async function guard(installationCredential:string,id=studentId,nonce=randomUUID()){
  const reply=await request("/guards","POST",{identifier:id,pin:"1234",osSessionNonce:nonce},installationCredential);
  return {...reply,nonce};
}
async function proof(credential:string,browserFamily="chrome",profileId=randomUUID(),challenge=randomBytes(32).toString("base64url")){
  const reply=await request("/guards/pairing-proofs","POST",{browserFamily,profileId,challenge},credential);
  assert.equal(reply.status,201,JSON.stringify(reply.body));return {...reply.body,browserFamily,profileId,challenge};
}
async function pair(credential:string,family="chrome",profileId=randomUUID(),advertised=capabilities){
  const p=await proof(credential,family,profileId);const reply=await request("/browser/pair","POST",{...p,expiresAt:undefined,serverTime:undefined,clientProtocolVersion:3,capabilities:advertised,extensionVersion:"3.0.3"});
  assert.equal(reply.status,201,JSON.stringify(reply.body));return {...reply.body,profileId};
}
function heartbeat(browser:any,sequence:number,url:string,extra:Record<string,unknown>={}){
  return request("/browser/heartbeat","POST",{...source(browser),sequence,observationId:randomUUID(),browserFocused:true,activeTabUrl:url,activeTabTitle:"Synthetic lesson",activeTabRef:`tab-${browser.browserFamily}`,allOpenTabs:[{tabRef:`tab-${browser.browserFamily}`,url,title:"Synthetic lesson",active:true}],tabSnapshot:{schemaVersion:1,revision:sequence},classroomControls:{screenLocked:false,flightPathActive:false,isSharing:false,cameraActive:false},...extra},browser.studentToken);
}
function command(type:string,payload:Record<string,unknown>,targets?:any[],actor=teacherToken){return request("/commands","POST",{teachingSessionId,targetScope:"students",targetStudentIds:[studentId],commandType:type,commandPayload:payload,...(targets?{browserTargets:targets.map(t=>({studentId,...source(t)}))}:{})},actor,staffHeaders());}

test("Windows real routes isolate credentials, browser children, authority, commands, images and guard lifecycle",async t=>{
  let installationA:any,installationB:any,bound:any,chrome:any,edge:any;
  t.beforeEach(async()=>{if(bound?.body?.guardCredential){const renewal=await request("/guards/renew","POST",{osSessionNonce:bound.nonce},bound.body.guardCredential);assert.equal(renewal.status,200,JSON.stringify(renewal.body));}});
  await t.test("default off and malformed allowlist fail closed without using native capture flag",async()=>{
    process.env.CLASSPILOT_WINDOWS_BROWSER_MODE="off";
    assert.equal((await tiles()).body.enabled,false);
    assert.equal((await request("/enrollment-tokens","POST",{},adminToken,staffHeaders())).status,404);
    process.env.CLASSPILOT_WINDOWS_BROWSER_MODE="on";
    const allowed=process.env.CLASSPILOT_WINDOWS_BROWSER_SCHOOL_IDS;process.env.CLASSPILOT_WINDOWS_BROWSER_SCHOOL_IDS=`${schoolId},*`;
    assert.equal((await tiles()).body.enabled,false);process.env.CLASSPILOT_WINDOWS_BROWSER_SCHOOL_IDS=allowed;
    assert.equal(process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE,"off");
  });
  await t.test("single-use school enrollment, staff cookie CSRF and credential audiences",async()=>{
    installationA=await installation();installationB=await installation();
    assert.equal((await request("/enroll","POST",{enrollmentToken:installationA.enrollmentToken,clientVersion:"test-1"})).status,401);
    assert.equal((await guard(adminToken)).status,401);
    const cookie=await request("/enrollment-tokens","POST",{},undefined,{...staffHeaders(),cookie:adminCookie});assert.equal(cookie.status,403);
    const invalidIdentifier=await request("/guards","POST",{identifier:randomUUID(),pin:"1234",osSessionNonce:randomUUID()},installationA.installationCredential);
    const invalidPin=await request("/guards","POST",{identifier:studentId,pin:"9999",osSessionNonce:randomUUID()},installationA.installationCredential);
    assert.equal(invalidIdentifier.status,401);assert.equal(invalidPin.status,401);assert.deepEqual(invalidIdentifier.body,invalidPin.body);
    assert.equal(invalidPin.body.code,"WINDOWS_CREDENTIAL_INVALID");
    bound=await guard(installationA.installationCredential);assert.equal(bound.status,201,JSON.stringify(bound.body));
    assert.ok(bound.body.guardCredential.startsWith("cpw1.guard."));
    assert.equal((await guard(bound.body.guardCredential)).status,401);
    assert.equal((await guard(installationB.installationCredential)).status,409);
    assert.equal((await fixture.query("SELECT count(*)::int AS n FROM student_sessions WHERE student_id=$1",[studentId])).rows[0].n,0);
  });
  await t.test("proof binds exact browser, profile, challenge and one-time expiry",async()=>{
    const p=await proof(bound.body.guardCredential);const body={proof:p.proof,browserFamily:p.browserFamily,profileId:p.profileId,challenge:p.challenge,clientProtocolVersion:3,capabilities,extensionVersion:"3.0.3"};
    assert.equal((await request("/browser/pair","POST",{...body,browserFamily:"edge"})).status,401);
    assert.equal((await request("/browser/pair","POST",{...body,challenge:randomBytes(32).toString("base64url")})).status,401);
    const response=await request("/browser/pair","POST",body);assert.equal(response.status,201,JSON.stringify(response.body));chrome={...response.body,profileId:p.profileId};
    assert.equal((await request("/browser/pair","POST",body)).status,401);
    const expired=await proof(bound.body.guardCredential,"edge");await fixture.query("UPDATE classpilot_windows_pairing_proofs SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 minute' WHERE token_hash=encode(sha256($1::bytea),'hex')",[Buffer.from(expired.proof)]);
    assert.equal((await request("/browser/pair","POST",{proof:expired.proof,browserFamily:expired.browserFamily,profileId:expired.profileId,challenge:expired.challenge,clientProtocolVersion:3,capabilities,extensionVersion:"3.0.3"})).status,401);
    edge=await pair(bound.body.guardCredential,"edge");assert.notEqual(edge.studentToken,chrome.studentToken);assert.notEqual(edge.sourceRef,chrome.sourceRef);
    const competitor=await proof(bound.body.guardCredential);assert.equal((await request("/browser/pair","POST",{proof:competitor.proof,browserFamily:"chrome",profileId:competitor.profileId,challenge:competitor.challenge,clientProtocolVersion:3,capabilities,extensionVersion:"3.0.3"})).status,409);
  });
  await t.test("actual extension tab envelope works; source pixels/navigation never union or leak in metadata",async()=>{
    for(const browser of[chrome,edge]){const response=await heartbeat(browser,1,`https://${browser.browserFamily}.example.edu/lesson`);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.exactBinding.studentSessionId,browser.studentSessionId);assert.equal(response.body.settings.enrollmentKey,undefined);assert.equal(response.body.settings.wsSharedKey,undefined);}
    const metadata=await tiles();assert.equal(metadata.status,200);assert.equal(metadata.body.tiles[0].browserSources.length,2);
    for(const row of metadata.body.tiles[0].browserSources){assert.equal(row.activeTabUrl,undefined);assert.equal(row.tabSnapshot,undefined);assert.equal(row.screenshot,undefined);}
    const selected=await tiles({selectedSources:[{studentId,...source(chrome)}]});const rows=selected.body.tiles[0].browserSources;
    assert.equal(rows.find((r:any)=>r.browserFamily==="chrome").activeTabUrl,"https://chrome.example.edu/lesson");assert.equal(rows.find((r:any)=>r.browserFamily==="edge").activeTabUrl,undefined);
    assert.equal((await heartbeat(chrome,1,"https://replay.example.edu")).status,409);
    assert.equal((await request("/tiles","POST",{teachingSessionId,studentIds:[studentId]},otherTeacherToken,staffHeaders())).status,403);
  });
  await t.test("policy commands target both children, tab commands exactly one and ACK cannot cross browsers",async()=>{
    assert.equal((await command("open-tab",{url:"https://example.edu/"})).status,400);
    assert.equal((await command("lock-screen",{url:"https://example.edu/"},undefined,adminToken)).status,403,"Observe is read-only");
    const lock=await command("lock-screen",{url:"https://example.edu/"});assert.equal(lock.status,201,JSON.stringify(lock.body));assert.equal(lock.body.targets.length,2);
    for(const browser of[chrome,edge]){const hb=await heartbeat(browser,2,`https://${browser.browserFamily}.example.edu/lesson`);assert.equal(hb.status,200,JSON.stringify(hb.body));assert.equal(hb.body.classroomState.restrictions.screenLock.active,true);const frame=hb.body.messages.find((m:any)=>m.commandId===lock.body.command.id);assert.equal(frame.type,"remote-control");assert.equal(frame.exactBinding.studentSessionId,browser.studentSessionId);}
    const open=await command("open-tab",{url:"https://example.edu/next"},[chrome]);assert.equal(open.status,201,JSON.stringify(open.body));assert.equal(open.body.targets.length,1);
    const revision=(await fixture.query("SELECT revision FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=$2",[schoolId,studentId])).rows[0].revision;
    // This is the actual 3.0.3 worker envelope: ackState, exact binding and a
    // top-level outcome. A successful receipt must drain its exact ACK outbox.
    const ack={acks:[{ackId:randomUUID(),commandId:open.body.command.id,ackState:"completed",bindingVersion:2,schoolId,studentId,
      studentSessionId:chrome.studentSessionId,deviceId:chrome.deviceId,studentControlRevision:revision,outcome:"applied",result:{opened:true}}]};
    const rejected=await request("/browser/command-acks","POST",{...source(edge),...ack},edge.studentToken);assert.equal(rejected.body.receipts[0].accepted,false);
    assert.equal(rejected.body.receipts[0].code,"COMMAND_ACK_BINDING_MISMATCH");
    const forged=await request("/browser/command-acks","POST",{...source(chrome),acks:[{...ack.acks[0],studentSessionId:edge.studentSessionId}]},chrome.studentToken);assert.equal(forged.body.receipts[0].accepted,false);
    const accepted=await request("/browser/command-acks","POST",{...source(chrome),...ack},chrome.studentToken);
    assert.deepEqual(accepted.body.receipts,[{ackId:ack.acks[0]!.ackId,commandId:open.body.command.id,accepted:true,disposition:"applied",retryable:false,code:"COMMAND_ACK_APPLIED"}]);
    const repeated=await request("/browser/command-acks","POST",{...source(chrome),...ack},chrome.studentToken);assert.equal(repeated.body.receipts[0].disposition,"idempotent");
    const inconsistent=await request("/browser/command-acks","POST",{...source(chrome),acks:[{...ack.acks[0],controlRevision:revision+1}]},chrome.studentToken);assert.equal(inconsistent.body.receipts[0].code,"COMMAND_ACK_BINDING_MISMATCH");
    const outcome=await request(`/commands/${open.body.command.id}?teachingSessionId=${teachingSessionId}`,"GET",undefined,teacherToken,staffHeaders());assert.equal(outcome.body.targets[0].status,"completed");assert.equal(outcome.body.targets[0].result.outcome,"applied");
    assert.equal((await command("close-tabs",{tabsToClose:[{studentId,tabRef:"tab-edge",observedRevision:2}]},[chrome])).status,409);
  });
  await t.test("authorized class observation accelerates both exact browsers and release restores background capture",async()=>{
    const policy=(browser:any)=>request("/browser/action","POST",{...source(browser),operation:"settings",payload:{}},browser.studentToken);
    for(const browser of[chrome,edge])assert.equal((await policy(browser)).body.screenshotPolicy.captureCadence.intervalSeconds,30);
    const viewerInstanceId=randomUUID();const leasePath=`${base}/api/classpilot/teaching-sessions/${teachingSessionId}/observation-lease`;
    const headers={authorization:`Bearer ${teacherToken}`,"content-type":"application/json",...staffHeaders()};
    const lease=await fetch(leasePath,{method:"PUT",headers,body:JSON.stringify({viewerInstanceId,scope:{kind:"class"}})});assert.equal(lease.status,200);
    try{for(const browser of[chrome,edge]){const result=await policy(browser);assert.equal(result.status,200);assert.equal(result.body.screenshotPolicy.captureCadence.intervalSeconds,5);
      assert.equal(result.body.screenshotPolicy.authority.teachingSessionId,teachingSessionId);assert.ok(result.body.screenshotPolicy.expiresInSeconds>0&&result.body.screenshotPolicy.expiresInSeconds<=45);}}
    finally{assert.equal((await fetch(leasePath,{method:"DELETE",headers,body:JSON.stringify({viewerInstanceId})})).status,204);}
    for(const browser of[chrome,edge])assert.equal((await policy(browser)).body.screenshotPolicy.captureCadence.intervalSeconds,30);
  });
  await t.test("current-page lock resolves each exact browser without using its sibling's URL",async()=>{
    const locked=await command("lock-screen",{url:"CURRENT_URL"});assert.equal(locked.status,201,JSON.stringify(locked.body));
    for(const browser of[chrome,edge]){const response=await heartbeat(browser,3,`https://${browser.browserFamily}.example.edu/lesson`);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.classroomState.restrictions.screenLock.url,`https://${browser.browserFamily}.example.edu/lesson`);}
  });
  await t.test("bounded JPEG uses exact child/control revision; metadata and stale control never return pixels",async()=>{
    const hb=await heartbeat(chrome,4,"https://chrome.example.edu/lesson");assert.equal(hb.status,200);const jpeg=await sharp({create:{width:160,height:90,channels:3,background:"#245"}}).jpeg().toBuffer();
    const input={...source(chrome),sequence:1,capturedAt:new Date().toISOString(),screenshot:`data:image/jpeg;base64,${jpeg.toString("base64")}`,screenshotAuthority:hb.body.screenshotPolicy.authority};
    const stored=await request("/browser/screenshot","POST",input,chrome.studentToken);assert.equal(stored.status,200,JSON.stringify(stored.body));
    assert.equal((await request("/browser/screenshot","POST",input,edge.studentToken)).status,409);
    const selected=await tiles({selectedSources:[{studentId,...source(chrome)}]});assert.ok(selected.body.tiles[0].browserSources.find((r:any)=>r.browserFamily==="chrome").screenshot.startsWith("data:image/jpeg;base64,"));
    await command("unlock-screen",{screenOnly:true});
    assert.equal((await request("/browser/screenshot","POST",{...input,sequence:2},chrome.studentToken)).status,409);
    const stale=await tiles({selectedSources:[{studentId,...source(chrome)}]});assert.equal(stale.body.tiles[0].browserSources.find((r:any)=>r.browserFamily==="chrome").screenshot,undefined);
  });
  await t.test("poll response is first-write per student across both browsers; source capability remains separate",async()=>{
    const poll=await command("poll",{question:"Ready?",options:["Yes","No"]});assert.equal(poll.status,201,JSON.stringify(poll.body));
    const payload=poll.body.command.commandPayload;
    const hb=await heartbeat(chrome,5,"https://chrome.example.edu/lesson");const revision=hb.body.exactBinding.controlRevision;
    const answer=(browser:any,selectedOption:number)=>request("/browser/action","POST",{...source(browser),operation:"poll-respond",payload:{pollId:payload.pollId,selectedOption,studentControlRevision:revision,teachingSessionId}},browser.studentToken);
    assert.equal((await answer(chrome,0)).status,200,JSON.stringify(lastApiFailure));assert.equal((await answer(edge,0)).body.disposition,"replayed");assert.equal((await answer(edge,1)).status,409);
    await assert.rejects(fixture.query("INSERT INTO poll_responses(school_id,poll_id,student_id,device_id,selected_option) VALUES($1,$2,$3,$4,0)",[schoolId,payload.pollId,secondStudentId,chrome.deviceId]),{code:"23514"});
    await assert.rejects(fixture.query("INSERT INTO classpilot_active_hands(school_id,teaching_session_id,student_id,device_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 minute')",[schoolId,teachingSessionId,secondStudentId,chrome.deviceId]),{code:"23514"});
    await assert.rejects(fixture.query("INSERT INTO chat_messages(school_id,session_id,student_id,device_id,student_session_id,sender_id,sender_type,content) VALUES($1,$2,$3::text,$4::text,$4::text,$3::text,'student','Synthetic')",[schoolId,teachingSessionId,secondStudentId,chrome.deviceId]),{code:"23514"});
    const help=await request("/browser/action","POST",{...source(chrome),operation:"class-tools:help",payload:{teachingSessionId,studentControlRevision:revision,data:{category:"assignment",explanation:"Synthetic help"}}},chrome.studentToken);assert.equal(help.status,200,JSON.stringify(help.body));
    assert.equal((await command("poll",{action:"close",pollId:payload.pollId})).status,201);
  });
  await t.test("mixed browser audience creates one resource and freezes both transports for close/stop",async()=>{
    const deviceId=`${tag}-mixed`;await inSchool(()=>storage.createDevice({schoolId,deviceId,classId:"default"}));
    const legacy=await inSchool(()=>storage.setActiveStudentForDevice(deviceId,secondStudentId));
    const mixed=(commandType:string,commandPayload:Record<string,unknown>,ids=[studentId,secondStudentId])=>request("/commands","POST",{teachingSessionId,targetScope:"students",targetStudentIds:ids,commandType,commandPayload},teacherToken,staffHeaders());
    const poll=await mixed("poll",{question:"One resource?",options:["Yes","No"]});assert.equal(poll.status,201,JSON.stringify(poll.body));
    assert.equal(poll.body.targets.length,3);assert.equal(poll.body.targets.filter((row:any)=>row.sourceRef).length,2);
    const row=await fixture.query("SELECT start_command_id FROM polls WHERE id=$1 AND school_id=$2",[poll.body.command.commandPayload.pollId,schoolId]);assert.equal(row.rows[0].start_command_id,poll.body.command.id);
    const stored=await fixture.query("SELECT student_id,student_session_id FROM classpilot_command_targets WHERE command_id=$1 AND student_session_id IS NOT NULL",[poll.body.command.id]);assert.deepEqual(stored.rows,[{student_id:secondStudentId,student_session_id:legacy.id}]);
    await fixture.query("INSERT INTO poll_responses(school_id,poll_id,student_id,device_id,selected_option) VALUES($1,$2,$3,$4,0)",[schoolId,poll.body.command.commandPayload.pollId,secondStudentId,deviceId]);
    const closed=await mixed("poll",{action:"close",pollId:poll.body.command.commandPayload.pollId},[studentId]);assert.equal(closed.status,201,JSON.stringify(closed.body));assert.equal(closed.body.targets.length,3,"closing cannot narrow original audience");
    const timer=await mixed("timer",{action:"start",seconds:120});assert.equal(timer.status,201,JSON.stringify(timer.body));
    const resource=timer.body.command.commandPayload;assert.ok(resource.timerId);
    const stopped=await mixed("timer",{action:"stop",timerId:resource.timerId,expectedRevision:resource.revision},[studentId]);assert.equal(stopped.status,201,JSON.stringify(stopped.body));assert.equal(stopped.body.targets.length,3);
    assert.equal((await fixture.query("SELECT count(*)::int AS count FROM classpilot_timers WHERE start_command_id=$1",[timer.body.command.id])).rows[0].count,1);
    await fixture.query("UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=$1",[legacy.id]);
  });
  await t.test("real student hand/help/chat compose within one transaction and events retain exact child context",async()=>{
    const hb=await heartbeat(chrome,6,"https://chrome.example.edu/lesson");assert.equal(hb.status,200,JSON.stringify(hb.body));const revision=hb.body.exactBinding.controlRevision;
    const action=(operation:string,payload:Record<string,unknown>)=>request("/browser/action","POST",{...source(chrome),operation,payload:{teachingSessionId,studentControlRevision:revision,...payload}},chrome.studentToken);
    for(const operation of["raise-hand","lower-hand"]){const result=await action(operation,{});assert.equal(result.status,200,JSON.stringify({operation,lastApiFailure,body:result.body}));}
    const chat=await action("send-message",{message:"Synthetic classroom question",clientMessageId:randomUUID()});assert.equal(chat.status,200,JSON.stringify(chat.body));assert.ok(chat.body.messageId);
    const event={schemaVersion:1,sourceEventId:randomUUID(),type:"tab_changed",occurredAt:new Date().toISOString(),teachingSessionId,url:"https://example.edu/lesson?secret=discard",title:"Synthetic"};
    const first=await action("events",{events:[event]});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.results[0].status,"stored");
    assert.equal((await action("events",{events:[event]})).body.results[0].status,"duplicate");
    assert.equal((await action("events",{events:[{...event,sourceEventId:randomUUID(),teachingSessionId:randomUUID()}]})).body.results[0].status,"not_retained");
    assert.equal((await request("/browser/action","POST",{...source(edge),operation:"events",payload:{events:[event]}},chrome.studentToken)).status,409);
    const retained=await fixture.query("SELECT device_id,student_id,sanitized_path FROM classpilot_monitoring_events WHERE source_event_id=$1 AND school_id=$2",[event.sourceEventId,schoolId]);assert.equal(retained.rows[0].student_id,studentId);assert.equal(retained.rows[0].device_id,chrome.deviceId);assert.equal(retained.rows[0].sanitized_path,"/lesson");
  });
  await t.test("capless Edge cannot borrow Chrome capability or receive an unsupported shared restriction",async()=>{
    edge=await pair(bound.body.guardCredential,"edge",edge.profileId,[]);
    const unsupported=await command("open-tab",{url:"https://example.edu/"},[edge]);assert.equal(unsupported.status,201,JSON.stringify(unsupported.body));assert.equal(unsupported.body.summary.unavailable,1);
    const chromeOnly=await command("open-tab",{url:"https://example.edu/"},[chrome]);assert.equal(chromeOnly.status,201);assert.equal(chromeOnly.body.summary.unavailable,0);
    const policy=await command("lock-screen",{url:"https://example.edu/"});assert.equal(policy.status,201);assert.equal(policy.body.summary.unavailable,1);assert.equal(policy.body.summary.pending,1);
    assert.equal((await heartbeat(edge,1,"https://edge.example.edu")).body.classroomState,null);
    assert.equal((await heartbeat(chrome,7,"https://chrome.example.edu")).body.classroomState.restrictions.screenLock.active,true);
    edge=await pair(bound.body.guardCredential,"edge",edge.profileId);
  });
  await t.test("selected browser metadata expires at the class deadline even while the guard remains valid",async()=>{
    const {classpilotWindowsStore}=await import("../dist/services/classpilotWindowsStore.js");
    const before=await tiles({selectedSources:[{studentId,...source(chrome)}]});assert.equal(before.status,200);
    assert.equal(before.body.tiles[0].browserSources.find((row:any)=>row.sourceRef===chrome.sourceRef).activeTabUrl,"https://chrome.example.edu");
    const original=(await fixture.query("SELECT hard_expires_at FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=$2",[schoolId,studentId])).rows[0].hard_expires_at;
    await fixture.query("UPDATE classpilot_student_control_states SET hard_expires_at=clock_timestamp()+interval '1 second' WHERE school_id=$1 AND student_id=$2",[schoolId,studentId]);
    const get=classpilotWindowsStore.get.bind(classpilotWindowsStore);
    const delayed=mock.method(classpilotWindowsStore,"get",async(...args:Parameters<typeof get>)=>{if(args[0]==="image")await pause(1_200);return get(...args);});
    try{
      const result=await tiles({selectedSources:[{studentId,...source(chrome)}]});assert.equal(result.status,200,JSON.stringify(result.body));
      const selected=result.body.tiles[0].browserSources.find((row:any)=>row.sourceRef===chrome.sourceRef);
      for(const key of["activeTabUrl","activeTabTitle","tabSnapshot","classroomControls","screenshot","aiClassification"])assert.equal(selected[key],undefined,key);
      assert.equal(selected.isLoggedIn,false);assert.ok(Date.parse(selected.expiresAt)<=Date.parse(result.body.serverTime));
    }finally{delayed.mock.restore();await fixture.query("UPDATE classpilot_student_control_states SET hard_expires_at=$1 WHERE school_id=$2 AND student_id=$3",[original,schoolId,studentId]);}
  });
  await t.test("no-class browser metadata is retained while screenshot bodies are discarded",async()=>{
    const [student]=await inSchool(()=>db.insert(schema.students).values({schoolId,firstName:"Synthetic",lastName:"Unclassed",status:"active",classpilotPinHash:undefined}).returning());
    await fixture.query("UPDATE students SET classpilot_pin_hash=(SELECT classpilot_pin_hash FROM students WHERE id=$1) WHERE id=$2",[studentId,student!.id]);
    const unclassed=await guard(installationB.installationCredential,student!.id);assert.equal(unclassed.status,201,JSON.stringify(unclassed.body));
    const browser=await pair(unclassed.body.guardCredential);const hb=await heartbeat(browser,1,"https://example.edu/unclassed");assert.equal(hb.status,200);assert.equal(hb.body.screenshotPolicy.authority.kind,"student_session");
    const jpeg=await sharp({create:{width:160,height:90,channels:3,background:"#246"}}).jpeg().toBuffer();
    const image=await request("/browser/screenshot","POST",{...source(browser),sequence:1,capturedAt:new Date().toISOString(),screenshot:`data:image/jpeg;base64,${jpeg.toString("base64")}`,screenshotAuthority:hb.body.screenshotPolicy.authority},browser.studentToken);assert.equal(image.status,200,JSON.stringify(image.body));assert.equal(image.body.discarded,true);
    const {classpilotWindowsStore}=await import("../dist/services/classpilotWindowsStore.js");assert.equal(await classpilotWindowsStore.get("image",schoolId,browser.sourceRef),null);
    assert.equal((await fixture.query("SELECT count(*)::int AS count FROM classpilot_windows_browser_events WHERE browser_id=$1 AND teaching_session_id IS NULL AND supervision_context_id IS NULL",[browser.deviceId])).rows[0].count,1);
    await request("/guards","DELETE",{},unclassed.body.guardCredential);
  });
  await t.test("reauth rotates exact source, old credential cannot revive, and native capture deletion is independent",async()=>{
    const old=chrome;chrome=await pair(bound.body.guardCredential,"chrome",old.profileId);
    assert.notEqual(chrome.sourceRef,old.sourceRef);assert.ok(chrome.bindingRevision>old.bindingRevision);
    assert.equal((await heartbeat(old,6,"https://old.example.edu")).status,401);
    assert.equal((await request("/browser/heartbeat","POST",{...source(old),sequence:1},chrome.studentToken)).status,409);
    process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE="on";
    const response=await fetch(`${base}/api/classpilot/native/sessions`,{method:"POST",headers:{authorization:`Bearer ${installationA.installationCredential}`,"content-type":"application/json"},body:JSON.stringify({identifier:studentId,pin:"1234",osSessionNonce:randomUUID()})});assert.equal(response.status,201);const native:unknown=await response.json();
    assert.ok(native&&typeof native==="object"&&"sessionCredential" in native&&typeof native.sessionCredential==="string");
    assert.equal((await fetch(`${base}/api/classpilot/native/session`,{method:"DELETE",headers:{authorization:`Bearer ${native.sessionCredential}`}})).status,204);
    process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE="off";assert.equal((await heartbeat(chrome,1,"https://chrome.example.edu/new")).status,200);
  });
  await t.test("PIN rotation, absolute/rolling expiry and OS nonce refuse guard/child authority",async()=>{
    assert.equal((await request("/guards/renew","POST",{osSessionNonce:randomUUID()},bound.body.guardCredential)).status,401);
    await fixture.query("UPDATE students SET classpilot_pin_hash=$1 WHERE id=$2",[await hashClassPilotPin("5678"),studentId]);
    assert.equal((await heartbeat(chrome,2,"https://stale.example.edu")).status,401);
    assert.equal((await request("/guards/renew","POST",{osSessionNonce:bound.nonce},bound.body.guardCredential)).status,401);
    await fixture.query("UPDATE students SET classpilot_pin_hash=$1 WHERE id=$2",[await hashClassPilotPin("1234"),studentId]);
    bound=await guard(installationA.installationCredential);assert.equal(bound.status,201);chrome=await pair(bound.body.guardCredential);
    await fixture.query("UPDATE classpilot_windows_guards SET expires_at=now()-interval '1 second' WHERE id=$1",[bound.body.guardCredential.split(".")[3]]);
    assert.equal((await heartbeat(chrome,1,"https://expired.example.edu")).status,401);assert.equal((await request("/guards/renew","POST",{osSessionNonce:bound.nonce},bound.body.guardCredential)).status,401);
    bound=await guard(installationA.installationCredential);assert.equal(bound.status,201);chrome=await pair(bound.body.guardCredential);edge=await pair(bound.body.guardCredential,"edge");
  });
  await t.test("administrator installation revocation releases the student for a different installation immediately",async()=>{
    const revoked=await request(`/installations/${installationA.installationCredential.split(".")[3]}`,"DELETE",undefined,adminToken,staffHeaders());assert.equal(revoked.status,204);
    assert.equal((await heartbeat(chrome,1,"https://revoked.example.edu")).status,401);
    assert.equal((await request("/guards/renew","POST",{osSessionNonce:bound.nonce},bound.body.guardCredential)).status,401);
    bound=await guard(installationB.installationCredential);assert.equal(bound.status,201,JSON.stringify(bound.body));
    chrome=await pair(bound.body.guardCredential);edge=await pair(bound.body.guardCredential,"edge");installationA=installationB;
  });
  await t.test("a current teacher announcement retries failed application and a completed exact ACK stops retry",async()=>{
    const announcement=await command("teacher-message",{message:"Synthetic retry announcement"});assert.equal(announcement.status,201,JSON.stringify(announcement.body));
    const first=await heartbeat(chrome,1,"https://chrome.example.edu/retry");assert.equal(first.status,200);
    const frame=first.body.messages.find((message:any)=>message.commandId===announcement.body.command.id);assert.ok(frame);
    const acknowledge=(ackState:string)=>request("/browser/command-acks","POST",{...source(chrome),acks:[{ackId:randomUUID(),commandId:announcement.body.command.id,
      ackState,...frame.exactBinding,studentControlRevision:frame.exactBinding.controlRevision,outcome:ackState==="completed"?"applied":"failed"}]},chrome.studentToken);
    const failed=await acknowledge("failed");assert.equal(failed.status,200);assert.equal(failed.body.receipts[0].accepted,true);
    const retried=await heartbeat(chrome,2,"https://chrome.example.edu/retry");assert.equal(retried.status,200);assert.ok(retried.body.messages.some((message:any)=>message.commandId===announcement.body.command.id));
    const completed=await acknowledge("completed");assert.equal(completed.status,200);assert.equal(completed.body.receipts[0].accepted,true);
    const finished=await heartbeat(chrome,3,"https://chrome.example.edu/retry");assert.equal(finished.status,200);assert.equal(finished.body.messages.some((message:any)=>message.commandId===announcement.body.command.id),false);
  });
  await t.test("policy batches retain unavailable students and deliver only the original available browser audience",async()=>{
    const before=(await fixture.query("SELECT revision,desired_state FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=$2",[schoolId,secondStudentId])).rows;
    const body={teachingSessionId,targetScope:"students",targetStudentIds:[studentId,secondStudentId],commandType:"attention-mode",commandPayload:{active:true}};
    const refused=await request("/commands","POST",body,adminToken,staffHeaders());assert.equal(refused.status,403,"Observe never becomes policy authority");
    const response=await request("/commands","POST",body,teacherToken,staffHeaders());assert.equal(response.status,201,JSON.stringify(response.body));
    assert.equal(response.body.summary.requested,3);assert.equal(response.body.summary.pending,2);assert.equal(response.body.summary.unavailable,1);
    const unavailable=response.body.targets.find((target:any)=>target.studentId===secondStudentId);assert.equal(unavailable.status,"unavailable");assert.equal(unavailable.result.code,"WINDOWS_SOURCE_UNAVAILABLE");
    assert.equal(unavailable.sourceRef,undefined);assert.equal(unavailable.browserFamily,undefined);assert.equal(unavailable.bindingRevision,undefined);
    assert.deepEqual((await fixture.query("SELECT revision,desired_state FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=$2",[schoolId,secondStudentId])).rows,before);
    const persisted=await request(`/commands/${response.body.command.id}?teachingSessionId=${teachingSessionId}`,"GET",undefined,teacherToken,staffHeaders());
    assert.deepEqual(persisted.body.targets,response.body.targets);assert.equal(persisted.body.command.commandPayload._windowsUnavailableStudentTargets,undefined);
    const hb=await heartbeat(chrome,4,"https://chrome.example.edu/partial");assert.equal(hb.status,200);const frame=hb.body.messages.find((message:any)=>message.commandId===response.body.command.id);assert.ok(frame);
    assert.equal(frame.command.data._windowsUnavailableStudentTargets,undefined);assert.equal(hb.body.classroomState.restrictions.attentionMode.active,true);
    const forged=await request("/commands","POST",{...body,commandPayload:{active:true,_windowsUnavailableStudentTargets:[{id:randomUUID(),studentId:randomUUID(),code:"WINDOWS_SOURCE_UNAVAILABLE"}]}},teacherToken,staffHeaders());assert.equal(forged.status,400);
    const empty=await request("/commands","POST",{...body,targetStudentIds:[]},teacherToken,staffHeaders());assert.equal(empty.status,400);
    const allUnavailable=await request("/commands","POST",{...body,targetStudentIds:[secondStudentId]},teacherToken,staffHeaders());assert.equal(allUnavailable.status,201);assert.equal(allUnavailable.body.summary.requested,1);assert.equal(allUnavailable.body.summary.unavailable,1);assert.equal(allUnavailable.body.summary.pending,0);
  });
  await t.test("teacher and browser sign-out retire guard and both children; legacy uniqueness remains unchanged",async()=>{
    const signed=await command("student-sign-out",{});assert.equal(signed.status,201);assert.equal(signed.body.summary.completed,2);
    assert.equal((await heartbeat(chrome,1,"https://signedout.example.edu")).status,401);assert.equal((await request("/guards/renew","POST",{osSessionNonce:bound.nonce},bound.body.guardCredential)).status,401);
    const unavailable=(await tiles()).body.tiles[0];assert.equal(unavailable.platform,"windows");assert.equal(unavailable.windowsSession.state,"unavailable");assert.equal(unavailable.browserOwner,undefined);
    const deviceId=`${tag}-legacy`;await inSchool(()=>storage.createDevice({schoolId,deviceId,classId:"default"}));
    const legacy=await inSchool(()=>storage.setActiveStudentForDevice(deviceId,studentId));assert.ok(legacy.id);
    const {classpilotPublicRealtimeBinding}=await import("../dist/services/classpilotRealtimeStatus.js");
    const handoff=(await tiles()).body.tiles[0];assert.deepEqual(handoff.browserOwner,{transport:"legacy",realtimeBinding:classpilotPublicRealtimeBinding(legacy.id)});
    assert.deepEqual(handoff.browserSources,[]);assert.equal(handoff.platform,undefined);assert.equal(handoff.windowsSession,undefined);
    assert.equal((await guard(installationA.installationCredential)).status,409);
    await fixture.query("UPDATE student_sessions SET is_active=false,ended_at=now() WHERE id=$1",[legacy.id]);
    const ended=(await tiles()).body.tiles[0];assert.equal(ended.platform,"windows");assert.equal(ended.browserOwner,undefined);
    bound=await guard(installationA.installationCredential);assert.equal(bound.status,201);chrome=await pair(bound.body.guardCredential);
    await assert.rejects(inSchool(()=>storage.startStudentSessionWithReplacements(schoolId,studentId,deviceId,{authKind:"managed_profile"})),(error:any)=>error.code==="WINDOWS_STUDENT_SESSION_CONFLICT");
    assert.equal((await request("/browser/action","POST",{...source(chrome),operation:"sign-out",payload:{}},chrome.studentToken)).status,200);
    assert.equal((await request("/guards/pairing-proofs","POST",{browserFamily:"edge",profileId:randomUUID(),challenge:randomBytes(32).toString("base64url")},bound.body.guardCredential)).status,401);
  });
});

test("Windows classification Redis publication preserves exact sequence bytes and absolute retention",async()=>{
  const {ClasspilotWindowsStore}=await import("../dist/services/classpilotWindowsStore.js");
  const redis=createClient({url:process.env.TEST_REDIS_URL});await redis.connect();
  const prefix=`${tag}:classification-lua:${randomUUID()}`,sourceRef=randomUUID();
  const store=new ClasspilotWindowsStore(args=>redis.sendCommand(args),prefix);
  try{
    await store.put("telemetry",schoolId,sourceRef,{sequence:Number.MAX_SAFE_INTEGER,sourceRef,bindingRevision:1},Date.now()+15_000,Number.MAX_SAFE_INTEGER);
    const keys=await redis.keys(`${prefix}:telemetry:*`);assert.equal(keys.length,1);const before=await redis.pTTL(keys[0]!);
    await pause(20);assert.equal(await store.patchClassification(schoolId,sourceRef,Number.MAX_SAFE_INTEGER,{category:"educational"}),true);
    const after=await redis.pTTL(keys[0]!);assert.ok(after>0&&after<=before-10,"classification must retain the existing absolute TTL");
    const stored=await store.get("telemetry",schoolId,sourceRef);assert.equal(stored?.sequence,Number.MAX_SAFE_INTEGER);assert.equal(stored?.aiCategory,"educational");
    await assert.rejects(store.put("telemetry",schoolId,sourceRef,{sequence:Number.MAX_SAFE_INTEGER},Date.now()+15_000,Number.MAX_SAFE_INTEGER),(error:any)=>error.code==="WINDOWS_SEQUENCE_STALE");
  }finally{const keys=await redis.keys(`${prefix}:*`);if(keys.length)await redis.del(keys);await redis.quit();}
});

test("actual Chrome and Edge use the isolated Windows broker and source-qualified API",{skip:!process.env.WINDOWS_BROWSER_INTEGRATION_SCRIPT},async()=>{
  process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1="true";
  const installationData=await installation();const signed=await guard(installationData.installationCredential);
  assert.equal(signed.status,201,"Synthetic integrated browser guard must be available");
  const {emptyClasspilotRestrictions}=await import("../dist/services/classpilotClassroomState.js");
  await inSchool(()=>storage.withClasspilotWindowsAuthority(schoolId,[studentId],database=>storage.setClasspilotWindowsRestrictions(schoolId,studentId,{restrictions:emptyClasspilotRestrictions()},database)));
  const artifactRoot=path.join(process.env.LOCALAPPDATA!,"ClassPilotDesktop","windows-browser-parity",tag);await mkdir(artifactRoot,{recursive:true});
  try{
    const script=path.resolve(process.env.WINDOWS_BROWSER_INTEGRATION_SCRIPT!);
    const summary=await new Promise<Record<string,any>>((resolve,reject)=>{
      const browserNode=process.env.WINDOWS_BROWSER_NODE_EXECUTABLE?path.resolve(process.env.WINDOWS_BROWSER_NODE_EXECUTABLE):process.execPath;
      const child=spawn(browserNode,[script],{cwd:path.dirname(script),windowsHide:true,stdio:["pipe","pipe","pipe"],
        env:Object.fromEntries(["PATH","SystemRoot","TEMP","TMP","LOCALAPPDATA","APPDATA","WINDOWS_EXTENSION_ARTIFACT"].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]))});
      let output="",bytes=0;const timer=setTimeout(()=>{child.kill();reject(new Error("WINDOWS_BROWSER_E2E_TIMEOUT"));},300_000);
      child.stdout.on("data",chunk=>{bytes+=chunk.length;if(bytes>16_384){child.kill();reject(new Error("WINDOWS_BROWSER_E2E_OUTPUT_LIMIT"));}else output+=String(chunk);});
      child.stderr.on("data",()=>{/* Browser diagnostics can contain navigation data; never print them. */});
      child.on("error",()=>{clearTimeout(timer);reject(new Error("WINDOWS_BROWSER_E2E_START_FAILED"));});
      child.on("close",code=>{clearTimeout(timer);if(code!==0)return reject(new Error("WINDOWS_BROWSER_E2E_FAILED"));try{resolve(JSON.parse(output));}catch{reject(new Error("WINDOWS_BROWSER_E2E_INVALID_SUMMARY"));}});
      child.stdin.end(JSON.stringify({origin:base,guardCredential:signed.body.guardCredential,osSessionNonce:signed.nonce,teacherCredential:teacherToken,schoolId,studentId,teachingSessionId,artifactRoot}));
    });
    assert.equal(summary.schemaVersion,1);assert.equal(summary.chrome?.authenticated,true);assert.equal(summary.edge?.authenticated,true);
    assert.notEqual(summary.chrome?.sourceRef,summary.edge?.sourceRef);assert.equal(summary.exactTabAction,true);assert.equal(summary.bothBrowserPolicy,true);assert.equal(summary.acknowledgment,true);assert.equal(summary.legacyCredentialLeak,false);
    for(const key of ["realServerTools","studentResponseDeduplication","privateChat","sourceQualifiedScreenshots"])assert.equal(summary[key],true,key);
  }finally{await request("/guards","DELETE",{},signed.body.guardCredential);await request(`/installations/${installationData.installationCredential.split(".")[3]}`,"DELETE",undefined,adminToken,staffHeaders());}
});
