import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROSTER_MARK,
  answerableConversations,
  broadcastButtonLabel,
  buildMessagingRoster,
  describeRosterPresence,
  enterTarget,
  filterRoster,
  longestWaitingUnreadId,
  needReplyLabel,
  readOnlyReplyNote,
  splitOffRoster,
} from '../src/products/classpilot/lib/chatRoster.js';
import { compareStudentsByLastName } from '../src/products/classpilot/lib/studentOrder.js';
import { deriveChatConversations } from '../src/products/classpilot/lib/chatThreads.js';
import { SELECTION_CLEARED_TARGET_LABEL, signOutOnlySelectionLabel } from '../src/products/classpilot/lib/dashboardCommandContext.js';

const ON = { kind: 'online', telemetryCurrent: true };
const IDLE = { kind: 'idle', telemetryCurrent: true };
const STALE = { kind: 'updates_unavailable', telemetryCurrent: false };
const SIGNED_OUT = { kind: 'signed_out', telemetryCurrent: false };

test('roster presence: with {staff} > on now > absent > not signed in > not reporting', () => {
  assert.deepEqual(
    describeRosterPresence({ monitoring: ON, absent: true, coveredByStaffName: 'Morgan Monitor', isLoggedIn: true }),
    { mark: 'diamond', word: 'With Morgan Monitor', srStatus: 'With Morgan Monitor', canMessage: false },
    'a student supervised elsewhere is read-only, whatever their device reports',
  );
  assert.equal(describeRosterPresence({ coveredByStaffName: '  ' }).word, 'With another teacher', 'an unknown supervisor still reads as a person');
  assert.deepEqual(
    describeRosterPresence({ monitoring: ON, absent: true }),
    { mark: 'dot', word: '', srStatus: 'On now', canMessage: true },
    'a student marked absent whose device reports is on now',
  );
  assert.equal(describeRosterPresence({ monitoring: IDLE }).srStatus, 'On now', 'an idle device is still reporting');
  assert.deepEqual(
    describeRosterPresence({ monitoring: SIGNED_OUT, absent: true, isLoggedIn: false }),
    { mark: 'cross', word: 'Absent', srStatus: 'Absent', canMessage: true },
  );
  assert.deepEqual(
    describeRosterPresence({ monitoring: SIGNED_OUT }),
    { mark: 'dash', word: 'Not signed in', srStatus: 'Not signed in', canMessage: true },
  );
  assert.equal(describeRosterPresence({ monitoring: STALE, isLoggedIn: false }).word, 'Not signed in', 'the roster row alone can say signed out');
  assert.deepEqual(
    describeRosterPresence({ monitoring: STALE }),
    { mark: 'ring', word: '', srStatus: 'Not reporting', canMessage: true },
  );
  assert.deepEqual(describeRosterPresence(), { mark: 'ring', word: '', srStatus: 'Not reporting', canMessage: true });
  assert.equal(describeRosterPresence({ coveredByStaffName: null, monitoring: ON }).canMessage, true, 'null means not supervised elsewhere');
  // Five states, five shapes: presence never depends on colour alone.
  assert.equal(new Set(Object.values(ROSTER_MARK)).size, 5);
});

