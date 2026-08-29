import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  QueryClient,
  QueryObserver,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import {
  TILE_BATCH_REFETCH_INTERVAL_MS,
  changedTileBindingStudentIds,
  createTileBatchRequests,
  fetchTileBatch,
  indexTileScreenshots,
  removeLegacyScreenshotsFromTileBatchData,
  removeStudentsFromTileBatchData,
  retainFreshTileScreenshotsOnNull,
  tileBatchRequestShouldPoll,
} from '../src/products/classpilot/lib/tileBatchPolling.js';
import {
  purgeAllScreenshotTileCaches,
  purgeAllStudentTileCaches,
  purgeLegacyScreenshotTileCaches,
  reconcileStudentTileBindingCaches,
  scrubStudentTileCaches,
  purgeStudentTileCaches,
  tileBatchFailureScope,
} from '../src/products/classpilot/lib/tileCachePrivacy.js';
import {
  deriveScreenshotDisplay,
} from '../src/products/classpilot/lib/studentMonitoringDisplay.js';

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

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
const revisionOneRequests = createTileBatchRequests([{
  studentId: studentIds[0],
  realtimeBinding: 'binding-a',
  classroomState: { revision: 1 },
}], {
  schoolId: 'school-1',
  viewerId: 'staff-1',
  authority: 'observed-class:class',
  teachingSessionId: 'session-1',
});
const revisionTwoRequests = createTileBatchRequests([{
  studentId: studentIds[0],
  realtimeBinding: 'binding-a',
  classroomState: { revision: 2 },
}], {
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
  'an exact screenshot query key must change with its realtime binding tuple',
);
assert.deepEqual(
  contextBoundRequests[1].queryKey,
  replacementBindingRequests[1].queryKey,
  'non-pixel history may retain its stable student-ID cohort key',
);
assert.notDeepEqual(
  revisionOneRequests[0].queryKey,
  revisionTwoRequests[0].queryKey,
  'a public classroom control revision change must replace the exact screenshot query key',
);
assert.deepEqual(
  changedTileBindingStudentIds(
    [{ studentId: studentIds[0], realtimeBinding: 'binding-a', classroomState: { revision: 1 } }],
    [{ studentId: studentIds[0], realtimeBinding: 'binding-a', classroomState: { revision: 2 } }],
  ),
  [studentIds[0]],
  'control-revision changes must trigger the same immediate pixel scrub as realtime-binding changes',
);
assert.equal(
  JSON.stringify(contextBoundRequests).includes('deviceId'),
  false,
  'context-bound requests must still expose no device IDs',
);

const exactV2Screenshot = {
  screenshot: 'data:image/jpeg;base64,v2',
  bindingVersion: 'v2:expected-binding',
};
const indexedBindingCases = indexTileScreenshots({
  tiles: [
    {
      studentId: 'valid-v2',
      bindingVersion: 'v2:expected-binding',
      screenshot: exactV2Screenshot,
    },
    {
      studentId: 'mismatched-v2',
      bindingVersion: 'v2:expected-binding',
      screenshot: { ...exactV2Screenshot, bindingVersion: 'v2:different-binding' },
    },
    { studentId: 'missing-row-v2', screenshot: exactV2Screenshot },
    {
      studentId: 'missing-screenshot-v2',
      bindingVersion: 'v2:expected-binding',
      screenshot: { screenshot: 'unmarked-pixel' },
    },
    { studentId: 'legacy-v1', screenshot: { screenshot: 'legacy-pixel' } },
  ],
});
assert.equal(indexedBindingCases.get('valid-v2'), exactV2Screenshot);
assert.equal(indexedBindingCases.get('mismatched-v2'), null);
assert.equal(indexedBindingCases.get('missing-row-v2'), null);
assert.equal(indexedBindingCases.get('missing-screenshot-v2'), null);
assert.deepEqual(indexedBindingCases.get('legacy-v1'), { screenshot: 'legacy-pixel' });

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
const normalizedMismatchedFetch = await fetchTileBatch(
  requests[0],
  async () => ({
    tiles: [{
      studentId: studentIds[0],
      bindingVersion: 'v2:expected-binding',
      screenshot: { screenshot: 'wrong-pixel', bindingVersion: 'v2:different-binding' },
    }],
  }),
);
assert.equal(
  normalizedMismatchedFetch.tiles[0].screenshot,
  null,
  'mismatched V2 pixels must be nulled before the raw response enters React Query',
);

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
const retainedAtSixtySeconds = retainFreshTileScreenshotsOnNull(
  priorScreenshotResponse,
  successfulNullResponse,
  screenshotCapturedAtMs + 60_000,
);
assert.equal(
  retainedAtSixtySeconds.tiles[0].screenshot.screenshot,
  priorScreenshot.screenshot,
  'a same-query 200 null may retain its original screenshot inside the 75-second window',
);
assert.equal(
  deriveScreenshotDisplay(
    retainedAtSixtySeconds.tiles[0].screenshot,
    screenshotCapturedAtMs + 75_000,
  ).retained,
  false,
  'a successful null received at 60 seconds must become unavailable at the original 75-second boundary',
);
assert.equal(
  deriveScreenshotDisplay(
    retainedAtSixtySeconds.tiles[0].screenshot,
    screenshotCapturedAtMs + 90_000,
  ).retained,
  false,
  'a successful null must never drift into the 75-to-120-second reconnect presentation',
);
const retainedJustBeforeSeventyFiveSeconds = retainFreshTileScreenshotsOnNull(
  priorScreenshotResponse,
  successfulNullResponse,
  screenshotCapturedAtMs + 74_999,
);
assert.equal(
  retainedJustBeforeSeventyFiveSeconds.tiles[0].screenshot.screenshot,
  priorScreenshot.screenshot,
  'a same-binding null may preserve pixels only inside the normal 75-second freshness window',
);
const hiddenAtSeventyFiveSeconds = retainFreshTileScreenshotsOnNull(
  priorScreenshotResponse,
  successfulNullResponse,
  screenshotCapturedAtMs + 75_000,
);
assert.equal(
  hiddenAtSeventyFiveSeconds.tiles[0].screenshot,
  null,
  'a successful null must hide the prior preview at the exact 75-second boundary',
);
assert.deepEqual(
  retainFreshTileScreenshotsOnNull(priorScreenshotResponse, { tiles: [] }, screenshotCapturedAtMs + 30_000),
  { tiles: [] },
  'an omitted/unauthorized row must never inherit a prior screenshot',
);
const v2BindingVersion = 'v2:opaque-binding-a';
const v2PriorScreenshot = { ...priorScreenshot, bindingVersion: v2BindingVersion };
const v2PriorResponse = {
  tiles: [{
    studentId: studentIds[0],
    bindingVersion: v2BindingVersion,
    screenshot: v2PriorScreenshot,
  }],
};
assert.equal(
  retainFreshTileScreenshotsOnNull(v2PriorResponse, {
    tiles: [{ studentId: studentIds[0], bindingVersion: v2BindingVersion, screenshot: null }],
  }, screenshotCapturedAtMs + 60_000).tiles[0].screenshot.screenshot,
  v2PriorScreenshot.screenshot,
  'a fresh null V2 row may retain pixels only under the exact same expected opaque binding',
);
assert.equal(
  retainFreshTileScreenshotsOnNull(v2PriorResponse, {
    tiles: [{ studentId: studentIds[0], bindingVersion: 'v2:opaque-binding-b', screenshot: null }],
  }, screenshotCapturedAtMs + 60_000).tiles[0].screenshot,
  null,
  'a changed V2 expected binding must scrub prior pixels immediately',
);
assert.equal(
  retainFreshTileScreenshotsOnNull(v2PriorResponse, successfulNullResponse, screenshotCapturedAtMs + 60_000)
    .tiles[0].screenshot,
  null,
  'an absent expected V2 binding must fail private rather than retaining class-bound pixels',
);
assert.equal(
  retainFreshTileScreenshotsOnNull(priorScreenshotResponse, {
    tiles: [{ studentId: studentIds[0], bindingVersion: v2BindingVersion, screenshot: null }],
  }, screenshotCapturedAtMs + 60_000).tiles[0].screenshot,
  null,
  'a V1 screenshot must never cross into an incoming V2 authority binding',
);
assert.equal(
  retainFreshTileScreenshotsOnNull(v2PriorResponse, {
    tiles: [{ studentId: studentIds[0], bindingVersion: 'v1:legacy-binding', screenshot: null }],
  }, screenshotCapturedAtMs + 60_000).tiles[0].screenshot,
  null,
  'a V2 screenshot must never cross into an incoming V1 authority binding',
);

const privacyQueryClient = new QueryClient();
assert.equal(tileBatchFailureScope({ response: { status: 403 } }), 'global');
assert.equal(tileBatchFailureScope({ response: { status: 404 } }), 'cohort');
assert.equal(tileBatchFailureScope({ response: { status: 503 } }), 'transient');
const unavailableStoreClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0 } },
});
const unavailableStoreKey = ['/api/classpilot/tiles/screenshots', 'exact-context', 'cohort'];
unavailableStoreClient.setQueryData(unavailableStoreKey, priorScreenshotResponse);
await assert.rejects(
  unavailableStoreClient.fetchQuery({
    queryKey: unavailableStoreKey,
    queryFn: async () => {
      const error = new Error('Screenshot store unavailable');
      error.response = { status: 503 };
      throw error;
    },
  }),
);
assert.equal(
  unavailableStoreClient.getQueryData(unavailableStoreKey),
  priorScreenshotResponse,
  'a 503 must retain the last exact-context screenshot response for the bounded reconnect window',
);
unavailableStoreClient.clear();
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

