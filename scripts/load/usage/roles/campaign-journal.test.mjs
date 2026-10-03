import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute,resolve,sep} from 'node:path';
import {canonicalHash,hash} from './receipt-loader.mjs';
import {validateCandidateRun,CAMPAIGN_CONTRACT_SHA256} from './campaign-validation.mjs';
import {PROFILE,ROLE_LIMITS,POOL_LIMITS,LIFECYCLE_EVENTS} from './profile.mjs';
import {runCampaignAttempt,campaignCommand} from './run-campaign.mjs';
import {OPEN_LOOP_HEARTBEATS} from '../open-loop-heartbeats.mjs';
import {RELEASE_ENABLED_PROFILE} from '../release-enabled-profile.mjs';
import {RELEASE_DRAIN_OPERATIONS,releaseDrainGauges} from '../release-enabled-drain.mjs';
import {RUN_RECORDS,sealRunReceipts} from './receipt-writer.mjs';
import {createCampaign,registerAttempt,finishAttempt,closeJournal,closeCampaign,loadRegisteredAttempt} from './campaign-journal.mjs';

// Independent filesystem-owner fixtures, with the same strict synthetic receipt
// contract as campaign-validation.test.mjs. No Docker, database or load is run.
// Small synthetic owner receipts; never a real capacity or browser result.
const source = 'a'.repeat(40), sha = char => char.repeat(64), digest = char => 'sha256:' + sha(char);
const roles = Object.keys(ROLE_LIMITS), scopes = ['school','grade','class','student'];
const timestamp = n => new Date(Date.UTC(2026,9,3,12,0,n)).toISOString();
const zeroCounters = () => Object.fromEntries(['checkoutAttempts','checkoutSuccess','checkoutFailure','sqlFailure','admissionAdmitted','admissionDenied','admissionCancelled','heartbeatOptionalTelemetryFailures','heartbeatHandlerFailures','heartbeatOptionalInboxFailures','heartbeatInboxChecks'].map(key=>[key,0]));
const heartbeat = () => ({configured:{...OPEN_LOOP_HEARTBEATS},expected:6000,offered:6000,started:6000,succeeded:6000,failed:0,refusedAtInFlightLimit:0,lateOffers:0,maxOfferLatenessMs:5,peakInFlight:30,
  bySchool:{0:{offered:3000,started:3000,succeeded:3000,failed:0,refused:0},1:{offered:3000,started:3000,succeeded:3000,failed:0,refused:0}},
  offerWindowMs:59990,totalIncludingDrainMs:60100,outstandingAfterDrain:0,accepted:true,timings:{count:6000,minMs:1,p50Ms:20,p95Ms:50,maxMs:100}});
const heavyWorkers = () => [0,1].map(schoolIndex=>({schoolIndex,correct:true,rowCount:84000,seconds:10002500,heartbeatCount:1000000,durationMs:48000}));
const currentWorkers = () => [0,1].map(schoolIndex=>({schoolIndex,correct:true,rowCount:500,seconds:30000,expectedSeconds:30000,heartbeatCount:3000,durationMs:100,
  fixtureViolations:{unexpectedStudents:0,unexpectedUrlObservations:0,unexpectedClassificationObservations:0,unexpectedTeacherIntentObservations:0,currentAiDecisionRows:0,invalidRosterStudents:0},
  timestampPrecision:{precision:'integer_microseconds_text',exactRoundedSeconds:30000,students:500}}));
