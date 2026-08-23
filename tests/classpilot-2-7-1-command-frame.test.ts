import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classpilotCommandAuthorityEnvelope } from "../src/services/classpilotCommandAuthority.js";
import {
  classpilotCommandFrameForTarget,
  normalizeCommandPayload,
} from "../src/services/classpilotCommandDispatcher.js";

test("SchoolPilot emits the retained 2.7.1 exact-tab V2 frame contract", () => {
  const fixture = JSON.parse(readFileSync(new URL(
    "./fixtures/classpilot-compatibility/schoolpilot-2.7.1-exact-tab-frame.json",
    import.meta.url
  ), "utf8")) as { fixtureSchemaVersion: number; frame: Record<string, unknown> };
  assert.equal(fixture.fixtureSchemaVersion, 1);

  const frame = classpilotCommandFrameForTarget(
    "school-a",
    "close-tabs",
    "close-tab",
    {
      commandId: "command-a",
      closeAll: false,
      tabsToClose: [{
        studentId: "student-a",
        tabRef: "tab-ref-a",
        observedRevision: 44,
      }],
    },
    {
      studentId: "student-a",
      studentName: "Student A",
      studentSessionId: "student-session-a",
      deviceId: "device-a",
      available: true,
      controlRevision: 12,
      exactTabCloseVersion: 2,
    },
    {
      policy: "transient_action",
      expiresAt: new Date("2026-08-23T15:00:15.000Z"),
    },
    undefined,
    classpilotCommandAuthorityEnvelope({ teachingSessionId: "teaching-session-a" })
  );
  assert.ok(frame);
  frame._msgId = "<opaque-message-id>";
  assert.deepEqual(JSON.parse(JSON.stringify(frame)), fixture.frame);
});

test("exact-tab V2 generation fails closed without the complete frozen tuple", () => {
  const frame = classpilotCommandFrameForTarget(
    "school-a",
    "close-tabs",
    "close-tab",
    {
      commandId: "command-a",
      closeAll: false,
      tabsToClose: [{ studentId: "student-a", tabRef: "tab-ref-a", observedRevision: 44 }],
    },
    {
      studentId: "student-a",
      studentName: "Student A",
      studentSessionId: "student-session-a",
      deviceId: "device-a",
      available: true,
      exactTabCloseVersion: 2,
    },
    { policy: "transient_action", expiresAt: new Date() },
    undefined,
    classpilotCommandAuthorityEnvelope({ teachingSessionId: "teaching-session-a" })
  );
  assert.equal(frame, null);
});

test("SchoolPilot emits explicit close-tabs plus closeAll for the ordinary all-tabs action", async () => {
  const fixture = JSON.parse(readFileSync(new URL(
    "./fixtures/classpilot-compatibility/schoolpilot-2.7.1-close-all-frame.json",
    import.meta.url
  ), "utf8")) as { fixtureSchemaVersion: number; frame: Record<string, unknown> };
  assert.equal(fixture.fixtureSchemaVersion, 1);
  const normalized = await normalizeCommandPayload(
    "close-tabs",
    { closeAll: true },
    "school-a",
    "teacher-a",
    "teaching-session-a"
  );
  assert.equal(normalized.extensionType, "close-tabs");

  const frame = classpilotCommandFrameForTarget(
    "school-a",
    "close-tabs",
    normalized.extensionType,
    { commandId: "command-close-all", ...normalized.payload },
    {
      studentId: "student-a",
      studentName: "Student A",
      studentSessionId: "student-session-a",
      deviceId: "device-a",
      available: true,
    },
    { policy: "transient_action", expiresAt: new Date("2026-08-23T15:00:15.000Z") },
    undefined,
    classpilotCommandAuthorityEnvelope({ teachingSessionId: "teaching-session-a" })
  );

  assert.ok(frame);
  assert.ok("command" in frame);
  assert.equal(frame.command.type, "close-tabs");
  assert.equal(frame.command.data.closeAll, true);
  assert.equal("exactBinding" in frame, false);
  assert.equal("tabRefs" in frame.command.data, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify({ ...frame, _msgId: "<opaque-message-id>" })),
    fixture.frame
  );
});
