import { createHash } from "node:crypto";
import type { SchoolPilotMigration } from "./migrationLedger.js";

/**
 * The email mutation runs only after the aggregate identity/assignment
 * preflight below succeeds. It is intentionally part of the same versioned,
 * transactional migration as every live-ownership trigger: the unique index
 * can never commit while an integrity finding remains.
 */
export const STAFF_IDENTITY_NORMALIZED_EMAIL_SQL = `
UPDATE users
SET email = lower(btrim(email)),
    auth_version = auth_version + 1,
    updated_at = now()
WHERE email IS DISTINCT FROM lower(btrim(email));

CREATE UNIQUE INDEX IF NOT EXISTS users_email_normalized_unique
  ON users (lower(btrim(email)));
`;

/**
 * Atomic contract migration for normalized user identity and every live staff
 * ownership relationship.
 *
 * The counts-only aggregate preflight is deliberate: a deployment must stop
 * until every email collision and stale live assignment has been reviewed
 * through the staff-identity inventory and repair workflow. Historical and
 * archived class references are retained.
 */
export const STAFF_IDENTITY_INTEGRITY_SQL = `
SELECT set_config('app.is_super', 'on', true);

-- Freeze every table covered by the preflight until the deferred triggers are
-- installed. Without this lock, a writer could create a new invalid row after
-- the inventory query but before enforcement becomes active.
LOCK TABLE
  schools,
  users,
  school_memberships,
  groups,
  group_teachers,
  homerooms,
  homeroom_teachers,
  settings,
  grades,
  teacher_grades,
  students,
  teacher_students,
  flight_paths,
  block_lists,
  student_groups,
  classpilot_coverage_assignments,
  teaching_sessions,
  classpilot_session_staff,
  classpilot_supervision_contexts,
  passpilot_kiosk_sessions,
  classpilot_schedule_changes,
  classpilot_schedule_change_legs,
  classpilot_scheduled_conflicts
IN SHARE ROW EXCLUSIVE MODE;

-- A soft-deleted school is a historical tenant boundary. Missing school rows
-- remain fail-closed so malformed foreign keys cannot be hidden by this
-- exemption. The helper is shared by the aggregate preflight and the runtime
-- triggers, which keeps stage-five inventory parity explicit.
CREATE OR REPLACE FUNCTION schoolpilot_staff_assignment_school_is_live(
  target_school_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_assignment_school_live$
  SELECT target_school_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM schools AS school
      WHERE school.id = target_school_id
        AND school.deleted_at IS NOT NULL
    );
$staff_assignment_school_live$;

DO $staff_identity_preflight$
DECLARE
  normalized_email_collision_count BIGINT;
  invalid_primary_count BIGINT;
  invalid_relationship_count BIGINT;
  invalid_class_relationship_shape_count BIGINT;
  primary_mirror_mismatch_count BIGINT;
  invalid_gopilot_primary_count BIGINT;
  invalid_gopilot_relationship_count BIGINT;
  invalid_gopilot_relationship_shape_count BIGINT;
  cross_school_gopilot_relationship_count BIGINT;
  gopilot_primary_mirror_mismatch_count BIGINT;
  invalid_tenant_scope_count BIGINT;
  invalid_unscoped_tenant_count BIGINT;
  invalid_live_assignment_count BIGINT;
  invalid_live_blocker_count BIGINT;
BEGIN
  SELECT count(*)
  INTO normalized_email_collision_count
  FROM (
    SELECT lower(btrim(email))
    FROM users
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) AS normalized_email_collision;

  SELECT count(*)
  INTO invalid_primary_count
  FROM groups AS class_group
  WHERE class_group.group_type IN ('admin_class', 'teacher_created', 'teacher_small_group')
    AND class_group.status = 'active'
    AND schoolpilot_staff_assignment_school_is_live(class_group.school_id)
    AND NOT EXISTS (
      SELECT 1
      FROM school_memberships AS membership
      INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
      WHERE membership.school_id = class_group.school_id
        AND membership.user_id = class_group.teacher_id
        AND membership.status = 'active'
        AND membership.role IN ('teacher', 'admin', 'school_admin')
    );

  SELECT count(*)
  INTO invalid_relationship_count
  FROM group_teachers AS relationship
  INNER JOIN groups AS class_group ON class_group.id = relationship.group_id
  WHERE class_group.group_type IN ('admin_class', 'teacher_created', 'teacher_small_group')
    AND class_group.status = 'active'
    AND schoolpilot_staff_assignment_school_is_live(class_group.school_id)
    AND NOT EXISTS (
      SELECT 1
      FROM school_memberships AS membership
      INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
      WHERE membership.school_id = class_group.school_id
        AND membership.user_id = relationship.teacher_id
        AND membership.status = 'active'
        AND membership.role IN ('teacher', 'admin', 'school_admin')
    );

  SELECT count(*)
  INTO invalid_class_relationship_shape_count
  FROM group_teachers AS relationship
  INNER JOIN groups AS class_group ON class_group.id = relationship.group_id
  WHERE class_group.group_type IN ('admin_class', 'teacher_created', 'teacher_small_group')
    AND class_group.status = 'active'
    AND schoolpilot_staff_assignment_school_is_live(class_group.school_id)
    AND (
      relationship.role NOT IN ('primary', 'co-teacher')
      OR (
        relationship.role = 'primary'
        AND relationship.teacher_id IS DISTINCT FROM class_group.teacher_id
      )
      OR (
        relationship.role = 'co-teacher'
        AND relationship.teacher_id IS NOT DISTINCT FROM class_group.teacher_id
      )
    );

  SELECT count(*)
  INTO primary_mirror_mismatch_count
  FROM groups AS class_group
  WHERE class_group.group_type IN ('admin_class', 'teacher_created', 'teacher_small_group')
    AND class_group.status = 'active'
    AND schoolpilot_staff_assignment_school_is_live(class_group.school_id)
    AND (
      (
        SELECT count(*)
        FROM group_teachers AS primary_relationship
        WHERE primary_relationship.group_id = class_group.id
          AND primary_relationship.role = 'primary'
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM group_teachers AS matching_primary
        WHERE matching_primary.group_id = class_group.id
          AND matching_primary.role = 'primary'
          AND matching_primary.teacher_id = class_group.teacher_id
      )
    );

  SELECT count(*)
  INTO invalid_gopilot_primary_count
  FROM homerooms AS homeroom
  WHERE homeroom.teacher_id IS NOT NULL
    AND schoolpilot_staff_assignment_school_is_live(homeroom.school_id)
    AND NOT EXISTS (
      SELECT 1
      FROM school_memberships AS membership
      INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
      WHERE membership.school_id = homeroom.school_id
        AND membership.user_id = homeroom.teacher_id
        AND membership.status = 'active'
        AND COALESCE(NULLIF(BTRIM(membership.gopilot_role), ''), membership.role)
          = 'teacher'
    );

  SELECT count(*)
  INTO invalid_gopilot_relationship_count
  FROM homeroom_teachers AS relationship
  WHERE schoolpilot_staff_assignment_school_is_live(relationship.school_id)
    AND NOT EXISTS (
    SELECT 1
    FROM school_memberships AS membership
    INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
    WHERE membership.school_id = relationship.school_id
      AND membership.user_id = relationship.teacher_id
      AND membership.status = 'active'
      AND COALESCE(NULLIF(BTRIM(membership.gopilot_role), ''), membership.role)
        = 'teacher'
  );

  SELECT count(*)
  INTO invalid_gopilot_relationship_shape_count
  FROM homeroom_teachers AS relationship
  INNER JOIN homerooms AS homeroom ON homeroom.id = relationship.homeroom_id
  WHERE relationship.school_id = homeroom.school_id
    AND schoolpilot_staff_assignment_school_is_live(homeroom.school_id)
    AND (
      relationship.role NOT IN ('primary', 'co-teacher')
      OR (
        relationship.role = 'primary'
        AND relationship.teacher_id IS DISTINCT FROM homeroom.teacher_id
      )
      OR (
        relationship.role = 'co-teacher'
        AND relationship.teacher_id IS NOT DISTINCT FROM homeroom.teacher_id
      )
    );

  SELECT count(*)
  INTO cross_school_gopilot_relationship_count
  FROM homeroom_teachers AS relationship
  LEFT JOIN homerooms AS homeroom ON homeroom.id = relationship.homeroom_id
  WHERE (
      homeroom.id IS NULL
      OR homeroom.school_id <> relationship.school_id
    )
    AND (
      schoolpilot_staff_assignment_school_is_live(relationship.school_id)
      OR schoolpilot_staff_assignment_school_is_live(homeroom.school_id)
    );

  SELECT count(*)
  INTO gopilot_primary_mirror_mismatch_count
  FROM homerooms AS homeroom
  WHERE schoolpilot_staff_assignment_school_is_live(homeroom.school_id)
    AND (
      (
        homeroom.teacher_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM homeroom_teachers AS unexpected_primary
          WHERE unexpected_primary.school_id = homeroom.school_id
            AND unexpected_primary.homeroom_id = homeroom.id
            AND unexpected_primary.role = 'primary'
        )
      ) OR (
        homeroom.teacher_id IS NOT NULL
        AND (
          (
            SELECT count(*)
            FROM homeroom_teachers AS primary_relationship
            WHERE primary_relationship.school_id = homeroom.school_id
              AND primary_relationship.homeroom_id = homeroom.id
              AND primary_relationship.role = 'primary'
          ) <> 1
          OR NOT EXISTS (
            SELECT 1
            FROM homeroom_teachers AS matching_primary
            WHERE matching_primary.school_id = homeroom.school_id
              AND matching_primary.homeroom_id = homeroom.id
              AND matching_primary.role = 'primary'
              AND matching_primary.teacher_id = homeroom.teacher_id
          )
        )
      )
    );

  -- Child rows whose stored tenant key disagrees with their authoritative
  -- parent cannot be safely repaired or inventoried through a school-scoped
  -- request. Active legacy teaching sessions may have a NULL school_id; their
  -- parent group is the authoritative fallback, but a non-NULL mismatch is a
  -- hard integrity error.
  SELECT count(*)
  INTO invalid_tenant_scope_count
  FROM (
    SELECT relationship.id
    FROM teacher_students AS relationship
    INNER JOIN students AS student ON student.id = relationship.student_id
    WHERE student.status = 'active'
      AND relationship.school_id IS DISTINCT FROM student.school_id
      AND (
        schoolpilot_staff_assignment_school_is_live(student.school_id)
        OR schoolpilot_staff_assignment_school_is_live(relationship.school_id)
      )

    UNION ALL

    SELECT teaching_session.id
    FROM teaching_sessions AS teaching_session
    LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE teaching_session.end_time IS NULL
      AND (
        class_group.id IS NULL
        OR (
          teaching_session.school_id IS NOT NULL
          AND teaching_session.school_id IS DISTINCT FROM class_group.school_id
        )
      )
      AND (
        (
          class_group.id IS NULL
          AND teaching_session.school_id IS NULL
        )
        OR schoolpilot_staff_assignment_school_is_live(class_group.school_id)
        OR schoolpilot_staff_assignment_school_is_live(teaching_session.school_id)
      )

    UNION ALL

    SELECT session_staff.id
    FROM classpilot_session_staff AS session_staff
    LEFT JOIN teaching_sessions AS teaching_session
      ON teaching_session.id = session_staff.teaching_session_id
    LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE teaching_session.id IS NOT NULL
      AND teaching_session.end_time IS NULL
      AND (
        class_group.id IS NULL
        OR (
          teaching_session.school_id IS NOT NULL
          AND teaching_session.school_id IS DISTINCT FROM class_group.school_id
        )
        OR session_staff.school_id IS DISTINCT FROM class_group.school_id
      )
      AND (
        schoolpilot_staff_assignment_school_is_live(class_group.school_id)
        OR schoolpilot_staff_assignment_school_is_live(teaching_session.school_id)
        OR schoolpilot_staff_assignment_school_is_live(session_staff.school_id)
      )

    UNION ALL

    SELECT schedule_leg.id
    FROM classpilot_schedule_change_legs AS schedule_leg
    INNER JOIN classpilot_schedule_changes AS schedule_change
      ON schedule_change.id = schedule_leg.schedule_change_id
    LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
    WHERE schedule_change.reservation_active = true
      AND schedule_leg.reservation_active = true
      AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved')
      AND (
        schedule_change.school_id IS DISTINCT FROM schedule_leg.school_id
        OR class_group.id IS NULL
        OR class_group.school_id IS DISTINCT FROM schedule_leg.school_id
      )
      AND (
        schoolpilot_staff_assignment_school_is_live(schedule_change.school_id)
        OR schoolpilot_staff_assignment_school_is_live(schedule_leg.school_id)
        OR schoolpilot_staff_assignment_school_is_live(class_group.school_id)
      )

    UNION ALL

    SELECT conflict.id
    FROM classpilot_scheduled_conflicts AS conflict
    LEFT JOIN groups AS class_group ON class_group.id = conflict.group_id
    WHERE conflict.status IN ('coverage_needed', 'claimed', 'pending')
      AND (
        class_group.id IS NULL
        OR class_group.school_id IS DISTINCT FROM conflict.school_id
      )
      AND (
        schoolpilot_staff_assignment_school_is_live(class_group.school_id)
        OR schoolpilot_staff_assignment_school_is_live(conflict.school_id)
      )
  ) AS invalid_tenant_scope;

  -- Rows whose tenant key has no schools parent cannot appear in an
  -- all-school inventory. Keep them in an explicit global bucket. The one
  -- legacy shape with no tenant key at all (an active session with a missing
  -- group and NULL school snapshot) is included here as well.
  SELECT count(*)
  INTO invalid_unscoped_tenant_count
  FROM (
    SELECT class_group.id
    FROM groups AS class_group
    WHERE class_group.group_type IN ('admin_class', 'teacher_created', 'teacher_small_group')
      AND class_group.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id
      )

    UNION ALL

    SELECT homeroom.id
    FROM homerooms AS homeroom
    WHERE NOT EXISTS (
      SELECT 1 FROM schools AS school WHERE school.id = homeroom.school_id
    )

    UNION ALL

    SELECT relationship.id
    FROM homeroom_teachers AS relationship
    WHERE NOT EXISTS (
      SELECT 1 FROM schools AS school WHERE school.id = relationship.school_id
    )

    UNION ALL

    SELECT relationship.id
    FROM teacher_grades AS relationship
    INNER JOIN grades AS grade ON grade.id = relationship.grade_id
    LEFT JOIN settings AS school_settings ON school_settings.school_id = grade.school_id
    WHERE COALESCE(school_settings.passpilot_class_source, 'legacy_grades') = 'legacy_grades'
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = grade.school_id
      )

    UNION ALL

    SELECT relationship.id
    FROM teacher_students AS relationship
    INNER JOIN students AS student ON student.id = relationship.student_id
    WHERE student.status = 'active'
      AND (
        NOT EXISTS (
          SELECT 1 FROM schools AS school WHERE school.id = student.school_id
        )
        OR (
          relationship.school_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schools AS school WHERE school.id = relationship.school_id
          )
        )
      )

    UNION ALL

    SELECT resource.id FROM flight_paths AS resource
    WHERE resource.teacher_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = resource.school_id
      )

    UNION ALL

    SELECT resource.id FROM block_lists AS resource
    WHERE NOT EXISTS (
      SELECT 1 FROM schools AS school WHERE school.id = resource.school_id
    )

    UNION ALL

    SELECT resource.id FROM student_groups AS resource
    WHERE resource.teacher_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = resource.school_id
      )

    UNION ALL

    SELECT assignment.id FROM classpilot_coverage_assignments AS assignment
    WHERE assignment.active = true
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = assignment.school_id
      )

    UNION ALL

    SELECT school_settings.id FROM settings AS school_settings
    WHERE school_settings.central_email_recipient_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = school_settings.school_id
      )

    UNION ALL

    SELECT teaching_session.id
    FROM teaching_sessions AS teaching_session
    LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE teaching_session.end_time IS NULL
      AND (
        (class_group.id IS NULL AND teaching_session.school_id IS NULL)
        OR (
          teaching_session.school_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schools AS school WHERE school.id = teaching_session.school_id
          )
        )
        OR (
          class_group.id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id
          )
        )
      )

    UNION ALL

    SELECT session_staff.id
    FROM classpilot_session_staff AS session_staff
    INNER JOIN teaching_sessions AS teaching_session
      ON teaching_session.id = session_staff.teaching_session_id
    LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE teaching_session.end_time IS NULL
      AND (
        NOT EXISTS (
          SELECT 1 FROM schools AS school WHERE school.id = session_staff.school_id
        )
        OR (
          teaching_session.school_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schools AS school WHERE school.id = teaching_session.school_id
          )
        )
        OR (
          class_group.id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id
          )
        )
      )

    UNION ALL

    SELECT context.id FROM classpilot_supervision_contexts AS context
    WHERE context.status = 'active'
      AND context.ended_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = context.school_id
      )

    UNION ALL

    SELECT kiosk_session.id FROM passpilot_kiosk_sessions AS kiosk_session
    WHERE kiosk_session.status = 'active'
      AND kiosk_session.teacher_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM schools AS school WHERE school.id = kiosk_session.school_id
      )

    UNION ALL

    SELECT schedule_leg.id
    FROM classpilot_schedule_change_legs AS schedule_leg
    INNER JOIN classpilot_schedule_changes AS schedule_change
      ON schedule_change.id = schedule_leg.schedule_change_id
    LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
    WHERE schedule_change.reservation_active = true
      AND schedule_leg.reservation_active = true
      AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved')
      AND (
        NOT EXISTS (
          SELECT 1 FROM schools AS school WHERE school.id = schedule_leg.school_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM schools AS school WHERE school.id = schedule_change.school_id
        )
        OR (
          class_group.id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id
          )
        )
      )

    UNION ALL

    SELECT conflict.id
    FROM classpilot_scheduled_conflicts AS conflict
    LEFT JOIN groups AS class_group ON class_group.id = conflict.group_id
    WHERE conflict.status IN ('coverage_needed', 'claimed', 'pending')
      AND (
        NOT EXISTS (
          SELECT 1 FROM schools AS school WHERE school.id = conflict.school_id
        )
        OR (
          class_group.id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id
          )
        )
      )
  ) AS invalid_unscoped_tenant;

  -- Keep the stage-five database preflight aligned with the ID-only readiness
  -- inventory. These are live ownership records, not immutable history.
  SELECT count(*)
  INTO invalid_live_assignment_count
  FROM (
    SELECT relationship.id
    FROM teacher_grades AS relationship
    INNER JOIN grades AS grade ON grade.id = relationship.grade_id
    LEFT JOIN settings AS school_settings ON school_settings.school_id = grade.school_id
    WHERE COALESCE(school_settings.passpilot_class_source, 'legacy_grades') = 'legacy_grades'
      AND schoolpilot_staff_assignment_school_is_live(grade.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = grade.school_id
          AND membership.user_id = relationship.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )

    UNION ALL

    SELECT relationship.id
    FROM teacher_students AS relationship
    INNER JOIN students AS student ON student.id = relationship.student_id
    WHERE student.status = 'active'
      AND schoolpilot_staff_assignment_school_is_live(student.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = student.school_id
          AND membership.user_id = relationship.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )

    UNION ALL

    SELECT resource.id
    FROM flight_paths AS resource
    WHERE resource.teacher_id IS NOT NULL
      AND schoolpilot_staff_assignment_school_is_live(resource.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = resource.school_id
          AND membership.user_id = resource.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )

    UNION ALL

    SELECT resource.id
    FROM block_lists AS resource
    WHERE schoolpilot_staff_assignment_school_is_live(resource.school_id)
      AND NOT EXISTS (
      SELECT 1
      FROM school_memberships AS membership
      INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
      WHERE membership.school_id = resource.school_id
        AND membership.user_id = resource.teacher_id
        AND membership.status = 'active'
        AND membership.role IN ('teacher', 'admin', 'school_admin')
    )

    UNION ALL

    SELECT resource.id
    FROM student_groups AS resource
    WHERE resource.teacher_id IS NOT NULL
      AND schoolpilot_staff_assignment_school_is_live(resource.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = resource.school_id
          AND membership.user_id = resource.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )

    UNION ALL

    SELECT assignment.id
    FROM classpilot_coverage_assignments AS assignment
    WHERE assignment.active = true
      AND schoolpilot_staff_assignment_school_is_live(assignment.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = assignment.school_id
          AND membership.user_id = assignment.staff_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin', 'office_staff')
      )

    UNION ALL

    SELECT school_settings.id
    FROM settings AS school_settings
    WHERE school_settings.central_email_recipient_user_id IS NOT NULL
      AND schoolpilot_staff_assignment_school_is_live(school_settings.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = school_settings.school_id
          AND membership.user_id = school_settings.central_email_recipient_user_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin', 'office_staff')
      )
  ) AS invalid_live_assignment;

  SELECT count(*)
  INTO invalid_live_blocker_count
  FROM (
    SELECT teaching_session.id
    FROM teaching_sessions AS teaching_session
    INNER JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE teaching_session.end_time IS NULL
      AND schoolpilot_staff_assignment_school_is_live(class_group.school_id)
      AND (
        teaching_session.school_id IS NULL
        OR teaching_session.school_id = class_group.school_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = class_group.school_id
          AND membership.user_id = teaching_session.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )

    UNION ALL

    SELECT session_staff.id
    FROM classpilot_session_staff AS session_staff
    INNER JOIN teaching_sessions AS teaching_session
      ON teaching_session.id = session_staff.teaching_session_id
    INNER JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE teaching_session.end_time IS NULL
      AND schoolpilot_staff_assignment_school_is_live(class_group.school_id)
      AND (
        teaching_session.school_id IS NULL
        OR teaching_session.school_id = class_group.school_id
      )
      AND session_staff.school_id = class_group.school_id
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = class_group.school_id
          AND membership.user_id = session_staff.staff_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )

    UNION ALL

    SELECT context.id
    FROM classpilot_supervision_contexts AS context
    WHERE context.status = 'active'
      AND context.ended_at IS NULL
      AND schoolpilot_staff_assignment_school_is_live(context.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = context.school_id
          AND membership.user_id = context.assigned_staff_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin', 'office_staff')
      )

    UNION ALL

    SELECT kiosk_session.id
    FROM passpilot_kiosk_sessions AS kiosk_session
    WHERE kiosk_session.status = 'active'
      AND kiosk_session.teacher_id IS NOT NULL
      AND schoolpilot_staff_assignment_school_is_live(kiosk_session.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = kiosk_session.school_id
          AND membership.user_id = kiosk_session.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin', 'office_staff')
      )

    UNION ALL

    SELECT schedule_leg.id
    FROM classpilot_schedule_change_legs AS schedule_leg
    INNER JOIN classpilot_schedule_changes AS schedule_change
      ON schedule_change.id = schedule_leg.schedule_change_id
      AND schedule_change.school_id = schedule_leg.school_id
    WHERE schedule_change.reservation_active = true
      AND schedule_leg.reservation_active = true
      AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved')
      AND schoolpilot_staff_assignment_school_is_live(schedule_leg.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = schedule_leg.school_id
          AND membership.user_id = schedule_leg.primary_teacher_id_snapshot
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )

    UNION ALL

    SELECT conflict.id
    FROM classpilot_scheduled_conflicts AS conflict
    WHERE conflict.status IN ('coverage_needed', 'claimed', 'pending')
      AND schoolpilot_staff_assignment_school_is_live(conflict.school_id)
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = conflict.school_id
          AND membership.user_id = conflict.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )
  ) AS invalid_live_blocker;

  IF normalized_email_collision_count <> 0
    OR invalid_primary_count <> 0
    OR invalid_relationship_count <> 0
    OR invalid_class_relationship_shape_count <> 0
    OR primary_mirror_mismatch_count <> 0
    OR invalid_gopilot_primary_count <> 0
    OR invalid_gopilot_relationship_count <> 0
    OR invalid_gopilot_relationship_shape_count <> 0
    OR cross_school_gopilot_relationship_count <> 0
    OR gopilot_primary_mirror_mismatch_count <> 0
    OR invalid_tenant_scope_count <> 0
    OR invalid_unscoped_tenant_count <> 0
    OR invalid_live_assignment_count <> 0
    OR invalid_live_blocker_count <> 0
  THEN
    RAISE EXCEPTION 'STAFF_IDENTITY_CONTRACT_PRECHECK_FAILED'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'staff_identity_contract_precheck',
        DETAIL = format(
          'normalized_email_collision=%s invalid_primary=%s invalid_relationship=%s invalid_class_relationship_shape=%s primary_mirror_mismatch=%s invalid_gopilot_primary=%s invalid_gopilot_relationship=%s invalid_gopilot_relationship_shape=%s cross_school_gopilot_relationship=%s gopilot_primary_mirror_mismatch=%s invalid_tenant_scope=%s invalid_unscoped_tenant=%s invalid_live_assignment=%s invalid_live_blocker=%s',
          normalized_email_collision_count,
          invalid_primary_count,
          invalid_relationship_count,
          invalid_class_relationship_shape_count,
          primary_mirror_mismatch_count,
          invalid_gopilot_primary_count,
          invalid_gopilot_relationship_count,
          invalid_gopilot_relationship_shape_count,
          cross_school_gopilot_relationship_count,
          gopilot_primary_mirror_mismatch_count,
          invalid_tenant_scope_count,
          invalid_unscoped_tenant_count,
          invalid_live_assignment_count,
          invalid_live_blocker_count
        );
  END IF;
END;
$staff_identity_preflight$;

CREATE OR REPLACE FUNCTION schoolpilot_lock_staff_assignment_school(
  target_school_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_assignment_school_lock$
BEGIN
  IF target_school_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM schools AS school WHERE school.id = target_school_id
  ) THEN
    RAISE EXCEPTION 'STAFF_DEPENDENCY_SCHOOL_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'staff_live_dependency_tenant_scope';
  END IF;

  -- This key is shared with every canonical application writer. Taking it in
  -- each database trigger also closes write-skew for direct SQL and old code:
  -- concurrent assignment creation and membership loss cannot both commit.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('staff-assignment-lifecycle:' || target_school_id, 0::bigint)
  );
END;
$staff_assignment_school_lock$;

CREATE OR REPLACE FUNCTION schoolpilot_lock_staff_assignment_schools(
  target_school_ids TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_assignment_schools_lock$
DECLARE
  target_school_id TEXT;
BEGIN
  -- Multi-tenant dependency rows (and school-id moves) must acquire the same
  -- lifecycle locks in a stable order. This both closes restore/write races and
  -- avoids deadlocks when two transactions touch the same schools in reverse
  -- application order.
  FOR target_school_id IN
    SELECT DISTINCT touched.school_id
    FROM unnest(COALESCE(target_school_ids, ARRAY[]::TEXT[]))
      AS touched(school_id)
    WHERE touched.school_id IS NOT NULL
    ORDER BY touched.school_id
  LOOP
    PERFORM schoolpilot_lock_staff_assignment_school(target_school_id);
  END LOOP;
END;
$staff_assignment_schools_lock$;

CREATE OR REPLACE FUNCTION schoolpilot_staff_assignment_touched_schools(
  target_school_id TEXT
)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_assignment_touched_schools$
  SELECT COALESCE(
    array_agg(candidate.school_id ORDER BY candidate.school_id),
    ARRAY[]::TEXT[]
  )
  FROM (
    SELECT DISTINCT raw_school.school_id
    FROM (
      SELECT target_school_id AS school_id
      UNION ALL
      SELECT relationship.school_id
      FROM homeroom_teachers AS relationship
      LEFT JOIN homerooms AS homeroom ON homeroom.id = relationship.homeroom_id
      WHERE relationship.school_id = target_school_id
        OR homeroom.school_id = target_school_id
      UNION ALL
      SELECT homeroom.school_id
      FROM homeroom_teachers AS relationship
      LEFT JOIN homerooms AS homeroom ON homeroom.id = relationship.homeroom_id
      WHERE relationship.school_id = target_school_id
        OR homeroom.school_id = target_school_id
      UNION ALL
      SELECT relationship.school_id
      FROM teacher_students AS relationship
      LEFT JOIN students AS student ON student.id = relationship.student_id
      WHERE relationship.school_id = target_school_id
        OR student.school_id = target_school_id
      UNION ALL
      SELECT student.school_id
      FROM teacher_students AS relationship
      LEFT JOIN students AS student ON student.id = relationship.student_id
      WHERE relationship.school_id = target_school_id
        OR student.school_id = target_school_id
      UNION ALL
      SELECT teaching_session.school_id
      FROM teaching_sessions AS teaching_session
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE teaching_session.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT class_group.school_id
      FROM teaching_sessions AS teaching_session
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE teaching_session.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT session_staff.school_id
      FROM classpilot_session_staff AS session_staff
      LEFT JOIN teaching_sessions AS teaching_session
        ON teaching_session.id = session_staff.teaching_session_id
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE session_staff.school_id = target_school_id
        OR teaching_session.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT teaching_session.school_id
      FROM classpilot_session_staff AS session_staff
      LEFT JOIN teaching_sessions AS teaching_session
        ON teaching_session.id = session_staff.teaching_session_id
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE session_staff.school_id = target_school_id
        OR teaching_session.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT class_group.school_id
      FROM classpilot_session_staff AS session_staff
      LEFT JOIN teaching_sessions AS teaching_session
        ON teaching_session.id = session_staff.teaching_session_id
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE session_staff.school_id = target_school_id
        OR teaching_session.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT schedule_change.school_id
      FROM classpilot_schedule_change_legs AS schedule_leg
      LEFT JOIN classpilot_schedule_changes AS schedule_change
        ON schedule_change.id = schedule_leg.schedule_change_id
      LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
      WHERE schedule_leg.school_id = target_school_id
        OR schedule_change.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT schedule_leg.school_id
      FROM classpilot_schedule_change_legs AS schedule_leg
      LEFT JOIN classpilot_schedule_changes AS schedule_change
        ON schedule_change.id = schedule_leg.schedule_change_id
      LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
      WHERE schedule_leg.school_id = target_school_id
        OR schedule_change.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT class_group.school_id
      FROM classpilot_schedule_change_legs AS schedule_leg
      LEFT JOIN classpilot_schedule_changes AS schedule_change
        ON schedule_change.id = schedule_leg.schedule_change_id
      LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
      WHERE schedule_leg.school_id = target_school_id
        OR schedule_change.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT conflict.school_id
      FROM classpilot_scheduled_conflicts AS conflict
      LEFT JOIN groups AS class_group ON class_group.id = conflict.group_id
      WHERE conflict.school_id = target_school_id
        OR class_group.school_id = target_school_id
      UNION ALL
      SELECT class_group.school_id
      FROM classpilot_scheduled_conflicts AS conflict
      LEFT JOIN groups AS class_group ON class_group.id = conflict.group_id
      WHERE conflict.school_id = target_school_id
        OR class_group.school_id = target_school_id
    ) AS raw_school
    WHERE raw_school.school_id IS NOT NULL
  ) AS candidate;
$staff_assignment_touched_schools$;

CREATE OR REPLACE FUNCTION schoolpilot_assert_live_staff_dependency(
  target_kind TEXT,
  target_id TEXT,
  locked_school_ids TEXT[] DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_live_dependency$
DECLARE
  resolved_school_id TEXT;
  owner_user_id TEXT;
  required_eligibility TEXT;
  dependency_is_live BOOLEAN := false;
  tenant_scope_valid BOOLEAN := true;
  dependency_touches_live_school BOOLEAN;
  dependency_found BOOLEAN := false;
  touched_school_ids TEXT[];
  previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  CASE target_kind
    WHEN 'passpilot_legacy_class' THEN
      SELECT
        grade.school_id,
        relationship.teacher_id,
        COALESCE(school_settings.passpilot_class_source, 'legacy_grades') = 'legacy_grades',
        ARRAY[grade.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM teacher_grades AS relationship
      INNER JOIN grades AS grade ON grade.id = relationship.grade_id
      LEFT JOIN settings AS school_settings ON school_settings.school_id = grade.school_id
      WHERE relationship.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'teacher_student_assignment' THEN
      SELECT
        student.school_id,
        relationship.teacher_id,
        student.status = 'active',
        student.status <> 'active'
          OR relationship.school_id IS NOT DISTINCT FROM student.school_id,
        schoolpilot_staff_assignment_school_is_live(student.school_id)
          OR schoolpilot_staff_assignment_school_is_live(relationship.school_id),
        ARRAY[student.school_id, relationship.school_id]::TEXT[]
      INTO
        resolved_school_id,
        owner_user_id,
        dependency_is_live,
        tenant_scope_valid,
        dependency_touches_live_school,
        touched_school_ids
      FROM teacher_students AS relationship
      INNER JOIN students AS student ON student.id = relationship.student_id
      WHERE relationship.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'flight_path' THEN
      SELECT
        resource.school_id,
        resource.teacher_id,
        resource.teacher_id IS NOT NULL,
        ARRAY[resource.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM flight_paths AS resource
      WHERE resource.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'block_list' THEN
      SELECT
        resource.school_id,
        resource.teacher_id,
        true,
        ARRAY[resource.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM block_lists AS resource
      WHERE resource.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'student_group' THEN
      SELECT
        resource.school_id,
        resource.teacher_id,
        resource.teacher_id IS NOT NULL,
        ARRAY[resource.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM student_groups AS resource
      WHERE resource.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'coverage_assignment' THEN
      SELECT
        assignment.school_id,
        assignment.staff_id,
        assignment.active,
        ARRAY[assignment.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM classpilot_coverage_assignments AS assignment
      WHERE assignment.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'active_staff';

    WHEN 'central_email_recipient' THEN
      SELECT
        school_settings.school_id,
        school_settings.central_email_recipient_user_id,
        school_settings.central_email_recipient_user_id IS NOT NULL,
        ARRAY[school_settings.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM settings AS school_settings
      WHERE school_settings.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'active_staff';

    WHEN 'active_teaching_session' THEN
      SELECT
        class_group.school_id,
        teaching_session.teacher_id,
        teaching_session.end_time IS NULL,
        teaching_session.end_time IS NOT NULL
          OR (
            class_group.id IS NOT NULL
            AND (
              teaching_session.school_id IS NULL
              OR teaching_session.school_id = class_group.school_id
            )
          ),
        (
          class_group.id IS NULL
          AND teaching_session.school_id IS NULL
        )
          OR schoolpilot_staff_assignment_school_is_live(class_group.school_id)
          OR schoolpilot_staff_assignment_school_is_live(teaching_session.school_id),
        ARRAY[class_group.school_id, teaching_session.school_id]::TEXT[]
      INTO
        resolved_school_id,
        owner_user_id,
        dependency_is_live,
        tenant_scope_valid,
        dependency_touches_live_school,
        touched_school_ids
      FROM teaching_sessions AS teaching_session
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE teaching_session.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'active_session_staff' THEN
      SELECT
        class_group.school_id,
        session_staff.staff_id,
        teaching_session.end_time IS NULL,
        teaching_session.end_time IS NOT NULL
          OR (
            class_group.id IS NOT NULL
            AND (
              teaching_session.school_id IS NULL
              OR teaching_session.school_id = class_group.school_id
            )
            AND session_staff.school_id = class_group.school_id
          ),
        schoolpilot_staff_assignment_school_is_live(class_group.school_id)
          OR schoolpilot_staff_assignment_school_is_live(teaching_session.school_id)
          OR schoolpilot_staff_assignment_school_is_live(session_staff.school_id),
        ARRAY[
          class_group.school_id,
          teaching_session.school_id,
          session_staff.school_id
        ]::TEXT[]
      INTO
        resolved_school_id,
        owner_user_id,
        dependency_is_live,
        tenant_scope_valid,
        dependency_touches_live_school,
        touched_school_ids
      FROM classpilot_session_staff AS session_staff
      INNER JOIN teaching_sessions AS teaching_session
        ON teaching_session.id = session_staff.teaching_session_id
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE session_staff.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'active_supervision_context' THEN
      SELECT
        context.school_id,
        context.assigned_staff_id,
        context.status = 'active' AND context.ended_at IS NULL,
        ARRAY[context.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM classpilot_supervision_contexts AS context
      WHERE context.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'active_staff';

    WHEN 'active_kiosk_session' THEN
      SELECT
        kiosk_session.school_id,
        kiosk_session.teacher_id,
        kiosk_session.status = 'active' AND kiosk_session.teacher_id IS NOT NULL,
        ARRAY[kiosk_session.school_id]::TEXT[]
      INTO resolved_school_id, owner_user_id, dependency_is_live, touched_school_ids
      FROM passpilot_kiosk_sessions AS kiosk_session
      WHERE kiosk_session.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'active_staff';

    WHEN 'active_schedule_change' THEN
      SELECT
        schedule_leg.school_id,
        schedule_leg.primary_teacher_id_snapshot,
        schedule_change.reservation_active = true
          AND schedule_leg.reservation_active = true
          AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved'),
        NOT (
          schedule_change.reservation_active = true
          AND schedule_leg.reservation_active = true
          AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved')
        ) OR (
          schedule_change.school_id = schedule_leg.school_id
          AND class_group.id IS NOT NULL
          AND class_group.school_id = schedule_leg.school_id
        ),
        schoolpilot_staff_assignment_school_is_live(schedule_change.school_id)
          OR schoolpilot_staff_assignment_school_is_live(schedule_leg.school_id)
          OR schoolpilot_staff_assignment_school_is_live(class_group.school_id),
        ARRAY[
          schedule_change.school_id,
          schedule_leg.school_id,
          class_group.school_id
        ]::TEXT[]
      INTO
        resolved_school_id,
        owner_user_id,
        dependency_is_live,
        tenant_scope_valid,
        dependency_touches_live_school,
        touched_school_ids
      FROM classpilot_schedule_change_legs AS schedule_leg
      INNER JOIN classpilot_schedule_changes AS schedule_change
        ON schedule_change.id = schedule_leg.schedule_change_id
      LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
      WHERE schedule_leg.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    WHEN 'active_scheduled_conflict' THEN
      SELECT
        conflict.school_id,
        conflict.teacher_id,
        conflict.status IN ('coverage_needed', 'claimed', 'pending'),
        conflict.status NOT IN ('coverage_needed', 'claimed', 'pending')
          OR (
            class_group.id IS NOT NULL
            AND class_group.school_id = conflict.school_id
          ),
        schoolpilot_staff_assignment_school_is_live(conflict.school_id)
          OR schoolpilot_staff_assignment_school_is_live(class_group.school_id),
        ARRAY[conflict.school_id, class_group.school_id]::TEXT[]
      INTO
        resolved_school_id,
        owner_user_id,
        dependency_is_live,
        tenant_scope_valid,
        dependency_touches_live_school,
        touched_school_ids
      FROM classpilot_scheduled_conflicts AS conflict
      LEFT JOIN groups AS class_group ON class_group.id = conflict.group_id
      WHERE conflict.id = target_id;
      dependency_found := FOUND;
      required_eligibility := 'base_teaching';

    ELSE
      RAISE EXCEPTION 'STAFF_DEPENDENCY_KIND_UNKNOWN'
        USING ERRCODE = '22023', CONSTRAINT = 'staff_live_dependency_kind';
  END CASE;

  IF NOT dependency_found THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  dependency_touches_live_school := COALESCE(
    dependency_touches_live_school,
    schoolpilot_staff_assignment_school_is_live(resolved_school_id)
  );

  SELECT COALESCE(array_agg(touched.school_id ORDER BY touched.school_id), ARRAY[]::TEXT[])
  INTO touched_school_ids
  FROM (
    SELECT DISTINCT candidate.school_id
    FROM unnest(COALESCE(touched_school_ids, ARRAY[resolved_school_id]::TEXT[]))
      AS candidate(school_id)
    WHERE candidate.school_id IS NOT NULL
  ) AS touched;

  IF resolved_school_id IS NULL THEN
    IF dependency_is_live IS TRUE THEN
      RAISE EXCEPTION 'STAFF_DEPENDENCY_SCHOOL_MISMATCH'
        USING ERRCODE = '23514', CONSTRAINT = 'staff_live_dependency_tenant_scope';
    END IF;
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  -- Lock even an inactive dependency before deciding that it is exempt. A
  -- parent row (student status, PassPilot source, schedule-change status, or
  -- teaching-session end state) can make it live concurrently. Re-enter after
  -- the lock so the final predicate is evaluated from a fresh READ COMMITTED
  -- statement snapshot.
  IF locked_school_ids IS NULL THEN
    PERFORM schoolpilot_lock_staff_assignment_schools(touched_school_ids);
    PERFORM schoolpilot_assert_live_staff_dependency(
      target_kind,
      target_id,
      touched_school_ids
    );
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  IF locked_school_ids IS DISTINCT FROM touched_school_ids THEN
    RAISE EXCEPTION 'STAFF_DEPENDENCY_SCHOOL_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'staff_live_dependency_tenant_scope';
  END IF;

  -- Deleted tenants are historical, but their writers still serialize with a
  -- possible restore. The recursive pass above observes the restore winner's
  -- committed state before deciding whether this dependency remains exempt.
  IF dependency_touches_live_school IS NOT TRUE THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  IF tenant_scope_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'STAFF_DEPENDENCY_SCHOOL_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'staff_live_dependency_tenant_scope';
  END IF;

  IF dependency_is_live IS NOT TRUE OR owner_user_id IS NULL THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  IF required_eligibility = 'base_teaching' AND NOT EXISTS (
    SELECT 1
    FROM school_memberships AS membership
    INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
    WHERE membership.school_id = resolved_school_id
      AND membership.user_id = owner_user_id
      AND membership.status = 'active'
      AND membership.role IN ('teacher', 'admin', 'school_admin')
  ) THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENT_INELIGIBLE'
      USING ERRCODE = '23514', CONSTRAINT = 'staff_live_dependency_teaching_membership';
  END IF;

  IF required_eligibility = 'active_staff' AND NOT EXISTS (
    SELECT 1
    FROM school_memberships AS membership
    INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
    WHERE membership.school_id = resolved_school_id
      AND membership.user_id = owner_user_id
      AND membership.status = 'active'
      AND membership.role IN ('teacher', 'admin', 'school_admin', 'office_staff')
  ) THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENT_INELIGIBLE'
      USING ERRCODE = '23514', CONSTRAINT = 'staff_live_dependency_active_membership';
  END IF;

  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$staff_live_dependency$;

CREATE OR REPLACE FUNCTION schoolpilot_check_live_staff_dependency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_live_dependency_trigger$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  PERFORM schoolpilot_assert_live_staff_dependency(TG_ARGV[0], NEW.id);
  RETURN NEW;
END;
$staff_live_dependency_trigger$;

CREATE OR REPLACE FUNCTION schoolpilot_check_parent_staff_dependencies()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_parent_dependency_trigger$
DECLARE
  dependency RECORD;
  old_parent_school_id TEXT;
  new_parent_school_id TEXT;
  previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'settings' THEN
      PERFORM schoolpilot_lock_staff_assignment_schools(ARRAY[OLD.school_id]::TEXT[]);
      FOR dependency IN
        SELECT relationship.id
        FROM teacher_grades AS relationship
        INNER JOIN grades AS grade ON grade.id = relationship.grade_id
        WHERE grade.school_id = OLD.school_id
      LOOP
        PERFORM schoolpilot_assert_live_staff_dependency(
          'passpilot_legacy_class', dependency.id
        );
      END LOOP;
    ELSIF TG_TABLE_NAME = 'groups' THEN
      PERFORM schoolpilot_lock_staff_assignment_schools(ARRAY[OLD.school_id]::TEXT[]);
      FOR dependency IN
        SELECT teaching_session.id
        FROM teaching_sessions AS teaching_session
        WHERE teaching_session.group_id = OLD.id
      LOOP
        PERFORM schoolpilot_assert_live_staff_dependency(
          'active_teaching_session', dependency.id
        );
      END LOOP;
      FOR dependency IN
        SELECT session_staff.id
        FROM classpilot_session_staff AS session_staff
        INNER JOIN teaching_sessions AS teaching_session
          ON teaching_session.id = session_staff.teaching_session_id
        WHERE teaching_session.group_id = OLD.id
      LOOP
        PERFORM schoolpilot_assert_live_staff_dependency(
          'active_session_staff', dependency.id
        );
      END LOOP;
      FOR dependency IN
        SELECT conflict.id
        FROM classpilot_scheduled_conflicts AS conflict
        WHERE conflict.group_id = OLD.id
      LOOP
        PERFORM schoolpilot_assert_live_staff_dependency(
          'active_scheduled_conflict', dependency.id
        );
      END LOOP;
    END IF;
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'settings' THEN
    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[
        NEW.school_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.school_id ELSE NULL END
      ]::TEXT[]
    );
    PERFORM schoolpilot_assert_live_staff_dependency('central_email_recipient', NEW.id);
    FOR dependency IN
      SELECT relationship.id
      FROM teacher_grades AS relationship
      INNER JOIN grades AS grade ON grade.id = relationship.grade_id
      WHERE grade.school_id = NEW.school_id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'passpilot_legacy_class', dependency.id
      );
    END LOOP;
    IF TG_OP = 'UPDATE' AND OLD.school_id IS DISTINCT FROM NEW.school_id THEN
      FOR dependency IN
        SELECT relationship.id
        FROM teacher_grades AS relationship
        INNER JOIN grades AS grade ON grade.id = relationship.grade_id
        WHERE grade.school_id = OLD.school_id
      LOOP
        PERFORM schoolpilot_assert_live_staff_dependency(
          'passpilot_legacy_class', dependency.id
        );
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'grades' THEN
    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[
        NEW.school_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.school_id ELSE NULL END
      ]::TEXT[]
    );
    FOR dependency IN
      SELECT relationship.id
      FROM teacher_grades AS relationship
      WHERE relationship.grade_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'passpilot_legacy_class', dependency.id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'students' THEN
    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[
        NEW.school_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.school_id ELSE NULL END
      ]::TEXT[]
    );
    FOR dependency IN
      SELECT relationship.id
      FROM teacher_students AS relationship
      WHERE relationship.student_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'teacher_student_assignment', dependency.id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'teaching_sessions' THEN
    SELECT class_group.school_id
    INTO new_parent_school_id
    FROM groups AS class_group
    WHERE class_group.id = NEW.group_id;
    IF TG_OP = 'UPDATE' THEN
      SELECT class_group.school_id
      INTO old_parent_school_id
      FROM groups AS class_group
      WHERE class_group.id = OLD.group_id;
    END IF;
    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[
        NEW.school_id,
        new_parent_school_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.school_id ELSE NULL END,
        old_parent_school_id
      ]::TEXT[]
    );
    PERFORM schoolpilot_assert_live_staff_dependency('active_teaching_session', NEW.id);
    FOR dependency IN
      SELECT session_staff.id
      FROM classpilot_session_staff AS session_staff
      WHERE session_staff.teaching_session_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'active_session_staff', dependency.id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'classpilot_schedule_changes' THEN
    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[
        NEW.school_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.school_id ELSE NULL END
      ]::TEXT[]
    );
    FOR dependency IN
      SELECT schedule_leg.id
      FROM classpilot_schedule_change_legs AS schedule_leg
      WHERE schedule_leg.schedule_change_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'active_schedule_change', dependency.id
      );
    END LOOP;
  ELSIF TG_TABLE_NAME = 'groups' THEN
    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[
        NEW.school_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.school_id ELSE NULL END
      ]::TEXT[]
    );
    PERFORM schoolpilot_assert_admin_class_staff_integrity(NEW.id);
    FOR dependency IN
      SELECT teaching_session.id
      FROM teaching_sessions AS teaching_session
      WHERE teaching_session.group_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'active_teaching_session', dependency.id
      );
    END LOOP;
    FOR dependency IN
      SELECT session_staff.id
      FROM classpilot_session_staff AS session_staff
      INNER JOIN teaching_sessions AS teaching_session
        ON teaching_session.id = session_staff.teaching_session_id
      WHERE teaching_session.group_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'active_session_staff', dependency.id
      );
    END LOOP;
    FOR dependency IN
      SELECT schedule_leg.id
      FROM classpilot_schedule_change_legs AS schedule_leg
      WHERE schedule_leg.group_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'active_schedule_change', dependency.id
      );
    END LOOP;
    FOR dependency IN
      SELECT conflict.id
      FROM classpilot_scheduled_conflicts AS conflict
      WHERE conflict.group_id = NEW.id
    LOOP
      PERFORM schoolpilot_assert_live_staff_dependency(
        'active_scheduled_conflict', dependency.id
      );
    END LOOP;
  END IF;

  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$staff_parent_dependency_trigger$;

CREATE OR REPLACE FUNCTION schoolpilot_assert_no_active_schedule_change_for_group(
  target_group_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_schedule_change_ownership$
DECLARE
  target_school_id TEXT;
  locked_school_id TEXT;
  previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  SELECT class_group.school_id
  INTO target_school_id
  FROM groups AS class_group
  WHERE class_group.id = target_group_id;
  IF NOT FOUND THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  locked_school_id := target_school_id;
  PERFORM schoolpilot_lock_staff_assignment_school(target_school_id);
  SELECT class_group.school_id
  INTO target_school_id
  FROM groups AS class_group
  WHERE class_group.id = target_group_id;
  IF NOT FOUND OR target_school_id IS DISTINCT FROM locked_school_id THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENT_PARENT_CHANGED'
      USING ERRCODE = '40001', CONSTRAINT = 'staff_assignment_parent_school_race';
  END IF;
  IF NOT schoolpilot_staff_assignment_school_is_live(target_school_id) THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM classpilot_schedule_change_legs AS schedule_leg
    INNER JOIN classpilot_schedule_changes AS schedule_change
      ON schedule_change.id = schedule_leg.schedule_change_id
      AND schedule_change.school_id = schedule_leg.school_id
    WHERE schedule_leg.group_id = target_group_id
      AND schedule_leg.school_id = target_school_id
      AND schedule_leg.reservation_active = true
      AND schedule_change.reservation_active = true
      AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved')
  ) THEN
    RAISE EXCEPTION 'STAFF_ACTIVE_SCHEDULE_CHANGE_OWNERSHIP_LOCKED'
      USING ERRCODE = '23514', CONSTRAINT = 'classpilot_active_schedule_change_ownership';
  END IF;

  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$staff_schedule_change_ownership$;

CREATE OR REPLACE FUNCTION schoolpilot_assert_admin_class_staff_integrity(
  target_group_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_integrity_function$
DECLARE
  class_row RECORD;
  locked_school_id TEXT;
  primary_relationship_count INTEGER;
  matching_primary_count INTEGER;
  previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  SELECT id, school_id
  INTO class_row
  FROM groups
  WHERE id = target_group_id;

  IF NOT FOUND THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  locked_school_id := class_row.school_id;
  PERFORM schoolpilot_lock_staff_assignment_school(locked_school_id);

  -- Re-read after a possibly-blocking advisory lock so every predicate below
  -- observes the transaction that won the school-scoped serialization race.
  SELECT id, school_id, teacher_id, group_type, status
  INTO class_row
  FROM groups
  WHERE id = target_group_id;

  IF NOT FOUND THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;
  IF class_row.school_id IS DISTINCT FROM locked_school_id THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENT_PARENT_CHANGED'
      USING ERRCODE = '40001', CONSTRAINT = 'staff_assignment_parent_school_race';
  END IF;
  IF class_row.group_type NOT IN ('admin_class', 'teacher_created', 'teacher_small_group')
    OR class_row.status <> 'active'
    OR NOT schoolpilot_staff_assignment_school_is_live(class_row.school_id)
  THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM school_memberships AS membership
    INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
    WHERE membership.school_id = class_row.school_id
      AND membership.user_id = class_row.teacher_id
      AND membership.status = 'active'
      AND membership.role IN ('teacher', 'admin', 'school_admin')
  ) THEN
    RAISE EXCEPTION 'STAFF_CLASS_ASSIGNMENT_INELIGIBLE'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'classpilot_active_primary_teacher_membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM group_teachers AS relationship
    WHERE relationship.group_id = class_row.id
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = class_row.school_id
          AND membership.user_id = relationship.teacher_id
          AND membership.status = 'active'
          AND membership.role IN ('teacher', 'admin', 'school_admin')
      )
  ) THEN
    RAISE EXCEPTION 'STAFF_CLASS_ASSIGNMENT_INELIGIBLE'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'classpilot_active_group_teacher_membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM group_teachers AS relationship
    WHERE relationship.group_id = class_row.id
      AND (
        relationship.role NOT IN ('primary', 'co-teacher')
        OR (
          relationship.role = 'primary'
          AND relationship.teacher_id IS DISTINCT FROM class_row.teacher_id
        )
        OR (
          relationship.role = 'co-teacher'
          AND relationship.teacher_id IS NOT DISTINCT FROM class_row.teacher_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'STAFF_CLASS_PRIMARY_MIRROR_MISMATCH'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'classpilot_admin_class_primary_teacher_mirror';
  END IF;

  SELECT
    count(*) FILTER (WHERE relationship.role = 'primary'),
    count(*) FILTER (
      WHERE relationship.role = 'primary'
        AND relationship.teacher_id = class_row.teacher_id
    )
  INTO primary_relationship_count, matching_primary_count
  FROM group_teachers AS relationship
  WHERE relationship.group_id = class_row.id;

  IF primary_relationship_count <> 1 OR matching_primary_count <> 1 THEN
    RAISE EXCEPTION 'STAFF_CLASS_PRIMARY_MIRROR_MISMATCH'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'classpilot_admin_class_primary_teacher_mirror';
  END IF;
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$staff_integrity_function$;

CREATE OR REPLACE FUNCTION schoolpilot_check_admin_class_staff_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_group_trigger$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.teacher_id IS DISTINCT FROM NEW.teacher_id THEN
    PERFORM schoolpilot_assert_no_active_schedule_change_for_group(NEW.id);
  END IF;
  PERFORM schoolpilot_assert_admin_class_staff_integrity(NEW.id);
  RETURN NEW;
END;
$staff_group_trigger$;

CREATE OR REPLACE FUNCTION schoolpilot_check_group_teacher_staff_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_relationship_trigger$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM schoolpilot_assert_no_active_schedule_change_for_group(OLD.group_id);
    PERFORM schoolpilot_assert_admin_class_staff_integrity(OLD.group_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE'
    AND (
      OLD.group_id IS DISTINCT FROM NEW.group_id
      OR OLD.teacher_id IS DISTINCT FROM NEW.teacher_id
      OR OLD.role IS DISTINCT FROM NEW.role
    )
  ) THEN
    PERFORM schoolpilot_assert_no_active_schedule_change_for_group(NEW.group_id);
    IF TG_OP = 'UPDATE' AND OLD.group_id IS DISTINCT FROM NEW.group_id THEN
      PERFORM schoolpilot_assert_no_active_schedule_change_for_group(OLD.group_id);
    END IF;
  END IF;
  PERFORM schoolpilot_assert_admin_class_staff_integrity(NEW.group_id);
  IF TG_OP = 'UPDATE' AND OLD.group_id <> NEW.group_id THEN
    PERFORM schoolpilot_assert_admin_class_staff_integrity(OLD.group_id);
  END IF;
  RETURN NEW;
END;
$staff_relationship_trigger$;

CREATE OR REPLACE FUNCTION schoolpilot_check_departing_staff_assignments()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $staff_membership_trigger$
DECLARE
  has_base_teaching_membership BOOLEAN;
  has_gopilot_teaching_membership BOOLEAN;
  has_active_staff_membership BOOLEAN;
  loses_base_teaching_membership BOOLEAN;
  loses_gopilot_teaching_membership BOOLEAN;
  loses_active_staff_membership BOOLEAN;
  previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  PERFORM schoolpilot_lock_staff_assignment_schools(
    ARRAY[
      OLD.school_id,
      CASE WHEN TG_OP = 'UPDATE' THEN NEW.school_id ELSE NULL END
    ]::TEXT[]
  );

  IF NOT schoolpilot_staff_assignment_school_is_live(OLD.school_id) THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM school_memberships AS remaining
    INNER JOIN users AS membership_user ON membership_user.id = remaining.user_id
    WHERE remaining.school_id = OLD.school_id
      AND remaining.user_id = OLD.user_id
      AND remaining.status = 'active'
      AND remaining.role IN ('teacher', 'admin', 'school_admin')
  ) INTO has_base_teaching_membership;

  loses_base_teaching_membership :=
    OLD.status = 'active'
    AND OLD.role IN ('teacher', 'admin', 'school_admin')
    AND NOT has_base_teaching_membership;

  IF loses_base_teaching_membership AND (
    EXISTS (
      SELECT 1
      FROM groups AS class_group
      WHERE class_group.school_id = OLD.school_id
        AND class_group.group_type IN ('admin_class', 'teacher_created', 'teacher_small_group')
        AND class_group.status = 'active'
        AND (
          class_group.teacher_id = OLD.user_id
          OR EXISTS (
            SELECT 1
            FROM group_teachers AS relationship
            WHERE relationship.group_id = class_group.id
              AND relationship.teacher_id = OLD.user_id
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM teacher_grades AS relationship
      INNER JOIN grades AS grade ON grade.id = relationship.grade_id
      LEFT JOIN settings AS school_settings ON school_settings.school_id = grade.school_id
      WHERE grade.school_id = OLD.school_id
        AND relationship.teacher_id = OLD.user_id
        AND COALESCE(school_settings.passpilot_class_source, 'legacy_grades') = 'legacy_grades'
    )
    OR EXISTS (
      SELECT 1
      FROM teacher_students AS relationship
      INNER JOIN students AS student ON student.id = relationship.student_id
      WHERE student.school_id = OLD.school_id
        AND student.status = 'active'
        AND relationship.teacher_id = OLD.user_id
    )
    OR EXISTS (
      SELECT 1 FROM flight_paths AS resource
      WHERE resource.school_id = OLD.school_id
        AND resource.teacher_id = OLD.user_id
    )
    OR EXISTS (
      SELECT 1 FROM block_lists AS resource
      WHERE resource.school_id = OLD.school_id
        AND resource.teacher_id = OLD.user_id
    )
    OR EXISTS (
      SELECT 1 FROM student_groups AS resource
      WHERE resource.school_id = OLD.school_id
        AND resource.teacher_id = OLD.user_id
    )
    OR EXISTS (
      SELECT 1
      FROM teaching_sessions AS teaching_session
      INNER JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE class_group.school_id = OLD.school_id
        AND (
          teaching_session.school_id IS NULL
          OR teaching_session.school_id = class_group.school_id
        )
        AND teaching_session.teacher_id = OLD.user_id
        AND teaching_session.end_time IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM classpilot_session_staff AS session_staff
      INNER JOIN teaching_sessions AS teaching_session
        ON teaching_session.id = session_staff.teaching_session_id
      INNER JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE class_group.school_id = OLD.school_id
        AND (
          teaching_session.school_id IS NULL
          OR teaching_session.school_id = class_group.school_id
        )
        AND session_staff.school_id = class_group.school_id
        AND session_staff.staff_id = OLD.user_id
        AND teaching_session.end_time IS NULL
    )
    -- A kiosk may be owned by office staff, but an existing teacher-owned
    -- kiosk is still a blocker for a teacher -> non-teaching role change.
    OR EXISTS (
      SELECT 1
      FROM passpilot_kiosk_sessions AS kiosk_session
      WHERE kiosk_session.school_id = OLD.school_id
        AND kiosk_session.teacher_id = OLD.user_id
        AND kiosk_session.status = 'active'
    )
    OR EXISTS (
      SELECT 1
      FROM classpilot_schedule_change_legs AS schedule_leg
      INNER JOIN classpilot_schedule_changes AS schedule_change
        ON schedule_change.id = schedule_leg.schedule_change_id
        AND schedule_change.school_id = schedule_leg.school_id
      WHERE schedule_leg.school_id = OLD.school_id
        AND schedule_leg.primary_teacher_id_snapshot = OLD.user_id
        AND schedule_leg.reservation_active = true
        AND schedule_change.reservation_active = true
        AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved')
    )
    OR EXISTS (
      SELECT 1
      FROM classpilot_scheduled_conflicts AS conflict
      WHERE conflict.school_id = OLD.school_id
        AND conflict.teacher_id = OLD.user_id
        AND conflict.status IN ('coverage_needed', 'claimed', 'pending')
    )
  ) THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'staff_live_teaching_dependency_membership';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM school_memberships AS remaining
    INNER JOIN users AS membership_user ON membership_user.id = remaining.user_id
    WHERE remaining.school_id = OLD.school_id
      AND remaining.user_id = OLD.user_id
      AND remaining.status = 'active'
      AND COALESCE(NULLIF(BTRIM(remaining.gopilot_role), ''), remaining.role)
        = 'teacher'
  ) INTO has_gopilot_teaching_membership;

  loses_gopilot_teaching_membership :=
    OLD.status = 'active'
    AND COALESCE(NULLIF(BTRIM(OLD.gopilot_role), ''), OLD.role) = 'teacher'
    AND NOT has_gopilot_teaching_membership;

  IF loses_gopilot_teaching_membership AND (
    EXISTS (
      SELECT 1
      FROM homerooms AS homeroom
      WHERE homeroom.school_id = OLD.school_id
        AND homeroom.teacher_id = OLD.user_id
    )
    OR EXISTS (
      SELECT 1
      FROM homeroom_teachers AS relationship
      WHERE relationship.school_id = OLD.school_id
        AND relationship.teacher_id = OLD.user_id
    )
  ) THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'gopilot_active_staff_assignment_membership';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM school_memberships AS remaining
    INNER JOIN users AS membership_user ON membership_user.id = remaining.user_id
    WHERE remaining.school_id = OLD.school_id
      AND remaining.user_id = OLD.user_id
      AND remaining.status = 'active'
      AND remaining.role IN ('teacher', 'admin', 'school_admin', 'office_staff')
  ) INTO has_active_staff_membership;

  loses_active_staff_membership :=
    OLD.status = 'active'
    AND OLD.role IN ('teacher', 'admin', 'school_admin', 'office_staff')
    AND NOT has_active_staff_membership;

  IF loses_active_staff_membership AND (
    EXISTS (
      SELECT 1
      FROM classpilot_coverage_assignments AS assignment
      WHERE assignment.school_id = OLD.school_id
        AND assignment.staff_id = OLD.user_id
        AND assignment.active = true
    )
    OR EXISTS (
      SELECT 1
      FROM settings AS school_settings
      WHERE school_settings.school_id = OLD.school_id
        AND school_settings.central_email_recipient_user_id = OLD.user_id
    )
    OR EXISTS (
      SELECT 1
      FROM classpilot_supervision_contexts AS context
      WHERE context.school_id = OLD.school_id
        AND context.assigned_staff_id = OLD.user_id
        AND context.status = 'active'
        AND context.ended_at IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM passpilot_kiosk_sessions AS kiosk_session
      WHERE kiosk_session.school_id = OLD.school_id
        AND kiosk_session.teacher_id = OLD.user_id
        AND kiosk_session.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'staff_live_active_dependency_membership';
  END IF;

  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$staff_membership_trigger$;

CREATE OR REPLACE FUNCTION schoolpilot_assert_gopilot_homeroom_staff_integrity(
  target_homeroom_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $gopilot_homeroom_integrity$
DECLARE
  homeroom_row RECORD;
  locked_homeroom_school_id TEXT;
  touched_school_ids TEXT[];
  primary_relationship_count INTEGER;
  matching_primary_count INTEGER;
  previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  SELECT homeroom.id, homeroom.school_id
  INTO homeroom_row
  FROM homerooms AS homeroom
  WHERE homeroom.id = target_homeroom_id;
  IF NOT FOUND THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  locked_homeroom_school_id := homeroom_row.school_id;
  SELECT COALESCE(
    array_agg(candidate.school_id ORDER BY candidate.school_id),
    ARRAY[]::TEXT[]
  )
  INTO touched_school_ids
  FROM (
    SELECT DISTINCT school_id
    FROM (
      SELECT homeroom_row.school_id AS school_id
      UNION ALL
      SELECT relationship.school_id
      FROM homeroom_teachers AS relationship
      WHERE relationship.homeroom_id = target_homeroom_id
    ) AS raw_school
    WHERE raw_school.school_id IS NOT NULL
  ) AS candidate;
  PERFORM schoolpilot_lock_staff_assignment_schools(touched_school_ids);
  SELECT homeroom.id, homeroom.school_id, homeroom.teacher_id
  INTO homeroom_row
  FROM homerooms AS homeroom
  WHERE homeroom.id = target_homeroom_id;
  IF NOT FOUND THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;
  IF homeroom_row.school_id IS DISTINCT FROM locked_homeroom_school_id THEN
    RAISE EXCEPTION 'STAFF_ASSIGNMENT_PARENT_CHANGED'
      USING ERRCODE = '40001', CONSTRAINT = 'staff_assignment_parent_school_race';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM homeroom_teachers AS relationship
    WHERE relationship.homeroom_id = homeroom_row.id
      AND relationship.school_id <> homeroom_row.school_id
      AND (
        schoolpilot_staff_assignment_school_is_live(relationship.school_id)
        OR schoolpilot_staff_assignment_school_is_live(homeroom_row.school_id)
      )
  ) THEN
    RAISE EXCEPTION 'GOPILOT_HOMEROOM_SCHOOL_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'gopilot_homeroom_teacher_same_school';
  END IF;

  IF NOT schoolpilot_staff_assignment_school_is_live(homeroom_row.school_id) THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  IF homeroom_row.teacher_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM school_memberships AS membership
    INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
    WHERE membership.school_id = homeroom_row.school_id
      AND membership.user_id = homeroom_row.teacher_id
      AND membership.status = 'active'
      AND COALESCE(NULLIF(BTRIM(membership.gopilot_role), ''), membership.role)
        = 'teacher'
  ) THEN
    RAISE EXCEPTION 'GOPILOT_HOMEROOM_TEACHER_INELIGIBLE'
      USING ERRCODE = '23514', CONSTRAINT = 'gopilot_active_homeroom_teacher_membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM homeroom_teachers AS relationship
    WHERE relationship.homeroom_id = homeroom_row.id
      AND relationship.school_id = homeroom_row.school_id
      AND (
        relationship.role NOT IN ('primary', 'co-teacher')
        OR (
          relationship.role = 'primary'
          AND relationship.teacher_id IS DISTINCT FROM homeroom_row.teacher_id
        )
        OR (
          relationship.role = 'co-teacher'
          AND relationship.teacher_id IS NOT DISTINCT FROM homeroom_row.teacher_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'GOPILOT_HOMEROOM_PRIMARY_MIRROR_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'gopilot_homeroom_primary_teacher_mirror';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM homeroom_teachers AS relationship
    WHERE relationship.homeroom_id = homeroom_row.id
      AND NOT EXISTS (
        SELECT 1
        FROM school_memberships AS membership
        INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
        WHERE membership.school_id = homeroom_row.school_id
          AND membership.user_id = relationship.teacher_id
          AND membership.status = 'active'
          AND COALESCE(NULLIF(BTRIM(membership.gopilot_role), ''), membership.role)
            = 'teacher'
      )
  ) THEN
    RAISE EXCEPTION 'GOPILOT_HOMEROOM_TEACHER_INELIGIBLE'
      USING ERRCODE = '23514', CONSTRAINT = 'gopilot_active_homeroom_teacher_membership';
  END IF;

  SELECT
    count(*) FILTER (WHERE relationship.role = 'primary'),
    count(*) FILTER (
      WHERE relationship.role = 'primary'
        AND relationship.teacher_id = homeroom_row.teacher_id
    )
  INTO primary_relationship_count, matching_primary_count
  FROM homeroom_teachers AS relationship
  WHERE relationship.homeroom_id = homeroom_row.id
    AND relationship.school_id = homeroom_row.school_id;

  IF (
    homeroom_row.teacher_id IS NULL
    AND primary_relationship_count <> 0
  ) OR (
    homeroom_row.teacher_id IS NOT NULL
    AND (
      primary_relationship_count <> 1
      OR matching_primary_count <> 1
    )
  ) THEN
    RAISE EXCEPTION 'GOPILOT_HOMEROOM_PRIMARY_MIRROR_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'gopilot_homeroom_primary_teacher_mirror';
  END IF;

  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$gopilot_homeroom_integrity$;

CREATE OR REPLACE FUNCTION schoolpilot_check_gopilot_homeroom_staff_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $gopilot_homeroom_integrity_trigger$
BEGIN
  IF TG_TABLE_NAME = 'homerooms' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM schoolpilot_assert_gopilot_homeroom_staff_integrity(NEW.id);
      RETURN NEW;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM schoolpilot_assert_gopilot_homeroom_staff_integrity(OLD.homeroom_id);
    RETURN OLD;
  END IF;
  PERFORM schoolpilot_assert_gopilot_homeroom_staff_integrity(NEW.homeroom_id);
  IF TG_OP = 'UPDATE' AND OLD.homeroom_id IS DISTINCT FROM NEW.homeroom_id THEN
    PERFORM schoolpilot_assert_gopilot_homeroom_staff_integrity(OLD.homeroom_id);
  END IF;
  RETURN NEW;
END;
$gopilot_homeroom_integrity_trigger$;

CREATE OR REPLACE FUNCTION gopilot_validate_homeroom_teacher()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $gopilot_homeroom_staff$
DECLARE
  resolved_school_id TEXT;
  homeroom_school_id TEXT;
  locked_homeroom_school_id TEXT;
  previous_is_super TEXT;
BEGIN
  IF TG_TABLE_NAME = 'homerooms' THEN
    IF NEW.teacher_id IS NULL THEN
      RETURN NEW;
    END IF;
    resolved_school_id := NEW.school_id;
  ELSE
    resolved_school_id := NEW.school_id;
  END IF;

  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  IF TG_TABLE_NAME = 'homeroom_teachers' THEN
    SELECT homeroom.school_id
    INTO homeroom_school_id
    FROM homerooms AS homeroom
    WHERE homeroom.id = NEW.homeroom_id;

    IF NOT FOUND THEN
      IF schoolpilot_staff_assignment_school_is_live(resolved_school_id) THEN
        RAISE EXCEPTION 'GOPILOT_HOMEROOM_SCHOOL_MISMATCH'
          USING
            ERRCODE = '23514',
            CONSTRAINT = 'gopilot_homeroom_teacher_same_school';
      END IF;
      PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
      RETURN NEW;
    END IF;

    locked_homeroom_school_id := homeroom_school_id;

    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[resolved_school_id, homeroom_school_id]::TEXT[]
    );

    -- The parent may have moved while this trigger waited. Refuse the stale
    -- write instead of acquiring a newly discovered tenant lock out of order.
    SELECT homeroom.school_id
    INTO homeroom_school_id
    FROM homerooms AS homeroom
    WHERE homeroom.id = NEW.homeroom_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'GOPILOT_HOMEROOM_SCHOOL_MISMATCH'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'gopilot_homeroom_teacher_same_school';
    END IF;
    IF homeroom_school_id IS DISTINCT FROM locked_homeroom_school_id THEN
      RAISE EXCEPTION 'GOPILOT_HOMEROOM_SCHOOL_MISMATCH'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'gopilot_homeroom_teacher_same_school';
    END IF;

    IF homeroom_school_id <> resolved_school_id AND (
      schoolpilot_staff_assignment_school_is_live(resolved_school_id)
      OR schoolpilot_staff_assignment_school_is_live(homeroom_school_id)
    ) THEN
      RAISE EXCEPTION 'GOPILOT_HOMEROOM_SCHOOL_MISMATCH'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'gopilot_homeroom_teacher_same_school';
    END IF;
  ELSE
    PERFORM schoolpilot_lock_staff_assignment_schools(
      ARRAY[
        resolved_school_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.school_id ELSE NULL END
      ]::TEXT[]
    );
  END IF;

  IF NOT schoolpilot_staff_assignment_school_is_live(resolved_school_id) THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM school_memberships AS membership
    INNER JOIN users AS membership_user ON membership_user.id = membership.user_id
    WHERE membership.school_id = resolved_school_id
      AND membership.user_id = NEW.teacher_id
      AND membership.status = 'active'
      AND COALESCE(NULLIF(BTRIM(membership.gopilot_role), ''), membership.role)
        = 'teacher'
  ) THEN
    RAISE EXCEPTION 'GOPILOT_HOMEROOM_TEACHER_INELIGIBLE'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'gopilot_active_homeroom_teacher_membership';
  END IF;
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$gopilot_homeroom_staff$;

CREATE OR REPLACE FUNCTION schoolpilot_assert_school_staff_integrity(
  target_school_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $school_staff_integrity$
DECLARE
  dependency RECORD;
  locked_school_ids TEXT[];
  refreshed_school_ids TEXT[];
  previous_is_super TEXT;
BEGIN
  previous_is_super := current_setting('app.is_super', true);
  PERFORM set_config('app.is_super', 'on', true);

  IF NOT schoolpilot_staff_assignment_school_is_live(target_school_id) THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  locked_school_ids := schoolpilot_staff_assignment_touched_schools(target_school_id);
  PERFORM schoolpilot_lock_staff_assignment_schools(locked_school_ids);
  IF NOT schoolpilot_staff_assignment_school_is_live(target_school_id) THEN
    PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
    RETURN;
  END IF;

  refreshed_school_ids := schoolpilot_staff_assignment_touched_schools(target_school_id);
  IF refreshed_school_ids IS DISTINCT FROM locked_school_ids THEN
    RAISE EXCEPTION 'SCHOOL_STAFF_ASSIGNMENT_INTEGRITY_CHANGED'
      USING ERRCODE = '40001', CONSTRAINT = 'school_staff_assignment_restore_race';
  END IF;

  -- A relationship may store one tenant while its authoritative parent stores
  -- another. Reactivating either side must surface the corruption even when
  -- the other side remains deleted.
  IF EXISTS (
    SELECT 1
    FROM homeroom_teachers AS relationship
    LEFT JOIN homerooms AS homeroom ON homeroom.id = relationship.homeroom_id
    WHERE (
        relationship.school_id = target_school_id
        OR homeroom.school_id = target_school_id
      )
      AND (
        homeroom.id IS NULL
        OR relationship.school_id <> homeroom.school_id
      )
      AND (
        schoolpilot_staff_assignment_school_is_live(relationship.school_id)
        OR schoolpilot_staff_assignment_school_is_live(homeroom.school_id)
      )
  ) THEN
    RAISE EXCEPTION 'GOPILOT_HOMEROOM_SCHOOL_MISMATCH'
      USING ERRCODE = '23514', CONSTRAINT = 'gopilot_homeroom_teacher_same_school';
  END IF;

  FOR dependency IN
    SELECT class_group.id
    FROM groups AS class_group
    WHERE class_group.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_admin_class_staff_integrity(dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT homeroom.id
    FROM homerooms AS homeroom
    WHERE homeroom.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_gopilot_homeroom_staff_integrity(dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT relationship.id
    FROM teacher_grades AS relationship
    INNER JOIN grades AS grade ON grade.id = relationship.grade_id
    WHERE grade.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('passpilot_legacy_class', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT relationship.id
    FROM teacher_students AS relationship
    INNER JOIN students AS student ON student.id = relationship.student_id
    WHERE student.school_id = target_school_id
      OR relationship.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('teacher_student_assignment', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT resource.id FROM flight_paths AS resource
    WHERE resource.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('flight_path', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT resource.id FROM block_lists AS resource
    WHERE resource.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('block_list', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT resource.id FROM student_groups AS resource
    WHERE resource.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('student_group', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT assignment.id FROM classpilot_coverage_assignments AS assignment
    WHERE assignment.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('coverage_assignment', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT school_settings.id FROM settings AS school_settings
    WHERE school_settings.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('central_email_recipient', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT teaching_session.id
    FROM teaching_sessions AS teaching_session
    LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE teaching_session.school_id = target_school_id
      OR class_group.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('active_teaching_session', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT session_staff.id
    FROM classpilot_session_staff AS session_staff
    LEFT JOIN teaching_sessions AS teaching_session
      ON teaching_session.id = session_staff.teaching_session_id
    LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
    WHERE session_staff.school_id = target_school_id
      OR teaching_session.school_id = target_school_id
      OR class_group.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('active_session_staff', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT context.id FROM classpilot_supervision_contexts AS context
    WHERE context.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('active_supervision_context', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT kiosk_session.id FROM passpilot_kiosk_sessions AS kiosk_session
    WHERE kiosk_session.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('active_kiosk_session', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT schedule_leg.id
    FROM classpilot_schedule_change_legs AS schedule_leg
    LEFT JOIN classpilot_schedule_changes AS schedule_change
      ON schedule_change.id = schedule_leg.schedule_change_id
    LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
    WHERE schedule_leg.school_id = target_school_id
      OR schedule_change.school_id = target_school_id
      OR class_group.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('active_schedule_change', dependency.id);
  END LOOP;

  FOR dependency IN
    SELECT conflict.id
    FROM classpilot_scheduled_conflicts AS conflict
    LEFT JOIN groups AS class_group ON class_group.id = conflict.group_id
    WHERE conflict.school_id = target_school_id
      OR class_group.school_id = target_school_id
  LOOP
    PERFORM schoolpilot_assert_live_staff_dependency('active_scheduled_conflict', dependency.id);
  END LOOP;

  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.is_super', COALESCE(previous_is_super, ''), true);
  RAISE;
END;
$school_staff_integrity$;

CREATE OR REPLACE FUNCTION schoolpilot_guard_school_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $school_hard_delete_guard$
BEGIN
  -- School records are lifecycle roots and are retained after soft deletion.
  -- An unconditional guard removes first-reference races from tables whose
  -- historical school keys intentionally do not cascade.
  RAISE EXCEPTION 'SCHOOL_STAFF_HISTORY_REQUIRES_RETENTION'
    USING ERRCODE = '23514', CONSTRAINT = 'school_staff_history_hard_delete';
  RETURN OLD;
END;
$school_hard_delete_guard$;

CREATE OR REPLACE FUNCTION schoolpilot_guard_user_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $user_hard_delete_guard$
BEGIN
  -- Staff identities are retained records. The application has no canonical
  -- hard-delete path, and an unconditional database guard removes the
  -- otherwise unavoidable race with creation of a user's first reference.
  RAISE EXCEPTION 'STAFF_IDENTITY_HISTORY_REQUIRES_RETENTION'
    USING ERRCODE = '23514', CONSTRAINT = 'staff_identity_history_hard_delete';
  RETURN OLD;
END;
$user_hard_delete_guard$;

CREATE OR REPLACE FUNCTION schoolpilot_check_school_staff_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $school_staff_integrity_trigger$
BEGIN
  IF NEW.deleted_at IS NULL THEN
    PERFORM schoolpilot_assert_school_staff_integrity(NEW.id);
  END IF;
  RETURN NEW;
END;
$school_staff_integrity_trigger$;

DROP TRIGGER IF EXISTS classpilot_admin_class_staff_integrity ON groups;
CREATE CONSTRAINT TRIGGER classpilot_admin_class_staff_integrity
AFTER INSERT OR UPDATE OF teacher_id, school_id, group_type, status
ON groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_admin_class_staff_integrity();

DROP TRIGGER IF EXISTS school_staff_assignment_reactivation_integrity ON schools;
CREATE CONSTRAINT TRIGGER school_staff_assignment_reactivation_integrity
AFTER UPDATE OF deleted_at, status
ON schools
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_school_staff_integrity();

DROP TRIGGER IF EXISTS school_staff_history_hard_delete_guard ON schools;
CREATE TRIGGER school_staff_history_hard_delete_guard
BEFORE DELETE
ON schools
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_guard_school_hard_delete();

DROP TRIGGER IF EXISTS staff_identity_history_hard_delete_guard ON users;
CREATE TRIGGER staff_identity_history_hard_delete_guard
BEFORE DELETE
ON users
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_guard_user_hard_delete();

DROP TRIGGER IF EXISTS classpilot_group_teacher_staff_integrity ON group_teachers;
CREATE CONSTRAINT TRIGGER classpilot_group_teacher_staff_integrity
AFTER INSERT OR UPDATE OR DELETE
ON group_teachers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_group_teacher_staff_integrity();

DROP TRIGGER IF EXISTS classpilot_staff_assignment_membership_update ON school_memberships;
CREATE CONSTRAINT TRIGGER classpilot_staff_assignment_membership_update
AFTER UPDATE OF user_id, school_id, role, gopilot_role, status
ON school_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_departing_staff_assignments();

DROP TRIGGER IF EXISTS gopilot_validate_homeroom_primary_teacher ON homerooms;
CREATE TRIGGER gopilot_validate_homeroom_primary_teacher
BEFORE INSERT OR UPDATE OF school_id, teacher_id
ON homerooms
FOR EACH ROW
EXECUTE FUNCTION gopilot_validate_homeroom_teacher();

DROP TRIGGER IF EXISTS gopilot_validate_homeroom_co_teacher ON homeroom_teachers;
CREATE TRIGGER gopilot_validate_homeroom_co_teacher
BEFORE INSERT OR UPDATE OF school_id, homeroom_id, teacher_id
ON homeroom_teachers
FOR EACH ROW
EXECUTE FUNCTION gopilot_validate_homeroom_teacher();

DROP TRIGGER IF EXISTS gopilot_homeroom_primary_mirror_integrity ON homerooms;
CREATE CONSTRAINT TRIGGER gopilot_homeroom_primary_mirror_integrity
AFTER INSERT OR UPDATE OF school_id, teacher_id
ON homerooms
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_gopilot_homeroom_staff_integrity();

DROP TRIGGER IF EXISTS gopilot_homeroom_teacher_mirror_integrity ON homeroom_teachers;
CREATE CONSTRAINT TRIGGER gopilot_homeroom_teacher_mirror_integrity
AFTER INSERT OR UPDATE OR DELETE
ON homeroom_teachers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_gopilot_homeroom_staff_integrity();

DROP TRIGGER IF EXISTS passpilot_teacher_grade_staff_integrity ON teacher_grades;
CREATE CONSTRAINT TRIGGER passpilot_teacher_grade_staff_integrity
AFTER INSERT OR UPDATE OF teacher_id, grade_id
ON teacher_grades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('passpilot_legacy_class');

DROP TRIGGER IF EXISTS classpilot_teacher_student_staff_integrity ON teacher_students;
CREATE CONSTRAINT TRIGGER classpilot_teacher_student_staff_integrity
AFTER INSERT OR UPDATE OF teacher_id, student_id, school_id
ON teacher_students
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('teacher_student_assignment');

DROP TRIGGER IF EXISTS classpilot_flight_path_staff_integrity ON flight_paths;
CREATE CONSTRAINT TRIGGER classpilot_flight_path_staff_integrity
AFTER INSERT OR UPDATE OF school_id, teacher_id
ON flight_paths
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('flight_path');

DROP TRIGGER IF EXISTS classpilot_block_list_staff_integrity ON block_lists;
CREATE CONSTRAINT TRIGGER classpilot_block_list_staff_integrity
AFTER INSERT OR UPDATE OF school_id, teacher_id
ON block_lists
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('block_list');

DROP TRIGGER IF EXISTS classpilot_student_group_staff_integrity ON student_groups;
CREATE CONSTRAINT TRIGGER classpilot_student_group_staff_integrity
AFTER INSERT OR UPDATE OF school_id, teacher_id
ON student_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('student_group');

DROP TRIGGER IF EXISTS classpilot_coverage_assignment_staff_integrity ON classpilot_coverage_assignments;
CREATE CONSTRAINT TRIGGER classpilot_coverage_assignment_staff_integrity
AFTER INSERT OR UPDATE OF school_id, staff_id, active
ON classpilot_coverage_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('coverage_assignment');

DROP TRIGGER IF EXISTS classpilot_session_staff_integrity ON classpilot_session_staff;
CREATE CONSTRAINT TRIGGER classpilot_session_staff_integrity
AFTER INSERT OR UPDATE OF school_id, teaching_session_id, staff_id
ON classpilot_session_staff
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('active_session_staff');

DROP TRIGGER IF EXISTS classpilot_supervision_staff_integrity ON classpilot_supervision_contexts;
CREATE CONSTRAINT TRIGGER classpilot_supervision_staff_integrity
AFTER INSERT OR UPDATE OF school_id, assigned_staff_id, status, ended_at
ON classpilot_supervision_contexts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('active_supervision_context');

DROP TRIGGER IF EXISTS passpilot_kiosk_staff_integrity ON passpilot_kiosk_sessions;
CREATE CONSTRAINT TRIGGER passpilot_kiosk_staff_integrity
AFTER INSERT OR UPDATE OF school_id, teacher_id, status
ON passpilot_kiosk_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('active_kiosk_session');

DROP TRIGGER IF EXISTS classpilot_schedule_change_leg_staff_integrity ON classpilot_schedule_change_legs;
CREATE CONSTRAINT TRIGGER classpilot_schedule_change_leg_staff_integrity
AFTER INSERT OR UPDATE OF school_id, schedule_change_id, group_id, primary_teacher_id_snapshot, reservation_active
ON classpilot_schedule_change_legs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('active_schedule_change');

DROP TRIGGER IF EXISTS classpilot_scheduled_conflict_staff_integrity ON classpilot_scheduled_conflicts;
CREATE CONSTRAINT TRIGGER classpilot_scheduled_conflict_staff_integrity
AFTER INSERT OR UPDATE OF school_id, group_id, teacher_id, status
ON classpilot_scheduled_conflicts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_live_staff_dependency('active_scheduled_conflict');

DROP TRIGGER IF EXISTS staff_settings_dependency_integrity ON settings;
CREATE CONSTRAINT TRIGGER staff_settings_dependency_integrity
AFTER INSERT OR UPDATE OF school_id, passpilot_class_source, central_email_recipient_user_id OR DELETE
ON settings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_parent_staff_dependencies();

DROP TRIGGER IF EXISTS passpilot_grade_dependency_integrity ON grades;
CREATE CONSTRAINT TRIGGER passpilot_grade_dependency_integrity
AFTER INSERT OR UPDATE OF school_id
ON grades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_parent_staff_dependencies();

DROP TRIGGER IF EXISTS classpilot_student_dependency_integrity ON students;
CREATE CONSTRAINT TRIGGER classpilot_student_dependency_integrity
AFTER INSERT OR UPDATE OF school_id, status
ON students
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_parent_staff_dependencies();

DROP TRIGGER IF EXISTS classpilot_teaching_session_staff_integrity ON teaching_sessions;
CREATE CONSTRAINT TRIGGER classpilot_teaching_session_staff_integrity
AFTER INSERT OR UPDATE OF school_id, group_id, teacher_id, end_time
ON teaching_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_parent_staff_dependencies();

DROP TRIGGER IF EXISTS classpilot_schedule_change_staff_integrity ON classpilot_schedule_changes;
CREATE CONSTRAINT TRIGGER classpilot_schedule_change_staff_integrity
AFTER INSERT OR UPDATE OF school_id, status, reservation_active
ON classpilot_schedule_changes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_parent_staff_dependencies();

DROP TRIGGER IF EXISTS classpilot_group_live_dependency_integrity ON groups;
CREATE CONSTRAINT TRIGGER classpilot_group_live_dependency_integrity
AFTER UPDATE OF school_id OR DELETE
ON groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_parent_staff_dependencies();

DROP TRIGGER IF EXISTS classpilot_staff_assignment_membership_delete ON school_memberships;
CREATE CONSTRAINT TRIGGER classpilot_staff_assignment_membership_delete
AFTER DELETE
ON school_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION schoolpilot_check_departing_staff_assignments();

-- SECURITY DEFINER is required so FORCE-RLS tables remain visible without a
-- request tenant GUC. Keep these functions private: application callers must
-- use the canonical lifecycle service, while triggers execute as the owner.
REVOKE ALL ON FUNCTION schoolpilot_lock_staff_assignment_school(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_lock_staff_assignment_schools(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_staff_assignment_school_is_live(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_staff_assignment_touched_schools(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_assert_school_staff_integrity(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_check_school_staff_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_guard_school_hard_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_guard_user_hard_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_assert_live_staff_dependency(TEXT, TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_check_live_staff_dependency() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_check_parent_staff_dependencies() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_assert_no_active_schedule_change_for_group(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_assert_admin_class_staff_integrity(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_check_admin_class_staff_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_check_group_teacher_staff_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_check_departing_staff_assignments() FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_assert_gopilot_homeroom_staff_integrity(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION schoolpilot_check_gopilot_homeroom_staff_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION gopilot_validate_homeroom_teacher() FROM PUBLIC;

-- This remains inside the same ledger-managed transaction as the aggregate
-- preflight and all integrity triggers above.
${STAFF_IDENTITY_NORMALIZED_EMAIL_SQL}
`;

export const staffIdentityIntegrityMigration: SchoolPilotMigration = {
  id: "20260824_staff_identity_integrity_contract",
  checksum: createHash("sha256").update(STAFF_IDENTITY_INTEGRITY_SQL).digest("hex"),
  mode: "transactional",
  apply: async (connection) => {
    await connection.query(STAFF_IDENTITY_INTEGRITY_SQL);
  },
};
