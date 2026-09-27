import { requireScheduledClassroomContext, parseClasspilotActivityAuthority } from "../../services/classpilotActivityAuthority.js";
import { getScheduledClassroomHands } from "../../services/classpilotScheduledClassroomTools.js";
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import {
  getDashboardTabs,
  createDashboardTab,
  updateDashboardTab,
  deleteDashboardTab,
  getTeacherSettings,
  getSettingsForSchool,
  getSchoolById,
  getActiveTeachingSessionForSchool,
  getTeachingSessionByIdAndSchool,
  getActiveHandsBySession,
  getTeacherStudentAssignmentsForSchool,
  assignTeacherStudent,
  unassignTeacherStudent,
  getStudentById,
  getGroupsByTeacherAndSchool,
  getGroupsBySchool,
  upsertClasspilotGroupWithAssignments,
  getMembershipByUserAndSchool,
  getUserById,
  validateStaffEmailDomainForSchool,
  isAuthorizedClasspilotSessionStaff,
} from "../../services/storage.js";
import {
  getEffectiveFabToggles,
  updateAndFanoutSessionFabSettings,
} from "../../services/classpilotFab.js";
import {
  effectiveSharedChromebookLoginMethod,
} from "../../services/classpilotSharedChromebook.js";
import { classPilotStudentDto } from "../../util/safeStudent.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import { getSchoolWebsitePolicy } from "../../services/classpilotSchoolWebsitePolicy.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function isAdminRole(req: any, res: any): boolean {
  return requestHasAnySchoolRole(req, res, ["admin", "school_admin"]);
}

function safeSchoolSettingsResponse(
  schoolSettings: Awaited<ReturnType<typeof getSettingsForSchool>>,
  canReadSchoolAdminSettings: boolean,
  schoolTimezone: string | null | undefined
) {
  return {
    schoolName: schoolSettings?.schoolName || "",
    retentionHours: schoolSettings?.retentionHours || "720",
    ipAllowlist: schoolSettings?.ipAllowlist || [],
    blockedDomains: schoolSettings?.blockedDomains || [],
    allowedDomains: schoolSettings?.allowedDomains || [],
    gradeLevels: schoolSettings?.gradeLevels || [],
    maxTabsPerStudent: schoolSettings?.maxTabsPerStudent || null,
    aiSafetyEmailsEnabled: schoolSettings?.aiSafetyEmailsEnabled ?? true,
    pauseChatDuringTesting: schoolSettings?.pauseChatDuringTesting !== false,
    enableTrackingHours: schoolSettings?.enableTrackingHours ?? false,
    trackingStartTime: schoolSettings?.trackingStartTime ?? "08:00",
    trackingEndTime: schoolSettings?.trackingEndTime ?? "15:00",
    trackingDays: schoolSettings?.trackingDays ?? ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    schoolTimezone: schoolTimezone || "America/New_York",
    afterHoursMode: schoolSettings?.afterHoursMode ?? "off",
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
  requireClasspilotEntitlement,
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
    const [schoolSettings, school] = await Promise.all([getSettingsForSchool(schoolId), getSchoolById(schoolId)]);
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
      sessionChatPaused: fabToggles.sessionChatPaused,
      sessionMessagesPaused: fabToggles.messagesPaused,
      sessionChatPauseReason: fabToggles.pauseReason,
      activeSessionId: activeSession?.id || null,
      sessionFabRevision: fabToggles.lifecycleRevision,
      // School-wide settings (from settings table)
      ...safeSchoolSettingsResponse(schoolSettings, canReadSchoolAdminSettings, school?.schoolTimezone),
      ...(canReadSchoolAdminSettings ? await getSchoolWebsitePolicy(schoolId) : {}),
      // Teacher's own blocked domains (for MySettings editable field)
      teacherBlockedDomains: (teacherSettings as any)?.blockedDomains || [],
      // School-wide blocked domains (for MySettings read-only display)
      schoolBlockedDomains: schoolSettings?.blockedDomains || [],
    });
  } catch (err) {
    next(err);
  }
});