test('the roster is the whole class in the grid order, one primitive row per student', () => {
  const students = [
    { studentId: 'cy', studentName: 'Cy Zed', isLoggedIn: true },
    { studentId: 'ada', studentName: 'Ada Student', isLoggedIn: true },
    { studentId: 'ben', studentName: 'Ben Adams', isLoggedIn: false },
    { studentId: 'ann', studentName: 'Ann Student', isLoggedIn: true },
    { studentId: 'ada', studentName: 'Ada Student', isLoggedIn: false },
    { studentId: '', studentName: 'No id' },
    { studentId: 'nameless', firstName: 'Dee', lastName: 'Vance' },
  ];
  const { conversations } = deriveChatConversations([
    { id: 'm1', studentId: 'ada', studentName: 'Ada Student', message: 'Can I print?', timestamp: '2026-09-18T14:00:00.000Z', read: false },
    { id: 'm2', studentId: 'ada', studentName: 'Ada Student', message: 'Hello?', timestamp: '2026-09-18T14:01:00.000Z', read: false },
    { id: 'm3', studentId: 'cy', studentName: 'Cy Zed', message: 'Done', timestamp: '2026-09-18T14:02:00.000Z', read: true },
  ], {});
  const rows = buildMessagingRoster({
    students,
    monitoringByStudent: new Map([['ada', ON], ['ben', SIGNED_OUT], ['cy', ON], ['ann', STALE]]),
    absentIds: new Set(['ann']),
    coverageByStudent: new Map([['cy', 'Morgan Monitor']]),
    conversations,
  });
  const gridOrder = [...students].sort(compareStudentsByLastName).map((row) => row.studentId);
  assert.deepEqual(
    rows.map((row) => row.studentId),
    gridOrder.filter((id, index) => id && gridOrder.indexOf(id) === index),
    'the shared comparator decides the order; each student appears once',
  );
  assert.deepEqual(rows.map((row) => row.studentId), ['nameless', 'ben', 'ada', 'ann', 'cy']);
  assert.deepEqual(rows.find((row) => row.studentId === 'ada'), {
    studentId: 'ada', name: 'Ada Student', mark: 'dot', word: '', srStatus: 'On now', canMessage: true, unreadCount: 2, hasThread: true,
  });
  assert.deepEqual(rows.find((row) => row.studentId === 'cy'), {
    studentId: 'cy', name: 'Cy Zed', mark: 'diamond', word: 'With Morgan Monitor', srStatus: 'With Morgan Monitor', canMessage: false, unreadCount: 0, hasThread: true,
  });
  assert.equal(rows.find((row) => row.studentId === 'ben').word, 'Not signed in');
  assert.equal(rows.find((row) => row.studentId === 'ann').word, 'Absent');
  assert.equal(rows.find((row) => row.studentId === 'nameless').name, 'Dee Vance');
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['canMessage', 'hasThread', 'mark', 'name', 'srStatus', 'studentId', 'unreadCount', 'word']);
    assert.ok(Object.values(row).every((value) => value === null || typeof value !== 'object'), 'a row is primitives only: no message text, previews or times');
  }
  assert.deepEqual(buildMessagingRoster(), []);
  assert.deepEqual(
    buildMessagingRoster({ students: [{ studentId: 'x', studentName: 'X Ray' }], coverageByStudent: { x: '' } })[0].word,
    'With another teacher',
    'a plain object also maps coverage',
  );
});

test('Find matches names ignoring case and accents, and Enter opens only a single messageable match', () => {
  const rows = [
    { studentId: 'a', name: 'Ada Student', canMessage: true },
    { studentId: 'e', name: 'Émile Zola', canMessage: true },
    { studentId: 'c', name: 'Cy Zed', canMessage: false },
    { studentId: 'z', name: 'Zed Adams', canMessage: true },
  ];
  assert.equal(filterRoster(rows, ''), rows, 'a blank query keeps the same rows');
  assert.equal(filterRoster(rows, '   '), rows);
  assert.deepEqual(filterRoster(rows, 'ADA').map((row) => row.studentId), ['a', 'z']);
  assert.deepEqual(filterRoster(rows, 'emile').map((row) => row.studentId), ['e']);
  assert.deepEqual(filterRoster(rows, ' zed ').map((row) => row.studentId), ['c', 'z']);
  assert.deepEqual(filterRoster(rows, 'nobody'), []);
  assert.deepEqual(filterRoster(null, 'a'), []);
  assert.equal(enterTarget(filterRoster(rows, 'emile'))?.studentId, 'e');
  assert.equal(enterTarget(filterRoster(rows, 'zed'))?.studentId, 'z', 'a read-only match does not count');
  assert.equal(enterTarget(filterRoster(rows, 'ada')), null, 'two matches: Enter opens nothing');
  assert.equal(enterTarget(filterRoster(rows, 'cy')), null, 'a read-only row is never opened by Enter');
  assert.equal(enterTarget([]), null);
  assert.equal(enterTarget(undefined), null);
});

