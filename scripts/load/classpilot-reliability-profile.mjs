import { createHash } from 'node:crypto';

export const RELIABILITY_WORKLOAD_VERSION = 'classpilot-reliability-v1';
export const RELIABILITY_ENDPOINT_SHAPE = `${RELIABILITY_WORKLOAD_VERSION}|GET /api/students-aggregated?teachingSessionId=:id|POST /api/classpilot/tiles/screenshots studentIds[1..50] teachingSessionId|POST /api/classpilot/tiles/history studentIds[1..50] teachingSessionId limit[1..10]|PUT /api/classpilot/teaching-sessions/:id/observation-lease|transport-probe-v1`;
export const RELIABILITY_ENDPOINT_SHA256 = createHash('sha256').update(RELIABILITY_ENDPOINT_SHAPE).digest('hex');
export const RELIABILITY_CAPABILITIES = Object.freeze([
  'scopedAuthorityChecksV1', 'screenshotObservationLeaseV1',
  'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1',
]);

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
