import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { Button } from '../src/components/ui/button';
import StudentTile from '../src/products/classpilot/components/StudentTile';

const TWO_HOURS_PLUS_CLOCK_BOUNDARY_MS = 122 * 60 * 1000;

const SIGNED_OUT_STUDENT = Object.freeze({
  studentId: 'signed-out-student',
  studentName: 'Signed Out Student',
  status: 'offline',
  loginState: 'not_logged_in',
  isLoggedIn: false,
  classroomState: { revision: 7 },
  enforcementHealth: 'pending',
});

const ONLINE_STUDENT = Object.freeze({
  studentId: 'online-student',
  studentName: 'Online Student',
  status: 'online',
  loginState: 'logged_in',
  isLoggedIn: true,
  activeTabUrl: 'https://example.test/lesson',
  activeTabTitle: 'Lesson',
});

const INTERACTIVE_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'interactive-student',
  studentName: 'Interactive Student',
});

const MEMO_DETAILS_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'memo-details-student',
  studentName: 'Memo Details Student',
});

const MEMO_DETAILS_DISPLAY = Object.freeze({
  kind: 'online',
  status: 'online',
  label: 'Online',
  telemetryCurrent: true,
  observedAtMs: Date.parse('2026-08-24T12:00:00.000Z'),
  nextBoundaryAtMs: Date.parse('2026-08-24T12:01:00.000Z'),
});

const NEVER_OBSERVED_STUDENT = Object.freeze({
  studentId: 'never-observed-student',
  studentName: 'Never Observed Student',
  status: 'offline',
  loginState: 'not_logged_in',
  isLoggedIn: false,
});

const SIGNAL_LOST_STUDENT = Object.freeze({
  studentId: 'signal-lost-student',
  studentName: 'Signal Lost Student',
  status: 'offline',
  loginState: 'logged_in',
  isLoggedIn: true,
  monitoringState: 'signal_lost',
});

const SIGNAL_LOST_RETAINED_STUDENT = Object.freeze({
  ...SIGNAL_LOST_STUDENT,
  studentId: 'signal-lost-retained-student',
  studentName: 'Signal Lost Retained Student',
});

const SIGNAL_LOST_SIGN_OUT_STUDENT = Object.freeze({
  ...SIGNAL_LOST_STUDENT,
  studentId: 'signal-lost-sign-out-student',
  studentName: 'Signal Lost Sign Out Student',
});

const SIGNAL_LOST_EXPIRED_STUDENT = Object.freeze({
  ...SIGNAL_LOST_STUDENT,
  studentId: 'signal-lost-expired-student',
  studentName: 'Signal Lost Expired Student',
});

const READ_ONLY_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'read-only-student',
  studentName: 'Observed Student',
});

const SUPERVISED_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'supervised-student',
  studentName: 'Supervised Student',
});

const PAUSED_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'paused-student',
  studentName: 'Paused Observation Student',
});

const PAUSED_V2_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'paused-v2-student',
  studentName: 'Paused V2 Observation Student',
});

const PENDING_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'pending-student',
  studentName: 'Pending Observation Student',
});

const DENIED_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'denied-student',
  studentName: 'Denied Observation Student',
});

const SCREENSHOT_DATA_URL = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="320" height="180"%3E%3Crect width="320" height="180" fill="%231d4ed8"/%3E%3C/svg%3E';
// A deliberately non-16:9 replacement frame. The browser runner holds its
// Image.decode() open, so the tile must keep painting the previous frame until
// the decode resolves, then letterbox this one instead of cropping it.
const GATED_SCREENSHOT_DATA_URL = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="200" data-frame="gatedframe"%3E%3Crect width="640" height="200" fill="%23b91c1c"/%3E%3C/svg%3E';
const RECENT_HEARTBEATS = Object.freeze([
  Object.freeze({
    activeTabUrl: 'https://research.example.test/notes',
    activeTabTitle: 'Research notes',
    favicon: '',
  }),
]);

