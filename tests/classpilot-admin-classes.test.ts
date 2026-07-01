import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  addGroupStudentsDetailed,
  archiveGroup,
  createGroup,
  createMembership,
  createSchool,
  createStudent,
  createTeachingSession,
  createUser,
  findOverlappingScheduledAdminClass,
  getAdminClassSummariesBySchool,
  getGroupByIdAndSchool,
  getGroupStudents,
  getGroupTeacherSummaries,
  groupHasTeachingHistory,
  hardDeleteGroupWithCleanup,
  replaceGroupTeachers,
  updateAdminClassWithTeachers,
  upsertAdminClassroomClass,
  upsertClassroomCourse,
  upsertClassroomCourseStudents,
  getClassroomCourseStudents,
} from "../dist/services/storage.js";
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";

const TAG = `admin_class_${Date.now()}`;
let school: any;
let admin: any;
let teacherA: any;
let teacherB: any;
let teacherC: any;
let studentA: any;
let studentB: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

before(async () => {
  await asSystem(async () => {
    await db.execute(sql`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'live'`);
    await db.execute(sql`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_conflict_id TEXT`);
  });
  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
  } as any);
  admin = await createUser({ email: `admin@${TAG}.example.edu`, firstName: "Ada", lastName: "Admin" } as any);
  teacherA = await createUser({ email: `teacher-a@${TAG}.example.edu`, firstName: "Tara", lastName: "Alpha" } as any);
  teacherB = await createUser({ email: `teacher-b@${TAG}.example.edu`, firstName: "Terry", lastName: "Beta" } as any);
  teacherC = await createUser({ email: `teacher-c@${TAG}.example.edu`, firstName: "Casey", lastName: "Co" } as any);
  await createMembership({ userId: admin.id, schoolId: school.id, role: "admin", status: "active" } as any);
  await createMembership({ userId: teacherA.id, schoolId: school.id, role: "teacher", status: "active" } as any);
  await createMembership({ userId: teacherB.id, schoolId: school.id, role: "teacher", status: "active" } as any);
  await createMembership({ userId: teacherC.id, schoolId: school.id, role: "school_admin", status: "active" } as any);
  studentA = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Student",
    lastName: "One",
    email: `one@${TAG}.example.edu`,
    gradeLevel: "8",
  } as any));
  studentB = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Student",
    lastName: "Two",
    email: `two@${TAG}.example.edu`,
    gradeLevel: "8",
  } as any));
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM teaching_sessions WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classroom_course_students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classroom_courses WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
    });
  } catch {
    /* best-effort cleanup */
  }
  await pool.end();
});

