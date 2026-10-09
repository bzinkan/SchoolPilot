function negotiated(row, name) {
  const accepted = row?.acceptedCapabilities ?? row?.capabilities;
  return Array.isArray(accepted) ? accepted.includes(name) : accepted?.[name] === true;
}

export function focusTabCapability(row) {
  if (!negotiated(row, 'scopedAuthorityChecksV1') || !negotiated(row, 'focusTabV1'))
    return { enabled: false, reason: 'Focus and Bring Forward are unavailable for this student. A negotiated ClassPilot update is required.' };
  if (typeof row.studentId !== 'string' || !row.studentId || typeof row.tabRef !== 'string'
    || !row.tabRef.trim() || row.tabRef.length > 128 || !Number.isSafeInteger(row.observedRevision) || row.observedRevision < 1)
    return { enabled: false, reason: 'Refresh the tab list before selecting an exact tab.' };
  return { enabled: true, reason: '' };
}

export function exactFocusPayload(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 50
    || new Set(rows.map(row => row.studentId)).size !== rows.length
    || rows.some(row => !focusTabCapability(row).enabled)) throw new Error('Choose one current exact tab per student.');
  return { tabTargets: rows.map(row => ({ studentId: row.studentId, tabRef: row.tabRef, observedRevision: row.observedRevision })) };
}

const CURRENT_TAB_UNAVAILABLE_REASON = 'Current tab unavailable—refresh or use Manage Tabs.';

// A current-tab action must use the browser's opaque identity and actual tab
// snapshot revision. URL equality, a screenshot, and the realtime revision are
// deliberately not fallbacks: duplicate URLs can identify different tabs.
export function currentTabFocusTarget(student) {
  const unavailable = { enabled: false, reason: CURRENT_TAB_UNAVAILABLE_REASON, row: null, payload: null };
  const tabRef = student?.activeTabRef;
  const observedRevision = student?.tabSnapshotRevision ?? student?.tabSnapshot?.revision;
  if (typeof tabRef !== 'string' || !tabRef || tabRef.trim() !== tabRef || tabRef.length > 128
    || !Number.isSafeInteger(observedRevision) || observedRevision < 1) return unavailable;
  const matches = (Array.isArray(student?.allOpenTabs) ? student.allOpenTabs : []).filter(tab => tab?.tabRef === tabRef);
  if (matches.length !== 1) return unavailable;
  const tab = matches[0];
  try {
    if (!['http:', 'https:'].includes(new URL(tab.url).protocol)) return unavailable;
  } catch {
    return unavailable;
  }
  const row = { studentId: student.studentId, tabRef, observedRevision,
    acceptedCapabilities: student.acceptedCapabilities, capabilities: student.capabilities,
    url: tab.url, title: tab.title };
  const capability = focusTabCapability(row);
  if (!capability.enabled) return unavailable;
  return { enabled: true, reason: '', row, payload: exactFocusPayload([row]) };
}

export function focusPayloadForStudents(payload, studentIds) {
  if (!Array.isArray(payload?.tabTargets) || !Array.isArray(studentIds) || !studentIds.length
    || new Set(studentIds).size !== studentIds.length) throw new Error('Exact tab targets changed. Refresh and try again.');
  const rows = payload.tabTargets.filter(row => studentIds.includes(row.studentId));
  if (rows.length !== studentIds.length || new Set(rows.map(row => row.studentId)).size !== rows.length)
    throw new Error('Exact tab targets changed. Refresh and try again.');
  return { tabTargets: rows.map(row => ({ studentId: row.studentId, tabRef: row.tabRef, observedRevision: row.observedRevision })) };
}

function deriveFocusState(student) {
  const state = student?.focus;
  const requested = student?.classroomState?.restrictions?.focus;
  const hasDesiredSnapshot = Boolean(student?.classroomState?.restrictions);
  const assignmentId = requested?.assignmentId || state?.assignmentId || null;
  const result = (status, label, present, confirmed = false) => ({
    status, label, present, clearable: present, confirmed, assignmentId,
    pending: status === 'requested' || status === 'releasing',
  });
  if (requested?.active === true && typeof requested.assignmentId === 'string'
    && requested.assignmentId && requested.assignmentId !== state?.assignmentId)
    return result('requested', 'Focus requested; awaiting confirmation', true);
  if (state?.state === 'invalidated') {
    const label = state.reason === 'focus_tab_closed' ? 'Focus ended: tab closed'
      : state.reason === 'focus_tab_missing' ? 'Focus ended: tab unavailable'
        : state.reason === 'focus_tab_off_policy' ? 'Focus ended: tab no longer allowed'
          : 'Focus ended: target unavailable';
    return result('invalidated', label, false);
  }
  if (hasDesiredSnapshot && requested?.active !== true && ['active', 'suspended'].includes(state?.state))
    return result('releasing', 'Stopping Focus; awaiting confirmation', true);
  if (state?.state === 'active') return result('active', 'Focus confirmed', true, true);
  if (state?.state === 'suspended') return result('suspended', state.reason === 'attention' ? 'Focus paused for Attention'
    : state.reason === 'authentication' ? 'Focus paused for sign-in' : 'Focus waiting for the browser', true);
  return requested?.active === true
    ? result('requested', 'Focus requested; awaiting confirmation', true)
    : result('none', 'No Focus confirmed', false);
}

