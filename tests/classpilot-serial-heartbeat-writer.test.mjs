import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialHeartbeatWriter } from '../scripts/load/classpilot-reliability-profile.mjs';

const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ send = async () => ({ ok: true }) } = {}) {
  let now = 0, nextTimer = 0, cooldown = 0, inFlight = 0, peakInFlight = 0, snapshots = 0;
  const timers = new Map(), sent = [], state = { identity: 'student-session-a', title: 'initial' };
  const writer = new SerialHeartbeatWriter({
    now: () => now, identity: () => state.identity, cooldownUntil: () => cooldown,
    schedule(callback, ms) { assert.ok(Number.isFinite(ms) && ms > 0); const id = ++nextTimer; timers.set(id, { callback, at: now + ms }); return id; },
    clear: id => timers.delete(id),
    snapshot() { snapshots += 1; return { ...state }; },
    async send(body, metadata) {
      const item = { at: now, body, ...metadata }; sent.push(item);
      inFlight += 1; peakInFlight = Math.max(peakInFlight, inFlight);
      try { return await send(item); } finally { inFlight -= 1; }
    },
  });
  return {
    writer, sent, state, timers,
    set(at) { assert.ok(at >= now); now = at; },
    cooldownUntil(at) { cooldown = at; },
    async advance(at) {
      assert.ok(at >= now); let turns = 0;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= at).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++turns < 1000); timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].callback(); await flush();
      }
      now = at; await flush();
    },
    get peakInFlight() { return peakInFlight; }, get snapshots() { return snapshots; },
  };
}

test('navigation coalesces to the first pending two-second deadline and queries the latest snapshot', async () => {
  const f = fixture(); f.writer.navigation(); f.set(500); f.state.title = 'middle'; f.writer.navigation();
  f.set(1500); f.state.title = 'latest'; f.writer.navigation();
  assert.equal(f.writer.eventDue, 2000); await f.advance(1999); assert.equal(f.sent.length, 0);
  await f.advance(2000); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body.title, 'latest');
  assert.equal(f.sent[0].reason, 'navigation'); assert.equal(f.snapshots, 1); assert.equal(f.timers.size, 0);
});

test('a regular heartbeat before event due leaves one trailing fresh event snapshot', async () => {
  const f = fixture(); f.writer.navigation(); f.set(1000); f.writer.regular(); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].reason, 'regular');
  assert.equal(f.writer.pendingEvent, true); assert.equal(f.writer.eventDue, 2000);
  f.state.title = 'after-regular'; await f.advance(2000);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.title, 'after-regular'); assert.equal(f.sent[1].reason, 'navigation');
});

test('a regular heartbeat may satisfy an already-due event without a duplicate event send', async () => {
  const f = fixture(); f.writer.navigation(); f.set(2000); f.state.title = 'due'; f.writer.regular(); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].reason, 'regular'); assert.equal(f.writer.pendingEvent, false);
  await f.advance(10000); assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 0);
});

test('navigation arriving during a blocked heartbeat drains once after real settlement with fresh state', async () => {
  const gate = deferred(), f = fixture({ send: item => item.reason === 'regular' ? gate.promise : Promise.resolve({ ok: true }) });
  f.writer.regular(); await flush(); f.set(100); f.writer.navigation(); f.set(500); f.state.title = 'newest'; f.writer.navigation();
  assert.equal(f.writer.eventDue, 2100); await f.advance(2500); assert.equal(f.sent.length, 1); assert.equal(f.writer.active, true);
  gate.resolve({ ok: true }); await flush(); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].at, 2500);
  assert.equal(f.sent[1].body.title, 'newest'); assert.equal(f.peakInFlight, 1);
});

test('cooldown and a queued regular send preserve the first event deadline without overlap', async () => {
  const f = fixture(); f.cooldownUntil(5000); f.writer.navigation(); f.set(1000); f.writer.navigation();
  f.set(3000); f.writer.regular(); assert.equal(f.writer.eventDue, 2000);
  await f.advance(4999); assert.equal(f.sent.length, 0); f.state.title = 'after-cooldown'; await f.advance(5000);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].reason, 'regular'); assert.equal(f.sent[0].body.title, 'after-cooldown');
  assert.equal(f.writer.pendingEvent, false); assert.equal(f.peakInFlight, 1);
});

test('hold retains pending event and regular work until both release and raw heartbeat settlement', async () => {
  const gate = deferred(), f = fixture({ send: item => item.body.title === 'initial' ? gate.promise : Promise.resolve({ ok: true }) });
  f.writer.regular(); await flush(); f.writer.hold(); f.set(500); f.writer.navigation(); f.writer.regular(); f.state.title = 'released';
  await f.advance(3000); f.writer.release(); await flush(); assert.equal(f.sent.length, 1);
  gate.resolve({ ok: true }); await flush(); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.title, 'released');
  assert.equal(f.peakInFlight, 1); assert.equal(f.writer.active, false);
});

test('identity change retires an old pending event rather than sending it under the new identity', async () => {
  const f = fixture(); f.writer.navigation(); f.set(1000); f.state.identity = 'student-session-b';
  await f.advance(2000); assert.equal(f.sent.length, 0); assert.equal(f.writer.pendingEvent, false);
  f.writer.navigation(); f.state.title = 'new-identity'; await f.advance(4000);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body.identity, 'student-session-b'); assert.equal(f.sent[0].body.title, 'new-identity');
});