const FAVICON_STRIP_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'favicon-strip-student',
  studentName: 'Favicon Strip Student',
  activeTabUrl: 'https://docs.example.test/assignment',
  activeTabTitle: 'Assignment',
  activeTabRef: 'tab-active',
  openTabCount: 12,
  tabsTruncated: true,
  allOpenTabs: Object.freeze([
    Object.freeze({ tabRef: 'tab-1', url: 'https://reading.example.test/chapter-1', title: 'Chapter 1', favicon: 'https://reading.example.test/favicon.ico' }),
    Object.freeze({ tabRef: 'tab-2', url: 'https://reading.example.test/chapter-2', title: 'Chapter 2', favicon: 'https://reading.example.test/favicon.ico' }),
    Object.freeze({ tabRef: 'tab-active', url: 'https://docs.example.test/assignment', title: 'Assignment', favicon: 'https://docs.example.test/favicon.ico' }),
    Object.freeze({ tabRef: 'tab-3', url: 'chrome://extensions', title: 'Extensions', favicon: 'https://chrome.example.test/favicon.ico' }),
    Object.freeze({ tabRef: 'tab-4', url: 'https://video.example.test/watch', title: 'Video', favicon: 'http://video.example.test/favicon.ico' }),
    Object.freeze({ tabRef: 'tab-5', url: 'https://quiz.example.test/q1', title: 'Quiz', favicon: 'data:image/png;base64,AAAA' }),
    Object.freeze({ tabRef: 'tab-6', url: 'https://notes.example.test/', title: 'Notes', favicon: 'https://notes.example.test/favicon.ico' }),
  ]),
});

const TEMP_ALLOW_BLOCKED_DOMAINS = Object.freeze(['blocked.example.test']);
const TEMP_ALLOW_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'temp-allow-student',
  studentName: 'Temp Allow Student',
  activeTabUrl: 'https://www.blocked.example.test/game',
  activeTabTitle: 'Blocked game',
  classroomState: Object.freeze({
    revision: 4,
    restrictions: Object.freeze({
      temporaryAllows: Object.freeze([
        Object.freeze({ domain: 'reading.example.test', expiresAt: '2026-08-24T12:10:30.000Z' }),
      ]),
    }),
  }),
});

const TAB_LIMIT_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'tab-limit-student',
  studentName: 'Tab Limit Student',
  openTabCount: 7,
  classroomState: Object.freeze({ revision: 3, restrictions: Object.freeze({ tabLimit: 5 }) }),
});

const FRAME_SWAP_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'frame-swap-student',
  studentName: 'Frame Swap Student',
});

// Three tiles that differ only in preview state and badges. Their rendered
// heights must stay identical so a wall never reflows as students move between
// live, badged and stale states.
const HEIGHT_CURRENT_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'height-current-student',
  studentName: 'Height A',
});

const HEIGHT_BADGED_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'height-badged-student',
  studentName: 'Height B',
});

const HEIGHT_STALE_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'height-stale-student',
  studentName: 'Height C',
});

const ACTIVE_STALE_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'active-stale-student',
  studentName: 'Active Stale Student',
});

const ACTIVE_FRESH_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'active-fresh-student',
  studentName: 'Active Fresh Student',
});

const BACKGROUND_STALE_STUDENT = Object.freeze({
  ...ONLINE_STUDENT,
  studentId: 'background-stale-student',
  studentName: 'Background Stale Student',
});

function onlineDisplay(observedAtMs) {
  return {
    kind: 'online',
    status: 'online',
    label: 'Online',
    telemetryCurrent: true,
    observedAtMs,
    nextBoundaryAtMs: observedAtMs + 60_000,
  };
}

