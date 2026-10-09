import assert from 'node:assert/strict';
import test from 'node:test';
import { runTileLockAction, tileLockAuthorityKey } from '../src/products/classpilot/lib/tileLockActions.js';

const STUDENT = 'student-a';
const command = (commandType, status = 'completed', overrides = {}) => ({
  id: `${commandType}-a`, commandType, teachingSessionId: 'class-a',
  targets: [{ studentId: STUDENT, status }], ...overrides,
});
const noRead = async () => assert.fail('A terminal command must not require a status read.');
const focusPayload = { tabTargets: [{ studentId: STUDENT, tabRef: 'opaque-current-tab', observedRevision: 7 }] };

test('current-tab Focus sends exactly one scoped opaque target and never converts a URL into identity', async () => {
  const calls = [];
  const result = await runTileLockAction({ action: 'focus-current-tab', studentId: STUDENT, focusPayload,
    readCommand: noRead, postCommand: async (...args) => {
      calls.push(args);
      return { command: command('focus-tab') };
    } });
  assert.deepEqual(calls, [['focus-tab', focusPayload, [STUDENT]]]);
  assert.equal(result.outcomes.focus.status, 'completed');
  assert.equal(result.pending, false);
});

test('single stop and Waypoint clear use only their existing narrow commands', async () => {
  for (const [action, type, payload, field] of [
    ['stop-focus', 'stop-focus', {}, 'focus'],
    ['clear-waypoint', 'unlock-screen', { screenOnly: true }, 'waypoint'],
  ]) {
    const calls = [];
    const result = await runTileLockAction({ action, studentId: STUDENT, readCommand: noRead,
      postCommand: async (...args) => { calls.push(args); return { command: command(type) }; } });
    assert.deepEqual(calls, [[type, payload, [STUDENT]]]);
    assert.equal(result.outcomes[field].status, 'completed');
    assert.deepEqual(Object.keys(result.outcomes), [field]);
  }
});

test('completed ACKs with explicit stale or expired application results remain failed for Focus and Waypoint', async () => {
  for (const [action, type, field] of [
    ['focus-current-tab', 'focus-tab', 'focus'],
    ['stop-focus', 'stop-focus', 'focus'],
    ['clear-waypoint', 'unlock-screen', 'waypoint'],
  ]) for (const outcome of ['stale', 'expired']) {
    const applicationResult = { outcome, reason: 'Exact binding is no longer current' };
    const result = await runTileLockAction({ action, studentId: STUDENT, focusPayload, readCommand: noRead,
      postCommand: async () => ({ command: command(type, 'completed', {
        targets: [{ studentId: STUDENT, status: 'completed', result: applicationResult }],
      }) }),
    });
    assert.equal(result.outcomes[field].status, 'failed', `${type} ${outcome} cannot claim enforcement`);
    assert.equal(result.outcomes[field].commandType, type);
    assert.deepEqual(result.outcomes[field].result, applicationResult, 'the explicit device result remains reviewable');
    assert.ok(result.outcomes[field].error, 'a completed transport ACK must explain its failed application');
  }
});

test('Stop Both still clears Waypoint after a stale Focus ACK while preserving the Focus application failure', async () => {
  const calls = [];
  const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT, readCommand: noRead,
    postCommand: async (type, payload, ids) => {
      calls.push([type, payload, ids]);
      return { command: command(type, 'completed', {
        targets: [{ studentId: STUDENT, status: 'completed', result: { outcome: type === 'stop-focus' ? 'stale' : 'applied' } }],
      }) };
    } });
  assert.deepEqual(calls, [['stop-focus', {}, [STUDENT]], ['unlock-screen', { screenOnly: true }, [STUDENT]]]);
  assert.equal(result.outcomes.focus.status, 'failed');
  assert.equal(result.outcomes.focus.result.outcome, 'stale');
  assert.equal(result.outcomes.waypoint.status, 'completed');
  assert.equal(result.outcomes.waypoint.result.outcome, 'applied');
});

test('an expired Waypoint completed ACK retains partial Stop Both results and retries only Waypoint', async () => {
  const calls = [];
  const postCommand = async (type, payload, ids) => {
    calls.push([type, payload, ids]);
    return { command: command(type, 'completed', {
      targets: [{ studentId: STUDENT, status: 'completed', result: { outcome: calls.length === 2 ? 'expired' : 'applied' } }],
    }) };
  };
  const partial = await runTileLockAction({ action: 'stop-both', studentId: STUDENT, readCommand: noRead, postCommand });
  assert.equal(partial.outcomes.focus.status, 'completed');
  assert.equal(partial.outcomes.waypoint.status, 'failed');
  assert.equal(partial.outcomes.waypoint.result.outcome, 'expired');
  const retried = await runTileLockAction({ action: 'clear-waypoint', studentId: STUDENT, readCommand: noRead, postCommand });
  assert.equal(retried.outcomes.waypoint.status, 'completed');
  assert.deepEqual(calls.map(call => call[0]), ['stop-focus', 'unlock-screen', 'unlock-screen']);
  assert.equal(partial.outcomes.focus.status, 'completed', 'retry preserves the original successful Focus result');
});

