import { auditLogs } from "../schema/shared.js";
import { disciplineError } from "./schoolDisciplineValidation.js";
import { withSharedStudentRecords, assertSharedStudentActor, type SharedStudentActor, type SharedStudentIdentity } from "./sharedStudentRecords.js";
import type { MyDeskDatabase } from "./mydesk.js";

export type DisciplineActor = SharedStudentActor;
export type DisciplineIdentity = SharedStudentIdentity & { canViewSchool: boolean };
export async function assertDisciplineActor(actor: DisciplineActor, tx: MyDeskDatabase): Promise<DisciplineIdentity> {
  const identity = await assertSharedStudentActor(actor, tx);
  return { ...identity, canViewSchool: identity.manager };
}
export async function withDiscipline<T>(actor: DisciplineActor, fn: (tx: MyDeskDatabase, identity: DisciplineIdentity) => Promise<T>, lifecycle = false, consistent = false) {
  try {
    return await withSharedStudentRecords(actor, (tx, identity) => fn(tx, { ...identity, canViewSchool: identity.manager }), { lifecycle, consistent });
  } catch (error) {
    if (error instanceof Error && "code" in error && String(error.code).startsWith("STUDENT_RECORD_")) {
      throw disciplineError("status" in error && typeof error.status === "number" ? error.status : 403,
        String(error.code).slice("STUDENT_RECORD_".length), error.message);
    }
    if (error instanceof Error && "code" in error && error.code === "CLASSPILOT_NOT_ENTITLED") throw disciplineError(403, "SCHOOL_UNAVAILABLE", "Active ClassPilot access is required");
    throw error;
  }
}
export async function disciplineAudit(tx: MyDeskDatabase, actor: DisciplineActor, action: string, id?: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditLogs).values({ schoolId: actor.schoolId, userId: actor.authorId, action: `discipline.${action}`,
    entityType: "discipline_record", entityId: id, metadata });
}
export const disciplineCapabilities = (actor: DisciplineActor) => withDiscipline(actor, async (_tx, identity) => ({
  canSubmit: true, canViewSchool: identity.manager, canManageAccess: false, canCorrectSchool: identity.manager,
  accessPolicy: "current_students", defaultScope: identity.manager ? "school" : "assigned" }));
/** Old grant rows remain audit history; no grant can authorize or deny current access. */
export const listDisciplineAccess = (actor: DisciplineActor) => withDiscipline(actor, async () => {
  throw disciplineError(410, "ACCESS_RETIRED", "School administrators now have automatic discipline access");
});
export const setDisciplineAccess = (actor: DisciplineActor, _userId: string, _raw: unknown) => listDisciplineAccess(actor);
