import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { createRedisReadyWaiter } from "../src/util/redisReadyWaiter.ts";

class FakeRedisClient extends EventEmitter {
  isReady = false;

  becomeReady() {
    this.isReady = true;
    this.emit("ready");
  }

  disconnect() {
    this.isReady = false;
  }
}

describe("shared Redis readiness waiter", () => {
  it("uses one ready listener for 25 concurrent waiters and resolves all of them", async () => {
    const client = new FakeRedisClient();
    const waitForReady = createRedisReadyWaiter(client, 1_000);

    const waits = Array.from({ length: 25 }, () => waitForReady());
    assert.equal(client.listenerCount("ready"), 1);
    assert.ok(waits.every((wait) => wait === waits[0]));

    client.becomeReady();
    await Promise.all(waits);
    assert.equal(client.listenerCount("ready"), 0);
  });

  it("rejects all concurrent waiters on one timeout and retries on a later wait", async () => {
    const client = new FakeRedisClient();
    const waitForReady = createRedisReadyWaiter(client, 10);

    const firstCycle = Array.from({ length: 25 }, () => waitForReady());
    assert.equal(client.listenerCount("ready"), 1);
    const settled = await Promise.allSettled(firstCycle);
    assert.ok(
      settled.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          result.reason.message === "redis not ready"
      )
    );
    assert.equal(client.listenerCount("ready"), 0);

    const retry = waitForReady();
    assert.equal(client.listenerCount("ready"), 1);
    client.becomeReady();
    await retry;
    assert.equal(client.listenerCount("ready"), 0);
  });

  it("closes the missed-ready race and starts a fresh cycle after disconnect", async () => {
    const client = new FakeRedisClient();
    const originalOn = client.on.bind(client);
    let simulateMissedEvent = true;
    client.on = ((event: string | symbol, listener: (...args: any[]) => void) => {
      if (simulateMissedEvent && event === "ready") {
        simulateMissedEvent = false;
        client.isReady = true;
      }
      return originalOn(event, listener);
    }) as typeof client.on;

    const waitForReady = createRedisReadyWaiter(client, 1_000);
    await waitForReady();
    assert.equal(client.listenerCount("ready"), 0);

    client.disconnect();
    const reconnect = waitForReady();
    assert.equal(client.listenerCount("ready"), 1);
    client.becomeReady();
    await reconnect;
    assert.equal(client.listenerCount("ready"), 0);
  });
});
