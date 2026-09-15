import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type db from "../db.js";
import { groups, groupStudents, groupTeachers, teachingSessions, classpilotSessionStudents, classpilotSessionStaff,
  classpilotScheduleChangeLegs, classpilotScheduleChanges, classpilotSupervisionContexts, classpilotSupervisionStudents } from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import { getHeartbeatTrackingSettingsForSchool } from "./storage.js";
import { evaluateScheduleProfileTestingWindows, type ScheduleProfileValidationFacts } from "./classpilotScheduleProfileValidation.js";
import { resolveClassBaseWindow, type SchoolSchedulingConfig, type SchedulingCalendar } from "./classpilotSchedulingRules.js";
import { analyzeScheduleStudents, type StudentAnalysisClass, type StudentAnalysisTesting } from "./classpilotScheduleStudentAnalysis.js";
import type { ScheduleProfileTestingWindow } from "./classpilotScheduleProfileModel.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";

type Options = {
  schoolId: string; dates: string[]; schoolTimezone: string; now: Date; database: typeof db;
  baseline: SchoolSchedulingConfig; config: SchoolSchedulingConfig; calendar: SchedulingCalendar;
  testingWindows: ScheduleProfileTestingWindow[]; staff: Array<{ id: string; name: string }>;
  supervisionGroups: Array<{ id: string; studentIds: string[]; inactiveStudents: number; staffIds: string[] }>;
};
type Blocker = { code: string; message: string; date?: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const LIMITS = { classes: 5_000, sessions: 50_000, relationships: 250_000 };
function index(rows: Array<{ parent: string; value: string }>) {
  const result = new Map<string, string[]>();
  for (const row of rows) { const values = result.get(row.parent) ?? []; values.push(row.value); result.set(row.parent, values); }
  return result;
}

/** Full-school facts, including captured session authority, for each actual application date.
 * The caller re-runs this inside the lifecycle/class-source transaction before committing.
 */
export async function reviewScheduleApplicationStudents(options: Options) {
  const { database, schoolId, dates, schoolTimezone, now } = options;
  const unavailable = () => ({ complete: false, blockers: [{ code: "SCHEDULE_PROFILE_STUDENT_REVIEW_LIMIT",
    message: "Student schedule checks could not complete within the analysis limits. No handoff is verified. Review fewer dates or classes before applying." }] as Blocker[],
    studentConflicts: [] as Array<{ date: string; classIds: string[]; staffIds: string[]; startTime: string; endTime: string; studentCount: number; newStudentCount: number; change: string }>,
    afterTesting: options.testingWindows.map(w => ({ date: w.date, blockId: w.blockId, status: "unavailable" as "ready" | "unavailable", studentCount: null as number | null,
      allocations: [] as Array<{ kind: string; studentCount: number; classIds: string[]; blockIds: string[]; classNames?: string[]; blockNames?: string[]; staff: Array<{ id: string; name: string }>; at: string | null }> })),
    fingerprint: digest({ schoolId, dates, unavailable: true }) });
  const first = localDateTimeUtc(dates[0]!, "00:00", schoolTimezone);
  const last = new Date(localDateTimeUtc(dates.at(-1)!, "23:59", schoolTimezone).getTime() + 60_000);
  const today = localDateInTimeZone(now, schoolTimezone);
  const [classRows, sessions, contexts, tracking] = await Promise.all([
    database.select().from(groups).where(and(eq(groups.schoolId, schoolId), eq(groups.status, "active"))).orderBy(groups.id).limit(LIMITS.classes + 1),
    database.select().from(teachingSessions).where(and(eq(teachingSessions.schoolId, schoolId), or(
      inArray(teachingSessions.scheduledDate, dates),
      dates.includes(today) ? and(isNull(teachingSessions.scheduledDate), lt(teachingSessions.startTime, last), or(isNull(teachingSessions.endTime), gt(teachingSessions.endTime, first))) : undefined,
    ))).orderBy(teachingSessions.id).limit(LIMITS.sessions + 1),
    database.select().from(classpilotSupervisionContexts).where(and(eq(classpilotSupervisionContexts.schoolId, schoolId),
      eq(classpilotSupervisionContexts.status, "active"), lt(classpilotSupervisionContexts.startsAt, last), gt(classpilotSupervisionContexts.endsAt, first)))
      .orderBy(classpilotSupervisionContexts.id).limit(LIMITS.sessions + 1),
    getHeartbeatTrackingSettingsForSchool(schoolId, database, { lock: true, bypassCache: true }),
  ]);
  if (classRows.length > LIMITS.classes || sessions.length > LIMITS.sessions || contexts.length > LIMITS.sessions) return unavailable();
  const groupIds = classRows.map(g => g.id), sessionIds = sessions.map(s => s.id), contextIds = contexts.map(c => c.id);
  const [classStaff, classStudents, sessionStaff, sessionStudents, supervisedStudents, approved] = await Promise.all([
    groupIds.length ? database.select({ parent: groupTeachers.groupId, value: groupTeachers.teacherId }).from(groupTeachers)
      .innerJoin(groups, and(eq(groups.id, groupTeachers.groupId), eq(groups.schoolId, schoolId)))
      .where(inArray(groupTeachers.groupId, groupIds)).orderBy(groupTeachers.groupId, groupTeachers.teacherId).limit(LIMITS.relationships + 1) : [],
    groupIds.length ? database.select({ parent: groupStudents.groupId, value: groupStudents.studentId }).from(groupStudents)
      .innerJoin(groups, and(eq(groups.id, groupStudents.groupId), eq(groups.schoolId, schoolId)))
      .innerJoin(students, and(eq(students.id, groupStudents.studentId), eq(students.schoolId, schoolId), eq(students.status, "active")))
      .where(inArray(groupStudents.groupId, groupIds)).orderBy(groupStudents.groupId, groupStudents.studentId).limit(LIMITS.relationships + 1) : [],
    sessionIds.length ? database.select({ parent: classpilotSessionStaff.teachingSessionId, value: classpilotSessionStaff.staffId }).from(classpilotSessionStaff)
      .where(and(eq(classpilotSessionStaff.schoolId, schoolId), inArray(classpilotSessionStaff.teachingSessionId, sessionIds)))
      .orderBy(classpilotSessionStaff.teachingSessionId, classpilotSessionStaff.staffId).limit(LIMITS.relationships + 1) : [],
    sessionIds.length ? database.select({ parent: classpilotSessionStudents.teachingSessionId, value: classpilotSessionStudents.studentId }).from(classpilotSessionStudents)
      .where(and(eq(classpilotSessionStudents.schoolId, schoolId), inArray(classpilotSessionStudents.teachingSessionId, sessionIds)))
      .orderBy(classpilotSessionStudents.teachingSessionId, classpilotSessionStudents.studentId).limit(LIMITS.relationships + 1) : [],
    contextIds.length ? database.select({ parent: classpilotSupervisionStudents.contextId, value: classpilotSupervisionStudents.studentId }).from(classpilotSupervisionStudents)
      .where(and(eq(classpilotSupervisionStudents.schoolId, schoolId), inArray(classpilotSupervisionStudents.contextId, contextIds), isNull(classpilotSupervisionStudents.releasedAt)))
      .orderBy(classpilotSupervisionStudents.contextId, classpilotSupervisionStudents.studentId).limit(LIMITS.relationships + 1) : [],
    database.select({ id: classpilotScheduleChangeLegs.id, groupId: classpilotScheduleChangeLegs.groupId, date: classpilotScheduleChangeLegs.scheduledDate,
      startTime: classpilotScheduleChangeLegs.effectiveStartTime, endTime: classpilotScheduleChangeLegs.effectiveEndTime }).from(classpilotScheduleChangeLegs)
      .innerJoin(classpilotScheduleChanges, and(eq(classpilotScheduleChanges.id, classpilotScheduleChangeLegs.scheduleChangeId), eq(classpilotScheduleChanges.schoolId, schoolId)))
      .where(and(eq(classpilotScheduleChangeLegs.schoolId, schoolId), inArray(classpilotScheduleChangeLegs.scheduledDate, dates),
        eq(classpilotScheduleChangeLegs.reservationActive, true), eq(classpilotScheduleChanges.status, "approved"), eq(classpilotScheduleChanges.reservationActive, true)))
      .orderBy(classpilotScheduleChangeLegs.id).limit(LIMITS.sessions + 1),
  ]);
  if ([classStaff, classStudents, sessionStaff, sessionStudents, supervisedStudents].some(r => r.length > LIMITS.relationships) || approved.length > LIMITS.sessions) return unavailable();
  const staffByGroup = index(classStaff), rosterByGroup = index(classStudents), staffBySession = index(sessionStaff), rosterBySession = index(sessionStudents), rosterByContext = index(supervisedStudents);
  const staffNames = new Map(options.staff.map(s => [s.id, s]));
  const staff = (ids: string[]) => [...new Set(ids)].sort().flatMap(id => staffNames.has(id) ? [staffNames.get(id)!] : []);
  const facts: ScheduleProfileValidationFacts = { schoolTimezone, tracking, calendar: options.calendar, config: options.config, today, approved,
    groups: classRows.map(g => ({ ...g, staffIds: [...new Set([g.teacherId, ...(staffByGroup.get(g.id) ?? [])])].sort(), studentIds: rosterByGroup.get(g.id) ?? [] })),
    sessions: sessions.map(s => ({ id: s.id, groupId: s.groupId, name: s.classNameSnapshot || classRows.find(g => g.id === s.groupId)?.name || "Recorded class",
      date: s.scheduledDate, scheduledState: s.scheduledState, startAt: (s.scheduledStartAt ?? s.startTime).toISOString(),
      endAt: s.scheduledEndAt && s.endTime ? new Date(Math.min(s.scheduledEndAt.getTime(), s.endTime.getTime())).toISOString() : (s.scheduledEndAt ?? s.endTime)?.toISOString() ?? null,
      rosterComplete: Boolean(s.rosterSnapshotCompletedAt), staffIds: [...new Set([s.teacherId, ...(staffBySession.get(s.id) ?? [])])].sort(), studentIds: rosterBySession.get(s.id) ?? [] })),
  };
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: schoolTimezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const at = (value: number) => clock.format(new Date(value));
  const interval = (date: string, window: { startTime: string; endTime: string }) => ({ start: localDateTimeUtc(date, window.startTime, schoolTimezone).getTime(), end: localDateTimeUtc(date, window.endTime, schoolTimezone).getTime() });
  const resolve = (date: string, config: SchoolSchedulingConfig): StudentAnalysisClass[] => {
    const frozen = facts.sessions.filter(s => s.date === date), frozenIds = new Set(frozen.map(s => s.groupId));
    const rows: StudentAnalysisClass[] = [];
    for (const g of facts.groups) {
      if (frozenIds.has(g.id)) continue;
      const row: StudentAnalysisClass = { classId: g.id, name: g.name, staff: staff(g.staffIds), studentIds: g.studentIds, window: null };
      const legs = approved.filter(l => l.groupId === g.id && l.date === date);
      try {
        const window = resolveClassBaseWindow(g, date, config, options.calendar);
        if (legs.length > 1 || (!window && legs.length)) row.unavailable = true;
        else if (window) { row.window = interval(date, legs[0] ?? window); row.unavailable = g.staffIds.some(id => !staffNames.has(id)); }
      } catch { row.unavailable = true; }
      // An undated recorded session and a possible scheduled occurrence can
      // have different captured/current authority. Do not invent a merged
      // roster or a manual-overrides-scheduled rule for that ambiguous window.
      if (date === today && row.window && facts.sessions.some(s => !s.date && s.groupId === g.id && s.scheduledState !== "skipped"
        && Date.parse(s.startAt) < row.window!.end && (!s.endAt || Date.parse(s.endAt) > row.window!.start))) row.unavailable = true;
      rows.push(row);
    }
    for (const s of facts.sessions.filter(s => s.date === date || (!s.date && date === today))) {
      if (s.scheduledState === "skipped") continue;
      const dayStart = localDateTimeUtc(date, "00:00", schoolTimezone).getTime(), dayEnd = localDateTimeUtc(date, "23:59", schoolTimezone).getTime() + 60_000;
      const start = Math.max(dayStart, Date.parse(s.startAt)), end = Math.min(dayEnd, s.endAt ? Date.parse(s.endAt) : dayEnd);
      if (end <= start) continue;
      rows.push({ classId: s.groupId, name: s.name, staff: staff(s.staffIds), studentIds: s.rosterComplete ? s.studentIds : null,
        window: { start, end }, unavailable: !s.rosterComplete || !s.endAt || s.staffIds.some(id => !staffNames.has(id)) });
    }
    for (const leg of approved.filter(l => l.date === date && !facts.groups.some(g => g.id === l.groupId) && !frozenIds.has(l.groupId)))
      rows.push({ classId: leg.groupId, name: "Unavailable class", staff: [], studentIds: null, window: interval(date, leg), unavailable: true });
    return rows;
  };
  const testing = (date: string, config: SchoolSchedulingConfig): StudentAnalysisTesting[] => {
    // Saved, never-activated past blocks cannot establish current supervision.
    const windows = (config.profileApplications ?? []).filter(a => a.status === "scheduled").flatMap(a => a.testingWindows)
      .filter(w => w.date === date && localDateTimeUtc(date, w.startTime, schoolTimezone) > now);
    const rows: StudentAnalysisTesting[] = windows.map(w => {
      const valid = !evaluateScheduleProfileTestingWindows([w], { ...facts, config }, { fingerprint: false }).blockers.length;
      const group = options.supervisionGroups.find(g => g.id === w.coverageGroupId);
      const frozenStudents = new Set(w.studentIds), currentStudents = new Set(group?.studentIds ?? []);
      const eligible = group && !group.inactiveStudents && group.staffIds.includes(w.assignedStaffId) && staffNames.has(w.assignedStaffId)
        && frozenStudents.size > 0 && frozenStudents.size <= 500 && frozenStudents.size === currentStudents.size && [...frozenStudents].every(id => currentStudents.has(id));
      return { blockId: options.testingWindows.includes(w) ? w.blockId : `existing:${w.blockId}:${w.startTime}`, name: w.name, staff: staff([w.assignedStaffId]), studentIds: w.studentIds, window: interval(date, w), validForPrecedence: Boolean(valid && eligible) };
    });
    for (const c of contexts) {
      const dayStart = localDateTimeUtc(date, "00:00", schoolTimezone).getTime(), dayEnd = localDateTimeUtc(date, "23:59", schoolTimezone).getTime() + 60_000;
      const start = Math.max(dayStart, c.startsAt.getTime()), end = Math.min(dayEnd, c.endsAt.getTime());
      if (end <= start) continue;
      rows.push({ blockId: c.scheduleProfileBlockId || c.id, name: c.name, staff: staff([c.assignedStaffId]), studentIds: rosterByContext.get(c.id) ?? [], window: { start, end }, validForPrecedence: staffNames.has(c.assignedStaffId) });
    }
    return rows;
  };
  const result = unavailable();
  result.complete = true; result.blockers = []; result.afterTesting = [];
  const reviewedFacts = [];
  for (const date of dates) {
    const classes = resolve(date, options.config), baselineClasses = resolve(date, options.baseline);
    const resolved = { classes, baselineClasses, testing: testing(date, options.config), baselineTesting: testing(date, options.baseline) };
    reviewedFacts.push({ date, ...resolved });
    const analysis = analyzeScheduleStudents(resolved);
    if (!analysis.complete) { result.complete = false; result.blockers.push({ date, code: "SCHEDULE_PROFILE_STUDENT_REVIEW_INCOMPLETE", message: "Student schedule checks are incomplete. Resolve unavailable class schedules or rosters before applying." }); }
    for (const conflict of analysis.overlaps) {
      const { window, ...details } = conflict;
      result.studentConflicts.push({ ...details, date, startTime: at(window.start), endTime: at(window.end) });
      if (conflict.newStudentCount) result.blockers.push({ date, code: "SCHEDULE_PROFILE_STUDENT_CONFLICT", message: `${conflict.classIds.map(id => classes.find(c => c.classId === id)?.name || "Class").join(" and ")} assign ${conflict.newStudentCount} student${conflict.newStudentCount === 1 ? "" : "s"} to new competing class time from ${at(conflict.window.start)}–${at(conflict.window.end)}.` });
    }
    for (const w of options.testingWindows.filter(w => w.date === date)) {
      const summary = analysis.afterTesting.find(s => s.blockId === w.blockId);
      result.afterTesting.push({ date, blockId: w.blockId, status: summary?.status ?? "unavailable", studentCount: summary?.studentCount ?? null,
        allocations: summary?.allocations.map(a => ({ ...a, at: a.at === null ? null : at(a.at),
          classNames: a.classIds.map(id => classes.find(c => c.classId === id)?.name || "Unavailable class"),
          blockNames: a.blockIds.map(id => resolved.testing.find(b => b.blockId === id)?.name || "Unavailable testing") })) ?? [] });
    }
  }
  result.fingerprint = digest({ schoolId, dates, facts, reviewedFacts, supervisionGroups: options.supervisionGroups, staff: options.staff,
    baseline: options.baseline, config: options.config, contexts, supervisedStudents });
  return result;
}
