import { and, eq } from "drizzle-orm";
import type { db } from "../db.js";
import { classpilotCommands, classpilotCommandTargets, classpilotStudentControlStates,
  type ClasspilotCommand, type ClasspilotCommandTarget, type ClasspilotStudentControlState,
  type InsertClasspilotCommand, type InsertClasspilotCommandTarget, type FlightPath } from "../schema/classpilot.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Order-independent exact policy/source identity, after canonical URL normalization. */
export function reviewedClassroomSourceKey(path: Pick<FlightPath,
  "sourceCourseId" | "sourceResourceIds" | "allowedDomains" | "resources" | "blockedDomains">): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)])) : value;
  return JSON.stringify({ course: path.sourceCourseId, sourceIds: [...new Set(path.sourceResourceIds || [])].sort(),
    domains: [...new Set(path.allowedDomains || [])].sort(),
    resources: (path.resources || []).map(value => JSON.stringify(stable(value))).sort(),
    blocks: [...new Set(path.blockedDomains || [])].sort() });
}

/** Both the public Date and a PostgreSQL timestamp are compared at JS precision. */
export function flightPathReviewedInstantMatches(updatedAt: Date, expected: string): boolean {
  return updatedAt instanceof Date && Number.isFinite(updatedAt.getTime()) && updatedAt.getTime() === Date.parse(expected);
}

export function restrictionPrerequisiteMatches(options: {
  request: Pick<ClasspilotCommand, "schoolId" | "teacherId" | "teachingSessionId" | "supervisionContextId">;
  target: Pick<ClasspilotCommandTarget, "studentId" | "studentSessionId" | "deviceId" | "status">;
  source?: Pick<ClasspilotCommand, "id" | "schoolId" | "teacherId" | "teachingSessionId" | "supervisionContextId" | "commandType">;
  sourceTarget?: Pick<ClasspilotCommandTarget, "schoolId" | "commandId" | "studentId" | "studentSessionId" | "deviceId" | "status" | "result">;
  current?: Pick<ClasspilotStudentControlState, "schoolId" | "studentId" | "teachingSessionId" | "supervisionContextId" | "revision" |
    "sourceCommandId" | "appliedRevision" | "lastOutcome" | "enforcementHealth" | "hardExpiresAt" | "scheduledEndAt">;
  contextAuthorityRevision?: string; now?: Date;
}): boolean {
  const { request, target, source, sourceTarget, current } = options;
  const result = record(sourceTarget?.result);
  // Canonical state ACK reconciliation may complete the source before its
  // command ACK arrives; that trusted record names classroomStateRevision.
  const revision = result.classroomStateRevision ?? result.appliedRevision;
  const now = options.now || new Date();
  return !!source && !!sourceTarget && !!current && target.status !== "unavailable"
    && source.commandType === "apply-flight-path" && source.schoolId === request.schoolId
    && source.teacherId === request.teacherId && source.teachingSessionId === request.teachingSessionId
    && source.supervisionContextId === request.supervisionContextId
    && sourceTarget.schoolId === request.schoolId && sourceTarget.commandId === source.id
    && sourceTarget.studentId === target.studentId && sourceTarget.status === "completed" && result.outcome === "applied"
    && !!target.studentSessionId && !!target.deviceId
    && sourceTarget.studentSessionId === target.studentSessionId && sourceTarget.deviceId === target.deviceId
    && Number.isSafeInteger(revision) && Number(revision) > 0 && current.revision === revision
    && (result.classroomStateRevision === undefined || result.appliedRevision === undefined || result.classroomStateRevision === result.appliedRevision)
    && current.schoolId === request.schoolId && current.studentId === target.studentId
    && current.teachingSessionId === request.teachingSessionId && current.supervisionContextId === request.supervisionContextId
    && current.sourceCommandId === source.id && current.appliedRevision === revision
    && current.lastOutcome === "applied" && current.enforcementHealth === "synced"
    && !!current.hardExpiresAt && current.hardExpiresAt > now && (!current.scheduledEndAt || current.scheduledEndAt > now)
    && (!request.supervisionContextId || (typeof options.contextAuthorityRevision === "string"
      && result.scheduledContextAuthorityRevision === options.contextAuthorityRevision));
}

/** Caller holds entitlement, actor/context and sorted student-control locks. */
export async function classpilotRestrictionPrerequisiteCurrent(database: typeof db,
  request: Pick<InsertClasspilotCommand, "schoolId" | "teacherId" | "teachingSessionId" | "supervisionContextId">,
  target: Pick<InsertClasspilotCommandTarget, "studentId" | "studentSessionId" | "deviceId" | "status">,
  sourceId: string, contextAuthorityRevision?: string): Promise<boolean> {
  const [source] = await database.select().from(classpilotCommands).where(and(
    eq(classpilotCommands.id, sourceId), eq(classpilotCommands.schoolId, request.schoolId))).limit(1);
  const [sourceTarget] = await database.select().from(classpilotCommandTargets).where(and(
    eq(classpilotCommandTargets.commandId, sourceId), eq(classpilotCommandTargets.schoolId, request.schoolId),
    eq(classpilotCommandTargets.studentId, target.studentId))).limit(1).for("update");
  const [current] = await database.select().from(classpilotStudentControlStates).where(and(
    eq(classpilotStudentControlStates.schoolId, request.schoolId), eq(classpilotStudentControlStates.studentId, target.studentId))).limit(1);
  return restrictionPrerequisiteMatches({ request: { ...request, teachingSessionId: request.teachingSessionId || null,
    supervisionContextId: request.supervisionContextId || null }, target: { ...target, status: target.status || "requested",
    studentSessionId: target.studentSessionId || null, deviceId: target.deviceId || null }, source, sourceTarget, current, contextAuthorityRevision });
}
