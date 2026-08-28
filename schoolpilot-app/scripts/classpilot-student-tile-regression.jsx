import { useRef, useState } from 'react';
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
const RECENT_HEARTBEATS = Object.freeze([
  Object.freeze({
    activeTabUrl: 'https://research.example.test/notes',
    activeTabTitle: 'Research notes',
    favicon: '',
  }),
]);

function TileRegressionHarness() {
  const [observedAtMs, setObservedAtMs] = useState(() => Date.now());
  const [tabClicks, setTabClicks] = useState(0);
  const [cardClicks, setCardClicks] = useState(0);
  const [returnClicks, setReturnClicks] = useState(0);
  const [tilesVisible, setTilesVisible] = useState(false);
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
      <p data-testid="tab-clicks">Tab clicks: {tabClicks}</p>
      <p data-testid="card-clicks">Card clicks: {cardClicks}</p>
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
            onClick={() => setCardClicks((count) => count + 1)}
            onManageTabs={() => setTabClicks((count) => count + 1)}
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
            onClick={() => setCardClicks((count) => count + 1)}
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
            onReturnToClass={() => setReturnClicks((count) => count + 1)}
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
      </div>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<TileRegressionHarness />);
