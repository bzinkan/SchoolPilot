import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { classpilotClientHealthSchema, emitClasspilotClientHealth } from "../../services/classpilotClientHealth.js";
import { identityHasAnyRole, loadVerifiedSchoolIdentities } from "../../services/schoolIdentity.js";

const router = Router();
const dashboardRoles = ["teacher", "admin", "school_admin", "office_staff"] as const;
const limiter = rateLimit({
  windowMs: 60_000,
  // One report per visible dashboard/minute. A second slot accommodates clock
  // boundaries or two tabs without turning telemetry into a retry loop.
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  // Diagnostic traffic must never wait for Redis while retaining a tenant DB
  // lease. The client sends once/minute; this synchronous per-process actor guard
  // also caps extra tabs. The ordinary shared API limiter remains in force.
  keyGenerator: req => req.authUser!.id,
  message: { error: "Client health reporting rate exceeded", code: "CLIENT_HEALTH_RATE_LIMITED" },
});

router.post("/monitoring/client-health",
  authenticate,
  requireSchoolContext,
  // Global operators bypass ordinary school middleware. Diagnostic summaries
  // still require an actual active staff membership in the reported school.
  (req, res, next) => {
    if (!req.authUser?.isSuperAdmin) return next();
    void loadVerifiedSchoolIdentities(req.authUser.id, res.locals.schoolId).then(([identity]) => {
      if (!identity || !identityHasAnyRole(identity, dashboardRoles)) {
        return res.status(403).json({ error: "School staff membership required" });
      }
      next();
    }).catch(next);
  },
  requireClasspilotEntitlement,
  requireRole(...dashboardRoles),
  limiter,
  (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // The app's JSON parser may already have run. Enforce this route's smaller
    // bound here as well; rejected bodies are never logged or echoed.
    if (Number(req.get("content-length") || 0) > 2_048
      || Buffer.byteLength(JSON.stringify(req.body ?? null), "utf8") > 2_048) {
      return res.status(413).json({ error: "Client health summary is too large" });
    }
    const parsed = classpilotClientHealthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid client health summary" });
    emitClasspilotClientHealth(parsed.data);
    return res.status(204).end();
  },
);

export default router;
