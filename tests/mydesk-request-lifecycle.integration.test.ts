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
import myDeskRouter from "../src/routes/mydesk.js";
import { drainTenantContextReleases } from "../src/middleware/tenantContext.js";
import { myDeskObjectStore, myDeskSha256 } from "../src/services/mydeskFiles.js";
import { signUserToken } from "../src/services/jwt.js";

const ids = { school: randomUUID(), otherSchool: randomUUID(), author: randomUUID() };
const fixturePool = process.env.ADMIN_DATABASE_URL ? new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2 }) : pool;
const originalStore = { ...myDeskObjectStore };
const objects = new Map<string, Buffer>();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const requestEvents = new Map<string, { closed: ReturnType<typeof deferred>; responded: ReturnType<typeof deferred> }>();
let putGate: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;
let getGate: typeof putGate;
let server: Server, baseUrl: string, photo: Buffer;
const noteEnvelope = z.object({ note: z.object({ id: z.string(), revision: z.number() }) });
const fileEnvelope = z.object({ attachment: z.object({ id: z.string() }) });
const timeout = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Fixture operation did not finish")), 5_000); timer.unref();
})]);

function headers(tag?: string) {
  return { "x-school-id": ids.school, authorization: `Bearer ${signUserToken({ userId: ids.author, email: `${ids.author}@example.test`, authVersion: 1 })}`,
    ...(tag ? { "x-fixture-request": tag } : {}) };
}
async function jsonRequest(path: string, body: unknown) {
  const response = await fetch(baseUrl + path, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
async function draftWithReservation() {
  const note = noteEnvelope.parse(await jsonRequest("/notes", { clientRequestId: randomUUID(), body: "Private fixture" })).note;
  const attachment = fileEnvelope.parse(await jsonRequest(`/notes/${note.id}/attachments`, {
    clientRequestId: randomUUID(), filename: "work.png", contentType: "image/png", size: photo.length, sha256: myDeskSha256(photo),
  })).attachment;
  return { note, attachment, path: `/notes/${note.id}/attachments/${attachment.id}/content` };
}

before(async () => {
  for (const url of [process.env.DATABASE_URL, process.env.ADMIN_DATABASE_URL].filter(Boolean)) {
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(url!).hostname), "Only local fixture databases are permitted");
  }
  await fixturePool.query(MYDESK_SQL);
  if (process.env.RLS_GUC_ENABLED === "true") {
    const role = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.deepEqual(role.rows[0], { current_user: process.env.RLS_TEST_ROLE, rolsuper: false, rolbypassrls: false });
  }
  await fixturePool.query("INSERT INTO schools(id,name,status,is_active,plan_status) VALUES($1,'Lifecycle fixture','active',true,'active'),($2,'Other lifecycle fixture','active',true,'active')", [ids.school, ids.otherSchool]);
  await fixturePool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Private','Author')", [ids.author, `${ids.author}@example.test`]);
  await fixturePool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, ids.author]);
  await fixturePool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  process.env.MYDESK_ENABLED_SCHOOL_IDS = ids.school;
  photo = await sharp({ create: { width: 12, height: 16, channels: 3, background: "#4488ff" } }).png().toBuffer();
  myDeskObjectStore.put = async (key, bytes) => { putGate?.entered.resolve(); if (putGate) await putGate.released.promise; objects.set(key, bytes); };
  myDeskObjectStore.get = async key => { getGate?.entered.resolve(); if (getGate) await getGate.released.promise; const bytes = objects.get(key); assert.ok(bytes); return bytes; };
  myDeskObjectStore.delete = async key => { objects.delete(key); };
  const app = express(); app.use(express.json());
  app.use(session({ secret: "mydesk-lifecycle-local-session-secret", resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    const events = requestEvents.get(req.get("x-fixture-request") || "");
    if (events) {
      res.once("close", events.closed.resolve);
      const send = res.send.bind(res);
      res.send = body => { events.responded.resolve(); return send(body); };
    }
    next();
  });
  app.use("/api/mydesk", myDeskRouter);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); baseUrl = `http://127.0.0.1:${address.port}/api/mydesk`;
});

after(async () => {
  putGate?.released.resolve(); getGate?.released.resolve();
  Object.assign(myDeskObjectStore, originalStore);
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL app.is_super='on'");
    for (const table of ["mydesk_attachments", "mydesk_notes", "audit_logs"]) await client.query(`DELETE FROM ${table} WHERE school_id=$1`, [ids.school]);
    await client.query("UPDATE schools SET deleted_at=now() WHERE id=ANY($1::text[])", [[ids.school, ids.otherSchool]]);
    await client.query("DELETE FROM product_licenses WHERE school_id=$1", [ids.school]);
    await client.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  await Promise.all([pool.end(), sessionPool.end(), ...(fixturePool !== pool ? [fixturePool.end()] : [])]);
});

