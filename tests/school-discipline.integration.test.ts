import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import session from "express-session";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema/index.js";
import { pool, sessionPool } from "../src/db.js";
import { SCHOOL_DISCIPLINE_SQL } from "../src/db/schoolDisciplineMigration.js";
import { MYDESK_SQL } from "../src/db/mydeskMigration.js";
import { createSchoolDisciplineRouter } from "../src/routes/schoolDiscipline.js";
import { cleanupSchoolDiscipline } from "../src/services/schoolDisciplineCleanup.js";
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
    for (const table of ["groups", "students", "settings", "school_memberships", "product_licenses"]) await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
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
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Fifth science','teacher_created','active')", [f.groupId,f.schoolId,f.teacher]);
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
  studentId: f.studentId, category: "referral", title: "Corrected account", body: "Teacher reported the observed event.", entryDate: "2026-09-26", attachmentIds: record.currentVersion.attachments.map((a:any) => a.id) });
async function grant(f: Fixture, enabled = true, revision = 0) { const response = await request(f,`/access/${f.admin}`,"PUT",{enabled,revision,clientRequestId:randomUUID()},f.admin); assert.equal(response.status,200,response.text); return response.data; }

test("explicit grants, ownership, tenant isolation, super-admin and impersonation denial", async () => {
  const f = await fixture(), other = await fixture(), record = await submit(f);
  for (const user of [f.other,f.admin,f.super]) assert.equal((await request(f,`/${record.id}`,"GET",undefined,user)).status,404);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.outside)).status,403);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.office)).status,403);
  await fixturePool.query("UPDATE school_memberships SET role='office_staff' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.other]);
  const demoted=await request(f,"/capabilities","GET",undefined,f.other);
  assert.equal(demoted.status,403); assert.equal(demoted.data.code,"DISCIPLINE_ACCESS_DENIED");
  const platform=await request(f,"/capabilities","GET",undefined,f.outside);
  assert.equal(platform.status,403); assert.equal(platform.data.code,"DISCIPLINE_ACCESS_DENIED");
  const unauthenticated=await fetch(baseUrl+"/api/classpilot/discipline-records/capabilities",{headers:{"x-school-id":f.schoolId}});
  assert.equal(unauthenticated.status,401);
  assert.equal((await request(f,"/search","POST",{scope:"school"},f.admin)).status,403);
  assert.equal((await request(f,`/access/${f.other}`,"PUT",{enabled:true,revision:0,clientRequestId:randomUUID()},f.admin)).status,404);
  await grant(f); const shown = await request(f,`/${record.id}`,"GET",undefined,f.admin);
  assert.equal(shown.status,200,shown.text); assert.equal(shown.data.record.canCorrect,false); assert.equal("sourceNoteId" in shown.data.record,false);
  assert.equal((await request(f,`/${record.id}/withdraw`,"POST",{revision:1,reason:"Administrator cannot mutate",clientRequestId:randomUUID()},f.admin)).status,404);
  assert.equal((await request(f,`/${record.id}/correct`,"POST",correctionInput(f,record),f.admin)).status,404);
  assert.equal((await request(other,`/${record.id}`)).status,404);
  const impersonation = await fetch(baseUrl + "/fixture/impersonate", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targetId:f.teacher,originalId:f.admin})});
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.teacher,{cookie:impersonation.headers.get("set-cookie")!.split(";",1)[0]!})).status,403);
  assert.equal(shown.headers.get("cache-control"),"private, no-store");
});

test("immutable school snapshot and separate selected evidence survive private deletion and archival", async () => {
  const f = await fixture(), selected = await addEvidence(f), excluded = await addEvidence(f);
  const input = {...submitInput(f),attachmentIds:[selected.id]}, result = await request(f,"/submit","POST",input);
  assert.equal(result.status,201,result.text); const record = result.data.record;
  assert.equal(record.currentVersion.attachments.length,1); assert.ok(!JSON.stringify(record).includes(excluded.id));
  await fixturePool.query("UPDATE mydesk_notes SET status='deleted',deleted_at=now(),body='private edit',revision=2 WHERE id=$1",[f.noteId]); objects.delete(selected.key);
  await fixturePool.query("UPDATE groups SET status='archived' WHERE id=$1",[f.groupId]);
  const shown = await request(f,`/${record.id}`); assert.equal(shown.status,200); assert.equal(shown.data.record.currentVersion.body,"Reported classroom incident.");
  const a = record.currentVersion.attachments[0], path = `/${record.id}/versions/${record.currentVersion.id}/attachments/${a.id}/content`;
  const bytes = await request(f,path); assert.equal(bytes.status,200,bytes.text); assert.deepEqual(bytes.bytes,selected.bytes);
  const corrected = await request(f,`/${record.id}/correct`,"POST",correctionInput(f,record)); assert.equal(corrected.status,200,corrected.text);
  assert.equal(corrected.data.record.versions.length,2); assert.equal(corrected.data.record.versions[1].body,"Reported classroom incident.");
  await assert.rejects(fixturePool.query("UPDATE school_discipline_versions SET snapshot='{}' WHERE id=$1",[record.currentVersion.id]),/immutable/);
  await grant(f); await fixturePool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.teacher]);
  assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.admin)).status,200);
  assert.equal((await request(f,`/${record.id}`)).status,403);
});

