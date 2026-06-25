import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { getSchoolDeviceStatuses } from "../../realtime/student-statuses.js";
import {
  assignStudentsToSupervisionContext,
  createCoverageAssignment,
  createSupervisionContextWithStudents,
  extendSupervisionContext,
  getActiveCoverageAssignmentsForStaff,
  getActiveTeachingSessionForSchool,
  getGroupByIdAndSchool,
  getGroupStudents,
  getMembershipByUserAndSchool,
  getOnlineUnassignedStudents,
  getStudentById,
  getSupervisionContextByIdAndSchool,
  getUserById,
  listCoverageAssignments,
  listSupervisionContexts,
  listSupervisionStudentsForContexts,
  releaseSupervisionStudents,
  updateCoverageAssignmentActive,
  type OnlineUnassignedStudent,
} from "../../services/storage.js";
import { logAudit } from "../../services/audit.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

const COVERAGE_TYPES = new Set([
  "state_testing",
  "indoor_recess",
  "intervention",
  "office",
  "assembly",
  "other",
]);

function isAdmin(req: any, res: any) {
  const role = res.locals.membershipRole;
  return req.authUser?.isSuperAdmin || role === "admin" || role === "school_admin";
}

function requireStaffRole(req: any, res: any): boolean {
  const role = res.locals.membershipRole;
  return !!req.authUser?.isSuperAdmin || ["admin", "school_admin", "teacher", "office_staff"].includes(role);
}

function normalizeStudentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((id) => id.trim()).filter(Boolean))];
}

function normalizeScopeValue(scopeType: string, raw: unknown): string | null {
  if (scopeType === "school") return null;
  if (scopeType === "students") {
    const ids = normalizeStudentIds(raw);
    return ids.length ? ids.join(",") : null;
  }
  const value = String(raw || "").trim();
  return value || null;
}

function studentName(student: any): string {
  return [student.firstName, student.lastName].filter(Boolean).join(" ").trim() || student.email || student.id;
}

function activeStatusFor(row: OnlineUnassignedStudent) {
  const statuses = getSchoolDeviceStatuses(row.student.schoolId);
  const byStudent = statuses.find((status) => status.studentId === row.student.id);
  const byDevice = statuses.find((status) => status.deviceId === row.studentSession.deviceId);
  const rt = byStudent || byDevice || null;
  const lastSeenAt = rt?.lastSeenAt || row.studentSession.lastSeenAt.getTime();
  const age = lastSeenAt ? Date.now() - lastSeenAt : Infinity;
  return {
    status: age < 60000 ? "online" : age < 300000 ? "idle" : "offline",
    lastSeenAt,
    activeTabTitle: rt?.activeTabTitle || "",
    activeTabUrl: rt?.activeTabUrl || "",
    primaryDeviceId: rt?.deviceId || row.studentSession.deviceId,
    allOpenTabs: rt?.allOpenTabs || [],
    screenshotHealth: rt?.screenshotHealth,
  };
}

async function groupStudentSet(groupId: string): Promise<Set<string>> {
  const rows = await getGroupStudents(groupId);
  return new Set(rows.map((row) => row.studentId));
}

async function assignmentsCoverStudent(assignments: any[], student: any): Promise<boolean> {
  for (const assignment of assignments) {
    if (assignment.scopeType === "school") return true;
    if (assignment.scopeType === "grade" && String(student.gradeLevel || "") === String(assignment.scopeValue || "")) {
      return true;
    }
    if (assignment.scopeType === "students") {
      const ids = String(assignment.scopeValue || "").split(",").map((id) => id.trim()).filter(Boolean);
      if (ids.includes(student.id)) return true;
    }
    if (assignment.scopeType === "group" && assignment.scopeValue) {
      const members = await groupStudentSet(assignment.scopeValue);
      if (members.has(student.id)) return true;
    }
  }
  return false;
}

