import { getDatabaseErrorDetails } from "../util/databaseError.js";

/**
 * Guard outcomes that indicate an attempted staff ownership/access mutation was
 * rejected by the canonical lifecycle service or its database backstop.
 *
 * These codes are safe operational dimensions. They intentionally omit school,
 * membership, user, class, and request identifiers.
 */
export const STAFF_LIFECYCLE_GUARD_CODES = [
  "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
  "STAFF_ASSIGNMENT_INELIGIBLE",
  "STAFF_DEPENDENCY_SCHOOL_MISMATCH",
  "STAFF_ACTIVE_SCHEDULE_CHANGE_OWNERSHIP_LOCKED",
  "STAFF_CLASS_ASSIGNMENT_INELIGIBLE",
  "STAFF_CLASS_PRIMARY_MIRROR_MISMATCH",
  "GOPILOT_HOMEROOM_TEACHER_INELIGIBLE",
  "GOPILOT_HOMEROOM_SCHOOL_MISMATCH",
  "GOPILOT_HOMEROOM_PRIMARY_MIRROR_MISMATCH",
] as const;

export type StaffLifecycleGuardCode = (typeof STAFF_LIFECYCLE_GUARD_CODES)[number];

const STAFF_LIFECYCLE_GUARD_CODE_SET = new Set<string>(
  STAFF_LIFECYCLE_GUARD_CODES
);

const STAFF_LIFECYCLE_CONSTRAINT_CODES: Readonly<Record<string, StaffLifecycleGuardCode>> = {
  classpilot_active_staff_assignment_membership:
    "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
  staff_live_teaching_dependency_membership:
    "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
  staff_live_active_dependency_membership:
    "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
  staff_live_dependency_tenant_scope: "STAFF_DEPENDENCY_SCHOOL_MISMATCH",
  staff_live_dependency_teaching_membership: "STAFF_ASSIGNMENT_INELIGIBLE",
  staff_live_dependency_active_membership: "STAFF_ASSIGNMENT_INELIGIBLE",
  classpilot_active_schedule_change_ownership:
    "STAFF_ACTIVE_SCHEDULE_CHANGE_OWNERSHIP_LOCKED",
  classpilot_active_primary_teacher_membership:
    "STAFF_CLASS_ASSIGNMENT_INELIGIBLE",
  classpilot_active_group_teacher_membership:
    "STAFF_CLASS_ASSIGNMENT_INELIGIBLE",
  classpilot_admin_class_primary_teacher_mirror:
    "STAFF_CLASS_PRIMARY_MIRROR_MISMATCH",
  gopilot_active_staff_assignment_membership:
    "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
  gopilot_active_homeroom_teacher_membership:
    "GOPILOT_HOMEROOM_TEACHER_INELIGIBLE",
  gopilot_homeroom_teacher_same_school:
    "GOPILOT_HOMEROOM_SCHOOL_MISMATCH",
  gopilot_homeroom_primary_teacher_mirror:
    "GOPILOT_HOMEROOM_PRIMARY_MIRROR_MISMATCH",
};

export function isStaffLifecycleGuardCode(
  value: unknown
): value is StaffLifecycleGuardCode {
  return typeof value === "string" && STAFF_LIFECYCLE_GUARD_CODE_SET.has(value);
}

/**
 * Reduce an application or wrapped PostgreSQL error to a safe canonical guard
 * code. No message, query, identifier, or arbitrary error property escapes.
 */
export function resolveStaffLifecycleGuardCode(
  error: unknown
): StaffLifecycleGuardCode | undefined {
  const details = getDatabaseErrorDetails(error);
  if (isStaffLifecycleGuardCode(details.code)) return details.code;
  return details.constraint
    ? STAFF_LIFECYCLE_CONSTRAINT_CODES[details.constraint]
    : undefined;
}
