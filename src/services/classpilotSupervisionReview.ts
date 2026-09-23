import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import db from "../db.js";
import { schoolMemberships, users } from "../schema/core.js";
import { students } from "../schema/students.js";
import { classpilotCoverageAssignments as grants, classpilotCoverageScopeGroups as savedGroups,
  classpilotCoverageScopeGroupMembers as savedMembers, classpilotSupervisionContexts as contexts,
  classpilotSupervisionStudents as assignments, classpilotSessionStaff, groupStudents, groups,
  studentSessions, devices } from "../schema/classpilot.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool, type StaffAssignmentLifecycleLockDb } from "./staffAssignmentLifecycleLock.js";
import { assignStudentsToSupervisionContext, createSupervisionContextWithStudents, extendSupervisionContext,
  getActiveClassOwnersForStudents, getActiveSupervisionForStudents, lockClasspilotStudentControlAuthorities } from "./storage.js";
import { currentStudentSessionAuthorityPredicate } from "./classpilotStudentSessionAuthority.js";
import { supervisionActivityPresentation } from "./classpilotSupervisionPurpose.js";

type Tx = StaffAssignmentLifecycleLockDb;
const id = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const inputSchema = z.object({
  action: z.enum(["start", "send", "end_time"]),
  studentIds: z.array(id).max(5000).default([]),
  supervisionGroupId: id.optional(), assignedStaffId: id.optional(), destinationContextId: id.optional(),
  contextType: z.enum(["other", "state_testing"]).default("other"),
  name: z.string().trim().min(1).max(120).optional(), endsAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional(),
}).strict();
export type SupervisionReviewRequest = z.infer<typeof inputSchema>;
export class SupervisionReviewError extends Error {
  constructor(message: string, public code = "SUPERVISION_REVIEW_INVALID", public status = 400) { super(message); }
}
function fail(message: string, code?: string, status?: number): never { throw new SupervisionReviewError(message, code, status); }
function stableJson(value: unknown) {
  return JSON.stringify(value, (_key, current: unknown) => current && typeof current === "object" && !Array.isArray(current)
    ? Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right))) : current);
}
function parse(input: unknown) {
  const result = inputSchema.safeParse(input);
  if (!result.success) fail(result.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  return { ...result.data, studentIds: [...new Set(result.data.studentIds)].sort() };
}
function displayName(user: { displayName: string | null; firstName: string | null; lastName: string | null; email: string }) {
  return user.displayName || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
}
function allowsClaim(grant: typeof grants.$inferSelect) {
  const permissions = (grant.permissions || {}) as Record<string, unknown>;
  return grant.active && grant.scopeType !== "setup" && (permissions.claim === true || permissions.observe === true);
}
export function isAdHocSupervisionDestination(context: typeof contexts.$inferSelect, now = new Date()) {
  return context.status === "active" && context.startsAt <= now && context.endsAt > now
    && !context.scheduledConflictId && !context.scheduleProfileApplicationId && !context.scheduleProfileDate && !context.scheduleProfileBlockId;
}
async function scopeData(tx: Tx, schoolId: string, actorId: string) {
  const [actor] = await tx.select().from(users).where(eq(users.id, actorId));
  const memberships = await tx.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.status, "active")));
  const actorMemberships = memberships.filter(row => row.userId === actorId);
  const admin = actor?.isSuperAdmin === true || actorMemberships.some(row => ["admin", "school_admin"].includes(row.role));
  if (!admin && !actorMemberships.some(row => ["teacher", "office_staff"].includes(row.role))) fail("Active school staff access is required.", "FORBIDDEN", 403);
  const grantRows = await tx.select().from(grants).where(and(eq(grants.schoolId, schoolId), eq(grants.active, true)));
  const groupRows = await tx.select().from(savedGroups).where(and(eq(savedGroups.schoolId, schoolId), eq(savedGroups.active, true)));
  const memberRows = await tx.select().from(savedMembers).where(eq(savedMembers.schoolId, schoolId));
  const classMembers = await tx.select({ groupId: groupStudents.groupId, studentId: groupStudents.studentId }).from(groupStudents)
    .innerJoin(groups, and(eq(groups.id, groupStudents.groupId), eq(groups.schoolId, schoolId)));
  const enabledIds = new Set(groupRows.map(row => row.id));
  const covers = (staffId: string, student: typeof students.$inferSelect) => grantRows.some(row => {
    if (row.staffId !== staffId || !allowsClaim(row)) return false;
    if (row.scopeType === "school") return true;
    if (row.scopeType === "grade") return row.scopeValue === String(student.gradeLevel || "");
    if (row.scopeType === "students") return String(row.scopeValue || "").split(",").map(id => id.trim()).includes(student.id);
    if (row.scopeType === "group") return classMembers.some(member => member.groupId === row.scopeValue && member.studentId === student.id);
    return row.scopeType === "coverage_group" && enabledIds.has(row.scopeValue || "") && memberRows.some(member => member.coverageGroupId === row.scopeValue && member.studentId === student.id);
  });
  return { actor, memberships, admin, grantRows, groupRows, memberRows, classMembers, covers };
}

