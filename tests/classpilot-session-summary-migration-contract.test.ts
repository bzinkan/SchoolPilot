import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const storageSource = readFileSync(new URL("../src/services/storage.ts", import.meta.url), "utf8");
const lifecycleSource = readFileSync(
  new URL("../src/services/classpilotSessionLifecycle.ts", import.meta.url),
  "utf8"
);
const scheduledStartSource = readFileSync(
  new URL("../src/services/classpilotScheduledStart.ts", import.meta.url),
  "utf8"
);
const presenceSource = readFileSync(
  new URL("../src/realtime/classpilotStaffPresence.ts", import.meta.url),
  "utf8"
);
const websocketSource = readFileSync(
  new URL("../src/realtime/websocket.ts", import.meta.url),
  "utf8"
);

function requiredMigrationBlock(startMarker: string, endMarker: string): string {
  const start = migrationSource.indexOf(startMarker);
  const end = migrationSource.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing migration marker: ${startMarker}`);
  assert.ok(end > start, `missing migration boundary after: ${startMarker}`);
  return migrationSource.slice(start, end);
}

describe("ClassPilot Session Summary startup migration contract", () => {
  it("keeps the immutable roster snapshot table and indexes fail-closed", () => {
    const snapshotBlock = requiredMigrationBlock(
      "// Session roster snapshots are now required runtime infrastructure",
      "// ClassPilot admin analytics: forward-only session-attributed class usage"
    );

    assert.match(snapshotBlock, /CREATE TABLE IF NOT EXISTS classpilot_session_students/);
    assert.match(snapshotBlock, /classpilot_session_students_session_student_unique/);
    assert.match(snapshotBlock, /classpilot_session_students_school_session_idx/);
    assert.match(snapshotBlock, /classpilot_session_students_school_group_idx/);
    assert.match(snapshotBlock, /classpilot_session_students_school_student_idx/);
    assert.doesNotMatch(snapshotBlock, /\btry\s*\{/);
    assert.doesNotMatch(snapshotBlock, /\bcatch\s*\(/);
    assert.doesNotMatch(snapshotBlock, /console\.warn/);
  });

  it("keeps the durable delivery outbox and indexes fail-closed", () => {
    const outboxBlock = requiredMigrationBlock(
      "// Durable ClassPilot session-summary delivery outbox",
      "// ClassPilot teacher command tracking"
    );

    assert.match(outboxBlock, /CREATE TABLE IF NOT EXISTS classpilot_session_summary_deliveries/);
    assert.match(outboxBlock, /cp_summary_delivery_session_kind_unique/);
    assert.match(outboxBlock, /cp_summary_delivery_session_email_unique/);
    assert.match(outboxBlock, /cp_summary_delivery_school_session_idx/);
    assert.match(outboxBlock, /cp_summary_delivery_due_idx/);
    assert.match(outboxBlock, /cp_summary_delivery_lease_idx/);
    assert.doesNotMatch(outboxBlock, /\btry\s*\{/);
    assert.doesNotMatch(outboxBlock, /\bcatch\s*\(/);
    assert.doesNotMatch(outboxBlock, /console\.warn/);
  });

  it("creates the immutable class-name snapshot as required occurrence metadata", () => {
    assert.match(
      migrationSource,
      /ALTER TABLE teaching_sessions ADD COLUMN IF NOT EXISTS class_name_snapshot TEXT/,
      "summary rendering must retain its class label after a group rename or archive"
    );
  });

  it("detaches rebuildable usage aggregation from finalization and contains rejection", () => {
    const finalizerStart = storageSource.indexOf("export async function finalizeTeachingSession");
    const finalizerEnd = storageSource.indexOf(
      "export async function listScheduledSessionsReadyToFinalize",
      finalizerStart
    );
    assert.ok(finalizerStart >= 0 && finalizerEnd > finalizerStart);
    const finalizer = storageSource.slice(finalizerStart, finalizerEnd);
    assert.doesNotMatch(finalizer, /aggregateClasspilotSessionUsage/);

    const sideEffectsStart = lifecycleSource.indexOf(
      "export function runClasspilotFinalizationSideEffects"
    );
    const sideEffectsEnd = lifecycleSource.indexOf("type SessionSummaryData", sideEffectsStart);
    assert.ok(sideEffectsStart >= 0 && sideEffectsEnd > sideEffectsStart);
    const sideEffects = lifecycleSource.slice(sideEffectsStart, sideEffectsEnd);
    assert.match(sideEffects, /void\s+runWithTenantContext/);
    assert.match(sideEffects, /runWithTenantContext\(\{\s*schoolId:\s*options\.schoolId\s*\}/);
    assert.match(sideEffects, /aggregateClasspilotSessionUsage\(result\.session\.id\)/);
    assert.doesNotMatch(sideEffects, /await\s+(?:runWithTenantContext|aggregateClasspilotSessionUsage)/);
    assert.match(
      sideEffects,
      /\.catch\(\(err\)\s*=>\s*\{[\s\S]*console\.warn/
    );

    const manualStartEnd = lifecycleSource.indexOf("export type ClasspilotSessionLifecycle");
    const manualStart = lifecycleSource.slice(
      lifecycleSource.indexOf("export async function startManualClasspilotSession"),
      manualStartEnd
    );
    const manualLockCommit = manualStart.indexOf("const outcome = await withTeachingSessionStartLock");
    const manualSideEffects = manualStart.indexOf("runClasspilotFinalizationSideEffects", manualLockCommit);
    assert.ok(manualLockCommit >= 0 && manualSideEffects > manualLockCommit);
    assert.match(manualStart.slice(0, manualSideEffects), /deferSideEffects:\s*true/);

    const scheduledStart = scheduledStartSource.slice(
      scheduledStartSource.indexOf("async function startScheduledClass(options:"),
      scheduledStartSource.indexOf("async function startScheduledClassLocked")
    );
    const scheduledLockCommit = scheduledStart.indexOf("const outcome = await withTeachingSessionStartLock");
    const scheduledSideEffects = scheduledStart.indexOf(
      "runClasspilotFinalizationSideEffects",
      scheduledLockCommit
    );
    assert.ok(scheduledLockCommit >= 0 && scheduledSideEffects > scheduledLockCommit);
    const scheduledLockedStart = scheduledStartSource.slice(
      scheduledStartSource.indexOf("async function startScheduledClassLocked"),
      scheduledStartSource.indexOf("export async function startScheduledClassFromConflict")
    );
    assert.match(scheduledLockedStart, /deferSideEffects:\s*true/);
    assert.doesNotMatch(scheduledLockedStart, /runClasspilotFinalizationSideEffects/);
  });

  it("bounds shared-presence failures without gating WebSocket authentication", () => {
    assert.match(
      presenceSource,
      /CLASSPILOT_STAFF_PRESENCE_OPERATION_TIMEOUT_MS\s*=\s*500/
    );
    const boundedStart = presenceSource.indexOf("async function boundedPresenceOperation");
    const boundedEnd = presenceSource.indexOf(
      "export function touchClasspilotStaffPresence",
      boundedStart
    );
    assert.ok(boundedStart >= 0 && boundedEnd > boundedStart);
    const boundedOperation = presenceSource.slice(boundedStart, boundedEnd);
    assert.match(boundedOperation, /Promise\.race/);
    assert.match(
      boundedOperation,
      /CLASSPILOT_STAFF_PRESENCE_OPERATION_TIMEOUT_MS/
    );
    assert.match(boundedOperation, /clearTimeout\(timer\)/);

    const presenceRecord = websocketSource.indexOf(
      "const presenceRecorded = recordStaffPresence(schoolId, userId)"
    );
    const authSuccess = websocketSource.indexOf(
      'ws.send(JSON.stringify({ type: "auth-success", role }))',
      presenceRecord
    );
    const deferredPickup = websocketSource.indexOf(
      "void presenceRecorded.then",
      authSuccess
    );
    assert.ok(presenceRecord >= 0 && authSuccess > presenceRecord && deferredPickup > authSuccess);
    assert.doesNotMatch(
      websocketSource.slice(presenceRecord, authSuccess),
      /\bawait\b/,
      "auth-success must be sent before waiting for the shared presence mutation"
    );
  });
});
