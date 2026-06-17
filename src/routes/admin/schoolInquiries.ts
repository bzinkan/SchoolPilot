import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import {
  createSchoolInquiry,
  getSchoolInquiries,
  updateSchoolInquiry,
  deleteSchoolInquiry,
} from "../../services/storage.js";
import { sendSchoolInquiryNotification, sendSchoolInquiryConfirmation } from "../../services/email.js";

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

function cleanOptional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeProducts(value: unknown): string | null {
  const allowed = new Set(["CLASSPILOT", "PASSPILOT", "GOPILOT"]);
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const products = raw
    .map((p) => String(p).trim().toUpperCase())
    .filter((p) => allowed.has(p));
  return products.length > 0 ? Array.from(new Set(products)).join(",") : null;
}

// POST /api/admin/school-inquiries - Public informational inquiry
router.post("/", async (req, res, next) => {
  try {
    const {
      schoolName,
      domain,
      contactName,
      contactEmail,
      contactPhone,
      preferredContactMethod,
      adminItEmail,
      billingEmail,
      estimatedStudents,
      interestedProducts,
      questions,
    } = req.body;

    if (!schoolName || !contactName || !contactEmail) {
      return res
        .status(400)
        .json({ error: "schoolName, contactName, and contactEmail are required" });
    }

    const cleanEmail = String(contactEmail).trim().toLowerCase();
    const products = normalizeProducts(interestedProducts);

    // Avoid duplicate open inquiries for the same contact without exposing
    // whether a specific email already submitted the form.
    const existing = await getSchoolInquiries({ status: "pending" });
    const dup = existing.find((i) => i.contactEmail.toLowerCase() === cleanEmail);
    if (dup) {
      return res.json({ success: true, message: "Inquiry received" });
    }

    const inquiry = await createSchoolInquiry({
      schoolName: String(schoolName).trim(),
      domain: cleanOptional(domain),
      contactName: String(contactName).trim(),
      contactEmail: cleanEmail,
      contactPhone: cleanOptional(contactPhone),
      preferredContactMethod: cleanOptional(preferredContactMethod),
      adminItEmail: cleanOptional(adminItEmail),
      billingEmail: cleanOptional(billingEmail),
      estimatedStudents: cleanOptional(estimatedStudents),
      interestedProducts: products,
      questions: cleanOptional(questions),
      status: "pending",
    });

    await sendSchoolInquiryNotification({
      schoolName: inquiry.schoolName,
      contactName: inquiry.contactName,
      contactEmail: inquiry.contactEmail,
      contactPhone: inquiry.contactPhone,
      preferredContactMethod: inquiry.preferredContactMethod,
      adminItEmail: inquiry.adminItEmail,
      billingEmail: inquiry.billingEmail,
      estimatedStudents: inquiry.estimatedStudents,
      interestedProducts: inquiry.interestedProducts,
      questions: inquiry.questions,
    });

    await sendSchoolInquiryConfirmation({
      contactName: inquiry.contactName,
      contactEmail: inquiry.contactEmail,
      schoolName: inquiry.schoolName,
    });

    return res.status(201).json({ success: true, inquiry });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/school-inquiries - Super admin: list inquiries
router.get("/", authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const { status, product } = req.query;
    const inquiries = await getSchoolInquiries({
      status: status as string,
      product: product as string,
    });
    return res.json({ inquiries });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/school-inquiries/:id - Super admin: update inquiry
router.patch("/:id", authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { status, notes, schoolId } = req.body;

    const data: Record<string, unknown> = {};
    if (status !== undefined) {
      if (!["pending", "contacted", "converted", "closed"].includes(status)) {
        return res.status(400).json({ error: "Invalid inquiry status" });
      }
      data.status = status;
    }
    if (notes !== undefined) data.notes = notes;
    if (schoolId !== undefined) data.schoolId = schoolId || null;

    if (status === "contacted" || status === "converted" || status === "closed") {
      data.processedBy = req.authUser!.id;
      data.processedAt = new Date();
    }

    const updated = await updateSchoolInquiry(id, data);
    if (!updated) {
      return res.status(404).json({ error: "School inquiry not found" });
    }

    return res.json({ inquiry: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/school-inquiries/:id - Super admin: delete inquiry
router.delete("/:id", authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    await deleteSchoolInquiry(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