export function focusStatusLabel(student) {
  return deriveFocusState(student).label;
}

function screenOnlyUnlockSupported(student) {
  // Keep the existing screen-only unlock negotiation, including older public
  // telemetry which reports it in capabilities rather than acceptedCapabilities.
  return student?.capabilities?.screenOnlyUnlockV1 === true
    || student?.acceptedCapabilities?.screenOnlyUnlockV1 === true
    || [student?.extensionCapabilities, student?.capabilities, student?.acceptedCapabilities]
      .some(values => Array.isArray(values) && values.includes('screenOnlyUnlockV1'));
}

function operationLabel(action) {
  switch (action) {
    case 'focus-current-tab':
    case 'focus-tab': return 'Focus requested; awaiting confirmation';
    case 'stop-focus': return 'Stopping Focus; awaiting confirmation';
    case 'clear-waypoint': return 'Clearing Waypoint; awaiting confirmation';
    case 'stop-both': return 'Stopping Focus and clearing Waypoint; awaiting confirmation';
    default: return 'Updating locks; awaiting confirmation';
  }
}

const AWAITING_OUTCOMES = new Set(['requesting', 'requested', 'sent', 'pending', 'received']);
const FAILED_OUTCOMES = new Set(['failed', 'unavailable', 'expired']);

