import { createHash } from "node:crypto";
import { getDashboardSchedule, type PlannedActivity } from "./classpilotDashboardSchedule.js";
import { and, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "../db.js";
import { classpilotSessionStaff, classpilotSessionStudents, classpilotSupervisionContexts, groups, teachingSessions } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { isScheduledClassroomEnabled, scheduledClassroomRoster, scheduledContextHasClassroomTools, scheduledSupervisionSource,
  supervisionActivitySource, type ClasspilotActivityAuthority, type ClasspilotActivitySource } from "./classpilotActivityAuthority.js";
import { classpilotSupervisionPreviewObserved } from "../config/classpilotSupervisionPreviewRollout.js";

export const SCHEDULED_CLASSROOM_COMMANDS = ["open-tab", "close-tabs", "lock-screen", "unlock-screen", "teacher-message",
  "apply-flight-path", "remove-flight-path", "apply-block-list", "remove-block-list", "attention-mode", "timer", "poll",
  "student-sign-out", "temp-unblock", "limit-tabs", "lesson-activity"] as const;

export type ClasspilotDashboardActivity = {
  id: string; source: ClasspilotActivitySource; name: string; startsAt: string; endsAt: string | null;
  status: "active"; authority: ClasspilotActivityAuthority; studentCount: number;
  groupId?: string; teacherId: string; staffIds: string[];
  contextAuthorityRevision?: string;
  sessionMode?: "live"; rosterSnapshotCompletedAt?: string; endTime?: null;
  capabilities: { commands: string[]; fab: boolean; chat: boolean; raiseHand: boolean; polls: boolean; timers: boolean;
    liveView: boolean; screenshots: boolean; settings: boolean };
};

export function classroomActivityCapabilities() {
  return { commands: [...SCHEDULED_CLASSROOM_COMMANDS], fab: true, chat: true, raiseHand: true, polls: true,
    timers: true, liveView: true, screenshots: true, settings: true };
}

/** Personal assignment only. School-wide Observe access is never a personal activity. */
export async function getClasspilotDashboardActivity(schoolId: string, viewerId: string, now = new Date(), database: typeof db = db) {
  // Either rollout makes the activity feed authoritative: scheduled blocks for
  // the scheduled-classroom rollout, ad hoc claims for the supervision-preview one.
  const enabled = isScheduledClassroomEnabled(schoolId) || classpilotSupervisionPreviewObserved(schoolId);
  const activities: ClasspilotDashboardActivity[] = [];
  const identities: unknown[] = [];
  const futureContexts: PlannedActivity[] = [];
  if (enabled) {
    const contexts = await database.select().from(classpilotSupervisionContexts).where(and(
      eq(classpilotSupervisionContexts.schoolId, schoolId), eq(classpilotSupervisionContexts.assignedStaffId, viewerId),
      eq(classpilotSupervisionContexts.status, "active"), gt(classpilotSupervisionContexts.endsAt, now),
      // No scheduled-origin filter: scheduledContextHasClassroomTools below decides
      // per context, so an ad hoc claim reaches the same gate a scheduled block does.
    )).orderBy(classpilotSupervisionContexts.startsAt, classpilotSupervisionContexts.id).limit(201);
    if (contexts.length > 200) throw Object.assign(new Error("Personal activity scope is too large to load completely"), { status: 422 });
    for (const context of contexts) {
      const source = scheduledSupervisionSource(context);
      if (source && context.startsAt > now) futureContexts.push({ id: context.id, source, name: context.name,
        startsAt: context.startsAt.toISOString(), endsAt: context.endsAt.toISOString(), status: "pending" });
      if (!scheduledContextHasClassroomTools(context, now)) continue;
      const roster = await scheduledClassroomRoster(schoolId, context.id, database);
      if (!roster.length) continue;
      identities.push([context.id, context.updatedAt, roster.map((row) => [row.assignment.id, row.student.id])]);
      activities.push({ id: context.id, source: supervisionActivitySource(context), name: context.name,
        startsAt: context.startsAt.toISOString(), endsAt: context.endsAt.toISOString(), status: "active",
        authority: { supervisionContextId: context.id }, studentCount: roster.length, teacherId: context.assignedStaffId,
        staffIds: [context.assignedStaffId], contextAuthorityRevision: String(context.classroomAuthorityRevision),
        capabilities: classroomActivityCapabilities() });
    }
    const sessions = await database.select({ session: teachingSessions, group: groups }).from(teachingSessions)
      .innerJoin(groups, and(eq(groups.id, teachingSessions.groupId), eq(groups.schoolId, schoolId)))
      .innerJoin(classpilotSessionStaff, and(eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id),
        eq(classpilotSessionStaff.schoolId, schoolId), eq(classpilotSessionStaff.staffId, viewerId)))
      .where(and(eq(teachingSessions.schoolId, schoolId), eq(teachingSessions.sessionMode, "live"), isNull(teachingSessions.endTime),
        lte(teachingSessions.startTime, now),
        isNotNull(teachingSessions.rosterSnapshotCompletedAt),
        or(isNull(teachingSessions.scheduledEndAt), gt(teachingSessions.scheduledEndAt, now))))
      .orderBy(desc(teachingSessions.startTime), teachingSessions.id).limit(201);
    if (sessions.length > 200) throw Object.assign(new Error("Personal class scope is too large to load completely"), { status: 422 });
    for (const { session, group } of sessions) {
      const roster = await database.select({ studentId: classpilotSessionStudents.studentId }).from(classpilotSessionStudents)
        .innerJoin(students, and(eq(students.id, classpilotSessionStudents.studentId),
          eq(students.schoolId, schoolId), eq(students.status, "active")))
        .where(and(eq(classpilotSessionStudents.schoolId, schoolId), eq(classpilotSessionStudents.teachingSessionId, session.id))).limit(501);
      if (roster.length > 500) throw Object.assign(new Error("Personal class roster exceeds complete-load limit"), { status: 422 });
      const staff = await database.select({ id: classpilotSessionStaff.staffId }).from(classpilotSessionStaff)
        .where(and(eq(classpilotSessionStaff.schoolId, schoolId), eq(classpilotSessionStaff.teachingSessionId, session.id)));
      identities.push([session.id, session.controlUpdatedAt, roster, staff]);
      activities.push({ id: session.id, source: session.scheduledDate ? "scheduled_class" : "class", name: session.classNameSnapshot || group.name,
        startsAt: (session.scheduledStartAt || session.startTime).toISOString(), endsAt: session.scheduledEndAt?.toISOString() ?? null,
        status: "active", authority: { teachingSessionId: session.id }, studentCount: roster.length, groupId: group.id,
        sessionMode: "live", rosterSnapshotCompletedAt: session.rosterSnapshotCompletedAt!.toISOString(), endTime: null,
        teacherId: session.teacherId, staffIds: staff.map((row) => row.id), capabilities: classroomActivityCapabilities() });
    }
  }
  const current = activities[0] ?? null;
  const schedule = enabled ? await getDashboardSchedule(schoolId, viewerId, current, now, database, futureContexts) : { next: null, nextBoundaryAt: null };
  return { enabled, schoolId, viewerId, serverTime: now.toISOString(),
    revision: `activity-v1:${createHash("sha256").update(JSON.stringify([enabled, activities, identities, schedule.next])).digest("base64url")}`,
    current, activities, ...schedule };
}
