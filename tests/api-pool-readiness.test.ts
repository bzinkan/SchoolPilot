import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiPoolReadiness } from "../src/services/apiPoolReadiness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture({ start = true } = {}) {
  let clock = 0;
  let probes = 0;
  let probe: () => Promise<boolean> = async () => true;
  const pool = { total: 16, idle: 16, waiting: 0, max: 16 };
  const transitions: Array<{ state: string; stalledForMs: number }> = [];
  const readiness = new ApiPoolReadiness({
    now: () => clock,
    readPool: () => ({ ...pool }),
    probeDatabase: () => { probes++; return probe(); },
    onTransition(event) { transitions.push(event); },
  });
  if (start) readiness.start();
  return {
    readiness, pool, transitions,
    get probes() { return probes; },
    setProbe(next: () => Promise<boolean>) { probe = next; },
    setTime(now: number) { assert.ok(now >= clock); clock = now; },
    async sampleAt(now: number) { assert.ok(now >= clock); clock = now; await readiness.sample(); },
    saturate(waiting = 1) { pool.total = pool.max; pool.idle = 0; pool.waiting = waiting; },
  };
}

describe("API pool readiness", () => {
  it("does not probe or report ready before serving startup, and stays draining after stop", async () => {
    const f = fixture({ start: false });
    f.saturate();
    assert.deepEqual(f.readiness.status(), { ready: false, reason: "starting" });
    await f.sampleAt(120_000);
    assert.equal(f.probes, 0);
    f.readiness.start();
    assert.deepEqual(f.readiness.status(), { ready: true, reason: "ready" });
    f.readiness.stop();
    await f.sampleAt(240_000);
    assert.deepEqual(f.readiness.status(), { ready: false, reason: "draining" });
    assert.equal(f.probes, 0);
  });

  it("keeps an idle server healthy across zero-traffic intervals without querying the database", async () => {
    const f = fixture();
    for (const now of [0, 60_000, 120_000, 600_000]) await f.sampleAt(now);
    assert.equal(f.readiness.status().ready, true);
    assert.equal(f.probes, 0);
    assert.equal(f.transitions.some(({ state }) => state === "pool_stalled"), false);
  });

  it("does not mistake a fully leased cohort with no observed demand for a failed pool", async () => {
    const f = fixture();
    f.saturate(0);
    for (const now of [0, 60_000, 120_000, 180_000]) await f.sampleAt(now);
    assert.equal(f.readiness.status().ready, true);
    assert.equal(f.probes, 0);
  });

  it("requires sustained full capacity and two independent successes ten seconds apart", async () => {
    const f = fixture();
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(59_999);
    assert.equal(f.probes, 0);
    await f.sampleAt(60_000);
    assert.equal(f.probes, 1);
    assert.equal(f.readiness.status().ready, true);
    await f.sampleAt(69_999);
    assert.equal(f.probes, 1);
    await f.sampleAt(70_000);
    assert.equal(f.probes, 2);
    assert.deepEqual(f.readiness.status(), { ready: false, reason: "pool_stalled" });
  });

  it("remembers failed demand after the waiting requests have timed out", async () => {
    const f = fixture();
    f.saturate();
    await f.sampleAt(0);
    f.pool.waiting = 0;
    await f.sampleAt(60_000);
    await f.sampleAt(70_000);
    assert.equal(f.pool.waiting, 0);
    assert.deepEqual(f.readiness.status(), { ready: false, reason: "pool_stalled" });
  });

  it("uses an acquisition failure as demand even when polling never sees a waiter", async () => {
    const f = fixture();
    f.saturate(0);
    f.readiness.recordAcquisitionFailure();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    await f.sampleAt(70_000);
    assert.deepEqual(f.readiness.status(), { ready: false, reason: "pool_stalled" });
  });

  it("does not retire a busy server while release/acquire progress continues at full capacity", async () => {
    const f = fixture();
    f.saturate();
    await f.sampleAt(0);
    // A released client can be handed directly to the next waiter, leaving
    // sampled idleCount at zero throughout an ordinary busy school period.
    for (const now of [55_000, 110_000, 165_000, 220_000]) {
      f.setTime(now);
      f.readiness.recordProgress();
      await f.readiness.sample();
    }
    assert.equal(f.readiness.status().ready, true);
    assert.equal(f.probes, 0);
  });

  it("resets the stall clock after progress even when the pool remains full", async () => {
    const f = fixture();
    f.saturate();
    await f.sampleAt(0);
    f.setTime(55_000);
    f.readiness.recordProgress();
    await f.readiness.sample();
    await f.sampleAt(65_000);
    assert.equal(f.probes, 0);
    await f.sampleAt(115_000);
    assert.equal(f.probes, 1);
    await f.sampleAt(125_000);
    assert.equal(f.readiness.status().reason, "pool_stalled");
  });

  it("does not mark partial capacity or available idle clients as an exhausted pool", async () => {
    for (const counts of [{ total: 15, idle: 0 }, { total: 16, idle: 1 }]) {
      const f = fixture();
      Object.assign(f.pool, counts, { waiting: 2 });
      f.readiness.recordAcquisitionFailure();
      await f.sampleAt(0);
      await f.sampleAt(60_000);
      await f.sampleAt(70_000);
      assert.equal(f.readiness.status().ready, true);
      assert.equal(f.probes, 0);
    }
  });

  it("suppresses replacement while the independent database check also fails", async () => {
    const f = fixture();
    f.setProbe(async () => false);
    f.saturate();
    await f.sampleAt(0);
    for (const now of [60_000, 70_000, 130_000, 190_000]) await f.sampleAt(now);
    assert.equal(f.readiness.status().ready, true);
    assert.equal(f.transitions.some(({ state }) => state === "pool_stalled"), false);
    assert.ok(f.transitions.some(({ state }) => state === "probe_deferred"));
  });

  it("requires fresh healthy confirmations after a failed check interrupts confirmation", async () => {
    const f = fixture();
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    f.setProbe(async () => false);
    await f.sampleAt(70_000);
    assert.equal(f.readiness.status().ready, true);
    f.setProbe(async () => true);
    await f.sampleAt(80_000);
    assert.equal(f.readiness.status().ready, true, "a pre-failure success cannot count toward recovery confirmation");
    await f.sampleAt(90_000);
    assert.equal(f.readiness.status().reason, "pool_stalled");
  });

  it("contains a rejected independent probe and does not expose its error through readiness", async () => {
    const f = fixture();
    f.setProbe(async () => { throw new Error("synthetic private connection details"); });
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    assert.deepEqual(f.readiness.status(), { ready: true, reason: "ready" });
    assert.equal(JSON.stringify(f.transitions).includes("private connection details"), false);
  });

  it("shares one pending independent probe across overlapping samples", async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.setProbe(() => pending.promise);
    f.saturate();
    await f.sampleAt(0);
    f.setTime(60_000);
    const first = f.readiness.sample();
    const second = f.readiness.sample();
    assert.equal(f.probes, 1);
    pending.resolve(true);
    await Promise.all([first, second]);
    assert.equal(f.probes, 1);
    assert.equal(f.readiness.status().ready, true);
  });

  it("fences a late successful second probe when main-pool progress has already resumed", async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    f.setProbe(() => pending.promise);
    f.setTime(70_000);
    const sample = f.readiness.sample();
    f.readiness.recordProgress();
    pending.resolve(true);
    await sample;
    assert.deepEqual(f.readiness.status(), { ready: true, reason: "ready" });
    assert.equal(f.transitions.some(({ state }) => state === "pool_stalled"), false);
  });

  it("rechecks capacity after awaiting a probe, even without a progress callback", async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    f.setProbe(() => pending.promise);
    f.setTime(70_000);
    const sample = f.readiness.sample();
    f.pool.idle = 1;
    pending.resolve(true);
    await sample;
    assert.deepEqual(f.readiness.status(), { ready: true, reason: "ready" });
  });

  it("fences an in-flight probe during shutdown and drains it without starting another", async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    f.setProbe(() => pending.promise);
    f.setTime(70_000);
    const sample = f.readiness.sample();
    f.readiness.stop();
    let drained = false;
    const drain = f.readiness.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    assert.deepEqual(f.readiness.status(), { ready: false, reason: "draining" });
    pending.resolve(true);
    await Promise.all([sample, drain]);
    await f.sampleAt(90_000);
    assert.equal(drained, true);
    assert.equal(f.probes, 2);
    assert.equal(f.transitions.some(({ state }) => state === "pool_stalled"), false);
  });

  it("answers repeated readiness requests from cached state without adding probes", async () => {
    const f = fixture();
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    await f.sampleAt(70_000);
    const before = f.probes;
    for (let index = 0; index < 100; index++) {
      assert.deepEqual(f.readiness.status(), { ready: false, reason: "pool_stalled" });
    }
    assert.equal(f.probes, before);
  });

  it("restores readiness after real pool progress and emits a single transition for each state", async () => {
    const f = fixture();
    f.saturate();
    await f.sampleAt(0);
    await f.sampleAt(60_000);
    await f.sampleAt(70_000);
    await f.sampleAt(80_000);
    assert.equal(f.transitions.filter(({ state }) => state === "pool_stalled").length, 1);
    f.readiness.recordProgress();
    assert.deepEqual(f.readiness.status(), { ready: true, reason: "ready" });
    f.pool.idle = 1;
    await f.sampleAt(90_000);
    assert.equal(f.transitions.at(-1)?.state, "ready");
    assert.equal(f.transitions.filter(({ state }) => state === "pool_stalled").length, 1);
  });
});
