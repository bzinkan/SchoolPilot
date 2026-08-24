import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { STAFF_IDENTITY_INTEGRITY_SQL } from "../src/db/staffIdentityIntegrityMigration.js";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? (error as { code?: string }).code
    : undefined;
}

function errorConstraint(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? (error as { constraint?: string }).constraint
    : undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function scopedIntegritySql(schemaIdentifier: string): string {
  return STAFF_IDENTITY_INTEGRITY_SQL.replaceAll(
    "SET search_path = public, pg_temp",
    `SET search_path = ${schemaIdentifier}, pg_temp`,
  );
}

const createIntegrityProbeTablesSql = `
  CREATE TABLE schools (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    deleted_at TIMESTAMPTZ
  );
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    auth_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE school_memberships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    gopilot_role TEXT
  );
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    group_type TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE group_teachers (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    role TEXT NOT NULL
  );
  CREATE TABLE homerooms (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT,
    name TEXT NOT NULL
  );
  CREATE TABLE homeroom_teachers (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    homeroom_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    role TEXT NOT NULL
  );
  CREATE TABLE settings (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    passpilot_class_source TEXT NOT NULL DEFAULT 'legacy_grades',
    central_email_recipient_user_id TEXT
  );
  CREATE TABLE grades (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL
  );
  CREATE TABLE teacher_grades (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    grade_id TEXT NOT NULL
  );
  CREATE TABLE students (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE teacher_students (
    id TEXT PRIMARY KEY,
    teacher_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    school_id TEXT
  );
  CREATE TABLE flight_paths (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT
  );
  CREATE TABLE block_lists (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL
  );
  CREATE TABLE student_groups (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT
  );
  CREATE TABLE classpilot_coverage_assignments (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE teaching_sessions (
    id TEXT PRIMARY KEY,
    school_id TEXT,
    group_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    end_time TIMESTAMPTZ
  );
  CREATE TABLE classpilot_session_staff (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teaching_session_id TEXT NOT NULL,
    staff_id TEXT NOT NULL
  );
  CREATE TABLE classpilot_supervision_contexts (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    assigned_staff_id TEXT NOT NULL,
    status TEXT NOT NULL,
    ended_at TIMESTAMPTZ
  );
  CREATE TABLE passpilot_kiosk_sessions (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    teacher_id TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE classpilot_schedule_changes (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reservation_active BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE classpilot_schedule_change_legs (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    schedule_change_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    primary_teacher_id_snapshot TEXT NOT NULL,
    reservation_active BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE classpilot_scheduled_conflicts (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    teacher_id TEXT NOT NULL,
    status TEXT NOT NULL
  );
`;

test("deferred staff ownership constraints reject invalid writes and allow an atomic transfer", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  const schema = `staff_integrity_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaIdentifier = `"${schema}"`;
  const scopedSql = scopedIntegritySql(schemaIdentifier);

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO schools (id) VALUES ('school-1'), ('school-2');
      INSERT INTO users (id, email)
      VALUES
        ('normalized-user', ' Teacher@Example.ORG '),
        ('source-user', 'source@example.org'),
        ('replacement-user', 'replacement@example.org'),
        ('office-user', 'office@example.org'),
        ('resource-user', 'resource@example.org'),
        ('coverage-user', 'coverage@example.org'),
        ('workflow-user', 'workflow@example.org'),
        ('gopilot-parent-user', 'gopilot-parent@example.org')
    `);
    await client.query(scopedSql);

    const normalizedIdentity = await client.query<{
      email: string;
      auth_version: number;
      index_installed: boolean;
    }>(`
      SELECT
        email,
        auth_version,
        to_regclass('users_email_normalized_unique') IS NOT NULL AS index_installed
      FROM users
      WHERE id = 'normalized-user'
    `);
    assert.deepEqual(normalizedIdentity.rows, [{
      email: "teacher@example.org",
      auth_version: 2,
      index_installed: true,
    }]);

    await client.query("SAVEPOINT hard_user_delete_guard");
    await assert.rejects(
      client.query("DELETE FROM users WHERE id = 'normalized-user'"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_identity_history_hard_delete",
      "staff identities must never be hard-deleted",
    );
    await client.query("ROLLBACK TO SAVEPOINT hard_user_delete_guard");

    await client.query("SAVEPOINT hard_school_delete_is_always_retained");
    await assert.rejects(
      client.query("DELETE FROM schools WHERE id = 'school-2'"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "school_staff_history_hard_delete",
      "school lifecycle roots must use soft deletion even before their first dependency",
    );
    await client.query("ROLLBACK TO SAVEPOINT hard_school_delete_is_always_retained");

    await client.query(`
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES
        ('source-membership', 'source-user', 'school-1', 'teacher', 'active'),
        ('replacement-membership', 'replacement-user', 'school-1', 'teacher', 'active');
      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES
        ('admin-class', 'school-1', 'source-user', 'admin_class', 'active'),
        ('teacher-class', 'school-1', 'source-user', 'teacher_created', 'active');
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES
        ('admin-primary', 'admin-class', 'source-user', 'primary'),
        ('teacher-primary', 'teacher-class', 'source-user', 'primary');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);

    await client.query("SAVEPOINT unsupported_class_relationship_role");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('unsupported-class-role', 'admin-class', 'replacement-user', 'observer')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "classpilot_admin_class_primary_teacher_mirror",
      "active class relationships must use only canonical primary/co-teacher roles",
    );
    await client.query("ROLLBACK TO SAVEPOINT unsupported_class_relationship_role");

    await client.query("SAVEPOINT duplicate_class_primary_as_co_teacher");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('duplicate-class-owner', 'admin-class', 'source-user', 'co-teacher')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "classpilot_admin_class_primary_teacher_mirror",
      "an active class owner cannot also be represented as a co-teacher",
    );
    await client.query("ROLLBACK TO SAVEPOINT duplicate_class_primary_as_co_teacher");

    await client.query("SAVEPOINT mismatched_class_primary_owner");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      DELETE FROM group_teachers WHERE id = 'admin-primary';
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('mismatched-class-primary', 'admin-class', 'replacement-user', 'primary')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "classpilot_admin_class_primary_teacher_mirror",
      "the active class primary relationship must match groups.teacher_id",
    );
    await client.query("ROLLBACK TO SAVEPOINT mismatched_class_primary_owner");

    await client.query("SAVEPOINT invalid_co_teacher");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('invalid-co', 'admin-class', 'missing-user', 'co-teacher')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) => errorCode(error) === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_co_teacher");

    await client.query("SAVEPOINT valid_gopilot_teacher");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('valid-homeroom', 'school-1', 'source-user', 'Valid homeroom');
      INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
      VALUES ('valid-homeroom-primary', 'school-1', 'valid-homeroom', 'source-user', 'primary');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await client.query("ROLLBACK TO SAVEPOINT valid_gopilot_teacher");

    for (const malformed of [
      {
        suffix: "unsupported-role",
        ownerId: "source-user",
        extraTeacherId: "replacement-user",
        extraRole: "observer",
      },
      {
        suffix: "duplicate-owner",
        ownerId: "source-user",
        extraTeacherId: "source-user",
        extraRole: "co-teacher",
      },
    ]) {
      await client.query(`SAVEPOINT gopilot_${malformed.suffix.replaceAll("-", "_")}`);
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(`
        INSERT INTO homerooms (id, school_id, teacher_id, name)
        VALUES ($1, 'school-1', $2, 'Shape probe')
      `, [
        `homeroom-${malformed.suffix}`,
        malformed.ownerId,
      ]);
      await client.query(`
        INSERT INTO homeroom_teachers (
          id, school_id, homeroom_id, teacher_id, role
        ) VALUES
          ($3, 'school-1', $1, $2, 'primary'),
          ($4, 'school-1', $1, $5, $6)
      `, [
        `homeroom-${malformed.suffix}`,
        malformed.ownerId,
        `homeroom-${malformed.suffix}-primary`,
        `homeroom-${malformed.suffix}-extra`,
        malformed.extraTeacherId,
        malformed.extraRole,
      ]);
      await assert.rejects(
        client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        (error: unknown) =>
          errorCode(error) === "23514"
          && errorConstraint(error) === "gopilot_homeroom_primary_teacher_mirror",
        `GoPilot ${malformed.suffix} relationship shape must be rejected`,
      );
      await client.query(`ROLLBACK TO SAVEPOINT gopilot_${malformed.suffix.replaceAll("-", "_")}`);
    }

    await client.query("SAVEPOINT mismatched_gopilot_primary_owner");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('mismatched-owner-homeroom', 'school-1', 'source-user', 'Mismatch');
      INSERT INTO homeroom_teachers (
        id, school_id, homeroom_id, teacher_id, role
      ) VALUES (
        'mismatched-owner-primary', 'school-1', 'mismatched-owner-homeroom',
        'replacement-user', 'primary'
      )
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "gopilot_homeroom_primary_teacher_mirror",
      "the GoPilot primary relationship must match homerooms.teacher_id",
    );
    await client.query("ROLLBACK TO SAVEPOINT mismatched_gopilot_primary_owner");

    await client.query("SAVEPOINT invalid_gopilot_primary_mirror");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('missing-primary-homeroom', 'school-1', 'source-user', 'Missing primary')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "gopilot_homeroom_primary_teacher_mirror",
      "a GoPilot primary teacher must have exactly one matching primary relationship",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_gopilot_primary_mirror");

    await client.query("SAVEPOINT invalid_gopilot_null_primary_mirror");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('unassigned-homeroom', 'school-1', NULL, 'Unassigned');
      INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
      VALUES ('unexpected-primary', 'school-1', 'unassigned-homeroom', 'source-user', 'primary')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "gopilot_homeroom_primary_teacher_mirror",
      "an unassigned GoPilot homeroom must have no primary relationship",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_gopilot_null_primary_mirror");

    await client.query("SAVEPOINT invalid_gopilot_role");
    await client.query(`
      INSERT INTO school_memberships (
        id, user_id, school_id, role, status, gopilot_role
      ) VALUES (
        'office-membership', 'office-user', 'school-1', 'teacher', 'active', 'office_staff'
      )
    `);
    await assert.rejects(
      client.query(`
        INSERT INTO homerooms (id, school_id, teacher_id, name)
        VALUES ('invalid-homeroom', 'school-1', 'office-user', 'Invalid homeroom')
      `),
      (error: unknown) => errorCode(error) === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_gopilot_role");

    await client.query("SAVEPOINT gopilot_override_scope");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO school_memberships (
        id, user_id, school_id, role, status, gopilot_role
      ) VALUES (
        'gopilot-parent-membership', 'gopilot-parent-user', 'school-1',
        'parent', 'active', 'teacher'
      );
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('gopilot-override-homeroom', 'school-1', 'gopilot-parent-user', 'Override');
      INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
      VALUES (
        'gopilot-override-primary', 'school-1', 'gopilot-override-homeroom',
        'gopilot-parent-user', 'primary'
      );
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO classpilot_coverage_assignments (id, school_id, staff_id, active)
      VALUES ('gopilot-only-coverage', 'school-1', 'gopilot-parent-user', true)
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_active_membership",
      "a GoPilot-only role must not grant general staff ownership",
    );
    await client.query("ROLLBACK TO SAVEPOINT gopilot_override_scope");

    await client.query("SAVEPOINT invalid_membership_loss");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      UPDATE school_memberships
      SET status = 'inactive'
      WHERE id = 'source-membership'
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) => errorCode(error) === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_membership_loss");

    await client.query("SAVEPOINT direct_group_delete_active_session");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('delete-blocking-session', 'school-1', 'admin-class', 'source-user', NULL);
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES (
        'delete-blocking-session-staff', 'school-1', 'delete-blocking-session',
        'source-user'
      );
      DELETE FROM groups WHERE id = 'admin-class';
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
      "direct SQL cannot orphan an active teaching session or its staff rows",
    );
    await client.query("ROLLBACK TO SAVEPOINT direct_group_delete_active_session");

    await client.query("SAVEPOINT direct_group_delete_active_conflict");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO classpilot_scheduled_conflicts (
        id, school_id, group_id, teacher_id, status
      ) VALUES (
        'delete-blocking-conflict', 'school-1', 'admin-class',
        'source-user', 'coverage_needed'
      );
      DELETE FROM groups WHERE id = 'admin-class';
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
      "direct SQL cannot orphan an active scheduled conflict",
    );
    await client.query("ROLLBACK TO SAVEPOINT direct_group_delete_active_conflict");

    await client.query("SAVEPOINT direct_group_move_session_staff");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('source-membership-school-2', 'source-user', 'school-2', 'teacher', 'active');
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('move-session', NULL, 'admin-class', 'source-user', NULL);
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES ('move-session-staff', 'school-1', 'move-session', 'source-user');
      UPDATE groups SET school_id = 'school-2' WHERE id = 'admin-class';
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
      "moving a group must recheck active session staff against the new tenant",
    );
    await client.query("ROLLBACK TO SAVEPOINT direct_group_move_session_staff");

    await client.query("SAVEPOINT settings_default_legacy_dependency");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO settings (id, school_id, passpilot_class_source)
      VALUES ('class-source-settings', 'school-1', 'admin_classes');
      INSERT INTO grades (id, school_id) VALUES ('legacy-grade', 'school-1');
      INSERT INTO teacher_grades (id, teacher_id, grade_id)
      VALUES ('legacy-grade-owner', 'missing-user', 'legacy-grade');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);

    await client.query("SAVEPOINT settings_delete_reactivates_legacy");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("DELETE FROM settings WHERE id = 'class-source-settings'");
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_teaching_membership",
      "deleting settings cannot silently reactivate invalid legacy grade ownership",
    );
    await client.query("ROLLBACK TO SAVEPOINT settings_delete_reactivates_legacy");

    await client.query("SAVEPOINT settings_move_reactivates_legacy");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      UPDATE settings SET school_id = 'school-2'
      WHERE id = 'class-source-settings'
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_teaching_membership",
      "moving settings cannot silently reactivate invalid legacy grade ownership",
    );
    await client.query("ROLLBACK TO SAVEPOINT settings_move_reactivates_legacy");
    await client.query("ROLLBACK TO SAVEPOINT settings_default_legacy_dependency");

    await client.query("SAVEPOINT invalid_live_teaching_dependency_loss");
    await client.query(`
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('resource-membership', 'resource-user', 'school-1', 'teacher', 'active');
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('owned-block-list', 'school-1', 'resource-user');
      SET CONSTRAINTS ALL DEFERRED;
      UPDATE school_memberships
      SET role = 'office_staff'
      WHERE id = 'resource-membership';
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_teaching_dependency_membership",
      "a live non-class teaching dependency must block a teaching-role downgrade",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_live_teaching_dependency_loss");

    await client.query("SAVEPOINT invalid_live_active_dependency_loss");
    await client.query(`
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('coverage-membership', 'coverage-user', 'school-1', 'office_staff', 'active');
      INSERT INTO classpilot_coverage_assignments (id, school_id, staff_id, active)
      VALUES ('active-coverage', 'school-1', 'coverage-user', true);
      SET CONSTRAINTS ALL DEFERRED;
      UPDATE school_memberships
      SET status = 'inactive'
      WHERE id = 'coverage-membership';
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_active_dependency_membership",
      "a live staff dependency must block membership deactivation",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_live_active_dependency_loss");

    await client.query("SAVEPOINT invalid_direct_live_dependency");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('invalid-direct-block-list', 'school-1', 'missing-user')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_teaching_membership",
      "assignment-side triggers must reject a direct live dependency owned by ineligible staff",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_direct_live_dependency");

    await client.query("SAVEPOINT invalid_teacher_small_group_owner");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES (
        'invalid-small-group', 'school-1', 'missing-user',
        'teacher_small_group', 'active'
      );
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('invalid-small-group-primary', 'invalid-small-group', 'missing-user', 'primary')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "classpilot_active_primary_teacher_membership",
      "teacher small groups must participate in live ownership integrity",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_teacher_small_group_owner");

    await client.query("SAVEPOINT invalid_direct_active_staff_dependency");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO classpilot_coverage_assignments (id, school_id, staff_id, active)
      VALUES ('invalid-direct-coverage', 'school-1', 'missing-user', true)
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_active_membership",
      "assignment-side triggers must reject active-staff dependencies owned by ineligible users",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_direct_active_staff_dependency");

    await client.query("SAVEPOINT valid_legacy_session_scope_fallback");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('legacy-null-school-session', NULL, 'admin-class', 'source-user', NULL);
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES (
        'legacy-null-school-session-staff', 'school-1',
        'legacy-null-school-session', 'source-user'
      );
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await client.query("ROLLBACK TO SAVEPOINT valid_legacy_session_scope_fallback");

    await client.query("SAVEPOINT invalid_session_staff_scope");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('mismatched-session', NULL, 'admin-class', 'source-user', NULL);
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES (
        'mismatched-session-staff', 'other-school',
        'mismatched-session', 'source-user'
      )
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
      "active session staff must share the parent group's resolved school",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_session_staff_scope");

    await client.query("SAVEPOINT invalid_teacher_student_scope");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO students (id, school_id, status)
      VALUES ('active-student', 'school-1', 'active');
      INSERT INTO teacher_students (id, teacher_id, student_id, school_id)
      VALUES ('cross-school-teacher-student', 'source-user', 'active-student', 'other-school')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
      "active teacher-student rows must share their student's school",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_teacher_student_scope");

    await client.query("SAVEPOINT invalid_active_workflow_loss");
    await client.query(`
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('workflow-membership', 'workflow-user', 'school-1', 'teacher', 'active');
      INSERT INTO classpilot_schedule_changes (
        id, school_id, status, reservation_active
      ) VALUES (
        'active-change', 'school-1', 'pending_admin', true
      );
      INSERT INTO classpilot_schedule_change_legs (
        id, school_id, schedule_change_id, group_id,
        primary_teacher_id_snapshot, reservation_active
      ) VALUES (
        'active-change-leg', 'school-1', 'active-change', 'admin-class',
        'workflow-user', true
      );
      SET CONSTRAINTS ALL DEFERRED;
      UPDATE school_memberships
      SET status = 'inactive'
      WHERE id = 'workflow-membership';
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_teaching_dependency_membership",
      "an active schedule-change workflow must block membership deactivation",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_active_workflow_loss");

    await client.query("SAVEPOINT active_workflow_ownership_change");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO classpilot_schedule_changes (
        id, school_id, status, reservation_active
      ) VALUES (
        'ownership-locked-change', 'school-1', 'approved', true
      );
      INSERT INTO classpilot_schedule_change_legs (
        id, school_id, schedule_change_id, group_id,
        primary_teacher_id_snapshot, reservation_active
      ) VALUES (
        'ownership-locked-leg', 'school-1', 'ownership-locked-change',
        'admin-class', 'source-user', true
      );
      UPDATE groups
      SET teacher_id = 'replacement-user'
      WHERE id = 'admin-class';
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "classpilot_active_schedule_change_ownership",
      "active reserved schedule changes must freeze current class ownership",
    );
    await client.query("ROLLBACK TO SAVEPOINT active_workflow_ownership_change");

    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      UPDATE groups
      SET teacher_id = 'replacement-user'
      WHERE id IN ('admin-class', 'teacher-class');
      DELETE FROM group_teachers
      WHERE group_id IN ('admin-class', 'teacher-class')
        AND role = 'primary';
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES
        ('admin-replacement-primary', 'admin-class', 'replacement-user', 'primary'),
        ('teacher-replacement-primary', 'teacher-class', 'replacement-user', 'primary');
      UPDATE school_memberships
      SET status = 'inactive'
      WHERE id = 'source-membership';
      SET CONSTRAINTS ALL IMMEDIATE;
    `);

    const ownership = await client.query<{ id: string; teacher_id: string }>(`
      SELECT id, teacher_id
      FROM groups
      WHERE id IN ('admin-class', 'teacher-class')
      ORDER BY id
    `);
    assert.deepEqual(ownership.rows, [
      { id: "admin-class", teacher_id: "replacement-user" },
      { id: "teacher-class", teacher_id: "replacement-user" },
    ]);

    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES ('archived-history', 'school-1', 'missing-user', 'admin_class', 'archived');
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES
        ('archived-unsupported-role', 'archived-history', 'missing-user', 'observer'),
        ('archived-owner-as-co', 'archived-history', 'missing-user', 'co-teacher');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

test("deleted-school ownership stays historical while active and cross-school writes remain guarded", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  const schema = `staff_integrity_deleted_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaIdentifier = quoteIdentifier(schema);

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO schools (id, status, deleted_at)
      VALUES
        ('active-school', 'active', NULL),
        ('deleted-school', 'deleted', now());
      INSERT INTO users (id, email)
      VALUES
        ('normalization-proof', ' Historical@Example.ORG '),
        ('active-teacher', 'active-teacher@example.org');

      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES ('deleted-class', 'deleted-school', 'missing-user', 'admin_class', 'active');
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('deleted-class-observer', 'deleted-class', 'missing-user', 'observer');
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('deleted-homeroom', 'deleted-school', 'missing-user', 'Historical');
      INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
      VALUES (
        'deleted-homeroom-observer', 'deleted-school', 'deleted-homeroom',
        'missing-user', 'observer'
      );
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('deleted-block-list', 'deleted-school', 'missing-user');
    `);

    await client.query(scopedIntegritySql(schemaIdentifier));
    const normalized = await client.query<{ email: string }>(`
      SELECT email FROM users WHERE id = 'normalization-proof'
    `);
    assert.equal(normalized.rows[0]?.email, "historical@example.org");

    await client.query("SAVEPOINT deleted_runtime_write");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('deleted-runtime-block-list', 'deleted-school', 'still-missing');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await client.query("ROLLBACK TO SAVEPOINT deleted_runtime_write");

    await client.query("SAVEPOINT active_runtime_write");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('active-invalid-block-list', 'active-school', 'missing-user')
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_teaching_membership",
      "the same stale dependency must remain invalid in an active tenant",
    );
    await client.query("ROLLBACK TO SAVEPOINT active_runtime_write");

    await client.query("SAVEPOINT active_cross_school_write");
    await client.query(`
      INSERT INTO school_memberships (
        id, user_id, school_id, role, status, gopilot_role
      ) VALUES (
        'active-teacher-membership', 'active-teacher', 'active-school',
        'teacher', 'active', 'teacher'
      );
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('active-homeroom', 'active-school', 'active-teacher', 'Active');
      INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
      VALUES (
        'active-homeroom-primary', 'active-school', 'active-homeroom',
        'active-teacher', 'primary'
      );
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await assert.rejects(
      client.query(`
        INSERT INTO homeroom_teachers (
          id, school_id, homeroom_id, teacher_id, role
        ) VALUES (
          'deleted-to-active-cross-school', 'deleted-school', 'active-homeroom',
          'missing-user', 'co-teacher'
        )
      `),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "gopilot_homeroom_teacher_same_school",
      "a cross-school relationship touching an active tenant must fail closed",
    );
    await client.query("ROLLBACK TO SAVEPOINT active_cross_school_write");

    await client.query("SAVEPOINT invalid_school_restore");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`
      UPDATE schools
      SET deleted_at = NULL, status = 'active'
      WHERE id = 'deleted-school'
    `);
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) => errorCode(error) === "23514",
      "restoring a deleted tenant must revalidate all dormant ownership",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_school_restore");

    await client.query("SAVEPOINT hard_school_delete_guard");
    await assert.rejects(
      client.query("DELETE FROM schools WHERE id = 'deleted-school'"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "school_staff_history_hard_delete",
      "a soft-deleted tenant with retained ownership history must not be hard-deleted",
    );
    await client.query("ROLLBACK TO SAVEPOINT hard_school_delete_guard");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

test("stage-five preflight rejects stale live ownership outside class tables", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  const schema = `staff_integrity_preflight_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaIdentifier = quoteIdentifier(schema);

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO schools (id) VALUES ('school-1');
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('orphaned-block-list', 'school-1', 'missing-user');
      INSERT INTO users (id, email)
      VALUES ('must-not-normalize', ' Mixed@Example.ORG ');
      SAVEPOINT atomic_contract_preflight;
    `);

    await assert.rejects(
      client.query(scopedIntegritySql(schemaIdentifier)),
      (error: unknown) => {
        const candidate = error as { code?: string; constraint?: string; detail?: string };
        return candidate.code === "23514"
          && candidate.constraint === "staff_identity_contract_precheck"
          && candidate.detail?.includes("invalid_live_assignment=1") === true;
      },
      "the deferred contract must not install while any live ownership is stale",
    );
    await client.query("ROLLBACK TO SAVEPOINT atomic_contract_preflight");
    const rolledBackContract = await client.query<{
      email: string;
      auth_version: number;
      index_installed: boolean;
    }>(`
      SELECT
        email,
        auth_version,
        to_regclass('users_email_normalized_unique') IS NOT NULL AS index_installed
      FROM users
      WHERE id = 'must-not-normalize'
    `);
    assert.deepEqual(rolledBackContract.rows, [{
      email: " Mixed@Example.ORG ",
      auth_version: 1,
      index_installed: false,
    }], "email normalization and its index must roll back with any integrity finding");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

test("stage-five preflight exposes orphan tenant keys and unscoped active sessions", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  const schema = `staff_integrity_unscoped_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaIdentifier = quoteIdentifier(schema);

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('orphan-school-block-list', 'missing-school', 'missing-user');
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('unscoped-session', NULL, 'missing-group', 'missing-user', NULL);
    `);

    await assert.rejects(
      client.query(scopedIntegritySql(schemaIdentifier)),
      (error: unknown) => {
        const candidate = error as { code?: string; constraint?: string; detail?: string };
        return candidate.code === "23514"
          && candidate.constraint === "staff_identity_contract_precheck"
          && candidate.detail?.includes("invalid_unscoped_tenant=2") === true;
      },
      "global orphan inventory must explain every preflight-only tenant finding",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

test("stage-five preflight rejects every canonical live relationship-shape finding", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  const schema = `staff_integrity_shapes_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaIdentifier = quoteIdentifier(schema);

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO schools (id) VALUES ('school');
      INSERT INTO users (id, email)
      VALUES ('staff-user', 'staff@example.org');
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES
        ('shape-source-membership', 'shape-source', 'school', 'teacher', 'active'),
        ('shape-replacement-membership', 'shape-replacement', 'school', 'teacher', 'active');

      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES
        ('shape-class-a', 'school', 'shape-source', 'admin_class', 'active'),
        ('shape-class-b', 'school', 'shape-source', 'teacher_created', 'active'),
        ('shape-archived', 'school', 'missing-history-user', 'admin_class', 'archived');
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES
        ('shape-class-a-primary', 'shape-class-a', 'shape-source', 'primary'),
        ('shape-class-a-owner-co', 'shape-class-a', 'shape-source', 'co-teacher'),
        ('shape-class-a-unsupported', 'shape-class-a', 'shape-replacement', 'observer'),
        ('shape-class-b-wrong-primary', 'shape-class-b', 'shape-replacement', 'primary'),
        ('shape-archived-unsupported', 'shape-archived', 'missing-history-user', 'observer'),
        ('shape-archived-owner-co', 'shape-archived', 'missing-history-user', 'co-teacher');

      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES
        ('shape-homeroom-a', 'school', 'shape-source', 'Shape A'),
        ('shape-homeroom-b', 'school', 'shape-source', 'Shape B');
      INSERT INTO homeroom_teachers (
        id, school_id, homeroom_id, teacher_id, role
      ) VALUES
        ('shape-homeroom-a-primary', 'school', 'shape-homeroom-a', 'shape-source', 'primary'),
        ('shape-homeroom-a-owner-co', 'school', 'shape-homeroom-a', 'shape-source', 'co-teacher'),
        ('shape-homeroom-a-unsupported', 'school', 'shape-homeroom-a', 'shape-replacement', 'observer'),
        ('shape-homeroom-b-wrong-primary', 'school', 'shape-homeroom-b', 'shape-replacement', 'primary');
    `);

    await assert.rejects(
      client.query(scopedIntegritySql(schemaIdentifier)),
      (error: unknown) => {
        const candidate = error as { code?: string; constraint?: string; detail?: string };
        return candidate.code === "23514"
          && candidate.constraint === "staff_identity_contract_precheck"
          && candidate.detail?.includes("invalid_class_relationship_shape=3") === true
          && candidate.detail?.includes("invalid_gopilot_relationship_shape=3") === true;
      },
      "unsupported roles, owner-as-co, and primary-owner mismatches must all block stage five",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

test("stage-five preflight resolves active legacy session schools from parent groups", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  const schema = `staff_integrity_legacy_session_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaIdentifier = quoteIdentifier(schema);

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO schools (id) VALUES ('school');
      INSERT INTO users (id, email)
      VALUES ('staff-user', 'staff@example.org');
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('membership', 'staff-user', 'school', 'teacher', 'active');
      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES ('class', 'school', 'staff-user', 'teacher_created', 'active');
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('primary', 'class', 'staff-user', 'primary');
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('legacy-session', NULL, 'class', 'staff-user', NULL);
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES (
        'legacy-session-staff', 'school', 'legacy-session', 'staff-user'
      );
    `);

    await client.query(scopedIntegritySql(schemaIdentifier));
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

test("stage-five preflight rejects cross-tenant live session snapshots", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  const schema = `staff_integrity_session_scope_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schemaIdentifier = quoteIdentifier(schema);

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO schools (id) VALUES ('school'), ('other-school');
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('membership', 'staff-user', 'school', 'teacher', 'active');
      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES ('class', 'school', 'staff-user', 'teacher_created', 'active');
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('primary', 'class', 'staff-user', 'primary');
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('session', NULL, 'class', 'staff-user', NULL);
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES (
        'cross-tenant-session-staff', 'other-school', 'session', 'staff-user'
      );
    `);

    await assert.rejects(
      client.query(scopedIntegritySql(schemaIdentifier)),
      (error: unknown) => {
        const candidate = error as { code?: string; constraint?: string; detail?: string };
        return candidate.code === "23514"
          && candidate.constraint === "staff_identity_contract_precheck"
          && candidate.detail?.includes("invalid_tenant_scope=1") === true;
      },
      "the versioned preflight must fail closed on live child/parent tenant mismatches",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});

test("staff ownership guards remain fail-closed under FORCE RLS without tenant GUCs", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL");
    return;
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  const token = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schema = `staff_integrity_rls_${token}`;
  const role = `staff_integrity_rls_owner_${token}`;
  const schemaIdentifier = quoteIdentifier(schema);
  const roleIdentifier = quoteIdentifier(role);
  let transactionStarted = false;

  try {
    const capability = await client.query<{
      rolcreaterole: boolean;
      rolsuper: boolean;
      session_user: string;
    }>(`
      SELECT
        role.rolcreaterole,
        role.rolsuper,
        session_user::text AS session_user
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `);
    const currentRole = capability.rows[0];
    if (!currentRole || (!currentRole.rolcreaterole && !currentRole.rolsuper)) {
      t.skip("requires the ADMIN_DATABASE_URL role to have CREATEROLE");
      return;
    }

    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(`CREATE ROLE ${roleIdentifier} NOSUPERUSER NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(
      `GRANT ${roleIdentifier} TO ${quoteIdentifier(currentRole.session_user)}`,
    );
    await client.query(`CREATE SCHEMA ${schemaIdentifier} AUTHORIZATION ${roleIdentifier}`);
    await client.query(`SET LOCAL ROLE ${roleIdentifier}`);
    await client.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await client.query(createIntegrityProbeTablesSql);
    await client.query(`
      INSERT INTO schools (id, status, deleted_at)
      VALUES ('school', 'active', NULL), ('deleted-school', 'deleted', now())
    `);
    await client.query(scopedIntegritySql(schemaIdentifier));

    await client.query(`
      INSERT INTO users (id, email)
      VALUES
        ('staff-user', 'staff@example.org'),
        ('unassigned-user', 'unassigned@example.org');
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('membership', 'staff-user', 'school', 'teacher', 'active');
      INSERT INTO groups (id, school_id, teacher_id, group_type, status)
      VALUES ('class', 'school', 'staff-user', 'teacher_created', 'active');
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('primary', 'class', 'staff-user', 'primary');
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('homeroom', 'school', 'staff-user', 'Homeroom');
      INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
      VALUES ('homeroom-primary', 'school', 'homeroom', 'staff-user', 'primary');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);

    await client.query(`
      CREATE POLICY force_rls_tenant_visibility ON schools
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR id = NULLIF(current_setting('app.school_id', true), '')
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
      ALTER TABLE schools FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON groups
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
      ALTER TABLE groups FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON homerooms
      FOR SELECT
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE homerooms ENABLE ROW LEVEL SECURITY;
      ALTER TABLE homerooms FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON block_lists
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE block_lists ENABLE ROW LEVEL SECURITY;
      ALTER TABLE block_lists FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON settings
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE settings FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON grades
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE grades ENABLE ROW LEVEL SECURITY;
      ALTER TABLE grades FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON teacher_grades
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR EXISTS (
          SELECT 1 FROM grades AS grade
          WHERE grade.id = teacher_grades.grade_id
            AND grade.school_id = NULLIF(current_setting('app.school_id', true), '')
        )
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR EXISTS (
          SELECT 1 FROM grades AS grade
          WHERE grade.id = teacher_grades.grade_id
            AND grade.school_id = NULLIF(current_setting('app.school_id', true), '')
        )
      );
      ALTER TABLE teacher_grades ENABLE ROW LEVEL SECURITY;
      ALTER TABLE teacher_grades FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON teaching_sessions
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
        OR EXISTS (
          SELECT 1 FROM groups AS class_group
          WHERE class_group.id = teaching_sessions.group_id
            AND class_group.school_id = NULLIF(current_setting('app.school_id', true), '')
        )
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
        OR EXISTS (
          SELECT 1 FROM groups AS class_group
          WHERE class_group.id = teaching_sessions.group_id
            AND class_group.school_id = NULLIF(current_setting('app.school_id', true), '')
        )
      );
      ALTER TABLE teaching_sessions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE teaching_sessions FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON classpilot_session_staff
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE classpilot_session_staff ENABLE ROW LEVEL SECURITY;
      ALTER TABLE classpilot_session_staff FORCE ROW LEVEL SECURITY;
      CREATE POLICY force_rls_tenant_visibility ON classpilot_scheduled_conflicts
      FOR ALL
      USING (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      )
      WITH CHECK (
        current_setting('app.is_super', true) = 'on'
        OR school_id = NULLIF(current_setting('app.school_id', true), '')
      );
      ALTER TABLE classpilot_scheduled_conflicts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE classpilot_scheduled_conflicts FORCE ROW LEVEL SECURITY;
      SELECT set_config('app.is_super', '', true);
      SELECT set_config('app.school_id', '', true);
    `);

    const hiddenWithoutTenantContext = await client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM groups",
    );
    assert.equal(
      hiddenWithoutTenantContext.rows[0]?.count,
      0,
      "the non-superuser table owner must be subject to FORCE RLS",
    );

    await client.query(`
      INSERT INTO school_memberships (
        id, user_id, school_id, role, status, gopilot_role
      ) VALUES (
        'unassigned-membership', 'unassigned-user', 'school', 'teacher', 'active', 'teacher'
      )
    `);
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("UPDATE school_memberships SET role = 'admin' WHERE id = 'unassigned-membership'");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const settingAfterSuccess = await client.query<{ is_super: string }>(
      "SELECT current_setting('app.is_super', true) AS is_super",
    );
    assert.notEqual(
      settingAfterSuccess.rows[0]?.is_super,
      "on",
      "a successful trigger must restore the caller's non-super RLS context",
    );

    for (const malformed of [
      {
        savepoint: "force_rls_class_unsupported",
        insert: `
          INSERT INTO group_teachers (id, group_id, teacher_id, role)
          VALUES ('force-class-unsupported', 'class', 'unassigned-user', 'observer')
        `,
        constraint: "classpilot_admin_class_primary_teacher_mirror",
      },
      {
        savepoint: "force_rls_class_duplicate_owner",
        insert: `
          INSERT INTO group_teachers (id, group_id, teacher_id, role)
          VALUES ('force-class-owner-co', 'class', 'staff-user', 'co-teacher')
        `,
        constraint: "classpilot_admin_class_primary_teacher_mirror",
      },
      {
        savepoint: "force_rls_class_owner_mismatch",
        insert: `
          DELETE FROM group_teachers WHERE id = 'primary';
          INSERT INTO group_teachers (id, group_id, teacher_id, role)
          VALUES ('force-class-wrong-primary', 'class', 'unassigned-user', 'primary')
        `,
        constraint: "classpilot_admin_class_primary_teacher_mirror",
      },
      {
        savepoint: "force_rls_homeroom_unsupported",
        insert: `
          INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
          VALUES ('force-homeroom-unsupported', 'school', 'homeroom', 'unassigned-user', 'observer')
        `,
        constraint: "gopilot_homeroom_primary_teacher_mirror",
      },
      {
        savepoint: "force_rls_homeroom_duplicate_owner",
        insert: `
          INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
          VALUES ('force-homeroom-owner-co', 'school', 'homeroom', 'staff-user', 'co-teacher')
        `,
        constraint: "gopilot_homeroom_primary_teacher_mirror",
      },
      {
        savepoint: "force_rls_homeroom_owner_mismatch",
        insert: `
          DELETE FROM homeroom_teachers WHERE id = 'homeroom-primary';
          INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
          VALUES ('force-homeroom-wrong-primary', 'school', 'homeroom', 'unassigned-user', 'primary')
        `,
        constraint: "gopilot_homeroom_primary_teacher_mirror",
      },
    ]) {
      await client.query(`SAVEPOINT ${malformed.savepoint}`);
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await client.query(malformed.insert);
      await assert.rejects(
        client.query("SET CONSTRAINTS ALL IMMEDIATE"),
        (error: unknown) =>
          errorCode(error) === "23514"
          && errorConstraint(error) === malformed.constraint,
        `${malformed.savepoint} must fail closed while its parent is hidden by FORCE RLS`,
      );
      await client.query(`ROLLBACK TO SAVEPOINT ${malformed.savepoint}`);
    }

    await client.query("SAVEPOINT invalid_force_rls_membership_loss");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("UPDATE school_memberships SET status = 'inactive' WHERE id = 'membership'");
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) => errorCode(error) === "23514",
      "the SECURITY DEFINER guard must see hidden ownership and reject membership loss",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_force_rls_membership_loss");
    const settingAfterFailure = await client.query<{ is_super: string }>(
      "SELECT current_setting('app.is_super', true) AS is_super",
    );
    assert.notEqual(
      settingAfterFailure.rows[0]?.is_super,
      "on",
      "a rejected trigger must restore the caller's non-super RLS context",
    );

    await client.query("SAVEPOINT valid_force_rls_non_class_dependency");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'school', true)");
    await client.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('force-rls-block-list', 'school', 'staff-user')
    `);
    await client.query("SELECT set_config('app.school_id', '', true)");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const settingAfterDependencySuccess = await client.query<{ is_super: string }>(
      "SELECT current_setting('app.is_super', true) AS is_super",
    );
    assert.notEqual(
      settingAfterDependencySuccess.rows[0]?.is_super,
      "on",
      "an assignment-side trigger must restore FORCE-RLS authority after success",
    );
    await client.query("ROLLBACK TO SAVEPOINT valid_force_rls_non_class_dependency");

    await client.query("SAVEPOINT invalid_force_rls_non_class_dependency");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'school', true)");
    await client.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('force-rls-invalid-block-list', 'school', 'missing-user')
    `);
    await client.query("SELECT set_config('app.school_id', '', true)");
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_teaching_membership",
      "assignment-side guards must see FORCE-RLS-hidden rows and fail closed",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_force_rls_non_class_dependency");
    const settingAfterDependencyFailure = await client.query<{ is_super: string }>(
      "SELECT current_setting('app.is_super', true) AS is_super",
    );
    assert.notEqual(
      settingAfterDependencyFailure.rows[0]?.is_super,
      "on",
      "an assignment-side rejection must restore the caller's FORCE-RLS context",
    );

    await client.query("SAVEPOINT force_rls_settings_parent_guard");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'school', true)");
    await client.query(`
      INSERT INTO settings (id, school_id, passpilot_class_source)
      VALUES ('force-settings', 'school', 'admin_classes');
      INSERT INTO grades (id, school_id) VALUES ('force-grade', 'school');
      INSERT INTO teacher_grades (id, teacher_id, grade_id)
      VALUES ('force-grade-owner', 'missing-user', 'force-grade')
    `);
    await client.query("SELECT set_config('app.school_id', '', true)");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SAVEPOINT force_rls_settings_delete");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'school', true)");
    await client.query("DELETE FROM settings WHERE id = 'force-settings'");
    await client.query("SELECT set_config('app.school_id', '', true)");
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_teaching_membership",
      "the settings DELETE backstop must see FORCE-RLS-hidden grade ownership",
    );
    await client.query("ROLLBACK TO SAVEPOINT force_rls_settings_delete");
    await client.query("ROLLBACK TO SAVEPOINT force_rls_settings_parent_guard");

    await client.query("SAVEPOINT force_rls_group_delete_session");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'school', true)");
    await client.query(`
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('force-delete-session', 'school', 'class', 'staff-user', NULL);
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES (
        'force-delete-session-staff', 'school', 'force-delete-session', 'staff-user'
      )
    `);
    await client.query("SELECT set_config('app.school_id', '', true)");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'school', true)");
    await client.query("DELETE FROM groups WHERE id = 'class'");
    await client.query("SELECT set_config('app.school_id', '', true)");
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
      "the group DELETE backstop must see FORCE-RLS-hidden active sessions",
    );
    await client.query("ROLLBACK TO SAVEPOINT force_rls_group_delete_session");

    await client.query("SAVEPOINT force_rls_group_delete_conflict");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'school', true)");
    await client.query(`
      INSERT INTO classpilot_scheduled_conflicts (
        id, school_id, group_id, teacher_id, status
      ) VALUES (
        'force-delete-conflict', 'school', 'class', 'staff-user', 'coverage_needed'
      );
      DELETE FROM groups WHERE id = 'class'
    `);
    await client.query("SELECT set_config('app.school_id', '', true)");
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
      "the group DELETE backstop must see FORCE-RLS-hidden active conflicts",
    );
    await client.query("ROLLBACK TO SAVEPOINT force_rls_group_delete_conflict");

    await client.query("SAVEPOINT force_rls_deleted_school_exemption");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'deleted-school', true)");
    await client.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('force-rls-deleted-block-list', 'deleted-school', 'missing-user')
    `);
    await client.query("SELECT set_config('app.school_id', '', true)");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");

    await client.query("SAVEPOINT force_rls_cross_school_write");
    await assert.rejects(
      client.query(`
        INSERT INTO homeroom_teachers (
          id, school_id, homeroom_id, teacher_id, role
        ) VALUES (
          'force-rls-cross-school', 'deleted-school', 'homeroom',
          'missing-user', 'co-teacher'
        )
      `),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "gopilot_homeroom_teacher_same_school",
      "FORCE RLS must not hide an active parent from the cross-school guard",
    );
    await client.query("ROLLBACK TO SAVEPOINT force_rls_cross_school_write");

    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("SELECT set_config('app.school_id', 'deleted-school', true)");
    await client.query(`
      UPDATE schools
      SET deleted_at = NULL, status = 'active'
      WHERE id = 'deleted-school'
    `);
    await client.query("SELECT set_config('app.school_id', '', true)");
    await assert.rejects(
      client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      (error: unknown) => errorCode(error) === "23514",
      "the deferred restore guard must see dormant ownership through FORCE RLS",
    );
    await client.query("ROLLBACK TO SAVEPOINT force_rls_deleted_school_exemption");
  } finally {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await client.query("RESET ROLE").catch(() => undefined);
    await client.end();
  }
});

test("assignment creation and membership loss cannot both commit", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const token = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schema = `staff_integrity_race_${token}`;
  const schemaIdentifier = quoteIdentifier(schema);
  const schoolId = `school-${token}`;
  const setupClient = new pg.Client({ connectionString });
  const assignmentClient = new pg.Client({ connectionString });
  const membershipClient = new pg.Client({ connectionString });
  let schemaCommitted = false;

  await setupClient.connect();
  try {
    await setupClient.query("BEGIN");
    await setupClient.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await setupClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await setupClient.query(createIntegrityProbeTablesSql);
    await setupClient.query("INSERT INTO schools (id) VALUES ($1)", [schoolId]);
    await setupClient.query(
      "INSERT INTO users (id, email) VALUES ('staff-user', 'staff@example.org')",
    );
    await setupClient.query(scopedIntegritySql(schemaIdentifier));
    await setupClient.query(
      `
        INSERT INTO school_memberships (id, user_id, school_id, role, status)
        VALUES ('membership', 'staff-user', $1, 'teacher', 'active')
      `,
      [schoolId],
    );
    await setupClient.query("COMMIT");
    schemaCommitted = true;

    await Promise.all([assignmentClient.connect(), membershipClient.connect()]);
    await Promise.all([
      assignmentClient.query("BEGIN"),
      membershipClient.query("BEGIN"),
    ]);
    await Promise.all([
      assignmentClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`),
      membershipClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`),
    ]);
    await Promise.all([
      assignmentClient.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'"),
      membershipClient.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'"),
    ]);

    await assignmentClient.query(
      `
        INSERT INTO groups (id, school_id, teacher_id, group_type, status)
        VALUES ('concurrent-class', $1, 'staff-user', 'teacher_created', 'active')
      `,
      [schoolId],
    );
    await assignmentClient.query(`
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('concurrent-primary', 'concurrent-class', 'staff-user', 'primary')
    `);
    await membershipClient.query(
      "UPDATE school_memberships SET status = 'inactive' WHERE id = 'membership'",
    );

    const commitResults = await Promise.allSettled([
      assignmentClient.query("COMMIT"),
      membershipClient.query("COMMIT"),
    ]);
    const committed = commitResults.filter((result) => result.status === "fulfilled");
    const rejected = commitResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(committed.length, 1, "exactly one competing transaction must commit");
    assert.equal(rejected.length, 1, "exactly one competing transaction must be rejected");
    assert.equal(
      errorCode(rejected[0]?.reason),
      "23514",
      "the losing transaction must fail an integrity constraint, not time out",
    );

    const finalState = await setupClient.query<{
      active_assignments: number;
      membership_status: string;
      primary_mirrors: number;
    }>(`
      SELECT
        membership.status AS membership_status,
        (
          SELECT count(*)::integer
          FROM ${schemaIdentifier}.groups AS class_group
          WHERE class_group.id = 'concurrent-class'
        ) AS active_assignments,
        (
          SELECT count(*)::integer
          FROM ${schemaIdentifier}.group_teachers AS relationship
          WHERE relationship.group_id = 'concurrent-class'
            AND relationship.role = 'primary'
            AND relationship.teacher_id = 'staff-user'
        ) AS primary_mirrors
      FROM ${schemaIdentifier}.school_memberships AS membership
      WHERE membership.id = 'membership'
    `);
    const state = finalState.rows[0];
    assert.ok(state);
    assert.ok(
      (state.membership_status === "active"
        && state.active_assignments === 1
        && state.primary_mirrors === 1)
      || (state.membership_status === "inactive"
        && state.active_assignments === 0
        && state.primary_mirrors === 0),
      `final ownership state is inconsistent: ${JSON.stringify(state)}`,
    );
  } finally {
    await Promise.allSettled([
      assignmentClient.query("ROLLBACK"),
      membershipClient.query("ROLLBACK"),
    ]);
    await Promise.allSettled([
      assignmentClient.end(),
      membershipClient.end(),
    ]);
    if (schemaCommitted) {
      await setupClient.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`).catch(() => undefined);
    } else {
      await setupClient.query("ROLLBACK").catch(() => undefined);
    }
    await setupClient.end();
  }
});

