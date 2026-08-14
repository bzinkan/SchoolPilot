import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { requireRole } from "../middleware/requireRole.js";
import { requireProductLicense } from "../middleware/requireProductLicense.js";
import { sanitizeSchool } from "../util/sanitizeSchool.js";
import { classPilotStudentDto } from "../util/safeStudent.js";
import { decryptClassPilotPin } from "../services/classpilotPins.js";
import {
  getGradesBySchool,
  createGrade,
  updateGrade,
  deleteGrade,
  assignTeacherGrade,
  removeTeacherGrade,
  getUsersBySchool,
  getStaffBySchool,
  getStudentsBySchool,
  getStudentById,
  deleteStudent,
  updateStudent,
  getSchoolById,
  updateSchool,
  updateCanonicalKioskClass,
  updateLegacyKioskClass,
  getUserByEmail,
  createUser,
  createMembership,
  getMembershipByUserAndSchool,
  deleteMembershipForSchool,
  updateMembership,
  updateMembershipForSchool,
  updateUser,
  getActiveTeachingSessionForSchool,
  getTeachingSessionByIdAndSchool,
  isAuthorizedClasspilotSessionStaff,
  getClasspilotSessionStudentRoster,
  getClasspilotStudentControlStates,
  getGroupStudents,
  getGroupByIdAndSchool,
  getUserById,
  validateStaffEmailDomainForSchool,
} from "../services/storage.js";
import db from "../db.js";
import { heartbeats, devices as deviceTable, groups, dailyUsage } from "../schema/classpilot.js";
import { eq, and, sql } from "drizzle-orm";
import { createGradeSchema } from "../schema/validation.js";
import { hashPassword } from "../util/password.js";
import { logAudit, getAuditLogs, countAuditLogs } from "../services/audit.js";
import {
  canAccessGrade,
  canAccessPasspilotClass,
  getCanonicalClassForSchool,
  getPasspilotClassSourceForSchool,
  getGradeForSchool,
  getRequestPassPilotRole,
  getTeacherGradeAssignments,
  hasPasspilotCanonicalClassCapability,
  isPassPilotManager,
  requireLegacyPasspilotClassSource,
  requirePassPilotRole,
  userBelongsToSchool,
} from "../services/passpilotAccess.js";
import {
  getClasspilotAdminAnalyticsByGroup,
  getClasspilotAdminAnalyticsByTeacher,
  getClasspilotAdminAnalyticsSummary,
} from "../services/classpilotAdminAnalytics.js";
import {
  getClasspilotDashboardSchoolTimezone,
  getClasspilotDashboardSnapshot,
} from "../services/classpilotDashboardSnapshot.js";
import { requireGoPilotRole } from "../services/gopilotAccess.js";
import {
  getGoPilotSettings,
} from "../services/gopilotSettings.js";
import { sendGoPilotParentPortalDisabled } from "../util/gopilotParentContainment.js";
import { rejectDisabledGoPilotParent } from "../middleware/rejectDisabledGoPilotParent.js";
import { readHeartbeatTileCacheBatch } from "../services/heartbeatTileCache.js";
import {
  CLASSPILOT_REALTIME_EXPIRED_AFTER_MS,
  CLASSPILOT_REALTIME_SCHEMA_VERSION,
  CLASSPILOT_REALTIME_STALE_AFTER_MS,
  classpilotPublicRealtimeBinding,
  readClasspilotRealtimeStatusBatch,
  readLocalClasspilotRealtimeStatusBatch,
  type ClasspilotRealtimeBinding,
  type ClasspilotRealtimeStatus,
} from "../services/classpilotRealtimeStatus.js";
import {
  effectiveClasspilotControlEnforcementHealth,
  serializeClasspilotStudentControlState,
} from "../services/classpilotClassroomState.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

