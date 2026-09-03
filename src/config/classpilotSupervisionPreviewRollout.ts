export type ClasspilotSupervisionPreviewMode = "off" | "observe" | "on";

/**
 * Screen previews for supervision-claimed students are an operator-controlled
 * rollout. An absent, malformed, or unrecognized value deliberately selects
 * "off", which is byte-for-byte today's behaviour: the upload is discarded and
 * the tile read builds no supervision binding.
 *
 * "observe" runs every code path and emits counters while still discarding, so
 * the feature can be watched in production before a single pixel is stored.
 */
export function classpilotSupervisionPreviewMode(
  value: string | undefined = process.env.CLASSPILOT_SUPERVISION_PREVIEW_MODE
): ClasspilotSupervisionPreviewMode {
  return value === "observe" || value === "on" || value === "off" ? value : "off";
}

function allowedSchoolIds(
  value: string | undefined = process.env.CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS
): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

/**
 * An empty allowlist means every school, matching how capability rollouts read
 * an empty `schoolIds` set, so operators do not learn a second rule. A pilot
 * should always name its schools explicitly.
 */
function schoolIsInRollout(schoolId: string, env: NodeJS.ProcessEnv): boolean {
  const allowed = allowedSchoolIds(env.CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS);
  return allowed.size === 0 || allowed.has(schoolId);
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
  if (
    classpilotSupervisionPreviewMode(raw) === "off"
    && (env.CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS ?? "").trim().length > 0
  ) {
    console.warn(
      "[env] WARNING: CLASSPILOT_SUPERVISION_PREVIEW_SCHOOL_IDS is set but "
        + "CLASSPILOT_SUPERVISION_PREVIEW_MODE is off; no school will receive supervision previews."
    );
  }
}
