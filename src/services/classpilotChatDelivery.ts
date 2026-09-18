import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";

export type StudentChatFanOutReport = {
  schoolId: string;
  authority: { kind: "teaching-session" | "supervision-context"; id: string };
  messageId: string;
  /** "local" = the API task that stored the message; "relay" = a task that received it over Redis. */
  source: "local" | "relay";
  /** Staff sockets this task wrote the event to. */
  delivered: number;
  /** Local source only: whether the Redis relay accepted the event for the other tasks. */
  relayAccepted?: boolean;
};

/**
 * One line per API task per student message, so an incident can be settled from
 * CloudWatch: if every task reports delivered=0 the server never had an eligible
 * teacher socket (subscription, assignment or authority-revision mismatch); if any
 * task reports delivered>=1 the event reached a socket and the gap is client-side.
 * Only opaque ids are logged, never message content.
 */
export function describeStudentChatFanOut(report: StudentChatFanOutReport): { level: "log" | "warn"; line: string } {
  const relay = report.source === "local"
    ? ` relay=${report.relayAccepted ? "accepted" : "unavailable"}`
    : "";
  const scope = `school=${report.schoolId} ${report.authority.kind}=${report.authority.id} message=${report.messageId} source=${report.source}`;
  if (report.delivered <= 0) {
    return { level: "warn", line: `[ClassPilot chat] student-message reached no staff socket on this task ${scope} delivered=0${relay}` };
  }
  return { level: "log", line: `[ClassPilot chat] student-message fan-out ${scope} delivered=${report.delivered}${relay}` };
}

export function reportStudentChatFanOut(
  report: StudentChatFanOutReport,
  sink: Pick<Console, "log" | "warn"> = console,
): void {
  try {
    const described = describeStudentChatFanOut(report);
    if (report.delivered > 0) recordRuntimePerformanceCounter("studentChatFanOutDelivered", report.delivered);
    else recordRuntimePerformanceCounter("studentChatFanOutMissed");
    sink[described.level](described.line);
  } catch {
    // Diagnostics never affect message delivery.
  }
}
