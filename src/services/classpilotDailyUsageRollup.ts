import { coerceSchedulerTimestamp } from "../util/schedulerTimestamp.js";
import { utcTimestampForSql } from "../util/schoolTime.js";

/** pg.Pool, a PoolClient or a test double: these statements only need query(text, values). */
type Queryable = {
  query(text: string, values: unknown[]): Promise<{ rows: RawAggregate[] }>;
};

export type DailyUsageAggregate = {
  studentId: string;
  totalSeconds: number;
  heartbeatCount: number;
  topDomains: Array<{ domain: string; seconds: number; visits: number }>;
  firstSeen: Date | string | null;
  lastSeen: Date | string | null;
};

// Heartbeats without a student never reach daily_usage: student_id is NOT NULL there and the
// legacy path skips them, so the shadow comparison stays like-for-like. $2/$3 are UTC
// wall-clock strings compared with heartbeats.timestamp (timestamp without time zone).
const WINDOWS_AGGREGATION_CTES = `
windows_window AS NOT MATERIALIZED (
  SELECT event.id, event.student_id, event.observed_at,
    event.observed_at AT TIME ZONE 'UTC' AS timestamp, event.active_tab_url,
    least(event.usage_ends_at, event.observed_at + interval '10 seconds',
      browser.ended_at, guard.ended_at, guard.expires_at, guard.absolute_expires_at,
      $3::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS ends_at
  FROM classpilot_windows_browser_events event
  JOIN classpilot_windows_browsers browser ON browser.id = event.browser_id
    AND browser.school_id = event.school_id AND browser.student_id = event.student_id
  JOIN classpilot_windows_guards guard ON guard.id = browser.guard_id
    AND guard.school_id = browser.school_id AND guard.student_id = browser.student_id
  WHERE event.school_id = $1 AND event.browser_focused
    AND event.observed_at >= $2::timestamp AT TIME ZONE 'UTC'
    AND event.observed_at < $3::timestamp AT TIME ZONE 'UTC'
    AND event.observed_at >= greatest(browser.created_at, guard.created_at)
    AND least(event.usage_ends_at, browser.ended_at, guard.ended_at,
      guard.expires_at, guard.absolute_expires_at) > event.observed_at
),
windows_legacy_coverage AS MATERIALIZED (
  -- The legacy writer deliberately keeps COUNT(*) * 10, including duplicates.
  -- Remove its forward ten-second coverage only from the added Windows time.
  -- Unioning these slots avoids subtracting duplicate legacy heartbeats twice.
  SELECT heartbeat.student_id, range_agg(tsrange(heartbeat.timestamp,
    least(heartbeat.timestamp + interval '10 seconds', $3::timestamp), '[)')) AS slots
  FROM heartbeats heartbeat
  WHERE heartbeat.school_id = $1 AND heartbeat.timestamp >= $2::timestamp
    AND heartbeat.timestamp < $3::timestamp
    AND heartbeat.student_id IN (SELECT student_id FROM windows_window)
  GROUP BY heartbeat.student_id
),
windows_boundaries AS (
  SELECT student_id, timestamp AS boundary FROM windows_window
  UNION SELECT student_id, ends_at FROM windows_window
),
windows_segments AS (
  SELECT student_id, boundary AS starts_at,
    lead(boundary) OVER (PARTITION BY student_id ORDER BY boundary) AS ends_at
  FROM windows_boundaries
),
windows_attribution AS MATERIALIZED (
  SELECT segment.student_id, source.id, source.active_tab_url,
    extract(epoch FROM upper(remaining.slot) - lower(remaining.slot)) AS seconds
  FROM windows_segments segment
  JOIN LATERAL (
    SELECT observation.id, observation.active_tab_url FROM windows_window observation
    WHERE observation.student_id = segment.student_id
      AND observation.observed_at > (segment.starts_at - interval '10 seconds') AT TIME ZONE 'UTC'
      AND observation.observed_at <= segment.starts_at AT TIME ZONE 'UTC'
      AND observation.ends_at > segment.starts_at
    ORDER BY observation.observed_at DESC, observation.id DESC LIMIT 1
  ) source ON true
  LEFT JOIN windows_legacy_coverage legacy ON legacy.student_id = segment.student_id
  CROSS JOIN LATERAL unnest(
    CASE WHEN segment.ends_at > segment.starts_at
      THEN tsmultirange(tsrange(segment.starts_at, segment.ends_at, '[)'))
      ELSE '{}'::tsmultirange END - coalesce(legacy.slots, '{}'::tsmultirange)
  ) remaining(slot)
  WHERE segment.ends_at > segment.starts_at
),
windows_totals AS MATERIALIZED (
  SELECT observations.student_id, observations.heartbeat_count, coalesce(durations.total_seconds, 0)::int AS total_seconds,
    observations.first_seen, observations.last_seen
  FROM (SELECT student_id, count(*)::int AS heartbeat_count, min(timestamp) AS first_seen, max(timestamp) AS last_seen
    FROM windows_window GROUP BY student_id) observations
  LEFT JOIN (SELECT student_id, round(sum(seconds))::int AS total_seconds
    FROM windows_attribution GROUP BY student_id) durations USING (student_id)
),
windows_domains AS MATERIALIZED (
  SELECT student_id, substring(active_tab_url FROM '://([^/]+)') AS domain,
    round(sum(seconds))::int AS seconds, count(DISTINCT id)::int AS visits
  FROM windows_attribution GROUP BY student_id, substring(active_tab_url FROM '://([^/]+)')
)
`;

