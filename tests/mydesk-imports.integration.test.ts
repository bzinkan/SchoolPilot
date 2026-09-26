import { after, before, test, mock } from "node:test";
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
import { MYDESK_IMPORTS_SQL } from "../src/db/mydeskImportsMigration.js";
import { MYDESK_WORKSPACE_SQL } from "../src/db/mydeskWorkspaceMigration.js";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/schema/index.js";
import sharp from "sharp";
import {
  myDeskObjectStore,
  myDeskSha256,
} from "../src/services/mydeskFiles.js";
import {
  runMyDeskImportJobs,
  type MyDeskImportProcessor,
} from "../src/services/mydeskImportWorker.js";
import { cleanupMyDeskImports } from "../src/services/mydeskImportCleanup.js";
import {
  renderImportSource,
  cropImportRegion,
  buildImportAttachment,
  MyDeskImportProcessingError,
  type ImportExtraction,
} from "../src/services/mydeskImportProcessing.js";
import { importRegion } from "../src/services/mydeskImportsValidation.js";
import myDeskRouter from "../src/routes/mydesk.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signUserToken } from "../src/services/jwt.js";

const schoolIds: string[] = [];
// Fixtures and DDL use the administrator connection; real HTTP handlers keep the restricted application pool.
const fixturePool = process.env.ADMIN_DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2 })
  : pool;
const fixtureDb = drizzle(fixturePool, { schema });
const objects = new Map<string, Buffer>();
const deletedKeys: string[] = [];
const assetSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    contentType: z.string().nullable(),
    pageCount: z.number().nullable(),
    parentAssetId: z.string().nullable(),
    pageNumber: z.number().nullable(),
  })
  .passthrough();
const itemSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  revision: z.number(),
  regions: z.array(importRegion),
  subjectNames: z.array(z.string()),
  groupId: z.string().nullable(),
  studentId: z.string().nullable(),
  rosterRevision: z.string().nullable(),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  entryDate: z.string().nullable(),
  warnings: z.array(z.string()),
  reviewed: z.boolean(),
  excluded: z.boolean(),
  extractionStatus: z.string(),
  approvedAssetId: z.string().nullable(),
  noteId: z.string().nullable(),
});
const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  revision: z.number(),
  selectedGroupIds: z.array(z.string()),
  pageDecisions: z.array(
    z.object({ assetId: z.string(), excluded: z.boolean() }),
  ),
  expiresAt: z.string(),
  uploadExpiresAt: z.string(),
  pageCount: z.number(),
  attempts: z.number(),
  lastErrorCode: z.string().nullable(),
  assets: z.array(assetSchema),
  items: z.array(itemSchema),
  commitReceipt: z
    .object({
      notes: z.array(z.object({ itemId: z.string(), noteId: z.string() })),
    })
    .nullable(),
});
const runEnvelope = z.object({ import: runSchema });
type ImportRun = z.infer<typeof runSchema>;
let photo: Buffer;