function server(worker=false) {
  return {database:{acquisitions:{count:worker?2:12000,failures:0,maxMs:1},statements:{select:{count:1,failures:0,maxMs:1}},pendingAcquisitions:0,activeQueries:0,pools:{main:{waiting:0,held:0}}},
    http:{activeResponses:0,abortedResponses:0},tenantReleases:{pending:0},measurementStartedHrtimeMicroseconds:100,snapshotHrtimeMicroseconds:200,
    operations:{schemaVersion:2,operations:Object.fromEntries(RELEASE_DRAIN_OPERATIONS.map(name=>[name,{counters:zeroCounters(),activeOperations:0,pendingCheckouts:0,activeCheckouts:0}]))}};
}
const drain = () => ({complete:true,physicallyIdle:true,abortedResponses:0,gauges:releaseDrainGauges(server())});
function resource(role, containerId, identity, after) {
  return {schemaVersion:1,role,containerId,source,imageId:identity.helper.imageId,runtimeSha256:identity.helper.runtimeSha256,harnessSha256:identity.harness.executed[role],
    hrtimeMicroseconds:after?200:100,cpuMax:`${ROLE_LIMITS[role].cpu*100000} 100000`,memoryMax:ROLE_LIMITS[role].memory,memorySwapMax:0,
    cpu:{usage_usec:after?100:0,user_usec:after?90:0,system_usec:after?10:0,nr_periods:after?1:0,nr_throttled:0,throttled_usec:0},memory:{current:1024,peak:2048,events:{oom:0,oom_kill:0,high:0,max:0}}};
}
function fixture(index=1) {
  const run=index.toString(16).padStart(12,'0'), pgContainerId=hash(`pg-${index}`),redisContainerId=hash(`redis-${index}`);
  const migrations=Array.from({length:53},(_,i)=>({id:`migration-${i}`,checksum:sha('7'),status:'complete'}));
  const files={'profile.mjs':sha('1'),'campaign-validation.mjs':sha('2'),'runtime-facts.mjs':sha('3')};
  const executed=Object.fromEntries(roles.map((r,i)=>[r,sha(String(i+4))]));
  const scan={passed:true,sourceSha:source,imageId:digest('1'),configDigest:digest('3'),os:'linux',architecture:'amd64',counts:{HIGH:0,CRITICAL:0}},scanRaw=JSON.stringify(scan);
  const binding={applicationSource:source,passed:true,cleanupPassed:true,applicationChanges:0,predeclaredExecutionMode:'capacity-candidate',allowedModes:['diagnostic','capacity-candidate'],candidateImageId:digest('1'),candidateConfigDigest:digest('3'),
    candidateScanReceiptSha256:hash(scanRaw),roleImageId:digest('4'),runtimeConfigDigest:digest('5'),runtimeSha256:sha('6'),harnessIdentity:hash(JSON.stringify(files)),roleHarnessSha256:files,harnessHashes:executed};
  const bindingRaw=JSON.stringify(binding);
  const identity={candidate:{indexDigest:digest('1'),platformManifestDigest:digest('2'),configDigest:digest('3'),scanReceiptSha256:hash(scanRaw)},
    helper:{imageId:digest('4'),runtimeConfigDigest:digest('5'),bindingSha256:hash(bindingRaw),runtimeSha256:sha('6')},harness:{identity:hash(JSON.stringify(files)),files,executed},
    profileSha256:files['profile.mjs'],validatorSha256:files['campaign-validation.mjs'],contractSha256:CAMPAIGN_CONTRACT_SHA256,schemaSha256:sha('8'),registrySha256:sha('9'),migrationSha256:hash(JSON.stringify(migrations))};
  const plan={schemaVersion:2,run,nonce:hash(`nonce-${index}`),source,mode:'capacity-candidate',profile:PROFILE,phase:'combined',diagnosticOnly:false,cpuProfile:false,
    declaredAt:timestamp(1),campaignSha256:sha('b'),ordinal:index,previousEntrySha256:sha('c'),identity};
  const image={indexDigest:digest('1'),platformManifestDigest:digest('2'),configDigest:digest('3')};
  const schools=[0,1].map(index=>({index,raw:1000001,aggregates:541500,currentSessions:100,rosterRows:500,staffBindings:100,staffIdentities:101,controls:500,exactLiveBindings:500,
    heavyBindings:{pairs:500,devices:500,invalid:0},ai:{rows:10000,students:500,observations:10000,invalid:0,minperstudent:20,maxperstudent:20},clocks:{schools:1,licenses:1,controls:500,sessions:100}}));
  const state=second=>({Running:true,Paused:false,Restarting:false,OOMKilled:false,Dead:false,Error:'',StartedAt:timestamp(second)});
  const preparation={run,source,startedAt:timestamp(2),finishedAt:timestamp(4),mode:'capacity-candidate',profile:PROFILE,pgContainerId,redisContainerId,fresh:true,redis:{containerId:redisContainerId,pgContainerId,createdAt:timestamp(7),readyAt:timestamp(7),afterColdRestart:true},
    restore:{source,snapshotManifestSha256:sha('d'),analyze:true,clientsClosed:true,validityHorizon:timestamp(600),
      databaseValidation:{source,seedSource:source,snapshotManifestSha256:sha('d'),passed:true,clientsClosed:true,measurementStarted:false,admittedTables:129,migrations:53,migrationsSha256:identity.migrationSha256,
        role:{sameUser:true,superuser:false,bypassRls:false,freshCredentialRole:true},schools,finishedAt:timestamp(3)},
      schemaComparison:{passed:true,originalSha256:sha('a'),referenceSha256:sha('b'),restoredSha256:sha('c'),originalCanonicalSha256:sha('8'),referenceCanonicalSha256:sha('6'),restoredCanonicalSha256:sha('6'),referenceNormalizedSha256:sha('5'),restoredNormalizedSha256:sha('5')}}};
  const cold={run,pgContainerId,before:state(2),after:state(7),clientsClosed:true,restarted:true,startedAfterValidation:true,validatedAt:timestamp(4),restartedAt:timestamp(6)};
  const gate={schemaVersion:2,run,nonce:plan.nonce,source,imageId:identity.helper.imageId,bindingSha256:identity.helper.bindingSha256,profile:PROFILE,mode:'capacity-candidate',phase:'combined',diagnosticOnly:false,releasedAt:timestamp(5),releaseSha256:sha('e')};
  const execution={sourceRevision:source,workloadProfile:PROFILE,candidateImageId:identity.candidate.indexDigest,diagnosticImageId:identity.helper.imageId,phase:'combined',diagnosticOnly:false,collectApiCpuProfile:false,
    coldPostgresRestart:true,hostFilesystemCachesFlushed:false,restrictedNonOwnerRole:true,rlsInventory:'classpilotPrivateChatLifecyclePostExpand',admittedTables:129,currentFixtureMigrations:true,registrySha256:identity.registrySha256,
    postgresCpu:4,postgresMemoryBytes:4294967296,roleNodeOldSpaceMiB:null,seederNodeOldSpaceMiB:512,productionMutations:0,exitCode:0};
  const metrics={sourceRevision:source,sourceClean:true,sourceUnchangedAtFinish:true,sourceAtFinish:{revision:source,clean:true},diagnosticOnly:false,cpuProfile:{enabled:false},
    execution:{profile:PROFILE,mode:'capacity-candidate',phase:'combined',diagnosticOnly:false},pools:{...POOL_LIMITS},prewarmed:16,readiness:true,redisReady:true,staffAuthenticationVerified:true,enabledCapabilitiesVerified:true,
    childShutdownClean:true,roleOwnershipClean:true,roleResourceEvidenceComplete:true,processes:{},preflightDrain:drain(),startedAt:timestamp(8),finishedAt:timestamp(80),
    poolReadiness:['api','session','worker'].map(name=>({name,max:POOL_LIMITS[name],acquisitionCalls:1,queryCalls:1,sameRole:true,neutralSchool:true,databaseSuperuser:false,databaseBypassRls:false,applicationSuperScope:name==='worker',checkoutDeadlineMs:name==='worker'?10000:5000,statementDeadlineMs:name==='worker'?60000:15000})),
    phases:[{name:'combined',insertedObservations:6000,traffic:{heartbeats:heartbeat(),heartbeatStatuses:{200:6000},
      reports:[1,7,30,365].flatMap((days,wave)=>[0,1].flatMap(schoolIndex=>scopes.flatMap(scope=>[0,1].map(()=>({wave,days,schoolIndex,scope,status:200,correct:true,durationMs:100}))))),
      lifecycle:{passed:true,simulatedClientAcknowledgements:true,browserEnforcementClaimed:false,events:[...LIFECYCLE_EVENTS,...LIFECYCLE_EVENTS]}},
      workers:heavyWorkers(),serverDrain:{api:drain(),worker:drain()},api:server(),worker:server(true)}],
    correctness:{passed:true,currentDayWorkers:currentWorkers(),csvAuditCount:8,exports:[0,1].flatMap(schoolIndex=>scopes.map(scope=>({schoolIndex,scope,csvSha256:sha('a'),durationMs:100,report:{scope:{kind:scope}}})))},roleResources:{}};
  const host={run,source,imageId:identity.helper.imageId,mode:'combined',pgContainerId,passed:true,roles:[],cleanup:{cleanupPassed:true,clean:true,roles:[]}};
  const cleanup={run,finishedAt:timestamp(85),cleanupPassed:true,roles:{cleanupPassed:true,roles:[]},fixtures:{cleanupPassed:true,resources:[{role:'postgres',id:pgContainerId,confirmedAbsent:true,cleanupPassed:true},{role:'redis',id:redisContainerId,confirmedAbsent:true,cleanupPassed:true}]}};
  const runtimeFlags={};
  for(const role of roles){
    const containerId=hash(`${run}-${role}`),caps={nanoCpus:ROLE_LIMITS[role].cpu*1e9,memoryBytes:ROLE_LIMITS[role].memory,memorySwapBytes:ROLE_LIMITS[role].memory,heapMiB:null};
    if(role!=='coordinator')metrics.processes[role]=`${containerId}:123`;
    const exit={role,run,source,containerId,imageId:identity.helper.imageId,inspected:true,running:false,logsClosed:true,exitCode:0,attachExitCode:0,forced:false,oomKilled:false,clean:true};
    host.roles.push({role,containerId,caps,exit,inspection:{run,source,containerId,imageId:identity.helper.imageId,runtimeConfigDigest:identity.helper.runtimeConfigDigest,pgContainerId,caps,checks:{command:true,mounts:true,environment:true,security:true,identity:true,resources:true,network:true}}});
    host.cleanup.roles.push({role,containerId,cleanupPassed:true,cleanExit:true,forced:false});cleanup.roles.roles.push({role,id:containerId,confirmedAbsent:true,cleanupPassed:true,forced:false});
    metrics.roleResources[role]={before:resource(role,containerId,identity,false),after:resource(role,containerId,identity,true)};
    const stages=role==='coordinator'?['startup','exit']:role==='generator'?['startup','phase_start','shutdown','exit']:['startup','phase_reset','phase_snapshot','shutdown','exit'];
    runtimeFlags[role]=stages.map((stage,i)=>({role,source,profile:PROFILE,node:'22.23.3',diagnosticOnly:false,preloaderSha256:files['runtime-facts.mjs'],execArgv:['--import','/prototype/runtime-facts.mjs'],
      nodeOptionsPresent:false,oldSpaceOverrideMiB:null,heap:{heap_size_limit:1024*1024*1024},hrtimeMicroseconds:100+i,...(stage==='exit'?{exitCode:0}:{}),stage}));
  }
  const bundle={plan,preparation,cold,gate,execution,final:{source,clean:true,unchanged:true,harnessSha256:identity.harness.identity},candidate:{scan,scanRaw,image},runtime:{binding,bindingRaw,proof:{node:'v22.23.3',runtimeSha256:identity.helper.runtimeSha256}},metrics,roles:host,cleanup,
    database:{schemaSha256:identity.schemaSha256,nativeRenderedSchemaSha256:sha('5'),registrySha256:identity.registrySha256,migrations,admission:{inventory:'classpilotPrivateChatLifecyclePostExpand',tables:129,forced:true,restrictedNonOwnerRole:true}},runtimeFlags};
  const phase=metrics.phases[0];
  phase.traffic.heartbeatCapabilityProof={requiredCapabilities:['preciseRestrictionResourcesV1','focusTabV1','privateChatLifecycleV1','lateSignInRestrictionSsoV1','restrictionAuthPassThroughV1','screenshotTrackingWindowLeaseV1'],validatedResponses:6000};
  phase.persistedBefore=[0,1].map(index=>({school_id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,count:6}));
  phase.persistedAfter=phase.persistedBefore.map(row=>({...row,count:3006}));
  for(const row of metrics.correctness.currentDayWorkers)Object.assign(row,{schoolId:phase.persistedAfter[row.schoolIndex].school_id,rawObservationCount:3006,persistedObservationCount:3006,heartbeatCount:3006});
  return bindPlan(bundle);
}
function bindPlan(bundle){bundle.planRaw=JSON.stringify(bundle.plan);const trustedPlanSha256=hash(bundle.planRaw);bundle.preparation.planSha256=trustedPlanSha256;return {bundle,trustedPlanSha256};}
function validate(f){return validateCandidateRun(f.bundle,f.trustedPlanSha256);}


