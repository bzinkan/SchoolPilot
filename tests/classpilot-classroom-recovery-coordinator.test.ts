import assert from "node:assert/strict";
import test from "node:test";
import {
  ClasspilotClassroomRecoveryCoordinator,
  ClasspilotRecoveryCancelledError,
  type ClasspilotRecoveryIdentity,
} from "../src/realtime/classpilotClassroomRecovery.js";

function fixture() {
  let open = true, running = true;
  let identity: ClasspilotRecoveryIdentity | undefined = { schoolId: "school-fixture", studentId: "student-fixture",
    studentSessionId: "session-fixture", deviceId: "device-fixture", generation: 1, acceptedCapabilities: ["scopedAuthorityChecksV1"] };
  const counters: string[] = [], failures: Array<{ error: unknown; stage: string }> = [], pending: Promise<unknown>[] = [];
  const coordinator = new ClasspilotClassroomRecoveryCoordinator({
    identity: () => identity, open: () => open, accepting: () => running,
    counter: name => { counters.push(name); }, timing: () => {},
    failure: (error, stage) => { failures.push({ error, stage }); },
    track: promise => { pending.push(promise); },
  });
  return { coordinator, counters, failures, pending,
    close() { open = false; coordinator.invalidate(); },
    stop() { running = false; },
    replace() { identity = identity ? { ...identity, generation: identity.generation + 1, studentSessionId: "new-session" } : undefined; },
    unregister() { identity = undefined; },
    identity: () => identity,
  };
}

test("closed admission does no work and duplicate admission coalesces before execution", async () => {
  const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
  assert.equal(f.coordinator.admit(), undefined);
  assert.equal(f.counters.filter(name => name === "classroomRecoveryCoalesced").length, 1);
  f.close();
  let calls = 0;
  await f.coordinator.run(attempt, async () => { calls++; return "transmitted"; });
  assert.equal(calls, 0); assert.equal(f.failures.length, 0);
  assert.ok(f.counters.includes("classroomRecoveryCancelledClosed"));
  assert.equal(f.coordinator.admit(), undefined);
});

test("identity is immutable and a superseded attempt cannot release a newer admission", async () => {
  const f = fixture(), old = f.coordinator.admit(); assert.ok(old);
  f.identity()!.acceptedCapabilities.push("untrusted-later-capability");
  assert.deepEqual(old.identity.acceptedCapabilities, ["scopedAuthorityChecksV1"]);
  f.replace();
  const current = f.coordinator.admit(); assert.ok(current);
  await f.coordinator.run(old, async () => { assert.fail("Old work must not start"); });
  assert.equal(f.coordinator.admit(), undefined, "Old finally must not clear the current token");
  await f.coordinator.run(current, async attempt => { attempt.assertCurrent(); return "withheld"; });
  assert.ok(f.coordinator.admit());
  assert.equal(f.failures.length, 0);
  assert.ok(f.counters.includes("classroomRecoveryCancelledSuperseded"));
});

test("unregistered connections and server shutdown fence queued work", async () => {
  for (const change of ["unregister", "stop"] as const) {
    const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
    f[change]();
    await f.coordinator.run(attempt, async () => { assert.fail("Retired work cannot reach the database"); });
    assert.deepEqual(f.failures, []);
    assert.ok(f.counters.includes(change === "stop" ? "classroomRecoveryCancelledClosed" : "classroomRecoveryCancelledSuperseded"));
  }
});

test("cancellation unwinds its transaction before it is counted and never means successful delivery", async () => {
  const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
  let rolledBack = false;
  await f.coordinator.run(attempt, async current => {
    try { f.close(); current.assertCurrent(); }
    finally { assert.equal(f.counters.includes("classroomRecoveryCancelledClosed"), false); rolledBack = true; }
    return "transmitted";
  });
  assert.equal(rolledBack, true);
  assert.equal(f.failures.length, 0);
  assert.equal(f.counters.includes("classroomRecoveryTransmitted"), false);
});

test("SQL or commit errors remain failures even after the peer closes", async () => {
  for (const stage of ["authority", "projection", "commit"] as const) {
    const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
    const error = new Error("Student WebSocket closed during classroom-state recovery");
    await f.coordinator.run(attempt, async current => { current.stage = stage; f.close(); throw error; });
    assert.deepEqual(f.failures, [{ error, stage }]);
    assert.ok(f.counters.includes("classroomRecoveryServiceFailed"));
    assert.equal(f.counters.includes("classroomRecoveryCancelledClosed"), false);
  }
});

