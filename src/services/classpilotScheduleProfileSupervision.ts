import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import db from "../db.js";
import { schools, schoolMemberships } from "../schema/core.js";
import { students } from "../schema/students.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { classpilotCoverageAssignments, classpilotCoverageScopeGroups, classpilotCoverageScopeGroupMembers,
  classpilotSupervisionContexts, classpilotSupervisionStudents } from "../schema/classpilot.js";
import { localDateTimeUtc } from "../util/schoolTime.js";
import { schedulerDb } from "./schedulerDb.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { resolveClasspilotEntitlement } from "./classpilotEntitlement.js";
import { resolveClasspilotMonitoringPolicy } from "./classpilotMonitoringPolicy.js";
import { isSchedulingInstructionalDate } from "./classpilotSchedulingRules.js";
import { normalizeScheduleProfileCollections, SCHEDULE_PROFILE_LIMITS,
  type ScheduleProfileTestingWindow } from "./classpilotScheduleProfileModel.js";
import { createSupervisionContextWithStudents, releaseSupervisionStudents, getHeartbeatTrackingSettingsForSchool,
  lockClasspilotStudentControlAuthorities, lockInstructionalCalendarDate } from "./storage.js";
import { classpilotLifecyclePushes } from "./classpilotLifecyclePushes.js";
import { syncClasspilotControlStatesToActiveDevices } from "./classpilotControlStateDelivery.js";
import { validateScheduleProfileTestingWindows } from "./classpilotScheduleProfileValidation.js";

export type ProfileSupervisionOutcome = {
  applicationId: string; date: string; blockId: string;
  status: "started" | "failed" | "missed" | "cancelled";
  code: string; contextId?: string; updatedAt: string;
};
export type ProfileSupervisionStatus = Omit<ProfileSupervisionOutcome, "status" | "updatedAt"> & {
  status: "pending" | "active" | "ended" | "failed" | "missed" | "cancelled" | "releasing";
  updatedAt?: string;
};
const MAX_SCHOOLS_PER_TICK = 25;
const MAX_WINDOWS_PER_SCHOOL_TICK = 10;
let schoolCursor = "";

export function profileSupervisionOutcomeKey(applicationId: string, date: string, blockId: string) {
  return `${applicationId}:${date}:${blockId}`;
}

function applications(config: { profileApplications?: unknown }) {
  return normalizeScheduleProfileCollections([], config.profileApplications ?? []).profileApplications;
}

function pushControls(schoolId: string, studentIds: string[]) {
  if (!studentIds.length) return;
  void classpilotLifecyclePushes.enqueue(async (signal) => {
    await syncClasspilotControlStatesToActiveDevices(schoolId, [...new Set(studentIds)], signal);
  });
}

/** Root route callers retain their tenant context; cross-school discovery uses only the scheduler pool. */
export async function getScheduledProfileSupervisionStatuses(schoolId: string, applicationId?: string, database: typeof db = db): Promise<ProfileSupervisionStatus[]> {
  const [schedule] = await database.select().from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1);
  if (!schedule) return [];
  const selected = applications(schedule.config).filter((application) => !applicationId || application.id === applicationId);
  if (!selected.length) return [];
  const contexts = await database.select().from(classpilotSupervisionContexts).where(and(
    eq(classpilotSupervisionContexts.schoolId, schoolId),
    inArray(classpilotSupervisionContexts.scheduleProfileApplicationId, selected.map((application) => application.id)),
  )).limit(SCHEDULE_PROFILE_LIMITS.testingWindows);
  const byKey = new Map(contexts.map((context) => [profileSupervisionOutcomeKey(
    context.scheduleProfileApplicationId!, context.scheduleProfileDate!, context.scheduleProfileBlockId!,
  ), context]));
  return selected.flatMap((application) => application.testingWindows.map((window): ProfileSupervisionStatus => {
    const key = profileSupervisionOutcomeKey(application.id, window.date, window.blockId);
    const receipt = schedule.profileActivationOutcomes[key];
    const context = byKey.get(key);
    const status = application.status === "cancelled" ? context?.status === "active" ? "releasing" : "cancelled"
      : context ? context.status === "ended" ? "ended" : "active"
      : receipt?.status === "started" ? "ended" : receipt?.status ?? "pending";
    return { applicationId: application.id, date: window.date, blockId: window.blockId, status,
      code: receipt?.code ?? (status === "pending" ? "AWAITING_WINDOW" : status.toUpperCase()),
      ...(context || receipt?.contextId ? { contextId: context?.id ?? receipt?.contextId } : {}),
      ...(receipt ? { updatedAt: receipt.updatedAt } : {}) };
  }));
}

