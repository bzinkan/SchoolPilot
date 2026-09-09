import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { getMonitoringInterruptionSettings, getMonitoringInterruptionSummary, listMonitoringInterruptionHistory, listMonitoringInterruptions, setMonitoringInterruptionSettings } from "../../services/classpilotMonitoringInterruptions.js";
import { invalidMonitoringHistory } from "../../services/classpilotMonitoringHistoryRules.js";
import { logAudit } from "../../services/audit.js";
const router = Router();
router.use(authenticate, requireSchoolContext, requireClasspilotEntitlement, requireRole("admin", "school_admin", "teacher", "office_staff"));
router.get("/", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, no-store");
    const options = { schoolId: res.locals.schoolId!, actorId: req.authUser!.id, isAdmin: requestHasAnySchoolRole(req, res, ["admin", "school_admin"]) };
    if (req.query.view === undefined) return res.json(await listMonitoringInterruptions(options));
    if (req.query.view === "summary" && Object.keys(req.query).length === 1) return res.json(await getMonitoringInterruptionSummary(options));
    if (req.query.view !== "history" || Object.keys(req.query).some((key) => !["view", "filter", "cursor"].includes(key))
      || typeof req.query.filter !== "string" || !["open", "recent"].includes(req.query.filter) || (req.query.cursor !== undefined && (typeof req.query.cursor !== "string" || !req.query.cursor))) throw invalidMonitoringHistory();
    return res.json(await listMonitoringInterruptionHistory({ ...options, filter: req.query.filter as "open" | "recent", cursor: req.query.cursor as string | undefined }));
  } catch (error) { next(error); }
});
router.get("/settings", requireRole("admin", "school_admin"), async (_req, res, next) => {
  try { res.json(await getMonitoringInterruptionSettings(res.locals.schoolId!)); } catch (error) { next(error); }
});
router.put("/settings", requireRole("admin", "school_admin"), async (req, res, next) => {
  try {
    if (typeof req.body.digestEnabled !== "boolean" || !Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 0 || Object.keys(req.body).some((key) => !["digestEnabled", "expectedRevision"].includes(key))) return res.status(400).json({ error: "Provide digestEnabled and the current expectedRevision." });
    const saved = await setMonitoringInterruptionSettings(res.locals.schoolId!, req.authUser!.id, req.body.digestEnabled, req.body.expectedRevision);
    await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id, userRole: res.locals.membershipRole, action: "classpilot.monitoring_digest.updated", entityType: "monitoring_digest", metadata: saved });
    res.json(saved);
  } catch (error) { next(error); }
});
export default router;
