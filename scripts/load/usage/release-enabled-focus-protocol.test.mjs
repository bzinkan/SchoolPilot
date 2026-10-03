import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { focusClassroomAcknowledgement, publicFocusProjectionMatches } from './release-enabled-protocol.mjs';
const school = { id: 'school', currentSession: 'class-session', students: ['student'], studentSessions: ['student-session'], devices: ['device'] };
const frame = () => ({ commandId: 'command', command: { commandId: 'command' }, studentId: 'student', studentSessionId: 'student-session',
  exactBinding: { schoolId: 'school', studentId: 'student', studentSessionId: 'student-session', deviceId: 'device', controlRevision: 7 },
  classroomState: { teachingSessionId: 'class-session', revision: 7, authPassThroughPolicyRevision: 2,
    restrictions: { focus: { active: true, assignmentId: 'delivered-assignment', tabRef: 'synthetic-tab-0', observedRevision: 9 } } } });
const active = () => focusClassroomAcknowledgement(frame(), school, 0, 'focus-tab', 'command');
const row = expected => ({ studentId: expected.studentId, realtimeBinding: expected.realtimeBinding, enforcementHealth: 'synced',
  classroomState: frame().classroomState });
test('Focus state ACK uses the packaged field and exact delivered revision, assignment and binding', () => {
 const proof=active(); assert.deepEqual(proof.classroomAck.focusStatus,{state:'active',assignmentId:'delivered-assignment'});
 assert.equal(Object.hasOwn(proof.classroomAck,'focus'),false); assert.equal(proof.classroomAck.appliedRevision,7);
 assert.equal(proof.classroomAck.appliedAuthPolicyRevision,2); assert.equal(proof.classroomAck.teachingSessionId,'class-session');
 assert.equal(publicFocusProjectionMatches(row(proof),proof),true);
});
test('missing or mismatched transport proof cannot produce a synthetic successful ACK', () => {
 for(const mutate of [f=>delete f.exactBinding,f=>{f.studentSessionId='replacement'},f=>{f.exactBinding.deviceId='replacement'},
  f=>delete f.classroomState,f=>{f.classroomState.revision=8},f=>{f.classroomState.teachingSessionId='other-class'},
  f=>{f.classroomState.supervisionContextId='supervision'},f=>delete f.classroomState.restrictions.focus.assignmentId,
  f=>{f.classroomState.restrictions.focus.tabRef='replacement'},f=>{f.classroomState.restrictions.focus.observedRevision=10}]) {
   const input=frame();mutate(input);assert.throws(()=>focusClassroomAcknowledgement(input,school,0,'focus-tab','command'));
 }
});
test('public verification never accepts another student, session, revision, assignment or pending state', () => {
 const proof=active();for(const mutate of [r=>{r.studentId='other'},r=>{r.realtimeBinding='replacement'},
  r=>{r.classroomState.teachingSessionId='other'},r=>{r.classroomState.revision=6},r=>{r.classroomState.revision=8},
  r=>{r.classroomState.supervisionContextId='other'},r=>{r.enforcementHealth='pending'},r=>{r.classroomState.restrictions.focus.assignmentId='other'},
  r=>{r.classroomState.restrictions.focus.active=false}]) {const candidate=structuredClone(row(proof));mutate(candidate);assert.equal(publicFocusProjectionMatches(candidate,proof),false);}
});
test('Stop Focus ACK and public proof require exact cleared revision',()=>{
 const input=frame();input.classroomState.revision=8;input.exactBinding.controlRevision=8;delete input.classroomState.restrictions.focus;
 const proof=focusClassroomAcknowledgement(input,school,0,'stop-focus','command');assert.deepEqual(proof.classroomAck.focusStatus,{state:'inactive'});
 const projected={...row(proof),classroomState:input.classroomState};assert.equal(publicFocusProjectionMatches(projected,proof),true);
 projected.classroomState.restrictions.focus={active:true,assignmentId:'old'};assert.equal(publicFocusProjectionMatches(projected,proof),false);
});
test('legacy focus wire-key mutation fails the packaged contract assertion',async()=>{
 const text=fs.readFileSync(new URL('./release-enabled-protocol.mjs',import.meta.url),'utf8');
 const needle='outcome: \'applied\', focusStatus, teachingSessionId:';
 assert.equal(text.split(needle).length,2);
 const mutated=text.replace(needle,'outcome: \'applied\', focus: focusStatus, teachingSessionId:');
 const bad=await import('data:text/javascript;base64,'+Buffer.from(mutated).toString('base64'));
 assert.throws(()=>assert.deepEqual(bad.focusClassroomAcknowledgement(frame(),school,0,'focus-tab','command').classroomAck.focusStatus,
  {state:'active',assignmentId:'delivered-assignment'}));
});
test('lifecycle state ACK/public confirmation precedes command completion; ordinary heartbeat and claims stay unchanged',()=>{
 const code=fs.readFileSync(new URL('./release-enabled-generator.mjs',import.meta.url),'utf8');
 const start=code.indexOf('async function command('),end=code.indexOf('async function lifecycle()',start),section=code.slice(start,end);
 assert.ok(section.indexOf('connection.socket.send(JSON.stringify(focusProof.classroomAck))')<section.indexOf('await assertPublicFocusApplied'));
 assert.ok(section.indexOf('await assertPublicFocusApplied')<section.indexOf("request('/api/classpilot/device/command-acks'"));
 assert.ok(section.includes('focusStatus: focusProof.focusStatus'));
 assert.ok(code.includes('simulatedClientAcknowledgements: true, browserEnforcementClaimed: false'));
});
