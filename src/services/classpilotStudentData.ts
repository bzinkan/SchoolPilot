import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import db from "../db.js";
import { schools } from "../schema/core.js";
import {
  classpilotSessionStudents,
  classpilotSessionUsage,
  teachingSessions,
} from "../schema/classpilot.js";
import { students } from "../schema/students.js";
import {
  addLocalDays,
  localDateInTimeZone,
  localDateStartUtc,
} from "../util/schoolTime.js";

export type ClasspilotStudentDataPeriod = "today" | "week" | "month" | "year";

type StudentIdentity = {
  studentId: string;
  name: string;
};

type StoredUsageRow = {
  studentId: string;
  totalSeconds: number;
  heartbeatCount: number;
  topDomains: unknown;
  computedAt: Date;
};

type StudentAccumulator = StudentIdentity & {
  monitoredSeconds: number;
  heartbeatCount: number;
  domains: Map<string, number>;
};

export class ClasspilotStudentDataNotFoundError extends Error {
  readonly code: "CLASSPILOT_SESSION_NOT_FOUND" | "CLASSPILOT_STUDENT_NOT_FOUND";

  constructor(code: ClasspilotStudentDataNotFoundError["code"], message: string) {
    super(message);
    this.name = "ClasspilotStudentDataNotFoundError";
    this.code = code;
  }
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
  session?: { startTime: Date; endTime: Date | null; timezoneSnapshot: string | null };
}) {
  const timeZone = options.session?.timezoneSnapshot || options.timeZone || "America/New_York";
  if (options.session) {
    const end = options.session.endTime && options.session.endTime < options.now
      ? options.session.endTime
      : options.now;
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

export function buildClasspilotStudentDataResponse(options: {
  period: ClasspilotStudentDataPeriod;
  sessionId?: string;
  selectedStudentId?: string;
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
    }])
  );

  for (const row of options.usageRows) {
    const accumulator = accumulators.get(row.studentId);
    if (!accumulator) continue;
    const totalSeconds = nonnegativeInteger(row.totalSeconds);
    accumulator.monitoredSeconds += totalSeconds;
    accumulator.heartbeatCount += nonnegativeInteger(row.heartbeatCount);
    for (const domain of storedDomains(row.topDomains, totalSeconds)) {
      accumulator.domains.set(
        domain.domain,
        (accumulator.domains.get(domain.domain) || 0) + domain.seconds
      );
    }
  }

  const allDomainTotals = new Map<string, number>();
  for (const accumulator of accumulators.values()) {
    for (const [domain, seconds] of accumulator.domains) {
      allDomainTotals.set(domain, (allDomainTotals.get(domain) || 0) + seconds);
    }
  }

  const summaries = [...accumulators.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.studentId.localeCompare(right.studentId))
    .map((student) => {
      const domains = sortedBoundedDomains(student.domains, student.monitoredSeconds);
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
      };
    });
  const monitoredSeconds = summaries.reduce((sum, student) => sum + student.monitoredSeconds, 0);
  const topDomains = sortedBoundedDomains(allDomainTotals, monitoredSeconds).slice(0, 10);
  const selectedStudent = options.selectedStudentId
    ? summaries.find((student) => student.studentId === options.selectedStudentId) ?? null
    : null;
  const revisionInput = {
    schemaVersion: 1,
    period: options.period,
    sessionId: options.sessionId ?? null,
    selectedStudentId: options.selectedStudentId ?? null,
    timeZone: options.timeZone,
    startLocalDate: options.startLocalDate,
    endLocalDate: options.endLocalDate,
    monitoredSeconds,
    topDomains,
    students: summaries,
  };
  const revision = `student-data-v1:${createHash("sha256")
    .update(JSON.stringify(revisionInput))
    .digest("base64url")
    .slice(0, 32)}`;

  return {
    schemaVersion: 1,
    revision,
    period: options.period,
    sessionId: options.sessionId ?? null,
    generatedAt: options.generatedAt.toISOString(),
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
    studentCount: summaries.length,
    monitoredSeconds,
    topDomains,
    students: summaries,
    student: selectedStudent,
  };
}

