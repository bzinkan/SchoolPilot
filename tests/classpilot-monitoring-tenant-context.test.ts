import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pg from "pg";

process.env.DATABASE_URL = "postgresql://unit:unit@127.0.0.1:1/schoolpilot_unit";
process.env.REDIS_URL = "";
const { pool } = await import("../src/db.js");
const { getTenantStore, tenantALS } = await import("../src/db/tenantContext.js");
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
const { default: errorMonitor } = await import("../src/services/errorMonitor.js");
const { getClasspilotMonitoringPolicy } = await import("../src/services/classpilotMonitoringPolicy.js");
const { getHeartbeatTrackingSettingsForSchool } = await import("../src/services/storage.js");

function fixture(t: TestContext, maximum = 1) {
  const previous = process.env.RLS_GUC_ENABLED;
  process.env.RLS_GUC_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.RLS_GUC_ENABLED;
    else process.env.RLS_GUC_ENABLED = previous;
  });
  t.mock.method(errorMonitor, "trackError", () => {});
  const fullBySchool = new Map([["monitor-school-a", true], ["monitor-school-b", false]]);
  const reads: Array<{ schoolId: string; isSuper: string; client: pg.Client }> = [];
  const clients: Array<{ client: pg.PoolClient; schoolId: string; isSuper: string; held: boolean; releases: number }> = [];
  let pausedReset: { started: () => void; allowed: Promise<void> } | undefined;
  const connect = t.mock.method(pool, "connect", async () => {
    let entry = clients.find(candidate => !candidate.held);
    if (!entry) {
      if (clients.length >= maximum) throw new Error("one-client fixture is saturated by the outer request");
      const state = { schoolId: "", isSuper: "off", held: true, releases: 0 };
      const client = Object.assign(new pg.Client(), {
        release() {
          assert.equal(state.held, true, "client released exactly once");
          assert.equal(state.schoolId, "", "school GUC reset before release");
          assert.equal(state.isSuper, "off", "super GUC reset before release");
          state.held = false; state.releases++;
        },
      });
      t.mock.method(client, "query", async (query: string | { text: string }, values?: unknown[]) => {
        const text = typeof query === "string" ? query : query.text;
        assert.equal(state.held, true, "query must retain client ownership");
        if (text.includes("set_config")) {
          if (text.includes("'app.school_id', ''")) {
            const paused = pausedReset; pausedReset = undefined;
            if (paused) { paused.started(); await paused.allowed; }
            state.schoolId = ""; state.isSuper = "off";
          }
          else { state.isSuper = String(values?.[0]); state.schoolId = String(values?.[1]); }
          return { rows: [] };
        }
        assert.match(text, /from "settings" inner join "schools"/);
        assert.equal(values?.[0], state.schoolId, "fresh settings are read only in the selected tenant scope");
        reads.push({ schoolId: state.schoolId, isSuper: state.isSuper, client });
        return { rows: [[true, "08:00", "15:00", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          "America/New_York", fullBySchool.get(state.schoolId) ? "full" : "off", {}, {}]] };
      });
      entry = Object.assign(state, { client }); clients.push(entry);
    }
    entry.held = true;
    return entry.client;
  });
  return { connect, clients, reads, fullBySchool, pauseNextReset() {
    let started!: () => void, allow!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    const allowed = new Promise<void>(resolve => { allow = resolve; });
    pausedReset = { started, allowed };
    return { reached, allow };
  } };
}

const afterHours = { now: new Date("2026-09-09T03:00:00Z") };

test("monitoring policy reuses a matching one-client request lease and reads changed authority freshly", async t => {
  const f = fixture(t);
  await runWithTenantContext({ schoolId: "monitor-school-a" }, async () => {
    const outer = getTenantStore();
    assert.ok(outer);
    // Warm the existing heartbeat-settings cache; command authority must bypass it.
    assert.equal((await getHeartbeatTrackingSettingsForSchool("monitor-school-a"))?.afterHoursMode, "full");
    f.fullBySchool.set("monitor-school-a", false);
    assert.equal((await getClasspilotMonitoringPolicy("monitor-school-a", afterHours)).mode, "off");
    f.fullBySchool.set("monitor-school-a", true);
    assert.equal((await getClasspilotMonitoringPolicy("monitor-school-a", afterHours)).mode, "full");
    assert.equal(getTenantStore(), outer);
    assert.equal(f.connect.mock.callCount(), 1, "no second checkout while the request owns the only client");
    assert.equal(f.reads.length, 3, "cached settings must never authorize the command");
    assert.ok(f.reads.every(read => read.client === outer.client && read.isSuper === "off"));
    assert.equal(f.clients[0]?.releases, 0, "nested helper must not release the request's client");
  });
  assert.equal(f.clients[0]?.releases, 1);
  assert.equal(getTenantStore(), undefined);
});

