import { randomUUID } from "node:crypto";
import type { db } from "../db.js";
import type { ClasspilotStudentControlState } from "../schema/classpilot.js";
import { classpilotCommandAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import { classpilotControlStateExactBinding } from "./classpilotControlStateFrame.js";
import { focusAssignmentMatches, focusRecord, readFocusCleanup } from "./classpilotFocus.js";

type Binding = { schoolId: string; studentId: string; studentSessionId: string; deviceId: string };

/** Narrow cleanup-only command. Never includes a partial restriction snapshot. */
export function classpilotFocusCleanupFrame(options: { state: ClasspilotStudentControlState;
  binding: Binding; acceptedCapabilities: readonly string[]; authorityCurrent: boolean; now?: Date }) {
  const { state, binding } = options;
  const cleanup = readFocusCleanup(state.desiredState);
  const lifetime = [state.scheduledEndAt, state.hardExpiresAt].filter((date): date is Date => date instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  if (!options.authorityCurrent || !cleanup || !lifetime || lifetime <= (options.now || new Date())
    || !options.acceptedCapabilities.includes("scopedAuthorityChecksV1")
    || focusRecord(focusRecord(state.desiredState).restrictions).focus !== undefined
    || cleanup.revisionAtAssignment > state.revision
    || !focusAssignmentMatches({ assignment: cleanup, ...binding,
      teachingSessionId: state.teachingSessionId, supervisionContextId: state.supervisionContextId })) return null;
  const envelope = { studentId: binding.studentId, studentSessionId: binding.studentSessionId,
    exactBinding: classpilotControlStateExactBinding({ ...binding, controlRevision: state.revision }),
    ...(cleanup.contextAuthorityRevision ? { contextAuthorityRevision: cleanup.contextAuthorityRevision } : {}),
    deliveryPolicy: "persistent_control" as const, expiresAt: lifetime.toISOString() };
  return { type: "remote-control", _msgId: randomUUID(), commandId: cleanup.sourceCommandId, ...envelope,
    command: { type: "stop-focus", commandId: cleanup.sourceCommandId, ...envelope,
      ...classpilotCommandAuthorityEnvelope(state), data: {} } };
}

/** Call while the canonical entitlement/student-control/exact-binding locks are
 * held. A stored tombstone is recovery evidence, never fresh actor authority. */
export async function prepareClasspilotFocusCleanupFrame(database: typeof db,
  state: ClasspilotStudentControlState | null | undefined, binding: Binding, acceptedCapabilities: readonly string[]) {
  const cleanup = state && readFocusCleanup(state.desiredState);
  if (!state || !cleanup) return null;
  const { hasCurrentClasspilotStudentControlAuthority, isAuthorizedClasspilotSessionStaff } = await import("./storage.js");
  const authorityCurrent = await hasCurrentClasspilotStudentControlAuthority({ ...binding,
    teachingSessionId: state.teachingSessionId, supervisionContextId: state.supervisionContextId,
    ownershipRevision: state.revision }, database);
  if (!authorityCurrent) return null;
  if (state.teachingSessionId) {
    if (!(await isAuthorizedClasspilotSessionStaff(binding.schoolId, state.teachingSessionId, cleanup.ownerId, database))) return null;
  } else {
    const { requireScheduledClassroomContext } = await import("./classpilotActivityAuthority.js");
    try { await requireScheduledClassroomContext({ schoolId: binding.schoolId, supervisionContextId: state.supervisionContextId!,
      actorId: cleanup.ownerId, contextAuthorityRevision: cleanup.contextAuthorityRevision ?? undefined, lock: true }, database); }
    catch { return null; }
  }
  const { assertClasspilotEntitled } = await import("./classpilotEntitlement.js");
  try { await assertClasspilotEntitled(binding.schoolId, database, { lock: true }); }
  catch { return null; }
  return classpilotFocusCleanupFrame({ state, binding, acceptedCapabilities, authorityCurrent });
}
