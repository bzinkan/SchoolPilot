import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import {
  assignStudentsToSupervisionContext,
  createCoverageAssignment,
  createCoverageScopeGroup,
  createSupervisionContextWithStudents,
  claimScheduledCoverageStudents,
  getActiveCoverageAssignmentsForScopeGroups,
  getActiveDirectSupervisionContextForStaff,
  getActiveSessionsForStudents,
  getActiveSupervisionForStudents,
  getActiveSupervisionContextForStaffGroup,
  extendSupervisionContext,
  getActiveCoverageAssignmentsForStaff,
  getCoverageScopeGroupByIdAndSchool,
  getCoverageScopeGroupStudentIds,
  getCoverageScopeGroupStudentIdsForGroups,
  getActiveTeachingSessionForSchool,
  getClasspilotSessionStudentRoster,
  getGroupsBySchool,
  getGroupByIdAndSchool,
  getGroupStudents,
  getGroupStudentIdsForGroups,
  getGroupTeacherIdsForGroups,
  getGroupTeachers,
  getMembershipByUserAndSchool,
  getOnlineUnassignedStudents,
  getSettingsForSchool,
  getStaffBySchool,
  getStudentById,
  getStudentsBySchool,
  getStudentsByIds,
  getScheduledClassConflictByIdAndSchool,
  getSupervisionContextByIdAndSchool,
  listCoverageAssignments,
  listCoverageScopeGroups,
  listActiveScheduledClassConflicts,
  listSupervisionContexts,
  listSupervisionStudentsForContexts,
  replaceCoverageScopeGroupMembers,
  replaceCoverageScopeGroupStaff,
  releaseSupervisionStudents,
  updateScheduledClassConflictStatus,
  updateCoverageAssignment,
  updateCoverageScopeGroup,
  type OnlineUnassignedStudent,
} from "../../services/storage.js";
import {
  hydrateClasspilotCoverageStatuses,
  type ClasspilotCoverageStatus,
} from "../../services/classpilotCoverageHydration.js";
import { publicClasspilotCommand } from "../../services/classpilotCommandPublic.js";
import {
  broadcastScheduledConflictUpdate,
  buildScheduledCoveragePayload,
} from "../../services/classpilotScheduledStart.js";
import { getAuditLogs, logAudit } from "../../services/audit.js";
import {
  COVERAGE_COMMAND_TYPES,
  executeClasspilotCommand,
  type ResolvedClasspilotCommandTarget,
} from "../../services/classpilotCommandDispatcher.js";
import { localDateInTimeZone, localDateStartUtc } from "../../util/schoolTime.js";
import { syncClasspilotControlStatesToActiveDevices } from "../../services/classpilotControlStateDelivery.js";
import {
  classpilotCoverageSummaryRevision,
  publishClasspilotCoverageSummaryUpdated,
} from "../../services/classpilotCoverageSummary.js";
import { requestHasAnySchoolRole } from "../../services/schoolAuthorization.js";
import {
  classpilotRealtimeFresh,
  readClasspilotRealtimeStatusBatch,
} from "../../services/classpilotRealtimeStatus.js";
import { isClasspilotCapabilityActive } from "../../services/classpilotProtocol.js";
import { classpilotCurrentPageSignedOutSkipReason } from "../../services/classpilotCurrentPage.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "office_staff", "teacher"),
] as const;

// Every successful coverage mutation emits one school-scoped invalidation.
// The event contains no counts because staff can have different visible scopes.
router.use("/coverage", (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  res.once("finish", () => {
    const schoolId = res.locals.schoolId as string | undefined;
    if (schoolId && res.statusCode >= 200 && res.statusCode < 300) {
      publishClasspilotCoverageSummaryUpdated(schoolId);
    }
  });
  next();
});

const COVERAGE_TYPES = new Set([
  "state_testing",
  "indoor_recess",
  "intervention",
  "office",
  "assembly",
  "other",
]);
const COVERAGE_LATE_SIGN_IN_COMMANDS = new Set([
  "lock-screen",
  "unlock-screen",
  "apply-flight-path",
  "remove-flight-path",
  "apply-block-list",
  "remove-block-list",
]);
const COVERAGE_SCOPE_TYPES = new Set(["school", "grade", "group", "students", "coverage_group", "setup"]);

function isAdmin(req: any, res: any) {
  return requestHasAnySchoolRole(req, res, ["admin", "school_admin"]);
}

function requireStaffRole(req: any, res: any): boolean {
  return requestHasAnySchoolRole(req, res, [
    "admin",
    "school_admin",
    "teacher",
    "office_staff",
  ]);
}

function assignmentAllowsClaim(assignment: any): boolean {
  const permissions = assignment?.permissions as any;
  return (
    assignment?.active !== false &&
    assignment?.scopeType !== "setup" &&
    (permissions?.claim === true || permissions?.observe === true)
  );
}

function assignmentAllowsSetup(assignment: any): boolean {
  const permissions = assignment?.permissions as any;
  return (
    assignment?.active !== false &&
    (
      (assignment?.scopeType === "setup" && permissions?.setup === true) ||
      (assignment?.scopeType !== "setup" && permissions?.setup === true)
    )
  );
}

type SetupAccess = {
  isAdmin: boolean;
  actorId?: string;
  canSetup: boolean;
  isSchoolwide: boolean;
  assignments: any[];
};

async function setupAccessForRequest(req: any, res: any): Promise<SetupAccess> {
  if (isAdmin(req, res)) {
    return { isAdmin: true, actorId: req.authUser?.id, canSetup: true, isSchoolwide: true, assignments: [] };
  }
  if (!requireStaffRole(req, res)) {
    return { isAdmin: false, canSetup: false, isSchoolwide: false, assignments: [] };
  }
  const assignments = (await getActiveCoverageAssignmentsForStaff(res.locals.schoolId!, req.authUser!.id))
    .filter(assignmentAllowsSetup);
  const isSchoolwide = assignments.some((assignment) =>
    assignment.scopeType === "setup" || assignment.scopeType === "school"
  );
  return {
    isAdmin: false,
    actorId: req.authUser!.id,
    canSetup: assignments.length > 0,
    isSchoolwide,
    assignments,
  };
}

async function canManageSupervisionSetup(req: any, res: any): Promise<boolean> {
  return (await setupAccessForRequest(req, res)).canSetup;
}

async function setupCapabilityPayload(req: any, res: any) {
  const access = await setupAccessForRequest(req, res);
  return {
    isAdmin: access.isAdmin,
    canManageSupervisionSetup: access.canSetup,
    isSchoolwideSetupManager: access.isSchoolwide,
    setupScopes: access.isAdmin ? [] : await assignmentResponse(res.locals.schoolId!, access.assignments),
  };
}

function normalizeStudentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((id) => id.trim()).filter(Boolean))];
}

