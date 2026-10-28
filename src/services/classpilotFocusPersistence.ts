import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { db } from "../db.js";
import { classpilotCommands, classpilotCommandTargets, classpilotStudentControlStates,
  type ClasspilotCommand, type ClasspilotCommandTarget, type ClasspilotStudentControlState } from "../schema/classpilot.js";
import { schoolMemberships } from "../schema/core.js";
import { classpilotRealtimeFresh, readClasspilotRealtimeStatusBatch } from "./classpilotRealtimeStatus.js";
import { hasCurrentClasspilotStudentControlAuthority, isAuthorizedClasspilotSessionStaff,
  getClasspilotStudentControlState, getClasspilotSsoPolicyForSchool } from "./storage.js";
import { serializeClasspilotStudentControlStateForDelivery } from "./classpilotClassroomState.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { requireScheduledClassroomContext } from "./classpilotActivityAuthority.js";
import { assertClasspilotEntitled } from "./classpilotEntitlement.js";
import { assertLegacyTabFocusNotRetired, isLegacyTabFocusStart, focusAssignmentMatches, focusAuthoringEnabled, focusCapabilityAccepted, focusOpenReceiptSchema, focusRecord,
  focusServerOrigin, readFocusAssignment, readFocusCleanup, readFocusOpenIntent, readFocusRestriction, withoutClasspilotFocus,
  type ClasspilotExactTabTarget, type ClasspilotFocusAssignment, type ClasspilotFocusOpenIntent } from "./classpilotFocus.js";

type Database = typeof db;

function scopeMatches(state: ClasspilotStudentControlState, command: ClasspilotCommand): boolean {
  return state.teachingSessionId === command.teachingSessionId
    && state.supervisionContextId === command.supervisionContextId;
}

function assignmentFor(command: ClasspilotCommand, target: ClasspilotCommandTarget,
  revision: number, assignmentId = randomUUID()): ClasspilotFocusAssignment {
  return { version: 1, assignmentId, schoolId: command.schoolId, studentId: target.studentId,
    studentSessionId: target.studentSessionId!, deviceId: target.deviceId!, serverOrigin: focusServerOrigin(),
    teachingSessionId: command.teachingSessionId, supervisionContextId: command.supervisionContextId,
    ownerId: command.teacherId,
    contextAuthorityRevision: typeof focusRecord(target.result).scheduledContextAuthorityRevision === "string"
      ? String(focusRecord(target.result).scheduledContextAuthorityRevision) : null,
    sourceCommandId: command.id, sourceTargetId: target.id, revisionAtAssignment: revision };
}

async function writeFocus(database: Database, state: ClasspilotStudentControlState,
  commandId: string | null, desiredState: Record<string, unknown>, now: Date): Promise<ClasspilotStudentControlState> {
  const [updated] = await database.update(classpilotStudentControlStates).set({ desiredState,
    revision: state.revision + 1, sourceCommandId: commandId, enforcementHealth: "pending",
    appliedRevision: null, lastOutcome: null, lastError: null, lastAcknowledgedAt: null, updatedAt: now,
  }).where(and(eq(classpilotStudentControlStates.id, state.id),
    eq(classpilotStudentControlStates.schoolId, state.schoolId),
    eq(classpilotStudentControlStates.revision, state.revision))).returning();
  if (!updated) throw new Error("Focus authority changed inside the locked transaction");
  return updated;
}

