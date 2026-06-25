import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { getSchoolDeviceStatuses } from "../../realtime/student-statuses.js";
import {
  assignStudentsToSupervisionContext,
  createCoverageAssignment,
  createCoverageScopeGroup,
  createSupervisionContextWithStudents,
  getActiveSessionByStudent,
  extendSupervisionContext,
  getActiveCoverageAssignmentsForStaff,
  getCoverageScopeGroupByIdAndSchool,
  getCoverageScopeGroupStudentIds,
  getActiveTeachingSessionForSchool,
  getGroupByIdAndSchool,
  getGroupStudents,
  getMembershipByUserAndSchool,
  getOnlineUnassignedStudents,
  getStudentById,
  getSupervisionContextByIdAndSchool,
  getUserById,
  listCoverageAssignments,
  listCoverageScopeGroups,
  listSupervisionContexts,
  listSupervisionStudentsForContexts,
  replaceCoverageScopeGroupMembers,
  releaseSupervisionStudents,
  updateCoverageAssignment,
  updateCoverageScopeGroup,
  type OnlineUnassignedStudent,
} from "../../services/storage.js";
import { getAuditLogs, logAudit } from "../../services/audit.js";
import {
  COVERAGE_COMMAND_TYPES,
  executeClasspilotCommand,
  type ResolvedClasspilotCommandTarget,
} from "../../services/classpilotCommandDispatcher.js";

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
const COVERAGE_SCOPE_TYPES = new Set(["school", "grade", "group", "students", "coverage_group"]);

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
    allOpenTabs: sanitizeTabs(rt?.allOpenTabs || []),
    screenshotHealth: rt?.screenshotHealth,
  };
}

function sanitizeTabs(tabs: any[]) {
  return tabs.map((tab) => ({
    title: tab.title || "",
    url: tab.url || "",
    favIconUrl: tab.favIconUrl || tab.favicon || "",
    active: !!tab.active,
  }));
}

async function activeStatusForStudent(schoolId: string, student: any) {
  const session = await getActiveSessionByStudent(student.id);
  const statuses = getSchoolDeviceStatuses(schoolId);
  const byStudent = statuses.find((status) => status.studentId === student.id);
  const byDevice = session ? statuses.find((status) => status.deviceId === session.deviceId) : null;
  const rt = byStudent || byDevice || null;
  const lastSeenAt = rt?.lastSeenAt || session?.lastSeenAt?.getTime?.() || null;
  const age = lastSeenAt ? Date.now() - lastSeenAt : Infinity;
  return {
    status: age < 60000 ? "online" : age < 300000 ? "idle" : "offline",
    lastSeenAt,
    activeTabTitle: rt?.activeTabTitle || "",
    activeTabUrl: rt?.activeTabUrl || "",
    allOpenTabs: sanitizeTabs(rt?.allOpenTabs || []),
    screenshotHealth: rt?.screenshotHealth,
  };
}

async function groupStudentSet(groupId: string): Promise<Set<string>> {
  const rows = await getGroupStudents(groupId);
  return new Set(rows.map((row) => row.studentId));
}

