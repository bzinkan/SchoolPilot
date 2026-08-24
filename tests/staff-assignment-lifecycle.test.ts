import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import { users, schools, schoolMemberships } from "../dist/schema/core.js";
import { auditLogs } from "../dist/schema/shared.js";
import {
  blockLists,
  groups,
  groupStudents,
  groupTeachers,
  classpilotCoverageAssignments,
  classpilotScheduledConflicts,
  classpilotScheduleChangePairs,
  classpilotScheduleChanges,
  classpilotScheduleChangeLegs,
  flightPaths,
  studentGroups,
} from "../dist/schema/classpilot.js";
import { homerooms, homeroomTeachers } from "../dist/schema/gopilot.js";
import {
  addGroupStudentsDetailed,
  archiveGroup,
  assignTeacherGrade,
  assignTeacherStudent,
  createBlockList,
  createCoverageAssignment,
  createFlightPath,
  createGrade,
  createGroup,
  createHomeroomWithPrimaryTeacher,
  createKioskSession,
  createMembership,
  createOrReuseScheduledReportSession,
  createProductLicense,
  createSchool,
  createSelfClaimedKioskSession,
  createSupervisionContextWithStudents,
  createStudent,
  createTeachingSession,
  createUser,
  claimScheduledCoverageStudents,
  deleteMembershipForSchool,
  deleteGroup,
  replaceGroupTeachers,
  claimKioskSessionByCode,
  createResumedKioskSession,
  extendSupervisionContext,
  releaseKioskSession,
  updateScheduledClassConflictStatus,
  updateMembershipForSchool,
  updateSchool,
  upsertAdminClassroomClass,
  upsertScheduledClassConflict,
  upsertScheduledClassConflictForOccurrence,
  upsertSettings,
  withTeachingSessionStartLock,
} from "../dist/services/storage.js";
import {
  createStaffIdentityRepairProof,
  getStaffAssignmentImpact,
  getStaffAssignmentIntegrityIssues,
  transitionStaffAssignments,
} from "../dist/services/staffAssignmentLifecycle.js";
import { lockStaffAssignmentLifecycleSchool } from "../dist/services/staffAssignmentLifecycleLock.js";
import { staffTransitionProductContextError } from "../dist/routes/staffAssignmentLifecycle.js";
import {
  assertStaffIdentityRepairExecutionAdmission,
  parseStaffIdentityRepairCliArgs,
  STAFF_IDENTITY_REPAIR_ACKNOWLEDGEMENT,
  STAFF_IDENTITY_REPAIR_PRODUCTION_ADMISSION,
  validateStaffIdentityRepairCliOptions,
} from "../dist/cli/repairClasspilotStaffIdentity.js";

const TAG = `staff_lifecycle_${Date.now()}`;
let school: Awaited<ReturnType<typeof createSchool>>;
let actor: Awaited<ReturnType<typeof createUser>>;
let source: Awaited<ReturnType<typeof createUser>>;
let replacement: Awaited<ReturnType<typeof createUser>>;
let coClassOwner: Awaited<ReturnType<typeof createUser>>;
let sourceMembership: Awaited<ReturnType<typeof createMembership>>;
let replacementMembership: Awaited<ReturnType<typeof createMembership>>;
let student: Awaited<ReturnType<typeof createStudent>>;

function inSchool<T>(schoolId: string, operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, operation);
}

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
}

