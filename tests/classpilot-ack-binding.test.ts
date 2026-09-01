import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classpilotAckAppliedAuthPolicyRevision,
  classpilotAckControlRevision,
  classpilotAckEnvelopeMatchesBinding,
} from "../src/services/classpilotAckBinding.js";
import {
  classpilotCommandAckReceipt,
  terminalClasspilotCommandAckReceipt,
} from "../src/services/classpilotAckReceipt.js";

const authenticated = {
  schoolId: "school-a",
  deviceId: "device-a",
  studentId: "student-a",
  studentSessionId: "session-a",
};

describe("ClassPilot command ACK envelope binding", () => {
  it("preserves protocol v2 ACK compatibility when no envelope is supplied", () => {
    assert.equal(classpilotAckEnvelopeMatchesBinding({
      commandId: "command-a",
      ackState: "completed",
    }, authenticated), true);
  });

  it("accepts a complete matching protocol v3 envelope", () => {
    assert.equal(classpilotAckEnvelopeMatchesBinding({
      schoolId: authenticated.schoolId,
      deviceId: authenticated.deviceId,
      exactBinding: {
        studentId: authenticated.studentId,
        studentSessionId: authenticated.studentSessionId,
      },
    }, authenticated), true);
  });

  it("rejects every mismatched or malformed explicit binding before storage", () => {
    for (const envelope of [
      { schoolId: "school-b" },
      { deviceId: "device-b" },
      { studentId: "student-b" },
      { studentSessionId: "session-b" },
      { exactBinding: { studentId: "student-a", studentSessionId: "session-b" } },
      { exactBinding: { schoolId: "school-b" } },
      { exactBinding: { deviceId: "device-b" } },
      { authority: { schoolId: "school-b" } },
      {
        schoolId: "school-a",
        authority: { schoolId: "school-b" },
      },
      { exactBinding: "malformed" },
      { studentId: "" },
    ]) {
      assert.equal(
        classpilotAckEnvelopeMatchesBinding(envelope, authenticated),
        false
      );
    }
  });

  it("accepts only one strictly encoded, consistent control revision", () => {
    assert.equal(classpilotAckControlRevision({ studentControlRevision: 12 }), 12);
    assert.equal(classpilotAckControlRevision({
      studentControlRevision: 12,
      exactBinding: { controlRevision: 12 },
    }), 12);
    for (const ack of [
      { studentControlRevision: "12" },
      { studentControlRevision: -1 },
      { studentControlRevision: 12, exactBinding: { controlRevision: 13 } },
    ]) {
      assert.equal(classpilotAckEnvelopeMatchesBinding(ack, authenticated), false);
      assert.equal(classpilotAckControlRevision(ack), undefined);
    }
  });

  it("accepts only a non-negative integer auth-policy fence", () => {
    assert.equal(
      classpilotAckAppliedAuthPolicyRevision({ appliedAuthPolicyRevision: 14 }),
      14,
    );
    for (const ack of [
      {},
      { appliedAuthPolicyRevision: null },
      { appliedAuthPolicyRevision: "14" },
      { appliedAuthPolicyRevision: -1 },
      { appliedAuthPolicyRevision: 1.5 },
    ]) {
      assert.equal(classpilotAckAppliedAuthPolicyRevision(ack), undefined);
    }
  });
});

describe("ClassPilot command ACK receipts", () => {
  it("keeps legacy accepted while making terminal outbox decisions explicit", () => {
    assert.deepEqual(terminalClasspilotCommandAckReceipt(
      "ack-a",
      "command-a",
      "COMMAND_ACK_TARGET_GONE"
    ), {
      ackId: "ack-a",
      commandId: "command-a",
      accepted: false,
      disposition: "terminal_rejected",
      retryable: false,
      code: "COMMAND_ACK_TARGET_GONE",
    });
    assert.deepEqual(classpilotCommandAckReceipt("ack-b", "command-b", {
      disposition: "idempotent",
      retryable: false,
      code: "COMMAND_ACK_IDEMPOTENT",
      target: undefined!,
    }), {
      ackId: "ack-b",
      commandId: "command-b",
      accepted: true,
      disposition: "idempotent",
      retryable: false,
      code: "COMMAND_ACK_IDEMPOTENT",
    });
  });

});
