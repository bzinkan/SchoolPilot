import assert from 'node:assert/strict';
import test from 'node:test';
import { currentTabFocusTarget, deriveTileLockControl, exactFocusPayload, focusTabCapability, focusPayloadForStudents, focusStatusLabel, focusCommandFeedback }
  from '../src/products/classpilot/lib/focusControls.js';

const row = (studentId, tabRef) => ({ studentId, tabRef, observedRevision: 7,
  acceptedCapabilities: { focusTabV1: true, scopedAuthorityChecksV1: true }, url: 'https://duplicate.example/', deviceId: 'must-not-leak' });
test('duplicate URLs retain each selected opaque ref and never enter the payload', () => {
  assert.deepEqual(exactFocusPayload([row('student-a', 'opaque-a'), row('student-b', 'opaque-b')]), {
    tabTargets: [{ studentId: 'student-a', tabRef: 'opaque-a', observedRevision: 7 }, { studentId: 'student-b', tabRef: 'opaque-b', observedRevision: 7 }] });
});
test('raw advertisement cannot override capability withdrawal', () => {
  assert.equal(focusTabCapability({ ...row('a', 'ref'), acceptedCapabilities: [],
    capabilities: { focusTabV1: true, scopedAuthorityChecksV1: true }, extensionCapabilities: ['focusTabV1', 'scopedAuthorityChecksV1'] }).enabled, false);
});
test('missing refs, stale revisions and two targets for one student cannot construct a command', () => {
  for (const value of [{ ...row('a', 'ref'), tabRef: '' }, { ...row('a', 'ref'), observedRevision: 0 }, { ...row('a', 'ref'), observedRevision: 1.2 }])
    assert.throws(() => exactFocusPayload([value]));
  assert.throws(() => exactFocusPayload([row('a', 'ref'), row('a', 'other')]));
  assert.throws(() => exactFocusPayload([]));
});
test('claimed contexts receive only their selected students and reject missing or duplicate bindings', () => {
  const payload = exactFocusPayload([row('a', 'ref-a'), row('b', 'ref-b')]);
  assert.deepEqual(focusPayloadForStudents(payload, ['b']), { tabTargets: [{ studentId: 'b', tabRef: 'ref-b', observedRevision: 7 }] });
  assert.throws(() => focusPayloadForStudents(payload, ['c']));
  assert.throws(() => focusPayloadForStudents(payload, ['a', 'a']));
});
test('desired Focus is pending and suspended states never claim active enforcement', () => {
  assert.match(focusStatusLabel({ classroomState: { restrictions: { focus: { active: true } } } }), /awaiting confirmation/);
  assert.equal(focusStatusLabel({ focus: { state: 'suspended', reason: 'authentication' } }), 'Focus paused for sign-in');
  assert.equal(focusStatusLabel({ focus: { state: 'active' } }), 'Focus confirmed');
});
test('a prior device assignment cannot confirm or describe a newly requested Focus', () => {
  const classroomState = { restrictions: { focus: { active: true, assignmentId: 'new-focus' } } };
  for (const focus of [
    { state: 'active', assignmentId: 'old-focus' },
    { state: 'suspended', assignmentId: 'old-focus', reason: 'attention' },
    { state: 'suspended', assignmentId: 'old-focus', reason: 'authentication' },
    { state: 'invalidated', assignmentId: 'old-focus', reason: 'focus_tab_closed' },
  ]) {
    assert.equal(focusStatusLabel({ classroomState, focus }), 'Focus requested; awaiting confirmation');
  }
});
test('matching Focus assignment retains its actual lifecycle label', () => {
  const classroomState = { restrictions: { focus: { active: true, assignmentId: 'current-focus' } } };
  for (const [focus, expected] of [
    [{ state: 'active', assignmentId: 'current-focus' }, 'Focus confirmed'],
    [{ state: 'suspended', assignmentId: 'current-focus', reason: 'attention' }, 'Focus paused for Attention'],
    [{ state: 'suspended', assignmentId: 'current-focus', reason: 'authentication' }, 'Focus paused for sign-in'],
    [{ state: 'invalidated', assignmentId: 'current-focus', reason: 'focus_tab_closed' }, 'Focus ended: tab closed'],
  ]) {
    assert.equal(focusStatusLabel({ classroomState, focus }), expected);
    assert.equal(focusStatusLabel({ focus }), expected, 'coverage rows without desired assignment retain reported truth');
    assert.equal(focusStatusLabel({ classroomState: { restrictions: { focus: { active: true } } }, focus }), expected,
      'legacy desired state without an assignment cannot establish a mismatch');
  }
});
test('received ACKs remain pending and unavailable recipients do not become signed-out claims', () => {
  const feedback = focusCommandFeedback({ targets: [{ status: 'received' }, { status: 'unavailable' }] }, 'focus-tab');
  assert.match(feedback.title, /awaiting/); assert.match(feedback.description, /0 completed, 1 pending, 1 failed or unavailable/);
  assert.doesNotMatch(feedback.description, /signed out|saved/);
});