async function lockSchool(database: Parameters<Parameters<typeof db.transaction>[0]>[0], schoolId: string) {
  if (!await lockStaffAssignmentLifecycleSchool(database, schoolId, { includeDeleted: true })) return false;
  await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${schoolId}`}))`);
  return true;
}

async function saveOutcome(database: typeof db, schoolId: string, outcome: ProfileSupervisionOutcome,
  schedule: typeof classpilotSchoolSchedules.$inferSelect) {
  const key = profileSupervisionOutcomeKey(outcome.applicationId, outcome.date, outcome.blockId);
  const retainedKeys = new Set(applications(schedule.config).flatMap((application) => application.testingWindows
    .map((window) => profileSupervisionOutcomeKey(application.id, window.date, window.blockId))));
  const outcomes = Object.fromEntries(Object.entries(schedule.profileActivationOutcomes).filter(([key]) => retainedKeys.has(key)));
  outcomes[key] = outcome;
  await database.update(classpilotSchoolSchedules).set({
    profileActivationOutcomes: outcomes,
  }).where(eq(classpilotSchoolSchedules.schoolId, schoolId));
}

/** Frozen targets must still exactly match the active group and its paired staff. */
async function validateWindowScope(schoolId: string, window: ScheduleProfileTestingWindow, database: typeof db, now: Date): Promise<string | null> {
  const studentIds = [...new Set(window.studentIds)].sort();
  if (!studentIds.length || studentIds.length > SCHEDULE_PROFILE_LIMITS.studentsPerWindow) return "TESTING_ROSTER_INVALID";
  await lockClasspilotStudentControlAuthorities(schoolId, studentIds, database);
  const [group] = await database.select({ id: classpilotCoverageScopeGroups.id, active: classpilotCoverageScopeGroups.active })
    .from(classpilotCoverageScopeGroups).where(and(eq(classpilotCoverageScopeGroups.schoolId, schoolId), eq(classpilotCoverageScopeGroups.id, window.coverageGroupId))).limit(1).for("share");
  if (!group?.active) return "COVERAGE_GROUP_UNAVAILABLE";
  const [membership] = await database.select({ id: schoolMemberships.id }).from(schoolMemberships).where(and(
    eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, window.assignedStaffId), eq(schoolMemberships.status, "active"),
    inArray(schoolMemberships.role, ["teacher", "admin", "school_admin", "office_staff"]),
  )).limit(1).for("share");
  if (!membership) return "STAFF_MEMBERSHIP_UNAVAILABLE";
  const pairings = await database.select({ permissions: classpilotCoverageAssignments.permissions }).from(classpilotCoverageAssignments).where(and(
    eq(classpilotCoverageAssignments.schoolId, schoolId), eq(classpilotCoverageAssignments.staffId, window.assignedStaffId),
    eq(classpilotCoverageAssignments.scopeType, "coverage_group"), eq(classpilotCoverageAssignments.scopeValue, window.coverageGroupId),
    eq(classpilotCoverageAssignments.active, true),
  )).for("share");
  if (!pairings.some(({ permissions }) => {
    const value = permissions as Record<string, unknown>;
    return value.claim === true || value.observe === true;
  })) return "STAFF_GROUP_PAIRING_CHANGED";
  const members = await database.select({ studentId: classpilotCoverageScopeGroupMembers.studentId }).from(classpilotCoverageScopeGroupMembers).where(and(
    eq(classpilotCoverageScopeGroupMembers.schoolId, schoolId), eq(classpilotCoverageScopeGroupMembers.coverageGroupId, window.coverageGroupId),
  )).orderBy(classpilotCoverageScopeGroupMembers.studentId).for("share");
  if (members.length !== studentIds.length || members.some((member, index) => member.studentId !== studentIds[index])) return "COVERAGE_ROSTER_CHANGED";
  const activeStudents = await database.select({ id: students.id }).from(students).where(and(
    eq(students.schoolId, schoolId), inArray(students.id, studentIds), eq(students.status, "active"),
  )).orderBy(students.id).for("update");
  if (activeStudents.length !== studentIds.length) return "STUDENT_SCOPE_CHANGED";
  const occupied = await database.select({ id: classpilotSupervisionContexts.id }).from(classpilotSupervisionContexts)
    .leftJoin(classpilotSupervisionStudents, and(eq(classpilotSupervisionStudents.contextId, classpilotSupervisionContexts.id),
      eq(classpilotSupervisionStudents.schoolId, schoolId), isNull(classpilotSupervisionStudents.releasedAt)))
    .where(and(eq(classpilotSupervisionContexts.schoolId, schoolId), eq(classpilotSupervisionContexts.status, "active"),
      gt(classpilotSupervisionContexts.endsAt, now), or(eq(classpilotSupervisionContexts.assignedStaffId, window.assignedStaffId),
        inArray(classpilotSupervisionStudents.studentId, studentIds)))).limit(1);
  return occupied.length ? "SUPERVISION_ALREADY_CLAIMED" : null;
}

