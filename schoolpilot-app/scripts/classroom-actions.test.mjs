import assert from 'node:assert/strict';
import test from 'node:test';
import { classroomLinks, classroomCanFocus, classroomLessonStarts, reviewedFlightPathMatches, runClassroomAction, waitForClassroomTargets }
  from '../src/products/classpilot/lib/classroomActions.js';

const target = (studentId, status = 'completed', result = {}) => ({ studentId, status, result });
const command = (id, targets, commandType = 'apply-flight-path') => ({ id, commandType, teachingSessionId: 'class-a', targets });
const flightPath = { id: 'lesson-a', updatedAt: '2026-09-30T12:00:00.000Z' };
const noRead = async () => { throw new Error('Unexpected status read'); };

test('Open + Focus requires accepted capabilities and does not trust raw extension advertisement', () => {
  assert.equal(classroomCanFocus([{ acceptedCapabilities: [], extensionCapabilities: ['scopedAuthorityChecksV1', 'focusTabV1'] }]), false);
  assert.equal(classroomCanFocus([{ acceptedCapabilities: ['scopedAuthorityChecksV1', 'focusTabV1'] }]), true);
});

test('Website lesson starts keep the selected assignment URL inside the reviewed hostname boundary', () => {
  const preview = { boundary: 'website', scopes: [{ url: 'https://classroom.google.com', label: 'Entire website' }], authoring: { allowedDomains: ['classroom.google.com'] } };
  const choices = [{ url: 'https://classroom.google.com/c/course/a/assignment/details', title: 'Assignment' }, { url: 'https://other.test/', title: 'Excluded' }];
  assert.deepEqual(classroomLessonStarts(preview, choices), [{ url: choices[0].url, label: 'Assignment' }]);
});

test('Classroom browser links discard credentials, unsafe schemes and duplicate URLs', () => {
  assert.deepEqual(classroomLinks({ id: 'a', links: [{ url: 'javascript:alert(1)' }, { url: 'https://person:secret@example.test/' },
    { url: 'https://example.test/lesson', title: 'Lesson' }, { url: 'https://example.test/lesson' }] }),
  [{ id: 'a:2', url: 'https://example.test/lesson', title: 'Lesson' }]);
});

test('returned lesson must retain exactly the reviewed resource policy with no additional blocks or domains', () => {
  const authoring = { allowedDomains: [], resources: [{ url: 'https://docs.google.com/document/d/Doc_A/edit' }] };
  const saved = { allowedDomains: [], blockedDomains: [], resources: [{ type: 'resource', canonicalUrl: authoring.resources[0].url }] };
  assert.equal(reviewedFlightPathMatches(saved, authoring), true);
  for (const changed of [{ ...saved, allowedDomains: ['google.com'] }, { ...saved, resources: [] }, { ...saved, blockedDomains: ['example.test'] }])
    assert.equal(reviewedFlightPathMatches(changed, authoring), false);
  assert.equal(reviewedFlightPathMatches({ allowedDomains: ['example.test'], blockedDomains: [] }, { allowedDomains: ['example.test'], resources: [] }), true);
});

test('Open is one explicit student-scoped request and adds no restriction or Focus', async () => {
  const calls = [];
  const result = await runClassroomAction({ action: 'open', url: 'https://example.test/task', studentIds: ['a', 'b'], readCommand: noRead,
    postCommand: async (...args) => { calls.push(args); return { command: command('open-a', [target('a'), target('b', 'unavailable')], 'open-tab') }; } });
  assert.deepEqual(calls, [['open-tab', { url: 'https://example.test/task' }, ['a', 'b']]]);
  assert.equal(result[0].open, 'completed'); assert.equal(result[1].open, 'unavailable');
});

test('Lesson opens only the applied target and includes the same exact source command prerequisite', async () => {
  const calls = [];
  const result = await runClassroomAction({ action: 'lesson', url: 'https://example.test/task', studentIds: ['a', 'b', 'c'], flightPath, readCommand: noRead,
    postCommand: async (...args) => {
      calls.push(args);
      return args[0] === 'apply-flight-path' ? { command: command('restriction-a', [target('a', 'completed', { outcome: 'applied' }),
        target('b', 'failed', { outcome: 'failed' }), target('c', 'completed', { outcome: 'unsupported' })]) }
        : { command: command('open-a', [target('a')], 'open-tab') };
    } });
  assert.deepEqual(calls, [['apply-flight-path', { flightPathId: 'lesson-a', expectedFlightPathUpdatedAt: flightPath.updatedAt }, ['a', 'b', 'c']],
    ['open-tab', { url: 'https://example.test/task', afterRestrictionCommandId: 'restriction-a' }, ['a']]]);
  assert.equal(result[1].open, 'not opened'); assert.equal(result[2].open, 'not opened');
});

