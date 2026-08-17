import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import { signUserToken } from "../dist/services/jwt.js";
import {
  addGroupStudentsDetailed,
  assignTeacherStudent,
  batchDismiss,
  batchRelease,
  callNextBatch,
  callQueueEntry,
  createFamilyGroupWithStudents,
  createCoverageScopeGroup,
  createGroup,
  createMembership,
  createProductLicense,
  createSchool,
  createStudent,
  createUser,
  deactivateStudentsForRoster,
  delayQueueEntry,
  dismissQueueEntry,
  getClasspilotSessionStudentRoster,
  getActiveHandsBySession,
  getActivePassesByClass,
  getActivePassesBySchool,
  getActivePassForStudent,
  getCoverageScopeGroupStudentIds,
  getGroupStudents,
  getOrCreateSession,
  getQueueBySession,
  getPassHistoryPage,
  getSessionStats,
  getStudentById,
  getStudentsByIds,
  getSubgroupMembers,
  holdQueueEntry,
  listCoverageScopeGroups,
  reactivateInactiveStudentForRosterImport,
  releaseQueueEntry,
  setActiveStudentForDevice,
  startStudentSession,
  transitionDismissalSessionStatus,
} from "../dist/services/storage.js";

const TAG = `student_lifecycle_${Date.now().toString(36)}_${process.pid}`;
const schoolAId = `${TAG}_school_a`;
const schoolBId = `${TAG}_school_b`;
const domainStem = TAG.replaceAll("_", "-");
const domainA = `${domainStem}-a.example.edu`;
const domainB = `${domainStem}-b.example.edu`;

let admin: any;
let schoolAdmin: any;
let teacher: any;
let office: any;
let server: Server;
let baseUrl: string;
let originalRedisUrl: string | undefined;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authFor(user: any, schoolId = schoolAId): Record<string, string> {
  const token = signUserToken({
    userId: user.id,
    email: user.email,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  });
  return {
    authorization: `Bearer ${token}`,
    "x-school-id": schoolId,
  };
}

async function requestJson(
  method: string,
  path: string,
  user: any,
  body?: unknown,
  schoolId = schoolAId
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...authFor(user, schoolId),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createLifecycleStudent(
  suffix: string,
  status: "active" | "inactive" = "active"
) {
  return inSchool(schoolAId, () => createStudent({
    schoolId: schoolAId,
    firstName: "Lifecycle",
    lastName: suffix,
    email: `${suffix.toLowerCase()}@${domainA}`,
    classpilotPinHash: `${TAG}-pin-hash-${suffix}`,
    classpilotPinEncrypted: `${TAG}-pin-cipher-${suffix}`,
    status,
  } as any));
}

before(async () => {
  originalRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "";
  mock.timers.enable({ apis: ["setInterval"] });

  await createSchool({
    id: schoolAId,
    name: `${TAG} School A`,
    domain: domainA,
    slug: `${TAG}-a`,
    status: "active",
  } as any);
  await createSchool({
    id: schoolBId,
    name: `${TAG} School B`,
    domain: domainB,
    slug: `${TAG}-b`,
    status: "active",
  } as any);
  await createProductLicense({ schoolId: schoolAId, product: "CLASSPILOT", status: "active" } as any);
  await createProductLicense({ schoolId: schoolBId, product: "CLASSPILOT", status: "active" } as any);

  admin = await createUser({
    id: `${TAG}_admin`,
    email: `admin@${domainA}`,
    firstName: "Admin",
    lastName: "User",
  } as any);
  schoolAdmin = await createUser({
    id: `${TAG}_school_admin`,
    email: `school-admin@${domainA}`,
    firstName: "School",
    lastName: "Admin",
  } as any);
  teacher = await createUser({
    id: `${TAG}_teacher`,
    email: `teacher@${domainA}`,
    firstName: "Teacher",
    lastName: "User",
  } as any);
  office = await createUser({
    id: `${TAG}_office`,
    email: `office@${domainA}`,
    firstName: "Office",
    lastName: "User",
  } as any);

  await inSchool(schoolAId, async () => {
    await createMembership({ userId: admin.id, schoolId: schoolAId, role: "admin", status: "active" } as any);
    await createMembership({ userId: schoolAdmin.id, schoolId: schoolAId, role: "school_admin", status: "active" } as any);
    await createMembership({ userId: teacher.id, schoolId: schoolAId, role: "teacher", status: "active" } as any);
    await createMembership({ userId: office.id, schoolId: schoolAId, role: "office_staff", status: "active" } as any);
  });

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  try {
    await asSystem(async () => {
      await db.execute(sql`DROP TRIGGER IF EXISTS ${sql.raw(`${TAG}_rollback_trigger`)} ON students`);
      await db.execute(sql`DROP FUNCTION IF EXISTS ${sql.raw(`${TAG}_rollback_guard`)}()`);
      await db.execute(sql`DELETE FROM mailpilot_watches WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id IN (${schoolAId}, ${schoolBId}))`);
      await db.execute(sql`DELETE FROM classpilot_active_hands WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM subgroup_members WHERE subgroup_id IN (SELECT id FROM subgroups WHERE school_id IN (${schoolAId}, ${schoolBId}))`);
      await db.execute(sql`DELETE FROM subgroups WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM classpilot_coverage_scope_group_members WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM classpilot_coverage_scope_groups WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM passes WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${schoolAId}, ${schoolBId}))`);
      await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${schoolAId}, ${schoolBId}))`);
      await db.execute(sql`DELETE FROM groups WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM family_group_students WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM family_groups WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM activity_log WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM dismissal_queue WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM dismissal_sessions WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM students WHERE school_id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${schoolAId}, ${schoolBId})`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${admin.id}, ${schoolAdmin.id}, ${teacher.id}, ${office.id})`);
    });
  } finally {
    await pool.end();
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    mock.timers.reset();
  }
});

