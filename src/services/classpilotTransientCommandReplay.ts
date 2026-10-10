import { sql } from "drizzle-orm";
import type db from "../db.js";
import type { ClasspilotCommand } from "../schema/classpilot.js";
import { classpilotCommandAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import {
  classpilotCommandDeliveryPolicy,
  isClasspilotReplayableTransientCommandType,
} from "./classpilotCommandDelivery.js";
import {
  classpilotCommandFrameForTarget,
  classpilotPersistedTargetAuthorityRevisions,
  classpilotRequiredToolsCapability,
  type ResolvedClasspilotCommandTarget,
} from "./classpilotCommandDispatcher.js";
import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";
import {
  listClasspilotReplayableTransientCommandTargets,
  type ClasspilotReplayableTransientCommandTarget,
  type ClasspilotTransientCommandExactBinding,
} from "./storage.js";

/** Newest pending timer/poll targets considered per auth-success. */
export const CLASSPILOT_TRANSIENT_REPLAY_LIMIT = 20;

export type ClasspilotTransientReplayFrame = NonNullable<ReturnType<typeof classpilotCommandFrameForTarget>>;

/**
 * What the device will hold once it applies the `auth-success` frame of the
 * same bootstrap transaction. A frame is replayed only if the extension will
 * accept it against exactly this state; anything else would be rejected on the
 * device as COMMAND_AUTHORITY_MISMATCH and surface to the teacher as a failed
 * target instead of an expired one.
 */
export type ClasspilotTransientReplayAuthority = {
  /** Class contexts of the student FAB state delivered with auth-success. */
  activeContexts: ReadonlyArray<{ teachingSessionId?: string | null; supervisionContextId?: string | null }>;
  /** Scheduled classroom authority revision of that FAB state, when it has one. */
  contextAuthorityRevision?: string | null;
  /** Owner and revision of the control state delivered with auth-success; null when none is delivered. */
  controlState: { supervisionContextId: string | null; revision: number } | null;
  /** Capabilities this socket accepted during protocol negotiation. */
  acceptedCapabilities: readonly string[];
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The dispatcher proves class authority when it delivers. A replay happens up
 * to a minute later, so the class may have ended, the student may have moved
 * to another class or supervision context, or (scheduled classrooms) the
 * control revision the frame is bound to may have been retired.
 */
function replayAuthorityCurrent(
  command: Pick<ClasspilotCommand, "teachingSessionId" | "supervisionContextId">,
  target: ResolvedClasspilotCommandTarget,
  authority: ClasspilotTransientReplayAuthority,
): boolean {
  const teachingSessionId = command.teachingSessionId || null;
  const supervisionContextId = command.supervisionContextId || null;
  if (Boolean(teachingSessionId) === Boolean(supervisionContextId)) return false;
  const contexts = authority.activeContexts ?? [];
  if (teachingSessionId) {
    return contexts.some((context) => context.teachingSessionId === teachingSessionId);
  }
  if (!contexts.some((context) => context.supervisionContextId === supervisionContextId)) return false;
  // The extension accepts a scheduled timer/poll only when the frame's frozen
  // control revision equals the revision it currently holds.
  if (authority.controlState?.supervisionContextId !== supervisionContextId) return false;
  if (
    !Number.isSafeInteger(target.scheduledAuthorityRevision)
    || target.scheduledAuthorityRevision !== authority.controlState.revision
  ) return false;
  return target.contextAuthorityRevision === undefined
    || target.contextAuthorityRevision === (authority.contextAuthorityRevision ?? null);
}

/**
 * Payload to re-send, or null when there is nothing left to show.
 *
 * A revisioned timer (Class Tools phase 2+) carries an absolute `deadline`. A
 * legacy timer start carries only a duration: the extension counts from the
 * moment it receives the frame, while the dashboard counts from the command's
 * `createdAt`. Re-sending the original duration would therefore run the
 * student's timer late by the replay delay, and would restart it on a device
 * that had applied the frame but lost its receipt. The replayed start carries
 * the seconds remaining instead, so it ends with the teacher's timer and is
 * idempotent when it repeats.
 */
function replayPayload(
  command: Pick<ClasspilotCommand, "commandType" | "createdAt">,
  payload: Record<string, unknown>,
  now: Date,
): Record<string, unknown> | null {
  if (command.commandType !== "timer" || payload.action !== "start") return payload;
  const absoluteEnd = payload.deadline ?? payload.endsAt ?? payload.endAt;
  if (absoluteEnd !== undefined && absoluteEnd !== null) {
    const endsAt = typeof absoluteEnd === "number" ? absoluteEnd : Date.parse(String(absoluteEnd));
    if (Number.isFinite(endsAt) && endsAt > 0) return endsAt > now.getTime() ? payload : null;
  }
  const seconds = Number(payload.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return payload;
  const remaining = Math.round(seconds - (now.getTime() - command.createdAt.getTime()) / 1000);
  if (remaining < 1) return null;
  return { ...payload, seconds: Math.min(seconds, remaining) };
}

/**
 * The remote-control frame for one pending timer/poll target, or null when it
 * must not be replayed. Built with the dispatcher's own frame builder from the
 * persisted command payload and target row, so it carries the same binding and
 * authority envelope as the original dispatch, with a fresh `_msgId`.
 */
export function classpilotTransientReplayFrameFor(
  entry: ClasspilotReplayableTransientCommandTarget,
  authority: ClasspilotTransientReplayAuthority,
  now: Date = new Date(),
): ClasspilotTransientReplayFrame | null {
  const { command, target } = entry;
  if (!isClasspilotReplayableTransientCommandType(command.commandType)) return null;
  if (target.status !== "sent" || target.receivedAt) return null;
  if (!target.studentSessionId || !target.deviceId) return null;
  if (!command.expiresAt || command.expiresAt.getTime() <= now.getTime()) return null;
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
  if (!replayAuthorityCurrent(command, resolvedTarget, authority)) return null;
  const storedPayload = recordOf(command.commandPayload);
  const requiredCapability = classpilotRequiredToolsCapability(command.commandType, storedPayload);
  if (requiredCapability && !authority.acceptedCapabilities.includes(requiredCapability)) return null;
  const payload = replayPayload(command, storedPayload, now);
  if (!payload) return null;
  // Timer and poll normalize to an extension type equal to their command
  // type (classpilotCommandDispatcher normalizeCommandPayload).
  return classpilotCommandFrameForTarget(
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
}

/**
 * Remote-control frames for this exact binding's un-received, unexpired
 * timer/poll targets, oldest first.
 *
 * Runs inside the student WebSocket bootstrap transaction (same student-control
 * lock as command persistence); the caller's synchronous delivery callback only
 * `ws.send()`s the result after `auth-success`. Target status is untouched: the
 * device's `received` ACK remains the only receipt.
 *
 * This is optional work inside a mandatory transaction. The read runs in its
 * own savepoint and every failure degrades to "nothing replayed": a replay
 * problem must never fail a student's authentication.
 */
export async function prepareClasspilotTransientCommandReplay(
  binding: ClasspilotTransientCommandExactBinding,
  transactionDb: typeof db,
  authority: ClasspilotTransientReplayAuthority,
  options: {
    now?: Date;
    list?: typeof listClasspilotReplayableTransientCommandTargets;
  } = {},
): Promise<ClasspilotTransientReplayFrame[]> {
  const now = options.now ?? new Date();
  const list = options.list ?? listClasspilotReplayableTransientCommandTargets;
  const reportFailure = (error: unknown) => {
    recordRuntimePerformanceCounter("transientCommandReplayFailed");
    console.warn(
      "[ClassPilot] Transient command replay skipped",
      error instanceof Error ? error.name : "error",
    );
  };

  let pending: ClasspilotReplayableTransientCommandTarget[] = [];
  await transactionDb.execute(sql`SAVEPOINT classpilot_transient_command_replay`);
  try {
    pending = await list(binding, transactionDb, { limit: CLASSPILOT_TRANSIENT_REPLAY_LIMIT, now });
  } catch (error) {
    // A PostgreSQL error aborts its subtransaction. Restore it before the
    // mandatory bootstrap queries; a failed rollback or release must propagate.
    await transactionDb.execute(sql`ROLLBACK TO SAVEPOINT classpilot_transient_command_replay`);
    pending = [];
    reportFailure(error);
  }
  await transactionDb.execute(sql`RELEASE SAVEPOINT classpilot_transient_command_replay`);

  const frames: ClasspilotTransientReplayFrame[] = [];
  for (const entry of pending) {
    try {
      const frame = classpilotTransientReplayFrameFor(entry, authority, now);
      if (frame) frames.push(frame);
    } catch (error) {
      reportFailure(error);
    }
  }
  return frames;
}
