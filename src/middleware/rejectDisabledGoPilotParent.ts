import type { RequestHandler } from "express";
import { getRequestGoPilotRole } from "../services/gopilotAccess.js";
import {
  isDisabledGoPilotParentRole,
  sendGoPilotParentPortalDisabled,
} from "../util/gopilotParentContainment.js";

/**
 * Must run immediately after school context resolution and before any
 * resource lookup. Historical parent memberships receive the same terminal
 * response regardless of the requested child, session, or pickup identifier.
 */
export const rejectDisabledGoPilotParent: RequestHandler = async (req, res, next) => {
  try {
    const role = await getRequestGoPilotRole(req, res);
    if (isDisabledGoPilotParentRole(role)) {
      return sendGoPilotParentPortalDisabled(res);
    }
    return next();
  } catch (error) {
    return next(error);
  }
};
