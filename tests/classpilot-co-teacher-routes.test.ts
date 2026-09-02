import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";

// W2 (e): teachers manage the co-teachers of the classes they own.
//
// POST /api/classpilot/groups/:id/teachers and
// DELETE /api/classpilot/groups/:id/teachers/:teacherId are open to school
// administrators (admin, school_admin) and to the group's primary teacher.
// Official classes (admin_class) stay routed to the admin class API for
// everyone, and the storage layer still refuses to remove the primary teacher.

const TAG = `cp_co_teacher_routes_${Date.now()}`;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.REDIS_URL = "";
delete process.env.SENDGRID_API_KEY;
process.env.NODE_ENV = "test";

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;

let school: any;
let admin: any;
let schoolAdmin: any;
let office: any;
let primary: any;
let coTeacher: any;
let otherTeacher: any;
let teacherGroup: any;
let officialGroup: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function headersFor(user: any): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: false,
    })}`,
    "x-school-id": school.id,
  };
}

async function requestJson(
  method: string,
  path: string,
  user: any,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headersFor(user),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

type GroupTeacherRow = { role: string; teacherId: string };

async function groupTeacherRows(groupId: string): Promise<string[]> {
  const rows = await inSchool<GroupTeacherRow[]>(school.id, () => storage.getGroupTeachers(groupId));
  return rows.map((row) => `${row.role}:${row.teacherId}`).sort();
}

function teachersPath(group: any): string {
  return `/classpilot/groups/${group.id}/teachers`;
}

async function cleanupSchool(schoolId: string): Promise<void> {
  await asSystem(() => db.transaction(async (tx: any) => {
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_legs WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_changes WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM classpilot_schedule_change_pairs WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM audit_logs WHERE school_id = ${schoolId}`);
    await tx.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})`);
    await tx.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})`);
    await tx.execute(sql`DELETE FROM groups WHERE school_id = ${schoolId}`);
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
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  school = await storage.createSchool({
    name: `${TAG} School`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-school`,
    schoolTimezone: "America/New_York",
  });
  [admin, schoolAdmin, office, primary, coTeacher, otherTeacher] = await Promise.all([
    storage.createUser({ email: `admin@${TAG}.example.edu`, firstName: "Alex", lastName: "Admin" }),
    storage.createUser({ email: `school-admin@${TAG}.example.edu`, firstName: "Sam", lastName: "SchoolAdmin" }),
    storage.createUser({ email: `office@${TAG}.example.edu`, firstName: "Oakley", lastName: "Office" }),
    storage.createUser({ email: `primary@${TAG}.example.edu`, firstName: "Priya", lastName: "Primary" }),
    storage.createUser({ email: `co-teacher@${TAG}.example.edu`, firstName: "Casey", lastName: "Co" }),
    storage.createUser({ email: `other@${TAG}.example.edu`, firstName: "Ollie", lastName: "Other" }),
  ]);
  for (const [user, role] of [
    [admin, "admin"],
    [schoolAdmin, "school_admin"],
    [office, "office_staff"],
    [primary, "teacher"],
    [coTeacher, "teacher"],
    [otherTeacher, "teacher"],
  ] as const) {
    await storage.createMembership({ userId: user.id, schoolId: school.id, role, status: "active" });
  }
  await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
  await storage.upsertSettings(school.id, { schoolName: school.name, wsSharedKey: "" });

  teacherGroup = await inSchool(school.id, () => storage.createGroup({
    schoolId: school.id,
    teacherId: primary.id,
    name: `${TAG} Teacher Class`,
    groupType: "teacher_created",
    status: "active",
  }));
  officialGroup = await inSchool(school.id, () => storage.createGroup({
    schoolId: school.id,
    teacherId: primary.id,
    name: `${TAG} Official Class`,
    groupType: "admin_class",
    status: "active",
  }));

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
    if (school?.id) await cleanupSchool(school.id);
    await asSystem(() => db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`));
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
  }
});

