import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  getDashboardTabs,
  createDashboardTab,
  updateDashboardTab,
  deleteDashboardTab,
  getTeacherSettings,
  upsertTeacherSettings,
  getTeacherStudentAssignments,
  assignTeacherStudent,
  unassignTeacherStudent,
  getGroupsByTeacher,
  createGroup,
} from "../../services/storage.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

// ============================================================================
// Dashboard Tabs
// ============================================================================

// GET /api/classpilot/teacher/dashboard-tabs
router.get("/dashboard-tabs", ...auth, async (req, res, next) => {
  try {
    const tabs = await getDashboardTabs(req.authUser!.id);
    return res.json({ tabs });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/dashboard-tabs
router.post("/dashboard-tabs", ...auth, async (req, res, next) => {
  try {
    const { label, filterType, filterValue, order } = req.body;
    if (!label || !filterType) {
      return res.status(400).json({ error: "label and filterType required" });
    }

    const tab = await createDashboardTab({
      teacherId: req.authUser!.id,
      label,
      filterType,
      filterValue: filterValue || null,
      order: order || "0",
    });

    return res.status(201).json({ tab });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/teacher/dashboard-tabs/:id
router.patch("/dashboard-tabs/:id", ...auth, async (req, res, next) => {
  try {
    const id = param(req, "id");
    const { label, filterType, filterValue, order } = req.body;

    const data: Record<string, unknown> = {};
    if (label !== undefined) data.label = label;
    if (filterType !== undefined) data.filterType = filterType;
    if (filterValue !== undefined) data.filterValue = filterValue;
    if (order !== undefined) data.order = order;

    const updated = await updateDashboardTab(id, data);
    if (!updated) {
      return res.status(404).json({ error: "Tab not found" });
    }
    return res.json({ tab: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/teacher/dashboard-tabs/:id
router.delete("/dashboard-tabs/:id", ...auth, async (req, res, next) => {
  try {
    await deleteDashboardTab(param(req, "id"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teacher Settings
// ============================================================================

// GET /api/classpilot/teacher/settings
router.get("/settings", ...auth, async (req, res, next) => {
  try {
    const settings = await getTeacherSettings(req.authUser!.id);
    return res.json({ settings: settings || null });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/settings
router.post("/settings", ...auth, async (req, res, next) => {
  try {
    const { maxTabsPerStudent, allowedDomains, blockedDomains, defaultFlightPathId } = req.body;

    const data: Record<string, unknown> = {};
    if (maxTabsPerStudent !== undefined) data.maxTabsPerStudent = maxTabsPerStudent;
    if (allowedDomains !== undefined) data.allowedDomains = allowedDomains;
    if (blockedDomains !== undefined) data.blockedDomains = blockedDomains;
    if (defaultFlightPathId !== undefined) data.defaultFlightPathId = defaultFlightPathId;

    const settings = await upsertTeacherSettings(req.authUser!.id, data);
    return res.json({ settings });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teacher-Student Assignments
// ============================================================================

// GET /api/classpilot/teacher/students
router.get("/students", ...auth, async (req, res, next) => {
  try {
    const assignments = await getTeacherStudentAssignments(req.authUser!.id);
    return res.json({ students: assignments });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/students/:studentId/assign
router.post("/students/:studentId/assign", ...auth, async (req, res, next) => {
  try {
    await assignTeacherStudent(req.authUser!.id, param(req, "studentId"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/teacher/students/:studentId/unassign
router.delete("/students/:studentId/unassign", ...auth, async (req, res, next) => {
  try {
    await unassignTeacherStudent(req.authUser!.id, param(req, "studentId"));
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Settings sub-routes (ClassPilot frontend)
// ============================================================================

// POST /settings/hand-raising - Toggle hand-raising setting
router.post("/settings/hand-raising", ...auth, async (req, res) => {
  const { enabled } = req.body;
  return res.json({ ok: true, handRaisingEnabled: enabled !== false });
});

// POST /settings/student-messaging - Toggle student messaging setting
router.post("/settings/student-messaging", ...auth, async (req, res) => {
  const { enabled } = req.body;
  return res.json({ ok: true, studentMessagingEnabled: enabled !== false });
});

// ============================================================================
// Teacher groups (ClassPilot frontend calls /teacher/groups)
// ============================================================================

// GET /teacher/groups - Groups for the current teacher
router.get("/groups", ...auth, async (req, res, next) => {
  try {
    const groups = await getGroupsByTeacher(req.authUser!.id);
    return res.json({ groups });
  } catch (err) {
    next(err);
  }
});

// POST /teacher/groups - Create a group
router.post("/groups", ...auth, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const group = await createGroup({
      schoolId: res.locals.schoolId!,
      teacherId: req.authUser!.id,
      name,
    });
    return res.status(201).json({ group });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Raised hands (ClassPilot frontend)
// ============================================================================

// GET /teacher/raised-hands - Students with raised hands (stub)
router.get("/raised-hands", ...auth, async (_req, res) => {
  return res.json({ raisedHands: [] });
});

export default router;
