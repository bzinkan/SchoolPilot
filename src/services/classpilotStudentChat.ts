const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
export function isExactIdempotentStudentMessage(
  existing: {
    schoolId: string;
    sessionId: string;
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
