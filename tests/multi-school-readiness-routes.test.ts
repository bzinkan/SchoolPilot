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
  createDismissalChange,
  createFamilyGroup,
  getSchoolById,
  getOverrideForStudent,
  getStudentById,
  getStudentByEmail,
  getMembershipByUserAndSchool,
  addHomeroomTeacher,
  addStudentToFamilyGroup,
  upsertSettings,
  updateEnrollmentSettings,
} from "../dist/services/storage.js";
import { resolveGoPilotIdentity } from "../dist/services/gopilotAccess.js";
import { signUserToken } from "../dist/services/jwt.js";
import { verifyStudentToken } from "../dist/services/deviceJwt.js";
import { hashPassword } from "../dist/util/password.js";

const TAG = `msready${Date.now()}`;
const schoolAEnrollmentKey = `${TAG}-school-a-setup-key`;
const schoolBEnrollmentKey = `${TAG}-school-b-setup-key`;

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

async function registerStudent(
  body: Record<string, unknown>,
  enrollmentKey: string | null = schoolAEnrollmentKey
) {
  return requestJson(
    "POST",
    "/classpilot/register-student",
    body,
    enrollmentKey ? { "x-classpilot-enrollment-key": enrollmentKey } : {}
  );
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
  await db.execute(sql`ALTER TABLE IF EXISTS students ADD COLUMN IF NOT EXISTS classpilot_pin_hash TEXT`);
  await db.execute(sql`ALTER TABLE IF EXISTS students ADD COLUMN IF NOT EXISTS classpilot_pin_encrypted TEXT`);
  await db.execute(sql`ALTER TABLE IF EXISTS dismissal_changes ADD COLUMN IF NOT EXISTS acknowledged_by TEXT`);
  await db.execute(sql`ALTER TABLE IF EXISTS dismissal_changes ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP`);
  await db.execute(sql`ALTER TABLE IF EXISTS dismissal_overrides ADD COLUMN IF NOT EXISTS bus_route TEXT`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_timeline_events (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      case_id TEXT,
      event_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      severity TEXT,
      actor_user_id TEXT,
      metadata JSONB,
      occurred_at TIMESTAMP NOT NULL DEFAULT now(),
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS student_timeline_events_school_occurred_idx ON student_timeline_events (school_id, occurred_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS student_timeline_events_student_occurred_idx ON student_timeline_events (student_id, occurred_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS student_timeline_events_case_idx ON student_timeline_events (case_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS student_timeline_events_type_idx ON student_timeline_events (event_type)`);

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
  await inSchool(schoolA.id, () =>
    updateEnrollmentSettings(schoolA.id, {
      autoEnrollStudents: false,
      enrollmentKey: schoolAEnrollmentKey,
      enrollmentKeyRequired: true,
    })
  );
  await inSchool(schoolB.id, () =>
    updateEnrollmentSettings(schoolB.id, {
      autoEnrollStudents: false,
      enrollmentKey: schoolBEnrollmentKey,
      enrollmentKeyRequired: true,
    })
  );

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
      await db.execute(sql`DELETE FROM student_timeline_events WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM dismissal_overrides WHERE session_id IN (SELECT id FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM dismissal_changes WHERE session_id IN (SELECT id FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM dismissal_queue WHERE session_id IN (SELECT id FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM student_attendance WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM family_group_students WHERE family_group_id IN (SELECT id FROM family_groups WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM family_groups WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM parent_student WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
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
    assert.ok(token.sessionId);
  });

  it("legacy register-student requires the managed setup key before minting a token", async () => {
    const response = await registerStudent(
      {
        deviceId: `${TAG}-missing-key-device`,
        studentEmail: `exact@${TAG}-a.example.edu`,
        schoolId: schoolA.id,
      },
      null
    );

    assert.equal(response.status, 401);
    assert.match(response.body.error, /enrollment key/i);
  });

  it("extension login-config defaults shared Chromebook sign-in to Name + PIN", async () => {
    await inSchool(schoolA.id, () =>
      upsertSettings(schoolA.id, {
        enrollmentKey: schoolAEnrollmentKey,
        enrollmentKeyRequired: true,
        sharedChromebookSignInEnabled: true,
      } as any)
    );

    const pinConfig = await requestJson(
      "GET",
      `/classpilot/extension/login-config?schoolSlug=${schoolA.slug}`,
      undefined,
      { "x-classpilot-enrollment-key": schoolAEnrollmentKey }
    );
    assert.equal(pinConfig.status, 200);
    assert.equal(pinConfig.body.loginMethod, "name_pin");
    assert.equal(pinConfig.body.pinLoginEnabled, true);

    await inSchool(schoolA.id, () =>
      upsertSettings(schoolA.id, {
        sharedChromebookLoginMethod: "email_id",
        sharedChromebookPinLoginEnabled: false,
      } as any)
    );

    const emailConfig = await requestJson(
      "GET",
      `/classpilot/extension/login-config?schoolSlug=${schoolA.slug}`,
      undefined,
      { "x-classpilot-enrollment-key": schoolAEnrollmentKey }
    );
    assert.equal(emailConfig.status, 200);
    assert.equal(emailConfig.body.loginMethod, "email_id");
    assert.equal(emailConfig.body.pinLoginEnabled, false);
  });

  it("admin student creation auto-generates ClassPilot PINs but not Student ID Numbers", async () => {
    const manualId = "8700001";
    const manual = await requestJson(
      "POST",
      "/students",
      {
        firstName: "Manual",
        lastName: "Id",
        email: `manual.id@${TAG}-a.example.edu`,
        studentIdNumber: manualId,
      },
      authFor(adminUser, schoolA.id)
    );
    assert.equal(manual.status, 201);
    assert.equal(manual.body.student.studentIdNumber, manualId);
    assert.equal(manual.body.generatedPins.length, 1);
    assert.match(manual.body.generatedPins[0].pin, /^\d{4}$/);

    const generated = await requestJson(
      "POST",
      "/students",
      {
        firstName: "Generated",
        lastName: "Id",
        email: `generated.id@${TAG}-a.example.edu`,
      },
      authFor(adminUser, schoolA.id)
    );
    assert.equal(generated.status, 201);
    assert.equal(generated.body.student.studentIdNumber, null);
    assert.equal(generated.body.generatedPins.length, 1);
    assert.match(generated.body.generatedPins[0].pin, /^\d{4}$/);

    const bulk = await requestJson(
      "POST",
      "/students/bulk",
      {
        students: [
          {
            firstName: "Bulk",
            lastName: "Manual",
            email: `bulk.manual.id@${TAG}-a.example.edu`,
            studentIdNumber: "8700002",
          },
          {
            firstName: "Bulk",
            lastName: "Generated",
            email: `bulk.generated.id@${TAG}-a.example.edu`,
          },
        ],
      },
      authFor(adminUser, schoolA.id)
    );
    assert.equal(bulk.status, 201);
    assert.equal(bulk.body.generatedPins.length, 2);
    assert.ok(bulk.body.generatedPins.every((row: any) => /^\d{4}$/.test(row.pin)));

    const bulkManual = await inSchool(schoolA.id, () => getStudentByEmail(schoolA.id, `bulk.manual.id@${TAG}-a.example.edu`));
    const bulkGenerated = await inSchool(schoolA.id, () => getStudentByEmail(schoolA.id, `bulk.generated.id@${TAG}-a.example.edu`));
    assert.equal(bulkManual?.studentIdNumber, "8700002");
    assert.equal(bulkGenerated?.studentIdNumber, null);
    assert.ok(bulkManual?.classpilotPinHash);
    assert.ok(bulkGenerated?.classpilotPinHash);
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

  it("GoPilot role resolution treats office representations consistently", async () => {
    const manualOffice = await createUser({
      email: `${TAG}-manual-office@${TAG}-a.example.edu`,
      firstName: "Manual",
      lastName: "Office",
    } as any);
    const importedOffice = await createUser({
      email: `${TAG}-imported-office@${TAG}-a.example.edu`,
      firstName: "Imported",
      lastName: "Office",
    } as any);
    const duplicateRoleUser = await createUser({
      email: `${TAG}-duplicate-role@${TAG}-a.example.edu`,
      firstName: "Duplicate",
      lastName: "Role",
    } as any);

    await inSchool(schoolA.id, async () => {
      await createMembership({
        userId: manualOffice.id,
        schoolId: schoolA.id,
        role: "teacher",
        gopilotRole: "office_staff",
        status: "active",
      } as any);
      await createMembership({
        userId: importedOffice.id,
        schoolId: schoolA.id,
        role: "office_staff",
        status: "active",
      } as any);
      await createMembership({
        userId: duplicateRoleUser.id,
        schoolId: schoolA.id,
        role: "parent",
        status: "active",
      } as any);
      await createMembership({
        userId: duplicateRoleUser.id,
        schoolId: schoolA.id,
        role: "teacher",
        status: "active",
      } as any);
    });

    const manualIdentity = await resolveGoPilotIdentity(manualOffice.id, schoolA.id);
    const importedIdentity = await resolveGoPilotIdentity(importedOffice.id, schoolA.id);
    const duplicateIdentity = await resolveGoPilotIdentity(duplicateRoleUser.id, schoolA.id);

    assert.equal(manualIdentity?.primaryRole, "office_staff");
    assert.equal(importedIdentity?.primaryRole, "office_staff");
    assert.equal(manualIdentity?.capabilities.manageDismissal, true);
    assert.equal(importedIdentity?.capabilities.manageDismissal, true);
    assert.equal(duplicateIdentity?.primaryRole, "teacher");
    assert.equal(duplicateIdentity?.capabilities.parentStudentAccess, false);
  });

  it("GoPilot Workspace office re-import updates existing teacher memberships", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const existingTeacher = await createUser({
      email: `${TAG}-office-reimport@${TAG}-a.example.edu`,
      firstName: "Office",
      lastName: "Reimport",
    } as any);
    await inSchool(schoolA.id, () =>
      createMembership({
        userId: existingTeacher.id,
        schoolId: schoolA.id,
        role: "teacher",
        status: "active",
      } as any)
    );

    const res = await requestJson(
      "POST",
      "/google/workspace/import-staff",
      {
        users: [{
          email: existingTeacher.email,
          firstName: existingTeacher.firstName,
          lastName: existingTeacher.lastName,
        }],
        role: "office_staff",
        source: "gopilot_setup",
      },
      adminAuth
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 1);

    const membership = await inSchool(schoolA.id, () =>
      getMembershipByUserAndSchool(existingTeacher.id, schoolA.id)
    );
    assert.equal(membership?.role, "teacher");
    assert.equal(membership?.gopilotRole, "office_staff");

    const identity = await resolveGoPilotIdentity(existingTeacher.id, schoolA.id);
    assert.equal(identity?.primaryRole, "office_staff");
    assert.equal(identity?.capabilities.manageDismissal, true);
  });

  it("GoPilot teachers can manage attendance only for assigned homerooms", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const teacherAuth = authFor(teacherA, schoolA.id);
    const date = "2099-01-02";

    const seed = await requestJson(
      "POST",
      "/attendance",
      {
        studentIds: [teacherAStudent.id, teacherBStudent.id],
        date,
        status: "absent",
        reason: "fixture",
      },
      adminAuth
    );
    assert.equal(seed.status, 201);

    const read = await requestJson("GET", `/attendance?date=${date}`, undefined, teacherAuth);
    assert.equal(read.status, 200);
    const visibleIds = new Set((read.body.records || []).map((record: any) => record.studentId));
    assert.ok(visibleIds.has(teacherAStudent.id));
    assert.ok(!visibleIds.has(teacherBStudent.id));

    const foreignWrite = await requestJson(
      "POST",
      "/attendance",
      { studentIds: [teacherBStudent.id], date: "2099-01-03", status: "tardy" },
      teacherAuth
    );
    assert.equal(foreignWrite.status, 403);

    const ownWrite = await requestJson(
      "POST",
      "/attendance",
      { studentIds: [teacherAStudent.id], date: "2099-01-03", status: "tardy" },
      teacherAuth
    );
    assert.equal(ownWrite.status, 201);

    const foreignRecord = (seed.body.records || []).find((record: any) => record.studentId === teacherBStudent.id);
    assert.ok(foreignRecord?.id);
    const foreignDelete = await requestJson("DELETE", `/attendance/${foreignRecord.id}`, undefined, teacherAuth);
    assert.equal(foreignDelete.status, 403);
  });

  it("same-day change review creates an override and does not change roster defaults", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const teacherAuth = authFor(teacherA, schoolA.id);
    const parent = await createUser({
      email: `${TAG}-change-parent@${TAG}-a.example.edu`,
      firstName: "Change",
      lastName: "Parent",
    } as any);
    await inSchool(schoolA.id, () =>
      createMembership({ userId: parent.id, schoolId: schoolA.id, role: "parent", status: "active" } as any)
    );

    const sessionRes = await requestJson("POST", "/gopilot/dismissal/sessions", undefined, adminAuth);
    assert.equal(sessionRes.status, 200);
    const sessionId = sessionRes.body.session.id;

    const change = await inSchool(schoolA.id, () =>
      createDismissalChange({
        sessionId,
        studentId: teacherAStudent.id,
        requestedBy: parent.id,
        fromType: "car",
        toType: "bus",
        busRoute: "42",
        note: "today only",
      } as any)
    );

    const acknowledge = await requestJson("POST", `/gopilot/changes/${change.id}/acknowledge`, undefined, teacherAuth);
    assert.equal(acknowledge.status, 200);
    assert.equal(acknowledge.body.change.acknowledgedBy, teacherA.id);

    const teacherReview = await requestJson("PUT", `/gopilot/changes/${change.id}`, { status: "approved" }, teacherAuth);
    assert.equal(teacherReview.status, 403);

    const adminReview = await requestJson("PUT", `/gopilot/changes/${change.id}`, { status: "approved" }, adminAuth);
    assert.equal(adminReview.status, 200);
    assert.equal(adminReview.body.change.status, "approved");

    const override = await inSchool(schoolA.id, () => getOverrideForStudent(sessionId, teacherAStudent.id));
    assert.equal(override?.overrideType, "bus");
    assert.equal(override?.busRoute, "42");
    const student = await inSchool(schoolA.id, () => getStudentById(teacherAStudent.id));
    assert.equal(student?.dismissalType, "car");
    assert.equal(student?.busRoute, null);

    const busCheckIn = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in-by-bus`,
      { busNumber: "42" },
      adminAuth
    );
    assert.equal(busCheckIn.status, 200);
    assert.ok(
      busCheckIn.body.entries.some((entry: any) => entry.studentId === teacherAStudent.id),
      "approved bus-route override should be eligible for bus check-in"
    );

    const afterschoolStudent = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "After",
        lastName: "School",
        email: `after.school@${TAG}-a.example.edu`,
        homeroomId: homeroomA.id,
        dismissalType: "car",
        status: "active",
      } as any)
    );
    const afterschoolFamily = await inSchool(schoolA.id, () =>
      createFamilyGroup({
        schoolId: schoolA.id,
        familyName: "After Family",
        carNumber: `${TAG}-202`,
      } as any)
    );
    await inSchool(schoolA.id, () => addStudentToFamilyGroup(afterschoolFamily.id, afterschoolStudent.id));
    const afterschoolCheckIn = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in-by-number`,
      { carNumber: afterschoolFamily.carNumber },
      adminAuth
    );
    assert.equal(afterschoolCheckIn.status, 200);
    assert.ok(afterschoolCheckIn.body.entries.some((entry: any) => entry.studentId === afterschoolStudent.id));

    const afterschoolChange = await inSchool(schoolA.id, () =>
      createDismissalChange({
        sessionId,
        studentId: afterschoolStudent.id,
        requestedBy: parent.id,
        fromType: "car",
        toType: "afterschool",
        note: "club today",
      } as any)
    );
    const afterschoolReview = await requestJson(
      "PUT",
      `/gopilot/changes/${afterschoolChange.id}`,
      { status: "approved" },
      adminAuth
    );
    assert.equal(afterschoolReview.status, 200);
    const queueAfterOverride = await requestJson(
      "GET",
      `/gopilot/dismissal/sessions/${sessionId}/queue`,
      undefined,
      adminAuth
    );
    assert.equal(queueAfterOverride.status, 200);
    assert.ok(
      !(queueAfterOverride.body || []).some((entry: any) => entry.student_id === afterschoolStudent.id),
      "approved afterschool override should remove the student from the active queue"
    );
    const timeline = await inSchool(schoolA.id, () =>
      db.execute(sql`
        SELECT id FROM student_timeline_events
        WHERE school_id = ${schoolA.id}
          AND student_id = ${afterschoolStudent.id}
          AND source_type = 'gopilot'
          AND title = 'Dismissal override'
      `)
    );
    assert.ok(timeline.rows.length > 0, "approved request should record an override timeline event");
  });

  it("GoPilot queue lifecycle and check-in responses enforce safe transitions", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const teacherAuth = authFor(teacherA, schoolA.id);
    const sessionRes = await requestJson("POST", "/gopilot/dismissal/sessions", undefined, adminAuth);
    assert.equal(sessionRes.status, 200);
    const sessionId = sessionRes.body.session.id;

    const carStudent = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Lifecycle",
        lastName: "Car",
        email: `lifecycle.car@${TAG}-a.example.edu`,
        homeroomId: homeroomA.id,
        dismissalType: "car",
        status: "active",
      } as any)
    );
    const family = await inSchool(schoolA.id, () =>
      createFamilyGroup({
        schoolId: schoolA.id,
        familyName: "Lifecycle Family",
        carNumber: `${TAG}-101`,
      } as any)
    );
    await inSchool(schoolA.id, () => addStudentToFamilyGroup(family.id, carStudent.id));

    const checkIn = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in-by-number`,
      { carNumber: family.carNumber },
      adminAuth
    );
    assert.equal(checkIn.status, 200);
    assert.equal(checkIn.body.outcome, "created");
    assert.equal(checkIn.body.groupLabel, "Lifecycle Family");
    assert.equal(checkIn.body.entries.length, 1);
    assert.equal(checkIn.body.entries[0].studentName, "Lifecycle Car");
    const queueId = checkIn.body.entries[0].queueId;

    const duplicate = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in-by-number`,
      { carNumber: family.carNumber },
      adminAuth
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.outcome, "duplicate");

    const earlyRelease = await requestJson("POST", `/queue/${queueId}/release`, undefined, teacherAuth);
    assert.equal(earlyRelease.status, 409);
    const earlyPickup = await requestJson("POST", `/queue/${queueId}/dismiss`, undefined, adminAuth);
    assert.equal(earlyPickup.status, 409);

    const hold = await requestJson("POST", `/queue/${queueId}/hold`, { reason: "Waiting for ID" }, adminAuth);
    assert.equal(hold.status, 200);
    assert.equal(hold.body.entry.status, "held");

    const call = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/call`,
      { queueId, zone: "A" },
      adminAuth
    );
    assert.equal(call.status, 200);
    assert.equal(call.body.entry.status, "called");
    assert.equal(call.body.entry.holdReason, null);

    const teacherQueueAfterCall = await requestJson(
      "GET",
      `/gopilot/dismissal/sessions/${sessionId}/queue`,
      undefined,
      teacherAuth
    );
    assert.equal(teacherQueueAfterCall.status, 200);
    assert.equal(
      (teacherQueueAfterCall.body || []).find((entry: any) => entry.id === queueId)?.status,
      "called"
    );

    const delay = await requestJson("POST", `/queue/${queueId}/delay`, undefined, adminAuth);
    assert.equal(delay.status, 200);
    assert.equal(delay.body.entry.status, "delayed");
    const recallDelayed = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/call`,
      { queueId, zone: "B" },
      adminAuth
    );
    assert.equal(recallDelayed.status, 200);
    assert.equal(recallDelayed.body.entry.status, "called");
    assert.equal(recallDelayed.body.entry.delayedUntil, null);

    const release = await requestJson("POST", `/queue/${queueId}/release`, undefined, teacherAuth);
    assert.equal(release.status, 200);
    assert.equal(release.body.entry.status, "released");

    const pickup = await requestJson("POST", `/queue/${queueId}/dismiss`, undefined, adminAuth);
    assert.equal(pickup.status, 200);
    assert.equal(pickup.body.entry.status, "dismissed");
  });

  it("GoPilot bus check-in response reports partial absent skips", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const sessionRes = await requestJson("POST", "/gopilot/dismissal/sessions", undefined, adminAuth);
    assert.equal(sessionRes.status, 200);
    const sessionId = sessionRes.body.session.id;
    const busRoute = `${TAG}-BUS-7`;
    const today = new Date().toISOString().slice(0, 10);

    const presentBusStudent = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Present",
        lastName: "Bus",
        email: `present.bus@${TAG}-a.example.edu`,
        homeroomId: homeroomA.id,
        dismissalType: "bus",
        busRoute,
        status: "active",
      } as any)
    );
    const absentBusStudent = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Absent",
        lastName: "Bus",
        email: `absent.bus@${TAG}-a.example.edu`,
        homeroomId: homeroomA.id,
        dismissalType: "bus",
        busRoute,
        status: "active",
      } as any)
    );

    const markAbsent = await requestJson(
      "POST",
      "/attendance",
      { studentIds: [absentBusStudent.id], date: today, status: "absent" },
      adminAuth
    );
    assert.equal(markAbsent.status, 201);

    const busCheckIn = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in-by-bus`,
      { busNumber: busRoute },
      adminAuth
    );
    assert.equal(busCheckIn.status, 200);
    assert.equal(busCheckIn.body.outcome, "partial");
    assert.equal(busCheckIn.body.groupLabel, `Bus #${busRoute}`);
    assert.deepEqual(
      busCheckIn.body.entries.map((entry: any) => entry.studentId),
      [presentBusStudent.id]
    );
    assert.deepEqual(
      busCheckIn.body.skippedAbsent.map((student: any) => student.studentId),
      [absentBusStudent.id]
    );
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

  it("shared-product teachers without GoPilot homerooms keep school-wide attendance access", async () => {
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
      await createProductLicense({ schoolId: ppSchool.id, product: "GOPILOT", status: "active" } as any);
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

      const attendance = await requestJson(
        "POST",
        "/attendance",
        { studentIds: [ppStudent.id], date: "2099-02-01", status: "absent" },
        auth
      );
      assert.equal(attendance.status, 201);

      const attendanceRead = await requestJson("GET", "/attendance?date=2099-02-01", undefined, auth);
      assert.equal(attendanceRead.status, 200);
      assert.ok(
        (attendanceRead.body.records || []).some((record: any) => record.studentId === ppStudent.id),
        "shared-product teacher should keep attendance visibility without a GoPilot homeroom"
      );
    } finally {
      await asSystem(async () => {
        if (ppSchool?.id) {
          await db.execute(sql`DELETE FROM student_attendance WHERE school_id = ${ppSchool.id}`);
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
