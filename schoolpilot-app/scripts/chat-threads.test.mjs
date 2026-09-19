import assert from 'node:assert/strict';
import test from 'node:test';
import { CANNED_REPLIES, CHAT_REPLY_MAX_CHARS, countUnreadByStudent, looksLikeQuestion, deriveChatConversations, DELIVERY_RANK, mergeDeliveryStatus, deliveryLabel, describeChatPause } from '../src/products/classpilot/lib/chatThreads.js';

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
  const { conversations, totalUnread } = deriveChatConversations(studentMessages, chatReplies);
  assert.deepEqual(conversations.map((row) => row.studentId), ['ada', 'cy', 'zed', 'ben'], 'unread first (newest unread first), then newest activity');
  assert.equal(totalUnread, 2);
  const ada = conversations[0];
  assert.deepEqual(ada.items.map((item) => item.id), ['s1', 't1', 's2'], 'merged timeline is oldest first');
  assert.equal(ada.unreadCount, 1);
  assert.equal(ada.lastItem.id, 's2');
  assert.equal(ada.lastAt, '2026-09-18T14:05:00.000Z');
  assert.equal(conversations[2].studentName, 'Unknown', 'a reply-only thread still gets a row');
  assert.equal(conversations[2].lastItem.sender, 'teacher');
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

test('a pause is described by who paused it, and a testing pause is locked', () => {
  assert.equal(describeChatPause(null), null);
  assert.equal(describeChatPause({ messagesPaused: false, pauseReason: null }), null);
  const teacher = describeChatPause({ messagesPaused: true, pauseReason: 'teacher' });
  assert.deepEqual([teacher.reason, teacher.locked, teacher.title], ['teacher', false, 'Messages paused']);
  const testing = describeChatPause({ messagesPaused: true, pauseReason: 'testing' });
  assert.deepEqual([testing.reason, testing.locked, testing.title], ['testing', true, 'Paused for testing']);
  assert.equal(describeChatPause({ messagesPaused: true }).reason, 'teacher', 'an unknown reason reads as the teacher');
});
