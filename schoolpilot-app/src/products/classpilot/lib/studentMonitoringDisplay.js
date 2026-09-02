export const MONITORING_SIGNAL_LOSS_MS = 60_000;
export const MONITORING_SIGNAL_LOSS_CONFIRMATION_MS = 30_000;
export const MONITORING_SIGNAL_LOSS_CONFIRMED_MS =
  MONITORING_SIGNAL_LOSS_MS + MONITORING_SIGNAL_LOSS_CONFIRMATION_MS;
// One maximum 35-second reconciliation interval plus bounded delivery/render
// allowance. An old success cannot permanently certify a signal-loss state.
export const MONITORING_CONFIRMATION_FRESH_MS = 45_000;
export const SCREENSHOT_STALE_MS = 75_000;
// Active-view (observed, capability-negotiated) captures arrive about every
// 5 seconds; three missed captures make a preview visibly stale.
export const SCREENSHOT_ACTIVE_VIEW_CAPTURE_MS = 5_000;
export const SCREENSHOT_ACTIVE_VIEW_STALE_MS = 15_000;
export const SCREENSHOT_RECONNECT_RETAIN_MS = 120_000;
export const SCREENSHOT_SUCCESSFUL_NULL_RETAIN_UNTIL_FIELD = '__classpilotSuccessfulNullRetainUntilMs';
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

