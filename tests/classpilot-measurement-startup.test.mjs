import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { measurementPlan, measurementExpected, measurementWaiting, validateMeasurementWaiting,
  measurementReadySignal, validateMeasurementReadySignal, measurementPendingSignal, validateMeasurementPendingSignal,
  MeasurementStartupGate, CapturePulseController } from '../scripts/load/classpilot-reliability-profile.mjs';
import { createMeasurementArtifactChannel, establishMeasurementStartup,
  measurementFailureDiagnostic, measurementOperationRetryable } from '../scripts/load/run-classpilot-remote-generator.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const base = Date.now();
const startAt = new Date(base + 120_000).toISOString();
const expected = measurementExpected({ campaign: 'classpilot-staging-20261013-0d1060d261d5', runId: '40-' + 'a'.repeat(16),
  primaryDevices: 40, candidateApiImage: '135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:' + '1'.repeat(64),
  scriptBundleSha256: '2'.repeat(64), files: { devices: { sha256: '3'.repeat(64) } },
  measurementPlan: measurementPlan(40), measurementPlanSha256: digest(JSON.stringify(measurementPlan(40))) }, '4'.repeat(64));
const waiting = mode => measurementWaiting(expected, { startAt, mode, nonce: 'b'.repeat(48), createdAt: new Date(base).toISOString() });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class S3Fixture {
  constructor(handler) { this.config = { maxAttempts: 1, region: 'us-east-1' }; this.handler = handler; this.calls = [];
    this.middlewares = []; this.middlewareStack = { add: value => this.middlewares.push(value) }; }
  async send(command, options) {
    const input = command.input, method = command.constructor.name === 'GetObjectCommand' ? 'GET' : 'PUT';
    const args = { request: { protocol: 'https:', hostname: input.Bucket + '.s3.us-east-1.amazonaws.com',
      path: '/' + input.Key, method, headers: { 'x-amz-expected-bucket-owner': input.ExpectedBucketOwner } } };
    let dispatch = async () => { this.calls.push({ method, input }); return this.handler(command, options); };
    for (const middleware of this.middlewares.slice().reverse()) dispatch = middleware(dispatch);
    return dispatch(args);
  }
  destroy() { this.destroyed = true; }
}
const objectBody = value => ({ Body: Readable.from([Buffer.from(JSON.stringify(value))]) });
function producer(handler, mode = 'workload') {
  const sdk = new S3Fixture(handler);
  return { sdk, channel: createMeasurementArtifactChannel({ role: 'producer', expected, mode, startAt, s3: sdk }) };
}

