import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

// Uses Node's built-in test runner (run via `tsx` loader — no extra deps, so no
// added audit surface). Imports the COMPILED output so we exercise exactly what
// ships and avoid .js-extension ESM resolution of source .ts. CI builds first.
import {
  createSchool,
  createUser,
  createGroup,
  createTeachingSession,
  createSubgroup,
  assignTeacherStudent,
  getGroupByIdAndSchool,
  getGroupsByTeacherAndSchool,
  createFlightPath,
  getFlightPathById,
  createBlockList,
  getBlockListById,
  createStudent,
  getStudentByEmail,
  searchStudents,
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
  setActiveStudentForDevice,
  getActiveSessionsForStudents,
  createHomeroom,
  getHomeroomsBySchool,
  createFamilyGroup,
  getFamilyGroupsBySchool,
  createParentStudentLink,
  getParentStudentLinks,
  createMessage,
  getMessagesBySchool,
  getMessageByIdAndSchool,
  deleteMessage,
} from "../dist/services/storage.js";
import {
  scopedDeviceTargets,
  deviceBelongsToSchoolAndStudent,
} from "../dist/services/classpilotDeviceScope.js";
import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";

// Cross-tenant isolation regression suite. Seeds two schools and asserts the
// school-scoped storage helpers never return one school's resource to the other,
// and that legitimate same-school access still works (no over-blocking). Durable
// guard against the IDOR class fixed in the 2026-06 isolation sweep.

const TAG = `xtest_${Date.now()}`;
let schoolA: any;
let schoolB: any;
let schoolShared: any;
let teacher: any;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

before(async () => {
  schoolA = await createSchool({ name: `${TAG}_A`, domain: `${TAG}-a.example.edu`, slug: `${TAG}-a` } as any);
  schoolB = await createSchool({ name: `${TAG}_B`, domain: `${TAG}-b.example.edu`, slug: `${TAG}-b` } as any);
  schoolShared = await createSchool({ name: `${TAG}_Shared`, domain: `${TAG}-a.example.edu`, slug: `${TAG}-shared` } as any);
  teacher = await createUser({ email: `${TAG}-teacher@example.edu`, firstName: "T", lastName: "Teacher" } as any);
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM google_oauth_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${TAG}%@%`})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE email_lc LIKE ${`${TAG}%@%`}) OR device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE email_lc LIKE ${`${TAG}%@%`})`);
      await db.execute(sql`DELETE FROM devices WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM settings WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM dashboard_tabs WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM flight_paths WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM block_lists WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`}))`);
      await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`}))`);
      await db.execute(sql`DELETE FROM subgroups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM teacher_students WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM messages WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM parent_student WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM family_group_students WHERE family_group_id IN (SELECT id FROM family_groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`}))`);
      await db.execute(sql`DELETE FROM family_groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM homeroom_teachers WHERE homeroom_id IN (SELECT id FROM homerooms WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`}))`);
      await db.execute(sql`DELETE FROM homerooms WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM groups WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM grades WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM students WHERE school_id IN (SELECT id FROM schools WHERE name LIKE ${`${TAG}_%`})`);
      await db.execute(sql`DELETE FROM schools WHERE name LIKE 'xtest_%'`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE 'xtest_%@example.edu'`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${TAG}%@%`}`);
    });
  } catch {
    /* ignore */
  }
  await pool.end();
});

