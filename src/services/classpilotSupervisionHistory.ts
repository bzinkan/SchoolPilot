import { sql, type SQL } from "drizzle-orm";

/** A retained tombstone still prevents falling back to a context's new owner. */
export function supervisionContextHasReportsSql(schoolId: string, contextId: string | SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM classpilot_supervision_report_segments AS tracked
    WHERE tracked.school_id=${schoolId} AND tracked.context_id=${contextId})`;
}

export function retainedSupervisionStaffSql(options: {
  schoolId: string; contextId: string; staffId: string; now: Date;
}): SQL {
  return sql`EXISTS (SELECT 1 FROM classpilot_supervision_report_segments AS tenure
    WHERE tenure.school_id=${options.schoolId} AND tenure.context_id=${options.contextId}
      AND tenure.staff_id=${options.staffId} AND tenure.detail_expired_at IS NULL
      AND tenure.state <> 'expired'
      AND (tenure.expires_at IS NULL OR tenure.expires_at>${options.now.toISOString()}::timestamptz))`;
}

/** Filter before pagination; a new supervisor cannot inherit earlier events. */
export function supervisionEventOwnershipSql(options: {
  schoolId: string; contextId: string | SQL; staffId: string; studentId: SQL; occurredAt: SQL; now: Date;
}): SQL {
  return sql`(
    (NOT ${supervisionContextHasReportsSql(options.schoolId, options.contextId)}
      AND EXISTS (SELECT 1 FROM classpilot_supervision_contexts AS legacy
        WHERE legacy.school_id=${options.schoolId} AND legacy.id=${options.contextId}
          AND legacy.assigned_staff_id=${options.staffId}))
    OR EXISTS (
      SELECT 1 FROM classpilot_supervision_report_segments AS tenure
      INNER JOIN classpilot_supervision_student_reports AS detail
        ON detail.school_id=tenure.school_id AND detail.report_id=tenure.id
      INNER JOIN classpilot_supervision_contexts AS context
        ON context.school_id=tenure.school_id AND context.id=tenure.context_id
      CROSS JOIN LATERAL jsonb_array_elements(detail.participation_intervals) AS participation(value)
      WHERE tenure.school_id=${options.schoolId} AND tenure.context_id=${options.contextId}
        AND tenure.staff_id=${options.staffId} AND detail.student_id=${options.studentId}
        AND tenure.detail_expired_at IS NULL AND tenure.state <> 'expired'
        AND (tenure.expires_at IS NULL OR tenure.expires_at>${options.now.toISOString()}::timestamptz)
        AND ${options.occurredAt} >= GREATEST(tenure.window_start,(participation.value->>'start')::timestamptz)
        AND ${options.occurredAt} < LEAST(
          COALESCE((participation.value->>'end')::timestamptz,'infinity'::timestamptz),
          COALESCE(tenure.window_end,'infinity'::timestamptz),
          COALESCE(context.ended_at AT TIME ZONE 'UTC','infinity'::timestamptz),
          context.ends_at AT TIME ZONE 'UTC',${options.now.toISOString()}::timestamptz)
    ))`;
}
