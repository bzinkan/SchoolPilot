import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import db from "../db.js";
import { schools, schoolMemberships, users } from "../schema/core.js";
import { students } from "../schema/students.js";
import { settings, auditLogs } from "../schema/shared.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { groups, groupStudents, groupTeachers, teachingSessions, classpilotSessionStaff, classpilotSessionStudents,
  classpilotScheduleChanges, classpilotScheduleChangeLegs, classpilotTodayChanges, classpilotTodayOccurrences,
  classpilotSupervisionContexts, classpilotSupervisionStudents, type ClasspilotTodayChange } from "../schema/classpilot.js";
import { isClasspilotTodayScheduleEnabled } from "../config/classpilotTodaySchedule.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { getSchoolSchedulingContext } from "./classpilotScheduling.js";
import { datePlusDays, isSchedulingDate, resolveClassBaseWindow, resolveSchoolScheduleDay } from "./classpilotSchedulingRules.js";
import { isScheduleProfileBlockCancelled } from "./classpilotScheduleProfileModel.js";
import { scheduleProfileWindowHasFullMonitoring } from "./classpilotScheduleProfileValidation.js";
import { getApprovedScheduleChangeLegsForSchoolDate, broadcastClasspilotScheduleChangeUpdate,
  announceClasspilotScheduleChangeIds } from "./classpilotScheduleChanges.js";
import { loadClasspilotTodayOccurrences } from "./classpilotTodayOccurrences.js";
import { assertTodayScheduleWriteContract } from "./classpilotTodayScheduleContract.js";
import { applyClasspilotTodayTransitions, lockClasspilotTodayTransitionStudents } from "./classpilotTodayTransitions.js";
import { classpilotTeachingSessionDeadline, classpilotTeachingSessionIsCurrent } from "./classpilotTeachingSessionWindow.js";
import { withClasspilotSchedulePostCommitTransaction, lockInstructionalCalendarDate,
  getHeartbeatTrackingSettingsForSchool } from "./storage.js";
import { pushClasspilotSessionControlStates, runClasspilotFinalizationSideEffects } from "./classpilotSessionLifecycle.js";
import { buildTodaySchedulePlan, reciprocalTodayCandidates, sameTodayRoster, signTodayScheduleReview,
  todayPlanReviewIdentity, todayScheduleDigest, todayScheduleError, todayWindowOverlaps,
  verifyTodayScheduleReview, type TodayClass, type TodayMeeting, type TodayReviewClaims,
  type TodayScheduleInput, type TodaySchedulePlan, type TodayScheduleBlocker } from "./classpilotTodayScheduleModel.js";

type Database = typeof db;
type RequestContext = { schoolId: string; actorId: string; now?: Date; dbInstance?: Database };
const MAX_CLASSES = 500;
const MAX_RELATIONS = 100_000;
const REVIEW_TTL_MS = 5 * 60_000;
function fail(message: string, code?: string, status?: number): never { throw todayScheduleError(message, code, status); }

function bounded<T>(rows: T[], limit: number): T[] {
  if (rows.length > limit) fail("Today's schedule is too large to review safely. Ask an administrator.", "TODAY_SCHEDULE_ANALYSIS_LIMIT");
  return rows;
}
function staffName(user: { firstName: string | null; lastName: string | null; email: string }) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
}
async function access(schoolId: string, actorId: string, database: Database, lock = false) {
  const membershipQuery = database.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId),
    eq(schoolMemberships.userId, actorId), eq(schoolMemberships.status, "active")));
  const memberships = lock ? await membershipQuery.for("share") : await membershipQuery;
  const admin = memberships.some(row => row.role === "admin" || row.role === "school_admin");
  if (!admin && !memberships.some(row => row.role === "teacher")) fail("Active teaching membership required.", "TODAY_SCHEDULE_FORBIDDEN", 403);
  const policyQuery = database.select({ allowed: settings.allowTeacherManualToday }).from(settings).where(eq(settings.schoolId, schoolId));
  const [policy] = lock ? await policyQuery.for("update") : await policyQuery;
  if (!policy) fail("School scheduling settings are unavailable.", "TODAY_SCHEDULE_UNAVAILABLE", 503);
  return { admin, permissionSettingEnabled: policy.allowed, allowed: admin || policy.allowed };
}

