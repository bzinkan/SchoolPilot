import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

process.env.SCHEDULER_DB_POOL_MAX = "1";
process.env.SCHEDULER_LOCK_POOL_MAX = "2";

const { pool } = await import("../dist/db.js");
const { runWithSchedulerLock } = await import("../dist/services/scheduler.js");
const { schedulerLockPool, schedulerPool } = await import("../dist/services/schedulerDb.js");

describe("scheduler advisory locks", () => {
  after(async () => {
    await Promise.allSettled([pool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  });

  it("skips duplicate jobs while a matching advisory lock is held", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runWithSchedulerLock("test-lock", async () => {
      firstStarted();
      await releaseFirstPromise;
      return "first";
    });

    await firstStartedPromise;

    const second = await runWithSchedulerLock("test-lock", async () => "second");
    assert.deepEqual(second, { acquired: false });

    releaseFirst();
    assert.deepEqual(await first, { acquired: true, result: "first" });

    const third = await runWithSchedulerLock("test-lock", async () => "third");
    assert.deepEqual(third, { acquired: true, result: "third" });
  });

  it("does not consume scheduler query-pool connections while holding locks", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runWithSchedulerLock("test-query-pool-isolation", async () => {
      firstStarted();
      await releaseFirstPromise;
      return "first";
    });

    await firstStartedPromise;

    const result = await schedulerPool.query<{ ok: number }>("SELECT 1 AS ok");
    assert.equal(result.rows[0]?.ok, 1);

    const rlsFlag = await schedulerPool.query<{ isSuper: string | null }>(
      "SELECT current_setting('app.is_super', true) AS \"isSuper\""
    );
    assert.equal(rlsFlag.rows[0]?.isSuper, "on");

    releaseFirst();
    assert.deepEqual(await first, { acquired: true, result: "first" });
  });
});
