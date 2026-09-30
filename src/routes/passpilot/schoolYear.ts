import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requirePassPilotRole } from "../../services/passpilotAccess.js";
import { getPasspilotSchoolYear, previewPasspilotSchoolYear, savePasspilotSchoolYear,
  passpilotSchoolYearSchema, savePasspilotSchoolYearSchema } from "../../services/passpilotSchoolYear.js";

const router = Router();
router.use(authenticate, requireSchoolContext, requireActiveSchool, requireProductLicense("PASSPILOT"), requirePassPilotRole("admin", "school_admin"));
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
router.get("/", async (req, res, next) => {
  try { res.json(await getPasspilotSchoolYear(res.locals.schoolId!, req.authUser!)); } catch (error) { next(error); }
});
router.post("/preview", async (req, res, next) => {
  try {
    const body = passpilotSchoolYearSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Choose both school-year dates.", code: "PASSPILOT_SCHOOL_YEAR_INVALID" });
    return res.json(await previewPasspilotSchoolYear(res.locals.schoolId!, req.authUser!, body.data));
  } catch (error) { next(error); }
});
router.put("/", async (req, res, next) => {
  try {
    const body = savePasspilotSchoolYearSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Preview both school-year dates before saving.", code: "PASSPILOT_SCHOOL_YEAR_INVALID" });
    return res.json(await savePasspilotSchoolYear(res.locals.schoolId!, req.authUser!, body.data));
  } catch (error) { next(error); }
});
export default router;
