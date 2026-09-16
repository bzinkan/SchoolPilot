import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { db } from "../db.js";
import { classpilotSupervisionContexts, classpilotSupervisionStudents, type ClasspilotSupervisionContext } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { isScheduledClassroomEnabled } from "../config/classpilotScheduledClassroom.js";
import { classpilotSupervisionPreviewObserved } from "../config/classpilotSupervisionPreviewRollout.js";

export { isScheduledClassroomEnabled } from "../config/classpilotScheduledClassroom.js";

export type ClasspilotActivityAuthority =
  | { teachingSessionId: string; supervisionContextId?: never }
  | { supervisionContextId: string; teachingSessionId?: never };
export type ClasspilotActivitySource = "class" | "scheduled_class" | "scheduled_testing" | "scheduled_coverage";
export type ScheduledSupervisionSource = "scheduled_testing" | "scheduled_coverage";

export function requireScheduledClassroomRequestRevision(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(value)) {
    throw Object.assign(new Error("Refresh the scheduled classroom before trying again"), {
      status: 409, code: "CLASSROOM_AUTHORITY_CHANGED", expose: true,
    });
  }
  return value;
}

export function assertScheduledClassroomAuthorityRevision(context: Pick<ClasspilotSupervisionContext, "classroomAuthorityRevision">, expected: unknown): void {
  if (requireScheduledClassroomRequestRevision(expected) !== String(context.classroomAuthorityRevision)) {
    throw Object.assign(new Error("Scheduled classroom staff assignment changed; refresh before trying again"), {
      status: 409, code: "CLASSROOM_AUTHORITY_CHANGED", expose: true,
    });
  }
}

export function parseClasspilotActivityAuthority(value: unknown): ClasspilotActivityAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if ((raw.teachingSessionId != null && typeof raw.teachingSessionId !== "string")
    || (raw.supervisionContextId != null && typeof raw.supervisionContextId !== "string")) return null;
  const teaching = typeof raw.teachingSessionId === "string" ? raw.teachingSessionId.trim() : "";
  const supervision = typeof raw.supervisionContextId === "string" ? raw.supervisionContextId.trim() : "";
  if ((typeof raw.teachingSessionId === "string" && !teaching) || (typeof raw.supervisionContextId === "string" && !supervision)) return null;
  if (!!teaching === !!supervision || (teaching || supervision).length > 128) return null;
  return teaching ? { teachingSessionId: teaching } : { supervisionContextId: supervision };
}

export function scheduledSupervisionSource(context: Pick<ClasspilotSupervisionContext,
  "scheduleProfileApplicationId" | "scheduleProfileDate" | "scheduleProfileBlockId" | "scheduledConflictId">): ScheduledSupervisionSource | null {
  if (context.scheduleProfileApplicationId && context.scheduleProfileDate && context.scheduleProfileBlockId) return "scheduled_testing";
  return context.scheduledConflictId ? "scheduled_coverage" : null;
}

export function scheduledContextHasClassroomTools(context: ClasspilotSupervisionContext | null | undefined,
  now = new Date()): context is ClasspilotSupervisionContext {
  return !!context && isScheduledClassroomEnabled(context.schoolId) && !!scheduledSupervisionSource(context)
    && context.status === "active" && context.startsAt <= now && context.endsAt > now;
}

export async function requireScheduledClassroomContext(options: {
  schoolId: string; supervisionContextId: string; actorId?: string; allowObserve?: boolean; now?: Date; lock?: boolean;
  contextAuthorityRevision?: string;
}, database: typeof db = db): Promise<ClasspilotSupervisionContext> {
  const now = options.now ?? new Date();
  const query = database.select().from(classpilotSupervisionContexts).where(and(
    eq(classpilotSupervisionContexts.schoolId, options.schoolId),
    eq(classpilotSupervisionContexts.id, options.supervisionContextId),
    eq(classpilotSupervisionContexts.status, "active"),
    lte(classpilotSupervisionContexts.startsAt, now), gt(classpilotSupervisionContexts.endsAt, now),
  )).limit(1);
  const [context] = await (options.lock ? query.for("share") : query);
  if (!scheduledContextHasClassroomTools(context, options.now ?? new Date())
    || (options.actorId && context.assignedStaffId !== options.actorId && !options.allowObserve)) {
    throw Object.assign(new Error("Scheduled classroom activity is unavailable"), { status: 404, code: "CLASSROOM_ACTIVITY_UNAVAILABLE", expose: true });
  }
  if (options.contextAuthorityRevision !== undefined) assertScheduledClassroomAuthorityRevision(context, options.contextAuthorityRevision);
  return context;
}

