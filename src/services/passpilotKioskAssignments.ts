import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import db from "../db.js";
import { schools, schoolMemberships, productLicenses, users } from "../schema/core.js";
import { settings, studentTimelineEvents } from "../schema/shared.js";
import { recordPasspilotKioskCounter } from "./passpilotKioskMetrics.js";
import { students } from "../schema/students.js";
import { grades, teacherGrades, passpilotGradeStudents, passpilotTeacherKioskSettings, passpilotKioskSessions, passes,
  type KioskSession, type Pass } from "../schema/passpilot.js";
import { groups, groupTeachers, groupStudents, teachingSessions, classpilotSessionStaff, classpilotSessionStudents,
  classpilotSupervisionContexts, classpilotSupervisionStudents } from "../schema/classpilot.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { localDateInTimeZone, localDateTimeUtc, addLocalDays } from "../util/schoolTime.js";
import { readStoredSchoolSchedulingConfig, resolveClassBaseWindow } from "./classpilotSchedulingRules.js";
import { getApprovedScheduleChangeLegsForSchoolDate } from "./classpilotScheduleChanges.js";
import { isScheduleProfileBlockCancelled } from "./classpilotScheduleProfileModel.js";
import { assertClasspilotEntitled, isClasspilotSchoolActive } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { lockInstructionalCalendarDate, lockClasspilotStudentControlAuthorities } from "./storage.js";
import { isWithinTrackingWindow } from "./schoolHours.js";
import { emptyKioskSchedule, kioskError, kioskScheduleSchema, selectKioskAssignment, standaloneKioskWindows,
  type KioskAssignment, type KioskMode, type KioskSchedule } from "./passpilotKioskSchedule.js";

