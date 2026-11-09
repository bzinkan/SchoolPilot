import assert from 'node:assert/strict';
import test from 'node:test';
import * as lifecycle from '../src/products/classpilot/lib/privateChatLifecycle.js';
const { privateChatLifecycleToken, privateChatLifecycleCanAdvance, samePrivateChatLifecycle, privateChatReadiness } = lifecycle;
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
test('readiness never enables unknown or contradictory lifecycle rows and preserves legacy positive evidence', () => {
  assert.equal(typeof privateChatReadiness, 'function');
  for (const row of [null, {}, { supported: false }, { supported: true, readiness: 'future_unknown' },
    { supported: false, readiness: 'ready' }, { supported: true, readiness: 'update_required' }]) {
    assert.equal(privateChatReadiness(row), 'syncing');
  }
  assert.equal(privateChatReadiness({ supported: true }), 'ready');
  assert.equal(privateChatReadiness({ supported: true, readiness: 'ready' }), 'ready');
  for (const readiness of ['update_required', 'reconnecting', 'signed_out', 'unavailable', 'disabled']) {
    assert.equal(privateChatReadiness({ supported: false, readiness }), readiness);
  }
});
test('a reply refused during a connection or capability change requests authoritative lifecycle refresh', () => {
  for (const code of ['PRIVATE_CHAT_CLIENT_UPDATE_REQUIRED', 'PRIVATE_CHAT_RECONNECT_REQUIRED', 'PRIVATE_CHAT_SIGN_IN_REQUIRED', 'PRIVATE_CHAT_READINESS_UNAVAILABLE']) {
    assert.equal(lifecycle.privateChatLifecycleError({ response: { data: { code } } }), code);
  }
});
