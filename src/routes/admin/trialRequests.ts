import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createTrialRequest,
  getTrialRequests,
  getTrialRequestById,
  updateTrialRequest,
  deleteTrialRequest,
} from "../../services/storage.js";
import { sendTrialRequestNotification } from "../../services/email.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function requireSuperAdmin(req: any, res: any, next: any) {
  if (!req.authUser?.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}

// POST /api/trial-requests - Public: submit trial request
router.post("/", async (req, res, next) => {
  try {
    const {
      schoolName,
      domain,
      contactName,
      contactEmail,
      adminPhone,
      estimatedStudents,
      estimatedTeachers,
      message,
      zipCode,
      product,
    } = req.body;

    if (!schoolName || !contactName || !contactEmail) {
      return res
        .status(400)
        .json({ error: "schoolName, contactName, and contactEmail are required" });
    }

    // Check for duplicate (same email, pending)
    const existing = await getTrialRequests({ status: "pending" });
    const dup = existing.find(
      (r) => r.contactEmail.toLowerCase() === contactEmail.toLowerCase()
    );
    if (dup) {
      // Return success to avoid email enumeration
      return res.json({ success: true, message: "Request received" });
    }

    const request = await createTrialRequest({
      schoolName,
      domain: domain || null,
      contactName,
      contactEmail,
      adminPhone: adminPhone || null,
      estimatedStudents: estimatedStudents || null,
      estimatedTeachers: estimatedTeachers || null,
      message: message || null,
      zipCode: zipCode || null,
      product: product || null,
      status: "pending",
    });

    await sendTrialRequestNotification({
      schoolName,
      contactName,
      contactEmail,
      product,
    });

    return res.status(201).json({ success: true, request });
  } catch (err) {
    next(err);
  }
});

// GET /api/trial-requests - Super admin: list trial requests
router.get("/", authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const { status, product } = req.query;
    const requests = await getTrialRequests({
      status: status as string,
      product: product as string,
    });
    return res.json({ requests });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/trial-requests/:id - Super admin: update trial request
router.patch("/:id", authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { status, notes } = req.body;

    const data: Record<string, unknown> = {};
    if (status !== undefined) data.status = status;
    if (notes !== undefined) data.notes = notes;

    if (status === "contacted" || status === "converted" || status === "declined") {
      data.processedBy = req.authUser!.id;
      data.processedAt = new Date();
    }

    const updated = await updateTrialRequest(id, data);
    if (!updated) {
      return res.status(404).json({ error: "Trial request not found" });
    }

    return res.json({ request: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/trial-requests/:id - Super admin: delete trial request
router.delete("/:id", authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    await deleteTrialRequest(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
