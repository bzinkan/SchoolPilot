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
export type ClasspilotActivitySource = "class" | "scheduled_class" | "scheduled_testing" | "scheduled_coverage"
  | "ad_hoc_supervision";
export type ScheduledSupervisionSource = "scheduled_testing" | "scheduled_coverage";
export type SupervisionActivitySource = ScheduledSupervisionSource | "ad_hoc_supervision";

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

/** Every supervision context has a source; an ad hoc claim simply has no schedule behind it. */
export function supervisionActivitySource(context: Parameters<typeof scheduledSupervisionSource>[0]): SupervisionActivitySource {
  return scheduledSupervisionSource(context) ?? "ad_hoc_supervision";
}

/**
 * Claiming a student IS the act of taking supervisory responsibility, so an ad
 * hoc claim carries the same classroom tools a scheduled block does - gated on
 * its own rollout rather than the scheduled one, so it stages independently.
 */
export function scheduledContextHasClassroomTools(context: ClasspilotSupervisionContext | null | undefined,
  now = new Date()): context is ClasspilotSupervisionContext {
  if (!context || context.status !== "active" || context.startsAt > now || context.endsAt <= now) return false;
  const { schoolId } = context;
  return scheduledSupervisionSource(context)
    ? isScheduledClassroomEnabled(schoolId)
    : classpilotSupervisionPreviewObserved(schoolId);
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