let server: Server, baseUrl: string;
before(async () => {
  process.env.MYDESK_MODE = "on";
  process.env.MYDESK_SEATING_MODE = "on";
  process.env.MYDESK_AI_IMPORT_MODE = "on";

  assert.ok(
    ["localhost", "127.0.0.1", "::1"].includes(
      new URL(process.env.DATABASE_URL || "").hostname,
    ),
  );
  if (process.env.ADMIN_DATABASE_URL)
    assert.ok(
      ["localhost", "127.0.0.1", "::1"].includes(
        new URL(process.env.ADMIN_DATABASE_URL).hostname,
      ),
    );
  await fixturePool.query(MYDESK_SQL);
  await fixturePool.query(MYDESK_SEATING_SQL);
  await fixturePool.query(MYDESK_IMPORTS_SQL);
  await fixturePool.query(MYDESK_WORKSPACE_SQL);
  photo = await sharp({
    create: { width: 800, height: 1000, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer();
  mock.method(myDeskObjectStore, "put", async (key: string, bytes: Buffer) => {
    objects.set(key, Buffer.from(bytes));
  });
  mock.method(myDeskObjectStore, "get", async (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) throw new Error("fixture object missing");
    return Buffer.from(bytes);
  });
  mock.method(myDeskObjectStore, "delete", async (key: string) => {
    deletedKeys.push(key);
    objects.delete(key);
  });
  if (process.env.RLS_GUC_ENABLED === "true") {
    assert.match(
      process.env.RLS_TEST_ROLE || "",
      /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/,
    );
    await fixturePool.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON mydesk_imports,mydesk_import_items,mydesk_import_assets,mydesk_preferences TO "${process.env.RLS_TEST_ROLE}"`,
    );
    const role = await pool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(role.rows[0], {
      current_user: process.env.RLS_TEST_ROLE,
      rolsuper: false,
      rolbypassrls: false,
    });
    const policies = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owns_table: boolean;
    }>(
      "SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname IN ('mydesk_imports','mydesk_import_items','mydesk_import_assets') ORDER BY relname",
    );
    assert.equal(policies.rows.length, 3);
    assert.ok(
      policies.rows.every(
        (row) =>
          row.relrowsecurity && row.relforcerowsecurity && !row.owns_table,
      ),
    );
  }
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: "mydesk-local-fixture-session-secret",
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.post("/fixture/impersonate", (req, res) => {
    const input = z
      .object({ targetId: z.string(), originalId: z.string() })
      .parse(req.body);
    req.session.userId = input.targetId;
    req.session.originalUserId = input.originalId;
    req.session.impersonating = true;
    req.session.authVersion = 1;
    res.json({ ok: true });
  });
  app.use(
    "/api/mydesk",
    (req, res, next) => {
      // Drop the TCP response only after the real handler has committed its mutation.
      if (req.headers["x-fixture-drop-response"] === "1")
        res.json = () => {
          res.destroy();
          return res;
        };
      next();
    },
    myDeskRouter,
  );
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.is_super='on'");
    // Canonical lifecycle guards retain school/user roots even in the CI schema.
    await client.query(
      "UPDATE schools SET deleted_at=now() WHERE id=ANY($1::text[])",
      [schoolIds],
    );
    for (const table of [
      "mydesk_import_items",
      "mydesk_import_assets",
      "mydesk_imports",
      "mydesk_preferences",
      "mydesk_seating_charts",
      "mydesk_attachments",
      "mydesk_notes",
      "audit_logs",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE school_id=ANY($1::text[])`,
        [schoolIds],
      );
    for (const table of ["group_students", "group_teachers"])
      await client.query(
        `DELETE FROM ${table} WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))`,
        [schoolIds],
      );
    for (const table of [
      "groups",
      "students",
      "settings",
      "school_memberships",
      "product_licenses",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE school_id=ANY($1::text[])`,
        [schoolIds],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    mock.restoreAll();
    client.release();
    await Promise.all([
      pool.end(),
      sessionPool.end(),
      ...(fixturePool !== pool ? [fixturePool.end()] : []),
    ]);
  }
});
async function fixtureTransaction(
  operation: (client: pg.PoolClient) => Promise<void>,
) {
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function fixture() {
  const f = {
    schoolId: randomUUID(),
    teacherId: randomUUID(),
    colleagueId: randomUUID(),
    adminId: randomUUID(),
    officeId: randomUUID(),
    superId: randomUUID(),
    outsideSuperId: randomUUID(),
    groupId: randomUUID(),
    studentId: randomUUID(),
  };
  schoolIds.push(f.schoolId);
  await fixtureTransaction(async (client) => {
    await client.query(
      "INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'My Desk fixture','active',true,'active','UTC')",
      [f.schoolId],
    );
    await client.query(
      "INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')",
      [f.schoolId],
    );
    for (const [id, role] of [
      [f.teacherId, "teacher"],
      [f.colleagueId, "teacher"],
      [f.adminId, "school_admin"],
      [f.officeId, "office_staff"],
      [f.superId, "teacher"],
      [f.outsideSuperId, null],
    ]) {
      await client.query(
        "INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Notebook','Author',$3)",
        [id, `${id}@example.test`, id === f.superId || id === f.outsideSuperId],
      );
      if (role)
        await client.query(
          "INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')",
          [f.schoolId, id, role],
        );
    }
    await client.query(
      "INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Science','teacher_created','active')",
      [f.groupId, f.schoolId, f.teacherId],
    );
    await client.query(
      "INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($1,$3,'co-teacher')",
      [f.groupId, f.teacherId, f.colleagueId],
    );
    await client.query(
      "INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'co-teacher')",
      [f.groupId, f.superId],
    );
    await client.query(
      "INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'First','Student','active')",
      [f.studentId, f.schoolId],
    );
    await client.query(
      "INSERT INTO group_students(group_id,student_id) VALUES($1,$2)",
      [f.groupId, f.studentId],
    );
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(
  f: Fixture,
  path: string,
  method = "GET",
  body?: unknown,
  authorId = f.teacherId,
  cookie?: string,
) {
  const headers: Record<string, string> = {
    "x-school-id": f.schoolId,
    "content-type": "application/json",
    authorization: `Bearer ${signUserToken({ userId: authorId, email: `${authorId}@example.test`, authVersion: 1 })}`,
  };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(baseUrl + "/api/mydesk" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data: unknown = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? JSON.parse(text)
    : text;
  return { status: response.status, data, text, headers: response.headers };
}

async function getRun(f: Fixture, id: string) {
  const r = await request(f, `/imports/${id}`);
  assert.equal(r.status, 200, r.text);
  return runEnvelope.parse(r.data).import;
}
async function createRun(
  f: Fixture,
  selectedGroupIds = [f.groupId],
  expectedSourceCount = 1,
) {
  const r = await request(f, "/imports", "POST", {
    clientRequestId: randomUUID(),
    selectedGroupIds,
    expectedSourceCount,
  });
  assert.equal(r.status, 201, r.text);
  return runEnvelope.parse(r.data).import;
}
async function uploadSource(f: Fixture, run: ImportRun) {
  const input = {
    clientRequestId: randomUUID(),
    filename: "private-packet.jpg",
    contentType: "image/jpeg",
    size: photo.length,
    sha256: myDeskSha256(photo),
  };
  const reservation = await request(
    f,
    `/imports/${run.id}/assets`,
    "POST",
    input,
  );
  assert.equal(reservation.status, 201, reservation.text);
  const asset = z.object({ asset: assetSchema }).parse(reservation.data).asset;
  const response = await fetch(
    `${baseUrl}/api/mydesk/imports/${run.id}/assets/${asset.id}/content`,
    {
      method: "PUT",
      headers: {
        "x-school-id": f.schoolId,
        "content-type": "image/jpeg",
        authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.test`, authVersion: 1 })}`,
      },
      body: Uint8Array.from(photo),
    },
  );
  assert.equal(response.status, 200, await response.text());
  return { run: await getRun(f, run.id), asset, input };
}
const extraction = (name = "First Student"): ImportExtraction => ({
  subjectNames: [name],
  entryDate: "2026-09-20",
  category: "detention",
  title: "Form record",
  body: "The form reports a classroom incident. Detention was assigned.",
  warnings: [],
});
function processor(
  overrides: Partial<MyDeskImportProcessor> = {},
): MyDeskImportProcessor {
  return {
    renderImportSource,
    detectImportForms: async () => [{ x: 0, y: 0, width: 1, height: 1 }],
    extractImportForm: async () => extraction(),
    cropImportRegion,
    buildImportAttachment,
    ...overrides,
  };
}
async function start(f: Fixture, run: ImportRun) {
  const r = await request(f, `/imports/${run.id}/process`, "POST", {
    requestId: randomUUID(),
    revision: run.revision,
  });
  assert.equal(r.status, 200, r.text);
  return runEnvelope.parse(r.data).import;
}
async function work(p = processor()) {
  return runMyDeskImportJobs({ database: fixtureDb, processor: p });
}
async function readyRun(
  f: Fixture,
  p = processor(),
  selectedGroupIds = [f.groupId],
) {
  let run = await createRun(f, selectedGroupIds);
  ({ run } = await uploadSource(f, run));
  run = await start(f, run);
  await work(p);
  run = await getRun(f, run.id);
  assert.equal(run.status, "review", JSON.stringify(run));
  return run;
}
async function changeItem(
  f: Fixture,
  run: ImportRun,
  itemId: string,
  patch: Record<string, unknown>,
) {
  const item = run.items.find((i) => i.id === itemId)!;
  const r = await request(f, `/imports/${run.id}/items/${itemId}`, "PATCH", {
    requestId: randomUUID(),
    revision: run.revision,
    itemRevision: item.revision,
    ...patch,
  });
  assert.equal(r.status, 200, r.text);
  return runEnvelope.parse(r.data).import;
}
async function approve(
  f: Fixture,
  run: ImportRun,
  itemId: string,
  groupId = f.groupId,
  studentId = f.studentId,
) {
  const roster = z
    .object({ rosterRevision: z.string() })
    .parse((await request(f, `/classes/${groupId}/students`)).data);
  return changeItem(f, run, itemId, {
    groupId,
    studentId,
    rosterRevision: roster.rosterRevision,
    entryDate: "2026-09-20",
    reviewed: true,
  });
}
async function accountPages(f: Fixture, run: ImportRun) {
  const r = await request(f, `/imports/${run.id}`, "PATCH", {
    requestId: randomUUID(),
    revision: run.revision,
    pageDecisions: run.assets
      .filter((a) => a.kind === "page")
      .map((a) => ({
        assetId: a.id,
        excluded: !run.items.some(
          (i) => !i.excluded && i.regions.some((r) => r.assetId === a.id),
        ),
      })),
  });
  assert.equal(r.status, 200, r.text);
  return runEnvelope.parse(r.data).import;
}

async function savedSource(f: Fixture, bytes = photo, contentType = "image/jpeg") {
  const id = randomUUID(), attachmentId = randomUUID(), storageKey = `mydesk/${f.schoolId}/${f.teacherId}/${id}/${attachmentId}`;
  const sha256 = myDeskSha256(bytes);
  await fixtureDb.insert(schema.mydeskNotes).values({ id, schoolId: f.schoolId, authorId: f.teacherId,
    clientRequestId: randomUUID(), requestFingerprint: sha256, status: "active", targetKind: "general", entryDate: "2026-09-26" });
  await fixtureDb.insert(schema.mydeskAttachments).values({ id: attachmentId, schoolId: f.schoolId, authorId: f.teacherId,
    noteId: id, clientRequestId: randomUUID(), requestFingerprint: sha256, storageKey, originalFilename: "private-packet",
    status: "ready", committedAt: new Date(), contentType, byteSize: bytes.length, inputSha256: sha256, sha256 });
  objects.set(storageKey, bytes);
  return { noteId: id, attachmentId, storageKey };
}

test("saved-attachment extraction owns an independent retry-safe copy and never grants another author access", async () => {
  const f = await fixture(), source = await savedSource(f);
  const input = { clientRequestId: randomUUID(), noteId: source.noteId, attachmentId: source.attachmentId, selectedGroupIds: [f.groupId] };
  for (const identity of [f.colleagueId, f.adminId, f.superId]) {
    const denied = await request(f, "/imports/from-attachment", "POST", input, identity);
    assert.equal(denied.status, 404, denied.text);
  }
  const copied = await request(f, "/imports/from-attachment", "POST", input);
  assert.equal(copied.status, 201, copied.text);
  const run = runEnvelope.parse(copied.data).import;
  assert.equal(run.assets.length, 1); assert.equal(run.assets[0]!.status, "ready");
  const keys = await fixturePool.query<{storage_key: string}>("SELECT storage_key FROM mydesk_import_assets WHERE import_id=$1", [run.id]);
  const copyKey = keys.rows[0]!.storage_key;
  assert.notEqual(copyKey, source.storageKey); assert.ok(objects.has(copyKey)); assert.ok(objects.has(source.storageKey));
  await fixturePool.query("UPDATE mydesk_notes SET status='deleted' WHERE id=$1", [source.noteId]);
  await fixturePool.query("UPDATE mydesk_attachments SET status='delete_pending' WHERE id=$1", [source.attachmentId]);
  objects.delete(source.storageKey);
  const replay = await request(f, "/imports/from-attachment", "POST", input);
  assert.equal(replay.status, 200, replay.text); assert.equal(runEnvelope.parse(replay.data).import.id, run.id);
  assert.equal((await request(f, `/imports/${run.id}/assets/${run.assets[0]!.id}/content`)).status, 200);
  const cancel = await request(f, `/imports/${run.id}`, "DELETE", { requestId: randomUUID(), revision: run.revision });
  assert.equal(cancel.status, 200, cancel.text);
  await cleanupMyDeskImports({ database: fixtureDb, limit: 200 });
  assert.ok(!objects.has(copyKey));
  const tombstone = await fixturePool.query("SELECT source_note_id,source_attachment_id,preferences_snapshot FROM mydesk_imports WHERE id=$1", [run.id]);
  assert.deepEqual(tombstone.rows[0], { source_note_id: null, source_attachment_id: null, preferences_snapshot: { revision: 0, preferredClasses: {} } });
  assert.equal((await request(f, "/imports/from-attachment", "POST", input)).status, 200, "terminal request remains replayable");
});

test("saved-source deletion during copy cannot promote bytes and leaves durable terminal cleanup", async () => {
  const f = await fixture(), source = await savedSource(f);
  const input = { clientRequestId: randomUUID(), noteId: source.noteId, attachmentId: source.attachmentId, selectedGroupIds: [f.groupId] };
  const put = mock.method(myDeskObjectStore, "put", async (key: string, bytes: Buffer) => {
    objects.set(key, bytes);
    await fixturePool.query("UPDATE mydesk_notes SET status='deleted' WHERE id=$1", [source.noteId]);
  });
  try {
    const result = await request(f, "/imports/from-attachment", "POST", input);
    assert.equal(result.status, 404, result.text);
    const receipt = await request(f, "/imports/from-attachment", "POST", input);
    assert.equal(receipt.status, 200, receipt.text);
    const run = runEnvelope.parse(receipt.data).import;
    assert.equal(run.status, "cancelled"); assert.equal(run.assets.length, 0);
    const pending = await fixturePool.query<{storage_key:string,status:string}>("SELECT storage_key,status FROM mydesk_import_assets WHERE import_id=$1", [run.id]);
    assert.equal(pending.rows[0]!.status, "delete_pending");
    await cleanupMyDeskImports({ database: fixtureDb, now: new Date(Date.now() + 7 * 60_000), limit: 200 });
    assert.ok(!objects.has(pending.rows[0]!.storage_key));
    assert.ok(objects.has(source.storageKey), "import cleanup must never delete source evidence");
  } finally { put.mock.restore(); }
});

test("invalid saved sources close recoverably and do not require recopying to cancel", async () => {
  const f = await fixture(), source = await savedSource(f, Buffer.from("unreadable packet"), "application/pdf");
  const input = { clientRequestId: randomUUID(), noteId: source.noteId, attachmentId: source.attachmentId, selectedGroupIds: [f.groupId] };
  const bad = await request(f, "/imports/from-attachment", "POST", input);
  assert.equal(bad.status, 422, bad.text);
  const replay = await request(f, "/imports/from-attachment", "POST", input);
  assert.equal(replay.status, 200, replay.text); assert.equal(runEnvelope.parse(replay.data).import.status, "cancelled");
  assert.ok(objects.has(source.storageKey));
});

test("an interrupted source read can resume or cancel after the original is removed", async () => {
  const f = await fixture(), source = await savedSource(f);
  const input = {clientRequestId:randomUUID(),noteId:source.noteId,attachmentId:source.attachmentId,selectedGroupIds:[f.groupId]};
  const get = mock.method(myDeskObjectStore,"get",async () => {throw new Error("storage temporarily unavailable");});
  try { assert.equal((await request(f,"/imports/from-attachment","POST",input)).status,503); }
  finally {get.mock.restore();}
  await fixturePool.query("UPDATE mydesk_notes SET status='deleted' WHERE id=$1",[source.noteId]);
  const replay=await request(f,"/imports/from-attachment","POST",input);
  assert.equal(replay.status,200,replay.text); assert.equal(runEnvelope.parse(replay.data).import.status,"cancelled");
  assert.ok(objects.has(source.storageKey));
});

test("unexpired legacy imports keep their original prompt version while resuming worker stages", async () => {
  const f=await fixture(); let run=await createRun(f);
  ({run}=await uploadSource(f,run)); await start(f,run);
  await fixturePool.query("UPDATE mydesk_imports SET prompt_version='mydesk-forms-20260925-v1' WHERE id=$1",[run.id]);
  await work(); run=await getRun(f,run.id); assert.equal(run.status,"review");
  const item=run.items[0]!;
  run=await changeItem(f,run,item.id,{regions:[{...item.regions[0]!,rotation:180}]});
  await work(processor({extractImportForm:async()=>{throw new Error("geometry edits must not reread teacher fields");}}));
  run=await getRun(f,run.id); assert.equal(run.status,"review"); assert.equal(run.items[0]!.regions[0]!.rotation,180);
  const stored=await fixturePool.query("SELECT prompt_version FROM mydesk_imports WHERE id=$1",[run.id]);
  assert.equal(stored.rows[0].prompt_version,"mydesk-forms-20260925-v1");
});

test("matching deduplicates stable students and uses the frozen grade filing preference only among selected classes", async () => {
  const f = await fixture(), second = randomUUID();
  await fixturePool.query("UPDATE groups SET grade_level='6' WHERE id=$1", [f.groupId]);
  await fixtureTransaction(async (client) => {
    await client.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status,grade_level) VALUES($1,$2,$3,'Math','teacher_created','active','6')", [second, f.schoolId, f.teacherId]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')", [second, f.teacherId]);
    await client.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [second, f.studentId]);
  });
  assert.equal((await request(f, "/preferences", "PATCH", {revision: 0, preferredClasses: {"6":f.groupId}})).status, 200);
  let run = await createRun(f, [f.groupId, second]);
  assert.equal((await request(f, "/preferences", "PATCH", {revision: 1, preferredClasses: {"6":second}})).status, 200);
  ({run} = await uploadSource(f, run)); await start(f, run);
  await work(processor({detectImportForms: async () => [{x:0,y:0,width:1,height:1,rotation:180}]}));
  run = await getRun(f, run.id);
  assert.equal(run.items[0]!.studentId, f.studentId); assert.equal(run.items[0]!.groupId, f.groupId);
  assert.equal(run.items[0]!.regions[0]!.rotation, 180); assert.equal(run.items[0]!.reviewed, false);
  const duplicate = randomUUID();
  await fixturePool.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'First','Student','active')", [duplicate,f.schoolId]);
  await fixturePool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [second,duplicate]);
  const ambiguous = await readyRun(f, processor(), [f.groupId, second]);
  assert.equal(ambiguous.items[0]!.studentId, null); assert.equal(ambiguous.items[0]!.groupId, null);
});

test("imports enforce HTTP owner, tenant, verified membership, impersonation and feature boundaries", async () => {
  const f = await fixture(),
    other = await fixture();
  let run = await createRun(f);
  const uploaded = await uploadSource(f, run);
  run = uploaded.run;
  for (const author of [f.colleagueId, f.adminId, f.superId]) {
    for (const [path, method, body] of [
      [`/imports/${run.id}`, "GET", undefined],
      [
        `/imports/${run.id}`,
        "PATCH",
        {
          requestId: randomUUID(),
          revision: run.revision,
          selectedGroupIds: [f.groupId],
        },
      ],
      [
        `/imports/${run.id}/assets/${uploaded.asset.id}/content`,
        "GET",
        undefined,
      ],
      [
        `/imports/${run.id}/assets`,
        "POST",
        { ...uploaded.input, clientRequestId: randomUUID() },
      ],
      [
        `/imports/${run.id}/process`,
        "POST",
        { requestId: randomUUID(), revision: run.revision },
      ],
      [
        `/imports/${run.id}`,
        "DELETE",
        { requestId: randomUUID(), revision: run.revision },
      ],
    ] as const) {
      const r = await request(f, path, method, body, author);
      assert.equal(r.status, 404, r.text);
      assert.equal(r.headers.get("cache-control"), "private, no-store");
    }
    assert.deepEqual(
      z
        .object({ imports: z.array(z.unknown()) })
        .parse((await request(f, "/imports", "GET", undefined, author)).data)
        .imports,
      [],
    );
  }
  assert.equal((await request(other, `/imports/${run.id}`)).status, 404);
  assert.equal(
    (await request(f, "/imports", "GET", undefined, f.officeId)).status,
    403,
  );
  assert.equal(
    (await request(f, "/imports", "GET", undefined, f.outsideSuperId)).status,
    403,
  );
  const login = await fetch(baseUrl + "/fixture/impersonate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      targetId: f.teacherId,
      originalId: f.outsideSuperId,
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.equal(
    (
      await request(
        f,
        `/imports/${run.id}`,
        "GET",
        undefined,
        f.teacherId,
        cookie,
      )
    ).status,
    403,
  );
  process.env.MYDESK_AI_IMPORT_MODE = "off";
  assert.equal(
    z
      .object({ aiImportEnabled: z.boolean() })
      .parse((await request(f, "/capabilities")).data).aiImportEnabled,
    false,
  );
  assert.equal((await request(f, `/imports/${run.id}`)).status, 404);
  process.env.MYDESK_AI_IMPORT_MODE = "on";
  assert.equal(
    (
      await request(f, "/imports", "POST", {
        clientRequestId: randomUUID(),
        selectedGroupIds: [other.groupId],
        expectedSourceCount: 1,
      })
    ).status,
    409,
  );
  assert.ok(!JSON.stringify(run).includes("storageKey"));
  if (process.env.RLS_GUC_ENABLED === "true")
    assert.equal(
      (
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM mydesk_imports WHERE school_id=$1",
          [f.schoolId],
        )
      ).rows[0]!.count,
      0,
    );
});

test("source uploads preserve immutable reservations, count pages and start seven-day review on completion", async () => {
  const f = await fixture();
  let run = await createRun(f);
  const uploaded = await uploadSource(f, run);
  run = uploaded.run;
  assert.equal(run.pageCount, 1);
  assert.ok(Date.parse(run.expiresAt) > Date.now() + 6 * 24 * 3600_000);
  const retry = await request(
    f,
    `/imports/${run.id}/assets`,
    "POST",
    uploaded.input,
  );
  assert.equal(retry.status, 201);
  assert.equal(
    z.object({ asset: assetSchema }).parse(retry.data).asset.id,
    uploaded.asset.id,
  );
  const mismatch = await fetch(
    `${baseUrl}/api/mydesk/imports/${run.id}/assets/${uploaded.asset.id}/content`,
    {
      method: "PUT",
      headers: {
        "x-school-id": f.schoolId,
        "content-type": "application/pdf",
        authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.test`, authVersion: 1 })}`,
      },
      body: Uint8Array.from(photo),
    },
  );
  assert.equal(mismatch.status, 409);
  assert.equal(
    (
      await request(f, `/imports/${run.id}/assets`, "POST", {
        ...uploaded.input,
        clientRequestId: randomUUID(),
      })
    ).status,
    409,
  );
  run = await createRun(f, [f.groupId], 5);
  ({ run } = await uploadSource(f, run));
  assert.ok(Date.parse(run.expiresAt) < Date.now() + 25 * 3600_000);
  for (let n = 1; n < 5; n++)
    assert.equal(
      (
        await request(f, `/imports/${run.id}/assets`, "POST", {
          ...uploaded.input,
          clientRequestId: randomUUID(),
        })
      ).status,
      201,
    );
  assert.equal(
    (
      await request(f, `/imports/${run.id}/assets`, "POST", {
        ...uploaded.input,
        clientRequestId: randomUUID(),
      })
    ).status,
    409,
  );
  run = await getRun(f, run.id);
  assert.ok(Date.parse(run.uploadExpiresAt) < Date.now() + 25 * 3600_000);
  assert.equal(
    (
      await request(f, `/imports/${run.id}/process`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
      })
    ).status,
    409,
  );
});

test("review binds the crop, exact roster and explicit date; all forms/pages save atomically and replay after lost response", async () => {
  const f = await fixture();
  let run = await readyRun(
    f,
    processor({
      detectImportForms: async () => [
        { x: 0, y: 0, width: 1, height: 0.5 },
        { x: 0, y: 0.5, width: 1, height: 0.5 },
      ],
    }),
  );
  assert.equal(run.items.length, 2);
  assert.equal(run.items[0]!.studentId, f.studentId);
  assert.equal(run.items[0]!.reviewed, false);
  let bad = await request(f, `/imports/${run.id}/commit`, "POST", {
    requestId: randomUUID(),
    revision: run.revision,
    itemIds: run.items.map((i) => i.id),
  });
  assert.equal(bad.status, 409);
  run = await changeItem(f, run, run.items[0]!.id, { entryDate: null });
  bad = await request(
    f,
    `/imports/${run.id}/items/${run.items[0]!.id}`,
    "PATCH",
    {
      requestId: randomUUID(),
      revision: run.revision,
      itemRevision: run.items[0]!.revision,
      reviewed: true,
    },
  );
  assert.equal(bad.status, 409);
  for (const item of run.items) run = await approve(f, run, item.id);
  assert.equal(
    (
      await request(f, `/imports/${run.id}/commit`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
        itemIds: run.items.map((i) => i.id),
      })
    ).status,
    409,
  );
  run = await accountPages(f, run);
  assert.equal(
    (
      await request(f, `/imports/${run.id}/commit`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
        itemIds: [run.items[0]!.id],
      })
    ).status,
    409,
  );
  const body = {
    requestId: randomUUID(),
    revision: run.revision,
    itemIds: run.items.map((i) => i.id),
  };
  await assert.rejects(
    fetch(`${baseUrl}/api/mydesk/imports/${run.id}/commit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-school-id": f.schoolId,
        "x-fixture-drop-response": "1",
        authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.test`, authVersion: 1 })}`,
      },
      body: JSON.stringify(body),
    }),
  );
  const saved = await request(f, `/imports/${run.id}/commit`, "POST", body);
  assert.equal(saved.status, 200, saved.text);
  run = runEnvelope.parse(saved.data).import;
  assert.equal(run.status, "completed");
  assert.equal(run.items.length, 0);
  assert.equal(run.assets.length, 0);
  assert.equal(run.commitReceipt!.notes.length, 2);
  const receipt = run.commitReceipt!;
  const notes = await fixturePool.query<{
    id: string;
    status: string;
    body: string;
  }>("SELECT id,status,body FROM mydesk_notes WHERE school_id=$1", [
    f.schoolId,
  ]);
  assert.equal(notes.rows.length, 2);
  assert.ok(notes.rows.every((n) => n.status === "active"));
  const retained = await fixturePool.query<{ storage_key: string }>(
    "SELECT storage_key FROM mydesk_attachments WHERE school_id=$1",
    [f.schoolId],
  );
  assert.equal(retained.rows.length, 2);
  await cleanupMyDeskImports({
    database: fixtureDb,
    now: new Date(Date.now() + 10 * 60_000),
  });
  assert.ok(retained.rows.every((a) => objects.has(a.storage_key)));
  assert.ok(retained.rows.every((a) => !deletedKeys.includes(a.storage_key)));
  const drafts = await fixturePool.query<{
    body: string;
    category: string;
    subject_names: unknown[];
  }>(
    "SELECT body,category,subject_names FROM mydesk_import_items WHERE import_id=$1",
    [run.id],
  );
  assert.ok(
    drafts.rows.every(
      (i) =>
        i.body === "" && i.category === "note" && i.subject_names.length === 0,
    ),
  );
  const noteId = receipt.notes[0]!.noteId;
  const note = z
    .object({ note: z.object({ revision: z.number() }) })
    .parse((await request(f, `/notes/${noteId}`)).data).note;
  assert.equal(
    (
      await request(f, `/notes/${noteId}`, "DELETE", {
        revision: note.revision,
      })
    ).status,
    200,
  );
  const replay = await request(f, `/imports/${run.id}/commit`, "POST", body);
  assert.equal(replay.status, 200);
  assert.deepEqual(
    runEnvelope.parse(replay.data).import.commitReceipt,
    receipt,
  );
  assert.equal((await request(f, `/notes/${noteId}`)).status, 404);
  const audit = await fixturePool.query<{
    metadata: unknown;
    changes: unknown;
    entity_name: string | null;
  }>(
    "SELECT metadata,changes,entity_name FROM audit_logs WHERE school_id=$1 AND action LIKE 'mydesk.import.%'",
    [f.schoolId],
  );
  assert.ok(!JSON.stringify(audit.rows).includes("classroom incident"));
  assert.ok(audit.rows.every((row) => !row.entity_name && !row.changes));
});

