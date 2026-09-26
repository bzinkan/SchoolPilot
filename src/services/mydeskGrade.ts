import { sql, type SQLWrapper } from "drizzle-orm";

/** Shared normalization for filing identities, never derived from class names. */
export function normalizeMyDeskGrade(value: string | null | undefined): string | null {
  const grade = (value || "").trim().replace(/^grade\s+/i, "").replace(/(\d+)(st|nd|rd|th)$/i, "$1").toUpperCase();
  return grade && grade.length <= 40 ? grade : null;
}
export function myDeskGradeSql(column: SQLWrapper) {
  return sql`NULLIF(upper(regexp_replace(regexp_replace(btrim(${column}), '^grade\\s+', '', 'i'), '(\\d+)(st|nd|rd|th)$', '\\1', 'i')), '')`;
}
