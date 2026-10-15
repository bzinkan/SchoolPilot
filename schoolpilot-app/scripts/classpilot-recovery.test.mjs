import assert from 'node:assert/strict';
import test from 'node:test';
import { createClasspilotScreenshotQueue, withClasspilotReadDeadline, withClasspilotLeaseDeadline,
  createClasspilotTransportMonitor, classpilotSnapshotRequest, stepClasspilotPreviewRecovery, selectClasspilotFastStudents } from '../src/products/classpilot/lib/classpilotRecovery.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('the authorized open student drawer gets a fast permit within the hundred-target limit even offscreen', () => {
  const students = Array.from({ length: 160 }, (_, index) => ({ studentId: String(index) }));
  const eligibleIds = new Set(students.map(student => student.studentId));
  const nearViewportIds = new Set(students.slice(0, 120).map(student => student.studentId));
  const select = priorityStudentId => selectClasspilotFastStudents(students, { eligibleIds, nearViewportIds, tracking: true, priorityStudentId });
  assert.equal(select().length, 100); assert.equal(select('159').length, 100);
  assert.equal(select('159')[0].studentId, '159'); assert.equal(select('159').some(student => student.studentId === '99'), false);
  eligibleIds.delete('159'); assert.equal(select('159').some(student => student.studentId === '159'), false);
  assert.equal(select('not-in-current-roster').length, 100);
});

test('missing preview events retain five-second recovery beyond a minute and fresh pixels end an episode', () => {
  const recoveries = new Map();
  const student = { studentId: 'active', realtimeBinding: 'binding-a', acceptedCapabilities: { screenshotActiveObservationCadenceV1: true } };
  const screenshots = new Map([['active', { timestamp: new Date(0).toISOString(), bindingVersion: 'binding-a' }]]);
  const state = { students: [student], screenshots, denied: new Set(), observationStatus: () => 'observed' };
  const step = now => stepClasspilotPreviewRecovery(recoveries, { ...state, now });
  assert.deepEqual(step(0).due, []);
  for (let now = 8_000; now <= 98_000; now += 5_000) {
    const result = step(now);
    assert.deepEqual(result.due, ['active']); assert.equal(result.nextAt, now + 5_000);
  }
  screenshots.set('active', { timestamp: new Date(100_000).toISOString(), bindingVersion: 'binding-a' });
  assert.deepEqual(step(100_000).due, []); assert.equal(recoveries.get('active').recovering, false);
  assert.equal(recoveries.get('active').nextAt, 108_000);
  assert.equal(step(108_000).gapRecoveries, 1, 'A new gap after fresh pixels is a new recovery episode');
  student.realtimeBinding = 'binding-b'; screenshots.clear(); step(109_000);
  assert.equal(recoveries.get('active').recovering, false);
  state.students = Array.from({ length: 150 }, (_, index) => ({ ...student, studentId: String(index) }));
  step(110_000); assert.equal(recoveries.size, 100); assert.equal(recoveries.has('active'), false);
});

test('an ignored abort cannot hold a snapshot caller or revive a late result', async () => {
  const gate = deferred(); let aborted = false;
  const request = withClasspilotReadDeadline(signal => { signal.addEventListener('abort', () => { aborted = true; }); return gate.promise; }, undefined, 10);
  await assert.rejects(request, { code: 'CLASSPILOT_READ_TIMEOUT' });
  assert.equal(aborted, true); gate.resolve('late pixels'); await turn();
});

test('only snapshot routes receive deadlines; classroom command writes run once', async () => {
  const calls = [];
  const request = (...args) => { calls.push(args); return Promise.resolve({}); };
  await classpilotSnapshotRequest(request, 'GET', '/students-aggregated');
  await classpilotSnapshotRequest(request, 'POST', '/classpilot/tiles/screenshots', { studentIds: ['a'] });
  await classpilotSnapshotRequest(request, 'POST', '/commands', { teachingSessionId: 'class' });
  assert(calls[0][3].signal); assert(calls[1][3].signal); assert.equal(calls[2][3].signal, undefined);
  assert.equal(calls.filter(call => call[1] === '/commands').length, 1);
});