test("crop edits and joining forms preserve teacher text, invalidate review, and promote an image-only continuation PDF", async () => {
  const f = await fixture();
  let calls = 0;
  const p = processor({
    detectImportForms: async () => [
      { x: 0, y: 0, width: 1, height: 0.5 },
      { x: 0, y: 0.5, width: 1, height: 0.5 },
    ],
    extractImportForm: async () => {
      calls++;
      return extraction();
    },
  });
  let run = await readyRun(f, p);
  assert.equal(calls, 2);
  run = await changeItem(f, run, run.items[0]!.id, {
    body: "Teacher's corrected factual summary",
  });
  run = await approve(f, run, run.items[0]!.id);
  run = await accountPages(f, run);
  const [target, source] = run.items;
  const joined = await request(
    f,
    `/imports/${run.id}/items/${target!.id}/join`,
    "POST",
    {
      requestId: randomUUID(),
      revision: run.revision,
      itemRevision: target!.revision,
      sourceItemId: source!.id,
      sourceItemRevision: source!.revision,
    },
  );
  assert.equal(joined.status, 200, joined.text);
  run = runEnvelope.parse(joined.data).import;
  assert.equal(run.status, "queued");
  assert.deepEqual(run.pageDecisions, []);
  await work(p);
  run = await getRun(f, run.id);
  assert.equal(calls, 2);
  assert.equal(run.items[0]!.body, "Teacher's corrected factual summary");
  assert.equal(run.items[0]!.reviewed, false);
  assert.equal(run.items[1]!.excluded, true);
  assert.equal(
    run.assets.find((a) => a.id === run.items[0]!.approvedAssetId)!.contentType,
    "application/pdf",
  );
  run = await approve(f, run, target!.id);
  run = await accountPages(f, run);
  assert.equal(
    (
      await request(f, `/imports/${run.id}/commit`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
        itemIds: [target!.id],
      })
    ).status,
    200,
  );
  const attachments = await fixturePool.query<{ content_type: string }>(
    "SELECT content_type FROM mydesk_attachments WHERE school_id=$1",
    [f.schoolId],
  );
  assert.deepEqual(attachments.rows, [{ content_type: "application/pdf" }]);
});