describe("ClassPilot student roster removal lifecycle", () => {
  it("deactivates without deleting retained relationships, ends sessions, and audits exactly once", async () => {
    const student = await createLifecycleStudent("Retained");
    const group = await inSchool(schoolAId, () => createGroup({
      schoolId: schoolAId,
      teacherId: teacher.id,
      name: `${TAG} Active Class`,
      groupType: "admin_class",
      status: "active",
    } as any));
    await inSchool(schoolAId, () => addGroupStudentsDetailed(group.id, [student.id]));
    const family = await inSchool(schoolAId, () => createFamilyGroupWithStudents({
      schoolId: schoolAId,
      carNumber: `${TAG}-car`,
      familyName: `${TAG} Family`,
    } as any, [student.id]));
    const activeSession = await inSchool(schoolAId, () =>
      startStudentSession(schoolAId, student.id, `${TAG}-device-retained`)
    );
    const teachingSessionId = `${TAG}_teaching_session`;
    const subgroupId = `${TAG}_subgroup`;
    const coverageGroupId = `${TAG}_coverage_group`;
    const retainedPassId = `${TAG}_retained_pass`;
    await inSchool(schoolAId, async () => {
      await db.execute(sql`
        INSERT INTO teaching_sessions
          (id, group_id, teacher_id, school_id, session_mode, roster_snapshot_completed_at)
        VALUES
          (${teachingSessionId}, ${group.id}, ${teacher.id}, ${schoolAId}, 'live', now())
      `);
      await db.execute(sql`
        INSERT INTO classpilot_session_students
          (school_id, teaching_session_id, group_id, student_id, student_name_snapshot)
        VALUES
          (${schoolAId}, ${teachingSessionId}, ${group.id}, ${student.id}, 'Retained Student')
      `);
      await db.execute(sql`
        INSERT INTO subgroups (id, group_id, school_id, name)
        VALUES (${subgroupId}, ${group.id}, ${schoolAId}, 'Retained subgroup')
      `);
      await db.execute(sql`
        INSERT INTO subgroup_members (subgroup_id, student_id)
        VALUES (${subgroupId}, ${student.id})
      `);
      await db.execute(sql`
        INSERT INTO classpilot_coverage_scope_groups
          (id, school_id, name, created_by)
        VALUES
          (${coverageGroupId}, ${schoolAId}, 'Retained coverage', ${admin.id})
      `);
      await db.execute(sql`
        INSERT INTO classpilot_coverage_scope_group_members
          (school_id, coverage_group_id, student_id)
        VALUES
          (${schoolAId}, ${coverageGroupId}, ${student.id})
      `);
      await db.execute(sql`
        INSERT INTO classpilot_active_hands
          (school_id, teaching_session_id, student_id, device_id)
        VALUES
          (${schoolAId}, ${teachingSessionId}, ${student.id}, ${`${TAG}-device-hand`})
      `);
      await db.execute(sql`
        INSERT INTO passes
          (id, school_id, student_id, teacher_id, classpilot_group_id,
           class_name_snapshot, destination, status, expires_at)
        VALUES
          (${retainedPassId}, ${schoolAId}, ${student.id}, ${teacher.id}, ${group.id},
           'Retained class', 'bathroom', 'active', now() + interval '1 hour')
      `);
    });

    const actor = {
      userId: admin.id,
      userEmail: admin.email,
      userRole: "admin",
      source: "test.single",
    };
    const first = await inSchool(schoolAId, () =>
      deactivateStudentsForRoster(schoolAId, [student.id], actor)
    );
    assert.deepEqual(first.deactivatedStudentIds, [student.id]);
    assert.equal(first.endedSessionCount, 1);

    const state = await asSystem(async () => {
      const [studentRow, familyRows, groupRows, sessionRows, snapshotRows, audits] = await Promise.all([
        db.execute(sql`SELECT id, status FROM students WHERE id = ${student.id}`),
        db.execute(sql`SELECT student_id FROM family_group_students WHERE family_group_id = ${family.id}`),
        db.execute(sql`SELECT student_id FROM group_students WHERE group_id = ${group.id}`),
        db.execute(sql`SELECT id, is_active, ended_at FROM student_sessions WHERE id = ${activeSession.id}`),
        db.execute(sql`SELECT student_id FROM classpilot_session_students WHERE teaching_session_id = ${teachingSessionId}`),
        db.execute(sql`SELECT action, changes, metadata FROM audit_logs WHERE entity_id = ${student.id} ORDER BY created_at`),
      ]);
      return { studentRow, familyRows, groupRows, sessionRows, snapshotRows, audits };
    });
    assert.equal(state.studentRow.rows[0]?.status, "inactive");
    assert.equal(state.familyRows.rows.length, 1);
    assert.equal(state.groupRows.rows.length, 1);
    assert.equal(state.snapshotRows.rows.length, 1);
    assert.equal(state.sessionRows.rows[0]?.is_active, false);
    assert.ok(state.sessionRows.rows[0]?.ended_at);
    assert.equal(state.audits.rows.length, 1);
    assert.equal(state.audits.rows[0]?.action, "student.deactivated");
    assert.equal(JSON.stringify(state.audits.rows[0]).includes(student.email), false);

    assert.deepEqual(await inSchool(schoolAId, () => getGroupStudents(group.id)), []);
    assert.deepEqual(
      await inSchool(schoolAId, () => getClasspilotSessionStudentRoster(schoolAId, teachingSessionId)),
      []
    );
    assert.deepEqual(await inSchool(schoolAId, () => getSubgroupMembers(subgroupId)), []);
    assert.deepEqual(
      await inSchool(schoolAId, () => getCoverageScopeGroupStudentIds(schoolAId, coverageGroupId)),
      []
    );
    const coverageGroups = await inSchool(schoolAId, () => listCoverageScopeGroups(schoolAId));
    assert.deepEqual(
      coverageGroups.find((coverageGroup) => coverageGroup.id === coverageGroupId)?.members,
      []
    );
    assert.deepEqual(
      await inSchool(schoolAId, () => getActiveHandsBySession(schoolAId, teachingSessionId)),
      []
    );
    assert.deepEqual(
      await inSchool(schoolAId, () => getActivePassesBySchool(schoolAId)),
      []
    );
    assert.deepEqual(
      await inSchool(schoolAId, () => getActivePassesByClass(schoolAId, group.id)),
      []
    );
    assert.equal(
      await inSchool(schoolAId, () => getActivePassForStudent(student.id, schoolAId)),
      undefined
    );
    const retainedPassHistory = await inSchool(schoolAId, () =>
      getPassHistoryPage(schoolAId, { studentId: student.id })
    );
    assert.deepEqual(retainedPassHistory.passes.map((pass) => pass.id), [retainedPassId]);
    const retainedStudentIdentity = await inSchool(schoolAId, () =>
      getStudentsByIds([student.id])
    );
    assert.equal(retainedStudentIdentity[0]?.id, student.id);
    assert.equal(retainedStudentIdentity[0]?.firstName, student.firstName);
    const retainedOperationalRows = await asSystem(() => db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM subgroup_members WHERE subgroup_id = ${subgroupId}) AS subgroup_count,
        (SELECT count(*)::int FROM classpilot_coverage_scope_group_members WHERE coverage_group_id = ${coverageGroupId}) AS coverage_count,
        (SELECT count(*)::int FROM classpilot_active_hands WHERE teaching_session_id = ${teachingSessionId}) AS hand_count
    `));
    assert.deepEqual(retainedOperationalRows.rows[0], {
      subgroup_count: 1,
      coverage_count: 1,
      hand_count: 1,
    });
    await assert.rejects(
      inSchool(schoolAId, () => assignTeacherStudent(teacher.id, student.id)),
      (error: any) => error?.code === "STUDENT_INACTIVE"
    );
    await assert.rejects(
      inSchool(schoolAId, () => createCoverageScopeGroup({
        group: {
          schoolId: schoolAId,
          name: "Cannot assign removed student",
          createdBy: admin.id,
        },
        studentIds: [student.id],
      } as any)),
      (error: any) => error?.code === "STUDENT_INACTIVE"
    );

    const retry = await inSchool(schoolAId, () =>
      deactivateStudentsForRoster(schoolAId, [student.id], actor)
    );
    assert.equal(retry.deactivatedStudentIds.length, 0);
    const auditCountAfterRetry = await asSystem(() => db.execute(sql`
      SELECT count(*)::int AS count
      FROM audit_logs
      WHERE entity_id = ${student.id} AND action = 'student.deactivated'
    `));
    assert.equal(auditCountAfterRetry.rows[0]?.count, 1);

    await assert.rejects(
      inSchool(schoolAId, () =>
        startStudentSession(schoolAId, student.id, `${TAG}-device-inactive`)
      ),
      (error: any) => error?.code === "STUDENT_INACTIVE" && error?.status === 403
    );
    await assert.rejects(
      inSchool(schoolAId, () =>
        setActiveStudentForDevice(`${TAG}-device-switch-inactive`, student.id)
      ),
      (error: any) => error?.code === "STUDENT_INACTIVE" && error?.status === 403
    );
    const anomalousSession = await inSchool(schoolAId, () => db.execute(sql`
      INSERT INTO student_sessions (student_id, device_id, is_active)
      VALUES (${student.id}, ${`${TAG}-device-anomalous`}, true)
      RETURNING id
    `));

    const restored = await inSchool(schoolAId, () =>
      reactivateInactiveStudentForRosterImport(
        schoolAId,
        student.email!.toLowerCase(),
        { firstName: "Restored", email: student.email },
        { ...actor, source: "test.restore" }
      )
    );
    assert.equal(restored.reactivated, true);
    assert.equal(restored.student?.id, student.id);
    assert.equal(restored.student?.classpilotPinHash, student.classpilotPinHash);
    assert.equal(restored.student?.classpilotPinEncrypted, student.classpilotPinEncrypted);
    assert.equal((await inSchool(schoolAId, () => getGroupStudents(group.id))).length, 1);
    const anomalousAfterRestore = await asSystem(() => db.execute(sql`
      SELECT is_active, ended_at
      FROM student_sessions
      WHERE id = ${String(anomalousSession.rows[0]?.id)}
    `));
    assert.equal(anomalousAfterRestore.rows[0]?.is_active, false);
    assert.ok(anomalousAfterRestore.rows[0]?.ended_at);

    const activeRefresh = await inSchool(schoolAId, () =>
      reactivateInactiveStudentForRosterImport(
        schoolAId,
        student.email!.toLowerCase(),
        { lastName: "Refreshed", email: student.email },
        { ...actor, source: "test.refresh" }
      )
    );
    assert.equal(activeRefresh.reactivated, false);
    const restoreAuditCount = await asSystem(() => db.execute(sql`
      SELECT count(*)::int AS count
      FROM audit_logs
      WHERE entity_id = ${student.id} AND action = 'student.reactivated'
    `));
    assert.equal(restoreAuditCount.rows[0]?.count, 1);
  });

  it("rolls back an entire bulk transition on failure and cannot cross tenants", async () => {
    const first = await createLifecycleStudent("AtomicOne");
    const second = await createLifecycleStudent("AtomicTwo");
    const foreign = await inSchool(schoolBId, () => createStudent({
      schoolId: schoolBId,
      firstName: "Foreign",
      lastName: "Student",
      email: `foreign@${domainB}`,
      status: "active",
    } as any));
    const triggerName = `${TAG}_rollback_trigger`;
    const functionName = `${TAG}_rollback_guard`;

    await asSystem(async () => {
      await db.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $body$
        BEGIN
          IF NEW.id = '${second.id}' AND NEW.status = 'inactive' THEN
            RAISE EXCEPTION 'intentional student lifecycle rollback test';
          END IF;
          RETURN NEW;
        END;
        $body$ LANGUAGE plpgsql
      `));
      await db.execute(sql.raw(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON students
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()
      `));
    });

    try {
      await assert.rejects(
        inSchool(schoolAId, () => deactivateStudentsForRoster(
          schoolAId,
          [first.id, second.id],
          { userId: admin.id, userRole: "admin", source: "test.atomic" }
        ))
      );
    } finally {
      await asSystem(async () => {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${triggerName} ON students`));
        await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${functionName}()`));
      });
    }

    const statuses = await asSystem(() => db.execute(sql`
      SELECT id, status FROM students WHERE id IN (${first.id}, ${second.id}) ORDER BY id
    `));
    assert.deepEqual(statuses.rows.map((row: any) => row.status), ["active", "active"]);
    const audits = await asSystem(() => db.execute(sql`
      SELECT id FROM audit_logs
      WHERE entity_id IN (${first.id}, ${second.id}) AND action = 'student.deactivated'
    `));
    assert.equal(audits.rows.length, 0);

    const crossTenant = await inSchool(schoolAId, () => deactivateStudentsForRoster(
      schoolAId,
      [foreign.id],
      { userId: admin.id, userRole: "admin", source: "test.cross_tenant" }
    ));
    assert.deepEqual(crossTenant.foundStudentIds, []);
    assert.equal((await inSchool(schoolBId, () => getStudentById(foreign.id)))?.status, "active");
  });

  it("keeps retained inactive students out of every live GoPilot queue mutation and completion count", async () => {
    const inactiveStudent = await createLifecycleStudent("QueueInactive");
    const activeStudent = await createLifecycleStudent("QueueActive");
    const session = await inSchool(schoolAId, () =>
      getOrCreateSession(schoolAId, "2099-12-31")
    );
    const activated = await inSchool(schoolAId, () =>
      transitionDismissalSessionStatus({
        sessionId: session.id,
        schoolId: schoolAId,
        nextStatus: "active",
        actorId: admin.id,
      })
    );
    assert.equal(activated.outcome, "updated");
    const inactiveEntryResult = await inSchool(schoolAId, () => db.execute(sql`
      INSERT INTO dismissal_queue
        (school_id, session_id, student_id, status, position, check_in_method)
      VALUES
        (${schoolAId}, ${session.id}, ${inactiveStudent.id}, 'waiting', 1, 'staff_search')
      RETURNING id
    `));
    const activeEntryResult = await inSchool(schoolAId, () => db.execute(sql`
      INSERT INTO dismissal_queue
        (school_id, session_id, student_id, status, position, check_in_method)
      VALUES
        (${schoolAId}, ${session.id}, ${activeStudent.id}, 'waiting', 2, 'staff_search')
      RETURNING id
    `));
    const inactiveEntry = { id: String(inactiveEntryResult.rows[0]?.id) };
    const activeEntry = { id: String(activeEntryResult.rows[0]?.id) };
    await inSchool(schoolAId, () => deactivateStudentsForRoster(
      schoolAId,
      [inactiveStudent.id],
      { userId: admin.id, userRole: "admin", source: "test.queue" }
    ));

    assert.equal(
      await inSchool(schoolAId, () =>
        callQueueEntry(inactiveEntry.id, null, schoolAId, session.id)
      ),
      undefined
    );
    const called = await inSchool(schoolAId, () =>
      callNextBatch(session.id, 10, null, schoolAId)
    );
    assert.deepEqual(called.map((entry) => entry.id), [activeEntry.id]);

    await inSchool(schoolAId, () => db.execute(sql`
      UPDATE dismissal_queue SET status = 'called' WHERE id = ${inactiveEntry.id}
    `));
    assert.equal(
      await inSchool(schoolAId, () =>
        releaseQueueEntry(inactiveEntry.id, schoolAId, session.id)
      ),
      undefined
    );
    assert.equal(
      await inSchool(schoolAId, () =>
        holdQueueEntry(inactiveEntry.id, "retained", schoolAId, session.id)
      ),
      undefined
    );
    await inSchool(schoolAId, () => db.execute(sql`
      UPDATE dismissal_queue SET status = 'held' WHERE id = ${inactiveEntry.id}
    `));
    assert.equal(
      await inSchool(schoolAId, () =>
        delayQueueEntry(inactiveEntry.id, schoolAId, session.id)
      ),
      undefined
    );

    await inSchool(schoolAId, () => db.execute(sql`
      UPDATE dismissal_queue SET status = 'called' WHERE id = ${inactiveEntry.id}
    `));
    const released = await inSchool(schoolAId, () =>
      batchRelease([inactiveEntry.id, activeEntry.id], schoolAId, session.id)
    );
    assert.deepEqual(released.map((entry) => entry.id), [activeEntry.id]);
    await inSchool(schoolAId, () => db.execute(sql`
      UPDATE dismissal_queue SET status = 'released' WHERE id = ${inactiveEntry.id}
    `));
    const batchDismissed = await inSchool(schoolAId, () =>
      batchDismiss([inactiveEntry.id, activeEntry.id], schoolAId, session.id)
    );
    assert.equal(batchDismissed.entries.length, 0);
    const inactiveDismiss = await inSchool(schoolAId, () =>
      dismissQueueEntry(inactiveEntry.id, schoolAId, session.id, {
        custodyAcknowledged: true,
      })
    );
    assert.equal(inactiveDismiss.entry, undefined);
    const activeDismiss = await inSchool(schoolAId, () =>
      dismissQueueEntry(activeEntry.id, schoolAId, session.id, {
        custodyAcknowledged: true,
      })
    );
    assert.equal(activeDismiss.entry?.id, activeEntry.id);

    const liveQueue = await inSchool(schoolAId, () =>
      getQueueBySession(session.id, undefined, { activeStudentsOnly: true })
    );
    const retainedQueue = await inSchool(schoolAId, () => getQueueBySession(session.id));
    assert.deepEqual(liveQueue.map((entry) => entry.id), [activeEntry.id]);
    assert.equal(retainedQueue.length, 2);
    const liveStats = await inSchool(schoolAId, () =>
      getSessionStats(session.id, { activeStudentsOnly: true })
    );
    const historicalStats = await inSchool(schoolAId, () => getSessionStats(session.id));
    assert.equal(liveStats?.total, 1);
    assert.equal(historicalStats?.total, 2);

    const completed = await inSchool(schoolAId, () =>
      transitionDismissalSessionStatus({
        sessionId: session.id,
        schoolId: schoolAId,
        nextStatus: "completed",
        actorId: admin.id,
      })
    );
    assert.equal(completed.outcome, "updated");
  });

  it("enforces lifecycle roles and restores exact inactive emails through unified routes", async () => {
    const removable = await createLifecycleStudent("UnifiedDelete");
    assert.equal((await requestJson("DELETE", `/students/${removable.id}`, teacher)).status, 403);
    assert.equal((await requestJson("DELETE", `/students/${removable.id}`, office)).status, 403);
    const removed = await requestJson("DELETE", `/students/${removable.id}`, schoolAdmin);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { ok: true });
    assert.equal((await requestJson("DELETE", `/students/${removable.id}`, schoolAdmin)).status, 200);
    const genericInactiveQuery = await requestJson(
      "GET",
      "/students?status=inactive",
      teacher
    );
    assert.equal(genericInactiveQuery.status, 200);
    assert.equal(
      genericInactiveQuery.body.students.some((student: any) => student.id === removable.id),
      false
    );
    const classpilotInactiveQuery = await requestJson(
      "GET",
      "/classpilot/students?status=inactive",
      office
    );
    assert.equal(classpilotInactiveQuery.status, 200);
    assert.equal(
      classpilotInactiveQuery.body.students.some((student: any) => student.id === removable.id),
      false
    );

    const statusTarget = await createLifecycleStudent("StatusGuard");
    const teacherStatus = await requestJson(
      "PATCH",
      `/students/${statusTarget.id}`,
      teacher,
      { status: "inactive" }
    );
    assert.equal(teacherStatus.status, 400);
    assert.equal(teacherStatus.body.code, "STUDENT_STATUS_MANAGED_SEPARATELY");

    const restoreTarget = await createLifecycleStudent("UnifiedRestore", "inactive");
    const teacherRestore = await requestJson("POST", "/students", teacher, {
      firstName: "Teacher",
      lastName: "CannotRestore",
      email: restoreTarget.email,
    });
    assert.equal(teacherRestore.status, 409, JSON.stringify(teacherRestore.body));
    const restored = await requestJson("POST", "/students", schoolAdmin, {
      firstName: "IT",
      lastName: "Restored",
      email: restoreTarget.email,
    });
    assert.equal(restored.status, 201);
    assert.equal(restored.body.restored, true);
    assert.equal(restored.body.student.id, restoreTarget.id);
  });

  it("keeps the legacy ClassPilot aliases aligned and bulk removal atomic/compatible", async () => {
    const monitorDelete = await createLifecycleStudent("MonitorDelete");
    assert.equal(
      (await requestJson("DELETE", `/classpilot/students/${monitorDelete.id}`, teacher)).status,
      403
    );
    assert.equal(
      (await requestJson("DELETE", `/classpilot/students/${monitorDelete.id}`, schoolAdmin)).status,
      200
    );

    const monitorRestore = await createLifecycleStudent("MonitorRestore", "inactive");
    const restored = await requestJson("POST", "/classpilot/roster/student", schoolAdmin, {
      firstName: "Alias",
      lastName: "Restored",
      email: monitorRestore.email,
      gradeLevel: "8",
    });
    assert.equal(restored.status, 201);
    assert.equal(restored.body.restored, true);
    assert.equal(restored.body.student.id, monitorRestore.id);
    assert.deepEqual(restored.body.generatedPins, []);

    const monitorBulkRestore = await createLifecycleStudent("MonitorBulkRestore", "inactive");
    const bulkRestore = await requestJson("POST", "/classpilot/roster/bulk", schoolAdmin, {
      students: [{
        firstName: "Alias",
        lastName: "BulkRestored",
        email: monitorBulkRestore.email,
        gradeLevel: "7",
      }],
    });
    assert.equal(bulkRestore.status, 200);
    assert.equal(bulkRestore.body.created, 1);
    assert.equal(bulkRestore.body.restored, 1);
    assert.equal(bulkRestore.body.students[0].id, monitorBulkRestore.id);

    const bulkActive = await createLifecycleStudent("CompatBulkActive");
    const bulkInactive = await createLifecycleStudent("CompatBulkInactive", "inactive");
    assert.equal(
      (await requestJson("POST", "/admin/students/bulk-delete", office, {
        studentIds: [bulkActive.id],
      })).status,
      403
    );
    const bulk = await requestJson("POST", "/admin/students/bulk-delete", schoolAdmin, {
      studentIds: [bulkActive.id, bulkInactive.id, `${TAG}_missing`],
    });
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body, {
      deleted: 1,
      deactivated: 1,
      alreadyInactive: 1,
      failed: 1,
    });
  });
});
