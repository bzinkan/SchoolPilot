import type { Request, RequestHandler, Response } from "express";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import db from "../db.js";
import {
  schoolMemberships,
  type SchoolMembership,
  type User,
} from "../schema/core.js";
import { resolveGopilotEntitlement } from "./gopilotEntitlement.js";
import {
  authorizedPickups,
  busRoutes,
  dismissalChanges,
  dismissalQueue,
  dismissalSessions,
  familyGroups,
  homerooms,
  homeroomTeachers,
  parentStudent,
} from "../schema/gopilot.js";
import { students } from "../schema/students.js";

export type GoPilotRole =
  | "super_admin"
  | "admin"
  | "school_admin"
  | "office_staff"
  | "teacher"
  | "parent";

export type GoPilotCapabilities = {
  manageDismissal: boolean;
  approveChangeRequests: boolean;
  acknowledgeChangeRequests: boolean;
  schoolWideAttendance: boolean;
  teacherAttendance: boolean;
  parentStudentAccess: boolean;
  manageSetup: boolean;
};

export type GoPilotIdentity = {
  primaryRole: GoPilotRole;
  roles: GoPilotRole[];
  capabilities: GoPilotCapabilities;
  memberships: SchoolMembership[];
};

const GOPILOT_ROLE_PRIORITY: readonly GoPilotRole[] = [
  "super_admin",
  "admin",
  "school_admin",
  "office_staff",
  "teacher",
  "parent",
];

export function effectiveGoPilotRole(
  membership: Pick<SchoolMembership, "role" | "gopilotRole">
): GoPilotRole {
  return (membership.gopilotRole?.trim() || membership.role) as GoPilotRole;
}

export function isGoPilotManager(role: GoPilotRole | null | undefined): boolean {
  return role === "super_admin" || role === "admin" || role === "school_admin" || role === "office_staff";
}

export function isGoPilotStaff(role: GoPilotRole | null | undefined): boolean {
  return isGoPilotManager(role) || role === "teacher";
}

function roleFromMembership(membership: Pick<SchoolMembership, "role" | "gopilotRole">): GoPilotRole[] {
  const role = effectiveGoPilotRole(membership);
  return ["admin", "school_admin", "office_staff", "teacher", "parent"].includes(role)
    ? [role]
    : [];
}

function primaryRoleFromRoles(roles: GoPilotRole[]): GoPilotRole {
  return GOPILOT_ROLE_PRIORITY.find((role) => roles.includes(role)) ?? "parent";
}

export function goPilotRolesFromMemberships(
  memberships: readonly Pick<SchoolMembership, "role" | "gopilotRole">[]
): GoPilotRole[] {
  return [...new Set(memberships.flatMap(roleFromMembership))]
    .sort(
      (left, right) =>
        GOPILOT_ROLE_PRIORITY.indexOf(left) - GOPILOT_ROLE_PRIORITY.indexOf(right)
    );
}

export function goPilotIdentityHasAnyRole(
  identity: { roles: readonly GoPilotRole[] },
  roles: readonly GoPilotRole[]
): boolean {
  return roles.some((role) => identity.roles.includes(role));
}

export function capabilitiesForGoPilotRoles(
  roles: readonly GoPilotRole[]
): GoPilotCapabilities {
  const manager = roles.some(isGoPilotManager);
  return {
    manageDismissal: manager,
    approveChangeRequests: manager,
    acknowledgeChangeRequests: manager || roles.includes("teacher"),
    schoolWideAttendance: manager,
    teacherAttendance: roles.includes("teacher"),
    parentStudentAccess: roles.includes("parent"),
    manageSetup: roles.some((role) =>
      role === "super_admin" || role === "admin" || role === "school_admin"
    ),
  };
}