const tileStudent = (overrides = {}) => ({
  studentId: 'student-a', activeTabRef: 'exact-current', tabSnapshotRevision: 7,
  acceptedCapabilities: { focusTabV1: true, scopedAuthorityChecksV1: true },
  capabilities: { screenOnlyUnlockV1: true }, screenLocked: false,
  allOpenTabs: [
    { tabRef: 'same-url-other-tab', url: 'https://duplicate.example/', active: true },
    { tabRef: 'exact-current', url: 'https://duplicate.example/', title: 'Current exact tab' },
  ],
  ...overrides,
});
const desired = (focus, waypoint = false) => ({ restrictions: { focus, screenLock: { active: waypoint } } });
const activeFocusStudent = (overrides = {}) => tileStudent({
  classroomState: desired({ active: true, assignmentId: 'current-focus' }),
  focus: { state: 'active', assignmentId: 'current-focus' },
  ...overrides,
});

test('tile shortcut chooses the active opaque ref, never a duplicate URL or active-flag guess', () => {
  const target = currentTabFocusTarget(tileStudent());
  assert.equal(target.enabled, true);
  assert.equal(target.row.title, 'Current exact tab');
  assert.deepEqual(target.payload, { tabTargets: [{ studentId: 'student-a', tabRef: 'exact-current', observedRevision: 7 }] });
  assert.equal(currentTabFocusTarget(tileStudent({ tabSnapshotRevision: undefined, tabSnapshot: { revision: 9 } })).row.observedRevision, 9);
});

test('tile shortcut fails closed without genuine snapshot identity and a single matching HTTP(S) row', () => {
  const invalid = [
    { activeTabRef: undefined }, { activeTabRef: ' exact-current ' }, { activeTabRef: 'missing' },
    { tabSnapshotRevision: undefined, revision: 7 }, { tabSnapshotRevision: '7' },
    { tabSnapshotRevision: 0 }, { tabSnapshotRevision: 1.2 },
    { allOpenTabs: [{ tabRef: 'exact-current', url: 'chrome://newtab/' }] },
    { allOpenTabs: [{ tabRef: 'exact-current', url: 'javascript:alert(1)' }] },
    { allOpenTabs: [{ tabRef: 'exact-current', url: 'invalid-url' }] },
    { allOpenTabs: [{ tabRef: 'exact-current', url: 'https://a.example/' }, { tabRef: 'exact-current', url: 'https://b.example/' }] },
    { acceptedCapabilities: [] }, { acceptedCapabilities: { focusTabV1: true, scopedAuthorityChecksV1: false } },
  ];
  for (const overrides of invalid) {
    const target = currentTabFocusTarget(tileStudent(overrides));
    assert.equal(target.enabled, false, JSON.stringify(overrides));
    assert.equal(target.reason, 'Current tab unavailable—refresh or use Manage Tabs.');
    assert.equal(target.row, null);
    assert.equal(target.payload, null);
  }
});

