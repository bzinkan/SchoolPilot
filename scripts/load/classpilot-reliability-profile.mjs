import { createHash, randomFillSync, randomBytes } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

export const RELIABILITY_WORKLOAD_VERSION = 'classpilot-reliability-v3';
export const RELIABILITY_FIXTURE_VERSION = 'per-device-high-entropy-three-color-jpeg-40k-v3';
export const RELIABILITY_ENDPOINT_SHAPE = `${RELIABILITY_WORKLOAD_VERSION}|GET /api/students-aggregated?teachingSessionId=:id|POST /api/classpilot/tiles/screenshots studentIds[1..50] teachingSessionId|POST /api/classpilot/tiles/history studentIds[1..50] teachingSessionId limit[1..10]|PUT /api/classpilot/teaching-sessions/:id/observation-lease|transport-probe-v1|initial-concurrent-class-command-burst|causal-capture-frame-v2|controller-monotonic-navigation-v1|${RELIABILITY_FIXTURE_VERSION}`;
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
    screenshotBytes: 40 * 1024, measurementPlan: measurementPlan(primaryDevices),
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

// Private design prototype only. No AWS client, network, application imports,
// credential reads, authority mutation, or runtime installation is included.


export const NAVIGATION_LIMITS = Object.freeze({ controlBytes: 4096, readMs: 250,
  pollMs: 100, roundReadWindowMs: 3000, controlTtlMs: 10_000,
  regularHeartbeatMs: 10_000, eventCoalesceMs: 2000, eventPeriodMs: 60_000,
  p95UpperMs: 3000, p99UpperMs: 5000 });
const origin = 'https://staging.school-pilot.net';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireCondition(condition, message) { if (!condition) throw Error(message); }

export function navigationSnapshot(control, publicBinding, revisionBase) {
  requireCondition(typeof publicBinding === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(publicBinding), 'Exact public binding required');
  requireCondition(Number.isSafeInteger(revisionBase) && revisionBase >= 0 && Number.isSafeInteger(revisionBase + control.round), 'Verified surviving tab revision baseline required');
  const marker = createHash('sha256').update('classpilot-navigation-probe:v1\0')
    .update(control.runId).update('\0').update(control.nonce).update('\0').update(publicBinding).digest('hex').slice(0, 24);
  const domain = control.round % 2 ? 'docs.google.com' : 'classroom.google.com';
  const title = `ClassPilot navigation ${marker}`;
  const url = `https://${domain}/load/navigation/${marker}`;
  const tabRef = `navigation-${marker}`;
  // One already-served, self-origin reviewed SVG alternates with the existing
  // placeholder. Data/favicon schemes rejected by the actual UI are not used.
  const favicon = control.round % 2 ? `${origin}/favicon.svg` : undefined;
  return Object.freeze({ marker, hostname: domain, activeTabTitle: title, activeTabUrl: url,
    activeTabRef: tabRef, tabSnapshotRevision: revisionBase + control.round,
    allOpenTabs: [Object.freeze({ tabRef, title, url, ...(favicon ? { favicon } : {}) })], favicon });
}

// readComplete must encompass SDK headers AND bounded body consumption. Its
// adapter uses maxAttempts=1 and reports raw SDK attempts separately. A caller
// timeout fences this read; late settlement releases its guard but cannot emit
// telemetry. The guard is retained if an abort does not actually settle.
export class BoundedControlReader {
  constructor(readComplete, { timeoutMs = NAVIGATION_LIMITS.readMs, maximumBytes = NAVIGATION_LIMITS.controlBytes } = {}) {
    this.readComplete = readComplete; this.timeoutMs = timeoutMs; this.maximumBytes = maximumBytes; this.active = null;
    this.counters = { attempts: 0, timeouts: 0, busy: 0, lateSettlements: 0 };
  }
  async read(key) {
    if (this.active) { this.counters.busy += 1;
      throw Object.assign(Error('Navigation control read still settling'), { measurementReadCode: 'busy' }); }
    const controller = new AbortController(); let timer, fenced = false;
    this.counters.attempts += 1;
    const underlying = Promise.resolve().then(() => this.readComplete(key, { signal: controller.signal }));
    this.active = underlying;
    const release = () => { if (fenced) this.counters.lateSettlements += 1;
      if (this.active === underlying) this.active = null; };
    underlying.then(release, release);
    try {
      const bytes = await Promise.race([underlying, new Promise((_, reject) => {
        timer = setTimeout(() => { fenced = true; this.counters.timeouts += 1; controller.abort();
          reject(Object.assign(Error('Navigation control full-body deadline'), { measurementReadCode: 'deadline' })); }, this.timeoutMs);
      })]);
      requireCondition(!fenced && Buffer.isBuffer(bytes) && bytes.length <= this.maximumBytes,
        'Exact bounded control bytes required');
      return JSON.parse(bytes.toString('utf8'));
    } finally { clearTimeout(timer); }
  }
}

