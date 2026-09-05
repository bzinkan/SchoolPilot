import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { WebSocket, WebSocketServer } from "ws";
import { Server as SocketIOServer } from "socket.io";
import { WebSocketWorkTracker } from "../src/realtime/websocketWork.js";
import { createUpgradedTransportShutdown } from "../src/realtime/websocketShutdown.js";
import { drainService } from "../src/services/serviceShutdown.js";

type Next = (error?: Error) => void;
type Timer = { callback: () => void; unref(): void };
class TestSocket {
  connected = true;
  data = { userId: "user-fixture", authVersion: 1, isSuperAdmin: true };
  handshake = { auth: { token: "signed-fixture" } };
  rooms = new Set<string>();
  events = new Map<string, (...args: unknown[]) => unknown>();
  packet?: (event: unknown[], next: Next) => unknown;
  use(handler: NonNullable<TestSocket["packet"]>) { this.packet = handler; }
  on(event: string, handler: (...args: unknown[]) => unknown) { this.events.set(event, handler); }
  disconnect() { this.connected = false; this.events.get("disconnect")?.(); }
  emit() {}
  join(room: string) { this.rooms.add(room); }
  leave(room: string) { this.rooms.delete(room); }
}

function socketHarness() {
  let namespace: (socket: TestSocket, next: Next) => unknown = () => {};
  let connect: (socket: TestSocket) => void = () => {};
  let read: () => Promise<unknown> = async () => ({ authVersion: 1, isSuperAdmin: true });
  let tenantWork: (work: () => Promise<unknown>) => Promise<unknown> = async (work) => work();
  let reads = 0;
  const timers = new Set<Timer>();
  class TestServer {
    sockets = { sockets: new Map() };
    use(handler: typeof namespace) { namespace = handler; }
    on(_event: string, handler: typeof connect) { connect = handler; }
    to() { return { emit() {} }; }
  }
  const dependencies: Record<string, unknown> = {
    "socket.io": { Server: TestServer },
    "../services/jwt.js": {
      verifyUserToken: () => ({ userId: "user-fixture", authVersion: 1 }),
      credentialVersionMatches: () => true,
    },
    "../services/storage.js": { getUserById: () => { reads++; return read(); } },
    "../services/gopilotAccess.js": {
      hasAnyActiveGoPilotStaffMembership: async () => true,
      hasActiveGoPilotLicense: async () => true,
    },
    "../middleware/tenantContext.js": {
      runWithTenantContext: (_scope: unknown, work: () => Promise<unknown>) => tenantWork(work),
    },
    "./socketio-redis.js": { subscribeSocketIoRedis: async () => {}, publishSocketIoRedis: async () => true },
    "./cacheInvalidation.js": { registerCacheInvalidationHandler() {} },
    "./websocketWork.js": { WebSocketWorkTracker },
  };
  const exports: Record<string, unknown> = {};
  const source = readFileSync(new URL("../src/realtime/socketio.ts", import.meta.url), "utf8");
  const executable = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(executable, {
    exports,
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
    process: { env: {} },
    console: { log() {} },
    setInterval: (callback: () => void) => {
      const timer = { callback, unref() {} }; timers.add(timer); return timer;
    },
    clearInterval: (timer: Timer) => { timers.delete(timer); },
  });
  (exports.setupSocketIO as (server: object) => void)({});
  return {
    namespace: (socket: TestSocket, next: Next) => namespace(socket, next),
    connect: (socket: TestSocket) => connect(socket),
    stop: exports.stopSocketIoWork as () => void,
    drain: exports.drainSocketIoWork as () => Promise<void>,
    setRead: (replacement: typeof read) => { read = replacement; },
    setTenantWork: (replacement: typeof tenantWork) => { tenantWork = replacement; },
    readCount: () => reads,
    timers,
  };
}

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("a non-acknowledging WebSocket cannot consume the database drain budget", { timeout: 5_000 }, async () => {
  const server = createServer();
  const closeUpgrades = createUpgradedTransportShutdown(server);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const accepted = once(wss, "connection");
  const peer = connect(address.port, "127.0.0.1");
  peer.on("data", () => {}); // Consume Close without sending the protocol ACK.
  await once(peer, "connect");
  peer.write("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + randomBytes(16).toString("base64") + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
  const [socket] = await accepted as [WebSocket];
  const tracker = new WebSocketWorkTracker();
  let releaseHandler!: () => void;
  let releaseCloseCleanup!: () => void;
  const handler = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const closeCleanup = new Promise<void>((resolve) => { releaseCloseCleanup = resolve; });
  tracker.track(handler);
  socket.on("close", () => { tracker.track(closeCleanup); });
  let transportClosed!: () => void;
  const transport = new Promise<void>((resolve) => { transportClosed = resolve; });
  const events: string[] = [];
  let forced = 0;
  let shutdown: Promise<unknown> | undefined;
  try {
    shutdown = drainService({
      timeoutMs: 2_000, cleanupReserveMs: 200,
      stopIntake() { tracker.stop(); },
      async drainProducers() {
        await closeUpgrades(async () => {
          socket.close(1011, "Server shutting down");
          await Promise.all([
            new Promise<void>((resolve) => wss.close(() => resolve())),
            new Promise<void>((resolve) => server.close(() => resolve())),
          ]);
        }, { gracePeriodMs: 25, onForcedClose(count) { forced = count; } });
        transportClosed();
        await tracker.drain();
      },
      sealBackground() { events.push("seal"); },
      async drainBackground() { events.push("background"); },
      cancelBackground() { assert.fail("transport termination must not cancel admitted database work"); },
      async disposeMonitor() { events.push("monitor"); },
      stopMetrics() {},
      pools: [{ name: "main", pool: { totalCount: 0, idleCount: 0, waitingCount: 0, async end() { events.push("pool"); } } }],
      snapshot: () => ({}), report() {},
    });
    await transport;
    assert.equal(forced, 1);
    assert.equal(socket.readyState, WebSocket.CLOSED);
    assert.deepEqual(events, [], "transport closure is not producer completion");
    releaseHandler();
    await tick();
    assert.deepEqual(events, [], "close-triggered work must also finish before background and pool drain");
    releaseCloseCleanup();
    assert.deepEqual(await shutdown, { completed: true, timedOut: false });
    assert.deepEqual(events, ["seal", "background", "monitor", "pool"]);
  } finally {
    releaseHandler(); releaseCloseCleanup();
    socket.terminate(); peer.destroy();
    await shutdown;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("responsive WebSockets complete the existing close handshake without forced termination", async () => {
  const server = createServer();
  const closeUpgrades = createUpgradedTransportShutdown(server);
  const wss = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(peer, "open");
  const closed = once(peer, "close");
  let forced = 0;
  try {
    await closeUpgrades(async () => {
      for (const socket of wss.clients) socket.close(1011, "Server shutting down");
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    }, { onForcedClose(count) { forced = count; } });
    const [code, reason] = await closed;
    assert.equal(code, 1011);
    assert.equal(reason.toString(), "Server shutting down");
    assert.equal(forced, 0);
  } finally {
    peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an unauthenticated Engine.IO WebSocket also has a bounded close handshake", { timeout: 5_000 }, async () => {
  const server = createServer();
  const closeUpgrades = createUpgradedTransportShutdown(server);
  const io = new SocketIOServer(server, { path: "/gopilot-socket/" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const accepted = once(io.engine, "connection");
  const peer = connect(address.port, "127.0.0.1");
  peer.on("data", () => {});
  await once(peer, "connect");
  peer.write("GET /gopilot-socket/?EIO=4&transport=websocket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + randomBytes(16).toString("base64") + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
  await accepted;
  let forced = 0;
  try {
    await closeUpgrades(() => new Promise<void>((resolve) => {
      void io.close(() => resolve());
    }), { gracePeriodMs: 25, onForcedClose(count) { forced = count; } });
    assert.equal(forced, 1);
    assert.equal(io.engine.clientsCount, 0);
  } finally {
    peer.destroy();
    await io.close();
  }
});

for (const producer of ["namespace", "initial_credentials", "packet", "join", "timer"] as const) {
  test(`Socket.IO shutdown drains admitted ${producer} work and fences later database work`, async () => {
    const harness = socketHarness();
    const socket = new TestSocket();
    if (producer !== "namespace" && producer !== "initial_credentials") {
      harness.connect(socket);
      await tick();
      assert.equal(harness.timers.size, 1);
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (producer === "join") {
      harness.setTenantWork(async (work) => { await gate; return work(); });
      socket.events.get("join:school")?.({ schoolId: "school-fixture" });
    } else {
      harness.setRead(async () => { await gate; return { authVersion: 1, isSuperAdmin: true }; });
      if (producer === "namespace") harness.namespace(socket, () => {});
      else if (producer === "initial_credentials") harness.connect(socket);
      else if (producer === "packet") socket.packet?.([], () => {});
      else [...harness.timers][0]!.callback();
    }
    await tick();
    harness.stop();
    let drained = false;
    const drain = harness.drain().then(() => { drained = true; });
    await tick();
    assert.equal(drained, false, "closing transport admission must retain the in-flight producer");
    const readsAtStop = harness.readCount();
    let rejected = false;
    harness.namespace(new TestSocket(), (error) => { rejected = !!error; });
    socket.packet?.([], () => {});
    socket.events.get("join:school")?.({ schoolId: "school-fixture" });
    assert.equal(rejected, true);
    assert.equal(harness.readCount(), readsAtStop);
    assert.equal(harness.timers.size, 0);
    release();
    await drain;
    await tick();
    assert.equal(drained, true);
    assert.equal(harness.timers.size, 0, "completing initial auth must not restart a timer after shutdown");
  });
}

test("replacement summary delivery exits producer ALS and stays tracked until its tenant work settles", async () => {
  const source = readFileSync(new URL("../src/services/classpilotScheduledStart.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("if (finalization.result.deliveryCount > 0) {");
  const end = source.indexOf("\n  }\n  for (const conflictId", start);
  assert.ok(start > 0 && end > start);
  const execute = ts.transpileModule(`(() => { ${source.slice(start, end)} })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const scope = new AsyncLocalStorage<boolean>();
  let tracked: Promise<unknown> | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let observedScope: boolean | undefined = true;
  const run = runInNewContext(execute, {
    finalization: { result: { deliveryCount: 1, session: { id: "session-fixture" } } },
    options: { group: { schoolId: "school-fixture" } },
    runWithoutTenantContext: (work: () => unknown) => scope.exit(work),
    runWithTenantContext: async (_scope: unknown, work: () => Promise<unknown>) => {
      observedScope = scope.getStore();
      await gate;
      return work();
    },
    dispatchDueClasspilotSessionSummaries: async () => {},
    trackClasspilotLifecycleTransport: (work: Promise<unknown>) => { tracked = work; },
  }) as () => void;
  scope.run(true, run);
  assert.equal(observedScope, undefined);
  assert.ok(tracked);
  let completed = false;
  void tracked.then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  release();
  await tracked;
  assert.equal(completed, true);
});
