import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  STAFF_IDENTITY_INTEGRITY_SQL,
  staffIdentityIntegrityMigration,
} from "../src/db/staffIdentityIntegrityMigration.js";

test("staff identity contract is checksum-bound, aggregate, and fail-closed", () => {
  assert.equal(
    staffIdentityIntegrityMigration.checksum,
    createHash("sha256").update(STAFF_IDENTITY_INTEGRITY_SQL).digest("hex")
  );
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /STAFF_IDENTITY_CONTRACT_PRECHECK_FAILED/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /normalized_email_collision_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /users_email_normalized_unique/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_primary_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_relationship_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_class_relationship_shape_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /primary_mirror_mismatch_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /gopilot_primary_mirror_mismatch_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_gopilot_relationship_shape_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_tenant_scope_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_unscoped_tenant_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_live_assignment_count <> 0/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /invalid_live_blocker_count <> 0/);
  for (const tableName of [
    "schools",
    "users",
    "school_memberships",
    "groups",
    "group_teachers",
    "homerooms",
    "homeroom_teachers",
    "settings",
    "grades",
    "teacher_grades",
    "students",
    "teacher_students",
    "flight_paths",
    "block_lists",
    "student_groups",
    "classpilot_coverage_assignments",
    "teaching_sessions",
    "classpilot_session_staff",
    "classpilot_supervision_contexts",
    "passpilot_kiosk_sessions",
    "classpilot_schedule_changes",
    "classpilot_schedule_change_legs",
    "classpilot_scheduled_conflicts",
  ]) {
    assert.match(
      STAFF_IDENTITY_INTEGRITY_SQL,
      new RegExp(`\\b${tableName}\\b`),
      `${tableName} must be frozen and included in the migration contract`,
    );
  }
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /LOCK TABLE[\s\S]*IN SHARE ROW EXCLUSIVE MODE;/,
  );
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /teacher_small_group/);
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE TRIGGER school_staff_history_hard_delete_guard[\s\S]*BEFORE DELETE[\s\S]*ON schools/,
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE TRIGGER staff_identity_history_hard_delete_guard[\s\S]*BEFORE DELETE[\s\S]*ON users/,
  );
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /schoolpilot_lock_staff_assignment_school/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /schoolpilot_staff_assignment_school_is_live/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /school\.deleted_at IS NOT NULL/);
});

