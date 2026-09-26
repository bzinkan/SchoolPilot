import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import session from "express-session";
import pg from "pg";
import { z } from "zod";
import { pool, sessionPool } from "../src/db.js";
import { MYDESK_SQL } from "../src/db/mydeskMigration.js";
import { MYDESK_WORKSPACE_SQL } from "../src/db/mydeskWorkspaceMigration.js";
import myDeskRouter from "../src/routes/mydesk.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signUserToken } from "../src/services/jwt.js";

const schoolIds: string[] = [];
// Fixtures and DDL use the administrator connection; real HTTP handlers keep the restricted application pool.
const fixturePool = process.env.ADMIN_DATABASE_URL ? new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2 }) : pool;
const noteSchema = z.object({ id: z.string(), clientRequestId: z.string(), title: z.string(), displayTitle: z.string(), body: z.string(), status: z.string(), revision: z.number(),
  targetKind: z.string(), groupName: z.string().nullable(), studentName: z.string().nullable(), groupId: z.string().nullable(),
  pinned: z.boolean(), attachments: z.array(z.object({ id: z.string(), status: z.string() })) });
const noteEnvelope = z.object({ note: noteSchema });
const listEnvelope = z.object({ notes: z.array(noteSchema), nextCursor: z.string().nullable() });
let server: Server, baseUrl: string;
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  if (process.env.ADMIN_DATABASE_URL) assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.ADMIN_DATABASE_URL).hostname));
  await fixturePool.query(MYDESK_SQL);
  await fixturePool.query(MYDESK_WORKSPACE_SQL);
  if (process.env.RLS_GUC_ENABLED === "true") {
    const role = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows[0], { current_user: process.env.RLS_TEST_ROLE, rolsuper: false, rolbypassrls: false });
    const policies = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owns_table: boolean }>(
      "SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname IN ('mydesk_notes','mydesk_attachments') ORDER BY relname");
    assert.equal(policies.rows.length, 2);
    assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table));
  }
  const app = express(); app.use(express.json());
  app.use(session({ secret: "mydesk-local-fixture-session-secret", resave: false, saveUninitialized: false }));
  app.post("/fixture/impersonate", (req, res) => {
    const input = z.object({ targetId: z.string(), originalId: z.string() }).parse(req.body);
    req.session.userId = input.targetId; req.session.originalUserId = input.originalId; req.session.impersonating = true; req.session.authVersion = 1;
    res.json({ ok: true });
  });
  app.use("/api/mydesk", myDeskRouter); app.use(errorHandler);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL app.is_super='on'");
    // Canonical lifecycle guards retain school/user roots even in the CI schema.
    await client.query("UPDATE schools SET deleted_at=now() WHERE id=ANY($1::text[])", [schoolIds]);
    for (const table of ["mydesk_preferences", "mydesk_attachments", "mydesk_notes", "audit_logs"]) await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    for (const table of ["group_students", "group_teachers"]) await client.query(`DELETE FROM ${table} WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))`, [schoolIds]);
    for (const table of ["groups", "students", "settings", "school_memberships", "product_licenses"]) await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await Promise.all([pool.end(), sessionPool.end(), ...(fixturePool !== pool ? [fixturePool.end()] : [])]); }
});
async function fixtureTransaction(operation: (client: pg.PoolClient) => Promise<void>) {
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN"); await operation(client); await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function fixture() {
  const f = { schoolId: randomUUID(), teacherId: randomUUID(), colleagueId: randomUUID(), adminId: randomUUID(), officeId: randomUUID(),
    superId: randomUUID(), outsideSuperId: randomUUID(), groupId: randomUUID(), studentId: randomUUID() };
  schoolIds.push(f.schoolId);
  await fixtureTransaction(async client => {
    await client.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'My Desk fixture','active',true,'active','UTC')", [f.schoolId]);
    await client.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [f.schoolId]);
    for (const [id, role] of [[f.teacherId, "teacher"], [f.colleagueId, "teacher"], [f.adminId, "school_admin"], [f.officeId, "office_staff"], [f.superId, "teacher"], [f.outsideSuperId, null]]) {
      await client.query("INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Notebook','Author',$3)", [id, `${id}@example.test`, id === f.superId || id === f.outsideSuperId]);
      if (role) await client.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [f.schoolId, id, role]);
    }
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Science','teacher_created','active')", [f.groupId, f.schoolId, f.teacherId]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($1,$3,'co-teacher')", [f.groupId, f.teacherId, f.colleagueId]);
    await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'First','Student','active')", [f.studentId, f.schoolId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId, f.studentId]);
  });
  process.env.MYDESK_MODE = "on";
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(f: Fixture, path: string, method = "GET", body?: unknown, authorId = f.teacherId, cookie?: string) {
  const headers: Record<string, string> = { "x-school-id": f.schoolId, "content-type": "application/json",
    authorization: `Bearer ${signUserToken({ userId: authorId, email: `${authorId}@example.test`, authVersion: 1 })}` };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(baseUrl + "/api/mydesk" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); const data: unknown = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
  return { status: response.status, data, text, headers: response.headers };
}
async function draft(f: Fixture, fields: Record<string, unknown> = {}, authorId = f.teacherId) {
  const response = await request(f, "/notes", "POST", { clientRequestId: randomUUID(), body: "Private observation", ...fields }, authorId);
  assert.equal(response.status, 201, response.text); return noteEnvelope.parse(response.data).note;
}
async function activate(f: Fixture, note: z.infer<typeof noteSchema>, authorId = f.teacherId) {
  const response = await request(f, `/notes/${note.id}/complete`, "POST", { revision: note.revision, attachmentIds: [] }, authorId);
  assert.equal(response.status, 200, response.text); return noteEnvelope.parse(response.data).note;
}
test("author privacy across co-teacher, admin, school and direct-ID mutations", async () => {
  const f = await fixture(), other = await fixture(); const note = await activate(f, await draft(f));
  for (const author of [f.colleagueId, f.adminId, f.superId]) {
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const response = await request(f, `/notes/${note.id}`, method, method === "GET" ? undefined : { revision: note.revision, ...(method === "PATCH" ? { body: "changed" } : {}) }, author);
      assert.equal(response.status, 404, response.text);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }
    const list = await request(f, "/notes", "GET", undefined, author); assert.deepEqual(listEnvelope.parse(list.data).notes, []);
  }
  assert.equal((await request(other, `/notes/${note.id}`)).status, 404);
  const own = await request(f, `/notes/${note.id}`); assert.equal(own.status, 200); assert.equal(own.headers.get("cache-control"), "private, no-store");
  if (process.env.RLS_GUC_ENABLED === "true") {
    assert.equal((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM mydesk_notes WHERE id=$1", [note.id])).rows[0]!.count, 0,
      "The same application role denies access without the HTTP request's tenant context");
  }
  assert.ok(!own.text.includes("requestFingerprint") && !own.text.includes("storageKey"));
  assert.equal((await fixturePool.query("SELECT count(*)::int n FROM student_timeline_events WHERE school_id=$1 AND source_type='mydesk'", [f.schoolId])).rows[0].n, 0);
});
test("real super-admin requires actual membership; impersonation cannot bypass with bearer", async () => {
  const f = await fixture();
  const denied = await request(f, "/capabilities", "GET", undefined, f.outsideSuperId);
  assert.equal(denied.status, 403); assert.equal(denied.headers.get("cache-control"), "private, no-store");
  assert.equal(denied.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await request(f, "/capabilities", "GET", undefined, f.officeId)).status, 403);
  assert.equal((await request(f, "/capabilities", "GET", undefined, f.superId)).status, 200);
  await activate(f, await draft(f, {}, f.superId), f.superId);
  const adminClasses = await request(f, "/classes", "GET", undefined, f.adminId);
  assert.deepEqual(z.object({ current: z.array(z.object({ id: z.string() })) }).parse(adminClasses.data).current.map(row => row.id), [f.groupId]);
  const adminOwn = await activate(f, await draft(f, { targetKind: "class", groupId: f.groupId }, f.adminId), f.adminId);
  assert.equal((await request(f, `/notes/${adminOwn.id}`)).status, 404, "schoolwide class filing grants no cross-author notebook reads");
  const login = await fetch(baseUrl + "/fixture/impersonate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: f.adminId, originalId: f.outsideSuperId }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
  assert.equal((await request(f, "/notes", "GET", undefined, f.teacherId, cookie)).status, 403);
  assert.equal((await request(f, "/notes", "POST", { clientRequestId: randomUUID(), body: "blocked" }, f.teacherId, cookie)).status, 403);
});
test("pending saves hide until completion; concurrent retries and cancelled IDs never duplicate", async () => {
  const f = await fixture(); const input = { clientRequestId: randomUUID(), title: "Title is content", body: "" };
  const responses = await Promise.all([request(f, "/notes", "POST", input), request(f, "/notes", "POST", input)]);
  const first = noteEnvelope.parse(responses[0]!.data).note, second = noteEnvelope.parse(responses[1]!.data).note;
  assert.equal(first.id, second.id); assert.deepEqual(listEnvelope.parse((await request(f, "/notes")).data).notes, []);
  assert.equal((await request(f, "/notes", "POST", { ...input, title: "different" })).status, 409);
  const note = await activate(f, first);
  assert.equal((await request(f, `/notes/${note.id}/complete`, "POST", { revision: first.revision, attachmentIds: [] })).status, 200);
  assert.equal((await request(f, `/notes/${note.id}`, "PATCH", { revision: note.revision, title: "", body: "" })).status, 409);
  assert.equal((await request(f, `/notes/${note.id}`, "DELETE", { revision: note.revision })).status, 200);
  assert.equal((await request(f, "/notes", "POST", input)).status, 404);
  assert.equal((await fixturePool.query("SELECT count(*)::int n FROM mydesk_notes WHERE school_id=$1 AND client_request_id=$2", [f.schoolId, input.clientRequestId])).rows[0].n, 1);
});
test("current class filing stays explicit across roster moves without a teaching session", async () => {
  const f = await fixture(), sixthGradeId = randomUUID();
  await fixtureTransaction(async client => {
    await client.query("UPDATE groups SET name='5th grade',group_type='admin_class' WHERE id=$1", [f.groupId]);
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'6th grade','teacher_small_group','active')", [sixthGradeId, f.schoolId, f.colleagueId]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($1,$3,'co-teacher')", [sixthGradeId, f.colleagueId, f.teacherId]);
  });
  const classes = await request(f, "/classes"); assert.equal(classes.status, 200, classes.text);
  assert.deepEqual(z.object({ current: z.array(z.object({ id: z.string(), name: z.string(), groupType: z.string() })) }).parse(classes.data).current, [
    { id: f.groupId, name: "5th grade", groupType: "admin_class" },
    { id: sixthGradeId, name: "6th grade", groupType: "teacher_small_group" },
  ]);
  assert.equal((await fixturePool.query<{ count: number }>("SELECT count(*)::int AS count FROM teaching_sessions WHERE school_id=$1", [f.schoolId])).rows[0]!.count, 0);
  const general = await activate(f, await draft(f));
  const fifthClass = await activate(f, await draft(f, { targetKind: "class", groupId: f.groupId }));
  const fifthStudent = await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: f.studentId }));
  const sixthClass = await activate(f, await draft(f, { targetKind: "class", groupId: sixthGradeId }));
  const noteIds = async (filters: Record<string, unknown>) => {
    const response = await request(f, "/notes/search", "POST", filters); assert.equal(response.status, 200, response.text);
    return new Set(listEnvelope.parse(response.data).notes.map(note => note.id));
  };
  assert.deepEqual(await noteIds({ scope: "all" }), new Set([general.id, fifthClass.id, fifthStudent.id, sixthClass.id]));
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_students WHERE group_id=$1 AND student_id=$2", [f.groupId, f.studentId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [sixthGradeId, f.studentId]);
  });
  assert.deepEqual(await noteIds({ scope: "class", classId: f.groupId }), new Set([fifthClass.id, fifthStudent.id]));
  assert.deepEqual(await noteIds({ scope: "class", classId: f.groupId, studentId: f.studentId }), new Set([fifthStudent.id]));
  assert.deepEqual(await noteIds({ scope: "class", classId: sixthGradeId }), new Set([sixthClass.id]));
  assert.deepEqual(await noteIds({ scope: "class", classId: sixthGradeId, studentId: f.studentId }), new Set());
  assert.deepEqual((await request(f, `/classes/${f.groupId}/note-students`)).data, { students: [{ id: f.studentId, name: "First Student" }] });
  assert.deepEqual((await request(f, `/classes/${sixthGradeId}/note-students`)).data, { students: [] });
  const sixthStudent = await activate(f, await draft(f, { targetKind: "student", groupId: sixthGradeId, studentId: f.studentId }));
  assert.deepEqual(await noteIds({ scope: "class", classId: sixthGradeId, studentId: f.studentId }), new Set([sixthStudent.id]));
  assert.deepEqual(await noteIds({ scope: "all" }), new Set([general.id, fifthClass.id, fifthStudent.id, sixthClass.id, sixthStudent.id]));
  assert.deepEqual(await noteIds({ scope: "general" }), new Set([general.id]));
  assert.deepEqual(await noteIds({ scope: "past" }), new Set());
  assert.equal((await fixturePool.query<{ count: number }>("SELECT count(*)::int AS count FROM teaching_sessions WHERE school_id=$1", [f.schoolId])).rows[0]!.count, 0);
});

