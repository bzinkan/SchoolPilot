import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { isScheduledClassroomEnabled, type ClasspilotActivityAuthority } from "./classpilotActivityAuthority.js";
import { classpilotSupervisionPreviewObserved } from "../config/classpilotSupervisionPreviewRollout.js";

/** Current Dashboard history uses the same parent and roster as its tiles.
 * No login/device is required: assigned offline students keep their history. */
export async function readActivityHistoryScope(options: {
  schoolId: string; staffId: string; studentId: string; allowObserve: boolean;
  authority: ClasspilotActivityAuthority; contextAuthorityRevision?: string;
}) {
  const { schoolId, staffId, studentId, allowObserve, authority } = options;
  if (authority.supervisionContextId
    && !isScheduledClassroomEnabled(schoolId) && !classpilotSupervisionPreviewObserved(schoolId)) return null;
  const result = await db.execute<{ stamp: string; start_ms: number; end_ms: number }>(authority.supervisionContextId ? sql`
    SELECT assignment.id || ':' || context.assigned_staff_id || ':' || context.classroom_authority_revision::text || ':' ||
        COALESCE(tenure.id, context.updated_at::text) AS stamp,
      extract(epoch from GREATEST(context.starts_at AT TIME ZONE 'UTC', assignment.assigned_at AT TIME ZONE 'UTC',
        COALESCE(tenure.window_start, CASE WHEN context.classroom_authority_revision=0
          THEN context.starts_at AT TIME ZONE 'UTC' ELSE context.updated_at AT TIME ZONE 'UTC' END)))::double precision * 1000 AS start_ms,
      extract(epoch from LEAST(context.ends_at AT TIME ZONE 'UTC', clock_timestamp()))::double precision * 1000 AS end_ms
    FROM classpilot_supervision_contexts context
    JOIN classpilot_supervision_students assignment ON assignment.school_id=context.school_id
      AND assignment.context_id=context.id AND assignment.student_id=${studentId} AND assignment.released_at IS NULL
    JOIN students student ON student.id=assignment.student_id AND student.school_id=context.school_id AND student.status='active'
    JOIN classpilot_student_control_states control ON control.school_id=context.school_id AND control.student_id=student.id
      AND control.supervision_context_id=context.id AND control.teaching_session_id IS NULL
    LEFT JOIN classpilot_supervision_report_segments tenure ON tenure.school_id=context.school_id AND tenure.context_id=context.id
      AND tenure.staff_id=context.assigned_staff_id AND tenure.state='active' AND tenure.window_end IS NULL
    WHERE context.school_id=${schoolId} AND context.id=${authority.supervisionContextId}
      AND context.classroom_authority_revision::text=${options.contextAuthorityRevision ?? null}
      AND (${allowObserve} OR context.assigned_staff_id=${staffId})
      AND context.status='active' AND context.starts_at AT TIME ZONE 'UTC' <= clock_timestamp()
      AND context.ends_at AT TIME ZONE 'UTC' > clock_timestamp()
    LIMIT 1
  ` : sql`
    SELECT roster.id || ':' || session.id AS stamp,
      extract(epoch from GREATEST(session.start_time AT TIME ZONE 'UTC', roster.captured_at))::double precision * 1000 AS start_ms,
      extract(epoch from LEAST(COALESCE(session.scheduled_end_at, 'infinity'::timestamptz), clock_timestamp()))::double precision * 1000 AS end_ms
    FROM teaching_sessions session
    JOIN classpilot_session_students roster ON roster.school_id=session.school_id AND roster.teaching_session_id=session.id
      AND roster.student_id=${studentId}
    JOIN students student ON student.id=roster.student_id AND student.school_id=session.school_id AND student.status='active'
    JOIN classpilot_student_control_states control ON control.school_id=session.school_id AND control.student_id=student.id
      AND control.teaching_session_id=session.id AND control.supervision_context_id IS NULL
    WHERE session.school_id=${schoolId} AND session.id=${authority.teachingSessionId}
      AND session.session_mode='live' AND session.end_time IS NULL
      AND session.start_time AT TIME ZONE 'UTC' <= clock_timestamp()
      AND (session.scheduled_end_at IS NULL OR session.scheduled_end_at > clock_timestamp())
      AND (${allowObserve} OR EXISTS (SELECT 1 FROM classpilot_session_staff staff
        WHERE staff.school_id=session.school_id AND staff.teaching_session_id=session.id AND staff.staff_id=${staffId}))
      AND NOT EXISTS (SELECT 1 FROM classpilot_supervision_students assignment
        JOIN classpilot_supervision_contexts context ON context.school_id=assignment.school_id AND context.id=assignment.context_id
        WHERE assignment.school_id=session.school_id AND assignment.student_id=student.id AND assignment.released_at IS NULL
          AND context.status='active' AND context.starts_at AT TIME ZONE 'UTC' <= clock_timestamp()
          AND context.ends_at AT TIME ZONE 'UTC' > clock_timestamp())
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row || !Number.isFinite(row.start_ms) || !Number.isFinite(row.end_ms)) return null;
  return { stamp: row.stamp, from: new Date(row.start_ms), to: new Date(row.end_ms) };
}