// Adapter invokes regular() from the unchanged absolute ten-second timer.
// Every old, event and regular request uses this ONE writer for its exact
// authenticated device binding. snapshot() is queried at dispatch, never at
// event receipt. No second browser heartbeat writer exists.
export class SerialHeartbeatWriter {
  constructor({ now, schedule, clear, send, snapshot, cooldownUntil = () => 0, identity = () => null }) {
    Object.assign(this, { now, schedule, clear, send, snapshot, cooldownUntil, identity });
    this.scope = identity(); this.scopeEpoch = 0;
    this.generation = 0; this.pendingEvent = false; this.regularPending = false;
    this.active = false; this.timer = null; this.eventDue = Infinity; this.denied = false;
    this.counters = { started: 0, eventRequests: 0, regularRequests: 0, failed: 0, denied: 0 };
  }
  synchronizeIdentity() {
    const scope = this.identity();
    if (!Object.is(scope, this.scope)) {
      this.scope = scope; this.scopeEpoch += 1; this.pendingEvent = false; this.regularPending = false;
      this.eventDue = Infinity; this.denied = false;
      if (this.timer !== null) { this.clear(this.timer); this.timer = null; }
    }
    return scope;
  }
  hold() { this.held = true; }
  release() { this.held = false; this.pump(); }
  regular() { this.synchronizeIdentity(); this.regularPending = true; this.pump(); }
  navigation() { this.synchronizeIdentity(); this.generation += 1;
    if (!this.pendingEvent) this.eventDue = this.now() + NAVIGATION_LIMITS.eventCoalesceMs;
    this.pendingEvent = true; this.pump(); }
  pump() {
    this.synchronizeIdentity();
    if (this.denied || this.active || this.held) return;
    if (this.timer !== null) { this.clear(this.timer); this.timer = null; }
    if (!this.regularPending && !this.pendingEvent) return;
    const now = this.now(), availableAt = Math.max(this.cooldownUntil(), this.regularPending ? now : this.eventDue);
    if (availableAt > now) { this.timer = this.schedule(() => { this.timer = null; this.pump(); }, availableAt - now); return; }
    const generation = this.generation, scope = this.scope, scopeEpoch = this.scopeEpoch, reason = this.regularPending ? 'regular' : 'navigation';
    this.active = true; this.regularPending = false;
    if (this.pendingEvent && this.eventDue <= now) { this.pendingEvent = false; this.eventDue = Infinity; }
    Promise.resolve().then(() => {
      if (!Object.is(this.synchronizeIdentity(), scope) || this.scopeEpoch !== scopeEpoch) return;
      const freshBody = this.snapshot();
      if (!Object.is(this.synchronizeIdentity(), scope) || this.scopeEpoch !== scopeEpoch) return;
      this.counters.started += 1; this.counters[reason === 'regular' ? 'regularRequests' : 'eventRequests'] += 1;
      return this.send(freshBody, { generation, reason });
    }).then(result => {
      if (!Object.is(this.synchronizeIdentity(), scope) || this.scopeEpoch !== scopeEpoch) return;
      if (result?.denied) { this.denied = true; this.counters.denied += 1; return; }
      if (!result?.ok) this.counters.failed += 1;
    }, () => { if (Object.is(this.synchronizeIdentity(), scope) && this.scopeEpoch === scopeEpoch) this.counters.failed += 1; })
      .finally(() => { this.active = false; this.pump(); });
  }
}

export function navigationGate(samples, { planned, primaryDevices, observedDevices, scopeErrors = 0,
  generationRegressions = 0, clockErrors = 0 } = {}) {
  const bounds = [1000, 2000, 3000, 5000, 8000, Infinity], counts = bounds.map(() => 0);
  for (const sample of samples) {
    requireCondition(sample === Infinity || Number.isFinite(sample) && sample >= 0, 'Invalid navigation sample');
    counts[bounds.findIndex(bound => sample <= bound)] += 1;
  }
  const missing = Math.max(0, planned - samples.length); counts[counts.length - 1] += missing;
  const percentile = percent => { let cumulative = 0; for (let i = 0; i < counts.length; i += 1) {
    cumulative += counts[i]; if (cumulative >= Math.ceil(planned * percent / 100)) return bounds[i];
  } return Infinity; };
  const complete = Number.isSafeInteger(planned) && planned > 0 && samples.length === planned
    && samples.every(Number.isFinite) && observedDevices === primaryDevices
    && scopeErrors === 0 && generationRegressions === 0 && clockErrors === 0;
  const p95 = percentile(95), p99 = percentile(99);
  return { version: 'causal-trigger-to-painted-tab-upper-bound-v1', required: true,
    complete, planned, observed: samples.length, missing, primaryDevices, observedDevices,
    boundsMs: bounds.map(x => Number.isFinite(x) ? x : null), counts,
    p95UpperMs: Number.isFinite(p95) ? p95 : null, p99UpperMs: Number.isFinite(p99) ? p99 : null,
    passed: complete && p95 <= NAVIGATION_LIMITS.p95UpperMs && p99 <= NAVIGATION_LIMITS.p99UpperMs };
}

// Private causal-capture prototype. Built-ins only; no network or app imports.


