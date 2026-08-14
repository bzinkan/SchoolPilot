export type ClasspilotCommandDeliveryPolicy =
  | "persistent_control"
  | "transient_action"
  | "durable_message"
  | "server_authoritative";

export const CLASSPILOT_TRANSIENT_COMMAND_TTL_MS = 15_000;

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
]);

const TRANSIENT_ACTION_COMMAND_TYPES = new Set([
  "open-tab",
  "close-tab",
  "close-tabs",
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
    ? new Date(issuedAt.getTime() + CLASSPILOT_TRANSIENT_COMMAND_TTL_MS)
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