for (const mode of ['workload', 'channel-preflight']) test('positive waiting and readiness bind exact ' + mode, () => {
  const w = waiting(mode);
  assert.equal(validateMeasurementWaiting(w, expected, { startAt, mode }), w);
  const ready = measurementReadySignal(expected, w);
  assert.equal(validateMeasurementReadySignal(ready, expected, w), ready);
  assert.equal(ready.trafficStarted, false); assert.equal(ready.capacityAcceptance, false);
  assert.equal(ready.waitingNonceSha256, digest(w.nonce));
  assert.throws(() => validateMeasurementWaiting(w, expected, { startAt, mode: mode === 'workload' ? 'channel-preflight' : 'workload' }));
});
for (const key of ['campaign', 'runId', 'candidateApiImage', 'scriptBundleSha256', 'sourceArtifactSha256',
  'cohortSha256', 'planSha256', 'nonce', 'startAt', 'expiresAt', 'mode']) test('waiting rejects changed ' + key, () => {
  const w = { ...waiting('workload'), [key]: 'foreign' };
  assert.throws(() => validateMeasurementWaiting(w, expected, { startAt }));
});
test('waiting rejects unknown fields, future creation and expired bodies', () => {
  const w = waiting('workload');
  assert.throws(() => validateMeasurementWaiting({ ...w, commandAuthority: true }, expected, { startAt }));
  assert.throws(() => validateMeasurementWaiting({ ...w, createdAt: startAt }, expected, { startAt }));
  assert.throws(() => validateMeasurementWaiting(w, expected, { startAt, now: Date.parse(w.expiresAt) }));
});
test('pending and Ready cannot satisfy causal signals or another mode/source/nonce', () => {
  const w = waiting('workload'), pending = measurementPendingSignal(expected, w, 'started');
  assert.equal(validateMeasurementPendingSignal(pending, expected, w, 'started'), pending);
  assert.throws(() => validateMeasurementPendingSignal(pending, expected, w, 'drained'));
  assert.throws(() => validateMeasurementPendingSignal({ ...pending, nonceSha256: 'c'.repeat(64) }, expected, w, 'started'));
  assert.throws(() => validateMeasurementReadySignal(measurementReadySignal(expected, w), expected, { ...w, nonce: 'd'.repeat(48) }));
});
test('waiting never adopts a pulse; actual first pulse requires Ready and t0', () => {
  let now = base;
  const gate = new MeasurementStartupGate(expected, { startAt, now: () => now });
  const w = waiting('workload'), pulse = new CapturePulseController(expected, { now: () => 0 }).issue();
  assert.equal(gate.control(w), null); assert.equal(gate.firstPulse, false);
  assert.throws(() => gate.control(pulse)); gate.markReady();
  assert.throws(() => gate.control(pulse)); assert.equal(gate.firstPulse, false);
  now = Date.parse(startAt); assert.equal(gate.control(w), null); assert.equal(gate.firstPulse, false);
  assert.deepEqual(gate.control(pulse), pulse); assert.equal(gate.firstPulse, true);
});
test('startup nonce is unusable for capture, navigation and drain', () => {
  for (const field of ['nonce', 'navigationNonce', 'revisionDrainNonce']) {
    let now = base; const gate = new MeasurementStartupGate(expected, { startAt, now: () => now });
    const w = waiting('workload'); gate.acceptWaiting(w); gate.markReady(); now = Date.parse(startAt);
    const pulse = new CapturePulseController(expected, { now: () => 0 }).issue();
    assert.throws(() => gate.control({ ...pulse, [field]: w.nonce })); assert.equal(gate.firstPulse, false);
  }
});
test('startup replay, missed readiness and missing pulse1 are hard failures', () => {
  let now = base; const gate = new MeasurementStartupGate(expected, { startAt, now: () => now });
  gate.acceptWaiting(waiting('workload'));
  assert.throws(() => gate.acceptWaiting({ ...waiting('workload'), nonce: 'e'.repeat(48) }));
  now = Date.parse(startAt) - 500; assert.throws(() => gate.markReady());
  const other = new MeasurementStartupGate(expected, { startAt, now: () => base }); other.acceptWaiting(waiting('workload')); other.markReady();
  other.now = () => Date.parse(startAt); const controller = new CapturePulseController(expected, { now: () => 0 });
  controller.issue(); assert.throws(() => other.control(controller.issue()));
});
test('later control cannot revert to waiting, regress, or change an accepted sequence', () => {
  let now = base; const gate = new MeasurementStartupGate(expected, { startAt, now: () => now });
  const w = waiting('workload'); gate.acceptWaiting(w); gate.markReady(); now = Date.parse(startAt);
  const controller = new CapturePulseController(expected, { now: () => 0 }), first = controller.issue();
  gate.control(first); assert.throws(() => gate.control(w));
  assert.throws(() => gate.control({ ...first, nonce: 'e'.repeat(48) }));
  assert.deepEqual(gate.control(first), first);
  controller.issue(); const third = controller.issue(); assert.deepEqual(gate.control(third), third);
  assert.throws(() => gate.control(first));
});
test('factory snapshots a supplied waiting identity before caller mutation', async () => {
  const w = waiting('workload'), original = { ...w };
  const sdk = new S3Fixture(() => objectBody(measurementReadySignal(expected, original)));
  const channel = createMeasurementArtifactChannel({ role: 'controller', expected, startAt, startup: w, s3: sdk });
  try { w.nonce = 'e'.repeat(48); const result = await channel.read('measurement-ready.json');
    assert.equal(result.waitingNonceSha256, digest(original.nonce)); }
  finally { channel.close(); }
});
test('factory cannot publish Ready directly or after failed pending publication', async () => {
  const w = waiting('workload');
  const { channel, sdk } = producer(command => command.constructor.name === 'GetObjectCommand' ? objectBody(w)
    : (() => { throw Error('pending denied'); })());
  try {
    await channel.read('measurement-control.json');
    await assert.rejects(channel.publish('measurement-ready.json', measurementReadySignal(expected, w)));
    assert.equal(sdk.calls.length, 1);
    await assert.rejects(channel.publish('measurement-started.json', measurementPendingSignal(expected, w, 'started')));
    assert.equal(channel.summary().startupFailed, true);
    const before = sdk.calls.length;
    await assert.rejects(channel.publish('measurement-drained.json', measurementPendingSignal(expected, w, 'drained')));
    await assert.rejects(channel.publish('measurement-ready.json', measurementReadySignal(expected, w)));
    assert.equal(sdk.calls.length, before);
  } finally { channel.close(); }
});
test('actual shared startup writes producer pending outputs then Ready before its accepted log', async () => {
  const notifications = [], w = waiting('workload');
  const { sdk, channel } = producer(command => command.constructor.name === 'GetObjectCommand' ? objectBody(w) : {});
  try {
    const gate = await establishMeasurementStartup({ channel, expected, startAt, notify: value => notifications.push(value) });
    assert.equal(gate.ready, true); assert.equal(gate.firstPulse, false);
    assert.deepEqual(sdk.calls.map(call => [call.method, call.input.Key.split('/').slice(-2).join('/')]), [
      ['GET', 'inputs/measurement-control.json'], ['PUT', 'results/measurement-started.json'],
      ['PUT', 'results/measurement-drained.json'], ['PUT', 'results/measurement-ready.json']]);
    assert.equal(notifications.length, 1); assert.equal(notifications[0].kind, 'classpilot-measurement-ready-v1');
    validateMeasurementReadySignal(notifications[0], expected, w);
    assert.deepEqual(notifications[0], JSON.parse(sdk.calls.at(-1).input.Body));
    assert.equal(notifications[0].trafficStarted, false);
    assert(sdk.calls.filter(call => call.method === 'PUT').every(call => call.input.IfNoneMatch === '*'));
    await assert.rejects(channel.publish('measurement-started.json', measurementPendingSignal(expected, w, 'started')));
  } finally { channel.close(); }
});
for (const status of [403, 404]) test('actual shared startup fails closed on storage ' + status, async () => {
  const notifications = [];
  const { channel, sdk } = producer(() => { throw Object.assign(Error('private URL/id'), { $metadata: { httpStatusCode: status } }); });
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, notify: value => notifications.push(value) }),
      error => error.measurementStage === 'waiting-read');
    assert.equal(notifications.length, 0); assert.equal(sdk.calls.length, 1);
  } finally { channel.close(); }
});
test('role prefix mismatch is a storage denial and never readiness', async () => {
  const foreign = { ...expected, campaign: 'classpilot-staging-20261014-abcdefabcdef' };
  const sdk = new S3Fixture(command => {
    assert(!command.input.Key.startsWith('runs/classpilot-staging-20261013-0d1060d261d5/'));
    throw Object.assign(Error('not admitted by role policy'), { $metadata: { httpStatusCode: 403 } });
  });
  const channel = createMeasurementArtifactChannel({ role: 'producer', expected: foreign, startAt, s3: sdk });
  try { await assert.rejects(establishMeasurementStartup({ channel, expected: foreign, startAt })); assert.equal(sdk.calls.length, 1); }
  finally { channel.close(); }
});
test('ignored Ready PUT timeout retains raw guard, emits no Ready and has no ambiguous resend', async () => {
  const late = deferred(), notifications = [], w = waiting('workload');
  const { channel, sdk } = producer(command => command.constructor.name === 'GetObjectCommand' ? objectBody(w)
    : command.input.Key.endsWith('/measurement-ready.json') ? late.promise : {});
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, notify: value => notifications.push(value) }));
    assert.equal(notifications.length, 0); assert.equal(channel.summary().publicationInFlight, true);
    const before = sdk.calls.length;
    await assert.rejects(channel.publish('measurement-ready.json', measurementReadySignal(expected, w)));
    assert.equal(sdk.calls.length, before); late.resolve({}); await delay(10);
    assert.equal(channel.summary().publicationInFlight, false); assert.equal(notifications.length, 0);
    assert.equal(channel.summary().publisher.lateSettlements, 1);
  } finally { late.resolve({}); channel.close(); }
});
test('ignored waiting body timeout retains read guard and gives no positive proof', async () => {
  const late = deferred(), w = waiting('workload'), notifications = [];
  const body = { async *[Symbol.asyncIterator]() { yield await late.promise; }, destroy() {} };
  const { channel, sdk } = producer(() => ({ Body: body }));
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, notify: value => notifications.push(value) }));
    assert.equal(channel.summary().readInFlight, true); assert.equal(notifications.length, 0);
    await assert.rejects(channel.read('measurement-control.json')); assert.equal(sdk.calls.length, 1);
    late.resolve(Buffer.from(JSON.stringify(w))); await delay(10);
    assert.equal(channel.summary().readInFlight, false); assert.equal(notifications.length, 0);
  } finally { late.resolve(Buffer.from(JSON.stringify(w))); channel.close(); }
});
test('safe diagnostics contain only fixed stage/code, without raw messages or identities', () => {
  const value = measurementFailureDiagnostic(Object.assign(Error('token URL customer ID'), {
    measurementStage: 'waiting-read', $metadata: { httpStatusCode: 403 } }));
  assert.deepEqual(value, { schemaVersion: 1, kind: 'measurement-stage-failure-v1', stage: 'waiting-read', code: 'access-denied' });
  assert.equal(JSON.stringify(value).includes('customer'), false);
  assert.equal(measurementFailureDiagnostic(Error('arbitrary'), 'foreign URL').stage, 'unknown');
});
for (const [label, denied] of [['HTTP403', { $metadata: { httpStatusCode: 403 } }],
  ['HTTP404', { $metadata: { httpStatusCode: 404 } }], ['NoSuchKey', { name: 'NoSuchKey' }],
  ['AccessDenied', { name: 'AccessDenied' }]]) {
  for (const [trait, soft] of [['AbortError', { name: 'AbortError' }], ['deadline', { measurementReadCode: 'deadline' }],
    ['busy', { measurementReadCode: 'busy' }]]) test(label + ' stays fatal despite ' + trait, () => {
      assert.equal(measurementOperationRetryable({ ...soft, ...denied }), false);
    });
}

