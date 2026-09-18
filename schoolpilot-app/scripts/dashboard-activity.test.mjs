import assert from 'node:assert/strict';
import test from 'node:test';
import { activityAuthority, activityAuthorityKey, activityAuthorityQuery, activityParentPath, activityRequestHeaders,
  activityTransitionKey, normalizeDashboardActivity, resolveActivityView, matchesActivityAuthority } from '../src/products/classpilot/lib/dashboardActivity.js';
import { deriveDashboardCapabilities, resolveCommandTargets, normalizeSessionFabState,
  buildStudentSignOutCommandRequest, studentSupportsScheduledClassroom } from '../src/products/classpilot/lib/dashboardCommandContext.js';
import { createTileBatchRequests } from '../src/products/classpilot/lib/tileBatchPolling.js';
import { applyStudentRealtimeEvents } from '../src/products/classpilot/lib/studentRealtimeCache.js';

const current = { id: 'test', source: 'scheduled_testing', name: 'Reading MAP',
  status: 'active', authority: { supervisionContextId: 'test' }, studentCount: 23,
  startsAt: '2026-09-15T13:11:00Z', endsAt: '2026-09-15T13:15:00Z',
  capabilities: { commands: ['open-tab', 'timer', 'student-sign-out'], fab: true, liveView: true, settings: true } };
const dto = { enabled: true, schoolId: 'school', viewerId: 'teacher', current };

test('scheduled authority never becomes a teaching-session request and rejects ambiguous parents', () => {
  assert.deepEqual(activityAuthority(current), { supervisionContextId: 'test' });
  assert.equal(activityAuthority({ teachingSessionId: 'test', supervisionContextId: 'test' }), null);
  assert.equal(activityAuthorityQuery(current), 'supervisionContextId=test');
  assert.deepEqual(activityRequestHeaders('school', '0'), { 'X-School-Id': 'school', 'X-ClassPilot-Context-Authority-Revision': '0' });
  assert.equal(activityParentPath(current, 'settings'), '/classpilot/supervision-contexts/test/settings');
  assert.notEqual(activityAuthorityKey(current), activityAuthorityKey({ teachingSessionId: 'test' }));
  assert.equal(matchesActivityAuthority({ teachingSessionId: 'test' }, current), false);
  assert.equal(matchesActivityAuthority({ supervisionContextId: 'test' }, current), true);
});

test('clock expiry revokes old activity without inventing the next class or erasing offline roster counts', () => {
  const active = normalizeDashboardActivity(dto, 'school', 'teacher', Date.parse('2026-09-15T13:11:00Z'));
  assert.equal(active.current.studentCount, 23);
  const ended = normalizeDashboardActivity(dto, 'school', 'teacher', Date.parse(current.endsAt));
  assert.equal(ended.current, null);
  assert.equal(ended.pending, true);
  assert.notEqual(active.transitionKey, ended.transitionKey);
  assert.equal(normalizeDashboardActivity(dto, 'other', 'teacher'), null);
  assert.equal(normalizeDashboardActivity(dto, 'school', 'other'), null);
  assert.equal(normalizeDashboardActivity({ ...dto, current: { ...current, source: 'class', endsAt: null,
    authority: { teachingSessionId: 'manual' } } }, 'school', 'teacher', Date.parse('2026-09-16T13:00:00Z')).current.authority.teachingSessionId, 'manual');
});

test('a scheduled handoff resets a manual view once; extensions and roster refreshes do not', () => {
  const key = activityTransitionKey(current);
  const input = { scopeKey: 'school:teacher', scheduledEnabled: true, transitionKey: key, defaultView: 'class' };
  assert.equal(resolveActivityView({ ...input, selection: { scopeKey: input.scopeKey, transitionKey: 'previous', view: 'claimed' } }), 'class');
  const selection = { scopeKey: input.scopeKey, transitionKey: key, view: 'available' };
  assert.equal(resolveActivityView({ ...input, selection }), 'available');
  assert.equal(activityTransitionKey({ ...current, studentCount: 20, endsAt: '2026-09-15T14:00:00Z' }), key);
  const reassignedKey = activityTransitionKey({ ...current, contextAuthorityRevision: 'next-tenure' });
  assert.notEqual(reassignedKey, key);
  assert.equal(resolveActivityView({ ...input, selection, transitionKey: reassignedKey }), 'class');
  assert.equal(resolveActivityView({ ...input, selection, scopeKey: 'another-school:teacher' }), 'class');
});

