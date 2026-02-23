import crypto from "crypto";
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
  getSettingsForSchool,
  upsertSettings,
  getTeacherStudentAssignments,
  assignTeacherStudent,
  unassignTeacherStudent,
  getGroupsByTeacher,
  getGroupsBySchool,
  createGroup,
} from "../../services/storage.js";
import { broadcastToStudentsLocal } from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";

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
    const teacherSettings = await getTeacherSettings(req.authUser!.id);
    const schoolSettings = await getSettingsForSchool(res.locals.schoolId!);
    return res.json({
      ...(teacherSettings || {}),
      // School-wide settings (from settings table)
      schoolName: schoolSettings?.schoolName || "",
      retentionHours: schoolSettings?.retentionHours || "720",
      ipAllowlist: schoolSettings?.ipAllowlist || [],
      blockedDomains: schoolSettings?.blockedDomains || [],
      maxTabsPerStudent: schoolSettings?.maxTabsPerStudent || null,
      aiSafetyEmailsEnabled: schoolSettings?.aiSafetyEmailsEnabled ?? true,
      // Teacher's own blocked domains (for MySettings editable field)
      teacherBlockedDomains: (teacherSettings as any)?.blockedDomains || [],
      // School-wide blocked domains (for MySettings read-only display)
      schoolBlockedDomains: schoolSettings?.blockedDomains || [],
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/settings
router.post("/settings", ...auth, async (req, res, next) => {
  try {
    const {
      maxTabsPerStudent, allowedDomains, blockedDomains, defaultFlightPathId,
      schoolName, retentionHours, ipAllowlist, aiSafetyEmailsEnabled,
    } = req.body;

    // Teacher-specific settings
    const data: Record<string, unknown> = {};
    if (maxTabsPerStudent !== undefined) data.maxTabsPerStudent = maxTabsPerStudent;
    if (allowedDomains !== undefined) data.allowedDomains = allowedDomains;
    if (blockedDomains !== undefined) data.blockedDomains = blockedDomains;
    if (defaultFlightPathId !== undefined) data.defaultFlightPathId = defaultFlightPathId;

    const settings = await upsertTeacherSettings(req.authUser!.id, data);

    // School-wide settings — only when the admin settings page sends them.
    // The admin page sends schoolName/retentionHours/ipAllowlist/aiSafetyEmailsEnabled
    // which the teacher's MySettings page never includes.
    const isAdminSettingsRequest = schoolName !== undefined || retentionHours !== undefined
      || ipAllowlist !== undefined || aiSafetyEmailsEnabled !== undefined;

    if (isAdminSettingsRequest) {
      const schoolId = res.locals.schoolId!;
      const schoolData: Record<string, unknown> = {};
      if (schoolName !== undefined) schoolData.schoolName = schoolName;
      if (retentionHours !== undefined) schoolData.retentionHours = String(retentionHours);
      if (ipAllowlist !== undefined) schoolData.ipAllowlist = ipAllowlist;
      if (blockedDomains !== undefined) schoolData.blockedDomains = blockedDomains;
      if (allowedDomains !== undefined) schoolData.allowedDomains = allowedDomains;
      if (maxTabsPerStudent !== undefined) schoolData.maxTabsPerStudent = maxTabsPerStudent || null;
      if (aiSafetyEmailsEnabled !== undefined) schoolData.aiSafetyEmailsEnabled = aiSafetyEmailsEnabled !== false;

      if (Object.keys(schoolData).length > 0) {
        await upsertSettings(schoolId, schoolData);
      }

      // Broadcast updated global blacklist to all connected students
      if (blockedDomains !== undefined) {
        const blacklistMsg = {
          type: "update-global-blacklist",
          blockedDomains: blockedDomains || [],
        };
        broadcastToStudentsLocal(schoolId, blacklistMsg);
        void publishWS({ kind: "students", schoolId }, blacklistMsg);
      }
    }

    // If maxTabsPerStudent changed from admin settings, broadcast limit-tabs to all students
    if (isAdminSettingsRequest && maxTabsPerStudent !== undefined) {
      const sid = res.locals.schoolId!;
      const maxTabs = maxTabsPerStudent ? parseInt(String(maxTabsPerStudent), 10) : null;
      const limitMsg = {
        type: "remote-control",
        _msgId: crypto.randomUUID(),
        command: { type: "limit-tabs", data: { maxTabs: (maxTabs && maxTabs > 0) ? maxTabs : null } },
      };
      broadcastToStudentsLocal(sid, limitMsg);
      void publishWS({ kind: "students", schoolId: sid }, limitMsg);
    }

    return res.json(settings);
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
router.post("/settings/hand-raising", ...auth, async (req, res, next) => {
  try {
    const { enabled } = req.body;
    const schoolId = res.locals.schoolId!;
    const handRaisingEnabled = enabled !== false;

    await upsertTeacherSettings(req.authUser!.id, { handRaisingEnabled });

    const msg = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: { type: "hand-raising-toggle", data: { enabled: handRaisingEnabled } },
    };
    broadcastToStudentsLocal(schoolId, msg);
    await publishWS({ kind: "students", schoolId }, msg);

    return res.json({ ok: true, handRaisingEnabled, enabled: handRaisingEnabled });
  } catch (err) {
    next(err);
  }
});

// POST /settings/student-messaging - Toggle student messaging setting
router.post("/settings/student-messaging", ...auth, async (req, res, next) => {
  try {
    const { enabled } = req.body;
    const schoolId = res.locals.schoolId!;
    const studentMessagingEnabled = enabled !== false;

    await upsertTeacherSettings(req.authUser!.id, { studentMessagingEnabled });

    const msg = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: { type: "messaging-toggle", data: { enabled: studentMessagingEnabled, messagingEnabled: studentMessagingEnabled } },
    };
    broadcastToStudentsLocal(schoolId, msg);
    await publishWS({ kind: "students", schoolId }, msg);

    return res.json({ ok: true, studentMessagingEnabled, enabled: studentMessagingEnabled });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teacher groups (ClassPilot frontend calls /teacher/groups)
// ============================================================================

// GET /teacher/groups - Groups for the current teacher (admins see all school groups)
router.get("/groups", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = res.locals.membershipRole;
    let groupsList;
    if (role === "admin" || role === "school_admin" || role === "super_admin") {
      groupsList = await getGroupsBySchool(schoolId);
    } else {
      groupsList = await getGroupsByTeacher(req.authUser!.id);
    }
    return res.json({ groups: groupsList });
  } catch (err) {
    next(err);
  }
});

// POST /teacher/groups - Create a group
router.post("/groups", ...auth, async (req, res, next) => {
  try {
    const { name, teacherId, gradeLevel, periodLabel, description, groupType } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const group = await createGroup({
      schoolId: res.locals.schoolId!,
      teacherId: teacherId || req.authUser!.id,
      name,
      gradeLevel: gradeLevel || undefined,
      periodLabel: periodLabel || undefined,
      description: description || undefined,
      groupType: groupType || "teacher_created",
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
