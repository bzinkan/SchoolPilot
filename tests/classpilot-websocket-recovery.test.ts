import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { ClasspilotClassroomRecoveryCoordinator } from "../src/realtime/classpilotClassroomRecovery.js";
import { classpilotClassroomStatePushFrame } from "../src/services/classpilotControlStateFrame.js";

const source = readFileSync(new URL("../src/realtime/websocket.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const marker = source.indexOf('message.type === "classroom-state-request"');
const start = source.lastIndexOf("        if (", marker);
const end = source.indexOf('\n        if (\n          client.role === "student"', marker + 60);
assert.ok(start > 0 && end > marker);
const executable = ts.transpileModule(`async function recover() { ${source.slice(start, end)} }; recover;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(options: { closeAt?: "policy" | "lock" | "read" | "retire" | "cleanup";
  denied?: boolean; withheld?: boolean; noState?: boolean; commitFailure?: boolean; sqlFailure?: boolean; sendFailure?: boolean } = {}) {
  let checkouts = 0, held = false, rollbacks = 0, sends = 0, epoch = 1;
  const frames: Array<{ type: string; classroomState?: unknown; exactBinding?: { studentSessionId: string } }> = [];
  const failures: unknown[] = [], counters: string[] = [], pending: Promise<unknown>[] = [];
  const client = { role: "student", authenticated: true, schoolId: "school-fixture", studentId: "student-fixture",
    studentSessionId: "session-fixture", deviceId: "device-fixture", acceptedCapabilities: [] };
  const ws = { readyState: 1, send(payload: string, callback: (error?: Error) => void) {
    const frame = JSON.parse(payload); if (frame.type === "classroom-state-sync") assert.equal(held, true);
    sends++; frames.push(frame); callback(options.sendFailure ? new Error("synthetic write failure") : undefined);
  }, close() { ws.readyState = 3; } };
  const closeAt = (stage: typeof options.closeAt) => { if (options.closeAt === stage) ws.close(); };
  const classroomRecovery = new ClasspilotClassroomRecoveryCoordinator({
    identity: () => ({ ...client, generation: epoch }), open: () => ws.readyState === 1, accepting: () => true,
    counter: name => { counters.push(name); }, timing: () => {},
    failure: error => { failures.push(error); }, track: promise => { pending.push(promise); },
  });
  const context = {
    client, ws, classroomRecovery, recoveryAttempt: classroomRecovery.admit(),
    WebSocket: { OPEN: 1 }, message: { type: "classroom-state-request" }, classpilotClassroomStatePushFrame,
    async getClasspilotMonitoringPolicy() { closeAt("policy"); return { policyMode: "full" }; },
    async runWithTenantContext(_scope: unknown, work: () => Promise<unknown>) { checkouts++; return work(); },
    async withClasspilotStudentControlDeliveryAuthority(_binding: unknown, prepare: (db: object) => Promise<unknown>, deliver: (_claimed: unknown, value: unknown) => unknown) {
      held = true;
      try {
        const prepared = await prepare({});
        if (options.denied) return { authorized: false };
        const value = deliver([], prepared);
        if (options.commitFailure) throw new Error("synthetic commit failure");
        return { authorized: true, value };
      } catch (error) { rollbacks++; throw error; }
      finally { held = false; }
    },
    async lockClasspilotSsoPolicyDeliveryAuthority() { closeAt("lock"); },
    async getClasspilotStudentControlState() { closeAt("read"); if (options.sqlFailure) throw new Error("synthetic SQL failure"); return null; },
    async getClasspilotSsoPolicyForSchool() { return { policy: {}, revision: 0 }; },
    async retireLegacyTabFocusForStudentLocked() { closeAt("retire"); return options.noState ? null : { revision: 8 }; },
    serializeClasspilotStudentControlStateForDelivery() { return { classroomState: { revision: 8 }, withheld: !!options.withheld }; },
    isClasspilotCapabilityActive() { return true; },
    async prepareClasspilotFocusCleanupFrame() { closeAt("cleanup"); return null; },
  };
  const recover = runInNewContext(executable, context) as () => Promise<void>;
  return { async run() { await recover(); await Promise.all(pending); }, ws, frames, failures, counters,
    stats: () => ({ checkouts, sends, rollbacks }),
    retry() { epoch++; ws.readyState = 1; context.recoveryAttempt = classroomRecovery.admit(); },
  };
}

test("a queued classroom recovery after peer closure performs no database work or send", async () => {
  const f = fixture(); f.ws.close();
  await f.run();
  assert.deepEqual(f.stats(), { checkouts: 0, sends: 0, rollbacks: 0 });
  assert.equal(f.failures.length, 0);
});

test("the actual request branch cancels after each awaited preparation stage", async () => {
  for (const closeAt of ["policy", "lock", "read", "retire", "cleanup"] as const) {
    const f = fixture({ closeAt, withheld: closeAt === "cleanup" });
    await f.run();
    assert.equal(f.stats().sends, 0, closeAt);
    assert.equal(f.stats().rollbacks, closeAt === "policy" ? 0 : 1, closeAt);
    assert.equal(f.failures.length, 0, closeAt);
    assert.ok(f.counters.includes("classroomRecoveryCancelledClosed"), closeAt);
  }
});

test("the actual branch sends an explicit-null snapshot under authority and counts transport only", async () => {
  const f = fixture({ noState: true }); await f.run();
  assert.equal(f.frames[0]?.type, "classroom-state-sync");
  assert.equal(f.frames[0]?.exactBinding?.studentSessionId, "session-fixture");
  assert.equal(f.frames[0]?.classroomState, null);
  assert.equal(f.counters.includes("classroomRecoveryTransmitted"), true);
  assert.equal(f.failures.length, 0);
});

test("real branch SQL, commit and callback failures remain observable", async () => {
  for (const options of [{ sqlFailure: true, closeAt: "read" as const }, { commitFailure: true }, { sendFailure: true }]) {
    const f = fixture(options); await f.run();
    assert.equal(f.failures.length, 1);
    assert.equal(f.counters.includes("classroomRecoveryTransmitted"), false);
  }
});

test("authority denial and capability withholding are distinct recovery outcomes", async () => {
  const denied = fixture({ denied: true }); await denied.run();
  assert.equal(denied.frames[0]?.type, "auth-error");
  assert.ok(denied.counters.includes("classroomRecoveryDenied"));
  const withheld = fixture({ withheld: true }); await withheld.run();
  assert.equal(withheld.frames.length, 0);
  assert.ok(withheld.counters.includes("classroomRecoveryWithheld"));
  assert.equal(withheld.counters.includes("classroomRecoveryTransmitted"), false);
});

test("real frame admission coalesces recovery bursts before queueing and preserves ACK order", async () => {
  const queueStart = source.indexOf('    ws.on("message", (data) => {', marker);
  const queueEnd = source.indexOf('    ws.on("close", () => {', queueStart);
  const queueExecutable = ts.transpileModule(`let pendingFrames = 0; let frameQueue = Promise.resolve();
    ${source.slice(queueStart, queueEnd)}
    () => frameQueue;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let listener!: (data: Buffer) => void, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [], counters: string[] = [];
  const identity = { schoolId: "school-fixture", studentId: "student-fixture", studentSessionId: "session-fixture",
    deviceId: "device-fixture", generation: 1, acceptedCapabilities: [] };
  const classroomRecovery = new ClasspilotClassroomRecoveryCoordinator({
    identity: () => identity, open: () => true, accepting: () => true,
    counter: name => { counters.push(name); }, timing: () => {}, failure: error => { throw error; }, track: () => {},
  });
  const drain = runInNewContext(queueExecutable, {
    ws: { on(_event: string, callback: typeof listener) { listener = callback; } },
    classroomRecovery, webSocketWork: { canStart: () => true, track: (work: Promise<unknown>) => work },
    consumeClasspilotWsFrame: () => true, frameBucket: {}, CLASSPILOT_WS_MAX_PENDING_FRAMES: 64,
    async handleMessage(data: Buffer, attempt: ReturnType<typeof classroomRecovery.admit>) {
      const type = JSON.parse(data.toString()).type;
      if (attempt) await classroomRecovery.run(attempt, async () => { order.push(type); await blocked; return "withheld"; });
      else order.push(type);
    },
  }) as () => Promise<void>;
  const send = (type: string) => listener(Buffer.from(JSON.stringify({ type })));
  send("classroom-state-request"); send("command-ack"); send("classroom-state-request"); send("classroom-state-request");
  await Promise.resolve();
  assert.deepEqual(order, ["classroom-state-request"]);
  assert.equal(counters.filter(name => name === "classroomRecoveryCoalesced").length, 2);
  release(); await drain();
  assert.deepEqual(order, ["classroom-state-request", "command-ack"]);
  send("classroom-state-request"); await drain();
  assert.deepEqual(order, ["classroom-state-request", "command-ack", "classroom-state-request"]);
});
