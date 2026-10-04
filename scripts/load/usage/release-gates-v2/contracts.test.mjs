import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PROFILES, assertOffering, profileHash, stageForRound, stickyTarget, hash } from './contracts.mjs';
import { offerHeartbeats, sealTimings, targetFor } from './offering.mjs';
import { patchGeneratorV2, patchProcessV2, patchDrainV2 } from './patch.mjs';
import { validateRound, validatePairs, reportMatrix, validateMixedRuns,expectedTopologyCounts,validateLostReconnectEvidence,workerLossOverlap } from './validation.mjs';
import { classifyLog, cpuWindow, cpuObservation, negativeLogCoverage } from './measurements.mjs';
import { checkPersistence } from './persistence.mjs';
import { declareCampaign, reserveAttempt, registerAttempt, verifyPairedClosure, verifyUsageComparisons, assertCandidateBinding, usageCandidateBinding, verifyBroaderGate } from './campaign.mjs';
import { loadReceipt } from './receipts.mjs';
import { remapObservedEnvironment, roleEnvironment } from './environment.mjs';
import { ownRole } from './owner.mjs';
import { withPinnedBuildBase } from './build-helper.mjs';
import { lostReconnectBindings } from './reconnect.mjs';
import { gracefulSnapshotOverlay } from './restore.mjs';
import { canonicalSchemaFingerprint } from '../release-schema-fingerprint.mjs';
const file=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const digest='a'.repeat(64),source='a'.repeat(40),candidate='b'.repeat(40);
test('new profiles pin real offerings and retain the failed single task separately',()=>{
  for(const profile of Object.values(PROFILES))assertOffering(profile.offering);
  assert.equal(PROFILES.sole.offering.expected,798);assert.equal(PROFILES.normal.offering.expected,2040);
  assert.deepEqual(PROFILES.normal.offering.schoolDevices,[170,170]);assert.equal(PROFILES.usage.apiTasks,3);
  assertOffering(PROFILES.mixed.continuousOffering);assert.equal(PROFILES.mixed.continuousOffering.expected,11970);
  assertOffering(PROFILES.broader.continuousOffering);assert.equal(PROFILES.broader.continuousOffering.expected,72000);
  assert.equal(PROFILES.broader.initialApiTasks,3);assert.deepEqual(PROFILES.broader.offering.schoolDevices,[400,400]);
  assert.notEqual(profileHash(PROFILES.broader),profileHash(PROFILES.mixed));
  assert.notEqual(PROFILES.usage.name,PROFILES.overload.name);assert.equal(PROFILES.overload.kind,'diagnostic');
  assert.throws(()=>assertOffering({...PROFILES.sole.offering,expected:6000}));
  assert.deepEqual([0,5,7,10].map(round=>[stageForRound(round).active.length,stageForRound(round).distribution]),[[1,'uniform'],[3,'uniform'],[3,'sticky80'],[2,'survivors']]);
  assert.deepEqual(targetFor(169,PROFILES.normal.offering),{index:169,schoolIndex:0,deviceIndex:169,studentOrdinal:169,offsetMs:169*1000/34});
  assert.equal(targetFor(170,PROFILES.normal.offering).schoolIndex,1);assert.equal(targetFor(340,PROFILES.normal.offering).deviceIndex,0);
  assert.equal(Array.from({length:100},(_,n)=>stickyTarget(n,[0,1,2],'sticky80')).filter(n=>n===0).length,80);
});
test('observed rollout scopes remap to the actual profile fixture, including a restored Usage snapshot',()=>{
  const capture={definitions:[{service:'schoolpilot-production-api',environment:{CLASSPILOT_CAPABILITY_ROLLOUTS_JSON:JSON.stringify({restrictionAuthPassThroughV1:{mode:'schools',schoolIds:['observed']}})}}]};
  const mapped=remapObservedEnvironment(capture,[{observedSchoolId:'observed',fixtureSchoolIndex:0}],'2026-10-03',['actual-snapshot-school0','actual-snapshot-school1']);
  assert.deepEqual(JSON.parse(mapped.environment.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON).restrictionAuthPassThroughV1.schoolIds,['actual-snapshot-school0']);
  assert.throws(()=>remapObservedEnvironment(capture,[],'2026-10-03'));
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
  assert.ok(generated.includes('stage.fromRound*60_000+stage.reconnectStartDelayMs'));assert.ok(generated.includes('controlSockets[2]=reconnected'));
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

test('intentional lifecycle409 logs require the exact observed request, code and one occurrence',()=>{
  const requestId='12345678-1234-4123-8123-123456789abc',probe={requestId,status:409,code:'PRIVATE_CHAT_LIFECYCLE_STALE'};
  const line=`Error [req:${requestId}]: { errorType: 'Error', errorCode: 'PRIVATE_CHAT_LIFECYCLE_STALE' }`;
  assert.equal(classifyLog(line,'api',{complete:true}).errorCount,1);
  const permitted=classifyLog(line,'api',{complete:true,expectedNegativeProbes:[probe]});assert.equal(permitted.errorCount,0);assert.deepEqual(permitted.expectedNegativeRequestIds,[requestId]);
  assert.equal(negativeLogCoverage([{role:'api0',...permitted}],[probe]),true);assert.equal(negativeLogCoverage([{role:'api0',expectedNegativeRequestIds:[]}],[probe]),false);
  assert.equal(classifyLog(line+'\n'+line,'api',{complete:true,expectedNegativeProbes:[probe]}).errorCount,1);
  assert.equal(classifyLog(line.replace(requestId,'a'.repeat(36)),'api',{complete:true,expectedNegativeProbes:[probe]}).errorCount,1);
  assert.equal(classifyLog(line+' SQLSTATE 40P01','api',{complete:true,expectedNegativeProbes:[probe]}).errorCount,1);
  assert.throws(()=>classifyLog(line,'api',{complete:true,expectedNegativeProbes:[{...probe,status:500}]}));
});

test('only the non-serving fixture seeder omits the not-yet-created Redis endpoint',()=>{
  const args={base:{DB_POOL_MAX:'20',SCHEDULER_DB_POOL_MAX:'5'},source,run:'a'.repeat(12),appUrl:'synthetic',adminUrl:'synthetic',profile:PROFILES.classroom,tables:[],secrets:{},arm:'C'};
  assert.equal(roleEnvironment({...args,role:'seeder'}).REDIS_URL,undefined);
  for(const role of ['api0','worker','generator'])assert.equal(roleEnvironment({...args,role}).REDIS_URL,'redis://127.0.0.1:6387');
});

test('a final response published during exit is checked, while missing or foreign replies fail',async()=>{
  for(const reply of ['bound','missing','foreign']){
    const root=mkdtempSync(join(tmpdir(),'release297-final-response-')), privateDirectory=join(root,'private'),outputDirectory=join(root,'output');mkdirSync(privateDirectory);mkdirSync(outputDirectory);
    const run='a'.repeat(12),id='c'.repeat(64),image='sha256:'+digest,containerImage='sha256:'+'e'.repeat(64),pgContainerId='d'.repeat(64),role='api0';
    const control=join(privateDirectory,role);let running=true;
    const frame=value=>JSON.stringify({...value,binding:{run,source,role,containerId:reply==='foreign'?'f'.repeat(64):id}});
    const docker=async args=>{
      if(args[0]==='create')return id;
      if(args[0]==='start'){writeFileSync(join(control,'ready.json'),JSON.stringify({binding:{run,source,role,containerId:id}}));return '';}
      if(args[0]==='inspect'){
        if(running&&existsSync(join(control,'binding.json'))&&args[1]===id){
          try{const request=JSON.parse(readFileSync(join(control,'request-1.json')));if(reply!=='missing')writeFileSync(join(control,'response-1.json'),frame({id:request.id,value:'final-ack'}));running=false;}catch(error){if(error.code!=='ENOENT')throw error;}
        }
        return JSON.stringify([{Id:id,Name:`/schoolpilot-release297-v2-${role}-${run}`,Image:containerImage,Config:{Image:image,Labels:{'codex.release297-v2':run,'codex.release297-role':role,'codex.release297-source':source}},HostConfig:{NetworkMode:'container:'+pgContainerId,NanoCpus:1e9,Memory:1024,MemorySwap:1024,Privileged:false,ReadonlyRootfs:true},State:{Running:running,ExitCode:0}}]);
      }
      throw Error('Unexpected test Docker operation');
    };
    const owner=await ownRole({docker,run,source,helperImage:image,helperConfigDigest:containerImage,helperContainerImage:containerImage,preparation:{executedFiles:{'scripts/load/usage/release-gates-v2/blackbox-api.mjs':digest}},pgContainerId,role,entryFile:'/harness/blackbox-api.mjs',environment:{NODE_ENV:'test'},privateDirectory,outputDirectory,cpu:1,memory:1024});
    if(reply==='bound')assert.equal(await owner.rpc('shutdown'), 'final-ack');else await assert.rejects(owner.rpc('shutdown'));
  }
});

test('a bare image digest builds only through its verified owned local tag and cleans on failure',async()=>{
  for(const buildFails of [false,true]){
    const image='sha256:'+digest,tags=new Map([[image,{Id:image}]]),receipts=[];
    const invoke=async args=>{
      if(args[1]==='inspect'){if(!tags.has(args[2]))throw Error('Missing local image');return{stdout:JSON.stringify([tags.get(args[2])])};}
      if(args[1]==='tag'){assert.equal(args[2],image);assert.equal(tags.has(args[3]),false);tags.set(args[3],tags.get(image));return{stdout:''};}
      if(args[1]==='rm'){assert.ok(args[2].startsWith('schoolpilot-release297-v2-owned-base-'));tags.delete(args[2]);return{stdout:''};}
      throw Error('Unexpected image operation');
    };
    const operation=withPinnedBuildBase(image,invoke,async tag=>{assert.ok(tag.startsWith('schoolpilot-release297-v2-owned-base-'));assert.equal(tags.get(tag).Id,image);if(buildFails)throw Error('Build failure');return'compiled';},(name,value)=>receipts.push({name,value}));
    if(buildFails)await assert.rejects(operation,/Build failure/);else assert.equal(await operation,'compiled');
    assert.equal(tags.size,1);assert.equal(receipts[0].value.cleanupPassed,true);assert.equal(receipts[0].value.baseBytesChanged,false);
  }
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
  verifiedReceiptManifestSha256:digest,fixtureLogicalSha256:digest,nodeVersion:'v22.23.3',clientAdvertisementSha256:digest,clientAdvertisementVersion:'2.9.6',
  harnessSource:'c'.repeat(40),schemaSha256:arm==='A'?digest:'b'.repeat(64),applicationImage:'sha256:'+(arm==='A'?digest:'b'.repeat(64)),
  wholeOwnedCpuIncludesFinalClassificationFlush:true,wholeOwnedApiCpuMicroseconds:(arm==='A'?10:10.4)*2040*1000}));}