test("staff identity constraints cover primary, co-teacher, and membership-loss writes", () => {
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE CONSTRAINT TRIGGER classpilot_admin_class_staff_integrity[\s\S]*DEFERRABLE INITIALLY DEFERRED/
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE CONSTRAINT TRIGGER classpilot_group_teacher_staff_integrity[\s\S]*DEFERRABLE INITIALLY DEFERRED/
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE CONSTRAINT TRIGGER classpilot_staff_assignment_membership_update[\s\S]*DEFERRABLE INITIALLY DEFERRED/
  );
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /role IN \('teacher', 'admin', 'school_admin'\)/);
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /COALESCE\(NULLIF\(BTRIM\(membership\.gopilot_role\), ''\), membership\.role\)\s*= 'teacher'/
  );
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /gopilot_active_staff_assignment_membership/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /gopilot_homeroom_teacher_same_school/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /staff_live_teaching_dependency_membership/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /staff_live_active_dependency_membership/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /staff_live_dependency_teaching_membership/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /staff_live_dependency_active_membership/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /staff_live_dependency_tenant_scope/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /classpilot_active_schedule_change_ownership/);
  assert.match(STAFF_IDENTITY_INTEGRITY_SQL, /gopilot_homeroom_primary_teacher_mirror/);
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE CONSTRAINT TRIGGER school_staff_assignment_reactivation_integrity[\s\S]*AFTER UPDATE OF deleted_at, status[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE CONSTRAINT TRIGGER staff_settings_dependency_integrity[\s\S]*OR DELETE/,
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /CREATE CONSTRAINT TRIGGER classpilot_group_live_dependency_integrity[\s\S]*OR DELETE/,
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /relationship\.role NOT IN \('primary', 'co-teacher'\)/,
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /relationship\.role = 'co-teacher'[\s\S]*relationship\.teacher_id IS NOT DISTINCT FROM class_(?:group|row)\.teacher_id/,
  );
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /relationship\.role = 'co-teacher'[\s\S]*relationship\.teacher_id IS NOT DISTINCT FROM homeroom(?:_row)?\.teacher_id/,
  );
  for (const liveDependency of [
    "teacher_grades",
    "teacher_students",
    "flight_paths",
    "block_lists",
    "student_groups",
    "classpilot_coverage_assignments",
    "teaching_sessions",
    "classpilot_session_staff",
    "classpilot_supervision_contexts",
    "passpilot_kiosk_sessions",
    "classpilot_schedule_change_legs",
    "classpilot_scheduled_conflicts",
    "central_email_recipient_user_id",
  ]) {
    assert.match(
      STAFF_IDENTITY_INTEGRITY_SQL,
      new RegExp(`\\b${liveDependency}\\b`),
      `${liveDependency} must participate in membership-loss protection`,
    );
  }

  for (const triggerName of [
    "passpilot_teacher_grade_staff_integrity",
    "classpilot_teacher_student_staff_integrity",
    "classpilot_flight_path_staff_integrity",
    "classpilot_block_list_staff_integrity",
    "classpilot_student_group_staff_integrity",
    "classpilot_coverage_assignment_staff_integrity",
    "classpilot_session_staff_integrity",
    "classpilot_supervision_staff_integrity",
    "passpilot_kiosk_staff_integrity",
    "classpilot_schedule_change_leg_staff_integrity",
    "classpilot_scheduled_conflict_staff_integrity",
    "staff_settings_dependency_integrity",
    "passpilot_grade_dependency_integrity",
    "classpilot_student_dependency_integrity",
    "classpilot_teaching_session_staff_integrity",
    "classpilot_schedule_change_staff_integrity",
    "classpilot_group_live_dependency_integrity",
    "gopilot_homeroom_primary_mirror_integrity",
    "gopilot_homeroom_teacher_mirror_integrity",
    "school_staff_assignment_reactivation_integrity",
  ]) {
    assert.match(
      STAFF_IDENTITY_INTEGRITY_SQL,
      new RegExp(
        `CREATE CONSTRAINT TRIGGER ${triggerName}[\\s\\S]*DEFERRABLE INITIALLY DEFERRED`,
      ),
      `${triggerName} must enforce assignment-side integrity`,
    );
  }
});

