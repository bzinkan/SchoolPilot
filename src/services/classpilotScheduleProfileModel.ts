/** Reusable plans and immutable, school-local dated snapshots. No live roster reads. */
export type ScheduleProfileWindow = { startTime: string; endTime: string };
/** Half-open school-local windows: a meeting ending at the next start does not overlap. */
export function scheduleProfileWindowsOverlap(a: ScheduleProfileWindow, b: ScheduleProfileWindow): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}
export type ScheduleProfileDefinition = {
  name: string;
  grades: string[];
  classIds: string[];
  classRules: Array<{ classId: string; action: "time" | "skip"; startTime?: string; endTime?: string }>;
  testingBlocks: Array<{ id: string; name: string; coverageGroupId: string; assignedStaffId: string; startTime: string; endTime: string }>;
};
export type SavedScheduleProfile = {
  id: string;
  revision: number;
  definition: ScheduleProfileDefinition;
  updatedAt: string;
};
export type ScheduleProfileTestingWindow = {
  date: string;
  blockId: string;
  name: string;
  coverageGroupId: string;
  assignedStaffId: string;
  studentIds: string[];
  startTime: string;
  endTime: string;
};
export type ScheduleProfileApplication = {
  id: string;
  profileId: string;
  profileName: string;
  profileRevision: number;
  dates: string[];
  definition: ScheduleProfileDefinition;
  classWindows: Record<string, Record<string, ScheduleProfileWindow | null>>;
  testingWindows: ScheduleProfileTestingWindow[];
  status: "scheduled" | "cancelled";
  createdBy: string;
  createdAt: string;
};
export const SCHEDULE_PROFILE_LIMITS = {
  profiles: 30, applications: 100, dates: 31, classes: 500, blocks: 30,
  classWindows: 15_500, testingWindows: 2_000, studentsPerWindow: 500, grades: 30,
} as const;

