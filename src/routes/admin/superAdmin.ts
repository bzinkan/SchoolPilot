import { Router } from "express";
import crypto from "crypto";
import { authenticate } from "../../middleware/authenticate.js";
import {
  getAllSchools,
  getSchoolById,
  createSchool,
  updateSchool,
  softDeleteSchool,
  getMembershipsBySchool,
  createMembership,
  createUser,
  getUserByEmail,
  getStudentsBySchool,
  getStaffBySchool,
  getAllProductLicenses,
  getProductLicenses,
  createProductLicense,
  deleteProductLicense,
  deleteMembership,
  updateUser,
} from "../../services/storage.js";
import { hashPassword } from "../../util/password.js";
import { sendWelcomeEmail } from "../../services/email.js";
import { logAudit } from "../../services/audit.js";

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

const auth = [authenticate, requireSuperAdmin] as const;

// GET /api/super-admin/stats - Dashboard statistics
router.get("/stats", ...auth, async (req, res, next) => {
  try {
    const schools = await getAllSchools();
    const active = schools.filter((s) => s.status === "active").length;
    const trial = schools.filter((s) => s.status === "trial").length;
    const suspended = schools.filter((s) => s.status === "suspended").length;

    return res.json({
      totalSchools: schools.length,
      activeSchools: active,
      trialSchools: trial,
      suspendedSchools: suspended,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/super-admin/schools - List all schools
router.get("/schools", ...auth, async (req, res, next) => {
  try {
    const [schools, licenses] = await Promise.all([
      getAllSchools(),
      getAllProductLicenses(),
    ]);

    // Build a map of schoolId -> active product names
    const licenseMap = new Map<string, string[]>();
    for (const lic of licenses) {
      if (lic.status === "active") {
        const arr = licenseMap.get(lic.schoolId) || [];
        arr.push(lic.product);
        licenseMap.set(lic.schoolId, arr);
      }
    }

    const { search, status } = req.query;

    let filtered = schools;
    if (status && status !== "all") {
      filtered = filtered.filter((s) => s.status === status);
    }
    if (search) {
      const term = (search as string).toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.name.toLowerCase().includes(term) ||
          (s.domain && s.domain.toLowerCase().includes(term))
      );
    }

    const result = filtered.map((s) => ({
      ...s,
      products: licenseMap.get(s.id) || [],
    }));

    return res.json({ schools: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/schools - Create school with first admin
router.post("/schools", ...auth, async (req, res, next) => {
  try {
    const {
      name,
      domain,
      status,
      maxLicenses,
      maxStudents,
      billingEmail,
      trialDays,
      // Support both naming conventions from frontend
      adminEmail, firstAdminEmail,
      adminFirstName, firstAdminName,
      adminLastName,
      adminPassword, firstAdminPassword,
      products,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    // Resolve field names (frontend sends firstAdmin*, backend originally used admin*)
    const resolvedAdminEmail = adminEmail || firstAdminEmail;
    const resolvedAdminPassword = adminPassword || firstAdminPassword;
    const resolvedAdminFirstName = adminFirstName || firstAdminName;
    const resolvedAdminLastName = adminLastName || "";

    const schoolData: Record<string, unknown> = {
      name,
      domain: domain || null,
      status: status || "active",
      billingEmail: billingEmail || null,
    };

    if (maxLicenses !== undefined) schoolData.maxLicenses = maxLicenses;
    if (maxStudents !== undefined) schoolData.maxStudents = maxStudents;

    if (trialDays) {
      schoolData.status = "trial";
      schoolData.trialEndsAt = new Date(Date.now() + trialDays * 86400000);
    }

    const school = await createSchool(schoolData as any);

    // Create product licenses if provided
    if (Array.isArray(products) && products.length > 0) {
      for (const product of products) {
        if (["CLASSPILOT", "PASSPILOT", "GOPILOT"].includes(product)) {
          await createProductLicense({ schoolId: school.id, product, status: "active" });
        }
      }
    }

    // Create admin user if provided
    let tempPassword: string | undefined;
    if (resolvedAdminEmail) {
      const adminEmail = resolvedAdminEmail as string;
      const pwd = resolvedAdminPassword || crypto.randomBytes(8).toString("hex");
      tempPassword = pwd;
      const hashed = await hashPassword(pwd);

      // Split name into first/last if provided as a single "firstAdminName" field
      let firstName = resolvedAdminFirstName || "Admin";
      let lastName = resolvedAdminLastName;
      if (firstName && !lastName && firstName.includes(" ")) {
        const parts = firstName.split(" ");
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }

      let user = await getUserByEmail(adminEmail);
      if (!user) {
        user = await createUser({
          email: adminEmail,
          password: hashed,
          firstName,
          lastName,
        });
      }

      await createMembership({
        userId: user.id,
        schoolId: school.id,
        role: "admin",
        status: "active",
      });

      await sendWelcomeEmail(adminEmail, name, pwd);
    }

    await logAudit({
      schoolId: school.id,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      action: "school.created",
      entityType: "school",
      entityId: school.id,
      entityName: name,
    });

    return res.status(201).json({ school, tempPassword });
  } catch (err) {
    next(err);
  }
});

// GET /api/super-admin/schools/:id - Get school details
router.get("/schools/:id", ...auth, async (req, res, next) => {
  try {
    const school = await getSchoolById(param(req, "id"));
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }

    const [memberships, students, licenses] = await Promise.all([
      getMembershipsBySchool(school.id),
      getStudentsBySchool(school.id),
      getProductLicenses(school.id),
    ]);

    // Flatten membership + user data so the frontend can read email/displayName directly
    const flattenMembership = (m: any) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      email: m.user?.email,
      firstName: m.user?.firstName,
      lastName: m.user?.lastName,
      displayName: m.user?.displayName
        || [m.user?.firstName, m.user?.lastName].filter(Boolean).join(" ")
        || m.user?.email,
    });

    const admins = memberships.filter((m) => m.role === "admin").map(flattenMembership);
    const teachers = memberships.filter((m) => m.role === "teacher").map(flattenMembership);
    const products = licenses
      .filter((l) => l.status === "active")
      .map((l) => l.product);

    return res.json({
      ...school,
      admins,
      teachers,
      staff: memberships.map(flattenMembership),
      studentCount: students.length,
      products,
      productLicenses: licenses,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/super-admin/schools/:id - Update school
router.patch("/schools/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { name, domain, status, billingEmail, schoolTimezone, maxStudents, maxLicenses, planTier, planStatus, activeUntil } = req.body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (domain !== undefined) data.domain = domain;
    if (status !== undefined) data.status = status;
    if (billingEmail !== undefined) data.billingEmail = billingEmail;
    if (schoolTimezone !== undefined) data.schoolTimezone = schoolTimezone;
    if (maxStudents !== undefined) data.maxStudents = maxStudents;
    if (maxLicenses !== undefined) data.maxLicenses = maxLicenses;
    if (planTier !== undefined) data.planTier = planTier;
    if (planStatus !== undefined) data.planStatus = planStatus;
    if (activeUntil !== undefined) data.activeUntil = activeUntil ? new Date(activeUntil) : null;

    const updated = await updateSchool(id, data);
    if (!updated) {
      return res.status(404).json({ error: "School not found" });
    }

    await logAudit({
      schoolId: id,
      userId: req.authUser!.id,
      action: "school.updated",
      entityType: "school",
      entityId: id,
      changes: data,
    });

    return res.json({ school: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/super-admin/schools/:id - Soft delete school
router.delete("/schools/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    await softDeleteSchool(id);

    await logAudit({
      schoolId: id,
      userId: req.authUser!.id,
      action: "school.deleted",
      entityType: "school",
      entityId: id,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/schools/:id/suspend - Suspend school
router.post("/schools/:id/suspend", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const updated = await updateSchool(id, { status: "suspended" });
    if (!updated) {
      return res.status(404).json({ error: "School not found" });
    }

    await logAudit({
      schoolId: id,
      userId: req.authUser!.id,
      action: "school.suspended",
      entityType: "school",
      entityId: id,
    });

    return res.json({ school: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/schools/:id/restore - Restore school
router.post("/schools/:id/restore", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const updated = await updateSchool(id, { status: "active", deletedAt: null });
    if (!updated) {
      return res.status(404).json({ error: "School not found" });
    }

    await logAudit({
      schoolId: id,
      userId: req.authUser!.id,
      action: "school.restored",
      entityType: "school",
      entityId: id,
    });

    return res.json({ school: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/schools/:id/admins - Add admin to school
router.post("/schools/:id/admins", ...auth, async (req, res, next) => {
  try {
    const schoolId = param(req, "id");
    const { email, firstName, lastName, displayName, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    // Resolve name: accept firstName/lastName or displayName (split on space)
    let resolvedFirst = firstName;
    let resolvedLast = lastName || "";
    if (!resolvedFirst && displayName) {
      const parts = displayName.trim().split(" ");
      resolvedFirst = parts[0];
      resolvedLast = parts.slice(1).join(" ");
    }

    const tempPassword = password || crypto.randomBytes(8).toString("hex");
    const hashed = await hashPassword(tempPassword);

    let user = await getUserByEmail(email);
    if (!user) {
      user = await createUser({
        email,
        password: hashed,
        firstName: resolvedFirst || "Admin",
        lastName: resolvedLast,
      });
    }

    await createMembership({
      userId: user.id,
      schoolId,
      role: "admin",
      status: "active",
    });

    const school = await getSchoolById(schoolId);
    if (school) {
      await sendWelcomeEmail(email, school.name, tempPassword);
    }

    return res.status(201).json({ user: { id: user.id, email: user.email }, tempPassword });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/super-admin/schools/:id/admins/:membershipId - Update admin name
router.patch("/schools/:id/admins/:membershipId", ...auth, async (req, res, next) => {
  try {
    const schoolId = param(req, "id");
    const membershipId = param(req, "membershipId");
    const { firstName, lastName, displayName } = req.body;

    // Find the membership to get the userId
    const memberships = await getMembershipsBySchool(schoolId);
    const membership = memberships.find((m) => m.id === membershipId);
    if (!membership) {
      return res.status(404).json({ error: "Admin not found" });
    }

    // Resolve name
    let resolvedFirst = firstName;
    let resolvedLast = lastName;
    if (!resolvedFirst && displayName) {
      const parts = displayName.trim().split(" ");
      resolvedFirst = parts[0];
      resolvedLast = parts.slice(1).join(" ");
    }

    const data: Record<string, unknown> = {};
    if (resolvedFirst !== undefined) data.firstName = resolvedFirst;
    if (resolvedLast !== undefined) data.lastName = resolvedLast;

    await updateUser(membership.userId, data);

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      action: "admin.updated",
      entityType: "membership",
      entityId: membershipId,
      changes: data,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/super-admin/schools/:id/admins/:membershipId - Remove admin from school
router.delete("/schools/:id/admins/:membershipId", ...auth, async (req, res, next) => {
  try {
    const schoolId = param(req, "id");
    const membershipId = param(req, "membershipId");

    const memberships = await getMembershipsBySchool(schoolId);
    const membership = memberships.find((m) => m.id === membershipId);
    if (!membership) {
      return res.status(404).json({ error: "Admin not found" });
    }

    await deleteMembership(membershipId);

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      action: "admin.removed",
      entityType: "membership",
      entityId: membershipId,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/schools/:id/impersonate - Impersonate school admin
router.post("/schools/:id/impersonate", ...auth, async (req, res, next) => {
  try {
    const schoolId = param(req, "id");
    const school = await getSchoolById(schoolId);
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }

    // Find first admin of the school
    const memberships = await getMembershipsBySchool(schoolId);
    const admin = memberships.find((m) => m.role === "admin");
    if (!admin) {
      return res.status(400).json({ error: "No admin found for this school" });
    }

    // Set session impersonation
    if (req.session) {
      (req.session as any).originalUserId = req.authUser!.id;
      (req.session as any).impersonating = true;
      (req.session as any).userId = admin.userId;
      (req.session as any).schoolId = schoolId;
      (req.session as any).role = "admin";
    }

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      action: "admin.impersonate",
      entityType: "school",
      entityId: schoolId,
      entityName: school.name,
    });

    return res.json({ ok: true, schoolId, schoolName: school.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/stop-impersonate - Stop impersonating
router.post("/stop-impersonate", ...auth, async (req, res, next) => {
  try {
    if (req.session) {
      const originalUserId = (req.session as any).originalUserId;
      if (originalUserId) {
        (req.session as any).userId = originalUserId;
        delete (req.session as any).originalUserId;
        delete (req.session as any).impersonating;
        delete (req.session as any).schoolId;
        delete (req.session as any).role;
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/schools/:id/products - Add product license
router.post("/schools/:id/products", ...auth, async (req, res, next) => {
  try {
    const schoolId = param(req, "id");
    const { product } = req.body;
    if (!product || !["CLASSPILOT", "PASSPILOT", "GOPILOT"].includes(product)) {
      return res.status(400).json({ error: "product must be CLASSPILOT, PASSPILOT, or GOPILOT" });
    }

    const existing = await getProductLicenses(schoolId);
    if (existing.some((l) => l.product === product && l.status === "active")) {
      return res.status(409).json({ error: `${product} is already active for this school` });
    }

    const license = await createProductLicense({ schoolId, product, status: "active" });

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      action: "product.added",
      entityType: "product_license",
      entityId: license.id,
      entityName: product,
    });

    return res.status(201).json({ license });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/super-admin/schools/:id/products/:product - Remove product license
router.delete("/schools/:id/products/:product", ...auth, async (req, res, next) => {
  try {
    const schoolId = param(req, "id");
    const product = param(req, "product").toUpperCase();

    const existing = await getProductLicenses(schoolId);
    const license = existing.find((l) => l.product === product);
    if (!license) {
      return res.status(404).json({ error: "Product license not found" });
    }

    await deleteProductLicense(license.id);

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      action: "product.removed",
      entityType: "product_license",
      entityId: license.id,
      entityName: product,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/super-admin/schools/:id/reset-login - Reset admin password
router.post("/schools/:id/reset-login", ...auth, async (req, res, next) => {
  try {
    const schoolId = param(req, "id");
    const memberships = await getMembershipsBySchool(schoolId);
    const admin = memberships.find((m) => m.role === "admin");
    if (!admin) {
      return res.status(400).json({ error: "No admin found" });
    }

    const tempPassword = crypto.randomBytes(8).toString("hex");
    const hashed = await hashPassword(tempPassword);

    const { updateUser } = await import("../../services/storage.js");
    await updateUser(admin.userId, { password: hashed });

    return res.json({ tempPassword, userId: admin.userId });
  } catch (err) {
    next(err);
  }
});

// GET /api/super-admin/audit-logs - Get audit logs
router.get("/audit-logs", ...auth, async (req, res, next) => {
  try {
    const { schoolId, action, entityType, limit } = req.query;
    const { getAuditLogs } = await import("../../services/audit.js");

    const logs = await getAuditLogs({
      schoolId: schoolId as string,
      action: action as string,
      entityType: entityType as string,
      limit: limit ? parseInt(limit as string) : 100,
    });

    return res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/schools/:id/billing - School billing info
router.get("/schools/:id/billing", ...auth, async (req, res, next) => {
  try {
    const { getSchoolById, getProductLicenses } = await import("../../services/storage.js");
    const school = await getSchoolById(param(req, "id"));
    if (!school) return res.status(404).json({ error: "School not found" });
    const licenses = await getProductLicenses(school.id);
    return res.json({
      school: { id: school.id, name: school.name, planTier: school.planTier, status: school.status },
      licenses,
      billing: { stripeCustomerId: school.stripeCustomerId, stripeSubscriptionId: school.stripeSubscriptionId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/admin-emails - List admin emails
router.get("/admin-emails", ...auth, async (_req, res) => {
  return res.json({ emails: [] });
});

// POST /api/admin/broadcast-email - Send broadcast email
router.post("/broadcast-email", ...auth, async (_req, res) => {
  return res.json({ ok: true, message: "Broadcast not yet implemented" });
});

export default router;