function comparison(identity){
  const scriptHashes=Object.fromEntries(['run-release-enabled-scale.ps1','release-enabled-scale.mjs','release-enabled-generator.mjs','release-enabled-process.mjs','release-enabled-profile.mjs'].map((key,n)=>[key,sha(String(n+1))]));
  const metrics=fixture().bundle.metrics;metrics.profile=structuredClone(RELEASE_ENABLED_PROFILE);metrics.processes={api:100,worker:101,generator:102};metrics.capacityAccepted=true;metrics.sourceHashes=scriptHashes;
  metrics.startedAt=timestamp(100);metrics.finishedAt=timestamp(172);
  delete metrics.phases[0].traffic.heartbeatCapabilityProof;
  for(const row of metrics.correctness.currentDayWorkers){delete row.schoolId;delete row.rawObservationCount;delete row.persistedObservationCount;}
  delete metrics.execution;delete metrics.poolReadiness;delete metrics.roleOwnershipClean;delete metrics.roleResourceEvidenceComplete;delete metrics.roleResources;
  const execution={sourceRevision:source,workloadProfile:RELEASE_ENABLED_PROFILE.name,phase:'combined',diagnosticOnly:false,collectApiCpuProfile:false,nodeOldSpaceMiB:512,exitCode:0,productionMutations:0,
    coldPostgresRestart:true,hostFilesystemCachesFlushed:false,restrictedNonOwnerRole:true,admittedTables:129,registrySha256:identity.registrySha256,postgresCpu:4,postgresMemoryBytes:4294967296};
  const receipt={source,schemaSha256:identity.schemaSha256,profile:RELEASE_ENABLED_PROFILE.name,scriptHashes,metrics,execution,exitCode:0,cleanupPassed:true,
    schemaFingerprint:{canonicalSha256:identity.schemaSha256},cleanup:{resources:[{role:'postgres',id:sha('c'),confirmedAbsent:true,cleanupPassed:true},{role:'redis',id:sha('d'),confirmedAbsent:true,cleanupPassed:true}]}};
  const raw=JSON.stringify(receipt);return {raw,receipt,expected:{source,schemaSha256:identity.schemaSha256,profile:RELEASE_ENABLED_PROFILE.name,phase:'combined',diagnosticOnly:false,collectApiCpuProfile:false,nodeOldSpaceMiB:512,scriptHashes}};
}

