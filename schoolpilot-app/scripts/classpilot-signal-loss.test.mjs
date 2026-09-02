import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MONITORING_SIGNAL_LOSS_MS,
  MONITORING_SIGNAL_LOSS_CONFIRMED_MS,
  MONITORING_CONFIRMATION_FRESH_MS,
  SCREENSHOT_ACTIVE_VIEW_CAPTURE_MS,
  SCREENSHOT_ACTIVE_VIEW_STALE_MS,
  SCREENSHOT_RECONNECT_RETAIN_MS,
  SCREENSHOT_STALE_MS,
  deriveScreenshotCaptureCadence,
  deriveScreenshotDisplay,
  deriveScreenshotHealthDisplay,
  deriveScreenshotPreviewMode,
  deriveStudentMonitoringDisplay,
  deriveUnavailablePreview,
  findNextStudentFreshnessBoundary,
  formatRelativeLastSeen,
  formatRemainingMinutes,
  normalizeObservedAtForDisplay,
  projectStudentMonitoringDisplays,
  removeStoppedLiveStream,
  screenshotStaleThresholdMs,
} from '../src/products/classpilot/lib/studentMonitoringDisplay.js';
import {
  MAX_TRACKED_TRANSIENT_COMMANDS,
  applyTransientCommandUpdate,
  completedStudentIdsFromCommand,
  commandDeliveryFeedback,
  expireTransientCommands,
  findNextTransientExpiry,
  hasPendingTransientAction,
  latestTransientClassroomUiEffect,
  trackTransientCommandResponse,
  transientClassroomUiEffect,
} from '../src/products/classpilot/lib/commandDeliveryTruth.js';
import {
  advanceGraceReconciliationLatch,
  reconcileGraceCohort,
} from '../src/products/classpilot/lib/graceReconciliation.js';

const observedAt = Date.parse('2026-08-13T12:00:00.000Z');
const monitoredStudent = (overrides = {}) => ({
  studentId: 'student-1',
  status: 'online',
  loginState: 'logged_in',
  isLoggedIn: true,
  activityState: 'active',
  monitoringState: 'healthy',
  activityFresh: true,
  realtimeBinding: 'binding-a',
  realtimeRevision: 3,
  realtimeObservedAt: new Date(observedAt).toISOString(),
  activeTabUrl: 'https://example.test/lesson',
  aiClassification: { category: 'non-educational' },
  ...overrides,
});

test('monitoring enters one grace state at 60 seconds and requires server confirmation at 90 seconds', () => {
  assert.equal(
    deriveStudentMonitoringDisplay(monitoredStudent(), observedAt + MONITORING_SIGNAL_LOSS_MS - 1).kind,
    'online',
  );
  assert.equal(
    deriveStudentMonitoringDisplay(monitoredStudent(), observedAt + MONITORING_SIGNAL_LOSS_MS).kind,
    'reconnecting',
  );
  assert.equal(
    deriveStudentMonitoringDisplay(
      monitoredStudent(),
      observedAt + MONITORING_SIGNAL_LOSS_CONFIRMED_MS,
      { lastSuccessfulReconciliationAtMs: null },
    ).kind,
    'updates_unavailable',
  );
  const confirmedLost = monitoredStudent({
    monitoringState: 'signal_lost',
    activityFresh: false,
    monitoringLostAt: new Date(observedAt + MONITORING_SIGNAL_LOSS_MS).toISOString(),
  });
  assert.equal(
    deriveStudentMonitoringDisplay(
      confirmedLost,
      observedAt + MONITORING_SIGNAL_LOSS_CONFIRMED_MS,
      { lastSuccessfulReconciliationAtMs: observedAt + MONITORING_SIGNAL_LOSS_MS },
    ).kind,
    'signal_lost',
  );
});

test('a confirmed loss becomes updates unavailable when both realtime and reconciliation go stale', () => {
  const confirmedLost = monitoredStudent({
    monitoringState: 'signal_lost',
    activityFresh: false,
    monitoringLostAt: new Date(observedAt + MONITORING_SIGNAL_LOSS_MS).toISOString(),
  });
  const reconciliationAtMs = observedAt + MONITORING_SIGNAL_LOSS_MS;
  const atConfirmation = deriveStudentMonitoringDisplay(
    confirmedLost,
    observedAt + MONITORING_SIGNAL_LOSS_CONFIRMED_MS,
    { lastSuccessfulReconciliationAtMs: reconciliationAtMs, realtimeHealthy: false },
  );
  assert.equal(atConfirmation.kind, 'signal_lost');
  assert.equal(
    atConfirmation.nextBoundaryAtMs,
    reconciliationAtMs + MONITORING_CONFIRMATION_FRESH_MS,
  );

  const afterBothPathsGoStale = deriveStudentMonitoringDisplay(
    confirmedLost,
    reconciliationAtMs + MONITORING_CONFIRMATION_FRESH_MS,
    { lastSuccessfulReconciliationAtMs: reconciliationAtMs, realtimeHealthy: false },
  );
  assert.equal(afterBothPathsGoStale.kind, 'updates_unavailable');

  const liveSubscriptionStillConfirmsNoNewHeartbeat = deriveStudentMonitoringDisplay(
    confirmedLost,
    reconciliationAtMs + MONITORING_CONFIRMATION_FRESH_MS + 30_000,
    { lastSuccessfulReconciliationAtMs: reconciliationAtMs, realtimeHealthy: true },
  );
  assert.equal(liveSubscriptionStillConfirmsNoNewHeartbeat.kind, 'signal_lost');
});

test('signed-out and delegated rows never enter a freshness timer', () => {
  const signedOut = monitoredStudent({ loginState: 'not_logged_in', isLoggedIn: false });
  const delegated = monitoredStudent({ activityState: 'delegated', _realtimeSuppressed: true });
  assert.equal(deriveStudentMonitoringDisplay(signedOut, observedAt).label, 'Not logged in');
  assert.equal(
    deriveStudentMonitoringDisplay(delegated, observedAt).label,
    'Monitoring handled by assigned staff',
  );
  assert.equal(findNextStudentFreshnessBoundary([signedOut, delegated], new Map(), observedAt), null);
});

test('authentication progress stays connected while preview authority refreshes independently', () => {
  const signingIn = deriveStudentMonitoringDisplay(monitoredStudent({
    restrictionAuthState: 'in_progress',
  }), observedAt + 1_000);
  assert.equal(signingIn.kind, 'signing_in');
  assert.equal(signingIn.label, 'Signing in');
  assert.equal(signingIn.telemetryCurrent, true);
  assert.equal(deriveUnavailablePreview(signingIn).reason, 'Updating preview');

  const returning = deriveStudentMonitoringDisplay(monitoredStudent({
    restrictionAuthState: 'returning',
  }), observedAt + 1_000);
  assert.equal(returning.kind, 'signing_in');

  const staleAuth = deriveStudentMonitoringDisplay(monitoredStudent({
    restrictionAuthState: 'in_progress',
  }), observedAt + MONITORING_SIGNAL_LOSS_MS);
  assert.equal(staleAuth.kind, 'reconnecting', 'freshness still derives only from heartbeat time');
});