export async function resolveGoPilotIdentity(
  userId: string,
  schoolId: string
): Promise<GoPilotIdentity | null> {
  const memberships = await db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active")
      )
    );

  if (memberships.length === 0) return null;

  const roles = goPilotRolesFromMemberships(memberships);
  if (roles.length === 0) return null;

  const primaryRole = primaryRoleFromRoles(roles);
  return {
    primaryRole,
    roles,
    capabilities: capabilitiesForGoPilotRoles(roles),
    memberships,
  };
}

export async function hasActiveGoPilotLicense(schoolId: string): Promise<boolean> {
  return (await resolveGopilotEntitlement(schoolId)).entitled;
}

export async function hasAnyActiveGoPilotStaffMembership(userId: string): Promise<boolean> {
  const staffRoles = ["admin", "school_admin", "office_staff", "teacher"];
  const [membership] = await db
    .select({ id: schoolMemberships.id })
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.status, "active"),
        or(
          sql`btrim(${schoolMemberships.gopilotRole}) IN ('admin', 'school_admin', 'office_staff', 'teacher')`,
          and(
            or(
              isNull(schoolMemberships.gopilotRole),
              sql`btrim(${schoolMemberships.gopilotRole}) = ''`
            ),
            inArray(schoolMemberships.role, staffRoles)
          )
        )
      )
    )
    .limit(1);
  return Boolean(membership);
}

export async function getGoPilotMembership(
  userId: string,
  schoolId: string
): Promise<SchoolMembership | undefined> {
  const identity = await resolveGoPilotIdentity(userId, schoolId);
  return identity?.memberships.find((membership) =>
    roleFromMembership(membership).includes(identity.primaryRole)
  ) ?? identity?.memberships[0];
}

export async function getRequestGoPilotIdentity(
  req: Request,
  res: Response
): Promise<GoPilotIdentity | null> {
  if (req.authUser?.isSuperAdmin) {
    const identity: GoPilotIdentity = {
      primaryRole: "super_admin",
      roles: ["super_admin"],
      capabilities: capabilitiesForGoPilotRoles(["super_admin"]),
      memberships: [],
    };
    res.locals.gopilotRole = identity.primaryRole;
    res.locals.gopilotIdentity = identity;
    return identity;
  }

  const cached = res.locals.gopilotIdentity as GoPilotIdentity | undefined;
  if (cached) {
    return cached;
  }

  const schoolId = res.locals.schoolId as string | undefined;
  const userId = req.authUser?.id;
  if (!schoolId || !userId) return null;

  const identity = await resolveGoPilotIdentity(userId, schoolId);
  if (!identity) return null;

  res.locals.gopilotIdentity = identity;
  res.locals.gopilotRole = identity.primaryRole;
  return identity;
}

export async function getRequestGoPilotRole(
  req: Request,
  res: Response
): Promise<GoPilotRole | null> {
  return (await getRequestGoPilotIdentity(req, res))?.primaryRole ?? null;
}

