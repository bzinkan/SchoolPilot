import type db from "../db.js";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import {
  isClasspilotStaffUserConnected,
  type ClasspilotStaffPresenceStore,
} from "../realtime/classpilotStaffPresence.js";
import type { ClasspilotScheduledConflict, Group, TeachingSession } from "../schema/classpilot.js";
import type { Student } from "../schema/students.js";
import { localDateInTimeZone } from "../util/schoolTime.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  dispatchDueClasspilotSessionSummaries,
  finalizeClasspilotSession,
  pushClasspilotSessionControlStates,
  runClasspilotFinalizationSideEffects,
} from "./classpilotSessionLifecycle.js";
import { syncClasspilotControlStatesToActiveDevices } from "./classpilotControlStateDelivery.js";
import {
  getApprovedScheduleChangeLegsForSchoolDate,
  getEffectiveClasspilotScheduleWindow,
  lockAndLoadEffectiveClasspilotScheduleContext,
} from "./classpilotScheduleChanges.js";
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
  getInstructionalDateStatus,
  getScheduledClassConflictByIdAndSchool,
  getScheduledClassConflictForSlot,
  getScheduledGroupsReadyToStart,
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
  withInstructionalCalendarDateLock,
  withTeachingSessionStartLock,
  type FinalizeTeachingSessionResult,
} from "./storage.js";

export type ScheduledClassAutoStartResult =
  | { status: "started"; session: TeachingSession }
  | { status: "coverage_needed"; conflictId: string }
  | { status: "claimed"; conflictId: string }
  | { status: "skipped"; reason: string };

type ScheduledOccurrencePreparation =
  | { occurrence: TeachingSession; group?: Group }
  | { reason: "non_instructional_day" | "missing_schedule_window" | "outside_schedule_window" | "skipped" };

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

function occurrenceTimeHHMM(value: Date, timeZone: string): string {
  return value.toLocaleString("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(/^24:/, "00:");
}

export type ClasspilotScheduleRuntimeMetric =
  | "EffectiveWindowResolved"
  | "EffectiveWindowResolutionFailure"
  | "OriginalWindowStartDenied"
  | "ScheduleChangePartialPair"
  | "ScheduleChangeExecutionInvalid"
  | "SwappedOccurrenceStarted";

/** Emit only fixed-name, count-only schedule runtime metrics. */
export function emitClasspilotScheduleRuntimeMetric(
  metricName: ClasspilotScheduleRuntimeMetric,
  count = 1,
  now = new Date()
): void {
  if (!Number.isFinite(count) || count <= 0) return;
  console.log(JSON.stringify({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot",
        Dimensions: [["Environment"]],
        Metrics: [{ Name: metricName, Unit: "Count" }],
      }],
    },
    Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    [metricName]: count,
  }));
}

function emitEffectiveWindowFailure(error?: unknown): void {
  if ((error as { code?: string } | undefined)?.code === "SCHEDULE_CHANGE_EXECUTION_INVALID") {
    emitClasspilotScheduleRuntimeMetric("ScheduleChangeExecutionInvalid");
  }
  emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolutionFailure");
}

function assertCompleteApprovedSwapContext(context: {
  effectiveLeg?: unknown;
  lockedGroupIds: string[];
}): void {
  if (!context.effectiveLeg || context.lockedGroupIds.length === 2) return;
  emitClasspilotScheduleRuntimeMetric("ScheduleChangePartialPair");
  emitClasspilotScheduleRuntimeMetric("ScheduleChangeExecutionInvalid");
  emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolutionFailure");
  throw Object.assign(new Error("The approved schedule change is incomplete."), {
    code: "SCHEDULE_CHANGE_EXECUTION_INVALID",
    status: 409,
  });
}

/**
 * Candidate selection deliberately overlays approved schedule-change legs in
 * one batch. The authoritative single-group resolver is called again under the
 * school/date lock before an occurrence is created, so approval/cancellation
 * races still have one deterministic winner.
 */
