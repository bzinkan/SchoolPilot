import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../db.js";
import { schoolMemberships, users } from "../schema/core.js";
import { auditLogs } from "../schema/shared.js";
import { schoolDisciplineAccess as grants } from "../schema/schoolDiscipline.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { disciplineError, disciplineAccessInput } from "./schoolDisciplineValidation.js";
import { myDeskSha256 } from "./mydeskFiles.js";
import type { MyDeskActor, MyDeskDatabase } from "./mydesk.js";

export type DisciplineActor = Pick<MyDeskActor, "schoolId" | "authorId">;
export type DisciplineIdentity = DisciplineActor & { manager: boolean; canViewSchool: boolean; name: string };
export async function assertDisciplineActor(actor: DisciplineActor, tx: MyDeskDatabase): Promise<DisciplineIdentity> {
  try { await assertClasspilotEntitled(actor.schoolId, tx, { lock: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "CLASSPILOT_NOT_ENTITLED") throw disciplineError(403, "SCHOOL_UNAVAILABLE", "Active ClassPilot access is required");
    throw error;
  }
  const memberships = await tx.select({ role: schoolMemberships.role }).from(schoolMemberships).where(and(
    eq(schoolMemberships.schoolId, actor.schoolId), eq(schoolMemberships.userId, actor.authorId), eq(schoolMemberships.status, "active"),
    inArray(schoolMemberships.role, ["teacher", "admin", "school_admin"]))).for("share");
  if (!memberships.length) throw disciplineError(403, "MEMBERSHIP_REQUIRED", "Your own active school staff membership is required");
  const [user] = await tx.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, actor.authorId));
  if (!user) throw disciplineError(403, "MEMBERSHIP_REQUIRED", "Your own active school staff membership is required");
  const manager = memberships.some(x => x.role === "admin" || x.role === "school_admin");
  const [grant] = await tx.select({ enabled: grants.enabled }).from(grants).where(and(eq(grants.schoolId, actor.schoolId), eq(grants.userId, actor.authorId))).for("share");
  return { ...actor, manager, canViewSchool: manager && grant?.enabled === true, name: `${user.firstName || ""} ${user.lastName || ""}`.trim().slice(0, 500) || "School staff" };
}
export function withDiscipline<T>(actor: DisciplineActor, fn: (tx: MyDeskDatabase, verified: DisciplineIdentity) => Promise<T>, lifecycle = false, consistent = false) {
  return runWithTenantContext({ schoolId: actor.schoolId }, () => db.transaction(async tx => {
    if (lifecycle && !await lockStaffAssignmentLifecycleSchool(tx, actor.schoolId)) throw disciplineError(403, "SCHOOL_UNAVAILABLE", "School access is unavailable");
    return fn(tx, await assertDisciplineActor(actor, tx));
  }, consistent ? { isolationLevel: "repeatable read" } : undefined));
}
export async function disciplineAudit(tx: MyDeskDatabase, actor: DisciplineActor, action: string, id?: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditLogs).values({ schoolId: actor.schoolId, userId: actor.authorId, action: `discipline.${action}`,
    entityType: "discipline_record", entityId: id, metadata });
}
export const disciplineCapabilities = (actor: DisciplineActor) => withDiscipline(actor, async (_tx, identity) => ({ canSubmit: true,
  canViewSchool: identity.canViewSchool, canManageAccess: identity.manager }));
export const listDisciplineAccess = (actor: DisciplineActor) => withDiscipline(actor, async (tx, identity) => {
  if (!identity.manager) throw disciplineError(403, "ACCESS_MANAGEMENT_REQUIRED", "A school administrator is required");
  const memberships = await tx.select({ userId: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId)).where(and(eq(schoolMemberships.schoolId, actor.schoolId), eq(schoolMemberships.status, "active"),
      inArray(schoolMemberships.role, ["admin", "school_admin"]))).orderBy(users.id).limit(2001);
  const rows = [...new Map(memberships.map(row => [row.userId, row])).values()];
  if (rows.length > 1000) throw disciplineError(422, "ACCESS_DIRECTORY_LIMIT", "The administrator directory exceeds 1,000 entries");
  const access = await tx.select().from(grants).where(eq(grants.schoolId, actor.schoolId));
  return { staff: rows.map(row => { const grant = access.find(g => g.userId === row.userId); return { userId: row.userId,
    name: `${row.firstName || ""} ${row.lastName || ""}`.trim() || "School staff", email: row.email, enabled: grant?.enabled === true, revision: grant?.revision ?? 0 }; }) };
});
export async function setDisciplineAccess(actor: DisciplineActor, userId: string, raw: unknown) {
  const input = disciplineAccessInput.parse(raw), fingerprint = myDeskSha256(Buffer.from(JSON.stringify([userId, input.enabled, input.revision])));
  return withDiscipline(actor, async (tx, identity) => {
    if (!identity.manager) throw disciplineError(403, "ACCESS_MANAGEMENT_REQUIRED", "A school administrator is required");
    const eligible = await tx.select({ id: schoolMemberships.id }).from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, actor.schoolId),
      eq(schoolMemberships.userId, userId), eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, ["admin", "school_admin"]))).for("share");
    if (!eligible.length) throw disciplineError(404, "STAFF_NOT_FOUND", "An active administrator in this school is required");
    const where = and(eq(grants.schoolId, actor.schoolId), eq(grants.userId, userId));
    const [previous] = await tx.select().from(grants).where(where).for("update");
    const receipt = previous?.mutationReceipts.find(x => x.id === input.clientRequestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw disciplineError(409, "REQUEST_CONFLICT", "This request identifier was already used");
      return { userId, enabled: previous!.enabled, revision: previous!.revision };
    }
    if ((previous?.revision ?? 0) !== input.revision) throw disciplineError(409, "REVISION_CONFLICT", "This permission changed. Refresh before saving");
    const revision = input.revision + 1;
    const values = { enabled: input.enabled, revision, updatedBy: actor.authorId, updatedAt: new Date(),
      mutationReceipts: [...(previous?.mutationReceipts || []), { id: input.clientRequestId, fingerprint, revision }].slice(-100) };
    if (previous) await tx.update(grants).set(values).where(where);
    else await tx.insert(grants).values({ schoolId: actor.schoolId, userId, ...values });
    await disciplineAudit(tx, actor, input.enabled ? "access.granted" : "access.revoked", userId, { userId, revision, selfGrant: actor.authorId === userId });
    return { userId, enabled: input.enabled, revision };
  }, true);
}