for (const mode of ['workload', 'channel-preflight']) test('startup-only cold headers recover with retained singleflight: ' + mode, async () => {
  const notices = [], w = waiting(mode); let gets = 0, raw = 0, maximum = 0;
  const { channel, sdk } = producer(async command => {
    if (command.constructor.name !== 'GetObjectCommand') return {};
    gets += 1; raw += 1; maximum = Math.max(maximum, raw);
    try { if (gets === 1) await delay(320); return objectBody(w); }
    finally { raw -= 1; }
  }, mode);
  try {
    const gate = await establishMeasurementStartup({ channel, expected, startAt, mode, notify: value => notices.push(value) });
    assert.equal(gate.ready, true); assert.equal(notices.length, 1); assert.equal(gets, 2); assert.equal(maximum, 1);
    assert.equal(sdk.calls.filter(call => call.method === 'PUT').length, 3);
    assert.equal(channel.summary().reader.timeouts, 1); assert.equal(channel.summary().reader.attempts, 2);
    assert.equal(channel.summary().reader.lateSettlements, 1);
  } finally { channel.close(); }
});
test('startup ignored body cancellation holds raw guard through true EOF, late valid body earns no readiness', async () => {
  const bodyDone = deferred(), entered = deferred(), w = waiting('workload'), bytes = Buffer.from(JSON.stringify(w));
  let gets = 0; const notices = [];
  const { channel, sdk } = producer(command => {
    if (command.constructor.name !== 'GetObjectCommand') return {};
    gets += 1;
    return gets === 1 ? { Body: { destroy() {}, async *[Symbol.asyncIterator]() {
      entered.resolve(); yield bytes.subarray(0, 17); await bodyDone.promise; yield bytes.subarray(17);
    } } } : objectBody(w);
  });
  const run = establishMeasurementStartup({ channel, expected, startAt, notify: value => notices.push(value) });
  try {
    await entered.promise; await delay(300);
    assert.equal(gets, 1); assert.equal(channel.summary().readInFlight, true); assert.equal(notices.length, 0);
    assert.equal(sdk.calls.filter(call => call.method === 'PUT').length, 0);
    bodyDone.resolve(); const gate = await run;
    assert.equal(gate.ready, true); assert.equal(gets, 2); assert.equal(notices.length, 1);
    assert.equal(channel.summary().reader.lateSettlements, 1); assert.equal(channel.summary().readInFlight, false);
  } finally { bodyDone.resolve(); channel.close(); await run.catch(() => {}); }
});
for (const denied of [
  { $metadata: { httpStatusCode: 403 }, name: 'AbortError' },
  { $metadata: { httpStatusCode: 404 }, measurementReadCode: 'deadline' },
  { name: 'AccessDenied' }, { name: 'NoSuchKey' },
]) test('late authoritative denial defeats startup retry: ' + JSON.stringify(denied), async () => {
  const notices = []; let gets = 0;
  const { channel, sdk } = producer(async command => {
    assert.equal(command.constructor.name, 'GetObjectCommand'); gets += 1; await delay(320);
    throw Object.assign(Error('private values must not enter diagnostics'), denied);
  });
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, notify: value => notices.push(value) }),
      error => error.measurementStage === 'waiting-read' && !measurementOperationRetryable(error));
    assert.equal(gets, 1); assert.equal(notices.length, 0); assert.equal(sdk.calls.length, 1);
    assert.equal(channel.summary().readInFlight, false);
  } finally { channel.close(); }
});
for (const invalid of ['malformed', 'foreign', 'expired']) test('known late ' + invalid + ' waiting body permanently defeats retry', async () => {
  const done = deferred(), bytes = Buffer.from(invalid === 'malformed' ? '{bad-json' : JSON.stringify({ ...waiting('workload'),
    ...(invalid === 'foreign' ? { sourceArtifactSha256: 'f'.repeat(64) } : { expiresAt: new Date(base - 1).toISOString() }) }));
  const notices = []; let gets = 0;
  const { channel, sdk } = producer(command => {
    assert.equal(command.constructor.name, 'GetObjectCommand'); gets += 1;
    return { Body: { destroy() {}, async *[Symbol.asyncIterator]() { await done.promise; yield bytes; } } };
  });
  const run = establishMeasurementStartup({ channel, expected, startAt, notify: value => notices.push(value) });
  try {
    await delay(300); assert.equal(channel.summary().readInFlight, true); assert.equal(gets, 1);
    done.resolve(); await assert.rejects(run, error => error.measurementStage === 'waiting-read' && !measurementOperationRetryable(error));
    assert.equal(gets, 1); assert.equal(notices.length, 0); assert.equal(sdk.calls.length, 1);
    assert.equal(channel.summary().readInFlight, false);
  } finally { done.resolve(); channel.close(); await run.catch(() => {}); }
});
test('ignored headers consume only the original eight-second monotonic startup budget', async () => {
  const late = deferred(), notices = []; let clock = 0;
  const { channel, sdk } = producer(() => late.promise);
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, monotonicNow: () => clock,
      pause: async milliseconds => { assert(milliseconds <= 100); clock += 1000; }, notify: value => notices.push(value) }),
      error => error.measurementStage === 'waiting-read' && error.measurementReadCode === 'deadline');
    assert.equal(clock, 8000); assert.equal(sdk.calls.length, 1); assert.equal(channel.summary().readInFlight, true);
    assert.equal(channel.summary().reader.timeouts, 1); assert.equal(notices.length, 0);
    late.resolve(objectBody(waiting('workload'))); await delay(0);
    assert.equal(channel.summary().readInFlight, false); assert.equal(channel.summary().reader.lateSettlements, 1);
    assert.equal(sdk.calls.length, 1); assert.equal(notices.length, 0);
  } finally { late.resolve(objectBody(waiting('workload'))); channel.close(); }
});
test('eight-second monotonic budget includes successful waiting and all publications', async () => {
  const notices = []; let clock = 0, gets = 0, puts = 0;
  const { channel, sdk } = producer(command => {
    if (command.constructor.name === 'GetObjectCommand') { gets += 1; clock = 7900; return objectBody(waiting('workload')); }
    puts += 1; clock = 8100; return {};
  });
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, monotonicNow: () => clock,
      notify: value => notices.push(value) }), error => error.measurementStage === 'pending-publish');
    assert.equal(gets, 1); assert.equal(puts, 1); assert.equal(sdk.calls.length, 2); assert.equal(notices.length, 0);
  } finally { channel.close(); }
});
test('prestart fence denies before first GET and denies changed expiry after read', async () => {
  const { channel, sdk } = producer(command => command.constructor.name === 'GetObjectCommand' ? objectBody(waiting('workload')) : {});
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, now: () => Date.parse(startAt) - 500 }));
    assert.equal(sdk.calls.length, 0);
    let wall = base;
    const wrapped = { read: async (...args) => { const value = await channel.read(...args); wall = Date.parse(startAt); return value; },
      publish: (...args) => channel.publish(...args) };
    await assert.rejects(establishMeasurementStartup({ channel: wrapped, expected, startAt, now: () => wall }));
    assert.equal(sdk.calls.filter(call => call.method === 'PUT').length, 0);
  } finally { channel.close(); }
});
test('startup mutation failure is never retried even when its error is read-retryable', async () => {
  const notices = [];
  const { channel, sdk } = producer(command => command.constructor.name === 'GetObjectCommand' ? objectBody(waiting('workload'))
    : Promise.reject(Object.assign(Error('unknown PUT'), { name: 'AbortError' })));
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, notify: value => notices.push(value) }));
    assert.equal(sdk.calls.length, 2); assert.equal(channel.summary().startupFailed, true); assert.equal(notices.length, 0);
  } finally { channel.close(); }
});
test('startup refuses invalid or backward monotonic clocks without SDK work', async () => {
  const { channel, sdk } = producer(() => objectBody(waiting('workload')));
  try {
    for (const value of [NaN, Infinity, -Infinity]) await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, monotonicNow: () => value }));
    let first = true;
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, monotonicNow: () => first ? (first = false, 10) : 9 }));
    assert.equal(sdk.calls.length, 0);
  } finally { channel.close(); }
});

