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
  createCustodyAlert,
  createFamilyGroup,
  createParentStudentLink,
  getOrCreateSession,
  addToQueue,
  getQueueBySession,
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
  await db.execute(sql`ALTER TABLE IF EXISTS dismissal_queue ADD COLUMN IF NOT EXISTS pickup_group_id TEXT`);
  await db.execute(sql`ALTER TABLE IF EXISTS dismissal_queue ADD COLUMN IF NOT EXISTS pickup_group_label TEXT`);
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
      await db.execute(sql`DELETE FROM heartbeats WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM student_devices WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM devices WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM audit_logs WHERE user_email LIKE ${`${TAG}%@%`}`);
      await db.execute(sql`DELETE FROM student_timeline_events WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE context_id LIKE ${`${TAG}-student-data-supervision-%`}`);
      await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE id LIKE ${`${TAG}-student-data-supervision-%`}`);
      await db.execute(sql`DELETE FROM classpilot_session_usage WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM classpilot_session_reports WHERE teaching_session_id LIKE ${`${TAG}-student-data-session-%`}`);
      await db.execute(sql`DELETE FROM classpilot_session_students WHERE teaching_session_id LIKE ${`${TAG}-student-data-session-%`}`);
      await db.execute(sql`DELETE FROM classpilot_session_staff WHERE teaching_session_id LIKE ${`${TAG}-student-data-session-%`}`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE id LIKE ${`${TAG}-student-data-session-%`}`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id LIKE ${`${TAG}-student-data-group-%`}`);
      await db.execute(sql`DELETE FROM groups WHERE id LIKE ${`${TAG}-student-data-group-%`}`);
      await db.execute(sql`DELETE FROM dismissal_overrides WHERE session_id IN (SELECT id FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM dismissal_changes WHERE session_id IN (SELECT id FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM dismissal_queue WHERE session_id IN (SELECT id FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
      await db.execute(sql`DELETE FROM dismissal_sessions WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM student_attendance WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM custody_alerts WHERE student_id IN (SELECT id FROM students WHERE school_id IN (${schoolA.id}, ${schoolB.id}))`);
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
  it("serves privacy-safe Student Data aggregates and additive cursor roster pages", async () => {
    const foreignStudent = await inSchool(schoolB.id, () => createStudent({
      schoolId: schoolB.id,
      firstName: "Foreign",
      lastName: `${TAG} Student`,
      email: `foreign.student@${TAG}-b.example.edu`,
      status: "active",
    }));
    const timeZone = schoolA.schoolTimezone || "America/New_York";
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const groupAId = `${TAG}-student-data-group-a`;
    const groupBId = `${TAG}-student-data-group-b`;
    const sessionAId = `${TAG}-student-data-session-a`;
    const sessionBId = `${TAG}-student-data-session-b`;
    await asSystem(async () => {
      await db.execute(sql`
        INSERT INTO groups (
          id, school_id, teacher_id, name, group_type, status, created_at
        ) VALUES (
          ${groupAId}, ${schoolA.id}, ${teacherA.id}, 'Teacher A Science',
          'admin_class', 'active', now()
        ), (
          ${groupBId}, ${schoolB.id}, ${teacherB.id}, 'Foreign Science',
          'admin_class', 'active', now()
        )
      `);
      await db.execute(sql`
        INSERT INTO teaching_sessions (
          id, school_id, group_id, teacher_id, session_mode,
          start_time, end_time, class_name_snapshot, timezone_snapshot,
          roster_snapshot_completed_at, created_at
        ) VALUES (
          ${sessionAId}, ${schoolA.id}, ${groupAId}, ${teacherA.id}, 'live',
          now() - interval '50 minutes', now() - interval '20 minutes',
          'Teacher A Science', ${timeZone}, now() - interval '50 minutes', now() - interval '50 minutes'
        ), (
          ${sessionBId}, ${schoolB.id}, ${groupBId}, ${teacherB.id}, 'live',
          now() - interval '50 minutes', now() - interval '20 minutes',
          'Foreign Science', ${schoolB.schoolTimezone || "America/New_York"},
          now() - interval '50 minutes', now() - interval '50 minutes'
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_staff (
          school_id, teaching_session_id, staff_id, role,
          staff_name_snapshot, staff_email_snapshot, captured_at
        ) VALUES (
          ${schoolA.id}, ${sessionAId}, ${teacherA.id}, 'primary',
          'Teacher A', ${teacherA.email}, now() - interval '50 minutes'
        ), (
          ${schoolB.id}, ${sessionBId}, ${teacherB.id}, 'primary',
          'Teacher B', ${teacherB.email}, now() - interval '50 minutes'
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_students (
          school_id, teaching_session_id, group_id, student_id,
          student_name_snapshot, captured_at
        ) VALUES (
          ${schoolA.id}, ${sessionAId}, ${groupAId}, ${teacherAStudent.id},
          'Assigned Alpha', now() - interval '50 minutes'
        ), (
          ${schoolB.id}, ${sessionBId}, ${groupBId}, ${foreignStudent.id},
          'Foreign Student', now() - interval '50 minutes'
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_usage (
          school_id, teaching_session_id, group_id, student_id, local_date,
          total_seconds, heartbeat_count, top_domains, computed_at
        ) VALUES (
          ${schoolA.id}, ${sessionAId}, ${groupAId},
          ${teacherAStudent.id}, ${localDate}, 20, 2,
          ${JSON.stringify([{ domain: "https://www.example.com/private?token=secret", seconds: 9999 }])}::jsonb,
          now()
        ), (
          ${schoolB.id}, ${sessionBId}, ${groupBId},
          ${foreignStudent.id}, ${localDate}, 40, 4,
          ${JSON.stringify([{ domain: "foreign.example/private", seconds: 40 }])}::jsonb,
          now()
        )
      `);
    });

    const auth = authFor(adminUser, schoolA.id);
    const legacyRoster = await requestJson("GET", "/classpilot/roster/students", undefined, auth);
    assert.equal(legacyRoster.status, 200, JSON.stringify(legacyRoster.body));
    assert.ok(Array.isArray(legacyRoster.body.students));
    assert.equal(legacyRoster.body.pageInfo, undefined, "no-query clients retain the legacy shape");

    const firstPage = await requestJson(
      "GET",
      "/classpilot/roster/students?limit=2",
      undefined,
      auth
    );
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
    assert.equal(firstPage.body.students.length, 2);
    assert.equal(firstPage.body.pageInfo.limit, 2);
    assert.equal(firstPage.body.pageInfo.hasNextPage, true);
    assert.ok(firstPage.body.nextCursor);
    assert.doesNotMatch(JSON.stringify(firstPage.body), /deviceId|classpilotPin/i);

    const secondPage = await requestJson(
      "GET",
      `/classpilot/roster/students?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
      undefined,
      auth
    );
    assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
    const firstIds = new Set(firstPage.body.students.map((student: any) => student.id));
    assert.ok(secondPage.body.students.every((student: any) => !firstIds.has(student.id)));

    const searchPage = await requestJson(
      "GET",
      `/classpilot/roster/students?search=${encodeURIComponent(teacherAStudent.email)}&limit=100`,
      undefined,
      auth
    );
    assert.equal(searchPage.status, 200, JSON.stringify(searchPage.body));
    assert.deepEqual(searchPage.body.students.map((student: any) => student.id), [teacherAStudent.id]);
    const invalidCursor = await requestJson(
      "GET",
      "/classpilot/roster/students?cursor=not-a-cursor",
      undefined,
      auth
    );
    assert.equal(invalidCursor.status, 400);

    const scopes = await requestJson(
      "GET",
      "/classpilot/student-data/scopes",
      undefined,
      authFor(teacherA, schoolA.id)
    );
    assert.equal(scopes.status, 200, JSON.stringify(scopes.body));
    assert.equal(scopes.body.defaultScopeKey, "mine");
    assert.ok(scopes.body.scopes.some((scope: any) => scope.key === "mine"));
    assert.ok(scopes.body.scopes.some((scope: any) => scope.key === `class:${groupAId}`));
    assert.ok(!scopes.body.scopes.some((scope: any) => scope.key === `class:${groupBId}`));

    const teacherAggregate = await requestJson(
      "GET",
      "/classpilot/student-data?period=today&scope=mine",
      undefined,
      authFor(teacherA, schoolA.id)
    );
    assert.equal(teacherAggregate.status, 200, JSON.stringify(teacherAggregate.body));
    assert.equal(teacherAggregate.body.scope.key, "mine");
    assert.equal(teacherAggregate.body.dataState, "final");
    assert.equal(teacherAggregate.body.students.length, 1);
    assert.equal(teacherAggregate.body.students[0].studentId, teacherAStudent.id);
    assert.equal(teacherAggregate.body.students[0].monitoredSeconds, 20);

    const unauthorizedClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(groupAId)}`,
      undefined,
      authFor(teacherB, schoolA.id)
    );
    assert.equal(unauthorizedClass.status, 404);
    assert.deepEqual(unauthorizedClass.body, {
      error: "Student Data scope not found",
      code: "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND",
    });

    const aggregate = await requestJson(
      "GET",
      "/classpilot/student-data?period=today",
      undefined,
      auth
    );
    assert.equal(aggregate.status, 200, JSON.stringify(aggregate.body));
    assert.equal(aggregate.body.studentsTruncated, false);
    assert.equal(aggregate.body.activitySource, "heartbeats");
    assert.equal(aggregate.body.screenshotsUsedForTimeCalculations, false);
    assert.equal(aggregate.body.scope.key, "school");
    assert.equal(aggregate.body.dataState, "final");
    const studentAggregate = aggregate.body.students.find(
      (student: any) => student.studentId === teacherAStudent.id
    );
    assert.equal(studentAggregate.monitoredSeconds, 20);
    assert.deepEqual(studentAggregate.topDomains, [{ domain: "example.com", seconds: 20 }]);
    assert.doesNotMatch(
      JSON.stringify(aggregate.body),
      /private|token=secret|foreign\.example|deviceId|classpilotPin/i
    );

    const repeated = await requestJson(
      "GET",
      "/classpilot/student-data?period=today",
      undefined,
      auth
    );
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.revision, aggregate.body.revision);
    const compatibilityAlias = await requestJson(
      "GET",
      "/student-data?period=today",
      undefined,
      auth
    );
    assert.equal(compatibilityAlias.status, 200, JSON.stringify(compatibilityAlias.body));
    assert.equal(compatibilityAlias.body.revision, aggregate.body.revision);
    const selected = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&studentId=${teacherAStudent.id}`,
      undefined,
      auth
    );
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    assert.equal(selected.body.student.studentId, teacherAStudent.id);
    assert.equal(selected.body.students.length, 1);
    const foreignTarget = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&studentId=${foreignStudent.id}`,
      undefined,
      auth
    );
    assert.equal(foreignTarget.status, 404);
    assert.deepEqual(foreignTarget.body, {
      error: "Student Data scope not found",
      code: "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND",
    });
  });

  it("enforces immutable teacher authority, report retention, and scheduled live windows", async () => {
    const unrelatedTeacher = await createUser({
      email: `${TAG}-student-data-unrelated@${TAG}-a.example.edu`,
      firstName: "Unrelated",
      lastName: "Teacher",
    });
    const officeUser = await createUser({
      email: `${TAG}-student-data-office@${TAG}-a.example.edu`,
      firstName: "Office",
      lastName: "Only",
    });
    await inSchool(schoolA.id, async () => {
      await createMembership({
        userId: unrelatedTeacher.id,
        schoolId: schoolA.id,
        role: "teacher",
        status: "active",
      });
      await createMembership({
        userId: officeUser.id,
        schoolId: schoolA.id,
        role: "office_staff",
        status: "active",
      });
    });
    const formerStudent = await inSchool(schoolA.id, () => createStudent({
      schoolId: schoolA.id,
      firstName: "Former",
      lastName: "Private",
      email: `former.private@${TAG}-a.example.edu`,
      status: "active",
    }));
    const timeZone = schoolA.schoolTimezone || "America/New_York";
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const priorLocalDate = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Date.now() - 48 * 60 * 60 * 1_000));
    const reassignedGroupId = `${TAG}-student-data-group-reassigned`;
    const expiredGroupId = `${TAG}-student-data-group-expired`;
    const incompleteGroupId = `${TAG}-student-data-group-incomplete`;
    const failedGroupId = `${TAG}-student-data-group-failed`;
    const scheduledPastGroupId = `${TAG}-student-data-group-scheduled-past`;
    const scheduledLiveGroupId = `${TAG}-student-data-group-scheduled-live`;
    const overduePriorGroupId = `${TAG}-student-data-group-overdue-prior`;
    const hardCappedGroupId = `${TAG}-student-data-group-hard-capped`;
    const taughtSessionId = `${TAG}-student-data-session-reassigned-live`;
    const scheduledReportSessionId = `${TAG}-student-data-session-reassigned-scheduled-report`;
    const expiredSessionId = `${TAG}-student-data-session-expired`;
    const incompleteSessionId = `${TAG}-student-data-session-incomplete`;
    const failedSessionId = `${TAG}-student-data-session-failed`;
    const scheduledPastSessionId = `${TAG}-student-data-session-scheduled-past`;
    const scheduledLiveSessionId = `${TAG}-student-data-session-scheduled-live`;
    const overduePriorSessionId = `${TAG}-student-data-session-overdue-prior`;
    const hardCappedSessionId = `${TAG}-student-data-session-hard-capped`;
    const liveSupervisionContextId = `${TAG}-student-data-supervision-live`;
    const deviceA = `${TAG}-student-data-device-a`;
    const deviceB = `${TAG}-student-data-device-b`;
    const deviceC = `${TAG}-student-data-device-c`;

    await asSystem(async () => {
      await db.execute(sql`
        UPDATE students SET status = 'inactive' WHERE id = ${formerStudent.id}
      `);
      await db.execute(sql`
        INSERT INTO groups (
          id, school_id, teacher_id, name, group_type, status, created_at
        ) VALUES
          (${reassignedGroupId}, ${schoolA.id}, ${teacherB.id}, 'Reassigned Current Class', 'admin_class', 'active', now()),
          (${expiredGroupId}, ${schoolA.id}, ${teacherA.id}, 'Expired Private Class', 'admin_class', 'archived', now()),
          (${incompleteGroupId}, ${schoolA.id}, ${teacherA.id}, 'Incomplete Snapshot Class', 'admin_class', 'archived', now()),
          (${failedGroupId}, ${schoolA.id}, ${teacherA.id}, 'Failed Report Class', 'admin_class', 'archived', now()),
          (${scheduledPastGroupId}, ${schoolA.id}, ${teacherA.id}, 'Past Scheduled Class', 'admin_class', 'active', now()),
          (${scheduledLiveGroupId}, ${schoolA.id}, ${teacherA.id}, 'Current Scheduled Class', 'admin_class', 'active', now())
          ,(${overduePriorGroupId}, ${schoolA.id}, ${teacherA.id}, 'Prior Overdue Class', 'admin_class', 'archived', now())
          ,(${hardCappedGroupId}, ${schoolA.id}, ${teacherA.id}, 'Twelve Hour Capped Class', 'admin_class', 'archived', now())
      `);
      await db.execute(sql`
        INSERT INTO group_students (group_id, student_id) VALUES
          (${reassignedGroupId}, ${teacherBStudent.id}),
          (${scheduledPastGroupId}, ${teacherAStudent.id}),
          (${scheduledLiveGroupId}, ${teacherAStudent.id}),
          (${scheduledLiveGroupId}, ${teacherBStudent.id})
      `);
      await db.execute(sql`
        INSERT INTO teaching_sessions (
          id, school_id, group_id, teacher_id, session_mode,
          start_time, end_time, class_name_snapshot, timezone_snapshot,
          roster_snapshot_completed_at, created_at
        ) VALUES
          (
            ${taughtSessionId}, ${schoolA.id}, ${reassignedGroupId}, ${teacherA.id}, 'live',
            now() - interval '3 hours', now(),
            'Frozen Teacher A Class', ${timeZone}, now() - interval '3 hours', now() - interval '3 hours'
          ),
          (
            ${scheduledReportSessionId}, ${schoolA.id}, ${reassignedGroupId}, ${teacherA.id}, 'scheduled_report',
            now() - interval '3 hours', now() - interval '2 hours',
            'Scheduled Report Only', ${timeZone}, now() - interval '3 hours', now() - interval '3 hours'
          ),
          (
            ${expiredSessionId}, ${schoolA.id}, ${expiredGroupId}, ${teacherA.id}, 'live',
            now() - interval '3 hours', now() - interval '2 hours',
            'Frozen Expired Private Class', ${timeZone}, now() - interval '3 hours', now() - interval '3 hours'
          ),
          (
            ${incompleteSessionId}, ${schoolA.id}, ${incompleteGroupId}, ${teacherA.id}, 'live',
            now() - interval '3 hours', now() - interval '2 hours',
            'Frozen Incomplete Class', ${timeZone}, NULL, now() - interval '3 hours'
          ),
          (
            ${failedSessionId}, ${schoolA.id}, ${failedGroupId}, ${teacherA.id}, 'live',
            now() - interval '3 hours', now() - interval '2 hours',
            'Frozen Failed Report Class', ${timeZone}, now() - interval '3 hours', now() - interval '3 hours'
          )
      `);
      await db.execute(sql`
        INSERT INTO teaching_sessions (
          id, school_id, group_id, teacher_id, session_mode,
          scheduled_date, scheduled_timezone, scheduled_start_at, scheduled_end_at,
          scheduled_state, start_time, end_time, class_name_snapshot,
          timezone_snapshot, roster_snapshot_completed_at, created_at
        ) VALUES
          (
            ${scheduledPastSessionId}, ${schoolA.id}, ${scheduledPastGroupId}, ${teacherA.id}, 'live',
            ${localDate}, ${timeZone}, now() - interval '30 minutes', now() - interval '10 minutes',
            'active', now() - interval '30 minutes', NULL, 'Past Scheduled Class',
            ${timeZone}, now() - interval '30 minutes', now() - interval '30 minutes'
          ),
          (
            ${scheduledLiveSessionId}, ${schoolA.id}, ${scheduledLiveGroupId}, ${teacherA.id}, 'live',
            ${localDate}, ${timeZone}, now() - interval '5 minutes', now() + interval '10 minutes',
            'active', now() - interval '5 minutes', NULL, 'Current Scheduled Class',
            ${timeZone}, now() - interval '5 minutes', now() - interval '5 minutes'
          ),
          (
            ${overduePriorSessionId}, ${schoolA.id}, ${overduePriorGroupId}, ${teacherA.id}, 'live',
            ${priorLocalDate}, ${timeZone}, now() - interval '49 hours', now() - interval '48 hours',
            'active', now() - interval '49 hours', NULL, 'Prior Overdue Class',
            ${timeZone}, now() - interval '49 hours', now() - interval '49 hours'
          )
      `);
      await db.execute(sql`
        INSERT INTO teaching_sessions (
          id, school_id, group_id, teacher_id, session_mode,
          start_time, end_time, class_name_snapshot, timezone_snapshot,
          roster_snapshot_completed_at, created_at
        ) VALUES (
          ${hardCappedSessionId}, ${schoolA.id}, ${hardCappedGroupId}, ${teacherA.id}, 'live',
          now() - interval '13 hours', NULL, 'Twelve Hour Capped Class', ${timeZone},
          now() - interval '13 hours', now() - interval '13 hours'
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_staff (
          school_id, teaching_session_id, staff_id, role,
          staff_name_snapshot, staff_email_snapshot, captured_at
        ) VALUES
          (${schoolA.id}, ${taughtSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '3 hours'),
          (${schoolA.id}, ${taughtSessionId}, ${multiSchoolTeacher.id}, 'co_teacher', 'Multi Teacher', ${multiSchoolTeacher.email}, now() - interval '3 hours'),
          (${schoolA.id}, ${scheduledReportSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '3 hours'),
          (${schoolA.id}, ${expiredSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '3 hours'),
          (${schoolA.id}, ${incompleteSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '3 hours'),
          (${schoolA.id}, ${failedSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '3 hours'),
          (${schoolA.id}, ${scheduledPastSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '30 minutes'),
          (${schoolA.id}, ${scheduledLiveSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '5 minutes')
          ,(${schoolA.id}, ${overduePriorSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '49 hours')
          ,(${schoolA.id}, ${hardCappedSessionId}, ${teacherA.id}, 'primary', 'Teacher A', ${teacherA.email}, now() - interval '13 hours')
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_students (
          school_id, teaching_session_id, group_id, student_id,
          student_name_snapshot, captured_at
        ) VALUES
          (${schoolA.id}, ${taughtSessionId}, ${reassignedGroupId}, ${teacherAStudent.id}, 'Assigned Alpha', now() - interval '3 hours'),
          (${schoolA.id}, ${scheduledReportSessionId}, ${reassignedGroupId}, ${teacherAStudent.id}, 'Assigned Alpha', now() - interval '3 hours'),
          (${schoolA.id}, ${expiredSessionId}, ${expiredGroupId}, ${formerStudent.id}, 'Former Private Frozen Name', now() - interval '3 hours'),
          (${schoolA.id}, ${incompleteSessionId}, ${incompleteGroupId}, ${teacherAStudent.id}, 'Assigned Alpha', now() - interval '3 hours'),
          (${schoolA.id}, ${failedSessionId}, ${failedGroupId}, ${teacherAStudent.id}, 'Assigned Alpha', now() - interval '3 hours'),
          (${schoolA.id}, ${scheduledPastSessionId}, ${scheduledPastGroupId}, ${teacherAStudent.id}, 'Assigned Alpha', now() - interval '30 minutes'),
          (${schoolA.id}, ${scheduledLiveSessionId}, ${scheduledLiveGroupId}, ${teacherAStudent.id}, 'Assigned Alpha', now() - interval '5 minutes'),
          (${schoolA.id}, ${scheduledLiveSessionId}, ${scheduledLiveGroupId}, ${teacherBStudent.id}, 'Assigned Beta', now() - interval '5 minutes')
          ,(${schoolA.id}, ${overduePriorSessionId}, ${overduePriorGroupId}, ${formerStudent.id}, 'Prior Frozen Private Name', now() - interval '49 hours')
          ,(${schoolA.id}, ${hardCappedSessionId}, ${hardCappedGroupId}, ${teacherBStudent.id}, 'Assigned Beta', now() - interval '13 hours')
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_reports (
          school_id, teaching_session_id, state, window_start, window_end,
          timezone, authorization_marker, settle_at, next_attempt_at, expires_at
        ) VALUES (
          ${schoolA.id}, ${expiredSessionId}, 'ready',
          now() - interval '3 hours', now() - interval '2 hours', ${timeZone},
          ${JSON.stringify({ version: 1, salt: "0123456789abcdef", digests: [] })}::jsonb,
          now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 minute'
        ), (
          ${schoolA.id}, ${failedSessionId}, 'failed',
          now() - interval '3 hours', now() - interval '2 hours', ${timeZone},
          ${JSON.stringify({ version: 1, salt: "0011223344556677", digests: [] })}::jsonb,
          now() - interval '2 hours', now() + interval '1 minute', now() + interval '30 days'
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_usage (
          school_id, teaching_session_id, group_id, student_id, local_date,
          total_seconds, heartbeat_count, top_domains, computed_at
        ) VALUES
          (${schoolA.id}, ${taughtSessionId}, ${reassignedGroupId}, ${teacherAStudent.id}, ${localDate}, 33, 3, '[]'::jsonb, now()),
          (${schoolA.id}, ${scheduledReportSessionId}, ${reassignedGroupId}, ${teacherAStudent.id}, ${localDate}, 444, 4, '[]'::jsonb, now()),
          (${schoolA.id}, ${expiredSessionId}, ${expiredGroupId}, ${formerStudent.id}, ${localDate}, 777, 7, '[]'::jsonb, now()),
          (${schoolA.id}, ${incompleteSessionId}, ${incompleteGroupId}, ${teacherAStudent.id}, ${localDate}, 888, 8, '[]'::jsonb, now()),
          (${schoolA.id}, ${scheduledLiveSessionId}, ${scheduledLiveGroupId}, ${teacherAStudent.id}, ${localDate}, 7, 1, '[]'::jsonb, now())
      `);
      await db.execute(sql`
        INSERT INTO student_sessions (
          id, student_id, device_id, started_at, last_seen_at, ended_at, is_active, auth_kind
        ) VALUES
          (${`${TAG}-student-data-auth-a`}, ${teacherAStudent.id}, ${deviceA}, now() - interval '40 minutes', now(), now(), false, 'legacy'),
          (${`${TAG}-student-data-auth-b`}, ${teacherBStudent.id}, ${deviceB}, now() - interval '40 minutes', now(), now(), false, 'legacy')
          ,(${`${TAG}-student-data-auth-c`}, ${teacherBStudent.id}, ${deviceC}, now() - interval '14 hours', now(), now(), false, 'legacy')
      `);
      await db.execute(sql`
        INSERT INTO heartbeats (
          device_id, student_id, student_email, school_id,
          active_tab_title, active_tab_url, timestamp
        ) VALUES
          (${deviceA}, ${teacherAStudent.id}, ${teacherAStudent.email}, ${schoolA.id}, 'A1', 'https://a.example', now() - interval '4 minutes'),
          (${deviceA}, ${teacherAStudent.id}, ${teacherAStudent.email}, ${schoolA.id}, 'A2', 'https://a.example', now() - interval '3 minutes 50 seconds'),
          (${deviceA}, ${teacherAStudent.id}, ${teacherAStudent.email}, ${schoolA.id}, 'Before past deadline', 'https://before.example', now() - interval '15 minutes'),
          (${deviceA}, ${teacherAStudent.id}, ${teacherAStudent.email}, ${schoolA.id}, 'Before past deadline 2', 'https://before.example', now() - interval '14 minutes 50 seconds'),
          (${deviceA}, ${teacherAStudent.id}, ${teacherAStudent.email}, ${schoolA.id}, 'Past deadline', 'https://late.example', now() - interval '5 minutes'),
          (${deviceB}, ${teacherBStudent.id}, ${teacherBStudent.email}, ${schoolA.id}, 'B1', 'https://b.example', now() - interval '4 minutes'),
          (${deviceB}, ${teacherBStudent.id}, ${teacherBStudent.email}, ${schoolA.id}, 'B2', 'https://b.example', now() - interval '3 minutes 50 seconds'),
          (${deviceB}, ${teacherBStudent.id}, ${teacherBStudent.email}, ${schoolA.id}, 'B3', 'https://b.example', now() - interval '3 minutes 40 seconds')
          ,(${deviceC}, ${teacherBStudent.id}, ${teacherBStudent.email}, ${schoolA.id}, 'Before hard cap 1', 'https://before-hardcap.example', now() - interval '2 hours')
          ,(${deviceC}, ${teacherBStudent.id}, ${teacherBStudent.email}, ${schoolA.id}, 'Before hard cap 2', 'https://before-hardcap.example', now() - interval '1 hour 50 minutes')
          ,(${deviceC}, ${teacherBStudent.id}, ${teacherBStudent.email}, ${schoolA.id}, 'After hard cap', 'https://after-hardcap.example', now() - interval '30 minutes')
      `);
    });

    const teacherAAuth = authFor(teacherA, schoolA.id);
    const teacherBAuth = authFor(teacherB, schoolA.id);
    const coTeacherAuth = authFor(multiSchoolTeacher, schoolA.id);
    const unrelatedAuth = authFor(unrelatedTeacher, schoolA.id);
    const teacherAScopes = await requestJson(
      "GET",
      "/classpilot/student-data/scopes",
      undefined,
      teacherAAuth
    );
    assert.equal(teacherAScopes.status, 200, JSON.stringify(teacherAScopes.body));
    const scopeRows: Array<{
      key: string;
      isActive: boolean;
      activeTeachingSessionId: string | null;
    }> = teacherAScopes.body.scopes;
    const scopesByKey = new Map(
      scopeRows.map((scope) => [scope.key, scope] as const)
    );
    assert.ok(scopesByKey.has(`class:${reassignedGroupId}`), "former teacher keeps the taught frozen class");
    assert.ok(!scopesByKey.has(`class:${expiredGroupId}`), "expired report must not expose its frozen class label");
    assert.ok(!scopesByKey.has(`class:${incompleteGroupId}`), "incomplete frozen roster must not create a zombie scope");
    assert.ok(scopesByKey.has(`class:${failedGroupId}`), "retryable retained report remains an explicit scope");
    assert.equal(scopesByKey.get(`class:${scheduledPastGroupId}`)?.isActive, false);
    assert.equal(scopesByKey.get(`class:${scheduledPastGroupId}`)?.activeTeachingSessionId, null);
    assert.equal(scopesByKey.get(`class:${scheduledLiveGroupId}`)?.isActive, true);
    assert.equal(
      scopesByKey.get(`class:${scheduledLiveGroupId}`)?.activeTeachingSessionId,
      scheduledLiveSessionId
    );
    assert.equal(teacherAScopes.body.defaultScopeKey, `class:${scheduledLiveGroupId}`);
    assert.equal(scopesByKey.get(`class:${overduePriorGroupId}`)?.isActive, false);
    assert.equal(scopesByKey.get(`class:${hardCappedGroupId}`)?.isActive, false);

    const priorToday = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(overduePriorGroupId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(priorToday.status, 200, JSON.stringify(priorToday.body));
    assert.deepEqual(priorToday.body.students, []);
    const priorStudentSelector = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(overduePriorGroupId)}&studentId=${encodeURIComponent(formerStudent.id)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(priorStudentSelector.status, 404);
    assert.equal(priorStudentSelector.body.code, "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND");

    const hardCappedSession = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(hardCappedSessionId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(hardCappedSession.status, 200, JSON.stringify(hardCappedSession.body));
    assert.equal(hardCappedSession.body.dataState, "finalizing");
    assert.ok(hardCappedSession.body.students[0].monitoredSeconds > 0);
    assert.ok(
      !(hardCappedSession.body.students[0].topDomains || []).some(
        (domain: any) => domain.domain === "after-hardcap.example"
      ),
      "the absolute twelve-hour authority cap excludes later heartbeats"
    );

    const formerTeacherClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(reassignedGroupId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(formerTeacherClass.status, 200, JSON.stringify(formerTeacherClass.body));
    assert.deepEqual(
      formerTeacherClass.body.students.map((student: any) => [student.studentId, student.monitoredSeconds]),
      [[teacherAStudent.id, 33]],
      "only the immutable live session is counted; scheduled_report rows never grant authority"
    );
    const coTeacherClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(reassignedGroupId)}`,
      undefined,
      coTeacherAuth
    );
    assert.equal(coTeacherClass.status, 200, JSON.stringify(coTeacherClass.body));
    assert.equal(coTeacherClass.body.students[0].monitoredSeconds, 33);

    const currentTeacherClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(reassignedGroupId)}`,
      undefined,
      teacherBAuth
    );
    assert.equal(currentTeacherClass.status, 200, JSON.stringify(currentTeacherClass.body));
    assert.deepEqual(
      currentTeacherClass.body.students.map((student: any) => [student.studentId, student.monitoredSeconds]),
      [[teacherBStudent.id, 0]],
      "a new teacher gets the current roster but never inherits the former teacher's history"
    );
    const unrelatedClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(reassignedGroupId)}`,
      undefined,
      unrelatedAuth
    );
    assert.equal(unrelatedClass.status, 404);
    assert.equal(unrelatedClass.body.code, "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND");

    for (const officePath of [
      "/classpilot/student-data/scopes",
      "/classpilot/student-data?period=today",
    ]) {
      const denied = await requestJson("GET", officePath, undefined, authFor(officeUser, schoolA.id));
      assert.equal(denied.status, 403, `${officePath} is unavailable to office-only staff`);
    }
    const pollutedScope = await requestJson(
      "GET",
      "/classpilot/student-data?period=today&scope=mine&scope=class",
      undefined,
      teacherAAuth
    );
    assert.equal(pollutedScope.status, 400);
    const conflictingSelectors = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(taughtSessionId)}&scope=class&groupId=${encodeURIComponent(reassignedGroupId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(conflictingSelectors.status, 400);

    for (const hiddenSessionId of [
      scheduledReportSessionId,
      expiredSessionId,
      incompleteSessionId,
    ]) {
      const hidden = await requestJson(
        "GET",
        `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(hiddenSessionId)}`,
        undefined,
        teacherAAuth
      );
      assert.equal(hidden.status, 404, `${hiddenSessionId} must use neutral not-found authority`);
      assert.deepEqual(hidden.body, {
        error: "Student Data scope not found",
        code: "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND",
      });
    }

    const expiredAdminSession = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(expiredSessionId)}`,
      undefined,
      authFor(adminUser, schoolA.id)
    );
    assert.equal(expiredAdminSession.status, 404);
    assert.equal(expiredAdminSession.body.code, "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND");

    const failedReport = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(failedSessionId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(failedReport.status, 503, JSON.stringify(failedReport.body));
    assert.equal(failedReport.body.code, "CLASSPILOT_STUDENT_DATA_UNAVAILABLE");

    const schoolAggregate = await requestJson(
      "GET",
      "/classpilot/student-data?period=today&scope=school",
      undefined,
      authFor(adminUser, schoolA.id)
    );
    assert.equal(schoolAggregate.status, 200, JSON.stringify(schoolAggregate.body));
    assert.ok(
      !schoolAggregate.body.students.some((student: any) => student.studentId === formerStudent.id),
      "an expired report cannot disclose a physically retained frozen student name"
    );
    const schoolTeacherA = schoolAggregate.body.students.find(
      (student: any) => student.studentId === teacherAStudent.id
    );
    // Admin reporting counts the unattended scheduled block (+444). A
    // scheduled_report occurrence is finalized and carries a ready report and
    // real heartbeat-derived usage; only the teacher's console was absent.
    // Excluding it hid genuine monitoring data from the school's own record --
    // an empty class screen for students who were demonstrably on their
    // devices. Teacher-scoped reads stay live-only, which the retained-teacher
    // authority assertion above pins.
    //
    // The incomplete row (888) is still excluded, and that half of the original
    // contract is unchanged: it has no completed roster snapshot, so it is not
    // reportable for anyone.
    assert.ok(
      schoolTeacherA.monitoredSeconds === 484 || schoolTeacherA.monitoredSeconds === 504,
      `retained live rows (40/60) plus the unattended scheduled block (444) are counted, `
        + `and the incomplete row (888) is not; got ${schoolTeacherA.monitoredSeconds}`
    );

    const liveClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(scheduledLiveGroupId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(liveClass.status, 200, JSON.stringify(liveClass.body));
    assert.equal(liveClass.body.dataState, "live");
    assert.ok(liveClass.body.provisionalAsOf);
    const liveA = liveClass.body.students.find((student: any) => student.studentId === teacherAStudent.id);
    const liveB = liveClass.body.students.find((student: any) => student.studentId === teacherBStudent.id);
    assert.equal(liveA.monitoredSeconds, 7, "stored final key wins over provisional materialization");
    assert.ok(liveB.monitoredSeconds > 0, "unfinalized frozen student receives read-only live materialization");

    await asSystem(async () => {
      await db.execute(sql`
        INSERT INTO classpilot_supervision_contexts (
          id, school_id, context_type, name, status, assigned_staff_id,
          created_by, starts_at, ends_at, ended_at
        ) VALUES (
          ${liveSupervisionContextId}, ${schoolA.id}, 'manual',
          'Student Data cache supervision fence', 'ended', ${teacherB.id},
          ${teacherA.id}, now() - interval '4 minutes 5 seconds',
          now() - interval '3 minutes 35 seconds',
          now() - interval '3 minutes 35 seconds'
        )
      `);
      await db.execute(sql`
        INSERT INTO classpilot_supervision_students (
          school_id, context_id, student_id, source, assigned_by,
          assigned_at, released_at, release_reason
        ) VALUES (
          ${schoolA.id}, ${liveSupervisionContextId}, ${teacherBStudent.id},
          'manual', ${teacherA.id}, now() - interval '4 minutes 5 seconds',
          now() - interval '3 minutes 35 seconds', 'test_completed'
        )
      `);
    });
    const supervisedLiveClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(scheduledLiveGroupId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(supervisedLiveClass.status, 200, JSON.stringify(supervisedLiveClass.body));
    const supervisedLiveB = supervisedLiveClass.body.students.find(
      (student: any) => student.studentId === teacherBStudent.id
    );
    assert.equal(supervisedLiveClass.body.dataState, "live");
    assert.ok(
      supervisedLiveB.monitoredSeconds < liveB.monitoredSeconds,
      "delegated supervision removes the overlapping provisional class interval"
    );
    assert.notEqual(
      supervisedLiveClass.body.revision,
      liveClass.body.revision,
      "a changed supervision context must fence a warm provisional cache entry"
    );

    const pastClass = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&scope=class&groupId=${encodeURIComponent(scheduledPastGroupId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(pastClass.status, 200, JSON.stringify(pastClass.body));
    assert.equal(pastClass.body.dataState, "finalizing");
    const cappedPastSeconds = pastClass.body.students[0].monitoredSeconds;
    assert.ok(cappedPastSeconds > 0, "pre-deadline activity survives scheduler lag");
    assert.ok(
      !(pastClass.body.students[0].topDomains || []).some((domain: any) => domain.domain === "late.example"),
      "the half-open scheduled deadline excludes later heartbeats"
    );
    const pastSessionDuringLag = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(scheduledPastSessionId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(pastSessionDuringLag.status, 200, JSON.stringify(pastSessionDuringLag.body));
    assert.equal(pastSessionDuringLag.body.dataState, "finalizing");
    assert.equal(pastSessionDuringLag.body.students[0].monitoredSeconds, cappedPastSeconds);

    await asSystem(async () => {
      await db.execute(sql`
        UPDATE teaching_sessions
        SET end_time = scheduled_end_at, scheduled_state = 'finalized'
        WHERE id = ${scheduledPastSessionId}
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_reports (
          school_id, teaching_session_id, state, window_start, window_end,
          timezone, authorization_marker, tracking_policy,
          settle_at, next_attempt_at, expires_at
        )
        SELECT
          school_id, id, 'pending', start_time, end_time, ${timeZone},
          ${JSON.stringify({ version: 1, salt: "fedcba9876543210", digests: [] })}::jsonb,
          ${JSON.stringify({
            enableTrackingHours: false,
            trackingStartTime: null,
            trackingEndTime: null,
            trackingDays: [],
            schoolTimezone: timeZone,
            afterHoursMode: "off",
          })}::jsonb,
          now(), now(), now() + interval '30 days'
        FROM teaching_sessions WHERE id = ${scheduledPastSessionId}
      `);
    });
    const pendingPast = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(scheduledPastSessionId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(pendingPast.status, 200, JSON.stringify(pendingPast.body));
    assert.equal(pendingPast.body.dataState, "finalizing");
    assert.equal(pendingPast.body.students[0].monitoredSeconds, cappedPastSeconds);

    await asSystem(async () => {
      await db.execute(sql`
        UPDATE classpilot_session_reports
        SET state = 'ready', materialized_at = now(), updated_at = now()
        WHERE teaching_session_id = ${scheduledPastSessionId}
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_usage (
          school_id, teaching_session_id, group_id, student_id, local_date,
          total_seconds, heartbeat_count, top_domains, computed_at
        ) VALUES (
          ${schoolA.id}, ${scheduledPastSessionId}, ${scheduledPastGroupId},
          ${teacherAStudent.id}, ${localDate}, ${cappedPastSeconds}, 1,
          '[]'::jsonb, now()
        )
      `);
    });
    const finalizedPast = await requestJson(
      "GET",
      `/classpilot/student-data?period=today&sessionId=${encodeURIComponent(scheduledPastSessionId)}`,
      undefined,
      teacherAAuth
    );
    assert.equal(finalizedPast.status, 200, JSON.stringify(finalizedPast.body));
    assert.equal(finalizedPast.body.dataState, "final");
    assert.equal(finalizedPast.body.students[0].monitoredSeconds, cappedPastSeconds);
  });

  it("denies the device aggregate to a GoPilot-only retained parent while preserving dual-product base-admin access", async () => {
    const suffix = `${TAG}-aggregate-gate`;
    const gopilotOnlySchool = await createSchool({
      name: suffix,
      domain: `${suffix}.example.edu`,
      slug: suffix,
      status: "active",
    } as any);
    const retainedParent = await createUser({
      email: `${suffix}@${suffix}.example.edu`,
      firstName: "Retained",
      lastName: "Parent",
    } as any);
    const dualProductParent = await createUser({
      email: `${suffix}@${schoolA.domain}`,
      firstName: "Dual Product",
      lastName: "Parent",
    } as any);
    const baseParent = await createUser({
      email: `${suffix}-base-parent@${schoolA.domain}`,
      firstName: "Historical",
      lastName: "Base Parent",
    } as any);
    try {
      await asSystem(async () => {
        await createProductLicense({ schoolId: gopilotOnlySchool.id, product: "GOPILOT", status: "active" } as any);
        await createMembership({
          userId: retainedParent.id,
          schoolId: gopilotOnlySchool.id,
          role: "admin",
          gopilotRole: "parent",
          status: "active",
        } as any);
      });

      const denied = await requestJson(
        "GET",
        "/students-aggregated",
        undefined,
        authFor(retainedParent, gopilotOnlySchool.id)
      );
      assert.equal(denied.status, 403);
      assert.doesNotMatch(JSON.stringify(denied.body), /deviceId|device_id/i);

      const retainedMembership = await asSystem(() =>
        getMembershipByUserAndSchool(retainedParent.id, gopilotOnlySchool.id)
      );
      assert.ok(retainedMembership?.id);
      const directDenials = [
        await requestJson("GET", "/users/staff", undefined, {
          ...authFor(retainedParent, gopilotOnlySchool.id),
          "x-gopilot-setup": "true",
        }),
        await requestJson("POST", "/users/staff", {}, authFor(retainedParent, gopilotOnlySchool.id)),
        await requestJson("PUT", `/users/staff/${retainedMembership.id}`, { role: "teacher" }, authFor(retainedParent, gopilotOnlySchool.id)),
        await requestJson("DELETE", `/users/staff/${retainedMembership.id}`, undefined, authFor(retainedParent, gopilotOnlySchool.id)),
        await requestJson("GET", "/users/members", undefined, authFor(retainedParent, gopilotOnlySchool.id)),
        await requestJson("GET", "/users/teachers", undefined, authFor(retainedParent, gopilotOnlySchool.id)),
        await requestJson("GET", "/google/directory/users", undefined, authFor(retainedParent, gopilotOnlySchool.id)),
      ];
      for (const response of directDenials) {
        assert.equal(response.status, 410, JSON.stringify(response.body));
        assert.equal(response.body.code, "GOPILOT_PARENT_PORTAL_DISABLED");
      }
      const membershipAfter = await asSystem(() =>
        getMembershipByUserAndSchool(retainedParent.id, gopilotOnlySchool.id)
      );
      assert.equal(membershipAfter?.status, "active", "denied direct mutations must not change historical membership data");

      const classPilotAllowed = await requestJson(
        "GET",
        "/students-aggregated",
        undefined,
        authFor(adminUser, schoolA.id)
      );
      assert.equal(classPilotAllowed.status, 200);
      assert.ok(Array.isArray(classPilotAllowed.body));

      const dualProductMembership = await asSystem(() =>
        createMembership({
          userId: dualProductParent.id,
          schoolId: schoolA.id,
          role: "admin",
          gopilotRole: "parent",
          status: "active",
        } as any)
      );
      await asSystem(() =>
        createMembership({
          userId: baseParent.id,
          schoolId: schoolA.id,
          role: "parent",
          gopilotRole: "parent",
          status: "active",
        } as any)
      );
      const classPilotParentDenials = [
        await requestJson("GET", "/classpilot/students", undefined, authFor(baseParent, schoolA.id)),
        await requestJson(
          "GET",
          `/classpilot/student-analytics/${teacherAStudent.id}`,
          undefined,
          authFor(baseParent, schoolA.id)
        ),
        await requestJson(
          "POST",
          "/classpilot/checkin/request",
          { question: "Unauthorized broadcast" },
          authFor(baseParent, schoolA.id)
        ),
        await requestJson(
          "POST",
          "/classpilot/groups",
          { name: "Unauthorized class" },
          authFor(baseParent, schoolA.id)
        ),
      ];
      for (const response of classPilotParentDenials) {
        assert.equal(response.status, 403, JSON.stringify(response.body));
        assert.doesNotMatch(JSON.stringify(response.body), /Assigned Alpha|device|heartbeat/i);
      }
      const selfPromotion = await requestJson(
        "PUT",
        `/users/staff/${dualProductMembership.id}`,
        { gopilotRole: "office_staff" },
        authFor(dualProductParent, schoolA.id)
      );
      assert.equal(selfPromotion.status, 400, JSON.stringify(selfPromotion.body));
      assert.equal(selfPromotion.body.code, "GOPILOT_ROLE_CONTEXT_REQUIRED");

      const crossProductCreate = await requestJson(
        "POST",
        "/users/staff",
        {
          email: `${suffix}-new@${schoolA.domain}`,
          firstName: "Blocked",
          lastName: "Promotion",
          role: "teacher",
          gopilotRole: "teacher",
        },
        authFor(dualProductParent, schoolA.id)
      );
      assert.equal(crossProductCreate.status, 400, JSON.stringify(crossProductCreate.body));
      assert.equal(crossProductCreate.body.code, "GOPILOT_ROLE_CONTEXT_REQUIRED");

      const dualProductMembershipAfter = await asSystem(() =>
        getMembershipByUserAndSchool(dualProductParent.id, schoolA.id)
      );
      assert.equal(dualProductMembershipAfter?.gopilotRole, "parent");
    } finally {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM school_memberships WHERE user_id = ${retainedParent.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE user_id = ${dualProductParent.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE user_id = ${baseParent.id}`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${gopilotOnlySchool.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${gopilotOnlySchool.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${retainedParent.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${dualProductParent.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${baseParent.id}`);
      });
    }
  });

  it("legacy register-student succeeds for an exact roster email in an active ClassPilot school", async () => {
    const response = await registerStudent({
      deviceId: `${TAG}-exact-device`,
      studentEmail: `exact@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.student.email, `exact@${TAG}-a.example.edu`);
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
    assert.equal(pinConfig.body.schoolId, schoolA.id);
    assert.equal(pinConfig.body.passpilotKioskAvailable, false);

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

  it("extension login-config reports PassPilot kiosk availability only when the kiosk would work", async () => {
    await inSchool(schoolA.id, () =>
      upsertSettings(schoolA.id, {
        enrollmentKey: schoolAEnrollmentKey,
        enrollmentKeyRequired: true,
        sharedChromebookSignInEnabled: true,
      } as any)
    );

    const fetchConfig = () =>
      requestJson(
        "GET",
        `/classpilot/extension/login-config?schoolSlug=${schoolA.slug}`,
        undefined,
        { "x-classpilot-enrollment-key": schoolAEnrollmentKey }
      );

    // schoolA has no PASSPILOT license (Super Admin toggle off) → no kiosk launch.
    const withoutLicense = await fetchConfig();
    assert.equal(withoutLicense.status, 200);
    assert.equal(withoutLicense.body.schoolId, schoolA.id);
    assert.equal(withoutLicense.body.passpilotKioskAvailable, false);

    try {
      await createProductLicense({ schoolId: schoolA.id, product: "PASSPILOT", status: "active" } as any);

      // License alone is not enough — the kiosk must be enabled with a PIN set.
      const licenseOnly = await fetchConfig();
      assert.equal(licenseOnly.status, 200);
      assert.equal(licenseOnly.body.passpilotKioskAvailable, false);

      await asSystem(async () => {
        await db.execute(
          sql`UPDATE schools SET kiosk_enabled = true, kiosk_pin_hash = 'test-hash' WHERE id = ${schoolA.id}`
        );
      });
      const available = await fetchConfig();
      assert.equal(available.status, 200);
      assert.equal(available.body.passpilotKioskAvailable, true);
    } finally {
      await asSystem(async () => {
        await db.execute(
          sql`DELETE FROM product_licenses WHERE school_id = ${schoolA.id} AND product = 'PASSPILOT'`
        );
        await db.execute(
          sql`UPDATE schools SET kiosk_enabled = false, kiosk_pin_hash = NULL WHERE id = ${schoolA.id}`
        );
      });
    }
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
    assert.equal(response.body.student.email, `auto@${TAG}-a.example.edu`);
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

    const assignedStudents = await requestJson("GET", "/gopilot/students", undefined, auth);
    assert.equal(assignedStudents.status, 200);
    const assignedIds = new Set((assignedStudents.body.students || []).map((s: any) => s.id));
    assert.ok(assignedIds.has(teacherAStudent.id));
    assert.ok(!assignedIds.has(teacherBStudent.id));

    const foreignHomeroomStudents = await requestJson("GET", `/gopilot/students?homeroomId=${homeroomB.id}`, undefined, auth);
    assert.equal(foreignHomeroomStudents.status, 403);

    const ownStudent = await requestJson("GET", `/gopilot/students/${teacherAStudent.id}`, undefined, auth);
    assert.equal(ownStudent.status, 200);
    assert.equal(ownStudent.body.student.id, teacherAStudent.id);

    const foreignStudent = await requestJson("GET", `/gopilot/students/${teacherBStudent.id}`, undefined, auth);
    assert.equal(foreignStudent.status, 404);

    const foreignUpdate = await requestJson(
      "PATCH",
      `/gopilot/students/${teacherBStudent.id}`,
      { firstName: "Changed" },
      auth
    );
    assert.equal(foreignUpdate.status, 403);
  });

  it("ClassPilot timeline returns a narrow student identity DTO", async () => {
    await inSchool(schoolA.id, () =>
      db.execute(sql`
        UPDATE students SET
          google_user_id = 'sensitive-google-id',
          student_code = '1234',
          external_id = 'sensitive-sis-id',
          classpilot_pin_hash = 'sensitive-pin-hash',
          classpilot_pin_encrypted = 'sensitive-pin-ciphertext',
          device_id = 'sensitive-device-id'
        WHERE id = ${teacherAStudent.id}
      `)
    );
    const response = await requestJson(
      "GET",
      `/classpilot/students/${teacherAStudent.id}/timeline`,
      undefined,
      authFor(adminUser, schoolA.id)
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.student.id, teacherAStudent.id);
    assert.deepEqual(
      Object.keys(response.body.student).sort(),
      ["email", "firstName", "gradeLevel", "id", "lastName", "photoUrl", "status"]
    );
    for (const forbidden of [
      "googleUserId",
      "studentCode",
      "externalId",
      "classpilotPinHash",
      "classpilotPinEncrypted",
      "deviceId",
    ]) {
      assert.equal(forbidden in response.body.student, false, forbidden);
    }
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
    assert.equal(
      duplicateIdentity?.capabilities.parentStudentAccess,
      true,
      "authorization must honor every active role, not only the display primary role"
    );
  });

  it("GoPilot staff setup writes sanitized create, update, and removal audits", async () => {
    const email = `${TAG}-audited-staff@${TAG}-a.example.edu`;
    const auth = authFor(adminUser, schoolA.id);
    const created = await requestJson(
      "POST",
      `/schools/${schoolA.id}/staff`,
      { email, firstName: "Audit", lastName: "Staff", role: "teacher", gopilotRole: "teacher" },
      auth
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const membershipId = created.body.membership.id;
    assert.ok(membershipId);

    const updated = await requestJson(
      "PUT",
      `/schools/${schoolA.id}/staff/${membershipId}`,
      { role: "teacher", gopilotRole: "office_staff" },
      auth
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const removed = await requestJson(
      "DELETE",
      `/schools/${schoolA.id}/staff/${membershipId}`,
      undefined,
      auth
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const auditResult = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT action, entity_id, changes, metadata
      FROM audit_logs
      WHERE school_id = ${schoolA.id}
        AND entity_id = ${membershipId}
        AND action IN ('gopilot.staff.created', 'gopilot.staff.updated', 'gopilot.staff.removed')
      ORDER BY created_at
    `));
    assert.deepEqual(auditResult.rows.map((row: any) => row.action), [
      "gopilot.staff.created",
      "gopilot.staff.updated",
      "gopilot.staff.removed",
    ]);
    const serialized = JSON.stringify(auditResult.rows);
    assert.doesNotMatch(serialized, new RegExp(email, "i"));
    assert.doesNotMatch(serialized, /password/i);
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

    const read = await requestJson("GET", `/attendance?date=${date}&productContext=gopilot`, undefined, teacherAuth);
    assert.equal(read.status, 200);
    const visibleIds = new Set((read.body.records || []).map((record: any) => record.studentId));
    assert.ok(visibleIds.has(teacherAStudent.id));
    assert.ok(!visibleIds.has(teacherBStudent.id));

    const foreignWrite = await requestJson(
      "POST",
      "/attendance",
      { studentIds: [teacherBStudent.id], date: "2099-01-03", status: "tardy", productContext: "gopilot" },
      teacherAuth
    );
    assert.equal(foreignWrite.status, 403);

    const ownWrite = await requestJson(
      "POST",
      "/attendance",
      { studentIds: [teacherAStudent.id], date: "2099-01-03", status: "tardy", productContext: "gopilot" },
      teacherAuth
    );
    assert.equal(ownWrite.status, 201);

    const foreignRecord = (seed.body.records || []).find((record: any) => record.studentId === teacherBStudent.id);
    assert.ok(foreignRecord?.id);
    const foreignDelete = await requestJson(
      "DELETE",
      `/attendance/${foreignRecord.id}?productContext=gopilot`,
      undefined,
      teacherAuth
    );
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

    const resume = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "active" }, adminAuth);
    assert.equal(resume.status, 200);

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

    const initialStart = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "active" }, adminAuth);
    assert.equal(initialStart.status, 200);

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
    assert.equal(checkIn.body.entries[0].pickupGroupId, `family:${family.id}`);
    const queueId = checkIn.body.entries[0].queueId;

    const duplicate = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in-by-number`,
      { carNumber: family.carNumber },
      adminAuth
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.outcome, "duplicate");

    const busOverrideMissingRoute = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/override`,
      { studentId: carStudent.id, overrideType: "bus" },
      teacherAuth
    );
    assert.equal(busOverrideMissingRoute.status, 403);
    const busOverride = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/override`,
      { studentId: carStudent.id, overrideType: "bus", busRoute: `${TAG}-ROUTE-9` },
      adminAuth
    );
    assert.equal(busOverride.status, 201);
    assert.equal(busOverride.body.override.busRoute, `${TAG}-ROUTE-9`);

    const pauseBeforeActions = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "paused" }, adminAuth);
    assert.equal(pauseBeforeActions.status, 200);

    const pendingCall = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/call`,
      { queueId, zone: "A" },
      adminAuth
    );
    assert.equal(pendingCall.status, 409);
    const pendingBatchRelease = await requestJson("POST", "/queue/release-batch", { queueIds: [queueId] }, teacherAuth);
    assert.equal(pendingBatchRelease.status, 409);
    const pendingWalkerRelease = await requestJson("POST", `/gopilot/dismissal/sessions/${sessionId}/release-walkers`, undefined, adminAuth);
    assert.equal(pendingWalkerRelease.status, 409);
    const pendingOverride = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/override`,
      { studentId: carStudent.id, overrideType: "walker" },
      teacherAuth
    );
    assert.equal(pendingOverride.status, 403);

    const earlyRelease = await requestJson("POST", `/queue/${queueId}/release`, undefined, teacherAuth);
    assert.equal(earlyRelease.status, 409);
    const earlyPickup = await requestJson("POST", `/queue/${queueId}/dismiss`, undefined, adminAuth);
    assert.equal(earlyPickup.status, 409);

    const hold = await requestJson("POST", `/queue/${queueId}/hold`, { reason: "Waiting for ID" }, adminAuth);
    assert.equal(hold.status, 409);

    const start = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "active" }, adminAuth);
    assert.equal(start.status, 200);
    assert.equal(start.body.session.status, "active");
    const activeHold = await requestJson("POST", `/queue/${queueId}/hold`, { reason: "Waiting for ID" }, adminAuth);
    assert.equal(activeHold.status, 200);
    assert.equal(activeHold.body.entry.status, "held");

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
    assert.equal(recallDelayed.status, 409);
    await inSchool(schoolA.id, () =>
      db.execute(sql`UPDATE dismissal_queue SET delayed_until = NOW() - INTERVAL '1 second' WHERE id = ${queueId}`)
    );
    const recallExpiredDelay = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/call`,
      { queueId, zone: "B" },
      adminAuth
    );
    assert.equal(recallExpiredDelay.status, 200);
    assert.equal(recallExpiredDelay.body.entry.status, "called");
    assert.equal(recallExpiredDelay.body.entry.delayedUntil, null);

    const pause = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "paused" }, adminAuth);
    assert.equal(pause.status, 200);
    const pausedRelease = await requestJson("POST", `/queue/${queueId}/release`, undefined, teacherAuth);
    assert.equal(pausedRelease.status, 409);
    const pausedOverride = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/override`,
      { studentId: carStudent.id, overrideType: "walker" },
      teacherAuth
    );
    assert.equal(pausedOverride.status, 403);
    const resume = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "active" }, adminAuth);
    assert.equal(resume.status, 200);

    const release = await requestJson("POST", `/queue/${queueId}/release`, undefined, teacherAuth);
    assert.equal(release.status, 200);
    assert.equal(release.body.entry.status, "released");

    const pickup = await requestJson("POST", `/queue/${queueId}/dismiss`, undefined, adminAuth);
    assert.equal(pickup.status, 200);
    assert.equal(pickup.body.entry.status, "dismissed");
  });

  it("GoPilot getOrCreateSession does not reset completed sessions or delete queue history", async () => {
    const date = `2099-02-${String(10 + Math.floor(Math.random() * 10)).padStart(2, "0")}`;
    const session = await inSchool(schoolA.id, () => getOrCreateSession(schoolA.id, date));
    const entry = await inSchool(schoolA.id, () =>
      addToQueue({
        sessionId: session.id,
        studentId: teacherAStudent.id,
        guardianName: "History Guardian",
        pickupGroupId: "test-history-group",
        pickupGroupLabel: "History Guardian",
        checkInMethod: "car_number",
        status: "dismissed",
        dismissedAt: new Date(),
        position: 1,
      } as any)
    );

    await db.execute(sql`UPDATE dismissal_sessions SET status = 'completed', ended_at = NOW() WHERE id = ${session.id}`);
    const again = await inSchool(schoolA.id, () => getOrCreateSession(schoolA.id, date));
    const queue = await inSchool(schoolA.id, () => getQueueBySession(session.id));

    assert.equal(again.id, session.id);
    assert.equal(again.status, "completed");
    assert.ok(queue.some((item: any) => item.id === entry.id));
  });

  it("GoPilot office pickup uses stable groups and custody acknowledgement", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const sessionRes = await requestJson("POST", "/gopilot/dismissal/sessions", undefined, adminAuth);
    assert.equal(sessionRes.status, 200);
    const sessionId = sessionRes.body.session.id;
    const start = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "active" }, adminAuth);
    assert.equal(start.status, 200);

    const studentOne = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Shared",
        lastName: "One",
        email: `shared.one@${TAG}-a.example.edu`,
        homeroomId: homeroomA.id,
        dismissalType: "car",
        status: "active",
      } as any)
    );
    const studentTwo = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Shared",
        lastName: "Two",
        email: `shared.two@${TAG}-a.example.edu`,
        homeroomId: homeroomA.id,
        dismissalType: "car",
        status: "active",
      } as any)
    );
    const parentOne = await createUser({
      email: `${TAG}-same-guardian-1@${TAG}-a.example.edu`,
      firstName: "Same",
      lastName: "Guardian",
    } as any);
    const parentTwo = await createUser({
      email: `${TAG}-same-guardian-2@${TAG}-a.example.edu`,
      firstName: "Same",
      lastName: "Guardian",
    } as any);
    await inSchool(schoolA.id, () =>
      createMembership({ userId: parentOne.id, schoolId: schoolA.id, role: "parent", status: "active" } as any)
    );
    await inSchool(schoolA.id, () =>
      createMembership({ userId: parentTwo.id, schoolId: schoolA.id, role: "parent", status: "active" } as any)
    );
    await inSchool(schoolA.id, () =>
      createParentStudentLink({
        parentId: parentOne.id,
        studentId: studentOne.id,
        schoolId: schoolA.id,
        relationship: "guardian",
        isPrimary: true,
        status: "approved",
      } as any)
    );
    await inSchool(schoolA.id, () =>
      createParentStudentLink({
        parentId: parentTwo.id,
        studentId: studentTwo.id,
        schoolId: schoolA.id,
        relationship: "guardian",
        isPrimary: true,
        status: "approved",
      } as any)
    );
    await inSchool(schoolA.id, () =>
      createCustodyAlert({
        studentId: studentTwo.id,
        personName: "Restricted Adult",
        alertType: "custody_restriction",
        notes: "Must confirm identity",
        createdBy: adminUser.id,
        active: true,
      } as any)
    );

    const queueBeforeParentAttempts = await inSchool(schoolA.id, () => getQueueBySession(sessionId));
    const checkInOne = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in`,
      undefined,
      authFor(parentOne, schoolA.id)
    );
    const checkInTwo = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in`,
      undefined,
      authFor(parentTwo, schoolA.id)
    );
    assert.equal(checkInOne.status, 410);
    assert.equal(checkInTwo.status, 410);
    assert.equal(checkInOne.body.code, "GOPILOT_PARENT_PORTAL_DISABLED");
    assert.deepEqual(checkInTwo.body, checkInOne.body);
    const queueAfterParentAttempts = await inSchool(schoolA.id, () => getQueueBySession(sessionId));
    assert.equal(
      queueAfterParentAttempts.length,
      queueBeforeParentAttempts.length,
      "disabled parent calls must not mutate the queue"
    );

    const arrivalOne = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/arrivals`,
      { source: "staff_search", studentIds: [studentOne.id] },
      adminAuth
    );
    const arrivalTwo = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/arrivals`,
      { source: "staff_search", studentIds: [studentTwo.id] },
      adminAuth
    );
    assert.equal(arrivalOne.status, 200);
    assert.equal(arrivalTwo.status, 200);
    assert.notEqual(arrivalOne.body.entries[0].pickupGroupId, arrivalTwo.body.entries[0].pickupGroupId);

    const queueOne = arrivalOne.body.entries[0].queueId;
    const queueTwo = arrivalTwo.body.entries[0].queueId;
    for (const queueId of [queueOne, queueTwo]) {
      const call = await requestJson("POST", `/gopilot/dismissal/sessions/${sessionId}/call`, { queueId, zone: "A" }, adminAuth);
      assert.equal(call.status, 200);
      const release = await requestJson("POST", `/queue/${queueId}/release`, undefined, adminAuth);
      assert.equal(release.status, 200);
    }

    const mixedBatch = await requestJson(
      "POST",
      "/queue/dismiss-batch",
      { queueIds: [queueOne, queueTwo], pickupGroupId: arrivalOne.body.entries[0].pickupGroupId },
      adminAuth
    );
    assert.equal(mixedBatch.status, 409);

    await inSchool(schoolA.id, () => db.execute(sql`UPDATE dismissal_queue SET pickup_group_id = NULL WHERE id = ${queueOne}`));
    const legacyBatch = await requestJson(
      "POST",
      "/queue/dismiss-batch",
      { queueIds: [queueOne], pickupGroupId: arrivalOne.body.entries[0].pickupGroupId },
      adminAuth
    );
    assert.equal(legacyBatch.status, 409);

    const pickupOne = await requestJson("POST", `/queue/${queueOne}/dismiss`, undefined, adminAuth);
    assert.equal(pickupOne.status, 200);

    const custodyBlocked = await requestJson("POST", `/queue/${queueTwo}/dismiss`, undefined, adminAuth);
    assert.equal(custodyBlocked.status, 409);
    assert.equal(custodyBlocked.body.custodyAlerts[0].studentName, "Shared Two");

    const custodyAcknowledged = await requestJson(
      "POST",
      `/queue/${queueTwo}/dismiss`,
      { custodyAcknowledged: true, pickupPersonName: "Verified Guardian", pickupNote: "ID checked" },
      adminAuth
    );
    assert.equal(custodyAcknowledged.status, 200);
    assert.equal(custodyAcknowledged.body.entry.status, "dismissed");
  });

  it("GoPilot bus check-in response reports partial absent skips", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const sessionRes = await requestJson("POST", "/gopilot/dismissal/sessions", undefined, adminAuth);
    assert.equal(sessionRes.status, 200);
    const sessionId = sessionRes.body.session.id;
    const busRoute = `${TAG}-BUS-7`;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

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
    const tardyBusStudent = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Tardy",
        lastName: "Bus",
        email: `tardy.bus@${TAG}-a.example.edu`,
        homeroomId: homeroomA.id,
        dismissalType: "bus",
        busRoute,
        status: "active",
      } as any)
    );
    const earlyBusStudent = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Early",
        lastName: "Bus",
        email: `early.bus@${TAG}-a.example.edu`,
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
    const markTardy = await requestJson(
      "POST",
      "/attendance",
      { studentIds: [tardyBusStudent.id], date: today, status: "tardy" },
      adminAuth
    );
    assert.equal(markTardy.status, 201);
    const markEarly = await requestJson(
      "POST",
      "/attendance",
      { studentIds: [earlyBusStudent.id], date: today, status: "early_dismissal" },
      adminAuth
    );
    assert.equal(markEarly.status, 201);

    const busCheckIn = await requestJson(
      "POST",
      `/gopilot/dismissal/sessions/${sessionId}/check-in-by-bus`,
      { busNumber: busRoute },
      adminAuth
    );
    assert.equal(busCheckIn.status, 200);
    assert.equal(busCheckIn.body.outcome, "partial");
    assert.equal(busCheckIn.body.groupLabel, `Bus #${busRoute}`);
    const checkedInIds = new Set(busCheckIn.body.entries.map((entry: any) => entry.studentId));
    assert.ok(checkedInIds.has(presentBusStudent.id));
    assert.ok(checkedInIds.has(tardyBusStudent.id));
    assert.ok(!checkedInIds.has(absentBusStudent.id));
    assert.ok(!checkedInIds.has(earlyBusStudent.id));
    const skippedIds = new Set(busCheckIn.body.skippedAbsent.map((student: any) => student.studentId));
    assert.ok(skippedIds.has(absentBusStudent.id));
    assert.ok(skippedIds.has(earlyBusStudent.id));
    assert.ok(!skippedIds.has(tardyBusStudent.id));
  });

  it("GoPilot today's session lookup is read-only after completion", async () => {
    const adminAuth = authFor(adminUser, schoolA.id);
    const sessionRes = await requestJson("POST", "/gopilot/dismissal/sessions", undefined, adminAuth);
    assert.equal(sessionRes.status, 200);
    const sessionId = sessionRes.body.session.id;

    const start = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "active" }, adminAuth);
    assert.equal(start.status, 200);

    const queueRes = await requestJson("GET", `/gopilot/dismissal/sessions/${sessionId}/queue`, undefined, adminAuth);
    assert.equal(queueRes.status, 200);
    for (const entry of queueRes.body || []) {
      if (entry.status === "dismissed") continue;
      if (entry.status !== "released") {
        if (entry.status !== "called") {
          const call = await requestJson(
            "POST",
            `/gopilot/dismissal/sessions/${sessionId}/call`,
            { queueId: entry.id, zone: "A" },
            adminAuth
          );
          assert.equal(call.status, 200);
        }
        const release = await requestJson("POST", `/queue/${entry.id}/release`, undefined, adminAuth);
        assert.equal(release.status, 200);
      }
      const pickup = await requestJson("POST", `/queue/${entry.id}/dismiss`, { custodyAcknowledged: true }, adminAuth);
      assert.equal(pickup.status, 200);
    }

    const complete = await requestJson("PUT", `/gopilot/dismissal/sessions/${sessionId}`, { status: "completed" }, adminAuth);
    assert.equal(complete.status, 200);

    const today = await requestJson("GET", "/gopilot/dismissal/sessions/today", undefined, adminAuth);
    assert.equal(today.status, 200);
    assert.equal(today.body.session.id, sessionId);
    assert.equal(today.body.session.status, "completed");
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

      const studentsA = await requestJson("GET", "/gopilot/students", undefined, schoolAAuth);
      assert.equal(studentsA.status, 200);
      const studentIdsA = new Set((studentsA.body.students || []).map((s: any) => s.id));
      assert.ok(studentIdsA.has(multiStudentA.id));
      assert.ok(!studentIdsA.has(districtStudent.id));

      const homeroomsC = await requestJson("GET", "/gopilot/homerooms", undefined, districtAuth);
      assert.equal(homeroomsC.status, 200);
      const homeroomIdsC = new Set((homeroomsC.body.homerooms || []).map((h: any) => h.id));
      assert.ok(homeroomIdsC.has(districtHomeroom.id));
      assert.ok(!homeroomIdsC.has(multiHomeroomA.id));

      const studentsC = await requestJson("GET", "/gopilot/students", undefined, districtAuth);
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

      const gopilotContextAttendance = await requestJson(
        "POST",
        "/attendance",
        { studentIds: [ppStudent.id], date: "2099-02-01", status: "absent", productContext: "gopilot" },
        auth
      );
      assert.equal(gopilotContextAttendance.status, 403);

      const gopilotContextRead = await requestJson(
        "GET",
        "/attendance?date=2099-02-01&productContext=gopilot",
        undefined,
        auth
      );
      assert.equal(gopilotContextRead.status, 403);

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
      const record = (attendanceRead.body.records || []).find((r: any) => r.studentId === ppStudent.id);
      assert.ok(record?.id);
      const gopilotContextDelete = await requestJson(
        "DELETE",
        `/attendance/${record.id}?productContext=gopilot`,
        undefined,
        auth
      );
      assert.equal(gopilotContextDelete.status, 403);
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
