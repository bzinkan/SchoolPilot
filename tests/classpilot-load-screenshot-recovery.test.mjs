import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { SerialHeartbeatWriter, publicBindingFromDevice } from '../scripts/load/classpilot-reliability-profile.mjs';

const source = fs.readFileSync(new URL('../scripts/load/classpilot-load-test.mjs', import.meta.url), 'utf8');
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, `Actual source boundaries: ${start}`);
  return source.slice(a, b);
};
const helpers = between('// BEGIN scoped screenshot recovery.', '// END scoped screenshot recovery.');
const requestSource = between('async function request(path, {', '\nfunction issue(');
const drainSource = between('async function drainResponse(', '\nfunction observeHttp(');
const observeSource = between('function observeHttp(', '\nfunction responseIsolationViolation(');
const finalizeSource = between('function finalizePendingRequest(', '\nasync function request(');
const messageSource = between('function handleDeviceMessage(', '\nfunction connectDevice(');
const trafficSource = between('function startDeviceTraffic(', '\nconst devicesForTeacherCache');
const tick = () => new Promise(setImmediate);
const capabilities = ['scopedAuthorityChecksV1', 'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1'];
const token = (sessionId = 'session-a') => 'synthetic.' + Buffer.from(JSON.stringify({
  schoolId: 'school-a', studentId: 'student-a', deviceId: 'device-a', sessionId,
})).toString('base64url') + '.fixture';

function fixture() {
  const clock = { mono: 1000, wall: 1_800_000_000_000 };
  class ClockDate extends Date { static now() { return clock.wall; } }
  const counters = new Proxy({}, { get: (v, k) => v[k] ?? 0 });
  const timers = [], fatals = [], latencies = [], pendingRequests = new Map();
  const context = vm.createContext({ Buffer, Date: ClockDate, Set, Map, AbortController,
    monotonicNowMs: () => clock.mono, counters, reliabilityWorkload: true, publicBindingFromDevice,
    authenticatedDeviceIds: new Set(),
    cancelLater() {}, pendingRequests, nextRequestId: 1, requestTimeoutMs: 15000,
    baseUrl: 'http://127.0.0.1', LOAD_GATE_USER_AGENT: 'offline-regression',
    MAX_RESPONSE_CAPTURE_BYTES: 5 * 1024 * 1024,
    fineLatencyEndpoint: () => '', fineEndpointLatencies: null,
    fiveMinuteRequests: { add() {} }, fiveMinuteDeviceIngestRequests: { add() {} },
    fiveMinuteGeneralApiRequests: { add() {} }, statusCodes: {},
    histogram: () => ({ observe: (ms, failed) => latencies.push({ ms, failed }) }),
    triggerFatalGate: (reason, details) => fatals.push({ reason, ...details }),
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimeout() {},
  });
  vm.runInContext(`${helpers}\n${drainSource}\n${observeSource}\n${finalizeSource}\n${requestSource}\n${messageSource}`, context);
  const state = { authenticated: true, expectedTeachingSessionId: 'class-a', reliabilityCaptures: 0, device: {
    schoolId: 'school-a', studentId: 'student-a', classId: 'roster-a', teacherId: null,
    deviceId: 'device-a', studentToken: token(),
  } };
  const reserve = () => context.reserveScreenshotRecovery(state);
  const policy = (revision = 1) => ({ mode: 'tracking_window_lease', captureAllowed: true,
    authority: { kind: 'teaching_session', teachingSessionId: 'class-a', controlRevision: revision },
    expiresInSeconds: 90, serverTime: new Date(clock.wall).toISOString(),
    captureCadence: { mode: 'active_view', intervalSeconds: 5, expiresInSeconds: 84 } });
  const adopt = (guard, value = policy(), origin = 'heartbeat') => context.adoptRecoveryScreenshotPolicy(state,
    { screenshotPolicy: value, acceptedCapabilities: capabilities }, guard, origin);
  const initial = reserve(); assert.equal(adopt(initial), true);
  const response = (status, body) => ({ status, ok: status >= 200 && status < 300,
    body: (async function* () { yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); })() });
  const screenshot = () => context.request('/api/classpilot/device/screenshot', { method: 'POST',
    token: state.device.studentToken, body: { screenshot: 'synthetic' }, kind: 'screenshotPost',
    screenshotRecovery: { state, guard: reserve() } });
  return { context, state, clock, counters, timers, fatals, latencies, pendingRequests, reserve, policy, adopt, response, screenshot };
}

