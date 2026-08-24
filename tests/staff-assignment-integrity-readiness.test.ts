import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getStaffAssignmentIntegrityIssues,
  getUnscopedStaffAssignmentIntegrityIssues,
} from "../dist/services/staffAssignmentLifecycle.js";
import {
  getStaffIdentityInventoryOutcome,
} from "../dist/cli/repairClasspilotStaffIdentity.js";

function queuedSelectDb(results: unknown[][]) {
  let cursor = 0;
  const database = {
    select() {
      const result = results[cursor++];
      if (!result) throw new Error(`Unexpected readiness query ${cursor}.`);
      const query: Record<string, unknown> = {};
      for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
        query[method] = () => query;
      }
      query.then = (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject);
      return query;
    },
  };
  return {
    database,
    assertConsumed() {
      assert.equal(cursor, results.length, "readiness query fixture must match the service query plan");
    },
  };
}

describe("staff assignment readiness inventory", () => {
  it("accepts a GoPilot teacher override on a non-staff base membership", async () => {
    const schoolId = "school-a";
    const fixture = queuedSelectDb([
      [{ userId: "gopilot-teacher", role: "parent", gopilotRole: "teacher" }],
      [], // Active ClassPilot classes; no relationship query follows.
      [{ id: "settings-1", classSource: "admin_classes", centralRecipientUserId: null }],
      [{ id: "homeroom-1", teacherId: "gopilot-teacher" }],
      [{
        id: "homeroom-rel-1",
        homeroomId: "homeroom-1",
        teacherId: "gopilot-teacher",
        role: "primary",
        relationshipSchoolId: schoolId,
        homeroomSchoolId: schoolId,
        primaryTeacherId: "gopilot-teacher",
      }],
      [], // Coverage.
      [], // Teacher/student relationships.
      [], // Flight paths.
      [], // Block lists.
      [], // Student groups.
      [], // Active teaching sessions.
      [], // Active session staff.
      [], // Supervision contexts.
      [], // Kiosk sessions.
      [], // Active schedule changes.
      [], // Active scheduled conflicts.
    ]);

    const issues = await getStaffAssignmentIntegrityIssues(
      schoolId,
      fixture.database as never
    );
    fixture.assertConsumed();

    assert.equal(issues.total, 0);
    assert.deepEqual(issues.invalidLiveAssignments, []);
    assert.deepEqual(issues.invalidHomeroomRelationships, []);
    assert.deepEqual(issues.homeroomPrimaryMirrorMismatches, []);
  });

  it("keeps corrupt relationship, tenant, and legacy-session rows visible as ID-only findings", async () => {
    const schoolId = "school-a";
    const fixture = queuedSelectDb([
      // Active school memberships.
      [{ userId: "eligible", role: "teacher", gopilotRole: null }],
      // Active instructional classes and every relationship on those classes.
      [{ id: "class-1", teacherId: "eligible" }],
      [{ id: "class-rel-1", groupId: "class-1", teacherId: "stale", role: "primary" }],
      // Settings select; admin_classes skips the legacy grade query.
      [{ id: "settings-1", classSource: "admin_classes", centralRecipientUserId: null }],
      // Homerooms and relationship rows returned by the parent-or-child school query.
      [{ id: "homeroom-null-primary", teacherId: null }],
      [
        {
          id: "homeroom-rel-orphan",
          homeroomId: "missing-homeroom",
          teacherId: "stale",
          role: "co-teacher",
          relationshipSchoolId: schoolId,
          homeroomSchoolId: null,
          primaryTeacherId: null,
        },
        {
          id: "homeroom-rel-cross-school",
          homeroomId: "homeroom-other-school",
          teacherId: "eligible",
          role: "co-teacher",
          relationshipSchoolId: schoolId,
          homeroomSchoolId: "school-b",
          primaryTeacherId: "eligible",
        },
        {
          id: "homeroom-rel-unexpected-primary",
          homeroomId: "homeroom-null-primary",
          teacherId: "eligible",
          role: "primary",
          relationshipSchoolId: schoolId,
          homeroomSchoolId: schoolId,
          primaryTeacherId: null,
        },
      ],
      // Coverage.
      [],
      // Active teacher/student relationship with a child tenant-key mismatch.
      [{
        id: "teacher-student-1",
        studentId: "student-1",
        teacherId: "stale",
        relationshipSchoolId: "school-b",
        studentSchoolId: schoolId,
        studentStatus: "active",
      }],
      // Flight paths, block lists, and student groups.
      [],
      [],
      [],
      // Active sessions: valid legacy NULL school, mismatched school, missing class.
      [
        {
          id: "session-legacy-null",
          groupId: "class-1",
          teacherId: "stale",
          sessionSchoolId: null,
          parentGroupId: "class-1",
          groupSchoolId: schoolId,
        },
        {
          id: "session-school-mismatch",
          groupId: "class-1",
          teacherId: "eligible",
          sessionSchoolId: "school-b",
          parentGroupId: "class-1",
          groupSchoolId: schoolId,
        },
        {
          id: "session-missing-class",
          groupId: "class-missing",
          teacherId: "eligible",
          sessionSchoolId: schoolId,
          parentGroupId: null,
          groupSchoolId: null,
        },
      ],
      // Session staff: child mismatch plus a valid legacy-session participant.
      [
        {
          id: "session-staff-mismatch",
          sessionId: "session-legacy-null",
          groupId: "class-1",
          staffId: "eligible",
          staffSchoolId: "school-b",
          sessionSchoolId: null,
          parentGroupId: "class-1",
          groupSchoolId: schoolId,
        },
        {
          id: "session-staff-stale",
          sessionId: "session-legacy-null",
          groupId: "class-1",
          staffId: "stale",
          staffSchoolId: schoolId,
          sessionSchoolId: null,
          parentGroupId: "class-1",
          groupSchoolId: schoolId,
        },
      ],
      // Supervision and kiosk blockers.
      [],
      [],
      // Reserved schedule-change snapshots: one valid stale owner, one tenant mismatch.
      [
        {
          id: "schedule-leg-stale-owner",
          groupId: "class-1",
          teacherId: "stale",
          legSchoolId: schoolId,
          changeId: "schedule-change-1",
          changeSchoolId: schoolId,
          parentGroupId: "class-1",
          groupSchoolId: schoolId,
        },
        {
          id: "schedule-leg-school-mismatch",
          groupId: "class-1",
          teacherId: "eligible",
          legSchoolId: "school-b",
          changeId: "schedule-change-2",
          changeSchoolId: schoolId,
          parentGroupId: "class-1",
          groupSchoolId: schoolId,
        },
      ],
      // Active scheduled conflict with a mismatched parent school.
      [{
        id: "scheduled-conflict-mismatch",
        groupId: "class-1",
        teacherId: "eligible",
        conflictSchoolId: "school-b",
        parentGroupId: "class-1",
        groupSchoolId: schoolId,
      }],
    ]);

    const issues = await getStaffAssignmentIntegrityIssues(
      schoolId,
      fixture.database as never
    );
    fixture.assertConsumed();

    assert.deepEqual(issues.invalidClassRelationships, [{
      groupId: "class-1",
      teacherId: "stale",
      relationshipId: "class-rel-1",
      role: "primary",
      reasons: ["missing_active_teachable_membership", "primary_owner_mismatch"],
    }]);
    assert.ok(issues.invalidHomeroomRelationships.some((row) =>
      row.relationshipId === "homeroom-rel-orphan" && row.reasons.includes("missing_parent")
    ));
    assert.ok(issues.invalidHomeroomRelationships.some((row) =>
      row.relationshipId === "homeroom-rel-cross-school" && row.reasons.includes("cross_school_parent")
    ));
    assert.deepEqual(issues.homeroomPrimaryMirrorMismatches, [{
      homeroomId: "homeroom-null-primary",
      teacherId: null,
      mirrorTeacherIds: ["eligible"],
    }]);

    const tenantIssues = new Map(
      issues.invalidTenantScopes.map((row) => [`${row.resourceType}:${row.resourceId}`, row.reason])
    );
    assert.equal(tenantIssues.get("teacher_student_assignment:teacher-student-1"), "school_mismatch");
    assert.equal(tenantIssues.get("active_teaching_session:session-school-mismatch"), "school_mismatch");
    assert.equal(tenantIssues.get("active_teaching_session:session-missing-class"), "missing_parent");
    assert.equal(tenantIssues.get("active_session_staff:session-staff-mismatch"), "school_mismatch");
    assert.equal(tenantIssues.get("active_schedule_change:schedule-leg-school-mismatch"), "school_mismatch");
    assert.equal(tenantIssues.get("active_scheduled_conflict:scheduled-conflict-mismatch"), "school_mismatch");
    assert.equal(
      tenantIssues.has("active_teaching_session:session-legacy-null"),
      false,
      "a NULL legacy session school resolves through the parent class"
    );

    assert.ok(issues.invalidLiveBlockers.some((row) =>
      row.blockerType === "active_teaching_session" &&
      row.blockerId === "session-legacy-null" &&
      row.ownerUserId === "stale"
    ));
    assert.ok(issues.invalidLiveBlockers.some((row) =>
      row.blockerType === "active_teaching_session" &&
      row.blockerId === "session-staff-stale" &&
      row.ownerUserId === "stale"
    ));
    assert.ok(issues.invalidLiveBlockers.some((row) =>
      row.blockerType === "active_schedule_change" &&
      row.blockerId === "schedule-leg-stale-owner" &&
      row.ownerUserId === "stale"
    ));
    assert.ok(issues.total > 0);
  });

  it("blocks all-school rollout for either ownership findings or normalized-email collisions", () => {
    assert.deepEqual(
      getStaffIdentityInventoryOutcome({ affectedSchoolCount: 0, emailCollisionGroupCount: 0 }),
      { status: "passed", exitCode: 0 }
    );
    assert.deepEqual(
      getStaffIdentityInventoryOutcome({ affectedSchoolCount: 1, emailCollisionGroupCount: 0 }),
      { status: "blocked", exitCode: 3 }
    );
    assert.deepEqual(
      getStaffIdentityInventoryOutcome({ affectedSchoolCount: 0, emailCollisionGroupCount: 1 }),
      { status: "blocked", exitCode: 3 }
    );
    assert.deepEqual(
      getStaffIdentityInventoryOutcome({
        affectedSchoolCount: 0,
        emailCollisionGroupCount: 0,
        unscopedIssueCount: 1,
      }),
      { status: "blocked", exitCode: 3 }
    );
  });

  it("reports orphan tenant keys in a separate global ID-only bucket", async () => {
    const issues = await getUnscopedStaffAssignmentIntegrityIssues({
      execute: async () => ({
        rows: [
          {
            resource_type: "block_list",
            resource_id: "resource-1",
            stored_school_id: "missing-school",
          },
          {
            resource_type: "active_teaching_session",
            resource_id: "session-1",
            stored_school_id: null,
          },
        ],
      }),
    } as never);

    assert.deepEqual(issues, {
      unscopedTenantDependencies: [
        {
          resourceType: "block_list",
          resourceId: "resource-1",
          storedSchoolId: "missing-school",
        },
        {
          resourceType: "active_teaching_session",
          resourceId: "session-1",
          storedSchoolId: null,
        },
      ],
      counts: { unscopedTenantDependencies: 2 },
      total: 2,
    });
  });
});
