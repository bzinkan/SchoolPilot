import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PROFILES, assertOffering, profileHash, stageForRound, stickyTarget, hash } from './contracts.mjs';
import { offerHeartbeats, sealTimings, targetFor } from './offering.mjs';
import { patchGeneratorV2, patchProcessV2, patchDrainV2 } from './patch.mjs';
import { validateRound, validatePairs, reportMatrix, validateMixedRuns } from './validation.mjs';
import { classifyLog, cpuWindow } from './measurements.mjs';
import { checkPersistence } from './persistence.mjs';
import { declareCampaign, reserveAttempt, registerAttempt } from './campaign.mjs';
import { loadReceipt } from './receipts.mjs';
const file=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const digest='a'.repeat(64),source='a'.repeat(40),candidate='b'.repeat(40);
test('new profiles pin real offerings and retain the failed single task separately',()=>{
  for(const profile of Object.values(PROFILES))assertOffering(profile.offering);
  assert.equal(PROFILES.sole.offering.expected,798);assert.equal(PROFILES.normal.offering.expected,2040);
  assert.deepEqual(PROFILES.normal.offering.schoolDevices,[170,170]);assert.equal(PROFILES.usage.apiTasks,3);
  assertOffering(PROFILES.mixed.continuousOffering);assert.equal(PROFILES.mixed.continuousOffering.expected,11970);
  assert.notEqual(PROFILES.usage.name,PROFILES.overload.name);assert.equal(PROFILES.overload.kind,'diagnostic');
  assert.throws(()=>assertOffering({...PROFILES.sole.offering,expected:6000}));
  assert.deepEqual([0,5,7,10].map(round=>[stageForRound(round).active.length,stageForRound(round).distribution]),[[1,'uniform'],[3,'uniform'],[3,'sticky80'],[2,'survivors']]);
  assert.deepEqual(targetFor(169,PROFILES.normal.offering),{index:169,schoolIndex:0,deviceIndex:169,studentOrdinal:169,offsetMs:169*1000/34});
  assert.equal(targetFor(170,PROFILES.normal.offering).schoolIndex,1);assert.equal(targetFor(340,PROFILES.normal.offering).deviceIndex,0);
  assert.equal(Array.from({length:100},(_,n)=>stickyTarget(n,[0,1,2],'sticky80')).filter(n=>n===0).length,80);
});
test('new offering makes real HTTP calls, respects nondefault population and completes the declared window',async()=>{
  const seen=[],server=createServer((request,response)=>{seen.push(request.url);response.writeHead(200,{'Content-Type':'application/json'});response.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const config={...PROFILES.normal.offering,requestsPerSecond:20,schoolDevices:[3,0],durationMs:300,deviceCadenceMs:150,expected:6,maxInFlight:3};
    const result=sealTimings(await offerHeartbeats(async(offer,signal)=>({status:(await fetch(`http://127.0.0.1:${server.address().port}/${offer.schoolIndex}/${offer.deviceIndex}`,{signal})).status,targetIndex:0}),{config}));
    assert.equal(result.accepted,true);assert.deepEqual(seen,['/0/0','/0/1','/0/2','/0/0','/0/1','/0/2']);
    assert.equal(result.targetHistogram[0],6);assert.equal(result.bindings['0:2'].acknowledged200,2);assert.ok(result.offerWindowMs>=300);assert.equal(result.timings.count,6);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('ordinary HTTP204 cannot borrow reconnect tolerance',async()=>{
  const config={...PROFILES.sole.offering,requestsPerSecond:100,schoolDevices:[1,0],durationMs:10,deviceCadenceMs:10,expected:1,maxInFlight:1};
  const result=await offerHeartbeats(async()=>({status:204}),{config});assert.equal(result.accepted,false);assert.equal(result.failed,1);
});
test('reconnect extras count204 as transport success but persist only exact200 bindings',()=>{
  const fixture={schools:[{id:'s',students:['a','b']} ]},before={rows:[],invalid:0};
  const traffic={heartbeats:{bindings:{'0:0':{acknowledged200:6},'0:1':{acknowledged200:6}}},reconnect:{bindings:{'0:0':{acknowledged200:0,acknowledged204:1},'0:1':{acknowledged200:1,acknowledged204:0}}}};
  const after={rows:[{school_id:'s',student_id:'a',count:6,invalid:0},{school_id:'s',student_id:'b',count:7,invalid:0}],invalid:0};
  assert.equal(checkPersistence(before,after,traffic,fixture).passed,true);
  assert.equal(checkPersistence(before,{...after,rows:[{school_id:'s',student_id:'a',count:7,invalid:0},{school_id:'s',student_id:'b',count:6,invalid:0}]},traffic,fixture).passed,false);
  assert.equal(checkPersistence(before,{...after,invalid:1},traffic,fixture).passed,false);
});
test('generated overlays are strict, fix the polling budget and never alter canonical bytes',async()=>{
  const original=file('release-enabled-generator.mjs'), before=hash(original), generated=patchGeneratorV2(original);
  assert.equal(hash(file('release-enabled-generator.mjs')),before);assert.ok(generated.includes('AbortSignal.timeout(20_000)'));
  assert.ok(!generated.includes('Math.max(1, deadline - Date.now())'));assert.ok(generated.includes('allowPreflightThrottle && result.status === 204'));
  assert.ok(generated.includes('continuousStartsAtMs+601_000'));assert.ok(generated.includes('controlSockets[2]=reconnected'));
  assert.ok(generated.includes('Forbidden same-school recipient'));assert.ok(!generated.includes('offer.index < RELEASE_ENABLED_PROFILE.preflightDevicesPerSchool'));
  assert.throws(()=>patchGeneratorV2(original.replace('let fixture, base, schools;','changed')));
  const process=patchProcessV2(file('release-enabled-process.mjs'));assert.ok(process.includes('dist/middleware/classpilotHeartbeatAdmission.js'));
  const drain=await import('data:text/javascript;base64,'+Buffer.from(patchDrainV2(file('release-enabled-drain.mjs'))).toString('base64'));
  const snapshot={operations:{schemaVersion:2,operations:Object.fromEntries(drain.RELEASE_DRAIN_OPERATIONS.map(name=>[name,{activeOperations:0,pendingCheckouts:0,activeCheckouts:0}]))},
    database:{pendingAcquisitions:0,activeQueries:0,pools:{api:{waiting:0,held:0}}},http:{activeResponses:0},tenantReleases:{pending:0},heartbeatAdmission:{queued:1,active:0}};
  assert.equal(drain.releaseServerIsIdle(snapshot),false);snapshot.heartbeatAdmission.queued=0;assert.equal(drain.releaseServerIsIdle(snapshot),true);
});
test('missing logs and native error markers remain unavailable or fail; never become zeros',()=>{
  assert.equal(classifyLog('','api').available,false);
  assert.equal(classifyLog('Unexpected error on idle client','api',{complete:true}).errorCount,1);
  assert.equal(classifyLog('ERROR: canceling statement due to statement timeout','postgres',{complete:true}).categories.statement,1);
  assert.equal(classifyLog('connection timeout exceeded','api',{complete:true}).categories.acquisition,1);
});
test('CPU window cannot use late cleanup to dilute an overloaded offering',()=>{
  const window={declaredDurationMs:60_000,startDelayMs:0,endDelayMs:0,start:{cpu:{usage_usec:0},hrtimeMicroseconds:0},end:{cpu:{usage_usec:40_000_000},hrtimeMicroseconds:60_000_000}};
  assert.ok(cpuWindow(window).meanFraction>.60);
  assert.throws(()=>cpuWindow({...window,declaredDurationMs:120_000}));assert.throws(()=>cpuWindow({...window,endDelayMs:1000}));
});
function reportRows(){return [0,1].flatMap(schoolIndex=>['school','grade','class','student'].flatMap(scope=>[1,7,30,365].flatMap((days,wave)=>[0,1].map(()=>({schoolIndex,scope,days,wave,status:200,correct:true,durationMs:50})))));}
test('all64 reports cover every school, scope, range and replica',()=>{const rows=reportRows();assert.equal(reportMatrix(rows),true);assert.equal(reportMatrix(Array(64).fill(rows[0])),false);rows[63].status=503;assert.equal(reportMatrix(rows),false);});
function pairRecords(){return ['A','A','A','B','B','A','A','B'].map(arm=>({profile:PROFILES.normal.name,contractSha256:profileHash(PROFILES.normal),observedFlagsSha256:digest,arm,
  source:arm==='A'?source:candidate,runPassed:true,cleanupPassed:true,sourceUnchanged:true,cpuMsPer200:arm==='A'?10:10.4,p95Ms:arm==='A'?100:108,
  verifiedReceiptManifestSha256:digest,fixtureLogicalSha256:digest,nodeVersion:'v22.23.3'}));}
test('paired nonregression rejects noisy controls, bad margins and another profile',()=>{
  const options={profile:PROFILES.normal,baselineSource:source,candidateSource:candidate,observedFlagsSha256:digest};
  const rows=pairRecords();assert.equal(validatePairs(rows,options).passed,true);
  rows[3].cpuMsPer200=11.1;assert.equal(validatePairs(rows,options).passed,false);
  const noise=pairRecords();noise[1].cpuMsPer200=10.6;assert.equal(validatePairs(noise,options).disposition,'inconclusive-host-noise');
  const wrong=pairRecords();wrong[3].profile=PROFILES.sole.name;assert.throws(()=>validatePairs(wrong,options));
});
test('a final failed mixed run cannot be accepted from passing minute claims',()=>{
  assert.throws(()=>validateMixedRuns(Array.from({length:3},()=>({profile:PROFILES.mixed.name,rounds:Array(15).fill({}),cleanupPassed:true,runPassed:false}))));
});
test('receipt verifier rejects missing manifest records and tampering',()=>{
  const directory=mkdtempSync(join(tmpdir(),'release297-receipt-negative-')), privateDir=join(directory,'private');mkdirSync(privateDir);
  const manifest={schemaVersion:2,profile:PROFILES.normal.name,source,run:'a'.repeat(12),records:{}};
  writeFileSync(join(directory,'receipt-manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>loadReceipt(directory,hash(JSON.stringify(manifest)),privateDir));assert.throws(()=>loadReceipt(directory,digest,privateDir));
});
test('a reserved failed setup is preserved and cannot be silently retried in place',()=>{
  const root=mkdtempSync(join(tmpdir(),'release297-journal-negative-')), directory=join(root,'campaign');
  declareCampaign({directory,kind:'paired',profile:PROFILES.normal.name,candidateSource:candidate,baselineSource:source,observedFlagsSha256:digest});
  const reservation=reserveAttempt({directory,run:'a'.repeat(12),receiptDirectory:join(root,'receipt'),privateDirectory:join(root,'private')});
  assert.equal(reservation.arm,'A');assert.throws(()=>reserveAttempt({directory,run:'b'.repeat(12),receiptDirectory:join(root,'receipt2'),privateDirectory:join(root,'private2')}));
  assert.equal(registerAttempt({directory,receiptDirectory:join(root,'receipt'),receiptManifestSha256:digest,privateDirectory:join(root,'private')}).runPassed,false);
  const journal=JSON.parse(readFileSync(join(directory,'journal.json'),'utf8'));assert.equal(journal.attempts[0].receipt.verificationFailure,'RECEIPT_UNAVAILABLE_OR_INVALID');
  assert.throws(()=>reserveAttempt({directory,run:'a'.repeat(12),receiptDirectory:join(root,'other'),privateDirectory:join(root,'other-private')}));
});
