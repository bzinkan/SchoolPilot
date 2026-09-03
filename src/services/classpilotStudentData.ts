import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import db from "../db.js";
import { schools } from "../schema/core.js";
import {
  classpilotMonitoringEvents,
  classpilotSessionReports,
  classpilotSessionStaff,
  classpilotSessionStudents,
  classpilotSessionUsage,
  classpilotSupervisionContexts,
  classpilotSupervisionStudents,
  groups,
  groupStudents,
  groupTeachers,
  studentSessions,
  teachingSessions,
  type ClasspilotSessionReport,
  type TeachingSession,
} from "../schema/classpilot.js";
import { settings } from "../schema/shared.js";
import { students } from "../schema/students.js";
import { materializeStudents } from "./classpilotMonitoringReports.js";
import { classpilotSessionReportVersionForNewRow } from "../config/classpilotSessionReportRollout.js";
import {
  CLASSPILOT_STUDENT_DATA_CACHE_BUCKET_MS,
  classpilotStudentDataProvisionalCache,
  type ClasspilotStudentDataCachedRow,
  type ClasspilotStudentDataCacheBinding,
} from "./classpilotStudentDataProvisionalCache.js";
import {
  getHeartbeatsForStudentsInRange,
  type ClasspilotSessionReportInput,
} from "./storage.js";
import {
  addLocalDays,
  localDateInTimeZone,
  localDateStartUtc,
} from "../util/schoolTime.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import {
  CLASSPILOT_ACTIVITY_KINDS,
  type ClasspilotActivityKind,
} from "./classpilotActivityAttribution.js";

export type ClasspilotStudentDataPeriod = "today" | "week" | "month" | "year";
export type ClasspilotStudentDataRole = "admin" | "school_admin" | "teacher";
export type ClasspilotStudentDataScopeKind = "school" | "mine" | "class";

export type ClasspilotStudentDataScope = {
  key: string;
  kind: ClasspilotStudentDataScopeKind;
  label: string;
  groupId: string | null;
};

export type ClasspilotStudentDataScopeOption = ClasspilotStudentDataScope & {
  activeTeachingSessionId: string | null;
  isActive: boolean;
};

export type ClasspilotStudentDataState = "final" | "live" | "finalizing";

/**
 * Why the numbers look the way they do.
 *
 * `monitored`   - a live session covered the window.
 * `unattended`  - a scheduled block ran and was reported, but no teacher was
 *                 connected. Heartbeats are still collected and attributed;
 *                 only the live console was absent.
 * `no_session`  - no session covered the window at all, so nothing was expected.
 */
export type ClasspilotStudentDataMonitoringCoverage =
  | "monitored"
  | "unattended"
  | "no_session";

export type ClasspilotStudentDataActivityKind = ClasspilotActivityKind;

export type ClasspilotStudentDataActivity = {
  kind: ClasspilotStudentDataActivityKind;
  domain: string;
  seconds: number;
};

const STUDENT_DATA_ACTIVITY_KINDS = new Set<ClasspilotStudentDataActivityKind>(
  CLASSPILOT_ACTIVITY_KINDS
);

const CLASSPILOT_SESSION_MAX_MS = 12 * 60 * 60 * 1_000;

/**
 * Session modes whose usage is reportable in Student Data.
 *
 * A scheduled occurrence is promoted to 'live' only when a teacher is connected
 * at the bell; with nobody connected it stays 'scheduled_report'. It is still
 * finalized, still gets a classpilot_session_reports row, and still gets
 * classpilot_session_usage rows -- every write path is mode-blind. Filtering
 * reads on 'live' therefore wrote real monitoring data and then made it
 * unreachable, which is what produced an empty Student Data screen for a class
 * whose students were demonstrably on their devices.
 *
 * Reporting surfaces key on lifecycle, not on whether a teacher happened to
 * have the console open. This matches getActiveTeachingSessions in storage.ts
 * and classpilotAdminAnalytics, which already count unattended occurrences.
 *
 * Control surfaces -- tile/screenshot authorization, WebSocket subscribe,
 * command dispatch, teacher chat, FAB actions, roster resync -- deliberately
 * stay 'live'-only and must NOT use this.
 */
const LIVE_SESSION_MODE = "live";
const SCHEDULED_REPORT_SESSION_MODE = "scheduled_report";

/**
 * Which session modes a given role may read.
 *
 * Admins read school-wide, so an unattended block is simply part of the
 * school's record and is included.
 *
 * A teacher is deliberately narrower. Their authority over a past class comes
 * from the frozen classpilot_session_staff row on a session they actually ran,
 * and it survives being reassigned off the group. An unattended occurrence ran
 * without anyone, so counting it would let a former teacher read a block they
 * were never present for -- the case pinned by
 * tests/multi-school-readiness-routes.test.ts ("scheduled_report rows never
 * grant authority"). Teachers still receive the unattended block's numbers in
 * their session summary email, which is scoped by delivery rather than by
 * retained read access.
 */
function reportableSessionModes(role: ClasspilotStudentDataRole): string[] {
  return role === "teacher"
    ? [LIVE_SESSION_MODE]
    : [LIVE_SESSION_MODE, SCHEDULED_REPORT_SESSION_MODE];
}

/** Reportable-mode predicate for Drizzle queries over `teachingSessions`. */
function reportableSessionMode(role: ClasspilotStudentDataRole): SQL {
  return inArray(teachingSessions.sessionMode, reportableSessionModes(role));
}

/** Reportable-mode predicate for raw SQL that aliases the table as `session`. */
function reportableSessionModeSql(role: ClasspilotStudentDataRole): SQL {
  const modes = reportableSessionModes(role);
  return sql`session.session_mode IN (${sql.join(
    modes.map((mode) => sql`${mode}`),
    sql`, `
  )})`;
}

type StudentIdentity = {
  studentId: string;
  name: string;
};

type StoredUsageRow = {
  studentId: string;
  totalSeconds: number;
  heartbeatCount: number;
  topDomains: unknown;
  topActivities?: unknown;
  computedAt: Date;
};

type KeyedStoredUsageRow = StoredUsageRow & {
  teachingSessionId: string;
  localDate: string;
};

type StudentAccumulator = StudentIdentity & {
  monitoredSeconds: number;
  heartbeatCount: number;
  domains: Map<string, number>;
  activities: Map<string, ClasspilotStudentDataActivity>;
};

export class ClasspilotStudentDataNotFoundError extends Error {
  readonly code:
    | "CLASSPILOT_SESSION_NOT_FOUND"
    | "CLASSPILOT_STUDENT_NOT_FOUND"
    | "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND";

  constructor(code: ClasspilotStudentDataNotFoundError["code"], message: string) {
    super(message);
    this.name = "ClasspilotStudentDataNotFoundError";
    this.code = code;
  }
}

export class ClasspilotStudentDataUnavailableError extends Error {
  readonly code = "CLASSPILOT_STUDENT_DATA_UNAVAILABLE";

  constructor() {
    super("Student Data is temporarily unavailable while the class report is retried");
    this.name = "ClasspilotStudentDataUnavailableError";
  }
}

export function parseClasspilotStudentDataScope(
  value: unknown
): ClasspilotStudentDataScopeKind | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "school" || value === "mine" || value === "class") return value;
  throw Object.assign(new Error("scope must be school, mine, or class"), {
    code: "INVALID_STUDENT_DATA_SCOPE",
  });
}

export function parseClasspilotStudentDataPeriod(value: unknown): ClasspilotStudentDataPeriod {
  if (value === undefined || value === "") return "today";
  if (value === "today" || value === "week" || value === "month" || value === "year") {
    return value;
  }
  throw Object.assign(new Error("period must be today, week, month, or year"), {
    code: "INVALID_STUDENT_DATA_PERIOD",
  });
}

