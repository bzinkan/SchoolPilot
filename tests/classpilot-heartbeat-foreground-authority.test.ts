import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/storage.ts", import.meta.url), "utf8");
const start = source.indexOf("async function runClasspilotControlDeliveryTransaction<");
const end = source.indexOf("export async function withClasspilotStudentWebSocketBootstrapAuthority<", start);
assert.ok(start >= 0 && end > start);
const executable = ts.transpileModule(source.slice(start, end).replaceAll("export ", "") + "\nwithClasspilotHeartbeatDeliveryAuthority;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
type Projection = { authority: { kind: string; teachingSessionId?: string; controlRevision: number } };
type Result = { authorized: boolean; value?: unknown; foreground: { status: string; succeeded?: boolean } };
type Prepare = (connection: object, read: () => Promise<Projection | undefined>) => Promise<unknown>;
function fixture(options: { projection?: Projection; deny?: boolean; fault?: string; bindings?: boolean[]; publish?: () => Promise<void> } = {}) {
  const order: string[] = []; let held = false, failures = 0, published = 0, bindingReads = 0, faults = 0;
  const projection = options.projection ?? { authority: { kind: "teaching_session", teachingSessionId: "teaching-a", controlRevision: 8 } };
  const connection = { async execute(query: string) {
    assert.equal(held, true); const final = query.includes("AS entitled"); order.push(final ? "final-fence" : query.startsWith("SELECT") ? "temporal" : query);
    if (final) return { rows: [{ entitled: true, bound: options.bindings?.[2] ?? true, denialReason: "license_inactive" }] };
    if (options.fault && query.startsWith(options.fault) && faults++ === 0) throw new Error("synthetic SQL failure");
    return { rows: options.deny ? [] : [{ allowed: 1 }] };
  } };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => strings.reduce((s, part, i) => s + part + (i < values.length ? String(values[i]) : ""), "").trim();
  const fn = runInNewContext(executable, {
    trackHeartbeatPreparedReadTask: (_tx: object, work: () => Promise<unknown>) => work(),
    sealHeartbeatPreparedReads: async () => {},
    assertHeartbeatPreparedReadsSettled: () => {},
    withHeartbeatPreparedReadTransaction: (reference: { transaction: (work: () => Promise<unknown>) => Promise<unknown> }, _school: string, work: () => Promise<unknown>) => reference.transaction(work),
    db: { async transaction(work: (tx: typeof connection) => Promise<unknown>) {
      held = true; order.push("begin"); try { return await work(connection); } finally { held = false; order.push("released"); }
    } }, sql: tag, classpilotStudentControlStates: "control", teachingSessions: "teaching", studentSessions: {}, students: {}, devices: {}, schools: {},
    classpilotSupervisionStudents: "assignments", classpilotSupervisionContexts: "contexts",
    classpilotEntitledSchoolPredicate: () => "entitled", currentStudentSessionAuthorityPredicate: () => "exact-current-clock",
    assertClasspilotEntitled: async () => { order.push("entitlement"); },
    lockClasspilotStudentControlAuthorities: async () => { order.push("student-lock"); },
    lockClasspilotSsoPolicyDeliveryAuthority: async () => {},
    hasExactClasspilotTelemetryBinding: async () => { order.push("binding"); return options.bindings?.[bindingReads++] ?? true; },
    getClasspilotScreenshotAuthorityProjection: async (_binding: object, tx: object) => { assert.equal(tx, connection); return projection; },
    assertClasspilotSynchronousAuthorityResult(value: unknown) { assert.equal(value instanceof Promise, false); },
    ClasspilotTeacherChatBindingLostError: class extends Error {},
  }) as (binding: object, prepare: Prepare, deliver: () => string, recovery: undefined, foreground: object) => Promise<Result>;
  const run = (prepare: Prepare = async (_tx, read) => read(), overrides: Record<string, unknown> = {}) => fn(
    { schoolId: "school-a", studentId: "student-a", studentSessionId: "binding-a", deviceId: "device-a" }, prepare,
    () => { assert.equal(held, true); order.push("http"); return "HTTP200"; }, undefined,
    { teachingSessionId: "teaching-a", controlRevision: 8, publish: async () => { assert.equal(held, true); published++; order.push("publish"); await options.publish?.(); },
      onFailure: () => { failures++; }, ...overrides });
  return { run, order, snapshot: () => ({ held, failures, published, bindingReads }) };
}

test("owned teaching proof publishes once between fresh binding fences and returns HTTP under retained ownership", async () => {
  const f = fixture(); const r = await f.run();
  assert.equal(r.authorized, true); assert.deepEqual(JSON.parse(JSON.stringify(r.foreground)), { status: "settled", succeeded: true });
  assert.deepEqual(f.order, ["begin", "entitlement", "student-lock", "binding", "binding", "SAVEPOINT classpilot_heartbeat_foreground", "temporal", "publish", "RELEASE SAVEPOINT classpilot_heartbeat_foreground", "final-fence", "http", "released"]);
});
for (const mode of ["no-reader", "wrong-session", "wrong-revision", "student-proof"] as const) test(`unsupported ${mode} requests fallback without optional SQL or transport`, async () => {
  const f = fixture(mode === "student-proof" ? { projection: { authority: { kind: "student_session", controlRevision: 8 } } } : {});
  const r = await f.run(mode === "no-reader" ? async () => undefined : undefined,
    mode === "wrong-session" ? { teachingSessionId: "other" } : mode === "wrong-revision" ? { controlRevision: 9 } : {});
  assert.equal(r.foreground.status, "fallback"); assert.equal(f.snapshot().published, 0); assert.equal(f.order.includes("temporal"), false);
});
test("temporal denial suppresses rather than falling back and still checks HTTP binding", async () => {
  const f = fixture({ deny: true }); const r = await f.run();
  assert.equal(r.authorized, true); assert.equal(r.foreground.status, "suppressed"); assert.equal(f.snapshot().published, 0);
  assert.equal(f.order.filter(x => x === "binding").length, 2); assert.ok(f.order.includes("final-fence"));
});
for (const kind of ["temporal SQL", "partial transport"] as const) test(`${kind} failure is terminal and restores its savepoint before mandatory SQL`, async () => {
  const f = fixture(kind === "temporal SQL" ? { fault: "SELECT" } : { publish: async () => { throw new Error("partial send"); } });
  const r = await f.run(); assert.equal(r.authorized, true); assert.equal(r.foreground.status, "settled"); assert.equal(r.foreground.succeeded, false);
  assert.equal(f.snapshot().failures, 1); assert.equal(f.snapshot().published, kind === "temporal SQL" ? 0 : 1);
  const rollback = f.order.indexOf("ROLLBACK TO SAVEPOINT classpilot_heartbeat_foreground");
  assert.ok(rollback > 0); assert.equal(f.order[rollback + 1], "RELEASE SAVEPOINT classpilot_heartbeat_foreground"); assert.equal(f.order[rollback + 2], "final-fence");
});
for (const statement of ["ROLLBACK TO SAVEPOINT", "RELEASE SAVEPOINT"] as const) test(`${statement} failure cannot authorize HTTP`, async () => {
  const f = fixture({ fault: statement, publish: async () => { throw new Error("partial send"); } });
  await assert.rejects(f.run(), /synthetic SQL failure/); assert.equal(f.order.includes("http"), false); assert.equal(f.snapshot().held, false);
});
test("binding loss before optional phase emits nothing; binding loss after publish never authorizes HTTP", async () => {
  for (const [bindings, emitted] of [[[true, false], 0], [[true, true, false], 1]] as const) {
    const f = fixture({ bindings: [...bindings] }); const r = await f.run();
    assert.equal(r.authorized, false); assert.equal(r.foreground.status, "suppressed"); assert.equal(f.snapshot().published, emitted); assert.equal(f.order.includes("http"), false);
  }
});
test("public projection mutation cannot forge retained grant and reader cannot escape preparation", async () => {
  const f = fixture({ projection: { authority: { kind: "student_session", controlRevision: 8 } } });
  let retained: (() => Promise<Projection | undefined>) | undefined;
  const r = await f.run(async (_tx, read) => { retained = read; const p = await read(); p!.authority = { kind: "teaching_session", teachingSessionId: "teaching-a", controlRevision: 8 }; });
  assert.equal(r.foreground.status, "fallback"); await assert.rejects(retained!(), /after preparation/);
});
