import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireSuperAdmin } from "../../middleware/requireRole.js";
import { auditLimiter } from "../../middleware/rateLimiter.js";
import { runWorkspaceAudit } from "../../services/workspaceAudit.js";

const router = Router();

// Workspace Audit is gated to super-admin only while the new OAuth scopes
// (admin.directory.device.chromeos.readonly, chrome.management.policy.readonly)
// progress through Google verification. Regular school admins do not see the
// UI and cannot hit the endpoint. Flip requireSuperAdmin → requireRole("admin",
// "school_admin") to re-open to all school admins after verification completes.
const auth = [
  authenticate,
  requireSuperAdmin,
  auditLimiter,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

// POST /api/google/workspace-audit/run
// Runs the audit against the connected Google Workspace and returns a scorecard.
router.post("/run", ...auth, async (req, res, next) => {
  try {
    const report = await runWorkspaceAudit(req.authUser!.id);
    return res.json(report);
  } catch (err: any) {
    if (err?.message === "Google not connected") {
      return res.status(400).json({ error: "Google not connected", code: "NO_TOKENS" });
    }
    if (
      err?.code === "INSUFFICIENT_PERMISSIONS" ||
      err?.code === 403 ||
      err?.response?.status === 403 ||
      err?.statusCode === 403
    ) {
      return res.status(403).json({
        error: err?.message || "Workspace admin permissions required to run the audit.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }
    next(err);
  }
});

export default router;