function firstLocalDateForPeriod(
  period: ClasspilotStudentDataPeriod,
  todayLocalDate: string
): string {
  if (period === "today") return todayLocalDate;
  if (period === "month") return `${todayLocalDate.slice(0, 7)}-01`;
  if (period === "year") return `${todayLocalDate.slice(0, 4)}-01-01`;
  const day = new Date(`${todayLocalDate}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return addLocalDays(todayLocalDate, -daysSinceMonday);
}

export function resolveClasspilotStudentDataWindow(options: {
  period: ClasspilotStudentDataPeriod;
  timeZone: string;
  now: Date;
  session?: {
    startTime: Date;
    endTime: Date | null;
    scheduledEndAt?: Date | null;
    timezoneSnapshot: string | null;
  };
}) {
  const timeZone = options.session?.timezoneSnapshot || options.timeZone || "America/New_York";
  if (options.session) {
    const sessionAuthorityEnd = new Date(Math.min(
      options.now.getTime(),
      options.session.endTime?.getTime() ?? Number.POSITIVE_INFINITY,
      options.session.scheduledEndAt?.getTime() ?? Number.POSITIVE_INFINITY,
      options.session.startTime.getTime() + CLASSPILOT_SESSION_MAX_MS
    ));
    const end = sessionAuthorityEnd < options.session.startTime
      ? options.session.startTime
      : sessionAuthorityEnd;
    return {
      period: options.period,
      timeZone,
      startLocalDate: localDateInTimeZone(options.session.startTime, timeZone),
      endLocalDate: localDateInTimeZone(end, timeZone),
      rangeStart: options.session.startTime,
      rangeEnd: end,
    };
  }
  const endLocalDate = localDateInTimeZone(options.now, timeZone);
  const startLocalDate = firstLocalDateForPeriod(options.period, endLocalDate);
  return {
    period: options.period,
    timeZone,
    startLocalDate,
    endLocalDate,
    rangeStart: localDateStartUtc(startLocalDate, timeZone),
    rangeEnd: options.now,
  };
}

function nonnegativeInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function storedDomains(value: unknown, monitoredSeconds: number): Array<{ domain: string; seconds: number }> {
  if (!Array.isArray(value)) return [];
  let remaining = monitoredSeconds;
  const domains: Array<{ domain: string; seconds: number }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || remaining <= 0) continue;
    const item = raw as Record<string, unknown>;
    const domain = normalizeDomain(item.domain ?? item.name ?? item.hostname);
    if (!domain) continue;
    const seconds = Math.min(
      remaining,
      nonnegativeInteger(item.seconds ?? item.boundedSeconds ?? item.durationSeconds)
    );
    if (seconds <= 0) continue;
    domains.push({ domain, seconds });
    remaining -= seconds;
  }
  return domains;
}

/**
 * Best-effort kind for legacy rows that stored hostnames only. Keep in step
 * with the equivalent SQL CASE below, with legacyActivityKind in
 * schoolpilot-app/src/products/classpilot/lib/studentData.js, and with
 * classifyClasspilotActivity.
 *
 * google.com deliberately stays `domain` here. The live classifier reads the
 * path to tell Search from Maps; a legacy row has no path, so labelling it
 * "Google Search" would be a guess. Rendering the bare hostname is honest and
 * matches what these rows show today.
 */
function fallbackActivityKind(domain: string): ClasspilotStudentDataActivityKind {
  if (domain === "docs.google.com") return "google_workspace_unspecified";
  if (domain === "slides.google.com") return "google_slides";
  if (domain === "forms.google.com") return "google_forms";
  if (domain === "sheets.google.com" || domain === "spreadsheets.google.com") {
    return "google_sheets";
  }
  if (domain === "classroom.google.com") return "google_classroom";
  if (domain === "drive.google.com") return "google_drive";
  if (domain === "mail.google.com") return "google_mail";
  if (domain === "meet.google.com") return "google_meet";
  return "domain";
}

function activityKind(value: unknown): ClasspilotStudentDataActivityKind | null {
  return typeof value === "string"
    && STUDENT_DATA_ACTIVITY_KINDS.has(value as ClasspilotStudentDataActivityKind)
    ? value as ClasspilotStudentDataActivityKind
    : null;
}

function storedActivities(
  value: unknown,
  monitoredSeconds: number,
  fallbackDomains: Array<{ domain: string; seconds: number }>
): ClasspilotStudentDataActivity[] {
  const source = Array.isArray(value)
    ? value
    : fallbackDomains.map((domain) => ({
        kind: fallbackActivityKind(domain.domain),
        domain: domain.domain,
        seconds: domain.seconds,
      }));
  let remaining = monitoredSeconds;
  const activities: ClasspilotStudentDataActivity[] = [];
  for (const raw of source) {
    if (!raw || typeof raw !== "object" || remaining <= 0) continue;
    const item = raw as Record<string, unknown>;
    const kind = activityKind(item.kind);
    const domain = normalizeDomain(item.domain ?? item.hostname);
    if (!kind || !domain) continue;
    const seconds = Math.min(
      remaining,
      nonnegativeInteger(item.seconds ?? item.boundedSeconds ?? item.durationSeconds)
    );
    if (seconds <= 0) continue;
    activities.push({ kind, domain, seconds });
    remaining -= seconds;
  }
  return activities;
}

function studentDataActivityKey(activity: Pick<ClasspilotStudentDataActivity, "kind" | "domain">) {
  return `${activity.kind}\u0000${activity.domain}`;
}

function sortedBoundedDomains(domains: Map<string, number>, maximumSeconds: number) {
  let remaining = maximumSeconds;
  return [...domains.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .flatMap(([domain, rawSeconds]) => {
      if (remaining <= 0) return [];
      const seconds = Math.min(remaining, nonnegativeInteger(rawSeconds));
      remaining -= seconds;
      return seconds > 0 ? [{ domain, seconds }] : [];
    });
}

function sortedBoundedActivities(
  activities: Map<string, ClasspilotStudentDataActivity>,
  maximumSeconds: number
): ClasspilotStudentDataActivity[] {
  let remaining = maximumSeconds;
  return [...activities.values()]
    .sort((left, right) => right.seconds - left.seconds
      || left.kind.localeCompare(right.kind)
      || left.domain.localeCompare(right.domain))
    .flatMap((activity) => {
      if (remaining <= 0) return [];
      const seconds = Math.min(remaining, nonnegativeInteger(activity.seconds));
      remaining -= seconds;
      return seconds > 0 ? [{ ...activity, seconds }] : [];
    });
}

export function buildClasspilotStudentDataResponse(options: {
  period: ClasspilotStudentDataPeriod;
  sessionId?: string;
  selectedStudentId?: string;
  scope?: ClasspilotStudentDataScope;
  dataState?: ClasspilotStudentDataState;
  monitoringCoverage?: ClasspilotStudentDataMonitoringCoverage;
  provisionalAsOf?: Date | null;
  timeZone: string;
  startLocalDate: string;
  endLocalDate: string;
  rangeStart: Date;
  rangeEnd: Date;
  generatedAt: Date;
  identities: StudentIdentity[];
  usageRows: StoredUsageRow[];
}) {
  const accumulators = new Map<string, StudentAccumulator>(
    options.identities.map((identity) => [identity.studentId, {
      ...identity,
      monitoredSeconds: 0,
      heartbeatCount: 0,
      domains: new Map<string, number>(),
      activities: new Map<string, ClasspilotStudentDataActivity>(),
    }])
  );

  for (const row of options.usageRows) {
    const accumulator = accumulators.get(row.studentId);
    if (!accumulator) continue;
    const totalSeconds = nonnegativeInteger(row.totalSeconds);
    accumulator.monitoredSeconds += totalSeconds;
    accumulator.heartbeatCount += nonnegativeInteger(row.heartbeatCount);
    const domains = storedDomains(row.topDomains, totalSeconds);
    for (const domain of domains) {
      accumulator.domains.set(
        domain.domain,
        (accumulator.domains.get(domain.domain) || 0) + domain.seconds
      );
    }
    for (const activity of storedActivities(row.topActivities, totalSeconds, domains)) {
      const key = studentDataActivityKey(activity);
      const current = accumulator.activities.get(key);
      accumulator.activities.set(key, {
        ...activity,
        seconds: (current?.seconds || 0) + activity.seconds,
      });
    }
  }

  const allDomainTotals = new Map<string, number>();
  const allActivityTotals = new Map<string, ClasspilotStudentDataActivity>();
  for (const accumulator of accumulators.values()) {
    for (const [domain, seconds] of accumulator.domains) {
      allDomainTotals.set(domain, (allDomainTotals.get(domain) || 0) + seconds);
    }
    for (const activity of accumulator.activities.values()) {
      const key = studentDataActivityKey(activity);
      const current = allActivityTotals.get(key);
      allActivityTotals.set(key, {
        ...activity,
        seconds: (current?.seconds || 0) + activity.seconds,
      });
    }
  }

  const summaries = [...accumulators.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.studentId.localeCompare(right.studentId))
    .map((student) => {
      const domains = sortedBoundedDomains(student.domains, student.monitoredSeconds);
      const activities = sortedBoundedActivities(student.activities, student.monitoredSeconds);
      return {
        studentId: student.studentId,
        name: student.name,
        monitoredSeconds: student.monitoredSeconds,
        heartbeatCount: student.heartbeatCount,
        reportedDomainCount: domains.length,
        siteCount: domains.length,
        topDomain: domains[0]?.domain ?? null,
        domains: domains.slice(0, 10),
        topDomains: domains.slice(0, 10),
        topActivity: activities[0] ?? null,
        activities: activities.slice(0, 10),
        topActivities: activities.slice(0, 10),
      };
    });
  const monitoredSeconds = summaries.reduce((sum, student) => sum + student.monitoredSeconds, 0);
  const topDomains = sortedBoundedDomains(allDomainTotals, monitoredSeconds).slice(0, 10);
  const topActivities = sortedBoundedActivities(allActivityTotals, monitoredSeconds).slice(0, 10);
  const selectedStudent = options.selectedStudentId
    ? summaries.find((student) => student.studentId === options.selectedStudentId) ?? null
    : null;
  const revisionInput = {
    schemaVersion: 2,
    period: options.period,
    sessionId: options.sessionId ?? null,
    selectedStudentId: options.selectedStudentId ?? null,
    scope: options.scope ?? null,
    dataState: options.dataState ?? "final",
    monitoringCoverage: options.monitoringCoverage ?? "no_session",
    timeZone: options.timeZone,
    startLocalDate: options.startLocalDate,
    endLocalDate: options.endLocalDate,
    monitoredSeconds,
    topDomains,
    topActivities,
    students: summaries,
  };
  const revision = `student-data-v2:${createHash("sha256")
    .update(JSON.stringify(revisionInput))
    .digest("base64url")
    .slice(0, 32)}`;

  return {
    schemaVersion: 2,
    revision,
    period: options.period,
    sessionId: options.sessionId ?? null,
    generatedAt: options.generatedAt.toISOString(),
    scope: options.scope ?? {
      key: "school",
      kind: "school" as const,
      label: "Entire school",
      groupId: null,
    },
    dataState: options.dataState ?? "final",
    monitoringCoverage: options.monitoringCoverage ?? "no_session",
    asOf: options.generatedAt.toISOString(),
    provisionalAsOf: options.provisionalAsOf?.toISOString() ?? null,
    range: {
      start: options.rangeStart.toISOString(),
      end: options.rangeEnd.toISOString(),
      startLocalDate: options.startLocalDate,
      endLocalDate: options.endLocalDate,
      timeZone: options.timeZone,
    },
    activitySource: "heartbeats" as const,
    screenshotsUsedForTimeCalculations: false,
    studentsTruncated: false,
    topDomainsLimit: 10,
    domainCoverage: "stored-session-top-domains" as const,
    topActivitiesLimit: 10,
    activityCoverage: "stored-session-top-activities" as const,
    studentCount: summaries.length,
    monitoredSeconds,
    topDomains,
    topActivities,
    students: summaries,
    student: selectedStudent,
  };
}

function scopeNotFound(): never {
  throw new ClasspilotStudentDataNotFoundError(
    "CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND",
    "Student Data scope not found"
  );
}

function invalidSelector(message: string): never {
  throw Object.assign(new Error(message), {
    code: "INVALID_STUDENT_DATA_SELECTOR",
  });
}

function scopeForGroup(groupId: string, label: string): ClasspilotStudentDataScope {
  return {
    key: `class:${groupId}`,
    kind: "class",
    label,
    groupId,
  };
}

function dateFromUnknown(value: unknown, fallback: Date): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function sessionAuthorityDeadline(
  session: Pick<TeachingSession, "startTime" | "endTime" | "scheduledEndAt">,
  reportWindowEnd?: Date | null
): Date {
  return new Date(Math.min(
    reportWindowEnd?.getTime() ?? Number.POSITIVE_INFINITY,
    session.endTime?.getTime() ?? Number.POSITIVE_INFINITY,
    session.scheduledEndAt?.getTime() ?? Number.POSITIVE_INFINITY,
    session.startTime.getTime() + CLASSPILOT_SESSION_MAX_MS
  ));
}

function effectiveSessionAuthorityEnd(
  session: Pick<TeachingSession, "startTime" | "endTime" | "scheduledEndAt">,
  now: Date,
  reportWindowEnd?: Date | null
): Date {
  const deadline = sessionAuthorityDeadline(session, reportWindowEnd);
  return deadline < now ? deadline : now;
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type StudentDataScopeSet = {
  defaultScopeKey: string;
  scopes: ClasspilotStudentDataScopeOption[];
};

type StudentDataAuthorityWindow = {
  now: Date;
  retentionCutoff: Date;
};

async function loadStudentDataAuthorityWindow(options: {
  schoolId: string;
  now: Date;
  dbInstance: typeof db;
}): Promise<StudentDataAuthorityWindow> {
  const [row] = await options.dbInstance
    .select({ retentionHours: settings.retentionHours })
    .from(settings)
    .where(eq(settings.schoolId, options.schoolId))
    .limit(1);
  const retentionDays = parseClasspilotRetentionDays(row?.retentionHours);
  return {
    now: options.now,
    retentionCutoff: new Date(
      options.now.getTime() - retentionDays * 24 * 60 * 60 * 1_000
    ),
  };
}

function retainedSessionAuthoritySql(authority: StudentDataAuthorityWindow): SQL {
  return sql`(
    session.start_time AT TIME ZONE 'UTC' <= ${authority.now.toISOString()}
    AND LEAST(
      COALESCE(report.window_end, 'infinity'::timestamptz),
      COALESCE(session.end_time AT TIME ZONE 'UTC', 'infinity'::timestamptz),
      COALESCE(session.scheduled_end_at, 'infinity'::timestamptz),
      (session.start_time AT TIME ZONE 'UTC') + interval '12 hours'
    ) >= ${authority.retentionCutoff.toISOString()}
    AND (
      report.id IS NULL
      OR (
        report.expires_at > ${authority.now.toISOString()}
        AND report.detail_expired_at IS NULL
        AND report.state <> 'expired'
      )
    )
  )`;
}

function retainedSessionAuthorityTableSql(authority: StudentDataAuthorityWindow): SQL {
  return sql`(
    ${teachingSessions.startTime} AT TIME ZONE 'UTC' <= ${authority.now.toISOString()}
    AND LEAST(
      COALESCE(${classpilotSessionReports.windowEnd}, 'infinity'::timestamptz),
      COALESCE(${teachingSessions.endTime} AT TIME ZONE 'UTC', 'infinity'::timestamptz),
      COALESCE(${teachingSessions.scheduledEndAt}, 'infinity'::timestamptz),
      (${teachingSessions.startTime} AT TIME ZONE 'UTC') + interval '12 hours'
    ) >= ${authority.retentionCutoff.toISOString()}
    AND (
      ${classpilotSessionReports.id} IS NULL
      OR (
        ${classpilotSessionReports.expiresAt} > ${authority.now.toISOString()}
        AND ${classpilotSessionReports.detailExpiredAt} IS NULL
        AND ${classpilotSessionReports.state} <> 'expired'
      )
    )
  )`;
}

async function loadActiveScopeSessions(options: {
  schoolId: string;
  actorId: string;
  role: ClasspilotStudentDataRole;
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}) {
  const fields = {
    id: teachingSessions.id,
    groupId: teachingSessions.groupId,
    teacherId: teachingSessions.teacherId,
    startTime: teachingSessions.startTime,
  };
  const conditions = and(
    eq(teachingSessions.schoolId, options.schoolId),
    reportableSessionMode(options.role),
    isNull(teachingSessions.endTime),
    sql`${teachingSessions.startTime} AT TIME ZONE 'UTC' <= ${options.authority.now.toISOString()}`,
    sql`(${teachingSessions.scheduledEndAt} IS NULL OR ${teachingSessions.scheduledEndAt} > ${options.authority.now.toISOString()})`,
    sql`(${teachingSessions.startTime} AT TIME ZONE 'UTC') + interval '12 hours' > ${options.authority.now.toISOString()}`,
    isNotNull(teachingSessions.rosterSnapshotCompletedAt),
    eq(groups.schoolId, options.schoolId),
    eq(groups.groupType, "admin_class")
  );
  if (options.role === "teacher") {
    return options.dbInstance
      .select(fields)
      .from(teachingSessions)
      .innerJoin(groups, and(
        eq(groups.id, teachingSessions.groupId),
        eq(groups.schoolId, teachingSessions.schoolId)
      ))
      .innerJoin(classpilotSessionStaff, and(
        eq(classpilotSessionStaff.schoolId, options.schoolId),
        eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id),
        eq(classpilotSessionStaff.staffId, options.actorId)
      ))
      .where(conditions)
      .orderBy(
        sql`CASE WHEN ${teachingSessions.teacherId} = ${options.actorId} THEN 0 ELSE 1 END`,
        desc(teachingSessions.startTime),
        teachingSessions.id
      );
  }
  return options.dbInstance
    .select(fields)
    .from(teachingSessions)
    .innerJoin(groups, and(
      eq(groups.id, teachingSessions.groupId),
      eq(groups.schoolId, teachingSessions.schoolId)
    ))
    .where(conditions)
    .orderBy(desc(teachingSessions.startTime), teachingSessions.id);
}

async function loadStudentDataScopeSet(options: {
  schoolId: string;
  actorId: string;
  role: ClasspilotStudentDataRole;
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}): Promise<StudentDataScopeSet> {
  const activeSessions = await loadActiveScopeSessions(options);
  const activeByGroup = new Map<string, string>();
  for (const session of activeSessions) {
    if (!activeByGroup.has(session.groupId)) activeByGroup.set(session.groupId, session.id);
  }

  if (options.role !== "teacher") {
    const groupRows = await options.dbInstance
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(
        eq(groups.schoolId, options.schoolId),
        eq(groups.groupType, "admin_class")
      ))
      .orderBy(asc(groups.name), asc(groups.id));
    return {
      defaultScopeKey: "school",
      scopes: [
        {
          key: "school",
          kind: "school",
          label: "Entire school",
          groupId: null,
          activeTeachingSessionId: null,
          isActive: false,
        },
        ...groupRows.map((group) => ({
          ...scopeForGroup(group.id, group.name),
          activeTeachingSessionId: activeByGroup.get(group.id) ?? null,
          isActive: activeByGroup.has(group.id),
        })),
      ],
    };
  }

  const [primaryGroups, coTeacherGroups, historicalResult] = await Promise.all([
    options.dbInstance
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(
        eq(groups.schoolId, options.schoolId),
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active"),
        eq(groups.teacherId, options.actorId)
      )),
    options.dbInstance
      .select({ id: groups.id, name: groups.name })
      .from(groupTeachers)
      .innerJoin(groups, and(
        eq(groups.id, groupTeachers.groupId),
        eq(groups.schoolId, options.schoolId)
      ))
      .where(and(
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active"),
        eq(groupTeachers.teacherId, options.actorId)
      )),
    options.dbInstance.execute(sql`
      SELECT DISTINCT ON (session.group_id)
        session.group_id,
        COALESCE(NULLIF(BTRIM(session.class_name_snapshot), ''), class_group.name) AS label
      FROM ${classpilotSessionStaff} AS session_staff
      INNER JOIN ${teachingSessions} AS session
        ON session.id = session_staff.teaching_session_id
       AND session.school_id = ${options.schoolId}
       AND ${reportableSessionModeSql("teacher")}
      INNER JOIN ${groups} AS class_group
        ON class_group.id = session.group_id
       AND class_group.school_id = ${options.schoolId}
       AND class_group.group_type = 'admin_class'
      LEFT JOIN ${classpilotSessionReports} AS report
        ON report.school_id = ${options.schoolId}
       AND report.teaching_session_id = session.id
      WHERE session_staff.school_id = ${options.schoolId}
        AND session_staff.staff_id = ${options.actorId}
        AND session.roster_snapshot_completed_at IS NOT NULL
        AND ${retainedSessionAuthoritySql(options.authority)}
      ORDER BY session.group_id, session.start_time DESC, session.id DESC
    `),
  ]);

  const byGroup = new Map<string, string>();
  for (const group of [...primaryGroups, ...coTeacherGroups]) {
    if (!byGroup.has(group.id)) byGroup.set(group.id, group.name);
  }
  for (const raw of historicalResult.rows as Record<string, unknown>[]) {
    const groupId = typeof raw.group_id === "string" ? raw.group_id : "";
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (groupId && !byGroup.has(groupId)) byGroup.set(groupId, label || "Class");
  }
  const classScopes = [...byGroup.entries()]
    .map(([groupId, label]) => ({
      ...scopeForGroup(groupId, label),
      activeTeachingSessionId: activeByGroup.get(groupId) ?? null,
      isActive: activeByGroup.has(groupId),
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key));
  const ownedActiveSession = activeSessions.find(
    (session) => session.teacherId === options.actorId
  );
  return {
    defaultScopeKey: ownedActiveSession
      ? `class:${ownedActiveSession.groupId}`
      : "mine",
    scopes: [{
      key: "mine",
      kind: "mine",
      label: "My Classes",
      groupId: null,
      activeTeachingSessionId: null,
      isActive: false,
    }, ...classScopes],
  };
}

export async function getClasspilotStudentDataScopes(options: {
  schoolId: string;
  actorId: string;
  role: ClasspilotStudentDataRole;
  now?: Date;
  dbInstance?: typeof db;
}) {
  const dbInstance = options.dbInstance || db;
  return dbInstance.transaction(
    async (tx) => {
      const transactionDb = tx as unknown as typeof db;
      const authority = await loadStudentDataAuthorityWindow({
        schoolId: options.schoolId,
        now: options.now || new Date(),
        dbInstance: transactionDb,
      });
      return {
        schemaVersion: 1,
        ...await loadStudentDataScopeSet({
          ...options,
          authority,
          dbInstance: transactionDb,
        }),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

type ResolvedStudentDataSelection = {
  scope: ClasspilotStudentDataScope;
  session?: TeachingSession;
};

async function loadAuthorizedSession(options: {
  schoolId: string;
  actorId: string;
  role: ClasspilotStudentDataRole;
  sessionId: string;
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}): Promise<{ session: TeachingSession; groupName: string } | undefined> {
  const fields = { session: teachingSessions, groupName: groups.name };
  const conditions = and(
    eq(teachingSessions.id, options.sessionId),
    eq(teachingSessions.schoolId, options.schoolId),
    reportableSessionMode(options.role),
    isNotNull(teachingSessions.rosterSnapshotCompletedAt),
    eq(groups.id, teachingSessions.groupId),
    eq(groups.schoolId, options.schoolId),
    retainedSessionAuthorityTableSql(options.authority)
  );
  if (options.role === "teacher") {
    return (await options.dbInstance
      .select(fields)
      .from(teachingSessions)
      .innerJoin(groups, and(
        eq(groups.id, teachingSessions.groupId),
        eq(groups.schoolId, teachingSessions.schoolId)
      ))
      .leftJoin(classpilotSessionReports, and(
        eq(classpilotSessionReports.schoolId, options.schoolId),
        eq(classpilotSessionReports.teachingSessionId, teachingSessions.id)
      ))
      .innerJoin(classpilotSessionStaff, and(
        eq(classpilotSessionStaff.schoolId, options.schoolId),
        eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id),
        eq(classpilotSessionStaff.staffId, options.actorId)
      ))
      .where(conditions)
      .limit(1))[0];
  }
  return (await options.dbInstance
    .select(fields)
    .from(teachingSessions)
    .innerJoin(groups, and(
      eq(groups.id, teachingSessions.groupId),
      eq(groups.schoolId, teachingSessions.schoolId)
    ))
    .leftJoin(classpilotSessionReports, and(
      eq(classpilotSessionReports.schoolId, options.schoolId),
      eq(classpilotSessionReports.teachingSessionId, teachingSessions.id)
    ))
    .where(conditions)
    .limit(1))[0];
}

async function resolveStudentDataSelection(options: {
  schoolId: string;
  actorId: string;
  role: ClasspilotStudentDataRole;
  scope?: ClasspilotStudentDataScopeKind;
  groupId?: string;
  sessionId?: string;
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}): Promise<ResolvedStudentDataSelection> {
  if (options.sessionId) {
    if (options.scope !== undefined || options.groupId !== undefined) {
      invalidSelector("sessionId cannot be combined with scope or groupId");
    }
    const authorized = await loadAuthorizedSession({
      schoolId: options.schoolId,
      actorId: options.actorId,
      role: options.role,
      sessionId: options.sessionId,
      authority: options.authority,
      dbInstance: options.dbInstance,
    });
    if (!authorized) scopeNotFound();
    return {
      session: authorized.session,
      scope: scopeForGroup(
        authorized.session.groupId,
        authorized.session.classNameSnapshot || authorized.groupName
      ),
    };
  }

  if (options.scope === "class" && !options.groupId) {
    invalidSelector("groupId is required for class scope");
  }
  if (options.scope !== "class" && options.groupId !== undefined) {
    invalidSelector("groupId is only valid for class scope");
  }
  const scopeSet = await loadStudentDataScopeSet(options);
  const requestedKey = options.scope === "class"
    ? `class:${options.groupId}`
    : options.scope || scopeSet.defaultScopeKey;
  const selected = scopeSet.scopes.find((scope) => scope.key === requestedKey);
  if (!selected) scopeNotFound();
  return {
    scope: {
      key: selected.key,
      kind: selected.kind,
      label: selected.label,
      groupId: selected.groupId,
    },
  };
}

function usageScopeConditions(options: {
  schoolId: string;
  role: ClasspilotStudentDataRole;
  actorId: string;
  selection: ResolvedStudentDataSelection;
  startLocalDate: string;
  endLocalDate: string;
  studentIds?: string[];
  authority: StudentDataAuthorityWindow;
}): SQL[] {
  const conditions: SQL[] = [
    sql`usage.school_id = ${options.schoolId}`,
    sql`session.school_id = ${options.schoolId}`,
    reportableSessionModeSql(options.role),
    sql`session.roster_snapshot_completed_at IS NOT NULL`,
    sql`class_group.school_id = ${options.schoolId}`,
    retainedSessionAuthoritySql(options.authority),
    sql`(report.id IS NULL OR report.state = 'ready')`,
  ];
  if (options.selection.session) {
    conditions.push(sql`session.id = ${options.selection.session.id}`);
  } else {
    conditions.push(
      sql`usage.local_date >= ${options.startLocalDate}`,
      sql`usage.local_date <= ${options.endLocalDate}`
    );
    if (options.selection.scope.kind === "class") {
      conditions.push(sql`session.group_id = ${options.selection.scope.groupId!}`);
    }
    if (options.selection.scope.kind === "mine") {
      conditions.push(sql`class_group.group_type = 'admin_class'`);
    }
  }
  if (options.studentIds?.length) {
    conditions.push(sql`usage.student_id IN (${sql.join(
      options.studentIds.map((studentId) => sql`${studentId}`),
      sql`, `
    )})`);
  }
  return conditions;
}

/**
 * Distinct session modes behind the usage rows in scope.
 *
 * Drives `monitoringCoverage` on the response. Without it "this class was never
 * monitored" and "this class was monitored and the students were idle" are
 * indistinguishable in the payload -- they render byte-identically -- so the UI
 * had no way to stop presenting the first as though it were the second.
 *
 * Deliberately reuses usageScopeConditions verbatim so coverage can never
 * disagree with the aggregate it describes.
 */
async function loadScopeSessionModes(options: {
  schoolId: string;
  role: ClasspilotStudentDataRole;
  actorId: string;
  selection: ResolvedStudentDataSelection;
  startLocalDate: string;
  endLocalDate: string;
  studentIds?: string[];
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}): Promise<Set<string>> {
  if (options.studentIds?.length === 0) return new Set();
  const conditions = usageScopeConditions(options);
  const staffJoin = options.role === "teacher"
    ? sql`
        INNER JOIN ${classpilotSessionStaff} AS session_staff
          ON session_staff.school_id = ${options.schoolId}
         AND session_staff.teaching_session_id = session.id
         AND session_staff.staff_id = ${options.actorId}
      `
    : sql``;
  const result = await options.dbInstance.execute(sql`
    SELECT DISTINCT session.session_mode AS session_mode
    FROM ${classpilotSessionUsage} AS usage
    INNER JOIN ${teachingSessions} AS session
      ON session.id = usage.teaching_session_id
     AND session.school_id = ${options.schoolId}
    INNER JOIN ${groups} AS class_group
      ON class_group.id = session.group_id
     AND class_group.school_id = ${options.schoolId}
    LEFT JOIN ${classpilotSessionReports} AS report
      ON report.school_id = ${options.schoolId}
     AND report.teaching_session_id = session.id
    ${staffJoin}
    WHERE ${sql.join(conditions, sql` AND `)}
  `);
  const modes = new Set<string>();
  for (const row of result.rows as Array<{ session_mode: unknown }>) {
    if (typeof row.session_mode === "string" && row.session_mode) modes.add(row.session_mode);
  }
  return modes;
}

/**
 * Whether the numbers on screen came from a monitored session, an unattended
 * scheduled block, or no session at all.
 */
function resolveMonitoringCoverage(
  storedModes: Set<string>,
  candidates: ProvisionalSession[]
): ClasspilotStudentDataMonitoringCoverage {
  const modes = new Set(storedModes);
  for (const candidate of candidates) {
    if (candidate.session.sessionMode) modes.add(candidate.session.sessionMode);
  }
  if (modes.size === 0) return "no_session";
  return modes.has("live") ? "monitored" : "unattended";
}

async function loadAggregatedStoredUsage(options: {
  schoolId: string;
  role: ClasspilotStudentDataRole;
  actorId: string;
  selection: ResolvedStudentDataSelection;
  startLocalDate: string;
  endLocalDate: string;
  studentIds?: string[];
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}): Promise<StoredUsageRow[]> {
  if (options.studentIds?.length === 0) return [];
  const conditions = usageScopeConditions(options);
  const staffJoin = options.role === "teacher"
    ? sql`
        INNER JOIN ${classpilotSessionStaff} AS session_staff
          ON session_staff.school_id = ${options.schoolId}
         AND session_staff.teaching_session_id = session.id
         AND session_staff.staff_id = ${options.actorId}
      `
    : sql``;
  const result = await options.dbInstance.execute(sql`
    WITH scoped_usage AS MATERIALIZED (
      SELECT
        usage.student_id,
        usage.total_seconds,
        usage.heartbeat_count,
        usage.top_domains,
        usage.top_activities,
        usage.computed_at
      FROM ${classpilotSessionUsage} AS usage
      INNER JOIN ${teachingSessions} AS session
        ON session.id = usage.teaching_session_id
       AND session.school_id = ${options.schoolId}
      INNER JOIN ${groups} AS class_group
        ON class_group.id = session.group_id
       AND class_group.school_id = ${options.schoolId}
      INNER JOIN ${classpilotSessionStudents} AS frozen_roster
        ON frozen_roster.school_id = ${options.schoolId}
       AND frozen_roster.teaching_session_id = session.id
       AND frozen_roster.group_id = session.group_id
       AND frozen_roster.student_id = usage.student_id
      LEFT JOIN ${classpilotSessionReports} AS report
        ON report.school_id = ${options.schoolId}
       AND report.teaching_session_id = session.id
      ${staffJoin}
      WHERE ${sql.join(conditions, sql` AND `)}
    ),
    student_totals AS (
      SELECT
        student_id,
        COALESCE(SUM(GREATEST(total_seconds, 0)), 0)::bigint AS total_seconds,
        COALESCE(SUM(GREATEST(heartbeat_count, 0)), 0)::bigint AS heartbeat_count,
        MAX(computed_at) AS computed_at
      FROM scoped_usage
      GROUP BY student_id
    ),
    domain_totals AS (
      SELECT
        scoped.student_id,
        NULLIF(BTRIM(domain_item.value->>'domain'), '') AS domain,
        SUM(
          CASE
            WHEN COALESCE(domain_item.value->>'seconds', '') ~ '^[0-9]+$'
              THEN (domain_item.value->>'seconds')::numeric
            ELSE 0
          END
        )::bigint AS seconds
      FROM scoped_usage AS scoped
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(scoped.top_domains) = 'array' THEN scoped.top_domains
          ELSE '[]'::jsonb
        END
      ) AS domain_item(value)
      WHERE jsonb_typeof(domain_item.value) = 'object'
        AND NULLIF(BTRIM(domain_item.value->>'domain'), '') IS NOT NULL
      GROUP BY scoped.student_id, NULLIF(BTRIM(domain_item.value->>'domain'), '')
    ),
    ranked_domains AS (
      SELECT
        student_id,
        domain,
        GREATEST(seconds, 0) AS seconds,
        ROW_NUMBER() OVER (
          PARTITION BY student_id
          ORDER BY GREATEST(seconds, 0) DESC, domain
        ) AS domain_rank
      FROM domain_totals
    ),
    activity_items AS (
      SELECT
        scoped.student_id,
        activity_item.value AS value
      FROM scoped_usage AS scoped
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(scoped.top_activities) = 'array' THEN scoped.top_activities
          ELSE '[]'::jsonb
        END
      ) AS activity_item(value)
      WHERE scoped.top_activities IS NOT NULL
        AND jsonb_typeof(activity_item.value) = 'object'

      UNION ALL

      SELECT
        scoped.student_id,
        JSONB_BUILD_OBJECT(
          'kind', CASE NULLIF(BTRIM(domain_item.value->>'domain'), '')
            WHEN 'docs.google.com' THEN 'google_workspace_unspecified'
            WHEN 'slides.google.com' THEN 'google_slides'
            WHEN 'forms.google.com' THEN 'google_forms'
            WHEN 'sheets.google.com' THEN 'google_sheets'
            WHEN 'spreadsheets.google.com' THEN 'google_sheets'
            WHEN 'classroom.google.com' THEN 'google_classroom'
            WHEN 'drive.google.com' THEN 'google_drive'
            WHEN 'mail.google.com' THEN 'google_mail'
            WHEN 'meet.google.com' THEN 'google_meet'
            -- google.com stays 'domain': legacy rows carry no path, so Search
            -- cannot be distinguished from Maps. See fallbackActivityKind.
            ELSE 'domain'
          END,
          'domain', NULLIF(BTRIM(domain_item.value->>'domain'), ''),
          'seconds', CASE
            WHEN COALESCE(domain_item.value->>'seconds', '') ~ '^[0-9]+$'
              THEN (domain_item.value->>'seconds')::numeric
            ELSE 0
          END
        ) AS value
      FROM scoped_usage AS scoped
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(scoped.top_domains) = 'array' THEN scoped.top_domains
          ELSE '[]'::jsonb
        END
      ) AS domain_item(value)
      WHERE scoped.top_activities IS NULL
        AND jsonb_typeof(domain_item.value) = 'object'
        AND NULLIF(BTRIM(domain_item.value->>'domain'), '') IS NOT NULL
    ),
    activity_totals AS (
      SELECT
        student_id,
        NULLIF(BTRIM(value->>'kind'), '') AS kind,
        NULLIF(BTRIM(value->>'domain'), '') AS domain,
        SUM(
          CASE
            WHEN COALESCE(value->>'seconds', '') ~ '^[0-9]+$'
              THEN (value->>'seconds')::numeric
            ELSE 0
          END
        )::bigint AS seconds
      FROM activity_items
      WHERE NULLIF(BTRIM(value->>'kind'), '') IS NOT NULL
        AND NULLIF(BTRIM(value->>'domain'), '') IS NOT NULL
      GROUP BY
        student_id,
        NULLIF(BTRIM(value->>'kind'), ''),
        NULLIF(BTRIM(value->>'domain'), '')
    ),
    ranked_activities AS (
      SELECT
        student_id,
        kind,
        domain,
        GREATEST(seconds, 0) AS seconds,
        ROW_NUMBER() OVER (
          PARTITION BY student_id
          ORDER BY GREATEST(seconds, 0) DESC, kind, domain
        ) AS activity_rank
      FROM activity_totals
    )
    SELECT
      totals.student_id,
      totals.total_seconds,
      totals.heartbeat_count,
      totals.computed_at,
      COALESCE(
        JSONB_AGG(
          JSONB_BUILD_OBJECT('domain', domains.domain, 'seconds', domains.seconds)
          ORDER BY domains.seconds DESC, domains.domain
        ) FILTER (WHERE domains.domain_rank <= 50),
        '[]'::jsonb
      ) AS top_domains,
      COALESCE((
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'kind', activities.kind,
            'domain', activities.domain,
            'seconds', activities.seconds
          )
          ORDER BY activities.seconds DESC, activities.kind, activities.domain
        )
        FROM ranked_activities AS activities
        WHERE activities.student_id = totals.student_id
          AND activities.activity_rank <= 50
      ), '[]'::jsonb) AS top_activities
    FROM student_totals AS totals
    LEFT JOIN ranked_domains AS domains
      ON domains.student_id = totals.student_id
     AND domains.domain_rank <= 50
    GROUP BY
      totals.student_id,
      totals.total_seconds,
      totals.heartbeat_count,
      totals.computed_at
    ORDER BY totals.student_id
  `);
  return (result.rows as Record<string, unknown>[]).flatMap((row) => {
    if (typeof row.student_id !== "string") return [];
    return [{
      studentId: row.student_id,
      totalSeconds: nonnegativeInteger(row.total_seconds),
      heartbeatCount: nonnegativeInteger(row.heartbeat_count),
      topDomains: jsonArray(row.top_domains),
      topActivities: jsonArray(row.top_activities),
      computedAt: dateFromUnknown(row.computed_at, new Date(0)),
    }];
  });
}

async function loadCurrentRosterIdentities(options: {
  schoolId: string;
  role: ClasspilotStudentDataRole;
  actorId: string;
  selection: ResolvedStudentDataSelection;
  dbInstance: typeof db;
}): Promise<StudentIdentity[]> {
  if (
    options.selection.session
    || options.selection.scope.kind === "school"
  ) return [];
  if (options.role !== "teacher" && options.selection.scope.kind !== "class") return [];

  const scopeConditions: SQL[] = [
    sql`class_group.school_id = ${options.schoolId}`,
    sql`class_group.group_type = 'admin_class'`,
    sql`class_group.status = 'active'`,
  ];
  if (options.selection.scope.kind === "class") {
    scopeConditions.push(sql`class_group.id = ${options.selection.scope.groupId!}`);
  }
  if (options.role === "teacher") {
    scopeConditions.push(sql`(
      class_group.teacher_id = ${options.actorId}
      OR EXISTS (
        SELECT 1
        FROM ${groupTeachers} AS current_co_teacher
        WHERE current_co_teacher.group_id = class_group.id
          AND current_co_teacher.teacher_id = ${options.actorId}
      )
    )`);
  }
  const result = await options.dbInstance.execute(sql`
    SELECT DISTINCT ON (student.id)
      student.id AS student_id,
      COALESCE(
        NULLIF(BTRIM(CONCAT_WS(' ', student.first_name, student.last_name)), ''),
        'Unknown student'
      ) AS student_name
    FROM ${groups} AS class_group
    INNER JOIN ${groupStudents} AS current_roster
      ON current_roster.group_id = class_group.id
    INNER JOIN ${students} AS student
      ON student.id = current_roster.student_id
     AND student.school_id = ${options.schoolId}
     AND student.status = 'active'
    WHERE ${sql.join(scopeConditions, sql` AND `)}
    ORDER BY student.id, current_roster.assigned_at DESC, current_roster.id DESC
  `);
  return (result.rows as Record<string, unknown>[]).flatMap((row) => (
    typeof row.student_id === "string"
      ? [{
          studentId: row.student_id,
          name: typeof row.student_name === "string" && row.student_name.trim()
            ? row.student_name.trim()
            : "Unknown student",
        }]
      : []
  ));
}

async function loadScopedIdentities(options: {
  schoolId: string;
  role: ClasspilotStudentDataRole;
  actorId: string;
  selection: ResolvedStudentDataSelection;
  rangeStart: Date;
  rangeEnd: Date;
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}): Promise<StudentIdentity[]> {
  const conditions: SQL[] = [
    sql`roster.school_id = ${options.schoolId}`,
    sql`session.school_id = ${options.schoolId}`,
    reportableSessionModeSql(options.role),
    sql`session.roster_snapshot_completed_at IS NOT NULL`,
    sql`class_group.school_id = ${options.schoolId}`,
    retainedSessionAuthoritySql(options.authority),
  ];
  if (options.selection.session) {
    conditions.push(sql`session.id = ${options.selection.session.id}`);
  } else {
    conditions.push(
      sql`session.start_time AT TIME ZONE 'UTC' < ${options.rangeEnd.toISOString()}`,
      sql`LEAST(
        COALESCE(report.window_end, 'infinity'::timestamptz),
        COALESCE(session.end_time AT TIME ZONE 'UTC', 'infinity'::timestamptz),
        COALESCE(session.scheduled_end_at, 'infinity'::timestamptz),
        (session.start_time AT TIME ZONE 'UTC') + interval '12 hours'
      ) > ${options.rangeStart.toISOString()}`
    );
    if (options.selection.scope.kind === "class") {
      conditions.push(sql`session.group_id = ${options.selection.scope.groupId!}`);
    } else {
      conditions.push(sql`class_group.group_type = 'admin_class'`);
    }
  }
  const staffJoin = options.role === "teacher"
    ? sql`
        INNER JOIN ${classpilotSessionStaff} AS session_staff
          ON session_staff.school_id = ${options.schoolId}
         AND session_staff.teaching_session_id = session.id
         AND session_staff.staff_id = ${options.actorId}
      `
    : sql``;
  const result = await options.dbInstance.execute(sql`
    SELECT DISTINCT ON (roster.student_id)
      roster.student_id,
      COALESCE(
        NULLIF(BTRIM(roster.student_name_snapshot), ''),
        NULLIF(BTRIM(CONCAT_WS(' ', student.first_name, student.last_name)), ''),
        'Unknown student'
      ) AS student_name
    FROM ${classpilotSessionStudents} AS roster
    INNER JOIN ${teachingSessions} AS session
      ON session.id = roster.teaching_session_id
     AND session.school_id = ${options.schoolId}
     AND session.group_id = roster.group_id
    INNER JOIN ${groups} AS class_group
      ON class_group.id = session.group_id
     AND class_group.school_id = ${options.schoolId}
    LEFT JOIN ${students} AS student
     ON student.id = roster.student_id
     AND student.school_id = ${options.schoolId}
    LEFT JOIN ${classpilotSessionReports} AS report
      ON report.school_id = ${options.schoolId}
     AND report.teaching_session_id = session.id
    ${staffJoin}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY
      roster.student_id,
      session.start_time DESC,
      roster.captured_at DESC,
      roster.id DESC
  `);
  const frozen = (result.rows as Record<string, unknown>[]).flatMap((row) => (
    typeof row.student_id === "string"
      ? [{
          studentId: row.student_id,
          name: typeof row.student_name === "string" && row.student_name.trim()
            ? row.student_name.trim()
            : "Unknown student",
        }]
      : []
  ));
  const current = !options.selection.session && options.selection.scope.kind === "school"
    ? await options.dbInstance
        .select({
          studentId: students.id,
          firstName: students.firstName,
          lastName: students.lastName,
        })
        .from(students)
        .where(and(
          eq(students.schoolId, options.schoolId),
          eq(students.status, "active")
        ))
        .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id))
        .then((rows) => rows.map((row) => ({
          studentId: row.studentId,
          name: [row.firstName, row.lastName].filter(Boolean).join(" ") || "Unknown student",
        })))
    : await loadCurrentRosterIdentities(options);
  const byStudent = new Map(frozen.map((identity) => [identity.studentId, identity]));
  for (const identity of current) {
    if (!byStudent.has(identity.studentId)) byStudent.set(identity.studentId, identity);
  }
  return [...byStudent.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.studentId.localeCompare(right.studentId)
  );
}

type ProvisionalSession = {
  session: TeachingSession;
  report: ClasspilotSessionReport | null;
  state: "live" | "finalizing" | "unavailable";
};

async function loadProvisionalSessions(options: {
  schoolId: string;
  actorId: string;
  role: ClasspilotStudentDataRole;
  selection: ResolvedStudentDataSelection;
  rangeStart: Date;
  rangeEnd: Date;
  authority: StudentDataAuthorityWindow;
  dbInstance: typeof db;
}): Promise<ProvisionalSession[]> {
  if (!options.selection.session && options.selection.scope.kind !== "class") return [];
  const groupId = options.selection.session?.groupId || options.selection.scope.groupId!;
  const sessionConditions = [
    eq(teachingSessions.schoolId, options.schoolId),
    reportableSessionMode(options.role),
    eq(teachingSessions.groupId, groupId),
    isNotNull(teachingSessions.rosterSnapshotCompletedAt),
    eq(groups.schoolId, options.schoolId),
  ];
  if (options.selection.session) {
    sessionConditions.push(eq(teachingSessions.id, options.selection.session.id));
  } else {
    sessionConditions.push(
      sql`${teachingSessions.startTime} AT TIME ZONE 'UTC' < ${options.rangeEnd.toISOString()}`,
      sql`LEAST(
        COALESCE(${classpilotSessionReports.windowEnd}, 'infinity'::timestamptz),
        COALESCE(${teachingSessions.endTime} AT TIME ZONE 'UTC', 'infinity'::timestamptz),
        COALESCE(${teachingSessions.scheduledEndAt}, 'infinity'::timestamptz),
        (${teachingSessions.startTime} AT TIME ZONE 'UTC') + interval '12 hours'
      ) > ${options.rangeStart.toISOString()}`
    );
  }
  const fields = { session: teachingSessions, report: classpilotSessionReports };
  const load = () => {
    const base = options.dbInstance
      .select(fields)
      .from(teachingSessions)
      .innerJoin(groups, and(
        eq(groups.id, teachingSessions.groupId),
        eq(groups.schoolId, teachingSessions.schoolId)
      ))
      .leftJoin(classpilotSessionReports, and(
        eq(classpilotSessionReports.schoolId, options.schoolId),
        eq(classpilotSessionReports.teachingSessionId, teachingSessions.id)
      ));
    return options.role === "teacher"
      ? base.innerJoin(classpilotSessionStaff, and(
          eq(classpilotSessionStaff.schoolId, options.schoolId),
          eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id),
          eq(classpilotSessionStaff.staffId, options.actorId)
        ))
      : base;
  };
  const rows = await load()
    .where(and(
      ...sessionConditions,
      retainedSessionAuthorityTableSql(options.authority),
      or(
        isNull(teachingSessions.endTime),
        and(
          isNotNull(teachingSessions.endTime),
          inArray(classpilotSessionReports.state, ["pending", "materializing", "failed"])
        )
      )
    ))
    .orderBy(desc(teachingSessions.startTime), teachingSessions.id);
  const provisional: ProvisionalSession[] = [];
  for (const row of rows) {
    if (row.report?.state === "failed") {
      provisional.push({ session: row.session, report: row.report, state: "unavailable" });
      continue;
    }
    if (row.session.endTime) {
      if (row.report && (row.report.state === "pending" || row.report.state === "materializing")) {
        provisional.push({ session: row.session, report: row.report, state: "finalizing" });
      }
    } else {
      const authorityDeadline = sessionAuthorityDeadline(row.session, row.report?.windowEnd);
      provisional.push({
        session: row.session,
        report: row.report,
        state: authorityDeadline > options.authority.now ? "live" : "finalizing",
      });
    }
  }
  return provisional;
}

type TrackingPolicy = ClasspilotSessionReportInput["trackingPolicy"];

async function loadCurrentTrackingPolicy(options: {
  schoolId: string;
  timeZone: string;
  dbInstance: typeof db;
}): Promise<TrackingPolicy> {
  const [row] = await options.dbInstance
    .select({
      enableTrackingHours: settings.enableTrackingHours,
      trackingStartTime: settings.trackingStartTime,
      trackingEndTime: settings.trackingEndTime,
      trackingDays: settings.trackingDays,
      afterHoursMode: settings.afterHoursMode,
      schoolTimezone: settings.schoolTimezone,
    })
    .from(settings)
    .where(eq(settings.schoolId, options.schoolId))
    .limit(1);
  return {
    enableTrackingHours: row?.enableTrackingHours === true,
    trackingStartTime: row?.trackingStartTime || null,
    trackingEndTime: row?.trackingEndTime || null,
    trackingDays: row?.trackingDays || [],
    schoolTimezone: row?.schoolTimezone || options.timeZone,
    afterHoursMode: row?.afterHoursMode || "off",
  };
}

async function loadReadOnlyProvisionalContext(options: {
  schoolId: string;
  session: TeachingSession;
  windowStart: Date;
  windowEnd: Date;
  trackingPolicy: TrackingPolicy;
  dbInstance: typeof db;
}): Promise<ClasspilotSessionReportInput> {
  const roster = await options.dbInstance
    .select({
      studentId: classpilotSessionStudents.studentId,
      studentName: classpilotSessionStudents.studentNameSnapshot,
      capturedAt: classpilotSessionStudents.capturedAt,
    })
    .from(classpilotSessionStudents)
    .where(and(
      eq(classpilotSessionStudents.schoolId, options.schoolId),
      eq(classpilotSessionStudents.teachingSessionId, options.session.id),
      eq(classpilotSessionStudents.groupId, options.session.groupId)
    ));
  const studentIds = roster.map((row) => row.studentId);
  if (studentIds.length === 0) {
    return {
      session: options.session,
      roster: [],
      authenticatedSessions: [],
      heartbeats: [],
      aiDecisions: [],
      evidenceArtifacts: [],
      exclusions: [],
      monitoringEvents: [],
      trackingPolicy: options.trackingPolicy,
    };
  }
  const [authenticatedSessions, supervisionRows, monitoringEvents] = await Promise.all([
    options.dbInstance
      .select({
        id: studentSessions.id,
        studentId: studentSessions.studentId,
        startedAt: studentSessions.startedAt,
        endedAt: studentSessions.endedAt,
        lastSeenAt: studentSessions.lastSeenAt,
      })
      .from(studentSessions)
      .innerJoin(students, and(
        eq(students.id, studentSessions.studentId),
        eq(students.schoolId, options.schoolId)
      ))
      .where(and(
        inArray(studentSessions.studentId, studentIds),
        sql`${studentSessions.startedAt} < ${options.windowEnd.toISOString()}`,
        sql`COALESCE(${studentSessions.endedAt}, ${options.windowEnd.toISOString()}) > ${options.windowStart.toISOString()}`
      )),
    options.dbInstance
      .select({
        studentId: classpilotSupervisionStudents.studentId,
        assignedAt: classpilotSupervisionStudents.assignedAt,
        releasedAt: classpilotSupervisionStudents.releasedAt,
        startsAt: classpilotSupervisionContexts.startsAt,
        endsAt: classpilotSupervisionContexts.endsAt,
        endedAt: classpilotSupervisionContexts.endedAt,
      })
      .from(classpilotSupervisionStudents)
      .innerJoin(classpilotSupervisionContexts, and(
        eq(classpilotSupervisionContexts.id, classpilotSupervisionStudents.contextId),
        eq(classpilotSupervisionContexts.schoolId, options.schoolId)
      ))
      .where(and(
        eq(classpilotSupervisionStudents.schoolId, options.schoolId),
        inArray(classpilotSupervisionStudents.studentId, studentIds),
        sql`${classpilotSupervisionStudents.assignedAt} < ${options.windowEnd.toISOString()}`,
        sql`COALESCE(${classpilotSupervisionStudents.releasedAt}, ${classpilotSupervisionContexts.endedAt}, ${classpilotSupervisionContexts.endsAt}) > ${options.windowStart.toISOString()}`
      )),
    options.dbInstance
      .select()
      .from(classpilotMonitoringEvents)
      .where(and(
        eq(classpilotMonitoringEvents.schoolId, options.schoolId),
        eq(classpilotMonitoringEvents.teachingSessionId, options.session.id),
        inArray(classpilotMonitoringEvents.studentId, studentIds),
        sql`${classpilotMonitoringEvents.occurredAt} >= ${options.windowStart}`,
        sql`${classpilotMonitoringEvents.occurredAt} < ${options.windowEnd}`,
        ne(classpilotMonitoringEvents.eventType, "monitoring_gap")
      )),
  ]);
  return {
    session: options.session,
    roster: roster.map((row) => ({
      studentId: row.studentId,
      studentName: row.studentName || "Unknown student",
      capturedAt: row.capturedAt,
    })),
    authenticatedSessions,
    heartbeats: [],
    aiDecisions: [],
    evidenceArtifacts: [],
    exclusions: supervisionRows.flatMap((row) => {
      const end = [row.releasedAt, row.endedAt, row.endsAt]
        .filter((value): value is Date => !!value)
        .sort((left, right) => left.getTime() - right.getTime())[0];
      if (!end) return [];
      return [{
        studentId: row.studentId,
        start: row.assignedAt > row.startsAt ? row.assignedAt : row.startsAt,
        end,
        source: "delegated_supervision" as const,
      }];
    }),
    monitoringEvents,
    trackingPolicy: options.trackingPolicy,
  };
}

function usageKey(row: Pick<KeyedStoredUsageRow, "teachingSessionId" | "studentId" | "localDate">) {
  return `${row.teachingSessionId}\u0000${row.studentId}\u0000${row.localDate}`;
}

async function loadStoredKeysForSessions(options: {
  schoolId: string;
  sessionIds: string[];
  dbInstance: typeof db;
}): Promise<Set<string>> {
  if (options.sessionIds.length === 0) return new Set();
  const rows = await options.dbInstance
    .select({
      teachingSessionId: classpilotSessionUsage.teachingSessionId,
      studentId: classpilotSessionUsage.studentId,
      localDate: classpilotSessionUsage.localDate,
    })
    .from(classpilotSessionUsage)
    .innerJoin(teachingSessions, and(
      eq(teachingSessions.id, classpilotSessionUsage.teachingSessionId),
      eq(teachingSessions.schoolId, options.schoolId),
      inArray(teachingSessions.sessionMode, [LIVE_SESSION_MODE, SCHEDULED_REPORT_SESSION_MODE])
    ))
    .leftJoin(classpilotSessionReports, and(
      eq(classpilotSessionReports.schoolId, options.schoolId),
      eq(classpilotSessionReports.teachingSessionId, teachingSessions.id)
    ))
    .where(and(
      eq(classpilotSessionUsage.schoolId, options.schoolId),
      inArray(classpilotSessionUsage.teachingSessionId, options.sessionIds),
      or(
        isNull(classpilotSessionReports.id),
        eq(classpilotSessionReports.state, "ready")
      )
    ));
  return new Set(rows.map(usageKey));
}

function stableHashValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableHashValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableHashValue(nested)])
    );
  }
  return value;
}

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableHashValue(value)))
    .digest("base64url");
}

function provisionalContextHash(input: ClasspilotSessionReportInput): string {
  return sha256Json({
    roster: input.roster
      .map((row) => ({ studentId: row.studentId, capturedAt: row.capturedAt }))
      .sort((left, right) => left.studentId.localeCompare(right.studentId)),
    authenticatedSessions: [...input.authenticatedSessions]
      .map((row) => ({
        id: row.id,
        studentId: row.studentId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    exclusions: [...input.exclusions]
      .sort((left, right) => left.studentId.localeCompare(right.studentId)
        || left.start.getTime() - right.start.getTime()),
    monitoringEvents: [...input.monitoringEvents]
      .map((event) => ({
        id: event.id,
        studentId: event.studentId,
        eventType: event.eventType,
        origin: event.origin,
        occurredAt: event.occurredAt,
        metadata: event.metadata,
      }))
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()
        || left.id.localeCompare(right.id)),
  });
}

function provisionalCacheTtlSeconds(options: {
  candidate: ProvisionalSession;
  now: Date;
  retentionCutoff: Date;
}): number {
  const deadline = sessionAuthorityDeadline(
    options.candidate.session,
    options.candidate.report?.windowEnd
  );
  const retentionMs = options.now.getTime() - options.retentionCutoff.getTime();
  const upperBounds = [
    options.now.getTime() + 90_000,
    deadline.getTime() + retentionMs,
    options.candidate.report?.expiresAt.getTime() ?? Number.POSITIVE_INFINITY,
  ];
  if (options.candidate.state === "live") upperBounds.push(deadline.getTime());
  return Math.max(1, Math.floor((Math.min(...upperBounds) - options.now.getTime()) / 1_000));
}

async function materializeReadOnlyProvisionalUsage(options: {
  schoolId: string;
  timeZone: string;
  periodWindow: ReturnType<typeof resolveClasspilotStudentDataWindow>;
  sessionSpecific: boolean;
  candidates: ProvisionalSession[];
  now: Date;
  retentionCutoff: Date;
  dbInstance: typeof db;
}): Promise<{ rows: KeyedStoredUsageRow[]; asOf: Date | null }> {
  if (options.candidates.length === 0) return { rows: [], asOf: null };
  const [currentPolicy, storedKeys] = await Promise.all([
    loadCurrentTrackingPolicy({
      schoolId: options.schoolId,
      timeZone: options.timeZone,
      dbInstance: options.dbInstance,
    }),
    loadStoredKeysForSessions({
      schoolId: options.schoolId,
      sessionIds: options.candidates.map((candidate) => candidate.session.id),
      dbInstance: options.dbInstance,
    }),
  ]);
  const rows: KeyedStoredUsageRow[] = [];
  let asOf: Date | null = null;
  for (const candidate of options.candidates) {
    if (candidate.state === "unavailable") continue;
    const timeZone = candidate.report?.timezone
      || candidate.session.timezoneSnapshot
      || options.timeZone;
    const localDate = localDateInTimeZone(candidate.session.startTime, timeZone);
    if (!options.sessionSpecific && (
      localDate < options.periodWindow.startLocalDate
      || localDate > options.periodWindow.endLocalDate
    )) continue;
    const authoritativeStart = candidate.report?.windowStart || candidate.session.startTime;
    const authoritativeEnd = effectiveSessionAuthorityEnd(
      candidate.session,
      options.now,
      candidate.report?.windowEnd
    );
    const bucketCutoff = new Date(
      Math.floor(options.now.getTime() / CLASSPILOT_STUDENT_DATA_CACHE_BUCKET_MS)
        * CLASSPILOT_STUDENT_DATA_CACHE_BUCKET_MS
    );
    const windowStart = new Date(Math.max(
      authoritativeStart.getTime(),
      options.periodWindow.rangeStart.getTime()
    ));
    const windowEnd = new Date(Math.min(
      authoritativeEnd.getTime(),
      options.periodWindow.rangeEnd.getTime(),
      bucketCutoff.getTime()
    ));
    if (windowEnd <= windowStart) continue;
    const trackingPolicy: TrackingPolicy = candidate.report?.trackingPolicy
      ? {
          enableTrackingHours: candidate.report.trackingPolicy.enableTrackingHours === true,
          trackingStartTime: candidate.report.trackingPolicy.trackingStartTime || null,
          trackingEndTime: candidate.report.trackingPolicy.trackingEndTime || null,
          trackingDays: candidate.report.trackingPolicy.trackingDays || [],
          schoolTimezone: candidate.report.trackingPolicy.schoolTimezone || timeZone,
          afterHoursMode: candidate.report.trackingPolicy.afterHoursMode || "off",
        }
      : { ...currentPolicy, schoolTimezone: timeZone };
    const context = await loadReadOnlyProvisionalContext({
      schoolId: options.schoolId,
      session: candidate.session,
      windowStart,
      windowEnd,
      trackingPolicy,
      dbInstance: options.dbInstance,
    });
    const reportForRead = {
      ...(candidate.report || {}),
      schoolId: options.schoolId,
      teachingSessionId: candidate.session.id,
      windowStart,
      windowEnd,
      timezone: timeZone,
      reportVersion: candidate.report?.reportVersion
        || classpilotSessionReportVersionForNewRow(),
    } as ClasspilotSessionReport;
    const binding: ClasspilotStudentDataCacheBinding = {
      schemaVersion: 2,
      schoolId: options.schoolId,
      teachingSessionId: candidate.session.id,
      groupId: candidate.session.groupId,
      state: candidate.state,
      reportId: candidate.report?.id ?? null,
      reportState: candidate.report?.state ?? null,
      reportVersion: reportForRead.reportVersion,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      snapshotBucket: bucketCutoff.toISOString(),
      timezone: timeZone,
      trackingPolicyHash: sha256Json(trackingPolicy),
      contextHash: provisionalContextHash(context),
    };
    const cached = await classpilotStudentDataProvisionalCache.getOrCompute({
      binding,
      ttlSeconds: provisionalCacheTtlSeconds({
        candidate,
        now: options.now,
        retentionCutoff: options.retentionCutoff,
      }),
      compute: async () => {
        const studentIds = context.roster.map((row) => row.studentId);
        const heartbeatRows = studentIds.length === 0
          ? []
          : await getHeartbeatsForStudentsInRange(
              options.schoolId,
              studentIds,
              windowStart,
              windowEnd,
              options.dbInstance
            );
        const input: ClasspilotSessionReportInput = {
          ...context,
          heartbeats: heartbeatRows,
        };
        const computedRows: ClasspilotStudentDataCachedRow[] = materializeStudents(
          reportForRead,
          input
        ).map((student) => ({
          teachingSessionId: candidate.session.id,
          studentId: student.studentId,
          localDate,
          totalSeconds: student.observedSeconds,
          heartbeatCount: student.heartbeatCount,
          topDomains: student.topDomains,
          topActivities: student.topActivities,
          computedAt: windowEnd,
        }));
        return { rows: computedRows, asOf: windowEnd };
      },
    });
    if (!asOf || cached.asOf < asOf) asOf = cached.asOf;
    for (const row of cached.rows) {
      if (!storedKeys.has(usageKey(row))) rows.push(row);
    }
  }
  return { rows, asOf };
}

export async function getClasspilotStudentData(options: {
  schoolId: string;
  actorId: string;
  role: ClasspilotStudentDataRole;
  period: ClasspilotStudentDataPeriod;
  scope?: ClasspilotStudentDataScopeKind;
  groupId?: string;
  sessionId?: string;
  studentId?: string;
  schoolTimeZone?: string | null;
  now?: Date;
  dbInstance?: typeof db;
}) {
  const dbInstance = options.dbInstance || db;
  const now = options.now || new Date();
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    let schoolTimeZone = options.schoolTimeZone || null;
    if (!schoolTimeZone) {
      const [school] = await transactionDb
        .select({ timeZone: schools.schoolTimezone })
        .from(schools)
        .where(eq(schools.id, options.schoolId))
        .limit(1);
      schoolTimeZone = school?.timeZone || "America/New_York";
    }
    const authority = await loadStudentDataAuthorityWindow({
      schoolId: options.schoolId,
      now,
      dbInstance: transactionDb,
    });
    const selection = await resolveStudentDataSelection({
      schoolId: options.schoolId,
      actorId: options.actorId,
      role: options.role,
      scope: options.scope,
      groupId: options.groupId,
      sessionId: options.sessionId,
      authority,
      dbInstance: transactionDb,
    });
    const window = resolveClasspilotStudentDataWindow({
      period: options.period,
      timeZone: schoolTimeZone,
      now,
      session: selection.session,
    });
    let identities = await loadScopedIdentities({
      schoolId: options.schoolId,
      actorId: options.actorId,
      role: options.role,
      selection,
      rangeStart: window.rangeStart,
      rangeEnd: window.rangeEnd,
      authority,
      dbInstance: transactionDb,
    });
    if (options.studentId) {
      const selected = identities.find((identity) => identity.studentId === options.studentId);
      if (!selected) scopeNotFound();
      identities = [selected];
    }
    const studentIds = identities.map((identity) => identity.studentId);
    const [storedUsage, storedSessionModes, candidates] = await Promise.all([
      loadAggregatedStoredUsage({
        schoolId: options.schoolId,
        actorId: options.actorId,
        role: options.role,
        selection,
        startLocalDate: window.startLocalDate,
        endLocalDate: window.endLocalDate,
        studentIds,
        authority,
        dbInstance: transactionDb,
      }),
      loadScopeSessionModes({
        schoolId: options.schoolId,
        actorId: options.actorId,
        role: options.role,
        selection,
        startLocalDate: window.startLocalDate,
        endLocalDate: window.endLocalDate,
        studentIds,
        authority,
        dbInstance: transactionDb,
      }),
      loadProvisionalSessions({
        schoolId: options.schoolId,
        actorId: options.actorId,
        role: options.role,
        selection,
        rangeStart: window.rangeStart,
        rangeEnd: window.rangeEnd,
        authority,
        dbInstance: transactionDb,
      }),
    ]);
    if (candidates.some((candidate) => candidate.state === "unavailable")) {
      throw new ClasspilotStudentDataUnavailableError();
    }
    const provisionalUsage = await materializeReadOnlyProvisionalUsage({
      schoolId: options.schoolId,
      timeZone: window.timeZone,
      periodWindow: window,
      sessionSpecific: !!selection.session,
      candidates,
      now,
      retentionCutoff: authority.retentionCutoff,
      dbInstance: transactionDb,
    });
    const dataState: ClasspilotStudentDataState = candidates.some((candidate) => candidate.state === "live")
      ? "live"
      : candidates.some((candidate) => candidate.state === "finalizing")
        ? "finalizing"
        : "final";
    return buildClasspilotStudentDataResponse({
      period: options.period,
      sessionId: selection.session?.id,
      selectedStudentId: options.studentId,
      scope: selection.scope,
      dataState,
      monitoringCoverage: resolveMonitoringCoverage(storedSessionModes, candidates),
      provisionalAsOf: dataState === "final" ? null : provisionalUsage.asOf,
      timeZone: window.timeZone,
      startLocalDate: window.startLocalDate,
      endLocalDate: window.endLocalDate,
      rangeStart: window.rangeStart,
      rangeEnd: window.rangeEnd,
      generatedAt: now,
      identities,
      usageRows: [...storedUsage, ...provisionalUsage.rows],
    });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
