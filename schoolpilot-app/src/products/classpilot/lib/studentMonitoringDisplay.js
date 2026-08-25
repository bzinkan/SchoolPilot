export const MONITORING_SIGNAL_LOSS_MS = 60_000;
export const SCREENSHOT_STALE_MS = 75_000;
export const OBSERVED_AT_DISPLAY_FUTURE_SKEW_MS = 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ABSOLUTE_OBSERVED_AT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function parsedObservedTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '') return null;
  const parsed = typeof trimmed === 'number'
    ? trimmed
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)
      ? Number(trimmed)
      : Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeObservedAtForOrdering(value, nowMs = Date.now()) {
  const parsed = parsedObservedTime(value);
  const now = Number(nowMs);
  if (
    parsed === null
    || !Number.isFinite(now)
    || now <= 0
    || parsed > now + OBSERVED_AT_DISPLAY_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return Math.min(parsed, now);
}

export function normalizeObservedAtForDisplay(value, nowMs = Date.now()) {
  return normalizeObservedAtForOrdering(value, nowMs);
}

function normalizedStudentObservedAt(student, nowMs) {
  return normalizeObservedAtForDisplay(student?.realtimeObservedAt, nowMs)
    ?? normalizeObservedAtForDisplay(student?.lastSeenAt, nowMs);
}

export function formatRelativeLastSeen(value, nowMs = Date.now()) {
  const observedAtMs = normalizeObservedAtForDisplay(value, nowMs);
  if (observedAtMs === null) return 'Never observed';

  const elapsedMs = Math.max(0, Number(nowMs) - observedAtMs);
  if (elapsedMs < MINUTE_MS) return 'Last seen just now';
  if (elapsedMs < HOUR_MS) {
    const minutes = Math.floor(elapsedMs / MINUTE_MS);
    return `Last seen ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    return `Last seen ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(elapsedMs / DAY_MS);
  return `Last seen ${days} day${days === 1 ? '' : 's'} ago`;
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
      observedAtMs: normalizedStudentObservedAt(student, nowMs),
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

  const observedAtMs = normalizedStudentObservedAt(student, nowMs);
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
  const observedAtMs = normalizeObservedAtForDisplay(
    screenshotData?.timestamp ?? screenshotData?.capturedAt ?? screenshotData?.observedAt,
    nowMs,
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

export function formatAbsoluteObservedAt(value, nowMs = Date.now()) {
  const time = normalizeObservedAtForDisplay(value, nowMs);
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
