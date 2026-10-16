export const CLASSROOM_COURSES_SCOPE = "https://www.googleapis.com/auth/classroom.courses.readonly";

export const CLASSROOM_RESOURCE_SCOPES = [
  CLASSROOM_COURSES_SCOPE,
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
] as const;

function canonicalScope(scope: string): string {
  // Google can return a different scope string from the one requested:
  // https://developers.google.com/identity/protocols/oauth2#3.-examine-scopes-of-access-granted-by-the-user.
  // The teacher coursework read alias was verified against courseWork.list
  // with a real grant on 2026-10-12; keep this mapping limited to known aliases.
  switch (scope) {
    case "https://www.googleapis.com/auth/classroom.student-submissions.students.readonly":
      return "https://www.googleapis.com/auth/classroom.coursework.students.readonly";
    case "https://www.googleapis.com/auth/userinfo.email":
      return "email";
    default:
      return scope;
  }
}

export function missingGoogleOAuthScopes(
  tokenScope: string | null | undefined,
  requiredScopes: readonly string[],
): string[] {
  const granted = new Set((tokenScope || "").split(/\s+/).filter(Boolean).map(canonicalScope));
  return requiredScopes.filter((scope) => !granted.has(canonicalScope(scope)));
}
