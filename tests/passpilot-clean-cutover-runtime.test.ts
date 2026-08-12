import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import {
  addGroupStudents,
  assignTeacherGrade,
  completePasspilotClassMigration,
  createGrade,
  createGroup,
  createLegacyPass,
  createProductLicense,
  createSchool,
  createStudent,
  createUser,
  getPasspilotCleanSchoolCutoverEligibility,
  getSettingsForSchool,
  listPasspilotLegacyClassSourceSchoolIds,
  updateLegacyKioskClass,
  upsertSettings,
} from "../dist/services/storage.js";
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";

const schemaReady = await pool
  .query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'settings'
         AND column_name = 'passpilot_class_source'
     ) AS ready`
  )
  .then((result) => result.rows[0]?.ready === true)
  .catch(() => false);
const runtimeIt = schemaReady ? it : it.skip;

const TAG = `passpilot_clean_cutover_${Date.now()}`;
let actor: any;
let teacher: any;
let cleanSchool: any;
let dirtySchool: any;
let emptySchool: any;
let cleanStudent: any;

function inSchool<T>(schoolId: string, operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, operation);
}

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
}

async function addBothLicenses(schoolId: string): Promise<void> {
  await createProductLicense({ schoolId, product: "PASSPILOT", status: "active" } as any);
  await createProductLicense({ schoolId, product: "CLASSPILOT", status: "active" } as any);
}

before(async () => {
  if (!schemaReady) return;
  await asSystem(async () => {
    actor = await createUser({
      email: `super-admin@${TAG}.example.edu`,
      firstName: "Clean",
      lastName: "Operator",
      isSuperAdmin: true,
    } as any);
    teacher = await createUser({
      email: `teacher@${TAG}.example.edu`,
      firstName: "Clean",
      lastName: "Teacher",
    } as any);
    cleanSchool = await createSchool({
      name: `${TAG}_clean`,
      domain: `${TAG}-clean.example.edu`,
      slug: `${TAG}-clean`,
    } as any);
    dirtySchool = await createSchool({
      name: `${TAG}_dirty`,
      domain: `${TAG}-dirty.example.edu`,
      slug: `${TAG}-dirty`,
    } as any);
    emptySchool = await createSchool({
      name: `${TAG}_empty`,
      domain: `${TAG}-empty.example.edu`,
      slug: `${TAG}-empty`,
    } as any);
    for (const school of [cleanSchool, dirtySchool, emptySchool]) {
      await addBothLicenses(school.id);
      await inSchool(school.id, () =>
        upsertSettings(school.id, {
          schoolName: school.name,
          passpilotClassSource: "legacy_grades",
        })
      );
    }

    await inSchool(cleanSchool.id, async () => {
      cleanStudent = await createStudent({
        schoolId: cleanSchool.id,
        firstName: "Clean",
        lastName: "Student",
        status: "active",
      } as any);
      const group = await createGroup({
        schoolId: cleanSchool.id,
        teacherId: teacher.id,
        name: "Official Clean Class",
        groupType: "admin_class",
        status: "active",
      } as any);
      await addGroupStudents(group.id, [cleanStudent.id]);
    });

    await inSchool(dirtySchool.id, async () => {
      const grade = await createGrade({
        schoolId: dirtySchool.id,
        name: "Legacy Class",
      } as any);
      const student = await createStudent({
        schoolId: dirtySchool.id,
        firstName: "Legacy",
        lastName: "Student",
        gradeId: grade.id,
        status: "active",
      } as any);
      await createGroup({
        schoolId: dirtySchool.id,
        teacherId: teacher.id,
        name: "Official Dirty Class",
        groupType: "admin_class",
        status: "active",
      } as any);
      await assignTeacherGrade(teacher.id, grade.id);
      await updateLegacyKioskClass(dirtySchool.id, grade.id, teacher.id);
      await createLegacyPass({
        schoolId: dirtySchool.id,
        studentId: student.id,
        teacherId: teacher.id,
        gradeId: grade.id,
        destination: "bathroom",
        status: "returned",
        duration: 5,
        expiresAt: new Date(Date.now() + 300_000),
        returnedAt: new Date(),
        issuedVia: "teacher",
      } as any, { actorUserId: teacher.id, manager: false });
      await upsertSettings(dirtySchool.id, {
        schoolName: dirtySchool.name,
        passpilotClassSource: "legacy_grades",
        passpilotCanonicalWritesAt: new Date(),
        passpilotClassCutoverAt: new Date(),
      });
    });
  });
});

after(async () => {
  if (!schemaReady) {
    await pool.end();
    return;
  }
  await asSystem(async () => {
    const schoolIds = [cleanSchool?.id, dirtySchool?.id, emptySchool?.id].filter(Boolean);
    if (schoolIds.length > 0) {
      const list = sql.join(schoolIds.map((id) => sql`${id}`), sql`, `);
      await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM passes WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${list}))`);
      await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${list}))`);
      await db.execute(sql`DELETE FROM groups WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM teacher_grades WHERE grade_id IN (SELECT id FROM grades WHERE school_id IN (${list}))`);
      await db.execute(sql`DELETE FROM grades WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM students WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM settings WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${list})`);
    }
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
  });
  await pool.end();
});

describe("PassPilot clean-school cutover storage guard", () => {
  runtimeIt("reports exact clean and dirty state without changing the source", async () => {
    const { clean, dirty, empty, candidates } = await asSystem(async () => ({
      clean: await getPasspilotCleanSchoolCutoverEligibility(cleanSchool.id),
      dirty: await getPasspilotCleanSchoolCutoverEligibility(dirtySchool.id),
      empty: await getPasspilotCleanSchoolCutoverEligibility(emptySchool.id),
      candidates: await listPasspilotLegacyClassSourceSchoolIds(),
    }));
    assert.equal(clean.eligible, true);
    assert.equal(clean.counts.activeOfficialClasses, 1);
    assert.equal(clean.counts.passes, 0);
    assert.equal(dirty.eligible, false);
    assert.ok(dirty.reasons.includes("legacy_grades_present"));
    assert.ok(dirty.reasons.includes("passes_present"));
    assert.ok(dirty.reasons.includes("student_grade_assignments_present"));
    assert.ok(dirty.reasons.includes("teacher_grade_assignments_present"));
    assert.ok(dirty.reasons.includes("kiosk_selection_present"));
    assert.ok(dirty.reasons.includes("prior_canonical_write_present"));
    assert.ok(dirty.reasons.includes("prior_cutover_marker_present"));
    assert.equal(empty.eligible, false);
    assert.ok(empty.reasons.includes("active_official_class_required"));
    assert.ok(candidates.includes(cleanSchool.id));
    assert.ok(candidates.includes(dirtySchool.id));
    assert.ok(candidates.includes(emptySchool.id));
    assert.equal((await inSchool(cleanSchool.id, () => getSettingsForSchool(cleanSchool.id)))?.passpilotClassSource, "legacy_grades");
  });

  runtimeIt("rechecks clean state in the cutover transaction and audits the explicit cutover", async () => {
    await inSchool(cleanSchool.id, async () => {
      const initial = await getPasspilotCleanSchoolCutoverEligibility(cleanSchool.id);
      assert.equal(initial.eligible, true);
      const historicalPass = await createLegacyPass({
        schoolId: cleanSchool.id,
        studentId: cleanStudent.id,
        teacherId: teacher.id,
        gradeId: null,
        destination: "office",
        status: "returned",
        duration: 5,
        expiresAt: new Date(Date.now() + 300_000),
        returnedAt: new Date(),
        issuedVia: "teacher",
      } as any, { manager: true });
      await assert.rejects(
        completePasspilotClassMigration(
          cleanSchool.id,
          actor.id,
          initial.revision!,
          true,
          true
        ),
        (error: any) => error?.code === "PASSPILOT_CLEAN_CUTOVER_INELIGIBLE"
      );
      assert.equal((await getSettingsForSchool(cleanSchool.id))?.passpilotClassSource, "legacy_grades");

      await db.execute(sql`DELETE FROM passes WHERE id = ${historicalPass.id} AND school_id = ${cleanSchool.id}`);
      const rechecked = await getPasspilotCleanSchoolCutoverEligibility(cleanSchool.id);
      assert.equal(rechecked.eligible, true);
      await assert.rejects(
        completePasspilotClassMigration(
          cleanSchool.id,
          actor.id,
          rechecked.revision!,
          false,
          true
        ),
        (error: any) => error?.code === "PASSPILOT_CLASS_MODEL_ACKNOWLEDGEMENT_REQUIRED"
      );
      const completed = await completePasspilotClassMigration(
        cleanSchool.id,
        actor.id,
        rechecked.revision!,
        true,
        true
      );
      assert.equal(completed.source, "classpilot_groups");
    });

    const candidates = await asSystem(() => listPasspilotLegacyClassSourceSchoolIds());
    assert.equal(candidates.includes(cleanSchool.id), false);
    const auditResult = await asSystem(() => db.execute(sql`
      SELECT changes
      FROM audit_logs
      WHERE school_id = ${cleanSchool.id}
        AND action = 'passpilot.class_migration.completed'
      ORDER BY created_at DESC
      LIMIT 1
    `));
    const audit = (auditResult as unknown as { rows: Array<{ changes: { requireClean?: boolean } }> }).rows[0];
    assert.ok(audit);
    assert.equal(audit.changes.requireClean, true);
  });

  runtimeIt("never lets dirty or zero-class schools use the guarded completion path", async () => {
    for (const school of [dirtySchool, emptySchool]) {
      await inSchool(school.id, async () => {
        const eligibility = await getPasspilotCleanSchoolCutoverEligibility(school.id);
        await assert.rejects(
          completePasspilotClassMigration(
            school.id,
            actor.id,
            eligibility.revision!,
            true,
            true
          ),
          (error: any) => error?.code === "PASSPILOT_CLEAN_CUTOVER_INELIGIBLE"
        );
        assert.equal((await getSettingsForSchool(school.id))?.passpilotClassSource, "legacy_grades");
      });
    }
  });
});