test('Stop Both waits for Stop Focus device confirmation before dispatching screen-only unlock', async () => {
  const calls = [], updates = [];
  let focusConfirmed = false;
  const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT,
    waitOptions: { sleep: async () => {} }, onUpdate: update => updates.push(update),
    postCommand: async (type, payload, ids) => {
      calls.push([type, payload, ids]);
      if (type === 'unlock-screen') assert.equal(focusConfirmed, true, 'unlock cannot race a received Focus command');
      return { command: command(type, type === 'stop-focus' ? 'received' : 'completed') };
    },
    readCommand: async source => {
      assert.equal(source.id, 'stop-focus-a');
      assert.deepEqual(calls.map(call => call[0]), ['stop-focus']);
      focusConfirmed = true;
      return { command: command('stop-focus') };
    } });
  assert.deepEqual(calls, [['stop-focus', {}, [STUDENT]], ['unlock-screen', { screenOnly: true }, [STUDENT]]]);
  assert.equal(result.outcomes.focus.status, 'completed');
  assert.equal(result.outcomes.waypoint.status, 'completed');
  assert.ok(updates.some(update => update.pending && update.outcomes.focus.status === 'received'
    && !update.outcomes.waypoint), 'an HTTP receipt remains visibly pending');
  assert.equal(updates.find(update => update.outcomes.focus.status === 'received').outcomes.focus.status, 'received',
    'saved update snapshots cannot be rewritten by later device confirmation');
});

test('the default Stop Both wait reaches 60 seconds and leaves Waypoint available for a separate retry', async () => {
  let now = 0, sleeps = 0;
  const calls = [];
  const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT,
    waitOptions: { now: () => now, sleep: async milliseconds => { now += milliseconds; sleeps += 1; } },
    postCommand: async (...args) => { calls.push(args); return { command: command('stop-focus', 'received') }; },
    readCommand: async () => ({ command: command('stop-focus', 'received') }),
  });
  assert.equal(now, 60_000);
  assert.equal(sleeps, 80);
  assert.deepEqual(calls, [['stop-focus', {}, [STUDENT]]]);
  assert.equal(result.outcomes.focus.status, 'received');
  assert.equal(result.outcomes.waypoint, undefined);
  assert.match(result.phase, /Focus confirmation pending.*Clear Waypoint separately/);
  assert.equal(result.pending, false, 'the completed wait releases the operation guard without inventing confirmation');
});

test('every terminal Stop Focus failure still attempts eligible Waypoint clearing', async () => {
  for (const status of ['failed', 'unavailable', 'expired']) {
    const calls = [];
    const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT, readCommand: noRead,
      postCommand: async (type, payload, ids) => {
        calls.push([type, payload, ids]);
        return { command: command(type, type === 'stop-focus' ? status : 'completed') };
      } });
    assert.deepEqual(calls.map(call => call[0]), ['stop-focus', 'unlock-screen']);
    assert.equal(result.outcomes.focus.status, status);
    assert.equal(result.outcomes.waypoint.status, 'completed');
  }
});

test('a rejected Stop Focus request records its failure separately and still clears Waypoint', async () => {
  const calls = [];
  const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT, readCommand: noRead,
    postCommand: async (type) => {
      calls.push(type);
      if (type === 'stop-focus') throw new Error('Focus removal refused');
      return { command: command(type) };
    } });
  assert.deepEqual(calls, ['stop-focus', 'unlock-screen']);
  assert.equal(result.outcomes.focus.status, 'failed');
  assert.equal(result.outcomes.focus.error, 'Focus removal refused');
  assert.equal(result.outcomes.waypoint.status, 'completed');
});

test('partial Stop Both retains completed Focus and retries only the remaining Waypoint action', async () => {
  const calls = [];
  const postCommand = async (type, payload, ids) => {
    calls.push([type, payload, ids]);
    return { command: command(type, calls.length === 2 ? 'failed' : 'completed', {
      targets: [{ studentId: STUDENT, status: calls.length === 2 ? 'failed' : 'completed', errorMessage: calls.length === 2 ? 'Waypoint unavailable' : undefined }],
    }) };
  };
  const first = await runTileLockAction({ action: 'stop-both', studentId: STUDENT, readCommand: noRead, postCommand });
  assert.equal(first.outcomes.focus.status, 'completed');
  assert.equal(first.outcomes.waypoint.status, 'failed');
  assert.equal(first.outcomes.waypoint.error, 'Waypoint unavailable');
  const retry = await runTileLockAction({ action: 'clear-waypoint', studentId: STUDENT, readCommand: noRead, postCommand });
  assert.equal(retry.outcomes.waypoint.status, 'completed');
  assert.deepEqual(calls.map(call => call[0]), ['stop-focus', 'unlock-screen', 'unlock-screen']);
  assert.equal(first.outcomes.focus.status, 'completed', 'successful prior outcomes remain intact');
});