function owner(t) {
  t.mock.timers.enable({apis:['Date'],now:Date.parse(timestamp(-1))});
  const parent = realpathSync(tmpdir()), base = mkdtempSync(join(parent, 'schoolpilot-campaign-journal-'));
  t.after(() => {
    const target = resolve(base), rel = relative(parent, target);
    assert.ok(rel.startsWith('schoolpilot-campaign-journal-') && !rel.includes(sep) && !isAbsolute(rel));
    assert.equal(realpathSync(base), target);
    rmSync(target, {recursive:true,force:true});
  });
  const directory = join(base, 'campaign'), identity = fixture().bundle.plan.identity;
  const original = comparison(identity), declaration = {mode:'capacity-candidate',source,profile:PROFILE,phase:'combined',diagnosticOnly:false,identity,originalComparison:original.expected};
  const created = createCampaign(directory, declaration);
  const trusted = {trustedCampaignSha256:created.campaignSha256};
  const setTime = second => t.mock.timers.setTime(Date.parse(timestamp(second)));
  const options = n => ({...trusted,run:n.toString(16).padStart(12,'0'),nonce:hash(`nonce-${n}`),source,outputDirectory:join(base,`run-${n}`)});
  function register(n) { setTime((n-1)*1000); return registerAttempt(directory, options(n)); }
  function seal(n, r, mutate = () => {}) {
    const shift = value => Array.isArray(value) ? value.map(shift) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shift(v)])) : typeof value === 'string' && /^2026-10-03T/.test(value) ? new Date(Date.parse(value)+(n-1)*1000000).toISOString() : value;
    const b = shift(fixture(n).bundle); b.plan = r.plan; b.planRaw = r.planRaw; b.preparation.planSha256 = r.planSha256;b.gate.nonce=r.plan.nonce;
    mutate(b);
    const output = options(n).outputDirectory; mkdirSync(output);
    for (const [name,file] of Object.entries(RUN_RECORDS)) writeFileSync(join(output,file),name === 'plan' ? r.planRaw : JSON.stringify(b[name]),{flag:'wx'});
    const loaded = sealRunReceipts(output,r.planSha256);
    setTime((n-1)*1000+90);
    return {bundle:b,loaded};
  }
  function complete(n,r,mutate=()=>{}) {
    const proof=seal(n,r,mutate);
    const entry=finishAttempt(directory,{...trusted,registrationSha256:r.registrationSha256,status:'completed',cleanupRaw:JSON.stringify(proof.bundle.cleanup),receiptManifestSha256:proof.loaded.receiptManifestSha256});
    return {entry,...proof};
  }
  function fail(n,r,status='setup-failed',cleanupPassed=true) {
    const cleanupRaw = JSON.stringify({run:r.plan.run,finishedAt:timestamp((n-1)*1000+85),cleanupPassed}); setTime((n-1)*1000+90);
    return finishAttempt(directory,{...trusted,registrationSha256:r.registrationSha256,status,cleanupRaw,failureCode:'SYNTHETIC_FIXTURE_FAILURE'});
  }
  function close(n) { setTime(n*1000); return closeJournal(directory,trusted); }
  function closeComparison(n,journal,mutate = () => {}) {
    const c = comparison(identity).receipt; c.metrics.startedAt=timestamp(n*1000+100);c.metrics.finishedAt=timestamp(n*1000+172);mutate(c);setTime(n*1000+180);
    return closeCampaign(directory,{...trusted,trustedJournalSha256:journal.trustedJournalSha256,comparisonRaw:JSON.stringify(c)});
  }
  return {base,directory,created,declaration,trusted,options,register,seal,complete,fail,close,closeComparison,setTime};
}