function normalizeScopeValue(scopeType: string, raw: unknown): string | null {
  if (scopeType === "setup") return null;
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

function staffName(staff: any): string {
  return staff?.displayName || [staff?.firstName, staff?.lastName].filter(Boolean).join(" ").trim() || staff?.email || staff?.id || "Staff";
}

async function groupStudentSet(groupId: string): Promise<Set<string>> {
  const rows = await getGroupStudents(groupId);
  return new Set(rows.map((row) => row.studentId));
}

async function coverageGroupStudentSet(schoolId: string, coverageGroupId: string): Promise<Set<string>> {
  return new Set(await getCoverageScopeGroupStudentIds(schoolId, coverageGroupId));
}

type CoverageAssignmentScopeIndex = {
  groupStudents: Map<string, Set<string>>;
  coverageGroupStudents: Map<string, Set<string>>;
};

async function hydrateCoverageAssignmentScopeIndex(
  schoolId: string,
  assignments: any[],
  knownCoverageGroups: any[] = []
): Promise<CoverageAssignmentScopeIndex> {
  const groupIds = [...new Set(
    assignments
      .filter((assignment) => assignment.scopeType === "group" && assignment.scopeValue)
      .map((assignment) => String(assignment.scopeValue))
  )];
  const coverageGroupIds = [...new Set(
    assignments
      .filter((assignment) => assignment.scopeType === "coverage_group" && assignment.scopeValue)
      .map((assignment) => String(assignment.scopeValue))
  )];
  const knownCoverageGroupById = new Map(
    knownCoverageGroups.map((group) => [String(group.id), group])
  );
  const missingCoverageGroupIds = coverageGroupIds.filter(
    (groupId) => !knownCoverageGroupById.has(groupId)
  );
  const [groupStudents, missingCoverageStudents] = await Promise.all([
    getGroupStudentIdsForGroups(schoolId, groupIds),
    getCoverageScopeGroupStudentIdsForGroups(schoolId, missingCoverageGroupIds),
  ]);
  const coverageGroupStudents = new Map<string, Set<string>>();
  for (const groupId of coverageGroupIds) {
    const known = knownCoverageGroupById.get(groupId);
    coverageGroupStudents.set(
      groupId,
      known
        ? new Set((known.members || []).map((member: any) => String(member.studentId)))
        : missingCoverageStudents.get(groupId) || new Set()
    );
  }
  return { groupStudents, coverageGroupStudents };
}

function assignmentCoversStudentFromIndex(
  assignment: any,
  student: any,
  index: CoverageAssignmentScopeIndex
): boolean {
  if (assignment.scopeType === "setup") return false;
  if (assignment.scopeType === "school") return true;
  if (
    assignment.scopeType === "grade" &&
    String(student.gradeLevel || "") === String(assignment.scopeValue || "")
  ) return true;
  if (assignment.scopeType === "students") {
    const ids = String(assignment.scopeValue || "").split(",").map((id) => id.trim()).filter(Boolean);
    return ids.includes(student.id);
  }
  if (assignment.scopeType === "group" && assignment.scopeValue) {
    return index.groupStudents.get(String(assignment.scopeValue))?.has(student.id) === true;
  }
  if (assignment.scopeType === "coverage_group" && assignment.scopeValue) {
    return index.coverageGroupStudents.get(String(assignment.scopeValue))?.has(student.id) === true;
  }
  return false;
}

function matchingDirectAssignmentsForStudentFromIndex(
  assignments: any[],
  student: any,
  index: CoverageAssignmentScopeIndex
) {
  return assignments.filter((assignment) =>
    assignmentAllowsClaim(assignment) &&
    assignment.scopeType !== "coverage_group" &&
    assignment.scopeType !== "setup" &&
    assignmentCoversStudentFromIndex(assignment, student, index)
  );
}

async function filterRowsByAssignments(rows: OnlineUnassignedStudent[], assignments: any[]) {
  if (rows.length === 0) return [];
  const index = await hydrateCoverageAssignmentScopeIndex(
    rows[0]!.student.schoolId,
    assignments
  );
  return rows.filter((row) => assignments.some((assignment) =>
    assignmentAllowsClaim(assignment) &&
    assignmentCoversStudentFromIndex(assignment, row.student, index)
  ));
}

async function assertStudentsInSchool(schoolId: string, studentIds: string[]) {
  const uniqueIds = [...new Set(studentIds.map(String).filter(Boolean))];
  const loaded = await getStudentsByIds(uniqueIds);
  const byId = new Map(loaded.map((student) => [student.id, student]));
  if (
    loaded.length !== uniqueIds.length ||
    loaded.some((student) => student.schoolId !== schoolId)
  ) {
    const err: any = new Error("One or more students are not in this school");
    err.status = 400;
    throw err;
  }
  return uniqueIds.map((id) => byId.get(id)!);
}

async function assertActiveStudentsInSchool(schoolId: string, studentIds: string[]) {
  const schoolStudents = await assertStudentsInSchool(schoolId, studentIds);
  if (schoolStudents.some((student) => student.status !== "active")) {
    throw Object.assign(new Error("One or more students are not active in this school"), {
      status: 400,
      code: "CLASSPILOT_STUDENT_INACTIVE",
    });
  }
  return schoolStudents;
}

async function assertValidAssignmentScope(schoolId: string, scopeType: string, rawScopeValue: unknown) {
  if (!COVERAGE_SCOPE_TYPES.has(scopeType)) {
    throw Object.assign(new Error("A valid coverage scope is required"), { status: 400 });
  }
  const scopeValue = normalizeScopeValue(scopeType, rawScopeValue);
  if (scopeType === "setup") return null;
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
    await assertActiveStudentsInSchool(schoolId, scopeValue!.split(",").map((id) => id.trim()).filter(Boolean));
  }
  return scopeValue;
}

async function assertStudentsWithinSetupAccess(
  schoolId: string,
  access: SetupAccess,
  studentIds: string[]
) {
  const students = await assertActiveStudentsInSchool(schoolId, studentIds);
  if (access.isAdmin || access.isSchoolwide) return students;
  const index = await hydrateCoverageAssignmentScopeIndex(schoolId, access.assignments);
  for (const student of students) {
    if (!access.assignments.some((assignment) =>
      assignmentCoversStudentFromIndex(assignment, student, index)
    )) {
      throw Object.assign(new Error("One or more students are outside your setup scope"), { status: 403 });
    }
  }
  return students;
}

async function assignmentScopeWithinSetupAccess(
  schoolId: string,
  access: SetupAccess,
  scopeType: string,
  scopeValue: string | null
): Promise<boolean> {
  if (access.isAdmin || access.isSchoolwide) return true;
  if (scopeType === "setup" || scopeType === "school") return false;
  if (scopeType === "grade") {
    return access.assignments.some((assignment) =>
      assignment.scopeType === "grade" &&
      String(assignment.scopeValue || "") === String(scopeValue || "")
    );
  }
  if (scopeType === "students") {
    const studentIds = String(scopeValue || "").split(",").map((id) => id.trim()).filter(Boolean);
    try {
      await assertStudentsWithinSetupAccess(schoolId, access, studentIds);
      return true;
    } catch {
      return false;
    }
  }
  if (scopeType === "group" && scopeValue) {
    const group = await getGroupByIdAndSchool(scopeValue, schoolId);
    if (!group) return false;
    const members = await groupStudentSet(scopeValue);
    if (members.size === 0 && group.gradeLevel) {
      return assignmentScopeWithinSetupAccess(schoolId, access, "grade", String(group.gradeLevel));
    }
    return allStudentIdsWithinSetupAccess(schoolId, access, Array.from(members));
  }
  if (scopeType === "coverage_group" && scopeValue) {
    const members = await coverageGroupStudentSet(schoolId, scopeValue);
    return allStudentIdsWithinSetupAccess(schoolId, access, Array.from(members));
  }
  return false;
}

async function allStudentIdsWithinSetupAccess(
  schoolId: string,
  access: SetupAccess,
  studentIds: string[]
): Promise<boolean> {
  if (studentIds.length === 0) return access.isAdmin || access.isSchoolwide;
  try {
    await assertStudentsWithinSetupAccess(schoolId, access, studentIds);
    return true;
  } catch {
    return false;
  }
}

async function filterStudentsBySetupAccess(schoolId: string, access: SetupAccess, students: any[]) {
  if (access.isAdmin || access.isSchoolwide) return students;
  const index = await hydrateCoverageAssignmentScopeIndex(schoolId, access.assignments);
  return students.filter((student) => access.assignments.some((assignment) =>
    assignmentCoversStudentFromIndex(assignment, student, index)
  ));
}

async function filterClassesBySetupAccess(schoolId: string, access: SetupAccess, groups: any[]) {
  if (access.isAdmin || access.isSchoolwide) return groups;
  const [classMembers, accessIndex] = await Promise.all([
    getGroupStudentIdsForGroups(schoolId, groups.map((group) => group.id)),
    hydrateCoverageAssignmentScopeIndex(schoolId, access.assignments),
  ]);
  const memberStudents = await getStudentsByIds(
    [...new Set([...classMembers.values()].flatMap((members) => [...members]))]
  );
  const studentsById = new Map(
    memberStudents
      .filter((student) => student.schoolId === schoolId)
      .map((student) => [student.id, student])
  );
  return groups.filter((group) => {
    const memberIds = [...(classMembers.get(group.id) || [])];
    if (memberIds.length === 0) {
      return Boolean(group.gradeLevel) && access.assignments.some((assignment) =>
        assignment.scopeType === "grade" &&
        String(assignment.scopeValue || "") === String(group.gradeLevel)
      );
    }
    return memberIds.every((studentId) => {
      const student = studentsById.get(studentId);
      return Boolean(student) && access.assignments.some((assignment) =>
        assignmentCoversStudentFromIndex(assignment, student, accessIndex)
      );
    });
  });
}

async function filterSupervisionGroupsBySetupAccess(schoolId: string, access: SetupAccess, groups: any[]) {
  if (access.isAdmin || access.isSchoolwide) return groups;
  const index = await hydrateCoverageAssignmentScopeIndex(
    schoolId,
    access.assignments,
    groups
  );
  return groups.filter((group) => {
    const members = group.members || [];
    if (members.length === 0) return group.createdBy === access.actorId;
    return members.every((member: any) => access.assignments.some((assignment) =>
      assignmentCoversStudentFromIndex(assignment, member.student, index)
    ));
  });
}

async function canManageSupervisionGroupWithinSetupAccess(
  schoolId: string,
  access: SetupAccess,
  groupId: string
) {
  if (await assignmentScopeWithinSetupAccess(schoolId, access, "coverage_group", groupId)) return true;
  const group = await getCoverageScopeGroupByIdAndSchool(schoolId, groupId);
  return !!group && (group.members || []).length === 0 && group.createdBy === access.actorId;
}

