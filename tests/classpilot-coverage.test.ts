import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import { signUserToken } from "../dist/services/jwt.js";
import {
  addGroupStudentsDetailed,
  createCoverageAssignment,
  createCoverageScopeGroup,
  createClasspilotCommandWithTargets,
  createDevice,
  createGroup,
  createMembership,
  createProductLicense,
  createSchool,
  createStudent,
  createSupervisionContextWithStudents,
  createTeachingSession,
  createUser,
  endTeachingSession,
  getActiveCoverageAssignmentsForStaff,
  getActiveSessionByStudent,
  getActiveSupervisionForStudent,
  getCoverageScopeGroupStudentIds,
  getClasspilotCommandByIdAndSchool,
  getOnlineUnassignedStudents,
  listCoverageScopeGroups,
  linkStudentDevice,
  replaceCoverageScopeGroupMembers,
  releaseSupervisionStudents,
  setActiveStudentForDevice,
  updateCoverageAssignment,
  updateCoverageScopeGroup,
  updateClasspilotCommandTargetAck,
} from "../dist/services/storage.js";
import { getAuditLogs } from "../dist/services/audit.js";
import { scopedDeviceTargets } from "../dist/services/classpilotDeviceScope.js";

const TAG = `cpcoverage_${Date.now()}`;

let school: any;
let admin: any;
let teacher: any;
let coverageStaff: any;
let scopedCoverageStaff: any;
let studentUnassigned: any;
let studentInClass: any;
let studentCoverage: any;
let studentDeviceGuard: any;
let server: Server;
let baseUrl: string;
let originalRedisUrl: string | undefined;

const deviceUnassigned = `${TAG}-device-unassigned`;
const deviceInClass = `${TAG}-device-class`;
const deviceCoverage = `${TAG}-device-coverage`;
const deviceGuard = `${TAG}-device-guard`;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
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

async function requestJson(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
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
  };
}

function expectNoDeviceIds(value: unknown) {
  const text = JSON.stringify(value);
  assert.equal(text.includes("deviceId"), false);
  assert.equal(text.includes("primaryDeviceId"), false);
  assert.equal(text.includes("studentSessionId"), false);
}