const causalJpegPrefix = 'data:image/jpeg;base64,';
const fixedBytes = 40960, stampBytes = 96;
const captureControlKeys = 'campaign,candidateApiImage,cohortSha256,kind,lifetimeMs,navigationNonce,navigationRound,nonce,planSha256,primaryDevices,pulseSequence,revisionBaselinesSha256,revisionDrainNonce,runId,schemaVersion,scriptBundleSha256,sourceArtifactSha256';
const requireCaptureCondition = (condition, message) => { if (!condition) throw Error(message); };
const captureSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateCapturePulse(value, expected) {
  requireCaptureCondition(expected.account === '135775632425' && expected.bucket === 'schoolpilot-staging-load-135775632425'
    && expected.origin === 'https://staging.school-pilot.net', 'Exact isolated pulse context required');
  requireCaptureCondition(Object.keys(value ?? {}).sort().join(',') === captureControlKeys && value.schemaVersion === 1
    && value.kind === 'classpilot-measurement-control-v3', 'Strict content-free capture pulse schema required');
  requireCaptureCondition(value.campaign === expected.campaign && /^classpilot-staging-\d{8}-[a-f0-9]{12}$/.test(value.campaign)
    && value.runId === expected.runId && new RegExp(`^${expected.primaryDevices}-[a-f0-9]{16}$`).test(value.runId)
    && value.primaryDevices === expected.primaryDevices && [40, 500, 800].includes(value.primaryDevices),
  'Exact active run and primary cohort required');
  for (const name of ['sourceArtifactSha256', 'scriptBundleSha256', 'cohortSha256', 'planSha256'])
    requireCaptureCondition(captureSha(value[name]) && value[name] === expected[name], 'Exact source/closure/cohort pulse binding required');
  requireCaptureCondition(value.candidateApiImage === expected.candidateApiImage
    && /^135775632425\.dkr\.ecr\.us-east-1\.amazonaws\.com\/schoolpilot-staging-api@sha256:[a-f0-9]{64}$/.test(value.candidateApiImage),
  'Exact isolated candidate image required');
  requireCaptureCondition(Number.isSafeInteger(value.pulseSequence) && value.pulseSequence > 0 && value.pulseSequence <= expected.maximumPulses
    && /^[a-f0-9]{48}$/.test(value.nonce) && value.lifetimeMs === 20000, 'Bounded ordinal/nonce/lifetime required');
  requireCaptureCondition(Number.isSafeInteger(value.navigationRound) && value.navigationRound >= 0
    && value.navigationRound <= expected.maximumNavigationRounds
    && (value.navigationRound === 0 ? value.navigationNonce === null : /^[a-f0-9]{48}$/.test(value.navigationNonce))
    && (value.revisionBaselinesSha256 === null || captureSha(value.revisionBaselinesSha256)), 'Exact navigation generation and bootstrap digest required');
  requireCaptureCondition(value.revisionDrainNonce === null || /^[a-f0-9]{48}$/.test(value.revisionDrainNonce), 'Bounded revision drain nonce required');
  return Object.freeze({ ...value });
}

export function capturePulseMarker(pulse, publicBinding) {
  requireCaptureCondition(typeof publicBinding === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(publicBinding), 'Exact public binding required');
  return createHash('sha256').update('classpilot-capture-pulse:v1\0').update(pulse.runId).update('\0')
    .update(String(pulse.pulseSequence)).update('\0').update(pulse.nonce).update('\0').update(publicBinding)
    .digest('hex').slice(0, 24);
}

// This object is owned by the SAME rendered-driver/controller Node process
// that observes Chrome IPC. Store only its own monotonic t0; never import the
// producer or browser-page performance origin. issue() records t0 BEFORE RNG.
export class CapturePulseController {
  constructor(expected, { now, nonce = () => randomBytes(24).toString('hex'), maximumHistory = 32 } = {}) {
    Object.assign(this, { expected, now, nonce, maximumHistory }); this.sequence = 0; this.history = new Map(); this.revisionDrainNonce = null; this.navigationRound = 0; this.navigationNonce = null; this.navigationHistory = new Map();this.nonces=new Set();
  }
  issue({ navigationRound = this.navigationRound, revisionBaselinesSha256 = null, revisionDrainNonce = this.revisionDrainNonce } = {}) {
    const t0 = this.now(); requireCaptureCondition(Number.isFinite(t0), 'Controller monotonic clock required');
    const freshNonce = this.nonce();
    requireCaptureCondition(/^[a-f0-9]{48}$/.test(freshNonce)&&!this.nonces.has(freshNonce),'Fresh unpredictable capture nonce required');
    requireCaptureCondition(this.sequence<measurementPlan(this.expected.primaryDevices).maximumPulses,'Bounded campaign pulse count exceeded');
    this.nonces.add(freshNonce);this.revisionDrainNonce = revisionDrainNonce;
    requireCaptureCondition(navigationRound === this.navigationRound || navigationRound === this.navigationRound + 1, 'Exact next navigation generation required');
    if (navigationRound > this.navigationRound) {
      requireCaptureCondition(captureSha(revisionBaselinesSha256), 'Navigation requires verified revision bootstrap');
      this.navigationRound = navigationRound; this.navigationNonce = freshNonce;
      this.navigationHistory.set(navigationRound, { t0, nonce: freshNonce });
      while (this.navigationHistory.size > 4) this.navigationHistory.delete(this.navigationHistory.keys().next().value);
    }
    const value = validateCapturePulse({ schemaVersion: 1, kind: 'classpilot-measurement-control-v3',
      campaign: this.expected.campaign, runId: this.expected.runId, primaryDevices: this.expected.primaryDevices,
      sourceArtifactSha256: this.expected.sourceArtifactSha256, scriptBundleSha256: this.expected.scriptBundleSha256,
      cohortSha256: this.expected.cohortSha256, candidateApiImage: this.expected.candidateApiImage,
      pulseSequence: ++this.sequence, nonce: freshNonce, lifetimeMs: 20000,
      navigationRound: this.navigationRound, navigationNonce: this.navigationNonce, revisionBaselinesSha256, revisionDrainNonce, planSha256: this.expected.planSha256 }, this.expected);
    this.prune(t0); this.history.set(value.pulseSequence, { value, t0 });
    while (this.history.size > this.maximumHistory) this.history.delete(this.history.keys().next().value);
    return value;
  }
  prune(now = this.now()) {
    for (const [sequence, entry] of this.history) if (now - entry.t0 > entry.value.lifetimeMs) this.history.delete(sequence);
  }
  ageUpper(frame, publicBinding, observedAt = this.now()) {
    requireCaptureCondition(Number.isFinite(observedAt), 'Controller observation monotonic clock required');
    this.prune(observedAt); const entry = this.history.get(frame?.pulseSequence);
    requireCaptureCondition(entry && frame.pulseMarker === capturePulseMarker(entry.value, publicBinding),
      'Unknown, expired, foreign-run or different-binding frame cannot establish capture age');
    requireCaptureCondition(observedAt >= entry.t0 && observedAt - entry.t0 <= entry.value.lifetimeMs,
      'Capture challenge expired or controller clock moved backward');
    return observedAt - entry.t0;
  }
}