export async function cancelClasspilotFocusOpenIntents(database: Database, schoolId: string,
  studentIds: readonly string[], scope?: { teachingSessionId: string | null; supervisionContextId: string | null },
  binding?: { studentSessionId: string; deviceId: string }, errorCode = "FOCUS_INTENT_CANCELLED"): Promise<void> {
  if (!studentIds.length) return;
  const targets = await database.select({ target: classpilotCommandTargets, command: classpilotCommands })
    .from(classpilotCommandTargets).innerJoin(classpilotCommands,
      and(eq(classpilotCommands.id, classpilotCommandTargets.commandId), eq(classpilotCommands.schoolId, schoolId)))
    .where(and(eq(classpilotCommandTargets.schoolId, schoolId), inArray(classpilotCommandTargets.studentId, [...studentIds]),
      sql`${classpilotCommandTargets.result}->'focusOpenIntentV1'->>'state' = 'pending'`));
  for (const { target, command } of targets) {
    if (scope && (scope.teachingSessionId !== command.teachingSessionId
      || scope.supervisionContextId !== command.supervisionContextId)) continue;
    const intent = readFocusOpenIntent(target.result);
    if (!intent) {
      // Retirement is terminal even for a malformed historical pending intent.
      // Binding-specific lifecycle cleanup cannot infer its missing authority.
      const raw = focusRecord(focusRecord(target.result).focusOpenIntentV1);
      if (!binding && errorCode === "TAB_FOCUS_RETIRED" && raw.state === "pending") {
        await database.update(classpilotCommandTargets).set({ result: { ...focusRecord(target.result),
          focusOpenIntentV1: { ...raw, state: "refused", errorCode } }, updatedAt: new Date() })
          .where(eq(classpilotCommandTargets.id, target.id));
      }
      continue;
    }
    if (binding && (intent.binding.studentSessionId !== binding.studentSessionId
      || intent.binding.deviceId !== binding.deviceId)) continue;
    await database.update(classpilotCommandTargets).set({ result: { ...focusRecord(target.result),
      focusOpenIntentV1: { ...intent, state: "refused", errorCode } }, updatedAt: new Date() })
      .where(eq(classpilotCommandTargets.id, target.id));
  }
}

/** Shared removal primitive. Caller holds the school/student control authority
 * locks and has already authorized its teacher command or removal-only lifecycle
 * operation. A real stop command/target is required before minting a tombstone. */
export async function stopClasspilotFocusStateLocked(database: Database, options: {
  state: ClasspilotStudentControlState; now?: Date;
  sourceCommandId?: string | null;
  stop?: { commandId: string; targetId: string; studentSessionId: string | null; deviceId: string | null };
}): Promise<ClasspilotStudentControlState> {
  const { state, stop } = options;
  const cleaned = withoutClasspilotFocus(state.desiredState);
  const assignment = readFocusAssignment(state.desiredState);
  const cleanup = readFocusCleanup(state.desiredState);
  const exact = assignment || cleanup;
  if (stop && exact && stop.studentSessionId && stop.deviceId
    && focusAssignmentMatches({ assignment: exact, schoolId: state.schoolId, studentId: state.studentId,
      studentSessionId: stop.studentSessionId, deviceId: stop.deviceId,
      teachingSessionId: state.teachingSessionId, supervisionContextId: state.supervisionContextId })) {
    cleaned.focusCleanupV1 = assignment ? { ...assignment, sourceCommandId: stop.commandId,
      sourceTargetId: stop.targetId, revisionAtAssignment: state.revision + 1 } : cleanup;
  } else if (!assignment && cleanup) {
    // Saved-state cleanup and repeated recovery never discard an outstanding
    // exact stop receipt. Binding/ownership lifecycle retirement handles it.
    cleaned.focusCleanupV1 = cleanup;
    const status = focusRecord(state.desiredState).focusStatusV1;
    if (focusRecord(status).state === "inactive") cleaned.focusStatusV1 = status;
  }
  return JSON.stringify(cleaned) === JSON.stringify(state.desiredState) ? state
    : writeFocus(database, state, options.sourceCommandId !== undefined ? options.sourceCommandId
      : stop?.commandId ?? state.sourceCommandId, cleaned, options.now || new Date());
}

