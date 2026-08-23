import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classpilotClassroomStatePushFrame,
  classpilotFabStatePushFrame,
} from "../src/services/classpilotControlStateFrame.js";

const fixture = JSON.parse(readFileSync(new URL(
  "./fixtures/classpilot-compatibility/schoolpilot-2.7.1-control-revision-frames.json",
  import.meta.url
), "utf8")) as {
  fixtureSchemaVersion: number;
  frames: { classroom: Record<string, unknown>; fab: Record<string, unknown> };
};

test("SchoolPilot authoritative control pushes carry one complete exact V2 binding", () => {
  assert.equal(fixture.fixtureSchemaVersion, 1);
  const binding = {
    schoolId: "school-a",
    deviceId: "device-a",
    studentId: "student-a",
    studentSessionId: "student-session-a",
    controlRevision: 42,
  };
  const classroom = classpilotClassroomStatePushFrame({
    type: "classroom-state-sync",
    messageId: "classroom-message-a",
    binding,
    classroomState: { schemaVersion: 1, revision: 42 },
  });
  const fab = classpilotFabStatePushFrame({
    messageId: "fab-message-a",
    sessionId: "teaching-session-a",
    binding,
    data: {
      schemaVersion: 1,
      studentId: "student-a",
      studentSessionId: "student-session-a",
      ownershipRevision: 42,
      revision: 41,
      lifecycleRevision: 41,
    },
  });
  assert.deepEqual(classroom, fixture.frames.classroom);
  assert.deepEqual(fab, fixture.frames.fab);
});

test("SchoolPilot refuses malformed control revision bindings before publication", () => {
  assert.throws(() => classpilotClassroomStatePushFrame({
    type: "classroom-state-sync",
    binding: {
      schoolId: "school-a",
      deviceId: "device-a",
      studentId: "student-a",
      studentSessionId: "student-session-a",
      controlRevision: Number.NaN,
    },
    classroomState: null,
  }), /revision is invalid/);
});
