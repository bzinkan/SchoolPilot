import {
  HEARTBEAT_ATTRIBUTION_LIMIT_SECONDS,
  serverTrackingDisabledIntervals,
  trackingPolicyDisabledIntervals,
  type ClasspilotTrackingPolicy,
  type ClasspilotTrackingStateEvent,
} from "./classpilotHeartbeatCoverage.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import {
  addLocalDays,
  localDateInTimeZone,
  localDateStartUtc,
  utcTimestampForSql,
} from "../util/schoolTime.js";

/*
 * Monitored Browser Time rollups (classpilot_usage_rollups).
 *
 * One school-local day per statement, rewritten (DELETE + INSERT) inside one
 * transaction under a per-school advisory lock on the scheduler pool. That pool
 * runs with app.is_super=on, so every statement below filters school_id = $1
 * itself; RLS does not scope scheduler work.
 *
 * Attribution follows the v2 session-report rule (classpilotHeartbeatCoverage):
 * heartbeats without a student are dropped, one observation per student per
 * second survives across devices (reconnects, handoffs and duplicate sends
 * never add time), and each observation earns the least of 15 seconds, the gap
 * to the same student's next observation, the end of the window and the start
 * of the next excluded interval. Tracking-policy-disabled and server-disabled
 * intervals are excluded with the same helpers the reports use. Domains are
 * kept only for http(s) URLs; the category prefers the newest AI decision for
 * the heartbeat, and a teacher-intent exemption keeps a page from counting as
 * off-task. Class attribution uses the frozen session roster: the newest
 * session whose window holds the observation wins. Supervision contexts are
 * not a class dimension in v1; their time counts toward the student with no
 * class.
 */

type Row = Record<string, unknown>;

export type ClasspilotUsageRollupQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
};

export type ClasspilotUsageRollupClient = ClasspilotUsageRollupQueryable & {
  release(error?: Error | boolean): void;
};

/** pg.Pool (the scheduler pool in production) or a test double. */
export type ClasspilotUsageRollupPool = ClasspilotUsageRollupQueryable & {
  connect(): Promise<ClasspilotUsageRollupClient>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Probe from this far before the stored processed cutoff (late arrivals). */
const RECOMPUTE_LOOKBACK_MS = 5 * 60 * 1000;
/**
 * runHeavyJobsSerially purges retention only once an hour's UTC minute reaches
 * 30. The rollup stops taking new work at :25 so it can never push the purge
 * past its hour; one in-flight school is bounded by the pool's statement
 * timeout.
 */
export const CLASSPILOT_USAGE_ROLLUP_BUDGET_END_MINUTE = 25;
const DEFAULT_CONCURRENCY = 2;

export const CLASSPILOT_USAGE_ROLLUP_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('classpilot_usage_rollup'), hashtext($1))";

export const CLASSPILOT_USAGE_ROLLUP_DELETE_SQL =
  "DELETE FROM classpilot_usage_rollups WHERE school_id = $1 AND usage_date = $2::date";

export const CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL = `SELECT retention_hours, enable_tracking_hours, tracking_start_time,
  tracking_end_time, tracking_days, after_hours_mode
FROM settings
WHERE school_id = $1`;

// Parameterized per student through the (school_id, student_id, occurred_at)
// index; only server-authored state transitions can exclude time.
export const CLASSPILOT_USAGE_ROLLUP_TRACKING_EVENTS_SQL = `SELECT student.id AS student_id, event.event_type, event.origin,
  event.occurred_at, event.metadata
FROM students AS student
CROSS JOIN LATERAL (
  SELECT tracking.event_type, tracking.origin, tracking.occurred_at, tracking.metadata
  FROM classpilot_monitoring_events AS tracking
  WHERE tracking.school_id = $1
    AND tracking.student_id = student.id
    AND tracking.occurred_at >= $2::timestamptz
    AND tracking.occurred_at < $3::timestamptz
    AND tracking.origin = 'server'
    AND tracking.event_type = 'monitoring_state_changed'
) AS event
WHERE student.school_id = $1`;

