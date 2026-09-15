import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";
import type { ScheduleProfileApplication } from "./classpilotScheduleProfileModel.js";
import type { ProfileSupervisionStatus } from "./classpilotScheduleProfileSupervision.js";
import { datePlusDays, resolveClassBaseWindow, resolveSchoolScheduleDay, type SchedulingGroup, type SchoolSchedulingConfig, type SchedulingCalendar, type BellWindow } from "./classpilotSchedulingRules.js";

export type ApplicationCancellation = {
  canRequest: boolean;
  cutoffAt: string | null;
  reason: null | "started" | "cancelled" | "unavailable" | "no_changes";
};
export type ApplicationDateSummary = {
  date: string;
  phase: "future" | "today" | "past" | "cancelled" | "no_changes";
  customTimeCount: number;
  skippedClassCount: number;
  testingBlockCount: number;
  testingOutcomes: Record<ProfileSupervisionStatus["status"] | "unknown", number>;
  testingStatusByBlock: Record<string, ProfileSupervisionStatus["status"] | "unknown">;
};
export type ApplicationSummary = {
  dates: ApplicationDateSummary[];
  nextFutureDate: string | null;
  appliedToday: boolean;
  cancellation: ApplicationCancellation;
  historyRemoval: ApplicationHistoryRemoval;
};

export type ApplicationHistoryRemoval = {
  canRequest: boolean;
  reason: "available" | "not_past" | "supervision_pending" | "unavailable" | "hidden";
  checkedAt: string;
};
export type ApplicationHistorySupervision = {
  id: string;
  applicationId: string | null;
  date: string | null;
  blockId: string | null;
  status: string;
  endedAt: Date | null;
  hasUnreleasedStudents: boolean;
};

/** Visibility is separate from cancellation. Missing operational evidence never proves completion. */
export function applicationHistoryRemoval(options: {
  application: ScheduleProfileApplication;
  testingStatuses: ProfileSupervisionStatus[];
  supervision?: ApplicationHistorySupervision[];
  unresolvedApplicationIds?: string[];
  schoolTimezone: string;
  now: Date;
}): ApplicationHistoryRemoval {
  const { application, now } = options;
  const result = (reason: ApplicationHistoryRemoval["reason"]): ApplicationHistoryRemoval => ({ canRequest: reason === "available", reason, checkedAt: now.toISOString() });
  if (application.historyHiddenAt) return result("hidden");
  const today = localDateInTimeZone(now, options.schoolTimezone);
  if (!application.dates.length || application.dates.some(date => date >= today)) return result("not_past");
  if (!options.supervision) return result("unavailable");
  if (options.unresolvedApplicationIds?.includes(application.id)) return result("unavailable");
  const statuses = options.testingStatuses.filter(status => status.applicationId === application.id);
  const contexts = options.supervision.filter(context => context.applicationId === application.id || statuses.some(status => status.contextId === context.id));
  if (contexts.some(context => context.status === "active" || context.hasUnreleasedStudents)) return result("supervision_pending");
  if (contexts.some(context => context.status !== "ended" || !context.endedAt || !Number.isFinite(context.endedAt.getTime()) || context.endedAt > now
    || context.applicationId !== application.id || !application.testingWindows.some(window => window.date === context.date && window.blockId === context.blockId))) return result("unavailable");
  for (const window of application.testingWindows) {
    const matches = statuses.filter(status => status.date === window.date && status.blockId === window.blockId);
    if (matches.length !== 1) return result("unavailable");
    const status = matches[0]!;
    if (["pending", "active", "releasing"].includes(status.status)) return result("supervision_pending");
    if (!["ended", "failed", "missed", "cancelled"].includes(status.status)) return result("unavailable");
    const context = contexts.find(context => context.date === window.date && context.blockId === window.blockId);
    if ((status.status === "ended" && !context) || (status.contextId && context?.id !== status.contextId)) return result("unavailable");
  }
  if (statuses.some(status => !application.testingWindows.some(window => window.date === status.date && window.blockId === status.blockId))) return result("unavailable");
  return result("available");
}

export type ApplicationTiming = { earliestKnownStart: number | null; unavailable: boolean; hasChanges: boolean };

