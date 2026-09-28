import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import session from "express-session";
import pg from "pg";
import ExcelJS from "exceljs";
import { z } from "zod";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, sessionPool } from "../src/db.js";
import * as schema from "../src/schema/index.js";
import { STUDENT_INFORMATION_REDESIGN_SQL } from "../src/db/studentInformationRedesignMigration.js";
import { IMPORT_PROCESSING_STAGES_SQL } from "../src/db/importProcessingStagesMigration.js";
import { createStudentInformationRouter } from "../src/routes/studentInformation.js";
import { myDeskUpstreamErrorBoundary } from "../src/middleware/mydeskUpstreamErrorBoundary.js";
import { signUserToken } from "../src/services/jwt.js";
import {
  myDeskSha256,
  type MyDeskObjectStore,
} from "../src/services/mydeskFiles.js";
import {
  updateStudentContactProfile,
  getStudentContactProfile,
} from "../src/services/studentInformation.js";
import {
  createInformationImport,
  reserveInformationAsset,
  uploadInformationAsset,
  getInformationImport,
  processInformationImport,
  updateInformationItem,
  commitInformationImport,
  cancelInformationImport,
  joinInformationItems,
  addInformationItem,
} from "../src/services/studentInformationImports.js";
import {
  runStudentInformationJobs,
  cleanupStudentInformationImports,
} from "../src/services/studentInformationWorker.js";
import {
  contactProfile,
  emptyContactFields,
} from "../src/services/studentInformationValidation.js";
const fixturePool = new pg.Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
  max: 2,
});
const database = drizzle(fixturePool, { schema }),
  objects = new Map<string, Buffer>();
const store: MyDeskObjectStore = {
  async put(key, bytes) {
    objects.set(key, Buffer.from(bytes));
  },
  async get(key) {
    const bytes = objects.get(key);
    if (!bytes) throw Error("missing synthetic object");
    return bytes;
  },
  async delete(key) {
    objects.delete(key);
  },
};
let server: Server, base: string;
const schools: string[] = [];
before(async () => {
  assert.ok(
    ["127.0.0.1", "localhost"].includes(
      new URL(process.env.DATABASE_URL!).hostname,
    ),
  );
  process.env.MYDESK_MODE = "on";
  process.env.STUDENT_INFORMATION_AI_IMPORT_MODE = "on";
  await fixturePool.query(STUDENT_INFORMATION_REDESIGN_SQL);
  await fixturePool.query(IMPORT_PROCESSING_STAGES_SQL);
  if (process.env.RLS_TEST_ROLE) {
    assert.match(process.env.RLS_TEST_ROLE, /^[a-z_][a-z0-9_]+$/);
    await fixturePool.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON student_contact_profiles,student_contact_profile_versions,student_information_imports,student_information_import_items,student_information_import_assets,import_processing_stages TO "${process.env.RLS_TEST_ROLE}"`,
    );
    const roles = await pool.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(roles.rows[0], { rolsuper: false, rolbypassrls: false });
  }
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: "synthetic-information-session",
      resave: false,
      saveUninitialized: false,
    }),
  );
  app.post("/test-support-session", (req, res) => {
    req.session.userId = req.body.userId;
    req.session.authVersion = 1;
    req.session.impersonating = true;
    req.session.originalUserId = req.body.originalUserId;
    res.json({ ok: true });
  });
  app.use(
    "/api/classpilot/student-information",
    createStudentInformationRouter(store),
  );
  app.use("/api/classpilot/student-information", myDeskUpstreamErrorBoundary);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}/api/classpilot/student-information`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of schools)
    await fixturePool.query("UPDATE schools SET deleted_at=now() WHERE id=$1", [
      id,
    ]);
  await Promise.all([pool.end(), sessionPool.end(), fixturePool.end()]);
});
async function fixture() {
  const f = {
    schoolId: randomUUID(),
    teacherId: randomUUID(),
    otherId: randomUUID(),
    adminId: randomUUID(),
    studentId: randomUUID(),
    secondId: randomUUID(),
    classId: randomUUID(),
  };
  schools.push(f.schoolId);
  const client = await fixturePool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Synthetic contact school','active',true,'active','UTC')",
      [f.schoolId],
    );
    await client.query(
      "INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')",
      [f.schoolId],
    );
    for (const [id, role] of [
      [f.teacherId, "teacher"],
      [f.otherId, "teacher"],
      [f.adminId, "school_admin"],
    ]) {
      await client.query(
        "INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Staff')",
        [id, `${id}@example.invalid`],
      );
      await client.query(
        "INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')",
        [f.schoolId, id, role],
      );
    }
    await client.query(
      "INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES($1,$2,$3,'Official 5th grade','admin_class','active')",
      [f.classId, f.schoolId, f.teacherId],
    );
    await client.query(
      "INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'primary')",
      [f.classId, f.teacherId],
    );
    for (const [id, name] of [
      [f.studentId, "One"],
      [f.secondId, "Two"],
    ]) {
      await client.query(
        "INSERT INTO students(id,school_id,first_name,last_name,status,grade_level) VALUES($1,$2,'Synthetic',$3,'active','5')",
        [id, f.schoolId, name],
      );
      await client.query(
        "INSERT INTO group_students(group_id,student_id) VALUES($1,$2)",
        [f.classId, id],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    ...f,
    actor: { schoolId: f.schoolId, authorId: f.teacherId },
    admin: { schoolId: f.schoolId, authorId: f.adminId },
  };
}
const contact = () => ({
  ...emptyContactFields,
  id: randomUUID(),
  name: "Synthetic Guardian",
  relationship: "Parent",
  phones: ["00123456789"],
  emails: ["guardian@example.invalid"],
});
const status = (value: number) => (error: unknown) =>
  error instanceof Error && "status" in error && error.status === value;
