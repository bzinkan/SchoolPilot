import { sql, type SQL } from "drizzle-orm";
import db from "../db.js";
import { formulaSafeCsvCell } from "../util/classpilotEventCursor.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import { addLocalDays, localDateInTimeZone, localDateStartUtc } from "../util/schoolTime.js";
import { resolveHistoryDates } from "./classpilotBrowsingHistoryModel.js";

/*
 * Digital Usage read model over classpilot_usage_rollups: Monitored Browser
 * Time, the browser activity ClassPilot observed on managed Chromebooks. It is
 * never described as full-device time. Every query filters school_id itself
 * and also runs under the request's tenant context (forced RLS).
 *
 * Presented days are the requested local dates, clipped to today, to the
 * school's retention window (a day whose start is older than the retention
 * cutoff is withheld, as for browsing domains) and to the first day the rollup
 * has produced for the school (earlier days were never computed, which is not
 * the same as zero). No response contains a device identifier.
 */

export const CLASSPILOT_DIGITAL_USAGE_SCOPES = ["school", "grade", "class", "student"] as const;
export type ClasspilotDigitalUsageScope = (typeof CLASSPILOT_DIGITAL_USAGE_SCOPES)[number];
export const CLASSPILOT_DIGITAL_USAGE_FORMATS = ["json", "csv"] as const;
export type ClasspilotDigitalUsageFormat = (typeof CLASSPILOT_DIGITAL_USAGE_FORMATS)[number];
export const CLASSPILOT_DIGITAL_USAGE_TOP_DOMAINS = 10;
export const MONITORED_BROWSER_TIME = "Monitored Browser Time";
const MONITORED_BROWSER_TIME_NOTE =
  "Monitored Browser Time counts only browser activity ClassPilot observed on managed Chromebooks.";

export class ClasspilotDigitalUsageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ClasspilotDigitalUsageError";
    this.code = code;
    this.status = status;
  }
}

export type ClasspilotDigitalUsageQuery = {
  scope: ClasspilotDigitalUsageScope;
  id: string | null;
  from?: string;
  to?: string;
  format: ClasspilotDigitalUsageFormat;
};

function singleQueryValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ClasspilotDigitalUsageError("CLASSPILOT_USAGE_INVALID_REQUEST", `Provide ${name} once.`, 400);
  }
  return value.trim();
}

/** Strict query parsing; unknown scope/format values and malformed ids are rejected. */
export function parseClasspilotDigitalUsageQuery(query: Record<string, unknown>): ClasspilotDigitalUsageQuery {
  const scopeValue = singleQueryValue(query.scope, "scope") || "school";
  if (!(CLASSPILOT_DIGITAL_USAGE_SCOPES as readonly string[]).includes(scopeValue)) {
    throw new ClasspilotDigitalUsageError(
      "CLASSPILOT_USAGE_INVALID_REQUEST",
      "Choose a scope of school, grade, class or student.",
      400
    );
  }
  const scope = scopeValue as ClasspilotDigitalUsageScope;
  const formatValue = singleQueryValue(query.format, "format") || "json";
  if (!(CLASSPILOT_DIGITAL_USAGE_FORMATS as readonly string[]).includes(formatValue)) {
    throw new ClasspilotDigitalUsageError("CLASSPILOT_USAGE_INVALID_REQUEST", "Choose a format of json or csv.", 400);
  }
  const id = singleQueryValue(query.id, "id") || null;
  if (scope === "school" && id !== null) {
    throw new ClasspilotDigitalUsageError("CLASSPILOT_USAGE_INVALID_REQUEST", "The school scope takes no id.", 400);
  }
  if (scope !== "school" && (id === null || id.length > 128 || !/^[\w .:-]+$/.test(id))) {
    throw new ClasspilotDigitalUsageError("CLASSPILOT_USAGE_INVALID_REQUEST", `Choose a ${scope}.`, 400);
  }
  return {
    scope,
    id,
    from: singleQueryValue(query.from, "from"),
    to: singleQueryValue(query.to, "to"),
    format: formatValue as ClasspilotDigitalUsageFormat,
  };
}

export type ClasspilotDigitalUsageTotals = {
  monitoredBrowserSeconds: number;
  instructionalSeconds: number;
  offTaskSeconds: number;
  unknownSeconds: number;
  activeMonitoredStudents: number;
  heartbeatCount: number;
};

