export type ClasspilotCommandDeliveryPolicy =
  | "persistent_control"
  | "transient_action"
  | "durable_message"
  | "server_authoritative";

export const CLASSPILOT_TRANSIENT_COMMAND_TTL_MS = 15_000;

/**
 * Timer and poll frames carry their own end time (`deadline`/`timerExpiresAt`,
 * the poll record), so a late delivery still renders correctly: the student
 * sees the remaining time or the still-open poll, never a stale one-shot
 * action. They therefore stay deliverable for 60 s by default, which spans the
 * 7.5-29 s reconnect window measured in production. Open/close/activate-tab
 * keep the 15 s one-shot deadline above.
 *
 * `CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS` overrides the default (15000 restores
 * the legacy deadline). The environment is read per call so a rollback needs
 * no redeploy of a module constant and an invalid value falls back to the
 * default instead of producing a NaN deadline.
 */
const DEFAULT_TIMER_POLL_COMMAND_TTL_MS = 60_000;
const TIMER_POLL_COMMAND_TYPES = new Set(["timer", "poll"]);

export function classpilotTimerPollCommandTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMER_POLL_COMMAND_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMER_POLL_COMMAND_TTL_MS;
}

export const CLASSPILOT_TIMER_POLL_COMMAND_TTL_MS = classpilotTimerPollCommandTtlMs();

/** Transient command types whose un-received frames are replayed on student WebSocket auth-success. */
export const CLASSPILOT_REPLAYABLE_TRANSIENT_COMMAND_TYPES = ["timer", "poll"] as const;

export function isClasspilotReplayableTransientCommandType(commandType: string): boolean {
  return TIMER_POLL_COMMAND_TYPES.has(commandType);
}

/** Deadline for a transient action by type: 60 s (env-overridable) for timer/poll, 15 s otherwise. */
export function classpilotTransientCommandTtlMs(
  commandType: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  return TIMER_POLL_COMMAND_TYPES.has(commandType)
    ? classpilotTimerPollCommandTtlMs(env)
    : CLASSPILOT_TRANSIENT_COMMAND_TTL_MS;
}

/**
 * Replay of un-received timer/poll frames on student WebSocket auth-success.
 * Default off. `CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH=true` enables it for every
 * school unless `CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS` (comma-separated)
 * narrows it to a canary set.
 */
export function classpilotTransientReplayOnAuthEnabled(
  schoolId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.CLASSPILOT_TRANSIENT_REPLAY_ON_AUTH !== "true") return false;
  const allowlist = (env.CLASSPILOT_TRANSIENT_REPLAY_SCHOOL_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(schoolId);
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
  issuedAt: Date = new Date()
): Date | null {
  return classpilotCommandDeliveryPolicy(commandType) === "transient_action"
    ? new Date(issuedAt.getTime() + classpilotTransientCommandTtlMs(commandType))
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
