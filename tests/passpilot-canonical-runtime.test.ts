import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import {
  addGroupTeacher,
  addGroupStudents,
  archiveGroup,
  assignTeacherGrade,
  completePasspilotClassMigration,
  createCanonicalPass,
  createGrade,
  createGroup,
  createLegacyPass,
  createMembership,
  createProductLicense,
  createSchool,
  createStudent,
  createUser,
  deleteGrade,
  deleteProductLicenseForSchool,
  getKioskStudentState,
  getPassHistory,
  getPassHistoryPage,
  getSchoolById,
  getSettingsForSchool,
  hardDeleteGroupWithCleanup,
  initializePasspilotClassMigrationInventory,
  removeGroupStudent,
  returnKioskPassForStudent,
  returnPass,
  updateCanonicalKioskClass,
  updateGroup,
  updateLegacyKioskClass,
  updatePasspilotClassMappings,
  upsertSettings,
} from "../dist/services/storage.js";
import { getPasspilotClasses, getPasspilotClassRoster } from "../dist/services/passpilotClasses.js";
import {
  canAccessPass,
  requirePasspilotClassModel,
} from "../dist/services/passpilotAccess.js";
import { executeTool } from "../dist/services/chatToolExecutor.js";
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";

const canonicalSchemaReady = await pool
  .query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'schools'
         AND column_name = 'kiosk_classpilot_group_id'
     ) AS ready`
  )
  .then((result) => result.rows[0]?.ready === true)
  .catch(() => false);
const runtimeIt = canonicalSchemaReady ? it : it.skip;

const TAG = `passpilot_canonical_${Date.now()}`;
let schoolA: any;
let schoolB: any;
let raceSchool: any;
let migrationSchool: any;
let legacySchool: any;
let teacher: any;
let migrationTeacher: any;
let legacyTeacher: any;
let groupA: any;
let studentA: any;
let classpilotLicenseA: any;
let foreignStudent: any;
let migrationGroup: any;
let migrationStudent: any;
let migrationPass: any;
let canonicalPassA: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

async function classModelAdmission(
  schoolId: string,
  capability?: string
): Promise<{ nextCalled: boolean; status: number; body: any }> {
  let nextCalled = false;
  let status = 200;
  let body: any = null;
  const req = {
    get(name: string) {
      return name.toLowerCase() === "x-passpilot-class-model" ? capability : undefined;
    },
  } as any;
  const res = {
    locals: { schoolId },
    status(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    json(nextBody: any) {
      body = nextBody;
      return this;
    },
  } as any;
  await requirePasspilotClassModel(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, status, body };
}

function chatContext(user: any, school: any, role: string) {
  return {
    userId: user.id,
    schoolId: school.id,
    schoolName: school.name,
    userName: `${user.firstName} ${user.lastName}`,
    userRole: role,
    licensedProducts: ["PASSPILOT", "CLASSPILOT"],
    getTranscript: () => "",
  };
}

async function licenseBoth(schoolId: string) {
  const classpilot = await createProductLicense({
    schoolId,
    product: "CLASSPILOT",
    status: "active",
  } as any);
  await createProductLicense({
    schoolId,
    product: "PASSPILOT",
    status: "active",
  } as any);
  return classpilot;
}

before(async () => {
  if (!canonicalSchemaReady) return;
  schoolA = await createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}-a.example.edu`,
    slug: `${TAG}-a`,
  } as any);
  schoolB = await createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}-b.example.edu`,
    slug: `${TAG}-b`,
  } as any);
  raceSchool = await createSchool({
    name: `${TAG}_Race`,
    domain: `${TAG}-race.example.edu`,
    slug: `${TAG}-race`,
  } as any);
  migrationSchool = await createSchool({
    name: `${TAG}_Migration`,
    domain: `${TAG}-migration.example.edu`,
    slug: `${TAG}-migration`,
  } as any);
  legacySchool = await createSchool({
    name: `${TAG}_Legacy`,
    domain: `${TAG}-legacy.example.edu`,
    slug: `${TAG}-legacy`,
  } as any);
  teacher = await createUser({
    email: `teacher@${TAG}-a.example.edu`,
    firstName: "Casey",
    lastName: "Teacher",
  } as any);
  migrationTeacher = await createUser({
    email: `teacher@${TAG}-migration.example.edu`,
    firstName: "Morgan",
    lastName: "Migration",
  } as any);
  legacyTeacher = await createUser({
    email: `teacher@${TAG}-legacy.example.edu`,
    firstName: "Lee",
    lastName: "Legacy",
  } as any);
  await createMembership({
    schoolId: schoolA.id,
    userId: teacher.id,
    role: "teacher",
    status: "active",
  } as any);
  await createMembership({
    schoolId: migrationSchool.id,
    userId: migrationTeacher.id,
    role: "teacher",
    status: "active",
  } as any);
  await createMembership({
    schoolId: legacySchool.id,
    userId: legacyTeacher.id,
    role: "teacher",
    status: "active",
  } as any);
  classpilotLicenseA = await licenseBoth(schoolA.id);
  await licenseBoth(raceSchool.id);
  await licenseBoth(migrationSchool.id);
  await createProductLicense({ schoolId: schoolB.id, product: "PASSPILOT", status: "active" } as any);
  await createProductLicense({ schoolId: legacySchool.id, product: "PASSPILOT", status: "active" } as any);

  await inSchool(schoolA.id, async () => {
    await upsertSettings(schoolA.id, { schoolName: schoolA.name, passpilotClassSource: "legacy_grades" });
    studentA = await createStudent({
      schoolId: schoolA.id,
      firstName: "Alex",
      lastName: "Student",
      email: `student@${TAG}-a.example.edu`,
      emailLc: `student@${TAG}-a.example.edu`,
      status: "active",
    } as any);
    groupA = await createGroup({
      schoolId: schoolA.id,
      teacherId: teacher.id,
      name: "Grade 6 Homeroom",
      groupType: "admin_class",
      status: "active",
    } as any);
    await addGroupStudents(groupA.id, [studentA.id]);
  });
  await inSchool(schoolB.id, () =>
    upsertSettings(schoolB.id, { schoolName: schoolB.name, passpilotClassSource: "legacy_grades" })
  );
  foreignStudent = await inSchool(schoolB.id, () =>
    createStudent({
      schoolId: schoolB.id,
      firstName: "Foreign",
      lastName: "Student",
      status: "active",
    } as any)
  );
  await inSchool(raceSchool.id, async () => {
    await upsertSettings(raceSchool.id, { schoolName: raceSchool.name, passpilotClassSource: "legacy_grades" });
    await createStudent({
      id: `${TAG}-race-student`,
      schoolId: raceSchool.id,
      firstName: "Race",
      lastName: "Student",
      status: "active",
    } as any);
  });
  await inSchool(migrationSchool.id, () =>
    upsertSettings(migrationSchool.id, {
      schoolName: migrationSchool.name,
      passpilotClassSource: "legacy_grades",
    })
  );
  await inSchool(legacySchool.id, () =>
    upsertSettings(legacySchool.id, {
      schoolName: legacySchool.name,
      passpilotClassSource: "legacy_grades",
    })
  );
});

after(async () => {
  if (!canonicalSchemaReady) {
    await pool.end();
    return;
  }
  await asSystem(async () => {
    const schoolIds = [
      schoolA?.id,
      schoolB?.id,
      raceSchool?.id,
      migrationSchool?.id,
      legacySchool?.id,
    ].filter(Boolean);
    if (schoolIds.length > 0) {
      await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM passes WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)}))`);
      await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)}))`);
      await db.execute(sql`DELETE FROM groups WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM teacher_grades WHERE grade_id IN (SELECT id FROM grades WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)}))`);
      await db.execute(sql`DELETE FROM grades WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM students WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM settings WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${sql.join(schoolIds.map((id) => sql`${id}`), sql`, `)})`);
    }
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}-%`}`);
  });
  await pool.end();
});

describe("PassPilot canonical ClassPilot classes", () => {
  runtimeIt("keeps class inventory read-only and requires explicit acknowledged cutover", async () => {
    await inSchool(schoolA.id, async () => {
      const beforeInventory = await getPasspilotClasses(schoolA.id, {
        userId: teacher.id,
        manager: false,
      });
      assert.equal(beforeInventory.source, "legacy_grades");
      assert.equal(beforeInventory.classes.length, 0);
      assert.equal((await getSettingsForSchool(schoolA.id))?.passpilotClassSource, "legacy_grades");

      await assert.rejects(
        completePasspilotClassMigration(schoolA.id, teacher.id, 0, false),
        (error: any) => error?.code === "PASSPILOT_CLASS_MODEL_ACKNOWLEDGEMENT_REQUIRED"
      );
      await completePasspilotClassMigration(schoolA.id, teacher.id, 0, true);
      assert.equal((await getSettingsForSchool(schoolA.id))?.passpilotClassSource, "classpilot_groups");

      const canonicalInventory = await getPasspilotClasses(schoolA.id, {
        userId: teacher.id,
        manager: false,
      });
      assert.deepEqual(canonicalInventory.classes.map((entry) => entry.classId), [groupA.id]);
    });
  });

  runtimeIt("writes canonical pass context atomically and denies cross-tenant/legacy writes", async () => {
    await inSchool(schoolA.id, async () => {
      const pass = await createCanonicalPass(
        {
          schoolId: schoolA.id,
          studentId: studentA.id,
          teacherId: teacher.id,
          classId: groupA.id,
          destination: "bathroom",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "teacher",
        },
        { actorUserId: teacher.id, manager: false }
      );
      canonicalPassA = pass;
      assert.equal(pass.classpilotGroupId, groupA.id);
      assert.equal(pass.gradeId, null);
      assert.equal(pass.classNameSnapshot, groupA.name);
      assert.ok((await getSettingsForSchool(schoolA.id))?.passpilotCanonicalWritesAt);

      await asSystem(() =>
        db.execute(sql`
          INSERT INTO group_students (group_id, student_id)
          VALUES (${groupA.id}, ${foreignStudent.id})
          ON CONFLICT DO NOTHING
        `)
      );
      const activeClasses = await getPasspilotClasses(schoolA.id, {
        userId: teacher.id,
        manager: true,
      });
      assert.equal(activeClasses.classes.find((entry) => entry.classId === groupA.id)?.studentCount, 1);
      const roster = await getPasspilotClassRoster(schoolA.id, groupA.id, {
        userId: teacher.id,
        manager: true,
      });
      assert.deepEqual(roster?.students.map((student) => student.id), [studentA.id]);
      await asSystem(() =>
        db.execute(sql`
          DELETE FROM group_students
          WHERE group_id = ${groupA.id} AND student_id = ${foreignStudent.id}
        `)
      );
      await assert.rejects(
        createLegacyPass({
          schoolId: schoolA.id,
          studentId: studentA.id,
          teacherId: teacher.id,
          destination: "office",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "teacher",
        }),
        (error: any) => error?.code === "PASSPILOT_CLASS_SOURCE_CHANGED"
      );
      assert.equal(await canAccessPass(teacher, schoolA.id, pass, "teacher"), true);
      await archiveGroup(groupA.id);
      assert.equal(await canAccessPass(teacher, schoolA.id, pass, "teacher"), true);
      const historyClasses = await getPasspilotClasses(schoolA.id, {
        userId: teacher.id,
        manager: true,
        scope: "history",
      });
      assert.ok(
        historyClasses.classes.some(
          (entry) => entry.classId === groupA.id && entry.status === "archived"
        )
      );
      await assert.rejects(
        hardDeleteGroupWithCleanup(groupA.id),
        (error: any) => error?.code === "CLASSPILOT_CLASS_IN_USE_BY_PASSPILOT"
      );
      await assert.rejects(
        deleteProductLicenseForSchool(schoolA.id, classpilotLicenseA.id),
        (error: any) => error?.code === "CLASSPILOT_REQUIRED_FOR_PASSPILOT_CLASSES"
      );
    });

    await inSchool(schoolB.id, async () => {
      await assert.rejects(
        createCanonicalPass({
          schoolId: schoolA.id,
          studentId: studentA.id,
          teacherId: teacher.id,
          classId: groupA.id,
          destination: "bathroom",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "teacher",
        }),
        (error: any) => ["PASSPILOT_CLASS_SOURCE_CHANGED", "PASSPILOT_CANONICAL_CLASS_NOT_FOUND"].includes(error?.code)
      );
    });
  });

  runtimeIt("keeps history-only legacy classes out of active use and preserves references", async () => {
    await inSchool(schoolB.id, async () => {
      const grade = await createGrade({ schoolId: schoolB.id, name: "Legacy Archive" } as any);
      await db.execute(sql`
        UPDATE students SET grade_id = ${grade.id} WHERE id = ${foreignStudent.id}
      `);
      await db.execute(sql`
        UPDATE grades
        SET migration_state = 'history_only', mapped_at = now()
        WHERE id = ${grade.id}
      `);

      const activeClasses = await getPasspilotClasses(schoolB.id, {
        userId: teacher.id,
        manager: true,
      });
      assert.equal(activeClasses.classes.some((entry) => entry.classId === grade.id), false);
      const historyClasses = await getPasspilotClasses(schoolB.id, {
        userId: teacher.id,
        manager: true,
        scope: "history",
      });
      assert.equal(
        historyClasses.classes.some((entry) => entry.classId === grade.id && entry.historyOnly),
        true
      );
      await assert.rejects(
        createLegacyPass({
          schoolId: schoolB.id,
          studentId: foreignStudent.id,
          teacherId: null,
          gradeId: grade.id,
          destination: "bathroom",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "kiosk",
        }),
        (error: any) => error?.code === "PASSPILOT_HISTORY_CLASS_READ_ONLY"
      );
      await assert.rejects(
        deleteGrade(grade.id),
        (error: any) => error?.code === "PASSPILOT_LEGACY_CLASS_REFERENCED"
      );
    });
  });

  runtimeIt("enforces multi-class, co-teacher, kiosk, and chat authorization without legacy writes", async () => {
    await inSchool(schoolA.id, async () => {
      if (canonicalPassA?.id) await returnPass(canonicalPassA.id, schoolA.id);

      const coTeacher = await createUser({
        email: `coteacher@${TAG}-a.example.edu`,
        firstName: "Cory",
        lastName: "CoTeacher",
      } as any);
      const unrelatedTeacher = await createUser({
        email: `unrelated@${TAG}-a.example.edu`,
        firstName: "Uma",
        lastName: "Unrelated",
      } as any);
      await createMembership({
        schoolId: schoolA.id,
        userId: coTeacher.id,
        role: "teacher",
        status: "active",
      } as any);
      await createMembership({
        schoolId: schoolA.id,
        userId: unrelatedTeacher.id,
        role: "teacher",
        status: "active",
      } as any);

      const secondStudent = await createStudent({
        schoolId: schoolA.id,
        firstName: "Bailey",
        lastName: "Second",
        status: "active",
      } as any);
      const primaryClass = await createGroup({
        schoolId: schoolA.id,
        teacherId: teacher.id,
        name: "Canonical Math",
        groupType: "admin_class",
        status: "active",
      } as any);
      const secondaryClass = await createGroup({
        schoolId: schoolA.id,
        teacherId: coTeacher.id,
        name: "Canonical Science",
        groupType: "admin_class",
        status: "active",
      } as any);
      await addGroupTeacher(primaryClass.id, coTeacher.id, "co-teacher");
      await addGroupTeacher(secondaryClass.id, teacher.id, "co-teacher");
      await addGroupStudents(primaryClass.id, [studentA.id, secondStudent.id]);
      await addGroupStudents(secondaryClass.id, [studentA.id]);

      const primaryInventory = await getPasspilotClasses(schoolA.id, {
        userId: teacher.id,
        manager: false,
      });
      const coTeacherInventory = await getPasspilotClasses(schoolA.id, {
        userId: coTeacher.id,
        manager: false,
      });
      const unrelatedInventory = await getPasspilotClasses(schoolA.id, {
        userId: unrelatedTeacher.id,
        manager: false,
      });
      for (const inventory of [primaryInventory, coTeacherInventory]) {
        const ids = new Set(inventory.classes.map((entry) => entry.classId));
        assert.equal(ids.has(primaryClass.id), true);
        assert.equal(ids.has(secondaryClass.id), true);
      }
      assert.deepEqual(unrelatedInventory.classes, []);

      const beforeLegacyState = await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM grades WHERE school_id = ${schoolA.id}) AS grade_count,
          (SELECT COUNT(*)::int FROM teacher_grades tg
             JOIN grades g ON g.id = tg.grade_id
            WHERE g.school_id = ${schoolA.id}) AS teacher_grade_count,
          (SELECT grade_id FROM students WHERE id = ${studentA.id}) AS student_grade_id
      `);
      const selectedPass = await createCanonicalPass(
        {
          schoolId: schoolA.id,
          studentId: studentA.id,
          teacherId: teacher.id,
          classId: secondaryClass.id,
          destination: "library",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "teacher",
        },
        { actorUserId: teacher.id, manager: false }
      );
      assert.equal(selectedPass.classpilotGroupId, secondaryClass.id);
      assert.equal(selectedPass.gradeId, null);
      assert.equal(selectedPass.classNameSnapshot, "Canonical Science");

      await updateGroup(secondaryClass.id, { name: "Renamed Canonical Science" } as any);
      const [snapshottedPass] = (await db.execute(sql`
        SELECT class_name_snapshot FROM passes WHERE id = ${selectedPass.id}
      `)).rows as Array<{ class_name_snapshot: string }>;
      assert.equal(snapshottedPass?.class_name_snapshot, "Canonical Science");
      await returnPass(selectedPass.id, schoolA.id);

      await assert.rejects(
        createCanonicalPass(
          {
            schoolId: schoolA.id,
            studentId: studentA.id,
            teacherId: unrelatedTeacher.id,
            classId: primaryClass.id,
            destination: "office",
            status: "active",
            duration: 5,
            expiresAt: new Date(Date.now() + 300_000),
            issuedVia: "teacher",
          },
          { actorUserId: unrelatedTeacher.id, manager: false }
        ),
        (error: any) => error?.code === "PASSPILOT_CLASS_ACCESS_DENIED"
      );

      const teacherCreated = await createGroup({
        schoolId: schoolA.id,
        teacherId: teacher.id,
        name: "Teacher-created Group",
        groupType: "teacher_created",
        status: "active",
      } as any);
      const archivedOfficial = await createGroup({
        schoolId: schoolA.id,
        teacherId: teacher.id,
        name: "Archived Official",
        groupType: "admin_class",
        status: "archived",
      } as any);
      await addGroupStudents(teacherCreated.id, [studentA.id]);
      await addGroupStudents(archivedOfficial.id, [studentA.id]);
      for (const classId of [teacherCreated.id, archivedOfficial.id]) {
        await assert.rejects(
          createCanonicalPass(
            {
              schoolId: schoolA.id,
              studentId: studentA.id,
              teacherId: teacher.id,
              classId,
              destination: "office",
              status: "active",
              duration: 5,
              expiresAt: new Date(Date.now() + 300_000),
              issuedVia: "teacher",
            },
            { actorUserId: teacher.id, manager: false }
          ),
          (error: any) => error?.code === "PASSPILOT_CANONICAL_CLASS_NOT_FOUND"
        );
      }

      const teacherStudents = await executeTool(
        "list_students",
        {},
        chatContext(teacher, schoolA, "teacher") as any
      );
      const unrelatedStudents = await executeTool(
        "list_students",
        {},
        chatContext(unrelatedTeacher, schoolA, "teacher") as any
      );
      const coTeacherClasses = await executeTool(
        "list_passpilot_classes",
        {},
        chatContext(coTeacher, schoolA, "teacher") as any
      );
      assert.equal(teacherStudents.success, true);
      assert.deepEqual(
        new Set(teacherStudents.data.students.map((student: any) => student.id)),
        new Set([studentA.id, secondStudent.id])
      );
      assert.deepEqual(unrelatedStudents.data.students, []);
      assert.equal(
        coTeacherClasses.data.classes.some((entry: any) => entry.id === secondaryClass.id),
        true
      );

      await updateCanonicalKioskClass(schoolA.id, primaryClass.id, teacher.id, true);
      const kioskPass = await createCanonicalPass(
        {
          schoolId: schoolA.id,
          studentId: studentA.id,
          teacherId: teacher.id,
          classId: primaryClass.id,
          destination: "bathroom",
          status: "active",
          duration: 5,
          expiresAt: new Date(Date.now() + 300_000),
          issuedVia: "kiosk",
        },
        { kiosk: true }
      );
      await updateCanonicalKioskClass(schoolA.id, secondaryClass.id, teacher.id, true);
      const mismatchedKioskState = await getKioskStudentState(schoolA.id, studentA.id, true);
      assert.equal(mismatchedKioskState.enrolled, true);
      assert.equal(mismatchedKioskState.activePass, null);
      assert.equal(mismatchedKioskState.hasActivePassInAnotherClass, true);
      await assert.rejects(
        returnKioskPassForStudent(schoolA.id, studentA.id, true),
        (error: any) => error?.code === "PASSPILOT_KIOSK_PASS_CLASS_MISMATCH"
      );
      await updateCanonicalKioskClass(schoolA.id, primaryClass.id, teacher.id, true);
      assert.equal((await returnKioskPassForStudent(schoolA.id, studentA.id, true))?.id, kioskPass.id);

      const afterLegacyState = await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM grades WHERE school_id = ${schoolA.id}) AS grade_count,
          (SELECT COUNT(*)::int FROM teacher_grades tg
             JOIN grades g ON g.id = tg.grade_id
            WHERE g.school_id = ${schoolA.id}) AS teacher_grade_count,
          (SELECT grade_id FROM students WHERE id = ${studentA.id}) AS student_grade_id
      `);
      assert.deepEqual(afterLegacyState.rows, beforeLegacyState.rows);
      const kioskSchool = await getSchoolById(schoolA.id);
      assert.equal(kioskSchool?.kioskGradeId, null);
      assert.equal(kioskSchool?.kioskClasspilotGroupId, primaryClass.id);
    });
  });

  runtimeIt("persists migration decisions, rejects stale revisions and active passes, and translates kiosk state", async () => {
    await inSchool(migrationSchool.id, async () => {
      const legacyGrade = await createGrade({
        schoolId: migrationSchool.id,
        name: "Migration Homeroom",
      } as any);
      const student = await createStudent({
        schoolId: migrationSchool.id,
        firstName: "Mia",
        lastName: "Mapped",
        gradeId: legacyGrade.id,
        status: "active",
      } as any);
      migrationStudent = student;
      await assignTeacherGrade(migrationTeacher.id, legacyGrade.id);
      migrationGroup = await createGroup({
        schoolId: migrationSchool.id,
        teacherId: migrationTeacher.id,
        name: "Migration Homeroom",
        groupType: "admin_class",
        status: "active",
      } as any);
      await addGroupStudents(migrationGroup.id, [student.id]);
      await updateLegacyKioskClass(
        migrationSchool.id,
        legacyGrade.id,
        migrationTeacher.id
      );

      const initialized = await initializePasspilotClassMigrationInventory(
        migrationSchool.id,
        migrationTeacher.id
      );
      assert.equal(initialized.revision, 1);
      assert.equal(initialized.legacyGrades[0]?.migrationState, "auto_linked");
      assert.equal(initialized.legacyGrades[0]?.classpilotGroupId, migrationGroup.id);

      await assert.rejects(
        updatePasspilotClassMappings(
          migrationSchool.id,
          migrationTeacher.id,
          0,
          [{ gradeId: legacyGrade.id, classId: null, state: "history_only" }]
        ),
        (error: any) => error?.code === "PASSPILOT_CLASS_MIGRATION_CONFLICT"
      );
      const afterConflict = await initializePasspilotClassMigrationInventory(
        migrationSchool.id,
        migrationTeacher.id
      );
      assert.equal(afterConflict.revision, 1);
      assert.equal(afterConflict.legacyGrades[0]?.classpilotGroupId, migrationGroup.id);

      migrationPass = await createLegacyPass({
        schoolId: migrationSchool.id,
        studentId: student.id,
        teacherId: migrationTeacher.id,
        gradeId: legacyGrade.id,
        destination: "bathroom",
        status: "active",
        duration: 5,
        expiresAt: new Date(Date.now() + 300_000),
        issuedVia: "teacher",
      });
      await assert.rejects(
        completePasspilotClassMigration(
          migrationSchool.id,
          migrationTeacher.id,
          1,
          true
        ),
        (error: any) => error?.code === "PASSPILOT_ACTIVE_LEGACY_PASSES"
      );
      assert.equal(
        (await getSettingsForSchool(migrationSchool.id))?.passpilotClassSource,
        "legacy_grades"
      );

      await returnPass(migrationPass.id, migrationSchool.id);
      const completed = await completePasspilotClassMigration(
        migrationSchool.id,
        migrationTeacher.id,
        1,
        true
      );
      assert.equal(completed.source, "classpilot_groups");
      assert.equal(completed.revision, 2);
      const school = await getSchoolById(migrationSchool.id);
      assert.equal(school?.kioskGradeId, null);
      assert.equal(school?.kioskClasspilotGroupId, migrationGroup.id);

      const mappedHistory = await getPassHistory(migrationSchool.id, {
        classId: migrationGroup.id,
      });
      assert.equal(mappedHistory.some((pass) => pass.id === migrationPass.id), true);
      assert.equal(mappedHistory.find((pass) => pass.id === migrationPass.id)?.gradeId, legacyGrade.id);
      assert.equal(mappedHistory.find((pass) => pass.id === migrationPass.id)?.classpilotGroupId, null);

      const auditRows = await db.execute(sql`
        SELECT action FROM audit_logs
        WHERE school_id = ${migrationSchool.id}
          AND action IN (
            'passpilot.class_migration.inventory_initialized',
            'passpilot.class_migration.completed'
          )
        ORDER BY action
      `);
      assert.deepEqual(
        auditRows.rows.map((row: any) => row.action),
        [
          "passpilot.class_migration.completed",
          "passpilot.class_migration.inventory_initialized",
        ]
      );
    });
  });

  runtimeIt("keeps PassPilot-only schools legacy and enforces exact canonical client admission", async () => {
    await inSchool(legacySchool.id, async () => {
      const grade = await createGrade({
        schoolId: legacySchool.id,
        name: "Legacy Advisory",
      } as any);
      const student = await createStudent({
        schoolId: legacySchool.id,
        firstName: "Lena",
        lastName: "Legacy",
        gradeId: grade.id,
        status: "active",
      } as any);
      await assignTeacherGrade(legacyTeacher.id, grade.id);
      await updateLegacyKioskClass(legacySchool.id, grade.id, legacyTeacher.id);

      const inventory = await getPasspilotClasses(legacySchool.id, {
        userId: legacyTeacher.id,
        manager: false,
      });
      assert.equal(inventory.source, "legacy_grades");
      assert.deepEqual(inventory.classes.map((entry) => entry.classId), [grade.id]);

      const legacyPass = await createLegacyPass({
        schoolId: legacySchool.id,
        studentId: student.id,
        teacherId: legacyTeacher.id,
        gradeId: grade.id,
        destination: "office",
        status: "active",
        duration: 5,
        expiresAt: new Date(Date.now() + 300_000),
        issuedVia: "teacher",
      });
      assert.equal((await returnPass(legacyPass.id, legacySchool.id))?.id, legacyPass.id);

      await createProductLicense({
        schoolId: legacySchool.id,
        product: "CLASSPILOT",
        status: "active",
      } as any);
      assert.equal(
        (await getSettingsForSchool(legacySchool.id))?.passpilotClassSource,
        "legacy_grades"
      );
      const secondGrade = await createGrade({
        schoolId: legacySchool.id,
        name: "Still Legacy",
      } as any);
      assert.ok(secondGrade.id);
      assert.equal((await getSchoolById(legacySchool.id))?.kioskGradeId, grade.id);

      assert.deepEqual(await classModelAdmission(legacySchool.id), {
        nextCalled: true,
        status: 200,
        body: null,
      });
    });

    await inSchool(schoolA.id, async () => {
      const missing = await classModelAdmission(schoolA.id);
      assert.equal(missing.nextCalled, false);
      assert.equal(missing.status, 426);
      assert.equal(missing.body?.code, "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED");
      const wrong = await classModelAdmission(schoolA.id, "classpilot-groups-v0");
      assert.equal(wrong.nextCalled, false);
      assert.equal(wrong.status, 426);
      const current = await classModelAdmission(schoolA.id, "classpilot-groups-v1");
      assert.equal(current.nextCalled, true);
      assert.equal(current.status, 200);
    });
  });

  runtimeIt("partitions canonical classes, rosters, passes, and migration state under RLS", {
    skip: process.env.RLS_GUC_ENABLED !== "true",
  }, async () => {
    const tenantIds = [schoolA.id, migrationSchool.id];
    const rowsFor = (tableName: "settings" | "groups" | "students" | "passes" | "grades") =>
      db.execute(sql.raw(
        `SELECT school_id FROM ${tableName} WHERE school_id IN ('${tenantIds[0]}', '${tenantIds[1]}') ORDER BY school_id`
      ));

    await inSchool(schoolA.id, async () => {
      for (const tableName of ["settings", "groups", "students", "passes"] as const) {
        const result = await rowsFor(tableName);
        assert.ok(result.rows.length > 0, `${tableName} must include same-school rows`);
        assert.equal(result.rows.every((row: any) => row.school_id === schoolA.id), true);
      }
      assert.deepEqual((await rowsFor("grades")).rows, []);

      const foreignInventory = await getPasspilotClasses(migrationSchool.id, {
        userId: teacher.id,
        manager: true,
      });
      assert.deepEqual(foreignInventory.classes, []);
      await assert.rejects(
        createCanonicalPass(
          {
            schoolId: schoolA.id,
            studentId: migrationStudent.id,
            teacherId: teacher.id,
            classId: migrationGroup.id,
            destination: "office",
            status: "active",
            duration: 5,
            expiresAt: new Date(Date.now() + 300_000),
            issuedVia: "teacher",
          },
          { actorUserId: teacher.id, manager: false }
        ),
        (error: any) => error?.code === "PASSPILOT_CANONICAL_CLASS_NOT_FOUND"
      );
    });

    await inSchool(migrationSchool.id, async () => {
      for (const tableName of ["settings", "groups", "students", "passes", "grades"] as const) {
        const result = await rowsFor(tableName);
        assert.ok(result.rows.length > 0, `${tableName} must include same-school rows`);
        assert.equal(result.rows.every((row: any) => row.school_id === migrationSchool.id), true);
      }
    });
  });

  runtimeIt("serializes official roster mutation on the PassPilot class lock", async () => {
    const { group, student } = await inSchool(schoolA.id, async () => {
      const group = await createGroup({
        schoolId: schoolA.id,
        teacherId: teacher.id,
        name: "Roster Lock Class",
        groupType: "admin_class",
        status: "active",
      } as any);
      const student = await createStudent({
        schoolId: schoolA.id,
        firstName: "Roster",
        lastName: "Lock",
        status: "active",
      } as any);
      await db.execute(sql`INSERT INTO group_students (group_id, student_id) VALUES (${group.id}, ${student.id})`);
      return { group, student };
    });

    const lockObserver = new pg.Client({
      connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
    });
    await lockObserver.connect();
    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = inSchool(schoolA.id, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${schoolA.id}`}))`);
        reportLocked();
        await release;
      })
    );
    await locked;
    let mutationSettled = false;
    const mutation = inSchool(schoolA.id, () =>
      removeGroupStudent(group.id, student.id)
    ).finally(() => {
        mutationSettled = true;
    });

    const waitDeadline = Date.now() + 2_000;
    let mutationWaitingOnAdvisoryLock = false;
    let mutationSettledBeforeRelease = true;
    let blockerOutcome: PromiseSettledResult<void>;
    let mutationOutcome: PromiseSettledResult<void>;
    try {
      while (!mutationSettled && Date.now() < waitDeadline) {
        const waitingLocks = await lockObserver.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM pg_locks
             WHERE locktype = 'advisory'
               AND granted = false
           ) AS waiting`
        );
        mutationWaitingOnAdvisoryLock = waitingLocks.rows[0]?.waiting === true;
        if (mutationWaitingOnAdvisoryLock) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      mutationSettledBeforeRelease = mutationSettled;
    } finally {
      releaseLock();
      [blockerOutcome, mutationOutcome] = await Promise.allSettled([blocker, mutation]);
      await lockObserver.end();
    }
    assert.equal(blockerOutcome.status, "fulfilled");
    assert.equal(mutationOutcome.status, "fulfilled");
    assert.equal(mutationSettledBeforeRelease, false);
    assert.equal(mutationWaitingOnAdvisoryLock, true);
  });

  runtimeIt("serializes legacy issuance against cutover", async () => {
    await inSchool(raceSchool.id, async () => {
      const legacyWrite = createLegacyPass({
        schoolId: raceSchool.id,
        studentId: `${TAG}-race-student`,
        teacherId: null,
        destination: "bathroom",
        status: "active",
        duration: 5,
        expiresAt: new Date(Date.now() + 300_000),
        issuedVia: "kiosk",
      });
      const cutover = completePasspilotClassMigration(raceSchool.id, teacher.id, 0, true);
      const outcomes = await Promise.allSettled([legacyWrite, cutover]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
      const source = (await getSettingsForSchool(raceSchool.id))?.passpilotClassSource;
      assert.ok(source === "legacy_grades" || source === "classpilot_groups");
    });
  });

  runtimeIt("paginates every pass issued within the same database millisecond", async () => {
    await inSchool(schoolA.id, async () => {
      const ids = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      await db.execute(sql`
        INSERT INTO passes (
          id, student_id, teacher_id, school_id, classpilot_group_id,
          class_name_snapshot, destination, status, issued_at, expires_at, issued_via
        ) VALUES
          (${ids[0]}, ${studentA.id}, ${teacher.id}, ${schoolA.id}, ${groupA.id}, ${groupA.name}, 'office', 'returned', timestamp '2099-01-01 12:34:56.789100', timestamp '2099-01-01 12:34:56.789100', 'teacher'),
          (${ids[1]}, ${studentA.id}, ${teacher.id}, ${schoolA.id}, ${groupA.id}, ${groupA.name}, 'office', 'returned', timestamp '2099-01-01 12:34:56.789500', timestamp '2099-01-01 12:34:56.789500', 'teacher'),
          (${ids[2]}, ${studentA.id}, ${teacher.id}, ${schoolA.id}, ${groupA.id}, ${groupA.name}, 'office', 'returned', timestamp '2099-01-01 12:34:56.789900', timestamp '2099-01-01 12:34:56.789900', 'teacher')
      `);

      const first = await getPassHistoryPage(schoolA.id, {
        classId: groupA.id,
        limit: 1,
      });
      const second = await getPassHistoryPage(schoolA.id, {
        classId: groupA.id,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      const third = await getPassHistoryPage(schoolA.id, {
        classId: groupA.id,
        limit: 1,
        cursor: second.nextCursor ?? undefined,
      });
      assert.deepEqual(
        [first.passes[0]?.id, second.passes[0]?.id, third.passes[0]?.id],
        [...ids].sort().reverse()
      );
    });
  });
});
