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
  it("retains the newest attempted revision across a subscriber reconnect", {
    skip: !redisUrl,
    timeout: 10_000,
  }, async () => {
    const publisher = createClient({ url: redisUrl });
    const delayedPublisher = publisher.duplicate();
    const subscriber = publisher.duplicate();
    const sourceSubscriber = publisher.duplicate();
    const suffix = randomUUID();
    const key = `schoolpilot:test:ws:ordered:${suffix}`;
    const channel = `schoolpilot:test:ws:channel:${suffix}`;
    const messages: string[] = [];
    const localNewest: string[] = [];
    const localDelayed: string[] = [];
    const waitForMessages = async (count: number) => {
      const deadline = Date.now() + 2_000;
      while (messages.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(messages.length, count);
    };

    const publish = (
      client: typeof publisher,
      revision: string,
      payload: string,
      local: string[]
    ) => client.sendCommand<number>([
        "EVAL",
        ORDERED_PUBLISH_SCRIPT,
        "1",
        key,
        revision,
        String(ORDERED_PUBLISH_TTL_SECONDS),
        channel,
        payload,
      ]).then((result) => {
        // Mirrors publishOrderedWS: only an accepted global claim may fan out
        // on the publishing API task.
        if (result >= 0) local.push(payload);
        return result;
      });

    try {
      await publisher.connect();
      await delayedPublisher.connect();
      await subscriber.connect();
      await sourceSubscriber.connect();

      assert.equal(
        await publish(publisher, "200", "newest-without-subscriber", localNewest),
        0
      );
      assert.equal(await publisher.get(key), "200");
      assert.deepEqual(localNewest, ["newest-without-subscriber"]);

      await subscriber.subscribe(channel, (payload) => { messages.push(payload); });
      await sourceSubscriber.subscribe(channel, () => undefined);
      await sourceSubscriber.unsubscribe(channel);
      await sourceSubscriber.quit();
      assert.equal(
        await publish(delayedPublisher, "100", "stale-received", localDelayed),
        -1
      );
      assert.deepEqual(messages, []);
      assert.deepEqual(localDelayed, []);

      // The stale publisher reads a fresh snapshot/revision on its bounded
      // retry, so its own local teachers and the reconnected remote subscriber
      // both converge on the newest state.
      assert.equal(
        await publish(delayedPublisher, "201", "newer-completed", localDelayed),
        1
      );
      await waitForMessages(1);
      assert.equal(await publisher.get(key), "201");
      assert.deepEqual(messages, ["newer-completed"]);
      assert.deepEqual(localDelayed, ["newer-completed"]);

      const localKey = `local:${suffix}`;
      assert.equal(recordLocalOrderedDelivery(localKey, "300"), true);
      assert.equal(recordLocalOrderedDelivery(localKey, "299"), false);
      assert.equal(recordLocalOrderedDelivery(localKey, "301"), true);
    } finally {
      if (publisher.isOpen) await publisher.del(key).catch(() => undefined);
      if (delayedPublisher.isOpen) await delayedPublisher.quit().catch(() => undefined);
      if (sourceSubscriber.isOpen) await sourceSubscriber.quit().catch(() => undefined);
      if (subscriber.isOpen) await subscriber.quit().catch(() => undefined);
      if (publisher.isOpen) await publisher.quit().catch(() => undefined);
    }
  });
});
