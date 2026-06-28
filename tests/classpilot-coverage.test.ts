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
  getActiveClassOwnersForStudents,
  getActiveTeachingSessionForSchool,
  getActiveCoverageAssignmentsForStaff,
  getActiveClassOwnerForStudent,
  getActiveSessionByStudent,
  getActiveSupervisionForStudent,
  getCoverageScopeGroupStudentIds,
  getCentralEmailRecipientForSchool,
  getClasspilotSessionStudents,
  getClasspilotCommandByIdAndSchool,
  getSettingsForSchool,
  getOnlineUnassignedStudents,
  addCentralEmailRecipientForSchool,
  listCoverageScopeGroups,
  linkStudentDevice,
  replaceCoverageScopeGroupMembers,
  releaseSupervisionStudents,
  setActiveStudentForDevice,
  updateCoverageAssignment,
  updateCoverageScopeGroup,
  updateClasspilotCommandTargetAck,
  updateEnrollmentSettings,
} from "../dist/services/storage.js";
import { processScheduledClassAutoStart } from "../dist/services/classpilotScheduledStart.js";
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
  await db.execute(sql`ALTER TABLE settings ADD COLUMN IF NOT EXISTS central_email_recipient_user_id TEXT`);
  await db.execute(sql`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS control_updated_at TIMESTAMP`);

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
      scheduled_conflict_id TEXT,
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
  await db.execute(sql`ALTER TABLE classpilot_supervision_contexts ADD COLUMN IF NOT EXISTS scheduled_conflict_id TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_school_status_idx ON classpilot_supervision_contexts (school_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_staff_idx ON classpilot_supervision_contexts (school_id, assigned_staff_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_coverage_group_idx ON classpilot_supervision_contexts (school_id, coverage_group_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_supervision_contexts_scheduled_conflict_idx ON classpilot_supervision_contexts (school_id, scheduled_conflict_id)`);

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

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS classpilot_scheduled_conflicts (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      school_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      block_start_time TEXT NOT NULL,
      block_end_time TEXT,
      status TEXT NOT NULL DEFAULT 'coverage_needed',
      conflict_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      scheduled_teacher_connected BOOLEAN NOT NULL DEFAULT false,
      last_checked_at TIMESTAMP NOT NULL DEFAULT now(),
      resolved_at TIMESTAMP,
      resolved_by TEXT,
      resolution TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_unique
    ON classpilot_scheduled_conflicts (school_id, group_id, scheduled_date, block_start_time)
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS classpilot_scheduled_conflicts_school_status_idx ON classpilot_scheduled_conflicts (school_id, status)`);
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
        await db.execute(sql`DELETE FROM classpilot_scheduled_conflicts WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_command_targets WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_commands WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id = ${school.id}) OR device_id LIKE ${`${TAG}-%`}`);
        await db.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE school_id = ${school.id}) OR device_id LIKE ${`${TAG}-%`}`);
        await db.execute(sql`DELETE FROM devices WHERE school_id = ${school.id} OR device_id LIKE ${`${TAG}-%`}`);
        await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
        await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
        await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM settings WHERE school_id = ${school.id}`);
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

  it("warns before starting a class that overlaps another teacher's active roster", async () => {
    const sourceTeacher = await createUser({
      email: `source-teacher@${TAG}.example.edu`,
      firstName: "Sam",
      lastName: "Source",
    } as any);
    const secondSourceTeacher = await createUser({
      email: `second-source-teacher@${TAG}.example.edu`,
      firstName: "Mina",
      lastName: "Monitor",
    } as any);
    const startingTeacher = await createUser({
      email: `starting-teacher@${TAG}.example.edu`,
      firstName: "Tara",
      lastName: "Starter",
    } as any);
    await createMembership({ userId: sourceTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: secondSourceTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: startingTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);

    const noOverlapStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "No",
      lastName: "Overlap",
      email: `no-overlap@${TAG}.example.edu`,
      emailLc: `no-overlap@${TAG}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as any));
    const ownOverlapStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Own",
      lastName: "Switch",
      email: `own-switch@${TAG}.example.edu`,
      emailLc: `own-switch@${TAG}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as any));
    const crossTeacherStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Cross",
      lastName: "Teacher",
      email: `cross-teacher@${TAG}.example.edu`,
      emailLc: `cross-teacher@${TAG}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as any));
    const secondCrossTeacherStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Second",
      lastName: "Overlap",
      email: `second-overlap@${TAG}.example.edu`,
      emailLc: `second-overlap@${TAG}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as any));

    const noOverlapGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: startingTeacher.id,
      name: `${TAG}_No_Overlap_Start`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(noOverlapGroup.id, [noOverlapStudent.id]));
    const noOverlapStart = await requestJson("POST", "/sessions/start", {
      groupId: noOverlapGroup.id,
    }, authFor(startingTeacher, school.id));
    assert.equal(noOverlapStart.status, 201);
    await inSchool(school.id, () => endTeachingSession(noOverlapStart.body.session.id));

    const scheduledClosedGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: startingTeacher.id,
      name: `${TAG}_Scheduled_Closed`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "00:00",
      blockEndTime: "00:00",
    } as any));
    const scheduledClosedStart = await requestJson("POST", "/sessions/start", {
      groupId: scheduledClosedGroup.id,
      acknowledgeOverlap: true,
    }, authFor(startingTeacher, school.id));
    assert.equal(scheduledClosedStart.status, 403);

    const ownGroupA = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: startingTeacher.id,
      name: `${TAG}_Own_A`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const ownGroupB = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: startingTeacher.id,
      name: `${TAG}_Own_B`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(ownGroupA.id, [ownOverlapStudent.id]));
    await inSchool(school.id, () => addGroupStudentsDetailed(ownGroupB.id, [ownOverlapStudent.id]));
    const ownStartA = await requestJson("POST", "/sessions/start", { groupId: ownGroupA.id }, authFor(startingTeacher, school.id));
    assert.equal(ownStartA.status, 201);
    const ownStartB = await requestJson("POST", "/sessions/start", { groupId: ownGroupB.id }, authFor(startingTeacher, school.id));
    assert.equal(ownStartB.status, 201);
    await inSchool(school.id, () => endTeachingSession(ownStartB.body.session.id));

    const activeSourceGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: sourceTeacher.id,
      name: `${TAG}_Source_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const secondActiveSourceGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: secondSourceTeacher.id,
      name: `${TAG}_Second_Source_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const overlappingStartGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: startingTeacher.id,
      name: `${TAG}_Overlap_Start`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(activeSourceGroup.id, [crossTeacherStudent.id]));
    await inSchool(school.id, () => addGroupStudentsDetailed(secondActiveSourceGroup.id, [secondCrossTeacherStudent.id]));
    await inSchool(school.id, () => addGroupStudentsDetailed(overlappingStartGroup.id, [crossTeacherStudent.id, secondCrossTeacherStudent.id]));
    const sourceSession = await inSchool(school.id, () => createTeachingSession({
      groupId: activeSourceGroup.id,
      teacherId: sourceTeacher.id,
    } as any));
    const secondSourceSession = await inSchool(school.id, () => createTeachingSession({
      groupId: secondActiveSourceGroup.id,
      teacherId: secondSourceTeacher.id,
    } as any));

    const warned = await requestJson("POST", "/sessions/start", {
      groupId: overlappingStartGroup.id,
    }, authFor(startingTeacher, school.id));
    assert.equal(warned.status, 409);
    assert.equal(warned.body.code, "CLASS_ROSTER_ACTIVE_OVERLAP");
    assert.equal(warned.body.severity, "warning");
    assert.equal(warned.body.requiresAcknowledgement, true);
    assert.equal(warned.body.canStartAnyway, true);
    assert.equal(warned.body.selectedClass.id, overlappingStartGroup.id);
    assert.equal(warned.body.totalOverlapCount, 2);
    assert.equal(warned.body.groups.length, 2);
    const sourceOverlap = warned.body.groups.find((group: any) => group.sessionId === sourceSession.id);
    const secondSourceOverlap = warned.body.groups.find((group: any) => group.sessionId === secondSourceSession.id);
    assert.ok(sourceOverlap);
    assert.ok(secondSourceOverlap);
    assert.equal(sourceOverlap.className, activeSourceGroup.name);
    assert.equal(sourceOverlap.teacherName, "Sam Source");
    assert.equal(sourceOverlap.affectedCount, 1);
    assert.equal(sourceOverlap.affectedStudents[0].studentId, crossTeacherStudent.id);
    assert.equal(secondSourceOverlap.className, secondActiveSourceGroup.name);
    assert.equal(secondSourceOverlap.teacherName, "Mina Monitor");
    assert.equal(secondSourceOverlap.affectedCount, 1);
    assert.equal(secondSourceOverlap.affectedStudents[0].studentId, secondCrossTeacherStudent.id);
    expectNoDeviceIds(warned.body);

    const acknowledged = await requestJson("POST", "/sessions/start", {
      groupId: overlappingStartGroup.id,
      acknowledgeOverlap: true,
    }, authFor(startingTeacher, school.id));
    assert.equal(acknowledged.status, 201);
    assert.equal(acknowledged.body.session.groupId, overlappingStartGroup.id);

    await inSchool(school.id, () => endTeachingSession(sourceSession.id));
    await inSchool(school.id, () => endTeachingSession(secondSourceSession.id));
    await inSchool(school.id, () => endTeachingSession(acknowledged.body.session.id));
  });

  it("pushes offline scheduled classes into available scheduled coverage and releases when the scheduled teacher starts", async () => {
    const sourceTeacher = await createUser({
      email: `scheduled-source@${TAG}.example.edu`,
      firstName: "Paula",
      lastName: "Present",
    } as any);
    const scheduledTeacher = await createUser({
      email: `scheduled-teacher@${TAG}.example.edu`,
      firstName: "Nora",
      lastName: "NoLogin",
    } as any);
    const unrelatedTeacher = await createUser({
      email: `scheduled-unrelated@${TAG}.example.edu`,
      firstName: "Uri",
      lastName: "Unrelated",
    } as any);
    const scheduledCoverageStaff = await createUser({
      email: `scheduled-coverage-staff@${TAG}.example.edu`,
      firstName: "Casey",
      lastName: "ScheduledCoverage",
    } as any);
    await createMembership({ userId: sourceTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: scheduledTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: unrelatedTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: scheduledCoverageStaff.id, schoolId: school.id, role: "office_staff", status: "active" } as any);
    await inSchool(school.id, () => createCoverageAssignment({
      schoolId: school.id,
      staffId: scheduledCoverageStaff.id,
      scopeType: "grade",
      scopeValue: "6",
      permissions: { observe: true, claim: true },
      active: true,
      createdBy: admin.id,
    } as any));

    const scheduledOnlyStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Scheduled",
      lastName: "Only",
      email: `scheduled-only@${TAG}.example.edu`,
      emailLc: `scheduled-only@${TAG}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as any));
    const connectedStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Connected",
      lastName: "Scheduled",
      email: `scheduled-connected@${TAG}.example.edu`,
      emailLc: `scheduled-connected@${TAG}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as any));
    const overlapStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Overlap",
      lastName: "Scheduled",
      email: `scheduled-overlap@${TAG}.example.edu`,
      emailLc: `scheduled-overlap@${TAG}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as any));
    const scheduledOnlyDevice = `${TAG}-scheduled-only-device`;
    const overlapDevice = `${TAG}-scheduled-overlap-device`;
    const connectedDevice = `${TAG}-scheduled-connected-device`;
    await inSchool(school.id, async () => {
      await createDevice({ deviceId: scheduledOnlyDevice, schoolId: school.id, classId: "default", deviceName: "Scheduled Only" } as any);
      await createDevice({ deviceId: overlapDevice, schoolId: school.id, classId: "default", deviceName: "Scheduled Overlap" } as any);
      await createDevice({ deviceId: connectedDevice, schoolId: school.id, classId: "default", deviceName: "Scheduled Connected" } as any);
      await linkStudentDevice({ studentId: scheduledOnlyStudent.id, deviceId: scheduledOnlyDevice });
      await linkStudentDevice({ studentId: overlapStudent.id, deviceId: overlapDevice });
      await linkStudentDevice({ studentId: connectedStudent.id, deviceId: connectedDevice });
      await setActiveStudentForDevice(scheduledOnlyDevice, scheduledOnlyStudent.id);
      await setActiveStudentForDevice(overlapDevice, overlapStudent.id);
      await setActiveStudentForDevice(connectedDevice, connectedStudent.id);
    });

    const connectedGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: scheduledTeacher.id,
      name: `${TAG}_Scheduled_Connected`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "08:00",
      blockEndTime: "08:45",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(connectedGroup.id, [connectedStudent.id]));
    const connectedStart = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: connectedGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: true,
    }));
    assert.equal(connectedStart.status, "started");
    if (connectedStart.status === "started") {
      await inSchool(school.id, () => endTeachingSession(connectedStart.session.id));
    }

    const sourceGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: sourceTeacher.id,
      name: `${TAG}_Scheduled_Source`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const scheduledGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: scheduledTeacher.id,
      name: `${TAG}_Scheduled_Coverage_Needed`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "09:00",
      blockEndTime: "09:45",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(sourceGroup.id, [overlapStudent.id]));
    await inSchool(school.id, () => addGroupStudentsDetailed(scheduledGroup.id, [scheduledOnlyStudent.id, overlapStudent.id]));
    const sourceSession = await inSchool(school.id, () => createTeachingSession({
      groupId: sourceGroup.id,
      teacherId: sourceTeacher.id,
    } as any));

    const coverageNeeded = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set([sourceTeacher.id]),
    }));
    assert.equal(coverageNeeded.status, "coverage_needed");
    const scheduledActive = await inSchool(school.id, () => getActiveTeachingSessionForSchool(scheduledTeacher.id, school.id));
    assert.equal(scheduledActive, undefined);

    const duplicate = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set([sourceTeacher.id]),
    }));
    assert.equal(duplicate.status, "coverage_needed");
    assert.equal(duplicate.status === "coverage_needed" && coverageNeeded.status === "coverage_needed" ? duplicate.conflictId : null, coverageNeeded.status === "coverage_needed" ? coverageNeeded.conflictId : null);

    const adminList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(admin, school.id));
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.conflicts.length, 1);
    const conflict = adminList.body.conflicts[0];
    assert.equal(conflict.groupId, scheduledGroup.id);
    assert.equal(conflict.teacherId, scheduledTeacher.id);
    assert.equal(conflict.canStartAnyway, true);
    assert.equal(conflict.status, "coverage_needed");
    assert.equal(conflict.overlap.claimableCount, 1);
    assert.equal(conflict.overlap.monitoredCount, 1);
    assert.match(conflict.message, /not currently logged in/);
    expectNoDeviceIds(conflict);

    const staffQueue = await requestJson("GET", "/coverage/available-students", undefined, authFor(scheduledCoverageStaff, school.id));
    assert.equal(staffQueue.status, 200);
    const flatAvailableIds = new Set(staffQueue.body.students.map((student: any) => student.studentId));
    assert.equal(flatAvailableIds.has(scheduledOnlyStudent.id), false);
    assert.equal(staffQueue.body.scheduledCoverageGroups.length, 1);
    assert.equal(staffQueue.body.scheduledCoverageGroups[0].id, conflict.id);
    const scheduledCoverageIds = new Set(staffQueue.body.scheduledCoverageGroups[0].students.map((student: any) => student.studentId));
    assert.equal(scheduledCoverageIds.has(scheduledOnlyStudent.id), true);
    expectNoDeviceIds(staffQueue.body.scheduledCoverageGroups[0]);

    const scheduledTeacherList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(scheduledTeacher, school.id));
    assert.equal(scheduledTeacherList.status, 200);
    assert.equal(scheduledTeacherList.body.conflicts.length, 1);
    assert.equal(scheduledTeacherList.body.conflicts[0].canStartAnyway, true);

    const affectedTeacherList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(sourceTeacher, school.id));
    assert.equal(affectedTeacherList.status, 200);
    assert.equal(affectedTeacherList.body.conflicts.length, 1);
    assert.equal(affectedTeacherList.body.conflicts[0].canStartAnyway, false);
    assert.match(affectedTeacherList.body.conflicts[0].message, /not currently logged in/);

    const unrelatedList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(unrelatedTeacher, school.id));
    assert.equal(unrelatedList.status, 200);
    assert.equal(unrelatedList.body.conflicts.length, 0);

    const affectedStart = await requestJson("POST", `/classpilot/scheduled-conflicts/${conflict.id}/start-anyway`, {}, authFor(sourceTeacher, school.id));
    assert.equal(affectedStart.status, 403);

    const claim = await requestJson("POST", "/coverage/claim", {
      scheduledConflictId: conflict.id,
      studentIds: [scheduledOnlyStudent.id],
    }, authFor(scheduledCoverageStaff, school.id));
    assert.equal(claim.status, 201);
    const activeScheduledCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(activeScheduledCoverage?.context.contextType, "scheduled_coverage");

    const skipped = await requestJson("POST", `/classpilot/scheduled-conflicts/${conflict.id}/skip`, {}, authFor(scheduledTeacher, school.id));
    assert.equal(skipped.status, 200);
    const skippedRetry = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
    }));
    assert.equal(skippedRetry.status, "skipped");
    if (activeScheduledCoverage) {
      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: activeScheduledCoverage.context.id,
        releaseReason: "test_cleanup",
      }));
    }

    const startAnywayGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: scheduledTeacher.id,
      name: `${TAG}_Scheduled_Start_Anyway`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "10:00",
      blockEndTime: "10:45",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(startAnywayGroup.id, [scheduledOnlyStudent.id, overlapStudent.id]));
    const coverageStart = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: startAnywayGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
    }));
    assert.equal(coverageStart.status, "coverage_needed");
    assert.ok(coverageStart.status === "coverage_needed" && coverageStart.conflictId);
    const claimStart = await requestJson("POST", "/coverage/claim", {
      scheduledConflictId: coverageStart.status === "coverage_needed" ? coverageStart.conflictId : "",
      studentIds: [scheduledOnlyStudent.id],
    }, authFor(scheduledCoverageStaff, school.id));
    assert.equal(claimStart.status, 201);
    const started = await requestJson(
      "POST",
      `/classpilot/scheduled-conflicts/${coverageStart.status === "coverage_needed" ? coverageStart.conflictId : ""}/start-anyway`,
      {},
      authFor(scheduledTeacher, school.id)
    );
    assert.equal(started.status, 201);
    const [owner] = await inSchool(school.id, () => getActiveClassOwnersForStudents(school.id, [overlapStudent.id]));
    assert.equal(owner.session.id, started.body.session.id);
    const releasedScheduledCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(releasedScheduledCoverage, undefined);

    await inSchool(school.id, () => endTeachingSession(sourceSession.id));
    await inSchool(school.id, () => endTeachingSession(started.body.session.id));
  });

  it("gives the newest normal class session control of overlapping students", async () => {
    const secondTeacher = await createUser({
      email: `second-teacher@${TAG}.example.edu`,
      firstName: "Nina",
      lastName: "Newest",
    } as any);
    await createMembership({ userId: secondTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);

    const oldGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Old_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const newGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: secondTeacher.id,
      name: `${TAG}_New_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(oldGroup.id, [studentDeviceGuard.id]));
    await inSchool(school.id, () => addGroupStudentsDetailed(newGroup.id, [studentDeviceGuard.id]));

    const oldSession = await inSchool(school.id, () => createTeachingSession({ groupId: oldGroup.id, teacherId: teacher.id }));
    const newSession = await inSchool(school.id, () => createTeachingSession({ groupId: newGroup.id, teacherId: secondTeacher.id }));
    await inSchool(school.id, async () => {
      await db.execute(sql`UPDATE teaching_sessions SET start_time = ${new Date(Date.now() - 60_000)} WHERE id = ${oldSession.id}`);
      await db.execute(sql`UPDATE teaching_sessions SET start_time = ${new Date()} WHERE id = ${newSession.id}`);
    });

    const aggregated = await requestJson("GET", "/students-aggregated", undefined, authFor(teacher, school.id));
    assert.equal(aggregated.status, 200);
    const overlappingStudent = aggregated.body.find((student: any) => student.studentId === studentDeviceGuard.id);
    assert.equal(overlappingStudent?.supervisionContext?.id, newSession.id);
    assert.equal(overlappingStudent?.supervisionContext?.type, "class");

    const oldCommand = await requestJson("POST", "/commands", {
      teachingSessionId: oldSession.id,
      targetScope: "students",
      targetStudentIds: [studentDeviceGuard.id],
      commandType: "open-tab",
      commandPayload: { url: "https://example.com/old" },
    }, authFor(teacher, school.id));
    assert.equal(oldCommand.status, 201);
    assert.equal(oldCommand.body.summary.requested, 1);
    assert.equal(oldCommand.body.summary.unavailable, 1);
    assert.equal(oldCommand.body.summary.sent, 0);
    assert.match(oldCommand.body.command.targets[0].errorMessage, /active in/);

    const newCommand = await requestJson("POST", "/commands", {
      teachingSessionId: newSession.id,
      targetScope: "students",
      targetStudentIds: [studentDeviceGuard.id],
      commandType: "open-tab",
      commandPayload: { url: "https://example.com/new" },
    }, authFor(secondTeacher, school.id));
    assert.equal(newCommand.status, 201);
    assert.equal(newCommand.body.summary.requested, 1);
    assert.equal(newCommand.body.summary.unavailable, 0);
    assert.equal(newCommand.body.summary.sent, 1);

    await inSchool(school.id, () => endTeachingSession(oldSession.id));
    await inSchool(school.id, () => endTeachingSession(newSession.id));
  });

  it("resyncs an active class roster and requires acknowledgement before reclaiming active students", async () => {
    const resyncTeacher = await createUser({
      email: `resync-teacher@${TAG}.example.edu`,
      firstName: "Rita",
      lastName: "Resync",
    } as any);
    const otherTeacher = await createUser({
      email: `resync-other@${TAG}.example.edu`,
      firstName: "Omar",
      lastName: "Owner",
    } as any);
    const unauthorizedTeacher = await createUser({
      email: `resync-unauthorized@${TAG}.example.edu`,
      firstName: "Una",
      lastName: "Allowed",
    } as any);
    await createMembership({ userId: resyncTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: otherTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    await createMembership({ userId: unauthorizedTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);

    const originalStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Original",
      lastName: "Roster",
      email: `resync-original@${TAG}.example.edu`,
      emailLc: `resync-original@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));
    const lateStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Late",
      lastName: "Joiner",
      email: `resync-late@${TAG}.example.edu`,
      emailLc: `resync-late@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));
    const overlapStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Overlap",
      lastName: "Student",
      email: `resync-overlap@${TAG}.example.edu`,
      emailLc: `resync-overlap@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));

    const resyncGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: resyncTeacher.id,
      name: `${TAG}_Resync_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const otherGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: otherTeacher.id,
      name: `${TAG}_Other_Active_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(resyncGroup.id, [originalStudent.id]));
    const resyncSession = await inSchool(school.id, () => createTeachingSession({ groupId: resyncGroup.id, teacherId: resyncTeacher.id }));

    const noop = await requestJson("POST", `/sessions/${resyncSession.id}/resync`, {}, authFor(resyncTeacher, school.id));
    assert.equal(noop.status, 200);
    assert.equal(noop.body.rosterCount, 1);
    assert.equal(noop.body.alreadyInSession, 1);
    assert.equal(noop.body.addedToSession, 0);
    assert.equal(noop.body.notSignedIn, 1);

    await inSchool(school.id, () => addGroupStudentsDetailed(resyncGroup.id, [lateStudent.id]));
    const added = await requestJson("POST", `/sessions/${resyncSession.id}/resync`, {}, authFor(resyncTeacher, school.id));
    assert.equal(added.status, 200);
    assert.equal(added.body.rosterCount, 2);
    assert.equal(added.body.addedToSession, 1);
    const sessionRowsAfterAdd = await inSchool(school.id, () => getClasspilotSessionStudents(resyncSession.id));
    assert.ok(sessionRowsAfterAdd.some((row) => row.studentId === lateStudent.id));

    const forbidden = await requestJson("POST", `/sessions/${resyncSession.id}/resync`, {}, authFor(unauthorizedTeacher, school.id));
    assert.equal(forbidden.status, 403);

    await inSchool(school.id, async () => {
      await addGroupStudentsDetailed(resyncGroup.id, [overlapStudent.id]);
      await addGroupStudentsDetailed(otherGroup.id, [overlapStudent.id]);
    });
    const otherSession = await inSchool(school.id, () => createTeachingSession({ groupId: otherGroup.id, teacherId: otherTeacher.id }));

    const warned = await requestJson("POST", `/sessions/${resyncSession.id}/resync`, {}, authFor(resyncTeacher, school.id));
    assert.equal(warned.status, 409);
    assert.equal(warned.body.code, "CLASS_RESYNC_ACTIVE_OVERLAP");
    assert.equal(warned.body.requiresAcknowledgement, true);
    assert.equal(warned.body.activeElsewhere, 1);
    assert.equal(warned.body.conflicts[0].sessionId, otherSession.id);
    assert.equal(warned.body.conflicts[0].teacherName, "Omar Owner");
    expectNoDeviceIds(warned.body);

    const acknowledged = await requestJson("POST", `/sessions/${resyncSession.id}/resync`, {
      acknowledgeOverlap: true,
    }, authFor(resyncTeacher, school.id));
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.body.addedToSession, 1);
    assert.equal(acknowledged.body.activeElsewhere, 1);
    assert.ok(acknowledged.body.session.controlUpdatedAt);
    const owner = await inSchool(school.id, () => getActiveClassOwnerForStudent(school.id, overlapStudent.id));
    assert.equal(owner?.session.id, resyncSession.id);

    const auditRows = await getAuditLogs({
      schoolId: school.id,
      action: "classpilot.session.resync",
      entityId: resyncSession.id,
      limit: 10,
    });
    assert.ok(auditRows.length >= 2);

    await inSchool(school.id, () => endTeachingSession(resyncSession.id));
    await inSchool(school.id, () => endTeachingSession(otherSession.id));
  });

  it("signs out explicit active class students and rejects implicit whole-class sign-out", async () => {
    const signOutStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Sign",
      lastName: "Out",
      email: `sign-out@${TAG}.example.edu`,
      emailLc: `sign-out@${TAG}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as any));
    const signOutDevice = `${TAG}-device-sign-out`;
    const signOutGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Sign_Out_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));

    await inSchool(school.id, async () => {
      await createDevice({ deviceId: signOutDevice, schoolId: school.id, classId: "default", deviceName: "Sign Out" } as any);
      await linkStudentDevice({ studentId: signOutStudent.id, deviceId: signOutDevice });
      await setActiveStudentForDevice(signOutDevice, signOutStudent.id);
      await addGroupStudentsDetailed(signOutGroup.id, [signOutStudent.id]);
    });
    const session = await inSchool(school.id, () => createTeachingSession({ groupId: signOutGroup.id, teacherId: teacher.id }));

    const broadCommand = await requestJson("POST", "/commands", {
      teachingSessionId: session.id,
      targetScope: "class",
      commandType: "student-sign-out",
      commandPayload: {},
    }, authFor(teacher, school.id));
    assert.equal(broadCommand.status, 400);
    assert.match(broadCommand.body.error, /explicit targetStudentIds/);

    const selectedCommand = await requestJson("POST", "/commands", {
      teachingSessionId: session.id,
      targetScope: "students",
      targetStudentIds: [signOutStudent.id],
      commandType: "student-sign-out",
      commandPayload: {},
    }, authFor(teacher, school.id));
    assert.equal(selectedCommand.status, 201);
    assert.equal(selectedCommand.body.summary.requested, 1);
    assert.equal(selectedCommand.body.summary.sent, 1);
    assert.equal(selectedCommand.body.summary.unavailable, 0);
    assert.equal(selectedCommand.body.command.targets[0].studentId, signOutStudent.id);
    assert.equal(selectedCommand.body.command.targets[0].deviceId, signOutDevice);
    assert.match(selectedCommand.body.message, /Signed out 1 student/);

    const activeAfterSignOut = await inSchool(school.id, () => getActiveSessionByStudent(signOutStudent.id));
    assert.equal(activeAfterSignOut, undefined);

    await inSchool(school.id, () => endTeachingSession(session.id));
  });

  it("excludes actively logged-in students from the shared Chromebook login roster", async () => {
    const enrollmentKey = `${TAG}-login-key`;
    const waitingStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Waiting",
      lastName: "Login",
      email: `waiting-login@${TAG}.example.edu`,
      emailLc: `waiting-login@${TAG}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as any));
    await inSchool(school.id, () => updateEnrollmentSettings(school.id, {
      enrollmentKey,
      enrollmentKeyRequired: true,
      sharedChromebookSignInEnabled: true,
      sharedChromebookLoginMethod: "name_pin",
      sharedChromebookPinLoginEnabled: true,
    }));

    const roster = await requestJson(
      "GET",
      `/classpilot/extension/login-roster?schoolId=${encodeURIComponent(school.id)}&gradeLevel=8`,
      undefined,
      { "x-classpilot-enrollment-key": enrollmentKey }
    );
    assert.equal(roster.status, 200);
    const rosterIds = new Set(roster.body.students.map((student: any) => student.id));
    assert.ok(!rosterIds.has(studentCoverage.id));
    assert.ok(!rosterIds.has(studentDeviceGuard.id));
    assert.ok(rosterIds.has(waitingStudent.id));
    expectNoDeviceIds(roster.body);
  });

  it("lets admins configure one active staff account for central ClassPilot email copies", async () => {
    const adminAuth = authFor(admin, school.id);
    const teacherAuth = authFor(teacher, school.id);

    const forbidden = await requestJson("POST", "/settings", {
      centralEmailRecipientUserId: coverageStaff.id,
    }, teacherAuth);
    assert.equal(forbidden.status, 403);

    const invalid = await requestJson("POST", "/settings", {
      centralEmailRecipientUserId: studentUnassigned.id,
    }, adminAuth);
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /active staff/);

    const update = await requestJson("POST", "/settings", {
      schoolName: school.name,
      retentionHours: "720",
      centralEmailRecipientUserId: coverageStaff.id,
    }, adminAuth);
    assert.equal(update.status, 200);

    const saved = await inSchool(school.id, () => getSettingsForSchool(school.id));
    assert.equal(saved?.centralEmailRecipientUserId, coverageStaff.id);

    const resolved = await inSchool(school.id, () => getCentralEmailRecipientForSchool(school.id));
    assert.equal(resolved?.email, coverageStaff.email);

    const withCentralCopy = await inSchool(school.id, () =>
      addCentralEmailRecipientForSchool(school.id, [admin.email])
    );
    assert.deepEqual(withCentralCopy, [admin.email, coverageStaff.email]);

    const deduped = await inSchool(school.id, () =>
      addCentralEmailRecipientForSchool(school.id, [coverageStaff.email.toUpperCase()])
    );
    assert.deepEqual(deduped, [coverageStaff.email.toUpperCase()]);

    const clear = await requestJson("POST", "/settings", {
      schoolName: school.name,
      retentionHours: "720",
      centralEmailRecipientUserId: null,
    }, adminAuth);
    assert.equal(clear.status, 200);

    const cleared = await inSchool(school.id, () => getSettingsForSchool(school.id));
    assert.equal(cleared?.centralEmailRecipientUserId, null);
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
    const floorCaptain = await createUser({
      email: `floor-captain@${TAG}.example.edu`,
      firstName: "Flo",
      lastName: "Captain",
    } as any);
    await createMembership({ userId: floorCaptain.id, schoolId: school.id, role: "teacher", status: "active" } as any);
    const floorCaptainAuth = authFor(floorCaptain, school.id);

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

    const floorCaptainSetupAssignment = await requestJson("POST", "/coverage/assignments", {
      staffId: floorCaptain.id,
      scopeType: "grade",
      scopeValue: "8",
      permissions: { claim: true, setup: true },
    }, adminAuth);
    assert.equal(floorCaptainSetupAssignment.status, 201);
    assert.equal(floorCaptainSetupAssignment.body.assignment.abilities.claim, true);
    assert.equal(floorCaptainSetupAssignment.body.assignment.abilities.setup, true);
    assert.equal(floorCaptainSetupAssignment.body.assignment.scopeLabel, "Roster Grade: 8");

    const floorCaptainCapabilities = await requestJson("GET", "/coverage/capabilities", undefined, floorCaptainAuth);
    assert.equal(floorCaptainCapabilities.status, 200);
    assert.equal(floorCaptainCapabilities.body.canManageSupervisionSetup, true);
    assert.equal(floorCaptainCapabilities.body.isSchoolwideSetupManager, false);
    assert.ok(floorCaptainCapabilities.body.setupScopes.some((scope: any) => scope.scopeLabel === "Roster Grade: 8"));

    const floorCaptainSetupStudents = await requestJson("GET", "/coverage/setup/students", undefined, floorCaptainAuth);
    assert.equal(floorCaptainSetupStudents.status, 200);
    const floorCaptainStudentIds = new Set(floorCaptainSetupStudents.body.students.map((student: any) => student.id));
    assert.ok(floorCaptainStudentIds.has(studentCoverage.id));
    assert.ok(floorCaptainStudentIds.has(studentDeviceGuard.id));
    assert.ok(!floorCaptainStudentIds.has(studentUnassigned.id));
    expectNoDeviceIds(floorCaptainSetupStudents.body);

    const floorCaptainGroup = await requestJson("POST", "/coverage/supervision-groups", {
      name: "Floor Captain Makeup Group",
      studentIds: [studentCoverage.id],
      staffIds: [coverageStaff.id],
    }, floorCaptainAuth);
    assert.equal(floorCaptainGroup.status, 201);
    assert.equal(floorCaptainGroup.body.group.studentCount, 1);
    assert.ok(floorCaptainGroup.body.group.staff.some((staff: any) => staff.id === coverageStaff.id));
    expectNoDeviceIds(floorCaptainGroup.body);

    const floorCaptainOutOfScopeGroup = await requestJson("POST", "/coverage/supervision-groups", {
      name: "Wrong Grade Group",
      studentIds: [studentUnassigned.id],
      staffIds: [coverageStaff.id],
    }, floorCaptainAuth);
    assert.equal(floorCaptainOutOfScopeGroup.status, 403);

    const floorCaptainClaimAssignment = await requestJson("POST", "/coverage/assignments", {
      staffId: coverageStaff.id,
      scopeType: "grade",
      scopeValue: "8",
    }, floorCaptainAuth);
    assert.equal(floorCaptainClaimAssignment.status, 403);
    assert.match(floorCaptainClaimAssignment.body.error, /Admin access required/);

    const floorCaptainSetupDelegation = await requestJson("POST", "/coverage/assignments", {
      staffId: coverageStaff.id,
      scopeType: "grade",
      scopeValue: "8",
      permissions: { setup: true },
    }, floorCaptainAuth);
    assert.equal(floorCaptainSetupDelegation.status, 403);

    const floorCaptainSchoolwideAssignment = await requestJson("POST", "/coverage/assignments", {
      staffId: coverageStaff.id,
      scopeType: "school",
    }, floorCaptainAuth);
    assert.equal(floorCaptainSchoolwideAssignment.status, 403);

    const floorCaptainAssignments = await requestJson("GET", "/coverage/assignments", undefined, floorCaptainAuth);
    assert.equal(floorCaptainAssignments.status, 403);
    assert.match(floorCaptainAssignments.body.error, /Admin access required/);

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
    assert.equal(teacherCapabilities.body.isSchoolwideSetupManager, true);

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
    assert.match(teacherAssignments.body.error, /Admin access required/);

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