export type ClasspilotDigitalUsageDay = ClasspilotDigitalUsageTotals & {
  date: string;
  /** final once the rollup ran after the day ended; live while it may still change. */
  state: "final" | "live";
};

export type ClasspilotDigitalUsageReport = {
  schemaVersion: 1;
  measure: typeof MONITORED_BROWSER_TIME;
  note: string;
  scope: { kind: ClasspilotDigitalUsageScope; id: string | null; label: string };
  range: {
    from: string;
    to: string;
    today: string;
    timeZone: string;
    retentionDays: number;
    /** First local date whose whole day is inside the retention window. */
    retainedFrom: string;
    partiallyExpired: boolean;
    /** First local date the rollup has produced for this school, if any. */
    computedFrom: string | null;
    partiallyComputed: boolean;
    /** The dates actually presented in totals and byDay (null when none). */
    presentedFrom: string | null;
    presentedTo: string | null;
  };
  /** unavailable: nothing computed to present (never zero usage). */
  dataState: "unavailable" | "live" | "final";
  generatedAt: string;
  computedAt: string | null;
  totals: ClasspilotDigitalUsageTotals;
  byDay: ClasspilotDigitalUsageDay[];
  topEducationalDomains: Array<{ domain: string; seconds: number }>;
  topNonEducationalDomains: Array<{ domain: string; seconds: number }>;
};

type Executor = Pick<typeof db, "execute">;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

