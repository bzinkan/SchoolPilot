import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";

test("missing Redis configuration retains an explicit reason and the compatibility undefined result", () => {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const redis = await import('./src/realtime/ws-redis.ts');
    assert.deepEqual(await redis.realtimeRedisCommandOutcome(['GETDEL','synthetic']),
      {status:'not_admitted',reason:'not_configured'});
    assert.equal(await redis.realtimeRedisCommand(['GETDEL','synthetic']), undefined);
    await redis.disposeWSRedis();
  `], { env: { ...process.env, NODE_ENV: "test", REDIS_URL: "" }, stdio: "pipe", timeout: 10_000 });
});

test("the actual typed coordination adapter preserves replies and never repeats a late destructive take", async () => {
  const sockets = new Set<net.Socket>();
  const hints = new Map<string, string>();
  let hold = false;
  let takes = 0;
  const held: Array<() => void> = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const count = Number(buffer.subarray(1, end));
        let cursor = end + 2;
        const args: string[] = [];
        for (let index = 0; index < count; index++) {
          const lengthEnd = buffer.indexOf("\r\n", cursor);
          if (lengthEnd < 0) return;
          const length = Number(buffer.subarray(cursor + 1, lengthEnd));
          cursor = lengthEnd + 2;
          if (buffer.length < cursor + length + 2) return;
          args.push(buffer.subarray(cursor, cursor + length).toString());
          cursor += length + 2;
        }
        buffer = buffer.subarray(cursor);
        let reply = "+OK\r\n";
        if (args[0] === "SET") hints.set(args[1]!, args[2]!);
        if (args[0] === "GETDEL") {
          takes++;
          const value = hints.get(args[1]!);
          hints.delete(args[1]!);
          reply = value === undefined ? "$-1\r\n" : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
        }
        const send = () => { if (!socket.destroyed) socket.write(reply); };
        if (args[0] === "GETDEL" && hold) held.push(send); else send();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const originalUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = `redis://127.0.0.1:${address.port}`;
  const redis = await import("../src/realtime/ws-redis.js");
  const release = () => { hold = false; held.splice(0).forEach(send => send()); };
  try {
    assert.deepEqual(await redis.realtimeRedisCommandOutcome(["GETDEL", "synthetic:absent"]), { status: "accepted", value: null });
    assert.equal(await redis.realtimeRedisCommand(["SET", "synthetic:empty", ""]), "OK");
    assert.equal(await redis.realtimeRedisCommand(["GETDEL", "synthetic:empty"]), "");
    await redis.realtimeRedisCommand(["SET", "synthetic:late", "hint"]);
    hold = true;
    const before = takes;
    const result = await redis.realtimeRedisCommandOutcome(["GETDEL", "synthetic:late"]);
    assert.deepEqual(result, { status: "unknown", reason: "timeout" });
    assert.equal(takes, before + 1);
    release();
    await pause(20);
    assert.deepEqual(result, { status: "unknown", reason: "timeout" }, "late transport completion does not reclassify the caller");
    assert.equal(takes, before + 1, "the uncertain GETDEL was not retried");
    assert.deepEqual(await redis.realtimeRedisCommandOutcome(["GETDEL", "synthetic:late"]), { status: "accepted", value: null });
    const controller = new AbortController();
    controller.abort();
    const priorAbortTakes = takes;
    assert.deepEqual(await redis.realtimeRedisCommandOutcome(["GETDEL", "synthetic:aborted"], { signal: controller.signal }),
      { status: "not_admitted", reason: "aborted" });
    assert.equal(takes, priorAbortTakes);
    await redis.realtimeRedisCommand(["SET", "synthetic:admitted-abort", "hint"]);
    hold = true;
    const admittedController = new AbortController();
    const admitted = redis.realtimeRedisCommandOutcome(["GETDEL", "synthetic:admitted-abort"], { signal: admittedController.signal });
    for (let attempt = 0; attempt < 50 && takes === priorAbortTakes; attempt++) await pause(2);
    assert.equal(takes, priorAbortTakes + 1, "the abort follows an actual destructive take");
    admittedController.abort();
    assert.deepEqual(await admitted, { status: "unknown", reason: "aborted" });
    release();
    await pause(20);
    assert.equal(takes, priorAbortTakes + 1, "the late aborted take was not repeated");
  } finally {
    release();
    await redis.disposeWSRedis();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = originalUrl;
  }
});