export async function getClasspilotGroupsReadyAtEffectiveWindow(options: {
  schoolId: string;
  scheduledDate: string;
  currentTimeHHMM: string;
  dbInstance?: typeof db;
}): Promise<Group[]> {
  let baseCandidates: Group[];
  let approvedLegs: Awaited<ReturnType<typeof getApprovedScheduleChangeLegsForSchoolDate>>;
  try {
    [baseCandidates, approvedLegs] = await Promise.all([
      getScheduledGroupsReadyToStart(
        options.schoolId,
        options.currentTimeHHMM,
        options.scheduledDate,
        options.dbInstance
      ),
      getApprovedScheduleChangeLegsForSchoolDate({
        schoolId: options.schoolId,
        scheduledDate: options.scheduledDate,
        dbInstance: options.dbInstance,
      }),
    ]);
  } catch (error) {
    emitEffectiveWindowFailure(error);
    throw error;
  }
  const candidatesById = new Map(baseCandidates.map((group) => [group.id, group]));
  const approvedLegCounts = new Map<string, number>();
  for (const leg of approvedLegs) {
    approvedLegCounts.set(leg.swapId, (approvedLegCounts.get(leg.swapId) || 0) + 1);
  }
  const partialPairCount = Array.from(approvedLegCounts.values())
    .filter((count) => count !== 2).length;
  if (partialPairCount > 0) {
    emitClasspilotScheduleRuntimeMetric("ScheduleChangePartialPair", partialPairCount);
    emitClasspilotScheduleRuntimeMetric("ScheduleChangeExecutionInvalid", partialPairCount);
    emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolutionFailure", partialPairCount);
    throw Object.assign(new Error("One or more approved schedule changes are incomplete."), {
      code: "SCHEDULE_CHANGE_EXECUTION_INVALID",
      status: 409,
    });
  }
  await Promise.all(approvedLegs.map(async (leg) => {
    if (candidatesById.has(leg.groupId)) return;
    const group = await getGroupByIdAndSchool(
      leg.groupId,
      options.schoolId,
      options.dbInstance
    );
    if (group) candidatesById.set(group.id, group);
  }));
  const approvedByGroupId = new Map(approvedLegs.map((leg) => [leg.groupId, leg]));
  return Array.from(candidatesById.values())
    .filter((group) => {
      if (
        group.status !== "active"
        || !group.scheduleEnabled
        || !group.blockStartTime
        || !group.blockEndTime
        || group.scheduleSkippedDate === options.scheduledDate
      ) return false;
      const leg = approvedByGroupId.get(group.id);
      const start = leg?.effectiveStartTime || group.blockStartTime!;
      const end = leg?.effectiveEndTime || group.blockEndTime!;
      return start <= options.currentTimeHHMM && end > options.currentTimeHHMM;
    })
    .sort((left, right) => {
      const leftStart = approvedByGroupId.get(left.id)?.effectiveStartTime || left.blockStartTime!;
      const rightStart = approvedByGroupId.get(right.id)?.effectiveStartTime || right.blockStartTime!;
      return leftStart.localeCompare(rightStart) || left.id.localeCompare(right.id);
    });
}

/**
 * Linearize the instructional-calendar decision with canonical occurrence
 * creation. Calendar saves use the same school/date advisory transaction lock,
 * so whichever transaction wins becomes authoritative for this block:
 * an existing occurrence remains frozen, while a newly closed date cannot
 * acquire an occurrence, coverage request, or summary outbox row.
 */