async function facts(options: RequestContext, database: Database, now: Date) {
  const [school] = await database.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId));
  if (!school) fail("School not found.", "TODAY_SCHEDULE_NOT_FOUND", 404);
  const timeZone = school.timezone || "America/New_York";
  const schoolDate = localDateInTimeZone(now, timeZone);
  const [context, classRows, staffRows, permission] = await Promise.all([
    getSchoolSchedulingContext(options.schoolId, database),
    database.select().from(groups).where(and(eq(groups.schoolId, options.schoolId), eq(groups.status, "active"),
      eq(groups.groupType, "admin_class"), eq(groups.scheduleEnabled, true))).orderBy(groups.id).limit(MAX_CLASSES + 1),
    database.select({ user: users }).from(users).innerJoin(schoolMemberships, and(eq(schoolMemberships.userId, users.id),
      eq(schoolMemberships.schoolId, options.schoolId), eq(schoolMemberships.status, "active"),
      inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"]))).orderBy(users.id),
    access(options.schoolId, options.actorId, database),
  ]);
  bounded(classRows, MAX_CLASSES);
  const groupIds = classRows.map(row => row.id);
  const [roster, coTeachers, sessions, latest, approved, legacy, supervision, supervised] = await Promise.all([
    groupIds.length ? database.select({ groupId: groupStudents.groupId, studentId: groupStudents.studentId, status: students.status })
      .from(groupStudents).leftJoin(students, and(eq(students.id, groupStudents.studentId), eq(students.schoolId, options.schoolId)))
      .innerJoin(groups, and(eq(groups.id, groupStudents.groupId), eq(groups.schoolId, options.schoolId)))
      .where(inArray(groupStudents.groupId, groupIds)).orderBy(groupStudents.groupId, students.id).limit(MAX_RELATIONS + 1) : [],
    groupIds.length ? database.select().from(groupTeachers).innerJoin(groups, and(eq(groups.id, groupTeachers.groupId),
      eq(groups.schoolId, options.schoolId))).where(inArray(groupTeachers.groupId, groupIds)).limit(MAX_RELATIONS + 1) : [],
    database.select().from(teachingSessions).where(and(eq(teachingSessions.schoolId, options.schoolId),
      or(eq(teachingSessions.scheduledDate, schoolDate), isNull(teachingSessions.endTime)))).orderBy(teachingSessions.id).limit(2_001),
    loadClasspilotTodayOccurrences({ schoolId: options.schoolId, scheduledDate: schoolDate, dbInstance: database }),
    getApprovedScheduleChangeLegsForSchoolDate({ schoolId: options.schoolId, scheduledDate: schoolDate, dbInstance: database }),
    database.select({ change: classpilotScheduleChanges, leg: classpilotScheduleChangeLegs }).from(classpilotScheduleChanges)
      .innerJoin(classpilotScheduleChangeLegs, and(eq(classpilotScheduleChangeLegs.schoolId, options.schoolId),
        eq(classpilotScheduleChangeLegs.scheduleChangeId, classpilotScheduleChanges.id)))
      .where(and(eq(classpilotScheduleChanges.schoolId, options.schoolId), eq(classpilotScheduleChanges.scheduledDate, schoolDate),
        inArray(classpilotScheduleChanges.status, ["pending_counterpart", "pending_admin", "approved"]))).orderBy(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.id).limit(2_001),
    database.select().from(classpilotSupervisionContexts).where(and(eq(classpilotSupervisionContexts.schoolId, options.schoolId),
      eq(classpilotSupervisionContexts.status, "active"))).orderBy(classpilotSupervisionContexts.id).limit(MAX_CLASSES + 1),
    database.select().from(classpilotSupervisionStudents).where(and(eq(classpilotSupervisionStudents.schoolId, options.schoolId),
      isNull(classpilotSupervisionStudents.releasedAt))).orderBy(classpilotSupervisionStudents.contextId, classpilotSupervisionStudents.studentId).limit(MAX_RELATIONS + 1),
  ]);
  bounded(roster, MAX_RELATIONS); bounded(coTeachers, MAX_RELATIONS); bounded(sessions, 2_000);
  bounded(legacy, 2_000); bounded(supervision, MAX_CLASSES); bounded(supervised, MAX_RELATIONS);
  const sessionIds = sessions.map(row => row.id);
  const [sessionStaff, sessionStudents] = await Promise.all([
    sessionIds.length ? database.select().from(classpilotSessionStaff).where(and(eq(classpilotSessionStaff.schoolId, options.schoolId),
      inArray(classpilotSessionStaff.teachingSessionId, sessionIds))).orderBy(classpilotSessionStaff.teachingSessionId, classpilotSessionStaff.staffId).limit(MAX_RELATIONS + 1) : [],
    sessionIds.length ? database.select({ sessionId: classpilotSessionStudents.teachingSessionId, studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents).where(and(eq(classpilotSessionStudents.schoolId, options.schoolId),
        inArray(classpilotSessionStudents.teachingSessionId, sessionIds))).orderBy(classpilotSessionStudents.teachingSessionId, classpilotSessionStudents.studentId).limit(MAX_RELATIONS + 1) : [],
  ]);
  bounded(sessionStaff, MAX_RELATIONS); bounded(sessionStudents, MAX_RELATIONS);
  const staffById = new Map(staffRows.map(({ user }) => [user.id, staffName(user)]));
  const approvedByGroup = new Map(approved.map(row => [row.groupId, row]));
  const classes: TodayClass[] = [];
  for (const group of classRows) {
    const members = roster.filter(row => row.groupId === group.id);
    const staffIds = [...new Set([group.teacherId, ...coTeachers.filter(row => row.group_teachers.groupId === group.id)
      .map(row => row.group_teachers.teacherId)])].sort();
    const entry: TodayClass = { groupId: group.id, name: group.name, primaryTeacherId: group.teacherId,
      primaryTeacherName: staffById.get(group.teacherId) || "Teacher", studentIds: members.map(row => row.studentId),
      staffIds, rosterValid: members.length > 0 && members.length <= 500 && members.every(row => row.status === "active")
        && staffById.has(group.teacherId), meetings: [] };
    const saved = latest.get(group.id);
    const sourceWindows: Array<{ key: string; source: string; startsAt: Date; endsAt: Date; occurrenceId: string | null; legacySessionId?: string }> = [];
    if (saved) {
      for (const row of saved) if (row.kind === "meeting" && row.scheduledStartAt && row.scheduledEndAt)
        sourceWindows.push({ key: `today:${row.id}`, source: "today", startsAt: row.scheduledStartAt,
          endsAt: row.scheduledEndAt, occurrenceId: typeof row.source.preservedLegacySessionId === "string" ? null
            : typeof row.source.preservedOccurrenceId === "string" ? row.source.preservedOccurrenceId : row.id,
          ...(typeof row.source.preservedLegacySessionId === "string" ? { legacySessionId: row.source.preservedLegacySessionId } : {}) });
      // Suppression remains authoritative for automatic execution. Its original
      // slot is offered only as an explicit, newly reviewed recovery candidate.
      for (const row of saved) if (row.kind === "suppression") {
        const recorded = sessions.find(session => session.groupId === group.id && session.scheduledDate === schoolDate && !session.scheduledOccurrenceId);
        const base = resolveClassBaseWindow(group, schoolDate, context.config, context.calendar);
        const originalStart = typeof row.source.originalStartsAt === "string" ? new Date(row.source.originalStartsAt) : recorded?.scheduledStartAt
          ?? (base ? localDateTimeUtc(schoolDate, base.startTime, timeZone) : null);
        const originalEnd = typeof row.source.originalEndsAt === "string" ? new Date(row.source.originalEndsAt) : recorded?.scheduledEndAt
          ?? (base ? localDateTimeUtc(schoolDate, base.endTime, timeZone) : null);
        if (originalStart && originalEnd && Number.isFinite(originalStart.getTime()) && originalEnd > originalStart)
          sourceWindows.push({ key: `suppression:${row.id}`, source: "suppression", startsAt: originalStart,
            endsAt: originalEnd, occurrenceId: row.id });
      }
    } else {
      const recorded = sessions.find(row => row.groupId === group.id && row.scheduledDate === schoolDate && !row.scheduledOccurrenceId);
      let startsAt = recorded?.scheduledStartAt, endsAt = recorded?.scheduledEndAt;
      if (!startsAt || !endsAt) {
        const base = resolveClassBaseWindow(group, schoolDate, context.config, context.calendar);
        const leg = approvedByGroup.get(group.id);
        if (base) {
          startsAt = localDateTimeUtc(schoolDate, leg?.effectiveStartTime ?? base.startTime, timeZone);
          endsAt = localDateTimeUtc(schoolDate, leg?.effectiveEndTime ?? base.endTime, timeZone);
        }
      }
      if (startsAt && endsAt) sourceWindows.push({ key: recorded ? `legacy:${recorded.id}` : `base:${group.id}:${schoolDate}:${startsAt.toISOString()}:${endsAt.toISOString()}`,
        source: approvedByGroup.has(group.id) ? "swap" : "recurring", startsAt, endsAt, occurrenceId: null });
    }
    for (const item of sourceWindows) {
      const session = sessions.find(row => row.groupId === group.id && row.scheduledDate === schoolDate
        && (item.legacySessionId ? row.id === item.legacySessionId : item.occurrenceId ? row.scheduledOccurrenceId === item.occurrenceId : !row.scheduledOccurrenceId));
      const state = item.source === "suppression" ? group.scheduleManualDate === schoolDate ? "manual" : "skipped"
        : !saved && group.scheduleManualDate === schoolDate ? "manual"
        : session?.scheduledState === "skipped" || !saved && group.scheduleSkippedDate === schoolDate ? "skipped"
          : session?.endTime ? "ended" : item.startsAt > now ? "future" : item.endsAt > now ? "current" : "ended";
      entry.meetings.push({ groupId: group.id, name: group.name, teacherId: group.teacherId,
        teacherName: entry.primaryTeacherName, startsAt: item.startsAt.toISOString(), endsAt: item.endsAt.toISOString(),
        key: item.key, source: item.source, state, sessionId: session?.id ?? null, scheduledOccurrenceId: item.occurrenceId });
    }
    classes.push(entry);
  }
  const fingerprint = todayScheduleDigest({ schoolDate, timeZone, revision: context.revision, config: context.config,
    calendar: context.calendar, permission: permission.permissionSettingEnabled, classes,
    sessions: sessions.map(session => ({ id: session.id, groupId: session.groupId, teacherId: session.teacherId,
      sessionMode: session.sessionMode, startTime: session.startTime, endTime: session.endTime,
      scheduledDate: session.scheduledDate, scheduledOccurrenceId: session.scheduledOccurrenceId,
      scheduledStartAt: session.scheduledStartAt, scheduledEndAt: session.scheduledEndAt, manualExpiresAt: session.manualExpiresAt,
      rosterSnapshotCompletedAt: session.rosterSnapshotCompletedAt })), sessionStaff, sessionStudents,
    legacy: legacy.map(row => ({ id: row.change.id, revision: row.change.revision, status: row.change.status, leg: row.leg })),
    supervision, supervised });
  return { schoolDate, timeZone, context, permission, classes, sessions, sessionStaff, sessionStudents,
    latest, legacy, supervision, supervised, fingerprint };
}
type Facts = Awaited<ReturnType<typeof facts>>;

function selectMeeting(input: TodayScheduleInput, group: TodayClass, ref: string | undefined,
  options: RequestContext, data: Facts, now: Date, referenceAt = now): TodayMeeting {
  let key: string | undefined;
  if (ref) {
    const claims = verifyTodayScheduleReview(ref, { ...options, purpose: "meeting", now: referenceAt });
    if (claims.scheduledDate !== data.schoolDate) fail("The school date changed. Review today again.", "TODAY_SCHEDULE_DATE_CHANGED");
    key = claims.meetingKey;
  }
  const remaining = group.meetings.filter(meeting => meeting.endsAt > now.toISOString() && (!key || key === meeting.key));
  if (remaining.length !== 1) fail(remaining.length ? "This class has several remaining meetings. Select an exact period."
    : "That meeting has changed or ended. Review today again.", remaining.length ? "TODAY_SCHEDULE_MEETING_AMBIGUOUS" : "TODAY_SCHEDULE_REVIEW_STALE");
  return remaining[0]!;
}

function assertAssigned(group: TodayClass, actorId: string) {
  if (!group.staffIds.includes(actorId)) fail("Choose one of your assigned classes.", "TODAY_SCHEDULE_FORBIDDEN", 403);
  if (!group.rosterValid) fail("This class needs a nonempty saved roster of active students and an active primary teacher.", "TODAY_SCHEDULE_ROSTER_INVALID");
}

function planConflicts(plan: TodaySchedulePlan, data: Facts, now: Date): TodayScheduleBlocker[] {
  const blockers: TodayScheduleBlocker[] = [];
  const affected = new Set(plan.groupIds);
  const byGroup = new Map(data.classes.map(group => [group.groupId, group]));
  const add = (code: string, message: string) => { if (!blockers.some(row => row.code === code && row.message === message)) blockers.push({ code, message }); };
  for (let index = 0; index < plan.after.length; index++) for (const other of plan.after.slice(index + 1)) {
    const candidate = plan.after[index]!;
    if (!todayWindowOverlaps(candidate, other)) continue;
    const first = byGroup.get(candidate.groupId)!, second = byGroup.get(other.groupId)!;
    if (first.staffIds.some(id => second.staffIds.includes(id)) || first.studentIds.some(id => second.studentIds.includes(id)))
      add("TODAY_SCHEDULE_CLASS_CONFLICT", "The proposed periods would assign a student or co-teacher to two classes at once.");
  }
  for (const candidate of plan.after) {
    const group = byGroup.get(candidate.groupId)!;
    for (const other of data.classes) {
      if (affected.has(other.groupId)) continue;
      for (const meeting of other.meetings) {
        if (["ended", "manual", "skipped"].includes(meeting.state) || !todayWindowOverlaps(candidate, meeting)) continue;
        if (group.staffIds.some(id => other.staffIds.includes(id)) || group.studentIds.some(id => other.studentIds.includes(id)))
          add("TODAY_SCHEDULE_CLASS_CONFLICT", `${candidate.name} would overlap ${other.name} for an assigned teacher or student.`);
      }
    }
    for (const session of data.sessions) {
      if (affected.has(session.groupId) || !classpilotTeachingSessionIsCurrent(session, now)) continue;
      const liveWindow = { startsAt: session.startTime.toISOString(), endsAt: classpilotTeachingSessionDeadline(session).toISOString() };
      if (!todayWindowOverlaps(candidate, liveWindow)) continue;
      const staff = data.sessionStaff.filter(row => row.teachingSessionId === session.id).map(row => row.staffId);
      const roster = data.sessionStudents.filter(row => row.sessionId === session.id).map(row => row.studentId);
      if (group.staffIds.some(id => staff.includes(id)) || group.studentIds.some(id => roster.includes(id)))
        add("TODAY_SCHEDULE_LIVE_CONFLICT", "Another live class owns an affected teacher or student. Finish or adjust that class first.");
    }
    for (const context of data.supervision) {
      if (!todayWindowOverlaps(candidate, { startsAt: context.startsAt.toISOString(), endsAt: context.endsAt.toISOString() })) continue;
      const roster = data.supervised.filter(row => row.contextId === context.id).map(row => row.studentId);
      if (group.staffIds.includes(context.assignedStaffId) || group.studentIds.some(id => roster.includes(id)))
        add("TODAY_SCHEDULE_COVERAGE_CONFLICT", "An affected teacher or student has active Coverage. Release or adjust Coverage first.");
    }
    for (const application of data.context.config.profileApplications ?? []) {
      if (application.status !== "scheduled") continue;
      for (const testing of application.testingWindows) {
        if (testing.date !== data.schoolDate || isScheduleProfileBlockCancelled(application, testing.date, testing.blockId)) continue;
        const testingWindow = { startsAt: localDateTimeUtc(testing.date, testing.startTime, data.timeZone).toISOString(),
          endsAt: localDateTimeUtc(testing.date, testing.endTime, data.timeZone).toISOString() };
        if (todayWindowOverlaps(candidate, testingWindow) && (group.staffIds.includes(testing.assignedStaffId)
          || group.studentIds.some(id => testing.studentIds.includes(id))))
          add("TODAY_SCHEDULE_TESTING_CONFLICT", "An affected teacher or student has a testing block. Ask an administrator to adjust it first.");
      }
    }
  }
  for (const id of new Set(data.legacy.filter(row => row.change.status === "approved" && affected.has(row.leg.groupId)).map(row => row.change.id))) {
    if (data.legacy.some(row => row.change.id === id && !affected.has(row.leg.groupId)))
      add("TODAY_SCHEDULE_LEGACY_APPROVED_CONFLICT", "This would replace only part of an approved planned swap. Ask an administrator to resolve the complete swap.");
  }
  return blockers;
}

function requiredAcceptance(plan: TodaySchedulePlan, data: Facts, now: Date) {
  if (!plan.counterpartTeacherId) return null;
  const counterpartGroups = plan.before.filter(row => row.teacherId === plan.counterpartTeacherId).map(row => row.groupId);
  const live = data.sessions.filter(row => counterpartGroups.includes(row.groupId) && classpilotTeachingSessionIsCurrent(row, now));
  if (!live.length) return null;
  if (live.some(session => !data.sessionStaff.some(row => row.teachingSessionId === session.id && row.staffId === plan.counterpartTeacherId)))
    fail("The live class's saved staff no longer matches this period pair. Ask an administrator.", "TODAY_SCHEDULE_LIVE_STAFF_CHANGED");
  return { teacherId: plan.counterpartTeacherId, teacherName: plan.before.find(row => row.teacherId === plan.counterpartTeacherId)!.teacherName,
    liveSessionIds: live.map(row => row.id).sort() };
}

async function preview(options: RequestContext & { input: TodayScheduleInput }, database: Database, now: Date, purpose: "apply" | "accept" = "apply", change?: ClasspilotTodayChange) {
  const data = await facts(options, database, now), input = options.input;
  if (!isSchedulingDate(input.expectedSchoolDate) || input.expectedSchoolDate !== data.schoolDate)
    fail("The school date changed. Review today again.", "TODAY_SCHEDULE_DATE_CHANGED");
  if (!resolveSchoolScheduleDay(data.schoolDate, data.context.config, data.context.calendar).instructional)
    fail("Today is not an instructional date. Ask an administrator to review the school calendar.", "TODAY_SCHEDULE_NON_INSTRUCTIONAL");
  const firstClass = data.classes.find(row => row.groupId === input.currentGroupId);
  if (!firstClass) fail("Assigned scheduled class not found.", "TODAY_SCHEDULE_NOT_FOUND", 404);
  const initiatorId = change?.requestedByUserId ?? options.actorId;
  if (change) {
    const initiatorAccess = await access(options.schoolId, initiatorId, database);
    if (!initiatorAccess.allowed) fail("The requester no longer has permission to change today's periods.", "TODAY_SCHEDULE_REQUESTER_UNAVAILABLE", 403);
  }
  assertAssigned(firstClass, initiatorId);
  const first = selectMeeting(input, firstClass, input.currentMeetingRef, { ...options, actorId: initiatorId }, data, now, change?.createdAt);
  let second: TodayMeeting | undefined;
  let counterpart: ReturnType<typeof reciprocalTodayCandidates>[number] | undefined;
  let eligibleCandidates: Array<{ teacherId: string; teacherName: string }> = [];
  const blockers: TodayScheduleBlocker[] = [];
  if (input.action === "swap") {
    const secondClass = data.classes.find(row => row.groupId === input.selectedGroupId);
    if (!secondClass) fail("Choose a later assigned class.", "TODAY_SCHEDULE_NOT_FOUND", 404);
    assertAssigned(secondClass, initiatorId);
    if (secondClass.primaryTeacherId !== firstClass.primaryTeacherId || !sameTodayRoster(firstClass, firstClass) || !sameTodayRoster(secondClass, secondClass))
      fail("Choose two classes for the same primary teacher with saved student rosters.", "TODAY_SCHEDULE_PERIOD_PAIR_INVALID");
    second = selectMeeting(input, secondClass, input.selectedMeetingRef, { ...options, actorId: initiatorId }, data, now, change?.createdAt);
    const matches = reciprocalTodayCandidates(data.classes, firstClass, secondClass, first, second);
    eligibleCandidates = [...new Map(matches.map(row => [row.teacherId, { teacherId: row.teacherId, teacherName: row.teacherName }])).values()];
    const selected = input.counterpartTeacherId ? matches.filter(row => row.teacherId === input.counterpartTeacherId) : matches;
    if (selected.length === 1) counterpart = selected[0];
    else if (!selected.length) blockers.push({ code: "TODAY_SCHEDULE_RECIPROCAL_PAIR_REQUIRED", message: "No exact reciprocal pair of saved student rosters and period windows was found." });
    else blockers.push({ code: eligibleCandidates.length > 1 && !input.counterpartTeacherId ? "TODAY_SCHEDULE_COUNTERPART_REQUIRED" : "TODAY_SCHEDULE_MEETING_AMBIGUOUS",
      message: eligibleCandidates.length > 1 && !input.counterpartTeacherId ? "Choose the other teacher for this period swap." : "Several saved class entries match this teacher. Ask an administrator to resolve the duplicate periods." });
  }
  if (blockers.length) return { data, plan: null, fingerprint: null, response: {
    schoolDate: data.schoolDate, timeZone: data.timeZone, action: input.action, canApply: false, blockers,
    eligibleCandidates, selectedCounterpartTeacherId: input.counterpartTeacherId ?? null,
    requiresCounterpartSelection: blockers.some(row => row.code === "TODAY_SCHEDULE_COUNTERPART_REQUIRED"),
    before: [], after: [], requiresAcceptance: false, requiredAcceptance: null,
  } };
  const plan = buildTodaySchedulePlan({ input, first, second, counterpart, timeZone: data.timeZone, now });
  const tracking = await getHeartbeatTrackingSettingsForSchool(options.schoolId, database, { bypassCache: true });
  const localTime = (date: string) => new Date(date).toLocaleString("en-GB", { timeZone: data.timeZone,
    hour: "2-digit", minute: "2-digit", hour12: false }).replace(/^24:/, "00:");
  if (plan.after.some(item => !scheduleProfileWindowHasFullMonitoring({ date: data.schoolDate,
    startTime: localTime(item.startsAt), endTime: localTime(item.endsAt) }, tracking)))
    blockers.push({ code: "TODAY_SCHEDULE_MONITORING_UNAVAILABLE", message: "Full classroom monitoring must be available throughout both proposed periods. Ask an administrator to review Monitoring Hours." });
  const ownGroups = new Set(plan.before.filter(row => row.teacherId === plan.initiatorTeacherId).map(row => row.groupId));
  if (data.sessions.some(session => ownGroups.has(session.groupId) && classpilotTeachingSessionIsCurrent(session, now)
    && !data.sessionStaff.some(row => row.teachingSessionId === session.id && row.staffId === initiatorId)))
    blockers.push({ code: "TODAY_SCHEDULE_LIVE_STAFF_CHANGED", message: "Your current assignment is not part of this live class's saved staff. Ask its teacher or an administrator." });
  blockers.push(...planConflicts(plan, data, now));
  const required = requiredAcceptance(plan, data, now);
  const fingerprint = todayScheduleDigest({ facts: data.fingerprint, plan: todayPlanReviewIdentity(plan), required });
  const cutoff = new Date(plan.mode === "before_bell" ? plan.firstStartsAt : plan.firstEndsAt).getTime();
  const expiresAt = new Date(Math.min(now.getTime() + REVIEW_TTL_MS, cutoff)).toISOString();
  const allowed = data.permission.allowed && isClasspilotTodayScheduleEnabled();
  if (!allowed) blockers.push({ code: !isClasspilotTodayScheduleEnabled() ? "TODAY_SCHEDULE_DISABLED" : "TODAY_SCHEDULE_TEACHER_DISABLED",
    message: !isClasspilotTodayScheduleEnabled() ? "Teacher period swaps are not available yet." : "Your administrator must allow teacher period swaps." });
  const claims: TodayReviewClaims = { v: 1, purpose, schoolId: options.schoolId, actorId: options.actorId,
    scheduledDate: data.schoolDate, input, fingerprint, expiresAt: Date.parse(expiresAt),
    ...(change ? { changeId: change.id, revision: change.revision } : {}) };
  return { data, plan, fingerprint, response: { schoolDate: data.schoolDate, timeZone: data.timeZone, action: input.action,
    mode: plan.mode, canApply: blockers.length === 0, blockers, eligibleCandidates,
    selectedCounterpartTeacherId: plan.counterpartTeacherId, requiresCounterpartSelection: false,
    before: plan.before, after: plan.after, requiresAcceptance: !!required, requiredAcceptance: required,
    ...(blockers.length === 0 ? { reviewToken: signTodayScheduleReview(claims), expiresAt } : {}),
    cutoverAt: (plan.mode === "remainder" ? now : new Date(plan.firstStartsAt)).toISOString(),
    currentPeriodEndsAt: plan.firstEndsAt, laterPeriodStartsAt: plan.laterStartsAt, laterPeriodEndsAt: plan.laterEndsAt } };
}

export async function previewClasspilotTodaySchedule(options: RequestContext & { input: TodayScheduleInput }) {
  return (await preview(options, options.dbInstance ?? db, options.now ?? new Date())).response;
}

function storedPlan(change: ClasspilotTodayChange): TodaySchedulePlan {
  const plan = change.planSnapshot;
  if (plan.schemaVersion !== 1 || !["swap", "skip"].includes(String(plan.action)) || !plan.input
    || !Array.isArray(plan.before) || !Array.isArray(plan.after) || !Array.isArray(plan.groupIds))
    fail("This record belongs to an administrator recovery action.", "TODAY_SCHEDULE_NOT_ACTIONABLE");
  return plan as unknown as TodaySchedulePlan;
}

function reviewedLiveSessionIds(change: ClasspilotTodayChange): string[] {
  const review = change.reviewSnapshot.requiredAcceptance;
  if (!review || typeof review !== "object" || Array.isArray(review) || !("liveSessionIds" in review)
    || !Array.isArray(review.liveSessionIds) || !review.liveSessionIds.length || review.liveSessionIds.length > 4
    || !review.liveSessionIds.every((id): id is string => typeof id === "string" && !!id)) return [];
  return [...new Set(review.liveSessionIds)].sort();
}

function answerAuthority(change: ClasspilotTodayChange, actorId: string, sessions: Facts["sessions"],
  staff: Facts["sessionStaff"], now: Date) {
  const ids = reviewedLiveSessionIds(change);
  if (actorId === change.requestedByUserId || !ids.length) return { frozen: false, current: false };
  const reviewedSessions = ids.map(id => sessions.find(session => session.id === id && session.schoolId === change.schoolId
    && change.affectedGroupIds.includes(session.groupId)));
  const frozen = reviewedSessions.every((session, index) => !!session && staff.some(row =>
    row.teachingSessionId === ids[index] && row.staffId === actorId));
  return { frozen, current: frozen && reviewedSessions.every(session => !!session && classpilotTeachingSessionIsCurrent(session, now)) };
}

async function loadAnswerAuthority(change: ClasspilotTodayChange, actorId: string, database: Database, now: Date) {
  const ids = reviewedLiveSessionIds(change);
  if (!ids.length || actorId === change.requestedByUserId) return { frozen: false, current: false };
  const [sessions, staff] = await Promise.all([
    database.select().from(teachingSessions).where(and(eq(teachingSessions.schoolId, change.schoolId), inArray(teachingSessions.id, ids))),
    database.select().from(classpilotSessionStaff).where(and(eq(classpilotSessionStaff.schoolId, change.schoolId),
      inArray(classpilotSessionStaff.teachingSessionId, ids), eq(classpilotSessionStaff.staffId, actorId))),
  ]);
  return answerAuthority(change, actorId, sessions, staff, now);
}

function serializeChange(change: ClasspilotTodayChange, actorId: string, admin: boolean, allowed = true,
  authority = { frozen: false, current: false }) {
  const plan = change.planSnapshot;
  const pending = change.status === "pending";
  return { id: change.id, status: change.status, revision: change.revision, scheduledDate: change.scheduledDate,
    requestedByUserId: change.requestedByUserId, counterpartTeacherId: change.counterpartTeacherId,
    createdAt: change.createdAt.toISOString(), appliedAt: change.appliedAt?.toISOString() ?? null, cutoffAt: change.cutoffAt.toISOString(),
    before: Array.isArray(plan.before) ? plan.before : [], after: Array.isArray(plan.after) ? plan.after.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const window = item as Record<string, unknown>;
      return change.appliedAt && plan.mode === "remainder" && window.endsAt === plan.firstEndsAt
        ? { ...window, startsAt: change.appliedAt.toISOString() } : window;
    }) : [],
    mode: plan.mode ?? null, requiresAcceptance: change.counterpartTeacherId !== null && pending,
    canAccept: pending && authority.current && allowed && isClasspilotTodayScheduleEnabled(),
    canDecline: pending && authority.frozen,
    canCancel: pending && (change.requestedByUserId === actorId || admin) };
}

