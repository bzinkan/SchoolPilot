import { sql, type SQL } from "drizzle-orm";
import db from "../db.js";
import { localDateInTimeZone, resolveSchoolLocalPeriod, utcTimestampForSql, type SchoolLocalPeriod } from "../util/schoolTime.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import { coerceSchedulerTimestamp } from "../util/schedulerTimestamp.js";

type Options = { now?: Date; page?: number };
type Context = {
  schoolId: string;
  now: Date;
  period: SchoolLocalPeriod;
  cutoff: Date;
  range: { timeZone: string; retainedFrom: string; partiallyRetained: boolean; asOf: string };
};
type ReportCounts = { completed: number; ready: number; preparing: number; failed: number; unavailable: number };

async function context(schoolId: string, requestedPeriod: string | undefined, options: Options): Promise<Context> {
  const [school] = (await db.execute<{ school_timezone: string | null; retention_hours: string | null }>(sql`
    SELECT s.school_timezone,p.retention_hours FROM schools s
    LEFT JOIN settings p ON p.school_id=s.id WHERE s.id=${schoolId}
  `)).rows;
  if (!school) throw Object.assign(new Error("School not found"), { status: 404 });
  const now = options.now ?? new Date();
  const period = resolveSchoolLocalPeriod(requestedPeriod ?? "7d", school.school_timezone, now);
  const cutoff = new Date(now.getTime() - parseClasspilotRetentionDays(school.retention_hours) * 86_400_000);
  return { schoolId,now,period,cutoff,range:{timeZone:period.timeZone,retainedFrom:localDateInTimeZone(cutoff,period.timeZone),partiallyRetained:period.rangeStartUtc<cutoff,asOf:now.toISOString()} };
}

/** A read-only cohort. Retrying generation stays preparing; expiry is never a failure. */
function completed(c: Context): SQL {
  return sql`completed AS (
    SELECT s.id,s.group_id,s.teacher_id,s.session_mode,s.start_time,s.end_time,
      COALESCE(NULLIF(s.class_name_snapshot,''),g.name,'Class') AS class_name,
      COALESCE(NULLIF(staff.staff_name_snapshot,''),NULLIF(s.scheduled_teacher_name,''),NULLIF(u.display_name,''),NULLIF(concat_ws(' ',u.first_name,u.last_name),''),'Unknown teacher') AS teacher_name,
      CASE WHEN r.id IS NULL OR r.state='expired' OR r.expires_at<=${c.now.toISOString()}::timestamptz OR r.detail_expired_at IS NOT NULL THEN 'unavailable'
        WHEN r.state='ready' THEN 'ready' WHEN r.state IN ('pending','materializing') THEN 'preparing'
        WHEN r.state='failed' THEN 'failed' ELSE 'unavailable' END AS report_state,
      r.id AS report_id,r.attempt_count,r.updated_at AS failed_at,r.total_eligible_seconds,r.total_observed_seconds,
      r.partial_count,r.none_count,r.not_expected_count,r.unavailable_count
    FROM teaching_sessions s
    LEFT JOIN classpilot_session_reports r ON r.school_id=${c.schoolId} AND r.teaching_session_id=s.id
    LEFT JOIN groups g ON g.school_id=${c.schoolId} AND g.id=s.group_id
    LEFT JOIN users u ON u.id=s.teacher_id
    LEFT JOIN classpilot_session_staff staff ON staff.school_id=${c.schoolId} AND staff.teaching_session_id=s.id AND staff.staff_id=s.teacher_id AND staff.role='primary'
    WHERE s.school_id=${c.schoolId} AND s.end_time IS NOT NULL
      AND s.end_time>=${utcTimestampForSql(c.period.rangeStartUtc)}::timestamp
      AND s.end_time<${utcTimestampForSql(c.now)}::timestamp
      AND s.end_time>${utcTimestampForSql(c.cutoff)}::timestamp
      AND s.session_mode IN ('live','scheduled_report')
      AND (s.scheduled_state IS NULL OR s.scheduled_state<>'skipped')
  )`;
}

