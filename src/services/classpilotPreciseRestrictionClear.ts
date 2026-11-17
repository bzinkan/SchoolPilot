import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db from "../db.js";
import {
  classpilotClassroomStates,
  classpilotStudentControlStates,
  classpilotSessionStudents,
  groups,
  teachingSessions,
} from "../schema/classpilot.js";
import { preciseRestrictionResourcesActive } from "./classpilotPreciseRestrictions.js";
import {
  PRECISE_CLASSROOM_STATE_PREDICATE_SQL,
  PRECISE_CONTROL_STATE_PREDICATE_SQL,
  PRECISE_AUTOMATIC_POLICY_PREDICATE_SQL,
  PRECISE_AUTOMATIC_SESSION_PREDICATE_SQL,
  PRECISE_RESTRICTION_CLEAR_OUTCOME,
  PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL,
  clearPreciseRestrictionsFromDesiredState,
  clearAutomaticClassroomFlightPathPolicy,
  clearAutomaticClassroomFlightPathState,
  preciseRestrictionClearProof,
} from "./classpilotPreciseRestrictionRollback.js";
import { lockClasspilotStudentControlAuthorities } from "./storage.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";

/**
 * Roadmap PR 2 rollback support. Before an image older than
 * preciseRestrictionResourcesV1 is restored, every stored precise Waypoint
 * and Flight Path is ended explicitly with a control-revision bump, so no
 * stored state carries a `resource`/`resources` key any more. Flight Path
 * definitions (flight_paths.resources) are teacher data and are never touched.
 * The reviewed SQL precheck and the transform live in the pure
 * classpilotPreciseRestrictionRollback.ts.
 */

function clearError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

async function preciseControlStateRows(
  schoolId: string,
  dbInstance: typeof db,
  lock: boolean
) {
  const query = dbInstance
    .select({
      id: classpilotStudentControlStates.id,
      studentId: classpilotStudentControlStates.studentId,
      revision: classpilotStudentControlStates.revision,
      desiredState: classpilotStudentControlStates.desiredState,
    })
    .from(classpilotStudentControlStates)
    .where(and(
      eq(classpilotStudentControlStates.schoolId, schoolId),
      sql.raw(`(${PRECISE_CONTROL_STATE_PREDICATE_SQL})`)
    ));
  return lock ? query.for("update") : query;
}

async function preciseClassroomStateIds(
  schoolId: string,
  dbInstance: typeof db,
  lock: boolean
): Promise<string[]> {
  const query = dbInstance
    .select({ id: classpilotClassroomStates.id })
    .from(classpilotClassroomStates)
    .where(and(
      eq(classpilotClassroomStates.schoolId, schoolId),
      sql.raw(`(${PRECISE_CLASSROOM_STATE_PREDICATE_SQL})`)
    ));
  return (await (lock ? query.for("update") : query)).map((row) => row.id);
}

async function automaticSessionStates(schoolId: string, dbInstance: typeof db, lock: boolean) {
  const query = dbInstance.select({ id: teachingSessions.id, state: teachingSessions.automaticFlightPathState })
    .from(teachingSessions).innerJoin(groups, eq(groups.id, teachingSessions.groupId))
    .where(and(sql`coalesce(${teachingSessions.schoolId}, ${groups.schoolId}) = ${schoolId}`,
      sql.raw(PRECISE_AUTOMATIC_SESSION_PREDICATE_SQL))).orderBy(teachingSessions.id);
  return lock ? query.for("update", { of: teachingSessions }) : query;
}

async function automaticGroupPolicies(schoolId: string, dbInstance: typeof db, lock: boolean) {
  const query = dbInstance.select({ id: groups.id, policy: groups.automaticFlightPathPolicy }).from(groups)
    .where(and(eq(groups.schoolId, schoolId), sql.raw(PRECISE_AUTOMATIC_POLICY_PREDICATE_SQL))).orderBy(groups.id);
  return lock ? query.for("update") : query;
}

export type PreciseRestrictionInventory = Array<{
  schoolId: string;
  controlStateCount: number;
  classroomStateCount: number;
  automaticSessionStateCount: number;
  automaticGroupPolicyCount: number;
}>;