const legacyScrubClient = new QueryClient();
const legacyAndV2Key = ['/api/classpilot/tiles/screenshots', 'authority-a', 'mixed'];
const v2Pixel = { screenshot: 'v2-pixel', bindingVersion: 'v2:exact-class-binding' };
legacyScrubClient.setQueryData(legacyAndV2Key, {
  tiles: [
    { studentId: studentIds[0], screenshot: { screenshot: 'legacy-pixel' } },
    { studentId: studentIds[1], screenshot: v2Pixel },
  ],
});
await purgeLegacyScreenshotTileCaches(legacyScrubClient);
assert.deepEqual(
  legacyScrubClient.getQueryData(legacyAndV2Key).tiles.map((tile) => tile.studentId),
  [studentIds[1]],
  'V1 observation revocation must scrub only legacy pixels from a mixed cohort',
);
assert.deepEqual(
  legacyScrubClient.getQueryData(legacyAndV2Key).tiles[0].screenshot,
  v2Pixel,
  'V2 class-bound pixels must survive legacy observation-lease revocation',
);
assert.equal(
  removeLegacyScreenshotsFromTileBatchData(new Map([
    [studentIds[0], { screenshot: 'legacy-pixel' }],
    [studentIds[1], v2Pixel],
  ])).has(studentIds[0]),
  false,
  'selected Map-shaped caches must also drop legacy pixels',
);
assert.equal(
  removeLegacyScreenshotsFromTileBatchData(new Map([
    [studentIds[0], { screenshot: 'legacy-pixel' }],
    [studentIds[1], v2Pixel],
  ])).has(studentIds[1]),
  true,
  'selected Map-shaped caches must preserve V2 pixels',
);
assert.deepEqual(
  retainFreshTileScreenshotsOnNull(
    priorScreenshotResponse,
    removeLegacyScreenshotsFromTileBatchData(successfulNullResponse),
    screenshotCapturedAtMs + 30_000,
  ),
  { tiles: [] },
  'a denied/paused V1 null row must be removed before structural sharing can repopulate it',
);
legacyScrubClient.clear();

