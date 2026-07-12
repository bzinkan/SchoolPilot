import { createHash } from "node:crypto";

import {
  usesDeviceScopedApiLimit,
  type ApiRateLimitRequestLike,
} from "./apiRateLimitRoutes.js";

export const DEFAULT_API_RATE_LIMIT_PER_MINUTE = 1_000;
export const SESSION_API_RATE_LIMIT_PER_MINUTE = 5_000;

export type ApiRateLimitIdentityInput = {
  request: ApiRateLimitRequestLike;
  authorization?: string;
  sessionUserId?: string | number | null;
  sessionImpersonating?: boolean;
  verifiedBearerUserId?: string | number | null;
  normalizedIp: string;
};

export type ApiRateLimitIdentity = {
  key: string;
  limit: number;
};

type BearerVerificationPayload = {
  userId?: string | number | null;
  exp?: number;
};

type CachedBearerVerifierOptions = {
  ttlMs?: number;
  invalidTtlMs?: number;
  maxEntries?: number;
  maxTokenLength?: number;
  now?: () => number;
};

function opaqueKey(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${prefix}:${digest}`;
}

function bearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

export function verifyBearerUserId(
  authorization: string | undefined,
  verify: (token: string) => BearerVerificationPayload
): string | null {
  const token = bearerToken(authorization);
  if (!token) return null;
  try {
    return normalizeUserId(verify(token).userId);
  } catch {
    return null;
  }
}

/**
 * Builds a bounded verifier for the pre-authentication rate limiter. Cache keys
 * are SHA-256 digests, never bearer tokens, and invalid entries expire quickly.
 * Compact-token and length checks reject obviously hostile input before JWT
 * cryptography. Successful entries never outlive the signed JWT expiry.
 */
export function createCachedBearerUserIdVerifier(
  verify: (token: string) => BearerVerificationPayload,
  options: CachedBearerVerifierOptions = {}
): (authorization: string | undefined) => string | null {
  const ttlMs = Math.max(1, options.ttlMs ?? 60_000);
  const invalidTtlMs = Math.max(1, options.invalidTtlMs ?? 5_000);
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 4_096));
  const maxTokenLength = Math.max(128, options.maxTokenLength ?? 4_096);
  const now = options.now ?? Date.now;
  const compactJwt = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const cache = new Map<
    string,
    { userId: string | null; expiresAtMs: number }
  >();

  return (authorization) => {
    const token = bearerToken(authorization);
    if (
      !token ||
      token.length > maxTokenLength ||
      !compactJwt.test(token)
    ) {
      return null;
    }

    const nowMs = now();
    const cacheKey = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      // Refresh insertion order to make the fixed-size map an LRU cache.
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached.userId;
    }
    if (cached) cache.delete(cacheKey);

    let userId: string | null = null;
    let expiresAtMs = nowMs + invalidTtlMs;
    try {
      const payload = verify(token);
      userId = normalizeUserId(payload.userId);
      if (userId) {
        const signedExpiryMs =
          typeof payload.exp === "number" && Number.isFinite(payload.exp)
            ? payload.exp * 1_000
            : Number.POSITIVE_INFINITY;
        expiresAtMs = Math.min(nowMs + ttlMs, signedExpiryMs);
      }
    } catch {
      // Cache a short-lived negative result to make replayed invalid JWTs cheap.
    }

    if (expiresAtMs > nowMs) {
      cache.set(cacheKey, { userId, expiresAtMs });
      if (cache.size > maxEntries) {
        // Insertion can exceed the fixed bound by only one entry. Evict the
        // LRU head in O(1); expired entries are removed lazily on lookup and
        // must never trigger a full-cache scan on an attacker-controlled path.
        const oldestKey = cache.keys().next().value as string | undefined;
        if (oldestKey) cache.delete(oldestKey);
      }
    }

    return userId;
  };
}

function normalizeUserId(
  userId: ApiRateLimitIdentityInput["sessionUserId"]
): string | null {
  if (typeof userId === "string") {
    const normalized = userId.trim();
    return normalized || null;
  }

  if (typeof userId === "number" && Number.isFinite(userId)) {
    return String(userId);
  }

  return null;
}

/**
 * Resolve the global API limit without exposing bearer tokens or user ids in
 * Redis keys. Device endpoints take precedence because those requests bypass
 * the web-session middleware in app.ts.
 */
export function resolveApiRateLimitIdentity(
  input: ApiRateLimitIdentityInput
): ApiRateLimitIdentity {
  const token = bearerToken(input.authorization);
  if (token && usesDeviceScopedApiLimit(input.request)) {
    return {
      key: opaqueKey("device-token", token),
      limit: DEFAULT_API_RATE_LIMIT_PER_MINUTE,
    };
  }

  // Match authenticate.ts exactly: an active impersonation session wins;
  // otherwise an explicit signature-verified bearer wins, with the ordinary
  // session as fallback. Both auth modes share the same opaque key namespace.
  const sessionUserId = normalizeUserId(input.sessionUserId);
  const bearerUserId = normalizeUserId(input.verifiedBearerUserId);
  const staffUserId =
    input.sessionImpersonating && sessionUserId
      ? sessionUserId
      : bearerUserId ?? sessionUserId;
  if (staffUserId) {
    return {
      key: opaqueKey("staff-user", staffUserId),
      limit: SESSION_API_RATE_LIMIT_PER_MINUTE,
    };
  }

  return {
    key: `ip:${input.normalizedIp}`,
    limit: DEFAULT_API_RATE_LIMIT_PER_MINUTE,
  };
}
