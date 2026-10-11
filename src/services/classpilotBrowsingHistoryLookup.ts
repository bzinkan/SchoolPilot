import { eq, sql } from "drizzle-orm";
import db from "../db.js";
import { settings } from "../schema/shared.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import { historyError } from "./classpilotBrowsingHistoryModel.js";
import { encodeHistoryLookupCursor, resolveHistoryLookup } from "./classpilotBrowsingHistoryLookupModel.js";
import { classpilotStudentHistoryAuthorityQueries, type ClasspilotStudentDataRole } from "./classpilotStudentData.js";

/** Independent of live dashboards and aggregate reports; authority is reapplied before every page. */
export async function findStudentBrowsingHistory(input: {
  schoolId: string; actorId: string; role: ClasspilotStudentDataRole;
  search?: unknown; limit?: unknown; cursor?: unknown; now?: Date;
}) {
  if (!["admin", "school_admin", "teacher"].includes(input.role)) {
    throw historyError("HISTORY_DENIED", "School staff access is required.", 403);
  }
  const { search, limit, scope, cursor } = resolveHistoryLookup(input);
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
  const rows = await db.execute<{ student_id: string; name: string; email: string | null; sort_name: string }>(sql`
    WITH named_students AS (
      SELECT id AS student_id,
        COALESCE(NULLIF(BTRIM(CONCAT_WS(' ',first_name,last_name)),''),'Unknown student') AS name,
        NULLIF(BTRIM(email),'') AS email
      FROM students WHERE school_id=${input.schoolId}
    ), lookup_students AS (
      SELECT *, LOWER(LEFT(name,256)) COLLATE "C" AS sort_name FROM named_students
      WHERE (${search}='' OR STRPOS(LOWER(name),${search})>0 OR STRPOS(LOWER(COALESCE(email,'')),${search})>0)
        ${cursor ? sql`AND (LOWER(LEFT(name,256)) COLLATE "C",student_id COLLATE "C")>(${cursor.name} COLLATE "C",${cursor.id} COLLATE "C")` : sql``}
    ) ${teacherAuthority}
    SELECT lookup_students.student_id, name, email, sort_name FROM lookup_students ${teacherJoins}
    WHERE true ${teacherPredicate}
    ORDER BY sort_name COLLATE "C",lookup_students.student_id COLLATE "C" LIMIT ${limit + 1}
  `);
  const page = rows.rows.slice(0, limit);
  const hasMore = rows.rows.length > limit;
  const last = page.at(-1);
  return {
    students: page.map(row => ({ studentId: row.student_id, name: row.name, email: row.email })),
    nextCursor: hasMore && last ? encodeHistoryLookupCursor(scope, last.sort_name, last.student_id) : null,
    hasMore,
  };
}
