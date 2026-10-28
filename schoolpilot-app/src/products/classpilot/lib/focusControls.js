import { normalizeObservedAtForOrdering } from './studentMonitoringDisplay.js';

function negotiated(row, name) {
  const accepted = row?.acceptedCapabilities ?? row?.capabilities;
  return Array.isArray(accepted) ? accepted.includes(name) : accepted?.[name] === true;
}

// Bring Forward retains the exact-tab wire capability. Renaming the website
// restriction must not weaken its opaque identity or negotiated capability.
export function exactTabCapability(row) {
  if (!negotiated(row, 'scopedAuthorityChecksV1') || !negotiated(row, 'focusTabV1'))
    return { enabled: false, reason: 'Bring Forward is unavailable for this student. A negotiated ClassPilot update is required.' };
  if (typeof row.studentId !== 'string' || !row.studentId || typeof row.tabRef !== 'string'
    || !row.tabRef.trim() || row.tabRef.length > 128 || !Number.isSafeInteger(row.observedRevision) || row.observedRevision < 1)
    return { enabled: false, reason: 'Refresh the tab list before selecting an exact tab.' };
  return { enabled: true, reason: '' };
}

export function exactTabPayload(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 50
    || new Set(rows.map(row => row.studentId)).size !== rows.length
    || rows.some(row => !exactTabCapability(row).enabled)) throw new Error('Choose one current exact tab per student.');
  return { tabTargets: rows.map(row => ({ studentId: row.studentId, tabRef: row.tabRef, observedRevision: row.observedRevision })) };
}

export function exactTabPayloadForStudents(payload, studentIds) {
  if (!Array.isArray(payload?.tabTargets) || !Array.isArray(studentIds) || !studentIds.length
    || new Set(studentIds).size !== studentIds.length) throw new Error('Exact tab targets changed. Refresh and try again.');
  const rows = payload.tabTargets.filter(row => studentIds.includes(row.studentId));
  if (rows.length !== studentIds.length || new Set(rows.map(row => row.studentId)).size !== rows.length)
    throw new Error('Exact tab targets changed. Refresh and try again.');
  return { tabTargets: rows.map(row => ({ studentId: row.studentId, tabRef: row.tabRef, observedRevision: row.observedRevision })) };
}

const CURRENT_PAGE_UNAVAILABLE_REASON = 'Current website unavailable. Wait for a fresh browser update or use Set Focus with a specific URL.';

