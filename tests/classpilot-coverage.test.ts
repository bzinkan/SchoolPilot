import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import { signUserToken } from "../dist/services/jwt.js";
import { createStudentToken } from "../dist/services/deviceJwt.js";
import {
  readClasspilotLateSignInDeliveryProvenance,
  withClasspilotLateSignInOrigin,
} from "../dist/services/classpilotClassroomState.js";
import { redisCommand } from "../dist/middleware/rateLimiter.js";
import {
  addGroupStudentsDetailed,
  acknowledgeClasspilotStudentControlState,
  createCoverageAssignment,
  countClasspilotLateSignInStampedStates,
  createCoverageScopeGroup,
  createFlightPath,
  deleteFlightPath,
  createBlockList,
  deleteBlockList,
  createClasspilotCommandWithTargets,
  createDevice,
  deleteDevice,
  createGroup,
  createMembership,
  createProductLicense,
  createPollResponseFirstWrite,
  createSchool,
  createStudent,
  createSupervisionContextWithStudents,
  createTeachingSession,
  createOrReuseScheduledReportSession,
  createUser,
  endStudentSession,
  endTeachingSession,
  expireClasspilotTransientCommandTargets,
  getActiveClassOwnersForStudents,
  getActiveTeachingSessionForSchool,
  getActiveCoverageAssignmentsForStaff,
  getActiveClassOwnerForStudent,
  getActiveSessionByStudent,
  getActiveSessionsForStudents,
  getActiveSupervisionForStudent,
  getCoverageScopeGroupStudentIds,
  getCoverageScopeGroupStudentIdsForGroups,
  getCentralEmailRecipientForSchool,
  getClasspilotSessionStudents,
  getClasspilotSessionStudentRoster,
  getClasspilotStudentControlState,
  getClasspilotCommandByIdAndSchool,
  getActiveClasspilotClassroomStates,
  getActiveHandsForStudent,
  getActiveHandsBySession,
  getPendingMessagesForStudent,
  getRecentMessagesForStudent,
  getGroupStudents,
  getGroupStudentIdsForGroups,
  getGroupTeacherIdsForGroups,
  getSettingsForSchool,
  getOnlineUnassignedStudents,
  addCentralEmailRecipientForSchool,
  addGroupTeacher,
  getActiveScheduledReportSessionForConflict,
  getScheduledClassConflictByIdAndSchool,
  getScheduledGroupsReadyToEnd,
  isAuthorizedClasspilotSessionStaff,
  listCoverageScopeGroups,
  linkStudentDevice,
  markClasspilotCommandTargetsSent,
  replaceCoverageScopeGroupMembers,
  releaseSupervisionStudents,
  resyncActiveClasspilotSessionStudents,
  persistClasspilotCommandTargetAck,
  persistClasspilotControlCommandState,
  replaceClasspilotStudentControlSnapshots,
  replaceClasspilotSupervisionControlSnapshots,
  setActiveStudentForDevice,
  updateCoverageAssignment,
  updateCoverageScopeGroup,
  updateClasspilotCommandTargetAck,
  updateClasspilotCommandSummary,
  updateEnrollmentSettings,
  updateGroup,
  upsertClasspilotActiveHand,
  upsertSessionSettings,
  clearClasspilotActiveHand,
  upsertSettings,
  upsertClasspilotClassroomStates,
  withClasspilotCommandBroadcastLock,
  withClasspilotSupervisionTelemetryAuthority,
} from "../dist/services/storage.js";
import { buildStudentFabState } from "../dist/services/classpilotFab.js";
import { snapshotClasspilotCoverageHydrationMetrics } from "../dist/services/classpilotCoverageHydration.js";
import {
  classpilotRealtimeStatusKey,
  setClasspilotRealtimeStatusCommandForTests,
  writeClasspilotRealtimeStatus,
} from "../dist/services/classpilotRealtimeStatus.js";
import {
  heartbeatTileCacheKey,
  setHeartbeatTileCacheCommandForTests,
} from "../dist/services/heartbeatTileCache.js";
import {
  executeClasspilotCommand,
  normalizeCommandPayload,
} from "../dist/services/classpilotCommandDispatcher.js";
import {
  expireScheduledClassConflictsForSchool,
  processScheduledClassAutoStart,
  startActiveScheduledClassesForTeacher,
} from "../dist/services/classpilotScheduledStart.js";
import { getAuditLogs } from "../dist/services/audit.js";
import { scopedDeviceTargets } from "../dist/services/classpilotDeviceScope.js";
import { localDateInTimeZone } from "../dist/util/schoolTime.js";

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
let sessionGuard: any;
let server: Server;
let baseUrl: string;
let originalRedisUrl: string | undefined;

const deviceUnassigned = `${TAG}-device-unassigned`;
const deviceInClass = `${TAG}-device-class`;
const deviceCoverage = `${TAG}-device-coverage`;
const deviceGuard = `${TAG}-device-guard`;
const sharedRealtimeRows = new Map<string, string>();
let sharedRealtimeAvailable = false;

async function sharedRealtimeCommand(args: string[]): Promise<unknown> {
  if (!sharedRealtimeAvailable) throw new Error("shared realtime unavailable in test");
  if (args[0] === "MGET") {
    return args.slice(1).map((key) => sharedRealtimeRows.get(key) ?? null);
  }
  if (args[0] === "DEL") {
    let deleted = 0;
    for (const key of args.slice(1)) {
      if (sharedRealtimeRows.delete(key)) deleted += 1;
    }
    return deleted;
  }
  if (args[0] === "EVAL") {
    const key = args[3];
    const snapshotJson = args[5];
    if (!key || !snapshotJson) {
      throw new Error("Malformed shared realtime EVAL command in test");
    }
    const proposedRevision = Number(args[4]) || 0;
    const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
    const currentRaw = sharedRealtimeRows.get(key);
    const current = currentRaw
      ? JSON.parse(currentRaw) as Record<string, unknown>
      : undefined;
    snapshot.revision = Math.max(
      proposedRevision,
      Number(current?.revision || 0) + 1
    );
    const encoded = JSON.stringify(snapshot);
    sharedRealtimeRows.set(key, encoded);
    return encoded;
  }
  throw new Error(`Unsupported shared realtime command in test: ${args[0] || ""}`);
}

async function withSharedRealtime<T>(run: () => Promise<T>): Promise<T> {
  sharedRealtimeRows.clear();
  sharedRealtimeAvailable = true;
  try {
    return await run();
  } finally {
    sharedRealtimeAvailable = false;
    sharedRealtimeRows.clear();
  }
}

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

