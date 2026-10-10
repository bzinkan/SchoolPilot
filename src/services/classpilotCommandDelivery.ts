import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";

export type ClasspilotCommandDeliveryPolicy =
  | "persistent_control"
  | "transient_action"
  | "durable_message"
  | "server_authoritative";

export const CLASSPILOT_TRANSIENT_COMMAND_TTL_MS = 15_000;

/**
 * Timer and poll targets may stay deliverable longer than the 15 s one-shot
 * deadline, but only where something can still deliver them: the auth-success
 * replay. Where the replay is off, a longer deadline re-delivers nothing. It
 * only keeps a missed target awaiting for longer, which holds the dashboard's
 * timer and poll controls until the deadline, and it lets a late live frame
 * run late on the device: a phase-0 timer frame carries a duration, not an end
 * time, so the extension counts the full duration from receipt. The replay
 * corrects for that by sending the seconds remaining; a live frame cannot.
 *
 * Timers get 60 s in the replay pilot; polls additionally require the school's
 * safe-poll capability rollout. Older poll clients can share that deadline but
 * never receive poll replay. Open/close/activate-tab always keep 15 s.
 *
 * The override applies only after the command's replay gate is active, and
 * accepts integral deadlines between the legacy 15 s and the reviewed 60 s.
 */
const REPLAY_TIMER_POLL_COMMAND_TTL_MS = 60_000;
const TIMER_POLL_COMMAND_TYPES = new Set(["timer", "poll"]);

export function classpilotTimerPollCommandTtlMs(
  env: NodeJS.ProcessEnv = process.env,
  schoolId?: string,
  commandType: "timer" | "poll" = "timer",
): number {
  if (!schoolId || !classpilotTransientReplayOnAuthEnabled(schoolId, env)
    || (commandType === "poll" && !isClasspilotCapabilityActive("pollReplaySafeV1", { schoolId }, env))) {
    return CLASSPILOT_TRANSIENT_COMMAND_TTL_MS;
  }
  const raw = env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
  if (raw !== undefined && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 15_000 && parsed <= 60_000) return parsed;
  }
  return REPLAY_TIMER_POLL_COMMAND_TTL_MS;
}

/** Transient command types whose un-received frames are replayed on student WebSocket auth-success. */
export const CLASSPILOT_REPLAYABLE_TRANSIENT_COMMAND_TYPES = ["timer", "poll"] as const;

export function isClasspilotReplayableTransientCommandType(commandType: string): boolean {
  return TIMER_POLL_COMMAND_TYPES.has(commandType);
}

/**
 * Deadline by type: 15 s unless that command's school replay gate is enabled.
 */
export function classpilotTransientCommandTtlMs(
  commandType: string,
  env: NodeJS.ProcessEnv = process.env,
  schoolId?: string
): number {
  return TIMER_POLL_COMMAND_TYPES.has(commandType)
    ? classpilotTimerPollCommandTtlMs(env, schoolId, commandType as "timer" | "poll")
    : CLASSPILOT_TRANSIENT_COMMAND_TTL_MS;
}

/**
 * Replay of un-received timer/poll frames on student WebSocket auth-success.
 * Default off, with exactly one canonical UUID pilot. An absent, empty or
 * malformed allowlist never broadens this first rollout to every school.
 */
export function classpilotTransientReplayOnAuthEnabled(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH !== "true") return false;
  const pilotSchoolId = env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pilotSchoolId)
    && schoolId === pilotSchoolId;
}

const PERSISTENT_CONTROL_COMMAND_TYPES = new Set([
  "lock-screen",
  "unlock-screen",
  "apply-flight-path",
  "remove-flight-path",
  "apply-block-list",
  "remove-block-list",
  "attention-mode",
  "limit-tabs",
  "temp-unblock",
  "focus-tab",
  "stop-focus",
]);

const TRANSIENT_ACTION_COMMAND_TYPES = new Set([
  "open-tab",
  "close-tab",
  "close-tabs",
  "activate-tab",
  "timer",
  "poll",
]);

/**
 * Commands default to one-shot delivery. That fail-safe keeps a newly added
 * action from being replayed after reconnect until it is deliberately placed
 * in one of the durable policies below.
 */
export function classpilotCommandDeliveryPolicy(
  commandType: string
): ClasspilotCommandDeliveryPolicy {
  if (PERSISTENT_CONTROL_COMMAND_TYPES.has(commandType)) return "persistent_control";
  if (commandType === "teacher-message") return "durable_message";
  if (commandType === "student-sign-out") return "server_authoritative";
  if (TRANSIENT_ACTION_COMMAND_TYPES.has(commandType)) return "transient_action";
  return "transient_action";
}

export function classpilotCommandExpiresAt(
  commandType: string,
  issuedAt: Date = new Date(),
  schoolId?: string
): Date | null {
  return classpilotCommandDeliveryPolicy(commandType) === "transient_action"
    ? new Date(issuedAt.getTime() + classpilotTransientCommandTtlMs(commandType, process.env, schoolId))
    : null;
}

export function isPersistentClasspilotControl(commandType: string): boolean {
  return classpilotCommandDeliveryPolicy(commandType) === "persistent_control";
}

type CommandTargetLike = {
  status?: string | null;
  ackState?: string | null;
  sentAt?: Date | string | null;
  receivedAt?: Date | string | null;
};

export function summarizeClasspilotCommandTargets(command: {
  targets?: CommandTargetLike[] | null;
}) {
  const targets = command.targets || [];
  const requested = targets.length;
  const attempted = targets.filter((target) =>
    Boolean(target.sentAt)
    || ["received", "completed", "failed"].includes(String(target.status || ""))
  ).length;
  const received = targets.filter((target) => Boolean(target.receivedAt)).length;
  const acknowledged = targets.filter((target) =>
    Boolean(target.receivedAt)
    || ["received", "completed", "failed"].includes(String(target.ackState || ""))
  ).length;
  const completed = targets.filter((target) => target.status === "completed").length;
  const expired = targets.filter((target) => target.status === "expired").length;
  const failed = targets.filter((target) => target.status === "failed").length;
  const unavailable = targets.filter((target) => target.status === "unavailable").length;
  const pending = targets.filter((target) =>
    ["requested", "sent", "received"].includes(String(target.status || ""))
  ).length;
  return {
    requested,
    attempted,
    acknowledged,
    completed,
    pending,
    expired,
    failed,
    unavailable,
    // Mixed-version clients still consume these milestone names.
    sent: attempted,
    received,
    awaitingAck: Math.max(0, attempted - acknowledged - expired),
  };
}
