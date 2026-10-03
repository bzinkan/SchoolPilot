import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const start = source.indexOf("    // --- Deliver any missed messages");
const end = source.indexOf("\n  } catch (err)", start);
assert.ok(start > 0 && end > start);
const executable = ts.transpileModule(`async function heartbeat(){${source.slice(start, end)}};heartbeat;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
type Fields = Record<string, unknown>;
type State = { studentId: string; messageIds: Set<string>; hasUnacknowledgedCommandMessages: boolean; lastHeartbeatAt: number; lastInboxCheckAt: number };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options: { rows?: Fields[]; checked?: boolean; failCommit?: boolean; denied?: boolean; finish?: boolean; alreadyClosed?: boolean; existing?: State } = {}) {
  const deliveredMessages = new Map<string, State>(options.existing ? [["device", options.existing]] : []);
  const deviceLastHeartbeat = new Map([["device", { studentId: "student", studentSessionId: "session" }]]);
  const response = Object.assign(new EventEmitter(), { body: {} as Fields, destroyed: options.alreadyClosed === true, writableFinished: false, status() { return response; }, json(body: Fields) { response.body = body; if (options.finish !== false) response.emit("finish"); return body; } });
  const release = deferred(), delivered = deferred(); let inboxRequest: Fields | undefined;
  const context = {
    Map, Set, Promise, Date, deliveredMessages, deviceLastHeartbeat, deviceId: "device", schoolId: "school", studentId: "student", studentSessionId: "session", now: 1000,
    pendingMessageRecoveryHeartbeat: false, PENDING_MESSAGE_PERIODIC_CHECK_MS: 300_000, MAX_DELIVERED_MESSAGE_DEVICES: 100, DELIVERED_MESSAGE_CACHE_MAX_IDS: 500,
    teacherReplyLastCheck: new Map([["session:device", 1000]]), MAX_TEACHER_REPLY_CHECKS: 100,
    setBoundedMap(map: Map<string, unknown>, key: string, value: unknown) { map.set(key, value); },
    async runWithTenantContext(_scope: Fields, work: () => Promise<unknown>) { const result = await work(); delivered.resolve(); await release.promise; if (options.failCommit) throw new Error("COMMIT failed"); return result; },
    async withClasspilotHeartbeatDeliveryAuthority(_binding: Fields, prepare: (db: object, read: () => Promise<undefined>) => Promise<Fields>, deliver: (rows: never[], prepared: Fields, inbox: Fields) => unknown, _recovery: unknown, _foreground: unknown, request: Fields | undefined) {
      inboxRequest = request; const prepared = await prepare({}, async () => undefined);
      if (options.denied) return { authorized: false, foreground: { status: "suppressed" } };
      return { authorized: true, value: deliver([], prepared, request && options.checked !== false ? { checked: true, messages: options.rows ?? [] } : { checked: false }), foreground: { status: "fallback" } };
    },
    async getClasspilotStudentControlDeliveryContext() { return { controlState: null, ssoPolicy: {} }; },
    trackingWindowScreenshotLeaseNegotiated: false, screenshotPolicy: {}, fabSyncPending: false, protocol: {}, req: { body: {} },
    deferredForeground: undefined, school: { planStatus: "active" }, res: response,
    recordRuntimePerformanceCounter() {}, recordHeartbeatHotPathCounter() {},
    classpilotControlStateExactBinding(value: unknown) { return value; },
  };
  const run: () => Promise<unknown> = runInNewContext(executable, context);
  return { run, release: release.resolve, ready: delivered.promise, deliveredMessages, deviceLastHeartbeat, response, request: () => inboxRequest };
}
const legacy = { id: "legacy", message: "Synthetic", commandId: null, teachingSessionId: null, supervisionContextId: null };
const command = { ...legacy, id: "command-message", commandId: "command", teachingSessionId: "class" };
for (const rows of [[], [legacy], [command], [legacy, command]]) test(`inbox cache waits for commit/release after HTTP finish (${rows.length} rows)`, async () => {
  const f = fixture({ rows }); const work = f.run(); await f.ready;
  assert.equal(f.deliveredMessages.size, 0); f.release(); await work;
  const state = f.deliveredMessages.get("device")!; assert.equal(state.lastInboxCheckAt, 1000);
  assert.deepEqual([...state.messageIds], rows.includes(legacy) ? ["legacy"] : []);
  assert.equal(state.hasUnacknowledgedCommandMessages, rows.includes(command));
  if (rows.includes(command)) assert.equal((f.response.body.pendingMessages as Fields[]).find(row => row.commandId)?.messageKind, "announcement");
});
for (const mode of ["commit", "optional", "denied"] as const) test(`${mode} failure never advances the inbox cache`, async () => {
  const f = fixture({ rows: [legacy], failCommit: mode === "commit", checked: mode !== "optional", denied: mode === "denied" });
  const work = f.run(); await f.ready; f.release();
  if (mode === "commit") await assert.rejects(work, /COMMIT failed/); else await work;
  assert.equal(f.deliveredMessages.size, 0);
});
test("close before finish retries immediately after release; a later finish cannot suppress retry", async () => {
  const f = fixture({ rows: [legacy], finish: false }); const work = f.run(); await f.ready;
  f.response.emit("close"); f.response.emit("finish"); f.release(); await work;
  assert.equal(f.deliveredMessages.get("device")?.lastInboxCheckAt, 0);
  assert.equal(f.deliveredMessages.get("device")?.messageIds.size, 0);
});
for (const changed of ["student", "session"] as const) test(`post-HTTP ${changed} replacement cannot apply stale delivery cache`, async () => {
  const f = fixture({ rows: [legacy] }); const work = f.run(); await f.ready;
  f.deviceLastHeartbeat.set("device", { studentId: changed === "student" ? "other" : "student", studentSessionId: "new" });
  f.release(); await work; assert.equal(f.deliveredMessages.size, 0);
});
test("periodic cache retains no-query path and command retries never exclude command-linked IDs", async () => {
  const existing = { studentId: "student", messageIds: new Set(["legacy"]), hasUnacknowledgedCommandMessages: false, lastHeartbeatAt: 999, lastInboxCheckAt: 900 };
  const f = fixture({ existing }); const work = f.run(); await f.ready; assert.equal(f.request(), undefined); f.release(); await work;
  const retry = fixture({ existing: { ...existing, hasUnacknowledgedCommandMessages: true }, rows: [command] });
  const attempt = retry.run(); await retry.ready; assert.deepEqual(JSON.parse(JSON.stringify(retry.request())), { excludeMessageIds: ["legacy"] }); retry.release(); await attempt;
  assert.deepEqual([...retry.deliveredMessages.get("device")!.messageIds], ["legacy"]);
});
test("newer completed request is not overwritten by an older committed check", async () => {
  const f = fixture({ rows: [legacy] }); const work = f.run(); await f.ready;
  const newer = { studentId: "student", messageIds: new Set<string>(), hasUnacknowledgedCommandMessages: true, lastHeartbeatAt: 2000, lastInboxCheckAt: 2000 };
  f.deliveredMessages.set("device", newer); f.release(); await work;
  assert.equal(f.deliveredMessages.get("device"), newer); assert.equal(newer.messageIds.size, 0);
});

test("client closed before inbox staging cannot suppress legacy recovery", async () => {
  const f = fixture({ rows: [legacy], finish: false, alreadyClosed: true }); const work = f.run(); await f.ready;
  f.release(); await work; assert.equal(f.deliveredMessages.get("device")?.lastInboxCheckAt, 0);
  assert.equal(f.deliveredMessages.get("device")?.messageIds.size, 0);
});

test("finish after release marks only legacy IDs; close after release forces immediate retry", async () => {
  for (const event of ["finish", "close"]) {
    const f = fixture({ rows: [legacy, command], finish: false }); const work = f.run(); await f.ready;
    f.release(); await work; assert.equal(f.deliveredMessages.get("device")?.messageIds.size, 0);
    f.response.emit(event); const state = f.deliveredMessages.get("device")!;
    assert.deepEqual([...state.messageIds], event === "finish" ? ["legacy"] : []);
    assert.equal(state.lastInboxCheckAt, event === "close" ? 0 : 1000);
    assert.equal(state.hasUnacknowledgedCommandMessages, true);
  }
});
