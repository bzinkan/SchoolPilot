import type db from "../db.js";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import {
  isClasspilotStaffUserConnected,
  type ClasspilotStaffPresenceStore,
} from "../realtime/classpilotStaffPresence.js";
import type { ClasspilotScheduledConflict, Group, TeachingSession } from "../schema/classpilot.js";
import type { Student } from "../schema/students.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  dispatchDueClasspilotSessionSummaries,
  finalizeClasspilotSession,
  runClasspilotFinalizationSideEffects,
} from "./classpilotSessionLifecycle.js";
import {
  createOrReuseScheduledReportSession,
  getActiveClassOwnersForStudents,
  getActiveScheduledReportSessionForConflict,
  getActiveSessionByStudent,
  getActiveSupervisionForStudents,
  getActiveTeachingSessionForSchool,
  getClasspilotSessionStudentRoster,
  getGroupByIdAndSchool,
  getGroupStudents,
  getScheduledClassConflictByIdAndSchool,
  getScheduledClassConflictForSlot,
  getScheduledTeachingSessionOccurrence,
  getSchoolById,
  getUserById,
  listActiveScheduledClassConflictsReadyToExpire,
  listActiveScheduledClassConflictsForTeacher,
  listActiveSupervisionContextsForScheduledConflict,
  listOtherActiveTeachingSessionsForSchool,
  promoteScheduledReportSessionToLive,
  releaseScheduledConflictSupervision,
  resolveScheduledClassConflict,
  resolveScheduledConflictForStartedOccurrence,
  skipScheduledTeachingSessionOccurrence,
  upsertScheduledClassConflictForOccurrence,
  withTeachingSessionStartLock,
  type FinalizeTeachingSessionResult,
} from "./storage.js";

export type ScheduledClassAutoStartResult =
  | { status: "started"; session: TeachingSession }
  | { status: "coverage_needed"; conflictId: string }
  | { status: "claimed"; conflictId: string }
  | { status: "skipped"; reason: string };

export type ScheduledCoverageStudentPayload = {
  studentId: string;
  studentName: string;
  studentEmail?: string;
  gradeLevel?: string;
};

export type ScheduledCoveragePayload = {
  code: "SCHEDULED_COVERAGE_NEEDED";
  selectedClass: {
    id: string;
    name: string;
  };
  scheduledTeacher: {
    id: string;
    displayName: string;
  };
  scheduledDate: string;
  blockStartTime: string | null;
  blockEndTime: string | null;
  reportingState: "active";
  needsSupervision: boolean;
  teacherConnected: boolean;
  totalRosterCount: number;
  claimableCount: number;
  monitoredCount: number;
  claimedCount: number;
  offlineOrUnmonitoredCount: number;
  claimableStudents: ScheduledCoverageStudentPayload[];
  monitoredGroups: {
    teacherId: string;
    teacherName: string;
    classId: string;
    className: string;
    sessionId: string;
    affectedCount: number;
    affectedStudents: ScheduledCoverageStudentPayload[];
  }[];
};

function displayName(user: any): string {
  return user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || user?.email || "Unknown teacher";
}

function studentName(student: Student): string {
  return [student.firstName, student.lastName].filter(Boolean).join(" ").trim() || student.email || student.id;
}

function safeStudent(student: Student): ScheduledCoverageStudentPayload {
  return {
    studentId: student.id,
    studentName: studentName(student),
    studentEmail: student.email || undefined,
    gradeLevel: student.gradeLevel || undefined,
  };
}

function conflictBroadcast(conflictId: string) {
  return {
    type: "scheduled-class-conflict-updated" as const,
    conflictId,
  };
}

function scheduledBlockStartUtc(scheduledDate: string, blockStartTime: string, timeZone: string): Date {
  return localDateTimeUtc(scheduledDate, blockStartTime, timeZone);
}

export function broadcastScheduledClassUpdate(
  schoolId: string,
  update: { type: "scheduled-class-conflict-updated"; conflictId?: string; startedSessionIds?: string[] }
): void {
  broadcastToTeachersLocal(schoolId, update);
  void publishWS({ kind: "staff", schoolId }, update);
}

export function broadcastScheduledConflictUpdate(schoolId: string, conflictId: string): void {
  broadcastScheduledClassUpdate(schoolId, conflictBroadcast(conflictId));
}