test('tile lock matrix uses direct Focus, Stop Focus, and screen-only Waypoint actions, with a menu only for both', () => {
  for (const [student, expected] of [
    [tileStudent(), { action: 'focus-current-tab', locked: false, menu: false, label: 'Focus current tab' }],
    [activeFocusStudent(), { action: 'stop-focus', locked: true, menu: false, label: 'Stop Focus' }],
    [tileStudent({ screenLocked: true }), { action: 'clear-waypoint', locked: true, menu: false, label: 'Clear Waypoint' }],
    [activeFocusStudent({ screenLocked: true, classroomState: desired({ active: true, assignmentId: 'current-focus' }, true) }),
      { action: null, locked: true, menu: true, label: 'Manage Focus and Waypoint' }],
  ]) {
    const control = deriveTileLockControl(student);
    for (const [key, value] of Object.entries(expected)) assert.equal(control[key], value, key);
    assert.equal(control.disabled, false);
  }
});

test('requested and paused Focus stay clearable alongside Waypoint without claiming active enforcement', () => {
  for (const [focus, status, label] of [
    [{ state: 'active', assignmentId: 'prior-focus' }, 'requested', 'Focus requested; awaiting confirmation'],
    [{ state: 'suspended', assignmentId: 'current-focus', reason: 'attention' }, 'suspended', 'Focus paused for Attention'],
    [{ state: 'suspended', assignmentId: 'current-focus', reason: 'authentication' }, 'suspended', 'Focus paused for sign-in'],
    [{ state: 'suspended', assignmentId: 'current-focus', reason: 'browser_operation_pending' }, 'suspended', 'Focus waiting for the browser'],
  ]) {
    const control = deriveTileLockControl(activeFocusStudent({ focus, screenLocked: true,
      classroomState: desired({ active: true, assignmentId: 'current-focus' }, true) }));
    assert.equal(control.focus.status, status);
    assert.equal(control.focus.label, label);
    assert.equal(control.focus.confirmed, false);
    assert.equal(control.menu, true);
    assert.equal(control.locked, true);
  }
});

test('matching invalidated Focus is visibly ended and cannot turn an unrelated Waypoint into Stop Focus', () => {
  const student = activeFocusStudent({ focus: { state: 'invalidated', assignmentId: 'current-focus', reason: 'focus_tab_closed' } });
  const ended = deriveTileLockControl(student);
  assert.equal(ended.locked, false);
  assert.equal(ended.action, 'focus-current-tab');
  assert.match(ended.statusLabel, /Focus ended/);
  assert.equal(ended.warning, true);
  const waypoint = deriveTileLockControl({ ...student, screenLocked: true,
    classroomState: desired({ active: true, assignmentId: 'current-focus' }, true) });
  assert.equal(waypoint.locked, true);
  assert.equal(waypoint.action, 'clear-waypoint');
  assert.equal(waypoint.menu, false);
});

test('invalidated Focus explains each target lifecycle reason without claiming enforcement', () => {
  for (const [reason, label] of [
    ['focus_tab_closed', 'Focus ended: tab closed'],
    ['focus_tab_missing', 'Focus ended: tab unavailable'],
    ['focus_tab_off_policy', 'Focus ended: tab no longer allowed'],
    ['unknown-reason', 'Focus ended: target unavailable'],
  ]) {
    const student = activeFocusStudent({ focus: { state: 'invalidated', assignmentId: 'current-focus', reason } });
    assert.equal(focusStatusLabel(student), label);
    const control = deriveTileLockControl(student);
    assert.equal(control.statusLabel, label);
    assert.equal(control.locked, false);
    assert.equal(control.focus.clearable, false);
  }
});