function activeClasses(c: Context): SQL {
  return sql`active_classes AS (
    SELECT g.id,g.name,COALESCE(NULLIF(u.display_name,''),NULLIF(concat_ws(' ',u.first_name,u.last_name),''),'Unknown teacher') AS teacher_name
    FROM groups g LEFT JOIN users u ON u.id=g.teacher_id
    WHERE g.school_id=${c.schoolId} AND g.group_type='admin_class' AND g.status='active'
  )`;
}

function readyObservations(c: Context): SQL {
  // The end-selected cohort owns the whole stored report, including observations
  // before midnight. Legacy usage rows have independent start-date cleanup.
  return sql`ready_observations AS (
    SELECT c.group_id,u.student_id,(c.end_time AT TIME ZONE 'UTC' AT TIME ZONE ${c.period.timeZone})::date AS local_date,
      u.last_observed_at AS last_seen FROM classpilot_session_student_reports u
    JOIN completed c ON c.id=u.teaching_session_id AND c.report_id=u.report_id AND c.report_state='ready'
    WHERE u.school_id=${c.schoolId} AND u.observed_seconds>0
  )`;
}

function publicContext(c: Context) { return { period:c.period,range:c.range,basis:"completed_sessions" as const }; }

function isoTimestamp(value: Date|string): string {
  // PostgreSQL's text timestamp parser can emit an hour-only offset (+00).
  const normalized = typeof value === "string" ? value.replace(/([+-]\d{2})$/, "$1:00") : value;
  const parsed = coerceSchedulerTimestamp(normalized);
  if (!parsed) throw new Error("Invalid reporting timestamp");
  return parsed.toISOString();
}

async function reportCounts(c: Context): Promise<ReportCounts> {
  const [row] = (await db.execute<ReportCounts>(sql`WITH ${completed(c)} SELECT
    count(*)::int AS completed,count(*) FILTER(WHERE report_state='ready')::int AS ready,
    count(*) FILTER(WHERE report_state='preparing')::int AS preparing,
    count(*) FILTER(WHERE report_state='failed')::int AS failed,
    count(*) FILTER(WHERE report_state='unavailable')::int AS unavailable FROM completed`)).rows;
  return row!;
}

type ClassRow = { groupId:string; groupName:string; teacherName:string; sessionCount:number; readySummaryCount:number; days:number; observedStudents:number; lastObservedAt:Date|string|null };
export async function getClasspilotAdoptionOverview(schoolId: string, period?: string, options: Options = {}) {
  const c = await context(schoolId,period,options);
  const [classResult, totals, states] = await Promise.all([
    db.execute<ClassRow>(sql`WITH ${completed(c)},${activeClasses(c)},${readyObservations(c)},
      sessions AS (SELECT group_id,count(*)::int AS n,count(*) FILTER(WHERE report_state='ready')::int AS ready FROM completed GROUP BY group_id),
      observations AS (SELECT group_id,count(DISTINCT local_date)::int AS days,count(DISTINCT student_id)::int AS students,max(last_seen) AS last_seen FROM ready_observations GROUP BY group_id)
      SELECT a.id AS "groupId",a.name AS "groupName",a.teacher_name AS "teacherName",COALESCE(s.n,0)::int AS "sessionCount",
        COALESCE(s.ready,0)::int AS "readySummaryCount",COALESCE(o.days,0)::int AS days,COALESCE(o.students,0)::int AS "observedStudents",o.last_seen AS "lastObservedAt"
      FROM active_classes a LEFT JOIN sessions s ON s.group_id=a.id LEFT JOIN observations o ON o.group_id=a.id ORDER BY a.name,a.id`),
    db.execute<{ observed:number; teachers:number; enrolled:number }>(sql`WITH ${completed(c)},${activeClasses(c)},${readyObservations(c)} SELECT
      (SELECT count(DISTINCT u.student_id)::int FROM ready_observations u JOIN active_classes a ON a.id=u.group_id) AS observed,
      (SELECT count(DISTINCT c.teacher_id)::int FROM completed c JOIN active_classes a ON a.id=c.group_id WHERE c.session_mode='live') AS teachers,
      (SELECT count(*)::int FROM students WHERE school_id=${c.schoolId} AND status='active') AS enrolled`),
    reportCounts(c),
  ]);
  const classes = classResult.rows.map(row => {
    const measurable = (row.sessionCount===0 && !c.range.partiallyRetained) || row.readySummaryCount>0;
    return {groupId:row.groupId,groupName:row.groupName,teacherName:row.teacherName,sessionCount:row.sessionCount,readySummaryCount:row.readySummaryCount,
      observedStudentCount:measurable ? row.observedStudents : null,daysWithObservations:measurable ? row.days : null,lastObservedAt:row.lastObservedAt ? isoTimestamp(row.lastObservedAt) : null};
  });
  const completedSessions = classes.reduce((total,row) => total+row.sessionCount,0);
  const readySummaries = classes.reduce((total,row) => total+row.readySummaryCount,0);
  const measurable = (completedSessions===0 && !c.range.partiallyRetained) || readySummaries>0;
  const dataState = !measurable ? "unavailable" : completedSessions===0 ? "empty" : readySummaries<completedSessions || c.range.partiallyRetained ? "partial" : "available";
  return {...publicContext(c),dataState,reportCounts:states,summary:{totalClasses:classes.length,classesWithObservations:measurable ? classes.filter(row=>(row.observedStudentCount ?? 0)>0).length : null,
    studentsObserved:measurable ? totals.rows[0]!.observed : null,totalStudents:totals.rows[0]!.enrolled,teachersWithLiveSessions:totals.rows[0]!.teachers,completedSessions,readySummaries},classes};
}