test("past notes remain owned after reassignment, while new filing and current student lists close", async () => {
  const f = await fixture(); const note = await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: f.studentId }));
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.teacherId]);
    await client.query("UPDATE group_teachers SET role='primary' WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.colleagueId]);
    await client.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [f.groupId, f.colleagueId]);
  });
  assert.equal((await request(f, `/classes/${f.groupId}/students`)).status, 404);
  assert.equal((await request(f, "/notes", "POST", { clientRequestId: randomUUID(), targetKind: "class", groupId: f.groupId, body: "new" })).status, 404);
  assert.equal((await request(f, `/notes/${note.id}`)).status, 200);
  assert.deepEqual(listEnvelope.parse((await request(f, "/notes")).data).notes, []);
  assert.deepEqual(listEnvelope.parse((await request(f, "/notes?scope=past")).data).notes.map(row => row.id), [note.id]);
  const changed = await request(f, `/notes/${note.id}`, "PATCH", { revision: note.revision, body: "Still my notebook" }); assert.equal(changed.status, 200, changed.text);
  assert.equal((await request(f, `/notes/${note.id}`, "PATCH", { revision: note.revision, body: "Stale" })).status, 409);
  const updated = noteEnvelope.parse(changed.data).note;
  const refile = await request(f, `/notes/${note.id}`, "PATCH", { revision: updated.revision, targetKind: "general", groupId: null, studentId: null }); assert.equal(refile.status, 200, refile.text);
  assert.equal(listEnvelope.parse((await request(f, "/notes?scope=general")).data).notes.length, 1);
  await fixturePool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [f.schoolId, f.teacherId]);
  assert.equal((await request(f, `/notes/${note.id}`)).status, 403);
});
test("class deletion preserves snapshots and student deactivation does not delete owned notes", async () => {
  const f = await fixture(); const note = await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: f.studentId }));
  await fixturePool.query("UPDATE students SET status='inactive' WHERE id=$1", [f.studentId]);
  assert.equal((await request(f, `/notes/${note.id}`)).status, 200);
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_students WHERE group_id=$1", [f.groupId]); await client.query("DELETE FROM group_teachers WHERE group_id=$1", [f.groupId]);
    await client.query("DELETE FROM groups WHERE id=$1", [f.groupId]);
  });
  const retained = noteEnvelope.parse((await request(f, `/notes/${note.id}`)).data).note;
  assert.equal(retained.groupId, null); assert.equal(retained.groupName, "Science"); assert.equal(retained.studentName, "First Student");
});
test("class student filters use only owned saved snapshots after roster and class changes", async () => {
  const f = await fixture(), other = await fixture();
  const oldNote = await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: f.studentId }));
  await fixturePool.query("UPDATE mydesk_notes SET updated_at=now()-interval '1 day' WHERE id=$1", [oldNote.id]);
  await fixturePool.query("UPDATE students SET first_name='Bright' WHERE id=$1", [f.studentId]);
  const latestNote = await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: f.studentId }));
  const secondStudentId = randomUUID();
  await fixtureTransaction(async client => {
    await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Aaron','History','active')", [secondStudentId, f.schoolId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId, secondStudentId]);
  });
  await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: secondStudentId }));
  const path = `/classes/${f.groupId}/note-students`;
  const expected = { students: [{ id: secondStudentId, name: "Aaron History" }, { id: f.studentId, name: "Bright Student" }] };
  const current = await request(f, path); assert.equal(current.status, 200, current.text); assert.deepEqual(current.data, expected);
  for (const authorId of [f.colleagueId, f.adminId]) {
    const privateOptions = await request(f, path, "GET", undefined, authorId);
    assert.equal(privateOptions.status, 200, privateOptions.text); assert.deepEqual(privateOptions.data, { students: [] });
  }
  await fixtureTransaction(async client => {
    await client.query("UPDATE students SET first_name='Current roster secret',status='inactive' WHERE id=ANY($1::text[])", [[f.studentId, secondStudentId]]);
    await client.query("DELETE FROM group_students WHERE group_id=$1", [f.groupId]);
    await client.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.teacherId]);
    await client.query("UPDATE group_teachers SET role='primary' WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.colleagueId]);
    await client.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [f.groupId, f.colleagueId]);
  });
  assert.equal((await request(f, `/classes/${f.groupId}/students`)).status, 404);
  const past = await request(f, path); assert.equal(past.status, 200, past.text); assert.deepEqual(past.data, expected);
  const filtered = await request(f, "/notes/search", "POST", { scope: "past", classId: f.groupId, studentId: f.studentId });
  assert.equal(filtered.status, 200, filtered.text);
  assert.deepEqual(new Set(listEnvelope.parse(filtered.data).notes.map(note => note.id)), new Set([oldNote.id, latestNote.id]));
  assert.equal((await request(other, path)).status, 404);
  assert.equal((await request(f, path, "GET", undefined, f.superId)).status, 404);
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_teachers WHERE group_id=$1", [f.groupId]);
    await client.query("DELETE FROM groups WHERE id=$1", [f.groupId]);
  });
  assert.deepEqual((await request(f, path)).data, expected);
  for (const authorId of [f.colleagueId, f.adminId]) assert.equal((await request(f, path, "GET", undefined, authorId)).status, 404);
});

