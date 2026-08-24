import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import db from "../db.js";
import { users, schools, schoolMemberships } from "../schema/core.js";
import {
  groups,
  groupStudents,
  groupTeachers,
  teachingSessions,
  classpilotSessionStaff,
  classpilotCoverageAssignments,
  classpilotSupervisionContexts,
  classpilotScheduledConflicts,
  classpilotScheduleChanges,
  classpilotScheduleChangeLegs,
  flightPaths,
  blockLists,
  studentGroups,
  teacherStudents,
} from "../schema/classpilot.js";
import {
  grades,
  teacherGrades,
  passpilotKioskSessions,
} from "../schema/passpilot.js";
import { homerooms, homeroomTeachers } from "../schema/gopilot.js";
import { auditLogs, settings } from "../schema/shared.js";
import { students } from "../schema/students.js";
import {
  dispatchCacheInvalidation,
  invalidateUserCredentialConnections,
  publishCacheInvalidation,
} from "../realtime/cacheInvalidation.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";

type LifecycleDb = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TEACHABLE_STAFF_ROLES = [
  "teacher",
  "admin",
  "school_admin",
] as const;

const TEACHABLE_STAFF_ROLE_SET = new Set<string>(TEACHABLE_STAFF_ROLES);
const STAFF_TRANSITION_ROLES = [
  ...TEACHABLE_STAFF_ROLES,
  "office_staff",
] as const;
export const ACTIVE_INSTRUCTIONAL_GROUP_TYPES = [
  "admin_class",
  "teacher_created",
  "teacher_small_group",
] as const;

export type TeachableStaffRole = (typeof TEACHABLE_STAFF_ROLES)[number];
export type StaffTransitionRole = (typeof STAFF_TRANSITION_ROLES)[number];

export type StaffAssignmentType =
  | "class_primary"
  | "class_co_teacher"
  | "passpilot_legacy_class"
  | "gopilot_homeroom_primary"
  | "gopilot_homeroom_co_teacher"
  | "coverage_assignment"
  | "teacher_student_assignment"
  | "flight_path"
  | "block_list"
  | "student_group"
  | "central_email_recipient";

export type StaffAssignmentImpactAssignment = {
  assignmentType: StaffAssignmentType;
  assignmentId: string;
  resourceId: string;
  label: string;
  required: boolean;
  allowedOperations: Array<"replace" | "remove">;
};

export type StaffAssignmentBlockerType =
  | "active_teaching_session"
  | "active_supervision_context"
  | "active_kiosk_session"
  | "active_schedule_change"
  | "active_scheduled_conflict";

export type StaffAssignmentImpactBlocker = {
  blockerType: StaffAssignmentBlockerType;
  blockerId: string;
  resourceId?: string;
  label: string;
};

export type StaffAssignmentImpact = {
  membershipId: string;
  userId: string;
  role: string;
  gopilotRole: string | null;
  effectiveGopilotRole: string;
  status: string;
  target: StaffTransitionTarget;
  revision: string;
  assignments: StaffAssignmentImpactAssignment[];
  blockers: StaffAssignmentImpactBlocker[];
  generatedAt: string;
};

export type StaffTransitionTarget = {
  action: "deactivate" | "change_role";
  newRole?: string;
  newGopilotRole?: string | null;
};

export type StaffTransitionDecision = {
  assignmentType: StaffAssignmentType;
  assignmentId: string;
  operation: "replace" | "remove";
  replacementMembershipId?: string;
};

export type StaffTransitionRequest = {
  expectedRevision: string;
  action: "deactivate" | "change_role";
  newRole?: StaffTransitionRole;
  newGopilotRole?: "teacher" | "office_staff" | null;
  decisions: StaffTransitionDecision[];
};

export type StaffTransitionResult = {
  membership: typeof schoolMemberships.$inferSelect;
  transferred: Array<{
    assignmentType: StaffAssignmentType;
    assignmentId: string;
    resourceId: string;
    operation: "replace" | "remove";
    replacementUserId?: string;
  }>;
  preservation?: {
    before: StaffClassStateCounts;
    after: StaffClassStateCounts;
    unchanged: true;
  };
};

export type StaffClassStateCounts = {
  classCount: number;
  rosterMembershipCount: number;
  teachingSessionCount: number;
};

export type StaffClassStateInvariant = {
  classIds: string[];
  expected: StaffClassStateCounts;
};

export type StaffIdentityRepairProofInput = {
  schoolId: string;
  sourceMembershipId: string;
  targetMembershipId: string;
  impactRevision: string;
  preservationCounts: StaffClassStateCounts;
};

export function createStaffIdentityRepairProof(
  input: StaffIdentityRepairProofInput
): string {
  const canonical = {
    version: "staff-identity-repair-proof-v1",
    schoolId: input.schoolId,
    sourceMembershipId: input.sourceMembershipId,
    targetMembershipId: input.targetMembershipId,
    impactRevision: input.impactRevision,
    preservationCounts: input.preservationCounts,
  };
  return `staff-repair-proof-v1:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("base64url")}`;
}

type LifecycleErrorDetails = Record<string, string | number | boolean | string[]>;

export class StaffAssignmentLifecycleError extends Error {
  readonly expose = true;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: LifecycleErrorDetails
  ) {
    super(message);
    this.name = "StaffAssignmentLifecycleError";
  }
}

function lifecycleError(
  status: number,
  code: string,
  message: string,
  details?: LifecycleErrorDetails
): StaffAssignmentLifecycleError {
  return new StaffAssignmentLifecycleError(status, code, message, details);
}

function stableSortByIdentity<T extends { assignmentType: string; assignmentId: string }>(
  values: T[]
): T[] {
  return values.sort((left, right) =>
    `${left.assignmentType}\u0000${left.assignmentId}`.localeCompare(
      `${right.assignmentType}\u0000${right.assignmentId}`
    )
  );
}

function impactRevision(input: {
  membershipId: string;
  userId: string;
  role: string;
  gopilotRole: string | null;
  status: string;
  target: StaffTransitionTarget;
  assignments: StaffAssignmentImpactAssignment[];
  blockers: StaffAssignmentImpactBlocker[];
}): string {
  const canonical = {
    membershipId: input.membershipId,
    userId: input.userId,
    role: input.role,
    gopilotRole: input.gopilotRole,
    status: input.status,
    target: input.target,
    assignments: input.assignments.map((assignment) => ({
      assignmentType: assignment.assignmentType,
      assignmentId: assignment.assignmentId,
      resourceId: assignment.resourceId,
      required: assignment.required,
    })),
    blockers: [...input.blockers]
      .sort((left, right) =>
        `${left.blockerType}\u0000${left.blockerId}`.localeCompare(
          `${right.blockerType}\u0000${right.blockerId}`
        )
      )
      .map((blocker) => ({
        blockerType: blocker.blockerType,
        blockerId: blocker.blockerId,
        resourceId: blocker.resourceId ?? null,
      })),
  };
  return `staff-impact-v2:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("base64url")}`;
}

export function effectiveGopilotRole(
  membership: Pick<typeof schoolMemberships.$inferSelect, "role" | "gopilotRole">
): string {
  return membership.gopilotRole?.trim() || membership.role;
}

function uniqueBy<T>(values: T[], identity: (value: T) => string): T[] {
  const result = new Map<string, T>();
  for (const value of values) result.set(identity(value), value);
  return [...result.values()];
}

