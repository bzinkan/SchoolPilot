import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { createHeartbeatAdmissionGate, HeartbeatAdmissionError, heartbeatAdmissionEnabled,
  withClasspilotHeartbeatAdmission } from '../src/middleware/classpilotHeartbeatAdmission.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Clock {
  time = 0; timers = new Set();
  now = () => this.time;
  setTimer = (callback, ms) => { const timer = { callback, at: this.time + ms, unref() {} }; this.timers.add(timer); return timer; };
  clearTimer = timer => this.timers.delete(timer);
  advance(ms) { this.time += ms; for (const timer of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(timer); timer.callback(); } }
}
function fixture() { const clock = new Clock(); return { clock, gate: createHeartbeatAdmissionGate(clock) }; }
const occupy = gate => Promise.all(Array.from({ length: 8 }, () => gate.acquire()));
function request() {
  const req = Object.assign(new EventEmitter(), { aborted: false, body: {}, headers: {} });
  const res = Object.assign(new EventEmitter(), { locals: {}, destroyed: false, writableEnded: false,
    statusCode: 200, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.writableEnded = true; this.emit('finish'); return this; },
  });
  return { req, res, errors: [] };
}
function run(stages, gate, supplied = request(), enabled = true) {
  const completion = withClasspilotHeartbeatAdmission(stages, { gate, enabled: () => enabled })(
    supplied.req, supplied.res, error => supplied.errors.push(error));
  return { ...supplied, completion };
}
function errorCode(code) { return error => error instanceof HeartbeatAdmissionError && error.code === code; }

