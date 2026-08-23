import test from "node:test";
import assert from "node:assert/strict";
import {
  isExactIdempotentStudentMessage,
  parseClasspilotClientMessageId,
} from "../src/services/classpilotStudentChat.js";

const clientMessageId = "550e8400-e29b-41d4-a716-446655440000";

test("student chat preserves legacy requests and validates durable UUIDs", () => {
  assert.deepEqual(parseClasspilotClientMessageId(undefined), {
    status: "legacy",
    clientMessageId: null,
  });
  assert.deepEqual(parseClasspilotClientMessageId(clientMessageId.toUpperCase()), {
    status: "valid",
    clientMessageId,
  });
  assert.equal(parseClasspilotClientMessageId("not-a-uuid").status, "invalid");
});
test("student chat idempotency never crosses an exact authority boundary", () => {
  const existing = {
    schoolId: "school-a",
    sessionId: "teaching-a",
    studentId: "student-a",
    studentSessionId: "binding-a",
    senderType: "student",
    content: "Please help",
    clientMessageId,
  };
  const expected = {
    schoolId: "school-a",
    teachingSessionId: "teaching-a",
    studentId: "student-a",
    studentSessionId: "binding-a",
    content: "Please help",
    clientMessageId,
  };
  assert.equal(isExactIdempotentStudentMessage(existing, expected), true);
  for (const mutation of [
    { schoolId: "school-b" },
    { teachingSessionId: "teaching-b" },
    { studentId: "student-b" },
    { studentSessionId: "binding-b" },
    { content: "Different" },
    { clientMessageId: "650e8400-e29b-41d4-a716-446655440000" },
  ]) {
    assert.equal(isExactIdempotentStudentMessage(existing, { ...expected, ...mutation }), false);
  }
});