test('classroom commands queue one targeted preview fallback instead of cohort refetch bursts', () => {
  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const start = dashboardSource.indexOf('const refreshScreenshotsForDevices = () =>');
  const end = dashboardSource.indexOf('const decorateCommandResponse', start);
  const refresh = dashboardSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(refresh, /queueTargetedScreenshotRefresh/);
  assert.match(refresh, /targetStudents\.map\(\(student\) => student\.studentId\)/);
  assert.doesNotMatch(refresh, /invalidateQueries|\[1000, 2000, 3000, 5000, 8000\]/);

  const tileSource = readFileSync(
    new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url),
    'utf8',
  );
  assert.match(tileSource, />Updating preview</);
  assert.match(tileSource, /screenshot-updating-authority/);
});

test('last-seen display rejects sentinel timestamps and formats valid observations relatively', () => {
  for (const invalid of [
    null,
    undefined,
    '',
    0,
    '0',
    -1,
    Number.NaN,
    Infinity,
    'not-a-date',
    '1970-01-01T00:00:00.000Z',
  ]) {
    assert.equal(normalizeObservedAtForDisplay(invalid, observedAt), null);
    assert.equal(formatRelativeLastSeen(invalid, observedAt), 'Never observed');
  }

  assert.equal(
    formatRelativeLastSeen(observedAt - (12 * 60_000), observedAt),
    'Last seen 12 minutes ago',
  );
  assert.equal(
    formatRelativeLastSeen(observedAt + 30_000, observedAt),
    'Last seen just now',
    'minor future clock skew must be clamped to the present',
  );
  assert.equal(
    formatRelativeLastSeen(observedAt + 61_000, observedAt),
    'Never observed',
    'timestamps beyond the bounded skew allowance are not observations',
  );

  const signedOutEpoch = monitoredStudent({
    loginState: 'not_logged_in',
    isLoggedIn: false,
    realtimeObservedAt: null,
    lastSeenAt: 0,
  });
  assert.equal(deriveStudentMonitoringDisplay(signedOutEpoch, observedAt).observedAtMs, null);

  const validFallback = deriveStudentMonitoringDisplay({
    ...signedOutEpoch,
    realtimeObservedAt: 0,
    lastSeenAt: observedAt - 60_000,
  }, observedAt);
  assert.equal(validFallback.observedAtMs, observedAt - 60_000);
});

test('unavailable previews preserve signed-out, delegated, and signal-loss truth', () => {
  const signedOutPreview = deriveUnavailablePreview({ kind: 'signed_out' });
  assert.equal(signedOutPreview.reason, 'Not logged in');
  assert.equal(signedOutPreview.showLastObservation, true);
  assert.equal(signedOutPreview.warning, false);

  const delegatedPreview = deriveUnavailablePreview({ kind: 'delegated' });
  assert.equal(delegatedPreview.reason, 'Monitoring handled by assigned staff');
  assert.equal(delegatedPreview.showLastObservation, false);
  assert.equal(delegatedPreview.warning, false);

  const signalLossPreview = deriveUnavailablePreview({ kind: 'signal_lost' });
  assert.equal(signalLossPreview.reason, 'Monitoring signal lost');
  assert.equal(signalLossPreview.showLastObservation, true);
  assert.equal(signalLossPreview.warning, true);
});

test('temporary allow countdowns use whole minutes, expire closed, and share the minute clock', () => {
  assert.equal(formatRemainingMinutes(observedAt + 10 * 60_000, observedAt), '10 min left');
  assert.equal(formatRemainingMinutes(observedAt + 9 * 60_000 + 30_000, observedAt), '9 min left');
  assert.equal(formatRemainingMinutes(observedAt + 60_000, observedAt), '1 min left');
  assert.equal(formatRemainingMinutes(observedAt + 59_999, observedAt), '<1 min left');
  assert.equal(formatRemainingMinutes(observedAt + 1, observedAt), '<1 min left');
  assert.equal(formatRemainingMinutes(observedAt, observedAt), null);
  assert.equal(formatRemainingMinutes(observedAt - 1, observedAt), null);
  assert.equal(formatRemainingMinutes(Number.NaN, observedAt), null);
  assert.equal(formatRemainingMinutes(null, observedAt), null);
  assert.equal(formatRemainingMinutes(observedAt + 60_000, Number.NaN), null);

  const tileSource = readFileSync(
    new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url),
    'utf8',
  );
  assert.match(
    tileSource,
    /data-testid=\{`badge-blocked-by-scene-\$\{student\.studentId\}`\}[\s\S]{0,1200}data-testid=\{`button-allow-temporarily-\$\{student\.studentId\}`\}/,
    'the Flight Path block badge must carry the temporary allow action',
  );
  assert.match(
    tileSource,
    /data-testid=\{`badge-blocked-\$\{student\.studentId\}`\}[\s\S]{0,1200}data-testid=\{`button-allow-temporarily-\$\{student\.studentId\}`\}/,
    'the blocked-domain badge must carry the temporary allow action',
  );
  assert.match(
    tileSource,
    /disabled=\{interactionsDisabled \|\| !canTempUnblock \|\| !onCommand \|\| commandPending\}/,
    'the temporary allow must fail closed on capability, callback, and pending state',
  );
  assert.match(tileSource, /studentTileTempUnblockCommand\(student, domain\)/);
  assert.match(
    tileSource,
    /data-testid=\{`badge-temp-allow-\$\{student\.studentId\}`\}[\s\S]{0,400}<ExpiryCountdown expiresAtMs=\{allow\.expiresAtMs\}/,
    'the temporary allow chip must count down through the shared minute leaf',
  );
  assert.doesNotMatch(tileSource, /button-temp-unblock|button-tab-limit/);

  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  assert.match(dashboardSource, /canTempUnblock=\{dashboardCapabilities\.allows\('temp-unblock'\)\}/);
  assert.match(
    dashboardSource,
    /activeTemporaryAllows\(student, freshnessNowMs\)\.map\(\(allow\) => allow\.domain\)[\s\S]{0,400}teacherAllowedDomains:/,
    'an active temporary allow must clear the off-task flag like a session allow',
  );
  assert.doesNotMatch(dashboardSource, /tempUnblockMutation/);

  const lastSeenSource = readFileSync(
    new URL('../src/products/classpilot/components/LastSeenTime.jsx', import.meta.url),
    'utf8',
  );
  assert.match(lastSeenSource, /export function useMinuteClock\(\)/);
  assert.match(lastSeenSource, /export const ExpiryCountdown = memo\(/);
  assert.equal((lastSeenSource.match(/setInterval\(/g) || []).length, 1, 'countdowns must not add a second timer');
  assert.equal((lastSeenSource.match(/subscribeToMinuteClock,/g) || []).length, 1, 'both leaves must subscribe through one hook');
});

test('the dashboard omits the aggregate signal-loss card while student tiles retain the warning', () => {
  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(dashboardSource, /text-monitoring-lost-count/);
  assert.doesNotMatch(dashboardSource, /monitoringLostCount/);
  assert.doesNotMatch(dashboardSource, /Signal lost — cause unknown/);
  assert.match(dashboardSource, /grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6/);

  const tileSource = readFileSync(
    new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url),
    'utf8',
  );
  assert.match(tileSource, /deriveUnavailablePreview/);
  assert.match(tileSource, /\{unavailablePreview\.reason\}/);
  assert.equal(
    deriveUnavailablePreview({ kind: 'signal_lost' }).reason,
    'Monitoring signal lost',
  );
});

