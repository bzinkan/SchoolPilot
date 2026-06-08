import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Uses Node's built-in test runner (run via `tsx` loader — no extra deps, so no
// added audit surface). Imports the COMPILED output so we exercise exactly what
// ships and avoid .js-extension ESM resolution of source .ts. CI builds first.
import {
  createSchool,
  createUser,
  createGroup,
  createTeachingSession,
  getGroupByIdAndSchool,
  getGroupsByTeacherAndSchool,
  createFlightPath,
  getFlightPathById,
  createBlockList,
  getBlockListById,
  createStudent,
  createGrade,
  getGradeById,
  createDashboardTab,
  getDashboardTabs,
  createMembership,
  upsertGoogleOAuthToken,
  getGoogleOAuthTokenForSchool,
  updateEnrollmentSettings,
  getSettingsForSchool,
  createDevice,
  linkStudentDevice,
} from "../dist/services/storage.js";
import {
  scopedDeviceTargets,
  deviceBelongsToSchoolAndStudent,
} from "../dist/services/classpilotDeviceScope.js";
import { pool } from "../dist/db.js";

// Cross-tenant isolation regression suite. Seeds two schools and asserts the
// school-scoped storage helpers never return one school's resource to the other,
// and that legitimate same-school access still works (no over-blocking). Durable
// guard against the IDOR class fixed in the 2026-06 isolation sweep.

const TAG = `xtest_${Date.now()}`;
let schoolA: any;
let schoolB: any;
let schoolShared: any;
let teacher: any;

before(async () => {
  schoolA = await createSchool({ name: `${TAG}_A`, domain: `${TAG}-a.example.edu`, slug: `${TAG}-a` } as any);
  schoolB = await createSchool({ name: `${TAG}_B`, domain: `${TAG}-b.example.edu`, slug: `${TAG}-b` } as any);
  schoolShared = await createSchool({ name: `${TAG}_Shared`, domain: `${TAG}-a.example.edu`, slug: `${TAG}-shared` } as any);
  teacher = await createUser({ email: `${TAG}-teacher@example.edu`, firstName: "T", lastName: "Teacher" } as any);
});