test("matching remains unresolved for duplicate names and revoked/moved roster prevents partial commit", async () => {
  const f = await fixture(),
    groupId = randomUUID(),
    studentId = randomUUID();
  await fixtureTransaction(async (client) => {
    await client.query(
      "INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Sixth grade','teacher_small_group','active')",
      [groupId, f.schoolId, f.colleagueId],
    );
    await client.query(
      "INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary'),($1,$3,'co-teacher')",
      [groupId, f.colleagueId, f.teacherId],
    );
    await client.query(
      "INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'First','Student','active')",
      [studentId, f.schoolId],
    );
    await client.query(
      "INSERT INTO group_students(group_id,student_id) VALUES($1,$2)",
      [groupId, studentId],
    );
  });
  let run = await readyRun(
    f,
    processor({
      detectImportForms: async () => [
        { x: 0, y: 0, width: 1, height: 0.5 },
        { x: 0, y: 0.5, width: 1, height: 0.5 },
      ],
    }),
    [f.groupId, groupId],
  );
  assert.ok(run.items.every((i) => i.studentId === null && i.groupId === null));
  run = await approve(f, run, run.items[0]!.id);
  run = await approve(f, run, run.items[1]!.id, groupId, studentId);
  run = await accountPages(f, run);
  await fixturePool.query(
    "DELETE FROM group_students WHERE group_id=$1 AND student_id=$2",
    [groupId, studentId],
  );
  const result = await request(f, `/imports/${run.id}/commit`, "POST", {
    requestId: randomUUID(),
    revision: run.revision,
    itemIds: run.items.map((i) => i.id),
  });
  assert.equal(result.status, 409, result.text);
  assert.equal(
    (
      await fixturePool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM mydesk_notes WHERE school_id=$1",
        [f.schoolId],
      )
    ).rows[0]!.count,
    0,
  );
});