// Legacy aliases /settings and /teacher/settings share this route. Their mixed
// payload cannot establish which scope an operator intended to save.
router.post("/settings", ...auth, (_req, res) => res.status(409).json({
  error: "Settings have moved. Refresh the page before saving again.",
  code: "SETTINGS_REFRESH_REQUIRED",
}));

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
    if (
      !student ||
      student.schoolId !== res.locals.schoolId ||
      student.status !== "active"
    ) {
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
    const teachingSessionId = String(req.body?.teachingSessionId || "").trim();
    if (!teachingSessionId) {
      return res.status(400).json({ error: "teachingSessionId is required", code: "TEACHING_SESSION_REQUIRED" });
    }
    const session = await getTeachingSessionByIdAndSchool(teachingSessionId, schoolId);
    const authorized = session && !session.endTime
      && await isAuthorizedClasspilotSessionStaff(schoolId, session.id, req.authUser!.id);
    if (!authorized || !session) {
      return res.status(404).json({ error: "Active class session not found" });
    }
    const result = await updateAndFanoutSessionFabSettings({
      schoolId,
      teachingSessionId: session.id,
      actorId: req.authUser!.id,
      raiseHandEnabled: requestedEnabled,
      expectedRevision: Number.isInteger(req.body?.expectedRevision) ? req.body.expectedRevision : undefined,
    });
    return res.json({
      ok: true,
      sessionId: session.id,
      settings: result.settings,
      state: result.state,
      handRaisingEnabled: result.state.handRaisingEnabled,
      enabled: result.state.handRaisingEnabled,
      targetedStudentCount: result.targetedStudentCount,
    });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.current ? { current: err.current } : {}),
    });
    next(err);
  }
});

// POST /settings/student-messaging - Toggle student messaging setting
router.post("/settings/student-messaging", ...auth, async (req, res, next) => {
  try {
    const { enabled } = req.body;
    const schoolId = res.locals.schoolId!;
    const requestedEnabled = enabled !== false;
    const teachingSessionId = String(req.body?.teachingSessionId || "").trim();
    if (!teachingSessionId) {
      return res.status(400).json({ error: "teachingSessionId is required", code: "TEACHING_SESSION_REQUIRED" });
    }
    const session = await getTeachingSessionByIdAndSchool(teachingSessionId, schoolId);
    const authorized = session && !session.endTime
      && await isAuthorizedClasspilotSessionStaff(schoolId, session.id, req.authUser!.id);
    if (!authorized || !session) {
      return res.status(404).json({ error: "Active class session not found" });
    }
    const result = await updateAndFanoutSessionFabSettings({
      schoolId,
      teachingSessionId: session.id,
      actorId: req.authUser!.id,
      chatEnabled: requestedEnabled,
      expectedRevision: Number.isInteger(req.body?.expectedRevision) ? req.body.expectedRevision : undefined,
    });
    return res.json({
      ok: true,
      sessionId: session.id,
      settings: result.settings,
      state: result.state,
      studentMessagingEnabled: result.state.messagingEnabled,
      enabled: result.state.messagingEnabled,
      targetedStudentCount: result.targetedStudentCount,
    });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.current ? { current: err.current } : {}),
    });
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
    const scope = String(req.query.scope ?? "");
    let groupsList;
    if (scope === "mine") {
      groupsList = await getGroupsByTeacherAndSchool(req.authUser!.id, schoolId);
    } else if (isAdminRole(req, res)) {
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
    const { group } = await upsertClasspilotGroupWithAssignments({
      schoolId: res.locals.schoolId!,
      data: {
        name,
        gradeLevel: gradeLevel || undefined,
        periodLabel: periodLabel || undefined,
        description: description || undefined,
        groupType: groupType || "teacher_created",
        scheduleEnabled: scheduleEnabled || false,
        blockStartTime: scheduleEnabled ? blockStartTime : null,
        blockEndTime: scheduleEnabled ? blockEndTime : null,
      },
      primaryTeacherId: ownerTeacherId,
      coTeacherIds: [],
      scheduleChangeActorId: req.authUser!.id,
    });
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
    if (req.query.supervisionContextId) {
      const authority = parseClasspilotActivityAuthority(req.query);
      if (!authority?.supervisionContextId || req.query.sessionId) return res.status(400).json({ error: "Exactly one classroom authority is required" });
      const context = await requireScheduledClassroomContext({ schoolId, supervisionContextId: authority.supervisionContextId,
        actorId: req.authUser!.id, allowObserve: isAdminRole(req, res) });
      const hands = await getScheduledClassroomHands(schoolId, context.id);
      return res.json({ supervisionContextId: context.id, raisedHands: hands.map(({ hand, student }) => ({
        supervisionContextId: context.id, studentId: student.id,
        studentName: [student.firstName, student.lastName].filter(Boolean).join(" ").trim() || student.email || student.id,
        studentEmail: student.email || "", timestamp: hand.raisedAt.toISOString(), expiresAt: hand.expiresAt?.toISOString() || null,
      })) });
    }
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
