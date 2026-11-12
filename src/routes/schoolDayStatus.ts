import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { requireClasspilotEntitlement } from "../middleware/requireClasspilotEntitlement.js";
import { requireGopilotEntitlement } from "../middleware/requireGopilotEntitlement.js";
import { requireProductLicense } from "../middleware/requireProductLicense.js";
import { requireRole } from "../middleware/requireRole.js";
import { rejectDisabledGoPilotParent } from "../middleware/rejectDisabledGoPilotParent.js";
import { requirePassPilotRole } from "../services/passpilotAccess.js";
import { requireGoPilotRole } from "../services/gopilotAccess.js";
import { getSchoolDayStatus, type SchoolDayStatusProduct } from "../services/schoolDayStatus.js";

/** Product roles stay authoritative, including GoPilot-only staff overrides. */
export function createSchoolDayStatusRouter(product: SchoolDayStatusProduct) {
  const router = Router();
  router.use(authenticate, requireSchoolContext);
  if (product === "classpilot") {
    router.use(requireActiveSchool, requireClasspilotEntitlement, requireRole("admin", "school_admin", "office_staff", "teacher"));
  } else if (product === "passpilot") {
    router.use(requireActiveSchool, requireProductLicense("PASSPILOT"), requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"));
  } else {
    router.use(rejectDisabledGoPilotParent, requireActiveSchool, requireGopilotEntitlement, requireGoPilotRole("admin", "school_admin", "office_staff", "teacher"));
  }
  router.get("/", async (_req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      return res.json(await getSchoolDayStatus(res.locals.schoolId!, product));
    } catch (error) { return next(error); }
  });
  return router;
}
