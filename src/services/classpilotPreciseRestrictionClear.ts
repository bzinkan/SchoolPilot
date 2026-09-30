import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import db from "../db.js";
import {
  classpilotClassroomStates,
  classpilotStudentControlStates,
} from "../schema/classpilot.js";
import { preciseRestrictionResourcesActive } from "./classpilotPreciseRestrictions.js";
import {
  PRECISE_CLASSROOM_STATE_PREDICATE_SQL,
  PRECISE_CONTROL_STATE_PREDICATE_SQL,
  PRECISE_RESTRICTION_CLEAR_OUTCOME,
  PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL,
  clearPreciseRestrictionsFromDesiredState,
  preciseRestrictionClearProof,
} from "./classpilotPreciseRestrictionRollback.js";
import { lockClasspilotStudentControlAuthorities } from "./storage.js";

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

export type PreciseRestrictionInventory = Array<{
  schoolId: string;
  controlStateCount: number;
  classroomStateCount: number;
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
  const bySchool = new Map<string, { schoolId: string; controlStateCount: number; classroomStateCount: number }>();
  for (const row of result.rows) {
    const entry = bySchool.get(row.school_id)
      ?? { schoolId: row.school_id, controlStateCount: 0, classroomStateCount: 0 };
    if (row.kind === "control_state") entry.controlStateCount += Number(row.row_count);
    else entry.classroomStateCount += Number(row.row_count);
    bySchool.set(row.school_id, entry);
  }
  return [...bySchool.values()].sort((left, right) => left.schoolId.localeCompare(right.schoolId));
}

export type PreciseRestrictionClearPlan = {
  schoolId: string;
  controlStateCount: number;
  classroomStateCount: number;
  proof: string;
};

/** Dry run for one school: counts plus the proof an execution must quote. */
export async function planClasspilotPreciseRestrictionClear(
  schoolId: string,
  dbInstance: typeof db = db
): Promise<PreciseRestrictionClearPlan> {
  const controlStates = await preciseControlStateRows(schoolId, dbInstance, false);
  const classroomStateIds = await preciseClassroomStateIds(schoolId, dbInstance, false);
  return {
    schoolId,
    controlStateCount: controlStates.length,
    classroomStateCount: classroomStateIds.length,
    proof: preciseRestrictionClearProof({ schoolId, controlStates, classroomStateIds }),
  };
}

export type PreciseRestrictionClearResult = {
  schoolId: string;
  controlStatesCleared: number;
  screenLocksCleared: number;
  flightPathsCleared: number;
  restorableSnapshotsCleared: number;
  classroomStatesCleared: number;
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
    const candidates = await preciseControlStateRows(schoolId, transactionDb, false);
    const lockedStudentIds = new Set(
      await lockClasspilotStudentControlAuthorities(
        schoolId,
        candidates.map((row) => row.studentId),
        transactionDb
      )
    );
    const controlStates = await preciseControlStateRows(schoolId, transactionDb, true);
    const classroomStateIds = await preciseClassroomStateIds(schoolId, transactionDb, true);
    if (
      controlStates.some((row) => !lockedStudentIds.has(row.studentId))
      || preciseRestrictionClearProof({ schoolId, controlStates, classroomStateIds })
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

    const remainingControlStates = await preciseControlStateRows(schoolId, transactionDb, false);
    const remainingClassroomStates = await preciseClassroomStateIds(schoolId, transactionDb, false);
    if (
      classroomStatesCleared.length !== classroomStateIds.length
      || remainingControlStates.length > 0
      || remainingClassroomStates.length > 0
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
    };
  });
}
