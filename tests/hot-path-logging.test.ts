import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("ClassPilot hot-path logging", () => {
  it("aggregates Redis and screenshot success activity without identifiers", () => {
    const redisSource = readFileSync(
      new URL("../src/realtime/ws-redis.ts", import.meta.url),
      "utf8"
    );
    const devicesSource = readFileSync(
      new URL("../src/routes/classpilot/devices.ts", import.meta.url),
      "utf8"
    );
    const websocketSource = readFileSync(
      new URL("../src/realtime/websocket.ts", import.meta.url),
      "utf8"
    );

    assert.match(redisSource, /HOT_PATH_LOG_INTERVAL_MS = 60_000/);
    assert.match(redisSource, /event: "realtime_hot_path_summary"/);
    assert.match(devicesSource, /recordScreenshotUpload\(/);

    assert.doesNotMatch(redisSource, /console\.log\(`\[Redis\].*publishing/);
    assert.doesNotMatch(redisSource, /console\.log\(`\[Redis\].*published/);
    assert.doesNotMatch(redisSource, /console\.log\(`\[Redis\].*received/);
    assert.doesNotMatch(devicesSource, /\[Screenshot\] Upload from device=/);

    assert.match(websocketSource, /MAX_CONCURRENT_COMMAND_UPDATE_PUBLICATIONS = 2/);
    const publicationSource = readFileSync(new URL("../src/realtime/boundedRedisPublication.ts", import.meta.url), "utf8");
    assert.match(publicationSource, /ordinaryMs: 250, orderedMs: 500, maxInFlight: 32/);
    assert.match(publicationSource, /rawWatchdogMs: 2_000/);
    assert.match(websocketSource, /includeSource: false/);
    assert.match(publicationSource, /Promise\.race\(\[terminal, timeout\]\)/);
    assert.match(redisSource, /budgetMs: REDIS_PUBLICATION_LIMITS\.orderedMs/);
    assert.match(websocketSource, /orderedKey: state\.key/);
    assert.match(websocketSource, /recordLocalOrderedDelivery\(state\.key, revision\)/);
    assert.match(websocketSource, /state\.dirty = true/);
    assert.match(redisSource, /envelope\.instanceId === instanceId && !envelope\.includeSource/);
    assert.match(redisSource, /ORDERED_PUBLISH_SCRIPT/);
    assert.match(redisSource, /isRedisPublisherReady/);
  });
});