async function visibleChange(options: RequestContext & { changeId: string }, database: Database, lock = false) {
  const query = database.select().from(classpilotTodayChanges).where(and(eq(classpilotTodayChanges.schoolId, options.schoolId),
    eq(classpilotTodayChanges.id, options.changeId)));
  const [change] = lock ? await query.for("update") : await query;
  const permission = await access(options.schoolId, options.actorId, database);
  if (!change) fail("Schedule change not found.", "TODAY_SCHEDULE_NOT_FOUND", 404);
  const authority = await loadAnswerAuthority(change, options.actorId, database, options.now ?? new Date());
  if (!change || !permission.admin && change.requestedByUserId !== options.actorId && change.counterpartTeacherId !== options.actorId) {
    const assignments = await database.select({ groupId: groupTeachers.groupId }).from(groupTeachers)
      .innerJoin(groups, and(eq(groups.id, groupTeachers.groupId), eq(groups.schoolId, options.schoolId)))
      .where(and(inArray(groupTeachers.groupId, change.affectedGroupIds), eq(groupTeachers.teacherId, options.actorId)));
    const primary = await database.select({ id: groups.id }).from(groups).where(and(eq(groups.schoolId, options.schoolId),
      inArray(groups.id, change.affectedGroupIds), eq(groups.teacherId, options.actorId)));
    if (!assignments.length && !primary.length && !authority.frozen) fail("Schedule change not found.", "TODAY_SCHEDULE_NOT_FOUND", 404);
  }
  return { change, permission, authority };
}

