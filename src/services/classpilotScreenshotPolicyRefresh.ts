import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { sendToStudentBindingLocal, type ExactStudentSocketBinding } from "../realtime/ws-broadcast.js";
import {
  executeRealtimeRedisCommand,
  publishWS,
} from "../realtime/ws-redis.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import {
  recordHeartbeatHotPathCounter,
  recordHeartbeatHotPathTiming,
} from "./heartbeatHotPathMetrics.js";
import { getActiveSessionsForStudents } from "./storage.js";
import {
  classpilotScreenshotPolicyRefreshClaimDigest,
  type ClasspilotScreenshotPolicyRefreshReason,
} from "./classpilotScreenshotPolicyRefreshClaim.js";

const SCREENSHOT_POLICY_REFRESH_CAPABILITY =
  "screenshotActiveObservationCadenceV1" as const;
const SCREENSHOT_POLICY_REFRESH_COALESCE_MS = 1_000;
const MAX_LOCAL_REFRESH_CLAIMS = 4_096;
const localRefreshClaims = new Map<string, number>();

type RefreshClaim = "claimed" | "coalesced" | "unavailable";

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
  teachingSessionId?: string;
  supervisionContextId?: string;
  reason: ClasspilotScreenshotPolicyRefreshReason;
  studentIds: readonly string[];
}): Promise<RefreshClaim> {
  const digest = classpilotScreenshotPolicyRefreshClaimDigest(options);
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
 * Prompt capable extensions in one frozen activity to refresh their screenshot
 * policy. The hint carries the current student/session binding required by the
 * extension; it grants no capture authority. Clients request the normal
 * heartbeat policy, and every upload is still independently checked.
 *
 * One Redis claim coalesces viewer churn across API tasks. After the claim,
 * the only tenant-scoped database work is a single active-session read. The
 * device identifier remains private routing metadata. Exact-binding delivery
 * prevents a delayed hint from reaching a replacement login on that device.
 */
export async function nudgeClasspilotScreenshotPolicyRefresh(options: {
  schoolId: string;
  teachingSessionId?: string;
  supervisionContextId?: string;
  studentIds: string[];
  reason?: ClasspilotScreenshotPolicyRefreshReason;
  onFailure?: (error: unknown) => void;
}): Promise<number> {
  if (!isClasspilotCapabilityActive(SCREENSHOT_POLICY_REFRESH_CAPABILITY, {
    schoolId: options.schoolId,
  })) return 0;

  const refreshStartedAt = performance.now();
  try {
    const studentIds = [...new Set(options.studentIds.map(String).filter(Boolean))].sort();
    if (studentIds.length === 0) return 0;
    const reason = options.reason ?? "scope_changed";
    const claim = await claimRefreshWindow({
      schoolId: options.schoolId,
      teachingSessionId: options.teachingSessionId,
      supervisionContextId: options.supervisionContextId,
      reason,
      studentIds,
    });
    if (claim === "coalesced") {
      recordHeartbeatHotPathCounter("screenshotPolicyRefreshCoalesced");
      return 0;
    }
    if (claim === "unavailable") {
      // Regular ten-second heartbeats remain the bounded, fail-private fallback.
      recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
      options.onFailure?.(new Error("Screenshot policy refresh claim unavailable"));
      return 0;
    }

    let bindings: ExactStudentSocketBinding[];
    try {
      const sessions = await runWithTenantContext(
        { schoolId: options.schoolId },
        () => getActiveSessionsForStudents(options.schoolId, studentIds),
      );
      bindings = [...new Map(sessions.filter(session => session.deviceId && studentIds.includes(session.studentId))
        .map(session => [session.id, { schoolId: options.schoolId, studentId: session.studentId,
          studentSessionId: session.id, deviceId: session.deviceId! }])).values()];
    } catch (error) {
      recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
      options.onFailure?.(error);
      return 0;
    }
    if (bindings.length === 0) return 0;
    // Bound publication concurrency; a large roster must not open one pending
    // Redis operation per student. No extra database queries are needed.
    for (let offset = 0; offset < bindings.length; offset += 8) {
      await Promise.all(bindings.slice(offset, offset + 8).map(async binding => {
        const message = {
          type: "screenshot-policy-refresh", _msgId: randomUUID(), reason: "observation_changed",
          studentId: binding.studentId, studentSessionId: binding.studentSessionId,
          ...(options.supervisionContextId ? { supervisionContextId: options.supervisionContextId } : { teachingSessionId: options.teachingSessionId }),
        } as const;
        const localDelivered = sendToStudentBindingLocal(binding, message, {
          requiredCapability: SCREENSHOT_POLICY_REFRESH_CAPABILITY,
        });
        let remotePublished = false;
        let publicationError: unknown;
        try {
          remotePublished = await publishWS({ kind: "student-binding", ...binding,
            requiredCapability: SCREENSHOT_POLICY_REFRESH_CAPABILITY }, message);
        } catch (error) { publicationError = error; }
        recordHeartbeatHotPathCounter("screenshotPolicyRefreshSignals");
        recordHeartbeatHotPathCounter("screenshotPolicyRefreshTargets");
        if (localDelivered) recordHeartbeatHotPathCounter("screenshotPolicyRefreshLocalDeliveries");
        if (remotePublished) recordHeartbeatHotPathCounter("screenshotPolicyRefreshPublicationsAccepted");
        if (!remotePublished && !localDelivered) recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
        if (!remotePublished && process.env.REDIS_URL) {
          options.onFailure?.(publicationError ?? new Error("Screenshot policy refresh publication unavailable"));
        }
      }));
    }
    return bindings.length;
  } finally {
    recordHeartbeatHotPathTiming(
      "screenshotPolicyRefreshMs",
      performance.now() - refreshStartedAt
    );
  }
}

export function resetClasspilotScreenshotPolicyRefreshForTests(): void {
  localRefreshClaims.clear();
}
