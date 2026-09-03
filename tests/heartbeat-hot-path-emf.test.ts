import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HOT_PATH_EMF_COUNTERS,
  HOT_PATH_EMF_EVENT,
  HOT_PATH_EMF_NAMESPACE,
  buildHeartbeatHotPathEmfEvent,
  buildHeartbeatHotPathSummaryEvent,
} from "../src/services/heartbeatHotPathMetrics.ts";

const INTERVAL = {
  startedAt: new Date("2026-09-01T13:00:00.000Z"),
  endedAt: new Date("2026-09-01T13:01:00.000Z"),
};

// The alarm resources in infra/alarms.tf reference these names verbatim.
const EXPECTED_METRICS = [
  "HeartbeatRecorded",
  "HeartbeatGapOver60Seconds",
  "TileBatchScreenshotItems",
  "TileBatchScreenshotMissItems",
  "TileBatchScreenshotStoreUnavailable",
  "ScreenshotAvailableBroadcastFailures",
  "ScreenshotAvailableBroadcastSkipped",
  "ScreenshotCadenceObservationUnavailable",
  "DeviceHeartbeatRateLimited",
  "DeviceScreenshotRateLimited",
];

const EXPECTED_COUNTERS = [
  "heartbeatRecorded",
  "heartbeatGapOver60Seconds",
  "tileBatchScreenshotItems",
  "tileBatchScreenshotMissItems",
  "tileBatchScreenshotStoreUnavailable",
  "screenshotAvailableBroadcastFailures",
  "screenshotAvailableBroadcastSkipped",
  "screenshotCadenceObservationUnavailable",
  "deviceHeartbeatRateLimited",
  "deviceScreenshotRateLimited",
];