async function coverageGroupStudentSet(schoolId: string, coverageGroupId: string): Promise<Set<string>> {
  return new Set(await getCoverageScopeGroupStudentIds(schoolId, coverageGroupId));
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
    if (assignment.scopeType === "coverage_group" && assignment.scopeValue) {
      const members = await coverageGroupStudentSet(student.schoolId, assignment.scopeValue);
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

async function assertValidAssignmentScope(schoolId: string, scopeType: string, rawScopeValue: unknown) {
  if (!COVERAGE_SCOPE_TYPES.has(scopeType)) {
    throw Object.assign(new Error("A valid coverage scope is required"), { status: 400 });
  }
  const scopeValue = normalizeScopeValue(scopeType, rawScopeValue);
  if (scopeType !== "school" && !scopeValue) {
    throw Object.assign(new Error("scopeValue is required for this scope type"), { status: 400 });
  }
  if (scopeType === "group" && !(await getGroupByIdAndSchool(scopeValue!, schoolId))) {
    throw Object.assign(new Error("Coverage class/group not found"), { status: 404 });
  }
  if (scopeType === "coverage_group") {
    const group = await getCoverageScopeGroupByIdAndSchool(schoolId, scopeValue!);
    if (!group || !group.active) {
      throw Object.assign(new Error("Testing group not found"), { status: 404 });
    }
  }
  if (scopeType === "students") {
    await assertStudentsInSchool(schoolId, scopeValue!.split(",").map((id) => id.trim()).filter(Boolean));
  }
  return scopeValue;
}

async function assignmentResponse(schoolId: string, assignments: any[]) {
  const staffIds = [...new Set(assignments.map((assignment) => assignment.staffId).filter(Boolean))];
  const staffEntries = await Promise.all(staffIds.map(async (id) => [id, await getUserById(id)] as const));
  const staffById = new Map(staffEntries);

  return Promise.all(assignments.map(async (assignment) => {
    const staff = staffById.get(assignment.staffId);
    let scopeLabel = "Schoolwide";
    let scopeDetail: any = null;
    if (assignment.scopeType === "grade") {
      scopeLabel = `Grade ${assignment.scopeValue}`;
    } else if (assignment.scopeType === "group") {
      const group = assignment.scopeValue ? await getGroupByIdAndSchool(assignment.scopeValue, schoolId) : null;
      scopeLabel = group?.name ? `Class/Group: ${group.name}` : "Class/Group";
      scopeDetail = group ? { id: group.id, name: group.name } : null;
    } else if (assignment.scopeType === "coverage_group") {
      const group = assignment.scopeValue ? await getCoverageScopeGroupByIdAndSchool(schoolId, assignment.scopeValue) : null;
      scopeLabel = group?.name ? `Testing Group: ${group.name}` : "Testing Group";
      scopeDetail = group ? { id: group.id, name: group.name, studentCount: group.members.length } : null;
    } else if (assignment.scopeType === "students") {
      const ids = String(assignment.scopeValue || "").split(",").map((id) => id.trim()).filter(Boolean);
      scopeLabel = `${ids.length} selected student${ids.length === 1 ? "" : "s"}`;
      scopeDetail = { studentIds: ids };
    }

    return {
      ...assignment,
      permissionLabel: "Claim + Manage",
      scopeLabel,
      scopeDetail,
      staff: staff ? {
        id: staff.id,
        email: staff.email,
        displayName: staff.displayName || [staff.firstName, staff.lastName].filter(Boolean).join(" ") || staff.email,
      } : null,
    };
  }));
}

function coverageScopeGroupPayload(group: any) {
  return {
    id: group.id,
    schoolId: group.schoolId,
    name: group.name,
    description: group.description,
    active: group.active,
    createdBy: group.createdBy,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    studentCount: group.members.length,
    students: group.members.map((member: any) => ({
      studentId: member.studentId,
      studentName: studentName(member.student),
      studentEmail: member.student.email || undefined,
      gradeLevel: member.student.gradeLevel || undefined,
    })),
  };
}

function coverageCommandResponse(result: any) {
  const command = result.command
    ? {
        ...result.command,
        targets: (result.command.targets || []).map((target: any) => {
          const { deviceId: _deviceId, studentSessionId: _studentSessionId, ...safeTarget } = target;
          return safeTarget;
        }),
      }
    : result.command;
  return { ...result, command };
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
    const canViewStudents = includeStudentsFor(context);
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
      canManage: canViewStudents,
      canViewStudents,
      activeStudentCount: (studentsByContext.get(context.id) || []).length,
    };
  });
}

function canManageContext(req: any, res: any, context: any) {
  return isAdmin(req, res) || context.assignedStaffId === req.authUser!.id || context.createdBy === req.authUser!.id;
}

