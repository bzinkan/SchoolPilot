import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import session from "express-session";
import pg from "pg";
import sharp from "sharp";
import { z } from "zod";
import { pool, sessionPool } from "../src/db.js";
import { MYDESK_SQL } from "../src/db/mydeskMigration.js";
import { MYDESK_IMPORTS_SQL } from "../src/db/mydeskImportsMigration.js";
import myDeskRouter from "../src/routes/mydesk.js";
import { myDeskUpstreamErrorBoundary } from "../src/middleware/mydeskUpstreamErrorBoundary.js";
import { signUserToken } from "../src/services/jwt.js";
import { myDeskObjectStore, myDeskSha256 } from "../src/services/mydeskFiles.js";

const fixturePool = process.env.ADMIN_DATABASE_URL ? new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2 }) : pool;
const schoolIds: string[] = [];
const stored = new Map<string, Buffer>();
const realStore = { ...myDeskObjectStore };
let server: Server, baseUrl: string;
const runEnvelope = z.object({ import: z.object({ id: z.string(), revision: z.number(), status: z.string(), selectedGroupIds: z.array(z.string()), assets: z.array(z.object({ id: z.string(), status: z.string() })), items: z.array(z.unknown()) }) });
const assetEnvelope = z.object({ asset: z.object({ id: z.string(), status: z.string() }) });

