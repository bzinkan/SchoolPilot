import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import session from "express-session";
import pg from "pg";
import { z } from "zod";
import { pool, sessionPool } from "../src/db.js";
import { MYDESK_SQL } from "../src/db/mydeskMigration.js";
import { MYDESK_SEATING_SQL } from "../src/db/mydeskSeatingMigration.js";
import { seatingLayout, type SeatingLayout } from "../src/services/mydeskSeatingValidation.js";
import myDeskRouter from "../src/routes/mydesk.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signUserToken } from "../src/services/jwt.js";

const schoolIds: string[] = [];
// Keep fixture locks and barrier polling off the application pool in both lanes.
// Ordinary CI uses the worker's two-client app pool; sharing it here would consume
// both clients before the barrier observer can check the blocked HTTP save.
const fixturePool = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL, max: 2 });
const summarySchema = z.object({ id: z.string(), classId: z.string().nullable(), filingGroupId: z.string(), className: z.string(),
  name: z.string(), isCurrent: z.boolean(), revision: z.number(), canEdit: z.boolean(), createdAt: z.string(), updatedAt: z.string() });
const chartSchema = summarySchema.extend({ layout: seatingLayout, roster: z.array(z.object({ id: z.string(), name: z.string() })), rosterRevision: z.string() });
const chartEnvelope = z.object({ chart: chartSchema });
const listEnvelope = z.object({ charts: z.array(summarySchema.strict()), nextCursor: z.string().nullable() });
const rosterEnvelope = z.object({ class: z.object({ id: z.string(), name: z.string() }),
  students: z.array(z.object({ id: z.string(), name: z.string() })), rosterRevision: z.string().regex(/^[a-f0-9]{64}$/) });