async function snapshot(tx: Tx, schoolId: string, actorId: string, original: SupervisionReviewRequest) {
  const now = new Date();
  const database = tx as unknown as typeof db;
  const scope = await scopeData(tx, schoolId, actorId);
  const request = { ...original };
  let destinationContext: typeof contexts.$inferSelect | undefined;
  if (request.destinationContextId) {
    [destinationContext] = await tx.select().from(contexts).where(and(eq(contexts.schoolId, schoolId), eq(contexts.id, request.destinationContextId)));
    if (!destinationContext || !isAdHocSupervisionDestination(destinationContext, now)) fail("Choose an active, already-started session without a scheduled origin.", "SUPERVISION_DESTINATION_UNAVAILABLE", 409);
    if (request.action === "start") fail("Starting a session cannot reuse another session.");
    request.assignedStaffId = destinationContext.assignedStaffId;
    request.supervisionGroupId = destinationContext.coverageGroupId || undefined;
    request.contextType = destinationContext.contextType === "state_testing" ? "state_testing" : "other";
    request.name = destinationContext.name;
    if (request.action === "send") request.endsAt = destinationContext.endsAt.toISOString();
  }
  if (request.action === "end_time" && !destinationContext) fail("Choose a session to update.");
  const assignedStaffId = request.assignedStaffId || actorId;
  request.assignedStaffId = assignedStaffId;
  const staffMemberships = scope.memberships.filter(row => row.userId === assignedStaffId && ["admin", "school_admin", "teacher", "office_staff"].includes(row.role));
  if (!staffMemberships.length) fail("The supervisor is no longer active in this school.", "SUPERVISION_STAFF_UNAVAILABLE", 409);
  const [staff] = await tx.select().from(users).where(eq(users.id, assignedStaffId));
  if (!staff) fail("Supervisor not found.", "NOT_FOUND", 404);
  if (request.action !== "send" && !scope.admin && assignedStaffId !== actorId) fail("Only administrators can start or update another staff member's session.", "FORBIDDEN", 403);
  const group = request.supervisionGroupId ? scope.groupRows.find(row => row.id === request.supervisionGroupId) : undefined;
  if (request.supervisionGroupId && !group) fail("This saved group is disabled or unavailable.", "SUPERVISION_GROUP_UNAVAILABLE", 409);
  if (request.action === "send") {
    if (!group) fail("Choose a saved group and an authorized supervisor for Send.");
    if (!scope.grantRows.some(row => row.staffId === assignedStaffId && allowsClaim(row) && row.scopeType === "coverage_group" && row.scopeValue === group.id)) {
      fail("The receiving supervisor is no longer authorized for this saved group.", "SUPERVISION_PERMISSION_CHANGED", 409);
    }
  }
  const endsAt = new Date(request.endsAt || "");
  if (!Number.isFinite(endsAt.getTime()) || endsAt <= now) fail("Choose an end time in the future.");
  const startsAt = destinationContext?.startsAt ?? now;
  if (endsAt.getTime() > startsAt.getTime() + 12 * 60 * 60_000) fail("Supervision must end within 12 hours of its start.");
  request.endsAt = endsAt.toISOString();
  request.name ||= group?.name || (request.contextType === "state_testing" ? "Testing" : "Supervision");
  let currentRows: Array<typeof assignments.$inferSelect> = [];
  if (destinationContext) currentRows = await tx.select().from(assignments).where(and(eq(assignments.schoolId, schoolId), eq(assignments.contextId, destinationContext.id), isNull(assignments.releasedAt)));
  if (request.action === "end_time") request.studentIds = currentRows.map(row => row.studentId).sort();
  if (!request.studentIds.length) fail("Select at least one student.");
  const studentRows = await tx.select().from(students).where(and(eq(students.schoolId, schoolId), inArray(students.id, request.studentIds)));
  if (studentRows.length !== request.studentIds.length) fail("One or more students are unavailable in this school.", "NOT_FOUND", 404);
  const supervision = await getActiveSupervisionForStudents(schoolId, request.studentIds, database);
  const classOwners = await getActiveClassOwnersForStudents(schoolId, request.studentIds, database, now);
  const sessionIds = [...new Set(classOwners.map(row => row.session.id))];
  const frozenStaff = sessionIds.length ? await tx.select().from(classpilotSessionStaff).where(and(eq(classpilotSessionStaff.schoolId, schoolId), inArray(classpilotSessionStaff.teachingSessionId, sessionIds))) : [];
  const onlineRows = await tx.select({ studentId: studentSessions.studentId, sessionId: studentSessions.id }).from(studentSessions)
    .innerJoin(devices, and(eq(devices.deviceId, studentSessions.deviceId), eq(devices.schoolId, schoolId)))
    .where(and(inArray(studentSessions.studentId, request.studentIds), currentStudentSessionAuthorityPredicate(), gte(studentSessions.lastSeenAt, new Date(now.getTime() - 5 * 60_000))));
  const futureRows = await tx.select({ studentId: assignments.studentId, contextId: assignments.contextId }).from(assignments)
    .innerJoin(contexts, and(eq(contexts.id, assignments.contextId), eq(contexts.schoolId, schoolId), eq(contexts.status, "active"), gt(contexts.startsAt, now), gt(contexts.endsAt, now)))
    .where(and(eq(assignments.schoolId, schoolId), inArray(assignments.studentId, request.studentIds), isNull(assignments.releasedAt)));
  const studentResults = request.studentIds.map(studentId => {
    const student = studentRows.find(row => row.id === studentId)!;
    const coverage = supervision.find(row => row.studentId === studentId);
    const classOwner = classOwners.find(row => row.studentId === studentId);
    const currentOwner = coverage ? { kind: "supervision", id: coverage.context.id, name: supervisionActivityPresentation(coverage.context, [coverage.assignment]).name,
      assignedStaffId: coverage.context.assignedStaffId, endsAt: coverage.context.endsAt.toISOString() }
      : classOwner ? { kind: "class", id: classOwner.session.id, name: classOwner.groupName, assignedStaffId: classOwner.session.teacherId,
        endsAt: classOwner.session.scheduledEndAt?.toISOString() || null } : null;
    const alreadyAssigned = !!destinationContext && coverage?.context.id === destinationContext.id;
    const visible = scope.admin || request.action === "end_time" || (request.action === "start" ? scope.covers(actorId, student)
      : !!classOwner && frozenStaff.some(row => row.teachingSessionId === classOwner.session.id && row.staffId === actorId));
    let reason: string | null = null;
    // Authorization precedes every explanation: even a reason about inactivity,
    // a reservation or group membership is private student information.
    if (!visible) reason = "Student is outside your authorized classroom or supervision scope.";
    else if (student.status !== "active") reason = "Student is inactive.";
    else if (request.action === "end_time") reason = null;
    else if (futureRows.some(row => row.studentId === studentId)) reason = "A future supervision assignment already reserves this student.";
    else if (group && !scope.memberRows.some(row => row.coverageGroupId === group.id && row.studentId === studentId)) reason = "Student is no longer in this saved group.";
    else if (request.action === "start" && !scope.admin && !scope.covers(actorId, student)) reason = "Student is outside your supervision permissions.";
    else if (request.action === "start" && !scope.admin && currentOwner) reason = "Student is already in a class or supervision session.";
    else if (request.action === "send" && !scope.admin && (!classOwner || !frozenStaff.some(row => row.teachingSessionId === classOwner.session.id && row.staffId === actorId)
      || (coverage && !alreadyAssigned))) reason = "Teachers can only send students currently controlled by their active class.";
    else if (!alreadyAssigned && !onlineRows.some(row => row.studentId === studentId)) reason = "Student is not currently connected.";
    return { studentId, name: visible ? [student.firstName, student.lastName].filter(Boolean).join(" ") || student.email || studentId : "Unavailable student",
      eligible: !reason, reason, currentOwner: visible ? currentOwner : null, status: reason ? "unavailable" : alreadyAssigned ? "already_assigned" : "ready" };
  });
  const destination = { contextId: destinationContext?.id || null, name: request.name, purpose: destinationContext
    ? supervisionActivityPresentation(destinationContext, currentRows).purpose : request.contextType === "state_testing" ? "testing" : "supervision",
    assignedStaffId, supervisorName: displayName(staff), endsAt: request.endsAt,
    revision: destinationContext ? String(destinationContext.classroomAuthorityRevision) : null };
  // Include authorization inputs, exact source assignments and immutable class
  // ownership. Heartbeats are reduced to eligibility/binding so healthy updates
  // do not make an otherwise unchanged review stale.
  const fingerprint = createHash("sha256").update(stableJson({ schoolId, actorId, request, studentResults, destination,
    actorRoles: scope.memberships.filter(row => row.userId === actorId || row.userId === assignedStaffId).map(row => [row.id, row.role, row.status]).sort(),
    admin: scope.admin, grants: scope.grantRows.filter(row => row.staffId === actorId || row.staffId === assignedStaffId).sort((a,b) => a.id.localeCompare(b.id)),
    group: group ? [group.id, group.updatedAt] : null, destinationUpdatedAt: destinationContext?.updatedAt,
    destinationRoster: currentRows.map(row => [row.studentId, row.id]).sort(),
    assignments: supervision.map(row => [row.studentId, row.assignment.id, row.context.classroomAuthorityRevision]).sort(),
    frozenStaff: frozenStaff.map(row => [row.teachingSessionId, row.staffId, row.role]).sort(),
    bindings: onlineRows.map(row => [row.studentId, row.sessionId]).sort(),
  })).digest("hex");
  return { request, students: studentResults, destination, fingerprint, scope, currentRows };
}

