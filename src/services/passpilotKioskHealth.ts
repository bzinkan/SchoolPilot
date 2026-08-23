import crypto from "node:crypto";
import { z } from "zod";
import { redisCommand } from "../middleware/rateLimiter.js";
import { recordPasspilotKioskCounter } from "./passpilotKioskMetrics.js";

const CLIENT_HEALTH_RATE_LIMIT_MS = 5 * 60 * 1_000;
const CLIENT_HEALTH_MAX_KEYS = 4_096;
const healthHmacKey =
  process.env.KIOSK_HEALTH_HMAC_SECRET ||
  process.env.KIOSK_TOKEN_SECRET ||
  process.env.JWT_SECRET ||
  "schoolpilot-development-kiosk-health-secret";

export const passpilotKioskClientHealthSchema = z
  .object({
    event: z.enum(["snapshot_failure", "snapshot_recovery"]),
    consecutiveFailures: z.number().int().min(3).max(1_000),
    reason: z
      .enum(["network", "timeout", "server", "invalid_response", "unknown"])
      .optional(),
  })
  .strict();

export type PasspilotKioskClientHealth = z.infer<
  typeof passpilotKioskClientHealthSchema
>;

export class BoundedKioskHealthRateLimiter {
  private readonly entries = new Map<string, number>();

  constructor(
    readonly maxEntries = CLIENT_HEALTH_MAX_KEYS,
    readonly windowMs = CLIENT_HEALTH_RATE_LIMIT_MS
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("kiosk_health_rate_limit_max_entries_invalid");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("kiosk_health_rate_limit_window_invalid");
    }
  }

  accept(digest: string, nowMs = Date.now()): boolean {
    this.pruneExpired(nowMs);
    const nextAllowedAt = this.entries.get(digest);
    if (nextAllowedAt !== undefined && nextAllowedAt > nowMs) return false;
    if (this.entries.has(digest)) this.entries.delete(digest);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(digest, nowMs + this.windowMs);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private pruneExpired(nowMs: number): void {
    for (const [digest, nextAllowedAt] of this.entries) {
      if (nextAllowedAt <= nowMs) this.entries.delete(digest);
    }
  }
}

const healthRateLimiter = new BoundedKioskHealthRateLimiter();

function healthKey(options: {
  schoolId: string;
  kioskScopeId: string | null;
  event: PasspilotKioskClientHealth["event"];
}): string {
  return crypto
    .createHmac("sha256", healthHmacKey)
    .update(JSON.stringify([
      "passpilot-kiosk-client-health-v1",
      options.schoolId,
      options.kioskScopeId ?? "legacy",
      options.event,
    ]))
    .digest("base64url");
}

export async function recordPasspilotKioskClientHealth(options: {
  schoolId: string;
  kioskScopeId: string | null;
  health: PasspilotKioskClientHealth;
  nowMs?: number;
}): Promise<{ accepted: boolean; retryAfterSeconds: number }> {
  const digest = healthKey({
    schoolId: options.schoolId,
    kioskScopeId: options.kioskScopeId,
    event: options.health.event,
  });
  let accepted: boolean | undefined;
  if (process.env.REDIS_URL) {
    const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
    try {
      const result = await redisCommand(
        [
          "SET",
          `${prefix}:passpilot:kiosk-health:${digest}`,
          "1",
          "NX",
          "EX",
          String(CLIENT_HEALTH_RATE_LIMIT_MS / 1_000),
        ],
        { readyTimeoutMs: 200 }
      );
      if (result === "OK") accepted = true;
      else if (result === null) accepted = false;
    } catch {
      // Diagnostics are best effort. Fall back to the bounded process-local
      // limiter so a Redis outage cannot affect kiosk operation.
    }
  }
  accepted ??= healthRateLimiter.accept(digest, options.nowMs);
  recordPasspilotKioskCounter(
    accepted ? "clientHealthAccepted" : "clientHealthSuppressed"
  );
  return {
    accepted,
    retryAfterSeconds: accepted ? 0 : CLIENT_HEALTH_RATE_LIMIT_MS / 1_000,
  };
}

export function resetPasspilotKioskHealthStateForTests(): void {
  healthRateLimiter.clear();
}

export function snapshotPasspilotKioskHealthStateForTests(): {
  size: number;
  maxEntries: number;
  windowMs: number;
} {
  return {
    size: healthRateLimiter.size,
    maxEntries: healthRateLimiter.maxEntries,
    windowMs: healthRateLimiter.windowMs,
  };
}
