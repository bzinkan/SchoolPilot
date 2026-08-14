import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyStudentRealtimeEvents,
  coalesceStudentRealtimeEvents,
  makeAggregatedStudentsQueryKey,
  mergeAggregatedStudents,
} from '../src/products/classpilot/lib/studentRealtimeCache.js';

const base = () => [{
  studentId: 'student-1',
  primaryDeviceId: 'device-1',
  status: 'online',
  activeTabUrl: 'https://example.test/old',
  realtimeBinding: 'binding-a',
  realtimeRevision: 3,
  realtimeObservedAt: '2026-08-13T12:00:00.000Z',
}];

test('scopes query keys by school and effective session', () => {
  assert.deepEqual(makeAggregatedStudentsQueryKey('school-1', 'session-1'), [
    '/api/students-aggregated', 'school-1', 'session-1',
  ]);
  assert.notDeepEqual(
    makeAggregatedStudentsQueryKey('school-1', 'session-1'),
    makeAggregatedStudentsQueryKey('school-2', 'session-1'),
  );
});

test('applies an allowed higher-revision update without appending students', () => {
  const result = applyStudentRealtimeEvents(base(), [{
    type: 'student-update',
    schoolId: 'school-1',
    studentId: 'student-1',
    deviceId: 'device-1',
    revision: 4,
    observedAtMs: Date.parse('2026-08-13T12:00:10.000Z'),
    activeTabUrl: 'https://example.test/new',
    status: 'tracking-disabled',
  }, {
    type: 'student-update',
    schoolId: 'school-1',
    studentId: 'unauthorized-student',
    deviceId: 'other-device',
    revision: 10,
  }], { schoolId: 'school-1' });

  assert.equal(result.length, 1);
  assert.equal(result[0].activeTabUrl, 'https://example.test/new');
  assert.equal(result[0].status, 'online', 'legacy tracking status must not overwrite aggregate status');
  assert.equal(result[0].realtimeRevision, 4);
});

test('rejects wrong-school, wrong-device, and stale events', () => {
  const original = base();
  const events = [
    { type: 'student-update', schoolId: 'school-2', studentId: 'student-1', deviceId: 'device-1', revision: 9 },
    { type: 'student-update', schoolId: 'school-1', studentId: 'student-1', deviceId: 'device-2', revision: 9 },
    { type: 'student-update', schoolId: 'school-1', studentId: 'student-1', deviceId: 'device-1', revision: 2 },
  ];
  assert.equal(applyStudentRealtimeEvents(original, events, { schoolId: 'school-1' }), original);
});

test('rejects a classification for a page that is no longer active', () => {
  const original = base();
  const result = applyStudentRealtimeEvents(original, [{
    type: 'ai-classification',
    schoolId: 'school-1',
    studentId: 'student-1',
    deviceId: 'device-1',
    revision: 4,
    activeTabUrl: 'https://example.test/different',
    classification: { category: 'non-educational' },
  }], { schoolId: 'school-1' });
  assert.equal(result, original);
});

test('a higher-revision heartbeat is authoritative for observed classroom controls', () => {
  const original = [{
    ...base()[0],
    screenLocked: true,
    flightPathActive: true,
    activeFlightPathName: 'Old path',
  }];
  const result = applyStudentRealtimeEvents(original, [{
    type: 'student-update',
    schoolId: 'school-1',
    studentId: 'student-1',
    deviceId: 'device-1',
    revision: 4,
    screenLocked: false,
    flightPathActive: false,
    activeFlightPathName: null,
    activeTabTitle: 'Fresh title',
  }], { schoolId: 'school-1' });
  assert.equal(result[0].screenLocked, false);
  assert.equal(result[0].flightPathActive, false);
  assert.equal(result[0].activeFlightPathName, null);
  assert.equal(result[0].activeTabTitle, 'Fresh title');
});

test('clears a prior page classification while the newer heartbeat is pending', () => {
  const original = [{
    ...base()[0],
    aiClassification: { category: 'non-educational' },
    aiCategory: 'non-educational',
  }];
  const result = applyStudentRealtimeEvents(original, [{
    type: 'student-update', schoolId: 'school-1', studentId: 'student-1', deviceId: 'device-1', revision: 4,
    activeTabUrl: 'https://example.test/new', classificationPending: true,
  }], { schoolId: 'school-1' });
  assert.equal(result[0].aiClassification, null);
  assert.equal(result[0].aiCategory, null);
});

