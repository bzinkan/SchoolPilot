import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lifecycleAudience, verifyClassroomBindings, sanitizedClassroomOracleFailure } from './lifecycle-audience.mjs';
import { PROFILES } from './contracts.mjs';
import { patchGeneratorV2 } from './patch.mjs';
import { runNegativeProbes, retainCompletedGeneratorTraffic } from './measurements.mjs';

const schools = [0, 1].map(index => ({ index, id: 'school-' + index,
  teachers: ['teacher-' + index], currentSession: 'class-' + index,
  students: Array.from({ length: 500 }, (_, i) => `student-${index}-${i}`),
  devices: Array.from({ length: 500 }, (_, i) => `device-${index}-${i}`),
  studentSessions: Array.from({ length: 500 }, (_, i) => `binding-${index}-${i}`) }));
const fixture = { schools };
function rows(profile) {
  const audience = lifecycleAudience(profile, schools), commands = [], messages = [];
  for (const i of audience.schoolIndices) for (let n = 0; n < audience.repetitions; n++) {
    const school = schools[i];
    for (const type of ['lock-screen', 'focus-tab', 'stop-focus', 'unlock-screen']) {
      const target = ['lock-screen', 'unlock-screen'].includes(type) ? 0 : 1;
      commands.push({ school_id: school.id, teacher_id: school.teachers[0], teaching_session_id: school.currentSession,
        command_type: type, target_scope: 'students', target_count: 1, student_id: school.students[target],
        student_session_id: school.studentSessions[target], device_id: school.devices[target], status: 'completed' });
    }
    for (const status of ['delivered', 'expired']) messages.push({ school_id: school.id, session_id: school.currentSession,
      sender_id: school.teachers[0], student_id: school.students[2], recipient_id: school.students[2],
      student_session_id: school.studentSessions[2], device_id: school.devices[2], delivery_status: status });
  }
  return { commands, messages, fixture, profile };
}

