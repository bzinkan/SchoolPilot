import { parseClasspilotSchoolScope } from "./classpilotSchoolScope.js";

/**
 * School Library rollout for Flight Paths and Block Lists (shared + official
 * items). Off unless CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE is exactly "on".
 *
 * With the mode on, CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS optionally
 * narrows the rollout to the named schools (comma-separated). An absent or
 * empty list means every school. A malformed list turns the feature off for
 * every school: a typo must never enable a school it was not written for.
 *
 * With the feature off for a school, the Flight Path and Block List APIs return
 * exactly their previous shape, the publication endpoints answer 409, and
 * command dispatch resolves only the caller's own items.
 */
export function isSharedTeachingResourcesEnabled(
  schoolId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!schoolId) return false;
  if (env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE !== "on") return false;
  const schools = parseClasspilotSchoolScope(env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS);
  if (schools === null) return false;
  return schools.size === 0 || schools.has(schoolId);
}