describe("ClassPilot admin class management storage contracts", () => {
  it("reassigns the primary teacher and staged co-teachers transactionally", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Science`,
      groupType: "admin_class",
      gradeLevel: "8",
      status: "active",
    } as any));
    await inSchool(school.id, () => replaceGroupTeachers(group.id, teacherA.id, [teacherC.id]));

    const updated = await inSchool(school.id, () => updateAdminClassWithTeachers({
      groupId: group.id,
      data: { name: `${TAG}_Science Updated` },
      primaryTeacherId: teacherB.id,
      coTeacherIds: [teacherC.id],
    }));

    assert.equal(updated?.teacherId, teacherB.id);
    const fetched = await inSchool(school.id, () => getGroupByIdAndSchool(group.id, school.id));
    assert.equal(fetched?.teacherId, teacherB.id);

    const teachers = await inSchool(school.id, () => getGroupTeacherSummaries(group.id, school.id));
    assert.deepEqual(
      teachers.map((entry) => [entry.teacherId, entry.relationshipRole]).sort(),
      [[teacherB.id, "primary"], [teacherC.id, "co-teacher"]].sort()
    );
  });

  it("batch roster assignment is idempotent and reports already-present students", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Roster`,
      groupType: "admin_class",
      status: "active",
    } as any));

    const first = await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentA.id, studentB.id]));
    assert.equal(first.added.length, 2);
    assert.equal(first.alreadyPresent.length, 0);

    const second = await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentA.id, studentB.id]));
    assert.equal(second.added.length, 0);
    assert.deepEqual(new Set(second.alreadyPresent), new Set([studentA.id, studentB.id]));

    const roster = await inSchool(school.id, () => getGroupStudents(group.id));
    assert.equal(roster.length, 2);
  });

  it("upserts Google Classroom classes and enrollment mappings idempotently", async () => {
    const course = await inSchool(school.id, () => upsertClassroomCourse({
      schoolId: school.id,
      googleCourseId: `${TAG}_google_course`,
      name: `${TAG}_Google Science`,
      section: "8A",
      lastSyncedAt: new Date(),
    } as any));

    const first = await inSchool(school.id, () => upsertAdminClassroomClass({
      schoolId: school.id,
      data: {
        schoolId: school.id,
        teacherId: teacherA.id,
        name: `${TAG}_Google Science`,
        groupType: "admin_class",
        status: "active",
        gradeLevel: "8",
        googleClassroomCourseId: `${TAG}_google_course`,
      } as any,
      primaryTeacherId: teacherA.id,
      coTeacherIds: [teacherC.id],
      studentIds: [studentA.id],
    }));

    assert.equal(first.group.teacherId, teacherA.id);
    assert.equal(first.roster.added.length, 1);

    await inSchool(school.id, () => upsertClassroomCourseStudents([{
      schoolId: school.id,
      courseId: course.id,
      studentId: studentA.id,
      googleUserId: "google-student-a",
      studentEmailLc: studentA.email.toLowerCase(),
      lastSeenAt: new Date(),
    } as any]));
    await inSchool(school.id, () => upsertClassroomCourseStudents([{
      schoolId: school.id,
      courseId: course.id,
      studentId: studentA.id,
      googleUserId: "google-student-a-updated",
      studentEmailLc: studentA.email.toLowerCase(),
      lastSeenAt: new Date(),
    } as any]));
    const courseStudents = await inSchool(school.id, () => getClassroomCourseStudents(course.id));
    assert.equal(courseStudents.length, 1);
    assert.equal(courseStudents[0]?.googleUserId, "google-student-a-updated");

    const second = await inSchool(school.id, () => upsertAdminClassroomClass({
      schoolId: school.id,
      existingGroupId: first.group.id,
      data: {
        schoolId: school.id,
        teacherId: teacherB.id,
        name: `${TAG}_Google Science Updated`,
        groupType: "admin_class",
        status: "active",
        gradeLevel: "8",
        googleClassroomCourseId: `${TAG}_google_course`,
      } as any,
      primaryTeacherId: teacherB.id,
      coTeacherIds: [],
      studentIds: [studentA.id, studentB.id],
    }));

    assert.equal(second.group.id, first.group.id);
    assert.equal(second.group.teacherId, teacherB.id);
    assert.deepEqual(second.roster.added, [studentB.id]);
    assert.deepEqual(second.roster.alreadyPresent, [studentA.id]);
    const teachers = await inSchool(school.id, () => getGroupTeacherSummaries(first.group.id, school.id));
    assert.deepEqual(teachers.map((entry) => [entry.teacherId, entry.relationshipRole]), [[teacherB.id, "primary"]]);
  });

  it("archives classes and exposes aggregate student counts", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Archive`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentA.id]));

    const summaries = await inSchool(school.id, () => getAdminClassSummariesBySchool(school.id, { status: "active", search: `${TAG}_Archive` }));
    assert.equal(summaries[0]?.studentCount, 1);

    const archived = await inSchool(school.id, () => archiveGroup(group.id));
    assert.equal(archived?.status, "archived");
    assert.ok(archived?.archivedAt);

    const activeAfterArchive = await inSchool(school.id, () => getAdminClassSummariesBySchool(school.id, { status: "active", search: `${TAG}_Archive` }));
    assert.equal(activeAfterArchive.length, 0);
    const archivedSummaries = await inSchool(school.id, () => getAdminClassSummariesBySchool(school.id, { status: "archived", search: `${TAG}_Archive` }));
    assert.equal(archivedSummaries.length, 1);
  });

  it("detects teacher schedule overlaps and teaching history", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Scheduled`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "09:00",
      blockEndTime: "10:00",
    } as any));

    const overlap = await inSchool(school.id, () => findOverlappingScheduledAdminClass({
      schoolId: school.id,
      teacherId: teacherA.id,
      blockStartTime: "09:30",
      blockEndTime: "10:30",
    }));
    assert.equal(overlap?.id, group.id);

    await inSchool(school.id, () => createTeachingSession({ groupId: group.id, teacherId: teacherA.id } as any));
    assert.equal(await inSchool(school.id, () => groupHasTeachingHistory(group.id)), true);

    const empty = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacherA.id,
      name: `${TAG}_Empty`,
      groupType: "admin_class",
      status: "archived",
    } as any));
    assert.equal(await inSchool(school.id, () => hardDeleteGroupWithCleanup(empty.id)), true);
    assert.equal(await inSchool(school.id, () => getGroupByIdAndSchool(empty.id, school.id)), undefined);
  });
});