test('generated positive lifecycle never targets preflight-only inactive school', () => {
  const source = readFileSync(new URL('../release-enabled-generator.mjs', import.meta.url), 'utf8');
  const generated = patchGeneratorV2(source);
  const lifecycle = generated.slice(generated.indexOf('async function lifecycle()'));
  const rhs = lifecycle.match(/for \(const school of (.+)\) \{/)[1];
  const selected = Function('schools', 'v2Profile', 'lifecycleAudience', 'return (' + rhs + ');')(schools, PROFILES.mixed, lifecycleAudience);
  assert.deepEqual(selected.map(school => school.index), [0]);
});
test('one-school continuous oracle retains all 15 complete exact-bound lifecycles', () => {
  const result = verifyClassroomBindings(rows(PROFILES.mixed));
  assert.equal(result.commandTargetsChecked, 60);
  assert.equal(result.privateBindingsChecked, 30);
  assert.deepEqual(result.declaredSchoolIndices, [0]);
});
test('two-school classroom and Usage profiles retain both positive audiences', () => {
  for (const profile of [PROFILES.classroom, PROFILES.usage]) {
    assert.deepEqual(lifecycleAudience(profile, schools).schoolIndices, [0, 1]);
    const result = verifyClassroomBindings(rows(profile));
    assert.equal(result.commandTargetsChecked, 8);
    assert.equal(result.privateBindingsChecked, 4);
  }
});
test('too few active controls and malformed active fixture bindings fail', () => {
  assert.throws(() => lifecycleAudience({ ...PROFILES.mixed, continuousOffering: { schoolDevices: [1, 0] } }, schools));
  assert.throws(() => lifecycleAudience({ ...PROFILES.mixed, continuousOffering: { schoolDevices: [2, 0] } }, schools));
  assert.throws(() => lifecycleAudience(PROFILES.mixed, [{ ...schools[0], index: 1 }, schools[1]]));
  assert.throws(() => lifecycleAudience(PROFILES.mixed, [{ ...schools[0], studentSessions: [] }, schools[1]]));
});
test('fulfilled generator evidence survives an independently failed topology', () => {
  const traffic = { heartbeats: { offered: 11970 }, lifecycle: { rounds: [{ expectedNegativeProbes: [] }] } };
  const settled = [{ status: 'fulfilled', value: traffic }, { status: 'rejected', reason: Error('topology failed') }];
  const metrics = {}, records = [];
  retainCompletedGeneratorTraffic(settled, metrics, (name, value) => records.push({ name, value }));
  assert.equal(metrics.continuousTraffic, traffic);
  assert.deepEqual(records, [{ name: 'continuous-traffic.json', value: traffic }]);
  assert.equal(settled.some(result => result.status === 'rejected'), true);
  assert.equal(metrics.runPassed, undefined);
});
test('public oracle failure excludes extras and rejects arbitrary labels or counts', () => {
  const evidence = { predicate: 'COMMAND_TARGET_STATUS', declaredSchoolIndices: [0], repetitions: 15,
    observedCommands: 60, expectedCommands: 60, observedMessages: 30, expectedMessages: 30, secret: 'private-fixture-id' };
  const result = sanitizedClassroomOracleFailure({ code: 'CLASSROOM_ORACLE_COMMAND_TARGET_STATUS', oracle: evidence });
  assert.equal(JSON.stringify(result).includes('private-fixture-id'), false);
  assert.throws(() => sanitizedClassroomOracleFailure({ code: 'CLASSROOM_ORACLE_COMMAND_TARGET_STATUS', oracle: { ...evidence, predicate: 'private-secret' } }));
  assert.throws(() => sanitizedClassroomOracleFailure({ code: 'CLASSROOM_ORACLE_COMMAND_TARGET_STATUS', oracle: { ...evidence, observedCommands: 'private-secret' } }));
});
test('all persisted idle-school and same-school wrong-recipient writes are rejected', () => {
  const input = rows(PROFILES.mixed);
  input.commands.push(rows(PROFILES.classroom).commands.find(row => row.school_id === schools[1].id));
  assert.throws(() => verifyClassroomBindings(input), error => error.code === 'CLASSROOM_ORACLE_DECLARED_AUDIENCE');
  const wrong = rows(PROFILES.mixed); wrong.messages[0].recipient_id = schools[0].students[3];
  assert.throws(() => verifyClassroomBindings(wrong), error => error.code === 'CLASSROOM_ORACLE_MESSAGE_TARGET_BINDING');
});
test('incomplete cleanup, missing actions and duplicate replacement actions fail', () => {
  const incomplete = rows(PROFILES.mixed); incomplete.commands[0].status = 'pending';
  assert.throws(() => verifyClassroomBindings(incomplete), error => error.code === 'CLASSROOM_ORACLE_COMMAND_TARGET_STATUS');
  const missing = rows(PROFILES.mixed); missing.commands.pop();
  assert.throws(() => verifyClassroomBindings(missing), error => error.code === 'CLASSROOM_ORACLE_COMMAND_CARDINALITY');
  const duplicate = rows(PROFILES.mixed); duplicate.commands[3] = duplicate.commands[0];
  assert.throws(() => verifyClassroomBindings(duplicate), error => error.code === 'CLASSROOM_ORACLE_COMMAND_TYPE_COUNTS');
});
test('failed global oracle preserves only fully captured exact negative probe evidence', () => {
  const probe = { requestId: '00000000-0000-0000-0000-000000000001', status: 409, code: 'PRIVATE_CHAT_LIFECYCLE_STALE' };
  assert.deepEqual(runNegativeProbes({ rounds: [], continuousTraffic: { lifecycle: { rounds: [{ expectedNegativeProbes: [probe] }] } } }), [probe]);
});
test('oracle failure evidence contains counts and predicate, never fixture identifiers', () => {
  const input = rows(PROFILES.mixed); input.commands[0].device_id = 'private-wrong-device';
  assert.throws(() => verifyClassroomBindings(input), error => {
    assert.equal(error.code, 'CLASSROOM_ORACLE_COMMAND_TARGET_BINDING');
    const evidence = JSON.stringify(error.publicOracleEvidence);
    assert.equal(evidence.includes('private-wrong-device'), false);
    assert.equal(evidence.includes('school-0'), false);
    assert.equal(error.publicOracleEvidence.observedCommands, 60);
    return true;
  });
});