test('missing timestamps fail closed to unavailable and explicit loss still needs a confirmed boundary', () => {
  const missingTime = monitoredStudent({ realtimeObservedAt: null });
  assert.equal(deriveStudentMonitoringDisplay(missingTime, observedAt).kind, 'updates_unavailable');

  const explicitLoss = monitoredStudent({
    monitoringState: 'signal_lost',
    activityFresh: false,
    monitoringLostAt: new Date(observedAt + 1_000).toISOString(),
  });
  assert.equal(deriveStudentMonitoringDisplay(explicitLoss, observedAt + 2_000).kind, 'online');
  assert.equal(deriveStudentMonitoringDisplay(
    explicitLoss,
    observedAt + MONITORING_SIGNAL_LOSS_CONFIRMED_MS,
    { lastSuccessfulReconciliationAtMs: observedAt + MONITORING_SIGNAL_LOSS_MS },
  ).kind, 'signal_lost');
});

test('a same-binding higher-revision observation clears signal loss immediately', () => {
  const lostStudent = monitoredStudent({
    monitoringState: 'signal_lost',
    activityFresh: false,
    monitoringLostAt: new Date(observedAt + MONITORING_SIGNAL_LOSS_MS).toISOString(),
  });
  const lost = deriveStudentMonitoringDisplay(
    lostStudent,
    observedAt + MONITORING_SIGNAL_LOSS_CONFIRMED_MS,
    { lastSuccessfulReconciliationAtMs: observedAt + MONITORING_SIGNAL_LOSS_MS },
  );
  assert.equal(lost.kind, 'signal_lost');
  const recovered = monitoredStudent({
    realtimeRevision: 4,
    realtimeObservedAt: new Date(observedAt + 60_000).toISOString(),
  });
  assert.equal(deriveStudentMonitoringDisplay(recovered, observedAt + 60_000).kind, 'online');
});

test('screenshots become stale at 75 seconds independently of healthy URL telemetry', () => {
  const screenshot = { screenshot: 'data:image/jpeg;base64,test', timestamp: observedAt };
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS - 1).fresh, true);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS).fresh, false);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS).retained, true);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_RECONNECT_RETAIN_MS).retained, false);

  const student = monitoredStudent({ realtimeObservedAt: new Date(observedAt + 70_000).toISOString() });
  assert.equal(deriveStudentMonitoringDisplay(student, observedAt + SCREENSHOT_STALE_MS).telemetryCurrent, true);
});

test('authorized screenshot pixels use exact 75-second and 120-second display boundaries', () => {
  const screenshotData = { screenshot: 'data:image/jpeg;base64,test', timestamp: observedAt };
  assert.equal(deriveScreenshotPreviewMode({
    screenshotData,
    nowMs: observedAt + SCREENSHOT_STALE_MS - 1,
  }), 'current');
  assert.equal(deriveScreenshotPreviewMode({
    screenshotData,
    nowMs: observedAt + SCREENSHOT_STALE_MS,
    telemetryCurrent: true,
    transportHealthy: true,
  }), 'retained', 'a healthy heartbeat cannot make a 75-second screenshot look current or disappear');
  assert.equal(deriveScreenshotPreviewMode({
    screenshotData,
    nowMs: observedAt + SCREENSHOT_RECONNECT_RETAIN_MS - 1,
    telemetryCurrent: false,
    transportHealthy: false,
  }), 'retained', 'a stale heartbeat keeps only the visibly aged authorized image');
  assert.equal(deriveScreenshotPreviewMode({
    screenshotData,
    nowMs: observedAt + SCREENSHOT_RECONNECT_RETAIN_MS,
  }), null);
  assert.equal(deriveScreenshotPreviewMode({
    screenshotData,
    nowMs: observedAt + 1,
    authorizationRevoked: true,
  }), null, 'authorization loss wins even over a one-millisecond-old cached image');
});

test('signal-loss tiles schedule both screenshot-aging transitions', () => {
  const student = monitoredStudent({ studentId: 'signal-loss-boundary-student' });
  const screenshots = new Map([[
    student.studentId,
    { screenshot: 'data:image/jpeg;base64,test', timestamp: observedAt },
  ]]);
  const signalLostDisplays = new Map([[
    student.studentId,
    {
      kind: 'signal_lost',
      status: 'signal_lost',
      label: 'Monitoring signal lost',
      telemetryCurrent: false,
      observedAtMs: observedAt,
      nextBoundaryAtMs: null,
    },
  ]]);
  assert.equal(
    findNextStudentFreshnessBoundary(
      [student],
      screenshots,
      observedAt + SCREENSHOT_STALE_MS - 1,
      signalLostDisplays,
    ),
    observedAt + SCREENSHOT_STALE_MS,
  );
  assert.equal(
    findNextStudentFreshnessBoundary(
      [student],
      screenshots,
      observedAt + SCREENSHOT_STALE_MS,
      signalLostDisplays,
    ),
    observedAt + SCREENSHOT_RECONNECT_RETAIN_MS,
  );
  assert.equal(
    findNextStudentFreshnessBoundary(
      [student],
      screenshots,
      observedAt + SCREENSHOT_RECONNECT_RETAIN_MS,
      signalLostDisplays,
    ),
    null,
  );
});

test('observed active-view tiles age at 15 seconds while every default boundary stays byte-identical', () => {
  assert.equal(SCREENSHOT_ACTIVE_VIEW_CAPTURE_MS, 5_000);
  assert.equal(SCREENSHOT_ACTIVE_VIEW_STALE_MS, 15_000);
  assert.equal(screenshotStaleThresholdMs('active_view'), 15_000);
  assert.equal(screenshotStaleThresholdMs('background'), SCREENSHOT_STALE_MS);
  assert.equal(screenshotStaleThresholdMs(undefined), SCREENSHOT_STALE_MS);

  const screenshot = { screenshot: 'data:image/jpeg;base64,test', timestamp: observedAt };
  const activeView = { staleThresholdMs: 15_000 };
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + 14_999, activeView).fresh, true);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + 15_000, activeView).fresh, false);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + 15_000, activeView).retained, true);
  assert.equal(
    deriveScreenshotDisplay(screenshot, observedAt + 14_999, activeView).nextBoundaryAtMs,
    observedAt + 15_000,
    'the active-view boundary must be scheduled at exactly 15 seconds',
  );
  assert.equal(
    deriveScreenshotDisplay(screenshot, observedAt + 15_000, activeView).nextBoundaryAtMs,
    observedAt + SCREENSHOT_RECONNECT_RETAIN_MS,
    'retention stays at the shared 120-second boundary',
  );
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_RECONNECT_RETAIN_MS, activeView).retained, false);
  assert.equal(
    deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS, { staleThresholdMs: 600_000 }).fresh,
    false,
    'a cadence threshold may only tighten, never extend, the 75-second default',
  );
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + 20_000, { staleThresholdMs: Number.NaN }).fresh, true);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + 20_000, { staleThresholdMs: 0 }).fresh, true);

  assert.deepEqual(
    deriveScreenshotDisplay(screenshot, observedAt + 20_000),
    deriveScreenshotDisplay(screenshot, observedAt + 20_000, {}),
    'the default display must be identical with or without the option bag',
  );
  assert.deepEqual(
    deriveScreenshotDisplay(screenshot, observedAt + 20_000),
    deriveScreenshotDisplay(screenshot, observedAt + 20_000, { staleThresholdMs: SCREENSHOT_STALE_MS }),
  );
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + 20_000).fresh, true);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS - 1).fresh, true);
  assert.equal(deriveScreenshotDisplay(screenshot, observedAt + SCREENSHOT_STALE_MS).fresh, false);

  assert.equal(deriveScreenshotPreviewMode({ screenshotData: screenshot, nowMs: observedAt + 20_000 }), 'current');
  assert.equal(
    deriveScreenshotPreviewMode({ screenshotData: screenshot, nowMs: observedAt + 20_000, staleThresholdMs: 15_000 }),
    'retained',
    'an observed active-view tile must dim once its 5-second cadence has stalled for 15 seconds',
  );
  assert.equal(
    deriveScreenshotPreviewMode({ screenshotData: screenshot, nowMs: observedAt + 14_999, staleThresholdMs: 15_000 }),
    'current',
  );
  assert.equal(
    deriveScreenshotPreviewMode({ screenshotData: screenshot, nowMs: observedAt + 1, staleThresholdMs: 15_000, authorizationRevoked: true }),
    null,
  );
});

