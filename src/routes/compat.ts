import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireSchoolContext } from "../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../middleware/requireActiveSchool.js";
import { requireRole } from "../middleware/requireRole.js";
import { requireProductLicense } from "../middleware/requireProductLicense.js";
import { updateSchoolSchema } from "../schema/validation.js";
import { sanitizeSchool } from "../util/sanitizeSchool.js";
import { toSchoolUpdate } from "../util/schoolUpdate.js";
import { safeStudent } from "../util/safeStudent.js";
import { decryptClassPilotPin } from "../services/classpilotPins.js";
import { getSchoolDeviceStatuses } from "../realtime/student-statuses.js";
import { getConnectedStudentDeviceIds } from "../realtime/ws-broadcast.js";
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
  getPendingParentRequests,
  updateParentStudentLinkByIdAndSchool,
  getParentStudentLinkByIdAndSchool,
  getApprovedChildrenForParent,
  getUserByEmail,
  createUser,
  createMembership,
  getMembershipByUserAndSchool,
  deleteMembershipForSchool,
  updateMembership,
  updateMembershipForSchool,
  updateUser,
  getActiveTeachingSessionForSchool,
  getGroupStudents,
  getGroupByIdAndSchool,
  getUserById,
  getAttendanceBySchool,
  getActivePassesBySchool,
  getActiveSupervisionForStudents,
  getActiveClassOwnersForStudents,
  validateStaffEmailDomainForSchool,
} from "../services/storage.js";
import db from "../db.js";
import { heartbeats, devices as deviceTable, groups, dailyUsage, studentDevices, studentSessions } from "../schema/classpilot.js";
import { dismissalQueue, dismissalSessions } from "../schema/gopilot.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { createGradeSchema } from "../schema/validation.js";
import { hashPassword } from "../util/password.js";
import { logAudit, getAuditLogs, countAuditLogs } from "../services/audit.js";
import {
  canAccessGrade,
  getGradeForSchool,
  getRequestPassPilotRole,
  getTeacherGradeAssignments,
  isPassPilotManager,
  requirePassPilotRole,
  userBelongsToSchool,
} from "../services/passpilotAccess.js";
import {
  getClasspilotAdminAnalyticsByGroup,
  getClasspilotAdminAnalyticsByTeacher,
  getClasspilotAdminAnalyticsSummary,
} from "../services/classpilotAdminAnalytics.js";

const router = Router();

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

function displayNameForUser(user: any): string {
  return user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "Staff";
}