test('caller cancellation immediately aborts the composed snapshot request', async () => {
  const caller = new AbortController(); let forwarded;
  const pending = withClasspilotReadDeadline(signal => { forwarded = signal; return new Promise(() => {}); }, caller.signal);
  await turn(); caller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(forwarded.aborted, true);
});

test('a timed-out lease PUT keeps late exact-viewer cleanup attached', async () => {
  const gate = deferred(); const deleted = [];
  await assert.rejects(withClasspilotLeaseDeadline(gate.promise, () => deleted.push('old-viewer'), 10), { code: 'CLASSPILOT_READ_TIMEOUT' });
  assert.deepEqual(deleted, []);
  gate.resolve({ state: 'active' }); await turn();
  assert.deepEqual(deleted, ['old-viewer']);
});

test('latest pending targets merge and a slow cohort does not block another cohort', async () => {
  const queue = createClasspilotScreenshotQueue({ concurrency: 3, intervalMs: 10 });
  const gate = deferred(); const calls = [];
  const read = async ids => { calls.push(ids); if (ids.includes('a')) await gate.promise; return ids; };
  const first = queue.read({ key: 'cohort-a', studentIds: ['a'], read });
  await turn();
  const pendingB = queue.read({ key: 'cohort-a', studentIds: ['b'], read });
  const pendingC = queue.read({ key: 'cohort-a', studentIds: ['c'], read });
  const other = await queue.read({ key: 'cohort-z', studentIds: ['z'], read });
  assert.deepEqual(other, ['z']); assert.equal(calls.length, 2);
  gate.resolve(); await first;
  assert.deepEqual(await pendingB, ['b', 'c']); assert.deepEqual(await pendingC, ['b', 'c']);
  assert.equal(calls.length, 3); queue.clear();
});

test('screenshot concurrency, cohort cancellation and maximum targets remain bounded', async () => {
  const queue = createClasspilotScreenshotQueue({ concurrency: 3, intervalMs: 0 });
  const gates = Array.from({ length: 6 }, deferred); let active = 0, peak = 0;
  const requests = gates.map((gate, index) => queue.read({ key: String(index), studentIds: [String(index)], read: async (_, signal) => {
    active += 1; peak = Math.max(active, peak);
    try { return await withClasspilotReadDeadline(() => gate.promise, signal, 1000); } finally { active -= 1; }
  } }));
  const results = Promise.allSettled(requests);
  await turn(); assert.equal(peak, 3);
  queue.clear(); const cancelled = await results;
  assert(cancelled.every(result => result.status === 'rejected'));
  await assert.rejects(queue.read({ key: 'wide', studentIds: Array.from({ length: 51 }, (_, i) => String(i)), read: () => [] }));
  gates.forEach(gate => gate.resolve());
});

test('transport probes negotiate nonce matching and reconnect after a missing response', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const previous = globalThis.document; globalThis.document = { visibilityState: 'visible' };
  const frames = [], health = []; let timeouts = 0;
  const monitor = createClasspilotTransportMonitor({ socket: { readyState: 1, send: text => frames.push(JSON.parse(text)) },
    onHealth: value => health.push(value), onPhase() {}, onStable() {}, onTimeout: () => { timeouts += 1; } });
  try {
    monitor.opened(); monitor.authenticated({ transportProbeV1: true });
    assert.equal(health.at(-1), false, 'Authentication alone cannot advertise live transport');
    monitor.message({ type: 'transport-probe-reply', nonce: frames[0].nonce });
    assert.equal(health.at(-1), true);
    context.mock.timers.tick(10_000);
    assert.equal(frames[1].type, 'transport-probe');
    monitor.message({ type: 'transport-probe-reply', nonce: 'incorrect' });
    context.mock.timers.tick(5_000); assert.equal(timeouts, 1); assert.equal(health.at(-1), false);
    monitor.dispose();
  } finally { globalThis.document = previous; }
});