type Database = typeof db;
type Source = "legacy_grades" | "classpilot_groups";
const MAX_ROSTER = 1000;
export async function getKioskPreferences(schoolId: string, teacherId: string, database: Database = db) {
  const [row] = await database.select().from(passpilotTeacherKioskSettings).where(and(
    eq(passpilotTeacherKioskSettings.schoolId, schoolId), eq(passpilotTeacherKioskSettings.teacherId, teacherId)));
  return row ?? { schoolId, teacherId, mode: "manual" as KioskMode, schedule: emptyKioskSchedule(), revision: 0, updatedAt: null, updatedBy: null };
}
export async function kioskTeacher(schoolId: string, teacherId: string, database: Database = db) {
  const [membership] = await database.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId),
    eq(schoolMemberships.userId, teacherId), eq(schoolMemberships.status, "active"),
    inArray(schoolMemberships.role, ["teacher", "admin", "school_admin", "office_staff"])))
    .orderBy(sql`CASE ${schoolMemberships.role} WHEN 'admin' THEN 0 WHEN 'school_admin' THEN 1 WHEN 'teacher' THEN 2 ELSE 3 END`).limit(1);
  if (!membership) throw kioskError("This teacher no longer has school access.", "PASSPILOT_KIOSK_SESSION_EXPIRED", 404);
  return membership;
}
export async function kioskClasses(schoolId: string, teacherId: string, source: Source, database: Database = db, manager = false) {
  if (source === "legacy_grades") {
    const rows = await database.selectDistinct({ id: grades.id, name: grades.name }).from(grades)
      .leftJoin(teacherGrades, eq(teacherGrades.gradeId, grades.id))
      .where(and(eq(grades.schoolId, schoolId), ne(grades.migrationState, "history_only"), manager ? undefined : eq(teacherGrades.teacherId, teacherId))).limit(501);
    if (rows.length > 500) throw kioskError("Too many classes to resolve completely.", "PASSPILOT_KIOSK_SCOPE_LIMIT", 422);
    return rows;
  }
  const rows = await database.selectDistinct({ id: groups.id, name: groups.name }).from(groups)
    .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
    .where(and(eq(groups.schoolId, schoolId), eq(groups.groupType, "admin_class"), eq(groups.status, "active"),
      manager ? undefined : or(eq(groups.teacherId, teacherId), eq(groupTeachers.teacherId, teacherId)))).limit(501);
  if (rows.length > 500) throw kioskError("Too many classes to resolve completely.", "PASSPILOT_KIOSK_SCOPE_LIMIT", 422);
  return rows;
}
async function classpilotCandidates(schoolId: string, teacherId: string, dates: string[], timezone: string,
  calendar: Record<string, { nonInstructionalDates?: string[] }>, database: Database): Promise<KioskAssignment[]> {
  await assertClasspilotEntitled(schoolId, database);
  const [scheduleRows, personal, recorded, contexts] = await Promise.all([
    database.select().from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1),
    database.selectDistinct({ group: groups }).from(groups).leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
      .where(and(eq(groups.schoolId, schoolId), eq(groups.status, "active"), eq(groups.groupType, "admin_class"),
        or(eq(groups.teacherId, teacherId), eq(groupTeachers.teacherId, teacherId)))).limit(501),
    database.select({ session: teachingSessions, authorizedStaff: classpilotSessionStaff.staffId }).from(teachingSessions)
      .leftJoin(classpilotSessionStaff, and(eq(classpilotSessionStaff.schoolId, schoolId),
        eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id), eq(classpilotSessionStaff.staffId, teacherId)))
      .where(and(eq(teachingSessions.schoolId, schoolId), inArray(teachingSessions.scheduledDate, dates),
        or(eq(classpilotSessionStaff.staffId, teacherId), sql`EXISTS (SELECT 1 FROM ${groups} g
          WHERE g.id=${teachingSessions.groupId} AND g.school_id=${schoolId} AND (g.teacher_id=${teacherId}
            OR EXISTS (SELECT 1 FROM ${groupTeachers} t WHERE t.group_id=g.id AND t.teacher_id=${teacherId})))`))).limit(1001),
    // Include terminal contexts: their existence prevents resurrecting an early-ended block.
    database.select().from(classpilotSupervisionContexts).where(and(eq(classpilotSupervisionContexts.schoolId, schoolId),
      or(inArray(classpilotSupervisionContexts.scheduleProfileDate, dates),
        and(eq(classpilotSupervisionContexts.assignedStaffId, teacherId), eq(classpilotSupervisionContexts.status, "active"),
          gt(classpilotSupervisionContexts.endsAt, localDateTimeUtc(dates[0]!, "00:00", timezone)))))).limit(2501),
  ]);
  if (personal.length > 500 || recorded.length > 1000 || contexts.length > 2500) throw kioskError("Schedule is too large to resolve completely.", "PASSPILOT_KIOSK_SCOPE_LIMIT", 422);
  const config = readStoredSchoolSchedulingConfig(scheduleRows[0]?.config);
  const candidates: KioskAssignment[] = [];
  const frozen = new Set(recorded.map(({ session: s }) => `${s.scheduledDate}:${s.groupId}`));
  for (const { session: s, authorizedStaff } of recorded) {
    if (s.scheduledState === "skipped" || !s.scheduledStartAt || !s.scheduledEndAt
      || (s.rosterSnapshotCompletedAt && !authorizedStaff)
      || calendar[s.scheduledDate!.slice(0, 7)]?.nonInstructionalDates?.includes(s.scheduledDate!)) continue;
    candidates.push({ id: s.id, kind: "class", name: s.classNameSnapshot || "Scheduled class", classId: s.groupId,
      ...(s.rosterSnapshotCompletedAt ? { teachingSessionId: s.id } : {}), supervisionContextId: null, startsAt: s.scheduledStartAt.toISOString(),
      endsAt: s.scheduledEndAt.toISOString(), state: "ready" });
  }
  for (const date of dates) {
    const windows = personal.flatMap(({ group }) => {
      if (frozen.has(`${date}:${group.id}`) || group.scheduleSkippedDate === date) return [];
      const window = resolveClassBaseWindow(group, date, config, calendar);
      return window ? [{ group, window }] : [];
    });
    if (!windows.length) continue;
    const legs = await getApprovedScheduleChangeLegsForSchoolDate({ schoolId, scheduledDate: date, dbInstance: database });
    const byClass = new Map(legs.map(l => [l.groupId, l]));
    for (const { group, window } of windows) {
      const leg = byClass.get(group.id);
      candidates.push({ id: `classpilot:${date}:${group.id}`, kind: "class", name: group.name,
        classId: group.id, supervisionContextId: null, state: "ready",
        startsAt: localDateTimeUtc(date, leg?.effectiveStartTime ?? window.startTime, timezone).toISOString(),
        endsAt: localDateTimeUtc(date, leg?.effectiveEndTime ?? window.endTime, timezone).toISOString() });
    }
  }
  for (const c of contexts) {
    if (c.assignedStaffId !== teacherId || c.status !== "active" || (!c.scheduleProfileApplicationId && !c.scheduledConflictId)) continue;
    if (c.scheduleProfileApplicationId) {
      const application = config.profileApplications?.find(a => a.id === c.scheduleProfileApplicationId);
      if (!application || isScheduleProfileBlockCancelled(application, c.scheduleProfileDate!, c.scheduleProfileBlockId!)) continue;
    }
    candidates.push({ id: c.id, kind: c.scheduleProfileApplicationId ? "testing" : "coverage", name: c.name,
      classId: null, supervisionContextId: c.id, authorityRevision: c.classroomAuthorityRevision,
      startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), state: "ready" });
  }
  for (const application of config.profileApplications ?? []) for (const window of application.testingWindows) {
    if (!dates.includes(window.date) || window.assignedStaffId !== teacherId
      || isScheduleProfileBlockCancelled(application, window.date, window.blockId)) continue;
    if (contexts.some(c => c.scheduleProfileApplicationId === application.id && c.scheduleProfileDate === window.date && c.scheduleProfileBlockId === window.blockId)) continue;
    const key = `${application.id}:${window.date}:${window.blockId}`;
    const receipt = scheduleRows[0]?.profileActivationOutcomes[key];
    if (receipt && (receipt.status === "started" || receipt.status === "cancelled")) continue;
    candidates.push({ id: `testing:${key}`, kind: "testing", name: window.name, classId: null, supervisionContextId: null,
      startsAt: localDateTimeUtc(window.date, window.startTime, timezone).toISOString(),
      endsAt: localDateTimeUtc(window.date, window.endTime, timezone).toISOString(), state: receipt ? "failed" : "pending" });
  }
  return candidates;
}

