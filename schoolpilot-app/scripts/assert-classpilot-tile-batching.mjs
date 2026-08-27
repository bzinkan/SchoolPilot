import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QueryClient } from '@tanstack/react-query';
import {
  TILE_BATCH_REFETCH_INTERVAL_MS,
  createTileBatchRequests,
  fetchTileBatch,
  removeStudentsFromTileBatchData,
  retainFreshTileScreenshotsOnNull,
} from '../src/products/classpilot/lib/tileBatchPolling.js';
import {
  purgeAllScreenshotTileCaches,
  purgeAllStudentTileCaches,
  tileBatchFailureScope,
} from '../src/products/classpilot/lib/tileCachePrivacy.js';

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

const contextBoundRequests = createTileBatchRequests([
  { studentId: studentIds[0], realtimeBinding: 'binding-a' },
], {
  schoolId: 'school-1',
  viewerId: 'staff-1',
  authority: 'observed-class:class',
  teachingSessionId: 'session-1',
});
const replacementBindingRequests = createTileBatchRequests([
  { studentId: studentIds[0], realtimeBinding: 'binding-b' },
], {
  schoolId: 'school-1',
  viewerId: 'staff-1',
  authority: 'observed-class:class',
  teachingSessionId: 'session-1',
});
assert.equal(contextBoundRequests[0].body.teachingSessionId, 'session-1');
const claimedCoverageRequests = createTileBatchRequests([
  { studentId: studentIds[0], realtimeBinding: 'binding-a' },
], {
  schoolId: 'school-1',
  viewerId: 'staff-1',
  authority: 'teacher:claimed',
});
assert.equal(
  Object.hasOwn(claimedCoverageRequests[0].body, 'teachingSessionId'),
  false,
  'claimed coverage reads must retain supervision-context authorization without a class session ID',
);
assert.notDeepEqual(
  contextBoundRequests[0].queryKey,
  replacementBindingRequests[0].queryKey,
  'a public realtime-binding change must isolate cached screenshot pixels',
);
assert.equal(
  JSON.stringify(contextBoundRequests).includes('deviceId'),
  false,
  'context-bound requests must still expose no device IDs',
);

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

const authorizedTile = { studentId: studentIds[1], screenshot: { imageData: 'authorized' } };
const cachedBatch = {
  tiles: [
    { studentId: studentIds[0], screenshot: { imageData: 'revoked' } },
    authorizedTile,
  ],
};
const purgedBatch = removeStudentsFromTileBatchData(cachedBatch, [studentIds[0]]);
assert.deepEqual(
  purgedBatch.tiles.map((tile) => tile.studentId),
  [studentIds[1]],
  'active cohort cache cleanup must remove only the revoked student row',
);
assert.equal(
  purgedBatch.tiles[0],
  authorizedTile,
  'active cohort cache cleanup must preserve authorized classmates and their row identity',
);
assert.equal(
  removeStudentsFromTileBatchData(cachedBatch, ['missing-student']),
  cachedBatch,
  'a no-op cleanup must preserve the cached response identity',
);

const cachedHistory = new Map([
  [studentIds[0], [{ activeTabUrl: 'https://revoked.example' }]],
  [studentIds[1], [{ activeTabUrl: 'https://authorized.example' }]],
]);
const purgedHistory = removeStudentsFromTileBatchData(cachedHistory, new Set([studentIds[0]]));
assert.equal(purgedHistory.has(studentIds[0]), false);
assert.deepEqual(purgedHistory.get(studentIds[1]), cachedHistory.get(studentIds[1]));

