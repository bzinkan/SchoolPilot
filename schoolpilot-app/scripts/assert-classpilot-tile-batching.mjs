import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TILE_BATCH_REFETCH_INTERVAL_MS,
  createTileBatchRequests,
  fetchTileBatchWithRollbackFallback,
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
const healthy = await fetchTileBatchWithRollbackFallback(
  requests[0],
  new Map(),
  async () => {
    healthyRequests += 1;
    return { tiles: [] };
  }
);
assert.deepEqual(healthy, { tiles: [] });
assert.equal(healthyRequests, 1, 'healthy batch polling must make one network request per request descriptor');

let authorization404Requests = 0;
const authorization404 = await fetchTileBatchWithRollbackFallback(
  requests[0],
  new Map(),
  async () => {
    authorization404Requests += 1;
    throw { response: { status: 404, data: { error: 'No accessible tiles' } } };
  }
);
assert.deepEqual(authorization404, { tiles: [] });
assert.equal(authorization404Requests, 1, 'authorization 404 must not activate legacy fan-out');

const rollbackRequest = createTileBatchRequests(studentIds.slice(0, 2))[0];
const legacyDevices = new Map(rollbackRequest.body.studentIds.map((studentId, index) => [studentId, `device-${index}`]));
const rollbackCalls = [];
const rollback = await fetchTileBatchWithRollbackFallback(
  rollbackRequest,
  legacyDevices,
  async (method, endpoint) => {
    rollbackCalls.push([method, endpoint]);
    if (method === 'POST') {
      throw { response: { status: 404, data: { error: 'Not found' } } };
    }
    return { screenshot: 'data:image/jpeg;base64,fixture' };
  }
);
assert.equal(rollbackCalls.length, 3, 'legacy fan-out must activate only after the old backend route 404');
assert.equal(rollback.tiles.length, 2);

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

console.log(`ClassPilot tile batching contract passed (${requests.length} requests for ${studentIds.length} tiles).`);
