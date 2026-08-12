import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const TAG = `passpilot_multiclass_${Date.now()}`;
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let access: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;
let schoolA: any;
let schoolB: any;
let adminA: any;
let adminB: any;
let teacherA: any;
let teacherB: any;
let unrelatedTeacher: any;
let officeA: any;
let gradeA: any;
let gradeB: any;
let sharedStudent: any;
let schemaReady = false;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authFor(user: any, schoolId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: false,
    })}`,
    "x-school-id": schoolId,
    "x-passpilot-class-model": "classpilot-groups-v1",
  };
}

async function requestJson(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  access = await import("../dist/services/passpilotAccess.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  schemaReady = await pool
    .query(`SELECT to_regclass('public.passpilot_grade_students') IS NOT NULL AS ready`)
    .then((result: any) => result.rows[0]?.ready === true)
    .catch(() => false);
  if (!schemaReady) return;

  schoolA = await storage.createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}-a.example.edu`,
    slug: `${TAG}-a`,
  } as any);
  schoolB = await storage.createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}-b.example.edu`,
    slug: `${TAG}-b`,
  } as any);
  adminA = await storage.createUser({ email: `admin@${TAG}-a.example.edu`, firstName: "Admin", lastName: "A" } as any);
  adminB = await storage.createUser({ email: `admin@${TAG}-b.example.edu`, firstName: "Admin", lastName: "B" } as any);
  teacherA = await storage.createUser({ email: `teacher-a@${TAG}-a.example.edu`, firstName: "Teacher", lastName: "A" } as any);
  teacherB = await storage.createUser({ email: `teacher-b@${TAG}-a.example.edu`, firstName: "Teacher", lastName: "B" } as any);
  unrelatedTeacher = await storage.createUser({ email: `unrelated@${TAG}-a.example.edu`, firstName: "Teacher", lastName: "Unrelated" } as any);
  officeA = await storage.createUser({ email: `office@${TAG}-a.example.edu`, firstName: "Office", lastName: "A" } as any);
  for (const [user, school, role] of [
    [adminA, schoolA, "school_admin"],
    [adminB, schoolB, "school_admin"],
    [teacherA, schoolA, "teacher"],
    [teacherB, schoolA, "teacher"],
    [unrelatedTeacher, schoolA, "teacher"],
    [officeA, schoolA, "office_staff"],
  ] as const) {
    await storage.createMembership({ schoolId: school.id, userId: user.id, role, status: "active" } as any);
  }
  for (const school of [schoolA, schoolB]) {
    await storage.createProductLicense({ schoolId: school.id, product: "PASSPILOT", status: "active" } as any);
    await inSchool(school.id, () => storage.upsertSettings(school.id, {
      schoolName: school.name,
      passpilotClassSource: "legacy_grades",
    }));
  }
  await inSchool(schoolA.id, async () => {
    gradeA = await storage.createGrade({ schoolId: schoolA.id, name: "Class A" } as any);
    gradeB = await storage.createGrade({ schoolId: schoolA.id, name: "Class B" } as any);
    sharedStudent = await storage.createStudent({
      schoolId: schoolA.id,
      firstName: "Shared",
      lastName: "Student",
      status: "active",
    } as any);
    await storage.assignTeacherGrade(teacherA.id, gradeA.id);
    await storage.assignTeacherGrade(teacherB.id, gradeB.id);
  });

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
    if (schemaReady && schoolA?.id && schoolB?.id) {
      await asSystem(async () => {
        const ids = sql.join([schoolA.id, schoolB.id].map((id) => sql`${id}`), sql`, `);
        await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM passes WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM teacher_grades WHERE grade_id IN (SELECT id FROM grades WHERE school_id IN (${ids}))`);
        await db.execute(sql`DELETE FROM passpilot_grade_students WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM grades WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM students WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM settings WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM schools WHERE id IN (${ids})`);
        await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}-%`}`);
      });
    }
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
  }
});

