import assert from 'node:assert/strict';
import test from 'node:test';
import { CANNED_REPLIES, CHAT_REPLY_MAX_CHARS, cannedRepliesFor, chatStudentName, countUnreadByStudent, looksLikeQuestion, deriveChatConversations, describeChatDeviceReadiness, describeChatReplyError, DELIVERY_RANK, emptyConversation, mergeDeliveryStatus, deliveryLabel, describeChatPause } from '../src/products/classpilot/lib/chatThreads.js';

test('a message is a question when it ends with a question mark', () => {
  assert.equal(looksLikeQuestion('can we go gym still?????'), true);
  assert.equal(looksLikeQuestion('  Can I use the printer?  '), true);
  assert.equal(looksLikeQuestion('MR.ZZZZ!!!!!!!'), false);
  assert.equal(looksLikeQuestion('why? because'), false);
  assert.equal(looksLikeQuestion(''), false);
  assert.equal(looksLikeQuestion(null), false);
  assert.equal(looksLikeQuestion(undefined), false);
});

test('unread counts group by student and skip read rows and rows without a student', () => {
  const counts = countUnreadByStudent([
    { id: '1', studentId: 'a', read: false },
    { id: '2', studentId: 'a', read: true },
    { id: '3', studentId: 'a', read: false },
    { id: '4', studentId: 'b', read: false },
    { id: '5', read: false },
    null,
  ]);
  assert.deepEqual([...counts.entries()], [['a', 2], ['b', 1]]);
  assert.equal(countUnreadByStudent(undefined).size, 0);
});

test('canned replies are short, unique, and exactly one of them is the one-tap acknowledgement', () => {
  const ids = new Set(CANNED_REPLIES.map(reply => reply.id));
  assert.equal(ids.size, CANNED_REPLIES.length);
  for (const reply of CANNED_REPLIES) {
    assert.ok(reply.text.length > 0 && reply.text.length <= CHAT_REPLY_MAX_CHARS, reply.id);
  }
  assert.equal(CANNED_REPLIES.filter(reply => reply.ack).length, 1);
  assert.equal(CANNED_REPLIES.find(reply => reply.ack).text, 'Got it');
});

test('a thread the student has not written in offers only openers: no acknowledgement and no answers', () => {
  assert.equal(cannedRepliesFor(true), CANNED_REPLIES, 'once the student has written, every quick reply fits');
  assert.deepEqual(cannedRepliesFor(false).map(reply => reply.id), ['come-see-me', 'check-board']);
  assert.equal(cannedRepliesFor(false).some(reply => reply.ack || reply.replyOnly), false);
});

test('conversations merge a student thread with the teacher replies, oldest first, and order unread first then newest', () => {
  const studentMessages = [
    { id: 's1', studentId: 'ada', studentName: 'Ada Student', message: 'Can I print?', timestamp: '2026-09-18T14:00:00.000Z', read: true },
    { id: 's2', studentId: 'ada', studentName: 'Ada Student', message: 'Hello?', timestamp: '2026-09-18T14:05:00.000Z', read: false },
    { id: 's3', studentId: 'ben', studentName: 'Ben Student', message: 'Done', timestamp: '2026-09-18T14:09:00.000Z', read: true },
    { id: 's4', studentId: 'cy', studentName: 'Cy Student', message: 'Early note', timestamp: '2026-09-18T13:00:00.000Z', read: false },
  ];
  const chatReplies = {
    ada: [{ id: 't1', message: 'Yes', timestamp: '2026-09-18T14:02:00.000Z', status: 'delivered' }],
    zed: [{ id: 't2', message: 'Orphan reply', timestamp: '2026-09-18T14:10:00.000Z', status: 'sent' }],
  };
  const nameById = new Map([['zed', 'Zed Student'], ['ada', 'Roster Ada']]);
  const { conversations, totalUnread } = deriveChatConversations(studentMessages, chatReplies, nameById);
  assert.deepEqual(conversations.map((row) => row.studentId), ['ada', 'cy', 'zed', 'ben'], 'unread first (newest unread first), then newest activity');
  assert.equal(totalUnread, 2);
  const ada = conversations[0];
  assert.deepEqual(ada.items.map((item) => item.id), ['s1', 't1', 's2'], 'merged timeline is oldest first');
  assert.equal(ada.unreadCount, 1);
  assert.equal(ada.lastItem.id, 's2');
  assert.equal(ada.lastAt, '2026-09-18T14:05:00.000Z');
  assert.equal(ada.studentName, 'Ada Student', 'the name a student message carries is kept');
  assert.equal(conversations[2].studentName, 'Zed Student', 'a thread the teacher started is named from the class roster');
  assert.equal(conversations[2].lastItem.sender, 'teacher');
});

