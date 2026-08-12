import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getRequestPassPilotRole,
  isPassPilotManager,
  requirePasspilotClassModel,
  requirePassPilotRole,
} from "../../services/passpilotAccess.js";
import {
  getPasspilotClasses,
  getPasspilotClassRoster,
} from "../../services/passpilotClasses.js";
import { safeStudent } from "../../util/safeStudent.js";

const router = Router();

router.use(
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher")
);
router.use(requirePasspilotClassModel);

router.get("/", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    const result = await getPasspilotClasses(schoolId, {
      userId: req.authUser!.id,
      manager: isPassPilotManager(role),
      scope: req.query.scope === "history" ? "history" : "active",
    });
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/students", async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = await getRequestPassPilotRole(req, res);
    const result = await getPasspilotClassRoster(schoolId, String(req.params.id ?? ""), {
      userId: req.authUser!.id,
      manager: isPassPilotManager(role),
    });
    if (!result) return res.status(404).json({ error: "Class not found" });
    return res.json({
      source: result.source,
      class: result.classRecord,
      students: result.students.map((student) => safeStudent(student)),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