test("daily quotas charge explicit rereads once, retain history through cancellation, and reject excess work", async () => {
  const f = await fixture();
  process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES = "2";
  try {
    let run = await readyRun(f);
    const item = run.items[0]!;
    const input = {
      requestId: randomUUID(),
      revision: run.revision,
      itemRevision: item.revision,
    };
    const first = await request(
      f,
      `/imports/${run.id}/items/${item.id}/reread`,
      "POST",
      input,
    );
    assert.equal(first.status, 200, first.text);
    assert.equal(
      (
        await request(
          f,
          `/imports/${run.id}/items/${item.id}/reread`,
          "POST",
          input,
        )
      ).status,
      200,
    );
    await work();
    run = await getRun(f, run.id);
    assert.equal(
      (
        await request(f, `/imports/${run.id}/items/${item.id}/reread`, "POST", {
          requestId: randomUUID(),
          revision: run.revision,
          itemRevision: run.items[0]!.revision,
        })
      ).status,
      429,
    );
    assert.equal(
      (
        await request(f, `/imports/${run.id}`, "DELETE", {
          requestId: randomUUID(),
          revision: run.revision,
        })
      ).status,
      200,
    );
    const ledger = await fixturePool.query<{
      quota_usage: Array<{ date: string; pages: number }>;
    }>("SELECT quota_usage FROM mydesk_imports WHERE id=$1", [run.id]);
    assert.equal(ledger.rows[0]!.quota_usage[0]!.pages, 2);
    let another = await createRun(f);
    ({ run: another } = await uploadSource(f, another));
    assert.equal(
      (
        await request(f, `/imports/${another.id}/process`, "POST", {
          requestId: randomUUID(),
          revision: another.revision,
        })
      ).status,
      429,
    );
  } finally {
    delete process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES;
  }
});

