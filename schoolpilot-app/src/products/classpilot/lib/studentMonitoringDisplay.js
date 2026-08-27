export const MONITORING_SIGNAL_LOSS_MS = 60_000;
export const MONITORING_SIGNAL_LOSS_CONFIRMATION_MS = 30_000;
export const MONITORING_SIGNAL_LOSS_CONFIRMED_MS =
  MONITORING_SIGNAL_LOSS_MS + MONITORING_SIGNAL_LOSS_CONFIRMATION_MS;
// One maximum 35-second reconciliation interval plus bounded delivery/render
// allowance. An old success cannot permanently certify a signal-loss state.
export const MONITORING_CONFIRMATION_FRESH_MS = 45_000;
export const SCREENSHOT_STALE_MS = 75_000;
export const SCREENSHOT_RECONNECT_RETAIN_MS = 120_000;
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

function serverReportsMonitoringLoss(student) {
  return student?.monitoringState === 'lost'
    || student?.monitoringState === 'signal_lost'
    || (student?.activityFresh === false && Boolean(student?.monitoringLostAt));
}

function hasSuccessfulReconciliationAfter(value, boundaryAtMs) {
  const reconciledAtMs = Number(value);
  return Number.isFinite(reconciledAtMs)
    && reconciledAtMs > 0
    && reconciledAtMs >= boundaryAtMs;
}

function monitoringConfirmation(options, graceStartedAtMs, nowMs) {
  const hasExplicitReconciliation = Object.prototype.hasOwnProperty.call(
    options,
    'lastSuccessfulReconciliationAtMs',
  );
  if (!hasExplicitReconciliation) {
    return { confirmed: true, nextBoundaryAtMs: null };
  }

  const reconciledAtMs = Number(options.lastSuccessfulReconciliationAtMs);
  const postGraceSuccess = hasSuccessfulReconciliationAfter(
    reconciledAtMs,
    graceStartedAtMs ?? Number.POSITIVE_INFINITY,
  );
  if (!postGraceSuccess) return { confirmed: false, nextBoundaryAtMs: null };

  const realtimeHealthy = options.realtimeHealthy === true;
  const reconciliationExpiresAtMs = reconciledAtMs + MONITORING_CONFIRMATION_FRESH_MS;
  const reconciliationFresh = nowMs < reconciliationExpiresAtMs;
  return {
    confirmed: realtimeHealthy || reconciliationFresh,
    nextBoundaryAtMs: !realtimeHealthy && reconciliationFresh
      ? reconciliationExpiresAtMs
      : null,
  };
}

export function deriveStudentMonitoringDisplay(student, nowMs = Date.now(), options = {}) {
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
  const graceStartedAtMs = observedAtMs === null
    ? null
    : observedAtMs + MONITORING_SIGNAL_LOSS_MS;
  const confirmedBoundaryAtMs = observedAtMs === null
    ? null
    : observedAtMs + MONITORING_SIGNAL_LOSS_CONFIRMED_MS;
  const serverReportsLoss = serverReportsMonitoringLoss(student);
  const confirmation = monitoringConfirmation(options, graceStartedAtMs, nowMs);
  const authoritativeLossConfirmed = serverReportsLoss && confirmation.confirmed;

  if (observedAtMs === null) {
    const signalLost = authoritativeLossConfirmed;
    return {
      kind: signalLost ? 'signal_lost' : 'updates_unavailable',
      status: signalLost ? 'signal_lost' : 'updates_unavailable',
      label: signalLost ? 'Monitoring signal lost' : 'Monitoring updates unavailable',
      telemetryCurrent: false,
      observedAtMs,
      nextBoundaryAtMs: signalLost ? confirmation.nextBoundaryAtMs : null,
    };
  }

  if (nowMs >= graceStartedAtMs && nowMs < confirmedBoundaryAtMs) {
    return {
      kind: 'reconnecting',
      status: 'reconnecting',
      label: 'Updating monitoring…',
      telemetryCurrent: false,
      observedAtMs,
      nextBoundaryAtMs: confirmedBoundaryAtMs,
    };
  }

  if (nowMs >= confirmedBoundaryAtMs) {
    const signalLost = authoritativeLossConfirmed;
    return {
      kind: signalLost ? 'signal_lost' : 'updates_unavailable',
      status: signalLost ? 'signal_lost' : 'updates_unavailable',
      label: signalLost ? 'Monitoring signal lost' : 'Monitoring updates unavailable',
      telemetryCurrent: false,
      observedAtMs,
      nextBoundaryAtMs: signalLost ? confirmation.nextBoundaryAtMs : null,
    };
  }

  const idle = student?.activityState === 'idle' || student?.status === 'idle';
  return {
    kind: idle ? 'idle' : 'online',
    status: idle ? 'idle' : 'online',
    label: idle ? 'Idle' : 'Online',
    telemetryCurrent: true,
    observedAtMs,
    nextBoundaryAtMs: graceStartedAtMs,
  };
}

function sameMonitoringDisplay(left, right) {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.is(left[key], right[key]));
}

export function projectStudentMonitoringDisplays(
  students,
  nowMs = Date.now(),
  options = {},
  previousDisplays = null,
) {
  const previous = previousDisplays instanceof Map ? previousDisplays : null;
  const next = new Map();
  let projectionUnchanged = Boolean(previous && previous.size === (students || []).length);

  for (const student of students || []) {
    if (!student?.studentId) continue;
    const derived = deriveStudentMonitoringDisplay(student, nowMs, options);
    const prior = previous?.get(student.studentId);
    const display = sameMonitoringDisplay(prior, derived) ? prior : derived;
    next.set(student.studentId, display);
    if (display !== prior) projectionUnchanged = false;
  }

  return projectionUnchanged ? previous : next;
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
  const retained = available
    && observedAtMs !== null
    && nowMs < observedAtMs + SCREENSHOT_RECONNECT_RETAIN_MS;
  return {
    available,
    fresh,
    retained,
    observedAtMs,
    nextBoundaryAtMs: fresh
      ? observedAtMs + SCREENSHOT_STALE_MS
      : retained
        ? observedAtMs + SCREENSHOT_RECONNECT_RETAIN_MS
        : null,
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
      return {
        reason: 'Monitoring signal lost',
        showLastObservation: true,
        warning: true,
      };
    case 'reconnecting':
      return {
        reason: 'Updating monitoring…',
        showLastObservation: true,
        warning: true,
      };
    case 'updates_unavailable':
    default:
      return {
        reason: 'Monitoring updates unavailable',
        showLastObservation: true,
        warning: true,
      };
  }
}

export function findNextStudentFreshnessBoundary(
  students,
  screenshotsByStudent,
  nowMs = Date.now(),
  monitoringDisplaysByStudent = null,
) {
  let earliest = null;

  for (const student of students || []) {
    const monitoring = monitoringDisplaysByStudent?.get?.(student?.studentId)
      || deriveStudentMonitoringDisplay(student, nowMs);
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
      (monitoring.telemetryCurrent || monitoring.kind === 'reconnecting' || monitoring.kind === 'updates_unavailable')
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
