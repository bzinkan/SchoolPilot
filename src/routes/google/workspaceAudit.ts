import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { runWorkspaceAudit } from "../../services/workspaceAudit.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
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
    if (err?.code === 403 || err?.response?.status === 403) {
      return res.status(403).json({
        error: "Workspace admin permissions required to run the audit.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }
    next(err);
  }
});

export default router;
