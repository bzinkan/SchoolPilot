import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TILE_BATCH_REFETCH_INTERVAL_MS,
  createTileBatchRequests,
  fetchTileBatch,
} from '../src/products/classpilot/lib/tileBatchPolling.js';

const studentIds = Array.from({ length: 40 }, (_, index) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
);
const requests = createTileBatchRequests(studentIds);

assert.equal(requests.length, 2, 'forty tiles must use exactly two polling requests');
assert.deepEqual(
  requests.map((request) => request.endpoint),
  ['/classpilot/tiles/screenshots', '/classpilot/tiles/history']
);
assert.ok(requests.every((request) => request.body.studentIds.length === 40));
assert.ok(requests.every((request) => request.refetchInterval === TILE_BATCH_REFETCH_INTERVAL_MS));
assert.equal(requests[1].body.limit, 10);
assert.equal(JSON.stringify(requests).includes('deviceId'), false, 'batch requests must expose only student IDs');

let healthyRequests = 0;
const requestSignal = new AbortController().signal;
const healthy = await fetchTileBatch(
  requests[0],
  async (method, endpoint, body, config) => {
    healthyRequests += 1;
    assert.equal(method, 'POST');
    assert.equal(endpoint, requests[0].endpoint);
    assert.deepEqual(body, requests[0].body);
    assert.equal(config.signal, requestSignal);
    return { tiles: [] };
  },
  requestSignal,
);
assert.deepEqual(healthy, { tiles: [] });
assert.equal(healthyRequests, 1, 'healthy batch polling must make one network request per request descriptor');

let failedBatchRequests = 0;
await assert.rejects(
  fetchTileBatch(
    requests[0],
    async () => {
      failedBatchRequests += 1;
      throw Object.assign(new Error('Not found'), {
        response: { status: 404, data: { error: 'Not found' } },
      });
    },
  ),
  /Not found/,
);
assert.equal(failedBatchRequests, 1, 'a failed cohort request must never fan out per student');

const fiftyStudentIds = Array.from({ length: 50 }, (_, index) =>
  `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
);
const fiftyStudentRequests = createTileBatchRequests(fiftyStudentIds);
assert.equal(fiftyStudentRequests.length, 2, 'fifty tiles must still use exactly two polling requests');
assert.ok(fiftyStudentRequests.every((request) => request.body.studentIds.length === 50));

const fiftyOneStudentRequests = createTileBatchRequests([
  ...fiftyStudentIds,
  '20000000-0000-4000-8000-000000000000',
]);
assert.equal(fiftyOneStudentRequests.length, 4, 'larger rosters must use another bounded request pair');
assert.deepEqual(
  fiftyOneStudentRequests.map((request) => request.body.studentIds.length),
  [50, 50, 1, 1]
);
assert.equal(
  new Set(fiftyOneStudentRequests.flatMap((request) => request.body.studentIds)).size,
  51,
  'chunking must not drop students'
);

const studentTileSource = await readFile(
  new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url),
  'utf8'
);
const dashboardSource = await readFile(
  new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
  'utf8'
);

assert.equal(
  /`\/heartbeats\/\$\{student\.primaryDeviceId\}`/.test(studentTileSource),
  false,
  'StudentTile must not poll per-device history'
);
assert.equal(
  /`\/device\/screenshot\/\$\{student\.primaryDeviceId\}`/.test(studentTileSource),
  false,
  'StudentTile must not poll per-device screenshots'
);
assert.match(dashboardSource, /historyByStudent\.get\(student\.studentId\)/);
assert.match(dashboardSource, /screenshotsByStudent\.get\(student\.studentId\)/);
assert.match(dashboardSource, /data-testid="tile-cohort-refresh-error"/);
assert.doesNotMatch(
  dashboardSource,
  /failedScreenshotStudentIds|failedHistoryStudentIds/,
  'a cohort refresh failure must not blank otherwise usable per-student data',
);
assert.doesNotMatch(
  await readFile(new URL('../src/products/classpilot/lib/tileBatchPolling.js', import.meta.url), 'utf8'),
  /\/device\/screenshot|\/heartbeats\//,
  'tile polling must not contain a legacy per-device fallback',
);

console.log(`ClassPilot tile batching contract passed (${requests.length} requests for ${studentIds.length} tiles).`);