export async function getClasspilotTodaySchedule(options: RequestContext) {
  const database = options.dbInstance ?? db, now = options.now ?? new Date();
  const data = await facts(options, database, now);
  const records = bounded(await database.select().from(classpilotTodayChanges).where(and(eq(classpilotTodayChanges.schoolId, options.schoolId),
    eq(classpilotTodayChanges.scheduledDate, data.schoolDate))).orderBy(classpilotTodayChanges.createdAt).limit(501), 500);
  const own = data.classes.filter(group => group.staffIds.includes(options.actorId));
  const ownIds = new Set(own.map(group => group.groupId));
  const enabled = isClasspilotTodayScheduleEnabled();
  return { enabled, schoolDate: data.schoolDate, timeZone: data.timeZone,
    resumesAt: localDateTimeUtc(datePlusDays(data.schoolDate, 1), "00:00", data.timeZone).toISOString(),
    canRequest: enabled && data.permission.allowed, permissionSettingEnabled: data.permission.permissionSettingEnabled,
    classes: own.map(group => ({ groupId: group.groupId, name: group.name, primaryTeacherId: group.primaryTeacherId,
      primaryTeacherName: group.primaryTeacherName, studentCount: group.studentIds.length,
      meetings: group.meetings.map(meeting => ({ meetingRef: signTodayScheduleReview({ v: 1, purpose: "meeting", schoolId: options.schoolId,
        actorId: options.actorId, scheduledDate: data.schoolDate, meetingKey: meeting.key, expiresAt: now.getTime() + REVIEW_TTL_MS }),
        startsAt: meeting.startsAt, endsAt: meeting.endsAt, state: meeting.state, source: meeting.source })) })),
    changes: records.filter(change => change.requestedByUserId === options.actorId || change.counterpartTeacherId === options.actorId
      || change.affectedGroupIds.some(id => ownIds.has(id)) || answerAuthority(change, options.actorId, data.sessions, data.sessionStaff, now).frozen)
      .map(change => serializeChange(change, options.actorId, data.permission.admin, data.permission.allowed,
        answerAuthority(change, options.actorId, data.sessions, data.sessionStaff, now))) };
}