function secret() {
  const configured = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!configured && (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production")) throw new Error("A supervision review signing secret is required");
  return configured || "supervision-review-development-only";
}
function signature(payload: string) { return createHmac("sha256", secret()).update(`classpilot-supervision-review-v1:${payload}`).digest("base64url"); }
function issue(fingerprint: string) {
  const payload = Buffer.from(JSON.stringify({ fingerprint, expiresAt: Date.now() + 5 * 60_000 })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
function verify(token: unknown, fingerprint: string) {
  if (typeof token !== "string" || token.length > 1000) fail("Review the current students before continuing.", "SUPERVISION_REVIEW_STALE", 409);
  const [payload, mac, extra] = token.split(".");
  const expected = signature(payload || "");
  if (!mac || extra || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) fail("Review the current students before continuing.", "SUPERVISION_REVIEW_STALE", 409);
  let decoded: any;
  try { decoded = JSON.parse(Buffer.from(payload || "", "base64url").toString()); } catch { fail("Review the current students before continuing.", "SUPERVISION_REVIEW_STALE", 409); }
  if (decoded.fingerprint !== fingerprint || !Number.isFinite(decoded.expiresAt) || decoded.expiresAt <= Date.now()) fail("Students, permissions, or the destination changed. Review again before continuing.", "SUPERVISION_REVIEW_STALE", 409);
}
async function locked<T>(schoolId: string, operation: (tx: Tx) => Promise<T>) {
  return db.transaction(async tx => {
    if (!await lockStaffAssignmentLifecycleSchool(tx, schoolId)) fail("School not found.", "NOT_FOUND", 404);
    await assertClasspilotEntitled(schoolId, tx as unknown as typeof db, { lock: true });
    return operation(tx);
  });
}
export async function previewSupervision(options: { schoolId: string; actorId: string; input: unknown }) {
  const request = parse(options.input);
  return locked(options.schoolId, async tx => {
    const review = await snapshot(tx, options.schoolId, options.actorId, request);
    return { request: review.request, students: review.students, destination: review.destination, reviewToken: issue(review.fingerprint) };
  });
}
export async function commitSupervisionReview(options: { schoolId: string; actorId: string; input: unknown; reviewToken: unknown; action: SupervisionReviewRequest["action"] }) {
  const request = parse(options.input);
  if (request.action !== options.action) fail("This review belongs to a different action.");
  return locked(options.schoolId, async tx => {
    const database = tx as unknown as typeof db;
    let lockIds = request.studentIds;
    if (request.action === "end_time" && request.destinationContextId) lockIds = (await tx.select({ studentId: assignments.studentId }).from(assignments)
      .where(and(eq(assignments.schoolId, options.schoolId), eq(assignments.contextId, request.destinationContextId), isNull(assignments.releasedAt)))).map(row => row.studentId);
    await lockClasspilotStudentControlAuthorities(options.schoolId, lockIds, database);
    let review: Awaited<ReturnType<typeof snapshot>>;
    try { review = await snapshot(tx, options.schoolId, options.actorId, request); }
    catch (error) {
      if (error instanceof SupervisionReviewError) fail("The session or your permissions changed. Review again before continuing.", "SUPERVISION_REVIEW_STALE", 409);
      throw error;
    }
    verify(options.reviewToken, review.fingerprint);
    if (review.students.some(row => !row.eligible)) fail("Remove unavailable students and review the exact selection again.", "SUPERVISION_STUDENTS_UNAVAILABLE", 409);
    const normalized = review.request;
    const changedIds = review.students.filter(row => row.status !== "already_assigned").map(row => row.studentId);
    let context: typeof contexts.$inferSelect | undefined;
    if (request.action === "end_time") {
      context = await extendSupervisionContext({ schoolId: options.schoolId, contextId: normalized.destinationContextId!, endsAt: new Date(normalized.endsAt!) }, database);
    } else if (normalized.destinationContextId) {
      if (changedIds.length) await assignStudentsToSupervisionContext({ schoolId: options.schoolId, contextId: normalized.destinationContextId,
        studentIds: changedIds, assignedBy: options.actorId, source: review.scope.admin ? "admin_send" : "teacher_send" }, database);
      [context] = await tx.select().from(contexts).where(and(eq(contexts.schoolId, options.schoolId), eq(contexts.id, normalized.destinationContextId)));
    } else {
      context = await createSupervisionContextWithStudents({ context: { schoolId: options.schoolId, contextType: normalized.contextType, name: normalized.name!,
        status: "active", assignedStaffId: normalized.assignedStaffId!, createdBy: options.actorId,
        coverageGroupId: normalized.supervisionGroupId || null, note: normalized.note || null, endsAt: new Date(normalized.endsAt!) },
        studentIds: normalized.studentIds, assignedBy: options.actorId, source: request.action === "send"
          ? review.scope.admin ? "admin_send" : "teacher_send" : review.scope.admin ? "admin_claim" : "coverage_claim" }, database);
    }
    if (!context) fail("This session ended. Review again before continuing.", "SUPERVISION_REVIEW_STALE", 409);
    const rows = await tx.select().from(assignments).where(and(eq(assignments.schoolId, options.schoolId), eq(assignments.contextId, context.id), isNull(assignments.releasedAt)));
    return { context: { ...context, ...supervisionActivityPresentation(context, rows), activeStudentCount: rows.length }, assignments: rows,
      outcomes: review.students.map(row => ({ studentId: row.studentId, name: row.name, status: row.status === "already_assigned" && request.action !== "end_time" ? "already_assigned" : "assigned", reason: null })),
      changedStudentIds: request.action === "end_time" ? normalized.studentIds : changedIds };
  });
}

/** Operational roster read. It does not grant setup access or live ownership. */
export async function supervisionSessionOptions(options: { schoolId: string; actorId: string; supervisionGroupId?: string }) {
  return locked(options.schoolId, async tx => {
    const scope = await scopeData(tx, options.schoolId, options.actorId);
    const studentRows = await tx.select().from(students).where(and(eq(students.schoolId, options.schoolId), eq(students.status, "active")));
    const permitted = studentRows.filter(row => scope.admin || scope.covers(options.actorId, row));
    const visibleGroups = scope.groupRows.filter(group => scope.admin || scope.memberRows.some(member => member.coverageGroupId === group.id && permitted.some(row => row.id === member.studentId)));
    if (options.supervisionGroupId && !visibleGroups.some(row => row.id === options.supervisionGroupId)) fail("Saved group is outside your supervision permissions.", "FORBIDDEN", 403);
    const staffIds = scope.memberships.filter(row => ["admin", "school_admin", "teacher", "office_staff"].includes(row.role) && (scope.admin || row.userId === options.actorId)).map(row => row.userId);
    const staff = staffIds.length ? await tx.select().from(users).where(inArray(users.id, staffIds)) : [];
    return { groups: visibleGroups.map(row => ({ id: row.id, name: row.name })),
      students: permitted.filter(row => !options.supervisionGroupId || scope.memberRows.some(member => member.coverageGroupId === options.supervisionGroupId && member.studentId === row.id))
        .map(row => ({ studentId: row.id, studentName: [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email || row.id, gradeLevel: row.gradeLevel })),
      staff: staff.map(row => ({ id: row.id, displayName: displayName(row) })) };
  });
}
