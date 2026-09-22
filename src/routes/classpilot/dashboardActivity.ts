import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { getClasspilotDashboardActivity } from "../../services/classpilotDashboardActivity.js";
import { getClasspilotObservableActivities } from "../../services/classpilotObservableActivities.js";
import { requireScheduledClassroomContext, scheduledClassroomRoster, requireScheduledClassroomRequestRevision } from "../../services/classpilotActivityAuthority.js";
import { getScheduledClassroomSettings, scheduledClassroomToggles, updateScheduledClassroomSettings } from "../../services/classpilotScheduledClassroomTools.js";
import { logAudit } from "../../services/audit.js";
import { requireClasspilotFullMonitoring } from "../../services/classpilotMonitoringPolicy.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { syncClasspilotControlStatesToActiveDevices } from "../../services/classpilotControlStateDelivery.js";

const router = Router();
router.get("/observable-activities", authenticate, requireSchoolContext, requireClasspilotEntitlement,
  requireRole("admin", "school_admin"), requireClasspilotFullMonitoring, async (_req, res, next) => {
    try {
      res.set("Cache-Control", "no-store, private");
      res.json(await getClasspilotObservableActivities(res.locals.schoolId!));
    } catch (error) { next(error); }
  });
const auth = [authenticate, requireSchoolContext, requireClasspilotEntitlement, requireRole("admin", "school_admin", "teacher", "office_staff")] as const;
function scheduledClassroomState(toggles: Awaited<ReturnType<typeof scheduledClassroomToggles>>) {
  return { messagingEnabled: toggles.messagingEnabled, handRaisingEnabled: toggles.handRaisingEnabled,
    messagesPaused: toggles.messagesPaused, pauseReason: toggles.pauseReason, lifecycleRevision: toggles.lifecycleRevision };
}
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
    const toggles = await scheduledClassroomToggles(context.schoolId, context);
    res.json({ settings: toggles.settings ?? { supervisionContextId: context.id, chatEnabled: true, raiseHandEnabled: true, chatPaused: false, lifecycleRevision: 0 },
      state: scheduledClassroomState(toggles) });
  } catch (error) { next(error); }
});
router.patch("/supervision-contexts/:id/settings", ...auth, requireClasspilotFullMonitoring, async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["chatEnabled", "raiseHandEnabled", "chatPaused", "expectedRevision"].includes(key))
      || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
      || ["chatEnabled", "raiseHandEnabled", "chatPaused"].some((key) => key in body && typeof body[key] !== "boolean")
      || !("chatEnabled" in body || "raiseHandEnabled" in body || "chatPaused" in body)) {
      return res.status(400).json({ error: "chatEnabled, raiseHandEnabled and chatPaused must be boolean settings" });
    }
    const contextId = String(req.params.id);
    const settings = await updateScheduledClassroomSettings({ schoolId: res.locals.schoolId!, contextId, actorId: req.authUser!.id, ...body,
      contextAuthorityRevision: requireScheduledClassroomRequestRevision(req.get("X-ClassPilot-Context-Authority-Revision")) });
    const context = await requireScheduledClassroomContext({ schoolId: res.locals.schoolId!, supervisionContextId: contextId, actorId: req.authUser!.id });
    const roster = await scheduledClassroomRoster(res.locals.schoolId!, contextId);
    await syncClasspilotControlStatesToActiveDevices(res.locals.schoolId!, roster.map((row) => row.student.id));
    if (typeof body.chatPaused === "boolean") {
      await logAudit({ schoolId: res.locals.schoolId!, userId: req.authUser!.id, userRole: res.locals.membershipRole,
        action: body.chatPaused ? "classpilot.chat.paused" : "classpilot.chat.resumed", entityType: "supervision_context", entityId: contextId,
        metadata: { lifecycleRevision: settings.lifecycleRevision, targetedStudentCount: roster.length } });
    }
    res.json({ settings, state: scheduledClassroomState(await scheduledClassroomToggles(context.schoolId, context)) });
  } catch (error) { next(error); }
});
export default router;
