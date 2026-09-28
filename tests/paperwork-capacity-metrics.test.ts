import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadProbeEvidence, measureReadProbe, nearestRankPercentile, recordReadProbe } from '../scripts/load/paperwork/latency-metrics.mjs';

test('capacity p95 uses the same nearest-rank estimator for baseline, windows and endpoints', () => {
  const window = [...Array.from({ length: 19 }, () => 20), 80];
  assert.equal(nearestRankPercentile(window, .95), 20);
  assert.equal(nearestRankPercentile([...Array.from({ length: 18 }, () => 20), 30, 80], .95), 30);
  assert.equal(nearestRankPercentile(Array.from({ length: 120 }, (_, index) => index + 1), .95), 114);
  assert.equal(nearestRankPercentile(Array.from({ length: 40 }, (_, index) => index + 1), .95), 38);
  assert.equal(nearestRankPercentile([3, 1, 2], .95), 3);
  assert.equal(nearestRankPercentile([], .95), null);
  const original = [...window];
  nearestRankPercentile(window, .5);
  assert.deepEqual(window, original);
  assert.throws(() => nearestRankPercentile([Number.NaN], .95), /INVALID_LATENCY_SAMPLE/);
});

test('capacity probe evidence retains exact bounded metadata on success and failure', () => {
  const evidence = createReadProbeEvidence();
  recordReadProbe(evidence, { path: '/api/mydesk/capabilities', phase: 'baseline', startedAtMs: 10, durationMs: 23.125, status: 200 });
  recordReadProbe(evidence, { path: '/api/classpilot/groups', phase: 'preparing', startedAtMs: 50, durationMs: 81.375, status: null });
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)).samples, evidence.samples);
  assert.equal(evidence.measurement, 'full_request_including_body_parse');
  assert.equal(evidence.samples[1]?.status, null);
  assert.throws(() => recordReadProbe(evidence, { path: '/api/students/private-id', phase: 'preparing', startedAtMs: 1, durationMs: 2, status: 200 }), /INVALID_LATENCY_SAMPLE/);
  evidence.maxSamples = 2;
  assert.throws(() => recordReadProbe(evidence, { path: '/api/classpilot/groups', phase: 'preparing', startedAtMs: 100, durationMs: 4, status: 200 }), /LATENCY_SAMPLE_LIMIT/);
  assert.equal(evidence.samples.length, 2);
});

test('capacity timing includes the awaited body operation and persists failed reads', async () => {
  const evidence = createReadProbeEvidence();
  let clock = 100;
  let finishBody = () => {};
  const body = new Promise<void>(resolve => { finishBody = resolve; });
  const measured = measureReadProbe(evidence, { path: '/api/classpilot/teacher/settings', phase: 'preparing' },
    async () => { await body; return { status: 200, data: 'not retained' }; },
    { now: () => clock, originMs: 90 });
  assert.equal(evidence.samples.length, 0);
  clock = 180;
  finishBody();
  assert.equal((await measured).durationMs, 80);
  assert.deepEqual(evidence.samples[0], { path: '/api/classpilot/teacher/settings', phase: 'preparing', startedAtMs: 10, durationMs: 80, status: 200 });
  await assert.rejects(measureReadProbe(evidence, { path: '/api/classpilot/groups', phase: 'continuations' },
    async () => { clock = 195; throw new Error('synthetic read failure'); },
    { now: () => clock, originMs: 90 }), /synthetic read failure/);
  assert.deepEqual(evidence.samples[1], { path: '/api/classpilot/groups', phase: 'continuations', startedAtMs: 90, durationMs: 15, status: null });
  assert.doesNotMatch(JSON.stringify(evidence), /not retained|synthetic read failure/);
});