test('legacy pong, hidden pause and resume cannot leak duplicate heartbeat intervals', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const previous = globalThis.document; globalThis.document = { visibilityState: 'visible' };
  const frames = []; let timeouts = 0;
  const monitor = createClasspilotTransportMonitor({ socket: { readyState: 1, send: text => frames.push(JSON.parse(text)) },
    onHealth() {}, onPhase() {}, onStable() {}, onTimeout: () => { timeouts += 1; } });
  try {
    monitor.opened(); monitor.authenticated({}); monitor.message({ type: 'pong' }); context.mock.timers.tick(10_000);
    assert.deepEqual(frames, [{ type: 'ping' }, { type: 'ping' }]); monitor.message({ type: 'pong' });
    document.visibilityState = 'hidden'; monitor.visibility(); context.mock.timers.tick(60_000);
    assert.equal(timeouts, 0); assert.equal(frames.length, 2);
    document.visibilityState = 'visible'; monitor.visibility(); monitor.message({ type: 'pong' });
    monitor.visibility(); monitor.message({ type: 'pong' }); context.mock.timers.tick(10_000);
    assert.equal(frames.length, 5); monitor.message({ type: 'pong' });
    monitor.dispose(); context.mock.timers.tick(60_000); assert.equal(timeouts, 0);
  } finally { globalThis.document = previous; }
});

// Backend screenshots retain epoch milliseconds through the exact-binding tile index.
import * as previewRecovery from '../src/products/classpilot/lib/classpilotRecovery.js';
import { indexTileScreenshots } from '../src/products/classpilot/lib/tileBatchPolling.js';
import { readFileSync } from 'node:fs';

const PREVIEW_NOW = Date.parse('2026-10-14T12:00:00.000Z');
const previewStudent = (studentId = 'preview-student') => ({ studentId, realtimeBinding: 'current-binding',
  acceptedCapabilities: { screenshotActiveObservationCadenceV1: true } });
const previewFrame = (student, timestamp, bindingVersion = 'v2:current-binding') => ({ studentId: student.studentId,
  bindingVersion, screenshot: { timestamp, capturedAt: new Date(PREVIEW_NOW).toISOString(), bindingVersion, screenshot: 'synthetic-pixel-payload' } });
const previewState = (student, screenshots) => ({ students: [student], screenshots, denied: new Set(), observationStatus: () => 'observed' });

function actualPreviewHealthHook() {
  const source = readFileSync(new URL('../src/products/classpilot/hooks/useClasspilotPreviewRecovery.js', import.meta.url), 'utf8');
  const imports = source.match(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm);
  assert.equal(imports?.length, 3);
  const body = source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace('export function useClasspilotPreviewRecovery', 'function useClasspilotPreviewRecovery');
  return new Function('useEffect', 'useLayoutEffect', 'useRef', 'apiRequest', 'withClasspilotReadDeadline',
    'stepClasspilotPreviewRecovery', 'normalizeClasspilotPreviewTimestamp', body + '\nreturn useClasspilotPreviewRecovery;');
}

async function sampleActualPreviewHealth({ students, screenshots, denied = new Set(), update = () => {}, advanceMs = 0 }) {
  const effects = [], requests = [], queued = [], clientHealthRef = { current: null };
  let now = PREVIEW_NOW, interval = null, intervalMs = null;
  const previous = { document: globalThis.document, now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  globalThis.document = { visibilityState: 'visible' };
  Date.now = () => now;
  globalThis.setInterval = (callback, milliseconds) => { interval = callback; intervalMs = milliseconds; return 'owned-health-interval'; };
  globalThis.clearInterval = () => {};
  let cleanup;
  try {
    const hook = actualPreviewHealthHook()(callback => effects.push(callback), callback => callback(),
      current => ({ current }), (method, endpoint, body) => { requests.push({ method, endpoint, body }); return Promise.resolve({ ok: true }); },
      previewRecovery.withClasspilotReadDeadline, previewRecovery.stepClasspilotPreviewRecovery, previewRecovery.normalizeClasspilotPreviewTimestamp);
    hook({ fastScreenshotStudents: students, screenshotsByStudent: screenshots, screenshotTileReadsEnabled: true,
      deniedScreenshotReadIds: denied, studentView: 'class', claimedStudentObservationStatus: () => 'inactive', observationLeaseStatus: 'observed',
      targetedScreenshotFenceKey: 'exact-current-context', queueTargetedScreenshotRefresh: ids => queued.push(ids),
      screenshotRecoveryRef: { current: new Map() }, clientHealthRef, activeSchoolId: 'synthetic-school', viewerId: 'synthetic-viewer', token: 'synthetic-token' });
    cleanup = effects.at(-1)();
    assert.equal(intervalMs, 5_000);
    for (let tick = 0; tick < 12; tick += 1) { now += advanceMs; update(now, tick); interval(); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].endpoint, '/classpilot/monitoring/client-health');
    assert.equal(requests[0].body.intervalSeconds, 60); assert.deepEqual(queued, []);
    return requests[0].body;
  } finally {
    cleanup?.(); globalThis.document = previous.document; Date.now = previous.now;
    globalThis.setInterval = previous.setInterval; globalThis.clearInterval = previous.clearInterval;
  }
}