test("durable stage retries avoid repeated detection/extraction and stop after three failed attempts", async () => {
  const f = await fixture();
  let renderCalls = 0,
    detectCalls = 0,
    extractCalls = 0,
    buildCalls = 0;
  const p = processor({
    renderImportSource: async (...args) => {
      renderCalls++;
      return renderImportSource(...args);
    },
    detectImportForms: async () => {
      detectCalls++;
      return [{ x: 0, y: 0, width: 1, height: 1 }];
    },
    extractImportForm: async () => {
      extractCalls++;
      return extraction();
    },
    buildImportAttachment: async (pages) => {
      buildCalls++;
      if (buildCalls === 1)
        throw new MyDeskImportProcessingError(
          "MYDESK_IMPORT_AI_FAILED",
          "fixed error",
          true,
          503,
        );
      return buildImportAttachment(pages);
    },
  });
  let run = await createRun(f);
  ({ run } = await uploadSource(f, run));
  run = await start(f, run);
  await work(p);
  run = await getRun(f, run.id);
  assert.equal(run.status, "queued");
  await fixturePool.query(
    "UPDATE mydesk_imports SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  await work(p);
  run = await getRun(f, run.id);
  assert.equal(run.status, "review");
  assert.deepEqual(
    [renderCalls, detectCalls, extractCalls, buildCalls],
    [1, 1, 1, 2],
  );
  let failures = 0;
  const broken = processor({
    extractImportForm: async () => {
      failures++;
      throw new MyDeskImportProcessingError(
        "MYDESK_IMPORT_AI_TIMEOUT",
        "fixed timeout",
        true,
        503,
      );
    },
  });
  const form = run.items[0]!;
  assert.equal(
    (
      await request(f, `/imports/${run.id}/items/${form.id}/reread`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
        itemRevision: form.revision,
      })
    ).status,
    200,
  );
  for (let n = 0; n < 3; n++) {
    await fixturePool.query(
      "UPDATE mydesk_imports SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [run.id],
    );
    await work(broken);
  }
  run = await getRun(f, run.id);
  assert.equal(run.status, "failed");
  assert.equal(failures, 3);
  assert.equal(run.attempts, 3);
  assert.equal(
    (
      await request(f, `/imports/${run.id}/process`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
      })
    ).status,
    409,
  );
});

test("cancellation during provider work prevents later stages and cleanup removes every unpromoted object", async () => {
  const f = await fixture();
  let run = await createRun(f);
  ({ run } = await uploadSource(f, run));
  run = await start(f, run);
  let signalStarted!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  let extractions = 0;
  const working = work(
    processor({
      detectImportForms: async () => {
        signalStarted();
        await blocked;
        return [{ x: 0, y: 0, width: 1, height: 1 }];
      },
      extractImportForm: async () => {
        extractions++;
        return extraction();
      },
    }),
  );
  await started;
  run = await getRun(f, run.id);
  assert.equal(
    (
      await request(f, `/imports/${run.id}`, "DELETE", {
        requestId: randomUUID(),
        revision: run.revision,
      })
    ).status,
    200,
  );
  release();
  await working;
  assert.equal(extractions, 0);
  run = await getRun(f, run.id);
  assert.equal(run.status, "cancelled");
  assert.equal(run.items.length, 0);
  assert.equal(run.assets.length, 0);
  await cleanupMyDeskImports({
    database: fixtureDb,
    now: new Date(Date.now() + 10 * 60_000),
  });
  assert.ok(![...objects.keys()].some((key) => key.includes(run.id)));
});

test("entitlement revoked during provider work prevents publishing results or later AI calls", async () => {
  const f = await fixture();
  let run = await createRun(f);
  ({ run } = await uploadSource(f, run));
  run = await start(f, run);
  let extractions = 0;
  await work(processor({
    detectImportForms: async () => {
      await fixturePool.query("UPDATE product_licenses SET status='suspended' WHERE school_id=$1 AND product='CLASSPILOT'", [f.schoolId]);
      return [{ x: 0, y: 0, width: 1, height: 1 }];
    },
    extractImportForm: async () => { extractions++; return extraction(); },
  }));
  assert.equal(extractions, 0);
  assert.equal((await request(f, `/imports/${run.id}`)).status, 403);
  const stored = await fixturePool.query<{ status: string; count: number }>(
    "SELECT status,(SELECT count(*)::int FROM mydesk_import_items WHERE import_id=$1) AS count FROM mydesk_imports WHERE id=$1", [run.id]);
  assert.deepEqual(stored.rows[0], { status: "failed", count: 0 });
});

