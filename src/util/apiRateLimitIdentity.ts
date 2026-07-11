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

function normalizeSessionUserId(
  sessionUserId: ApiRateLimitIdentityInput["sessionUserId"]
): string | null {
  if (typeof sessionUserId === "string") {
    const normalized = sessionUserId.trim();
    return normalized || null;
  }

  if (typeof sessionUserId === "number" && Number.isFinite(sessionUserId)) {
    return String(sessionUserId);
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

  const sessionUserId = normalizeSessionUserId(input.sessionUserId);
  if (sessionUserId) {
    return {
      key: opaqueKey("session-user", sessionUserId),
      limit: SESSION_API_RATE_LIMIT_PER_MINUTE,
    };
  }

  return {
    key: `ip:${input.normalizedIp}`,
    limit: DEFAULT_API_RATE_LIMIT_PER_MINUTE,
  };
}
