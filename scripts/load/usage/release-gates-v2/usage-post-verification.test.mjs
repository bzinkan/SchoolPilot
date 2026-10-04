import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROFILES,profileHash,hash} from './contracts.mjs';
import {declareCampaign,reserveAttempt} from './campaign.mjs';
import {verifyClassroomBindings} from './lifecycle-audience.mjs';
import {retainCompletedGeneratorTraffic,runNegativeProbes} from './measurements.mjs';
import {USAGE_POST_VERIFICATION_CONTRACT,usagePostVerificationHash,assertUsagePostVerificationBinding,
  assertUsagePostVerificationReservation,assertUsagePostVerificationReceiptBinding,
  assertUsagePostVerificationEvidence,verifyUsageClassroomAfterLoad,verifyUsagePostVerificationCustody,
  assertUsagePostVerificationSet} from './usage-post-verification.mjs';

const source='a'.repeat(40),hostSource='b'.repeat(40),helper='sha256:'+'c'.repeat(64);
const frozenOriginalUsageJson='{"name":"release297-usage-shared-db-three-api-100-v2","kind":"usage","offering":{"requestsPerSecond":100,"schoolDevices":[500,500],"durationMs":60000,"deviceCadenceMs":10000,"expected":6000,"maxInFlight":1000,"requestTimeoutMs":20000,"maxOfferLatenessMs":100},"usage":true,"apiTasks":3,"repetitions":3,"reports":64,"rawPerSchool":1000000,"workerAcceptanceMs":48000,"pairedReleaseComparisonRequired":true}';
const write=(path,value)=>writeFileSync(path,JSON.stringify(value)+'\n');
function input(){
 const schools=[0,1].map(index=>({index,id:'school-'+index,teachers:['teacher-'+index],currentSession:'activity-'+index,
   students:Array.from({length:500},(_,n)=>`student-${index}-${n}`),devices:Array.from({length:500},(_,n)=>`device-${index}-${n}`),
   studentSessions:Array.from({length:500},(_,n)=>`session-${index}-${n}`)}));
 const fixture={schools},native={commands:[],messages:[],deliveries:[],threads:[],schoolSettings:[],activitySettings:[],memberships:[],staff:[]};
 for(const school of schools){
  const i=school.index;
  native.threads.push({id:'thread-'+i,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession,
   supervision_context_id:null,authority_assignment_id:'assignment-'+i,generation:2});
  native.memberships.push({id:'assignment-'+i,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession});
  native.staff.push({school_id:school.id,teaching_session_id:school.currentSession,staff_id:school.teachers[0]});
  native.schoolSettings.push({school_id:school.id,private_chat_epoch:1,student_messaging_enabled:true});
  native.activitySettings.push({school_id:school.id,session_id:school.currentSession,supervision_context_id:null,private_chat_epoch:1,chat_enabled:true});
  for(const type of ['lock-screen','focus-tab','stop-focus','unlock-screen']){
   const target=['lock-screen','unlock-screen'].includes(type)?0:1;
   native.commands.push({school_id:school.id,teacher_id:school.teachers[0],teaching_session_id:school.currentSession,command_type:type,target_scope:'students',
     target_count:1,student_id:school.students[target],student_session_id:school.studentSessions[target],device_id:school.devices[target],status:'completed'});
  }
  for(const delivered of [true,false]){
   const id=`message-${i}-${delivered}`;
   native.messages.push({id,school_id:school.id,session_id:school.currentSession,supervision_context_id:null,sender_id:school.teachers[0],
    student_id:school.students[2],recipient_id:school.devices[2],student_session_id:null,device_id:school.devices[2],delivery_status:delivered?'delivered':'sent',
    delivered_at:delivered?'2026-10-04T00:00:00Z':null,private_chat_thread_id:'thread-'+i,private_chat_school_epoch:1,private_chat_activity_epoch:1,private_chat_generation:1});
   native.deliveries.push({id:'delivery-'+id,chat_message_id:id,school_id:school.id,student_id:school.students[2],teaching_session_id:school.currentSession,
    supervision_context_id:null,state:delivered?'delivered':'attempted',attempt_count:1,last_attempt_at:'2026-10-04T00:00:00Z',
    last_attempt_student_session_id:school.studentSessions[2],last_attempt_device_id:school.devices[2],delivered_at:delivered?'2026-10-04T00:00:00Z':null});
  }
 }
 return{fixture,native};
}
function custody(){
 const root=mkdtempSync(join(tmpdir(),'release297-usage-post-')),receipt=join(root,'receipt'),privateRoot=join(root,'private');
 mkdirSync(receipt);mkdirSync(privateRoot);mkdirSync(join(privateRoot,'observer'));
 const {fixture,native}=input(),bytes=JSON.stringify(native)+'\n';
 writeFileSync(join(privateRoot,'observer','classroom-bindings.private.json'),bytes);write(join(privateRoot,'observer','response-1.json'),{value:fixture});
 const classroomBindings={...verifyClassroomBindings({...native,fixture,profile:PROFILES.usage}),nativeRowsSha256:hash(bytes)};
 const metrics={profile:PROFILES.usage.name,contractSha256:profileHash(PROFILES.usage),run:'123456789abc',source,helperImage:helper,
  harnessSource:'d'.repeat(40),hostHarnessSource:hostSource,hostHarnessSourceUnchanged:true,applicationImage:'sha256:'+'e'.repeat(64),schemaSha256:'f'.repeat(64),
  usagePostVerificationContractSha256:usagePostVerificationHash(),runPassed:true};
 metrics.usagePostVerification={schemaVersion:1,contractSha256:usagePostVerificationHash(),originalProfileSha256:metrics.contractSha256,
  run:metrics.run,source,helperImage:helper,hostHarnessSource:hostSource,fixtureSha256:hash(JSON.stringify(fixture)),
  extraMeasuredOffers:0,originalMeasuredWorkloadUnchanged:true,classroomBindings,passed:true};
 write(join(receipt,'usage-classroom-post-verification.json'),metrics.usagePostVerification);
 return{root,receipt,privateRoot,fixture,native,metrics};
}
test('separate post-verification retains the exact original Usage profile and hash',()=>{
 assert.equal(JSON.stringify(PROFILES.usage),frozenOriginalUsageJson);
 assert.equal(profileHash(PROFILES.usage),hash(frozenOriginalUsageJson));
 assert.equal(USAGE_POST_VERIFICATION_CONTRACT.originalProfileSha256,hash(frozenOriginalUsageJson));
 assert.equal(USAGE_POST_VERIFICATION_CONTRACT.extraMeasuredOffers,0);
 assert.throws(()=>assertUsagePostVerificationBinding('0'.repeat(64)));
 assert.throws(()=>assertUsagePostVerificationBinding(usagePostVerificationHash(),PROFILES.classroom));
});
test('declared campaign and reservation carry mandatory side-contract and host source without changing legacy declarations',()=>{
 const root=mkdtempSync(join(tmpdir(),'release297-usage-declare-'));
 try{
  const options={kind:'usage',profile:PROFILES.usage.name,candidateSource:source,observedFlagsSha256:'1'.repeat(64)};
  const old=declareCampaign({...options,directory:join(root,'old')});assert.equal('usagePostVerificationContractSha256' in old,false);
  const fresh=declareCampaign({...options,directory:join(root,'new'),hostHarnessSource:hostSource,usagePostVerificationContractSha256:usagePostVerificationHash()});
  assert.equal(fresh.contractSha256,profileHash(PROFILES.usage));
  const reservation=reserveAttempt({directory:join(root,'new'),run:'123456789abc',receiptDirectory:join(root,'receipt'),privateDirectory:join(root,'private')});
  const actual=JSON.parse(readFileSync(reservation.reservationFile,'utf8'));
  assert.equal(assertUsagePostVerificationReservation(actual,{usagePostVerificationContractSha256:usagePostVerificationHash(),hostHarnessSource:hostSource}),true);
  assert.throws(()=>assertUsagePostVerificationReservation(actual,{}));
  assert.throws(()=>assertUsagePostVerificationReservation(actual,{usagePostVerificationContractSha256:usagePostVerificationHash(),hostHarnessSource:'2'.repeat(40)}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('declared receipt and three-run closure cannot downgrade or rebind the postcondition',()=>{
 const c=custody();try{
  const contract={usagePostVerificationContractSha256:usagePostVerificationHash(),hostHarnessSource:hostSource};
  assert.equal(assertUsagePostVerificationReceiptBinding(contract,c.metrics),true);
  assert.throws(()=>assertUsagePostVerificationReceiptBinding(contract,{...c.metrics,usagePostVerificationContractSha256:undefined}));
  assert.throws(()=>assertUsagePostVerificationReceiptBinding(contract,{...c.metrics,hostHarnessSource:'2'.repeat(40)}));
  assert.equal(assertUsagePostVerificationSet([c.metrics,structuredClone(c.metrics),structuredClone(c.metrics)],usagePostVerificationHash()).passed,true);
  const drift=structuredClone(c.metrics);drift.hostHarnessSourceUnchanged=false;
  assert.throws(()=>assertUsagePostVerificationSet([c.metrics,c.metrics,drift],usagePostVerificationHash()));
  const helperDrift=structuredClone(c.metrics);helperDrift.helperImage='sha256:'+'3'.repeat(64);helperDrift.usagePostVerification.helperImage=helperDrift.helperImage;
  assert.throws(()=>assertUsagePostVerificationSet([c.metrics,c.metrics,helperDrift],usagePostVerificationHash()));
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('post-load execution adds one native read and no heartbeat or report traffic',async()=>{
 const c=custody();try{
  const calls=[],saved=[];
  const evidence=await verifyUsageClassroomAfterLoad({metrics:c.metrics,fixture:c.fixture,observer:{rpc:async(...args)=>{calls.push(args);return c.metrics.usagePostVerification.classroomBindings;}},save:(...args)=>saved.push(args)});
  assert.equal(evidence.passed,true);assert.deepEqual(calls,[['correctness',{classroom:true}]]);assert.equal(saved.length,1);
  assert.equal(evidence.extraMeasuredOffers,0);assert.equal(evidence.originalMeasuredWorkloadUnchanged,true);
  assert.equal(verifyUsagePostVerificationCustody(c.receipt,c.privateRoot,c.metrics).verified,true);
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('native custody rejects changed row bytes, changed fixture, missing evidence and forged native success',()=>{
 for(const mutation of ['row','fixture','missing','forged']){
  const c=custody();try{
   if(mutation==='row')writeFileSync(join(c.privateRoot,'observer','classroom-bindings.private.json'),'{}\n');
   if(mutation==='fixture')write(join(c.privateRoot,'observer','response-1.json'),{value:{schools:[]}});
   if(mutation==='missing')rmSync(join(c.receipt,'usage-classroom-post-verification.json'));
   if(mutation==='forged'){
    c.native.commands[0].device_id=c.fixture.schools[0].devices[3];const bytes=JSON.stringify(c.native)+'\n';
    writeFileSync(join(c.privateRoot,'observer','classroom-bindings.private.json'),bytes);
    c.metrics.usagePostVerification.classroomBindings.nativeRowsSha256=hash(bytes);write(join(c.receipt,'usage-classroom-post-verification.json'),c.metrics.usagePostVerification);
   }
   assert.throws(()=>verifyUsagePostVerificationCustody(c.receipt,c.privateRoot,c.metrics));
  }finally{rmSync(c.root,{recursive:true,force:true});}
 }
});
test('new proof cannot omit the actual native row or escape private custody through a directory link',()=>{
 const c=custody(),outside=mkdtempSync(join(tmpdir(),'release297-outside-'));
 try{
  const original=join(c.privateRoot,'observer','classroom-bindings.private.json');rmSync(original);
  assert.throws(()=>verifyUsagePostVerificationCustody(c.receipt,c.privateRoot,c.metrics));
  write(join(outside,'classroom-bindings.private.json'),c.native);write(join(outside,'response-1.json'),{value:c.fixture});
  rmSync(join(c.privateRoot,'observer'),{recursive:true,force:true});symlinkSync(outside,join(c.privateRoot,'observer'),'junction');
  assert.throws(()=>verifyUsagePostVerificationCustody(c.receipt,c.privateRoot,c.metrics),/escaped/);
 }finally{rmSync(c.root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
test('exact recipient, session, school, generation and cardinality remain mandatory even after rehashing mutated proof',()=>{
 for(const mutation of ['recipient','session','school','future-generation','extra-command','missing-delivery']){
  const c=custody();try{
   if(mutation==='recipient')c.native.messages[0].recipient_id=c.fixture.schools[0].devices[3];
   if(mutation==='session')c.native.deliveries[0].last_attempt_student_session_id=c.fixture.schools[0].studentSessions[3];
   if(mutation==='school')c.native.messages[0].school_id=c.fixture.schools[1].id;
   if(mutation==='future-generation')c.native.messages[0].private_chat_generation=3;
   if(mutation==='extra-command')c.native.commands.push(structuredClone(c.native.commands[0]));
   if(mutation==='missing-delivery')c.native.deliveries.pop();
   const bytes=JSON.stringify(c.native)+'\n';writeFileSync(join(c.privateRoot,'observer','classroom-bindings.private.json'),bytes);
   c.metrics.usagePostVerification.classroomBindings.nativeRowsSha256=hash(bytes);write(join(c.receipt,'usage-classroom-post-verification.json'),c.metrics.usagePostVerification);
   assert.throws(()=>verifyUsagePostVerificationCustody(c.receipt,c.privateRoot,c.metrics));
  }finally{rmSync(c.root,{recursive:true,force:true});}
 }
});
test('required proof rejects missing success and retains explicit original cold workload',()=>{
 const c=custody();try{
  const missing=structuredClone(c.metrics);delete missing.usagePostVerification;assert.throws(()=>assertUsagePostVerificationEvidence(missing));
  const changed=structuredClone(c.metrics);changed.usagePostVerification.extraMeasuredOffers=1;assert.throws(()=>assertUsagePostVerificationEvidence(changed));
  const incomplete=structuredClone(c.metrics);incomplete.usagePostVerification.classroomBindings.observedMessages=3;assert.throws(()=>assertUsagePostVerificationEvidence(incomplete));
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('a failed native postcondition retains settled traffic and intentional negative evidence without accepting the run',async()=>{
 const c=custody();try{
  const traffic={heartbeats:{offered:6000},lifecycle:{expectedNegativeProbes:[{requestId:'12345678-1234-1234-1234-123456789abc',status:409,code:'PRIVATE_CHAT_LIFECYCLE_STALE'}]}};
  const metrics={...c.metrics,rounds:[],runPassed:false},saved=[];
  retainCompletedGeneratorTraffic([{status:'fulfilled',value:traffic},{status:'fulfilled',value:[]}],metrics,(...args)=>saved.push(args));
  const failure={code:'CLASSROOM_ORACLE_MESSAGE_TARGET_BINDING',predicate:'MESSAGE_TARGET_BINDING',declaredSchoolIndices:[0,1]};
  const observer={rpc:async()=>{throw Object.assign(Error('native failure'),{classroomOracleFailure:failure});}};
  await assert.rejects(verifyUsageClassroomAfterLoad({metrics,fixture:c.fixture,save:(...args)=>saved.push(args),observer}));
  assert.equal(metrics.continuousTraffic,traffic);assert.equal(runNegativeProbes(metrics).length,1);assert.equal(metrics.runPassed,false);
  assert.deepEqual(saved.map(row=>row[0]),['continuous-traffic.json','usage-classroom-post-verification-failure.json']);
  assert.deepEqual(metrics.usagePostVerificationFailure,failure);
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
test('native post-verification distinguishes a legitimate unattempted fenced reply from delivered history',()=>{
 const c=custody();try{
  const message=c.native.messages.find(row=>row.delivery_status==='sent'),delivery=c.native.deliveries.find(row=>row.chat_message_id===message.id);
  message.device_id=null;message.recipient_id=null;Object.assign(delivery,{attempt_count:0,last_attempt_at:null,last_attempt_device_id:null,last_attempt_student_session_id:null,state:'queued'});
  const bytes=JSON.stringify(c.native)+'\n';writeFileSync(join(c.privateRoot,'observer','classroom-bindings.private.json'),bytes);
  c.metrics.usagePostVerification.classroomBindings={...verifyClassroomBindings({...c.native,fixture:c.fixture,profile:PROFILES.usage}),nativeRowsSha256:hash(bytes)};
  write(join(c.receipt,'usage-classroom-post-verification.json'),c.metrics.usagePostVerification);
  assert.equal(verifyUsagePostVerificationCustody(c.receipt,c.privateRoot,c.metrics).verified,true);
  assert.equal(c.metrics.usagePostVerification.classroomBindings.unattemptedExpiredMessages,1);
  assert.equal(c.native.messages.filter(row=>row.delivery_status==='delivered').length,2);
  delivery.last_attempt_at='2026-10-04T00:00:00Z';const corrupt=JSON.stringify(c.native)+'\n';writeFileSync(join(c.privateRoot,'observer','classroom-bindings.private.json'),corrupt);
  c.metrics.usagePostVerification.classroomBindings.nativeRowsSha256=hash(corrupt);write(join(c.receipt,'usage-classroom-post-verification.json'),c.metrics.usagePostVerification);
  assert.throws(()=>verifyUsagePostVerificationCustody(c.receipt,c.privateRoot,c.metrics));
 }finally{rmSync(c.root,{recursive:true,force:true});}
});
