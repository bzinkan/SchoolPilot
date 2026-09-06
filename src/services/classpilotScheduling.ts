import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import db from "../db.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { groups, groupTeachers, teachingSessions, classpilotSessionStaff, classpilotScheduleChanges, classpilotScheduleChangeLegs } from "../schema/classpilot.js";
import { settings } from "../schema/shared.js";
import { schools } from "../schema/core.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import {
  datePlusDays, emptySchoolSchedulingConfig, findScheduleOverlap,
  normalizeClassScheduleRule, normalizeSchoolSchedulingConfig, resolveClassBaseWindow,
  resolveSchoolScheduleDay, schedulingError,
  type ClasspilotScheduleRule, type SchedulingCalendar, type SchoolSchedulingConfig, type SchedulingGroup,
} from "./classpilotSchedulingRules.js";

export type SchoolSchedulingContext = { config: SchoolSchedulingConfig; revision: number; calendar: SchedulingCalendar };
export async function getSchoolSchedulingContext(schoolId: string, dbInstance: typeof db = db): Promise<SchoolSchedulingContext> {
  const [records, calendarRows] = await Promise.all([
    dbInstance.select().from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1),
    dbInstance.select({ calendar: settings.instructionalCalendar }).from(settings).where(eq(settings.schoolId, schoolId)).limit(1),
  ]);
  if (!calendarRows[0]) throw schedulingError("School calendar settings are unavailable.", "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE", 500);
  return { config: records[0] ? normalizeSchoolSchedulingConfig(records[0].config) : emptySchoolSchedulingConfig(), revision: records[0]?.revision ?? 0, calendar: calendarRows[0].calendar ?? {} };
}
export async function getClasspilotBaseScheduleWindow(options: { schoolId: string; group: SchedulingGroup; scheduledDate: string; dbInstance?: typeof db; context?: SchoolSchedulingContext }) {
  const context = options.context ?? await getSchoolSchedulingContext(options.schoolId, options.dbInstance);
  return resolveClassBaseWindow(options.group, options.scheduledDate, context.config, context.calendar);
}
/** ClassPilot makeup dates are intentionally separate from GoPilot dismissal dates. */
export async function getClasspilotInstructionalDateStatus(schoolId: string, date: string, dbInstance: typeof db = db) {
  const context = await getSchoolSchedulingContext(schoolId, dbInstance);
  const day = resolveSchoolScheduleDay(date, context.config, context.calendar);
  return { instructional: day.instructional, reason: day.instructional ? "instructional_day" as const : "non_instructional_day" as const };
}
export async function validateClassScheduling(options: { schoolId: string; rule: unknown; scheduleEnabled: boolean; dbInstance?: typeof db }): Promise<{ scheduleRule: ClasspilotScheduleRule; defaultWindow: { startTime: string; endTime: string } | null }> {
  const scheduleRule = normalizeClassScheduleRule(options.rule);
  if (!options.scheduleEnabled || (!scheduleRule.periodId && scheduleRule.cycleDay === "all")) return { scheduleRule, defaultWindow: null };
  const { config } = await getSchoolSchedulingContext(options.schoolId, options.dbInstance);
  if (scheduleRule.cycleDay !== "all" && !config.cycleAnchorDate) throw schedulingError("Configure the school's A/B year and anchor before assigning an A/B class.");
  const defaultWindow = scheduleRule.periodId ? config.profiles.find((profile) => profile.id === config.defaultProfileId)?.periods[scheduleRule.periodId] : null;
  if (scheduleRule.periodId && !defaultWindow) throw schedulingError("Choose a period configured in the school's default bell profile.");
  return { scheduleRule, defaultWindow: defaultWindow ?? null };
}

export async function assertSchoolSchedulingClassOverlap(options: { schoolId: string; excludeGroupId?: string | null; group: SchedulingGroup; teacherIds: string[]; dbInstance: typeof db }) {
  if (!options.group.scheduleEnabled) return;
  await validateClassScheduling({ schoolId: options.schoolId, rule: options.group.scheduleRule, scheduleEnabled: true, dbInstance: options.dbInstance });
  const context = await getSchoolSchedulingContext(options.schoolId, options.dbInstance);
  const [school] = await options.dbInstance.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId)).limit(1);
  const fromDate = localDateInTimeZone(new Date(), school?.timezone || "America/New_York");
  const candidates = await options.dbInstance.select({ group: groups }).from(groups)
    .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
    .where(and(eq(groups.schoolId, options.schoolId), eq(groups.status, "active"), eq(groups.scheduleEnabled, true),
      or(inArray(groups.teacherId, options.teacherIds), inArray(groupTeachers.teacherId, options.teacherIds))));
  for (const candidate of new Map(candidates.map(({ group }) => [group.id, group])).values()) {
    if (candidate.id === options.excludeGroupId) continue;
    const conflictDate = findScheduleOverlap({ ...options.group, id: options.group.id ?? options.excludeGroupId ?? undefined }, candidate, context.config, context.calendar, fromDate);
    if (conflictDate) throw schedulingError(`An assigned teacher has an overlapping class (${candidate.name}) on ${conflictDate}.`, "CLASS_SCHEDULE_CONFLICT", 409);
  }
}

