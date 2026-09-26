import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { schoolMemberships, users } from "../schema/core.js";
import { students } from "../schema/students.js";
import { groups, groupStudents, groupTeachers } from "../schema/classpilot.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import type { MyDeskDatabase } from "./mydesk.js";

export type SharedStudentActor = { schoolId: string; authorId: string };
export type SharedStudentIdentity = SharedStudentActor & { manager: boolean; name: string };
export const sharedStudentError = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code: `STUDENT_RECORD_${code}`, expose: true });

/** No platform privilege is consulted. HTTP callers also reject impersonation. */
export async function assertSharedStudentActor(actor: SharedStudentActor, tx: MyDeskDatabase): Promise<SharedStudentIdentity> {
  await assertClasspilotEntitled(actor.schoolId, tx, { lock: true });
  const memberships = await tx.select({ role: schoolMemberships.role }).from(schoolMemberships).where(and(
    eq(schoolMemberships.schoolId, actor.schoolId), eq(schoolMemberships.userId, actor.authorId),
    eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"]))).for("share");
  if (!memberships.length) throw sharedStudentError(403, "MEMBERSHIP_REQUIRED", "Your own active school staff membership is required");
  const [user] = await tx.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, actor.authorId)).for("share");
  if (!user) throw sharedStudentError(403, "MEMBERSHIP_REQUIRED", "Your own active school staff membership is required");
  return { ...actor, manager: memberships.some(row => row.role === "admin" || row.role === "school_admin"),
    name: `${user.firstName || ""} ${user.lastName || ""}`.trim().slice(0, 500) || "School staff" };
}

/** Self-created groups must never turn school-wide records into self-service access. */
export function sharedStudentIdWhere(identity: SharedStudentIdentity, studentId: SQLWrapper, options: { includeInactive?: boolean } = {}): SQL {
  return sql`EXISTS (SELECT 1 FROM students shared_student WHERE shared_student.id=${studentId}
    AND shared_student.school_id=${identity.schoolId}
    ${identity.manager && options.includeInactive ? sql`` : sql`AND shared_student.status='active'`}
    ${identity.manager ? sql`` : sql`AND EXISTS (
      SELECT 1 FROM group_students shared_member JOIN groups shared_class ON shared_class.id=shared_member.group_id
      WHERE shared_member.student_id=shared_student.id AND shared_class.school_id=${identity.schoolId}
        AND shared_class.status='active' AND shared_class.group_type='admin_class'
        AND (shared_class.teacher_id=${identity.authorId} OR EXISTS (SELECT 1 FROM group_teachers shared_teacher
          WHERE shared_teacher.group_id=shared_class.id AND shared_teacher.teacher_id=${identity.authorId} AND shared_teacher.role IN ('primary','co-teacher'))))`})`;
}
export const sharedStudentWhere = (identity: SharedStudentIdentity, options: { includeInactive?: boolean } = {}) =>
  and(eq(students.schoolId, identity.schoolId), sharedStudentIdWhere(identity, students.id, options))!;

export async function assertSharedStudentAccess(tx: MyDeskDatabase, identity: SharedStudentIdentity, studentId: string,
  options: { lock?: boolean; allowInactiveForAdmin?: boolean } = {}) {
  if (options.lock) {
    // Official roster writers serialize through the school lifecycle lock. Row
    // locks additionally protect direct deactivation and assignment deletion.
    const assigned = await tx.select({ id: groups.id }).from(groups).innerJoin(groupStudents, eq(groupStudents.groupId, groups.id))
      .where(and(eq(groups.schoolId, identity.schoolId), eq(groups.groupType, "admin_class"), eq(groups.status, "active"),
        eq(groupStudents.studentId, studentId))).orderBy(groups.id).for("share");
    for (const row of assigned) await tx.select({ id: groupTeachers.id }).from(groupTeachers).where(eq(groupTeachers.groupId, row.id)).for("share");
  }
  const query = tx.select({ id: students.id, firstName: students.firstName, lastName: students.lastName,
    gradeLevel: students.gradeLevel, status: students.status }).from(students).where(and(eq(students.id, studentId),
    sharedStudentWhere(identity, { includeInactive: options.allowInactiveForAdmin }))).limit(1);
  const [student] = await (options.lock ? query.for("share") : query);
  if (!student) throw sharedStudentError(404, "NOT_FOUND", "Student record not found");
  return { ...student, name: `${student.firstName} ${student.lastName}`.trim().slice(0, 500) };
}

export function withSharedStudentRecords<T>(actor: SharedStudentActor,
  operation: (tx: MyDeskDatabase, identity: SharedStudentIdentity) => Promise<T>, options: { consistent?: boolean; lifecycle?: boolean } = {}): Promise<T> {
  return runWithTenantContext({ schoolId: actor.schoolId }, () => db.transaction(async tx => {
    if (options.lifecycle && !await lockStaffAssignmentLifecycleSchool(tx, actor.schoolId)) throw sharedStudentError(403, "SCHOOL_UNAVAILABLE", "School access is unavailable");
    return operation(tx, await assertSharedStudentActor(actor, tx));
  }, options.consistent ? { isolationLevel: "repeatable read" } : undefined));
}
