import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { reliabilityProfile, validateReliabilityEnvironment, minimumReliabilitySamples, reliabilityScreenshotBindingMatches, RELIABILITY_WORKLOAD_VERSION, RELIABILITY_ENDPOINT_SHA256, RELIABILITY_FIXTURE_VERSION, makeReliabilityJpegFixture, reliabilityFixtureEvidence } from "../scripts/load/classpilot-reliability-profile.mjs";
import { stampReliabilityFrame, readReliabilityFrame } from "../scripts/load/reliability-rendered-frame.mjs";

const harness = readFileSync(new URL("../scripts/load/classpilot-load-test.mjs", import.meta.url), "utf8");
const source = harness.match(/const JPEG_1X1\s*=\s*"([^"]+)";/)?.[1];
assert.ok(source);
const baseJpeg = Buffer.from(source, "base64");

function environment(devices: number) {
  const profile = reliabilityProfile(devices);
  return {
    LOAD_RELIABILITY_WORKLOAD: RELIABILITY_WORKLOAD_VERSION,
    LOAD_RELIABILITY_DEVICE_COUNT: String(devices), LOAD_RELIABILITY_SMOKE: "false",
    LOAD_GATE_PROFILE: "partial", LOAD_ENFORCE_THRESHOLDS: "true",
    LOAD_WORKLOAD_SCHEMA_VERSION: RELIABILITY_WORKLOAD_VERSION,
    LOAD_DEVICE_COUNT: String(devices + 10), LOAD_DURATION_SECONDS: String(profile.durationSeconds),
    LOAD_HEARTBEAT_INTERVAL_MS: "10000", LOAD_SCREENSHOT_INTERVAL_MS: "5000",
    LOAD_SCREENSHOT_GET_INTERVAL_MS: "5000", LOAD_HISTORY_INTERVAL_MS: "30000",
    LOAD_REQUEST_TIMEOUT_MS: "8000", LOAD_WS_AUTH_TIMEOUT_MS: "5000",
    LOAD_TEACHER_HISTORY_WARMUP_MS: "18000", LOAD_SCREENSHOT_GET_WARMUP_MS: "13000", LOAD_COMMAND_WARMUP_MS: "30000",
    LOAD_SCREENSHOT_BYTES: "40960", LOAD_EXPECTED_CLASS_BODIES: String(profile.classrooms),
    LOAD_EXPECTED_TARGETS_PER_CLASS: String(profile.studentsPerClass), LOAD_EXPECTED_CANARY_DEVICES: "10",
    LOAD_WAF_DEVICE_LIMIT: "100000", LOAD_WAF_GENERAL_LIMIT: "50000", LOAD_FORCE_RECONNECT_AT_SECONDS: "120",
    LOAD_TEACHER_PATHS: "/api/students-aggregated?teachingSessionId={teachingSessionId}",
    LOAD_TILE_HISTORY_PATH: "/api/classpilot/tiles/history", LOAD_TILE_SCREENSHOTS_PATH: "/api/classpilot/tiles/screenshots",
  };
}