test('fresh advancing backend numeric capture timestamps never start extra preview recovery', () => {
  const student = previewStudent(), recoveries = new Map();
  const screenshots = indexTileScreenshots({ tiles: [previewFrame(student, PREVIEW_NOW)] });
  assert.equal(typeof screenshots.get(student.studentId).timestamp, 'number');
  const state = previewState(student, screenshots);
  for (let offset = 0; offset <= 120_000; offset += 5_000) {
    screenshots.set(student.studentId, { ...screenshots.get(student.studentId), timestamp: PREVIEW_NOW + offset });
    const result = stepClasspilotPreviewRecovery(recoveries, { ...state, now: PREVIEW_NOW + offset });
    assert.deepEqual(result.due, []); assert.equal(result.gapRecoveries, 0);
  }
});

test('actual health reporter recognizes numeric backend frames as fresh without extra recovery reads', async () => {
  const student = previewStudent(), screenshots = indexTileScreenshots({ tiles: [previewFrame(student, PREVIEW_NOW)] });
  const body = await sampleActualPreviewHealth({ students: [student], screenshots, advanceMs: 5_000,
    update: now => screenshots.set(student.studentId, { ...screenshots.get(student.studentId), timestamp: now, capturedAt: new Date(now).toISOString() }) });
  assert.deepEqual(body.freshnessBuckets, [12, 0, 0, 0, 0, 0]);
  assert.equal(body.counters.eventGapRecoveries, 0);
});

test('numeric and ISO capture timestamps share canonical skew and invalid-value behavior', () => {
  const normalize = previewRecovery.normalizeClasspilotPreviewTimestamp;
  for (const value of [PREVIEW_NOW - 1_000, new Date(PREVIEW_NOW - 1_000).toISOString(), String(PREVIEW_NOW - 1_000)]) {
    assert.equal(normalize(value, PREVIEW_NOW), PREVIEW_NOW - 1_000);
  }
  for (const value of [PREVIEW_NOW + 60_000, new Date(PREVIEW_NOW + 60_000).toISOString()]) assert.equal(normalize(value, PREVIEW_NOW), PREVIEW_NOW);
  for (const value of [PREVIEW_NOW + 60_001, new Date(PREVIEW_NOW + 60_001).toISOString(), undefined, null, '', 'invalid-time', NaN, Infinity, 0, -1, {}, [], true]) {
    assert.equal(normalize(value, PREVIEW_NOW), null);
  }
  assert.equal(normalize(PREVIEW_NOW, NaN), null);
});