let failingLegacyCache = {
  tiles: [
    { studentId: studentIds[0], screenshot: { screenshot: 'legacy-before-cancel' } },
    { studentId: studentIds[1], screenshot: v2Pixel },
  ],
};
const failingLegacyScrubClient = {
  setQueriesData(_query, updater) {
    failingLegacyCache = updater(failingLegacyCache);
  },
  async cancelQueries() {
    throw new Error('cancel failed');
  },
  async refetchQueries() {
    failingLegacyCache = {
      tiles: [
        { studentId: studentIds[0], screenshot: { screenshot: 'legacy-after-refetch' } },
        { studentId: studentIds[1], screenshot: v2Pixel },
      ],
    };
    throw new Error('refetch failed');
  },
};
await assert.doesNotReject(
  purgeLegacyScreenshotTileCaches(failingLegacyScrubClient),
  'privacy scrubbing must resolve even when cancellation and refetch fail',
);
assert.deepEqual(
  failingLegacyCache.tiles.map((tile) => tile.studentId),
  [studentIds[1]],
  'the final fail-safe scrub must remove V1 pixels reintroduced by a failed refetch',
);

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

const sixtyStudents = Array.from({ length: 60 }, (_, index) => ({
  studentId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  realtimeBinding: `binding-${index}`,
}));
const sixtyStudentRequests = createTileBatchRequests(sixtyStudents, {
  schoolId: 'school-1',
  viewerId: 'staff-1',
  authority: 'teacher:class',
  teachingSessionId: 'session-1',
});
assert.equal(sixtyStudentRequests.length, 4, 'a 60-student frozen roster has two fixed cohort pairs');
assert.deepEqual(
  sixtyStudentRequests.map((request) => request.body.studentIds.length),
  [50, 50, 10, 10],
);
const sixtyScreenshotRequests = sixtyStudentRequests.filter((request) => request.kind === 'screenshots');
const frozenQueryKeys = sixtyScreenshotRequests.map((request) => request.queryKey);
assert.deepEqual(
  createTileBatchRequests([...sixtyStudents].reverse(), {
    schoolId: 'school-1',
    viewerId: 'staff-1',
    authority: 'teacher:class',
    teachingSessionId: 'session-1',
  }).filter((request) => request.kind === 'screenshots').map((request) => request.queryKey),
  frozenQueryKeys,
  'sorting the full binding roster must keep cohort identities stable across presentation ordering',
);
assert.equal(tileBatchRequestShouldPoll(sixtyScreenshotRequests[0], {
  viewportTrackingSupported: true,
  nearViewportStudentIds: new Set([sixtyStudents[0].studentId]),
}), true);
assert.equal(tileBatchRequestShouldPoll(sixtyScreenshotRequests[1], {
  viewportTrackingSupported: true,
  nearViewportStudentIds: new Set([sixtyStudents[0].studentId]),
}), false);
assert.equal(tileBatchRequestShouldPoll(sixtyScreenshotRequests[1], {
  viewportTrackingSupported: true,
  nearViewportStudentIds: new Set([sixtyStudents[59].studentId]),
}), true);
assert.equal(tileBatchRequestShouldPoll(sixtyScreenshotRequests[1], {
  viewportTrackingSupported: true,
  nearViewportStudentIds: new Set(),
  liveViewStudentId: sixtyStudents[59].studentId,
}), true, 'Live View keeps its fixed cohort active even when its tile is offscreen');
assert.equal(tileBatchRequestShouldPoll(sixtyScreenshotRequests[1]), true, 'unsupported viewport tracking polls every cohort');