test("non-class dependency creation and membership loss cannot both commit", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const token = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schema = `staff_dependency_race_${token}`;
  const schemaIdentifier = quoteIdentifier(schema);
  const schoolId = `school-${token}`;
  const setupClient = new pg.Client({ connectionString });
  const assignmentClient = new pg.Client({ connectionString });
  const membershipClient = new pg.Client({ connectionString });
  let schemaCommitted = false;

  await setupClient.connect();
  try {
    await setupClient.query("BEGIN");
    await setupClient.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await setupClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await setupClient.query(createIntegrityProbeTablesSql);
    await setupClient.query("INSERT INTO schools (id) VALUES ($1)", [schoolId]);
    await setupClient.query(
      "INSERT INTO users (id, email) VALUES ('staff-user', 'staff@example.org')",
    );
    await setupClient.query(scopedIntegritySql(schemaIdentifier));
    await setupClient.query(
      `
        INSERT INTO school_memberships (id, user_id, school_id, role, status)
        VALUES ('membership', 'staff-user', $1, 'teacher', 'active')
      `,
      [schoolId],
    );
    await setupClient.query("COMMIT");
    schemaCommitted = true;

    await Promise.all([assignmentClient.connect(), membershipClient.connect()]);
    await Promise.all([
      assignmentClient.query("BEGIN"),
      membershipClient.query("BEGIN"),
    ]);
    await Promise.all([
      assignmentClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`),
      membershipClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`),
    ]);
    await Promise.all([
      assignmentClient.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'"),
      membershipClient.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'"),
    ]);

    await assignmentClient.query(
      `
        INSERT INTO block_lists (id, school_id, teacher_id)
        VALUES ('concurrent-block-list', $1, 'staff-user')
      `,
      [schoolId],
    );
    await membershipClient.query(
      "UPDATE school_memberships SET status = 'inactive' WHERE id = 'membership'",
    );

    const commitResults = await Promise.allSettled([
      assignmentClient.query("COMMIT"),
      membershipClient.query("COMMIT"),
    ]);
    const committed = commitResults.filter((result) => result.status === "fulfilled");
    const rejected = commitResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(committed.length, 1, "exactly one competing transaction must commit");
    assert.equal(rejected.length, 1, "exactly one competing transaction must be rejected");
    assert.equal(
      errorCode(rejected[0]?.reason),
      "23514",
      "the losing non-class transaction must fail an integrity constraint",
    );

    const finalState = await setupClient.query<{
      dependency_count: number;
      membership_status: string;
    }>(`
      SELECT
        membership.status AS membership_status,
        (
          SELECT count(*)::integer
          FROM ${schemaIdentifier}.block_lists AS resource
          WHERE resource.id = 'concurrent-block-list'
        ) AS dependency_count
      FROM ${schemaIdentifier}.school_memberships AS membership
      WHERE membership.id = 'membership'
    `);
    const state = finalState.rows[0];
    assert.ok(state);
    assert.ok(
      (state.membership_status === "active" && state.dependency_count === 1)
      || (state.membership_status === "inactive" && state.dependency_count === 0),
      `final non-class ownership state is inconsistent: ${JSON.stringify(state)}`,
    );
  } finally {
    await Promise.allSettled([
      assignmentClient.query("ROLLBACK"),
      membershipClient.query("ROLLBACK"),
    ]);
    await Promise.allSettled([
      assignmentClient.end(),
      membershipClient.end(),
    ]);
    if (schemaCommitted) {
      await setupClient.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`).catch(() => undefined);
    } else {
      await setupClient.query("ROLLBACK").catch(() => undefined);
    }
    await setupClient.end();
  }
});

test("stage-five table freeze closes the preflight-to-trigger installation gap", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const token = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schema = `staff_stage5_race_${token}`;
  const schemaIdentifier = quoteIdentifier(schema);
  const setupClient = new pg.Client({ connectionString });
  const writerClient = new pg.Client({ connectionString });
  const migrationClient = new pg.Client({ connectionString });
  let schemaCommitted = false;

  await setupClient.connect();
  try {
    await setupClient.query("BEGIN");
    await setupClient.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await setupClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await setupClient.query(createIntegrityProbeTablesSql);
    await setupClient.query("INSERT INTO schools (id) VALUES ('school')");
    await setupClient.query("COMMIT");
    schemaCommitted = true;

    await Promise.all([writerClient.connect(), migrationClient.connect()]);
    await writerClient.query("BEGIN");
    await writerClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await writerClient.query(`
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('concurrent-invalid-block', 'school', 'missing-user')
    `);

    await migrationClient.query("BEGIN");
    await migrationClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await migrationClient.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'");
    let migrationSettled = false;
    const migrationAttempt = migrationClient
      .query(scopedIntegritySql(schemaIdentifier))
      .finally(() => { migrationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      migrationSettled,
      false,
      "stage five must wait for pre-existing dependency DML before inventory",
    );

    await writerClient.query("COMMIT");
    await assert.rejects(
      migrationAttempt,
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_identity_contract_precheck",
      "the post-wait preflight must observe and reject the committed invalid row",
    );
    await migrationClient.query("ROLLBACK");
  } finally {
    await Promise.allSettled([
      writerClient.query("ROLLBACK"),
      migrationClient.query("ROLLBACK"),
    ]);
    await Promise.allSettled([writerClient.end(), migrationClient.end()]);
    if (schemaCommitted) {
      await setupClient.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`).catch(() => undefined);
    } else {
      await setupClient.query("ROLLBACK").catch(() => undefined);
    }
    await setupClient.end();
  }
});