test('numeric and ISO frames keep the original eight-second watchdog and five-second retry cadence', () => {
  for (const encode of [value => value, value => new Date(value).toISOString()]) {
    const student = previewStudent(), recoveries = new Map(), screenshots = new Map([[student.studentId, { timestamp: encode(PREVIEW_NOW), bindingVersion: 'v2:current-binding' }]]);
    const state = previewState(student, screenshots), step = offset => stepClasspilotPreviewRecovery(recoveries, { ...state, now: PREVIEW_NOW + offset });
    assert.deepEqual(step(0).due, []); assert.deepEqual(step(7_999).due, []);
    for (let offset = 8_000; offset <= 98_000; offset += 5_000) {
      const result = step(offset); assert.deepEqual(result.due, [student.studentId]);
      assert.equal(result.nextAt, PREVIEW_NOW + offset + 5_000); assert.equal(result.gapRecoveries, offset === 8_000 ? 1 : 0);
    }
    screenshots.set(student.studentId, { timestamp: encode(PREVIEW_NOW + 100_000), bindingVersion: 'v2:current-binding' });
    assert.deepEqual(step(100_000).due, []); assert.equal(recoveries.get(student.studentId).recovering, false);
    assert.deepEqual(step(107_999).due, []); assert.equal(step(108_000).gapRecoveries, 1);
  }
});

test('actual health bucket boundaries, allowed skew, and invalid future or missing frames agree for both wire formats', async () => {
  for (const encode of [value => value, value => new Date(value).toISOString()]) {
    const ages = [-60_001, -60_000, 0, 5_000, 5_001, 10_000, 10_001, 15_000, 15_001, 30_000, 30_001];
    const students = ages.map((_, index) => previewStudent('bucket-' + index));
    const screenshots = new Map(students.map((student, index) => [student.studentId, { timestamp: encode(PREVIEW_NOW - ages[index]) }]));
    students.push(previewStudent('missing-frame'), previewStudent('invalid-frame'));
    screenshots.set('invalid-frame', { timestamp: 'invalid-time' });
    const body = await sampleActualPreviewHealth({ students, screenshots });
    assert.deepEqual(body.freshnessBuckets, [36, 24, 24, 24, 12, 36]);
  }
});

test('exact binding rejection, denial latches, observation scope and capability gates remain independent of timestamp format', async () => {
  const student = previewStudent(), tile = previewFrame(student, PREVIEW_NOW);
  tile.screenshot.bindingVersion = 'v2:foreign-binding';
  const screenshots = indexTileScreenshots({ tiles: [tile] }); assert.equal(screenshots.get(student.studentId), null);
  const body = await sampleActualPreviewHealth({ students: [student], screenshots }); assert.deepEqual(body.freshnessBuckets, [0, 0, 0, 0, 0, 12]);
  const recoveries = new Map(), state = previewState(student, screenshots);
  stepClasspilotPreviewRecovery(recoveries, { ...state, now: PREVIEW_NOW });
  for (const altered of [{ denied: new Set([student.studentId]) }, { observationStatus: () => 'expired' },
    { students: [{ ...student, acceptedCapabilities: {} }] }]) {
    const result = stepClasspilotPreviewRecovery(recoveries, { ...state, ...altered, now: PREVIEW_NOW + 30_000 });
    assert.deepEqual(result.due, []); assert.equal(recoveries.has(student.studentId), false);
  }
  const denied = await sampleActualPreviewHealth({ students: [student], screenshots, denied: new Set([student.studentId]) });
  assert.deepEqual(denied.freshnessBuckets, [0, 0, 0, 0, 0, 0]);
});

test('preview timestamp recovery does not change student connectivity or revive a retired binding', () => {
  const student = { ...previewStudent(), isOnline: false, connectionStatus: 'offline' }, before = structuredClone(student);
  const screenshots = indexTileScreenshots({ tiles: [previewFrame(student, PREVIEW_NOW)] }), recoveries = new Map();
  const state = previewState(student, screenshots);
  stepClasspilotPreviewRecovery(recoveries, { ...state, now: PREVIEW_NOW });
  student.realtimeBinding = 'successor-binding'; screenshots.clear();
  assert.deepEqual(stepClasspilotPreviewRecovery(recoveries, { ...state, now: PREVIEW_NOW + 7_000 }).due, []);
  assert.equal(recoveries.get(student.studentId).recovering, false); assert.equal(recoveries.get(student.studentId).nextAt, PREVIEW_NOW + 15_000);
  assert.equal(student.isOnline, before.isOnline); assert.equal(student.connectionStatus, before.connectionStatus);
});