/** Unfrozen dated reservations survive recurrence edits; recorded occurrences already own their schedule. */
export async function assertAppliedScheduleProfileClassEligibility(options: { schoolId: string; groupId?: string | null; group: SchedulingGroup; dbInstance: typeof db }) {
  if (!options.groupId) return;
  const [savedSchedule] = await options.dbInstance.select({ config: classpilotSchoolSchedules.config }).from(classpilotSchoolSchedules)
    .where(eq(classpilotSchoolSchedules.schoolId, options.schoolId)).limit(1);
  // Inactive or non-ClassPilot classes must not acquire a calendar-settings
  // dependency merely because their edit passes through the shared writer.
  const applications = savedSchedule?.config.profileApplications ?? [];
  if (!applications.some((application) => application.status === "scheduled"
    && Object.values(application.classWindows).some((windows) => Object.hasOwn(windows, options.groupId!)))) return;
  const context = await getSchoolSchedulingContext(options.schoolId, options.dbInstance);
  const [school] = await options.dbInstance.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId)).limit(1);
  const today = localDateInTimeZone(new Date(), school?.timezone || "America/New_York");
  const frozen = await options.dbInstance.select({ date: teachingSessions.scheduledDate }).from(teachingSessions)
    .where(and(eq(teachingSessions.schoolId, options.schoolId), eq(teachingSessions.groupId, options.groupId), sql`${teachingSessions.scheduledDate} >= ${today}`));
  const frozenDates = new Set(frozen.map((row) => row.date));
  const baselineConfig = { ...context.config, profileApplications: [] };
  for (const application of context.config.profileApplications ?? []) if (application.status === "scheduled") {
    for (const date of application.dates) {
      if (date < today || frozenDates.has(date) || !Object.hasOwn(application.classWindows[date] ?? {}, options.groupId)) continue;
      let eligible = false;
      // A null (skip) reservation still requires a valid underlying occurrence.
      try { eligible = Boolean(resolveClassBaseWindow({ ...options.group, id: options.groupId }, date, baselineConfig, context.calendar)); } catch { /* Return the actionable reservation error below. */ }
      if (!eligible) throw schedulingError(`Cancel the applied schedule profile on ${date} before removing this class meeting.`, "SCHEDULE_PROFILE_APPLIED", 409);
    }
  }
}