// No capture cadence is scheduled here: the existing5s active /30s background
// producer invokes markerForCapture from its unchanged timer. The producer
// holds one latest pulse only; this is not a frame or command replay queue.
export class CapturePulseProducer {
  constructor(expected, now) { Object.assign(this, { expected, now }); this.latest = null; this.adoptedAt = 0; }
  adopt(value) {
    const pulse = validateCapturePulse(value, this.expected);
    requireCaptureCondition(!this.latest || pulse.pulseSequence > this.latest.pulseSequence,
      'Capture pulse replay or ordering regression');
    this.latest = pulse; this.adoptedAt = this.now(); return pulse;
  }
  markerForCapture(publicBinding) {
    requireCaptureCondition(this.latest && this.now() >= this.adoptedAt
      && this.now() - this.adoptedAt <= this.latest.lifetimeMs, 'No live adopted capture pulse');
    return { pulseSequence: this.latest.pulseSequence, pulseMarker: capturePulseMarker(this.latest, publicBinding) };
  }
}

export function stampCausalCapture(fixture, capturedAtWall, frameOrdinal, marker) {
  requireCaptureCondition(Buffer.isBuffer(fixture) && fixture.length === fixedBytes
    && fixture[0] === 255 && fixture[1] === 216 && fixture.at(-2) === 255 && fixture.at(-1) === 217
    && fixture.subarray(-98, -2).every(byte => byte === 0x4c), 'Exact immutable40KiB fixture with its reserved COM tail required');
  requireCaptureCondition(Number.isSafeInteger(capturedAtWall) && String(capturedAtWall).length === 13
    && Number.isSafeInteger(frameOrdinal) && frameOrdinal > 0
    && Number.isSafeInteger(marker.pulseSequence) && marker.pulseSequence > 0 && /^[a-f0-9]{24}$/.test(marker.pulseMarker),
  'Bounded capture/frame/pulse stamp required');
  const text = `CLP_REL_FRAME_V2:${capturedAtWall}:${frameOrdinal}:${marker.pulseSequence}:${marker.pulseMarker}:END`;
  requireCaptureCondition(Buffer.byteLength(text) <= stampBytes, 'Capture stamp exceeds existing96-byte reservation');
  const bytes = Buffer.from(fixture); bytes.fill(0x4c, bytes.length - 98, bytes.length - 2);
  bytes.write(text, bytes.length - 98, 'ascii'); return causalJpegPrefix + bytes.toString('base64');
}

export function readCausalCapture(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(causalJpegPrefix)) return null;
  const bytes = Buffer.from(dataUrl.slice(causalJpegPrefix.length), 'base64');
  if (bytes.length !== fixedBytes || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
  const match = /^CLP_REL_FRAME_V2:(\d{13}):(\d{1,16}):(\d{1,7}):([a-f0-9]{24}):END/.exec(bytes.subarray(-98, -2).toString('ascii'));
  if (!match) return null;
  const [capturedAt, frameOrdinal, pulseSequence] = match.slice(1, 4).map(Number);
  if (![capturedAt, frameOrdinal, pulseSequence].every(Number.isSafeInteger) || frameOrdinal < 1 || pulseSequence < 1) return null;
  return { capturedAt, frameOrdinal, pulseSequence, pulseMarker: match[4] };
}

// All telemetry below is synthetic measurement state, never command authority.
export const MEASUREMENT_LIMITS = Object.freeze({ pollMs: 100, readMs: 250,
  pulseMs: 1000, lifetimeMs: 20000, controlBytes: 4096, bootstrapBytes: 128 * 1024,
  navigationStartMs: 180000, navigationPeriodMs: 60000, navigationDeadlineMs: 5000,
  baselineDeadlineMs: 45000, baselineFreshMs: 15000 });