test("lost-response retry receipts and concurrent corrections do not duplicate publications", async () => {
  const f = await fixture(), input = submitInput(f);
  await assert.rejects(request(f,"/submit","POST",input,f.teacher,{"x-fixture-drop-response":"1"}));
  const retry = await request(f,"/submit","POST",input); assert.equal(retry.status,200,retry.text); const record = retry.data.record;
  const count = await fixturePool.query("SELECT count(*)::int AS n FROM school_discipline_records WHERE school_id=$1",[f.schoolId]); assert.equal(count.rows[0].n,1);
  const attempts = await Promise.all([request(f,`/${record.id}/correct`,"POST",correctionInput(f,record)),request(f,`/${record.id}/correct`,"POST",correctionInput(f,record))]);
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
  const withdrawal = {revision:2,clientRequestId:randomUUID(),reason:"Wrong account; withdrawn"};
  const withdrawn = await request(f,`/${record.id}/withdraw`,"POST",withdrawal); assert.equal(withdrawn.status,200,withdrawn.text);
  assert.equal((await request(f,`/${record.id}/withdraw`,"POST",withdrawal)).status,200);
  await fixturePool.query("UPDATE mydesk_notes SET status='deleted',deleted_at=now() WHERE id=$1",[f.noteId]);
  const lateRetry = await request(f,"/submit","POST",input); assert.equal(lateRetry.status,200); assert.equal(lateRetry.data.receipt.revision,1);
  assert.equal((await request(f,"/search","POST",{scope:"own"})).data.records.length,0);
  assert.equal((await request(f,"/search","POST",{scope:"own",status:"all"})).data.records.length,1);
});

test("source changes during copying cannot publish; abandoned reservations clean up without membership", async () => {
  const f = await fixture(); await addEvidence(f); let touched = false;
  putHook = async () => { if (!touched) { touched = true; await fixturePool.query("UPDATE mydesk_notes SET body='Changed after review',revision=2 WHERE id=$1",[f.noteId]); } };
  const response = await request(f,"/submit","POST",submitInput(f)); putHook = null;
  assert.equal(response.status,409,response.text); assert.equal(response.data.code,"DISCIPLINE_SOURCE_CHANGED");
  assert.equal((await request(f,"/search","POST",{})).data.records.length,0);
  await fixturePool.query("UPDATE groups SET status='archived' WHERE id=$1",[f.groupId]);
  await fixturePool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.teacher]);
  await fixturePool.query("UPDATE school_discipline_versions SET created_at=now()-interval '25 hours' WHERE school_id=$1",[f.schoolId]);
  await fixturePool.query("UPDATE school_discipline_attachments SET lease_until=NULL WHERE school_id=$1",[f.schoolId]);
  const keys = (await fixturePool.query("SELECT storage_key FROM school_discipline_attachments WHERE school_id=$1",[f.schoolId])).rows.map(r=>r.storage_key);
  deleteFails = true; await cleanupSchoolDiscipline({database:fixtureDb,store}); deleteFails = false;
  assert.ok(keys.every(key=>objects.has(key)));
  await cleanupSchoolDiscipline({database:fixtureDb,store,now:new Date(Date.now()+120_000)});
  assert.ok(keys.every(key=>!objects.has(key)));
  const cleanup = await fixturePool.query("SELECT status,cleanup_attempts FROM school_discipline_attachments WHERE school_id=$1",[f.schoolId]); assert.equal(cleanup.rows[0].status,"deleted");
});

test("partial evidence-copy retry preserves reservation identifiers and hides provider diagnostics", async () => {
  const f = await fixture(); await addEvidence(f); await addEvidence(f); const input = submitInput(f); let puts = 0;
  putHook = async () => { if (++puts === 2) throw new Error("PRIVATE PROVIDER CONTENT"); };
  const failed = await request(f,"/submit","POST",input); putHook = null;
  assert.equal(failed.status,503,failed.text); assert.ok(!failed.text.includes("PRIVATE PROVIDER"));
  const before = await fixturePool.query("SELECT id,storage_key FROM school_discipline_attachments WHERE school_id=$1 ORDER BY id",[f.schoolId]);
  const retry = await request(f,"/submit","POST",input); assert.equal(retry.status,201,retry.text);
  const after = await fixturePool.query("SELECT id,storage_key FROM school_discipline_attachments WHERE school_id=$1 ORDER BY id",[f.schoolId]); assert.deepEqual(after.rows,before.rows);
  assert.equal(retry.data.record.currentVersion.attachments.length,2);
});