export async function getClasspilotTodayScheduleChange(options: RequestContext & { changeId: string }) {
  const database = options.dbInstance ?? db;
  const { change, permission, authority } = await visibleChange(options, database);
  let acceptancePreview;
  if (change.status === "pending" && authority.frozen) {
    const plan = storedPlan(change);
    try {
      const reviewed = await preview({ ...options, input: plan.input }, database, options.now ?? new Date(), "accept", change);
      acceptancePreview = reviewed.fingerprint === change.reviewSnapshot.fingerprint ? reviewed.response : {
        ...reviewed.response, canApply: false, reviewToken: undefined, expiresAt: undefined,
        blockers: [...reviewed.response.blockers, { code: "TODAY_SCHEDULE_REVIEW_STALE", message: "This request's schedule or live class changed. Start a new review." }],
      };
    } catch (error) {
      const status = Number((error as { status?: number }).status);
      if (!(status >= 400 && status < 500)) throw error;
      acceptancePreview = { schoolDate: change.scheduledDate, timeZone: change.timezoneSnapshot, action: plan.action,
        mode: plan.mode, canApply: false, blockers: [{ code: "TODAY_SCHEDULE_REVIEW_STALE", message: "This request's authority or schedule changed. Start a new review." }],
        eligibleCandidates: [], selectedCounterpartTeacherId: change.counterpartTeacherId, requiresCounterpartSelection: false,
        before: plan.before, after: plan.after, requiresAcceptance: true, requiredAcceptance: null };
    }
  }
  return { change: serializeChange(change, options.actorId, permission.admin, permission.allowed, authority), ...(acceptancePreview ? { preview: acceptancePreview } : {}) };
}

