import { and, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import { schoolMemberships } from "../schema/core.js";
import { classpilotSessionStaff, classpilotSessionStudents, classpilotStudentControlStates, classpilotSupervisionContexts, classpilotSupervisionStudents, teachingSessions } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { auditLogs } from "../schema/shared.js";
import { classpilotToolHistory } from "../schema/classpilotTools.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { requireScheduledClassroomContext, type ClasspilotActivityAuthority } from "./classpilotActivityAuthority.js";
import { withScheduledStudentAction, type ScheduledStudentAction } from "./classpilotScheduledClassroomTools.js";
import { withAuthorizedStudentFabMutation, lockClasspilotStudentControlAuthorities, hasCurrentClasspilotStudentControlAuthority } from "./storage.js";

export type ToolsScope = { schoolId: string; actorId: string; authority: ClasspilotActivityAuthority; contextAuthorityRevision?: string };
export type ToolsParent = { schoolId: string; teachingSessionId: string | null; supervisionContextId: string | null };
export const toolsError = (message: string, code = "CLASS_TOOLS_CONFLICT", status = 409) => Object.assign(new Error(message), { status, code, expose: true });
export const toolsParent = (scope: Pick<ToolsScope, "schoolId" | "authority">): ToolsParent => ({ schoolId: scope.schoolId, teachingSessionId: scope.authority.teachingSessionId ?? null, supervisionContextId: scope.authority.supervisionContextId ?? null });
export function toolsWhere(table: { schoolId: any; teachingSessionId: any; supervisionContextId: any }, scope: Pick<ToolsScope, "schoolId" | "authority">): SQL {
  return and(eq(table.schoolId, scope.schoolId), scope.authority.teachingSessionId ? eq(table.teachingSessionId, scope.authority.teachingSessionId) : eq(table.supervisionContextId, scope.authority.supervisionContextId!))!;
}

/** Parent lock linearizes revisions, active-resource uniqueness and context end. */
export async function withToolsStaff<T>(scope: ToolsScope, mutate: (database: typeof db, expiresAt: Date) => Promise<T>, historical = false, readOnly = false): Promise<T> {
  return db.transaction(async tx => {
    const database = tx as unknown as typeof db;
    await assertClasspilotEntitled(scope.schoolId, database, { lock: true });
    const [membership] = await database.select({ id: schoolMemberships.id }).from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, scope.schoolId),
      eq(schoolMemberships.userId, scope.actorId), eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, ["teacher", "admin", "school_admin", "office_staff"]))).limit(1).for("share");
    if (!membership) throw toolsError("Staff access is no longer active", "CLASS_TOOLS_FORBIDDEN", 403);
    if (!readOnly) {
      // Match the canonical control-before-parent order. A student submission
      // already holds its control lock before checking the classroom parent.
      const members = scope.authority.teachingSessionId
        ? await database.select({ studentId: classpilotSessionStudents.studentId }).from(classpilotSessionStudents).where(and(eq(classpilotSessionStudents.schoolId, scope.schoolId), eq(classpilotSessionStudents.teachingSessionId, scope.authority.teachingSessionId)))
        : await database.select({ studentId: classpilotSupervisionStudents.studentId }).from(classpilotSupervisionStudents).where(and(eq(classpilotSupervisionStudents.schoolId, scope.schoolId), eq(classpilotSupervisionStudents.contextId, scope.authority.supervisionContextId!)));
      await lockClasspilotStudentControlAuthorities(scope.schoolId, members.map(row => row.studentId), database);
    }
    let expiresAt: Date;
    if (scope.authority.teachingSessionId) {
      const [session] = await database.select().from(teachingSessions).where(and(eq(teachingSessions.schoolId, scope.schoolId), eq(teachingSessions.id, scope.authority.teachingSessionId))).limit(1).for(readOnly ? "share" : "update");
      const [staff] = await database.select({ id: classpilotSessionStaff.id }).from(classpilotSessionStaff).where(and(eq(classpilotSessionStaff.schoolId, scope.schoolId),
        eq(classpilotSessionStaff.teachingSessionId, scope.authority.teachingSessionId), eq(classpilotSessionStaff.staffId, scope.actorId))).limit(1).for("share");
      if (!session || !staff || (!historical && (session.endTime || session.sessionMode !== "live" || (session.scheduledEndAt && session.scheduledEndAt <= new Date())))) throw toolsError("Classroom is no longer available", "CLASS_TOOLS_AUTHORITY_STALE", 404);
      expiresAt = session.endTime || session.scheduledEndAt || new Date(session.startTime.getTime() + 12 * 3600_000);
    } else {
      const [context] = await database.select().from(classpilotSupervisionContexts).where(and(eq(classpilotSupervisionContexts.schoolId, scope.schoolId), eq(classpilotSupervisionContexts.id, scope.authority.supervisionContextId!))).limit(1).for(readOnly ? "share" : "update");
      if (!context || context.assignedStaffId !== scope.actorId || String(context.classroomAuthorityRevision) !== scope.contextAuthorityRevision) throw toolsError("Classroom authority changed", "CLASS_TOOLS_AUTHORITY_STALE", 404);
      if (!historical) await requireScheduledClassroomContext({ schoolId: scope.schoolId, supervisionContextId: context.id, actorId: scope.actorId, contextAuthorityRevision: scope.contextAuthorityRevision }, database);
      expiresAt = context.endsAt;
    }
    if (!historical && expiresAt <= new Date()) throw toolsError("Classroom has ended", "CLASS_TOOLS_AUTHORITY_STALE", 409);
    return mutate(database, expiresAt);
  });
}