export const CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL = `SELECT processed_through, is_final
FROM classpilot_usage_rollup_days
WHERE school_id = $1 AND usage_date = $2::date`;

export const CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL = `INSERT INTO classpilot_usage_rollup_days
  (school_id, usage_date, day_start_at, day_end_at, processed_through, is_final, computed_at)
VALUES ($1, $2::date, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6, now())
ON CONFLICT (school_id, usage_date) DO UPDATE SET
  day_start_at = EXCLUDED.day_start_at, day_end_at = EXCLUDED.day_end_at,
  processed_through = EXCLUDED.processed_through, is_final = EXCLUDED.is_final, computed_at = EXCLUDED.computed_at`;

export const CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL = `SELECT EXISTS (
  SELECT 1 FROM heartbeats AS heartbeat
  WHERE heartbeat.school_id = $1
    AND heartbeat.student_id IS NOT NULL
    AND heartbeat."timestamp" >= $2::timestamp
    AND heartbeat."timestamp" < $3::timestamp
) AS changed`;

/**
 * $1 school id, $2/$3 the half-open window as UTC wall-clock strings compared
 * with heartbeats."timestamp" (timestamp without time zone, never converted),
 * $4 the school-local usage date, $5 the excluded intervals as JSON.
 */
export const CLASSPILOT_USAGE_ROLLUP_INSERT_SQL = `WITH observed AS MATERIALIZED (
  SELECT heartbeat.id, heartbeat.student_id, heartbeat."timestamp" AS observed_at,
    heartbeat.active_tab_url, heartbeat.ai_category, heartbeat.teacher_intent_source
  FROM heartbeats AS heartbeat
  WHERE heartbeat.school_id = $1
    AND heartbeat.student_id IS NOT NULL
    AND heartbeat."timestamp" >= $2::timestamp
    AND heartbeat."timestamp" < $3::timestamp
    AND EXISTS (
      SELECT 1 FROM students AS student
      WHERE student.school_id = $1 AND student.id = heartbeat.student_id
    )
),
excluded AS MATERIALIZED (
  SELECT NULLIF(item->>'studentId', '') AS student_id,
    (item->>'start')::timestamp AS start_at,
    (item->>'end')::timestamp AS end_at
  FROM jsonb_array_elements($5::jsonb) AS item
),
eligible AS MATERIALIZED (
  SELECT observed.* FROM observed
  WHERE NOT EXISTS (
    SELECT 1 FROM excluded
    WHERE (excluded.student_id IS NULL OR excluded.student_id = observed.student_id)
      AND observed.observed_at >= excluded.start_at
      AND observed.observed_at < excluded.end_at
  )
),
deduplicated AS MATERIALIZED (
  SELECT DISTINCT ON (student_id, date_trunc('second', observed_at)) *
  FROM eligible
  ORDER BY student_id, date_trunc('second', observed_at), observed_at, id
),
ai_decision AS MATERIALIZED (
  SELECT DISTINCT ON (decision.heartbeat_id) decision.heartbeat_id, decision.category,
    decision.teacher_intent_source
  FROM classpilot_ai_decisions AS decision
  WHERE decision.school_id = $1
    AND decision.created_at >= $2::timestamp
    AND decision.heartbeat_id IN (SELECT id FROM deduplicated)
  ORDER BY decision.heartbeat_id, decision.created_at DESC, decision.id DESC
),
normalized AS (
  SELECT observation.id, observation.student_id, observation.observed_at,
    LEAST(
      ${HEARTBEAT_ATTRIBUTION_LIMIT_SECONDS}::numeric,
      EXTRACT(EPOCH FROM ((LEAD(observation.observed_at) OVER student_timeline) - observation.observed_at)),
      EXTRACT(EPOCH FROM ($3::timestamp - observation.observed_at)),
      EXTRACT(EPOCH FROM ((
        SELECT MIN(excluded.start_at) FROM excluded
        WHERE (excluded.student_id IS NULL OR excluded.student_id = observation.student_id)
          AND excluded.start_at > observation.observed_at
      ) - observation.observed_at))
    ) AS attributed_seconds,
    CASE WHEN observation.active_tab_url ~* '^https?://'
      THEN left(regexp_replace(lower(COALESCE(
        substring(observation.active_tab_url FROM '(?i)^https?://(?:[^/?#@]*@)?([^:/?#]*)'), ''
      )), '^www\\.', ''), 253)
      ELSE ''
    END AS domain,
    CASE WHEN COALESCE(NULLIF(ai_decision.category, ''), observation.ai_category) IN ('educational', 'non-educational')
      THEN COALESCE(NULLIF(ai_decision.category, ''), observation.ai_category)
      ELSE 'unknown'
    END AS category,
    (NULLIF(ai_decision.teacher_intent_source, '') IS NOT NULL
      OR NULLIF(observation.teacher_intent_source, '') IS NOT NULL) AS teacher_intent_exempt
  FROM deduplicated AS observation
  LEFT JOIN ai_decision ON ai_decision.heartbeat_id = observation.id
  WINDOW student_timeline AS (PARTITION BY observation.student_id ORDER BY observation.observed_at, observation.id)
),
classified AS (
  SELECT normalized.*,
    CASE
      WHEN normalized.category = 'non-educational' AND NOT normalized.teacher_intent_exempt
        AND normalized.domain <> '' THEN 'non-educational'
      WHEN normalized.category IN ('educational', 'non-educational') THEN 'educational'
      ELSE 'unknown'
    END AS classification
  FROM normalized
),
roster_window AS MATERIALIZED (
  SELECT roster.student_id, roster.group_id AS class_id, session.id AS session_id, session.start_time,
    GREATEST(session.start_time, roster.captured_at AT TIME ZONE 'UTC') AS starts_at,
    LEAST(
      COALESCE(session.end_time, 'infinity'::timestamp),
      COALESCE(session.scheduled_end_at AT TIME ZONE 'UTC', 'infinity'::timestamp),
      session.start_time + interval '12 hours'
    ) AS ends_at
  FROM classpilot_session_students AS roster
  JOIN teaching_sessions AS session
    ON session.id = roster.teaching_session_id AND session.school_id = $1
  JOIN groups AS class
    ON class.id = roster.group_id AND class.school_id = $1
  WHERE roster.school_id = $1
    AND session.start_time < $3::timestamp
    AND session.start_time >= $2::timestamp - interval '12 hours'
),
attributed AS (
  SELECT DISTINCT ON (classified.id) classified.student_id, classified.attributed_seconds,
    classified.domain, classified.classification, roster_window.class_id, roster_window.session_id
  FROM classified
  LEFT JOIN roster_window
    ON roster_window.student_id = classified.student_id
    AND classified.observed_at >= roster_window.starts_at
    AND classified.observed_at < roster_window.ends_at
  ORDER BY classified.id, roster_window.start_time DESC NULLS LAST, roster_window.session_id DESC NULLS LAST
),
inserted AS (
  INSERT INTO classpilot_usage_rollups (
    school_id, usage_date, student_id, class_id, session_id, domain, classification, seconds, heartbeat_count
  )
  SELECT $1, $4::date, attributed.student_id, attributed.class_id, attributed.session_id,
    attributed.domain, attributed.classification,
    ROUND(SUM(GREATEST(attributed.attributed_seconds, 0)))::int, COUNT(*)::int
  FROM attributed
  GROUP BY attributed.student_id, attributed.class_id, attributed.session_id,
    attributed.domain, attributed.classification
  RETURNING seconds, heartbeat_count
)
SELECT COUNT(*)::int AS row_count,
  COALESCE(SUM(seconds), 0)::bigint AS seconds,
  COALESCE(SUM(heartbeat_count), 0)::bigint AS heartbeat_count
FROM inserted`;

