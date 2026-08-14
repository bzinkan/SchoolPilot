import crypto from "crypto";
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import { assertClasspilotRetentionHours } from "../../util/classpilotRetention.js";
import {
  getDashboardTabs,
  createDashboardTab,
  updateDashboardTab,
  deleteDashboardTab,
  getTeacherSettings,
  upsertTeacherSettings,
  getSettingsForSchool,
  upsertSettings,
  getActiveTeachingSessionForSchool,
  getTeachingSessionByIdAndSchool,
  getActiveHandsBySession,
  upsertSessionSettings,
  getTeacherStudentAssignmentsForSchool,
  assignTeacherStudent,
  unassignTeacherStudent,
  getStudentById,
  getGroupsByTeacherAndSchool,
  getGroupsBySchool,
  createGroup,
  getMembershipByUserAndSchool,
  getUserById,
  validateStaffEmailDomainForSchool,
  addGroupTeacher,
  isAuthorizedClasspilotSessionStaff,
} from "../../services/storage.js";
import { broadcastToStudentsLocal } from "../../realtime/ws-broadcast.js";
import { publishWS } from "../../realtime/ws-redis.js";
import {
  getEffectiveFabToggles,
  getSessionStudentDeviceIds,
} from "../../services/classpilotFab.js";
import {
  effectiveSharedChromebookLoginMethod,
  normalizeSharedChromebookLoginMethod,
} from "../../services/classpilotSharedChromebook.js";
import { classPilotStudentDto } from "../../util/safeStudent.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function isAdminRole(req: any, res: any): boolean {
  const role = res.locals.membershipRole;
  return req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
}