test('pre-fixture immutable registration and three complete runs bind the post-streak comparison',t=>{
  const o=owner(t), declaration=readFileSync(join(o.directory,'campaign.json'),'utf8'), prior=[];
  for(let n=1;n<=3;n++){
    const r=o.register(n);assert.equal(readdirSync(o.base).includes(`run-${n}`),false);
    assert.equal(r.plan.ordinal,n);assert.equal(hash(r.planRaw),r.planSha256);
    assert.equal(r.plan.previousEntrySha256,n===1?o.created.campaignSha256:prior.at(-1).entrySha256);
    const done=o.complete(n,r);assert.equal(validateCandidateRun(done.bundle,r.planSha256).runPassed,true);prior.push(done.entry);
  }
  const journal=o.close(3);assert.equal(journal.capacityAccepted,false);
  const closed=o.closeComparison(3,journal);assert.equal(closed.validation.capacityAccepted,true);assert.equal(closed.validation.productionReadiness,false);
  assert.equal(closed.validation.attemptResults.length,3);
  const closure=JSON.parse(closed.closureRaw);assert.equal(closure.journalSha256,journal.trustedJournalSha256);
  assert.equal(closure.comparisonDeclarationSha256,canonicalHash(o.declaration.originalComparison));
  assert.equal(closure.comparisonReceiptSha256,hash(readFileSync(join(o.directory,'comparison.json'))));
  assert.equal(readFileSync(join(o.directory,'campaign.json'),'utf8'),declaration);
  assert.equal('receiptSha256' in o.declaration.originalComparison,false);
});

