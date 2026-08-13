import assert from "node:assert/strict";
import { describe, it } from "node:test";

const relayModuleUrl = new URL("../src/realtime/socketio-redis.ts", import.meta.url).href;

describe("GoPilot Redis relay", () => {
  it("fails bounded and local-only when Redis is unavailable", async () => {
    const original = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const relay: any = await import(`${relayModuleUrl}?unavailable=${Date.now()}`);
    try {
      const startedAt = Date.now();
      assert.equal(
        await relay.publishSocketIoRedis({
          room: "school:test:office",
          event: "queue:updated",
          data: { ok: true },
        }),
        false
      );
      assert.ok(Date.now() - startedAt < 2_000, "relay degradation must not stall HTTP requests");
      assert.equal(relay.getSocketIoRedisHealth().healthy, false);
      const secondStartedAt = Date.now();
      assert.equal(
        await relay.publishSocketIoRedis({
          room: "school:test:office",
          event: "queue:updated",
          data: { retry: true },
        }),
        false
      );
      assert.ok(Date.now() - secondStartedAt < 1_000, "relay backoff must keep repeat publishes nonblocking");
    } finally {
      await relay.closeSocketIoRedis();
      if (original === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = original;
    }
  });

  it(
    "delivers a duplicate message ID exactly once across two relay instances",
    { skip: !process.env.TEST_REDIS_URL },
    async () => {
      const original = process.env.REDIS_URL;
      process.env.REDIS_URL = process.env.TEST_REDIS_URL;
      const suffix = Date.now();
      const first: any = await import(`${relayModuleUrl}?instance=first-${suffix}`);
      const second: any = await import(`${relayModuleUrl}?instance=second-${suffix}`);
      const received: unknown[] = [];
      try {
        await Promise.all([
          first.subscribeSocketIoRedis(() => undefined),
          second.subscribeSocketIoRedis((message: unknown) => received.push(message)),
        ]);
        const message = {
          room: "school:test:office",
          event: "queue:updated",
          data: { queueId: "queue-1" },
          messageId: `dedupe-${suffix}`,
        };
        assert.equal(await first.publishSocketIoRedis(message), true);
        assert.equal(await first.publishSocketIoRedis(message), true);

        const deadline = Date.now() + 2_000;
        while (received.length < 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(received.length, 1);
      } finally {
        await Promise.all([first.closeSocketIoRedis(), second.closeSocketIoRedis()]);
        if (original === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = original;
      }
    }
  );
});