function normalizeAssignmentPermissions(scopeType: string, rawPermissions: any = undefined) {
  if (scopeType === "setup") return { setup: true };
  const hasExplicitPermissions = rawPermissions && typeof rawPermissions === "object";
  const wantsClaim = hasExplicitPermissions
    ? rawPermissions.claim === true || rawPermissions.observe === true
    : true;
  const wantsSetup = hasExplicitPermissions && rawPermissions.setup === true;
  const permissions: any = {};
  if (wantsClaim) {
    permissions.observe = true;
    permissions.claim = true;
  }
  if (wantsSetup) permissions.setup = true;
  return permissions;
}

function assignmentHasAnyPermission(permissions: any) {
  return permissions?.claim === true || permissions?.observe === true || permissions?.setup === true;
}

async function assertActorCanWriteAssignment(
  req: any,
  res: any,
  scopeType: string,
  scopeValue: string | null,
  permissions: any
) {
  if (isAdmin(req, res)) return;
  const access = await setupAccessForRequest(req, res);
  if (!access.canSetup) {
    throw Object.assign(new Error("Setup permission required"), { status: 403 });
  }
  if (permissions?.setup === true || scopeType === "setup") {
    throw Object.assign(new Error("Only admins can grant setup access"), { status: 403 });
  }
  if (!(await assignmentScopeWithinSetupAccess(res.locals.schoolId!, access, scopeType, scopeValue))) {
    throw Object.assign(new Error("Assignment is outside your setup scope"), { status: 403 });
  }
}

async function assignmentResponse(schoolId: string, assignments: any[]) {
  const [staffRows, classGroups, coverageGroups] = await Promise.all([
    getStaffBySchool(schoolId),
    assignments.some((assignment) => assignment.scopeType === "group")
      ? getGroupsBySchool(schoolId)
      : Promise.resolve([]),
    assignments.some((assignment) => assignment.scopeType === "coverage_group")
      ? listCoverageScopeGroups(schoolId, { activeOnly: false })
      : Promise.resolve([]),
  ]);
  const staffById = new Map(staffRows.map((row) => [row.userId, row.user]));
  const classGroupById = new Map(classGroups.map((group) => [group.id, group]));
  const coverageGroupById = new Map(coverageGroups.map((group) => [group.id, group]));

  return assignments.map((assignment) => {
    const staff = staffById.get(assignment.staffId);
    const permissions = assignment.permissions as any;
    const claimPermission = assignmentAllowsClaim(assignment);
    const setupPermission = assignmentAllowsSetup(assignment);
    let scopeLabel = "Schoolwide";
    let scopeDetail: any = null;
    if (assignment.scopeType === "setup") {
      scopeLabel = "Setup Manager";
    } else if (assignment.scopeType === "grade") {
      scopeLabel = `Roster Grade: ${assignment.scopeValue}`;
    } else if (assignment.scopeType === "group") {
      const group = assignment.scopeValue
        ? classGroupById.get(String(assignment.scopeValue))
        : null;
      scopeLabel = group?.name ? `Class: ${group.name}` : "Class";
      scopeDetail = group ? { id: group.id, name: group.name } : null;
    } else if (assignment.scopeType === "coverage_group") {
      const group = assignment.scopeValue
        ? coverageGroupById.get(String(assignment.scopeValue))
        : null;
      scopeLabel = group?.name ? `Supervision Group: ${group.name}` : "Supervision Group";
      scopeDetail = group ? { id: group.id, name: group.name, studentCount: group.members.length } : null;
    } else if (assignment.scopeType === "students") {
      const ids = String(assignment.scopeValue || "").split(",").map((id) => id.trim()).filter(Boolean);
      scopeLabel = `${ids.length} selected student${ids.length === 1 ? "" : "s"}`;
      scopeDetail = { studentIds: ids };
    }
    const permissionLabels = [
      claimPermission ? "Claim + Manage" : null,
      setupPermission ? "Manage Supervision Setup" : null,
    ].filter(Boolean);

    return {
      ...assignment,
      permissions,
      abilities: {
        claim: claimPermission,
        setup: setupPermission,
      },
      permissionLabel: permissionLabels.join(" + ") || "No active abilities",
      scopeLabel,
      scopeDetail,
      staff: staff ? {
        id: staff.id,
        email: staff.email,
        displayName: staff.displayName || [staff.firstName, staff.lastName].filter(Boolean).join(" ") || staff.email,
      } : null,
    };
  });
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

async function assignmentScopeLabels(
  schoolId: string,
  assignments: any[],
  knownCoverageGroups: any[] = []
): Promise<Map<string, string>> {
  const needsClassGroups = assignments.some((assignment) => assignment.scopeType === "group");
  const missingCoverageGroupIds = new Set(
    assignments
      .filter((assignment) => assignment.scopeType === "coverage_group" && assignment.scopeValue)
      .map((assignment) => String(assignment.scopeValue))
  );
  for (const group of knownCoverageGroups) missingCoverageGroupIds.delete(String(group.id));
  const [classGroups, additionalCoverageGroups] = await Promise.all([
    needsClassGroups ? getGroupsBySchool(schoolId) : Promise.resolve([]),
    missingCoverageGroupIds.size > 0
      ? listCoverageScopeGroups(schoolId, { activeOnly: false })
      : Promise.resolve([]),
  ]);
  const classGroupById = new Map(classGroups.map((group) => [group.id, group]));
  const coverageGroupById = new Map(
    [...knownCoverageGroups, ...additionalCoverageGroups].map((group) => [String(group.id), group])
  );
  return new Map(assignments.map((assignment) => {
    let label = "Schoolwide";
    if (assignment.scopeType === "setup") label = "Setup Manager";
    else if (assignment.scopeType === "grade") label = `Roster Grade: ${assignment.scopeValue}`;
    else if (assignment.scopeType === "group") {
      const group = classGroupById.get(String(assignment.scopeValue));
      label = group?.name ? `Class: ${group.name}` : "Class";
    } else if (assignment.scopeType === "coverage_group") {
      const group = coverageGroupById.get(String(assignment.scopeValue));
      label = group?.name ? `Supervision Group: ${group.name}` : "Supervision Group";
    } else if (assignment.scopeType === "students") {
      const count = String(assignment.scopeValue || "").split(",").map((id) => id.trim()).filter(Boolean).length;
      label = `${count} selected student${count === 1 ? "" : "s"}`;
    }
    return [assignment.id, label] as const;
  }));
}

async function supervisionGroupPayloads(
  schoolId: string,
  groups: any[],
  options: { includeStudents?: boolean } = {}
) {
  const groupIds = groups.map((group) => String(group.id));
  const [allAssignments, staffRows] = await Promise.all([
    getActiveCoverageAssignmentsForScopeGroups(schoolId, groupIds),
    getStaffBySchool(schoolId),
  ]);
  const staffById = new Map(staffRows.map((row) => [row.userId, row.user]));
  const assignmentsByGroup = new Map<string, any[]>();
  for (const assignment of allAssignments.filter(assignmentAllowsClaim)) {
    const groupId = String(assignment.scopeValue || "");
    const list = assignmentsByGroup.get(groupId) || [];
    list.push(assignment);
    assignmentsByGroup.set(groupId, list);
  }
  return groups.map((group) => ({
    id: group.id,
    schoolId: group.schoolId,
    name: group.name,
    description: group.description,
    active: group.active,
    createdBy: group.createdBy,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    studentCount: group.members.length,
    students: options.includeStudents === false
      ? undefined
      : group.members.map((member: any) => ({
          studentId: member.studentId,
          studentName: studentName(member.student),
          studentEmail: member.student.email || undefined,
          gradeLevel: member.student.gradeLevel || undefined,
        })),
    staff: (assignmentsByGroup.get(String(group.id)) || []).flatMap((assignment) => {
      const staff = staffById.get(assignment.staffId);
      return staff ? [{
        id: staff.id,
        email: staff.email,
        displayName: staffName(staff),
        assignmentId: assignment.id,
      }] : [];
    }),
  }));
}

async function supervisionGroupPayload(
  schoolId: string,
  group: any,
  options: { includeStudents?: boolean } = {}
) {
  return (await supervisionGroupPayloads(schoolId, [group], options))[0]!;
}

function groupContainsStudent(group: any, studentId: string): boolean {
  return (group.members || []).some((member: any) => member.studentId === studentId);
}

async function activeCoverageGroupIdsForStaff(
  schoolId: string,
  staffId: string,
  assignments?: any[]
): Promise<Set<string>> {
  const activeAssignments = assignments ??
    await getActiveCoverageAssignmentsForStaff(schoolId, staffId);
  return new Set(
    activeAssignments
      .filter((assignment) => assignmentAllowsClaim(assignment) && assignment.scopeType === "coverage_group" && assignment.scopeValue)
      .map((assignment) => assignment.scopeValue!)
  );
}

async function visibleSupervisionGroupsForRequest(
  req: any,
  res: any,
  includeInactive = false,
  activeAssignments?: any[]
) {
  const schoolId = res.locals.schoolId!;
  const groups = await listCoverageScopeGroups(schoolId, { activeOnly: !includeInactive });
  if (isAdmin(req, res)) return groups;
  const allowedGroupIds = await activeCoverageGroupIdsForStaff(
    schoolId,
    req.authUser!.id,
    activeAssignments
  );
  return groups.filter((group) => allowedGroupIds.has(group.id));
}

function setupStaffPayload(rows: any[]) {
  return rows.map((row) => ({
    membershipId: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
    email: row.user?.email || "",
    displayName: staffName(row.user),
    user: row.user
      ? {
          id: row.user.id,
          email: row.user.email,
          displayName: staffName(row.user),
          firstName: row.user.firstName,
          lastName: row.user.lastName,
        }
      : null,
  }));
}

function setupStudentPayload(rows: any[]) {
  return rows.map((student) => ({
    id: student.id,
    studentId: student.id,
    studentName: studentName(student),
    studentEmail: student.email || undefined,
    email: student.email || undefined,
    gradeLevel: student.gradeLevel || undefined,
    firstName: student.firstName || undefined,
    lastName: student.lastName || undefined,
  }));
}

function setupClassPayload(rows: any[]) {
  return rows.map((group) => ({
    id: group.id,
    name: group.name,
    gradeLevel: group.gradeLevel || undefined,
    groupType: group.groupType,
    status: group.status,
  }));
}

function coverageStatusPayload(status: ClasspilotCoverageStatus) {
  return {
    status: status.status,
    lastSeenAt: status.lastSeenAt,
    activeTabTitle: status.activeTabTitle,
    activeTabUrl: status.activeTabUrl,
    allOpenTabs: status.allOpenTabs,
    screenshotHealth: status.screenshotHealth,
    tabSnapshot: status.tabSnapshot,
    tabSnapshotRevision: status.tabSnapshotRevision,
    extensionVersion: status.extensionVersion,
    capabilities: status.capabilities,
  };
}

function availableStudentPayload(
  row: OnlineUnassignedStudent,
  matchingGroups: any[],
  matchingAssignments: any[],
  status: ClasspilotCoverageStatus,
  assignmentLabels: Map<string, string>
) {
  const matchingScopes = matchingAssignments.map((assignment) => ({
    id: assignment.id,
    name: assignmentLabels.get(assignment.id) || "Assigned students",
    scopeType: assignment.scopeType,
  }));
  return {
    studentId: row.student.id,
    studentName: studentName(row.student),
    studentEmail: row.student.email || undefined,
    gradeLevel: row.student.gradeLevel || undefined,
    isLoggedIn: true,
    loginState: "logged_in",
    supervisionState: "available",
    supervisionContext: null,
    ...coverageStatusPayload(status),
    matchingGroups: matchingGroups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description || undefined,
    })),
    matchingScopes,
  };
}

