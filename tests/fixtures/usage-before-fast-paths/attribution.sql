-- Frozen read-only pre-fast-path reference at d9c45d77cb44d5ef1fa640610b495e4edc01284a.
WITH school_sessions AS MATERIALIZED (
  SELECT id, start_time, end_time, scheduled_end_at
  FROM teaching_sessions
  WHERE school_id = $1
    AND start_time < $3::timestamp
    AND start_time >= $2::timestamp - interval '12 hours'
),
school_roster_window AS MATERIALIZED (
  SELECT roster.student_id, roster.group_id AS class_id, session.id AS session_id, session.start_time,
    GREATEST(session.start_time, roster.captured_at AT TIME ZONE 'UTC') AS starts_at,
    LEAST(
      COALESCE(session.end_time, 'infinity'::timestamp),
      COALESCE(session.scheduled_end_at AT TIME ZONE 'UTC', 'infinity'::timestamp),
      session.start_time + interval '12 hours'
    ) AS ends_at
  FROM school_sessions AS session
  JOIN classpilot_session_students AS roster
    ON roster.teaching_session_id = session.id AND roster.school_id = $1
  JOIN groups AS class
    ON class.id = roster.group_id AND class.school_id = $1
),
grains AS (
  -- Forced tenant RLS can substantially underestimate school cardinality.
  -- Correlating the timeline and roster to one student bounds any nested-loop
  -- plan to that student's observations and sessions instead of the school.
  SELECT student_grains.*
  FROM students AS student_scope
  CROSS JOIN LATERAL (
WITH observed AS MATERIALIZED (
  SELECT heartbeat.id, heartbeat.student_id, heartbeat."timestamp" AS observed_at,
    heartbeat.active_tab_url, heartbeat.ai_category, heartbeat.teacher_intent_source
  FROM heartbeats AS heartbeat
  WHERE heartbeat.school_id = $1
    AND heartbeat.student_id IS NOT NULL
    AND heartbeat."timestamp" >= $2::timestamp
    AND heartbeat."timestamp" < $3::timestamp
    AND heartbeat.student_id = student_scope.id
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
  SELECT decision.heartbeat_id, decision.category,
    decision.teacher_intent_source
  FROM deduplicated AS observation
  CROSS JOIN LATERAL (
    SELECT newest.heartbeat_id, newest.category, newest.teacher_intent_source
    FROM classpilot_ai_decisions AS newest
    WHERE newest.school_id = $1
      AND newest.heartbeat_id = observation.id
      AND newest.created_at >= $2::timestamp
    ORDER BY newest.created_at DESC, newest.id DESC
    LIMIT 1
  ) AS decision
),
normalized AS (
  SELECT observation.id, observation.student_id, observation.observed_at,
    LEAST(
      15::numeric,
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
  SELECT * FROM school_roster_window
  WHERE student_id = student_scope.id
),
roster_boundaries AS (
  SELECT student_id, starts_at AS at FROM roster_window WHERE starts_at < ends_at
  UNION
  SELECT student_id, ends_at AS at FROM roster_window WHERE starts_at < ends_at
),
roster_intervals AS MATERIALIZED (
  SELECT student_id, at AS starts_at, LEAD(at) OVER (PARTITION BY student_id ORDER BY at) AS ends_at
  FROM roster_boundaries
),
winning_roster AS MATERIALIZED (
  -- Resolve overlapping frozen sessions once per roster interval instead of
  -- sorting every heartbeat by its candidate sessions. Boundaries are disjoint
  -- for each student; observations can match at most one winning interval.
  SELECT DISTINCT ON (roster_intervals.student_id, roster_intervals.starts_at)
    roster_intervals.student_id, roster_intervals.starts_at, roster_intervals.ends_at,
    roster_window.class_id, roster_window.session_id
  FROM roster_intervals
  JOIN roster_window ON roster_window.student_id = roster_intervals.student_id
    AND roster_intervals.starts_at >= roster_window.starts_at
    AND roster_intervals.starts_at < roster_window.ends_at
  WHERE roster_intervals.ends_at IS NOT NULL
  ORDER BY roster_intervals.student_id, roster_intervals.starts_at,
    roster_window.start_time DESC, roster_window.session_id DESC
),
attributed AS (
  SELECT classified.student_id, classified.attributed_seconds,
    classified.domain, classified.classification, winning_roster.class_id, winning_roster.session_id
  FROM classified
  LEFT JOIN winning_roster
    ON winning_roster.student_id = classified.student_id
    AND classified.observed_at >= winning_roster.starts_at
    AND classified.observed_at < winning_roster.ends_at
)
SELECT attributed.student_id, attributed.class_id, attributed.session_id,
  attributed.domain, attributed.classification,
  ROUND(SUM(GREATEST(attributed.attributed_seconds, 0)))::int AS seconds,
  COUNT(*)::int AS heartbeat_count
FROM attributed
GROUP BY attributed.student_id, attributed.class_id, attributed.session_id,
  attributed.domain, attributed.classification
  ) AS student_grains
  WHERE student_scope.school_id = $1
) SELECT $4::date AS usage_date,grains.* FROM grains ORDER BY student_id,COALESCE(class_id,''),COALESCE(session_id,''),domain,classification;
