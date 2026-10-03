import assert from "node:assert/strict";
import { it } from "node:test";
import {
  ClasspilotUsageRollupAdmission, ClasspilotUsageRollupBudget,
  CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL, withClasspilotUsageRollupOperation,
  type ClasspilotUsageRollupClock,
} from "../src/services/classpilotUsageRollupAdmission.ts";
import {
  classpilotUsageRollupDay, CLASSPILOT_USAGE_ROLLUP_INSERT_SQL, rollupClasspilotUsageDay,
  type ClasspilotUsageRollupClient, type ClasspilotUsageRollupPool,
} from "../src/services/classpilotUsageRollup.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fakeClock() {
  let now = 0;
  const timers = new Map<object, { at: number; callback(): void }>();
  const clock: ClasspilotUsageRollupClock = { now: () => now, schedule(callback, milliseconds) {
    const id = {}; timers.set(id, { at: now + milliseconds, callback }); return () => { timers.delete(id); };
  } };
  return { clock, advance(milliseconds: number, fire = true) {
    now += milliseconds;
    if (fire) for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  }, pending: () => timers.size };
}
const hasCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;
const empty = async () => ({ rows: [] });

it("admits one pool writer, reserves the FIFO waiter, bounds overflow and preserves its original deadline", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock), pool = {};
  const first = await admission.acquire(pool);
  const second = admission.acquire(pool);
  await assert.rejects(admission.acquire(pool), hasCode("USAGE_ROLLUP_BUSY"));
  const independent = await admission.acquire({}); independent.release();
  time.advance(34_000);
  first.release(); first.release();
  let thirdEntered = false;
  const third = admission.acquire(pool).then(permit => { thirdEntered = true; return permit; });
  const next = await second;
  assert.equal(thirdEntered, false);
  assert.equal(next.budget.remainingMs(), 26_000);
  next.release();
  (await third).release();
  assert.equal(time.pending(), 0);
});

it("expires queued work without a connection and removes its deadline timer", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock), pool = {};
  const first = await admission.acquire(pool);
  const queued = assert.rejects(admission.acquire(pool), hasCode("USAGE_ROLLUP_DEADLINE"));
  time.advance(60_000); await queued; first.release();
  const later = await admission.acquire(pool); later.release(); assert.equal(time.pending(), 0);
});

it("cancels only the queued operation and leaves the active permit owned", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock), pool = {};
  const first = await admission.acquire(pool), controller = new AbortController();
  const cancelled = assert.rejects(admission.acquire(pool, controller.signal), hasCode("USAGE_ROLLUP_CANCELLED"));
  controller.abort(); await cancelled;
  const replacement = admission.acquire(pool);
  await assert.rejects(admission.acquire(pool), hasCode("USAGE_ROLLUP_BUSY"));
  first.release(); (await replacement).release(); assert.equal(time.pending(), 0);
  await assert.rejects(admission.acquire(pool, controller.signal), hasCode("USAGE_ROLLUP_CANCELLED"));
});

it("rechecks the deadline on dispatch even when a timer callback was delayed", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock), pool = {};
  const first = await admission.acquire(pool), expired = assert.rejects(admission.acquire(pool), hasCode("USAGE_ROLLUP_DEADLINE"));
  time.advance(60_001, false); first.release(); await expired; assert.equal(time.pending(), 0);
  (await admission.acquire(pool)).release();
});

it("removes a waiter when timer setup fails instead of leaving a ghost queue entry", async () => {
  const time = fakeClock(); let rejectSchedule = true;
  const admission = new ClasspilotUsageRollupAdmission({ now: time.clock.now, schedule(callback, milliseconds) {
    if (rejectSchedule) throw new Error("timer unavailable");
    return time.clock.schedule(callback, milliseconds);
  } }), pool = {};
  const first = await admission.acquire(pool);
  await assert.rejects(admission.acquire(pool), /timer unavailable/);
  rejectSchedule = false; const next = admission.acquire(pool);
  first.release(); (await next).release(); assert.equal(time.pending(), 0);
});

it("removes a waiter if its budget expires between queue creation and timer setup", async () => {
  const time = fakeClock(); let readings = 0;
  const admission = new ClasspilotUsageRollupAdmission({ now() {
    if (++readings === 5) time.advance(60_000, false);
    return time.clock.now();
  }, schedule: time.clock.schedule }), pool = {};
  const first = await admission.acquire(pool);
  await assert.rejects(admission.acquire(pool), hasCode("USAGE_ROLLUP_DEADLINE"));
  const next = admission.acquire(pool);
  first.release(); (await next).release(); assert.equal(time.pending(), 0);
});

