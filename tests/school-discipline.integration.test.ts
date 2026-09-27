import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import session from "express-session";
import pg from "pg";
import { z } from "zod";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema/index.js";
import { pool, sessionPool } from "../src/db.js";
import { SCHOOL_DISCIPLINE_REDESIGN_SQL } from "../src/db/schoolDisciplineRedesignMigration.js";
import { MYDESK_GRADE_FILING_SQL } from "../src/db/mydeskGradeFilingMigration.js";
import { MYDESK_IMPORT_DESTINATION_SQL } from "../src/db/mydeskImportDestinationMigration.js";
import sharp from "sharp";
import { SCHOOL_DISCIPLINE_SQL } from "../src/db/schoolDisciplineMigration.js";
import { MYDESK_SQL } from "../src/db/mydeskMigration.js";
import { createSchoolDisciplineRouter } from "../src/routes/schoolDiscipline.js";
import { cleanupSchoolDiscipline } from "../src/services/schoolDisciplineCleanup.js";
import { listDisciplineStudents } from "../src/services/schoolDisciplineWorkspace.js";
import { datePlusDays, emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";
import { signUserToken } from "../src/services/jwt.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { myDeskUpstreamErrorBoundary } from "../src/middleware/mydeskUpstreamErrorBoundary.js";
import type { MyDeskObjectStore } from "../src/services/mydeskFiles.js";

const fixturePool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL, max: 2 });
const fixtureDb = drizzle(fixturePool, { schema });
const schoolIds: string[] = [], objects = new Map<string, Buffer>();
let getHook: ((key: string) => Promise<void>) | null = null, putHook: ((key: string) => Promise<void>) | null = null;
let deleteFails = false;
const store: MyDeskObjectStore = {
  async put(key, bytes) { await putHook?.(key); objects.set(key, Buffer.from(bytes)); },
  async get(key) { await getHook?.(key); const bytes = objects.get(key); if (!bytes) throw new Error("private filename/provider diagnostic must never escape"); return Buffer.from(bytes); },
  async delete(key) { if (deleteFails) throw new Error("private diagnostic"); objects.delete(key); },
};
let server: Server, baseUrl: string;
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  if (process.env.ADMIN_DATABASE_URL) assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.ADMIN_DATABASE_URL).hostname));
  await fixturePool.query(MYDESK_SQL); await fixturePool.query(SCHOOL_DISCIPLINE_SQL);
  await fixturePool.query(MYDESK_GRADE_FILING_SQL); await fixturePool.query(MYDESK_IMPORT_DESTINATION_SQL); await fixturePool.query(SCHOOL_DISCIPLINE_REDESIGN_SQL);
  if (process.env.RLS_GUC_ENABLED === "true") {
    assert.match(process.env.RLS_TEST_ROLE || "", /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
    await fixturePool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON school_discipline_records,school_discipline_versions,school_discipline_attachments,school_discipline_access TO "${process.env.RLS_TEST_ROLE}"`);
    const role = await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.equal(role.rows[0].rolsuper, false); assert.equal(role.rows[0].rolbypassrls, false);
  }
  const app = express(); app.use(express.json());
  app.use(session({ secret: "discipline-synthetic-test-session-only", resave: false, saveUninitialized: false }));
  app.post("/fixture/impersonate", (req, res) => {
    req.session.userId = req.body.targetId; req.session.originalUserId = req.body.originalId; req.session.impersonating = true; req.session.authVersion = 1;
    res.json({ ok: true });
  });
  app.use("/api/classpilot/discipline-records", (req, res, next) => {
    if (req.headers["x-fixture-drop-response"] === "1") res.json = () => { res.destroy(); return res; }; next();
  }, createSchoolDisciplineRouter(store));
  app.use("/api/classpilot/discipline-records", myDeskUpstreamErrorBoundary); app.use(errorHandler);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL app.is_super='on'");
    await client.query("UPDATE schools SET deleted_at=now() WHERE id=ANY($1::text[])", [schoolIds]);
    for (const table of ["school_discipline_attachments", "school_discipline_versions", "school_discipline_records", "school_discipline_access", "mydesk_attachments", "mydesk_notes", "audit_logs"])
      await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    for (const table of ["group_students", "group_teachers"]) await client.query(`DELETE FROM ${table} WHERE group_id IN(SELECT id FROM groups WHERE school_id=ANY($1::text[]))`, [schoolIds]);
    for (const table of ["groups", "students", "classpilot_school_schedules", "settings", "school_memberships", "product_licenses"]) await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await Promise.all([pool.end(), sessionPool.end(), fixturePool.end()]); }
});
async function fixture() {
  const f = { schoolId: randomUUID(), teacher: randomUUID(), other: randomUUID(), admin: randomUUID(), super: randomUUID(), outside: randomUUID(),
    office: randomUUID(), groupId: randomUUID(), studentId: randomUUID(), noteId: randomUUID(), attachmentIds: [] as string[] };
  schoolIds.push(f.schoolId);
  await fixturePool.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Synthetic discipline school','active',true,'active','UTC')", [f.schoolId]);
  await fixturePool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [f.schoolId]);
  for (const [id, role] of [[f.teacher,"teacher"], [f.other,"teacher"], [f.admin,"school_admin"], [f.super,"teacher"], [f.outside,null], [f.office,"office_staff"]]) {
    await fixturePool.query("INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Synthetic','Staff',$3)", [id, `${id}@example.test`, id === f.super || id === f.outside]);
    if (role) await fixturePool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [f.schoolId,id,role]);
  }
  await fixtureTransaction(async client => {
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Fifth science','admin_class','active')", [f.groupId,f.schoolId,f.teacher]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [f.groupId,f.teacher]);
  });
  await fixturePool.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Synthetic','Student','active')", [f.studentId,f.schoolId]);
  await fixturePool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId,f.studentId]);
  await fixturePool.query(`INSERT INTO mydesk_notes(id,school_id,author_id,client_request_id,request_fingerprint,target_kind,group_id,filing_group_id,group_name,student_id,filing_student_id,student_name,category,title,body,entry_date,status)
    VALUES($1,$2,$3,$4,$5,'student',$6,$6,'Fifth science',$7,$7,'Synthetic Student','referral','=FORMULA()','Reported classroom incident.','2026-09-26','active')`,
    [f.noteId,f.schoolId,f.teacher,randomUUID(),"a".repeat(64),f.groupId,f.studentId]);
  process.env.MYDESK_MODE = "on"; return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixtureTransaction(operation: (client: pg.PoolClient) => Promise<void>) {
  const client=await fixturePool.connect();
  try { await client.query("BEGIN"); await operation(client); await client.query("COMMIT"); }
  catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function deactivateFixtureTeacher(f: Fixture) {
  // A departing teacher must hand off their live class and its primary mirror
  // atomically. Private notes and cleanup work still belong to the old author.
  await fixtureTransaction(async client => {
    await client.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [f.groupId, f.other]);
    await client.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.teacher]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [f.groupId, f.other]);
    await client.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [f.schoolId, f.teacher]);
  });
  assert.equal((await request(f, "/capabilities")).status, 403);
}
async function addEvidence(f: Fixture) {
  const id = randomUUID(), key = `mydesk/${f.schoolId}/${f.teacher}/${f.noteId}/${id}`, bytes = Buffer.from(`synthetic image ${id}`);
  objects.set(key, bytes);
  await fixturePool.query(`INSERT INTO mydesk_attachments(id,school_id,author_id,note_id,client_request_id,request_fingerprint,storage_key,original_filename,content_type,input_sha256,sha256,byte_size,status,committed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'selected-photo.jpg','image/jpeg',$6,$6,$8,'ready',now())`,
    [id,f.schoolId,f.teacher,f.noteId,randomUUID(),createHash("sha256").update(bytes).digest("hex"),key,bytes.length]);
  f.attachmentIds.push(id); return { id, key, bytes };
}
async function request(f: Fixture, path: string, method = "GET", body?: unknown, user = f.teacher, extra: Record<string,string> = {}) {
  const response = await fetch(baseUrl + "/api/classpilot/discipline-records" + path, { method, headers: { "x-school-id": f.schoolId, "content-type": "application/json",
    authorization: `Bearer ${signUserToken({ userId: user, email: `${user}@example.test`, authVersion: 1 })}`, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString("utf8");
  return { status: response.status, data: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text, bytes, text, headers: response.headers };
}
const submitInput = (f: Fixture) => ({ clientRequestId: randomUUID(), noteId: f.noteId, noteRevision: 1, attachmentIds: [...f.attachmentIds] });
async function submit(f: Fixture) { const response = await request(f,"/submit","POST",submitInput(f)); assert.equal(response.status,201,response.text); return response.data.record; }
const correctionInput = (f: Fixture, record: any) => ({ clientRequestId: randomUUID(), revision: record.revision, reason: "Corrected the factual account", groupId: f.groupId,
  studentId: f.studentId, category: "referral", title: "Corrected account", body: "Teacher reported the observed event.", entryDate: "2026-09-26", attachmentIds: record.currentVersion.attachments.map((a:any) => a.id), ...(record.currentVersion.schemaVersion === 2 ? { referralRecorded: record.currentVersion.referralRecorded, detentionAssigned: record.currentVersion.detentionAssigned, detentionDates: record.currentVersion.detentionDates } : {}) });
const draftInput = (f: Fixture, overrides: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), studentId: f.studentId,
  groupId: f.groupId, category: "referral", title: "Incident", body: "Observed classroom action.", entryDate: "2026-09-26",
  referralRecorded: true, detentionAssigned: false, detentionDates: [], ...overrides });
async function draft(f: Fixture, overrides: Record<string, unknown> = {}, user = f.teacher) {
  const response = await request(f,"/drafts","POST",draftInput(f,overrides),user); assert.equal(response.status,201,response.text); return response.data.draft;
}
async function finish(f: Fixture, item: any, attachmentIds: string[] = [], extra: Record<string,unknown> = {}, user=f.teacher) {
  const duplicates = await request(f,`/${item.id}/duplicates`,"GET",undefined,user); assert.equal(duplicates.status,200,duplicates.text);
  const input = {clientRequestId:randomUUID(),revision:item.revision,attachmentIds,reviewed:true,acknowledgedDuplicateIds:duplicates.data.candidates.map((c:any)=>c.id),acknowledgedDuplicates:duplicates.data.candidates.map((c:any)=>({id:c.id,revision:c.revision})),...extra};
  const result = await request(f,`/${item.id}/finalize`,"POST",input,user); assert.equal(result.status,200,result.text); return {record:result.data.record,input};
}
async function upload(f: Fixture, item: any) {
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#fff'}}).png().toBuffer();
  const reserved=await request(f,`/${item.id}/attachments`,"POST",{clientRequestId:randomUUID(),revision:item.revision,filename:"synthetic.png",contentType:"image/png",size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  assert.equal(reserved.status,201,reserved.text); item.revision=reserved.data.revision;
  const response=await fetch(baseUrl+`/api/classpilot/discipline-records/${item.id}/attachments/${reserved.data.attachment.id}/content`,{method:'PUT',headers:{'x-school-id':f.schoolId,'content-type':'image/png',authorization:`Bearer ${signUserToken({userId:f.teacher,email:`${f.teacher}@example.test`,authVersion:1})}`},body:new Uint8Array(bytes)});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return z.object({ attachment: z.object({ id: z.string() }).passthrough() }).parse(result).attachment;
}

test("automatic administrators and current assigned co-teachers; self-created groups never grant shared access", async()=>{
  const f=await fixture(), foreign=await fixture(), record=await submit(f);
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.admin)).status,200);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.admin)).data.canManageAccess,false);
  assert.equal((await request(f,`/access/${f.admin}`,"PUT",{enabled:true,revision:0,clientRequestId:randomUUID()},f.admin)).status,410);
  for(const user of [f.other,f.super]) assert.equal((await request(f,`/${record.id}`,"GET",undefined,user)).status,404);
  for(const user of [f.outside,f.office]) assert.equal((await request(f,"/capabilities","GET",undefined,user)).status,403);
  const personal=randomUUID();await fixtureTransaction(async tx=>{
    await tx.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Self-selected','teacher_created','active')",[personal,f.schoolId,f.other]);
    await tx.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')",[personal,f.other]);
  });
  await fixturePool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)",[personal,f.studentId]);
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.other)).status,404);
  await fixturePool.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'co-teacher')",[f.groupId,f.other]);
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.other)).status,200);
  assert.equal((await request(f,`/${record.id}/correct`,"POST",correctionInput(f,record),f.other)).status,404);
  await fixturePool.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2",[f.groupId,f.other]);
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.other)).status,404);
  assert.equal((await request(foreign,`/${record.id}`)).status,404);
  const impersonation=await fetch(baseUrl+"/fixture/impersonate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targetId:f.admin,originalId:f.outside})});
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.admin,{cookie:impersonation.headers.get("set-cookie")!.split(";",1)[0]!})).status,403);
});

test("former students immediately leave shared access, even for the submitting teacher; school evidence survives",async()=>{
  const f=await fixture(),selected=await addEvidence(f),record=await submit(f),a=record.currentVersion.attachments[0];
  await fixturePool.query("UPDATE mydesk_notes SET status='deleted',deleted_at=now(),body='private edit',revision=2 WHERE id=$1",[f.noteId]);objects.delete(selected.key);
  await fixturePool.query("UPDATE groups SET status='archived' WHERE id=$1",[f.groupId]);
  for(const path of [`/${record.id}`,`/${record.id}/versions/${record.currentVersion.id}/attachments/${a.id}/content`]) assert.equal((await request(f,path)).status,404);
  assert.equal((await request(f,"/search","POST",{})).data.records.length,0);
  const shown=await request(f,`/${record.id}`,"GET",undefined,f.admin);assert.equal(shown.status,200);assert.equal(shown.data.record.currentVersion.body,"Reported classroom incident.");
  const bytes=await request(f,`/${record.id}/versions/${record.currentVersion.id}/attachments/${a.id}/content`,"GET",undefined,f.admin);assert.equal(bytes.status,200);assert.deepEqual(bytes.bytes,selected.bytes);
  const corrected=await request(f,`/${record.id}/correct`,"POST",correctionInput(f,record),f.admin);assert.equal(corrected.status,200,corrected.text);
  assert.equal(corrected.data.record.currentVersion.editedById,f.admin);
  await assert.rejects(fixturePool.query("UPDATE school_discipline_versions SET snapshot='{}' WHERE id=$1",[record.currentVersion.id]),/immutable/);
});

test("wrong-student correction does not expose former student's version or evidence to the new student's teacher",async()=>{
  const f=await fixture();await addEvidence(f);const record=await submit(f),previous=record.currentVersion;
  const student=randomUUID(),group=randomUUID();await fixturePool.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Second','Student','active')",[student,f.schoolId]);
  await fixtureTransaction(async tx=>{
    await tx.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Sixth','admin_class','active')",[group,f.schoolId,f.other]);
    await tx.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')",[group,f.other]);
  });
  await fixturePool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)",[group,student]);
  const corrected=await request(f,`/${record.id}/correct`,"POST",{...correctionInput(f,record),studentId:student,groupId:group,attachmentIds:[]},f.admin);assert.equal(corrected.status,200,corrected.text);
  const second=await request(f,`/${record.id}`,"GET",undefined,f.other);assert.equal(second.status,200);assert.equal(second.data.record.versions.length,1);
  const privateOld=await request(f,`/${record.id}/versions/${previous.id}/attachments/${previous.attachments[0].id}/content`,"GET",undefined,f.other);assert.equal(privateOld.status,404);
  assert.equal((await request(f,`/${record.id}`)).status,404);
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.admin)).data.record.versions.length,2);
});

test("direct reviewed saves need no notebook, one detention assignment counts once despite multiple dates, and summaries span pages",async()=>{
  const f=await fixture();await fixturePool.query("UPDATE students SET grade_level='5' WHERE id=$1",[f.studentId]);
  const noNotes=randomUUID();await fixturePool.query("INSERT INTO students(id,school_id,first_name,last_name,grade_level,status) VALUES($1,$2,'Zero','Notes','5','active')",[noNotes,f.schoolId]);await fixturePool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)",[f.groupId,noNotes]);
  for(let i=0;i<3;i++) await finish(f,await draft(f,{entryDate:`2026-09-${20+i}`,detentionAssigned:i===0,detentionDates:i===0?["2026-09-25","2026-09-26"]:[]}));
  const result=await request(f,"/students/search","POST",{scope:"assigned",period:"all",limit:1});assert.equal(result.status,200,result.text);
  const second=await request(f,"/students/search","POST",{scope:"assigned",period:"all",limit:1,cursor:result.data.nextCursor});
  const rows=[...result.data.students,...second.data.students];assert.equal(rows.length,2);
  assert.deepEqual(rows.find((row:any)=>row.id===f.studentId).referralCount,3);assert.equal(rows.find((row:any)=>row.id===f.studentId).detentionCount,1);assert.equal(rows.find((row:any)=>row.id===noNotes).incidentCount,0);
  const csv=await request(f,"/students/export","POST",{scope:"assigned",period:"all"});assert.equal(csv.status,200);assert.equal(csv.headers.get("x-discipline-row-count"),"2");
  const count=await fixturePool.query("SELECT count(*)::int n FROM mydesk_notes WHERE school_id=$1",[f.schoolId]);assert.equal(count.rows[0].n,1,"Only fixture note exists; direct incident creates no notebook note");
});

test("same private-note source and lost-response requests cannot create duplicate records",async()=>{
  const f=await fixture(),input=submitInput(f);await assert.rejects(request(f,"/submit","POST",input,f.teacher,{"x-fixture-drop-response":"1"}));
  const retry=await request(f,"/submit","POST",input);assert.equal(retry.status,200,retry.text);
  const another=await request(f,"/submit","POST",submitInput(f));assert.equal(another.status,200,another.text);assert.equal(another.data.record.id,retry.data.record.id);
  const count=await fixturePool.query("SELECT count(*)::int n FROM school_discipline_records WHERE school_id=$1",[f.schoolId]);assert.equal(count.rows[0].n,1);
});

test("direct review revisions, duplicate warnings, immutable admin corrections and withdrawal preserve accurate totals",async()=>{
  const f=await fixture(),first=await draft(f),saved=await finish(f,first);const replay=await request(f,`/${first.id}/finalize`,"POST",saved.input);assert.equal(replay.status,200,replay.text);
  const second=await draft(f);const unreviewed=await request(f,`/${second.id}/finalize`,"POST",{clientRequestId:randomUUID(),revision:second.revision,attachmentIds:[],reviewed:true});assert.equal(unreviewed.status,409);assert.equal(unreviewed.data.code,"DISCIPLINE_DUPLICATE_REVIEW_REQUIRED");
  const revision=await request(f,`/${second.id}/draft`,"PATCH",{...draftInput(f),revision:second.revision,body:"Edited after initial review"});assert.equal(revision.status,200,revision.text);
  const stale=await request(f,`/${second.id}/finalize`,"POST",{...saved.input,clientRequestId:randomUUID(),revision:second.revision});assert.equal(stale.status,409);
  const corrected=await request(f,`/${saved.record.id}/correct`,"POST",{...correctionInput(f,saved.record),referralRecorded:true,detentionAssigned:true,detentionDates:["2026-09-27"]},f.admin);assert.equal(corrected.status,200,corrected.text);
  const summary=await request(f,"/students/search","POST",{period:"all"});assert.equal(summary.data.students[0].incidentCount,1);assert.equal(summary.data.students[0].detentionCount,1);
  const withdrawn=await request(f,`/${saved.record.id}/withdraw`,"POST",{clientRequestId:randomUUID(),revision:2,reason:"Duplicate incident confirmed"},f.admin);assert.equal(withdrawn.status,200,withdrawn.text);
  assert.equal((await request(f,"/students/search","POST",{period:"all"})).data.students[0].incidentCount,0);
});

test("direct attachments are normalized, bounded, private until save, and promoted safely",async()=>{
  const f=await fixture(),item=await draft(f,{title:"",body:""}),file=await upload(f,item);
  assert.equal(file.contentType,"image/jpeg");assert.equal((await request(f,`/${item.id}`,"GET",undefined,f.admin)).status,404);
  assert.equal((await request(f,`/${item.id}/draft`,"GET",undefined,f.admin)).status,404);
  const preview=await request(f,`/${item.id}/attachments/${file.id}/content`);assert.equal(preview.status,200);assert.equal(preview.headers.get("cache-control"),"private, no-store");
  assert.equal((await request(f,`/${item.id}/attachments/${file.id}/content`,"GET",undefined,f.admin)).status,404);
  const saved=await finish(f,item,[file.id]);assert.equal(saved.record.currentVersion.attachments.length,1);
  assert.equal((await request(f,`/${item.id}/attachments/${file.id}/content`)).status,404);
  const bytes=await request(f,`/${item.id}/versions/${saved.record.currentVersion.id}/attachments/${file.id}/content`);assert.equal(bytes.status,200);assert.equal(bytes.headers.get("cache-control"),"private, no-store");
  const metadata=await sharp(bytes.bytes).metadata();assert.equal(metadata.exif,undefined);assert.ok(metadata.width!<=1600);
  await cleanupSchoolDiscipline({database:fixtureDb,store,now:new Date(Date.now()+48*60*60_000)});
  assert.equal((await request(f,`/${item.id}/versions/${saved.record.currentVersion.id}/attachments/${file.id}/content`)).status,200);
});

test("add evidence creates a correction with independent copies and keeps incident totals unchanged",async()=>{
  const f=await fixture();const first=await draft(f),a=await upload(f,first),saved=await finish(f,first,[a.id]);
  const second=await draft(f),b=await upload(f,second);
  const added=await finish(f,second,[b.id],{duplicateAction:"add_evidence",existingRecordId:saved.record.id,existingRevision:1,reason:"Continuation form for the same incident"});
  assert.equal(added.record.id,saved.record.id);assert.equal(added.record.revision,2);assert.equal(added.record.currentVersion.attachments.length,2);
  assert.equal(added.record.versions.find((v:any)=>v.number===1).attachments.length,1);
  const retry=await request(f,`/${second.id}/finalize`,"POST",added.input);assert.equal(retry.status,200,retry.text);assert.equal(retry.data.receipt.revision,2);
  const totals=await request(f,"/students/search","POST",{period:"all"});assert.equal(totals.data.students[0].incidentCount,1);
});

test("revocation during evidence fetch denies bytes, reactivation follows current administrator membership",async()=>{
  const f=await fixture();await addEvidence(f);const record=await submit(f);let once=false;
  getHook=async()=>{if(!once){once=true;await fixturePool.query("UPDATE school_memberships SET role='teacher' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);}};
  const a=record.currentVersion.attachments[0];const response=await request(f,`/${record.id}/versions/${record.currentVersion.id}/attachments/${a.id}/content`,"GET",undefined,f.admin);getHook=null;assert.equal(response.status,404,response.text);
  await fixturePool.query("UPDATE school_memberships SET role='school_admin' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);assert.equal((await request(f,"/capabilities","GET",undefined,f.admin)).data.canViewSchool,true);
});

test("source changes or roster departure during evidence copy never publish; failed preparation remains cleanup-owned",async()=>{
  const f=await fixture();await addEvidence(f);let touched=false;
  putHook=async()=>{if(!touched){touched=true;await fixturePool.query("UPDATE mydesk_notes SET body='Changed after review',revision=2 WHERE id=$1",[f.noteId]);}};
  const response=await request(f,"/submit","POST",submitInput(f));putHook=null;assert.equal(response.status,409,response.text);
  assert.equal((await request(f,"/search","POST",{})).data.records.length,0);
  await deactivateFixtureTeacher(f);
  await fixturePool.query("UPDATE school_discipline_versions SET created_at=now()-interval '25 hours' WHERE school_id=$1",[f.schoolId]);
  await fixturePool.query("UPDATE school_discipline_attachments SET lease_until=NULL WHERE school_id=$1",[f.schoolId]);
  const keys=(await fixturePool.query("SELECT storage_key FROM school_discipline_attachments WHERE school_id=$1",[f.schoolId])).rows.map(row=>row.storage_key);
  deleteFails=true;await cleanupSchoolDiscipline({database:fixtureDb,store});deleteFails=false;assert.ok(keys.every(key=>objects.has(key)));
  await cleanupSchoolDiscipline({database:fixtureDb,store,now:new Date(Date.now()+120_000)});assert.ok(keys.every(key=>!objects.has(key)));
});

test("cancelled and omitted draft files are durably removed even with published parent or disabled membership",async()=>{
  const f=await fixture(),item=await draft(f),file=await upload(f,item);await finish(f,item,[]);
  const key=(await fixturePool.query("SELECT storage_key FROM school_discipline_attachments WHERE id=$1",[file.id])).rows[0].storage_key;assert.ok(objects.has(key));
  await cleanupSchoolDiscipline({database:fixtureDb,store});assert.equal(objects.has(key),false);
  const cancel=await draft(f),second=await upload(f,cancel),input={clientRequestId:randomUUID(),revision:cancel.revision};
  assert.equal((await request(f,`/${cancel.id}/draft`,"DELETE",input)).status,200);assert.equal((await request(f,`/${cancel.id}/draft`,"DELETE",input)).status,200);
  await deactivateFixtureTeacher(f);
  await cleanupSchoolDiscipline({database:fixtureDb,store});assert.equal((await fixturePool.query("SELECT status FROM school_discipline_attachments WHERE id=$1",[second.id])).rows[0].status,"deleted");
});

test("concurrent corrections publish one revision and operational audit does not contain narrative or filenames",async()=>{
  const f=await fixture(),record=await submit(f);
  const attempts=await Promise.all([request(f,`/${record.id}/correct`,"POST",correctionInput(f,record)),request(f,`/${record.id}/correct`,"POST",correctionInput(f,record),f.admin)]);
  assert.deepEqual(attempts.map(result=>result.status).sort(),[200,409]);
  const audit=await fixturePool.query("SELECT metadata::text FROM audit_logs WHERE school_id=$1 AND action LIKE 'discipline.%'",[f.schoolId]);
  assert.ok(audit.rows.every(row=>!row.metadata?.includes("Reported classroom")&&!row.metadata?.includes("selected-photo")));
});

test("grade normalization, incident/teacher filters, latest dates, and stale school-year configuration are explicit",async()=>{
  const f=await fixture();await fixturePool.query("UPDATE students SET grade_level='Grade 5' WHERE id=$1",[f.studentId]);
  await finish(f,await draft(f,{entryDate:'2026-08-25',detentionAssigned:true,detentionDates:['2026-08-26','2026-08-27']}));
  await finish(f,await draft(f,{entryDate:'2026-09-20'}));
  const typed=await request(f,'/students/search','POST',{scope:'assigned',period:'all',gradeLevel:'5th',incidentType:'detention',submitterName:'Synthetic'});
  assert.equal(typed.status,200,typed.text);assert.equal(typed.data.students.length,1);assert.equal(typed.data.students[0].referralCount,1);assert.equal(typed.data.students[0].detentionCount,1);assert.equal(typed.data.students[0].latestIncident,'2026-08-25');
  const history=await request(f,`/students/${f.studentId}/history`,'POST',{period:'all',incidentType:'detention'});assert.equal(history.status,200,history.text);assert.equal(history.data.records.length,1);
  const exportResult=await request(f,'/export','POST',{scope:'assigned',incidentType:'detention'});assert.equal(exportResult.status,200,exportResult.text);assert.equal(exportResult.headers.get('x-discipline-row-count'),'1');
  await fixturePool.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb)",[f.schoolId,JSON.stringify({yearStart:'2020-08-01',yearEnd:'2021-06-30'})]);
  const stale=await request(f,'/students/search','POST',{period:'school_year'});assert.equal(stale.status,200,stale.text);assert.equal(stale.data.range.period,'all');assert.match(stale.data.range.notice,/Showing all dates/);
  assert.equal(stale.data.range.noticeCode,'SCHOOL_YEAR_OUTSIDE_RANGE');
  assert.deepEqual(stale.data.range.configuredSchoolYear,{from:'2020-08-01',to:'2021-06-30'});
});

test("school-year summaries, history and exports distinguish missing, invalid, current and outside date ranges", async (t) => {
  const now = new Date(); now.setUTCHours(12, 0, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  const today = now.toISOString().slice(0, 10), from = datePlusDays(today, -30), to = datePlusDays(today, 30);
  const allDates = [datePlusDays(from, -1), from, today, to, datePlusDays(to, 1)].sort().reverse();
  const f = await fixture();
  for (const entryDate of allDates) await finish(f, await draft(f, { entryDate }));
  const saveRange = async (boundaries: Record<string, unknown>) => fixturePool.query(
    "INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb) ON CONFLICT(school_id) DO UPDATE SET config=EXCLUDED.config",
    [f.schoolId, JSON.stringify({ ...emptySchoolSchedulingConfig(), ...boundaries })],
  );
  const verify = async (query: Record<string, unknown>, expected: { period: string; from?: string; to?: string; noticeCode?: string; configuredSchoolYear?: { from: string; to: string } }, dates: string[]) => {
    const summary = await request(f, "/students/search", "POST", query);
    assert.equal(summary.status, 200, summary.text);
    assert.equal(summary.data.students[0].incidentCount, dates.length);
    assert.equal(summary.data.students[0].referralCount, dates.length);
    const { notice, ...range } = summary.data.range;
    assert.deepEqual(range, expected);
    if (expected.noticeCode) assert.match(notice, /Showing all dates/);
    else assert.equal(notice, undefined);
    if (expected.noticeCode === "SCHOOL_YEAR_OUTSIDE_RANGE") assert.match(notice, /configured school year .* does not include today/);
    const history = await request(f, `/students/${f.studentId}/history`, "POST", query);
    assert.equal(history.status, 200, history.text);
    assert.deepEqual(history.data.range, summary.data.range);
    assert.deepEqual(history.data.records.map((record: any) => record.currentVersion.entryDate), dates);
    const summaryExport = await request(f, "/students/export", "POST", query);
    assert.equal(summaryExport.status, 200, summaryExport.text);
    assert.equal(summaryExport.text.split("\r\n")[1], `"${f.studentId}","Synthetic Student","","${dates.length}","${dates.length}","0"`);
    const incidentExport = await request(f, "/export", "POST", { scope: "assigned", studentId: f.studentId, from: range.from, to: range.to });
    assert.equal(incidentExport.status, 200, incidentExport.text);
    assert.equal(incidentExport.headers.get("x-discipline-row-count"), String(dates.length));
  };

  const missing = { period: "all", noticeCode: "SCHOOL_YEAR_NOT_CONFIGURED" };
  await verify({ period: "school_year" }, missing, allDates);
  for (const boundaries of [{}, { yearStart: from }, { yearEnd: to }, { yearStart: "2026-02-30", yearEnd: to },
    { yearStart: 2026, yearEnd: to }, { yearStart: to, yearEnd: from }, { yearStart: from, yearEnd: datePlusDays(from, 551) }]) {
    await saveRange(boundaries);
    await verify({ period: "school_year" }, missing, allDates);
  }
  await saveRange({ yearStart: from, yearEnd: to });
  await verify({ period: "school_year", from: today, to: today },
    { period: "school_year", from, to, configuredSchoolYear: { from, to } }, [to, today, from]);
  await verify({ period: "all" }, { period: "all" }, allDates);
  await verify({ period: "all", from: today, to: today }, { period: "all", from: today, to: today }, [today]);
  await verify({ period: "custom", from: today, to: today }, { period: "custom", from: today, to: today }, [today]);
  for (const configuredSchoolYear of [
    { from: datePlusDays(today, -60), to: datePlusDays(today, -1) },
    { from: datePlusDays(today, 1), to: datePlusDays(today, 60) },
  ]) {
    await saveRange({ yearStart: configuredSchoolYear.from, yearEnd: configuredSchoolYear.to });
    await verify({ period: "school_year" }, { period: "all", noticeCode: "SCHOOL_YEAR_OUTSIDE_RANGE", configuredSchoolYear }, allDates);
  }
});

test("school-year availability follows the school's local date at a UTC day boundary", async (t) => {
  const now = new Date(); now.setUTCHours(2, 30, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  const utcToday = now.toISOString().slice(0, 10), localToday = datePlusDays(utcToday, -1);
  const f = await fixture();
  await fixturePool.query("UPDATE schools SET school_timezone='America/Los_Angeles' WHERE id=$1", [f.schoolId]);
  await fixturePool.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb)",
    [f.schoolId, JSON.stringify({ ...emptySchoolSchedulingConfig(), yearStart: localToday, yearEnd: localToday })]);
  const local = await request(f, "/students/search", "POST", { period: "school_year" });
  assert.equal(local.status, 200, local.text);
  assert.deepEqual(local.data.range, { period: "school_year", from: localToday, to: localToday, configuredSchoolYear: { from: localToday, to: localToday } });
  await fixturePool.query("UPDATE schools SET school_timezone='UTC' WHERE id=$1", [f.schoolId]);
  const utc = await request(f, "/students/search", "POST", { period: "school_year" });
  assert.equal(utc.status, 200, utc.text);
  assert.equal(utc.data.range.period, "all");
  assert.equal(utc.data.range.noticeCode, "SCHOOL_YEAR_OUTSIDE_RANGE");
  assert.deepEqual(utc.data.range.configuredSchoolYear, { from: localToday, to: localToday });
});

test("administrators retain deleted-student history from immutable snapshots, teachers do not",async()=>{
  const f=await fixture(),item=await draft(f,{groupId:null});await finish(f,item);
  await fixturePool.query("DELETE FROM group_students WHERE student_id=$1",[f.studentId]);
  await fixturePool.query("DELETE FROM students WHERE id=$1",[f.studentId]);
  assert.equal((await request(f,`/${item.id}`)).status,404);
  await listDisciplineStudents({schoolId:f.schoolId,authorId:f.admin},{scope:'school',period:'all',includeInactive:true});
  const school=await request(f,'/students/search','POST',{scope:'school',period:'all',includeInactive:true},f.admin);assert.equal(school.status,200,school.text);
  assert.equal(school.data.students[0].id,f.studentId);assert.equal(school.data.students[0].name,'Synthetic Student');assert.equal(school.data.students[0].incidentCount,1);
  const history=await request(f,`/students/${f.studentId}/history`,'POST',{scope:'school',period:'all',includeInactive:true},f.admin);assert.equal(history.status,200,history.text);assert.equal(history.data.records.length,1);
  const denied=await request(f,'/students/search','POST',{scope:'assigned',period:'all',includeInactive:true});assert.equal(denied.status,200);assert.equal(denied.data.students.length,0);
});


test("published create and mutation receipts cannot bypass current student authorization",async()=>{
  const f=await fixture(),input=draftInput(f),created=await request(f,"/drafts","POST",input),saved=await finish(f,created.data.draft);
  const correction=correctionInput(f,saved.record),corrected=await request(f,`/${saved.record.id}/correct`,"POST",correction);assert.equal(corrected.status,200,corrected.text);
  await fixturePool.query("DELETE FROM group_students WHERE group_id=$1 AND student_id=$2",[f.groupId,f.studentId]);
  for(const [path,body] of [["/drafts",input],[`/${saved.record.id}/finalize`,saved.input],[`/${saved.record.id}/correct`,correction]] as const)
    assert.equal((await request(f,path,"POST",body)).status,404);
});


test("older clients cannot silently drop version-two incident flags or filing snapshots",async()=>{
 const f=await fixture();await fixturePool.query("UPDATE students SET grade_level='5' WHERE id=$1",[f.studentId]);await fixturePool.query("UPDATE groups SET school_year='2026-2027' WHERE id=$1",[f.groupId]);
 const item=await draft(f,{referralRecorded:true,detentionAssigned:true,detentionDates:['2026-09-27','2026-09-28']}),saved=await finish(f,item);
 const complete=correctionInput(f,saved.record),old={...complete};delete old.referralRecorded;delete old.detentionAssigned;delete old.detentionDates;
 const denied=await request(f,`/${item.id}/correct`,"POST",old);assert.equal(denied.status,409);assert.equal(denied.data.code,'DISCIPLINE_REFRESH_REQUIRED');
 await fixturePool.query("UPDATE students SET grade_level='6' WHERE id=$1",[f.studentId]);await fixturePool.query("UPDATE groups SET school_year='2027-2028' WHERE id=$1",[f.groupId]);
 const updated=await request(f,`/${item.id}/correct`,"POST",complete);assert.equal(updated.status,200,updated.text);assert.equal(updated.data.record.currentVersion.gradeLevel,'5');assert.equal(updated.data.record.currentVersion.schoolYear,'2026-2027');assert.equal(updated.data.record.currentVersion.detentionAssigned,true);assert.deepEqual(updated.data.record.currentVersion.detentionDates,['2026-09-27','2026-09-28']);
});


test("student incident history paginates by incident date rather than upload order",async()=>{
 const f=await fixture();for(const entryDate of ['2026-09-26','2025-08-10','2026-02-01'])await finish(f,await draft(f,{entryDate}));
 const dates:string[]=[];let cursor: string|undefined;do{const page=await request(f,`/students/${f.studentId}/history`,'POST',{period:'all',limit:1,...(cursor?{cursor}:{})});assert.equal(page.status,200,page.text);dates.push(...page.data.records.map((r:any)=>r.currentVersion.entryDate));cursor=page.data.nextCursor;}while(cursor);
 assert.deepEqual(dates,['2026-09-26','2026-02-01','2025-08-10']);
});
