import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createKioskApiClient,
  createKioskPollingController,
  normalizeKioskSnapshot,
  redeemKioskLaunchTicket,
} from '../src/products/passpilot/kioskController.js';
import {
  adoptKioskDeviceId,
  confirmKioskDeviceAdoption,
  getKioskDeviceId,
} from '../src/products/passpilot/kioskDeviceId.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    take() {
      const timer = timers.find((candidate) => !candidate.cleared);
      assert.ok(timer, 'an active timer must be scheduled');
      timer.cleared = true;
      return timer;
    },
  };
}

test('recursive kiosk polling never overlaps and waits for completion before scheduling', async () => {
  const timers = fakeTimers();
  const pending = [];
  let active = 0;
  let maximumActive = 0;
  const results = [];
  const controller = createKioskPollingController({
    request: ({ signal }) => new Promise((resolve, reject) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const finish = (callback, value) => {
        active -= 1;
        callback(value);
      };
      signal.addEventListener('abort', () => {
        const error = new Error('superseded');
        error.name = 'AbortError';
        finish(reject, error);
      }, { once: true });
      pending.push({ resolve: (value) => finish(resolve, value), signal });
    }),
    onResult: (value) => results.push(value.revision),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0.5,
  });

  controller.start();
  assert.equal(pending.length, 1);
  assert.equal(timers.timers.length, 0, 'no next poll is scheduled while a request is active');

  controller.refresh();
  assert.equal(pending[0].signal.aborted, true, 'superseded work must be aborted');
  assert.equal(pending.length, 1, 'replacement waits for the aborted request to settle');
  await flush();
  assert.equal(pending.length, 2);
  assert.equal(maximumActive, 1);

  pending[1].resolve({ revision: 2 });
  await flush();
  assert.deepEqual(results, [2]);
  assert.equal(timers.take().delay, 5_000);
  controller.stop();
});

test('failure polling uses jittered 5/10/20/30 second backoff and recovers to five seconds', async () => {
  const timers = fakeTimers();
  let attempt = 0;
  const statuses = [];
  const healthEvents = [];
  const controller = createKioskPollingController({
    request: async () => {
      attempt += 1;
      if (attempt <= 5) throw new Error(`offline-${attempt}`);
      return { revision: attempt };
    },
    onStatus: (status) => statuses.push(status),
    onHealthEvent: (event) => healthEvents.push(event),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 0.5,
  });

  controller.start();
  await flush();
  for (const expected of [5_000, 10_000, 20_000, 30_000, 30_000]) {
    const timer = timers.take();
    assert.equal(timer.delay, expected);
    timer.callback();
    await flush();
  }
  assert.equal(timers.take().delay, 5_000);
  assert.equal(statuses.some((status) => status.isOffline), true);
  assert.equal(statuses.at(-1).isOffline, false);
  assert.deepEqual(healthEvents, [
    { event: 'snapshot_failure', consecutiveFailures: 3, reason: 'network' },
    { event: 'snapshot_recovery', consecutiveFailures: 5 },
  ]);
  controller.stop();
});

