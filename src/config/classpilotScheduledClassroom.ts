import {
  assertRetiredClasspilotAllowlist,
  parseClasspilotSchoolScope,
  schoolIsOutsideScope,
} from "./classpilotSchoolScope.js";

/**
 * Scheduled classroom is on for every school unless it is switched off globally
 * or the school is named as an exclusion.
 *
 * Defaulting on is safe here in a way it is not for most flags, because this
 * feature degrades per device rather than per school. A device that cannot
 * negotiate scheduledClassroomV1 has its supervision authority rewritten to the
 * student session it would have carried anyway
 * (`classpilotScreenshotPolicy.ts`), and a student-session frame is discarded on
 * upload (`devices.ts`) exactly as it is with this off. An old fleet therefore
 * loses nothing by this being on; it simply does not gain it. Only a
 * supervision claim or a testing block reaches that path at all, so ordinary
 * class monitoring is untouched either way.
 */
export function isScheduledClassroomEnabled(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!schoolId) return false;
  // Anything other than an explicit "on" or an absent value is off. The boot
  // assertion rejects an unrecognized mode, so this only ever sees "off".
  const mode = env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE;
  if (mode !== undefined && mode !== "on") return false;
  return !schoolIsOutsideScope(schoolId, env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS);
}

/**
 * The one-second boundary worker is gated independently of the display and
 * authority rollout. They were a single switch, but they carry unrelated risk:
 * the display rollout degrades per device, while the worker drains a fleet-wide
 * `next_boundary_at` backlog four schools at a time. Keeping them separate lets
 * the display rollout reach every school without starting the worker, so this
 * one stays opt-in.
 */
export function isScheduleBoundaryWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLASSPILOT_SCHEDULE_BOUNDARY_WORKER_MODE === "on";
}

export function assertScheduledClassroomEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE !== undefined
    && !["off", "on"].includes(env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE)) {
    throw new Error("CLASSPILOT_SCHEDULED_CLASSROOM_MODE must be off or on");
  }
  if (env.CLASSPILOT_SCHEDULE_BOUNDARY_WORKER_MODE !== undefined
    && !["off", "on"].includes(env.CLASSPILOT_SCHEDULE_BOUNDARY_WORKER_MODE)) {
    throw new Error("CLASSPILOT_SCHEDULE_BOUNDARY_WORKER_MODE must be off or on");
  }
  assertRetiredClasspilotAllowlist(
    env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS,
    "CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS",
    "CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS",
  );
  if (parseClasspilotSchoolScope(env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS) === null) {
    throw new Error(
      "CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS must contain nonempty school identifiers",
    );
  }
}