export type ClasspilotUsageRollupDay = {
  date: string;
  dayStartUtc: Date;
  dayEndUtc: Date;
};

export function classpilotUsageRollupDay(date: string, timeZone: string): ClasspilotUsageRollupDay {
  return {
    date,
    dayStartUtc: localDateStartUtc(date, timeZone),
    dayEndUtc: localDateStartUtc(addLocalDays(date, 1), timeZone),
  };
}

/** Today and yesterday in the school's time zone (DST-safe half-open bounds). */
export function classpilotUsageRollupDays(now: Date, timeZone: string) {
  const today = localDateInTimeZone(now, timeZone);
  return {
    today: classpilotUsageRollupDay(today, timeZone),
    yesterday: classpilotUsageRollupDay(addLocalDays(today, -1), timeZone),
  };
}

function floorUtcHour(value: Date): Date {
  return new Date(Math.floor(value.getTime() / HOUR_MS) * HOUR_MS);
}

/** New work is not started at or after this instant (see the budget constant). */
export function classpilotUsageRollupDeadline(heavyJobStartedAt: Date): Date {
  return new Date(floorUtcHour(heavyJobStartedAt).getTime() + CLASSPILOT_USAGE_ROLLUP_BUDGET_END_MINUTE * 60_000);
}

/**
 * The oldest instant the hourly retention purge cannot yet have reached.
 * purgeExpiredHeartbeats deletes heartbeats older than now - retention, and it
 * runs only once an hour's UTC minute is at least 30, so before :30 the newest
 * purge finished by the top of the hour unless it overran (lastPurgeFinishedAt).
 * A day that starts before the horizon may already be partly purged: it is
 * never rewritten, and its existing rollup rows stay until the purge removes
 * the whole day. This is what keeps a one-day-retention school's finished day
 * whole: it is finalized at the first top-of-hour after local midnight, before
 * that hour's :30 purge.
 */
