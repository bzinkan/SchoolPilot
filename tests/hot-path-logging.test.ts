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
    assert.match(websocketSource, /COMMAND_UPDATE_PUBLISH_TIMEOUT_MS = 1_500/);
    assert.match(websocketSource, /includeSource: false/);
    assert.match(websocketSource, /signal: controller\.signal/);
    assert.match(websocketSource, /orderedKey: state\.key/);
    assert.match(websocketSource, /recordLocalOrderedDelivery\(state\.key, revision\)/);
    assert.match(websocketSource, /state\.dirty = true/);
    assert.match(redisSource, /envelope\.instanceId === instanceId && !envelope\.includeSource/);
    assert.match(redisSource, /ORDERED_PUBLISH_SCRIPT/);
    assert.match(redisSource, /isRedisPublisherReady/);
  });
});
