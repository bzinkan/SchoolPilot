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
    const schools = await getAllSchools();
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

    return res.json({ schools: filtered });
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
      maxStudents,
      billingEmail,
      trialDays,
      adminEmail,
      adminFirstName,
      adminLastName,
      adminPassword,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const schoolData: Record<string, unknown> = {
      name,
      domain: domain || null,
      status: status || "active",
      billingEmail: billingEmail || null,
    };

    if (trialDays) {
      schoolData.status = "trial";
      schoolData.trialEndsAt = new Date(Date.now() + trialDays * 86400000);
    }

    const school = await createSchool(schoolData as any);

    // Create admin user if provided
    if (adminEmail) {
      const tempPassword = adminPassword || crypto.randomBytes(8).toString("hex");
      const hashed = await hashPassword(tempPassword);

      let user = await getUserByEmail(adminEmail);
      if (!user) {
        user = await createUser({
          email: adminEmail,
          password: hashed,
          firstName: adminFirstName || "Admin",
          lastName: adminLastName || "",
        });
      }

      await createMembership({
        userId: user.id,
        schoolId: school.id,
        role: "admin",
        status: "active",
      });

      await sendWelcomeEmail(adminEmail, name, tempPassword);
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

    return res.status(201).json({ school });
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

    const memberships = await getMembershipsBySchool(school.id);
    const students = await getStudentsBySchool(school.id);

    return res.json({
      school,
      admins: memberships.filter((m) => m.role === "admin"),
      staff: memberships,
      studentCount: students.length,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/super-admin/schools/:id - Update school
router.patch("/schools/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { name, domain, status, billingEmail, schoolTimezone, maxStudents, planTier, planStatus, activeUntil } = req.body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (domain !== undefined) data.domain = domain;
    if (status !== undefined) data.status = status;
    if (billingEmail !== undefined) data.billingEmail = billingEmail;
    if (schoolTimezone !== undefined) data.schoolTimezone = schoolTimezone;
    if (maxStudents !== undefined) data.maxStudents = maxStudents;
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
    const { email, firstName, lastName, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const tempPassword = password || crypto.randomBytes(8).toString("hex");
    const hashed = await hashPassword(tempPassword);

    let user = await getUserByEmail(email);
    if (!user) {
      user = await createUser({
        email,
        password: hashed,
        firstName: firstName || "Admin",
        lastName: lastName || "",
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

export default router;
