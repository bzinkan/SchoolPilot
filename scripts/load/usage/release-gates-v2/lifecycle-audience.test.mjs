import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lifecycleAudience, verifyClassroomBindings, sanitizedClassroomOracleFailure } from './lifecycle-audience.mjs';
import { PROFILES } from './contracts.mjs';
import { patchGeneratorV2 } from './patch.mjs';
import { runNegativeProbes, retainCompletedGeneratorTraffic } from './measurements.mjs';
import {validateRound} from './validation.mjs';

const schools = [0, 1].map(index => ({ index, id: 'school-' + index,
  teachers: ['teacher-' + index], currentSession: 'class-' + index,
  students: Array.from({ length: 500 }, (_, i) => `student-${index}-${i}`),
  devices: Array.from({ length: 500 }, (_, i) => `device-${index}-${i}`),
  studentSessions: Array.from({ length: 500 }, (_, i) => `binding-${index}-${i}`) }));
const fixture = { schools };
function rows(profile) {
  const audience = lifecycleAudience(profile, schools), commands = [], messages = [],deliveries=[],threads=[],memberships=[],staff=[],schoolSettings=[],activitySettings=[];
  for(const i of audience.schoolIndices){const school=schools[i];threads.push({id:'thread-'+i,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession,supervision_context_id:null,authority_assignment_id:'assignment-'+i,generation:audience.repetitions+1});
    memberships.push({id:'assignment-'+i,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession});
    staff.push({school_id:school.id,teaching_session_id:school.currentSession,staff_id:school.teachers[0]});schoolSettings.push({school_id:school.id,private_chat_epoch:1,student_messaging_enabled:true});
    activitySettings.push({school_id:school.id,session_id:school.currentSession,supervision_context_id:null,private_chat_epoch:1,chat_enabled:true});}
  for (const i of audience.schoolIndices) for (let n = 0; n < audience.repetitions; n++) {
    const school = schools[i];
    for (const type of ['lock-screen', 'focus-tab', 'stop-focus', 'unlock-screen']) {
      const target = ['lock-screen', 'unlock-screen'].includes(type) ? 0 : 1;
      commands.push({ school_id: school.id, teacher_id: school.teachers[0], teaching_session_id: school.currentSession,
        command_type: type, target_scope: 'students', target_count: 1, student_id: school.students[target],
        student_session_id: school.studentSessions[target], device_id: school.devices[target], status: 'completed' });
    }
    for (const status of ['delivered', 'expired']) {const id=`message-${i}-${n}-${status}`;messages.push({id,school_id: school.id, session_id: school.currentSession,supervision_context_id:null,
      sender_id: school.teachers[0], student_id: school.students[2], recipient_id: school.devices[2],
      student_session_id:null,device_id: school.devices[2],delivery_status:status==='delivered'?'delivered':'sent',delivered_at:status==='delivered'?'2026-10-04T00:00:00Z':null,
      private_chat_thread_id:'thread-'+i,private_chat_school_epoch:1,private_chat_activity_epoch:1,private_chat_generation:n+1});
      deliveries.push({id:'delivery-'+id,chat_message_id:id,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession,supervision_context_id:null,
        state:status==='delivered'?'delivered':'attempted',attempt_count:1,last_attempt_at:'2026-10-04T00:00:00Z',last_attempt_student_session_id:school.studentSessions[2],last_attempt_device_id:school.devices[2],delivered_at:status==='delivered'?'2026-10-04T00:00:00Z':null});}
  }
  return { commands, messages,deliveries,threads,memberships,staff,schoolSettings,activitySettings,fixture,profile };
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
test('canonical teacher history uses transport recipient and relational expiry without worker materialization',()=>{
  const input=rows(PROFILES.classroom);assert.equal(input.messages[0].student_session_id,null);assert.equal(input.messages[1].delivery_status,'sent');
  assert.equal(input.deliveries[1].state,'attempted');assert.equal(verifyClassroomBindings(input).passed,true);
});
test('missing duplicate foreign and rebound durable deliveries reject independently',()=>{
  const mutations=[input=>input.deliveries.pop(),input=>input.deliveries.push({...input.deliveries[0]}),
    input=>input.deliveries.push({...input.deliveries[0],chat_message_id:'foreign-parent'}),
    input=>input.deliveries[0].school_id=schools[1].id,input=>input.deliveries[0].student_id=schools[0].students[3],
    input=>input.deliveries[0].last_attempt_student_session_id=schools[0].studentSessions[3],input=>input.deliveries[0].last_attempt_device_id=schools[0].devices[3],
    input=>input.deliveries[0].teaching_session_id='wrong-class',input=>input.messages[0].recipient_id=schools[0].students[2]];
  for(const mutate of mutations){const input=rows(PROFILES.classroom);mutate(input);assert.throws(()=>verifyClassroomBindings(input));}
});
test('wrong lifecycle assignment epochs generation and missing sender authority reject',()=>{
  for(const mutate of [input=>input.threads[0].authority_assignment_id='foreign-assignment',input=>input.threads[0].student_id=schools[0].students[3],
    input=>input.messages[1].private_chat_generation=2,input=>input.messages[1].private_chat_school_epoch=2,
    input=>input.messages[1].private_chat_activity_epoch=2,input=>input.schoolSettings[0].student_messaging_enabled=false,
    input=>input.threads[0].generation=1,input=>input.staff.pop(),input=>input.messages[1].delivery_status='expired']){
    const input=rows(PROFILES.classroom);mutate(input);assert.throws(()=>verifyClassroomBindings(input));}
});
test('never attempted expired rows retain null transport facts without claiming delivery',()=>{
  const input=rows(PROFILES.classroom),row=input.messages[1],child=input.deliveries[1];row.device_id=null;row.recipient_id=null;
  Object.assign(child,{attempt_count:0,last_attempt_at:null,last_attempt_student_session_id:null,last_attempt_device_id:null,state:'expired'});
  const result=verifyClassroomBindings(input);assert.equal(result.passed,true);assert.equal(result.unattemptedExpiredMessages,1);assert.equal(result.attemptedExpiredMessages,1);
  child.last_attempt_device_id=schools[0].devices[2];assert.throws(()=>verifyClassroomBindings(input),error=>error.code==='CLASSROOM_ORACLE_MESSAGE_TARGET_BINDING');
});
test('attempt metadata cannot contradict accepted delivery history',()=>{
  for(const value of [null,'invalid-time']){const input=rows(PROFILES.classroom);input.deliveries[0].last_attempt_at=value;assert.throws(()=>verifyClassroomBindings(input),error=>error.code==='CLASSROOM_ORACLE_DELIVERY_ATTEMPT');}
});
test('one-school minute expects its single exact negative probe; idle schools add no obligations',()=>{
  const probe={requestId:'00000000-0000-0000-0000-000000000001',status:409,code:'PRIVATE_CHAT_LIFECYCLE_STALE'};
  const round={topology:{active:[0],distribution:'uniform'},traffic:{lifecycle:{passed:true,expectedNegativeProbes:[probe]}}};
  assert.equal(validateRound(round,PROFILES.mixedNative).checks.classroom,true);
  round.traffic.lifecycle.expectedNegativeProbes.push({...probe,requestId:'00000000-0000-0000-0000-000000000002'});
  assert.equal(validateRound(round,PROFILES.mixedNative).checks.classroom,false);
});
test('native-binding profile keeps original workload and requires an independent row receipt',()=>{
  for(const [prior,next] of [[PROFILES.classroom,PROFILES.classroomNative],[PROFILES.mixed,PROFILES.mixedNative]]){
    const {name:_name,classroomBindingOracle:_oracle,...unchanged}=next;
    const {name:_prior,...original}=prior;assert.deepEqual(unchanged,original);
    const round={topology:{active:[0],distribution:'uniform'},traffic:{lifecycle:{passed:false}}};
    assert.equal(validateRound(round,next).checks.nativeClassroomBindings,false);
    round.classroomBindings={passed:true,nativeRowsSha256:'a'.repeat(64)};
    assert.equal(validateRound(round,next).checks.nativeClassroomBindings,true);
  }
});