test('a teacher-only thread reads Unknown only when no name is known anywhere', () => {
  const chatReplies = { zed: [{ id: 't2', message: 'Hello', timestamp: '2026-09-18T14:10:00.000Z', status: 'sent' }] };
  assert.equal(deriveChatConversations([], chatReplies).conversations[0].studentName, 'Unknown');
  assert.equal(deriveChatConversations([], chatReplies, new Map([['ada', 'Ada Student']])).conversations[0].studentName, 'Unknown');
  assert.equal(deriveChatConversations([], chatReplies, new Map([['zed', '  ']])).conversations[0].studentName, 'Unknown', 'a blank name is no name');
  assert.equal(deriveChatConversations([], chatReplies, { zed: 'Zed Student' }).conversations[0].studentName, 'Zed Student', 'a plain object works too');
  assert.equal(
    deriveChatConversations([], chatReplies, Object.create({ zed: 'Inherited Name' })).conversations[0].studentName,
    'Unknown',
    'inherited object keys are not names',
  );
});

test('a student row names its chat by display name, then first and last name', () => {
  assert.equal(chatStudentName({ studentName: ' Ada Student ' }), 'Ada Student');
  assert.equal(chatStudentName({ name: 'Ben Student' }), 'Ben Student');
  assert.equal(chatStudentName({ firstName: 'Cy', lastName: 'Student' }), 'Cy Student');
  assert.equal(chatStudentName({ email: 'dee@example.edu' }), '', 'an email is not a display name');
  assert.equal(chatStudentName(null), '');
});

test('an empty conversation is a thread the teacher can start', () => {
  assert.deepEqual(emptyConversation('ada', 'Ada Student'), { studentId: 'ada', studentName: 'Ada Student', studentEmail: '', items: [], unreadCount: 0 });
  assert.equal(emptyConversation('ada', '').studentName, 'Unknown');
});

test('conversations ignore rows without ids or students and tolerate bad timestamps', () => {
  const { conversations, totalUnread } = deriveChatConversations(
    [{ id: 'x', studentId: null, message: 'no student' }, { id: null, studentId: 'ada', message: 'no id' },
      { id: 'ok', studentId: 'ada', studentName: 'Ada', message: 'fine', timestamp: 'not a date', read: false }],
    { ada: [], ben: null }
  );
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].items.length, 1);
  assert.equal(totalUnread, 1);
  assert.deepEqual(deriveChatConversations(undefined, undefined), { conversations: [], totalUnread: 0 });
});

test('delivery status only moves forward and the latest of sent/failed wins', () => {
  assert.equal(mergeDeliveryStatus('sent', 'delivered'), 'delivered');
  assert.equal(mergeDeliveryStatus('delivered', 'seen'), 'seen');
  assert.equal(mergeDeliveryStatus('seen', 'delivered'), 'seen', 'a stray delivered never regresses seen');
  assert.equal(mergeDeliveryStatus('delivered', 'sent'), 'delivered', 'a history re-read cannot undo delivery');
  assert.equal(mergeDeliveryStatus('delivered', 'failed'), 'delivered');
  assert.equal(mergeDeliveryStatus('sent', 'failed'), 'failed');
  assert.equal(mergeDeliveryStatus('failed', 'sent'), 'sent');
  assert.equal(mergeDeliveryStatus(undefined, 'delivered'), 'delivered');
  assert.equal(mergeDeliveryStatus('seen', undefined), 'seen');
  assert.equal(mergeDeliveryStatus('seen', 'bogus'), 'seen');
  assert.deepEqual(DELIVERY_RANK, { sent: 1, failed: 1, delivered: 2, seen: 3 });
  assert.equal(deliveryLabel('seen'), 'Seen');
  assert.equal(deliveryLabel('delivered'), 'Delivered');
  assert.equal(deliveryLabel('failed', 'No device'), 'No device');
  assert.equal(deliveryLabel('failed'), 'Failed');
  assert.equal(deliveryLabel('sent'), 'Sending');
});

