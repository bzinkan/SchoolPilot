import { and, eq, gt, inArray, sql } from "drizzle-orm";
import db from "../db.js";
import { schoolMemberships, schools } from "../schema/core.js";
import { classpilotCoverageAssignments, classpilotCoverageScopeGroups, classpilotCoverageScopeGroupMembers, classpilotSupervisionContexts } from "../schema/classpilot.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { auditLogs } from "../schema/shared.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool, type StaffAssignmentLifecycleLockDb } from "./staffAssignmentLifecycleLock.js";
import { localDateTimeUtc } from "../util/schoolTime.js";
import { touchCoverageCategories } from "./classpilotCoverageCategoryVersions.js";

type Transaction = StaffAssignmentLifecycleLockDb;
type Assignment = typeof classpilotCoverageAssignments.$inferSelect;
export type CoverageAssignmentReview = Array<Pick<Assignment, "id" | "staffId" | "scopeType" | "scopeValue" | "permissions" | "updatedAt">>;
type Dependency = { kind: "profile" | "application" | "context"; id: string; name: string; date?: string };
export class CoverageDeletionError extends Error {
  constructor(message: string, public code: string, public status: number, public dependencies?: Dependency[]) { super(message); }
}
function fail(message: string, code = "COVERAGE_DELETE_INVALID", status = 400): never { throw new CoverageDeletionError(message, code, status); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail("A valid setup ID is required.");
  return value;
}
function body(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(field => field !== key)) fail("Reload the setup item before deleting it.");
  return value as Record<string, unknown>;
}
function allowsClaim(row: Assignment) {
  const permissions = row.permissions as Record<string, unknown>;
  return row.active && row.scopeType !== "setup" && (permissions.claim === true || permissions.observe === true);
}

/** Recheck the exact grants used by route scope validation after taking the lifecycle lock. */
export async function assertCoverageAssignmentReview(tx: Transaction, schoolId: string, review?: CoverageAssignmentReview, permission: "claim" | "setup" = "claim") {
  if (review === undefined) return;
  const ids = review.map(row => row.id);
  const current = ids.length ? await tx.select().from(classpilotCoverageAssignments).where(and(eq(classpilotCoverageAssignments.schoolId, schoolId), inArray(classpilotCoverageAssignments.id, ids))) : [];
  const allowed = (row: Assignment) => permission === "claim" ? allowsClaim(row) : row.active && (row.permissions as Record<string, unknown>).setup === true;
  if (!review.length || review.some(expected => !current.some(row => row.id === expected.id && allowed(row)
    && row.staffId === expected.staffId && row.scopeType === expected.scopeType && row.scopeValue === expected.scopeValue
    && row.updatedAt.getTime() === expected.updatedAt.getTime() && JSON.stringify(row.permissions) === JSON.stringify(expected.permissions)))) {
    fail(permission === "claim" ? "Supervision permissions changed. Refresh before claiming students." : "Setup permissions changed. Refresh before editing supervision groups.", "COVERAGE_PERMISSION_STALE", 409);
  }
}

/** Bump on every group/member/staff change, including direct permission edits. */
export async function touchCoverageGroups(tx: Transaction, schoolId: string, groupIds: string[]) {
  const ids = [...new Set(groupIds.filter(Boolean))];
  if (!ids.length) return;
  await tx.update(classpilotCoverageScopeGroups).set({
    updatedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), ${classpilotCoverageScopeGroups.updatedAt} + interval '1 millisecond')`,
  }).where(and(eq(classpilotCoverageScopeGroups.schoolId, schoolId), inArray(classpilotCoverageScopeGroups.id, ids)));
}

async function locked<T>(schoolId: string, actorId: string, operation: (tx: Transaction) => Promise<T>) {
  return db.transaction(async tx => {
    if (!await lockStaffAssignmentLifecycleSchool(tx, schoolId)) fail("School not found.", "NOT_FOUND", 404);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"passpilot-class-source:" + schoolId}))`);
    await assertClasspilotEntitled(schoolId, tx as unknown as typeof db, { lock: true });
    const memberships = await tx.select({ role: schoolMemberships.role }).from(schoolMemberships).where(and(
      eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, actorId), eq(schoolMemberships.status, "active"),
    ));
    if (!memberships.some(row => row.role === "admin" || row.role === "school_admin")) fail("Active school administrator access is required.", "FORBIDDEN", 403);
    return operation(tx);
  });
}