export type SchedulingPreview = {
  revision: number; previewToken: string; schoolTimezone: string;
  fromDate: string; throughDate: string; changedOccurrences: number;
  changes: Array<{ date: string; classId: string; className: string; before: unknown; after: unknown }>;
  blockers: Array<{ code: string; message: string; date?: string }>;
  days: Array<ReturnType<typeof resolveSchoolScheduleDay>>;
};
/** Also used by the existing calendar writer, so a holiday edit cannot invalidate an approved swap. */
export async function previewSchoolScheduling(options: {
  schoolId: string; config: SchoolSchedulingConfig; calendar?: SchedulingCalendar;
  dbInstance?: typeof db; now?: Date;
}): Promise<SchedulingPreview> {
  const database = options.dbInstance ?? db;
  const current = await getSchoolSchedulingContext(options.schoolId, database);
  const config = normalizeSchoolSchedulingConfig(options.config);
  const calendar = options.calendar ?? current.calendar;
  const [school] = await database.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId)).limit(1);
  const schoolTimezone = school?.timezone || "America/New_York";
  const now = options.now ?? new Date();
  const fromDate = localDateInTimeZone(now, schoolTimezone);
  const baselineConfig = { ...config, profileApplications: [] };
  const throughDate = [current.config.yearEnd, config.yearEnd, datePlusDays(fromDate, 370)].filter((d): d is string => !!d && d >= fromDate).sort().at(-1)!;
  const horizon = throughDate > datePlusDays(fromDate, 550) ? datePlusDays(fromDate, 550) : throughDate;
  const classRows = await database.select().from(groups).where(and(eq(groups.schoolId, options.schoolId), eq(groups.status, "active"), eq(groups.scheduleEnabled, true)));
  const [staff, frozen, approved] = await Promise.all([
    classRows.length ? database.select().from(groupTeachers).where(inArray(groupTeachers.groupId, classRows.map((g) => g.id))) : [],
    database.select({ id: teachingSessions.id, groupId: teachingSessions.groupId, date: teachingSessions.scheduledDate,
      teacherId: teachingSessions.teacherId, name: teachingSessions.classNameSnapshot, state: teachingSessions.scheduledState,
      startAt: teachingSessions.scheduledStartAt, endAt: teachingSessions.scheduledEndAt }).from(teachingSessions).where(and(eq(teachingSessions.schoolId, options.schoolId), sql`${teachingSessions.scheduledDate} >= ${fromDate}`)),
    database.select({ groupId: classpilotScheduleChangeLegs.groupId, date: classpilotScheduleChangeLegs.scheduledDate,
      startTime: classpilotScheduleChangeLegs.effectiveStartTime, endTime: classpilotScheduleChangeLegs.effectiveEndTime }).from(classpilotScheduleChangeLegs)
      .innerJoin(classpilotScheduleChanges, and(eq(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.scheduleChangeId), eq(classpilotScheduleChanges.schoolId, classpilotScheduleChangeLegs.schoolId)))
      .where(and(eq(classpilotScheduleChangeLegs.schoolId, options.schoolId), eq(classpilotScheduleChanges.status, "approved"), eq(classpilotScheduleChanges.reservationActive, true), sql`${classpilotScheduleChangeLegs.scheduledDate} >= ${fromDate}`)),
  ]);
  const frozenStaff = frozen.length ? await database.select().from(classpilotSessionStaff).where(and(eq(classpilotSessionStaff.schoolId, options.schoolId), inArray(classpilotSessionStaff.teachingSessionId, frozen.map((row) => row.id)))) : [];
  const frozenKeys = new Set(frozen.map((r) => `${r.groupId}:${r.date}`));
  const approvedWindows = new Map(approved.map((r) => [`${r.groupId}:${r.date}`, { startTime: r.startTime, endTime: r.endTime }]));
  const staffByClass = new Map(classRows.map((g) => [g.id, new Set([g.teacherId, ...staff.filter((r) => r.groupId === g.id).map((r) => r.teacherId)])]));
  const blockers: SchedulingPreview["blockers"] = [];
  const seenBlockers = new Set<string>();
  const block = (code: string, message: string, date?: string) => { const key = `${code}:${message}`; if (!seenBlockers.has(key)) { seenBlockers.add(key); if (blockers.length < 100) blockers.push({ code, message, ...(date ? { date } : {}) }); } };
  for (const group of classRows) {
    const rule = normalizeClassScheduleRule(group.scheduleRule);
    if (rule.periodId && !config.profiles.find((p) => p.id === config.defaultProfileId)?.periods[rule.periodId]) block("SCHEDULE_PERIOD_IN_USE", `${group.name} uses a period that is missing from the default bell profile.`);
    if (rule.cycleDay !== "all" && !config.cycleAnchorDate) block("SCHEDULE_CYCLE_IN_USE", `${group.name} uses A/B days. Keep a valid A/B anchor or update that class first.`);
  }
  if (config.cycleAnchorDate && !(resolveSchoolScheduleDay(config.cycleAnchorDate, config, calendar).instructional)) block("SCHEDULE_ANCHOR_CLOSED", "Choose an instructional date for the A/B anchor.");
  for (const date of new Set([...Object.keys(current.config.dateOverrides), ...Object.keys(config.dateOverrides)])) {
    if (date < fromDate && JSON.stringify(current.config.dateOverrides[date]) !== JSON.stringify(config.dateOverrides[date])) block("SCHEDULE_PAST_DATE_IMMUTABLE", "Past date overrides cannot be changed.", date);
  }
  const changes: SchedulingPreview["changes"] = [];
  const days: SchedulingPreview["days"] = [];
  let changedOccurrences = 0;
  const evaluationDates = new Set<string>();
  for (let date = fromDate; date <= horizon; date = datePlusDays(date, 1)) evaluationDates.add(date);
  for (const year of [current.config, config]) if (year.yearStart && year.yearEnd) {
    for (let date = year.yearStart > fromDate ? year.yearStart : fromDate; date <= year.yearEnd; date = datePlusDays(date, 1)) evaluationDates.add(date);
  }
  // An approved reservation or explicit exception is binding even beyond the
  // bounded calendar display. Always validate its exact date.
  for (const date of [...approved.map((row) => row.date), ...Object.keys(current.config.dateOverrides), ...Object.keys(config.dateOverrides)]) if (date >= fromDate) evaluationDates.add(date);
  for (const year of [current.config, config]) for (const application of year.profileApplications ?? []) if (application.status === "scheduled") {
    for (const date of application.dates) if (date >= fromDate) evaluationDates.add(date);
  }
  for (const group of classRows) {
    const startsOn = normalizeClassScheduleRule(group.scheduleRule).startsOn;
    if (startsOn && startsOn > horizon) for (let offset = 0; offset < 7; offset++) evaluationDates.add(datePlusDays(startsOn, offset));
  }
  for (const date of [...evaluationDates].sort()) {
    const nextDay = resolveSchoolScheduleDay(date, config, calendar);
    const oldDay = resolveSchoolScheduleDay(date, current.config, current.calendar);
    for (const application of config.profileApplications ?? []) if (application.status === "scheduled" && application.dates.includes(date)) {
      const reservedClassIds = Object.keys(application.classWindows[date] ?? {}).filter((classId) => !frozenKeys.has(`${classId}:${date}`));
      const unfinishedTesting = application.testingWindows.some((window) => window.date === date && localDateTimeUtc(date, window.endTime, schoolTimezone) > now);
      if (!nextDay.instructional && (reservedClassIds.length || unfinishedTesting)) block("SCHEDULE_PROFILE_APPLIED", "Cancel the applied schedule profile before closing its instructional date.", date);
      for (const classId of reservedClassIds) {
        const group = classRows.find((row) => row.id === classId);
        if (group) {
          let eligible = false;
          try { eligible = Boolean(resolveClassBaseWindow(group, date, baselineConfig, calendar, nextDay)); } catch { /* Include missing mappings in the preview blockers. */ }
          if (!eligible) block("SCHEDULE_PROFILE_APPLIED", "This calendar change would remove a class meeting reserved by an applied schedule profile.", date);
        }
      }
    }
    if (date <= horizon || [current.config, config].some((year) => year.yearStart && year.yearEnd && date >= year.yearStart && date <= year.yearEnd)) days.push(nextDay);
    const resolved: Array<{ name: string; staff: Set<string>; startAt: number; endAt: number }> = [];
    for (const occurrence of frozen.filter((row) => row.date === date && row.state !== "skipped")) {
      if (!occurrence.startAt || !occurrence.endAt) continue;
      resolved.push({ name: occurrence.name ?? classRows.find((g) => g.id === occurrence.groupId)?.name ?? "Frozen class",
        staff: new Set([occurrence.teacherId, ...frozenStaff.filter((row) => row.teachingSessionId === occurrence.id).map((row) => row.staffId)]),
        startAt: occurrence.startAt.getTime(), endAt: occurrence.endAt.getTime() });
    }
    for (const group of classRows) {
      if (frozenKeys.has(`${group.id}:${date}`)) continue;
      let before, after;
      try { before = resolveClassBaseWindow(group, date, current.config, current.calendar, oldDay); } catch { before = null; }
      try { after = resolveClassBaseWindow(group, date, config, calendar, nextDay); }
      catch (error) { block("SCHEDULE_PERIOD_UNAVAILABLE", `${group.name}: ${(error as Error).message}`, date); continue; }
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        if (date === fromDate && before && now >= localDateTimeUtc(date, before.startTime, schoolTimezone) && now < localDateTimeUtc(date, before.endTime, schoolTimezone)) block("SCHEDULE_WINDOW_IN_PROGRESS", "A current class window has not been frozen yet. Wait for it to start or end before changing the window.", date);
        changedOccurrences++;
        if (changes.length < 150) changes.push({ date, classId: group.id, className: group.name, before, after });
        if (approvedWindows.has(`${group.id}:${date}`)) block("SCHEDULE_CHANGE_APPROVED", "Cancel an affected approved schedule change before changing its base window.", date);
      }
      const effectiveWindow = approvedWindows.get(`${group.id}:${date}`) ?? after;
      if (effectiveWindow) resolved.push({ name: group.name, staff: staffByClass.get(group.id)!,
        startAt: localDateTimeUtc(date, effectiveWindow.startTime, schoolTimezone).getTime(),
        endAt: localDateTimeUtc(date, effectiveWindow.endTime, schoolTimezone).getTime() });
    }
    resolved.sort((a, b) => a.startAt - b.startAt);
    for (let i = 0; i < resolved.length; i++) for (let j = i + 1; j < resolved.length && resolved[j]!.startAt < resolved[i]!.endAt; j++) {
      const a = resolved[i]!, b = resolved[j]!;
      if ([...a.staff].some((id) => b.staff.has(id))) block("CLASS_SCHEDULE_CONFLICT", `${a.name} and ${b.name} overlap for an assigned teacher.`, date);
    }
  }
  const calendarIdentity = Object.fromEntries(Object.entries(calendar).sort(([a], [b]) => a.localeCompare(b)).map(([month, value]) => [month, [...(value.nonInstructionalDates ?? [])].sort()]));
  const previewToken = createHash("sha256").update(JSON.stringify({ current, config, calendar: calendarIdentity, classRows, staff, frozen, frozenStaff, approved, fromDate })).digest("hex");
  return { revision: current.revision, previewToken, schoolTimezone, fromDate, throughDate: days.at(-1)?.date ?? horizon, changedOccurrences, changes, blockers, days };
}