async function filterRowsByAssignments(rows: OnlineUnassignedStudent[], assignments: any[]) {
  const allowed: OnlineUnassignedStudent[] = [];
  for (const row of rows) {
    if (await assignmentsCoverStudent(assignments, row.student)) allowed.push(row);
  }
  return allowed;
}

async function assertStudentsInSchool(schoolId: string, studentIds: string[]) {
  const students = [];
  for (const studentId of studentIds) {
    const student = await getStudentById(studentId);
    if (!student || student.schoolId !== schoolId) {
      const err: any = new Error("One or more students are not in this school");
      err.status = 400;
      throw err;
    }
    students.push(student);
  }
  return students;
}

async function contextResponse(schoolId: string, contexts: any[], includeStudentsFor: (context: any) => boolean) {
  const staffIds = [...new Set(contexts.map((context) => context.assignedStaffId).filter(Boolean))];
  const staffEntries = await Promise.all(staffIds.map(async (id) => [id, await getUserById(id)] as const));
  const staffById = new Map(staffEntries);
  const contextIds = contexts.map((context) => context.id);
  const allStudents = await listSupervisionStudentsForContexts(schoolId, contextIds, { activeOnly: true });
  const studentsByContext = new Map<string, any[]>();
  for (const entry of allStudents) {
    const list = studentsByContext.get(entry.contextId) || [];
    list.push(entry);
    studentsByContext.set(entry.contextId, list);
  }

  return contexts.map((context) => {
    const staff = staffById.get(context.assignedStaffId);
    const students = includeStudentsFor(context)
      ? (studentsByContext.get(context.id) || []).map((entry) => ({
          studentId: entry.studentId,
          studentName: studentName(entry.student),
          gradeLevel: entry.student.gradeLevel,
          assignedAt: entry.assignedAt,
        }))
      : undefined;
    return {
      ...context,
      assignedStaff: staff ? {
        id: staff.id,
        email: staff.email,
        displayName: staff.displayName || [staff.firstName, staff.lastName].filter(Boolean).join(" ") || staff.email,
      } : null,
      students,
      activeStudentCount: (studentsByContext.get(context.id) || []).length,
    };
  });
}

router.get("/coverage/unassigned", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const rows = await getOnlineUnassignedStudents(schoolId);
    const visibleRows = isAdmin(req, res)
      ? rows
      : await filterRowsByAssignments(
          rows,
          await getActiveCoverageAssignmentsForStaff(schoolId, req.authUser!.id)
        );

    return res.json({
      students: visibleRows.map((row) => {
        const status = activeStatusFor(row);
        return {
          studentId: row.student.id,
          studentName: studentName(row.student),
          studentEmail: row.student.email || undefined,
          gradeLevel: row.student.gradeLevel || undefined,
          isLoggedIn: true,
          loginState: "logged_in",
          supervisionState: "online_unassigned",
          supervisionContext: null,
          deviceCount: 1,
          devices: [{ deviceId: status.primaryDeviceId, status: status.status, lastSeenAt: status.lastSeenAt }],
          primaryDeviceId: status.primaryDeviceId,
          status: status.status,
          lastSeenAt: status.lastSeenAt,
          activeTabTitle: status.activeTabTitle,
          activeTabUrl: status.activeTabUrl,
          allOpenTabs: status.allOpenTabs,
          screenshotHealth: status.screenshotHealth,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/assignments", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const assignments = await listCoverageAssignments(res.locals.schoolId!);
    return res.json({ assignments });
  } catch (err) {
    next(err);
  }
});

router.post("/coverage/assignments", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const schoolId = res.locals.schoolId!;
    const staffId = String(req.body.staffId || "").trim();
    const scopeType = String(req.body.scopeType || "").trim();
    if (!staffId || !["school", "grade", "group", "students"].includes(scopeType)) {
      return res.status(400).json({ error: "staffId and valid scopeType are required" });
    }
    const membership = await getMembershipByUserAndSchool(staffId, schoolId);
    if (!membership || membership.status !== "active") {
      return res.status(404).json({ error: "Staff member not found in this school" });
    }
    const scopeValue = normalizeScopeValue(scopeType, req.body.scopeValue ?? req.body.studentIds);
    if (scopeType !== "school" && !scopeValue) {
      return res.status(400).json({ error: "scopeValue is required for this scope type" });
    }
    if (scopeType === "group" && !(await getGroupByIdAndSchool(scopeValue!, schoolId))) {
      return res.status(404).json({ error: "Coverage group not found" });
    }

    const assignment = await createCoverageAssignment({
      schoolId,
      staffId,
      scopeType: scopeType as any,
      scopeValue,
      permissions: { observe: true, claim: true },
      active: true,
      createdBy: req.authUser!.id,
    });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.assignment.create",
      entityType: "coverage_assignment",
      entityId: assignment.id,
      changes: assignment,
    });
    return res.status(201).json({ assignment });
  } catch (err) {
    next(err);
  }
});