async function prepareScheduledOccurrence(options: {
  group: Group;
  scheduledDate: string;
  now: Date;
  dbInstance?: typeof db;
}): Promise<ScheduledOccurrencePreparation> {
  return withInstructionalCalendarDateLock(
    options.group.schoolId,
    options.scheduledDate,
    async (lockedDb) => {
      const existing = await getScheduledTeachingSessionOccurrence(
        options.group.schoolId,
        options.group.id,
        options.scheduledDate,
        lockedDb
      );
      if (existing) return { occurrence: existing };

      // Approval/cancellation owns the date lock first, while class mutations
      // own group locks. Lock the target (and both approved swap groups) in a
      // deterministic order, then discard the caller's potentially stale row.
      let context: Awaited<ReturnType<typeof lockAndLoadEffectiveClasspilotScheduleContext>>;
      try {
        context = await lockAndLoadEffectiveClasspilotScheduleContext({
          schoolId: options.group.schoolId,
          groupId: options.group.id,
          scheduledDate: options.scheduledDate,
          dbInstance: lockedDb,
        });
      } catch (error) {
        emitEffectiveWindowFailure(error);
        throw error;
      }
      if (!context) return { reason: "missing_schedule_window" as const };
      assertCompleteApprovedSwapContext(context);
      if (context.group.scheduleSkippedDate === options.scheduledDate) {
        return { reason: "skipped" as const };
      }
      if (
        context.group.status !== "active"
        || !context.group.scheduleEnabled
        || !context.group.blockStartTime
        || !context.group.blockEndTime
      ) {
        return { reason: "missing_schedule_window" as const };
      }

      // This read deliberately happens only after the shared advisory lock and
      // authoritative group locks are held, in the occurrence transaction.
      const calendarStatus = await getInstructionalDateStatus(
        options.group.schoolId,
        options.scheduledDate,
        lockedDb
      );
      if (!calendarStatus.instructional) {
        return { reason: "non_instructional_day" as const };
      }

      const scheduledTimezone = context.schoolTimezone;
      // A timezone edit racing candidate discovery cannot freeze an occurrence
      // under the wrong local date. The next scheduler tick will use the newly
      // authoritative date and timezone.
      if (localDateInTimeZone(options.now, scheduledTimezone) !== options.scheduledDate) {
        return { reason: "outside_schedule_window" as const };
      }

      let effectiveWindow: Awaited<ReturnType<typeof getEffectiveClasspilotScheduleWindow>>;
      try {
        effectiveWindow = await getEffectiveClasspilotScheduleWindow({
          schoolId: options.group.schoolId,
          group: context.group,
          scheduledDate: options.scheduledDate,
          timeZone: scheduledTimezone,
          dbInstance: lockedDb,
        });
      } catch (error) {
        emitEffectiveWindowFailure(error);
        throw error;
      }
      if (!effectiveWindow) {
        emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolutionFailure");
        return { reason: "missing_schedule_window" as const };
      }
      if (effectiveWindow.source === "swap") {
        emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolved");
      }
      if (
        options.now < effectiveWindow.scheduledStartAt
        || options.now >= effectiveWindow.scheduledEndAt
      ) {
        return { reason: "outside_schedule_window" as const };
      }

      const scheduledTeacher = await getUserById(context.group.teacherId, lockedDb);
      const occurrence = await createOrReuseScheduledReportSession({
        schoolId: options.group.schoolId,
        groupId: context.group.id,
        teacherId: context.group.teacherId,
        scheduledDate: options.scheduledDate,
        scheduledTimezone: effectiveWindow.timeZone,
        scheduledStartAt: effectiveWindow.scheduledStartAt,
        scheduledEndAt: effectiveWindow.scheduledEndAt,
        scheduledTeacherEmail: scheduledTeacher?.email || null,
        scheduledTeacherName: displayName(scheduledTeacher),
      }, lockedDb);
      return { occurrence, group: context.group };
    },
    options.dbInstance
  );
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
    const rosterStudent = row.student
      ? safeStudent(row.student)
      : {
          studentId: row.studentId,
          studentName: "studentNameSnapshot" in row && row.studentNameSnapshot
            ? row.studentNameSnapshot
            : row.studentId,
        };
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
      if (entry.students.length < 5) entry.students.push(rosterStudent);
      continue;
    }

    if (isOnline) {
      claimableStudents.push(rosterStudent);
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
  if (outcome.wasPromoted && outcome.session.scheduledDate) {
    try {
      const approvedLegs = await getApprovedScheduleChangeLegsForSchoolDate({
        schoolId: options.group.schoolId,
        scheduledDate: outcome.session.scheduledDate,
        dbInstance: options.dbInstance,
      });
      if (approvedLegs.some((leg) => leg.groupId === outcome.session.groupId)) {
        emitClasspilotScheduleRuntimeMetric("SwappedOccurrenceStarted");
      }
    } catch (error) {
      // The live transition is already committed; observability must never
      // turn a successful class start into an API/scheduler failure.
      emitEffectiveWindowFailure(error);
    }
  }
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
  void pushClasspilotSessionControlStates(options.group.schoolId, outcome.session.id).catch((error) => {
    console.warn(`[ClassPilot] Scheduled classroom-state push failed for ${outcome.session.id}:`, error);
  });
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
  wasPromoted: boolean;
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
  return {
    session,
    wasPromoted: !!promotedSession,
    finalizations,
    resolvedConflictIds,
  };
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
  let group = options.group;
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
    if (group.scheduleSkippedDate === options.scheduledDate) {
      return { status: "skipped", reason: "skipped" };
    }
    let effectiveWindow: Awaited<ReturnType<typeof getEffectiveClasspilotScheduleWindow>>;
    try {
      effectiveWindow = await getEffectiveClasspilotScheduleWindow({
        schoolId: group.schoolId,
        group,
        scheduledDate: options.scheduledDate,
        timeZone,
        dbInstance,
      });
    } catch (error) {
      emitEffectiveWindowFailure(error);
      throw error;
    }
    if (!effectiveWindow) return { status: "skipped", reason: "missing_schedule_window" };
    blockStartTime = effectiveWindow.blockStartTime;
    blockEndTime = effectiveWindow.blockEndTime;
    if (now < effectiveWindow.scheduledStartAt || now >= effectiveWindow.scheduledEndAt) {
      return { status: "skipped", reason: "outside_schedule_window" };
    }
    const prepared = await prepareScheduledOccurrence({
      group,
      scheduledDate: options.scheduledDate,
      now,
      dbInstance,
    });
    if ("reason" in prepared) {
      return { status: "skipped", reason: prepared.reason };
    }
    occurrence = prepared.occurrence;
    group = prepared.group || group;
  }
  if (occurrence.scheduledStartAt && occurrence.scheduledEndAt) {
    const occurrenceTimeZone = occurrence.scheduledTimezone || timeZone;
    blockStartTime = occurrenceTimeHHMM(occurrence.scheduledStartAt, occurrenceTimeZone);
    blockEndTime = occurrenceTimeHHMM(occurrence.scheduledEndAt, occurrenceTimeZone);
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
  if (conflictResult.restoredStudentIds.length > 0) {
    await syncClasspilotControlStatesToActiveDevices(
      group.schoolId,
      conflictResult.restoredStudentIds
    );
  }
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
  const released = await releaseScheduledConflictSupervision({
    schoolId: options.conflict.schoolId,
    scheduledConflictId: options.conflict.id,
    releaseReason: options.releaseReason,
  }, dbInstance);
  await syncClasspilotControlStatesToActiveDevices(
    options.conflict.schoolId,
    released.map((row) => row.studentId)
  );
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
  const now = options.now || new Date();
  const dbInstance = options.dbInstance;
  const school = await getSchoolById(group.schoolId, dbInstance);
  const timeZone = school?.schoolTimezone || "America/New_York";
  const scheduledDate = localDateInTimeZone(now, timeZone);
  let prepared = await prepareScheduledOccurrence({
    group,
    scheduledDate,
    now,
    dbInstance,
  });
  if ("reason" in prepared && prepared.reason === "outside_schedule_window") {
    const currentSchool = await getSchoolById(group.schoolId, dbInstance);
    const currentTimezone = currentSchool?.schoolTimezone || "America/New_York";
    const currentScheduledDate = localDateInTimeZone(now, currentTimezone);
    if (currentScheduledDate !== scheduledDate) {
      prepared = await prepareScheduledOccurrence({
        group,
        scheduledDate: currentScheduledDate,
        now,
        dbInstance,
      });
    }
  }
  return "occurrence" in prepared ? prepared.occurrence : undefined;
}

