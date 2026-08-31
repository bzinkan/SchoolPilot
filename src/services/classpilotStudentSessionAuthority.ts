import crypto from "node:crypto";
import { and, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { studentSessions } from "../schema/classpilot.js";

export const CLASSPILOT_MANUAL_SESSION_LEASE_SECONDS = 300;
export const CLASSPILOT_SESSION_RECOVERY_TOKEN_BYTES = 32;
export const CLASSPILOT_SESSION_RECOVERY_AUTH_SCHEME = "ClassPilot-Recovery";
export const CLASSPILOT_SESSION_RECOVERY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const CLASSPILOT_MANUAL_SHARED_ISSUANCE_ENV =
  "CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED";

// Phase B issues all new manual sign-ins with lease and recovery authority.
// An explicit env value other than "true" remains the emergency kill switch.
export const CLASSPILOT_MANUAL_SHARED_ISSUANCE_DEFAULT = true;

export function classpilotManualSharedSessionIssuanceEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const configured = env[CLASSPILOT_MANUAL_SHARED_ISSUANCE_ENV];
  if (configured === undefined) return CLASSPILOT_MANUAL_SHARED_ISSUANCE_DEFAULT;
  return configured.trim().toLowerCase() === "true";
}

export function assertClasspilotManualSharedSessionIssuanceEnabled(): void {
  if (classpilotManualSharedSessionIssuanceEnabled()) return;
  throw Object.assign(
    new Error("Manual student sign-in is temporarily unavailable"),
    {
      status: 503,
      code: "CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE",
      expose: true,
      retryable: true,
    }
  );
}

export type ClasspilotAcceptedHeartbeatThrottle = {
  acceptedAt: number;
  studentId: string;
  studentSessionId: string;
  authorityExpiresAtMs: number | null;
};

export function canShortCircuitAcceptedHeartbeat(options: {
  previous: ClasspilotAcceptedHeartbeatThrottle | undefined;
  studentId: string;
  studentSessionId: string;
  nowMs: number;
  minimumIntervalMs: number;
  acceptedCapabilities?: readonly string[];
}): boolean {
  // Tracking-window clients use a deliberate rapid heartbeat to acquire the
  // next immutable screenshot authority at gap -> class and class -> class
  // transitions. A 204 here would omit screenshotPolicy and delay capture.
  if (options.acceptedCapabilities?.includes("screenshotTrackingWindowLeaseV1")) {
    return false;
  }
  const previous = options.previous;
  if (!previous) return false;
  if (
    previous.studentId !== options.studentId
    || previous.studentSessionId !== options.studentSessionId
  ) return false;
  if (
    previous.authorityExpiresAtMs !== null
    && previous.authorityExpiresAtMs <= options.nowMs
  ) return false;
  return options.nowMs - previous.acceptedAt < options.minimumIntervalMs;
}

/**
 * PostgreSQL is the clock authority for manual-session leases. Keep this
 * predicate on every path that treats a student session as current authority.
 */
export function currentStudentSessionAuthorityPredicate(): SQL {
  return and(
    eq(studentSessions.isActive, true),
    isNull(studentSessions.endedAt),
    or(
      ne(studentSessions.authKind, "manual_shared"),
      and(
        isNotNull(studentSessions.manualLeaseExpiresAt),
        sql`${studentSessions.manualLeaseExpiresAt} > clock_timestamp()`
      )
    )
  )!;
}

export function createStudentSessionRecovery(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(CLASSPILOT_SESSION_RECOVERY_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashStudentSessionRecoveryToken(token) };
}

export function hashStudentSessionRecoveryToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeStudentSessionRecoveryToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return CLASSPILOT_SESSION_RECOVERY_TOKEN_PATTERN.test(token) ? token : null;
}

export function studentSessionRecoveryTokenFromAuthorization(
  authorization: string | string[] | undefined
): string | null {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value) return null;
  const match = /^ClassPilot-Recovery ([A-Za-z0-9_-]{43})$/.exec(value.trim());
  return match?.[1] ?? null;
}