/** Runs the reviewed precheck. Under a tenant context it sees that school only. */
export async function inventoryClasspilotPreciseRestrictions(
  dbInstance: typeof db = db
): Promise<PreciseRestrictionInventory> {
  const result = await dbInstance.execute<{
    kind: string;
    school_id: string;
    row_count: number | string;
  }>(sql.raw(PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL));
  const bySchool = new Map<string, PreciseRestrictionInventory[number]>();
  for (const row of result.rows) {
    const entry = bySchool.get(row.school_id)
      ?? { schoolId: row.school_id, controlStateCount: 0, classroomStateCount: 0, automaticSessionStateCount: 0, automaticGroupPolicyCount: 0 };
    if (row.kind === "control_state") entry.controlStateCount += Number(row.row_count);
    else if (row.kind === "classroom_state") entry.classroomStateCount += Number(row.row_count);
    else if (row.kind === "automatic_session") entry.automaticSessionStateCount += Number(row.row_count);
    else if (row.kind === "automatic_policy") entry.automaticGroupPolicyCount += Number(row.row_count);
    bySchool.set(row.school_id, entry);
  }
  return [...bySchool.values()].sort((left, right) => left.schoolId.localeCompare(right.schoolId));
}

export type PreciseRestrictionClearPlan = {
  schoolId: string;
  controlStateCount: number;
  classroomStateCount: number;
  automaticSessionStateCount: number;
  automaticGroupPolicyCount: number;
  proof: string;
};

/** Dry run for one school: counts plus the proof an execution must quote. */
export async function planClasspilotPreciseRestrictionClear(
  schoolId: string,
  dbInstance: typeof db = db
): Promise<PreciseRestrictionClearPlan> {
  const controlStates = await preciseControlStateRows(schoolId, dbInstance, false);
  const classroomStateIds = await preciseClassroomStateIds(schoolId, dbInstance, false);
  const sessionStates = await automaticSessionStates(schoolId, dbInstance, false);
  const groupPolicies = await automaticGroupPolicies(schoolId, dbInstance, false);
  return {
    schoolId,
    controlStateCount: controlStates.length,
    classroomStateCount: classroomStateIds.length,
    automaticSessionStateCount: sessionStates.length,
    automaticGroupPolicyCount: groupPolicies.length,
    proof: preciseRestrictionClearProof({ schoolId, controlStates, classroomStateIds,
      automaticSessionStates: sessionStates, automaticGroupPolicies: groupPolicies }),
  };
}

export type PreciseRestrictionClearResult = {
  schoolId: string;
  controlStatesCleared: number;
  screenLocksCleared: number;
  flightPathsCleared: number;
  restorableSnapshotsCleared: number;
  classroomStatesCleared: number;
  automaticSessionStatesCleared: number;
  automaticGroupPoliciesDisabled: number;
};

/**
 * Ends every stored precise restriction for one school in one transaction,
 * or changes nothing. Refused while the capability is still active for the
 * school (apply precise-restriction-resources-off first) and when the stored
 * rows no longer match the reviewed dry-run proof. Devices receive the higher
 * revision on their next heartbeat; nothing is published from here.
 */
