import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../db.js";
import { users, schools, schoolMemberships } from "../schema/core.js";
import { students } from "../schema/students.js";
import {
  dailyUsage,
  devices,
  groups,
  groupStudents,
  heartbeats,
  teachingSessions,
  classpilotSessionUsage,
} from "../schema/classpilot.js";
import {
  resolveSchoolLocalPeriod,
  utcTimestampForSql,
  type SchoolLocalPeriod,
} from "../util/schoolTime.js";

type AttributionMode = "roster" | "session";

type TopDomain = {
  domain: string;
  seconds: number;
  visits: number;
};

type ClassUsageAccumulator = {
  totalSeconds: number;
  activeStudentIds: Set<string>;
};

export { resolveSchoolLocalPeriod };

function addDomain(map: Map<string, TopDomain>, domain: string | null, seconds: number, visits: number) {
  if (!domain) return;
  const cleaned = domain.replace(/^www\./, "");
  const existing = map.get(cleaned) || { domain: cleaned, seconds: 0, visits: 0 };
  existing.seconds += Number(seconds) || 0;
  existing.visits += Number(visits) || 0;
  map.set(cleaned, existing);
}

function addTopDomains(map: Map<string, TopDomain>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { domain?: unknown; seconds?: unknown; visits?: unknown };
    if (typeof row.domain !== "string") continue;
    addDomain(map, row.domain, Number(row.seconds) || 0, Number(row.visits) || 0);
  }
}

function toTopWebsiteList(map: Map<string, TopDomain>) {
  return Array.from(map.values())
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 10)
    .map((row) => ({
      domain: row.domain,
      minutes: Math.round(row.seconds / 60),
      visits: row.visits,
    }));
}

function hasCompletedDates(period: SchoolLocalPeriod): period is SchoolLocalPeriod & {
  completedStartDate: string;
  completedEndDate: string;
} {
  return !!period.completedStartDate && !!period.completedEndDate;
}

async function getSchoolTimezone(schoolId: string): Promise<string> {
  const [school] = await db
    .select({ schoolTimezone: schools.schoolTimezone })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);
  return school?.schoolTimezone || "America/New_York";
}

export async function getClasspilotAdminAnalyticsSummary(
  schoolId: string,
  requestedPeriod: string | undefined,
  options: { now?: Date } = {}
) {
  const timezone = await getSchoolTimezone(schoolId);
  const period = resolveSchoolLocalPeriod(requestedPeriod, timezone, options.now);
  const currentDayStartSql = utcTimestampForSql(period.currentDayStartUtc);
  const rangeStartSql = utcTimestampForSql(period.rangeStartUtc);
  const rangeEndSql = utcTimestampForSql(period.rangeEndUtc);

  const completedRows = hasCompletedDates(period)
    ? await db
        .select({
          studentId: dailyUsage.studentId,
          totalSeconds: dailyUsage.totalSeconds,
          topDomains: dailyUsage.topDomains,
        })
        .from(dailyUsage)
        .where(
          and(
            eq(dailyUsage.schoolId, schoolId),
            sql`${dailyUsage.date} >= ${period.completedStartDate}`,
            sql`${dailyUsage.date} <= ${period.completedEndDate}`
          )
        )
    : [];

  const [todayTotal] = await db
    .select({
      totalSeconds: sql<number>`(COUNT(*) * 10)::int`,
    })
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        sql`${heartbeats.timestamp} >= ${currentDayStartSql}`,
        sql`${heartbeats.timestamp} < ${rangeEndSql}`
      )
    );

  const todayStudents = await db
    .select({ studentId: heartbeats.studentId })
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        sql`${heartbeats.studentId} IS NOT NULL`,
        sql`${heartbeats.timestamp} >= ${currentDayStartSql}`,
        sql`${heartbeats.timestamp} < ${rangeEndSql}`
      )
    )
    .groupBy(heartbeats.studentId);

  const todayDomains = await db
    .select({
      domain: sql<string>`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)')`,
      seconds: sql<number>`(COUNT(*) * 10)::int`,
      visits: sql<number>`COUNT(*)::int`,
    })
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        sql`${heartbeats.activeTabUrl} IS NOT NULL`,
        sql`${heartbeats.timestamp} >= ${currentDayStartSql}`,
        sql`${heartbeats.timestamp} < ${rangeEndSql}`
      )
    )
    .groupBy(sql`SUBSTRING(${heartbeats.activeTabUrl} FROM '://([^/]+)')`);

  const hourlyRows = await db
    .select({
      hour: sql<number>`EXTRACT(HOUR FROM (${heartbeats.timestamp} AT TIME ZONE 'UTC' AT TIME ZONE ${period.timeZone}))::int`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(heartbeats)
    .where(
      and(
        eq(heartbeats.schoolId, schoolId),
        sql`${heartbeats.timestamp} >= ${rangeStartSql}`,
        sql`${heartbeats.timestamp} < ${rangeEndSql}`
      )
    )
    .groupBy(sql`1`);

  const [studentCount, teacherCount, deviceCount] = await Promise.all([
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(students)
      .where(eq(students.schoolId, schoolId)),
    db
      .select({ count: sql<number>`COUNT(DISTINCT ${schoolMemberships.userId})::int` })
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.schoolId, schoolId),
          eq(schoolMemberships.status, "active"),
          inArray(schoolMemberships.role, ["admin", "school_admin", "teacher"])
        )
      ),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(devices)
      .where(eq(devices.schoolId, schoolId)),
  ]);

  const activeStudentIds = new Set<string>();
  const domains = new Map<string, TopDomain>();
  let completedSeconds = 0;

  for (const row of completedRows) {
    completedSeconds += Number(row.totalSeconds) || 0;
    if (row.studentId) activeStudentIds.add(row.studentId);
    addTopDomains(domains, row.topDomains);
  }
  for (const row of todayStudents) {
    if (row.studentId) activeStudentIds.add(row.studentId);
  }
  for (const row of todayDomains) addDomain(domains, row.domain, row.seconds, row.visits);

  const hourlyCounts = Array<number>(24).fill(0);
  for (const row of hourlyRows) {
    const hour = Number(row.hour);
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
      hourlyCounts[hour] = Number(row.count) || 0;
    }
  }
  const hourlyActivity = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hourlyCounts[hour] || 0,
  }));

  return {
    period,
    summary: {
      activeStudents: activeStudentIds.size,
      totalStudents: Number(studentCount[0]?.count) || 0,
      totalDevices: Number(deviceCount[0]?.count) || 0,
      totalBrowsingMinutes: Math.round((completedSeconds + (Number(todayTotal?.totalSeconds) || 0)) / 60),
      totalTeachers: Number(teacherCount[0]?.count) || 0,
    },
    hourlyActivity,
    topWebsites: toTopWebsiteList(domains),
  };
}

