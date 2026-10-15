import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
const boundedContext = vm.createContext({ performance,
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args) });
vm.runInContext(ts.transpileModule(readFileSync(new URL("../src/realtime/boundedRedisPublication.ts", import.meta.url), "utf8")
    .replaceAll("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, boundedContext);
const BoundedRedisPublication = boundedContext.BoundedRedisPublication
    ?? vm.runInContext("BoundedRedisPublication", boundedContext);
const redisSource = readFileSync(new URL("../src/realtime/ws-redis.ts", import.meta.url), "utf8");
const observationSource = readFileSync(new URL("../src/services/classpilotObservationLease.ts", import.meta.url), "utf8");
function between(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, `Actual source fence ${start}`);
    return source.slice(a, b);
}
const diagnosticSource = between(redisSource, "const OBSERVATION_NOT_ADMITTED_LABELS", "type HotPathActivity");
const recorderSource = between(redisSource, "function recordObservationStatusOutcome(", "const coordinationRuntime");
const wrapperSource = between(redisSource, "export async function realtimeRedisCommand(", "export async function subscribeWS(")
    .replace("export async function", "async function");
const statusSource = between(observationSource, "async function observationStatusForSubject(", "export async function classpilotObservationStatus(");
const luaSource = between(observationSource, "const OBSERVATION_STATUS_SCRIPT", "async function observationStatusForSubject(");
const compile = (source) => ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
function fixture(runtime, configured = true) {
    const activity = { observationStatusOutcomes: {} };
    const context = vm.createContext({ redisUrl: configured ? "synthetic-configured" : "", coordinationRuntime: runtime,
        hotPathActivity: activity });
    vm.runInContext(compile(`${diagnosticSource}\n${recorderSource}\n${wrapperSource}`), context);
    const invoke = context.realtimeRedisCommand;
    return { activity, invoke };
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const failureCases = [
    ["not_admitted", "queue_full"], ["not_admitted", "not_ready"], ["not_admitted", "circuit_open"],
    ["not_admitted", "shutdown"], ["not_admitted", "aborted"], ["not_admitted", "not_configured"],
    ["unknown", "timeout"], ["unknown", "transport_lost"], ["unknown", "shutdown"], ["unknown", "aborted"],
];
for (const [status, reason] of failureCases) {
    test(`actual coordination wrapper records only the fixed observation ${status}/${reason} disposition`, async () => {
        let calls = 0;
        const controller = new AbortController();
        const f = fixture({ async publish(_operation, options) {
                calls++;
                assert.equal(options.budgetMs, 250);
                assert.equal(options.signal, controller.signal);
                assert.deepEqual(Object.keys(options).sort(), ["budgetMs", "signal"]);
                return { status, reason };
            } });
        assert.equal(await f.invoke(["EVAL", "private-script", "1", "private-key"], {
            readyTimeoutMs: 200, signal: controller.signal, diagnosticOperation: "observation_status",
        }), undefined);
        assert.equal(calls, 1);
        assert.deepEqual(f.activity.observationStatusOutcomes, { [`${status}_${reason}`]: 1 });
        assert.ok(!JSON.stringify(f.activity).includes("private"));
    });
}
test("accepted means only transport accepted, preserves opaque replies and ignores untagged coordination operations", async () => {
    const raw = { opaque: "private-reply", notAnObservationStatus: true }, commands = [];
    const f = fixture({ async publish(operation) {
            return { status: "accepted", value: await operation({ async sendCommand(args) { commands.push(args); return raw; } }) };
        } });
    const args = ["EVAL", "private-script", "1", "private-key"];
    assert.equal(await f.invoke(args, { diagnosticOperation: "observation_status" }), raw);
    assert.equal(commands[0], args);
    assert.deepEqual(f.activity.observationStatusOutcomes, { accepted: 1 });
    for (const diagnosticOperation of [undefined, "tile_write", "status_write", "fab_getdel", "renew", "release", "constructor"]) {
        assert.equal(await f.invoke(args, { diagnosticOperation }), raw);
    }
    assert.deepEqual(f.activity.observationStatusOutcomes, { accepted: 1 });
    assert.ok(!JSON.stringify(f.activity).includes("private"));
});
test("missing configuration records one fixed refusal without calling the runtime", async () => {
    let calls = 0;
    const f = fixture({ async publish() { calls++; throw new Error("must not run"); } }, false);
    assert.equal(await f.invoke(["EVAL"], { diagnosticOperation: "observation_status" }), undefined);
    assert.deepEqual(f.activity.observationStatusOutcomes, { not_admitted_not_configured: 1 });
    assert.equal(calls, 0);
});
test("unknown and prototype input labels never create free-form diagnostic fields", async () => {
    for (const status of ["not_admitted", "unknown", "private-status", "constructor"]) {
        for (const reason of ["private-reason", "__proto__", "constructor", "toString"]) {
            const f = fixture({ async publish() { return { status, reason }; } });
            assert.equal(await f.invoke(["private-args"], { diagnosticOperation: "observation_status" }), undefined);
            assert.deepEqual(f.activity.observationStatusOutcomes, {});
        }
    }
});
test("a diagnostic storage failure cannot change accepted values or refused returns", async () => {
    for (const outcome of [{ status: "accepted", value: 0 }, { status: "not_admitted", reason: "queue_full" }]) {
        const f = fixture({ async publish() { return outcome; } });
        f.activity.observationStatusOutcomes = new Proxy({}, { set() { throw new Error("private-sink-error"); } });
        assert.equal(await f.invoke(["EVAL"], { diagnosticOperation: "observation_status" }), outcome.value);
    }
});
test("actual runtime timeout is counted once while late raw acceptance stays owned and does not replace it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const raw = deferred();
    let sends = 0;
    const client = { isReady: true, connect: async () => { }, destroy: () => raw.reject(Error("closed")),
        async sendCommand() { sends++; return raw.promise; } };
    const runtime = new BoundedRedisPublication({ create: () => client });
    const f = fixture(runtime);
    try {
        const pending = f.invoke(["EVAL"], { diagnosticOperation: "observation_status" });
        assert.equal(runtime.snapshot().active, 1);
        t.mock.timers.tick(250);
        assert.equal(await pending, undefined);
        assert.deepEqual(f.activity.observationStatusOutcomes, { unknown_timeout: 1 });
        assert.equal(runtime.snapshot().active, 1);
        raw.resolve([1, 123]);
        await tick();
        assert.equal(runtime.snapshot().active, 0);
        assert.deepEqual(f.activity.observationStatusOutcomes, { unknown_timeout: 1 });
        assert.equal(sends, 1);
    }
    finally {
        await runtime.dispose();
    }
});
test("actual runtime pre-admission and post-admission cancellation retain distinct single dispositions", async () => {
    const raw = deferred();
    let sends = 0;
    const client = { isReady: true, connect: async () => { }, destroy: () => raw.reject(Error("closed")),
        async sendCommand() { sends++; return raw.promise; } };
    const runtime = new BoundedRedisPublication({ create: () => client });
    const f = fixture(runtime), before = new AbortController(), after = new AbortController();
    try {
        before.abort();
        assert.equal(await f.invoke(["EVAL"], { signal: before.signal, diagnosticOperation: "observation_status" }), undefined);
        assert.equal(sends, 0);
        const pending = f.invoke(["EVAL"], { signal: after.signal, diagnosticOperation: "observation_status" });
        assert.equal(runtime.snapshot().active, 1);
        after.abort();
        assert.equal(await pending, undefined);
        assert.deepEqual(f.activity.observationStatusOutcomes, { not_admitted_aborted: 1, unknown_aborted: 1 });
        assert.equal(runtime.snapshot().active, 1);
        raw.resolve([0, 0]);
        await tick();
        assert.equal(runtime.snapshot().active, 0);
        assert.deepEqual(f.activity.observationStatusOutcomes, { not_admitted_aborted: 1, unknown_aborted: 1 });
        assert.equal(sends, 1);
    }
    finally {
        await runtime.dispose();
    }
});
test("actual observation status EVAL alone opts in and retains valid and fail-closed reply handling", async () => {
    for (const result of [[1, 91_000], [0, 0], [-1, 0], undefined, { private: "malformed" }]) {
        const captured = [];
        const context = vm.createContext({ Date, process: { env: { REDIS_URL: "synthetic-configured" } },
            observationLeaseStoreRequired: () => true, subjectIndexKey: () => "synthetic-index",
            CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION: 128, MAX_OBSERVATION_STUDENTS: 500,
            redisCommand: async (args, options) => { captured.push({ args, options }); return result; } });
        vm.runInContext(compile(`${luaSource}\n${statusSource}`), context);
        const invoke = context.observationStatusForSubject;
        const actual = await invoke({ schoolId: "private-school", subject: {}, studentId: "private-student", now: 1000 });
        assert.equal(captured.length, 1);
        assert.equal(captured[0].args[0], "EVAL");
        assert.deepEqual(JSON.parse(JSON.stringify(captured[0].options)), {
            readyTimeoutMs: 200, diagnosticOperation: "observation_status",
        });
        assert.deepEqual(JSON.parse(JSON.stringify(actual)), Array.isArray(result) && result[0] === 1
            ? { status: "observed", expiresInSeconds: 90 }
            : Array.isArray(result) && result[0] === 0 ? { status: "unobserved", expiresInSeconds: 0 }
                : { status: "unavailable", expiresInSeconds: 0 });
    }
    const tag = 'diagnosticOperation: "observation_status"';
    assert.equal(observationSource.split(tag).length - 1, 1, "Renew and release must not use the read diagnostic");
});