describe("ClassPilot co-teacher management routes", { concurrency: false }, () => {
  it("lets the primary teacher of a teacher-created class add and remove a co-teacher", async () => {
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);

    const added = await requestJson("POST", teachersPath(teacherGroup), primary, {
      teacherId: coTeacher.id,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.teacher.teacherId, coTeacher.id);
    assert.equal(added.body.teacher.role, "co-teacher");
    assert.deepEqual(
      await groupTeacherRows(teacherGroup.id),
      [`co-teacher:${coTeacher.id}`, `primary:${primary.id}`]
    );

    const listed = await requestJson("GET", teachersPath(teacherGroup), primary);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.teachers.map((entry: any) => [entry.role, entry.teacherId, entry.teacher?.name]).sort(),
      [
        ["co-teacher", coTeacher.id, "Casey Co"],
        ["primary", primary.id, "Priya Primary"],
      ]
    );

    const removed = await requestJson(
      "DELETE",
      `${teachersPath(teacherGroup)}/${coTeacher.id}`,
      primary
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body, { ok: true });
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);
  });

  it("rejects teachers who do not own the class and office staff with 403", async () => {
    const otherAdd = await requestJson("POST", teachersPath(teacherGroup), otherTeacher, {
      teacherId: coTeacher.id,
    });
    assert.equal(otherAdd.status, 403, JSON.stringify(otherAdd.body));
    assert.match(otherAdd.body.error, /admin or the class's primary teacher/);
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);

    const officeAdd = await requestJson("POST", teachersPath(teacherGroup), office, {
      teacherId: coTeacher.id,
    });
    assert.equal(officeAdd.status, 403, JSON.stringify(officeAdd.body));
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);

    // A co-teacher is not the primary teacher: they cannot manage the roster
    // of co-teachers either.
    await inSchool(school.id, () => storage.addGroupTeacher(teacherGroup.id, coTeacher.id, "co-teacher"));
    const coTeacherAdd = await requestJson("POST", teachersPath(teacherGroup), coTeacher, {
      teacherId: otherTeacher.id,
    });
    assert.equal(coTeacherAdd.status, 403, JSON.stringify(coTeacherAdd.body));

    const otherRemove = await requestJson(
      "DELETE",
      `${teachersPath(teacherGroup)}/${coTeacher.id}`,
      otherTeacher
    );
    assert.equal(otherRemove.status, 403, JSON.stringify(otherRemove.body));
    assert.match(otherRemove.body.error, /admin or the class's primary teacher/);

    const officeRemove = await requestJson(
      "DELETE",
      `${teachersPath(teacherGroup)}/${coTeacher.id}`,
      office
    );
    assert.equal(officeRemove.status, 403, JSON.stringify(officeRemove.body));
    assert.deepEqual(
      await groupTeacherRows(teacherGroup.id),
      [`co-teacher:${coTeacher.id}`, `primary:${primary.id}`]
    );

    await inSchool(school.id, () => storage.removeGroupTeacher(teacherGroup.id, coTeacher.id));
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);
  });

  it("allows school_admin and admin to manage co-teachers of teacher-created classes", async () => {
    const schoolAdminAdd = await requestJson("POST", teachersPath(teacherGroup), schoolAdmin, {
      teacherId: coTeacher.id,
    });
    assert.equal(schoolAdminAdd.status, 201, JSON.stringify(schoolAdminAdd.body));
    assert.deepEqual(
      await groupTeacherRows(teacherGroup.id),
      [`co-teacher:${coTeacher.id}`, `primary:${primary.id}`]
    );

    const adminRemove = await requestJson(
      "DELETE",
      `${teachersPath(teacherGroup)}/${coTeacher.id}`,
      admin
    );
    assert.equal(adminRemove.status, 200, JSON.stringify(adminRemove.body));
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);

    const adminAdd = await requestJson("POST", teachersPath(teacherGroup), admin, {
      teacherId: otherTeacher.id,
    });
    assert.equal(adminAdd.status, 201, JSON.stringify(adminAdd.body));
    assert.deepEqual(
      await groupTeacherRows(teacherGroup.id),
      [`co-teacher:${otherTeacher.id}`, `primary:${primary.id}`]
    );

    const schoolAdminRemove = await requestJson(
      "DELETE",
      `${teachersPath(teacherGroup)}/${otherTeacher.id}`,
      schoolAdmin
    );
    assert.equal(schoolAdminRemove.status, 200, JSON.stringify(schoolAdminRemove.body));
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);
  });

  it("keeps official classes routed to the admin class API for everyone", async () => {
    for (const actor of [primary, admin, schoolAdmin, otherTeacher]) {
      const add = await requestJson("POST", teachersPath(officialGroup), actor, {
        teacherId: coTeacher.id,
      });
      assert.equal(add.status, 403, `${actor.email}: ${JSON.stringify(add.body)}`);
      assert.match(add.body.error, /admin class management API/);

      const remove = await requestJson(
        "DELETE",
        `${teachersPath(officialGroup)}/${coTeacher.id}`,
        actor
      );
      assert.equal(remove.status, 403, `${actor.email}: ${JSON.stringify(remove.body)}`);
      assert.match(remove.body.error, /admin class management API/);
    }
    assert.deepEqual(await groupTeacherRows(officialGroup.id), [`primary:${primary.id}`]);
  });

  it("lists teachable admins only on request and lets the primary add a school_admin co-teacher", async () => {
    const ids = (response: { body: any }) =>
      response.body.teachers.map((entry: any) => entry.userId).sort();

    // Default listing is unchanged: only "teacher" memberships.
    const defaultListing = await requestJson("GET", "/users/teachers", primary);
    assert.equal(defaultListing.status, 200, JSON.stringify(defaultListing.body));
    assert.deepEqual(ids(defaultListing), [primary.id, coTeacher.id, otherTeacher.id].sort());
    assert.ok(defaultListing.body.teachers.every((entry: any) => entry.role === "teacher"));

    // ?teachable=true adds admin and school_admin memberships (never office staff)
    // with the same entry shape.
    const teachable = await requestJson("GET", "/users/teachers?teachable=true", primary);
    assert.equal(teachable.status, 200, JSON.stringify(teachable.body));
    assert.deepEqual(
      ids(teachable),
      [primary.id, coTeacher.id, otherTeacher.id, admin.id, schoolAdmin.id].sort()
    );
    const schoolAdminEntry = teachable.body.teachers.find((entry: any) => entry.userId === schoolAdmin.id);
    assert.equal(schoolAdminEntry.role, "school_admin");
    assert.equal(schoolAdminEntry.user.email, schoolAdmin.email);
    assert.equal(schoolAdminEntry.user.password, undefined);
    assert.deepEqual(
      Object.keys(schoolAdminEntry).sort(),
      Object.keys(defaultListing.body.teachers[0]).sort()
    );
    assert.ok(!teachable.body.teachers.some((entry: any) => entry.userId === office.id));

    // Any other truthy-looking value still means the default listing.
    const notOptedIn = await requestJson("GET", "/users/teachers?teachable=1", primary);
    assert.equal(notOptedIn.status, 200);
    assert.deepEqual(ids(notOptedIn), ids(defaultListing));

    const added = await requestJson("POST", teachersPath(teacherGroup), primary, {
      teacherId: schoolAdmin.id,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.teacher.role, "co-teacher");
    assert.deepEqual(
      await groupTeacherRows(teacherGroup.id),
      [`co-teacher:${schoolAdmin.id}`, `primary:${primary.id}`]
    );

    const removed = await requestJson(
      "DELETE",
      `${teachersPath(teacherGroup)}/${schoolAdmin.id}`,
      primary
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);
  });

  it("refuses to remove the primary teacher even for authorized callers", async () => {
    for (const actor of [primary, admin, schoolAdmin]) {
      const remove = await requestJson(
        "DELETE",
        `${teachersPath(teacherGroup)}/${primary.id}`,
        actor
      );
      assert.equal(remove.status, 409, `${actor.email}: ${JSON.stringify(remove.body)}`);
      assert.equal(remove.body.code, "CLASS_PRIMARY_TEACHER_REQUIRED");
    }
    assert.deepEqual(await groupTeacherRows(teacherGroup.id), [`primary:${primary.id}`]);
  });
});