test('upload policy refresh uses exact scope/generation and subtracts request age from both leases', () => {
  const f = fixture(), guard = f.reserve();
  f.clock.mono += 5000; f.clock.wall += 5000;
  const value = f.policy(); value.serverTime = new Date(guard.wall).toISOString();
  assert.equal(f.adopt(guard, value, 'upload'), true);
  assert.equal(f.state.device.reliabilityPolicy.expiresAtMono, guard.mono + 90000);
  assert.equal(f.state.device.reliabilityPolicy.captureCadence.expiresAtMono, guard.mono + 84000);
  f.clock.mono = guard.mono + 84000;
  assert.equal(f.context.recoveryScreenshotCaptureAllowed(f.state), false);
});

test('late success or denial from revision A cannot overwrite independently adopted revision B', () => {
  const f = fixture(), old = f.reserve(), newer = f.reserve();
  assert.equal(f.adopt(newer, f.policy(2)), true);
  const current = f.state.device.reliabilityPolicy;
  assert.equal(f.adopt(old, f.policy(1), 'upload'), false);
  assert.equal(f.adopt(old, { ...f.policy(1), captureAllowed: false }, 'denial'), false);
  assert.equal(f.state.device.reliabilityPolicy, current);
});

test('exact unexpired omission retains auth lease; heartbeat/upload omissions only downgrade cadence', () => {
  for (const origin of ['auth', 'heartbeat', 'upload']) {
    const f = fixture(), current = f.state.device.reliabilityPolicy, guard = f.reserve();
    f.context.adoptRecoveryScreenshotPolicy(f.state, { acceptedCapabilities: capabilities }, guard, origin);
    assert.equal(f.state.device.reliabilityPolicy.expiresAtMono, current.expiresAtMono);
    assert.equal(f.state.device.reliabilityPolicy.captureAllowed, true);
    assert.equal(f.state.device.reliabilityPolicy.captureCadence.mode, origin === 'auth' ? 'active_view' : 'background');
  }
  const f = fixture(), guard = f.reserve(); f.clock.mono += 90001; f.clock.wall += 90001;
  f.context.adoptRecoveryScreenshotPolicy(f.state, {}, guard, 'auth');
  assert.equal(f.state.device.reliabilityPolicy, null);
});

test('binding/token changes fence late responses, including returning to a former identity', () => {
  const f = fixture(), old = f.reserve();
  assert.equal(Object.hasOwn(f.state.device, 'studentSessionId'), false);
  f.state.device.studentToken = token('session-b'); f.reserve();
  f.state.device.studentToken = token('session-a'); f.reserve();
  assert.equal(f.adopt(old), false);
  f.state.device.studentToken += '-rotated-signature';
  assert.equal(f.context.screenshotRecoveryCurrent(f.state, old), false);
});

test('auth-success verifies the actual normalized manifest token session and full supplied binding', () => {
  const f = fixture(); let closed = 0;
  f.state.socket = { close: () => { closed++; } };
  f.state.screenshotAuthGuard = f.reserve();
  const message = { type: 'auth-success', role: 'student', schoolId: 'school-a', studentId: 'student-a',
    studentSessionId: 'session-a', exactBinding: { schoolId: 'school-a', studentId: 'student-a',
      studentSessionId: 'session-a', deviceId: 'device-a' }, acceptedCapabilities: capabilities,
    screenshotPolicy: f.policy() };
  f.context.handleDeviceMessage(f.state, Buffer.from(JSON.stringify(message)), () => {});
  assert.equal(f.counters.wsAuthenticated, 1); assert.equal(closed, 0);
  message.exactBinding.studentSessionId = 'foreign';
  f.context.handleDeviceMessage(f.state, Buffer.from(JSON.stringify(message)), () => {});
  assert.equal(f.counters.wsAuthErrors, 1); assert.equal(closed, 1);
});

test('policy validator refuses foreign context, extra authority keys, invalid dates and expired response leases', () => {
  for (const change of [
    value => { value.authority.teachingSessionId = 'class-foreign'; },
    value => { value.authority.deviceId = 'foreign'; },
    value => { value.serverTime = 'not-a-date'; },
    value => { value.expiresInSeconds = 91; },
  ]) {
    const f = fixture(), value = f.policy(), guard = f.reserve(); change(value);
    assert.equal(f.context.normalizeRecoveryScreenshotPolicy(f.state, value, guard, f.clock.wall, f.clock.mono), null);
  }
  const f = fixture(), value = f.policy(), guard = f.reserve();
  f.clock.mono += 90001; f.clock.wall += 90001;
  const expired = f.context.normalizeRecoveryScreenshotPolicy(f.state, value, guard, f.clock.wall, f.clock.mono);
  assert.equal(expired.captureAllowed, false);
  assert(expired.expiresAtMono <= f.clock.mono);
});

