import type { ClasspilotStudentControlState } from "../schema/classpilot.js";
import type { ClasspilotControlEnforcementHealth } from "./storage.js";

export type ClasspilotControlStateAckOutcome =
  | "applied"
  | "failed"
  | "unsupported"
  | "expired";

/** Enforcement health a classroom-state ACK with this outcome records. */
export function classpilotControlStateAckExpectedHealth(
  outcome: ClasspilotControlStateAckOutcome
): ClasspilotControlEnforcementHealth {
  return outcome === "applied" ? "synced" : outcome;
}

/**
 * Shared skip predicate for classroom-state ACKs arriving over the heartbeat
 * and the student WebSocket. Unchanged re-pushes (scheduler ticks, resyncs)
 * make the extension re-ACK a revision it already applied; such an ACK must
 * perform no write, because `acknowledgeClasspilotStudentControlState` stamps
 * control-state timestamps that feed screenshot authority.
 *
 * Inputs are read from an unlocked projection. A stale "needs ACK" answer is
 * harmless (the storage ACK revalidates under its own locks); a stale "skip"
 * answer can only occur when the durable row already reflects this ACK.
 */
export function classpilotControlStateAckRequired(options: {
  controlState: Pick<ClasspilotStudentControlState, "appliedRevision" | "enforcementHealth">;
  appliedRevision: number;
  outcome: ClasspilotControlStateAckOutcome;
  /** Late-sign-in origin whose applied binding has not yet been recorded. */
  lateSignInOriginPending: boolean;
  /** Client-applied SSO fence differs from the current projection revision. */
  restrictionAuthRevisionMismatch: boolean;
}): boolean {
  return options.lateSignInOriginPending
    || options.controlState.appliedRevision !== options.appliedRevision
    || options.controlState.enforcementHealth
      !== classpilotControlStateAckExpectedHealth(options.outcome)
    || options.restrictionAuthRevisionMismatch;
}