type FailureRow = { teachingSessionId:string; groupId:string; className:string; teacherName:string; windowStart:Date|string; windowEnd:Date|string; failedAt:Date|string; attemptCount:number };
export async function getClasspilotAdoptionFailures(schoolId: string, period?: string, options: Options = {}) {
  const c = await context(schoolId,period,options);
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page<1 || page>1_000_000) throw Object.assign(new Error("Invalid failure page"),{status:400});
  const pageSize = 20;
  const [total, result] = await Promise.all([
    db.execute<{total:number}>(sql`WITH ${completed(c)} SELECT count(*)::int AS total FROM completed WHERE report_state='failed'`),
    db.execute<FailureRow>(sql`WITH ${completed(c)} SELECT id AS "teachingSessionId",group_id AS "groupId",class_name AS "className",teacher_name AS "teacherName",
      start_time AT TIME ZONE 'UTC' AS "windowStart",end_time AT TIME ZONE 'UTC' AS "windowEnd",failed_at AS "failedAt",attempt_count AS "attemptCount"
      FROM completed WHERE report_state='failed' ORDER BY failed_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`),
  ]);
  return {...publicContext(c),total:total.rows[0]!.total,page,pageSize,failures:result.rows.map(row=>({...row,windowStart:isoTimestamp(row.windowStart),windowEnd:isoTimestamp(row.windowEnd),failedAt:isoTimestamp(row.failedAt),reason:"Session summary could not be generated."}))};
}