test('the capture cadence is active-view only for an observed, capability-accepted student', () => {
  const accepted = monitoredStudent({ acceptedCapabilities: { screenshotActiveObservationCadenceV1: true } });
  assert.equal(deriveScreenshotCaptureCadence({ student: accepted, observationLeaseStatus: 'observed' }), 'active_view');
  for (const status of ['pending', 'denied', 'paused_unobserved', 'legacy', undefined]) {
    assert.equal(
      deriveScreenshotCaptureCadence({ student: accepted, observationLeaseStatus: status }),
      'background',
      `${status} observation must stay on the background cadence`,
    );
  }
  assert.equal(
    deriveScreenshotCaptureCadence({
      student: monitoredStudent({ capabilities: { screenshotActiveObservationCadenceV1: true } }),
      observationLeaseStatus: 'observed',
    }),
    'background',
    'an extension advertisement without server acceptance must not claim the fast cadence',
  );
  assert.equal(
    deriveScreenshotCaptureCadence({
      student: monitoredStudent({ acceptedCapabilities: { screenshotActiveObservationCadenceV1: 'true' } }),
      observationLeaseStatus: 'observed',
    }),
    'background',
  );
  assert.equal(deriveScreenshotCaptureCadence({ student: monitoredStudent(), observationLeaseStatus: 'observed' }), 'background');
  assert.equal(deriveScreenshotCaptureCadence({}), 'background');
  assert.equal(deriveScreenshotCaptureCadence(), 'background');
});