async function dependencies(tx: Transaction, schoolId: string, options: { groupId?: string; staffId?: string; assignments?: Assignment[] }): Promise<Dependency[]> {
  const now = new Date();
  const [schedule] = await tx.select({ config: classpilotSchoolSchedules.config }).from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId));
  const [school] = await tx.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, schoolId));
  const usableGroupIds = new Set<string>();
  const assignments = options.assignments ?? [];
  if (options.staffId) {
    const staff = await tx.select({ role: schoolMemberships.role }).from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, options.staffId), eq(schoolMemberships.status, "active")));
    if (staff.some(row => ["admin", "school_admin", "teacher", "office_staff"].includes(row.role))) {
      const groupIds = assignments.filter(row => row.scopeType === "coverage_group" && allowsClaim(row)).map(row => row.scopeValue).filter((id): id is string => !!id);
      if (groupIds.length) {
        const groups = await tx.select({ id: classpilotCoverageScopeGroups.id }).from(classpilotCoverageScopeGroups).where(and(eq(classpilotCoverageScopeGroups.schoolId, schoolId), eq(classpilotCoverageScopeGroups.active, true), inArray(classpilotCoverageScopeGroups.id, groupIds)));
        for (const group of groups) usableGroupIds.add(group.id);
      }
    }
  }
  const affected = (block: { coverageGroupId: string; assignedStaffId: string }) => options.groupId
    ? block.coverageGroupId === options.groupId
    : block.assignedStaffId === options.staffId && usableGroupIds.has(block.coverageGroupId);
  const found: Dependency[] = [];
  for (const profile of schedule?.config.scheduleProfiles ?? []) {
    if (profile.definition.testingBlocks.some(affected)) found.push({ kind: "profile", id: profile.id, name: profile.definition.name });
  }
  for (const application of schedule?.config.profileApplications ?? []) {
    if (application.status !== "scheduled") continue;
    for (const window of application.testingWindows) {
      if (affected(window) && localDateTimeUtc(window.date, window.endTime, school?.timezone) > now) {
        found.push({ kind: "application", id: application.id, name: application.profileName, date: window.date });
        break;
      }
    }
  }
  // Live supervision owns immutable context/roster records. Never cascade into
  // those records, even when the original reusable setup can be removed.
  if (options.groupId || assignments.some(allowsClaim)) {
    const contexts = await tx.select({ id: classpilotSupervisionContexts.id, name: classpilotSupervisionContexts.name }).from(classpilotSupervisionContexts).where(and(
      eq(classpilotSupervisionContexts.schoolId, schoolId), eq(classpilotSupervisionContexts.status, "active"), gt(classpilotSupervisionContexts.endsAt, now),
      options.groupId ? eq(classpilotSupervisionContexts.coverageGroupId, options.groupId) : eq(classpilotSupervisionContexts.assignedStaffId, options.staffId!),
    ));
    for (const context of contexts) found.push({ kind: "context", id: context.id, name: context.name });
  }
  return found;
}
function assertUnused(found: Dependency[], label: string) {
  const first = found[0];
  if (!first) return;
  const use = first.kind === "profile" ? `saved schedule profile “${first.name}”` : first.kind === "application" ? `applied schedule “${first.name}” on ${first.date}` : `active supervision “${first.name}”`;
  const action = first.kind === "profile" ? "Edit its testing blocks first." : first.kind === "application" ? "Cancel that application or wait until its testing has ended." : "End that supervision first.";
  throw new CoverageDeletionError(`${label} is used by ${use}. ${action}`, "COVERAGE_DELETE_IN_USE", 409, found.slice(0, 50));
}