let server: Server, baseUrl: string;
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  if (process.env.ADMIN_DATABASE_URL) assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.ADMIN_DATABASE_URL).hostname));
  await fixturePool.query(MYDESK_SQL);
  await fixturePool.query(MYDESK_SEATING_SQL);
  if (process.env.RLS_GUC_ENABLED === "true") {
    assert.match(process.env.RLS_TEST_ROLE || "", /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
    await fixturePool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON mydesk_seating_charts TO "${process.env.RLS_TEST_ROLE}"`);
    const role = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows[0], { current_user: process.env.RLS_TEST_ROLE, rolsuper: false, rolbypassrls: false });
    const policies = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owns_table: boolean }>(
      "SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname IN ('mydesk_notes','mydesk_attachments','mydesk_seating_charts') ORDER BY relname");
    assert.equal(policies.rows.length, 3);
    assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table));
  }
  const app = express(); app.use(express.json());
  app.use(session({ secret: "mydesk-local-fixture-session-secret", resave: false, saveUninitialized: false }));
  app.post("/fixture/impersonate", (req, res) => {
    const input = z.object({ targetId: z.string(), originalId: z.string() }).parse(req.body);
    req.session.userId = input.targetId; req.session.originalUserId = input.originalId; req.session.impersonating = true; req.session.authVersion = 1;
    res.json({ ok: true });
  });
  app.use("/api/mydesk", (req, res, next) => {
    // Drop the TCP response only after the real handler has committed its mutation.
    if (req.headers["x-fixture-drop-response"] === "1") res.json = () => { res.destroy(); return res; };
    next();
  }, myDeskRouter); app.use(errorHandler);
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
    for (const table of ["mydesk_seating_charts", "mydesk_attachments", "mydesk_notes", "audit_logs"]) await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
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
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'co-teacher')", [f.groupId, f.superId]);
    await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'First','Student','active')", [f.studentId, f.schoolId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId, f.studentId]);
  });
  process.env.MYDESK_MODE = "on";
  process.env.MYDESK_SEATING_MODE = "on";
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

const layoutFor = (studentId: string | null, locked = false): SeatingLayout => ({ version: 1,
  seats: [{ id: randomUUID(), x: 0, y: 0, studentId, locked }, { id: randomUUID(), x: 120, y: 0, studentId: null, locked: false }] });
async function roster(f: Fixture, classId = f.groupId, authorId = f.teacherId) {
  const response = await request(f, `/classes/${classId}/students`, "GET", undefined, authorId);
  assert.equal(response.status, 200, response.text); return rosterEnvelope.parse(response.data);
}
async function createInput(f: Fixture, classId = f.groupId) {
  return { clientRequestId: randomUUID(), classId, name: "September arrangement", layout: layoutFor(f.studentId), rosterRevision: (await roster(f, classId)).rosterRevision };
}
async function createChart(f: Fixture, input: Awaited<ReturnType<typeof createInput>>, authorId = f.teacherId) {
  const response = await request(f, "/seating-charts", "POST", input, authorId);
  assert.equal(response.status, 201, response.text); return chartEnvelope.parse(response.data).chart;
}
async function getChart(f: Fixture, id: string) {
  const response = await request(f, `/seating-charts/${id}`); assert.equal(response.status, 200, response.text);
  return chartEnvelope.parse(response.data).chart;
}
async function list(f: Fixture, query = "", authorId = f.teacherId) {
  const response = await request(f, `/seating-charts${query}`, "GET", undefined, authorId);
  assert.equal(response.status, 200, response.text); return listEnvelope.parse(response.data);
}

test("seating HTTP routes enforce exact author, tenant, real membership, impersonation and rollout boundaries", async () => {
  const f = await fixture(), other = await fixture(), input = await createInput(f);
  const chart = await createChart(f, input);
  for (const authorId of [f.colleagueId, f.adminId, f.superId]) {
    const operations: Array<[string, string, unknown]> = [
      ["", "GET", undefined], ["", "PATCH", { requestId: randomUUID(), revision: chart.revision, name: "Overwrite", layout: chart.layout, rosterRevision: chart.rosterRevision }],
      ["", "DELETE", { requestId: randomUUID(), revision: chart.revision }],
      ["/current", "PUT", { requestId: randomUUID(), revision: chart.revision }],
      ["/duplicate", "POST", { clientRequestId: randomUUID(), sourceRevision: chart.revision, targetClassId: f.groupId, mode: "chart", name: "Copy", rosterRevision: chart.rosterRevision }],
    ];
    for (const [suffix, method, body] of operations) {
      const denied = await request(f, `/seating-charts/${chart.id}${suffix}`, method, body, authorId);
      assert.equal(denied.status, 404, denied.text); assert.equal(denied.headers.get("cache-control"), "private, no-store");
    }
    assert.deepEqual((await list(f, "", authorId)).charts, []);
  }
  assert.equal((await request(other, `/seating-charts/${chart.id}`)).status, 404);
  assert.equal((await request(f, "/seating-charts", "GET", undefined, f.officeId)).status, 403);
  assert.equal((await request(f, "/seating-charts", "GET", undefined, f.outsideSuperId)).status, 403);
  for (const authorId of [f.adminId, f.superId]) {
    const ownChart = await createChart(f, { ...input, clientRequestId: randomUUID() }, authorId);
    assert.equal((await request(f, `/seating-charts/${ownChart.id}`)).status, 404);
  }
  const login = await fetch(baseUrl + "/fixture/impersonate", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetId: f.teacherId, originalId: f.outsideSuperId }) });
  const cookie = login.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
  assert.equal((await request(f, `/seating-charts/${chart.id}`, "GET", undefined, f.teacherId, cookie)).status, 403);
  assert.equal((await fetch(baseUrl + `/api/mydesk/seating-charts/${chart.id}`)).status, 401);
  process.env.MYDESK_SEATING_MODE = "off";
  assert.equal(z.object({ seatingEnabled: z.boolean() }).parse((await request(f, "/capabilities")).data).seatingEnabled, false);
  assert.equal((await request(f, `/seating-charts/${chart.id}`)).status, 404);
  process.env.MYDESK_SEATING_MODE = "on"; process.env.MYDESK_MODE = "off";
  assert.equal(z.object({ seatingEnabled: z.boolean() }).parse((await request(f, "/capabilities")).data).seatingEnabled, false);
  assert.equal((await request(f, `/seating-charts/${chart.id}`)).status, 404);
  process.env.MYDESK_MODE = "on";
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.teacherId]);
    await client.query("UPDATE group_teachers SET role='primary' WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.colleagueId]);
    await client.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [f.groupId, f.colleagueId]);
    await client.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [f.schoolId, f.teacherId]);
  });
  assert.equal((await request(f, `/seating-charts/${chart.id}`)).status, 403);
});

test("seating saves replay safely and concurrent current changes keep one selection without reviving deleted charts", async () => {
  const f = await fixture(), input = await createInput(f);
  const replies = await Promise.all([request(f, "/seating-charts", "POST", input), request(f, "/seating-charts", "POST", input)]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 201]);
  const first = chartEnvelope.parse(replies[0]!.data).chart;
  assert.equal(first.id, chartEnvelope.parse(replies[1]!.data).chart.id); assert.equal(first.isCurrent, true);
  assert.equal((await request(f, "/seating-charts", "POST", { ...input, name: "Changed payload" })).status, 409);
  const second = await createChart(f, { ...input, clientRequestId: randomUUID(), name: "Partner work" });
  const third = await createChart(f, { ...input, clientRequestId: randomUUID(), name: "Assessment" });
  assert.equal(second.isCurrent, false); assert.equal(third.isCurrent, false);
  const patch = { requestId: randomUUID(), revision: first.revision, name: "Saved arrangement", layout: first.layout, rosterRevision: first.rosterRevision };
  const updated = await request(f, `/seating-charts/${first.id}`, "PATCH", patch); assert.equal(updated.status, 200, updated.text);
  const retry = await request(f, `/seating-charts/${first.id}`, "PATCH", patch); assert.equal(retry.status, 200, retry.text);
  assert.equal(chartEnvelope.parse(retry.data).chart.revision, first.revision + 1);
  assert.equal((await request(f, `/seating-charts/${first.id}`, "PATCH", { ...patch, name: "Reused ID" })).status, 409);
  const makeSecond = { requestId: randomUUID(), revision: second.revision };
  const current = await request(f, `/seating-charts/${second.id}/current`, "PUT", makeSecond); assert.equal(current.status, 200, current.text);
  assert.equal((await request(f, `/seating-charts/${second.id}/current`, "PUT", makeSecond)).status, 200);
  const firstFresh = await getChart(f, first.id);
  assert.equal(firstFresh.isCurrent, false); assert.equal(firstFresh.revision, first.revision + 2);
  const concurrent = await Promise.all([firstFresh, third].map(chart => request(f, `/seating-charts/${chart.id}/current`, "PUT", { requestId: randomUUID(), revision: chart.revision })));
  assert.ok(concurrent.every(reply => reply.status === 200), concurrent.map(reply => reply.text).join("\n"));
  assert.equal((await list(f)).charts.filter(chart => chart.isCurrent).length, 1);
  const latest = await getChart(f, first.id);
  const competingSaves = await Promise.all(["One", "Two"].map(name => request(f, `/seating-charts/${first.id}`, "PATCH", {
    requestId: randomUUID(), revision: latest.revision, name, layout: latest.layout, rosterRevision: latest.rosterRevision,
  })));
  assert.deepEqual(competingSaves.map(reply => reply.status).sort(), [200, 409]);
  for (const saved of (await list(f)).charts) {
    const deletion = { requestId: randomUUID(), revision: saved.revision };
    assert.equal((await request(f, `/seating-charts/${saved.id}`, "DELETE", deletion)).status, 200);
    assert.equal((await request(f, `/seating-charts/${saved.id}`, "DELETE", deletion)).status, 200);
    assert.equal((await request(f, `/seating-charts/${saved.id}`)).status, 404);
  }
  const tombstones = await fixturePool.query<{ name: string; group_name: string; group_id: string | null; roster_revision: string; layout: SeatingLayout; roster_snapshot: unknown[]; is_current: boolean }>(
    "SELECT name,group_name,group_id,roster_revision,layout,roster_snapshot,is_current FROM mydesk_seating_charts WHERE school_id=$1 AND author_id=$2", [f.schoolId, f.teacherId]);
  assert.equal(tombstones.rows.length, 3);
  for (const row of tombstones.rows) assert.deepEqual(row, { name: "", group_name: "", group_id: null, roster_revision: "", layout: { version: 1, seats: [] }, roster_snapshot: [], is_current: false });
  assert.equal((await request(f, "/seating-charts", "POST", input)).status, 404);
  const next = await createChart(f, { ...input, clientRequestId: randomUUID(), name: "New after deletion" });
  assert.equal(next.isCurrent, false, "The first-ever decision includes deletion tombstones");
});

test("roster drift cannot rewrite saved snapshots and past charts permit only read, layout-copy and deletion", async () => {
  const f = await fixture(), input = await createInput(f); input.layout = layoutFor(f.studentId, true);
  const chart = await createChart(f, input), nextClassId = randomUUID();
  await fixtureTransaction(async client => {
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Next class','teacher_small_group','active')", [nextClassId, f.schoolId, f.teacherId]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [nextClassId, f.teacherId]);
    await client.query("DELETE FROM group_students WHERE group_id=$1 AND student_id=$2", [f.groupId, f.studentId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [nextClassId, f.studentId]);
    await client.query("UPDATE students SET first_name='Moved' WHERE id=$1", [f.studentId]);
  });
  const retained = await getChart(f, chart.id); assert.deepEqual(retained.roster, [{ id: f.studentId, name: "First Student" }]);
  assert.equal(retained.layout.seats[0]!.studentId, f.studentId);
  const patch = { requestId: randomUUID(), revision: retained.revision, name: retained.name, layout: retained.layout, rosterRevision: retained.rosterRevision };
  const stale = await request(f, `/seating-charts/${chart.id}`, "PATCH", patch); assert.equal(stale.status, 409);
  assert.equal(z.object({ code: z.string() }).parse(stale.data).code, "MYDESK_SEATING_ROSTER_CHANGED");
  const removed = await request(f, `/seating-charts/${chart.id}`, "PATCH", { ...patch, requestId: randomUUID(), rosterRevision: (await roster(f)).rosterRevision });
  assert.equal(removed.status, 409); assert.equal(z.object({ code: z.string() }).parse(removed.data).code, "MYDESK_SEATING_STUDENT_UNAVAILABLE");
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.teacherId]);
    await client.query("UPDATE group_teachers SET role='primary' WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.colleagueId]);
    await client.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [f.groupId, f.colleagueId]);
  });
  assert.equal((await getChart(f, chart.id)).canEdit, false);
  assert.equal((await request(f, `/seating-charts/${chart.id}`, "PATCH", patch)).status, 409);
  assert.equal((await request(f, `/seating-charts/${chart.id}/current`, "PUT", { requestId: randomUUID(), revision: chart.revision })).status, 409);
  const fullCopy = { clientRequestId: randomUUID(), sourceRevision: chart.revision, targetClassId: f.groupId, mode: "chart", name: "Historical copy", rosterRevision: chart.rosterRevision };
  assert.equal((await request(f, `/seating-charts/${chart.id}/duplicate`, "POST", fullCopy)).status, 409);
  const nextRoster = await roster(f, nextClassId);
  const copy = { ...fullCopy, clientRequestId: randomUUID(), targetClassId: nextClassId, mode: "layout", rosterRevision: nextRoster.rosterRevision };
  const copied = await request(f, `/seating-charts/${chart.id}/duplicate`, "POST", copy); assert.equal(copied.status, 201, copied.text);
  const copyChart = chartEnvelope.parse(copied.data).chart;
  assert.equal(copyChart.isCurrent, true); assert.equal(copyChart.classId, nextClassId); assert.equal(copyChart.canEdit, true);
  assert.deepEqual(copyChart.layout.seats.map(seat => [seat.x, seat.y, seat.studentId, seat.locked]), [[0, 0, null, false], [120, 0, null, false]]);
  assert.ok(copyChart.layout.seats.every(seat => !chart.layout.seats.some(source => source.id === seat.id)));
  assert.deepEqual(copyChart.roster, [{ id: f.studentId, name: "Moved Student" }]);
  const copyRetry = await request(f, `/seating-charts/${chart.id}/duplicate`, "POST", copy); assert.equal(copyRetry.status, 200); assert.equal(chartEnvelope.parse(copyRetry.data).chart.id, copyChart.id);
  assert.deepEqual((await list(f)).charts.map(row => row.id), [copyChart.id]);
  assert.deepEqual((await list(f, "?scope=past")).charts.map(row => row.id), [chart.id]);
  const classes = z.object({ past: z.array(z.object({ id: z.string(), name: z.string() })) }).parse((await request(f, "/classes")).data);
  assert.deepEqual(classes.past, [{ id: f.groupId, name: "Science" }]);
  assert.deepEqual((await request(f, `/classes/${f.groupId}/note-students`)).data, { students: [] });
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_teachers WHERE group_id=$1", [f.groupId]);
    await client.query("DELETE FROM groups WHERE id=$1", [f.groupId]);
  });
  const deletedClass = await getChart(f, chart.id); assert.equal(deletedClass.classId, null); assert.equal(deletedClass.filingGroupId, f.groupId); assert.equal(deletedClass.className, "Science");
  assert.equal((await request(f, `/classes/${f.groupId}/note-students`, "GET", undefined, f.adminId)).status, 404);
  assert.equal((await request(f, `/seating-charts/${chart.id}`, "DELETE", { requestId: randomUUID(), revision: chart.revision })).status, 200);
});

test("5th and 6th grade charts work without sessions and refresh additions, renames and deactivation explicitly", async () => {
  const f = await fixture(), sixthId = randomUUID(), addedId = randomUUID();
  await fixtureTransaction(async client => {
    await client.query("UPDATE groups SET name='5th grade',group_type='admin_class' WHERE id=$1", [f.groupId]);
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'6th grade','teacher_small_group','active')", [sixthId, f.schoolId, f.colleagueId]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($1,$3,'co-teacher')", [sixthId, f.colleagueId, f.teacherId]);
  });
  const input = await createInput(f);
  const firstSaves = await Promise.all(["Rows", "Pairs"].map(name => request(f, "/seating-charts", "POST", { ...input, clientRequestId: randomUUID(), name })));
  assert.ok(firstSaves.every(response => response.status === 201), firstSaves.map(response => response.text).join("\n"));
  const fifthCharts = firstSaves.map(response => chartEnvelope.parse(response.data).chart);
  assert.equal(fifthCharts.filter(chart => chart.isCurrent).length, 1, "Concurrent distinct first saves designate exactly one current chart");
  const sixthRoster = await roster(f, sixthId);
  const sixth = await createChart(f, { clientRequestId: randomUUID(), classId: sixthId, name: "Sixth", layout: layoutFor(null), rosterRevision: sixthRoster.rosterRevision });
  assert.equal(sixth.isCurrent, true); assert.equal(sixth.className, "6th grade");
  await fixtureTransaction(async client => {
    await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'New','Student','active')", [addedId, f.schoolId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId, addedId]);
  });
  let chart = fifthCharts[0]!;
  const edit = (current: z.infer<typeof chartSchema>, rosterRevision: string, layout = current.layout) => ({
    requestId: randomUUID(), revision: current.revision, name: current.name, layout, rosterRevision,
  });
  assert.equal((await request(f, `/seating-charts/${chart.id}`, "PATCH", edit(chart, chart.rosterRevision))).status, 409);
  const withAddition = await roster(f);
  assert.equal(withAddition.students.length, 2);
  const assigned: SeatingLayout = { version: 1, seats: chart.layout.seats.map((seat, index) => index === 1 ? { ...seat, studentId: addedId } : seat) };
  const savedAddition = await request(f, `/seating-charts/${chart.id}`, "PATCH", edit(chart, withAddition.rosterRevision, assigned));
  assert.equal(savedAddition.status, 200, savedAddition.text); chart = chartEnvelope.parse(savedAddition.data).chart;
  assert.equal(chart.roster.length, 2); assert.equal(chart.layout.seats[1]!.studentId, addedId);
  await fixturePool.query("UPDATE students SET first_name='Renamed' WHERE id=$1", [f.studentId]);
  assert.equal((await getChart(f, chart.id)).roster.find(student => student.id === f.studentId)?.name, "First Student");
  const renamedRoster = await roster(f); assert.notEqual(renamedRoster.rosterRevision, chart.rosterRevision);
  const savedRename = await request(f, `/seating-charts/${chart.id}`, "PATCH", edit(chart, renamedRoster.rosterRevision));
  assert.equal(savedRename.status, 200, savedRename.text); chart = chartEnvelope.parse(savedRename.data).chart;
  assert.equal(chart.roster.find(student => student.id === f.studentId)?.name, "Renamed Student");
  await fixturePool.query("UPDATE students SET status='inactive' WHERE id=$1", [addedId]);
  const inactiveRoster = await roster(f); assert.deepEqual(inactiveRoster.students, [{ id: f.studentId, name: "Renamed Student" }]);
  assert.equal((await request(f, `/seating-charts/${chart.id}`, "PATCH", edit(chart, inactiveRoster.rosterRevision))).status, 409);
  const cleared: SeatingLayout = { version: 1, seats: chart.layout.seats.map(seat => seat.studentId === addedId ? { ...seat, studentId: null, locked: false } : seat) };
  const savedRemoval = await request(f, `/seating-charts/${chart.id}`, "PATCH", edit(chart, inactiveRoster.rosterRevision, cleared));
  assert.equal(savedRemoval.status, 200, savedRemoval.text); chart = chartEnvelope.parse(savedRemoval.data).chart;
  assert.deepEqual(chart.roster, [{ id: f.studentId, name: "Renamed Student" }]);
  assert.equal(chart.layout.seats[1]!.studentId, null);
  assert.deepEqual(new Set((await list(f, `?classId=${f.groupId}`)).charts.map(row => row.id)), new Set(fifthCharts.map(row => row.id)));
  assert.deepEqual((await list(f, `?classId=${sixthId}`)).charts.map(row => row.id), [sixth.id]);
  assert.equal((await list(f)).charts.filter(row => row.isCurrent).length, 2);
  assert.equal((await fixturePool.query<{ count: number }>("SELECT count(*)::int AS count FROM teaching_sessions WHERE school_id=$1", [f.schoolId])).rows[0]!.count, 0);
});

test("lost create, edit and delete HTTP responses replay without duplicate charts or mutations", async () => {
  const f = await fixture(), input = await createInput(f);
  const dropResponse = (path: string, method: string, body: unknown) => fetch(baseUrl + "/api/mydesk" + path, { method,
    headers: { "content-type": "application/json", "x-school-id": f.schoolId, "x-fixture-drop-response": "1",
      authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.test`, authVersion: 1 })}` },
    body: JSON.stringify(body),
  });
  await assert.rejects(dropResponse("/seating-charts", "POST", input));
  const retry = await request(f, "/seating-charts", "POST", input); assert.equal(retry.status, 200, retry.text);
  const chart = chartEnvelope.parse(retry.data).chart;
  assert.equal((await list(f)).charts.length, 1);
  const update = { requestId: randomUUID(), revision: chart.revision, name: "Committed before disconnect", layout: chart.layout, rosterRevision: chart.rosterRevision };
  await assert.rejects(dropResponse(`/seating-charts/${chart.id}`, "PATCH", update));
  const editRetry = await request(f, `/seating-charts/${chart.id}`, "PATCH", update); assert.equal(editRetry.status, 200, editRetry.text);
  const edited = chartEnvelope.parse(editRetry.data).chart; assert.equal(edited.revision, chart.revision + 1); assert.equal(edited.name, update.name);
  const deletion = { requestId: randomUUID(), revision: edited.revision };
  await assert.rejects(dropResponse(`/seating-charts/${chart.id}`, "DELETE", deletion));
  assert.equal((await request(f, `/seating-charts/${chart.id}`, "DELETE", deletion)).status, 200);
  assert.equal((await request(f, "/seating-charts", "POST", input)).status, 404);
  assert.deepEqual((await list(f)).charts, []);
});

test("class deletion and a concurrent chart save use group-before-chart locks without deadlocking", async () => {
  const f = await fixture(), chart = await createChart(f, await createInput(f));
  const client = await fixturePool.connect(); let saving: ReturnType<typeof request> | undefined;
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SELECT id FROM groups WHERE id=$1 FOR UPDATE", [f.groupId]);
    saving = request(f, `/seating-charts/${chart.id}`, "PATCH", { requestId: randomUUID(), revision: chart.revision,
      name: "Concurrent save", layout: chart.layout, rosterRevision: chart.rosterRevision });
    const deadline = Date.now() + 5000; let blocked = false;
    while (Date.now() < deadline) {
      const activity = await fixturePool.query<{ blocked: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state='active' AND wait_event_type='Lock' AND query LIKE '%"groups"%' AND query ILIKE '%for update%'
      ) AS blocked`);
      if (activity.rows[0]!.blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true, "The HTTP save must reach the group lock barrier");
    await client.query("DELETE FROM group_students WHERE group_id=$1", [f.groupId]);
    await client.query("DELETE FROM group_teachers WHERE group_id=$1", [f.groupId]);
    await client.query("DELETE FROM groups WHERE id=$1", [f.groupId]);
    await client.query("COMMIT");
    const response = await saving; assert.equal(response.status, 409, response.text);
    assert.equal(z.object({ code: z.string() }).parse(response.data).code, "MYDESK_SEATING_READ_ONLY");
    const retained = await getChart(f, chart.id); assert.equal(retained.classId, null); assert.equal(retained.name, chart.name);
  } catch (error) { await client.query("ROLLBACK"); await saving; throw error; }
  finally { client.release(); }
});