// Whole-minute countdown for self-expiring allows; null once expired.
export function formatRemainingMinutes(expiresAtMs, nowMs = Date.now()) {
  const expiresAt = Number(expiresAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) return null;
  const remainingMs = expiresAt - now;
  if (remainingMs < MINUTE_MS) return '<1 min left';
  return `${Math.floor(remainingMs / MINUTE_MS)} min left`;
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

  const restrictionAuthState = student?.restrictionAuthState;
  if (restrictionAuthState === 'in_progress' || restrictionAuthState === 'returning') {
    return {
      kind: 'signing_in',
      status: 'online',
      label: 'Signing in',
      telemetryCurrent: true,
      observedAtMs,
      nextBoundaryAtMs: graceStartedAtMs,
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

// `observationActive` is the caller's hint that the wall itself is observing
// (a held {kind:'class'} observation lease), where frames land about every 5
// seconds. It may only tighten the window: an unknown observation state keeps
// the 75-second default, and no hint can loosen an already-active cadence.
export function screenshotStaleThresholdMs(cadence, { observationActive = false } = {}) {
  return cadence === 'active_view' || observationActive === true
    ? SCREENSHOT_ACTIVE_VIEW_STALE_MS
    : SCREENSHOT_STALE_MS;
}

// A cadence-aware threshold may only tighten the fresh window; the 75-second
// default and the 120-second retention boundary are never extended.
function boundedStaleThresholdMs(staleThresholdMs) {
  const threshold = Number(staleThresholdMs);
  return Number.isFinite(threshold) && threshold > 0
    ? Math.min(threshold, SCREENSHOT_STALE_MS)
    : SCREENSHOT_STALE_MS;
}

export function deriveScreenshotCaptureCadence({ student, observationLeaseStatus } = {}) {
  return observationLeaseStatus === 'observed'
    && student?.acceptedCapabilities?.screenshotActiveObservationCadenceV1 === true
    ? 'active_view'
    : 'background';
}

export function deriveScreenshotDisplay(
  screenshotData,
  nowMs = Date.now(),
  { staleThresholdMs = SCREENSHOT_STALE_MS } = {},
) {
  const observedAtMs = normalizeObservedAtForDisplay(
    screenshotData?.timestamp ?? screenshotData?.capturedAt ?? screenshotData?.observedAt,
    nowMs,
  );
  const available = Boolean(screenshotData?.screenshot);
  const normalFreshUntilMs = observedAtMs === null
    ? null
    : observedAtMs + boundedStaleThresholdMs(staleThresholdMs);
  const successfulNullRetainUntilValue = Number(
    screenshotData?.[SCREENSHOT_SUCCESSFUL_NULL_RETAIN_UNTIL_FIELD],
  );
  const successfulNullRetainUntilMs = Number.isFinite(successfulNullRetainUntilValue)
    && successfulNullRetainUntilValue > 0
    && normalFreshUntilMs !== null
    ? Math.min(successfulNullRetainUntilValue, normalFreshUntilMs)
    : null;
  const retainedUntilMs = successfulNullRetainUntilMs
    ?? (observedAtMs === null ? null : observedAtMs + SCREENSHOT_RECONNECT_RETAIN_MS);
  const fresh = available
    && normalFreshUntilMs !== null
    && nowMs < normalFreshUntilMs;
  const retained = available
    && retainedUntilMs !== null
    && nowMs < retainedUntilMs;
  return {
    available,
    fresh,
    retained,
    observedAtMs,
    // The two absolute bounds behind `fresh`/`retained`. A caller that has to
    // re-evaluate this same frame at another instant (a memo comparator holding
    // one already-painted frame across two clock readings) projects them
    // forward instead of re-deriving from data it can no longer see.
    freshUntilMs: normalFreshUntilMs,
    retainedUntilMs,
    nextBoundaryAtMs: fresh
      ? normalFreshUntilMs
      : retained
        ? retainedUntilMs
        : null,
  };
}

export function deriveScreenshotPreviewMode({
  screenshotData,
  nowMs = Date.now(),
  authorizationRevoked = false,
  staleThresholdMs,
} = {}) {
  if (authorizationRevoked) return null;
  const screenshot = deriveScreenshotDisplay(screenshotData, nowMs, { staleThresholdMs });
  if (screenshot.fresh) return 'current';
  if (screenshot.retained) return 'retained';
  return null;
}

// Teacher-facing capture health. Never surfaces the raw extension error text.
export function deriveScreenshotHealthDisplay(student, {
  nowMs = Date.now(),
  cadence = 'background',
  screenshotDisplay = null,
  monitoringDisplay = null,
} = {}) {
  const health = student?.screenshotHealth;
  if (!health || typeof health !== 'object') return null;
  if (monitoringDisplay && !monitoringDisplay.telemetryCurrent) return null;
  if (monitoringDisplay && ['signed_out', 'delegated'].includes(monitoringDisplay.kind)) return null;

  const now = Number(nowMs);
  const lastErrorAt = Number(health.lastErrorAt);
  const lastSuccessAtValue = Number(health.lastSuccessAt);
  const lastSuccessAt = Number.isFinite(lastSuccessAtValue) ? lastSuccessAtValue : 0;
  const errorAfterSuccess = Number.isFinite(lastErrorAt) && lastErrorAt > 0 && lastErrorAt > lastSuccessAt;
  const errorRecent = errorAfterSuccess
    && Number.isFinite(now)
    && now - lastErrorAt <= 2 * screenshotStaleThresholdMs(cadence);
  // `alarmActive` reports that the extension's periodic capture alarm is
  // SCHEDULED, which is the healthy state for every actively monitored device
  // (service-worker.js sets it from `screenshotScheduled` and re-arms the alarm
  // whenever tracking is active). It is never a failure signal. Only a capture
  // error newer than the last success, and recent enough to still describe the
  // current frame, means capture is failing.
  if (errorRecent) {
    return { kind: 'failing', label: 'Preview capture failing', tone: 'warn' };
  }
  if (cadence === 'active_view') {
    return screenshotDisplay?.fresh
      ? { kind: 'live', label: 'Live preview · 5s', tone: 'ok' }
      : { kind: 'delayed', label: 'Preview delayed', tone: 'warn' };
  }
  return { kind: 'background', label: 'Preview every 30s', tone: 'muted' };
}

export function isClassBoundScreenshot(screenshotData) {
  return typeof screenshotData?.bindingVersion === 'string'
    && screenshotData.bindingVersion.startsWith('v2:');
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
    case 'signing_in':
      return {
        reason: 'Updating preview',
        showLastObservation: true,
        warning: false,
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
  screenshotStaleThresholdMsFor = null,
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
    const screenshotDisplay = deriveScreenshotDisplay(screenshot, nowMs, {
      staleThresholdMs: typeof screenshotStaleThresholdMsFor === 'function'
        ? screenshotStaleThresholdMsFor(student)
        : undefined,
    });
    if (
      (
        monitoring.telemetryCurrent
        || monitoring.kind === 'reconnecting'
        || monitoring.kind === 'updates_unavailable'
        || monitoring.kind === 'signal_lost'
      )
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