export function classpilotUsageRetentionHorizon(options: {
  now: Date;
  retentionDays: number;
  lastPurgeFinishedAt?: Date | null;
}): Date {
  let bound = options.now.getUTCMinutes() < 30 ? floorUtcHour(options.now) : options.now;
  if (options.lastPurgeFinishedAt && options.lastPurgeFinishedAt > bound) bound = options.lastPurgeFinishedAt;
  return new Date(bound.getTime() - options.retentionDays * DAY_MS);
}

type SettingsRow = {
  retention_hours?: unknown;
  enable_tracking_hours?: unknown;
  tracking_start_time?: unknown;
  tracking_end_time?: unknown;
  tracking_days?: unknown;
  after_hours_mode?: unknown;
};

/**
 * The school's current tracking policy, shaped exactly like the frozen policy
 * a session report snapshots (limited after-hours counts as off).
 */
export function classpilotUsageTrackingPolicy(
  settings: SettingsRow | undefined,
  timeZone: string
): ClasspilotTrackingPolicy {
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const afterHours = text(settings?.after_hours_mode);
  return {
    enableTrackingHours: settings?.enable_tracking_hours === true,
    trackingStartTime: text(settings?.tracking_start_time),
    trackingEndTime: text(settings?.tracking_end_time),
    trackingDays: Array.isArray(settings?.tracking_days)
      ? settings.tracking_days.filter((day): day is string => typeof day === "string")
      : [],
    schoolTimezone: timeZone,
    // Any other stored value never matched "off" in the report path either.
    afterHoursMode: afterHours === null || afterHours === "off" || afterHours === "limited" ? "off" : "full",
  };
}

export type ClasspilotUsageExclusion = { studentId: string | null; start: Date; end: Date };

/** Intervals the reports treat as not monitored: school-wide policy and per-student server state. */
export function classpilotUsageExclusions(options: {
  trackingPolicy: ClasspilotTrackingPolicy;
  trackingEvents: readonly ClasspilotTrackingStateEvent[];
  windowStart: Date;
  windowEnd: Date;
}): ClasspilotUsageExclusion[] {
  const exclusions: ClasspilotUsageExclusion[] = trackingPolicyDisabledIntervals(
    options.trackingPolicy,
    options.windowStart,
    options.windowEnd
  ).map((interval) => ({ studentId: null, start: interval.start, end: interval.end }));
  const studentIds = [...new Set(options.trackingEvents.map((event) => event.studentId))].sort();
  for (const studentId of studentIds) {
    for (const interval of serverTrackingDisabledIntervals(
      { monitoringEvents: options.trackingEvents },
      studentId,
      options.windowStart,
      options.windowEnd
    )) {
      exclusions.push({ studentId, start: interval.start, end: interval.end });
    }
  }
  return exclusions;
}