async function reconcileWindow(schoolId: string, candidate: { applicationId: string; date: string; blockId: string }, now: Date, database: typeof db) {
  const changedStudents: string[] = [];
  const outcome = await database.transaction(async (tx) => {
    if (!await lockSchool(tx, schoolId)) return null;
    const locked = tx as unknown as typeof db;
    await lockInstructionalCalendarDate(schoolId, candidate.date, locked);
    const [schedule] = await tx.select().from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1).for("update");
    const application = schedule && applications(schedule.config).find((entry) => entry.id === candidate.applicationId);
    const window = application?.testingWindows.find((entry) => entry.date === candidate.date && entry.blockId === candidate.blockId);
    if (!schedule || !application || !window) return null;
    const key = profileSupervisionOutcomeKey(application.id, window.date, window.blockId);
    const [existing] = await tx.select().from(classpilotSupervisionContexts).where(and(
      eq(classpilotSupervisionContexts.schoolId, schoolId), eq(classpilotSupervisionContexts.scheduleProfileApplicationId, application.id),
      eq(classpilotSupervisionContexts.scheduleProfileDate, window.date), eq(classpilotSupervisionContexts.scheduleProfileBlockId, window.blockId),
    )).limit(1);
    if (application.status === "cancelled") {
      if (existing?.status === "active") {
        const released = await releaseSupervisionStudents({ schoolId, contextId: existing.id, releaseReason: "schedule_profile_cancelled" }, locked);
        changedStudents.push(...released.map((row) => row.studentId));
      }
      const receipt: ProfileSupervisionOutcome = { ...candidate, status: "cancelled", code: "APPLICATION_CANCELLED",
        ...(existing ? { contextId: existing.id } : {}), updatedAt: now.toISOString() };
      await saveOutcome(locked, schoolId, receipt, schedule);
      return receipt;
    }
    // Existence, including ended/early-released contexts, is permanently terminal.
    if (existing || schedule.profileActivationOutcomes[key]) return null;
    const [school] = await tx.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, schoolId)).limit(1);
    const timezone = school?.timezone || "America/New_York";
    const startsAt = localDateTimeUtc(window.date, window.startTime, timezone);
    const endsAt = localDateTimeUtc(window.date, window.endTime, timezone);
    if (now < startsAt) return null;
    const receipt: ProfileSupervisionOutcome = { ...candidate, status: "failed", code: "ACTIVATION_FAILED", updatedAt: now.toISOString() };
    if (now >= endsAt) { receipt.status = "missed"; receipt.code = "WINDOW_ELAPSED"; }
    else {
      const entitlement = await resolveClasspilotEntitlement(schoolId, locked, { lock: true });
      const tracking = await getHeartbeatTrackingSettingsForSchool(schoolId, locked, { lock: true, bypassCache: true });
      if (!entitlement.entitled) receipt.code = "CLASSPILOT_NOT_ENTITLED";
      else if (!tracking || !isSchedulingInstructionalDate(window.date, tracking.instructionalCalendar ?? {}, tracking.schedulingDateOverrides ?? {})) receipt.code = "NON_INSTRUCTIONAL_DATE";
      else if (resolveClasspilotMonitoringPolicy(tracking, { now }).policyMode !== "full") receipt.code = "MONITORING_NOT_FULL";
      else {
        let invalid = await validateWindowScope(schoolId, window, locked, now);
        if (!invalid) {
          const validation = await validateScheduleProfileTestingWindows({ schoolId, testingWindows: [window],
            config: schedule.config, calendar: tracking.instructionalCalendar ?? {}, dbInstance: locked, now });
          invalid = validation.blockers[0]?.code ?? null;
        }
        if (invalid) receipt.code = invalid;
        else if (Math.max(now.getTime(), Date.now()) >= endsAt.getTime()) {
          // A school lock or validation query can finish after the tick's
          // original clock. Never grant new authority for an elapsed window.
          receipt.status = "missed"; receipt.code = "WINDOW_ELAPSED";
        } else {
          try {
            const context = await createSupervisionContextWithStudents({ context: {
              schoolId, contextType: "supervision_group", name: window.name, assignedStaffId: window.assignedStaffId,
              coverageGroupId: window.coverageGroupId, createdBy: application.createdBy, startsAt, endsAt,
              scheduleProfileApplicationId: application.id, scheduleProfileDate: window.date, scheduleProfileBlockId: window.blockId,
            }, studentIds: window.studentIds, assignedBy: application.createdBy, source: "schedule_profile" }, locked);
            receipt.status = "started"; receipt.code = "WINDOW_STARTED"; receipt.contextId = context.id;
            changedStudents.push(...window.studentIds);
          } catch {
            // The existing Coverage helper rolls its nested transaction back;
            // the outer transaction can durably report a bounded failure code.
            receipt.code = "ACTIVATION_FAILED";
          }
        }
      }
    }
    await saveOutcome(locked, schoolId, receipt, schedule);
    return receipt;
  });
  pushControls(schoolId, changedStudents);
  return outcome;
}

