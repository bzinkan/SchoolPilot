-- Frozen read-only pre-fast-path reference at d9c45d77cb44d5ef1fa640610b495e4edc01284a.

    WITH scoped AS MATERIALIZED (
    SELECT rollup.usage_date, rollup.student_id, rollup.domain, rollup.classification,
      rollup.seconds, rollup.heartbeat_count
    FROM classpilot_usage_rollups AS rollup
    JOIN classpilot_usage_rollup_days AS day
      ON day.school_id = rollup.school_id AND day.usage_date = rollup.usage_date
    WHERE rollup.school_id = $1
      AND rollup.usage_date >= $2::date
      AND rollup.usage_date <= $3::date

      AND ($5::text[] IS NULL OR rollup.student_id=ANY($5::text[]))
      AND ($6::text IS NULL OR rollup.class_id=$6)
    ), student_days AS (
      SELECT usage_date, student_id, SUM(seconds)::bigint AS monitored,
        SUM(seconds) FILTER (WHERE classification = 'educational')::bigint AS instructional,
        SUM(seconds) FILTER (WHERE classification = 'non-educational')::bigint AS off_task,
        SUM(seconds) FILTER (WHERE classification = 'unknown')::bigint AS unknown,
        SUM(heartbeat_count)::bigint AS heartbeats
      FROM scoped GROUP BY usage_date, student_id
    ), summary AS (
      SELECT usage_date::text AS usage_date, GROUPING(usage_date) AS total_row,
        COALESCE(SUM(monitored), 0)::bigint AS monitored,
        COALESCE(SUM(instructional), 0)::bigint AS instructional,
        COALESCE(SUM(off_task), 0)::bigint AS off_task,
        COALESCE(SUM(unknown), 0)::bigint AS unknown,
        COUNT(DISTINCT student_id)::int AS students,
        COALESCE(SUM(heartbeats), 0)::bigint AS heartbeats
      FROM student_days GROUP BY GROUPING SETS ((usage_date), ())
    ), domains AS (
      SELECT classification, domain, SUM(seconds)::bigint AS seconds
      FROM scoped
      WHERE classification IN ('educational', 'non-educational') AND domain <> ''
      GROUP BY classification, domain HAVING SUM(seconds) > 0
    ), ranked_domains AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY classification ORDER BY seconds DESC, domain ASC) AS rank
      FROM domains
    )
    SELECT 'summary' AS row_kind, summary.*, NULL::text AS classification,
      NULL::text AS domain, NULL::bigint AS seconds FROM summary
    UNION ALL
    SELECT 'domain', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      classification, domain, seconds FROM ranked_domains
      WHERE rank <= $4
    ORDER BY row_kind, classification, seconds DESC, domain ASC
  ;
