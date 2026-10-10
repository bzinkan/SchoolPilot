import type db from "../db.js";
import { classpilotCommandAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import {
  classpilotCommandDeliveryPolicy,
  isClasspilotReplayableTransientCommandType,
} from "./classpilotCommandDelivery.js";
import {
  classpilotCommandFrameForTarget,
  classpilotPersistedTargetAuthorityRevisions,
  type ResolvedClasspilotCommandTarget,
} from "./classpilotCommandDispatcher.js";
import {
  listClasspilotReplayableTransientCommandTargets,
  type ClasspilotTransientCommandExactBinding,
} from "./storage.js";

/** Newest pending timer/poll targets considered per auth-success. */
export const CLASSPILOT_TRANSIENT_REPLAY_LIMIT = 20;

export type ClasspilotTransientReplayFrame = NonNullable<ReturnType<typeof classpilotCommandFrameForTarget>>;

/**
 * Remote-control frames for this exact binding's un-received, unexpired
 * timer/poll targets, oldest first. Each frame is rebuilt with the
 * dispatcher's own frame builder from the persisted command payload and target
 * row, so it carries the same binding and authority envelope the original
 * dispatch produced, with a fresh `_msgId`.
 *
 * Runs inside the student WebSocket bootstrap transaction (same student-control
 * lock as command persistence); the caller's synchronous delivery callback only
 * `ws.send()`s the result after `auth-success`. Target status is untouched: the
 * device's `received` ACK remains the only receipt, and a target the device
 * already acknowledged is never selected.
 */
export async function prepareClasspilotTransientCommandReplay(
  binding: ClasspilotTransientCommandExactBinding,
  transactionDb: typeof db,
): Promise<ClasspilotTransientReplayFrame[]> {
  const pending = await listClasspilotReplayableTransientCommandTargets(
    binding,
    transactionDb,
    { limit: CLASSPILOT_TRANSIENT_REPLAY_LIMIT },
  );
  const frames: ClasspilotTransientReplayFrame[] = [];
  for (const { command, target } of pending) {
    if (!isClasspilotReplayableTransientCommandType(command.commandType)) continue;
    if (!target.studentSessionId || !target.deviceId) continue;
    const payload = command.commandPayload
      && typeof command.commandPayload === "object"
      && !Array.isArray(command.commandPayload)
      ? command.commandPayload as Record<string, unknown>
      : {};
    const resolvedTarget: ResolvedClasspilotCommandTarget = {
      studentId: target.studentId,
      // The frame builder never reads the display name; the public DTO is the
      // only consumer of student names and it is not involved here.
      studentName: "",
      studentSessionId: target.studentSessionId,
      deviceId: target.deviceId,
      available: true,
      stateAuthorized: true,
      ...classpilotPersistedTargetAuthorityRevisions(target.result),
    };
    // Timer and poll normalize to an extension type equal to their command
    // type (classpilotCommandDispatcher normalizeCommandPayload).
    const frame = classpilotCommandFrameForTarget(
      command.schoolId,
      command.commandType,
      command.commandType,
      { ...payload, commandId: command.id },
      resolvedTarget,
      {
        policy: classpilotCommandDeliveryPolicy(command.commandType),
        expiresAt: command.expiresAt,
      },
      undefined,
      classpilotCommandAuthorityEnvelope(command),
    );
    if (frame) frames.push(frame);
  }
  return frames;
}
