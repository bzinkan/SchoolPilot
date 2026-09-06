import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db from "../db.js";
import { schools, schoolMemberships } from "../schema/core.js";
import { students } from "../schema/students.js";
import { groups, groupStudents, groupTeachers, teachingSessions, classpilotCoverageScopeGroups, classpilotCoverageScopeGroupMembers, classpilotCoverageAssignments, classpilotSupervisionContexts, classpilotSupervisionStudents } from "../schema/classpilot.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { getSchoolSchedulingContext, previewSchoolScheduling } from "./classpilotScheduling.js";
import { validateScheduleProfileTestingWindows } from "./classpilotScheduleProfileValidation.js";
import { normalizeSchoolSchedulingConfig, resolveClassBaseWindow, resolveSchoolScheduleDay, schedulingError, isSchedulingDate, datePlusDays, type SchoolSchedulingConfig, type BellWindow } from "./classpilotSchedulingRules.js";
import { normalizeScheduleProfileDefinition, type ScheduleProfileDefinition, type SavedScheduleProfile, type ScheduleProfileApplication, type ScheduleProfileTestingWindow } from "./classpilotScheduleProfileModel.js";
import { getStaffBySchool, withClasspilotSchedulePostCommitTransaction, supersedePendingScheduleChangesForGroup } from "./storage.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";