router.patch("/coverage/assignments/:id", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const active = req.body.active !== false;
    const assignment = await updateCoverageAssignmentActive(res.locals.schoolId!, String(req.params.id), active);
    if (!assignment) return res.status(404).json({ error: "Coverage assignment not found" });
    return res.json({ assignment });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/contexts", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const activeOnly = req.query.active !== "false";
    const contexts = await listSupervisionContexts(schoolId, { activeOnly });
    const visible = isAdmin(req, res)
      ? contexts
      : contexts.filter((context) => context.assignedStaffId === req.authUser!.id || context.createdBy === req.authUser!.id || activeOnly);
    const response = await contextResponse(
      schoolId,
      visible,
      (context) => isAdmin(req, res) || context.assignedStaffId === req.authUser!.id || context.createdBy === req.authUser!.id
    );
    return res.json({ contexts: response });
  } catch (err) {
    next(err);
  }
});

router.post("/coverage/contexts", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const studentIds = normalizeStudentIds(req.body.studentIds);
    const admin = isAdmin(req, res);
    if (studentIds.length === 0 && !admin) return res.status(400).json({ error: "studentIds are required" });
    const students = await assertStudentsInSchool(schoolId, studentIds);
    if (!admin) {
      const unassignedRows = await getOnlineUnassignedStudents(schoolId);
      const unassignedIds = new Set(unassignedRows.map((row) => row.student.id));
      if (studentIds.some((id) => !unassignedIds.has(id))) {
        return res.status(403).json({ error: "Coverage staff can only claim currently unassigned students" });
      }
      const assignments = await getActiveCoverageAssignmentsForStaff(schoolId, req.authUser!.id);
      for (const student of students) {
        if (!(await assignmentsCoverStudent(assignments, student))) {
          return res.status(403).json({ error: "One or more students are outside your coverage scope" });
        }
      }
    }

    const contextType = String(req.body.contextType || "other").trim();
    if (!COVERAGE_TYPES.has(contextType)) return res.status(400).json({ error: "Invalid coverage type" });
    const endsAt = new Date(req.body.endsAt || "");
    if (!Number.isFinite(endsAt.getTime()) || endsAt <= new Date()) {
      return res.status(400).json({ error: "A future endsAt timestamp is required" });
    }
    const assignedStaffId = String(req.body.assignedStaffId || req.authUser!.id).trim();
    if (assignedStaffId !== req.authUser!.id && !admin) {
      return res.status(403).json({ error: "Only admins can assign coverage to another staff member" });
    }
    const assignedMembership = await getMembershipByUserAndSchool(assignedStaffId, schoolId);
    if (!assignedMembership || assignedMembership.status !== "active") {
      return res.status(404).json({ error: "Assigned staff member not found in this school" });
    }

    const context = await createSupervisionContextWithStudents({
      context: {
        schoolId,
        contextType,
        name: String(req.body.name || contextType.replace(/_/g, " ")).trim(),
        status: "active",
        assignedStaffId,
        createdBy: req.authUser!.id,
        note: req.body.note ? String(req.body.note) : null,
        endsAt,
      },
      studentIds,
      assignedBy: req.authUser!.id,
      source: admin ? "admin_claim" : "coverage_claim",
    });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.context.create",
      entityType: "supervision_context",
      entityId: context.id,
      changes: { contextType, studentIds, assignedStaffId, endsAt },
    });
    return res.status(201).json({ context });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/coverage/reroute", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const contextId = String(req.body.contextId || "").trim();
    const studentIds = normalizeStudentIds(req.body.studentIds);
    if (!contextId || studentIds.length === 0) return res.status(400).json({ error: "contextId and studentIds are required" });
    const context = await getSupervisionContextByIdAndSchool(schoolId, contextId);
    if (!context || context.status !== "active" || context.endsAt <= new Date()) {
      return res.status(404).json({ error: "Active coverage context not found" });
    }
    await assertStudentsInSchool(schoolId, studentIds);

    if (!isAdmin(req, res)) {
      const session = await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
      if (!session) return res.status(409).json({ error: "Start a class session before rerouting students" });
      const group = await getGroupByIdAndSchool(session.groupId, schoolId);
      if (!group) return res.status(404).json({ error: "Active class group not found" });
      const classRows = await getGroupStudents(group.id);
      const classStudentIds = new Set(classRows.map((row) => row.studentId));
      if (studentIds.some((studentId) => !classStudentIds.has(studentId))) {
        return res.status(403).json({ error: "Teachers can only reroute students in their active class" });
      }
    }

    const assignments = await assignStudentsToSupervisionContext({
      schoolId,
      contextId,
      studentIds,
      assignedBy: req.authUser!.id,
      source: isAdmin(req, res) ? "admin_reroute" : "teacher_reroute",
    });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.student.reroute",
      entityType: "supervision_context",
      entityId: contextId,
      changes: { studentIds },
    });
    return res.status(201).json({ assignments });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/coverage/contexts/:id/release", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const context = await getSupervisionContextByIdAndSchool(schoolId, String(req.params.id));
    if (!context) return res.status(404).json({ error: "Coverage context not found" });
    if (!isAdmin(req, res) && context.assignedStaffId !== req.authUser!.id && context.createdBy !== req.authUser!.id) {
      return res.status(403).json({ error: "Only admins or assigned coverage staff can release students" });
    }
    const released = await releaseSupervisionStudents({
      schoolId,
      contextId: context.id,
      studentIds: normalizeStudentIds(req.body.studentIds),
      releaseReason: req.body.releaseReason ? String(req.body.releaseReason) : "released",
    });
    return res.json({ released });
  } catch (err) {
    next(err);
  }
});

