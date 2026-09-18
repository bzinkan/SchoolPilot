import assert from 'node:assert/strict';
import test from 'node:test';
import { CANNED_REPLIES, CHAT_REPLY_MAX_CHARS, countUnreadByStudent, looksLikeQuestion } from '../src/products/classpilot/lib/chatThreads.js';

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