const screenshotCapturedAtMs = Date.parse('2026-08-27T12:00:00.000Z');
const priorScreenshot = {
  screenshot: 'data:image/jpeg;base64,prior',
  timestamp: screenshotCapturedAtMs,
};
const priorScreenshotResponse = {
  tiles: [{ studentId: studentIds[0], screenshot: priorScreenshot }],
};
const successfulNullResponse = {
  tiles: [{ studentId: studentIds[0], screenshot: null }],
};
const retainedAtThirtySeconds = retainFreshTileScreenshotsOnNull(
  priorScreenshotResponse,
  successfulNullResponse,
  screenshotCapturedAtMs + 30_000,
);
assert.equal(
  retainedAtThirtySeconds.tiles[0].screenshot,
  priorScreenshot,
  'a same-query 200 null may retain its original screenshot inside the 75-second window',
);
const hiddenAtSeventyFiveSeconds = retainFreshTileScreenshotsOnNull(
  priorScreenshotResponse,
  successfulNullResponse,
  screenshotCapturedAtMs + 75_000,
);
assert.equal(
  hiddenAtSeventyFiveSeconds.tiles[0].screenshot,
  null,
  'a successful null must hide the prior preview at its original 75-second boundary',
);
assert.deepEqual(
  retainFreshTileScreenshotsOnNull(priorScreenshotResponse, { tiles: [] }, screenshotCapturedAtMs + 30_000),
  { tiles: [] },
  'an omitted/unauthorized row must never inherit a prior screenshot',
);

const privacyQueryClient = new QueryClient();
assert.equal(tileBatchFailureScope({ response: { status: 403 } }), 'global');
assert.equal(tileBatchFailureScope({ response: { status: 404 } }), 'cohort');
assert.equal(tileBatchFailureScope({ response: { status: 503 } }), 'transient');
const visibleScreenshotKey = ['/api/classpilot/tiles/screenshots', 'authority-a', 'visible'];
const offFilterScreenshotKey = ['/api/classpilot/tiles/screenshots', 'authority-a', 'off-filter'];
const offFilterHistoryKey = ['/api/classpilot/tiles/history', 'authority-a', 'off-filter'];
privacyQueryClient.setQueryData(visibleScreenshotKey, cachedBatch);
privacyQueryClient.setQueryData(offFilterScreenshotKey, cachedBatch);
privacyQueryClient.setQueryData(offFilterHistoryKey, cachedBatch);
await purgeAllStudentTileCaches(privacyQueryClient);
assert.equal(privacyQueryClient.getQueryData(visibleScreenshotKey), undefined);
assert.equal(
  privacyQueryClient.getQueryData(offFilterScreenshotKey),
  undefined,
  'a viewer-global 403 must purge a second cached cohort hidden by the current search filter',
);
assert.equal(privacyQueryClient.getQueryData(offFilterHistoryKey), undefined);