export async function getClasspilotStudentData(options: {
  schoolId: string;
  period: ClasspilotStudentDataPeriod;
  sessionId?: string;
  studentId?: string;
  schoolTimeZone?: string | null;
  now?: Date;
  dbInstance?: typeof db;
}) {
  const dbInstance = options.dbInstance || db;
  const now = options.now || new Date();
  let schoolTimeZone = options.schoolTimeZone || null;
  if (!schoolTimeZone) {
    const [school] = await dbInstance
      .select({ timeZone: schools.schoolTimezone })
      .from(schools)
      .where(eq(schools.id, options.schoolId))
      .limit(1);
    schoolTimeZone = school?.timeZone || "America/New_York";
  }

  let session: {
    id: string;
    startTime: Date;
    endTime: Date | null;
    timezoneSnapshot: string | null;
  } | undefined;
  let identities: StudentIdentity[];
  if (options.sessionId) {
    [session] = await dbInstance
      .select({
        id: teachingSessions.id,
        startTime: teachingSessions.startTime,
        endTime: teachingSessions.endTime,
        timezoneSnapshot: teachingSessions.timezoneSnapshot,
      })
      .from(teachingSessions)
      .where(and(
        eq(teachingSessions.id, options.sessionId),
        eq(teachingSessions.schoolId, options.schoolId)
      ))
      .limit(1);
    if (!session) {
      throw new ClasspilotStudentDataNotFoundError(
        "CLASSPILOT_SESSION_NOT_FOUND",
        "Teaching session not found"
      );
    }
    const roster = await dbInstance
      .select({
        studentId: classpilotSessionStudents.studentId,
        studentNameSnapshot: classpilotSessionStudents.studentNameSnapshot,
        firstName: students.firstName,
        lastName: students.lastName,
      })
      .from(classpilotSessionStudents)
      .leftJoin(students, and(
        eq(students.id, classpilotSessionStudents.studentId),
        eq(students.schoolId, options.schoolId)
      ))
      .where(and(
        eq(classpilotSessionStudents.schoolId, options.schoolId),
        eq(classpilotSessionStudents.teachingSessionId, options.sessionId)
      ))
      .orderBy(asc(classpilotSessionStudents.studentId));
    identities = roster.map((row) => ({
      studentId: row.studentId,
      name: row.studentNameSnapshot
        || [row.firstName, row.lastName].filter(Boolean).join(" ")
        || "Unknown student",
    }));
  } else {
    identities = await dbInstance
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
      })));
  }

  if (options.studentId) {
    const selected = identities.find((identity) => identity.studentId === options.studentId);
    if (!selected) {
      throw new ClasspilotStudentDataNotFoundError(
        "CLASSPILOT_STUDENT_NOT_FOUND",
        "Student not found"
      );
    }
    identities = [selected];
  }

  const window = resolveClasspilotStudentDataWindow({
    period: options.period,
    timeZone: schoolTimeZone,
    now,
    session,
  });
  const usageConditions = [eq(classpilotSessionUsage.schoolId, options.schoolId)];
  if (options.sessionId) {
    usageConditions.push(eq(classpilotSessionUsage.teachingSessionId, options.sessionId));
  } else {
    usageConditions.push(
      gte(classpilotSessionUsage.localDate, window.startLocalDate),
      lte(classpilotSessionUsage.localDate, window.endLocalDate)
    );
  }
  if (identities.length > 0) {
    usageConditions.push(inArray(
      classpilotSessionUsage.studentId,
      identities.map((identity) => identity.studentId)
    ));
  }
  const usageRows: StoredUsageRow[] = identities.length === 0
    ? []
    : await dbInstance
      .select({
        studentId: classpilotSessionUsage.studentId,
        totalSeconds: classpilotSessionUsage.totalSeconds,
        heartbeatCount: classpilotSessionUsage.heartbeatCount,
        topDomains: classpilotSessionUsage.topDomains,
        computedAt: classpilotSessionUsage.computedAt,
      })
      .from(classpilotSessionUsage)
      .where(and(...usageConditions))
      .orderBy(
        asc(classpilotSessionUsage.studentId),
        asc(classpilotSessionUsage.localDate),
        asc(classpilotSessionUsage.teachingSessionId)
      );

  return buildClasspilotStudentDataResponse({
    period: options.period,
    sessionId: options.sessionId,
    selectedStudentId: options.studentId,
    timeZone: window.timeZone,
    startLocalDate: window.startLocalDate,
    endLocalDate: window.endLocalDate,
    rangeStart: window.rangeStart,
    rangeEnd: window.rangeEnd,
    generatedAt: now,
    identities,
    usageRows,
  });
}
