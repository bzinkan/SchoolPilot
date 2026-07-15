import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dispatchCacheInvalidation,
  publishCacheInvalidation,
  registerCacheInvalidationHandler,
  registerCacheInvalidationPublisher,
  type CacheInvalidationTarget,
} from "../dist/realtime/cacheInvalidation.js";

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

  it("delegates publication only after the realtime layer registers a publisher", async () => {
    let published: CacheInvalidationTarget | undefined;
    registerCacheInvalidationPublisher(async (next) => {
      published = next;
      return true;
    });

    assert.equal(await publishCacheInvalidation(target), true);
    assert.deepEqual(published, target);
  });
});
