import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createSubgroupMembersQuery,
  subgroupMembersQueryKey,
} from '../src/products/classpilot/lib/subgroupMembersQuery.js';
import {
  normalizedObservationScope,
  observationLeaseFailureStatus,
  observationLeaseRenewalFailureDisposition,
  observationLeaseResponseDisposition,
} from '../src/products/classpilot/lib/observationLeaseStatus.js';
import { classpilotReconciliationIntervalMs } from '../src/products/classpilot/lib/monitoringReconciliation.js';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  createTileBatchRequests,
  indexTileScreenshots,
  screenshotCohortPlaceholderData,
  buildScreenshotCohortPlaceholderData,
} from '../src/products/classpilot/lib/tileBatchPolling.js';

function responseError(status, code) {
  return {
    response: {
      status,
      data: code ? { code } : {},
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('observation lease failures distinguish transient outage and hard denial', () => {
  assert.equal(
    observationLeaseFailureStatus(responseError(404)),
    'denied',
    'an un-coded 404 can be an authorization/session failure and must fail private',
  );
  assert.equal(
    observationLeaseFailureStatus(responseError(404, 'OBSERVATION_SESSION_UNAVAILABLE')),
    'denied',
    'a current-server coded 404 must purge rather than revive cached previews',
  );
  assert.equal(observationLeaseFailureStatus(responseError(401, 'UNAUTHORIZED')), 'denied');
  assert.equal(observationLeaseFailureStatus(responseError(403, 'FORBIDDEN')), 'denied');
  assert.equal(
    observationLeaseFailureStatus(responseError(503, 'SCREENSHOT_STORE_UNAVAILABLE')),
    'error',
  );
  assert.equal(
    observationLeaseFailureStatus(responseError(409, 'OBSERVATION_LEASE_UNAVAILABLE')),
    'error',
  );
  assert.equal(observationLeaseFailureStatus(new Error('network unavailable')), 'error');
  assert.deepEqual(
    observationLeaseRenewalFailureDisposition(responseError(404, 'OBSERVATION_SESSION_UNAVAILABLE')),
    { status: 'denied', releaseLease: true },
    'an observed lease whose renewal is denied must be explicitly released',
  );
  assert.deepEqual(
    observationLeaseRenewalFailureDisposition(responseError(503, 'OBSERVATION_LEASE_UNAVAILABLE')),
    { status: 'error', releaseLease: false },
    'a transient outage retains only the already-bounded exact-context lease',
  );
});

test('malformed and over-limit enabled observation scopes fail private', async () => {
  const tooManyStudentIds = Array.from({ length: 501 }, (_, index) => `student-${index}`);
  assert.equal(normalizedObservationScope({ kind: 'students', studentIds: tooManyStudentIds }), null);
  assert.equal(normalizedObservationScope({ kind: 'students', studentIds: 'not-an-array' }), null);
  assert.equal(normalizedObservationScope({ kind: 'unknown' }), null);

  const [lease, dashboard] = await Promise.all([
    readFile(new URL('../src/products/classpilot/hooks/useObservationLease.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(lease, /leaseConfigurationInvalid[\s\S]{0,160}status = 'denied'/);
  assert.match(lease, /if \(!sessionId \|\| !normalizedScope\)[\s\S]{0,220}status: 'denied'/);
  assert.match(
    dashboard,
    /historyTileReadsEnabled = studentView !== 'available'[\s\S]{0,100}observationReadsAllowed/,
    'invalid observation scopes must still fail private for legacy history reads',
  );
  assert.match(
    dashboard,
    /screenshotTileReadsEnabled = studentView === 'claimed'[\s\S]{0,200}studentView === 'class' && Boolean\(effectiveActivityId\)/,
    'a live class must still ask the server for independently authorized V2 screenshots',
  );
});

test('deferred observation PUTs cannot adopt after hide or out of order after a restart', async () => {
  const deletedViewerIds = [];
  const adoptedViewerIds = [];
  const settle = async (request, runtime) => {
    await request.deferred.promise;
    const disposition = observationLeaseResponseDisposition({
      stopped: false,
      requestEpoch: request.epoch,
      currentEpoch: runtime.currentEpoch,
      visibilityState: runtime.visibilityState,
      requestViewerId: request.viewerId,
      activeViewerId: runtime.activeViewerId,
    });
    if (disposition === 'adopt') adoptedViewerIds.push(request.viewerId);
    else deletedViewerIds.push(request.viewerId);
  };

  const hiddenRequest = { deferred: deferred(), epoch: 1, viewerId: 'viewer-a' };
  const hiddenCompletion = settle(hiddenRequest, {
    currentEpoch: 2,
    visibilityState: 'hidden',
    activeViewerId: 'viewer-a',
  });
  hiddenRequest.deferred.resolve();
  await hiddenCompletion;
  assert.deepEqual(adoptedViewerIds, []);
  assert.deepEqual(deletedViewerIds, ['viewer-a']);

  const staleA = { deferred: deferred(), epoch: 3, viewerId: 'viewer-a2' };
  const currentB = { deferred: deferred(), epoch: 5, viewerId: 'viewer-b' };
  const visibleBRuntime = {
    currentEpoch: 5,
    visibilityState: 'visible',
    activeViewerId: 'viewer-b',
  };
  const staleCompletion = settle(staleA, visibleBRuntime);
  const currentCompletion = settle(currentB, visibleBRuntime);
  currentB.deferred.resolve();
  await currentCompletion;
  staleA.deferred.resolve();
  await staleCompletion;
  assert.deepEqual(adoptedViewerIds, ['viewer-b']);
  assert.deepEqual(deletedViewerIds, ['viewer-a', 'viewer-a2']);

  // Model an already-observed lease whose renewal PUT is still executing.
  // DELETE-on-hide can arrive first; the post-settlement DELETE is what
  // guarantees the late PUT commit cannot leave an orphaned observed lease.
  const renewal = deferred();
  const redisOrder = [];
  let redisObserved = true;
  const lateRenewal = (async () => {
    await renewal.promise;
    redisObserved = true;
    redisOrder.push('put-commit');
    redisObserved = false;
    redisOrder.push('delete-after-settle');
  })();
  redisObserved = false;
  redisOrder.push('delete-on-hide');
  renewal.resolve();
  await lateRenewal;
  assert.equal(redisObserved, false);
  assert.deepEqual(redisOrder, ['delete-on-hide', 'put-commit', 'delete-after-settle']);

  const leaseSource = await readFile(
    new URL('../src/products/classpilot/hooks/useObservationLease.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    leaseSource,
    /AbortController|controller\.abort\(\)/,
    'revocation must not abort a PUT and let its server mutation commit after the only DELETE',
  );
  assert.match(leaseSource, /if \(disposition === 'release'\)[\s\S]{0,100}await deleteLease\(requestViewerId\)/);
  assert.match(
    leaseSource,
    /if \(stopped \|\| epoch !== requestEpoch\)[\s\S]{0,320}await deleteLease\(requestViewerId\)/,
    'a revoked PUT must issue its second exact-viewer DELETE after rejection settles',
  );
  assert.match(
    leaseSource,
    /if \(!failure\.releaseLease\)[\s\S]{0,180}setStatus\('error'\)[\s\S]{0,140}else \{[\s\S]{0,240}setStatus\(failure\.status\)[\s\S]{0,220}await deleteLease\(requestViewerId\)/,
    'a terminal renewal denial must revoke the previously observed exact-viewer lease',
  );
});

test('aggregate reconciliation jitter is stable per tab and does not synchronize class viewers', () => {
  const scope = '["/api/students-aggregated","school-1","session-1"]';
  const firstViewer = classpilotReconciliationIntervalMs(`tab-alpha:${scope}`);
  const secondViewer = classpilotReconciliationIntervalMs(`tab-bravo:${scope}`);

  assert.equal(firstViewer, classpilotReconciliationIntervalMs(`tab-alpha:${scope}`));
  assert.notEqual(firstViewer, secondViewer);
  assert.ok(firstViewer >= 25_000 && firstViewer <= 35_000);
  assert.ok(secondViewer >= 25_000 && secondViewer <= 35_000);
});

test('subgroup membership queries are fenced by group and subgroup identity', async () => {
  assert.notDeepEqual(
    subgroupMembersQueryKey('group-a', 'subgroup-1'),
    subgroupMembersQueryKey('group-b', 'subgroup-1'),
  );
  assert.notDeepEqual(
    subgroupMembersQueryKey('group-a', 'subgroup-1'),
    subgroupMembersQueryKey('group-a', 'subgroup-2'),
  );

  const signal = new AbortController().signal;
  const calls = [];
  const query = createSubgroupMembersQuery({
    groupId: 'group-a',
    subgroupId: 'subgroup-1',
    requestApi: async (...args) => {
      calls.push(args);
      return { members: [{ studentId: 'student-1' }, 'student-2', null] };
    },
  });

  assert.equal(query.enabled, true);
  assert.deepEqual(await query.queryFn({ signal }), ['student-1', 'student-2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'GET');
  assert.equal(calls[0][1], '/subgroups/subgroup-1/members');
  assert.equal(calls[0][3].signal, signal);
});

test('Live View stays dormant in every Dashboard activity while passive previews remain available', async () => {
  const [dashboard, tile, portal, sidebar] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/VideoPortal.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/ClassPilotSidebar.jsx', import.meta.url), 'utf8'),
  ]);

  assert.equal(dashboard.match(/<VideoPortal/g)?.length, 1, 'retain one dormant Live View portal integration');
  assert.match(dashboard, /const LIVE_VIEW_UI_ENABLED = false;/);
  assert.doesNotMatch(dashboard, /LIVE_VIEW_UI_ENABLED = scheduledClassEnabled/);
  assert.match(dashboard, /LIVE_VIEW_UI_ENABLED && dashboardCapabilities\.canUseLiveView && liveViewState\.expanded/);
  assert.match(dashboard, /onStartLiveView=\{LIVE_VIEW_UI_ENABLED &&/);
  assert.match(dashboard, /onStopLiveView=\{LIVE_VIEW_UI_ENABLED &&/);
  assert.match(dashboard, /onExpandLiveView=\{LIVE_VIEW_UI_ENABLED \?/);
  assert.match(dashboard, /if \(message\.type === 'live-view-requested'\) \{\s*if \(!LIVE_VIEW_UI_ENABLED\) return;/);
  assert.match(dashboard, /const handleStartLiveView = async \(studentId, studentName\) => \{\s*if \(!LIVE_VIEW_UI_ENABLED\) return;/);
  assert.doesNotMatch(tile, /<VideoPortal|querySelector|portal-video-slot/);
  assert.doesNotMatch(portal, /querySelector|portal-video-slot/);
  assert.match(portal, /stream=|srcObject = stream/);
  assert.match(sidebar, /isOpen \? \(/, 'closed sidebar must not mount polling mini views');
});

test('student tiles split screenshot enlargement from the explicit Details action', async () => {
  const [dashboard, tile] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(
    tile,
    /const screenshotInteractionAvailable = Boolean\([\s\S]{0,180}onOpenScreenshot/,
    'the tile body must become interactive only when an authorized preview can be enlarged',
  );
  const cardSurface = tile.match(
    /data-testid=\{`card-student-\$\{student\.studentId\}`\}[\s\S]*?(?=>\r?\n\s*<div className="p-4 space-y-3">)/,
  )?.[0] || '';
  assert.ok(cardSurface.length > 0);
  assert.match(cardSurface, /onClick=\{screenshotInteractionAvailable/);
  assert.match(
    cardSurface,
    /target\.closest\('button, a, input, select, textarea, \[role="button"\], \[role="checkbox"\]'\)/,
    'nested controls must not bubble into screenshot enlargement',
  );
  assert.match(
    cardSurface,
    /onOpenScreenshot\(screenshotButtonRef\.current\)/,
    'the non-control tile body must route to the existing screenshot viewer',
  );
  assert.match(
    tile,
    /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*onOpenDetails\(event\.currentTarget\);\s*\}\}[\s\S]{0,360}aria-label=\{`Open details and activity for \$\{student\.studentName \|\| 'student'\}`\}[\s\S]{0,180}data-testid=\{`button-student-details-\$\{student\.studentId\}`\}/,
    'Details must be a separate labelled action that cannot bubble into screenshot enlargement',
  );
  assert.doesNotMatch(
    tile,
    /function StudentTile\(\{\s*student,\s*onClick,/,
    'the old ambiguous card-to-details callback must not remain',
  );

  const callbackPropsStart = tile.indexOf('const CALLBACK_PROPS');
  const callbackPropsEnd = tile.indexOf(']);', callbackPropsStart);
  const callbackProps = tile.slice(callbackPropsStart, callbackPropsEnd + 3);
  assert.ok(callbackPropsStart >= 0 && callbackPropsEnd > callbackPropsStart);
  assert.match(callbackProps, /'onOpenDetails'/);
  assert.doesNotMatch(callbackProps, /'onClick'/);
  assert.match(
    tile,
    /if \(CALLBACK_PROPS\.has\(key\)\) \{[\s\S]{0,280}Boolean\(previous\[key\]\) !== Boolean\(next\[key\]\)[\s\S]{0,80}return false;[\s\S]{0,80}continue;/,
    'memoized tiles must ignore callback identity but rerender when an authorized action appears or disappears',
  );

  assert.match(
    dashboard,
    /const tileDetailsRevoked = supervisedElsewhere[\s\S]{0,220}tileGlobalAuthorizationDenied[\s\S]{0,220}tileGlobalAuthorizationFailure[\s\S]{0,220}hardDeniedHistoryStudentIds\.has\(student\.studentId\)[\s\S]{0,220}monitoringDisplay\?\.kind === 'delegated'/,
    'delegation and global authorization failure must revoke Details before rendering the tile',
  );
  assert.match(
    dashboard,
    /onOpenDetails=\{tileDetailsRevoked\s*\? undefined\s*:\s*\(opener\) => openStudentDetails\(student, opener\)\}/,
    'teacher and Observe tiles must share the explicit, authorization-gated drawer callback',
  );
  assert.match(dashboard, /onClose=\{closeStudentDetails\}/);
  assert.match(
    dashboard,
    /studentDetailsOpenerRef\.current = opener \|\| null;[\s\S]{0,80}setSelectedStudent\(student\)/,
  );
  assert.match(
    dashboard,
    /opener\?\.isConnected[\s\S]{0,80}opener\.focus\(\)/,
    'closing Details must restore focus only to an opener that still belongs to the active context',
  );
  assert.match(
    dashboard,
    /const clearStudentDetails = useCallback\(\(\) => \{[\s\S]{0,180}studentDetailsOpenerRef\.current = null;[\s\S]{0,80}setSelectedStudent\(null\)/,
    'authority transitions must clear the drawer without focusing a stale tile',
  );
  const selectedDetailsRevocationStart = dashboard.indexOf('const selectedStudentDetailsRevoked');
  const selectedDetailsRevocationEnd = dashboard.indexOf(');', selectedDetailsRevocationStart);
  const selectedDetailsRevocation = dashboard.slice(
    selectedDetailsRevocationStart,
    selectedDetailsRevocationEnd + 2,
  );
  assert.ok(selectedDetailsRevocationStart >= 0 && selectedDetailsRevocationEnd > selectedDetailsRevocationStart);
  assert.match(selectedDetailsRevocation, /tileGlobalAuthorizationDenied/);
  assert.match(selectedDetailsRevocation, /tileGlobalAuthorizationFailure/);
  assert.match(selectedDetailsRevocation, /hardDeniedHistoryStudentIds\.has\(selectedStudentRow\?\.studentId\)/);
  assert.match(selectedDetailsRevocation, /detailHistoryHardDenied/);
  assert.match(selectedDetailsRevocation, /selectedStudentDisplay\?\.kind === 'delegated'/);
  assert.match(
    dashboard,
    /useLayoutEffect\(\(\) => \{\s*if \(selectedStudentDetailsRevoked\) clearStudentDetails\(\)/,
    'an open drawer must close synchronously when its exact authority is revoked',
  );
  assert.match(
    dashboard,
    /queryKey: detailHistoryQueryKey,[\s\S]{0,140}fetchAuthorizedTileBatch\([\s\S]{0,100}kind: 'history'[\s\S]{0,420}historyReadAuthorities, signal/,
    'a single-detail 404 must use the same exact-authority denial ledger as cohort history',
  );
  assert.match(
    dashboard,
    /const hardDeniedHistoryStudentIds = useMemo\(\(\) => \{\s*const deniedIds = new Set\(deniedHistoryReadIds\)/,
    'the persistent exact-authority denial remains the source for history privacy gates',
  );
  assert.match(
    dashboard,
    /\{selectedStudentRow && !selectedStudentDetailsRevoked && \([\s\S]{0,100}<StudentDetailDrawer/,
    'revoked details must not remain mounted while state cleanup settles',
  );
});

test('screenshot events coalesce one-second targeted refreshes without replacing cohort identity', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const handlerStart = dashboard.indexOf("if (message.type === 'screenshot-available')");
  const handlerEnd = dashboard.indexOf('if (message.type ===', handlerStart + 1);
  const handler = dashboard.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0);
  assert.match(handler, /queueTargetedScreenshotRefresh\(message\.studentId\)/);
  assert.doesNotMatch(handler, /refetchQueries/);
  assert.match(dashboard, /const SCREENSHOT_EVENT_COALESCE_MS = 1_000;/);
  assert.match(dashboard, /const SCREENSHOT_EVENT_RATE_LIMIT_MS = 1_000;/);
  assert.match(dashboard, /mergeTargetedTileScreenshotResponse/);
  assert.match(dashboard, /\.\.\.activityAuthority\(request\.body\)/);
  assert.match(
    dashboard,
    /targetedScreenshotFlushInFlightRef\.current = true[\s\S]{0,500}targetedScreenshotFlushInFlightRef\.current = false/,
    'a second one-second flush must wait and coalesce while the prior bounded flush is active',
  );
  assert.match(
    dashboard,
    /fenceGeneration:\s*targetedScreenshotFenceGenerationRef\.current\.generation/,
    'A to B to A must not let an old targeted screenshot response match by string key alone',
  );
});

test('dashboard renews observation only for a visible exact scope and virtualizes tile work', async () => {
  const [dashboard, lease, viewport, tile] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/hooks/useObservationLease.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/hooks/useTileViewport.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(dashboard, /useObservationLease\(/);
  assert.match(
    dashboard,
    /return studentView === 'class' \|\| claimedPreviewActive \? \{ kind: 'class' \} : null/,
    'Class view must keep one exact full-class observation lease even when presentation filters change',
  );
  assert.match(lease, /observation-lease/);
  assert.match(lease, /document\.visibilityState !== 'visible'/);
  assert.match(lease, /setTimeout\(renew/);
  assert.match(lease, /apiRequest\('DELETE'/);
  assert.match(dashboard, /paused_unobserved/);
  assert.match(viewport, /IntersectionObserver/);
  assert.match(viewport, /rootMargin: '100% 0px'/);
  assert.match(
    dashboard,
    /tileBatchRequestShouldPoll\(request, \{[\s\S]{0,200}nearViewportStudentIds,/,
    'the viewport must remain the polling gate for viewport-scoped tile reads',
  );
  assert.match(
    dashboard,
    /\[content-visibility:auto\] \[contain-intrinsic-size:420px\]/,
    'offscreen tiles must be skipped by the renderer, not unmounted',
  );
  // The PassPilot sidebar is position:fixed and compensated by a static
  // lg:ml-80 on <main>, so viewport breakpoints cannot see the 320px it takes.
  // The tile wall and the coverage panels size on their own width instead.
  assert.match(
    dashboard,
    /grid grid-cols-\[repeat\(auto-fill,minmax\(min\(224px,100%\),1fr\)\)\] gap-6/,
    'the tile wall must reflow on its own width so a fixed sidebar keeps tiles at 224px or the narrower available width',
  );
  assert.equal(
    (dashboard.match(/grid grid-cols-\[repeat\(auto-fill,minmax\(300px,1fr\)\)\] gap-4 p-4/g) || []).length,
    2,
    'both coverage panels must reflow on their own width',
  );
  assert.doesNotMatch(
    dashboard,
    /xl:grid-cols-/,
    'no dashboard card grid may size on a viewport breakpoint the fixed sidebar cannot influence',
  );
  assert.doesNotMatch(
    dashboard,
    /nearViewportStudentIds\.has\(student\.studentId\)\) \? <StudentTile/,
    'a tile must never be unmounted, and blanked, because it scrolled offscreen',
  );
  assert.match(
    viewport,
    /tracking: supported && settled/,
    'an observer that has not reported yet must poll every cohort instead of gating on an empty near set',
  );
  assert.match(
    viewport,
    /exitTimers\.set\(studentId, setTimeout\(/,
    'leaving the enter margin must be debounced so a scroll reversal cannot thrash polling',
  );
  assert.match(viewport, /TILE_VIEWPORT_EXIT_GRACE_MS/);
  assert.match(tile, /export default memo\(StudentTile, studentTilePropsEqual\)/);
});

test('authorization loss purges active tile caches without retaining denied pixels', async () => {
  const [dashboard, tile, dialog, privacy] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/ScreenshotPreviewDialog.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/lib/tileCachePrivacy.js', import.meta.url), 'utf8'),
  ]);

  assert.match(privacy, /queryClient\.setQueriesData\(/);
  assert.match(privacy, /queryClient\.cancelQueries\(/);
  assert.match(privacy, /queryClient\.removeQueries\(/);
  assert.match(dashboard, /purgeStudentTileCaches\(queryClient, JSON\.parse\(tileCachePurgeStudentIdsKey\)\)/);
  assert.match(dashboard, /purgeAllStudentTileCaches\(queryClient\)/);
  assert.match(dashboard, /tileBatchFailureScope\(query\.error\)/);
  assert.match(dashboard, /tileGlobalAuthorizationFailure/);
  assert.match(dashboard, /observationLeaseStatus === 'denied'/);
  assert.match(dashboard, /\['signed_out', 'delegated'\]\.includes\(monitoringDisplay\?\.kind\)/);
  assert.match(
    tile,
    /observationAuthorizationRevoked = !screenshotIsExactlyBound[\s\S]{0,180}screenshotObservationStatus === 'pending'[\s\S]{0,120}screenshotObservationStatus === 'denied'[\s\S]{0,120}screenshotObservationStatus === 'paused_unobserved'/,
    'a pixel with no exact generation stamp must retain every observation-lease privacy gate',
  );
  assert.match(
    tile,
    /screenshotAuthorizationRevoked = monitoringSuppressed[\s\S]{0,180}\['signed_out', 'delegated'\][\s\S]{0,120}screenshotAuthorizationDenied[\s\S]{0,120}observationAuthorizationRevoked/,
    'supervision, signed-out/delegated state, explicit context denial, and legacy lease loss must hard-hide pixels',
  );
  assert.match(tile, /screenshotObservationStatus === 'denied'/);
  assert.match(
    dashboard,
    /legacyScreenshotReadsRevoked[\s\S]{0,900}removeLegacyScreenshotsFromTileBatchData\(response\)/,
    'denied/paused mixed responses must discard V1 rows before React Query caches them',
  );
  assert.match(
    dashboard,
    /observationLeaseStatus === 'denied'[\s\S]{0,260}purgeAllStudentTileCaches\(queryClient\)[\s\S]{0,300}paused_unobserved[\s\S]{0,260}purgeLegacyScreenshotTileCaches/,
    'terminal denial must purge every generation while a normal view pause retains only exact V2 pixels',
  );
  assert.match(
    dashboard,
    /screenshotTileReadsEnabled = studentView === 'claimed'[\s\S]{0,320}!\['denied', 'ineligible', 'paused_unobserved'\]\.includes\(observationLeaseStatus\)/,
    'terminal denial and a paused observation must disable full and targeted screenshot reads',
  );
  assert.match(
    dashboard,
    /expandedScreenshotDisplay\.fresh \|\| expandedScreenshotDisplay\.retained/,
    'the enlarged viewer must remove expired pixels while leaving its unavailable shell open',
  );
  assert.match(
    dialog,
    /decodedScreenshotData[\s\S]{0,600}const pixelsAvailable = candidatePixelsAvailable[\s\S]{0,100}Boolean\(decodedScreenshotData\)[\s\S]{0,100}\(display\.fresh \|\| display\.retained\)/,
    'the enlarged viewer must derive pixel status from the frame that actually decoded',
  );
  assert.doesNotMatch(
    dialog,
    /catch\([^)]*setDecodedFrame\(null\)/,
    'a same-context decode failure must not blank the last valid frame',
  );
  assert.match(
    dialog,
    /decodedScreenshotData\?\.tabTitle[\s\S]{0,180}decodedScreenshotData\.tabTitle/,
    'the large viewer must swap pixels, freshness, and tab metadata as one decoded frame',
  );
  assert.match(
    tile,
    /deriveScreenshotPreviewMode\([\s\S]{0,180}authorizationRevoked: screenshotAuthorizationRevoked/,
    'screenshot aging must run only after all hard authorization gates are combined',
  );
  assert.match(tile, /screenshot-monitoring-warning-/);
  assert.match(
    privacy,
    /refetch = true/,
    'the purge must expose a refetch switch instead of always replaying the request',
  );
  assert.match(
    dashboard,
    /purgeStudentScreenshotTileCaches\([\s\S]{0,200}refetch: false/,
    'a hard-denied screenshot cohort must be scrubbed without replaying the denied request',
  );
  assert.match(
    dashboard,
    /purgeStudentHistoryTileCaches\([\s\S]{0,200}refetch: false/,
    'the history denial path carries the identical zero-backoff defect and the identical fence',
  );
  assert.match(
    dashboard,
    /purgedHardDeniedScreenshotKeyRef\.current === hardDeniedScreenshotStudentIdsKey\) return;/,
    'an unchanged denial set must not re-purge',
  );
});

test('a re-keyed screenshot cohort carries classmates forward but never a changed binding', async () => {
  const context = {
    schoolId: 'school-1',
    viewerId: 'teacher-1',
    authority: 'teacher:full:class',
    teachingSessionId: 'session-1',
  };
  const screenshotRequestFor = (students, requestContext = context) => (
    createTileBatchRequests(students, requestContext).find((request) => request.kind === 'screenshots')
  );
  const [signingIn, commanded, untouched] = ['student-a', 'student-b', 'student-c'];
  const previousStudents = [
    { studentId: signingIn, realtimeBinding: 'binding-a', classroomState: { revision: 3 } },
    { studentId: commanded, realtimeBinding: 'binding-b', classroomState: { revision: 1 } },
    { studentId: untouched, realtimeBinding: 'binding-c', classroomState: { revision: 1 } },
  ];
  const previousRequest = screenshotRequestFor(previousStudents);
  const previousData = {
    tiles: previousStudents.map((student) => ({
      studentId: student.studentId,
      screenshot: { screenshot: `${student.studentId}-pixel` },
    })),
  };
  const previousQuery = { queryKey: previousRequest.queryKey, state: { dataUpdatedAt: 1 } };

  const loginStudents = previousStudents.map((student) => (
    student.studentId === signingIn
      ? { ...student, realtimeBinding: 'binding-a-replacement' }
      : student
  ));
  const loginRequest = screenshotRequestFor(loginStudents);
  assert.notDeepEqual(
    loginRequest.queryKey,
    previousRequest.queryKey,
    'one student signing in must still re-key the whole exact-binding cohort',
  );
  const loginPlaceholder = screenshotCohortPlaceholderData(previousData, previousQuery, loginRequest);
  assert.deepEqual(
    loginPlaceholder.tiles.map((tile) => tile.studentId),
    [commanded, untouched],
    'classmates keep their painted frames while only the changed binding falls to loading',
  );

  const commandStudents = previousStudents.map((student) => (
    student.studentId === commanded
      ? { ...student, classroomState: { revision: 2 } }
      : student
  ));
  const commandPlaceholder = screenshotCohortPlaceholderData(
    previousData,
    previousQuery,
    screenshotRequestFor(commandStudents),
  );
  assert.deepEqual(
    commandPlaceholder.tiles.map((tile) => tile.studentId),
    [signingIn, untouched],
    'a teacher command must drop only the commanded student from the carry-forward',
  );

  assert.deepEqual(
    screenshotCohortPlaceholderData(previousData, previousQuery, loginRequest, {
      deniedStudentIds: new Set([commanded]),
    }).tiles.map((tile) => tile.studentId),
    [untouched],
    'a locally revoked student can never be carried forward',
  );
  assert.equal(
    screenshotCohortPlaceholderData(previousData, previousQuery, screenshotRequestFor(loginStudents, {
      ...context,
      viewerId: 'other-teacher',
    })),
    undefined,
    'another authority context can never seed a cohort from cached pixels',
  );
  assert.equal(
    screenshotCohortPlaceholderData(undefined, previousQuery, loginRequest),
    undefined,
    'a cohort with nothing to carry forward stays in its own loading state',
  );
  assert.equal(
    screenshotCohortPlaceholderData(previousData, previousQuery, previousRequest),
    undefined,
    'a key is never its own placeholder',
  );

  // The same carry-forward, driven through a real observer re-key: the
  // classmate keeps painting, the re-bound student does not, and the cache
  // entry for the replacement key stays empty until the POST answers.
  const placeholderClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  placeholderClient.mount();
  placeholderClient.setQueryData(previousRequest.queryKey, previousData);
  let releaseReplacementFetch;
  const replacementFetchGate = new Promise((resolve) => { releaseReplacementFetch = resolve; });
  const placeholderOptions = (request) => ({
    queryKey: request.queryKey,
    queryFn: async () => {
      await replacementFetchGate;
      return { tiles: [] };
    },
    select: indexTileScreenshots,
    retry: false,
    staleTime: 15_000,
    placeholderData: (carriedData, carriedQuery) => screenshotCohortPlaceholderData(
      carriedData,
      carriedQuery,
      request,
    ),
  });
  const placeholderObserver = new QueryObserver(placeholderClient, placeholderOptions(previousRequest));
  const unsubscribePlaceholder = placeholderObserver.subscribe(() => {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    placeholderObserver.setOptions(placeholderOptions(loginRequest));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rekeyedResult = placeholderObserver.getCurrentResult();
    assert.equal(rekeyedResult.isPlaceholderData, true, 'the re-keyed cohort must paint before its POST returns');
    assert.deepEqual(
      [...rekeyedResult.data.keys()],
      [commanded, untouched],
      'the re-bound student must be absent while classmates keep their frames',
    );
    assert.equal(
      placeholderClient.getQueryData(loginRequest.queryKey),
      undefined,
      'a carried-forward frame must stay observer-local and never enter the query cache',
    );
  } finally {
    releaseReplacementFetch();
    unsubscribePlaceholder();
    placeholderClient.unmount();
    placeholderClient.clear();
  }

  // New useQueries observers recover from the cache rather than from a prior
  // observer. Normalized keys omit a null tenure and add the absent-parent
  // marker for supervision, so raw view-context JSON is not a cache prefix.
  for (const requestContext of [
    { ...context, contextAuthorityRevision: null },
    { schoolId: context.schoolId, viewerId: context.viewerId, authority: 'teacher:scheduled-supervision:class',
      supervisionContextId: 'testing-1', contextAuthorityRevision: '0' },
  ]) {
    const cacheClient = new QueryClient();
    const cachedRequest = screenshotRequestFor(previousStudents, requestContext);
    cacheClient.setQueryData(cachedRequest.queryKey, previousData);
    const fromCache = (request) => buildScreenshotCohortPlaceholderData(
      cacheClient.getQueryCache().findAll({ queryKey: request.queryKey.slice(0, 2) }), request,
    );
    const replacement = screenshotRequestFor(loginStudents, requestContext);
    assert.deepEqual(fromCache(replacement)?.tiles.map(tile => tile.studentId), [commanded, untouched]);
    for (const changedContext of [
      { ...requestContext, viewerId: 'another-teacher' },
      { ...requestContext, contextAuthorityRevision: '1' },
      { schoolId: context.schoolId, viewerId: context.viewerId, authority: requestContext.authority,
        supervisionContextId: 'another-testing-context', contextAuthorityRevision: '0' },
    ]) {
      assert.equal(fromCache(screenshotRequestFor(loginStudents, changedContext)), undefined,
        'cached pixels cannot cross teacher, parent, or supervision tenure');
    }
    cacheClient.clear();
  }

  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const placeholderSource = dashboard.slice(
    dashboard.indexOf('const screenshotPlaceholderFunctions = useMemo('),
    dashboard.indexOf('const screenshotTileQueries = useQueries('),
  );
  assert.ok(placeholderSource.includes('deniedStudentIds: screenshotPlaceholderDeniedIds')
    && placeholderSource.includes('screenshotCohortPlaceholderData(previousData, previousQuery, request, privacy)')
    && /buildScreenshotCohortPlaceholderData\([\s\S]*queryKey: request\.queryKey\.slice\(0, 2\)[\s\S]*request,[\s\S]*privacy/.test(placeholderSource),
  'both observer and same-context cache carry-forward must use the exact revocation filter');
  assert.match(
    dashboard,
    /queryClient\.setQueryData\(request\.queryKey, \(previous\) => \(/,
    'targeted merges must keep writing the real cohort entry, never the observer-local placeholder',
  );
});

test('enabled observation scopes remain pending across A to B to A until their exact PUT succeeds', async () => {
  const [lease, dashboard, tile] = await Promise.all([
    readFile(new URL('../src/products/classpilot/hooks/useObservationLease.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(
    lease,
    /let status = 'pending';[\s\S]{0,180}if \(!enabled\) status = 'legacy';[\s\S]{0,280}else if \(leaseState\.contextKey === leaseContextKey\) status = leaseState\.status/,
    'an enabled exact context must stay pending until that context records its own lease response',
  );
  assert.match(lease, /if \(stopped\) return;/);
  // The Class lease is the class activity's alone; Claimed is served by one
  // lease per claimed context instead.
  assert.match(dashboard, /enabled: studentView === 'class' && Boolean\(effectiveActivity\?\.id\),/);
  assert.match(dashboard, /enabled: screenshotTileReadsEnabled/);
  assert.match(dashboard, /enabled: historyTileReadsEnabled/);
  assert.match(tile, /screenshotObservationStatus === 'pending'/);
  assert.match(tile, /Authorizing screen preview…/);
});

test('every claimed group holds its own supervision-context lease, never the class frozen-roster lease', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  // Every claimed group holds its own lease, so one group's denial cannot blank
  // another's tiles, and a student with no context still fails closed.
  assert.match(dashboard, /claimedPreviewContextsFromRoster\(displaySupervisionContexts, claimedPickupStudents\)/);
  assert.match(dashboard, /<ClaimedContextLease[\s\S]{0,200}supervisionContextId: context\.id|supervisionContextId: context\.id/);
  assert.match(dashboard, /claimedStudentObservationStatus = useCallback\(student => \{[\s\S]{0,300}if \(!context\) return 'denied';/);
  assert.match(dashboard, /return claimedLeaseStatuses\[`\$\{contextId\}:\$\{context\.contextAuthorityRevision\}`\] \|\| 'pending';/);
  // Each claimed batch carries its own context and revision, never the class one.
  assert.match(dashboard, /supervisionContextId: context\.id,[\s\S]{0,80}contextAuthorityRevision: context\.contextAuthorityRevision/);
  assert.match(dashboard, /screenshotTileReadsEnabled = studentView === 'claimed'/);
  assert.match(dashboard, /historyTileReadsEnabled = studentView !== 'available'[\s\S]{0,80}observationReadsAllowed/);
  assert.match(
    dashboard,
    /if \(studentView === 'class'\) return;[\s\S]{0,300}purgeLegacyScreenshotTileCaches\(queryClient\)/,
  );
  assert.match(dashboard, /tileScreenshotRevoked = tileSharedPrivacyRevoked[\s\S]{0,320}claimedTileStatus !== 'observed'[\s\S]{0,200}studentView !== 'class'/);
});

test('A to B switches replace the complete realtime routing context before queued events can flush', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const routingLayoutEffect = dashboard.match(
    /useLayoutEffect\(\(\) => \{[\s\S]{0,900}effectiveActivityIdRef\.current = effectiveActivityId;[\s\S]{0,300}aggregatedStudentsQueryKeyRef\.current = aggregatedStudentsQueryKey;[\s\S]{0,300}activeSchoolIdRef\.current = activeSchoolId;[\s\S]{0,300}coverageKeysRef\.current = \{ summaryQueryKey, claimedStudentsQueryKey \};[\s\S]{0,100}supervisionScopeRef\.current = classReaderKey;[\s\S]{0,300}pendingRealtimeEventsRef\.current = \[\];[\s\S]{0,500}\}, \[activeSchoolId, aggregatedStudentsQueryKey, effectiveActivityId, summaryQueryKey, claimedStudentsQueryKey, classReaderKey, effectiveAuthority\]\);/,
  );
  assert.ok(
    routingLayoutEffect,
    'session, query key, school, and queued events must switch atomically in one layout effect',
  );
  assert.doesNotMatch(
    dashboard,
    /useEffect\(\(\) => \{\s*aggregatedStudentsQueryKeyRef\.current/,
    'a later passive effect must not leave a session/query-key race window',
  );
  assert.match(
    dashboard,
    /if \(!currentSessionId\) return !messageSessionId;/,
    'Observe A to admin-school-wide must reject a delayed session-A event',
  );
  assert.match(
    dashboard,
    /const coverageEvents = coalesceStudentRealtimeEvents\(queued[\s\S]{0,220}entry\.coverageEligible/,
    'session-scoped classroom telemetry must not leak into a separately authorized coverage cache',
  );
  for (const eventType of [
    'live-view-requested',
    'hand-raised',
    'hand-lowered',
    'hand-dismissed',
    'student-message',
    'chat-message-delivery',
    'safety-alert',
    'screenshot-available',
    'student-event',
  ]) {
    const start = dashboard.indexOf(`if (message.type === '${eventType}')`);
    const next = dashboard.indexOf('if (message.type ===', start + 1);
    const handler = dashboard.slice(start, next < 0 ? dashboard.length : next);
    assert.ok(start >= 0, `missing ${eventType} handler`);
    assert.match(
      handler,
      /classRealtimeMessageEligibility\(message\)/,
      `${eventType} must reject a delayed session-A event before session-B side effects`,
    );
  }
});

test('detail history is fenced to the current authority and cannot reuse a stale selected row', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    dashboard,
    /selectedStudentRoster\.find\(\(student\) => student\.studentId === selectedStudent\.studentId\) \|\| null/,
  );
  assert.doesNotMatch(
    dashboard,
    /students\.find\(\(student\) => student\.studentId === selectedStudent\.studentId\) \|\| selectedStudent/,
  );
  assert.match(
    dashboard,
    /clearStudentDetails\(\);[\s\S]{0,240}\[\s*activeSchoolId,[\s\S]{0,220}effectiveActivityId,[\s\S]{0,160}studentView,/,
    'the drawer selection must be cleared when session or authority changes',
  );
  assert.match(
    dashboard,
    /const selectedStudentMissingFromRoster = Boolean\(selectedStudent && !selectedStudentRow\);[\s\S]{0,180}useLayoutEffect\(\(\) => \{\s*if \(selectedStudentMissingFromRoster\) clearStudentDetails\(\)/,
    'roster removal must clear selection before the same student ID can be authorized again',
  );
  assert.match(dashboard, /studentView !== 'available'/);
});

test('dashboard command entry points fail closed until the class roster is authoritative', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    dashboard,
    /const resolveActiveCommandTarget = \([\s\S]{0,320}overrideStudentIds = null,[\s\S]{0,320}\) => \{\s*if \(classStudentTargetsUnavailable\) \{\s*throw new Error/,
    'the final command-target resolver must reject an unknown class roster',
  );
  assert.match(
    dashboard,
    /const canUseRemoteControls = dashboardCapabilities\.canUseRemoteControls\s*&& !classStudentTargetsUnavailable/,
    'the classroom command row and student actions must share the unavailable-target guard',
  );
  assert.match(
    dashboard,
    /dashboardCapabilities\.canUseTeacherFab && !classStudentTargetsUnavailable/,
    'Teacher FAB and its messaging entry point must remain unavailable without a roster snapshot',
  );
});

test('late-sign-in restriction authoring is row-gated and command-specific', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    dashboard,
    /lateSignInRestrictionsEnabled = \(dashboardCapabilities\.ownedClassSession \|\| dashboardCapabilities\.scheduledSupervision\)\s*&& lateSignInRestrictionGateEnabled\(sessionFilteredStudents\)/,
    'the exact-school row projection must gate the signed-out authoring lane',
  );
  assert.match(
    dashboard,
    /commandSupportsLateSignInRestriction\(commandType, commandPayload\)[\s\S]{0,120}isStudentLateSignInRestrictionEligible\(student\)/,
    'signed-out students must be commandable only for persistent restriction commands',
  );
  const genericCommandability = dashboard.slice(
    dashboard.indexOf('const isStudentCommandable ='),
    dashboard.indexOf('const isStudentServerSignOutEligible ='),
  );
  assert.doesNotMatch(
    genericCommandability,
    /lateSignInRestrictionSsoV1Enabled|signed_out|isStudentLateSignInRestrictionEligible/,
    'a row-local capability must not make a signed-out student generically commandable',
  );
  assert.match(
    dashboard,
    /isStudentLateSignInRestrictionEligible = \(student\) => \([\s\S]{0,180}operatorEnabled: lateSignInRestrictionsEnabled/,
    'signed-out restriction eligibility must fail closed on the aggregate exact-school gate',
  );
  assert.match(
    dashboard,
    /selectableStudents[\s\S]{0,220}\[\.\.\.controllableStudents, \.\.\.lateSignInRestrictionStudents\]/,
    'Select All must include both online and gated signed-out students',
  );
  assert.match(
    dashboard,
    /partitionCurrentPageWaypointTargets\([\s\S]{0,180}explicitlySelectedStudents/,
    'current-page Waypoints must partition away students without fresh telemetry',
  );
});

test('Manage Tabs exposes a capability-gated tab limit that routes through the active command path', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  const limitMutationStart = dashboard.indexOf('const limitTabsMutation = useMutation');
  const limitMutationEnd = dashboard.indexOf('const lockScreenMutation = useMutation', limitMutationStart);
  assert.ok(limitMutationStart >= 0 && limitMutationEnd > limitMutationStart, 'missing limitTabsMutation');
  const limitMutation = dashboard.slice(limitMutationStart, limitMutationEnd);
  assert.match(
    limitMutation,
    /postActiveCommand\('limit-tabs', \{ maxTabs \}, recipients \? snapshotRecipientOptions\(recipients\) : \{ studentIds \}\)/,
    'the tab limit must go through the capability-checked active command path, to frozen or tile students',
  );
  assert.match(
    limitMutation,
    /invalidateQueries\(\{ queryKey: \['\/api\/commands\/active-state', activeSchoolId, currentUser\?\.id, effectiveAuthorityKey\] \}\)/,
  );
  assert.doesNotMatch(limitMutation, /\bonMutate\b|setQueryData/, 'the tab limit must not be applied optimistically');

  const dialogStart = dashboard.indexOf('data-testid="dialog-tabs"');
  const dialogEnd = dashboard.indexOf('{/* Apply Flight Path Dialog */}', dialogStart);
  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart, 'missing Manage Tabs dialog');
  const dialog = dashboard.slice(dialogStart, dialogEnd);
  assert.match(
    dialog,
    /dashboardCapabilities\.allows\('limit-tabs'\) && \([\s\S]{0,900}data-testid="input-tab-limit"[\s\S]{0,700}data-testid="button-apply-tab-limit"[\s\S]{0,500}data-testid="button-clear-tab-limit"/,
    'the tab-limit input and both actions must render only for an owned class inside the Manage Tabs dialog',
  );
  assert.match(dialog, /type="number"[\s\S]{0,80}min=\{1\}[\s\S]{0,40}max=\{100\}/);
  assert.match(
    dashboard,
    /queryKey: teacherPreferencesKey\(activeSchoolId, currentUser\?\.id\)[\s\S]{0,400}enabled: showCloseTabsDialog && dashboardCapabilities\.allows\('limit-tabs'\)[\s\S]{0,80}staleTime: 60_000/,
    'school/viewer preferences must load lazily only while Manage Tabs is open for an owned class',
  );
  assert.match(
    dashboard,
    /teacherTabLimitSeed\(teacherSettings, settings\?\.maxTabsPerStudent\)/,
    'the draft must seed from the resolved personal/school default before unlimited',
  );
});

test('past sessions load lazily and reuse the single mounted Session Summary dialog', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    dashboard,
    /queryKey: \['\/api\/classpilot\/teaching-sessions\/recent', activeSchoolId\][\s\S]{0,320}enabled: showPastSessions && Boolean\(activeSchoolId\)[\s\S]{0,80}staleTime: 30_000/,
    'the recent-sessions query must stay disabled until the popover opens',
  );
  assert.match(dashboard, /apiRequest\('GET', '\/classpilot\/teaching-sessions\/recent\?limit=20'\)/);
  assert.match(dashboard, /data-testid="dialog-past-sessions"/);
  assert.match(dashboard, /data-testid=\{`past-session-\$\{session\.id\}`\}/);
  assert.match(
    dashboard,
    /setShowPastSessions\(false\);\s*setSessionReportTarget\(\{ id: session\.id, name: session\.className \|\| 'Class' \}\);[\s\S]{0,120}data-testid=\{`button-open-session-report-\$\{session\.id\}`\}/,
    'opening a past summary must target the already-mounted report dialog',
  );
  assert.equal(
    dashboard.match(/<SessionMonitoringReportDialog/g)?.length,
    1,
    'past sessions must not mount a second Session Summary dialog',
  );
  assert.match(
    dashboard,
    /case "expired":\s*return \{ label: "Summary expired", action: "Summary expired", openable: false \};/,
  );
  assert.match(
    dashboard,
    /invalidateQueries\(\{ queryKey: \['\/api\/classpilot\/teaching-sessions\/recent'\], exact: false \}\)/,
    'ending a class must refresh the past-sessions list',
  );
});

test('sign-out-only selection closes command dialogs and cannot fall back to class-wide commands', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const closeEffectStart = dashboard.indexOf('if (!signOutOnlySelectionActive) return;');
  assert.ok(closeEffectStart >= 0, 'missing sign-out-only dialog shutdown effect');
  const closeEffect = dashboard.slice(closeEffectStart, closeEffectStart + 1_200);
  for (const setter of [
    'setShowOpenTabDialog(false)',
    'setShowCloseTabsDialog(false)',
    'setShowApplyFlightPathDialog(false)',
    'setShowFlightPathViewerDialog(false)',
    'setShowApplyBlockListDialog(false)',
    'setShowBlockListViewerDialog(false)',
    'setShowSendMessageDialog(false)',
    'setShowAttentionDialog(false)',
    'setShowTimerDialog(false)',
    'setShowPollDialog(false)',
    'setShowPollResultsDialog(false)',
    'setShowRerouteDialog(false)',
  ]) {
    assert.ok(closeEffect.includes(setter), `${setter} must close when sign-out-only selection starts`);
  }
  assert.match(
    dashboard,
    /assertClassroomCommandSelectionIsolation\(\s*commandType,\s*selectedServerSignOutStudentIds\.size,\s*\)/,
    'the final command builder must reject non-sign-out commands before resolving a default class target',
  );
  assert.match(
    dashboard,
    /const nonRestrictionSelectionActive = signOutOnlySelectionActive\s*\|\| lateSignInRestrictionSelectionActive/,
    'transient controls must treat both sign-out-only and deferred-restriction selections as unavailable',
  );
  assert.match(dashboard, /disabled=\{subgroupCommandsDisabled \|\| nonRestrictionSelectionActive\} data-testid="button-open-tab"/);
  assert.match(dashboard, /nonSignOutCommandsBlocked=\{signOutOnlySelectionActive\}/);
  assert.match(
    dashboard,
    /restrictionSelectionActive=\{lateSignInRestrictionSelectionActive\}/,
    'individual student actions must be blocked while a deferred-restriction selection is active',
  );
  assert.match(
    dashboard,
    /pollPending=\{nonRestrictionSelectionActive \|\| subgroupCommandsDisabled/,
  );
});

test('classroom dialogs freeze recipients when they open and send them as explicit studentIds', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const between = (startMarker, endMarker) => {
    const start = dashboard.indexOf(startMarker);
    assert.ok(start >= 0, `missing ${startMarker}`);
    const end = dashboard.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
    return dashboard.slice(start, end);
  };

  for (const [testId, kind] of [
    ['dialog-send-message', 'message'],
    ['dialog-attention-mode', 'attention'],
    ['dialog-timer', 'timer'],
    ['dialog-poll', 'poll'],
    ['dialog-open-tab', 'open-tab'],
    ['dialog-apply-flight-path', 'flight-path'],
    ['dialog-apply-block-list', 'block-list'],
  ]) {
    const dialog = between(`data-testid="${testId}"`, '</Dialog>');
    assert.doesNotMatch(dialog, /selectedStudentIds\.size/, `${testId} must not describe live ticks`);
    assert.doesNotMatch(dialog, /targetBannerLabel/, `${testId} must not describe the live target banner`);
    assert.match(
      dialog,
      new RegExp(`<CommandRecipients summaryAs=\\{DialogDescription\\} \\{\\.\\.\\.recipientDialogProps\\('${kind}'\\)\\} />`),
      `${testId} must list its frozen recipients`,
    );
    assert.match(dialog, /data-recipient-send=""/, `${testId} must mark the button that confirms a partial send`);
    assert.match(
      dialog,
      /onKeyDown=\{ignoreHeldEnter\}[^\n]*data-recipient-send=""/,
      `${testId} must not let a held Enter confirm a partial send`,
    );
    assert.match(dialog, /data-recipient-autofocus=""/, `${testId} must open in its first field, not on the recipient list`);
    assert.match(
      dashboard,
      new RegExp(`onOpenChange=\\{\\(open\\) => \\(open \\? setShow\\w+Dialog\\(true\\) : closeRecipientDialog\\('${kind}'\\)\\)\\}>\\s*<DialogContent[^>]*data-testid="${testId}"`),
      `closing ${testId} must discard its frozen recipients`,
    );
    const [, contentProps] = dashboard.match(new RegExp(`<DialogContent([^>]*)data-testid="${testId}"`));
    assert.match(contentProps, /onOpenAutoFocus=\{focusRecipientDialogField\}/, `${testId} must focus its marked field when it opens`);
    assert.match(contentProps, /max-h-\[calc\(100dvh-2rem\)\][^"]*overflow-y-auto/, `${testId} must scroll on a short screen instead of clipping its buttons`);
  }
  const recipients = await readFile(
    new URL('../src/products/classpilot/components/CommandRecipients.jsx', import.meta.url),
    'utf8',
  );
  assert.match(
    recipients,
    /<ul\s[^>]*aria-label="Recipients"\s+tabIndex=\{0\}/,
    'a long recipient list must be reachable, and scrollable, by keyboard',
  );
  assert.match(
    between('const ignoreHeldEnter = (event) => {', '\n  };'),
    /if \(event\.key === 'Enter' && event\.repeat\) event\.preventDefault\(\);/,
  );
  assert.match(
    between('const focusRecipientDialogField = (event) => {', '\n  };'),
    /querySelector\?\.\('\[data-recipient-autofocus\]'\);\s*if \(!field\) return;\s*event\.preventDefault\(\);\s*field\.focus\(/,
  );

  for (const [mutation, post] of [
    ['const sendMessageMutation = useMutation', /postClassroomCommand\('teacher-message', \{ message \}, snapshotRecipientOptions\(recipients\)\)/],
    ['const attentionModeMutation = useMutation', /postClassroomCommand\('attention-mode', \{ active, message \}, snapshotRecipientOptions\(recipients\)\)/],
    ['const timerMutation = useMutation', /postClassroomCommand\('timer', payload, snapshotRecipientOptions\(recipients\)\)/],
    ['const pollMutation = useMutation', /postClassroomCommand\('poll', \{ action: 'start', question, options \}, snapshotRecipientOptions\(recipients\)\)/],
    ['const openTabMutation = useMutation', /postActiveCommand\('open-tab', \{ url \}, snapshotRecipientOptions\(recipients\)\)/],
    ['const applyFlightPathMutation = useMutation', /postActiveCommand\('apply-flight-path', \{ flightPathId \}, snapshotRecipientOptions\(recipients\)\)/],
    ['const applyBlockListMutation = useMutation', /postActiveCommand\('apply-block-list', \{ blockListId \}, snapshotRecipientOptions\(recipients\)\)/],
  ]) {
    assert.match(between(mutation, 'onSuccess'), post, `${mutation} must post the frozen recipients`);
  }
  assert.match(
    between('const snapshotRecipientOptions = (recipients) => {', '\n  };'),
    /throw new Error\(RECIPIENTS_MISSING_MESSAGE\)[\s\S]{0,200}recipients\.scopeKey !== activityScopeRef\.current\) throw new Error\(RECIPIENTS_SCOPE_CHANGED_MESSAGE\)[\s\S]{0,80}return \{ studentIds: \[\.\.\.recipients\.studentIds\] \}/,
    'a send without recipients, or after the class changed, must fail closed instead of resolving a class target',
  );
  // Release, stop/pause/resume/extend and close keep their server-derived audience.
  assert.match(dashboard, /: postClassroomCommand\('attention-mode', \{ active, message \}\)\)/);
  assert.match(dashboard, /: postClassroomCommand\('timer', payload\)\)/);
  assert.match(dashboard, /postClassroomCommand\('poll', \{ action: 'close', pollId \}\)/);

  const opener = between('const openRecipientDialog = (kind, commandType, commandPayload = {}) => {', 'const clearRecipientSnapshot');
  assert.match(opener, /assertClassroomCommandSelectionIsolation\(commandType, selectedServerSignOutStudentIds\.size\)/);
  assert.match(opener, /dashboardCapabilities\.allows\(commandType\)/);
  assert.match(opener, /resolveActiveCommandTarget\(null, \{ commandType, commandPayload \}\)/);
  assert.match(opener, /snapshotCommandRecipients\(\{[\s\S]{0,500}scopeKey: activityScopeKey,\s*view: studentView,/);
  const refusal = opener.slice(opener.indexOf('} catch (error) {'));
  assert.match(refusal, /^\} catch \(error\) \{[\s\S]{0,700}toast\(\{\s*variant: 'destructive',[\s\S]{0,120}description: recipientDialogRefusalMessage\(error, \{[\s\S]{0,400}return false;\s*\}\s*\};/, 'an unavailable target must explain itself and not open the dialog');
  assert.doesNotMatch(refusal, /recipientDialogSetters|setRecipientSnapshot/, 'a refused dialog must not open or keep recipients');
  assert.match(opener, /setRecipientSnapshot\(\{ kind, snapshot, unavailableIds: null, confirmIds: null, notice: '' \}\);\s*recipientDialogSetters\[kind\]\(true\);\s*return true;/);
  assert.match(dashboard, /onClick=\{\(\) => openRecipientDialog\('open-tab', 'open-tab', \{ url: '' \}\)\} disabled=\{subgroupCommandsDisabled \|\| nonRestrictionSelectionActive\} data-testid="button-open-tab"/);
  assert.match(dashboard, /onSendMessage=\{subgroupCommandsDisabled \|\| !dashboardCapabilities\.allows\('teacher-message'\) \? undefined : \(\) => openRecipientDialog\('message', 'teacher-message'/);
  assert.match(dashboard, /onPollClick=\{\(\) => activePoll \? setShowPollResultsDialog\(true\) : openRecipientDialog\('poll', 'poll'/);
  assert.match(dashboard, /onPreset=\{\(preset\) => \{\s*if \(!openRecipientDialog\('poll', 'poll'/);
  assert.match(dashboard, /onTimerClick=\{\(\) => timerActive \? handleStopTimer\(\) : openRecipientDialog\('timer', 'timer'/);
  assert.match(dashboard, /onAttentionClick=\{\(\) => attentionActive \? setShowAttentionDialog\(true\) : openRecipientDialog\('attention', 'attention-mode'/);

  const take = between('const takeSnapshotRecipients = ', 'const snapshotRecipientOptions');
  assert.match(take, /snapshot\.scopeKey !== activityScopeRef\.current \|\| snapshot\.view !== studentView/);
  assert.match(take, /planRecipientSend\(\{\s*snapshot,\s*confirmIds: entry\.confirmIds,\s*commandableIds: commandableRecipientIds\(commandType, commandPayload\),\s*repeatGesture,\s*\}\)/);
  assert.match(take, /if \(step\.action === 'ignore'\) return null;/);
  assert.match(take, /if \(step\.action === 'ask'\) \{[^}]*\}\);\s*return null;\s*\}/, 'a lost recipient needs a second explicit send');
  assert.match(take, /if \(step\.action === 'restored'\) \{[\s\S]{0,300}return null;\s*\}/, 'a returning recipient is asked about, not silently skipped');
  assert.equal(take.match(/studentIds:/g)?.length, 1, 'only the planned send returns studentIds');
  assert.match(take, /studentIds: \[\.\.\.step\.studentIds\],/);

  for (const [handler, mutation, kind, send] of [
    ['const handleSendMessage = (event) => {', 'sendMessageMutation', 'message', 'sendMessageMutation.mutate({ message, recipients });'],
    ['const handleAttentionMode = (active, event) => {', 'attentionModeMutation', 'attention', 'attentionModeMutation.mutate({ active: true, message: attentionMessage, recipients });'],
    ['const handleStartTimer = (event) => {', 'timerMutation', 'timer', "timerMutation.mutate({ action: 'start', seconds: totalSeconds, message: timerMessage, recipients });"],
    ['const handleCreatePoll = (event) => {', 'pollMutation', 'poll', 'pollMutation.mutate({ question: pollQuestion.trim(), options: validOptions, recipients });'],
    ['const handleOpenTab = (event) => {', 'openTabMutation', 'open-tab', 'openTabMutation.mutate({ url: normalizedUrl, recipients });'],
    ['const handleApplyFlightPath = (event) => {', 'applyFlightPathMutation', 'flight-path', 'applyFlightPathMutation.mutate({ flightPathId: flightPath.id, allowedDomains: flightPath.allowedDomains || [], flightPathName: flightPath.flightPathName, recipients });'],
    ['const handleApplyBlockList = (event) => {', 'applyBlockListMutation', 'block-list', 'applyBlockListMutation.mutate({ blockListId: selectedBlockListId, recipients });'],
  ]) {
    const source = between(handler, send);
    assert.match(source, new RegExp(`if \\(${mutation}\\.isPending \\|\\| recipientSendBusyRef\\.current === '${kind}'\\) return;`), `${handler} must ignore a second send while one is in flight`);
    assert.match(source, new RegExp(`takeSnapshotRecipients\\('${kind}'`), `${handler} must send only frozen recipients`);
    assert.match(source, new RegExp(`if \\(!recipients\\) return;\\s*recipientSendBusyRef\\.current = '${kind}';\\s*$`), `${handler} must mark the send busy before mutating`);
    assert.match(between(`const ${mutation} = useMutation`, '\n  });'), new RegExp(`onSettled: [^\\n]*releaseRecipientSend\\('${kind}'\\)`), `${mutation} must release its busy mark when it settles`);
  }
  assert.match(between('data-testid="dialog-send-message"', 'data-testid="input-send-message"'), /e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.nativeEvent\.isComposing\) return;\s*e\.preventDefault\(\);\s*if \(e\.repeat\) return;/);
  assert.match(between('data-testid="dialog-open-tab"', 'data-testid="input-open-tab-url"'), /e\.key !== 'Enter' \|\| e\.nativeEvent\.isComposing \|\| openTabMutation\.isPending\) return;\s*if \(e\.repeat\) \{ e\.preventDefault\(\); return; \}/);
  assert.match(between('const recipientDeliveryToast = ', '\n  };'), /commandRecipientsSummary\(/, 'the toast names the audience without claiming delivery');

  for (const marker of [
    'if (!signOutOnlySelectionActive) return;',
    'if (!scheduledClassEnabled) return;',
  ]) {
    assert.match(between(marker, '}, ['), /setRecipientSnapshot\(null\);/, `${marker} must discard frozen recipients with the dialogs it closes`);
  }
  // A signed-out (deferred restriction) selection closes every dialog except
  // Apply Flight Path and Apply Block List, which keep their frozen recipients.
  assert.match(
    between('if (!lateSignInRestrictionSelectionActive) return;', '}, ['),
    /setRecipientSnapshot\(\(current\) => \(\['flight-path', 'block-list'\]\.includes\(current\?\.kind\) \? current : null\)\);/,
    'a deferred-restriction selection must discard frozen recipients only with the dialogs it closes',
  );
  assert.match(between('const handleAdminObservedSessionChange', 'const handleStopLiveView'), /setSkipTodayGroup\(null\);\s*setRecipientSnapshot\(null\);/);
  assert.match(dashboard, /throw new Error\(RECIPIENTS_UNAVAILABLE_MESSAGE\);/);
  assert.doesNotMatch(dashboard, /Clear the selection and try again/);
});

test('the Messages roster and the student grid share one last-name order, and roster rows carry no message text', async () => {
  const [dashboard, roster, rosterList] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/lib/chatRoster.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/ChatRosterList.jsx', import.meta.url), 'utf8'),
  ]);
  // One comparator: the grid's inline last-name sorts are gone.
  assert.match(dashboard, /import \{ compareStudentsByLastName \} from '\.\.\/lib\/studentOrder';/);
  assert.doesNotMatch(dashboard, /getLastName|localeCompare\(\w+\(b\.studentName\)\)/, 'no second copy of the student order');
  assert.match(
    dashboard,
    /const filteredClassStudents = sessionFilteredStudents\s+\.filter\([\s\S]{0,300}?\}\)\s+\.sort\(compareStudentsByLastName\);/,
    'the class grid sorts with the shared comparator',
  );
  assert.match(roster, /import \{ compareStudentsByLastName \} from '\.\/studentOrder\.js';/);
  assert.match(roster, /\[\.\.\.\(students \|\| \[\]\)\]\.sort\(compareStudentsByLastName\)/, 'the roster sorts with the same comparator');
  // The roster is the whole class: never the grid's search or subgroup filter.
  assert.match(dashboard, /buildMessagingRoster\(\{\s*students: sessionFilteredStudents,\s*monitoringByStudent: monitoringDisplaysByStudent,/);
  assert.doesNotMatch(dashboard, /buildMessagingRoster\(\{\s*students: filtered/);

  const { buildMessagingRoster } = await import('../src/products/classpilot/lib/chatRoster.js');
  const { compareStudentsByLastName } = await import('../src/products/classpilot/lib/studentOrder.js');
  const students = [
    { studentId: 'c', studentName: 'Cy Zed' },
    { studentId: 'a', studentName: 'Ada Student' },
    { studentId: 'b', studentName: 'ben adams' },
    { studentId: 'd', studentName: 'Ann Student' },
  ];
  const rows = buildMessagingRoster({
    students,
    conversations: [{ studentId: 'a', studentName: 'Ada Student', unreadCount: 1, lastItem: { message: 'private words' }, lastAt: '2026-09-18T14:00:00.000Z', items: [] }],
  });
  assert.deepEqual(rows.map((row) => row.studentId), [...students].sort(compareStudentsByLastName).map((row) => row.studentId));
  assert.equal(JSON.stringify(rows).includes('private words'), false, 'a roster row never carries what a student wrote');
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['canMessage', 'hasThread', 'mark', 'name', 'srStatus', 'studentId', 'unreadCount', 'word']);
  }

  // A row renders only primitives: no preview, time or avatar.
  assert.doesNotMatch(rosterList, /\blastItem\b|\blastAt\b|\.message\b|\.items\b|formatChatTimestamp|<time\b|\binitials\(/);
  const rowProps = rosterList.match(/const RosterRow = memo\(function RosterRow\(\{([\s\S]*?)\}\)/)?.[1];
  assert.ok(rowProps, 'RosterRow is memoised');
  assert.deepEqual(
    rowProps.split(',').map((prop) => prop.trim()).filter(Boolean).sort(),
    ['canMessage', 'current', 'focusable', 'hasThread', 'mark', 'name', 'onOpen', 'readinessKind', 'readinessLabel', 'srStatus', 'studentId', 'unreadCount', 'word'],
  );
});

test('a selection cleared automatically is refused, never widened, and every classroom send names its students', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const between = (startMarker, endMarker) => {
    const start = dashboard.indexOf(startMarker);
    assert.ok(start >= 0, `missing ${startMarker}`);
    const end = dashboard.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
    return dashboard.slice(start, end);
  };

  // The shared guard: the final resolver refuses the subgroup/class fallback
  // while a loss stands, except for controls whose audience the server derives.
  assert.match(
    between('const resolveActiveCommandTarget = (', 'const getActiveCommandStudents'),
    /selectionLoss: commandType && commandAudienceIsServerDerived\(commandType, commandPayload\)\s*\? null\s*: activeSelectionLoss,/,
  );
  // A lost selection belongs to one school and viewer, schedule boundary, view
  // and (Class view only) class authority revision: buildSelectionScopeKey
  // leaves the class session out of the Claimed view's scope.
  assert.match(
    dashboard,
    /const selectionScopeKey = buildSelectionScopeKey\(\{\s*readerKey: classReaderKey, transitionKey: scheduledTransitionKey, view: studentView, authorityKey: effectiveAuthorityKey,\s*\}\);/,
    'a lost selection belongs to one school, schedule boundary, view and Class-view authority revision',
  );
  assert.match(dashboard, /const activeSelectionLoss = selectionLoss\?\.scopeKey === selectionScopeKey \? selectionLoss : null;/);

  // Every automatic clearing records what it removed, with its cause; the
  // scope effect that drops a previous scope's loss is declared after them.
  const trim = between('const keepTick = (studentId) => (', '}, [lateSignInRestrictionEligibleStudentIds, monitoringDisplaysByStudent, selectionScopeKey, studentView]);');
  assert.match(
    trim,
    /^const keepTick = \(studentId\) => \(\s*monitoringDisplaysByStudent\.get\(studentId\)\?\.telemetryCurrent\s*\|\| lateSignInRestrictionEligibleStudentIds\.has\(studentId\)\s*\);/,
    'a signed-out tick for restrictions after sign-in is not dropped as stopped reporting; the binding check validates it',
  );
  assert.ok(
    dashboard.indexOf('const lateSignInRestrictionEligibleStudentIds = useMemo(') < dashboard.indexOf(trim),
    'the trim reads the late-sign-in eligibility it is declared after',
  );
  assert.match(trim, /if \(keepTick\(studentId\)\) next\.add\(studentId\);/);
  assert.match(trim, /const previousIds = \[\.\.\.selectedStudentIdsRef\.current\];\s*const keptIds = previousIds\.filter\(keepTick\);/);
  assert.match(trim, /selectionLossScopeRef\.current === selectionScopeKey\) \{\s*setSelectionLoss\(\(current\) => recordSelectionLoss\(current, \{\s*previousIds, keptIds, scopeKey: selectionScopeKey, reason: 'stopped-reporting',\s*\}\)\);/);
  assert.doesNotMatch(dashboard, /if \(monitoringDisplaysByStudent\.get\(studentId\)\?\.telemetryCurrent\) next\.add\(studentId\);/, 'one telemetry trim only');
  const bindingRecord = dashboard.indexOf("previousIds: previousCommandIds, keptIds: keptCommandIds, scopeKey: selectionScopeKey, reason: 'session-changed',");
  // A scope change drops the old scope's loss but keeps one recorded for the
  // new scope in the same commit (an automatic Class/Claimed switch).
  const scopeReset = dashboard.search(/selectionLossScopeRef\.current = selectionScopeKey;\s*setSelectionLoss\(\(current\) => \(current\?\.scopeKey === selectionScopeKey \? current : null\)\);/);
  assert.ok(dashboard.indexOf(trim) < bindingRecord && bindingRecord < scopeReset, 'record in both trims, then reset on a scope change');
  assert.doesNotMatch(dashboard, /selectionLossScopeRef\.current = selectionScopeKey;\s*setSelectionLoss\(null\);/, 'a scope change never drops the new scope\'s loss');
  // The supervision groups shown changed under ticked students, in the same
  // scope or by an automatic Class/Claimed switch: recorded for the view now
  // shown (with the chosen group and a selection already lost), so one-click
  // actions never reach every claimed student or the whole class.
  const automaticTarget = between('// The supervision groups shown changed (one ended, or one was assigned)', '}, [classReaderKey, studentView, automaticTestingTargetKey, clearStudentDetails]);');
  assert.match(
    automaticTarget,
    /const previousScopeKey = selectionLossScopeRef\.current;\s*const scopeKey = selectionScopeKeyRef\.current;\s*const automaticViewSwitch = previousScopeKey !== scopeKey && !studentViewChosenRef\.current\s*&& selectionScopeKeepsBoundary\(previousScopeKey, scopeKey\);\s*if \(previousScopeKey === scopeKey \|\| automaticViewSwitch\) \{/,
    'only a view staff did not pick, in the same school and boundary, carries the selection',
  );
  assert.match(automaticTarget, /const previousIds = \[\.\.\.selectedStudentIdsRef\.current\];\s*if \(selectedSubgroupIdRef\.current\) previousIds\.push\(selectedSubgroupIdRef\.current\);/);
  assert.match(automaticTarget, /previousIds: current\?\.scopeKey === previousScopeKey \? \[\.\.\.\(current\.lostIds \|\| \[\]\), \.\.\.previousIds\] : previousIds,\s*keptIds: \[\], scopeKey, reason: 'groups-changed',/);
  assert.ok(automaticTarget.indexOf("reason: 'groups-changed'") < automaticTarget.indexOf('setSelectedStudentIds(new Set());'));
  // The refs it reads are updated (layout) before it runs.
  for (const ref of [
    /const selectedSubgroupIdRef = useRef\(selectedSubgroupId\);\s*useLayoutEffect\(\(\) => \{ selectedSubgroupIdRef\.current = selectedSubgroupId; \}, \[selectedSubgroupId\]\);/,
    /const studentViewChosenRef = useRef\(studentViewChosen\);\s*useLayoutEffect\(\(\) => \{ studentViewChosenRef\.current = studentViewChosen; \}, \[studentViewChosen\]\);/,
  ]) {
    const declared = dashboard.search(ref);
    assert.ok(declared > 0 && declared < dashboard.indexOf(automaticTarget), `${ref} must be declared before the supervision-groups effect`);
  }
  const viewHook = await readFile(
    new URL('../src/products/classpilot/lib/useScheduledTestingView.js', import.meta.url),
    'utf8',
  );
  assert.match(viewHook, /studentViewChosen: Boolean\(manualSelection\),/, 'a view staff picked is never an automatic switch');
  // A removed subgroup is a lost target, never a silent whole class.
  const removedGroup = between('&& !subgroups.some((subgroup) => subgroup.id === selectedSubgroupId)', '}, [selectedSubgroupId, subgroups]);');
  assert.match(removedGroup, /const previousIds = \[\.\.\.selectedStudentIdsRef\.current, selectedSubgroupId\];\s*const scopeKey = selectionScopeKeyRef\.current;\s*if \(selectionLossScopeRef\.current === scopeKey\) \{\s*setSelectionLoss\(\(current\) => recordSelectionLoss\(current, \{\s*previousIds, keptIds: \[\], scopeKey, reason: 'group-removed',/);
  assert.match(dashboard, /const selectionScopeKeyRef = useRef\(selectionScopeKey\);\s*useLayoutEffect\(\(\) => \{ selectionScopeKeyRef\.current = selectionScopeKey; \}, \[selectionScopeKey\]\);/);
  // A new class, school or mode starts with no lost selection, except one
  // recorded for the view now shown. In an unchanged scope, a class session
  // starting or ending leaves Claimed-view ticks alone, and Class-view ticks
  // cleared when the class became unavailable are recorded.
  const modeResetEnd = dashboard.indexOf('}, [currentUser?.id, dashboardCapabilities.mode, effectiveActivity?.id, school?.id]);');
  assert.ok(modeResetEnd > 0, 'missing the class/mode reset effect');
  const modeReset = dashboard.slice(dashboard.lastIndexOf('useEffect(() => {', modeResetEnd), modeResetEnd);
  assert.match(
    modeReset,
    /const scopeKey = selectionScopeKeyRef\.current;\s*if \(selectionLossScopeRef\.current === scopeKey\) \{[\s\S]*?if \(studentViewRef\.current === 'claimed'\) return;[\s\S]*?const previousIds = \[\.\.\.selectedStudentIdsRef\.current\];\s*if \(previousIds\.length > 0\) \{\s*setSelectionLoss\(\(current\) => recordSelectionLoss\(current, \{\s*previousIds, keptIds: \[\], scopeKey, reason: 'class-unavailable',\s*\}\)\);\s*\}\s*\} else \{[\s\S]*?setSelectionLoss\(\(current\) => \(current\?\.scopeKey === scopeKey \? current : null\)\);\s*\}\s*setSelectedStudentIds\(new Set\(\)\);\s*setSelectedServerSignOutStudentIds\(new Set\(\)\);\s*setSelectedStudentBindingSnapshots\(new Map\(\)\);\s*$/,
  );
  assert.doesNotMatch(modeReset, /setSelectionLoss\(null\)/, 'a class session change never silently drops a lost selection');
  assert.match(between('if (!scheduledClassEnabled) return;', '}, ['), /setRecipientSnapshot\(null\);\s*setSelectionLoss\(null\);/);
  // Returning or releasing a student unticks only that student; it never
  // clears the other ticks (which would leave every claimed student targeted).
  assert.match(between('const deselectStudents = (studentIds = []) => {', '\n  };'), /setSelectedStudentIds\(\(prev\) => \{[\s\S]*!removed\.has\(studentId\)/);
  assert.doesNotMatch(between('const deselectStudents = (studentIds = []) => {', '\n  };'), /setSelectionLoss/);
  assert.match(between('const releaseClaimMutation = useMutation', 'onError'), /onSuccess: \(_data, variables\) => \{ if \(variables\.scope === supervisionScopeRef\.current\) \{ deselectStudents\(variables\.students\.map\(\(student\) => student\.studentId\)\);/);
  assert.doesNotMatch(between('const releaseClaimMutation = useMutation', 'const endTestingMutation'), /clearSelection\(\)/);
  assert.match(between('const returnToClassMutation = useMutation', 'onError'), /deselectStudents\(variables\?\.studentIds\);/);

  // Only the teacher's own choices clear a loss. "Choose again" only moves
  // focus: commands stay refused until the teacher actually chooses.
  assert.ok((between('const toggleStudentSelection = (studentId) => {', 'const selectAll = () => {').match(/setSelectionLoss\(null\);/g) || []).length >= 4);
  for (const [start, end] of [
    ['const selectAll = () => {', '\n  };'],
    ['const clearSelection = () => {', '\n  };'],
    ['const acceptSelectionLossFallback = () => {', '\n  };'],
    ['const handleStudentViewChange = (view) => {', '\n  };'],
  ]) {
    assert.match(between(start, end), /setSelectionLoss\(null\);/, `${start} must clear a lost selection`);
  }
  const chooseAgain = between('const chooseStudentsAgain = () => {', '\n  };');
  assert.doesNotMatch(chooseAgain, /setSelectionLoss/, '"Choose again" keeps the fallback refused until the teacher chooses');
  assert.match(chooseAgain, /const selectableIds = new Set\(selectableStudents\.map\(\(student\) => student\.studentId\)\);/, 'focus goes to a student the teacher can tick, not a stale one');
  assert.match(chooseAgain, /if \(checkbox\) checkbox\.focus\(\);\s*else focusSelectionTarget\(\);/);
  assert.match(between('const acceptSelectionLossFallback = () => {', '\n  };'), /focusSelectionTarget\(\);\s*setSelectionLoss\(null\);/, 'focus moves to the target before the notice goes away');
  assert.match(dashboard, /<div ref=\{selectionTargetRef\} tabIndex=\{-1\}[^>]*data-testid="badge-selection-count">/);
  assert.match(dashboard, /onChange=\{\(event\) => \{\s*setSelectionLoss\(null\);\s*setSelectedSubgroupId\(event\.target\.value\);/);
  // The status region stays mounted so the notice is announced when it appears.
  assert.match(dashboard, /<div role="status" data-testid="selection-lost-region">\s*\{selectionLossActive \? \(\s*<div className="[^"]*" data-testid="selection-lost-notice">/);
  const notice = between('data-testid="selection-lost-notice"', '\n        ) : null}');
  assert.match(notice, /\{selectionLostMessage\(activeSelectionLoss\.count, \{ scope: selectionLossScope, reason: activeSelectionLoss\.reason \}\)\}/);
  assert.match(notice, /onClick=\{chooseStudentsAgain\} data-testid="button-selection-lost-choose-again">Choose again</);
  assert.match(notice, /onClick=\{acceptSelectionLossFallback\} data-testid="button-selection-lost-use-all">\{selectionLossActionLabel\(selectionLossScope\)\}</);

  // postActiveCommand never resolves a live target for a missing list.
  assert.match(
    between('const postActiveCommand = ', 'const clickRecipientIds'),
    /if \(!Array\.isArray\(options\.studentIds\) \|\| options\.studentIds\.length === 0\) \{\s*throw new Error\(RECIPIENTS_MISSING_MESSAGE\);\s*\}\s*return studentView === "claimed"/,
  );
  assert.doesNotMatch(dashboard, /postActiveCommand\('apply-(?:flight-path|block-list)', \{ \w+ \}\)/, 'Apply Flight Path and Apply Block List must not post without studentIds');
  assert.match(between('const clickRecipientIds = ', '\n  };'), /return resolveActiveCommandTarget\(null, \{ commandType, commandPayload \}\)\.targetStudentIds;/);

  // Apply Flight Path and Apply Block List freeze their recipients when they open.
  assert.match(dashboard, /onClick=\{\(\) => openRecipientDialog\('flight-path', 'apply-flight-path'\)\}[^\n]*data-testid="button-apply-flight-path"/);
  assert.match(dashboard, /onClick=\{\(\) => openRecipientDialog\('block-list', 'apply-block-list'\)\}[^\n]*data-testid="button-apply-block-list"/);
  assert.match(dashboard, /onClick=\{\(\) => \{ if \(!openRecipientDialog\('block-list', 'apply-block-list'\)\) return; setSelectedBlockListId\(bl\.id\);/);
  // Only the dialogs' own onOpenChange (`open ? setShow…(true) : close…`) may
  // set them open directly; every opener goes through openRecipientDialog.
  assert.doesNotMatch(dashboard, /setShowApply(?:FlightPath|BlockList)Dialog\(true\)(?!\s*:)/, 'no opener may skip the frozen recipients');
  for (const probe of ['() => { setShowApplyFlightPathDialog(true); }', '() => { setShowApplyBlockListDialog(true) }', '() => setShowApplyFlightPathDialog(true)}']) {
    assert.match(probe, /setShowApply(?:FlightPath|BlockList)Dialog\(true\)(?!\s*:)/, `the opener check catches ${probe}`);
  }
  assert.match(dashboard, /const flightPathDomainRestrictionMessage = restrictionMessageForStudents\(recipientSnapshotRows\('flight-path'\)\);/);

  // Toolbar Manage Tabs uses its frozen list for the tabs it shows and for
  // bulk close and the tab limit; a tile's names exactly one student.
  assert.match(between('const openManageTabs = (studentIds = null) => {', '\n  };'), /if \(studentIds === null\) \{\s*if \(!openRecipientDialog\('manage-tabs', 'close-tabs', \{ closeAll: true \}\)\) return;/);
  assert.match(dashboard, /const manageTabsStudents = manageTabsStudentIds\s*\? getActiveCommandStudents\(manageTabsStudentIds\)\s*: recipientSnapshotRows\('manage-tabs', 'close-tabs', \{ closeAll: true \}\);/);
  assert.match(between('const handleCloseAllTabs = (event) => {', '\n  };'), /takeSnapshotRecipients\('manage-tabs', 'close-tabs', \{ closeAll: true \}, \{ repeatGesture: event\?\.detail > 1, action: 'close-all-tabs' \}\);[\s\S]*closeTabsMutation\.mutate\(\{ closeAll: true, recipients \}\);/);
  assert.match(between('const sendTabLimit = (maxTabs, event, action) => {', '\n  };'), /takeSnapshotRecipients\('manage-tabs', 'limit-tabs', \{ maxTabs \}, \{ repeatGesture: event\?\.detail > 1, action \}\);\s*if \(!recipients\) return;[\s\S]*limitTabsMutation\.mutate\(\{ maxTabs, recipients, draft \}\);/);
  // "Clear limit" empties the field only once a clear has gone through, and
  // not over a limit typed since; a refused or failed clear leaves it alone.
  assert.match(between('const handleClearTabLimit = (event) => {', '\n  };'), /^const handleClearTabLimit = \(event\) => \{\s*sendTabLimit\(null, event, 'clear-tab-limit'\);\s*$/);
  assert.doesNotMatch(between('const sendTabLimit = (maxTabs, event, action) => {', 'const handleCloseAllTabs'), /setTabLimitDraft\(/, 'pressing a send never empties the field');
  assert.match(
    between('const limitTabsMutation = useMutation', 'onError'),
    /onSuccess: \(data, variables\) => \{[\s\S]*if \(variables\?\.maxTabs === null\) setTabLimitDraft\(\(current\) => \(current === variables\.draft \? '' : current\)\);/,
  );
  assert.match(between('const closeTabsMutation = useMutation', 'onSuccess'), /postActiveCommand\('close-tabs', payload, recipients \? snapshotRecipientOptions\(recipients\) : \{ studentIds \}\)/);
  const tabsDialog = between('data-testid="dialog-tabs"', '</Dialog>');
  assert.match(tabsDialog, /<CommandRecipients summaryAs=\{DialogDescription\} offerCancel=\{false\} \{\.\.\.recipientDialogProps\('manage-tabs'\)\} \/>/);
  assert.match(tabsDialog, /onClick=\{handleCloseAllTabs\} onKeyDown=\{ignoreHeldEnter\}[^\n]*data-testid="button-close-all-tabs"/);
  assert.doesNotMatch(tabsDialog, /manageTabsStudents\.map/, 'bulk close must not re-read a live student list');
  assert.match(dashboard, /onOpenChange=\{\(open\) => \(open \? setShowCloseTabsDialog\(true\) : closeManageTabsDialog\(\)\)\}>\s*<DialogContent[^>]*data-testid="dialog-tabs"/);
  assert.match(between('const closeManageTabsDialog = () => {', '\n  };'), /clearRecipientSnapshot\('manage-tabs'\);/);

  // Class tools starts go to the selection resolved when pressed, explicitly.
  assert.match(between('const runClassToolsCommand = async', '\n  };'), /explicitTargets: !commandAudienceIsServerDerived\(type, payload\),/);
  assert.match(dashboard, /Boolean\(scheduledSupervisionId\) \|\| options\.explicitTargets === true \|\| hasUnavailableCommandTarget/);

  // Block List Status removes from the current target and names it.
  const blockListStatus = between('data-testid="dialog-block-list-viewer"', 'data-testid="button-remove-all-block-lists"');
  assert.match(blockListStatus, /Remove Block List from the current target/);
  assert.match(blockListStatus, /Target: \{displayedTargetBannerLabel\}\./);
  assert.doesNotMatch(blockListStatus, /from All Students/);
  assert.match(dashboard, /onClick=\{handleRemoveBlockList\}[^\n]*data-testid="button-remove-all-block-lists"/);
});