test('valid exact hints coalesce through the actual existing heartbeat writer and grant no policy', async () => {
  const f = fixture(), queued = [], sent = [], current = f.state.device.reliabilityPolicy;
  f.state.heartbeatWriter = new SerialHeartbeatWriter({ now: () => f.clock.mono,
    schedule: (fn, ms) => { const t = { fn, at: f.clock.mono + ms }; queued.push(t); return t; },
    clear: t => { t.cancelled = true; }, snapshot: () => ({ fresh: f.clock.mono }),
    send: async value => { sent.push(value); return { ok: true }; } });
  const hint = { type: 'screenshot-policy-refresh', reason: 'observation_changed',
    studentId: 'student-a', studentSessionId: 'session-a', teachingSessionId: 'class-a' };
  for (let i = 0; i < 3; i++) f.context.handleDeviceMessage(f.state, Buffer.from(JSON.stringify(hint)), () => {});
  assert.equal(f.counters.reliabilityScreenshotRefreshHints, 3);
  assert.equal(f.state.device.reliabilityPolicy, current);
  assert.equal(sent.length, 0);
  f.clock.mono += 2000; queued.filter(t => !t.cancelled).forEach(t => t.fn()); await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fresh, f.clock.mono);
  for (const mutation of [{ studentSessionId: 'foreign' }, { teachingSessionId: 'foreign' },
    { schoolId: 'foreign' }, { deviceId: 'foreign' }, { supervisionContextId: 'foreign' }]) {
    f.context.handleDeviceMessage(f.state, Buffer.from(JSON.stringify({ ...hint, ...mutation })), () => {});
  }
  assert.equal(f.counters.reliabilityScreenshotRefreshHintsIgnored, 5);
});

test('known heartbeat-required409 is classified only after EOF, remains4xx/failed latency and preserves the lease', async () => {
  const f = fixture(), current = f.state.device.reliabilityPolicy; let finishBody;
  f.context.ipv4Request = async () => ({ status: 409, ok: false, body: (async function* () {
    yield Buffer.from('{"ok":false,'); await new Promise(resolve => { finishBody = resolve; });
    yield Buffer.from('"code":"SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED"}');
  })() });
  const p = f.screenshot(); await tick();
  assert.equal(f.fatals.length, 0); assert.equal(f.counters.reliabilityScreenshotHeartbeatRequired, 0);
  assert.equal(f.pendingRequests.size, 1); finishBody(); const result = await p;
  assert.equal(result.screenshotRefusal.recoverable, true);
  assert.equal(f.counters.reliabilityScreenshotHeartbeatRequired, 1);
  assert.equal(f.counters.http4xx, 1); assert.equal(f.latencies[0].failed, true);
  assert.equal(f.state.device.reliabilityPolicy, current); assert.equal(f.pendingRequests.size, 0);
});

test('heartbeat-required recovery queues a fresh heartbeat without policy revocation or screenshot replay', () => {
  const f = fixture(), guard = f.reserve(), current = f.state.device.reliabilityPolicy; let heartbeats = 0;
  f.state.heartbeatWriter = { navigation: () => { heartbeats++; } };
  f.context.applyRecoveryScreenshotResponse(f.state, { ok: false, json: { ok: false,
    code: 'SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED' }, screenshotRefusal: {
    code: 'SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED', recoverable: true } }, guard);
  assert.equal(heartbeats, 1); assert.equal(f.state.device.reliabilityPolicy, current);
  assert.equal(f.state.reliabilityCaptures, 0);
});

test('a valid exact classroom hint also wakes the heartbeat while policy is paused or student-session-only', () => {
  const f = fixture(); let heartbeats = 0;
  f.state.heartbeatWriter = { navigation: () => { heartbeats++; } };
  const guard = f.reserve(), value = f.policy();
  value.authority = { kind: 'student_session', controlRevision: 0 };
  value.captureAllowed = false; value.expiresInSeconds = 0;
  assert.equal(f.adopt(guard, value, 'denial'), true);
  const hint = { type: 'screenshot-policy-refresh', reason: 'observation_changed',
    studentId: 'student-a', studentSessionId: 'session-a', teachingSessionId: 'class-a' };
  f.context.handleDeviceMessage(f.state, Buffer.from(JSON.stringify(hint)), () => {});
  assert.equal(heartbeats, 1); assert.equal(f.context.recoveryScreenshotCaptureAllowed(f.state), false);
  assert.equal(f.state.device.reliabilityPolicy.authority.kind, 'student_session');
});