function scheduledConflictExpiredError(message = "This scheduled block has ended."): Error & { status: number; code: string } {
  return Object.assign(new Error(message), {
    status: 409,
    code: "SCHEDULED_CONFLICT_EXPIRED",
  });
}

async function teacherConnected(
  schoolId: string,
  teacherId: string,
  options: {
    connectedTeacherIdsOverride?: Set<string>;
    scheduledTeacherConnectedOverride?: boolean;
    presenceStore?: Pick<ClasspilotStaffPresenceStore, "isFresh">;
    now?: Date;
  } = {}
): Promise<boolean> {
  if (options.scheduledTeacherConnectedOverride !== undefined) {
    return options.scheduledTeacherConnectedOverride;
  }
  if (options.connectedTeacherIdsOverride) {
    return options.connectedTeacherIdsOverride.has(teacherId);
  }
  return isClasspilotStaffUserConnected(schoolId, teacherId, {
    presenceStore: options.presenceStore,
    now: options.now,
  });
}

export async function buildScheduledCoveragePayload(options: {
  group: Group;
  scheduledDate: string;
  scheduledConflictId?: string | null;
  scheduledSession?: TeachingSession | null;
  dbInstance?: typeof db;
  connectedTeacherIdsOverride?: Set<string>;
  presenceStore?: Pick<ClasspilotStaffPresenceStore, "isFresh">;
  now?: Date;
}): Promise<ScheduledCoveragePayload> {
  const group = options.group;
  const schoolId = group.schoolId;
  const occurrence = options.scheduledSession
    || (options.scheduledConflictId
      ? await getActiveScheduledReportSessionForConflict(
          schoolId,
          options.scheduledConflictId,
          options.dbInstance
        )
      : undefined);
  const rows = occurrence?.rosterSnapshotCompletedAt
    ? await getClasspilotSessionStudentRoster(schoolId, occurrence.id, options.dbInstance)
    : await getGroupStudents(group.id, options.dbInstance);
  const studentIds = rows.map((row) => row.studentId);
  const scheduledTeacherId = occurrence?.teacherId || group.teacherId;
  const [teacher, owners, activeSupervision] = await Promise.all([
    getUserById(scheduledTeacherId, options.dbInstance),
    getActiveClassOwnersForStudents(schoolId, studentIds, options.dbInstance),
    getActiveSupervisionForStudents(schoolId, studentIds, options.dbInstance),
  ]);
  const ownerByStudent = new Map(owners.map((owner) => [owner.studentId, owner]));
  const supervisionByStudent = new Map(activeSupervision.map((entry) => [entry.studentId, entry.context]));
  const scheduledContexts = options.scheduledConflictId
    ? await listActiveSupervisionContextsForScheduledConflict(schoolId, options.scheduledConflictId, options.dbInstance)
    : [];
  const scheduledContextIds = new Set(scheduledContexts.map((context) => context.id));
  const presenceByTeacherId = new Map<string, Promise<boolean>>();
  const isTeacherConnected = (teacherId: string): Promise<boolean> => {
    let result = presenceByTeacherId.get(teacherId);
    if (!result) {
      result = teacherConnected(schoolId, teacherId, {
        connectedTeacherIdsOverride: options.connectedTeacherIdsOverride,
        presenceStore: options.presenceStore,
        now: options.now,
      });
      presenceByTeacherId.set(teacherId, result);
    }
    return result;
  };
  const monitoredByKey = new Map<string, {
    teacherId: string;
    teacherName: string;
    classId: string;
    className: string;
    sessionId: string;
    count: number;
    students: ScheduledCoverageStudentPayload[];
  }>();

  const claimableStudents: ScheduledCoverageStudentPayload[] = [];
  let claimedCount = 0;
  let monitoredCount = 0;
  let offlineOrUnmonitoredCount = 0;

  for (const row of rows) {
    const activeSession = await getActiveSessionByStudent(row.studentId);
    const lastSeenAt = activeSession?.lastSeenAt?.getTime?.() || 0;
    const isOnline = !!activeSession
      && lastSeenAt > 0
      && (options.now?.getTime() ?? Date.now()) - lastSeenAt <= 5 * 60 * 1000;
    const activeCoverage = supervisionByStudent.get(row.studentId);
    if (activeCoverage) {
      if (scheduledContextIds.has(activeCoverage.id)) {
        claimedCount++;
      } else {
        monitoredCount++;
      }
      continue;
    }

    const owner = ownerByStudent.get(row.studentId);
    if (owner && await isTeacherConnected(owner.session.teacherId)) {
      monitoredCount++;
      const key = `${owner.session.teacherId}:${owner.groupId}:${owner.session.id}`;
      let entry = monitoredByKey.get(key);
      if (!entry) {
        const ownerTeacher = await getUserById(owner.session.teacherId, options.dbInstance);
        entry = {
          teacherId: owner.session.teacherId,
          teacherName: displayName(ownerTeacher),
          classId: owner.groupId,
          className: owner.groupName,
          sessionId: owner.session.id,
          count: 0,
          students: [],
        };
        monitoredByKey.set(key, entry);
      }
      entry.count++;
      if (entry.students.length < 5) entry.students.push(safeStudent(row.student));
      continue;
    }

    if (isOnline) {
      claimableStudents.push(safeStudent(row.student));
    } else {
      offlineOrUnmonitoredCount++;
    }
  }

  return {
    code: "SCHEDULED_COVERAGE_NEEDED",
    selectedClass: {
      id: group.id,
      name: occurrence?.classNameSnapshot || group.name,
    },
    scheduledTeacher: {
      id: scheduledTeacherId,
      displayName: displayName(teacher),
    },
    scheduledDate: occurrence?.scheduledDate || options.scheduledDate,
    blockStartTime: occurrence?.scheduledStartAt
      ? occurrence.scheduledStartAt.toLocaleString("en-US", {
          timeZone: occurrence.scheduledTimezone || "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).replace(/^24:/, "00:")
      : group.blockStartTime || null,
    blockEndTime: occurrence?.scheduledEndAt
      ? occurrence.scheduledEndAt.toLocaleString("en-US", {
          timeZone: occurrence.scheduledTimezone || "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).replace(/^24:/, "00:")
      : group.blockEndTime || null,
    reportingState: "active",
    needsSupervision: true,
    teacherConnected: await isTeacherConnected(scheduledTeacherId),
    totalRosterCount: rows.length,
    claimableCount: claimableStudents.length,
    monitoredCount,
    claimedCount,
    offlineOrUnmonitoredCount,
    claimableStudents,
    monitoredGroups: Array.from(monitoredByKey.values()).map((entry) => ({
      teacherId: entry.teacherId,
      teacherName: entry.teacherName,
      classId: entry.classId,
      className: entry.className,
      sessionId: entry.sessionId,
      affectedCount: entry.count,
      affectedStudents: entry.students,
    })),
  };
}

async function startScheduledClass(options: {
  group: Group;
  scheduledSession: TeachingSession;
  scheduledConflict?: ClasspilotScheduledConflict | null;
  actorId?: string | null;
  dbInstance?: typeof db;
  afterReplacement?: () => Promise<void>;
}): Promise<TeachingSession> {
  const outcome = await withTeachingSessionStartLock(
    options.group.schoolId,
    options.scheduledSession.teacherId,
    (lockedDb) => startScheduledClassLocked({ ...options, dbInstance: lockedDb }),
    options.dbInstance
  );
  for (const finalization of outcome.finalizations) {
    runClasspilotFinalizationSideEffects(finalization.result, {
      schoolId: options.group.schoolId,
      reason: finalization.reason,
      dbInstance: options.dbInstance,
    });
    if (finalization.result.deliveryCount > 0) {
      void runWithTenantContext({ schoolId: options.group.schoolId }, () =>
        dispatchDueClasspilotSessionSummaries({
          schoolId: options.group.schoolId,
          teachingSessionId: finalization.result.session.id,
          limit: 2,
        })
      ).catch((error) => {
        console.warn(`[SessionSummary] Replacement delivery deferred for ${finalization.result.session.id}:`, error);
      });
    }
  }
  for (const conflictId of outcome.resolvedConflictIds) {
    broadcastScheduledConflictUpdate(options.group.schoolId, conflictId);
  }
  return outcome.session;
}

async function startScheduledClassLocked(options: {
  group: Group;
  scheduledSession: TeachingSession;
  scheduledConflict?: ClasspilotScheduledConflict | null;
  actorId?: string | null;
  dbInstance: typeof db;
  afterReplacement?: () => Promise<void>;
}): Promise<{
  session: TeachingSession;
  finalizations: Array<{
    result: FinalizeTeachingSessionResult;
    reason: "replacement_start";
  }>;
  resolvedConflictIds: string[];
}> {
  const dbInstance = options.dbInstance;
  const finalizations: Array<{
    result: FinalizeTeachingSessionResult;
    reason: "replacement_start";
  }> = [];
  const resolvedConflictIds: string[] = [];
  // Promotion is the linearization point. A concurrent End that wins first
  // prevents every replacement/coverage side effect; concurrent starters can
  // re-read the same live winner and remain idempotent.
  const promotedSession = await promoteScheduledReportSessionToLive({
    schoolId: options.group.schoolId,
    sessionId: options.scheduledSession.id,
  }, dbInstance);
  const currentOccurrence = promotedSession || await getScheduledTeachingSessionOccurrence(
    options.group.schoolId,
    options.scheduledSession.groupId,
    options.scheduledSession.scheduledDate!,
    dbInstance
  );
  const session = currentOccurrence?.sessionMode === "live"
    && !currentOccurrence.endTime
    && currentOccurrence.scheduledState === "active"
    ? currentOccurrence
    : undefined;
  if (!session) {
    throw Object.assign(new Error("This scheduled class occurrence is already finalized."), {
      status: 409,
      code: "SCHEDULED_OCCURRENCE_FINALIZED",
    });
  }

  const effectiveConflict = options.scheduledConflict
    || (session.scheduledConflictId
      ? await getScheduledClassConflictByIdAndSchool(
          session.scheduledConflictId,
          options.group.schoolId,
          dbInstance
        )
      : null);
  const effectiveConflictActive = !!effectiveConflict
    && ["coverage_needed", "claimed", "pending"].includes(effectiveConflict.status);
  const replacedSessions = await listOtherActiveTeachingSessionsForSchool(
    options.scheduledSession.teacherId,
    options.group.schoolId,
    session.id,
    dbInstance
  );
  for (const replacedSession of replacedSessions) {
    const finalized = await finalizeClasspilotSession({
      schoolId: options.group.schoolId,
      sessionId: replacedSession.id,
      reason: "replacement_start",
      dbInstance,
      deferSideEffects: true,
    });
    if (finalized) finalizations.push({ result: finalized, reason: "replacement_start" });
  }
  if (finalizations.length > 0) await options.afterReplacement?.();

  if (effectiveConflictActive) {
    const resolved = await resolveScheduledConflictForStartedOccurrence({
      schoolId: options.group.schoolId,
      teachingSessionId: session.id,
      scheduledConflictId: effectiveConflict.id,
      actorId: options.actorId || null,
    }, dbInstance);
    if (resolved) {
      resolvedConflictIds.push(effectiveConflict.id);
    }
  }
  return { session, finalizations, resolvedConflictIds };
}

export async function startScheduledClassFromConflict(options: {
  conflict: ClasspilotScheduledConflict;
  actorId?: string | null;
  dbInstance?: typeof db;
  now?: Date;
}): Promise<TeachingSession> {
  const group = await getGroupByIdAndSchool(
    options.conflict.groupId,
    options.conflict.schoolId,
    options.dbInstance
  );
  if (!group) throw Object.assign(new Error("Class not found"), { status: 404 });
  const occurrence = await getActiveScheduledReportSessionForConflict(
    options.conflict.schoolId,
    options.conflict.id,
    options.dbInstance
  );
  if (!occurrence?.scheduledStartAt || !occurrence.scheduledEndAt) {
    throw Object.assign(new Error("Scheduled occurrence not found"), { status: 409 });
  }
  const now = options.now || new Date();
  if (now < occurrence.scheduledStartAt || now >= occurrence.scheduledEndAt) {
    if (now >= occurrence.scheduledEndAt) {
      await expireScheduledClassConflict({
        conflict: options.conflict,
        actorId: options.actorId || null,
        dbInstance: options.dbInstance,
      });
      throw scheduledConflictExpiredError();
    }
    throw Object.assign(new Error("This scheduled block is not currently active."), {
      status: 409,
      code: "SCHEDULED_CONFLICT_NOT_ACTIVE",
    });
  }
  return startScheduledClass({
    group,
    scheduledSession: occurrence,
    scheduledConflict: options.conflict,
    actorId: options.actorId || null,
    dbInstance: options.dbInstance,
  });
}

export async function processScheduledClassAutoStart(options: {
  group: Group;
  scheduledDate: string;
  dbInstance?: typeof db;
  scheduledTeacherConnectedOverride?: boolean;
  connectedTeacherIdsOverride?: Set<string>;
  presenceStore?: Pick<ClasspilotStaffPresenceStore, "isFresh">;
  now?: Date;
  afterReplacement?: () => Promise<void>;
}): Promise<ScheduledClassAutoStartResult> {
  const dbInstance = options.dbInstance;
  const group = options.group;
  const school = await getSchoolById(group.schoolId, dbInstance);
  const timeZone = school?.schoolTimezone || "America/New_York";
  const now = options.now || new Date();
  let occurrence = await getScheduledTeachingSessionOccurrence(
    group.schoolId,
    group.id,
    options.scheduledDate,
    dbInstance
  );
  let blockStartTime = group.blockStartTime || "";
  let blockEndTime = group.blockEndTime || "";
  if (!occurrence) {
    if (!blockStartTime || !blockEndTime) return { status: "skipped", reason: "missing_schedule_window" };
    const scheduledStartAt = scheduledBlockStartUtc(options.scheduledDate, blockStartTime, timeZone);
    const scheduledEndAt = scheduledBlockStartUtc(options.scheduledDate, blockEndTime, timeZone);
    if (now < scheduledStartAt || now >= scheduledEndAt) {
      return { status: "skipped", reason: "outside_schedule_window" };
    }
    const scheduledTeacher = await getUserById(group.teacherId, dbInstance);
    occurrence = await createOrReuseScheduledReportSession({
      schoolId: group.schoolId,
      groupId: group.id,
      teacherId: group.teacherId,
      scheduledDate: options.scheduledDate,
      scheduledTimezone: timeZone,
      scheduledStartAt,
      scheduledEndAt,
      scheduledTeacherEmail: scheduledTeacher?.email || null,
      scheduledTeacherName: displayName(scheduledTeacher),
    }, dbInstance);
  } else if (occurrence.scheduledStartAt && occurrence.scheduledEndAt) {
    const occurrenceTimeZone = occurrence.scheduledTimezone || timeZone;
    blockStartTime = occurrence.scheduledStartAt.toLocaleString("en-US", {
      timeZone: occurrenceTimeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace(/^24:/, "00:");
    blockEndTime = occurrence.scheduledEndAt.toLocaleString("en-US", {
      timeZone: occurrenceTimeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace(/^24:/, "00:");
  }
  if (occurrence.endTime || occurrence.scheduledState === "finalized" || occurrence.scheduledState === "skipped") {
    return { status: "skipped", reason: occurrence.scheduledState || "finalized" };
  }
  if (occurrence.scheduledStartAt && now < occurrence.scheduledStartAt) {
    return { status: "skipped", reason: "not_yet_due" };
  }
  if (occurrence.scheduledEndAt && occurrence.scheduledEndAt <= now) {
    await finalizeClasspilotSession({
      schoolId: group.schoolId,
      sessionId: occurrence.id,
      reason: "scheduled_end",
      finalizedAt: occurrence.scheduledEndAt,
      dbInstance,
    });
    return { status: "skipped", reason: "scheduled_end" };
  }
  const occurrenceGroup = occurrence.teacherId === group.teacherId
    ? group
    : { ...group, teacherId: occurrence.teacherId };
  let existingConflict = occurrence.scheduledConflictId
    ? await getScheduledClassConflictByIdAndSchool(
      occurrence.scheduledConflictId,
      group.schoolId,
      dbInstance
    )
    : await getScheduledClassConflictForSlot({
      schoolId: group.schoolId,
      groupId: group.id,
      scheduledDate: occurrence.scheduledDate || options.scheduledDate,
      blockStartTime,
    }, dbInstance);
  if (occurrence.sessionMode === "live" && !occurrence.endTime) {
    const session = await startScheduledClass({
      group: occurrenceGroup,
      scheduledSession: occurrence,
      scheduledConflict: existingConflict,
      dbInstance,
      afterReplacement: options.afterReplacement,
    });
    return { status: "started", session };
  }
  if (["skipped", "started", "expired"].includes(existingConflict?.status || "")) {
    return { status: "skipped", reason: existingConflict!.status };
  }

  const scheduledTeacherConnected = await teacherConnected(group.schoolId, occurrence.teacherId, {
    scheduledTeacherConnectedOverride: options.scheduledTeacherConnectedOverride,
    connectedTeacherIdsOverride: options.connectedTeacherIdsOverride,
    presenceStore: options.presenceStore,
    now,
  });

  if (scheduledTeacherConnected) {
    const session = await startScheduledClass({
      group: occurrenceGroup,
      scheduledSession: occurrence,
      scheduledConflict: existingConflict,
      dbInstance,
      afterReplacement: options.afterReplacement,
    });
    broadcastScheduledClassUpdate(group.schoolId, {
      type: "scheduled-class-conflict-updated",
      startedSessionIds: [session.id],
    });
    return { status: "started", session };
  }

  const payload = await buildScheduledCoveragePayload({
    group: occurrenceGroup,
    scheduledDate: options.scheduledDate,
    scheduledConflictId: existingConflict?.id || null,
    scheduledSession: occurrence,
    dbInstance,
    connectedTeacherIdsOverride: options.connectedTeacherIdsOverride,
    presenceStore: options.presenceStore,
    now,
  });
  const status = payload.claimedCount > 0 ? "claimed" : "coverage_needed";
  const occurrenceStartHHMM = occurrence.scheduledStartAt!.toLocaleString("en-US", {
    timeZone: occurrence.scheduledTimezone || timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(/^24:/, "00:");
  const occurrenceEndHHMM = occurrence.scheduledEndAt!.toLocaleString("en-US", {
    timeZone: occurrence.scheduledTimezone || timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(/^24:/, "00:");
  const conflictResult = await upsertScheduledClassConflictForOccurrence({
    teachingSessionId: occurrence.id,
    schoolId: group.schoolId,
    groupId: group.id,
    teacherId: occurrence.teacherId,
    scheduledDate: occurrence.scheduledDate || options.scheduledDate,
    blockStartTime: existingConflict?.blockStartTime || occurrenceStartHHMM,
    blockEndTime: existingConflict?.blockEndTime || occurrenceEndHHMM,
    status,
    conflictPayload: payload,
    scheduledTeacherConnected: false,
  }, dbInstance);
  const conflict = conflictResult.conflict;
  if (!conflictResult.occurrenceActive) {
    return { status: "skipped", reason: "finalized" };
  }
  broadcastScheduledConflictUpdate(group.schoolId, conflict.id);
  return { status: status === "claimed" ? "claimed" : "coverage_needed", conflictId: conflict.id };
}

export async function startActiveScheduledClassesForTeacher(options: {
  schoolId: string;
  teacherId: string;
  now?: Date;
}): Promise<TeachingSession[]> {
  const now = options.now || new Date();
  const school = await getSchoolById(options.schoolId);
  const timeZone = school?.schoolTimezone || "America/New_York";
  const scheduledDate = localDateInTimeZone(now, timeZone);
  const conflicts = await listActiveScheduledClassConflictsForTeacher(
    options.schoolId,
    options.teacherId,
    scheduledDate
  );
  const started: TeachingSession[] = [];
  for (const conflict of conflicts) {
    try {
      const session = await startScheduledClassFromConflict({
        conflict,
        actorId: options.teacherId,
        now,
      });
      started.push(session);
    } catch (error) {
      if (!["SCHEDULED_CONFLICT_EXPIRED", "SCHEDULED_CONFLICT_NOT_ACTIVE"].includes((error as any)?.code)) {
        throw error;
      }
    }
  }
  return started;
}

export async function expireScheduledClassConflict(options: {
  conflict: ClasspilotScheduledConflict;
  actorId?: string | null;
  dbInstance?: typeof db;
}): Promise<ClasspilotScheduledConflict | undefined> {
  const dbInstance = options.dbInstance;
  if (options.conflict.status === "expired") return options.conflict;
  await closeScheduledConflictReporting({
    conflict: options.conflict,
    releaseReason: "scheduled_window_ended",
    dbInstance,
  });
  const updated = await resolveScheduledClassConflict(
    options.conflict.id,
    options.conflict.schoolId,
    "expired",
    options.actorId || null,
    dbInstance
  );
  broadcastScheduledConflictUpdate(options.conflict.schoolId, options.conflict.id);
  return updated;
}

export async function closeScheduledConflictReporting(options: {
  conflict: ClasspilotScheduledConflict;
  releaseReason: string;
  dbInstance?: typeof db;
}): Promise<void> {
  const dbInstance = options.dbInstance;
  await releaseScheduledConflictSupervision({
    schoolId: options.conflict.schoolId,
    scheduledConflictId: options.conflict.id,
    releaseReason: options.releaseReason,
  }, dbInstance);
  const reportSession = await getActiveScheduledReportSessionForConflict(
    options.conflict.schoolId,
    options.conflict.id,
    dbInstance
  );
  if (reportSession) {
    await finalizeClasspilotSession({
      schoolId: options.conflict.schoolId,
      sessionId: reportSession.id,
      reason: "scheduled_end",
      finalizedAt: reportSession.scheduledEndAt || undefined,
      dbInstance,
    });
  }
}

/** Freeze the old schedule/teacher/roster before an in-progress class edit. */
export async function freezeScheduledOccurrenceIfDue(options: {
  group: Group;
  now?: Date;
  dbInstance?: typeof db;
}): Promise<TeachingSession | undefined> {
  const { group } = options;
  if (!group.scheduleEnabled || !group.blockStartTime || !group.blockEndTime) return undefined;
  const now = options.now || new Date();
  const dbInstance = options.dbInstance;
  const school = await getSchoolById(group.schoolId, dbInstance);
  const timeZone = school?.schoolTimezone || "America/New_York";
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  if (weekday === "Sat" || weekday === "Sun") return undefined;
  const scheduledDate = localDateInTimeZone(now, timeZone);
  const scheduledStartAt = scheduledBlockStartUtc(scheduledDate, group.blockStartTime, timeZone);
  const scheduledEndAt = scheduledBlockStartUtc(scheduledDate, group.blockEndTime, timeZone);
  if (now < scheduledStartAt || now >= scheduledEndAt) return undefined;
  const teacher = await getUserById(group.teacherId, dbInstance);
  return createOrReuseScheduledReportSession({
    schoolId: group.schoolId,
    groupId: group.id,
    teacherId: group.teacherId,
    scheduledDate,
    scheduledTimezone: timeZone,
    scheduledStartAt,
    scheduledEndAt,
    scheduledTeacherEmail: teacher?.email || null,
    scheduledTeacherName: displayName(teacher),
  }, dbInstance);
}

export async function skipScheduledClassBeforeStart(options: {
  group: Group;
  scheduledDate: string;
  now?: Date;
  dbInstance?: typeof db;
}): Promise<{ skipped: boolean; session?: TeachingSession }> {
  if (!options.group.blockStartTime || !options.group.blockEndTime) return { skipped: false };
  const school = await getSchoolById(options.group.schoolId);
  const timeZone = school?.schoolTimezone || "America/New_York";
  const teacher = await getUserById(options.group.teacherId);
  return skipScheduledTeachingSessionOccurrence({
    schoolId: options.group.schoolId,
    groupId: options.group.id,
    teacherId: options.group.teacherId,
    scheduledDate: options.scheduledDate,
    scheduledTimezone: timeZone,
    scheduledStartAt: scheduledBlockStartUtc(options.scheduledDate, options.group.blockStartTime, timeZone),
    scheduledEndAt: scheduledBlockStartUtc(options.scheduledDate, options.group.blockEndTime, timeZone),
    scheduledTeacherEmail: teacher?.email || null,
    scheduledTeacherName: displayName(teacher),
    now: options.now,
  }, options.dbInstance);
}

export async function expireScheduledClassConflictsForSchool(options: {
  schoolId: string;
  scheduledDate: string;
  currentTimeHHMM: string;
  dbInstance?: typeof db;
}): Promise<ClasspilotScheduledConflict[]> {
  const dbInstance = options.dbInstance;
  const conflicts = await listActiveScheduledClassConflictsReadyToExpire(
    options.schoolId,
    options.scheduledDate,
    options.currentTimeHHMM,
    dbInstance
  );
  const expired: ClasspilotScheduledConflict[] = [];
  for (const conflict of conflicts) {
    const updated = await expireScheduledClassConflict({ conflict, dbInstance });
    if (updated) expired.push(updated);
  }
  return expired;
}