describe("heartbeat hot-path EMF event", () => {
  it("maps the fixed counter allowlist onto stable CloudWatch metric names", () => {
    assert.deepEqual(
      HOT_PATH_EMF_COUNTERS.map(([counter]) => counter),
      EXPECTED_COUNTERS
    );
    assert.deepEqual(
      HOT_PATH_EMF_COUNTERS.map(([, metric]) => metric),
      EXPECTED_METRICS
    );
    assert.equal(HOT_PATH_EMF_NAMESPACE, "SchoolPilot/ClassPilot");
    assert.equal(HOT_PATH_EMF_EVENT, "classpilot_heartbeat_hot_path_emf");
  });

  it("emits the hand-rolled EMF envelope with Environment/Service dimensions only", () => {
    const event = buildHeartbeatHotPathEmfEvent(
      { counters: {}, timings: {} },
      INTERVAL,
      { APP_ENV: "production", NODE_ENV: "test" }
    );

    assert.deepEqual(event._aws, {
      Timestamp: INTERVAL.endedAt.getTime(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot",
        Dimensions: [["Environment", "Service"]],
        Metrics: EXPECTED_METRICS.map((Name) => ({ Name, Unit: "Count" })),
      }],
    });
    assert.equal(event.Environment, "production");
    assert.equal(event.Service, "api");
    assert.equal(event.event, "classpilot_heartbeat_hot_path_emf");
    assert.equal(event.intervalStartedAtUtc, "2026-09-01T13:00:00.000Z");
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        "_aws",
        "Environment",
        "Service",
        "event",
        "intervalStartedAtUtc",
        ...EXPECTED_METRICS,
      ].sort()
    );
  });

  it("defaults every mapped metric to zero when its counter is absent", () => {
    const event = buildHeartbeatHotPathEmfEvent(
      { counters: {}, timings: {} },
      INTERVAL,
      {}
    );
    for (const metric of EXPECTED_METRICS) {
      assert.equal(event[metric], 0, metric);
    }
    assert.equal(event.Environment, "development");
  });

  it("copies recorded counter values and ignores unmapped counters and timings", () => {
    const event = buildHeartbeatHotPathEmfEvent({
      counters: {
        heartbeatRecorded: 1200,
        heartbeatGapOver60Seconds: 7,
        heartbeatGapOver30Seconds: 40,
        tileBatchScreenshotItems: 350,
        tileBatchScreenshotMissItems: 12,
        tileBatchScreenshotStoreUnavailable: 1,
        screenshotAvailableBroadcastFailures: 3,
        screenshotAvailableBroadcastSkipped: 6,
        screenshotCadenceObservationUnavailable: 2,
        deviceHeartbeatRateLimited: 5,
        deviceScreenshotRateLimited: 4,
        tileBatchHistoryFallbackItems: 99,
      },
      timings: { heartbeatDatabaseMs: { count: 3, totalMs: 30, maxMs: 20 } },
    }, INTERVAL, { NODE_ENV: "test" });

    assert.equal(event.HeartbeatRecorded, 1200);
    assert.equal(event.HeartbeatGapOver60Seconds, 7);
    assert.equal(event.TileBatchScreenshotItems, 350);
    assert.equal(event.TileBatchScreenshotMissItems, 12);
    assert.equal(event.TileBatchScreenshotStoreUnavailable, 1);
    assert.equal(event.ScreenshotAvailableBroadcastFailures, 3);
    assert.equal(event.ScreenshotAvailableBroadcastSkipped, 6);
    assert.equal(event.ScreenshotCadenceObservationUnavailable, 2);
    assert.equal(event.DeviceHeartbeatRateLimited, 5);
    assert.equal(event.DeviceScreenshotRateLimited, 4);
    assert.equal(event.Environment, "test");
    assert.equal("heartbeatGapOver30Seconds" in event, false);
    assert.equal("tileBatchHistoryFallbackItems" in event, false);
    assert.equal("counters" in event, false);
    assert.equal("timings" in event, false);
  });

  it("carries no school, device, student, or request identifiers", () => {
    const serialized = JSON.stringify(buildHeartbeatHotPathEmfEvent({
      counters: { heartbeatRecorded: 1 },
      timings: {},
    }, INTERVAL, { APP_ENV: "production" }));

    assert.doesNotMatch(serialized, /"(school|device|student|session|request)[A-Za-z]*Id"/i);
    assert.doesNotMatch(serialized, /"(schoolId|deviceId|studentId|userId|url|redisKey)"/);
    // The PI finalizer filters CloudWatch Logs on the summary event name; the
    // EMF twin must never match that filter pattern.
    assert.equal(serialized.includes("classpilot_heartbeat_hot_path_summary"), false);
  });

  it("rejects intervals that are not one UTC-minute lattice cell", () => {
    assert.throws(
      () => buildHeartbeatHotPathEmfEvent({ counters: {}, timings: {} }, {
        startedAt: new Date("2026-09-01T13:00:00.000Z"),
        endedAt: new Date("2026-09-01T13:02:00.000Z"),
      }),
      /heartbeat_hot_path_interval_invalid/
    );
    assert.throws(
      () => buildHeartbeatHotPathEmfEvent({ counters: {}, timings: {} }, {
        startedAt: new Date("2026-09-01T13:00:00.500Z"),
        endedAt: new Date("2026-09-01T13:01:00.500Z"),
      }),
      /heartbeat_hot_path_interval_invalid/
    );
  });

  it("leaves the summary event schema untouched", () => {
    const snapshot = {
      counters: { heartbeatRecorded: 4, tileBatchHistoryFallbackItems: 2 },
      timings: { heartbeatDatabaseMs: { count: 1, totalMs: 5, maxMs: 5 } },
    };
    const summary = buildHeartbeatHotPathSummaryEvent(snapshot, INTERVAL);

    assert.deepEqual(Object.keys(summary), [
      "event",
      "intervalSeconds",
      "intervalStartedAtUtc",
      "intervalEndedAtUtc",
      "counters",
      "timings",
    ]);
    assert.equal(summary.event, "classpilot_heartbeat_hot_path_summary");
    assert.equal(summary.intervalSeconds, 60);
    assert.equal(summary.intervalStartedAtUtc, "2026-09-01T13:00:00.000Z");
    assert.equal(summary.intervalEndedAtUtc, "2026-09-01T13:01:00.000Z");
    assert.deepEqual(summary.counters, snapshot.counters);
    assert.deepEqual(summary.timings, snapshot.timings);
    assert.equal("_aws" in summary, false);
    assert.equal(JSON.stringify(summary).includes("_aws"), false);
  });

  it("emits the EMF line beside the summary line on each interval flush", () => {
    const source = readFileSync(
      new URL("../src/services/heartbeatHotPathMetrics.ts", import.meta.url),
      "utf8"
    );
    const flushStart = source.indexOf(
      "function flushExpiredHeartbeatHotPathMetricIntervals("
    );
    assert.ok(flushStart >= 0);
    const flush = source.slice(flushStart);
    const summaryLog = flush.indexOf(
      "console.log(JSON.stringify(buildHeartbeatHotPathSummaryEvent(snapshot, {"
    );
    const emfLog = flush.indexOf(
      "console.log(JSON.stringify(buildHeartbeatHotPathEmfEvent(snapshot, {"
    );
    assert.ok(summaryLog >= 0);
    assert.ok(emfLog > summaryLog);
    assert.equal((flush.match(/console\.log\(/g) ?? []).length, 2);
  });
});
