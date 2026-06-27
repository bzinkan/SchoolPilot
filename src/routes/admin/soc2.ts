import { Router, type NextFunction, type Request, type Response } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { bindTenantContext } from "../../middleware/tenantContext.js";
import {
  buildSoc2DashboardReadiness,
  dispatchSoc2DashboardResync,
} from "../../services/soc2Dashboard.js";

const router = Router();

export function requireSoc2SuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser?.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  return next();
}

const auth = [authenticate, requireSoc2SuperAdmin, bindTenantContext] as const;

router.get("/readiness", ...auth, async (_req, res, next) => {
  try {
    return res.json(await buildSoc2DashboardReadiness());
  } catch (err) {
    return next(err);
  }
});

router.post("/resync", ...auth, async (_req, res) => {
  try {
    return res.status(202).json(await dispatchSoc2DashboardResync());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to queue SOC 2 resync.";
    return res.status(503).json({
      status: "unavailable",
      error: message,
      appImpact: "No user-facing behavior changed",
    });
  }
});

export default router;