test("completion commits chosen ready photos atomically and rejects empty or unfinished selections", async () => {
  const f = await fixture(); const note = await draft(f, { body: "" });
  assert.equal((await request(f, `/notes/${note.id}/complete`, "POST", { revision: note.revision, attachmentIds: [] })).status, 409);
  const photoId = randomUUID(), stagedId = randomUUID();
  for (const [id, status] of [[photoId, "ready"], [stagedId, "pending"]]) await fixturePool.query("INSERT INTO mydesk_attachments(id,school_id,author_id,note_id,client_request_id,storage_key,content_type,byte_size,input_sha256,sha256,status,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,'image/jpeg',100,$7,$7,$8,$7)", [id, f.schoolId, f.teacherId, note.id, randomUUID(), `fixture/${id}`, "a".repeat(64), status]);
  assert.equal((await request(f, `/notes/${note.id}/complete`, "POST", { revision: note.revision, attachmentIds: [photoId, stagedId] })).status, 409);
  const saved = await request(f, `/notes/${note.id}/complete`, "POST", { revision: note.revision, attachmentIds: [photoId] }); assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(noteEnvelope.parse(saved.data).note.attachments.map(row => row.id), [photoId]);
  assert.equal((await fixturePool.query("SELECT status FROM mydesk_attachments WHERE id=$1", [stagedId])).rows[0].status, "delete_pending");
  const savedNote = noteEnvelope.parse(saved.data).note;
  assert.equal(savedNote.title, ""); assert.equal(savedNote.displayTitle, "Photo note");
  assert.equal((await request(f, `/notes/${note.id}/complete`, "POST", { revision: savedNote.revision, attachmentIds: [] })).status, 409);
});
test("attachment HTTP routes preserve author privacy before file storage access", async () => {
  const f = await fixture(), other = await fixture(); const note = await activate(f, await draft(f));
  const bytes = Buffer.from("invalid JPEG fixture bytes");
  const metadata = { clientRequestId: randomUUID(), filename: "fixture.jpg", contentType: "image/jpeg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const reservation = await request(f, `/notes/${note.id}/attachments`, "POST", metadata); assert.equal(reservation.status, 201, reservation.text);
  const attachment = z.object({ attachment: z.object({ id: z.string() }) }).parse(reservation.data).attachment;
  assert.ok(!reservation.text.includes("storageKey"));
  const contentPath = `/notes/${note.id}/attachments/${attachment.id}/content`;
  const rawUpload = async (scope: Fixture, authorId: string, cookie?: string) => fetch(baseUrl + "/api/mydesk" + contentPath, {
    method: "PUT", headers: { "x-school-id": scope.schoolId, "content-type": "image/jpeg",
      authorization: `Bearer ${signUserToken({ userId: authorId, email: `${authorId}@example.test` })}`, ...(cookie ? { cookie } : {}) }, body: bytes,
  });
  for (const authorId of [f.colleagueId, f.adminId, f.superId]) {
    assert.equal((await request(f, `/notes/${note.id}/attachments`, "POST", { ...metadata, clientRequestId: randomUUID() }, authorId)).status, 404);
    assert.equal((await rawUpload(f, authorId)).status, 404);
    assert.equal((await request(f, contentPath, "GET", undefined, authorId)).status, 404);
    assert.equal((await request(f, `/notes/${note.id}/attachments/${attachment.id}`, "DELETE", { revision: note.revision }, authorId)).status, 404);
  }
  assert.equal((await rawUpload(other, other.teacherId)).status, 404);
  assert.equal((await request(other, contentPath)).status, 404);
  assert.equal((await fetch(baseUrl + "/api/mydesk" + contentPath)).status, 401);
  const invalidImage = await rawUpload(f, f.teacherId); assert.equal(invalidImage.status, 422, await invalidImage.text());
  const login = await fetch(baseUrl + "/fixture/impersonate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: f.teacherId, originalId: f.outsideSuperId }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
  assert.equal((await request(f, `/notes/${note.id}/attachments`, "POST", { ...metadata, clientRequestId: randomUUID() }, f.teacherId, cookie)).status, 403);
  assert.equal((await rawUpload(f, f.teacherId, cookie)).status, 403);
  assert.equal((await request(f, contentPath, "GET", undefined, f.teacherId, cookie)).status, 403);
  assert.equal((await request(f, `/notes/${note.id}/attachments/${attachment.id}`, "DELETE", { revision: note.revision }, f.teacherId, cookie)).status, 403);
  // A ready object would trigger S3 only after the owner and exact parent checks.
  await fixturePool.query("UPDATE mydesk_attachments SET status='ready',sha256=$2,committed_at=now() WHERE id=$1", [attachment.id, metadata.sha256]);
  for (const authorId of [f.colleagueId, f.adminId, f.superId]) assert.equal((await request(f, contentPath, "GET", undefined, authorId)).status, 404);
  const otherNote = await activate(f, await draft(f));
  assert.equal((await request(f, `/notes/${otherNote.id}/attachments/${attachment.id}/content`)).status, 404);
  const deleted = await request(f, `/notes/${note.id}/attachments/${attachment.id}`, "DELETE", { revision: note.revision }); assert.equal(deleted.status, 200, deleted.text);
  assert.equal((await request(f, contentPath)).status, 404);
});
test("filtered export includes every page and cursor is bound to the actor and filters", async () => {
  const f = await fixture();
  await fixturePool.query("INSERT INTO mydesk_notes(school_id,author_id,client_request_id,request_fingerprint,title,body,entry_date,status) SELECT $1,$2,gen_random_uuid(),repeat('a',64),'Export item ' || n,' =1+1','2026-09-25','active' FROM generate_series(1,105) n", [f.schoolId, f.teacherId]);
  const rejected = await request(f, "/notes?q=fixture"); assert.equal(rejected.status, 400);
  assert.equal(z.object({ code: z.string() }).parse(rejected.data).code, "MYDESK_PRIVATE_SEARCH_REQUIRED");
  assert.equal((await request(f, "/export?q=fixture")).status, 400);
  assert.equal((await request(f, "/notes?q=")).status, 200);
  assert.equal((await request(f, "/notes/search", "POST", { q: "Export", authorId: f.teacherId })).status, 400);
  const list = listEnvelope.parse((await request(f, "/notes/search", "POST", { limit: 10, q: "Export" })).data); assert.equal(list.notes.length, 10); assert.ok(list.nextCursor);
  const page = listEnvelope.parse((await request(f, "/notes/search", "POST", { limit: 10, q: "Export", cursor: list.nextCursor })).data); assert.ok(page.notes.every(row => !list.notes.some(first => first.id === row.id)));
  const pagedIds = list.notes.map(note => note.id); let cursor: string | null = list.nextCursor;
  while (cursor) {
    const next = listEnvelope.parse((await request(f, "/notes/search", "POST", { limit: 10, q: "Export", cursor })).data);
    pagedIds.push(...next.notes.map(note => note.id)); cursor = next.nextCursor;
  }
  assert.equal(pagedIds.length, 105, "same-timestamp rows must survive every cursor boundary");
  assert.equal(new Set(pagedIds).size, 105);
  assert.equal((await request(f, "/notes/search", "POST", { limit: 10, q: "different", cursor: list.nextCursor })).status, 400);
  assert.deepEqual(listEnvelope.parse((await request(f, "/notes/search", "POST", { q: "Export" }, f.adminId)).data).notes, []);
  const exported = await request(f, "/export", "POST", { q: "Export", limit: 10 }); assert.equal(exported.status, 200, exported.text); assert.equal(exported.headers.get("x-mydesk-row-count"), "105");
  assert.equal(exported.text.split("\r\n").filter(Boolean).length, 106); assert.ok(exported.text.includes('"\' =1+1"'));
  await fixturePool.query("INSERT INTO mydesk_notes(school_id,author_id,client_request_id,request_fingerprint,title,body,entry_date,status) SELECT $1,$2,gen_random_uuid(),repeat('a',64),'Export item ' || n,'Limit fixture','2026-09-25','active' FROM generate_series(106,5001) n", [f.schoolId, f.teacherId]);
  const tooMany = await request(f, "/export", "POST", { q: "Export", limit: 10 }); assert.equal(tooMany.status, 422, tooMany.text);
  const exportError = z.object({ code: z.string(), error: z.string() }).parse(tooMany.data);
  assert.equal(exportError.code, "MYDESK_EXPORT_LIMIT"); assert.match(exportError.error, /5,000/); assert.match(exportError.error, /Narrow your filters/);
  assert.ok(tooMany.headers.get("content-type")?.includes("application/json")); assert.equal(tooMany.headers.get("x-mydesk-row-count"), null);
  await fixturePool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='CLASSPILOT'", [f.schoolId]);
  assert.equal((await request(f, "/notes")).status, 403);
});


test("personal grade groups and revisioned defaults stay separate from administrator roster access", async () => {
  const f = await fixture(), otherGroup = randomUUID(), adminGroup = randomUUID();
  await fixtureTransaction(async client => {
    await client.query("UPDATE groups SET grade_level='5',name='Science' WHERE id=$1", [f.groupId]);
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,grade_level,group_type,status) VALUES($1,$2,$3,'Reading','5','teacher_created','active'),($4,$2,$5,'Administrator homeroom','6','teacher_created','active')", [otherGroup, f.schoolId, f.teacherId, adminGroup, f.adminId]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($3,$4,'primary')", [otherGroup, f.teacherId, adminGroup, f.adminId]);
  });
  const schema = z.object({ current: z.array(z.object({ id: z.string() })), personalByGrade: z.array(z.object({ gradeLevel: z.string().nullable(), classes: z.array(z.object({ id: z.string() })), preferredClassId: z.string().nullable(), preferenceStale: z.boolean() })), otherCurrent: z.array(z.object({ id: z.string() })) });
  const admin = schema.parse((await request(f, "/classes", "GET", undefined, f.adminId)).data);
  assert.equal(admin.current.length, 3);
  assert.deepEqual(admin.personalByGrade.map(row => row.classes.map(group => group.id)), [[adminGroup]]);
  assert.deepEqual(new Set(admin.otherCurrent.map(row => row.id)), new Set([f.groupId, otherGroup]));
  assert.equal((await request(f, "/preferences", "PATCH", { revision: 0, preferredClasses: { '5': f.groupId } }, f.adminId)).status, 404);
  const updates = await Promise.all([request(f, "/preferences", "PATCH", { revision: 0, preferredClasses: { '5': f.groupId } }), request(f, "/preferences", "PATCH", { revision: 0, preferredClasses: { '5': otherGroup } })]);
  assert.deepEqual(updates.map(row => row.status).sort(), [200, 409]);
  const saved = z.object({ revision: z.number(), preferredClasses: z.record(z.string()) }).parse((await request(f, "/preferences")).data);
  assert.equal(saved.revision, 1);
  assert.deepEqual((await request(f, "/preferences", "GET", undefined, f.colleagueId)).data, { revision: 0, preferredClasses: {} });
  assert.equal((await request(f, "/preferences", "PATCH", { revision: 1, preferredClasses: { '6': otherGroup } })).status, 409);
  await fixturePool.query("UPDATE groups SET status='archived' WHERE id=$1", [saved.preferredClasses['5']]);
  const stale = schema.parse((await request(f, "/classes")).data).personalByGrade.find(row => row.gradeLevel === '5');
  assert.equal(stale?.preferenceStale, true); assert.equal(stale?.preferredClassId, null);
  const replacement = saved.preferredClasses['5'] === f.groupId ? otherGroup : f.groupId;
  assert.equal((await request(f, "/preferences", "PATCH", { revision: 1, preferredClasses: { '5': replacement } })).status, 200);
  const constraints = await fixturePool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='mydesk_preferences'");
  assert.deepEqual(constraints.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  await assert.rejects(fixturePool.query("UPDATE mydesk_preferences SET revision=0 WHERE school_id=$1 AND author_id=$2", [f.schoolId, f.teacherId]), { code: "23514" });
  await assert.rejects(fixturePool.query("INSERT INTO mydesk_preferences(school_id,author_id) VALUES($1,$2)", [f.schoolId, f.outsideSuperId]), { code: "23514" });
  if (process.env.RLS_GUC_ENABLED === "true") {
    assert.equal((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM mydesk_preferences WHERE school_id=$1", [f.schoolId])).rows[0]!.count, 0);
  }
});

test("directory includes zero-note students; all-years history keeps own snapshots after roster access ends", async () => {
  const f = await fixture(), another = await fixture(), zero = randomUUID();
  await fixtureTransaction(async client => {
    await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Zero','Notes','active')", [zero, f.schoolId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId, zero]);
  });
  const history = await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: f.studentId, title: "Saved observation", category: "positive" }));
  await activate(f, await draft(f, { targetKind: "student", groupId: f.groupId, studentId: f.studentId, title: "Colleague content" }, f.colleagueId), f.colleagueId);
  const directorySchema = z.object({ students: z.array(z.object({ id: z.string(), noteCount: z.number() })), nextCursor: z.string().nullable() });
  const directory = directorySchema.parse((await request(f, "/students/search", "POST", {})).data);
  assert.deepEqual(new Map(directory.students.map(row => [row.id,row.noteCount])), new Map([[f.studentId,1],[zero,0]]));
  const noNotes = await request(f, `/students/${zero}/history`, "POST", {});
  assert.equal(noNotes.status, 200); assert.deepEqual(listEnvelope.parse(noNotes.data).notes, []);
  const first = directorySchema.parse((await request(f, "/students/search", "POST", { limit: 1 })).data);
  const second = directorySchema.parse((await request(f, "/students/search", "POST", { limit: 1, cursor: first.nextCursor })).data);
  assert.equal(new Set([...first.students,...second.students].map(row => row.id)).size, 2);
  await fixturePool.query("UPDATE groups SET status='archived',name='Renamed old class' WHERE id=$1", [f.groupId]);
  assert.deepEqual(directorySchema.parse((await request(f, "/students/search", "POST", {})).data).students, []);
  assert.deepEqual(listEnvelope.parse((await request(f, "/notes/search", "POST", { scope: "all" })).data).notes, [], "Existing All scope remains current classes only");
  const result = await request(f, `/students/${f.studentId}/history`, "POST", { category: "positive", q: "Saved" });
  assert.equal(result.status, 200, result.text);
  const saved = listEnvelope.parse(result.data).notes;
  assert.deepEqual(saved.map(row => row.id), [history.id]); assert.equal(saved[0]!.groupName, "Science");
  assert.equal(z.object({ student: z.object({ current: z.boolean(), name: z.string() }) }).parse(result.data).student.current, false);
  assert.deepEqual(listEnvelope.parse((await request(f, `/students/${f.studentId}/history`, "POST", { classId: "not-this-class" })).data).notes, []);
  assert.equal((await request(f, `/students/${f.studentId}/history`, "POST", {}, f.adminId)).status, 404);
  assert.equal((await request(another, `/students/${f.studentId}/history`, "POST", {})).status, 404);
  const csv = await request(f, `/students/${f.studentId}/export`, "POST", { category: "positive" });
  assert.equal(csv.status, 200); assert.ok(csv.text.includes("Saved observation") && csv.text.includes("Science") && !csv.text.includes("Colleague content"));
  assert.equal(csv.headers.get("cache-control"), "private, no-store");
});