test('initial NaN followed by finite monotonic time refuses before any SDK operation', async () => {
  const notices = []; let samples = 0;
  const { channel, sdk } = producer(() => objectBody(waiting('workload')));
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt,
      monotonicNow: () => ++samples === 1 ? NaN : 0, notify: value => notices.push(value) }), /monotonic/);
    assert.equal(samples, 1); assert.equal(sdk.calls.length, 0); assert.equal(notices.length, 0);
  } finally { channel.close(); }
});

for (const fence of ['monotonic', 'prestart']) test('queued startup publication rechecks ' + fence + ' before dispatch', async () => {
  const notices = []; let clock = 0, wall = base, gets = 0, puts = 0, samples = 0, fenced = false;
  const channel = {
    read: async () => { gets += 1; return waiting('workload'); },
    publish: async () => { puts += 1; return {}; },
    fenceStartup: () => { fenced = true; },
  };
  // The seventh sample reserves the first publication's budget. Advance the
  // virtual clock in the next microtask, ahead of its deferred dispatch. This
  // models suspension between admission and actual mutation invocation.
  await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, now: () => wall,
    monotonicNow: () => {
      samples += 1;
      if (samples === 7) queueMicrotask(() => {
        if (fence === 'monotonic') clock = 8000;
        else wall = Date.parse(startAt);
      });
      return clock;
    }, notify: value => notices.push(value) }), error => error.measurementStage === 'pending-publish');
  assert.equal(gets, 1); assert.equal(puts, 0); assert.equal(notices.length, 0); assert.equal(fenced, true);
});