/** Millisecond UTC wall clock for comparisons with timestamp-without-time-zone columns. */
function utcWallClock(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

export function classpilotUsageExclusionsJson(exclusions: readonly ClasspilotUsageExclusion[]): string {
  return JSON.stringify(exclusions.map((exclusion) => ({
    studentId: exclusion.studentId ?? "",
    start: utcWallClock(exclusion.start),
    end: utcWallClock(exclusion.end),
  })));
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export type ClasspilotUsageDayResult = { rowCount: number; seconds: number; heartbeatCount: number };

/** Rewrite one school-local day in one transaction. The caller enforces the retention horizon. */
export async function rollupClasspilotUsageDay(
  pool: ClasspilotUsageRollupPool,
  options: {
    schoolId: string;
    day: ClasspilotUsageRollupDay;
    windowEndUtc: Date;
    exclusions: readonly ClasspilotUsageExclusion[];
  }
): Promise<ClasspilotUsageDayResult> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    try {
      await client.query(CLASSPILOT_USAGE_ROLLUP_LOCK_SQL, [options.schoolId]);
      // Recheck under the same lock as the rewrite: stale queued work cannot
      // regress a newer snapshot or turn a finalized day back into a live day.
      const prior = await client.query(CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL, [options.schoolId, options.day.date]);
      const processedThrough = asDate(prior.rows[0]?.processed_through);
      if (processedThrough && processedThrough >= options.windowEndUtc) {
        await client.query("COMMIT");
        return { rowCount: 0, seconds: 0, heartbeatCount: 0 };
      }
      await client.query(CLASSPILOT_USAGE_ROLLUP_DELETE_SQL, [options.schoolId, options.day.date]);
      const result = await client.query(CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, [
        options.schoolId,
        utcTimestampForSql(options.day.dayStartUtc),
        utcTimestampForSql(options.windowEndUtc),
        options.day.date,
        classpilotUsageExclusionsJson(options.exclusions),
      ]);
      // Aggregate-change triggers invalidate prior coverage. Restore it only
      // after a successful insert, including the successful empty-day case.
      await client.query(CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL, [
        options.schoolId, options.day.date, options.day.dayStartUtc.toISOString(),
        options.day.dayEndUtc.toISOString(), options.windowEndUtc.toISOString(),
        options.windowEndUtc >= options.day.dayEndUtc,
      ]);
      await client.query("COMMIT");
      const row = result.rows[0] ?? {};
      return {
        rowCount: Number(row.row_count ?? 0),
        seconds: Number(row.seconds ?? 0),
        heartbeatCount: Number(row.heartbeat_count ?? 0),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => { broken = true; });
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

async function loadTrackingEvents(
  pool: ClasspilotUsageRollupQueryable,
  schoolId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<ClasspilotTrackingStateEvent[]> {
  const result = await pool.query(CLASSPILOT_USAGE_ROLLUP_TRACKING_EVENTS_SQL, [
    schoolId,
    windowStart.toISOString(),
    windowEnd.toISOString(),
  ]);
  return result.rows.flatMap((row) => {
    const occurredAt = asDate(row.occurred_at);
    return occurredAt && typeof row.student_id === "string"
      ? [{
          studentId: row.student_id,
          eventType: String(row.event_type ?? ""),
          origin: String(row.origin ?? ""),
          occurredAt,
          metadata: row.metadata,
        }]
      : [];
  });
}

async function hasHeartbeatsSinceLastRollup(
  pool: ClasspilotUsageRollupQueryable,
  schoolId: string,
  day: ClasspilotUsageRollupDay,
  windowEndUtc: Date
): Promise<boolean> {
  const last = await pool.query(CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL, [schoolId, day.date]);
  const processedThrough = asDate(last.rows[0]?.processed_through);
  // Absence is not a successful empty computation: establish coverage once,
  // even when no heartbeat exists. Computation time may be much later than the
  // input cutoff while a school waits behind other work.
  if (!processedThrough) return true;
  const since = new Date(Math.max(day.dayStartUtc.getTime(), processedThrough.getTime() - RECOMPUTE_LOOKBACK_MS));
  if (since >= windowEndUtc) return false;
  const changed = await pool.query(CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL, [
    schoolId,
    utcTimestampForSql(since),
    utcTimestampForSql(windowEndUtc),
  ]);
  return changed.rows[0]?.changed === true;
}

export type ClasspilotUsageRollupSchool = { id: string; timeZone: string };

export type ClasspilotUsageRollupMarkers = {
  isComplete(schoolId: string, date: string): Promise<boolean>;
  markComplete(schoolId: string, date: string): Promise<void>;
};

export type ClasspilotUsageRollupOutcome = {
  schools: number;
  /** Yesterday rewritten once after it ended. */
  finalizedDays: number;
  /** Every day rewrite, finalizations included. */
  recomputedDays: number;
  /** Today left alone: no heartbeat since its last computation. */
  unchangedDays: number;
  /** Refused because the day starts before the retention purge horizon. */
  retentionSkippedDays: number;
  /** Not started because the hour's budget ran out; the next hour retries. */
  deferredDays: number;
  failedSchools: number;
  rowCount: number;
  budgetExhausted: boolean;
};

type SchoolContext = {
  school: ClasspilotUsageRollupSchool;
  days: ReturnType<typeof classpilotUsageRollupDays>;
  horizon: Date;
  trackingPolicy: ClasspilotTrackingPolicy;
};

/**
 * One hourly pass. Finalizations of yesterday are queued before any of
 * today's recomputes, so the time-critical work (a finished day must be
 * captured before the :30 purge reaches it) always runs first, and the budget
 * only ever defers today's refresh or a finalization that a later hour may
 * still perform while the day is inside the horizon.
 */
export async function runClasspilotUsageRollup(options: {
  pool: ClasspilotUsageRollupPool;
  schools: readonly ClasspilotUsageRollupSchool[];
  now: Date;
  deadline: Date;
  markers: ClasspilotUsageRollupMarkers;
  lastPurgeFinishedAt?: Date | null;
  clock?: () => Date;
  concurrency?: number;
  onSchoolError?: (error: unknown, schoolId: string) => void;
}): Promise<ClasspilotUsageRollupOutcome> {
  const clock = options.clock ?? (() => new Date());
  const outcome: ClasspilotUsageRollupOutcome = {
    schools: options.schools.length,
    finalizedDays: 0,
    recomputedDays: 0,
    unchangedDays: 0,
    retentionSkippedDays: 0,
    deferredDays: 0,
    failedSchools: 0,
    rowCount: 0,
    budgetExhausted: false,
  };
  const failed = new Set<string>();
  const contexts = new Map<string, Promise<SchoolContext>>();
  const contextFor = (school: ClasspilotUsageRollupSchool) => {
    let context = contexts.get(school.id);
    if (!context) {
      context = (async () => {
        const settings = await options.pool.query(CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL, [school.id]);
        const row = settings.rows[0] as SettingsRow | undefined;
        return {
          school,
          days: classpilotUsageRollupDays(options.now, school.timeZone),
          horizon: classpilotUsageRetentionHorizon({
            now: options.now,
            retentionDays: parseClasspilotRetentionDays(row?.retention_hours),
            lastPurgeFinishedAt: options.lastPurgeFinishedAt,
          }),
          trackingPolicy: classpilotUsageTrackingPolicy(row, school.timeZone),
        };
      })();
      contexts.set(school.id, context);
    }
    return context;
  };
  const rewrite = async (context: SchoolContext, day: ClasspilotUsageRollupDay, windowEndUtc: Date) => {
    const trackingEvents = await loadTrackingEvents(options.pool, context.school.id, day.dayStartUtc, windowEndUtc);
    const result = await rollupClasspilotUsageDay(options.pool, {
      schoolId: context.school.id,
      day,
      windowEndUtc,
      exclusions: classpilotUsageExclusions({
        trackingPolicy: context.trackingPolicy,
        trackingEvents,
        windowStart: day.dayStartUtc,
        windowEnd: windowEndUtc,
      }),
    });
    outcome.recomputedDays += 1;
    outcome.rowCount += result.rowCount;
  };
  const tasks: Array<{ school: ClasspilotUsageRollupSchool; kind: "finalize" | "today" }> = [
    ...options.schools.map((school) => ({ school, kind: "finalize" as const })),
    ...options.schools.map((school) => ({ school, kind: "today" as const })),
  ];
  const runTask = async (task: (typeof tasks)[number]) => {
    const context = await contextFor(task.school);
    if (task.kind === "finalize") {
      const day = context.days.yesterday;
      // Redis is only a cache. Pre-ledger or invalidated cache entries cannot
      // assert a day was computed, and failed/skipped work is never completion.
      const coverage = await options.pool.query(CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL, [task.school.id, day.date]);
      if (coverage.rows[0]?.is_final === true) return;
      if (day.dayStartUtc < context.horizon) {
        // Partly purged already: keep the rows computed while it was today.
        outcome.retentionSkippedDays += 1;
        return;
      }
      await rewrite(context, day, day.dayEndUtc);
      outcome.finalizedDays += 1;
      await options.markers.markComplete(task.school.id, day.date);
      return;
    }
    const day = context.days.today;
    if (day.dayStartUtc < context.horizon) {
      outcome.retentionSkippedDays += 1;
      return;
    }
    const windowEndUtc = new Date(Math.min(day.dayEndUtc.getTime(), options.now.getTime()));
    if (!(await hasHeartbeatsSinceLastRollup(options.pool, task.school.id, day, windowEndUtc))) {
      outcome.unchangedDays += 1;
      return;
    }
    await rewrite(context, day, windowEndUtc);
  };

  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, tasks.length)) },
    async () => {
      while (next < tasks.length) {
        if (clock() >= options.deadline) {
          if (!outcome.budgetExhausted) {
            outcome.budgetExhausted = true;
            outcome.deferredDays += tasks.length - next;
            next = tasks.length;
          }
          return;
        }
        const task = tasks[next++]!;
        try {
          await runTask(task);
        } catch (error) {
          failed.add(task.school.id);
          options.onSchoolError?.(error, task.school.id);
        }
      }
    }
  );
  await Promise.all(workers);
  outcome.failedSchools = failed.size;
  return outcome;
}