function validateClasspilotRuleList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an array`), { status: 400 });
  }
  if (value.length > 1_000) {
    throw Object.assign(new Error(`${label} cannot contain more than 1,000 entries`), {
      status: 400,
      code: "CLASSROOM_RULE_LIMIT_EXCEEDED",
    });
  }
  const normalized = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  return normalized;
}

function safeSchoolSettingsResponse(
  schoolSettings: Awaited<ReturnType<typeof getSettingsForSchool>>,
  canReadSchoolAdminSettings: boolean
) {
  return {
    schoolName: schoolSettings?.schoolName || "",
    retentionHours: schoolSettings?.retentionHours || "720",
    ipAllowlist: schoolSettings?.ipAllowlist || [],
    blockedDomains: schoolSettings?.blockedDomains || [],
    maxTabsPerStudent: schoolSettings?.maxTabsPerStudent || null,
    aiSafetyEmailsEnabled: schoolSettings?.aiSafetyEmailsEnabled ?? true,
    centralEmailRecipientUserId: canReadSchoolAdminSettings
      ? schoolSettings?.centralEmailRecipientUserId || null
      : null,
    sharedChromebookSignInEnabled: !!schoolSettings?.sharedChromebookSignInEnabled,
    sharedChromebookLoginMethod: effectiveSharedChromebookLoginMethod(schoolSettings),
    sharedChromebookPinLoginEnabled: effectiveSharedChromebookLoginMethod(schoolSettings) === "name_pin",
  };
}

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

// ============================================================================
// Dashboard Tabs
// ============================================================================

// GET /api/classpilot/teacher/dashboard-tabs
router.get("/dashboard-tabs", ...auth, async (req, res, next) => {
  try {
    const tabs = await getDashboardTabs(req.authUser!.id, res.locals.schoolId!);
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
      schoolId: res.locals.schoolId!,
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

    const updated = await updateDashboardTab(id, req.authUser!.id, res.locals.schoolId!, data);
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
    await deleteDashboardTab(param(req, "id"), req.authUser!.id, res.locals.schoolId!);
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
    const schoolId = res.locals.schoolId!;
    const schoolSettings = await getSettingsForSchool(schoolId);
    const activeSession = await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
    const fabToggles = await getEffectiveFabToggles(schoolId, activeSession?.id || null);
    const canReadSchoolAdminSettings = isAdminRole(req, res);
    return res.json({
      ...(teacherSettings || {}),
      handRaisingEnabled: fabToggles.handRaisingEnabled,
      studentMessagingEnabled: fabToggles.messagingEnabled,
      sessionHandRaisingEnabled: fabToggles.sessionHandRaisingEnabled,
      sessionStudentMessagingEnabled: fabToggles.sessionMessagingEnabled,
      schoolHandRaisingEnabled: fabToggles.schoolHandRaisingEnabled,
      schoolStudentMessagingEnabled: fabToggles.schoolMessagingEnabled,
      activeSessionId: activeSession?.id || null,
      // School-wide settings (from settings table)
      ...safeSchoolSettingsResponse(schoolSettings, canReadSchoolAdminSettings),
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
      schoolName, retentionHours, ipAllowlist, aiSafetyEmailsEnabled, autoBlockUnsafeUrls,
      centralEmailRecipientUserId,
      sharedChromebookSignInEnabled, sharedChromebookLoginMethod, sharedChromebookPinLoginEnabled,
    } = req.body;

    // Teacher-specific settings
    const data: Record<string, unknown> = {};
    if (maxTabsPerStudent !== undefined) data.maxTabsPerStudent = maxTabsPerStudent;
    if (allowedDomains !== undefined) data.allowedDomains = validateClasspilotRuleList(allowedDomains, "Allowed domains");
    if (blockedDomains !== undefined) data.blockedDomains = validateClasspilotRuleList(blockedDomains, "Blocked domains");
    if (defaultFlightPathId !== undefined) data.defaultFlightPathId = defaultFlightPathId;

    // School-wide settings — only when the admin settings page sends them.
    // The admin page sends schoolName/retentionHours/ipAllowlist/aiSafetyEmailsEnabled
    // which the teacher's MySettings page never includes.
    const isAdminSettingsRequest = schoolName !== undefined || retentionHours !== undefined
      || ipAllowlist !== undefined || aiSafetyEmailsEnabled !== undefined || autoBlockUnsafeUrls !== undefined
      || centralEmailRecipientUserId !== undefined
      || sharedChromebookSignInEnabled !== undefined || sharedChromebookLoginMethod !== undefined
      || sharedChromebookPinLoginEnabled !== undefined;

    let normalizedCentralEmailRecipientUserId: string | null | undefined;
    if (isAdminSettingsRequest) {
      const role = res.locals.membershipRole;
      if (!req.authUser?.isSuperAdmin && role !== "admin" && role !== "school_admin") {
        return res.status(403).json({ error: "Admin access required to update school settings" });
      }

      if (centralEmailRecipientUserId !== undefined) {
        if (centralEmailRecipientUserId === null) {
          normalizedCentralEmailRecipientUserId = null;
        } else {
          if (typeof centralEmailRecipientUserId !== "string") {
            return res.status(400).json({ error: "Central email recipient must be a staff user ID or an explicit clear value" });
          }
          const rawRecipientId = centralEmailRecipientUserId.trim();
          if (!rawRecipientId) {
            return res.status(400).json({ error: "Central email recipient cannot be blank; use null to clear it" });
          }
          if (rawRecipientId === "none" || rawRecipientId === "__none__") {
            normalizedCentralEmailRecipientUserId = null;
          } else {
            const schoolId = res.locals.schoolId!;
            const membership = await getMembershipByUserAndSchool(rawRecipientId, schoolId);
            const allowedRoles = new Set(["admin", "school_admin", "teacher", "office_staff"]);
            if (!membership || !allowedRoles.has(membership.role)) {
              return res.status(400).json({ error: "Central email recipient must be active staff at this school" });
            }
            const user = await getUserById(rawRecipientId);
            if (!user?.email?.trim()) {
              return res.status(400).json({ error: "Central email recipient must have an email address" });
            }
            normalizedCentralEmailRecipientUserId = rawRecipientId;
          }
        }
      }
    }

    const settings = await upsertTeacherSettings(req.authUser!.id, data);

    let savedSchoolSettings: Awaited<ReturnType<typeof getSettingsForSchool>> = undefined;
    if (isAdminSettingsRequest) {
      const schoolId = res.locals.schoolId!;
      const schoolData: Record<string, unknown> = {};
      if (schoolName !== undefined) schoolData.schoolName = schoolName;
      if (retentionHours !== undefined) {
        schoolData.retentionHours = String(assertClasspilotRetentionHours(retentionHours));
      }
      if (ipAllowlist !== undefined) schoolData.ipAllowlist = ipAllowlist;
      if (blockedDomains !== undefined) schoolData.blockedDomains = validateClasspilotRuleList(blockedDomains, "Blocked domains");
      if (allowedDomains !== undefined) schoolData.allowedDomains = validateClasspilotRuleList(allowedDomains, "Allowed domains");
      if (maxTabsPerStudent !== undefined) schoolData.maxTabsPerStudent = maxTabsPerStudent || null;
      if (aiSafetyEmailsEnabled !== undefined) schoolData.aiSafetyEmailsEnabled = aiSafetyEmailsEnabled !== false;
      if (autoBlockUnsafeUrls !== undefined) schoolData.autoBlockUnsafeUrls = autoBlockUnsafeUrls !== false;
      if (normalizedCentralEmailRecipientUserId !== undefined) {
        schoolData.centralEmailRecipientUserId = normalizedCentralEmailRecipientUserId;
      }
      if (sharedChromebookSignInEnabled !== undefined) {
        schoolData.sharedChromebookSignInEnabled = sharedChromebookSignInEnabled === true;
        if (sharedChromebookSignInEnabled === true && sharedChromebookLoginMethod === undefined && sharedChromebookPinLoginEnabled === undefined) {
          schoolData.sharedChromebookLoginMethod = "name_pin";
          schoolData.sharedChromebookPinLoginEnabled = true;
        }
      }
      if (sharedChromebookLoginMethod !== undefined || sharedChromebookPinLoginEnabled !== undefined) {
        const method = normalizeSharedChromebookLoginMethod(
          sharedChromebookLoginMethod,
          sharedChromebookPinLoginEnabled === false ? "email_id" : "name_pin"
        );
        schoolData.sharedChromebookLoginMethod = method;
        schoolData.sharedChromebookPinLoginEnabled = method === "name_pin";
      }

      if (Object.keys(schoolData).length > 0) {
        savedSchoolSettings = await upsertSettings(schoolId, schoolData);
      } else {
        savedSchoolSettings = await getSettingsForSchool(schoolId);
      }

      // Broadcast updated global blacklist to all connected students
      if (blockedDomains !== undefined) {
        const blacklistMsg = {
          type: "update-global-blacklist",
          blockedDomains: savedSchoolSettings?.blockedDomains || [],
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

    if (!isAdminSettingsRequest) {
      return res.json(settings);
    }

    if (savedSchoolSettings === undefined) {
      savedSchoolSettings = await getSettingsForSchool(res.locals.schoolId!);
    }

    return res.json({
      ...(settings || {}),
      ...safeSchoolSettingsResponse(savedSchoolSettings, isAdminRole(req, res)),
    });
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
    const assignments = await getTeacherStudentAssignmentsForSchool(req.authUser!.id, res.locals.schoolId!);
    return res.json({
      students: assignments.map((assignment) => ({
        ...assignment,
        student: classPilotStudentDto(assignment.student),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/teacher/students/:studentId/assign
router.post("/students/:studentId/assign", ...auth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    await assignTeacherStudent(req.authUser!.id, studentId);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/teacher/students/:studentId/unassign
router.delete("/students/:studentId/unassign", ...auth, async (req, res, next) => {
  try {
    const studentId = param(req, "studentId");
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Student not found" });
    }
    await unassignTeacherStudent(req.authUser!.id, studentId);
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
    const requestedEnabled = enabled !== false;
    const session = await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
    if (!session) {
      return res.status(409).json({ error: "No active teaching session" });
    }

    const settings = await upsertSessionSettings(session.id, { raiseHandEnabled: requestedEnabled });
    const toggles = await getEffectiveFabToggles(schoolId, session.id);
    const targetDeviceIds = await getSessionStudentDeviceIds(session);

    const msg = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: {
        type: "hand-raising-toggle",
        data: {
          sessionId: session.id,
          enabled: toggles.handRaisingEnabled,
          handRaisingEnabled: toggles.handRaisingEnabled,
        },
      },
    };
    if (targetDeviceIds.length > 0) {
      broadcastToStudentsLocal(schoolId, msg, undefined, targetDeviceIds);
      await publishWS({ kind: "students", schoolId, targetDeviceIds }, msg);
    }

    return res.json({
      ok: true,
      sessionId: session.id,
      settings,
      handRaisingEnabled: toggles.handRaisingEnabled,
      enabled: toggles.handRaisingEnabled,
    });
  } catch (err) {
    next(err);
  }
});

// POST /settings/student-messaging - Toggle student messaging setting
router.post("/settings/student-messaging", ...auth, async (req, res, next) => {
  try {
    const { enabled } = req.body;
    const schoolId = res.locals.schoolId!;
    const requestedEnabled = enabled !== false;
    const session = await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
    if (!session) {
      return res.status(409).json({ error: "No active teaching session" });
    }

    const settings = await upsertSessionSettings(session.id, { chatEnabled: requestedEnabled });
    const toggles = await getEffectiveFabToggles(schoolId, session.id);
    const targetDeviceIds = await getSessionStudentDeviceIds(session);

    const msg = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: {
        type: "messaging-toggle",
        data: {
          sessionId: session.id,
          enabled: toggles.messagingEnabled,
          messagingEnabled: toggles.messagingEnabled,
        },
      },
    };
    if (targetDeviceIds.length > 0) {
      broadcastToStudentsLocal(schoolId, msg, undefined, targetDeviceIds);
      await publishWS({ kind: "students", schoolId, targetDeviceIds }, msg);
    }

    return res.json({
      ok: true,
      sessionId: session.id,
      settings,
      studentMessagingEnabled: toggles.messagingEnabled,
      enabled: toggles.messagingEnabled,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teacher groups (ClassPilot frontend calls /teacher/groups)
// ============================================================================

// GET /teacher/groups - Groups for the current teacher (admins see all school groups unless scope=mine)
router.get("/groups", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const role = res.locals.membershipRole;
    const scope = String(req.query.scope ?? "");
    let groupsList;
    if (scope === "mine") {
      groupsList = await getGroupsByTeacherAndSchool(req.authUser!.id, schoolId);
    } else if (role === "admin" || role === "school_admin" || role === "super_admin") {
      groupsList = await getGroupsBySchool(schoolId);
    } else {
      groupsList = await getGroupsByTeacherAndSchool(req.authUser!.id, schoolId);
    }
    return res.json({ groups: groupsList });
  } catch (err) {
    next(err);
  }
});

// POST /teacher/groups - Create a group
router.post("/groups", ...auth, async (req, res, next) => {
  try {
    const { name, teacherId, gradeLevel, periodLabel, description, groupType,
            scheduleEnabled, blockStartTime, blockEndTime } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    if (groupType === "admin_class") {
      return res.status(403).json({
        error: "Official classes must be created through the admin class management API.",
      });
    }
    if (scheduleEnabled) {
      if (!blockStartTime || !blockEndTime) {
        return res.status(400).json({ error: "blockStartTime and blockEndTime are required when scheduling is enabled" });
      }
      if (!/^\d{2}:\d{2}$/.test(String(blockStartTime)) || !/^\d{2}:\d{2}$/.test(String(blockEndTime))) {
        return res.status(400).json({ error: "Schedule times must be HH:MM" });
      }
      if (String(blockStartTime) >= String(blockEndTime)) {
        return res.status(400).json({ error: "blockStartTime must be before blockEndTime" });
      }
    }
    const ownerTeacherId = teacherId || req.authUser!.id;
    if (ownerTeacherId !== req.authUser!.id) {
      if (!isAdminRole(req, res)) {
        return res.status(403).json({ error: "Only admins can assign a group to another teacher" });
      }
    }
    const ownerMembership = await getMembershipByUserAndSchool(ownerTeacherId, res.locals.schoolId!);
    const ownerUser = await getUserById(ownerTeacherId);
    if (!ownerMembership || !ownerUser) {
      return res.status(404).json({ error: "Teacher not found in this school" });
    }
    const domainValidation = await validateStaffEmailDomainForSchool(ownerUser.email, res.locals.schoolId!);
    if (!domainValidation.ok) {
      return res.status(400).json({
        error: domainValidation.message,
        code: domainValidation.code,
        expectedDomain: domainValidation.expectedDomain,
        actualDomain: domainValidation.actualDomain,
      });
    }
    const group = await createGroup({
      schoolId: res.locals.schoolId!,
      teacherId: ownerTeacherId,
      name,
      gradeLevel: gradeLevel || undefined,
      periodLabel: periodLabel || undefined,
      description: description || undefined,
      groupType: groupType || "teacher_created",
      scheduleEnabled: scheduleEnabled || false,
      blockStartTime: scheduleEnabled ? blockStartTime : undefined,
      blockEndTime: scheduleEnabled ? blockEndTime : undefined,
    });
    await addGroupTeacher(group.id, ownerTeacherId, "primary");
    return res.status(201).json({ group });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Raised hands (ClassPilot frontend)
// ============================================================================

// GET /teacher/raised-hands - Active raised hands for a teaching session
router.get("/raised-hands", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const requestedSessionId = String(req.query.sessionId || "").trim();
    const session = requestedSessionId
      ? await getTeachingSessionByIdAndSchool(requestedSessionId, schoolId)
      : await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
    if (!session) {
      return res.status(requestedSessionId ? 404 : 409).json({ error: "Session not found" });
    }
    if (!isAdminRole(req, res) && !(await isAuthorizedClasspilotSessionStaff(
      schoolId,
      session.id,
      req.authUser!.id
    ))) {
      return res.status(404).json({ error: "Session not found" });
    }

    const hands = await getActiveHandsBySession(schoolId, session.id);
    return res.json({
      sessionId: session.id,
      raisedHands: hands.map((hand) => ({
        sessionId: session.id,
        studentId: hand.studentId,
        studentName: [hand.student.firstName, hand.student.lastName].filter(Boolean).join(" ").trim() || hand.student.email || hand.studentId,
        studentEmail: hand.student.email || "",
        timestamp: hand.raisedAt.toISOString(),
        expiresAt: hand.expiresAt?.toISOString() || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
