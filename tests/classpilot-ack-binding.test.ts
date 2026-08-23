import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classpilotAckEnvelopeMatchesBinding } from "../src/services/classpilotAckBinding.js";

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
});
