import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";

// School Library (shared and official Flight Paths / Block Lists) over HTTP.
// The library is school-scoped behind CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE;
// with it off every response keeps its previous shape. Sharing is the owner's
// decision, official marking is administrator-only (and only on shared or
// self-owned items), official items are administrator-managed, and privileged
// changes are audited in the same transaction as the change.

const TAG = `cp_library_routes_${Date.now()}`;
const DOMAIN = `${TAG}.example.edu`;
const FOREIGN_DOMAIN = `${TAG}-b.example.edu`;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_LIBRARY_MODE = process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE;
const ORIGINAL_LIBRARY_SCHOOLS = process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS;
process.env.REDIS_URL = "";
delete process.env.SENDGRID_API_KEY;
process.env.NODE_ENV = "test";

const LEGACY_FLIGHT_PATH_KEYS = [
  "id", "schoolId", "teacherId", "flightPathName", "description", "allowedDomains", "blockedDomains", "isDefault",
  "sourceType", "sourceCourseId", "sourceResourceIds", "sourceUpdatedAt", "createdAt",
];
const LEGACY_BLOCK_LIST_KEYS = ["id", "schoolId", "teacherId", "name", "description", "blockedDomains", "isDefault", "createdAt"];
const PROVENANCE_KEYS = ["sourceType", "sourceCourseId", "sourceResourceIds", "sourceUpdatedAt", "teacherId", "publishedBy", "schoolId"];

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let lifecycle: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;

let school: any;
let foreignSchool: any;
let admin: any;
let schoolAdmin: any;
let office: any;
let teacherA: any;
let teacherB: any;
let foreignTeacher: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function setLibrary(mode: "on" | "off" | undefined, schoolIds?: string): void {
  if (mode === undefined) delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE;
  else process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = mode;
  if (schoolIds === undefined) delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS;
  else process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = schoolIds;
}