export async function toolsRoster(scope: ToolsScope, database: typeof db = db) {
  const parentTable = scope.authority.teachingSessionId ? classpilotSessionStudents : classpilotSupervisionStudents;
  const parentCondition = scope.authority.teachingSessionId
    ? eq(classpilotSessionStudents.teachingSessionId, scope.authority.teachingSessionId)
    : and(eq(classpilotSupervisionStudents.contextId, scope.authority.supervisionContextId!), isNull(classpilotSupervisionStudents.releasedAt));
  return database.select({ studentId: students.id, firstName: students.firstName, lastName: students.lastName }).from(parentTable)
    .innerJoin(students, and(eq(students.id, parentTable.studentId), eq(students.schoolId, scope.schoolId), eq(students.status, "active")))
    .innerJoin(classpilotStudentControlStates, and(eq(classpilotStudentControlStates.schoolId, scope.schoolId), eq(classpilotStudentControlStates.studentId, students.id),
      scope.authority.teachingSessionId ? eq(classpilotStudentControlStates.teachingSessionId, scope.authority.teachingSessionId) : eq(classpilotStudentControlStates.supervisionContextId, scope.authority.supervisionContextId!),
      gt(classpilotStudentControlStates.hardExpiresAt, new Date())))
    .where(and(eq(parentTable.schoolId, scope.schoolId), parentCondition)).orderBy(students.id).limit(501);
}
export async function requireToolsStudent(scope: ToolsScope, studentId: string, database: typeof db) {
  await lockClasspilotStudentControlAuthorities(scope.schoolId, [studentId], database);
  if (!await hasCurrentClasspilotStudentControlAuthority({ schoolId: scope.schoolId, studentId, ...scope.authority }, database)) throw toolsError("Student classroom authority changed", "CLASS_TOOLS_STUDENT_MOVED");
}
export type ToolsStudentScope = Omit<ToolsScope, "actorId"> & { studentId: string; studentSessionId: string; deviceId: string; studentControlRevision?: number };
export async function withToolsStudent<T>(scope: ToolsStudentScope, feature: "hand-raise" | "hand-lower" | "engagement", mutate: (database: typeof db, expiresAt: Date) => Promise<T>): Promise<T> {
  if (scope.authority.supervisionContextId) return withScheduledStudentAction({ ...scope, supervisionContextId: scope.authority.supervisionContextId, studentControlRevision: scope.studentControlRevision } as ScheduledStudentAction, (database, context) => mutate(database, context.endsAt));
  return withAuthorizedStudentFabMutation({ ...scope, feature }, async (database, authority) => {
    if (authority.teachingSession.id !== scope.authority.teachingSessionId) throw toolsError("Student classroom changed", "CLASS_TOOLS_AUTHORITY_STALE");
    const expiry = authority.teachingSession.scheduledEndAt || new Date(authority.teachingSession.startTime.getTime() + 12 * 3600_000);
    if (expiry <= new Date()) throw toolsError("Classroom has ended", "CLASS_TOOLS_AUTHORITY_STALE");
    return mutate(database, expiry);
  });
}
/** IDs only in audit; authored text remains in scoped records and safety review. */
export async function recordToolsHistory(database: typeof db, scope: ToolsScope, kind: string, resourceId: string, detail: Record<string, unknown> = {}) {
  await database.insert(classpilotToolHistory).values({ ...toolsParent(scope), actorId: scope.actorId, kind, resourceId, detail });
  await database.insert(auditLogs).values({ schoolId: scope.schoolId, userId: scope.actorId, action: `classpilot.tools.${kind}`, entityType: "class_tools", entityId: resourceId,
    metadata: { ...scope.authority } });
  const parent = toolsParent(scope);
  await database.execute(sql`INSERT INTO session_settings(school_id,session_id,supervision_context_id) VALUES(${parent.schoolId},${parent.teachingSessionId},${parent.supervisionContextId}) ON CONFLICT DO NOTHING`);
  await database.execute(sql`UPDATE session_settings SET tools_revision=tools_revision+1 WHERE school_id=${parent.schoolId} AND session_id IS NOT DISTINCT FROM ${parent.teachingSessionId} AND supervision_context_id IS NOT DISTINCT FROM ${parent.supervisionContextId}`);
}
