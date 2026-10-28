import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "../db.js";
import { classpilotCommands, classpilotCommandTargets,
  type ClasspilotStudentControlState } from "../schema/classpilot.js";
import { auditLogs } from "../schema/shared.js";
import { schoolMemberships } from "../schema/core.js";
import { focusAssignmentMatches, focusRecord, readFocusAssignment } from "./classpilotFocus.js";
import { cancelClasspilotFocusOpenIntents, stopClasspilotFocusStateLocked } from "./classpilotFocusPersistence.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { requireScheduledClassroomContext } from "./classpilotActivityAuthority.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { getClasspilotStudentControlState, hasCurrentClasspilotStudentControlAuthority,
  isAuthorizedClasspilotSessionStaff, lockClasspilotStudentControlAuthorities } from "./storage.js";

type Database = typeof db;

async function retirePendingFocusTargetsLocked(database: Database, schoolId: string, studentId: string) {
  await cancelClasspilotFocusOpenIntents(database, schoolId, [studentId], undefined, undefined, "TAB_FOCUS_RETIRED");
  const retired = await database.execute<{ commandId: string }>(sql`
    UPDATE classpilot_command_targets target SET status='unavailable', error_message='TAB_FOCUS_RETIRED', updated_at=now()
    WHERE target.school_id=${schoolId} AND target.student_id=${studentId}
      AND target.status IN ('requested','sent','received') AND EXISTS (
        SELECT 1 FROM classpilot_commands command WHERE command.school_id=target.school_id AND command.id=target.command_id
        AND (command.command_type='focus-tab' OR (command.command_type='open-tab' AND command.command_payload->>'focusAfterOpen'='true')))
    RETURNING target.command_id AS "commandId"`);
  if (retired.rows.length) {
    const { updateClasspilotCommandSummary } = await import("./storage.js");
    for (const commandId of new Set(retired.rows.map(row => row.commandId)))
      await updateClasspilotCommandSummary(commandId, database);
  }
}

/** Tombstones and inactive ACK status are deliberately excluded: a completed
 * retirement is not another candidate on every heartbeat or scheduler tick. */
export function hasRetirableClasspilotFocus(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  const desired = focusRecord(value);
  const restrictions = focusRecord(desired.restrictions ?? desired);
  return Object.hasOwn(desired, "focusAssignmentV1") || Object.hasOwn(restrictions, "focus")
    || (Object.hasOwn(desired, "restorableClassState")
      && hasRetirableClasspilotFocus(focusRecord(desired.restorableClassState).desiredState, depth + 1));
}

/** Removal only. Caller already holds school entitlement and student-control
 * locks. The optional row is the caller's just-read locked delivery snapshot,
 * so ordinary heartbeat traffic performs no extra database query. */
export async function retireLegacyTabFocusForStudentLocked(database: Database, options: {
  schoolId: string; studentId: string; state?: ClasspilotStudentControlState | null;
  now?: Date; reason: "scheduler" | "reconnect" | "website_focus";
  allowDelivery?: boolean;
}): Promise<ClasspilotStudentControlState | undefined> {
  const current = options.state === undefined
    ? await getClasspilotStudentControlState(options.schoolId, options.studentId, database)
    : options.state ?? undefined;
  if (!current) return current;
  if (current.schoolId !== options.schoolId || current.studentId !== options.studentId)
    throw new Error("Focus retirement row does not match the locked student");
  if (!hasRetirableClasspilotFocus(current.desiredState)) return current;
  const now = options.now || new Date();
  await retirePendingFocusTargetsLocked(database, options.schoolId, options.studentId);
  const assignment = readFocusAssignment(current.desiredState);
  const lifetime = [current.scheduledEndAt, current.hardExpiresAt].filter((value): value is Date => !!value)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  let deliverable = options.allowDelivery !== false && !!assignment && !!lifetime && lifetime > now
    && focusAssignmentMatches({ assignment, schoolId: current.schoolId, studentId: current.studentId,
      studentSessionId: assignment.studentSessionId, deviceId: assignment.deviceId,
      teachingSessionId: current.teachingSessionId, supervisionContextId: current.supervisionContextId })
    && await hasCurrentClasspilotStudentControlAuthority({ schoolId: current.schoolId, studentId: current.studentId,
      teachingSessionId: current.teachingSessionId, supervisionContextId: current.supervisionContextId,
      ownershipRevision: current.revision }, database);
  if (deliverable && assignment) {
    const [membership] = await database.select({ id: schoolMemberships.id }).from(schoolMemberships).where(and(
      eq(schoolMemberships.schoolId, current.schoolId), eq(schoolMemberships.userId, assignment.ownerId),
      eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, ["teacher", "admin", "school_admin", "office_staff"]),
    )).limit(1).for("share");
    deliverable = !!membership;
  }
  if (deliverable && assignment) {
    if (current.teachingSessionId) {
      deliverable = await isAuthorizedClasspilotSessionStaff(current.schoolId, current.teachingSessionId, assignment.ownerId, database);
    } else {
      try {
        await requireScheduledClassroomContext({ schoolId: current.schoolId,
          supervisionContextId: current.supervisionContextId!, actorId: assignment.ownerId,
          contextAuthorityRevision: assignment.contextAuthorityRevision ?? undefined, lock: true }, database);
      } catch (error) {
        if (!(error && typeof error === "object" && "status" in error && [403, 404, 409].includes(Number(error.status)))) throw error;
        deliverable = false;
      }
    }
  }
  let stop: { commandId: string; targetId: string; studentSessionId: string; deviceId: string } | undefined;
  if (deliverable && assignment) {
    stop = { commandId: randomUUID(), targetId: randomUUID(),
      studentSessionId: assignment.studentSessionId, deviceId: assignment.deviceId };
    // Keep the historical owner attribution; the audit identifies this as a
    // system retirement, never a new teacher request or authority grant.
    await database.insert(classpilotCommands).values({ id: stop.commandId, schoolId: current.schoolId,
      teachingSessionId: current.teachingSessionId, supervisionContextId: current.supervisionContextId,
      teacherId: assignment.ownerId, targetScope: "students", commandType: "stop-focus", commandPayload: {},
      requestedCount: 1, expiresAt: lifetime });
    await database.insert(classpilotCommandTargets).values({ id: stop.targetId, commandId: stop.commandId,
      schoolId: current.schoolId, teachingSessionId: current.teachingSessionId,
      supervisionContextId: current.supervisionContextId, studentId: current.studentId,
      studentSessionId: stop.studentSessionId, deviceId: stop.deviceId,
      result: { frozenControlRevision: current.revision + 1,
        ...(assignment.contextAuthorityRevision ? { scheduledContextAuthorityRevision: assignment.contextAuthorityRevision } : {}) } });
  }
  // Ended/revoked owners receive no fabricated command or delivery authority.
  // Existing session/auth/entitlement finalization remains responsible for their
  // browser release; retaining a saved Focus could otherwise resurrect it.
  const updated = await stopClasspilotFocusStateLocked(database, { state: current, stop, now,
    ...(options.reason === "website_focus" ? { sourceCommandId: current.sourceCommandId } : {}) });
  await database.insert(auditLogs).values({ schoolId: current.schoolId, userId: null,
    action: "classpilot.legacy_tab_focus.retired", entityType: "student_control_state", entityId: current.id,
    metadata: { source: "system", reason: options.reason, revision: updated.revision,
      cleanupQueued: !!stop, ...(stop ? { commandId: stop.commandId } : {}) } });
  return updated;
}

