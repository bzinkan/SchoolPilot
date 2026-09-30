-- Immutable read-only attribution/grouping reference from source 330148bc (rollup unchanged since 50fd8dad).
WITH observed AS MATERIALIZED (
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
      )), '^www\.', ''), 253)
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
grain AS (SELECT student_id,class_id,session_id,domain,classification,ROUND(SUM(GREATEST(attributed_seconds,0)))::int AS seconds,COUNT(*)::int AS heartbeats FROM attributed GROUP BY student_id,class_id,session_id,domain,classification) SELECT $4::date AS usage_date,COUNT(*)::bigint AS rows,SUM(seconds) AS seconds,SUM(heartbeats) AS heartbeats FROM grain