test('an undelivered message to a signed-out student says it waits for them to sign in', () => {
  assert.equal(deliveryLabel('sent', null, { waitingFor: 'Ada Student' }), 'Waits until Ada Student signs in');
  assert.equal(deliveryLabel(undefined, null, { waitingFor: 'Ada Student' }), 'Waits until Ada Student signs in');
  assert.equal(deliveryLabel('delivered', null, { waitingFor: 'Ada Student' }), 'Delivered', 'a delivered message no longer waits');
  assert.equal(deliveryLabel('seen', null, { waitingFor: 'Ada Student' }), 'Seen');
  assert.equal(deliveryLabel('failed', 'No device', { waitingFor: 'Ada Student' }), 'No device', 'a failure is never hidden behind the wait');
  assert.equal(deliveryLabel('sent', null, { waitingFor: null }), 'Sending');
  assert.equal(deliveryLabel('sent', null, null), 'Sending');
});

test('a refused reply is described in plain words from its error code', () => {
  const failure = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
  const rows = [
    [failure(409, { error: 'Student classroom authority changed', code: 'chat_authority_stale' }), 'Ada Student is with another teacher right now.'],
    [failure(404, { error: 'Active class session not found', code: 'ACTIVE_SESSION_NOT_FOUND' }), 'This class has ended.'],
    [failure(404, { error: 'Scheduled classroom activity is unavailable', code: 'CLASSROOM_ACTIVITY_UNAVAILABLE' }), 'This class has ended.'],
    [failure(403, { error: 'Messaging is disabled', code: 'FAB_FEATURE_DISABLED' }), 'Messaging is turned off for this class or your school.'],
    [failure(404, { error: 'Student is not in this class session', code: 'CHAT_STUDENT_NOT_IN_SESSION' }), 'Ada Student isn’t in this class right now.'],
    [failure(409, { error: 'Student is no longer in this classroom activity', code: 'CLASSROOM_ACTIVITY_STALE' }), 'Ada Student isn’t in this class right now.'],
    // Codeless: the class ended or is no longer yours, or the student is off the roster.
    [failure(404, { error: 'Session not found' }), 'Ada Student isn’t in this class, or the class has ended. Refresh the page to check.'],
    [failure(400, { error: 'message cannot exceed 500 characters', code: 'MESSAGE_TOO_LONG' }), `Messages can be up to ${CHAT_REPLY_MAX_CHARS} characters.`],
    [failure(400, { error: 'Message must contain 1 to 500 characters', code: 'teacher_reply_invalid' }), `Messages can be up to ${CHAT_REPLY_MAX_CHARS} characters.`],
    [failure(400, { error: 'Message must contain 1–500 characters', code: 'MESSAGE_INVALID' }), `Messages can be up to ${CHAT_REPLY_MAX_CHARS} characters.`],
    [failure(409, { error: 'Scheduled classroom staff assignment changed; refresh before trying again', code: 'CLASSROOM_AUTHORITY_CHANGED' }), 'This class changed. Refresh the page and try again.'],
  ];
  for (const [error, expected] of rows) {
    assert.equal(describeChatReplyError(error, 'Ada Student'), expected, error.response.data.code || 'bare 404');
  }
  assert.equal(describeChatReplyError(rows[0][0], ''), 'This student is with another teacher right now.', 'no name falls back to a neutral subject');
  assert.equal(describeChatReplyError(failure(500, { error: 'Internal server error' }), 'Ada Student'), 'Internal server error', 'an unknown failure keeps the server message');
  assert.equal(describeChatReplyError(failure(404, { error: 'Thing missing', code: 'SOMETHING_ELSE' }), 'Ada Student'), 'Thing missing', 'a coded 404 is not mistaken for the roster check');
  assert.equal(describeChatReplyError(new Error('Network Error'), 'Ada Student'), 'Network Error');
  assert.equal(describeChatReplyError(null, 'Ada Student'), 'Something went wrong.');
});

test('a pause is described by who paused it, and a testing pause is locked', () => {
  assert.equal(describeChatPause(null), null);
  assert.equal(describeChatPause({ messagesPaused: false, pauseReason: null }), null);
  const teacher = describeChatPause({ messagesPaused: true, pauseReason: 'teacher' });
  assert.deepEqual([teacher.reason, teacher.locked, teacher.title], ['teacher', false, 'Messages paused']);
  const testing = describeChatPause({ messagesPaused: true, pauseReason: 'testing' });
  assert.deepEqual([testing.reason, testing.locked, testing.title], ['testing', true, 'Paused for testing']);
  assert.equal(describeChatPause({ messagesPaused: true }).reason, 'teacher', 'an unknown reason reads as the teacher');
});