test("deleted-school restore serializes with dormant dependency and membership writes", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const token = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schema = `staff_restore_race_${token}`;
  const schemaIdentifier = quoteIdentifier(schema);
  const setupClient = new pg.Client({ connectionString });
  const dormantWriter = new pg.Client({ connectionString });
  const restoreClient = new pg.Client({ connectionString });
  let schemaCommitted = false;

  await setupClient.connect();
  try {
    await setupClient.query("BEGIN");
    await setupClient.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await setupClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await setupClient.query(createIntegrityProbeTablesSql);
    await setupClient.query(`
      INSERT INTO schools (id, status, deleted_at)
      VALUES
        ('deleted-a', 'deleted', now()),
        ('deleted-b', 'deleted', now()),
        ('deleted-membership', 'deleted', now());
      INSERT INTO users (id, email) VALUES ('staff-user', 'staff@example.org');
    `);
    await setupClient.query(scopedIntegritySql(schemaIdentifier));
    await setupClient.query(`
      INSERT INTO homerooms (id, school_id, teacher_id, name)
      VALUES ('deleted-b-homeroom', 'deleted-b', NULL, 'Historical');
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('deleted-membership-row', 'staff-user', 'deleted-membership', 'teacher', 'active');
      INSERT INTO block_lists (id, school_id, teacher_id)
      VALUES ('deleted-membership-block', 'deleted-membership', 'staff-user');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await setupClient.query("COMMIT");
    schemaCommitted = true;

    await Promise.all([dormantWriter.connect(), restoreClient.connect()]);
    for (const client of [dormantWriter, restoreClient]) {
      await client.query(`SET search_path = ${schemaIdentifier}, pg_temp`);
      await client.query("SET lock_timeout = '10s'; SET statement_timeout = '15s'");
    }

    await dormantWriter.query("BEGIN");
    await dormantWriter.query(`
      INSERT INTO homeroom_teachers (id, school_id, homeroom_id, teacher_id, role)
      VALUES (
        'concurrent-cross-school', 'deleted-a', 'deleted-b-homeroom',
        'missing-user', 'co-teacher'
      );
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await restoreClient.query("BEGIN");
    await restoreClient.query(`
      UPDATE schools SET deleted_at = NULL, status = 'active'
      WHERE id = 'deleted-a'
    `);
    let restoreSettled = false;
    const crossRestoreAttempt = restoreClient
      .query("SET CONSTRAINTS ALL IMMEDIATE")
      .finally(() => { restoreSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(restoreSettled, false, "restore must wait for a dormant cross-tenant writer");
    await dormantWriter.query("COMMIT");
    await assert.rejects(
      crossRestoreAttempt,
      (error: unknown) =>
        (
          errorCode(error) === "23514"
          && errorConstraint(error) === "gopilot_homeroom_teacher_same_school"
        ) || (
          errorCode(error) === "40001"
          && errorConstraint(error) === "school_staff_assignment_restore_race"
        ),
    );
    await restoreClient.query("ROLLBACK");

    await dormantWriter.query("BEGIN");
    await dormantWriter.query(`
      UPDATE school_memberships SET status = 'inactive'
      WHERE id = 'deleted-membership-row';
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await restoreClient.query("BEGIN");
    await restoreClient.query(`
      UPDATE schools SET deleted_at = NULL, status = 'active'
      WHERE id = 'deleted-membership'
    `);
    restoreSettled = false;
    const membershipRestoreAttempt = restoreClient
      .query("SET CONSTRAINTS ALL IMMEDIATE")
      .finally(() => { restoreSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(restoreSettled, false, "restore must wait for dormant membership loss");
    await dormantWriter.query("COMMIT");
    await assert.rejects(
      membershipRestoreAttempt,
      (error: unknown) => errorCode(error) === "23514",
      "restore must re-read the committed membership loss before going live",
    );
    await restoreClient.query("ROLLBACK");
  } finally {
    await Promise.allSettled([
      dormantWriter.query("ROLLBACK"),
      restoreClient.query("ROLLBACK"),
    ]);
    await Promise.allSettled([dormantWriter.end(), restoreClient.end()]);
    if (schemaCommitted) {
      await setupClient.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`).catch(() => undefined);
    } else {
      await setupClient.query("ROLLBACK").catch(() => undefined);
    }
    await setupClient.end();
  }
});

test("parent tenant moves serialize with relationship and session child writes", async (t) => {
  const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    t.skip("requires ADMIN_DATABASE_URL or DATABASE_URL");
    return;
  }

  const token = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const schema = `staff_parent_move_race_${token}`;
  const schemaIdentifier = quoteIdentifier(schema);
  const setupClient = new pg.Client({ connectionString });
  const childClient = new pg.Client({ connectionString });
  const moveClient = new pg.Client({ connectionString });
  let schemaCommitted = false;

  await setupClient.connect();
  try {
    await setupClient.query("BEGIN");
    await setupClient.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await setupClient.query(`SET LOCAL search_path = ${schemaIdentifier}, pg_temp`);
    await setupClient.query(createIntegrityProbeTablesSql);
    await setupClient.query(`
      INSERT INTO schools (id) VALUES ('school-a'), ('school-b');
      INSERT INTO users (id, email) VALUES
        ('primary-user', 'primary@example.org'),
        ('co-user', 'co@example.org'),
        ('delete-race-user', 'delete-race@example.org');
    `);
    await setupClient.query(scopedIntegritySql(schemaIdentifier));
    await setupClient.query(`
      INSERT INTO school_memberships (id, user_id, school_id, role, status) VALUES
        ('primary-a', 'primary-user', 'school-a', 'teacher', 'active'),
        ('primary-b', 'primary-user', 'school-b', 'teacher', 'active'),
        ('co-a', 'co-user', 'school-a', 'teacher', 'active');
      INSERT INTO groups (id, school_id, teacher_id, group_type, status) VALUES
        ('group-a', 'school-a', 'primary-user', 'admin_class', 'active'),
        ('group-b', 'school-b', 'primary-user', 'admin_class', 'active');
      INSERT INTO group_teachers (id, group_id, teacher_id, role) VALUES
        ('group-a-primary', 'group-a', 'primary-user', 'primary'),
        ('group-b-primary', 'group-b', 'primary-user', 'primary');
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('group-move-session', NULL, 'group-a', 'primary-user', NULL);
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await setupClient.query("COMMIT");
    schemaCommitted = true;
    await setupClient.query(`SET search_path = ${schemaIdentifier}, pg_temp`);

    await Promise.all([childClient.connect(), moveClient.connect()]);
    for (const client of [childClient, moveClient]) {
      await client.query(`SET search_path = ${schemaIdentifier}, pg_temp`);
      await client.query("SET lock_timeout = '10s'; SET statement_timeout = '15s'");
    }

    await childClient.query("BEGIN");
    await childClient.query(`
      INSERT INTO group_teachers (id, group_id, teacher_id, role)
      VALUES ('concurrent-co', 'group-a', 'co-user', 'co-teacher');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await moveClient.query("BEGIN");
    await moveClient.query("UPDATE groups SET school_id = 'school-b' WHERE id = 'group-a'");
    let moveSettled = false;
    const relationshipMoveAttempt = moveClient
      .query("SET CONSTRAINTS ALL IMMEDIATE")
      .finally(() => { moveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(moveSettled, false, "group move must wait for an old-tenant relationship writer");
    await childClient.query("COMMIT");
    await assert.rejects(
      relationshipMoveAttempt,
      (error: unknown) => errorCode(error) === "23514",
      "the move must recheck the committed co-teacher under the new tenant",
    );
    await moveClient.query("ROLLBACK");
    await setupClient.query(`DELETE FROM ${schemaIdentifier}.group_teachers WHERE id = 'concurrent-co'`);

    await childClient.query("BEGIN");
    await childClient.query(`
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES (
        'concurrent-group-session-staff', 'school-a',
        'group-move-session', 'primary-user'
      );
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await moveClient.query("BEGIN");
    await moveClient.query("UPDATE groups SET school_id = 'school-b' WHERE id = 'group-a'");
    moveSettled = false;
    const groupSessionMoveAttempt = moveClient
      .query("SET CONSTRAINTS ALL IMMEDIATE")
      .finally(() => { moveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(moveSettled, false, "group move must wait for active session-staff writes");
    await childClient.query("COMMIT");
    await assert.rejects(
      groupSessionMoveAttempt,
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
    );
    await moveClient.query("ROLLBACK");

    await setupClient.query(`
      INSERT INTO teaching_sessions (id, school_id, group_id, teacher_id, end_time)
      VALUES ('session-move', 'school-a', 'group-a', 'primary-user', NULL)
    `);
    await childClient.query("BEGIN");
    await childClient.query(`
      INSERT INTO classpilot_session_staff (
        id, school_id, teaching_session_id, staff_id
      ) VALUES ('concurrent-session-staff', 'school-a', 'session-move', 'primary-user');
      SET CONSTRAINTS ALL IMMEDIATE;
    `);
    await moveClient.query("BEGIN");
    await moveClient.query(`
      UPDATE teaching_sessions
      SET school_id = 'school-b', group_id = 'group-b'
      WHERE id = 'session-move'
    `);
    moveSettled = false;
    const sessionMoveAttempt = moveClient
      .query("SET CONSTRAINTS ALL IMMEDIATE")
      .finally(() => { moveSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(moveSettled, false, "session move must wait for session-staff writes");
    await childClient.query("COMMIT");
    await assert.rejects(
      sessionMoveAttempt,
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_live_dependency_tenant_scope",
    );
    await moveClient.query("ROLLBACK");

    await childClient.query("BEGIN");
    await childClient.query(`
      INSERT INTO school_memberships (id, user_id, school_id, role, status)
      VALUES ('delete-race-membership', 'delete-race-user', 'school-a', 'teacher', 'active')
    `);
    await moveClient.query("BEGIN");
    await assert.rejects(
      moveClient.query("DELETE FROM users WHERE id = 'delete-race-user'"),
      (error: unknown) =>
        errorCode(error) === "23514"
        && errorConstraint(error) === "staff_identity_history_hard_delete",
      "hard user deletion must lose even when racing the identity's first membership",
    );
    await moveClient.query("ROLLBACK");
    await childClient.query("COMMIT");
    const retainedIdentity = await setupClient.query<{ users: number; memberships: number }>(`
      SELECT
        (SELECT count(*)::integer FROM users WHERE id = 'delete-race-user') AS users,
        (SELECT count(*)::integer FROM school_memberships WHERE id = 'delete-race-membership') AS memberships
    `);
    assert.deepEqual(retainedIdentity.rows[0], { users: 1, memberships: 1 });
  } finally {
    await Promise.allSettled([
      childClient.query("ROLLBACK"),
      moveClient.query("ROLLBACK"),
    ]);
    await Promise.allSettled([childClient.end(), moveClient.end()]);
    if (schemaCommitted) {
      await setupClient.query(`DROP SCHEMA IF EXISTS ${schemaIdentifier} CASCADE`).catch(() => undefined);
    } else {
      await setupClient.query("ROLLBACK").catch(() => undefined);
    }
    await setupClient.end();
  }
});
