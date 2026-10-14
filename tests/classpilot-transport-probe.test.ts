import assert from "node:assert/strict";
import { on, once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import pg from "pg";
import { WebSocket } from "ws";

process.env.REDIS_URL = "";
// This socket-only test imports the application pool but must never connect.
// Keep it independent of a developer .env and the DB-enabled CI lanes.
process.env.DATABASE_URL = "postgresql://unit:unit@127.0.0.1:1/schoolpilot_unit";

test("authenticated transport probes echo only bounded nonces without DB, presence or authority renewal", { timeout: 10_000 }, async t => {
  const transport = await import("../src/realtime/websocket.js");
  const sockets = await import("../src/realtime/ws-broadcast.js");
  let queries = 0;
  const mocked = t.mock.method(pg.Client.prototype, "query", () => {
    queries++;
    throw new Error("Transport probes must not acquire or query a database");
  });
  const http = createServer();
  const wss = transport.setupWebSocket(http);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const connected = once(wss, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const received: Array<Record<string, unknown>> = [];
  client.on("message", data => received.push(JSON.parse(data.toString())));
  await once(client, "open");
  const [socket] = await connected; assert.ok(socket instanceof WebSocket);
  const binding = { schoolId: "synthetic-school", studentId: "synthetic-student", studentSessionId: "synthetic-session", deviceId: "synthetic-device" };
  const sendAndFlush = async (frames: readonly Record<string, unknown>[]) => {
    const arrivals = on(socket, "message", { signal: t.signal });
    try {
      for (const frame of frames) client.send(JSON.stringify(frame));
      let count = 0;
      for await (const _ of arrivals) if (++count === frames.length) break;
      await transport.drainWebSocketWork();
      // Observe native consumption and queue completion before mutating this
      // fixture's auth state. A control-frame round trip also flushes any prior
      // server reply to the client before the negative assertion is checked.
      const flushed = once(client, "pong", { signal: t.signal });
      client.ping("probe_fixture_flush");
      const [payload] = await flushed;
      assert.equal(payload.toString(), "probe_fixture_flush");
    } finally { await arrivals.return?.(); }
  };
  try {
    await sendAndFlush([{ type: "transport-probe", nonce: "anonymous_1" }]);
    assert.equal(received.length, 0, "an unauthenticated socket cannot obtain the negotiated echo");
    assert.equal(await transport.deliverClasspilotStudentBindingRedisMessage({ kind: "student-binding", ...binding }, { type: "synthetic" }), false);
    const state = sockets.authenticateWsClient(socket, { role: "student", ...binding, acceptedCapabilities: [] });
    assert.ok(state);
    state.passiveAuthorizationExpiresAt = 123;
    state.passiveAuthorizationGeneration = 7;
    const reply = once(client, "message");
    client.send(JSON.stringify({ type: "transport-probe", nonce: "probe_0001" }));
    const [data] = await reply;
    assert.deepEqual(JSON.parse(data.toString()), { type: "transport-probe-reply", nonce: "probe_0001" });
    assert.equal(state.passiveAuthorizationExpiresAt, 123);
    assert.equal(state.passiveAuthorizationGeneration, 7);
    assert.equal(sockets.hasStudentBindingSocketLocal(binding, { type: "synthetic" }), true);
    assert.equal(sockets.hasStudentBindingSocketLocal({ ...binding, studentSessionId: "replacement-session" }, { type: "synthetic" }), false);
    assert.equal(sockets.hasStudentBindingSocketLocal(binding, { type: "synthetic" }, { requiredCapability: "not-supported" }), false);
    assert.equal(await transport.deliverClasspilotStudentBindingRedisMessage({ kind: "student-binding", ...binding, studentSessionId: "replacement-session" }, { type: "synthetic" }), false);
    const count = received.length;
    await sendAndFlush(["short", "x".repeat(65), "invalid nonce", "éééééééé", null, { value: "object_1" }]
      .map(nonce => ({ type: "transport-probe", nonce })));
    assert.equal(received.length, count);
    assert.equal(queries, 0);
  } finally {
    mocked.mock.restore();
    client.terminate(); socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    transport.stopWebSocketWork(); await transport.drainWebSocketWork();
    await (await import("../src/realtime/ws-redis.js")).disposeWSRedis();
    await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
    const pools = await import("../src/db.js");
    await Promise.all([pools.pool.end(), pools.sessionPool.end()]);
  }
});