test('paired nonregression rejects noisy controls, bad margins and another profile',()=>{
  const options={profile:PROFILES.normal,baselineSource:source,candidateSource:candidate,observedFlagsSha256:digest};
  const rows=pairRecords();assert.equal(validatePairs(rows,options).passed,true);
  rows[3].cpuMsPer200=11.1;rows[3].wholeOwnedApiCpuMicroseconds=11.1*2040*1000;assert.equal(validatePairs(rows,options).passed,false);
  const noise=pairRecords();noise[1].cpuMsPer200=10.6;noise[1].wholeOwnedApiCpuMicroseconds=10.6*2040*1000;assert.equal(validatePairs(noise,options).disposition,'inconclusive-control-variance');
  const wrong=pairRecords();wrong[3].profile=PROFILES.sole.name;assert.throws(()=>validatePairs(wrong,options));
  const drift=pairRecords();drift[3].harnessSource='d'.repeat(40);assert.throws(()=>validatePairs(drift,options));
  const schemaDrift=pairRecords();schemaDrift[3].schemaSha256='c'.repeat(64);assert.throws(()=>validatePairs(schemaDrift,options));
});

test('the separate800 profile selects only acknowledged lost clients and keeps survivor bindings steady',()=>{
  const profile=PROFILES.broaderConcentrated,startsAtMs=1000,sticky=stageForRound(9,profile),survivors=stageForRound(10,profile);
  const samples=[0,1].flatMap(schoolIndex=>Array.from({length:400},(_,deviceIndex)=>({schoolIndex,deviceIndex,targetIndex:stickyTarget(schoolIndex*500+deviceIndex,sticky.active,sticky.distribution),observedAtMs:startsAtMs+590_000})));
  const selected=lostReconnectBindings(samples,profile,startsAtMs);assert.equal(selected.observedBindings,800);assert.equal(selected.lostBindings,640);assert.deepEqual(selected.schools.map(row=>row.length),[320,320]);
  assert.deepEqual(expectedTopologyCounts(profile,survivors),{1:4320,2:480});
  const extra={lostBindingEvidence:selected,offered:640,targetHistogram:{1:640},bindings:Object.fromEntries(selected.schools.flatMap((rows,schoolIndex)=>rows.map(row=>[`${schoolIndex}:${row.deviceIndex}`,{acknowledged204:1}])))};
  assert.equal(validateLostReconnectEvidence(extra,profile),true);assert.equal(validateLostReconnectEvidence({...extra,targetHistogram:{1:639,2:1}},profile),false);
  for(const sample of samples){const target=stickyTarget(sample.schoolIndex*500+sample.deviceIndex,survivors.active,survivors.distribution);assert.equal(target,sample.targetIndex===0?1:sample.targetIndex);}
  assert.throws(()=>lostReconnectBindings(samples.slice(1),profile,startsAtMs));
  assert.throws(()=>lostReconnectBindings(samples.map((row,index)=>index===0?{...row,targetIndex:2}:row),profile,startsAtMs));
  assert.throws(()=>lostReconnectBindings(samples.map(row=>({...row,observedAtMs:startsAtMs+600_000})),profile,startsAtMs));
});

