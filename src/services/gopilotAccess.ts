import type { Request, RequestHandler, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import db from "../db.js";
import {
  productLicenses,
  schoolMemberships,
  type SchoolMembership,
  type User,
} from "../schema/core.js";
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

export function effectiveGoPilotRole(
  membership: Pick<SchoolMembership, "role" | "gopilotRole">
): GoPilotRole {
  return (membership.gopilotRole || membership.role) as GoPilotRole;
}

export function isGoPilotManager(role: GoPilotRole | null | undefined): boolean {
  return role === "super_admin" || role === "admin" || role === "school_admin" || role === "office_staff";
}

export function isGoPilotStaff(role: GoPilotRole | null | undefined): boolean {
  return isGoPilotManager(role) || role === "teacher";
}

export async function hasActiveGoPilotLicense(schoolId: string): Promise<boolean> {
  const [license] = await db
    .select({ id: productLicenses.id })
    .from(productLicenses)
    .where(
      and(
        eq(productLicenses.schoolId, schoolId),
        eq(productLicenses.product, "GOPILOT"),
        eq(productLicenses.status, "active")
      )
    )
    .limit(1);
  return !!license;
}

export async function getGoPilotMembership(
  userId: string,
  schoolId: string
): Promise<SchoolMembership | undefined> {
  const [membership] = await db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active")
      )
    )
    .limit(1);
  return membership;
}

export async function getRequestGoPilotRole(
  req: Request,
  res: Response
): Promise<GoPilotRole | null> {
  if (req.authUser?.isSuperAdmin) {
    res.locals.gopilotRole = "super_admin";
    return "super_admin";
  }

  if (res.locals.gopilotRole) {
    return res.locals.gopilotRole as GoPilotRole;
  }

  const schoolId = res.locals.schoolId as string | undefined;
  const userId = req.authUser?.id;
  if (!schoolId || !userId) return null;

  const membership = await getGoPilotMembership(userId, schoolId);
  if (!membership) return null;

  const role = effectiveGoPilotRole(membership);
  res.locals.gopilotRole = role;
  return role;
}

export function requireGoPilotRole(...roles: GoPilotRole[]): RequestHandler {
  return async (req, res, next) => {
    const role = await getRequestGoPilotRole(req, res);
    if (!role) {
      return res.status(403).json({ error: "No access to this school" });
    }
    if (role === "super_admin") {
      return next();
    }
    if (!roles.includes(role)) {
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
    .where(
      and(
        eq(dismissalQueue.id, queueId),
        eq(dismissalSessions.schoolId, schoolId)
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
