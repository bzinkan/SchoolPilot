export const MONITORING_SIGNAL_LOSS_MS = 60_000;
export const SCREENSHOT_STALE_MS = 75_000;

const ABSOLUTE_OBSERVED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function observedTime(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function isSignedOut(student) {
  return student?.loginState === 'not_logged_in'
    || student?.isLoggedIn === false
    || student?._realtimeSignedOut === true;
}

function isDelegated(student) {
  return student?.activityState === 'delegated'
    || student?._realtimeSuppressed === true;
}

export function deriveStudentMonitoringDisplay(student, nowMs = Date.now()) {
  if (isSignedOut(student)) {
    return {
      kind: 'signed_out',
      status: 'offline',
      label: 'Not logged in',
      telemetryCurrent: false,
      observedAtMs: observedTime(student?.realtimeObservedAt ?? student?.lastSeenAt),
      nextBoundaryAtMs: null,
    };
  }

  if (isDelegated(student)) {
    return {
      kind: 'delegated',
      status: 'delegated',
      label: 'Monitoring handled by assigned staff',
      telemetryCurrent: false,
      observedAtMs: null,
      nextBoundaryAtMs: null,
    };
  }

  const observedAtMs = observedTime(student?.realtimeObservedAt ?? student?.lastSeenAt);
  const nextBoundaryAtMs = observedAtMs === null
    ? null
    : observedAtMs + MONITORING_SIGNAL_LOSS_MS;
  const locallyStale = nextBoundaryAtMs !== null && nowMs >= nextBoundaryAtMs;
  const serverReportsLoss = student?.monitoringState === 'lost'
    || student?.monitoringState === 'signal_lost'
    || (student?.activityFresh === false && Boolean(student?.monitoringLostAt));
  const telemetryCurrent = observedAtMs !== null && !locallyStale && !serverReportsLoss;

  if (!telemetryCurrent) {
    return {
      kind: 'signal_lost',
      status: 'signal_lost',
      label: 'Monitoring signal lost — cause unknown',
      telemetryCurrent: false,
      observedAtMs,
      nextBoundaryAtMs: null,
    };
  }

  const idle = student?.activityState === 'idle' || student?.status === 'idle';
  return {
    kind: idle ? 'idle' : 'online',
    status: idle ? 'idle' : 'online',
    label: idle ? 'Idle' : 'Online',
    telemetryCurrent: true,
    observedAtMs,
    nextBoundaryAtMs,
  };
}

export function deriveScreenshotDisplay(screenshotData, nowMs = Date.now()) {
  const observedAtMs = observedTime(
    screenshotData?.timestamp ?? screenshotData?.capturedAt ?? screenshotData?.observedAt,
  );
  const available = Boolean(screenshotData?.screenshot);
  const fresh = available
    && observedAtMs !== null
    && nowMs < observedAtMs + SCREENSHOT_STALE_MS;
  return {
    available,
    fresh,
    observedAtMs,
    nextBoundaryAtMs: fresh ? observedAtMs + SCREENSHOT_STALE_MS : null,
  };
}

export function deriveUnavailablePreview(monitoringDisplay) {
  switch (monitoringDisplay?.kind) {
    case 'signed_out':
      return {
        reason: 'Not logged in',
        showLastObservation: true,
        warning: false,
      };
    case 'delegated':
      return {
        reason: 'Monitoring handled by assigned staff',
        showLastObservation: false,
        warning: false,
      };
    case 'signal_lost':
    default:
      return {
        reason: 'Monitoring signal lost — cause unknown',
        showLastObservation: true,
        warning: true,
      };
  }
}

export function findNextStudentFreshnessBoundary(students, screenshotsByStudent, nowMs = Date.now()) {
  let earliest = null;

  for (const student of students || []) {
    const monitoring = deriveStudentMonitoringDisplay(student, nowMs);
    if (
      monitoring.nextBoundaryAtMs !== null
      && monitoring.nextBoundaryAtMs > nowMs
      && (earliest === null || monitoring.nextBoundaryAtMs < earliest)
    ) {
      earliest = monitoring.nextBoundaryAtMs;
    }

    const screenshot = screenshotsByStudent?.get?.(student?.studentId);
    const screenshotDisplay = deriveScreenshotDisplay(screenshot, nowMs);
    if (
      monitoring.telemetryCurrent
      && screenshotDisplay.nextBoundaryAtMs !== null
      && screenshotDisplay.nextBoundaryAtMs > nowMs
      && (earliest === null || screenshotDisplay.nextBoundaryAtMs < earliest)
    ) {
      earliest = screenshotDisplay.nextBoundaryAtMs;
    }
  }

  return earliest;
}

export function lastObservedDomain(student) {
  if (!student?.activeTabUrl) return null;
  try {
    return new URL(student.activeTabUrl).hostname || null;
  } catch {
    return null;
  }
}

export function formatAbsoluteObservedAt(value) {
  const time = observedTime(value);
  return time === null
    ? 'Unavailable'
    : ABSOLUTE_OBSERVED_AT_FORMATTER.format(new Date(time));
}

export function removeStoppedLiveStream(liveStreams, studentId) {
  if (!(liveStreams instanceof Map) || !liveStreams.has(studentId)) return liveStreams;
  const next = new Map(liveStreams);
  next.delete(studentId);
  return next;
}
