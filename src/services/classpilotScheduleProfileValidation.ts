import { createHash } from "node:crypto";
import type db from "../db.js";
import type { HeartbeatTrackingSettings } from "./storage.js";
import type { ScheduleProfileTestingWindow } from "./classpilotScheduleProfileModel.js";
import { SCHEDULE_PROFILE_LIMITS } from "./classpilotScheduleProfileModel.js";
import { resolveClasspilotMonitoringPolicy } from "./classpilotMonitoringPolicy.js";
import { isSchedulingInstructionalDate, normalizeSchoolSchedulingConfig, resolveClassBaseWindow,
  type SchedulingCalendar, type SchedulingGroup, type SchoolSchedulingConfig } from "./classpilotSchedulingRules.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";

type Blocker = { code: string; message: string; date?: string };
type ObligationGroup = SchedulingGroup & { id: string; name: string; staffIds: string[]; studentIds: string[] };
type ObligationSession = {
  id: string; groupId: string; name: string; date: string | null; scheduledState: string | null;
  startAt: string; endAt: string | null; rosterComplete: boolean; staffIds: string[]; studentIds: string[];
};
export type ScheduleProfileValidationFacts = {
  schoolTimezone: string;
  tracking: HeartbeatTrackingSettings | undefined;
  config: SchoolSchedulingConfig;
  calendar: SchedulingCalendar;
  groups: ObligationGroup[];
  sessions: ObligationSession[];
  approved: Array<{ id: string; groupId: string; date: string; startTime: string; endTime: string }>;
  today: string;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const fingerprint = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

/** Testing a whole class is allowed; other pupils remain a proctor obligation. */
export function testingRosterHasOtherClassStudents(classStudents: string[], testingStudents: ReadonlySet<string>): boolean {
  return classStudents.some((id) => !testingStudents.has(id));
}

/** Exact transition probes also catch an overnight tracking window's daytime gap. */
export function scheduleProfileWindowHasFullMonitoring(window: Pick<ScheduleProfileTestingWindow, "date" | "startTime" | "endTime">, tracking: HeartbeatTrackingSettings | undefined): boolean {
  if (!tracking) return false;
  const timezone = tracking.schoolTimezone || "America/New_York";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0)); } catch { return false; }
  if (!isSchedulingInstructionalDate(window.date, tracking.instructionalCalendar ?? {}, tracking.schedulingDateOverrides ?? {})) return false;
  const start = localDateTimeUtc(window.date, window.startTime, timezone).getTime();
  const end = localDateTimeUtc(window.date, window.endTime, timezone).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const probes = new Set([start, end - 1]);
  if (tracking.enableTrackingHours) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(tracking.trackingStartTime ?? "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(tracking.trackingEndTime ?? "")) return false;
    const opens = localDateTimeUtc(window.date, tracking.trackingStartTime!, timezone).getTime();
    // The canonical predicate includes the configured end minute.
    const closes = localDateTimeUtc(window.date, tracking.trackingEndTime!, timezone).getTime() + 60_000;
    for (const boundary of [opens, closes]) for (const probe of [boundary - 1, boundary]) if (probe >= start && probe < end) probes.add(probe);
  }
  return [...probes].every((probe) => resolveClasspilotMonitoringPolicy(tracking, { now: new Date(probe) }).policyMode === "full");
}