before(async () => {
  await asSystem(async () => {
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1`);
  });
  school = await createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
  });
  await createProductLicense({
    schoolId: school.id,
    product: "CLASSPILOT",
    status: "active",
  });
  actor = await createUser({
    email: `admin@${TAG}.example.edu`,
    firstName: "Admin",
    lastName: "Actor",
  });
  source = await createUser({
    email: `source@${TAG}.example.edu`,
    firstName: "Source",
    lastName: "Teacher",
  });
  replacement = await createUser({
    email: `replacement@${TAG}.example.edu`,
    firstName: "Replacement",
    lastName: "Teacher",
  });
  coClassOwner = await createUser({
    email: `owner@${TAG}.example.edu`,
    firstName: "Class",
    lastName: "Owner",
  });
  await createMembership({ userId: actor.id, schoolId: school.id, role: "admin" });
  sourceMembership = await createMembership({
    userId: source.id,
    schoolId: school.id,
    role: "teacher",
  });
  replacementMembership = await createMembership({
    userId: replacement.id,
    schoolId: school.id,
    role: "teacher",
  });
  await createMembership({
    userId: coClassOwner.id,
    schoolId: school.id,
    role: "teacher",
  });
  student = await inSchool(school.id, () => createStudent({
    schoolId: school.id,
    firstName: "Roster",
    lastName: "Student",
    email: `student@${TAG}.example.edu`,
    gradeLevel: "8",
  }));
});

after(async () => {
  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM audit_logs WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM passpilot_kiosk_sessions WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM passpilot_kiosk_devices WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_coverage_assignments WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_scheduled_conflicts WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM teacher_students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM flight_paths WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM block_lists WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM student_groups WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM homeroom_teachers WHERE school_id = ${school.id}`);
      await db.execute(sql`UPDATE students SET homeroom_id = NULL WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM homerooms WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM teacher_grades WHERE grade_id IN (SELECT id FROM grades WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM grades WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_schedule_change_legs WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_schedule_changes WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM classpilot_schedule_change_pairs WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
      await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM settings WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
      await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
    });
  } catch {
    // Best-effort cleanup keeps the original test failure visible.
  }
  await pool.end();
});

describe("staff assignment lifecycle", () => {
  it("requires a central actor to transition a Super Admin membership", async () => {
    const central = await createUser({
      email: `transition-super@${TAG}.example.edu`,
      firstName: "Transition",
      lastName: "Central",
    });
    await asSystem(async () => {
      await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, central.id));
    });
    const membership = await createMembership({
      userId: central.id,
      schoolId: school.id,
      role: "admin",
      status: "active",
    });
    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, membership.id)
    );
    const before = await asSystem(async () => {
      const [row] = await db.select().from(users).where(eq(users.id, central.id)).limit(1);
      return row!;
    });

    await assert.rejects(
      () => inSchool(school.id, () => transitionStaffAssignments({
        schoolId: school.id,
        membershipId: membership.id,
        actorUserId: actor.id,
        actorRole: "admin",
        request: {
          expectedRevision: impact.revision,
          action: "deactivate",
          decisions: [],
        },
      })),
      (error: any) => error?.code === "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED"
    );
    const rejectedUser = await asSystem(async () => {
      const [row] = await db.select().from(users).where(eq(users.id, central.id)).limit(1);
      return row!;
    });
    assert.equal(rejectedUser.authVersion, before.authVersion);
    const [rejectedMembership] = await asSystem(async () =>
      db.select().from(schoolMemberships).where(eq(schoolMemberships.id, membership.id)).limit(1)
    );
    assert.equal(rejectedMembership?.status, "active");

    const transitioned = await inSchool(school.id, () => transitionStaffAssignments({
      schoolId: school.id,
      membershipId: membership.id,
      actorUserId: actor.id,
      actorRole: "super_admin",
      request: {
        expectedRevision: impact.revision,
        action: "deactivate",
        decisions: [],
      },
    }));
    assert.equal(transitioned.membership.status, "inactive");
    const centralUser = await asSystem(async () => {
      const [row] = await db.select().from(users).where(eq(users.id, central.id)).limit(1);
      return row!;
    });
    assert.equal(centralUser.authVersion, before.authVersion + 1);
  });

  it("keeps an ordinary multi-school membership transition school-scoped", async () => {
    const secondarySchool = await createSchool({
      name: `${TAG}_Secondary`,
      domain: `${TAG}.example.edu`,
      slug: `${TAG}-secondary`,
    });
    const shared = await createUser({
      email: `transition-multischool@${TAG}.example.edu`,
      firstName: "Transition",
      lastName: "Shared",
    });
    const localMembership = await createMembership({
      userId: shared.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    await createMembership({
      userId: shared.id,
      schoolId: secondarySchool.id,
      role: "teacher",
      status: "active",
    });
    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, localMembership.id, {
        action: "change_role",
        newRole: "admin",
      })
    );
    const transitioned = await inSchool(school.id, () => transitionStaffAssignments({
      schoolId: school.id,
      membershipId: localMembership.id,
      actorUserId: actor.id,
      actorRole: "admin",
      request: {
        expectedRevision: impact.revision,
        action: "change_role",
        newRole: "admin",
        decisions: [],
      },
    }));
    assert.equal(transitioned.membership.role, "admin");
    const [otherMembership] = await asSystem(async () =>
      db
        .select()
        .from(schoolMemberships)
        .where(
          and(
            eq(schoolMemberships.userId, shared.id),
            eq(schoolMemberships.schoolId, secondarySchool.id)
          )
        )
        .limit(1)
    );
    assert.equal(otherMembership?.role, "teacher");
    await asSystem(async () => {
      await db.delete(schoolMemberships).where(eq(schoolMemberships.schoolId, secondarySchool.id));
      await db.delete(schools).where(eq(schools.id, secondarySchool.id));
    });
  });

  it("locks and scans dormant ownership before restoring a deleted school", async () => {
    const restoreSchool = await createSchool({
      name: `${TAG}_RestoreSchool`,
      domain: `${TAG}-restore.example.edu`,
      slug: `${TAG}-restore`,
    });
    const restoreTeacher = await createUser({
      email: `restore-teacher@${TAG}-restore.example.edu`,
      firstName: "Restore",
      lastName: "Teacher",
    });
    const restoreMembership = await createMembership({
      userId: restoreTeacher.id,
      schoolId: restoreSchool.id,
      role: "teacher",
      status: "active",
    });
    await inSchool(restoreSchool.id, () => createBlockList({
      schoolId: restoreSchool.id,
      teacherId: restoreTeacher.id,
      name: `${TAG}_RestoreBlockList`,
      blockedDomains: ["example.invalid"],
    }));

    try {
      await asSystem(() => updateSchool(restoreSchool.id, { deletedAt: new Date() }));
      await asSystem(() => db
        .update(schoolMemberships)
        .set({ status: "inactive" })
        .where(eq(schoolMemberships.id, restoreMembership.id)));

      await assert.rejects(
        () => asSystem(() => updateSchool(restoreSchool.id, { deletedAt: null })),
        (error: any) => error?.code === "SCHOOL_STAFF_ASSIGNMENT_INTEGRITY_REQUIRED",
        "restore must fail before a deleted tenant's stale ownership becomes live",
      );
      const [stillDeleted] = await asSystem(() => db
        .select({ deletedAt: schools.deletedAt })
        .from(schools)
        .where(eq(schools.id, restoreSchool.id))
        .limit(1));
      assert.ok(stillDeleted?.deletedAt);
    } finally {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM block_lists WHERE school_id = ${restoreSchool.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${restoreSchool.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${restoreSchool.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${restoreTeacher.id}`);
      });
    }
  });

  it("blocks legacy deactivation and atomically transfers primary/co assignments without changing rosters", async () => {
    const primaryClass = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: source.id,
      name: `${TAG}_Primary`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => addGroupStudentsDetailed(primaryClass.id, [student.id]));

    const coClass = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: coClassOwner.id,
      name: `${TAG}_Co`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => replaceGroupTeachers(coClass.id, coClassOwner.id, [source.id]));

    const beforeUser = await asSystem(async () => {
      const [row] = await db.select().from(users).where(eq(users.id, source.id)).limit(1);
      return row!;
    });
    await assert.rejects(
      () => inSchool(school.id, () => deleteMembershipForSchool(sourceMembership.id, school.id)),
      (error: any) => error?.code === "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT"
    );

    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, sourceMembership.id)
    );
    assert.deepEqual(
      new Set(impact.assignments.map((assignment) => assignment.assignmentType)),
      new Set(["class_primary", "class_co_teacher"])
    );
    assert.equal(impact.blockers.length, 0);

    const result = await inSchool(school.id, () =>
      transitionStaffAssignments({
        schoolId: school.id,
        membershipId: sourceMembership.id,
        actorUserId: actor.id,
        actorRole: "admin",
        classStateInvariant: {
          classIds: [primaryClass.id, coClass.id],
          expected: {
            classCount: 2,
            rosterMembershipCount: 1,
            teachingSessionCount: 0,
          },
        },
        request: {
          expectedRevision: impact.revision,
          action: "deactivate",
          decisions: impact.assignments.map((assignment) => ({
            assignmentType: assignment.assignmentType,
            assignmentId: assignment.assignmentId,
            operation: assignment.assignmentType === "class_primary" ? "replace" : "remove",
            ...(assignment.assignmentType === "class_primary"
              ? { replacementMembershipId: replacementMembership.id }
              : {}),
          })),
        },
      })
    );

    assert.equal(result.membership.status, "inactive");
    assert.equal(result.transferred.length, 2);
    assert.deepEqual(result.preservation, {
      before: {
        classCount: 2,
        rosterMembershipCount: 1,
        teachingSessionCount: 0,
      },
      after: {
        classCount: 2,
        rosterMembershipCount: 1,
        teachingSessionCount: 0,
      },
      unchanged: true,
    });
    const [savedPrimary] = await inSchool(school.id, () =>
      db.select().from(groups).where(eq(groups.id, primaryClass.id)).limit(1)
    );
    assert.equal(savedPrimary?.teacherId, replacement.id);
    const primaryMirrors = await inSchool(school.id, () =>
      db.select().from(groupTeachers).where(eq(groupTeachers.groupId, primaryClass.id))
    );
    assert.deepEqual(
      primaryMirrors.map((row) => [row.teacherId, row.role]),
      [[replacement.id, "primary"]]
    );
    const sourceCoRows = await inSchool(school.id, () =>
      db
        .select()
        .from(groupTeachers)
        .where(and(eq(groupTeachers.groupId, coClass.id), eq(groupTeachers.teacherId, source.id)))
    );
    assert.equal(sourceCoRows.length, 0);
    const roster = await inSchool(school.id, () =>
      db.select().from(groupStudents).where(eq(groupStudents.groupId, primaryClass.id))
    );
    assert.deepEqual(roster.map((row) => row.studentId), [student.id]);

    const [savedUser] = await asSystem(() =>
      db.select().from(users).where(eq(users.id, source.id)).limit(1)
    );
    assert.equal(savedUser!.authVersion, beforeUser.authVersion + 1);
    const [savedMembership] = await asSystem(() =>
      db.select().from(schoolMemberships).where(eq(schoolMemberships.id, sourceMembership.id)).limit(1)
    );
    assert.equal(savedMembership?.status, "inactive");
    const auditRows = await inSchool(school.id, () =>
      db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.schoolId, school.id),
            eq(auditLogs.action, "school.staff.transitioned"),
            eq(auditLogs.entityId, sourceMembership.id)
          )
        )
    );
    assert.equal(auditRows.length, 1);
  });

  it("reports stale active ownership and primary-mirror mismatches as ID-only integrity findings", async () => {
    const stale = await createUser({
      email: `stale@${TAG}.example.edu`,
      firstName: "Stale",
      lastName: "Identity",
    });
    const staleMembership = await createMembership({
      userId: stale.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const staleGroup = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: stale.id,
      name: `${TAG}_Stale`,
      groupType: "admin_class",
      status: "active",
    }));
    await asSystem(async () => {
      await db
        .update(schoolMemberships)
        .set({ status: "inactive" })
        .where(eq(schoolMemberships.id, staleMembership.id));
      await db
        .delete(groupTeachers)
        .where(eq(groupTeachers.groupId, staleGroup.id));
    });

    const integrity = await inSchool(school.id, () =>
      getStaffAssignmentIntegrityIssues(school.id)
    );
    assert.ok(integrity.invalidPrimaryAssignments.some((row) => row.groupId === staleGroup.id));
    assert.ok(integrity.primaryMirrorMismatches.some((row) => row.groupId === staleGroup.id));
    assert.ok(integrity.total >= 2);
  });

  it("does not transfer user-owned classes while another active teachable membership remains", async () => {
    const multiRoleUser = await createUser({
      email: `multi-role@${TAG}.example.edu`,
      firstName: "Multi",
      lastName: "Role",
    });
    const teacherMembership = await createMembership({
      userId: multiRoleUser.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    await createMembership({
      userId: multiRoleUser.id,
      schoolId: school.id,
      role: "admin",
      status: "active",
    });
    const ownedClass = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: multiRoleUser.id,
      name: `${TAG}_MultiRole`,
      groupType: "admin_class",
      status: "active",
    }));

    const removed = await inSchool(school.id, () =>
      deleteMembershipForSchool(teacherMembership.id, school.id)
    );
    assert.equal(removed, true);
    const [savedClass] = await inSchool(school.id, () =>
      db.select().from(groups).where(eq(groups.id, ownedClass.id)).limit(1)
    );
    assert.equal(savedClass?.teacherId, multiRoleUser.id);
  });

  it("treats an office-staff deactivation as a departure and requires live coverage decisions", async () => {
    const officeUser = await createUser({
      email: `office@${TAG}.example.edu`,
      firstName: "Office",
      lastName: "Staff",
    });
    const officeMembership = await createMembership({
      userId: officeUser.id,
      schoolId: school.id,
      role: "office_staff",
      status: "active",
    });
    await inSchool(school.id, () =>
      db.insert(classpilotCoverageAssignments).values({
        schoolId: school.id,
        staffId: officeUser.id,
        scopeType: "school",
        permissions: {},
        active: true,
        createdBy: actor.id,
      })
    );
    await assert.rejects(
      () => inSchool(school.id, () => deleteMembershipForSchool(officeMembership.id, school.id)),
      (error: any) => error?.code === "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT"
    );
    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, officeMembership.id)
    );
    assert.deepEqual(impact.assignments.map((row) => row.assignmentType), ["coverage_assignment"]);
    const transitioned = await inSchool(school.id, () =>
      transitionStaffAssignments({
        schoolId: school.id,
        membershipId: officeMembership.id,
        actorUserId: actor.id,
        actorRole: "admin",
        request: {
          expectedRevision: impact.revision,
          action: "deactivate",
          decisions: impact.assignments.map((assignment) => ({
            assignmentType: assignment.assignmentType,
            assignmentId: assignment.assignmentId,
            operation: "remove",
          })),
        },
      })
    );
    assert.equal(transitioned.membership.status, "inactive");
    const [coverage] = await inSchool(school.id, () =>
      db
        .select()
        .from(classpilotCoverageAssignments)
        .where(eq(classpilotCoverageAssignments.staffId, officeUser.id))
        .limit(1)
    );
    assert.equal(coverage?.active, false);
  });

  it("rejects assigning two overlapping incoming classes to the same replacement", async () => {
    const overlapSource = await createUser({
      email: `overlap-source@${TAG}.example.edu`,
      firstName: "Overlap",
      lastName: "Source",
    });
    const overlapTarget = await createUser({
      email: `overlap-target@${TAG}.example.edu`,
      firstName: "Overlap",
      lastName: "Target",
    });
    const overlapSourceMembership = await createMembership({
      userId: overlapSource.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const overlapTargetMembership = await createMembership({
      userId: overlapTarget.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const first = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: overlapSource.id,
      name: `${TAG}_OverlapA`,
      groupType: "admin_class",
      status: "active",
    }));
    const second = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: overlapSource.id,
      name: `${TAG}_OverlapB`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, async () => {
      await db
        .update(groups)
        .set({ scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "10:00" })
        .where(eq(groups.id, first.id));
      await db
        .update(groups)
        .set({ scheduleEnabled: true, blockStartTime: "09:30", blockEndTime: "10:30" })
        .where(eq(groups.id, second.id));
    });
    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, overlapSourceMembership.id)
    );
    await assert.rejects(
      () => inSchool(school.id, () =>
        transitionStaffAssignments({
          schoolId: school.id,
          membershipId: overlapSourceMembership.id,
          actorUserId: actor.id,
          actorRole: "admin",
          request: {
            expectedRevision: impact.revision,
            action: "deactivate",
            decisions: impact.assignments.map((assignment) => ({
              assignmentType: assignment.assignmentType,
              assignmentId: assignment.assignmentId,
              operation: "replace",
              replacementMembershipId: overlapTargetMembership.id,
            })),
          },
        })
      ),
      (error: any) =>
        error?.code === "STAFF_REPLACEMENT_INVALID" &&
        /overlapping transitioned classes/i.test(error?.message)
    );
  });

  it("includes active schedule workflows for class relationships and snapshot owners as blockers", async () => {
    const scheduleSource = await createUser({
      email: `schedule-co@${TAG}.example.edu`,
      firstName: "Schedule",
      lastName: "CoTeacher",
    });
    const scheduleMembership = await createMembership({
      userId: scheduleSource.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const scheduleSnapshotOwner = await createUser({
      email: `schedule-snapshot@${TAG}.example.edu`,
      firstName: "Schedule",
      lastName: "Snapshot",
    });
    const scheduleSnapshotMembership = await createMembership({
      userId: scheduleSnapshotOwner.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const classA = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: coClassOwner.id,
      name: `${TAG}_ScheduleA`,
      groupType: "admin_class",
      status: "active",
    }));
    const classB = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: replacement.id,
      name: `${TAG}_ScheduleB`,
      groupType: "admin_class",
      status: "active",
    }));
    await inSchool(school.id, () => replaceGroupTeachers(classA.id, coClassOwner.id, [scheduleSource.id]));
    const [firstGroupId, secondGroupId] = [classA.id, classB.id].sort();
    await inSchool(school.id, () => db.transaction(async (tx) => {
      const [pair] = await tx
        .insert(classpilotScheduleChangePairs)
        .values({
          schoolId: school.id,
          firstGroupId: firstGroupId!,
          secondGroupId: secondGroupId!,
          status: "active",
          createdBy: actor.id,
        })
        .returning();
      const [change] = await tx
        .insert(classpilotScheduleChanges)
        .values({
          schoolId: school.id,
          pairId: pair!.id,
          scheduledDate: "2099-01-15",
          timezoneSnapshot: "America/New_York",
          status: "pending_admin",
          reason: "Test schedule blocker",
          requestedByUserId: actor.id,
          requesterGroupId: classA.id,
          counterpartTeacherId: replacement.id,
          requestedByRole: "admin",
          requiresAdminApproval: true,
          reservationActive: true,
        })
        .returning();
      await tx.insert(classpilotScheduleChangeLegs).values([
        {
          schoolId: school.id,
          scheduleChangeId: change!.id,
          scheduledDate: "2099-01-15",
          legOrder: 1,
          groupId: classA.id,
          primaryTeacherIdSnapshot: scheduleSnapshotOwner.id,
          classNameSnapshot: "Schedule A",
          originalStartTime: "09:00",
          originalEndTime: "10:00",
          effectiveStartTime: "10:00",
          effectiveEndTime: "11:00",
          reservationActive: true,
        },
        {
          schoolId: school.id,
          scheduleChangeId: change!.id,
          scheduledDate: "2099-01-15",
          legOrder: 2,
          groupId: classB.id,
          primaryTeacherIdSnapshot: replacement.id,
          classNameSnapshot: "Schedule B",
          originalStartTime: "10:00",
          originalEndTime: "11:00",
          effectiveStartTime: "09:00",
          effectiveEndTime: "10:00",
          reservationActive: true,
        },
      ]);
    })).catch((error: any) => {
      throw error?.cause ?? error;
    });
    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, scheduleMembership.id)
    );
    assert.ok(impact.blockers.some((blocker) => blocker.blockerType === "active_schedule_change"));
    const snapshotImpact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, scheduleSnapshotMembership.id)
    );
    assert.ok(
      snapshotImpact.blockers.some((blocker) => blocker.blockerType === "active_schedule_change"),
      "an active reserved teacher snapshot must be visible even without a current class relationship"
    );
  });

  it("does not disturb ClassPilot schedule changes for a GoPilot-only role loss", async () => {
    const scheduleOwner = await createUser({
      email: `schedule-gopilot-only@${TAG}.example.edu`,
      firstName: "Schedule",
      lastName: "GoPilotOnly",
    });
    const scheduleOwnerMembership = await createMembership({
      userId: scheduleOwner.id,
      schoolId: school.id,
      role: "teacher",
      gopilotRole: "teacher",
      status: "active",
    });
    const classA = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: scheduleOwner.id,
      name: `${TAG}_GoPilotOnlyScheduleA`,
      groupType: "admin_class",
      status: "active",
    }));
    const classB = await inSchool(school.id, () => createGroup({
      schoolId: school.id,
      teacherId: replacement.id,
      name: `${TAG}_GoPilotOnlyScheduleB`,
      groupType: "admin_class",
      status: "active",
    }));
    const change = await inSchool(school.id, () => db.transaction(async (tx) => {
      const [firstGroupId, secondGroupId] = [classA.id, classB.id].sort();
      const [pair] = await tx
        .insert(classpilotScheduleChangePairs)
        .values({
          schoolId: school.id,
          firstGroupId: firstGroupId!,
          secondGroupId: secondGroupId!,
          status: "active",
          createdBy: actor.id,
        })
        .returning();
      const [saved] = await tx
        .insert(classpilotScheduleChanges)
        .values({
          schoolId: school.id,
          pairId: pair!.id,
          scheduledDate: "2099-01-16",
          timezoneSnapshot: "America/New_York",
          status: "pending_admin",
          reason: "GoPilot-only membership regression",
          requestedByUserId: actor.id,
          requesterGroupId: classA.id,
          counterpartTeacherId: replacement.id,
          requestedByRole: "admin",
          requiresAdminApproval: true,
          reservationActive: true,
        })
        .returning();
      await tx.insert(classpilotScheduleChangeLegs).values([
        {
          schoolId: school.id,
          scheduleChangeId: saved!.id,
          scheduledDate: "2099-01-16",
          legOrder: 1,
          groupId: classA.id,
          primaryTeacherIdSnapshot: scheduleOwner.id,
          classNameSnapshot: classA.name,
          originalStartTime: "09:00",
          originalEndTime: "10:00",
          effectiveStartTime: "10:00",
          effectiveEndTime: "11:00",
          reservationActive: true,
        },
        {
          schoolId: school.id,
          scheduleChangeId: saved!.id,
          scheduledDate: "2099-01-16",
          legOrder: 2,
          groupId: classB.id,
          primaryTeacherIdSnapshot: replacement.id,
          classNameSnapshot: classB.name,
          originalStartTime: "10:00",
          originalEndTime: "11:00",
          effectiveStartTime: "09:00",
          effectiveEndTime: "10:00",
          reservationActive: true,
        },
      ]);
      return saved!;
    }));

    const updated = await inSchool(school.id, () =>
      updateMembershipForSchool(
        scheduleOwnerMembership.id,
        school.id,
        { gopilotRole: "office_staff" }
      )
    );
    assert.equal(updated?.role, "teacher");
    assert.equal(updated?.gopilotRole, "office_staff");
    const [unchanged] = await inSchool(school.id, () =>
      db
        .select({ status: classpilotScheduleChanges.status, reservationActive: classpilotScheduleChanges.reservationActive })
        .from(classpilotScheduleChanges)
        .where(eq(classpilotScheduleChanges.id, change.id))
        .limit(1)
    );
    assert.deepEqual(unchanged, { status: "pending_admin", reservationActive: true });
  });

  it("uses the effective GoPilot role for preview, legacy guards, and homeroom transfer", async () => {
    const gopilotSource = await createUser({
      email: `gopilot-source@${TAG}.example.edu`,
      firstName: "GoPilot",
      lastName: "Source",
    });
    const gopilotTarget = await createUser({
      email: `gopilot-target@${TAG}.example.edu`,
      firstName: "GoPilot",
      lastName: "Target",
    });
    const gopilotSourceMembership = await createMembership({
      userId: gopilotSource.id,
      schoolId: school.id,
      role: "parent",
      gopilotRole: "teacher",
      status: "active",
    });
    const gopilotTargetMembership = await createMembership({
      userId: gopilotTarget.id,
      schoolId: school.id,
      role: "parent",
      gopilotRole: "teacher",
      status: "active",
    });
    const homeroom = await inSchool(school.id, () =>
      createHomeroomWithPrimaryTeacher({
        schoolId: school.id,
        teacherId: gopilotSource.id,
        name: `${TAG}_Homeroom`,
        grade: "8",
      })
    );

    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, gopilotSourceMembership.id, {
        action: "change_role",
        newGopilotRole: "office_staff",
      })
    );
    assert.deepEqual(
      impact.assignments.map((assignment) => assignment.assignmentType),
      ["gopilot_homeroom_primary"]
    );
    const deactivateImpact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, gopilotSourceMembership.id, {
        action: "deactivate",
      })
    );
    assert.deepEqual(
      deactivateImpact.assignments.map((assignment) => assignment.assignmentType),
      impact.assignments.map((assignment) => assignment.assignmentType)
    );
    assert.notEqual(deactivateImpact.revision, impact.revision);
    assert.deepEqual(impact.target, {
      action: "change_role",
      newRole: "parent",
      newGopilotRole: "office_staff",
    });
    await assert.rejects(
      () => inSchool(school.id, () =>
        updateMembershipForSchool(
          gopilotSourceMembership.id,
          school.id,
          { gopilotRole: "office_staff" }
        )
      ),
      (error: any) => error?.code === "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT"
    );

    const transitioned = await inSchool(school.id, () =>
      transitionStaffAssignments({
        schoolId: school.id,
        membershipId: gopilotSourceMembership.id,
        actorUserId: actor.id,
        actorRole: "admin",
        request: {
          expectedRevision: impact.revision,
          action: "change_role",
          newGopilotRole: "office_staff",
          decisions: impact.assignments.map((assignment) => ({
            assignmentType: assignment.assignmentType,
            assignmentId: assignment.assignmentId,
            operation: "replace",
            replacementMembershipId: gopilotTargetMembership.id,
          })),
        },
      })
    );
    assert.equal(transitioned.membership.role, "parent");
    assert.equal(transitioned.membership.gopilotRole, "office_staff");
    const [savedHomeroom] = await inSchool(school.id, () =>
      db.select().from(homerooms).where(eq(homerooms.id, homeroom.id)).limit(1)
    );
    assert.equal(savedHomeroom?.teacherId, gopilotTarget.id);
    const mirrors = await inSchool(school.id, () =>
      db.select().from(homeroomTeachers).where(eq(homeroomTeachers.homeroomId, homeroom.id))
    );
    assert.deepEqual(
      mirrors.map((row) => [row.teacherId, row.role]),
      [[gopilotTarget.id, "primary"]]
    );
  });

  it("keeps active scheduled conflicts in a base-role downgrade review", async () => {
    const conflictOwner = await createUser({
      email: `conflict-owner@${TAG}.example.edu`,
      firstName: "Conflict",
      lastName: "Owner",
    });
    const conflictMembership = await createMembership({
      userId: conflictOwner.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const conflictClass = await inSchool(school.id, () =>
      createGroup({
        schoolId: school.id,
        teacherId: conflictOwner.id,
        name: `${TAG}_ConflictClass`,
        groupType: "admin_class",
        status: "active",
      })
    );
    const [conflict] = await inSchool(school.id, () =>
      db
        .insert(classpilotScheduledConflicts)
        .values({
          schoolId: school.id,
          groupId: conflictClass.id,
          teacherId: conflictOwner.id,
          scheduledDate: "2099-02-01",
          blockStartTime: "10:00",
          blockEndTime: "10:45",
          status: "coverage_needed",
        })
        .returning()
    );
    await assert.rejects(
      () => inSchool(school.id, () => deleteGroup(conflictClass.id)),
      (error: any) => error?.code === "CLASS_HAS_ACTIVE_SCHEDULED_CONFLICT",
      "hard deletion must preserve an active scheduled-conflict parent",
    );
    const impact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, conflictMembership.id, {
        action: "change_role",
        newRole: "office_staff",
      })
    );
    assert.ok(
      impact.blockers.some(
        (blocker) =>
          blocker.blockerType === "active_scheduled_conflict" &&
          blocker.blockerId === conflict!.id
        )
    );
    await assert.rejects(
      () => inSchool(school.id, () =>
        transitionStaffAssignments({
          schoolId: school.id,
          membershipId: conflictMembership.id,
          actorUserId: actor.id,
          actorRole: "admin",
          request: {
            expectedRevision: impact.revision,
            action: "change_role",
            newRole: "office_staff",
            decisions: impact.assignments.map((assignment) => ({
              assignmentType: assignment.assignmentType,
              assignmentId: assignment.assignmentId,
              operation: assignment.required ? "replace" : "remove",
              ...(assignment.required
                ? { replacementMembershipId: replacementMembership.id }
                : {}),
            })),
          },
        })
      ),
      (error: any) => error?.code === "STAFF_TRANSITION_BLOCKED"
    );
  });

  it("enforces teacher-created class ownership and inventories every live assignment type", async () => {
    const staleOwner = await createUser({
      email: `inventory-owner@${TAG}.example.edu`,
      firstName: "Inventory",
      lastName: "Owner",
    });
    const staleMembership = await createMembership({
      userId: staleOwner.id,
      schoolId: school.id,
      role: "teacher",
      gopilotRole: "teacher",
      status: "active",
    });
    const teacherCreated = await inSchool(school.id, () =>
      createGroup({
        schoolId: school.id,
        teacherId: staleOwner.id,
        name: `${TAG}_TeacherCreated`,
        groupType: "teacher_created",
        status: "active",
      })
    );
    const classMirrors = await inSchool(school.id, () =>
      db.select().from(groupTeachers).where(eq(groupTeachers.groupId, teacherCreated.id))
    );
    assert.deepEqual(
      classMirrors.map((row) => [row.teacherId, row.role]),
      [[staleOwner.id, "primary"]]
    );

    const grade = await inSchool(school.id, () =>
      createGrade({ schoolId: school.id, name: `${TAG}_LegacyGrade` })
    );
    await inSchool(school.id, () => assignTeacherGrade(staleOwner.id, grade.id));
    await inSchool(school.id, () =>
      createHomeroomWithPrimaryTeacher({
        schoolId: school.id,
        teacherId: staleOwner.id,
        name: `${TAG}_InventoryHomeroom`,
        grade: "7",
      })
    );
    await inSchool(school.id, () =>
      createCoverageAssignment({
        schoolId: school.id,
        staffId: staleOwner.id,
        scopeType: "school",
        permissions: {},
        active: true,
        createdBy: actor.id,
      })
    );
    await inSchool(school.id, () => assignTeacherStudent(staleOwner.id, student.id));
    await inSchool(school.id, () =>
      createFlightPath({
        schoolId: school.id,
        teacherId: staleOwner.id,
        flightPathName: `${TAG}_FlightPath`,
      })
    );
    await inSchool(school.id, () =>
      createBlockList({
        schoolId: school.id,
        teacherId: staleOwner.id,
        name: `${TAG}_BlockList`,
      })
    );
    await inSchool(school.id, () =>
      db.insert(studentGroups).values({
        schoolId: school.id,
        teacherId: staleOwner.id,
        groupName: `${TAG}_StudentGroup`,
      })
    );
    await inSchool(school.id, () =>
      upsertSettings(school.id, { centralEmailRecipientUserId: staleOwner.id })
    );
    const scheduleIntegrityPeer = await inSchool(school.id, () =>
      createGroup({
        schoolId: school.id,
        teacherId: replacement.id,
        name: `${TAG}_InventorySchedulePeer`,
        groupType: "admin_class",
        status: "active",
      })
    );
    const invalidScheduleLeg = await inSchool(school.id, () => db.transaction(async (tx) => {
      const [firstGroupId, secondGroupId] = [teacherCreated.id, scheduleIntegrityPeer.id].sort();
      const [pair] = await tx
        .insert(classpilotScheduleChangePairs)
        .values({
          schoolId: school.id,
          firstGroupId: firstGroupId!,
          secondGroupId: secondGroupId!,
          status: "active",
          createdBy: actor.id,
        })
        .returning();
      const [change] = await tx
        .insert(classpilotScheduleChanges)
        .values({
          schoolId: school.id,
          pairId: pair!.id,
          scheduledDate: "2099-02-20",
          timezoneSnapshot: "America/New_York",
          status: "approved",
          reason: "Integrity inventory fixture",
          requestedByUserId: actor.id,
          requestedByRole: "admin",
          requiresAdminApproval: false,
          approvedByUserId: actor.id,
          approvedAt: new Date(),
          reservationActive: true,
        })
        .returning();
      const [staleLeg] = await tx
        .insert(classpilotScheduleChangeLegs)
        .values({
          schoolId: school.id,
          scheduleChangeId: change!.id,
          scheduledDate: "2099-02-20",
          legOrder: 1,
          groupId: teacherCreated.id,
          primaryTeacherIdSnapshot: staleOwner.id,
          classNameSnapshot: teacherCreated.name,
          originalStartTime: "09:00",
          originalEndTime: "10:00",
          effectiveStartTime: "10:00",
          effectiveEndTime: "11:00",
          reservationActive: true,
        })
        .returning();
      await tx.insert(classpilotScheduleChangeLegs).values({
        schoolId: school.id,
        scheduleChangeId: change!.id,
        scheduledDate: "2099-02-20",
        legOrder: 2,
        groupId: scheduleIntegrityPeer.id,
        primaryTeacherIdSnapshot: replacement.id,
        classNameSnapshot: scheduleIntegrityPeer.name,
        originalStartTime: "10:00",
        originalEndTime: "11:00",
        effectiveStartTime: "09:00",
        effectiveEndTime: "10:00",
        reservationActive: true,
      });
      return staleLeg!;
    }));
    const liveImpact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, staleMembership.id)
    );
    const blockListImpact = liveImpact.assignments.find(
      (assignment) => assignment.assignmentType === "block_list"
    );
    assert.equal(blockListImpact?.required, true);
    assert.deepEqual(blockListImpact?.allowedOperations, ["replace"]);
    await asSystem(() =>
      db
        .update(schoolMemberships)
        .set({ status: "inactive" })
        .where(eq(schoolMemberships.id, staleMembership.id))
    );

    const integrity = await inSchool(school.id, () =>
      getStaffAssignmentIntegrityIssues(school.id)
    );
    assert.ok(
      integrity.invalidPrimaryAssignments.some((row) => row.groupId === teacherCreated.id),
      "teacher_created ownership must use the same readiness scope as admin_class"
    );
    const invalidTypes = new Set(
      integrity.invalidLiveAssignments
        .filter((row) => row.ownerUserId === staleOwner.id)
        .map((row) => row.assignmentType)
    );
    assert.deepEqual(
      invalidTypes,
      new Set([
        "passpilot_legacy_class",
        "gopilot_homeroom_primary",
        "coverage_assignment",
        "teacher_student_assignment",
        "flight_path",
        "block_list",
        "student_group",
        "central_email_recipient",
      ])
    );
    assert.equal(integrity.invalidAssignmentCountsByType.class_primary! >= 1, true);
    assert.ok(
      integrity.invalidLiveBlockers.some(
        (row) =>
          row.blockerType === "active_schedule_change" &&
          row.blockerId === invalidScheduleLeg.id &&
          row.resourceId === teacherCreated.id &&
          row.ownerUserId === staleOwner.id &&
          row.reason === "missing_active_teachable_membership"
      ),
      "active reserved schedule-change snapshots must be included in readiness"
    );
  });

  it("rechecks impact after a concurrent blocker writer commits under the lifecycle lock", async () => {
    const raceSource = await createUser({
      email: `race-source@${TAG}.example.edu`,
      firstName: "Race",
      lastName: "Source",
    });
    const raceMembership = await createMembership({
      userId: raceSource.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const raceClass = await inSchool(school.id, () =>
      createGroup({
        schoolId: school.id,
        teacherId: raceSource.id,
        name: `${TAG}_RaceClass`,
        groupType: "admin_class",
        status: "active",
      })
    );
    const reviewedImpact = await inSchool(school.id, () =>
      getStaffAssignmentImpact(school.id, raceMembership.id)
    );

    let releaseWriter!: () => void;
    let confirmWritten!: () => void;
    const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const blockerWritten = new Promise<void>((resolve) => { confirmWritten = resolve; });
    const writer = inSchool(school.id, () =>
      db.transaction(async (tx) => {
        const conflict = await upsertScheduledClassConflict(
          {
            schoolId: school.id,
            groupId: raceClass.id,
            teacherId: raceSource.id,
            scheduledDate: "2099-03-01",
            blockStartTime: "09:00",
            blockEndTime: "09:45",
            status: "coverage_needed",
            conflictPayload: { code: "SCHEDULED_COVERAGE_NEEDED" },
          },
          tx
        );
        confirmWritten();
        await writerRelease;
        return conflict;
      })
    );
    await blockerWritten;

    let transitionSettled = false;
    const transitionAttempt = inSchool(school.id, () =>
      transitionStaffAssignments({
        schoolId: school.id,
        membershipId: raceMembership.id,
        actorUserId: actor.id,
        actorRole: "admin",
        request: {
          expectedRevision: reviewedImpact.revision,
          action: "deactivate",
          decisions: reviewedImpact.assignments.map((assignment) => ({
            assignmentType: assignment.assignmentType,
            assignmentId: assignment.assignmentId,
            operation: assignment.required ? "replace" : "remove",
            ...(assignment.required
              ? { replacementMembershipId: replacementMembership.id }
              : {}),
          })),
        },
      })
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    ).finally(() => { transitionSettled = true; });

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(transitionSettled, false, "transition must wait for the blocker writer");
    releaseWriter();
    const [conflict, transitionResult] = await Promise.all([writer, transitionAttempt]);
    assert.equal(conflict.status, "coverage_needed");
    assert.equal(transitionResult.ok, false);
    if (transitionResult.ok) assert.fail("transition unexpectedly succeeded");
    assert.equal(
      (transitionResult.error as { code?: string }).code,
      "STAFF_ASSIGNMENT_IMPACT_STALE"
    );
    const [savedMembership] = await asSystem(() =>
      db
        .select({ status: schoolMemberships.status })
        .from(schoolMemberships)
        .where(eq(schoolMemberships.id, raceMembership.id))
        .limit(1)
    );
    assert.equal(savedMembership?.status, "active");
  });

  it("serializes dependency writers behind the shared school lifecycle lock", async () => {
    const membershipWriterUser = await createUser({
      email: `serialized-membership@${TAG}.example.edu`,
      firstName: "Serialized",
      lastName: "Membership",
    });
    const membershipWriterMembership = await createMembership({
      userId: membershipWriterUser.id,
      schoolId: school.id,
      role: "teacher",
      status: "active",
    });
    const archiveCandidate = await inSchool(school.id, () =>
      createGroup({
        schoolId: school.id,
        teacherId: replacement.id,
        name: `${TAG}_SerializedArchive`,
        groupType: "teacher_created",
        status: "active",
      })
    );
    const deleteCandidate = await inSchool(school.id, () =>
      createGroup({
        schoolId: school.id,
        teacherId: replacement.id,
        name: `${TAG}_SerializedDelete`,
        groupType: "teacher_created",
        status: "active",
      })
    );
    const sessionCandidate = await inSchool(school.id, () =>
      createGroup({
        schoolId: school.id,
        teacherId: replacement.id,
        name: `${TAG}_SerializedSession`,
        groupType: "admin_class",
        status: "active",
      })
    );
    const expectSerialized = async <T>(operation: () => Promise<T>): Promise<T> => {
      let releaseLock!: () => void;
      let confirmLocked!: () => void;
      const released = new Promise<void>((resolve) => { releaseLock = resolve; });
      const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
      const lockHolder = inSchool(school.id, () =>
        db.transaction(async (tx) => {
          const exists = await lockStaffAssignmentLifecycleSchool(tx, school.id);
          assert.equal(exists, true);
          confirmLocked();
          await released;
        })
      );
      await locked;
      let settled = false;
      const writer = inSchool(school.id, operation).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(settled, false);
      releaseLock();
      const [, result] = await Promise.all([lockHolder, writer]);
      assert.equal(settled, true);
      return result;
    };

    const updatedMembership = await expectSerialized(() =>
      updateMembershipForSchool(
        membershipWriterMembership.id,
        school.id,
        { role: "admin" }
      )
    );
    assert.equal(updatedMembership?.role, "admin");
    const createdClass = await expectSerialized(() =>
      createGroup({
        schoolId: school.id,
        teacherId: replacement.id,
        name: `${TAG}_SerializedCreate`,
        groupType: "teacher_created",
        status: "active",
      })
    );
    await expectSerialized(() =>
      replaceGroupTeachers(createdClass.id, replacement.id, [coClassOwner.id])
    );
    const adminClass = await expectSerialized(() =>
      upsertAdminClassroomClass({
        schoolId: school.id,
        data: {
          name: `${TAG}_SerializedAdminUpsert`,
          groupType: "admin_class",
          status: "active",
        },
        primaryTeacherId: replacement.id,
      })
    );
    assert.equal(adminClass.group.teacherId, replacement.id);

    await expectSerialized(() =>
      createFlightPath({
        schoolId: school.id,
        teacherId: replacement.id,
        flightPathName: `${TAG}_SerializedFlightPath`,
      })
    );
    const teachingSession = await expectSerialized(() =>
      createTeachingSession({
        groupId: sessionCandidate.id,
        teacherId: replacement.id,
      })
    );
    assert.equal(teachingSession.teacherId, replacement.id);
    const startLockResult = await expectSerialized(() =>
      withTeachingSessionStartLock(
        school.id,
        replacement.id,
        async () => "locked"
      )
    );
    assert.equal(startLockResult, "locked");
    const conflict = await expectSerialized(() =>
      upsertScheduledClassConflict({
        schoolId: school.id,
        groupId: sessionCandidate.id,
        teacherId: replacement.id,
        scheduledDate: "2099-04-01",
        blockStartTime: "10:00",
        blockEndTime: "10:45",
        status: "coverage_needed",
        conflictPayload: { code: "SCHEDULED_COVERAGE_NEEDED" },
      })
    );
    assert.equal(conflict.status, "coverage_needed");
    const pendingConflict = await expectSerialized(() =>
      updateScheduledClassConflictStatus(conflict.id, school.id, "pending")
    );
    assert.equal(pendingConflict?.status, "pending");
    const scheduledStartAt = new Date("2099-04-02T14:00:00.000Z");
    const scheduledEndAt = new Date("2099-04-02T14:45:00.000Z");
    const scheduledOccurrence = await inSchool(school.id, () =>
      createOrReuseScheduledReportSession({
        schoolId: school.id,
        groupId: sessionCandidate.id,
        teacherId: replacement.id,
        scheduledDate: "2099-04-02",
        scheduledTimezone: "America/New_York",
        scheduledStartAt,
        scheduledEndAt,
      })
    );
    const scheduledConflict = await inSchool(school.id, () =>
      upsertScheduledClassConflictForOccurrence({
        teachingSessionId: scheduledOccurrence.id,
        schoolId: school.id,
        groupId: sessionCandidate.id,
        teacherId: replacement.id,
        scheduledDate: "2099-04-02",
        blockStartTime: "10:00",
        blockEndTime: "10:45",
        status: "coverage_needed",
        conflictPayload: { code: "SCHEDULED_COVERAGE_NEEDED" },
      })
    );
    const scheduledClaim = await expectSerialized(() =>
      claimScheduledCoverageStudents({
        schoolId: school.id,
        scheduledConflictId: scheduledConflict.conflict.id,
        className: sessionCandidate.name,
        assignedStaffId: replacement.id,
        actorId: actor.id,
        studentIds: [],
        endsAt: scheduledEndAt,
      })
    );
    assert.equal(scheduledClaim.context.assignedStaffId, replacement.id);
    const context = await expectSerialized(() =>
      createSupervisionContextWithStudents({
        context: {
          schoolId: school.id,
          contextType: "direct_pickup",
          name: `${TAG}_SerializedSupervision`,
          assignedStaffId: replacement.id,
          createdBy: actor.id,
          endsAt: new Date(Date.now() + 60 * 60 * 1_000),
        },
        studentIds: [],
        assignedBy: actor.id,
      })
    );
    const extended = await expectSerialized(() =>
      extendSupervisionContext({
        schoolId: school.id,
        contextId: context.id,
        endsAt: new Date(Date.now() + 2 * 60 * 60 * 1_000),
      })
    );
    assert.equal(extended?.assignedStaffId, replacement.id);

    const kioskDeviceId = `${TAG}_serialized_device`;
    const unclaimedKiosk = await inSchool(school.id, () =>
      createKioskSession(school.id, kioskDeviceId)
    );
    const claimedKiosk = await expectSerialized(() =>
      claimKioskSessionByCode(
        school.id,
        unclaimedKiosk.claimCode,
        null,
        { actorUserId: replacement.id, manager: false }
      )
    );
    assert.equal(claimedKiosk.status, "active");
    await inSchool(school.id, () =>
      releaseKioskSession(
        school.id,
        claimedKiosk.id,
        { actorUserId: replacement.id, manager: false }
      )
    );
    const resumedKiosk = await expectSerialized(() =>
      createResumedKioskSession(school.id, kioskDeviceId)
    );
    assert.equal(resumedKiosk.teacherId, replacement.id);
    const selfKiosk = await expectSerialized(() =>
      createSelfClaimedKioskSession(
        school.id,
        null,
        { actorUserId: replacement.id, manager: false }
      )
    );
    assert.equal(selfKiosk.teacherId, replacement.id);
    const archived = await expectSerialized(() => archiveGroup(archiveCandidate.id));
    const deleted = await expectSerialized(() => deleteGroup(deleteCandidate.id));
    assert.equal(archived?.status, "archived");
    assert.equal(deleted, true);
  });
});