async function locked<T>(options: RequestContext, operation: (database: Database, now: () => Date) => Promise<T>) {
  return withClasspilotSchedulePostCommitTransaction(async tx => {
    if (!await lockStaffAssignmentLifecycleSchool(tx, options.schoolId)) fail("School not found.", "TODAY_SCHEDULE_NOT_FOUND", 404);
    const database = tx as unknown as Database;
    const now = () => options.now ?? new Date();
    const [school] = await database.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId));
    const date = localDateInTimeZone(now(), school?.timezone || "America/New_York");
    await lockInstructionalCalendarDate(options.schoolId, date, database);
    await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${options.schoolId}`}))`);
    await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    await access(options.schoolId, options.actorId, database, true);
    return operation(database, now);
  }, options.dbInstance ?? db);
}

async function audit(database: Database, schoolId: string, actorId: string, changeId: string, action: string, metadata: Record<string, unknown>) {
  await database.insert(auditLogs).values({ schoolId, userId: actorId, action: `classpilot.today_schedule.${action}`,
    entityType: "classpilot_today_change", entityId: changeId, metadata });
}

async function supersedeOverlaps(database: Database, options: RequestContext, data: Facts, plan: TodaySchedulePlan, now: Date, exceptId: string) {
  const affected = new Set(plan.groupIds);
  const ids = [...new Set(data.legacy.filter(row => affected.has(row.leg.groupId)).map(row => row.change.id))];
  if (ids.length) {
    await database.update(classpilotScheduleChanges).set({ status: "superseded", reservationActive: false,
      terminalByUserId: options.actorId, terminalReason: "replaced_by_today_schedule", terminalAt: now,
      updatedAt: now, revision: sql`${classpilotScheduleChanges.revision} + 1` })
      .where(and(eq(classpilotScheduleChanges.schoolId, options.schoolId), inArray(classpilotScheduleChanges.id, ids)));
    await database.update(classpilotScheduleChangeLegs).set({ reservationActive: false })
      .where(and(eq(classpilotScheduleChangeLegs.schoolId, options.schoolId), inArray(classpilotScheduleChangeLegs.scheduleChangeId, ids)));
    for (const id of ids) await audit(database, options.schoolId, options.actorId, exceptId, "legacy_replaced", { legacyChangeId: id });
  }
  const pending = await database.select().from(classpilotTodayChanges).where(and(eq(classpilotTodayChanges.schoolId, options.schoolId),
    eq(classpilotTodayChanges.scheduledDate, data.schoolDate), eq(classpilotTodayChanges.status, "pending"))).for("update");
  for (const row of pending) if (row.id !== exceptId && row.affectedGroupIds.some(id => affected.has(id))) {
    await database.update(classpilotTodayChanges).set({ status: "superseded", revision: row.revision + 1,
      terminalByUserId: options.actorId, terminalReason: "replaced_by_today_schedule", terminalAt: now, updatedAt: now })
      .where(and(eq(classpilotTodayChanges.schoolId, options.schoolId), eq(classpilotTodayChanges.id, row.id)));
    await audit(database, options.schoolId, options.actorId, row.id, "superseded", { replacementChangeId: exceptId });
  }
  return ids;
}

function assertPlanBoundary(data: Facts, plan: TodaySchedulePlan, now: Date) {
  if (localDateInTimeZone(now, data.timeZone) !== data.schoolDate
    || (plan.mode === "before_bell" ? new Date(plan.firstStartsAt) <= now : new Date(plan.firstEndsAt) <= now))
    fail("The period boundary changed. Review today again.", "TODAY_SCHEDULE_REVIEW_STALE");
}