test("global processing claims allow two jobs across runners and source expiry hides content before cleanup", async () => {
  const f = await fixture();
  const queued: ImportRun[] = [];
  for (let n = 0; n < 3; n++) {
    let run = await createRun(f);
    ({ run } = await uploadSource(f, run));
    queued.push(await start(f, run));
  }
  let started = 0,
    signal!: () => void,
    release!: () => void;
  const entered = new Promise<void>((resolve) => {
      signal = resolve;
    }),
    block = new Promise<void>((resolve) => {
      release = resolve;
    });
  const p = processor({
    detectImportForms: async () => {
      started++;
      if (started === 2) signal();
      await block;
      return [{ x: 0, y: 0, width: 1, height: 1 }];
    },
  });
  const first = work(p);
  await entered;
  assert.deepEqual(await work(p), []);
  assert.equal(started, 2);
  release();
  await first;
  await work();
  assert.ok(
    (await Promise.all(queued.map((r) => getRun(f, r.id)))).every(
      (r) => r.status === "review",
    ),
  );
  const run = queued[0]!;
  await fixturePool.query(
    "UPDATE mydesk_imports SET expires_at=now()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  const expired = await getRun(f, run.id);
  assert.equal(expired.status, "expired");
  assert.deepEqual(expired.assets, []);
  assert.deepEqual(expired.items, []);
  const stored = await fixturePool.query<{ body: string }>(
    "SELECT body FROM mydesk_import_items WHERE import_id=$1",
    [run.id],
  );
  assert.ok(stored.rows.some((i) => i.body.length > 0));
  await cleanupMyDeskImports({ database: fixtureDb });
  assert.ok(
    (
      await fixturePool.query<{ body: string }>(
        "SELECT body FROM mydesk_import_items WHERE import_id=$1",
        [run.id],
      )
    ).rows.every((i) => i.body === ""),
  );
});

test("import list cursor preserves timestamp precision and is bound to its author", async () => {
  const f = await fixture();
  await fixturePool.query(
    "INSERT INTO mydesk_imports(school_id,author_id,client_request_id,request_fingerprint,expected_source_count,expires_at,upload_expires_at) SELECT $1,$2,gen_random_uuid(),repeat('a',64),1,now()+interval '1 day',now()+interval '1 day' FROM generate_series(1,35)",
    [f.schoolId, f.teacherId],
  );
  const parse = (data: unknown) =>
    z
      .object({
        imports: z.array(z.object({ id: z.string() })),
        nextCursor: z.string().nullable(),
      })
      .parse(data);
  let result = parse((await request(f, "/imports?limit=10")).data);
  const firstCursor = result.nextCursor!;
  const ids = result.imports.map((i) => i.id);
  while (result.nextCursor) {
    result = parse(
      (
        await request(
          f,
          `/imports?limit=10&cursor=${encodeURIComponent(result.nextCursor)}`,
        )
      ).data,
    );
    ids.push(...result.imports.map((i) => i.id));
  }
  assert.equal(ids.length, 35);
  assert.equal(new Set(ids).size, 35);
  assert.equal(
    (
      await request(
        f,
        `/imports?cursor=${encodeURIComponent(firstCursor)}`,
        "GET",
        undefined,
        f.colleagueId,
      )
    ).status,
    400,
  );
});

test("a newly entitled school can create notes and process imports without runtime configuration changes", async () => {
  const configuration = [process.env.MYDESK_MODE, process.env.MYDESK_SEATING_MODE, process.env.MYDESK_AI_IMPORT_MODE];
  const f = await fixture();
  assert.deepEqual([process.env.MYDESK_MODE, process.env.MYDESK_SEATING_MODE, process.env.MYDESK_AI_IMPORT_MODE], configuration);
  const capabilities = z.object({ enabled: z.boolean(), seatingEnabled: z.boolean(), aiImportEnabled: z.boolean() })
    .parse((await request(f, "/capabilities")).data);
  assert.deepEqual(capabilities, { enabled: true, seatingEnabled: true, aiImportEnabled: true });
  const note = await request(f, "/notes", "POST", { clientRequestId: randomUUID(), body: "Private new-school note" });
  assert.equal(note.status, 201, note.text);
  const noteId = z.object({ note: z.object({ id: z.string() }) }).parse(note.data).note.id;
  assert.equal((await request(f, `/notes/${noteId}`, "GET", undefined, f.adminId)).status, 404);
  let run = await createRun(f);
  ({ run } = await uploadSource(f, run));
  run = await start(f, run);
  await work();
  assert.equal((await getRun(f, run.id)).status, "review");
  await fixturePool.query("UPDATE product_licenses SET expires_at=now()-interval '1 minute' WHERE school_id=$1 AND product='CLASSPILOT'", [f.schoolId]);
  assert.equal((await request(f, `/notes/${noteId}`)).status, 403);
  assert.equal((await request(f, `/imports/${run.id}`)).status, 403);
});

test("ineligible school and membership backlogs cannot starve new schools; fresh deletions precede tombstones", async () => {
  const disabled = await fixture(),
    enabled = await fixture();
  await fixturePool.query(
    "INSERT INTO mydesk_imports(school_id,author_id,client_request_id,request_fingerprint,expected_source_count,status,expires_at,upload_expires_at,created_at) SELECT $1,$2,gen_random_uuid(),repeat('a',64),1,'queued',now()+interval '1 day',now()+interval '1 day',now()-interval '1 hour' FROM generate_series(1,60)",
    [disabled.schoolId, disabled.teacherId],
  );
  await fixturePool.query("UPDATE product_licenses SET status='expired' WHERE school_id=$1 AND product='CLASSPILOT'", [disabled.schoolId]);
  // Also exceed the discovery page with nonqualifying staff at an entitled school.
  await fixturePool.query(
    "INSERT INTO mydesk_imports(school_id,author_id,client_request_id,request_fingerprint,expected_source_count,status,expires_at,upload_expires_at,created_at) SELECT $1,$2,gen_random_uuid(),repeat('a',64),1,'queued',now()+interval '1 day',now()+interval '1 day',now()-interval '1 hour' FROM generate_series(1,60)",
    [enabled.schoolId, enabled.officeId],
  );
  await fixtureTransaction(async client => {
    await client.query("DELETE FROM group_teachers WHERE group_id=$1 AND teacher_id=$2", [enabled.groupId, enabled.colleagueId]);
    await client.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [enabled.schoolId, enabled.colleagueId]);
    await client.query(
      "INSERT INTO mydesk_imports(school_id,author_id,client_request_id,request_fingerprint,expected_source_count,status,expires_at,upload_expires_at,created_at) SELECT $1,$2,gen_random_uuid(),repeat('a',64),1,'queued',now()+interval '1 day',now()+interval '1 day',now()-interval '1 hour' FROM generate_series(1,60)",
      [enabled.schoolId, enabled.colleagueId],
    );
  });
  let run = await createRun(enabled);
  ({ run } = await uploadSource(enabled, run));
  run = await start(enabled, run);
  await work();
  assert.equal((await getRun(enabled, run.id)).status, "review");
  assert.equal(
    (
      await fixturePool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM mydesk_imports WHERE school_id=$1 AND status='queued'",
        [disabled.schoolId],
      )
    ).rows[0]!.count,
    60,
  );
  await fixturePool.query(
    "UPDATE mydesk_imports SET status='cancelled' WHERE school_id=$1",
    [disabled.schoolId],
  );
  await fixturePool.query("UPDATE mydesk_imports SET status='cancelled' WHERE author_id=ANY($1::text[])", [[enabled.officeId, enabled.colleagueId]]);
  await cleanupMyDeskImports({
    database: fixtureDb,
    limit: 200,
    now: new Date(Date.now() + 10 * 60_000),
  });
  // Use the same clock for fixture eligibility and cleanup. PostgreSQL now()
  // retains microseconds that a same-millisecond JavaScript Date truncates.
  const cleanupNow = new Date(),
    freshId = randomUUID(),
    key = `mydesk/${enabled.schoolId}/${enabled.teacherId}/imports/${run.id}/${freshId}`;
  await fixturePool.query(
    "INSERT INTO mydesk_import_assets(id,school_id,author_id,import_id,kind,client_request_id,request_fingerprint,storage_key,status,next_cleanup_at) SELECT gen_random_uuid(),$1,$2,$3,'source',gen_random_uuid(),repeat('a',64),'mydesk/old-'||gen_random_uuid(),'deleted',$4::timestamptz-interval '2 days' FROM generate_series(1,60)",
    [enabled.schoolId, enabled.teacherId, run.id, cleanupNow],
  );
  await fixturePool.query(
    "INSERT INTO mydesk_import_assets(id,school_id,author_id,import_id,kind,client_request_id,request_fingerprint,storage_key,status,next_cleanup_at) VALUES($1,$2,$3,$4,'source',gen_random_uuid(),repeat('a',64),$5,'delete_pending',$6)",
    [freshId, enabled.schoolId, enabled.teacherId, run.id, key, cleanupNow],
  );
  objects.set(key, Buffer.from("synthetic"));
  const deletionCountBefore = deletedKeys.length;
  const cleanup = await cleanupMyDeskImports({
    database: fixtureDb,
    limit: 1,
    now: cleanupNow,
  });
  assert.equal(cleanup.deleted, 1);
  assert.equal(objects.has(key), false);
  assert.deepEqual(deletedKeys.slice(deletionCountBefore), [key]);
});