export function measurementPlan(count) {
  const seconds = count === 40 ? 600 : count === 500 ? 1800 : count === 800 ? 5400 : 0;
  requireCondition(seconds > 0, 'Exact V3 profile required');
  return Object.freeze({ version: 'classpilot-measurement-v3', pulseIntervalMs: MEASUREMENT_LIMITS.pulseMs,
    controlPollMs: MEASUREMENT_LIMITS.pollMs, controlReadMs: MEASUREMENT_LIMITS.readMs,
    lifetimeMs: MEASUREMENT_LIMITS.lifetimeMs, navigationStartMs: MEASUREMENT_LIMITS.navigationStartMs,
    navigationPeriodMs: MEASUREMENT_LIMITS.navigationPeriodMs,
    navigationRounds: Math.floor((seconds * 1000 - 30000 - MEASUREMENT_LIMITS.navigationStartMs) / MEASUREMENT_LIMITS.navigationPeriodMs) + 1,
    maximumPulses: seconds + 2, timingBasis: 'one-rendered-controller-monotonic-causal-upper-bound',
    revisionContinuity: 'observed-exact-bound-current-state-bootstrap', compositorWitness: 'decoded-source-and-native-page-pixels' });
}
export function measurementPlanDigest(count) { return createHash('sha256').update(JSON.stringify(measurementPlan(count))).digest('hex'); }
export function validateMeasurementPlan(value, count, digest) {
  requireCondition(JSON.stringify(value) === JSON.stringify(measurementPlan(count)) && digest === measurementPlanDigest(count), 'Exact immutable V3 measurement plan required');
  return value;
}
export function measurementExpected(manifest, sourceArtifactSha256) {
  validateMeasurementPlan(manifest.measurementPlan, manifest.primaryDevices, manifest.measurementPlanSha256);
  requireCondition(sha(sourceArtifactSha256) && sha(manifest.files?.devices?.sha256), 'Exact input and cohort digests required');
  return { account: '135775632425', bucket: 'schoolpilot-staging-load-135775632425', origin,
    campaign: manifest.campaign, runId: manifest.runId, primaryDevices: manifest.primaryDevices,
    candidateApiImage: manifest.candidateApiImage, scriptBundleSha256: manifest.scriptBundleSha256,
    sourceArtifactSha256, cohortSha256: manifest.files.devices.sha256, planSha256: manifest.measurementPlanSha256,
    maximumPulses: manifest.measurementPlan.maximumPulses, maximumNavigationRounds: manifest.measurementPlan.navigationRounds };
}

const startupUtc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const startupIdentityKeys = ['campaign', 'runId', 'primaryDevices', 'candidateApiImage', 'scriptBundleSha256',
  'sourceArtifactSha256', 'cohortSha256', 'planSha256'];
const startupIdentity = expected => Object.fromEntries(startupIdentityKeys.map(key => [key, expected[key]]));
const startupExpires = (expected, startAt, mode) => new Date(Date.parse(startAt)
  + (mode === 'channel-preflight' ? 60 : reliabilityProfile(expected.primaryDevices).durationSeconds + 60) * 1000).toISOString();

export function measurementWaiting(expected, { startAt, mode = 'workload', nonce = randomBytes(24).toString('hex'),
  createdAt = new Date().toISOString() } = {}) {
  return validateMeasurementWaiting({ schemaVersion: 1, kind: 'classpilot-measurement-waiting-v1',
    ...startupIdentity(expected), startAt, expiresAt: startupExpires(expected, startAt, mode), createdAt, mode, nonce,
    startupOnly: true, trafficStarted: false, capacityAcceptance: false }, expected, { startAt, mode });
}

export function validateMeasurementWaiting(value, expected, { startAt, mode = 'workload', now = Date.now() } = {}) {
  const keys = ['schemaVersion', 'kind', ...startupIdentityKeys, 'startAt', 'expiresAt', 'createdAt', 'mode', 'nonce',
    'startupOnly', 'trafficStarted', 'capacityAcceptance'].sort().join(',');
  requireCondition(Object.keys(value ?? {}).sort().join(',') === keys && value.schemaVersion === 1
    && value.kind === 'classpilot-measurement-waiting-v1' && ['workload', 'channel-preflight'].includes(mode)
    && value.mode === mode && startupUtc(startAt) && value.startAt === startAt && startupUtc(value.createdAt)
    && value.expiresAt === startupExpires(expected, startAt, mode) && typeof value.nonce === 'string'
    && /^[a-f0-9]{48}$/.test(value.nonce) && value.startupOnly === true && value.trafficStarted === false
    && value.capacityAcceptance === false && Number.isFinite(now) && Date.parse(value.createdAt) <= now + 1000
    && Date.parse(value.createdAt) < Date.parse(startAt) && Date.parse(startAt) - Date.parse(value.createdAt) <= 300_000
    && now < Date.parse(value.expiresAt), 'Exact finite waiting control required');
  for (const key of startupIdentityKeys) requireCondition(value[key] === expected[key], 'Waiting control artifact identity changed');
  return value;
}

export function measurementPendingSignal(expected, waiting, name) {
  requireCondition(['started', 'drained'].includes(name), 'Fixed pending signal required');
  return { schemaVersion: 1, kind: 'classpilot-measurement-pending-v1', ...startupIdentity(expected),
    signal: name, pending: true, waitingSha256: createHash('sha256').update(JSON.stringify(waiting)).digest('hex'),
    waitingNonceSha256: measurementNonceDigest(waiting.nonce), startAt: waiting.startAt,
    expiresAt: waiting.expiresAt, mode: waiting.mode, startupOnly: true, trafficStarted: false, capacityAcceptance: false };
}

