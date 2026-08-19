import type { RequestHandler } from "express";
import {
  resolveClasspilotEntitlement,
  type ClasspilotEntitlement,
} from "../services/classpilotEntitlement.js";

type ClasspilotEntitlementResolver = (
  schoolId: string
) => Promise<ClasspilotEntitlement>;

/**
 * Uncached ClassPilot entitlement gate for authenticated HTTP requests.
 *
 * The preceding authentication middleware must derive `schoolId`; request
 * bodies are never an authority source. Super-admin status deliberately does
 * not bypass a disabled school or inactive ClassPilot license.
 */
export function createRequireClasspilotEntitlement(
  resolveEntitlement: ClasspilotEntitlementResolver = resolveClasspilotEntitlement
): RequestHandler {
  return async (_req, res, next) => {
    try {
      const schoolId = String(res.locals.schoolId || "").trim();
      if (!schoolId) {
        return res.status(401).json({
          error: "Authenticated school context required",
          code: "CLASSPILOT_SCHOOL_CONTEXT_REQUIRED",
        });
      }
      const entitlement = await resolveEntitlement(schoolId);
      if (!entitlement.entitled) {
        return res.status(403).json({
          error: "school_not_entitled",
          code: "CLASSPILOT_NOT_ENTITLED",
          reason: entitlement.reason,
          schoolActive: false,
          planStatus: "inactive",
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export const requireClasspilotEntitlement = createRequireClasspilotEntitlement();
