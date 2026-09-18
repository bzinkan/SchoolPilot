import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeStudentChatFanOut, reportStudentChatFanOut } from "../src/services/classpilotChatDelivery.js";
import { snapshotRuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

const base = {
  schoolId: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222",
} as const;

describe("student chat fan-out diagnostics", () => {
  it("logs one searchable line per task and warns when no staff socket received the message", () => {
    const delivered = describeStudentChatFanOut({
      ...base, authority: { kind: "supervision-context", id: "ctx-1" }, source: "local", delivered: 2, relayAccepted: true,
    });
    assert.equal(delivered.level, "log");
    assert.equal(delivered.line,
      `[ClassPilot chat] student-message fan-out school=${base.schoolId} supervision-context=ctx-1 message=${base.messageId} source=local delivered=2 relay=accepted`);

    const missed = describeStudentChatFanOut({
      ...base, authority: { kind: "teaching-session", id: "session-1" }, source: "local", delivered: 0, relayAccepted: false,
    });
    assert.equal(missed.level, "warn");
    assert.equal(missed.line,
      `[ClassPilot chat] student-message reached no staff socket on this task school=${base.schoolId} teaching-session=session-1 message=${base.messageId} source=local delivered=0 relay=unavailable`);

    const relayed = describeStudentChatFanOut({
      ...base, authority: { kind: "teaching-session", id: "session-1" }, source: "relay", delivered: 1,
    });
    assert.equal(relayed.level, "log");
    assert.ok(relayed.line.endsWith("source=relay delivered=1"), "a relay report carries no relay status of its own");
  });

  it("counts delivered sockets and misses separately and never logs message content", () => {
    snapshotRuntimePerformanceMetrics({ reset: true });
    const lines: string[] = [];
    const sink = { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line) };
    reportStudentChatFanOut({
      ...base, authority: { kind: "supervision-context", id: "ctx-1" }, source: "local", delivered: 3, relayAccepted: true,
    }, sink);
    reportStudentChatFanOut({
      ...base, authority: { kind: "supervision-context", id: "ctx-1" }, source: "relay", delivered: 0,
    }, sink);
    const { counters } = snapshotRuntimePerformanceMetrics({ reset: true });
    assert.equal(counters.studentChatFanOutDelivered, 3);
    assert.equal(counters.studentChatFanOutMissed, 1);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotMatch(line, /content|message=undefined|studentName/);
    }
  });

  it("never throws into the delivery path when the sink fails", () => {
    const broken = { log: () => { throw new Error("sink down"); }, warn: () => { throw new Error("sink down"); } };
    assert.doesNotThrow(() => reportStudentChatFanOut({
      ...base, authority: { kind: "teaching-session", id: "session-1" }, source: "local", delivered: 1, relayAccepted: true,
    }, broken));
  });
});