test("manual recovery after failed detection and failed extraction preserves teacher text without another AI call", async () => {
  const f = await fixture();
  let run = await createRun(f);
  ({ run } = await uploadSource(f, run));
  run = await start(f, run);
  let detections = 0,
    extractions = 0;
  const unavailable = processor({
    detectImportForms: async () => {
      detections++;
      throw new MyDeskImportProcessingError(
        "MYDESK_IMPORT_AI_FAILED",
        "fixed",
        false,
        422,
      );
    },
    extractImportForm: async () => {
      extractions++;
      throw new MyDeskImportProcessingError(
        "MYDESK_IMPORT_AI_FAILED",
        "fixed",
        false,
        422,
      );
    },
  });
  await work(unavailable);
  run = await getRun(f, run.id);
  assert.equal(run.status, "failed");
  const page = run.assets.find((a) => a.kind === "page")!;
  const created = await request(f, `/imports/${run.id}/items`, "POST", {
    requestId: randomUUID(),
    revision: run.revision,
    regions: [
      { assetId: page.id, x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    ],
  });
  assert.equal(created.status, 200, created.text);
  await work(unavailable);
  run = await getRun(f, run.id);
  assert.equal(run.status, "failed");
  assert.equal(detections, 1);
  assert.equal(extractions, 1);
  run = await changeItem(f, run, run.items[0]!.id, {
    body: "Teacher transcribed the visible form.",
    entryDate: "2026-09-20",
  });
  await work(unavailable);
  run = await getRun(f, run.id);
  assert.equal(run.status, "review");
  assert.equal(run.items[0]!.body, "Teacher transcribed the visible form.");
  assert.equal(detections, 1);
  assert.equal(extractions, 1);
  run = await approve(f, run, run.items[0]!.id);
  run = await accountPages(f, run);
  assert.equal(
    (
      await request(f, `/imports/${run.id}/commit`, "POST", {
        requestId: randomUUID(),
        revision: run.revision,
        itemIds: [run.items[0]!.id],
      })
    ).status,
    200,
  );
});

test("capabilities publish the same configured import limits enforced by quota admission", async () => {
  const f = await fixture();
  const originalTeacher = process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES;
  const originalSchool = process.env.MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES;
  const originalGate = process.env.MYDESK_AI_IMPORT_MODE;
  try {
    delete process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES;
    delete process.env.MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES;
    const capabilitySchema = z.object({
      importProvider: z.literal("Anthropic"),
      importLimits: z
        .object({
          maxSources: z.number(),
          maxSourceBytes: z.number(),
          maxPages: z.number(),
          maxForms: z.number(),
          teacherDailyPages: z.number(),
          schoolDailyPages: z.number(),
          uploadExpiryHours: z.number(),
          reviewExpiryDays: z.number(),
        })
        .strict(),
    });
    const defaults = await request(f, "/capabilities");
    assert.equal(defaults.status, 200, defaults.text);
    assert.deepEqual(capabilitySchema.parse(defaults.data), {
      importProvider: "Anthropic",
      importLimits: {
        maxSources: 5,
        maxSourceBytes: 10 * 1024 * 1024,
        maxPages: 20,
        maxForms: 50,
        teacherDailyPages: 100,
        schoolDailyPages: 500,
        uploadExpiryHours: 24,
        reviewExpiryDays: 7,
      },
    });
    process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES = "1";
    process.env.MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES = "3";
    const configured = capabilitySchema.parse(
      (await request(f, "/capabilities")).data,
    );
    assert.equal(configured.importLimits.teacherDailyPages, 1);
    assert.equal(configured.importLimits.schoolDailyPages, 3);
    let first = await createRun(f);
    ({ run: first } = await uploadSource(f, first));
    await start(f, first);
    let second = await createRun(f);
    ({ run: second } = await uploadSource(f, second));
    assert.equal(
      (
        await request(f, `/imports/${second.id}/process`, "POST", {
          requestId: randomUUID(),
          revision: second.revision,
        })
      ).status,
      429,
    );
    process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES = "0";
    const invalid = await request(f, "/capabilities");
    assert.equal(invalid.status, 200, invalid.text);
    const unavailableSchema = z.object({
      enabled: z.literal(true),
      seatingEnabled: z.literal(true),
      aiImportEnabled: z.literal(false),
      importLimits: z.null(),
      importUnavailableCode: z.literal("MYDESK_IMPORT_CONFIGURATION"),
      schoolDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    unavailableSchema.parse(invalid.data);
    assert.equal(
      (
        await request(f, `/imports/${second.id}/process`, "POST", {
          requestId: randomUUID(),
          revision: second.revision,
        })
      ).status,
      503,
    );
    process.env.MYDESK_AI_IMPORT_MODE = "off";
    const disabled = await request(f, "/capabilities");
    assert.equal(disabled.status, 200, disabled.text);
    unavailableSchema.parse(disabled.data);
    const created = await request(f, "/notes", "POST", {
      clientRequestId: randomUUID(),
      targetKind: "general",
      title: "Ordinary notebook",
      body: "Synthetic note",
    });
    assert.equal(created.status, 201, created.text);
    const note = z
      .object({ note: z.object({ id: z.string(), revision: z.number() }) })
      .parse(created.data).note;
    const completed = await request(f, `/notes/${note.id}/complete`, "POST", {
      revision: note.revision,
      attachmentIds: [],
    });
    assert.equal(completed.status, 200, completed.text);
    const read = await request(f, `/notes/${note.id}`);
    assert.equal(read.status, 200, read.text);
    assert.equal(
      z.object({ note: z.object({ body: z.string() }) }).parse(read.data).note
        .body,
      "Synthetic note",
    );
  } finally {
    if (originalTeacher === undefined)
      delete process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES;
    else process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES = originalTeacher;
    if (originalSchool === undefined)
      delete process.env.MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES;
    else process.env.MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES = originalSchool;
    if (originalGate === undefined)
      delete process.env.MYDESK_AI_IMPORT_MODE;
    else process.env.MYDESK_AI_IMPORT_MODE = originalGate;
  }
});
