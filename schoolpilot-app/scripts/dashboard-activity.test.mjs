import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { activityAuthority, activityAuthorityKey, activityAuthorityQuery, activityParentPath, activityRequestHeaders,
  activityTransitionKey, normalizeDashboardActivity, resolveActivityView, matchesActivityAuthority, matchesCommandUpdateActivity, activityPurposeLabel, activityTitle, activityEndLabel, activityEndRequest, normalizeObservableActivities } from '../src/products/classpilot/lib/dashboardActivity.js';
import { deriveDashboardCapabilities, resolveCommandTargets, normalizeSessionFabState,
  buildStudentSignOutCommandRequest, studentSupportsScheduledClassroom } from '../src/products/classpilot/lib/dashboardCommandContext.js';
import { createTileBatchRequests } from '../src/products/classpilot/lib/tileBatchPolling.js';
import { applyStudentRealtimeEvents } from '../src/products/classpilot/lib/studentRealtimeCache.js';
import { applyTransientCommandUpdate, hasPendingTransientAction, latestTransientClassroomUiEffect,
  trackTransientCommandResponse } from '../src/products/classpilot/lib/commandDeliveryTruth.js';

const current = { id: 'test', source: 'scheduled_testing', name: 'Reading MAP',
  status: 'active', authority: { supervisionContextId: 'test' }, studentCount: 23,
  startsAt: '2026-09-15T13:11:00Z', endsAt: '2026-09-15T13:15:00Z',
  capabilities: { commands: ['open-tab', 'timer', 'student-sign-out'], fab: true, liveView: true, settings: true } };
const dto = { enabled: true, schoolId: 'school', viewerId: 'teacher', current };
const room = { ...current, id: 'room', name: 'My room', teacherId: 'teacher', contextType: 'temporary_room',
  staffIds: ['teacher'], capabilities: { ...current.capabilities, screenshots: true },
  source: 'ad_hoc_supervision', purpose: 'claim', contextAuthorityRevision: '8',
  authority: { supervisionContextId: 'room' }, startsAt: '2026-09-15T13:00:00Z', endsAt: '2026-09-15T16:00:00Z' };

test('a room defaults across reload and bells while explicit Class and Observe workspace choices remain respected', () => {
  const input = { scopeKey: 'school:teacher', transitionKey: 'class-one', scheduledEnabled: true, defaultView: 'class', room };
  assert.equal(resolveActivityView(input), 'claimed');
  const selectedRoom = { scopeKey: input.scopeKey, view: 'claimed', roomId: room.id, transitionKey: input.transitionKey };
  assert.equal(resolveActivityView({ ...input, transitionKey: 'next-bell', selection: selectedRoom }), 'claimed');
  assert.equal(resolveActivityView({ ...input, transitionKey: 'next-bell', selection: { ...selectedRoom, view: 'class' } }), 'class');
  assert.equal(resolveActivityView({ ...input, transitionKey: 'next-bell', selection: { ...selectedRoom, view: 'available' } }), 'available');
  assert.equal(resolveActivityView({ ...input, room: null, selection: selectedRoom }), 'class', 'An ended room cannot keep the room view selected');
  assert.equal(resolveActivityView({ ...input, room: { ...room, id: 'replacement' }, selection: { ...selectedRoom, view: 'class' } }), 'claimed');
});

test('room validation and expiration are independent from the normal current class', () => {
  const active = normalizeDashboardActivity({ ...dto, room }, 'school', 'teacher', Date.parse('2026-09-15T13:16:00Z'));
  assert.equal(active.current, null);
  assert.equal(active.room.id, 'room');
  assert.equal(normalizeDashboardActivity({ ...dto, room }, 'school', 'teacher', Date.parse(room.endsAt)).room, null);
  assert.throws(() => normalizeDashboardActivity({ ...dto, room: { ...room, teacherId: 'other' } }, 'school', 'teacher'), /room response/);
  assert.throws(() => normalizeDashboardActivity({ ...dto, room: { ...room, contextAuthorityRevision: undefined } }, 'school', 'teacher'), /room response/);
});