async function loadImpactForMembership(
  schoolId: string,
  membership: typeof schoolMemberships.$inferSelect,
  target: StaffTransitionTarget,
  dbInstance: LifecycleDb
): Promise<StaffAssignmentImpact> {
  const userId = membership.userId;
  const assignments: StaffAssignmentImpactAssignment[] = [];

  const primaryClasses = await dbInstance
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(
      and(
        eq(groups.schoolId, schoolId),
        eq(groups.teacherId, userId),
        inArray(groups.groupType, [...ACTIVE_INSTRUCTIONAL_GROUP_TYPES]),
        eq(groups.status, "active")
      )
    )
    .orderBy(asc(groups.id));
  assignments.push(
    ...primaryClasses.map((group) => ({
      assignmentType: "class_primary" as const,
      assignmentId: group.id,
      resourceId: group.id,
      label: group.name,
      required: true,
      allowedOperations: ["replace" as const],
    }))
  );

  const coClasses = await dbInstance
    .select({
      id: groupTeachers.id,
      groupId: groups.id,
      name: groups.name,
      primaryTeacherId: groups.teacherId,
    })
    .from(groupTeachers)
    .innerJoin(groups, eq(groups.id, groupTeachers.groupId))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        inArray(groups.groupType, [...ACTIVE_INSTRUCTIONAL_GROUP_TYPES]),
        eq(groups.status, "active"),
        eq(groupTeachers.teacherId, userId),
        ne(groups.teacherId, userId)
      )
    )
    .orderBy(asc(groupTeachers.id));
  assignments.push(
    ...coClasses.map((relationship) => ({
      assignmentType: "class_co_teacher" as const,
      assignmentId: relationship.id,
      resourceId: relationship.groupId,
      label: relationship.name,
      required: false,
      allowedOperations: ["replace" as const, "remove" as const],
    }))
  );

  const [classSource] = await dbInstance
    .select({ value: settings.passpilotClassSource })
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1);
  if (!classSource || classSource.value === "legacy_grades") {
    const legacyClasses = await dbInstance
      .select({ id: teacherGrades.id, gradeId: grades.id, name: grades.name })
      .from(teacherGrades)
      .innerJoin(grades, eq(grades.id, teacherGrades.gradeId))
      .where(and(eq(grades.schoolId, schoolId), eq(teacherGrades.teacherId, userId)))
      .orderBy(asc(teacherGrades.id));
    assignments.push(
      ...legacyClasses.map((relationship) => ({
        assignmentType: "passpilot_legacy_class" as const,
        assignmentId: relationship.id,
        resourceId: relationship.gradeId,
        label: relationship.name,
        required: false,
        allowedOperations: ["replace" as const, "remove" as const],
      }))
    );
  }

  const primaryHomerooms = await dbInstance
    .select({ id: homerooms.id, name: homerooms.name })
    .from(homerooms)
    .where(and(eq(homerooms.schoolId, schoolId), eq(homerooms.teacherId, userId)))
    .orderBy(asc(homerooms.id));
  assignments.push(
    ...primaryHomerooms.map((homeroom) => ({
      assignmentType: "gopilot_homeroom_primary" as const,
      assignmentId: homeroom.id,
      resourceId: homeroom.id,
      label: homeroom.name,
      required: true,
      allowedOperations: ["replace" as const],
    }))
  );

  const coHomerooms = await dbInstance
    .select({
      id: homeroomTeachers.id,
      homeroomId: homerooms.id,
      name: homerooms.name,
    })
    .from(homeroomTeachers)
    .innerJoin(homerooms, eq(homerooms.id, homeroomTeachers.homeroomId))
    .where(
      and(
        eq(homerooms.schoolId, schoolId),
        eq(homeroomTeachers.schoolId, schoolId),
        eq(homeroomTeachers.teacherId, userId),
        or(isNull(homerooms.teacherId), ne(homerooms.teacherId, userId))
      )
    )
    .orderBy(asc(homeroomTeachers.id));
  assignments.push(
    ...coHomerooms.map((relationship) => ({
      assignmentType: "gopilot_homeroom_co_teacher" as const,
      assignmentId: relationship.id,
      resourceId: relationship.homeroomId,
      label: relationship.name,
      required: false,
      allowedOperations: ["replace" as const, "remove" as const],
    }))
  );

  const coverage = await dbInstance
    .select({ id: classpilotCoverageAssignments.id })
    .from(classpilotCoverageAssignments)
    .where(
      and(
        eq(classpilotCoverageAssignments.schoolId, schoolId),
        eq(classpilotCoverageAssignments.staffId, userId),
        eq(classpilotCoverageAssignments.active, true)
      )
    )
    .orderBy(asc(classpilotCoverageAssignments.id));
  assignments.push(
    ...coverage.map((assignment) => ({
      assignmentType: "coverage_assignment" as const,
      assignmentId: assignment.id,
      resourceId: assignment.id,
      label: "Coverage assignment",
      required: false,
      allowedOperations: ["replace" as const, "remove" as const],
    }))
  );

  const studentAssignments = await dbInstance
    .select({ id: teacherStudents.id, studentId: teacherStudents.studentId })
    .from(teacherStudents)
    .innerJoin(students, eq(students.id, teacherStudents.studentId))
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        eq(teacherStudents.teacherId, userId)
      )
    )
    .orderBy(asc(teacherStudents.id));
  assignments.push(
    ...studentAssignments.map((assignment) => ({
      assignmentType: "teacher_student_assignment" as const,
      assignmentId: assignment.id,
      resourceId: assignment.studentId,
      label: "Direct student assignment",
      required: false,
      allowedOperations: ["replace" as const, "remove" as const],
    }))
  );

  const ownedFlightPaths = await dbInstance
    .select({ id: flightPaths.id })
    .from(flightPaths)
    .where(and(eq(flightPaths.schoolId, schoolId), eq(flightPaths.teacherId, userId)))
    .orderBy(asc(flightPaths.id));
  assignments.push(
    ...ownedFlightPaths.map((resource) => ({
      assignmentType: "flight_path" as const,
      assignmentId: resource.id,
      resourceId: resource.id,
      label: "Flight path",
      required: false,
      allowedOperations: ["replace" as const, "remove" as const],
    }))
  );

  const ownedBlockLists = await dbInstance
    .select({ id: blockLists.id })
    .from(blockLists)
    .where(and(eq(blockLists.schoolId, schoolId), eq(blockLists.teacherId, userId)))
    .orderBy(asc(blockLists.id));
  assignments.push(
    ...ownedBlockLists.map((resource) => ({
      assignmentType: "block_list" as const,
      assignmentId: resource.id,
      resourceId: resource.id,
      label: "Block list",
      required: true,
      allowedOperations: ["replace" as const],
    }))
  );

  const ownedStudentGroups = await dbInstance
    .select({ id: studentGroups.id })
    .from(studentGroups)
    .where(and(eq(studentGroups.schoolId, schoolId), eq(studentGroups.teacherId, userId)))
    .orderBy(asc(studentGroups.id));
  assignments.push(
    ...ownedStudentGroups.map((resource) => ({
      assignmentType: "student_group" as const,
      assignmentId: resource.id,
      resourceId: resource.id,
      label: "Student group",
      required: false,
      allowedOperations: ["replace" as const, "remove" as const],
    }))
  );

  const [centralRecipient] = await dbInstance
    .select({ id: settings.id })
    .from(settings)
    .where(
      and(
        eq(settings.schoolId, schoolId),
        eq(settings.centralEmailRecipientUserId, userId)
      )
    )
    .limit(1);
  if (centralRecipient) {
    assignments.push({
      assignmentType: "central_email_recipient",
      assignmentId: centralRecipient.id,
      resourceId: centralRecipient.id,
      label: "Central session-summary recipient",
      required: false,
      allowedOperations: ["replace", "remove"],
    });
  }

  stableSortByIdentity(assignments);
  const blockers: StaffAssignmentImpactBlocker[] = [];

  const activeSessions = await dbInstance
    .select({ id: teachingSessions.id, groupId: teachingSessions.groupId })
    .from(teachingSessions)
    .innerJoin(groups, eq(groups.id, teachingSessions.groupId))
    .leftJoin(
      classpilotSessionStaff,
      and(
        eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id),
        eq(classpilotSessionStaff.staffId, userId)
      )
    )
    .where(
      and(
        eq(groups.schoolId, schoolId),
        isNull(teachingSessions.endTime),
        or(eq(teachingSessions.teacherId, userId), eq(classpilotSessionStaff.staffId, userId))
      )
    )
    .orderBy(asc(teachingSessions.id));
  blockers.push(
    ...uniqueBy(activeSessions, (session) => session.id).map((session) => ({
      blockerType: "active_teaching_session" as const,
      blockerId: session.id,
      resourceId: session.groupId,
      label: "Active teaching session",
    }))
  );

  const activeContexts = await dbInstance
    .select({ id: classpilotSupervisionContexts.id })
    .from(classpilotSupervisionContexts)
    .where(
      and(
        eq(classpilotSupervisionContexts.schoolId, schoolId),
        eq(classpilotSupervisionContexts.assignedStaffId, userId),
        eq(classpilotSupervisionContexts.status, "active"),
        isNull(classpilotSupervisionContexts.endedAt)
      )
    )
    .orderBy(asc(classpilotSupervisionContexts.id));
  blockers.push(
    ...activeContexts.map((context) => ({
      blockerType: "active_supervision_context" as const,
      blockerId: context.id,
      resourceId: context.id,
      label: "Active supervision context",
    }))
  );

  const activeKiosks = await dbInstance
    .select({ id: passpilotKioskSessions.id })
    .from(passpilotKioskSessions)
    .where(
      and(
        eq(passpilotKioskSessions.schoolId, schoolId),
        eq(passpilotKioskSessions.teacherId, userId),
        eq(passpilotKioskSessions.status, "active")
      )
    )
    .orderBy(asc(passpilotKioskSessions.id));
  blockers.push(
    ...activeKiosks.map((session) => ({
      blockerType: "active_kiosk_session" as const,
      blockerId: session.id,
      resourceId: session.id,
      label: "Active PassPilot kiosk session",
    }))
  );

  const classIds = [
    ...new Set([
      ...primaryClasses.map((group) => group.id),
      ...coClasses.map((relationship) => relationship.groupId),
    ]),
  ];
  const activeScheduleOwnerPredicate =
    classIds.length > 0
      ? or(
          eq(classpilotScheduleChangeLegs.primaryTeacherIdSnapshot, userId),
          inArray(classpilotScheduleChangeLegs.groupId, classIds)
        )
      : eq(classpilotScheduleChangeLegs.primaryTeacherIdSnapshot, userId);
  const activeScheduleChanges = await dbInstance
    .select({
      id: classpilotScheduleChanges.id,
      groupId: classpilotScheduleChangeLegs.groupId,
    })
    .from(classpilotScheduleChanges)
    .innerJoin(
      classpilotScheduleChangeLegs,
      and(
        eq(classpilotScheduleChangeLegs.scheduleChangeId, classpilotScheduleChanges.id),
        eq(classpilotScheduleChangeLegs.schoolId, schoolId)
      )
    )
    .where(
      and(
        eq(classpilotScheduleChanges.schoolId, schoolId),
        eq(classpilotScheduleChanges.reservationActive, true),
        eq(classpilotScheduleChangeLegs.reservationActive, true),
        inArray(classpilotScheduleChanges.status, [
          "pending_counterpart",
          "pending_admin",
          "approved",
        ]),
        activeScheduleOwnerPredicate
      )
    )
    .orderBy(asc(classpilotScheduleChanges.id));
  blockers.push(
    ...uniqueBy(activeScheduleChanges, (change) => change.id).map((change) => ({
      blockerType: "active_schedule_change" as const,
      blockerId: change.id,
      resourceId: change.groupId,
      label: "Pending or approved schedule change",
    }))
  );

  const activeConflicts = await dbInstance
    .select({ id: classpilotScheduledConflicts.id, groupId: classpilotScheduledConflicts.groupId })
    .from(classpilotScheduledConflicts)
    .where(
      and(
        eq(classpilotScheduledConflicts.schoolId, schoolId),
        eq(classpilotScheduledConflicts.teacherId, userId),
        inArray(classpilotScheduledConflicts.status, ["coverage_needed", "claimed", "pending"])
      )
    )
    .orderBy(asc(classpilotScheduledConflicts.id));
  blockers.push(
    ...activeConflicts.map((conflict) => ({
      blockerType: "active_scheduled_conflict" as const,
      blockerId: conflict.id,
      resourceId: conflict.groupId,
      label: "Active scheduled coverage conflict",
    }))
  );

  blockers.sort((left, right) =>
    `${left.blockerType}\u0000${left.blockerId}`.localeCompare(
      `${right.blockerType}\u0000${right.blockerId}`
    )
  );
  const revision = impactRevision({
    membershipId: membership.id,
    userId,
    role: membership.role,
    gopilotRole: membership.gopilotRole,
    status: membership.status,
    target,
    assignments,
    blockers,
  });
  return {
    membershipId: membership.id,
    userId,
    role: membership.role,
    gopilotRole: membership.gopilotRole,
    effectiveGopilotRole: effectiveGopilotRole(membership),
    status: membership.status,
    target,
    revision,
    assignments,
    blockers,
    generatedAt: new Date().toISOString(),
  };
}

export async function getStaffAssignmentImpact(
  schoolId: string,
  membershipId: string,
  target: (Pick<StaffTransitionRequest, "action" | "newRole" | "newGopilotRole"> & {
    forceAll?: boolean;
  }) = { action: "deactivate" },
  dbInstance: LifecycleDb = db as unknown as LifecycleDb
): Promise<StaffAssignmentImpact> {
  const [membership] = await dbInstance
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.id, membershipId),
        eq(schoolMemberships.schoolId, schoolId)
      )
    )
    .limit(1);
  if (!membership) {
    throw lifecycleError(
      404,
      "STAFF_MEMBERSHIP_NOT_FOUND",
      "Staff membership not found."
    );
  }
  const nextStatus = target.action === "deactivate" ? "inactive" : membership.status;
  const nextRole = target.newRole ?? membership.role;
  const nextGopilotRole = Object.prototype.hasOwnProperty.call(target, "newGopilotRole")
    ? target.newGopilotRole ?? null
    : membership.gopilotRole;
  const normalizedTarget: StaffTransitionTarget = target.action === "deactivate"
    ? { action: "deactivate" }
    : {
        action: "change_role",
        newRole: nextRole,
        newGopilotRole: nextGopilotRole,
      };
  const impact = await loadImpactForMembership(
    schoolId,
    membership,
    normalizedTarget,
    dbInstance
  );
  if (target.forceAll) return impact;
  const loss = await staffEligibilityLoss({
    membership,
    nextStatus,
    nextRole,
    nextGopilotRole,
    dbInstance,
  });
  return impactForEligibilityLoss(impact, loss);
}

type StaffEligibilityLoss = {
  baseTeachingAuthority: boolean;
  baseTeaching: boolean;
  gopilotTeaching: boolean;
  activeStaff: boolean;
};

function hasBaseTeachingEligibility(
  membership: Pick<typeof schoolMemberships.$inferSelect, "role">
): boolean {
  return TEACHABLE_STAFF_ROLE_SET.has(membership.role);
}

function hasGopilotTeachingEligibility(
  membership: Pick<typeof schoolMemberships.$inferSelect, "role" | "gopilotRole">
): boolean {
  return effectiveGopilotRole(membership) === "teacher";
}

function hasActiveStaffEligibility(
  membership: Pick<typeof schoolMemberships.$inferSelect, "role">
): boolean {
  return (STAFF_TRANSITION_ROLES as readonly string[]).includes(membership.role);
}

async function staffEligibilityLoss(options: {
  membership: typeof schoolMemberships.$inferSelect;
  nextStatus: string;
  nextRole: string;
  nextGopilotRole: string | null;
  nextUserId?: string;
  nextSchoolId?: string;
  dbInstance: LifecycleDb;
}): Promise<StaffEligibilityLoss> {
  const membership = options.membership;
  const activeRows = await options.dbInstance
    .select({
      id: schoolMemberships.id,
      role: schoolMemberships.role,
      gopilotRole: schoolMemberships.gopilotRole,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId))
    .where(
      and(
        eq(schoolMemberships.schoolId, membership.schoolId),
        eq(schoolMemberships.userId, membership.userId),
        eq(schoolMemberships.status, "active")
      )
    )
    .for("update");
  const otherActiveRows = activeRows.filter((row) => row.id !== membership.id);
  const currentRemainsOnIdentity =
    options.nextStatus === "active" &&
    (options.nextUserId ?? membership.userId) === membership.userId &&
    (options.nextSchoolId ?? membership.schoolId) === membership.schoolId;
  const activeAfter = [
    ...otherActiveRows,
    ...(currentRemainsOnIdentity
      ? [{ id: membership.id, role: options.nextRole, gopilotRole: options.nextGopilotRole }]
      : []),
  ];
  const losesActiveStaff =
    activeRows.some(hasActiveStaffEligibility) &&
    !activeAfter.some(hasActiveStaffEligibility);
  const losesBaseTeachingAuthority =
    activeRows.some(hasBaseTeachingEligibility) &&
    !activeAfter.some(hasBaseTeachingEligibility);
  return {
    baseTeachingAuthority: losesBaseTeachingAuthority,
    baseTeaching:
      losesActiveStaff ||
      losesBaseTeachingAuthority,
    gopilotTeaching:
      losesActiveStaff ||
      (activeRows.some(hasGopilotTeachingEligibility) &&
        !activeAfter.some(hasGopilotTeachingEligibility)),
    activeStaff: losesActiveStaff,
  };
}

