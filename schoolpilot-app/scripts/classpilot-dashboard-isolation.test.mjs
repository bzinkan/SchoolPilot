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
    /screenshotTileReadsEnabled = studentView === 'class'[\s\S]{0,100}Boolean\(effectiveSessionId\)/,
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
    /if \(!failure\.releaseLease\)[\s\S]{0,180}setStatus\('error'\)[\s\S]{0,140}else \{[\s\S]{0,100}setStatus\(failure\.status\)[\s\S]{0,220}await deleteLease\(requestViewerId\)/,
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

test('dashboard retains dormant Live View code without exposing its portal or tile entrypoint', async () => {
  const [dashboard, tile, portal, sidebar] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/VideoPortal.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/ClassPilotSidebar.jsx', import.meta.url), 'utf8'),
  ]);

  assert.equal(dashboard.match(/<VideoPortal/g)?.length, 1, 'dashboard must render exactly one Live View portal');
  assert.match(dashboard, /const LIVE_VIEW_UI_ENABLED = false;/);
  assert.match(dashboard, /LIVE_VIEW_UI_ENABLED && dashboardCapabilities\.canUseLiveView && liveViewState\.expanded/);
  assert.match(dashboard, /onStartLiveView=\{LIVE_VIEW_UI_ENABLED &&/);
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
    /const tileDetailsRevoked = supervisedElsewhere[\s\S]{0,220}tileGlobalAuthorizationDenied[\s\S]{0,220}tileGlobalAuthorizationFailure[\s\S]{0,220}hardDeniedHistoryStudentIds\.has\(student\.studentId\)[\s\S]{0,180}detailHistoryDeniedStudentIds\.has\(student\.studentId\)[\s\S]{0,220}monitoringDisplay\?\.kind === 'delegated'/,
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
  assert.match(selectedDetailsRevocation, /detailHistoryDeniedStudentIds\.has\(selectedStudentRow\?\.studentId\)/);
  assert.match(selectedDetailsRevocation, /detailHistoryHardDenied/);
  assert.match(selectedDetailsRevocation, /selectedStudentDisplay\?\.kind === 'delegated'/);
  assert.match(
    dashboard,
    /useLayoutEffect\(\(\) => \{\s*if \(selectedStudentDetailsRevoked\) clearStudentDetails\(\)/,
    'an open drawer must close synchronously when its exact authority is revoked',
  );
  assert.match(
    dashboard,
    /detailHistoryFailureScope !== 'cohort'[\s\S]{0,180}setDetailHistoryDeniedStudentIds\([\s\S]{0,260}next\.add\(deniedStudentId\)/,
    'a single-detail 404 must persist as a per-student Details denial',
  );
  assert.match(
    dashboard,
    /setDetailHistoryDeniedStudentIds\([\s\S]{0,120}current\.size === 0 \? current : new Set\(\)[\s\S]{0,120}\[historyTileBindingTransitionKey\]/,
    'the per-student denial may clear only when the authorized history binding/context changes',
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
  assert.match(dashboard, /teachingSessionId: snapshot\.teachingSessionId/);
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
    /return studentView === 'class' \? \{ kind: 'class' \} : null/,
    'Class view must keep one exact full-class observation lease even when presentation filters change',
  );
  assert.match(lease, /observation-lease/);
  assert.match(lease, /document\.visibilityState !== 'visible'/);
  assert.match(lease, /setTimeout\(renew/);
  assert.match(lease, /apiRequest\('DELETE'/);
  assert.match(dashboard, /paused_unobserved/);
  assert.match(viewport, /IntersectionObserver/);
  assert.match(viewport, /rootMargin: '100% 0px'/);
  assert.match(dashboard, /nearViewportStudentIds\.has/);
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
    /observationAuthorizationRevoked = !screenshotIsClassBound[\s\S]{0,180}screenshotObservationStatus === 'pending'[\s\S]{0,120}screenshotObservationStatus === 'denied'[\s\S]{0,120}screenshotObservationStatus === 'paused_unobserved'/,
    'legacy V1 pixels must retain every observation-lease privacy gate',
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
    /screenshotTileReadsEnabled = studentView === 'class'[\s\S]{0,180}!\['denied', 'paused_unobserved'\]\.includes\(observationLeaseStatus\)/,
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
});

test('enabled observation scopes remain pending across A to B to A until their exact PUT succeeds', async () => {
  const [lease, dashboard, tile] = await Promise.all([
    readFile(new URL('../src/products/classpilot/hooks/useObservationLease.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(
    lease,
    /let status = 'pending';[\s\S]{0,180}if \(!enabled\) status = 'legacy';[\s\S]{0,100}else if \(leaseState\.contextKey === leaseContextKey\) status = leaseState\.status/,
    'an enabled exact context must stay pending until that context records its own lease response',
  );
  assert.match(lease, /if \(stopped\) return;/);
  assert.match(dashboard, /enabled: studentView === 'class' && Boolean\(effectiveSession\?\.id\)/);
  assert.match(dashboard, /enabled: screenshotTileReadsEnabled/);
  assert.match(dashboard, /enabled: historyTileReadsEnabled/);
  assert.match(tile, /screenshotObservationStatus === 'pending'/);
  assert.match(tile, /Authorizing screen preview…/);
});

test('claimed coverage stays telemetry-only without misusing the class frozen-roster lease', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );

  assert.match(dashboard, /studentView === 'claimed'[\s\S]{0,80}\? 'denied'/);
  assert.match(dashboard, /screenshotTileReadsEnabled = studentView === 'class'/);
  assert.match(dashboard, /historyTileReadsEnabled = studentView !== 'available'[\s\S]{0,80}observationReadsAllowed/);
  assert.match(
    dashboard,
    /if \(studentView === 'class'\) return;[\s\S]{0,300}purgeLegacyScreenshotTileCaches\(queryClient\)/,
  );
  assert.match(dashboard, /tileScreenshotRevoked = tileSharedPrivacyRevoked[\s\S]{0,160}studentView !== 'class'/);
});

test('A to B switches replace the complete realtime routing context before queued events can flush', async () => {
  const dashboard = await readFile(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const routingLayoutEffect = dashboard.match(
    /useLayoutEffect\(\(\) => \{[\s\S]{0,900}effectiveSessionIdRef\.current = effectiveSessionId;[\s\S]{0,300}aggregatedStudentsQueryKeyRef\.current = aggregatedStudentsQueryKey;[\s\S]{0,300}activeSchoolIdRef\.current = activeSchoolId;[\s\S]{0,300}pendingRealtimeEventsRef\.current = \[\];[\s\S]{0,500}\}, \[activeSchoolId, aggregatedStudentsQueryKey, effectiveSessionId\]\);/,
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
    /clearStudentDetails\(\);[\s\S]{0,240}\[\s*activeSchoolId,[\s\S]{0,220}effectiveSessionId,[\s\S]{0,160}studentView,/,
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
    /lateSignInRestrictionsEnabled = dashboardCapabilities\.ownedClassSession\s*&& lateSignInRestrictionGateEnabled\(sessionFilteredStudents\)/,
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
    /dashboardCapabilities\.canUseTeacherFab && !classStudentTargetsUnavailable && !nonRestrictionSelectionActive/,
  );
});