describe("cross-school isolation", () => {
  it("getGroupByIdAndSchool: own school yes, other school no", async () => {
    const g = await inSchool(schoolA.id, () =>
      createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_grpA` } as any)
    );
    assert.equal((await inSchool(schoolA.id, () => getGroupByIdAndSchool(g.id, schoolA.id)))?.id, g.id);
    assert.equal(await inSchool(schoolB.id, () => getGroupByIdAndSchool(g.id, schoolB.id)), undefined);
  });

  it("createTeachingSession derives school_id from the parent group (RLS WITH CHECK)", async () => {
    const g = await inSchool(schoolA.id, () =>
      createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_tsgrp` } as any)
    );
    const ts = await inSchool(schoolA.id, () => createTeachingSession({ groupId: g.id, teacherId: teacher.id }));
    assert.equal(ts.schoolId, schoolA.id);
    assert.notEqual(ts.schoolId, schoolB.id);
  });

  it("createSubgroup derives school_id from the parent group (RLS WITH CHECK)", async () => {
    const g = await inSchool(schoolA.id, () =>
      createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_sgGrp` } as any)
    );
    const sg = await inSchool(schoolA.id, () => createSubgroup({ groupId: g.id, name: `${TAG}_sg` } as any));
    assert.equal(sg.schoolId, schoolA.id);
  });

  it("assignTeacherStudent derives school_id from the student (RLS WITH CHECK)", async () => {
    const s = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "AT",
        lastName: "S",
        email: `${TAG}-ats@example.edu`,
        emailLc: `${TAG}-ats@example.edu`,
        status: "active",
      } as any)
    );
    const ts = await inSchool(schoolA.id, () => assignTeacherStudent(teacher.id, s.id));
    assert.equal(ts.schoolId, schoolA.id);
  });

  it("getGroupsByTeacherAndSchool partitions a teacher's groups by school", async () => {
    const groupA = await inSchool(schoolA.id, () =>
      createGroup({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_grpA2` } as any)
    );
    const groupB = await inSchool(schoolB.id, () =>
      createGroup({ schoolId: schoolB.id, teacherId: teacher.id, name: `${TAG}_grpB` } as any)
    );
    const inA = await inSchool(schoolA.id, () => getGroupsByTeacherAndSchool(teacher.id, schoolA.id));
    const inB = await inSchool(schoolB.id, () => getGroupsByTeacherAndSchool(teacher.id, schoolB.id));
    assert.ok(inA.some((x: any) => x.id === groupA.id));
    assert.ok(inB.some((x: any) => x.id === groupB.id));
    assert.ok(!inA.some((x: any) => x.id === groupB.id));
    assert.ok(inA.every((x: any) => x.schoolId === schoolA.id));
    assert.ok(inB.every((x: any) => x.schoolId === schoolB.id));
    assert.ok(!inA.some((x: any) => x.schoolId === schoolB.id));
  });

  it("getFlightPathById is school-scoped", async () => {
    const fp = await inSchool(schoolA.id, () =>
      createFlightPath({ schoolId: schoolA.id, teacherId: teacher.id, flightPathName: `${TAG}_fp` } as any)
    );
    assert.equal((await inSchool(schoolA.id, () => getFlightPathById(fp.id, schoolA.id)))?.id, fp.id);
    assert.equal(await inSchool(schoolB.id, () => getFlightPathById(fp.id, schoolB.id)), undefined);
  });

  it("getBlockListById is school-scoped", async () => {
    const bl = await inSchool(schoolA.id, () =>
      createBlockList({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_bl` } as any)
    );
    assert.equal((await inSchool(schoolA.id, () => getBlockListById(bl.id, schoolA.id)))?.id, bl.id);
    assert.equal(await inSchool(schoolB.id, () => getBlockListById(bl.id, schoolB.id)), undefined);
  });

  it("getGradeById exposes the schoolId handlers gate on", async () => {
    const grade = await inSchool(schoolA.id, () => createGrade({ schoolId: schoolA.id, name: `${TAG}_grade` } as any));
    const fetched = await inSchool(schoolA.id, () => getGradeById(grade.id));
    assert.equal(fetched?.schoolId, schoolA.id);
    assert.notEqual(fetched?.schoolId, schoolB.id);
  });

  it("getDashboardTabs partitions a teacher's tabs by school", async () => {
    await inSchool(schoolA.id, () =>
      createDashboardTab({ teacherId: teacher.id, schoolId: schoolA.id, label: `${TAG}_tabA`, filterType: "all" } as any)
    );
    await inSchool(schoolB.id, () =>
      createDashboardTab({ teacherId: teacher.id, schoolId: schoolB.id, label: `${TAG}_tabB`, filterType: "all" } as any)
    );
    const inA = await inSchool(schoolA.id, () => getDashboardTabs(teacher.id, schoolA.id));
    const inB = await inSchool(schoolB.id, () => getDashboardTabs(teacher.id, schoolB.id));
    assert.ok(inA.every((t: any) => t.schoolId === schoolA.id));
    assert.ok(inB.every((t: any) => t.schoolId === schoolB.id));
    assert.ok(!inA.some((t: any) => t.schoolId === schoolB.id));
  });

  it("a student created in School A carries School A's id, not B's", async () => {
    const s = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "S",
        lastName: "One",
        email: `${TAG}-s1@example.edu`,
        emailLc: `${TAG}-s1@example.edu`,
        status: "active",
      } as any)
    );
    assert.equal(s.schoolId, schoolA.id);
    assert.notEqual(s.schoolId, schoolB.id);
  });

  it("extension roster lookup requires an exact email match, not fuzzy search", async () => {
    const targetEmail = `${TAG}-target@${TAG}-a.example.edu`;
    const fuzzyOnlyEmail = `${TAG}-fuzzy-${TAG}-target@${TAG}-a.example.edu`;
    await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Fuzzy",
        lastName: "Only",
        email: fuzzyOnlyEmail,
        emailLc: fuzzyOnlyEmail,
        status: "active",
      } as any)
    );

    const fuzzyResults = await inSchool(schoolA.id, () => searchStudents(schoolA.id, { search: targetEmail }));
    assert.ok(fuzzyResults.some((student: any) => student.emailLc === fuzzyOnlyEmail));
    assert.equal(await inSchool(schoolA.id, () => getStudentByEmail(schoolA.id, targetEmail)), undefined);

    const exact = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Exact",
        lastName: "Match",
        email: targetEmail,
        emailLc: targetEmail,
        status: "active",
      } as any)
    );
    assert.equal((await inSchool(schoolA.id, () => getStudentByEmail(schoolA.id, targetEmail)))?.id, exact.id);
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

  it("homerooms and family groups are school-scoped under tenant context", async () => {
    const hrA = await inSchool(schoolA.id, () =>
      createHomeroom({ schoolId: schoolA.id, teacherId: teacher.id, name: `${TAG}_hrA`, grade: "4" } as any)
    );
    await inSchool(schoolB.id, () =>
      createHomeroom({ schoolId: schoolB.id, teacherId: teacher.id, name: `${TAG}_hrB`, grade: "4" } as any)
    );
    const homeroomsA = await inSchool(schoolA.id, () => getHomeroomsBySchool(schoolA.id));
    const homeroomsB = await inSchool(schoolB.id, () => getHomeroomsBySchool(schoolB.id));
    assert.ok(homeroomsA.some((h: any) => h.id === hrA.id));
    assert.ok(!homeroomsB.some((h: any) => h.id === hrA.id));

    const fgA = await inSchool(schoolA.id, () =>
      createFamilyGroup({ schoolId: schoolA.id, carNumber: `${TAG}-car-a`, familyName: "A" } as any)
    );
    await inSchool(schoolB.id, () =>
      createFamilyGroup({ schoolId: schoolB.id, carNumber: `${TAG}-car-b`, familyName: "B" } as any)
    );
    const familiesA = await inSchool(schoolA.id, () => getFamilyGroupsBySchool(schoolA.id));
    const familiesB = await inSchool(schoolB.id, () => getFamilyGroupsBySchool(schoolB.id));
    assert.ok(familiesA.some((g: any) => g.id === fgA.id));
    assert.ok(!familiesB.some((g: any) => g.id === fgA.id));
  });

  it("parent_student links derive school_id and reject mismatched school writes", async () => {
    const parent = await createUser({ email: `${TAG}-parent@outside.example.edu`, firstName: "P", lastName: "Parent" } as any);
    const student = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Link",
        lastName: "Child",
        email: `${TAG}-link-child@${TAG}-a.example.edu`,
        emailLc: `${TAG}-link-child@${TAG}-a.example.edu`,
        status: "active",
      } as any)
    );

    const link = await inSchool(schoolA.id, () =>
      createParentStudentLink({ parentId: parent.id, studentId: student.id, relationship: "parent", status: "approved" } as any)
    );
    assert.equal(link.schoolId, schoolA.id);

    const links = await inSchool(schoolA.id, () => getParentStudentLinks(parent.id));
    assert.ok(links.some((row: any) => row.id === link.id));
    await assert.rejects(
      () => inSchool(schoolA.id, () =>
        createParentStudentLink({
          parentId: parent.id,
          studentId: student.id,
          schoolId: schoolB.id,
          relationship: "parent",
          status: "approved",
        } as any)
      ),
      (err: any) => err?.code === "STUDENT_SCHOOL_MISMATCH"
    );
  });

  it("legacy messages carry school_id and are school-scoped under RLS", async () => {
    const student = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Msg",
        lastName: "Student",
        email: `${TAG}-msg-student@${TAG}-a.example.edu`,
        emailLc: `${TAG}-msg-student@${TAG}-a.example.edu`,
        status: "active",
      } as any)
    );
    const studentMsg = await inSchool(schoolA.id, () =>
      createMessage({ fromUserId: null, toStudentId: student.id, message: "hello", isAnnouncement: false } as any)
    );
    const announcement = await inSchool(schoolA.id, () =>
      createMessage({ fromUserId: teacher.id, toStudentId: null, message: "class note", isAnnouncement: true } as any, schoolA.id)
    );

    assert.equal(studentMsg.schoolId, schoolA.id);
    assert.equal(announcement.schoolId, schoolA.id);
    assert.equal((await inSchool(schoolA.id, () => getMessageByIdAndSchool(studentMsg.id, schoolA.id)))?.id, studentMsg.id);
    assert.equal(await inSchool(schoolB.id, () => getMessageByIdAndSchool(studentMsg.id, schoolB.id)), undefined);
    const listed = await inSchool(schoolA.id, () => getMessagesBySchool(schoolA.id));
    assert.ok(listed.some((m: any) => m.id === studentMsg.id));
    assert.equal(await inSchool(schoolA.id, () => deleteMessage(announcement.id)), true);
  });

  it("device target helpers filter to school-owned devices and enforce student-device pairing", async () => {
    const studentA = await inSchool(schoolA.id, () =>
      createStudent({
        schoolId: schoolA.id,
        firstName: "Device",
        lastName: "Owner",
        email: `${TAG}-device-student@${TAG}-a.example.edu`,
        emailLc: `${TAG}-device-student@${TAG}-a.example.edu`,
        status: "active",
      } as any)
    );
    await inSchool(schoolA.id, () =>
      createDevice({ deviceId: `${TAG}-device-a`, schoolId: schoolA.id, classId: "default", deviceName: "A" } as any)
    );
    await inSchool(schoolB.id, () =>
      createDevice({ deviceId: `${TAG}-device-b`, schoolId: schoolB.id, classId: "default", deviceName: "B" } as any)
    );
    await inSchool(schoolA.id, () => linkStudentDevice({ studentId: studentA.id, deviceId: `${TAG}-device-a` }));

    const scoped = await inSchool(schoolA.id, () =>
      scopedDeviceTargets([`${TAG}-device-a`, `${TAG}-device-b`, `${TAG}-missing`], schoolA.id)
    );
    assert.deepEqual(scoped.deviceIds, [`${TAG}-device-a`]);
    assert.equal(scoped.rejectedDeviceCount, 2);
    assert.equal(
      await inSchool(schoolA.id, () => deviceBelongsToSchoolAndStudent(`${TAG}-device-a`, schoolA.id, studentA.id)),
      `${TAG}-device-a`
    );
    assert.equal(
      await inSchool(schoolA.id, () => deviceBelongsToSchoolAndStudent(`${TAG}-device-b`, schoolA.id, studentA.id)),
      undefined
    );
  });

  it("batch active-session lookup excludes other-school and mismatched devices", async () => {
    const studentA = await inSchool(schoolA.id, () => createStudent({
      schoolId: schoolA.id,
      firstName: "Session",
      lastName: "Alpha",
      email: `${TAG}-session-a@${TAG}-a.example.edu`,
      emailLc: `${TAG}-session-a@${TAG}-a.example.edu`,
      status: "active",
    } as any));
    const studentB = await inSchool(schoolB.id, () => createStudent({
      schoolId: schoolB.id,
      firstName: "Session",
      lastName: "Beta",
      email: `${TAG}-session-b@${TAG}-b.example.edu`,
      emailLc: `${TAG}-session-b@${TAG}-b.example.edu`,
      status: "active",
    } as any));
    const corruptStudentA = await inSchool(schoolA.id, () => createStudent({
      schoolId: schoolA.id,
      firstName: "Session",
      lastName: "Mismatch",
      email: `${TAG}-session-mismatch@${TAG}-a.example.edu`,
      emailLc: `${TAG}-session-mismatch@${TAG}-a.example.edu`,
      status: "active",
    } as any));
    const deviceA = `${TAG}-session-device-a`;
    const deviceB = `${TAG}-session-device-b`;
    const mismatchedDeviceB = `${TAG}-session-device-b-mismatch`;
    await inSchool(schoolA.id, () => createDevice({ deviceId: deviceA, schoolId: schoolA.id, classId: "default" } as any));
    await inSchool(schoolB.id, () => createDevice({ deviceId: deviceB, schoolId: schoolB.id, classId: "default" } as any));
    await inSchool(schoolB.id, () => createDevice({ deviceId: mismatchedDeviceB, schoolId: schoolB.id, classId: "default" } as any));
    await inSchool(schoolA.id, () => linkStudentDevice({ studentId: studentA.id, deviceId: deviceA }));
    await inSchool(schoolB.id, () => linkStudentDevice({ studentId: studentB.id, deviceId: deviceB }));
    await inSchool(schoolA.id, () => setActiveStudentForDevice(deviceA, studentA.id));
    await inSchool(schoolB.id, () => setActiveStudentForDevice(deviceB, studentB.id));
    await asSystem(() => db.execute(sql`
      INSERT INTO student_sessions (student_id, device_id, is_active)
      VALUES (${corruptStudentA.id}, ${mismatchedDeviceB}, true)
    `).then(() => undefined));

    const requestedIds = [studentA.id, studentB.id, corruptStudentA.id, studentA.id];
    const sessionsA = await inSchool(schoolA.id, () => getActiveSessionsForStudents(schoolA.id, requestedIds));
    const sessionsB = await inSchool(schoolB.id, () => getActiveSessionsForStudents(schoolB.id, requestedIds));
    assert.deepEqual(sessionsA.map((session: any) => session.studentId), [studentA.id]);
    assert.deepEqual(sessionsB.map((session: any) => session.studentId), [studentB.id]);
  });

  it("updateEnrollmentSettings creates missing settings rows for legacy schools", async () => {
    await asSystem(() => db.execute(sql`DELETE FROM settings WHERE school_id = ${schoolB.id}`).then(() => undefined));
    await inSchool(schoolB.id, () => updateEnrollmentSettings(schoolB.id, { autoEnrollStudents: true }));
    const settings = await inSchool(schoolB.id, () => getSettingsForSchool(schoolB.id));
    assert.equal(settings?.autoEnrollStudents, true);
  });
});
