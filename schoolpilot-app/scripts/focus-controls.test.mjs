import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPageFocusTarget, deriveTileLockControl, exactTabPayload, exactTabCapability,
  exactTabPayloadForStudents, tabActionFeedback, tileFocusLifecycleObserved } from '../src/products/classpilot/lib/focusControls.js';
const row = (studentId = 'a', tabRef = 'opaque-a') => ({ studentId, tabRef, observedRevision: 7, acceptedCapabilities: ['scopedAuthorityChecksV1', 'focusTabV1'] });
const student = (extra = {}) => ({ studentId: 'a', activeTabUrl: 'https://lesson.example.test/page', screenLocked: false,
  acceptedCapabilities: { screenOnlyUnlockV1: true }, classroomState: { revision: 1, restrictions: { screenLock: { active: false }, focus: { active: false } } }, ...extra });
const focused = (extra = {}) => student({ screenLocked: true, classroomState: { revision: 2, restrictions: { screenLock: { active: true } } }, ...extra });

test('Bring Forward retains exact opaque identity, revisions and negotiated capabilities', () => {
  const payload = exactTabPayload([row('a'), row('b', 'opaque-b')]);
  assert.deepEqual(payload, { tabTargets: [{ studentId: 'a', tabRef: 'opaque-a', observedRevision: 7 }, { studentId: 'b', tabRef: 'opaque-b', observedRevision: 7 }] });
  for (const value of [{ ...row(), acceptedCapabilities: [], extensionCapabilities: ['focusTabV1', 'scopedAuthorityChecksV1'] },
    { ...row(), tabRef: '' }, { ...row(), observedRevision: 0 }]) {
    assert.equal(exactTabCapability(value).enabled, false); assert.throws(() => exactTabPayload([value]));
  }
  assert.throws(() => exactTabPayload([row(), row()])); assert.throws(() => exactTabPayload([]));
  assert.deepEqual(exactTabPayloadForStudents(payload, ['b']), { tabTargets: [payload.tabTargets[1]] });
  for (const ids of [[], ['c'], ['a', 'a']]) assert.throws(() => exactTabPayloadForStudents(payload, ids));
  assert.match(exactTabCapability({ ...row(), acceptedCapabilities: [] }).reason, /^Bring Forward/);
});
test('website Focus uses CURRENT_URL without exact-tab capability or opaque identity', () => {
  const current = student({ activeTabRef: null, tabSnapshotRevision: null, acceptedCapabilities: {} });
  assert.deepEqual(currentPageFocusTarget(current), { enabled: true, reason: '', payload: { url: 'CURRENT_URL' } });
  const control = deriveTileLockControl(current);
  assert.equal(control.action, 'focus-current-page'); assert.equal(control.disabled, false);
  assert.equal(control.label, 'Focus current website'); assert.equal(control.locked, false);
  assert.match(control.description, /Other pages on that website remain available/);
});
test('website shortcut refuses unsafe pages, stale telemetry and unavailable authority', () => {
  for (const activeTabUrl of ['', null, 'chrome://settings', 'about:blank', 'https://person:secret@example.test/'])
    assert.equal(deriveTileLockControl(student({ activeTabUrl })).disabled, true);
  assert.equal(currentPageFocusTarget(student({ studentId: '' })).enabled, false);
  for (const options of [{ focusTelemetryCurrent: false }, { canSetFocus: false }, { actionsDisabled: true }])
    assert.equal(deriveTileLockControl(student(), options).disabled, true);
});
test('one Stop Focus releases website or lingering legacy state with no second menu', () => {
  const active = deriveTileLockControl(focused());
  assert.equal(active.action, 'stop-focus'); assert.equal(active.statusLabel, 'Focus confirmed');
  for (const legacy of [student({ focus: { state: 'active' } }), student({ focus: { state: 'suspended' } }),
    student({ classroomState: { revision: 1, restrictions: { focus: { active: true } } } })]) {
    const control = deriveTileLockControl(legacy, { focusTelemetryCurrent: false, canSetFocus: false });
    assert.equal(control.action, 'stop-focus'); assert.equal(control.disabled, false);
    assert.equal(control.statusLabel, 'Focus cleanup available');
  }
});
test('Stop Focus retains capability and authority gates while current telemetry is unavailable', () => {
  assert.equal(deriveTileLockControl(focused(), { focusTelemetryCurrent: false }).disabled, false);
  assert.equal(deriveTileLockControl(focused({ acceptedCapabilities: {} })).disabled, true);
  assert.equal(deriveTileLockControl(focused(), { canStopFocus: false }).disabled, true);
  assert.equal(deriveTileLockControl(focused(), { actionsDisabled: true }).disabled, true);
  assert.equal(deriveTileLockControl(focused({ acceptedCapabilities: [], capabilities: { screenOnlyUnlockV1: true } })).disabled, false);
});
test('saved Focus requests and transient browser Focus remain distinct', () => {
  assert.equal(deriveTileLockControl(focused({ screenLocked: false })).statusLabel, 'Focus requested; awaiting confirmation');
  assert.equal(deriveTileLockControl(student({ screenLocked: true })).statusLabel, 'Focus confirmed');
});
test('accepted tile start stays clearable until a newer authoritative lifecycle snapshot arrives', () => {
  const operation = { action: 'focus-current-page', focusControlRevision: 1, awaitingFocusLifecycle: true, pending: false,
    outcomes: { focus: { status: 'completed', commandType: 'lock-screen' } } };
  const pending = deriveTileLockControl(student(), { lockOperation: operation });
  assert.equal(pending.locked, true); assert.equal(pending.action, 'stop-focus');
  assert.equal(pending.statusLabel, 'Focus requested; awaiting confirmation');
  assert.equal(tileFocusLifecycleObserved(student(), operation), false);
  assert.equal(tileFocusLifecycleObserved(focused(), operation), true);
  assert.equal(deriveTileLockControl(focused(), { lockOperation: operation }).statusLabel, 'Focus confirmed');
  const cleared = student({ classroomState: { revision: 3, restrictions: { screenLock: { active: false } } } });
  assert.equal(tileFocusLifecycleObserved(cleared, operation), true);
  assert.equal(deriveTileLockControl(cleared, { lockOperation: operation }).locked, false);
});
test('failed starts and obsolete stop acknowledgements cannot invent enforcement or erase newer Focus', () => {
  const failed = { action: 'focus-current-page', awaitingFocusLifecycle: true, outcomes: { focus: { status: 'failed' } } };
  assert.equal(deriveTileLockControl(student(), { lockOperation: failed }).locked, false);
  assert.equal(deriveTileLockControl(student(), { lockOperation: failed }).warning, true);
  assert.equal(deriveTileLockControl(student(), { lockOperation: { pending: true, action: 'focus-current-page' } }).disabled, true);
  const oldStop = { action: 'stop-focus', focusControlRevision: 1, outcomes: { focus: { status: 'completed', commandType: 'unlock-screen' } } };
  assert.equal(deriveTileLockControl(focused(), { lockOperation: oldStop }).locked, true);
  assert.equal(deriveTileLockControl(student({ classroomState: { revision: 3, restrictions: { screenLock: { active: false } } } }), { lockOperation: oldStop }).locked, false);
});
test('transient current-page Focus confirms at the same policy revision and rejects old inactive telemetry', () => {
  const observedAt = Date.now() - 10_000;
  const initial = student({ realtimeObservedAt: observedAt });
  const operation = { action: 'focus-current-page', focusControlRevision: 1, focusObservedAt: observedAt,
    awaitingFocusLifecycle: true, pending: false,
    outcomes: { focus: { status: 'completed', commandType: 'lock-screen', commandId: 'exact-start', result: { currentPage: true } } } };
  assert.equal(tileFocusLifecycleObserved(initial, operation), false);
  assert.equal(deriveTileLockControl(initial, { lockOperation: operation }).statusLabel, 'Focus requested; awaiting confirmation');
  const newerInactive = { ...initial, realtimeObservedAt: observedAt + 1000 };
  assert.equal(tileFocusLifecycleObserved(newerInactive, operation), false, 'inactive telemetry alone cannot erase an accepted transient start');
  const active = { ...initial, screenLocked: true, realtimeObservedAt: observedAt + 2000 };
  assert.equal(tileFocusLifecycleObserved(active, operation), true);
  assert.equal(tileFocusLifecycleObserved(active, operation, false), false, 'stale monitoring is not convergence evidence');
  assert.equal(deriveTileLockControl(active, { lockOperation: operation }).statusLabel, 'Focus confirmed');
  assert.equal(deriveTileLockControl(active, { lockOperation: operation }).pending, false);
  assert.equal(tileFocusLifecycleObserved(active, { ...operation, outcomes: { focus: { status: 'received' } } }), false);
  const confirmed = { ...operation, awaitingFocusLifecycle: false, focusConfirmedObservedAt: observedAt + 2000 };
  assert.equal(deriveTileLockControl(initial, { lockOperation: confirmed }).locked, true, 'an older inactive row cannot undo observed Focus');
  assert.equal(deriveTileLockControl({ ...initial, realtimeObservedAt: observedAt + 3000 }, { lockOperation: confirmed }).locked, false);
});
test('a transient Stop needs fresh release telemetry and never clears a newer Focus', () => {
  const observedAt = Date.now() - 10_000;
  const operation = { action: 'stop-focus', focusControlRevision: 1, focusObservedAt: observedAt,
    outcomes: { focus: { status: 'completed', commandType: 'unlock-screen', commandId: 'exact-stop' } } };
  const inactive = student({ realtimeObservedAt: observedAt });
  assert.equal(deriveTileLockControl(inactive, { lockOperation: operation }).statusLabel, 'Stopping Focus; awaiting confirmation');
  assert.equal(deriveTileLockControl({ ...inactive, realtimeObservedAt: observedAt + 1000 }, { lockOperation: operation }).locked, false);
  const newerFocus = focused({ realtimeObservedAt: observedAt + 2000 });
  assert.equal(deriveTileLockControl(newerFocus, { lockOperation: operation }).statusLabel, 'Focus confirmed');
});
test('Bring Forward feedback keeps received pending until completed', () => {
  assert.match(tabActionFeedback({ targets: [{ status: 'received' }] }).title, /awaiting confirmation/);
  assert.match(tabActionFeedback({ targets: [{ status: 'completed' }] }).title, /device confirmation received/);
  assert.equal(tabActionFeedback({ targets: [{ status: 'failed' }] }).variant, 'destructive');
});
