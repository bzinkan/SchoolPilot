import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { getSchoolSchedulingContext, previewSchoolScheduling, saveSchoolScheduling } from "../../services/classpilotScheduling.js";
import { normalizeSchoolSchedulingConfig, schedulingError } from "../../services/classpilotSchedulingRules.js";
import { logAudit } from "../../services/audit.js";
import { getSchoolById } from "../../services/storage.js";
import { localDateInTimeZone } from "../../util/schoolTime.js";

const router = Router();
router.use(authenticate, requireSchoolContext, requireClasspilotEntitlement, requireRole("admin", "school_admin"));
router.get("/", async (_req, res, next) => {
  try {
    const [context, school] = await Promise.all([getSchoolSchedulingContext(res.locals.schoolId!), getSchoolById(res.locals.schoolId!)]);
    const schoolTimezone = school?.schoolTimezone || "America/New_York";
    res.setHeader("Cache-Control", "no-store"); res.json({ ...context, schoolTimezone, schoolLocalToday: localDateInTimeZone(new Date(), schoolTimezone) });
  } catch (error) { next(error); }
});
router.post("/preview", async (req, res, next) => {
  try { res.json(await previewSchoolScheduling({ schoolId: res.locals.schoolId!, config: normalizeSchoolSchedulingConfig(req.body.config) })); } catch (error) { next(error); }
});
router.put("/", async (req, res, next) => {
  try {
    if (!Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 0 || typeof req.body.previewToken !== "string" || !/^[a-f0-9]{64}$/.test(req.body.previewToken)) throw schedulingError("Preview the schedule changes before saving.");
    const result = await saveSchoolScheduling({ schoolId: res.locals.schoolId!, config: req.body.config, expectedRevision: req.body.expectedRevision, previewToken: req.body.previewToken, actorId: req.authUser!.id });
    await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id, userRole: res.locals.membershipRole, action: "classpilot.scheduling.updated", entityType: "school_schedule", metadata: { revision: result.revision, changedOccurrences: result.changedOccurrences } });
    res.json(result);
  } catch (error) { next(error); }
});
export default router;