function scheduledCoverageStudentPayload(
  student: any,
  scheduledCoverage: { id: string; className: string; teacherName: string },
  status: ClasspilotCoverageStatus
) {
  return {
    studentId: student.id,
    studentName: studentName(student),
    studentEmail: student.email || undefined,
    gradeLevel: student.gradeLevel || undefined,
    isLoggedIn: true,
    loginState: "logged_in",
    supervisionState: "available",
    supervisionContext: null,
    ...coverageStatusPayload(status),
    matchingGroups: [],
    matchingScopes: [],
    matchingScheduledCoverage: scheduledCoverage,
  };
}

async function scheduledCoverageGroupsForRequest(
  req: any,
  res: any,
  activeAssignments: any[],
  knownAssignmentIndex?: CoverageAssignmentScopeIndex
) {
  const schoolId = res.locals.schoolId!;
  const conflicts = await listActiveScheduledClassConflicts(schoolId);
  const schoolGroups = conflicts.length > 0 ? await getGroupsBySchool(schoolId) : [];
  const groupById = new Map(schoolGroups.map((group) => [group.id, group]));
  const teacherIdsByGroup = isAdmin(req, res)
    ? new Map<string, Set<string>>()
    : await getGroupTeacherIdsForGroups(
        schoolId,
        conflicts.map((conflict) => conflict.groupId)
      );
  const assignmentIndex = knownAssignmentIndex ??
    await hydrateCoverageAssignmentScopeIndex(schoolId, activeAssignments);
  const drafts: Array<{
    conflict: (typeof conflicts)[number];
    scheduledPayload: Awaited<ReturnType<typeof buildScheduledCoveragePayload>>;
    scheduledCoverage: { id: string; className: string; teacherName: string };
    visibleStudentRows: any[];
    teacherName: string;
  }> = [];
  for (const conflict of conflicts) {
    const group = groupById.get(conflict.groupId);
    if (!group) continue;
    const scheduledPayload = await buildScheduledCoveragePayload({
      group,
      scheduledDate: conflict.scheduledDate,
      scheduledConflictId: conflict.id,
    });
    const teacherName = scheduledPayload.scheduledTeacher.displayName;
    const scheduledCoverage = {
      id: conflict.id,
      className: scheduledPayload.selectedClass.name,
      teacherName,
    };
    const claimableStudents = await getStudentsByIds(
      scheduledPayload.claimableStudents.map((entry) => entry.studentId)
    );
    const studentById = new Map(
      claimableStudents
        .filter((student) => student.schoolId === schoolId)
        .map((student) => [student.id, student])
    );
    const groupTeacher = teacherIdsByGroup.get(conflict.groupId)?.has(req.authUser!.id) === true;
    const visibleStudentRows = scheduledPayload.claimableStudents.flatMap((entry) => {
      const student = studentById.get(entry.studentId);
      if (!student) return [];
      const allowed =
        isAdmin(req, res) ||
        conflict.teacherId === req.authUser!.id ||
        groupTeacher ||
        activeAssignments.some((assignment) =>
          assignmentAllowsClaim(assignment) &&
          assignmentCoversStudentFromIndex(assignment, student, assignmentIndex)
        );
      return allowed ? [student] : [];
    });
    if (visibleStudentRows.length === 0) continue;
    drafts.push({
      conflict,
      scheduledPayload,
      scheduledCoverage,
      visibleStudentRows,
      teacherName,
    });
  }
  const scheduledStudentIds = drafts.flatMap((draft) =>
    draft.visibleStudentRows.map((student) => student.id)
  );
  const statuses = scheduledStudentIds.length > 0
    ? await hydrateClasspilotCoverageStatuses({ schoolId, studentIds: scheduledStudentIds })
    : new Map<string, ClasspilotCoverageStatus>();
  return drafts.map((draft) => {
    const visibleStudents = draft.visibleStudentRows.map((student) =>
      scheduledCoverageStudentPayload(
        student,
        draft.scheduledCoverage,
        statuses.get(student.id)!
      )
    );
    return {
      id: draft.conflict.id,
      kind: "scheduled_coverage",
      label: `Scheduled Supervision Needed: ${draft.scheduledPayload.selectedClass.name}`,
      className: draft.scheduledPayload.selectedClass.name,
      teacherName: draft.teacherName,
      scheduledTeacher: draft.scheduledPayload.scheduledTeacher,
      scheduledDate: draft.conflict.scheduledDate,
      blockStartTime: draft.conflict.blockStartTime,
      blockEndTime: draft.conflict.blockEndTime,
      canStartClass: isAdmin(req, res) || draft.conflict.teacherId === req.authUser!.id,
      claimableCount: visibleStudents.length,
      totalClaimableCount: draft.scheduledPayload.claimableCount,
      monitoredCount: draft.scheduledPayload.monitoredCount,
      claimedCount: draft.scheduledPayload.claimedCount,
      students: visibleStudents,
    };
  });
}

async function defaultClaimEndsAt(schoolId: string): Promise<Date> {
  const fallback = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const settings = await getSettingsForSchool(schoolId);
  const endTime = settings?.trackingEndTime || "";
  const match = /^(\d{1,2}):(\d{2})$/.exec(endTime);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) return fallback;
  const timeZone = settings?.schoolTimezone || "America/New_York";
  const localDate = localDateInTimeZone(new Date(), timeZone);
  const dayStart = localDateStartUtc(localDate, timeZone);
  const claimEnd = new Date(dayStart.getTime() + (hours * 60 + minutes) * 60 * 1000);
  return claimEnd > new Date() ? claimEnd : fallback;
}

function coverageCommandResponse(result: any) {
  const command = result.command ? publicClasspilotCommand(result.command) : result.command;
  return { ...result, command };
}

async function contextResponse(schoolId: string, contexts: any[], includeStudentsFor: (context: any) => boolean) {
  const contextIds = contexts.map((context) => context.id);
  const [staffRows, allStudents] = await Promise.all([
    getStaffBySchool(schoolId),
    listSupervisionStudentsForContexts(schoolId, contextIds, { activeOnly: true }),
  ]);
  const staffById = new Map(staffRows.map((row) => [row.userId, row.user]));
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
  return isAdmin(req, res) || context.assignedStaffId === req.authUser!.id;
}

function assertActiveContext(context: any): asserts context {
  if (!context || context.status !== "active" || context.endsAt <= new Date()) {
    throw Object.assign(new Error("Active coverage context not found"), { status: 404 });
  }
}

