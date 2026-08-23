import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

export type DailyUsageAggregate = {
  studentId: string;
  totalSeconds: number;
  heartbeatCount: number;
  topDomains: Array<{ domain: string; seconds: number; visits: number }>;
  firstSeen: Date | string | null;
  lastSeen: Date | string | null;
};

const AGGREGATION_CTES = `
WITH heartbeat_window AS MATERIALIZED (
  SELECT student_id, timestamp, active_tab_url
  FROM heartbeats
  WHERE school_id = $1
    AND timestamp >= $2
    AND timestamp < $3
),
student_totals AS MATERIALIZED (
  SELECT
    student_id,
    COUNT(*)::int AS heartbeat_count,
    (COUNT(*) * 10)::int AS total_seconds,
    MIN(timestamp) AS first_seen,
    MAX(timestamp) AS last_seen
  FROM heartbeat_window
  GROUP BY student_id
),
domain_counts AS MATERIALIZED (
  SELECT
    student_id,
    SUBSTRING(active_tab_url FROM '://([^/]+)') AS domain,
    (COUNT(*) * 10)::int AS seconds,
    COUNT(*)::int AS visits
  FROM heartbeat_window
  WHERE active_tab_url IS NOT NULL
  GROUP BY student_id, SUBSTRING(active_tab_url FROM '://([^/]+)')
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
  totals.first_seen,
  totals.last_seen
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
  first_seen,
  last_seen`;

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
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

export async function readSetBasedDailyUsageCandidate(
  queryable: Queryable,
  options: { schoolId: string; dayStartUtc: Date; dayEndUtc: Date }
): Promise<DailyUsageAggregate[]> {
  const result = await queryable.query<RawAggregate>(
    CLASSPILOT_DAILY_USAGE_CANDIDATE_SQL,
    [options.schoolId, options.dayStartUtc, options.dayEndUtc]
  );
  return result.rows.map(mapAggregate);
}

export async function upsertSetBasedDailyUsage(
  queryable: Queryable,
  options: { schoolId: string; date: string; dayStartUtc: Date; dayEndUtc: Date }
): Promise<DailyUsageAggregate[]> {
  const result = await queryable.query<RawAggregate>(
    CLASSPILOT_DAILY_USAGE_UPSERT_SQL,
    [options.schoolId, options.dayStartUtc, options.dayEndUtc, options.date]
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