const auth = [authenticate] as const;
const schoolAuth = [authenticate, requireSchoolContext, requireActiveSchool] as const;
const classPilotStaffAuth = [
  ...schoolAuth,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;
const passPilotAuth = [
  ...schoolAuth,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"),
] as const;
const legacyPassPilotClassAuth = [
  ...passPilotAuth,
  requireLegacyPasspilotClassSource,
] as const;
const goPilotStaffAuth = [
  ...schoolAuth,
  rejectDisabledGoPilotParent,
  requireProductLicense("GOPILOT"),
  requireGoPilotRole("admin", "school_admin", "office_staff", "teacher"),
] as const;
const goPilotAdminAuth = [
  ...schoolAuth,
  rejectDisabledGoPilotParent,
  requireProductLicense("GOPILOT"),
  requireGoPilotRole("admin", "school_admin"),
] as const;

function todayInTimeZone(timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

type AuthorizedRealtimeBinding = ClasspilotRealtimeBinding & {
  sessionStartedAt: Date | null;
};

function realtimeStatusFromHeartbeat(
  schoolId: string,
  binding: AuthorizedRealtimeBinding,
  heartbeat: any
): ClasspilotRealtimeStatus | null {
  const observedAt = new Date(heartbeat?.timestamp ?? 0).getTime();
  const sessionStartedAt = binding.sessionStartedAt?.getTime() ?? 0;
  if (
    heartbeat?.schoolId !== schoolId ||
    heartbeat?.studentId !== binding.studentId ||
    heartbeat?.deviceId !== binding.deviceId ||
    !Number.isFinite(observedAt) ||
    observedAt < sessionStartedAt ||
    Date.now() - observedAt >= CLASSPILOT_REALTIME_EXPIRED_AFTER_MS
  ) {
    return null;
  }
  const snapshot: ClasspilotRealtimeStatus = {
    schemaVersion: CLASSPILOT_REALTIME_SCHEMA_VERSION,
    state: "active",
    schoolId,
    studentId: binding.studentId,
    studentSessionId: binding.studentSessionId,
    deviceId: binding.deviceId,
    revision: 0,
    heartbeatId: heartbeat.id || null,
    observedAt,
    activeTabUrl: heartbeat.activeTabUrl || "",
    activeTabTitle: heartbeat.activeTabTitle || "",
    allOpenTabs: [],
    openTabCount: 0,
    tabsTruncated: false,
    activityState: "unknown",
    classroomControls: {
      screenLocked: heartbeat.screenLocked === true,
      flightPathActive: heartbeat.flightPathActive === true,
      isSharing: heartbeat.isSharing === true,
      cameraActive: heartbeat.cameraActive === true,
    },
    classificationPending: false,
  };
  if (heartbeat.favicon) snapshot.favicon = heartbeat.favicon;
  if (heartbeat.activeFlightPathName) {
    snapshot.classroomControls.activeFlightPathName = heartbeat.activeFlightPathName;
  }
  if (heartbeat.aiCategory || heartbeat.safetyAlert) {
    snapshot.aiClassification = {
      category: heartbeat.aiCategory || "unknown",
      safetyAlert: heartbeat.safetyAlert || null,
    };
  }
  if (heartbeat.screenshotHealth) snapshot.screenshotHealth = heartbeat.screenshotHealth;
  if (heartbeat.extensionVersion) snapshot.extensionVersion = heartbeat.extensionVersion;
  if (heartbeat.chromeVersion) snapshot.chromeVersion = heartbeat.chromeVersion;
  return snapshot;
}

async function loadAuthorizedRealtimeStatuses(
  schoolId: string,
  bindings: AuthorizedRealtimeBinding[]
): Promise<Map<string, ClasspilotRealtimeStatus>> {
  const selected = new Map<string, ClasspilotRealtimeStatus>();
  if (bindings.length === 0) return selected;

  const sharedLatest = await readClasspilotRealtimeStatusBatch(schoolId, bindings);
  const fallbackBindings: AuthorizedRealtimeBinding[] = [];
  for (const binding of bindings) {
    const result = sharedLatest.get(binding.studentId);
    if (result?.status === "hit") selected.set(binding.studentId, result.snapshot);
    else fallbackBindings.push(binding);
  }
  if (fallbackBindings.length === 0) return selected;

  // Shared heartbeat history is the first degraded-mode source. It carries
  // school/student/device bindings and is additionally constrained to the
  // currently authorized student-session window here.
  const sharedHistory = await readHeartbeatTileCacheBatch(
    schoolId,
    fallbackBindings,
    1
  );
  const localCandidates = readLocalClasspilotRealtimeStatusBatch(
    schoolId,
    fallbackBindings
  );
  for (const binding of fallbackBindings) {
    const history = sharedHistory.get(binding.studentId);
    if (history?.status === "hit") {
      const candidate = realtimeStatusFromHeartbeat(
        schoolId,
        binding,
        history.heartbeats[0]
      );
      if (candidate) {
        selected.set(binding.studentId, candidate);
        continue;
      }
    }
    const local = localCandidates.get(binding.studentId);
    if (local?.status === "hit") selected.set(binding.studentId, local.snapshot);
  }
  return selected;
}

// ============================================================================
// Grades without school prefix (PassPilot calls GET /grades, POST /grades)
// ============================================================================

router.get("/grades", ...legacyPassPilotClassAuth, async (req, res, next) => {
  try {
    const grades = (await getGradesBySchool(res.locals.schoolId!)).filter((grade) => grade.migrationState !== "history_only");
    return res.json({ grades });
  } catch (err) {
    next(err);
  }
});

router.get("/grades/available", ...legacyPassPilotClassAuth, async (req, res, next) => {
  try {
    const grades = (await getGradesBySchool(res.locals.schoolId!)).filter((grade) => grade.migrationState !== "history_only");
    return res.json({ grades });
  } catch (err) {
    next(err);
  }
});

router.post("/grades", ...legacyPassPilotClassAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
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

router.put("/grades/:id", ...legacyPassPilotClassAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
  try {
    const existing = await getGradeForSchool(param(req, "id"), res.locals.schoolId!);
    if (!existing) return res.status(404).json({ error: "Grade not found" });
    const grade = await updateGrade(param(req, "id"), req.body);
    if (!grade) return res.status(404).json({ error: "Grade not found" });
    return res.json({ grade });
  } catch (err) {
    next(err);
  }
});

router.delete("/grades/:id", ...legacyPassPilotClassAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
  try {
    const existing = await getGradeForSchool(param(req, "id"), res.locals.schoolId!);
    if (!existing) return res.status(404).json({ error: "Grade not found" });
    const deleted = await deleteGrade(param(req, "id"));
    if (!deleted) return res.status(404).json({ error: "Grade not found" });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Teacher-grades without school prefix (PassPilot)
// ============================================================================

router.get("/teacher-grades/:teacherId", ...legacyPassPilotClassAuth, async (req, res, next) => {
  try {
    const teacherId = param(req, "teacherId");
    const role = await getRequestPassPilotRole(req, res);
    if (!isPassPilotManager(role) && teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (!(await userBelongsToSchool(teacherId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Teacher not found" });
    }
    const assignments = (await getTeacherGradeAssignments(teacherId, res.locals.schoolId!))
      .filter((assignment) => assignment.grade.migrationState !== "history_only");
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

router.post("/teacher-grades", ...legacyPassPilotClassAuth, async (req, res, next) => {
  try {
    const { teacherId, gradeId } = req.body;
    if (!teacherId || !gradeId) {
      return res.status(400).json({ error: "teacherId and gradeId required" });
    }
    // Only admins can assign other teachers; teachers can only self-assign
    const role = await getRequestPassPilotRole(req, res);
    if (!isPassPilotManager(role) && teacherId !== req.authUser?.id) {
      return res.status(403).json({ error: "You can only assign grades to yourself" });
    }
    if (!(await getGradeForSchool(gradeId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Grade not found" });
    }
    if (!(await userBelongsToSchool(teacherId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Teacher not found" });
    }
    const assignment = await assignTeacherGrade(teacherId, gradeId);
    return res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

router.delete("/teacher-grades", ...legacyPassPilotClassAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
  try {
    const { teacherId, gradeId } = req.body;
    if (!teacherId || !gradeId) {
      return res.status(400).json({ error: "teacherId and gradeId required" });
    }
    if (!(await getGradeForSchool(gradeId, res.locals.schoolId!)) || !(await userBelongsToSchool(teacherId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Assignment not found" });
    }
    const removed = await removeTeacherGrade(teacherId, gradeId);
    if (!removed) return res.status(404).json({ error: "Assignment not found" });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/teacher-grades/self-assign", ...legacyPassPilotClassAuth, async (req, res, next) => {
  try {
    const { gradeId } = req.body;
    if (!gradeId) {
      return res.status(400).json({ error: "gradeId required" });
    }
    if (!(await getGradeForSchool(gradeId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Grade not found" });
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

router.get("/teachers", ...passPilotAuth, async (req, res, next) => {
  try {
    // Include office_staff since they act as teachers in PassPilot/ClassPilot
    const allStaff = await getUsersBySchool(res.locals.schoolId!);
    const teachers = allStaff.filter(t =>
      t.role === "teacher" || t.role === "office_staff"
    );
    return res.json({
      teachers: teachers.map((t) => {
        const { password: _, ...safeUser } = t.user;
        const displayName = [safeUser.firstName, safeUser.lastName].filter(Boolean).join(" ") || null;
        return { id: t.userId, membershipId: t.id, userId: t.userId, role: t.role, name: displayName, displayName, email: safeUser.email, user: safeUser };
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
    // Return all staff who can teach (office_staff acts as teacher in PassPilot/ClassPilot)
    const allStaff = await getUsersBySchool(res.locals.schoolId!);
    const teachable = allStaff.filter(t =>
      t.role === "teacher" || t.role === "school_admin" || t.role === "admin" || t.role === "office_staff"
    );
    return res.json({
      teachers: teachable.map((t) => {
        const { password: _, ...safeUser } = t.user;
        const displayName = [safeUser.firstName, safeUser.lastName].filter(Boolean).join(" ") || null;
        return {
          id: t.userId,
          membershipId: t.id,
          userId: t.userId,
          role: t.role,
          email: safeUser.email,
          displayName,
          user: safeUser,
        };
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
    const domainValidation = await validateStaffEmailDomainForSchool(email, res.locals.schoolId!);
    if (!domainValidation.ok) {
      return res.status(400).json({
        error: domainValidation.message,
        code: domainValidation.code,
        expectedDomain: domainValidation.expectedDomain,
        actualDomain: domainValidation.actualDomain,
      });
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

    logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "user.create",
      entityType: "user",
      entityId: user.id,
      entityName: user.displayName || email,
      changes: { role: staffRole },
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

    const membership = await updateMembershipForSchool(id, res.locals.schoolId!, data);
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

    logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "user.update",
      entityType: "user",
      entityId: id,
      entityName: name || undefined,
      changes: { role, name },
    });

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

    logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "user.update",
      entityType: "user",
      entityId: member.userId,
      entityName: member.user?.displayName || member.user?.email,
      changes: { passwordReset: true },
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/users/:id - Delete staff member (ClassPilot Admin panel)
router.delete("/admin/users/:id", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const membershipId = param(req, "id");
    const deleted = await deleteMembershipForSchool(membershipId, res.locals.schoolId!);
    if (!deleted) {
      return res.status(404).json({ error: "Membership not found" });
    }

    logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "user.delete",
      entityType: "user",
      entityId: membershipId,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /admin/audit-logs - School audit logs (ClassPilot Admin panel)
router.get("/admin/audit-logs", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const action = req.query.action as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const filterOpts = { schoolId, action: action || undefined };
    const [logs, total] = await Promise.all([
      getAuditLogs({ ...filterOpts, limit, offset }),
      countAuditLogs(filterOpts),
    ]);

    return res.json({ logs, total });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/teachers/:id - Remove staff member (alias for /admin/users/:id)
router.delete("/admin/teachers/:id", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const membershipId = param(req, "id");
    const deleted = await deleteMembershipForSchool(membershipId, res.locals.schoolId!);
    if (!deleted) return res.status(404).json({ error: "Staff member not found" });
    logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "user.delete",
      entityType: "membership",
      entityId: membershipId,
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /admin/cleanup-students - Clear all student devices and activity data
router.post("/admin/cleanup-students", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    // Delete heartbeats, devices, daily_usage, and group_students for this school
    await db.delete(heartbeats).where(eq(heartbeats.schoolId, schoolId));
    await db.delete(dailyUsage).where(eq(dailyUsage.schoolId, schoolId));
    await db.delete(deviceTable).where(eq(deviceTable.schoolId, schoolId));
    logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "students.cleanup",
      entityType: "school",
      entityId: schoolId,
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /admin/classroom/courses-preview - List Google Classroom courses for import
router.get("/admin/classroom/courses-preview", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { getRosterClassroomClientForSchool } = await import("../services/googleRosterConnector.js");
    const { classroom } = await getRosterClassroomClientForSchool(res.locals.schoolId!);
    const courses: any[] = [];
    let pageToken: string | undefined;
    do {
      const response = await classroom.courses.list({
        teacherId: "me",
        courseStates: ["ACTIVE"],
        pageSize: 100,
        pageToken,
      });
      courses.push(...(response.data.courses || []));
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
    return res.json({ courses });
  } catch (err) {
    return res.json({ courses: [] });
  }
});

// POST /admin/classroom/create-class - Create a group from a Google Classroom course
router.post("/admin/classroom/create-class", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { courseId, teacherId, gradeLevel } = req.body;
    if (!courseId || !teacherId) {
      return res.status(400).json({ error: "courseId and teacherId required" });
    }
    if (!(await userBelongsToSchool(teacherId, schoolId))) {
      return res.status(404).json({ error: "Teacher not found in this school" });
    }
    const teacher = await getUserById(teacherId);
    if (!teacher) {
      return res.status(404).json({ error: "Teacher not found in this school" });
    }
    const domainValidation = await validateStaffEmailDomainForSchool(teacher.email, schoolId);
    if (!domainValidation.ok) {
      return res.status(400).json({
        error: domainValidation.message,
        code: domainValidation.code,
        expectedDomain: domainValidation.expectedDomain,
        actualDomain: domainValidation.actualDomain,
      });
    }
    // Create a group for this course
    const [group] = await db.insert(groups).values({
      schoolId,
      teacherId,
      name: req.body.courseName || `Class ${courseId}`,
      groupType: "admin_class",
      gradeLevel: gradeLevel || null,
    }).returning();
    return res.status(201).json({ group });
  } catch (err) {
    next(err);
  }
});

router.get("/admin/teacher-students", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const students = await getStudentsBySchool(res.locals.schoolId!);
    // Include studentName/studentEmail for ClassPilot frontend compatibility
    const mapped = students.map((s: any) => ({
      ...classPilotStudentDto(s),
      hasClassPilotPin: !!s.classpilotPinHash,
      classpilotPin: decryptClassPilotPin(s.classpilotPinEncrypted),
      studentName: [s.firstName, s.lastName].filter(Boolean).join(" ") || s.email || "",
      studentEmail: s.email || "",
    }));
    return res.json({ students: mapped });
  } catch (err) {
    next(err);
  }
});

const classPilotAdminAnalyticsAuth = [
  ...schoolAuth,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

router.get("/admin/analytics/summary", ...classPilotAdminAnalyticsAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const analytics = await getClasspilotAdminAnalyticsSummary(schoolId, req.query.period as string | undefined);
    return res.json(analytics);
  } catch (err) {
    next(err);
  }
});

router.get("/admin/analytics/by-teacher", ...classPilotAdminAnalyticsAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const analytics = await getClasspilotAdminAnalyticsByTeacher(schoolId, req.query.period as string | undefined);
    return res.json(analytics);
  } catch (err) {
    next(err);
  }
});

router.get("/admin/analytics/by-group", ...classPilotAdminAnalyticsAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const attributionMode = req.query.attributionMode === "roster" ? "roster" : "session";
    const analytics = await getClasspilotAdminAnalyticsByGroup(schoolId, req.query.period as string | undefined, {
      attributionMode,
    });
    return res.json(analytics);
  } catch (err) {
    next(err);
  }
});

router.post("/admin/bulk-import", ...schoolAuth, requireRole("admin"), async (_req, res) => {
  return res.status(400).json({ error: "Use POST /students/import-csv for bulk import" });
});

router.post("/admin/students/bulk-delete", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { studentIds } = req.body;
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds array required" });
    }
    const schoolId = res.locals.schoolId!;
    let deleted = 0;
    for (const id of studentIds) {
      const student = await getStudentById(id);
      if (student && student.schoolId === schoolId) {
        await deleteStudent(id, schoolId);
        deleted++;
      }
    }
    // Audit destructive bulk action (who deleted how many, when).
    logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "student.bulk_delete",
      entityType: "student",
      metadata: { requested: studentIds.length, deleted },
    });
    return res.json({ deleted });
  } catch (err) {
    next(err);
  }
});

router.post("/admin/students/bulk-update-grade", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { studentIds, gradeLevel } = req.body;
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds array required" });
    }
    const schoolId = res.locals.schoolId!;
    let updated = 0;
    for (const id of studentIds) {
      const student = await getStudentById(id);
      if (student && student.schoolId === schoolId) {
        await updateStudent(id, { gradeLevel: gradeLevel || null });
        updated++;
      }
    }
    return res.json({ updated });
  } catch (err) {
    next(err);
  }
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

router.get("/admin/reports", ...passPilotAuth, requirePassPilotRole("admin", "school_admin"), async (_req, res) => {
  return res.json({ reports: [] });
});

// ============================================================================
// Kiosk config (PassPilot calls PUT /kiosk-config)
// ============================================================================

router.get("/kiosk-config", ...passPilotAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const source = await getPasspilotClassSourceForSchool(schoolId);
    if (source === "classpilot_groups" && !hasPasspilotCanonicalClassCapability(req)) {
      return res.status(426).json({
        error: "This school uses the ClassPilot class model. Refresh or update PassPilot before continuing.",
        code: "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
        requiredClassModel: "classpilot-groups-v1",
      });
    }
    const school = await getSchoolById(schoolId);
    if (!school) return res.status(404).json({ error: "School not found" });
    const classId = source === "classpilot_groups"
      ? school.kioskClasspilotGroupId || null
      : school.kioskGradeId || null;
    if (source === "classpilot_groups" && classId) {
      const configuredClass = await getCanonicalClassForSchool(classId, schoolId);
      if (!configuredClass) {
        return res.status(409).json({
          error: "The configured kiosk class is no longer active. Select an active ClassPilot class before using the kiosk.",
          code: "PASSPILOT_KIOSK_CLASS_INACTIVE",
          source,
        });
      }
    }
    return res.json({
      source,
      classId,
      gradeId: source === "legacy_grades" ? classId : null,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/kiosk-config", ...passPilotAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    let role;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "kioskEnabled")) {
      role = await getRequestPassPilotRole(req, res);
      if (role !== "super_admin" && role !== "admin" && role !== "school_admin") {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      // The legacy kiosk-config endpoint has no settings revision or PIN
      // invariant. Never let it bypass the authoritative admin settings API.
      return res.status(409).json({
        error: "Kiosk Mode is managed in PassPilot Setup settings.",
        code: "PASSPILOT_KIOSK_SETTINGS_MANAGED_IN_SETUP",
        managementUrl: "/passpilot/setup?section=settings",
      });
    }
    const source = await getPasspilotClassSourceForSchool(schoolId);
    if (source === "classpilot_groups" && !hasPasspilotCanonicalClassCapability(req)) {
      return res.status(426).json({
        error: "This school uses the ClassPilot class model. Refresh or update PassPilot before continuing.",
        code: "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
        requiredClassModel: "classpilot-groups-v1",
      });
    }
    const selectedClassId = req.body.classId !== undefined ? req.body.classId : req.body.gradeId;
    if (selectedClassId !== undefined) {
      role ??= await getRequestPassPilotRole(req, res);
      if (selectedClassId && !(await canAccessPasspilotClass(req.authUser!, schoolId, selectedClassId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      if (source === "classpilot_groups") {
        await updateCanonicalKioskClass(
          schoolId,
          selectedClassId || null,
          req.authUser!.id,
          isPassPilotManager(role)
        );
      } else {
        await updateLegacyKioskClass(
          schoolId,
          selectedClassId || null,
          req.authUser!.id,
          isPassPilotManager(role)
        );
      }
    }
    const school = await getSchoolById(schoolId);
    if (req.body.kioskName !== undefined) {
      const membership = await getMembershipByUserAndSchool(req.authUser!.id, schoolId);
      if (membership) {
        await updateMembership(membership.id, { kioskName: req.body.kioskName || null });
      }
      await updateUser(req.authUser!.id, { displayName: req.body.kioskName || null });
    }
    return res.json({ school: school ? sanitizeSchool(school) : school });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// My classes (PassPilot teacher dashboard)
// ============================================================================

router.get("/my-classes", ...legacyPassPilotClassAuth, async (req, res, next) => {
  try {
    const assignments = (await getTeacherGradeAssignments(req.authUser!.id, res.locals.schoolId!))
      .filter((assignment) => assignment.grade.migrationState !== "history_only");

    return res.json({
      classes: assignments.map((a) => ({
        id: a.grade.id,
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

router.get("/students-aggregated", ...classPilotStaffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const userId = req.authUser!.id;
    const membershipRole = res.locals.membershipRole as string | undefined;
    const isAdmin = membershipRole === "admin" || membershipRole === "school_admin" || membershipRole === "super_admin";

    const requestedTeachingSessionId = typeof req.query.teachingSessionId === "string"
      ? req.query.teachingSessionId.trim()
      : "";
    let activeSession = requestedTeachingSessionId
      ? await getTeachingSessionByIdAndSchool(requestedTeachingSessionId, schoolId)
      : await getActiveTeachingSessionForSchool(userId, schoolId);
    if (requestedTeachingSessionId) {
      const authorized = isAdmin || !!activeSession && await isAuthorizedClasspilotSessionStaff(
        schoolId,
        requestedTeachingSessionId,
        userId
      );
      if (!activeSession || activeSession.endTime || !authorized) {
        return res.status(404).json({ error: "Active class session not found" });
      }
    }
    const activeGroup = activeSession?.groupId
      ? await getGroupByIdAndSchool(activeSession.groupId, schoolId)
      : undefined;

    let dbStudents;
    if (activeGroup) {
      // The class roster is frozen at session start. Current group membership
      // must not silently add or remove students from an already-running
      // teacher monitoring boundary.
      const groupStudentRows = await getClasspilotSessionStudentRoster(
        schoolId,
        activeSession!.id
      );
      dbStudents = groupStudentRows.map((row) => {
        if (row.student) return row.student;
        const snapshotName = String(row.studentNameSnapshot || "Unknown student").trim();
        const nameParts = snapshotName.split(/\s+/);
        return {
          id: row.studentId,
          firstName: nameParts.shift() || "Unknown",
          lastName: nameParts.join(" "),
          email: null,
          gradeLevel: null,
          deviceId: null,
        };
      });
    } else if (isAdmin) {
      // Admin without active session → show all students
      dbStudents = await getStudentsBySchool(schoolId);
    } else {
      // Teacher without active session → show empty (Dashboard shows "No Active Class Session")
      return res.json([]);
    }

    const schoolTimezone = await getClasspilotDashboardSchoolTimezone(schoolId);
    const today = todayInTimeZone(schoolTimezone);

    const studentIds = dbStudents.map((s) => s.id);
    const [snapshotRows, controlStateRows] = await Promise.all([
      getClasspilotDashboardSnapshot(schoolId, studentIds, today),
      getClasspilotStudentControlStates(schoolId, studentIds),
    ]);
    const snapshotByStudent = new Map(snapshotRows.map((row) => [row.studentId, row]));
    const controlStateByStudent = new Map(controlStateRows.map((row) => [row.studentId, row]));
    const authorizedRealtimeBindings = snapshotRows
      .filter((row) => row.studentSessionId && row.sessionDeviceId)
      .map((row) => ({
        studentId: row.studentId,
        studentSessionId: row.studentSessionId!,
        deviceId: row.sessionDeviceId!,
        sessionStartedAt: row.sessionStartedAt,
      }));
    const realtimeByStudent = await loadAuthorizedRealtimeStatuses(
      schoolId,
      authorizedRealtimeBindings
    );

    const aggregated = dbStudents.map((student) => {
      const snapshot = snapshotByStudent.get(student.id);
      const rt = realtimeByStudent.get(student.id) || null;
      const desiredControlState = controlStateByStudent.get(student.id);
      const activeCoverage = snapshot?.coverage || null;
      const activeClass = snapshot?.activeClass || null;
      // Fallback to student_devices table when realtime status has no device mapping
      const deviceId = rt?.deviceId || snapshot?.sessionDeviceId || student.deviceId || snapshot?.mappedDeviceId || null;
      const activeRealtime = rt?.state === "active" ? rt : null;
      // A delegated student is observed by the assigned coverage staff, not by
      // the original class teacher. Keep roster/supervision context visible but
      // do not return live browser telemetry from the delegated interval.
      const delegatedAway = Boolean(
        activeCoverage && activeCoverage.assignedStaffId !== userId && !isAdmin
      );
      const visibleRealtime = delegatedAway ? null : activeRealtime;
      const signedOut = rt?.state === "signed_out";
      const attendanceStatus = snapshot?.attendanceStatus || "present";
      const activePass = snapshot?.activePass || null;
      const dismissal = snapshot?.dismissal || null;
      let suppressionReason: string | null = null;
      if (attendanceStatus === "absent") suppressionReason = "Student is marked absent";
      else if (attendanceStatus === "tardy") suppressionReason = "Student is marked tardy";
      else if (attendanceStatus === "early_dismissal") suppressionReason = "Student checked out early";
      else if (activePass) suppressionReason = "Student is on an active hall pass";
      else if (dismissal?.status === "dismissed") suppressionReason = "Student is dismissed";
      else if (dismissal?.status === "released") suppressionReason = "Student is released for dismissal";
      else if (dismissal) suppressionReason = "Student is in the dismissal flow";
      const sessionLastSeenAt = snapshot?.sessionLastSeenAt
        ? new Date(snapshot.sessionLastSeenAt).getTime()
        : 0;
      const lastActivityAt = visibleRealtime?.observedAt
        || (delegatedAway ? 0 : rt?.observedAt)
        || sessionLastSeenAt
        || 0;
      const timeSinceLastSeen = lastActivityAt ? Date.now() - lastActivityAt : Infinity;
      // Authentication state and monitoring freshness are deliberately
      // separate. A still-active session with stale telemetry is reported as
      // signal loss, never rewritten as "not logged in."
      const isLoggedIn = Boolean(
        snapshot?.studentSessionId && snapshot?.sessionDeviceId && !signedOut
      );
      let status: "online" | "idle" | "offline" = "offline";
      if (isLoggedIn && timeSinceLastSeen < CLASSPILOT_REALTIME_STALE_AFTER_MS) {
        status = "online";
      } else if (isLoggedIn && timeSinceLastSeen < CLASSPILOT_REALTIME_EXPIRED_AFTER_MS) {
        status = "idle";
      }
      const activityFresh = !delegatedAway && status === "online";
      const monitoringState = delegatedAway
        ? "not_expected"
        : !isLoggedIn
        ? "not_logged_in"
        : activityFresh
          ? "healthy"
          : "signal_lost";
      const monitoringLostAt = !delegatedAway && isLoggedIn && !activityFresh && lastActivityAt
        ? new Date(lastActivityAt + CLASSPILOT_REALTIME_STALE_AFTER_MS).toISOString()
        : null;
      const ownedDesiredControlState = (
        activeSession?.id
        && desiredControlState?.teachingSessionId === activeSession.id
      ) ? desiredControlState : undefined;
      const desiredClassroomState = ownedDesiredControlState
        ? serializeClasspilotStudentControlState(ownedDesiredControlState)
        : undefined;
      const realtimeClassroomState = visibleRealtime?.classroomState;
      const scopedRealtimeClassroomState = activeSession?.id
        ? realtimeClassroomState?.teachingSessionId === activeSession.id
          ? realtimeClassroomState
          : undefined
        : realtimeClassroomState;
      const realtimeClassroomRevision = scopedRealtimeClassroomState?.revision ?? -1;
      const authoritativeClassroomState = desiredClassroomState
        && desiredClassroomState.revision >= realtimeClassroomRevision
        ? desiredClassroomState
        : scopedRealtimeClassroomState;
      const enforcementHealth = ownedDesiredControlState
        ? (!isLoggedIn
            ? ownedDesiredControlState.enforcementHealth
            : effectiveClasspilotControlEnforcementHealth(
                ownedDesiredControlState,
                visibleRealtime?.extensionVersion
              ))
        : scopedRealtimeClassroomState
          ? visibleRealtime?.enforcementHealth || "unsupported"
          : "unsupported";

      return {
        studentId: student.id,
        studentEmail: student.email || undefined,
        studentName:
          [student.firstName, student.lastName].filter(Boolean).join(" ") ||
          student.email ||
          "Unknown",
        gradeLevel: student.gradeLevel || undefined,
        classId: "",
        deviceCount: deviceId ? 1 : 0,
        devices: [],
        status,
        loginState: isLoggedIn ? "logged_in" : "not_logged_in",
        isLoggedIn,
        lastSeenAt: lastActivityAt,
        deviceName: undefined,
        activeTabTitle: visibleRealtime?.activeTabTitle || "",
        activeTabUrl: visibleRealtime?.activeTabUrl || "",
        favicon: visibleRealtime?.favicon,
        allOpenTabs: visibleRealtime?.allOpenTabs,
        isSharing: visibleRealtime?.classroomControls.isSharing || false,
        screenLocked: visibleRealtime?.classroomControls.screenLocked || false,
        flightPathActive: visibleRealtime?.classroomControls.flightPathActive || false,
        activeFlightPathName: visibleRealtime?.classroomControls.activeFlightPathName,
        cameraActive: visibleRealtime?.classroomControls.cameraActive || false,
        aiClassification: visibleRealtime?.aiClassification || undefined,
        screenshotHealth: visibleRealtime?.screenshotHealth || undefined,
        classroomState: authoritativeClassroomState,
        enforcementHealth,
        realtimeBinding: !delegatedAway
          ? classpilotPublicRealtimeBinding(snapshot?.studentSessionId)
          : null,
        realtimeRevision: !delegatedAway && rt && rt.revision > 0
          ? rt.revision
          : null,
        realtimeObservedAt: !delegatedAway && rt
          ? new Date(rt.observedAt).toISOString()
          : null,
        activityFresh,
        activityState: delegatedAway
          ? "delegated"
          : visibleRealtime?.activityState || (signedOut ? "off" : "unknown"),
        monitoringState,
        monitoringLostAt,
        classificationPending: visibleRealtime?.classificationPending || false,
        openTabCount: visibleRealtime?.openTabCount || 0,
        tabsTruncated: visibleRealtime?.tabsTruncated || false,
        attendanceStatus,
        activePass: activePass ? {
          id: activePass.id,
          destination: activePass.destination,
          issuedAt: activePass.issuedAt,
          expiresAt: activePass.expiresAt,
          status: activePass.status,
        } : null,
        dismissalStatus: dismissal ? {
          id: dismissal.id,
          status: dismissal.status,
          checkInMethod: dismissal.checkInMethod,
          checkInTime: dismissal.checkInTime,
        } : null,
        supervisionState: activeCoverage
          ? "temporary_coverage"
          : activeGroup || activeClass
            ? "in_class"
            : isLoggedIn
              ? "online_unassigned"
              : "offline",
        supervisionContext: activeCoverage ? {
          id: activeCoverage.id,
          type: activeCoverage.contextType,
          name: activeCoverage.name,
          assignedStaffId: activeCoverage.assignedStaffId,
          assignedStaff: {
            id: activeCoverage.assignedStaffId,
            displayName: activeCoverage.assignedStaffDisplayName,
          },
          endsAt: activeCoverage.endsAt,
        } : activeClass ? {
          id: activeClass.sessionId,
          type: "class",
          name: activeClass.groupName,
          groupId: activeClass.groupId,
          teacherId: activeClass.teacherId,
          startTime: activeClass.startTime,
        } : null,
        monitoringContext: visibleRealtime?.aiClassification?.safetyAlert
          ? "safety_with_context"
          : (suppressionReason ? "classroom_noise_suppressed" : "classroom"),
        suppressionReason,
        classroomNoiseSuppressed: !!suppressionReason,
      };
    });

    return res.json(aggregated);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Export (ClassPilot)
// ============================================================================

router.get("/export/activity", ...classPilotStaffAuth, async (_req, res) => {
  return res.json({ activities: [] });
});

// ============================================================================
// GoPilot parent features
// ============================================================================

// GET /me/children (rewritten from /me/children → /users/me/children)
// This route is mounted at "/" so it handles /users/me/children

// POST /auth/register/parent
router.post("/auth/register/parent", async (_req, res) => {
  return sendGoPilotParentPortalDisabled(res);
});

// ============================================================================
// GoPilot school-scoped: settings, invite, parent-requests
// (These are called via URL rewrite from /schools/:id/settings → /compat/school-settings)
// ============================================================================

router.get("/compat/school-settings", ...goPilotStaffAuth, async (_req, res, next) => {
  try {
    const current = await getGoPilotSettings(res.locals.schoolId!);
    if (!current) return res.status(404).json({ error: "School not found" });
    return res.json({
      autoDismissalEnabled: current.autoStartEnabled,
      pickupZones: current.pickupZones,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/compat/school-settings", ...goPilotAdminAuth, (_req, res) => {
  // Legacy clients have no revision token and cannot safely participate in
  // concurrent settings updates. Keep the read alias during rollout, but
  // never let an old bundle overwrite the authoritative revisioned contract.
  return res.status(426).json({
    error: "Update GoPilot before changing dismissal settings.",
    code: "GOPILOT_SETTINGS_CLIENT_UPDATE_REQUIRED",
    managementUrl: "/gopilot/setup?tab=settings",
  });
});

router.all("/compat/invite", authenticate, (_req, res) => sendGoPilotParentPortalDisabled(res));
router.all("/compat/parent-requests", authenticate, (_req, res) => sendGoPilotParentPortalDisabled(res));
router.all("/compat/parent-requests/:id", authenticate, (_req, res) => sendGoPilotParentPortalDisabled(res));
router.all("/compat/parents", authenticate, (_req, res) => sendGoPilotParentPortalDisabled(res));

// ============================================================================
// CSV template & import (PassPilot)
// ============================================================================

router.get("/students/csv-template", ...passPilotAuth, async (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=students-template.csv");
  return res.send("firstName,lastName,email,studentIdNumber,gradeLevel,classpilotPin\n");
});

export default router;