test('scheduled full tools require server classification; manual and Observe keep their restrictions', () => {
  const input = { studentView: 'class', isTeacher: true, currentUserId: 'teacher', scheduledActivity: current };
  const caps = deriveDashboardCapabilities(input);
  assert.equal(caps.mode, 'scheduled-supervision');
  assert.equal(caps.canUseLiveView, true);
  assert.equal(caps.allows('timer'), true);
  assert.equal(deriveDashboardCapabilities({ ...input, scheduledActivity: { ...current, source: 'other' } }).canUseLiveView, false);
  assert.equal(deriveDashboardCapabilities({ ...input, isAdmin: true, observedSession: { id: 'observed', teacherId: 'other' } }).canUseLiveView, false);
});

test('scheduled commands and batches freeze explicit student IDs under their supervision authority', () => {
  const target = resolveCommandTargets({ mode: 'scheduled-supervision', sessionStudents: [{ studentId: 'a' }, { studentId: 'b' }], selectedStudentIds: ['a'] });
  assert.equal(target.targetScope, 'students'); assert.deepEqual(target.targetStudentIds, ['a']);
  assert.throws(() => resolveCommandTargets({ mode: 'scheduled-supervision', sessionStudents: [{ studentId: 'a' }], selectedStudentIds: ['missing'] }));
  assert.throws(() => resolveCommandTargets({ mode: 'scheduled-supervision', sessionStudents: [{ studentId: 'a' }], overrideStudentIds: [] }));
  const signOut = buildStudentSignOutCommandRequest(current, target);
  assert.equal(signOut.supervisionContextId, 'test'); assert.equal(Object.hasOwn(signOut, 'teachingSessionId'), false);
  const batches = createTileBatchRequests([{ studentId: 'a' }], current.authority);
  for (const batch of batches) { assert.equal(batch.body.supervisionContextId, 'test'); assert.equal(Object.hasOwn(batch.body, 'teachingSessionId'), false); }
});

test('scheduled FAB state and realtime events reject stale or differently typed authority', () => {
  assert.equal(normalizeSessionFabState({ teachingSessionId: 'test', revision: 1 }, current), null);
  assert.equal(normalizeSessionFabState({ supervisionContextId: 'test', revision: 2 }, current).revision, 2);
  const rows = [{ studentId: 'a', activeTabTitle: 'Original', realtimeBinding: 'b', realtimeRevision: 1 }];
  const event = { type: 'student-update', schoolId: 'school', studentId: 'a', supervisionContextId: 'other', activeTabTitle: 'Wrong assignment', realtimeBinding: 'b', realtimeRevision: 2 };
  assert.equal(applyStudentRealtimeEvents(rows, [event], { schoolId: 'school', supervisionContextId: 'test' }), rows);
});

test('full testing tools require accepted capabilities, not raw feature advertisements', () => {
  assert.equal(studentSupportsScheduledClassroom({ extensionCapabilities: ['scheduledClassroomV1', 'scopedAuthorityChecksV1'] }), false);
  assert.equal(studentSupportsScheduledClassroom({ capabilities: { scheduledClassroomV1: true, scopedAuthorityChecksV1: true } }), true);
  assert.equal(studentSupportsScheduledClassroom({ capabilities: { scheduledClassroomV1: true } }), false);
  // This is the shape the server actually sends (compat.ts publicClasspilotExtensionContract,
  // devices.ts publicRealtimeFields, classpilotCoverageHydration.ts): an object of
  // booleans, not an array. Before this was honoured every testing-block and claimed
  // tile read "not authorized" in production while the fixture-built array form passed.
  assert.equal(studentSupportsScheduledClassroom({ acceptedCapabilities: { scheduledClassroomV1: true, scopedAuthorityChecksV1: true } }), true);
  assert.equal(studentSupportsScheduledClassroom({ acceptedCapabilities: { scheduledClassroomV1: true, scopedAuthorityChecksV1: false } }), false);
  assert.equal(studentSupportsScheduledClassroom({ acceptedCapabilities: { scheduledClassroomV1: true } }), false);
  // A device that only advertises the capability still has not negotiated it.
  assert.equal(studentSupportsScheduledClassroom({ extensionCapabilities: ['scheduledClassroomV1', 'scopedAuthorityChecksV1'], acceptedCapabilities: {} }), false);
  assert.equal(normalizeSessionFabState({ supervisionContextId: 'test', lifecycleRevision: 3, raiseHandEnabled: false, chatEnabled: false }, current).messagingEnabled, false);
});