export function validateMeasurementPendingSignal(value, expected, waiting, name, now = Date.now()) {
  validateMeasurementWaiting(waiting, expected, { startAt: waiting.startAt, mode: waiting.mode, now });
  requireCondition(JSON.stringify(value) === JSON.stringify(measurementPendingSignal(expected, waiting, name)),
    'Exact pending signal required; pending is not completion');
  return value;
}

export function measurementReadySignal(expected, waiting, publishedAt = new Date().toISOString()) {
  return { schemaVersion: 1, kind: 'classpilot-measurement-ready-v1', ...startupIdentity(expected),
    waitingSha256: createHash('sha256').update(JSON.stringify(waiting)).digest('hex'),
    waitingNonceSha256: measurementNonceDigest(waiting.nonce), startAt: waiting.startAt, expiresAt: waiting.expiresAt,
    mode: waiting.mode, publishedAt, startupOnly: true, trafficStarted: false, applicationRequests: 0, capacityAcceptance: false };
}

export function validateMeasurementReadySignal(value, expected, waiting, now = Date.now()) {
  validateMeasurementWaiting(waiting, expected, { startAt: waiting.startAt, mode: waiting.mode, now });
  requireCondition(startupUtc(value?.publishedAt) && Date.parse(value.publishedAt) <= now + 1000
    && Date.parse(value.publishedAt) >= Date.parse(waiting.createdAt) && Date.parse(value.publishedAt) < Date.parse(waiting.startAt)
    && JSON.stringify(value) === JSON.stringify(measurementReadySignal(expected, waiting, value.publishedAt)),
    'Exact positive startup receipt required; ready is not traffic or authority');
  return value;
}

// Both native and workload producers use this gate. A waiting value may never
// become a device control, a pulse nonce or a successful causal receipt.
export class MeasurementStartupGate {
  constructor(expected, { startAt, mode = 'workload', now = Date.now } = {}) {
    this.expected = Object.freeze({ ...expected }); this.startAt = startAt; this.mode = mode; this.now = now;
    this.waiting = null; this.ready = false; this.firstPulse = false; this.latest = null;
  }
  acceptWaiting(value) {
    validateMeasurementWaiting(value, this.expected, { startAt: this.startAt, mode: this.mode, now: this.now() });
    if (this.waiting) requireCondition(JSON.stringify(value) === JSON.stringify(this.waiting), 'Startup nonce or waiting control replayed');
    else this.waiting = Object.freeze({ ...value });
    return this.waiting;
  }
  markReady() {
    requireCondition(this.waiting && this.now() < Date.parse(this.startAt) - 1000, 'Startup must finish before the shared start');
    this.ready = true;
  }
  control(value) {
    if (value?.kind === 'classpilot-measurement-waiting-v1') {
      requireCondition(!this.firstPulse, 'Waiting cannot overwrite a timed control');
      this.acceptWaiting(value); return null;
    }
    requireCondition(this.ready && this.now() >= Date.parse(this.startAt), 'Timed pulse requires ready and actual start');
    validateMeasurementWaiting(this.waiting, this.expected, { startAt: this.startAt, mode: this.mode, now: this.now() });
    const pulse = validateCapturePulse(value, this.expected);
    requireCondition([pulse.nonce, pulse.navigationNonce, pulse.revisionDrainNonce].every(nonce => nonce !== this.waiting.nonce),
      'Startup nonce cannot establish timed capture, navigation or drain');
    if (!this.firstPulse) requireCondition(pulse.pulseSequence === 1, 'First timed pulse must be the actual first challenge');
    if (this.latest) {
      requireCondition(pulse.pulseSequence >= this.latest.pulseSequence, 'Timed control cannot regress');
      if (pulse.pulseSequence === this.latest.pulseSequence) requireCondition(JSON.stringify(pulse) === JSON.stringify(this.latest),
        'An accepted sequence cannot change its challenge or payload');
    }
    this.latest = pulse;
    this.firstPulse = true;
    return pulse;
  }
}
export function publicBindingFromDevice(device) {
  let claims; try { claims = JSON.parse(Buffer.from(device.studentToken.split('.')[1], 'base64url')); } catch { throw Error('Malformed private device binding'); }
  requireCondition(claims.deviceId === device.deviceId && claims.studentId === device.studentId && claims.schoolId === device.schoolId
    && typeof claims.sessionId === 'string' && claims.sessionId.length > 0, 'Exact surviving private student token binding required');
  return createHash('sha256').update('classpilot:public-realtime-binding:v1\0').update(claims.sessionId).digest('base64url');
}
export function validateRevisionBootstrap(value, expected, devices) {
  requireCondition(Object.keys(value ?? {}).sort().join(',') === 'cohortSha256,planSha256,revisionBaselines,runId,schemaVersion,sourceArtifactSha256'
    && value.schemaVersion === 1 && value.runId === expected.runId && value.sourceArtifactSha256 === expected.sourceArtifactSha256
    && value.cohortSha256 === expected.cohortSha256 && value.planSha256 === expected.planSha256,
  'Exact revision-bootstrap run/source/cohort/plan binding required');
  requireCondition(Array.isArray(devices) && devices.length === expected.primaryDevices + 10, 'Exact primary plus ten leading canaries required');
  const bindings = new Set(devices.slice(10).map(publicBindingFromDevice));
  requireCondition(bindings.size === expected.primaryDevices && Array.isArray(value.revisionBaselines)
    && value.revisionBaselines.length === bindings.size, 'Every exact primary binding needs a surviving baseline');
  for (const row of value.revisionBaselines) {
    requireCondition(Object.keys(row ?? {}).sort().join(',') === 'publicBinding,revisionBase'
      && bindings.delete(row.publicBinding) && Number.isSafeInteger(row.revisionBase) && row.revisionBase >= 1
      && row.revisionBase + expected.maximumNavigationRounds + 1 <= Number.MAX_SAFE_INTEGER,
    'Unknown, duplicate, retired or unbounded revision baseline');
  }
  requireCondition(bindings.size === 0, 'Incomplete revision baseline'); return value;
}
export function observeRenderedStudentState(runtime, message, observedAt) {
  if (message?.type !== 'student-update') return false;
  if (!runtime.subscribed || message.schoolId !== runtime.actor.schoolId || !runtime.allowed.has(message.studentId)
    || message.teachingSessionId !== undefined && message.teachingSessionId !== runtime.actor.teachingSessionId
    || message.sessionId !== undefined && message.sessionId !== runtime.actor.teachingSessionId
    || message.supervisionContextId || message.realtimeBinding !== runtime.publicBindings.get(message.studentId)) return true;
  if (!Number.isSafeInteger(message.realtimeRevision) || !Number.isSafeInteger(message.tabSnapshotRevision)
    || message.tabSnapshotRevision < 1 || message.status !== 'active') return false;
  const previous = runtime.realtime.get(message.studentId);
  if (previous && message.realtimeRevision <= previous.realtimeRevision) return false;
  const seed = runtime.revisionSeeds?.get(message.studentId);
  if (Number.isSafeInteger(seed) && message.tabSnapshotRevision < seed) return true;
  runtime.realtime.set(message.studentId, { ...message, observedAt, socketGeneration: runtime.socketGeneration }); return false;
}
export function navigationMessageMatches(message, expected, runtime) {
  return runtime.subscribed && message?.socketGeneration === runtime.socketGeneration
    && message.realtimeBinding === expected.publicBinding && message.tabSnapshotRevision === expected.tabSnapshotRevision
    && message.activeTabRef === expected.activeTabRef && message.activeTabTitle === expected.activeTabTitle
    && message.activeTabUrl === expected.activeTabUrl && Array.isArray(message.allOpenTabs) && message.allOpenTabs.length === 1
    && message.allOpenTabs[0].tabRef === expected.activeTabRef && message.allOpenTabs[0].url === expected.activeTabUrl
    && message.allOpenTabs[0].title === expected.activeTabTitle;
}

