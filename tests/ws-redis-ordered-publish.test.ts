import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";

import {
  ORDERED_PUBLISH_SCRIPT,
  ORDERED_PUBLISH_TTL_SECONDS,
  recordLocalOrderedDelivery,
} from "../dist/realtime/ws-redis.js";

const redisUrl = process.env.TEST_REDIS_URL;

describe("ordered WebSocket Redis publication", () => {
  it("does not retain an undelivered revision and rejects an older delivered snapshot", {
    skip: !redisUrl,
    timeout: 10_000,
  }, async () => {
    const publisher = createClient({ url: redisUrl });
    const subscriber = publisher.duplicate();
    const sourceSubscriber = publisher.duplicate();
    const suffix = randomUUID();
    const key = `schoolpilot:test:ws:ordered:${suffix}`;
    const channel = `schoolpilot:test:ws:channel:${suffix}`;
    const messages: string[] = [];
    const waitForMessages = async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (messages.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(messages.length, count);
    };

    const publish = (revision: string, payload: string) => publisher.sendCommand<number>([
      "EVAL",
      ORDERED_PUBLISH_SCRIPT,
      "1",
      key,
      revision,
      String(ORDERED_PUBLISH_TTL_SECONDS),
      channel,
      payload,
    ]);

    try {
      await publisher.connect();
      await subscriber.connect();
      await sourceSubscriber.connect();

      assert.equal(await publish("100", "undelivered"), 0);
      assert.equal(await publisher.get(key), null);

      await subscriber.subscribe(channel, (payload) => { messages.push(payload); });
      await sourceSubscriber.subscribe(channel, () => undefined);
      await sourceSubscriber.unsubscribe(channel);
      await sourceSubscriber.quit();
      assert.equal(await publish("200", "completed"), 1);
      await waitForMessages(1);
      assert.equal(await publisher.get(key), "200");
      assert.equal(await publish("100", "stale-received"), -1);
      assert.deepEqual(messages, ["completed"]);

      assert.equal(await publish("201", "newer-completed"), 1);
      await waitForMessages(2);
      assert.equal(await publisher.get(key), "201");
      assert.deepEqual(messages, ["completed", "newer-completed"]);

      const localKey = `local:${suffix}`;
      assert.equal(recordLocalOrderedDelivery(localKey, "300"), true);
      assert.equal(recordLocalOrderedDelivery(localKey, "299"), false);
      assert.equal(recordLocalOrderedDelivery(localKey, "301"), true);
    } finally {
      if (publisher.isOpen) await publisher.del(key).catch(() => undefined);
      if (sourceSubscriber.isOpen) await sourceSubscriber.quit().catch(() => undefined);
      if (subscriber.isOpen) await subscriber.quit().catch(() => undefined);
      if (publisher.isOpen) await publisher.quit().catch(() => undefined);
    }
  });
});
