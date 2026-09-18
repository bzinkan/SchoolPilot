const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TeacherChatDeliveryStatus = "sent" | "delivered" | "failed" | "seen";
export type TeacherChatAckStatus = "delivered" | "failed" | "seen";

export function parseTeacherChatAckStatus(value: unknown): TeacherChatAckStatus | null {
  const status = typeof value === "string" ? value.trim() : "";
  return status === "delivered" || status === "failed" || status === "seen" ? status : null;
}

export type TeacherChatDeliveryTransition =
  | { changed: false }
  | {
    changed: true;
    outboxState: "delivered" | "retry";
    message: {
      deliveryStatus: TeacherChatDeliveryStatus;
      deliveredAt?: Date;
      seenAt?: Date;
      failedAt?: null;
      errorMessage: string | null;
    };
  };

/**
 * Delivery state only moves forward: sent -> delivered -> seen. `seen` is
 * terminal, a late `delivered` after `seen` is a no-op, and a late `failed`
 * after `delivered` never regresses the row. A `seen` ack on a message the
 * device never acknowledged as delivered backfills deliveredAt, because being
 * on screen proves delivery.
 */
export function nextTeacherChatDeliveryState(
  current: { deliveryStatus: string; deliveredAt: Date | null; seenAt: Date | null },
  ack: { status: TeacherChatAckStatus; at: Date; errorMessage?: string | null }
): TeacherChatDeliveryTransition {
  if (current.deliveryStatus === "seen") return { changed: false };
  if (ack.status === "seen") {
    return {
      changed: true,
      outboxState: "delivered",
      message: {
        deliveryStatus: "seen",
        deliveredAt: current.deliveredAt ?? ack.at,
        seenAt: current.seenAt ?? ack.at,
        failedAt: null,
        errorMessage: null,
      },
    };
  }
  if (current.deliveryStatus === "delivered") return { changed: false };
  if (ack.status === "delivered") {
    return {
      changed: true,
      outboxState: "delivered",
      message: { deliveryStatus: "delivered", deliveredAt: current.deliveredAt ?? ack.at, failedAt: null, errorMessage: null },
    };
  }
  return {
    changed: true,
    outboxState: "retry",
    message: { deliveryStatus: "sent", errorMessage: String(ack.errorMessage || "Device reported delivery failure").slice(0, 500) },
  };
}

export function parseClasspilotClientMessageId(value: unknown):
  | { status: "legacy"; clientMessageId: null }
  | { status: "valid"; clientMessageId: string }
  | { status: "invalid"; clientMessageId: null } {
  if (value === undefined || value === null || value === "") {
    return { status: "legacy", clientMessageId: null };
  }
  if (typeof value !== "string") return { status: "invalid", clientMessageId: null };
  const clientMessageId = value.trim();
  return UUID_PATTERN.test(clientMessageId)
    ? { status: "valid", clientMessageId: clientMessageId.toLowerCase() }
    : { status: "invalid", clientMessageId: null };
}

export function parseClasspilotTeachingSessionId(value: unknown):
  | { status: "legacy"; teachingSessionId: null }
  | { status: "valid"; teachingSessionId: string }
  | { status: "invalid"; teachingSessionId: null } {
  if (value === undefined || value === null || value === "") {
    return { status: "legacy", teachingSessionId: null };
  }
  if (typeof value !== "string") return { status: "invalid", teachingSessionId: null };
  const teachingSessionId = value.trim();
  return UUID_PATTERN.test(teachingSessionId)
    ? { status: "valid", teachingSessionId: teachingSessionId.toLowerCase() }
    : { status: "invalid", teachingSessionId: null };
}

export function isCurrentClasspilotStudentMessageSession(
  requestedTeachingSessionId: string | null | undefined,
  currentTeachingSessionId: string
): boolean {
  return !requestedTeachingSessionId || requestedTeachingSessionId === currentTeachingSessionId;
}

export function isExactIdempotentStudentMessage(
  existing: {
    schoolId: string;
    sessionId: string | null;
    studentId: string | null;
    studentSessionId: string | null;
    senderType: string;
    content: string;
    clientMessageId: string | null;
  } | null | undefined,
  expected: {
    schoolId: string;
    teachingSessionId: string;
    studentId: string;
    studentSessionId: string;
    content: string;
    clientMessageId: string;
  }
): boolean {
  return !!existing
    && existing.schoolId === expected.schoolId
    && existing.sessionId === expected.teachingSessionId
    && existing.studentId === expected.studentId
    && existing.studentSessionId === expected.studentSessionId
    && existing.senderType === "student"
    && existing.content === expected.content
    && existing.clientMessageId === expected.clientMessageId;
}
