import { Router, type NextFunction, type Request, type Response } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { bindTenantContext } from "../../middleware/tenantContext.js";
import {
  buildMonitoringHealthSnapshot,
  buildMonitoringStatusSummary,
  getMonitoringOverview,
  listMonitoringFingerprints,
  listMonitoringRecentErrors,
  MonitoringQueryError,
} from "../../services/monitoringDashboard.js";

const router = Router();

function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser?.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}

const auth = [authenticate, requireSuperAdmin, bindTenantContext] as const;

function handleMonitoringError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof MonitoringQueryError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  return next(err);
}

router.get("/status", ...auth, async (_req, res, next) => {
  try {
    const snapshot = await buildMonitoringHealthSnapshot();
    return res.json(buildMonitoringStatusSummary(snapshot));
  } catch (err) {
    return handleMonitoringError(err, res, next);
  }
});

router.get("/overview", ...auth, async (_req, res, next) => {
  try {
    return res.json(await getMonitoringOverview());
  } catch (err) {
    return handleMonitoringError(err, res, next);
  }
});

router.get("/fingerprints", ...auth, async (req, res, next) => {
  try {
    return res.json({ fingerprints: listMonitoringFingerprints(req.query) });
  } catch (err) {
    return handleMonitoringError(err, res, next);
  }
});

router.get("/recent-errors", ...auth, async (req, res, next) => {
  try {
    return res.json(await listMonitoringRecentErrors(req.query));
  } catch (err) {
    return handleMonitoringError(err, res, next);
  }
});

router.get("/health", ...auth, async (_req, res, next) => {
  try {
    return res.json(await buildMonitoringHealthSnapshot());
  } catch (err) {
    return handleMonitoringError(err, res, next);
  }
});

export default router;
