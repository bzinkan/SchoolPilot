import type { RequestHandler } from "express";
import {
  verifyStudentToken,
  TokenExpiredError,
  InvalidTokenError,
} from "../services/deviceJwt.js";
import { bindTenantContext, runWithTenantContext } from "./tenantContext.js";
import {
  resolveActiveStudentTokenSession,
  studentAuthenticationServiceError,
} from "../services/classpilotStudentAuth.js";
import { recordHeartbeatHotPathCounter } from "../services/heartbeatHotPathMetrics.js";

function extractBearerToken(rawHeader?: string | string[]): string | null {
  if (!rawHeader) return null;
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

function createRequireDeviceAuth(
  options: { bindTenant?: boolean; validateActiveSession?: boolean } = {}
): RequestHandler {
  const shouldBindTenant = options.bindTenant ?? true;
  const shouldValidateActiveSession = options.validateActiveSession ?? true;

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
      res.locals.schoolId = payload.schoolId;
      res.locals.studentId = payload.studentId;
      res.locals.deviceId = payload.deviceId;
      res.locals.studentSessionId = payload.sessionId;
      res.locals.studentEmail = payload.studentEmail;
      res.locals.authType = "device";

      // The heartbeat CTE already validates and locks the exact active session,
      // device, student, and school before it inserts. Its dedicated middleware
      // therefore performs cryptographic validation only and avoids a duplicate
      // database lookup. Other device routes retain the existing DB check.
      if (!shouldValidateActiveSession) {
        recordHeartbeatHotPathCounter("heartbeatCryptoAuth");
        return next();
      }

      if (shouldBindTenant) {
        return bindTenantContext(req, res, (bindError?: unknown) => {
          if (bindError) return next(bindError);
          void resolveActiveStudentTokenSession(payload)
            .then((activeSession) => {
              if (!activeSession) {
                res.status(401).json({ error: "Student session is no longer active" });
                return;
              }
              res.locals.activeStudentSession = activeSession;
              next();
            })
            .catch((error) => next(studentAuthenticationServiceError(error)));
        });
      }

      const activeSession = await runWithTenantContext(
        { schoolId: payload.schoolId },
        () => resolveActiveStudentTokenSession(payload)
      );
      if (!activeSession) {
        return res.status(401).json({ error: "Student session is no longer active" });
      }
      res.locals.activeStudentSession = activeSession;
      return next();
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        return res.status(401).json({ error: "Student token expired" });
      }
      if (error instanceof InvalidTokenError) {
        return res.status(401).json({ error: "Invalid student token" });
      }
      return next(studentAuthenticationServiceError(error));
    }
  };
}

export const requireDeviceAuth = createRequireDeviceAuth();
export const requireDeviceAuthWithoutTenant = createRequireDeviceAuth({
  bindTenant: false,
});
export const requireCryptographicDeviceAuth = createRequireDeviceAuth({
  bindTenant: false,
  validateActiveSession: false,
});