function TileRegressionHarness() {
  const [observedAtMs, setObservedAtMs] = useState(() => Date.now());
  const [tabClicks, setTabClicks] = useState(0);
  const [detailsClicks, setDetailsClicks] = useState(0);
  const [screenshotClicks, setScreenshotClicks] = useState(0);
  const [selectionClicks, setSelectionClicks] = useState(0);
  const [commandClicks, setCommandClicks] = useState(0);
  const [lastCommand, setLastCommand] = useState('');
  const [allowClicks, setAllowClicks] = useState(0);
  const [returnClicks, setReturnClicks] = useState(0);
  const [tilesVisible, setTilesVisible] = useState(false);
  const [frameSwapped, setFrameSwapped] = useState(false);
  const [memoDetailsEnabled, setMemoDetailsEnabled] = useState(true);
  const memoDetailsHandler = useCallback(
    () => setDetailsClicks((count) => count + 1),
    [],
  );
  const staleLiveStreamRef = useRef(null);
  if (staleLiveStreamRef.current === null && typeof MediaStream !== 'undefined') {
    staleLiveStreamRef.current = new MediaStream();
  }
  const renderCount = useRef(0);
  renderCount.current += 1;
  const freshnessNowMs = Date.now();

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <Button
        type="button"
        data-testid="age-last-seen"
        onClick={() => setObservedAtMs(Date.now() - TWO_HOURS_PLUS_CLOCK_BOUNDARY_MS)}
      >
        Age last seen
      </Button>
      <Button
        type="button"
        data-testid="toggle-tiles"
        onClick={() => setTilesVisible((visible) => !visible)}
      >
        {tilesVisible ? 'Hide tiles' : 'Show tiles'}
      </Button>
      <Button
        type="button"
        data-testid="revoke-memo-details"
        onClick={() => setMemoDetailsEnabled(false)}
      >
        Revoke memoized details
      </Button>
      <Button
        type="button"
        data-testid="swap-frame"
        onClick={() => setFrameSwapped(true)}
      >
        Swap frame
      </Button>
      <p data-testid="tab-clicks">Tab clicks: {tabClicks}</p>
      <p data-testid="details-clicks">Details clicks: {detailsClicks}</p>
      <p data-testid="screenshot-clicks">Screenshot clicks: {screenshotClicks}</p>
      <p data-testid="selection-clicks">Selection clicks: {selectionClicks}</p>
      <p data-testid="command-clicks">Command clicks: {commandClicks}</p>
      <p data-testid="last-command">{lastCommand}</p>
      <p data-testid="allow-clicks">Allow clicks: {allowClicks}</p>
      <p data-testid="return-clicks">Return clicks: {returnClicks}</p>
      <p data-testid="parent-renders">Parent renders: {renderCount.current}</p>

      {tilesVisible && <div className="mt-6 grid max-w-7xl grid-cols-3 gap-4">
        <div data-testid="signed-out-tile-host">
          <StudentTile
            student={{ ...SIGNED_OUT_STUDENT, lastSeenAt: observedAtMs }}
            monitoringDisplay={{
              kind: 'signed_out',
              status: 'offline',
              label: 'Not logged in',
              telemetryCurrent: false,
              observedAtMs,
              nextBoundaryAtMs: null,
            }}
            freshnessNowMs={freshnessNowMs}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 1,
              bindingVersion: 'v2:signed-out-binding',
              tabTitle: 'Signed-out private screen',
            }}
            onOpenDetails={() => setDetailsClicks((count) => count + 1)}
            onManageTabs={() => setTabClicks((count) => count + 1)}
            onToggleSelect={() => {}}
            persistentRestrictionSelectionAvailable
          />
        </div>

        <div data-testid="online-tile-host">
          <StudentTile
            student={ONLINE_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: Date.now(),
              nextBoundaryAtMs: Date.now() + 60_000,
            }}
            onManageTabs={() => setTabClicks((count) => count + 1)}
            onToggleSelect={() => {}}
            restrictionSelectionActive
          />
        </div>

        <div data-testid="interactive-tile-host">
          <StudentTile
            student={INTERACTIVE_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: freshnessNowMs,
              nextBoundaryAtMs: freshnessNowMs + 60_000,
            }}
            freshnessNowMs={freshnessNowMs}
            isOffTask
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs,
              bindingVersion: 'v2:interactive-binding',
              tabTitle: 'Interactive lesson',
            }}
            onOpenDetails={() => setDetailsClicks((count) => count + 1)}
            onOpenScreenshot={() => setScreenshotClicks((count) => count + 1)}
            onToggleSelect={() => setSelectionClicks((count) => count + 1)}
            onManageTabs={() => setTabClicks((count) => count + 1)}
            onCommand={() => setCommandClicks((count) => count + 1)}
            onAllowDomain={() => setAllowClicks((count) => count + 1)}
            recentHeartbeats={RECENT_HEARTBEATS}
          />
        </div>

        <div data-testid="memo-details-tile-host">
          <StudentTile
            student={MEMO_DETAILS_STUDENT}
            monitoringDisplay={MEMO_DETAILS_DISPLAY}
            onOpenDetails={memoDetailsEnabled ? memoDetailsHandler : undefined}
          />
        </div>

        <div data-testid="never-observed-tile-host">
          <StudentTile
            student={NEVER_OBSERVED_STUDENT}
            monitoringDisplay={{
              kind: 'signed_out',
              status: 'offline',
              label: 'Not logged in',
              telemetryCurrent: false,
              observedAtMs: null,
              nextBoundaryAtMs: null,
            }}
          />
        </div>

        <div data-testid="signal-lost-tile-host">
          <StudentTile
            student={{ ...SIGNAL_LOST_STUDENT, lastSeenAt: observedAtMs }}
            monitoringDisplay={{
              kind: 'signal_lost',
              status: 'signal_lost',
              label: 'Monitoring signal lost',
              telemetryCurrent: false,
              observedAtMs,
              nextBoundaryAtMs: null,
            }}
            freshnessNowMs={freshnessNowMs}
            screenshotObservationStatus="observed"
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 74_999,
              bindingVersion: 'v2:signal-lost-fresh-binding',
              tabTitle: 'Fresh capture while heartbeat is stale',
            }}
            onToggleSelect={() => {}}
            onCommand={() => {}}
          />
        </div>

        <div data-testid="signal-lost-retained-tile-host">
          <StudentTile
            student={{ ...SIGNAL_LOST_RETAINED_STUDENT, lastSeenAt: observedAtMs }}
            monitoringDisplay={{
              kind: 'signal_lost',
              status: 'signal_lost',
              label: 'Monitoring signal lost',
              telemetryCurrent: false,
              observedAtMs,
              nextBoundaryAtMs: null,
            }}
            freshnessNowMs={freshnessNowMs}
            screenshotObservationStatus="observed"
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 75_000,
              bindingVersion: 'v2:signal-lost-retained-binding',
              tabTitle: 'Aged capture while heartbeat is stale',
            }}
          />
        </div>

        <div data-testid="signal-lost-sign-out-tile-host">
          <StudentTile
            student={{ ...SIGNAL_LOST_SIGN_OUT_STUDENT, lastSeenAt: observedAtMs }}
            monitoringDisplay={{
              kind: 'signal_lost',
              status: 'signal_lost',
              label: 'Monitoring signal lost',
              telemetryCurrent: false,
              observedAtMs,
              nextBoundaryAtMs: null,
            }}
            signOutOnlySelectionAvailable
            nonSignOutCommandsBlocked
            actionsDisabledReason="Clear the sign-out-only selection before using other ClassPilot controls."
            onToggleSelect={() => {}}
            onCommand={() => {}}
          />
        </div>

        <div data-testid="signal-lost-expired-tile-host">
          <StudentTile
            student={{ ...SIGNAL_LOST_EXPIRED_STUDENT, lastSeenAt: observedAtMs }}
            monitoringDisplay={{
              kind: 'signal_lost',
              status: 'signal_lost',
              label: 'Monitoring signal lost',
              telemetryCurrent: false,
              observedAtMs,
              nextBoundaryAtMs: null,
            }}
            freshnessNowMs={freshnessNowMs}
            screenshotObservationStatus="observed"
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 120_000,
              bindingVersion: 'v2:signal-lost-expired-binding',
              tabTitle: 'Expired capture',
            }}
          />
        </div>

        <div data-testid="read-only-tile-host">
          <StudentTile
            student={READ_ONLY_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: Date.now(),
              nextBoundaryAtMs: Date.now() + 60_000,
            }}
            actionsDisabled
            actionsDisabledReason="Observe mode is read-only."
            signOutOnlySelectionAvailable
            onOpenDetails={() => setDetailsClicks((count) => count + 1)}
            onOpenScreenshot={() => setScreenshotClicks((count) => count + 1)}
            onToggleSelect={() => {}}
            onManageTabs={() => {}}
            onStartLiveView={() => {}}
            onStopLiveView={() => {}}
            onExpandLiveView={() => {}}
            onCommand={() => {}}
            onAllowDomain={() => {}}
            isOffTask
            liveStream={staleLiveStreamRef.current}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: Date.now(),
              tabTitle: 'Observed lesson',
            }}
            recentHeartbeats={RECENT_HEARTBEATS}
          />
        </div>

        <div data-testid="supervised-tile-host">
          <StudentTile
            student={SUPERVISED_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: Date.now(),
              nextBoundaryAtMs: Date.now() + 60_000,
            }}
            actionsDisabled
            actionsDisabledReason="Student controls belong to the supervising teacher."
            monitoringSuppressed
            monitoringSuppressedReason="Ms. Rivera is temporarily supervising this student."
            supervisionLabel="In supervision: Ms. Rivera"
            liveStream={staleLiveStreamRef.current}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: Date.now(),
              bindingVersion: 'v2:supervised-binding',
              tabTitle: 'Suppressed lesson',
            }}
            onOpenDetails={() => setDetailsClicks((count) => count + 1)}
            onOpenScreenshot={() => setScreenshotClicks((count) => count + 1)}
            onReturnToClass={() => setReturnClicks((count) => count + 1)}
          />
        </div>

        <div data-testid="favicon-strip-tile-host">
          <StudentTile
            student={FAVICON_STRIP_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: freshnessNowMs,
              nextBoundaryAtMs: freshnessNowMs + 60_000,
            }}
            freshnessNowMs={freshnessNowMs}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs,
              bindingVersion: 'v2:favicon-strip-binding',
              tabTitle: 'Assignment',
            }}
            onOpenScreenshot={() => setScreenshotClicks((count) => count + 1)}
            onManageTabs={() => setTabClicks((count) => count + 1)}
            onCommand={() => setCommandClicks((count) => count + 1)}
          />
        </div>

        <div data-testid="temp-allow-tile-host">
          <StudentTile
            student={TEMP_ALLOW_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: freshnessNowMs,
              nextBoundaryAtMs: freshnessNowMs + 60_000,
            }}
            freshnessNowMs={freshnessNowMs}
            blockedDomains={TEMP_ALLOW_BLOCKED_DOMAINS}
            canTempUnblock
            onCommand={(command) => {
              setCommandClicks((count) => count + 1);
              setLastCommand(JSON.stringify(command));
            }}
            onAllowDomain={() => setAllowClicks((count) => count + 1)}
          />
        </div>

        <div data-testid="tab-limit-tile-host">
          <StudentTile
            student={TAB_LIMIT_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: freshnessNowMs,
              nextBoundaryAtMs: freshnessNowMs + 60_000,
            }}
            freshnessNowMs={freshnessNowMs}
            onManageTabs={() => setTabClicks((count) => count + 1)}
          />
        </div>

        <div data-testid="paused-tile-host">
          <StudentTile
            student={PAUSED_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: Date.now(),
              nextBoundaryAtMs: Date.now() + 60_000,
            }}
            screenshotObservationStatus="paused_unobserved"
            liveStream={staleLiveStreamRef.current}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: Date.now(),
              tabTitle: 'Must not remain visible',
            }}
          />
        </div>

        <div data-testid="pending-tile-host">
          <StudentTile
            student={PENDING_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: Date.now(),
              nextBoundaryAtMs: Date.now() + 60_000,
            }}
            screenshotObservationStatus="pending"
            liveStream={staleLiveStreamRef.current}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: Date.now(),
              tabTitle: 'Cached prior context',
            }}
          />
        </div>

        <div data-testid="paused-v2-tile-host">
          <StudentTile
            student={PAUSED_V2_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: freshnessNowMs,
              nextBoundaryAtMs: freshnessNowMs + 60_000,
            }}
            freshnessNowMs={freshnessNowMs}
            screenshotObservationStatus="paused_unobserved"
            liveStream={staleLiveStreamRef.current}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 1,
              bindingVersion: 'v2:paused-class-bound-binding',
              tabTitle: 'Class-bound capture survives focus churn',
            }}
          />
        </div>

        <div data-testid="denied-tile-host">
          <StudentTile
            student={DENIED_STUDENT}
            monitoringDisplay={{
              kind: 'online',
              status: 'online',
              label: 'Online',
              telemetryCurrent: true,
              observedAtMs: freshnessNowMs,
              nextBoundaryAtMs: freshnessNowMs + 60_000,
            }}
            freshnessNowMs={freshnessNowMs}
            screenshotObservationStatus="denied"
            screenshotAuthorizationDenied
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 1,
              bindingVersion: 'v2:claimed-prior-binding',
              tabTitle: 'Claimed or denied prior context',
            }}
          />
        </div>

        <div data-testid="frame-swap-tile-host">
          <StudentTile
            student={FRAME_SWAP_STUDENT}
            monitoringDisplay={onlineDisplay(freshnessNowMs)}
            freshnessNowMs={freshnessNowMs}
            screenshotData={{
              screenshot: frameSwapped ? GATED_SCREENSHOT_DATA_URL : SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs,
              bindingVersion: 'v2:frame-swap-binding',
              tabTitle: frameSwapped ? 'Replacement frame' : 'Initial frame',
            }}
            onOpenScreenshot={() => setScreenshotClicks((count) => count + 1)}
          />
        </div>

        <div data-testid="height-current-tile-host">
          <StudentTile
            student={HEIGHT_CURRENT_STUDENT}
            monitoringDisplay={onlineDisplay(freshnessNowMs)}
            freshnessNowMs={freshnessNowMs}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs,
              bindingVersion: 'v2:height-current-binding',
              tabTitle: 'Lesson',
            }}
          />
        </div>

        <div data-testid="height-badged-tile-host">
          <StudentTile
            student={HEIGHT_BADGED_STUDENT}
            monitoringDisplay={onlineDisplay(freshnessNowMs)}
            freshnessNowMs={freshnessNowMs}
            isOffTask
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs,
              bindingVersion: 'v2:height-badged-binding',
              tabTitle: 'Lesson',
            }}
          />
        </div>

        <div data-testid="height-stale-tile-host">
          <StudentTile
            student={HEIGHT_STALE_STUDENT}
            monitoringDisplay={onlineDisplay(freshnessNowMs)}
            freshnessNowMs={freshnessNowMs}
          />
        </div>

        <div data-testid="active-stale-tile-host">
          <StudentTile
            student={ACTIVE_STALE_STUDENT}
            monitoringDisplay={onlineDisplay(freshnessNowMs)}
            freshnessNowMs={freshnessNowMs}
            observationActive
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 16_000,
              bindingVersion: 'v2:active-stale-binding',
              tabTitle: 'Capture the observing wall has outrun',
            }}
          />
        </div>

        <div data-testid="active-fresh-tile-host">
          <StudentTile
            student={ACTIVE_FRESH_STUDENT}
            monitoringDisplay={onlineDisplay(freshnessNowMs)}
            freshnessNowMs={freshnessNowMs}
            observationActive
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 14_000,
              bindingVersion: 'v2:active-fresh-binding',
              tabTitle: 'Capture inside the active window',
            }}
          />
        </div>

        <div data-testid="background-stale-tile-host">
          <StudentTile
            student={BACKGROUND_STALE_STUDENT}
            monitoringDisplay={onlineDisplay(freshnessNowMs)}
            freshnessNowMs={freshnessNowMs}
            screenshotData={{
              screenshot: SCREENSHOT_DATA_URL,
              timestamp: freshnessNowMs - 16_000,
              bindingVersion: 'v2:background-stale-binding',
              tabTitle: 'Capture inside the background window',
            }}
          />
        </div>
      </div>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<TileRegressionHarness />);