async function http(
  f: Awaited<ReturnType<typeof fixture>>,
  userId: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const token = signUserToken({
    userId,
    email: `${userId}@example.invalid`,
    authVersion: 1,
  });
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-School-Id": f.schoolId,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
test("HTTP manual profiles require current official assignment, preserve no-store denials and exact revision receipts", async () => {
  const f = await fixture();
  const input = {
    requestId: randomUUID(),
    revision: 0,
    reason: "Reviewed family form",
    changes: [{ kind: "add" as const, contact: contact() }],
  };
  const saved = await http(
    f,
    f.teacherId,
    `/students/${f.studentId}`,
    "PATCH",
    input,
  );
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get("cache-control") ?? "", /no-store/);
  const result = z
    .object({ profile: z.object({ data: contactProfile }) })
    .parse(await saved.json());
  assert.equal(result.profile.data.contacts[0]!.phones[0], "00123456789");
  assert.equal(
    (await http(f, f.teacherId, `/students/${f.studentId}`, "PATCH", input))
      .status,
    200,
  );
  assert.equal(
    (await http(f, f.otherId, `/students/${f.studentId}`)).status,
    404,
  );
  assert.equal(
    (await http(f, f.adminId, `/students/${f.studentId}`)).status,
    200,
  );
  const stale = await http(
    f,
    f.teacherId,
    `/students/${f.studentId}`,
    "PATCH",
    { ...input, requestId: randomUUID() },
  );
  assert.equal(stale.status, 409);
  await fixturePool.query(
    "DELETE FROM group_students WHERE group_id=$1 AND student_id=$2",
    [f.classId, f.studentId],
  );
  const denied = await http(f, f.teacherId, `/students/${f.studentId}/history`);
  assert.equal(denied.status, 404);
  assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
  const history = await http(f, f.adminId, `/students/${f.studentId}/history`);
  assert.equal(
    z.object({ versions: z.array(z.unknown()) }).parse(await history.json())
      .versions.length,
    1,
  );
});
test("cross-school, super-only and impersonated access are denied while manual profiles survive AI configuration failure", async () => {
  const f = await fixture(),
    other = await fixture();
  const superId = randomUUID();
  await fixturePool.query(
    "INSERT INTO users(id,email,first_name,last_name,is_super_admin) VALUES($1,$2,'Synthetic','Support',true)",
    [superId, `${superId}@example.invalid`],
  );
  assert.equal(
    (await http(f, superId, `/students/${f.studentId}`)).status,
    403,
  );
  assert.equal(
    (await http(other, other.teacherId, `/students/${f.studentId}`)).status,
    404,
  );
  const login = await fetch(
    base.replace(
      "/api/classpilot/student-information",
      "/test-support-session",
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: f.teacherId, originalUserId: superId }),
    },
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const denied = await fetch(`${base}/students/${f.studentId}`, {
    headers: {
      cookie,
      "X-School-Id": f.schoolId,
      Authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.invalid`, authVersion: 1 })}`,
    },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
  const malformed = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"privatePhone":"00123",',
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("cache-control") ?? "", /no-store/);
  assert.ok(!(await malformed.text()).includes("00123"));
  process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES = "invalid";
  try {
    const capability = await http(f, f.teacherId, "/capabilities");
    assert.equal(capability.status, 200);
    assert.equal(
      z.object({ aiImportEnabled: z.boolean() }).parse(await capability.json())
        .aiImportEnabled,
      false,
    );
    assert.equal(
      (await http(f, f.teacherId, `/students/${f.studentId}`)).status,
      200,
    );
  } finally {
    delete process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES;
  }
});
async function readyRun(
  f: Awaited<ReturnType<typeof fixture>>,
  text = "Student,Phone\nSynthetic One,00123456789",
) {
  const created = await createInformationImport(f.actor, {
      clientRequestId: randomUUID(),
      expectedSourceCount: 1,
    }),
    id = created.import.id,
    bytes = Buffer.from(text);
  const reserved = await reserveInformationAsset(f.actor, id, {
    clientRequestId: randomUUID(),
    filename: "synthetic.csv",
    contentType: "text/csv",
    size: bytes.length,
    sha256: myDeskSha256(bytes),
  });
  await uploadInformationAsset(
    f.actor,
    id,
    reserved.asset.id,
    bytes,
    "text/csv",
    store,
  );
  const run = await getInformationImport(f.actor, id);
  return run;
}
async function processRun(
  f: Awaited<ReturnType<typeof fixture>>,
  run: Awaited<ReturnType<typeof readyRun>>,
  names = ["Synthetic One"],
) {
  await processInformationImport(f.actor, run.id, {
    requestId: randomUUID(),
    revision: run.revision,
    sectionIds: run.assets.filter((a) => a.kind === "section").map((a) => a.id),
    acknowledgedWarnings: true,
    confirmedProvider: true,
  });
  await runStudentInformationJobs({
    database,
    store,
    extractor: async (source) => {
      assert.ok(source.bytes.toString().includes("Synthetic"));
      return {
        profiles: names.map((studentName) => ({
          studentName,
          studentIdentifier: null,
          contacts: [
            {
              ...emptyContactFields,
              name: "Synthetic Guardian",
              phones: ["00123456789"],
            },
          ],
          warnings: [],
        })),
      };
    },
  });
  return getInformationImport(f.actor, run.id);
}
async function reviewAll(
  f: Awaited<ReturnType<typeof fixture>>,
  run: Awaited<ReturnType<typeof readyRun>>,
) {
  for (const item of run.items) {
    const reply = await updateInformationItem(f.actor, run.id, item.id, {
      requestId: randomUUID(),
      revision: run.revision,
      itemRevision: item.revision,
      studentId: item.studentId,
      baseRevision: item.baseRevision,
      changes: item.proposed.contacts.map((c) => ({ kind: "add", contact: c })),
      reviewed: true,
      excluded: false,
      resolvedWarnings: true,
    });
    run = reply.import;
  }
  return run;
}
test("contact extraction joins the shared provider ledger when the v2 worker is enabled", async () => {
  process.env.MYDESK_IMPORT_PIPELINE_VERSION = "2";
  try {
    const f = await fixture();
    const run = await processRun(f, await readyRun(f));
    assert.equal(run.status, "review");
    assert.equal(run.items.length, 1);
    const stages = await fixturePool.query<{ kind: string; status: string; attempts: number; lease_id: string | null }>(
      "SELECT kind,status,attempts,lease_id FROM import_processing_stages WHERE import_id=$1", [run.id]);
    assert.deepEqual(stages.rows, [{ kind: "student-information", status: "completed", attempts: 1, lease_id: null }]);
  } finally { delete process.env.MYDESK_IMPORT_PIPELINE_VERSION; }
});

