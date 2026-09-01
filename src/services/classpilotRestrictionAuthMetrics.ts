import type { ClasspilotRestrictionAuthState } from "./classpilotRealtimeStatus.js";

export type ClasspilotRestrictionAuthTransitionMetric =
  | "restrictionAuthStarted"
  | "restrictionAuthCompleted"
  | "restrictionAuthTimedOut";

/**
 * Classify an exact-binding authentication transition without carrying any
 * school, student, device, provider, host, or URL into the metric payload.
 */
export function classpilotRestrictionAuthTransitionMetric(
  previous: ClasspilotRestrictionAuthState | null,
  next: ClasspilotRestrictionAuthState
): ClasspilotRestrictionAuthTransitionMetric | null {
  if (next === previous) return null;
  if (next === "in_progress") return "restrictionAuthStarted";
  if (next === "complete") return "restrictionAuthCompleted";
  if (next === "timed_out") return "restrictionAuthTimedOut";
  // Returning to idle is cleanup/cancellation/restriction removal, not proof
  // that the destination was reached. Completion must be explicit on the
  // exact authenticated heartbeat binding.
  return null;
}
