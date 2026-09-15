import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { getClasspilotDashboardActivity } from "../../services/classpilotDashboardActivity.js";
import { requireScheduledClassroomContext, scheduledClassroomRoster, requireScheduledClassroomRequestRevision } from "../../services/classpilotActivityAuthority.js";
import { getScheduledClassroomSettings, updateScheduledClassroomSettings } from "../../services/classpilotScheduledClassroomTools.js";
import { requireClasspilotFullMonitoring } from "../../services/classpilotMonitoringPolicy.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { syncClasspilotControlStatesToActiveDevices } from "../../services/classpilotControlStateDelivery.js";

const router = Router();
const auth = [authenticate, requireSchoolContext, requireClasspilotEntitlement, requireRole("admin", "school_admin", "teacher", "office_staff")] as const;
router.get("/dashboard-activity", authenticate, requireSchoolContext, requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "teacher", "office_staff"), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store, private");
      res.json(await getClasspilotDashboardActivity(res.locals.schoolId!, req.authUser!.id));
    } catch (error) { next(error); }
  });
router.get("/supervision-contexts/:id/settings", ...auth, async (req, res, next) => {
  try {
    const context = await requireScheduledClassroomContext({ schoolId: res.locals.schoolId!, supervisionContextId: String(req.params.id),
      actorId: req.authUser!.id, allowObserve: requestHasAnySchoolRole(req, res, ["admin", "school_admin"]) });
    const settings = await getScheduledClassroomSettings(context.schoolId, context.id);
    res.json({ settings: settings ?? { supervisionContextId: context.id, chatEnabled: true, raiseHandEnabled: true, lifecycleRevision: 0 } });
  } catch (error) { next(error); }
});
router.patch("/supervision-contexts/:id/settings", ...auth, requireClasspilotFullMonitoring, async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["chatEnabled", "raiseHandEnabled", "expectedRevision"].includes(key))
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
      || ["chatEnabled", "raiseHandEnabled"].some((key) => key in body && typeof body[key] !== "boolean")
      || !("chatEnabled" in body || "raiseHandEnabled" in body)) {
      return res.status(400).json({ error: "chatEnabled and raiseHandEnabled must be boolean settings" });
    }
    const contextId = String(req.params.id);
    const settings = await updateScheduledClassroomSettings({ schoolId: res.locals.schoolId!, contextId, actorId: req.authUser!.id, ...body,
      contextAuthorityRevision: requireScheduledClassroomRequestRevision(req.get("X-ClassPilot-Context-Authority-Revision")) });
    const roster = await scheduledClassroomRoster(res.locals.schoolId!, contextId);
    await syncClasspilotControlStatesToActiveDevices(res.locals.schoolId!, roster.map((row) => row.student.id));
    res.json({ settings });
  } catch (error) { next(error); }
});
export default router;
