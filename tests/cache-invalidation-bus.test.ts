import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  disposeCacheInvalidationPublisher,
  dispatchCacheInvalidation,
  publishCacheInvalidation,
  registerCacheInvalidationHandler,
  registerCacheInvalidationPublisher,
  type CacheInvalidationTarget,
} from "../dist/realtime/cacheInvalidation.js";
import {
  closeRedisRuntimeForShutdown,
  type RedisShutdownClient,
} from "../dist/realtime/ws-redis.js";

const target: CacheInvalidationTarget = {
  kind: "cache-invalidation",
  schoolId: "school-a",
  cache: "heartbeat-tracking-settings",
};

describe("cache invalidation bus", () => {
  it("dispatches peer invalidations without importing the Redis runtime", () => {
    let received: CacheInvalidationTarget | undefined;
    registerCacheInvalidationHandler((next) => {
      received = next;
    });

    dispatchCacheInvalidation(target);

    assert.deepEqual(received, target);
  });

  it("notifies every registered cache without allowing one handler to replace another", () => {
    const received: string[] = [];
    const unregisterFirst = registerCacheInvalidationHandler(() => received.push("first"));
    const unregisterSecond = registerCacheInvalidationHandler(() => received.push("second"));

    dispatchCacheInvalidation({
      kind: "cache-invalidation",
      schoolId: "school-a",
      cache: "classpilot-dashboard-school",
    });
    assert.deepEqual(received.slice(-2), ["first", "second"]);

    unregisterFirst();
    unregisterSecond();
  });

  it("delegates publication only after the realtime layer registers a publisher", async () => {
    let published: CacheInvalidationTarget | undefined;
    registerCacheInvalidationPublisher(async (next) => {
      published = next;
      return true;
    });

    assert.equal(await publishCacheInvalidation(target), true);
    assert.deepEqual(published, target);
  });

  it("bounds Redis initialization and terminal socket disconnect", async () => {
    const never = new Promise<never>(() => {});
    let quitCalls = 0;
    let disconnectCalls = 0;
    const client: RedisShutdownClient & { quit(): Promise<never> } = {
      quit: () => {
        quitCalls += 1;
        return never;
      },
      disconnect: () => {
        disconnectCalls += 1;
        return never;
      },
    };
    const startedAt = Date.now();

    await closeRedisRuntimeForShutdown({
      initialization: never,
      clients: () => [client],
      initializationGraceMs: 20,
      disconnectGraceMs: 20,
    });

    assert.equal(quitCalls, 0);
    assert.equal(disconnectCalls, 1);
    assert.ok(Date.now() - startedAt < 1_000);
  });

  it("bounds a stuck publication and makes shutdown terminal", async () => {
    const events: string[] = [];
    const observedSignals: AbortSignal[] = [];
    let publishCalls = 0;
    const never = new Promise<boolean>(() => {});
    registerCacheInvalidationPublisher(
      async (_target, options) => {
        publishCalls += 1;
        if (options?.signal) observedSignals.push(options.signal);
        return never;
      },
      async () => {
        events.push("disposed");
      }
    );

    const startedAt = Date.now();
    assert.equal(
      await publishCacheInvalidation(target, { timeoutMs: 25 }),
      false
    );
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(observedSignals[0]?.aborted, true);

    const remainingCapacity = Array.from({ length: 15 }, () =>
      publishCacheInvalidation(target, { timeoutMs: 10 })
    );
    const capacityStartedAt = Date.now();
    assert.equal(
      await publishCacheInvalidation(target, { timeoutMs: 100 }),
      false
    );
    assert.ok(Date.now() - capacityStartedAt < 500);
    assert.equal(publishCalls, 16);
    assert.deepEqual(await Promise.all(remainingCapacity), Array(15).fill(false));

    await disposeCacheInvalidationPublisher(50);
    assert.equal(await publishCacheInvalidation(target), false);

    registerCacheInvalidationPublisher(
      async () => {
        events.push("late-publish");
        return true;
      },
      () => {
        events.push("late-disposed");
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await disposeCacheInvalidationPublisher();

    assert.deepEqual(events, [
      "disposed",
      "late-disposed",
    ]);
  });
});