test('stale telemetry disables starting with current-tab guidance while authority and selection retain their reasons', () => {
  const stale = deriveTileLockControl(tileStudent(), {
    canFocusTab: false, focusTelemetryCurrent: false, actionsDisabledReason: 'Student actions are disabled while monitoring updates',
  });
  assert.equal(stale.disabled, true);
  assert.equal(stale.reason, 'Current tab unavailable—refresh or use Manage Tabs.');
  const missing = deriveTileLockControl(tileStudent({ activeTabRef: undefined }), { canFocusTab: false });
  assert.equal(missing.reason, 'Current tab unavailable—refresh or use Manage Tabs.');
  for (const actionsDisabledReason of ['Observe access is read-only', 'Clear the signed-out restriction selection']) {
    const denied = deriveTileLockControl(tileStudent(), {
      actionsDisabled: true, focusTelemetryCurrent: false, actionsDisabledReason,
    });
    assert.equal(denied.disabled, true);
    assert.equal(denied.reason, actionsDisabledReason);
  }
});

test('desired and reported Waypoint state show pending start and release truthfully', () => {
  const starting = deriveTileLockControl(tileStudent({ classroomState: desired(undefined, true) }));
  assert.equal(starting.waypoint.status, 'requested');
  assert.equal(starting.waypoint.confirmed, false);
  assert.equal(starting.locked, true);
  assert.equal(starting.pending, true);
  const releasing = deriveTileLockControl(tileStudent({ screenLocked: true, classroomState: desired(undefined, false) }));
  assert.equal(releasing.waypoint.status, 'releasing');
  assert.equal(releasing.locked, true);
  assert.match(releasing.statusLabel, /Clearing Waypoint; awaiting confirmation/);
});

test('Focus cleanup can remain available without current-tab capability or fresh target proof', () => {
  const control = deriveTileLockControl(activeFocusStudent({ activeTabRef: undefined, acceptedCapabilities: [] }), {
    canFocusTab: false, canStopFocus: true, canClearWaypoint: false,
  });
  assert.equal(control.action, 'stop-focus');
  assert.equal(control.disabled, false);
  assert.equal(control.focusTarget.enabled, false);
});

test('action authority and screen-only capability gate each menu choice independently', () => {
  const both = activeFocusStudent({ screenLocked: true, classroomState: desired({ active: true, assignmentId: 'current-focus' }, true) });
  const focusOnly = deriveTileLockControl(both, { canStopFocus: true, canClearWaypoint: false });
  assert.equal(focusOnly.disabled, false);
  assert.equal(focusOnly.stopFocusDisabled, false);
  assert.equal(focusOnly.clearWaypointDisabled, true);
  assert.equal(focusOnly.stopBothDisabled, true);
  const unsupported = deriveTileLockControl({ ...both, capabilities: {}, extensionCapabilities: [] });
  assert.equal(unsupported.stopFocusDisabled, false);
  assert.equal(unsupported.clearWaypointDisabled, true);
  assert.equal(unsupported.stopBothDisabled, true);
  const denied = deriveTileLockControl(both, { canStopFocus: false, canClearWaypoint: false });
  assert.equal(denied.disabled, true);
  assert.equal(deriveTileLockControl(both, { actionsDisabled: true }).disabled, true);
  const unrestricted = deriveTileLockControl(tileStudent());
  assert.equal(unrestricted.stopFocusDisabled, true);
  assert.equal(unrestricted.clearWaypointDisabled, true);
  assert.equal(unrestricted.stopBothDisabled, true);
});

test('pending operation disables duplicate dispatch but bounded waiting keeps cleanup available', () => {
  const student = activeFocusStudent();
  const operation = { action: 'stop-focus', phase: 'Stop Focus: awaiting confirmation',
    focusAssignmentId: 'current-focus', outcomes: { focus: { status: 'received' } } };
  const inFlight = deriveTileLockControl(student, { lockOperation: { ...operation, pending: true } });
  assert.equal(inFlight.pending, true);
  assert.equal(inFlight.disabled, true);
  assert.equal(inFlight.statusLabel, 'Stopping Focus; awaiting confirmation');
  const stillAwaiting = deriveTileLockControl(student, { lockOperation: { ...operation, pending: false } });
  assert.equal(stillAwaiting.pending, true);
  assert.equal(stillAwaiting.disabled, false);
  assert.equal(stillAwaiting.action, 'stop-focus');
});