const exactScrubClient = new QueryClient();
const exactScrubRawKey = sixtyScreenshotRequests[0].queryKey;
const exactScrubSelectedKey = [...exactScrubRawKey, 'selected-map'];
const changedStudentId = sixtyStudents[0].studentId;
const unchangedStudentId = sixtyStudents[1].studentId;
const unchangedScreenshot = { screenshot: 'classmate-pixel' };
exactScrubClient.setQueryData(exactScrubRawKey, {
  tiles: [
    { studentId: changedStudentId, screenshot: { screenshot: 'old-binding-pixel' } },
    { studentId: unchangedStudentId, screenshot: unchangedScreenshot },
  ],
});
exactScrubClient.setQueryData(exactScrubSelectedKey, new Map([
  [changedStudentId, { screenshot: 'old-binding-pixel' }],
  [unchangedStudentId, unchangedScreenshot],
]));
const cachedUnchangedScreenshot = exactScrubClient.getQueryData(exactScrubRawKey).tiles[1].screenshot;
const cachedUnchangedMapScreenshot = exactScrubClient.getQueryData(exactScrubSelectedKey).get(unchangedStudentId);
const replacementSixtyStudents = sixtyStudents.map((student) => (
  student.studentId === changedStudentId
    ? { ...student, realtimeBinding: 'replacement-binding' }
    : student
));
const replacementSixtyScreenshotRequests = createTileBatchRequests(replacementSixtyStudents, {
  schoolId: 'school-1',
  viewerId: 'staff-1',
  authority: 'teacher:class',
  teachingSessionId: 'session-1',
}).filter((request) => request.kind === 'screenshots');
assert.notDeepEqual(
  replacementSixtyScreenshotRequests[0].queryKey,
  frozenQueryKeys[0],
  'the screenshot cohort containing a replacement binding must receive a new exact query key',
);
assert.deepEqual(
  replacementSixtyScreenshotRequests[1].queryKey,
  frozenQueryKeys[1],
  'an unaffected screenshot cohort must preserve its exact query key',
);
const changedBindingStudentIds = changedTileBindingStudentIds(
  sixtyStudents,
  replacementSixtyStudents,
);
assert.deepEqual(
  changedBindingStudentIds,
  [changedStudentId],
  'an actual binding transition must identify only the student whose binding changed',
);
scrubStudentTileCaches(exactScrubClient, changedBindingStudentIds);
assert.deepEqual(
  exactScrubClient.getQueryData(exactScrubRawKey).tiles.map((tile) => tile.studentId),
  [unchangedStudentId],
  'an exact binding/privacy change scrubs only that student from the raw cohort cache',
);
assert.deepEqual(
  exactScrubClient.getQueryData(exactScrubRawKey).tiles[0].screenshot,
  cachedUnchangedScreenshot,
  'an exact cache scrub must preserve the unchanged classmate payload',
);
assert.equal(exactScrubClient.getQueryData(exactScrubSelectedKey).has(changedStudentId), false);
assert.equal(
  exactScrubClient.getQueryData(frozenQueryKeys[0]).tiles.some((tile) => tile.studentId === changedStudentId),
  false,
  'an A→B→A return must not resurrect pixels scrubbed from the former exact-binding key',
);
assert.equal(
  exactScrubClient.getQueryData(exactScrubSelectedKey).get(unchangedStudentId),
  cachedUnchangedMapScreenshot,
);
exactScrubClient.clear();

const bindingTransitionClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
});
bindingTransitionClient.mount();
const bindingTransitionKey = replacementSixtyScreenshotRequests[0].queryKey;
const bindingTransitionNow = Date.now();
const retainedClassmateScreenshot = {
  screenshot: 'retained-classmate-pixel',
  timestamp: new Date(bindingTransitionNow).toISOString(),
};
bindingTransitionClient.setQueryData(bindingTransitionKey, {
  tiles: [
    { studentId: changedStudentId, screenshot: { screenshot: 'former-binding-pixel' } },
    { studentId: unchangedStudentId, screenshot: retainedClassmateScreenshot },
  ],
});
let bindingTransitionFetches = 0;
const replacementScreenshot = {
  screenshot: 'replacement-binding-pixel',
  timestamp: new Date(bindingTransitionNow).toISOString(),
};
const bindingTransitionObserver = new QueryObserver(bindingTransitionClient, {
  queryKey: bindingTransitionKey,
  queryFn: async () => {
    bindingTransitionFetches += 1;
    return {
      tiles: [
        { studentId: changedStudentId, screenshot: replacementScreenshot },
        { studentId: unchangedStudentId, screenshot: null },
      ],
    };
  },
  staleTime: Number.POSITIVE_INFINITY,
  structuralSharing: (previous, incoming) => retainFreshTileScreenshotsOnNull(
    previous,
    incoming,
    bindingTransitionNow,
  ),
});
const unsubscribeBindingTransition = bindingTransitionObserver.subscribe(() => {});
try {
  scrubStudentTileCaches(bindingTransitionClient, changedBindingStudentIds);
  await reconcileStudentTileBindingCaches(bindingTransitionClient, changedBindingStudentIds);
  await waitUntil(
    () => bindingTransitionFetches === 1,
    'the same active cohort must refetch after its exact binding transition',
  );
  const transitionedTiles = bindingTransitionClient.getQueryData(bindingTransitionKey).tiles;
  assert.equal(
    transitionedTiles.find((tile) => tile.studentId === changedStudentId)?.screenshot,
    replacementScreenshot,
    'the replacement binding may populate new authorized pixels after the old row is scrubbed',
  );
  assert.equal(
    transitionedTiles.find((tile) => tile.studentId === unchangedStudentId)?.screenshot?.screenshot,
    retainedClassmateScreenshot.screenshot,
    'the same-key transition must preserve an unchanged classmate screenshot on a null poll',
  );
} finally {
  unsubscribeBindingTransition();
  bindingTransitionClient.unmount();
  bindingTransitionClient.clear();
}

const lifecycleClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0 } },
});
lifecycleClient.mount();
let lifecycleFetches = 0;
const lifecycleOptions = {
  queryKey: sixtyScreenshotRequests[0].queryKey,
  queryFn: async () => {
    lifecycleFetches += 1;
    return { tiles: [] };
  },
  enabled: true,
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: 'always',
  refetchOnReconnect: 'always',
};
const lifecycleObserver = new QueryObserver(lifecycleClient, lifecycleOptions);
const unsubscribeLifecycle = lifecycleObserver.subscribe(() => {});
try {
  await waitUntil(() => lifecycleFetches === 1, 'an enabled visible cohort must fetch immediately');
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await waitUntil(() => lifecycleFetches === 2, 'focus recovery must immediately refetch the stale active cohort');
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await waitUntil(() => lifecycleFetches === 3, 'network recovery must immediately refetch the stale active cohort');
  lifecycleObserver.setOptions({ ...lifecycleOptions, enabled: false });
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lifecycleFetches, 3, 'an offscreen disabled cohort must not refetch on focus or reconnect');
  assert.deepEqual(
    lifecycleObserver.options.queryKey,
    frozenQueryKeys[0],
    'viewport enablement changes must never change the frozen cohort query key',
  );
} finally {
  unsubscribeLifecycle();
  lifecycleClient.unmount();
  lifecycleClient.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
}

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
  /const screenshotTileQueryStudents = effectiveSessionId[\s\S]{0,80}\? students[\s\S]{0,80}: EMPTY_LIST/,
  'class screenshot cohorts must remain bound to the full frozen aggregate across temporary dashboard views',
);
assert.doesNotMatch(
  dashboardSource,
  /const tileStudents = viewportTrackingSupported/,
  'viewport state must not rebuild query identities from a partial roster',
);
assert.match(
  dashboardSource,
  /enabled: screenshotTileReadsEnabled && tileBatchRequestShouldPoll\(/,
  'viewport state may enable a fixed screenshot cohort without changing its identity',
);
assert.match(
  dashboardSource,
  /refetchOnWindowFocus: 'always',[\s\S]{0,80}refetchOnReconnect: 'always'/,
  'tile reads must reconcile immediately after focus or network recovery',
);
assert.match(
  dashboardSource,
  /changedTileBindingStudentIds\(previous\.students, nextStudents\)[\s\S]{0,600}scrubStudentTileCaches\(queryClient, changedStudentIds\)/,
  'binding transitions must scrub only the changed student while retaining the stable cohort cache',
);
assert.match(
  dashboardSource,
  /reconcileStudentTileBindingCaches\(queryClient, pending\.studentIds\)/,
  'the stable active cohort must refetch after its replacement query function is installed',
);
assert.match(
  dashboardSource,
  /if \(studentView === 'class'\) return;[\s\S]{0,300}purgeLegacyScreenshotTileCaches/,
  'leaving Class must scrub legacy pixels while allowing exact class-bound V2 pixels to bridge the view change',
);
assert.match(
  dashboardSource,
  /classDashboardCapabilities = deriveDashboardCapabilities\(\{[\s\S]{0,80}studentView: 'class'/,
  'screenshot authority must be derived independently from the temporary dashboard view',
);
assert.match(
  dashboardSource,
  /authority: `\$\{dashboardViewerRole\}:\$\{classDashboardCapabilities\.mode\}:class`[\s\S]{0,100}teachingSessionId: effectiveSessionId \|\| ''/,
  'teacher/admin Observe screenshot keys must retain the exact role, class authority, and frozen session',
);
assert.doesNotMatch(
  dashboardSource,
  /screenshotTileBatchContext = useMemo\([\s\S]{0,400}studentView/,
  'temporary Class/Available/Claimed view state must not enter screenshot cache identity',
);
assert.match(
  dashboardSource,
  /gcTime: TILE_SCREENSHOT_CACHE_GC_MS/,
  'inactive exact-context screenshots must remain cacheable through the bounded 120-second retention window',
);
assert.match(
  dashboardSource,
  /tileScreenshotRevoked = tileSharedPrivacyRevoked[\s\S]{0,160}studentView !== 'class'/,
  'cached Class pixels must never render in Available, Claimed, or Coverage views',
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
// Lock-to-URL was deliberately reinstated (2026-08) as a mode inside the
// single Lock dialog: the toolbar keeps one concise Lock button, and the
// dialog defaults to the CURRENT_URL sentinel with an optional explicit
// domain/URL mode. The historical bans above stay: the superseded
// standalone Lock URL control must never return as a second toolbar button.
assert.match(
  dashboardSource,
  /data-testid="dialog-lock-screen"/,
  'toolbar Lock must open the lock-screen dialog',
);
assert.match(
  dashboardSource,
  /data-testid="input-lock-screen-url"/,
  'the lock-screen dialog must offer the explicit domain/URL mode input',
);
assert.match(
  dashboardSource,
  /lockScreenMode === "url"[\s\S]{0,400}if \(!url\.match\(\/\^https\?:\\\/\\\/\/i\)\) url = 'https:\/\/' \+ url;/,
  'the explicit lock URL must be normalized with an https:// prefix before sending',
);
assert.match(
  dashboardSource,
  /setLockScreenMode\("current"\);\s*\n\s*setLockScreenUrl\(""\);\s*\n\s*setShowLockScreenDialog\(true\);/,
  'opening the lock dialog must reset to the CURRENT_URL default mode',
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
