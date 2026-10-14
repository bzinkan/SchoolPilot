import { createHash, randomFillSync } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

export const RELIABILITY_WORKLOAD_VERSION = 'classpilot-reliability-v2';
export const RELIABILITY_FIXTURE_VERSION = 'per-device-high-entropy-jpeg-40k-v2';
export const RELIABILITY_ENDPOINT_SHAPE = `${RELIABILITY_WORKLOAD_VERSION}|GET /api/students-aggregated?teachingSessionId=:id|POST /api/classpilot/tiles/screenshots studentIds[1..50] teachingSessionId|POST /api/classpilot/tiles/history studentIds[1..50] teachingSessionId limit[1..10]|PUT /api/classpilot/teaching-sessions/:id/observation-lease|transport-probe-v1|initial-concurrent-class-command-burst|unique-capture-frame-v1|${RELIABILITY_FIXTURE_VERSION}`;
export const RELIABILITY_ENDPOINT_SHA256 = createHash('sha256').update(RELIABILITY_ENDPOINT_SHAPE).digest('hex');
export const RELIABILITY_CAPABILITIES = Object.freeze([
  'scopedAuthorityChecksV1', 'screenshotObservationLeaseV1',
  'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1',
]);

const FIXTURE_BYTES = 40 * 1024, MAX_FIXTURES = 810, STAMP_BYTES = 96;
const JPEG_PREFIX = 'data:image/jpeg;base64,';

// COM payload bytes may contain arbitrary binary data: the segment's length
// delimits them. Independent randomness per device defeats cohort compression;
// only the existing96-byte capture-stamp tail remains predictable.
export function makeReliabilityJpegFixture(baseJpeg) {
  if (!Buffer.isBuffer(baseJpeg) || baseJpeg.length < 4 || baseJpeg[0] !== 255 || baseJpeg[1] !== 216
    || baseJpeg.at(-2) !== 255 || baseJpeg.at(-1) !== 217) throw new Error('A valid synthetic base JPEG is required');
  const extra = FIXTURE_BYTES - baseJpeg.length;
  if (extra < STAMP_BYTES + 5 || extra > 65537) throw new Error('Base JPEG cannot fit the fixed40KiB reliability fixture');
  const comment = Buffer.allocUnsafe(extra);
  comment[0] = 255; comment[1] = 254; comment.writeUInt16BE(extra - 2, 2);
  randomFillSync(comment, 4, extra - 4 - STAMP_BYTES);
  comment.fill(0x4c, extra - STAMP_BYTES);
  return Buffer.concat([baseJpeg.subarray(0, -2), comment, baseJpeg.subarray(-2)], FIXTURE_BYTES);
}

// This is aggregate synthetic-wire evidence, never frame contents, target IDs,
// or per-device hashes. It runs once before traffic, not on the capture hot path.
export function reliabilityFixtureEvidence(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length < 40 || fixtures.length > MAX_FIXTURES) throw new Error('Reliability fixture cache requires40..810 devices');
  const hashes = new Set();
  for (const fixture of fixtures) {
    if (!Buffer.isBuffer(fixture) || fixture.length !== FIXTURE_BYTES || fixture[0] !== 255 || fixture[1] !== 216
      || fixture.at(-2) !== 255 || fixture.at(-1) !== 217
      || !fixture.subarray(-98, -2).every(byte => byte === 0x4c)) throw new Error('Reliability fixture must retain exact bytes and capture-stamp padding');
    hashes.add(createHash('sha256').update(fixture).digest('hex'));
  }
  if (hashes.size !== fixtures.length) throw new Error('Reliability fixtures must be distinct per device');
  const cohort = fixtures.slice(0, 40), decodedJpegBytes = cohort.length * FIXTURE_BYTES;
  // Fixed synthetic metadata models the batched dataURL envelope without
  // introducing any actual student/device/binding values into the evidence.
  const body = Buffer.from(JSON.stringify({ tiles: cohort.map(fixture => ({ bindingVersion: 'v2:synthetic',
    screenshot: { bindingVersion: 'v2:synthetic', screenshot: JPEG_PREFIX + fixture.toString('base64') } })) }));
  const gzipBytes = gzipSync(body).length;
  const brotliBytes = brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }).length;
  const minimumEncodedBytes = Math.ceil(decodedJpegBytes * 0.95);
  if (gzipBytes < minimumEncodedBytes || brotliBytes < minimumEncodedBytes) throw new Error('Reliability cohort payload is unrealistically compressible');
  return { version: RELIABILITY_FIXTURE_VERSION, fixtureCount: fixtures.length, distinctFixtures: hashes.size,
    bytesPerFixture: FIXTURE_BYTES, decodedCacheBytes: fixtures.length * FIXTURE_BYTES, stampReservedBytes: STAMP_BYTES,
    cohort: { devices: cohort.length, decodedJpegBytes, jsonBytes: body.length, gzipBytes, brotliBytes,
      brotliQuality: 4, minimumEncodedBytes, minimumEncodedToDecodedRatio: 0.95,
      gzipEncodedToDecodedRatio: gzipBytes / decodedJpegBytes, brotliEncodedToDecodedRatio: brotliBytes / decodedJpegBytes } };
}