test("selected-source import reviews typed proposals, commits atomically, replays lost responses and purges every source", async () => {
  const f = await fixture();
  let run = await processRun(
    f,
    await readyRun(f),
    "Synthetic One,Synthetic Two".split(","),
  );
  assert.equal(run.status, "review");
  assert.equal(run.items.length, 2);
  assert.deepEqual(
    (await getStudentContactProfile(f.actor, f.studentId)).profile.data
      .contacts,
    [],
  );
  await assert.rejects(
    getInformationImport({ schoolId: f.schoolId, authorId: f.otherId }, run.id),
    status(404),
  );
  run = await reviewAll(f, run);
  const input = { requestId: randomUUID(), revision: run.revision };
  const saved = await commitInformationImport(f.actor, run.id, input);
  assert.equal(saved.receipt.profiles.length, 2);
  assert.deepEqual(
    await commitInformationImport(f.actor, run.id, input),
    saved,
  );
  assert.equal(
    (await getStudentContactProfile(f.actor, f.studentId)).profile.data
      .contacts[0]!.phones[0],
    "00123456789",
  );
  const closed = await getInformationImport(f.actor, run.id);
  assert.equal(closed.items.length, 0);
  assert.equal(closed.assets.length, 0);
  const cleanup = await cleanupStudentInformationImports({ database, store });
  assert.ok(cleanup.deleted >= 2);
  await fixturePool.query(
    "DELETE FROM group_students WHERE group_id=$1 AND student_id=$2",
    [f.classId, f.studentId],
  );
  await assert.rejects(
    commitInformationImport(f.actor, run.id, input),
    status(404),
  );
  await assert.rejects(getInformationImport(f.actor, run.id), status(404));
  assert.equal(
    (await getStudentContactProfile(f.admin, f.studentId)).profile.revision,
    1,
  );
});
test("directory grade normalization and selected spreadsheet bounds cannot be bypassed by source labels", async () => {
  const f = await fixture();
  await fixturePool.query(
    "UPDATE students SET grade_level='Grade 5' WHERE id=$1",
    [f.studentId],
  );
  await fixturePool.query("UPDATE students SET grade_level=NULL WHERE id=$1", [
    f.secondId,
  ]);
  const grade = await http(f, f.teacherId, "/search", "POST", {
    gradeLevel: "5",
  });
  const searchResponse = z.object({
    students: z.array(z.object({ id: z.string() })),
  });
  assert.deepEqual(
    searchResponse.parse(await grade.json()).students.map((s) => s.id),
    [f.studentId],
  );
  const absent = await http(f, f.teacherId, "/search", "POST", {
    gradeLevel: "unrecorded",
  });
  assert.deepEqual(
    searchResponse.parse(await absent.json()).students.map((s) => s.id),
    [f.secondId],
  );
  const book = new ExcelJS.Workbook();
  for (let index = 0; index < 6; index++)
    book
      .addWorksheet(`Contacts rows ${index}`)
      .addRow(["Synthetic One", "00123"]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer()),
    contentType =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const created = await createInformationImport(f.actor, {
    clientRequestId: randomUUID(),
    expectedSourceCount: 1,
  });
  const reserved = await reserveInformationAsset(f.actor, created.import.id, {
    clientRequestId: randomUUID(),
    filename: "synthetic.xlsx",
    contentType,
    size: bytes.length,
    sha256: myDeskSha256(bytes),
  });
  await uploadInformationAsset(
    f.actor,
    created.import.id,
    reserved.asset.id,
    bytes,
    contentType,
    store,
  );
  const run = await getInformationImport(f.actor, created.import.id);
  await assert.rejects(
    processInformationImport(f.actor, run.id, {
      requestId: randomUUID(),
      revision: run.revision,
      sectionIds: run.assets
        .filter((a) => a.kind === "section")
        .map((a) => a.id),
      acknowledgedWarnings: true,
      confirmedProvider: true,
    }),
    status(422),
  );
});
test("a changed current profile prevents every batch update and preserves review drafts", async () => {
  const f = await fixture();
  let run = await reviewAll(
    f,
    await processRun(f, await readyRun(f), ["Synthetic One", "Synthetic Two"]),
  );
  await updateStudentContactProfile(f.admin, f.secondId, {
    requestId: randomUUID(),
    revision: 0,
    reason: "Administrative correction",
    changes: [{ kind: "add", contact: contact() }],
  });
  await assert.rejects(
    commitInformationImport(f.actor, run.id, {
      requestId: randomUUID(),
      revision: run.revision,
    }),
    status(409),
  );
  assert.deepEqual(
    (await getStudentContactProfile(f.actor, f.studentId)).profile.data
      .contacts,
    [],
  );
  run = await getInformationImport(f.actor, run.id);
  assert.equal(run.status, "review");
  assert.equal(run.items.length, 2);
});
test("same-student drafts require explicit combination and renewed review", async () => {
  const f = await fixture();
  let run = await processRun(f, await readyRun(f), [
    "Synthetic One",
    "Synthetic One",
  ]);
  run = await reviewAll(f, run);
  await assert.rejects(
    commitInformationImport(f.actor, run.id, {
      requestId: randomUUID(),
      revision: run.revision,
    }),
    status(400),
  );
  const [target, source] = run.items;
  run = (
    await joinInformationItems(f.actor, run.id, target!.id, {
      requestId: randomUUID(),
      revision: run.revision,
      itemRevision: target!.revision,
      sourceItemId: source!.id,
      sourceItemRevision: source!.revision,
    })
  ).import;
  assert.equal(run.items.find((i) => i.id === source!.id)!.excluded, true);
  assert.equal(run.items.find((i) => i.id === target!.id)!.reviewed, false);
  assert.equal(
    run.items.find((i) => i.id === target!.id)!.proposed.contacts.length,
    2,
  );
});
test("a missed student can be added from selected source but nothing writes before an explicit reviewed commit", async () => {
  const f = await fixture();
  let run = await processRun(f, await readyRun(f), []);
  const input = {
    requestId: randomUUID(),
    revision: run.revision,
    sourceSectionId: run.selectedSectionIds[0]!,
    studentId: f.studentId,
  };
  const added = await addInformationItem(f.actor, run.id, input);
  assert.equal(added.import.items.length, 1);
  assert.equal(
    (await addInformationItem(f.actor, run.id, input)).import.items.length,
    1,
  );
  assert.equal(
    (await getStudentContactProfile(f.actor, f.studentId)).profile.revision,
    0,
  );
  run = added.import;
  const item = run.items[0]!,
    reviewed = await updateInformationItem(f.actor, run.id, item.id, {
      requestId: randomUUID(),
      revision: run.revision,
      itemRevision: item.revision,
      studentId: f.studentId,
      baseRevision: 0,
      changes: [{ kind: "add", contact: contact() }],
      reviewed: true,
      excluded: false,
      resolvedWarnings: true,
    });
  await commitInformationImport(f.actor, run.id, {
    requestId: randomUUID(),
    revision: reviewed.import.revision,
  });
  assert.equal(
    (await getStudentContactProfile(f.actor, f.studentId)).profile.data
      .contacts[0]!.phones[0],
    "00123456789",
  );
});
test("cancel during provider wait fences late results; cleanup works with the feature disabled", async () => {
  const f = await fixture(),
    run = await readyRun(f);
  await processInformationImport(f.actor, run.id, {
    requestId: randomUUID(),
    revision: run.revision,
    sectionIds: run.assets.filter((a) => a.kind === "section").map((a) => a.id),
    acknowledgedWarnings: true,
    confirmedProvider: true,
  });
  let started!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => (started = r)),
    resume = new Promise<void>((r) => (release = r));
  const worker = runStudentInformationJobs({
    database,
    store,
    extractor: async () => {
      started();
      await resume;
      return {
        profiles: [
          {
            studentName: "Synthetic One",
            studentIdentifier: null,
            contacts: [],
            warnings: [],
          },
        ],
      };
    },
  });
  await reached;
  const current = await getInformationImport(f.actor, run.id);
  await cancelInformationImport(f.actor, run.id, {
    requestId: randomUUID(),
    revision: current.revision,
  });
  release();
  await worker;
  const afterRun = await getInformationImport(f.actor, run.id);
  assert.equal(afterRun.status, "cancelled");
  assert.equal(afterRun.items.length, 0);
  process.env.STUDENT_INFORMATION_AI_IMPORT_MODE = "off";
  try {
    assert.ok(
      (await cleanupStudentInformationImports({ database, store })).deleted >=
        2,
    );
    assert.equal(
      (await getStudentContactProfile(f.actor, f.studentId)).profile.revision,
      0,
    );
  } finally {
    process.env.STUDENT_INFORMATION_AI_IMPORT_MODE = "on";
  }
});
test("the shared daily allowance counts both information and paperwork admissions without double charging retries", async () => {
  const f = await fixture(),
    run = await readyRun(f);
  process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES = "1";
  try {
    const input = {
      requestId: randomUUID(),
      revision: run.revision,
      sectionIds: run.assets
        .filter((a) => a.kind === "section")
        .map((a) => a.id),
      acknowledgedWarnings: true,
      confirmedProvider: true,
    };
    await processInformationImport(f.actor, run.id, input);
    await processInformationImport(f.actor, run.id, input);
    const another = await readyRun(f);
    await assert.rejects(
      processInformationImport(f.actor, another.id, {
        ...input,
        requestId: randomUUID(),
        revision: another.revision,
        sectionIds: another.assets
          .filter((a) => a.kind === "section")
          .map((a) => a.id),
      }),
      status(429),
    );
  } finally {
    delete process.env.MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES;
  }
});
test("cancel while a source PUT is in flight retains deletion ownership until the persisted upload lease is safe", async () => {
  const f = await fixture(),
    created = await createInformationImport(f.actor, {
      clientRequestId: randomUUID(),
      expectedSourceCount: 1,
    }),
    id = created.import.id,
    bytes = Buffer.from("Student,Phone\nSynthetic One,00123");
  const reserved = await reserveInformationAsset(f.actor, id, {
    clientRequestId: randomUUID(),
    filename: "synthetic.csv",
    contentType: "text/csv",
    size: bytes.length,
    sha256: myDeskSha256(bytes),
  });
  let started!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => (started = r)),
    resume = new Promise<void>((r) => (release = r));
  const delayed: MyDeskObjectStore = {
    ...store,
    async put(key, value) {
      started();
      await resume;
      await store.put(key, value, "text/csv");
    },
  };
  const upload = uploadInformationAsset(
    f.actor,
    id,
    reserved.asset.id,
    bytes,
    "text/csv",
    delayed,
  );
  await reached;
  const run = await getInformationImport(f.actor, id);
  await cancelInformationImport(f.actor, id, {
    requestId: randomUUID(),
    revision: run.revision,
  });
  const before = await fixturePool.query(
    "SELECT storage_key FROM student_information_import_assets WHERE import_id=$1",
    [id],
  );
  await cleanupStudentInformationImports({ database, store });
  release();
  await assert.rejects(upload, status(409));
  assert.ok(before.rows.some((row) => objects.has(row.storage_key)));
  await cleanupStudentInformationImports({
    database,
    store,
    now: new Date(Date.now() + 7 * 60_000),
  });
  assert.ok(before.rows.every((row) => !objects.has(row.storage_key)));
});