export async function getClasspilotAdminAnalyticsByTeacher(
  schoolId: string,
  requestedPeriod: string | undefined,
  options: { now?: Date } = {}
) {
  const timezone = await getSchoolTimezone(schoolId);
  const period = resolveSchoolLocalPeriod(requestedPeriod || "7d", timezone, options.now);
  const rangeStartSql = utcTimestampForSql(period.rangeStartUtc);
  const rangeEndSql = utcTimestampForSql(period.rangeEndUtc);

  const rows = await db
    .select({
      id: teachingSessions.teacherId,
      name: users.displayName,
      email: users.email,
      sessionCount: sql<number>`COUNT(DISTINCT ${teachingSessions.id})::int`,
      totalSessionMinutes: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (
        LEAST(COALESCE(${teachingSessions.endTime}, ${rangeEndSql}), ${rangeEndSql})
        - GREATEST(${teachingSessions.startTime}, ${rangeStartSql})
      )) / 60)::int, 0)`,
      groupCount: sql<number>`COUNT(DISTINCT ${teachingSessions.groupId})::int`,
    })
    .from(teachingSessions)
    .innerJoin(groups, eq(teachingSessions.groupId, groups.id))
    .innerJoin(users, eq(users.id, teachingSessions.teacherId))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active"),
        sql`${teachingSessions.startTime} < ${rangeEndSql}`,
        sql`COALESCE(${teachingSessions.endTime}, ${rangeEndSql}) >= ${rangeStartSql}`
      )
    )
    .groupBy(teachingSessions.teacherId, users.displayName, users.email);

  return {
    period,
    teachers: rows.map((row) => ({
      id: row.id,
      name: row.name || row.email || "Unknown",
      email: row.email || "",
      sessionCount: Number(row.sessionCount) || 0,
      totalSessionMinutes: Math.max(0, Number(row.totalSessionMinutes) || 0),
      groupCount: Number(row.groupCount) || 0,
    })),
  };
}

async function getOfficialClassRows(schoolId: string) {
  return db
    .select({
      groupId: groups.id,
      groupName: groups.name,
      periodLabel: groups.periodLabel,
      gradeLevel: groups.gradeLevel,
      teacherDisplayName: users.displayName,
      teacherEmail: users.email,
      studentCount: sql<number>`COUNT(DISTINCT ${groupStudents.studentId})::int`,
    })
    .from(groups)
    .innerJoin(users, eq(users.id, groups.teacherId))
    .leftJoin(groupStudents, eq(groupStudents.groupId, groups.id))
    .where(and(eq(groups.schoolId, schoolId), eq(groups.groupType, "admin_class"), eq(groups.status, "active")))
    .groupBy(groups.id, groups.name, groups.periodLabel, groups.gradeLevel, users.displayName, users.email);
}

function ensureClassUsage(map: Map<string, ClassUsageAccumulator>, groupId: string): ClassUsageAccumulator {
  const existing = map.get(groupId) || { totalSeconds: 0, activeStudentIds: new Set<string>() };
  map.set(groupId, existing);
  return existing;
}

async function getRosterModeUsage(schoolId: string, period: SchoolLocalPeriod) {
  const map = new Map<string, ClassUsageAccumulator>();
  const currentDayStartSql = utcTimestampForSql(period.currentDayStartUtc);
  const rangeEndSql = utcTimestampForSql(period.rangeEndUtc);

  if (hasCompletedDates(period)) {
    const completed = await db
      .select({
        groupId: groups.id,
        studentId: dailyUsage.studentId,
        totalSeconds: sql<number>`COALESCE(SUM(${dailyUsage.totalSeconds}), 0)::int`,
      })
      .from(groups)
      .innerJoin(groupStudents, eq(groupStudents.groupId, groups.id))
      .innerJoin(
        dailyUsage,
        and(
          eq(dailyUsage.studentId, groupStudents.studentId),
          eq(dailyUsage.schoolId, schoolId),
          sql`${dailyUsage.date} >= ${period.completedStartDate}`,
          sql`${dailyUsage.date} <= ${period.completedEndDate}`
        )
      )
      .where(and(eq(groups.schoolId, schoolId), eq(groups.groupType, "admin_class"), eq(groups.status, "active")))
      .groupBy(groups.id, dailyUsage.studentId);

    for (const row of completed) {
      const usage = ensureClassUsage(map, row.groupId);
      usage.totalSeconds += Number(row.totalSeconds) || 0;
      if (row.studentId) usage.activeStudentIds.add(row.studentId);
    }
  }

  const today = await db
    .select({
      groupId: groups.id,
      studentId: heartbeats.studentId,
      totalSeconds: sql<number>`(COUNT(*) * 10)::int`,
    })
    .from(groups)
    .innerJoin(groupStudents, eq(groupStudents.groupId, groups.id))
    .innerJoin(
      heartbeats,
      and(
        eq(heartbeats.studentId, groupStudents.studentId),
        eq(heartbeats.schoolId, schoolId),
        sql`${heartbeats.timestamp} >= ${currentDayStartSql}`,
        sql`${heartbeats.timestamp} < ${rangeEndSql}`
      )
    )
    .where(and(eq(groups.schoolId, schoolId), eq(groups.groupType, "admin_class"), eq(groups.status, "active")))
    .groupBy(groups.id, heartbeats.studentId);

  for (const row of today) {
    const usage = ensureClassUsage(map, row.groupId);
    usage.totalSeconds += Number(row.totalSeconds) || 0;
    if (row.studentId) usage.activeStudentIds.add(row.studentId);
  }

  return map;
}

async function getSessionModeUsage(schoolId: string, period: SchoolLocalPeriod) {
  const map = new Map<string, ClassUsageAccumulator>();
  const rows = await db
    .select({
      groupId: classpilotSessionUsage.groupId,
      studentId: classpilotSessionUsage.studentId,
      totalSeconds: sql<number>`COALESCE(SUM(${classpilotSessionUsage.totalSeconds}), 0)::int`,
    })
    .from(classpilotSessionUsage)
    .innerJoin(groups, eq(groups.id, classpilotSessionUsage.groupId))
    .where(
      and(
        eq(classpilotSessionUsage.schoolId, schoolId),
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active"),
        sql`${classpilotSessionUsage.localDate} >= ${period.startLocalDate}`,
        sql`${classpilotSessionUsage.localDate} <= ${period.todayLocalDate}`
      )
    )
    .groupBy(classpilotSessionUsage.groupId, classpilotSessionUsage.studentId);

  for (const row of rows) {
    const usage = ensureClassUsage(map, row.groupId);
    usage.totalSeconds += Number(row.totalSeconds) || 0;
    if (row.studentId) usage.activeStudentIds.add(row.studentId);
  }

  return map;
}

export async function getClasspilotAdminAnalyticsByGroup(
  schoolId: string,
  requestedPeriod: string | undefined,
  options: { now?: Date; attributionMode?: AttributionMode } = {}
) {
  const timezone = await getSchoolTimezone(schoolId);
  const period = resolveSchoolLocalPeriod(requestedPeriod || "7d", timezone, options.now);
  const attributionMode = options.attributionMode || "session";
  const [classRows, usageMap] = await Promise.all([
    getOfficialClassRows(schoolId),
    attributionMode === "roster" ? getRosterModeUsage(schoolId, period) : getSessionModeUsage(schoolId, period),
  ]);

  const rowsForResponse = attributionMode === "session"
    ? classRows.filter((row) => usageMap.has(row.groupId))
    : classRows;

  const groupsList = rowsForResponse.map((row) => {
    const usage = usageMap.get(row.groupId) || { totalSeconds: 0, activeStudentIds: new Set<string>() };
    const totalMinutes = Math.round(usage.totalSeconds / 60);
    const activeStudentCount = usage.activeStudentIds.size;
    return {
      groupId: row.groupId,
      groupName: row.groupName,
      periodLabel: row.periodLabel,
      gradeLevel: row.gradeLevel,
      teacherName: row.teacherDisplayName || row.teacherEmail || "Unknown",
      studentCount: Number(row.studentCount) || 0,
      activeStudentCount,
      totalBrowsingMinutes: totalMinutes,
      avgMinutesPerStudent: activeStudentCount > 0 ? Math.round(totalMinutes / activeStudentCount) : 0,
    };
  });

  groupsList.sort((a, b) => b.totalBrowsingMinutes - a.totalBrowsingMinutes || a.groupName.localeCompare(b.groupName));
  return { period, attributionMode, groups: groupsList };
}