for (const target of ['started', 'ready']) test('total-budget unknown ' + target + ' PUT permanently fences late acceptance and every startup retry', async () => {
  const late = deferred(), entered = deferred(), notices = []; let clock = 0;
  const w = waiting('workload');
  const { channel, sdk } = producer(command => {
    if (command.constructor.name === 'GetObjectCommand') { clock = target === 'started' ? 7900 : 0; return objectBody(w); }
    if (!command.input.Key.endsWith('/measurement-' + target + '.json')) {
      if (target === 'ready' && command.input.Key.endsWith('/measurement-drained.json')) clock = 7900;
      return {};
    }
    entered.resolve(); return late.promise;
  });
  const run = establishMeasurementStartup({ channel, expected, startAt, monotonicNow: () => clock,
    notify: value => notices.push(value) });
  try {
    await entered.promise;
    await assert.rejects(run, error => error.measurementStage === (target === 'ready' ? 'ready-publish' : 'pending-publish'));
    assert.equal(channel.summary().startupFailed, true); assert.equal(channel.summary().startupAccepted, false);
    assert.equal(channel.summary().publicationInFlight, true); assert.equal(channel.summary().acceptedPending, 0);
    const calls = sdk.calls.length;
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt }));
    await assert.rejects(channel.publish('measurement-drained.json', measurementPendingSignal(expected, w, 'drained')));
    await assert.rejects(channel.publish('measurement-ready.json', measurementReadySignal(expected, w)));
    assert.equal(sdk.calls.length, calls);
    late.resolve({}); await delay(10);
    assert.equal(channel.summary().publicationInFlight, false);
    assert.equal(channel.summary().startupAccepted, false); assert.equal(channel.summary().acceptedPending, 0);
    assert.equal(channel.summary().startupFailed, true); assert.equal(notices.length, 0);
    await assert.rejects(channel.publish('measurement-drained.json', measurementPendingSignal(expected, w, 'drained')));
    assert.equal(sdk.calls.length, calls);
  } finally { late.resolve({}); channel.close(); await run.catch(() => {}); }
});