const BASE_TEACHING_ASSIGNMENTS = new Set<StaffAssignmentType>([
  "class_primary",
  "class_co_teacher",
  "passpilot_legacy_class",
  "teacher_student_assignment",
  "flight_path",
  "block_list",
  "student_group",
]);
const GOPILOT_TEACHING_ASSIGNMENTS = new Set<StaffAssignmentType>([
  "gopilot_homeroom_primary",
  "gopilot_homeroom_co_teacher",
]);
const ACTIVE_STAFF_ASSIGNMENTS = new Set<StaffAssignmentType>([
  "coverage_assignment",
  "central_email_recipient",
]);
const BASE_TEACHING_BLOCKERS = new Set<StaffAssignmentBlockerType>([
  "active_teaching_session",
  "active_kiosk_session",
  "active_schedule_change",
  "active_scheduled_conflict",
]);
const ACTIVE_STAFF_BLOCKERS = new Set<StaffAssignmentBlockerType>([
  "active_supervision_context",
]);

function impactForEligibilityLoss(
  impact: StaffAssignmentImpact,
  loss: StaffEligibilityLoss,
  forceAll = false
): StaffAssignmentImpact {
  const assignments = forceAll
    ? impact.assignments
    : impact.assignments.filter(
        (assignment) =>
          (loss.baseTeaching && BASE_TEACHING_ASSIGNMENTS.has(assignment.assignmentType)) ||
          (loss.gopilotTeaching && GOPILOT_TEACHING_ASSIGNMENTS.has(assignment.assignmentType)) ||
          (loss.activeStaff && ACTIVE_STAFF_ASSIGNMENTS.has(assignment.assignmentType))
      );
  const blockers = forceAll || loss.activeStaff
    ? impact.blockers
    : impact.blockers.filter(
        (blocker) =>
          (loss.baseTeaching && BASE_TEACHING_BLOCKERS.has(blocker.blockerType)) ||
          (loss.activeStaff && ACTIVE_STAFF_BLOCKERS.has(blocker.blockerType))
      );
  const revision = impactRevision({
    membershipId: impact.membershipId,
    userId: impact.userId,
    role: impact.role,
    gopilotRole: impact.gopilotRole,
    status: impact.status,
    target: impact.target,
    assignments,
    blockers,
  });
  return { ...impact, assignments, blockers, revision };
}

/**
 * Fail-closed guard for legacy DELETE and role-change routes. Guided transition
 * is the sole path allowed to rewrite live ownership before eligibility loss.
 */
export async function assertStaffLifecycleMutationAllowed(options: {
  schoolId: string;
  membership: typeof schoolMemberships.$inferSelect;
  nextStatus: string;
  nextRole: string;
  nextGopilotRole: string | null;
  nextUserId?: string;
  nextSchoolId?: string;
  dbInstance: LifecycleDb;
}): Promise<StaffEligibilityLoss | null> {
  const loss = await staffEligibilityLoss({
    membership: options.membership,
    nextStatus: options.nextStatus,
    nextRole: options.nextRole,
    nextGopilotRole: options.nextGopilotRole,
    nextUserId: options.nextUserId,
    nextSchoolId: options.nextSchoolId,
    dbInstance: options.dbInstance,
  });
  const requiresTransfer = loss.baseTeaching || loss.gopilotTeaching || loss.activeStaff;
  if (!requiresTransfer) return null;
  const normalizedTarget: StaffTransitionTarget = options.nextStatus === "inactive"
    ? { action: "deactivate" }
    : {
        action: "change_role",
        newRole: options.nextRole,
        newGopilotRole: options.nextGopilotRole,
      };
  const fullImpact = await loadImpactForMembership(
    options.schoolId,
    options.membership,
    normalizedTarget,
    options.dbInstance
  );
  const impact = impactForEligibilityLoss(fullImpact, loss);
  if (impact.assignments.length === 0 && impact.blockers.length === 0) return loss;
  throw lifecycleError(
    409,
    "STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT",
    "Resolve or reassign this staff member's active responsibilities before changing teaching access.",
    {
      assignmentImpactRequired: true,
      assignmentCount: impact.assignments.length,
      blockerCount: impact.blockers.length,
      currentRevision: impact.revision,
    }
  );
}

function decisionIdentity(input: {
  assignmentType: string;
  assignmentId: string;
}): string {
  return `${input.assignmentType}\u0000${input.assignmentId}`;
}

async function validateReplacementMemberships(options: {
  schoolId: string;
  sourceUserId: string;
  decisions: StaffTransitionDecision[];
  assignmentsByIdentity: Map<string, StaffAssignmentImpactAssignment>;
  dbInstance: LifecycleDb;
}): Promise<Map<string, {
  membershipId: string;
  userId: string;
  role: string;
  gopilotRole: string | null;
}>> {
  const replacementMembershipIds = [
    ...new Set(
      options.decisions
        .filter((decision) => decision.operation === "replace")
        .map((decision) => decision.replacementMembershipId)
        .filter((value): value is string => Boolean(value))
    ),
  ];
  if (replacementMembershipIds.length === 0) return new Map();
  const rows = await options.dbInstance
    .select({
      membershipId: schoolMemberships.id,
      userId: schoolMemberships.userId,
      role: schoolMemberships.role,
      gopilotRole: schoolMemberships.gopilotRole,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId))
    .where(
      and(
        eq(schoolMemberships.schoolId, options.schoolId),
        eq(schoolMemberships.status, "active"),
        or(
          inArray(schoolMemberships.role, [...STAFF_TRANSITION_ROLES]),
          inArray(schoolMemberships.gopilotRole, [...STAFF_TRANSITION_ROLES])
        ),
        inArray(schoolMemberships.id, replacementMembershipIds)
      )
    )
    .for("update");
  const byMembershipId = new Map(rows.map((row) => [row.membershipId, row]));
  const invalid = options.decisions.some((decision) => {
    if (decision.operation !== "replace" || !decision.replacementMembershipId) return false;
    const replacement = byMembershipId.get(decision.replacementMembershipId);
    const assignment = options.assignmentsByIdentity.get(decisionIdentity(decision));
    if (!replacement || !assignment || replacement.userId === options.sourceUserId) return true;
    if (BASE_TEACHING_ASSIGNMENTS.has(assignment.assignmentType)) {
      return !hasBaseTeachingEligibility(replacement);
    }
    if (GOPILOT_TEACHING_ASSIGNMENTS.has(assignment.assignmentType)) {
      return !hasGopilotTeachingEligibility(replacement);
    }
    return !hasActiveStaffEligibility(replacement);
  });
  if (byMembershipId.size !== replacementMembershipIds.length || invalid) {
    throw lifecycleError(
      422,
      "STAFF_REPLACEMENT_INVALID",
      "Every replacement must be a different active same-school staff member eligible for that responsibility."
    );
  }
  return byMembershipId;
}

function windowsOverlap(
  left: { start: string; end: string },
  right: { start: string; end: string }
): boolean {
  return left.start < right.end && right.start < left.end;
}

async function assertReplacementSchedulesDoNotOverlap(options: {
  schoolId: string;
  impact: StaffAssignmentImpact;
  decisionsByIdentity: Map<string, StaffTransitionDecision>;
  replacements: Map<string, { membershipId: string; userId: string }>;
  actorUserId: string;
  dbInstance: LifecycleDb;
}): Promise<void> {
  const classAssignments = options.impact.assignments.filter(
    (assignment) =>
      assignment.assignmentType === "class_primary" ||
      assignment.assignmentType === "class_co_teacher"
  );
  if (classAssignments.length === 0) return;
  const classIds = [...new Set(classAssignments.map((assignment) => assignment.resourceId))];
  const transitioningClasses = await options.dbInstance
    .select({
      id: groups.id,
      scheduleEnabled: groups.scheduleEnabled,
      start: groups.blockStartTime,
      end: groups.blockEndTime,
    })
    .from(groups)
    .where(and(eq(groups.schoolId, options.schoolId), inArray(groups.id, classIds)));
  const classById = new Map(transitioningClasses.map((group) => [group.id, group]));

  const { assertProspectiveApprovedScheduleChangeAssignmentsSafe } = await import("./storage.js");
  const approvedSafetyChecks = new Set<string>();
  for (const assignment of classAssignments) {
    const decision = options.decisionsByIdentity.get(decisionIdentity(assignment));
    if (!decision || decision.operation !== "replace") continue;
    const replacement = options.replacements.get(decision.replacementMembershipId!);
    if (!replacement) continue;
    const identity = `${assignment.resourceId}\u0000${replacement.userId}`;
    if (approvedSafetyChecks.has(identity)) continue;
    approvedSafetyChecks.add(identity);
    await assertProspectiveApprovedScheduleChangeAssignmentsSafe({
      schoolId: options.schoolId,
      groupId: assignment.resourceId,
      addedTeacherIds: [replacement.userId],
      actorId: options.actorUserId,
      dbInstance: options.dbInstance as unknown as Parameters<
        typeof assertProspectiveApprovedScheduleChangeAssignmentsSafe
      >[0]["dbInstance"],
    });
  }

  const incomingByReplacement = new Map<
    string,
    Array<{
      assignmentId: string;
      id: string;
      start: string;
      end: string;
    }>
  >();
  for (const assignment of classAssignments) {
    const decision = options.decisionsByIdentity.get(decisionIdentity(assignment));
    if (!decision || decision.operation !== "replace") continue;
    const replacement = options.replacements.get(decision.replacementMembershipId!);
    const incoming = classById.get(assignment.resourceId);
    if (
      !replacement ||
      !incoming?.scheduleEnabled ||
      !incoming.start ||
      !incoming.end
    ) {
      continue;
    }
    const current = incomingByReplacement.get(replacement.userId) ?? [];
    current.push({
      assignmentId: assignment.assignmentId,
      id: incoming.id,
      start: incoming.start,
      end: incoming.end,
    });
    incomingByReplacement.set(replacement.userId, current);
  }
  for (const incomingClasses of incomingByReplacement.values()) {
    for (let leftIndex = 0; leftIndex < incomingClasses.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < incomingClasses.length; rightIndex += 1) {
        const left = incomingClasses[leftIndex]!;
        const right = incomingClasses[rightIndex]!;
        if (
          left.id !== right.id &&
          windowsOverlap(
            { start: left.start, end: left.end },
            { start: right.start, end: right.end }
          )
        ) {
          throw lifecycleError(
            422,
            "STAFF_REPLACEMENT_INVALID",
            "A replacement teacher would receive overlapping transitioned classes.",
            { assignmentId: left.assignmentId }
          );
        }
      }
    }
  }

  for (const assignment of classAssignments) {
    const decision = options.decisionsByIdentity.get(decisionIdentity(assignment));
    if (!decision || decision.operation !== "replace") continue;
    const replacement = options.replacements.get(decision.replacementMembershipId!);
    if (!replacement) continue;
    const incoming = classById.get(assignment.resourceId);
    if (!incoming?.scheduleEnabled || !incoming.start || !incoming.end) continue;
    const existingPrimary = await options.dbInstance
      .select({
        id: groups.id,
        start: groups.blockStartTime,
        end: groups.blockEndTime,
      })
      .from(groups)
      .where(
        and(
          eq(groups.schoolId, options.schoolId),
          eq(groups.status, "active"),
          eq(groups.scheduleEnabled, true),
          eq(groups.teacherId, replacement.userId),
          ne(groups.id, incoming.id)
        )
      );
    const existingCo = await options.dbInstance
      .select({
        id: groups.id,
        start: groups.blockStartTime,
        end: groups.blockEndTime,
      })
      .from(groupTeachers)
      .innerJoin(groups, eq(groups.id, groupTeachers.groupId))
      .where(
        and(
          eq(groups.schoolId, options.schoolId),
          eq(groups.status, "active"),
          eq(groups.scheduleEnabled, true),
          eq(groupTeachers.teacherId, replacement.userId),
          ne(groups.id, incoming.id)
        )
      );
    const existing = uniqueBy([...existingPrimary, ...existingCo], (group) => group.id);
    if (
      existing.some(
        (group) =>
          group.start &&
          group.end &&
          windowsOverlap(
            { start: incoming.start!, end: incoming.end! },
            { start: group.start, end: group.end }
          )
      )
    ) {
      throw lifecycleError(
        422,
        "STAFF_REPLACEMENT_INVALID",
        "A replacement teacher has an overlapping active class schedule.",
        { assignmentId: assignment.assignmentId }
      );
    }
  }
}