test("seating rejects forged ownership, student labels, invalid layouts and oversized rosters", async () => {
  const f = await fixture(), other = await fixture(), input = await createInput(f);
  for (const extra of [{ authorId: f.adminId }, { schoolId: other.schoolId }, { roster: [{ id: f.studentId, name: "Forged label" }] }]) {
    assert.equal((await request(f, "/seating-charts", "POST", { ...input, ...extra })).status, 400);
  }
  assert.equal((await request(f, "/seating-charts", "POST", { ...input, layout: { version: 1, seats: [{ ...input.layout.seats[0], name: "Forged" }] } })).status, 400);
  assert.equal((await request(f, "/seating-charts", "POST", { ...input, layout: layoutFor(other.studentId) })).status, 409);
  assert.equal((await request(f, "/seating-charts", "POST", { ...input, classId: other.groupId })).status, 404);
  assert.equal((await request(f, "/seating-charts", "POST", { ...input, layout: { version: 1, seats: input.layout.seats.map(seat => ({ ...seat, x: 0 })) } })).status, 400);
  await fixturePool.query("UPDATE students SET first_name=repeat('x',501) WHERE id=$1", [f.studentId]);
  assert.equal((await request(f, `/classes/${f.groupId}/students`)).status, 409);
  assert.equal((await request(f, "/seating-charts", "POST", input)).status, 409);
  await fixturePool.query("UPDATE students SET first_name='First' WHERE id=$1", [f.studentId]);
  await fixtureTransaction(async client => {
    await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) SELECT gen_random_uuid(),$1,'Large',n::text,'active' FROM generate_series(1,1000)n", [f.schoolId]);
    await client.query("INSERT INTO group_students(group_id,student_id) SELECT $1,id FROM students WHERE school_id=$2 AND first_name='Large'", [f.groupId, f.schoolId]);
  });
  const large = await request(f, `/classes/${f.groupId}/students`); assert.equal(large.status, 409);
  assert.equal(z.object({ code: z.string() }).parse(large.data).code, "MYDESK_SEATING_ROSTER_TOO_LARGE");
  assert.equal((await request(f, "/seating-charts", "POST", input)).status, 409);
});