function expectNoInternalRealtimeBindings(value: unknown, forbiddenValues: readonly string[]) {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate)) {
      const normalizedKey = key.toLowerCase();
      assert.equal(normalizedKey.includes("deviceid"), false, `teacher DTO exposed ${key}`);
      assert.equal(normalizedKey.includes("studentsessionid"), false, `teacher DTO exposed ${key}`);
      visit(nested);
    }
  };

  visit(value);
  const serialized = JSON.stringify(value);
  for (const forbidden of forbiddenValues) {
    assert.equal(serialized.includes(forbidden), false, `teacher DTO exposed internal value ${forbidden}`);
  }
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
  await db.execute(sql`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'live'`);
  await db.execute(sql`ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS scheduled_conflict_id TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS teaching_sessions_session_mode_idx ON teaching_sessions (session_mode)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS teaching_sessions_scheduled_conflict_idx ON teaching_sessions (scheduled_conflict_id)`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS school_id TEXT`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS command_id VARCHAR`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS teaching_session_id VARCHAR`);
  await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS supervision_context_id VARCHAR`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_command_student_unique
    ON messages (command_id, to_student_id)
    WHERE command_id IS NOT NULL AND to_student_id IS NOT NULL
  `);

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
  setClasspilotRealtimeStatusCommandForTests(sharedRealtimeCommand);
  mock.timers.enable({ apis: ["setInterval"] });

  await ensureCoverageTables();

  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
  } as any);
  await inSchool(school.id, () => upsertSettings(school.id, {
    schoolName: school.name,
    wsSharedKey: `${TAG}-shared-key`,
  }));
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
    sessionGuard = await setActiveStudentForDevice(deviceGuard, studentDeviceGuard.id);
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
        await db.execute(sql`DELETE FROM classpilot_session_summary_deliveries WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM poll_responses WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM polls WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_chat_deliveries WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM chat_messages WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM messages WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM classpilot_active_hands WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM session_settings WHERE school_id = ${school.id}`);
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
  setClasspilotRealtimeStatusCommandForTests(undefined);
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
  await pool.end();
});

describe("ClassPilot supervision coverage storage contracts", () => {
  it("returns 200 with an exact empty roster for admin school-wide and Observe views", async () => {
    const emptySchool = await createSchool({
      name: `${TAG}_Empty_School`,
      domain: `${TAG}-empty.example.edu`,
      slug: `${TAG}-empty`,
    });
    const emptyAdmin = await createUser({
      email: `admin@${TAG}-empty.example.edu`,
      firstName: "Empty",
      lastName: "Admin",
    });
    const emptyTeacher = await createUser({
      email: `teacher@${TAG}-empty.example.edu`,
      firstName: "Empty",
      lastName: "Teacher",
    });

    try {
      await createProductLicense({
        schoolId: emptySchool.id,
        product: "CLASSPILOT",
        status: "active",
      });
      await createMembership({
        userId: emptyAdmin.id,
        schoolId: emptySchool.id,
        role: "admin",
        status: "active",
      });
      await createMembership({
        userId: emptyTeacher.id,
        schoolId: emptySchool.id,
        role: "teacher",
        status: "active",
      });

      const schoolWide = await requestJson(
        "GET",
        "/students-aggregated",
        undefined,
        authFor(emptyAdmin, emptySchool.id)
      );
      assert.equal(schoolWide.status, 200);
      assert.deepEqual(schoolWide.body, []);

      const emptyGroup = await inSchool(emptySchool.id, () => createGroup({
        schoolId: emptySchool.id,
        teacherId: emptyTeacher.id,
        name: `${TAG}_Empty_Group`,
        groupType: "admin_class",
        status: "active",
      }));
      const emptySession = await inSchool(emptySchool.id, () => createTeachingSession({
        groupId: emptyGroup.id,
        teacherId: emptyTeacher.id,
      }));
      const observed = await requestJson(
        "GET",
        `/students-aggregated?teachingSessionId=${encodeURIComponent(emptySession.id)}`,
        undefined,
        authFor(emptyAdmin, emptySchool.id)
      );
      assert.equal(observed.status, 200);
      assert.deepEqual(observed.body, []);
    } finally {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${emptySchool.id}`);
        await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${emptySchool.id}`);
        await db.execute(sql`DELETE FROM groups WHERE school_id = ${emptySchool.id}`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${emptySchool.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${emptySchool.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${emptySchool.id}`);
        await db.execute(sql`DELETE FROM users WHERE id IN (${emptyAdmin.id}, ${emptyTeacher.id})`);
      });
    }
  });

  it("keeps admin and Observe rosters available across heartbeat-history fallback rows", async () => {
    const fallbackSchool = await createSchool({
      name: `${TAG}_Fallback_School`,
      domain: `${TAG}-fallback.example.edu`,
      slug: `${TAG}-fallback`,
    });
    const fallbackAdmin = await createUser({
      email: `admin@${TAG}-fallback.example.edu`,
      firstName: "Fallback",
      lastName: "Admin",
    });
    const fallbackTeacher = await createUser({
      email: `teacher@${TAG}-fallback.example.edu`,
      firstName: "Fallback",
      lastName: "Teacher",
    });
    const healthyDeviceId = `${TAG}-fallback-device-healthy`;
    const invalidDeviceId = `${TAG}-fallback-device-invalid`;

    try {
      await createProductLicense({
        schoolId: fallbackSchool.id,
        product: "CLASSPILOT",
        status: "active",
      });
      await createMembership({
        userId: fallbackAdmin.id,
        schoolId: fallbackSchool.id,
        role: "admin",
        status: "active",
      });
      await createMembership({
        userId: fallbackTeacher.id,
        schoolId: fallbackSchool.id,
        role: "teacher",
        status: "active",
      });
      const healthyStudent = await inSchool(fallbackSchool.id, () => createStudent({
        schoolId: fallbackSchool.id,
        firstName: "Healthy",
        lastName: "Fallback",
        email: `healthy@${TAG}-fallback.example.edu`,
        emailLc: `healthy@${TAG}-fallback.example.edu`,
        gradeLevel: "7",
        status: "active",
      }));
      const invalidStudent = await inSchool(fallbackSchool.id, () => createStudent({
        schoolId: fallbackSchool.id,
        firstName: "Invalid",
        lastName: "Fallback",
        email: `invalid@${TAG}-fallback.example.edu`,
        emailLc: `invalid@${TAG}-fallback.example.edu`,
        gradeLevel: "7",
        status: "active",
      }));
      await inSchool(fallbackSchool.id, async () => {
        await createDevice({
          deviceId: healthyDeviceId,
          schoolId: fallbackSchool.id,
          classId: "default",
          deviceName: "Healthy fallback",
        });
        await createDevice({
          deviceId: invalidDeviceId,
          schoolId: fallbackSchool.id,
          classId: "default",
          deviceName: "Invalid fallback",
        });
        await linkStudentDevice({ studentId: healthyStudent.id, deviceId: healthyDeviceId });
        await linkStudentDevice({ studentId: invalidStudent.id, deviceId: invalidDeviceId });
        await setActiveStudentForDevice(healthyDeviceId, healthyStudent.id);
        await setActiveStudentForDevice(invalidDeviceId, invalidStudent.id);
      });
      const fallbackGroup = await inSchool(fallbackSchool.id, () => createGroup({
        schoolId: fallbackSchool.id,
        teacherId: fallbackTeacher.id,
        name: `${TAG}_Fallback_Group`,
        groupType: "admin_class",
        status: "active",
      }));
      await inSchool(fallbackSchool.id, () => addGroupStudentsDetailed(fallbackGroup.id, [
        healthyStudent.id,
        invalidStudent.id,
      ]));
      const fallbackSession = await inSchool(fallbackSchool.id, () => createTeachingSession({
        groupId: fallbackGroup.id,
        teacherId: fallbackTeacher.id,
      }));

      const observedAt = new Date();
      const cacheRows = new Map<string, string[]>([
        [heartbeatTileCacheKey(fallbackSchool.id, healthyDeviceId), [JSON.stringify({
          id: `${TAG}-fallback-heartbeat-healthy`,
          schoolId: fallbackSchool.id,
          deviceId: healthyDeviceId,
          studentId: healthyStudent.id,
          studentEmail: healthyStudent.email,
          activeTabTitle: "Healthy history fallback",
          activeTabUrl: "https://example.edu/fallback",
          favicon: null,
          screenLocked: false,
          flightPathActive: false,
          activeFlightPathName: null,
          isSharing: false,
          cameraActive: false,
          aiCategory: null,
          safetyAlert: null,
          extensionVersion: null,
          chromeVersion: null,
          screenshotHealth: null,
          timestamp: observedAt.toISOString(),
          classificationPending: false,
        })]],
        [heartbeatTileCacheKey(fallbackSchool.id, invalidDeviceId), [JSON.stringify({
          id: `${TAG}-fallback-heartbeat-invalid`,
          schoolId: fallbackSchool.id,
          deviceId: invalidDeviceId,
          studentId: invalidStudent.id,
          studentEmail: invalidStudent.email,
          activeTabTitle: "Must not escape",
          activeTabUrl: "https://example.edu/invalid",
          favicon: null,
          screenLocked: false,
          flightPathActive: false,
          activeFlightPathName: null,
          isSharing: false,
          cameraActive: false,
          aiCategory: null,
          safetyAlert: null,
          extensionVersion: null,
          chromeVersion: null,
          screenshotHealth: null,
          timestamp: "0",
          classificationPending: false,
        })]],
      ]);
      let historyBatchReads = 0;
      setHeartbeatTileCacheCommandForTests(async (args: string[]) => {
        historyBatchReads += 1;
        const keyCount = Number(args[2]);
        return args.slice(3, 3 + keyCount).map((key) => cacheRows.get(key) ?? []);
      });

      const assertFallbackRoster = (body: unknown) => {
        assert.ok(Array.isArray(body));
        const healthyRow = body.find((row: unknown) => (
          !!row && typeof row === "object"
          && (row as Record<string, unknown>).studentId === healthyStudent.id
        ));
        const invalidRow = body.find((row: unknown) => (
          !!row && typeof row === "object"
          && (row as Record<string, unknown>).studentId === invalidStudent.id
        ));
        assert.ok(healthyRow);
        assert.ok(invalidRow);
        assert.equal(
          (healthyRow as Record<string, unknown>).activeTabTitle,
          "Healthy history fallback"
        );
        assert.equal((invalidRow as Record<string, unknown>).activeTabTitle, "");
        expectNoInternalRealtimeBindings(body, [
          healthyDeviceId,
          invalidDeviceId,
        ]);
      };

      const schoolWide = await requestJson(
        "GET",
        "/students-aggregated",
        undefined,
        authFor(fallbackAdmin, fallbackSchool.id)
      );
      assert.equal(schoolWide.status, 200);
      assertFallbackRoster(schoolWide.body);

      const observed = await requestJson(
        "GET",
        `/students-aggregated?teachingSessionId=${encodeURIComponent(fallbackSession.id)}`,
        undefined,
        authFor(fallbackAdmin, fallbackSchool.id)
      );
      assert.equal(observed.status, 200);
      assertFallbackRoster(observed.body);
      assert.ok(historyBatchReads >= 2);
    } finally {
      setHeartbeatTileCacheCommandForTests(undefined);
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM student_sessions WHERE device_id IN (${healthyDeviceId}, ${invalidDeviceId})`);
        await db.execute(sql`DELETE FROM student_devices WHERE device_id IN (${healthyDeviceId}, ${invalidDeviceId})`);
        await db.execute(sql`DELETE FROM devices WHERE school_id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${fallbackSchool.id})`);
        await db.execute(sql`DELETE FROM groups WHERE school_id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM students WHERE school_id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${fallbackSchool.id}`);
        await db.execute(sql`DELETE FROM users WHERE id IN (${fallbackAdmin.id}, ${fallbackTeacher.id})`);
      });
    }
  });

  it("returns immediate 403 for revoked staff and device ingest entitlements", async () => {
    const studentToken = createStudentToken({
      schoolId: school.id,
      studentId: studentDeviceGuard.id,
      deviceId: deviceGuard,
      sessionId: sessionGuard.id,
      studentEmail: studentDeviceGuard.email,
    });
    const deviceAuth = { authorization: `Bearer ${studentToken}` };
    try {
      await asSystem(() => db.execute(sql`
        UPDATE schools SET disabled_at = now() WHERE id = ${school.id}
      `));
      const disabledScreenshot = await requestJson(
        "POST",
        "/classpilot/device/screenshot",
        { screenshot: "data:image/jpeg;base64,AA==" },
        deviceAuth
      );
      assert.equal(disabledScreenshot.status, 403);
      assert.equal(disabledScreenshot.body.code, "CLASSPILOT_NOT_ENTITLED");
      const disabledStatus = await requestJson(
        "POST",
        "/classpilot/school/status",
        { studentToken }
      );
      assert.equal(disabledStatus.status, 403);
      assert.equal(disabledStatus.body.code, "CLASSPILOT_NOT_ENTITLED");
      assert.equal(disabledStatus.body.reason, "school_inactive");
      assert.equal(disabledStatus.body.planStatus, "inactive");
      const publicDisabledStatus = await requestJson(
        "POST",
        "/classpilot/school/status",
        { studentEmail: studentDeviceGuard.email }
      );
      assert.equal(publicDisabledStatus.status, 200);
      assert.deepEqual(publicDisabledStatus.body, {
        schoolActive: false,
        schoolSessionVersion: 1,
      });
      const disabledExtensionRegistration = await requestJson(
        "POST",
        "/classpilot/extension/register",
        {
          deviceId: `${TAG}-disabled-extension-register`,
          studentEmail: studentDeviceGuard.email,
          schoolId: school.id,
        }
      );
      assert.equal(disabledExtensionRegistration.status, 403);
      assert.equal(disabledExtensionRegistration.body.code, "CLASSPILOT_NOT_ENTITLED");
      assert.equal(disabledExtensionRegistration.body.reason, "school_inactive");
      const disabledEmailIdLogin = await requestJson(
        "POST",
        "/classpilot/extension/student-login",
        {
          deviceId: `${TAG}-disabled-email-id-login`,
          studentEmail: studentDeviceGuard.email,
          studentIdNumber: "does-not-matter",
        }
      );
      assert.equal(disabledEmailIdLogin.status, 403);
      assert.equal(disabledEmailIdLogin.body.code, "CLASSPILOT_NOT_ENTITLED");
      const disabledPinLogin = await requestJson(
        "POST",
        "/classpilot/extension/student-login",
        {
          deviceId: `${TAG}-disabled-pin-login`,
          schoolId: school.id,
          studentId: studentDeviceGuard.id,
          pin: "0000",
        }
      );
      assert.equal(disabledPinLogin.status, 403);
      assert.equal(disabledPinLogin.body.code, "CLASSPILOT_NOT_ENTITLED");

      await asSystem(() => db.execute(sql`
        UPDATE schools SET disabled_at = NULL, is_active = false WHERE id = ${school.id}
      `));
      const inactiveCommand = await requestJson("POST", "/commands", {}, authFor(teacher, school.id));
      assert.equal(inactiveCommand.status, 403);
      assert.equal(inactiveCommand.body.code, "CLASSPILOT_NOT_ENTITLED");

      await asSystem(() => db.execute(sql`
        UPDATE schools SET is_active = true, status = 'inactive' WHERE id = ${school.id}
      `));
      const inactiveStatus = await requestJson("POST", "/commands", {}, authFor(teacher, school.id));
      assert.equal(inactiveStatus.status, 403);
      assert.equal(inactiveStatus.body.code, "CLASSPILOT_NOT_ENTITLED");

      await asSystem(async () => {
        await db.execute(sql`UPDATE schools SET status = 'active' WHERE id = ${school.id}`);
        await db.execute(sql`
          UPDATE product_licenses
          SET status = 'inactive'
          WHERE school_id = ${school.id} AND product = 'CLASSPILOT'
        `);
      });
      const unlicensedEvent = await requestJson(
        "POST",
        "/classpilot/device/event",
        {},
        deviceAuth
      );
      assert.equal(unlicensedEvent.status, 403);
      assert.equal(unlicensedEvent.body.code, "CLASSPILOT_NOT_ENTITLED");
      const unlicensedStatus = await requestJson(
        "POST",
        "/classpilot/school/status",
        { studentToken }
      );
      assert.equal(unlicensedStatus.status, 403);
      assert.equal(unlicensedStatus.body.code, "CLASSPILOT_NOT_ENTITLED");
      assert.equal(unlicensedStatus.body.reason, "license_inactive");
      assert.equal(unlicensedStatus.body.planStatus, "inactive");
      const unlicensedLegacyRegistration = await requestJson(
        "POST",
        "/classpilot/register-student",
        {
          deviceId: `${TAG}-unlicensed-legacy-register`,
          studentEmail: studentDeviceGuard.email,
          schoolId: school.id,
        }
      );
      assert.equal(unlicensedLegacyRegistration.status, 403);
      assert.equal(unlicensedLegacyRegistration.body.code, "CLASSPILOT_NOT_ENTITLED");
      assert.equal(unlicensedLegacyRegistration.body.reason, "license_inactive");
    } finally {
      await asSystem(async () => {
        await db.execute(sql`
          UPDATE schools
          SET disabled_at = NULL, is_active = true, status = 'active'
          WHERE id = ${school.id}
        `);
        await db.execute(sql`
          UPDATE product_licenses
          SET status = 'active'
          WHERE school_id = ${school.id} AND product = 'CLASSPILOT'
        `);
      });
    }
  });

  it("raises one active hand idempotently under concurrent retries", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Concurrent_Hand`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentUnassigned.id]));
    const session = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    const expiresAt = new Date(Date.now() + 60_000);
    try {
      const attempts = await Promise.all(Array.from({ length: 16 }, () =>
        inSchool(school.id, () => upsertClasspilotActiveHand({
          schoolId: school.id,
          teachingSessionId: session.id,
          studentId: studentUnassigned.id,
          deviceId: deviceUnassigned,
          raisedAt: new Date(),
          expiresAt,
          clearedAt: null,
        }))
      ));
      assert.equal(new Set(attempts.map((row) => row.id)).size, 1);
      const active = await inSchool(school.id, () =>
        getActiveHandsForStudent(school.id, studentUnassigned.id)
      );
      assert.equal(active.length, 1);
      assert.equal(active[0]?.teachingSessionId, session.id);
    } finally {
      await inSchool(school.id, () => clearClasspilotActiveHand({
        schoolId: school.id,
        teachingSessionId: session.id,
        studentId: studentUnassigned.id,
      }));
      await inSchool(school.id, () => endTeachingSession(session.id));
    }
  });

  it("clears a raised hand when classroom ownership moves to a replacement session", async () => {
    const groupA = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Hand_Owner_A`,
      groupType: "admin_class",
      status: "active",
    } as any));
    const groupB = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: admin.id,
      name: `${TAG}_Hand_Owner_B`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(groupA.id, [studentUnassigned.id]));
    await inSchool(school.id, () => addGroupStudentsDetailed(groupB.id, [studentUnassigned.id]));
    const sessionA = await inSchool(school.id, () => createTeachingSession({
      groupId: groupA.id,
      teacherId: teacher.id,
    }));
    let sessionB: Awaited<ReturnType<typeof createTeachingSession>> | undefined;
    try {
      const hand = await inSchool(school.id, () => upsertClasspilotActiveHand({
        schoolId: school.id,
        teachingSessionId: sessionA.id,
        studentId: studentUnassigned.id,
        deviceId: deviceUnassigned,
        expiresAt: new Date(Date.now() + 60_000),
      } as any));
      assert.equal(hand.clearedAt, null);

      sessionB = await inSchool(school.id, () => createTeachingSession({
        groupId: groupB.id,
        teacherId: admin.id,
      }));
      const [studentHands, formerTeacherHands, fab] = await inSchool(school.id, () => Promise.all([
        getActiveHandsForStudent(school.id, studentUnassigned.id),
        getActiveHandsBySession(school.id, sessionA.id),
        buildStudentFabState(school.id, studentUnassigned.id),
      ]));
      assert.deepEqual(studentHands, []);
      assert.deepEqual(formerTeacherHands, []);
      assert.equal(fab.handRaised, false);
      assert.deepEqual(fab.activeHands, []);
      assert.deepEqual(fab.activeSessionIds, [sessionB.id]);
      const retained = await inSchool(school.id, () => db.execute(sql`
        SELECT cleared_at FROM classpilot_active_hands WHERE id = ${hand.id}
      `));
      assert.ok((retained.rows[0] as any)?.cleared_at);
    } finally {
      if (sessionB) await inSchool(school.id, () => endTeachingSession(sessionB!.id));
      await inSchool(school.id, () => endTeachingSession(sessionA.id));
    }
  });

  it("clears active hands before device deletion while retaining historical hand rows", async () => {
    const handDeviceId = `${TAG}-historical-hand-device`;
    await inSchool(school.id, () => createDevice({
      deviceId: handDeviceId,
      schoolId: school.id,
      classId: "default",
      deviceName: "Historical Hand",
    } as any));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Historical_Hand`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentUnassigned.id]));
    const session = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    try {
      const hand = await inSchool(school.id, () => upsertClasspilotActiveHand({
        schoolId: school.id,
        teachingSessionId: session.id,
        studentId: studentUnassigned.id,
        deviceId: handDeviceId,
      } as any));
      assert.equal(hand.clearedAt, null);
      assert.equal(await inSchool(school.id, () => deleteDevice(handDeviceId)), true);
      const retained = await inSchool(school.id, () => db.execute(sql`
        SELECT cleared_at
        FROM classpilot_active_hands
        WHERE id = ${hand.id}
      `));
      assert.ok((retained.rows[0] as any)?.cleared_at);
    } finally {
      await inSchool(school.id, () => endTeachingSession(session.id));
    }
  });

  it("returns 404 semantics for another teacher's Flight Path or block list", async () => {
    const foreignFlightPath = await inSchool(school.id, () => createFlightPath({
      schoolId: school.id,
      teacherId: admin.id,
      flightPathName: `${TAG}_Foreign_Flight_Path`,
      allowedDomains: ["example.edu"],
    }));
    const foreignBlockList = await inSchool(school.id, () => createBlockList({
      schoolId: school.id,
      teacherId: admin.id,
      name: `${TAG}_Foreign_Block_List`,
      blockedDomains: ["blocked.example"],
    }));
    try {
      await assert.rejects(
        () => inSchool(school.id, () => normalizeCommandPayload(
          "apply-flight-path",
          { flightPathId: foreignFlightPath.id },
          school.id,
          teacher.id
        )),
        (error: any) => error?.status === 404 && error?.message === "Flight Path not found"
      );
      await assert.rejects(
        () => inSchool(school.id, () => normalizeCommandPayload(
          "apply-block-list",
          { blockListId: foreignBlockList.id },
          school.id,
          teacher.id
        )),
        (error: any) => error?.status === 404 && error?.message === "Block List not found"
      );
    } finally {
      await inSchool(school.id, () => deleteFlightPath(foreignFlightPath.id, school.id));
      await inSchool(school.id, () => deleteBlockList(foreignBlockList.id, school.id));
    }
  });

  it("rejects applying an empty draft Flight Path with a stable resource error", async () => {
    const emptyFlightPath = await inSchool(school.id, () => createFlightPath({
      schoolId: school.id,
      teacherId: teacher.id,
      flightPathName: `${TAG}_Empty_Flight_Path`,
      allowedDomains: [],
    }));
    try {
      await assert.rejects(
        () => inSchool(school.id, () => normalizeCommandPayload(
          "apply-flight-path",
          { flightPathId: emptyFlightPath.id },
          school.id,
          teacher.id
        )),
        (error: any) => error?.status === 409 && error?.code === "FLIGHT_PATH_EMPTY"
      );
    } finally {
      await inSchool(school.id, () => deleteFlightPath(emptyFlightPath.id, school.id));
    }
  });

  it("batch-loads active student sessions within the requested school", async () => {
    const sessions = await inSchool(school.id, () => getActiveSessionsForStudents(
      school.id,
      [studentUnassigned.id, studentDeviceGuard.id, studentUnassigned.id, ""]
    ));
    assert.deepEqual(
      new Set(sessions.map((session) => session.studentId)),
      new Set([studentUnassigned.id, studentDeviceGuard.id])
    );
    assert.equal(sessions.length, 2);

    const wrongSchool = await inSchool(school.id, () => getActiveSessionsForStudents(
      "not-the-requested-school",
      [studentUnassigned.id, studentDeviceGuard.id]
    ));
    assert.deepEqual(wrongSchool, []);
    assert.deepEqual(await inSchool(school.id, () => getActiveSessionsForStudents(school.id, [])), []);
  });

  it("batch-loads direct and supervision-group membership within one exact school", async () => {
    const directGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Bulk_Membership`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(
      directGroup.id,
      [studentUnassigned.id, studentDeviceGuard.id]
    ));
    await inSchool(school.id, () => addGroupTeacher(
      directGroup.id,
      admin.id,
      "co-teacher"
    ));
    const coverageGroup = await inSchool(school.id, () => createCoverageScopeGroup({
      group: {
        schoolId: school.id,
        name: `${TAG}_Bulk_Coverage_Membership`,
        createdBy: admin.id,
      },
      studentIds: [studentCoverage.id],
    }));

    const direct = await inSchool(school.id, () => getGroupStudentIdsForGroups(
      school.id,
      [directGroup.id, directGroup.id]
    ));
    assert.deepEqual(
      direct.get(directGroup.id),
      new Set([studentUnassigned.id, studentDeviceGuard.id])
    );
    const teachers = await inSchool(school.id, () => getGroupTeacherIdsForGroups(
      school.id,
      [directGroup.id, directGroup.id]
    ));
    assert.deepEqual(
      teachers.get(directGroup.id),
      new Set([teacher.id, admin.id])
    );
    const coverage = await inSchool(school.id, () => getCoverageScopeGroupStudentIdsForGroups(
      school.id,
      [coverageGroup.id, coverageGroup.id]
    ));
    assert.deepEqual(coverage.get(coverageGroup.id), new Set([studentCoverage.id]));

    const wrongSchoolDirect = await inSchool(school.id, () => getGroupStudentIdsForGroups(
      "not-the-requested-school",
      [directGroup.id]
    ));
    assert.deepEqual(wrongSchoolDirect.get(directGroup.id), new Set());
    const wrongSchoolTeachers = await inSchool(school.id, () => getGroupTeacherIdsForGroups(
      "not-the-requested-school",
      [directGroup.id]
    ));
    assert.deepEqual(wrongSchoolTeachers.get(directGroup.id), new Set());
    const wrongSchoolCoverage = await inSchool(school.id, () => getCoverageScopeGroupStudentIdsForGroups(
      "not-the-requested-school",
      [coverageGroup.id]
    ));
    assert.deepEqual(wrongSchoolCoverage.get(coverageGroup.id), new Set());
  });

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

  it("caps long scheduled control windows at the 12-hour safety cutoff", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Long_Scheduled_Control_Window`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentUnassigned.id]));

    const scheduledStartAt = new Date(Date.now() - 5 * 60_000);
    const hardExpiresAt = new Date(scheduledStartAt.getTime() + 12 * 60 * 60_000);
    const scheduledEndAt = new Date(hardExpiresAt.getTime() + 60 * 60_000);
    const session = await inSchool(school.id, () => createOrReuseScheduledReportSession({
      schoolId: school.id,
      groupId: group.id,
      teacherId: teacher.id,
      scheduledDate: localDateInTimeZone(scheduledStartAt, "America/New_York"),
      scheduledTimezone: "America/New_York",
      scheduledStartAt,
      scheduledEndAt,
      scheduledTeacherEmail: teacher.email,
      scheduledTeacherName: "Tara Teacher",
    }));

    assert.equal(session.scheduledEndAt?.toISOString(), scheduledEndAt.toISOString());
    const controlState = await inSchool(school.id, () =>
      getClasspilotStudentControlState(school.id, studentUnassigned.id)
    );
    assert.equal(controlState?.teachingSessionId, session.id);
    assert.equal(controlState?.scheduledEndAt?.toISOString(), hardExpiresAt.toISOString());
    assert.equal(controlState?.hardExpiresAt?.toISOString(), hardExpiresAt.toISOString());

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
    const scheduledCoTeacher = await createUser({
      email: `scheduled-coteacher@${TAG}.example.edu`,
      firstName: "Cory",
      lastName: "CoTeacher",
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
    await createMembership({ userId: scheduledCoTeacher.id, schoolId: school.id, role: "teacher", status: "active" } as any);
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
      now: new Date("2026-01-15T13:15:00.000Z"),
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
    await inSchool(school.id, () => addGroupTeacher(scheduledGroup.id, scheduledCoTeacher.id, "co-teacher"));
    const sourceSession = await inSchool(school.id, () => createTeachingSession({
      groupId: sourceGroup.id,
      teacherId: sourceTeacher.id,
    } as any));

    const coverageNeeded = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set([sourceTeacher.id]),
      now: new Date("2026-01-15T14:15:00.000Z"),
    }));
    assert.equal(coverageNeeded.status, "coverage_needed");
    const scheduledActive = await inSchool(school.id, () => getActiveTeachingSessionForSchool(scheduledTeacher.id, school.id));
    assert.equal(scheduledActive, undefined);
    const reportSession = await inSchool(school.id, () => getActiveScheduledReportSessionForConflict(
      school.id,
      coverageNeeded.status === "coverage_needed" ? coverageNeeded.conflictId : ""
    ));
    assert.equal(reportSession?.groupId, scheduledGroup.id);
    assert.equal((reportSession as any)?.sessionMode, "scheduled_report");

    const duplicate = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set([sourceTeacher.id]),
      now: new Date("2026-01-15T14:15:00.000Z"),
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
    assert.equal(staffQueue.body.scheduledCoverageGroups[0].canStartClass, false);
    const scheduledCoverageIds = new Set(staffQueue.body.scheduledCoverageGroups[0].students.map((student: any) => student.studentId));
    assert.equal(scheduledCoverageIds.has(scheduledOnlyStudent.id), true);
    expectNoDeviceIds(staffQueue.body.scheduledCoverageGroups[0]);

    const scheduledTeacherList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(scheduledTeacher, school.id));
    assert.equal(scheduledTeacherList.status, 200);
    assert.equal(scheduledTeacherList.body.conflicts.length, 1);
    assert.equal(scheduledTeacherList.body.conflicts[0].canStartAnyway, true);
    const scheduledTeacherQueue = await requestJson("GET", "/coverage/available-students", undefined, authFor(scheduledTeacher, school.id));
    assert.equal(scheduledTeacherQueue.status, 200);
    assert.equal(scheduledTeacherQueue.body.scheduledCoverageGroups.length, 1);
    assert.equal(scheduledTeacherQueue.body.scheduledCoverageGroups[0].canStartClass, true);

    const adminQueue = await requestJson("GET", "/coverage/available-students", undefined, authFor(admin, school.id));
    assert.equal(adminQueue.status, 200);
    assert.equal(adminQueue.body.scheduledCoverageGroups.length, 1);
    assert.equal(adminQueue.body.scheduledCoverageGroups[0].canStartClass, true);

    const scheduledCoTeacherList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(scheduledCoTeacher, school.id));
    assert.equal(scheduledCoTeacherList.status, 200);
    assert.equal(scheduledCoTeacherList.body.conflicts.length, 1);
    assert.equal(scheduledCoTeacherList.body.conflicts[0].audience, "scheduled_coteacher");
    assert.equal(scheduledCoTeacherList.body.conflicts[0].canStartAnyway, true);
    assert.match(scheduledCoTeacherList.body.conflicts[0].message, /can start it now/);

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

    const coTeacherQueue = await requestJson("GET", "/coverage/available-students", undefined, authFor(scheduledCoTeacher, school.id));
    assert.equal(coTeacherQueue.status, 200);
    assert.equal(coTeacherQueue.body.scheduledCoverageGroups.length, 1);
    assert.equal(coTeacherQueue.body.scheduledCoverageGroups[0].canStartClass, true);
    assert.equal(
      coTeacherQueue.body.scheduledCoverageGroups[0].students.some(
        (student: any) => student.studentId === scheduledOnlyStudent.id
      ),
      true
    );

    const claim = await requestJson("POST", "/coverage/claim", {
      scheduledConflictId: conflict.id,
      studentIds: [scheduledOnlyStudent.id],
    }, authFor(scheduledCoTeacher, school.id));
    assert.equal(claim.status, 201);
    const activeScheduledCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(activeScheduledCoverage?.context.contextType, "scheduled_coverage");

    const skipped = await requestJson("POST", `/classpilot/scheduled-conflicts/${conflict.id}/skip`, {}, authFor(scheduledTeacher, school.id));
    assert.equal(skipped.status, 409);
    assert.equal(skipped.body.code, "SCHEDULED_OCCURRENCE_ALREADY_STARTED");
    const activeReportSession = await inSchool(school.id, () => getActiveScheduledReportSessionForConflict(school.id, conflict.id));
    assert.ok(activeReportSession);
    const earlyEnd = await requestJson(
      "POST",
      `/classpilot/teaching-sessions/${activeReportSession!.id}/end`,
      {},
      authFor(scheduledTeacher, school.id)
    );
    assert.equal(earlyEnd.status, 200);
    assert.equal(earlyEnd.body.summaryDisposition, "queued");
    assert.equal(earlyEnd.body.finalizationReason, "teacher_end");
    const skippedReportSession = await inSchool(school.id, () => getActiveScheduledReportSessionForConflict(school.id, conflict.id));
    assert.equal(skippedReportSession, undefined);
    const skippedCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(skippedCoverage, undefined);
    const skippedRetry = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: scheduledGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2026-01-15T14:15:00.000Z"),
    }));
    assert.equal(skippedRetry.status, "skipped");
    if (activeScheduledCoverage) {
      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: activeScheduledCoverage.context.id,
        releaseReason: "test_cleanup",
      }));
    }

    // The following blocks are independent coverage scenarios. Retire the
    // earlier recurring schedules before creating an all-day class for the
    // same teacher; production storage now correctly rejects that overlap.
    await inSchool(school.id, () => updateGroup(connectedGroup.id, {
      scheduleEnabled: false,
    } as any));
    await inSchool(school.id, () => updateGroup(scheduledGroup.id, {
      scheduleEnabled: false,
    } as any));

    const loginPickupGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: scheduledTeacher.id,
      name: `${TAG}_Scheduled_Login_Pickup`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "00:00",
      blockEndTime: "23:59",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(loginPickupGroup.id, [scheduledOnlyStudent.id]));
    const loginPickupStart = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: loginPickupGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2026-01-15T15:00:00.000Z"),
    }));
    assert.equal(loginPickupStart.status, "coverage_needed");
    const loginPickupConflictId = loginPickupStart.status === "coverage_needed" ? loginPickupStart.conflictId : "";
    const loginPickupReport = await inSchool(school.id, () => getActiveScheduledReportSessionForConflict(school.id, loginPickupConflictId));
    assert.equal((loginPickupReport as any)?.sessionMode, "scheduled_report");
    const loginPickupClaim = await requestJson("POST", "/coverage/claim", {
      scheduledConflictId: loginPickupConflictId,
      studentIds: [scheduledOnlyStudent.id],
    }, authFor(scheduledCoverageStaff, school.id));
    assert.equal(loginPickupClaim.status, 201);
    const loginPickupCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(loginPickupCoverage?.context.contextType, "scheduled_coverage");
    const pickedUp = await inSchool(school.id, () => startActiveScheduledClassesForTeacher({
      schoolId: school.id,
      teacherId: scheduledTeacher.id,
      now: new Date("2026-01-15T15:00:00.000Z"),
    }));
    assert.equal(pickedUp.length, 1);
    assert.equal(pickedUp[0].id, loginPickupReport?.id);
    assert.equal((pickedUp[0] as any).sessionMode, "live");
    const releasedLoginPickupCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(releasedLoginPickupCoverage, undefined);
    await inSchool(school.id, () => endTeachingSession(pickedUp[0].id));
    await inSchool(school.id, () => updateGroup(loginPickupGroup.id, {
      scheduleEnabled: false,
    } as any));

    const startAnywayGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: scheduledTeacher.id,
      name: `${TAG}_Scheduled_Start_Anyway`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "00:00",
      blockEndTime: "23:59",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(startAnywayGroup.id, [scheduledOnlyStudent.id, overlapStudent.id]));
    const startAnywayNow = new Date();
    const startAnywayDate = localDateInTimeZone(startAnywayNow, "America/New_York");
    // This subcase exercises an already-active conflict. Seed its canonical
    // occurrence around the real clock so weekend CI does not re-test the
    // separate instructional-calendar creation gate.
    await inSchool(school.id, () => createOrReuseScheduledReportSession({
      schoolId: school.id,
      groupId: startAnywayGroup.id,
      teacherId: scheduledTeacher.id,
      scheduledDate: startAnywayDate,
      scheduledTimezone: "America/New_York",
      scheduledStartAt: new Date(startAnywayNow.getTime() - 60_000),
      scheduledEndAt: new Date(startAnywayNow.getTime() + 60 * 60_000),
      scheduledTeacherEmail: scheduledTeacher.email,
      scheduledTeacherName: `${scheduledTeacher.firstName} ${scheduledTeacher.lastName}`,
    }));
    const coverageStart = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: startAnywayGroup,
      scheduledDate: startAnywayDate,
      scheduledTeacherConnectedOverride: false,
      now: startAnywayNow,
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
    const endedStarted = await requestJson(
      "POST",
      `/classpilot/teaching-sessions/${started.body.session.id}/end`,
      {},
      authFor(scheduledTeacher, school.id)
    );
    assert.equal(endedStarted.status, 200);
    assert.equal(endedStarted.body.finalizationReason, "teacher_end");
    await inSchool(school.id, () => updateGroup(startAnywayGroup.id, {
      scheduleEnabled: false,
    } as any));

    const expiringGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: scheduledTeacher.id,
      name: `${TAG}_Scheduled_Expires`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "11:00",
      blockEndTime: "11:45",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(expiringGroup.id, [scheduledOnlyStudent.id]));
    const expiringStart = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: expiringGroup,
      scheduledDate: "2026-01-15",
      scheduledTeacherConnectedOverride: false,
      now: new Date("2026-01-15T16:15:00.000Z"),
    }));
    assert.equal(expiringStart.status, "coverage_needed");
    const expiringConflictId = expiringStart.status === "coverage_needed" ? expiringStart.conflictId : "";
    assert.ok(expiringConflictId);
    const expiringReportSession = await inSchool(school.id, () =>
      getActiveScheduledReportSessionForConflict(school.id, expiringConflictId)
    );
    assert.ok(expiringReportSession);
    const expiringReadyToEnd = await inSchool(school.id, () => getScheduledGroupsReadyToEnd(school.id, "11:46"));
    assert.equal(expiringReadyToEnd.some((group: any) => group.sessionMode === "scheduled_report" && group.sessionId), true);
    const expiringClaim = await requestJson("POST", "/coverage/claim", {
      scheduledConflictId: expiringConflictId,
      studentIds: [scheduledOnlyStudent.id],
    }, authFor(scheduledCoverageStaff, school.id));
    assert.equal(expiringClaim.status, 201);
    const expiringCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(expiringCoverage?.context.contextType, "scheduled_coverage");

    await inSchool(school.id, () => updateEnrollmentSettings(school.id, {
      centralEmailRecipientUserId: scheduledCoverageStaff.id,
    } as any));
    const expired = await inSchool(school.id, () => expireScheduledClassConflictsForSchool({
      schoolId: school.id,
      scheduledDate: "2026-01-15",
      currentTimeHHMM: "11:46",
    }));
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, expiringConflictId);
    assert.equal(expired[0].status, "expired");
    const finalizedReport = await inSchool(school.id, () =>
      db.execute(sql`
        SELECT end_time::text AS end_time_text, scheduled_state, scheduled_finalization_reason
        FROM teaching_sessions
        WHERE id = ${expiringReportSession!.id}
      `)
    );
    assert.equal(finalizedReport.rows[0]?.scheduled_state, "finalized");
    assert.equal(finalizedReport.rows[0]?.scheduled_finalization_reason, "scheduled_end");
    assert.equal(
      new Date(`${String(finalizedReport.rows[0]!.end_time_text).replace(" ", "T")}Z`).toISOString(),
      "2026-01-15T16:45:00.000Z"
    );
    const queuedDeliveries = await inSchool(school.id, () =>
      db.execute(sql`
        SELECT recipient_kind, lower(btrim(recipient_email)) AS recipient_email, state
        FROM classpilot_session_summary_deliveries
        WHERE teaching_session_id = ${expiringReportSession!.id}
        ORDER BY recipient_kind
      `)
    );
    assert.deepEqual(
      queuedDeliveries.rows.map((row: any) => [row.recipient_kind, row.recipient_email]),
      [
        ["central", scheduledCoverageStaff.email.toLowerCase()],
        ["teacher", scheduledTeacher.email.toLowerCase()],
      ]
    );
    assert.ok(queuedDeliveries.rows.every((row: any) => row.state === "waiting_report"));
    const expiredCoverage = await inSchool(school.id, () => getActiveSupervisionForStudent(school.id, scheduledOnlyStudent.id));
    assert.equal(expiredCoverage, undefined);
    const expiredReportSession = await inSchool(school.id, () => getActiveScheduledReportSessionForConflict(school.id, expiringConflictId));
    assert.equal(expiredReportSession, undefined);

    const expiredAdminList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(admin, school.id));
    assert.equal(expiredAdminList.status, 200);
    assert.equal(expiredAdminList.body.conflicts.some((entry: any) => entry.id === expiringConflictId), false);
    const expiredStaffQueue = await requestJson("GET", "/coverage/available-students", undefined, authFor(scheduledCoverageStaff, school.id));
    assert.equal(expiredStaffQueue.status, 200);
    assert.equal(expiredStaffQueue.body.scheduledCoverageGroups.some((entry: any) => entry.id === expiringConflictId), false);
    const expiredStart = await requestJson(
      "POST",
      `/classpilot/scheduled-conflicts/${expiringConflictId}/start-anyway`,
      {},
      authFor(scheduledTeacher, school.id)
    );
    assert.equal(expiredStart.status, 409);
    assert.equal(expiredStart.body.code, "SCHEDULED_CONFLICT_EXPIRED");
    const postExpiredScheduledActive = await inSchool(school.id, () => getActiveTeachingSessionForSchool(scheduledTeacher.id, school.id));
    assert.equal(postExpiredScheduledActive, undefined);

    await inSchool(school.id, () => endTeachingSession(sourceSession.id));
  });

  it("lets a connected co-teacher start a scheduled class at the bell, at login, and from scheduled coverage", async () => {
    const primaryTeacher = await createUser({
      email: `coteacher-primary@${TAG}.example.edu`,
      firstName: "Pat",
      lastName: "Primary",
    });
    const coTeacher = await createUser({
      email: `coteacher-co@${TAG}.example.edu`,
      firstName: "Cody",
      lastName: "CoTeach",
    });
    const outsider = await createUser({
      email: `coteacher-outsider@${TAG}.example.edu`,
      firstName: "Olive",
      lastName: "Outsider",
    });
    for (const user of [primaryTeacher, coTeacher, outsider]) {
      await createMembership({ userId: user.id, schoolId: school.id, role: "teacher", status: "active" });
    }
    const coTaughtStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Cotaught",
      lastName: "Student",
      email: `coteacher-student@${TAG}.example.edu`,
      emailLc: `coteacher-student@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    }));
    const coTaughtDevice = `${TAG}-coteacher-device`;
    await inSchool(school.id, async () => {
      await createDevice({ deviceId: coTaughtDevice, schoolId: school.id, classId: "default", deviceName: "Co-taught" });
      await linkStudentDevice({ studentId: coTaughtStudent.id, deviceId: coTaughtDevice });
      await setActiveStudentForDevice(coTaughtDevice, coTaughtStudent.id);
    });

    // Bell start: the scheduled teacher is offline and only the co-teacher is
    // connected. The class starts for the scheduled teacher, the co-teacher is
    // recorded as the resolver, and the co-teacher is authorized session staff.
    const bellGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: primaryTeacher.id,
      name: `${TAG}_CoTeacher_Bell`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "08:00",
      blockEndTime: "08:45",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(bellGroup.id, [coTaughtStudent.id]));
    await inSchool(school.id, () => addGroupTeacher(bellGroup.id, coTeacher.id, "co-teacher"));
    const outsiderOnly = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: bellGroup,
      scheduledDate: "2026-01-16",
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set([outsider.id]),
      now: new Date("2026-01-16T13:15:00.000Z"),
    }));
    assert.equal(outsiderOnly.status, "coverage_needed");
    const bellConflictId = outsiderOnly.status === "coverage_needed" ? outsiderOnly.conflictId : "";
    assert.ok(bellConflictId);
    assert.equal(await inSchool(school.id, () => getActiveTeachingSessionForSchool(primaryTeacher.id, school.id)), undefined);
    const bellStart = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: bellGroup,
      scheduledDate: "2026-01-16",
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set([coTeacher.id]),
      now: new Date("2026-01-16T13:16:00.000Z"),
    }));
    assert.equal(bellStart.status, "started");
    const bellSession = bellStart.status === "started" ? bellStart.session : undefined;
    assert.ok(bellSession);
    assert.equal(bellSession.teacherId, primaryTeacher.id);
    assert.equal(bellSession.groupId, bellGroup.id);
    assert.equal(bellSession.sessionMode, "live");
    assert.equal(
      await inSchool(school.id, () => isAuthorizedClasspilotSessionStaff(school.id, bellSession.id, coTeacher.id)),
      true
    );
    assert.equal(
      await inSchool(school.id, () => isAuthorizedClasspilotSessionStaff(school.id, bellSession.id, outsider.id)),
      false
    );
    const bellConflict = await inSchool(school.id, () => getScheduledClassConflictByIdAndSchool(bellConflictId, school.id));
    assert.equal(bellConflict?.status, "started");
    assert.equal(bellConflict?.teacherId, primaryTeacher.id);
    assert.equal(bellConflict?.resolvedBy, coTeacher.id);
    await inSchool(school.id, () => endTeachingSession(bellSession.id));
    await inSchool(school.id, () => updateGroup(bellGroup.id, {
      scheduleEnabled: false,
    }));

    // Login pickup: the conflict stays routed to the scheduled teacher, but a
    // co-teacher signing in picks it up; an unrelated teacher does not.
    const pickupGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: primaryTeacher.id,
      name: `${TAG}_CoTeacher_Pickup`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "00:00",
      blockEndTime: "23:59",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(pickupGroup.id, [coTaughtStudent.id]));
    await inSchool(school.id, () => addGroupTeacher(pickupGroup.id, coTeacher.id, "co-teacher"));
    const pickupNeeded = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: pickupGroup,
      scheduledDate: "2026-01-16",
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set<string>(),
      now: new Date("2026-01-16T15:00:00.000Z"),
    }));
    assert.equal(pickupNeeded.status, "coverage_needed");
    const pickupConflictId = pickupNeeded.status === "coverage_needed" ? pickupNeeded.conflictId : "";
    assert.ok(pickupConflictId);
    const outsiderPickup = await inSchool(school.id, () => startActiveScheduledClassesForTeacher({
      schoolId: school.id,
      teacherId: outsider.id,
      now: new Date("2026-01-16T15:00:00.000Z"),
    }));
    assert.equal(outsiderPickup.length, 0);
    const coTeacherPickup = await inSchool(school.id, () => startActiveScheduledClassesForTeacher({
      schoolId: school.id,
      teacherId: coTeacher.id,
      now: new Date("2026-01-16T15:00:00.000Z"),
    }));
    assert.equal(coTeacherPickup.length, 1);
    const [coTeacherPickupSession] = coTeacherPickup;
    assert.ok(coTeacherPickupSession);
    assert.equal(coTeacherPickupSession.teacherId, primaryTeacher.id);
    assert.equal(coTeacherPickupSession.groupId, pickupGroup.id);
    assert.equal(coTeacherPickupSession.sessionMode, "live");
    const pickupConflict = await inSchool(school.id, () => getScheduledClassConflictByIdAndSchool(pickupConflictId, school.id));
    assert.equal(pickupConflict?.status, "started");
    assert.equal(pickupConflict?.teacherId, primaryTeacher.id);
    assert.equal(pickupConflict?.resolvedBy, coTeacher.id);
    await inSchool(school.id, () => endTeachingSession(coTeacherPickupSession.id));
    await inSchool(school.id, () => updateGroup(pickupGroup.id, {
      scheduleEnabled: false,
    }));

    // Scheduled coverage: a co-teacher sees the conflict as actionable and can
    // start the class from it; an unrelated teacher cannot.
    const coTaughtStartAnywayGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: primaryTeacher.id,
      name: `${TAG}_CoTeacher_Start_Anyway`,
      groupType: "admin_class",
      status: "active",
      scheduleEnabled: true,
      blockStartTime: "00:00",
      blockEndTime: "23:59",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(coTaughtStartAnywayGroup.id, [coTaughtStudent.id]));
    await inSchool(school.id, () => addGroupTeacher(coTaughtStartAnywayGroup.id, coTeacher.id, "co-teacher"));
    const coTaughtNow = new Date();
    const coTaughtDate = localDateInTimeZone(coTaughtNow, "America/New_York");
    // Seed the occurrence around the real clock so weekend CI does not re-test
    // the separate instructional-calendar creation gate.
    await inSchool(school.id, () => createOrReuseScheduledReportSession({
      schoolId: school.id,
      groupId: coTaughtStartAnywayGroup.id,
      teacherId: primaryTeacher.id,
      scheduledDate: coTaughtDate,
      scheduledTimezone: "America/New_York",
      scheduledStartAt: new Date(coTaughtNow.getTime() - 60_000),
      scheduledEndAt: new Date(coTaughtNow.getTime() + 60 * 60_000),
      scheduledTeacherEmail: primaryTeacher.email,
      scheduledTeacherName: `${primaryTeacher.firstName} ${primaryTeacher.lastName}`,
    }));
    const coTaughtCoverage = await inSchool(school.id, () => processScheduledClassAutoStart({
      group: coTaughtStartAnywayGroup,
      scheduledDate: coTaughtDate,
      scheduledTeacherConnectedOverride: false,
      connectedTeacherIdsOverride: new Set<string>(),
      now: coTaughtNow,
    }));
    assert.equal(coTaughtCoverage.status, "coverage_needed");
    const coTaughtConflictId = coTaughtCoverage.status === "coverage_needed" ? coTaughtCoverage.conflictId : "";
    assert.ok(coTaughtConflictId);

    const outsiderStart = await requestJson(
      "POST",
      `/classpilot/scheduled-conflicts/${coTaughtConflictId}/start-anyway`,
      {},
      authFor(outsider, school.id)
    );
    assert.equal(outsiderStart.status, 403);
    assert.equal(outsiderStart.body.error, "Only an admin or an assigned teacher can start this class");

    const coTeacherList = await requestJson("GET", "/classpilot/scheduled-conflicts", undefined, authFor(coTeacher, school.id));
    assert.equal(coTeacherList.status, 200);
    const coTeacherConflict = coTeacherList.body.conflicts.find((entry: any) => entry.id === coTaughtConflictId);
    assert.ok(coTeacherConflict);
    assert.equal(coTeacherConflict.audience, "scheduled_coteacher");
    assert.equal(coTeacherConflict.canStartAnyway, true);
    assert.equal(coTeacherConflict.teacherId, primaryTeacher.id);
    assert.match(coTeacherConflict.message, /You are a co-teacher for this class and can start it now/);
    const coTeacherStartQueue = await requestJson("GET", "/coverage/available-students", undefined, authFor(coTeacher, school.id));
    assert.equal(coTeacherStartQueue.status, 200);
    const coTeacherQueueGroup = coTeacherStartQueue.body.scheduledCoverageGroups.find((entry: any) => entry.id === coTaughtConflictId);
    assert.ok(coTeacherQueueGroup);
    assert.equal(coTeacherQueueGroup.canStartClass, true);

    const coTeacherStarted = await requestJson(
      "POST",
      `/classpilot/scheduled-conflicts/${coTaughtConflictId}/start-anyway`,
      {},
      authFor(coTeacher, school.id)
    );
    assert.equal(coTeacherStarted.status, 201);
    assert.equal(coTeacherStarted.body.session.teacherId, primaryTeacher.id);
    assert.equal(coTeacherStarted.body.session.groupId, coTaughtStartAnywayGroup.id);
    const coTaughtStartedConflict = await inSchool(school.id, () => getScheduledClassConflictByIdAndSchool(coTaughtConflictId, school.id));
    assert.equal(coTaughtStartedConflict?.status, "started");
    assert.equal(coTaughtStartedConflict?.teacherId, primaryTeacher.id);
    assert.equal(coTaughtStartedConflict?.resolvedBy, coTeacher.id);
    assert.equal(
      await inSchool(school.id, () => isAuthorizedClasspilotSessionStaff(school.id, coTeacherStarted.body.session.id, coTeacher.id)),
      true
    );
    await inSchool(school.id, () => endTeachingSession(coTeacherStarted.body.session.id));
    await inSchool(school.id, () => updateGroup(coTaughtStartAnywayGroup.id, {
      scheduleEnabled: false,
    }));
  });

  it("keeps complete unscoped and Observe rosters when one local realtime snapshot is circular", async () => {
    const validStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Valid",
      lastName: "Realtime",
      email: `valid-realtime@${TAG}.example.edu`,
      emailLc: `valid-realtime@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    }));
    const rejectedStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Rejected",
      lastName: "Realtime",
      email: `rejected-realtime@${TAG}.example.edu`,
      emailLc: `rejected-realtime@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    }));
    const neverObservedStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Never",
      lastName: "Observed",
      email: `never-observed@${TAG}.example.edu`,
      emailLc: `never-observed@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    }));
    const validDeviceId = `${TAG}-device-route-valid`;
    const rejectedDeviceId = `${TAG}-device-route-rejected`;

    const { validSession, rejectedSession } = await inSchool(school.id, async () => {
      await createDevice({
        deviceId: validDeviceId,
        schoolId: school.id,
        classId: "default",
        deviceName: "Route valid",
      });
      await createDevice({
        deviceId: rejectedDeviceId,
        schoolId: school.id,
        classId: "default",
        deviceName: "Route rejected",
      });
      await linkStudentDevice({ studentId: validStudent.id, deviceId: validDeviceId });
      await linkStudentDevice({ studentId: rejectedStudent.id, deviceId: rejectedDeviceId });
      const validSession = await setActiveStudentForDevice(validDeviceId, validStudent.id);
      const rejectedSession = await setActiveStudentForDevice(rejectedDeviceId, rejectedStudent.id);
      return { validSession, rejectedSession };
    });

    const routeGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Route_Regression`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(routeGroup.id, [
      validStudent.id,
      rejectedStudent.id,
      neverObservedStudent.id,
    ]));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: routeGroup.id,
      teacherId: teacher.id,
    }));

    const observedAt = Date.now();
    const validWrite = await writeClasspilotRealtimeStatus({
      schoolId: school.id,
      studentId: validStudent.id,
      studentSessionId: validSession.id,
      deviceId: validDeviceId,
      heartbeatId: `${TAG}-route-valid-heartbeat`,
      observedAt,
      activeTabUrl: "https://example.edu/valid",
      activeTabTitle: "Valid realtime",
      screenLocked: true,
      flightPathActive: true,
      activeFlightPathName: "Route regression",
      isSharing: true,
      cameraActive: true,
      extensionCapabilities: ["exactTabCloseV1"],
    });
    const rejectedWrite = await writeClasspilotRealtimeStatus({
      schoolId: school.id,
      studentId: rejectedStudent.id,
      studentSessionId: rejectedSession.id,
      deviceId: rejectedDeviceId,
      heartbeatId: `${TAG}-route-rejected-heartbeat`,
      observedAt,
      activeTabUrl: "https://example.edu/rejected",
      activeTabTitle: "Rejected realtime",
      screenLocked: true,
      flightPathActive: true,
      activeFlightPathName: "Must not escape",
      isSharing: true,
      cameraActive: true,
      extensionCapabilities: ["exactTabCloseV1"],
    });
    assert.ok(validWrite.snapshot);
    assert.ok(rejectedWrite.snapshot);
    Object.assign(rejectedWrite.snapshot, { circular: rejectedWrite.snapshot });
    await Promise.all([
      classpilotRealtimeStatusKey(school.id, validDeviceId),
      classpilotRealtimeStatusKey(school.id, rejectedDeviceId),
    ].map((key) => redisCommand(["DEL", key]).catch(() => undefined)));

    const unscoped = await requestJson(
      "GET",
      "/students-aggregated",
      undefined,
      authFor(admin, school.id)
    );
    assert.equal(unscoped.status, 200);
    assert.ok(Array.isArray(unscoped.body));
    assert.ok(unscoped.body.some((row: any) => row.studentId === validStudent.id));
    assert.ok(unscoped.body.some((row: any) => row.studentId === rejectedStudent.id));
    const unscopedNeverObservedRow = unscoped.body.find(
      (row: any) => row.studentId === neverObservedStudent.id
    );
    assert.ok(unscopedNeverObservedRow);
    assert.equal(Object.hasOwn(unscopedNeverObservedRow, "lastSeenAt"), true);
    assert.equal(unscopedNeverObservedRow.lastSeenAt, null);
    const unscopedRejectedRow = unscoped.body.find(
      (row: any) => row.studentId === rejectedStudent.id
    );
    assert.equal(unscopedRejectedRow.activeTabTitle, "");
    assert.equal(unscopedRejectedRow.activeTabUrl, "");
    assert.equal(unscopedRejectedRow.screenLocked, false);
    assert.equal(unscopedRejectedRow.flightPathActive, false);
    assert.equal(unscopedRejectedRow.activeFlightPathName, undefined);
    assert.equal(unscopedRejectedRow.isSharing, false);
    assert.equal(unscopedRejectedRow.cameraActive, false);
    assert.equal(unscopedRejectedRow.capabilities.exactTabCloseV1, false);

    const observeRejectedWrite = await writeClasspilotRealtimeStatus({
      schoolId: school.id,
      studentId: rejectedStudent.id,
      studentSessionId: rejectedSession.id,
      deviceId: rejectedDeviceId,
      heartbeatId: `${TAG}-route-observe-rejected-heartbeat`,
      observedAt: Date.now(),
      activeTabUrl: "https://example.edu/rejected-observe",
      activeTabTitle: "Rejected Observe realtime",
      screenLocked: true,
      flightPathActive: true,
      activeFlightPathName: "Must not escape Observe",
      isSharing: true,
      cameraActive: true,
      extensionCapabilities: ["exactTabCloseV1"],
    });
    assert.ok(observeRejectedWrite.snapshot);
    Object.assign(observeRejectedWrite.snapshot, { circular: observeRejectedWrite.snapshot });
    await redisCommand([
      "DEL",
      classpilotRealtimeStatusKey(school.id, rejectedDeviceId),
    ]).catch(() => undefined);

    const observed = await requestJson(
      "GET",
      `/students-aggregated?teachingSessionId=${encodeURIComponent(teachingSession.id)}`,
      undefined,
      authFor(admin, school.id)
    );
    assert.equal(observed.status, 200);
    assert.deepEqual(
      new Set(observed.body.map((row: any) => row.studentId)),
      new Set([validStudent.id, rejectedStudent.id, neverObservedStudent.id])
    );

    const validRow = observed.body.find((row: any) => row.studentId === validStudent.id);
    const rejectedRow = observed.body.find((row: any) => row.studentId === rejectedStudent.id);
    const neverObservedRow = observed.body.find(
      (row: any) => row.studentId === neverObservedStudent.id
    );
    assert.equal(validRow.lastSeenAt, observedAt);
    assert.equal(validRow.activeTabTitle, "Valid realtime");
    assert.equal(validRow.screenLocked, true);
    assert.equal(validRow.flightPathActive, true);
    assert.equal(validRow.activeFlightPathName, "Route regression");
    assert.equal(validRow.isSharing, true);
    assert.equal(validRow.cameraActive, true);
    assert.equal(validRow.capabilities.exactTabCloseV1, true);

    assert.ok(neverObservedRow);
    assert.equal(Object.hasOwn(neverObservedRow, "lastSeenAt"), true);
    assert.equal(neverObservedRow.lastSeenAt, null);
    assert.equal(neverObservedRow.realtimeObservedAt, null);
    assert.equal(neverObservedRow.loginState, "not_logged_in");
    assert.equal(neverObservedRow.isLoggedIn, false);

    assert.equal(rejectedRow.activeTabTitle, "");
    assert.equal(rejectedRow.activeTabUrl, "");
    assert.equal(rejectedRow.screenLocked, false);
    assert.equal(rejectedRow.flightPathActive, false);
    assert.equal(rejectedRow.activeFlightPathName, undefined);
    assert.equal(rejectedRow.isSharing, false);
    assert.equal(rejectedRow.cameraActive, false);
    assert.equal(rejectedRow.capabilities.exactTabCloseV1, false);

    expectNoInternalRealtimeBindings(unscoped.body, [
      validDeviceId,
      rejectedDeviceId,
      validSession.id,
      rejectedSession.id,
    ]);
    expectNoInternalRealtimeBindings(observed.body, [
      validDeviceId,
      rejectedDeviceId,
      validSession.id,
      rejectedSession.id,
    ]);

    await inSchool(school.id, () => endTeachingSession(teachingSession.id));
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
    const replacementState = await inSchool(school.id, () =>
      getClasspilotStudentControlState(school.id, studentDeviceGuard.id)
    );
    assert.equal(replacementState?.teachingSessionId, newSession.id);
    assert.equal(replacementState?.supervisionContextId, null);
    await inSchool(school.id, async () => {
      await db.execute(sql`UPDATE teaching_sessions SET start_time = ${new Date(Date.now() - 60_000)} WHERE id = ${oldSession.id}`);
      await db.execute(sql`UPDATE teaching_sessions SET start_time = ${new Date()} WHERE id = ${newSession.id}`);
    });
    try {
      await withSharedRealtime(async () => {
        await writeClasspilotRealtimeStatus({
          schoolId: school.id,
          studentId: studentDeviceGuard.id,
          studentSessionId: sessionGuard.id,
          deviceId: deviceGuard,
          heartbeatId: `${TAG}-newest-class-owner-heartbeat`,
          observedAt: Date.now(),
          activeTabUrl: "https://example.edu/newest-owner",
          activeTabTitle: "Newest class owner",
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
        assert.match(oldCommand.body.command.targets[0].errorMessage, /active in|authority changed before dispatch/);

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
      });
    } finally {
      await inSchool(school.id, () => endTeachingSession(oldSession.id));
      await inSchool(school.id, () => endTeachingSession(newSession.id));
    }
  });

  it("batch-resolves multiple command targets without changing class-row order", async () => {
    const activeStudentA = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Batch",
      lastName: "Active A",
      email: `batch-active-a@${TAG}.example.edu`,
      emailLc: `batch-active-a@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));
    const activeStudentB = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Batch",
      lastName: "Active B",
      email: `batch-active-b@${TAG}.example.edu`,
      emailLc: `batch-active-b@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));
    const staleStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Batch",
      lastName: "Stale",
      email: `batch-stale@${TAG}.example.edu`,
      emailLc: `batch-stale@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));
    const activeDeviceA = `${TAG}-batch-device-a`;
    const activeDeviceB = `${TAG}-batch-device-b`;
    const staleDevice = `${TAG}-batch-device-stale`;
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Batch_Command_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));

    const activeSessions = await inSchool(school.id, async () => {
      await createDevice({ deviceId: activeDeviceA, schoolId: school.id, classId: "default", deviceName: "Batch A" } as any);
      await createDevice({ deviceId: activeDeviceB, schoolId: school.id, classId: "default", deviceName: "Batch B" } as any);
      await createDevice({ deviceId: staleDevice, schoolId: school.id, classId: "default", deviceName: "Batch Stale" } as any);
      await linkStudentDevice({ studentId: activeStudentA.id, deviceId: activeDeviceA });
      await linkStudentDevice({ studentId: activeStudentB.id, deviceId: activeDeviceB });
      await linkStudentDevice({ studentId: staleStudent.id, deviceId: staleDevice });
      const activeSessionA = await setActiveStudentForDevice(activeDeviceA, activeStudentA.id);
      const activeSessionB = await setActiveStudentForDevice(activeDeviceB, activeStudentB.id);
      const staleSession = await setActiveStudentForDevice(staleDevice, staleStudent.id);
      await db.execute(sql`
        UPDATE student_sessions
        SET last_seen_at = ${new Date(Date.now() - 10 * 60 * 1000)}
        WHERE id = ${staleSession.id}
      `);
      await addGroupStudentsDetailed(group.id, [activeStudentA.id, staleStudent.id, activeStudentB.id]);
      return { activeSessionA, activeSessionB };
    });
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    try {
      await withSharedRealtime(async () => {
        const observedAt = Date.now();
        await writeClasspilotRealtimeStatus({
          schoolId: school.id,
          studentId: activeStudentA.id,
          studentSessionId: activeSessions.activeSessionA.id,
          deviceId: activeDeviceA,
          heartbeatId: `${TAG}-batch-active-a-heartbeat`,
          observedAt,
          activeTabUrl: "https://example.edu/batch-a",
          activeTabTitle: "Batch active A",
        });
        await writeClasspilotRealtimeStatus({
          schoolId: school.id,
          studentId: activeStudentB.id,
          studentSessionId: activeSessions.activeSessionB.id,
          deviceId: activeDeviceB,
          heartbeatId: `${TAG}-batch-active-b-heartbeat`,
          observedAt,
          activeTabUrl: "https://example.edu/batch-b",
          activeTabTitle: "Batch active B",
        });

        const requestedStudentIds = [staleStudent.id, activeStudentB.id, activeStudentA.id];
        const requestedSet = new Set(requestedStudentIds);
        const classRows = await inSchool(school.id, () =>
          getClasspilotSessionStudentRoster(school.id, teachingSession.id)
        );
        const expectedTargetOrder = classRows
          .filter((row) => requestedSet.has(row.studentId))
          .map((row) => row.studentId);

        const command = await requestJson("POST", "/commands", {
          teachingSessionId: teachingSession.id,
          targetScope: "students",
          targetStudentIds: requestedStudentIds,
          commandType: "open-tab",
          commandPayload: { url: "https://example.com/batch-targets" },
        }, authFor(teacher, school.id));

        assert.equal(command.status, 201);
        assert.equal(command.body.summary.requested, 3);
        assert.equal(command.body.summary.sent, 2);
        assert.equal(command.body.summary.unavailable, 1);
        assert.deepEqual(
          command.body.command.targets.map((target: any) => target.studentId),
          expectedTargetOrder
        );
        type CommandTargetView = {
          studentId: string;
          status?: string;
          errorMessage?: string;
        };
        const targetsByStudent = new Map<string, CommandTargetView>(
          command.body.command.targets.map(
            (target: CommandTargetView): [string, CommandTargetView] => [target.studentId, target]
          )
        );
        assert.equal(targetsByStudent.get(activeStudentA.id)?.status, "sent");
        assert.equal(targetsByStudent.get(activeStudentB.id)?.status, "sent");
        assert.equal(targetsByStudent.get(staleStudent.id)?.status, "unavailable");
        assert.match(
          targetsByStudent.get(staleStudent.id)?.errorMessage ?? "",
          /signal is unavailable/
        );
      });
    } finally {
      await inSchool(school.id, () => endTeachingSession(teachingSession.id));
    }
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
    assert.equal(forbidden.status, 404);

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

  it("serializes an active roster resync against session finalization", async () => {
    const raceTeacher = await createUser({
      email: `resync-race-teacher@${TAG}.example.edu`,
      firstName: "Race",
      lastName: "Teacher",
    } as any);
    await createMembership({
      userId: raceTeacher.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    } as any);
    const original = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Race",
      lastName: "Original",
      email: `resync-race-original@${TAG}.example.edu`,
      emailLc: `resync-race-original@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));
    const late = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Race",
      lastName: "Late",
      email: `resync-race-late@${TAG}.example.edu`,
      emailLc: `resync-race-late@${TAG}.example.edu`,
      gradeLevel: "7",
      status: "active",
    } as any));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: raceTeacher.id,
      name: `${TAG}_Resync_Finalize_Race`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [original.id]));
    const session = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: raceTeacher.id,
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [late.id]));

    const [resyncResult, ended] = await Promise.all([
      inSchool(school.id, () => resyncActiveClasspilotSessionStudents({
        schoolId: school.id,
        teachingSessionId: session.id,
      })),
      inSchool(school.id, () => endTeachingSession(session.id)),
    ]);
    assert.ok(ended?.endTime);

    const frozenRoster = await inSchool(school.id, () => getClasspilotSessionStudents(session.id));
    assert.equal(
      frozenRoster.some((row) => row.studentId === late.id),
      Boolean(resyncResult),
      "the late student is frozen only when resync wins the lifecycle lock"
    );
    for (const studentId of [original.id, late.id]) {
      const state = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, studentId)
      );
      assert.notEqual(state?.teachingSessionId, session.id);
    }
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
    assert.equal(selectedCommand.body.summary.completed, 1);
    assert.equal(selectedCommand.body.summary.acknowledged, 0);
    assert.equal(selectedCommand.body.summary.unavailable, 0);
    assert.equal(selectedCommand.body.deliveryPolicy, "server_authoritative");
    assert.equal(selectedCommand.body.expiresAt, null);
    assert.equal(selectedCommand.body.command.targets[0].studentId, signOutStudent.id);
    assert.equal(selectedCommand.body.command.targets[0].result.serverAuthoritative, true);
    expectNoDeviceIds(selectedCommand.body);
    assert.match(selectedCommand.body.message, /Student session ended for 1 student/);

    const activeAfterSignOut = await inSchool(school.id, () => getActiveSessionByStudent(signOutStudent.id));
    assert.equal(activeAfterSignOut, undefined);

    await inSchool(school.id, () => endTeachingSession(session.id));
  });

  it("ends a stale active student session through server-authoritative sign-out", async () => {
    const staleStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Stale",
      lastName: "Signout",
      email: `stale-sign-out@${TAG}.example.edu`,
      emailLc: `stale-sign-out@${TAG}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as any));
    const staleDevice = `${TAG}-device-stale-sign-out`;
    const staleGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Stale_Sign_Out_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));

    const staleStudentSession = await inSchool(school.id, async () => {
      await createDevice({
        deviceId: staleDevice,
        schoolId: school.id,
        classId: "default",
        deviceName: "Stale Sign Out",
      } as any);
      await linkStudentDevice({ studentId: staleStudent.id, deviceId: staleDevice });
      const active = await setActiveStudentForDevice(staleDevice, staleStudent.id);
      await addGroupStudentsDetailed(staleGroup.id, [staleStudent.id]);
      await db.execute(sql`
        UPDATE student_sessions
        SET last_seen_at = ${new Date(Date.now() - 10 * 60 * 1000)}
        WHERE id = ${active.id}
      `);
      return active;
    });
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: staleGroup.id,
      teacherId: teacher.id,
    }));

    const response = await requestJson("POST", "/commands", {
      teachingSessionId: teachingSession.id,
      targetScope: "students",
      targetStudentIds: [staleStudent.id],
      commandType: "student-sign-out",
      commandPayload: {},
    }, authFor(teacher, school.id));

    assert.equal(response.status, 201);
    assert.equal(response.body.deliveryPolicy, "server_authoritative");
    assert.equal(response.body.summary.requested, 1);
    assert.equal(response.body.summary.attempted, 1);
    assert.equal(response.body.summary.completed, 1);
    assert.equal(response.body.summary.acknowledged, 0);
    assert.equal(response.body.summary.unavailable, 0);
    assert.equal(response.body.command.targets[0].result.serverAuthoritative, true);
    expectNoDeviceIds(response.body);
    assert.equal(
      await inSchool(school.id, () => getActiveSessionByStudent(staleStudent.id)),
      undefined
    );
    const endedRow = await inSchool(school.id, async () => {
      const result = await db.execute(sql`
        SELECT ended_at
        FROM student_sessions
        WHERE id = ${staleStudentSession.id}
      `);
      return result.rows[0] as { ended_at: Date | null } | undefined;
    });
    assert.ok(endedRow?.ended_at);

    await inSchool(school.id, () => endTeachingSession(teachingSession.id));
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
    assert.equal(update.body.centralEmailRecipientUserId, coverageStaff.id);
    assert.equal(Object.hasOwn(update.body, "wsSharedKey"), false);
    assert.equal(Object.hasOwn(update.body, "enrollmentKey"), false);

    const saved = await inSchool(school.id, () => getSettingsForSchool(school.id));
    assert.equal(saved?.centralEmailRecipientUserId, coverageStaff.id);

    const adminRead = await requestJson("GET", "/settings", undefined, adminAuth);
    assert.equal(adminRead.status, 200);
    assert.equal(adminRead.body.centralEmailRecipientUserId, coverageStaff.id);
    assert.equal(Object.hasOwn(adminRead.body, "wsSharedKey"), false);
    assert.equal(Object.hasOwn(adminRead.body, "enrollmentKey"), false);

    const teacherRead = await requestJson("GET", "/settings", undefined, teacherAuth);
    assert.equal(teacherRead.status, 200);
    assert.equal(teacherRead.body.centralEmailRecipientUserId, null);

    const blank = await requestJson("POST", "/settings", {
      centralEmailRecipientUserId: "   ",
    }, adminAuth);
    assert.equal(blank.status, 400);
    assert.match(blank.body.error, /cannot be blank/);
    const unchangedAfterBlank = await inSchool(school.id, () => getSettingsForSchool(school.id));
    assert.equal(unchangedAfterBlank?.centralEmailRecipientUserId, coverageStaff.id);

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
    assert.equal(clear.body.centralEmailRecipientUserId, null);

    const cleared = await inSchool(school.id, () => getSettingsForSchool(school.id));
    assert.equal(cleared?.centralEmailRecipientUserId, null);

    const clearedRead = await requestJson("GET", "/settings", undefined, adminAuth);
    assert.equal(clearedRead.status, 200);
    assert.equal(clearedRead.body.centralEmailRecipientUserId, null);
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

    snapshotClasspilotCoverageHydrationMetrics({ reset: true });
    const staffQueue = await requestJson("GET", "/coverage/available-students", undefined, staffAuth);
    assert.equal(staffQueue.status, 200);
    const staffQueueIds = new Set(staffQueue.body.students.map((student: any) => student.studentId));
    assert.ok(staffQueueIds.has(studentUnassigned.id));
    assert.ok(staffQueue.body.students.every((student: any) =>
      student.matchingGroups.some((group: any) => group.id === groupRes.body.group.id)
    ));
    expectNoDeviceIds(staffQueue.body);
    const hydrationMetrics = snapshotClasspilotCoverageHydrationMetrics();
    assert.ok(hydrationMetrics.sessionSqlStatements <= 1);
    assert.ok(hydrationMetrics.realtimeRedisCommands <= 2);

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

    await withSharedRealtime(async () => {
      await writeClasspilotRealtimeStatus({
        schoolId: school.id,
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        heartbeatId: `${TAG}-direct-scope-heartbeat`,
        observedAt: Date.now(),
        activeTabUrl: "https://example.edu/direct-scope",
        activeTabTitle: "Direct scope",
      });

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
    });

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

    const unpairedStaffReroute = await requestJson("POST", "/coverage/send", {
      supervisionGroupId: target.supervisionGroupId,
      assignedStaffId: floorCaptain.id,
      studentIds: [studentInClass.id],
      note: "should require supervision group pairing",
    }, teacherAuth);
    assert.equal(unpairedStaffReroute.status, 403);
    assert.match(unpairedStaffReroute.body.error, /paired with this Supervision Group/);

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

  it("serializes exact operator gates and explicit login state for Coverage students", async () => {
    const suffix = `${TAG}-coverage-route-projection`;
    const signedOutStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Signed",
      lastName: "Out",
      email: `signed-out@${suffix}.example.edu`,
      emailLc: `signed-out@${suffix}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const signalLostStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Signal",
      lastName: "Lost",
      email: `signal-lost@${suffix}.example.edu`,
      emailLc: `signal-lost@${suffix}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const signalLostDeviceId = `${suffix}-device`;
    let context: any;
    const previousProtocolV3 = process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
    const previousStudentGate = process.env.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1;
    const previousLateSignIn = process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
    const previousRollouts = process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;

    try {
      process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
      process.env.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 = "true";
      process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true";
      process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
        studentAuthGatePresenceV1: { mode: "on", schoolIds: [school.id] },
        lateSignInRestrictionSsoV1: { mode: "on", schoolIds: [school.id] },
      });

      const signalLostSession = await inSchool(school.id, async () => {
        await createDevice({
          deviceId: signalLostDeviceId,
          schoolId: school.id,
          classId: "default",
          deviceName: "Coverage signal lost",
        } as Parameters<typeof createDevice>[0]);
        await linkStudentDevice({
          studentId: signalLostStudent.id,
          deviceId: signalLostDeviceId,
        });
        return setActiveStudentForDevice(signalLostDeviceId, signalLostStudent.id);
      });
      context = await inSchool(school.id, () => createSupervisionContextWithStudents({
        context: {
          schoolId: school.id,
          contextType: "office",
          name: "Coverage projection test",
          status: "active",
          assignedStaffId: coverageStaff.id,
          createdBy: admin.id,
          endsAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        studentIds: [signedOutStudent.id, signalLostStudent.id],
        assignedBy: admin.id,
        source: "admin_reroute",
      }));

      await withSharedRealtime(async () => {
        await writeClasspilotRealtimeStatus({
          schoolId: school.id,
          studentId: signalLostStudent.id,
          studentSessionId: signalLostSession.id,
          deviceId: signalLostDeviceId,
          heartbeatId: `${suffix}-stale-heartbeat`,
          observedAt: Date.now() - 2 * 60 * 1000,
          trackingStatus: "ACTIVE",
        });

        const response = await requestJson(
          "GET",
          `/coverage/contexts/${context.id}/students`,
          undefined,
          authFor(coverageStaff, school.id)
        );
        assert.equal(response.status, 200);
        const signedOutRow = response.body.students.find(
          (student: any) => student.studentId === signedOutStudent.id
        );
        const signalLostRow = response.body.students.find(
          (student: any) => student.studentId === signalLostStudent.id
        );
        assert.ok(signedOutRow);
        assert.ok(signalLostRow);
        for (const row of [signedOutRow, signalLostRow]) {
          assert.deepEqual(row.operatorCapabilities, {
            studentAuthGatePresenceV1: true,
            lateSignInRestrictionSsoV1: true,
            restrictionAuthPassThroughV1: false,
          });
          assert.equal(row.studentAuthGatePresenceV1Enabled, true);
          assert.equal(row.lateSignInRestrictionSsoV1Enabled, true);
          assert.equal(row.restrictionAuthPassThroughV1Enabled, false);
        }
        assert.equal(signedOutRow.isLoggedIn, false);
        assert.equal(signedOutRow.loginState, "not_logged_in");
        assert.equal(signedOutRow.status, "offline");
        assert.equal(signalLostRow.isLoggedIn, true);
        assert.equal(signalLostRow.loginState, "logged_in");
        assert.equal(signalLostRow.status, "idle");
        expectNoInternalRealtimeBindings(response.body, [
          signalLostDeviceId,
          signalLostSession.id,
        ]);
      });
    } finally {
      if (previousProtocolV3 === undefined) delete process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
      else process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = previousProtocolV3;
      if (previousStudentGate === undefined) delete process.env.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1;
      else process.env.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 = previousStudentGate;
      if (previousLateSignIn === undefined) delete process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
      else process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = previousLateSignIn;
      if (previousRollouts === undefined) delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
      else process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = previousRollouts;

      await inSchool(school.id, async () => {
        if (context?.id) {
          await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE context_id = ${context.id}`);
          await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE id = ${context.id}`);
        }
        await db.execute(sql`DELETE FROM student_sessions WHERE student_id IN (${signedOutStudent.id}, ${signalLostStudent.id})`);
        await db.execute(sql`DELETE FROM student_devices WHERE student_id IN (${signedOutStudent.id}, ${signalLostStudent.id})`);
        await db.execute(sql`DELETE FROM devices WHERE device_id = ${signalLostDeviceId}`);
        await db.execute(sql`DELETE FROM students WHERE id IN (${signedOutStudent.id}, ${signalLostStudent.id})`);
      });
    }
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
      studentSessionId: activeSession!.id,
      ackState: "completed",
      result: { ok: true },
    }));
    await inSchool(school.id, () => updateClasspilotCommandSummary(created.id));
    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.status, "completed");
    assert.equal(loaded?.targets[0]?.status, "completed");

    await inSchool(school.id, () => releaseSupervisionStudents({
      schoolId: school.id,
      contextId: context.id,
      releaseReason: "test_release",
    }));
  });

  it("publishes claimed-student telemetry only to the exact active assigned staff binding", async () => {
    const context = await inSchool(school.id, () => createSupervisionContextWithStudents({
      context: {
        schoolId: school.id,
        contextType: "office",
        name: "Coverage Telemetry Authority",
        status: "active",
        assignedStaffId: coverageStaff.id,
        createdBy: admin.id,
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      studentIds: [studentUnassigned.id],
      assignedBy: admin.id,
      source: "admin_reroute",
    }));
    try {
      const [binding, control] = await inSchool(school.id, () => Promise.all([
        getActiveSessionByStudent(studentUnassigned.id),
        getClasspilotStudentControlState(school.id, studentUnassigned.id),
      ]));
      assert.ok(binding);
      assert.equal(control?.supervisionContextId, context.id);
      let recipient: string | undefined;
      const accepted = await inSchool(school.id, () =>
        withClasspilotSupervisionTelemetryAuthority({
          schoolId: school.id,
          supervisionContextId: context.id,
          studentId: studentUnassigned.id,
          studentSessionId: binding!.id,
          deviceId: binding!.deviceId,
          controlRevision: control!.revision,
        }, (target) => {
          recipient = target.assignedStaffId;
          return "published";
        })
      );
      assert.equal(accepted, "published");
      assert.equal(recipient, coverageStaff.id);
      const staleRevision = await inSchool(school.id, () =>
        withClasspilotSupervisionTelemetryAuthority({
          schoolId: school.id,
          supervisionContextId: context.id,
          studentId: studentUnassigned.id,
          studentSessionId: binding!.id,
          deviceId: binding!.deviceId,
          controlRevision: control!.revision - 1,
        }, () => "must-not-publish")
      );
      assert.equal(staleRevision, undefined);
      await inSchool(school.id, () => endStudentSession(binding!.id));
      const signedOut = await inSchool(school.id, () =>
        withClasspilotSupervisionTelemetryAuthority({
          schoolId: school.id,
          supervisionContextId: context.id,
          studentId: studentUnassigned.id,
          studentSessionId: binding!.id,
          deviceId: binding!.deviceId,
          controlRevision: control!.revision,
          allowEndedBinding: true,
        }, (target) => target.assignedStaffId)
      );
      assert.equal(signedOut, coverageStaff.id, "the exact just-ended binding can publish its tombstone");
      await inSchool(school.id, () => setActiveStudentForDevice(deviceUnassigned, studentUnassigned.id));
      const staleSignedOut = await inSchool(school.id, () =>
        withClasspilotSupervisionTelemetryAuthority({
          schoolId: school.id,
          supervisionContextId: context.id,
          studentId: studentUnassigned.id,
          studentSessionId: binding!.id,
          deviceId: binding!.deviceId,
          controlRevision: control!.revision,
          allowEndedBinding: true,
        }, () => "must-not-publish")
      );
      assert.equal(staleSignedOut, undefined, "a replacement binding suppresses an old offline tombstone");
      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: context.id,
        releaseReason: "test_release",
      }));
      const afterRelease = await inSchool(school.id, () =>
        withClasspilotSupervisionTelemetryAuthority({
          schoolId: school.id,
          supervisionContextId: context.id,
          studentId: studentUnassigned.id,
          studentSessionId: binding!.id,
          deviceId: binding!.deviceId,
          controlRevision: control!.revision,
        }, () => "must-not-publish")
      );
      assert.equal(afterRelease, undefined);
    } finally {
      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: context.id,
        releaseReason: "test_cleanup",
      }));
    }
  });

  it("revalidates coverage actor, frozen membership, and exact binding in the command transaction", async () => {
    const context = await inSchool(school.id, () => createSupervisionContextWithStudents({
      context: {
        schoolId: school.id,
        contextType: "office",
        name: "Coverage Command Authority Race",
        status: "active",
        assignedStaffId: coverageStaff.id,
        createdBy: admin.id,
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      studentIds: [studentUnassigned.id, studentCoverage.id],
      assignedBy: admin.id,
      source: "admin_reroute",
    }));
    try {
      const [unassignedBinding, coverageBinding] = await inSchool(school.id, () =>
        Promise.all([
          getActiveSessionByStudent(studentUnassigned.id),
          getActiveSessionByStudent(studentCoverage.id),
        ])
      );
      assert.ok(unassignedBinding && coverageBinding);

      await assert.rejects(
        () => inSchool(school.id, () => executeClasspilotCommand({
          schoolId: school.id,
          actorId: teacher.id,
          supervisionContextId: context.id,
          targetScope: "students",
          commandType: "open-tab",
          rawCommandPayload: { url: "https://example.com/unauthorized" },
          targets: [{
            studentId: studentUnassigned.id,
            studentName: "Unassigned Student",
            studentSessionId: unassignedBinding!.id,
            deviceId: unassignedBinding!.deviceId,
            available: true,
          }],
          supervisionActorIsAdmin: false,
        })),
        (error: any) => error?.code === "COMMAND_ACTOR_AUTHORITY_STALE"
      );

      const adminCommand = await inSchool(school.id, () => executeClasspilotCommand({
        schoolId: school.id,
        actorId: admin.id,
        supervisionContextId: context.id,
        targetScope: "students",
        commandType: "open-tab",
        rawCommandPayload: { url: "https://example.com/admin" },
        targets: [{
          studentId: studentCoverage.id,
          studentName: "Coverage Student",
          studentSessionId: coverageBinding!.id,
          deviceId: coverageBinding!.deviceId,
          available: true,
        }],
        supervisionActorIsAdmin: true,
      }));
      assert.equal(adminCommand.command.targets[0]?.status, "sent");

      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: context.id,
        studentIds: [studentUnassigned.id],
        releaseReason: "race_before_commit",
      }));
      const staleTarget = await inSchool(school.id, () => executeClasspilotCommand({
        schoolId: school.id,
        actorId: coverageStaff.id,
        supervisionContextId: context.id,
        targetScope: "students",
        commandType: "open-tab",
        rawCommandPayload: { url: "https://example.com/stale" },
        targets: [{
          studentId: studentUnassigned.id,
          studentName: "Unassigned Student",
          studentSessionId: unassignedBinding!.id,
          deviceId: unassignedBinding!.deviceId,
          available: true,
        }],
        supervisionActorIsAdmin: false,
      }));
      assert.equal(staleTarget.command.targets[0]?.status, "unavailable");
      assert.equal(staleTarget.command.targets[0]?.deviceId, null);
      assert.match(staleTarget.command.targets[0]?.errorMessage || "", /authority changed before dispatch/);
      assert.equal(staleTarget.summary.attempted, 0);
    } finally {
      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: context.id,
        releaseReason: "test_release",
      }));
    }
  });

  it("revalidates immutable teaching-session staff inside command creation", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Command_Actor_Race`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentUnassigned.id]));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    try {
      const binding = await inSchool(school.id, () => getActiveSessionByStudent(studentUnassigned.id));
      assert.ok(binding);
      await assert.rejects(
        () => inSchool(school.id, () => executeClasspilotCommand({
          schoolId: school.id,
          actorId: coverageStaff.id,
          teachingSessionId: teachingSession.id,
          targetScope: "students",
          commandType: "open-tab",
          rawCommandPayload: { url: "https://example.com/not-session-staff" },
          targets: [{
            studentId: studentUnassigned.id,
            studentName: "Unassigned Student",
            studentSessionId: binding!.id,
            deviceId: binding!.deviceId,
            available: true,
          }],
        })),
        (error: any) => error?.code === "COMMAND_ACTOR_AUTHORITY_STALE"
      );
    } finally {
      await inSchool(school.id, () => endTeachingSession(teachingSession.id));
    }
  });

  it("linearizes command and FAB settings mutations behind entitlement revocation", async () => {
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Entitlement_Race`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [studentDeviceGuard.id]));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    const binding = await inSchool(school.id, () => getActiveSessionByStudent(studentDeviceGuard.id));
    assert.ok(binding);
    const revocation = await pool.connect();
    try {
      await revocation.query("BEGIN");
      await revocation.query(`
        UPDATE product_licenses
        SET status = 'inactive'
        WHERE school_id = $1 AND product = 'CLASSPILOT'
      `, [school.id]);

      const commandAttempt = inSchool(school.id, () => executeClasspilotCommand({
        schoolId: school.id,
        actorId: teacher.id,
        teachingSessionId: teachingSession.id,
        targetScope: "students",
        commandType: "open-tab",
        rawCommandPayload: { url: "https://example.com/revocation-race" },
        targets: [{
          studentId: studentDeviceGuard.id,
          studentName: "Device Guard",
          studentSessionId: binding!.id,
          deviceId: binding!.deviceId,
          available: true,
        }],
      }));
      const settingsAttempt = inSchool(school.id, () => upsertSessionSettings(
        school.id,
        teachingSession.id,
        { chatEnabled: false },
        { actorId: teacher.id }
      ));

      // Both mutations are now queued behind the revocation row lock. Once
      // revocation commits, their in-transaction uncached checks must observe
      // it and reject instead of committing after cleanup.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await revocation.query("COMMIT");
      const [commandResult, settingsResult] = await Promise.allSettled([
        commandAttempt,
        settingsAttempt,
      ]);
      assert.equal(commandResult.status, "rejected");
      assert.equal(settingsResult.status, "rejected");
      assert.equal(commandResult.status === "rejected" ? (commandResult.reason as any)?.code : null, "CLASSPILOT_NOT_ENTITLED");
      assert.equal(settingsResult.status === "rejected" ? (settingsResult.reason as any)?.code : null, "CLASSPILOT_NOT_ENTITLED");
    } finally {
      await revocation.query("ROLLBACK").catch(() => {});
      revocation.release();
      await asSystem(() => db.execute(sql`
        UPDATE product_licenses
        SET status = 'active'
        WHERE school_id = ${school.id} AND product = 'CLASSPILOT'
      `).then(() => undefined));
      await inSchool(school.id, () => endTeachingSession(teachingSession.id));
    }
  });

  it("does not persist a durable offline command after teaching authority moves to coverage", async () => {
    const offlineStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Offline",
      lastName: "Authority Race",
      email: `offline-authority-race@${TAG}.example.edu`,
      emailLc: `offline-authority-race@${TAG}.example.edu`,
      status: "active",
    } as any));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Offline_Authority_Race`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [offlineStudent.id]));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    const context = await inSchool(school.id, () => createSupervisionContextWithStudents({
      context: {
        schoolId: school.id,
        contextType: "office",
        name: "Offline Durable Authority Race",
        status: "active",
        assignedStaffId: coverageStaff.id,
        createdBy: admin.id,
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      studentIds: [offlineStudent.id],
      assignedBy: admin.id,
      source: "admin_reroute",
    }));
    try {
      // This target represents an offline roster snapshot resolved immediately
      // before the coverage claim committed.
      const result = await inSchool(school.id, () => executeClasspilotCommand({
        schoolId: school.id,
        actorId: teacher.id,
        teachingSessionId: teachingSession.id,
        targetScope: "students",
        commandType: "teacher-message",
        rawCommandPayload: { message: "Must not cross the ownership transition" },
        targets: [{
          studentId: offlineStudent.id,
          studentName: "Offline Authority Race",
          studentSessionId: null,
          deviceId: null,
          available: false,
          stateAuthorized: true,
          unavailableReason: "Student is not signed in to the extension",
        }],
      }));
      assert.equal(result.command.targets[0]?.status, "unavailable");
      assert.match(result.command.targets[0]?.errorMessage || "", /authority changed before dispatch/);
      const messages = await inSchool(school.id, () => getRecentMessagesForStudent(offlineStudent.id, 10));
      assert.equal(messages.length, 0);
    } finally {
      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: context.id,
        releaseReason: "test_release",
      }));
      await inSchool(school.id, () => endTeachingSession(teachingSession.id));
    }
  });

  it("keeps a completed command target terminal when sent and received updates arrive late", async () => {
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "lock-screen",
        commandPayload: {},
        requestedCount: 1,
        unavailableCount: 0,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "requested",
        errorMessage: null,
      } as any]
    ));

    const completed = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
      result: { ok: true },
    }));
    assert.equal(completed?.status, "completed");
    assert.ok(completed?.receivedAt);
    assert.ok(completed?.completedAt);

    const duplicate = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
      result: { ok: true },
    }));
    assert.equal(duplicate.disposition, "idempotent");
    assert.equal(duplicate.code, "COMMAND_ACK_IDEMPOTENT");

    const invalidTransition = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "received",
    }));
    assert.equal(invalidTransition.disposition, "terminal_rejected");
    assert.equal(invalidTransition.code, "COMMAND_ACK_INVALID_TRANSITION");

    const originalReceivedAt = completed.receivedAt!.getTime();
    const originalCompletedAt = completed.completedAt!.getTime();

    const markedSent = await inSchool(school.id, () => markClasspilotCommandTargetsSent(
      created.id,
      [deviceGuard]
    ));
    assert.equal(markedSent[0]?.status, "completed");
    assert.ok(markedSent[0]?.sentAt);

    const lateReceived = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "received",
      result: { late: true },
    }));
    assert.equal(lateReceived, undefined);

    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.status, "completed");
    assert.equal(loaded?.requestedCount, 1);
    assert.equal(loaded?.sentCount, 1);
    assert.equal(loaded?.receivedCount, 1);
    assert.equal(loaded?.completedCount, 1);
    assert.equal(loaded?.failedCount, 0);
    assert.equal(loaded?.unavailableCount, 0);
    assert.equal(loaded?.targets[0]?.status, "completed");
    assert.equal(loaded?.targets[0]?.ackState, "completed");
    assert.equal(loaded?.targets[0]?.receivedAt?.getTime(), originalReceivedAt);
    assert.equal(loaded?.targets[0]?.completedAt?.getTime(), originalCompletedAt);
    assert.deepEqual(loaded?.targets[0]?.result, { ok: true });
  });

  it("fails closed when an exact-tab V2 ACK does not match the frozen control revision", async () => {
    const createExactTarget = (suffix: string) => inSchool(school.id, () =>
      createClasspilotCommandWithTargets({
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "close-tabs",
        commandPayload: { suffix },
        requestedCount: 1,
        unavailableCount: 0,
      } as any, [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "sent",
        result: { exactTabCloseVersion: 2, frozenControlRevision: 12 },
        errorMessage: null,
      } as any])
    );

    const mismatchedCommand = await createExactTarget("mismatch");
    const mismatched = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: mismatchedCommand.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
      controlRevision: 13,
    }));
    assert.equal(mismatched.disposition, "terminal_rejected");
    assert.equal(mismatched.code, "COMMAND_ACK_BINDING_MISMATCH");
    assert.equal(mismatched.target?.status, "unavailable");

    const matchingCommand = await createExactTarget("match");
    const matching = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: matchingCommand.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
      controlRevision: 12,
    }));
    assert.equal(matching.disposition, "applied");
    assert.equal(matching.target.status, "completed");

    const expiredMismatchCommand = await inSchool(school.id, () =>
      createClasspilotCommandWithTargets({
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "close-tabs",
        commandPayload: { suffix: "expired-mismatch" },
        requestedCount: 1,
        unavailableCount: 0,
        expiresAt: new Date(Date.now() - 1_000),
      } as any, [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "sent",
        result: { exactTabCloseVersion: 2, frozenControlRevision: 12 },
        errorMessage: null,
      } as any])
    );
    const expiredMismatch = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: expiredMismatchCommand.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "expired",
      controlRevision: 13,
    }));
    assert.equal(expiredMismatch.disposition, "terminal_rejected");
    assert.equal(expiredMismatch.code, "COMMAND_ACK_BINDING_MISMATCH");
    assert.equal(expiredMismatch.target?.status, "unavailable");

    const expiredMissingCommand = await inSchool(school.id, () =>
      createClasspilotCommandWithTargets({
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "close-tabs",
        commandPayload: { suffix: "expired-missing" },
        requestedCount: 1,
        unavailableCount: 0,
        expiresAt: new Date(Date.now() - 1_000),
      } as any, [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "sent",
        result: { exactTabCloseVersion: 2, frozenControlRevision: 12 },
        errorMessage: null,
      } as any])
    );
    const expiredMissing = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: expiredMissingCommand.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "expired",
    }));
    assert.equal(expiredMissing.disposition, "terminal_rejected");
    assert.equal(expiredMissing.code, "COMMAND_ACK_BINDING_MISMATCH");
    assert.equal(expiredMissing.target?.status, "unavailable");

    const overwrittenCommand = await createExactTarget("client-result-cannot-overwrite-authority");
    const received = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: overwrittenCommand.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "received",
      controlRevision: 12,
      result: {
        phase: "received",
        exactTabCloseVersion: 1,
        frozenControlRevision: 999,
      },
    }));
    assert.equal(received.disposition, "applied");
    assert.deepEqual(received.target.result, {
      phase: "received",
      exactTabCloseVersion: 2,
      frozenControlRevision: 12,
    });

    const overwrittenRevision = await inSchool(school.id, () => persistClasspilotCommandTargetAck({
      commandId: overwrittenCommand.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
      controlRevision: 999,
      result: { phase: "completed" },
    }));
    assert.equal(overwrittenRevision.disposition, "terminal_rejected");
    assert.equal(overwrittenRevision.code, "COMMAND_ACK_BINDING_MISMATCH");
    assert.equal(overwrittenRevision.target?.status, "unavailable");
  });

  it("converges concurrent sent and acknowledgement updates on completed", async () => {
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "close-tab",
        commandPayload: { url: "https://example.com/" },
        requestedCount: 1,
        unavailableCount: 0,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "requested",
        errorMessage: null,
      } as any]
    ));

    await Promise.all([
      inSchool(school.id, () => markClasspilotCommandTargetsSent(created.id, [deviceGuard])),
      inSchool(school.id, () => updateClasspilotCommandTargetAck({
        commandId: created.id,
        schoolId: school.id,
        deviceId: deviceGuard,
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        ackState: "received",
        result: { phase: "received" },
      })),
      inSchool(school.id, () => updateClasspilotCommandTargetAck({
        commandId: created.id,
        schoolId: school.id,
        deviceId: deviceGuard,
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        ackState: "completed",
        result: { phase: "completed" },
      })),
    ]);
    await inSchool(school.id, () => updateClasspilotCommandSummary(created.id));

    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.status, "completed");
    assert.equal(loaded?.requestedCount, 1);
    assert.equal(loaded?.sentCount, 1);
    assert.equal(loaded?.receivedCount, 1);
    assert.equal(loaded?.completedCount, 1);
    assert.equal(loaded?.failedCount, 0);
    assert.equal(loaded?.unavailableCount, 0);
    assert.equal(loaded?.targets[0]?.status, "completed");
    assert.equal(loaded?.targets[0]?.ackState, "completed");
    assert.ok(loaded?.targets[0]?.sentAt);
    assert.ok(loaded?.targets[0]?.receivedAt);
    assert.ok(loaded?.targets[0]?.completedAt);
  });

  it("records a late received milestone without reopening a failed target", async () => {
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "open-tab",
        commandPayload: { url: "https://example.com/" },
        requestedCount: 1,
        unavailableCount: 0,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "requested",
        errorMessage: null,
      } as any]
    ));

    await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "failed",
      errorMessage: "synthetic failure",
    }));
    const lateReceived = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "received",
    }));
    assert.equal(lateReceived?.status, "failed");
    assert.equal(lateReceived?.ackState, "failed");
    await inSchool(school.id, () => updateClasspilotCommandSummary(created.id));

    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.status, "failed");
    assert.equal(loaded?.receivedCount, 1);
    assert.equal(loaded?.failedCount, 1);
    assert.equal(loaded?.targets[0]?.status, "failed");
    assert.equal(loaded?.targets[0]?.ackState, "failed");
    assert.ok(loaded?.targets[0]?.receivedAt);
    assert.ok(loaded?.targets[0]?.failedAt);
  });

  it("expires an unreceived transient target and rejects a late received acknowledgement", async () => {
    const deadline = new Date("2026-08-13T12:00:15.000Z");
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "open-tab",
        commandPayload: { url: "https://example.com/" },
        requestedCount: 1,
        unavailableCount: 0,
        expiresAt: deadline,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "requested",
        errorMessage: null,
      } as any]
    ));
    await inSchool(school.id, () => markClasspilotCommandTargetsSent(created.id, [deviceGuard]));

    const lateReceived = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "received",
      now: new Date(deadline.getTime() + 1),
    }));
    assert.equal(lateReceived?.status, "expired");
    assert.equal(lateReceived?.receivedAt, null);
    assert.notEqual(lateReceived?.ackState, "received");

    await inSchool(school.id, () => updateClasspilotCommandSummary(created.id));
    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.status, "expired");
    assert.equal(loaded?.targets[0]?.status, "expired");
  });

  it("allows completion after expiry only when receipt was recorded before the deadline", async () => {
    const deadline = new Date(Date.now() + 60_000);
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "close-tabs",
        commandPayload: {},
        requestedCount: 1,
        unavailableCount: 0,
        expiresAt: deadline,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "requested",
        errorMessage: null,
      } as any]
    ));
    await inSchool(school.id, () => markClasspilotCommandTargetsSent(created.id, [deviceGuard]));
    const received = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "received",
      now: new Date(deadline.getTime() - 1),
    }));
    assert.equal(received?.status, "received");

    const completed = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
      now: new Date(deadline.getTime() + 1),
    }));
    assert.equal(completed?.status, "completed");
    assert.ok(completed?.receivedAt);
    assert.ok(completed?.completedAt);
  });

  it("persists expired transient targets and accepts an exact expired device outcome", async () => {
    const deadline = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "timer",
        commandPayload: {},
        requestedCount: 1,
        unavailableCount: 0,
        expiresAt: deadline,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "sent",
        sentAt: new Date(deadline.getTime() - 1_000),
        errorMessage: null,
      } as any]
    ));

    assert.ok(created.expiresAt);
    assert.equal(created.targets[0]?.status, "sent");

    const expiredCommandIds = await inSchool(school.id, () =>
      expireClasspilotTransientCommandTargets({
        commandId: created.id,
        schoolId: school.id,
        now: new Date(),
      })
    );
    assert.deepEqual(expiredCommandIds, [created.id]);

    const expiredAck = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "expired",
      now: new Date(),
    }));
    assert.equal(expiredAck?.status, "expired");
    assert.equal(expiredAck?.ackState, "expired");
  });

  it("queues and recovers a durable teacher message through the class route when the active session loses signal", async () => {
    const signalLostStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Class",
      lastName: "Signal Lost",
      email: `class-signal-lost-message@${TAG}.example.edu`,
      emailLc: `class-signal-lost-message@${TAG}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const signalLostDeviceId = `${TAG}-class-signal-lost-message-device`;
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Class_Signal_Lost_Message`,
      groupType: "admin_class",
      status: "active",
    } as Parameters<typeof createGroup>[0]));
    await inSchool(school.id, async () => {
      await createDevice({
        deviceId: signalLostDeviceId,
        schoolId: school.id,
        classId: "default",
        deviceName: "Class Signal Lost Message",
      } as Parameters<typeof createDevice>[0]);
      await linkStudentDevice({
        studentId: signalLostStudent.id,
        deviceId: signalLostDeviceId,
      });
      await addGroupStudentsDetailed(group.id, [signalLostStudent.id]);
    });
    const studentSession = await inSchool(school.id, () =>
      setActiveStudentForDevice(signalLostDeviceId, signalLostStudent.id)
    );
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    const message = `Class route queued while signal lost ${TAG}`;
    try {
      const response = await requestJson("POST", "/commands", {
        teachingSessionId: teachingSession.id,
        targetScope: "students",
        targetStudentIds: [signalLostStudent.id],
        commandType: "teacher-message",
        commandPayload: { message },
      }, authFor(teacher, school.id));

      assert.equal(response.status, 201);
      assert.equal(response.body.deliveryPolicy, "durable_message");
      assert.equal(response.body.summary.requested, 1);
      assert.equal(response.body.summary.attempted, 0);
      assert.equal(response.body.summary.unavailable, 1);
      assert.match(response.body.command.targets[0]?.errorMessage || "", /signal is unavailable/);

      const queued = await inSchool(school.id, () =>
        getRecentMessagesForStudent(signalLostStudent.id, 10)
      );
      assert.equal(queued.some((entry) =>
        entry.commandId === response.body.command.id && entry.message === message
      ), true);

      const pending = await inSchool(school.id, () => getPendingMessagesForStudent({
        schoolId: school.id,
        studentId: signalLostStudent.id,
        studentSessionId: studentSession.id,
        deviceId: signalLostDeviceId,
      }));
      const recovered = pending.find((entry) => entry.commandId === response.body.command.id);
      assert.ok(recovered);
      assert.equal(recovered.message, message);
      const claimed = await inSchool(school.id, () =>
        getClasspilotCommandByIdAndSchool(response.body.command.id, school.id)
      );
      assert.equal(claimed?.targets[0]?.studentSessionId, studentSession.id);
      assert.equal(claimed?.targets[0]?.deviceId, signalLostDeviceId);
      assert.equal(claimed?.targets[0]?.status, "sent");
    } finally {
      await inSchool(school.id, () => endTeachingSession(teachingSession.id));
      await inSchool(school.id, () => endStudentSession(studentSession.id));
      await inSchool(school.id, () => deleteDevice(signalLostDeviceId));
    }
  });

  it("queues and recovers a durable teacher message through Coverage when the active session loses signal", async () => {
    const signalLostStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Coverage",
      lastName: "Signal Lost",
      email: `coverage-signal-lost-message@${TAG}.example.edu`,
      emailLc: `coverage-signal-lost-message@${TAG}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const signalLostDeviceId = `${TAG}-coverage-signal-lost-message-device`;
    await inSchool(school.id, async () => {
      await createDevice({
        deviceId: signalLostDeviceId,
        schoolId: school.id,
        classId: "default",
        deviceName: "Coverage Signal Lost Message",
      } as Parameters<typeof createDevice>[0]);
      await linkStudentDevice({
        studentId: signalLostStudent.id,
        deviceId: signalLostDeviceId,
      });
    });
    const studentSession = await inSchool(school.id, () =>
      setActiveStudentForDevice(signalLostDeviceId, signalLostStudent.id)
    );
    const context = await inSchool(school.id, () => createSupervisionContextWithStudents({
      context: {
        schoolId: school.id,
        contextType: "office",
        name: "Coverage Signal Lost Message",
        status: "active",
        assignedStaffId: coverageStaff.id,
        createdBy: admin.id,
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      studentIds: [signalLostStudent.id],
      assignedBy: admin.id,
      source: "admin_reroute",
    }));
    const message = `Coverage route queued while signal lost ${TAG}`;
    try {
      const response = await requestJson(
        "POST",
        `/coverage/contexts/${context.id}/commands`,
        {
          targetScope: "students",
          targetStudentIds: [signalLostStudent.id],
          commandType: "teacher-message",
          commandPayload: { message },
        },
        authFor(coverageStaff, school.id)
      );

      assert.equal(response.status, 201);
      assert.equal(response.body.deliveryPolicy, "durable_message");
      assert.equal(response.body.summary.requested, 1);
      assert.equal(response.body.summary.attempted, 0);
      assert.equal(response.body.summary.unavailable, 1);
      assert.match(response.body.command.targets[0]?.errorMessage || "", /signal is unavailable/);

      const queued = await inSchool(school.id, () =>
        getRecentMessagesForStudent(signalLostStudent.id, 10)
      );
      assert.equal(queued.some((entry) =>
        entry.commandId === response.body.command.id && entry.message === message
      ), true);

      const pending = await inSchool(school.id, () => getPendingMessagesForStudent({
        schoolId: school.id,
        studentId: signalLostStudent.id,
        studentSessionId: studentSession.id,
        deviceId: signalLostDeviceId,
      }));
      const recovered = pending.find((entry) => entry.commandId === response.body.command.id);
      assert.ok(recovered);
      assert.equal(recovered.message, message);
      const claimed = await inSchool(school.id, () =>
        getClasspilotCommandByIdAndSchool(response.body.command.id, school.id)
      );
      assert.equal(claimed?.targets[0]?.studentSessionId, studentSession.id);
      assert.equal(claimed?.targets[0]?.deviceId, signalLostDeviceId);
      assert.equal(claimed?.targets[0]?.status, "sent");
    } finally {
      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: context.id,
        releaseReason: "test_release",
      }));
      await inSchool(school.id, () => endStudentSession(studentSession.id));
      await inSchool(school.id, () => deleteDevice(signalLostDeviceId));
    }
  });

  it("recovers a durable teacher message after an outage longer than five minutes", async () => {
    const offlineStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Offline",
      lastName: "Message",
      email: `offline-message@${TAG}.example.edu`,
      emailLc: `offline-message@${TAG}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as any));
    const messageGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Durable_Message`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(messageGroup.id, [offlineStudent.id]));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: messageGroup.id,
      teacherId: teacher.id,
    }));
    const text = `Queued while offline ${TAG}`;
    const result = await inSchool(school.id, () => executeClasspilotCommand({
      schoolId: school.id,
      actorId: teacher.id,
      teachingSessionId: teachingSession.id,
      targetScope: "students",
      commandType: "teacher-message",
      rawCommandPayload: { message: text },
      targets: [{
        studentId: offlineStudent.id,
        studentName: "Offline Message",
        studentSessionId: null,
        deviceId: null,
        available: false,
        stateAuthorized: true,
        unavailableReason: "Student is not signed in to the extension",
      }],
    }));

    assert.equal(result.deliveryPolicy, "durable_message");
    assert.equal(result.expiresAt, null);
    assert.equal(result.summary.requested, 1);
    assert.equal(result.summary.attempted, 0);
    await inSchool(school.id, () => db.execute(sql`
      UPDATE messages
      SET timestamp = ${new Date(Date.now() - 10 * 60 * 1000)}
      WHERE school_id = ${school.id}
        AND to_student_id = ${offlineStudent.id}
        AND message = ${text}
    `));

    const legacyFiveMinuteWindow = await inSchool(school.id, () =>
      getRecentMessagesForStudent(offlineStudent.id, 5)
    );
    assert.equal(legacyFiveMinuteWindow.some((message) => message.message === text), false);

    const recoveryDeviceId = `${TAG}-offline-message-recovery`;
    await inSchool(school.id, () => createDevice({
      deviceId: recoveryDeviceId,
      schoolId: school.id,
      classId: "default",
      deviceName: "Offline Message Recovery",
    } as any));
    await inSchool(school.id, () => linkStudentDevice({
      studentId: offlineStudent.id,
      deviceId: recoveryDeviceId,
    }));
    const recoverySession = await inSchool(school.id, () =>
      setActiveStudentForDevice(recoveryDeviceId, offlineStudent.id)
    );
    const inboxOptions = {
      schoolId: school.id,
      studentId: offlineStudent.id,
      studentSessionId: recoverySession.id,
      deviceId: recoveryDeviceId,
    };
    const pending = await inSchool(school.id, () => getPendingMessagesForStudent(inboxOptions));
    const recovered = pending.find((message) => message.message === text);
    assert.ok(recovered);
    assert.equal(recovered.commandId, result.command.id);
    assert.equal(recovered.teachingSessionId, teachingSession.id);
    assert.equal(recovered.supervisionContextId, null);
    const claimedCommand = await inSchool(school.id, () =>
      getClasspilotCommandByIdAndSchool(result.command.id, school.id)
    );
    assert.equal(claimedCommand?.targets[0]?.studentSessionId, recoverySession.id);
    assert.equal(claimedCommand?.targets[0]?.deviceId, recoveryDeviceId);
    assert.equal(claimedCommand?.targets[0]?.status, "sent");
    const excluded = await inSchool(school.id, () => getPendingMessagesForStudent({
      ...inboxOptions,
      excludeMessageIds: [recovered.id],
    }));
    assert.equal(excluded.some((message) => message.id === recovered.id), false);

    const retryableFailure = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: result.command.id,
      schoolId: school.id,
      studentId: offlineStudent.id,
      studentSessionId: recoverySession.id,
      deviceId: recoveryDeviceId,
      ackState: "failed",
      errorMessage: "Temporary local inbox write failure",
    }));
    assert.ok(["sent", "received"].includes(retryableFailure?.status || ""));
    const retried = await inSchool(school.id, () => getPendingMessagesForStudent(inboxOptions));
    assert.equal(retried.some((message) => message.id === recovered.id), true);

    const completed = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: result.command.id,
      schoolId: school.id,
      studentId: offlineStudent.id,
      studentSessionId: recoverySession.id,
      deviceId: recoveryDeviceId,
      ackState: "completed",
      result: { messageId: recovered.id, recovered: true },
    }));
    assert.equal(completed?.status, "completed");
    await inSchool(school.id, () => updateClasspilotCommandSummary(result.command.id));
    const completedCommand = await inSchool(school.id, () =>
      getClasspilotCommandByIdAndSchool(result.command.id, school.id)
    );
    assert.equal(completedCommand?.status, "completed");
    assert.equal(completedCommand?.completedCount, 1);
    const afterCompleted = await inSchool(school.id, () => getPendingMessagesForStudent(inboxOptions));
    assert.equal(afterCompleted.some((message) => message.id === recovered.id), false);

    const staleText = `Must not return after session end ${TAG}`;
    const stale = await inSchool(school.id, () => executeClasspilotCommand({
      schoolId: school.id,
      actorId: teacher.id,
      teachingSessionId: teachingSession.id,
      targetScope: "students",
      commandType: "teacher-message",
      rawCommandPayload: { message: staleText },
      targets: [{
        studentId: offlineStudent.id,
        studentName: "Offline Message",
        studentSessionId: recoverySession.id,
        deviceId: recoveryDeviceId,
        available: true,
      }],
    }));
    await inSchool(school.id, () => endTeachingSession(teachingSession.id));
    const staleFailure = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: stale.command.id,
      schoolId: school.id,
      studentId: offlineStudent.id,
      studentSessionId: recoverySession.id,
      deviceId: recoveryDeviceId,
      ackState: "failed",
      errorMessage: "Teacher message belongs to an inactive teaching session",
    }));
    assert.equal(staleFailure?.status, "failed");
    const afterAuthorityEnded = await inSchool(school.id, () =>
      getPendingMessagesForStudent(inboxOptions)
    );
    assert.equal(afterAuthorityEnded.some((message) => message.commandId === stale.command.id), false);
    await inSchool(school.id, () => deleteDevice(recoveryDeviceId));
  });

  it("does not author an offline persistent-control state while the operator gate is off", async () => {
    const previousProtocol = process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
    const previousLateSignIn = process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
    const previousRollouts = process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
    process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
    process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "false";
    process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
      lateSignInRestrictionSsoV1: { mode: "off", schoolIds: [school.id] },
    });
    try {
      const offlineStudent = await inSchool(school.id, () => createStudent({
        schoolId: school.id,
        firstName: "Gate Off",
        lastName: "Control",
        email: `gate-off-control@${TAG}.example.edu`,
        emailLc: `gate-off-control@${TAG}.example.edu`,
        gradeLevel: "8",
        status: "active",
      } as any));
      const group = await inSchool(school.id, () => createGroup({
        schoolId: school.id,
        teacherId: teacher.id,
        name: `${TAG}_Gate_Off_Control`,
        groupType: "admin_class",
        status: "active",
      } as any));
      await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [offlineStudent.id]));
      const teachingSession = await inSchool(school.id, () => createTeachingSession({
        groupId: group.id,
        teacherId: teacher.id,
      }));
      const result = await inSchool(school.id, () => executeClasspilotCommand({
        schoolId: school.id,
        actorId: teacher.id,
        teachingSessionId: teachingSession.id,
        targetScope: "students",
        commandType: "lock-screen",
        rawCommandPayload: { url: "https://example.edu/must-not-persist" },
        targets: [{
          studentId: offlineStudent.id,
          studentName: "Gate Off Control",
          studentSessionId: null,
          deviceId: null,
          available: false,
          stateAuthorized: true,
          lateSignInEligible: true,
          unavailableReason: "Student is not signed in to the extension",
        }],
      }));
      assert.equal(result.command.targets[0]?.status, "unavailable");
      const control = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, offlineStudent.id)
      );
      assert.notEqual(control?.sourceCommandId, result.command.id);
      await inSchool(school.id, () => endTeachingSession(teachingSession.id));
    } finally {
      if (previousProtocol === undefined) delete process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
      else process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = previousProtocol;
      if (previousLateSignIn === undefined) {
        delete process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
      } else {
        process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = previousLateSignIn;
      }
      if (previousRollouts === undefined) delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
      else process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = previousRollouts;
    }
  });

  it("rechecks the late-sign-in gate under the class persistence lock", async () => {
    const previousProtocol = process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
    const previousLateSignIn = process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
    const previousRollouts = process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
    process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
    process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true";
    process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
      lateSignInRestrictionSsoV1: { mode: "on", schoolIds: [school.id] },
    });

    const blocker = await pool.connect();
    let blockerOpen = false;
    let teachingSession: any;
    let mutation: ReturnType<typeof persistClasspilotControlCommandState> | undefined;
    try {
      const offlineStudent = await inSchool(school.id, () => createStudent({
        schoolId: school.id,
        firstName: "Gate",
        lastName: "Class Race",
        email: `gate-class-race@${TAG}.example.edu`,
        emailLc: `gate-class-race@${TAG}.example.edu`,
        gradeLevel: "8",
        status: "active",
      } as Parameters<typeof createStudent>[0]));
      const group = await inSchool(school.id, () => createGroup({
        schoolId: school.id,
        teacherId: teacher.id,
        name: `${TAG}_Gate_Class_Race`,
        groupType: "admin_class",
        status: "active",
      } as Parameters<typeof createGroup>[0]));
      await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [offlineStudent.id]));
      teachingSession = await inSchool(school.id, () => createTeachingSession({
        groupId: group.id,
        teacherId: teacher.id,
      }));
      const before = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, offlineStudent.id)
      );
      assert.ok(before);
      const stampedBefore = await inSchool(school.id, () =>
        countClasspilotLateSignInStampedStates(school.id)
      );
      const attemptedCommandId = `${TAG}-gate-class-race-command`;

      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
        [`classpilot:student-control:${school.id}:${offlineStudent.id}`]
      );
      const blockerPid = Number(
        (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid
      );
      assert.equal(Number.isSafeInteger(blockerPid), true);

      let mutationSettled = false;
      mutation = inSchool(school.id, () => persistClasspilotControlCommandState({
        lateSignInGateRequiredStudentIds: [offlineStudent.id],
        classroomStateUpserts: [{
          schoolId: school.id,
          teachingSessionId: teachingSession.id,
          studentId: offlineStudent.id,
          stateType: "screen-lock",
          stateKey: "active",
          payload: { url: "https://example.edu/gate-class-race" },
          commandId: attemptedCommandId,
          appliedBy: teacher.id,
        }],
        studentSnapshots: {
          schoolId: school.id,
          teachingSessionId: teachingSession.id,
          studentIds: [offlineStudent.id],
          sourceCommandId: attemptedCommandId,
          bindingExpectationByStudent: new Map([
            [offlineStudent.id, { kind: "signed_out" as const }],
          ]),
          desiredState: () => withClasspilotLateSignInOrigin({
            desiredState: {
              restrictions: {
                locked: true,
                url: "https://example.edu/gate-class-race",
              },
            },
            commandId: attemptedCommandId,
          }),
        },
      }));
      void mutation.then(
        () => { mutationSettled = true; },
        () => { mutationSettled = true; }
      );

      let waitingCount = 0;
      const waitDeadline = Date.now() + 5_000;
      while (waitingCount === 0 && Date.now() < waitDeadline) {
        const snapshot = await blocker.query(`
          SELECT count(*)::integer AS "waitingCount"
          FROM pg_stat_activity AS waiter
          WHERE $1::integer = ANY(pg_blocking_pids(waiter.pid))
        `, [blockerPid]);
        waitingCount = Number(snapshot.rows[0]?.waitingCount ?? 0);
        if (waitingCount === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waitingCount, 1, "class persistence must wait on the exact student-control lock");
      assert.equal(mutationSettled, false);

      process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "false";
      process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
        lateSignInRestrictionSsoV1: { mode: "off", schoolIds: [school.id] },
      });
      await blocker.query("COMMIT");
      blockerOpen = false;

      const result = await mutation;
      assert.deepEqual(result.classroomStates, []);
      assert.deepEqual(result.studentControlStates, []);
      assert.deepEqual(result.rejectedStudentIds, [offlineStudent.id]);
      const after = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, offlineStudent.id)
      );
      assert.equal(after?.revision, before.revision);
      assert.equal(after?.sourceCommandId, before.sourceCommandId);
      assert.deepEqual(after?.desiredState, before.desiredState);
      assert.equal(
        await inSchool(school.id, () => countClasspilotLateSignInStampedStates(school.id)),
        stampedBefore
      );
      assert.equal(
        (await inSchool(school.id, () =>
          getActiveClasspilotClassroomStates(school.id, teachingSession.id)
        )).some((state) => state.commandId === attemptedCommandId),
        false
      );
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await mutation?.catch(() => {});
      if (teachingSession?.id) {
        await inSchool(school.id, () => endTeachingSession(teachingSession.id)).catch(() => {});
      }
      if (previousProtocol === undefined) delete process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
      else process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = previousProtocol;
      if (previousLateSignIn === undefined) {
        delete process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
      } else {
        process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = previousLateSignIn;
      }
      if (previousRollouts === undefined) delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
      else process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = previousRollouts;
    }
  });

  it("rechecks the late-sign-in gate under the Coverage persistence lock", async () => {
    const previousProtocol = process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
    const previousLateSignIn = process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
    const previousRollouts = process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
    process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
    process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true";
    process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
      lateSignInRestrictionSsoV1: { mode: "on", schoolIds: [school.id] },
    });

    const blocker = await pool.connect();
    let blockerOpen = false;
    let context: any;
    let mutation: ReturnType<typeof replaceClasspilotSupervisionControlSnapshots> | undefined;
    try {
      const offlineStudent = await inSchool(school.id, () => createStudent({
        schoolId: school.id,
        firstName: "Gate",
        lastName: "Coverage Race",
        email: `gate-coverage-race@${TAG}.example.edu`,
        emailLc: `gate-coverage-race@${TAG}.example.edu`,
        gradeLevel: "8",
        status: "active",
      } as Parameters<typeof createStudent>[0]));
      context = await inSchool(school.id, () => createSupervisionContextWithStudents({
        context: {
          schoolId: school.id,
          contextType: "office",
          name: "Late-sign-in gate Coverage race",
          status: "active",
          assignedStaffId: coverageStaff.id,
          createdBy: admin.id,
          endsAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        studentIds: [offlineStudent.id],
        assignedBy: admin.id,
        source: "admin_reroute",
      }));
      const before = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, offlineStudent.id)
      );
      assert.ok(before);
      const stampedBefore = await inSchool(school.id, () =>
        countClasspilotLateSignInStampedStates(school.id)
      );
      const attemptedCommandId = `${TAG}-gate-coverage-race-command`;

      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
        [`classpilot:student-control:${school.id}:${offlineStudent.id}`]
      );
      const blockerPid = Number(
        (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid
      );
      assert.equal(Number.isSafeInteger(blockerPid), true);

      let mutationSettled = false;
      mutation = inSchool(school.id, () => replaceClasspilotSupervisionControlSnapshots({
        schoolId: school.id,
        supervisionContextId: context.id,
        studentIds: [offlineStudent.id],
        sourceCommandId: attemptedCommandId,
        authorizedActorId: coverageStaff.id,
        actorIsAdmin: false,
        bindingExpectationByStudent: new Map([
          [offlineStudent.id, { kind: "signed_out" as const }],
        ]),
        lateSignInGateRequiredStudentIds: [offlineStudent.id],
        desiredState: () => withClasspilotLateSignInOrigin({
          desiredState: {
            restrictions: {
              locked: true,
              url: "https://example.edu/gate-coverage-race",
            },
          },
          commandId: attemptedCommandId,
        }),
      }));
      void mutation.then(
        () => { mutationSettled = true; },
        () => { mutationSettled = true; }
      );

      let waitingCount = 0;
      const waitDeadline = Date.now() + 5_000;
      while (waitingCount === 0 && Date.now() < waitDeadline) {
        const snapshot = await blocker.query(`
          SELECT count(*)::integer AS "waitingCount"
          FROM pg_stat_activity AS waiter
          WHERE $1::integer = ANY(pg_blocking_pids(waiter.pid))
        `, [blockerPid]);
        waitingCount = Number(snapshot.rows[0]?.waitingCount ?? 0);
        if (waitingCount === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waitingCount, 1, "Coverage persistence must wait on the exact student-control lock");
      assert.equal(mutationSettled, false);

      process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "false";
      process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
        lateSignInRestrictionSsoV1: { mode: "off", schoolIds: [school.id] },
      });
      await blocker.query("COMMIT");
      blockerOpen = false;

      assert.deepEqual(await mutation, []);
      const after = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, offlineStudent.id)
      );
      assert.equal(after?.revision, before.revision);
      assert.equal(after?.sourceCommandId, before.sourceCommandId);
      assert.deepEqual(after?.desiredState, before.desiredState);
      assert.equal(
        await inSchool(school.id, () => countClasspilotLateSignInStampedStates(school.id)),
        stampedBefore
      );
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await mutation?.catch(() => {});
      if (context?.id) {
        await inSchool(school.id, () => releaseSupervisionStudents({
          schoolId: school.id,
          contextId: context.id,
          releaseReason: "test_cleanup",
        })).catch(() => {});
      }
      if (previousProtocol === undefined) delete process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
      else process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = previousProtocol;
      if (previousLateSignIn === undefined) {
        delete process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
      } else {
        process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = previousLateSignIn;
      }
      if (previousRollouts === undefined) delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
      else process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = previousRollouts;
    }
  });

  it("completes an offline persistent-control command from authoritative state reconciliation", async () => {
    const previousProtocol = process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
    const previousLateSignIn = process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
    const previousRollouts = process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
    process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
    process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true";
    process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({
      lateSignInRestrictionSsoV1: { mode: "on", schoolIds: [school.id] },
    });
    try {
    const stampedBefore = await inSchool(school.id, () =>
      countClasspilotLateSignInStampedStates(school.id)
    );
    const offlineStudent = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Offline",
      lastName: "Control",
      email: `offline-control@${TAG}.example.edu`,
      emailLc: `offline-control@${TAG}.example.edu`,
      gradeLevel: "8",
      status: "active",
    } as any));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Offline_Control`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [offlineStudent.id]));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    const result = await inSchool(school.id, () => executeClasspilotCommand({
      schoolId: school.id,
      actorId: teacher.id,
      teachingSessionId: teachingSession.id,
      targetScope: "students",
      commandType: "lock-screen",
      rawCommandPayload: { url: "https://example.edu/locked" },
      targets: [{
        studentId: offlineStudent.id,
        studentName: "Offline Control",
        studentSessionId: null,
        deviceId: null,
        available: false,
        stateAuthorized: true,
        lateSignInEligible: true,
        unavailableReason: "Student is not signed in to the extension",
      }],
    }));
    assert.equal(result.command.targets[0]?.status, "unavailable");
    const control = await inSchool(school.id, () =>
      getClasspilotStudentControlState(school.id, offlineStudent.id)
    );
    assert.equal(control?.sourceCommandId, result.command.id);
    assert.equal(await inSchool(school.id, () =>
      countClasspilotLateSignInStampedStates(school.id)
    ), stampedBefore + 1);
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_student_control_states
      SET scheduled_end_at = clock_timestamp() - interval '1 second',
          hard_expires_at = clock_timestamp() + interval '1 hour'
      WHERE school_id = ${school.id}
        AND student_id = ${offlineStudent.id}
    `));
    const topLevelExpirySnapshot = await inSchool(school.id, () => db.execute(sql`
      SELECT
        scheduled_end_at <= clock_timestamp() AS scheduled_expired,
        hard_expires_at > clock_timestamp() AS hard_expiry_live,
        desired_state #>> '{restorableClassState,desiredState,lateSignInDelivery,origin}'
          AS nested_origin
      FROM classpilot_student_control_states
      WHERE school_id = ${school.id}
        AND student_id = ${offlineStudent.id}
    `));
    const topLevelExpiryRow = topLevelExpirySnapshot.rows[0] as {
      scheduled_expired?: boolean;
      hard_expiry_live?: boolean;
      nested_origin?: string | null;
    } | undefined;
    assert.equal(topLevelExpiryRow?.scheduled_expired, true);
    assert.equal(topLevelExpiryRow?.hard_expiry_live, true);
    assert.equal(topLevelExpiryRow?.nested_origin, null);
    const directRollbackCount = await inSchool(school.id, () => db.execute(sql`
      SELECT count(*)::int AS count
      FROM classpilot_student_control_states
      WHERE school_id = ${school.id}
        AND (
          (
            desired_state -> 'lateSignInDelivery' ->> 'origin' = 'deferred'
            AND (scheduled_end_at IS NULL OR scheduled_end_at > clock_timestamp())
            AND (hard_expires_at IS NULL OR hard_expires_at > clock_timestamp())
          )
          OR desired_state #>> '{restorableClassState,desiredState,lateSignInDelivery,origin}' = 'deferred'
        )
    `));
    assert.equal(Number(directRollbackCount.rows[0]?.count ?? 0), stampedBefore);
    assert.equal(await inSchool(school.id, () =>
      countClasspilotLateSignInStampedStates(school.id)
    ), stampedBefore);
    const expiredTopLevelStamped = await inSchool(school.id, () =>
      getClasspilotStudentControlState(school.id, offlineStudent.id)
    );
    assert.equal(
      readClasspilotLateSignInDeliveryProvenance(expiredTopLevelStamped?.desiredState)?.origin,
      "deferred"
    );
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_student_control_states
      SET scheduled_end_at = NULL,
          hard_expires_at = clock_timestamp() + interval '12 hours'
      WHERE school_id = ${school.id}
        AND student_id = ${offlineStudent.id}
    `));

    const recoveryDeviceId = `${TAG}-offline-control-recovery`;
    await inSchool(school.id, () => createDevice({
      deviceId: recoveryDeviceId,
      schoolId: school.id,
      classId: "default",
      deviceName: "Offline Control Recovery",
    } as any));
    await inSchool(school.id, () => linkStudentDevice({
      studentId: offlineStudent.id,
      deviceId: recoveryDeviceId,
    }));
    const recoverySession = await inSchool(school.id, () =>
      setActiveStudentForDevice(recoveryDeviceId, offlineStudent.id)
    );
    const acknowledged = await inSchool(school.id, () =>
      acknowledgeClasspilotStudentControlState({
        schoolId: school.id,
        studentId: offlineStudent.id,
        studentSessionId: recoverySession.id,
        deviceId: recoveryDeviceId,
        appliedRevision: control!.revision,
        outcome: "applied",
        acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      })
    );
    assert.equal(acknowledged?.sourceCommandId, result.command.id);
    const completed = await inSchool(school.id, () =>
      getClasspilotCommandByIdAndSchool(result.command.id, school.id)
    );
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.targets[0]?.studentSessionId, recoverySession.id);
    assert.equal(completed?.targets[0]?.deviceId, recoveryDeviceId);
    assert.deepEqual(completed?.targets[0]?.result, {
      classroomStateRevision: control!.revision,
      outcome: "applied",
      reconciliation: true,
    });
    const replacementDeviceId = `${TAG}-offline-control-replacement`;
    await inSchool(school.id, () => createDevice({
      deviceId: replacementDeviceId,
      schoolId: school.id,
      classId: "default",
      deviceName: "Offline Control Replacement",
    } as any));
    await inSchool(school.id, () => linkStudentDevice({
      studentId: offlineStudent.id,
      deviceId: replacementDeviceId,
    }));
    const replacementSession = await inSchool(school.id, () =>
      setActiveStudentForDevice(replacementDeviceId, offlineStudent.id)
    );
    const replacementAck = await inSchool(school.id, () =>
      acknowledgeClasspilotStudentControlState({
        schoolId: school.id,
        studentId: offlineStudent.id,
        studentSessionId: replacementSession.id,
        deviceId: replacementDeviceId,
        appliedRevision: control!.revision,
        outcome: "applied",
        acceptedCapabilities: ["lateSignInRestrictionSsoV1"],
      })
    );
    assert.equal(replacementAck?.revision, control!.revision);
    const bindingHistory = readClasspilotLateSignInDeliveryProvenance(
      replacementAck?.desiredState
    )?.appliedBindings ?? [];
    assert.equal(bindingHistory.some((entry) =>
      entry.studentSessionId === recoverySession.id
      && entry.deviceId === recoveryDeviceId
      && entry.revision === control!.revision
    ), true);
    assert.equal(bindingHistory.some((entry) =>
      entry.studentSessionId === replacementSession.id
      && entry.deviceId === replacementDeviceId
      && entry.revision === control!.revision
    ), true);
    // Coverage owns desired state temporarily by nesting the former class
    // snapshot. The rollback gauge must continue to count that durable stamp.
    const nestedCoverageDesiredState = {
      restrictions: {},
      restorableClassState: {
        desiredState: replacementAck!.desiredState,
        sourceCommandId: replacementAck!.sourceCommandId,
      },
    };
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_student_control_states
      SET desired_state = ${JSON.stringify(nestedCoverageDesiredState)}::jsonb
      WHERE school_id = ${school.id}
        AND student_id = ${offlineStudent.id}
    `));
    assert.equal(await inSchool(school.id, () =>
      countClasspilotLateSignInStampedStates(school.id)
    ), stampedBefore + 1);
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_student_control_states
      SET scheduled_end_at = clock_timestamp() - interval '1 second',
          hard_expires_at = clock_timestamp() + interval '1 hour'
      WHERE school_id = ${school.id}
        AND student_id = ${offlineStudent.id}
    `));
    assert.equal(await inSchool(school.id, () =>
      countClasspilotLateSignInStampedStates(school.id)
    ), stampedBefore + 1);
    const expiredStamped = await inSchool(school.id, () =>
      getClasspilotStudentControlState(school.id, offlineStudent.id)
    );
    const expiredDesiredState = expiredStamped?.desiredState as {
      restorableClassState?: { desiredState?: unknown };
    } | undefined;
    assert.equal(
      readClasspilotLateSignInDeliveryProvenance(
        expiredDesiredState?.restorableClassState?.desiredState
      )?.origin,
      "deferred"
    );
    await inSchool(school.id, () => endTeachingSession(teachingSession.id));
    await inSchool(school.id, () => deleteDevice(recoveryDeviceId));
    await inSchool(school.id, () => deleteDevice(replacementDeviceId));
    } finally {
      if (previousProtocol === undefined) delete process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
      else process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = previousProtocol;
      if (previousLateSignIn === undefined) {
        delete process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1;
      } else {
        process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = previousLateSignIn;
      }
      if (previousRollouts === undefined) delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
      else process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = previousRollouts;
    }
  });

  it("never represents transient timer or poll dispatch as active classroom state", async () => {
    const transientGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Transient_State_Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(school.id, () => addGroupStudentsDetailed(
      transientGroup.id,
      [studentDeviceGuard.id]
    ));
    const teachingSession = await inSchool(school.id, () => createTeachingSession({
      groupId: transientGroup.id,
      teacherId: teacher.id,
    }));
    await inSchool(school.id, () => upsertClasspilotClassroomStates([
      {
        schoolId: school.id,
        teachingSessionId: teachingSession.id,
        studentId: studentDeviceGuard.id,
        stateType: "timer",
        stateKey: "active",
        payload: { action: "start" },
        commandId: null,
        appliedBy: teacher.id,
      } as any,
      {
        schoolId: school.id,
        teachingSessionId: teachingSession.id,
        studentId: studentDeviceGuard.id,
        stateType: "poll",
        stateKey: "legacy-poll",
        payload: { action: "start" },
        commandId: null,
        appliedBy: teacher.id,
      } as any,
    ]));

    const target = {
      studentId: studentDeviceGuard.id,
      studentName: "Device Guard",
      studentSessionId: sessionGuard.id,
      deviceId: deviceGuard,
      available: true,
      stateAuthorized: true,
    };
    const timer = await inSchool(school.id, () => executeClasspilotCommand({
      schoolId: school.id,
      actorId: teacher.id,
      teachingSessionId: teachingSession.id,
      targetScope: "students",
      commandType: "timer",
      rawCommandPayload: { action: "start", durationSeconds: 120 },
      targets: [target],
    }));
    const poll = await inSchool(school.id, () => executeClasspilotCommand({
      schoolId: school.id,
      actorId: teacher.id,
      teachingSessionId: teachingSession.id,
      targetScope: "students",
      commandType: "poll",
      rawCommandPayload: {
        action: "start",
        question: "Transient delivery?",
        options: ["Yes", "No"],
      },
      targets: [target],
    }));

    assert.equal(timer.deliveryPolicy, "transient_action");
    assert.equal(poll.deliveryPolicy, "transient_action");
    assert.ok(timer.expiresAt);
    assert.ok(poll.expiresAt);
    assert.ok(poll.extra?.poll?.id);
    const pollPayload = poll.command.commandPayload as Record<string, unknown>;
    assert.equal(pollPayload.pollExpiresAt, pollPayload.expiresAt);
    assert.equal(
      pollPayload.pollExpiresAt,
      poll.extra?.poll?.expiresAt?.toISOString()
    );
    assert.ok(
      Date.parse(String(pollPayload.pollExpiresAt)) > Date.now() + 2 * 60 * 60 * 1000,
      "the authoritative poll lifecycle must outlive the old two-hour extension default"
    );
    await assert.rejects(
      () => inSchool(school.id, () => createPollResponseFirstWrite({
        schoolId: school.id,
        pollId: poll.extra.poll.id,
        studentId: studentDeviceGuard.id,
        studentSessionId: "replacement-session-not-targeted",
        deviceId: "replacement-device-not-targeted",
        selectedOption: 0,
      })),
      (error: any) => error?.code === "POLL_TARGET_NOT_AUTHORIZED"
    );
    const response = await inSchool(school.id, () => createPollResponseFirstWrite({
      schoolId: school.id,
      pollId: poll.extra.poll.id,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      deviceId: deviceGuard,
      selectedOption: 0,
    }));
    assert.equal(response.disposition, "created");
    await assert.rejects(
      () => inSchool(school.id, () => executeClasspilotCommand({
        schoolId: school.id,
        actorId: teacher.id,
        teachingSessionId: teachingSession.id,
        targetScope: "students",
        commandType: "poll",
        rawCommandPayload: {
          action: "start",
          question: "Second active poll?",
          options: ["Yes", "No"],
        },
        targets: [target],
      })),
      (error: any) => error?.status === 409 && error?.code === "POLL_ALREADY_ACTIVE"
    );
    const close = await inSchool(school.id, () => executeClasspilotCommand({
      schoolId: school.id,
      actorId: teacher.id,
      teachingSessionId: teachingSession.id,
      targetScope: "students",
      commandType: "poll",
      rawCommandPayload: { action: "close", pollId: poll.extra.poll.id },
      // Dashboard selection is intentionally empty here. Close must derive the
      // immutable target set from the original poll-start command.
      targets: [],
    }));
    assert.deepEqual(close.command.targets.map((row) => row.studentId), [studentDeviceGuard.id]);
    assert.equal(close.extra?.poll?.isActive, false, "the poll resource closes server-side");
    assert.equal(close.summary.completed, 0, "dispatch is not device completion");
    assert.equal(close.summary.pending, 1);
    assert.match(close.message, /Delivery attempted/);
    await inSchool(school.id, () => db.execute(sql`
      UPDATE classpilot_commands
      SET expires_at = ${new Date(Date.now() - 1_000)}
      WHERE id = ${close.command.id}
    `));
    await inSchool(school.id, () => expireClasspilotTransientCommandTargets({
      commandId: close.command.id,
      schoolId: school.id,
      now: new Date(),
    }));
    const expiredClose = await inSchool(school.id, () =>
      getClasspilotCommandByIdAndSchool(close.command.id, school.id)
    );
    assert.equal(expiredClose?.status, "expired");
    assert.equal(expiredClose?.completedCount, 0);
    const activeStates = await inSchool(school.id, () =>
      getActiveClasspilotClassroomStates(school.id, teachingSession.id)
    );
    assert.equal(
      activeStates.some((state) => state.stateType === "timer" || state.stateType === "poll"),
      false
    );

    await inSchool(school.id, () => endTeachingSession(teachingSession.id));
  });

  it("summarizes an empty command as unavailable", async () => {
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "lock-screen",
        commandPayload: {},
        requestedCount: 0,
        unavailableCount: 0,
      } as any,
      []
    ));

    await inSchool(school.id, () => updateClasspilotCommandSummary(created.id));
    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.status, "unavailable");
    assert.equal(loaded?.requestedCount, 0);
    assert.deepEqual(loaded?.targets, []);
  });

  it("serializes command snapshot revisions without holding the lock during publication", async () => {
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "lock-screen",
        commandPayload: {},
        requestedCount: 1,
        unavailableCount: 0,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: sessionGuard.id,
        deviceId: deviceGuard,
        status: "requested",
        errorMessage: null,
      } as any]
    ));
    await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "received",
    }));

    const publishedStatuses: string[] = [];
    const publishedRevisions: bigint[] = [];
    let snapshotCaptured!: () => void;
    const captured = new Promise<void>((resolve) => { snapshotCaptured = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondPublished!: () => void;
    const secondPublication = new Promise<void>((resolve) => { secondPublished = resolve; });

    const firstPublisher = inSchool(school.id, () => withClasspilotCommandBroadcastLock(
      created.id,
      school.id,
      async (command, revision) => {
        publishedStatuses.push(command.targets[0]!.status);
        publishedRevisions.push(BigInt(revision));
        snapshotCaptured();
        await release;
      }
    ));
    await captured;

    await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
    }));
    const secondPublisher = inSchool(school.id, () => withClasspilotCommandBroadcastLock(
      created.id,
      school.id,
      (command, revision) => {
        publishedStatuses.push(command.targets[0]!.status);
        publishedRevisions.push(BigInt(revision));
        secondPublished();
      }
    ));

    // Publication callbacks run after the advisory-lock transaction commits.
    // A slow Redis/local callback must not keep the next snapshot waiting on a
    // database connection or advisory lock.
    await secondPublication;
    releaseFirst();
    await Promise.all([firstPublisher, secondPublisher]);
    assert.deepEqual(publishedStatuses, ["received", "completed"]);
    assert.ok(publishedRevisions[1]! > publishedRevisions[0]!);
  });

  it("rejects command acknowledgements after a device starts a replacement student session", async () => {
    const originalSessionId = sessionGuard.id;
    const created = await inSchool(school.id, () => createClasspilotCommandWithTargets(
      {
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        teacherId: teacher.id,
        targetScope: "students",
        subgroupId: null,
        commandType: "lock-screen",
        commandPayload: {},
        requestedCount: 1,
        unavailableCount: 0,
      } as any,
      [{
        schoolId: school.id,
        teachingSessionId: null,
        supervisionContextId: null,
        commandId: "",
        studentId: studentDeviceGuard.id,
        studentSessionId: originalSessionId,
        deviceId: deviceGuard,
        status: "requested",
        errorMessage: null,
      } as any]
    ));

    sessionGuard = await inSchool(school.id, () =>
      setActiveStudentForDevice(deviceGuard, studentDeviceGuard.id)
    );
    const replacementAck = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: sessionGuard.id,
      ackState: "completed",
    }));
    const staleAck = await inSchool(school.id, () => updateClasspilotCommandTargetAck({
      commandId: created.id,
      schoolId: school.id,
      deviceId: deviceGuard,
      studentId: studentDeviceGuard.id,
      studentSessionId: originalSessionId,
      ackState: "completed",
    }));

    assert.equal(replacementAck, undefined);
    assert.equal(staleAck, undefined);
    const loaded = await inSchool(school.id, () => getClasspilotCommandByIdAndSchool(created.id, school.id));
    assert.equal(loaded?.targets[0]?.status, "requested");
  });

  it("skips an unchanged control-state upsert and still returns every requested student", async () => {
    const alpha = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Control",
      lastName: "NoopAlpha",
      email: `control-noop-alpha@${TAG}.example.edu`,
      emailLc: `control-noop-alpha@${TAG}.example.edu`,
      gradeLevel: "9",
      status: "active",
    }));
    const beta = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Control",
      lastName: "NoopBeta",
      email: `control-noop-beta@${TAG}.example.edu`,
      emailLc: `control-noop-beta@${TAG}.example.edu`,
      gradeLevel: "9",
      status: "active",
    }));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Control_Noop`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [alpha.id, beta.id]));
    const session = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    try {
      const [beforeAlpha, beforeBeta] = await inSchool(school.id, () => Promise.all([
        getClasspilotStudentControlState(school.id, alpha.id),
        getClasspilotStudentControlState(school.id, beta.id),
      ]));
      assert.ok(beforeAlpha);
      assert.ok(beforeBeta);

      const rows = await inSchool(school.id, () => replaceClasspilotStudentControlSnapshots({
        schoolId: school.id,
        teachingSessionId: session.id,
        studentIds: [alpha.id, beta.id],
        desiredState: { restrictions: {} },
        scheduledEndAt: beforeAlpha.scheduledEndAt,
        hardExpiresAt: beforeAlpha.hardExpiresAt ?? undefined,
        authorityMode: "filter",
      }));

      // A skipped conflict returns no row at all, so the caller must still be
      // handed the current snapshot for every requested student.
      for (const state of [beforeAlpha, beforeBeta]) {
        const returned = rows.find((row) => row.studentId === state.studentId);
        assert.ok(returned, "a skipped upsert must still return the current row");
        assert.equal(returned.revision, state.revision);
        assert.equal(returned.updatedAt.getTime(), state.updatedAt.getTime());
      }

      const [afterAlpha, afterBeta] = await inSchool(school.id, () => Promise.all([
        getClasspilotStudentControlState(school.id, alpha.id),
        getClasspilotStudentControlState(school.id, beta.id),
      ]));
      for (const [before, after] of [[beforeAlpha, afterAlpha], [beforeBeta, afterBeta]] as const) {
        assert.ok(after);
        assert.equal(after.revision, before.revision);
        assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
        assert.equal(after.enforcementHealth, before.enforcementHealth);
        assert.equal(after.appliedRevision, before.appliedRevision);
      }
    } finally {
      await inSchool(school.id, () => endTeachingSession(session.id)).catch(() => {});
    }
  });

  it("keeps an unchanged roster resync a no-op that preserves command provenance", async () => {
    const student = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Resync",
      lastName: "Noop",
      email: `resync-noop@${TAG}.example.edu`,
      emailLc: `resync-noop@${TAG}.example.edu`,
      gradeLevel: "9",
      status: "active",
    }));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Resync_Noop`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [student.id]));
    const session = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    try {
      const commandId = `${TAG}-resync-noop-command`;
      const persisted = await inSchool(school.id, () => persistClasspilotControlCommandState({
        studentSnapshots: {
          schoolId: school.id,
          teachingSessionId: session.id,
          studentIds: [student.id],
          sourceCommandId: commandId,
          desiredState: {
            restrictions: { locked: true, url: "https://example.edu/resync-noop" },
          },
        },
      }));
      assert.equal(persisted.studentControlStates.length, 1);
      const before = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, student.id)
      );
      assert.ok(before);
      assert.equal(before.sourceCommandId, commandId);

      const resynced = await inSchool(school.id, () => resyncActiveClasspilotSessionStudents({
        schoolId: school.id,
        teachingSessionId: session.id,
      }));
      assert.ok(resynced);
      assert.equal(resynced.summary.addedToSession, 0);

      const after = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, student.id)
      );
      assert.ok(after);
      assert.equal(after.revision, before.revision);
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
      // Provenance survives, so the next resync is a no-op as well.
      assert.equal(after.sourceCommandId, commandId);
      assert.deepEqual(after.desiredState, before.desiredState);
    } finally {
      await inSchool(school.id, () => endTeachingSession(session.id)).catch(() => {});
    }
  });

  it("bumps the revision when an identical command is re-issued", async () => {
    const student = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Forced",
      lastName: "Reissue",
      email: `forced-reissue@${TAG}.example.edu`,
      emailLc: `forced-reissue@${TAG}.example.edu`,
      gradeLevel: "9",
      status: "active",
    }));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Forced_Reissue`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [student.id]));
    const session = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    try {
      const commandId = `${TAG}-forced-reissue-command`;
      const desiredState = {
        restrictions: { locked: true, url: "https://example.edu/forced-reissue" },
      };
      const issue = () => inSchool(school.id, () => persistClasspilotControlCommandState({
        studentSnapshots: {
          schoolId: school.id,
          teachingSessionId: session.id,
          studentIds: [student.id],
          sourceCommandId: commandId,
          desiredState,
        },
      }));

      await issue();
      const before = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, student.id)
      );
      assert.ok(before);

      // Identical desired state and identical provenance: the re-issue must
      // still publish a revision so target reconciliation and the client
      // re-acknowledgement run.
      const reissued = await issue();
      assert.equal(reissued.studentControlStates[0]?.revision, before.revision + 1);
      const after = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, student.id)
      );
      assert.ok(after);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.sourceCommandId, commandId);
      assert.deepEqual(after.desiredState, before.desiredState);
    } finally {
      await inSchool(school.id, () => endTeachingSession(session.id)).catch(() => {});
    }
  });

  it("bumps the revision through supervision delegation and restore", async () => {
    const student = await inSchool(school.id, () => createStudent({
      schoolId: school.id,
      firstName: "Restore",
      lastName: "Authority",
      email: `restore-authority@${TAG}.example.edu`,
      emailLc: `restore-authority@${TAG}.example.edu`,
      gradeLevel: "9",
      status: "active",
    }));
    const group = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: teacher.id,
      name: `${TAG}_Restore_Authority`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(group.id, [student.id]));
    const session = await inSchool(school.id, () => createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
    }));
    let context: { id: string } | undefined;
    try {
      const inClass = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, student.id)
      );
      assert.ok(inClass);

      const claimed = await inSchool(school.id, () => createSupervisionContextWithStudents({
        context: {
          schoolId: school.id,
          contextType: "office",
          name: "Restore Authority Coverage",
          status: "active",
          assignedStaffId: coverageStaff.id,
          createdBy: admin.id,
          endsAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        studentIds: [student.id],
        assignedBy: admin.id,
        source: "admin_reroute",
      }));
      context = claimed;
      const delegated = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, student.id)
      );
      assert.ok(delegated);
      assert.equal(delegated.supervisionContextId, claimed.id);
      assert.equal(delegated.revision, inClass.revision + 1);

      await inSchool(school.id, () => releaseSupervisionStudents({
        schoolId: school.id,
        contextId: claimed.id,
        releaseReason: "test_release",
      }));
      const restored = await inSchool(school.id, () =>
        getClasspilotStudentControlState(school.id, student.id)
      );
      assert.ok(restored);
      assert.equal(restored.supervisionContextId, null);
      assert.equal(restored.teachingSessionId, session.id);
      assert.equal(restored.revision, delegated.revision + 1);
    } finally {
      if (context) {
        await inSchool(school.id, () => releaseSupervisionStudents({
          schoolId: school.id,
          contextId: context!.id,
          releaseReason: "test_cleanup",
        })).catch(() => {});
      }
      await inSchool(school.id, () => endTeachingSession(session.id)).catch(() => {});
    }
  });
});
