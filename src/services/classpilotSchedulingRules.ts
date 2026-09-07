/** School-local calendar rules. One class has at most one occurrence per date. */
import {
  normalizeScheduleProfileCollections, resolveAppliedScheduleProfileWindow,
  type SavedScheduleProfile, type ScheduleProfileApplication,
} from "./classpilotScheduleProfileModel.js";
export type ClasspilotScheduleRule = {
  weekdays: number[];
  startsOn: string | null;
  endsOn: string | null;
  cycleDay: "all" | "A" | "B";
  periodId: string | null;
};
export type BellWindow = { startTime: string; endTime: string };
export type SchoolSchedulingConfig = {
  schemaVersion: 1;
  yearStart: string | null;
  yearEnd: string | null;
  cycleAnchorDate: string | null;
  cycleAnchorDay: "A" | "B";
  periods: Array<{ id: string; name: string }>;
  profiles: Array<{ id: string; name: string; periods: Record<string, BellWindow> }>;
  defaultProfileId: string | null;
  weekdayProfiles: Record<string, string>;
  dateOverrides: Record<string, { profileId?: string; cycleDay?: "A" | "B"; instructional?: boolean; meetingWeekday?: number }>;
  scheduleProfiles?: SavedScheduleProfile[];
  profileApplications?: ScheduleProfileApplication[];
};
export type SchedulingCalendar = Record<string, { nonInstructionalDates?: string[] }>;
export const emptySchoolSchedulingConfig = (): SchoolSchedulingConfig => ({
  schemaVersion: 1, yearStart: null, yearEnd: null, cycleAnchorDate: null,
  cycleAnchorDay: "A", periods: [], profiles: [], defaultProfileId: null,
  weekdayProfiles: {}, dateOverrides: {}, scheduleProfiles: [], profileApplications: [],
});
export const defaultClassScheduleRule = (): ClasspilotScheduleRule => ({
  weekdays: [1, 2, 3, 4, 5], startsOn: null, endsOn: null, cycleDay: "all", periodId: null,
});
export function schedulingError(message: string, code = "INVALID_SCHEDULING_CONFIG", status = 400) {
  return Object.assign(new Error(message), { code, status, expose: true });
}
export function isSchedulingDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function datePlusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export function dateWeekday(date: string): number { return new Date(`${date}T12:00:00Z`).getUTCDay(); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw schedulingError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw schedulingError(`${label} contains an unsupported field.`);
}
function optionalDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isSchedulingDate(value)) throw schedulingError(`${label} must be a real date in YYYY-MM-DD format.`);
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) throw schedulingError("Period and profile IDs must contain 1–64 letters, numbers, underscores or hyphens and must not be reserved object keys.");
  return value;
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw schedulingError("A name of 1–80 characters is required.");
  return value.trim();
}
export function normalizeClassScheduleRule(value: unknown): ClasspilotScheduleRule {
  if (value === null || value === undefined) return defaultClassScheduleRule();
  const row = object(value, "Class schedule");
  exactKeys(row, ["weekdays", "startsOn", "endsOn", "cycleDay", "periodId"], "Class schedule");
  const weekdays = row.weekdays ?? [1, 2, 3, 4, 5];
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(weekdays).size !== weekdays.length) {
    throw schedulingError("Choose one or more unique weekdays, Sunday through Saturday.");
  }
  const startsOn = optionalDate(row.startsOn, "First class date");
  const endsOn = optionalDate(row.endsOn, "Last class date");
  if (startsOn && endsOn && startsOn > endsOn) throw schedulingError("The last class date must be on or after the first class date.");
  const cycleDay = row.cycleDay ?? "all";
  if (!["all", "A", "B"].includes(String(cycleDay))) throw schedulingError("Cycle day must be all, A or B.");
  return { weekdays: [...weekdays].sort(), startsOn, endsOn, cycleDay: cycleDay as ClasspilotScheduleRule["cycleDay"], periodId: row.periodId ? identifier(row.periodId) : null };
}
export function normalizeSchoolSchedulingConfig(value: unknown): SchoolSchedulingConfig {
  const row = object(value, "School schedule");
  exactKeys(row, Object.keys(emptySchoolSchedulingConfig()), "School schedule");
  if (row.schemaVersion !== 1) throw schedulingError("Unsupported school schedule version.");
  const yearStart = optionalDate(row.yearStart, "School year start");
  const yearEnd = optionalDate(row.yearEnd, "School year end");
  if (Boolean(yearStart) !== Boolean(yearEnd) || (yearStart && yearEnd && (yearEnd < yearStart || yearEnd > datePlusDays(yearStart, 550)))) throw schedulingError("Choose a school year date range of at most 550 days.");
  const cycleAnchorDate = optionalDate(row.cycleAnchorDate, "A/B anchor date");
  if (cycleAnchorDate && (!yearStart || !yearEnd || cycleAnchorDate < yearStart || cycleAnchorDate > yearEnd)) throw schedulingError("The A/B anchor must be an instructional date in the configured school year.");
  const cycleAnchorDay = row.cycleAnchorDay ?? "A";
  if (cycleAnchorDay !== "A" && cycleAnchorDay !== "B") throw schedulingError("Anchor day must be A or B.");
  if (!Array.isArray(row.periods) || row.periods.length > 30 || !Array.isArray(row.profiles) || row.profiles.length > 30) throw schedulingError("Up to 30 periods and 30 bell profiles are supported.");
  const periods = row.periods.map((value) => { const p = object(value, "Period"); exactKeys(p, ["id", "name"], "Period"); return { id: identifier(p.id), name: name(p.name) }; });
  const periodIds = new Set(periods.map((p) => p.id));
  if (periodIds.size !== periods.length) throw schedulingError("Period IDs must be unique.");
  const profiles = row.profiles.map((value) => {
    const p = object(value, "Bell profile"); exactKeys(p, ["id", "name", "periods"], "Bell profile");
    const windows = object(p.periods, "Profile periods");
    const result: Record<string, BellWindow> = {};
    for (const [key, value] of Object.entries(windows)) {
      if (!periodIds.has(key)) throw schedulingError("A bell profile refers to an unknown period.");
      const window = object(value, "Bell window"); exactKeys(window, ["startTime", "endTime"], "Bell window");
      if (typeof window.startTime !== "string" || typeof window.endTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.endTime) || window.startTime >= window.endTime) throw schedulingError("Each period needs valid start and end times, with the end after the start.");
      result[key] = { startTime: window.startTime, endTime: window.endTime };
    }
    return { id: identifier(p.id), name: name(p.name), periods: result };
  });
  const profileIds = new Set(profiles.map((p) => p.id));
  if (profileIds.size !== profiles.length) throw schedulingError("Bell profile IDs must be unique.");
  const profileId = (value: unknown) => { const id = identifier(value); if (!profileIds.has(id)) throw schedulingError("Choose a bell profile belonging to this school."); return id; };
  const defaultProfileId = row.defaultProfileId ? profileId(row.defaultProfileId) : null;
  const weekdayProfiles: Record<string, string> = {};
  for (const [day, id] of Object.entries(object(row.weekdayProfiles ?? {}, "Weekday profiles"))) {
    if (!/^[0-6]$/.test(day)) throw schedulingError("Weekday profiles support Sunday through Saturday.");
    weekdayProfiles[day] = profileId(id);
  }
  const overrides = object(row.dateOverrides ?? {}, "Date overrides");
  if (Object.keys(overrides).length > 550) throw schedulingError("Up to 550 date overrides are supported.");
  const dateOverrides: SchoolSchedulingConfig["dateOverrides"] = {};
  for (const [date, value] of Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isSchedulingDate(date)) throw schedulingError("Date overrides require real dates.");
    const o = object(value, "Date override"); exactKeys(o, ["profileId", "cycleDay", "instructional", "meetingWeekday"], "Date override");
    if (o.cycleDay !== undefined && o.cycleDay !== "A" && o.cycleDay !== "B") throw schedulingError("An override cycle day must be A or B.");
    if (o.instructional !== undefined && typeof o.instructional !== "boolean") throw schedulingError("Instructional date overrides must be true or false.");
    if (o.meetingWeekday !== undefined && (!Number.isInteger(o.meetingWeekday) || Number(o.meetingWeekday) < 0 || Number(o.meetingWeekday) > 6 || o.instructional !== true)) throw schedulingError("A makeup weekday requires an explicit instructional date and a weekday from Sunday through Saturday.");
    dateOverrides[date] = { ...(o.profileId ? { profileId: profileId(o.profileId) } : {}), ...(o.cycleDay ? { cycleDay: o.cycleDay as "A" | "B" } : {}), ...(o.instructional !== undefined ? { instructional: o.instructional } : {}), ...(o.meetingWeekday !== undefined ? { meetingWeekday: Number(o.meetingWeekday) } : {}) };
  }
  const profileCollections = normalizeScheduleProfileCollections(row.scheduleProfiles, row.profileApplications);
  return { schemaVersion: 1, yearStart, yearEnd, cycleAnchorDate, cycleAnchorDay, periods, profiles, defaultProfileId, weekdayProfiles, dateOverrides, ...profileCollections };
}
export function isSchedulingInstructionalDate(date: string, calendar: SchedulingCalendar, overrides: SchoolSchedulingConfig["dateOverrides"] = {}): boolean {
  return overrides[date]?.instructional ?? (![0, 6].includes(dateWeekday(date)) && !(calendar[date.slice(0, 7)]?.nonInstructionalDates ?? []).includes(date));
}
export function resolveSchoolScheduleDay(date: string, config: SchoolSchedulingConfig, calendar: SchedulingCalendar) {
  if (!isSchedulingDate(date)) throw schedulingError("Choose a real schedule date.");
  const instructional = isSchedulingInstructionalDate(date, calendar, config.dateOverrides);
  const override = config.dateOverrides[date];
  let cycleDay: "A" | "B" | null = null;
  if (instructional && config.cycleAnchorDate && config.yearStart && config.yearEnd && date >= config.yearStart && date <= config.yearEnd) {
    let offset = 0;
    const earlier = date < config.cycleAnchorDate ? date : config.cycleAnchorDate;
    const later = date < config.cycleAnchorDate ? config.cycleAnchorDate : date;
    for (let d = earlier; d < later; d = datePlusDays(d, 1)) if (isSchedulingInstructionalDate(d, calendar, config.dateOverrides)) offset++;
    cycleDay = offset % 2 === 0 ? config.cycleAnchorDay : config.cycleAnchorDay === "A" ? "B" : "A";
  }
  const meetingWeekday = override?.meetingWeekday ?? dateWeekday(date);
  return { date, instructional, meetingWeekday, cycleDay: instructional ? override?.cycleDay ?? cycleDay : null,
    profileId: override?.profileId ?? config.weekdayProfiles[String(meetingWeekday)] ?? config.defaultProfileId,
    overridden: Boolean(override),
  };
}
export type SchedulingGroup = { id?: string; scheduleEnabled: boolean; blockStartTime: string | null; blockEndTime: string | null; scheduleRule?: ClasspilotScheduleRule | null };
export function classScheduleRuleMatchesDate(rule: ClasspilotScheduleRule, date: string, day: ReturnType<typeof resolveSchoolScheduleDay>): boolean {
  return day.instructional && rule.weekdays.includes(day.meetingWeekday)
    && (!rule.startsOn || date >= rule.startsOn) && (!rule.endsOn || date <= rule.endsOn)
    && (rule.cycleDay === "all" || rule.cycleDay === day.cycleDay);
}
export function resolveClassBaseWindow(group: SchedulingGroup, date: string, config: SchoolSchedulingConfig, calendar: SchedulingCalendar, resolvedDay?: ReturnType<typeof resolveSchoolScheduleDay>): BellWindow | null {
  if (!group.scheduleEnabled) return null;
  const rule = normalizeClassScheduleRule(group.scheduleRule);
  const day = resolvedDay ?? resolveSchoolScheduleDay(date, config, calendar);
  if (!classScheduleRuleMatchesDate(rule, date, day)) return null;
  let baseline: BellWindow | null;
  if (rule.periodId) {
    const window = config.profiles.find((p) => p.id === day.profileId)?.periods[rule.periodId];
    if (!window) throw schedulingError("This class's period is missing from the date's bell profile.", "SCHEDULE_PERIOD_UNAVAILABLE", 409);
    baseline = window;
  } else baseline = group.blockStartTime && group.blockEndTime ? { startTime: group.blockStartTime, endTime: group.blockEndTime } : null;
  // A profile moves or skips an eligible occurrence; it cannot create a new class
  // occurrence outside its existing calendar, weekday, date range, or A/B rules.
  if (!baseline) return null;
  const applied = resolveAppliedScheduleProfileWindow(config.profileApplications, group.id, date);
  return applied === undefined ? baseline : applied;
}
/** Same-clock rules can overlap only on a date both classes actually meet. */
export function findScheduleOverlap(first: SchedulingGroup, second: SchedulingGroup, config: SchoolSchedulingConfig, calendar: SchedulingCalendar, fromDate: string): string | null {
  const a = normalizeClassScheduleRule(first.scheduleRule), b = normalizeClassScheduleRule(second.scheduleRule);
  if (!a.weekdays.some((d) => b.weekdays.includes(d))) return null;
  const start = [fromDate, a.startsOn, b.startsOn].filter((d): d is string => Boolean(d)).sort().at(-1)!;
  const ends = [a.endsOn, b.endsOn, (a.cycleDay !== "all" || b.cycleDay !== "all") ? config.yearEnd : null].filter((d): d is string => Boolean(d)).sort();
  const end = ends[0] ?? "9999-12-31";
  // Outside cycle schedules, weekly defaults repeat. Include every explicit future
  // exception as well as a full 550-day horizon, without unbounded date iteration.
  const through = end < datePlusDays(start, 550) ? end : datePlusDays(start, 550);
  const dates = new Set<string>();
  for (let date = start; date <= through; date = datePlusDays(date, 1)) dates.add(date);
  for (const date of Object.keys(config.dateOverrides)) if (date >= start && date <= end) dates.add(date);
  for (const application of config.profileApplications ?? []) if (application.status === "scheduled") {
    for (const date of application.dates) if (date >= start && date <= end) dates.add(date);
  }
  for (const date of [...dates].sort()) {
    const one = resolveClassBaseWindow(first, date, config, calendar), two = resolveClassBaseWindow(second, date, config, calendar);
    if (one && two && one.startTime < two.endTime && one.endTime > two.startTime) return date;
  }
  return null;
}
