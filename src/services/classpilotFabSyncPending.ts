import { createHmac } from "node:crypto";
import { redisCommand } from "../middleware/rateLimiter.js";
import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";

/**
 * A class start pushes `fab-state-sync` (chat + hand-raise availability) to
 * every student device over WebSocket. A device without an exact-binding
 * socket at that instant misses the push and keeps its stale pre-class state
 * until its own throttled recovery (up to five minutes). This module records
 * that miss per device binding so the device's next regular heartbeat carries
 * the FAB state instead. Ids never appear in Redis keys; the module never
 * touches the database and never throws into a delivery or heartbeat path.
 */

export const CLASSPILOT_FAB_SYNC_PENDING_TTL_SECONDS = 600;
const REDIS_READY_TIMEOUT_MS = 200;
const REDIS_COMMAND_TIMEOUT_MS = 250;
const MAX_LOCAL_PENDING = 10_000;
const KEY_VERSION = "classpilot:fab-sync-pending:v1";

export type ClasspilotFabSyncPendingBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

export type ClasspilotFabSyncPendingMark = "stored" | "local";

function pendingSecret(): string {
  const configured = process.env.CLASSPILOT_KIOSK_TICKET_HMAC_SECRET
    || process.env.SESSION_SECRET
    || process.env.JWT_SECRET;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("ClassPilot FAB sync pending HMAC secret is unavailable");
  }
  return configured || "classpilot-fab-sync-pending-development-only";
}

export function classpilotFabSyncPendingKey(binding: ClasspilotFabSyncPendingBinding): string {
  const digest = createHmac("sha256", pendingSecret())
    .update(KEY_VERSION)
    .update("\u0000")
    .update(binding.schoolId)
    .update("\u0000")
    .update(binding.studentId)
    .update("\u0000")
    .update(binding.studentSessionId)
    .update("\u0000")
    .update(binding.deviceId)
    .digest("base64url");
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:classpilot:fab-sync-pending:v1:${digest}`;
}

type RedisCommandFn = (
  args: string[],
  options?: { readyTimeoutMs?: number; signal?: AbortSignal }
) => Promise<unknown | undefined>;

export type ClasspilotFabSyncPendingStore = {
  mark: (binding: ClasspilotFabSyncPendingBinding) => Promise<ClasspilotFabSyncPendingMark>;
  take: (binding: ClasspilotFabSyncPendingBinding) => Promise<boolean>;
  clear: (binding: ClasspilotFabSyncPendingBinding) => Promise<void>;
  resetLocal: () => void;
};

export function createClasspilotFabSyncPendingStore(
  command: RedisCommandFn = redisCommand,
  now: () => number = Date.now
): ClasspilotFabSyncPendingStore {
  const local = new Map<string, number>();

  const bounded = async (args: string[]): Promise<unknown | undefined> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REDIS_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    try {
      return await command(args, { readyTimeoutMs: REDIS_READY_TIMEOUT_MS, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };

  const pruneLocal = (at: number): void => {
    for (const [key, expiresAt] of local) {
      if (expiresAt <= at) local.delete(key);
    }
    while (local.size >= MAX_LOCAL_PENDING) {
      const oldest = local.keys().next().value as string | undefined;
      if (!oldest) break;
      local.delete(oldest);
    }
  };

  const markLocally = (key: string): void => {
    const at = now();
    local.delete(key);
    pruneLocal(at);
    local.set(key, at + CLASSPILOT_FAB_SYNC_PENDING_TTL_SECONDS * 1_000);
  };

  const takeLocally = (key: string): boolean => {
    const expiresAt = local.get(key);
    if (expiresAt === undefined) return false;
    local.delete(key);
    return expiresAt > now();
  };

  return {
    async mark(binding) {
      const key = classpilotFabSyncPendingKey(binding);
      try {
        const result = await bounded([
          "SET",
          key,
          JSON.stringify({ v: 1, markedAt: now() }),
          "EX",
          String(CLASSPILOT_FAB_SYNC_PENDING_TTL_SECONDS),
        ]);
        if (result === "OK") {
          recordRuntimePerformanceCounter("fabSyncPendingMarked");
          return "stored";
        }
      } catch {
        // Fall through to the bounded local map.
      }
      markLocally(key);
      recordRuntimePerformanceCounter("fabSyncPendingMarkFallback");
      return "local";
    },
    async take(binding) {
      const key = classpilotFabSyncPendingKey(binding);
      let shared: unknown;
      try {
        shared = await bounded(["GETDEL", key]);
      } catch {
        shared = undefined;
      }
      if (typeof shared === "string") {
        local.delete(key);
        return true;
      }
      if (shared === undefined) recordRuntimePerformanceCounter("fabSyncPendingTakeUnavailable");
      return takeLocally(key);
    },
    async clear(binding) {
      const key = classpilotFabSyncPendingKey(binding);
      local.delete(key);
      try {
        await bounded(["DEL", key]);
      } catch {
        // A stale flag only costs one extra FAB build on the next heartbeat.
      }
    },
    resetLocal() {
      local.clear();
    },
  };
}

const defaultStore = createClasspilotFabSyncPendingStore();

export function markClasspilotFabSyncPending(
  binding: ClasspilotFabSyncPendingBinding
): Promise<ClasspilotFabSyncPendingMark> {
  return defaultStore.mark(binding);
}

export function takeClasspilotFabSyncPending(binding: ClasspilotFabSyncPendingBinding): Promise<boolean> {
  return defaultStore.take(binding);
}

export function clearClasspilotFabSyncPending(binding: ClasspilotFabSyncPendingBinding): Promise<void> {
  return defaultStore.clear(binding);
}

export function resetClasspilotFabSyncPendingForTests(): void {
  defaultStore.resetLocal();
}

export type ClasspilotFabSyncMissReport = ClasspilotFabSyncPendingBinding & {
  teachingSessionId: string | null;
  supervisionContextId: string | null;
  pending: ClasspilotFabSyncPendingMark;
  relay: "accepted" | "unavailable" | "skipped";
};

/**
 * One warn line per device that missed the local `fab-state-sync` push, so an
 * "Unavailable during class" report can be settled from CloudWatch with one
 * query. Only opaque ids are logged, never names or message content.
 */
export function describeClasspilotFabSyncMiss(report: ClasspilotFabSyncMissReport): { level: "warn"; line: string } {
  return {
    level: "warn",
    line: `[ClassPilot fab] fab-state-sync missed local socket school=${report.schoolId} student=${report.studentId}`
      + ` studentSession=${report.studentSessionId} device=${report.deviceId}`
      + ` teachingSession=${report.teachingSessionId ?? "none"} supervisionContext=${report.supervisionContextId ?? "none"}`
      + ` reason=control_ownership_transition pending=${report.pending} relay=${report.relay}`,
  };
}

export function reportClasspilotFabSyncMiss(
  report: ClasspilotFabSyncMissReport,
  sink: Pick<Console, "warn"> = console
): void {
  try {
    recordRuntimePerformanceCounter("fabSyncLocalDeliveryMissed");
    sink.warn(describeClasspilotFabSyncMiss(report).line);
  } catch {
    // Diagnostics never affect FAB delivery.
  }
}