test('eight active plus32 FIFO waiters; the33rd waiter is rejected without starting work', async () => {
  const { gate, clock } = fixture(), held = await occupy(gate), order = [];
  const queued = Array.from({ length: 32 }, (_, i) => gate.acquire().then(release => { order.push(i); release(); }));
  await assert.rejects(gate.acquire(), errorCode('full'));
  assert.deepEqual(gate.snapshot(), { active: 8, queued: 32 });
  held[0](); await Promise.all(queued);
  assert.deepEqual(order, Array.from({ length: 32 }, (_, i) => i));
  held.forEach(release => { release(); release(); });
  assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 }); assert.equal(clock.timers.size, 0);
});
test('250ms is absolute even when an expired timer has not run', async () => {
  const { gate, clock } = fixture(), held = await occupy(gate);
  const waiting = gate.acquire(), rejected = assert.rejects(waiting, errorCode('expired'));
  clock.time = 250; held[0](); await rejected;
  assert.deepEqual(gate.snapshot(), { active: 7, queued: 0 });
  held.slice(1).forEach(release => release()); assert.equal(clock.timers.size, 0);
});
test('queued cancellation, timeout and double release settle exactly once', async () => {
  const { gate, clock } = fixture(), held = await occupy(gate), controller = new AbortController();
  const aborted = gate.acquire(controller.signal), checkedAbort = assert.rejects(aborted, errorCode('aborted'));
  controller.abort(); controller.abort(); await checkedAbort;
  const expired = gate.acquire(), checkedExpiry = assert.rejects(expired, errorCode('expired'));
  clock.advance(250); await checkedExpiry;
  held.forEach(release => { release(); release(); });
  assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 }); assert.equal(clock.timers.size, 0);
  await assert.rejects(gate.acquire(controller.signal), errorCode('aborted'));
});
test('overload response is503 with stable code and Retry-After1; no first checkout occurs', async () => {
  const { gate, clock } = fixture(), held = await occupy(gate);
  let checkouts = 0;
  const queued = run([(_req, res) => { checkouts++; res.json({ ok: true }); }], gate);
  await tick(); clock.advance(250); await queued.completion;
  assert.equal(checkouts, 0); assert.equal(queued.res.statusCode, 503);
  assert.equal(queued.res.headers['Retry-After'], '1'); assert.equal(queued.res.body.code, 'CLASSPILOT_HEARTBEAT_BUSY');
  held.forEach(release => release());
});
test('disconnect removes only queued work and removes request listeners', async () => {
  const { gate, clock } = fixture(), held = await occupy(gate); let called = 0;
  const queued = run([() => called++], gate); await tick();
  queued.req.aborted = true; queued.req.emit('aborted'); queued.res.destroyed = true; queued.res.emit('close');
  await queued.completion; assert.equal(called, 0); assert.equal(queued.res.body, undefined);
  assert.deepEqual(gate.snapshot(), { active: 8, queued: 0 }); assert.equal(clock.timers.size, 0);
  assert.equal(queued.req.listenerCount('aborted'), 0); assert.equal(queued.res.listenerCount('close'), 0);
  held.forEach(release => release());
});
test('finish and disconnect cannot release a running SQL/COMMIT/RESET owner', async () => {
  const { gate } = fixture(), sql = deferred(), commit = deferred(), reset = deferred();
  const held = await Promise.all(Array.from({ length: 7 }, () => gate.acquire()));
  const running = run([async (_req, res) => { await sql.promise; res.json({ ok: true }); await commit.promise; await reset.promise; }], gate);
  await tick(); assert.equal(gate.snapshot().active, 8);
  const queued = run([(_req, res) => res.json({ ok: 'next' })], gate); await tick();
  running.req.aborted = true; running.req.emit('aborted'); running.res.emit('close');
  sql.resolve(); await tick(); assert.equal(gate.snapshot().active, 8); assert.equal(gate.snapshot().queued, 1);
  commit.resolve(); await tick(); assert.equal(gate.snapshot().queued, 1);
  reset.resolve(); await Promise.all([running.completion, queued.completion]);
  assert.deepEqual(queued.res.body, { ok: 'next' }); held.forEach(release => release());
  assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 });
});
test('SQL failure remains owned through rollback/discard cleanup before forwarding error', async () => {
  const { gate } = fixture(), rollback = deferred(), discarded = deferred(), failure = new Error('SQL failed');
  const running = run([async () => { try { throw failure; } finally { await rollback.promise; await discarded.promise; } }], gate);
  await tick(); running.res.emit('close'); assert.equal(gate.snapshot().active, 1); assert.deepEqual(running.errors, []);
  rollback.resolve(); await tick(); assert.equal(gate.snapshot().active, 1);
  discarded.resolve(); await running.completion; assert.deepEqual(running.errors, [failure]);
  assert.deepEqual(gate.snapshot(), { active: 0, queued: 0 });
});
test('middleware throwing after next cannot release downstream SQL before its cleanup', async () => {
  const { gate } = fixture(), cleanup = deferred(), failure = new Error('late middleware throw');
  const running = run([(_req, _res, next) => { next(); throw failure; }, async (_req, res) => { res.json({ ok: true }); await cleanup.promise; }], gate);
  await tick(); assert.equal(gate.snapshot().active, 1); assert.deepEqual(running.errors, []);
  cleanup.resolve(); await running.completion; assert.deepEqual(running.errors, [failure]); assert.equal(gate.snapshot().active, 0);
});
test('current entitlement is read after waiting and denied204/outside-window/legacy branches cannot skip it', async () => {
  for (const branch of ['modern', 'legacy', '204', 'outside_window']) {
    const { gate } = fixture(), held = await occupy(gate); let entitled = true, reads = 0, handlerCalls = 0;
    const queued = run([async (_req, res, next) => { reads++; if (!entitled) return res.status(403).json({ code: 'CLASSPILOT_NOT_ENTITLED' }); next(); },
      (_req, res) => { handlerCalls++; return res.status(branch === '204' ? 204 : 200).json({ branch }); }], gate);
    await tick(); assert.equal(reads, 0); entitled = false; held[0](); await queued.completion;
    assert.equal(reads, 1); assert.equal(handlerCalls, 0); assert.equal(queued.res.statusCode, 403);
    held.slice(1).forEach(release => release());
  }
});
test('limiter rejection preserves status and order while entitlement cleanup remains owned', async () => {
  const { gate } = fixture(), cleanup = deferred(), order = [];
  const invocation = run([async (_req, _res, next) => { order.push('entitlement'); next(); await cleanup.promise; },
    (_req, res) => { order.push('device_limiter'); res.status(429).json({ limited: true }); },
    () => order.push('handler')], gate);
  await tick(); assert.deepEqual(order, ['entitlement', 'device_limiter']); assert.equal(gate.snapshot().active, 1);
  cleanup.resolve(); await invocation.completion; assert.equal(invocation.res.statusCode, 429); assert.equal(gate.snapshot().active, 0);
});
test('concurrent and queued request ALS remains exact and never inherits the releasing tenant', async () => {
  const { gate } = fixture(), held = await occupy(gate), context = new AsyncLocalStorage(), seen = [];
  const requests = ['schoolA', 'schoolB'].map(school => context.run({ school, operation: 'original' }, () =>
    run([async (_req, _res, next) => { seen.push(context.getStore()); await tick(); next(); },
      (_req, res) => { seen.push(context.getStore()); res.json({ ok: true }); }], gate)));
  context.run({ school: 'unrelated', operation: 'other' }, () => held[0]());
  await Promise.all(requests.map(invocation => invocation.completion));
  assert.deepEqual(seen.map(value => value.school), ['schoolA', 'schoolA', 'schoolB', 'schoolB']);
  assert.ok(seen.every(value => value.operation === 'original'));
  held.slice(1).forEach(release => release());
});
test('both Usage modes off preserves original statuses and ignores a fully occupied admission gate', async () => {
  const { gate } = fixture(), held = await occupy(gate);
  for (const status of [200, 204, 401, 403, 409, 429]) {
    const result = run([(_req, res) => res.status(status).json({ status })], gate, request(), false);
    await result.completion; assert.equal(result.res.statusCode, status); assert.deepEqual(result.res.body, { status });
    assert.equal(gate.snapshot().queued, 0); assert.equal(gate.snapshot().active, 8);
  }
  held.forEach(release => release());
});
test('admission enables for admitted rollup-only and report modes, and fails closed for malformed/off/unadmitted modes', () => {
  const env = { RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: 'classpilot_usage_rollups,classpilot_usage_rollup_days', CLASSPILOT_USAGE_ROLLUP_MODE: 'on' };
  assert.equal(heartbeatAdmissionEnabled(env), true); assert.equal(heartbeatAdmissionEnabled({ ...env, CLASSPILOT_DIGITAL_USAGE_MODE: 'on' }), true);
  for (const override of [{ CLASSPILOT_USAGE_ROLLUP_MODE: 'off' }, { RLS_GUC_ENABLED: 'false' }, { RLS_ENABLED_TABLES: 'classpilot_usage_rollups' },
    { CLASSPILOT_DIGITAL_USAGE_MODE: 'ON' }, { CLASSPILOT_USAGE_ROLLUP_MODE: 'off', CLASSPILOT_DIGITAL_USAGE_MODE: 'on' }]) {
    assert.equal(heartbeatAdmissionEnabled({ ...env, ...override }), false);
  }
  assert.equal(heartbeatAdmissionEnabled({}), false);
});