/**
 * Preview-only supervision authority.
 *
 * Deliberately NOT part of `requireScheduledClassroomContext`, which also gates
 * commands, chat, timers, polls and Live View: widening that would hand an ad
 * hoc claim the whole classroom toolset. This grants exactly one thing — the
 * right to hold a screenshot observation lease on students you have claimed —
 * and only while the supervision-preview rollout is live for the school.
 */
export async function requireSupervisionPreviewContext(options: {
  schoolId: string; supervisionContextId: string; actorId?: string; allowObserve?: boolean; now?: Date; lock?: boolean;
  contextAuthorityRevision?: string;
}, database: typeof db = db): Promise<ClasspilotSupervisionContext> {
  const now = options.now ?? new Date();
  const query = database.select().from(classpilotSupervisionContexts).where(and(
    eq(classpilotSupervisionContexts.schoolId, options.schoolId),
    eq(classpilotSupervisionContexts.id, options.supervisionContextId),
    eq(classpilotSupervisionContexts.status, "active"),
    lte(classpilotSupervisionContexts.startsAt, now), gt(classpilotSupervisionContexts.endsAt, now),
  )).limit(1);
  const [context] = await (options.lock ? query.for("share") : query);
  const unavailable = () => Object.assign(new Error("Supervision activity is unavailable"),
    { status: 404, code: "CLASSROOM_ACTIVITY_UNAVAILABLE", expose: true });
  if (!context || context.status !== "active" || context.startsAt > now || context.endsAt <= now) throw unavailable();
  // Read the school before the predicate below: it narrows `context` away on its
  // false branch, which would make this unreachable to the type checker.
  const { schoolId, assignedStaffId } = context;
  // A scheduled classroom keeps its existing authority; the rollout is what
  // additionally admits an ad hoc claim.
  if (!scheduledContextHasClassroomTools(context, now) && !classpilotSupervisionPreviewObserved(schoolId)) throw unavailable();
  if (options.actorId && assignedStaffId !== options.actorId && !options.allowObserve) throw unavailable();
  if (options.contextAuthorityRevision !== undefined) assertScheduledClassroomAuthorityRevision(context, options.contextAuthorityRevision);
  return context;
}

export async function scheduledClassroomRoster(schoolId: string, supervisionContextId: string, database: typeof db = db) {
  const rows = await database.select({ assignment: classpilotSupervisionStudents, student: students })
    .from(classpilotSupervisionStudents).innerJoin(students, and(
      eq(students.id, classpilotSupervisionStudents.studentId), eq(students.schoolId, schoolId), eq(students.status, "active"),
    )).where(and(eq(classpilotSupervisionStudents.schoolId, schoolId),
      eq(classpilotSupervisionStudents.contextId, supervisionContextId), isNull(classpilotSupervisionStudents.releasedAt)))
    .orderBy(classpilotSupervisionStudents.studentId).limit(501);
  if (rows.length > 500) throw Object.assign(new Error("Classroom roster exceeds the complete-load limit"), { status: 422, code: "CLASSROOM_ROSTER_LIMIT" });
  return rows;
}

export async function scheduledClassroomBindingCapable(options: { schoolId: string; studentId: string; studentSessionId: string; deviceId: string }) {
  // Shared storage also serves GoPilot. Only an actual scheduled classroom
  // capability check should load the realtime Redis client.
  const { classpilotRealtimeFresh, readClasspilotRealtimeStatusBatch } = await import("./classpilotRealtimeStatus.js");
  const snapshot = (await readClasspilotRealtimeStatusBatch(options.schoolId, [options])).get(options.studentId);
  return snapshot?.status === "hit" && classpilotRealtimeFresh(snapshot.snapshot)
    && snapshot.snapshot.acceptedCapabilities?.includes("scheduledClassroomV1") === true;
}