async function ensureCoverageTables() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_commands (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR,
      supervision_context_id VARCHAR,
      teacher_id TEXT NOT NULL,
      target_scope TEXT NOT NULL,
      subgroup_id VARCHAR,
      command_type TEXT NOT NULL,
      command_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'requested',
      requested_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      received_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      unavailable_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE classpilot_commands ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR`);
  await db.execute(sql`ALTER TABLE classpilot_commands ALTER COLUMN teaching_session_id DROP NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_commands_school_context_idx ON classpilot_commands (school_id, supervision_context_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_command_targets (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      command_id VARCHAR NOT NULL,
      school_id TEXT NOT NULL,
      teaching_session_id VARCHAR,
      supervision_context_id VARCHAR,
      student_id TEXT NOT NULL,
      student_session_id VARCHAR,
      device_id TEXT,
      status TEXT NOT NULL DEFAULT 'requested',
      ack_state TEXT,
      error_message TEXT,
      result JSONB,
      sent_at TIMESTAMP,
      received_at TIMESTAMP,
      completed_at TIMESTAMP,
      failed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE classpilot_command_targets ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR`);
  await db.execute(sql`ALTER TABLE classpilot_command_targets ALTER COLUMN teaching_session_id DROP NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_command_targets_school_context_idx ON classpilot_command_targets (school_id, supervision_context_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_coverage_assignments (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_value TEXT,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_coverage_assignments_school_staff_idx ON classpilot_coverage_assignments (school_id, staff_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_coverage_assignments_scope_idx ON classpilot_coverage_assignments (school_id, scope_type, scope_value)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_coverage_scope_groups (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_coverage_scope_groups_school_idx ON classpilot_coverage_scope_groups (school_id, active)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_coverage_scope_group_members (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      coverage_group_id VARCHAR NOT NULL,
      student_id TEXT NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_coverage_scope_group_members_group_idx ON classpilot_coverage_scope_group_members (school_id, coverage_group_id)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS classpilot_coverage_scope_group_members_unique
    ON classpilot_coverage_scope_group_members (school_id, coverage_group_id, student_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_supervision_contexts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      context_type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      assigned_staff_id TEXT NOT NULL,
      coverage_group_id TEXT,
      created_by TEXT NOT NULL,
      note TEXT,
      starts_at TIMESTAMP NOT NULL DEFAULT now(),
      ends_at TIMESTAMP NOT NULL,
      ended_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE classpilot_supervision_contexts ADD COLUMN IF NOT EXISTS coverage_group_id TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_school_status_idx ON classpilot_supervision_contexts (school_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_staff_idx ON classpilot_supervision_contexts (school_id, assigned_staff_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_coverage_group_idx ON classpilot_supervision_contexts (school_id, coverage_group_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_supervision_students (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      context_id VARCHAR NOT NULL,
      student_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      assigned_by TEXT NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT now(),
      released_at TIMESTAMP,
      release_reason TEXT
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_students_context_idx ON classpilot_supervision_students (school_id, context_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_students_student_idx ON classpilot_supervision_students (school_id, student_id)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS classpilot_supervision_students_active_unique
    ON classpilot_supervision_students (school_id, student_id)
    WHERE released_at IS NULL
  `);
}

function ids(rows: Array<{ student: { id: string } }>) {
  return new Set(rows.map((row) => row.student.id));
}

before(async () => {
  originalRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "";
  mock.timers.enable({ apis: ["setInterval"] });

  await ensureCoverageTables();

  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
  } as any);
  await createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" } as any);
  admin = await createUser({ email: `admin@${TAG}.example.edu`, firstName: "Ada", lastName: "Admin" } as any);
  teacher = await createUser({ email: `teacher@${TAG}.example.edu`, firstName: "Tara", lastName: "Teacher" } as any);
  coverageStaff = await createUser({ email: `coverage@${TAG}.example.edu`, firstName: "Casey", lastName: "Coverage" } as any);
  scopedCoverageStaff = await createUser({ email: `scoped-coverage@${TAG}.example.edu`, firstName: "Sam", lastName: "Scoped" } as any);

  await createMembership({ userId: admin.id, schoolId: school.id, role: "admin", status: "active" } as any);
  await createMembership({ userId: teacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
  await createMembership({ userId: coverageStaff.id, schoolId: school.id, role: "office_staff", status: "active" } as any);
  await createMembership({ userId: scopedCoverageStaff.id, schoolId: school.id, role: "office_staff", status: "active" } as any);

  studentUnassigned = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Una",
    lastName: "Assigned",
    email: `unassigned@${TAG}.example.edu`,
    emailLc: `unassigned@${TAG}.example.edu`,
    gradeLevel: "7",
    status: "active",
  } as any));
  studentInClass = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Class",
    lastName: "Member",
    email: `class@${TAG}.example.edu`,
    emailLc: `class@${TAG}.example.edu`,
    gradeLevel: "7",
    status: "active",
  } as any));
  studentCoverage = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Temp",
    lastName: "Coverage",
    email: `coverage-student@${TAG}.example.edu`,
    emailLc: `coverage-student@${TAG}.example.edu`,
    gradeLevel: "8",
    status: "active",
  } as any));
  studentDeviceGuard = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Device",
    lastName: "Guard",
    email: `guard@${TAG}.example.edu`,
    emailLc: `guard@${TAG}.example.edu`,
    gradeLevel: "8",
    status: "active",
  } as any));

  await inSchool(school.id, async () => {
    await createDevice({ deviceId: deviceUnassigned, schoolId: school.id, classId: "default", deviceName: "Unassigned" } as any);
    await createDevice({ deviceId: deviceInClass, schoolId: school.id, classId: "default", deviceName: "Class" } as any);
    await createDevice({ deviceId: deviceCoverage, schoolId: school.id, classId: "default", deviceName: "Coverage" } as any);
    await createDevice({ deviceId: deviceGuard, schoolId: school.id, classId: "default", deviceName: "Guard" } as any);
    await linkStudentDevice({ studentId: studentUnassigned.id, deviceId: deviceUnassigned });
    await linkStudentDevice({ studentId: studentInClass.id, deviceId: deviceInClass });
    await linkStudentDevice({ studentId: studentCoverage.id, deviceId: deviceCoverage });
    await linkStudentDevice({ studentId: studentDeviceGuard.id, deviceId: deviceGuard });
    await setActiveStudentForDevice(deviceUnassigned, studentUnassigned.id);
    await setActiveStudentForDevice(deviceInClass, studentInClass.id);
    await setActiveStudentForDevice(deviceCoverage, studentCoverage.id);
    await setActiveStudentForDevice(deviceGuard, studentDeviceGuard.id);
  });

  const { createApp } = await import("../dist/app.js");
  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (school?.id) {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_coverage_assignments WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_coverage_scope_group_members WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_coverage_scope_groups WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_command_targets WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_commands WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id = ${school.id}) OR device_id LIKE ${`${TAG}-%`}`);
        await db.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE school_id = ${school.id}) OR device_id LIKE ${`${TAG}-%`}`);
        await db.execute(sql`DELETE FROM devices WHERE school_id = ${school.id} OR device_id LIKE ${`${TAG}-%`}`);
        await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
        await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
        await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
      });
    }
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
    });
  } catch {
    /* best-effort cleanup */
  }
  mock.timers.reset();
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
  await pool.end();
});

describe("ClassPilot supervision coverage storage contracts", () => {
  it("lists online unassigned students and excludes active class or temporary coverage students", async () => {
    const initial = await inSchool(school.id, () => getOnlineUnassignedStudents(school.id));
    assert.ok(ids(initial).has(studentUnassigned.id));
    assert.ok(ids(initial).has(studentInClass.id));
    assert.ok(ids(initial).has(studentCoverage.id));

    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Active_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentInClass.id]));
    const session = await inSchool(school.id, () => createTeachingSession({ groupId: group.id, teacherId: teacher.id }));

    const afterClassStart = await inSchool(school.id, () => getOnlineUnassignedStudents(school.id));
    assert.ok(ids(afterClassStart).has(studentUnassigned.id));
    assert.ok(!ids(afterClassStart).has(studentInClass.id));

    const context = await inSchool(school.id, () => createSupervisionContextWithStudents({
      context: {
        schoolId: school.id,
        contextType: "state_testing",
        name: "State Testing",
        status: "active",
        assignedStaffId: coverageStaff.id,
        createdBy: admin.id,
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      studentIds: [studentCoverage.id],
      assignedBy: admin.id,
      source: "admin_claim",
    }));

    const afterCoverageClaim = await inSchool(school.id, () => getOnlineUnassignedStudents(school.id));
    assert.ok(ids(afterCoverageClaim).has(studentUnassigned.id));
    assert.ok(!ids(afterCoverageClaim).has(studentCoverage.id));

    const released = await inSchool(school.id, () => releaseSupervisionStudents({
      schoolId: school.id,
      contextId: context.id,
      releaseReason: "returned_to_class",
    }));
    assert.equal(released[0]?.releaseReason, "returned_to_class");
    await inSchool(school.id, () => endTeachingSession(session.id));
  });

  it("tracks coverage assignments and blocks direct device targeting during temporary coverage", async () => {
    const assignment = await inSchool(school.id, () => createCoverageAssignment({
      schoolId: school.id,
      staffId: coverageStaff.id,
      scopeType: "school",
      scopeValue: null,
      permissions: { observe: true, claim: true },
      active: true,
      createdBy: admin.id,
    } as any));
    const activeAssignments = await inSchool(school.id, () => getActiveCoverageAssignmentsForStaff(school.id, coverageStaff.id));
    assert.ok(activeAssignments.some((entry) => entry.id === assignment.id));

    const context = await inSchool(school.id, () => createSupervisionContextWithStudents({
      context: {
        schoolId: school.id,
        contextType: "office",
        name: "Office Coverage",
        status: "active",
        assignedStaffId: coverageStaff.id,
        createdBy: admin.id,
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      studentIds: [studentDeviceGuard.id],
      assignedBy: admin.id,
      source: "admin_reroute",
    }));

    const supervision = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, studentDeviceGuard.id));
    assert.equal(supervision?.context.id, context.id);

    const scopedDuringCoverage = await inSchool(school.id, () => scopedDeviceTargets([deviceGuard], school.id));
    assert.deepEqual(scopedDuringCoverage.deviceIds, []);
    assert.equal(scopedDuringCoverage.rejectedDeviceCount, 1);

    await inSchool(school.id, () => releaseSupervisionStudents({
      schoolId: school.id,
      contextId: context.id,
      releaseReason: "test_release",
    }));

    const scopedAfterRelease = await inSchool(school.id, () => scopedDeviceTargets([deviceGuard], school.id));
    assert.deepEqual(scopedAfterRelease.deviceIds, [deviceGuard]);
    assert.equal(scopedAfterRelease.rejectedDeviceCount, 0);
  });

  it("manages reusable supervision groups and assignment edits", async () => {
    const group = await inSchool(school.id, () => createCoverageScopeGroup({
      group: {
        schoolId: school.id,
        name: "State Testing A",
        description: "Initial testing roster",
        active: true,
        createdBy: admin.id,
      },
      studentIds: [studentCoverage.id, studentDeviceGuard.id],
    } as any));
    assert.equal(group.members.length, 2);

    const listed = await inSchool(school.id, () => listCoverageScopeGroups(school.id));
    assert.ok(listed.some((entry) => entry.id === group.id && entry.members.length === 2));

    const replaced = await inSchool(school.id, () => replaceCoverageScopeGroupMembers({
      schoolId: school.id,
      groupId: group.id,
      studentIds: [studentUnassigned.id],
    }));
    assert.equal(replaced?.members.length, 1);
    assert.deepEqual(await inSchool(school.id, () => getCoverageScopeGroupStudentIds(school.id, group.id)), [studentUnassigned.id]);

    const assignment = await inSchool(school.id, () => createCoverageAssignment({
      schoolId: school.id,
      staffId: coverageStaff.id,
      scopeType: "coverage_group",
      scopeValue: group.id,
      permissions: { observe: true, claim: true },
      active: true,
      createdBy: admin.id,
    } as any));
    let activeAssignments = await inSchool(school.id, () => getActiveCoverageAssignmentsForStaff(school.id, coverageStaff.id));
    assert.ok(activeAssignments.some((entry) => entry.id === assignment.id && entry.scopeType === "coverage_group"));

    const updatedAssignment = await inSchool(school.id, () => updateCoverageAssignment(school.id, assignment.id, {
      scopeType: "grade",
      scopeValue: "8",
      active: false,
    } as any));
    assert.equal(updatedAssignment?.scopeType, "grade");
    assert.equal(updatedAssignment?.active, false);
    activeAssignments = await inSchool(school.id, () => getActiveCoverageAssignmentsForStaff(school.id, coverageStaff.id));
    assert.ok(!activeAssignments.some((entry) => entry.id === assignment.id));

    const disabledGroup = await inSchool(school.id, () => updateCoverageScopeGroup({
      schoolId: school.id,
      groupId: group.id,
      active: false,
    }));
    assert.equal(disabledGroup?.active, false);
  });

  it("supports supervision groups, available pickup, claiming, and teacher send targets", async () => {
    const adminAuth = authFor(admin, school.id);
    const staffAuth = authFor(scopedCoverageStaff, school.id);
    const teacherAuth = authFor(teacher, school.id);

    const groupRes = await requestJson("POST", "/coverage/supervision-groups", {
      name: "Route Supervision Group",
      description: "API route supervision scope",
      studentIds: [studentUnassigned.id, studentInClass.id, studentCoverage.id],
      staffIds: [scopedCoverageStaff.id],
    }, adminAuth);
    assert.equal(groupRes.status, 201);
    assert.equal(groupRes.body.group.studentCount, 3);
    assert.ok(groupRes.body.group.staff.some((staff: any) => staff.id === scopedCoverageStaff.id));
    expectNoDeviceIds(groupRes.body);

    const staffQueue = await requestJson("GET", "/coverage/available-students", undefined, staffAuth);
    assert.equal(staffQueue.status, 200);
    const staffQueueIds = new Set(staffQueue.body.students.map((student: any) => student.studentId));
    assert.ok(staffQueueIds.has(studentUnassigned.id));
    assert.ok(staffQueue.body.students.every((student: any) =>
      student.matchingGroups.some((group: any) => group.id === groupRes.body.group.id)
    ));
    expectNoDeviceIds(staffQueue.body);

    const teacherQueue = await requestJson("GET", "/coverage/available-students", undefined, teacherAuth);
    assert.equal(teacherQueue.status, 200);
    assert.deepEqual(teacherQueue.body.students, []);

    const teacherSetupBeforeGrant = await requestJson("POST", "/coverage/supervision-groups", {
      name: "Teacher Setup Before Grant",
      studentIds: [studentCoverage.id],
      staffIds: [coverageStaff.id],
    }, teacherAuth);
    assert.equal(teacherSetupBeforeGrant.status, 403);

    const setupAssignment = await requestJson("POST", "/coverage/assignments", {
      staffId: teacher.id,
      scopeType: "setup",
    }, adminAuth);
    assert.equal(setupAssignment.status, 201);
    assert.equal(setupAssignment.body.assignment.scopeLabel, "Setup Manager");
    assert.equal(setupAssignment.body.assignment.permissionLabel, "Manage Supervision Setup");

    const teacherCapabilities = await requestJson("GET", "/coverage/capabilities", undefined, teacherAuth);
    assert.equal(teacherCapabilities.status, 200);
    assert.equal(teacherCapabilities.body.canManageSupervisionSetup, true);

    const teacherSetupStaff = await requestJson("GET", "/coverage/setup/staff", undefined, teacherAuth);
    assert.equal(teacherSetupStaff.status, 200);
    assert.ok(teacherSetupStaff.body.users.some((user: any) => user.userId === coverageStaff.id));
    expectNoDeviceIds(teacherSetupStaff.body);

    const teacherSetupStudents = await requestJson("GET", "/coverage/setup/students", undefined, teacherAuth);
    assert.equal(teacherSetupStudents.status, 200);
    assert.ok(teacherSetupStudents.body.students.some((student: any) => student.id === studentCoverage.id));
    expectNoDeviceIds(teacherSetupStudents.body);

    const teacherSetupClasses = await requestJson("GET", "/coverage/setup/classes", undefined, teacherAuth);
    assert.equal(teacherSetupClasses.status, 200);
    expectNoDeviceIds(teacherSetupClasses.body);

    const teacherSetupGroup = await requestJson("POST", "/coverage/supervision-groups", {
      name: "Teacher Managed Makeup Group",
      studentIds: [studentCoverage.id],
      staffIds: [coverageStaff.id],
    }, teacherAuth);
    assert.equal(teacherSetupGroup.status, 201);
    assert.equal(teacherSetupGroup.body.group.studentCount, 1);
    assert.ok(teacherSetupGroup.body.group.staff.some((staff: any) => staff.id === coverageStaff.id));
    expectNoDeviceIds(teacherSetupGroup.body);

    const teacherAssignments = await requestJson("GET", "/coverage/assignments", undefined, teacherAuth);
    assert.equal(teacherAssignments.status, 403);

    const teacherQueueAfterSetupGrant = await requestJson("GET", "/coverage/available-students", undefined, teacherAuth);
    assert.equal(teacherQueueAfterSetupGrant.status, 200);
    assert.deepEqual(teacherQueueAfterSetupGrant.body.students, []);

    const directScopeGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: "8th",
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(directScopeGroup.id, [studentDeviceGuard.id]));
    await requestJson("POST", "/coverage/assignments", {
      staffId: teacher.id,
      scopeType: "group",
      scopeValue: directScopeGroup.id,
    }, adminAuth);

    const directScopeQueue = await requestJson("GET", "/coverage/available-students", undefined, teacherAuth);
    assert.equal(directScopeQueue.status, 200);
    const directScopeStudent = directScopeQueue.body.students.find((student: any) => student.studentId === studentDeviceGuard.id);
    assert.ok(directScopeStudent);
    assert.equal(directScopeStudent.matchingGroups.length, 0);
    assert.ok(directScopeStudent.matchingScopes.some((scope: any) => scope.name === "Class: 8th"));
    expectNoDeviceIds(directScopeQueue.body);

    const directClaimRes = await requestJson("POST", "/coverage/claim", {
      studentIds: [studentDeviceGuard.id],
    }, teacherAuth);
    assert.equal(directClaimRes.status, 201);
    assert.equal(directClaimRes.body.context.coverageGroupId, null);
    assert.equal(directClaimRes.body.context.name, "Class: 8th");
    expectNoDeviceIds(directClaimRes.body);
    await requestJson("POST", `/coverage/contexts/${directClaimRes.body.context.id}/release`, {
      studentIds: [studentDeviceGuard.id],
      releaseReason: "test_release",
    }, teacherAuth);

    const claimRes = await requestJson("POST", "/coverage/claim", {
      supervisionGroupId: groupRes.body.group.id,
      studentIds: [studentUnassigned.id],
    }, staffAuth);
    assert.equal(claimRes.status, 201);
    assert.equal(claimRes.body.context.coverageGroupId, groupRes.body.group.id);
    const contextId = claimRes.body.context.id;
    expectNoDeviceIds(claimRes.body);

    const staffClaimed = await requestJson("GET", "/coverage/claimed-students", undefined, staffAuth);
    assert.equal(staffClaimed.status, 200);
    assert.ok(staffClaimed.body.students.some((student: any) =>
      student.studentId === studentUnassigned.id &&
      student.contextId === contextId &&
      student.supervisionGroup.id === groupRes.body.group.id
    ));
    expectNoDeviceIds(staffClaimed.body);

    const teacherContexts = await requestJson("GET", "/coverage/contexts?activeOnly=true", undefined, teacherAuth);
    assert.equal(teacherContexts.status, 200);
    assert.ok(!teacherContexts.body.contexts.some((context: any) => context.id === contextId));

    const rerouteTargets = await requestJson("GET", "/coverage/reroute-targets", undefined, teacherAuth);
    assert.equal(rerouteTargets.status, 200);
    const target = rerouteTargets.body.targets.find((entry: any) =>
      entry.supervisionGroupId === groupRes.body.group.id &&
      entry.assignedStaffId === scopedCoverageStaff.id
    );
    assert.ok(target);
    assert.equal(Object.prototype.hasOwnProperty.call(target, "students"), false);
    expectNoDeviceIds(rerouteTargets.body);

    const activeClass = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Send_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(activeClass.id, [studentInClass.id]));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: activeClass.id,
      teacherId: teacher.id,
    }));

    const teacherReroute = await requestJson("POST", "/coverage/send", {
      supervisionGroupId: target.supervisionGroupId,
      assignedStaffId: target.assignedStaffId,
      studentIds: [studentInClass.id],
      note: "API teacher send check",
    }, teacherAuth);
    assert.equal(teacherReroute.status, 201);
    assert.ok(teacherReroute.body.assignments.some((assignment: any) =>
      assignment.studentId === studentInClass.id &&
      assignment.contextId === contextId &&
      assignment.source === "teacher_send"
    ));
    expectNoDeviceIds(teacherReroute.body);

    const returnOutOfClass = await requestJson("POST", "/coverage/return-to-class", {
      studentIds: [studentUnassigned.id],
    }, teacherAuth);
    assert.equal(returnOutOfClass.status, 403);
    assert.match(returnOutOfClass.body.error, /active class/);

    const returnToClass = await requestJson("POST", "/coverage/return-to-class", {
      studentIds: [studentInClass.id],
    }, teacherAuth);
    assert.equal(returnToClass.status, 200);
    assert.ok(returnToClass.body.released.some((assignment: any) =>
      assignment.studentId === studentInClass.id &&
      assignment.contextId === contextId &&
      assignment.releaseReason === "returned_to_class"
    ));
    expectNoDeviceIds(returnToClass.body);

    const returnedStudentCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, studentInClass.id));
    assert.equal(returnedStudentCoverage, undefined);
    const stillClaimedCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, studentUnassigned.id));
    assert.equal(stillClaimedCoverage?.context.id, contextId);

    const returnAuditRows = await inSchool(school.id, () => getAuditLogs({
      schoolId: school.id,
      entityType: "supervision_context",
      entityId: contextId,
      limit: 25,
    }));
    assert.ok(returnAuditRows.some((entry: any) =>
      entry.action === "coverage.student.return_to_class" &&
      entry.changes?.releaseReason === "returned_to_class" &&
      entry.changes?.studentIds?.includes(studentInClass.id)
    ));

    const outOfClassReroute = await requestJson("POST", "/coverage/send", {
      supervisionGroupId: target.supervisionGroupId,
      assignedStaffId: target.assignedStaffId,
      studentIds: [studentCoverage.id],
      note: "should be blocked",
    }, teacherAuth);
    assert.equal(outOfClassReroute.status, 403);
    assert.match(outOfClassReroute.body.error, /active class/);

    const releaseRes = await requestJson("POST", `/coverage/contexts/${contextId}/release`, {
      studentIds: [studentUnassigned.id],
      releaseReason: "test_release",
    }, staffAuth);
    assert.equal(releaseRes.status, 200);
    await inSchool(school.id, () => endTeachingSession(teachingSession.id));
  });

  it("records coverage commands against a supervision context without a teaching session", async () => {
    const context = await inSchool(school.id, () => createSupervisionContextWithStudents({
      context: {
        schoolId: school.id,
        contextType: "office",
        name: "Coverage Command Test",
        status: "active",
        assignedStaffId: coverageStaff.id,
        createdBy: admin.id,
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      studentIds: [studentUnassigned.id],
      assignedBy: admin.id,
      source: "admin_reroute",
    }));

    const activeSession = await inSchool(school.id, () => getActiveSessionByStudent(studentUnassigned.id));
    assert.ok(activeSession);

    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: context.id,
        teacherId: coverageStaff.id,
        targetScope: "context",
        subgroupId: null,
        commandType: "open-tab",
        commandPayload: { url: "https://example.com/" },
        requestedCount: 1,
        unavailableCount: 0,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: context.id,
        commandId: "",
        studentId: studentUnassigned.id,
        studentSessionId: activeSession!.id,
        deviceId: deviceUnassigned,
        status: "requested",
        errorMessage: null,
      } as any]
    ));

    assert.equal(created.teachingSessionId, null);
    assert.equal((created as any).supervisionContextId, context.id);
    assert.equal((created.targets[0] as any).supervisionContextId, context.id);

    await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceUnassigned,
      studentId: studentUnassigned.id,
      ackState: "completed",
      result: { ok: true },
    }));
    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.status, "completed");
    assert.equal(loaded?.targets[0]?.status, "completed");

    await inSchool(school.id, () => releaseSupervisionStudents({
      schoolId: school.id,
      contextId: context.id,
      releaseReason: "test_release",
    }));
  });
});
