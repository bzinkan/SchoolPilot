import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  classpilotClassroomStatePushFrame,
  classpilotFabStatePushFrame,
} from "../src/services/classpilotControlStateFrame.js";

const source = readFileSync(new URL("../src/services/classpilotControlStateDelivery.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function syncClasspilotControlStatesToActiveDevices");
assert.ok(start >= 0);
const executable = ts.transpileModule(`${source.slice(start).replace("export async function", "async function")}\nsyncClasspilotControlStatesToActiveDevices;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

type Frame = Record<string, unknown> & {
  type?: string;
  classroomState?: { teachingSessionId?: string | null };
  exactBinding?: { controlRevision: number };
  data?: { activeSessionIds?: string[]; teachingSessionId?: string | null; messagingEnabled?: boolean };
};
function fixture(options: { revoked?: boolean; lateSignIn?: boolean } = {}) {
  const binding = { kind: "student-binding", schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a" };
  const state = { revision: 8, teachingSessionId: options.revoked ? null : "teaching-a", supervisionContextId: null, desiredState: {}, restrictions: {} };
  const local: Frame[] = [], batches: Frame[][] = [], pending: Frame[] = [], cleared: Frame[] = [];
  let failFab = false, held = false;
  const transactionDb = {};
  const context = {
    process: { env: {} }, randomUUID: () => "test-message", classpilotClassroomStatePushFrame, classpilotFabStatePushFrame,
    async invalidateClasspilotLiveViewsForStudents() {},
    async runWithTenantContext(_scope: Frame, action: () => Promise<unknown>) { return action(); },
    async getActiveSessionsForStudents() { return [{ id: "session-a", studentId: "student-a", deviceId: "device-a", lastSeenAt: new Date() }]; },
    async readClasspilotRealtimeStatusBatch() { return new Map(); }, classpilotRealtimeFresh: () => false,
    async withClasspilotStudentControlDeliveryAuthority(target: Frame, prepare: (db: object) => Promise<Frame>, deliver: (_claimed: unknown, prepared: Frame) => unknown) {
      assert.deepEqual(JSON.parse(JSON.stringify(target)), binding);
      held = true;
      try { return { authorized: true, value: deliver(undefined, await prepare(transactionDb)) }; }
      finally { held = false; }
    },
    async lockClasspilotSsoPolicyDeliveryAuthority(_schoolId: string, db: object) { assert.equal(db, transactionDb); },
    async getClasspilotStudentControlState(_schoolId: string, _studentId: string, db: object) { assert.equal(db, transactionDb); return state; },
    async getClasspilotSsoPolicyForSchool() { return { revision: 1, policy: {} }; },
    async retireLegacyTabFocusForStudentLocked(db: object, value: Frame) { assert.equal(db, transactionDb); return value.state; },
    classpilotControlStateHasLateSignInOrigin: () => options.lateSignIn === true,
    async prepareClasspilotFocusCleanupFrame() { return null; },
    isClasspilotCapabilityActive: () => !options.lateSignIn,
    async buildStudentFabState(_schoolId: string, _studentId: string, value: Frame) {
      assert.equal(held, true); assert.equal(value.dbInstance, transactionDb);
      if (failFab) throw new Error("Synthetic transient FAB read failure");
      return { ownershipRevision: 8, lifecycleRevision: 0, teachingSessionId: state.teachingSessionId,
        activeSessionIds: state.teachingSessionId ? [state.teachingSessionId] : [], messagingEnabled: !options.revoked };
    },
    serializeClasspilotStudentControlStateForDelivery: () => ({ classroomState: state, withheld: false }),
    classpilotControlStateRequiresPreciseCapability: () => false,
    sendToStudentBindingLocal(target: Frame, frame: Frame) { assert.equal(held, false); assert.deepEqual(JSON.parse(JSON.stringify(target)), binding); local.push(frame); return true; },
    async publishWSBatch(publications: Frame[]) { assert.equal(held, false); batches.push(publications); return publications.map(() => true); },
    async markClasspilotFabSyncPending(target: Frame) { assert.equal(held, false); pending.push(target); return "stored"; },
    async clearClasspilotFabSyncPending(target: Frame) { assert.equal(held, false); cleared.push(target); },
    reportClasspilotFabSyncMiss() { throw new Error("A build failure must not be diagnosed as a missing socket"); },
    async nudgeClasspilotScreenshotPolicyRefresh() { assert.equal(held, false); },
    console,
  };
  const run: (schoolId: string, studentIds: string[]) => Promise<number> = runInNewContext(executable, context);
  return { run: () => run("school-a", ["student-a"]), local, batches, pending, cleared,
    failBuild(value: boolean) { failFab = value; } };
}

test("a transient FAB build failure omits fabricated disabled controls and retries the exact binding", async () => {
  const f = fixture(); f.failBuild(true);
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.local.map(frame => frame.type), ["classroom-state-sync"]);
  assert.equal(f.local[0]!.classroomState!.teachingSessionId, "teaching-a");
  assert.equal(f.local[0]!.exactBinding!.controlRevision, 8);
  assert.equal(f.pending.length, 1);
  assert.equal(f.cleared.length, 0);
  assert.equal(f.batches[0]!.length, 1);

  f.failBuild(false);
  assert.equal(await f.run(), 1);
  const recovered = f.local.find(frame => frame.type === "fab-state-sync");
  assert.ok(recovered);
  assert.deepEqual(recovered.data!.activeSessionIds, ["teaching-a"]);
  assert.equal(recovered.exactBinding!.controlRevision, 8);
  assert.equal(f.cleared.length, 1);
});

test("an authoritative empty FAB still revokes a departed class immediately", async () => {
  const f = fixture({ revoked: true });
  await f.run();
  assert.deepEqual(f.local.map(frame => frame.type), ["classroom-state-sync", "fab-state-sync"]);
  const fab = f.local[1]!;
  assert.equal(fab.exactBinding!.controlRevision, 8);
  assert.equal(fab.data!.teachingSessionId, null);
  assert.deepEqual(fab.data!.activeSessionIds, []);
  assert.equal(fab.data!.messagingEnabled, false);
  assert.equal(f.pending.length, 0);
});

test("FAB build failure still delivers the authoritative classroom revocation", async () => {
  const f = fixture({ revoked: true }); f.failBuild(true);
  await f.run();
  assert.deepEqual(f.local.map(frame => frame.type), ["classroom-state-sync"]);
  assert.equal(f.local[0]!.classroomState!.teachingSessionId, null);
  assert.equal(f.pending.length, 1);
});

test("deferred-origin capability withholding still hides the whole transition", async () => {
  const f = fixture({ lateSignIn: true });
  await f.run();
  assert.equal(f.local.length, 0);
  assert.equal(f.batches.length, 0);
  assert.equal(f.pending.length, 0);
});