async function assignmentRoster(schoolId: string, teacherId: string, source: Source, assignment: KioskAssignment | null, database: Database, now: Date) {
  if (!assignment || assignment.state !== "ready") return [];
  let condition;
  if (assignment.supervisionContextId) {
    condition = sql`EXISTS (SELECT 1 FROM ${classpilotSupervisionStudents} a WHERE a.school_id=${schoolId}
      AND a.context_id=${assignment.supervisionContextId} AND a.student_id=${students.id} AND a.released_at IS NULL)`;
  } else if (assignment.teachingSessionId) {
    condition = sql`EXISTS (SELECT 1 FROM ${classpilotSessionStudents} a WHERE a.school_id=${schoolId}
      AND a.teaching_session_id=${assignment.teachingSessionId} AND a.student_id=${students.id})`;
  } else if (source === "classpilot_groups") {
    condition = sql`EXISTS (SELECT 1 FROM ${groupStudents} a WHERE a.group_id=${assignment.classId} AND a.student_id=${students.id})`;
  } else {
    condition = sql`(${students.gradeId}=${assignment.classId} OR EXISTS (SELECT 1 FROM ${passpilotGradeStudents} a
      WHERE a.school_id=${schoolId} AND a.grade_id=${assignment.classId} AND a.student_id=${students.id}))`;
  }
  const delegated = source === "classpilot_groups" && !assignment.supervisionContextId
    ? sql`NOT EXISTS (SELECT 1 FROM ${classpilotSupervisionStudents} a INNER JOIN ${classpilotSupervisionContexts} c ON c.id=a.context_id AND c.school_id=a.school_id
        WHERE a.school_id=${schoolId} AND a.student_id=${students.id} AND a.released_at IS NULL AND c.status='active'
        AND c.starts_at <= ${now.toISOString()}::timestamp AND c.ends_at > ${now.toISOString()}::timestamp AND c.assigned_staff_id <> ${teacherId})` : undefined;
  const rows = await database.select({ id: students.id, firstName: students.firstName, lastName: students.lastName,
    studentIdNumber: students.studentIdNumber, status: students.status }).from(students)
    .where(and(eq(students.schoolId, schoolId), eq(students.status, "active"), condition, delegated))
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id)).limit(MAX_ROSTER + 1);
  if (rows.length > MAX_ROSTER) throw kioskError("Roster is too large to load completely.", "PASSPILOT_KIOSK_SCOPE_LIMIT", 422);
  return rows;
}

