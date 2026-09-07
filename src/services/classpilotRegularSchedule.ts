import { and, eq, sql } from "drizzle-orm";
import { groups } from "../schema/classpilot.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { schools } from "../schema/core.js";
import { settings } from "../schema/shared.js";
import {
  classScheduleRuleMatchesDate, emptySchoolSchedulingConfig, isSchedulingDate, normalizeClassScheduleRule, normalizeSchoolSchedulingConfig,
  resolveClassBaseWindow, resolveSchoolScheduleDay, schedulingError,
  type BellWindow, type SchedulingCalendar, type SchedulingGroup, type SchoolSchedulingConfig,
} from "./classpilotSchedulingRules.js";

type RegularScheduleClass = SchedulingGroup & { id: string };
export type RegularScheduleClassWindow = {
  classId: string;
  status: "meets" | "not_scheduled" | "schedule_off" | "unavailable";
  window: BellWindow | null;
  code?: string;
  message?: string;
};

export function regularScheduleReferenceDate(value: unknown): string {
  if (!isSchedulingDate(value)) {
    throw schedulingError("Choose a real reference date in YYYY-MM-DD format.", "INVALID_REFERENCE_DATE");
  }
  return value;
}

/** Current regular rules evaluated for a date, never an occurrence/history read. */
export function projectClasspilotRegularSchedule(options: {
  referenceDate: string;
  revision: number;
  schoolTimezone: string;
  config: SchoolSchedulingConfig;
  calendar: SchedulingCalendar;
  classes: RegularScheduleClass[];
}) {
  const referenceDate = regularScheduleReferenceDate(options.referenceDate);
  // The base resolver ordinarily includes dated profile applications. Remove
  // those only; calendar exceptions and the date's bell/A-B rules still apply.
  const config = { ...options.config, profileApplications: [] };
  const day = resolveSchoolScheduleDay(referenceDate, config, options.calendar);
  const profile = config.profiles.find((entry) => entry.id === day.profileId);
  const classes: RegularScheduleClassWindow[] = options.classes.map((group) => {
    if (!group.scheduleEnabled) return { classId: group.id, status: "schedule_off", window: null };
    try {
      const window = resolveClassBaseWindow(group, referenceDate, config, options.calendar, day);
      if (!window) {
        const rule = normalizeClassScheduleRule(group.scheduleRule);
        if (!rule.periodId && classScheduleRuleMatchesDate(rule, referenceDate, day)) {
          throw schedulingError("This class needs valid regular start and end times.", "SCHEDULE_WINDOW_UNAVAILABLE", 409);
        }
        return { classId: group.id, status: "not_scheduled", window: null };
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(window.startTime)
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.endTime) || window.startTime >= window.endTime) {
        throw schedulingError("This class needs valid regular start and end times.", "SCHEDULE_WINDOW_UNAVAILABLE", 409);
      }
      return { classId: group.id, status: "meets", window: { startTime: window.startTime, endTime: window.endTime } };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)
        || !["INVALID_SCHEDULING_CONFIG", "SCHEDULE_PERIOD_UNAVAILABLE", "SCHEDULE_WINDOW_UNAVAILABLE"].includes(String(error.code))) throw error;
      return { classId: group.id, status: "unavailable", window: null, code: String(error.code), message: error.message };
    }
  });
  return {
    referenceDate, revision: options.revision, schoolTimezone: options.schoolTimezone,
    day: { instructional: day.instructional, meetingWeekday: day.meetingWeekday, cycleDay: day.cycleDay,
      bellProfile: profile ? { id: profile.id, name: profile.name } : null, overridden: day.overridden },
    classes,
  };
}

/** Request callers already have a GUC-bound active-school context. */
export async function getClasspilotRegularSchedule(options: {
  schoolId: string;
  referenceDate: unknown;
  dbInstance?: typeof import("../db.js").default;
}) {
  const referenceDate = regularScheduleReferenceDate(options.referenceDate);
  const database = options.dbInstance ?? (await import("../db.js")).default;
  // A coherent, read-only snapshot of the small schedule inputs. Do not load
  // the full profile catalog, rosters, swaps, supervision or teaching sessions.
  return database.transaction(async (tx) => {
    const [schoolRows, scheduleRows, calendarRows, classRows] = await Promise.all([
      tx.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, options.schoolId)).limit(1),
      tx.select({
        // Profile snapshots include testing rosters and are unrelated to regular rules.
        config: sql<unknown>`${classpilotSchoolSchedules.config} - 'scheduleProfiles' - 'profileApplications'`,
        revision: classpilotSchoolSchedules.revision,
      })
        .from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, options.schoolId)).limit(1),
      tx.select({ calendar: settings.instructionalCalendar }).from(settings).where(eq(settings.schoolId, options.schoolId)).limit(1),
      tx.select({ id: groups.id, scheduleEnabled: groups.scheduleEnabled, blockStartTime: groups.blockStartTime,
        blockEndTime: groups.blockEndTime, scheduleRule: groups.scheduleRule })
        .from(groups).where(and(eq(groups.schoolId, options.schoolId), eq(groups.status, "active"))).orderBy(groups.id),
    ]);
    if (!schoolRows[0]) throw schedulingError("School not found.", "SCHOOL_NOT_FOUND", 404);
    if (!calendarRows[0]) throw schedulingError("School calendar settings are unavailable.", "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE", 500);
    const config = scheduleRows[0] ? normalizeSchoolSchedulingConfig(scheduleRows[0].config) : emptySchoolSchedulingConfig();
    return projectClasspilotRegularSchedule({ referenceDate, revision: scheduleRows[0]?.revision ?? 0,
      schoolTimezone: schoolRows[0].timezone || "America/New_York", config, calendar: calendarRows[0].calendar ?? {}, classes: classRows });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
