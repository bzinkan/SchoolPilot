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
  verify: (token: string) => { userId?: string | number | null }
): string | null {
  const token = bearerToken(authorization);
  if (!token) return null;
  try {
    return normalizeUserId(verify(token).userId);
  } catch {
    return null;
  }
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
