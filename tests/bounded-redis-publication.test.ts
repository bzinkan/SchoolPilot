import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { createClient } from "redis";
import { BoundedRedisPublication, REDIS_PUBLICATION_LIMITS, type PublicationDiagnostic } from "../src/realtime/boundedRedisPublication.js";
import { checkHealthRedis } from "../src/services/healthRedis.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Real RESP sockets, not mocked Redis promises: a reply withheld after write
 * exercises the node-redis state where AbortSignal/command timeout no longer
 * bounds the operation. All traffic and data stay on loopback. */
async function respFixture() {
  const sockets = new Set<net.Socket>();
  let hold = false;
  const held: Array<() => void> = [];
  const published: string[] = [];
  let writes = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let queued: number | null = null;
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const count = Number(buffer.subarray(1, end));
        let cursor = end + 2;
        const args: string[] = [];
        for (let i = 0; i < count; i++) {
          const lengthEnd = buffer.indexOf("\r\n", cursor);
          if (lengthEnd < 0) return;
          const length = Number(buffer.subarray(cursor + 1, lengthEnd));
          cursor = lengthEnd + 2;
          if (buffer.length < cursor + length + 2) return;
          args.push(buffer.subarray(cursor, cursor + length).toString());
          cursor += length + 2;
        }
        buffer = buffer.subarray(cursor);
        const command = args[0]!.toUpperCase();
        if (command === "PUBLISH") published.push(args[2]!);
        if (command === "MULTI") { queued = 0; socket.write("+OK\r\n"); }
        else if (command === "PUBLISH" && queued !== null) { queued++; socket.write("+QUEUED\r\n"); }
        else if (["PUBLISH", "EVAL", "EXEC", "MGET", "GET", "SETEX", "PING"].includes(command)) {
          writes++;
          const reply = queued !== null ? `*${queued}\r\n${":1\r\n".repeat(queued)}` : command === "PING" ? "+PONG\r\n" : ":1\r\n";
          queued = null;
          const send = () => { if (!socket.destroyed) socket.write(reply); };
          if (hold) held.push(send); else send();
        } else socket.write("+OK\r\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return {
    url: `redis://127.0.0.1:${address.port}`,
    hold: () => { hold = true; }, release: () => { hold = false; held.splice(0).forEach(send => send()); },
    writes: () => writes,
    published: () => published.slice(),
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("real written PUBLISH returns unknown at 250ms, and a late reply never retries the effect", async () => {
  const fixture = await respFixture();
  const events: PublicationDiagnostic[] = [];
  const runtime = new BoundedRedisPublication({ create: () => {
    const client = createClient({ url: fixture.url, disableOfflineQueue: true }); client.on("error", () => {}); return client;
  }, onDiagnostic: event => events.push(event) });
  try {
    assert.equal((await runtime.publish(client => client.publish("synthetic", "warm"))).status, "accepted");
    fixture.hold();
    const started = performance.now();
    assert.deepEqual(await runtime.publish(client => client.publish("synthetic", "one-shot")), { status: "unknown", reason: "timeout" });
    assert.ok(performance.now() - started < 700);
    assert.equal(runtime.snapshot().active, 1);
    assert.equal(fixture.writes(), 2);
    fixture.release(); await pause(25);
    assert.equal(runtime.snapshot().active, 0);
    assert.ok(events.includes("late_accepted"));
    assert.equal(fixture.writes(), 2, "uncertain one-shot publication is never retried");
  } finally { await runtime.dispose(); await fixture.close(); }
});

test("withheld EXEC is unknown and the 2s watchdog disposes the real publisher generation", async () => {
  const fixture = await respFixture();
  const events: PublicationDiagnostic[] = [];
  const runtime = new BoundedRedisPublication({ create: () => {
    const client = createClient({ url: fixture.url, disableOfflineQueue: true }); client.on("error", () => {}); return client;
  }, onDiagnostic: event => events.push(event) });
  try {
    await runtime.publish(client => client.publish("synthetic", "warm")); fixture.hold();
    const result = await runtime.publish(client => client.multi().publish("synthetic", "a").publish("synthetic", "b").exec());
    assert.equal(result.status, "unknown");
    await pause(REDIS_PUBLICATION_LIMITS.rawWatchdogMs);
    assert.ok(events.includes("watchdog"));
    assert.equal(runtime.snapshot().active, 0);
    assert.equal(runtime.snapshot().ready, false);
    assert.ok(events.includes("circuit_open"));
  } finally { await runtime.dispose(); await fixture.close(); }
});

test("admission is capped at 32 raw operations even after callers have timed out", async () => {
  const operations = Array.from({ length: 32 }, () => deferred<number>());
  const connection = { isReady: true, connect: async () => {}, destroy: () => operations.forEach(op => op.reject(new Error("closed"))) };
  const runtime = new BoundedRedisPublication({ create: () => connection, limits: { ordinaryMs: 20, circuitFailures: 100 } });
  try {
    const pending = operations.map(operation => runtime.publish(() => operation.promise));
    assert.equal((await runtime.publish(async () => 0)).status, "not_admitted");
    assert.equal(runtime.snapshot().active, 32);
    assert.ok((await Promise.all(pending)).every(result => result.status === "unknown"));
    const denied = await runtime.publish(async () => 0);
    assert.deepEqual(denied, { status: "not_admitted", reason: "queue_full" });
  } finally { await runtime.dispose(); }
  assert.equal(runtime.snapshot().active, 0);
});

test("three unknown deadlines open the circuit; only one recovery probe may run", async () => {
  const operations = Array.from({ length: 4 }, () => deferred<number>());
  const connection = { isReady: true, connect: async () => {}, destroy: () => operations.forEach(op => op.reject(new Error("closed"))) };
  const runtime = new BoundedRedisPublication({ create: () => connection, random: () => 0.5,
    limits: { ordinaryMs: 10, initialBackoffMs: 20, maxBackoffMs: 40 } });
  try {
    await Promise.all(operations.slice(0, 3).map(operation => runtime.publish(() => operation.promise)));
    assert.deepEqual(await runtime.publish(async () => 1), { status: "not_admitted", reason: "circuit_open" });
    await pause(25);
    const probe = runtime.publish(() => operations[3]!.promise, { budgetMs: 100 });
    assert.deepEqual(await runtime.publish(async () => 1), { status: "not_admitted", reason: "circuit_open" });
    operations[3]!.resolve(1);
    assert.equal((await probe).status, "accepted");
    assert.equal(runtime.snapshot().circuitOpen, false);
  } finally { await runtime.dispose(); }
});

test("readiness and shutdown are bounded and never admit an operation", async () => {
  const connectionReady = deferred<void>();
  let invoked = 0;
  const runtime = new BoundedRedisPublication({ create: () => ({ isReady: false,
    connect: () => connectionReady.promise, destroy: () => connectionReady.reject(new Error("closed")) }), limits: { readyMs: 10 } });
  assert.deepEqual(await runtime.publish(async () => ++invoked), { status: "not_admitted", reason: "not_ready" });
  assert.equal(invoked, 0);
  await runtime.dispose();
  assert.deepEqual(await runtime.publish(async () => ++invoked), { status: "not_admitted", reason: "shutdown" });
  assert.equal(invoked, 0);
});

test("late ordinary acceptance cannot close an open circuit or bypass its single recovery probe", async () => {
  let now = 0;
  const operations = Array.from({ length: 4 }, () => deferred<number>());
  const connection = { isReady: true, connect: async () => {}, destroy: () => operations.forEach(op => op.reject(new Error("closed"))) };
  const events: PublicationDiagnostic[] = [];
  const runtime = new BoundedRedisPublication({ create: () => connection, now: () => now, random: () => 0.5,
    onDiagnostic: event => events.push(event), limits: { ordinaryMs: 10, initialBackoffMs: 100, maxBackoffMs: 200 } });
  try {
    await Promise.all(operations.slice(0, 3).map(operation => runtime.publish(() => operation.promise)));
    assert.equal(runtime.snapshot().circuitOpen, true);
    operations[0]!.resolve(1); await pause(0);
    assert.equal(runtime.snapshot().circuitOpen, true);
    assert.deepEqual(await runtime.publish(async () => 1), { status: "not_admitted", reason: "circuit_open" });
    now = 101;
    const probe = runtime.publish(() => operations[3]!.promise, { budgetMs: 100 });
    operations[1]!.resolve(1); await pause(0);
    assert.deepEqual(await runtime.publish(async () => 1), { status: "not_admitted", reason: "circuit_open" });
    assert.equal(events.includes("recovered"), false);
    operations[3]!.resolve(1);
    assert.equal((await probe).status, "accepted");
    assert.ok(events.includes("recovered"));
    assert.equal((await runtime.publish(async () => 1)).status, "accepted");
  } finally { await runtime.dispose(); }
});

test("post-admission scope cancellations remain unknown without counting circuit failures", async () => {
  const operations = Array.from({ length: 3 }, () => deferred<number>());
  const connection = { isReady: true, connect: async () => {}, destroy: () => operations.forEach(op => op.reject(new Error("closed"))) };
  const runtime = new BoundedRedisPublication({ create: () => connection });
  try {
    const controllers = operations.map(() => new AbortController());
    const pending = operations.map((operation, index) => runtime.publish(() => operation.promise, { signal: controllers[index]!.signal }));
    controllers.forEach(controller => controller.abort());
    assert.deepEqual(await Promise.all(pending), operations.map(() => ({ status: "unknown", reason: "aborted" })));
    assert.equal(runtime.snapshot().active, 3, "cancellation does not pretend an admitted operation was cancelled on Redis");
    assert.equal(runtime.snapshot().circuitOpen, false);
    assert.equal((await runtime.publish(async () => 1)).status, "accepted");
  } finally { await runtime.dispose(); }
});

test("three deadlines in the rolling window open the circuit even between ordinary successes", async () => {
  let now = 0;
  const operations = Array.from({ length: 6 }, () => deferred<number>());
  const runtime = new BoundedRedisPublication({
    create: () => ({ isReady: true, connect: async () => {}, destroy: () => {} }),
    now: () => now, random: () => 0.5, limits: { ordinaryMs: 5 },
  });
  try {
    for (const [index, time] of [0, 4_000, 9_999].entries()) {
      now = time;
      assert.deepEqual(await runtime.publish(() => operations[index]!.promise), { status: "unknown", reason: "timeout" });
      if (index < 2) assert.equal((await runtime.publish(async () => 1)).status, "accepted");
    }
    assert.equal(runtime.snapshot().circuitOpen, true);
    assert.deepEqual(await runtime.publish(async () => 1), { status: "not_admitted", reason: "circuit_open" });
    now = 11_000;
    assert.equal((await runtime.publish(async () => 1)).status, "accepted", "a timely half-open probe recovers the circuit");
    for (const [index, time] of [12_000, 13_000].entries()) {
      now = time;
      await runtime.publish(() => operations[index + 3]!.promise);
    }
    assert.equal(runtime.snapshot().circuitOpen, false, "recovery cleared the prior failure window");
    now = 23_001;
    await runtime.publish(() => operations[5]!.promise);
    assert.equal(runtime.snapshot().circuitOpen, false, "deadlines older than the rolling10s window expire");
  } finally { await runtime.dispose(); }
});

test("positive circuit jitter never exceeds the actual10s backoff cap", async () => {
  let now = 0;
  const operations = Array.from({ length: 6 }, () => deferred<number>());
  const runtime = new BoundedRedisPublication({
    create: () => ({ isReady: true, connect: async () => {}, destroy: () => {} }),
    now: () => now, random: () => 1, limits: { ordinaryMs: 5, circuitFailures: 1 },
  });
  try {
    for (const [index, baseDelay] of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000].entries()) {
      assert.deepEqual(await runtime.publish(() => operations[index]!.promise), { status: "unknown", reason: "timeout" });
      // Resolve the admitted attempt after its deadline so it releases the
      // single probe slot without recovering the circuit from a late reply.
      operations[index]!.resolve(1);
      await pause(0);
      const opensAt = now + Math.min(10_000, baseDelay * (0.8 + 0.4));
      now = opensAt - 1;
      assert.deepEqual(await runtime.publish(async () => 1), { status: "not_admitted", reason: "circuit_open" });
      now = opensAt;
      assert.equal(runtime.snapshot().circuitOpen, false, "the next single probe is admitted at the capped deadline");
    }
    assert.equal((await runtime.publish(async () => 1)).status, "accepted");
  } finally { await runtime.dispose(); }
});

test("retirement frees all32 permits even when destroy never settles raw promises", async () => {
  let now = 0;
  let generations = 0;
  const events: PublicationDiagnostic[] = [];
  const operations = Array.from({ length: 32 }, () => deferred<number>());
  const runtime = new BoundedRedisPublication({ create: () => { generations++; return { isReady: true, connect: async () => {}, destroy: () => {} }; },
    onDiagnostic: event => events.push(event), now: () => now, random: () => 0.5,
    limits: { ordinaryMs: 5, rawWatchdogMs: 30, circuitFailures: 100, initialBackoffMs: 10 } });
  try {
    const pending = operations.map(operation => runtime.publish(() => operation.promise));
    assert.ok((await Promise.all(pending)).every(result => result.status === "unknown"));
    await pause(50);
    assert.equal(runtime.snapshot().active, 0);
    assert.equal(runtime.snapshot().pending, 0);
    assert.equal(events.filter(event => event === "watchdog").length, 1, "retired-generation watchdogs cannot reopen the circuit");
    now = 11; // Advance the injected circuit clock beyond its exact10ms backoff.
    assert.equal((await runtime.publish(async () => 1)).status, "accepted");
    assert.equal(generations, 2);
    operations[0]!.resolve(1); await pause(0);
    assert.ok(events.includes("late_accepted"), "late dispositions remain observed after admission is released");
  } finally { await runtime.dispose(); }
});

test("staggered old-generation watchdogs cannot disturb a recovered new connection", async () => {
  let now = 0;
  let generations = 0;
  const events: PublicationDiagnostic[] = [];
  const operations = [deferred<number>(), deferred<number>()];
  const runtime = new BoundedRedisPublication({ create: () => { generations++; return { isReady: true, connect: async () => {}, destroy: () => {} }; },
    onDiagnostic: event => events.push(event), now: () => now, random: () => 0.5,
    limits: { ordinaryMs: 5, rawWatchdogMs: 80, circuitFailures: 100, initialBackoffMs: 10 } });
  try {
    await runtime.publish(() => operations[0]!.promise);
    await pause(30);
    await runtime.publish(() => operations[1]!.promise);
    await pause(55); // First watchdog has retired both old admissions.
    now = 11;
    assert.equal((await runtime.publish(async () => 1)).status, "accepted");
    await pause(40); // The second old operation's original watchdog deadline.
    assert.equal(runtime.snapshot().ready, true);
    assert.equal(runtime.snapshot().circuitOpen, false);
    assert.equal(events.filter(event => event === "circuit_open").length, 1);
    assert.equal(generations, 2);
  } finally { await runtime.dispose(); }
});

test("healthy generations detach retirement listeners after each settled command", async () => {
  const runtime = new BoundedRedisPublication({ create: () => ({ isReady: true, connect: async () => {}, destroy: () => {} }) });
  try {
    for (let index = 0; index < 500; index++) {
      assert.equal((await runtime.publish(async () => index)).status, "accepted");
      assert.equal(runtime.snapshot().retirementWaiters, 0, "a healthy long-lived socket must not retain historical operation callbacks");
    }
    assert.equal(runtime.snapshot().active, 0);
    assert.equal(runtime.snapshot().pending, 0);
  } finally { await runtime.dispose(); }
});

test("startup warmup is nonblocking and avoids a first-operation cold connection miss", async () => {
  let ready = false;
  const runtime = new BoundedRedisPublication({ create: () => ({
    get isReady() { return ready; }, connect: async () => { await pause(120); ready = true; }, destroy: () => {},
  }) });
  const started = performance.now();
  runtime.warmup();
  assert.ok(performance.now() - started < 50);
  await pause(140);
  try { assert.deepEqual(await runtime.publish(async () => 1), { status: "accepted", value: 1 }); }
  finally { await runtime.dispose(); }
});

test("actual screenshot read and write adapters bound withheld Redis replies and keep their connection independent", async () => {
  const fixture = await respFixture();
  process.env.REDIS_URL = fixture.url;
  const realtime = await import("../src/realtime/ws-redis.js");
  try {
    const inputs = Array.from({ length: 41 }, (_, index) => ({
      target: { kind: "staff-user" as const, schoolId: "original-school", userId: `original-user-${index}` },
      message: { type: "synthetic-update", detail: { label: `original-${index}` } }, includeSource: false,
    }));
    const batch = realtime.publishWSBatchOutcomes(inputs);
    assert.equal(realtime.getRedisPublicationSnapshot().ready, false, "the first publication is waiting for connection readiness");
    for (const input of inputs) {
      input.target.schoolId = "mutated-school";
      input.target.userId = "mutated-user";
      input.message.detail.label = "mutated-message";
      input.includeSource = true;
    }
    inputs.reverse();
    inputs.pop();
    const outcomes = await batch;
    assert.equal(outcomes.length, 41, "the batch cardinality is frozen before readiness");
    assert.ok(outcomes.every(outcome => outcome.status === "accepted"));
    const envelopes = fixture.published().map(value => JSON.parse(value));
    assert.equal(envelopes.length, 41);
    for (const [index, envelope] of envelopes.entries()) {
      assert.deepEqual(envelope.target, { kind: "staff-user", schoolId: "original-school", userId: `original-user-${index}` });
      assert.deepEqual(envelope.message, { type: "synthetic-update", detail: { label: `original-${index}` } });
      assert.equal("includeSource" in envelope, false, "the original false option stays omitted from the wire envelope");
    }
    assert.equal(await realtime.executeRealtimeRedisCommand(["PING"]), "PONG");
    fixture.hold();
    const binding = { schoolId: "synthetic-school", deviceId: "synthetic-device", studentId: "synthetic-student",
      studentSessionId: "synthetic-session", teachingSessionId: "synthetic-class", controlRevision: 1 };
    const started = performance.now();
    assert.deepEqual(await realtime.getClassBoundScreenshots([binding]), { status: "unavailable" });
    assert.ok(performance.now() - started < 700);
    const timestamp = Date.now();
    const stored = await realtime.setClassBoundScreenshot(binding, { ...binding, screenshot: "synthetic-pixels", timestamp,
      capturedAt: new Date(timestamp).toISOString(), bindingVersion: realtime.classBoundScreenshotBindingVersion(binding) });
    assert.equal(stored, false, "unknown storage is unavailable, never a successful screenshot receipt");
    assert.equal(realtime.getRedisCoordinationSnapshot().active, 2);
    assert.equal(realtime.getRedisPublicationSnapshot().active, 0);
    const healthStarted = performance.now();
    assert.equal((await checkHealthRedis(true, realtime.executeRealtimeRedisCommand)).ok, false);
    assert.ok(performance.now() - healthStarted < 900, "health monitoring also bounds a PING written to a blackholed RESP peer");
    const orderedKey = "synthetic:ordered-timeout";
    const ordered = await realtime.publishOrderedWS({ kind: "staff-user", schoolId: "synthetic-school", userId: "synthetic-staff" },
      { type: "synthetic-update" }, { orderedKey, revision: "1" });
    assert.deepEqual(ordered, { status: "unknown", subscriberCount: 0, reason: "timeout" });
    assert.equal(realtime.recordLocalOrderedDelivery(orderedKey, "1"), true,
      "an unknown global claim cannot advance the source-local delivered watermark");
  } finally {
    await realtime.disposeWSRedis(); await fixture.close(); process.env.REDIS_URL = "";
  }
});
