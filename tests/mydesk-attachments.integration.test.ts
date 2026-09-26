import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { MYDESK_SQL } from "../src/db/mydeskMigration.js";
import { mydeskAttachments, mydeskNotes } from "../src/schema/mydesk.js";
import { myDeskSha256, type MyDeskObjectStore } from "../src/services/mydeskFiles.js";

const ids = { school: randomUUID(), teacher: randomUUID(), other: randomUUID() };
const actor = { schoolId: ids.school, authorId: ids.teacher, manager: false };
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let notes: typeof import("../src/services/mydesk.js");
let files: typeof import("../src/services/mydeskAttachments.js");
let cleanup: typeof import("../src/services/mydeskCleanup.js").cleanupMyDesk;
let image: Buffer;
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const objects = new Map<string, Buffer>();
let puts = 0;
const store: MyDeskObjectStore = {
  async put(key, bytes) { puts++; objects.set(key, bytes); },
  async get(key) { const bytes = objects.get(key); assert.ok(bytes); return bytes; },
  async delete(key) { objects.delete(key); },
};
const errorCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;
const newNote = async (body = "") => (await inSchool(() => notes.createMyDeskNote(actor, {
  clientRequestId: randomUUID(), targetKind: "general", category: "note", title: "", body, pinned: false,
}))).note;
const reserve = (noteId: string, clientRequestId = randomUUID()) => inSchool(() => files.reserveMyDeskAttachment(actor, noteId, {
  clientRequestId, filename: "Classwork.png", contentType: "image/png", size: image.length, sha256: myDeskSha256(image),
}));
const upload = (noteId: string, id: string, objectStore = store) => inSchool(() => files.uploadMyDeskAttachment(actor, noteId, id, image, "image/png", objectStore));

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Requires a local fixture");
  process.env.MYDESK_MODE = "on";
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  notes = await import("../src/services/mydesk.js"); files = await import("../src/services/mydeskAttachments.js");
  ({ cleanupMyDesk: cleanup } = await import("../src/services/mydeskCleanup.js"));
  await pool.query(MYDESK_SQL);
  await pool.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Private notebook fixture',$2,'active','active')", [ids.school, `${ids.school}.example.test`]);
  for (const id of [ids.teacher, ids.other]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Notebook','Teacher')", [id, `${id}@example.test`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, id]);
  }
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  image = await sharp({ create: { width: 16, height: 24, channels: 3, background: "#4488ff" } }).png().toBuffer();
});

