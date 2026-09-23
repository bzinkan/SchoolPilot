import { and, eq, inArray, or } from "drizzle-orm";
import db from "../db.js";
import { schools, users } from "../schema/core.js";
import { groups, groupTeachers, classpilotScheduledConflicts, classpilotSupervisionContexts } from "../schema/classpilot.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { isSchedulingDate, readStoredSchoolSchedulingConfig, schedulingError } from "./classpilotSchedulingRules.js";
import { isScheduleProfileBlockCancelled } from "./classpilotScheduleProfileModel.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";

type ScheduledState = "scheduled" | "active" | "ended" | "cancelled" | "unassigned" | "failed" | "missed" | "releasing";
type ScheduledItem = { id: string; purpose: "testing" | "coverage"; source: "schedule_profile" | "scheduled_coverage";
  name: string; startsAt: string; endsAt: string | null; state: ScheduledState;
  assignedStaff: { id: string; name: string } | null; supervisionGroupId?: string; supervisionContextId?: string };

/** Dated applied occurrences only. Saved group membership and reusable profiles are not activity. */
export async function getClasspilotScheduledSupervision(options: {
  schoolId: string; actorId: string; admin: boolean; date?: unknown; now?: Date;
}, database: typeof db = db) {
  const now = options.now ?? new Date();
  if (options.date !== undefined && !isSchedulingDate(options.date)) {
    throw schedulingError("Choose a real date in YYYY-MM-DD format.", "SCHEDULED_DATE_INVALID", 400);
  }
  return database.transaction(async tx => {
    const [school] = await tx.select({ timeZone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId)).limit(1);
    if (!school) throw schedulingError("School not found.", "SCHOOL_NOT_FOUND", 404);
    const timeZone = school.timeZone || "America/New_York";
    const date = options.date as string | undefined ?? localDateInTimeZone(now, timeZone);
    const [scheduleRows, conflictRows, coTeachers] = await Promise.all([
      tx.select().from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, options.schoolId)).limit(1),
      tx.select({ conflict: classpilotScheduledConflicts, name: groups.name }).from(classpilotScheduledConflicts)
        .innerJoin(groups, and(eq(groups.id, classpilotScheduledConflicts.groupId), eq(groups.schoolId, options.schoolId)))
        .where(and(eq(classpilotScheduledConflicts.schoolId, options.schoolId), eq(classpilotScheduledConflicts.scheduledDate, date)))
        .orderBy(classpilotScheduledConflicts.id).limit(501),
      options.admin ? Promise.resolve([]) : tx.select({ groupId: groupTeachers.groupId }).from(groupTeachers)
        .innerJoin(groups, and(eq(groups.id, groupTeachers.groupId), eq(groups.schoolId, options.schoolId)))
        .where(eq(groupTeachers.teacherId, options.actorId)),
    ]);
    if (conflictRows.length > 500) throw schedulingError("Too many scheduled coverage records to load completely.", "SCHEDULED_LIST_LIMIT", 422);
    const schedule = scheduleRows[0];
    const applications = readStoredSchoolSchedulingConfig(schedule?.config).profileApplications ?? [];
    const dated = applications.flatMap(application => application.testingWindows.filter(window => window.date === date)
      .map(window => ({ application, window })));
    const conflictIds = conflictRows.map(row => row.conflict.id);
    const contexts = await tx.select().from(classpilotSupervisionContexts).where(and(
      eq(classpilotSupervisionContexts.schoolId, options.schoolId), or(eq(classpilotSupervisionContexts.scheduleProfileDate, date),
        conflictIds.length ? inArray(classpilotSupervisionContexts.scheduledConflictId, conflictIds) : undefined),
    )).orderBy(classpilotSupervisionContexts.id).limit(2501);
    if (contexts.length > 2500) throw schedulingError("Too many scheduled contexts to load completely.", "SCHEDULED_LIST_LIMIT", 422);
    const staffIds = [...new Set([...dated.map(row => row.window.assignedStaffId), ...contexts.map(context => context.assignedStaffId)])];
    const staff = staffIds.length ? await tx.select({ id: users.id, displayName: users.displayName, firstName: users.firstName, lastName: users.lastName })
      .from(users).where(inArray(users.id, staffIds)) : [];
    const names = new Map(staff.map(person => [person.id, person.displayName || [person.firstName, person.lastName].filter(Boolean).join(" ") || "Staff"]));
    const assignedStaff = (id: string) => ({ id, name: names.get(id) || "Staff" });
    const items: ScheduledItem[] = [];
    for (const { application, window } of dated) {
      const context = contexts.find(row => row.scheduleProfileApplicationId === application.id && row.scheduleProfileDate === date && row.scheduleProfileBlockId === window.blockId);
      if (!options.admin && window.assignedStaffId !== options.actorId && context?.assignedStaffId !== options.actorId) continue;
      const startsAt = localDateTimeUtc(date, window.startTime, timeZone), endsAt = localDateTimeUtc(date, window.endTime, timeZone);
      const receipt = schedule?.profileActivationOutcomes[`${application.id}:${date}:${window.blockId}`];
      const cancelled = isScheduleProfileBlockCancelled(application, date, window.blockId);
      const state: ScheduledState = cancelled ? context?.status === "active" ? "releasing" : "cancelled"
        : context ? context.status !== "active" || context.endsAt <= now ? "ended" : context.startsAt > now ? "scheduled" : "active"
        : receipt?.status === "failed" || receipt?.status === "missed" || receipt?.status === "cancelled" ? receipt.status
        : receipt?.status === "started" ? "ended" : endsAt <= now ? "missed" : "scheduled";
      items.push({ id: `testing:${application.id}:${date}:${window.blockId}`, purpose: "testing", source: "schedule_profile",
        name: window.name, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), state,
        assignedStaff: assignedStaff(context?.assignedStaffId || window.assignedStaffId), supervisionGroupId: window.coverageGroupId,
        ...(context ? { supervisionContextId: context.id } : {}) });
    }
    const coTeacherGroups = new Set(coTeachers.map(row => row.groupId));
    for (const { conflict, name } of conflictRows) {
      const candidates = contexts.filter(context => context.scheduledConflictId === conflict.id);
      const classViewer = options.admin || conflict.teacherId === options.actorId || coTeacherGroups.has(conflict.groupId);
      // One scheduled class may be split between several supervisors. Preserve
      // each real assignment, and never use one supervisor's historical access
      // to expose another supervisor's current context.
      if (candidates.length) {
        for (const context of candidates) {
          if (!classViewer && context.assignedStaffId !== options.actorId) continue;
          const state: ScheduledState = context.status !== "active" || context.endsAt <= now ? "ended"
            : context.startsAt > now ? "scheduled" : "active";
          items.push({ id: `coverage:${conflict.id}:${context.id}`, purpose: "coverage", source: "scheduled_coverage", name,
            startsAt: context.startsAt.toISOString(), endsAt: context.endsAt.toISOString(), state,
            assignedStaff: assignedStaff(context.assignedStaffId), supervisionContextId: context.id });
        }
        continue;
      }
      if (!classViewer) continue;
      const startsAt = localDateTimeUtc(date, conflict.blockStartTime, timeZone);
      const endsAt = conflict.blockEndTime ? localDateTimeUtc(date, conflict.blockEndTime, timeZone) : null;
      const state: ScheduledState = conflict.status !== "coverage_needed" ? "ended" : endsAt && endsAt <= now ? "missed" : "unassigned";
      items.push({ id: `coverage:${conflict.id}`, purpose: "coverage", source: "scheduled_coverage", name,
        startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, state,
        assignedStaff: null });
    }
    return { date, timeZone, items: items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
