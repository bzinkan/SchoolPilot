import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "../db.js";
import { users } from "../schema/core.js";
import { students } from "../schema/students.js";
import { classpilotSessionStudents, classpilotSupervisionContexts, classpilotSupervisionStudents, groups, teachingSessions } from "../schema/classpilot.js";
import { scheduledContextHasClassroomTools, supervisionActivitySource } from "./classpilotActivityAuthority.js";
import { supervisionActivityPresentation } from "./classpilotSupervisionPurpose.js";
import { classpilotObservationSessionIsCurrent } from "./classpilotObservationAuthority.js";

const capabilities = { observe: true, tiles: true, screenshots: true, commands: false, fab: false, liveView: false } as const;

/** Discovery only: every subsequent lease/read/subscription reauthorizes its exact authority. */
export async function getClasspilotObservableActivities(schoolId: string, now = new Date(), database: typeof db = db) {
  const contexts = await database.select().from(classpilotSupervisionContexts).where(and(
    eq(classpilotSupervisionContexts.schoolId, schoolId), eq(classpilotSupervisionContexts.status, "active"),
    lte(classpilotSupervisionContexts.startsAt, now), gt(classpilotSupervisionContexts.endsAt, now),
  )).orderBy(classpilotSupervisionContexts.startsAt, classpilotSupervisionContexts.id).limit(501);
  const sessions = await database.select({ session: teachingSessions, group: groups }).from(teachingSessions)
    .innerJoin(groups, and(eq(groups.id, teachingSessions.groupId), eq(groups.schoolId, schoolId)))
    .where(and(eq(teachingSessions.schoolId, schoolId), or(eq(teachingSessions.sessionMode, "live"), and(
      eq(teachingSessions.sessionMode, "scheduled_report"), eq(teachingSessions.scheduledState, "active"),
      isNotNull(teachingSessions.scheduledDate), lte(teachingSessions.scheduledStartAt, now), gt(teachingSessions.scheduledEndAt, now))),
      isNull(teachingSessions.endTime), lte(teachingSessions.startTime, now), isNotNull(teachingSessions.rosterSnapshotCompletedAt),
      or(isNull(teachingSessions.scheduledEndAt), gt(teachingSessions.scheduledEndAt, now))))
    .orderBy(teachingSessions.startTime, teachingSessions.id).limit(501);
  if (contexts.length > 500 || sessions.length > 500) throw Object.assign(new Error("Too many active activities to load completely"), { status: 422 });
  const admittedContexts = contexts.filter(context => scheduledContextHasClassroomTools(context, now));
  const assignments = admittedContexts.length ? await database.select({ contextId: classpilotSupervisionStudents.contextId,
    source: classpilotSupervisionStudents.source }).from(classpilotSupervisionStudents)
    .innerJoin(students, and(eq(students.id, classpilotSupervisionStudents.studentId), eq(students.schoolId, schoolId), eq(students.status, "active")))
    .where(and(eq(classpilotSupervisionStudents.schoolId, schoolId), isNull(classpilotSupervisionStudents.releasedAt),
      inArray(classpilotSupervisionStudents.contextId, admittedContexts.map(context => context.id)))) : [];
  const rosters = sessions.length ? await database.select({ sessionId: classpilotSessionStudents.teachingSessionId })
    .from(classpilotSessionStudents).innerJoin(students, and(eq(students.id, classpilotSessionStudents.studentId),
      eq(students.schoolId, schoolId), eq(students.status, "active")))
    .where(and(eq(classpilotSessionStudents.schoolId, schoolId), inArray(classpilotSessionStudents.teachingSessionId, sessions.map(row => row.session.id)))) : [];
  const ownerIds = [...new Set([...admittedContexts.map(context => context.assignedStaffId), ...sessions.map(row => row.session.teacherId)])];
  const owners = ownerIds.length ? await database.select({ id: users.id, displayName: users.displayName, firstName: users.firstName, lastName: users.lastName })
    .from(users).where(inArray(users.id, ownerIds)) : [];
  const names = new Map(owners.map(owner => [owner.id, owner.displayName || [owner.firstName, owner.lastName].filter(Boolean).join(" ") || "Staff"]));
  const contextAssignments = new Map<string, Array<{ source: string }>>();
  for (const assignment of assignments) {
    const rows = contextAssignments.get(assignment.contextId) ?? [];
    rows.push(assignment);
    contextAssignments.set(assignment.contextId, rows);
  }
  const sessionCounts = new Map<string, number>();
  for (const row of rosters) sessionCounts.set(row.sessionId, (sessionCounts.get(row.sessionId) ?? 0) + 1);
  return { activities: [
    ...admittedContexts.flatMap(context => {
      const roster = contextAssignments.get(context.id) ?? [];
      if (!roster.length) return [];
      return [{ id: context.id, ...supervisionActivityPresentation(context, roster), source: supervisionActivitySource(context),
        status: "active", startsAt: context.startsAt.toISOString(), endsAt: context.endsAt.toISOString(), studentCount: roster.length,
        owner: { id: context.assignedStaffId, name: names.get(context.assignedStaffId) ?? "Staff" },
        authority: { supervisionContextId: context.id, teachingSessionId: null, contextAuthorityRevision: String(context.classroomAuthorityRevision) },
        capabilities }];
    }),
    ...sessions.flatMap(({ session, group }) => {
      const studentCount = sessionCounts.get(session.id) ?? 0;
      if (!studentCount || !classpilotObservationSessionIsCurrent(session, now)) return [];
      return [{ id: session.id, name: session.classNameSnapshot || group.name, purpose: "class" as const,
        source: session.scheduledDate ? "scheduled_class" : "class", status: "active",
        sessionMode: session.sessionMode,
        supervisionStatus: session.sessionMode === "scheduled_report" ? "awaiting_teacher" : "live",
        startsAt: (session.scheduledStartAt || session.startTime).toISOString(), endsAt: session.scheduledEndAt?.toISOString() ?? null,
        studentCount, owner: { id: session.teacherId, name: names.get(session.teacherId) ?? "Staff" },
        authority: { teachingSessionId: session.id, supervisionContextId: null, contextAuthorityRevision: null }, capabilities }];
    }),
  ] };
}
