import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PROFILES,profileHash,assertOffering,hash,OLD_CONTRACT_SHA256,OLD_CLOSED_JOURNAL_SHA256} from './contracts.mjs';
import {LOWER_LEVELS,LOWER_CONTRACT,lowerContractHash,assertLowerReservation,assertLowerPostRls,lowerCreateArguments,lowerHeadroom,assertLowerConfirmation,verifyLowerNativeCustody,verifyLowerPersistenceCustody,lowerAcquisitionLogProof} from './lower-load.mjs';
import {checkPersistence} from './persistence.mjs';
import {checkLowerStaffRows,createLowerStaffReader} from './lower-staff.mjs';
import {lowerScreenDisposition,assertLowerRecordedResult} from './lower-sweep.mjs';
const fixture={schools:[0,1].map(index=>({index,id:'school'+index,currentSession:'session'+index,groups:['group'+index],teachers:['teacher'+index]})),password:'synthetic-private-test-password',apiBases:['http://127.0.0.1:4001']};
function rows(){return PROFILES.lower133.lowerStaffReads.waveOffsetsMs.flatMap((scheduledOffsetMs,wave)=>['own','foreign'].map(kind=>({wave,kind,targetIndex:0,scheduledOffsetMs,offeredOffsetMs:scheduledOffsetMs,durationMs:2,status:kind==='own'?200:404,
  body:kind==='own'?{session:{id:'session0',schoolId:'school0',groupId:'group0',teacherId:'teacher0',endTime:null,lifecycle:{state:'active'}},settings:{}}:{error:'Session not found'}})));}
const native=()=>({passed:true,restrictedRole:true,crossSchool:true,resetScope:true,catalog:Array.from({length:129},(_,n)=>({relname:'table'+n,relrowsecurity:true,relforcerowsecurity:true})),migrations:Array.from({length:54},(_,n)=>({id:'migration'+n,checksum:'b'.repeat(64),status:'complete'}))});
function record(n=0){return{run:String(n).padStart(12,'0'),source:'a'.repeat(40),applicationImage:'sha256:'+'a'.repeat(64),schemaSha256:'a'.repeat(64),helperImage:'sha256:'+'b'.repeat(64),harnessSource:'a'.repeat(40),hostHarnessSource:'b'.repeat(40),observedFlagsSha256:'c'.repeat(64),clientAdvertisementSha256:'d'.repeat(64),verifiedReceiptManifestSha256:'e'.repeat(64),
  profile:PROFILES.lower133.name,contractSha256:profileHash(PROFILES.lower133),arm:'B',runPassed:true,cleanupPassed:true,sourceUnchanged:true,hostHarnessSourceUnchanged:true,expectedNegativeLogCoverage:true,errorCoverage:[{complete:true,available:true,errorCount:0},{complete:true,available:true,errorCount:0}],
  lowerAcquisitionLogEvidence:{passed:true},lowerLoad:{contractSha256:lowerContractHash()},postLowerRlsVerification:native(),databasePreparation:native(),p95Ms:200,rounds:[{acceptance:{checks:{cpuBound:true,latency:true,scopedTeacherReads:true,persistence:true,capabilityAcknowledgements:true,offering:true}},cpuByRole:[{}],apiCpuMeanFraction:.40,traffic:{lowerStaffReads:{passed:true}}}]};}