test('missing, multi-student, mismatched-type and replacement command responses cannot clear Waypoint', async () => {
  for (const data of [
    {},
    { command: command('stop-focus', 'completed', { targets: [] }) },
    { command: command('stop-focus', 'completed', { targets: [{ studentId: 'student-b', status: 'completed' }] }) },
    { command: command('stop-focus', 'completed', { targets: [{ studentId: STUDENT, status: 'completed' }, { studentId: 'student-b', status: 'completed' }] }) },
    { command: command('unlock-screen') },
    { commands: [command('stop-focus'), command('stop-focus', 'completed', { id: 'another-command' })] },
  ]) {
    const calls = [];
    const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT, readCommand: noRead,
      postCommand: async type => { calls.push(type); return data; } });
    assert.deepEqual(calls, ['stop-focus']);
    assert.equal(result.outcomes.focus.status, 'pending');
    assert.equal(result.outcomes.waypoint, undefined);
  }
  const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT,
    waitOptions: { sleep: async () => {} }, postCommand: async () => ({ command: command('stop-focus', 'received') }),
    readCommand: async () => ({ command: command('stop-focus', 'completed', { id: 'replacement-command' }) }),
  });
  assert.equal(result.outcomes.focus.status, 'pending');
  assert.match(result.outcomes.focus.error, /did not match/);
  assert.equal(result.outcomes.waypoint, undefined);
});

test('status read failures never become confirmation or dispatch the second action', async () => {
  const calls = [];
  const result = await runTileLockAction({ action: 'stop-both', studentId: STUDENT, waitOptions: { sleep: async () => {} },
    postCommand: async type => { calls.push(type); return { command: command(type, 'received') }; },
    readCommand: async () => { throw new Error('Status connection unavailable'); } });
  assert.deepEqual(calls, ['stop-focus']);
  assert.equal(result.outcomes.focus.status, 'pending');
  assert.equal(result.outcomes.focus.error, 'Status connection unavailable');
  assert.equal(result.outcomes.waypoint, undefined);
});

test('student binding or authority changes abort remaining Stop Both dispatches', async () => {
  for (const during of ['post', 'read']) {
    let current = true;
    const calls = [];
    await assert.rejects(runTileLockAction({ action: 'stop-both', studentId: STUDENT,
      assertCurrent: () => { if (!current) throw new Error('Classroom authority changed'); },
      waitOptions: { sleep: async () => {} },
      postCommand: async type => {
        calls.push(type);
        if (during === 'post') current = false;
        return { command: command(type, during === 'read' ? 'received' : 'completed') };
      },
      readCommand: async () => { current = false; return { command: command('stop-focus') }; },
    }), /Classroom authority changed/);
    assert.deepEqual(calls, ['stop-focus']);
  }
});

test('cancellation during device confirmation prevents Waypoint clearing', async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(runTileLockAction({ action: 'stop-both', studentId: STUDENT, signal: controller.signal,
    waitOptions: { sleep: async () => controller.abort() },
    postCommand: async type => { calls.push(type); return { command: command(type, 'received') }; },
    readCommand: noRead,
  }), { name: 'AbortError' });
  assert.deepEqual(calls, ['stop-focus']);
});

test('missing students, unknown actions and mismatched Focus targets never dispatch a command', async () => {
  for (const parameters of [
    { action: 'stop-both', studentId: '' },
    { action: 'lock-screen', studentId: STUDENT },
    { action: 'focus-current-tab', studentId: STUDENT },
    { action: 'focus-current-tab', studentId: STUDENT, focusPayload: { tabTargets: [{ studentId: 'student-b' }] } },
    { action: 'focus-current-tab', studentId: STUDENT, focusPayload: { tabTargets: [{ studentId: STUDENT }, { studentId: 'student-b' }] } },
  ]) await assert.rejects(runTileLockAction({ ...parameters, readCommand: noRead, postCommand: async () => assert.fail('No command is authorized') }));
});

test('authority keys ignore control revisions but detect binding, scope and ownership changes', () => {
  const student = { studentId: STUDENT, realtimeBinding: 'binding-a', contextId: 'coverage-a', contextAuthorityRevision: 3, controlRevision: 9 };
  const key = tileLockAuthorityKey('school-a:class-a', student);
  assert.equal(tileLockAuthorityKey('school-a:class-a', { ...student, controlRevision: 10 }), key);
  for (const changed of [
    { ...student, studentId: 'student-b' }, { ...student, realtimeBinding: 'binding-b' },
    { ...student, contextId: 'coverage-b' }, { ...student, contextAuthorityRevision: 4 },
  ]) assert.notEqual(tileLockAuthorityKey('school-a:class-a', changed), key);
  assert.notEqual(tileLockAuthorityKey('school-a:class-b', student), key);
});