describe("staff identity repair CLI safety contract", () => {
  it("requires both explicit admission and verified ECS identity for every execution", async () => {
    await assert.rejects(
      () => assertStaffIdentityRepairExecutionAdmission({
        execute: true,
        environment: {},
        resolveRuntimeIdentity: async () => ({
          taskDefinitionArn: "must-not-be-called",
          taskDefinitionSha256: "must-not-be-called",
        }),
      }),
      (error: any) => error?.code === "STAFF_IDENTITY_REPAIR_ECS_ONE_OFF_REQUIRED"
    );
    await assert.rejects(
      () => assertStaffIdentityRepairExecutionAdmission({
        execute: true,
        environment: {
          STAFF_IDENTITY_REPAIR_EXECUTION_ADMISSION:
            STAFF_IDENTITY_REPAIR_PRODUCTION_ADMISSION,
        },
        resolveRuntimeIdentity: async () => null,
      }),
      (error: any) => error?.code === "STAFF_IDENTITY_REPAIR_ECS_ONE_OFF_REQUIRED"
    );
    await assert.doesNotReject(() =>
      assertStaffIdentityRepairExecutionAdmission({
        execute: true,
        environment: {
          STAFF_IDENTITY_REPAIR_EXECUTION_ADMISSION:
            STAFF_IDENTITY_REPAIR_PRODUCTION_ADMISSION,
        },
        resolveRuntimeIdentity: async () => ({
          taskDefinitionArn:
            "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:1",
          taskDefinitionSha256: "runtime-identity-proof",
        }),
      })
    );
  });

  it("requires exact execution proof and forbids all-school execution", () => {
    const schoolId = "11111111-1111-4111-8111-111111111111";
    const sourceUserId = "22222222-2222-4222-8222-222222222222";
    const targetUserId = "33333333-3333-4333-8333-333333333333";
    const actorId = "44444444-4444-4444-8444-444444444444";
    const parsed = parseStaffIdentityRepairCliArgs([
      "--school-id",
      schoolId,
      "--source-user-id",
      sourceUserId,
      "--target-user-id",
      targetUserId,
      "--execute",
      "--revision",
      "staff-impact-v2:proof",
      "--proof",
      "staff-repair-proof-v1:proof",
      "--super-admin-actor-id",
      actorId,
      "--acknowledge",
      STAFF_IDENTITY_REPAIR_ACKNOWLEDGEMENT,
    ]);
    assert.doesNotThrow(() => validateStaffIdentityRepairCliOptions(parsed));
    assert.throws(() =>
      validateStaffIdentityRepairCliOptions(
        parseStaffIdentityRepairCliArgs([
          "--school-id",
          schoolId,
          "--source-user-id",
          sourceUserId,
          "--target-user-id",
          targetUserId,
          "--execute",
          "--revision",
          "staff-impact-v2:proof",
          "--super-admin-actor-id",
          actorId,
          "--acknowledge",
          STAFF_IDENTITY_REPAIR_ACKNOWLEDGEMENT,
        ])
      )
    );
    assert.throws(() =>
      validateStaffIdentityRepairCliOptions(
        parseStaffIdentityRepairCliArgs(["--all-schools", "--execute"])
      )
    );
  });

  it("binds recovery proof to both memberships, revision, and preservation counts", () => {
    const base = {
      schoolId: "11111111-1111-4111-8111-111111111111",
      sourceMembershipId: "22222222-2222-4222-8222-222222222222",
      targetMembershipId: "33333333-3333-4333-8333-333333333333",
      impactRevision: "staff-impact-v2:revision",
      preservationCounts: {
        classCount: 2,
        rosterMembershipCount: 46,
        teachingSessionCount: 5,
      },
    };
    const proof = createStaffIdentityRepairProof(base);
    assert.match(proof, /^staff-repair-proof-v1:/);
    assert.notEqual(
      proof,
      createStaffIdentityRepairProof({
        ...base,
        targetMembershipId: "44444444-4444-4444-8444-444444444444",
      })
    );
    assert.notEqual(
      proof,
      createStaffIdentityRepairProof({
        ...base,
        preservationCounts: { ...base.preservationCounts, rosterMembershipCount: 47 },
      })
    );
  });
});