test('device readiness: not reporting wins over everything and keeps the offline test id', () => {
  const offline = { telemetryCurrent: false, status: 'signal_lost' };
  const readiness = describeChatDeviceReadiness({
    student: { fabSyncPending: true, enforcementHealth: 'pending' },
    monitoring: offline,
    authority: { teachingSessionId: 'session-a' },
  });
  assert.equal(readiness.kind, 'offline');
  assert.equal(readiness.testId, 'chat-thread-offline-note');
  assert.match(readiness.label, /reconnects/);
  assert.equal(describeChatDeviceReadiness({ student: {}, monitoring: offline, authority: null }).kind, 'offline');
});

test('device readiness: a signed-out student is reached by signing in during this class, not by a reconnect', () => {
  const readiness = describeChatDeviceReadiness({
    student: { loginState: 'not_logged_in' },
    monitoring: { kind: 'signed_out', telemetryCurrent: false, status: 'offline' },
    authority: { teachingSessionId: 'session-a' },
  });
  assert.equal(readiness.kind, 'offline', 'the list still treats it as not reporting, not as blocked');
  assert.equal(readiness.testId, 'chat-thread-offline-note');
  assert.equal(readiness.label, 'Messages wait until the student signs in during this class.');
});

test('device readiness: never guesses without a drawer authority or a student', () => {
  const online = { telemetryCurrent: true, status: 'online' };
  assert.equal(describeChatDeviceReadiness({ student: {}, monitoring: online, authority: null }), null);
  assert.equal(describeChatDeviceReadiness({ student: null, monitoring: online, authority: { teachingSessionId: 'session-a' } }), null);
  assert.equal(describeChatDeviceReadiness(), null);
});

test('device readiness: a device with no classroom state has not joined the class', () => {
  const readiness = describeChatDeviceReadiness({
    student: { studentId: 's1' },
    monitoring: { telemetryCurrent: true, status: 'online' },
    authority: { teachingSessionId: 'session-a' },
  });
  assert.equal(readiness.kind, 'not_in_class');
  assert.equal(readiness.testId, 'chat-thread-readiness-note');
  assert.match(readiness.label, /under this class/);
});

test('device readiness: another class or a coverage context owning the device is reported', () => {
  const online = { telemetryCurrent: true, status: 'online' };
  const otherSession = describeChatDeviceReadiness({
    student: { classroomState: { teachingSessionId: 'session-b', supervisionContextId: null } },
    monitoring: online,
    authority: { teachingSessionId: 'session-a' },
  });
  assert.equal(otherSession.kind, 'other_authority');
  const otherContext = describeChatDeviceReadiness({
    student: { classroomState: { teachingSessionId: null, supervisionContextId: 'context-b' } },
    monitoring: online,
    authority: { supervisionContextId: 'context-a' },
  });
  assert.equal(otherContext.kind, 'other_authority');
  const matchingContext = describeChatDeviceReadiness({
    student: { classroomState: { teachingSessionId: null, supervisionContextId: 'context-a' }, enforcementHealth: 'synced' },
    monitoring: online,
    authority: { supervisionContextId: 'context-a' },
  });
  assert.equal(matchingContext, null);
});

test('device readiness: applying settings, then a re-sent FAB, then nothing in the way', () => {
  const online = { telemetryCurrent: true, status: 'online' };
  const authority = { teachingSessionId: 'session-a' };
  const owned = { teachingSessionId: 'session-a', supervisionContextId: null };
  assert.equal(describeChatDeviceReadiness({
    student: { classroomState: owned, enforcementHealth: 'pending', fabSyncPending: true }, monitoring: online, authority,
  }).kind, 'applying', 'an unacknowledged control revision outranks the FAB re-send');
  const syncing = describeChatDeviceReadiness({
    student: { classroomState: owned, enforcementHealth: 'synced', fabSyncPending: true }, monitoring: online, authority,
  });
  assert.equal(syncing.kind, 'fab_syncing');
  assert.match(syncing.detail, /last check-in/);
  assert.equal(describeChatDeviceReadiness({
    student: { classroomState: owned, enforcementHealth: 'synced', fabSyncPending: false }, monitoring: online, authority,
  }), null);
  assert.equal(describeChatDeviceReadiness({
    student: { classroomState: owned, enforcementHealth: 'synced' }, monitoring: null, authority,
  }), null, 'no monitoring projection is not treated as offline');
});