/** Pure evaluation keeps precedence and boundary behavior independently testable. */
export function evaluateScheduleProfileTestingWindows(testingWindows: ScheduleProfileTestingWindow[], facts: ScheduleProfileValidationFacts): { blockers: Blocker[]; fingerprint: string } {
  const blockers: Blocker[] = [];
  const seen = new Set<string>();
  const block = (code: string, message: string, date?: string) => {
    const key = `${code}:${date}:${message}`;
    if (!seen.has(key) && blockers.length < 100) { seen.add(key); blockers.push({ code, message, ...(date ? { date } : {}) }); }
  };
  const tracking = facts.tracking && { ...facts.tracking, schoolTimezone: facts.schoolTimezone,
    instructionalCalendar: facts.calendar, schedulingDateOverrides: facts.config.dateOverrides };
  const frozen = new Map(facts.sessions.filter((s) => s.date).map((s) => [`${s.groupId}:${s.date}`, s]));
  const approved = new Map(facts.approved.map((leg) => [`${leg.groupId}:${leg.date}`, leg]));
  const classById = new Map(facts.groups.map((g) => [g.id, g]));
  for (const window of testingWindows) {
    if (!scheduleProfileWindowHasFullMonitoring(window, tracking)) block("SCHEDULE_PROFILE_MONITORING_NOT_FULL", `${window.name}: full classroom monitoring must be available throughout this testing block. Review Monitoring Hours.`, window.date);
    const start = localDateTimeUtc(window.date, window.startTime, facts.schoolTimezone).getTime();
    const end = localDateTimeUtc(window.date, window.endTime, facts.schoolTimezone).getTime();
    const targets = new Set(window.studentIds);
    const conflicts = (name: string, students: string[], complete: boolean) => {
      if (!complete) block("SCHEDULE_PROFILE_FROZEN_ROSTER_UNAVAILABLE", `${window.name}: ${name} has an incomplete frozen roster. Resolve that class session before assigning its teacher.`, window.date);
      else if (testingRosterHasOtherClassStudents(students, targets)) block("SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT", `${window.name}: the assigned staff member also teaches ${name} during this block. Include that entire class in testing, adjust the class, or choose another proctor.`, window.date);
    };
    for (const session of facts.sessions) {
      if (!session.staffIds.includes(window.assignedStaffId) || session.scheduledState === "skipped") continue;
      if (session.date ? session.date !== window.date : window.date !== facts.today) continue;
      const sessionStart = Date.parse(session.startAt), sessionEnd = session.endAt ? Date.parse(session.endAt) : Infinity;
      if (sessionStart < end && sessionEnd > start) conflicts(session.name || classById.get(session.groupId)?.name || "Recorded class", session.studentIds, session.rosterComplete);
    }
    for (const group of facts.groups) {
      if (!group.staffIds.includes(window.assignedStaffId) || frozen.has(`${group.id}:${window.date}`)) continue;
      let classWindow;
      try { classWindow = resolveClassBaseWindow(group, window.date, facts.config, facts.calendar); }
      catch { block("SCHEDULE_PROFILE_CLASS_WINDOW_UNAVAILABLE", `${window.name}: ${group.name} has an unresolved schedule. Fix its period or calendar mapping first.`, window.date); continue; }
      const leg = approved.get(`${group.id}:${window.date}`);
      // The normal class resolver first requires an eligible base occurrence.
      if (!classWindow) {
        if (leg) block("SCHEDULE_PROFILE_CLASS_WINDOW_UNAVAILABLE", `${window.name}: an approved schedule change for ${group.name} has no eligible base occurrence. Resolve the schedule change first.`, window.date);
        continue;
      }
      const effective = leg ?? classWindow;
      const classStart = localDateTimeUtc(window.date, effective.startTime, facts.schoolTimezone).getTime();
      const classEnd = localDateTimeUtc(window.date, effective.endTime, facts.schoolTimezone).getTime();
      if (classStart < end && classEnd > start) conflicts(group.name, group.studentIds, true);
    }
  }
  return { blockers, fingerprint: fingerprint({ testingWindows, ...facts, tracking }) };
}

/**
 * Call inside the school lifecycle transaction for writes/activation. Preview
 * reads are revalidated and fingerprinted by the caller before committing.
 */