test('expiry between accepted pending writes and Ready fences every later startup operation', async () => {
  const w = waiting('workload'), notices = []; let afterDrained = false, samplesAfterDrained = 0;
  const { channel, sdk } = producer(command => command.constructor.name === 'GetObjectCommand' ? objectBody(w) : {});
  const wrapped = {
    read: (...args) => channel.read(...args), fenceStartup: () => channel.fenceStartup(),
    publish: async (name, ...args) => {
      const value = await channel.publish(name, ...args);
      if (name === 'measurement-drained.json') afterDrained = true;
      return value;
    },
  };
  try {
    await assert.rejects(establishMeasurementStartup({ channel: wrapped, expected, startAt,
      monotonicNow: () => afterDrained && ++samplesAfterDrained >= 2 ? 8000 : 0,
      notify: value => notices.push(value) }));
    assert.equal(sdk.calls.length, 3); assert.equal(notices.length, 0);
    assert.equal(channel.summary().startupFailed, true); assert.equal(channel.summary().startupAccepted, false);
    assert.equal(channel.summary().acceptedPending, 0);
    await assert.rejects(channel.publish('measurement-ready.json', measurementReadySignal(expected, w)));
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt }));
    assert.equal(sdk.calls.length, 3);
  } finally { channel.close(); }
});

test('late valid waiting identity stays immutable when a later GET changes its nonce', async () => {
  const w = waiting('workload'), notices = []; let gets = 0;
  const { channel, sdk } = producer(async command => {
    assert.equal(command.constructor.name, 'GetObjectCommand'); gets += 1;
    if (gets === 1) return { Body: { destroy() {}, async *[Symbol.asyncIterator]() {
      await delay(320); yield Buffer.from(JSON.stringify(w));
    } } };
    return objectBody({ ...w, nonce: 'c'.repeat(48) });
  });
  try {
    await assert.rejects(establishMeasurementStartup({ channel, expected, startAt, notify: value => notices.push(value) }),
      error => error.measurementStage === 'waiting-read' && !measurementOperationRetryable(error));
    assert.equal(gets, 2); assert.equal(sdk.calls.length, 2); assert.equal(notices.length, 0);
    assert.equal(channel.summary().startupFailed, true); assert.equal(channel.summary().reader.lateSettlements, 1);
  } finally { channel.close(); }
});