test("staff identity trigger functions scope FORCE-RLS bypass and are not public", () => {
  const functionSignatures = [
    ["schoolpilot_lock_staff_assignment_school", "TEXT"],
    ["schoolpilot_lock_staff_assignment_schools", "TEXT\\[\\]"],
    ["schoolpilot_staff_assignment_school_is_live", "TEXT"],
    ["schoolpilot_staff_assignment_touched_schools", "TEXT"],
    ["schoolpilot_assert_live_staff_dependency", "TEXT, TEXT, TEXT\\[\\]"],
    ["schoolpilot_check_live_staff_dependency", ""],
    ["schoolpilot_check_parent_staff_dependencies", ""],
    ["schoolpilot_assert_no_active_schedule_change_for_group", "TEXT"],
    ["schoolpilot_assert_admin_class_staff_integrity", "TEXT"],
    ["schoolpilot_check_admin_class_staff_integrity", ""],
    ["schoolpilot_check_group_teacher_staff_integrity", ""],
    ["schoolpilot_check_departing_staff_assignments", ""],
    ["schoolpilot_assert_gopilot_homeroom_staff_integrity", "TEXT"],
    ["schoolpilot_check_gopilot_homeroom_staff_integrity", ""],
    ["gopilot_validate_homeroom_teacher", ""],
    ["schoolpilot_assert_school_staff_integrity", "TEXT"],
    ["schoolpilot_check_school_staff_integrity", ""],
    ["schoolpilot_guard_school_hard_delete", ""],
    ["schoolpilot_guard_user_hard_delete", ""],
  ] as const;

  for (const [functionName, signature] of functionSignatures) {
    const start = STAFF_IDENTITY_INTEGRITY_SQL.indexOf(
      `CREATE OR REPLACE FUNCTION ${functionName}(`,
    );
    assert.notEqual(start, -1, `${functionName} must be defined`);
    const next = STAFF_IDENTITY_INTEGRITY_SQL.indexOf(
      "CREATE OR REPLACE FUNCTION ",
      start + 1,
    );
    const definition = STAFF_IDENTITY_INTEGRITY_SQL.slice(
      start,
      next === -1 ? undefined : next,
    );
    assert.match(definition, /SECURITY DEFINER/);
    assert.match(
      STAFF_IDENTITY_INTEGRITY_SQL,
      new RegExp(
        `REVOKE ALL ON FUNCTION ${functionName}\\(${signature}\\) FROM PUBLIC;`,
      ),
    );
  }

  const queryingFunctions = [
    "schoolpilot_assert_admin_class_staff_integrity",
    "schoolpilot_assert_live_staff_dependency",
    "schoolpilot_check_parent_staff_dependencies",
    "schoolpilot_assert_no_active_schedule_change_for_group",
    "schoolpilot_check_departing_staff_assignments",
    "schoolpilot_assert_gopilot_homeroom_staff_integrity",
    "gopilot_validate_homeroom_teacher",
    "schoolpilot_assert_school_staff_integrity",
  ] as const;
  for (const functionName of queryingFunctions) {
    const start = STAFF_IDENTITY_INTEGRITY_SQL.indexOf(
      `CREATE OR REPLACE FUNCTION ${functionName}(`,
    );
    const next = STAFF_IDENTITY_INTEGRITY_SQL.indexOf(
      "CREATE OR REPLACE FUNCTION ",
      start + 1,
    );
    const definition = STAFF_IDENTITY_INTEGRITY_SQL.slice(
      start,
      next === -1 ? undefined : next,
    );
    assert.match(
      definition,
      /previous_is_super\s*:=\s*current_setting\('app\.is_super', true\)/,
    );
    assert.match(
      definition,
      /PERFORM set_config\('app\.is_super', 'on', true\)/,
    );
    assert.match(
      definition,
      /PERFORM set_config\('app\.is_super', COALESCE\(previous_is_super, ''\), true\)/,
    );
    assert.match(
      definition,
      /EXCEPTION WHEN OTHERS THEN[\s\S]*set_config\('app\.is_super', COALESCE\(previous_is_super, ''\), true\)[\s\S]*RAISE;/,
      `${functionName} must restore app.is_super on exceptional exits`,
    );
  }
});

test("archived and non-instructional groups remain outside the live integrity contract", () => {
  assert.match(
    STAFF_IDENTITY_INTEGRITY_SQL,
    /class_row\.group_type NOT IN \('admin_class', 'teacher_created', 'teacher_small_group'\)[\s\S]*class_row\.status <> 'active'/
  );
});

test("non-production boot retains the versioned GoPilot teacher guard after ledger convergence", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const staffIdentityContractApplied = await hasCompletedSchoolPilotMigration\([\s\S]*?STAFF_IDENTITY_CONTRACT_MIGRATION_IDS[\s\S]*?if \(!staffIdentityContractApplied\) \{[\s\S]*?CREATE OR REPLACE FUNCTION gopilot_validate_homeroom_teacher\(\)/,
  );
  assert.match(
    source,
    /else \{[\s\S]*canonical staff identity homeroom guards retained from the versioned contract/,
  );
});
