import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { AppButtonError, appButtonDeleteInput, appButtonEditInput, appButtonInput, appButtonPreferenceInput } from "../../services/classpilotApps.js";
import { createClasspilotAppButton, deleteClasspilotAppButton, getClasspilotAppLibrary,
  setClasspilotAppButtonPreference, updateClasspilotAppButton } from "../../services/storage.js";

const router = Router();
const rejectSupportImpersonation: RequestHandler = (req, res, next) => {
  if (req.session?.impersonating || req.session?.originalUserId) {
    res.status(403).json({ error: "App buttons are unavailable during administrator support access", code: "CLASSPILOT_APPS_IMPERSONATION_BLOCKED" });
    return;
  }
  next();
};
router.use(rejectSupportImpersonation, authenticate, requireSchoolContext, requireActiveSchool, requireClasspilotEntitlement,
  requireRole("teacher", "admin", "school_admin"));
const actor = (req: Request, res: Response) => ({ teacherId: req.authUser!.id, isAdmin: requestHasAnySchoolRole(req, res, ["admin", "school_admin"]) });
const handle = (action: RequestHandler): RequestHandler => (req, res, next) => {
  void Promise.resolve(action(req, res, next)).catch(error => {
    if (error instanceof AppButtonError) res.status(error.status).json({ error: error.message, code: error.code });
    else if (error instanceof z.ZodError) res.status(400).json({ error: error.issues[0]?.message || "App button input is invalid", code: "CLASSPILOT_APP_INPUT_INVALID" });
    else next(error);
  });
};

router.get("/", handle(async (req, res) => {
  res.json(await getClasspilotAppLibrary(res.locals.schoolId!, actor(req, res)));
}));
router.post("/", handle(async (req, res) => {
  const input = appButtonInput.parse(req.body);
  res.status(201).json({ app: await createClasspilotAppButton(res.locals.schoolId!, actor(req, res), input) });
}));
router.patch("/:key", handle(async (req, res) => {
  const input = appButtonEditInput.parse(req.body);
  res.json({ app: await updateClasspilotAppButton(res.locals.schoolId!, actor(req, res), String(req.params.key), input) });
}));
router.delete("/:key", handle(async (req, res) => {
  const input = appButtonDeleteInput.parse(req.body);
  await deleteClasspilotAppButton(res.locals.schoolId!, actor(req, res), String(req.params.key), input.expectedRevision);
  res.status(204).end();
}));
router.put("/:key/preferences", handle(async (req, res) => {
  const input = appButtonPreferenceInput.parse(req.body);
  res.json({ app: await setClasspilotAppButtonPreference(res.locals.schoolId!, actor(req, res), String(req.params.key), input) });
}));

export default router;