test('"need reply" opens the student whose oldest unread message has waited longest', () => {
  const conversations = [
    { studentId: 'newest-first', unreadCount: 1, items: [
      { sender: 'student', read: false, timestamp: '2026-09-18T14:09:00.000Z' },
    ] },
    { studentId: 'waited-longest', unreadCount: 2, items: [
      { sender: 'student', read: true, timestamp: '2026-09-18T13:00:00.000Z' },
      { sender: 'teacher', read: true, timestamp: '2026-09-18T13:30:00.000Z' },
      { sender: 'student', read: false, timestamp: '2026-09-18T14:01:00.000Z' },
      { sender: 'student', read: false, timestamp: '2026-09-18T14:08:00.000Z' },
    ] },
    { studentId: 'all-read', unreadCount: 0, items: [{ sender: 'student', read: true, timestamp: '2026-09-18T12:00:00.000Z' }] },
  ];
  assert.equal(longestWaitingUnreadId(conversations), 'waited-longest', 'an older read message does not count as waiting');
  assert.equal(longestWaitingUnreadId([
    { studentId: 'first', unreadCount: 1, items: [{ sender: 'student', read: false, timestamp: 'not a time' }] },
    { studentId: 'second', unreadCount: 1, items: [] },
  ]), 'first', 'with no usable times, the first unread thread');
  assert.equal(longestWaitingUnreadId([{ studentId: 'read', unreadCount: 0, items: [] }]), null);
  assert.equal(longestWaitingUnreadId(undefined), null);
  assert.equal(needReplyLabel(1), '1 needs reply');
  assert.equal(needReplyLabel(3), '3 need reply');
  assert.equal(needReplyLabel(undefined), '0 need reply');
});

test('"need reply" counts only conversations the teacher can answer', () => {
  const conversations = [
    { studentId: 'ada', unreadCount: 1, items: [{ sender: 'student', read: false, timestamp: '2026-09-18T14:05:00.000Z' }] },
    { studentId: 'cy', unreadCount: 1, items: [{ sender: 'student', read: false, timestamp: '2026-09-18T14:00:00.000Z' }] },
    { studentId: 'gone', unreadCount: 1, items: [{ sender: 'student', read: false, timestamp: '2026-09-18T13:00:00.000Z' }] },
  ];
  const rosterById = new Map([
    ['ada', { studentId: 'ada', canMessage: true }],
    ['cy', { studentId: 'cy', canMessage: false }],
  ]);
  const answerable = answerableConversations(conversations, { rosterById });
  assert.deepEqual(answerable.map((row) => row.studentId), ['ada'], 'not a student with another staff member, nor one off the roster');
  assert.equal(longestWaitingUnreadId(answerable), 'ada', 'older unanswerable messages never win the jump');
  assert.deepEqual(answerableConversations(conversations, { rosterById, canStart: false }), [], 'nothing while messaging is off');
  assert.equal(answerableConversations(conversations), conversations, 'with no roster known, every thread is an inbox thread');
  assert.deepEqual(answerableConversations(undefined, { rosterById }), []);
  assert.deepEqual(
    answerableConversations(conversations, { rosterById: { ada: { canMessage: true } } }).map((row) => row.studentId),
    ['ada'],
    'a plain object also maps the roster',
  );
});

test('a read-only thread says why there is no reply box', () => {
  assert.equal(
    readOnlyReplyNote({ name: 'Cy Zed', word: 'With Morgan Monitor' }),
    'Cy Zed is with Morgan Monitor right now. You can reply when they’re back in this class.',
  );
  assert.equal(
    readOnlyReplyNote({ name: 'Cy Zed', word: 'With another teacher' }),
    'Cy Zed is with another teacher right now. You can reply when they’re back in this class.',
  );
  assert.equal(
    readOnlyReplyNote({ name: 'Al Aaron' }),
    'Al Aaron isn’t in this class right now. You can read this conversation but not reply.',
    'a thread under Other conversations',
  );
  assert.equal(readOnlyReplyNote({ name: '  ' }), 'This student isn’t in this class right now. You can read this conversation but not reply.');
  assert.equal(readOnlyReplyNote(), 'This student isn’t in this class right now. You can read this conversation but not reply.');
});