export function requireGoPilotRole(...roles: GoPilotRole[]): RequestHandler {
  return async (req, res, next) => {
    const identity = await getRequestGoPilotIdentity(req, res);
    if (!identity) {
      return res.status(403).json({ error: "No access to this school" });
    }
    if (identity.roles.includes("super_admin")) {
      return next();
    }
    if (!goPilotIdentityHasAnyRole(identity, roles)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  };
}

export async function getSessionForSchool(sessionId: string, schoolId: string) {
  const [session] = await db
    .select()
    .from(dismissalSessions)
    .where(
      and(
        eq(dismissalSessions.id, sessionId),
        eq(dismissalSessions.schoolId, schoolId)
      )
    )
    .limit(1);
  return session;
}

export async function getQueueEntryForSchool(queueId: string, schoolId: string) {
  const [row] = await db
    .select({ entry: dismissalQueue })
    .from(dismissalQueue)
    .innerJoin(dismissalSessions, eq(dismissalQueue.sessionId, dismissalSessions.id))
    .innerJoin(
      students,
      and(
        eq(students.id, dismissalQueue.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(dismissalQueue.id, queueId),
        eq(dismissalSessions.schoolId, schoolId),
        eq(dismissalQueue.schoolId, schoolId)
      )
    )
    .limit(1);
  return row?.entry;
}

export async function getHomeroomForSchool(homeroomId: string, schoolId: string) {
  const [homeroom] = await db
    .select()
    .from(homerooms)
    .where(and(eq(homerooms.id, homeroomId), eq(homerooms.schoolId, schoolId)))
    .limit(1);
  return homeroom;
}

export async function getBusRouteForSchool(routeId: string, schoolId: string) {
  const [route] = await db
    .select()
    .from(busRoutes)
    .where(and(eq(busRoutes.id, routeId), eq(busRoutes.schoolId, schoolId)))
    .limit(1);
  return route;
}

export async function getFamilyGroupForSchool(groupId: string, schoolId: string) {
  const [group] = await db
    .select()
    .from(familyGroups)
    .where(and(eq(familyGroups.id, groupId), eq(familyGroups.schoolId, schoolId)))
    .limit(1);
  return group;
}

export async function getPickupForSchool(pickupId: string, schoolId: string) {
  const [row] = await db
    .select({ pickup: authorizedPickups })
    .from(authorizedPickups)
    .innerJoin(students, eq(authorizedPickups.studentId, students.id))
    .where(
      and(
        eq(authorizedPickups.id, pickupId),
        eq(students.schoolId, schoolId)
      )
    )
    .limit(1);
  return row?.pickup;
}

export async function getDismissalChangeForSchool(changeId: string, schoolId: string) {
  const [row] = await db
    .select({ change: dismissalChanges })
    .from(dismissalChanges)
    .innerJoin(dismissalSessions, eq(dismissalChanges.sessionId, dismissalSessions.id))
    .where(
      and(
        eq(dismissalChanges.id, changeId),
        eq(dismissalSessions.schoolId, schoolId)
      )
    )
    .limit(1);
  return row?.change;
}

export async function getApprovedParentStudentIds(
  parentId: string,
  schoolId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ studentId: parentStudent.studentId })
    .from(parentStudent)
    .innerJoin(students, eq(parentStudent.studentId, students.id))
    .where(
      and(
        eq(parentStudent.parentId, parentId),
        eq(parentStudent.status, "approved"),
        eq(students.schoolId, schoolId)
      )
    );
  return new Set(rows.map((row) => row.studentId));
}

export async function getTeacherHomeroomIds(
  teacherId: string,
  schoolId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ homeroomId: homerooms.id })
    .from(homeroomTeachers)
    .innerJoin(homerooms, eq(homeroomTeachers.homeroomId, homerooms.id))
    .where(
      and(
        eq(homeroomTeachers.teacherId, teacherId),
        eq(homerooms.schoolId, schoolId)
      )
    );
  return new Set(rows.map((row) => row.homeroomId));
}

export async function canAccessStudent(
  user: User,
  schoolId: string,
  studentId: string,
  role: GoPilotRole | null
): Promise<boolean> {
  const [student] = await db
    .select({ id: students.id, homeroomId: students.homeroomId })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .limit(1);
  if (!student) return false;

  if (isGoPilotManager(role)) return true;

  if (role === "parent") {
    const allowed = await getApprovedParentStudentIds(user.id, schoolId);
    return allowed.has(studentId);
  }

  if (role === "teacher" && student.homeroomId) {
    const homeroomsForTeacher = await getTeacherHomeroomIds(user.id, schoolId);
    return homeroomsForTeacher.has(student.homeroomId);
  }

  return false;
}

export async function allStudentsBelongToSchool(
  studentIds: string[],
  schoolId: string
): Promise<boolean> {
  if (studentIds.length === 0) return true;
  const rows = await db
    .select({ id: students.id })
    .from(students)
    .where(and(inArray(students.id, studentIds), eq(students.schoolId, schoolId)));
  return rows.length === new Set(studentIds).size;
}