after(async () => {
  try {
    await pool.query(`DELETE FROM google_oauth_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`${TAG}%@%`]);
    await pool.query(`DELETE FROM school_memberships WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE email_lc LIKE $1)`, [`${TAG}%@%`]);
    await pool.query(`DELETE FROM devices WHERE device_id LIKE $1`, [`${TAG}-%`]);
    await pool.query(`DELETE FROM settings WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM dashboard_tabs WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM flight_paths WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM block_lists WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1))`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1))`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM teaching_sessions WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM grades WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM students WHERE school_id IN (SELECT id FROM schools WHERE name LIKE $1)`, [`${TAG}_%`]);
    await pool.query(`DELETE FROM schools WHERE name LIKE 'xtest_%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'xtest_%@example.edu'`);
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%@%`]);
  } catch {
    /* ignore */
  }
  await pool.end();
});

describe("cross-school isolation", () => {
  it("getGroupByIdAndSchool: own school yes, other school no", async () => {
    const g = await createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_grpA` } as any);
    assert.equal((await getGroupByIdAndSchool(g.id, schoolA.id))?.id, g.id);
    assert.equal(await getGroupByIdAndSchool(g.id, schoolB.id), undefined);
  });

  it("createTeachingSession derives school_id from the parent group (RLS WITH CHECK)", async () => {
    const g = await createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_tsgrp` } as any);
    const ts = await createTeachingSession({ groupId: g.id, teacherId: teacher.id });
    assert.equal(ts.schoolId, schoolA.id);
    assert.notEqual(ts.schoolId, schoolB.id);
  });

  it("getGroupsByTeacherAndSchool partitions a teacher's groups by school", async () => {
    await createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_grpA2` } as any);
    await createGroup({ schoolId: schoolB.id, teacherId: teacher.id, name: `${TAG}_grpB` } as any);
    const inA = await getGroupsByTeacherAndSchool(teacher.id, schoolA.id);
    const inB = await getGroupsByTeacherAndSchool(teacher.id, schoolB.id);
    assert.ok(inA.every((x: any) => x.schoolId === schoolA.id));
    assert.ok(inB.every((x: any) => x.schoolId === schoolB.id));
    assert.ok(!inA.some((x: any) => x.schoolId === schoolB.id));
  });

  it("getFlightPathById is school-scoped", async () => {
    const fp = await createFlightPath({ schoolId: schoolA.id, teacherId: teacher.id, flightPathName: `${TAG}_fp` } as any);
    assert.equal((await getFlightPathById(fp.id, schoolA.id))?.id, fp.id);
    assert.equal(await getFlightPathById(fp.id, schoolB.id), undefined);
  });

  it("getBlockListById is school-scoped", async () => {
    const bl = await createBlockList({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_bl` } as any);
    assert.equal((await getBlockListById(bl.id, schoolA.id))?.id, bl.id);
    assert.equal(await getBlockListById(bl.id, schoolB.id), undefined);
  });

  it("getGradeById exposes the schoolId handlers gate on", async () => {
    const grade = await createGrade({ schoolId: schoolA.id, name: `${TAG}_grade` } as any);
    const fetched = await getGradeById(grade.id);
    assert.equal(fetched?.schoolId, schoolA.id);
    assert.notEqual(fetched?.schoolId, schoolB.id);
  });

  it("getDashboardTabs partitions a teacher's tabs by school", async () => {
    await createDashboardTab({ teacherId: teacher.id, schoolId: schoolA.id, label: `${TAG}_tabA`, filterType: "all" } as any);
    await createDashboardTab({ teacherId: teacher.id, schoolId: schoolB.id, label: `${TAG}_tabB`, filterType: "all" } as any);
    const inA = await getDashboardTabs(teacher.id, schoolA.id);
    const inB = await getDashboardTabs(teacher.id, schoolB.id);
    assert.ok(inA.every((t: any) => t.schoolId === schoolA.id));
    assert.ok(inB.every((t: any) => t.schoolId === schoolB.id));
    assert.ok(!inA.some((t: any) => t.schoolId === schoolB.id));
  });

  it("a student created in School A carries School A's id, not B's", async () => {
    const s = await createStudent({
      schoolId: schoolA.id,
      firstName: "S",
      lastName: "One",
      email: `${TAG}-s1@example.edu`,
      emailLc: `${TAG}-s1@example.edu`,
      status: "active",
    } as any);
    assert.equal(s.schoolId, schoolA.id);
    assert.notEqual(s.schoolId, schoolB.id);
  });

  it("Google OAuth tokens must match the selected school domain, while shared domains are allowed", async () => {
    const googleAdmin = await createUser({ email: `${TAG}-google@${TAG}-a.example.edu`, firstName: "G", lastName: "Admin" } as any);
    await upsertGoogleOAuthToken(googleAdmin.id, {
      refreshToken: `${TAG}-refresh`,
      scope: "openid email https://www.googleapis.com/auth/classroom.courses.readonly",
      connectedEmail: `admin@${TAG}-a.example.edu`,
      connectedDomain: `${TAG}-a.example.edu`,
    });

    assert.equal((await getGoogleOAuthTokenForSchool(googleAdmin.id, schoolA.id))?.userId, googleAdmin.id);
    assert.equal((await getGoogleOAuthTokenForSchool(googleAdmin.id, schoolShared.id))?.userId, googleAdmin.id);
    await assert.rejects(
      () => getGoogleOAuthTokenForSchool(googleAdmin.id, schoolB.id),
      (err: any) => err?.code === "GOOGLE_DOMAIN_MISMATCH"
    );
  });

  it("staff memberships require the school's email domain but parent memberships do not", async () => {
    const matchingTeacher = await createUser({ email: `${TAG}-teacher@${TAG}-a.example.edu`, firstName: "T", lastName: "Match" } as any);
    const outsideUser = await createUser({ email: `${TAG}-outside@outside.example.edu`, firstName: "O", lastName: "User" } as any);

    const membership = await createMembership({ userId: matchingTeacher.id, schoolId: schoolA.id, role: "teacher", status: "active" } as any);
    assert.equal(membership.schoolId, schoolA.id);

    await assert.rejects(
      () => createMembership({ userId: outsideUser.id, schoolId: schoolA.id, role: "teacher", status: "active" } as any),
      (err: any) => err?.code === "STAFF_EMAIL_DOMAIN_MISMATCH"
    );

    const parentMembership = await createMembership({ userId: outsideUser.id, schoolId: schoolA.id, role: "parent", status: "active" } as any);
    assert.equal(parentMembership.role, "parent");
  });

  it("device target helpers filter to school-owned devices and enforce student-device pairing", async () => {
    const studentA = await createStudent({
      schoolId: schoolA.id,
      firstName: "Device",
      lastName: "Owner",
      email: `${TAG}-device-student@${TAG}-a.example.edu`,
      emailLc: `${TAG}-device-student@${TAG}-a.example.edu`,
      status: "active",
    } as any);
    await createDevice({ deviceId: `${TAG}-device-a`, schoolId: schoolA.id, classId: "default", deviceName: "A" } as any);
    await createDevice({ deviceId: `${TAG}-device-b`, schoolId: schoolB.id, classId: "default", deviceName: "B" } as any);
    await linkStudentDevice({ studentId: studentA.id, deviceId: `${TAG}-device-a` });

    const scoped = await scopedDeviceTargets([`${TAG}-device-a`, `${TAG}-device-b`, `${TAG}-missing`], schoolA.id);
    assert.deepEqual(scoped.deviceIds, [`${TAG}-device-a`]);
    assert.equal(scoped.rejectedDeviceCount, 2);
    assert.equal(await deviceBelongsToSchoolAndStudent(`${TAG}-device-a`, schoolA.id, studentA.id), `${TAG}-device-a`);
    assert.equal(await deviceBelongsToSchoolAndStudent(`${TAG}-device-b`, schoolA.id, studentA.id), undefined);
  });

  it("updateEnrollmentSettings creates missing settings rows for legacy schools", async () => {
    await pool.query(`DELETE FROM settings WHERE school_id = $1`, [schoolB.id]);
    await updateEnrollmentSettings(schoolB.id, { autoEnrollStudents: true });
    const settings = await getSettingsForSchool(schoolB.id);
    assert.equal(settings?.autoEnrollStudents, true);
  });
});