async function applyTransitionDecision(options: {
  schoolId: string;
  sourceUserId: string;
  assignment: StaffAssignmentImpactAssignment;
  decision: StaffTransitionDecision;
  replacement?: { membershipId: string; userId: string };
  dbInstance: LifecycleDb;
}): Promise<StaffTransitionResult["transferred"][number]> {
  const { assignment, decision, dbInstance } = options;
  const replacementUserId = options.replacement?.userId;
  if (decision.operation === "replace" && !replacementUserId) {
    throw lifecycleError(
      422,
      "STAFF_REPLACEMENT_INVALID",
      "A replacement membership is required."
    );
  }

  if (assignment.assignmentType === "class_primary") {
    if (decision.operation !== "replace") {
      throw lifecycleError(422, "STAFF_TRANSITION_INVALID", "Primary classes require a replacement.");
    }
    const [updated] = await dbInstance
      .update(groups)
      .set({ teacherId: replacementUserId! })
      .where(
        and(
          eq(groups.id, assignment.resourceId),
          eq(groups.schoolId, options.schoolId),
          eq(groups.status, "active"),
          eq(groups.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: groups.id });
    if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    await dbInstance
      .delete(groupTeachers)
      .where(
        and(
          eq(groupTeachers.groupId, assignment.resourceId),
          or(
            eq(groupTeachers.role, "primary"),
            eq(groupTeachers.teacherId, options.sourceUserId),
            eq(groupTeachers.teacherId, replacementUserId!)
          )
        )
      );
    await dbInstance.insert(groupTeachers).values({
      groupId: assignment.resourceId,
      teacherId: replacementUserId!,
      role: "primary",
    });
  } else if (assignment.assignmentType === "class_co_teacher") {
    const [removed] = await dbInstance
      .delete(groupTeachers)
      .where(
        and(
          eq(groupTeachers.id, assignment.assignmentId),
          eq(groupTeachers.groupId, assignment.resourceId),
          eq(groupTeachers.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: groupTeachers.id });
    if (!removed) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    if (decision.operation === "replace") {
      const [current] = await dbInstance
        .select({ teacherId: groups.teacherId })
        .from(groups)
        .where(and(eq(groups.id, assignment.resourceId), eq(groups.schoolId, options.schoolId)))
        .limit(1);
      if (!current) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
      if (current.teacherId !== replacementUserId) {
        await dbInstance
          .insert(groupTeachers)
          .values({
            groupId: assignment.resourceId,
            teacherId: replacementUserId!,
            role: "co-teacher",
          })
          .onConflictDoUpdate({
            target: [groupTeachers.groupId, groupTeachers.teacherId],
            set: { role: "co-teacher" },
          });
      }
    }
  } else if (assignment.assignmentType === "passpilot_legacy_class") {
    const [removed] = await dbInstance
      .delete(teacherGrades)
      .where(
        and(
          eq(teacherGrades.id, assignment.assignmentId),
          eq(teacherGrades.teacherId, options.sourceUserId),
          eq(teacherGrades.gradeId, assignment.resourceId)
        )
      )
      .returning({ id: teacherGrades.id });
    if (!removed) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    if (decision.operation === "replace") {
      await dbInstance
        .insert(teacherGrades)
        .values({ teacherId: replacementUserId!, gradeId: assignment.resourceId })
        .onConflictDoNothing();
    }
  } else if (assignment.assignmentType === "gopilot_homeroom_primary") {
    if (decision.operation !== "replace") {
      throw lifecycleError(422, "STAFF_TRANSITION_INVALID", "Primary homerooms require a replacement.");
    }
    const [updated] = await dbInstance
      .update(homerooms)
      .set({ teacherId: replacementUserId! })
      .where(
        and(
          eq(homerooms.id, assignment.resourceId),
          eq(homerooms.schoolId, options.schoolId),
          eq(homerooms.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: homerooms.id });
    if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    await dbInstance
      .delete(homeroomTeachers)
      .where(
        and(
          eq(homeroomTeachers.homeroomId, assignment.resourceId),
          eq(homeroomTeachers.schoolId, options.schoolId),
          or(
            eq(homeroomTeachers.role, "primary"),
            eq(homeroomTeachers.teacherId, options.sourceUserId),
            eq(homeroomTeachers.teacherId, replacementUserId!)
          )
        )
      );
    await dbInstance.insert(homeroomTeachers).values({
      schoolId: options.schoolId,
      homeroomId: assignment.resourceId,
      teacherId: replacementUserId!,
      role: "primary",
    });
  } else if (assignment.assignmentType === "gopilot_homeroom_co_teacher") {
    const [removed] = await dbInstance
      .delete(homeroomTeachers)
      .where(
        and(
          eq(homeroomTeachers.id, assignment.assignmentId),
          eq(homeroomTeachers.schoolId, options.schoolId),
          eq(homeroomTeachers.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: homeroomTeachers.id });
    if (!removed) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    if (decision.operation === "replace") {
      const [current] = await dbInstance
        .select({ teacherId: homerooms.teacherId })
        .from(homerooms)
        .where(and(eq(homerooms.id, assignment.resourceId), eq(homerooms.schoolId, options.schoolId)))
        .limit(1);
      if (!current) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
      if (current.teacherId !== replacementUserId) {
        await dbInstance
          .insert(homeroomTeachers)
          .values({
            schoolId: options.schoolId,
            homeroomId: assignment.resourceId,
            teacherId: replacementUserId!,
            role: "co-teacher",
          })
          .onConflictDoUpdate({
            target: [homeroomTeachers.homeroomId, homeroomTeachers.teacherId],
            set: { role: "co-teacher" },
          });
      }
    }
  } else if (assignment.assignmentType === "coverage_assignment") {
    if (decision.operation === "remove") {
      const [updated] = await dbInstance
        .update(classpilotCoverageAssignments)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(classpilotCoverageAssignments.id, assignment.assignmentId),
            eq(classpilotCoverageAssignments.schoolId, options.schoolId),
            eq(classpilotCoverageAssignments.staffId, options.sourceUserId),
            eq(classpilotCoverageAssignments.active, true)
          )
        )
        .returning({ id: classpilotCoverageAssignments.id });
      if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    } else {
      const [updated] = await dbInstance
        .update(classpilotCoverageAssignments)
        .set({ staffId: replacementUserId!, updatedAt: new Date() })
        .where(
          and(
            eq(classpilotCoverageAssignments.id, assignment.assignmentId),
            eq(classpilotCoverageAssignments.schoolId, options.schoolId),
            eq(classpilotCoverageAssignments.staffId, options.sourceUserId),
            eq(classpilotCoverageAssignments.active, true)
          )
        )
        .returning({ id: classpilotCoverageAssignments.id });
      if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    }
  } else if (assignment.assignmentType === "teacher_student_assignment") {
    const [removed] = await dbInstance
      .delete(teacherStudents)
      .where(
        and(
          eq(teacherStudents.id, assignment.assignmentId),
          eq(teacherStudents.schoolId, options.schoolId),
          eq(teacherStudents.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: teacherStudents.id });
    if (!removed) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
    if (decision.operation === "replace") {
      const [existing] = await dbInstance
        .select({ id: teacherStudents.id })
        .from(teacherStudents)
        .where(
          and(
            eq(teacherStudents.schoolId, options.schoolId),
            eq(teacherStudents.teacherId, replacementUserId!),
            eq(teacherStudents.studentId, assignment.resourceId)
          )
        )
        .limit(1);
      if (!existing) {
        await dbInstance.insert(teacherStudents).values({
          schoolId: options.schoolId,
          teacherId: replacementUserId!,
          studentId: assignment.resourceId,
        });
      }
    }
  } else if (assignment.assignmentType === "flight_path") {
    const [updated] = await dbInstance
      .update(flightPaths)
      .set({ teacherId: decision.operation === "replace" ? replacementUserId! : null })
      .where(
        and(
          eq(flightPaths.id, assignment.assignmentId),
          eq(flightPaths.schoolId, options.schoolId),
          eq(flightPaths.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: flightPaths.id });
    if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
  } else if (assignment.assignmentType === "block_list") {
    if (decision.operation !== "replace") {
      throw lifecycleError(
        422,
        "STAFF_TRANSITION_INVALID",
        "Block Lists require a replacement owner."
      );
    }
    const [updated] = await dbInstance
      .update(blockLists)
      .set({ teacherId: replacementUserId! })
      .where(
        and(
          eq(blockLists.id, assignment.assignmentId),
          eq(blockLists.schoolId, options.schoolId),
          eq(blockLists.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: blockLists.id });
    if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
  } else if (assignment.assignmentType === "student_group") {
    const [updated] = await dbInstance
      .update(studentGroups)
      .set({ teacherId: decision.operation === "replace" ? replacementUserId! : null })
      .where(
        and(
          eq(studentGroups.id, assignment.assignmentId),
          eq(studentGroups.schoolId, options.schoolId),
          eq(studentGroups.teacherId, options.sourceUserId)
        )
      )
      .returning({ id: studentGroups.id });
    if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
  } else if (assignment.assignmentType === "central_email_recipient") {
    const [updated] = await dbInstance
      .update(settings)
      .set({ centralEmailRecipientUserId: decision.operation === "replace" ? replacementUserId! : null })
      .where(
        and(
          eq(settings.id, assignment.assignmentId),
          eq(settings.schoolId, options.schoolId),
          eq(settings.centralEmailRecipientUserId, options.sourceUserId)
        )
      )
      .returning({ id: settings.id });
    if (!updated) throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff assignments changed; review them again.");
  }

  return {
    assignmentType: assignment.assignmentType,
    assignmentId: assignment.assignmentId,
    resourceId: assignment.resourceId,
    operation: decision.operation,
    ...(replacementUserId ? { replacementUserId } : {}),
  };
}

async function invalidateStaffAuthorization(schoolId: string): Promise<void> {
  const target = {
    kind: "cache-invalidation",
    schoolId,
    cache: "classpilot-passive-authorization",
  } as const;
  dispatchCacheInvalidation(target);
  await publishCacheInvalidation(target);
}

async function loadClassStateCounts(
  schoolId: string,
  classIds: string[],
  dbInstance: LifecycleDb
): Promise<StaffClassStateCounts> {
  if (classIds.length === 0) {
    return {
      classCount: 0,
      rosterMembershipCount: 0,
      teachingSessionCount: 0,
    };
  }

  const [classCountRow] = await dbInstance
    .select({ count: count() })
    .from(groups)
    .where(and(eq(groups.schoolId, schoolId), inArray(groups.id, classIds)));
  const [rosterCountRow] = await dbInstance
    .select({ count: count() })
    .from(groupStudents)
    .where(inArray(groupStudents.groupId, classIds));
  const [historyCountRow] = await dbInstance
    .select({ count: count() })
    .from(teachingSessions)
    .innerJoin(groups, eq(groups.id, teachingSessions.groupId))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        inArray(teachingSessions.groupId, classIds)
      )
    );

  return {
    classCount: Number(classCountRow?.count ?? 0),
    rosterMembershipCount: Number(rosterCountRow?.count ?? 0),
    teachingSessionCount: Number(historyCountRow?.count ?? 0),
  };
}

function classStateCountsMatch(
  left: StaffClassStateCounts,
  right: StaffClassStateCounts
): boolean {
  return (
    left.classCount === right.classCount &&
    left.rosterMembershipCount === right.rosterMembershipCount &&
    left.teachingSessionCount === right.teachingSessionCount
  );
}

export async function transitionStaffAssignments(options: {
  schoolId: string;
  membershipId: string;
  request: StaffTransitionRequest;
  actorUserId: string;
  actorRole?: string;
  allowInactiveSource?: boolean;
  expectedSourceUserId?: string;
  auditAction?: string;
  classStateInvariant?: StaffClassStateInvariant;
  repairProof?: {
    expectedProof: string;
    targetMembershipId: string;
  };
}): Promise<StaffTransitionResult> {
  const hasNewGopilotRole = Object.prototype.hasOwnProperty.call(
    options.request,
    "newGopilotRole"
  );
  if (
    !options.request.expectedRevision ||
    !Array.isArray(options.request.decisions) ||
    (options.request.action === "change_role" &&
      (!options.request.newRole && !hasNewGopilotRole)) ||
    (options.request.newRole !== undefined &&
      !STAFF_TRANSITION_ROLES.includes(options.request.newRole)) ||
    (hasNewGopilotRole &&
      options.request.newGopilotRole !== null &&
      options.request.newGopilotRole !== "teacher" &&
      options.request.newGopilotRole !== "office_staff") ||
    (options.request.action === "deactivate" &&
      (options.request.newRole !== undefined || hasNewGopilotRole)) ||
    (options.allowInactiveSource &&
      (!options.classStateInvariant || !options.repairProof))
  ) {
    throw lifecycleError(422, "STAFF_TRANSITION_INVALID", "Invalid staff transition request.");
  }

  let credentialInvalidatedUserId: string | undefined;
  try {
    const result = await db.transaction(
      async (rawTx) => {
        const tx = rawTx as unknown as LifecycleDb;
        const [candidateMembership] = await tx
          .select({ userId: schoolMemberships.userId })
          .from(schoolMemberships)
          .where(
            and(
              eq(schoolMemberships.id, options.membershipId),
              eq(schoolMemberships.schoolId, options.schoolId)
            )
          )
          .limit(1);
        if (!candidateMembership) {
          throw lifecycleError(404, "STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.");
        }
        const [candidateUser] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, candidateMembership.userId))
          .limit(1);
        if (!candidateUser) {
          throw lifecycleError(
            409,
            "STAFF_IDENTITY_STALE",
            "The staff identity changed concurrently; review it again."
          );
        }
        const {
          staffIdentityEmailLockKey,
          staffIdentityUserLockKey,
          takeStaffIdentityLocks,
        } = await import("./storage.js");
        await takeStaffIdentityLocks(
          tx as unknown as Parameters<typeof takeStaffIdentityLocks>[0],
          [
            staffIdentityEmailLockKey(candidateUser.email),
            staffIdentityUserLockKey(candidateMembership.userId),
          ]
        );
        const schoolLocked = await lockStaffAssignmentLifecycleSchool(
          tx as unknown as Parameters<typeof lockStaffAssignmentLifecycleSchool>[0],
          options.schoolId
        );
        if (!schoolLocked) {
          throw lifecycleError(404, "STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.");
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${options.schoolId}`}))`
        );
        const [membership] = await tx
          .select()
          .from(schoolMemberships)
          .where(
            and(
              eq(schoolMemberships.id, options.membershipId),
              eq(schoolMemberships.schoolId, options.schoolId)
            )
          )
          .limit(1)
          .for("update");
        if (!membership || (options.expectedSourceUserId && membership.userId !== options.expectedSourceUserId)) {
          throw lifecycleError(404, "STAFF_MEMBERSHIP_NOT_FOUND", "Staff membership not found.");
        }
        const [lockedUser] = await tx
          .select({ email: users.email, isSuperAdmin: users.isSuperAdmin })
          .from(users)
          .where(eq(users.id, membership.userId))
          .limit(1)
          .for("update");
        if (
          membership.userId !== candidateMembership.userId ||
          !lockedUser ||
          lockedUser.email.trim().toLowerCase() !== candidateUser.email.trim().toLowerCase()
        ) {
          throw lifecycleError(
            409,
            "STAFF_IDENTITY_STALE",
            "The staff identity changed concurrently; review it again."
          );
        }
        if (lockedUser.isSuperAdmin && options.actorRole !== "super_admin") {
          throw lifecycleError(
            409,
            "STAFF_IDENTITY_CENTRAL_REVIEW_REQUIRED",
            "A Super Admin must review school access changes for this central identity."
          );
        }
        if (membership.status !== "active" && !options.allowInactiveSource) {
          throw lifecycleError(422, "STAFF_TRANSITION_INVALID", "Only active staff may use the transition workflow.");
        }

        const nextStatus = options.request.action === "deactivate"
          ? "inactive"
          : membership.status;
        const nextRole = options.request.newRole ?? membership.role;
        const nextGopilotRole = hasNewGopilotRole
          ? options.request.newGopilotRole ?? null
          : membership.gopilotRole;
        const loss = await staffEligibilityLoss({
          membership,
          nextStatus,
          nextRole,
          nextGopilotRole,
          dbInstance: tx,
        });
        const normalizedTarget: StaffTransitionTarget = options.request.action === "deactivate"
          ? { action: "deactivate" }
          : {
              action: "change_role",
              newRole: nextRole,
              newGopilotRole: nextGopilotRole,
            };
        const fullImpact = await loadImpactForMembership(
          options.schoolId,
          membership,
          normalizedTarget,
          tx
        );
        const impact = impactForEligibilityLoss(
          fullImpact,
          loss,
          options.allowInactiveSource === true
        );
        if (impact.revision !== options.request.expectedRevision) {
          throw lifecycleError(
            409,
            "STAFF_ASSIGNMENT_IMPACT_STALE",
            "Staff assignments changed; review them again.",
            { currentRevision: impact.revision }
          );
        }

        let preservationBefore: StaffClassStateCounts | undefined;
        if (options.classStateInvariant) {
          const impactedClassIds = [
            ...new Set(
              impact.assignments
                .filter(
                  (assignment) =>
                    assignment.assignmentType === "class_primary" ||
                    assignment.assignmentType === "class_co_teacher"
                )
                .map((assignment) => assignment.resourceId)
            ),
          ].sort();
          const requestedClassIds = [
            ...new Set(options.classStateInvariant.classIds),
          ].sort();
          if (
            requestedClassIds.length !== options.classStateInvariant.classIds.length ||
            JSON.stringify(requestedClassIds) !== JSON.stringify(impactedClassIds)
          ) {
            throw lifecycleError(
              422,
              "STAFF_TRANSITION_INVALID",
              "The class preservation scope must exactly match the current class assignments."
            );
          }
          preservationBefore = await loadClassStateCounts(
            options.schoolId,
            requestedClassIds,
            tx
          );
          if (!classStateCountsMatch(preservationBefore, options.classStateInvariant.expected)) {
            throw lifecycleError(
              409,
              "STAFF_REPAIR_INVARIANT_STALE",
              "Class, roster, or teaching-history counts changed; run a new dry run."
            );
          }
        }

        if (options.repairProof) {
          if (!preservationBefore || !options.classStateInvariant) {
            throw lifecycleError(
              422,
              "STAFF_TRANSITION_INVALID",
              "Recovery proof requires transactional class-state preservation."
            );
          }
          const [proofTargetMembership] = await tx
            .select({
              id: schoolMemberships.id,
              userId: schoolMemberships.userId,
              role: schoolMemberships.role,
            })
            .from(schoolMemberships)
            .innerJoin(users, eq(users.id, schoolMemberships.userId))
            .where(
              and(
                eq(schoolMemberships.id, options.repairProof.targetMembershipId),
                eq(schoolMemberships.schoolId, options.schoolId),
                eq(schoolMemberships.status, "active")
              )
            )
            .limit(1)
            .for("update");
          const exactTargetUsed = options.request.decisions.every(
            (decision) =>
              decision.operation === "replace" &&
              decision.replacementMembershipId === options.repairProof!.targetMembershipId
          );
          const currentProof = createStaffIdentityRepairProof({
            schoolId: options.schoolId,
            sourceMembershipId: membership.id,
            targetMembershipId: options.repairProof.targetMembershipId,
            impactRevision: impact.revision,
            preservationCounts: preservationBefore,
          });
          if (
            !proofTargetMembership ||
            proofTargetMembership.userId === membership.userId ||
            !hasBaseTeachingEligibility(proofTargetMembership) ||
            !exactTargetUsed ||
            currentProof !== options.repairProof.expectedProof
          ) {
            throw lifecycleError(
              409,
              "STAFF_REPAIR_PROOF_INVALID",
              "Recovery inputs changed; run a new dry run."
            );
          }
        }

        const requiresAssignmentTransfer =
          options.allowInactiveSource === true || Object.values(loss).some(Boolean);
        if (requiresAssignmentTransfer && impact.blockers.length > 0) {
          throw lifecycleError(
            409,
            "STAFF_TRANSITION_BLOCKED",
            "End active sessions and resolve schedule workflows before transitioning this staff member.",
            {
              blockerCount: impact.blockers.length,
              blockerTypes: [...new Set(impact.blockers.map((blocker) => blocker.blockerType))],
            }
          );
        }

        const decisionsByIdentity = new Map<string, StaffTransitionDecision>();
        const effectiveDecisions = requiresAssignmentTransfer
          ? options.request.decisions
          : [];
        for (const decision of effectiveDecisions) {
          const identity = decisionIdentity(decision);
          if (decisionsByIdentity.has(identity)) {
            throw lifecycleError(422, "STAFF_TRANSITION_INVALID", "Each assignment must have exactly one decision.");
          }
          decisionsByIdentity.set(identity, decision);
        }
        const assignmentIdentities = new Set(impact.assignments.map(decisionIdentity));
        const missing = impact.assignments.filter(
          (assignment) => !decisionsByIdentity.has(decisionIdentity(assignment))
        );
        const unexpected = [...decisionsByIdentity.keys()].filter(
          (identity) => !assignmentIdentities.has(identity)
        );
        if (requiresAssignmentTransfer && (missing.length > 0 || unexpected.length > 0)) {
          throw lifecycleError(
            409,
            "STAFF_ASSIGNMENT_DECISIONS_REQUIRED",
            "Provide one current decision for every active staff assignment.",
            {
              missingAssignmentIds: missing.map((assignment) => assignment.assignmentId),
              unexpectedDecisionCount: unexpected.length,
            }
          );
        }

        for (const assignment of impact.assignments) {
          const decision = decisionsByIdentity.get(decisionIdentity(assignment));
          if (!decision) continue;
          if (!assignment.allowedOperations.includes(decision.operation)) {
            throw lifecycleError(422, "STAFF_TRANSITION_INVALID", "An assignment decision uses an unsupported operation.");
          }
          if (
            (decision.operation === "replace" && !decision.replacementMembershipId) ||
            (decision.operation === "remove" && decision.replacementMembershipId !== undefined)
          ) {
            throw lifecycleError(422, "STAFF_TRANSITION_INVALID", "Replacement membership usage is invalid.");
          }
        }

        const replacements = await validateReplacementMemberships({
          schoolId: options.schoolId,
          sourceUserId: membership.userId,
          decisions: effectiveDecisions,
          assignmentsByIdentity: new Map(
            impact.assignments.map((assignment) => [decisionIdentity(assignment), assignment])
          ),
          dbInstance: tx,
        });
        await assertReplacementSchedulesDoNotOverlap({
          schoolId: options.schoolId,
          impact,
          decisionsByIdentity,
          replacements,
          actorUserId: options.actorUserId,
          dbInstance: tx,
        });

        const transferred: StaffTransitionResult["transferred"] = [];
        if (requiresAssignmentTransfer) {
          for (const assignment of impact.assignments) {
            const decision = decisionsByIdentity.get(decisionIdentity(assignment))!;
            transferred.push(
              await applyTransitionDecision({
                schoolId: options.schoolId,
                sourceUserId: membership.userId,
                assignment,
                decision,
                replacement: decision.replacementMembershipId
                  ? replacements.get(decision.replacementMembershipId)
                  : undefined,
                dbInstance: tx,
              })
            );
          }
        }

        const [savedMembership] = await tx
          .update(schoolMemberships)
          .set(
            options.request.action === "deactivate"
              ? { status: "inactive" }
              : {
                  ...(options.request.newRole !== undefined
                    ? { role: options.request.newRole }
                    : {}),
                  ...(hasNewGopilotRole
                    ? { gopilotRole: nextGopilotRole }
                    : {}),
                }
          )
          .where(
            and(
              eq(schoolMemberships.id, membership.id),
              eq(schoolMemberships.schoolId, options.schoolId)
            )
          )
          .returning();
        if (!savedMembership) {
          throw lifecycleError(409, "STAFF_ASSIGNMENT_IMPACT_STALE", "Staff membership changed; review it again.");
        }
        const membershipAuthorityChanged =
          nextStatus !== membership.status ||
          nextRole !== membership.role ||
          nextGopilotRole !== membership.gopilotRole;
        if (membershipAuthorityChanged || options.allowInactiveSource) {
          await tx
            .update(users)
            .set({ authVersion: sql`${users.authVersion} + 1`, updatedAt: new Date() })
            .where(eq(users.id, membership.userId));
          credentialInvalidatedUserId = membership.userId;
        }
        let preservation: StaffTransitionResult["preservation"];
        if (options.classStateInvariant && preservationBefore) {
          const preservationAfter = await loadClassStateCounts(
            options.schoolId,
            options.classStateInvariant.classIds,
            tx
          );
          if (!classStateCountsMatch(preservationBefore, preservationAfter)) {
            throw lifecycleError(
              500,
              "STAFF_REPAIR_INVARIANT_VIOLATION",
              "The staff transition changed protected class, roster, or teaching-history counts."
            );
          }
          preservation = {
            before: preservationBefore,
            after: preservationAfter,
            unchanged: true,
          };
        }
        await tx.insert(auditLogs).values({
          schoolId: options.schoolId,
          userId: options.actorUserId,
          userRole: options.actorRole ?? null,
          action: options.auditAction ?? "school.staff.transitioned",
          entityType: "school_membership",
          entityId: membership.id,
          changes: {
            action: options.request.action,
            fromRole: membership.role,
            toRole: savedMembership.role,
            fromGopilotRole: membership.gopilotRole,
            toGopilotRole: savedMembership.gopilotRole,
            fromStatus: membership.status,
            toStatus: savedMembership.status,
            assignmentCount: transferred.length,
          },
          metadata: {
            sourceUserId: membership.userId,
            replacementUserIds: [...new Set(
              transferred
                .map((entry) => entry.replacementUserId)
                .filter((value): value is string => Boolean(value))
            )],
          },
        });
        return {
          membership: savedMembership,
          transferred,
          ...(preservation ? { preservation } : {}),
        };
      },
      // The lifecycle lock is the serialization boundary for live staff ownership.
      // READ COMMITTED is intentional: a transition that waits behind a blocker
      // writer must see that writer's commit when it reloads impact in-lock.
      // A SERIALIZABLE snapshot established by the identity lookups above can hide
      // that commit even though the lifecycle lock was acquired afterward.
      { isolationLevel: "read committed" }
    );
    await invalidateStaffAuthorization(options.schoolId);
    if (credentialInvalidatedUserId) {
      await invalidateUserCredentialConnections(credentialInvalidatedUserId);
    }
    return result;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "40001" || code === "40P01") {
      throw lifecycleError(
        409,
        "STAFF_ASSIGNMENT_IMPACT_STALE",
        "Staff assignments changed concurrently; review them again."
      );
    }
    throw error;
  }
}