test('malformed/unknown/foreign/invalid-time screenshot409 remains fatal with fixed content-free labels', async () => {
  for (const body of ['not-json', { ok: false, code: 'untrusted-free-form-text' },
    { ok: true, code: 'SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED' },
    { ok: false, code: 'SCREENSHOT_CAPTURE_PAUSED', screenshotPolicy: { mode: 'invalid' } },
    { ok: false, code: 'SCREENSHOT_CAPTURE_EXPIRED' }]) {
    const f = fixture(); f.context.ipv4Request = async () => f.response(409, body);
    const result = await f.screenshot(); assert.equal(result.screenshotRefusal.recoverable, false);
    assert.equal(f.fatals[0].reason, 'valid-http-409'); assert.equal(f.counters.http4xx, 1);
    assert(!JSON.stringify(f.fatals).includes('untrusted-free-form-text'));
  }
  const f = fixture(), policy = f.policy(); policy.authority.teachingSessionId = 'foreign';
  f.context.ipv4Request = async () => f.response(409, { ok: false, code: 'SCREENSHOT_AUTHORITY_SUPERSEDED', screenshotPolicy: policy });
  await f.screenshot(); assert.equal(f.fatals[0].reason, 'valid-http-409');
});

test('never-ending screenshot header/body aborts at the same8s whole-request deadline and is never replayed', async () => {
  for (const phase of ['headers', 'body']) {
    const f = fixture(); let attempts = 0;
    f.context.ipv4Request = async (url, { signal }) => {
      attempts++;
      const stalled = () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('synthetic abort')), { once: true }));
      if (phase === 'headers') return stalled();
      return { status: 409, ok: false, body: (async function* () { await stalled(); })() };
    };
    const p = f.screenshot(); await tick(); assert.equal(f.timers[0].ms, 8000);
    f.clock.mono += 8000; f.clock.wall += 8000; f.timers[0].fn(); await p;
    assert.equal(attempts, 1); assert.equal(f.pendingRequests.size, 0); assert.equal(f.counters.httpErrors, 1);
    if (phase === 'body') { assert.equal(f.fatals[0].screenshotRefusalCode, 'body-unavailable'); assert.equal(f.counters.http4xx, 1); }
  }
});

test('unrelated409 keeps its original immediate fatal behavior before body EOF', async () => {
  const f = fixture(); let release;
  f.context.ipv4Request = async () => ({ status: 409, ok: false,
    body: (async function* () { await new Promise(resolve => { release = resolve; }); yield Buffer.from('{}'); })() });
  const p = f.context.request('/api/classpilot/device/heartbeat', { method: 'POST', kind: 'heartbeat' });
  await tick(); assert.equal(f.fatals[0].reason, 'valid-http-409'); release(); await p;
  assert.equal(f.counters.http4xx, 1);
});

const captureRefusalCases = [
  ['binding', f => { f.state.screenshotRecoveryBinding = 'foreign'; }],
  ['capabilities', f => { f.state.screenshotCapabilities = new Set(); }],
  ['missing-policy', f => { f.state.device.reliabilityPolicy = null; }],
  ['permission-unavailable', f => { f.state.device.reliabilityPolicy.captureAllowed = false; }],
  ['authority', f => { f.state.device.reliabilityPolicy.authority.teachingSessionId = 'foreign'; }],
  ['cadence-background', f => { f.state.device.reliabilityPolicy.captureCadence.mode = 'background'; }],
  ['cadence-expired', f => { f.state.device.reliabilityPolicy.captureCadence.expiresAtMono = f.clock.mono; }],
];
const reasonCounterNames = ['Binding', 'Capabilities', 'MissingPolicy', 'Permission', 'Authority', 'CadenceBackground', 'CadenceExpired']
  .map(name => `reliabilityPolicyUnavailable${name}`);
const sourceCounterNames = ['None', 'Auth', 'Heartbeat', 'Upload', 'Denial'].map(name => `reliabilityPolicyUnavailableSource${name}`);