async function contextStudentPayload(schoolId: string, rows: any[]) {
  const statuses = await hydrateClasspilotCoverageStatuses({
    schoolId,
    studentIds: rows.map((row) => row.studentId),
  });
  const payload = [];
  for (const row of rows) {
    const status = statuses.get(row.studentId)!;
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
      ...coverageStatusPayload(status),
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

  await assertActiveStudentsInSchool(
    schoolId,
    selectedRows.map((row) => row.studentId)
  );

  const commandType = String(body.commandType || "").trim();
  const currentPageWaypoint = commandType === "lock-screen"
    && String(body.commandPayload?.url || "").trim() === "CURRENT_URL";
  const lateSignInAuthoring = isClasspilotCapabilityActive(
    "lateSignInRestrictionSsoV1",
    { schoolId }
  ) && COVERAGE_LATE_SIGN_IN_COMMANDS.has(commandType) && !currentPageWaypoint;
  const sessions = await getActiveSessionsForStudents(
    schoolId,
    selectedRows.map((row) => row.studentId)
  );
  const sessionsByStudent = new Map<string, (typeof sessions)[number]>();
  for (const session of sessions) {
    const current = sessionsByStudent.get(session.studentId);
    if (!current || session.lastSeenAt > current.lastSeenAt) {
      sessionsByStudent.set(session.studentId, session);
    }
  }
  const realtime = await readClasspilotRealtimeStatusBatch(
    schoolId,
    [...sessionsByStudent.values()].map((session) => ({
      studentId: session.studentId,
      studentSessionId: session.id,
      deviceId: session.deviceId,
    }))
  );
  const targets: ResolvedClasspilotCommandTarget[] = [];
  for (const row of selectedRows) {
    const session = sessionsByStudent.get(row.studentId);
    const read = realtime.get(row.studentId);
    const snapshot = read?.status === "hit" ? read.snapshot : null;
    const active = !!session && !!snapshot && classpilotRealtimeFresh(snapshot);
    const explicitlySignedOut = !session;
    const deferredAuthorized = explicitlySignedOut && lateSignInAuthoring;
    targets.push({
      studentId: row.studentId,
      studentName: studentName(row.student),
      studentSessionId: active ? session!.id : null,
      deviceId: active ? session!.deviceId : null,
      available: active,
      stateAuthorized: active || deferredAuthorized,
      lateSignInEligible: deferredAuthorized,
      unavailableReason: active
        ? undefined
        : explicitlySignedOut
          ? currentPageWaypoint
            ? classpilotCurrentPageSignedOutSkipReason({
                currentPageRequested: currentPageWaypoint,
                explicitlySignedOut,
              })
            : deferredAuthorized
              ? "Restriction will apply after sign-in"
              : "Student is not signed in to the extension"
          : "Student signal is unavailable; restriction was not changed",
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
    const statuses = await hydrateClasspilotCoverageStatuses({
      schoolId,
      studentIds: visibleRows.map((row) => row.student.id),
      knownSessions: visibleRows.map((row) => row.studentSession),
    });
    const students = visibleRows.map((row) => ({
      studentId: row.student.id,
      studentName: studentName(row.student),
      studentEmail: row.student.email || undefined,
      gradeLevel: row.student.gradeLevel || undefined,
      isLoggedIn: true,
      loginState: "logged_in",
      supervisionState: "online_unassigned",
      supervisionContext: null,
      deviceCount: 1,
      ...coverageStatusPayload(statuses.get(row.student.id)!),
    }));
    return res.json({ students });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/summary", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const admin = isAdmin(req, res);
    const [contexts, unassigned, assignments] = await Promise.all([
      listSupervisionContexts(schoolId, { activeOnly: true }),
      getOnlineUnassignedStudents(schoolId),
      admin
        ? Promise.resolve([])
        : getActiveCoverageAssignmentsForStaff(schoolId, req.authUser!.id),
    ]);
    const visibleContexts = admin
      ? contexts
      : contexts.filter((context) => context.assignedStaffId === req.authUser!.id);
    const visibleUnassigned = admin
      ? unassigned
      : await filterRowsByAssignments(unassigned, assignments);
    const claimedRows = await listSupervisionStudentsForContexts(
      schoolId,
      visibleContexts.map((context) => context.id),
      { activeOnly: true }
    );
    const availableStudentIds = visibleUnassigned.map((row) => row.student.id);
    const claimedStudentIds = claimedRows.map((row) => row.studentId);
    return res.json({
      revision: classpilotCoverageSummaryRevision({
        availableStudentIds,
        claimedStudentIds,
        contexts: visibleContexts,
      }),
      availableStudentCount: new Set(availableStudentIds).size,
      claimedStudentCount: new Set(claimedStudentIds).size,
      activeContextCount: visibleContexts.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/capabilities", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    return res.json(await setupCapabilityPayload(req, res));
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/setup/staff", ...auth, async (req, res, next) => {
  try {
    if (!(await canManageSupervisionSetup(req, res))) return res.status(403).json({ error: "Setup permission required" });
    const staff = await getStaffBySchool(res.locals.schoolId!);
    return res.json({ users: setupStaffPayload(staff) });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/setup/students", ...auth, async (req, res, next) => {
  try {
    const access = await setupAccessForRequest(req, res);
    if (!access.canSetup) return res.status(403).json({ error: "Setup permission required" });
    const students = await filterStudentsBySetupAccess(
      res.locals.schoolId!,
      access,
      await getStudentsBySchool(res.locals.schoolId!)
    );
    return res.json({ students: setupStudentPayload(students) });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/setup/classes", ...auth, async (req, res, next) => {
  try {
    const access = await setupAccessForRequest(req, res);
    if (!access.canSetup) return res.status(403).json({ error: "Setup permission required" });
    const groups = await filterClassesBySetupAccess(
      res.locals.schoolId!,
      access,
      await getGroupsBySchool(res.locals.schoolId!)
    );
    return res.json({ groups: setupClassPayload(groups) });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/assignments", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    if (!isAdmin(req, res)) return res.status(403).json({ error: "Admin access required" });
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
    const permissions = normalizeAssignmentPermissions(scopeType, req.body.permissions);
    if (!assignmentHasAnyPermission(permissions)) {
      return res.status(400).json({ error: "At least one permission is required" });
    }
    await assertActorCanWriteAssignment(req, res, scopeType, scopeValue, permissions);

    const assignment = await createCoverageAssignment({
      schoolId,
      staffId,
      scopeType: scopeType as any,
      scopeValue,
      permissions,
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
    const permissions = req.body.permissions === undefined
      ? existing.permissions
      : normalizeAssignmentPermissions(nextScopeType, req.body.permissions);
    if (!assignmentHasAnyPermission(permissions)) {
      return res.status(400).json({ error: "At least one permission is required" });
    }
    await assertActorCanWriteAssignment(req, res, nextScopeType, scopeValue, permissions);

    const assignment = await updateCoverageAssignment(schoolId, assignmentId, {
      staffId: nextStaffId,
      scopeType: nextScopeType as any,
      scopeValue,
      permissions,
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
    await assertActiveStudentsInSchool(schoolId, studentIds);
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
    await assertActiveStudentsInSchool(schoolId, studentIds);
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

router.get("/coverage/supervision-groups", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const access = await setupAccessForRequest(req, res);
    const groups = access.canSetup
      ? await filterSupervisionGroupsBySetupAccess(
          schoolId,
          access,
          await listCoverageScopeGroups(schoolId, { activeOnly: req.query.active === "true" })
        )
      : await visibleSupervisionGroupsForRequest(req, res);
    const payload = await supervisionGroupPayloads(
      schoolId,
      groups,
      { includeStudents: access.canSetup }
    );
    return res.json({ groups: payload });
  } catch (err) {
    next(err);
  }
});

router.post("/coverage/supervision-groups", ...auth, async (req, res, next) => {
  try {
    const access = await setupAccessForRequest(req, res);
    if (!access.canSetup) return res.status(403).json({ error: "Setup permission required" });
    const schoolId = res.locals.schoolId!;
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const studentIds = normalizeStudentIds(req.body.studentIds);
    const staffIds = normalizeStudentIds(req.body.staffIds);
    await assertStudentsWithinSetupAccess(schoolId, access, studentIds);
    for (const staffId of staffIds) {
      const membership = await getMembershipByUserAndSchool(staffId, schoolId);
      if (!membership || membership.status !== "active") {
        return res.status(404).json({ error: "One or more staff members were not found in this school" });
      }
    }
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
    await replaceCoverageScopeGroupStaff({ schoolId, groupId: group.id, staffIds, createdBy: req.authUser!.id });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.supervision_group.create",
      entityType: "coverage_scope_group",
      entityId: group.id,
      changes: { name, studentIds, staffIds },
    });
    const refreshed = await getCoverageScopeGroupByIdAndSchool(schoolId, group.id);
    return res.status(201).json({ group: await supervisionGroupPayload(schoolId, refreshed || group) });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch("/coverage/supervision-groups/:id", ...auth, async (req, res, next) => {
  try {
    const access = await setupAccessForRequest(req, res);
    if (!access.canSetup) return res.status(403).json({ error: "Setup permission required" });
    const schoolId = res.locals.schoolId!;
    const groupId = String(req.params.id);
    if (!(await canManageSupervisionGroupWithinSetupAccess(schoolId, access, groupId))) {
      return res.status(403).json({ error: "Supervision group is outside your setup scope" });
    }
    const data: { name?: string; description?: string | null; active?: boolean } = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name is required" });
      data.name = name;
    }
    if (req.body.description !== undefined) data.description = String(req.body.description || "");
    if (req.body.active !== undefined) data.active = req.body.active !== false;
    const group = await updateCoverageScopeGroup({ schoolId, groupId, ...data });
    if (!group) return res.status(404).json({ error: "Supervision group not found" });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.supervision_group.update",
      entityType: "coverage_scope_group",
      entityId: group.id,
      changes: data,
    });
    return res.json({ group: await supervisionGroupPayload(schoolId, group) });
  } catch (err) {
    next(err);
  }
});

router.put("/coverage/supervision-groups/:id/students", ...auth, async (req, res, next) => {
  try {
    const access = await setupAccessForRequest(req, res);
    if (!access.canSetup) return res.status(403).json({ error: "Setup permission required" });
    const schoolId = res.locals.schoolId!;
    const groupId = String(req.params.id);
    if (!(await canManageSupervisionGroupWithinSetupAccess(schoolId, access, groupId))) {
      return res.status(403).json({ error: "Supervision group is outside your setup scope" });
    }
    const studentIds = normalizeStudentIds(req.body.studentIds);
    await assertStudentsWithinSetupAccess(schoolId, access, studentIds);
    const group = await replaceCoverageScopeGroupMembers({ schoolId, groupId, studentIds });
    if (!group) return res.status(404).json({ error: "Supervision group not found" });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.supervision_group.students.update",
      entityType: "coverage_scope_group",
      entityId: group.id,
      changes: { studentIds },
    });
    return res.json({ group: await supervisionGroupPayload(schoolId, group) });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put("/coverage/supervision-groups/:id/staff", ...auth, async (req, res, next) => {
  try {
    const access = await setupAccessForRequest(req, res);
    if (!access.canSetup) return res.status(403).json({ error: "Setup permission required" });
    const schoolId = res.locals.schoolId!;
    const groupId = String(req.params.id);
    if (!(await canManageSupervisionGroupWithinSetupAccess(schoolId, access, groupId))) {
      return res.status(403).json({ error: "Supervision group is outside your setup scope" });
    }
    const group = await getCoverageScopeGroupByIdAndSchool(schoolId, groupId);
    if (!group) return res.status(404).json({ error: "Supervision group not found" });
    const staffIds = normalizeStudentIds(req.body.staffIds);
    for (const staffId of staffIds) {
      const membership = await getMembershipByUserAndSchool(staffId, schoolId);
      if (!membership || membership.status !== "active") {
        return res.status(404).json({ error: "One or more staff members were not found in this school" });
      }
    }
    await replaceCoverageScopeGroupStaff({ schoolId, groupId, staffIds, createdBy: req.authUser!.id });
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.supervision_group.staff.update",
      entityType: "coverage_scope_group",
      entityId: group.id,
      changes: { staffIds },
    });
    const refreshed = await getCoverageScopeGroupByIdAndSchool(schoolId, groupId);
    return res.json({ group: await supervisionGroupPayload(schoolId, refreshed || group) });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/available-students", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const rows = await getOnlineUnassignedStudents(schoolId);
    const activeAssignments = isAdmin(req, res)
      ? []
      : await getActiveCoverageAssignmentsForStaff(schoolId, req.authUser!.id);
    const visibleGroups = await visibleSupervisionGroupsForRequest(
      req,
      res,
      false,
      activeAssignments
    );
    const assignmentIndex = await hydrateCoverageAssignmentScopeIndex(
      schoolId,
      activeAssignments,
      visibleGroups
    );
    const scheduledCoverageGroups = await scheduledCoverageGroupsForRequest(
      req,
      res,
      activeAssignments,
      assignmentIndex
    );
    const scheduledCoverageStudentIds = new Set(
      scheduledCoverageGroups.flatMap((group: any) => (group.students || []).map((student: any) => student.studentId))
    );
    const candidateRows = rows.filter(
      (row) => !scheduledCoverageStudentIds.has(row.student.id)
    );
    const [assignmentLabels, statuses] = await Promise.all([
      assignmentScopeLabels(schoolId, activeAssignments, visibleGroups),
      hydrateClasspilotCoverageStatuses({
        schoolId,
        studentIds: candidateRows.map((row) => row.student.id),
        knownSessions: candidateRows.map((row) => row.studentSession),
      }),
    ]);
    const students = candidateRows.flatMap((row) => {
      const matchingGroups = visibleGroups.filter((group) =>
        groupContainsStudent(group, row.student.id)
      );
      const matchingAssignments = matchingDirectAssignmentsForStudentFromIndex(
        activeAssignments,
        row.student,
        assignmentIndex
      );
      if (
        !isAdmin(req, res) &&
        matchingGroups.length === 0 &&
        matchingAssignments.length === 0
      ) return [];
      return [availableStudentPayload(
        row,
        matchingGroups,
        matchingAssignments,
        statuses.get(row.student.id)!,
        assignmentLabels
      )];
    });
    return res.json({ students, scheduledCoverageGroups });
  } catch (err) {
    next(err);
  }
});

router.get("/coverage/claimed-students", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const contexts = (await listSupervisionContexts(schoolId, { activeOnly: true }))
      .filter((context) => isAdmin(req, res) || context.assignedStaffId === req.authUser!.id);
    const groupIds = [...new Set(contexts.map((context) => context.coverageGroupId).filter(Boolean))];
    const [allGroups, staffRows, rows] = await Promise.all([
      groupIds.length > 0
        ? listCoverageScopeGroups(schoolId, { activeOnly: false })
        : Promise.resolve([]),
      getStaffBySchool(schoolId),
      listSupervisionStudentsForContexts(
        schoolId,
        contexts.map((context) => context.id),
        { activeOnly: true }
      ),
    ]);
    const requestedGroupIds = new Set(groupIds);
    const groupsById = new Map(
      allGroups
        .filter((group) => requestedGroupIds.has(group.id))
        .map((group) => [group.id, group])
    );
    const staffById = new Map(staffRows.map((row) => [row.userId, row.user]));
    const contextsById = new Map(contexts.map((context) => [context.id, context]));
    const statuses = await hydrateClasspilotCoverageStatuses({
      schoolId,
      studentIds: rows.map((row) => row.studentId),
    });
    const students = rows.map((row) => {
      const context = contextsById.get(row.contextId);
      const group = context?.coverageGroupId ? groupsById.get(context.coverageGroupId) : null;
      const staff = context?.assignedStaffId ? staffById.get(context.assignedStaffId) : null;
      return {
        assignmentId: row.id,
        contextId: row.contextId,
        contextName: context?.name || "Claimed students",
        studentId: row.studentId,
        studentName: studentName(row.student),
        studentEmail: row.student.email || undefined,
        gradeLevel: row.student.gradeLevel || undefined,
        source: row.source,
        assignedAt: row.assignedAt,
        supervisionState: "claimed",
        ...coverageStatusPayload(statuses.get(row.studentId)!),
        supervisionGroup: group ? { id: group.id, name: group.name } : null,
        assignedStaff: staff ? { id: staff.id, displayName: staffName(staff) } : null,
      };
    });
    return res.json({ students });
  } catch (err) {
    next(err);
  }
});

async function assignStudentsToSupervisionGroup(options: {
  schoolId: string;
  group: any;
  assignedStaffId: string;
  actorId: string;
  studentIds: string[];
  source: string;
  note?: string;
}) {
  const endsAt = await defaultClaimEndsAt(options.schoolId);
  const existing = await getActiveSupervisionContextForStaffGroup(options.schoolId, options.assignedStaffId, options.group.id);
  if (existing) {
    const context = await extendSupervisionContext({
      schoolId: options.schoolId,
      contextId: existing.id,
      endsAt: existing.endsAt < endsAt ? endsAt : existing.endsAt,
      note: options.note || existing.note || null,
      coverageGroupId: options.group.id,
    });
    const assignments = await assignStudentsToSupervisionContext({
      schoolId: options.schoolId,
      contextId: existing.id,
      studentIds: options.studentIds,
      assignedBy: options.actorId,
      source: options.source,
    });
    const activeRows = await listSupervisionStudentsForContexts(
      options.schoolId,
      [existing.id],
      { activeOnly: true }
    );
    await syncClasspilotControlStatesToActiveDevices(
      options.schoolId,
      activeRows.map((row) => row.studentId)
    );
    return { context: context || existing, assignments };
  }

  const context = await createSupervisionContextWithStudents({
    context: {
      schoolId: options.schoolId,
      contextType: "supervision_group",
      name: options.group.name,
      status: "active",
      assignedStaffId: options.assignedStaffId,
      coverageGroupId: options.group.id,
      createdBy: options.actorId,
      note: options.note || null,
      endsAt,
    },
    studentIds: options.studentIds,
    assignedBy: options.actorId,
    source: options.source,
  });
  return { context, assignments: [] };
}

async function assignStudentsToDirectSupervision(options: {
  schoolId: string;
  assignedStaffId: string;
  actorId: string;
  studentIds: string[];
  source: string;
  name?: string;
  note?: string;
}) {
  const endsAt = await defaultClaimEndsAt(options.schoolId);
  const existing = await getActiveDirectSupervisionContextForStaff(options.schoolId, options.assignedStaffId);
  if (existing) {
    const context = await extendSupervisionContext({
      schoolId: options.schoolId,
      contextId: existing.id,
      endsAt: existing.endsAt < endsAt ? endsAt : existing.endsAt,
      note: options.note || existing.note || null,
      coverageGroupId: null,
    });
    const assignments = await assignStudentsToSupervisionContext({
      schoolId: options.schoolId,
      contextId: existing.id,
      studentIds: options.studentIds,
      assignedBy: options.actorId,
      source: options.source,
    });
    const activeRows = await listSupervisionStudentsForContexts(
      options.schoolId,
      [existing.id],
      { activeOnly: true }
    );
    await syncClasspilotControlStatesToActiveDevices(
      options.schoolId,
      activeRows.map((row) => row.studentId)
    );
    return { context: context || existing, assignments };
  }

  const context = await createSupervisionContextWithStudents({
    context: {
      schoolId: options.schoolId,
      contextType: "direct_pickup",
      name: options.name || "Claimed students",
      status: "active",
      assignedStaffId: options.assignedStaffId,
      coverageGroupId: null,
      createdBy: options.actorId,
      note: options.note || null,
      endsAt,
    },
    studentIds: options.studentIds,
    assignedBy: options.actorId,
    source: options.source,
  });
  return { context, assignments: [] };
}

router.post("/coverage/claim", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const groupId = String(req.body.supervisionGroupId || req.body.coverageGroupId || "").trim();
    const scheduledConflictId = String(req.body.scheduledConflictId || "").trim();
    const studentIds = normalizeStudentIds(req.body.studentIds);
    if (studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds are required" });
    }
    const assignedStaffId = isAdmin(req, res) && req.body.assignedStaffId
      ? String(req.body.assignedStaffId).trim()
      : req.authUser!.id;
    const staffMembership = await getMembershipByUserAndSchool(assignedStaffId, schoolId);
    if (!staffMembership || staffMembership.status !== "active") {
      return res.status(404).json({ error: "Assigned staff member not found in this school" });
    }
    const students = await assertActiveStudentsInSchool(schoolId, studentIds);

    let result;
    if (scheduledConflictId) {
      const conflict = await getScheduledClassConflictByIdAndSchool(scheduledConflictId, schoolId);
      if (conflict?.status === "expired") {
        return res.status(409).json({
          code: "SCHEDULED_CONFLICT_EXPIRED",
          error: "This scheduled block has ended. Students will move with the next class or become available again.",
        });
      }
      if (!conflict || !["coverage_needed", "claimed", "pending"].includes(conflict.status)) {
        return res.status(404).json({ error: "Scheduled coverage request not found" });
      }
      const group = await getGroupByIdAndSchool(conflict.groupId, schoolId);
      if (!group) return res.status(404).json({ error: "Scheduled class not found" });
      const scheduledPayload = await buildScheduledCoveragePayload({
        group,
        scheduledDate: conflict.scheduledDate,
        scheduledConflictId: conflict.id,
      });
      const claimableIds = new Set(scheduledPayload.claimableStudents.map((student) => student.studentId));
      if (studentIds.some((studentId) => !claimableIds.has(studentId))) {
        return res.status(409).json({ error: "One or more students are no longer available for scheduled coverage" });
      }
      if (!isAdmin(req, res)) {
        const [assignments, groupTeachers] = await Promise.all([
          getActiveCoverageAssignmentsForStaff(schoolId, req.authUser!.id),
          conflict.teacherId === req.authUser!.id
            ? Promise.resolve([])
            : getGroupTeachers(conflict.groupId),
        ]);
        const isClassTeacher =
          conflict.teacherId === req.authUser!.id ||
          groupTeachers.some((teacher) => teacher.teacherId === req.authUser!.id);
        const assignmentIndex = await hydrateCoverageAssignmentScopeIndex(
          schoolId,
          assignments
        );
        for (const student of students) {
          if (
            !isClassTeacher &&
            !assignments.some((assignment) =>
              assignmentAllowsClaim(assignment) &&
              assignmentCoversStudentFromIndex(assignment, student, assignmentIndex)
            )
          ) {
            return res.status(403).json({ error: "One or more students are outside your supervision scope" });
          }
        }
      }
      result = await claimScheduledCoverageStudents({
        schoolId,
        scheduledConflictId: conflict.id,
        className: scheduledPayload.selectedClass.name,
        assignedStaffId,
        actorId: req.authUser!.id,
        studentIds,
        endsAt: await defaultClaimEndsAt(schoolId),
        note: req.body.note ? String(req.body.note) : undefined,
      });
      // The claim transaction revision-refreshes every active member when it
      // extends this shared context. Push those durable snapshots together.
      const activeContextRows = await listSupervisionStudentsForContexts(
        schoolId,
        [result.context.id],
        { activeOnly: true }
      );
      await syncClasspilotControlStatesToActiveDevices(
        schoolId,
        activeContextRows.map((row) => row.studentId)
      );
      const refreshedPayload = await buildScheduledCoveragePayload({
        group,
        scheduledDate: conflict.scheduledDate,
        scheduledConflictId: conflict.id,
      });
      await updateScheduledClassConflictStatus(conflict.id, schoolId, "claimed", refreshedPayload);
      broadcastScheduledConflictUpdate(schoolId, conflict.id);
    } else if (groupId) {
      const unassignedRows = await getOnlineUnassignedStudents(schoolId);
      const unassignedIds = new Set(unassignedRows.map((row) => row.student.id));
      if (studentIds.some((studentId) => !unassignedIds.has(studentId))) {
        return res.status(409).json({ error: "One or more students are no longer available to claim" });
      }
      const group = await getCoverageScopeGroupByIdAndSchool(schoolId, groupId);
      if (!group || !group.active) return res.status(404).json({ error: "Supervision group not found" });
      if (!isAdmin(req, res)) {
        const allowedGroupIds = await activeCoverageGroupIdsForStaff(schoolId, req.authUser!.id);
        if (!allowedGroupIds.has(group.id)) {
          return res.status(403).json({ error: "You can only claim students from your Supervision Groups" });
        }
      }
      const groupMemberIds = new Set(group.members.map((member: any) => member.studentId));
      if (students.some((student) => !groupMemberIds.has(student.id))) {
        return res.status(403).json({ error: "One or more students are outside this Supervision Group" });
      }
      result = await assignStudentsToSupervisionGroup({
        schoolId,
        group,
        assignedStaffId,
        actorId: req.authUser!.id,
        studentIds,
        source: isAdmin(req, res) && assignedStaffId !== req.authUser!.id ? "admin_assign" : "staff_claim",
        note: req.body.note ? String(req.body.note) : undefined,
      });
    } else {
      const unassignedRows = await getOnlineUnassignedStudents(schoolId);
      const unassignedIds = new Set(unassignedRows.map((row) => row.student.id));
      if (studentIds.some((studentId) => !unassignedIds.has(studentId))) {
        return res.status(409).json({ error: "One or more students are no longer available to claim" });
      }
      let contextName = "Claimed students";
      if (!isAdmin(req, res)) {
        const assignments = await getActiveCoverageAssignmentsForStaff(schoolId, req.authUser!.id);
        const assignmentIndex = await hydrateCoverageAssignmentScopeIndex(schoolId, assignments);
        const matchesByStudent = students.map((student) =>
          matchingDirectAssignmentsForStudentFromIndex(assignments, student, assignmentIndex)
        );
        if (matchesByStudent.some((matches) => matches.length === 0)) {
          return res.status(403).json({ error: "One or more students are outside your supervision scope" });
        }
        const matchedAssignments = [
          ...new Map(
            matchesByStudent
              .flat()
              .map((assignment) => [assignment.id, assignment])
          ).values(),
        ];
        const labelsByAssignment = await assignmentScopeLabels(
          schoolId,
          matchedAssignments
        );
        const labels = new Set<string>();
        for (const matches of matchesByStudent) {
          labels.add(labelsByAssignment.get(matches[0]!.id) || "Assigned students");
        }
        if (labels.size === 1) contextName = Array.from(labels)[0] || contextName;
      }
      result = await assignStudentsToDirectSupervision({
        schoolId,
        assignedStaffId,
        actorId: req.authUser!.id,
        studentIds,
        source: isAdmin(req, res) && assignedStaffId !== req.authUser!.id ? "admin_assign" : "staff_claim",
        name: contextName,
        note: req.body.note ? String(req.body.note) : undefined,
      });
    }
    await syncClasspilotControlStatesToActiveDevices(schoolId, studentIds);
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.student.claim",
      entityType: "supervision_context",
      entityId: result.context.id,
      changes: { supervisionGroupId: groupId || null, scheduledConflictId: scheduledConflictId || null, assignedStaffId, studentIds },
    });
    return res.status(201).json({ context: result.context, assignments: result.assignments });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/coverage/send", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const groupId = String(req.body.supervisionGroupId || req.body.coverageGroupId || "").trim();
    const assignedStaffId = String(req.body.assignedStaffId || "").trim();
    const studentIds = normalizeStudentIds(req.body.studentIds);
    if (!groupId || !assignedStaffId || studentIds.length === 0) {
      return res.status(400).json({ error: "supervisionGroupId, assignedStaffId, and studentIds are required" });
    }
    const group = await getCoverageScopeGroupByIdAndSchool(schoolId, groupId);
    if (!group || !group.active) return res.status(404).json({ error: "Supervision group not found" });
    const staffMembership = await getMembershipByUserAndSchool(assignedStaffId, schoolId);
    if (!staffMembership || staffMembership.status !== "active") {
      return res.status(404).json({ error: "Assigned staff member not found in this school" });
    }
    const assignedStaffGroupIds = await activeCoverageGroupIdsForStaff(schoolId, assignedStaffId);
    if (!assignedStaffGroupIds.has(group.id)) {
      return res.status(403).json({ error: "Assigned staff member is not paired with this Supervision Group" });
    }
    await assertActiveStudentsInSchool(schoolId, studentIds);
    const groupMemberIds = new Set(group.members.map((member: any) => member.studentId));
    if (studentIds.some((studentId) => !groupMemberIds.has(studentId))) {
      return res.status(403).json({ error: "One or more students are outside this Supervision Group" });
    }
    if (!isAdmin(req, res)) {
      const session = await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
      if (!session) return res.status(409).json({ error: "Start a class session before sending students" });
      const classRows = await getClasspilotSessionStudentRoster(schoolId, session.id);
      const classStudentIds = new Set(classRows.map((row) => row.studentId));
      if (studentIds.some((studentId) => !classStudentIds.has(studentId))) {
        return res.status(403).json({ error: "Teachers can only send students from their active class" });
      }
    }

    const result = await assignStudentsToSupervisionGroup({
      schoolId,
      group,
      assignedStaffId,
      actorId: req.authUser!.id,
      studentIds,
      source: isAdmin(req, res) ? "admin_send" : "teacher_send",
      note: req.body.note ? String(req.body.note) : undefined,
    });
    await syncClasspilotControlStatesToActiveDevices(schoolId, studentIds);
    await logAudit({
      schoolId,
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      userRole: res.locals.membershipRole,
      action: "coverage.student.send",
      entityType: "supervision_context",
      entityId: result.context.id,
      changes: { supervisionGroupId: group.id, assignedStaffId, studentIds, note: req.body.note ? String(req.body.note) : null },
    });
    return res.status(201).json({ context: result.context, assignments: result.assignments });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post("/coverage/return-to-class", ...auth, async (req, res, next) => {
  try {
    if (!requireStaffRole(req, res)) return res.status(403).json({ error: "Staff access required" });
    const schoolId = res.locals.schoolId!;
    const studentIds = normalizeStudentIds(req.body.studentIds);
    if (studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds are required" });
    }

    const session = await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
    if (!session) {
      return res.status(409).json({ error: "Start a class session before returning students to class" });
    }

    await assertStudentsInSchool(schoolId, studentIds);
    const classRows = await getClasspilotSessionStudentRoster(schoolId, session.id);
    const classStudentIds = new Set(classRows.map((row) => row.studentId));
    if (studentIds.some((studentId) => !classStudentIds.has(studentId))) {
      return res.status(403).json({ error: "Teachers can only return students from their active class" });
    }

    const activeCoverage = await getActiveSupervisionForStudents(schoolId, studentIds);
    const coverageByStudent = new Map(activeCoverage.map((entry) => [entry.studentId, entry.context]));
    if (studentIds.some((studentId) => !coverageByStudent.has(studentId))) {
      return res.status(409).json({ error: "One or more selected students are not currently in supervision" });
    }

    const studentsByContext = new Map<string, string[]>();
    for (const studentId of studentIds) {
      const context = coverageByStudent.get(studentId)!;
      const rows = studentsByContext.get(context.id) || [];
      rows.push(studentId);
      studentsByContext.set(context.id, rows);
    }

    const released = [];
    for (const [contextId, contextStudentIds] of studentsByContext.entries()) {
      const contextReleased = await releaseSupervisionStudents({
        schoolId,
        contextId,
        studentIds: contextStudentIds,
        releaseReason: "returned_to_class",
      });
      released.push(...contextReleased);
      await logAudit({
        schoolId,
        userId: req.authUser!.id,
        userEmail: req.authUser!.email,
        userRole: res.locals.membershipRole,
        action: "coverage.student.return_to_class",
        entityType: "supervision_context",
        entityId: contextId,
        changes: {
          studentIds: contextStudentIds,
          teachingSessionId: session.id,
          releaseReason: "returned_to_class",
        },
      });
    }

    await syncClasspilotControlStatesToActiveDevices(schoolId, studentIds);

    return res.json({ released });
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
      : contexts.filter((context) => context.assignedStaffId === req.authUser!.id);
    const response = await contextResponse(
      schoolId,
      visible,
      (context) => isAdmin(req, res) || context.assignedStaffId === req.authUser!.id
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
    const groups = await listCoverageScopeGroups(schoolId, { activeOnly: true });
    const enriched = await supervisionGroupPayloads(
      schoolId,
      groups,
      { includeStudents: false }
    );
    const targets = enriched.flatMap((group) =>
      (group.staff || []).map((staff: any) => ({
        id: `${group.id}:${staff.id}`,
        name: group.name,
        supervisionGroupId: group.id,
        assignedStaffId: staff.id,
        assignedStaff: {
          id: staff.id,
          displayName: staff.displayName,
        },
      }))
    );
    return res.json({ targets, contexts: targets });
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
      supervisionActorIsAdmin: isAdmin(req, res),
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
    const students = await assertActiveStudentsInSchool(schoolId, studentIds);
    if (!admin) {
      const unassignedRows = await getOnlineUnassignedStudents(schoolId);
      const unassignedIds = new Set(unassignedRows.map((row) => row.student.id));
      if (studentIds.some((id) => !unassignedIds.has(id))) {
        return res.status(403).json({ error: "Coverage staff can only claim currently unassigned students" });
      }
      const assignments = await getActiveCoverageAssignmentsForStaff(schoolId, req.authUser!.id);
      const assignmentIndex = await hydrateCoverageAssignmentScopeIndex(schoolId, assignments);
      const outsideScope = students.some((student) => !assignments.some((assignment) =>
        assignmentAllowsClaim(assignment) &&
        assignmentCoversStudentFromIndex(assignment, student, assignmentIndex)
      ));
      if (outsideScope) {
        return res.status(403).json({ error: "One or more students are outside your coverage scope" });
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
        coverageGroupId: coverageGroupId || null,
        createdBy: req.authUser!.id,
        note: req.body.note ? String(req.body.note) : null,
        endsAt,
      },
      studentIds,
      assignedBy: req.authUser!.id,
      source: admin ? "admin_claim" : "coverage_claim",
    });
    await syncClasspilotControlStatesToActiveDevices(schoolId, studentIds);
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
    await assertActiveStudentsInSchool(schoolId, studentIds);

    if (!isAdmin(req, res)) {
      const session = await getActiveTeachingSessionForSchool(req.authUser!.id, schoolId);
      if (!session) return res.status(409).json({ error: "Start a class session before rerouting students" });
      const classRows = await getClasspilotSessionStudentRoster(schoolId, session.id);
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
    await syncClasspilotControlStatesToActiveDevices(schoolId, studentIds);
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
    if (!isAdmin(req, res) && context.assignedStaffId !== req.authUser!.id) {
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
    await syncClasspilotControlStatesToActiveDevices(
      schoolId,
      released.map((row) => row.studentId)
    );
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
    if (!isAdmin(req, res) && context.assignedStaffId !== req.authUser!.id) {
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
    if (endsAt) {
      const activeRows = await listSupervisionStudentsForContexts(schoolId, [context.id], { activeOnly: true });
      await syncClasspilotControlStatesToActiveDevices(
        schoolId,
        activeRows.map((row) => row.studentId)
      );
    }
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
