import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { getClasspilotScheduledSupervision } from "../../services/classpilotScheduledSupervision.js";

const router = Router();
router.get("/coverage/scheduled", authenticate, requireSchoolContext, requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "teacher", "office_staff"), async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store, private");
      res.json(await getClasspilotScheduledSupervision({ schoolId: res.locals.schoolId!, actorId: req.authUser!.id,
        admin: requestHasAnySchoolRole(req, res, ["admin", "school_admin"]), date: req.query.date }));
    } catch (error) { next(error); }
  });
export default router;
