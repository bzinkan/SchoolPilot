import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { sql } from "drizzle-orm";

// Exercise the compiled storage layer because that is the artifact shipped by
// the API image. CI builds before running the test suite.
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  addHomeroomTeacher,
  createFamilyGroupWithStudents,
  createHomeroomWithPrimaryTeacher,
  createMembership,
  createSchool,
  createStudent,
  createUser,
  deleteFamilyGroup,
  deleteHomeroom,
} from "../dist/services/storage.js";

const TAG = `gdfk_${Date.now().toString(36)}_${process.pid}`;
const ids = {
  schoolA: `${TAG}_school_a`,
  schoolB: `${TAG}_school_b`,
  primaryTeacher: `${TAG}_primary`,
  coTeacher: `${TAG}_co`,
  primaryMembership: `${TAG}_primary_membership`,
  coMembership: `${TAG}_co_membership`,
  homeroom: `${TAG}_homeroom`,
  studentOne: `${TAG}_student_one`,
  studentTwo: `${TAG}_student_two`,
  familyGroup: `${TAG}_family`,
};

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

async function homeroomState() {
  return asSystem(async () => {
    const [homeroom, teachers, assignedStudents] = await Promise.all([
      db.execute(sql`
        SELECT id, school_id
        FROM homerooms
        WHERE id = ${ids.homeroom}
      `),
      db.execute(sql`
        SELECT id, school_id, homeroom_id, teacher_id, role
        FROM homeroom_teachers
        WHERE homeroom_id = ${ids.homeroom}
        ORDER BY teacher_id
      `),
      db.execute(sql`
        SELECT id, school_id, homeroom_id
        FROM students
        WHERE id IN (${ids.studentOne}, ${ids.studentTwo})
        ORDER BY id
      `),
    ]);
    return {
      homeroom: homeroom.rows,
      teachers: teachers.rows,
      assignedStudents: assignedStudents.rows,
    };
  });
}

async function familyGroupState() {
  return asSystem(async () => {
    const [group, students] = await Promise.all([
      db.execute(sql`
        SELECT id, school_id
        FROM family_groups
        WHERE id = ${ids.familyGroup}
      `),
      db.execute(sql`
        SELECT id, school_id, family_group_id, student_id
        FROM family_group_students
        WHERE family_group_id = ${ids.familyGroup}
        ORDER BY student_id
      `),
    ]);
    return { group: group.rows, students: students.rows };
  });
}