/** Bounded cross-school scan belongs only to the scheduler connection. Every
 * mutation reacquires the canonical school/student locks and re-reads its row. */
export async function retireLegacyTabFocusBatch(database: Database, options: {
  limit?: number; publish?: (schoolId: string, studentIds: string[]) => Promise<unknown>;
} = {}): Promise<{ inspected: number; retired: number }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const candidates = await database.execute<{ schoolId: string; studentId: string }>(sql`
    SELECT DISTINCT "schoolId", "studentId" FROM (
      SELECT school_id AS "schoolId", student_id AS "studentId" FROM classpilot_student_control_states
      WHERE jsonb_path_exists(desired_state, '$.**.focusAssignmentV1')
         OR jsonb_path_exists(desired_state, '$.**.restrictions.focus')
         OR desired_state ? 'focus'
      UNION
      SELECT school_id AS "schoolId", student_id AS "studentId" FROM classpilot_command_targets
      WHERE result->'focusOpenIntentV1'->>'state' = 'pending'
      UNION
      SELECT target.school_id AS "schoolId", target.student_id AS "studentId" FROM classpilot_command_targets target
      JOIN classpilot_commands command ON command.id=target.command_id AND command.school_id=target.school_id
      WHERE target.status IN ('requested','sent','received') AND
        (command.command_type='focus-tab' OR (command.command_type='open-tab' AND command.command_payload->>'focusAfterOpen'='true'))
    ) candidates ORDER BY "schoolId", "studentId" LIMIT ${limit}`);
  let retired = 0;
  const changed = new Map<string, string[]>();
  for (const candidate of candidates.rows) {
    const didChange = await database.transaction(async (tx) => {
      if (!await lockStaffAssignmentLifecycleSchool(tx, candidate.schoolId, { includeDeleted: true })) return false;
      const transactionDb = tx as unknown as Database;
      let entitled = true;
      try { await assertClasspilotEntitled(candidate.schoolId, transactionDb, { lock: true }); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "CLASSPILOT_NOT_ENTITLED")) throw error;
        entitled = false;
      }
      await lockClasspilotStudentControlAuthorities(candidate.schoolId, [candidate.studentId], transactionDb);
      await retirePendingFocusTargetsLocked(transactionDb, candidate.schoolId, candidate.studentId);
      const current = await getClasspilotStudentControlState(candidate.schoolId, candidate.studentId, transactionDb);
      const updated = await retireLegacyTabFocusForStudentLocked(transactionDb, { ...candidate, state: current ?? null,
        reason: "scheduler", allowDelivery: entitled });
      return !!current && !!updated && current.revision !== updated.revision;
    });
    if (didChange) {
      retired++;
      changed.set(candidate.schoolId, [...(changed.get(candidate.schoolId) || []), candidate.studentId]);
    }
  }
  for (const [schoolId, studentIds] of changed) {
    // Durable state is committed even if an offline relay cannot be reached.
    try { await options.publish?.(schoolId, studentIds); } catch { /* next heartbeat reconciles */ }
  }
  return { inspected: candidates.rows.length, retired };
}