test('completed Focus cleanup only overrides its original assignment, never a replacement', () => {
  const operation = { pending: false, action: 'stop-focus', focusAssignmentId: 'current-focus',
    outcomes: { focus: { status: 'completed' } } };
  const stopped = deriveTileLockControl(activeFocusStudent(), { lockOperation: operation });
  assert.equal(stopped.locked, false);
  assert.equal(stopped.action, 'focus-current-tab');
  const replacement = activeFocusStudent({ classroomState: desired({ active: true, assignmentId: 'replacement-focus' }),
    focus: { state: 'active', assignmentId: 'replacement-focus' } });
  const active = deriveTileLockControl(replacement, { lockOperation: operation });
  assert.equal(active.locked, true);
  assert.equal(active.focus.confirmed, true);
  const obsoletePending = deriveTileLockControl(replacement, { lockOperation: { ...operation, outcomes: { focus: { status: 'received' } } } });
  assert.equal(obsoletePending.pending, false);
  assert.equal(obsoletePending.statusLabel, 'Focus confirmed');
  const oldAcknowledgment = deriveTileLockControl(activeFocusStudent({
    focus: { state: 'active', assignmentId: 'prior-focus' },
  }), { lockOperation: operation });
  assert.equal(oldAcknowledgment.locked, false, 'old ACK cannot defeat a completed cleanup of the current desired assignment');
});

test('Stop Both preserves failed restrictions and does not roll back a confirmed independent release', () => {
  const lockOperation = { pending: false, action: 'stop-both', focusAssignmentId: 'current-focus',
    outcomes: { focus: { status: 'completed' }, waypoint: { status: 'failed', error: 'Waypoint unavailable' } },
    error: 'Focus stopped; Waypoint could not be cleared.' };
  const partial = deriveTileLockControl(activeFocusStudent({ screenLocked: true,
    classroomState: desired({ active: true, assignmentId: 'current-focus' }, true) }), { lockOperation });
  assert.equal(partial.focus.clearable, false);
  assert.equal(partial.waypoint.clearable, true);
  assert.equal(partial.locked, true);
  assert.equal(partial.action, 'clear-waypoint');
  assert.equal(partial.warning, true);
  const reverse = deriveTileLockControl(activeFocusStudent({ screenLocked: true,
    classroomState: desired({ active: true, assignmentId: 'current-focus' }, false) }), {
    lockOperation: { ...lockOperation, outcomes: { focus: { status: 'failed' }, waypoint: { status: 'completed' } } },
  });
  assert.equal(reverse.focus.clearable, true);
  assert.equal(reverse.waypoint.clearable, false);
  assert.equal(reverse.action, 'stop-focus');
});

test('retrying Waypoint preserves the independently confirmed original Focus cleanup', () => {
  const student = activeFocusStudent({ screenLocked: true,
    classroomState: desired({ active: true, assignmentId: 'current-focus' }, true) });
  const lockOperation = { pending: true, action: 'clear-waypoint', focusAssignmentId: 'current-focus',
    outcomes: { focus: { status: 'completed', commandType: 'stop-focus' },
      waypoint: { status: 'received', commandType: 'unlock-screen' } } };
  const retrying = deriveTileLockControl(student, { lockOperation });
  assert.equal(retrying.focus.clearable, false);
  assert.equal(retrying.menu, false);
  assert.equal(retrying.locked, true);
  assert.equal(retrying.pending, true);
  assert.equal(retrying.statusLabel, 'Clearing Waypoint; awaiting confirmation');
  const replacement = deriveTileLockControl({ ...student,
    classroomState: desired({ active: true, assignmentId: 'replacement-focus' }, true),
    focus: { state: 'active', assignmentId: 'replacement-focus' },
  }, { lockOperation: { ...lockOperation, pending: false } });
  assert.equal(replacement.focus.confirmed, true);
  assert.equal(replacement.menu, true);
});

