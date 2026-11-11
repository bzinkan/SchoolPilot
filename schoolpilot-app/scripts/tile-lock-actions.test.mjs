import assert from 'node:assert/strict';
import test from 'node:test';
import { runTileLockAction, tileLockAuthorityKey, tileLockCommandOutcome } from '../src/products/classpilot/lib/tileLockActions.js';
import { commandDeliveryFeedback } from '../src/products/classpilot/lib/commandDeliveryTruth.js';
const response = (commandType, status = 'completed', result = { outcome: 'applied' }) => ({
  command: { id: 'command-a', commandType, teachingSessionId: 'class-a', targets: [{ studentId: 'a', status, result }] },
});
const noRead = async () => assert.fail('Unexpected status read');

test('refused Stop Focus is explicitly not queued and pending cleanup remains unconfirmed', () => {
  const refused = tileLockCommandOutcome({ status: 'unavailable', errorMessage: 'screen_only_unlock_requires_capable_online_extension' }, 'unlock-screen', 'stop-a');
  assert.equal(refused.status, 'unavailable');
  assert.match(refused.error, /Stop Focus was not queued/);
  assert.match(refused.error, /reconnect/i);
  const pending = tileLockCommandOutcome({ status: 'received', result: { outcome: 'applied' } }, 'unlock-screen', 'stop-b');
  assert.equal(pending.status, 'received');
  assert.equal(pending.error, undefined);
  const saved = tileLockCommandOutcome({ status: 'unavailable', errorMessage: 'screen_only_unlock_pending_clear' }, 'unlock-screen', 'saved-clear');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.error, undefined);
});

test('toolbar Stop Focus distinguishes unavailable students from acknowledgements still pending', () => {
  const refused = response('unlock-screen', 'unavailable', {});
  refused.command.targets[0].errorMessage = 'screen_only_unlock_requires_capable_online_extension';
  const feedback = commandDeliveryFeedback(refused, 'unlock-screen');
  assert.equal(feedback.title, 'Stop Focus not queued');
  assert.match(feedback.description, /not queued/);
  assert.doesNotMatch(feedback.description, /signed out/);
  assert.doesNotMatch(feedback.description, /screen_only_unlock/);
  const awaiting = commandDeliveryFeedback(response('unlock-screen', 'received', {}), 'unlock-screen');
  assert.match(awaiting.title, /awaiting confirmation/);
  assert.doesNotMatch(awaiting.description, /not queued/);
  const saved = response('unlock-screen', 'unavailable', {});
  saved.command.targets[0].errorMessage = 'screen_only_unlock_pending_clear';
  const savedFeedback = commandDeliveryFeedback(saved, 'unlock-screen');
  assert.match(savedFeedback.title, /awaiting confirmation/);
  assert.match(savedFeedback.description, /saved cleanup/);
  assert.doesNotMatch(savedFeedback.description, /not queued/);
  const stale = commandDeliveryFeedback(response('unlock-screen', 'completed', { outcome: 'stale' }), 'unlock-screen');
  assert.equal(stale.title, 'Stop Focus not confirmed');
  assert.match(stale.description, /did not apply/);
});
test('tile Focus and Stop Focus each send one narrow student-scoped website command', async () => {
  for (const [action, type, payload] of [['focus-current-page', 'lock-screen', { url: 'CURRENT_URL' }], ['stop-focus', 'unlock-screen', { screenOnly: true }]]) {
    const posts = [];
    const result = await runTileLockAction({ action, studentId: 'a', readCommand: noRead,
      postCommand: async (...args) => { posts.push(args); return response(type); } });
    assert.deepEqual(posts, [[type, payload, ['a']]]);
    assert.equal(result.outcomes.focus.status, 'completed'); assert.equal(result.pending, false);
  }
});
test('stale, expired or refused application ACKs remain failed without a second command', async () => {
  for (const action of ['focus-current-page', 'stop-focus']) for (const outcome of ['stale', 'expired', 'unsupported']) {
    let count = 0;
    const result = await runTileLockAction({ action, studentId: 'a', readCommand: noRead,
      postCommand: async type => { count++; return response(type, 'completed', { outcome }); } });
    assert.equal(count, 1); assert.equal(result.outcomes.focus.status, 'failed'); assert.match(result.outcomes.focus.error, /did not apply/);
  }
});
test('received Focus waits for its exact command confirmation', async () => {
  const updates = [], reads = [];
  const result = await runTileLockAction({ action: 'focus-current-page', studentId: 'a',
    postCommand: async type => response(type, 'received', {}),
    readCommand: async command => { reads.push(command.id); return response('lock-screen'); },
    waitOptions: { sleep: async () => {} }, onUpdate: value => updates.push(value) });
  assert.deepEqual(reads, ['command-a']); assert.ok(updates.some(value => value.outcomes.focus?.status === 'received'));
  assert.equal(result.outcomes.focus.status, 'completed');
});
test('missing, multi-student or mismatched commands stay unconfirmed', async () => {
  for (const malformed of [{}, response('stop-focus'), { command: { ...response('lock-screen').command,
    targets: [{ studentId: 'other', status: 'completed' }] } }, { commands: [response('lock-screen').command, { ...response('lock-screen').command, id: 'b' }] }]) {
    const result = await runTileLockAction({ action: 'focus-current-page', studentId: 'a', readCommand: noRead, postCommand: async () => malformed });
    assert.equal(result.outcomes.focus.status, 'pending');
  }
});
test('rejected or unavailable Stop Focus remains unconfirmed', async () => {
  const failed = await runTileLockAction({ action: 'stop-focus', studentId: 'a', readCommand: noRead,
    postCommand: async () => { throw new Error('Authority unavailable'); } });
  assert.equal(failed.outcomes.focus.status, 'failed'); assert.equal(failed.outcomes.focus.error, 'Authority unavailable');
  const unavailable = await runTileLockAction({ action: 'stop-focus', studentId: 'a', readCommand: noRead,
    postCommand: async type => response(type, 'unavailable', {}) });
  assert.equal(unavailable.outcomes.focus.status, 'unavailable');
});
test('cancellation and changed student authority prevent stale updates', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runTileLockAction({ action: 'focus-current-page', studentId: 'a', signal: controller.signal,
    postCommand: async () => assert.fail('Cancelled action cannot dispatch') }), { name: 'AbortError' });
  let current = true;
  await assert.rejects(runTileLockAction({ action: 'stop-focus', studentId: 'a',
    assertCurrent: () => { if (!current) throw new Error('Binding changed'); },
    postCommand: async type => { current = false; return response(type); } }), /Binding changed/);
  assert.notEqual(tileLockAuthorityKey('scope', { studentId: 'a', realtimeBinding: 'one' }), tileLockAuthorityKey('scope', { studentId: 'a', realtimeBinding: 'two' }));
});
test('missing students and retired actions never dispatch', async () => {
  for (const [action, studentId] of [['focus-current-page', ''], ['focus-current-tab', 'a'], ['clear-waypoint', 'a'], ['stop-both', 'a']])
    await assert.rejects(runTileLockAction({ action, studentId, postCommand: async () => assert.fail('Invalid action cannot dispatch') }), /valid lock action/);
});