test('declared reconnect subsets offer exact actual bindings and cannot remap ordinary traffic',async()=>{
  const config={...PROFILES.sole.offering,requestsPerSecond:20,schoolDevices:[3,0],durationMs:150,deviceCadenceMs:150,expected:3,maxInFlight:3},seen=[];
  const mapper=offer=>({...offer,deviceIndex:[0,2,3][offer.deviceIndex]});
  const result=await offerHeartbeats(async offer=>{seen.push(offer.deviceIndex);return{status:204,targetIndex:1};},{config,reconnect:true,mapOffer:mapper});
  assert.deepEqual(seen,[0,2,3]);assert.equal(result.accepted,true);assert.equal(result.bindings['0:3'].acknowledged204,1);assert.equal(result.bindings['0:1'],undefined);
  await assert.rejects(offerHeartbeats(async()=>({status:200}),{config,mapOffer:mapper}));
});

test('Usage requires measured paired release closures, while the old single-task journal stays diagnostic',()=>{
  const root=mkdtempSync(join(tmpdir(),'release297-usage-comparisons-'));
  const usage=declareCampaign({directory:join(root,'usage'),kind:'usage',profile:PROFILES.usage.name,candidateSource:candidate,observedFlagsSha256:digest});
  assert.equal(usage.pairedReleaseComparisonRequired,true);assert.equal(usage.historicalSingleTaskDiagnosticOnly,true);assert.equal(usage.originalComparisonRequired,undefined);
  const broad=declareCampaign({directory:join(root,'broader'),kind:'mixed',profile:PROFILES.broader.name,candidateSource:candidate,observedFlagsSha256:digest});assert.deepEqual(broad.order,['C','C','C']);assert.equal(broad.capacityAccepted,false);
  assert.throws(()=>verifyUsageComparisons({originalComparisonFile:'old-single-task',originalComparisonSha256:digest},usage));
});