async function applyPlan(database: Database, options: RequestContext, change: ClasspilotTodayChange, data: Facts, plan: TodaySchedulePlan,
  clock: () => Date, accepted: boolean) {
  const candidateAt = new Date(clock().getTime());
  const selectedSessionIds = new Set(data.classes.flatMap(group => group.meetings)
    .filter(meeting => plan.sourceMeetingKeys.includes(meeting.key) && meeting.sessionId).map(meeting => meeting.sessionId));
  const outgoingSessionIds = data.sessions.filter(row => plan.groupIds.includes(row.groupId) && !row.endTime
    && classpilotTeachingSessionDeadline(row) > candidateAt && (selectedSessionIds.has(row.id)
      || plan.mode === "remainder" && !row.scheduledDate && classpilotTeachingSessionIsCurrent(row, candidateAt))).map(row => row.id);
  await lockClasspilotTodayTransitionStudents({ schoolId: options.schoolId, groupIds: plan.groupIds,
    outgoingSessionIds, dbInstance: database });
  const now = new Date(clock().getTime());
  assertPlanBoundary(data, plan, now);
  const generationRows = await database.select({ generation: sql<number>`COALESCE(MAX(${classpilotTodayOccurrences.generation}), 0) + 1` })
    .from(classpilotTodayOccurrences).where(and(eq(classpilotTodayOccurrences.schoolId, options.schoolId),
      eq(classpilotTodayOccurrences.scheduledDate, data.schoolDate)));
  const generation = Number(generationRows[0]?.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) fail("Today's schedule generation is unavailable.", "TODAY_SCHEDULE_UNAVAILABLE", 503);
  const legacyIds = await supersedeOverlaps(database, options, data, plan, now, change.id);
  const [applied] = await database.update(classpilotTodayChanges).set({ status: "applied", generation: Number(generation),
    revision: change.revision + 1, appliedAt: now, appliedByUserId: options.actorId, updatedAt: now,
    ...(accepted ? { acceptedAt: now, acceptedByUserId: options.actorId } : {}) })
    .where(and(eq(classpilotTodayChanges.schoolId, options.schoolId), eq(classpilotTodayChanges.id, change.id))).returning();
  if (!applied) fail("The request changed before it could apply.", "TODAY_SCHEDULE_REVIEW_STALE");
  const entries = (plan.action === "skip" ? plan.before : plan.after).map(item => ({ ...item, preserved: null as TodayMeeting | null }));
  for (const group of data.classes) if (plan.groupIds.includes(group.groupId)) {
    for (const meeting of group.meetings) if (!plan.sourceMeetingKeys.includes(meeting.key) && meeting.endsAt > now.toISOString()
      && !["skipped", "manual", "ended"].includes(meeting.state)) entries.push({ ...meeting, preserved: meeting });
  }
  const occurrences = await database.insert(classpilotTodayOccurrences).values(entries.map(item => ({ schoolId: options.schoolId,
    changeId: change.id, scheduledDate: data.schoolDate, groupId: item.groupId, generation: Number(generation),
    kind: plan.action === "skip" && !item.preserved ? "suppression" as const : "meeting" as const,
    scheduledStartAt: plan.action === "skip" && !item.preserved ? null : new Date(!item.preserved && item.endsAt === plan.firstEndsAt && plan.mode === "remainder" ? now.toISOString() : item.startsAt),
    scheduledEndAt: plan.action === "skip" && !item.preserved ? null : new Date(item.endsAt), primaryTeacherIdSnapshot: item.teacherId,
    classNameSnapshot: item.name, timezoneSnapshot: data.timeZone,
    source: { schemaVersion: 1, action: plan.action, sourceMeetingKeys: plan.sourceMeetingKeys,
      originalStartsAt: item.preserved?.startsAt ?? plan.before.find(row => row.groupId === item.groupId)!.startsAt,
      originalEndsAt: item.preserved?.endsAt ?? plan.before.find(row => row.groupId === item.groupId)!.endsAt,
      ...(item.preserved?.scheduledOccurrenceId ? { preservedOccurrenceId: item.preserved.scheduledOccurrenceId } : {}),
      ...(item.preserved?.sessionId && !item.preserved.scheduledOccurrenceId ? { preservedLegacySessionId: item.preserved.sessionId } : {}),
      supersededLegacyChangeIds: legacyIds, cutoverAt: now.toISOString() } }))).returning();
  const transitions = await applyClasspilotTodayTransitions({ schoolId: options.schoolId, occurrenceIds: occurrences.map(row => row.id),
    outgoingSessionIds, liveTeacherIds: [plan.initiatorTeacherId, ...(accepted && plan.counterpartTeacherId ? [plan.counterpartTeacherId] : [])],
    cutoverAt: now, dbInstance: database });
  await database.insert(classpilotSchoolSchedules).values({ schoolId: options.schoolId, config: data.context.config,
    revision: data.context.revision + 1, updatedBy: options.actorId }).onConflictDoUpdate({ target: classpilotSchoolSchedules.schoolId,
    set: { revision: sql`${classpilotSchoolSchedules.revision} + 1`, updatedAt: now, updatedBy: options.actorId } });
  await audit(database, options.schoolId, options.actorId, change.id, "applied", { generation: Number(generation),
    action: plan.action, mode: plan.mode, endedSessionIds: outgoingSessionIds, occurrenceIds: occurrences.map(row => row.id) });
  // Later row/control locks can also outlive the window. Throw inside the
  // outer transaction so no expired plan, finalization or outbox row commits.
  assertPlanBoundary(data, plan, clock());
  return { change: applied, legacyIds, ...transitions };
}

async function publishCommitted(options: RequestContext, outcome: { legacyIds: string[]; finalizations: Awaited<ReturnType<typeof applyClasspilotTodayTransitions>>["finalizations"]; startedSessionIds: string[] }) {
  for (const result of outcome.finalizations) runClasspilotFinalizationSideEffects(result, { schoolId: options.schoolId, reason: "replacement_start" });
  await Promise.allSettled([...new Set(outcome.startedSessionIds)].map(id => pushClasspilotSessionControlStates(options.schoolId, id)));
  await Promise.allSettled([broadcastClasspilotScheduleChangeUpdate({ schoolId: options.schoolId }),
    outcome.legacyIds.length ? announceClasspilotScheduleChangeIds({ schoolId: options.schoolId, changeIds: outcome.legacyIds }) : Promise.resolve()]);
}

export async function createClasspilotTodayScheduleChange(options: RequestContext & { reviewToken: string; idempotencyKey: string }) {
  if (typeof options.idempotencyKey !== "string" || !options.idempotencyKey.trim() || options.idempotencyKey.length > 128)
    fail("A unique request key is required.", "TODAY_SCHEDULE_IDEMPOTENCY_REQUIRED", 400);
  const outcome = await locked(options, async (database, clock) => {
    const now = clock();
    const [existing] = await database.select().from(classpilotTodayChanges).where(and(eq(classpilotTodayChanges.schoolId, options.schoolId),
      eq(classpilotTodayChanges.requestedByUserId, options.actorId), eq(classpilotTodayChanges.idempotencyKey, options.idempotencyKey))).for("update");
    const requestHash = todayScheduleDigest({ reviewToken: options.reviewToken });
    if (existing) {
      if (existing.requestHash !== requestHash) fail("This request key was used for a different review.", "TODAY_SCHEDULE_IDEMPOTENCY_CONFLICT");
      return { change: existing, legacyIds: [], finalizations: [], startedSessionIds: [] };
    }
    if (!isClasspilotTodayScheduleEnabled()) fail("Teacher period swaps are not available yet.", "TODAY_SCHEDULE_DISABLED", 503);
    await assertTodayScheduleWriteContract(database);
    const claims = verifyTodayScheduleReview(options.reviewToken, { ...options, purpose: "apply", now });
    if (!claims.input) fail("A complete review is required.", "TODAY_SCHEDULE_REVIEW_STALE");
    const reviewed = await preview({ ...options, input: claims.input }, database, now);
    if (!reviewed.plan || !reviewed.response.canApply || reviewed.fingerprint !== claims.fingerprint)
      fail(reviewed.response.blockers[0]?.message || "The schedule changed. Review the period swap again.", reviewed.response.blockers[0]?.code || "TODAY_SCHEDULE_REVIEW_STALE");
    await database.select({ id: groups.id }).from(groups).where(and(eq(groups.schoolId, options.schoolId),
      inArray(groups.id, reviewed.plan.groupIds))).orderBy(groups.id).for("update");
    const commitAt = clock();
    if (localDateInTimeZone(commitAt, reviewed.data.timeZone) !== claims.scheduledDate
      || (reviewed.plan.mode === "before_bell" ? new Date(reviewed.plan.firstStartsAt) <= commitAt : new Date(reviewed.plan.firstEndsAt) <= commitAt))
      fail("The period boundary changed. Review today again.", "TODAY_SCHEDULE_REVIEW_STALE");
    const required = reviewed.response.requiredAcceptance;
    const [change] = await database.insert(classpilotTodayChanges).values({ schoolId: options.schoolId, scheduledDate: claims.scheduledDate,
      timezoneSnapshot: reviewed.data.timeZone, status: "pending", requestedByUserId: options.actorId,
      counterpartTeacherId: required?.teacherId ?? reviewed.plan.counterpartTeacherId,
      idempotencyKey: options.idempotencyKey, requestHash,
      reviewSnapshot: { fingerprint: reviewed.fingerprint, requiredAcceptance: required },
      planSnapshot: { ...reviewed.plan }, affectedGroupIds: reviewed.plan.groupIds,
      cutoffAt: new Date(reviewed.plan.firstEndsAt) }).returning();
    if (!change) fail("The request could not be created.", "TODAY_SCHEDULE_UNAVAILABLE", 503);
    await audit(database, options.schoolId, options.actorId, change.id, required ? "requested" : "created", {
      action: reviewed.plan.action, affectedGroupIds: reviewed.plan.groupIds, requiresAcceptance: !!required });
    assertPlanBoundary(reviewed.data, reviewed.plan, clock());
    if (required) return { change, legacyIds: [], finalizations: [], startedSessionIds: [] };
    return applyPlan(database, options, change, reviewed.data, reviewed.plan, clock, false);
  });
  await publishCommitted(options, outcome);
  return { change: serializeChange(outcome.change, options.actorId, false) };
}

