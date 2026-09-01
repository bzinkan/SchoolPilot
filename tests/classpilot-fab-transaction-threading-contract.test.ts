import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return value.slice(startIndex, endIndex);
}

test("WebSocket FAB bootstrap reuses its transaction fence for every authority read", () => {
  const websocket = source("../src/realtime/websocket.ts");
  const fab = source("../src/services/classpilotFab.ts");
  const storage = source("../src/services/storage.ts");

  const websocketFab = section(
    websocket,
    "const fab = await buildStudentFabState",
    "const [classroomStateRow, ssoPolicy] = await Promise.all",
  );
  assert.match(websocketFab, /dbInstance: transactionDb/);

  const buildState = section(
    fab,
    "export async function buildStudentFabState",
    "export async function getSessionStudentDeviceIds",
  );
  assert.match(buildState, /dbInstance\?: typeof db/);
  assert.match(
    buildState,
    /getClasspilotFabAuthoritySnapshot\([\s\S]*options\.dbInstance/,
  );
  assert.match(
    buildState,
    /getActiveHandsForStudent\([\s\S]*options\.dbInstance/,
  );
  assert.match(
    buildState,
    /getEffectiveFabToggles\([\s\S]*options\.schoolSettings,[\s\S]*options\.dbInstance/,
  );

  const toggles = section(
    fab,
    "export async function getEffectiveFabToggles",
    "export async function resolveStudentFabSessions",
  );
  assert.match(toggles, /dbInstance: typeof db = db/);
  assert.match(toggles, /getSettingsForSchool\(schoolId, dbInstance\)/);
  assert.match(toggles, /getSessionSettings\(schoolId, sessionId, dbInstance\)/);

  const sessionSettings = section(
    storage,
    "export async function getSessionSettings",
    "export async function upsertSessionSettings",
  );
  assert.match(sessionSettings, /dbInstance: typeof db = db/);
  assert.match(sessionSettings, /await dbInstance[\s\S]*\.from\(sessionSettings\)/);

  const activeHands = section(
    storage,
    "export async function getActiveHandsForStudent",
    "export async function upsertClasspilotActiveHand",
  );
  assert.match(activeHands, /dbInstance: typeof db = db/);
  assert.match(activeHands, /await dbInstance[\s\S]*\.from\(classpilotActiveHands\)/);

  const authoritySnapshot = section(
    storage,
    "export async function getClasspilotFabAuthoritySnapshot",
    "async function lockActiveSchoolStudentsForOperationalWrite",
  );
  assert.match(authoritySnapshot, /if \(dbInstance\) return resolveSnapshot\(dbInstance\)/);
  assert.match(
    authoritySnapshot,
    /return db\.transaction\(async \(tx\) => resolveSnapshot\(tx/,
  );
  assert.doesNotMatch(authoritySnapshot, /dbInstance\.transaction/);
  assert.match(
    authoritySnapshot,
    /getActiveSessionsForStudents\([\s\S]*snapshotDb[\s\S]*getActiveSupervisionForStudents\([\s\S]*snapshotDb[\s\S]*getActiveClassOwnerForStudent\([\s\S]*snapshotDb/,
  );
});