test('My room full tools use its exact server capabilities and cannot acquire authority through Observe', () => {
  const input = { studentView: 'claimed', isTeacher: true, currentUserId: 'teacher', roomActivity: room, scheduledActivity: current };
  const caps = deriveDashboardCapabilities(input);
  assert.equal(caps.canUseTeacherFab, true);
  assert.equal(caps.canUseLiveView, true);
  assert.equal(caps.canChangeFabSettings, true);
  assert.equal(caps.allows('timer'), true);
  assert.deepEqual(caps.authority, { supervisionContextId: 'room' });
  assert.equal(deriveDashboardCapabilities({ ...input, roomActivity: { ...room, capabilities: { commands: [] } } }).canUseTeacherFab, false);
  const observed = deriveDashboardCapabilities({ ...input, isAdmin: true, observedSession: { ...room, accessMode: 'observe' } });
  assert.equal(observed.canUseTeacherFab, false);
  assert.equal(observed.canUseRemoteControls, false);
  assert.equal(activityPurposeLabel(room), 'My room');
  assert.equal(activityTitle(room), 'My room');
  assert.equal(activityTitle({ ...room, name: 'Mixed grades' }), 'My room: Mixed grades');
  assert.equal(activityEndLabel(room), 'End room');
});

test('End room freezes the complete exact roster and rejects empty or stale confirmations', () => {
  const target = { ...room, expectedStudentIds: ['grade-3', 'grade-4', 'grade-5'] };
  assert.deepEqual(activityEndRequest(target, ['grade-5', 'grade-4', 'grade-3']), {
    studentIds: [], releaseReason: 'returned_to_class', expectedStudentIds: target.expectedStudentIds,
  });
  assert.throws(() => activityEndRequest({ ...target, expectedStudentIds: [] }, []), /roster is unavailable/);
  assert.throws(() => activityEndRequest(target, [...target.expectedStudentIds, 'new-student']), /roster changed/);
  assert.throws(() => activityEndRequest(target, ['grade-3', 'grade-4']), /roster changed/);
  assert.deepEqual(activityEndRequest(current, []), { studentIds: [], releaseReason: 'returned_to_class' });
});

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

function roomCommandUpdate(overrides = {}) {
  return { type: 'classpilot-command-update', commandId: 'room-poll',
    command: { id: 'room-poll', schoolId: 'school', supervisionContextId: 'room', commandType: 'poll',
      commandPayload: { action: 'start', pollId: 'poll', question: 'Ready?', options: ['Yes', 'No'] },
      targets: [{ studentId: 'student', status: 'received', result: { scheduledContextAuthorityRevision: '8' } }],
      ...overrides },
    summary: { requested: 1, attempted: 1, acknowledged: 1, received: 1, awaitingAck: 0 } };
}

test('late room ACKs cannot repopulate a replacement room or coverage workspace', () => {
  const oldAck = roomCommandUpdate();
  const scopes = [
    { authority: { supervisionContextId: 'replacement' }, contextAuthorityRevision: '0' },
    { authority: { supervisionContextId: 'coverage' }, contextAuthorityRevision: '4' },
    { authority: room.authority, contextAuthorityRevision: '9' },
    { authority: { teachingSessionId: 'class' } },
  ];
  for (const scope of scopes) {
    let tracked = new Map(); // A workspace switch clears the previous outcomes.
    if (matchesCommandUpdateActivity(oldAck, { schoolId: 'school', ...scope })) {
      tracked = applyTransientCommandUpdate(trackTransientCommandResponse(tracked, oldAck, 'poll'), oldAck);
    }
    assert.equal(tracked.size, 0, 'the old unknown command is refused before tracking');
    assert.equal(latestTransientClassroomUiEffect(tracked, 'poll'), null);
    assert.equal(hasPendingTransientAction(tracked, 'poll'), false);
  }
  const accepted = matchesCommandUpdateActivity(oldAck, {
    schoolId: 'school', authority: room.authority, contextAuthorityRevision: '8',
  });
  assert.equal(accepted, true, 'a current-room ACK may arrive before its HTTP response');
  const tracked = applyTransientCommandUpdate(trackTransientCommandResponse(new Map(), oldAck, 'poll'), oldAck);
  assert.equal(latestTransientClassroomUiEffect(tracked, 'poll')?.poll?.id, 'poll');
});

