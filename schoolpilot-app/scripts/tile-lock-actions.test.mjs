import assert from 'node:assert/strict';
import test from 'node:test';
import { runTileLockAction, tileLockAuthorityKey } from '../src/products/classpilot/lib/tileLockActions.js';
const response = (commandType, status = 'completed', result = { outcome: 'applied' }) => ({
  command: { id: 'command-a', commandType, teachingSessionId: 'class-a', targets: [{ studentId: 'a', status, result }] },
});
const noRead = async () => assert.fail('Unexpected status read');
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