function coverage(observed: number, eligible: number): number|null { return eligible>0 ? Math.round(Number(observed)/Number(eligible)*1000)/10 : null; }
type AvailabilityRow = { groupId:string; className:string; teacherName:string; readySummaryCount:number; summariesWithMissingObservations:number; observed:number; eligible:number; latestReadySessionId:string; lastSessionEnd:Date|string };
export async function getClasspilotReportingAvailability(schoolId: string, period?: string, options: Options = {}) {
  const c = await context(schoolId,period,options);
  const [total,result,states] = await Promise.all([
    db.execute<{eligible:number;observed:number;missing:number;notExpected:number;unavailable:number}>(sql`WITH ${completed(c)} SELECT
      COALESCE(sum(total_eligible_seconds),0)::bigint AS eligible,COALESCE(sum(total_observed_seconds),0)::bigint AS observed,
      count(*) FILTER(WHERE partial_count>0 OR none_count>0)::int AS missing,
      COALESCE(sum(not_expected_count),0)::int AS "notExpected",COALESCE(sum(unavailable_count),0)::int AS unavailable FROM completed WHERE report_state='ready'`),
    db.execute<AvailabilityRow>(sql`WITH ${completed(c)} SELECT group_id AS "groupId",
      (array_agg(class_name ORDER BY end_time DESC,id DESC))[1] AS "className",(array_agg(teacher_name ORDER BY end_time DESC,id DESC))[1] AS "teacherName",
      count(*)::int AS "readySummaryCount",count(*) FILTER(WHERE partial_count>0 OR none_count>0)::int AS "summariesWithMissingObservations",
      COALESCE(sum(total_observed_seconds),0)::bigint AS observed,COALESCE(sum(total_eligible_seconds),0)::bigint AS eligible,
      (array_agg(id ORDER BY end_time DESC,id DESC))[1] AS "latestReadySessionId",max(end_time) AT TIME ZONE 'UTC' AS "lastSessionEnd"
      FROM completed WHERE report_state='ready' GROUP BY group_id ORDER BY "className",group_id`),
    reportCounts(c),
  ]);
  const row = total.rows[0]!;
  return {...publicContext(c),reportCounts:states,coveragePercent:coverage(row.observed,row.eligible),summariesWithMissingObservations:row.missing,
    notExpectedStudentRecords:row.notExpected,unavailableStudentRecords:row.unavailable,
    classes:result.rows.map(row=>({groupId:row.groupId,className:row.className,teacherName:row.teacherName,readySummaryCount:row.readySummaryCount,
      summariesWithMissingObservations:row.summariesWithMissingObservations,coveragePercent:coverage(row.observed,row.eligible),latestReadySessionId:row.latestReadySessionId,lastSessionEnd:isoTimestamp(row.lastSessionEnd)}))};
}

export async function getClasspilotAdoptionTools(schoolId: string, period?: string, options: Options = {}) {
  const c = await context(schoolId,period,options);
  // No target join: a class command is one recorded action, not N student actions.
  const result = await db.execute<{commandType:string;count:number}>(sql`WITH ${completed(c)} SELECT command.command_type AS "commandType",count(*)::int AS count
    FROM classpilot_commands command JOIN completed c ON c.id=command.teaching_session_id
    WHERE command.school_id=${c.schoolId} AND command.created_at>=c.start_time AND command.created_at<c.end_time
    GROUP BY command.command_type ORDER BY count DESC,command.command_type`);
  return {...publicContext(c),totalActions:result.rows.reduce((total,row)=>total+row.count,0),tools:result.rows};
}

export async function getClasspilotAdoptionClients(schoolId: string, period?: string, options: Options = {}) {
  const c = await context(schoolId,period,options);
  // Exact accepted observations and frozen membership establish the window. Mutable
  // roster/device assignments and latest fleet inventory are not historical evidence.
  const result = await db.execute<{version:string|null;count:number}>(sql`WITH ${completed(c)},clients AS (
    SELECT DISTINCT ON (observed.device_id) NULLIF(btrim(observed.extension_version),'') AS version
    FROM completed c JOIN classpilot_session_students frozen
      ON frozen.school_id=${c.schoolId} AND frozen.teaching_session_id=c.id
    CROSS JOIN LATERAL (
      SELECT DISTINCT ON (h.device_id) h.device_id,h.extension_version,h.timestamp,h.id
      FROM heartbeats h WHERE h.school_id=${c.schoolId} AND h.student_id=frozen.student_id
        AND h.timestamp>=GREATEST(c.start_time,frozen.captured_at AT TIME ZONE 'UTC')
        AND h.timestamp>${utcTimestampForSql(c.cutoff)}::timestamp AND h.timestamp<c.end_time
      ORDER BY h.device_id,h.timestamp DESC,h.id DESC
    ) observed
    ORDER BY observed.device_id,observed.timestamp DESC,observed.id DESC
  ) SELECT version,count(*)::int AS count FROM clients GROUP BY version ORDER BY version NULLS LAST`);
  return {...publicContext(c),totalClients:result.rows.reduce((total,row)=>total+row.count,0),versions:result.rows};
}
