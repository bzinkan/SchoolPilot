import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getPickupsForStudent,
  createPickup,
  updatePickupStatus,
  revokePickup,
  getCustodyAlertsBySchool,
  createCustodyAlert,
  getStudentById,
} from "../../services/storage.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
] as const;

// ============================================================================
// Authorized Pickups
// ============================================================================

// GET /api/gopilot/pickups/student/:studentId
router.get("/student/:studentId", ...auth, async (req, res, next) => {
  try {
    const pickups = await getPickupsForStudent(param(req, "studentId"));
    return res.json({ pickups });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/pickups/student/:studentId
router.post("/student/:studentId", ...auth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const { name, relationship, phone } = req.body;

    if (!name || !relationship) {
      return res
        .status(400)
        .json({ error: "name and relationship are required" });
    }

    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    const pickup = await createPickup({
      studentId,
      addedBy: req.authUser!.id,
      name,
      relationship,
      phone: phone || null,
    });

    return res.status(201).json({ pickup });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/pickups/:id
router.put("/:id", ...auth, async (req, res, next) => {
  try {
    const { status } = req.body;
    const updated = await updatePickupStatus(param(req, "id"), status);
    if (!updated) {
      return res.status(404).json({ error: "Pickup not found" });
    }
    return res.json({ pickup: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gopilot/pickups/:id - Revoke (soft delete)
router.delete("/:id", ...auth, async (req, res, next) => {
  try {
    await revokePickup(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Custody Alerts
// ============================================================================

// GET /api/gopilot/pickups/custody-alerts
router.get("/custody-alerts", ...auth, async (req, res, next) => {
  try {
    const alerts = await getCustodyAlertsBySchool(res.locals.schoolId!);
    return res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/pickups/student/:studentId/custody-alert
router.post(
  "/student/:studentId/custody-alert",
  ...auth,
  async (req, res, next) => {
    try {
      const studentId = param(req, "studentId");
      const { personName, alertType, notes, courtOrder } = req.body;

      if (!personName || !alertType) {
        return res
          .status(400)
          .json({ error: "personName and alertType are required" });
      }

      const student = await getStudentById(studentId);
      if (!student || student.schoolId !== res.locals.schoolId) {
        return res.status(404).json({ error: "Student not found" });
      }

      const alert = await createCustodyAlert({
        studentId,
        personName,
        alertType,
        notes: notes || null,
        courtOrder: courtOrder || null,
        createdBy: req.authUser!.id,
      });

      return res.status(201).json({ alert });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
