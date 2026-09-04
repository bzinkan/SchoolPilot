import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { WebSocketWorkTracker } from "../src/realtime/websocketWork.js";

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