export async function validateScheduleProfileTestingWindows(options: {
  schoolId: string; testingWindows: ScheduleProfileTestingWindow[]; config?: SchoolSchedulingConfig;
  calendar?: SchedulingCalendar; dbInstance?: typeof db; now?: Date;
}): Promise<{ blockers: Blocker[]; fingerprint: string }> {
  if (!options.testingWindows.length) return { blockers: [], fingerprint: fingerprint({ testingWindows: [] }) };
  if (options.testingWindows.length > SCHEDULE_PROFILE_LIMITS.testingWindows) return { blockers: [{ code: "SCHEDULE_PROFILE_VALIDATION_LIMIT", message: "Too many testing blocks to validate together." }], fingerprint: fingerprint({ limit: true }) };
  const [{ default: defaultDb }, schema, core, studentSchema, operators, storage, scheduling] = await Promise.all([
    import("../db.js"), import("../schema/classpilot.js"), import("../schema/core.js"), import("../schema/students.js"),
    import("drizzle-orm"), import("./storage.js"), import("./classpilotScheduling.js"),
  ]);
  const database = options.dbInstance ?? defaultDb;
  const { and, eq, inArray, isNull, lt, gt, or } = operators;
  const { groups, groupTeachers, groupStudents, teachingSessions, classpilotSessionStaff, classpilotSessionStudents, classpilotScheduleChangeLegs, classpilotScheduleChanges } = schema;
  const dates = [...new Set(options.testingWindows.map((w) => w.date))].sort();
  const proctors = [...new Set(options.testingWindows.map((w) => w.assignedStaffId))].sort();
  const [tracking, context, schoolRows] = await Promise.all([
    storage.getHeartbeatTrackingSettingsForSchool(options.schoolId, database, { lock: true, bypassCache: true }),
    options.config && options.calendar ? Promise.resolve({ config: options.config, calendar: options.calendar }) : scheduling.getSchoolSchedulingContext(options.schoolId, database),
    database.select({ timezone: core.schools.schoolTimezone }).from(core.schools).where(eq(core.schools.id, options.schoolId)).limit(1),
  ]);
  const schoolTimezone = schoolRows[0]?.timezone || "America/New_York";
  const config = normalizeSchoolSchedulingConfig(options.config ?? context.config), calendar = options.calendar ?? context.calendar;
  const today = localDateInTimeZone(options.now ?? new Date(), schoolTimezone);
  // Explicit caps fail closed; queries never truncate into an apparently safe preview.
  const MAX_GROUPS = 5_000, MAX_SESSIONS = 50_000, MAX_RELATIONSHIPS = 250_000;
  const limitResult = () => ({ blockers: [{ code: "SCHEDULE_PROFILE_VALIDATION_LIMIT", message: "This school has too many related class records to validate safely in one preview. Narrow the testing selection." }], fingerprint: fingerprint({ schoolId: options.schoolId, dates, proctors, limit: true }) });
  const rawGroups = await database.select({ group: groups }).from(groups).leftJoin(groupTeachers, and(eq(groupTeachers.groupId, groups.id), inArray(groupTeachers.teacherId, proctors)))
    .where(and(eq(groups.schoolId, options.schoolId), eq(groups.status, "active"), eq(groups.scheduleEnabled, true), or(inArray(groups.teacherId, proctors), inArray(groupTeachers.teacherId, proctors))))
    .orderBy(groups.id).limit(MAX_GROUPS + 1);
  if (rawGroups.length > MAX_GROUPS) return limitResult();
  const selectedGroups = [...new Map(rawGroups.map(({ group }) => [group.id, group])).values()];
  const groupIds = selectedGroups.map((g) => g.id);
  const first = localDateTimeUtc(dates[0]!, "00:00", schoolTimezone);
  const last = new Date(localDateTimeUtc(dates.at(-1)!, "23:59", schoolTimezone).getTime() + 60_000);
  const sessionAuthority = or(inArray(teachingSessions.teacherId, proctors), inArray(classpilotSessionStaff.staffId, proctors));
  const rawSessions = await database.select({ session: teachingSessions }).from(teachingSessions)
    .leftJoin(classpilotSessionStaff, and(eq(classpilotSessionStaff.schoolId, options.schoolId), eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id), inArray(classpilotSessionStaff.staffId, proctors)))
    .where(and(eq(teachingSessions.schoolId, options.schoolId), or(
      and(inArray(teachingSessions.scheduledDate, dates), or(sessionAuthority, groupIds.length ? inArray(teachingSessions.groupId, groupIds) : undefined)),
      dates.includes(today) ? and(isNull(teachingSessions.scheduledDate), sessionAuthority, lt(teachingSessions.startTime, last), or(isNull(teachingSessions.endTime), gt(teachingSessions.endTime, first))) : undefined,
    ))).orderBy(teachingSessions.id).limit(MAX_SESSIONS + 1);
  if (rawSessions.length > MAX_SESSIONS) return limitResult();
  const sessions = [...new Map(rawSessions.map(({ session }) => [session.id, session])).values()];
  const sessionIds = sessions.map((s) => s.id);
  const [classStaff, classStudents, sessionStaff, sessionStudents, approved] = await Promise.all([
    groupIds.length ? database.select({ groupId: groupTeachers.groupId, staffId: groupTeachers.teacherId }).from(groupTeachers).innerJoin(groups, and(eq(groups.id, groupTeachers.groupId), eq(groups.schoolId, options.schoolId)))
      .where(inArray(groupTeachers.groupId, groupIds)).orderBy(groupTeachers.groupId, groupTeachers.teacherId).limit(MAX_RELATIONSHIPS + 1) : [],
    groupIds.length ? database.select({ groupId: groupStudents.groupId, studentId: groupStudents.studentId }).from(groupStudents).innerJoin(groups, and(eq(groups.id, groupStudents.groupId), eq(groups.schoolId, options.schoolId)))
      .innerJoin(studentSchema.students, and(eq(studentSchema.students.id, groupStudents.studentId), eq(studentSchema.students.schoolId, options.schoolId), eq(studentSchema.students.status, "active")))
      .where(inArray(groupStudents.groupId, groupIds)).orderBy(groupStudents.groupId, groupStudents.studentId).limit(MAX_RELATIONSHIPS + 1) : [],
    sessionIds.length ? database.select({ sessionId: classpilotSessionStaff.teachingSessionId, staffId: classpilotSessionStaff.staffId }).from(classpilotSessionStaff)
      .where(and(eq(classpilotSessionStaff.schoolId, options.schoolId), inArray(classpilotSessionStaff.teachingSessionId, sessionIds))).orderBy(classpilotSessionStaff.teachingSessionId, classpilotSessionStaff.staffId).limit(MAX_RELATIONSHIPS + 1) : [],
    sessionIds.length ? database.select({ sessionId: classpilotSessionStudents.teachingSessionId, studentId: classpilotSessionStudents.studentId }).from(classpilotSessionStudents)
      .where(and(eq(classpilotSessionStudents.schoolId, options.schoolId), inArray(classpilotSessionStudents.teachingSessionId, sessionIds))).orderBy(classpilotSessionStudents.teachingSessionId, classpilotSessionStudents.studentId).limit(MAX_RELATIONSHIPS + 1) : [],
    groupIds.length ? database.select({ id: classpilotScheduleChangeLegs.id, groupId: classpilotScheduleChangeLegs.groupId, date: classpilotScheduleChangeLegs.scheduledDate,
      startTime: classpilotScheduleChangeLegs.effectiveStartTime, endTime: classpilotScheduleChangeLegs.effectiveEndTime }).from(classpilotScheduleChangeLegs)
      .innerJoin(classpilotScheduleChanges, and(eq(classpilotScheduleChanges.schoolId, options.schoolId), eq(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.scheduleChangeId)))
      .where(and(eq(classpilotScheduleChangeLegs.schoolId, options.schoolId), inArray(classpilotScheduleChangeLegs.groupId, groupIds), inArray(classpilotScheduleChangeLegs.scheduledDate, dates), eq(classpilotScheduleChangeLegs.reservationActive, true), eq(classpilotScheduleChanges.status, "approved"), eq(classpilotScheduleChanges.reservationActive, true)))
      .orderBy(classpilotScheduleChangeLegs.id).limit(MAX_SESSIONS + 1) : [],
  ]);
  if ([classStaff, classStudents, sessionStaff, sessionStudents].some((rows) => rows.length > MAX_RELATIONSHIPS) || approved.length > MAX_SESSIONS) return limitResult();
  function indexed(rows: Array<{ parent: string; value: string }>) {
    const map = new Map<string, string[]>();
    for (const row of rows) { const values = map.get(row.parent) ?? []; values.push(row.value); map.set(row.parent, values); }
    return map;
  }
  const staffByGroup = indexed(classStaff.map((r) => ({ parent: r.groupId, value: r.staffId })));
  const studentsByGroup = indexed(classStudents.map((r) => ({ parent: r.groupId, value: r.studentId })));
  const staffBySession = indexed(sessionStaff.map((r) => ({ parent: r.sessionId, value: r.staffId })));
  const studentsBySession = indexed(sessionStudents.map((r) => ({ parent: r.sessionId, value: r.studentId })));
  return evaluateScheduleProfileTestingWindows(options.testingWindows, {
    schoolTimezone, tracking, config, calendar, today, approved,
    groups: selectedGroups.map((g) => ({ id: g.id, name: g.name, scheduleEnabled: g.scheduleEnabled, blockStartTime: g.blockStartTime, blockEndTime: g.blockEndTime, scheduleRule: g.scheduleRule,
      staffIds: [...new Set([g.teacherId, ...(staffByGroup.get(g.id) ?? [])])].sort(), studentIds: studentsByGroup.get(g.id) ?? [] })),
    sessions: sessions.map((s) => ({ id: s.id, groupId: s.groupId, name: s.classNameSnapshot || selectedGroups.find((g) => g.id === s.groupId)?.name || "Recorded class", date: s.scheduledDate,
      scheduledState: s.scheduledState, startAt: (s.scheduledStartAt ?? s.startTime).toISOString(), endAt: (s.scheduledEndAt ?? s.endTime)?.toISOString() ?? null,
      rosterComplete: Boolean(s.rosterSnapshotCompletedAt), staffIds: [...new Set([s.teacherId, ...(staffBySession.get(s.id) ?? [])])].sort(), studentIds: studentsBySession.get(s.id) ?? [] })),
  });
}