test('failed and aborted attempts remain in chain before three later consecutive passes',t=>{
  const o=owner(t);
  const first=o.fail(1,o.register(1),'setup-failed'), second=o.fail(2,o.register(2),'aborted');
  for(let n=3;n<=5;n++)o.complete(n,o.register(n));
  const journal=o.close(5), entries=JSON.parse(journal.journalRaw).attempts;
  assert.deepEqual(entries.slice(0,2),[first,second]);
  assert.equal(entries[2].previousEntrySha256,second.entrySha256);
  const closed=o.closeComparison(5,journal);assert.equal(closed.validation.capacityAccepted,true);assert.equal(closed.validation.attempts,5);
  assert.deepEqual(closed.validation.attemptResults.slice(0,2).map(e=>e.runPassed),[false,false]);
});

test('completed numerical failure stays recorded and cannot initiate the comparison',t=>{
  const o=owner(t);for(let n=1;n<=3;n++)o.complete(n,o.register(n),b=>{if(n===2)b.metrics.phases[0].traffic.heartbeats.failed=1;});
  const j=o.close(3);assert.throws(()=>o.closeComparison(3,j),/three consecutive/);
  assert.equal(JSON.parse(j.journalRaw).attempts[1].status,'completed');assert.equal(readdirSync(o.directory).includes('comparison.json'),false);
});

test('a failed cleanup is retained and prevents retry or closure',t=>{
  const o=owner(t), entry=o.fail(1,o.register(1),'run-failed',false);
  assert.equal(entry.ownershipReleased,false);assert.match(readFileSync(join(o.directory,'001.completion.json'),'utf8'),/SYNTHETIC_FIXTURE_FAILURE/);
  assert.throws(()=>o.register(2),/ownership/);assert.throws(()=>o.close(1),/owners/);
});

test('unfinished registration blocks another fixture and closed journal',t=>{
  const o=owner(t);o.register(1);assert.throws(()=>o.register(2),/unfinished/);assert.throws(()=>o.close(1));
});

test('registration refuses existing output, source drift, reused run, reused nonce and overlapping cleanup time',t=>{
  const o=owner(t);o.setTime(0);mkdirSync(o.options(1).outputDirectory);
  assert.throws(()=>registerAttempt(o.directory,o.options(1)),/fresh/);
  assert.throws(()=>registerAttempt(o.directory,{...o.options(2),source:'b'.repeat(40)}));
  const r=registerAttempt(o.directory,o.options(2));o.fail(1,r);
  for(const change of [{run:r.plan.run},{nonce:r.plan.nonce}])assert.throws(()=>registerAttempt(o.directory,{...o.options(3),...change}));
  o.setTime(85);assert.throws(()=>registerAttempt(o.directory,o.options(3)),/follow owner cleanup/);
});

test('finish requires the exact registration and actual sealed receipt plan and cleanup',t=>{
  const o=owner(t),r=o.register(1);o.setTime(90);
  const args={...o.trusted,registrationSha256:r.registrationSha256,status:'completed',cleanupRaw:JSON.stringify({run:r.plan.run,cleanupPassed:true,finishedAt:timestamp(85)}),receiptManifestSha256:sha('a')};
  assert.throws(()=>finishAttempt(o.directory,{...args,registrationSha256:sha('b')}));
  assert.throws(()=>finishAttempt(o.directory,args)); // No fabricated manifest or output can complete a run.
  assert.equal(readdirSync(o.directory).includes('001.completion.json'),false);
  o.fail(1,r);assert.throws(()=>finishAttempt(o.directory,{...args,status:'aborted',failureCode:'FAIL'}),/No unfinished/);
});

test('registration cannot be retroactively created inside campaign or a used output directory',t=>{
  const o=owner(t);o.setTime(0);
  assert.throws(()=>registerAttempt(o.directory,{...o.options(1),outputDirectory:join(o.directory,'run')}),/disjoint/);
  assert.throws(()=>registerAttempt(o.directory,{...o.options(1),outputDirectory:o.base}));
});