const CLASSPILOT_USAGE_ROLLUP_METRIC_NAMES = [
  "UsageRollupFailedSchools",
  "UsageRollupDeferredDays",
] as const;

export type ClasspilotUsageRollupMetricName = (typeof CLASSPILOT_USAGE_ROLLUP_METRIC_NAMES)[number];

export type ClasspilotUsageRollupMetricRecord = {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: ClasspilotUsageRollupMetricName; Unit: "Count" }>;
    }>;
  };
  Environment: string;
} & Partial<Record<ClasspilotUsageRollupMetricName, number>>;

/**
 * CloudWatch EMF record for one run, or null when there is nothing to publish.
 * Nonzero-only, like the daily rollup: the classpilot_usage_rollup log line
 * already carries every counter, zeros included.
 */
export function classpilotUsageRollupMetricRecord(
  counts: { failedSchools: number; deferredDays: number },
  options: { environment: string; timestamp: number }
): ClasspilotUsageRollupMetricRecord | null {
  const values: Partial<Record<ClasspilotUsageRollupMetricName, number>> = {};
  if (counts.failedSchools > 0) values.UsageRollupFailedSchools = counts.failedSchools;
  if (counts.deferredDays > 0) values.UsageRollupDeferredDays = counts.deferredDays;
  const names = CLASSPILOT_USAGE_ROLLUP_METRIC_NAMES.filter((name) => values[name] !== undefined);
  if (names.length === 0) return null;
  return {
    _aws: {
      Timestamp: options.timestamp,
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot",
        Dimensions: [["Environment"]],
        Metrics: names.map((name) => ({ Name: name, Unit: "Count" as const })),
      }],
    },
    Environment: options.environment,
    ...values,
  };
}