function assertActiveContext(context: any): asserts context {
  if (!context || context.status !== "active" || context.endsAt <= new Date()) {
    throw Object.assign(new Error("Active coverage context not found"), { status: 404 });
  }
}

async function contextStudentPayload(schoolId: string, rows: any[]) {
  const payload = [];
  for (const row of rows) {
    const status = await activeStatusForStudent(schoolId, row.student);
    payload.push({
      assignmentId: row.id,
      studentId: row.studentId,
      studentName: studentName(row.student),
      studentEmail: row.student.email || undefined,
      gradeLevel: row.student.gradeLevel || undefined,
      source: row.source,
      assignedBy: row.assignedBy,
      assignedAt: row.assignedAt,
      releasedAt: row.releasedAt,
      releaseReason: row.releaseReason,
      supervisionState: row.releasedAt ? "released" : "temporary_coverage",
      status: status.status,
      lastSeenAt: status.lastSeenAt,
      activeTabTitle: status.activeTabTitle,
      activeTabUrl: status.activeTabUrl,
      allOpenTabs: status.allOpenTabs,
      screenshotHealth: status.screenshotHealth,
    });
  }
  return payload;
}

async function resolveCoverageCommandTargets(
  schoolId: string,
  contextId: string,
  body: any
): Promise<ResolvedClasspilotCommandTarget[]> {
  const scope = String(body.targetScope || "").trim();
  if (scope !== "context" && scope !== "students") {
    throw Object.assign(new Error("targetScope must be context or students"), { status: 400 });
  }

  const activeRows = await listSupervisionStudentsForContexts(schoolId, [contextId], { activeOnly: true });
  if (activeRows.length === 0) {
    throw Object.assign(new Error("Coverage context has no active students"), { status: 400 });
  }

  let selectedRows = activeRows;
  if (scope === "students") {
    const targetStudentIds = normalizeStudentIds(body.targetStudentIds);
    if (targetStudentIds.length === 0) {
      throw Object.assign(new Error("targetStudentIds is required when targetScope is students"), { status: 400 });
    }
    const activeIds = new Set(activeRows.map((row) => row.studentId));
    const outsideContext = targetStudentIds.filter((id) => !activeIds.has(id));
    if (outsideContext.length > 0) {
      throw Object.assign(new Error("One or more selected students are not active in this coverage context"), { status: 400 });
    }
    const targetSet = new Set(targetStudentIds);
    selectedRows = activeRows.filter((row) => targetSet.has(row.studentId));
  }

  const now = Date.now();
  const activeWindowMs = 5 * 60 * 1000;
  const targets: ResolvedClasspilotCommandTarget[] = [];
  for (const row of selectedRows) {
    const session = await getActiveSessionByStudent(row.studentId);
    const lastSeenAt = session?.lastSeenAt?.getTime?.() ?? 0;
    const active = !!session && lastSeenAt > 0 && now - lastSeenAt <= activeWindowMs;
    targets.push({
      studentId: row.studentId,
      studentName: studentName(row.student),
      studentSessionId: active ? session!.id : null,
      deviceId: active ? session!.deviceId : null,
      available: active,
      unavailableReason: active ? undefined : "Student is not signed in to the extension",
    });
  }
  return targets;
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
    const schoolId = res.locals.schoolId!;
    const assignments = await listCoverageAssignments(schoolId);
    return res.json({ assignments: await assignmentResponse(schoolId, assignments) });
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
    if (!staffId || !COVERAGE_SCOPE_TYPES.has(scopeType)) {
      return res.status(400).json({ error: "staffId and valid scopeType are required" });
    }
    const membership = await getMembershipByUserAndSchool(staffId, schoolId);
    if (!membership || membership.status !== "active") {
      return res.status(404).json({ error: "Staff member not found in this school" });
    }
    const scopeValue = await assertValidAssignmentScope(schoolId, scopeType, req.body.scopeValue ?? req.body.studentIds);

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
    return res.status(201).json({ assignment: (await assignmentResponse(schoolId, [assignment]))[0] });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch("/coverage/assignments/:id", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const schoolId = res.locals.schoolId!;
    const assignmentId = String(req.params.id);
    const existing = (await listCoverageAssignments(schoolId)).find((assignment) => assignment.id === assignmentId);
    if (!existing) return res.status(404).json({ error: "Coverage assignment not found" });

    const activeOnlyChange =
      req.body.active !== undefined &&
      req.body.staffId === undefined &&
      req.body.scopeType === undefined &&
      req.body.scopeValue === undefined &&
      req.body.studentIds === undefined;
    if (activeOnlyChange) {
      const assignment = await updateCoverageAssignment(schoolId, assignmentId, { active: req.body.active !== false });
      if (!assignment) return res.status(404).json({ error: "Coverage assignment not found" });
      await logAudit({
        schoolId,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.membershipRole,
        action: "coverage.assignment.update",
        entityType: "coverage_assignment",
        entityId: assignment.id,
        changes: { active: assignment.active },
      });
      return res.json({ assignment: (await assignmentResponse(schoolId, [assignment]))[0] });
    }

    const nextStaffId = req.body.staffId === undefined ? existing.staffId : String(req.body.staffId || "").trim();
    const nextScopeType = req.body.scopeType === undefined ? existing.scopeType : String(req.body.scopeType || "").trim();
    const rawScopeValue = req.body.scopeValue === undefined && req.body.studentIds === undefined
      ? existing.scopeValue
      : req.body.scopeValue ?? req.body.studentIds;
    if (!nextStaffId) return res.status(400).json({ error: "staffId is required" });
    const membership = await getMembershipByUserAndSchool(nextStaffId, schoolId);
    if (!membership || membership.status !== "active") {
      return res.status(404).json({ error: "Staff member not found in this school" });
    }
    const scopeValue = await assertValidAssignmentScope(schoolId, nextScopeType, rawScopeValue);
    const active = req.body.active === undefined ? existing.active : req.body.active !== false;

    const assignment = await updateCoverageAssignment(schoolId, assignmentId, {
      staffId: nextStaffId,
      scopeType: nextScopeType as any,
      scopeValue,
      permissions: { observe: true, claim: true },
      active,
    });
    if (!assignment) return res.status(404).json({ error: "Coverage assignment not found" });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.assignment.update",
      entityType: "coverage_assignment",
      entityId: assignment.id,
      changes: assignment,
    });
    return res.json({ assignment: (await assignmentResponse(schoolId, [assignment]))[0] });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get("/coverage/scope-groups", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const groups = await listCoverageScopeGroups(res.locals.schoolId!, { activeOnly: req.query.active === "true" });
    return res.json({ groups: groups.map(coverageScopeGroupPayload) });
  } catch (err) {
    next(err);
  }
});