// One projection drives the tile and the dashboard's action decisions. Desired
// restrictions are pending until the corresponding device status confirms
// them; a prior Focus assignment can never confirm a replacement assignment.
export function deriveTileLockControl(student, {
  lockOperation = null,
  canFocusTab = true,
  canStopFocus = true,
  canClearWaypoint = true,
  focusTelemetryCurrent = true,
  actionsDisabled = false,
  actionsDisabledReason = '',
} = {}) {
  let focus = deriveFocusState(student);
  const requestedFocus = student?.classroomState?.restrictions?.focus;
  const operationAction = lockOperation?.action || lockOperation?.phase;
  const clearsFocus = ['stop-focus', 'stop-both'].includes(operationAction)
    || lockOperation?.outcomes?.focus?.commandType === 'stop-focus';
  const originalAssignment = lockOperation?.focusAssignmentId;
  // Desired assignment identity wins over an earlier device ACK. Once desired
  // Focus has been removed, a still-reported assignment remains release proof.
  const currentAssignment = (requestedFocus?.active === true ? requestedFocus.assignmentId : null)
    || student?.focus?.assignmentId || null;
  const originalFocusOnly = originalAssignment !== undefined
    && (!currentAssignment || currentAssignment === originalAssignment);
  if (clearsFocus && lockOperation?.outcomes?.focus?.status === 'completed' && originalFocusOnly) {
    focus = { ...focus, status: 'none', label: 'Focus stopped', present: false,
      clearable: false, confirmed: false, pending: false };
  }

  const requestedWaypoint = student?.classroomState?.restrictions?.screenLock;
  const hasDesiredWaypoint = typeof requestedWaypoint?.active === 'boolean';
  const reportedWaypoint = student?.screenLocked === true;
  const desiredWaypoint = hasDesiredWaypoint ? requestedWaypoint.active : reportedWaypoint;
  let waypoint = desiredWaypoint
    ? { status: reportedWaypoint ? 'active' : 'requested', present: true, clearable: true,
      confirmed: reportedWaypoint, pending: !reportedWaypoint,
      label: reportedWaypoint ? 'Waypoint confirmed' : 'Waypoint requested; awaiting confirmation' }
    : reportedWaypoint
      ? { status: 'releasing', present: true, clearable: true, confirmed: false, pending: true,
        label: 'Clearing Waypoint; awaiting confirmation' }
      : { status: 'none', present: false, clearable: false, confirmed: false, pending: false,
        label: 'No Waypoint confirmed' };
  if (!desiredWaypoint && lockOperation?.outcomes?.waypoint?.status === 'completed'
    && ['clear-waypoint', 'stop-both'].includes(operationAction)) {
    waypoint = { ...waypoint, status: 'none', label: 'Waypoint cleared', present: false,
      clearable: false, confirmed: false, pending: false };
  }

  const focusTarget = currentTabFocusTarget(student);
  const busy = lockOperation?.pending === true;
  const focusReleaseConfirmed = Boolean(student?.classroomState?.restrictions)
    && requestedFocus?.active !== true && student?.focus?.state === 'inactive';
  const focusStartConfirmed = operationAction === 'focus-current-tab'
    && ['active', 'suspended', 'invalidated'].includes(focus.status);
  const waypointReleaseConfirmed = requestedWaypoint?.active !== true && student?.screenLocked === false;
  const outcomes = Object.entries(lockOperation?.outcomes || {})
    .filter(([name]) => name !== 'focus' || !clearsFocus || originalAssignment === undefined || originalFocusOnly)
    .filter(([name, outcome]) => !AWAITING_OUTCOMES.has(outcome?.status)
      || (name === 'focus' ? !(clearsFocus && focusReleaseConfirmed) && !focusStartConfirmed
        : !waypointReleaseConfirmed))
    .map(([, outcome]) => outcome);
  const awaitingOutcome = outcomes.some(outcome => AWAITING_OUTCOMES.has(outcome?.status));
  const pending = busy || awaitingOutcome || focus.pending || waypoint.pending;
  const menu = focus.clearable && waypoint.clearable;
  const action = menu ? null : focus.clearable ? 'stop-focus' : waypoint.clearable ? 'clear-waypoint' : 'focus-current-tab';
  const focusDisabled = !canStopFocus;
  const waypointDisabled = !canClearWaypoint || !screenOnlyUnlockSupported(student);
  let reason = actionsDisabledReason || 'Student actions are unavailable in this view';
  let disabled = actionsDisabled || busy;
  if (busy) reason = operationLabel(operationAction);
  else if (!actionsDisabled) {
    if (menu) {
      disabled = focusDisabled && waypointDisabled;
      reason = !canStopFocus && !canClearWaypoint ? 'Focus and Waypoint controls are unavailable in this view'
        : 'Extension update required for screen-only unlock';
    } else if (action === 'stop-focus') {
      disabled = focusDisabled;
      reason = 'Stop Focus is unavailable in this view';
    } else if (action === 'clear-waypoint') {
      disabled = waypointDisabled;
      reason = !canClearWaypoint ? 'Clear Waypoint is unavailable in this view' : 'Extension update required for screen-only unlock';
    } else {
      disabled = !canFocusTab || !focusTelemetryCurrent || !focusTarget.enabled;
      reason = !focusTelemetryCurrent || !focusTarget.enabled ? CURRENT_TAB_UNAVAILABLE_REASON
        : actionsDisabledReason || 'Focus is unavailable in this view';
    }
  }
  const stateLabels = [focus.status !== 'none' ? focus.label : '', waypoint.status !== 'none' ? waypoint.label : ''].filter(Boolean);
  const statusLabel = busy || awaitingOutcome
    ? operationLabel(operationAction)
    : stateLabels.join(' · ') || 'No Focus or Waypoint';
  const actionLabel = menu ? 'Manage Focus and Waypoint' : action === 'stop-focus' ? 'Stop Focus'
    : action === 'clear-waypoint' ? 'Clear Waypoint' : 'Focus current tab';
  const detail = action === 'focus-current-tab'
    ? 'Keeps the student on this tab; navigation within the tab remains available'
    : statusLabel;
  return { focus, waypoint, locked: focus.present || waypoint.present, pending, busy,
    warning: ['suspended', 'invalidated'].includes(focus.status) || Boolean(lockOperation?.error)
      || outcomes.some(outcome => FAILED_OUTCOMES.has(outcome?.status)),
    action, menu, label: actionLabel, description: detail, statusLabel, disabled, reason, focusTarget,
    stopFocusDisabled: actionsDisabled || busy || focusDisabled || !focus.clearable,
    clearWaypointDisabled: actionsDisabled || busy || waypointDisabled || !waypoint.clearable,
    stopBothDisabled: actionsDisabled || busy || focusDisabled || waypointDisabled || !menu };
}

export function focusCommandFeedback(value, commandType) {
  const targets = value?.command?.targets || value?.targets || [];
  const completed = targets.filter(row => row.status === 'completed').length;
  const unsuccessful = targets.filter(row => ['failed', 'unavailable', 'expired'].includes(row.status)).length;
  const pending = targets.length - completed - unsuccessful;
  const name = commandType === 'activate-tab' ? 'Bring Forward' : commandType === 'stop-focus' ? 'Stop Focus' : 'Focus';
  return { title: `${name}: ${completed ? 'device confirmation received' : pending ? 'awaiting confirmation' : 'not confirmed'}`,
    description: `${completed} completed, ${pending} pending, ${unsuccessful} failed or unavailable. Per-student results remain visible below.`,
    variant: unsuccessful && !completed && !pending ? 'destructive' : undefined };
}