type Database = typeof db;
type Blocker = { code: string; message: string; date?: string };
type ProfileRequest = { schoolId: string; revision: number; profileId: string; profileRevision: number; dates: string[]; definition?: unknown; actorId: string; now?: Date };
function fail(message: string, code = "SCHEDULE_PROFILE_INVALID", status = 400): never { throw schedulingError(message, code, status); }
function revision(value: number) { if (!Number.isSafeInteger(value) || value < 0) fail("A current schedule revision is required."); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object" && !(value instanceof Date)) return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
function overlaps(a: BellWindow, b: BellWindow) { return a.startTime < b.endTime && b.startTime < a.endTime; }
function scopeIncludes(definition: ScheduleProfileDefinition, row: { id: string; gradeLevel: string | null }) {
  return definition.classIds.includes(row.id) || (!!row.gradeLevel && definition.grades.includes(row.gradeLevel));
}

async function catalog(schoolId: string, database: Database = db) {
  const [context, schoolRows, classRows, staffRows, supervisionGroups, members, assignments, classMembers, coTeachers, activeContexts, supervisedStudents] = await Promise.all([
    getSchoolSchedulingContext(schoolId, database),
    database.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, schoolId)),
    database.select().from(groups).where(and(eq(groups.schoolId, schoolId), eq(groups.status, "active"))).orderBy(groups.id),
    getStaffBySchool(schoolId, "active", database),
    database.select().from(classpilotCoverageScopeGroups).where(and(eq(classpilotCoverageScopeGroups.schoolId, schoolId), eq(classpilotCoverageScopeGroups.active, true))).orderBy(classpilotCoverageScopeGroups.id),
    database.select({ groupId: classpilotCoverageScopeGroupMembers.coverageGroupId, studentId: students.id, status: students.status }).from(classpilotCoverageScopeGroupMembers)
      .innerJoin(students, and(eq(students.id, classpilotCoverageScopeGroupMembers.studentId), eq(students.schoolId, classpilotCoverageScopeGroupMembers.schoolId)))
      .where(eq(classpilotCoverageScopeGroupMembers.schoolId, schoolId)).orderBy(classpilotCoverageScopeGroupMembers.coverageGroupId, students.id),
    database.select().from(classpilotCoverageAssignments).where(and(eq(classpilotCoverageAssignments.schoolId, schoolId), eq(classpilotCoverageAssignments.active, true), eq(classpilotCoverageAssignments.scopeType, "coverage_group"))).orderBy(classpilotCoverageAssignments.id),
    database.select({ classId: groupStudents.groupId, studentId: groupStudents.studentId }).from(groupStudents).innerJoin(groups, eq(groups.id, groupStudents.groupId)).where(eq(groups.schoolId, schoolId)).orderBy(groupStudents.groupId, groupStudents.studentId),
    database.select({ classId: groupTeachers.groupId, staffId: groupTeachers.teacherId }).from(groupTeachers).innerJoin(groups, eq(groups.id, groupTeachers.groupId)).where(eq(groups.schoolId, schoolId)).orderBy(groupTeachers.groupId, groupTeachers.teacherId),
    database.select().from(classpilotSupervisionContexts).where(and(eq(classpilotSupervisionContexts.schoolId, schoolId), eq(classpilotSupervisionContexts.status, "active"))).orderBy(classpilotSupervisionContexts.id),
    database.select({ contextId: classpilotSupervisionStudents.contextId, studentId: classpilotSupervisionStudents.studentId }).from(classpilotSupervisionStudents).where(and(eq(classpilotSupervisionStudents.schoolId, schoolId), isNull(classpilotSupervisionStudents.releasedAt))).orderBy(classpilotSupervisionStudents.contextId, classpilotSupervisionStudents.studentId),
  ]);
  const staff = [...new Map(staffRows.map((r) => [r.user.id, { id: r.user.id, name: [r.user.firstName, r.user.lastName].filter(Boolean).join(" ") || r.user.email }])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const staffIds = new Set(staff.map((s) => s.id));
  return { context, schoolTimezone: schoolRows[0]?.timezone || "America/New_York", classes: classRows, staff, classMembers, coTeachers, activeContexts, supervisedStudents,
    supervisionGroups: supervisionGroups.map((group) => ({ id: group.id, name: group.name,
      studentIds: members.filter((m) => m.groupId === group.id && m.status === "active").map((m) => m.studentId),
      inactiveStudents: members.filter((m) => m.groupId === group.id && m.status !== "active").length,
      staffIds: [...new Set(assignments.filter((a) => {
        const permissions = a.permissions as Record<string, unknown>;
        return a.scopeValue === group.id && staffIds.has(a.staffId) && (permissions.claim === true || permissions.observe === true);
      }).map((a) => a.staffId))].sort(),
    })),
  };
}
type Catalog = Awaited<ReturnType<typeof catalog>>;
function definitionReferences(definition: ScheduleProfileDefinition, data: Catalog): Blocker[] {
  const blockers: Blocker[] = [];
  const add = (message: string) => blockers.push({ code: "SCHEDULE_PROFILE_REFERENCE", message });
  for (const id of definition.classIds) if (!data.classes.some((c) => c.id === id)) add("A selected class is no longer active in this school. Update the profile.");
  for (const rule of definition.classRules) {
    const row = data.classes.find((c) => c.id === rule.classId);
    if (!row || !scopeIncludes(definition, row)) add("Every changed class must belong to the selected grades or classes in this school.");
    else if (!row.scheduleEnabled) add(row.name + " has no enabled class schedule. Enable its schedule before applying time changes.");
  }
  for (const block of definition.testingBlocks) {
    const group = data.supervisionGroups.find((g) => g.id === block.coverageGroupId);
    if (!group) add(block.name + ": the supervision group is no longer active in this school.");
    else if (!group.staffIds.includes(block.assignedStaffId)) add(block.name + ": choose an active staff member paired with this supervision group.");
  }
  return blockers;
}
export async function getScheduleProfiles(schoolId: string) {
  const data = await catalog(schoolId);
  const { getScheduledProfileSupervisionStatuses } = await import("./classpilotScheduleProfileSupervision.js");
  return { revision: data.context.revision, schoolTimezone: data.schoolTimezone, schoolLocalToday: localDateInTimeZone(new Date(), data.schoolTimezone),
    profiles: data.context.config.scheduleProfiles ?? [], applications: data.context.config.profileApplications ?? [],
    classes: data.classes.map((g) => ({ id: g.id, name: g.name, gradeLevel: g.gradeLevel, scheduleEnabled: g.scheduleEnabled, blockStartTime: g.blockStartTime, blockEndTime: g.blockEndTime, teacherName: data.staff.find((s) => s.id === g.teacherId)?.name })),
    staff: data.staff, supervisionGroups: data.supervisionGroups, testingStatuses: await getScheduledProfileSupervisionStatuses(schoolId) };
}
async function locked<T>(schoolId: string, actorId: string, operation: (database: Database) => Promise<T>) {
  return withClasspilotSchedulePostCommitTransaction(async (tx) => {
    if (!await lockStaffAssignmentLifecycleSchool(tx, schoolId)) fail("School not found.", "SCHOOL_NOT_FOUND", 404);
    const database = tx as unknown as Database;
    await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"passpilot-class-source:" + schoolId}))`);
    await assertClasspilotEntitled(schoolId, database, { lock: true });
    const memberships = await database.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, actorId), eq(schoolMemberships.status, "active")));
    if (!memberships.some((m) => m.role === "admin" || m.role === "school_admin")) fail("Active school administrator access is required.", "FORBIDDEN", 403);
    return operation(database);
  });
}
async function persist(schoolId: string, actorId: string, config: SchoolSchedulingConfig, expected: number, database: Database) {
  const normalized = normalizeSchoolSchedulingConfig(config);
  await database.insert(classpilotSchoolSchedules).values({ schoolId, config: normalized, revision: expected + 1, updatedBy: actorId })
    .onConflictDoUpdate({ target: classpilotSchoolSchedules.schoolId, set: { config: normalized, revision: expected + 1, updatedBy: actorId, updatedAt: new Date() } });
  return expected + 1;
}
export async function saveScheduleProfile(options: { schoolId: string; actorId: string; revision: number; id?: string; profileRevision?: number; definition: unknown }) {
  revision(options.revision);
  const definition = normalizeScheduleProfileDefinition(options.definition);
  return locked(options.schoolId, options.actorId, async (database) => {
    const data = await catalog(options.schoolId, database);
    if (data.context.revision !== options.revision) fail("Schedules changed. Reload before saving the profile.", "SCHEDULE_PREVIEW_STALE", 409);
    const blockers = definitionReferences(definition, data);
    if (blockers[0]) fail(blockers[0].message);
    const profiles = data.context.config.scheduleProfiles ?? [];
    const previous = options.id ? profiles.find((p) => p.id === options.id) : undefined;
    if (options.id && !previous) fail("Schedule profile not found.", "NOT_FOUND", 404);
    if (previous && previous.revision !== options.profileRevision) fail("This profile was edited. Reload it before saving.", "SCHEDULE_PREVIEW_STALE", 409);
    const profile: SavedScheduleProfile = { id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, definition, updatedAt: new Date().toISOString() };
    const config = { ...data.context.config, scheduleProfiles: [...profiles.filter((p) => p.id !== profile.id), profile] };
    return { profile, revision: await persist(options.schoolId, options.actorId, config, options.revision, database) };
  });
}
function applicationId(options: ProfileRequest, definition: ScheduleProfileDefinition, dates: string[]) {
  return "application_" + digest({ schoolId: options.schoolId, revision: options.revision, profileId: options.profileId, profileRevision: options.profileRevision, definition, dates }).slice(0, 40);
}
async function buildPreview(options: ProfileRequest, database: Database = db) {
  revision(options.revision);
  const data = await catalog(options.schoolId, database);
  if (data.context.revision !== options.revision) fail("Schedules changed. Reload and preview again.", "SCHEDULE_PREVIEW_STALE", 409);
  const profile = data.context.config.scheduleProfiles?.find((p) => p.id === options.profileId);
  if (!profile) fail("Schedule profile not found.", "NOT_FOUND", 404);
  if (profile.revision !== options.profileRevision) fail("This profile was edited. Reload and preview again.", "SCHEDULE_PREVIEW_STALE", 409);
  const definition = options.definition === undefined ? profile.definition : normalizeScheduleProfileDefinition(options.definition);
  if (!Array.isArray(options.dates) || !options.dates.length || options.dates.length > 31 || options.dates.some((d) => !isSchedulingDate(d))) fail("Select between one and 31 real dates.");
  const dates = [...new Set(options.dates)].sort();
  const now = options.now ?? new Date();
  const today = localDateInTimeZone(now, data.schoolTimezone);
  if (dates.some((d) => d < today || d > datePlusDays(today, 550))) fail("Choose dates from today through the next 550 days.");
  const blockers = definitionReferences(definition, data);
  const block = (message: string, date?: string, code = "SCHEDULE_PROFILE_CONFLICT") => blockers.push({ message, code, ...(date ? { date } : {}) });
  if (!definition.classRules.length && !definition.testingBlocks.length) block("Add a class time change, a skipped class, or a testing block before applying this profile.");
  const selected = data.classes.filter((c) => scopeIncludes(definition, c));
  const classWindows: ScheduleProfileApplication["classWindows"] = {};
  const testingWindows: ScheduleProfileTestingWindow[] = [];
  const changes: Array<{ date: string; classId: string; className: string; before: BellWindow | null; after: BellWindow | null }> = [];
  const frozen = await database.select({ classId: teachingSessions.groupId, date: teachingSessions.scheduledDate }).from(teachingSessions).where(and(eq(teachingSessions.schoolId, options.schoolId), inArray(teachingSessions.scheduledDate, dates)));
  for (const date of dates) {
    if (!resolveSchoolScheduleDay(date, data.context.config, data.context.calendar).instructional) { block("This is not an instructional date. Update the school calendar first.", date); continue; }
    classWindows[date] = {};
    for (const row of selected) {
      const rule = definition.classRules.find((r) => r.classId === row.id);
      if (!rule) continue;
      let before: BellWindow | null;
      try { before = resolveClassBaseWindow(row, date, data.context.config, data.context.calendar); }
      catch { block(row.name + ": resolve the missing period mapping before applying a profile.", date); continue; }
      if (!before) continue;
      const after = rule.action === "skip" ? null : { startTime: rule.startTime!, endTime: rule.endTime! };
      if (data.context.config.profileApplications?.some((a) => a.status === "scheduled" && Object.hasOwn(a.classWindows[date] ?? {}, row.id))) { block(row.name + " already has an applied profile on this date. Cancel that application first.", date); continue; }
      if (frozen.some((f) => f.classId === row.id && f.date === date)) { block(row.name + " already has a recorded occurrence on this date. It cannot be changed.", date); continue; }
      if (localDateTimeUtc(date, before.startTime, data.schoolTimezone) <= now || (after && localDateTimeUtc(date, after.startTime, data.schoolTimezone) <= now)) { block(row.name + ": apply the profile before both the original and proposed start time.", date); continue; }
      classWindows[date][row.id] = after;
      changes.push({ date, classId: row.id, className: row.name, before, after });
    }
    for (const planned of definition.testingBlocks) {
      const group = data.supervisionGroups.find((g) => g.id === planned.coverageGroupId);
      if (!group || !group.staffIds.includes(planned.assignedStaffId)) continue;
      if (!group.studentIds.length || group.inactiveStudents || group.studentIds.length > 500) { block(planned.name + ": choose a group with one to 500 active students and resolve inactive members.", date); continue; }
      if (localDateTimeUtc(date, planned.startTime, data.schoolTimezone) <= now) { block(planned.name + ": choose a testing start time in the future.", date); continue; }
      testingWindows.push({ date, blockId: planned.id, name: planned.name, coverageGroupId: planned.coverageGroupId, assignedStaffId: planned.assignedStaffId, studentIds: group.studentIds, startTime: planned.startTime, endTime: planned.endTime });
    }
  }
  const application: ScheduleProfileApplication = { id: applicationId(options, definition, dates), profileId: profile.id, profileName: definition.name, profileRevision: profile.revision,
    dates, definition, classWindows, testingWindows, status: "scheduled", createdAt: profile.updatedAt, createdBy: options.actorId };
  const config = { ...data.context.config, profileApplications: [...(data.context.config.profileApplications ?? []), application] };
  const scheduling = await previewSchoolScheduling({ schoolId: options.schoolId, config, now, dbInstance: database });
  blockers.push(...scheduling.blockers);
  const otherTesting = (data.context.config.profileApplications ?? []).filter((a) => a.status === "scheduled").flatMap((a) => a.testingWindows);
  for (const [index, window] of testingWindows.entries()) {
    const overlapping = [...otherTesting, ...testingWindows.slice(0, index)].filter((w) => w.date === window.date && overlaps(w, window));
    if (overlapping.some((w) => w.assignedStaffId === window.assignedStaffId || w.studentIds.some((id) => window.studentIds.includes(id)))) block(window.name + ": a staff member or student is assigned to overlapping testing blocks.", window.date);
    const start = localDateTimeUtc(window.date, window.startTime, data.schoolTimezone), end = localDateTimeUtc(window.date, window.endTime, data.schoolTimezone);
    for (const context of data.activeContexts) if (context.startsAt < end && context.endsAt > start) {
      if (context.assignedStaffId === window.assignedStaffId || data.supervisedStudents.some((s) => s.contextId === context.id && window.studentIds.includes(s.studentId))) block(window.name + ": existing active supervision overlaps this block. Release or adjust that supervision first.", window.date);
    }
  }
  const testingValidation = await validateScheduleProfileTestingWindows({ schoolId: options.schoolId, testingWindows, config, calendar: data.context.calendar, dbInstance: database, now });
  blockers.push(...testingValidation.blockers);
  if (!changes.length && !testingWindows.length) block("No eligible class meetings or testing blocks were found on these dates.");
  const uniqueBlockers = [...new Map(blockers.map((b) => [b.code + ":" + b.date + ":" + b.message, b])).values()].slice(0, 100);
  const previewToken = digest({ revision: data.context.revision, application, scheduling: scheduling.previewToken, testing: testingValidation.fingerprint, classes: data.classes, staff: data.staff, groups: data.supervisionGroups, classMembers: data.classMembers, coTeachers: data.coTeachers, activeContexts: data.activeContexts, supervisedStudents: data.supervisedStudents, today });
  return { revision: data.context.revision, previewToken, blockers: uniqueBlockers, changes, testingWindows, affectedClasses: new Set(changes.map((c) => c.classId)).size, schoolTimezone: data.schoolTimezone, application, config };
}
export async function previewScheduleProfile(options: ProfileRequest) {
  const { config: _config, application: _application, ...publicPreview } = await buildPreview(options);
  return publicPreview;
}
export async function applyScheduleProfile(options: ProfileRequest & { previewToken: string }) {
  if (!/^[a-f0-9]{64}$/.test(options.previewToken)) fail("Review a current preview before applying a profile.");
  return locked(options.schoolId, options.actorId, async (database) => {
    const validationStarted = Date.now(), checkedAt = options.now ?? new Date();
    const preview = await buildPreview({ ...options, now: checkedAt }, database);
    if (preview.previewToken !== options.previewToken) fail("The schedule, roster, or staff changed. Preview this application again.", "SCHEDULE_PREVIEW_STALE", 409);
    if (preview.blockers[0]) fail(preview.blockers[0].message, preview.blockers[0].code, 409);
    const commitAt = new Date(checkedAt.getTime() + Date.now() - validationStarted);
    const starts = preview.changes.flatMap((change) => [change.before, change.after].filter((window): window is BellWindow => Boolean(window)).map((window) => localDateTimeUtc(change.date, window.startTime, preview.schoolTimezone)));
    starts.push(...preview.testingWindows.map((window) => localDateTimeUtc(window.date, window.startTime, preview.schoolTimezone)));
    if (starts.some((start) => start <= commitAt)) fail("A class or testing window has started. Review a later date before applying.", "SCHEDULE_APPLICATION_STARTED", 409);
    preview.application.createdAt = (options.now ?? new Date()).toISOString();
    const nextRevision = await persist(options.schoolId, options.actorId, preview.config, options.revision, database);
    for (const classId of new Set(preview.changes.map((c) => c.classId))) await supersedePendingScheduleChangesForGroup({ schoolId: options.schoolId, groupId: classId, actorId: options.actorId, reason: "class_configuration_changed", dbInstance: database });
    return { application: preview.application, revision: nextRevision };
  });
}
export async function cancelScheduleProfileApplication(options: { schoolId: string; actorId: string; revision: number; applicationId: string; now?: Date }) {
  revision(options.revision);
  const result = await locked(options.schoolId, options.actorId, async (database) => {
    const context = await getSchoolSchedulingContext(options.schoolId, database);
    const application = context.config.profileApplications?.find((a) => a.id === options.applicationId);
    if (!application) fail("Schedule application not found.", "NOT_FOUND", 404);
    if (application.status === "cancelled") return { revision: context.revision };
    if (context.revision !== options.revision) fail("Schedules changed. Reload before cancelling.", "SCHEDULE_PREVIEW_STALE", 409);
    const data = await catalog(options.schoolId, database);
    const validationStarted = Date.now(), now = options.now ?? new Date();
    const starts = application.testingWindows.map((w) => localDateTimeUtc(w.date, w.startTime, data.schoolTimezone));
    for (const [date, windows] of Object.entries(application.classWindows)) for (const [id, window] of Object.entries(windows)) {
      const row = data.classes.find((c) => c.id === id);
      const baseline = row ? resolveClassBaseWindow(row, date, { ...context.config, profileApplications: [] }, context.calendar) : null;
      if (window) starts.push(localDateTimeUtc(date, window.startTime, data.schoolTimezone));
      if (baseline) starts.push(localDateTimeUtc(date, baseline.startTime, data.schoolTimezone));
    }
    if (starts.some((start) => start <= now)) fail("This application has started. Release or extend active testing in Coverage; recorded class schedules are preserved.", "SCHEDULE_APPLICATION_STARTED", 409);
    const config = { ...context.config, profileApplications: context.config.profileApplications!.map((a) => a.id === application.id ? { ...a, status: "cancelled" as const } : a) };
    const preview = await previewSchoolScheduling({ schoolId: options.schoolId, config, dbInstance: database, now });
    if (preview.blockers[0]) fail(preview.blockers[0].message, preview.blockers[0].code, 409);
    if (starts.some((start) => start.getTime() <= now.getTime() + Date.now() - validationStarted)) fail("This application has started. Use Coverage to manage active testing.", "SCHEDULE_APPLICATION_STARTED", 409);
    const nextRevision = await persist(options.schoolId, options.actorId, config, options.revision, database);
    const affectedClasses = new Set(Object.values(application.classWindows).flatMap((windows) => Object.keys(windows)));
    for (const classId of affectedClasses) await supersedePendingScheduleChangesForGroup({ schoolId: options.schoolId, groupId: classId, actorId: options.actorId, reason: "class_configuration_changed", dbInstance: database });
    return { revision: nextRevision };
  });
  const { cancelProfileSupervision } = await import("./classpilotScheduleProfileSupervision.js");
  // Cancellation is already durable. The worker retries interrupted releases;
  // a status-refresh failure must not disguise the successful calendar write.
  const testingStatuses = await cancelProfileSupervision(options.schoolId, options.applicationId).catch(() => undefined);
  return { ...result, testingStatuses, ...(testingStatuses ? {} : { testingStatusUnavailable: true }) };
}
