/** The display and authority rollout are deliberately fail-closed. */
export function isScheduledClassroomEnabled(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!schoolId || env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE !== "on") return false;
  const raw = env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
  if (raw === undefined || raw.trim() === "") return true;
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.some((id) => !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) return false;
  return ids.includes(schoolId);
}

export function assertScheduledClassroomEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE !== undefined
    && !["off", "on"].includes(env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE)) {
    throw new Error("CLASSPILOT_SCHEDULED_CLASSROOM_MODE must be off or on");
  }
  const raw = env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
  if (raw?.trim() && raw.split(",").some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id.trim()))) {
    throw new Error("CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS must contain nonempty school identifiers");
  }
}