export async function actOnClasspilotTodayScheduleChange(options: RequestContext & {
  changeId: string; action: "accept" | "decline" | "cancel"; expectedRevision: number; reviewToken?: string;
}) {
  const outcome = await locked(options, async (database, clock) => {
    const candidate = await visibleChange(options, database);
    await database.select({ id: groups.id }).from(groups).where(and(eq(groups.schoolId, options.schoolId),
      inArray(groups.id, candidate.change.affectedGroupIds))).orderBy(groups.id).for("update");
    const { change, permission, authority } = await visibleChange(options, database, true);
    if (change.revision !== options.expectedRevision) fail("This request changed. Reload it before continuing.", "TODAY_SCHEDULE_REVISION_CONFLICT");
    if (change.status !== "pending") fail("This request is no longer pending.", "TODAY_SCHEDULE_NOT_ACTIONABLE");
    if (options.action === "accept" || options.action === "decline") {
      if (!authority.frozen) fail("Only the affected live class's saved staff may answer this request.", "TODAY_SCHEDULE_FORBIDDEN", 403);
    } else if (change.requestedByUserId !== options.actorId && !permission.admin) fail("Only the requester may cancel this request.", "TODAY_SCHEDULE_FORBIDDEN", 403);
    const now = clock();
    if (options.action !== "accept") {
      const [terminal] = await database.update(classpilotTodayChanges).set({ status: options.action === "decline" ? "declined" : "cancelled",
        revision: change.revision + 1, terminalByUserId: options.actorId, terminalReason: options.action,
        terminalAt: now, updatedAt: now }).where(and(eq(classpilotTodayChanges.schoolId, options.schoolId), eq(classpilotTodayChanges.id, change.id))).returning();
      if (!terminal) fail("The request changed before it could close.", "TODAY_SCHEDULE_REVIEW_STALE");
      await audit(database, options.schoolId, options.actorId, change.id, terminal.status, { revision: terminal.revision });
      return { change: terminal, legacyIds: [], finalizations: [], startedSessionIds: [], stale: false };
    }
    if (!permission.allowed || !isClasspilotTodayScheduleEnabled()) fail("Teacher period swaps are disabled.", "TODAY_SCHEDULE_TEACHER_DISABLED", 403);
    await assertTodayScheduleWriteContract(database);
    const plan = storedPlan(change);
    const claims = verifyTodayScheduleReview(options.reviewToken || "", { ...options, purpose: "accept", now });
    if (claims.changeId !== change.id || claims.revision !== change.revision) fail("This request changed. Review it again.", "TODAY_SCHEDULE_REVIEW_STALE");
    const closeStale = async () => {
      const [closed] = await database.update(classpilotTodayChanges).set({ status: change.cutoffAt <= now ? "expired" : "superseded",
        revision: change.revision + 1, terminalByUserId: options.actorId, terminalReason: "review_changed",
        terminalAt: now, updatedAt: now }).where(and(eq(classpilotTodayChanges.schoolId, options.schoolId), eq(classpilotTodayChanges.id, change.id))).returning();
      if (!closed) fail("The request changed before it could close.", "TODAY_SCHEDULE_REVIEW_STALE");
      await audit(database, options.schoolId, options.actorId, change.id, closed.status, { reason: "review_changed" });
      return { change: closed, legacyIds: [], finalizations: [], startedSessionIds: [], stale: true };
    };
    let reviewed: Awaited<ReturnType<typeof preview>>;
    try { reviewed = await preview({ ...options, input: plan.input }, database, now, "accept", change); }
    catch (error) {
      const status = Number((error as { status?: number }).status);
      if (!(status >= 400 && status < 500)) throw error;
      return closeStale();
    }
    if (!reviewed.plan || !reviewed.response.canApply || reviewed.fingerprint !== claims.fingerprint
      || reviewed.fingerprint !== change.reviewSnapshot.fingerprint || change.cutoffAt <= now) {
      return closeStale();
    }
    await database.select({ id: groups.id }).from(groups).where(and(eq(groups.schoolId, options.schoolId),
      inArray(groups.id, reviewed.plan.groupIds))).orderBy(groups.id).for("update");
    const commitAt = clock();
    if (change.cutoffAt <= commitAt || localDateInTimeZone(commitAt, reviewed.data.timeZone) !== change.scheduledDate
      || reviewed.plan.mode === "before_bell" && new Date(reviewed.plan.firstStartsAt) <= commitAt)
      fail("This period ended. Review a new change.", "TODAY_SCHEDULE_REVIEW_STALE");
    return { ...await applyPlan(database, options, change, reviewed.data, reviewed.plan, clock, true), stale: false };
  });
  await publishCommitted(options, outcome);
  if (outcome.stale) fail("The schedule or live class changed. This request was closed; make a new review.", "TODAY_SCHEDULE_REVIEW_STALE");
  return { change: serializeChange(outcome.change, options.actorId, false) };
}

/** Cleanup remains active when requests, memberships or entitlement are disabled. */
export async function expireClasspilotTodayScheduleChanges(options: {
  schoolId: string; now?: Date; dbInstance?: Database;
}): Promise<number> {
  const expired = await withClasspilotSchedulePostCommitTransaction(async tx => {
    if (!await lockStaffAssignmentLifecycleSchool(tx, options.schoolId, { includeDeleted: true })) return 0;
    const database = tx as unknown as Database;
    const candidateAt = options.now ?? new Date();
    const pending = bounded(await database.select().from(classpilotTodayChanges).where(and(
      eq(classpilotTodayChanges.schoolId, options.schoolId), eq(classpilotTodayChanges.status, "pending"),
      lte(classpilotTodayChanges.cutoffAt, candidateAt))).orderBy(classpilotTodayChanges.scheduledDate, classpilotTodayChanges.id).limit(501), 500);
    for (const date of [...new Set(pending.map(row => row.scheduledDate))].sort())
      await lockInstructionalCalendarDate(options.schoolId, date, database);
    await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${options.schoolId}`}))`);
    const now = options.now ?? new Date();
    if (!pending.length) return 0;
    const rows = await database.update(classpilotTodayChanges).set({ status: "expired",
      revision: sql`${classpilotTodayChanges.revision} + 1`, terminalReason: "period_window_elapsed", terminalAt: now, updatedAt: now })
      .where(and(eq(classpilotTodayChanges.schoolId, options.schoolId), inArray(classpilotTodayChanges.id, pending.map(row => row.id)),
        eq(classpilotTodayChanges.status, "pending"), lte(classpilotTodayChanges.cutoffAt, now))).returning();
    for (const row of rows) await database.insert(auditLogs).values({ schoolId: options.schoolId,
      action: "classpilot.today_schedule.expired", entityType: "classpilot_today_change", entityId: row.id,
      metadata: { reason: "period_window_elapsed", revision: row.revision } });
    return rows.length;
  }, options.dbInstance ?? db);
  if (expired) await Promise.allSettled([broadcastClasspilotScheduleChangeUpdate({ schoolId: options.schoolId })]);
  return expired;
}