test("reliability workloads retain exact 40/500/800 shapes, five-second capture and actual WAF headroom", () => {
  for (const devices of [40, 500, 800]) {
    const profile = validateReliabilityEnvironment(environment(devices), "http://127.0.0.1:4000");
    assert.equal(profile?.classrooms, devices === 40 ? 1 : 20);
    assert.equal(profile!.classrooms * profile!.studentsPerClass, devices);
    assert.equal(profile?.deviceIngestPerFiveMinutes, devices * 90);
    assert.equal(profile?.socketProbeIntervalMs, 10_000);
    assert.equal(profile?.productionAccepted, false);
    assert.equal(profile?.managedDevicesValidated, false);
  }
  assert.equal(reliabilityProfile(800).deviceIngestPerFiveMinutes, 72_000);
  assert.equal(reliabilityProfile(800).deviceIngestPerFiveMinutes * 1.3, 93_600);
  assert.match(RELIABILITY_ENDPOINT_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(RELIABILITY_WORKLOAD_VERSION, 'classpilot-reliability-v3');
  assert.throws(() => validateReliabilityEnvironment({ ...environment(40), LOAD_RELIABILITY_WORKLOAD: 'classpilot-reliability-v1' }, 'http://localhost:4000'), /Unknown reliability workload/);
});

test("all810 device fixtures have independent legal40KiB comments and bounded decoded cache", () => {
  const fixtures = Array.from({ length: 810 }, () => makeReliabilityJpegFixture(baseJpeg));
  const evidence = reliabilityFixtureEvidence(fixtures);
  assert.equal(evidence.version, RELIABILITY_FIXTURE_VERSION);
  assert.equal(evidence.fixtureCount, 810);
  assert.equal(evidence.distinctFixtures, 810);
  assert.equal(evidence.decodedCacheBytes, 810 * 40960);
  assert.equal(evidence.stampReservedBytes, 96);
  for (const fixture of fixtures) {
    assert.equal(fixture.length, 40960);
    const segmentStart = baseJpeg.length - 2;
    assert.equal(fixture.readUInt16BE(segmentStart), 0xfffe);
    assert.equal(segmentStart + 2 + fixture.readUInt16BE(segmentStart + 2), fixture.length - 2);
    assert.deepEqual(fixture.subarray(0, segmentStart), baseJpeg.subarray(0, -2));
    assert.ok(fixture.subarray(-98, -2).every(value => value === 0x4c));
    assert.equal(fixture.readUInt16BE(fixture.length - 2), 0xffd9);
  }
  assert.ok(evidence.cohort.gzipBytes >= evidence.cohort.minimumEncodedBytes);
  assert.ok(evidence.cohort.brotliBytes >= evidence.cohort.minimumEncodedBytes);
  assert.equal(evidence.cohort.decodedJpegBytes, 40 * 40960);
  assert.doesNotMatch(JSON.stringify(evidence), /studentId|deviceId|data:image|base64|sha256|fixture-[0-9]/);
});

test("wire evidence rejects lowentropy, sharedpayload, invalidsize and oversized caches", () => {
  const independent = Array.from({ length: 40 }, () => makeReliabilityJpegFixture(baseJpeg));
  assert.throws(() => reliabilityFixtureEvidence(independent.slice(1)), /40..810/);
  assert.throws(() => reliabilityFixtureEvidence(Array.from({ length: 811 }, () => independent[0]!)), /40..810/);
  assert.throws(() => reliabilityFixtureEvidence(independent.map(() => independent[0]!)), /distinct per device/);
  const almostShared = independent.map((_fixture, index) => {
    const copied = Buffer.from(independent[0]!); copied[baseJpeg.length + 5] = index; return copied;
  });
  assert.throws(() => reliabilityFixtureEvidence(almostShared), /unrealistically compressible/);
  const oldPadding = independent.map((_fixture, index) => {
    const copied = Buffer.from(independent[0]!);
    copied.fill(0x4c, baseJpeg.length + 2, copied.length - 98);
    copied[baseJpeg.length + 5] = index;
    return copied;
  });
  assert.throws(() => reliabilityFixtureEvidence(oldPadding), /unrealistically compressible/, 'Historical repeated padding cannot earnv2 wire credit');
  const wrongSize = [...independent]; wrongSize[0] = wrongSize[0]!.subarray(1);
  assert.throws(() => reliabilityFixtureEvidence(wrongSize), /exact bytes/);
  assert.throws(() => makeReliabilityJpegFixture(Buffer.alloc(40960)), /synthetic base JPEG/);
});

test("capture stamps retain exactsize and entropy without mutating the per-device cached buffer", () => {
  const fixture = makeReliabilityJpegFixture(baseJpeg), before = createHash('sha256').update(fixture).digest('hex');
  const source = 'data:image/jpeg;base64,' + fixture.toString('base64'), at = 1791950000000;
  const first = stampReliabilityFrame(source, at, 1), second = stampReliabilityFrame(source, at + 5000, 2);
  assert.deepEqual(readReliabilityFrame(first), { capturedAt: at, ordinal: 1 });
  assert.deepEqual(readReliabilityFrame(second), { capturedAt: at + 5000, ordinal: 2 });
  const firstBytes = Buffer.from(first.slice('data:image/jpeg;base64,'.length), 'base64');
  assert.equal(firstBytes.length, 40960);
  assert.deepEqual(firstBytes.subarray(0, -98), fixture.subarray(0, -98));
  assert.equal(createHash('sha256').update(fixture).digest('hex'), before);
});

test("capacity evidence requires sustained per-device and per-cohort rates, allowing only bounded warmup and final rounds", () => {
  assert.equal(minimumReliabilitySamples({ durationMs: 5_400_000, intervalMs: 10_000, timeoutMs: 15_000 }), 536);
  assert.equal(minimumReliabilitySamples({ durationMs: 5_400_000, intervalMs: 5_000, warmupMs: 30_000, timeoutMs: 15_000 }), 1069);
  assert.equal(minimumReliabilitySamples({ durationMs: 16_000, intervalMs: 5_000, warmupMs: 12_000, timeoutMs: 2_000, scale: 16_000 / 60_000 }), 6);
});

test("freshness evidence requires an exact current pixel binding", () => {
  assert.equal(reliabilityScreenshotBindingMatches({ bindingVersion: "v2:current", screenshot: { bindingVersion: "v2:current" } }), true);
  assert.equal(reliabilityScreenshotBindingMatches({ bindingVersion: "v3:current", screenshot: { bindingVersion: "v3:current" } }), true);
  for (const tile of [
    { bindingVersion: "v2:current", screenshot: { bindingVersion: "v2:retired" } },
    { bindingVersion: "v2:current", screenshot: {} },
    { screenshot: { bindingVersion: "v2:current" } },
    { screenshot: {} },
    { bindingVersion: "v2:current", screenshot: null },
  ]) assert.equal(reliabilityScreenshotBindingMatches(tile), false);
});

test("new traffic cannot bypass the paused production campaign or masquerade as historical certification", () => {
  for (const target of ["https://school-pilot.net", "https://www.school-pilot.net", "https://api-origin.school-pilot.net", "https://schoolpilot-production-alb.example.test"]) {
    assert.throws(() => validateReliabilityEnvironment(environment(800), target), /Production reliability load is paused/);
  }
  assert.throws(() => validateReliabilityEnvironment({ ...environment(800), LOAD_GATE_PROFILE: "launch" }, "http://localhost:4000"), /historical launch certification/);
  assert.throws(() => validateReliabilityEnvironment({ ...environment(800), LOAD_ENGINEERING_ACCEPTANCE: "true" }, "http://localhost:4000"), /historical acceptance identity/);
  assert.throws(() => validateReliabilityEnvironment({ ...environment(800), LOAD_WAF_DEVICE_LIMIT: "200000" }, "http://localhost:4000"), /LOAD_WAF_DEVICE_LIMIT=100000/);
  assert.throws(() => validateReliabilityEnvironment({ ...environment(800), LOAD_TEACHER_HISTORY_WARMUP_MS: "5390000" }, "http://localhost:4000"), /LOAD_TEACHER_HISTORY_WARMUP_MS=18000/);
  assert.throws(() => validateReliabilityEnvironment({ ...environment(800), LOAD_TEACHER_PATHS: "/api/students-aggregated" }, "http://localhost:4000"), /LOAD_TEACHER_PATHS=/);
  assert.throws(() => validateReliabilityEnvironment(environment(800), "https://unbound.example.test"), /explicitly bound/);
});

test("only explicitly bound staging origins can run and short smoke evidence is loopback-only", () => {
  const origin = "https://reliability-staging.example.test";
  assert.ok(validateReliabilityEnvironment({ ...environment(500), LOAD_RELIABILITY_STAGING_ORIGIN: origin }, origin));
  const documentedStaging = 'https://staging.school-pilot.net';
  assert.ok(validateReliabilityEnvironment({ ...environment(500), LOAD_RELIABILITY_STAGING_ORIGIN: documentedStaging }, documentedStaging));
  const smoke = { ...environment(40), LOAD_RELIABILITY_SMOKE: "true", LOAD_DURATION_SECONDS: "60" };
  assert.equal(validateReliabilityEnvironment(smoke, "http://127.0.0.1:4000")?.smoke, true);
  assert.throws(() => validateReliabilityEnvironment({ ...smoke, LOAD_RELIABILITY_STAGING_ORIGIN: origin }, origin), /loopback-only/);
  assert.throws(() => validateReliabilityEnvironment({ ...environment(800), LOAD_SCREENSHOT_INTERVAL_MS: "30000" }, "http://localhost:4000"), /LOAD_SCREENSHOT_INTERVAL_MS=5000/);
  assert.equal(validateReliabilityEnvironment({}, "http://localhost:4000"), null, "Legacy workloads are unchanged");
});
