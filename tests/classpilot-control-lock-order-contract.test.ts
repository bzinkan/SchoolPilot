import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storage = readFileSync(new URL("../src/services/storage.ts", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const startIndex = storage.indexOf(start);
  const endIndex = storage.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing ${start}`);
  return storage.slice(startIndex, endIndex);
}

function assertOrdered(label: string, value: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const current = value.indexOf(marker, previous + 1);
    assert.ok(current > previous, `${label}: missing or inverted ${marker}`);
    previous = current;
  }
}

test("heartbeat, transfer, class/Coverage persistence, and delivery share binding lock order", () => {
  const heartbeat = section(
    "export async function createHeartbeatAndRefreshPresence",
    "export async function getHeartbeatsByDevice"
  );
  assertOrdered("heartbeat", heartbeat, [
    "locked_student_authority",
    "locked_device",
    "represented_session",
  ]);

  const transfer = section(
    "export async function startStudentSessionWithReplacements",
    "export async function endStudentSessionExact"
  );
  const transferLocked = transfer.slice(transfer.indexOf("await lockClasspilotStudentControlAuthorities"));
  assertOrdered("session transfer", transferLocked, [
    "await lockClasspilotStudentControlAuthorities",
    ".from(students)",
    ".from(devices)",
    ".from(studentSessions)",
  ]);

  const persistentCommand = section(
    "export async function persistClasspilotControlCommandState",
    "export async function upsertClasspilotClassroomStates"
  );
  assertOrdered("persistent class command", persistentCommand, [
    "lockClasspilotStudentControlAuthorities",
    "const bindingDeviceIds",
    ".orderBy(devices.deviceId)",
    ".orderBy(studentSessions.studentId, studentSessions.id)",
    '.for("update", { of: studentSessions })',
    "const [lockedSession]",
    ".from(teachingSessions)",
  ]);

  const coverage = section(
    "export async function replaceClasspilotSupervisionControlSnapshots",
    "export async function restoreClasspilotStudentControlStatesAfterSupervision"
  );
  assertOrdered("persistent Coverage command", coverage, [
    "lockClasspilotStudentControlAuthorities",
    "const bindingDeviceIds",
    ".orderBy(devices.deviceId)",
    ".orderBy(studentSessions.studentId, studentSessions.id)",
    '.for("update", { of: studentSessions })',
    "const [context]",
    ".from(classpilotSupervisionContexts)",
  ]);

  const delivery = section(
    "export async function withClasspilotStudentControlDeliveryAuthority",
    "export async function withClasspilotStudentWebSocketBootstrapAuthority"
  );
  assertOrdered("exact-bound delivery", delivery, [
    "lockClasspilotStudentControlAuthorities",
    "hasExactClasspilotTelemetryBinding",
  ]);
});

test("roster resync and finalization share lifecycle, student, then session order", () => {
  const resync = section(
    "export async function resyncActiveClasspilotSessionStudents",
    "async function snapshotClasspilotSessionStaff"
  );
  assertOrdered("roster resync", resync, [
    "lockClasspilotTeachingSessionLifecycle",
    "lockClasspilotStudentControlAuthorities",
    "const [locked]",
    ".from(teachingSessions)",
    '.for("update")',
  ]);

  const finalization = section(
    "export async function finalizeTeachingSession",
    "export async function"
  );
  assertOrdered("session finalization", finalization, [
    "lockClasspilotTeachingSessionLifecycle",
    "lockClasspilotStudentControlAuthorities",
    "const [session]",
    ".from(teachingSessions)",
    '.for("update")',
  ]);
});

test("the lock-order exception is explicit about its coordinated-migration boundary", () => {
  const documentation = readFileSync(
    new URL("../docs/classpilot-control-authority-lock-order.md", import.meta.url),
    "utf8"
  );
  assert.match(documentation, /cannot be introduced\s+in only the new\s+command path/i);
  assert.match(documentation, /mixed lock orders/i);
  assert.match(documentation, /sorted .*student-control/i);
});