test('an old in-flight denial cannot deny or release queued work for a new identity', async () => {
  const gate = deferred(), f = fixture({ send: item => item.body.identity === 'student-session-a' ? gate.promise : Promise.resolve({ ok: true }) });
  f.writer.regular(); await flush(); f.set(1000); f.state.identity = 'student-session-b'; f.writer.navigation();
  await f.advance(2500); assert.equal(f.sent.length, 1); assert.equal(f.writer.active, true);
  gate.resolve({ denied: true }); await flush(); assert.equal(f.writer.denied, false); assert.equal(f.writer.counters.denied, 0);
  await f.advance(3000); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.identity, 'student-session-b'); assert.equal(f.peakInFlight, 1);
});

test('identity change between reservation and dispatch cannot pair an old snapshot with a new binding', async () => {
  const f = fixture(); f.writer.regular(); f.state.identity = 'student-session-b'; f.state.title = 'fresh'; f.writer.regular(); await flush();
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].body, { identity: 'student-session-b', title: 'fresh' });
  assert.equal(f.writer.counters.started, 1); assert.equal(f.snapshots, 1);
});

for (const outcome of ['failed', 'rejected']) test('a consumed '+outcome+' heartbeat does not invent a retry event', async () => {
  const f = fixture({ send: async () => { if (outcome === 'rejected') throw Error('offline failure'); return { ok: false }; } });
  f.writer.regular(); await flush(); assert.equal(f.writer.counters.failed, 1); assert.equal(f.writer.pendingEvent, false);
  await f.advance(10000); assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 0);
});

test('a failed old heartbeat preserves a genuinely new pending event without resetting its deadline', async () => {
  const gate = deferred(), f = fixture({ send: item => item.reason === 'regular' ? gate.promise : Promise.resolve({ ok: true }) });
  f.writer.regular(); await flush(); f.set(500); f.writer.navigation(); f.set(1200); gate.reject(Error('offline failure')); await flush();
  assert.equal(f.writer.eventDue, 2500); await f.advance(2500); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].reason, 'navigation');
  assert.equal(f.peakInFlight, 1); assert.equal(f.writer.counters.failed, 1);
});

test('a current identity denial stays terminal until the exact identity changes', async () => {
  const f = fixture({ send: async () => ({ denied: true }) }); f.writer.regular(); await flush();
  assert.equal(f.writer.denied, true); f.writer.navigation(); f.writer.regular(); await f.advance(10000); assert.equal(f.sent.length, 1);
  f.state.identity = 'student-session-b'; f.writer.regular(); await flush(); assert.equal(f.sent.length, 2); assert.equal(f.sent[1].body.identity, 'student-session-b');
});

for (const outcome of ['denied', 'failed', 'rejected']) test('an old A '+outcome+' result cannot affect new A work after an observed A-B-A identity transition', async () => {
  const gate = deferred(), f = fixture({ send: item => item.body.title === 'initial' ? gate.promise : Promise.resolve({ ok: true }) });
  f.writer.regular(); await flush(); f.set(1000); f.state.identity = 'student-session-b'; f.writer.navigation();
  f.set(1100); f.state.identity = 'student-session-a'; f.state.title = 'returned-a'; f.writer.navigation();
  assert.equal(f.writer.active, true); assert.equal(f.sent.length, 1); assert.equal(f.writer.eventDue, 3100);
  f.set(1200); if (outcome === 'rejected') gate.reject(Error('retired A failure')); else gate.resolve(outcome === 'denied' ? { denied: true } : { ok: false });
  await flush(); assert.equal(f.writer.denied, false); assert.equal(f.writer.counters.denied, 0); assert.equal(f.writer.counters.failed, 0);
  assert.equal(f.writer.pendingEvent, true); assert.equal(f.writer.eventDue, 3100); await f.advance(3100);
  assert.equal(f.sent.length, 2); assert.deepEqual(f.sent[1].body, { identity: 'student-session-a', title: 'returned-a' }); assert.equal(f.peakInFlight, 1);
});

test('an A-B-A change after reservation drops the retired A dispatch even when its identity value matches again', async () => {
  const f = fixture(); f.writer.regular(); f.state.identity = 'student-session-b'; f.writer.regular();
  f.state.identity = 'student-session-a'; f.state.title = 'returned-a'; f.writer.regular(); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body.title, 'returned-a'); assert.equal(f.writer.counters.started, 1);
});

test('an A-B-A change inside fresh snapshot acquisition fences that snapshot and preserves new pending work', async () => {
  const f = fixture(); let first = true;
  f.writer.snapshot = () => {
    if (!first) return { ...f.state };
    first = false; const retired = { ...f.state }; f.state.identity = 'student-session-b'; f.writer.navigation();
    f.state.identity = 'student-session-a'; f.state.title = 'returned-a'; f.writer.navigation(); return retired;
  };
  f.writer.regular(); await flush(); assert.equal(f.sent.length, 0); assert.equal(f.writer.pendingEvent, true);
  await f.advance(2000); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body.title, 'returned-a'); assert.equal(f.writer.counters.started, 1);
});