async function requestJson(
  method: string,
  path: string,
  user: any,
  body?: unknown,
  schoolId: string = school.id
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${signUserToken({ userId: user.id, email: user.email, isSuperAdmin: false })}`,
      "x-school-id": schoolId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

async function createPath(owner: any, name: string, extra: Record<string, unknown> = {}, schoolId: string = school.id): Promise<any> {
  return inSchool(schoolId, () => storage.createFlightPath({
    schoolId,
    teacherId: owner === null ? null : owner.id,
    flightPathName: `${TAG} ${name}`,
    allowedDomains: ["science.example.edu"],
    blockedDomains: [],
    ...extra,
  }));
}

async function createList(owner: any, name: string, extra: Record<string, unknown> = {}, schoolId: string = school.id): Promise<any> {
  return inSchool(schoolId, () => storage.createBlockList({
    schoolId,
    teacherId: owner.id,
    name: `${TAG} ${name}`,
    blockedDomains: ["games.example.com"],
    ...extra,
  }));
}

async function storedPath(id: string): Promise<any> {
  return inSchool(school.id, () => storage.getFlightPathById(id, school.id));
}

async function storedList(id: string): Promise<any> {
  return inSchool(school.id, () => storage.getBlockListById(id, school.id));
}

async function auditActions(entityId: string): Promise<Array<{ action: string; userId: string | null; changes: any; metadata: any }>> {
  const result: any = await asSystem(() => db.execute(sql`
    SELECT action, user_id, changes, metadata
    FROM audit_logs
    WHERE school_id = ${school.id} AND entity_id = ${entityId}
    ORDER BY created_at, id
  `));
  return result.rows.map((row: any) => ({
    action: row.action,
    userId: row.user_id,
    changes: row.changes,
    metadata: row.metadata,
  }));
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

async function cleanupSchool(schoolId: string): Promise<void> {
  await asSystem(() => db.transaction(async (tx: any) => {
    await tx.execute(sql`DELETE FROM audit_logs WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM flight_paths WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM block_lists WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM product_licenses WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM school_memberships WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM settings WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM schools WHERE id = ${schoolId}`);
  }));
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  lifecycle = await import("../dist/services/staffAssignmentLifecycle.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  school = await storage.createSchool({ name: `${TAG} School`, domain: DOMAIN, slug: `${TAG}-school`, schoolTimezone: "America/New_York" });
  foreignSchool = await storage.createSchool({ name: `${TAG} Foreign`, domain: FOREIGN_DOMAIN, slug: `${TAG}-foreign`, schoolTimezone: "America/New_York" });
  [admin, schoolAdmin, office, teacherA, teacherB, foreignTeacher] = await Promise.all([
    storage.createUser({ email: `admin@${DOMAIN}`, firstName: "Alex", lastName: "Admin" }),
    storage.createUser({ email: `school-admin@${DOMAIN}`, firstName: "Sam", lastName: "SchoolAdmin" }),
    storage.createUser({ email: `office@${DOMAIN}`, firstName: "Oakley", lastName: "Office" }),
    storage.createUser({ email: `teacher-a@${DOMAIN}`, firstName: "Avery", lastName: "Teacher" }),
    storage.createUser({ email: `teacher-b@${DOMAIN}`, firstName: "Blake", lastName: "Teacher" }),
    storage.createUser({ email: `teacher-f@${FOREIGN_DOMAIN}`, firstName: "Finley", lastName: "Foreign" }),
  ]);
  for (const [user, role, schoolId] of [
    [admin, "admin", school.id],
    [schoolAdmin, "school_admin", school.id],
    [office, "office_staff", school.id],
    [teacherA, "teacher", school.id],
    [teacherB, "teacher", school.id],
    [foreignTeacher, "teacher", foreignSchool.id],
  ] as const) {
    await storage.createMembership({ userId: user.id, schoolId, role, status: "active" });
  }
  for (const target of [school, foreignSchool]) {
    await storage.createProductLicense({ schoolId: target.id, product: "CLASSPILOT", status: "active" });
    await storage.upsertSettings(target.id, { schoolName: target.name, wsSharedKey: "" });
  }

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(() => setLibrary(undefined));

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const target of [school, foreignSchool]) {
      if (target?.id) await cleanupSchool(target.id);
    }
    await asSystem(() => db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${DOMAIN}`} OR email LIKE ${`%@${FOREIGN_DOMAIN}`}`));
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    if (ORIGINAL_SENDGRID_API_KEY === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = ORIGINAL_SENDGRID_API_KEY;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_LIBRARY_MODE === undefined) delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE;
    else process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = ORIGINAL_LIBRARY_MODE;
    if (ORIGINAL_LIBRARY_SCHOOLS === undefined) delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS;
    else process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS = ORIGINAL_LIBRARY_SCHOOLS;
  }
});

describe("ClassPilot School Library routes", { concurrency: false }, () => {
  it("keeps today's exact Flight Path and Block List payloads while the library is off", async () => {
    const ownPath = await createPath(teacherA, "Off own path", {
      sourceType: "google_classroom", sourceCourseId: "course-off", sourceResourceIds: ["r-1"], sourceUpdatedAt: new Date(),
    });
    const sharedByOther = await createPath(teacherB, "Off shared path", { visibility: "school", official: true });
    const ownList = await createList(teacherA, "Off own list");

    for (const [mode, schoolIds] of [[undefined, undefined], ["off", undefined], ["on", foreignSchool.id], ["on", "not a valid,list"]] as const) {
      setLibrary(mode, schoolIds);
      const paths = await requestJson("GET", "/flight-paths", teacherA);
      assert.equal(paths.status, 200, paths.text);
      assert.deepEqual(Object.keys(paths.body), ["flightPaths"], `${mode}/${schoolIds}`);
      assert.deepEqual(ids(paths.body.flightPaths), [ownPath.id]);
      assert.deepEqual(Object.keys(paths.body.flightPaths[0]), LEGACY_FLIGHT_PATH_KEYS);
      assert.equal(paths.body.flightPaths[0].sourceCourseId, "course-off");
      assert.doesNotMatch(paths.text, /"(?:visibility|official|publishedAt|publishedBy|library|features|canEdit|canShare|canMarkOfficial)"/);

      const lists = await requestJson("GET", "/block-lists", teacherA);
      assert.equal(lists.status, 200, lists.text);
      assert.deepEqual(Object.keys(lists.body), ["blockLists"]);
      assert.deepEqual(ids(lists.body.blockLists), [ownList.id]);
      assert.deepEqual(Object.keys(lists.body.blockLists[0]), LEGACY_BLOCK_LIST_KEYS);
    }

    setLibrary("off");
    const created = await requestJson("POST", "/flight-paths", teacherA, { flightPathName: `${TAG} Off created`, allowedDomains: ["a.example.edu"] });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(Object.keys(created.body), ["flightPath"]);
    assert.deepEqual(Object.keys(created.body.flightPath), LEGACY_FLIGHT_PATH_KEYS);
    const detail = await requestJson("GET", `/flight-paths/${ownPath.id}`, teacherA);
    assert.deepEqual(Object.keys(detail.body.flightPath), LEGACY_FLIGHT_PATH_KEYS);
    const patched = await requestJson("PATCH", `/flight-paths/${ownPath.id}`, teacherA, { description: "Updated" });
    assert.equal(patched.status, 200, patched.text);
    assert.deepEqual(Object.keys(patched.body.flightPath), LEGACY_FLIGHT_PATH_KEYS);
    const listCreated = await requestJson("POST", "/block-lists", teacherA, { name: `${TAG} Off created list`, blockedDomains: ["x.example.com"] });
    assert.deepEqual(Object.keys(listCreated.body.blockList), LEGACY_BLOCK_LIST_KEYS);

    // A published item stays invisible to other teachers while the library is off.
    assert.equal((await requestJson("GET", `/flight-paths/${sharedByOther.id}`, teacherA)).status, 404);
    for (const [path, body] of [
      [`/flight-paths/${ownPath.id}/visibility`, { visibility: "school" }],
      [`/flight-paths/${sharedByOther.id}/copy`, {}],
      [`/block-lists/${ownList.id}/visibility`, { visibility: "school" }],
      [`/block-lists/${ownList.id}/copy`, {}],
    ] as const) {
      const refused = await requestJson("POST", path, teacherA, body);
      assert.equal(refused.status, 409, `${path}: ${refused.text}`);
      assert.equal(refused.body.code, "SHARED_TEACHING_RESOURCES_DISABLED");
    }
    const official = await requestJson("POST", `/flight-paths/${sharedByOther.id}/official`, admin, { official: false });
    assert.equal(official.status, 409);
    assert.equal((await storedPath(ownPath.id)).visibility, "private");
  });

  it("lists same-school shared and official items in the School Library and never private or foreign ones", async () => {
    setLibrary("on");
    const privateA = await createPath(teacherA, "Library private A");
    const sharedA = await createPath(teacherA, "Library shared A", {
      visibility: "school",
      sourceType: "google_classroom",
      sourceCourseId: "course-private-id",
      sourceResourceIds: ["resource-private-id"],
      sourceUpdatedAt: new Date(),
    });
    const officialAdmin = await createPath(admin, "Library official admin", { official: true });
    const foreignShared = await createPath(foreignTeacher, "Library foreign shared", { visibility: "school" }, foreignSchool.id);
    const sharedListA = await createList(teacherA, "Library shared list A", { visibility: "school" });
    const privateListA = await createList(teacherA, "Library private list A");

    const forB = await requestJson("GET", "/flight-paths", teacherB);
    assert.equal(forB.status, 200, forB.text);
    assert.deepEqual(Object.keys(forB.body), ["flightPaths", "library", "features"]);
    assert.deepEqual(forB.body.features, { sharedTeachingResources: true });
    const libraryIds = forB.body.library.map((row: any) => row.id);
    assert.ok(libraryIds.includes(sharedA.id));
    assert.ok(libraryIds.includes(officialAdmin.id), "official items are visible even when private");
    assert.equal(libraryIds.includes(privateA.id), false);
    assert.equal(libraryIds.includes(foreignShared.id), false);
    const sharedView = forB.body.library.find((row: any) => row.id === sharedA.id);
    for (const key of PROVENANCE_KEYS) assert.equal(key in sharedView, false, `library view must not expose ${key}`);
    assert.equal(sharedView.ownerName, "Avery Teacher");
    assert.equal(sharedView.visibility, "school");
    assert.equal(sharedView.canEdit, false);
    assert.doesNotMatch(forB.text, /course-private-id|resource-private-id/);
    assert.deepEqual(forB.body.library.find((row: any) => row.id === officialAdmin.id).official, true);

    const forA = await requestJson("GET", "/flight-paths", teacherA);
    const ownIds = forA.body.flightPaths.map((row: any) => row.id);
    assert.ok(ownIds.includes(privateA.id) && ownIds.includes(sharedA.id));
    assert.equal(forA.body.library.some((row: any) => row.id === sharedA.id), false, "own items are not repeated in the library");
    const ownShared = forA.body.flightPaths.find((row: any) => row.id === sharedA.id);
    assert.equal(ownShared.sourceCourseId, "course-private-id", "the owner still sees their own provenance");
    assert.equal("publishedBy" in ownShared, false);
    assert.equal(ownShared.canShare, true);

    const foreign = await requestJson("GET", "/flight-paths", foreignTeacher, undefined, foreignSchool.id);
    assert.equal(foreign.status, 200, foreign.text);
    assert.equal(foreign.body.library.some((row: any) => row.id === sharedA.id || row.id === officialAdmin.id), false);
    assert.deepEqual(ids(foreign.body.flightPaths), [foreignShared.id]);

    const listsForB = await requestJson("GET", "/block-lists", teacherB);
    assert.deepEqual(Object.keys(listsForB.body), ["blockLists", "library", "features"]);
    const listIds = listsForB.body.library.map((row: any) => row.id);
    assert.ok(listIds.includes(sharedListA.id));
    assert.equal(listIds.includes(privateListA.id), false);
    const listView = listsForB.body.library.find((row: any) => row.id === sharedListA.id);
    for (const key of ["teacherId", "publishedBy", "schoolId"]) assert.equal(key in listView, false);
    assert.equal(listView.ownerName, "Avery Teacher");
  });

  it("serves library viewers the library projection on GET by id and keeps private items hidden", async () => {
    setLibrary("on");
    const privateA = await createPath(teacherA, "Detail private A");
    const sharedA = await createPath(teacherA, "Detail shared A", { visibility: "school", sourceCourseId: "course-detail" });
    const officialAdmin = await createPath(admin, "Detail official admin", { official: true });
    const sharedList = await createList(teacherA, "Detail shared list", { visibility: "school" });
    const privateList = await createList(teacherA, "Detail private list");

    const shared = await requestJson("GET", `/flight-paths/${sharedA.id}`, teacherB);
    assert.equal(shared.status, 200, shared.text);
    for (const key of PROVENANCE_KEYS) assert.equal(key in shared.body.flightPath, false);
    assert.equal(shared.body.flightPath.ownerName, "Avery Teacher");
    assert.equal((await requestJson("GET", `/flight-paths/${officialAdmin.id}`, teacherB)).status, 200);
    assert.equal((await requestJson("GET", `/flight-paths/${privateA.id}`, teacherB)).status, 404);
    assert.equal((await requestJson("GET", `/block-lists/${sharedList.id}`, teacherB)).status, 200);
    assert.equal((await requestJson("GET", `/block-lists/${privateList.id}`, teacherB)).status, 404);
    assert.equal((await requestJson("GET", `/flight-paths/${sharedA.id}`, foreignTeacher, undefined, foreignSchool.id)).status, 404);

    // Owners and administrators keep the full stored view.
    const adminView = await requestJson("GET", `/flight-paths/${sharedA.id}`, admin);
    assert.equal(adminView.body.flightPath.sourceCourseId, "course-detail");

    // A former member's name is never shown.
    const former = await storage.createUser({ email: `former@${DOMAIN}`, firstName: "Former", lastName: "Teacher" });
    const formerMembership = await storage.createMembership({ userId: former.id, schoolId: school.id, role: "teacher", status: "active" });
    const formerShared = await createPath(former, "Detail former shared", { visibility: "school" });
    await asSystem(() => db.execute(sql`UPDATE school_memberships SET status = 'inactive' WHERE id = ${formerMembership.id}`));
    const formerView = await requestJson("GET", `/flight-paths/${formerShared.id}`, teacherB);
    assert.equal(formerView.status, 200, formerView.text);
    assert.equal(formerView.body.flightPath.ownerName, null);
    const listed = await requestJson("GET", "/flight-paths", teacherB);
    assert.equal(listed.body.library.find((row: any) => row.id === formerShared.id)?.ownerName, null);
  });

  it("lets only the owner share, audits it, and never lets an administrator publish a teacher's private item", async () => {
    setLibrary("on");
    const privateA = await createPath(teacherA, "Share private A");
    const sharedA = await createPath(teacherA, "Share shared A", { visibility: "school" });

    assert.equal((await requestJson("POST", `/flight-paths/${privateA.id}/visibility`, teacherA, { visibility: "public" })).status, 400);
    assert.equal((await requestJson("POST", `/flight-paths/${privateA.id}/visibility`, teacherA, { visibility: "school", official: true })).status, 400);

    const shared = await requestJson("POST", `/flight-paths/${privateA.id}/visibility`, teacherA, { visibility: "school" });
    assert.equal(shared.status, 200, shared.text);
    assert.equal(shared.body.flightPath.visibility, "school");
    assert.ok(shared.body.flightPath.publishedAt);
    assert.equal("publishedBy" in shared.body.flightPath, false);
    const audits = await auditActions(privateA.id);
    assert.deepEqual(audits.map((row) => row.action), ["classpilot.flight_path.visibility_changed"]);
    assert.equal(audits[0]!.userId, teacherA.id);
    assert.deepEqual(audits[0]!.changes, { before: { visibility: "private", official: false }, after: { visibility: "school", official: false } });
    assert.equal((await storedPath(privateA.id)).publishedBy, teacherA.id);

    const viewerRefused = await requestJson("POST", `/flight-paths/${sharedA.id}/visibility`, teacherB, { visibility: "private" });
    assert.equal(viewerRefused.status, 403, viewerRefused.text);
    assert.equal(viewerRefused.body.code, "SHARED_RESOURCE_OWNER_REQUIRED");
    const hidden = await createPath(teacherA, "Share hidden A");
    assert.equal((await requestJson("POST", `/flight-paths/${hidden.id}/visibility`, teacherB, { visibility: "school" })).status, 404);
    const adminRefused = await requestJson("POST", `/flight-paths/${hidden.id}/visibility`, admin, { visibility: "school" });
    assert.equal(adminRefused.status, 403, adminRefused.text);
    assert.equal(adminRefused.body.code, "SHARED_RESOURCE_OWNER_REQUIRED");
    assert.equal((await storedPath(hidden.id)).visibility, "private");
    assert.deepEqual(await auditActions(hidden.id), []);

    const unshared = await requestJson("POST", `/flight-paths/${sharedA.id}/visibility`, teacherA, { visibility: "private" });
    assert.equal(unshared.status, 200, unshared.text);
    assert.equal(unshared.body.flightPath.publishedAt, null);

    const list = await createList(teacherA, "Share list A");
    const listShared = await requestJson("POST", `/block-lists/${list.id}/visibility`, teacherA, { visibility: "school" });
    assert.equal(listShared.status, 200, listShared.text);
    assert.equal(listShared.body.blockList.visibility, "school");
    assert.deepEqual((await auditActions(list.id)).map((row) => row.action), ["classpilot.block_list.visibility_changed"]);
    assert.equal((await requestJson("POST", `/block-lists/${list.id}/visibility`, admin, { visibility: "private" })).status, 403);
  });

  it("restricts official marking to administrators and to shared or self-owned items", async () => {
    setLibrary("on");
    const privateA = await createPath(teacherA, "Official private A");
    const sharedA = await createPath(teacherA, "Official shared A", { visibility: "school" });
    const ownAdmin = await createPath(schoolAdmin, "Official own school admin");

    const teacherRefused = await requestJson("POST", `/flight-paths/${sharedA.id}/official`, teacherA, { official: true });
    assert.equal(teacherRefused.status, 403, teacherRefused.text);

    const privateRefused = await requestJson("POST", `/flight-paths/${privateA.id}/official`, admin, { official: true });
    assert.equal(privateRefused.status, 409, privateRefused.text);
    assert.equal(privateRefused.body.code, "SHARED_RESOURCE_NOT_SHARED");
    assert.equal((await storedPath(privateA.id)).official, false);
    assert.deepEqual(await auditActions(privateA.id), []);

    const marked = await requestJson("POST", `/flight-paths/${sharedA.id}/official`, admin, { official: true });
    assert.equal(marked.status, 200, marked.text);
    assert.equal(marked.body.flightPath.official, true);
    const audits = await auditActions(sharedA.id);
    assert.deepEqual(audits.map((row) => row.action), ["classpilot.flight_path.official_changed"]);
    assert.equal(audits[0]!.userId, admin.id);
    assert.equal(audits[0]!.metadata.actorIsOwner, false);
    assert.equal((await storedPath(sharedA.id)).publishedBy, admin.id);

    const own = await requestJson("POST", `/flight-paths/${ownAdmin.id}/official`, schoolAdmin, { official: true });
    assert.equal(own.status, 200, own.text);
    const forB = await requestJson("GET", "/flight-paths", teacherB);
    assert.ok(forB.body.library.some((row: any) => row.id === ownAdmin.id && row.official === true));

    const removed = await requestJson("POST", `/flight-paths/${sharedA.id}/official`, admin, { official: false });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.flightPath.official, false);
    assert.equal(removed.body.flightPath.visibility, "school", "removing the official mark keeps the owner's sharing");

    const privateList = await createList(teacherA, "Official private list");
    const sharedList = await createList(teacherA, "Official shared list", { visibility: "school" });
    assert.equal((await requestJson("POST", `/block-lists/${privateList.id}/official`, admin, { official: true })).status, 409);
    const listMarked = await requestJson("POST", `/block-lists/${sharedList.id}/official`, admin, { official: true });
    assert.equal(listMarked.status, 200, listMarked.text);
    assert.deepEqual((await auditActions(sharedList.id)).map((row) => row.action), ["classpilot.block_list.official_changed"]);
  });

  it("keeps official items administrator-managed, keeps other teachers out, and audits privileged edits", async () => {
    setLibrary("on");
    const official = await createPath(teacherA, "Managed official", { visibility: "school", official: true });
    const sharedA = await createPath(teacherA, "Managed shared");
    await requestJson("POST", `/flight-paths/${sharedA.id}/visibility`, teacherA, { visibility: "school" });
    const privateA = await createPath(teacherA, "Managed private");

    const ownerPatch = await requestJson("PATCH", `/flight-paths/${official.id}`, teacherA, { flightPathName: `${TAG} Hijacked` });
    assert.equal(ownerPatch.status, 403, ownerPatch.text);
    assert.equal(ownerPatch.body.code, "OFFICIAL_RESOURCE_ADMIN_ONLY");
    assert.equal((await requestJson("DELETE", `/flight-paths/${official.id}`, teacherA)).status, 403);
    assert.equal((await requestJson("POST", `/flight-paths/${official.id}/visibility`, teacherA, { visibility: "private" })).status, 403);
    assert.equal((await storedPath(official.id)).flightPathName, `${TAG} Managed official`);

    const adminPatch = await requestJson("PATCH", `/flight-paths/${official.id}`, admin, { flightPathName: `${TAG} Managed official v2` });
    assert.equal(adminPatch.status, 200, adminPatch.text);
    const adminAudit = await auditActions(official.id);
    assert.deepEqual(adminAudit.map((row) => row.action), ["classpilot.flight_path.updated"]);
    assert.deepEqual(adminAudit[0]!.changes.fields, ["flightPathName"]);
    assert.equal(adminAudit[0]!.metadata.actorIsOwner, false);

    const teacherBPatch = await requestJson("PATCH", `/flight-paths/${sharedA.id}`, teacherB, { flightPathName: `${TAG} Hijacked` });
    assert.equal(teacherBPatch.status, 404, teacherBPatch.text);
    assert.equal((await requestJson("DELETE", `/flight-paths/${sharedA.id}`, teacherB)).status, 404);
    assert.equal((await storedPath(sharedA.id)).flightPathName, `${TAG} Managed shared`);

    const ownerSharedPatch = await requestJson("PATCH", `/flight-paths/${sharedA.id}`, teacherA, { allowedDomains: ["one.example.edu", "two.example.edu"] });
    assert.equal(ownerSharedPatch.status, 200, ownerSharedPatch.text);
    assert.deepEqual((await auditActions(sharedA.id)).map((row) => row.action), [
      "classpilot.flight_path.visibility_changed",
      "classpilot.flight_path.updated",
    ]);

    const ownerPrivatePatch = await requestJson("PATCH", `/flight-paths/${privateA.id}`, teacherA, { description: "notes" });
    assert.equal(ownerPrivatePatch.status, 200, ownerPrivatePatch.text);
    assert.deepEqual(await auditActions(privateA.id), [], "an owner's edit of a private item is not a privileged change");
    const adminPrivatePatch = await requestJson("PATCH", `/flight-paths/${privateA.id}`, admin, { description: "admin notes" });
    assert.equal(adminPrivatePatch.status, 200, adminPrivatePatch.text);
    assert.deepEqual((await auditActions(privateA.id)).map((row) => row.action), ["classpilot.flight_path.updated"]);

    const deleted = await requestJson("DELETE", `/flight-paths/${sharedA.id}`, admin);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(await storedPath(sharedA.id), undefined);
    assert.equal((await auditActions(sharedA.id)).at(-1)?.action, "classpilot.flight_path.deleted");

    const officialList = await createList(teacherA, "Managed official list", { visibility: "school", official: true });
    assert.equal((await requestJson("PATCH", `/block-lists/${officialList.id}`, teacherA, { name: `${TAG} Hijacked list` })).status, 403);
    assert.equal((await requestJson("DELETE", `/block-lists/${officialList.id}`, teacherA)).status, 403);
    assert.equal((await requestJson("PATCH", `/block-lists/${officialList.id}`, teacherB, { name: `${TAG} Hijacked list` })).status, 404);
    const adminListPatch = await requestJson("PATCH", `/block-lists/${officialList.id}`, admin, { blockedDomains: ["games.example.com", "video.example.com"] });
    assert.equal(adminListPatch.status, 200, adminListPatch.text);
    assert.deepEqual((await auditActions(officialList.id)).map((row) => row.action), ["classpilot.block_list.updated"]);
    assert.equal((await storedList(officialList.id)).name, `${TAG} Managed official list`);
  });

  it("copies a visible item into a private copy owned by the caller, without the source's Classroom provenance", async () => {
    setLibrary("on");
    const sharedA = await createPath(teacherA, "Copy research", {
      visibility: "school",
      official: true,
      description: "Plant cells",
      allowedDomains: ["cells.example.edu"],
      sourceType: "google_classroom",
      sourceCourseId: "course-copy",
      sourceResourceIds: ["resource-copy"],
      sourceUpdatedAt: new Date(),
    });
    const privateA = await createPath(teacherA, "Copy private");
    await createPath(teacherB, "Copy research");

    const copied = await requestJson("POST", `/flight-paths/${sharedA.id}/copy`, teacherB, {});
    assert.equal(copied.status, 201, copied.text);
    const copy = copied.body.flightPath;
    assert.notEqual(copy.id, sharedA.id);
    assert.equal(copy.teacherId, teacherB.id);
    assert.equal(copy.flightPathName, `${TAG} Copy research (copy)`);
    assert.equal(copy.description, "Plant cells");
    assert.deepEqual(copy.allowedDomains, ["cells.example.edu"]);
    assert.equal(copy.visibility, "private");
    assert.equal(copy.official, false);
    assert.equal(copy.publishedAt, null);
    assert.equal(copy.sourceType, null);
    assert.equal(copy.sourceCourseId, null);
    assert.deepEqual(copy.sourceResourceIds, []);
    assert.equal(copy.sourceUpdatedAt, null);
    assert.equal(copy.canEdit, true);
    const copyAudit = await auditActions(copy.id);
    assert.deepEqual(copyAudit.map((row) => row.action), ["classpilot.flight_path.copied"]);
    assert.equal(copyAudit[0]!.metadata.sourceId, sharedA.id);

    // The copy belongs to B: B edits it freely; A's official original is untouched.
    const edited = await requestJson("PATCH", `/flight-paths/${copy.id}`, teacherB, { allowedDomains: ["mine.example.edu"] });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual((await storedPath(sharedA.id)).allowedDomains, ["cells.example.edu"]);

    assert.equal((await requestJson("POST", `/flight-paths/${privateA.id}/copy`, teacherB, {})).status, 404);
    assert.equal((await requestJson("POST", `/flight-paths/${sharedA.id}/copy`, teacherB, { name: "x" })).status, 400);
    const officeCopy = await requestJson("POST", `/flight-paths/${sharedA.id}/copy`, office, {});
    assert.equal(officeCopy.status, 403, officeCopy.text);
    assert.equal(officeCopy.body.code, "CLASS_TEACHER_NOT_FOUND");
    assert.equal((await requestJson("POST", `/flight-paths/${sharedA.id}/copy`, foreignTeacher, {}, foreignSchool.id)).status, 404);

    const sharedList = await createList(teacherA, "Copy list", { visibility: "school" });
    const listCopy = await requestJson("POST", `/block-lists/${sharedList.id}/copy`, teacherB, {});
    assert.equal(listCopy.status, 201, listCopy.text);
    assert.equal(listCopy.body.blockList.teacherId, teacherB.id);
    assert.equal(listCopy.body.blockList.visibility, "private");
    assert.equal(listCopy.body.blockList.official, false);
    assert.deepEqual((await auditActions(listCopy.body.blockList.id)).map((row) => row.action), ["classpilot.block_list.copied"]);
    assert.equal((await requestJson("POST", `/block-lists/${sharedList.id}/copy`, office, {})).status, 403);
  });

  it("returns an error instead of success when the strict audit cannot be written, and keeps the item unchanged", async () => {
    setLibrary("on");
    const privateA = await createPath(teacherA, "Audit private");
    const sharedA = await createPath(teacherA, "Audit shared", { visibility: "school" });
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `library_audit_fail_${suffix}`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$`);
    await pool.query(`CREATE TRIGGER ${functionName} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.school_id = '${school.id}') EXECUTE FUNCTION ${functionName}()`);
    try {
      const shared = await requestJson("POST", `/flight-paths/${privateA.id}/visibility`, teacherA, { visibility: "school" });
      assert.equal(shared.status, 500, shared.text);
      assert.equal((await storedPath(privateA.id)).visibility, "private");

      const official = await requestJson("POST", `/flight-paths/${sharedA.id}/official`, admin, { official: true });
      assert.equal(official.status, 500, official.text);
      assert.equal((await storedPath(sharedA.id)).official, false);

      const patched = await requestJson("PATCH", `/flight-paths/${sharedA.id}`, admin, { flightPathName: `${TAG} Unaudited` });
      assert.equal(patched.status, 500, patched.text);
      assert.equal((await storedPath(sharedA.id)).flightPathName, `${TAG} Audit shared`);

      const deleted = await requestJson("DELETE", `/flight-paths/${sharedA.id}`, teacherA);
      assert.equal(deleted.status, 500, deleted.text);
      assert.ok(await storedPath(sharedA.id), "an unaudited delete of a shared item must roll back");
    } finally {
      await pool.query(`DROP TRIGGER ${functionName} ON audit_logs`);
      await pool.query(`DROP FUNCTION ${functionName}()`);
    }
  });

  it("keeps publication through a staff transfer, audits the hand-off, and leaves ownerless shared items to administrators", async () => {
    setLibrary("on");
    const departing = await storage.createUser({ email: `departing@${DOMAIN}`, firstName: "Dana", lastName: "Departing" });
    const departingMembership = await storage.createMembership({ userId: departing.id, schoolId: school.id, role: "teacher", status: "active" });
    const [replacementMembership] = await asSystem(() => db.execute(sql`
      SELECT id FROM school_memberships WHERE user_id = ${teacherB.id} AND school_id = ${school.id} AND role = 'teacher'
    `)).then((result: any) => result.rows);
    const sharedPath = await createPath(departing, "Transfer shared path", { visibility: "school" });
    const officialList = await createList(departing, "Transfer official list", { official: true });

    const impact: any = await inSchool(school.id, () => lifecycle.getStaffAssignmentImpact(school.id, departingMembership.id));
    const pathImpact = impact.assignments.find((row: any) => row.assignmentId === sharedPath.id);
    const listImpact = impact.assignments.find((row: any) => row.assignmentId === officialList.id);
    assert.equal(pathImpact.label, "Flight path (shared in the School Library)");
    assert.equal(listImpact.label, "Block list (official, in the School Library)");

    await inSchool(school.id, () => lifecycle.transitionStaffAssignments({
      schoolId: school.id,
      membershipId: departingMembership.id,
      actorUserId: admin.id,
      actorRole: "admin",
      request: {
        expectedRevision: impact.revision,
        action: "deactivate",
        decisions: impact.assignments.map((assignment: any) => ({
          assignmentType: assignment.assignmentType,
          assignmentId: assignment.assignmentId,
          operation: assignment.assignmentType === "block_list" ? "replace" : "remove",
          ...(assignment.assignmentType === "block_list" ? { replacementMembershipId: replacementMembership.id } : {}),
        })),
      },
    }));

    const ownerless = await storedPath(sharedPath.id);
    assert.equal(ownerless.teacherId, null);
    assert.equal(ownerless.visibility, "school", "publication state carries over");
    const transferredList = await storedList(officialList.id);
    assert.equal(transferredList.teacherId, teacherB.id);
    assert.equal(transferredList.official, true);
    const pathAudit = await auditActions(sharedPath.id);
    assert.deepEqual(pathAudit.map((row) => row.action), ["classpilot.flight_path.published_owner_transferred"]);
    assert.deepEqual(pathAudit[0]!.changes, { fromTeacherId: departing.id, toTeacherId: null, visibility: "school", official: false });
    assert.equal(pathAudit[0]!.userId, admin.id);
    assert.equal(pathAudit[0]!.metadata.ownerless, true);
    const listAudit = await auditActions(officialList.id);
    assert.deepEqual(listAudit.map((row) => row.action), ["classpilot.block_list.published_owner_transferred"]);
    assert.equal(listAudit[0]!.changes.toTeacherId, teacherB.id);

    // The ownerless shared Flight Path stays usable but only administrators change it.
    const viewed = await requestJson("GET", `/flight-paths/${sharedPath.id}`, teacherA);
    assert.equal(viewed.status, 200, viewed.text);
    assert.equal(viewed.body.flightPath.ownerName, null);
    assert.equal((await requestJson("PATCH", `/flight-paths/${sharedPath.id}`, teacherA, { description: "mine now" })).status, 404);
    assert.equal((await requestJson("POST", `/flight-paths/${sharedPath.id}/visibility`, teacherA, { visibility: "private" })).status, 403);
    const adminEdit = await requestJson("PATCH", `/flight-paths/${sharedPath.id}`, admin, { description: "kept by the school" });
    assert.equal(adminEdit.status, 200, adminEdit.text);
    const adminUnshare = await requestJson("POST", `/flight-paths/${sharedPath.id}/visibility`, admin, { visibility: "private" });
    assert.equal(adminUnshare.status, 200, adminUnshare.text);
    assert.equal(adminUnshare.body.flightPath.visibility, "private");
    const adminReshare = await requestJson("POST", `/flight-paths/${sharedPath.id}/visibility`, admin, { visibility: "school" });
    assert.equal(adminReshare.status, 403, "an administrator cannot publish an ownerless private item");
    // The departed teacher's block list now belongs to its replacement; still official.
    assert.equal((await requestJson("PATCH", `/block-lists/${officialList.id}`, teacherB, { name: "renamed" })).status, 403);
  });
});