export async function resolveKioskAssignment(schoolId: string, session: KioskSession, database: Database = db, now = new Date()) {
  if (session.schoolId !== schoolId || session.status !== "active" || !session.teacherId) throw kioskError("Kiosk session expired.", "PASSPILOT_KIOSK_SESSION_EXPIRED", 404);
  const [membership, preference, schoolRows, settingsRows] = await Promise.all([
    kioskTeacher(schoolId, session.teacherId, database), getKioskPreferences(schoolId, session.teacherId, database),
    database.select().from(schools).where(eq(schools.id, schoolId)).limit(1),
    database.select().from(settings).where(eq(settings.schoolId, schoolId)).limit(1),
  ]);
  const school = schoolRows[0], schoolSettings = settingsRows[0];
  if (!school || !schoolSettings) throw kioskError("School schedule settings are unavailable.", "PASSPILOT_KIOSK_SCHEDULE_UNAVAILABLE", 503);
  const source = schoolSettings.passpilotClassSource;
  const timezone = school.schoolTimezone || "America/New_York";
  const today = localDateInTimeZone(now, timezone), midnight = localDateTimeUtc(addLocalDays(today, 1), "00:00", timezone);
  let candidates: KioskAssignment[] = [];
  if (preference.mode !== "manual") {
    if (process.env.PASSPILOT_AUTOMATIC_KIOSK_ENABLED === "false") throw kioskError("Automatic kiosks are temporarily unavailable. Choose Manual in kiosk settings.", "PASSPILOT_KIOSK_SCHEDULE_UNAVAILABLE", 503);
    if ((preference.mode === "passpilot") !== (source === "legacy_grades")) throw kioskError("The schedule source changed. Update kiosk settings.", "PASSPILOT_CLASS_SOURCE_CHANGED");
    if (preference.mode === "passpilot") {
      const schedule = kioskScheduleSchema.parse(preference.schedule);
      const classes = await kioskClasses(schoolId, session.teacherId, source, database);
      const names = new Map(classes.map(c => [c.id, c.name]));
      // No DB reads per date; a week is sufficient for weekly next-class display.
      for (let offset = 0; offset < 8; offset++) for (const window of standaloneKioskWindows(schedule, addLocalDays(today, offset), timezone, schoolSettings.instructionalCalendar ?? {})) {
        if (!names.has(window.classId!)) throw kioskError("A scheduled class is no longer assigned to this teacher. Update the schedule.", "PASSPILOT_KIOSK_SCHEDULE_UNAVAILABLE");
        candidates.push({ ...window, name: names.get(window.classId!)! });
      }
    } else {
      // One bounded week includes the next weekday after a weekend; no Dashboard projection or side effects.
      candidates = await classpilotCandidates(schoolId, session.teacherId, Array.from({ length: 8 }, (_, offset) => addLocalDays(today, offset)), timezone,
        schoolSettings.instructionalCalendar ?? {}, database);
    }
  }
  const automatic = selectKioskAssignment(candidates, now, midnight);
  let overrideExpiresAt = session.overrideExpiresAt;
  if (preference.mode !== "manual" && session.overrideStartedAt && overrideExpiresAt) {
    // Include newly inserted boundaries that have already elapsed since the override began.
    const editedBoundary = selectKioskAssignment(candidates, session.overrideStartedAt, midnight).nextBoundaryAt;
    overrideExpiresAt = new Date(Math.min(overrideExpiresAt.getTime(), Date.parse(editedBoundary)));
  }
  const overridden = preference.mode !== "manual" && !!overrideExpiresAt && overrideExpiresAt > now;
  let current = automatic.current, status = automatic.status;
  if (preference.mode === "manual" || overridden) {
    const classId = session.classSource === source ? source === "legacy_grades" ? session.gradeId : session.classpilotGroupId : null;
    const classes = classId ? await kioskClasses(schoolId, session.teacherId, source, database,
      ["admin", "school_admin", "office_staff"].includes(membership.role)) : [];
    const target = classes.find(c => c.id === classId);
    if (classId && !target) throw kioskError("This class is no longer available to the kiosk teacher.", "PASSPILOT_KIOSK_CLASS_INACTIVE");
    current = target ? { id: `manual:${target.id}`, kind: "class", name: target.name, classId: target.id, supervisionContextId: null,
      startsAt: (session.overrideStartedAt ?? session.claimedAt ?? session.createdAt).toISOString(),
      endsAt: (overridden ? overrideExpiresAt! : midnight).toISOString(), state: "ready" } : null;
    status = current ? "ready" : "idle";
  }
  const roster = await assignmentRoster(schoolId, session.teacherId, source, current, database, now);
  const revision = `kiosk-activity-v1:${createHash("sha256").update(JSON.stringify([source, preference.mode, preference.revision,
    session.id, session.teacherId, session.revision, current, status, overridden, roster.map(s => s.id)])).digest("base64url")}`;
  return { mode: preference.mode, source, current, status, next: automatic.next, overridden,
    overrideExpiresAt: overridden ? overrideExpiresAt!.toISOString() : null,
    nextBoundaryAt: overridden ? new Date(Math.min(Date.parse(automatic.nextBoundaryAt), overrideExpiresAt!.getTime())).toISOString() : automatic.nextBoundaryAt,
    serverTime: now.toISOString(), timezone, revision, roster };
}

