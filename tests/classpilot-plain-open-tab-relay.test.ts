import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  ClasspilotPlainOpenTabRelay, PLAIN_OPEN_TAB_RELAY_LIMITS,
  type PlainOpenTabRelayTarget, type PlainOpenTabRelayAuthority,
} from "../src/realtime/classpilotPlainOpenTabRelay.js";

type Ports = ConstructorParameters<typeof ClasspilotPlainOpenTabRelay>[0];
const url = "https://example.test/lesson";
const start = Date.now();
const target = (n: number): PlainOpenTabRelayTarget => ({ kind: "student-binding", schoolId: "school",
  studentId: `student-${n}`, studentSessionId: `session-${n}`, deviceId: `device-${n}` });
function frame(binding: PlainOpenTabRelayTarget, commandId = "command") {
  return { type: "remote-control", _msgId: `message-${binding.studentId}`, commandId,
    studentId: binding.studentId, studentSessionId: binding.studentSessionId,
    deliveryPolicy: "transient_action", expiresAt: new Date(start + 15_000).toISOString(),
    command: { type: "open-tab", commandId, studentId: binding.studentId,
      studentSessionId: binding.studentSessionId, deliveryPolicy: "transient_action",
      expiresAt: new Date(start + 15_000).toISOString(),
      authority: { teachingSessionId: "teaching", supervisionContextId: null as string | null },
      teachingSessionId: "teaching", supervisionContextId: null as string | null, data: { url } } };
}
function authority(schoolId = "school", commandId = "command"): PlainOpenTabRelayAuthority {
  return { command: { id: commandId, schoolId, commandType: "open-tab", commandPayload: { url },
    teachingSessionId: "teaching", supervisionContextId: null, expiresAt: new Date(start + 15_000) }, isCurrent: () => true };
}
function harness(overrides: Partial<Ports> = {}) {
  const batches: Array<{ schoolId: string; commandId: string; count: number }> = [];
  const sent: unknown[] = [], serialized: unknown[] = [];
  const ports: Ports = { now: () => start, hasLocal: () => true,
    sendLocal: (_binding, message) => { sent.push(message); return true; },
    fallback: async (_binding, message) => { serialized.push(message); return true; },
    runBatch: async (options, send) => {
      batches.push({ schoolId: options.schoolId, commandId: options.commandId, count: options.targets.length });
      return options.targets.map(row => ({ authorized: true, value: send(row, authority(options.schoolId, options.commandId)) }));
    }, ...overrides };
  return { relay: new ClasspilotPlainOpenTabRelay(ports), ports, batches, sent, serialized };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("forty exact local frames share one cohort while retaining every original envelope", async () => {
  const h = harness(), messages = Array.from({ length: 40 }, (_, n) => frame(target(n)));
  assert.deepEqual(await Promise.all(messages.map((message, n) => h.relay.deliver(target(n), message))), Array(40).fill(true));
  assert.deepEqual(h.batches, [{ schoolId: "school", commandId: "command", count: 40 }]);
  assert.deepEqual(h.sent, messages); assert.notEqual(h.sent[0], messages[0]);
  assert.equal(h.serialized.length, 0); await h.relay.drain();
  assert.deepEqual(h.relay.state(), { queuedGroups: 0, activeBatches: 0, frames: 0, bytes: 0, pending: 0, stopped: false });
});

test("enqueue freezes original payload, message id, deadlines and capability requirements", async () => {
  let checkedCapabilities: string[] | undefined;
  const h = harness({ hasLocal: binding => { checkedCapabilities = binding.requiredCapabilities; return true; } });
  const binding: PlainOpenTabRelayTarget = { ...target(1), requiredCapabilities: ["screenshotActiveObservationCadenceV1"] };
  const message = frame(binding), original = structuredClone(message);
  const result = h.relay.deliver(binding, message); message._msgId = "mutated"; message.command.data.url = "https://changed.test/";
  message.expiresAt = new Date(start + 60_000).toISOString(); binding.requiredCapabilities!.push("focusTabV1");
  assert.equal(await result, true); assert.deepEqual(h.sent, [original]); assert.ok(Object.isFrozen(h.sent[0]));
  assert.deepEqual(checkedCapabilities, ["screenshotActiveObservationCadenceV1"]); assert.ok(Object.isFrozen(checkedCapabilities));
});

test("rich, malformed or mismatched envelope shapes retain only the pre-dispatch serialized path", async () => {
  const changes = [
    (m: ReturnType<typeof frame>) => Object.assign(m, { classroomState: {} }),
    (m: ReturnType<typeof frame>) => Object.assign(m.command, { currentPage: true }),
    (m: ReturnType<typeof frame>) => Object.assign(m.command.data, { focusAfterOpen: true }),
    (m: ReturnType<typeof frame>) => { m.command.commandId = "other"; },
    (m: ReturnType<typeof frame>) => { m.command.studentSessionId = "other"; },
    (m: ReturnType<typeof frame>) => { m.command.teachingSessionId = "other"; },
    (m: ReturnType<typeof frame>) => { m.command.expiresAt = "invalid"; },
    (m: ReturnType<typeof frame>) => { m.command.type = "teacher-message"; },
  ];
  for (const change of changes) { const h = harness(), message = frame(target(1)); change(message);
    assert.equal(await h.relay.deliver(target(1), message), true); assert.equal(h.batches.length, 0); assert.deepEqual(h.serialized, [message]); }
});

test("an expired original plain frame is retired without a database attempt or fallback", async () => {
  const h = harness({ now: () => start + 15_000 });
  assert.equal(await h.relay.deliver(target(1), frame(target(1))), false);
  assert.equal(h.batches.length, 0); assert.equal(h.serialized.length, 0);
});

test("both original deadlines remain binding through queue and callback despite a renewed DB deadline", async () => {
  let now = start;
  const h = harness({ now: () => now, runBatch: async (options, send) => {
    now = start + 15_000; const current = authority(); current.command.expiresAt = new Date(start + 60_000);
    return options.targets.map(row => ({ authorized: true, value: send(row, current) }));
  } });
  assert.equal(await h.relay.deliver(target(1), frame(target(1))), false); assert.equal(h.sent.length, 0); assert.equal(h.serialized.length, 0);
  const queued = harness({ now: () => now }); now = start;
  const pending = queued.relay.deliver(target(2), frame(target(2))); now += 15_000;
  assert.equal(await pending, false); assert.equal(queued.batches.length, 0);
});

test("DB command, URL, exact authority and database clock cannot be borrowed", async () => {
  const changes = [
    (a: PlainOpenTabRelayAuthority) => { a.command.id = "other"; },
    (a: PlainOpenTabRelayAuthority) => { a.command.schoolId = "other"; },
    (a: PlainOpenTabRelayAuthority) => { a.command.commandType = "teacher-message"; },
    (a: PlainOpenTabRelayAuthority) => { a.command.commandPayload = { url: "https://other.test/" }; },
    (a: PlainOpenTabRelayAuthority) => { a.command.commandPayload = { url, focusAfterOpen: true }; },
    (a: PlainOpenTabRelayAuthority) => { a.command.teachingSessionId = "other"; },
    (a: PlainOpenTabRelayAuthority) => { a.command.supervisionContextId = "other"; },
    (a: PlainOpenTabRelayAuthority) => { a.command.expiresAt = new Date(start + 14_000); },
    (a: PlainOpenTabRelayAuthority) => { a.isCurrent = () => false; },
  ];
  for (const change of changes) { const h = harness({ runBatch: async (options, send) => {
    const current = authority(); change(current); return options.targets.map(row => ({ authorized: true, value: send(row, current) }));
  } }); assert.equal(await h.relay.deliver(target(1), frame(target(1))), false); assert.equal(h.sent.length, 0); assert.equal(h.serialized.length, 0); }
});

test("local exact socket and capability admission is repeated before DB and immediately before send", async () => {
  const absent = harness({ hasLocal: () => false }); assert.equal(await absent.relay.deliver(target(1), frame(target(1))), false);
  assert.equal(absent.batches.length, 0);
  let checks = 0; const changed = harness({ hasLocal: () => ++checks === 1 });
  assert.equal(await changed.relay.deliver(target(1), frame(target(1))), false);
  assert.equal(changed.batches.length, 1); assert.equal(changed.sent.length, 0); assert.equal(changed.serialized.length, 0);
});

test("exact duplicates share the owned outcome while conflicting student frames and forty-first targets are refused", async () => {
  let notAdmitted = 0;
  const h = harness({ onNotAdmitted: () => { notAdmitted++; } }), message = frame(target(1));
  const first = h.relay.deliver(target(1), message);
  assert.equal(h.relay.deliver(target(1), structuredClone(message)), first);
  const conflict = structuredClone(message); conflict._msgId = "different";
  assert.equal(await h.relay.deliver(target(1), conflict), false);
  assert.equal(await first, true); assert.equal(await h.relay.deliver(target(1), message), true);
  assert.equal(h.batches.length, 1); assert.equal(h.sent.length, 1); assert.equal(h.serialized.length, 0);
  const full = harness(), results = await Promise.all(Array.from({ length: 41 }, (_, n) => full.relay.deliver(target(n), frame(target(n)))));
  assert.deepEqual(results, [...Array(40).fill(true), false]); assert.equal(full.batches[0]!.count, 40);
  assert.equal(full.serialized.length, 0); assert.equal(notAdmitted, 1);
});

test("unique arrivals for an active cohort wait for its settlement, including stop and drain", async () => {
  const gate = deferred(); let active = 0, peak = 0, calls = 0;
  const h = harness({ runBatch: async (options, send) => {
    calls++; active++; peak = Math.max(peak, active);
    if (calls === 1) await gate.promise;
    active--; return options.targets.map(row => ({ authorized: true, value: send(row, authority()) }));
  } });
  const first = h.relay.deliver(target(1), frame(target(1))); await nextTurn(); assert.equal(calls, 1);
  const trailing = [2, 3].map(n => h.relay.deliver(target(n), frame(target(n))));
  await nextTurn(); assert.equal(calls, 1); assert.equal(h.relay.state().queuedGroups, 1);
  h.relay.stop(); let drained = false; const drain = h.relay.drain().then(() => { drained = true; });
  await nextTurn(); assert.equal(drained, false); gate.resolve();
  assert.deepEqual(await Promise.all([first, ...trailing]), [true, true, true]); await drain;
  assert.equal(calls, 2); assert.equal(peak, 1); assert.equal(h.serialized.length, 0);
});

test("separate school/command groups never merge and at most two DB cohorts run during owned shutdown drain", async () => {
  const gate = deferred(); let running = 0, peak = 0, calls = 0;
  const h = harness({ runBatch: async (options, send) => { calls++; running++; peak = Math.max(peak, running);
    await gate.promise; running--; return options.targets.map(row => ({ authorized: true, value: send(row, authority(options.schoolId, options.commandId)) })); } });
  const callsPending = [1, 2, 3].map(n => h.relay.deliver(target(n), frame(target(n), `command-${n}`)));
  await nextTurn(); assert.equal(calls, 2); assert.equal(peak, 2); assert.equal(h.relay.state().frames, 3);
  h.relay.stop(); assert.equal(await h.relay.deliver(target(4), frame(target(4))), false);
  let drained = false; const drain = h.relay.drain().then(() => { drained = true; }); await nextTurn(); assert.equal(drained, false);
  gate.resolve(); assert.ok((await Promise.all(callsPending)).every(Boolean)); await drain;
  assert.equal(calls, 3); assert.equal(peak, 2); assert.equal(h.relay.state().frames, 0); assert.equal(h.relay.state().bytes, 0);
});

test("partial send followed by a send/commit error never retries or invokes serialized fallback", async () => {
  let attempted = 0; const h = harness({ runBatch: async (options, send) => {
    attempted++; send(options.targets[0]!, authority()); throw Error("Synthetic commit failure after a local send");
  } }); const results = await Promise.all([1, 2].map(n => h.relay.deliver(target(n), frame(target(n)))));
  assert.deepEqual(results, [false, false]); assert.equal(h.sent.length, 1); assert.equal(attempted, 1); assert.equal(h.serialized.length, 0);
  assert.equal(await h.relay.deliver(target(1), frame(target(1))), false);
  assert.equal(attempted, 1); assert.equal(h.sent.length, 1);
  await h.relay.drain(); assert.equal(attempted, 1); assert.equal(h.relay.state().pending, 0);
});

test("finite queued frame, group and byte caps refuse admission without bypassing DB concurrency", async () => {
  let refused = 0;
  const frames = harness({ onNotAdmitted: () => { refused++; } }), requests = Array.from({ length: 1281 }, (_, n) => frames.relay.deliver(target(n), frame(target(n), `command-${Math.floor(n / 40)}`)));
  assert.ok(frames.relay.state().frames <= PLAIN_OPEN_TAB_RELAY_LIMITS.frames);
  assert.ok(frames.relay.state().bytes <= PLAIN_OPEN_TAB_RELAY_LIMITS.bytes);
  const outcomes = await Promise.all(requests); assert.equal(outcomes.at(-1), false); assert.ok(refused > 0); assert.equal(frames.serialized.length, 0);
  const groups = harness(), separate = Array.from({ length: 33 }, (_, n) => groups.relay.deliver(target(n), frame(target(n), `command-${n}`)));
  assert.equal(groups.relay.state().queuedGroups, PLAIN_OPEN_TAB_RELAY_LIMITS.groups);
  assert.equal((await Promise.all(separate)).at(-1), false); assert.equal(groups.serialized.length, 0);
  const large = harness(), message = frame(target(1)); message.command.data.url += "a".repeat(PLAIN_OPEN_TAB_RELAY_LIMITS.bytes);
  assert.equal(await large.relay.deliver(target(1), message), false); assert.equal(large.relay.state().frames, 0); assert.equal(large.batches.length, 0); assert.equal(large.serialized.length, 0);
});

test("throwing local lookups retire owned items and never strand stop/drain", async () => {
  const h = harness({ hasLocal: () => { throw Error("Synthetic lookup fault"); } });
  const pending = [1, 2].map(n => h.relay.deliver(target(n), frame(target(n))));
  h.relay.stop(); assert.deepEqual(await Promise.all(pending), [false, false]); await h.relay.drain();
  assert.equal(h.relay.state().pending, 0); assert.equal(h.relay.state().frames, 0); assert.equal(h.relay.state().bytes, 0);
  assert.equal(h.batches.length, 0); assert.equal(h.serialized.length, 0);
});

test("copy failures refuse admission and numeric instrumentation cannot alter delivery", async () => {
  let now = 2, refused = 0; const waits: number[] = [];
  const h = harness({ monotonicNow: () => now, onQueueWait: ms => { waits.push(ms); throw Error("Sink fault"); },
    onNotAdmitted: () => { refused++; throw Error("Sink fault"); } });
  const uncopyable = { ...target(1), callback: () => false };
  assert.equal(await h.relay.deliver(uncopyable, frame(uncopyable)), false);
  const pending = h.relay.deliver(target(2), frame(target(2))); now = 12;
  assert.equal(await pending, true); assert.deepEqual(waits, [10]); assert.equal(refused, 1); await h.relay.drain();
});

test("completed original-deadline history remains bounded and expiry reclaims its admission counters", async () => {
  let now = start, calls = 0;
  const h = harness({ now: () => now, runBatch: async (options, send) => {
    calls++; const current = authority(options.schoolId, options.commandId); current.command.expiresAt = new Date(start + 60_000);
    return options.targets.map(row => ({ authorized: true, value: send(row, current) }));
  } });
  const requests = Array.from({ length: PLAIN_OPEN_TAB_RELAY_LIMITS.groups }, (_, n) => h.relay.deliver(target(n), frame(target(n), `command-${n}`)));
  assert.ok((await Promise.all(requests)).every(Boolean)); await h.relay.drain();
  assert.equal(h.relay.state().frames, 0); assert.equal(h.relay.state().bytes, 0);
  assert.equal(await h.relay.deliver(target(99), frame(target(99), "blocked-history")), false);
  assert.equal(calls, 32); assert.equal(h.serialized.length, 0);
  now = start + 15_000;
  const fresh = frame(target(100), "fresh-original");
  fresh.expiresAt = fresh.command.expiresAt = new Date(start + 30_000).toISOString();
  assert.equal(await h.relay.deliver(target(100), fresh), true); assert.equal(calls, 33);
  assert.equal(h.serialized.length, 0); await h.relay.drain();
});