export type StaffAssignmentIntegrityReason =
  | "missing_active_teachable_membership"
  | "missing_active_gopilot_teacher_membership"
  | "missing_active_staff_membership";

export type StaffRelationshipIntegrityReason =
  | StaffAssignmentIntegrityReason
  | "unsupported_relationship_role"
  | "primary_owner_mismatch"
  | "co_teacher_duplicates_primary"
  | "missing_parent"
  | "cross_school_parent";

export type StaffTenantScopeResourceType =
  | "teacher_student_assignment"
  | "active_teaching_session"
  | "active_session_staff"
  | "active_schedule_change"
  | "active_scheduled_conflict";

export type StaffAssignmentIntegrityIssues = {
  invalidPrimaryAssignments: Array<{
    groupId: string;
    teacherId: string;
    reason: "missing_active_teachable_membership";
  }>;
  invalidCoTeacherAssignments: Array<{
    groupId: string;
    teacherId: string;
    relationshipId: string;
    reason: "missing_active_teachable_membership";
  }>;
  /** Canonical relationship inventory; invalidCoTeacherAssignments is retained for old clients. */
  invalidClassRelationships: Array<{
    groupId: string;
    teacherId: string;
    relationshipId: string;
    role: string;
    reasons: StaffRelationshipIntegrityReason[];
  }>;
  primaryMirrorMismatches: Array<{
    groupId: string;
    teacherId: string;
    mirrorTeacherIds: string[];
  }>;
  invalidLiveAssignments: Array<{
    assignmentType: StaffAssignmentType;
    assignmentId: string;
    resourceId: string;
    ownerUserId: string;
    reason: StaffAssignmentIntegrityReason;
  }>;
  invalidLiveBlockers: Array<{
    blockerType: StaffAssignmentBlockerType;
    blockerId: string;
    resourceId?: string;
    ownerUserId: string;
    reason: StaffAssignmentIntegrityReason;
  }>;
  homeroomPrimaryMirrorMismatches: Array<{
    homeroomId: string;
    teacherId: string | null;
    mirrorTeacherIds: string[];
  }>;
  invalidHomeroomRelationships: Array<{
    relationshipId: string;
    homeroomId: string;
    teacherId: string;
    role: string;
    relationshipSchoolId: string;
    homeroomSchoolId: string | null;
    reasons: StaffRelationshipIntegrityReason[];
  }>;
  invalidTenantScopes: Array<{
    resourceType: StaffTenantScopeResourceType;
    resourceId: string;
    parentResourceId?: string;
    storedSchoolId: string | null;
    parentSchoolId: string | null;
    reason: "missing_parent" | "school_mismatch";
  }>;
  invalidAssignmentCountsByType: Partial<Record<StaffAssignmentType, number>>;
  invalidBlockerCountsByType: Partial<Record<StaffAssignmentBlockerType, number>>;
  counts: {
    invalidPrimaryAssignments: number;
    invalidCoTeacherAssignments: number;
    invalidClassRelationships: number;
    primaryMirrorMismatches: number;
    invalidLiveAssignments: number;
    invalidLiveBlockers: number;
    homeroomPrimaryMirrorMismatches: number;
    invalidHomeroomRelationships: number;
    invalidTenantScopes: number;
  };
  total: number;
};

