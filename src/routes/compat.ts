import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { requireRole } from "../middleware/requireRole.js";
import {
  getGradesBySchool,
  createGrade,
  getTeacherGrades,
  assignTeacherGrade,
  getUsersBySchool,
  getStaffBySchool,
  getStudentsBySchool,
  getSchoolById,
  updateSchool,
  getPendingParentRequests,
  updateParentStudentLink,
  getParentStudentLinkById,
  getApprovedChildrenForParent,
  getUserByEmail,
  createUser,
  createMembership,
  getMembershipByUserAndSchool,
  deleteMembership,
  updateMembership,
  updateUser,
} from "../services/storage.js";
import { createGradeSchema } from "../schema/validation.js";
import { hashPassword } from "../util/password.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [authenticate] as const;
const schoolAuth = [authenticate, requireSchoolContext, requireActiveSchool] as const;

// ============================================================================
// Grades without school prefix (PassPilot calls GET /grades, POST /grades)
// ============================================================================

router.get("/grades", ...schoolAuth, async (req, res, next) => {
  try {
    const grades = await getGradesBySchool(res.locals.schoolId!);
    return res.json({ grades });
  } catch (err) {
    next(err);
  }
});

router.get("/grades/available", ...schoolAuth, async (req, res, next) => {
  try {
    const grades = await getGradesBySchool(res.locals.schoolId!);
    return res.json({ grades });
  } catch (err) {
    next(err);
  }
});

router.post("/grades", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const parsed = createGradeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }
    const grade = await createGrade({ schoolId: res.locals.schoolId!, ...parsed.data });
    return res.status(201).json({ grade });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teacher-grades without school prefix (PassPilot)
// ============================================================================

