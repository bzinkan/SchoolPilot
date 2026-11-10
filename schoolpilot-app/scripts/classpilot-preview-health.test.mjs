import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as recovery from '../src/products/classpilot/lib/classpilotRecovery.js';
import { indexTileScreenshots } from '../src/products/classpilot/lib/tileBatchPolling.js';

const health = await import('../src/products/classpilot/lib/classpilotPreviewHealth.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const NOW = Date.parse('2026-11-10T12:00:00Z');
const student = (id, extra = {}) => ({ studentId: id, loginState: 'logged_in', lastSeenAt: NOW,
  acceptedCapabilities: { screenshotActiveObservationCadenceV1: true }, ...extra });
function sample(students, screenshots = new Map(), extra = {}) {
  assert.equal(typeof health.createPreviewEligibilityV1, 'function');
  const result = health.createPreviewEligibilityV1();
  health.recordPreviewEligibilityV1(result, { students, screenshots, enabled: true, denied: new Set(),
    observationStatus: () => 'observed', ...extra }, NOW);
  return result;
}

test('qualified online observed missing and stale pixels remain in the denominator', () => {
  const result = sample([student('missing'), student('stale'), student('invalid'), student('metadata-only')], new Map([
    ['stale', { timestamp: NOW - 31_000, screenshot: 'cached-pixels' }],
    ['invalid', { timestamp: 'invalid', screenshot: 'cached-pixels' }], ['metadata-only', { timestamp: NOW }],
  ]));
  assert.deepEqual(result.freshnessBuckets, [0, 0, 0, 0, 1, 3]);
  assert.deepEqual(result.excludedCounts, { readDenied: 0, notObserved: 0, backgroundCadence: 0, monitoringNotCurrent: 0 });
});

test('idle with current telemetry qualifies independently of image presence', () => {
  assert.deepEqual(sample([student('idle', { activityState: 'idle', status: 'idle' })]).freshnessBuckets, [0, 0, 0, 0, 0, 1]);
});

test('excluded cohorts are disjoint and conserve all visible fast-target samples', () => {
  const rows = [student('denied'), student('pending'), student('background', { acceptedCapabilities: {} }),
    student('offline', { lastSeenAt: NOW - 120_000 }), student('qualified')];
  const result = sample(rows, new Map(), { denied: new Set(['denied']),
    observationStatus: row => ['denied', 'pending'].includes(row.studentId) ? 'denied' : 'observed' });
  assert.deepEqual(result.excludedCounts, { readDenied: 1, notObserved: 1, backgroundCadence: 1, monitoringNotCurrent: 1 });
  assert.equal(result.freshnessBuckets.reduce((a, b) => a + b, 0) + Object.values(result.excludedCounts).reduce((a, b) => a + b, 0), rows.length);
  assert.equal(JSON.stringify(result).includes('studentId'), false);
});

test('qualified numeric and ISO timestamps preserve six boundaries and binding rejection', () => {
  const ages = [-60_001, -60_000, 0, 5_000, 5_001, 10_000, 10_001, 15_000, 15_001, 30_000, 30_001];
  for (const encode of [value => value, value => new Date(value).toISOString()]) {
    const rows = ages.map((_, i) => student(String(i)));
    const screenshots = new Map(rows.map((row, i) => [row.studentId, { timestamp: encode(NOW - ages[i]), screenshot: 'cached-pixels' }]));
    assert.deepEqual(sample(rows, screenshots).freshnessBuckets, [3, 2, 2, 2, 1, 1]);
  }
  const screenshots = indexTileScreenshots({ tiles: [{ studentId: 'bound', bindingVersion: 'v2:current',
    screenshot: { timestamp: NOW, bindingVersion: 'v2:retired', screenshot: 'old-private-pixels' } }] });
  assert.deepEqual(sample([student('bound')], screenshots).freshnessBuckets, [0, 0, 0, 0, 0, 1]);
});

test('hidden and disabled views add no qualified or excluded samples', () => {
  assert.deepEqual(sample([student('row')], new Map(), { visible: false }), health.createPreviewEligibilityV1());
  assert.deepEqual(sample([student('row')], new Map(), { enabled: false }), health.createPreviewEligibilityV1());
});

test('the combined qualified and excluded payload stays bounded at6000 samples', () => {
  const result = sample(Array.from({ length: 6_001 }, (_, i) => student(String(i))), new Map(),
    { observationStatus: row => Number(row.studentId) % 2 ? 'pending' : 'observed' });
  assert.equal(result.freshnessBuckets.reduce((a, b) => a + b, 0) + Object.values(result.excludedCounts).reduce((a, b) => a + b, 0), 6_000);
});

function actualHookFactory() {
  const source = readFileSync(new URL('../src/products/classpilot/hooks/useClasspilotPreviewRecovery.js', import.meta.url), 'utf8');
  const body = source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
    .replace('export function useClasspilotPreviewRecovery', 'function useClasspilotPreviewRecovery');
  return new Function('useEffect', 'useLayoutEffect', 'useRef', 'apiRequest', 'withClasspilotReadDeadline',
    'stepClasspilotPreviewRecovery', 'normalizeClasspilotPreviewTimestamp', 'createPreviewEligibilityV1', 'recordPreviewEligibilityV1',
    body + '\nreturn useClasspilotPreviewRecovery;');
}

test('the actual hook preserves legacy buckets and counters while adding fixed qualified diagnostics', async () => {
  const effects = [], posted = []; let tick;
  const previous = { document: globalThis.document, now: Date.now, setInterval, clearInterval };
  globalThis.document = { visibilityState: 'visible' }; Date.now = () => NOW;
  globalThis.setInterval = callback => { tick = callback; return 1; }; globalThis.clearInterval = () => {};
  let cleanup;
  try {
    const hook = actualHookFactory()(fn => effects.push(fn), fn => fn(), current => ({ current }),
      async (_method, _path, body) => { posted.push(body); return {}; }, recovery.withClasspilotReadDeadline,
      recovery.stepClasspilotPreviewRecovery, recovery.normalizeClasspilotPreviewTimestamp,
      health.createPreviewEligibilityV1, health.recordPreviewEligibilityV1);
    hook({ fastScreenshotStudents: [student('fresh'), student('missing'), student('offline', { lastSeenAt: NOW - 120_000 }), student('denied')],
      screenshotsByStudent: new Map([['fresh', { timestamp: NOW, screenshot: 'cached-pixels' }], ['offline', { timestamp: NOW - 120_000, screenshot: 'cached-pixels' }]]),
      screenshotTileReadsEnabled: true, deniedScreenshotReadIds: new Set(['denied']), studentView: 'claimed',
      claimedStudentObservationStatus: () => 'observed', observationLeaseStatus: 'legacy', targetedScreenshotFenceKey: 'scope',
      queueTargetedScreenshotRefresh: () => {}, screenshotRecoveryRef: { current: new Map() }, clientHealthRef: { current: null },
      activeSchoolId: 'school', viewerId: 'viewer', token: 'token' });
    cleanup = effects.at(-1)(); for (let i = 0; i < 12; i++) tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].freshnessBuckets, [12, 0, 0, 0, 12, 12]);
    assert.deepEqual(posted[0].counters, { readTimeouts: 0, reconnects: 0, recoveries: 0, eventGapRecoveries: 0 });
    assert.deepEqual(posted[0].previewEligibilityV1, { version: 1, freshnessBuckets: [12, 0, 0, 0, 0, 12],
      excludedCounts: { readDenied: 12, notObserved: 0, backgroundCadence: 0, monitoringNotCurrent: 12 } });
  } finally { cleanup?.(); globalThis.document = previous.document; Date.now = previous.now;
    globalThis.setInterval = previous.setInterval; globalThis.clearInterval = previous.clearInterval; }
});
