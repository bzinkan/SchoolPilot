import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { ErrorReply } from "redis";
import { executeRedisScriptCommand } from "../src/realtime/redisScriptCommand.ts";
import { BoundedRedisPublication } from "../src/realtime/boundedRedisPublication.ts";

const script = "return ARGV[1]";
const command = ["EVAL", script, "2", "scope:first", "scope:second", "", "\u00e9", "{\"revision\":7}"];
const shaCommand = ["EVALSHA", "098e0f0d1448c0a81dafe820f66d460eb09263da", ...command.slice(2)];
const noScript = () => new ErrorReply("NOSCRIPT No matching script. Please use EVAL.");
const readyOptions = () => ({ deadlineAt: performance.now() + 1_000, isReady: () => true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

test("EVAL uses its content digest without changing key count, keys, argument bytes or reply", async () => {
  const reply = ["", 0, null];
  const result = await executeRedisScriptCommand(async args => {
    assert.deepEqual(args, shaCommand);
    return reply;
  }, command, readyOptions());
  assert.strictEqual(result, reply);
  assert.deepEqual(command, ["EVAL", script, "2", "scope:first", "scope:second", "", "\u00e9", "{\"revision\":7}"]);
});

test("commands other than EVAL retain their exact command object and outcome", async () => {
  for (const original of [["SET", "opaque", "value", "NX", "EX", "60"], ["EVALSHA", "existing", "0"], ["MGET", "one", "two"], []]) {
    assert.equal(await executeRedisScriptCommand(async args => {
      assert.strictEqual(args, original);
      return 0;
    }, original, readyOptions()), 0);
  }
});

test("a definite NOSCRIPT reply loads and executes the original script exactly once", async () => {
  const attempts: string[][] = [];
  assert.equal(await executeRedisScriptCommand(async args => {
    attempts.push(args);
    if (attempts.length === 1) throw noScript();
    assert.deepEqual(args, command);
    return 0;
  }, command, readyOptions()), 0);
  assert.deepEqual(attempts, [shaCommand, command]);
});

test("NOSCRIPT recovery retains the original script, keys and arguments when the caller reuses its array", async () => {
  const miss = deferred<number>();
  const original = ["EVAL", "return ARGV[1]", "1", "original:key", "original:value"];
  const attempts: string[][] = [];
  const pending = executeRedisScriptCommand(async args => {
    attempts.push(args);
    return attempts.length === 1 ? miss.promise : 1;
  }, original, readyOptions());
  original[1] = "return 0";
  original[3] = "different:key";
  original[4] = "different:value";
  miss.reject(noScript());
  assert.equal(await pending, 1);
  assert.deepEqual(attempts, [
    ["EVALSHA", "098e0f0d1448c0a81dafe820f66d460eb09263da", "1", "original:key", "original:value"],
    ["EVAL", "return ARGV[1]", "1", "original:key", "original:value"],
  ]);
});

test("a failure of the original EVAL is terminal even when its reply is NOSCRIPT", async () => {
  const error = noScript();
  let attempts = 0;
  await assert.rejects(executeRedisScriptCommand(async () => {
    attempts++;
    throw error;
  }, command, readyOptions()), error);
  assert.equal(attempts, 2);
});

test("timeouts, disconnects, other Redis errors and unverified NOSCRIPT-looking errors never retry", async () => {
  for (const error of [new Error("timeout"), new Error("Socket closed unexpectedly"),
    new Error("NOSCRIPT No matching script. Please use EVAL."),
    new ErrorReply("ERR NOSCRIPT was mentioned in a script"), new ErrorReply("BUSY Redis is busy running a script")]) {
    let attempts = 0;
    await assert.rejects(executeRedisScriptCommand(async () => {
      attempts++;
      throw error;
    }, command, readyOptions()), error);
    assert.equal(attempts, 1, error.message);
  }
});

test("NOSCRIPT after the absolute deadline never starts an EVAL", async () => {
  let now = 10;
  let attempts = 0;
  const error = noScript();
  await assert.rejects(executeRedisScriptCommand(async () => {
    attempts++;
    now = 20;
    throw error;
  }, command, { deadlineAt: 20, now: () => now, isReady: () => true }), error);
  assert.equal(attempts, 1);
});

test("abort or retirement between NOSCRIPT and fallback prevents an EVAL", async () => {
  for (const condition of ["aborted", "retired"] as const) {
    const abort = new AbortController();
    let ready = true;
    let attempts = 0;
    const error = noScript();
    await assert.rejects(executeRedisScriptCommand(async () => {
      attempts++;
      if (condition === "aborted") abort.abort();
      else ready = false;
      throw error;
    }, command, { ...readyOptions(), signal: abort.signal, isReady: () => ready }), error);
    assert.equal(attempts, 1, condition);
  }
});

test("the bounded operation keeps one original budget across SHA miss and EVAL", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const first = deferred<number>();
  const second = deferred<number>();
  const fallbackStarted = deferred<void>();
  let attempts = 0;
  const connection = { isReady: true, connect: async () => {}, destroy() { this.isReady = false; } };
  const runtime = new BoundedRedisPublication({ create: () => connection, now: () => now,
    limits: { circuitFailures: 100 } });
  try {
    const pending = runtime.publish(client => executeRedisScriptCommand(async args => {
      attempts++;
      assert.deepEqual(args, attempts === 1 ? shaCommand : command);
      if (attempts === 2) fallbackStarted.resolve();
      return attempts === 1 ? first.promise : second.promise;
    }, command, { deadlineAt: 50, now: () => now, isReady: () => client.isReady }), { budgetMs: 50 });
    now = 15;
    t.mock.timers.tick(15);
    first.reject(noScript());
    await fallbackStarted.promise;
    now = 50;
    t.mock.timers.tick(35);
    assert.deepEqual(await pending, { status: "unknown", reason: "timeout" });
    assert.equal(attempts, 2);
    assert.equal(runtime.snapshot().active, 1, "the original operation owns late EVAL settlement");
    second.resolve(0);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runtime.snapshot().active, 0);
  } finally { first.resolve(0); second.resolve(0); await runtime.dispose(); }
});