export async function skipScheduledClassBeforeStart(options: {
  group: Group;
  scheduledDate: string;
  now?: Date;
  dbInstance?: typeof db;
}): Promise<{
  skipped: boolean;
  session?: TeachingSession;
  reason?: "non_instructional_day" | "school_date_changed";
}> {
  const now = options.now ?? new Date();
  return withInstructionalCalendarDateLock(
    options.group.schoolId,
    options.scheduledDate,
    async (lockedDb) => {
      const existing = await getScheduledTeachingSessionOccurrence(
        options.group.schoolId,
        options.group.id,
        options.scheduledDate,
        lockedDb
      );
      if (existing) {
        return { skipped: existing.scheduledState === "skipped", session: existing };
      }
      let context: Awaited<ReturnType<typeof lockAndLoadEffectiveClasspilotScheduleContext>>;
      try {
        context = await lockAndLoadEffectiveClasspilotScheduleContext({
          schoolId: options.group.schoolId,
          groupId: options.group.id,
          scheduledDate: options.scheduledDate,
          dbInstance: lockedDb,
        });
      } catch (error) {
        emitEffectiveWindowFailure(error);
        throw error;
      }
      if (!context) return { skipped: false };
      assertCompleteApprovedSwapContext(context);
      if (
        context.group.status !== "active"
        || !context.group.scheduleEnabled
        || !context.group.blockStartTime
        || !context.group.blockEndTime
      ) return { skipped: false };
      const calendarStatus = await getInstructionalDateStatus(
        options.group.schoolId,
        options.scheduledDate,
        lockedDb
      );
      if (!calendarStatus.instructional) {
        return { skipped: false, reason: "non_instructional_day" as const };
      }
      const timeZone = context.schoolTimezone;
      if (localDateInTimeZone(now, timeZone) !== options.scheduledDate) {
        return { skipped: false, reason: "school_date_changed" as const };
      }
      let effectiveWindow: Awaited<ReturnType<typeof getEffectiveClasspilotScheduleWindow>>;
      try {
        effectiveWindow = await getEffectiveClasspilotScheduleWindow({
          schoolId: options.group.schoolId,
          group: context.group,
          scheduledDate: options.scheduledDate,
          timeZone,
          dbInstance: lockedDb,
        });
      } catch (error) {
        emitEffectiveWindowFailure(error);
        throw error;
      }
      if (!effectiveWindow) {
        emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolutionFailure");
        return { skipped: false };
      }
      if (effectiveWindow.source === "swap") {
        emitClasspilotScheduleRuntimeMetric("EffectiveWindowResolved");
      }
      const teacher = await getUserById(context.group.teacherId, lockedDb);
      return skipScheduledTeachingSessionOccurrence({
        schoolId: options.group.schoolId,
        groupId: context.group.id,
        teacherId: context.group.teacherId,
        scheduledDate: options.scheduledDate,
        scheduledTimezone: effectiveWindow.timeZone,
        scheduledStartAt: effectiveWindow.scheduledStartAt,
        scheduledEndAt: effectiveWindow.scheduledEndAt,
        scheduledTeacherEmail: teacher?.email || null,
        scheduledTeacherName: displayName(teacher),
        now,
      }, lockedDb);
    },
    options.dbInstance
  );
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
