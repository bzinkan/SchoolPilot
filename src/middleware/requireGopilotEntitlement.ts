import type { RequestHandler } from "express";
import {
  resolveGopilotEntitlement,
  type GoPilotEntitlement,
} from "../services/gopilotEntitlement.js";

type GoPilotEntitlementResolver = (
  schoolId: string
) => Promise<GoPilotEntitlement>;

export function createRequireGopilotEntitlement(
  resolveEntitlement: GoPilotEntitlementResolver = resolveGopilotEntitlement
): RequestHandler {
  const checkEntitlement: RequestHandler = async (_req, res, next) => {
    const schoolId = res.locals.schoolId as string | undefined;
    if (!schoolId) {
      return res.status(400).json({ error: "School context required" });
    }

    const entitlement = await resolveEntitlement(schoolId);
    if (!entitlement.entitled) {
      return res.status(403).json({
        error: "School is not entitled to GoPilot",
        code: "GOPILOT_NOT_ENTITLED",
        reason: entitlement.reason,
      });
    }

    res.locals.gopilotEntitlement = entitlement;
    return next();
  };

  return (req, res, next) => {
    void Promise.resolve(checkEntitlement(req, res, next)).catch(next);
  };
}

export const requireGopilotEntitlement = createRequireGopilotEntitlement();