privacyQueryClient.setQueryData(offFilterScreenshotKey, cachedBatch);
privacyQueryClient.setQueryData(offFilterHistoryKey, cachedBatch);
await purgeAllScreenshotTileCaches(privacyQueryClient);
assert.equal(
  privacyQueryClient.getQueryData(offFilterScreenshotKey),
  undefined,
  'claimed coverage without a supervision observation lease must fail private for pixels',
);
assert.equal(
  privacyQueryClient.getQueryData(offFilterHistoryKey),
  cachedBatch,
  'claimed coverage may preserve its independently authorized sessionless heartbeat history',
);
privacyQueryClient.clear();

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
assert.match(
  dashboardSource,
  /teachingSessionId: studentView === 'class' \? effectiveSessionId \|\| '' : ''/,
  'only teacher/admin Observe class tiles may bind reads to a frozen teaching session',
);
assert.match(
  dashboardSource,
  /detailHistoryTeachingSessionId = studentView === 'class'[\s\S]{0,120}\? effectiveSessionId[\s\S]{0,900}selectedStudentRow\?\.realtimeBinding/,
  'detail history must share the full school/viewer/authority/session/binding cache boundary',
);
assert.match(
  dashboardSource,
  /\.\.\.\(detailHistoryTeachingSessionId[\s\S]{0,140}\{ teachingSessionId: detailHistoryTeachingSessionId \}/,
  'class detail history must send its exact teaching session while claimed coverage omits it',
);
assert.doesNotMatch(
  studentTileSource,
  /enforcementHealth|Controls:/,
  'teacher tiles must not expose device-control synchronization health',
);
assert.doesNotMatch(
  studentTileSource,
  />\s*Preview unavailable\s*</,
  'unavailable-state truth must replace the redundant preview heading',
);
assert.doesNotMatch(
  studentTileSource,
  /Last observed site:/,
  'last-observed site details belong in the student drawer rather than the tile',
);
assert.match(
  studentTileSource,
  /data-testid=\{`button-manage-tabs-\$\{student\.studentId\}`\}[\s\S]{0,180}View Tabs/,
  'the per-student shortcut must be labeled View Tabs',
);
assert.match(
  dashboardSource,
  /onClick=\{\(\) => openManageTabs\(null\)\}[\s\S]{0,260}data-testid="button-tabs"[\s\S]{0,180}Manage Tabs/,
  'the toolbar action must be labeled Manage Tabs without changing its active-target scope',
);
assert.match(
  dashboardSource,
  /onManageTabs=\{[^\n]*openManageTabs\(\[student\.studentId\]\)/,
  'the tile action must remain bound to exactly one student',
);
assert.doesNotMatch(
  dashboardSource,
  /data-testid="tile-cohort-refresh-error"/,
  'cohort tile failures must remain tile-local and not add a dashboard-wide warning banner',
);
for (const removedControl of [
  'button-temp-unblock',
  'button-tab-limit',
  'button-command-results',
  'button-lock-url',
]) {
  assert.doesNotMatch(
    dashboardSource,
    new RegExp(`data-testid=["']${removedControl}["']`),
    `${removedControl} must remain absent from the classroom toolbar`,
  );
}
assert.doesNotMatch(
  dashboardSource,
  /showLockUrlDialog|handleLockToUrl|dialog-lock-url|input-lock-url|button-confirm-lock-url/,
  'the removed Lock URL action must leave no dialog, state, validation, or handler behind',
);
assert.match(
  dashboardSource,
  /data-testid="button-lock-screen"[\s\S]{0,180}>Lock<\/Button>/,
  'the current-domain action must retain button-lock-screen and display the concise Lock label',
);
assert.match(
  dashboardSource,
  /data-testid="button-unlock-screen"[\s\S]{0,220}>Unlock<\/Button>/,
  'the screen-only release action must use button-unlock-screen and display Unlock',
);
assert.doesNotMatch(
  dashboardSource,
  />Lock Current<|>Lock URL</,
  'the classroom toolbar must not expose the superseded Lock Current or Lock URL labels',
);
assert.match(
  dashboardSource,
  /toolbarScreenCommand\(['"]lock-screen['"],\s*selectedStudentIds\)/,
  'toolbar Lock must build its command only from the explicit selection',
);
assert.match(
  dashboardSource,
  /toolbarScreenCommand\(['"]unlock-screen['"],\s*selectedStudentIds\)/,
  'toolbar Unlock must build its command only from the explicit selection',
);
assert.match(
  dashboardSource,
  /selectedStudentIds\.size === 0/,
  'toolbar screen controls must remain disabled while there is no explicit selection',
);
assert.match(
  dashboardSource,
  /screenOnlyUnlockV1/,
  'toolbar Unlock must remain capability-gated',
);
assert.match(
  dashboardSource,
  /explicitlySelectedUnlockStudents\.every\(\(student\) => studentSupportsCapability\(student, 'screenOnlyUnlockV1'\)\)/,
  'one unsupported student in a mixed selection must disable toolbar Unlock',
);
assert.match(
  dashboardSource,
  /screenToolbarRosterUnavailable[\s\S]{0,240}studentsLoading \|\| studentsQueryError[\s\S]{0,180}claimedStudentsLoading \|\| claimedStudentsQueryError/,
  'Lock and Unlock must fail closed when either command roster cannot be loaded',
);
assert.match(
  dashboardSource,
  /exactSelectedTargetsResolved = !screenToolbarRosterUnavailable/,
  'retained stale roster rows must not leave Lock or Unlock usable after a load failure',
);
assert.match(
  dashboardSource,
  /exactSelectedUnlockTargetsResolved = !screenToolbarRosterUnavailable/,
  'a known active lock may retain only the separately resolved safety-unlock path',
);
assert.match(
  dashboardSource,
  /disabled=\{[^\n]*lockScreenMutation\.isPending[^\n]*unlockScreenMutation\.isPending[^\n]*\}[^\n]*data-testid="button-lock-screen"/,
  'Lock must remain disabled while either screen command is pending',
);
assert.match(
  dashboardSource,
  /disabled=\{[^\n]*lockScreenMutation\.isPending[^\n]*unlockScreenMutation\.isPending[^\n]*\}[^\n]*data-testid="button-unlock-screen"/,
  'Unlock must remain disabled while either screen command is pending',
);
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
