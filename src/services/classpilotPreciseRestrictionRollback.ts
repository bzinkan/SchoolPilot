import { createHash } from "node:crypto";

/**
 * Pure part of the roadmap PR 2 rollback clear: the reviewed SQL precheck,
 * the desired-state transform and the dry-run proof. The database side is
 * src/services/classpilotPreciseRestrictionClear.ts and the operator entry
 * point is src/cli/clearClasspilotPreciseRestrictions.ts.
 *
 * The rollout runbook (docs/CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md) quotes the
 * precheck verbatim and a test pins that, so the SQL an operator reviews is
 * exactly the SQL the clear runs.
 */

export const PRECISE_RESTRICTION_CLEAR_OUTCOME = "precise_restriction_cleared";
export const PRECISE_RESTRICTION_CLEAR_PROOF_PREFIX = "precise-clear-proof-v1:";

/**
 * Presence rule, matching the PR 2-pre fence: any `resource` key on a screen
 * lock or `resources` key on a Flight Path, active or not, in the stored
 * snapshot, its legacy flat shape, or the class snapshot Coverage keeps for
 * restoration. `strict` jsonpath never unwraps arrays, like the transform.
 */
const PRECISE_CONTROL_STATE_PATHS = [
  "$.restrictions.screenLock.resource",
  "$.restrictions.flightPath.resources",
  "$.screenLock.resource",
  "$.flightPath.resources",
  "$.restorableClassState.desiredState.restrictions.screenLock.resource",
  "$.restorableClassState.desiredState.restrictions.flightPath.resources",
  "$.restorableClassState.desiredState.screenLock.resource",
  "$.restorableClassState.desiredState.flightPath.resources",
] as const;

export const PRECISE_CONTROL_STATE_PREDICATE_SQL = PRECISE_CONTROL_STATE_PATHS
  .map((path) => `desired_state @? 'strict ${path}'`)
  .join("\n   OR ");

export const PRECISE_CLASSROOM_STATE_PREDICATE_SQL = [
  "cleared_at IS NULL",
  "AND ((state_type = 'screen-lock' AND payload ? 'resource')",
  "  OR (state_type = 'flight-path' AND payload ? 'resources'))",
].join("\n  ");

/** Read-only, counts only. Zero rows means no stored precise restriction remains. */
export const PRECISE_RESTRICTION_ROLLBACK_PRECHECK_SQL = [
  "SELECT 'control_state' AS kind, school_id, count(*)::int AS row_count",
  "FROM classpilot_student_control_states",
  `WHERE ${PRECISE_CONTROL_STATE_PREDICATE_SQL}`,
  "GROUP BY school_id",
  "UNION ALL",
  "SELECT 'classroom_state' AS kind, school_id, count(*)::int AS row_count",
  "FROM classpilot_classroom_states",
  `WHERE ${PRECISE_CLASSROOM_STATE_PREDICATE_SQL}`,
  "GROUP BY school_id",
  "ORDER BY kind, school_id",
].join("\n");

type JsonObject = Record<string, unknown>;

function plainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

type ClearedSnapshot = { next: JsonObject; screenLocks: number; flightPaths: number };

/** Ends a precise Waypoint / Flight Path held directly on one restrictions object. */
function clearRestrictionObject(container: JsonObject): ClearedSnapshot {
  let next = container;
  let screenLocks = 0;
  let flightPaths = 0;
  const screenLock = container.screenLock;
  if (plainObject(screenLock) && hasOwn(screenLock, "resource")) {
    next = { ...next, screenLock: { active: false } };
    screenLocks += 1;
  }
  const flightPath = container.flightPath;
  if (plainObject(flightPath) && hasOwn(flightPath, "resources")) {
    next = { ...next, flightPath: { active: false, allowedDomains: [] } };
    flightPaths += 1;
  }
  return { next, screenLocks, flightPaths };
}

/** One desired snapshot: its `restrictions` object and the legacy flat shape. */
function clearDesiredSnapshot(snapshot: JsonObject): ClearedSnapshot {
  let next = snapshot;
  let screenLocks = 0;
  let flightPaths = 0;
  if (plainObject(snapshot.restrictions)) {
    const inner = clearRestrictionObject(snapshot.restrictions);
    if (inner.screenLocks + inner.flightPaths > 0) {
      next = { ...next, restrictions: inner.next };
      screenLocks += inner.screenLocks;
      flightPaths += inner.flightPaths;
    }
  }
  const flat = clearRestrictionObject(next);
  if (flat.screenLocks + flat.flightPaths > 0) {
    next = flat.next;
    screenLocks += flat.screenLocks;
    flightPaths += flat.flightPaths;
  }
  return { next, screenLocks, flightPaths };
}

export type PreciseRestrictionDesiredStateClear = {
  desiredState: unknown;
  changed: boolean;
  clearedScreenLocks: number;
  clearedFlightPaths: number;
  clearedRestorableSnapshot: boolean;
};

/**
 * Pure. Replaces every precise screen lock with `{ active: false }` and every
 * precise Flight Path with `{ active: false, allowedDomains: [] }` (the shapes
 * unlock-screen and remove-flight-path produce), in the snapshot and in the
 * Coverage restoration snapshot. Every other restriction, including a website
 * Waypoint or website Flight Path, is kept exactly. A precise entry is never
 * narrowed to its websites: the restriction ends visibly instead of changing
 * silently, which matches how the dispatcher refuses (never degrades) a
 * precise Flight Path once the capability is off.
 */
export function clearPreciseRestrictionsFromDesiredState(
  value: unknown
): PreciseRestrictionDesiredStateClear {
  const unchanged = {
    desiredState: value,
    changed: false,
    clearedScreenLocks: 0,
    clearedFlightPaths: 0,
    clearedRestorableSnapshot: false,
  };
  if (!plainObject(value)) return unchanged;
  const top = clearDesiredSnapshot(value);
  let desiredState = top.next;
  let clearedScreenLocks = top.screenLocks;
  let clearedFlightPaths = top.flightPaths;
  let clearedRestorableSnapshot = false;
  const restorable = desiredState.restorableClassState;
  if (plainObject(restorable) && plainObject(restorable.desiredState)) {
    const nested = clearDesiredSnapshot(restorable.desiredState);
    if (nested.screenLocks + nested.flightPaths > 0) {
      // The restored snapshot no longer matches its source command, so a later
      // ACK must not complete that command's target.
      desiredState = {
        ...desiredState,
        restorableClassState: { ...restorable, desiredState: nested.next, sourceCommandId: null },
      };
      clearedScreenLocks += nested.screenLocks;
      clearedFlightPaths += nested.flightPaths;
      clearedRestorableSnapshot = true;
    }
  }
  if (clearedScreenLocks + clearedFlightPaths === 0) return unchanged;
  return {
    desiredState,
    changed: true,
    clearedScreenLocks,
    clearedFlightPaths,
    clearedRestorableSnapshot,
  };
}

export function preciseRestrictionClearProof(input: {
  schoolId: string;
  controlStates: ReadonlyArray<{ id: string; revision: number }>;
  classroomStateIds: readonly string[];
}): string {
  const canonical = JSON.stringify({
    version: 1,
    schoolId: input.schoolId,
    controlStates: input.controlStates.map((row) => `${row.id}:${row.revision}`).sort(),
    classroomStates: [...input.classroomStateIds].sort(),
  });
  return `${PRECISE_RESTRICTION_CLEAR_PROOF_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}