test("grant revocation during download denies bytes and demotion/reactivation requires a fresh grant", async () => {
  const f = await fixture(); await addEvidence(f); const record = await submit(f); await grant(f);
  let once = false; getHook = async () => { if (!once) { once = true; await grant(f,false,1); } };
  const a = record.currentVersion.attachments[0]; const response = await request(f,`/${record.id}/versions/${record.currentVersion.id}/attachments/${a.id}/content`,"GET",undefined,f.admin);
  getHook = null; assert.equal(response.status,404,response.text);
  await grant(f,true,2);
  await fixturePool.query("UPDATE school_memberships SET role='teacher' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);
  await fixturePool.query("UPDATE school_memberships SET role='school_admin' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.admin)).data.canViewSchool,false);
  const audit = await fixturePool.query("SELECT metadata FROM audit_logs WHERE school_id=$1 AND action='discipline.access.auto_revoked'",[f.schoolId]); assert.equal(audit.rows.length,1);
  await grant(f,true,4); assert.equal((await request(f,`/${record.id}`,"GET",undefined,f.admin)).status,200);
});

test("pagination, selected filters and formula-safe export use exactly authorized snapshots", async () => {
  const f = await fixture(); for (let i=0;i<4;i++) await submit(f); await grant(f);
  const seen = new Set<string>(); let cursor: string | undefined;
  do { const page = await request(f,"/search","POST",{scope:"school",limit:1,studentName:"Synthetic",submitterName:"Synthetic",cursor},f.admin);
    assert.equal(page.status,200,page.text); for (const r of page.data.records) {assert.ok(!seen.has(r.id));seen.add(r.id);} cursor=page.data.nextCursor || undefined;
  } while(cursor); assert.equal(seen.size,4);
  assert.equal((await request(f,"/search","POST",{scope:"school",studentName:"%"},f.admin)).data.records.length,0);
  const csv = await request(f,"/export","POST",{scope:"school",studentName:"Synthetic"},f.admin);
  assert.equal(csv.status,200,csv.text); assert.equal(csv.headers.get("x-discipline-row-count"),"4"); assert.ok(csv.text.includes("'=FORMULA()"));
  assert.equal((await request(f,"/export","POST",{scope:"school"},f.other)).status,403);
  const audit = await fixturePool.query("SELECT metadata::text FROM audit_logs WHERE school_id=$1 AND action LIKE 'discipline.%'",[f.schoolId]);
  assert.ok(audit.rows.every(row=>!row.metadata?.includes("Reported classroom")&&!row.metadata?.includes("selected-photo")));
});

test("cleanup cannot delete evidence promoted during a live copy lease", async () => {
  const f = await fixture(); await addEvidence(f); let swept = false;
  putHook = async () => {
    if (swept) return; swept = true;
    await fixturePool.query("UPDATE school_discipline_versions SET created_at=now()-interval '25 hours' WHERE school_id=$1",[f.schoolId]);
    const result = await cleanupSchoolDiscipline({database:fixtureDb,store}); assert.equal(result.abandoned,0);
  };
  const result = await request(f,"/submit","POST",submitInput(f)); putHook = null; assert.equal(result.status,201,result.text);
  const record = result.data.record, a = record.currentVersion.attachments[0];
  await cleanupSchoolDiscipline({database:fixtureDb,store,now:new Date(Date.now()+48*60*60_000)});
  assert.equal((await request(f,`/${record.id}/versions/${record.currentVersion.id}/attachments/${a.id}/content`)).status,200);
});

test("multiple admin memberships preserve grants until the last qualifying membership ends", async () => {
  const f = await fixture(); await grant(f);
  await fixturePool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'admin','active')",[f.schoolId,f.admin]);
  await fixturePool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2 AND role='school_admin'",[f.schoolId,f.admin]);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.admin)).data.canViewSchool,true);
  await fixturePool.query("DELETE FROM school_memberships WHERE school_id=$1 AND user_id=$2 AND role='admin'",[f.schoolId,f.admin]);
  await fixturePool.query("UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.admin)).data.canViewSchool,false);
  const race = await Promise.all([request(f,`/access/${f.admin}`,"PUT",{revision:2,enabled:true,clientRequestId:randomUUID()},f.admin),
    request(f,`/access/${f.admin}`,"PUT",{revision:2,enabled:false,clientRequestId:randomUUID()},f.admin)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
});

test("historical submission preserves saved labels through roster departure, but entitlement revocation denies access", async () => {
  const f = await fixture(); await addEvidence(f); let changed=false;
  const saved=await fixturePool.query("SELECT group_name,student_name FROM mydesk_notes WHERE id=$1",[f.noteId]);
  putHook=async()=>{if(!changed){changed=true;
    await fixturePool.query("DELETE FROM group_students WHERE group_id=$1 AND student_id=$2",[f.groupId,f.studentId]);
    await fixturePool.query("UPDATE students SET first_name='Restricted current label',status='inactive' WHERE id=$1",[f.studentId]);
    await fixtureTransaction(async client=>{
      await client.query("UPDATE groups SET name='Restricted current class',teacher_id=$2,status='archived' WHERE id=$1",[f.groupId,f.other]);
      await client.query("DELETE FROM group_teachers WHERE group_id=$1",[f.groupId]);
      await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')",[f.groupId,f.other]);
    });
  }};
  const result=await request(f,"/submit","POST",submitInput(f));putHook=null;assert.equal(result.status,201,result.text);
  assert.equal(result.data.record.currentVersion.className,saved.rows[0].group_name);
  assert.equal(result.data.record.currentVersion.studentName,saved.rows[0].student_name);
  assert.equal((await request(f,"/search","POST",{})).data.records.length,1);
  const another=await request(f,"/submit","POST",submitInput(f));assert.equal(another.status,201,another.text);
  assert.equal(another.data.record.currentVersion.studentName,saved.rows[0].student_name);
  await fixturePool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='CLASSPILOT'",[f.schoolId]);
  assert.equal((await request(f,"/capabilities")).status,403);
  assert.equal((await request(f,`/${result.data.record.id}`)).status,403);
  const reservations=await fixturePool.query("SELECT count(*)::int AS n FROM school_discipline_attachments WHERE school_id=$1 AND status='committed'",[f.schoolId]);assert.equal(reservations.rows[0].n,2);
});

test("concurrent removal of separate administrative roles cannot revive a dormant grant", async () => {
  const f=await fixture(); await grant(f);
  await fixturePool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'admin','active')",[f.schoolId,f.admin]);
  const first=await fixturePool.connect(), second=await fixturePool.connect();
  let pending:Promise<pg.QueryResult>|undefined;
  try {
    await first.query("BEGIN; SET LOCAL statement_timeout='5s'"); await second.query("BEGIN; SET LOCAL statement_timeout='5s'");
    const firstPid=(await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const secondPid=(await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await first.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2 AND role='school_admin'",[f.schoolId,f.admin]);
    pending=second.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2 AND role='admin'",[f.schoolId,f.admin]);
    // Attach a handler immediately so an unexpected timeout is not unhandled.
    void pending.catch(()=>undefined);
    let blocked=false; const deadline=Date.now()+3000;
    while(Date.now()<deadline && !blocked) {
      blocked=(await first.query("SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked",[firstPid,secondPid])).rows[0].blocked;
      if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(blocked,true,"Second role removal must serialize on the grant before checking eligibility");
    await first.query("COMMIT"); await pending; await second.query("COMMIT");
  } finally { await first.query("ROLLBACK"); if(pending) await pending.catch(()=>undefined); await second.query("ROLLBACK"); first.release(); second.release(); }
  const access=(await fixturePool.query("SELECT enabled,revision FROM school_discipline_access WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin])).rows[0];
  assert.deepEqual(access,{enabled:false,revision:2});
  await fixturePool.query("UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.admin)).data.canViewSchool,false);
});

test("global membership revocation scopes only its target school and restores the caller without a super bypass",async()=>{
  const f=await fixture(); await grant(f);
  const client=await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL app.school_id=''; SET LOCAL app.is_super='off'");
    await client.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);
    const scope=(await client.query("SELECT current_setting('app.school_id',true) AS school,current_setting('app.is_super',true) AS super")).rows[0];
    assert.deepEqual(scope,{school:"",super:"off"}); await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK");throw error; } finally {client.release();}
  await fixturePool.query("UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2",[f.schoolId,f.admin]);
  assert.equal((await request(f,"/capabilities","GET",undefined,f.admin)).data.canViewSchool,false);
  const audit=(await fixturePool.query("SELECT user_id,metadata FROM audit_logs WHERE school_id=$1 AND action='discipline.access.auto_revoked'",[f.schoolId])).rows[0];
  assert.deepEqual(audit,{user_id:null,metadata:{userId:f.admin,reason:"membership_changed"}},"Automatic housekeeping records its target, not a fabricated acting user");
});