function count(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

function asDate(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function emptyTotals(): ClasspilotDigitalUsageTotals {
  return {
    monitoredBrowserSeconds: 0,
    instructionalSeconds: 0,
    offTaskSeconds: 0,
    unknownSeconds: 0,
    activeMonitoredStudents: 0,
    heartbeatCount: 0,
  };
}

function totalsOf(row: Record<string, unknown>): ClasspilotDigitalUsageTotals {
  return {
    monitoredBrowserSeconds: count(row.monitored),
    instructionalSeconds: count(row.instructional),
    offTaskSeconds: count(row.off_task),
    unknownSeconds: count(row.unknown),
    activeMonitoredStudents: count(row.students),
    heartbeatCount: count(row.heartbeats),
  };
}

function resolveDates(options: { from?: string; to?: string; timeZone: string; now: Date }) {
  try {
    return resolveHistoryDates({ startDate: options.from, endDate: options.to, timeZone: options.timeZone, now: options.now });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new ClasspilotDigitalUsageError(
      code === "HISTORY_RANGE_INVALID" ? "CLASSPILOT_USAGE_RANGE_INVALID" : "CLASSPILOT_USAGE_DATE_INVALID",
      code === "HISTORY_RANGE_INVALID"
        ? "Choose an ordered date range of at most 366 days."
        : "Use valid school-local dates in YYYY-MM-DD format.",
      400
    );
  }
}

function scopeNotFound(): never {
  throw new ClasspilotDigitalUsageError("CLASSPILOT_USAGE_SCOPE_NOT_FOUND", "Digital Usage scope not found", 404);
}

async function resolveScope(
  executor: Executor,
  schoolId: string,
  scope: ClasspilotDigitalUsageScope,
  id: string | null
): Promise<{ label: string; filter: SQL }> {
  if (scope === "school") {
    const [school] = rowsOf(await executor.execute(sql`SELECT name FROM schools WHERE id = ${schoolId} LIMIT 1`));
    return { label: typeof school?.name === "string" && school.name ? school.name : "Entire school", filter: sql`` };
  }
  const scopeId = id!;
  if (scope === "student") {
    const [student] = rowsOf(await executor.execute(sql`
      SELECT first_name, last_name FROM students WHERE school_id = ${schoolId} AND id = ${scopeId} LIMIT 1
    `));
    if (!student) scopeNotFound();
    const label = [student.first_name, student.last_name].filter((part) => typeof part === "string" && part).join(" ");
    return { label: label || "Student", filter: sql`AND rollup.student_id = ${scopeId}` };
  }
  if (scope === "class") {
    const [group] = rowsOf(await executor.execute(sql`
      SELECT name FROM groups WHERE school_id = ${schoolId} AND id = ${scopeId} LIMIT 1
    `));
    if (!group) scopeNotFound();
    return {
      label: typeof group.name === "string" && group.name ? group.name : "Class",
      filter: sql`AND rollup.class_id = ${scopeId}`,
    };
  }
  // Grade is the student's current grade level (students.grade_level).
  const [known] = rowsOf(await executor.execute(sql`
    SELECT (
      EXISTS (SELECT 1 FROM students WHERE school_id = ${schoolId} AND grade_level = ${scopeId})
      OR ${scopeId} = ANY(COALESCE((SELECT grade_levels FROM settings WHERE school_id = ${schoolId}), '{}'::text[]))
    ) AS known
  `));
  if (known?.known !== true) scopeNotFound();
  return {
    label: `Grade ${scopeId}`,
    filter: sql`AND rollup.student_id IN (
      SELECT student.id FROM students AS student
      WHERE student.school_id = ${schoolId} AND student.grade_level = ${scopeId}
    )`,
  };
}

async function topDomains(
  executor: Executor,
  options: { schoolId: string; from: string; to: string; filter: SQL; classification: "educational" | "non-educational" }
): Promise<Array<{ domain: string; seconds: number }>> {
  const rows = rowsOf(await executor.execute(sql`
    SELECT rollup.domain, SUM(rollup.seconds)::bigint AS seconds
    FROM classpilot_usage_rollups AS rollup
    WHERE rollup.school_id = ${options.schoolId}
      AND rollup.usage_date >= ${options.from}::date
      AND rollup.usage_date <= ${options.to}::date
      AND rollup.classification = ${options.classification}
      AND rollup.domain <> ''
      ${options.filter}
    GROUP BY rollup.domain
    HAVING SUM(rollup.seconds) > 0
    ORDER BY SUM(rollup.seconds) DESC, rollup.domain ASC
    LIMIT ${CLASSPILOT_DIGITAL_USAGE_TOP_DOMAINS}
  `));
  return rows.map((row) => ({ domain: String(row.domain), seconds: count(row.seconds) }));
}

async function readReport(
  executor: Executor,
  options: { schoolId: string; scope: ClasspilotDigitalUsageScope; id: string | null; from?: string; to?: string; now: Date }
): Promise<ClasspilotDigitalUsageReport> {
  const [context] = rowsOf(await executor.execute(sql`
    SELECT school.school_timezone AS time_zone, school_settings.retention_hours
    FROM schools AS school
    LEFT JOIN settings AS school_settings ON school_settings.school_id = school.id
    WHERE school.id = ${options.schoolId}
    LIMIT 1
  `));
  const timeZone = typeof context?.time_zone === "string" && context.time_zone ? context.time_zone : "America/New_York";
  const dates = resolveDates({ from: options.from, to: options.to, timeZone, now: options.now });
  const scope = await resolveScope(executor, options.schoolId, options.scope, options.id);
  const retentionDays = parseClasspilotRetentionDays(context?.retention_hours);
  const cutoff = new Date(options.now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffDate = localDateInTimeZone(cutoff, timeZone);
  const retainedFrom = localDateStartUtc(cutoffDate, timeZone) >= cutoff ? cutoffDate : addLocalDays(cutoffDate, 1);
  const [coverage] = rowsOf(await executor.execute(sql`
    SELECT MIN(rollup.usage_date)::text AS computed_from
    FROM classpilot_usage_rollups AS rollup
    WHERE rollup.school_id = ${options.schoolId}
  `));
  const computedFrom = typeof coverage?.computed_from === "string" ? coverage.computed_from : null;
  const today = dates.today;
  const presentedTo = dates.endDate < today ? dates.endDate : today;
  const presentedFrom = [dates.startDate, retainedFrom, computedFrom ?? presentedTo]
    .reduce((latest, date) => (date > latest ? date : latest));
  const hasPresented = computedFrom !== null && presentedFrom <= presentedTo;

  const report: ClasspilotDigitalUsageReport = {
    schemaVersion: 1,
    measure: MONITORED_BROWSER_TIME,
    note: MONITORED_BROWSER_TIME_NOTE,
    scope: { kind: options.scope, id: options.id, label: scope.label },
    range: {
      from: dates.startDate,
      to: dates.endDate,
      today,
      timeZone,
      retentionDays,
      retainedFrom,
      partiallyExpired: dates.startDate < retainedFrom,
      computedFrom,
      partiallyComputed: computedFrom === null || dates.startDate < computedFrom,
      presentedFrom: hasPresented ? presentedFrom : null,
      presentedTo: hasPresented ? presentedTo : null,
    },
    dataState: "unavailable",
    generatedAt: options.now.toISOString(),
    computedAt: null,
    totals: emptyTotals(),
    byDay: [],
    topEducationalDomains: [],
    topNonEducationalDomains: [],
  };
  if (!hasPresented) return report;

  const aggregate = rowsOf(await executor.execute(sql`
    SELECT rollup.usage_date::text AS usage_date,
      GROUPING(rollup.usage_date) AS total_row,
      COALESCE(SUM(rollup.seconds), 0)::bigint AS monitored,
      COALESCE(SUM(rollup.seconds) FILTER (WHERE rollup.classification = 'educational'), 0)::bigint AS instructional,
      COALESCE(SUM(rollup.seconds) FILTER (WHERE rollup.classification = 'non-educational'), 0)::bigint AS off_task,
      COALESCE(SUM(rollup.seconds) FILTER (WHERE rollup.classification = 'unknown'), 0)::bigint AS unknown,
      COUNT(DISTINCT rollup.student_id)::int AS students,
      COALESCE(SUM(rollup.heartbeat_count), 0)::bigint AS heartbeats,
      MAX(rollup.computed_at) AS computed_at
    FROM classpilot_usage_rollups AS rollup
    WHERE rollup.school_id = ${options.schoolId}
      AND rollup.usage_date >= ${presentedFrom}::date
      AND rollup.usage_date <= ${presentedTo}::date
      ${scope.filter}
    GROUP BY GROUPING SETS ((rollup.usage_date), ())
  `));
  const byDate = new Map<string, Record<string, unknown>>();
  let totalRow: Record<string, unknown> | undefined;
  for (const row of aggregate) {
    if (Number(row.total_row) === 1) totalRow = row;
    else if (typeof row.usage_date === "string") byDate.set(row.usage_date, row);
  }
  let computedAt: Date | null = null;
  for (let date = presentedFrom; date <= presentedTo; date = addLocalDays(date, 1)) {
    const row = byDate.get(date);
    const dayComputedAt = asDate(row?.computed_at);
    if (dayComputedAt && (!computedAt || dayComputedAt > computedAt)) computedAt = dayComputedAt;
    const dayEnd = localDateStartUtc(addLocalDays(date, 1), timeZone);
    const state: ClasspilotDigitalUsageDay["state"] = row
      ? (dayComputedAt && dayComputedAt >= dayEnd ? "final" : "live")
      : (date < today ? "final" : "live");
    report.byDay.push({ date, state, ...(row ? totalsOf(row) : emptyTotals()) });
  }
  report.totals = totalRow ? totalsOf(totalRow) : emptyTotals();
  report.computedAt = computedAt ? computedAt.toISOString() : null;
  report.dataState = report.byDay.some((day) => day.state === "live") ? "live" : "final";
  const window = { schoolId: options.schoolId, from: presentedFrom, to: presentedTo, filter: scope.filter };
  report.topEducationalDomains = await topDomains(executor, { ...window, classification: "educational" });
  report.topNonEducationalDomains = await topDomains(executor, { ...window, classification: "non-educational" });
  return report;
}

/**
 * The Digital Usage report for one scope, read in one repeatable-read,
 * read-only transaction so totals, days and top sites agree. Pass the
 * caller's transaction to read inside it instead.
 */
export async function getClasspilotDigitalUsage(options: {
  schoolId: string;
  scope: ClasspilotDigitalUsageScope;
  id: string | null;
  from?: string;
  to?: string;
  now?: Date;
  transaction?: Executor;
}): Promise<ClasspilotDigitalUsageReport> {
  const input = { ...options, now: options.now ?? new Date() };
  if (options.transaction) return readReport(options.transaction, input);
  return db.transaction(
    async (tx) => readReport(tx as unknown as Executor, input),
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

/**
 * One student's Monitored Browser Time for the Student Data export: the same
 * rollup read at student scope, without the scope label (Student Data already
 * names the student) or the per-day student count.
 */
export type ClasspilotStudentMonitoredBrowserTime = {
  measure: typeof MONITORED_BROWSER_TIME;
  source: "classpilot_usage_rollups";
  note: string;
  dataState: ClasspilotDigitalUsageReport["dataState"];
  computedAt: string | null;
  range: ClasspilotDigitalUsageReport["range"];
  totals: Omit<ClasspilotDigitalUsageTotals, "activeMonitoredStudents">;
  byDay: Array<Omit<ClasspilotDigitalUsageDay, "activeMonitoredStudents">>;
  topEducationalDomains: ClasspilotDigitalUsageReport["topEducationalDomains"];
  topNonEducationalDomains: ClasspilotDigitalUsageReport["topNonEducationalDomains"];
};

export async function getClasspilotStudentMonitoredBrowserTime(options: {
  schoolId: string;
  studentId: string;
  from: string;
  to: string;
  now: Date;
  transaction: Executor;
}): Promise<ClasspilotStudentMonitoredBrowserTime> {
  const report = await getClasspilotDigitalUsage({
    schoolId: options.schoolId,
    scope: "student",
    id: options.studentId,
    from: options.from,
    to: options.to,
    now: options.now,
    transaction: options.transaction,
  });
  const { activeMonitoredStudents: _totalStudents, ...totals } = report.totals;
  return {
    measure: report.measure,
    source: "classpilot_usage_rollups",
    note: report.note,
    dataState: report.dataState,
    computedAt: report.computedAt,
    range: report.range,
    totals,
    byDay: report.byDay.map(({ activeMonitoredStudents: _dayStudents, ...day }) => day),
    topEducationalDomains: report.topEducationalDomains,
    topNonEducationalDomains: report.topNonEducationalDomains,
  };
}

function minutes(seconds: number): string {
  return (seconds / 60).toFixed(1);
}

/** Formula-safe CSV with a UTF-8 BOM and CRLF rows (the monitoring export pattern). */
export function classpilotDigitalUsageCsv(report: ClasspilotDigitalUsageReport): string {
  const rows: unknown[][] = [
    ["Report", MONITORED_BROWSER_TIME],
    ["Scope", report.scope.kind],
    ["Label", report.scope.label],
    ["From", report.range.from],
    ["To", report.range.to],
    ["Time zone", report.range.timeZone],
    ["Retained from", report.range.retainedFrom],
    ["Partially expired", report.range.partiallyExpired ? "yes" : "no"],
    ["Computed from", report.range.computedFrom ?? ""],
    ["Data state", report.dataState],
    ["Generated at", report.generatedAt],
    ["Note", report.note],
    [],
    [
      "Date",
      "Day state",
      `${MONITORED_BROWSER_TIME} (minutes)`,
      "Instructional (minutes)",
      "Off-task (minutes)",
      "Unclassified (minutes)",
      "Active monitored students",
      "Heartbeats",
    ],
    ...report.byDay.map((day) => [
      day.date,
      day.state,
      minutes(day.monitoredBrowserSeconds),
      minutes(day.instructionalSeconds),
      minutes(day.offTaskSeconds),
      minutes(day.unknownSeconds),
      day.activeMonitoredStudents,
      day.heartbeatCount,
    ]),
    [
      "Total",
      "",
      minutes(report.totals.monitoredBrowserSeconds),
      minutes(report.totals.instructionalSeconds),
      minutes(report.totals.offTaskSeconds),
      minutes(report.totals.unknownSeconds),
      report.totals.activeMonitoredStudents,
      report.totals.heartbeatCount,
    ],
    [],
    ["Top educational sites", "Minutes"],
    ...report.topEducationalDomains.map((row) => [row.domain, minutes(row.seconds)]),
    [],
    ["Top non-educational sites", "Minutes"],
    ...report.topNonEducationalDomains.map((row) => [row.domain, minutes(row.seconds)]),
  ];
  return `\uFEFF${rows.map((row) => row.map(formulaSafeCsvCell).join(",")).join("\r\n")}\r\n`;
}

export function classpilotDigitalUsageCsvFileName(report: ClasspilotDigitalUsageReport): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9-]/g, "_").slice(0, 64);
  return `classpilot-monitored-browser-time-${safe(report.scope.kind)}-${safe(report.range.from)}-${safe(report.range.to)}.csv`;
}
