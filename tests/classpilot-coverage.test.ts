import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  addGroupStudentsDetailed,
  createCoverageAssignment,
  createClasspilotCommandWithTargets,
  createDevice,
  createGroup,
  createMembership,
  createSchool,
  createStudent,
  createSupervisionContextWithStudents,
  createTeachingSession,
  createUser,
  endTeachingSession,
  getActiveCoverageAssignmentsForStaff,
  getActiveSessionByStudent,
  getActiveSupervisionForStudent,
  getClasspilotCommandByIdAndSchool,
  getOnlineUnassignedStudents,
  linkStudentDevice,
  releaseSupervisionStudents,
  setActiveStudentForDevice,
  updateClasspilotCommandTargetAck,
} from "../dist/services/storage.js";
import { scopedDeviceTargets } from "../dist/services/classpilotDeviceScope.js";

const TAG = `cpcoverage_${Date.now()}`;

let school: any;
let admin: any;
let teacher: any;
let coverageStaff: any;
let studentUnassigned: any;
let studentInClass: any;
let studentCoverage: any;
let studentDeviceGuard: any;

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

async function ensureCoverageTables() {
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
    CREATE TABLE IF NOT EXISTS classpilot_supervision_contexts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      context_type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      assigned_staff_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      note TEXT,
      starts_at TIMESTAMP NOT NULL DEFAULT now(),
      ends_at TIMESTAMP NOT NULL,
      ended_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_school_status_idx ON classpilot_supervision_contexts (school_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_staff_idx ON classpilot_supervision_contexts (school_id, assigned_staff_id)`);

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
  await ensureCoverageTables();

  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
  } as any);
  admin = await createUser({ email: `admin@${TAG}.example.edu`, firstName: "Ada", lastName: "Admin" } as any);
  teacher = await createUser({ email: `teacher@${TAG}.example.edu`, firstName: "Tara", lastName: "Teacher" } as any);
  coverageStaff = await createUser({ email: `coverage@${TAG}.example.edu`, firstName: "Casey", lastName: "Coverage" } as any);

  await createMembership({ userId: admin.id, schoolId: school.id, role: "admin", status: "active" } as any);
  await createMembership({ userId: teacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
  await createMembership({ userId: coverageStaff.id, schoolId: school.id, role: "office_staff", status: "active" } as any);

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
});

after(async () => {
  try {
    if (school?.id) {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_coverage_assignments WHERE school_id = ${school.id}`);
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
