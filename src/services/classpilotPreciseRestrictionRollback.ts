import { createHash } from "node:crypto";
import { emptyAutomaticFlightPathState, type AutomaticFlightPathPolicy, type AutomaticFlightPathState } from "./classpilotAutomaticFlightPath.js";

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
 * Presence rule, matching the delivery fence: any `resource` or `classroomScope`
 * key on a screen lock or `resources` key on a Flight Path, active or not, in the stored
 * snapshot, its legacy flat shape, or the class snapshot Coverage keeps for
 * restoration. `strict` jsonpath never unwraps arrays, like the transform.
 */
const PRECISE_CONTROL_STATE_PATHS = [
  "$.restrictions.screenLock.resource",
  "$.restrictions.screenLock.classroomScope",
  "$.restrictions.flightPath.resources",
  "$.restrictions.flightPath.classroomMaterials",
  "$.restrictions.screenLock.classroomMaterials",
  "$.screenLock.resource",
  "$.screenLock.classroomScope",
  "$.flightPath.resources",
  "$.flightPath.classroomMaterials",
  "$.screenLock.classroomMaterials",
  "$.restorableClassState.desiredState.restrictions.screenLock.resource",
  "$.restorableClassState.desiredState.restrictions.screenLock.classroomScope",
  "$.restorableClassState.desiredState.restrictions.flightPath.resources",
  "$.restorableClassState.desiredState.restrictions.flightPath.classroomMaterials",
  "$.restorableClassState.desiredState.restrictions.screenLock.classroomMaterials",
  "$.restorableClassState.desiredState.screenLock.resource",
  "$.restorableClassState.desiredState.screenLock.classroomScope",
  "$.restorableClassState.desiredState.flightPath.resources",
  "$.restorableClassState.desiredState.flightPath.classroomMaterials",
  "$.restorableClassState.desiredState.screenLock.classroomMaterials",
] as const;

export const PRECISE_CONTROL_STATE_PREDICATE_SQL = PRECISE_CONTROL_STATE_PATHS
  .map((path) => `desired_state @? 'strict ${path}'`)
  .join("\n   OR ");

export const PRECISE_CLASSROOM_STATE_PREDICATE_SQL = [
  "cleared_at IS NULL",
  "AND ((state_type = 'screen-lock' AND (payload ? 'resource' OR payload ? 'classroomScope' OR payload ? 'classroomMaterials'))",
  "  OR (state_type = 'flight-path' AND (payload ? 'resources' OR payload ? 'classroomMaterials')))",
].join("\n  ");

// Presence catches malformed snapshots as well as valid schema-2 data. A
// disabled policy still holds its content approval until the clear removes it.
export const PRECISE_AUTOMATIC_SESSION_PREDICATE_SQL = "(automatic_flight_path_state->>'schemaVersion' = '2' OR automatic_flight_path_state ? 'perStudentPayloads' OR automatic_flight_path_state->'payload' ? 'classroomMaterials')";
export const PRECISE_AUTOMATIC_POLICY_PREDICATE_SQL = "(automatic_flight_path_policy->>'schemaVersion' = '2' OR automatic_flight_path_policy ? 'classroomAccess')";

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
  "UNION ALL",
  "SELECT 'automatic_session' AS kind, coalesce(teaching_sessions.school_id, groups.school_id) AS school_id, count(*)::int AS row_count",
  "FROM teaching_sessions JOIN groups ON groups.id = teaching_sessions.group_id",
  `WHERE ${PRECISE_AUTOMATIC_SESSION_PREDICATE_SQL}`,
  "GROUP BY coalesce(teaching_sessions.school_id, groups.school_id)",
  "UNION ALL",
  "SELECT 'automatic_policy' AS kind, school_id, count(*)::int AS row_count",
  "FROM groups",
  `WHERE ${PRECISE_AUTOMATIC_POLICY_PREDICATE_SQL}`,
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

function safeRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : 0;
}

/** Remove compiled maps entirely so neither reconciliation nor an older image can reuse them. */
export function clearAutomaticClassroomFlightPathState(value: unknown):
  { changed: false; state: unknown } | { changed: true; state: AutomaticFlightPathState } {
  if (!plainObject(value) || !(value.schemaVersion === 2 || hasOwn(value, "perStudentPayloads")
    || plainObject(value.payload) && hasOwn(value.payload, "classroomMaterials")))
    return { changed: false, state: value };
  return { changed: true, state: { ...emptyAutomaticFlightPathState(PRECISE_RESTRICTION_CLEAR_OUTCOME),
    revision: safeRevision(value.revision) + 1, status: "off" } };
}

/** Ordinary automatic website policies remain usable; content approvals require a fresh review after rollback. */
export function clearAutomaticClassroomFlightPathPolicy(value: unknown):
  { changed: false; policy: unknown } | { changed: true; policy: AutomaticFlightPathPolicy } {
  if (!plainObject(value) || !(value.schemaVersion === 2 || hasOwn(value, "classroomAccess")))
    return { changed: false, policy: value };
  return { changed: true, policy: { schemaVersion: 1, revision: safeRevision(value.revision) + 1, enabled: false,
    flightPathId: typeof value.flightPathId === "string" && value.flightPathId ? value.flightPathId : null,
    updatedBy: typeof value.updatedBy === "string" && value.updatedBy ? value.updatedBy : null } };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}

function snapshotHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

type ClearedSnapshot = { next: JsonObject; screenLocks: number; flightPaths: number };

/** Ends a precise Waypoint, Classroom scope or Flight Path on one restrictions object. */
function clearRestrictionObject(container: JsonObject): ClearedSnapshot {
  let next = container;
  let screenLocks = 0;
  let flightPaths = 0;
  const screenLock = container.screenLock;
  if (plainObject(screenLock) && (hasOwn(screenLock, "resource") || hasOwn(screenLock, "classroomScope") || hasOwn(screenLock, "classroomMaterials"))) {
    next = { ...next, screenLock: { active: false } };
    screenLocks += 1;
  }
  const flightPath = container.flightPath;
  if (plainObject(flightPath) && (hasOwn(flightPath, "resources") || hasOwn(flightPath, "classroomMaterials"))) {
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
  automaticSessionStates?: ReadonlyArray<{ id: string; state: unknown }>;
  automaticGroupPolicies?: ReadonlyArray<{ id: string; policy: unknown }>;
}): string {
  const canonical = JSON.stringify({
    version: 1,
    schoolId: input.schoolId,
    controlStates: input.controlStates.map((row) => `${row.id}:${row.revision}`).sort(),
    classroomStates: [...input.classroomStateIds].sort(),
    // Bind complete frozen payloads and grant identities, even if a writer
    // changed JSON without advancing its declared revision.
    automaticSessionStates: (input.automaticSessionStates ?? []).map(row => `${row.id}:${snapshotHash(row.state)}`).sort(),
    automaticGroupPolicies: (input.automaticGroupPolicies ?? []).map(row => `${row.id}:${snapshotHash(row.policy)}`).sort(),
  });
  return `${PRECISE_RESTRICTION_CLEAR_PROOF_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}