test('paired closure verification rejects wrong candidate, incomplete campaigns and old-single substitution',()=>{
  const root=mkdtempSync(join(tmpdir(),'release297-paired-closure-negative-'));
  for(const kind of ['wrong-source','incomplete','old-single']){
    const directory=join(root,kind);mkdirSync(directory);
    const contract={kind:'paired',profile:kind==='old-single'?PROFILES.overload.name:PROFILES.normal.name,candidateSource:kind==='wrong-source'?source:candidate,observedFlagsSha256:digest,contractSha256:profileHash(PROFILES.normal)};
    const contractBytes=JSON.stringify(contract),journalBytes=JSON.stringify({contractSha256:hash(contractBytes),closed:true,attempts:Array(7).fill({state:'recorded'})});
    writeFileSync(join(directory,'contract.json'),contractBytes);writeFileSync(join(directory,'journal.json'),journalBytes);
    const closureBytes=JSON.stringify({contractSha256:hash(contractBytes),journalSha256:hash(journalBytes),passed:true});writeFileSync(join(directory,'closure.json'),closureBytes);
    assert.throws(()=>verifyPairedClosure({directory,closureSha256:hash(closureBytes),privateDirectories:Array(8).fill(root)},{profile:PROFILES.normal,candidateSource:candidate,observedFlagsSha256:digest}));
  }
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


test('Usage paired comparisons reject candidate image and canonical schema drift',()=>{
  const binding={source:candidate,applicationImage:'sha256:'+'b'.repeat(64),schemaSha256:'b'.repeat(64)};
  assert.doesNotThrow(()=>assertCandidateBinding(pairRecords(),binding));
  for(const key of ['applicationImage','schemaSha256']){
    const rows=pairRecords();rows[3][key]=key==='applicationImage'?'sha256:'+'c'.repeat(64):'c'.repeat(64);
    assert.throws(()=>assertCandidateBinding(rows,binding));
  }
  const usage=Array.from({length:3},()=>({...pairRecords()[3],arm:'C',profile:PROFILES.usage.name}));
  assert.deepEqual(usageCandidateBinding(usage,candidate),binding);
  assert.throws(()=>assertCandidateBinding(pairRecords(),{...binding,schemaSha256:'c'.repeat(64)}));
  assert.throws(()=>usageCandidateBinding([{...usage[0],applicationImage:'sha256:'+'d'.repeat(64)},...usage.slice(1)],candidate));
});

test('canonical native schema retains function, parent validation, RLS and inventory semantics',()=>{
  const ddl="\\restrict ABC123\nCREATE FUNCTION test() RETURNS text AS $$ SELECT 'original'; $$ LANGUAGE sql;\nCREATE TRIGGER parent_check BEFORE INSERT ON messages EXECUTE FUNCTION test();\nCREATE POLICY school_scope ON messages USING (school_id = current_setting('app.school_id'));\nALTER TABLE messages ADD CONSTRAINT parent_fk FOREIGN KEY (parent_id) REFERENCES threads(id);\nINSERT INTO tenant_rls_inventory VALUES ('messages');\n\\unrestrict ABC123\n";
  const fingerprint=canonicalSchemaFingerprint(ddl);
  assert.equal(fingerprint,canonicalSchemaFingerprint('\uFEFF'+ddl.replaceAll('ABC123','XYZ789').replaceAll('\n','\r\n')));
  for(const [before,after] of [["'original'","'changed'"],['BEFORE INSERT','BEFORE UPDATE'],['school_id =','school_id <>'],['threads(id)','other_threads(id)'],["('messages')","('threads')"]])
    assert.notEqual(fingerprint,canonicalSchemaFingerprint(ddl.replace(before,after)));
});

test('both Usage-enabled 800 routing cases require actual report and worker obligations',()=>{
  const ordinary=PROFILES.broader,concentrated=PROFILES.broaderConcentrated;
  assert.notEqual(profileHash(ordinary),profileHash(concentrated));
  for(const profile of [ordinary,concentrated]){
    assert.equal(profile.usage,true);assert.equal(profile.reports,64);assert.equal(profile.rawPerSchool,1_000_000);
    assert.equal(profile.workerAcceptanceMs,48_000);assert.equal(profile.workerStartAtMs,600_000);assert.equal(profile.capacityDeadlinesOnly,true);
    assert.deepEqual(profile.reportWaveOffsetsMs,[0,300_000,600_000,720_000]);
    assert.equal(stageForRound(10,profile).reconnectOffers,640);
  }
  const profile=ordinary,startsAtMs=1000,sticky=stageForRound(9,profile),survivors=stageForRound(10,profile);
  const samples=[0,1].flatMap(schoolIndex=>Array.from({length:400},(_,deviceIndex)=>({schoolIndex,deviceIndex,targetIndex:stickyTarget(schoolIndex*500+deviceIndex,sticky.active,sticky.distribution),observedAtMs:startsAtMs+590_000})));
  const selected=lostReconnectBindings(samples,profile,startsAtMs);
  const extra={lostBindingEvidence:selected,offered:640,targetHistogram:{1:320,2:320},bindings:Object.fromEntries(selected.schools.flatMap((rows,schoolIndex)=>rows.map(row=>[`${schoolIndex}:${row.deviceIndex}`,{acknowledged204:1}])))};
  assert.deepEqual(expectedTopologyCounts(profile,survivors),{1:2400,2:2400});assert.equal(validateLostReconnectEvidence(extra,profile),true);
  assert.equal(validateLostReconnectEvidence({...extra,targetHistogram:{1:640}},profile),false);
  assert.throws(()=>verifyBroaderGate({campaigns:[{directory:'single-concentrated-case'}]}));
});


test('mixed Usage cannot omit workers, reports, coverage, audit or worker database evidence',()=>{
  const profile=PROFILES.broader,stage=stageForRound(0,profile),negative=[{requestId:'12345678-1234-4123-8123-123456789abc',status:409,code:'PRIVATE_CHAT_LIFECYCLE_STALE'},{requestId:'22345678-1234-4123-8123-123456789abc',status:409,code:'PRIVATE_CHAT_LIFECYCLE_STALE'}];
  const reports=reportRows().map(row=>({...row,scheduledOffsetMs:profile.reportWaveOffsetsMs[row.wave],offeredOffsetMs:profile.reportWaveOffsetsMs[row.wave]+1,
    endpointIndex:stickyTarget(row.schoolIndex*500,stageForRound(Math.floor(profile.reportWaveOffsetsMs[row.wave]/60_000),profile).active,stageForRound(Math.floor(profile.reportWaveOffsetsMs[row.wave]/60_000),profile).distribution)}));
  const usage={reports,workers:[0,1].map(schoolIndex=>({schoolIndex,correct:true,durationMs:47_000,startedAtMs:601003,finishedAtMs:648003})),correctness:{passed:true,audit:{passed:true,auditRecords:Array(8).fill({})}},
    workerDatabase:{acquisitions:{count:2,failures:0},statements:{rollup:{failures:0}}},workerStartAtMs:600_000,workerStartedOffsetMs:600_002,startsAtMs:1000};
  const traffic={expected:4800,configured:profile.offering,accepted:true,started:4800,succeeded:4800,failed:0,refusedAtInFlightLimit:0,lateOffers:0,outstandingAfterDrain:0,
    timings:{count:4800,maxMs:15000,p95Ms:1000},capabilityAcknowledgements200:4800,targetHistogram:expectedTopologyCounts(profile,stage)};
  const round={profile:profile.name,contractSha256:profileHash(profile),traffic:{heartbeats:traffic,lifecycle:{passed:true,expectedNegativeProbes:negative}},topology:stage,
    invalidBindings:0,persistence:{passed:true},continuousGlobal:{passed:true,actualPersisted:72000,acknowledged200:72000,targetCounts:true,usage},drains:[{complete:true}],
    errorCoverage:Array.from({length:5},()=>({available:true,complete:true,errorCount:0,sha256:digest})),databaseFailures:0};
  assert.equal(validateRound(round,profile).passed,true); // Usage deadlines, not dark-release CPU/500ms criteria.
  const unavailableCpu=structuredClone(round);unavailableCpu.cpuByRole=[{window:{windowFailed:true},...cpuObservation({windowFailed:true},{strict:false})}];assert.equal(validateRound(unavailableCpu,profile).passed,true);
  for(const key of ['reports','workers','correctness','workerDatabase']){const altered=structuredClone(round);delete altered.continuousGlobal.usage[key];assert.equal(validateRound(altered,profile).passed,false,key);}
  const late=structuredClone(round);late.continuousGlobal.usage.workers[0].durationMs=48_001;assert.equal(validateRound(late,profile).passed,false);
  const failure=structuredClone(round);failure.continuousGlobal.usage.workerDatabase.statements.rollup.failures=1;assert.equal(validateRound(failure,profile).passed,false);
  const missed=structuredClone(round);missed.continuousGlobal.usage.workerStartedOffsetMs=630000;missed.continuousGlobal.usage.workers.forEach(row=>{row.startedAtMs=631000;row.finishedAtMs=678000;});assert.equal(validateRound(missed,profile).passed,false);
  const noLog=structuredClone(round);noLog.errorCoverage.pop();assert.equal(validateRound(noLog,profile).passed,false);
});


test('worker loss overlap uses actual native worker intervals and real loss-wave request intervals',()=>{
  const usage={startsAtMs:1000,workers:[0,1].map(schoolIndex=>({schoolIndex,startedAtMs:601003,finishedAtMs:630000})),reports:reportRows().map(row=>({...row,offeredOffsetMs:PROFILES.broader.reportWaveOffsetsMs[row.wave]+2,durationMs:40}))};
  assert.equal(workerLossOverlap(usage,PROFILES.broader),true);
  assert.equal(workerLossOverlap({...usage,workers:usage.workers.map(row=>({...row,startedAtMs:620000,finishedAtMs:630000}))},PROFILES.broader),false);
  assert.equal(workerLossOverlap({...usage,workers:usage.workers.map(row=>({...row,finishedAtMs:601010}))},PROFILES.broader),false);
});


test('optional Usage CPU timing remains unavailable while dark mixed keeps strict capture criteria',()=>{
  const late={declaredDurationMs:60_000,startDelayMs:1000,endDelayMs:1000,start:{cpu:{usage_usec:0},hrtimeMicroseconds:0},end:{cpu:{usage_usec:40_000_000},hrtimeMicroseconds:60_000_000}};
  const optional=cpuObservation(late,{strict:false});assert.equal(optional.available,false);assert.equal(optional.acceptedAsCpuEvidence,false);assert.equal(optional.meanFraction,null);
  assert.throws(()=>cpuObservation(late));assert.throws(()=>cpuWindow(late));
});


test('v2 snapshot cleanup overlays only exact owned graceful cleanup and preserves frozen ABI bytes',async()=>{
  const url=new URL('../roles/restore-snapshot.mjs',import.meta.url),original=readFileSync(url,'utf8'),before=hash(original),overlay=gracefulSnapshotOverlay(original,url);
  assert.equal(hash(readFileSync(url,'utf8')),before);assert.ok(overlay.includes("call(['stop','--time','30',actualId]"));
  assert.ok(overlay.includes("assert.equal(stopped.ExitCode,0)"));assert.ok(!overlay.includes("call(['rm','--force'"));assert.ok(overlay.includes("call(['rm','--volumes',actualId]"));
  const native=await import(url),adapted=await import('data:text/javascript;base64,'+Buffer.from(overlay).toString('base64'));
  assert.equal(typeof adapted.withRestoredSnapshot,'function');assert.equal(adapted.assertUnexpiredRestoreGate.toString().replaceAll('\r\n','\n'),native.assertUnexpiredRestoreGate.toString().replaceAll('\r\n','\n'));
  assert.equal(adapted.compareNativeSchemas.toString().replaceAll('\r\n','\n'),native.compareNativeSchemas.toString().replaceAll('\r\n','\n'));assert.equal(adapted.verifyOwnedSnapshotContainer.toString().replaceAll('\r\n','\n'),native.verifyOwnedSnapshotContainer.toString().replaceAll('\r\n','\n'));
  assert.throws(()=>gracefulSnapshotOverlay(original.replace("remove:actualId=>call(['rm','--force','--volumes',actualId]","changed"),url));
});


test('monotonic offering waits through undersleep at each due time and the complete window',async()=>{
  let clock=0,waits=0;const offered=[];
  const config={...PROFILES.normal.offering,requestsPerSecond:20,schoolDevices:[3,0],durationMs:150,deviceCadenceMs:150,expected:3,maxInFlight:3};
  const result=await offerHeartbeats(async offer=>{offered.push({offset:offer.offsetMs,actual:clock});return{status:200,targetIndex:0};},
    {config,now:()=>clock,sleep:async ms=>{waits++;clock+=Math.max(.1,ms-.75);}});
  assert.equal(result.accepted,true);assert.ok(waits>3);assert.ok(offered.every(row=>row.actual>=row.offset));
  assert.ok(result.offerWindowMs>=config.durationMs);assert.equal(result.offered,3);assert.equal(result.outstandingAfterDrain,0);
});