// Failure of schedule resolution must close checkout without hiding eligible returns.
export async function resolveKioskDisplayAssignment(schoolId: string, session: KioskSession) {
  await kioskTeacher(schoolId, session.teacherId!);
  const preference = await getKioskPreferences(schoolId, session.teacherId!);
  const [schoolSettings] = await db.select().from(settings).where(eq(settings.schoolId, schoolId)).limit(1);
  try {
    return { ...await resolveKioskAssignment(schoolId, session), message: null as string | null };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") throw error;
    recordPasspilotKioskCounter("assignmentFailures");
    return { mode: preference.mode, source: schoolSettings?.passpilotClassSource ?? "legacy_grades", current: null,
      status: "unavailable" as const, next: null, overridden: false, overrideExpiresAt: null, nextBoundaryAt: null,
      serverTime: new Date().toISOString(), timezone: "UTC", revision: `unavailable:${session.id}:${preference.revision}`,
      roster: [], message: "The current schedule could not be verified. New passes are unavailable. Outstanding passes can still be returned." };
  }
}

export async function assertKioskScheduleEditor(schoolId: string, teacherId: string, actorId: string, database: Database) {
  const [actor] = await database.select({ isSuperAdmin: users.isSuperAdmin }).from(users).where(eq(users.id, actorId)).limit(1);
  const teacher = await kioskTeacher(schoolId, teacherId, database);
  if (teacher.role === "office_staff") throw kioskError("Teachers and administrators manage kiosk schedules.", "FORBIDDEN", 403);
  if (actor?.isSuperAdmin) return;
  const membership = await kioskTeacher(schoolId, actorId, database);
  if (!["admin", "school_admin"].includes(membership.role) && (actorId !== teacherId || membership.role !== "teacher")) {
    throw kioskError("Only administrators can manage another teacher's schedule.", "FORBIDDEN", 403);
  }
}