/** Session end/transfer already holds the sorted student-control lock. */
export async function retireClasspilotFocusForBinding(database: Database, schoolId: string,
  studentId: string, binding: { studentSessionId: string; deviceId: string }): Promise<void> {
  await cancelClasspilotFocusOpenIntents(database, schoolId, [studentId], undefined, binding);
  const current = await getClasspilotStudentControlState(schoolId, studentId, database);
  if (!current) return;
  const { readFocusAssignment } = await import("./classpilotFocus.js");
  const assignment = readFocusAssignment(current.desiredState) || readFocusCleanup(current.desiredState);
  const saved = focusRecord(focusRecord(current.desiredState).restorableClassState);
  const savedAssignment = readFocusAssignment(saved.desiredState) || readFocusCleanup(saved.desiredState);
  const matches = (a: ClasspilotFocusAssignment | null) => !!a
    && a.studentSessionId === binding.studentSessionId && a.deviceId === binding.deviceId;
  if (!matches(assignment) && !matches(savedAssignment)) return;
  // A saved class Focus is retired at delegation, but account for imported
  // feature-aware rows as well without clearing a newer top-level assignment.
  const cleaned = matches(assignment) ? withoutClasspilotFocus(current.desiredState)
    : { ...focusRecord(current.desiredState), restorableClassState: { ...saved,
      desiredState: withoutClasspilotFocus(saved.desiredState) } };
  await writeFocus(database, current, current.sourceCommandId || assignment?.sourceCommandId || savedAssignment!.sourceCommandId,
    cleaned, new Date());
}

/** Called only inside canonical command creation, after its actor/roster/binding
 * and control locks. New Focus state and its immutable command commit together. */
export async function persistClasspilotFocusCommand(database: Database, command: ClasspilotCommand,
  targets: ClasspilotCommandTarget[], now = new Date()): Promise<ClasspilotCommandTarget[]> {
  const payload = focusRecord(command.commandPayload);
  assertLegacyTabFocusNotRetired(command.commandType, payload);
  const exact = command.commandType === "focus-tab" || command.commandType === "activate-tab";
  const chained = command.commandType === "open-tab" && payload.focusAfterOpen === true;
  const stop = command.commandType === "stop-focus";
  if (!exact && !chained && !stop) return targets;
  const evidence = await readClasspilotRealtimeStatusBatch(command.schoolId,
    targets.filter(target => !stop && target.status !== "unavailable" && target.studentSessionId && target.deviceId)
      .map(target => ({ studentId: target.studentId, studentSessionId: target.studentSessionId!, deviceId: target.deviceId! })));
  const rows = Array.isArray(payload.tabTargets) ? payload.tabTargets as ClasspilotExactTabTarget[] : [];
  const updatedTargets: ClasspilotCommandTarget[] = [];
  for (const target of targets) {
    const current = await getClasspilotStudentControlState(command.schoolId, target.studentId, database);
    if (!current || !scopeMatches(current, command)) {
      const [unavailable] = await database.update(classpilotCommandTargets).set({ status: "unavailable",
        errorMessage: "Focus command scope no longer owns this student", updatedAt: now,
      }).where(eq(classpilotCommandTargets.id, target.id)).returning();
      updatedTargets.push(unavailable!); continue;
    }
    if (stop) {
      await cancelClasspilotFocusOpenIntents(database, command.schoolId, [target.studentId], command);
      const state = await stopClasspilotFocusStateLocked(database, { state: current, now,
        stop: { commandId: command.id, targetId: target.id,
          studentSessionId: target.studentSessionId, deviceId: target.deviceId } });
      const [updated] = await database.update(classpilotCommandTargets).set({ result: { ...focusRecord(target.result),
        frozenControlRevision: state.revision }, updatedAt: now }).where(eq(classpilotCommandTargets.id, target.id)).returning();
      updatedTargets.push(updated!);
      continue;
    }
    if (target.status === "unavailable") { updatedTargets.push(target); continue; }
    const read = evidence.get(target.studentId);
    const snapshot = read?.status === "hit" && classpilotRealtimeFresh(read.snapshot, now.getTime()) ? read.snapshot : null;
    const row = rows.find(row => row.studentId === target.studentId);
    const policy = await getClasspilotSsoPolicyForSchool(command.schoolId, database);
    const delivered = serializeClasspilotStudentControlStateForDelivery({ state: current, now,
      gateActive: isClasspilotCapabilityActive("lateSignInRestrictionSsoV1", { schoolId: command.schoolId }),
      acceptedCapabilities: snapshot?.acceptedCapabilities ?? [],
      exactBinding: { schoolId: command.schoolId, studentId: target.studentId,
        studentSessionId: target.studentSessionId!, deviceId: target.deviceId! },
      authPassThrough: { gateActive: isClasspilotCapabilityActive("restrictionAuthPassThroughV1", { schoolId: command.schoolId }),
        policyRevision: policy.revision, policy: policy.policy } });
    const unsupported = !focusAuthoringEnabled(command.schoolId)
      || !snapshot || !focusCapabilityAccepted(snapshot.acceptedCapabilities ?? []);
    const stale = exact && (!row || snapshot?.tabSnapshotRevision !== row.observedRevision
      || !snapshot?.allOpenTabs.some(tab => tab.tabRef === row.tabRef));
    if (unsupported || stale || delivered.withheld) {
      const [unavailable] = await database.update(classpilotCommandTargets).set({ status: "unavailable",
        errorMessage: unsupported ? "TAB_ACTIVATE_CAPABILITY_REQUIRED"
          : stale ? "STALE_TAB_REF" : "FOCUS_RESTRICTION_SNAPSHOT_UNSUPPORTED", updatedAt: now,
      }).where(eq(classpilotCommandTargets.id, target.id)).returning();
      updatedTargets.push(unavailable!); continue;
    }
    let result = focusRecord(target.result);
    if (chained) {
      const assignment = assignmentFor(command, target, current.revision);
      const intent: ClasspilotFocusOpenIntent = { version: 1, assignmentId: assignment.assignmentId,
        childCommandId: randomUUID(), deadline: command.expiresAt!.toISOString(), state: "pending", binding: assignment };
      result = { ...result, frozenControlRevision: current.revision, focusOpenIntentV1: intent };
    } else if (command.commandType === "focus-tab") {
      const assignment = assignmentFor(command, target, current.revision + 1);
      const desired = withoutClasspilotFocus(current.desiredState);
      desired.restrictions = { ...focusRecord(desired.restrictions), focus: { active: true,
        assignmentId: assignment.assignmentId, tabRef: row!.tabRef, observedRevision: row!.observedRevision,
        targetKind: "snapshot", source: "teacher", setAt: now.toISOString() } };
      desired.focusAssignmentV1 = assignment;
      await writeFocus(database, current, command.id, desired, now);
      result = { ...result, focusExactAuthorityV1: assignment, frozenControlRevision: current.revision + 1 };
    } else result = { ...result, focusExactAuthorityV1: assignmentFor(command, target, current.revision),
      frozenControlRevision: current.revision };
    const [updated] = await database.update(classpilotCommandTargets).set({ result, updatedAt: now })
      .where(eq(classpilotCommandTargets.id, target.id)).returning();
    updatedTargets.push(updated!);
  }
  return updatedTargets;
}

