import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classpilotObservationSessionEligible,
  classpilotSessionAuthorityKey,
  clearTileReadDenials,
  createCoalescedClasspilotRefresh,
  deniedTileStudentIds,
  isClasspilotSessionUnavailable,
  recordTileReadDenial,
  tileReadAuthorityMap,
  tileRequestWithoutDeniedStudents,
} from '../src/products/classpilot/lib/classpilotReadRecovery.js';

const liveSession = { id: 'class-a', sessionMode: 'live', endTime: null, rosterSnapshotCompletedAt: '2026-09-04T12:00:00Z' };
const student = (id, binding = 'binding-a') => ({ studentId: id, realtimeBinding: binding, isLoggedIn: true, classroomState: { revision: 1 } });
const request = { kind: 'screenshots', body: { studentIds: ['a', 'b'], teachingSessionId: 'class-a' } };

test('scheduled active metadata is not observation authority; missing readiness fails private', () => {
  assert.equal(classpilotObservationSessionEligible(liveSession), true);
  for (const session of [null, {}, { ...liveSession, sessionMode: 'report_only', scheduledState: 'active' },
    { ...liveSession, endTime: '2026-09-04T13:00Z' }, { ...liveSession, rosterSnapshotCompletedAt: null }]) {
    assert.equal(classpilotObservationSessionEligible(session), false);
  }
});

test('only a session-scoped missing-session response terminates aggregate reconciliation', () => {
  const response = (status, code) => ({ response: { status, data: { code } } });
  assert.equal(isClasspilotSessionUnavailable(response(404), 'class-a'), true);
  assert.equal(isClasspilotSessionUnavailable(response(404, 'CLASSPILOT_SESSION_UNAVAILABLE'), 'class-a'), true);
  assert.equal(isClasspilotSessionUnavailable(response(404), null), false);
  for (const status of [408, 429, 500, 503]) assert.equal(isClasspilotSessionUnavailable(response(status), 'class-a'), false);
  assert.equal(isClasspilotSessionUnavailable(new Error('offline'), 'class-a'), false);
});

test('denial remains private across cache success, focus, view return and unrelated student changes', () => {
  const denials = new Set();
  const original = tileReadAuthorityMap('school:viewer:class', [student('a'), student('b')]);
  recordTileReadDenial(denials, 'screenshots', original, ['a']);
  // Neither cache state nor observation visibility is part of an authority.
  const refreshed = tileReadAuthorityMap('school:viewer:class', [
    { ...student('a'), realtimeObservedAt: 'later', status: 'online' }, student('b', 'new-binding'),
  ]);
  assert.deepEqual([...deniedTileStudentIds(denials, 'screenshots', refreshed)], ['a']);
  assert.deepEqual(tileRequestWithoutDeniedStudents(request, denials, refreshed).body.studentIds, ['b']);
  assert.deepEqual([...deniedTileStudentIds(denials, 'history', refreshed)], []);
  const ownNewBinding = tileReadAuthorityMap('school:viewer:class', [student('a', 'new-binding'), student('b')]);
  assert.deepEqual([...deniedTileStudentIds(denials, 'screenshots', ownNewBinding)], []);
  assert.deepEqual([...deniedTileStudentIds(denials, 'screenshots', tileReadAuthorityMap('school:other:class', [student('a')]))], []);
});

test('whole-cohort denial produces no request targets; checked retry clears only exact visible authority', () => {
  const denials = new Set();
  const current = tileReadAuthorityMap('school:viewer:class', [student('a'), student('b')]);
  const other = tileReadAuthorityMap('school:viewer:other-class', [student('a')]);
  recordTileReadDenial(denials, 'screenshots', current, ['a', 'b']);
  recordTileReadDenial(denials, 'screenshots', other, ['a']);
  assert.deepEqual(tileRequestWithoutDeniedStudents(request, denials, current).body.studentIds, []);
  clearTileReadDenials(denials, 'screenshots', current);
  assert.deepEqual(tileRequestWithoutDeniedStudents(request, denials, current).body.studentIds, ['a', 'b']);
  assert.deepEqual([...deniedTileStudentIds(denials, 'screenshots', other)], ['a']);
});

test('late denial for an old binding cannot revoke a replacement binding', () => {
  const denials = new Set();
  const before = tileReadAuthorityMap('school:viewer:class', [student('a')]);
  const after = tileReadAuthorityMap('school:viewer:class', [student('a', 'replacement')]);
  recordTileReadDenial(denials, 'screenshots', before, ['a']);
  assert.deepEqual([...deniedTileStudentIds(denials, 'screenshots', after)], []);
  assert.notEqual(classpilotSessionAuthorityKey({ schoolId: 's', viewerId: 'v', session: liveSession }),
    classpilotSessionAuthorityKey({ schoolId: 's', viewerId: 'other', session: liveSession }));
});

test('overlapping lifecycle events share work without swallowing a subsequent authority refresh', async () => {
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const refresh = createCoalescedClasspilotRefresh();
  const work = async () => { requests += 1; await gate; return 'fresh'; };
  const focus = refresh('class-a', work);
  const online = refresh('class-a', work);
  const visible = refresh('class-a', work);
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.equal(focus, online);
  assert.equal(focus, visible);
  release();
  await focus;
  await refresh('class-a', work);
  assert.equal(requests, 2);
  await refresh('class-a', work);
  assert.equal(requests, 3);
  await refresh('class-b', work);
  assert.equal(requests, 4);
  await refresh('class-a', work);
  assert.equal(requests, 5);
});