export async function saveKioskPreferences(options: { schoolId: string; teacherId: string; actorId: string; mode: KioskMode; schedule: KioskSchedule; expectedRevision: number }) {
  const schedule = kioskScheduleSchema.parse(options.schedule);
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    await lockKioskSchool(database, options.schoolId);
    await assertKioskScheduleEditor(options.schoolId, options.teacherId, options.actorId, database);
    const [school] = await tx.select().from(schools).where(eq(schools.id, options.schoolId)).limit(1);
    const [license] = await tx.select().from(productLicenses).where(and(eq(productLicenses.schoolId, options.schoolId),
      eq(productLicenses.product, "PASSPILOT"))).limit(1).for("share");
    if (!school || !isClasspilotSchoolActive(school) || license?.status !== "active"
      || (license.expiresAt && license.expiresAt <= new Date())) throw kioskError("PassPilot access is no longer active.", "PASSPILOT_NOT_ENTITLED", 403);
    const [setting] = await tx.select().from(settings).where(eq(settings.schoolId, options.schoolId)).limit(1);
    if (!setting) throw kioskError("School settings unavailable.");
    if (options.mode === "classpilot") {
      if (setting.passpilotClassSource !== "classpilot_groups") throw kioskError("Link PassPilot to ClassPilot classes before enabling this schedule.");
      await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    }
    if (options.mode === "passpilot" && setting.passpilotClassSource !== "legacy_grades") throw kioskError("This school's schedules are managed in ClassPilot.");
    const previous = await getKioskPreferences(options.schoolId, options.teacherId, database);
    const scheduleChanged = JSON.stringify(schedule) !== JSON.stringify(previous.schedule);
    if ((options.mode === "passpilot" || scheduleChanged) && (schedule.blocks.length || schedule.exceptions.some(e => e.blocks.length))) {
      const classes = new Set((await kioskClasses(options.schoolId, options.teacherId, setting.passpilotClassSource, database)).map(c => c.id));
      if ([...schedule.blocks, ...schedule.exceptions.flatMap(e => e.blocks)].some(b => !classes.has(b.classId))) throw kioskError("Schedule only this teacher's assigned classes.", "PASSPILOT_CLASS_ACCESS_DENIED", 403);
    }
    if (previous.revision !== options.expectedRevision) throw kioskError("The schedule changed. Reload before saving.", "PASSPILOT_KIOSK_PREFERENCES_CHANGED");
    const values = { mode: options.mode, schedule, revision: previous.revision + 1, updatedAt: new Date(), updatedBy: options.actorId };
    const [saved] = await tx.insert(passpilotTeacherKioskSettings).values({ schoolId: options.schoolId, teacherId: options.teacherId, ...values })
      .onConflictDoUpdate({ target: [passpilotTeacherKioskSettings.schoolId, passpilotTeacherKioskSettings.teacherId], set: values }).returning();
    if (previous.mode !== options.mode) await tx.update(passpilotKioskSessions).set({ overrideStartedAt: null, overrideExpiresAt: null })
      .where(and(eq(passpilotKioskSessions.schoolId, options.schoolId), eq(passpilotKioskSessions.teacherId, options.teacherId)));
    return saved!;
  });
}