test("seating library paginates same-timestamp summaries and binds cursors to owner and scope", async () => {
  const f = await fixture();
  await fixturePool.query("INSERT INTO mydesk_seating_charts(school_id,author_id,client_request_id,request_fingerprint,group_id,filing_group_id,group_name,name,roster_revision) SELECT $1,$2,gen_random_uuid(),repeat('a',64),$3,$3,'Science','Chart '||n,repeat('b',64) FROM generate_series(1,35)n", [f.schoolId, f.teacherId, f.groupId]);
  const first = await list(f, "?limit=10"); assert.equal(first.charts.length, 10); assert.ok(first.nextCursor);
  const ids = first.charts.map(chart => chart.id); let cursor: string | null = first.nextCursor;
  while (cursor) {
    const page = await list(f, `?limit=10&cursor=${encodeURIComponent(cursor)}`); ids.push(...page.charts.map(chart => chart.id)); cursor = page.nextCursor;
  }
  assert.equal(ids.length, 35); assert.equal(new Set(ids).size, 35);
  assert.equal((await request(f, `/seating-charts?scope=past&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
  assert.equal((await request(f, `/seating-charts?cursor=${encodeURIComponent(first.nextCursor)}`, "GET", undefined, f.colleagueId)).status, 400);
  assert.deepEqual((await list(f, "", f.colleagueId)).charts, []);
  if (process.env.RLS_GUC_ENABLED === "true") {
    assert.equal((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM mydesk_seating_charts WHERE school_id=$1", [f.schoolId])).rows[0]!.count, 0);
  }
});
