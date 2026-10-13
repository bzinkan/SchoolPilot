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