test('room command ACKs require an unambiguous frozen tenure and exact parent', () => {
  const scope = { schoolId: 'school', authority: room.authority, contextAuthorityRevision: '8' };
  const matches = overrides => matchesCommandUpdateActivity(roomCommandUpdate(overrides), scope);
  assert.equal(matches({ teachingSessionId: 'room' }), false, 'two parent kinds are ambiguous');
  assert.equal(matches({ schoolId: 'another-school' }), false);
  assert.equal(matches({ targets: [{ studentId: 'student', status: 'received' }] }), false);
  assert.equal(matchesCommandUpdateActivity(roomCommandUpdate({ targets: [{ studentId: 'student', status: 'received' }] }),
    { ...scope, knownCommand: true }), false, 'known timer/poll IDs still require their frozen tenure');
  assert.equal(matches({ contextAuthorityRevision: null }), false);
  assert.equal(matches({ contextAuthorityRevision: '08' }), false);
  assert.equal(matches({ contextAuthorityRevision: '9' }), false, 'conflicting envelope and frozen target revisions are refused');
  assert.equal(matches({ targets: [
    { studentId: 'student', status: 'received', result: { scheduledContextAuthorityRevision: '8' } },
    { studentId: 'other', status: 'received', result: { scheduledContextAuthorityRevision: '7' } },
  ] }), false);
  assert.equal(matches({ targets: [
    { studentId: 'student', status: 'received', result: { scheduledContextAuthorityRevision: '8' } },
    { studentId: 'other', status: 'received' },
  ] }), false, 'one valid target cannot authorize an unversioned acknowledged target');
  assert.equal(matches({ targets: [
    { studentId: 'student', status: 'received', result: { scheduledContextAuthorityRevision: '8' } },
    { studentId: 'offline', status: 'unavailable' },
  ] }), true, 'unavailable targets need not have frozen authority metadata');
  const unversioned = roomCommandUpdate({ commandType: 'lock-screen', commandPayload: { currentPage: true },
    targets: [{ studentId: 'student', status: 'received' }] });
  assert.equal(matchesCommandUpdateActivity(unversioned, scope), false, 'an old unversioned unknown command cannot enter the room');
  assert.equal(matchesCommandUpdateActivity(unversioned, { ...scope, knownCommand: true }), true,
    'an HTTP response already tracked in this exact scope may finish without a tenure field the server never supplies');
  assert.equal(matchesCommandUpdateActivity(roomCommandUpdate({ commandType: 'stop-focus',
    targets: [{ studentId: 'student', status: 'completed' }] }), { ...scope, knownCommand: true }), true,
    'the current exact Stop Focus HTTP command can receive status without a tenure field');
});

