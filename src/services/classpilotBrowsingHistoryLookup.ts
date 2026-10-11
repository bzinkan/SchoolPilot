import { eq, sql } from "drizzle-orm";
import db from "../db.js";
import { settings } from "../schema/shared.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import { historyError } from "./classpilotBrowsingHistoryModel.js";
import { encodeHistoryLookupCursor, resolveHistoryLookup } from "./classpilotBrowsingHistoryLookupModel.js";
import { classpilotStudentHistoryAuthorityQueries, type ClasspilotStudentDataRole } from "./classpilotStudentData.js";

type LookupStudent = { student_id: string; name: string; email: string | null; sort_name: string };
type HistoryClassFilter = { classId: string; name: string; gradeLevel: string | null; grades: string[] };

/** Independent of live dashboards and aggregate reports; authority is reapplied before every page. */
export async function findStudentBrowsingHistory(input: {
  schoolId: string; actorId: string; role: ClasspilotStudentDataRole;
  search?: unknown; limit?: unknown; cursor?: unknown; classId?: unknown; grade?: unknown; now?: Date;
}) {
  if (!["admin", "school_admin", "teacher"].includes(input.role)) {
    throw historyError("HISTORY_DENIED", "School staff access is required.", 403);
  }
  const { search, limit, scope, cursor, classId, grade } = resolveHistoryLookup(input);
  const now = input.now || new Date();
  const [policy] = await db.select({ retentionHours: settings.retentionHours })
    .from(settings).where(eq(settings.schoolId, input.schoolId)).limit(1);
  const retentionCutoff = new Date(now.getTime() - parseClasspilotRetentionDays(policy?.retentionHours) * 86400000);
  const queries = classpilotStudentHistoryAuthorityQueries({
    ...input, now, retentionCutoff,
    studentId: sql`ANY (SELECT student_id FROM lookup_students)`,
  });
  // tstzmultirange performs the same union/subtraction as the detailed URL reader,
  // before LIMIT. No per-student requests or current roster assignments grant access.
  const teacherAuthority = input.role === "teacher" ? sql`
    , class_intervals AS (${queries.sessions}), delegated_intervals AS (${queries.supervision}),
    own_intervals AS (
      SELECT student_id, start, "end" FROM delegated_intervals
        WHERE legacy_ownership AND assigned_staff_id=${input.actorId}
      ${queries.recorded ? sql`UNION ALL SELECT student_id, start, "end" FROM (${queries.recorded}) AS recorded` : sql``}
    ), class_access AS (
      SELECT student_id, range_agg(tstzrange(GREATEST(start,${retentionCutoff.toISOString()}::timestamptz),"end",'[)')) AS windows
      FROM class_intervals WHERE "end">GREATEST(start,${retentionCutoff.toISOString()}::timestamptz) GROUP BY student_id
    ), delegated_access AS (
      SELECT student_id, range_agg(tstzrange(GREATEST(start,${retentionCutoff.toISOString()}::timestamptz),"end",'[)')) AS windows
      FROM delegated_intervals WHERE "end">GREATEST(start,${retentionCutoff.toISOString()}::timestamptz) GROUP BY student_id
    ), own_access AS (
      SELECT student_id, range_agg(tstzrange(GREATEST(start,${retentionCutoff.toISOString()}::timestamptz),"end",'[)')) AS windows
      FROM own_intervals WHERE "end">GREATEST(start,${retentionCutoff.toISOString()}::timestamptz) GROUP BY student_id
    )
  ` : sql``;
  const teacherJoins = input.role === "teacher" ? sql`
    LEFT JOIN class_access USING(student_id) LEFT JOIN delegated_access USING(student_id) LEFT JOIN own_access USING(student_id)
  ` : sql``;
  const teacherPredicate = input.role === "teacher" ? sql`AND NOT isempty(
    (COALESCE(class_access.windows,'{}'::tstzmultirange)-COALESCE(delegated_access.windows,'{}'::tstzmultirange))
      +COALESCE(own_access.windows,'{}'::tstzmultirange)
  )` : sql``;
  // Options and membership filters share this statement's snapshot. Current
  // official assignments only narrow discovery; the retained authority below
  // still decides which student identities a teacher can receive.
  const result = await db.execute<{
    class_options: HistoryClassFilter[]; grades: string[]; filters_allowed: boolean; student_rows: LookupStudent[];
  }>(sql`
    WITH eligible_classes AS (
      SELECT class_group.id AS class_id,
        COALESCE(NULLIF(BTRIM(class_group.name),''),'Unnamed class') AS name,
        NULLIF(BTRIM(class_group.grade_level),'') AS grade_level
      FROM groups class_group
      WHERE class_group.school_id=${input.schoolId}
        AND class_group.group_type='admin_class' AND class_group.status='active'
        ${input.role === "teacher" ? sql`AND (
          class_group.teacher_id=${input.actorId} OR EXISTS (
            SELECT 1 FROM group_teachers assigned_teacher
            WHERE assigned_teacher.group_id=class_group.id AND assigned_teacher.teacher_id=${input.actorId}
              AND assigned_teacher.role IN ('primary','co-teacher')
          )
        )` : sql``}
    ), eligible_roster AS (
      SELECT roster.student_id, eligible_classes.class_id, eligible_classes.grade_level AS class_grade,
        NULLIF(BTRIM(student.grade_level),'') AS student_grade
      FROM eligible_classes
      INNER JOIN group_students roster ON roster.group_id=eligible_classes.class_id
      INNER JOIN students student ON student.id=roster.student_id AND student.school_id=${input.schoolId}
    ), class_grade_candidates AS (
      SELECT class_id, grade_level AS grade FROM eligible_classes
      UNION
      SELECT class_id, student_grade AS grade FROM eligible_roster
    ), class_grades AS (
      SELECT class_id, grade FROM class_grade_candidates
      WHERE grade IS NOT NULL AND LENGTH(grade)<=100 AND grade !~ '[[:cntrl:]]'
    ), class_grade_options AS (
      SELECT class_id, jsonb_agg(grade ORDER BY
        CASE WHEN grade='PK' THEN 0 WHEN grade='K' THEN 1 WHEN grade ~ '^(?:[1-9]|1[0-2])$' THEN grade::integer+2 ELSE 100 END,
        grade COLLATE "C") AS grades
      FROM class_grades GROUP BY class_id
    ), grade_candidates AS (
      SELECT DISTINCT grade FROM class_grades
      ${input.role === "teacher" ? sql`` : sql`UNION
        SELECT NULLIF(BTRIM(grade_level),'') AS grade FROM students WHERE school_id=${input.schoolId}`}
    ), eligible_grades AS (
      SELECT grade FROM grade_candidates WHERE grade IS NOT NULL AND LENGTH(grade)<=100 AND grade !~ '[[:cntrl:]]'
    ), allowed_filters AS (
      SELECT (${classId}::text IS NULL OR EXISTS (SELECT 1 FROM eligible_classes WHERE class_id=${classId}))
        AND (${grade}::text IS NULL OR EXISTS (SELECT 1 FROM eligible_grades WHERE eligible_grades.grade=${grade})) AS allowed
    ), named_students AS (
      SELECT student.id AS student_id,
        COALESCE(NULLIF(BTRIM(CONCAT_WS(' ',student.first_name,student.last_name)),''),'Unknown student') AS name,
        NULLIF(BTRIM(student.email),'') AS email
      FROM students student WHERE student.school_id=${input.schoolId}
        AND (SELECT allowed FROM allowed_filters)
        ${classId ? sql`AND EXISTS (
          SELECT 1 FROM eligible_roster WHERE eligible_roster.student_id=student.id AND eligible_roster.class_id=${classId}
        )` : sql``}
        ${grade ? input.role === "teacher" ? sql`AND EXISTS (
          SELECT 1 FROM eligible_roster WHERE eligible_roster.student_id=student.id
            ${classId ? sql`AND eligible_roster.class_id=${classId}` : sql``}
            AND (eligible_roster.student_grade=${grade} OR eligible_roster.class_grade=${grade})
        )` : sql`AND (NULLIF(BTRIM(student.grade_level),'')=${grade} OR EXISTS (
          SELECT 1 FROM eligible_roster WHERE eligible_roster.student_id=student.id AND eligible_roster.class_grade=${grade}
            ${classId ? sql`AND eligible_roster.class_id=${classId}` : sql``}
        ))` : sql``}
    ), lookup_students AS (
      SELECT *, LOWER(LEFT(name,256)) COLLATE "C" AS sort_name FROM named_students
      WHERE (${search}='' OR STRPOS(LOWER(name),${search})>0 OR STRPOS(LOWER(COALESCE(email,'')),${search})>0)
        ${cursor ? sql`AND (LOWER(LEFT(name,256)) COLLATE "C",student_id COLLATE "C")>(${cursor.name} COLLATE "C",${cursor.id} COLLATE "C")` : sql``}
    ) ${teacherAuthority}, page_rows AS (
      SELECT lookup_students.student_id, name, email, sort_name FROM lookup_students ${teacherJoins}
      WHERE true ${teacherPredicate}
      ORDER BY sort_name COLLATE "C",lookup_students.student_id COLLATE "C" LIMIT ${limit + 1}
    )
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('classId',class_id,'name',name,'gradeLevel',grade_level,
        'grades',COALESCE(class_grade_options.grades,'[]'::jsonb))
        ORDER BY LOWER(name) COLLATE "C",class_id COLLATE "C") FROM eligible_classes
        LEFT JOIN class_grade_options USING(class_id)),'[]'::jsonb) AS class_options,
      COALESCE((SELECT jsonb_agg(grade ORDER BY
        CASE WHEN grade='PK' THEN 0 WHEN grade='K' THEN 1 WHEN grade ~ '^(?:[1-9]|1[0-2])$' THEN grade::integer+2 ELSE 100 END,
        grade COLLATE "C") FROM eligible_grades),'[]'::jsonb) AS grades,
      (SELECT allowed FROM allowed_filters) AS filters_allowed,
      COALESCE((SELECT jsonb_agg(to_jsonb(page_rows) ORDER BY sort_name COLLATE "C",student_id COLLATE "C") FROM page_rows),'[]'::jsonb) AS student_rows
  `);
  const lookup = result.rows[0];
  if (!lookup) throw historyError("HISTORY_UNAVAILABLE", "Student browsing history lookup is unavailable.", 503);
  if (!lookup.filters_allowed) {
    throw historyError("HISTORY_FILTER_DENIED", "This grade or class is no longer available. Refresh the browsing history filters.", 403);
  }
  const page = lookup.student_rows.slice(0, limit);
  const hasMore = lookup.student_rows.length > limit;
  const last = page.at(-1);
  return {
    students: page.map(row => ({ studentId: row.student_id, name: row.name, email: row.email })),
    nextCursor: hasMore && last ? encodeHistoryLookupCursor(scope, last.sort_name, last.student_id) : null,
    hasMore,
    filterOptions: { classes: lookup.class_options, grades: lookup.grades },
  };
}