test("a delayed NOSCRIPT after the bounded caller timed out cannot replay an effect", async () => {
  const first = deferred<number>();
  let attempts = 0;
  const connection = { isReady: true, connect: async () => {}, destroy() { this.isReady = false; } };
  const runtime = new BoundedRedisPublication({ create: () => connection, limits: { circuitFailures: 100 } });
  try {
    const deadlineAt = performance.now() + 20;
    const result = await runtime.publish(client => executeRedisScriptCommand(async () => {
      attempts++;
      return first.promise;
    }, command, { deadlineAt, isReady: () => client.isReady }), { budgetMs: 20 });
    assert.deepEqual(result, { status: "unknown", reason: "timeout" });
    first.reject(noScript());
    await pause(0);
    assert.equal(attempts, 1);
    assert.equal(runtime.snapshot().active, 0);
  } finally { first.resolve(0); await runtime.dispose(); }
});

test("an aborted bounded caller cannot start EVAL when a late NOSCRIPT arrives", async () => {
  const first = deferred<number>();
  const abort = new AbortController();
  let attempts = 0;
  const connection = { isReady: true, connect: async () => {}, destroy() { this.isReady = false; } };
  const runtime = new BoundedRedisPublication({ create: () => connection });
  try {
    const pending = runtime.publish(client => executeRedisScriptCommand(async () => {
      attempts++;
      return first.promise;
    }, command, { ...readyOptions(), signal: abort.signal, isReady: () => client.isReady }), { signal: abort.signal });
    abort.abort();
    assert.deepEqual(await pending, { status: "unknown", reason: "aborted" });
    first.reject(noScript());
    await pause(0);
    assert.equal(attempts, 1);
  } finally { first.resolve(0); await runtime.dispose(); }
});

test("shutdown retires the original connection before a delayed NOSCRIPT can start EVAL", async () => {
  const first = deferred<number>();
  let attempts = 0;
  const connection = { isReady: true, connect: async () => {}, destroy() { this.isReady = false; } };
  const runtime = new BoundedRedisPublication({ create: () => connection });
  const pending = runtime.publish(client => executeRedisScriptCommand(async () => {
    attempts++;
    return first.promise;
  }, command, { ...readyOptions(), isReady: () => client.isReady }));
  const shutdown = runtime.dispose();
  first.reject(noScript());
  assert.deepEqual(await pending, { status: "unknown", reason: "shutdown" });
  await shutdown;
  assert.equal(attempts, 1);
  assert.equal(runtime.snapshot().active, 0);
});