// Browser-only sampler: it reads existing DOM, without injecting app state.
// Native screenshot comparison below also catches pointer-events:none overlays.
export async function collectNavigationPixelWitness(expectedRows) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return expectedRows.map(expected => {
    const card = document.querySelector(`[data-testid="card-student-${CSS.escape(expected.studentId)}"]`);
    const tab = card?.querySelector(`[data-testid="tab-favicon-${CSS.escape(expected.studentId)}-0"]`);
    const image = tab?.querySelector('img'), paint = image || tab?.querySelector('div'), box = paint?.getBoundingClientRect();
    let visible = document.visibilityState === 'visible' && !!box && box.width > 0 && box.height > 0
      && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    for (let node = paint; visible && node; node = node.parentElement) {
      const style = getComputedStyle(node), b = node.getBoundingClientRect();
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) !== 1
        || /hidden|clip|scroll|auto/.test(style.overflowX) && (box.left < b.left || box.right > b.right)
        || /hidden|clip|scroll|auto/.test(style.overflowY) && (box.top < b.top || box.bottom > b.bottom)) visible = false;
    }
    const titleMatches = tab?.getAttribute('title') === `${expected.activeTabTitle} · ${expected.hostname}`;
    const active = tab?.classList.contains('ring-1') && tab?.classList.contains('border-primary/70');
    const sourceMatches = expected.favicon ? image?.currentSrc === expected.favicon && image.complete && image.naturalWidth > 0 : !image && !!paint;
    const points = [], canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d');
    if (visible && sourceMatches && titleMatches && active) {
      if (image) {
        // Match native destination pixels, including fractional layout offset;
        // a32px surrogate introduces SVG rasterization/antialiasing error.
        canvas.width=Math.ceil(box.width)+2;canvas.height=Math.ceil(box.height)+2;
        context.drawImage(image,box.left-Math.floor(box.left),box.top-Math.floor(box.top),box.width,box.height);
      }
      else {
        const stack = []; for (let node = paint; node; node = node.parentElement) stack.push(node);
        for (const node of stack.reverse()) { context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 32, 32); }
      }
      const anchors = image ? [[.2,.2],[.5,.2],[.8,.2],[.35,.45],[.45,.45],[.4,.55],[.4,.75]]
        : [[.4,.4],[.5,.4],[.6,.4],[.4,.5],[.5,.5],[.6,.5],[.5,.6]];
      for (const [x, y] of anchors) {
        const screenX = Math.floor(box.left + box.width * x), screenY = Math.floor(box.top + box.height * y);
        const hit = document.elementFromPoint(screenX, screenY);
        if (!hit || !(tab === hit || tab.contains(hit))) visible = false;
        const rgba = [...context.getImageData(image?screenX-Math.floor(box.left):Math.floor(32*x), image?screenY-Math.floor(box.top):Math.floor(32*y), 1, 1).data];
        if (rgba[3] === 255) points.push({ x: screenX, y: screenY, rgba });
      }
    }
    return { studentId: expected.studentId, marker: expected.marker, points,
      matched: !!visible && !!sourceMatches && !!titleMatches && !!active && points.length >= 5 };
  });
}
export async function compareNativeNavigationPixels({ pngDataUrl, rows }) {
  const image = new Image(); image.src = pngDataUrl; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
  const values = rows.map(row => {
    const actual = row.points.map(point => [...context.getImageData(point.x, point.y, 1, 1).data]);
    const matches = row.matched && row.points.length >= 5 && row.points.every((point, index) =>
      point.rgba.every((value, channel) => Math.abs(value - actual[index][channel]) <= 12));
    return { studentId: row.studentId, marker: row.marker, matched: matches, pixels: actual.flat() };
  });
  canvas.width=1;canvas.height=1;image.removeAttribute('src');return values;
}