test('screenshot health chips explain capture state without leaking the raw extension error', () => {
  const healthy = { lastSuccessAt: observedAt - 2_000, lastErrorAt: 0, lastError: '', attempts: 10, successes: 10, alarmActive: false };
  const online = deriveStudentMonitoringDisplay(monitoredStudent(), observedAt + 1_000);
  const freshDisplay = { available: true, fresh: true, retained: true };
  const staleDisplay = { available: true, fresh: false, retained: true };
  const cases = [
    {
      name: 'active view with a fresh frame is live',
      student: monitoredStudent({ screenshotHealth: healthy }),
      options: { cadence: 'active_view', screenshotDisplay: freshDisplay },
      expected: { kind: 'live', label: 'Live preview · 5s', tone: 'ok' },
    },
    {
      name: 'active view with a stale frame is delayed',
      student: monitoredStudent({ screenshotHealth: healthy }),
      options: { cadence: 'active_view', screenshotDisplay: staleDisplay },
      expected: { kind: 'delayed', label: 'Preview delayed', tone: 'warn' },
    },
    {
      name: 'active view without any frame is delayed',
      student: monitoredStudent({ screenshotHealth: healthy }),
      options: { cadence: 'active_view', screenshotDisplay: null },
      expected: { kind: 'delayed', label: 'Preview delayed', tone: 'warn' },
    },
    {
      name: 'background cadence explains the slow refresh',
      student: monitoredStudent({ screenshotHealth: healthy }),
      options: { cadence: 'background', screenshotDisplay: freshDisplay },
      expected: { kind: 'background', label: 'Preview every 30s', tone: 'muted' },
    },
    {
      // Regression guard: `alarmActive` means the extension's periodic capture
      // alarm is scheduled, which is the healthy state on every monitored
      // device. Reading it as a failure badged the whole wall.
      name: 'a scheduled capture alarm is healthy, never a failure',
      student: monitoredStudent({ screenshotHealth: { ...healthy, alarmActive: true } }),
      options: { cadence: 'active_view', screenshotDisplay: freshDisplay },
      expected: { kind: 'live', label: 'Live preview · 5s', tone: 'ok' },
    },
    {
      name: 'a scheduled alarm does not mask a genuine recent capture error',
      student: monitoredStudent({ screenshotHealth: { ...healthy, alarmActive: true, lastErrorAt: observedAt - 1_000, lastError: 'captureVisibleTab: permission denied' } }),
      options: { cadence: 'active_view', screenshotDisplay: freshDisplay },
      expected: { kind: 'failing', label: 'Preview capture failing', tone: 'warn' },
    },
    {
      name: 'a stale capture error with the alarm scheduled reports the background cadence',
      student: monitoredStudent({ screenshotHealth: { ...healthy, alarmActive: true, lastSuccessAt: observedAt - 200_000, lastErrorAt: observedAt - 150_001, lastError: 'boom' } }),
      options: { cadence: 'background', screenshotDisplay: freshDisplay },
      expected: { kind: 'background', label: 'Preview every 30s', tone: 'muted' },
    },
    {
      name: 'a recent error after the last success is failing on the active cadence',
      student: monitoredStudent({ screenshotHealth: { ...healthy, lastErrorAt: observedAt - 1_000, lastError: 'boom' } }),
      options: { cadence: 'active_view', screenshotDisplay: freshDisplay },
      expected: { kind: 'failing', label: 'Preview capture failing', tone: 'warn' },
    },
    {
      name: 'an error older than twice the active threshold no longer fails',
      student: monitoredStudent({ screenshotHealth: { ...healthy, lastSuccessAt: observedAt - 60_000, lastErrorAt: observedAt - 30_001, lastError: 'boom' } }),
      options: { cadence: 'active_view', screenshotDisplay: freshDisplay },
      expected: { kind: 'live', label: 'Live preview · 5s', tone: 'ok' },
    },
    {
      name: 'an error inside twice the active threshold is failing',
      student: monitoredStudent({ screenshotHealth: { ...healthy, lastSuccessAt: observedAt - 60_000, lastErrorAt: observedAt - 30_000, lastError: 'boom' } }),
      options: { cadence: 'active_view', screenshotDisplay: freshDisplay },
      expected: { kind: 'failing', label: 'Preview capture failing', tone: 'warn' },
    },
    {
      name: 'the background cadence keeps the wider 150-second failure window',
      student: monitoredStudent({ screenshotHealth: { ...healthy, lastSuccessAt: observedAt - 60_000, lastErrorAt: observedAt - 30_001, lastError: 'boom' } }),
      options: { cadence: 'background', screenshotDisplay: freshDisplay },
      expected: { kind: 'failing', label: 'Preview capture failing', tone: 'warn' },
    },
    {
      name: 'the background failure window also closes at 150 seconds',
      student: monitoredStudent({ screenshotHealth: { ...healthy, lastSuccessAt: observedAt - 200_000, lastErrorAt: observedAt - 150_001, lastError: 'boom' } }),
      options: { cadence: 'background', screenshotDisplay: freshDisplay },
      expected: { kind: 'background', label: 'Preview every 30s', tone: 'muted' },
    },
    {
      name: 'an error before a later success is not failing',
      student: monitoredStudent({ screenshotHealth: { ...healthy, lastErrorAt: observedAt - 5_000, lastSuccessAt: observedAt - 1_000 } }),
      options: { cadence: 'active_view', screenshotDisplay: freshDisplay },
      expected: { kind: 'live', label: 'Live preview · 5s', tone: 'ok' },
    },
    {
      name: 'an error with no success ever is failing',
      student: monitoredStudent({ screenshotHealth: { ...healthy, lastSuccessAt: 0, lastErrorAt: observedAt - 1_000 } }),
      options: { cadence: 'background', screenshotDisplay: null },
      expected: { kind: 'failing', label: 'Preview capture failing', tone: 'warn' },
    },
  ];
  for (const { name, student, options, expected } of cases) {
    const display = deriveScreenshotHealthDisplay(student, { nowMs: observedAt, monitoringDisplay: online, ...options });
    assert.deepEqual(display, expected, name);
    assert.equal(JSON.stringify(display).includes('boom'), false, `${name}: raw lastError must never render`);
    assert.equal(JSON.stringify(display).includes('captureVisibleTab'), false, `${name}: raw lastError must never render`);
  }

  assert.equal(deriveScreenshotHealthDisplay(monitoredStudent(), { nowMs: observedAt, cadence: 'active_view' }), null, 'no health means no chip');
  assert.equal(deriveScreenshotHealthDisplay(monitoredStudent({ screenshotHealth: 'bad' }), { nowMs: observedAt }), null);
  assert.equal(
    deriveScreenshotHealthDisplay(monitoredStudent({ screenshotHealth: healthy }), {
      nowMs: observedAt,
      cadence: 'active_view',
      screenshotDisplay: freshDisplay,
      monitoringDisplay: deriveStudentMonitoringDisplay(monitoredStudent(), observedAt + MONITORING_SIGNAL_LOSS_MS),
    }),
    null,
    'stale telemetry must hide capture health',
  );
  assert.equal(
    deriveScreenshotHealthDisplay(monitoredStudent({ screenshotHealth: healthy }), {
      nowMs: observedAt,
      monitoringDisplay: { kind: 'signed_out', telemetryCurrent: true },
    }),
    null,
  );
  assert.equal(
    deriveScreenshotHealthDisplay(monitoredStudent({ screenshotHealth: healthy }), {
      nowMs: observedAt,
      monitoringDisplay: { kind: 'delegated', telemetryCurrent: true },
    }),
    null,
  );
  assert.equal(
    deriveScreenshotHealthDisplay(monitoredStudent({ screenshotHealth: healthy }), { nowMs: observedAt })?.kind,
    'background',
    'without a monitoring display the chip is derived from cadence alone',
  );

  const tileSource = readFileSync(
    new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url),
    'utf8',
  );
  assert.match(tileSource, /screenshot-health-/);
  assert.match(tileSource, /const staleThresholdMs = screenshotStaleThresholdMs\(screenshotCaptureCadence\)/);
  assert.match(
    tileSource,
    /deriveScreenshotPreviewMode\(\{[\s\S]{0,180}authorizationRevoked: screenshotAuthorizationRevoked,\s*staleThresholdMs,/,
    'the preview mode must honor the cadence threshold after every hard authorization gate',
  );
  assert.match(tileSource, /staleThresholdMs: screenshotStaleThresholdMs\(props\.screenshotCaptureCadence\)/, 'memo equality must project the cadence-aware freshness');
  assert.doesNotMatch(tileSource, /screenshotHealth\.lastError|lastError\}/, 'the raw extension error must never render in a tile');
  assert.match(tileSource, /screenshot-updating-authority/);
  assert.match(tileSource, /\{unavailablePreview\.reason\}/);

  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  assert.match(
    dashboardSource,
    /const screenshotCaptureCadence = deriveScreenshotCaptureCadence\(\{\s*student,\s*observationLeaseStatus: tileScreenshotObservationStatus,\s*\}\);/,
  );
  assert.match(dashboardSource, /screenshotCaptureCadence=\{screenshotCaptureCadence\}/);
  assert.match(
    dashboardSource,
    /findNextStudentFreshnessBoundary\([\s\S]{0,400}\(student\) => screenshotStaleThresholdMs\(deriveScreenshotCaptureCadence\(\{[\s\S]{0,120}observationLeaseStatus: tileScreenshotObservationStatus/,
    'the freshness timer must schedule the 15-second active-view boundary',
  );
  assert.match(
    dashboardSource,
    /const expandedScreenshotDisplay = deriveScreenshotDisplay\(\s*expandedScreenshotHardRevoked \? null : expandedScreenshotData,\s*freshnessNowMs,\s*\);/,
    'the enlarged viewer keeps the default 75-second threshold',
  );
});

test('the freshness planner schedules the active-view boundary only for tiles whose resolver tightens it', () => {
  const activeStudent = monitoredStudent({
    studentId: 'active-view-student',
    acceptedCapabilities: { screenshotActiveObservationCadenceV1: true },
  });
  const backgroundStudent = monitoredStudent({ studentId: 'background-student' });
  const screenshots = new Map([
    [activeStudent.studentId, { screenshot: 'a', timestamp: observedAt }],
    [backgroundStudent.studentId, { screenshot: 'b', timestamp: observedAt }],
  ]);
  const displays = new Map([
    [activeStudent.studentId, deriveStudentMonitoringDisplay(activeStudent, observedAt + 1_000)],
    [backgroundStudent.studentId, deriveStudentMonitoringDisplay(backgroundStudent, observedAt + 1_000)],
  ]);
  const resolver = (student) => screenshotStaleThresholdMs(
    deriveScreenshotCaptureCadence({ student, observationLeaseStatus: 'observed' }),
  );
  assert.equal(
    findNextStudentFreshnessBoundary([activeStudent, backgroundStudent], screenshots, observedAt + 1_000, displays, resolver),
    observedAt + 15_000,
    'the earliest boundary must be the observed tile aging at 15 seconds',
  );
  assert.equal(
    findNextStudentFreshnessBoundary([backgroundStudent], screenshots, observedAt + 1_000, displays, resolver),
    observedAt + MONITORING_SIGNAL_LOSS_MS,
    'a background tile keeps the heartbeat grace boundary ahead of its 75-second screenshot boundary',
  );
  assert.equal(
    findNextStudentFreshnessBoundary([activeStudent, backgroundStudent], screenshots, observedAt + 1_000, displays),
    observedAt + MONITORING_SIGNAL_LOSS_MS,
    'without a resolver the planner is unchanged',
  );
  assert.equal(
    findNextStudentFreshnessBoundary([activeStudent], screenshots, observedAt + 15_000, displays, resolver),
    observedAt + MONITORING_SIGNAL_LOSS_MS,
    'after the 15-second boundary the next transition is the 60-second grace start',
  );
});

test('a stopped WebRTC stream cannot bypass the signal-loss preview', () => {
  const frozenStream = { id: 'frozen-stream' };
  const current = new Map([['student-1', frozenStream]]);
  const cleared = removeStoppedLiveStream(current, 'student-1');
  const display = deriveStudentMonitoringDisplay(
    monitoredStudent({
      monitoringState: 'signal_lost',
      activityFresh: false,
      monitoringLostAt: new Date(observedAt + MONITORING_SIGNAL_LOSS_MS).toISOString(),
    }),
    observedAt + MONITORING_SIGNAL_LOSS_CONFIRMED_MS,
    { lastSuccessfulReconciliationAtMs: observedAt + MONITORING_SIGNAL_LOSS_MS },
  );

  assert.notEqual(cleared, current);
  assert.equal(cleared.has('student-1'), false);
  assert.equal(current.get('student-1'), frozenStream, 'state updates remain immutable');
  assert.equal(display.kind, 'signal_lost');
  assert.equal(deriveUnavailablePreview(display).reason, 'Monitoring signal lost');

  const webRtcSource = readFileSync(
    new URL('../src/hooks/useWebRTC.js', import.meta.url),
    'utf8',
  );
  assert.match(webRtcSource, /export function useWebRTC\(wsSource, onStreamStopped\)/);
  assert.match(webRtcSource, /event\.track\.onended = \(\) => stopLiveView\(studentId\)/);
  assert.match(webRtcSource, /pc\.connectionState === 'failed'[\s\S]*pc\.connectionState === 'disconnected'[\s\S]*pc\.connectionState === 'closed'/);
  assert.match(webRtcSource, /connectionsRef\.current\.delete\(studentId\);[\s\S]*onStreamStopped\?\.\(studentId\);/);
  assert.match(webRtcSource, /const signalingSocket = wsArg \|\| currentSocket\(\);/);
  assert.match(webRtcSource, /Error creating\/sending offer[\s\S]*stopLiveView\(studentId\);[\s\S]*return false;/);
  assert.match(webRtcSource, /handleLiveViewRequested[\s\S]*negotiationId[\s\S]*type: 'offer'/);
  assert.match(webRtcSource, /A server authorization can arrive after[\s\S]*type: 'stop-share'[\s\S]*negotiationId/);
  assert.match(webRtcSource, /if \(!connection\.peerConnection\.remoteDescription\)[\s\S]*connection\.pendingIce\.push\(candidate\)/);

  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  assert.match(dashboardSource, /useWebRTC\(wsRef, handleLiveStreamStopped\)/);
  assert.match(dashboardSource, /message\.type === 'live-view-requested'[\s\S]*message\.negotiationId/);
  assert.match(dashboardSource, /message\.type === 'auth-error'[\s\S]*webrtc\.cleanup\(\)/);
  assert.match(dashboardSource, /socket\.onclose = \(\) => \{[\s\S]*webrtc\.cleanup\(\)/);
  assert.match(dashboardSource, /A peer-to-peer stream can outlive signaling[\s\S]*cleanupLiveViews\(\)/);
  assert.match(dashboardSource, /message\.type === 'student-signed-out'[\s\S]*webrtc\.stopLiveView\(message\.studentId\)/);
  assert.match(
    dashboardSource,
    /message\.type === 'student-signed-out'[\s\S]*pendingRealtimeEventsRef\.current = pendingRealtimeEventsRef\.current\.filter[\s\S]*setQueryData\(coverageQueryKey, nextCoverageSnapshot\)/,
    'signed-out tombstones must evict queued telemetry and update coverage tiles immediately',
  );
  const signedOutStart = dashboardSource.indexOf("if (message.type === 'student-signed-out')");
  const signedOutEnd = dashboardSource.indexOf("if (message.type === 'session-ended')", signedOutStart);
  const signedOutHandler = dashboardSource.slice(signedOutStart, signedOutEnd);
  assert.ok(signedOutStart >= 0 && signedOutEnd > signedOutStart);
  assert.ok(
    signedOutHandler.indexOf('if (!classEligible && !coverageEligible) return;')
      < signedOutHandler.indexOf('webrtc.stopLiveView(message.studentId)'),
    'session/scope eligibility must be checked before a delayed sign-out stops a live view',
  );
  assert.ok(
    signedOutHandler.indexOf('if (!classMutationAccepted && !coverageMutationAccepted) return;')
      < signedOutHandler.indexOf('purgeStudentTileCaches'),
    'binding/revision acceptance must be checked before a delayed sign-out purges pixels',
  );
  const safetyAlertStart = dashboardSource.indexOf("if (message.type === 'safety-alert')");
  const screenshotEventStart = dashboardSource.indexOf("if (message.type === 'screenshot-available')", safetyAlertStart);
  const safetyAlertHandler = dashboardSource.slice(safetyAlertStart, screenshotEventStart);
  assert.ok(safetyAlertStart >= 0 && screenshotEventStart > safetyAlertStart);
  assert.ok(
    safetyAlertHandler.indexOf('if (!classRealtimeMessageEligibility(message)) return;')
      < safetyAlertHandler.indexOf('toast({'),
    'a delayed session-A safety alert must be rejected before it can affect session B',
  );
  assert.match(dashboardSource, /for \(const studentId of signedOutStudentIds\)[\s\S]*webrtc\.stopLiveView\(studentId\)/);
});

test('an 800-student cohort plans one earliest timeout in O(n) semantics', () => {
  const students = Array.from({ length: 800 }, (_, index) => monitoredStudent({
    studentId: `student-${index}`,
    realtimeObservedAt: new Date(observedAt + index).toISOString(),
  }));
  const screenshots = new Map(students.map((student, index) => [
    student.studentId,
    { screenshot: `image-${index}`, timestamp: observedAt + 20_000 + index },
  ]));
  assert.equal(
    findNextStudentFreshnessBoundary(students, screenshots, observedAt),
    observedAt + MONITORING_SIGNAL_LOSS_MS,
  );
});

test('unchanged monitoring projections preserve map and per-student object identity', () => {
  const students = [
    monitoredStudent({ studentId: 'student-1' }),
    monitoredStudent({ studentId: 'student-2' }),
  ];
  const first = projectStudentMonitoringDisplays(students, observedAt + 10_000, {
    lastSuccessfulReconciliationAtMs: observedAt + 5_000,
    realtimeHealthy: true,
  });
  const unchanged = projectStudentMonitoringDisplays(students, observedAt + 20_000, {
    lastSuccessfulReconciliationAtMs: observedAt + 15_000,
    realtimeHealthy: true,
  }, first);
  assert.equal(unchanged, first);
  assert.equal(unchanged.get('student-1'), first.get('student-1'));
  assert.equal(unchanged.get('student-2'), first.get('student-2'));

  const oneStudentChanged = projectStudentMonitoringDisplays([
    { ...students[0], activityState: 'idle' },
    students[1],
  ], observedAt + 20_000, {
    lastSuccessfulReconciliationAtMs: observedAt + 15_000,
    realtimeHealthy: true,
  }, unchanged);
  assert.notEqual(oneStudentChanged, unchanged);
  assert.notEqual(oneStudentChanged.get('student-1'), unchanged.get('student-1'));
  assert.equal(oneStudentChanged.get('student-2'), unchanged.get('student-2'));
});

test('800 staggered grace boundaries trigger one cohort reconciliation rather than per-tile requests', () => {
  let latch = { scopeKey: null, cohortActive: false };
  let refetches = 0;
  for (let index = 0; index < 800; index += 1) {
    const reconnecting = Array.from(
      { length: Math.min(index + 1, 30) },
      (_, offset) => `student-${index - offset}`,
    );
    latch = reconcileGraceCohort({
      current: latch,
      scopeKey: 'school-1:session-1',
      reconnectingStudentIds: reconnecting,
      refetch: () => { refetches += 1; },
    });
  }
  assert.equal(refetches, 1, 'the production callback may run only once for one active grace cohort');

  latch = advanceGraceReconciliationLatch(latch, 'school-1:session-1', []).latch;
  const recoveredThenStaleAgain = advanceGraceReconciliationLatch(
    latch,
    'school-1:session-1',
    ['student-1'],
  );
  assert.equal(recoveredThenStaleAgain.shouldRefetch, true, 'a later distinct grace cohort may reconcile once');
});

function transientResponse(index = 1) {
  return {
    command: {
      id: `command-${index}`,
      commandType: 'open-tab',
      deliveryPolicy: 'transient_action',
      expiresAt: new Date(observedAt + 15_000 + index).toISOString(),
      targets: [{ studentId: `student-${index}`, status: 'sent' }],
    },
    summary: { attempted: 1, pending: 1, acknowledged: 0, completed: 0, expired: 0, failed: 0, unavailable: 0 },
  };
}

test('transient delivery uses one earliest expiry and never claims completion', () => {
  const tracked = trackTransientCommandResponse(new Map(), transientResponse(), 'open-tab');
  assert.equal(findNextTransientExpiry(tracked, observedAt), observedAt + 15_001);
  assert.equal(commandDeliveryFeedback(transientResponse(), 'open-tab').title, 'Delivery attempted');
});

test('an acknowledgement before expiry prevents local expiration', () => {
  const tracked = trackTransientCommandResponse(new Map(), transientResponse(), 'open-tab');
  const updated = applyTransientCommandUpdate(tracked, {
    type: 'classpilot-command-update',
    commandId: 'command-1',
    command: {
      ...transientResponse().command,
      targets: [{ studentId: 'student-1', status: 'received' }],
    },
    summary: { attempted: 1, acknowledged: 1, pending: 1, received: 1, awaitingAck: 0 },
  });
  assert.equal(expireTransientCommands(updated, observedAt + 30_000), updated);
  assert.equal(findNextTransientExpiry(updated, observedAt), null);
  assert.equal(updated.get('command-1').summary.pending, 1, 'received work may finish after expiry');
});

test('an unacknowledged transient becomes not delivered at expiry', () => {
  const tracked = trackTransientCommandResponse(new Map(), transientResponse(), 'open-tab');
  const expired = expireTransientCommands(tracked, observedAt + 15_001);
  const entry = expired.get('command-1');
  assert.equal(entry.summary.pending, 0);
  assert.equal(entry.summary.expired, 1);
  assert.equal(commandDeliveryFeedback({
    command: transientResponse().command,
    summary: entry.summary,
  }, 'open-tab').title, 'Not delivered');
});

function classroomTransientResponse({ commandId, commandType, action, pollId, createdAtOffset = 0 }) {
  const commandPayload = {
    action,
    ...(pollId ? { pollId, question: 'Ready?', options: ['Yes', 'No'] } : {}),
  };
  return {
    command: {
      id: commandId,
      commandType,
      commandPayload,
      createdAt: new Date(observedAt + createdAtOffset).toISOString(),
      deliveryPolicy: 'transient_action',
      expiresAt: new Date(observedAt + 15_000).toISOString(),
      targets: [{ studentId: 'student-1', status: 'sent' }],
    },
    summary: { attempted: 1, pending: 1, awaitingAck: 1 },
  };
}

function acknowledgeClassroomTransient(current, response) {
  return applyTransientCommandUpdate(current, {
    type: 'classpilot-command-update',
    commandId: response.command.id,
    command: {
      ...response.command,
      targets: [{ studentId: 'student-1', status: 'received' }],
    },
    summary: {
      attempted: 1,
      acknowledged: 1,
      received: 1,
      pending: 1,
      awaitingAck: 0,
    },
  });
}

test('timer starts only after an ACK update and an expired start remains inactive', () => {
  const start = classroomTransientResponse({
    commandId: 'timer-start',
    commandType: 'timer',
    action: 'start',
  });
  const pending = trackTransientCommandResponse(new Map(), start, 'timer');
  assert.equal(hasPendingTransientAction(pending, 'timer'), true);
  assert.equal(transientClassroomUiEffect(pending.get('timer-start')), null);

  const expired = expireTransientCommands(pending, observedAt + 15_000);
  assert.equal(hasPendingTransientAction(expired, 'timer'), false);
  assert.equal(latestTransientClassroomUiEffect(expired, 'timer'), null);

  const acknowledged = acknowledgeClassroomTransient(pending, start);
  assert.deepEqual(latestTransientClassroomUiEffect(acknowledged, 'timer'), {
    commandId: 'timer-start',
    control: 'timer',
    active: true,
  });
  const lateHttpResponse = trackTransientCommandResponse(acknowledged, start, 'timer');
  assert.equal(hasPendingTransientAction(lateHttpResponse, 'timer'), false);
  assert.equal(latestTransientClassroomUiEffect(lateHttpResponse, 'timer')?.active, true);

  const failedAfterReceipt = applyTransientCommandUpdate(acknowledged, {
    type: 'classpilot-command-update',
    commandId: start.command.id,
    command: {
      ...start.command,
      targets: [{ studentId: 'student-1', status: 'failed' }],
    },
    summary: { attempted: 1, acknowledged: 1, received: 1, failed: 1, pending: 0, awaitingAck: 0 },
  });
  assert.equal(latestTransientClassroomUiEffect(failedAfterReceipt, 'timer'), null);
});

test('an expired timer stop or poll close preserves the last acknowledged active state', () => {
  const timerStart = classroomTransientResponse({
    commandId: 'timer-start',
    commandType: 'timer',
    action: 'start',
  });
  let timerCommands = trackTransientCommandResponse(new Map(), timerStart, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStart);

  const timerStop = classroomTransientResponse({
    commandId: 'timer-stop',
    commandType: 'timer',
    action: 'stop',
  });
  timerCommands = trackTransientCommandResponse(timerCommands, timerStop, 'timer');
  timerCommands = expireTransientCommands(timerCommands, observedAt + 15_000);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, true);

  timerCommands = trackTransientCommandResponse(timerCommands, timerStop, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStop);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, false);

  const pollStart = classroomTransientResponse({
    commandId: 'poll-start',
    commandType: 'poll',
    action: 'start',
    pollId: 'poll-1',
  });
  let pollCommands = trackTransientCommandResponse(new Map(), pollStart, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollStart);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.poll?.id, 'poll-1');

  const pollClose = classroomTransientResponse({
    commandId: 'poll-close',
    commandType: 'poll',
    action: 'close',
    pollId: 'poll-1',
  });
  pollCommands = trackTransientCommandResponse(pollCommands, pollClose, 'poll');
  pollCommands = expireTransientCommands(pollCommands, observedAt + 15_000);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, true);

  pollCommands = trackTransientCommandResponse(pollCommands, pollClose, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollClose);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, false);
});