/** Called after the application cancellation commits; worker reconciliation also catches interrupted requests. */
export async function cancelProfileSupervision(schoolId: string, applicationId: string) {
  const statuses = await getScheduledProfileSupervisionStatuses(schoolId, applicationId);
  const active = statuses.filter((status) => status.status === "releasing");
  for (const status of active.slice(0, MAX_WINDOWS_PER_SCHOOL_TICK)) {
    await reconcileWindow(schoolId, status, new Date(), db);
  }
  return getScheduledProfileSupervisionStatuses(schoolId, applicationId);
}

/** Bounded discovery on the worker pool, followed by one locked transaction per due block. */
export async function reconcileScheduledProfileSupervision(now = new Date(), schoolId?: string) {
  const database = schoolId ? db : schedulerDb;
  const candidates = await database.select({ schoolId: classpilotSchoolSchedules.schoolId, config: classpilotSchoolSchedules.config,
    outcomes: classpilotSchoolSchedules.profileActivationOutcomes, timezone: schools.schoolTimezone }).from(classpilotSchoolSchedules)
    .innerJoin(schools, eq(schools.id, classpilotSchoolSchedules.schoolId)).where(and(
      sql`jsonb_array_length(COALESCE(${classpilotSchoolSchedules.config}->'profileApplications','[]'::jsonb)) > 0`,
      schoolId ? eq(classpilotSchoolSchedules.schoolId, schoolId) : gt(classpilotSchoolSchedules.schoolId, schoolCursor),
    )).orderBy(asc(classpilotSchoolSchedules.schoolId)).limit(MAX_SCHOOLS_PER_TICK);
  if (!schoolId) schoolCursor = candidates.length === MAX_SCHOOLS_PER_TICK ? candidates.at(-1)!.schoolId : "";
  const result = { schoolsChecked: candidates.length, windowsChecked: 0, started: 0, failed: 0, missed: 0, cancelled: 0 };
  for (const school of candidates) {
    const entries = applications(school.config);
    const activeCancelled = await database.select({ applicationId: classpilotSupervisionContexts.scheduleProfileApplicationId,
      date: classpilotSupervisionContexts.scheduleProfileDate, blockId: classpilotSupervisionContexts.scheduleProfileBlockId })
      .from(classpilotSupervisionContexts).where(and(eq(classpilotSupervisionContexts.schoolId, school.schoolId),
        eq(classpilotSupervisionContexts.status, "active"), isNotNull(classpilotSupervisionContexts.scheduleProfileApplicationId)))
      .limit(SCHEDULE_PROFILE_LIMITS.testingWindows);
    const cancelledIds = new Set(entries.filter((entry) => entry.status === "cancelled").map((entry) => entry.id));
    const windows: Array<{ applicationId: string; date: string; blockId: string }> = activeCancelled
      .filter((context) => context.applicationId && cancelledIds.has(context.applicationId))
      .map((context) => ({ applicationId: context.applicationId!, date: context.date!, blockId: context.blockId! }));
    for (const application of entries) {
      if (application.status !== "scheduled") continue;
      for (const window of application.testingWindows) {
        const key = profileSupervisionOutcomeKey(application.id, window.date, window.blockId);
        if (school.outcomes[key] || localDateTimeUtc(window.date, window.startTime, school.timezone) > now) continue;
        windows.push({ applicationId: application.id, date: window.date, blockId: window.blockId });
      }
    }
    for (const window of windows.slice(0, MAX_WINDOWS_PER_SCHOOL_TICK)) {
      result.windowsChecked += 1;
      const outcome = await reconcileWindow(school.schoolId, window, now, database);
      if (outcome) result[outcome.status] += 1;
    }
  }
  return result;
}