test("monitoring policy uses a separate non-super lease for a different school and restores outer authority", async t => {
  const f = fixture(t, 2);
  await runWithTenantContext({ schoolId: "monitor-school-a" }, async () => {
    const outer = getTenantStore();
    assert.ok(outer);
    assert.equal((await getClasspilotMonitoringPolicy("monitor-school-b", afterHours)).mode, "off");
    assert.equal(getTenantStore(), outer);
    assert.equal(f.connect.mock.callCount(), 2);
    assert.equal(f.reads.length, 1);
    assert.equal(f.reads[0]?.schoolId, "monitor-school-b");
    assert.equal(f.reads[0]?.isSuper, "off");
    assert.notEqual(f.reads[0]?.client, outer.client);
    assert.equal(f.clients[0]?.schoolId, "monitor-school-a");
    assert.equal(f.clients[0]?.releases, 0);
    assert.equal(f.clients[1]?.releases, 1);
  });
  assert.equal(f.clients[0]?.releases, 1);
});

test("monitoring policy does not inherit same-school super authority or release it", async t => {
  const f = fixture(t, 2);
  await runWithTenantContext({ schoolId: "monitor-school-a", isSuper: true }, async () => {
    const outer = getTenantStore();
    assert.ok(outer);
    assert.equal((await getClasspilotMonitoringPolicy("monitor-school-a", afterHours)).mode, "full");
    assert.equal(getTenantStore(), outer);
    assert.equal(f.connect.mock.callCount(), 2);
    assert.equal(f.reads[0]?.isSuper, "off");
    assert.notEqual(f.reads[0]?.client, outer.client);
    assert.equal(f.clients[0]?.isSuper, "on");
    assert.equal(f.clients[0]?.releases, 0);
    assert.equal(f.clients[1]?.releases, 1);
  });
  assert.equal(f.clients[0]?.releases, 1);
});

test("unbound monitoring policy still owns and cleans up its short tenant lease", async t => {
  const f = fixture(t);
  assert.equal((await getClasspilotMonitoringPolicy("monitor-school-b", afterHours)).mode, "off");
  assert.equal(f.connect.mock.callCount(), 1);
  assert.equal(f.reads[0]?.schoolId, "monitor-school-b");
  assert.equal(f.reads[0]?.isSuper, "off");
  assert.equal(f.clients[0]?.releases, 1);
  assert.equal(getTenantStore(), undefined);
});

test("a captured context cannot reuse a client while its RESET is in flight", async t => {
  const f = fixture(t, 2), paused = f.pauseNextReset();
  let captured: NonNullable<ReturnType<typeof getTenantStore>> | undefined;
  const releasing = runWithTenantContext({ schoolId: "monitor-school-a" }, async () => { captured = getTenantStore(); });
  try {
    await paused.reached;
    assert.ok(captured);
    await tenantALS.run(captured, async () => {
      assert.equal((await getClasspilotMonitoringPolicy("monitor-school-a", afterHours)).mode, "full");
    });
    assert.equal(f.connect.mock.callCount(), 2);
    assert.notEqual(f.reads[0]?.client, captured.client);
    assert.equal(f.clients[0]?.releases, 0);
    assert.equal(f.clients[1]?.releases, 1);
  } finally { paused.allow(); await releasing; }
  assert.equal(f.clients[0]?.releases, 1);
});

test("a stale context cannot borrow a later lease of the same physical client", async t => {
  const f = fixture(t, 2);
  let captured: NonNullable<ReturnType<typeof getTenantStore>> | undefined;
  await runWithTenantContext({ schoolId: "monitor-school-a" }, async () => { captured = getTenantStore(); });
  assert.ok(captured);
  const stale = captured;
  await runWithTenantContext({ schoolId: "monitor-school-a" }, async () => {
    const current = getTenantStore(); assert.ok(current);
    assert.equal(current.client, stale.client);
    assert.notEqual(current, stale);
    await tenantALS.run(stale, async () => {
      assert.equal((await getClasspilotMonitoringPolicy("monitor-school-a", afterHours)).mode, "full");
    });
    assert.equal(f.connect.mock.callCount(), 3);
    assert.notEqual(f.reads[0]?.client, current.client);
    assert.equal(getTenantStore(), current);
    assert.equal(f.clients[0]?.releases, 1, "the current lease is still owned by its own caller");
  });
  assert.equal(f.clients[0]?.releases, 2);
});