describe("PassPilot standalone multi-class rosters", { concurrency: false }, () => {
  it("keeps schema, startup backfill, integrity, and RLS deployment contracts aligned", () => {
    const schema = readFileSync(new URL("../src/schema/passpilot.ts", import.meta.url), "utf8");
    const startup = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const deployment = readFileSync(new URL("../scripts/enforce-deploy-rls-allowlist.mjs", import.meta.url), "utf8");
    const kioskRoute = readFileSync(new URL("../src/routes/passpilot/kiosk.ts", import.meta.url), "utf8");
    assert.match(schema, /passpilotGradeStudents = pgTable\(/);
    assert.match(schema, /"passpilot_grade_students"/);
    assert.match(startup, /INSERT INTO passpilot_grade_students/);
    assert.match(startup, /ON CONFLICT \(school_id, grade_id, student_id\) DO NOTHING/);
    assert.match(startup, /invalid_passpilot_grade_students/);
    assert.match(startup, /passpilot_grade_students_student_school_fk/);
    assert.match(startup, /passpilot_grade_students_grade_school_fk/);
    assert.match(startup, /students_school_id_id_unique/);
    assert.match(startup, /grades_school_id_id_unique/);
    assert.match(deployment, /passpilot_grade_students/);
    assert.match(kioskRoute, /skipSuccessfulRequests:\s*true/);
  });

  it("allows assigned teachers and managers, denies unrelated teachers, and is idempotent", async (t) => {
    if (!schemaReady) return t.skip("passpilot_grade_students migration not applied");
    const assigned = await requestJson(
      "POST",
      `/passpilot/classes/${gradeA.id}/students`,
      { studentIds: [sharedStudent.id, sharedStudent.id] },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.addedCount, 1);

    const duplicate = await requestJson(
      "POST",
      `/passpilot/classes/${gradeA.id}/students`,
      { studentIds: [sharedStudent.id] },
      authFor(adminA, schoolA.id)
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.addedCount, 0);

    const denied = await requestJson(
      "POST",
      `/passpilot/classes/${gradeA.id}/students`,
      { studentIds: [sharedStudent.id] },
      authFor(unrelatedTeacher, schoolA.id)
    );
    assert.equal(denied.status, 403);
    await inSchool(schoolA.id, () =>
      assert.rejects(
        storage.addStudentsToLegacyPasspilotGrade(
          schoolA.id,
          gradeA.id,
          [sharedStudent.id],
          { actorUserId: unrelatedTeacher.id, manager: false }
        ),
        (error: any) => error?.code === "PASSPILOT_CLASS_ACCESS_DENIED"
      )
    );

    const manager = await requestJson(
      "POST",
      `/passpilot/classes/${gradeB.id}/students`,
      { studentIds: [sharedStudent.id] },
      authFor(officeA, schoolA.id)
    );
    assert.equal(manager.status, 200);
    assert.equal(manager.body.addedCount, 1);
    const primaryProjection = await inSchool(schoolA.id, () => storage.getStudentById(sharedStudent.id));
    assert.equal(primaryProjection.gradeId, gradeA.id, "additive assignment must not overwrite legacy primary class");

    const crossTenant = await requestJson(
      "POST",
      `/passpilot/classes/${gradeA.id}/students`,
      { studentIds: [sharedStudent.id] },
      authFor(adminB, schoolB.id)
    );
    assert.equal(crossTenant.status, 404);

    const [rosterA, rosterB] = await inSchool(schoolA.id, () => Promise.all([
      storage.getStudentsByGrade(schoolA.id, gradeA.id),
      storage.getStudentsByGrade(schoolA.id, gradeB.id),
    ]));
    assert.deepEqual(rosterA.map((student: any) => student.id), [sharedStudent.id]);
    assert.deepEqual(rosterB.map((student: any) => student.id), [sharedStudent.id]);
  });

  it("requires an exact class for shared students and never leaks a Class B pass to Class A", async (t) => {
    if (!schemaReady) return t.skip("passpilot_grade_students migration not applied");
    await inSchool(schoolA.id, async () => {
      await assert.rejects(
        storage.createLegacyPass({
          schoolId: schoolA.id,
          studentId: sharedStudent.id,
          teacherId: teacherA.id,
          destination: "bathroom",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "teacher",
        } as any, { manager: true }),
        (error: any) => error?.code === "PASSPILOT_CLASS_REQUIRED"
      );
      const passB = await storage.createLegacyPass({
        schoolId: schoolA.id,
        studentId: sharedStudent.id,
        teacherId: teacherB.id,
        gradeId: gradeB.id,
        destination: "office",
        status: "active",
        duration: 5,
        expiresAt: new Date(Date.now() + 300_000),
        issuedVia: "teacher",
      } as any, { actorUserId: teacherB.id, manager: false });
      assert.equal(passB.classNameSnapshot, "Class B");
      assert.equal(await access.canAccessPass(teacherA, schoolA.id, passB, "teacher"), false);
      assert.equal(await access.canAccessPass(teacherB, schoolA.id, passB, "teacher"), true);
      await storage.returnPass(passB.id, schoolA.id);

      await storage.removeTeacherGrade(teacherB.id, gradeB.id);
      await assert.rejects(
        storage.createLegacyPass({
          schoolId: schoolA.id,
          studentId: sharedStudent.id,
          teacherId: teacherB.id,
          gradeId: gradeB.id,
          destination: "office",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "teacher",
        } as any, { actorUserId: teacherB.id, manager: false }),
        (error: any) => error?.code === "PASSPILOT_CLASS_ACCESS_DENIED"
      );
      await storage.assignTeacherGrade(teacherB.id, gradeB.id);
    });
  });

  it("confines a configured legacy kiosk to its exact class roster", async (t) => {
    if (!schemaReady) return t.skip("passpilot_grade_students migration not applied");
    const { hashPassword } = await import("../dist/util/password.js");
    await inSchool(schoolA.id, async () => {
      await storage.updateSchool(schoolA.id, {
        kioskEnabled: true,
        kioskPinHash: await hashPassword("4826"),
      });
      await storage.updateLegacyKioskClass(schoolA.id, gradeA.id, adminA.id, true);
    });
    const kioskHeaders = {
      "x-school-id": schoolA.id,
      "x-kiosk-pin": "4826",
    };
    const classes = await requestJson(
      "GET",
      `/passpilot/kiosk/grades?school=${schoolA.id}`,
      null,
      kioskHeaders
    );
    assert.equal(classes.status, 200);
    assert.deepEqual(classes.body.classes.map((entry: any) => entry.classId), [gradeA.id]);

    const wrongRoster = await requestJson(
      "GET",
      `/passpilot/kiosk/students?school=${schoolA.id}&gradeId=${gradeB.id}`,
      null,
      kioskHeaders
    );
    assert.equal(wrongRoster.status, 409);
    assert.equal(wrongRoster.body.code, "PASSPILOT_KIOSK_CLASS_CHANGED");

    const configuredRoster = await requestJson(
      "GET",
      `/passpilot/kiosk/students?school=${schoolA.id}&gradeId=${gradeA.id}`,
      null,
      kioskHeaders
    );
    assert.equal(configuredRoster.status, 200);
    assert.equal(
      configuredRoster.body.students.some((student: any) => student.id === sharedStudent.id),
      true
    );

    await inSchool(schoolA.id, async () => {
      await assert.rejects(
        storage.updateLegacyKioskClass(schoolA.id, null, unrelatedTeacher.id, false),
        (error: any) => error?.code === "PASSPILOT_CLASS_ACCESS_DENIED"
      );
      assert.equal((await storage.getSchoolById(schoolA.id))?.kioskGradeId, gradeA.id);

      await storage.updateLegacyKioskClass(schoolA.id, gradeB.id, adminA.id, true);
      await assert.rejects(
        storage.createLegacyPass({
          schoolId: schoolA.id,
          studentId: sharedStudent.id,
          teacherId: adminA.id,
          gradeId: gradeA.id,
          destination: "office",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "kiosk",
        } as any, { kiosk: true, expectedKioskClassId: gradeA.id }),
        (error: any) => error?.code === "PASSPILOT_KIOSK_CLASS_CHANGED"
      );
      await storage.updateLegacyKioskClass(schoolA.id, gradeA.id, adminA.id, true);
    });
  });

  it("honors an old serving task changing grade_id after backfill, then repairs on additive write", async (t) => {
    if (!schemaReady) return t.skip("passpilot_grade_students migration not applied");
    await inSchool(schoolA.id, async () => {
      const rollingStudent = await storage.createStudent({
        schoolId: schoolA.id,
        firstName: "Rolling",
        lastName: "Writer",
        status: "active",
      } as any);
      await storage.addStudentsToLegacyPasspilotGrade(
        schoolA.id,
        gradeA.id,
        [rollingStudent.id],
        { manager: true }
      );

      // Simulate an old task after the deployment backfill: it still knows only
      // students.grade_id and moves the projection from A to B.
      await db.execute(sql`UPDATE students SET grade_id = ${gradeB.id} WHERE id = ${rollingStudent.id}`);
      const gradeIds = await storage.getLegacyPasspilotGradeIdsForStudent(schoolA.id, rollingStudent.id);
      assert.deepEqual(new Set(gradeIds), new Set([gradeA.id, gradeB.id]));
      assert.equal(
        (await storage.getStudentsByGrade(schoolA.id, gradeB.id)).some((student: any) => student.id === rollingStudent.id),
        true
      );

      const rollingPass = await storage.createLegacyPass({
        schoolId: schoolA.id,
        studentId: rollingStudent.id,
        teacherId: teacherB.id,
        gradeId: gradeB.id,
        destination: "office",
        status: "active",
        duration: 5,
        expiresAt: new Date(Date.now() + 300_000),
        issuedVia: "teacher",
      } as any, { actorUserId: teacherB.id, manager: false });
      assert.equal(rollingPass.gradeId, gradeB.id);
      assert.equal(rollingPass.classNameSnapshot, "Class B");
      await storage.returnPass(rollingPass.id, schoolA.id);

      await storage.addStudentsToLegacyPasspilotGrade(
        schoolA.id,
        gradeB.id,
        [rollingStudent.id],
        { manager: true }
      );
      const memberships = await db.execute(sql`
        SELECT grade_id FROM passpilot_grade_students
        WHERE school_id = ${schoolA.id} AND student_id = ${rollingStudent.id}
        ORDER BY grade_id
      `);
      assert.deepEqual(
        new Set(memberships.rows.map((row: any) => row.grade_id)),
        new Set([gradeA.id, gradeB.id])
      );
    });
  });

  it("removes only the requested class and keeps the remaining class visible", async (t) => {
    if (!schemaReady) return t.skip("passpilot_grade_students migration not applied");
    const removed = await requestJson(
      "DELETE",
      `/passpilot/classes/${gradeB.id}/students/${sharedStudent.id}`,
      {},
      authFor(teacherB, schoolA.id)
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    await inSchool(schoolA.id, async () => {
      assert.equal((await storage.getStudentsByGrade(schoolA.id, gradeA.id)).some((student: any) => student.id === sharedStudent.id), true);
      assert.equal((await storage.getStudentsByGrade(schoolA.id, gradeB.id)).some((student: any) => student.id === sharedStudent.id), false);
    });
  });

  it("leaves canonical ClassPilot roster ownership unchanged", async (t) => {
    if (!schemaReady) return t.skip("passpilot_grade_students migration not applied");
    await inSchool(schoolB.id, () => storage.upsertSettings(schoolB.id, {
      schoolName: schoolB.name,
      passpilotClassSource: "classpilot_groups",
    }));
    const before = await asSystem(() => db.execute(sql`
      SELECT COUNT(*)::int AS count FROM passpilot_grade_students
      WHERE school_id = ${schoolB.id}
    `));
    const response = await requestJson(
      "POST",
      "/passpilot/classes/not-a-legacy-class/students",
      { studentIds: [sharedStudent.id] },
      authFor(adminB, schoolB.id)
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "CLASSES_MANAGED_IN_CLASSPILOT");
    const after = await asSystem(() => db.execute(sql`
      SELECT COUNT(*)::int AS count FROM passpilot_grade_students
      WHERE school_id = ${schoolB.id}
    `));
    assert.deepEqual(after.rows, before.rows);
  });
});