test('a received restriction waits for its exact command and cannot open early', async () => {
  const calls = [], updates = [];
  await runClassroomAction({ action: 'lesson', url: 'https://example.test/task', studentIds: ['a'], flightPath,
    waitOptions: { sleep: async () => {} }, onUpdate: rows => updates.push(structuredClone(rows)),
    readCommand: async source => { assert.deepEqual(calls.map(row => row[0]), ['apply-flight-path']); assert.equal(source.id, 'restriction-a');
      return { command: command('restriction-a', [target('a', 'completed', { outcome: 'applied' })]) }; },
    postCommand: async (...args) => { calls.push(args); return { command: command(args[0] === 'apply-flight-path' ? 'restriction-a' : 'open-a',
      [target('a', args[0] === 'apply-flight-path' ? 'received' : 'completed')], args[0]) }; } });
  assert.equal(updates[0][0].open, 'not requested'); assert.equal(calls.length, 2);
});

test('server-issued Focus continuation remains pending until its own device confirmation', async () => {
  const updates = [], reads = [];
  const result = await runClassroomAction({ action: 'open-focus', url: 'https://duplicate.test/', studentIds: ['a'],
    waitOptions: { sleep: async () => {} }, onUpdate: rows => updates.push(structuredClone(rows)),
    postCommand: async (type, payload, ids) => { assert.equal(type, 'open-tab'); assert.deepEqual(payload, { url: 'https://duplicate.test/', focusAfterOpen: true }); assert.deepEqual(ids, ['a']);
      return { command: command('open-a', [target('a', 'completed', { followUp: { kind: 'focus', state: 'committed', commandId: 'focus-exact-a' } })], type) }; },
    readCommand: async source => { reads.push(source.id); return { command: command('focus-exact-a', [target('a', reads.length === 1 ? 'received' : 'completed')], 'focus-tab') }; } });
  assert.deepEqual(reads, ['focus-exact-a', 'focus-exact-a']);
  assert.ok(updates.some(rows => rows[0].open === 'completed' && rows[0].focus === 'received'));
  assert.equal(result[0].focus, 'completed');
});

test('Focus refusal cannot fall back to another tab with a duplicate URL', async () => {
  const result = await runClassroomAction({ action: 'open-focus', url: 'https://duplicate.test/', studentIds: ['a'], readCommand: noRead,
    postCommand: async () => ({ command: command('open-a', [target('a', 'completed', { followUp: { kind: 'focus', state: 'refused' } })], 'open-tab') }) });
  assert.equal(result[0].open, 'completed'); assert.equal(result[0].focus, 'refused');
});

test('authority change after applied confirmation prevents the dependent open', async () => {
  let current = true; const calls = [];
  await assert.rejects(runClassroomAction({ action: 'lesson', url: 'https://example.test/task', studentIds: ['a'], flightPath,
    waitOptions: { sleep: async () => {} }, assertCurrent: () => { if (!current) throw new Error('Authority changed'); },
    postCommand: async (...args) => { calls.push(args); return { command: command('restriction-a', [target('a', 'pending')]) }; },
    readCommand: async () => { current = false; return { command: command('restriction-a', [target('a', 'completed', { outcome: 'applied' })]) }; },
  }), /Authority changed/);
  assert.equal(calls.length, 1);
});

test('a changed source command and a timed-out pending target stay unconfirmed', async () => {
  const original = command('restriction-a', [target('a', 'pending')]);
  await assert.rejects(waitForClassroomTargets(original, ['a'], { sleep: async () => {}, readCommand: async () => ({ command: command('replacement-b', [target('a')]) }) }), /did not match/);
  assert.equal((await waitForClassroomTargets(original, ['a'], { timeoutMs: 0, readCommand: noRead }))[0].status, 'pending');
});

test('missing or duplicated targets never become a class-wide command', async () => {
  for (const studentIds of [[], ['a', 'a']]) await assert.rejects(runClassroomAction({ action: 'open', url: 'https://example.test/', studentIds,
    readCommand: noRead, postCommand: async () => assert.fail('Cannot send missing targets') }), /explicit students/);
});

test('Website lesson starts normalize one terminal hostname dot without admitting unrelated hosts', () => {
  const preview = { boundary: 'website', scopes: [{ url: 'https://example.test', label: 'Entire website' }], authoring: { allowedDomains: ['example.test'] } };
  const choices = [
    { url: 'https://example.test./lesson', title: 'Root lesson' },
    { url: 'https://class.example.test./lesson', title: 'Subdomain lesson' },
    { url: 'https://example.test../lesson', title: 'Two terminal dots' },
    { url: 'https://notexample.test./lesson', title: 'Suffix spoof' },
    { url: 'https://example.test.attacker.test./lesson', title: 'Unrelated host' },
  ];
  assert.deepEqual(classroomLessonStarts(preview, choices), [
    { url: choices[0].url, label: 'Root lesson' },
    { url: choices[1].url, label: 'Subdomain lesson' },
  ]);
});