export function currentPageFocusTarget(student) {
  const unavailable = { enabled: false, reason: CURRENT_PAGE_UNAVAILABLE_REASON, payload: null };
  if (typeof student?.studentId !== 'string' || !student.studentId) return unavailable;
  try {
    const url = new URL(student.activeTabUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return unavailable;
  } catch { return unavailable; }
  // The server resolves the fresh current page for this student. A tab ref is
  // not an identity requirement for a website restriction.
  return { enabled: true, reason: '', payload: { url: 'CURRENT_URL' } };
}

function screenOnlyUnlockSupported(student) {
  return student?.capabilities?.screenOnlyUnlockV1 === true
    || student?.acceptedCapabilities?.screenOnlyUnlockV1 === true
    || [student?.extensionCapabilities, student?.capabilities, student?.acceptedCapabilities]
      .some(values => Array.isArray(values) && values.includes('screenOnlyUnlockV1'));
}

function legacyFocusPresent(student) {
  return student?.classroomState?.restrictions?.focus?.active === true
    || ['active', 'suspended'].includes(student?.focus?.state);
}

export function tileFocusTelemetryObservedAt(student) {
  return normalizeObservedAtForOrdering(student?.realtimeObservedAt)
    ?? normalizeObservedAtForOrdering(student?.lastSeenAt);
}

function completedCurrentPageStart(operation) {
  const outcome = operation?.outcomes?.focus;
  return operation?.action === 'focus-current-page' && outcome?.status === 'completed'
    && outcome.commandType === 'lock-screen' && outcome.result?.currentPage === true;
}

// CURRENT_URL is transient: its browser confirmation need not change the saved
// policy revision. Fence it with the exact command ACK and newer telemetry.
// An old inactive row cannot undo a start, even if its ACK arrives first.
export function tileFocusLifecycleObserved(student, operation, telemetryCurrent = true) {
  const observedAt = tileFocusTelemetryObservedAt(student);
  const newerTelemetry = telemetryCurrent && observedAt !== null
    && Number.isFinite(operation?.focusObservedAt) && observedAt > operation.focusObservedAt;
  if (newerTelemetry && completedCurrentPageStart(operation)) {
    if (student?.screenLocked === true) return true;
    if (student?.screenLocked === false && Number.isFinite(operation.focusConfirmedObservedAt)
      && observedAt > operation.focusConfirmedObservedAt) return true;
  }
  if (newerTelemetry && operation?.action === 'stop-focus'
    && operation?.outcomes?.focus?.status === 'completed'
    && operation.outcomes.focus.commandType === 'unlock-screen'
    && student?.screenLocked === false && !legacyFocusPresent(student)
    && student?.classroomState?.restrictions?.screenLock?.active !== true) return true;
  const revision = student?.classroomState?.revision;
  const restrictions = student?.classroomState?.restrictions;
  if (!restrictions || !Number.isSafeInteger(revision) || revision < 1
    || !Number.isSafeInteger(operation?.focusControlRevision)
    || revision <= operation.focusControlRevision) return false;
  return restrictions.screenLock?.active === true
    ? student?.screenLocked === true
    : student?.screenLocked === false;
}

const AWAITING_OUTCOMES = new Set(['requesting', 'requested', 'sent', 'pending', 'received']);
const FAILED_OUTCOMES = new Set(['failed', 'unavailable', 'expired']);

export function deriveTileLockControl(student, {
  lockOperation = null, canSetFocus = true, canStopFocus = true,
  focusTelemetryCurrent = true, actionsDisabled = false, actionsDisabledReason = '',
} = {}) {
  const requested = student?.classroomState?.restrictions?.screenLock;
  const hasDesired = typeof requested?.active === 'boolean';
  const reported = student?.screenLocked === true;
  const desired = hasDesired ? requested.active : reported;
  const legacy = legacyFocusPresent(student);
  const action = lockOperation?.action || lockOperation?.phase;
  const outcome = lockOperation?.outcomes?.focus;
  const lifecycleObserved = tileFocusLifecycleObserved(student, lockOperation, focusTelemetryCurrent);
  const provisionalStart = action === 'focus-current-page'
    && (lockOperation?.awaitingFocusLifecycle === true
      || completedCurrentPageStart(lockOperation) && Number.isFinite(lockOperation?.focusConfirmedObservedAt))
    && !lifecycleObserved && !FAILED_OUTCOMES.has(outcome?.status);
  const releaseConfirmed = !desired && student?.screenLocked === false && !legacy
    && (action !== 'stop-focus' || lifecycleObserved);
  const outcomeAwaiting = AWAITING_OUTCOMES.has(outcome?.status)
    && !lifecycleObserved;
  const busy = lockOperation?.pending === true;
  const stopping = action === 'stop-focus' && !releaseConfirmed && !lifecycleObserved
    && !FAILED_OUTCOMES.has(outcome?.status);
  const clearable = desired || reported || legacy || provisionalStart || stopping;
  const pending = busy || outcomeAwaiting || provisionalStart || stopping || (desired && !reported);
  let statusLabel = stopping ? 'Stopping Focus; awaiting confirmation'
    : reported && !provisionalStart ? 'Focus confirmed'
    : desired || provisionalStart ? 'Focus requested; awaiting confirmation'
      : legacy ? 'Focus cleanup available' : 'No Focus';
  if (busy || outcomeAwaiting) statusLabel = action === 'stop-focus'
    ? 'Stopping Focus; awaiting confirmation' : 'Focus requested; awaiting confirmation';
  const focusTarget = currentPageFocusTarget(student);
  const nextAction = clearable ? 'stop-focus' : 'focus-current-page';
  let reason = actionsDisabledReason || 'Student actions are unavailable in this view';
  let disabled = actionsDisabled || busy;
  if (busy) reason = statusLabel;
  else if (!actionsDisabled && clearable) {
    disabled = !canStopFocus || !screenOnlyUnlockSupported(student);
    reason = !canStopFocus ? 'Stop Focus is unavailable in this view' : 'Extension update required for screen-only unlock';
  } else if (!actionsDisabled) {
    disabled = !canSetFocus || !focusTelemetryCurrent || !focusTarget.enabled;
    reason = !focusTelemetryCurrent || !focusTarget.enabled ? CURRENT_PAGE_UNAVAILABLE_REASON : 'Focus is unavailable in this view';
  }
  return {
    locked: clearable, pending, busy, action: nextAction,
    warning: Boolean(lockOperation?.error) || FAILED_OUTCOMES.has(outcome?.status),
    label: clearable ? 'Stop Focus' : 'Focus current website',
    description: clearable ? statusLabel : 'Keeps the student on their current website. Other pages on that website remain available.',
    statusLabel, disabled, reason, focusTarget,
    stopFocusDisabled: actionsDisabled || busy || !canStopFocus || !screenOnlyUnlockSupported(student) || !clearable,
  };
}

export function tabActionFeedback(value) {
  const targets = value?.command?.targets || value?.targets || [];
  const completed = targets.filter(row => row.status === 'completed').length;
  const unsuccessful = targets.filter(row => ['failed', 'unavailable', 'expired'].includes(row.status)).length;
  const pending = targets.length - completed - unsuccessful;
  return { title: `Bring Forward: ${completed ? 'device confirmation received' : pending ? 'awaiting confirmation' : 'not confirmed'}`,
    description: `${completed} completed, ${pending} pending, ${unsuccessful} failed or unavailable. Per-student results remain visible below.`,
    variant: unsuccessful && !completed && !pending ? 'destructive' : undefined };
}