test("synchronous sends and asynchronous send callbacks remain observable failures", async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
    const error = new Error("synthetic send failure");
    let finish: ((error?: Error) => void) | undefined;
    await f.coordinator.run(attempt, async current => {
      current.send({ type: "classroom-state-sync" }, (_payload, callback) => {
        if (!asynchronous) throw error;
        finish = callback;
      });
      return "transmitted";
    });
    if (asynchronous) { f.close(); finish!(error); await Promise.all(f.pending); }
    assert.deepEqual(f.failures, [{ error, stage: "send" }]);
    assert.equal(f.counters.filter(name => name === "classroomRecoveryTransportFailed").length, 1);
    assert.equal(f.counters.includes("classroomRecoveryTransmitted"), false);
  }
});

test("transport write completion follows commit and never claims student application", async () => {
  const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
  let commit!: () => void;
  const committed = new Promise<void>(resolve => { commit = resolve; });
  const run = f.coordinator.run(attempt, async current => {
    current.send({ type: "classroom-state-sync" }, (_payload, callback) => { callback(); });
    await committed; return "transmitted";
  });
  await Promise.resolve();
  assert.equal(f.counters.includes("classroomRecoveryTransmitted"), false);
  commit(); await run; await Promise.all(f.pending);
  assert.equal(f.counters.filter(name => name === "classroomRecoveryTransmitted").length, 1);
  assert.equal(f.counters.some(name => /applied|ack/i.test(name)), false);
});

test("serialization failures and a failed transaction after queueing never claim success", async () => {
  for (const serialization of [true, false]) {
    const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
    const cycle: Record<string, unknown> = {}; cycle.cycle = cycle;
    await f.coordinator.run(attempt, async current => {
      current.send(serialization ? cycle : {}, (_payload, callback) => { callback(); });
      current.stage = "commit"; throw new Error("synthetic commit failure");
    });
    assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0]!.stage, serialization ? "serialization" : "commit");
    assert.equal(f.counters.includes("classroomRecoveryTransmitted"), false);
  }
});

test("queued callbacks remain drain-owned and report failure after COMMIT or a later send fails", async () => {
  for (const stage of ["commit", "send"] as const) {
    const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
    let callback!: (error?: Error) => void;
    const primary = new Error("synthetic primary failure"), transport = new Error("synthetic callback failure");
    await f.coordinator.run(attempt, async current => {
      current.send({}, (_payload, finish) => { callback = finish; });
      current.stage = stage;
      if (stage === "send") current.send({}, () => { throw primary; });
      throw primary;
    });
    callback(transport);
    assert.equal(f.pending.length, 1, "Transaction failure must still register every queued callback with drain");
    await Promise.all(f.pending);
    assert.deepEqual(f.failures, [{ error: primary, stage }, { error: transport, stage: "send" }]);
    assert.equal(f.counters.includes("classroomRecoveryTransmitted"), false);
  }
});

test("one failed write cannot finish shutdown ownership of another pending write", async () => {
  const f = fixture(), attempt = f.coordinator.admit(); assert.ok(attempt);
  const callbacks: Array<(error?: Error) => void> = [];
  await f.coordinator.run(attempt, async current => {
    current.send({}, (_payload, finish) => { callbacks.push(finish); });
    current.send({}, (_payload, finish) => { callbacks.push(finish); });
    return "transmitted";
  });
  let drained = false;
  const drain = Promise.all(f.pending).then(() => { drained = true; });
  callbacks[0]!(new Error("first write failed"));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(drained, false, "The second write still belongs to shutdown drain");
  callbacks[1]!(); await drain;
  assert.equal(f.failures.length, 1);
});

test("ordinary AbortError is not a recovery cancellation, but the branded cancellation is", () => {
  assert.equal(new Error("closed") instanceof ClasspilotRecoveryCancelledError, false);
  const cancelled = new ClasspilotRecoveryCancelledError("socket_closed");
  assert.equal(cancelled.reason, "socket_closed");
});
