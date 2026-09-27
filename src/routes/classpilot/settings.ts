import { Router, type RequestHandler } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { ClasspilotSettingsError, getClasspilotSchoolSettings, getClasspilotTeacherPreferences,
  updateClasspilotSchoolSettings, updateClasspilotTeacherPreferences } from "../../services/classpilotSettings.js";

const router = Router();
const auth = [authenticate, requireSchoolContext, requireActiveSchool, requireClasspilotEntitlement] as const;
const teachers = requireRole("teacher", "admin", "school_admin");
const administrators = requireRole("admin", "school_admin");
function handle(action: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(action(req, res, next)).catch(error => {
      if (error instanceof ClasspilotSettingsError) {
        res.status(error.status).json({ error: error.message, code: error.code,
          ...(error.current === undefined ? {} : { current: error.current }) });
      } else if (error?.code === "SCHOOL_WEBSITE_POLICY_CONFLICT") {
        res.status(409).json({ error: error.message, code: error.code, revision: error.revision });
      } else next(error);
    });
  };
}
router.get("/teacher/preferences", ...auth, teachers, handle(async (req, res) => {
  res.json(await getClasspilotTeacherPreferences({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id }));
}));
router.patch("/teacher/preferences", ...auth, teachers, handle(async (req, res) => {
  res.json(await updateClasspilotTeacherPreferences({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id }, req.body));
}));
router.get("/admin/settings", ...auth, administrators, handle(async (req, res) => {
  res.json(await getClasspilotSchoolSettings({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id }));
}));
router.patch("/admin/settings/:section", ...auth, administrators, handle(async (req, res) => {
  res.json(await updateClasspilotSchoolSettings({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id }, String(req.params.section), req.body));
}));
export default router;