/** Consume only a successful authenticated open ACK. Caller holds entitlement,
 * sorted control and source-target locks, and commits the ACK in this same TX. */
export async function consumeClasspilotFocusOpenReceipt(database: Database, command: ClasspilotCommand,
  target: ClasspilotCommandTarget, options: { result: unknown; controlRevision?: number;
    acceptedCapabilities: readonly string[]; now: Date }): Promise<Record<string, unknown> | null> {
  const intent = readFocusOpenIntent(target.result);
  if (!intent || intent.state !== "pending") return null;
  const result = focusRecord(target.result);
  const reject = (errorCode: string, state: "refused" | "expired" = "refused") => ({ ...result,
    focusOpenIntentV1: { ...intent, state, errorCode } });
  if (isLegacyTabFocusStart(command.commandType, command.commandPayload)) return reject("TAB_FOCUS_RETIRED");
  if (Date.parse(intent.deadline) <= options.now.getTime()) return reject("FOCUS_RECEIPT_EXPIRED", "expired");
  const receipt = focusOpenReceiptSchema.safeParse(options.result);
  if (!receipt.success) return reject("FOCUS_RECEIPT_INVALID");
  const current = await getClasspilotStudentControlState(command.schoolId, target.studentId, database);
  if (!current || !scopeMatches(current, command) || current.revision !== intent.binding.revisionAtAssignment
    || options.controlRevision !== current.revision || !focusAuthoringEnabled(command.schoolId)
    || !focusCapabilityAccepted(options.acceptedCapabilities)
    || intent.binding.studentSessionId !== target.studentSessionId || intent.binding.deviceId !== target.deviceId
    || intent.binding.serverOrigin !== focusServerOrigin()
    || !(await hasCurrentClasspilotStudentControlAuthority({ schoolId: command.schoolId, studentId: target.studentId,
      teachingSessionId: command.teachingSessionId, supervisionContextId: command.supervisionContextId,
      ownershipRevision: current.revision }, database))) return reject("FOCUS_AUTHORITY_STALE");
  const evidence = await readClasspilotRealtimeStatusBatch(command.schoolId, [{ studentId: target.studentId,
    studentSessionId: target.studentSessionId!, deviceId: target.deviceId! }]);
  const live = evidence.get(target.studentId);
  if (live?.status !== "hit" || !classpilotRealtimeFresh(live.snapshot, options.now.getTime())
    || !focusCapabilityAccepted(live.snapshot.acceptedCapabilities ?? [])) return reject("TAB_ACTIVATE_CAPABILITY_REQUIRED");
  const [membership] = await database.select({ id: schoolMemberships.id }).from(schoolMemberships).where(and(
    eq(schoolMemberships.schoolId, command.schoolId), eq(schoolMemberships.userId, command.teacherId),
    eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, ["teacher", "admin", "school_admin", "office_staff"]))).limit(1).for("share");
  if (!membership) return reject("FOCUS_ACTOR_STALE");
  if (command.teachingSessionId) {
    if (!(await isAuthorizedClasspilotSessionStaff(command.schoolId, command.teachingSessionId, command.teacherId, database)))
      return reject("FOCUS_ACTOR_STALE");
  } else {
    try { await requireScheduledClassroomContext({ schoolId: command.schoolId,
      supervisionContextId: command.supervisionContextId!, actorId: command.teacherId,
      contextAuthorityRevision: intent.binding.contextAuthorityRevision ?? undefined, lock: true }, database); }
    catch { return reject("FOCUS_ACTOR_STALE"); }
  }
  // Row locks fence mutations, while license/school time limits can elapse
  // during a lock wait. Recheck them at the final child-creation boundary.
  try { await assertClasspilotEntitled(command.schoolId, database, { lock: true }); }
  catch { return reject("FOCUS_AUTHORITY_STALE"); }
  if (Date.parse(intent.deadline) <= Date.now()
    || (current.hardExpiresAt && current.hardExpiresAt <= new Date())
    || (current.scheduledEndAt && current.scheduledEndAt <= new Date())) return reject("FOCUS_RECEIPT_EXPIRED", "expired");
  const childTargetId = randomUUID();
  const assignment = { ...intent.binding, revisionAtAssignment: current.revision + 1,
    sourceCommandId: intent.childCommandId, sourceTargetId: childTargetId };
  const row = { studentId: target.studentId, tabRef: receipt.data.tabRef,
    observedRevision: receipt.data.tabSnapshotRevision };
  await database.insert(classpilotCommands).values({ id: intent.childCommandId, schoolId: command.schoolId,
    teachingSessionId: command.teachingSessionId, supervisionContextId: command.supervisionContextId,
    teacherId: command.teacherId, targetScope: "students", commandType: "focus-tab", commandPayload: { tabTargets: [row] },
    requestedCount: 1, unavailableCount: 0, expiresAt: null });
  await database.insert(classpilotCommandTargets).values({ id: childTargetId, commandId: intent.childCommandId,
    schoolId: command.schoolId, teachingSessionId: command.teachingSessionId, supervisionContextId: command.supervisionContextId,
    studentId: target.studentId, studentSessionId: target.studentSessionId, deviceId: target.deviceId,
    status: "requested", result: { focusExactAuthorityV1: assignment, frozenControlRevision: current.revision + 1 } });
  const desired = withoutClasspilotFocus(current.desiredState);
  desired.restrictions = { ...focusRecord(desired.restrictions), focus: { active: true,
    assignmentId: intent.assignmentId, tabRef: row.tabRef, observedRevision: row.observedRevision,
    targetKind: "open_receipt", source: "teacher", setAt: options.now.toISOString() } };
  desired.focusAssignmentV1 = assignment;
  await writeFocus(database, current, intent.childCommandId, desired, options.now);
  return { ...result, focusOpenIntentV1: { ...intent, state: "committed", childRevision: current.revision + 1 } };
}
