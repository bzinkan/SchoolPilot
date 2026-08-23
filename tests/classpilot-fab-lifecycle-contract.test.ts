import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("ClassPilot FAB lifecycle publication contract", () => {
  it("shares one authoritative start/end publisher", async () => {
    const lifecycle = await readFile(
      new URL("../src/services/classpilotSessionLifecycle.ts", import.meta.url),
      "utf8"
    );
    const delivery = await readFile(
      new URL("../src/services/classpilotControlStateDelivery.ts", import.meta.url),
      "utf8"
    );
    assert.match(lifecycle, /export async function publishClasspilotSessionFabStates/);
    assert.match(lifecycle, /event: "started"/);
    assert.match(lifecycle, /event: "ended"/);
    assert.match(lifecycle, /syncClasspilotControlStatesToActiveDevices/);
    assert.match(delivery, /classpilotFabStatePushFrame/);
    assert.match(delivery, /activeSessionIds: \[\]/);
  });

  it("limits start fanout to the frozen roster's current owned bindings", async () => {
    const source = await readFile(
      new URL("../src/services/classpilotSessionLifecycle.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      source,
      /options\.event === "started"\s*\? await getSessionStudentBindings\(options\.schoolId, options\.teachingSessionId\)/
    );
  });

  it("routes both manual and scheduled starts through the FAB publisher", async () => {
    const lifecycle = await readFile(
      new URL("../src/services/classpilotSessionLifecycle.ts", import.meta.url),
      "utf8"
    );
    const scheduled = await readFile(
      new URL("../src/services/classpilotScheduledStart.ts", import.meta.url),
      "utf8"
    );
    assert.match(lifecycle, /startManualClasspilotSession[\s\S]*pushClasspilotSessionControlStates/);
    assert.match(scheduled, /pushClasspilotSessionControlStates\(options\.group\.schoolId, outcome\.session\.id\)/);
  });

  it("does not let a bare device end event erase a replacement session", async () => {
    const lifecycle = await readFile(
      new URL("../src/services/classpilotSessionLifecycle.ts", import.meta.url),
      "utf8"
    );
    const publisher = lifecycle.slice(
      lifecycle.indexOf("export async function publishClasspilotSessionFabStates"),
      lifecycle.indexOf("async function publishControlStateRows")
    );
    assert.match(publisher, /syncClasspilotControlStatesToActiveDevices/);
    assert.doesNotMatch(publisher, /type: "session-ended"/);
  });

  it("publishes disabled FABs on claim and recomputed owned-class FABs on release", async () => {
    const delivery = await readFile(
      new URL("../src/services/classpilotControlStateDelivery.ts", import.meta.url),
      "utf8"
    );
    const fab = await readFile(
      new URL("../src/services/classpilotFab.ts", import.meta.url),
      "utf8"
    );
    const coverage = await readFile(
      new URL("../src/routes/classpilot/coverage.ts", import.meta.url),
      "utf8"
    );
    assert.match(delivery, /fabState = await buildStudentFabState\(schoolId, studentId, \{[\s\S]*studentSessionId: session\.id/);
    assert.match(fab, /const ownershipRevision = authority\.ownershipRevision/);
    assert.equal(fab.match(/\n\s+ownershipRevision,/g)?.length, 2);
    assert.match(fab, /const fullState = await buildStudentFabState\(options\.schoolId, binding\.studentId, \{[\s\S]*studentSessionId: binding\.studentSessionId/);
    assert.match(fab, /if \(supervision\)[\s\S]*activeSessionIds: \[\][\s\S]*messagingEnabled: false/);
    assert.match(fab, /activeSessionIds: sessions\.map\(\(session\) => session\.id\)/);
    assert.match(coverage, /coverage\/claim[\s\S]*syncClasspilotControlStatesToActiveDevices/);
    assert.match(coverage, /coverage\/contexts\/:id\/release[\s\S]*syncClasspilotControlStatesToActiveDevices/);
  });

  it("binds every authoritative FAB snapshot and toggle to the exact student session", async () => {
    const [fab, storage, delivery, websocket, devices] = await Promise.all([
      readFile(new URL("../src/services/classpilotFab.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/services/storage.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/services/classpilotControlStateDelivery.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/realtime/websocket.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8"),
    ]);
    const builder = fab.slice(
      fab.indexOf("export async function buildStudentFabState"),
      fab.indexOf("export async function getSessionStudentDeviceIds")
    );
    assert.equal(builder.match(/studentSessionId,/g)?.length, 2);
    assert.equal(builder.match(/schemaVersion: 1,\r?\n\s+studentId,/g)?.length, 2);
    const fanout = fab.slice(
      fab.indexOf("export async function updateAndFanoutSessionFabSettings"),
      fab.length
    );
    assert.match(fanout, /studentId: binding\.studentId/);
    assert.match(fanout, /studentSessionId: binding\.studentSessionId/);
    assert.match(delivery, /studentSessionId: session\.id/);
    assert.match(websocket, /studentSessionId: activeSession\.id/);
    assert.match(devices, /buildStudentFabState\(schoolId, studentId, \{ studentSessionId \}\)/);
    const atomicAuthority = storage.slice(
      storage.indexOf("export async function getClasspilotFabAuthoritySnapshot"),
      storage.indexOf("async function lockActiveSchoolStudentsForOperationalWrite")
    );
    assert.match(atomicAuthority, /lockClasspilotStudentControlAuthorities/);
    assert.match(atomicAuthority, /classpilotStudentControlStates[\s\S]*\.for\("share"\)/);
    assert.match(atomicAuthority, /getActiveSupervisionForStudents/);
    assert.match(atomicAuthority, /getActiveClassOwnerForStudent/);
  });
});