export async function saveSchoolScheduling(options: { schoolId: string; config: unknown; expectedRevision: number; previewToken: string; actorId: string }) {
  const config = normalizeSchoolSchedulingConfig(options.config);
  const { withClasspilotSchedulePostCommitTransaction, supersedePendingScheduleChangesForGroup, recordClasspilotMonitoringPolicyChange } = await import("./storage.js");
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    const database = tx as unknown as typeof db;
    if (!await lockStaffAssignmentLifecycleSchool(tx as unknown as Parameters<typeof lockStaffAssignmentLifecycleSchool>[0], options.schoolId)) throw schedulingError("School not found.", "SCHOOL_NOT_FOUND", 404);
    await database.select({ id: schools.id }).from(schools).where(eq(schools.id, options.schoolId)).for("update");
    await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${options.schoolId}`}))`);
    await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    const current = await getSchoolSchedulingContext(options.schoolId, database);
    if (JSON.stringify(current.config.scheduleProfiles ?? []) !== JSON.stringify(config.scheduleProfiles ?? []) || JSON.stringify(current.config.profileApplications ?? []) !== JSON.stringify(config.profileApplications ?? [])) {
      throw schedulingError("Use Schedule Profiles to save, apply, or cancel a profile. Reload this calendar draft to keep current profile applications.", "SCHEDULE_PROFILE_WORKFLOW_REQUIRED", 409);
    }
    const preview = await previewSchoolScheduling({ schoolId: options.schoolId, config, dbInstance: database });
    if (preview.revision !== options.expectedRevision || preview.previewToken !== options.previewToken) throw schedulingError("Schedules changed since this preview. Preview the changes again.", "SCHEDULE_PREVIEW_STALE", 409);
    if (preview.blockers.length) throw schedulingError(preview.blockers[0]!.message, preview.blockers[0]!.code, 409);
    const [saved] = await database.insert(classpilotSchoolSchedules).values({ schoolId: options.schoolId, config, revision: preview.revision + 1, updatedBy: options.actorId })
      .onConflictDoUpdate({ target: classpilotSchoolSchedules.schoolId, set: { config, revision: preview.revision + 1, updatedAt: new Date(), updatedBy: options.actorId } }).returning();
    recordClasspilotMonitoringPolicyChange(database, options.schoolId);
    // A pending request was previewed against older base windows. Supersede it
    // through the existing workflow helper; approved unaffected swaps remain.
    const affected = new Set(preview.changes.map((change) => change.classId));
    // changes is a bounded display sample, so use every scheduled class when
    // there are more changes than displayed to avoid truncating workflow work.
    if (preview.changedOccurrences > preview.changes.length) {
      for (const group of await database.select({ id: groups.id }).from(groups).where(eq(groups.schoolId, options.schoolId))) affected.add(group.id);
    }
    for (const groupId of affected) await supersedePendingScheduleChangesForGroup({ schoolId: options.schoolId, groupId, actorId: options.actorId, reason: "class_configuration_changed", dbInstance: database });
    return { config: saved!.config, revision: saved!.revision, changedOccurrences: preview.changedOccurrences };
  });
}