export async function clearClasspilotPreciseRestrictionsForSchool(
  options: {
    schoolId: string;
    expectedProof: string;
    now?: Date;
    env?: NodeJS.ProcessEnv;
  },
  dbInstance: typeof db = db
): Promise<PreciseRestrictionClearResult> {
  const { schoolId } = options;
  if (preciseRestrictionResourcesActive(schoolId, options.env ?? process.env)) {
    throw clearError(
      "preciseRestrictionResourcesV1 is still active for this school. Apply precise-restriction-resources-off first.",
      "PRECISE_RESTRICTION_CAPABILITY_ACTIVE"
    );
  }
  const now = options.now ?? new Date();
  return dbInstance.transaction(async (tx) => {
    const transactionDb = tx as unknown as typeof db;
    // Serialize class starts and policy saves before taking sorted student
    // authority. Reconciliation takes students before teaching-session rows.
    if (!await lockStaffAssignmentLifecycleSchool(tx, schoolId, { includeDeleted: true }))
      throw clearError("School not found.", "PRECISE_RESTRICTION_CLEAR_INCOMPLETE");
    const candidates = await preciseControlStateRows(schoolId, transactionDb, false);
    const sessionCandidates = await automaticSessionStates(schoolId, transactionDb, false);
    const automaticRoster = sessionCandidates.length ? await tx.select({ studentId: classpilotSessionStudents.studentId })
      .from(classpilotSessionStudents).where(and(eq(classpilotSessionStudents.schoolId, schoolId),
        inArray(classpilotSessionStudents.teachingSessionId, sessionCandidates.map(row => row.id)))) : [];
    const lockedStudentIds = new Set(
      await lockClasspilotStudentControlAuthorities(
        schoolId,
        [...candidates.map((row) => row.studentId), ...automaticRoster.map(row => row.studentId)],
        transactionDb
      )
    );
    const controlStates = await preciseControlStateRows(schoolId, transactionDb, true);
    const classroomStateIds = await preciseClassroomStateIds(schoolId, transactionDb, true);
    const sessionStates = await automaticSessionStates(schoolId, transactionDb, true);
    const groupPolicies = await automaticGroupPolicies(schoolId, transactionDb, true);
    if (
      controlStates.some((row) => !lockedStudentIds.has(row.studentId))
      || preciseRestrictionClearProof({ schoolId, controlStates, classroomStateIds,
        automaticSessionStates: sessionStates, automaticGroupPolicies: groupPolicies })
        !== options.expectedProof
    ) {
      throw clearError(
        "Stored precise restrictions changed after the dry run. Run the dry run again.",
        "PRECISE_RESTRICTION_CLEAR_PROOF_MISMATCH"
      );
    }

    let screenLocksCleared = 0;
    let flightPathsCleared = 0;
    let restorableSnapshotsCleared = 0;
    for (const row of controlStates) {
      const cleared = clearPreciseRestrictionsFromDesiredState(row.desiredState);
      if (!cleared.changed) {
        throw clearError("A precise restriction could not be cleared.", "PRECISE_RESTRICTION_CLEAR_INCOMPLETE");
      }
      const [updated] = await tx
        .update(classpilotStudentControlStates)
        .set({
          desiredState: cleared.desiredState,
          revision: sql`${classpilotStudentControlStates.revision} + 1`,
          // The snapshot no longer matches its source command; a later ACK of
          // the cleared revision must not complete that command's target.
          sourceCommandId: null,
          enforcementHealth: "pending",
          appliedRevision: null,
          lastOutcome: PRECISE_RESTRICTION_CLEAR_OUTCOME,
          lastError: null,
          updatedAt: now,
        })
        .where(and(
          eq(classpilotStudentControlStates.schoolId, schoolId),
          eq(classpilotStudentControlStates.id, row.id),
          eq(classpilotStudentControlStates.revision, row.revision)
        ))
        .returning({ id: classpilotStudentControlStates.id });
      if (!updated) {
        throw clearError("A precise restriction could not be cleared.", "PRECISE_RESTRICTION_CLEAR_INCOMPLETE");
      }
      screenLocksCleared += cleared.clearedScreenLocks;
      flightPathsCleared += cleared.clearedFlightPaths;
      if (cleared.clearedRestorableSnapshot) restorableSnapshotsCleared += 1;
    }

    const classroomStatesCleared = classroomStateIds.length === 0
      ? []
      : await tx
          .update(classpilotClassroomStates)
          .set({ clearedAt: now, updatedAt: now })
          .where(and(
            eq(classpilotClassroomStates.schoolId, schoolId),
            inArray(classpilotClassroomStates.id, classroomStateIds),
            isNull(classpilotClassroomStates.clearedAt)
          ))
          .returning({ id: classpilotClassroomStates.id });

    for (const row of sessionStates) {
      const cleared = clearAutomaticClassroomFlightPathState(row.state);
      if (!cleared.changed) throw clearError("An automatic Classroom snapshot could not be cleared.", "PRECISE_RESTRICTION_CLEAR_INCOMPLETE");
      await tx.update(teachingSessions).set({ automaticFlightPathState: cleared.state })
        .where(eq(teachingSessions.id, row.id));
    }
    for (const row of groupPolicies) {
      const cleared = clearAutomaticClassroomFlightPathPolicy(row.policy);
      if (!cleared.changed) throw clearError("An automatic Classroom approval could not be cleared.", "PRECISE_RESTRICTION_CLEAR_INCOMPLETE");
      await tx.update(groups).set({ automaticFlightPathPolicy: cleared.policy })
        .where(and(eq(groups.schoolId, schoolId), eq(groups.id, row.id)));
    }

    const remainingControlStates = await preciseControlStateRows(schoolId, transactionDb, false);
    const remainingClassroomStates = await preciseClassroomStateIds(schoolId, transactionDb, false);
    const remainingAutomaticStates = await automaticSessionStates(schoolId, transactionDb, false);
    const remainingAutomaticPolicies = await automaticGroupPolicies(schoolId, transactionDb, false);
    if (
      classroomStatesCleared.length !== classroomStateIds.length
      || remainingControlStates.length > 0
      || remainingClassroomStates.length > 0
      || remainingAutomaticStates.length > 0
      || remainingAutomaticPolicies.length > 0
    ) {
      throw clearError("A precise restriction could not be cleared.", "PRECISE_RESTRICTION_CLEAR_INCOMPLETE");
    }
    return {
      schoolId,
      controlStatesCleared: controlStates.length,
      screenLocksCleared,
      flightPathsCleared,
      restorableSnapshotsCleared,
      classroomStatesCleared: classroomStatesCleared.length,
      automaticSessionStatesCleared: sessionStates.length,
      automaticGroupPoliciesDisabled: groupPolicies.length,
    };
  });
}