before(async () => {
  for (const value of [process.env.DATABASE_URL, process.env.ADMIN_DATABASE_URL].filter((value): value is string => !!value)) {
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname), "HTTP fixtures are local only");
  }
  await fixturePool.query(MYDESK_SQL); await fixturePool.query(MYDESK_IMPORTS_SQL);
  if (process.env.RLS_GUC_ENABLED === "true") {
    const roleName = process.env.RLS_TEST_ROLE || ""; assert.match(roleName, /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
    await fixturePool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON mydesk_imports,mydesk_import_items,mydesk_import_assets,mydesk_notes,mydesk_attachments TO "${roleName}"`);
    const role = await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
  }
  myDeskObjectStore.put = async (key, bytes) => { stored.set(key, Buffer.from(bytes)); };
  myDeskObjectStore.get = async key => { const bytes = stored.get(key); if (!bytes) throw new Error("fixture missing object"); return Buffer.from(bytes); };
  myDeskObjectStore.delete = async key => { stored.delete(key); };
  const app = express(); app.use(express.json());
  app.use(session({ secret: "mydesk-synthetic-http-session", resave: false, saveUninitialized: false }));
  app.post("/fixture/impersonate", (req, res) => {
    const input = z.object({ targetId: z.string(), originalId: z.string() }).parse(req.body);
    req.session.userId = input.targetId; req.session.originalUserId = input.originalId; req.session.impersonating = true; req.session.authVersion = 1;
    res.json({ ok: true });
  });
  app.use("/api/mydesk", (req, res, next) => {
    if (req.headers["x-fixture-drop-response"] === "1") res.json = () => { res.destroy(); return res; };
    next();
  }, myDeskRouter);
  app.use("/api/mydesk", myDeskUpstreamErrorBoundary);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  Object.assign(myDeskObjectStore, realStore);
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL app.is_super='on'");
    await client.query("UPDATE schools SET deleted_at=now() WHERE id=ANY($1::text[])", [schoolIds]);
    for (const table of ["mydesk_import_items", "mydesk_import_assets", "mydesk_imports", "mydesk_attachments", "mydesk_notes", "audit_logs"])
      await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    for (const table of ["group_students", "group_teachers"])
      await client.query(`DELETE FROM ${table} WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))`, [schoolIds]);
    for (const table of ["groups", "students", "settings", "school_memberships", "product_licenses"])
      await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await Promise.all([pool.end(), sessionPool.end(), ...(fixturePool !== pool ? [fixturePool.end()] : [])]); }
});

async function fixture() {
  const f = { schoolId: randomUUID(), teacherId: randomUUID(), colleagueId: randomUUID(), adminId: randomUUID(), superId: randomUUID(), outsideSuperId: randomUUID(), groupId: randomUUID(), studentId: randomUUID() };
  schoolIds.push(f.schoolId);
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL app.is_super='on'");
    await client.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Synthetic import school','active',true,'active','America/New_York')", [f.schoolId]);
    await client.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [f.schoolId]);
    for (const [id, role] of [[f.teacherId, "teacher"], [f.colleagueId, "teacher"], [f.adminId, "school_admin"], [f.superId, "teacher"], [f.outsideSuperId, null]]) {
      await client.query("INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Synthetic','Author',$3)", [id, `${id}@example.test`, id === f.superId || id === f.outsideSuperId]);
      if (role) await client.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [f.schoolId, id, role]);
    }
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'5th grade','teacher_created','active')", [f.groupId, f.schoolId, f.teacherId]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($1,$3,'co-teacher'),($1,$4,'co-teacher')", [f.groupId, f.teacherId, f.colleagueId, f.superId]);
    await client.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Jordan','Example','active')", [f.studentId, f.schoolId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.groupId, f.studentId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  process.env.MYDESK_ENABLED_SCHOOL_IDS = schoolIds.join(","); process.env.MYDESK_AI_IMPORT_ENABLED_SCHOOL_IDS = schoolIds.join(",");
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function headers(f: Fixture, authorId = f.teacherId) { return { "x-school-id": f.schoolId,
  authorization: `Bearer ${signUserToken({ userId: authorId, email: `${authorId}@example.test`, authVersion: 1 })}`, "content-type": "application/json" }; }
async function api(f: Fixture, path: string, method = "GET", body?: unknown, authorId = f.teacherId) {
  const response = await fetch(`${baseUrl}/api/mydesk${path}`, { method, headers: headers(f, authorId), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, body: await response.json() };
}
async function create(f: Fixture) {
  const result = await api(f, "/imports", "POST", { clientRequestId: randomUUID(), selectedGroupIds: [f.groupId], expectedSourceCount: 1 });
  assert.equal(result.response.status, 201); return runEnvelope.parse(result.body).import;
}
async function source(f: Fixture, runId: string) {
  const bytes = await sharp({ create: { width: 400, height: 600, channels: 3, background: "white" } }).jpeg().toBuffer();
  const reservation = { clientRequestId: randomUUID(), filename: "synthetic-forms.jpg", contentType: "image/jpeg", size: bytes.length, sha256: myDeskSha256(bytes) };
  const result = await api(f, `/imports/${runId}/assets`, "POST", reservation); assert.equal(result.response.status, 201);
  return { bytes, reservation, asset: assetEnvelope.parse(result.body).asset };
}

test("HTTP import creates and lists author-private drafts without a teaching session or note", async () => {
  const f = await fixture(), run = await create(f);
  assert.equal(run.status, "uploading"); assert.deepEqual(run.selectedGroupIds, [f.groupId]);
  const own = await api(f, "/imports"); assert.equal(own.response.status, 200); assert.match(own.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(z.object({ imports: z.array(z.object({ id: z.string() })) }).parse(own.body).imports[0]?.id, run.id);
  const colleague = await api(f, "/imports", "GET", undefined, f.colleagueId);
  assert.deepEqual(z.object({ imports: z.array(z.unknown()) }).parse(colleague.body).imports, []);
  const notes = await api(f, "/notes"); assert.deepEqual(z.object({ notes: z.array(z.unknown()) }).parse(notes.body).notes, []);
  const capabilities = await api(f, "/capabilities"); assert.equal(capabilities.response.status, 200);
});

test("HTTP IDs never grant another teacher, administrator, super administrator, or school access", async () => {
  const f = await fixture(), other = await fixture(), run = await create(f), file = await source(f, run.id);
  const itemId = randomUUID(), continuationId = randomUUID();
  for (const [index, id] of [itemId, continuationId].entries())
    await fixturePool.query("INSERT INTO mydesk_import_items(id,school_id,author_id,import_id,client_request_id,ordinal,body) VALUES($1,$2,$3,$4,$5,$6,'Synthetic private form')", [id, f.schoolId, f.teacherId, run.id, randomUUID(), index]);
  const mutation = { requestId: randomUUID(), revision: run.revision };
  const cases: Array<[string, string, unknown?]> = [
    [`/imports/${run.id}`, "GET"], [`/imports/${run.id}`, "PATCH", mutation], [`/imports/${run.id}`, "DELETE", mutation],
    [`/imports/${run.id}/process`, "POST", mutation], [`/imports/${run.id}/assets/${file.asset.id}/content`, "GET"],
    [`/imports/${run.id}/assets`, "POST", { ...file.reservation, clientRequestId: randomUUID() }],
    [`/imports/${run.id}/items`, "POST", { ...mutation, regions: [{ assetId: file.asset.id, x: 0, y: 0, width: 1, height: 1, rotation: 0 }] }],
    [`/imports/${run.id}/items/${itemId}`, "PATCH", { ...mutation, itemRevision: 1, reviewed: true }],
    [`/imports/${run.id}/items/${itemId}/reread`, "POST", { ...mutation, itemRevision: 1 }],
    [`/imports/${run.id}/items/${itemId}/join`, "POST", { ...mutation, itemRevision: 1, sourceItemId: continuationId, sourceItemRevision: 1 }],
    [`/imports/${run.id}/commit`, "POST", { ...mutation, itemIds: [itemId] }],
  ];
  for (const authorId of [f.colleagueId, f.adminId, f.superId]) {
    for (const [path, method, body] of cases) {
      const result = await api(f, path, method, body, authorId); assert.equal(result.response.status, 404, `${method} ${path}`);
      assert.ok(!JSON.stringify(result.body).includes("synthetic-forms"));
      assert.ok(!JSON.stringify(result.body).includes("Synthetic private form"));
    }
    const upload = await fetch(`${baseUrl}/api/mydesk/imports/${run.id}/assets/${file.asset.id}/content`, { method: "PUT", headers: { ...headers(f, authorId), "content-type": "image/jpeg" }, body: new Uint8Array(file.bytes) });
    assert.equal(upload.status, 404);
  }
  for (const [path, method, body] of cases) {
    assert.equal((await api(other, path, method, body)).response.status, 404, `cross-school ${method} ${path}`);
    assert.equal((await api(f, path, method, body, f.outsideSuperId)).response.status, 403, `unqualified super ${method} ${path}`);
  }
  const impersonation = await fetch(`${baseUrl}/fixture/impersonate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: f.teacherId, originalId: f.adminId }) });
  const cookie = impersonation.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
  for (const [path, method, body] of cases) {
    const result = await fetch(`${baseUrl}/api/mydesk${path}`, { method, headers: { ...headers(f), cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(result.status, 403, `impersonated ${method} ${path}`);
  }
  for (const scope of [
    { headers: headers(other), status: 404 },
    { headers: headers(f, f.outsideSuperId), status: 403 },
    { headers: { ...headers(f), cookie }, status: 403 },
  ]) {
    const result = await fetch(`${baseUrl}/api/mydesk/imports/${run.id}/assets/${file.asset.id}/content`, { method: "PUT", headers: { ...scope.headers, "content-type": "image/jpeg" }, body: new Uint8Array(file.bytes) });
    assert.equal(result.status, scope.status);
  }
  const ownedSuper = await api(f, "/imports", "POST", { clientRequestId: randomUUID(), selectedGroupIds: [f.groupId], expectedSourceCount: 1 }, f.superId);
  assert.equal(ownedSuper.response.status, 201);
});

test("HTTP impersonation, revoked membership and disabled rollout cannot read retained drafts", async () => {
  const f = await fixture(), run = await create(f);
  const impersonation = await fetch(`${baseUrl}/fixture/impersonate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: f.teacherId, originalId: f.adminId }) });
  const cookie = impersonation.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
  const denied = await fetch(`${baseUrl}/api/mydesk/imports/${run.id}`, { headers: { "x-school-id": f.schoolId, cookie } }); assert.equal(denied.status, 403);
  process.env.MYDESK_AI_IMPORT_ENABLED_SCHOOL_IDS = schoolIds.filter(id => id !== f.schoolId).join(",");
  assert.equal((await api(f, `/imports/${run.id}`)).response.status, 404);
  process.env.MYDESK_AI_IMPORT_ENABLED_SCHOOL_IDS = schoolIds.join(",");
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL app.is_super='on'");
    await client.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.teacherId]);
    await client.query("UPDATE group_teachers SET role='primary' WHERE group_id=$1 AND teacher_id=$2", [f.groupId, f.colleagueId]);
    await client.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [f.groupId, f.colleagueId]);
    await client.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [f.schoolId, f.teacherId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  assert.equal((await api(f, `/imports/${run.id}`)).response.status, 403);
});

test("HTTP source upload retries reuse one private object and cancellation removes preview access immediately", async () => {
  const f = await fixture(), run = await create(f), file = await source(f, run.id), beforeObjects = stored.size;
  const put = () => fetch(`${baseUrl}/api/mydesk/imports/${run.id}/assets/${file.asset.id}/content`, { method: "PUT", headers: { ...headers(f), "content-type": "image/jpeg" }, body: new Uint8Array(file.bytes) });
  assert.equal((await put()).status, 200); assert.equal((await put()).status, 200); assert.equal(stored.size, beforeObjects + 1);
  const preview = await fetch(`${baseUrl}/api/mydesk/imports/${run.id}/assets/${file.asset.id}/content`, { headers: headers(f) });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("content-type"), "image/jpeg");
  assert.match(preview.headers.get("cache-control") || "", /no-store/); assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  const fresh = runEnvelope.parse((await api(f, `/imports/${run.id}`)).body).import;
  const cancelled = await api(f, `/imports/${run.id}`, "DELETE", { requestId: randomUUID(), revision: fresh.revision }); assert.equal(cancelled.response.status, 200);
  const unavailable = await fetch(`${baseUrl}/api/mydesk/imports/${run.id}/assets/${file.asset.id}/content`, { headers: headers(f) }); assert.ok([404, 409].includes(unavailable.status));
  const terminal = runEnvelope.parse((await api(f, `/imports/${run.id}`)).body).import;
  assert.deepEqual(terminal.assets, []); assert.deepEqual(terminal.items, []); assert.deepEqual(terminal.selectedGroupIds, []);
});

test("HTTP lost create response and changed retry bodies cannot duplicate imports", async () => {
  const f = await fixture(), body = { clientRequestId: randomUUID(), selectedGroupIds: [f.groupId], expectedSourceCount: 1 };
  await assert.rejects(fetch(`${baseUrl}/api/mydesk/imports`, { method: "POST", headers: { ...headers(f), "x-fixture-drop-response": "1" }, body: JSON.stringify(body) }));
  const retry = await api(f, "/imports", "POST", body); assert.equal(retry.response.status, 200);
  const firstId = runEnvelope.parse(retry.body).import.id;
  const again = await api(f, "/imports", "POST", body); assert.equal(runEnvelope.parse(again.body).import.id, firstId);
  const changed = await api(f, "/imports", "POST", { ...body, selectedGroupIds: [randomUUID()] }); assert.equal(changed.response.status, 409);
  const list = z.object({ imports: z.array(z.object({ id: z.string() })) }).parse((await api(f, "/imports")).body);
  assert.deepEqual(list.imports.map(item => item.id), [firstId]);
});

test("HTTP parsing and strict ownership fields cannot expose document text", async () => {
  const f = await fixture();
  const malformed = await fetch(`${baseUrl}/api/mydesk/imports`, { method: "POST", headers: headers(f), body: '{"private_document":"SENSITIVE SYNTHETIC TEXT",' });
  assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes("SENSITIVE"));
  const injected = await api(f, "/imports", "POST", { clientRequestId: randomUUID(), selectedGroupIds: [f.groupId], expectedSourceCount: 1, authorId: f.colleagueId, schoolId: f.schoolId });
  assert.equal(injected.response.status, 400);
});