export async function lockKioskSchool(database: Database, schoolId: string) {
  if (!await lockStaffAssignmentLifecycleSchool(database as unknown as Parameters<typeof lockStaffAssignmentLifecycleSchool>[0], schoolId)) throw kioskError("School not found.", "SCHOOL_NOT_FOUND", 404);
  await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`passpilot-class-source:${schoolId}`}))`);
}
export async function setKioskOverride(schoolId: string, session: KioskSession, database: Database) {
  if (!session.teacherId) return;
  const prefs = await getKioskPreferences(schoolId, session.teacherId, database);
  if (prefs.mode === "manual") return;
  const now = new Date();
  const assignment = await resolveKioskAssignment(schoolId, { ...session, overrideStartedAt: null, overrideExpiresAt: null }, database, now);
  await database.update(passpilotKioskSessions).set({ overrideStartedAt: now, overrideExpiresAt: new Date(assignment.nextBoundaryAt) })
    .where(and(eq(passpilotKioskSessions.schoolId, schoolId), eq(passpilotKioskSessions.id, session.id)));
  session.overrideStartedAt = now;
  session.overrideExpiresAt = new Date(assignment.nextBoundaryAt);
}

export async function kioskReturnablePasses(schoolId: string, teacherId: string, database: Database = db) {
  const rows = await database.select({ pass: passes, student: { id: students.id, firstName: students.firstName, lastName: students.lastName,
    studentIdNumber: students.studentIdNumber, status: students.status } }).from(passes)
    .innerJoin(students, and(eq(students.schoolId, schoolId), eq(students.id, passes.studentId)))
    .where(and(eq(passes.schoolId, schoolId), eq(passes.teacherId, teacherId), eq(passes.issuedVia, "kiosk"), eq(passes.status, "active")))
    .orderBy(passes.id).limit(MAX_ROSTER + 1);
  if (rows.length > MAX_ROSTER) throw kioskError("Too many outstanding passes to load completely.", "PASSPILOT_KIOSK_SCOPE_LIMIT", 422);
  return rows;
}

async function assertKioskWriteAccess(database: Database, schoolId: string, expectedPinHash: string | null) {
  const [school] = await database.select().from(schools).where(eq(schools.id, schoolId)).limit(1).for("share");
  const [license] = await database.select().from(productLicenses).where(and(eq(productLicenses.schoolId, schoolId), eq(productLicenses.product, "PASSPILOT"))).limit(1).for("share");
  if (!school || !isClasspilotSchoolActive(school) || !school.kioskEnabled || school.kioskPinHash !== expectedPinHash
    || license?.status !== "active" || (license.expiresAt && license.expiresAt <= new Date())) {
    throw kioskError("Kiosk access is no longer active.", "PASSPILOT_KIOSK_DISABLED", 403);
  }
  return school;
}

function assertLiveSession(session: KioskSession | undefined): asserts session is KioskSession & { teacherId: string } {
  if (!session || session.status !== "active" || !session.teacherId || session.lastSeenAt.getTime() <= Date.now() - 20 * 60 * 60_000) {
    throw kioskError("Kiosk session expired.", "PASSPILOT_KIOSK_SESSION_EXPIRED", 404);
  }
}

async function recordKioskPassTimeline(database: Database, pass: Pass, action: "issued" | "returned") {
  await database.insert(studentTimelineEvents).values({ schoolId: pass.schoolId, studentId: pass.studentId,
    eventType: "pass", sourceType: "passpilot", sourceId: pass.id, title: `Hall pass ${action}: ${pass.destination}`,
    summary: pass.activityNameSnapshot || pass.customDestination, actorUserId: pass.teacherId,
    metadata: { status: pass.status, destination: pass.destination, issuedVia: "kiosk", activityKind: pass.activityKind,
      activityName: pass.activityNameSnapshot, supervisionContextId: pass.supervisionContextId, issuingKioskSessionId: pass.issuingKioskSessionId } });
}

export async function createActivityKioskPass(options: { schoolId: string; sessionId: string; studentId: string; expectedRevision: unknown;
  expectedPinHash: string | null; destination: string; customDestination?: string | null }) {
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    await lockKioskSchool(database, options.schoolId);
    const school = await assertKioskWriteAccess(database, options.schoolId, options.expectedPinHash);
    await lockInstructionalCalendarDate(options.schoolId, localDateInTimeZone(new Date(), school.schoolTimezone), database);
    await lockClasspilotStudentControlAuthorities(options.schoolId, [options.studentId], database);
    const [session] = await tx.select().from(passpilotKioskSessions).where(and(eq(passpilotKioskSessions.schoolId, options.schoolId),
      eq(passpilotKioskSessions.id, options.sessionId))).limit(1).for("update");
    assertLiveSession(session);
    const assignment = await resolveKioskAssignment(options.schoolId, session, database);
    if (typeof options.expectedRevision !== "string" || options.expectedRevision !== assignment.revision) {
      recordPasspilotKioskCounter("staleCheckoutConflicts");
      throw kioskError("The kiosk assignment changed. Select the student again.");
    }
    if (assignment.source === "classpilot_groups") await assertClasspilotEntitled(options.schoolId, database, { lock: true });
    if (assignment.status !== "ready" || !assignment.current || !assignment.roster.some(s => s.id === options.studentId)) throw kioskError("The student is not in the kiosk's current roster.", "PASSPILOT_STUDENT_NOT_IN_CLASS");
    const [schoolSettings] = await tx.select().from(settings).where(eq(settings.schoolId, options.schoolId)).limit(1);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) throw kioskError("Passes cannot be issued outside school hours.", "PASSPILOT_OUTSIDE_SCHOOL_HOURS", 403);
    const current = assignment.current;
    const duration = school.defaultPassDuration ?? 5;
    if (Date.now() >= Date.parse(assignment.nextBoundaryAt) || Date.now() >= Date.parse(current.endsAt)) {
      recordPasspilotKioskCounter("staleCheckoutConflicts");
      throw kioskError("The kiosk assignment changed. Select the student again.");
    }
    const [pass] = await tx.insert(passes).values({ schoolId: options.schoolId, studentId: options.studentId, teacherId: session.teacherId,
      gradeId: assignment.source === "legacy_grades" ? current.classId : null,
      classpilotGroupId: assignment.source === "classpilot_groups" ? current.classId : null,
      classNameSnapshot: current.kind === "class" ? current.name : null,
      supervisionContextId: current.supervisionContextId, activityKind: current.kind === "class" ? null : current.kind,
      activityNameSnapshot: current.kind === "class" ? null : current.name,
      issuingKioskSessionId: session.id, destination: options.destination, customDestination: options.destination === "custom" ? options.customDestination : null,
      status: "active", issuedVia: "kiosk", duration, expiresAt: new Date(Date.now() + duration * 60_000) }).returning();
    if (assignment.source === "classpilot_groups") await tx.update(settings).set({ passpilotCanonicalWritesAt: sql`COALESCE(${settings.passpilotCanonicalWritesAt}, now())` }).where(eq(settings.schoolId, options.schoolId));
    await tx.update(passpilotKioskSessions).set({ lastSeenAt: new Date() }).where(eq(passpilotKioskSessions.id, session.id));
    await recordKioskPassTimeline(database, pass!, "issued");
    return pass!;
  });
}

export async function returnTeacherKioskPass(schoolId: string, sessionId: string, studentId: string, expectedPinHash: string | null): Promise<Pass | null> {
  return db.transaction(async tx => {
    const database = tx as unknown as Database;
    await lockKioskSchool(database, schoolId);
    await assertKioskWriteAccess(database, schoolId, expectedPinHash);
    const [session] = await tx.select().from(passpilotKioskSessions).where(and(eq(passpilotKioskSessions.schoolId, schoolId), eq(passpilotKioskSessions.id, sessionId))).limit(1).for("update");
    assertLiveSession(session);
    await kioskTeacher(schoolId, session.teacherId, database);
    const [pass] = await tx.update(passes).set({ status: "returned", returnedAt: new Date() }).where(and(eq(passes.schoolId, schoolId),
      eq(passes.studentId, studentId), eq(passes.teacherId, session.teacherId), eq(passes.issuedVia, "kiosk"), eq(passes.status, "active"))).returning();
    if (pass) {
      await recordKioskPassTimeline(database, pass, "returned");
      await tx.update(passpilotKioskSessions).set({ lastSeenAt: new Date() }).where(and(eq(passpilotKioskSessions.schoolId, schoolId), eq(passpilotKioskSessions.id, sessionId)));
    } else recordPasspilotKioskCounter("returnFailures");
    return pass ?? null;
  });
}