const auth = [authenticate] as const;
const schoolAuth = [authenticate, requireSchoolContext, requireActiveSchool] as const;
const passPilotAuth = [
  ...schoolAuth,
  requireProductLicense("PASSPILOT"),
  requirePassPilotRole("admin", "school_admin", "office_staff", "teacher"),
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

// ============================================================================
// Grades without school prefix (PassPilot calls GET /grades, POST /grades)
// ============================================================================

router.get("/grades", ...passPilotAuth, async (req, res, next) => {
  try {
    const grades = await getGradesBySchool(res.locals.schoolId!);
    return res.json({ grades });
  } catch (err) {
    next(err);
  }
});

router.get("/grades/available", ...passPilotAuth, async (req, res, next) => {
  try {
    const grades = await getGradesBySchool(res.locals.schoolId!);
    return res.json({ grades });
  } catch (err) {
    next(err);
  }
});

router.post("/grades", ...passPilotAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
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

router.put("/grades/:id", ...passPilotAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
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

router.delete("/grades/:id", ...passPilotAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
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

router.get("/teacher-grades/:teacherId", ...passPilotAuth, async (req, res, next) => {
  try {
    const teacherId = param(req, "teacherId");
    const role = await getRequestPassPilotRole(req, res);
    if (!isPassPilotManager(role) && teacherId !== req.authUser!.id) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    if (!(await userBelongsToSchool(teacherId, res.locals.schoolId!))) {
      return res.status(404).json({ error: "Teacher not found" });
    }
    const assignments = await getTeacherGradeAssignments(teacherId, res.locals.schoolId!);
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

router.post("/teacher-grades", ...passPilotAuth, async (req, res, next) => {
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

router.delete("/teacher-grades", ...passPilotAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
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

router.post("/teacher-grades/self-assign", ...passPilotAuth, async (req, res, next) => {
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
      ...safeStudent(s),
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
        await deleteStudent(id);
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

router.patch("/admin/settings", ...passPilotAuth, requirePassPilotRole("admin", "school_admin"), async (req, res, next) => {
  try {
    // Whitelist fields — prevents mass-assignment of billing/plan fields
    const parsed = updateSchoolSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }
    // toSchoolUpdate hashes the input-only kioskPin into kioskPinHash
    const school = await updateSchool(res.locals.schoolId!, await toSchoolUpdate(parsed.data));

    logAudit({
      schoolId: res.locals.schoolId!,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "settings.update",
      entityType: "school",
      entityId: res.locals.schoolId!,
      // never log the plaintext PIN
      changes:
        req.body?.kioskPin !== undefined
          ? { ...req.body, kioskPin: "[redacted]" }
          : req.body,
    });

    return res.json({ school: school ? sanitizeSchool(school) : school });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Kiosk config (PassPilot calls PUT /kiosk-config)
// ============================================================================

router.put("/kiosk-config", ...passPilotAuth, async (req, res, next) => {
  try {
    const updates: Record<string, any> = {};
    if (req.body.kioskEnabled !== undefined) updates.kioskEnabled = req.body.kioskEnabled;
    if (req.body.gradeId !== undefined) {
      const role = await getRequestPassPilotRole(req, res);
      if (req.body.gradeId && !(await canAccessGrade(req.authUser!, res.locals.schoolId!, req.body.gradeId, role))) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      updates.kioskGradeId = req.body.gradeId;
      updates.kioskActivatedByUserId = req.authUser!.id;
    }
    const school = await updateSchool(res.locals.schoolId!, updates);
    if (req.body.kioskName !== undefined) {
      const membership = await getMembershipByUserAndSchool(req.authUser!.id, res.locals.schoolId!);
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

router.get("/my-classes", ...passPilotAuth, async (req, res, next) => {
  try {
    const assignments = await getTeacherGradeAssignments(req.authUser!.id, res.locals.schoolId!);

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

router.get("/students-aggregated", ...schoolAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const userId = req.authUser!.id;
    const membershipRole = res.locals.membershipRole as string | undefined;
    const isAdmin = membershipRole === "admin" || membershipRole === "school_admin" || membershipRole === "super_admin";

    // Check for active teaching session. getActiveTeachingSession is keyed by
    // teacherId only, so for a multi-school teacher it can return a session that
    // belongs to a DIFFERENT school. Verify the session's group belongs to the
    // current school before exposing its students (cross-school PII guard).
    const activeSession = await getActiveTeachingSessionForSchool(userId, schoolId);
    const activeGroup = activeSession?.groupId
      ? await getGroupByIdAndSchool(activeSession.groupId, schoolId)
      : undefined;

    let dbStudents;
    if (activeGroup) {
      // Teacher/admin with active in-school session → show only that group's students
      const groupStudentRows = await getGroupStudents(activeGroup.id);
      dbStudents = groupStudentRows.map((gs) => gs.student);
    } else if (isAdmin) {
      // Admin without active session → show all students
      dbStudents = await getStudentsBySchool(schoolId);
    } else {
      // Teacher without active session → show empty (Dashboard shows "No Active Class Session")
      return res.json([]);
    }

    const realtimeStatuses = getSchoolDeviceStatuses(schoolId);
    const connectedDevices = getConnectedStudentDeviceIds(schoolId);
    const school = await getSchoolById(schoolId);
    const today = todayInTimeZone(school?.schoolTimezone);

    // Build lookups for real-time status
    const statusByDevice = new Map(
      realtimeStatuses.map((s) => [s.deviceId, s])
    );
    const statusByStudent = new Map(
      realtimeStatuses.map((s) => [s.studentId, s])
    );
    const statusByEmail = new Map(
      realtimeStatuses
        .filter((s) => s.studentEmail)
        .map((s) => [s.studentEmail!.toLowerCase(), s])
    );

    // Fallback: query student_devices for students without realtime status
    // This ensures primaryDeviceId is always resolved even after server restart
    const studentIds = dbStudents.map((s) => s.id);
    const deviceMappings = studentIds.length > 0
      ? await db.select({ studentId: studentDevices.studentId, deviceId: studentDevices.deviceId, lastSeenAt: studentDevices.lastSeenAt })
          .from(studentDevices)
          .where(inArray(studentDevices.studentId, studentIds))
      : [];
    const [activeStudentSessions, attendanceRows, activePasses, dismissalRows, activeCoverageRows, activeClassRows] = await Promise.all([
      studentIds.length > 0
        ? db
            .select()
            .from(studentSessions)
            .where(
              and(
                inArray(studentSessions.studentId, studentIds),
                eq(studentSessions.isActive, true)
              )
            )
        : [],
      getAttendanceBySchool(schoolId, today),
      getActivePassesBySchool(schoolId),
      studentIds.length > 0
        ? db
            .select({ queue: dismissalQueue, session: dismissalSessions })
            .from(dismissalQueue)
            .innerJoin(dismissalSessions, eq(dismissalQueue.sessionId, dismissalSessions.id))
            .where(
              and(
                eq(dismissalSessions.schoolId, schoolId),
                eq(dismissalSessions.date, today),
                inArray(dismissalQueue.studentId, studentIds),
                inArray(dismissalSessions.status, ["active", "paused", "completed"])
              )
            )
        : [],
      studentIds.length > 0 ? getActiveSupervisionForStudents(schoolId, studentIds) : [],
      studentIds.length > 0 ? getActiveClassOwnersForStudents(schoolId, studentIds) : [],
    ]);
    const attendanceByStudent = new Map(attendanceRows.map((row) => [row.attendance.studentId, row.attendance]));
    const activePassByStudent = new Map(activePasses.map((pass) => [pass.studentId, pass]));
    const activeSessionByStudent = new Map(activeStudentSessions.map((session) => [session.studentId, session]));
    const activeCoverageByStudent = new Map(activeCoverageRows.map((entry) => [entry.studentId, entry.context]));
    const activeClassByStudent = new Map(activeClassRows.map((row) => [row.studentId, row]));
    const activeCoverageStaffEntries = await Promise.all(
      [...new Set(activeCoverageRows.map((entry) => entry.context.assignedStaffId).filter(Boolean))]
        .map(async (staffId) => [staffId, await getUserById(staffId)] as const)
    );
    const activeCoverageStaffById = new Map(activeCoverageStaffEntries);
    const dismissalByStudent = new Map<string, any>();
    for (const row of dismissalRows) {
      const existing = dismissalByStudent.get(row.queue.studentId);
      if (!existing || row.queue.createdAt > existing.queue.createdAt) {
        dismissalByStudent.set(row.queue.studentId, row);
      }
    }
    // Build map: studentId → most recent deviceId
    const deviceByStudent = new Map<string, string>();
    for (const row of deviceMappings) {
      const existing = deviceByStudent.get(row.studentId);
      if (!existing) {
        deviceByStudent.set(row.studentId, row.deviceId);
      }
      // student_devices rows are unordered; keep any mapping (typically one device per student)
    }

    const aggregated = dbStudents.map((student) => {
      const rt =
        (student.deviceId ? statusByDevice.get(student.deviceId) : null) ||
        statusByStudent.get(student.id) ||
        (student.email ? statusByEmail.get(student.email.toLowerCase()) : null) ||
        null;
      const activeStudentSession = activeSessionByStudent.get(student.id);
      const activeCoverage = activeCoverageByStudent.get(student.id);
      const activeClass = activeClassByStudent.get(student.id);
      // Fallback to student_devices table when realtime status has no device mapping
      const deviceId = rt?.deviceId || activeStudentSession?.deviceId || student.deviceId || deviceByStudent.get(student.id) || null;
      const isConnected = deviceId ? connectedDevices.has(deviceId) : false;
      const attendance = attendanceByStudent.get(student.id);
      const attendanceStatus = attendance?.status || "present";
      const activePass = activePassByStudent.get(student.id) || null;
      const dismissal = dismissalByStudent.get(student.id)?.queue || null;
      let suppressionReason: string | null = null;
      if (attendanceStatus === "absent") suppressionReason = "Student is marked absent";
      else if (attendanceStatus === "tardy") suppressionReason = "Student is marked tardy";
      else if (attendanceStatus === "early_dismissal") suppressionReason = "Student checked out early";
      else if (activePass) suppressionReason = "Student is on an active hall pass";
      else if (dismissal?.status === "dismissed") suppressionReason = "Student is dismissed";
      else if (dismissal?.status === "released") suppressionReason = "Student is released for dismissal";
      else if (dismissal) suppressionReason = "Student is in the dismissal flow";
      const sessionLastSeenAt = activeStudentSession?.lastSeenAt
        ? activeStudentSession.lastSeenAt.getTime()
        : 0;
      const lastActivityAt = rt?.lastSeenAt || sessionLastSeenAt || 0;
      const timeSinceLastSeen = lastActivityAt ? Date.now() - lastActivityAt : Infinity;
      const isLoggedIn = !!activeStudentSession && timeSinceLastSeen < 300000;
      let status: "online" | "idle" | "offline" = "offline";
      if (timeSinceLastSeen < 60000 || (isConnected && timeSinceLastSeen < 90000)) {
        status = "online";
      } else if (timeSinceLastSeen < 300000) {
        status = "idle";
      }
      if (!isLoggedIn) {
        status = "offline";
      }

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
        devices: deviceId
          ? [{ deviceId, deviceName: undefined, status, lastSeenAt: lastActivityAt }]
          : [],
        status,
        loginState: isLoggedIn ? "logged_in" : "not_logged_in",
        isLoggedIn,
        lastSeenAt: lastActivityAt,
        primaryDeviceId: deviceId,
        deviceName: undefined,
        activeTabTitle: rt?.activeTabTitle || "",
        activeTabUrl: rt?.activeTabUrl || "",
        favicon: rt?.favicon,
        allOpenTabs: rt?.allOpenTabs?.map((t) => ({ ...t, deviceId: deviceId || "" })),
        isSharing: rt?.isSharing || false,
        screenLocked: rt?.screenLocked || false,
        flightPathActive: rt?.flightPathActive || false,
        activeFlightPathName: rt?.activeFlightPathName,
        cameraActive: rt?.cameraActive || false,
        aiClassification: rt?.aiClassification || undefined,
        screenshotHealth: rt?.screenshotHealth || undefined,
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
          assignedStaff: activeCoverage.assignedStaffId ? {
            id: activeCoverage.assignedStaffId,
            displayName: displayNameForUser(activeCoverageStaffById.get(activeCoverage.assignedStaffId)),
          } : null,
          endsAt: activeCoverage.endsAt,
        } : activeClass ? {
          id: activeClass.session.id,
          type: "class",
          name: activeClass.groupName,
          groupId: activeClass.groupId,
          teacherId: activeClass.session.teacherId,
          startTime: activeClass.session.startTime,
        } : null,
        monitoringContext: rt?.aiClassification?.safetyAlert
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
    const parsed = school.settings ? JSON.parse(school.settings) : {};
    // Provide default pickup zones if none configured
    if (!parsed.pickupZones || parsed.pickupZones.length === 0) {
      parsed.pickupZones = [
        { id: "A", name: "Zone A" },
        { id: "B", name: "Zone B" },
        { id: "C", name: "Zone C" },
      ];
    }
    return res.json(parsed);
  } catch (err) {
    next(err);
  }
});

router.put("/compat/school-settings", ...schoolAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const school = await getSchoolById(res.locals.schoolId!);
    if (!school) return res.status(404).json({ error: "School not found" });
    // Merge incoming settings with existing settings JSON blob
    const existing = school.settings ? JSON.parse(school.settings) : {};
    const merged = { ...existing, ...req.body };
    const updated = await updateSchool(res.locals.schoolId!, {
      settings: JSON.stringify(merged),
    });
    if (!updated) return res.status(404).json({ error: "School not found" });
    return res.json(merged);
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
    const link = await getParentStudentLinkByIdAndSchool(param(req, "id"), res.locals.schoolId!);
    if (!link) return res.status(404).json({ error: "Request not found" });
    const updated = await updateParentStudentLinkByIdAndSchool(param(req, "id"), res.locals.schoolId!, { status });
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
  return res.send("firstName,lastName,email,studentIdNumber,gradeLevel,classpilotPin\n");
});

export default router;
