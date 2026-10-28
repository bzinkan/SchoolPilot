import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { classpilotControlAuthorityRevisionForDelivery } from "../src/services/classpilotClassroomState.js";

const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const start = source.indexOf("    const teacherReplyCheckKey = `${studentSessionId}:${deviceId}`;");
const end = source.indexOf("    if (!finalDelivery.authorized)", start);
assert.ok(start >= 0 && end > start);
const executable = ts.transpileModule(`async function deliver() { ${source.slice(start, end)}\n return finalDelivery; }\ndeliver;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type Frame = Record<string, unknown>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type WithheldReason = Parameters<typeof classpilotControlAuthorityRevisionForDelivery>[0]["delivery"]["withheldReason"];
function fixture(options: { messages?: boolean; publish?: () => Promise<boolean>; recover?: boolean;
  requestFab?: boolean; withheldReason?: WithheldReason; supervision?: boolean; cleanup?: boolean } = {}) {
  const order: string[] = [], local: Array<{ target: Frame; frame: Frame }> = [], remote: Array<{ target: Frame; frame: Frame }> = [];
  let held = false, leases = 0, authorities = 0, response: Frame | undefined;
  const released = deferred();
  const transactionDb = { fixture: "private-recovery-transaction" };
  const scope = options.supervision
    ? { teachingSessionId: null, supervisionContextId: "context-a" }
    : { teachingSessionId: "teaching-a", supervisionContextId: null };
  const storedControlState = { ...scope, revision: 46, desiredState: { restrictions: { focus: { active: true } } } };
  const retiredControlState = { ...scope, revision: 47, desiredState: { restrictions: {} } };
  const lifecycle = { threadId: "thread-a", threadGeneration: 2, schoolEpoch: 3, activityEpoch: 4 };
  const rows = options.messages ? [{ message: { id: "message-a", content: "Synthetic private reply", supervisionContextId: "context-a" } }] : [];
  const context = {
    schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a",
    shouldCheckPendingMessages: false, commitPendingInbox() {},
    deferredForeground: undefined, now: 1_000_000, pendingMessageRecoveryHeartbeat: options.recover !== false,
    teacherReplyLastCheck: new Map([["session-a:device-a", 1_000_000]]), MAX_TEACHER_REPLY_CHECKS: 100,
    setBoundedMap(map: Map<string, number>, key: string, value: number) { map.set(key, value); },
    async runWithTenantContext(scope: Frame, action: () => Promise<unknown>) {
      assert.equal(scope.operation, "heartbeat_final_delivery");
      leases++; held = true; order.push("lease");
      try { return await action(); }
      finally { held = false; order.push("released"); released.resolve(); }
    },
    async withClasspilotHeartbeatDeliveryAuthority(binding: Frame, prepare: (db: object) => Promise<Frame>,
      deliver: (claimed: typeof rows, prepared: Frame) => unknown,
      recover: ((claimed: typeof rows, prepared: Frame) => unknown) | undefined) {
      authorities++;
      assert.equal(binding.freezeSsoPolicy, true);
      const prepared = await prepare(transactionDb); order.push("prepared");
      assert.equal(prepared.privateReplyControlRevision, retiredControlState.revision);
      if (recover && rows.length) recover(rows, prepared);
      return { authorized: true, value: deliver(rows, prepared), foreground: { status: "fallback" } };
    },
    async getClasspilotStudentControlDeliveryContext(schoolId: string, studentId: string, database: object) {
      assert.equal(held, true); assert.equal(database, transactionDb);
      assert.equal(schoolId, "school-a"); assert.equal(studentId, "student-a"); order.push("control-read");
      return { controlState: storedControlState, ssoPolicy: { revision: 6, policy: {} } };
    },
    async retireLegacyTabFocusForStudentLocked(database: object, value: Frame) {
      assert.equal(held, true); assert.equal(database, transactionDb);
      assert.equal(value.schoolId, "school-a"); assert.equal(value.studentId, "student-a");
      assert.equal(value.state, storedControlState); assert.equal(value.reason, "reconnect");
      order.push("focus-retired"); return retiredControlState;
    },
    isClasspilotCapabilityActive() { return true; },
    serializeClasspilotStudentControlStateForDelivery(value: Frame) {
      assert.equal(held, true); assert.equal(value.state, retiredControlState);
      order.push("serialize"); return { classroomState: null, withheld: true, withheldReason: options.withheldReason };
    },
    classpilotControlAuthorityRevisionForDelivery,
    async prepareClasspilotFocusCleanupFrame(database: object, state: object) {
      assert.equal(held, true); assert.equal(database, transactionDb); assert.equal(state, retiredControlState);
      order.push("cleanup"); return options.cleanup === false ? null : { exactBinding: { controlRevision: 99 } };
    },
    async buildStudentFabState(_schoolId: string, _studentId: string, value: Frame) {
      assert.equal(held, true); assert.equal(value.dbInstance, transactionDb);
      return { ...scope, ownershipRevision: 47, activeSessionIds: options.supervision ? [] : ["teaching-a"],
        activeContexts: [options.supervision ? { supervisionContextId: "context-a" } : { teachingSessionId: "teaching-a" }] };
    },
    trackingWindowScreenshotLeaseNegotiated: false, screenshotPolicy: { enabled: false },
    protocol: { acceptedCapabilities: ["privateChatLifecycleV1"] }, req: { body: { requestFabState: options.requestFab === true } }, fabSyncPending: false,
    classpilotControlStateExactBinding(value: Frame) { return value; },
    school: { planStatus: "active" }, pendingMessages: [],
    recordRuntimePerformanceCounter() {}, recordHeartbeatHotPathCounter() {},
    res: { json(body: Frame) { assert.equal(held, true); order.push("http"); response = body; return { sent: true }; } },
    privateChatMessageLifecycle() { return lifecycle; },
    classpilotCommandAuthorityEnvelope(authority: Frame) { return authority; },
    sendToStudentBindingLocal(target: Frame, frame: Frame) { assert.equal(held, true); order.push("local"); local.push({ target, frame }); },
    publishWS(target: Frame, frame: Frame) { assert.equal(held, true); order.push("publish"); remote.push({ target, frame }); return options.publish?.() ?? Promise.resolve(true); },
    Promise,
  };
  const run: () => Promise<unknown> = runInNewContext(executable, context);
  return { run, order, local, remote, released: released.promise, snapshot: () => ({ held, leases, authorities, response }), lifecycle };
}

test("actual heartbeat final-delivery route uses one lease with empty outbox and preserves mandatory preparation", async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.snapshot().leases, 1);
  assert.equal(f.snapshot().authorities, 1);
  assert.deepEqual(f.order, ["lease", "control-read", "focus-retired", "serialize", "cleanup", "prepared", "http", "released"]);
  assert.equal(f.snapshot().response?.ok, true);
});

test("actual heartbeat private frames keep exact binding and raw control revision while Redis settles after release", async () => {
  const remote = deferred();
  const f = fixture({ messages: true, publish: () => remote.promise.then(() => true) });
  let settled = false;
  const delivery = f.run().then(value => { settled = true; return value; });
  try {
    await f.released;
    assert.equal(f.snapshot().held, false);
    assert.equal(f.snapshot().response?.ok, true);
    assert.equal(settled, false, "only network settlement remains after the lease ends");
    assert.deepEqual(f.order, ["lease", "control-read", "focus-retired", "serialize", "cleanup", "prepared", "local", "publish", "http", "released"]);
    assert.deepEqual(JSON.parse(JSON.stringify(f.local[0]?.target)), {
      kind: "student-binding", schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a",
    });
    assert.equal(f.local[0]?.frame.studentControlRevision, 47, "use the retired row revision, never the old row46 or serialized/cleanup revision99");
    assert.equal(f.local[0]?.frame.chatMessageId, "message-a");
    assert.equal(f.local[0]?.frame.studentSessionId, "session-a");
    assert.deepEqual(f.local[0]?.frame.privateChatLifecycle, f.lifecycle);
    assert.equal(f.remote[0]?.frame, f.local[0]?.frame);
  } finally { remote.resolve(); await delivery; }
});

test("actual heartbeat immediately handles a Redis rejection without losing valid HTTP or retained authority cleanup", async () => {
  const f = fixture({ messages: true, publish: () => Promise.reject(new Error("Synthetic Redis failure")) });
  await f.run();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.snapshot().response?.ok, true);
  assert.equal(f.snapshot().held, false);
  assert.equal(f.snapshot().leases, 1);
});

test("actual heartbeat keeps the thirty-second recovery cooldown without skipping the final mandatory lease", async () => {
  const f = fixture({ recover: false, messages: true });
  await f.run();
  assert.equal(f.snapshot().leases, 1);
  assert.equal(f.snapshot().authorities, 1);
  assert.equal(f.local.length, 0);
  assert.equal(f.remote.length, 0);
  assert.equal(f.snapshot().response?.ok, true);
});

test("heartbeat recovery preserves classroom ownership when only a restriction snapshot is withheld", async () => {
  for (const withheldReason of ["restriction_auth_update_required", "precise_restriction_capability_required", "focus_tab_capability_required"] as const) {
    for (const supervision of [false, true]) {
      const f = fixture({ requestFab: true, withheldReason, supervision, cleanup: false });
      await f.run();
      const response = f.snapshot().response!;
      const fab = response.fab as Frame;
      const binding = response.exactBinding as Frame;
      assert.equal(response.classroomState, null, "unsupported restrictions remain withheld");
      assert.equal(fab.ownershipRevision, 47, `${withheldReason} retains canonical FAB ownership`);
      assert.equal(binding.controlRevision, 47, "the exact binding and FAB carry the same current revision");
      assert.deepEqual(JSON.parse(JSON.stringify(fab.activeContexts)), [supervision
        ? { supervisionContextId: "context-a" } : { teachingSessionId: "teaching-a" }]);
    }
  }
});

test("heartbeat recovery keeps deferred-origin and unknown withheld revisions hidden", async () => {
  for (const withheldReason of ["late_sign_in_capability_required", undefined] as const) {
    const f = fixture({ requestFab: true, withheldReason, cleanup: false });
    await f.run();
    const response = f.snapshot().response!;
    assert.equal(response.classroomState, null);
    assert.equal((response.fab as Frame).ownershipRevision, 0);
    assert.equal((response.exactBinding as Frame).controlRevision, 0);
  }
});
