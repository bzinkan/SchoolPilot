import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { getScheduleProfiles, saveScheduleProfile, previewScheduleProfile, applyScheduleProfile, cancelScheduleProfileApplication } from "../../services/classpilotScheduleProfiles.js";
import { getClasspilotRegularSchedule } from "../../services/classpilotRegularSchedule.js";
import { getScheduleDraftReview } from "../../services/classpilotScheduleDraftReview.js";
import { logAudit } from "../../services/audit.js";
import { broadcastClasspilotScheduleChangeUpdate } from "../../services/classpilotScheduleChanges.js";

const router = Router();
router.use(authenticate, requireSchoolContext, requireClasspilotEntitlement, requireRole("admin", "school_admin"));
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
router.get("/regular-schedule", async (req, res, next) => {
  try { res.json(await getClasspilotRegularSchedule({ schoolId: res.locals.schoolId!, referenceDate: req.query.referenceDate })); }
  catch (error) { next(error); }
});
router.post("/draft-review", async (req, res, next) => {
  try { res.json(await getScheduleDraftReview({ schoolId: res.locals.schoolId!, referenceDate: req.body.referenceDate, definition: req.body.definition })); }
  catch (error) { next(error); }
});
router.get("/", async (_req, res, next) => {
  try { res.json(await getScheduleProfiles(res.locals.schoolId!)); } catch (error) { next(error); }
});
router.post("/", async (req, res, next) => {
  try {
    const result = await saveScheduleProfile({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id, revision: req.body.revision, id: req.body.id, profileRevision: req.body.profileRevision, definition: req.body.definition, previewDate: req.body.previewDate });
    await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id, userRole: res.locals.membershipRole, action: "classpilot.schedule_profile.saved", entityType: "schedule_profile", entityId: result.profile.id, metadata: { revision: result.profile.revision, classRules: result.profile.definition.classRules.length, testingBlocks: result.profile.definition.testingBlocks.length, ...(result.profile.previewDate !== undefined ? { previewDate: result.profile.previewDate } : {}) } });
    res.status(req.body.id ? 200 : 201).json(result);
  } catch (error) { next(error); }
});
router.post("/preview", async (req, res, next) => {
  try { res.json(await previewScheduleProfile({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id, revision: req.body.revision, profileId: req.body.profileId, profileRevision: req.body.profileRevision, dates: req.body.dates, definition: req.body.definition })); }
  catch (error) { next(error); }
});
router.post("/apply", async (req, res, next) => {
  try {
    const result = await applyScheduleProfile({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id, revision: req.body.revision, profileId: req.body.profileId, profileRevision: req.body.profileRevision, dates: req.body.dates, definition: req.body.definition, previewToken: req.body.previewToken });
    await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id, userRole: res.locals.membershipRole, action: "classpilot.schedule_profile.applied", entityType: "schedule_profile_application", entityId: result.application.id, metadata: { profileId: result.application.profileId, profileRevision: result.application.profileRevision, dateCount: result.application.dates.length, testingWindows: result.application.testingWindows.length } });
    await broadcastClasspilotScheduleChangeUpdate({ schoolId: res.locals.schoolId!, revision: result.revision }).catch(() => undefined);
    res.status(201).json(result);
  } catch (error) { next(error); }
});
router.post("/applications/:id/cancel", async (req, res, next) => {
  try {
    const result = await cancelScheduleProfileApplication({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id, revision: req.body.revision, applicationId: String(req.params.id) });
    await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id, userRole: res.locals.membershipRole, action: "classpilot.schedule_profile.cancelled", entityType: "schedule_profile_application", entityId: String(req.params.id), metadata: { revision: result.revision } });
    await broadcastClasspilotScheduleChangeUpdate({ schoolId: res.locals.schoolId!, revision: result.revision }).catch(() => undefined);
    res.json(result);
  } catch (error) { next(error); }
});
export default router;