async function abortDuringStorage(method: "PUT" | "GET", path: string, gate: NonNullable<typeof putGate>, beforeResume?: () => Promise<void>) {
  const tag = randomUUID(), events = { closed: deferred(), responded: deferred() };
  requestEvents.set(tag, events);
  const controller = new AbortController();
  const response = fetch(baseUrl + path, { method, headers: { ...headers(tag), ...(method === "PUT" ? { "content-type": "image/png" } : {}) },
    body: method === "PUT" ? new Uint8Array(photo) : undefined, signal: controller.signal }).catch(() => undefined);
  await timeout(gate.entered.promise);
  // Check this after the borrowed-transaction assertion so a regression also exercises stale-client reuse.
  const idleDuringStorage = pool.totalCount === pool.idleCount;
  controller.abort(); await response; await timeout(events.closed.promise); await drainTenantContextReleases();
  assert.equal(pool.totalCount, pool.idleCount, "aborted HTTP request must not retain a database client");
  await beforeResume?.();
  const borrower = await pool.connect();
  try {
    await borrower.query("BEGIN");
    await borrower.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true),set_config('mydesk.fixture_transaction','still-open',true)", [ids.otherSchool]);
    gate.released.resolve(); await timeout(events.responded.promise);
    const current = await borrower.query<{ school_id: string; marker: string }>(
      "SELECT current_setting('app.school_id',true) school_id,current_setting('mydesk.fixture_transaction',true) marker");
    assert.deepEqual(current.rows[0], { school_id: ids.otherSchool, marker: "still-open" }, "cancelled handler must not query/commit/rollback a client reused by another tenant");
    assert.ok(idleDuringStorage, "external file I/O must leave the application pool idle");
  } finally {
    gate.released.resolve(); await borrower.query("ROLLBACK"); borrower.release(); requestEvents.delete(tag);
  }
}

test("aborted HTTP upload finalizes through a fresh tenant scope without reusing another request's transaction", async () => {
  const upload = await draftWithReservation();
  putGate = { entered: deferred(), released: deferred() };
  try { await abortDuringStorage("PUT", upload.path, putGate); }
  finally { putGate.released.resolve(); putGate = undefined; }
  const result = await fixturePool.query<{ status: string; school_id: string; author_id: string }>(
    "SELECT status,school_id,author_id FROM mydesk_attachments WHERE id=$1", [upload.attachment.id]);
  assert.deepEqual(result.rows[0], { status: "ready", school_id: ids.school, author_id: ids.author });
});

test("aborted HTTP download rechecks ownership without disturbing another tenant's borrowed client", async () => {
  const upload = await draftWithReservation();
  const uploaded = await fetch(baseUrl + upload.path, { method: "PUT", headers: { ...headers(), "content-type": "image/png" }, body: new Uint8Array(photo) });
  assert.ok(uploaded.ok, await uploaded.text());
  await jsonRequest(`/notes/${upload.note.id}/complete`, { revision: upload.note.revision, attachmentIds: [upload.attachment.id] });
  getGate = { entered: deferred(), released: deferred() };
  try { await abortDuringStorage("GET", upload.path, getGate); }
  finally { getGate.released.resolve(); getGate = undefined; }
});

test("aborted upload into a deleted note repairs its cleanup queue in a fresh tenant scope", async () => {
  const upload = await draftWithReservation();
  putGate = { entered: deferred(), released: deferred() };
  try {
    await abortDuringStorage("PUT", upload.path, putGate, async () => {
      const deleted = await fetch(baseUrl + `/notes/${upload.note.id}`, { method: "DELETE",
        headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ revision: upload.note.revision }) });
      assert.ok(deleted.ok, await deleted.text());
    });
  } finally { putGate.released.resolve(); putGate = undefined; }
  const result = await fixturePool.query<{ status: string; school_id: string; author_id: string; note_id: string; last_error_code: string; next_cleanup_at: Date | null }>(
    "SELECT status,school_id,author_id,note_id,last_error_code,next_cleanup_at FROM mydesk_attachments WHERE id=$1", [upload.attachment.id]);
  const row = result.rows[0]; assert.ok(row?.next_cleanup_at);
  assert.deepEqual({ ...row, next_cleanup_at: undefined }, { status: "delete_pending", school_id: ids.school, author_id: ids.author,
    note_id: upload.note.id, last_error_code: "late_upload", next_cleanup_at: undefined });
});