test('sign-out wins over a queued active event until HTTP reconciliation', () => {
  const signedOut = applyStudentRealtimeEvents(base(), [{
    type: 'student-signed-out', schoolId: 'school-1', studentId: 'student-1', deviceId: 'device-1', revision: 4,
  }], { schoolId: 'school-1' });
  const late = applyStudentRealtimeEvents(signedOut, [{
    type: 'student-update', schoolId: 'school-1', studentId: 'student-1', deviceId: 'device-1', revision: 5,
  }], { schoolId: 'school-1' });
  assert.equal(late, signedOut);
  assert.equal(late[0].loginState, 'not_logged_in');
});

test('coalesces a burst to the highest revision per student and event type', () => {
  const result = coalesceStudentRealtimeEvents([
    { type: 'student-update', studentId: 'student-1', revision: 2 },
    { type: 'student-update', studentId: 'student-1', revision: 4 },
    { type: 'ai-classification', studentId: 'student-1', revision: 3 },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result.find((event) => event.type === 'student-update').revision, 4);
});

test('a new public binding resets prior telemetry and accepts a lower revision', () => {
  const original = [{
    ...base()[0],
    realtimeRevision: 99,
    aiClassification: { category: 'non-educational' },
    aiCategory: 'non-educational',
    allOpenTabs: [{ url: 'https://old.example', title: 'Old tab' }],
  }];
  const switched = applyStudentRealtimeEvents(original, [{
    type: 'student-update',
    eventVersion: 2,
    schoolId: 'school-1',
    studentId: 'student-1',
    realtimeBinding: 'binding-b',
    revision: 1,
    activeTabUrl: 'https://new.example',
    activeTabTitle: 'New session',
  }], { schoolId: 'school-1' });

  assert.equal(switched[0].realtimeBinding, 'binding-b');
  assert.equal(switched[0].realtimeRevision, 1);
  assert.equal(switched[0].activeTabUrl, 'https://new.example');
  assert.equal(switched[0].aiClassification, null);
  assert.deepEqual(switched[0].allOpenTabs, []);

  const delayedOldBinding = applyStudentRealtimeEvents(switched, [{
    type: 'student-update',
    eventVersion: 2,
    schoolId: 'school-1',
    studentId: 'student-1',
    realtimeBinding: 'binding-a',
    revision: 100,
    activeTabUrl: 'https://stale.example',
  }], { schoolId: 'school-1' });
  assert.equal(delayedOldBinding, switched);
});

test('rejects a v2 message with no public binding', () => {
  const original = base();
  const result = applyStudentRealtimeEvents(original, [{
    type: 'student-update',
    eventVersion: 2,
    schoolId: 'school-1',
    studentId: 'student-1',
    revision: 4,
    activeTabUrl: 'https://malformed.example',
  }], { schoolId: 'school-1' });
  assert.equal(result, original);
});

test('the first v2 binding clears a legacy signed-out latch', () => {
  const legacySignedOut = [{
    ...base()[0],
    realtimeBinding: null,
    _realtimeSignedOut: true,
    loginState: 'not_logged_in',
    isLoggedIn: false,
  }];
  const result = applyStudentRealtimeEvents(legacySignedOut, [{
    type: 'student-update',
    eventVersion: 2,
    schoolId: 'school-1',
    studentId: 'student-1',
    realtimeBinding: 'binding-b',
    revision: 1,
    activeTabUrl: 'https://new-login.example',
  }], { schoolId: 'school-1' });
  assert.equal(result[0]._realtimeSignedOut, false);
  assert.equal(result[0].loginState, 'logged_in');
  assert.equal(result[0].activeTabUrl, 'https://new-login.example');
});

test('coalescing keeps messages from distinct bindings so switch order is enforced', () => {
  const result = coalesceStudentRealtimeEvents([
    { type: 'student-update', studentId: 'student-1', realtimeBinding: 'binding-a', revision: 100 },
    { type: 'student-update', studentId: 'student-1', realtimeBinding: 'binding-b', revision: 1 },
  ]);
  assert.equal(result.length, 2);
});

test('a stale HTTP response cannot replace newer websocket state', () => {
  const oldData = [{
    ...base()[0],
    realtimeRevision: 8,
    activeTabUrl: 'https://example.test/socket',
    monitoringState: 'observed',
    status: 'online',
    loginState: 'logged_in',
    isLoggedIn: true,
    lastSeenAt: '2026-08-13T12:01:00.000Z',
  }];
  const serverData = [{
    ...base()[0],
    realtimeRevision: 7,
    activeTabUrl: 'https://example.test/http',
    status: 'offline',
    loginState: 'not_logged_in',
    isLoggedIn: false,
    lastSeenAt: '2026-08-13T11:59:00.000Z',
    studentName: 'Updated Name',
  }];
  const merged = mergeAggregatedStudents(oldData, serverData);
  assert.equal(merged[0].activeTabUrl, 'https://example.test/socket');
  assert.equal(merged[0].studentName, 'Updated Name');
  assert.equal(merged[0].realtimeRevision, 8);
  assert.equal(merged[0].status, 'online');
  assert.equal(merged[0].loginState, 'logged_in');
  assert.equal(merged[0].isLoggedIn, true);
  assert.equal(merged[0].lastSeenAt, '2026-08-13T12:01:00.000Z');
});

test('an unchanged or empty HTTP reconciliation preserves the cached reference', () => {
  const empty = [];
  assert.equal(mergeAggregatedStudents(empty, []), empty);

  const row = {
    studentId: 'student-1',
    status: 'online',
    realtimeBinding: 'binding-1',
    realtimeRevision: 4,
  };
  const cached = [row];
  assert.equal(mergeAggregatedStudents(cached, [{ ...row }]), cached);
});

test('a binding change makes the server response authoritative', () => {
  const serverData = [{ ...base()[0], realtimeBinding: 'binding-b', realtimeRevision: 1 }];
  const merged = mergeAggregatedStudents(base(), serverData);
  assert.equal(merged[0].realtimeBinding, 'binding-b');
  assert.equal(merged[0].realtimeRevision, 1);
});

test('an in-flight HTTP response for a retired binding cannot undo a websocket switch', () => {
  const switched = applyStudentRealtimeEvents(base(), [{
    type: 'student-update',
    eventVersion: 2,
    schoolId: 'school-1',
    studentId: 'student-1',
    realtimeBinding: 'binding-b',
    revision: 1,
    activeTabUrl: 'https://socket.example',
  }], { schoolId: 'school-1' });
  const staleServer = [{
    ...base()[0],
    realtimeBinding: 'binding-a',
    realtimeRevision: 100,
    activeTabUrl: 'https://stale-http.example',
    studentName: 'Updated Name',
  }];
  const merged = mergeAggregatedStudents(switched, staleServer);
  assert.equal(merged[0].realtimeBinding, 'binding-b');
  assert.equal(merged[0].realtimeRevision, 1);
  assert.equal(merged[0].activeTabUrl, 'https://socket.example');
  assert.equal(merged[0].studentName, 'Updated Name');
});

test('delegated aggregate state suppresses sockets until REST explicitly clears it', () => {
  const delegated = mergeAggregatedStudents(base(), [{
    ...base()[0],
    realtimeBinding: null,
    realtimeRevision: null,
    activeTabUrl: '',
    activityState: 'delegated',
    monitoringState: 'not_expected',
  }]);
  assert.equal(delegated[0]._realtimeSuppressed, true);
  assert.equal(delegated[0].activeTabUrl, '');

  const leaked = applyStudentRealtimeEvents(delegated, [{
    type: 'student-update',
    eventVersion: 2,
    schoolId: 'school-1',
    studentId: 'student-1',
    realtimeBinding: 'binding-a',
    revision: 100,
    activeTabUrl: 'https://delegated-private.example',
  }], { schoolId: 'school-1' });
  assert.equal(leaked, delegated);

  const returned = mergeAggregatedStudents(delegated, [{
    ...base()[0],
    realtimeRevision: 101,
    activeTabUrl: 'https://returned.example',
    activityState: 'active',
    monitoringState: 'healthy',
  }]);
  assert.equal(returned[0]._realtimeSuppressed, undefined);
  assert.equal(returned[0].activeTabUrl, 'https://returned.example');
});
