import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const realtime = await import("../src/services/classpilotRealtimeStatus.ts");
const { focusStatusSchema } = await import("../src/services/classpilotFocus.ts");
const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const start = source.indexOf("function publicRealtimeFields(");
const end = source.indexOf("\ntype ClasspilotRealtimeControlAuthority", start);
assert.ok(start >= 0 && end > start);
const executable = ts.transpileModule(`${source.slice(start, end)}\npublicRealtimeFields;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const project: (snapshot: Record<string, unknown>) => Record<string, unknown> = runInNewContext(executable, {
  ...realtime, focusStatusSchema, Date,
});

const binding = { schoolId: "school-a", studentId: "student-a", studentSessionId: "session-a", deviceId: "device-a" };
const heartbeat = {
  ...binding, heartbeatId: "heartbeat-a", observedAt: 1_000_000,
  activeTabUrl: "https://example.test/path", activeTabTitle: "Example", trackingStatus: "ACTIVE",
  allOpenTabs: [], classificationPending: true,
};

function store() {
  let shared: string | undefined;
  const cache = realtime.createClasspilotRealtimeStatusStore(async (args) => {
    if (args[0] === "EVAL") {
      shared = args[5];
      return shared;
    }
    if (args[0] === "MGET") return [shared];
    throw new Error("Unexpected cache command");
  }, () => heartbeat.observedAt);
  return { cache, replace: (value: string) => { shared = value; } };
}

describe("optional Focus status validation", () => {
  it("does not build validation errors for absent Focus in write, shared/local read or public projection", async (t) => {
    const parse = t.mock.method(focusStatusSchema, "safeParse");
    const { cache } = store();
    const result = await cache.write(heartbeat);
    assert.equal(result.status, "stored");
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.focus, undefined);
    assert.equal((await cache.readBatch(binding.schoolId, [binding])).get(binding.studentId)?.status, "hit");
    assert.equal(cache.readLocal(binding.schoolId, [binding]).get(binding.studentId)?.status, "hit");
    assert.equal(project({ ...result.snapshot }).focus, undefined);
    assert.equal(parse.mock.callCount(), 0);
  });

  it("continues validating and dropping present malformed Focus on every ingress and public egress", async (t) => {
    const parse = t.mock.method(focusStatusSchema, "safeParse");
    const malformed: unknown[] = [null, false, "inactive", {}, { state: "active" },
      { state: "suspended", assignmentId: "focus-a", reason: "unknown" },
      { state: "active", assignmentId: "focus-a", deviceId: "must-not-leak" }];
    for (const focus of malformed) {
      const before = parse.mock.callCount();
      const { cache, replace } = store();
      const written = await cache.write({ ...heartbeat, focus });
      assert.ok(written.snapshot);
      assert.equal(written.snapshot.focus, undefined);
      assert.equal(written.snapshot.activeTabTitle, "Example");
      assert.equal(parse.mock.callCount(), before + 1);
      const injected = { ...written.snapshot, focus };
      replace(JSON.stringify(injected));
      const read = (await cache.readBatch(binding.schoolId, [binding])).get(binding.studentId);
      assert.equal(read?.status, "hit");
      assert.ok(read?.snapshot);
      assert.equal(read.snapshot.focus, undefined);
      assert.equal(parse.mock.callCount(), before + 2);
      assert.equal(project(injected).focus, undefined);
      assert.equal(parse.mock.callCount(), before + 3);
    }
    assert.equal(parse.mock.callCount(), malformed.length * 3);
  });

  it("preserves every valid Focus lifecycle state without changing public output", async () => {
    const states = [
      { state: "inactive" },
      { state: "active", assignmentId: "focus-a" },
      ...["attention", "authentication", "browser_operation_pending"].map((reason) => ({ state: "suspended", assignmentId: "focus-a", reason })),
      ...["focus_tab_closed", "focus_tab_missing", "focus_tab_off_policy"].map((reason) => ({ state: "invalidated", assignmentId: "focus-a", reason })),
    ];
    for (const focus of states) {
      const { cache } = store();
      const written = await cache.write({ ...heartbeat, focus });
      assert.ok(written.snapshot);
      assert.deepEqual(written.snapshot.focus, focus);
      const shared = (await cache.readBatch(binding.schoolId, [binding])).get(binding.studentId);
      assert.ok(shared?.status === "hit");
      assert.deepEqual(shared.snapshot.focus, focus);
      const local = cache.readLocal(binding.schoolId, [binding]).get(binding.studentId);
      assert.ok(local?.status === "hit");
      assert.deepEqual(local.snapshot.focus, focus);
      assert.deepEqual(project({ ...written.snapshot }).focus, focus);
    }
  });
});