export async function deleteCoverageSupervisionGroup(options: { schoolId: string; actorId: string; groupId: string; body: unknown }) {
  const groupId = identifier(options.groupId), input = body(options.body, "updatedAt");
  if (typeof input.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.updatedAt) || !Number.isFinite(Date.parse(input.updatedAt))) fail("Reload this supervision group before deleting it.");
  return locked(options.schoolId, options.actorId, async tx => {
    const [group] = await tx.select().from(classpilotCoverageScopeGroups).where(and(eq(classpilotCoverageScopeGroups.schoolId, options.schoolId), eq(classpilotCoverageScopeGroups.id, groupId))).for("update");
    if (!group) fail("Supervision group not found.", "NOT_FOUND", 404);
    if (group.updatedAt.toISOString() !== input.updatedAt) fail("This supervision group changed. Cancel and reopen Delete after reloading the groups.", "COVERAGE_DELETE_STALE", 409);
    assertUnused(await dependencies(tx, options.schoolId, { groupId }), "This supervision group");
    const removedAssignments = await tx.delete(classpilotCoverageAssignments).where(and(eq(classpilotCoverageAssignments.schoolId, options.schoolId), eq(classpilotCoverageAssignments.scopeType, "coverage_group"), eq(classpilotCoverageAssignments.scopeValue, groupId))).returning({ id: classpilotCoverageAssignments.id });
    const removedMembers = await tx.delete(classpilotCoverageScopeGroupMembers).where(and(eq(classpilotCoverageScopeGroupMembers.schoolId, options.schoolId), eq(classpilotCoverageScopeGroupMembers.coverageGroupId, groupId))).returning({ id: classpilotCoverageScopeGroupMembers.id });
    await tx.delete(classpilotCoverageScopeGroups).where(and(eq(classpilotCoverageScopeGroups.schoolId, options.schoolId), eq(classpilotCoverageScopeGroups.id, groupId)));
    await touchCoverageCategories(tx, options.schoolId, [group.categoryId]);
    await tx.insert(auditLogs).values({ schoolId: options.schoolId, userId: options.actorId, action: "coverage.supervision_group.delete", entityType: "coverage_scope_group", entityId: groupId, entityName: group.name, changes: { deletedAssignments: removedAssignments.length, deletedMembers: removedMembers.length } });
    return { deleted: true, groupId, deletedAssignments: removedAssignments.length, deletedMembers: removedMembers.length };
  });
}

export async function deleteCoverageStaffAssignments(options: { schoolId: string; actorId: string; staffId: string; body: unknown }) {
  const staffId = identifier(options.staffId), input = body(options.body, "assignmentIds");
  if (!Array.isArray(input.assignmentIds) || !input.assignmentIds.length || input.assignmentIds.length > 1000) fail("Provide the staff permissions shown in the current list.");
  const ids = input.assignmentIds.map(identifier);
  if (new Set(ids).size !== ids.length) fail("Staff permission IDs must be unique.");
  return locked(options.schoolId, options.actorId, async tx => {
    const assignments = await tx.select().from(classpilotCoverageAssignments).where(and(eq(classpilotCoverageAssignments.schoolId, options.schoolId), eq(classpilotCoverageAssignments.staffId, staffId))).for("update");
    if (!assignments.length) fail("Staff permissions not found.", "NOT_FOUND", 404);
    if (assignments.length !== ids.length || assignments.some(row => !ids.includes(row.id))) fail("These staff permissions changed. Cancel and reopen Delete after reloading the permissions.", "COVERAGE_DELETE_STALE", 409);
    assertUnused(await dependencies(tx, options.schoolId, { staffId, assignments }), "These staff permissions");
    await tx.delete(classpilotCoverageAssignments).where(and(eq(classpilotCoverageAssignments.schoolId, options.schoolId), eq(classpilotCoverageAssignments.staffId, staffId), inArray(classpilotCoverageAssignments.id, ids)));
    await touchCoverageGroups(tx, options.schoolId, assignments.filter(row => row.scopeType === "coverage_group").map(row => row.scopeValue ?? ""));
    await tx.insert(auditLogs).values({ schoolId: options.schoolId, userId: options.actorId, action: "coverage.staff_permissions.delete", entityType: "coverage_assignment", entityId: staffId, changes: { assignmentIds: ids, deletedAssignments: ids.length } });
    return { deleted: true, staffId, deletedAssignments: ids.length };
  });
}
