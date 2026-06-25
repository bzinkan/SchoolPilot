import type { RequestHandler } from "express";
import {
  verifyStudentToken,
  TokenExpiredError,
  InvalidTokenError,
  type StudentTokenPayload,
} from "../services/deviceJwt.js";
import { bindTenantContext, runWithTenantContext } from "./tenantContext.js";
import { verifyActiveStudentTokenSession } from "../services/classpilotStudentAuth.js";

const activeStudentSessionCache = new Map<string, number>();
const MAX_ACTIVE_STUDENT_SESSION_CACHE_SIZE = 5000;

function extractBearerToken(rawHeader?: string | string[]): string | null {
  if (!rawHeader) return null;
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

function activeStudentSessionCacheKey(payload: StudentTokenPayload): string {
  return `${payload.schoolId}:${payload.studentId}:${payload.deviceId}:${payload.sessionId}`;
}

function hasCachedActiveStudentSession(payload: StudentTokenPayload): boolean {
  const cacheKey = activeStudentSessionCacheKey(payload);
  const expiresAt = activeStudentSessionCache.get(cacheKey);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt > Date.now()) {
    return true;
  }
  activeStudentSessionCache.delete(cacheKey);
  return false;
}

function cacheActiveStudentSession(payload: StudentTokenPayload, ttlMs: number): void {
  if (ttlMs <= 0) {
    return;
  }
  const now = Date.now();
  if (activeStudentSessionCache.size >= MAX_ACTIVE_STUDENT_SESSION_CACHE_SIZE) {
    for (const [key, expiresAt] of activeStudentSessionCache) {
      if (expiresAt <= now || activeStudentSessionCache.size >= MAX_ACTIVE_STUDENT_SESSION_CACHE_SIZE) {
        activeStudentSessionCache.delete(key);
      }
      if (activeStudentSessionCache.size < MAX_ACTIVE_STUDENT_SESSION_CACHE_SIZE) {
        break;
      }
    }
  }
  activeStudentSessionCache.set(activeStudentSessionCacheKey(payload), now + ttlMs);
}

function createRequireDeviceAuth(
  options: { bindTenant?: boolean; activeSessionCacheTtlMs?: number } = {}
): RequestHandler {
  const shouldBindTenant = options.bindTenant ?? true;
  const activeSessionCacheTtlMs = options.activeSessionCacheTtlMs ?? 0;

  /**
   * Device authentication middleware for ClassPilot Chrome extension.
   * Validates student JWT tokens from either Authorization header or request body.
   */
  return async (req, res, next) => {
    const headerToken = extractBearerToken(req.headers.authorization);
    const bodyToken =
      typeof req.body?.studentToken === "string"
        ? req.body.studentToken.trim()
        : null;
    const token = headerToken ?? bodyToken;

    if (!token) {
      return res.status(401).json({ error: "Device token required" });
    }

    try {
      const payload = verifyStudentToken(token);
      let hasActiveSession = hasCachedActiveStudentSession(payload);
      if (!hasActiveSession) {
        hasActiveSession = await runWithTenantContext(
          { schoolId: payload.schoolId },
          () => verifyActiveStudentTokenSession(payload)
        );
        if (hasActiveSession) {
          cacheActiveStudentSession(payload, activeSessionCacheTtlMs);
        }
      }
      if (!hasActiveSession) {
        return res.status(401).json({ error: "Student session is no longer active" });
      }
      res.locals.schoolId = payload.schoolId;
      res.locals.studentId = payload.studentId;
      res.locals.deviceId = payload.deviceId;
      res.locals.studentSessionId = payload.sessionId;
      res.locals.studentEmail = payload.studentEmail;
      res.locals.authType = "device";
      if (!shouldBindTenant) {
        return next();
      }
      return bindTenantContext(req, res, next);
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        return res.status(401).json({ error: "Student token expired" });
      }
      if (error instanceof InvalidTokenError) {
        return res.status(401).json({ error: "Invalid student token" });
      }
      return res.status(401).json({ error: "Unauthorized" });
    }
  };
}

export const requireDeviceAuth = createRequireDeviceAuth();
export const requireDeviceAuthWithoutTenant = createRequireDeviceAuth({
  bindTenant: false,
  activeSessionCacheTtlMs: 60_000,
});