test('immutable declarations, completion entries and final journal cannot be overwritten',t=>{
  const o=owner(t);assert.throws(()=>createCampaign(o.directory,o.declaration));
  o.fail(1,o.register(1));o.close(1);
  assert.throws(()=>o.register(2),/closed/);assert.throws(()=>o.close(1),/closed/);
});

test('existing owner lock is never stolen or removed by a competing call',t=>{
  const o=owner(t),path=join(o.directory,'mutation.lock');writeFileSync(path,'retained crashed owner',{flag:'wx'});
  assert.throws(()=>o.register(1),/EEXIST/);assert.equal(readFileSync(path,'utf8'),'retained crashed owner');
});

test('corrupted registration fails closed',t=>{
  const o=owner(t);o.fail(1,o.register(1));o.fail(2,o.register(2));
  const path=join(o.directory,'001.registration.json'),r=JSON.parse(readFileSync(path));r.nonce=sha('e');writeFileSync(path,JSON.stringify(r));
  assert.throws(()=>o.register(3));
});

test('a missing middle completion cannot erase an earlier failed attempt',t=>{
  const o=owner(t);o.fail(1,o.register(1));o.fail(2,o.register(2));
  rmSync(join(o.directory,'001.completion.json'));
  assert.throws(()=>o.register(3),/Unfinished attempt before a later registration/);
});

test('clock regression cannot close a journal before its completed entry',t=>{
  const o=owner(t);o.fail(1,o.register(1));o.setTime(89);
  assert.throws(()=>closeJournal(o.directory,o.trusted));assert.equal(readdirSync(o.directory).includes('journal.json'),false);
});

test('registration rejects a substituted declaration despite a matching caller source',t=>{
  const o=owner(t),path=join(o.directory,'campaign.json'),c=JSON.parse(readFileSync(path));c.campaign.identity.schemaSha256=sha('a');writeFileSync(path,JSON.stringify(c));
  assert.throws(()=>o.register(1));
});

test('immutable closure binds failed original comparison without converting it to a pass',t=>{
  const o=owner(t);for(let n=1;n<=3;n++)o.complete(n,o.register(n));const j=o.close(3);
  const result=o.closeComparison(3,j,c=>{c.metrics.phases[0].traffic.heartbeats.failed=1;});
  assert.equal(result.validation.capacityAccepted,false);assert.equal(result.validation.comparisonPassed,false);
  assert.equal(JSON.parse(readFileSync(join(o.directory,'comparison.json'))).metrics.phases[0].traffic.heartbeats.failed,1);
  assert.throws(()=>o.closeComparison(3,j));
});

for(const [name,mutate] of Object.entries({
  'old classroom-off comparison profile':c=>c.profile='cold-open-loop-ai',
  'wrong comparison source':c=>c.source='b'.repeat(40),
  'substituted comparison schema':c=>c.schemaSha256=sha('f'),
}))test(`closure never accepts ${name}`,t=>{
  const o=owner(t);for(let n=1;n<=3;n++)o.complete(n,o.register(n));
  const result=o.closeComparison(3,o.close(3),mutate);assert.equal(result.validation.capacityAccepted,false);
});

test('comparison before final journal closure or with wrong journal hash is refused',t=>{
  const o=owner(t);for(let n=1;n<=3;n++)o.complete(n,o.register(n));const j=o.close(3);
  assert.throws(()=>o.closeComparison(3,{...j,trustedJournalSha256:sha('f')}));
  assert.throws(()=>o.closeComparison(3,j,c=>{c.metrics.startedAt=timestamp(2999);}));
  assert.equal(readdirSync(o.directory).includes('closure.json'),false);
});

test('completed raw receipt substitution after registration cannot survive journal close',t=>{
  const o=owner(t),r=o.register(1);o.complete(1,r);
  writeFileSync(join(o.options(1).outputDirectory,RUN_RECORDS.metrics),'{}');
  assert.throws(()=>o.close(1));assert.equal(readdirSync(o.directory).includes('journal.json'),false);
});

test('future predicted comparison hash and diagnostic declaration are rejected',t=>{
  const o=owner(t);for(const mutate of [c=>c.originalComparison.receiptSha256=sha('a'),c=>c.mode='diagnostic',c=>c.originalComparison.profile='cold-open-loop-ai']){
    const c=structuredClone(o.declaration);mutate(c);assert.throws(()=>createCampaign(join(o.base,'invalid'),c));
  }
});

function attemptOptions(o,n=1){return{...o.trusted,mode:'capacity-candidate',phase:'combined',campaignDirectory:o.directory,source,run:o.options(n).run,evidenceDirectory:o.options(n).outputDirectory};}
function pending(o,options){return loadRegisteredAttempt(o.directory,{...o.trusted,registrationSha256:options.registrationSha256,source,run:options.run,outputDirectory:options.evidenceDirectory});}