it("awaits a late checkout, releases its client without SQL, then admits the next writer", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock), checkout = deferred<ClasspilotUsageRollupClient>();
  let connects = 0, releases = 0, firstWork = false;
  const client = { query: empty, release() { releases++; } };
  const pool: ClasspilotUsageRollupPool = { query: empty, connect() { connects++; return connects === 1 ? checkout.promise : Promise.resolve(client); } };
  const first = assert.rejects(withClasspilotUsageRollupOperation(pool, async () => { firstWork = true; }, { admission }), hasCode("USAGE_ROLLUP_DEADLINE"));
  await Promise.resolve(); time.advance(30_000);
  const second = withClasspilotUsageRollupOperation(pool, async () => "second", { admission });
  time.advance(30_001); assert.equal(connects, 1);
  checkout.resolve(client); await first; assert.equal(await second, "second");
  assert.equal(firstWork, false); assert.equal(releases, 2); assert.equal(connects, 2);
});

it("holds admission through delayed cleanup and rejects over-budget completion", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock), entered = deferred<void>(), cleanup = deferred<void>();
  let connects = 0, releases = 0;
  const pool: ClasspilotUsageRollupPool = { query: empty, async connect() { connects++; return { query: empty, release() { releases++; } }; } };
  const first = assert.rejects(withClasspilotUsageRollupOperation(pool, async () => {
    entered.resolve(); await cleanup.promise; return "late";
  }, { admission }), hasCode("USAGE_ROLLUP_DEADLINE"));
  await entered.promise; time.advance(20_000);
  const second = withClasspilotUsageRollupOperation(pool, async () => "second", { admission });
  time.advance(40_001); assert.equal(connects, 1); assert.equal(releases, 0);
  cleanup.resolve(); await first; assert.equal(await second, "second"); assert.equal(releases, 2);
});

it("releases the permit on checkout and release failure without hiding those failures", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock);
  let connects = 0;
  const pool: ClasspilotUsageRollupPool = { query: empty, async connect() {
    connects++;
    if (connects === 1) throw new Error("checkout failed");
    return { query: empty, release() { if (connects === 2) throw new Error("release failed"); } };
  } };
  await assert.rejects(withClasspilotUsageRollupOperation(pool, async () => true, { admission }), /checkout failed/);
  await assert.rejects(withClasspilotUsageRollupOperation(pool, async () => true, { admission }), /release failed/);
  assert.equal(await withClasspilotUsageRollupOperation(pool, async () => true, { admission }), true);
});

it("preserves an original work failure if cleanup also fails after the budget", async () => {
  const time = fakeClock(), admission = new ClasspilotUsageRollupAdmission(time.clock);
  const original = new Error("original SQL failure");
  const pool: ClasspilotUsageRollupPool = { query: empty, async connect() {
    return { query: empty, release() { time.advance(60_001); throw new Error("secondary release failure"); } };
  } };
  await assert.rejects(withClasspilotUsageRollupOperation(pool, async () => { throw original; }, { admission }), error => error === original);
});

it("reduces each SQL budget and rejects expired work before another statement", async () => {
  const time = fakeClock(), budget = new ClasspilotUsageRollupBudget(time.clock), calls: Array<{ text: string; values?: unknown[] }> = [];
  const client: ClasspilotUsageRollupClient = { async query(text, values) { calls.push({ text, values }); return { rows: [] }; }, release() {} };
  time.advance(10_000); await budget.query(client, "SELECT 1");
  time.advance(5_000); await budget.query(client, "SELECT 2");
  assert.deepEqual(calls.filter(row => row.text === CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL).map(row => row.values), [[50_000],[45_000]]);
  assert.match(CLASSPILOT_USAGE_ROLLUP_TIMEOUT_SQL, /LEAST\(\$1::integer, CASE WHEN setting::integer = 0/);
  time.advance(45_000); await assert.rejects(budget.query(client,"SELECT 3"), hasCode("USAGE_ROLLUP_DEADLINE"));
  assert.equal(calls.length, 4);
});

it("detects cancellation after an active query completes before issuing another statement", async () => {
  const time = fakeClock(), controller = new AbortController(), budget = new ClasspilotUsageRollupBudget(time.clock, controller.signal);
  const client: ClasspilotUsageRollupClient = { async query(text) { if (text === "SELECT 1") controller.abort(); return { rows: [] }; }, release() {} };
  await assert.rejects(budget.query(client,"SELECT 1"), hasCode("USAGE_ROLLUP_CANCELLED"));
});

it("all rollup entrypoint callers share one writer and bounded admission", async () => {
  const inserted = deferred<void>(), finish = deferred<void>(); let connects = 0, released = 0;
  const pool: ClasspilotUsageRollupPool = { query: empty, async connect() {
    connects++; const first = connects === 1;
    return { async query(text) {
      if (first && text === CLASSPILOT_USAGE_ROLLUP_INSERT_SQL) { inserted.resolve(); await finish.promise; }
      return { rows: [] };
    }, release() { released++; } };
  } };
  const day = classpilotUsageRollupDay("2026-10-01", "America/New_York");
  const run = (schoolId: string) => rollupClasspilotUsageDay(pool, { schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
  const first = run("first"); await inserted.promise;
  const second = run("second"); await assert.rejects(run("third"), hasCode("USAGE_ROLLUP_BUSY"));
  assert.equal(connects, 1); finish.resolve(); await Promise.all([first,second]);
  assert.equal(connects, 2); assert.equal(released, 2);
});