const AGGREGATION_CTES = `
WITH ${WINDOWS_AGGREGATION_CTES}, heartbeat_window AS MATERIALIZED (
  SELECT student_id, timestamp, active_tab_url
  FROM heartbeats
  WHERE school_id = $1
    AND student_id IS NOT NULL
    AND timestamp >= $2
    AND timestamp < $3
),
legacy_student_totals AS MATERIALIZED (
  SELECT
    student_id,
    COUNT(*)::int AS heartbeat_count,
    (COUNT(*) * 10)::int AS total_seconds,
    MIN(timestamp) AS first_seen,
    MAX(timestamp) AS last_seen
  FROM heartbeat_window
  GROUP BY student_id
),
legacy_domain_counts AS MATERIALIZED (
  SELECT
    student_id,
    SUBSTRING(active_tab_url FROM '://([^/]+)') AS domain,
    (COUNT(*) * 10)::int AS seconds,
    COUNT(*)::int AS visits
  FROM heartbeat_window
  WHERE active_tab_url IS NOT NULL
  GROUP BY student_id, SUBSTRING(active_tab_url FROM '://([^/]+)')
),
student_totals AS MATERIALIZED (
  SELECT student_id, sum(heartbeat_count)::int AS heartbeat_count, sum(total_seconds)::int AS total_seconds,
    min(first_seen) AS first_seen, max(last_seen) AS last_seen
  FROM (SELECT * FROM legacy_student_totals UNION ALL SELECT * FROM windows_totals) sources GROUP BY student_id
),
domain_counts AS MATERIALIZED (
  SELECT student_id, domain, sum(seconds)::int AS seconds, sum(visits)::int AS visits
  FROM (SELECT * FROM legacy_domain_counts UNION ALL SELECT * FROM windows_domains) sources GROUP BY student_id, domain
),
ranked_domains AS MATERIALIZED (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY student_id
    ORDER BY visits DESC, domain ASC
  ) AS domain_rank
  FROM domain_counts
  WHERE domain IS NOT NULL
),
top_domains AS MATERIALIZED (
  SELECT
    student_id,
    JSONB_AGG(
      JSONB_BUILD_OBJECT('domain', domain, 'seconds', seconds, 'visits', visits)
      ORDER BY visits DESC, domain ASC
    ) FILTER (WHERE domain_rank <= 5) AS domains
  FROM ranked_domains
  GROUP BY student_id
)
`;

export const CLASSPILOT_DAILY_USAGE_CANDIDATE_SQL = `${AGGREGATION_CTES}
SELECT
  totals.student_id,
  totals.total_seconds,
  totals.heartbeat_count,
  COALESCE(domains.domains, '[]'::jsonb) AS top_domains,
  totals.first_seen::text AS first_seen,
  totals.last_seen::text AS last_seen
FROM student_totals AS totals
LEFT JOIN top_domains AS domains USING (student_id)
ORDER BY totals.student_id`;