test('older server revisions are discarded without replacing last-known-good state', async () => {
  const timers = fakeTimers();
  const revisions = [8, 7];
  const committed = [];
  const controller = createKioskPollingController({
    request: async () => ({ revision: revisions.shift() }),
    onResult: (value) => committed.push(value.revision),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  controller.start();
  await flush();
  timers.take().callback();
  await flush();
  assert.deepEqual(committed, [8]);
  assert.equal(controller.getState().latestDataRevision, 8);
  controller.stop();
});

test('kiosk API client prefers a short-lived token and falls back to PIN only for legacy servers', async () => {
  const tokenCalls = [];
  const tokenClient = createKioskApiClient({
    schoolId: 'school-1',
    pin: '2468',
    fetchImpl: async (url, options) => {
      tokenCalls.push({ url, options });
      return url.endsWith('/auth')
        ? new Response(JSON.stringify({ token: 'signed-token', expiresInSeconds: 900 }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await tokenClient.request('/api/passpilot/kiosk/config');
  assert.equal(tokenCalls[1].options.headers['X-Kiosk-Token'], 'signed-token');
  assert.equal('X-Kiosk-Pin' in tokenCalls[1].options.headers, false);
  assert.equal(tokenCalls[1].options.credentials, 'omit');

  const legacyCalls = [];
  const legacyClient = createKioskApiClient({
    schoolId: 'school-1',
    pin: '2468',
    fetchImpl: async (url, options) => {
      legacyCalls.push({ url, options });
      return url.endsWith('/auth')
        ? new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await legacyClient.request('/api/passpilot/kiosk/config');
  assert.equal(legacyCalls[1].options.headers['X-Kiosk-Pin'], '2468');
  assert.equal('X-Kiosk-Token' in legacyCalls[1].options.headers, false);

  const rejectedClient = createKioskApiClient({
    schoolId: 'school-1',
    pin: '2468',
    fetchImpl: async () => new Response(JSON.stringify({
      error: 'Kiosk access is disabled.',
      code: 'PASSPILOT_KIOSK_DISABLED',
    }), { status: 404 }),
  });
  await assert.rejects(
    () => rejectedClient.request('/api/passpilot/kiosk/config'),
    (error) => error.code === 'PASSPILOT_KIOSK_DISABLED',
    'a domain-coded 404 must fail closed instead of activating legacy PIN mode',
  );
});

test('snapshot normalization joins active passes without exposing transport shape to pages', () => {
  const snapshot = normalizeKioskSnapshot({
    revision: 12,
    config: { source: 'classpilot_groups', classId: 'class-1', className: 'Biology' },
    session: { id: 'session-1', status: 'active' },
    roster: { students: [{ id: 'student-1', firstName: 'Ada', lastName: 'Student' }] },
    passes: [{ id: 'pass-1', studentId: 'student-1', destination: 'nurse' }],
  });
  assert.equal(snapshot.classId, 'class-1');
  assert.equal(snapshot.students[0].activePass.id, 'pass-1');
});

test('concurrent StrictMode launch-ticket redemption shares one one-use request', async () => {
  let calls = 0;
  const client = {
    async request(url, options) {
      calls += 1;
      assert.equal(url, '/api/passpilot/kiosk/launch-ticket/redeem');
      assert.deepEqual(JSON.parse(options.body), { ticket: 'ticket-1' });
      await flush();
      return new Response(JSON.stringify({
        continuityOnly: true,
        deviceId: '22222222-2222-4222-8222-222222222222',
      }), { status: 200 });
    },
  };
  const [first, second] = await Promise.all([
    redeemKioskLaunchTicket({ client, ticket: 'ticket-1' }),
    redeemKioskLaunchTicket({ client, ticket: 'ticket-1' }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test('kiosk continuity storage is school-scoped and migrates the legacy key once', () => {
  const values = new Map([
    ['pp_kiosk_device', '11111111-1111-4111-8111-111111111111'],
  ]);
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };

  try {
    const schoolA = adoptKioskDeviceId('22222222-2222-4222-8222-222222222222', 'school-a');
    assert.equal(schoolA.previousId, '11111111-1111-4111-8111-111111111111');
    assert.equal(values.has('pp_kiosk_device'), false, 'the global key must not remain linkable');
    assert.equal(values.get('pp_kiosk_device:school-a'), schoolA.id);
    confirmKioskDeviceAdoption(schoolA.id, 'school-a');

    const schoolB = adoptKioskDeviceId('33333333-3333-4333-8333-333333333333', 'school-b');
    assert.equal(schoolB.previousId, null, 'a second school must not inherit school A continuity');
    assert.equal(getKioskDeviceId('school-a'), schoolA.id);
    assert.equal(getKioskDeviceId('school-b'), schoolB.id);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('both kiosk pages use one shared controller and contain no interval polling', async () => {
  const files = await Promise.all([
    readFile(new URL('../src/products/passpilot/pages/Kiosk.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/passpilot/pages/KioskSimple.jsx', import.meta.url), 'utf8'),
  ]);
  for (const source of files) {
    assert.equal((source.match(/useKioskPollingController\(\{/g) || []).length, 1);
    assert.doesNotMatch(source, /setInterval\s*\(/);
    assert.doesNotMatch(source, /\bfetch\s*\(/, 'all kiosk requests must pass through token-aware transport');
    assert.match(source, /KioskOfflineBanner/);
    assert.match(source, /response\.status === 404 && !data\?\.code/);
  }
});
