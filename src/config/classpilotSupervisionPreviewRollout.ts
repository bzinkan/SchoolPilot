import {
  assertRetiredClasspilotAllowlist,
  parseClasspilotSchoolScope,
  schoolIsOutsideScope,
} from "./classpilotSchoolScope.js";

export type ClasspilotSupervisionPreviewMode = "off" | "observe" | "on";

/**
 * Screen previews for supervision-claimed students are on for every school.
 *
 * An absent value selects "on": a teacher who has claimed a student has taken
 * responsibility for them, and a tile with no screen is the bug this rollout
 * was created to fix. "observe" remains available to run every code path and
 * emit counters while still discarding frames, which is useful when watching a
 * change in production, but it is a deliberate operator choice rather than the
 * resting state.
 *
 * An unrecognized value still reads as "off" so a typo cannot retain frames the
 * operator did not intend. The boot assertion refuses to start on one, so this
 * fallback should be unreachable in a running server.
 */
export function classpilotSupervisionPreviewMode(
  value: string | undefined = process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE
): ClasspilotSupervisionPreviewMode {
  if (value === undefined) return "on";
  return value === "observe" || value === "on" || value === "off" ? value : "off";
}

/**
 * Every school is in the rollout unless it is explicitly carved out. The
 * previous shape was an allowlist where an empty value meant every school,
 * which read as a pilot but behaved as a fleet-wide switch depending on a
 * variable nobody looked at.
 */
function schoolIsInRollout(schoolId: string, env: NodeJS.ProcessEnv): boolean {
  return !schoolIsOutsideScope(schoolId, env.CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS);
}

/** True only when a frame may actually be retained for this school. */
export function classpilotSupervisionPreviewRetentionEnabled(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    classpilotSupervisionPreviewMode(env.CLASSPILOT_SUPERVISION_PREVIEW_MODE) === "on"
    && schoolIsInRollout(schoolId, env)
  );
}

/**
 * True when the authorization and lease paths should run and emit counters,
 * which includes "on". Retention itself still requires the check above.
 */
export function classpilotSupervisionPreviewObserved(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const mode = classpilotSupervisionPreviewMode(env.CLASSPILOT_SUPERVISION_PREVIEW_MODE);
  return mode !== "off" && schoolIsInRollout(schoolId, env);
}

/**
 * Refuse to boot on a value an operator plainly meant as an enablement but that
 * would silently read as "off". Failing closed is correct, failing closed while
 * looking enabled is not.
 */
export function assertClasspilotSupervisionPreviewEnv(
  env: NodeJS.ProcessEnv = process.env
): void {
  const raw = env.CLASSPILOT_SUPERVISION_PREVIEW_MODE;
  if (raw !== undefined && raw !== "off" && raw !== "observe" && raw !== "on") {
    throw new Error(
      "FATAL: CLASSPILOT_SUPERVISION_PREVIEW_MODE must be one of off, observe, or on; "
        + "an unrecognized value would silently disable supervision previews."
    );
  }
  assertRetiredClasspilotAllowlist(
    env.CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS,
    "CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS",
    "CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS",
  );
  if (parseClasspilotSchoolScope(env.CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS) === null) {
    throw new Error(
      "FATAL: CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS must contain nonempty school identifiers; "
        + "an unparseable carve-out list disables supervision previews for every school."
    );
  }
  if (classpilotSupervisionPreviewMode(raw) === "off"
    && (env.CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS ?? "").trim().length > 0) {
    console.warn(
      "[env] WARNING: CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS is set but "
        + "CLASSPILOT_SUPERVISION_PREVIEW_MODE is off; no school receives supervision previews anyway."
    );
  }
}
