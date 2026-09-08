import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { groups, groupStudents, groupTeachers, classpilotCoverageScopeGroups, classpilotCoverageScopeGroupMembers, classpilotCoverageAssignments } from "../schema/classpilot.js";
import { schools, schoolMemberships, users } from "../schema/core.js";
import { students } from "../schema/students.js";
import { settings } from "../schema/shared.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { emptySchoolSchedulingConfig, normalizeSchoolSchedulingConfig, schedulingError, type SchoolSchedulingConfig, type SchedulingCalendar, type SchedulingGroup } from "./classpilotSchedulingRules.js";
import { projectClasspilotRegularSchedule, regularScheduleReferenceDate } from "./classpilotRegularSchedule.js";
import { normalizeScheduleProfileId, SCHEDULE_PROFILE_LIMITS, scheduleProfileWindowsOverlap, type ScheduleProfileDefinition, type ScheduleProfileWindow } from "./classpilotScheduleProfileModel.js";
import { scheduleProfileWindowHasFullMonitoring, testingRosterHasOtherClassStudents } from "./classpilotScheduleProfileValidation.js";
import type { HeartbeatTrackingSettings } from "./storage.js";

const READ_LIMITS = { classes: 5_000, staff: 5_000, relationships: 250_000, comparisons: 250_000, issues: 1_000 } as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function invalid(message: string): never { throw schedulingError(message, "SCHEDULE_DRAFT_REVIEW_INVALID"); }
function record(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain object.`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} contains an unsupported field.`);
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must contain at most ${maximum} entries.`);
  return value;
}
function text(value: unknown, maximum: number, label: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} must be text of at most ${maximum} characters.`);
  return value.trim();
}
function unique<T>(values: T[], label: string): T[] {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique.`);
  return values;
}
function optionalId(value: unknown): string { return value === "" || value === undefined ? "" : normalizeScheduleProfileId(value); }
function validWindow(value: { startTime?: string; endTime?: string }): value is ScheduleProfileWindow {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.startTime ?? "") && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.endTime ?? "") && value.startTime! < value.endTime!;
}

/** Only the review boundary accepts unfinished fields; persisted definitions stay strict. */
export function normalizeScheduleDraftReviewDefinition(value: unknown): ScheduleProfileDefinition {
  const row = record(value, ["name", "grades", "classIds", "classRules", "testingBlocks"], "Draft profile");
  const grades = unique(list(row.grades, SCHEDULE_PROFILE_LIMITS.grades, "Grades").map((grade) => {
    const result = text(grade, 40, "Grade"); if (!result) invalid("Grades cannot be empty."); return result;
  }), "Grades").sort();
  const classIds = unique(list(row.classIds, SCHEDULE_PROFILE_LIMITS.classes, "Classes").map(normalizeScheduleProfileId), "Class IDs").sort();
  const classRules = list(row.classRules, SCHEDULE_PROFILE_LIMITS.classes, "Class rules").map((value) => {
    const rule = record(value, ["classId", "action", "startTime", "endTime"], "Class rule");
    const classId = normalizeScheduleProfileId(rule.classId);
    if (rule.action === "skip") {
      if (rule.startTime !== undefined || rule.endTime !== undefined) invalid("Skipped classes cannot specify times.");
      return { classId, action: "skip" as const };
    }
    if (rule.action !== "time") invalid("Class rules must change times or skip a meeting.");
    return { classId, action: "time" as const, startTime: text(rule.startTime, 5, "Start time"), endTime: text(rule.endTime, 5, "End time") };
  }).sort((a, b) => a.classId.localeCompare(b.classId));
  unique(classRules.map((rule) => rule.classId), "Class rules");
  const testingBlocks = list(row.testingBlocks, SCHEDULE_PROFILE_LIMITS.blocks, "Testing blocks").map((value) => {
    const block = record(value, ["id", "name", "coverageGroupId", "assignedStaffId", "startTime", "endTime"], "Testing block");
    return { id: normalizeScheduleProfileId(block.id), name: text(block.name, 80, "Testing block name"),
      coverageGroupId: optionalId(block.coverageGroupId), assignedStaffId: optionalId(block.assignedStaffId),
      startTime: text(block.startTime, 5, "Start time"), endTime: text(block.endTime, 5, "End time") };
  }).sort((a, b) => a.id.localeCompare(b.id));
  unique(testingBlocks.map((block) => block.id), "Testing blocks");
  return { name: text(row.name, 80, "Profile name"), grades, classIds, classRules, testingBlocks };
}

type Staff = { id: string; name: string };
export type DraftReviewFacts = {
  referenceDate: string; revision: number; schoolTimezone: string; config: SchoolSchedulingConfig; calendar: SchedulingCalendar;
  tracking: HeartbeatTrackingSettings | undefined;
  classes: Array<SchedulingGroup & { id: string; name: string; gradeLevel: string | null; staff: Staff[]; studentIds: string[]; unavailableStaff?: boolean }>;
  supervisionGroups: Array<{ id: string; name: string; studentIds: string[]; inactiveStudents: number; staffIds: string[] }>;
  staff: Staff[];
};
export type DraftReviewIssue = { id: string; kind: "conflict" | "overlap" | "incomplete"; code: string; message: string; classIds: string[]; blockIds: string[]; staffIds: string[] };

/** Current regular configuration plus this draft, never a live or historical snapshot. */
export function projectScheduleDraftReview(definition: ScheduleProfileDefinition, facts: DraftReviewFacts) {
  const regular = projectClasspilotRegularSchedule(facts);
  const issues: DraftReviewIssue[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const issue = (kind: DraftReviewIssue["kind"], code: string, message: string, classIds: string[] = [], blockIds: string[] = [], staffIds: string[] = []) => {
    const refs = { classIds: [...new Set(classIds)].sort(), blockIds: [...new Set(blockIds)].sort(), staffIds: [...new Set(staffIds)].sort() };
    const id = hash({ kind, code, ...refs }).slice(0, 24);
    if (seen.has(id)) return;
    if (issues.length >= READ_LIMITS.issues) { truncated = true; return; }
    seen.add(id); issues.push({ id, kind, code, message, ...refs });
  };
  if (!definition.name) issue("incomplete", "SCHEDULE_DRAFT_NAME_INCOMPLETE", "Enter a profile name before saving.");
  if (!regular.day.instructional) issue("incomplete", "SCHEDULE_DRAFT_REFERENCE_CLOSED", "Choose an instructional reference date to review the proposed day. This date does not activate the profile.");
  const sourceById = new Map(facts.classes.map((row) => [row.id, row]));
  const rules = new Map(definition.classRules.map((rule) => [rule.classId, rule]));
  const classIds = new Set(definition.classIds), grades = new Set(definition.grades);
  for (const id of new Set([...classIds, ...rules.keys()])) if (!sourceById.has(id)) issue("incomplete", "SCHEDULE_PROFILE_REFERENCE", "A selected class is no longer active in this school. Update the profile.", [id]);
  const classes = regular.classes.map((resolved) => {
    const source = sourceById.get(resolved.classId)!;
    const selected = classIds.has(source.id) || (!!source.gradeLevel && grades.has(source.gradeLevel));
    const rule = rules.get(source.id);
    let proposedWindow = resolved.window;
    let proposedStatus: typeof resolved.status | "skipped" | "incomplete" = resolved.status;
    const action = rule?.action ?? "keep";
    if (source.unavailableStaff) issue("incomplete", "SCHEDULE_DRAFT_STAFF_UNAVAILABLE", `${source.name}: an assigned teacher is not an active staff member in this school. Resolve that assignment before relying on the review.`, [source.id]);
    if (resolved.status === "unavailable") issue("incomplete", resolved.code ?? "SCHEDULE_PERIOD_UNAVAILABLE", `${source.name}: ${resolved.message ?? "Regular schedule unavailable."}`, [source.id]);
    if (rule && (!selected || !source.scheduleEnabled)) issue("incomplete", "SCHEDULE_PROFILE_REFERENCE", `${source.name}: changed classes must have an enabled schedule and belong to the profile selection.`, [source.id]);
    if (rule?.action === "time" && !validWindow(rule)) {
      proposedWindow = null;
      proposedStatus = "incomplete";
      issue("incomplete", "SCHEDULE_DRAFT_CLASS_INCOMPLETE", `${source.name}: enter a valid start and end time. This class is not checked yet.`, [source.id]);
    } else if (selected && source.scheduleEnabled && resolved.window && rule) {
      proposedWindow = rule.action === "skip" ? null : { startTime: rule.startTime!, endTime: rule.endTime! };
      if (rule.action === "skip") proposedStatus = "skipped";
    }
    return { classId: source.id, name: source.name, gradeLevel: source.gradeLevel, staff: source.staff, selected, status: resolved.status, proposedStatus, regularWindow: resolved.window, proposedWindow, action };
  });
  if (!classes.some((row) => row.selected) && !definition.testingBlocks.length) issue("incomplete", "SCHEDULE_DRAFT_SELECTION_INCOMPLETE", "Select classes or add a testing block to review this profile.");
  const groupById = new Map(facts.supervisionGroups.map((group) => [group.id, group]));
  const staffById = new Map(facts.staff.map((staff) => [staff.id, staff]));
  const testingStudents = new Map<string, Set<string>>();
  const testingBlocks = definition.testingBlocks.map((block) => {
    const group = groupById.get(block.coverageGroupId);
    const staff = staffById.get(block.assignedStaffId);
    const targets = new Set(group?.studentIds ?? []);
    testingStudents.set(block.id, targets);
    let status: "ready" | "incomplete" | "unavailable" = "ready";
    if (!block.name || !block.coverageGroupId || !block.assignedStaffId || !validWindow(block)) {
      status = "incomplete";
      issue("incomplete", "SCHEDULE_DRAFT_BLOCK_INCOMPLETE", `${block.name || "Testing block"}: choose a group and staff member, enter a name and valid times. This block is not checked yet.`, [], [block.id], staff ? [staff.id] : []);
    } else if (!group || !staff || !group.staffIds.includes(staff.id)) {
      status = "unavailable";
      issue("incomplete", "SCHEDULE_PROFILE_REFERENCE", `${block.name}: choose an active supervision group and a staff member paired with it.`, [], [block.id], staff ? [staff.id] : []);
    } else if (!targets.size || targets.size > SCHEDULE_PROFILE_LIMITS.studentsPerWindow || group.inactiveStudents) {
      status = "unavailable";
      issue("incomplete", "SCHEDULE_DRAFT_GROUP_UNAVAILABLE", `${block.name}: choose a group with one to 500 active students and resolve inactive members.`, [], [block.id], [staff.id]);
    }
    if (status === "ready" && regular.day.instructional && !scheduleProfileWindowHasFullMonitoring({ ...block, date: facts.referenceDate }, facts.tracking && {
      ...facts.tracking, schoolTimezone: facts.schoolTimezone, instructionalCalendar: facts.calendar, schedulingDateOverrides: facts.config.dateOverrides,
    })) issue("conflict", "SCHEDULE_PROFILE_MONITORING_NOT_FULL", `${block.name}: full classroom monitoring must be available throughout this block. Review Monitoring Hours.`, [], [block.id], [block.assignedStaffId]);
    const classParticipation = facts.classes.flatMap((row) => {
      const count = row.studentIds.filter((id) => targets.has(id)).length;
      return count ? [{ classId: row.id, count, total: row.studentIds.length }] : [];
    });
    return { blockId: block.id, name: block.name, coverageGroupId: block.coverageGroupId, groupName: group?.name ?? null,
      assignedStaffId: block.assignedStaffId, staffName: staff?.name ?? null, startTime: block.startTime, endTime: block.endTime, status, studentCount: targets.size, classParticipation };
  });
  let comparisons = 0;
  const checkLimit = () => { if (++comparisons > READ_LIMITS.comparisons || truncated) { truncated = true; return false; } return true; };
  if (regular.day.instructional) {
    const meetings = classes.filter((row) => row.proposedWindow).sort((a, b) => a.proposedWindow!.startTime.localeCompare(b.proposedWindow!.startTime));
    for (let i = 0; i < meetings.length && !truncated; i++) for (let j = i + 1; j < meetings.length && meetings[j]!.proposedWindow!.startTime < meetings[i]!.proposedWindow!.endTime; j++) {
      if (!checkLimit()) break;
      const a = meetings[i]!, b = meetings[j]!;
      const staffIds = a.staff.filter((staff) => b.staff.some((other) => staff.id === other.id)).map((staff) => staff.id);
      if (staffIds.length) issue("conflict", "CLASS_SCHEDULE_CONFLICT", `${a.name} and ${b.name} overlap for an assigned teacher.`, [a.classId, b.classId], [], staffIds);
    }
    const readyBlocks = testingBlocks.filter((block) => block.status === "ready");
    for (let i = 0; i < readyBlocks.length && !truncated; i++) {
      const block = readyBlocks[i]!, targets = testingStudents.get(block.blockId)!;
      for (const other of readyBlocks.slice(0, i)) {
        if (!checkLimit()) break;
        if (scheduleProfileWindowsOverlap(block, other) && (block.assignedStaffId === other.assignedStaffId || [...targets].some((id) => testingStudents.get(other.blockId)!.has(id)))) {
          issue("conflict", "SCHEDULE_PROFILE_CONFLICT", `${block.name} and ${other.name} assign staff or students to overlapping testing blocks.`, [], [block.blockId, other.blockId], [block.assignedStaffId, other.assignedStaffId]);
        }
      }
      for (const row of meetings) {
        if (!checkLimit()) break;
        if (!scheduleProfileWindowsOverlap(block, row.proposedWindow!)) continue;
        const source = sourceById.get(row.classId)!;
        const isProctor = row.staff.some((staff) => staff.id === block.assignedStaffId);
        if (isProctor && testingRosterHasOtherClassStudents(source.studentIds, targets)) issue("conflict", "SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT", `${block.name}: the assigned staff member also teaches ${row.name} during this block. Include that entire class in this testing group, adjust the class, or choose another proctor.`, [row.classId], [block.blockId], [block.assignedStaffId]);
        else if (isProctor || source.studentIds.some((id) => targets.has(id))) issue("overlap", "SCHEDULE_DRAFT_TESTING_CLASS_OVERLAP", `${block.name} overlaps ${row.name}. Testing supervision takes precedence for participating students; the regular class remains scheduled.`, [row.classId], [block.blockId], [block.assignedStaffId]);
      }
    }
  }
  if (truncated) issues.push({ id: "review-limit", kind: "incomplete", code: "SCHEDULE_DRAFT_REVIEW_LIMIT", message: "The review reached its analysis limit. The day is not fully checked; narrow the schedule or resolve existing issues before reviewing again.", classIds: [], blockIds: [], staffIds: [] });
  const counts = { conflicts: issues.filter((row) => row.kind === "conflict").length, overlaps: issues.filter((row) => row.kind === "overlap").length, incomplete: issues.filter((row) => row.kind === "incomplete").length };
  return { referenceDate: regular.referenceDate, revision: regular.revision, schoolTimezone: regular.schoolTimezone, day: regular.day,
    requestFingerprint: hash({ referenceDate: facts.referenceDate, definition }), complete: counts.incomplete === 0, classes, testingBlocks, issues, counts };
}

/** One tenant-bound, coherent snapshot. Never calls live/session or profile application readers. */
export async function getScheduleDraftReview(options: { schoolId: string; referenceDate: unknown; definition: unknown; dbInstance?: typeof import("../db.js").default }) {
  const referenceDate = regularScheduleReferenceDate(options.referenceDate);
  const definition = normalizeScheduleDraftReviewDefinition(options.definition);
  const database = options.dbInstance ?? (await import("../db.js")).default;
  return database.transaction(async (tx) => {
    const [schoolRows, scheduleRows, settingRows, classRows] = await Promise.all([
      tx.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId)).limit(1),
      tx.select({ config: sql<unknown>`${classpilotSchoolSchedules.config} - 'scheduleProfiles' - 'profileApplications'`, revision: classpilotSchoolSchedules.revision }).from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, options.schoolId)).limit(1),
      tx.select({ instructionalCalendar: settings.instructionalCalendar, enableTrackingHours: settings.enableTrackingHours, trackingStartTime: settings.trackingStartTime,
        trackingEndTime: settings.trackingEndTime, trackingDays: settings.trackingDays, afterHoursMode: settings.afterHoursMode }).from(settings).where(eq(settings.schoolId, options.schoolId)).limit(1),
      tx.select({ id: groups.id, name: groups.name, gradeLevel: groups.gradeLevel, teacherId: groups.teacherId, scheduleEnabled: groups.scheduleEnabled,
        blockStartTime: groups.blockStartTime, blockEndTime: groups.blockEndTime, scheduleRule: groups.scheduleRule }).from(groups)
        .where(and(eq(groups.schoolId, options.schoolId), eq(groups.status, "active"))).orderBy(groups.id).limit(READ_LIMITS.classes + 1),
    ]);
    if (!schoolRows[0]) throw schedulingError("School not found.", "SCHOOL_NOT_FOUND", 404);
    if (!settingRows[0]) throw schedulingError("School calendar settings are unavailable.", "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE", 500);
    const assertLimit = (rows: unknown[], maximum: number) => { if (rows.length > maximum) throw schedulingError("This school has too many related records for a complete draft review. Resolve the schedule size before reviewing again.", "SCHEDULE_DRAFT_REVIEW_LIMIT", 413); };
    assertLimit(classRows, READ_LIMITS.classes);
    const ids = classRows.map((row) => row.id), requestedGroups = [...new Set(definition.testingBlocks.map((block) => block.coverageGroupId).filter(Boolean))];
    const [classStaff, classMembers, scopeGroups, scopeMembers, assignments] = await Promise.all([
      ids.length ? tx.select({ classId: groupTeachers.groupId, staffId: groupTeachers.teacherId }).from(groupTeachers).innerJoin(groups, and(eq(groups.id, groupTeachers.groupId), eq(groups.schoolId, options.schoolId)))
        .where(inArray(groupTeachers.groupId, ids)).orderBy(groupTeachers.groupId, groupTeachers.teacherId).limit(READ_LIMITS.relationships + 1) : [],
      ids.length && requestedGroups.length ? tx.select({ classId: groupStudents.groupId, studentId: groupStudents.studentId }).from(groupStudents).innerJoin(groups, and(eq(groups.id, groupStudents.groupId), eq(groups.schoolId, options.schoolId)))
        .innerJoin(students, and(eq(students.id, groupStudents.studentId), eq(students.schoolId, options.schoolId), eq(students.status, "active")))
        .where(inArray(groupStudents.groupId, ids)).orderBy(groupStudents.groupId, groupStudents.studentId).limit(READ_LIMITS.relationships + 1) : [],
      requestedGroups.length ? tx.select({ id: classpilotCoverageScopeGroups.id, name: classpilotCoverageScopeGroups.name }).from(classpilotCoverageScopeGroups)
        .where(and(eq(classpilotCoverageScopeGroups.schoolId, options.schoolId), eq(classpilotCoverageScopeGroups.active, true), inArray(classpilotCoverageScopeGroups.id, requestedGroups))) : [],
      requestedGroups.length ? tx.select({ groupId: classpilotCoverageScopeGroupMembers.coverageGroupId, studentId: students.id, status: students.status }).from(classpilotCoverageScopeGroupMembers)
        .innerJoin(classpilotCoverageScopeGroups, and(eq(classpilotCoverageScopeGroups.id, classpilotCoverageScopeGroupMembers.coverageGroupId), eq(classpilotCoverageScopeGroups.schoolId, options.schoolId), eq(classpilotCoverageScopeGroups.active, true)))
        .innerJoin(students, and(eq(students.id, classpilotCoverageScopeGroupMembers.studentId), eq(students.schoolId, options.schoolId)))
        .where(and(eq(classpilotCoverageScopeGroupMembers.schoolId, options.schoolId), inArray(classpilotCoverageScopeGroupMembers.coverageGroupId, requestedGroups)))
        .orderBy(classpilotCoverageScopeGroupMembers.coverageGroupId, students.id).limit(READ_LIMITS.relationships + 1) : [],
      requestedGroups.length ? tx.select({ groupId: classpilotCoverageAssignments.scopeValue, staffId: classpilotCoverageAssignments.staffId, permissions: classpilotCoverageAssignments.permissions }).from(classpilotCoverageAssignments)
        .where(and(eq(classpilotCoverageAssignments.schoolId, options.schoolId), eq(classpilotCoverageAssignments.active, true), eq(classpilotCoverageAssignments.scopeType, "coverage_group"), inArray(classpilotCoverageAssignments.scopeValue, requestedGroups)))
        .orderBy(classpilotCoverageAssignments.id).limit(READ_LIMITS.relationships + 1) : [],
    ]);
    for (const rows of [classStaff, classMembers, scopeMembers, assignments]) assertLimit(rows, READ_LIMITS.relationships);
    const staffIds = [...new Set([...classRows.map((row) => row.teacherId), ...classStaff.map((row) => row.staffId), ...assignments.map((row) => row.staffId), ...definition.testingBlocks.map((row) => row.assignedStaffId)].filter(Boolean))];
    assertLimit(staffIds, READ_LIMITS.staff);
    const staffRows = staffIds.length ? await tx.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(schoolMemberships)
      .innerJoin(users, eq(users.id, schoolMemberships.userId)).where(and(eq(schoolMemberships.schoolId, options.schoolId), eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, ["admin", "school_admin", "teacher", "office_staff"]), inArray(schoolMemberships.userId, staffIds))).limit(READ_LIMITS.relationships + 1) : [];
    assertLimit(staffRows, READ_LIMITS.relationships);
    const staff = [...new Map(staffRows.map((row) => [row.id, { id: row.id, name: [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email }])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const staffById = new Map(staff.map((row) => [row.id, row]));
    function index(rows: Array<{ parent: string; value: string }>) {
      const result = new Map<string, string[]>();
      for (const row of rows) { const values = result.get(row.parent) ?? []; values.push(row.value); result.set(row.parent, values); }
      return result;
    }
    const teachers = index(classStaff.map((row) => ({ parent: row.classId, value: row.staffId }))), rosters = index(classMembers.map((row) => ({ parent: row.classId, value: row.studentId })));
    const config = scheduleRows[0] ? normalizeSchoolSchedulingConfig(scheduleRows[0].config) : emptySchoolSchedulingConfig();
    return projectScheduleDraftReview(definition, { referenceDate, revision: scheduleRows[0]?.revision ?? 0, schoolTimezone: schoolRows[0].timezone || "America/New_York", config,
      calendar: settingRows[0].instructionalCalendar ?? {}, tracking: { ...settingRows[0], schoolTimezone: schoolRows[0].timezone }, staff,
      classes: classRows.map((row) => {
        const assigned = [...new Set([row.teacherId, ...(teachers.get(row.id) ?? [])])];
        return { ...row, staff: assigned.flatMap((id) => { const found = staffById.get(id); return found ? [found] : []; }),
          unavailableStaff: assigned.some((id) => !staffById.has(id)), studentIds: rosters.get(row.id) ?? [] };
      }),
      supervisionGroups: scopeGroups.map((group) => ({ ...group, studentIds: scopeMembers.filter((member) => member.groupId === group.id && member.status === "active").map((member) => member.studentId),
        inactiveStudents: scopeMembers.filter((member) => member.groupId === group.id && member.status !== "active").length,
        staffIds: [...new Set(assignments.filter((assignment) => assignment.groupId === group.id && staffById.has(assignment.staffId)
          && ((assignment.permissions as Record<string, unknown>).claim === true || (assignment.permissions as Record<string, unknown>).observe === true)).map((assignment) => assignment.staffId))] })),
    });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
