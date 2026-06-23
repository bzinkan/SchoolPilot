import type { RequestHandler } from "express";
import {
  verifyStudentToken,
  TokenExpiredError,
  InvalidTokenError,
} from "../services/deviceJwt.js";
import { bindTenantContext, runWithTenantContext } from "./tenantContext.js";
import { verifyActiveStudentTokenSession } from "../services/classpilotStudentAuth.js";

function extractBearerToken(rawHeader?: string | string[]): string | null {
  if (!rawHeader) return null;
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

/**
 * Device authentication middleware for ClassPilot Chrome extension.
 * Validates student JWT tokens from either Authorization header or request body.
 */
export const requireDeviceAuth: RequestHandler = async (req, res, next) => {
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
    const hasActiveSession = await runWithTenantContext(
      { schoolId: payload.schoolId },
      () => verifyActiveStudentTokenSession(payload)
    );
    if (!hasActiveSession) {
      return res.status(401).json({ error: "Student session is no longer active" });
    }
    res.locals.schoolId = payload.schoolId;
    res.locals.studentId = payload.studentId;
    res.locals.deviceId = payload.deviceId;
    res.locals.studentSessionId = payload.sessionId;
    res.locals.studentEmail = payload.studentEmail;
    res.locals.authType = "device";
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