after(async () => {
  if (!pool) return;
  await tenant({ isSuper: true }, async () => {
    for (const table of ["mydesk_attachments", "mydesk_notes", "audit_logs"]) await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${ids.school}`);
  });
  // Canonical staff lifecycle guards retain school/user roots after soft deletion.
  await pool.query("UPDATE schools SET deleted_at=now() WHERE id=$1", [ids.school]);
  await pool.query("DELETE FROM product_licenses WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), (await import("../src/db.js")).sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});

test("attachment-only save is staged, retryable and author-private; last content cannot be removed", async () => {
  const note = await newNote(); const request = randomUUID();
  const attachment = await reserve(note.id, request); assert.equal((await reserve(note.id, request)).id, attachment.id);
  const beforePuts = puts;
  const ready = await upload(note.id, attachment.id); assert.equal(ready.contentType, "image/jpeg");
  assert.equal((await upload(note.id, attachment.id)).id, ready.id); assert.equal(puts - beforePuts, 1);
  await assert.rejects(inSchool(() => files.readMyDeskAttachment(actor, note.id, attachment.id, store)), errorCode("not_found"));
  const active = await inSchool(() => notes.completeMyDeskNote(actor, note.id, note.revision, {}, [attachment.id]));
  assert.equal(active.attachments.length, 1);
  assert.equal((await inSchool(() => notes.completeMyDeskNote(actor, note.id, note.revision, {}, [attachment.id]))).revision, active.revision);
  assert.ok((await inSchool(() => files.readMyDeskAttachment(actor, note.id, attachment.id, store))).bytes.length);
  await assert.rejects(inSchool(() => files.readMyDeskAttachment({ ...actor, authorId: ids.other }, note.id, attachment.id, store)), errorCode("MYDESK_NOTE_NOT_FOUND"));
  await assert.rejects(inSchool(() => files.deleteMyDeskAttachment(actor, note.id, attachment.id, active.revision)), errorCode("MYDESK_NOTE_EMPTY"));
});

test("concurrent attachment reservations obey five-file limit and reuse request IDs", async () => {
  const note = await newNote("Work sample");
  const sameRequest = randomUUID(); const repeated = await Promise.all([reserve(note.id, sameRequest), reserve(note.id, sameRequest)]);
  assert.equal(repeated[0]!.id, repeated[1]!.id);
  const results = await Promise.allSettled(Array.from({ length: 7 }, () => reserve(note.id)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 4);
  assert.equal(results.filter(result => result.status === "rejected").length, 3);
  const rows = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.noteId, note.id)));
  assert.equal(rows.length, 5); assert.ok(rows.every(row => row.storageKey && row.status === "pending"));
});

test("partial failure can finish uploaded files while preserving failed keys for cleanup", async () => {
  const note = await newNote(); const good = await reserve(note.id); const bad = await reserve(note.id);
  await upload(note.id, good.id);
  await assert.rejects(upload(note.id, bad.id, { ...store, async put() { throw new Error("interrupted"); } }));
  const saved = await inSchool(() => notes.completeMyDeskNote(actor, note.id, note.revision, {}, [good.id]));
  assert.deepEqual(saved.attachments.map(row => row.id), [good.id]);
  const [failed] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, bad.id)));
  assert.equal(failed!.status, "delete_pending"); assert.ok(failed!.storageKey); assert.ok(failed!.uploadLeaseUntil);
});

test("an interrupted PUT can be retried on its reserved key after its lease expires", async () => {
  const note = await newNote(); const attachment = await reserve(note.id);
  await assert.rejects(upload(note.id, attachment.id, { ...store, async put(key, bytes) {
    // The object reached S3, but the process lost the acknowledgement before marking it ready.
    objects.set(key, bytes); throw new Error("lost acknowledgement");
  } }));
  const [interrupted] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  assert.equal(interrupted!.status, "pending"); assert.ok(objects.has(interrupted!.storageKey));
  await assert.rejects(upload(note.id, attachment.id), errorCode("upload_in_progress"));
  await inSchool(() => database.update(mydeskAttachments).set({ uploadLeaseUntil: new Date(Date.now() - 1000) }).where(eq(mydeskAttachments.id, attachment.id)));
  const retried = await upload(note.id, attachment.id); assert.equal(retried.id, attachment.id); assert.equal(retried.status, "ready");
  const [stored] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  assert.equal(stored!.storageKey, interrupted!.storageKey);
  assert.equal((await inSchool(() => notes.completeMyDeskNote(actor, note.id, note.revision, {}, [retried.id]))).attachments.length, 1);
});

test("delete during an upload cannot resurrect files and cleanup waits for in-flight writes", async () => {
  const note = await newNote(); const attachment = await reserve(note.id);
  let acknowledgePut!: () => void; let releasePut!: () => void;
  const started = new Promise<void>(resolve => { acknowledgePut = resolve; });
  const pause = new Promise<void>(resolve => { releasePut = resolve; });
  const deferredStore: MyDeskObjectStore = { ...store, async put(key, bytes) { acknowledgePut(); await pause; objects.set(key, bytes); } };
  const uploading = upload(note.id, attachment.id, deferredStore);
  await started;
  await inSchool(() => notes.deleteMyDeskNote(actor, note.id, note.revision));
  let deleteCalls = 0;
  const deletingStore = { ...store, async delete(key: string) { deleteCalls++; objects.delete(key); } };
  await tenant({ isSuper: true }, () => cleanup({ database, store: deletingStore }));
  assert.equal(deleteCalls, 0);
  releasePut(); await assert.rejects(uploading, errorCode("upload_cancelled"));
  const [queued] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  assert.equal(queued!.status, "delete_pending"); assert.ok(objects.has(queued!.storageKey));
  await tenant({ isSuper: true }, () => cleanup({ database, store: deletingStore, now: new Date(Date.now() + 5 * 60_000) }));
  assert.equal(objects.has(queued!.storageKey), false);
  const [deleted] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  assert.equal(deleted!.status, "deleted"); assert.equal(deleted!.originalFilename, "");
});

test("a PUT arriving after cleanup is requeued; tombstones also reconcile a crash after a late PUT", async () => {
  const note = await newNote(); const attachment = await reserve(note.id);
  let startedPut!: () => void; let releasePut!: () => void;
  const started = new Promise<void>(resolve => { startedPut = resolve; });
  const paused = new Promise<void>(resolve => { releasePut = resolve; });
  const uploading = upload(note.id, attachment.id, { ...store, async put(key, bytes) { startedPut(); await paused; objects.set(key, bytes); } });
  await started;
  await inSchool(() => notes.deleteMyDeskNote(actor, note.id, note.revision));
  const afterLease = new Date(Date.now() + 5 * 60_000);
  await tenant({ isSuper: true }, () => cleanup({ database, store, now: afterLease }));
  const [tombstone] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  assert.equal(tombstone!.status, "deleted"); assert.ok(tombstone!.nextCleanupAt);
  releasePut(); await assert.rejects(uploading, errorCode("upload_cancelled"));
  assert.ok(objects.has(tombstone!.storageKey));
  const [requeued] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  assert.equal(requeued!.status, "delete_pending");
  await tenant({ isSuper: true }, () => cleanup({ database, store, now: afterLease }));
  assert.equal(objects.has(tombstone!.storageKey), false);
  // A process that dies after PUT cannot execute requeue. The retained scheduled tombstone still catches it.
  objects.set(tombstone!.storageKey, image);
  await tenant({ isSuper: true }, () => cleanup({ database, store, now: new Date(afterLease.getTime() + 25 * 60 * 60_000) }));
  assert.equal(objects.has(tombstone!.storageKey), false);
});

test("abandoned pending saves expire; failed deletion stays queued and retries with rollout disabled", async () => {
  const note = await newNote("Private text that must be purged"); const attachment = await reserve(note.id); await upload(note.id, attachment.id);
  await inSchool(() => database.update(mydeskNotes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(mydeskNotes.id, note.id)));
  const now = new Date(Date.now() + 10 * 60_000);
  await tenant({ isSuper: true }, () => cleanup({ database, now, store: { ...store, async delete() { throw new Error("network unavailable"); } } }));
  const [queued] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  const [expired] = await inSchool(() => database.select().from(mydeskNotes).where(eq(mydeskNotes.id, note.id)));
  assert.equal(queued!.status, "delete_pending"); assert.ok(queued!.cleanupAttempts > 0); assert.ok(queued!.nextCleanupAt);
  assert.equal(expired!.status, "deleted"); assert.equal(expired!.body, "");
  process.env.MYDESK_MODE = "off";
  try { await tenant({ isSuper: true }, () => cleanup({ database, store, now: new Date(now.getTime() + 25 * 60 * 60_000) })); }
  finally { process.env.MYDESK_MODE = "on"; }
  const [removed] = await inSchool(() => database.select().from(mydeskAttachments).where(eq(mydeskAttachments.id, attachment.id)));
  assert.equal(removed!.status, "deleted"); assert.equal(objects.has(removed!.storageKey), false);
});
