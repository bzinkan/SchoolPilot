import { parseRlsEnabledTables } from "../db/rlsPolicies.js";

export const CLASSPILOT_TODAY_SCHEDULE_MODE_KEY = "CLASSPILOT_TODAY_SCHEDULE_MODE";
export const CLASSPILOT_TODAY_SCHEDULE_RLS_TABLES = [
  "classpilot_today_changes",
  "classpilot_today_occurrences",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;

/** New-write gate only. Committed dated occurrences must always be resolved. */
export function isClasspilotTodayScheduleEnabled(env: Environment = process.env): boolean {
  if (env[CLASSPILOT_TODAY_SCHEDULE_MODE_KEY] !== "on" || env.RLS_GUC_ENABLED !== "true") return false;
  const admitted = parseRlsEnabledTables(env.RLS_ENABLED_TABLES);
  return CLASSPILOT_TODAY_SCHEDULE_RLS_TABLES.every(table => admitted.has(table));
}
