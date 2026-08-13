import { Router, type RequestHandler } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getPickupsForStudent,
  createPickup,
  transitionAuthorizedPickupStatus,
  getCustodyAlertsBySchool,
  createCustodyAlert,
  getStudentById,
} from "../../services/storage.js";
import { getRequestGoPilotRole } from "../../services/gopilotAccess.js";
import {
  isAuthorizedPickupStatus,
  isAuthorizedPickupManagerRole,
  toAuthorizedPickupDto,
} from "../../util/gopilotParentContainment.js";
import { rejectDisabledGoPilotParent } from "../../middleware/rejectDisabledGoPilotParent.js";
import { logAudit } from "../../services/audit.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const requirePickupManager: RequestHandler = async (req, res, next) => {
  try {
    const role = await getRequestGoPilotRole(req, res);
    if (!isAuthorizedPickupManagerRole(role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

const auth = [
  authenticate,
  requireSchoolContext,
  rejectDisabledGoPilotParent,
  requireActiveSchool,
  requireProductLicense("GOPILOT"),
] as const;

const manageAuth = [
  ...auth,
  requirePickupManager,
] as const;

// ============================================================================
// Authorized Pickups
// ============================================================================

// GET /api/gopilot/pickups/all — All pickups for this school (admin/office)
router.get("/all", ...manageAuth, async (req, res, next) => {
  try {
    const { getPickupsBySchool } = await import("../../services/storage.js");
    const pickups = await getPickupsBySchool(res.locals.schoolId!);
    return res.json({ pickups: pickups.map(toAuthorizedPickupDto) });
  } catch (err) {
    next(err);
  }
});

// GET /api/gopilot/pickups/student/:studentId
router.get("/student/:studentId", ...manageAuth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const schoolId = res.locals.schoolId!;
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }

    const pickups = await getPickupsForStudent(studentId);
    return res.json({ pickups: pickups.map(toAuthorizedPickupDto) });
  } catch (err) {
    next(err);
  }
});

// POST /api/gopilot/pickups/student/:studentId
router.post("/student/:studentId", ...manageAuth, async (req, res, next) => {
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
      schoolId: res.locals.schoolId!,
      studentId,
      addedBy: req.authUser!.id,
      name,
      relationship,
      phone: phone || null,
      status: "pending",
    });

    await logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.gopilotRole,
      action: "gopilot.authorized_pickup.created",
      entityType: "authorized_pickup",
      entityId: pickup.id,
      metadata: { status: "pending" },
    });

    return res.status(201).json({ pickup: toAuthorizedPickupDto(pickup) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/gopilot/pickups/:id
router.put("/:id", ...manageAuth, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!isAuthorizedPickupStatus(status)) {
      return res.status(400).json({
        error: "status must be pending, approved, or revoked",
      });
    }
    const result = await transitionAuthorizedPickupStatus(
      param(req, "id"),
      res.locals.schoolId!,
      status
    );
    if (result.outcome === "not_found") {
      return res.status(404).json({ error: "Pickup not found" });
    }
    if (result.outcome === "invalid_status") {
      return res.status(409).json({
        error: "Pickup has an invalid legacy status and requires staff review",
        code: "GOPILOT_PICKUP_INVALID_STATUS",
      });
    }
    if (result.outcome === "invalid_transition") {
      return res.status(409).json({
        error: `Cannot change an authorized pickup from ${result.pickup.status} to ${status}`,
        code: "GOPILOT_PICKUP_INVALID_TRANSITION",
      });
    }
    if (result.outcome === "updated") {
      await logAudit({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole,
        action: "gopilot.authorized_pickup.status_changed",
        entityType: "authorized_pickup",
        entityId: result.pickup.id,
        changes: { from: result.previousStatus, to: result.pickup.status },
      });
    }
    return res.json({ pickup: toAuthorizedPickupDto(result.pickup) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/gopilot/pickups/:id - Revoke (soft delete)
router.delete("/:id", ...manageAuth, async (req, res, next) => {
  try {
    const result = await transitionAuthorizedPickupStatus(
      param(req, "id"),
      res.locals.schoolId!,
      "revoked"
    );
    if (result.outcome === "not_found") {
      return res.status(404).json({ error: "Pickup not found" });
    }
    if (result.outcome === "invalid_status") {
      return res.status(409).json({
        error: "Pickup has an invalid legacy status and requires staff review",
        code: "GOPILOT_PICKUP_INVALID_STATUS",
      });
    }
    if (result.outcome === "invalid_transition") {
      return res.status(409).json({
        error: `Cannot revoke an authorized pickup from ${result.pickup.status}`,
        code: "GOPILOT_PICKUP_INVALID_TRANSITION",
      });
    }
    if (result.outcome === "updated") {
      await logAudit({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole,
        action: "gopilot.authorized_pickup.revoked",
        entityType: "authorized_pickup",
        entityId: result.pickup.id,
        changes: { from: result.previousStatus, to: "revoked" },
      });
    }
    return res.json({ ok: true, status: "revoked" });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Custody Alerts
// ============================================================================

// GET /api/gopilot/pickups/custody-alerts
router.get("/custody-alerts", ...manageAuth, async (req, res, next) => {
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
  ...manageAuth,
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
        schoolId: res.locals.schoolId!,
        studentId,
        personName,
        alertType,
        notes: notes || null,
        courtOrder: courtOrder || null,
        createdBy: req.authUser!.id,
      });

      await logAudit({
        schoolId: res.locals.schoolId!,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.gopilotRole,
        action: "gopilot.custody_alert.created",
        entityType: "custody_alert",
        entityId: alert.id,
        metadata: { alertType },
      });

      return res.status(201).json({ alert });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
