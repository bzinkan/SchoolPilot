/**
 * Distributed one-time authorization-code exchange for OAuth callbacks.
 *
 * Production codes are stored in Redis so an OAuth callback handled by one
 * API task can be exchanged on any other task. Redis keys are HMAC-derived;
 * neither the bearer code nor its JWT is ever written to logs. GETDEL makes
 * consumption atomic across the fleet.
 *
 * Development and tests may use the bounded in-process fallback only when
 * Redis is not configured. Production fails closed instead of issuing a code
 * that another task could not consume.
 */
import crypto from "crypto";
import { redisCommand } from "../middleware/rateLimiter.js";

interface CodeRecord {
  token: string;
  expiresAt: number;
}

const CODE_TTL_SECONDS = 60;
const CODE_TTL_MS = CODE_TTL_SECONDS * 1_000;
const MAX_LOCAL_CODES = 1_024;
const localCodeStore = new Map<string, CodeRecord>();

function productionMode(): boolean {
  return process.env.NODE_ENV === "production";
}

function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

function hmacSecret(): string {
  const secret =
    process.env.AUTH_CODE_HMAC_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.JWT_SECRET;
  if (!secret && productionMode()) {
    throw new Error("AUTH_CODE_HMAC_SECRET is required in production");
  }
  return secret || "schoolpilot-development-auth-code-secret";
}

function redisKey(code: string): string {
  const digest = crypto
    .createHmac("sha256", hmacSecret())
    .update(code)
    .digest("base64url");
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:auth-code:${digest}`;
}

function pruneLocalStore(now = Date.now()): void {
  for (const [code, record] of localCodeStore) {
    if (record.expiresAt <= now) localCodeStore.delete(code);
  }
  while (localCodeStore.size >= MAX_LOCAL_CODES) {
    const oldest = localCodeStore.keys().next().value as string | undefined;
    if (!oldest) break;
    localCodeStore.delete(oldest);
  }
}

/** Stash a JWT under a fresh URL-safe one-time code. */
export async function issueAuthCode(token: string): Promise<string> {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("A non-empty token is required");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = crypto.randomBytes(32).toString("base64url");
    if (redisConfigured()) {
      let result: unknown;
      try {
        result = await redisCommand(
          ["SET", redisKey(code), token, "EX", String(CODE_TTL_SECONDS), "NX"],
          { readyTimeoutMs: 1_000 }
        );
      } catch {
        throw new Error("One-time authorization code service unavailable");
      }
      if (result === "OK") return code;
      if (result === null) continue;
      throw new Error("One-time authorization code service unavailable");
    }

    if (productionMode()) {
      throw new Error("One-time authorization code service unavailable");
    }
    pruneLocalStore();
    localCodeStore.set(code, {
      token,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    return code;
  }

  throw new Error("Unable to allocate a one-time authorization code");
}

/** Atomically exchange a code for its JWT. */
export async function consumeAuthCode(code: string): Promise<string | null> {
  if (typeof code !== "string" || code.length === 0) return null;

  if (redisConfigured()) {
    let result: unknown;
    try {
      result = await redisCommand(["GETDEL", redisKey(code)], {
        readyTimeoutMs: 1_000,
      });
    } catch {
      throw new Error("One-time authorization code service unavailable");
    }
    if (typeof result === "string") return result;
    if (result === null) return null;
    throw new Error("One-time authorization code service unavailable");
  }

  if (productionMode()) {
    throw new Error("One-time authorization code service unavailable");
  }
  const record = localCodeStore.get(code);
  if (!record) return null;
  localCodeStore.delete(code);
  return record.expiresAt > Date.now() ? record.token : null;
}

export function resetAuthCodeStoreForTests(): void {
  if (process.env.NODE_ENV === "production") return;
  localCodeStore.clear();
}