export const CLASSPILOT_DAILY_USAGE_UPSERT_SQL = `${AGGREGATION_CTES}
INSERT INTO daily_usage (
  school_id,
  student_id,
  date,
  total_seconds,
  heartbeat_count,
  top_domains,
  first_seen,
  last_seen,
  computed_at
)
SELECT
  $1,
  totals.student_id,
  $4,
  totals.total_seconds,
  totals.heartbeat_count,
  COALESCE(domains.domains, '[]'::jsonb),
  totals.first_seen,
  totals.last_seen,
  NOW()
FROM student_totals AS totals
LEFT JOIN top_domains AS domains USING (student_id)
ON CONFLICT (student_id, date) DO UPDATE SET
  school_id = EXCLUDED.school_id,
  total_seconds = EXCLUDED.total_seconds,
  heartbeat_count = EXCLUDED.heartbeat_count,
  top_domains = EXCLUDED.top_domains,
  first_seen = EXCLUDED.first_seen,
  last_seen = EXCLUDED.last_seen,
  computed_at = NOW()
RETURNING
  student_id,
  total_seconds,
  heartbeat_count,
  top_domains,
  first_seen::text AS first_seen,
  last_seen::text AS last_seen`;

type RawAggregate = {
  student_id: string;
  total_seconds: number;
  heartbeat_count: number;
  top_domains: DailyUsageAggregate["topDomains"] | null;
  first_seen: Date | string | null;
  last_seen: Date | string | null;
};

function mapAggregate(row: RawAggregate): DailyUsageAggregate {
  return {
    studentId: row.student_id,
    totalSeconds: Number(row.total_seconds),
    heartbeatCount: Number(row.heartbeat_count),
    topDomains: Array.isArray(row.top_domains) ? row.top_domains : [],
    // The legacy path's conversion: timestamp-without-time-zone text read as UTC. pg would
    // otherwise parse these columns in the host's local time.
    firstSeen: coerceSchedulerTimestamp(row.first_seen),
    lastSeen: coerceSchedulerTimestamp(row.last_seen),
  };
}

// The legacy writer retains its original heartbeat queries; this independently
// bounded contribution also includes Windows-only students and all domains
// before the final top-five selection.
export async function readWindowsDailyUsageCandidate(
  queryable: Queryable, options: { schoolId: string; dayStartUtc: Date; dayEndUtc: Date },
): Promise<DailyUsageAggregate[]> {
  const result = await queryable.query(`WITH ${WINDOWS_AGGREGATION_CTES}
    SELECT totals.student_id, totals.total_seconds, totals.heartbeat_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('domain', domain, 'seconds', seconds, 'visits', visits)
        ORDER BY visits DESC, domain ASC) FROM windows_domains domains
        WHERE domains.student_id = totals.student_id AND domain IS NOT NULL), '[]'::jsonb) AS top_domains,
      totals.first_seen::text AS first_seen, totals.last_seen::text AS last_seen FROM windows_totals totals`,
  [options.schoolId, utcTimestampForSql(options.dayStartUtc), utcTimestampForSql(options.dayEndUtc)]);
  return result.rows.map(mapAggregate);
}

export function mergeWindowsDailyUsage(legacy: DailyUsageAggregate[], windows: DailyUsageAggregate[]): DailyUsageAggregate[] {
  const windowsStudents = new Set(windows.map(row => row.studentId));
  const merged = new Map(legacy.map(row => [row.studentId, { ...row, topDomains: row.topDomains.map(domain => ({ ...domain })) }]));
  for (const row of windows) {
    const current = merged.get(row.studentId);
    if (!current) { merged.set(row.studentId, { ...row, topDomains: row.topDomains.map(domain => ({ ...domain })) }); continue; }
    current.totalSeconds += row.totalSeconds;
    current.heartbeatCount += row.heartbeatCount;
    if (row.firstSeen && (!current.firstSeen || new Date(row.firstSeen) < new Date(current.firstSeen))) current.firstSeen = row.firstSeen;
    if (row.lastSeen && (!current.lastSeen || new Date(row.lastSeen) > new Date(current.lastSeen))) current.lastSeen = row.lastSeen;
    for (const domain of row.topDomains) {
      const existing = current.topDomains.find(candidate => candidate.domain === domain.domain);
      if (existing) { existing.seconds += domain.seconds; existing.visits += domain.visits; }
      else current.topDomains.push({ ...domain });
    }
  }
  return [...merged.values()].map(row => ({ ...row, topDomains: (windowsStudents.has(row.studentId)
    ? row.topDomains.sort((a, b) => b.visits - a.visits || a.domain.localeCompare(b.domain))
    : row.topDomains).slice(0, 5) }));
}