test('late updates for an older start cannot resurrect a stopped timer or closed poll', () => {
  const timerStart = classroomTransientResponse({
    commandId: 'ordered-timer-start',
    commandType: 'timer',
    action: 'start',
    createdAtOffset: 1_000,
  });
  const timerStop = classroomTransientResponse({
    commandId: 'ordered-timer-stop',
    commandType: 'timer',
    action: 'stop',
    createdAtOffset: 2_000,
  });
  let timerCommands = trackTransientCommandResponse(new Map(), timerStart, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStart);
  timerCommands = trackTransientCommandResponse(timerCommands, timerStop, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStop);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, false);
  timerCommands = trackTransientCommandResponse(timerCommands, timerStart, 'timer');
  timerCommands = acknowledgeClassroomTransient(timerCommands, timerStart);
  assert.equal(latestTransientClassroomUiEffect(timerCommands, 'timer')?.active, false);

  const pollStart = classroomTransientResponse({
    commandId: 'ordered-poll-start',
    commandType: 'poll',
    action: 'start',
    pollId: 'ordered-poll',
    createdAtOffset: 3_000,
  });
  const pollClose = classroomTransientResponse({
    commandId: 'ordered-poll-close',
    commandType: 'poll',
    action: 'close',
    pollId: 'ordered-poll',
    createdAtOffset: 4_000,
  });
  let pollCommands = trackTransientCommandResponse(new Map(), pollStart, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollStart);
  pollCommands = trackTransientCommandResponse(pollCommands, pollClose, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollClose);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, false);
  pollCommands = trackTransientCommandResponse(pollCommands, pollStart, 'poll');
  pollCommands = acknowledgeClassroomTransient(pollCommands, pollStart);
  assert.equal(latestTransientClassroomUiEffect(pollCommands, 'poll')?.active, false);
});