test('threads with students who are not on the roster split off, in last-name order', () => {
  const conversations = [
    { studentId: 'gone-z', studentName: 'Zoe Zimmer' },
    { studentId: 'ada', studentName: 'Ada Student' },
    { studentId: 'gone-a', studentName: 'Al Aaron' },
    { studentName: 'No id' },
  ];
  assert.deepEqual(splitOffRoster(conversations, new Set(['ada'])).map((row) => row.studentId), ['gone-a', 'gone-z']);
  assert.deepEqual(splitOffRoster(conversations, new Map([['ada', {}]])).map((row) => row.studentId), ['gone-a', 'gone-z'], 'a Map keyed by student id works too');
  assert.deepEqual(splitOffRoster(conversations, ['ada', 'gone-a', 'gone-z']), []);
  assert.deepEqual(splitOffRoster(undefined, ['ada']), []);
  assert.equal(conversations[0].studentId, 'gone-z', 'the input is not reordered');
});

test('the announce button names its real target: ticks, then the subgroup, then the class', () => {
  assert.equal(broadcastButtonLabel(), 'Announce to class');
  assert.equal(broadcastButtonLabel({ selectedCount: 0, subgroupName: '  ' }), 'Announce to class');
  assert.equal(broadcastButtonLabel({ selectedCount: 1, subgroupName: 'Reading table' }), 'Message 1 selected student');
  assert.equal(broadcastButtonLabel({ selectedCount: 3 }), 'Message 3 selected students');
  assert.equal(broadcastButtonLabel({ subgroupName: 'Reading table' }), 'Message Reading table');
});

test('while a cleared selection stands, the announce button names no group or class', () => {
  const cleared = 'Selection cleared · choose students again';
  assert.equal(SELECTION_CLEARED_TARGET_LABEL, cleared, 'the Target badge wording');
  assert.equal(broadcastButtonLabel({ selectionLost: true }), cleared, 'never "Announce to class"');
  assert.equal(broadcastButtonLabel({ selectionLost: true, subgroupName: 'Reading table' }), cleared, 'never the group');
  assert.equal(broadcastButtonLabel({ selectionLost: true, selectedCount: 2, subgroupName: 'Reading table' }), 'Message 2 selected students', 'new ticks are a target again');
  assert.equal(broadcastButtonLabel({ selectionLost: 1 }), 'Announce to class', 'only a real loss changes the label');
});

test('while students are ticked for sign-out only, the announce button names that selection, whatever else is ticked or lost', () => {
  // Every control but Student Sign Out refuses until those ticks are cleared,
  // so the dialog never opens for the ticks, the group or the class.
  assert.equal(signOutOnlySelectionLabel(1), '1 selected for sign-out only', 'the Target badge wording');
  assert.equal(broadcastButtonLabel({ signOutOnlyCount: 1 }), '1 selected for sign-out only', 'never "Announce to class"');
  assert.equal(broadcastButtonLabel({ signOutOnlyCount: 2, subgroupName: 'Reading table' }), '2 selected for sign-out only', 'never the group');
  assert.equal(broadcastButtonLabel({ signOutOnlyCount: 1, selectedCount: 3 }), '1 selected for sign-out only', 'never the other ticks');
  assert.equal(broadcastButtonLabel({ signOutOnlyCount: 1, selectionLost: true }), '1 selected for sign-out only', 'the refusal a click meets first');
  assert.equal(broadcastButtonLabel({ signOutOnlyCount: 0, selectionLost: true }), SELECTION_CLEARED_TARGET_LABEL);
  assert.equal(broadcastButtonLabel({ signOutOnlyCount: -1 }), 'Announce to class', 'only a count changes the label');
  assert.equal(broadcastButtonLabel({ signOutOnlyCount: Number.NaN, selectedCount: 2 }), 'Message 2 selected students');
});