// Day bounds are bound as UTC wall-clock strings. node-postgres serializes a JS Date in the
// host's local time with an offset, and a timestamp-without-time-zone comparison drops it.
export async function readSetBasedDailyUsageCandidate(
  queryable: Queryable,
  options: { schoolId: string; dayStartUtc: Date; dayEndUtc: Date }
): Promise<DailyUsageAggregate[]> {
  const result = await queryable.query(
    CLASSPILOT_DAILY_USAGE_CANDIDATE_SQL,
    [options.schoolId, utcTimestampForSql(options.dayStartUtc), utcTimestampForSql(options.dayEndUtc)]
  );
  return result.rows.map(mapAggregate);
}

export async function upsertSetBasedDailyUsage(
  queryable: Queryable,
  options: { schoolId: string; date: string; dayStartUtc: Date; dayEndUtc: Date }
): Promise<DailyUsageAggregate[]> {
  const result = await queryable.query(
    CLASSPILOT_DAILY_USAGE_UPSERT_SQL,
    [
      options.schoolId,
      utcTimestampForSql(options.dayStartUtc),
      utcTimestampForSql(options.dayEndUtc),
      options.date,
    ]
  );
  return result.rows.map(mapAggregate);
}

function timestamp(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function dailyUsageAggregatesEqual(
  left: readonly DailyUsageAggregate[],
  right: readonly DailyUsageAggregate[]
): boolean {
  const canonical = (rows: readonly DailyUsageAggregate[]) => rows
    .map((row) => ({
      studentId: row.studentId,
      totalSeconds: row.totalSeconds,
      heartbeatCount: row.heartbeatCount,
      topDomains: row.topDomains.map((domain) => ({
        domain: domain.domain,
        seconds: Number(domain.seconds),
        visits: Number(domain.visits),
      })),
      firstSeen: timestamp(row.firstSeen),
      lastSeen: timestamp(row.lastSeen),
    }))
    .sort((a, b) => a.studentId.localeCompare(b.studentId));
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export type DailyUsageRollupMode = "legacy" | "shadow" | "set_based";

/**
 * CLASSPILOT_DAILY_USAGE_ROLLUP_MODE. `on` is an alias of `set_based` (the value the governed
 * product runtime tool writes). Unset, empty and unrecognized values, `off` included, keep the
 * `shadow` default: legacy rows are written and the set-based result is only compared.
 */
export function parseDailyUsageRollupMode(value: string | undefined): DailyUsageRollupMode {
  const configured = String(value || "shadow").trim().toLowerCase();
  if (configured === "set_based" || configured === "on") return "set_based";
  if (configured === "legacy") return "legacy";
  return "shadow";
}

const DAILY_USAGE_ROLLUP_METRIC_NAMES = [
  "DailyUsageRollupShadowMismatch",
  "DailyUsageRollupFailedSchools",
] as const;

export type DailyUsageRollupMetricName = typeof DAILY_USAGE_ROLLUP_METRIC_NAMES[number];

export type DailyUsageRollupMetricRecord = {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: DailyUsageRollupMetricName; Unit: "Count" }>;
    }>;
  };
  Environment: string;
} & Partial<Record<DailyUsageRollupMetricName, number>>;

/**
 * CloudWatch EMF record for one rollup run, or null when there is nothing to publish. Only
 * nonzero counters are declared as metrics: an all-zero series bills like an active one, and
 * the run's JSON log line already carries every counter, zeros included (see #539).
 */
export function dailyUsageRollupMetricRecord(
  counts: { shadowMismatches: number; failedSchools: number },
  options: { environment: string; timestamp: number }
): DailyUsageRollupMetricRecord | null {
  const values: Partial<Record<DailyUsageRollupMetricName, number>> = {};
  if (counts.shadowMismatches > 0) values.DailyUsageRollupShadowMismatch = counts.shadowMismatches;
  if (counts.failedSchools > 0) values.DailyUsageRollupFailedSchools = counts.failedSchools;
  const names = DAILY_USAGE_ROLLUP_METRIC_NAMES.filter((name) => values[name] !== undefined);
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
