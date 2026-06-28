import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { pool } from "../dist/db.js";
import { runWithSchedulerLock } from "../dist/services/scheduler.js";
import { schedulerPool } from "../dist/services/schedulerDb.js";

describe("scheduler advisory locks", () => {
  after(async () => {
    await Promise.allSettled([pool.end(), schedulerPool.end()]);
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
});