/** Reuse resolved days/classes across all applications; never run restoration previews on a list read. */
export function createApplicationTimingResolver(options: {
  classes: Array<SchedulingGroup & { id: string }>;
  config: SchoolSchedulingConfig;
  calendar: SchedulingCalendar;
  schoolTimezone: string;
}) {
  const classes = new Map(options.classes.map((row) => [row.id, row]));
  const baselineConfig = { ...options.config, profileApplications: [] };
  const days = new Map<string, ReturnType<typeof resolveSchoolScheduleDay>>();
  const baselines = new Map<string, BellWindow | null>();
  const starts = new Map<string, number | null>();
  const startFor = (date: string, time: string) => {
    const key = `${date}:${time}`;
    if (starts.has(key)) return starts.get(key)!;
    let start: number | null = null;
    try {
      const instant = localDateTimeUtc(date, time, options.schoolTimezone).getTime();
      if (Number.isFinite(instant)) start = instant;
    } catch {
      // Cache unavailable instants too; each application still fails its own time gate.
    }
    starts.set(key, start);
    return start;
  };
  const baselineFor = (date: string, id: string) => {
    const key = `${date}:${id}`;
    if (baselines.has(key)) return baselines.get(key)!;
    let baseline: BellWindow | null = null;
    try {
      const row = classes.get(id);
      if (row) {
        let day = days.get(date);
        if (!day) { day = resolveSchoolScheduleDay(date, baselineConfig, options.calendar); days.set(date, day); }
        baseline = resolveClassBaseWindow(row, date, baselineConfig, options.calendar, day);
      }
    } catch {
      // A missing bell/calendar dependency cannot prove that cancellation is still timely.
    }
    baselines.set(key, baseline);
    return baseline;
  };
  return (application: ScheduleProfileApplication): ApplicationTiming => {
    let earliestKnownStart: number | null = null, unavailable = false, hasChanges = false;
    const include = (date: string, startTime: string) => {
      const start = startFor(date, startTime);
      if (start === null) { unavailable = true; return; }
      earliestKnownStart = earliestKnownStart === null ? start : Math.min(earliestKnownStart, start);
    };
    for (const window of application.testingWindows) {
      hasChanges = true;
      include(window.date, window.startTime);
    }
    for (const [date, windows] of Object.entries(application.classWindows)) {
      for (const [id, proposed] of Object.entries(windows)) {
        hasChanges = true;
        if (proposed) include(date, proposed.startTime);
        const baseline = baselineFor(date, id);
        if (baseline) include(date, baseline.startTime);
        else unavailable = true;
      }
    }
    return { earliestKnownStart, unavailable, hasChanges };
  };
}

/** The read hint and the locked mutation share this time gate. The mutation also validates restoration. */
export function applicationCancellation(application: ScheduleProfileApplication, timing: ApplicationTiming, now: Date): ApplicationCancellation {
  const cutoffAt = !timing.unavailable && timing.earliestKnownStart !== null ? new Date(timing.earliestKnownStart).toISOString() : null;
  const reason = application.status === "cancelled" ? "cancelled"
    : timing.earliestKnownStart !== null && timing.earliestKnownStart <= now.getTime() ? "started"
    : timing.unavailable ? "unavailable"
    : !timing.hasChanges ? "no_changes" : null;
  return { canRequest: reason === null, cutoffAt, reason };
}

const outcomeKey = (applicationId: string, date: string, blockId: string) => `${applicationId}:${date}:${blockId}`;
export function summarizeScheduleApplications(options: {
  applications: ScheduleProfileApplication[];
  testingStatuses: ProfileSupervisionStatus[];
  timing: (application: ScheduleProfileApplication) => ApplicationTiming;
  schoolTimezone: string;
  now: Date;
  historySupervision?: ApplicationHistorySupervision[];
  unresolvedApplicationIds?: string[];
}) {
  const today = localDateInTimeZone(options.now, options.schoolTimezone);
  const statuses = new Map<string, ProfileSupervisionStatus | null>();
  for (const status of options.testingStatuses) {
    const key = outcomeKey(status.applicationId, status.date, status.blockId);
    statuses.set(key, statuses.has(key) ? null : status);
  }
  const applicationSummaries: Record<string, ApplicationSummary> = {};
  for (const application of options.applications) {
    const testsByDate = new Map<string, typeof application.testingWindows>();
    for (const window of application.testingWindows) {
      const windows = testsByDate.get(window.date) ?? [];
      windows.push(window); testsByDate.set(window.date, windows);
    }
    const dates = application.dates.map((date): ApplicationDateSummary => {
      const windows = Object.values(application.classWindows[date] ?? {});
      const tests = testsByDate.get(date) ?? [];
      const testingOutcomes: ApplicationDateSummary["testingOutcomes"] = { pending: 0, active: 0, ended: 0, failed: 0, missed: 0, cancelled: 0, releasing: 0, unknown: 0 };
      const testingStatusByBlock: ApplicationDateSummary["testingStatusByBlock"] = {};
      for (const window of tests) {
        const status = statuses.get(outcomeKey(application.id, date, window.blockId));
        // An overdue unprocessed block is not evidence of a successful start or a recorded failure.
        const overduePending = status?.status === "pending" && localDateTimeUtc(date, window.endTime, options.schoolTimezone) <= options.now;
        const outcome = !status || overduePending || !Object.hasOwn(testingOutcomes, status.status) ? "unknown" : status.status;
        testingOutcomes[outcome]++;
        testingStatusByBlock[window.blockId] = outcome;
      }
      return { date, phase: application.status === "cancelled" ? "cancelled" : !windows.length && !tests.length ? "no_changes" : date < today ? "past" : date === today ? "today" : "future",
        customTimeCount: windows.filter((window) => window !== null).length,
        skippedClassCount: windows.filter((window) => window === null).length,
        testingBlockCount: tests.length, testingOutcomes, testingStatusByBlock };
    });
    applicationSummaries[application.id] = { dates,
      nextFutureDate: dates.filter((date) => date.phase === "future").map((date) => date.date).sort()[0] ?? null,
      appliedToday: dates.some((date) => date.phase === "today"),
      cancellation: applicationCancellation(application, options.timing(application), options.now),
      historyRemoval: applicationHistoryRemoval({ ...options, application, supervision: options.historySupervision }) };
  }
  return { applicationSummaries, summariesCheckedAt: options.now.toISOString(),
    nextSchoolDateAt: localDateTimeUtc(datePlusDays(today, 1), "00:00", options.schoolTimezone).toISOString() };
}
