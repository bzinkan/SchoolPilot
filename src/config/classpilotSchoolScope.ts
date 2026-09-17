/**
 * Shared parsing for the ClassPilot per-school carve-out lists.
 *
 * These lists name the schools that must NOT receive a rollout. The inverse
 * shape — an allowlist naming the schools that do — was the original design and
 * does not survive more than one school: onboarding a school then means
 * remembering to add it to every list before the product works for it, and
 * forgetting presents as a product bug rather than a missing config line.
 */
const SCHOOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Returns the parsed set, or null when the value is malformed.
 *
 * Callers treat null as "this list cannot be reasoned about" and refuse the
 * rollout for every school. That is the conservative reading: a typo in an
 * exclusion list must never silently enable the school it was written to carve
 * out, and a rollout that is off everywhere is visible immediately, whereas one
 * that leaked to a single school is not.
 */
export function parseClasspilotSchoolScope(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw.trim() === "") return new Set();
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.some((id) => !SCHOOL_ID_PATTERN.test(id))) return null;
  return new Set(ids);
}

/** True when the school is covered, i.e. not carved out and the list parses. */
export function schoolIsOutsideScope(schoolId: string, raw: string | undefined): boolean {
  const excluded = parseClasspilotSchoolScope(raw);
  return excluded === null || excluded.has(schoolId);
}

/**
 * Boot-time guard for a retired allowlist. Leaving the old variable set would
 * read as "these are the schools with the feature" while every other school had
 * it too, which is a more dangerous misreading than a refused boot.
 */
export function assertRetiredClasspilotAllowlist(
  value: string | undefined,
  retiredName: string,
  replacementName: string,
): void {
  if (!value?.trim()) return;
  throw new Error(
    `FATAL: ${retiredName} is retired. The rollout it gated is now on for every school; `
      + `name any school that must not receive it in ${replacementName}.`,
  );
}