router.patch("/coverage/contexts/:id", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const context = await getSupervisionContextByIdAndSchool(schoolId, String(req.params.id));
    if (!context) return res.status(404).json({ error: "Coverage context not found" });
    if (!isAdmin(req, res) && context.assignedStaffId !== req.authUser!.id && context.createdBy !== req.authUser!.id) {
      return res.status(403).json({ error: "Only admins or assigned coverage staff can update coverage" });
    }
    const endsAt = req.body.endsAt ? new Date(req.body.endsAt) : undefined;
    if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt <= new Date())) {
      return res.status(400).json({ error: "endsAt must be in the future" });
    }
    const assignedStaffId = isAdmin(req, res) && req.body.assignedStaffId ? String(req.body.assignedStaffId) : undefined;
    if (assignedStaffId) {
      const assignedMembership = await getMembershipByUserAndSchool(assignedStaffId, schoolId);
      if (!assignedMembership || assignedMembership.status !== "active") {
        return res.status(404).json({ error: "Assigned staff member not found in this school" });
      }
    }

    const updated = await extendSupervisionContext({
      schoolId,
      contextId: context.id,
      endsAt,
      note: req.body.note === undefined ? undefined : String(req.body.note || ""),
      assignedStaffId,
    });
    return res.json({ context: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