before(async () => {
  await createSchool({
    id: ids.schoolA,
    name: `${TAG} School A`,
    domain: `${TAG}-a.example.edu`,
    slug: `${TAG}-a`,
  } as any);
  await createSchool({
    id: ids.schoolB,
    name: `${TAG} School B`,
    domain: `${TAG}-b.example.edu`,
    slug: `${TAG}-b`,
  } as any);

  const primary = await createUser({
    id: ids.primaryTeacher,
    email: `primary@${TAG}-a.example.edu`,
    firstName: "Primary",
    lastName: "Teacher",
  } as any);
  const coTeacher = await createUser({
    id: ids.coTeacher,
    email: `co@${TAG}-a.example.edu`,
    firstName: "Co",
    lastName: "Teacher",
  } as any);
  await createMembership({
    id: ids.primaryMembership,
    userId: primary.id,
    schoolId: ids.schoolA,
    role: "teacher",
    gopilotRole: "teacher",
    status: "active",
  } as any);
  await createMembership({
    id: ids.coMembership,
    userId: coTeacher.id,
    schoolId: ids.schoolA,
    role: "teacher",
    gopilotRole: "teacher",
    status: "active",
  } as any);

  await inSchool(ids.schoolA, async () => {
    const homeroom = await createHomeroomWithPrimaryTeacher({
      id: ids.homeroom,
      schoolId: ids.schoolA,
      teacherId: primary.id,
      name: `${TAG} Homeroom`,
      grade: "5",
    } as any);
    await addHomeroomTeacher(homeroom.id, coTeacher.id, "co-teacher");

    await createStudent({
      id: ids.studentOne,
      schoolId: ids.schoolA,
      firstName: "Student",
      lastName: "One",
      homeroomId: homeroom.id,
      status: "active",
    } as any);
    await createStudent({
      id: ids.studentTwo,
      schoolId: ids.schoolA,
      firstName: "Student",
      lastName: "Two",
      homeroomId: homeroom.id,
      status: "active",
    } as any);

    await createFamilyGroupWithStudents({
      id: ids.familyGroup,
      schoolId: ids.schoolA,
      carNumber: `${TAG}-car`,
      familyName: `${TAG} Family`,
    } as any, [ids.studentOne, ids.studentTwo]);
  });
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`
        DELETE FROM family_group_students
        WHERE family_group_id = ${ids.familyGroup}
           OR school_id IN (${ids.schoolA}, ${ids.schoolB})
      `);
      await db.execute(sql`
        DELETE FROM family_groups
        WHERE id = ${ids.familyGroup}
           OR school_id IN (${ids.schoolA}, ${ids.schoolB})
      `);
      await db.execute(sql`
        DELETE FROM homeroom_teachers
        WHERE homeroom_id = ${ids.homeroom}
           OR school_id IN (${ids.schoolA}, ${ids.schoolB})
      `);
      await db.execute(sql`
        UPDATE students
        SET homeroom_id = NULL
        WHERE homeroom_id = ${ids.homeroom}
      `);
      await db.execute(sql`
        DELETE FROM homerooms
        WHERE id = ${ids.homeroom}
           OR school_id IN (${ids.schoolA}, ${ids.schoolB})
      `);
      await db.execute(sql`
        DELETE FROM students
        WHERE id IN (${ids.studentOne}, ${ids.studentTwo})
           OR school_id IN (${ids.schoolA}, ${ids.schoolB})
      `);
      await db.execute(sql`
        DELETE FROM school_memberships
        WHERE id IN (${ids.primaryMembership}, ${ids.coMembership})
           OR school_id IN (${ids.schoolA}, ${ids.schoolB})
      `);
      await db.execute(sql`
        DELETE FROM schools
        WHERE id IN (${ids.schoolA}, ${ids.schoolB})
      `);
      await db.execute(sql`
        DELETE FROM users
        WHERE id IN (${ids.primaryTeacher}, ${ids.coTeacher})
      `);
    });
  } finally {
    await pool.end();
  }
});

describe("GoPilot setup deletion tenant-FK cleanup", { concurrency: false }, () => {
  it("deletes a same-school homeroom only after clearing teachers and detaching students", async () => {
    const beforeWrongSchoolDelete = await homeroomState();
    assert.equal(beforeWrongSchoolDelete.homeroom.length, 1);
    assert.equal(beforeWrongSchoolDelete.teachers.length, 2);
    assert.deepEqual(
      beforeWrongSchoolDelete.assignedStudents.map((row: any) => row.homeroom_id),
      [ids.homeroom, ids.homeroom]
    );

    const wrongSchoolDeleted = await inSchool(ids.schoolB, () =>
      deleteHomeroom(ids.homeroom, ids.schoolB)
    );
    assert.equal(wrongSchoolDeleted, false);
    assert.deepEqual(await homeroomState(), beforeWrongSchoolDelete);

    const deleted = await inSchool(ids.schoolA, () =>
      deleteHomeroom(ids.homeroom, ids.schoolA)
    );
    assert.equal(deleted, true);

    const afterDelete = await homeroomState();
    assert.deepEqual(afterDelete.homeroom, []);
    assert.deepEqual(afterDelete.teachers, []);
    assert.equal(afterDelete.assignedStudents.length, 2);
    assert.deepEqual(
      afterDelete.assignedStudents.map((row: any) => row.homeroom_id),
      [null, null]
    );
  });

  it("deletes a same-school family group only after clearing its student links", async () => {
    const beforeWrongSchoolDelete = await familyGroupState();
    assert.equal(beforeWrongSchoolDelete.group.length, 1);
    assert.equal(beforeWrongSchoolDelete.students.length, 2);

    const wrongSchoolDeleted = await inSchool(ids.schoolB, () =>
      deleteFamilyGroup(ids.familyGroup, ids.schoolB)
    );
    assert.equal(wrongSchoolDeleted, false);
    assert.deepEqual(await familyGroupState(), beforeWrongSchoolDelete);

    const deleted = await inSchool(ids.schoolA, () =>
      deleteFamilyGroup(ids.familyGroup, ids.schoolA)
    );
    assert.equal(deleted, true);

    const afterDelete = await familyGroupState();
    assert.deepEqual(afterDelete.group, []);
    assert.deepEqual(afterDelete.students, []);
  });
});