test('candidate owner consumes only the exact current pending registration',t=>{
 const o=owner(t),r=o.register(1),args={...o.trusted,registrationSha256:r.registrationSha256,source,run:r.plan.run,outputDirectory:o.options(1).outputDirectory};
 assert.deepEqual(loadRegisteredAttempt(o.directory,args),r);
 for(const change of[{registrationSha256:sha('f')},{source:'b'.repeat(40)},{run:'f'.repeat(12)},{outputDirectory:o.options(2).outputDirectory}])assert.throws(()=>loadRegisteredAttempt(o.directory,{...args,...change}));
 o.fail(1,r);assert.throws(()=>loadRegisteredAttempt(o.directory,args),/No pending/);
});

test('one-attempt CLI owner registers before work and credits only actual sealed receipts',async t=>{
 const o=owner(t);o.setTime(0);let calls=0;
 const result=await runCampaignAttempt(attemptOptions(o),{runOwner:async options=>{
  calls++;assert.equal(readdirSync(o.base).includes('run-1'),false);
  const r=pending(o,options);assert.equal(r.plan.mode,'capacity-candidate');assert.equal(r.plan.ordinal,1);
  o.seal(1,r);return{run:r.plan.run,exitCode:0};
 }});
 assert.equal(calls,1);assert.equal(result.entry.status,'completed');assert.equal(result.attemptPassed,true);assert.equal(result.capacityAccepted,false);
 assert.equal(readdirSync(o.directory).filter(name=>name.endsWith('registration.json')).length,1);
});

for(const scenario of['missing-cleanup','malformed-cleanup','wrong-run-cleanup'])test('attempt setup failure retains unconfirmed ownership: '+scenario,async t=>{
 const o=owner(t);o.setTime(0);
 const result=await runCampaignAttempt(attemptOptions(o),{runOwner:async options=>{
  pending(o,options);if(scenario!=='missing-cleanup'){mkdirSync(options.evidenceDirectory);writeFileSync(join(options.evidenceDirectory,RUN_RECORDS.cleanup),scenario==='malformed-cleanup'?'{':JSON.stringify({run:'f'.repeat(12),finishedAt:timestamp(2),cleanupPassed:true}));}
  o.setTime(3);throw Error('synthetic setup error');
 }});
 assert.equal(result.entry.status,'setup-failed');assert.equal(result.entry.ownershipReleased,false);assert.equal(result.exitCode,1);assert.equal(result.attemptPassed,false);
 assert.throws(()=>o.register(2),/ownership/);assert.throws(()=>o.close(1),/owners/);
});

for(const scenario of['run-failed','aborted','throw-after-seal','exit-mismatch'])test('attempt owner errors remain failure entries: '+scenario,async t=>{
 const o=owner(t);o.setTime(0);
 const result=await runCampaignAttempt(attemptOptions(o),{runOwner:async options=>{
  const r=pending(o,options);
  if(scenario==='throw-after-seal'||scenario==='exit-mismatch')o.seal(1,r);
  else{mkdirSync(options.evidenceDirectory);writeFileSync(join(options.evidenceDirectory,RUN_RECORDS.gate),'{}');writeFileSync(join(options.evidenceDirectory,RUN_RECORDS.cleanup),JSON.stringify({run:r.plan.run,finishedAt:timestamp(85),cleanupPassed:true}));o.setTime(90);}
  if(scenario==='exit-mismatch')return{run:r.plan.run,exitCode:1};
  const error=Error('synthetic owner error');if(scenario==='aborted')error.name='AbortError';throw error;
 }});
 assert.equal(result.entry.status,scenario==='aborted'?'aborted':'run-failed');assert.equal(result.entry.ownershipReleased,true);assert.equal(result.exitCode,1);assert.equal(result.attemptPassed,false);
 assert.ok(result.entry.failureCode);o.register(2); // Exact released owner permits a new, separately registered attempt.
});

test('completed workload failure stays numerical failure without an automatic retry',async t=>{
 const o=owner(t);o.setTime(0);
 const result=await runCampaignAttempt(attemptOptions(o),{runOwner:async options=>{const r=pending(o,options);o.seal(1,r,b=>{b.metrics.phases[0].traffic.heartbeats.failed=1;b.execution.exitCode=1;});return{run:r.plan.run,exitCode:1};}});
 assert.equal(result.entry.status,'completed');assert.equal(result.exitCode,1);assert.equal(result.attemptPassed,false);assert.equal(result.capacityAccepted,false);
 assert.equal(readdirSync(o.directory).filter(name=>name.endsWith('registration.json')).length,1);
});

test('campaign command refuses unsupported commands without side effects',async()=>{await assert.rejects(()=>campaignCommand('release-gate',{}),/UNKNOWN_CAMPAIGN_COMMAND/);});