router.post("/coverage/scope-groups", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const schoolId = res.locals.schoolId!;
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const studentIds = normalizeStudentIds(req.body.studentIds);
    await assertStudentsInSchool(schoolId, studentIds);
    const group = await createCoverageScopeGroup({
      group: {
        schoolId,
        name,
        description: req.body.description ? String(req.body.description) : null,
        active: true,
        createdBy: req.authUser!.id,
      },
      studentIds,
    });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.scope_group.create",
      entityType: "coverage_scope_group",
      entityId: group.id,
      changes: { name, studentIds },
    });
    return res.status(201).json({ group: coverageScopeGroupPayload(group) });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch("/coverage/scope-groups/:id", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const schoolId = res.locals.schoolId!;
    const groupId = String(req.params.id);
    const data: { name?: string; description?: string | null; active?: boolean } = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name is required" });
      data.name = name;
    }
    if (req.body.description !== undefined) data.description = String(req.body.description || "");
    if (req.body.active !== undefined) data.active = req.body.active !== false;
    const group = await updateCoverageScopeGroup({ schoolId, groupId, ...data });
    if (!group) return res.status(404).json({ error: "Testing group not found" });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.scope_group.update",
      entityType: "coverage_scope_group",
      entityId: group.id,
      changes: data,
    });
    return res.json({ group: coverageScopeGroupPayload(group) });
  } catch (err) {
    next(err);
  }
});