describe("staff assignment lifecycle route authorization contract", () => {
  it("keeps base-role and GoPilot-role transitions in their authorized product contexts", () => {
    assert.deepEqual(
      staffTransitionProductContextError(false, { newGopilotRole: "teacher" }),
      {
        code: "GOPILOT_ROLE_CONTEXT_REQUIRED",
        error: "GoPilot roles must be changed from GoPilot staff setup.",
      }
    );
    assert.deepEqual(
      staffTransitionProductContextError(true, { newRole: "teacher" }),
      {
        code: "BASE_ROLE_CONTEXT_REQUIRED",
        error: "GoPilot setup may change product roles or explicitly promote a staff member to shared school admin.",
      }
    );
    assert.equal(
      staffTransitionProductContextError(false, { newRole: "office_staff" }),
      null
    );
    assert.equal(
      staffTransitionProductContextError(true, { newGopilotRole: "office_staff" }),
      null
    );
    assert.equal(
      staffTransitionProductContextError(true, {
        newRole: "admin",
        newGopilotRole: null,
      }),
      null
    );
  });

  it("uses GoPilot effective-role management for school aliases and base admin for canonical users", () => {
    const source = readFileSync(
      new URL("../src/routes/staffAssignmentLifecycle.ts", import.meta.url),
      "utf8"
    );
    assert.match(source, /res\.locals\.goPilotSetup === true/);
    assert.match(source, /getRequestGoPilotRole\(req, res\)/);
    assert.match(source, /hasActiveGoPilotLicense\(schoolId\)/);
    assert.match(source, /effectiveRole !== "admin"/);
    assert.match(source, /effectiveRole !== "school_admin"/);
    assert.match(source, /hasActiveIndependentStaffProduct\(schoolId\)/);
    assert.match(source, /requireBaseAdmin\(req, res, next\)/);
  });

  it("keeps Super Admin membership removal anchored to the route school", () => {
    const source = readFileSync(
      new URL("../src/routes/admin/superAdmin.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      source,
      /deleteMembershipForSchool\([\s\S]*?membershipId,[\s\S]*?schoolId,[\s\S]*?undefined,[\s\S]*?true[\s\S]*?\)/
    );
    assert.match(source, /if \(!removed\)/);
    assert.doesNotMatch(source, /await deleteMembership\(membershipId\)/);
  });
});
