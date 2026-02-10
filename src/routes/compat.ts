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
} from "../services/storage.js";
import { createGradeSchema } from "../schema/validation.js";

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
        return { membershipId: s.id, userId: s.userId, role: s.role, user: safeUser };
      }),
    });
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

// ============================================================================
// CSV template & import (PassPilot)
// ============================================================================

router.get("/students/csv-template", ...schoolAuth, async (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=students-template.csv");
  return res.send("firstName,lastName,studentIdNumber,gradeLevel\n");
});

export default router;