export function measurementNonceDigest(nonce) { requireCondition(/^[a-f0-9]{48}$/.test(nonce), 'Exact measurement nonce required'); return createHash('sha256').update(nonce).digest('hex'); }
export function createBoundedObserverPool({ limit = 2, maximumQueue = 40, now = () => performance.now() } = {}) {
  let active=0;const waiters=[];const counters={completed:0,peakActive:0,peakQueued:0,maximumQueueAgeMs:0};
  const run=async operation=>{const queuedAt=now();
    if(active<limit&&waiters.length===0)active+=1;
    else { requireCondition(waiters.length<maximumQueue,'Bounded observer queue exceeded');await new Promise(resolve=>{waiters.push(resolve);counters.peakQueued=Math.max(counters.peakQueued,waiters.length);}); }
    counters.peakActive=Math.max(counters.peakActive,active);counters.peakQueued=Math.max(counters.peakQueued,waiters.length);counters.maximumQueueAgeMs=Math.max(counters.maximumQueueAgeMs,now()-queuedAt);
    try{return await operation();}finally{counters.completed+=1;const next=waiters.shift();if(next)next();else active-=1;}
  };
  return {run,summary:()=>({...counters,active,queued:waiters.length,limit,maximumQueue})};
}
export function measurementSignal(expected, kind, nonce) {
  requireCondition(['measurement-started-v3', 'measurement-drained-v3'].includes(kind), 'Exact causal signal kind required');
  return { schemaVersion: 1, kind, runId: expected.runId, sourceArtifactSha256: expected.sourceArtifactSha256,
    scriptBundleSha256: expected.scriptBundleSha256, planSha256: expected.planSha256, cohortSha256: expected.cohortSha256,
    nonceSha256: measurementNonceDigest(nonce), primaryBindings: expected.primaryDevices, trafficStarted: true };
}
export function validateMeasurementSignal(value, expected, kind, nonce) {
  requireCondition(JSON.stringify(value) === JSON.stringify(measurementSignal(expected, kind, nonce)), 'Exact finite causal signal required'); return value;
}

// Native Chrome generated legal1x1 JPEG bases; no student/device/frame identifiers.
export const CAPTURE_COLOR_BASES = Object.freeze([
  {
    "name": "red",
    "decodedRgba": [
      216,
      48,
      37,
      255
    ],
    "base64": "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAJCv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AAOO9VQ//9k="
  },
  {
    "name": "green",
    "decodedRgba": [
      24,
      128,
      57,
      255
    ],
    "base64": "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAICf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADHG9I9//9k="
  },
  {
    "name": "blue",
    "decodedRgba": [
      26,
      115,
      233,
      255
    ],
    "base64": "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAJCv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ABepQCe//9k="
  }
].map(value => Object.freeze(value)));

export function makeReliabilityColorFixtures() {
  const bases=CAPTURE_COLOR_BASES.map(value=>Buffer.from(value.base64,'base64'));
  if(new Set(bases.map(value=>value.length)).size!==1)throw Error('Equal legal1x1 JPEG base lengths required');
  const first=makeReliabilityJpegFixture(bases[0]);
  return bases.map((base,index)=>{if(!index)return first;const fixture=Buffer.from(first);base.subarray(0,-2).copy(fixture);return fixture;});
}
export function reliabilityColorFixtureEvidence(fixtures) {
  if(!fixtures.every(set=>Array.isArray(set)&&set.length===3))throw Error('Three immutable color variants per exact device required');
  const variants=[0,1,2].map(index=>reliabilityFixtureEvidence(fixtures.map(set=>set[index])));
  return { ...variants[0],version:RELIABILITY_FIXTURE_VERSION, colorVariants:3, fixtureCount:fixtures.length, decodedCacheBytes:fixtures.length*3*40960,
    decodedColors:CAPTURE_COLOR_BASES.map(value=>value.decodedRgba), variants };
}
