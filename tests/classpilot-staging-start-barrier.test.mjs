import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateStagingInputFreshness, validateStagingRunManifest, validateStagingStartAt,
  waitForStagingStart } from '../scripts/load/staging-start-barrier.mjs';
import { reliabilityProfile } from '../scripts/load/classpilot-reliability-profile.mjs';

const origin = 'https://staging.school-pilot.net';
const epoch = Date.parse('2026-10-13T20:00:00.000Z');
const utc = offset => new Date(epoch + offset).toISOString();
const manifest = () => ({ version: 1, campaign: 'classpilot-staging-20261013-0d1060d261d5', runId: '40-0123456789abcdef',
  primaryDevices: 40, candidateApiImage: `135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:${'a'.repeat(64)}`,
  scriptBundleSha256: 'b'.repeat(64), createdAt: utc(-1000), startAt: utc(240_000),
  files: Object.fromEntries(['devices', 'auth', 'commands'].map(key => [key, { bytes: 2, sha256: 'c'.repeat(64) }])) });

test('start selection requires strict canonical UTC, bounded future staging and no production or missing-stage bypass', () => {
  assert.equal(validateStagingStartAt(utc(300_000), origin, epoch), epoch + 300_000);
  assert.equal(validateStagingStartAt(undefined, 'http://127.0.0.1:9', epoch), null);
  for (const start of [undefined, utc(0), utc(-1), utc(300_001), '2026-10-13T20:01:00Z',
    '2026-10-13T20:01:00.000+00:00', '2026-02-30T20:01:00.000Z']) assert.throws(() => validateStagingStartAt(start, origin, epoch));
  assert.throws(() => validateStagingStartAt(utc(1000), 'https://school-pilot.net', epoch));
  assert.throws(() => validateStagingStartAt(utc(1000), 'http://127.0.0.1:9', epoch), 'a staging barrier cannot become a loopback acceleration knob');
});

test('run manifest binds one start, exact auth bytes and full profile without duration overrides', () => {
  const value = manifest(), expected = { primaryDevices: 40, startAt: value.startAt, authSha256: 'c'.repeat(64) };
  assert.equal(validateStagingRunManifest(value, expected, epoch), value);
  for (const change of [{ startAt: utc(240_001) }, { primaryDevices: 800 }, { durationSeconds: 1 },
    { createdAt: utc(-900_001) }, { candidateApiImage: value.candidateApiImage.replace('staging', 'production') }]) {
    assert.throws(() => validateStagingRunManifest({ ...value, ...change }, expected, epoch));
  }
  assert.throws(() => validateStagingRunManifest(value, { ...expected, authSha256: 'd'.repeat(64) }, epoch));
  assert.deepEqual([40, 500, 800].map(count => reliabilityProfile(count).durationSeconds), [600, 1800, 5400]);
});

test('both independent actors publish readiness then start the same full-profile clock at one absolute instant', async () => {
  const actor = async () => {
    let wall = epoch, mono = 123;
    const readiness = [];
    const result = await waitForStagingStart({ startAt: utc(2000), origin, inputCreatedAt: utc(-1000),
      wallNow: () => wall, monotonicNow: () => mono, onReady: ready => readiness.push(ready),
      sleep: async milliseconds => { assert.equal(readiness.length, 1); wall += milliseconds; mono += milliseconds; } });
    assert.equal(readiness[0].readyAt, utc(0)); assert.equal(result.startSkewMs, 0);
    assert.equal(result.actualStartedAt, utc(2000)); assert.equal(result.monotonicStartedAt, 2123);
    return result;
  };
  const [fleet, browser] = await Promise.all([actor(), actor()]);
  assert.equal(fleet.plannedStartAt, browser.plannedStartAt);
  assert.equal(fleet.actualStartedAt, browser.actualStartedAt);
});

test('late preparation, delayed ready publication and missed callback fail instead of starting late', async () => {
  await assert.rejects(waitForStagingStart({ startAt: utc(500), origin, inputCreatedAt: utc(-1000), wallNow: () => epoch, monotonicNow: () => 0 }), /readiness margin/);
  let wall = epoch, mono = 0;
  await assert.rejects(waitForStagingStart({ startAt: utc(2000), origin, inputCreatedAt: utc(-1000), wallNow: () => wall,
    monotonicNow: () => mono, onReady: () => { wall += 2500; mono += 2500; } }), /readiness completed/);
  wall = epoch; mono = 0;
  await assert.rejects(waitForStagingStart({ startAt: utc(2000), origin, inputCreatedAt: utc(-1000), wallNow: () => wall,
    monotonicNow: () => mono, sleep: async milliseconds => { wall += milliseconds + 4000; mono += milliseconds + 4000; } }), /missed.*deadline/);
});

test('clock jumps, cancellation and input freshness expiry cannot silently change a campaign start', async () => {
  let wall = epoch, mono = 0;
  await assert.rejects(waitForStagingStart({ startAt: utc(2000), origin, inputCreatedAt: utc(-1000), wallNow: () => wall,
    monotonicNow: () => mono, sleep: async milliseconds => { wall += milliseconds + 1001; mono += milliseconds; } }), /wall clock changed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForStagingStart({ startAt: utc(2000), origin, inputCreatedAt: utc(-1000), wallNow: () => epoch,
    monotonicNow: () => 0, signal: controller.signal }), /cancelled/);
  wall = epoch; mono = 0;
  await assert.rejects(waitForStagingStart({ startAt: utc(2000), origin, inputCreatedAt: utc(-899_000), wallNow: () => wall,
    monotonicNow: () => mono, sleep: async milliseconds => { wall += milliseconds; mono += milliseconds; } }), /fifteen minutes/);
  assert.throws(() => validateStagingInputFreshness(utc(1), epoch));
});