router.put("/coverage/scope-groups/:id/students", ...auth, async (req, res, next) => {
  try {
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
    const schoolId = res.locals.schoolId!;
    const groupId = String(req.params.id);
    const studentIds = normalizeStudentIds(req.body.studentIds);
    await assertStudentsInSchool(schoolId, studentIds);
    const group = await replaceCoverageScopeGroupMembers({ schoolId, groupId, studentIds });
    if (!group) return res.status(404).json({ error: "Testing group not found" });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.scope_group.members.update",
      entityType: "coverage_scope_group",
      entityId: group.id,
      changes: { studentIds },
    });
    return res.json({ group: coverageScopeGroupPayload(group) });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
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
      : contexts.filter((context) => context.assignedStaffId === req.authUser!.id || context.createdBy === req.authUser!.id);
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

router.get("/coverage/reroute-targets", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const contexts = await listSupervisionContexts(schoolId, { activeOnly: true });
    const staffIds = [...new Set(contexts.map((context) => context.assignedStaffId).filter(Boolean))];
    const staffEntries = await Promise.all(staffIds.map(async (id) => [id, await getUserById(id)] as const));
    const staffById = new Map(staffEntries);
    return res.json({
      contexts: contexts.map((context) => {
        const staff = staffById.get(context.assignedStaffId);
        return {
          id: context.id,
          name: context.name,
          contextType: context.contextType,
          assignedStaff: staff ? {
            id: staff.id,
            displayName: staff.displayName || [staff.firstName, staff.lastName].filter(Boolean).join(" ") || staff.email,
          } : null,
          endsAt: context.endsAt,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/contexts/:id/students", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const context = await getSupervisionContextByIdAndSchool(schoolId, String(req.params.id));
    if (!context) return res.status(404).json({ error: "Coverage context not found" });
    if (!canManageContext(req, res, context)) {
      return res.status(403).json({ error: "Only admins or assigned coverage staff can view coverage students" });
    }

    const activeOnly = req.query.active !== "false";
    const rows = await listSupervisionStudentsForContexts(schoolId, [context.id], { activeOnly });
    return res.json({
      context,
      students: await contextStudentPayload(schoolId, rows),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/contexts/:id/history", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const context = await getSupervisionContextByIdAndSchool(schoolId, String(req.params.id));
    if (!context) return res.status(404).json({ error: "Coverage context not found" });
    if (!canManageContext(req, res, context)) {
      return res.status(403).json({ error: "Only admins or assigned coverage staff can view coverage history" });
    }

    const [studentRows, auditRows] = await Promise.all([
      listSupervisionStudentsForContexts(schoolId, [context.id], { activeOnly: false }),
      getAuditLogs({
        schoolId,
        entityType: "supervision_context",
        entityId: context.id,
        limit: 100,
      }),
    ]);
    const studentEvents = studentRows.flatMap((row) => {
      const assigned = {
        id: `${row.id}:assigned`,
        type: "student.assigned",
        action: "Student assigned",
        createdAt: row.assignedAt,
        actorId: row.assignedBy,
        actorEmail: null,
        studentId: row.studentId,
        studentName: studentName(row.student),
        details: { source: row.source },
      };
      if (!row.releasedAt) return [assigned];
      return [
        assigned,
        {
          id: `${row.id}:released`,
          type: "student.released",
          action: "Student released",
          createdAt: row.releasedAt,
          actorId: null,
          actorEmail: null,
          studentId: row.studentId,
          studentName: studentName(row.student),
          details: { releaseReason: row.releaseReason || "released" },
        },
      ];
    });
    const auditEvents = auditRows.map((entry: any) => ({
      id: entry.id,
      type: entry.action,
      action: entry.action,
      createdAt: entry.createdAt,
      actorId: entry.userId,
      actorEmail: entry.userEmail,
      studentId: null,
      studentName: null,
      details: entry.changes,
    }));

    const events = [...studentEvents, ...auditEvents]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 100);
    return res.json({ events });
  } catch (err) {
    next(err);
  }
});

router.post("/coverage/contexts/:id/commands", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const context = await getSupervisionContextByIdAndSchool(schoolId, String(req.params.id));
    assertActiveContext(context);
    if (!canManageContext(req, res, context)) {
      return res.status(403).json({ error: "Only admins or assigned coverage staff can command this coverage context" });
    }

    const commandType = String(req.body.commandType || "").trim();
    if (!COVERAGE_COMMAND_TYPES.has(commandType)) {
      return res.status(400).json({ error: "Unsupported coverage command type" });
    }
    const targetScope = String(req.body.targetScope || "").trim();
    if (targetScope !== "context" && targetScope !== "students") {
      return res.status(400).json({ error: "targetScope must be context or students" });
    }

    const targets = await resolveCoverageCommandTargets(schoolId, context.id, req.body);
    const result = await executeClasspilotCommand({
      schoolId,
      actorId: req.authUser!.id,
      supervisionContextId: context.id,
      targetScope,
      commandType,
      rawCommandPayload: req.body.commandPayload || {},
      targets,
      persistClassroomState: false,
    });

    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.command",
      entityType: "supervision_context",
      entityId: context.id,
      changes: {
        commandId: result.command.id,
        commandType,
        targetScope,
        targetStudentIds: targets.map((target) => target.studentId),
        summary: result.summary,
      },
    });
    return res.status(201).json(coverageCommandResponse(result));
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/coverage/contexts", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    let studentIds = normalizeStudentIds(req.body.studentIds);
    const coverageGroupId = String(req.body.coverageGroupId || "").trim();
    if (coverageGroupId) {
      const coverageGroup = await getCoverageScopeGroupByIdAndSchool(schoolId, coverageGroupId);
      if (!coverageGroup || !coverageGroup.active) {
        return res.status(404).json({ error: "Testing group not found" });
      }
      studentIds = [...new Set([...studentIds, ...(await getCoverageScopeGroupStudentIds(schoolId, coverageGroupId))])];
    }
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
      changes: { contextType, studentIds, coverageGroupId: coverageGroupId || null, assignedStaffId, endsAt, note: req.body.note ? String(req.body.note) : null },
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
    const note = String(req.body.note || req.body.reason || "").trim();
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
      changes: { studentIds, note: note || null },
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
    const studentIds = normalizeStudentIds(req.body.studentIds);
    const releaseReason = String(req.body.releaseReason || "").trim();
    if (!releaseReason) {
      return res.status(400).json({ error: "releaseReason is required" });
    }
    if (studentIds.length > 0) {
      const activeRows = await listSupervisionStudentsForContexts(schoolId, [context.id], { activeOnly: true });
      const activeStudentIds = new Set(activeRows.map((row) => row.studentId));
      if (studentIds.some((studentId) => !activeStudentIds.has(studentId))) {
        return res.status(400).json({ error: "One or more selected students are not active in this coverage context" });
      }
    }
    const released = await releaseSupervisionStudents({
      schoolId,
      contextId: context.id,
      studentIds,
      releaseReason,
    });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.context.release",
      entityType: "supervision_context",
      entityId: context.id,
      changes: {
        studentIds: studentIds.length > 0 ? studentIds : released.map((row) => row.studentId),
        releaseReason,
      },
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
    const updateChanges: Record<string, unknown> = {};
    if (endsAt) updateChanges.endsAt = endsAt;
    if (req.body.note !== undefined) updateChanges.note = String(req.body.note || "");
    if (assignedStaffId) updateChanges.assignedStaffId = assignedStaffId;
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.context.update",
      entityType: "supervision_context",
      entityId: context.id,
      changes: updateChanges,
    });
    return res.json({ context: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
