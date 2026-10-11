import { historyError, historyScopeHash } from "./classpilotBrowsingHistoryModel.js";

type LookupCursor = { v: 1; scope: string; name: string; id: string };

function lookupFilter(value: unknown, maximumLength: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw historyError("HISTORY_FILTER_INVALID", "Choose a grade or class from the available filters.");
  }
  const filter = value.trim();
  if (filter.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw historyError("HISTORY_FILTER_INVALID", "Choose a grade or class from the available filters.");
  }
  return filter || null;
}

export function resolveHistoryLookup(input: {
  schoolId: string; actorId: string; role: string;
  search?: unknown; limit?: unknown; cursor?: unknown; classId?: unknown; grade?: unknown;
}) {
  if (input.search !== undefined && typeof input.search !== "string") {
    throw historyError("HISTORY_SEARCH_INVALID", "Search by a student name or email.");
  }
  const search = String(input.search ?? "").trim().toLowerCase();
  if (search.length > 150 || /[\u0000-\u001f\u007f]/.test(search)) {
    throw historyError("HISTORY_SEARCH_INVALID", "Use a search of at most 150 characters.");
  }
  if (input.limit !== undefined && !["number", "string"].includes(typeof input.limit)) {
    throw historyError("HISTORY_LIMIT_INVALID", "History search page size must be a positive integer.");
  }
  const requested = input.limit === undefined ? 50 : Number(input.limit);
  if (!Number.isInteger(requested) || requested < 1) {
    throw historyError("HISTORY_LIMIT_INVALID", "History search page size must be a positive integer.");
  }
  const limit = Math.min(100, requested);
  const classId = lookupFilter(input.classId, 256);
  const grade = lookupFilter(input.grade, 100);
  // Keep already-open unfiltered pages compatible during rolling deployments.
  const scope = historyScopeHash(classId || grade
    ? ["history-student-lookup-v2", input.schoolId, input.actorId, input.role, search, classId, grade]
    : ["history-student-lookup-v1", input.schoolId, input.actorId, input.role, search]);
  let cursor: LookupCursor | null = null;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (!value || typeof value !== "object") throw new Error();
      const row = value as Partial<LookupCursor>;
      if (row.v !== 1 || row.scope !== scope || typeof row.name !== "string" || row.name.length > 256 || typeof row.id !== "string" || !row.id || row.id.length > 256) throw new Error();
      cursor = { v: 1, scope, name: row.name, id: row.id };
    } catch {
      throw historyError("HISTORY_CURSOR_INVALID", "This student search cursor is invalid or belongs to another search.");
    }
  }
  return { search, limit, scope, cursor, classId, grade };
}

export function encodeHistoryLookupCursor(scope: string, name: string, id: string) {
  return Buffer.from(JSON.stringify({ v: 1, scope, name, id })).toString("base64url");
}
