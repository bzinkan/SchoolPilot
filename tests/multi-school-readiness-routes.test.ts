import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  createMembership,
  createProductLicense,
  createHomeroom,
  createSchool,
  createStudent,
  createUser,
  getSchoolById,
  getStudentByEmail,
  addHomeroomTeacher,
  updateEnrollmentSettings,
} from "../dist/services/storage.js";
import { signUserToken } from "../dist/services/jwt.js";
import { verifyStudentToken } from "../dist/services/deviceJwt.js";
import { hashPassword } from "../dist/util/password.js";

const TAG = `msready${Date.now()}`;

let schoolA: any;
let schoolB: any;
let adminUser: any;
let superUser: any;
let teacherA: any;
let teacherB: any;
let multiSchoolTeacher: any;
let homeroomA: any;
let homeroomB: any;
let multiHomeroomA: any;
let teacherAStudent: any;
let teacherBStudent: any;
let multiStudentA: any;
let server: Server;
let baseUrl: string;
let originalRedisUrl: string | undefined;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

async function requestJson(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

async function loginAsSchoolAdmin(): Promise<{ cookie: string; csrfToken: string }> {
  const login = await requestJson("POST", "/auth/login", {
    email: adminUser.email,
    password: "AdminPass123!",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "expected login to set a session cookie");

  const csrf = await requestJson("GET", "/auth/csrf", undefined, { cookie });
  assert.equal(csrf.status, 200);
  assert.ok(csrf.body.csrfToken);
  return { cookie, csrfToken: csrf.body.csrfToken };
}

async function registerStudent(body: Record<string, unknown>) {
  return requestJson("POST", "/classpilot/register-student", body);
}

function authFor(user: any, schoolId: string): Record<string, string> {
  const token = signUserToken({
    userId: user.id,
    email: user.email,
    isSuperAdmin: !!user.isSuperAdmin,
  });
  return {
    authorization: `Bearer ${token}`,
    "x-school-id": schoolId,
  };
}

before(async () => {
  originalRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "";
  mock.timers.enable({ apis: ["setInterval"] });

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`);

  schoolA = await createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}-a.example.edu`,
    slug: `${TAG}-a`,
    status: "active",
  } as any);
  schoolB = await createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}-b.example.edu`,
    slug: `${TAG}-b`,
    status: "active",
  } as any);
  await createProductLicense({ schoolId: schoolA.id, product: "CLASSPILOT", status: "active" } as any);
  await createProductLicense({ schoolId: schoolB.id, product: "CLASSPILOT", status: "active" } as any);
  await createProductLicense({ schoolId: schoolA.id, product: "GOPILOT", status: "active" } as any);
  await createProductLicense({ schoolId: schoolB.id, product: "GOPILOT", status: "active" } as any);
  await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: false }));
  await inSchool(schoolB.id, () => updateEnrollmentSettings(schoolB.id, { autoEnrollStudents: false }));

  await inSchool(schoolA.id, () =>
    createStudent({
      schoolId: schoolA.id,
      firstName: "Exact",
      lastName: "Student",
      email: `exact@${TAG}-a.example.edu`,
      status: "active",
    } as any)
  );
  await inSchool(schoolA.id, () =>
    createStudent({
      schoolId: schoolA.id,
      firstName: "Fuzzy",
      lastName: "Target",
      email: `fuzzy.target@${TAG}-a.example.edu`,
      status: "active",
    } as any)
  );

  adminUser = await createUser({
    email: `${TAG}-admin@${TAG}-a.example.edu`,
    password: await hashPassword("AdminPass123!"),
    firstName: "School",
    lastName: "Admin",
  } as any);
  await inSchool(schoolA.id, () =>
    createMembership({
      userId: adminUser.id,
      schoolId: schoolA.id,
      role: "admin",
      status: "active",
    } as any)
  );

  superUser = await createUser({
    email: `${TAG}-super@example.edu`,
    password: await hashPassword("SuperPass123!"),
    firstName: "Super",
    lastName: "Admin",
    isSuperAdmin: true,
  } as any);

  teacherA = await createUser({
    email: `${TAG}-teacher-a@${TAG}-a.example.edu`,
    password: await hashPassword("TeacherPass123!"),
    firstName: "Teacher",
    lastName: "A",
  } as any);
  teacherB = await createUser({
    email: `${TAG}-teacher-b@${TAG}-a.example.edu`,
    password: await hashPassword("TeacherPass123!"),
    firstName: "Teacher",
    lastName: "B",
  } as any);
  multiSchoolTeacher = await createUser({
    email: `${TAG}-multi-teacher@${TAG}-a.example.edu`,
    password: await hashPassword("TeacherPass123!"),
    firstName: "Multi",
    lastName: "Teacher",
  } as any);

  await inSchool(schoolA.id, async () => {
    await createMembership({ userId: teacherA.id, schoolId: schoolA.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: teacherB.id, schoolId: schoolA.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: multiSchoolTeacher.id, schoolId: schoolA.id, role: "teacher", status: "active" } as any);

    homeroomA = await createHomeroom({
      schoolId: schoolA.id,
      teacherId: teacherA.id,
      name: `${TAG}_Teacher_A`,
      grade: "6",
    } as any);
    homeroomB = await createHomeroom({
      schoolId: schoolA.id,
      teacherId: teacherB.id,
      name: `${TAG}_Teacher_B`,
      grade: "6",
    } as any);
    multiHomeroomA = await createHomeroom({
      schoolId: schoolA.id,
      teacherId: multiSchoolTeacher.id,
      name: `${TAG}_Multi_A`,
      grade: "7",
    } as any);
    await addHomeroomTeacher(homeroomA.id, teacherA.id, "primary");
    await addHomeroomTeacher(homeroomB.id, teacherB.id, "primary");
    await addHomeroomTeacher(multiHomeroomA.id, multiSchoolTeacher.id, "primary");

    teacherAStudent = await createStudent({
      schoolId: schoolA.id,
      firstName: "Assigned",
      lastName: "Alpha",
      email: `assigned.alpha@${TAG}-a.example.edu`,
      homeroomId: homeroomA.id,
      status: "active",
    } as any);
    teacherBStudent = await createStudent({
      schoolId: schoolA.id,
      firstName: "Assigned",
      lastName: "Beta",
      email: `assigned.beta@${TAG}-a.example.edu`,
      homeroomId: homeroomB.id,
      status: "active",
    } as any);
    multiStudentA = await createStudent({
      schoolId: schoolA.id,
      firstName: "Multi",
      lastName: "Alpha",
      email: `multi.alpha@${TAG}-a.example.edu`,
      homeroomId: multiHomeroomA.id,
      status: "active",
    } as any);
  });

  const { createApp } = await import("../dist/app.js");
  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM student_sessions WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM student_devices WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM devices WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM audit_logs WHERE user_email LIKE ${`${TAG}%@%`}`);
      await db.execute(sql`DELETE FROM settings WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM students WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM homeroom_teachers WHERE homeroom_id IN (SELECT id FROM homerooms WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM homerooms WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${TAG}%@%`}`);
      await db.execute(sql`DELETE FROM "session" WHERE sess::text LIKE ${`%${TAG}%`}`);
    });
  } catch {
    /* ignore cleanup errors */
  }
  await pool.end();
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }
  mock.timers.reset();
});

describe("multi-school readiness route hardening", () => {
  it("legacy register-student succeeds for an exact roster email in an active ClassPilot school", async () => {
    const response = await registerStudent({
      deviceId: `${TAG}-exact-device`,
      studentEmail: `exact@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.student.emailLc, `exact@${TAG}-a.example.edu`);
    const token = verifyStudentToken(response.body.studentToken);
    assert.equal(token.schoolId, schoolA.id);
    assert.equal(token.studentId, response.body.student.id);
  });

  it("legacy register-student rejects a foreign supplied schoolId even when the email resolves", async () => {
    const response = await registerStudent({
      deviceId: `${TAG}-foreign-school-device`,
      studentEmail: `exact@${TAG}-a.example.edu`,
      schoolId: schoolB.id,
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /schoolId does not match/i);
  });

  it("legacy register-student rejects unknown roster emails when auto-enroll is off", async () => {
    await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: false }));

    const response = await registerStudent({
      deviceId: `${TAG}-unknown-device`,
      studentEmail: `unknown@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /Student not enrolled/i);
  });

  it("legacy register-student uses exact email lookup instead of fuzzy student search", async () => {
    await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: false }));

    const response = await registerStudent({
      deviceId: `${TAG}-fuzzy-device`,
      studentEmail: `fuzzy@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /Student not enrolled/i);
  });

  it("legacy register-student still auto-enrolls only after domain, license, settings, and rate-limit checks", async () => {
    await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: true }));

    const response = await registerStudent({
      deviceId: `${TAG}-auto-device`,
      studentEmail: `auto@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
      firstName: "Auto",
      lastName: "Enroll",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.student.emailLc, `auto@${TAG}-a.example.edu`);
    const created = await inSchool(schoolA.id, () => getStudentByEmail(schoolA.id, `auto@${TAG}-a.example.edu`));
    assert.equal(created?.id, response.body.student.id);
  });

  it("session users cannot read or update a different school through a raw URL id", async () => {
    const { cookie, csrfToken } = await loginAsSchoolAdmin();

    const ownSchool = await requestJson("GET", `/schools/${schoolA.id}`, undefined, { cookie });
    assert.equal(ownSchool.status, 200);
    assert.equal(ownSchool.body.school.id, schoolA.id);

    const foreignSchool = await requestJson("GET", `/schools/${schoolB.id}`, undefined, { cookie });
    assert.equal(foreignSchool.status, 404);

    const foreignLicenses = await requestJson("GET", `/schools/${schoolB.id}/licenses`, undefined, { cookie });
    assert.equal(foreignLicenses.status, 404);

    const patch = await requestJson(
      "PATCH",
      `/schools/${schoolB.id}`,
      { name: `${TAG}_B_PWNED` },
      { cookie, "x-csrf-token": csrfToken }
    );
    assert.equal(patch.status, 404);

    const unchanged = await getSchoolById(schoolB.id);
    assert.equal(unchanged?.name, `${TAG}_B`);
  });

  it("super admins can still target another school explicitly", async () => {
    const token = signUserToken({
      userId: superUser.id,
      email: superUser.email,
      isSuperAdmin: true,
    });
    const auth = { authorization: `Bearer ${token}` };

    const read = await requestJson("GET", `/schools/${schoolB.id}`, undefined, auth);
    assert.equal(read.status, 200);
    assert.equal(read.body.school.id, schoolB.id);

    const update = await requestJson("PATCH", `/schools/${schoolB.id}`, { name: `${TAG}_B_super_updated` }, auth);
    assert.equal(update.status, 200);
    assert.equal(update.body.school.id, schoolB.id);

    const changed = await getSchoolById(schoolB.id);
    assert.equal(changed?.name, `${TAG}_B_super_updated`);
  });

  it("GoPilot teachers cannot list another same-school teacher's homeroom or students", async () => {
    const auth = authFor(teacherA, schoolA.id);

    const homerooms = await requestJson("GET", "/gopilot/homerooms", undefined, auth);
    assert.equal(homerooms.status, 200);
    const homeroomIds = new Set((homerooms.body.homerooms || []).map((h: any) => h.id));
    assert.ok(homeroomIds.has(homeroomA.id));
    assert.ok(!homeroomIds.has(homeroomB.id));

    const assignedStudents = await requestJson("GET", "/students", undefined, auth);
    assert.equal(assignedStudents.status, 200);
    const assignedIds = new Set((assignedStudents.body.students || []).map((s: any) => s.id));
    assert.ok(assignedIds.has(teacherAStudent.id));
    assert.ok(!assignedIds.has(teacherBStudent.id));

    const foreignHomeroomStudents = await requestJson("GET", `/students?homeroomId=${homeroomB.id}`, undefined, auth);
    assert.equal(foreignHomeroomStudents.status, 200);
    assert.deepEqual(foreignHomeroomStudents.body.students, []);

    const ownStudent = await requestJson("GET", `/students/${teacherAStudent.id}`, undefined, auth);
    assert.equal(ownStudent.status, 200);
    assert.equal(ownStudent.body.student.id, teacherAStudent.id);

    const foreignStudent = await requestJson("GET", `/students/${teacherBStudent.id}`, undefined, auth);
    assert.equal(foreignStudent.status, 404);

    const foreignUpdate = await requestJson(
      "PATCH",
      `/students/${teacherBStudent.id}`,
      { firstName: "Changed" },
      auth
    );
    assert.equal(foreignUpdate.status, 404);
  });

  it("GoPilot multi-school teachers only see assignments for the active school context", async () => {
    let districtSchool: any;
    try {
      districtSchool = await createSchool({
        name: `${TAG}_C`,
        domain: schoolA.domain,
        slug: `${TAG}-c`,
        status: "active",
      } as any);
      await createProductLicense({ schoolId: districtSchool.id, product: "GOPILOT", status: "active" } as any);
      await inSchool(districtSchool.id, () => updateEnrollmentSettings(districtSchool.id, { autoEnrollStudents: false }));

      let districtHomeroom: any;
      let districtStudent: any;
      await inSchool(districtSchool.id, async () => {
        await createMembership({
          userId: multiSchoolTeacher.id,
          schoolId: districtSchool.id,
          role: "teacher",
          status: "active",
        } as any);
        districtHomeroom = await createHomeroom({
          schoolId: districtSchool.id,
          teacherId: multiSchoolTeacher.id,
          name: `${TAG}_Multi_C`,
          grade: "8",
        } as any);
        await addHomeroomTeacher(districtHomeroom.id, multiSchoolTeacher.id, "primary");
        districtStudent = await createStudent({
          schoolId: districtSchool.id,
          firstName: "Multi",
          lastName: "Charlie",
          email: `multi.charlie@${TAG}-a.example.edu`,
          homeroomId: districtHomeroom.id,
          status: "active",
        } as any);
      });

      const schoolAAuth = authFor(multiSchoolTeacher, schoolA.id);
      const districtAuth = authFor(multiSchoolTeacher, districtSchool.id);

      const homeroomsA = await requestJson("GET", "/gopilot/homerooms", undefined, schoolAAuth);
      assert.equal(homeroomsA.status, 200);
      const homeroomIdsA = new Set((homeroomsA.body.homerooms || []).map((h: any) => h.id));
      assert.ok(homeroomIdsA.has(multiHomeroomA.id));
      assert.ok(!homeroomIdsA.has(districtHomeroom.id));

      const studentsA = await requestJson("GET", "/students", undefined, schoolAAuth);
      assert.equal(studentsA.status, 200);
      const studentIdsA = new Set((studentsA.body.students || []).map((s: any) => s.id));
      assert.ok(studentIdsA.has(multiStudentA.id));
      assert.ok(!studentIdsA.has(districtStudent.id));

      const homeroomsC = await requestJson("GET", "/gopilot/homerooms", undefined, districtAuth);
      assert.equal(homeroomsC.status, 200);
      const homeroomIdsC = new Set((homeroomsC.body.homerooms || []).map((h: any) => h.id));
      assert.ok(homeroomIdsC.has(districtHomeroom.id));
      assert.ok(!homeroomIdsC.has(multiHomeroomA.id));

      const studentsC = await requestJson("GET", "/students", undefined, districtAuth);
      assert.equal(studentsC.status, 200);
      const studentIdsC = new Set((studentsC.body.students || []).map((s: any) => s.id));
      assert.ok(studentIdsC.has(districtStudent.id));
      assert.ok(!studentIdsC.has(multiStudentA.id));
    } finally {
      if (districtSchool?.id) {
        await asSystem(async () => {
          await db.execute(sql`DELETE FROM settings WHERE school_id = ${districtSchool.id}`);
          await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${districtSchool.id}`);
          await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${districtSchool.id}`);
          await db.execute(sql`DELETE FROM students WHERE school_id = ${districtSchool.id}`);
          await db.execute(sql`DELETE FROM homeroom_teachers WHERE homeroom_id IN (SELECT id FROM homerooms WHERE school_id = ${districtSchool.id})`);
          await db.execute(sql`DELETE FROM homerooms WHERE school_id = ${districtSchool.id}`);
          await db.execute(sql`DELETE FROM schools WHERE id = ${districtSchool.id}`);
        });
      }
    }
  });

  it("teacher at a non-GoPilot school keeps the full roster (no homeroom scoping)", async () => {
    // Regression guard for the cross-product landmine: /students is shared across
    // products. A PassPilot/ClassPilot-only school has no homerooms, so GoPilot-style
    // teacher scoping must NOT apply there — otherwise the roster wrongly returns [].
    let ppSchool: any;
    let ppTeacher: any;
    try {
      ppSchool = await createSchool({
        name: `${TAG}_PP`,
        domain: `${TAG}-pp.example.edu`,
        slug: `${TAG}-pp`,
        status: "active",
      } as any);
      await createProductLicense({ schoolId: ppSchool.id, product: "PASSPILOT", status: "active" } as any);
      ppTeacher = await createUser({
        email: `${TAG}-pp-teacher@${TAG}-pp.example.edu`,
        password: await hashPassword("TeacherPass123!"),
        firstName: "PP",
        lastName: "Teacher",
      } as any);
      let ppStudent: any;
      await inSchool(ppSchool.id, async () => {
        await createMembership({ userId: ppTeacher.id, schoolId: ppSchool.id, role: "teacher", status: "active" } as any);
        ppStudent = await createStudent({
          schoolId: ppSchool.id,
          firstName: "Pass",
          lastName: "Kid",
          email: `kid@${TAG}-pp.example.edu`,
          status: "active",
        } as any);
      });

      const auth = authFor(ppTeacher, ppSchool.id);
      const res = await requestJson("GET", "/students", undefined, auth);
      assert.equal(res.status, 200);
      const ids = new Set((res.body.students || []).map((s: any) => s.id));
      assert.ok(ids.has(ppStudent.id), "PassPilot teacher should see the school roster, not an empty list");
    } finally {
      await asSystem(async () => {
        if (ppSchool?.id) {
          await db.execute(sql`DELETE FROM settings WHERE school_id = ${ppSchool.id}`);
          await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${ppSchool.id}`);
          await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${ppSchool.id}`);
          await db.execute(sql`DELETE FROM students WHERE school_id = ${ppSchool.id}`);
          await db.execute(sql`DELETE FROM schools WHERE id = ${ppSchool.id}`);
        }
        if (ppTeacher?.id) {
          await db.execute(sql`DELETE FROM users WHERE id = ${ppTeacher.id}`);
        }
      });
    }
  });
});
