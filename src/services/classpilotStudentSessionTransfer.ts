import type { StudentSessionAuthKind } from "../schema/classpilot.js";
import type { ClasspilotStudentAuthGatePresenceReadResult } from "./classpilotStudentAuthGatePresence.js";
import { CLASSPILOT_STUDENT_AUTH_GATE_STALE_AFTER_MS } from "./classpilotStudentAuthGatePresence.js";

export type ClasspilotStudentSessionTransferDecision =
  | { status: "allowed"; source: "gate_presence" | "stale_heartbeat" }
  | { status: "blocked" | "unavailable" };

export type ClasspilotStudentRosterTransferDecision =
  | { status: "reclaimable" }
  | { status: "allowed"; source: "gate_presence" | "stale_heartbeat" }
  | { status: "hidden" };

/**
 * Pure policy shared by roster visibility and credential-validated transfer.
 * Gate presence wins only when it is newer than the exact session heartbeat;
 * a later heartbeat means the student resumed and must be hidden immediately.
 * The PostgreSQL heartbeat/session-start fallback remains usable even when the
 * shared gate-presence store is unavailable.
 */
export function classpilotStudentSessionTransferDecision(options: {
  authKind: StudentSessionAuthKind;
  sessionStartedAt: Date;
  latestHeartbeatAt: Date | null;
  gatePresence: ClasspilotStudentAuthGatePresenceReadResult;
  now?: number;
}): ClasspilotStudentSessionTransferDecision {
  if (options.authKind !== "manual_shared") return { status: "blocked" };
  const now = options.now ?? Date.now();
  const latestHeartbeatAt = options.latestHeartbeatAt?.getTime()
    ?? options.sessionStartedAt.getTime();
  if (!Number.isFinite(now) || !Number.isFinite(latestHeartbeatAt)) {
    return { status: "blocked" };
  }
  if (
    options.gatePresence.status === "present"
    && options.gatePresence.presence.expiresAt > now
    && options.gatePresence.presence.observedAt > latestHeartbeatAt
  ) {
    return { status: "allowed", source: "gate_presence" };
  }
  if (now - latestHeartbeatAt >= CLASSPILOT_STUDENT_AUTH_GATE_STALE_AFTER_MS) {
    return { status: "allowed", source: "stale_heartbeat" };
  }
  if (
    options.gatePresence.status === "unavailable"
    || options.gatePresence.status === "rejected"
  ) {
    return { status: "unavailable" };
  }
  return { status: "blocked" };
}

/**
 * A roster row is actionable only when exactly one current authority exists.
 * Duplicate manual rows must not become a false offer even when each row is
 * individually stale: the issuance transaction deliberately rejects that
 * ambiguous authority set.
 */
export function classpilotStudentRosterTransferDecision(options: {
  authorities: ReadonlyArray<{
    id: string;
    authKind: StudentSessionAuthKind;
    startedAt: Date;
    latestHeartbeatAt: Date | null;
  }>;
  reclaimableSessionId?: string;
  gatePresenceBySession: ReadonlyMap<string, ClasspilotStudentAuthGatePresenceReadResult>;
  now?: number;
}): ClasspilotStudentRosterTransferDecision {
  if (options.authorities.length !== 1) return { status: "hidden" };
  const authority = options.authorities[0]!;
  if (
    options.reclaimableSessionId
    && authority.id === options.reclaimableSessionId
  ) {
    return { status: "reclaimable" };
  }
  const decision = classpilotStudentSessionTransferDecision({
    authKind: authority.authKind,
    sessionStartedAt: authority.startedAt,
    latestHeartbeatAt: authority.latestHeartbeatAt,
    gatePresence: options.gatePresenceBySession.get(authority.id) ?? { status: "absent" },
    now: options.now,
  });
  return decision.status === "allowed"
    ? decision
    : { status: "hidden" };
}