export type StaffUnscopedAssignmentIntegrityIssues = {
  unscopedTenantDependencies: Array<{
    resourceType: string;
    resourceId: string;
    storedSchoolId: string | null;
  }>;
  counts: {
    unscopedTenantDependencies: number;
  };
  total: number;
};

/**
 * Global ID-only bucket for live rows that cannot be attributed to any tenant.
 * School-scoped scans cannot discover a live dependency whose tenant key has
 * no schools parent, nor a legacy active session with neither a tenant snapshot
 * nor a parent group. Stage-five inventory and monitoring query this bucket
 * separately under their existing super-admin database context.
 */
export async function getUnscopedStaffAssignmentIntegrityIssues(
  dbInstance: LifecycleDb = db as unknown as LifecycleDb
): Promise<StaffUnscopedAssignmentIntegrityIssues> {
  const result = await dbInstance.execute<{
    resource_type: string;
    resource_id: string;
    stored_school_id: string | null;
  }>(sql`
    SELECT resource_type, resource_id, stored_school_id
    FROM (
      SELECT 'active_class'::text AS resource_type,
        class_group.id AS resource_id, class_group.school_id AS stored_school_id
      FROM groups AS class_group
      WHERE class_group.group_type IN ('admin_class', 'teacher_created', 'teacher_small_group')
        AND class_group.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id)

      UNION ALL
      SELECT 'gopilot_homeroom', homeroom.id, homeroom.school_id
      FROM homerooms AS homeroom
      WHERE NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = homeroom.school_id)

      UNION ALL
      SELECT 'gopilot_homeroom_relationship', relationship.id, relationship.school_id
      FROM homeroom_teachers AS relationship
      WHERE NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = relationship.school_id)

      UNION ALL
      SELECT 'passpilot_legacy_class', relationship.id, grade.school_id
      FROM teacher_grades AS relationship
      INNER JOIN grades AS grade ON grade.id = relationship.grade_id
      LEFT JOIN settings AS school_settings ON school_settings.school_id = grade.school_id
      WHERE COALESCE(school_settings.passpilot_class_source, 'legacy_grades') = 'legacy_grades'
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = grade.school_id)

      UNION ALL
      SELECT 'teacher_student_assignment', relationship.id,
        COALESCE(relationship.school_id, student.school_id)
      FROM teacher_students AS relationship
      INNER JOIN students AS student ON student.id = relationship.student_id
      WHERE student.status = 'active'
        AND (
          NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = student.school_id)
          OR (
            relationship.school_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM schools AS school WHERE school.id = relationship.school_id
            )
          )
        )

      UNION ALL
      SELECT 'flight_path', resource.id, resource.school_id
      FROM flight_paths AS resource
      WHERE resource.teacher_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = resource.school_id)

      UNION ALL
      SELECT 'block_list', resource.id, resource.school_id
      FROM block_lists AS resource
      WHERE NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = resource.school_id)

      UNION ALL
      SELECT 'student_group', resource.id, resource.school_id
      FROM student_groups AS resource
      WHERE resource.teacher_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = resource.school_id)

      UNION ALL
      SELECT 'coverage_assignment', assignment.id, assignment.school_id
      FROM classpilot_coverage_assignments AS assignment
      WHERE assignment.active = true
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = assignment.school_id)

      UNION ALL
      SELECT 'central_email_recipient', school_settings.id, school_settings.school_id
      FROM settings AS school_settings
      WHERE school_settings.central_email_recipient_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = school_settings.school_id)

      UNION ALL
      SELECT 'active_teaching_session', teaching_session.id,
        COALESCE(teaching_session.school_id, class_group.school_id)
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
      SELECT 'active_session_staff', session_staff.id,
        COALESCE(session_staff.school_id, teaching_session.school_id, class_group.school_id)
      FROM classpilot_session_staff AS session_staff
      INNER JOIN teaching_sessions AS teaching_session
        ON teaching_session.id = session_staff.teaching_session_id
      LEFT JOIN groups AS class_group ON class_group.id = teaching_session.group_id
      WHERE teaching_session.end_time IS NULL
        AND (
          NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = session_staff.school_id)
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
      SELECT 'active_supervision_context', context.id, context.school_id
      FROM classpilot_supervision_contexts AS context
      WHERE context.status = 'active' AND context.ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = context.school_id)

      UNION ALL
      SELECT 'active_kiosk_session', kiosk_session.id, kiosk_session.school_id
      FROM passpilot_kiosk_sessions AS kiosk_session
      WHERE kiosk_session.status = 'active' AND kiosk_session.teacher_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = kiosk_session.school_id)

      UNION ALL
      SELECT 'active_schedule_change', schedule_leg.id,
        COALESCE(schedule_leg.school_id, schedule_change.school_id, class_group.school_id)
      FROM classpilot_schedule_change_legs AS schedule_leg
      INNER JOIN classpilot_schedule_changes AS schedule_change
        ON schedule_change.id = schedule_leg.schedule_change_id
      LEFT JOIN groups AS class_group ON class_group.id = schedule_leg.group_id
      WHERE schedule_change.reservation_active = true
        AND schedule_leg.reservation_active = true
        AND schedule_change.status IN ('pending_counterpart', 'pending_admin', 'approved')
        AND (
          NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = schedule_leg.school_id)
          OR NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = schedule_change.school_id)
          OR (
            class_group.id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id
            )
          )
        )

      UNION ALL
      SELECT 'active_scheduled_conflict', conflict.id,
        COALESCE(conflict.school_id, class_group.school_id)
      FROM classpilot_scheduled_conflicts AS conflict
      LEFT JOIN groups AS class_group ON class_group.id = conflict.group_id
      WHERE conflict.status IN ('coverage_needed', 'claimed', 'pending')
        AND (
          NOT EXISTS (SELECT 1 FROM schools AS school WHERE school.id = conflict.school_id)
          OR (
            class_group.id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM schools AS school WHERE school.id = class_group.school_id
            )
          )
        )
    ) AS unscoped
    ORDER BY resource_type, resource_id
  `);
  const rows = result.rows.map((row) => ({
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    storedSchoolId: row.stored_school_id,
  }));
  return {
    unscopedTenantDependencies: rows,
    counts: {
      unscopedTenantDependencies: rows.length,
    },
    total: rows.length,
  };
}

