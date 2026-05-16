export interface SchoolContextRequestLike {
  params?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  session?: { schoolId?: string | null };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function getRequestedSchoolId(req: SchoolContextRequestLike): string {
  return firstString(
    req.params?.schoolId,
    req.headers?.["x-school-id"],
    req.query?.schoolId,
    req.session?.schoolId
  );
}
