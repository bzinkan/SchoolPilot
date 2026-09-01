import { createHash, randomUUID } from "node:crypto";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { broadcastToStudentsLocal } from "../realtime/ws-broadcast.js";
import {
  executeRealtimeRedisCommand,
  publishWS,
} from "../realtime/ws-redis.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { recordHeartbeatHotPathCounter } from "./heartbeatHotPathMetrics.js";
import { getActiveSessionsForStudents } from "./storage.js";

const SCREENSHOT_POLICY_REFRESH_CAPABILITY =
  "screenshotActiveObservationCadenceV1" as const;
const SCREENSHOT_POLICY_REFRESH_COALESCE_MS = 1_000;
const MAX_LOCAL_REFRESH_CLAIMS = 4_096;
const localRefreshClaims = new Map<string, number>();

type RefreshReason = "activated" | "scope_changed" | "released";
type RefreshClaim = "claimed" | "coalesced" | "unavailable";

function refreshClaimDigest(options: {
  schoolId: string;
  teachingSessionId: string;
  reason: RefreshReason;
}): string {
  return createHash("sha256")
    .update(`${options.schoolId}\u001f${options.teachingSessionId}\u001f${options.reason}`)
    .digest("base64url");
}

function claimLocalRefreshWindow(digest: string, now = Date.now()): RefreshClaim {
  for (const [key, expiresAt] of localRefreshClaims) {
    if (expiresAt <= now) localRefreshClaims.delete(key);
  }
  const existing = localRefreshClaims.get(digest);
  if (existing && existing > now) return "coalesced";
  while (localRefreshClaims.size >= MAX_LOCAL_REFRESH_CLAIMS) {
    const oldest = localRefreshClaims.keys().next().value as string | undefined;
    if (!oldest) break;
    localRefreshClaims.delete(oldest);
  }
  localRefreshClaims.set(digest, now + SCREENSHOT_POLICY_REFRESH_COALESCE_MS);
  return "claimed";
}

async function claimRefreshWindow(options: {
  schoolId: string;
  teachingSessionId: string;
  reason: RefreshReason;
}): Promise<RefreshClaim> {
  const digest = refreshClaimDigest(options);
  if (!process.env.REDIS_URL) return claimLocalRefreshWindow(digest);
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  const result = await executeRealtimeRedisCommand<string | null>([
    "SET",
    `${prefix}:classpilot:screenshot-policy-refresh:v1:${digest}`,
    "1",
    "PX",
    String(SCREENSHOT_POLICY_REFRESH_COALESCE_MS),
    "NX",
  ], { timeoutMs: 250 });
  if (result === "OK") return "claimed";
  if (result === null) return "coalesced";
  return "unavailable";
}

/**
 * Prompt capable extensions in one frozen teaching session to refresh their
 * screenshot policy. The wire frame contains no student, session, or device
 * identifier and grants no authority; clients only use it to request the
 * normal heartbeat policy, and every upload is still independently checked.
 *
 * One Redis claim coalesces viewer churn across API tasks. After the claim,
 * the only tenant-scoped database work is a single active-session read. The
 * resulting device list is routing metadata in the private Redis envelope,
 * never part of the student-facing signal.
 */
export async function nudgeClasspilotScreenshotPolicyRefresh(options: {
  schoolId: string;
  teachingSessionId: string;
  studentIds: string[];
  reason?: RefreshReason;
}): Promise<number> {
  if (!isClasspilotCapabilityActive(SCREENSHOT_POLICY_REFRESH_CAPABILITY, {
    schoolId: options.schoolId,
  })) return 0;

  const studentIds = [...new Set(options.studentIds.map(String).filter(Boolean))];
  if (studentIds.length === 0) return 0;
  const reason = options.reason ?? "scope_changed";
  const claim = await claimRefreshWindow({
    schoolId: options.schoolId,
    teachingSessionId: options.teachingSessionId,
    reason,
  });
  if (claim === "coalesced") {
    recordHeartbeatHotPathCounter("screenshotPolicyRefreshCoalesced");
    return 0;
  }
  if (claim === "unavailable") {
    // Regular ten-second heartbeats remain the bounded, fail-private fallback.
    recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
    return 0;
  }

  let targetDeviceIds: string[];
  try {
    const sessions = await runWithTenantContext(
      { schoolId: options.schoolId },
      () => getActiveSessionsForStudents(options.schoolId, studentIds),
    );
    targetDeviceIds = [...new Set(
      sessions.map((session) => session.deviceId).filter((value): value is string => Boolean(value)),
    )];
  } catch {
    recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
    return 0;
  }
  if (targetDeviceIds.length === 0) return 0;

  const message = {
    type: "screenshot-policy-refresh",
    _msgId: randomUUID(),
    reason: "observation_changed",
    teachingSessionId: options.teachingSessionId,
  } as const;
  const localDelivered = broadcastToStudentsLocal(
    options.schoolId,
    message,
    undefined,
    targetDeviceIds,
  );
  let remotePublished = false;
  try {
    remotePublished = await publishWS({
      kind: "students",
      schoolId: options.schoolId,
      targetDeviceIds,
    }, message);
  } catch {
    // The next ordinary heartbeat is the durable fallback.
  }

  recordHeartbeatHotPathCounter("screenshotPolicyRefreshSignals");
  recordHeartbeatHotPathCounter("screenshotPolicyRefreshTargets", targetDeviceIds.length);
  recordHeartbeatHotPathCounter("screenshotPolicyRefreshLocalDeliveries", localDelivered);
  if (remotePublished) {
    // Redis acceptance is transport evidence only, never device adoption.
    recordHeartbeatHotPathCounter("screenshotPolicyRefreshPublicationsAccepted");
  }
  if (!remotePublished && localDelivered === 0) {
    recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
  }
  return targetDeviceIds.length;
}

export function resetClasspilotScreenshotPolicyRefreshForTests(): void {
  localRefreshClaims.clear();
}
