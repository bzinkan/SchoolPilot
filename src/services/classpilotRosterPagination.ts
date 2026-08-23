import { and, asc, eq, gt, ilike, or, type SQL } from "drizzle-orm";
import db from "../db.js";
import { students, type Student } from "../schema/students.js";

const DEFAULT_ROSTER_PAGE_SIZE = 100;
export const MAX_ROSTER_PAGE_SIZE = 200;
const MAX_ROSTER_SEARCH_LENGTH = 100;
const MAX_CURSOR_LENGTH = 2_048;

type RosterCursor = {
  lastName: string;
  firstName: string;
  id: string;
};

export class InvalidRosterCursorError extends Error {
  readonly code = "INVALID_ROSTER_CURSOR";

  constructor(message = "Invalid roster cursor") {
    super(message);
    this.name = "InvalidRosterCursorError";
  }
}

function isBoundedCursorPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function encodeClasspilotRosterCursor(student: Pick<Student, "id" | "firstName" | "lastName">): string {
  return Buffer.from(JSON.stringify({
    lastName: student.lastName,
    firstName: student.firstName,
    id: student.id,
  } satisfies RosterCursor), "utf8").toString("base64url");
}

export function decodeClasspilotRosterCursor(value: string): RosterCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH) throw new InvalidRosterCursorError();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RosterCursor>;
    if (
      !isBoundedCursorPart(parsed.lastName)
      || !isBoundedCursorPart(parsed.firstName)
      || !isBoundedCursorPart(parsed.id)
    ) {
      throw new InvalidRosterCursorError();
    }
    return {
      lastName: parsed.lastName,
      firstName: parsed.firstName,
      id: parsed.id,
    };
  } catch (error) {
    if (error instanceof InvalidRosterCursorError) throw error;
    throw new InvalidRosterCursorError();
  }
}

export function parseClasspilotRosterLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_ROSTER_PAGE_SIZE;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new InvalidRosterCursorError("limit must be an integer between 1 and 200");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROSTER_PAGE_SIZE) {
    throw new InvalidRosterCursorError("limit must be an integer between 1 and 200");
  }
  return limit;
}

export function parseClasspilotRosterSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidRosterCursorError("search must be a string");
  }
  const search = value.trim();
  if (search.length > MAX_ROSTER_SEARCH_LENGTH) {
    throw new InvalidRosterCursorError("search must be at most 100 characters");
  }
  return search || undefined;
}

export async function listClasspilotRosterStudentsPage(options: {
  schoolId: string;
  cursor?: string;
  limit?: string;
  search?: string;
  dbInstance?: typeof db;
}): Promise<{
  students: Student[];
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const dbInstance = options.dbInstance || db;
  const limit = parseClasspilotRosterLimit(options.limit);
  const search = parseClasspilotRosterSearch(options.search);
  const cursor = options.cursor === undefined
    ? undefined
    : decodeClasspilotRosterCursor(options.cursor);
  const conditions: SQL[] = [
    eq(students.schoolId, options.schoolId),
    eq(students.status, "active"),
  ];

  if (search) {
    const pattern = `%${search}%`;
    conditions.push(or(
      ilike(students.firstName, pattern),
      ilike(students.lastName, pattern),
      ilike(students.email, pattern),
      ilike(students.gradeLevel, pattern)
    )!);
  }

  if (cursor) {
    conditions.push(or(
      gt(students.lastName, cursor.lastName),
      and(
        eq(students.lastName, cursor.lastName),
        gt(students.firstName, cursor.firstName)
      ),
      and(
        eq(students.lastName, cursor.lastName),
        eq(students.firstName, cursor.firstName),
        gt(students.id, cursor.id)
      )
    )!);
  }

  const rows = await dbInstance
    .select()
    .from(students)
    .where(and(...conditions))
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    students: page,
    limit,
    hasMore,
    nextCursor: hasMore && last ? encodeClasspilotRosterCursor(last) : null,
  };
}