function invalid(message: string, code = "INVALID_SCHEDULE_PROFILE", status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid(`${label} contains an unsupported field.`);
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(`${label} must be an array with at most ${max} entries.`);
  return value;
}
export function normalizeScheduleProfileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)
    || ["__proto__", "constructor", "prototype"].includes(value)) {
    throw invalid("Schedule profile references need 1–128 letters, numbers, underscores or hyphens and cannot be reserved object keys.");
  }
  return value;
}
function label(value: unknown, field: string, max = 80): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${field} needs 1–${max} characters without control characters.`);
  return value.trim();
}
function unique<T>(values: T[], field: string): T[] {
  if (new Set(values).size !== values.length) throw invalid(`${field} must be unique.`);
  return values;
}
function ids(value: unknown, max: number, field: string): string[] {
  return unique(list(value, max, field).map(normalizeScheduleProfileId), field).sort();
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid("Application dates must be real dates in YYYY-MM-DD format.");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw invalid("Profile timestamps must be UTC ISO timestamps.");
  date(value.slice(0, 10));
  return new Date(value).toISOString();
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid("Profile revisions must be positive safe integers.");
  return value;
}
function window(value: unknown): ScheduleProfileWindow {
  const row = object(value, "Schedule window"); keys(row, ["startTime", "endTime"], "Schedule window");
  if (typeof row.startTime !== "string" || typeof row.endTime !== "string"
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.endTime)
    || row.startTime >= row.endTime) throw invalid("Schedule windows require valid HH:mm times with the end after the start on the same date.");
  return { startTime: row.startTime, endTime: row.endTime };
}

export function normalizeScheduleProfileDefinition(value: unknown): ScheduleProfileDefinition {
  const row = object(value, "Schedule profile");
  keys(row, ["name", "grades", "classIds", "classRules", "testingBlocks"], "Schedule profile");
  const grades = unique(list(row.grades ?? [], SCHEDULE_PROFILE_LIMITS.grades, "Grades").map((grade) => label(grade, "Grade", 40)), "Grades").sort();
  const classIds = ids(row.classIds ?? [], SCHEDULE_PROFILE_LIMITS.classes, "Classes");
  const classRules = list(row.classRules ?? [], SCHEDULE_PROFILE_LIMITS.classes, "Class rules").map((value) => {
    const rule = object(value, "Class rule");
    keys(rule, ["classId", "action", "startTime", "endTime"], "Class rule");
    const classId = normalizeScheduleProfileId(rule.classId);
    if (rule.action === "skip") {
      if (rule.startTime !== undefined || rule.endTime !== undefined) throw invalid("A skipped class cannot also specify times.");
      return { classId, action: "skip" as const };
    }
    if (rule.action !== "time") throw invalid("Class rules must change times or skip the class.");
    return { classId, action: "time" as const, ...window({ startTime: rule.startTime, endTime: rule.endTime }) };
  }).sort((a, b) => a.classId.localeCompare(b.classId));
  unique(classRules.map((rule) => rule.classId), "Class rule references");
  const testingBlocks = list(row.testingBlocks ?? [], SCHEDULE_PROFILE_LIMITS.blocks, "Testing blocks").map((value) => {
    const block = object(value, "Testing block");
    keys(block, ["id", "name", "coverageGroupId", "assignedStaffId", "startTime", "endTime"], "Testing block");
    return { id: normalizeScheduleProfileId(block.id), name: label(block.name, "Testing block name"),
      coverageGroupId: normalizeScheduleProfileId(block.coverageGroupId), assignedStaffId: normalizeScheduleProfileId(block.assignedStaffId),
      ...window({ startTime: block.startTime, endTime: block.endTime }) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  unique(testingBlocks.map((block) => block.id), "Testing block IDs");
  return { name: label(row.name, "Schedule profile name"), grades, classIds, classRules, testingBlocks };
}

export function normalizeSavedScheduleProfile(value: unknown): SavedScheduleProfile {
  const row = object(value, "Saved schedule profile");
  keys(row, ["id", "revision", "definition", "updatedAt"], "Saved schedule profile");
  return { id: normalizeScheduleProfileId(row.id), revision: revision(row.revision), definition: normalizeScheduleProfileDefinition(row.definition), updatedAt: timestamp(row.updatedAt) };
}

export function normalizeScheduleProfileApplication(value: unknown): ScheduleProfileApplication {
  const row = object(value, "Schedule profile application");
  keys(row, ["id", "profileId", "profileName", "profileRevision", "dates", "definition", "classWindows", "testingWindows", "status", "createdBy", "createdAt"], "Schedule profile application");
  const dates = unique(list(row.dates, SCHEDULE_PROFILE_LIMITS.dates, "Application dates").map(date), "Application dates").sort();
  if (!dates.length) throw invalid("Choose at least one application date.");
  const dateSet = new Set(dates);
  const definition = normalizeScheduleProfileDefinition(row.definition);
  const profileName = label(row.profileName, "Applied profile name");
  if (profileName !== definition.name) throw invalid("The application name must match its saved definition snapshot.");
  const classRules = new Map(definition.classRules.map((rule) => [rule.classId, rule]));
  const classWindows: ScheduleProfileApplication["classWindows"] = {};
  const rawDates = object(row.classWindows, "Application class windows");
  if (Object.keys(rawDates).length > SCHEDULE_PROFILE_LIMITS.dates) throw invalid("Too many dates in application class windows.");
  let classWindowCount = 0;
  for (const [key, value] of Object.entries(rawDates).sort(([a], [b]) => a.localeCompare(b))) {
    if (!dateSet.has(date(key))) throw invalid("Class windows must belong to an application date.");
    const rawClasses = object(value, "Dated class windows");
    if (Object.keys(rawClasses).length > SCHEDULE_PROFILE_LIMITS.classes) throw invalid("Too many classes in a dated application.");
    const windows: Record<string, ScheduleProfileWindow | null> = {};
    for (const [classId, value] of Object.entries(rawClasses).sort(([a], [b]) => a.localeCompare(b))) {
      normalizeScheduleProfileId(classId);
      const rule = classRules.get(classId);
      if (!rule) throw invalid("Applied class windows must reference a class rule in the definition snapshot.");
      const next = value === null ? null : window(value);
      if ((rule.action === "skip" && next !== null) || (rule.action === "time" && (!next || rule.startTime !== next.startTime || rule.endTime !== next.endTime))) throw invalid("Applied class windows must match their definition snapshot.");
      windows[classId] = next;
      if (++classWindowCount > SCHEDULE_PROFILE_LIMITS.classWindows) throw invalid("Too many class windows in this application.");
    }
    classWindows[key] = windows;
  }
  const blocks = new Map(definition.testingBlocks.map((block) => [block.id, block]));
  const testingWindows = list(row.testingWindows, SCHEDULE_PROFILE_LIMITS.dates * SCHEDULE_PROFILE_LIMITS.blocks, "Application testing windows").map((value) => {
    const w = object(value, "Testing window");
    keys(w, ["date", "blockId", "name", "coverageGroupId", "assignedStaffId", "studentIds", "startTime", "endTime"], "Testing window");
    const result = { date: date(w.date), blockId: normalizeScheduleProfileId(w.blockId), name: label(w.name, "Testing window name"),
      coverageGroupId: normalizeScheduleProfileId(w.coverageGroupId), assignedStaffId: normalizeScheduleProfileId(w.assignedStaffId),
      studentIds: ids(w.studentIds, SCHEDULE_PROFILE_LIMITS.studentsPerWindow, "Testing students"), ...window({ startTime: w.startTime, endTime: w.endTime }) };
    if (!dateSet.has(result.date)) throw invalid("Testing windows must belong to an application date.");
    const block = blocks.get(result.blockId);
    if (!block || block.name !== result.name || block.coverageGroupId !== result.coverageGroupId || block.assignedStaffId !== result.assignedStaffId
      || block.startTime !== result.startTime || block.endTime !== result.endTime) throw invalid("Testing windows must match their definition snapshot.");
    if (!result.studentIds.length) throw invalid("Each applied testing window needs at least one student.");
    return result;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.blockId.localeCompare(b.blockId));
  unique(testingWindows.map((w) => `${w.date}:${w.blockId}`), "Testing date/block pairs");
  if (row.status !== "scheduled" && row.status !== "cancelled") throw invalid("Application status must be scheduled or cancelled.");
  return { id: normalizeScheduleProfileId(row.id), profileId: normalizeScheduleProfileId(row.profileId), profileName,
    profileRevision: revision(row.profileRevision), dates, definition, classWindows, testingWindows, status: row.status,
    createdBy: normalizeScheduleProfileId(row.createdBy), createdAt: timestamp(row.createdAt) };
}

export function normalizeScheduleProfileCollections(scheduleProfiles: unknown = [], profileApplications: unknown = []): {
  scheduleProfiles: SavedScheduleProfile[]; profileApplications: ScheduleProfileApplication[];
} {
  const profiles = list(scheduleProfiles, SCHEDULE_PROFILE_LIMITS.profiles, "Saved schedule profiles").map(normalizeSavedScheduleProfile).sort((a, b) => a.id.localeCompare(b.id));
  const applications = list(profileApplications, SCHEDULE_PROFILE_LIMITS.applications, "Profile applications").map(normalizeScheduleProfileApplication).sort((a, b) => a.id.localeCompare(b.id));
  unique(profiles.map((p) => p.id), "Saved profile IDs");
  unique(applications.map((a) => a.id), "Application IDs");
  const reserved = new Set<string>();
  let testingCount = 0;
  for (const application of applications) {
    testingCount += application.testingWindows.length;
    if (testingCount > SCHEDULE_PROFILE_LIMITS.testingWindows) throw invalid("Up to 2,000 testing windows are supported across school applications.");
    if (application.status !== "scheduled") continue;
    for (const [date, windows] of Object.entries(application.classWindows)) for (const classId of Object.keys(windows)) {
      const key = `${date}:${classId}`;
      if (reserved.has(key)) throw invalid("Two active profile applications cannot change the same class on the same date.", "SCHEDULE_PROFILE_APPLICATION_CONFLICT", 409);
      reserved.add(key);
    }
  }
  // Applications remain valid snapshots when the reusable catalog profile changes or is removed.
  return { scheduleProfiles: profiles, profileApplications: applications };
}

/** undefined means unaffected; null is an explicit, exact class/date cancellation. */
export function resolveAppliedScheduleProfileWindow(applications: ScheduleProfileApplication[] | undefined, classId: string | undefined, date: string): ScheduleProfileWindow | null | undefined {
  if (!classId) return undefined;
  normalizeScheduleProfileId(classId);
  let result: ScheduleProfileWindow | null | undefined;
  for (const application of applications ?? []) {
    if (application.status !== "scheduled" || !application.dates.includes(date)) continue;
    const windows = application.classWindows[date];
    if (!windows || !Object.hasOwn(windows, classId)) continue;
    if (result !== undefined) throw invalid("Two active profile applications cannot change the same class on the same date.", "SCHEDULE_PROFILE_APPLICATION_CONFLICT", 409);
    result = windows[classId];
  }
  return result;
}