test('Dashboard does not hydrate timer or poll activity from attempted active-state rows', () => {
  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const activeStateEffect = dashboardSource.slice(
    dashboardSource.indexOf('const hasAttention = activeClassroomStates.some'),
    dashboardSource.indexOf('const performLogout'),
  );
  assert.doesNotMatch(activeStateEffect, /stateType === ['"]timer['"]/);
  assert.doesNotMatch(activeStateEffect, /stateType === ['"]poll['"]/);

  const timerMutation = dashboardSource.slice(
    dashboardSource.indexOf('const timerMutation = useMutation'),
    dashboardSource.indexOf('const handleAttentionMode'),
  );
  assert.doesNotMatch(timerMutation, /setTimerActive/);

  const pollMutation = dashboardSource.slice(
    dashboardSource.indexOf('const pollMutation = useMutation'),
    dashboardSource.indexOf('const dismissHandMutation'),
  );
  assert.doesNotMatch(pollMutation, /setActivePoll/);

  const teacherFabSource = readFileSync(
    new URL('../src/products/classpilot/components/TeacherFab.jsx', import.meta.url),
    'utf8',
  );
  assert.match(teacherFabSource, /pollPending \? "Poll pending"/);
  assert.match(teacherFabSource, /timerPending \? "Timer pending"/);
});

test('persistent-control dispatches do not mutate observed device-control badges', () => {
  const dashboardSource = readFileSync(
    new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url),
    'utf8',
  );
  const dashboardLockMutations = dashboardSource.slice(
    dashboardSource.indexOf('const lockScreenMutation = useMutation'),
    dashboardSource.indexOf('const handleOpenTab'),
  );
  const dashboardFlightPathMutations = dashboardSource.slice(
    dashboardSource.indexOf('const applyFlightPathMutation = useMutation'),
    dashboardSource.indexOf('const handleApplyFlightPath'),
  );
  for (const mutationSource of [dashboardLockMutations, dashboardFlightPathMutations]) {
    assert.doesNotMatch(mutationSource, /\bonMutate\b/);
    assert.doesNotMatch(mutationSource, /setQueryData/);
    assert.doesNotMatch(mutationSource, /screenLocked\s*:/);
    assert.doesNotMatch(mutationSource, /flightPathActive\s*:/);
    assert.doesNotMatch(mutationSource, /summary\??\.sent/);
  }
  assert.doesNotMatch(dashboardSource, /preserveOptimisticControls/);
  assert.doesNotMatch(dashboardSource, /reconcileOptimisticStudentState/);
  assert.doesNotMatch(dashboardSource, /optimisticUpdateUntilRef/);

  const tileSource = readFileSync(
    new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url),
    'utf8',
  );
  const tileControlMutations = tileSource.slice(
    tileSource.indexOf('const unblockForClassMutation = useMutation'),
    tileSource.indexOf('const getStatusLabel'),
  );
  assert.doesNotMatch(tileControlMutations, /\bonMutate\b/);
  assert.doesNotMatch(tileControlMutations, /setQueryData/);
  assert.doesNotMatch(tileControlMutations, /screenLocked\s*:/);
  assert.doesNotMatch(tileControlMutations, /summary\??\.sent/);
});

test('offline persistent controls and durable messages keep their truthful policy result', () => {
  const unavailable = {
    command: { targets: [{ studentId: 'student-1', status: 'unavailable' }] },
    summary: { requested: 1, unavailable: 1, attempted: 0, pending: 0 },
  };
  assert.equal(commandDeliveryFeedback(unavailable, 'lock-screen').title, 'Restriction saved');
  assert.equal(commandDeliveryFeedback(unavailable, 'teacher-message').title, 'Message queued');
});

test('server-authoritative sign-out requires completed targets before claiming completion', () => {
  const attemptedOnly = {
    command: {
      commandType: 'student-sign-out',
      deliveryPolicy: 'server_authoritative',
      targets: [{ studentId: 'student-1', status: 'sent' }],
    },
    summary: { requested: 1, attempted: 1, completed: 0, pending: 1 },
  };
  const attemptedFeedback = commandDeliveryFeedback(attemptedOnly, 'student-sign-out');
  assert.equal(attemptedFeedback.title, 'Failed');
  assert.equal(attemptedFeedback.description.includes('ended on the server'), false);
  assert.deepEqual([...completedStudentIdsFromCommand(attemptedOnly)], []);

  const completed = {
    command: {
      commandType: 'student-sign-out',
      deliveryPolicy: 'server_authoritative',
      targets: [
        { studentId: 'student-1', status: 'completed' },
        { studentId: 'student-2', status: 'unavailable' },
      ],
    },
    summary: { requested: 2, attempted: 1, completed: 1, unavailable: 1 },
  };
  const completedFeedback = commandDeliveryFeedback(completed, 'student-sign-out');
  assert.equal(completedFeedback.title, 'Sign-out completed');
  assert.match(completedFeedback.description, /1 student session ended on the server/);
  assert.deepEqual([...completedStudentIdsFromCommand(completed)], ['student-1']);
});

test('the transient dashboard map remains bounded', () => {
  let tracked = new Map();
  for (let index = 1; index <= MAX_TRACKED_TRANSIENT_COMMANDS + 5; index += 1) {
    tracked = trackTransientCommandResponse(tracked, transientResponse(index), 'open-tab');
  }
  assert.equal(tracked.size, MAX_TRACKED_TRANSIENT_COMMANDS);
  assert.equal(tracked.has('command-1'), false);
  assert.equal(tracked.has(`command-${MAX_TRACKED_TRANSIENT_COMMANDS + 5}`), true);
});
