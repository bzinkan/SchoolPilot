import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
} from "../src/services/classpilotHistoryFallbackSqlIdentity.ts";
import {
  bindHeartbeatHotPathApiRuntimeTaskDefinitionSha256,
  bindHeartbeatHotPathHistoryFallbackSqlIdentity,
  buildHeartbeatHotPathSummaryEvent,
  recordHeartbeatTileHistoryFallbackDatabaseRead,
  snapshotHeartbeatHotPathMetrics,
} from "../src/services/heartbeatHotPathMetrics.ts";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

describe("heartbeat hot-path fallback SQL identity", () => {
  it("emits only the version and compiled-SQL hash in sanitized summaries", () => {
    bindHeartbeatHotPathHistoryFallbackSqlIdentity({
      version: CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
      compiledSqlSha256: HEX_A,
      parameterTypeSignatureSha256: HEX_B,
    });
    bindHeartbeatHotPathApiRuntimeTaskDefinitionSha256(HEX_C);

    const event = buildHeartbeatHotPathSummaryEvent({
      counters: { tileBatchHistoryFallbackItems: 40 },
      timings: {},
    }, {
      startedAt: new Date("2026-07-21T20:00:00.000Z"),
      endedAt: new Date("2026-07-21T20:01:00.000Z"),
    });
    assert.equal(
      event.historyFallbackSqlIdentityVersion,
      "history-fallback-queryid-v1"
    );
    assert.equal(event.historyFallbackSqlIdentitySha256, HEX_A);
    assert.equal(event.apiRuntimeTaskDefinitionSha256, HEX_C);
    assert.equal(event.intervalStartedAtUtc, "2026-07-21T20:00:00.000Z");
    assert.equal(event.intervalEndedAtUtc, "2026-07-21T20:01:00.000Z");
    assert.equal(JSON.stringify(event).includes(HEX_B), false);
    assert.equal(JSON.stringify(event).includes("queryIdentifier"), false);
    assert.equal(JSON.stringify(event).includes("task-definition/"), false);
  });

  it("rejects missing, reversed, or non-finite evidence intervals", () => {
    const snapshot = {
      counters: { tileBatchHistoryFallbackItems: 1 },
      timings: {},
    };
    assert.throws(
      () => buildHeartbeatHotPathSummaryEvent(snapshot, {
        startedAt: new Date("2026-07-21T20:01:00.000Z"),
        endedAt: new Date("2026-07-21T20:00:00.000Z"),
      }),
      /heartbeat_hot_path_interval_invalid/
    );
    assert.throws(
      () => buildHeartbeatHotPathSummaryEvent(snapshot, {
        startedAt: new Date(Number.NaN),
        endedAt: new Date("2026-07-21T20:01:00.000Z"),
      }),
      /heartbeat_hot_path_interval_invalid/
    );
    assert.throws(
      () => buildHeartbeatHotPathSummaryEvent(snapshot, {
        startedAt: new Date("2026-07-21T20:00:00.000Z"),
        endedAt: new Date("2026-07-21T20:01:00.001Z"),
      }),
      /heartbeat_hot_path_interval_invalid/
    );
    assert.throws(
      () => buildHeartbeatHotPathSummaryEvent(snapshot, {
        startedAt: new Date("2026-07-21T20:00:00.001Z"),
        endedAt: new Date("2026-07-21T20:01:00.001Z"),
      }),
      /heartbeat_hot_path_interval_invalid/
    );
  });

  it("fails closed for malformed or process-local identity drift", () => {
    assert.throws(
      () => bindHeartbeatHotPathHistoryFallbackSqlIdentity({
        version: CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
        compiledSqlSha256: "not-a-hash",
        parameterTypeSignatureSha256: HEX_B,
      }),
      /history_fallback_sql_shape_identity_invalid/
    );
    assert.throws(
      () => bindHeartbeatHotPathHistoryFallbackSqlIdentity({
        version: CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
        compiledSqlSha256: HEX_B,
        parameterTypeSignatureSha256: HEX_B,
      }),
      /history_fallback_sql_shape_identity_changed/
    );
    assert.throws(
      () => bindHeartbeatHotPathApiRuntimeTaskDefinitionSha256("not-a-hash"),
      /heartbeat_hot_path_api_runtime_identity_invalid/
    );
    assert.throws(
      () => bindHeartbeatHotPathApiRuntimeTaskDefinitionSha256(HEX_A),
      /heartbeat_hot_path_api_runtime_identity_changed/
    );
  });

  it("records fallback cohort size and successful SQL timing atomically", () => {
    snapshotHeartbeatHotPathMetrics({ reset: true });
    recordHeartbeatTileHistoryFallbackDatabaseRead(40, 2.75);
    const snapshot = snapshotHeartbeatHotPathMetrics({ reset: true });
    assert.equal(snapshot.counters.tileBatchHistoryFallbackItems, 40);
    assert.deepEqual(snapshot.timings.tileBatchHistoryDatabaseMs, {
      count: 1,
      totalMs: 2.75,
      maxMs: 2.75,
    });
  });
});