// Allow one deadline-truncated round, not a generator that silently underloads
// a fleet. Test acceleration changes timer cadence only on loopback.
export function minimumReliabilitySamples({ durationMs, intervalMs, warmupMs = 0, spreadMs = intervalMs, timeoutMs, scale = 1 }) {
  return Math.max(1, Math.floor((durationMs - (warmupMs + spreadMs) * scale - timeoutMs) / (intervalMs * scale)) - 1);
}

// Capacity evidence counts only pixels the dashboard's exact-binding fence
// would accept. An HTTP200 with retired or unbound pixels is not freshness.
export function reliabilityScreenshotBindingMatches(tile) {
  return typeof tile?.bindingVersion === 'string' && /^v\d+:/.test(tile.bindingVersion)
    && tile.screenshot?.bindingVersion === tile.bindingVersion;
}

export function reliabilityProfile(primaryDevices) {
  if (![40, 500, 800].includes(primaryDevices)) throw new Error('Reliability profile must contain 40, 500 or 800 primary devices');
  const classrooms = primaryDevices === 40 ? 1 : 20;
  return Object.freeze({
    version: RELIABILITY_WORKLOAD_VERSION,
    primaryDevices, canaryDevices: 10, classrooms,
    studentsPerClass: primaryDevices / classrooms,
    durationSeconds: primaryDevices === 40 ? 600 : primaryDevices === 500 ? 1800 : 5400,
    heartbeatIntervalMs: 10_000, screenshotIntervalMs: 5_000,
    screenshotReadIntervalMs: 5_000, historyReadIntervalMs: 30_000,
    socketProbeIntervalMs: 10_000,
    deviceIngestPerFiveMinutes: primaryDevices * 90,
    deviceIngestLimit: 100_000, generalApiLimit: 50_000,
    screenshotBytes: 40 * 1024,
  });
}

/** This new workload cannot silently become evidence for a historical campaign. */
export function validateReliabilityEnvironment(env, target) {
  const version = env.LOAD_RELIABILITY_WORKLOAD || '';
  if (!version) return null;
  if (version !== RELIABILITY_WORKLOAD_VERSION) throw new Error('Unknown reliability workload version');
  const url = new URL(target);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (['school-pilot.net', 'www.school-pilot.net', 'api-origin.school-pilot.net'].includes(url.hostname)
    || url.hostname.includes('schoolpilot-production')) {
    throw new Error('Production reliability load is paused; a new reviewed campaign is required');
  }
  if (!loopback && (url.protocol !== 'https:' || env.LOAD_RELIABILITY_STAGING_ORIGIN !== url.origin)) {
    throw new Error('Reliability traffic requires loopback or an explicitly bound HTTPS staging origin');
  }
  if (env.LOAD_GATE_PROFILE !== 'partial' || env.LOAD_ENFORCE_THRESHOLDS !== 'true') {
    throw new Error('Reliability uses enforced partial evidence, never historical launch certification');
  }
  const profile = reliabilityProfile(Number(env.LOAD_RELIABILITY_DEVICE_COUNT));
  const expected = {
    LOAD_WORKLOAD_SCHEMA_VERSION: RELIABILITY_WORKLOAD_VERSION,
    LOAD_DEVICE_COUNT: String(profile.primaryDevices + profile.canaryDevices),
    LOAD_HEARTBEAT_INTERVAL_MS: '10000', LOAD_SCREENSHOT_INTERVAL_MS: '5000',
    LOAD_SCREENSHOT_GET_INTERVAL_MS: '5000', LOAD_HISTORY_INTERVAL_MS: '30000',
    LOAD_REQUEST_TIMEOUT_MS: '8000', LOAD_WS_AUTH_TIMEOUT_MS: '5000',
    LOAD_TEACHER_HISTORY_WARMUP_MS: '18000', LOAD_SCREENSHOT_GET_WARMUP_MS: '13000',
    LOAD_COMMAND_WARMUP_MS: '30000',
    LOAD_SCREENSHOT_BYTES: String(profile.screenshotBytes),
    LOAD_EXPECTED_CLASS_BODIES: String(profile.classrooms),
    LOAD_EXPECTED_TARGETS_PER_CLASS: String(profile.studentsPerClass),
    LOAD_EXPECTED_CANARY_DEVICES: '10', LOAD_WAF_DEVICE_LIMIT: '100000', LOAD_WAF_GENERAL_LIMIT: '50000',
    LOAD_TEACHER_PATHS: '/api/students-aggregated?teachingSessionId={teachingSessionId}',
    LOAD_TILE_HISTORY_PATH: '/api/classpilot/tiles/history', LOAD_TILE_SCREENSHOTS_PATH: '/api/classpilot/tiles/screenshots',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) throw new Error(`Reliability profile requires ${key}=${value}`);
  }
  const smoke = env.LOAD_RELIABILITY_SMOKE === 'true';
  if (smoke && !loopback) throw new Error('Short reliability smoke runs are loopback-only');
  if (Number(env.LOAD_DURATION_SECONDS) !== (smoke ? 60 : profile.durationSeconds)) {
    throw new Error('Reliability duration does not match the selected workload');
  }
  if (!Number(env.LOAD_FORCE_RECONNECT_AT_SECONDS)) throw new Error('Reliability requires a forced reconnect wave');
  if (env.LOAD_ENGINEERING_ACCEPTANCE === 'true' || env.LOAD_DIAGNOSTIC_ONLY === 'true') {
    throw new Error('Reliability cannot reuse a historical acceptance identity');
  }
  return { ...profile, smoke, productionAccepted: false, managedDevicesValidated: false };
}