router.get("/teacher-grades/:teacherId", ...schoolAuth, async (req, res, next) => {
  try {
    const assignments = await getTeacherGrades(param(req, "teacherId"));
    return res.json({
      assignments: assignments.map((a) => ({
        id: a.teacherGrade.id,
        gradeId: a.teacherGrade.gradeId,
        gradeName: a.grade.name,
        assignedAt: a.teacherGrade.assignedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/teacher-grades", ...schoolAuth, async (req, res, next) => {
  try {
    const { teacherId, gradeId } = req.body;
    if (!teacherId || !gradeId) {
      return res.status(400).json({ error: "teacherId and gradeId required" });
    }
    const assignment = await assignTeacherGrade(teacherId, gradeId);
    return res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

router.post("/teacher-grades/self-assign", ...schoolAuth, async (req, res, next) => {
  try {
    const { gradeId } = req.body;
    if (!gradeId) {
      return res.status(400).json({ error: "gradeId required" });
    }
    const assignment = await assignTeacherGrade(req.authUser!.id, gradeId);
    return res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teachers list without prefix (PassPilot calls GET /teachers)
// ============================================================================

router.get("/teachers", ...schoolAuth, async (req, res, next) => {
  try {
    const teachers = await getUsersBySchool(res.locals.schoolId!, "teacher");
    return res.json({
      teachers: teachers.map((t) => {
        const { password: _, ...safeUser } = t.user;
        return { membershipId: t.id, userId: t.userId, role: t.role, user: safeUser };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Admin teacher/user management (PassPilot & ClassPilot call /admin/teachers)
// ============================================================================

router.get("/admin/teachers", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const teachers = await getUsersBySchool(res.locals.schoolId!, "teacher");
    return res.json({
      teachers: teachers.map((t) => {
        const { password: _, ...safeUser } = t.user;
        return { membershipId: t.id, userId: t.userId, role: t.role, user: safeUser };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/teachers", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    // Forward to user/staff creation - accept same body format
    return res.status(400).json({ error: "Use POST /users/staff to create staff members" });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/users", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const staff = await getStaffBySchool(res.locals.schoolId!);
    return res.json({
      users: staff.map((s) => {
        const { password: _, ...safeUser } = s.user;
        // Map DB role "admin" → "school_admin" for the frontend display
        const displayRole = s.role === "admin" ? "school_admin" : s.role;
        return { membershipId: s.id, userId: s.userId, role: displayRole, user: safeUser };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users - Create staff member (ClassPilot Admin panel)
router.post("/admin/users", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { email, role, name, password } = req.body;
    if (!email) {
      return res.status(400).json({ error: "email is required" });
    }

    const staffRole = role === "school_admin" ? "admin" : role || "teacher";
    if (!["admin", "teacher", "office_staff"].includes(staffRole)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    let user = await getUserByEmail(email.toLowerCase());

    if (!user) {
      const hashedPw = password ? await hashPassword(password) : null;
      const nameParts = (name || email.split("@")[0]).split(/\s+/);
      user = await createUser({
        email: email.toLowerCase(),
        password: hashedPw,
        firstName: nameParts[0] || "",
        lastName: nameParts.slice(1).join(" ") || "",
        displayName: name || email.split("@")[0],
      });
    }

    const existing = await getMembershipByUserAndSchool(user.id, res.locals.schoolId!);
    if (existing) {
      return res.status(409).json({ error: "User already has a membership in this school" });
    }

    const membership = await createMembership({
      userId: user.id,
      schoolId: res.locals.schoolId!,
      role: staffRole,
    });

    const { password: _, ...safeUser } = user;
    return res.status(201).json({ user: safeUser, membership });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/users/:id - Update staff member (ClassPilot Admin panel)
router.patch("/admin/users/:id", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { role, name } = req.body;

    const data: Record<string, unknown> = {};
    if (role) {
      data.role = role === "school_admin" ? "admin" : role;
    }

    const membership = await updateMembership(id, data);
    if (!membership) {
      return res.status(404).json({ error: "Membership not found" });
    }

    if (name && membership.userId) {
      const nameParts = name.split(/\s+/);
      await updateUser(membership.userId, {
        firstName: nameParts[0] || "",
        lastName: nameParts.slice(1).join(" ") || "",
        displayName: name,
      });
    }

    return res.json({ membership });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id/password - Reset staff password (ClassPilot Admin panel)
// :id is the membership ID; look up the userId from it
router.post("/admin/users/:id/password", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: "newPassword is required" });
    }
    const staff = await getStaffBySchool(res.locals.schoolId!);
    const member = staff.find((s) => s.id === param(req, "id"));
    if (!member) {
      return res.status(404).json({ error: "Staff member not found" });
    }
    const hashed = await hashPassword(newPassword);
    const updated = await updateUser(member.userId, { password: hashed });
    if (!updated) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/users/:id - Delete staff member (ClassPilot Admin panel)
router.delete("/admin/users/:id", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const deleted = await deleteMembership(param(req, "id"));
    if (!deleted) {
      return res.status(404).json({ error: "Membership not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/teacher-students", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const students = await getStudentsBySchool(res.locals.schoolId!);
    return res.json({ students });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/analytics/summary", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.json({ summary: { totalStudents: 0, totalTeachers: 0, totalSessions: 0 } });
});

router.post("/admin/bulk-import", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.status(400).json({ error: "Use POST /students/import-csv for bulk import" });
});

router.post("/admin/students/bulk-delete", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.status(400).json({ error: "Bulk delete not yet implemented" });
});

router.get("/admin/admin-emails", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.json({ emails: [] });
});

router.post("/admin/broadcast-email", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.json({ ok: true, message: "Broadcast not yet implemented" });
});

// ============================================================================
// Admin reports & settings (PassPilot)
// ============================================================================

router.get("/admin/reports", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.json({ reports: [] });
});

router.patch("/admin/settings", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const school = await updateSchool(res.locals.schoolId!, req.body);
    return res.json({ school });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Kiosk config (PassPilot calls PUT /kiosk-config)
// ============================================================================

router.put("/kiosk-config", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const school = await updateSchool(res.locals.schoolId!, {
      kioskEnabled: req.body.kioskEnabled,
    });
    return res.json({ school });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// My classes (PassPilot teacher dashboard)
// ============================================================================

router.get("/my-classes", ...schoolAuth, async (req, res, next) => {
  try {
    const assignments = await getTeacherGrades(req.authUser!.id);
    return res.json({
      classes: assignments.map((a) => ({
        id: a.teacherGrade.id,
        gradeId: a.teacherGrade.gradeId,
        name: a.grade.name,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Students aggregated (ClassPilot)
// ============================================================================

router.get("/students-aggregated", ...schoolAuth, async (req, res, next) => {
  try {
    const students = await getStudentsBySchool(res.locals.schoolId!);
    return res.json({ students });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Export (ClassPilot)
// ============================================================================

router.get("/export/activity", ...schoolAuth, async (_req, res) => {
  return res.json({ activities: [] });
});

// ============================================================================
// GoPilot parent features
// ============================================================================

// GET /me/children (rewritten from /me/children → /users/me/children)
// This route is mounted at "/" so it handles /users/me/children

// POST /auth/register/parent
router.post("/auth/register/parent", async (_req, res) => {
  return res.status(400).json({ error: "Use POST /auth/register with parentMode flag" });
});

// ============================================================================
// GoPilot school-scoped: settings, invite, parent-requests
// (These are called via URL rewrite from /schools/:id/settings → /compat/school-settings)
// ============================================================================

router.get("/compat/school-settings", ...schoolAuth, async (req, res, next) => {
  try {
    const school = await getSchoolById(res.locals.schoolId!);
    if (!school) return res.status(404).json({ error: "School not found" });
    return res.json({ settings: school });
  } catch (err) {
    next(err);
  }
});

router.put("/compat/school-settings", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const school = await updateSchool(res.locals.schoolId!, req.body);
    if (!school) return res.status(404).json({ error: "School not found" });
    return res.json({ settings: school });
  } catch (err) {
    next(err);
  }
});

router.post("/compat/invite", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.json({ inviteCode: "invite-" + Date.now(), message: "Invite feature stub" });
});

router.get("/compat/parent-requests", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const requests = await getPendingParentRequests(res.locals.schoolId!);
    return res.json({ requests });
  } catch (err) {
    next(err);
  }
});

router.put("/compat/parent-requests/:id", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }
    const link = await getParentStudentLinkById(param(req, "id"));
    if (!link) return res.status(404).json({ error: "Request not found" });
    const updated = await updateParentStudentLink(param(req, "id"), { status });
    return res.json({ request: updated });
  } catch (err) {
    next(err);
  }
});

// GET /compat/parents - List parents for a school with their linked children
router.get("/compat/parents", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const parentMemberships = await getUsersBySchool(res.locals.schoolId!, "parent");
    const parents = await Promise.all(
      parentMemberships.map(async (m) => {
        const children = await getApprovedChildrenForParent(m.userId, res.locals.schoolId!);
        const { password: _, ...safeUser } = m.user;
        return {
          membershipId: m.id,
          userId: m.userId,
          role: m.role,
          carNumber: m.carNumber,
          user: safeUser,
          children: children.map((c) => ({
            id: c.student.id,
            firstName: c.student.firstName,
            lastName: c.student.lastName,
            gradeLevel: c.student.gradeLevel,
            relationship: c.link.relationship,
          })),
        };
      })
    );
    return res.json(parents);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// CSV template & import (PassPilot)
// ============================================================================

router.get("/students/csv-template", ...schoolAuth, async (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=students-template.csv");
  return res.send("firstName,lastName,studentIdNumber,gradeLevel\n");
});

export default router;
