import assert from 'node:assert/strict';
import test from 'node:test';
import { privateChatLifecycleToken, privateChatLifecycleCanAdvance, samePrivateChatLifecycle } from '../src/products/classpilot/lib/privateChatLifecycle.js';
const token = { threadId: 'thread-a', schoolEpoch: 1, activityEpoch: 1, threadGeneration: 1 };
test('a retired conversation can never adopt a lower epoch or thread generation', () => {
  const ended = { ...token, threadGeneration: 2 };
  assert.equal(privateChatLifecycleCanAdvance(ended, token), false);
  assert.equal(privateChatLifecycleCanAdvance({ ...ended, schoolEpoch: 2 }, ended), false);
  assert.equal(privateChatLifecycleCanAdvance({ ...ended, activityEpoch: 2 }, ended), false);
  assert.equal(privateChatLifecycleCanAdvance(ended, { ...ended, schoolEpoch: 2 }), true);
  assert.equal(privateChatLifecycleCanAdvance(ended, { ...ended, threadId: 'another-thread' }), false);
  assert.equal(samePrivateChatLifecycle(ended, token), false);
});
test('unknown or malformed tokens never create private write authority', () => {
  for (const value of [null, {}, { ...token, schoolEpoch: '1' }, { ...token, activityEpoch: 0 }, { ...token, threadGeneration: Number.MAX_SAFE_INTEGER + 1 }, { ...token, threadId: 'x'.repeat(129) }]) assert.equal(privateChatLifecycleToken(value), null);
  assert.deepEqual(privateChatLifecycleToken({ ...token, unrelatedServerField: 'omit' }), token);
  assert.equal(Object.isFrozen(privateChatLifecycleToken(token)), true);
});