/** ID-only school-scoped inventory for IT Readiness and controlled repair. */
export async function getStaffAssignmentIntegrityIssues(
  schoolId: string,
  dbInstance: LifecycleDb = db as unknown as LifecycleDb
): Promise<StaffAssignmentIntegrityIssues> {
  const activeMembershipRows = await dbInstance
    .select({
      userId: schoolMemberships.userId,
      role: schoolMemberships.role,
      gopilotRole: schoolMemberships.gopilotRole,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active")
      )
    );
  const activeStaff = new Set(
    activeMembershipRows.filter(hasActiveStaffEligibility).map((row) => row.userId)
  );
  const eligible = new Set(
    activeMembershipRows.filter(hasBaseTeachingEligibility).map((row) => row.userId)
  );
  const gopilotEligible = new Set(
    activeMembershipRows.filter(hasGopilotTeachingEligibility).map((row) => row.userId)
  );
  const activeClasses = await dbInstance
    .select({ id: groups.id, teacherId: groups.teacherId })
    .from(groups)
    .where(
      and(
        eq(groups.schoolId, schoolId),
        inArray(groups.groupType, [...ACTIVE_INSTRUCTIONAL_GROUP_TYPES]),
        eq(groups.status, "active")
      )
    )
    .orderBy(asc(groups.id));
  const classIds = activeClasses.map((group) => group.id);
  const relationships = classIds.length === 0
    ? []
    : await dbInstance
        .select({
          id: groupTeachers.id,
          groupId: groupTeachers.groupId,
          teacherId: groupTeachers.teacherId,
          role: groupTeachers.role,
        })
        .from(groupTeachers)
        .where(inArray(groupTeachers.groupId, classIds))
        .orderBy(asc(groupTeachers.id));
  const relationshipsByGroup = new Map<string, typeof relationships>();
  for (const relationship of relationships) {
    const current = relationshipsByGroup.get(relationship.groupId) ?? [];
    current.push(relationship);
    relationshipsByGroup.set(relationship.groupId, current);
  }
  const invalidPrimaryAssignments = activeClasses
    .filter((group) => !eligible.has(group.teacherId))
    .map((group) => ({
      groupId: group.id,
      teacherId: group.teacherId,
      reason: "missing_active_teachable_membership" as const,
    }));
  const invalidCoTeacherAssignments = relationships
    .filter((relationship) => relationship.role === "co-teacher" && !eligible.has(relationship.teacherId))
    .map((relationship) => ({
      groupId: relationship.groupId,
      teacherId: relationship.teacherId,
      relationshipId: relationship.id,
      reason: "missing_active_teachable_membership" as const,
    }));
  const classById = new Map(activeClasses.map((group) => [group.id, group]));
  const invalidClassRelationships: StaffAssignmentIntegrityIssues["invalidClassRelationships"] = [];
  for (const relationship of relationships) {
    const parent = classById.get(relationship.groupId);
    if (!parent) continue;
    const reasons: StaffRelationshipIntegrityReason[] = [];
    if (!eligible.has(relationship.teacherId)) {
      reasons.push("missing_active_teachable_membership");
    }
    if (relationship.role !== "primary" && relationship.role !== "co-teacher") {
      reasons.push("unsupported_relationship_role");
    } else if (
      relationship.role === "primary" &&
      relationship.teacherId !== parent.teacherId
    ) {
      reasons.push("primary_owner_mismatch");
    } else if (
      relationship.role === "co-teacher" &&
      relationship.teacherId === parent.teacherId
    ) {
      reasons.push("co_teacher_duplicates_primary");
    }
    if (reasons.length > 0) {
      invalidClassRelationships.push({
        groupId: relationship.groupId,
        teacherId: relationship.teacherId,
        relationshipId: relationship.id,
        role: relationship.role,
        reasons,
      });
    }
  }
  const primaryMirrorMismatches = activeClasses.flatMap((group) => {
    const mirrorTeacherIds = (relationshipsByGroup.get(group.id) ?? [])
      .filter((relationship) => relationship.role === "primary")
      .map((relationship) => relationship.teacherId)
      .sort();
    return mirrorTeacherIds.length === 1 && mirrorTeacherIds[0] === group.teacherId
      ? []
      : [{ groupId: group.id, teacherId: group.teacherId, mirrorTeacherIds }];
  });

  const invalidLiveAssignments: StaffAssignmentIntegrityIssues["invalidLiveAssignments"] = [];
  const recordInvalidAssignment = (entry: StaffAssignmentIntegrityIssues["invalidLiveAssignments"][number]) => {
    invalidLiveAssignments.push(entry);
  };
  const invalidTenantScopes: StaffAssignmentIntegrityIssues["invalidTenantScopes"] = [];

  const [schoolSettings] = await dbInstance
    .select({
      id: settings.id,
      classSource: settings.passpilotClassSource,
      centralRecipientUserId: settings.centralEmailRecipientUserId,
    })
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1);

  if (!schoolSettings || schoolSettings.classSource === "legacy_grades") {
    const rows = await dbInstance
      .select({ id: teacherGrades.id, gradeId: teacherGrades.gradeId, teacherId: teacherGrades.teacherId })
      .from(teacherGrades)
      .innerJoin(grades, eq(grades.id, teacherGrades.gradeId))
      .where(eq(grades.schoolId, schoolId));
    for (const row of rows) {
      if (!eligible.has(row.teacherId)) {
        recordInvalidAssignment({
          assignmentType: "passpilot_legacy_class",
          assignmentId: row.id,
          resourceId: row.gradeId,
          ownerUserId: row.teacherId,
          reason: "missing_active_teachable_membership",
        });
      }
    }
  }

  const homeroomRows = await dbInstance
    .select({ id: homerooms.id, teacherId: homerooms.teacherId })
    .from(homerooms)
    .where(eq(homerooms.schoolId, schoolId))
    .orderBy(asc(homerooms.id));
  const homeroomRelationships = await dbInstance
    .select({
      id: homeroomTeachers.id,
      homeroomId: homeroomTeachers.homeroomId,
      teacherId: homeroomTeachers.teacherId,
      role: homeroomTeachers.role,
      relationshipSchoolId: homeroomTeachers.schoolId,
      homeroomSchoolId: homerooms.schoolId,
      primaryTeacherId: homerooms.teacherId,
    })
    .from(homeroomTeachers)
    .leftJoin(homerooms, eq(homerooms.id, homeroomTeachers.homeroomId))
    .where(
      or(
        eq(homeroomTeachers.schoolId, schoolId),
        eq(homerooms.schoolId, schoolId)
      )
    )
    .orderBy(asc(homeroomTeachers.id));
  const homeroomRelationshipsById = new Map<string, typeof homeroomRelationships>();
  for (const relationship of homeroomRelationships) {
    if (
      relationship.relationshipSchoolId !== schoolId ||
      relationship.homeroomSchoolId !== schoolId
    ) {
      continue;
    }
    const current = homeroomRelationshipsById.get(relationship.homeroomId) ?? [];
    current.push(relationship);
    homeroomRelationshipsById.set(relationship.homeroomId, current);
  }
  for (const homeroom of homeroomRows) {
    if (homeroom.teacherId && !gopilotEligible.has(homeroom.teacherId)) {
      recordInvalidAssignment({
        assignmentType: "gopilot_homeroom_primary",
        assignmentId: homeroom.id,
        resourceId: homeroom.id,
        ownerUserId: homeroom.teacherId,
        reason: "missing_active_gopilot_teacher_membership",
      });
    }
  }
  const invalidHomeroomRelationships: StaffAssignmentIntegrityIssues["invalidHomeroomRelationships"] = [];
  for (const relationship of homeroomRelationships) {
    const reasons: StaffRelationshipIntegrityReason[] = [];
    if (relationship.relationshipSchoolId === schoolId) {
      if (!gopilotEligible.has(relationship.teacherId)) {
        reasons.push("missing_active_gopilot_teacher_membership");
        recordInvalidAssignment({
          assignmentType: relationship.role === "primary"
            ? "gopilot_homeroom_primary"
            : "gopilot_homeroom_co_teacher",
          assignmentId: relationship.id,
          resourceId: relationship.homeroomId,
          ownerUserId: relationship.teacherId,
          reason: "missing_active_gopilot_teacher_membership",
        });
      }
      if (relationship.role !== "primary" && relationship.role !== "co-teacher") {
        reasons.push("unsupported_relationship_role");
      }
    }
    if (relationship.homeroomSchoolId === null) {
      reasons.push("missing_parent");
    } else if (relationship.relationshipSchoolId !== relationship.homeroomSchoolId) {
      reasons.push("cross_school_parent");
    } else if (relationship.relationshipSchoolId === schoolId) {
      if (
        relationship.role === "primary" &&
        relationship.teacherId !== relationship.primaryTeacherId
      ) {
        reasons.push("primary_owner_mismatch");
      } else if (
        relationship.role === "co-teacher" &&
        relationship.teacherId === relationship.primaryTeacherId
      ) {
        reasons.push("co_teacher_duplicates_primary");
      }
    }
    if (reasons.length > 0) {
      invalidHomeroomRelationships.push({
        relationshipId: relationship.id,
        homeroomId: relationship.homeroomId,
        teacherId: relationship.teacherId,
        role: relationship.role,
        relationshipSchoolId: relationship.relationshipSchoolId,
        homeroomSchoolId: relationship.homeroomSchoolId,
        reasons,
      });
    }
  }
  const homeroomPrimaryMirrorMismatches = homeroomRows.flatMap((homeroom) => {
    const mirrorTeacherIds = (homeroomRelationshipsById.get(homeroom.id) ?? [])
      .filter((relationship) => relationship.role === "primary")
      .map((relationship) => relationship.teacherId)
      .sort();
    const mirrorMatches = homeroom.teacherId === null
      ? mirrorTeacherIds.length === 0
      : mirrorTeacherIds.length === 1 && mirrorTeacherIds[0] === homeroom.teacherId;
    return mirrorMatches
      ? []
      : [{ homeroomId: homeroom.id, teacherId: homeroom.teacherId, mirrorTeacherIds }];
  });

  const coverageRows = await dbInstance
    .select({ id: classpilotCoverageAssignments.id, staffId: classpilotCoverageAssignments.staffId })
    .from(classpilotCoverageAssignments)
    .where(
      and(
        eq(classpilotCoverageAssignments.schoolId, schoolId),
        eq(classpilotCoverageAssignments.active, true)
      )
    );
  for (const row of coverageRows) {
    if (!activeStaff.has(row.staffId)) {
      recordInvalidAssignment({
        assignmentType: "coverage_assignment",
        assignmentId: row.id,
        resourceId: row.id,
        ownerUserId: row.staffId,
        reason: "missing_active_staff_membership",
      });
    }
  }

  const directStudentRows = await dbInstance
    .select({
      id: teacherStudents.id,
      studentId: teacherStudents.studentId,
      teacherId: teacherStudents.teacherId,
      relationshipSchoolId: teacherStudents.schoolId,
      studentSchoolId: students.schoolId,
      studentStatus: students.status,
    })
    .from(teacherStudents)
    .leftJoin(students, eq(students.id, teacherStudents.studentId))
    .where(
      or(
        eq(teacherStudents.schoolId, schoolId),
        eq(students.schoolId, schoolId)
      )
    );
  for (const row of directStudentRows) {
    if (row.studentStatus !== "active" || row.studentSchoolId === null) continue;
    if (row.relationshipSchoolId !== row.studentSchoolId) {
      invalidTenantScopes.push({
        resourceType: "teacher_student_assignment",
        resourceId: row.id,
        parentResourceId: row.studentId,
        storedSchoolId: row.relationshipSchoolId,
        parentSchoolId: row.studentSchoolId,
        reason: "school_mismatch",
      });
    }
    if (row.studentSchoolId === schoolId && !eligible.has(row.teacherId)) {
      recordInvalidAssignment({
        assignmentType: "teacher_student_assignment",
        assignmentId: row.id,
        resourceId: row.studentId,
        ownerUserId: row.teacherId,
        reason: "missing_active_teachable_membership",
      });
    }
  }

  const flightPathRows = await dbInstance
    .select({ id: flightPaths.id, teacherId: flightPaths.teacherId })
    .from(flightPaths)
    .where(and(eq(flightPaths.schoolId, schoolId), sql`${flightPaths.teacherId} IS NOT NULL`));
  for (const row of flightPathRows) {
    if (row.teacherId && !eligible.has(row.teacherId)) {
      recordInvalidAssignment({
        assignmentType: "flight_path",
        assignmentId: row.id,
        resourceId: row.id,
        ownerUserId: row.teacherId,
        reason: "missing_active_teachable_membership",
      });
    }
  }

  const blockListRows = await dbInstance
    .select({ id: blockLists.id, teacherId: blockLists.teacherId })
    .from(blockLists)
    .where(eq(blockLists.schoolId, schoolId));
  for (const row of blockListRows) {
    if (!eligible.has(row.teacherId)) {
      recordInvalidAssignment({
        assignmentType: "block_list",
        assignmentId: row.id,
        resourceId: row.id,
        ownerUserId: row.teacherId,
        reason: "missing_active_teachable_membership",
      });
    }
  }

  const studentGroupRows = await dbInstance
    .select({ id: studentGroups.id, teacherId: studentGroups.teacherId })
    .from(studentGroups)
    .where(and(eq(studentGroups.schoolId, schoolId), sql`${studentGroups.teacherId} IS NOT NULL`));
  for (const row of studentGroupRows) {
    if (row.teacherId && !eligible.has(row.teacherId)) {
      recordInvalidAssignment({
        assignmentType: "student_group",
        assignmentId: row.id,
        resourceId: row.id,
        ownerUserId: row.teacherId,
        reason: "missing_active_teachable_membership",
      });
    }
  }

  if (
    schoolSettings?.centralRecipientUserId &&
    !activeStaff.has(schoolSettings.centralRecipientUserId)
  ) {
    recordInvalidAssignment({
      assignmentType: "central_email_recipient",
      assignmentId: schoolSettings.id,
      resourceId: schoolSettings.id,
      ownerUserId: schoolSettings.centralRecipientUserId,
      reason: "missing_active_staff_membership",
    });
  }
  stableSortByIdentity(invalidLiveAssignments);

  const invalidLiveBlockers: StaffAssignmentIntegrityIssues["invalidLiveBlockers"] = [];
  const activeTeachingRows = await dbInstance
    .select({
      id: teachingSessions.id,
      groupId: teachingSessions.groupId,
      teacherId: teachingSessions.teacherId,
      sessionSchoolId: teachingSessions.schoolId,
      parentGroupId: groups.id,
      groupSchoolId: groups.schoolId,
    })
    .from(teachingSessions)
    .leftJoin(groups, eq(groups.id, teachingSessions.groupId))
    .where(
      and(
        isNull(teachingSessions.endTime),
        or(
          eq(teachingSessions.schoolId, schoolId),
          eq(groups.schoolId, schoolId)
        )
      )
    );
  for (const row of activeTeachingRows) {
    const missingParent = row.parentGroupId === null || row.groupSchoolId === null;
    const schoolMismatch = !missingParent &&
      row.sessionSchoolId !== null &&
      row.sessionSchoolId !== row.groupSchoolId;
    if (missingParent || schoolMismatch) {
      invalidTenantScopes.push({
        resourceType: "active_teaching_session",
        resourceId: row.id,
        parentResourceId: row.groupId,
        storedSchoolId: row.sessionSchoolId,
        parentSchoolId: row.groupSchoolId,
        reason: missingParent ? "missing_parent" : "school_mismatch",
      });
    }
    if (
      !missingParent &&
      !schoolMismatch &&
      row.groupSchoolId === schoolId &&
      !eligible.has(row.teacherId)
    ) {
      invalidLiveBlockers.push({
        blockerType: "active_teaching_session",
        blockerId: row.id,
        resourceId: row.groupId,
        ownerUserId: row.teacherId,
        reason: "missing_active_teachable_membership",
      });
    }
  }
  const activeSessionStaffRows = await dbInstance
    .select({
      id: classpilotSessionStaff.id,
      sessionId: teachingSessions.id,
      groupId: teachingSessions.groupId,
      staffId: classpilotSessionStaff.staffId,
      staffSchoolId: classpilotSessionStaff.schoolId,
      sessionSchoolId: teachingSessions.schoolId,
      parentGroupId: groups.id,
      groupSchoolId: groups.schoolId,
    })
    .from(classpilotSessionStaff)
    .innerJoin(teachingSessions, eq(teachingSessions.id, classpilotSessionStaff.teachingSessionId))
    .leftJoin(groups, eq(groups.id, teachingSessions.groupId))
    .where(
      and(
        isNull(teachingSessions.endTime),
        or(
          eq(classpilotSessionStaff.schoolId, schoolId),
          eq(teachingSessions.schoolId, schoolId),
          eq(groups.schoolId, schoolId)
        )
      )
    );
  for (const row of activeSessionStaffRows) {
    const missingParent = row.parentGroupId === null || row.groupSchoolId === null;
    const schoolMismatch = !missingParent && (
      (row.sessionSchoolId !== null && row.sessionSchoolId !== row.groupSchoolId) ||
      row.staffSchoolId !== row.groupSchoolId
    );
    if (missingParent || schoolMismatch) {
      invalidTenantScopes.push({
        resourceType: "active_session_staff",
        resourceId: row.id,
        parentResourceId: row.sessionId,
        storedSchoolId: row.staffSchoolId,
        parentSchoolId: row.groupSchoolId,
        reason: missingParent ? "missing_parent" : "school_mismatch",
      });
    }
    if (
      !missingParent &&
      !schoolMismatch &&
      row.groupSchoolId === schoolId &&
      !eligible.has(row.staffId)
    ) {
      invalidLiveBlockers.push({
        blockerType: "active_teaching_session",
        blockerId: row.id,
        resourceId: row.groupId,
        ownerUserId: row.staffId,
        reason: "missing_active_teachable_membership",
      });
    }
  }
  const activeSupervisionRows = await dbInstance
    .select({ id: classpilotSupervisionContexts.id, staffId: classpilotSupervisionContexts.assignedStaffId })
    .from(classpilotSupervisionContexts)
    .where(
      and(
        eq(classpilotSupervisionContexts.schoolId, schoolId),
        eq(classpilotSupervisionContexts.status, "active"),
        isNull(classpilotSupervisionContexts.endedAt)
      )
    );
  for (const row of activeSupervisionRows) {
    if (!activeStaff.has(row.staffId)) {
      invalidLiveBlockers.push({
        blockerType: "active_supervision_context",
        blockerId: row.id,
        resourceId: row.id,
        ownerUserId: row.staffId,
        reason: "missing_active_staff_membership",
      });
    }
  }
  const activeKioskRows = await dbInstance
    .select({ id: passpilotKioskSessions.id, teacherId: passpilotKioskSessions.teacherId })
    .from(passpilotKioskSessions)
    .where(
      and(
        eq(passpilotKioskSessions.schoolId, schoolId),
        eq(passpilotKioskSessions.status, "active")
      )
    );
  for (const row of activeKioskRows) {
    if (row.teacherId && !activeStaff.has(row.teacherId)) {
      invalidLiveBlockers.push({
        blockerType: "active_kiosk_session",
        blockerId: row.id,
        resourceId: row.id,
        ownerUserId: row.teacherId,
        reason: "missing_active_staff_membership",
      });
    }
  }
  const activeScheduleChangeLegRows = await dbInstance
    .select({
      id: classpilotScheduleChangeLegs.id,
      groupId: classpilotScheduleChangeLegs.groupId,
      teacherId: classpilotScheduleChangeLegs.primaryTeacherIdSnapshot,
      legSchoolId: classpilotScheduleChangeLegs.schoolId,
      changeId: classpilotScheduleChanges.id,
      changeSchoolId: classpilotScheduleChanges.schoolId,
      parentGroupId: groups.id,
      groupSchoolId: groups.schoolId,
    })
    .from(classpilotScheduleChangeLegs)
    .innerJoin(
      classpilotScheduleChanges,
      eq(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.scheduleChangeId)
    )
    .leftJoin(groups, eq(groups.id, classpilotScheduleChangeLegs.groupId))
    .where(
      and(
        eq(classpilotScheduleChangeLegs.reservationActive, true),
        eq(classpilotScheduleChanges.reservationActive, true),
        inArray(classpilotScheduleChanges.status, [
          "pending_counterpart",
          "pending_admin",
          "approved",
        ]),
        or(
          eq(classpilotScheduleChangeLegs.schoolId, schoolId),
          eq(classpilotScheduleChanges.schoolId, schoolId),
          eq(groups.schoolId, schoolId)
        )
      )
    );
  for (const row of activeScheduleChangeLegRows) {
    const missingParent = row.parentGroupId === null || row.groupSchoolId === null;
    const schoolMismatch = !missingParent && (
      row.changeSchoolId !== row.legSchoolId ||
      row.groupSchoolId !== row.legSchoolId
    );
    if (missingParent || schoolMismatch) {
      invalidTenantScopes.push({
        resourceType: "active_schedule_change",
        resourceId: row.id,
        parentResourceId: row.changeId,
        storedSchoolId: row.legSchoolId,
        parentSchoolId: row.groupSchoolId,
        reason: missingParent ? "missing_parent" : "school_mismatch",
      });
    }
    if (
      !missingParent &&
      !schoolMismatch &&
      row.legSchoolId === schoolId &&
      !eligible.has(row.teacherId)
    ) {
      invalidLiveBlockers.push({
        blockerType: "active_schedule_change",
        blockerId: row.id,
        resourceId: row.groupId,
        ownerUserId: row.teacherId,
        reason: "missing_active_teachable_membership",
      });
    }
  }
  const activeConflictRows = await dbInstance
    .select({
      id: classpilotScheduledConflicts.id,
      groupId: classpilotScheduledConflicts.groupId,
      teacherId: classpilotScheduledConflicts.teacherId,
      conflictSchoolId: classpilotScheduledConflicts.schoolId,
      parentGroupId: groups.id,
      groupSchoolId: groups.schoolId,
    })
    .from(classpilotScheduledConflicts)
    .leftJoin(groups, eq(groups.id, classpilotScheduledConflicts.groupId))
    .where(
      and(
        inArray(classpilotScheduledConflicts.status, ["coverage_needed", "claimed", "pending"]),
        or(
          eq(classpilotScheduledConflicts.schoolId, schoolId),
          eq(groups.schoolId, schoolId)
        )
      )
    );
  for (const row of activeConflictRows) {
    const missingParent = row.parentGroupId === null || row.groupSchoolId === null;
    const schoolMismatch = !missingParent && row.conflictSchoolId !== row.groupSchoolId;
    if (missingParent || schoolMismatch) {
      invalidTenantScopes.push({
        resourceType: "active_scheduled_conflict",
        resourceId: row.id,
        parentResourceId: row.groupId,
        storedSchoolId: row.conflictSchoolId,
        parentSchoolId: row.groupSchoolId,
        reason: missingParent ? "missing_parent" : "school_mismatch",
      });
    }
    if (
      !missingParent &&
      !schoolMismatch &&
      row.conflictSchoolId === schoolId &&
      !eligible.has(row.teacherId)
    ) {
      invalidLiveBlockers.push({
        blockerType: "active_scheduled_conflict",
        blockerId: row.id,
        resourceId: row.groupId,
        ownerUserId: row.teacherId,
        reason: "missing_active_teachable_membership",
      });
    }
  }
  invalidLiveBlockers.sort((left, right) =>
    `${left.blockerType}\u0000${left.blockerId}\u0000${left.ownerUserId}`.localeCompare(
      `${right.blockerType}\u0000${right.blockerId}\u0000${right.ownerUserId}`
    )
  );
  invalidClassRelationships.sort((left, right) =>
    left.relationshipId.localeCompare(right.relationshipId)
  );
  invalidHomeroomRelationships.sort((left, right) =>
    left.relationshipId.localeCompare(right.relationshipId)
  );
  invalidTenantScopes.sort((left, right) =>
    `${left.resourceType}\u0000${left.resourceId}`.localeCompare(
      `${right.resourceType}\u0000${right.resourceId}`
    )
  );

  const invalidAssignmentCountsByType: StaffAssignmentIntegrityIssues["invalidAssignmentCountsByType"] = {};
  for (const assignment of invalidLiveAssignments) {
    invalidAssignmentCountsByType[assignment.assignmentType] =
      (invalidAssignmentCountsByType[assignment.assignmentType] ?? 0) + 1;
  }
  invalidAssignmentCountsByType.class_primary = invalidPrimaryAssignments.length;
  invalidAssignmentCountsByType.class_co_teacher = invalidCoTeacherAssignments.length;
  const invalidBlockerCountsByType: StaffAssignmentIntegrityIssues["invalidBlockerCountsByType"] = {};
  for (const blocker of invalidLiveBlockers) {
    invalidBlockerCountsByType[blocker.blockerType] =
      (invalidBlockerCountsByType[blocker.blockerType] ?? 0) + 1;
  }
  const counts = {
    invalidPrimaryAssignments: invalidPrimaryAssignments.length,
    invalidCoTeacherAssignments: invalidCoTeacherAssignments.length,
    invalidClassRelationships: invalidClassRelationships.length,
    primaryMirrorMismatches: primaryMirrorMismatches.length,
    invalidLiveAssignments: invalidLiveAssignments.length,
    invalidLiveBlockers: invalidLiveBlockers.length,
    homeroomPrimaryMirrorMismatches: homeroomPrimaryMirrorMismatches.length,
    invalidHomeroomRelationships: invalidHomeroomRelationships.length,
    invalidTenantScopes: invalidTenantScopes.length,
  };
  // Relationship ownership is also retained in invalidLiveAssignments for
  // compatibility. Only add the relationship category to total when it has a
  // shape or tenant-parent error, so a plain stale owner is not double-counted.
  const supplementalHomeroomRelationshipCount = invalidHomeroomRelationships.filter(
    (relationship) => relationship.reasons.some(
      (reason) => reason !== "missing_active_gopilot_teacher_membership"
    )
  ).length;
  return {
    invalidPrimaryAssignments,
    invalidCoTeacherAssignments,
    invalidClassRelationships,
    primaryMirrorMismatches,
    invalidLiveAssignments,
    invalidLiveBlockers,
    homeroomPrimaryMirrorMismatches,
    invalidHomeroomRelationships,
    invalidTenantScopes,
    invalidAssignmentCountsByType,
    invalidBlockerCountsByType,
    counts,
    total:
      counts.invalidPrimaryAssignments +
      counts.invalidClassRelationships +
      counts.primaryMirrorMismatches +
      counts.invalidLiveAssignments +
      counts.invalidLiveBlockers +
      counts.homeroomPrimaryMirrorMismatches +
      supplementalHomeroomRelationshipCount +
      counts.invalidTenantScopes,
  };
}

export async function findTransitionMembershipForUser(options: {
  schoolId: string;
  userId: string;
  allowInactive: boolean;
  dbInstance?: LifecycleDb;
}): Promise<typeof schoolMemberships.$inferSelect> {
  const dbInstance = options.dbInstance ?? (db as unknown as LifecycleDb);
  const memberships = await dbInstance
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.schoolId, options.schoolId),
        eq(schoolMemberships.userId, options.userId),
        inArray(schoolMemberships.role, [...TEACHABLE_STAFF_ROLES])
      )
    )
    .orderBy(asc(schoolMemberships.id));
  const candidates = memberships.filter(
    (membership) => membership.status === "active" || options.allowInactive
  );
  const active = candidates.filter((membership) => membership.status === "active");
  const selected = active.length === 1
    ? active[0]
    : active.length === 0 && candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!selected) {
    throw lifecycleError(
      409,
      "STAFF_SOURCE_MEMBERSHIP_AMBIGUOUS",
      "The source identity must have exactly one applicable teaching membership."
    );
  }
  return selected;
}