test('teaching aliases and current owned legacy coverage command statuses remain scoped', () => {
  const classScope = { schoolId: 'school', authority: { teachingSessionId: 'class' } };
  const teaching = { command: { schoolId: 'school', teachingSessionId: 'class', commandType: 'timer' } };
  assert.equal(matchesCommandUpdateActivity(teaching, classScope), true);
  assert.equal(matchesCommandUpdateActivity({ command: { sessionId: 'class' } }, classScope), true);
  assert.equal(matchesCommandUpdateActivity({ command: { teachingSessionId: 'other' } }, classScope), false);
  assert.equal(matchesCommandUpdateActivity({ command: {} }, classScope), false);
  assert.equal(matchesCommandUpdateActivity({ command: {} }, { ...classScope, knownCommand: true }), true);
  const legacy = roomCommandUpdate({ supervisionContextId: 'legacy', commandType: 'focus-tab',
    targets: [{ studentId: 'student', status: 'received' }] });
  const legacyScope = { ...classScope, knownCommand: true, legacyCoverageStudents: [
    { studentId: 'student', contextId: 'legacy', contextAuthorityRevision: '3' },
  ] };
  assert.equal(matchesCommandUpdateActivity(legacy, legacyScope), true);
  assert.equal(matchesCommandUpdateActivity(legacy, { ...legacyScope, knownCommand: false }), false,
    'an unversioned legacy ACK must belong to an HTTP command in the current exact scope');
  assert.equal(matchesCommandUpdateActivity(legacy, { ...legacyScope, authority: room.authority, contextAuthorityRevision: '8' }), false,
    'a room never falls back to another owned legacy coverage context');
  assert.equal(matchesCommandUpdateActivity(roomCommandUpdate({ ...legacy.command,
    targets: [{ studentId: 'student', status: 'received', result: { scheduledContextAuthorityRevision: '3' } }] }),
  { ...legacyScope, authority: room.authority, contextAuthorityRevision: '3' }), false,
  'even matching revisions and known owned coverage commands cannot cross a supervision parent boundary');
  assert.equal(matchesCommandUpdateActivity(legacy, classScope), false);
  assert.equal(matchesCommandUpdateActivity(roomCommandUpdate({ ...legacy.command,
    targets: [...legacy.command.targets, { studentId: 'not-owned', status: 'received' }] }), legacyScope), false);
  assert.equal(matchesCommandUpdateActivity(roomCommandUpdate({ ...legacy.command, commandType: 'poll' }), legacyScope), false,
    'legacy coverage cannot introduce a classroom poll into the active workspace');
});

test('Dashboard fences command updates before focus or transient state changes', () => {
  const source = readFileSync(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("if (message.type === 'classpilot-command-update')"));
  const fence = handler.indexOf('if (!matchesCommandUpdateActivity(message,');
  assert.ok(fence >= 0);
  assert.ok(fence < handler.indexOf('focusCommandUpdatesRef.current'));
  assert.ok(fence < handler.indexOf('setLastFocusResult'));
  assert.ok(fence < handler.indexOf('trackTransientCommandResponse('));
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*knownClassroomCommandIdsRef\.current\.clear\(\);\s*transientCommandOutcomesRef\.current = new Map\(\);/);
  assert.match(source, /knownCommand: knownClassroomCommandIdsRef\.current\.has\(commandId\)/);
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


test('purpose labels never infer testing from group names and explicit Observe always stays read-only', () => {
  const claim = { ...current, source: 'ad_hoc_supervision', purpose: 'claim', name: 'MAP testing group' };
  assert.equal(activityPurposeLabel(claim), 'Claimed students');
  assert.equal(activityEndLabel(claim), 'Release all');
  assert.equal(activityPurposeLabel({ ...claim, purpose: 'coverage' }), 'Coverage');
  assert.equal(activityEndLabel({ ...claim, purpose: 'coverage' }), 'End coverage');
  const [observed] = normalizeObservableActivities({ activities: [{ ...claim,
    authority: { supervisionContextId: 'test', contextAuthorityRevision: '4' },
    owner: { id: 'admin', name: 'Admin' }, capabilities: { observe: true, screenshots: true } }] });
  assert.equal(observed.contextAuthorityRevision, '4');
  const capabilities = deriveDashboardCapabilities({ studentView: 'class', isAdmin: true, currentUserId: 'admin', observedSession: observed });
  assert.equal(capabilities.observedOtherClass, true);
  assert.equal(capabilities.canUseRemoteControls, false);
  assert.equal(capabilities.canUseTeacherFab, false);
  assert.deepEqual(capabilities.authority, { supervisionContextId: 'test' });
  assert.deepEqual(normalizeObservableActivities({ activities: [{ ...claim, capabilities: { observe: true } }] }), [], 'No supervision revision means no observable authority');
});