test('fixed first-false diagnostics equal the unchanged predicate, including combined failures', () => {
  const allowed = fixture();
  assert.equal(allowed.context.recoveryScreenshotCaptureAllowed(allowed.state), true);
  assert.equal(allowed.context.recoveryScreenshotCaptureRefusalReason(allowed.state), null);
  for (let first = 0; first < captureRefusalCases.length; first++) {
    for (let second = first; second < captureRefusalCases.length; second++) {
      const f = fixture();
      // Apply downstream changes first; missing policy may remove their parent.
      captureRefusalCases[second][1](f); captureRefusalCases[first][1](f);
      assert.equal(Boolean(f.context.recoveryScreenshotCaptureAllowed(f.state)), false);
      assert.equal(f.context.recoveryScreenshotCaptureRefusalReason(f.state), captureRefusalCases[first][0]);
    }
  }
  for (const capability of capabilities) {
    const f = fixture(); f.state.screenshotCapabilities.delete(capability);
    assert.equal(f.context.recoveryScreenshotCaptureRefusalReason(f.state), 'capabilities');
  }
});

test('diagnostics preserve exact permission, authority, cadence and expiry boundaries', () => {
  for (const [reason, mutate] of [
    ['permission-unavailable', f => { f.state.device.reliabilityPolicy.expiresAtMono = f.clock.mono; }],
    ['permission-unavailable', f => { f.state.device.reliabilityPolicy.expiresAtMono = NaN; }],
    ['authority', f => { f.state.device.reliabilityPolicy.authority = { kind: 'student_session' }; }],
    ['cadence-background', f => { f.state.device.reliabilityPolicy.captureCadence.intervalSeconds = 30; }],
    ['cadence-background', f => { delete f.state.device.reliabilityPolicy.captureCadence; }],
    ['cadence-expired', f => { f.state.device.reliabilityPolicy.captureCadence.expiresAtMono = NaN; }],
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(Boolean(f.context.recoveryScreenshotCaptureAllowed(f.state)), false);
    assert.equal(f.context.recoveryScreenshotCaptureRefusalReason(f.state), reason);
  }
  const f = fixture();
  f.state.device.reliabilityPolicy.expiresAtMono = f.clock.mono + 1;
  f.state.device.reliabilityPolicy.captureCadence.expiresAtMono = f.clock.mono + 1;
  assert.equal(f.context.recoveryScreenshotCaptureAllowed(f.state), true);
  assert.equal(f.context.recoveryScreenshotCaptureRefusalReason(f.state), null);
});

test('each refusal records exactly one fixed reason and source without persisting untrusted fields', () => {
  for (const [index, [reason, mutate]] of captureRefusalCases.entries()) {
    const f = fixture(); mutate(f);
    f.state.screenshotPolicyAppliedSource = 'untrusted-free-form';
    f.context.recordRecoveryScreenshotCaptureRefusal(f.state);
    assert.equal(f.counters[reasonCounterNames[index]], 1, reason);
    assert.equal(reasonCounterNames.reduce((sum, name) => sum + f.counters[name], 0), 1);
    assert.equal(sourceCounterNames.reduce((sum, name) => sum + f.counters[name], 0), 1);
    assert.equal(f.counters.reliabilityPolicyUnavailableSourceNone, 1);
    assert(!JSON.stringify(f.counters).includes('untrusted-free-form'));
    assert(Object.keys(f.counters).every(name => reasonCounterNames.includes(name) || sourceCounterNames.includes(name)));
  }
  const f = fixture(); f.context.recordRecoveryScreenshotCaptureRefusal(f.state);
  assert.equal(Object.keys(f.counters).length, 0);
});

test('last-applied policy source follows accepted, omitted and malformed policies but not rejected generations or scopes', () => {
  for (const source of ['auth', 'heartbeat', 'upload', 'denial']) {
    const f = fixture(); assert.equal(f.adopt(f.reserve(), f.policy(), source), true);
    assert.equal(f.state.screenshotPolicyAppliedSource, source);
    f.state.device.reliabilityPolicy.captureCadence.mode = 'background';
    f.context.recordRecoveryScreenshotCaptureRefusal(f.state);
    assert.equal(f.counters[sourceCounterNames[['auth', 'heartbeat', 'upload', 'denial'].indexOf(source) + 1]], 1);
    const newer = f.reserve(); f.context.adoptRecoveryScreenshotPolicy(f.state, {}, newer, source);
    assert.equal(f.state.screenshotPolicyAppliedSource, source);
    const malformed = f.reserve();
    f.context.adoptRecoveryScreenshotPolicy(f.state, { screenshotPolicy: { mode: 'malformed' } }, malformed, source);
    assert.equal(f.state.device.reliabilityPolicy, null);
    assert.equal(f.state.screenshotPolicyAppliedSource, source);
  }
  const f = fixture(), old = f.reserve(), newer = f.reserve();
  assert.equal(f.adopt(newer, f.policy(2), 'heartbeat'), true);
  assert.equal(f.adopt(old, f.policy(), 'auth'), false);
  const lowerRevision = f.reserve();
  assert.equal(f.adopt(lowerRevision, f.policy(1), 'denial'), false);
  const foreignScope = f.reserve();
  f.state.device.reliabilityPolicy.authority.controlRevision = 3;
  assert.equal(f.adopt(foreignScope, f.policy(3), 'upload'), false);
  assert.equal(f.state.screenshotPolicyAppliedSource, 'heartbeat');
  f.state.device.studentToken = token('session-b'); f.reserve();
  assert.equal(f.state.screenshotPolicyAppliedSource, 'none');
  assert.equal(f.adopt(newer, f.policy(3), 'auth'), false);
  assert.equal(f.state.screenshotPolicyAppliedSource, 'none');
});

test('actual periodic refusal branch keeps the same primary-only warmup and aggregate accounting with zero requests', () => {
  const f = fixture(), scheduled = []; let requests = 0;
  Object.assign(f.context, {
    SerialHeartbeatWriter: class { regular() {} },
    later: callback => { scheduled.push(callback); }, cancelLater() {},
    workloadEvery() {}, stoppingTraffic: false, acceleratedRequestStaggerMs: 0,
    heartbeatIntervalMs: 10000, screenshotIntervalMs: 5000, devices: [f.state.device],
    teacherSchoolId: 'school-a', runStartedAtMonoNs: 0n, NANOSECONDS_PER_MILLISECOND: 1000000n,
    issue: () => { requests++; }, capturePulseProducer: null,
  });
  vm.runInContext(trafficSource, f.context);
  f.state.device.reliabilityPolicy.captureCadence.mode = 'background';
  f.context.startDeviceTraffic(f.state, 0);
  const capture = scheduled[1];
  f.clock.mono = 30000; capture();
  assert.equal(f.counters.reliabilityPolicyUnavailable, 0);
  f.clock.mono = 30001; capture(); capture();
  assert.equal(f.counters.reliabilityPolicyUnavailable, 2);
  assert.equal(reasonCounterNames.reduce((sum, name) => sum + f.counters[name], 0), 2);
  assert.equal(sourceCounterNames.reduce((sum, name) => sum + f.counters[name], 0), 2);
  assert.equal(f.counters.reliabilityPolicyUnavailableCadenceBackground, 2);
  assert.equal(f.counters.reliabilityPolicyUnavailableSourceHeartbeat, 2);
  f.state.device.schoolId = 'canary-school';
  f.state.device.studentToken = 'synthetic.' + Buffer.from(JSON.stringify({
    schoolId: 'canary-school', studentId: 'student-a', deviceId: 'device-a', sessionId: 'session-a',
  })).toString('base64url') + '.fixture';
  f.reserve(); capture();
  assert.equal(f.counters.reliabilityPolicyUnavailable, 2);
  assert.equal(requests, 0);
});

test('a newer valid background policy can cause a local refusal despite HTTP success, then a newer active policy restores it', () => {
  const f = fixture(), current = f.policy();
  current.captureCadence = { mode: 'background', intervalSeconds: 30, expiresInSeconds: 90 };
  const background = f.reserve();
  f.context.applyRecoveryScreenshotResponse(f.state, { ok: true, json: { ok: true, screenshotPolicy: current } }, background);
  assert.equal(f.state.reliabilityCaptures, 1);
  assert.equal(f.context.recoveryScreenshotCaptureAllowed(f.state), false);
  assert.equal(f.context.recoveryScreenshotCaptureRefusalReason(f.state), 'cadence-background');
  assert.equal(f.state.screenshotPolicyAppliedSource, 'upload');
  assert.equal(f.adopt(f.reserve(), f.policy(), 'heartbeat'), true);
  assert.equal(f.context.recoveryScreenshotCaptureAllowed(f.state), true);
  assert.equal(f.context.recoveryScreenshotCaptureRefusalReason(f.state), null);
  assert.equal(f.state.screenshotPolicyAppliedSource, 'heartbeat');
  assert.equal(f.fatals.length, 0); assert.equal(f.counters.httpErrors, 0);
});