test('fresh telemetry converging after a timeout clears stale awaiting indicators for independent cleanup outcomes', () => {
  const student = tileStudent({ classroomState: desired(undefined, false), focus: { state: 'inactive' } });
  const lockOperation = { pending: false, action: 'stop-both', focusAssignmentId: 'current-focus',
    outcomes: { focus: { status: 'received', commandType: 'stop-focus' },
      waypoint: { status: 'pending', commandType: 'unlock-screen' } } };
  const converged = deriveTileLockControl(student, { lockOperation });
  assert.equal(converged.pending, false);
  assert.equal(converged.locked, false);
  assert.equal(converged.statusLabel, 'No Focus or Waypoint');
  const unknown = deriveTileLockControl({ ...student, focus: undefined, screenLocked: undefined }, { lockOperation });
  assert.equal(unknown.pending, true, 'absent status is not a device confirmation');
  const inFlight = deriveTileLockControl(student, { lockOperation: { ...lockOperation, pending: true } });
  assert.equal(inFlight.pending, true, 'still-running requests retain their duplicate-dispatch guard');
});

test('fresh matching Focus lifecycle replaces an obsolete starting-command awaiting indicator', () => {
  const lockOperation = { pending: false, action: 'focus-current-tab', focusAssignmentId: null,
    outcomes: { focus: { status: 'received', commandType: 'focus-tab' } } };
  const control = deriveTileLockControl(activeFocusStudent(), { lockOperation });
  assert.equal(control.pending, false);
  assert.equal(control.statusLabel, 'Focus confirmed');
  const paused = deriveTileLockControl(activeFocusStudent({
    focus: { state: 'suspended', assignmentId: 'current-focus', reason: 'authentication' },
  }), { lockOperation });
  assert.equal(paused.pending, false);
  assert.equal(paused.statusLabel, 'Focus paused for sign-in');
});

test('requested and sent cleanup commands remain awaiting after timeout and converge on later telemetry', () => {
  for (const status of ['requesting', 'requested', 'sent', 'pending', 'received']) {
    const lockOperation = { pending: false, action: 'clear-waypoint',
      outcomes: { waypoint: { status, commandType: 'unlock-screen' } } };
    const pending = deriveTileLockControl(tileStudent({ screenLocked: true,
      classroomState: desired(undefined, true) }), { lockOperation });
    assert.equal(pending.pending, true, status);
    assert.equal(pending.statusLabel, 'Clearing Waypoint; awaiting confirmation', status);
    assert.equal(pending.disabled, false, 'bounded wait releases only the duplicate-dispatch guard');
    const converged = deriveTileLockControl(tileStudent({ screenLocked: false,
      classroomState: desired(undefined, false) }), { lockOperation });
    assert.equal(converged.pending, false, status);
    assert.equal(converged.statusLabel, 'No Focus or Waypoint', status);

    const focusOperation = { pending: false, action: 'stop-focus', focusAssignmentId: 'current-focus',
      outcomes: { focus: { status, commandType: 'stop-focus' } } };
    const focusPending = deriveTileLockControl(activeFocusStudent(), { lockOperation: focusOperation });
    assert.equal(focusPending.pending, true, status);
    assert.equal(focusPending.statusLabel, 'Stopping Focus; awaiting confirmation', status);
    const focusConverged = deriveTileLockControl(tileStudent({ focus: { state: 'inactive' },
      classroomState: desired(undefined, false) }), { lockOperation: focusOperation });
    assert.equal(focusConverged.pending, false, status);
  }
});