const emf=()=>({_aws:{Timestamp:2000,CloudWatchMetrics:[{Namespace:'SchoolPilot/Monitoring'}]},Release:'a'.repeat(40),Service:'api',Environment:'test',InstanceId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',MonitorCaptured:0,MonitorCapturedInterval:0,DatabaseConnectivityMonitorCapturedInterval:0});
async function historicalContracts(){
  // Exact Git source snapshot from 05d745d5d695faf1d526bf31c44532ec43a0deb2.
  // Normalize checkout CRLF only; canonical profile JSON and hashes remain exact.
  const old=readFileSync(new URL('./fixtures/contracts-05d745d5.fixture.mjs',import.meta.url),'utf8');
  assert.equal(hash(old.replaceAll('\r\n','\n')),'3de37a4d6170b0f0305118076df4614f78e02c1b7d98e24f1034fed10edd47af');
  const before=await import('data:text/javascript;base64,'+Buffer.from(old).toString('base64'));
  assert.equal(OLD_CONTRACT_SHA256,before.OLD_CONTRACT_SHA256);assert.equal(OLD_CLOSED_JOURNAL_SHA256,before.OLD_CLOSED_JOURNAL_SHA256);
  return before;
}
function assertHistoricalProfiles(actual,before){
  for(const [key,value] of Object.entries(before.PROFILES)){
    assert.deepEqual(actual[key],value,key);
    assert.equal(hash(JSON.stringify(actual[key])),before.profileHash(value),key+' canonical hash');
  }
}
test('final source-defined monitor log proof accepts stable zero without optional lifetime',()=>{
  const proof=lowerAcquisitionLogProof(JSON.stringify(emf()),{source:'a'.repeat(40),measuredEndsAtMs:1000,complete:true});assert.equal(proof.passed,true);assert.equal(proof.rawAcquisitionCountersAvailable,false);
});
test('recovered acquisition, readiness deferral and missing/invalid final EMF are fatal',()=>{
  const settings={source:'a'.repeat(40),measuredEndsAtMs:1000,complete:true};
  for(const mutate of [row=>row.DatabaseConnectivityMonitorCapturedInterval=1,row=>row.DatabaseConnectivityMonitorCaptured=1,row=>delete row.DatabaseConnectivityMonitorCapturedInterval,row=>row.DatabaseConnectivityMonitorCapturedInterval=NaN,row=>row.Release='b'.repeat(40),row=>row._aws.Timestamp=999,row=>row.MonitorCaptured=1]){const row=emf();mutate(row);assert.throws(()=>lowerAcquisitionLogProof(JSON.stringify(row),settings));}
  for(const bad of ['[ErrorMonitor] ALERT: database_connectivity - 1 matching errors in 5 min',JSON.stringify({event:'api_pool_readiness_transition',state:'probe_deferred'}),JSON.stringify({event:'api_pool_readiness_transition',state:'pool_stalled'}),JSON.stringify({event:'api_pool_readiness_sample_failed'})])assert.throws(()=>lowerAcquisitionLogProof(JSON.stringify(emf())+'\n'+bad,settings));
  assert.throws(()=>lowerAcquisitionLogProof('',settings));assert.throws(()=>lowerAcquisitionLogProof(JSON.stringify(emf()),{...settings,complete:false}));
  assert.throws(()=>lowerAcquisitionLogProof(JSON.stringify({...emf(),DatabaseConnectivityMonitorCapturedInterval:1})+'\n'+JSON.stringify({...emf(),_aws:{...emf()._aws,Timestamp:3000}}),settings));
  assert.throws(()=>lowerAcquisitionLogProof(JSON.stringify(emf())+'\n'+JSON.stringify({...emf(),InstanceId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}),settings));
  const unsafe=record();unsafe.lowerAcquisitionLogEvidence.passed=false;assert.equal(lowerScreenDisposition(unsafe).fatal,true);
});
test('lower levels use one school, exact packaged cadence and preserved old profiles',async()=>{
  assert.deepEqual(LOWER_LEVELS.map(row=>row.offering.schoolDevices),[[133,0],[250,0],[340,0],[500,0]]);
  assert.deepEqual(LOWER_LEVELS.map(row=>row.offering.expected),[798,1500,2040,3000]);for(const profile of LOWER_LEVELS){assertOffering(profile.offering);assert.equal(profile.offering.deviceCadenceMs,10000);}
  assertHistoricalProfiles(PROFILES,await historicalContracts());
  assert.equal(LOWER_CONTRACT.queryRecorder,false);assert.equal(LOWER_CONTRACT.cpuProfiler,false);assert.equal(LOWER_CONTRACT.comparisonPolicyAmended,false);
});
test('historical profile snapshot rejects changed values and canonical key-order drift',async()=>{
  const before=await historicalContracts(),changed=structuredClone(PROFILES);changed.usage.offering.expected-=1;
  assert.throws(()=>assertHistoricalProfiles(changed,before),{code:'ERR_ASSERTION'});
  const reordered={...PROFILES,usage:Object.fromEntries(Object.entries(PROFILES.usage).reverse())};
  assert.deepEqual(reordered.usage,before.PROFILES.usage);
  assert.throws(()=>assertHistoricalProfiles(reordered,before),{code:'ERR_ASSERTION'});
});
test('scoped teacher read replay accepts exact own authority and foreign denials',()=>assert.equal(checkLowerStaffRows(rows(),fixture,PROFILES.lower133).passed,true));
test('scoped teacher reads reject wrong school, teacher, class and session',()=>{
  for(const key of ['schoolId','teacherId','groupId','id']){const raw=rows();raw[0].body.session[key]='foreign';assert.throws(()=>checkLowerStaffRows(raw,fixture,PROFILES.lower133));}
});
test('foreign session success, private data, duplicate or delayed reads reject',()=>{
  for(const mutate of [raw=>raw[1].status=200,raw=>raw[1].body.extra='private',raw=>raw[1]=raw[0],raw=>raw[0].durationMs=20001,raw=>raw[0].offeredOffsetMs=101,raw=>raw[10].offeredOffsetMs=60000]){const raw=rows();mutate(raw);assert.throws(()=>checkLowerStaffRows(raw,fixture,PROFILES.lower133));}
});
test('actual reader uses teacher cookie on same API and exactly twelve timed reads',async()=>{
  const originalDateNow=Date.now;let clock=100000,calls=[],timers=[];Date.now=()=>100000;
  try{const fetchFn=async(url,options)=>{calls.push({url,options});const login=url.endsWith('/auth/login'),csrf=url.endsWith('/auth/csrf');
    return{status:url.endsWith('session1')?404:200,headers:{getSetCookie:()=>login?['schoolpilot.sid=synthetic; Path=/']:[]},json:async()=>login?{}:csrf?{csrfToken:'csrf'}:url.endsWith('session1')?{error:'Session not found'}:rows()[0].body};};
    const reader=await createLowerStaffReader(fixture,PROFILES.lower133,{fetchFn,now:()=>clock,sleep:ms=>new Promise(wake=>timers.push({at:clock+ms,wake}))});
    const operation=reader(100000);
    for(let wave=0;wave<6;wave++){clock=100000+wave*10000;for(const timer of timers.filter(row=>row.at<=clock))timer.wake();timers=timers.filter(row=>row.at>clock);for(let n=0;n<20;n++)await Promise.resolve();}
    const result=await operation;assert.equal(result.summary.passed,true);assert.equal(calls.length,14);
    assert.equal(JSON.parse(calls[0].options.body).email,'scale-teacher0@example.test');
    for(const call of calls.slice(2)){assert.ok(call.url.startsWith(fixture.apiBases[0]));assert.equal(call.options.headers.Cookie,'schoolpilot.sid=synthetic');assert.equal(call.options.headers['X-School-Id'],'school0');}
  }finally{Date.now=originalDateNow;}
});
test('slow first teacher read cannot shift the independently scheduled later waves',async()=>{
  const dateNow=Date.now;let clock=100000,timers=[],firstRead=true,releaseFirst;Date.now=()=>100000;
  try{
    const fetchFn=async(url)=>{
      if(url.endsWith('session0')&&firstRead){firstRead=false;await new Promise(resolve=>{releaseFirst=resolve;});}
      const login=url.endsWith('/auth/login'),csrf=url.endsWith('/auth/csrf');return{status:url.endsWith('session1')?404:200,
        headers:{getSetCookie:()=>login?['schoolpilot.sid=synthetic; Path=/']:[]},json:async()=>login?{}:csrf?{csrfToken:'csrf'}:url.endsWith('session1')?{error:'Session not found'}:rows()[0].body};
    };
    const reader=await createLowerStaffReader(fixture,PROFILES.lower133,{fetchFn,now:()=>clock,sleep:ms=>new Promise(wake=>timers.push({at:clock+ms,wake}))}),operation=reader(100000);
    for(const offset of [0,10000,15000,20000,30000,40000,50000]){clock=100000+offset;if(offset===15000)releaseFirst();for(const timer of timers.filter(row=>row.at<=clock))timer.wake();timers=timers.filter(row=>row.at>clock);for(let n=0;n<20;n++)await Promise.resolve();}
    const result=await operation;assert.equal(result.summary.passed,true);assert.equal(result.rows.find(row=>row.wave===0&&row.kind==='own').durationMs,15000);
    assert.equal(result.rows.find(row=>row.wave===1&&row.kind==='own').offeredOffsetMs,10000);
  }finally{Date.now=dateNow;}
});
test('headroom is compulsory for chosen confirmation, hard gate differs',()=>{
  const records=[0,1,2].map(record);assert.equal(assertLowerConfirmation(records,PROFILES.lower133).headroomPassed,true);
  records[2].p95Ms=401;assert.equal(lowerHeadroom(records[2]),false);assert.throws(()=>assertLowerConfirmation(records,PROFILES.lower133));
  assert.equal(assertLowerConfirmation(records,PROFILES.lower133,{requireHeadroom:false}).hardGatePassed,true);
});
test('confirmation rejects repeated runs, absent verified custody or changed source',()=>{
  for(const mutate of [rs=>rs[2].run=rs[0].run,rs=>delete rs[2].verifiedReceiptManifestSha256,rs=>rs[2].source='f'.repeat(40),rs=>rs[2].rounds[0].traffic.lowerStaffReads.passed=false]){const rs=[0,1,2].map(record);mutate(rs);assert.throws(()=>assertLowerConfirmation(rs,PROFILES.lower133));}
});
test('screen stops upward immediately on hard failure or lost margin',()=>{
  assert.equal(lowerScreenDisposition(record()).continueUpward,true);const failed=record();failed.runPassed=false;assert.equal(lowerScreenDisposition(failed).fatal,true);
  const edge=record();edge.rounds[0].apiCpuMeanFraction=.501;assert.equal(lowerScreenDisposition(edge).reason,'HEADROOM_LOST');
});
test('only CPU or latency may select a lower ceiling; authority and failed requests are fatal',()=>{
  const cpu=record();cpu.runPassed=false;cpu.failure='V2_NUMERICAL_ACCEPTANCE_FAILED';cpu.rounds[0].acceptance.checks.cpuBound=false;
  assert.equal(lowerScreenDisposition(cpu).fatal,false);assert.equal(lowerScreenDisposition(cpu).reason,'CPU_OR_LATENCY_CUTOFF');
  for(const key of ['scopedTeacherReads','persistence','capabilityAcknowledgements','offering']){const failure=structuredClone(cpu);failure.rounds[0].acceptance.checks[key]=false;assert.equal(lowerScreenDisposition(failure).fatal,true);}
  const logged=structuredClone(cpu);logged.errorCoverage[0].errorCount=1;assert.equal(lowerScreenDisposition(logged).fatal,true);
});
test('loaded passing receipt cannot pass after final reservation or frozen-host verification failed',()=>{
  const verified={...record(),sourceUnchanged:true,reservationSha256:'a'.repeat(64),quietWindowSha256:'b'.repeat(64)},registered={state:'recorded',verificationCompleted:true,runPassed:true,cleanupPassed:true,run:verified.run,profile:verified.profile,reservationSha256:verified.reservationSha256,quietWindowSha256:verified.quietWindowSha256};
  assert.equal(assertLowerRecordedResult(registered,verified),verified);
  assert.throws(()=>assertLowerRecordedResult({...registered,verificationCompleted:false,runPassed:false},verified));
  assert.throws(()=>assertLowerRecordedResult(registered,undefined));
});
test('lower reservation cannot omit, downgrade or rebind declared side contract',()=>{
  const binding={hostHarnessSource:'a'.repeat(40)},reservation={lowerLoadContractSha256:lowerContractHash(),hostHarnessSource:binding.hostHarnessSource,lowerLoadBindingSha256:hash(JSON.stringify(binding))};
  assertLowerReservation(reservation,binding);for(const key of Object.keys(reservation)){const changed={...reservation};delete changed[key];assert.throws(()=>assertLowerReservation(changed,binding));}
});
test('post RLS replay rejects false flags and modified full native vectors',()=>{
  assertLowerPostRls(native(),native());for(const mutate of [row=>row.crossSchool=false,row=>row.catalog.pop(),row=>row.catalog[0].relforcerowsecurity=false,row=>row.migrations[0].checksum='f'.repeat(64),row=>row.migrations[0].status='pending']){const actual=native();mutate(actual);assert.throws(()=>assertLowerPostRls(actual,native()));}
});
test('readonly overlay mounts preserve role limits and reject force/profiler',()=>{
  const base=['create','--label','codex.release297-role=generator','--cpus','2','--memory','1073741824','image','/harness/role-entry.mjs'],binding={contractsFile:'C:/contracts.mjs',overlays:[{name:'blackbox-generator.mjs',file:'C:/generator.mjs'},{name:'lower-staff.mjs',file:'C:/staff.mjs'}]};
  const result=lowerCreateArguments(base,binding);assert.equal(result.at(-2),'image');assert.equal(result.at(-1),base.at(-1));assert.equal(result.filter(row=>row==='--mount').length,3);assert.equal(result[result.indexOf('--cpus')+1],'2');
  assert.throws(()=>lowerCreateArguments(['kill','owner'],binding));assert.throws(()=>lowerCreateArguments(['rm','--force','owner'],binding));assert.throws(()=>lowerCreateArguments([...base.slice(0,-2),'--cpu-prof',...base.slice(-2)],binding));
});
test('native teacher response custody rejects missing, tampered and foreign response data',()=>{
  const directory=mkdtempSync(join(tmpdir(),'release297-lower-'));mkdirSync(join(directory,'generator'));
  const request={operation:'initialize',value:fixture},raw=rows(),proof={source:'a'.repeat(40),run:'1'.repeat(12),profile:PROFILES.lower133.name,rows:raw,summary:checkLowerStaffRows(raw,fixture,PROFILES.lower133)};
  const requestFile=join(directory,'generator','request-1.json'),proofFile=join(directory,'generator','lower-staff-reads.private.json');writeFileSync(requestFile,JSON.stringify(request));writeFileSync(proofFile,JSON.stringify(proof));
  const metrics={source:proof.source,run:proof.run,lowerStaffFixtureSha256:hash(readFileSync(requestFile)),rounds:[{traffic:{lowerStaffReads:{...proof.summary,nativeProofSha256:hash(readFileSync(proofFile))}}}]};
  try{verifyLowerNativeCustody(directory,metrics,PROFILES.lower133);proof.rows[0].body.session.schoolId='foreign';writeFileSync(proofFile,JSON.stringify(proof));assert.throws(()=>verifyLowerNativeCustody(directory,metrics,PROFILES.lower133));rmSync(proofFile);assert.throws(()=>verifyLowerNativeCustody(directory,metrics,PROFILES.lower133));}
  finally{rmSync(directory,{recursive:true,force:true});}
});
test('native persisted tuple replay rejects false counts and contained-path escape',()=>{
  const parent=mkdtempSync(join(tmpdir(),'release297-lower-persistence-')),directory=join(parent,'private');mkdirSync(directory);mkdirSync(join(directory,'observer'));mkdirSync(join(directory,'generator'));
  const boundFixture={schools:[{id:'school0',students:['student0']},{id:'school1',students:['student1']}]},traffic={bindings:{'0:0':{acknowledged200:1}}};
  const before={rows:[],invalid:0,total:0},after={rows:[{school_id:'school0',student_id:'student0',count:1,invalid:0}],invalid:0,total:1};
  const metrics={run:'1'.repeat(12),source:'a'.repeat(40),roleCleanup:{exits:[{role:'observer',containerId:'b'.repeat(64)}]},rounds:[{traffic,persistence:checkPersistence(before,after,traffic,boundFixture),persisted:1}]};
  writeFileSync(join(directory,'generator','request-1.json'),JSON.stringify({value:boundFixture}));
  metrics.lowerPersistenceCustody=[before,after].map((value,index)=>{const id=index+2,request=`observer/request-${id}.json`,response=`observer/response-${id}.json`;
    writeFileSync(join(directory,request),JSON.stringify({id,operation:'snapshot'}));writeFileSync(join(directory,response),JSON.stringify({id,binding:{run:metrics.run,source:metrics.source,role:'observer',containerId:'b'.repeat(64)},value}));
    return{request,response,requestSha256:hash(readFileSync(join(directory,request))),responseSha256:hash(readFileSync(join(directory,response)))};
  });
  try{
    verifyLowerPersistenceCustody(directory,metrics);const file=join(directory,metrics.lowerPersistenceCustody[1].response),tampered=JSON.parse(readFileSync(file));tampered.value.rows[0].count=2;writeFileSync(file,JSON.stringify(tampered));
    assert.throws(()=>verifyLowerPersistenceCustody(directory,metrics));metrics.lowerPersistenceCustody[1].responseSha256=hash(readFileSync(file));assert.throws(()=>verifyLowerPersistenceCustody(directory,metrics));
    writeFileSync(join(parent,'outside.json'),readFileSync(file));metrics.lowerPersistenceCustody[1].response='../outside.json';assert.throws(()=>verifyLowerPersistenceCustody(directory,metrics));
  }finally{assert.ok(parent.startsWith(join(tmpdir(),'release297-lower-persistence-')));rmSync(parent,{recursive:true,force:true});}
});
