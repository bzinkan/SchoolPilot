import crypto from "crypto";
import { redisCommand } from "../middleware/rateLimiter.js";

export const CLASSPILOT_SAFETY_COOLDOWN_SECONDS = 10 * 60;
const MAX_LOCAL_CLAIMS = 20_000;
const localClaims = new Map<string, number>();

function secret(): string {
  const configured = process.env.CLASSPILOT_SAFETY_COOLDOWN_HMAC_SECRET
    || process.env.JWT_SECRET;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("CLASSPILOT_SAFETY_COOLDOWN_HMAC_SECRET is required in production");
  }
  return configured || "schoolpilot-development-safety-cooldown-secret";
}

export function classpilotSafetyCooldownKey(input: {
  schoolId: string;
  deviceId: string;
  domain: string;
}): string {
  const digest = crypto
    .createHmac("sha256", secret())
    .update(input.schoolId)
    .update("\0")
    .update(input.deviceId)
    .update("\0")
    .update(input.domain)
    .digest("base64url");
  return `${process.env.REDIS_PREFIX ?? "schoolpilot"}:classpilot:safety-cooldown:${digest}`;
}

function claimLocally(key: string, now = Date.now()): boolean {
  const expiresAt = localClaims.get(key) ?? 0;
  if (expiresAt > now) return false;
  localClaims.delete(key);
  for (const [candidate, candidateExpiry] of localClaims) {
    if (candidateExpiry <= now) localClaims.delete(candidate);
  }
  while (localClaims.size >= MAX_LOCAL_CLAIMS) {
    const oldest = localClaims.keys().next().value as string | undefined;
    if (!oldest) break;
    localClaims.delete(oldest);
  }
  localClaims.set(key, now + CLASSPILOT_SAFETY_COOLDOWN_SECONDS * 1_000);
  return true;
}

/**
 * Atomically elects one task to emit staff/email alerts. Safety tab closure is
 * deliberately outside this claim and always proceeds. Redis outages fall
 * back to a bounded process claim so an outage cannot suppress all alerts.
 */
export async function claimClasspilotSafetyAlert(input: {
  schoolId: string;
  deviceId: string;
  domain: string;
}): Promise<boolean> {
  const key = classpilotSafetyCooldownKey(input);
  if (process.env.REDIS_URL) {
    try {
      const result = await redisCommand([
        "SET",
        key,
        "1",
        "NX",
        "EX",
        String(CLASSPILOT_SAFETY_COOLDOWN_SECONDS),
      ], { readyTimeoutMs: 1_000 });
      if (result !== undefined) return result === "OK";
    } catch {
      // The local bounded claim is a notification-availability fallback, not
      // an authority source. It may duplicate across tasks but cannot suppress
      // safety closure or broaden a command target.
    }
  }
  return claimLocally(key);
}

export function resetClasspilotSafetyCooldownForTests(): void {
  localClaims.clear();
}
