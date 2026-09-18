import assert from 'node:assert/strict';
import test from 'node:test';
import { formatChatTimestamp } from '../src/products/classpilot/lib/chatTimestamp.js';

const now = new Date(2026, 8, 18, 14, 5, 0);

test('a message sent today shows only its local time', () => {
  const label = formatChatTimestamp(new Date(2026, 8, 18, 9, 7, 0).toISOString(), now);
  assert.match(label, /^9:07/);
  assert.doesNotMatch(label, /Sep/);
});

test('a message from another day is prefixed with its date', () => {
  const label = formatChatTimestamp(new Date(2026, 8, 17, 15, 30, 0).toISOString(), now);
  assert.match(label, /Sep 17/);
  assert.match(label, /3:30/);
});

test('an invalid or missing timestamp renders nothing rather than "Invalid Date"', () => {
  assert.equal(formatChatTimestamp(undefined, now), '');
  assert.equal(formatChatTimestamp('not a date', now), '');
  assert.equal(formatChatTimestamp(null, now), '');
});
