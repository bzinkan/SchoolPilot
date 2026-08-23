import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BoundedClasspilotTurnTelemetryLimiter,
  CLASSPILOT_TURN_MAX_CONNECTION_TIME_MS,
  classpilotTurnTelemetryDigest,
  classpilotTurnTelemetryMetricPayload,
  classpilotTurnTelemetrySchema,
} from "../src/services/classpilotTurnTelemetry.js";

const negotiationId = "signed-negotiation-token-with-enough-length";

describe("ClassPilot TURN client telemetry", () => {
  it("accepts only the strict bounded terminal ICE contract", () => {
    assert.equal(classpilotTurnTelemetrySchema.safeParse({
      negotiationId,
      attempt: 1,
      outcome: "connected",
      connectionTimeMs: 1_234,
      selectedCandidateType: "relay",
      relayTransport: "tls",
    }).success, true);

    for (const value of [
      {
        negotiationId,
        attempt: 3,
        outcome: "connected",
        connectionTimeMs: 1,
        selectedCandidateType: "host",
      },
      {
        negotiationId,
        attempt: 0,
        outcome: "connected",
        connectionTimeMs: CLASSPILOT_TURN_MAX_CONNECTION_TIME_MS + 1,
        selectedCandidateType: "host",
      },
      {
        negotiationId,
        attempt: 0,
        outcome: "failed",
        connectionTimeMs: 30_000,
        selectedCandidateType: "relay",
      },
      {
        negotiationId,
        attempt: 0,
        outcome: "connected",
        connectionTimeMs: 500,
        selectedCandidateType: "host",
        relayTransport: "udp",
      },
      {
        negotiationId,
        attempt: 0,
        outcome: "failed",
        connectionTimeMs: 500,
        selectedCandidateType: "unknown",
        arbitraryReason: "raw browser error",
      },
    ]) {
      assert.equal(classpilotTurnTelemetrySchema.safeParse(value).success, false);
    }
  });

  it("bounds and expires opaque per-attempt idempotency state", () => {
    const limiter = new BoundedClasspilotTurnTelemetryLimiter(2, 100);
    assert.equal(limiter.accept("digest-a", 1_000), true);
    assert.equal(limiter.accept("digest-a", 1_001), false);
    assert.equal(limiter.accept("digest-b", 1_002), true);
    assert.equal(limiter.accept("digest-c", 1_003), true);
    assert.equal(limiter.size, 2);
    assert.equal(limiter.accept("digest-b", 1_200), true);
    assert.equal(limiter.size, 1);
  });

  it("uses opaque limiter keys and emits identifier-free fixed-name EMF", () => {
    const binding = {
      schoolId: "school-secret",
      studentId: "student-secret",
      studentSessionId: "session-secret",
      deviceId: "device-secret",
    };
    const digest = classpilotTurnTelemetryDigest({
      binding,
      negotiationId,
      attempt: 2,
    });
    assert.match(digest, /^[A-Za-z0-9_-]{43}$/);
    for (const secret of [...Object.values(binding), negotiationId]) {
      assert.doesNotMatch(digest, new RegExp(secret));
    }

    const payload = classpilotTurnTelemetryMetricPayload({
      attempt: 2,
      outcome: "connected",
      connectionTimeMs: 3_210,
      selectedCandidateType: "relay",
      relayTransport: "tcp",
    }, {
      nowMs: 10_000,
      environment: "test",
    });
    const serialized = JSON.stringify(payload);
    assert.equal(payload.IceSuccessCount, 1);
    assert.equal(payload.IceConnectionTimeMs, 3_210);
    assert.equal(payload.RelayFallbackCount, 1);
    assert.equal(payload.RelayTcpCount, 1);
    assert.equal(payload.IceRestartAttemptCount, 1);
    assert.deepEqual(
      (payload._aws as {
        CloudWatchMetrics: Array<{ Dimensions: string[][] }>;
      }).CloudWatchMetrics[0]?.Dimensions,
      [["Environment"]]
    );
    assert.doesNotMatch(
      serialized,
      /school-secret|student-secret|session-secret|device-secret|signed-negotiation/
    );
    assert.doesNotMatch(
      serialized,
      /schoolId|studentId|studentSessionId|deviceId|negotiationId|userId|requestId/
    );
  });

  it("mounts behind device auth, entitlement, capability, active negotiation, and current staff authority", () => {
    const route = readFileSync("src/routes/classpilot/liveViewTelemetry.ts", "utf8");
    const index = readFileSync("src/routes/index.ts", "utf8");
    assert.match(route, /requireCryptographicDeviceAuth/);
    assert.match(route, /requireClasspilotEntitlement/);
    assert.match(route, /max: 20/);
    assert.match(route, /device-token:[^\n]*createHash\("sha256"\)/);
    assert.match(route, /isClasspilotCapabilityActive\("liveViewIceServersV1"/);
    assert.match(route, /isClasspilotLiveViewNegotiationActive/);
    assert.match(route, /isAuthorizedClasspilotSessionStaff/);
    assert.match(route, /controlState\?\.teachingSessionId === authority\.teachingSessionId/);
    assert.match(route, /status\(202\)\.json\(\{[\s\S]*accepted:[\s\S]*duplicate:/);
    assert.match(index, /router\.use\("\/classpilot", liveViewTelemetryRoutes\)/);
  });
});
