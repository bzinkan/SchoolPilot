import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHash, hash } from './receipt-loader.mjs';
import { validateCandidateRun, validateCandidateCampaign, CAMPAIGN_CONTRACT_SHA256 } from './campaign-validation.mjs';
import { PROFILE, ROLE_LIMITS, POOL_LIMITS, LIFECYCLE_EVENTS } from './profile.mjs';
import { OPEN_LOOP_HEARTBEATS } from '../open-loop-heartbeats.mjs';
import { COLD_OPEN_LOOP_PROFILE } from '../cold-open-loop-profile.mjs';
import { RELEASE_ENABLED_PROFILE } from '../release-enabled-profile.mjs';
import { RELEASE_DRAIN_OPERATIONS, releaseDrainGauges } from '../release-enabled-drain.mjs';

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
  const migrations=Array.from({length:54},(_,i)=>({id:`migration-${i}`,checksum:sha('7'),status:'complete'}));
  const files={'profile.mjs':sha('1'),'campaign-validation.mjs':sha('2'),'runtime-facts.mjs':sha('3')};
  const executed=Object.fromEntries(roles.map((r,i)=>[r,sha(String(i+4))]));
  const scan={passed:true,sourceSha:source,imageId:digest('1'),configDigest:digest('3'),os:'linux',architecture:'amd64',counts:{HIGH:0,CRITICAL:0}},scanRaw=JSON.stringify(scan);
  const binding={applicationSource:source,passed:true,cleanupPassed:true,applicationChanges:0,allowedModes:['diagnostic','capacity-candidate'],candidateImageId:digest('1'),candidateConfigDigest:digest('3'),
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
      databaseValidation:{source,seedSource:source,snapshotManifestSha256:sha('d'),passed:true,clientsClosed:true,measurementStarted:false,admittedTables:129,migrations:54,migrationsSha256:identity.migrationSha256,
        screenshotEvidence:{signature:'public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)',runtimeExecute:true,publicExecute:false,exactDefinition:true},
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
  return modernEvidence(bindPlan(bundle));
}
function bindPlan(bundle){bundle.planRaw=JSON.stringify(bundle.plan);const trustedPlanSha256=hash(bundle.planRaw);bundle.preparation.planSha256=trustedPlanSha256;return {bundle,trustedPlanSha256};}
function validate(f){return validateCandidateRun(f.bundle,f.trustedPlanSha256);}
function modernEvidence(f) {
  const phase=f.bundle.metrics.phases[0];
  phase.traffic.heartbeatCapabilityProof={requiredCapabilities:['preciseRestrictionResourcesV1','focusTabV1','privateChatLifecycleV1','lateSignInRestrictionSsoV1','restrictionAuthPassThroughV1','screenshotTrackingWindowLeaseV1'],validatedResponses:6000};
  phase.persistedBefore=[0,1].map(index=>({school_id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,count:6}));
  phase.persistedAfter=phase.persistedBefore.map(row=>({...row,count:3006}));
  for(const row of f.bundle.metrics.correctness.currentDayWorkers)Object.assign(row,{schoolId:phase.persistedAfter[row.schoolIndex].school_id,rawObservationCount:3006,persistedObservationCount:3006,heartbeatCount:3006});
  return f;
}
test('modern contract accepts the actual single API preflight receipt',()=>{
  const f=modernEvidence(fixture());f.bundle.metrics.preflightDrain=drain();assert.equal(validate(f).runPassed,true);
});
test('modern contract rejects even one otherwise historically allowed204',()=>{
  const f=modernEvidence(fixture());const phase=f.bundle.metrics.phases[0];phase.traffic.heartbeatStatuses={200:5999,204:1};phase.insertedObservations=5999;
  assert.equal(validate(f).runPassed,false);
});
test('modern contract rejects an independently observed missing raw heartbeat despite successful totals',()=>{
  const f=modernEvidence(fixture());f.bundle.metrics.correctness.currentDayWorkers[0].rawObservationCount=3005;assert.equal(validate(f).runPassed,false);
});
test('modern contract rejects missing response negotiation evidence despite initialization success',()=>{
  const f=modernEvidence(fixture());delete f.bundle.metrics.phases[0].traffic.heartbeatCapabilityProof;assert.equal(validate(f).runPassed,false);
});
test('fresh authority validation may follow release but must precede cold restart',()=>{const f=fixture();f.bundle.cold.validatedAt=new Date(Date.parse(f.bundle.gate.releasedAt)+500).toISOString();assert.equal(validate(f).runPassed,true);f.bundle.cold.validatedAt=new Date(Date.parse(f.bundle.cold.restartedAt)+1).toISOString();assert.ok(validate(f).failures.includes('preparation'));});
test('original comparison fingerprint stays distinct from equal native re-rendered schemas',()=>{const f=fixture();assert.notEqual(f.bundle.preparation.restore.schemaComparison.originalCanonicalSha256,f.bundle.preparation.restore.schemaComparison.restoredCanonicalSha256);assert.equal(validate(f).runPassed,true);for(const field of ['originalCanonicalSha256','restoredCanonicalSha256','restoredNormalizedSha256']){const copy=structuredClone(f);copy.bundle.preparation.restore.schemaComparison[field]=sha('f');assert.ok(validate(copy).failures.includes('preparation'));}});
test('Redis creation in the pre-restart namespace cannot qualify as restored preparation',()=>{const f=fixture();f.bundle.preparation.redis.createdAt=f.bundle.gate.releasedAt;assert.ok(validate(f).failures.includes('preparation'));});

test('complete bound synthetic receipts pass a run without claiming capacity',()=>assert.deepEqual(validate(fixture()),{runPassed:true,failures:[],capacityAccepted:false}));
const mutations={
  'old 53-migration restore':b=>{b.preparation.restore.databaseValidation.migrations=53;},
  'missing function runtime assertion':b=>{delete b.preparation.restore.databaseValidation.screenshotEvidence;},
  'PUBLIC function execution':b=>{b.preparation.restore.databaseValidation.screenshotEvidence.publicExecute=true;},
  'different function signature':b=>{b.preparation.restore.databaseValidation.screenshotEvidence.signature='public.other(text)';},
  'diagnostic relabel still has a diagnostic gate':b=>b.gate.diagnosticOnly=true,
  'diagnostic helper never allowed candidate':b=>{b.runtime.binding.allowedModes=['diagnostic'];b.runtime.bindingRaw=JSON.stringify(b.runtime.binding);b.plan.identity.helper.bindingSha256=hash(b.runtime.bindingRaw);b.gate.bindingSha256=b.plan.identity.helper.bindingSha256;},
  'wrong final source':b=>b.final.source='b'.repeat(40),
  'changed harness bytes':b=>b.runtime.binding.roleHarnessSha256['profile.mjs']=sha('f'),
  'high finding':b=>b.candidate.scan.counts.HIGH=1,
  'missing report despite configured64':b=>b.metrics.phases[0].traffic.reports.pop(),
  'duplicate report scope':b=>b.metrics.phases[0].traffic.reports[0].scope='grade',
  'wave moved despite same scope/range aggregate':b=>b.metrics.phases[0].traffic.reports[0].wave=1,
  'wrong wave day':b=>b.metrics.phases[0].traffic.reports[0].days=7,
  'report deadline boundary':b=>b.metrics.phases[0].traffic.reports[0].durationMs=20000,
  'report status error with success flag':b=>b.metrics.phases[0].traffic.reports[0].status=503,
  'report error alongside status200':b=>b.metrics.phases[0].traffic.reports[0].error={},
  'CSV substituted school':b=>b.metrics.correctness.exports[0].schoolIndex=1,
  'audit count missing':b=>delete b.metrics.correctness.csvAuditCount,
  'refused offering':b=>b.metrics.phases[0].traffic.heartbeats.refusedAtInFlightLimit=1,
  'late offering':b=>b.metrics.phases[0].traffic.heartbeats.lateOffers=1,
  'late maximum hidden by zero count':b=>b.metrics.phases[0].traffic.heartbeats.maxOfferLatenessMs=101,
  'offered5999':b=>b.metrics.phases[0].traffic.heartbeats.offered=5999,
  'shortened offering':b=>b.metrics.phases[0].traffic.heartbeats.configured.durationMs=10000,
  'school accounting mismatch':b=>b.metrics.phases[0].traffic.heartbeats.bySchool[0].succeeded=2999,
  'completion sample missing':b=>b.metrics.phases[0].traffic.heartbeats.timings.count=5999,
  'request deadline boundary':b=>b.metrics.phases[0].traffic.heartbeats.timings.maxMs=20000,
  '204 broadening':b=>b.metrics.phases[0].traffic.heartbeatStatuses={200:5989,204:11},
  'persisted observation mismatch':b=>b.metrics.phases[0].insertedObservations--,
  'capability count includes only initialization':b=>b.metrics.phases[0].traffic.heartbeatCapabilityProof.validatedResponses=10,
  'capability count includes initialization and traffic':b=>b.metrics.phases[0].traffic.heartbeatCapabilityProof.validatedResponses=6010,
  'modern capability missing':b=>b.metrics.phases[0].traffic.heartbeatCapabilityProof.requiredCapabilities.pop(),
  'capability duplicated to preserve count':b=>b.metrics.phases[0].traffic.heartbeatCapabilityProof.requiredCapabilities[5]='focusTabV1',
  'only legacy capabilities verified':b=>b.metrics.phases[0].traffic.heartbeatCapabilityProof.requiredCapabilities.length=3,
  'missing before counts':b=>delete b.metrics.phases[0].persistedBefore,
  'missing after counts':b=>delete b.metrics.phases[0].persistedAfter,
  'duplicated school before counts':b=>b.metrics.phases[0].persistedBefore[1].school_id=b.metrics.phases[0].persistedBefore[0].school_id,
  'foreign school after counts':b=>b.metrics.phases[0].persistedAfter[0].school_id='ffffffff-ffff-4fff-8fff-ffffffffffff',
  'extra school hidden in persisted counts':b=>b.metrics.phases[0].persistedAfter.push({school_id:'ffffffff-ffff-4fff-8fff-ffffffffffff',count:0}),
  'priming count reduced with unchanged measured delta':b=>{b.metrics.phases[0].persistedBefore[0].count=5;b.metrics.phases[0].persistedAfter[0].count=3005;},
  'school loss offset by another school gain':b=>{for(const [index,delta] of [[0,-1],[1,1]]){b.metrics.phases[0].persistedAfter[index].count+=delta;for(const key of ['rawObservationCount','persistedObservationCount','heartbeatCount'])b.metrics.correctness.currentDayWorkers[index][key]+=delta;}},
  'missing independent raw count':b=>delete b.metrics.correctness.currentDayWorkers[0].rawObservationCount,
  'missing independent persisted count':b=>delete b.metrics.correctness.currentDayWorkers[0].persistedObservationCount,
  'raw count supplied as string':b=>b.metrics.correctness.currentDayWorkers[0].rawObservationCount='3006',
  'independent persisted count disagrees':b=>b.metrics.correctness.currentDayWorkers[0].persistedObservationCount--,
  'rollup loses observations but still reports correct seconds':b=>b.metrics.correctness.currentDayWorkers[0].heartbeatCount--,
  'currentday proof missing school identity':b=>delete b.metrics.correctness.currentDayWorkers[0].schoolId,
  'currentday proof repeats another school':b=>b.metrics.correctness.currentDayWorkers[1].schoolId=b.metrics.correctness.currentDayWorkers[0].schoolId,
  'duplicate worker school':b=>b.metrics.phases[0].workers[1].schoolIndex=0,
  'queue-inclusive worker over48s':b=>b.metrics.phases[0].workers[1].durationMs=48000.001,
  'negative worker duration':b=>b.metrics.phases[0].workers[0].durationMs=-1,
  'wrong worker grain':b=>b.metrics.phases[0].workers[0].rowCount--,
  'duplicate currentday school':b=>b.metrics.correctness.currentDayWorkers[1].schoolIndex=0,
  'currentday invalid classification':b=>b.metrics.correctness.currentDayWorkers[0].fixtureViolations.unexpectedClassificationObservations=1,
  'stale lifecycle event':b=>b.metrics.phases[0].traffic.lifecycle.events.pop(),
  'claimed browser enforcement':b=>b.metrics.phases[0].traffic.lifecycle.browserEnforcementClaimed=true,
  'checkout failure':b=>b.metrics.phases[0].api.database.acquisitions.failures=1,
  'SQL failure':b=>b.metrics.phases[0].api.database.statements.select.failures=1,
  'optional inbox failure':b=>b.metrics.phases[0].api.operations.operations.heartbeat_final_delivery.counters.heartbeatOptionalInboxFailures=1,
  'missing optional counter':b=>delete b.metrics.phases[0].api.operations.operations.heartbeat_background.counters.heartbeatOptionalTelemetryFailures,
  'late handler failure':b=>b.metrics.phases[0].api.operations.operations.heartbeat_handler.counters.heartbeatHandlerFailures=1,
  'unsettled ownership':b=>b.metrics.phases[0].api.operations.operations.heartbeat_handler.activeOperations=1,
  'drain physicallyzero but aborted':b=>b.metrics.phases[0].api.http.abortedResponses=1,
  'missing drain operation':b=>delete b.metrics.phases[0].api.operations.operations.user_identity,
  'larger pool':b=>b.metrics.poolReadiness[0].max=17,
  'privileged session pool':b=>b.metrics.poolReadiness[1].databaseBypassRls=true,
  'larger acquisition deadline':b=>b.metrics.poolReadiness[0].checkoutDeadlineMs=6000,
  'prewarm altered':b=>b.metrics.prewarmed=15,
  'snapshot earlier source':b=>b.preparation.restore.source='b'.repeat(40),
  'snapshot notanalyzed':b=>b.preparation.restore.analyze=false,
  'restore client stillowned':b=>b.preparation.restore.clientsClosed=false,
  'expired fixture authority':b=>b.preparation.restore.validityHorizon=timestamp(79),
  'native schema mismatch':b=>b.preparation.restore.schemaComparison.restoredNormalizedSha256=sha('f'),
  'migration status drift':b=>b.database.migrations[0].status='pending',
  'missing RLS FORCE':b=>b.database.admission.forced=false,
  'invalid live tuples':b=>b.preparation.restore.databaseValidation.schools[0].exactLiveBindings=499,
  'cold restart differentcontainer':b=>b.cold.pgContainerId=sha('f'),
  'restart notfresh':b=>b.cold.after.StartedAt=b.cold.before.StartedAt,
  'cold restart before gate':b=>b.cold.restartedAt=timestamp(4),
  'measurement before cold restart':b=>b.metrics.startedAt=timestamp(6),
  'coordinator null exit':b=>b.roles.roles.find(r=>r.role==='coordinator').exit=null,
  'coordinator nonzero':b=>b.roles.roles.find(r=>r.role==='coordinator').exit.exitCode=1,
  'forced API exit':b=>b.roles.roles.find(r=>r.role==='api').exit.forced=true,
  'unclosed logs':b=>b.roles.roles[0].exit.logsClosed=false,
  'actual inspection absent':b=>delete b.roles.roles[0].inspection,
  'wrong actualcap':b=>b.roles.roles[0].inspection.caps.nanoCpus=2000000000,
  'OOM':b=>b.metrics.roleResources.api.after.memory.events.oom_kill=1,
  'missing cgroup timing':b=>delete b.metrics.roleResources.api.before.cpu.usage_usec,
  'profile flag present':b=>b.runtimeFlags.api[0].execArgv.push('--cpu-prof'),
  'heap override present':b=>b.runtimeFlags.api[0].oldSpaceOverrideMiB=512,
  'startup-only runtime proof':b=>b.runtimeFlags.api=b.runtimeFlags.api.slice(0,1),
  'diagnostic runtime record':b=>b.runtimeFlags.worker[0].diagnosticOnly=true,
  'unknown cleanup absence':b=>delete b.cleanup.fixtures.resources[0].confirmedAbsent,
  'wrong removedID':b=>b.cleanup.roles.roles[0].id=sha('f'),
  'missing role cleanup':b=>b.cleanup.roles.roles.pop(),
  'process receipt from another container':b=>b.metrics.processes.api=sha('f')+':123',
  'preflight uncertainty erased by reset':b=>b.metrics.preflightDrain.abortedResponses=1,
  'missing single API preflight':b=>delete b.metrics.preflightDrain,
  'fabricated nested preflight shape':b=>b.metrics.preflightDrain={api:drain(),worker:drain()},
  'incomplete API preflight':b=>b.metrics.preflightDrain.complete=false,
  'owned work remains at API preflight':b=>b.metrics.preflightDrain.physicallyIdle=false,
  'preflight error alongside complete':b=>b.metrics.preflightDrain.error={code:'DRAIN_FAILED'},
};
for(const [name,mutate] of Object.entries(mutations))test(`candidate rejects ${name}`,()=>{
  const f=fixture();mutate(f.bundle);const bound=bindPlan(f.bundle);const result=validate(bound);assert.equal(result.runPassed,false);assert.ok(result.failures.length>0);
});

function comparison(identity){
  const scriptHashes=Object.fromEntries(['run-release-enabled-scale.ps1','release-enabled-scale.mjs','release-enabled-generator.mjs','release-enabled-process.mjs','release-enabled-profile.mjs'].map((key,n)=>[key,sha(String(n+1))]));
  const metrics=fixture().bundle.metrics;metrics.profile=structuredClone(RELEASE_ENABLED_PROFILE);metrics.processes={api:100,worker:101,generator:102};metrics.capacityAccepted=true;metrics.sourceHashes=scriptHashes;
  delete metrics.phases[0].traffic.heartbeatCapabilityProof;
  for(const row of metrics.correctness.currentDayWorkers)for(const key of ['schoolId','rawObservationCount','persistedObservationCount'])delete row[key];
  metrics.startedAt=timestamp(100);metrics.finishedAt=timestamp(172);
  delete metrics.execution;delete metrics.poolReadiness;delete metrics.roleOwnershipClean;delete metrics.roleResourceEvidenceComplete;delete metrics.roleResources;
  const execution={sourceRevision:source,workloadProfile:RELEASE_ENABLED_PROFILE.name,phase:'combined',diagnosticOnly:false,collectApiCpuProfile:false,nodeOldSpaceMiB:512,exitCode:0,productionMutations:0,
    coldPostgresRestart:true,hostFilesystemCachesFlushed:false,restrictedNonOwnerRole:true,admittedTables:129,registrySha256:identity.registrySha256,postgresCpu:4,postgresMemoryBytes:4294967296};
  const receipt={source,schemaSha256:identity.schemaSha256,profile:RELEASE_ENABLED_PROFILE.name,scriptHashes,metrics,execution,exitCode:0,cleanupPassed:true,
    schemaFingerprint:{canonicalSha256:identity.schemaSha256},cleanup:{resources:[{role:'postgres',id:sha('c'),confirmedAbsent:true,cleanupPassed:true},{role:'redis',id:sha('d'),confirmedAbsent:true,cleanupPassed:true}]}};
  const raw=JSON.stringify(receipt);return {raw,receipt,expected:{source,schemaSha256:identity.schemaSha256,profile:RELEASE_ENABLED_PROFILE.name,phase:'combined',diagnosticOnly:false,collectApiCpuProfile:false,nodeOldSpaceMiB:512,scriptHashes}};
}
function campaign(statuses=['completed','completed','completed'], mutate=()=>{}, mutateComparison=()=>{}){
  const seed=fixture(),original=comparison(seed.bundle.plan.identity);
  original.receipt.metrics.startedAt=timestamp(statuses.length*1000+100);original.receipt.metrics.finishedAt=timestamp(statuses.length*1000+172);
  mutateComparison(original.receipt);original.raw=JSON.stringify(original.receipt);
  const campaign={mode:'capacity-candidate',source,profile:PROFILE,phase:'combined',diagnosticOnly:false,identity:seed.bundle.plan.identity,originalComparison:original.expected};
  const trustedCampaignSha256=canonicalHash(campaign),attempts=[],loaded=new Map();let previous=trustedCampaignSha256;
  for(let n=0;n<statuses.length;n++){
    const f=fixture(n+1);Object.assign(f.bundle.plan,{campaignSha256:trustedCampaignSha256,previousEntrySha256:previous,ordinal:n+1});
    const shift=value=>{if(Array.isArray(value))return value.map(shift);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,shift(item)]));return typeof value==='string'&&/^2026-10-03T/.test(value)?new Date(Date.parse(value)+n*1000000).toISOString():value;};
    f.bundle=shift(f.bundle);
    mutate(f.bundle,n);const final=bindPlan(f.bundle);
    final.receiptManifestSha256=hash(`receipt-${n}`);final.cleanupRaw=JSON.stringify(final.bundle.cleanup);
    const entry={ordinal:n+1,run:f.bundle.plan.run,nonce:f.bundle.plan.nonce,registeredAt:timestamp(n*1000),previousEntrySha256:previous,status:statuses[n],receiptManifestSha256:final.receiptManifestSha256,planSha256:final.trustedPlanSha256,
      ownershipReleased:true,cleanupFinishedAt:final.bundle.cleanup.finishedAt,cleanupSha256:hash(final.cleanupRaw),finishedAt:timestamp(n*1000+90),...(statuses[n]==='completed'?{}:{failureCode:'SYNTHETIC_FAILURE'})};
    entry.entrySha256=canonicalHash(entry);previous=entry.entrySha256;attempts.push(entry);loaded.set(entry.run,final);
  }
  const journalRaw=JSON.stringify({schemaVersion:2,campaign,attempts,closedAt:timestamp(statuses.length*1000+90)});
  const closureRaw=JSON.stringify({schemaVersion:1,campaignSha256:trustedCampaignSha256,journalSha256:hash(journalRaw),comparisonDeclarationSha256:canonicalHash(campaign.originalComparison),comparisonReceiptSha256:hash(original.raw),closedAt:timestamp(statuses.length*1000+180)});
  return {journalRaw,trustedJournalSha256:hash(journalRaw),trustedCampaignSha256,loadRun:entry=>loaded.get(entry.run),comparison:original,loaded,closureRaw,trustedClosureSha256:hash(closureRaw)};
}
test('three consecutive complete passes plus separately bound original comparison qualify only bounded capacity',()=>{
  const result=validateCandidateCampaign(campaign());assert.equal(result.capacityAccepted,true);assert.equal(result.productionReadiness,false);assert.equal(result.attemptResults.length,3);
});
test('original Windows comparison retains its historical first-offer allowance without modern overlay receipts',()=>{
  const result=validateCandidateCampaign(campaign(undefined,undefined,receipt=>{
    const phase=receipt.metrics.phases[0];phase.traffic.heartbeatStatuses={200:5999,204:1};phase.insertedObservations=5999;
    assert.equal(phase.traffic.heartbeatCapabilityProof,undefined);
    assert.equal(receipt.metrics.correctness.currentDayWorkers[0].rawObservationCount,undefined);
  }));
  assert.equal(result.comparisonPassed,true);assert.equal(result.capacityAccepted,true);
});
test('failure interrupts streak rather than selecting three best runs',()=>{
  const result=validateCandidateCampaign(campaign(['completed','completed','aborted','completed']));assert.equal(result.capacityAccepted,false);assert.equal(result.attemptResults[2].status,'aborted');assert.equal(result.attemptResults[2].runPassed,false);
});
for(const [name,mutate]of Object.entries({
  'missing failed cleanup':entry=>delete entry.cleanupFinishedAt,
  'unreleased failed ownership':entry=>entry.ownershipReleased=false,
  'invalid failed cleanup hash':entry=>entry.cleanupSha256='invalid',
  'failed completion before cleanup':entry=>entry.finishedAt=timestamp(1),
  'overlapping failed ownership':entry=>entry.cleanupFinishedAt=timestamp(1001),
  'missing failed reason':entry=>delete entry.failureCode,
}))test(`failed attempt cannot be hidden by later passes: ${name}`,()=>{const c=campaign(['aborted','completed','completed','completed']);const journal=JSON.parse(c.journalRaw);mutate(journal.attempts[0]);c.journalRaw=JSON.stringify(journal);c.trustedJournalSha256=hash(c.journalRaw);assert.throws(()=>validateCandidateCampaign(c));});
test('completed raw cleanup cannot be substituted by an equivalent unbound owner string',()=>{const c=campaign();const load=c.loadRun;c.loadRun=entry=>({...load(entry),cleanupRaw:load(entry).cleanupRaw+' '});assert.throws(()=>validateCandidateCampaign(c));});
test('three later consecutive passes preserve earlier failures',()=>{
  const result=validateCandidateCampaign(campaign(['setup-failed','run-failed','completed','completed','completed']));assert.equal(result.capacityAccepted,true);assert.equal(result.attemptResults.length,5);assert.deepEqual(result.attemptResults.slice(0,2).map(r=>r.runPassed),[false,false]);
});
test('completed receipt with failed numbers breaks streak',()=>{
  const result=validateCandidateCampaign(campaign(undefined,(b,n)=>{if(n===1)b.metrics.phases[0].traffic.heartbeats.failed=1;}));assert.equal(result.capacityAccepted,false);assert.deepEqual(result.attemptResults[1].failures,['metrics']);
});
test('same application but changed schema/profile identity cannot mix runs',()=>{
  const c=campaign(undefined,(b,n)=>{if(n===1)b.plan.identity.schemaSha256=sha('f');});assert.throws(()=>validateCandidateCampaign(c));
});
test('same fixture cannot be counted twice',()=>{
  const c=campaign(undefined,(b,n)=>{if(n===1)b.preparation.pgContainerId=hash('pg-1');});assert.throws(()=>validateCandidateCampaign(c));
});
test('missing original comparison does not become three-run acceptance',()=>{
  const c=campaign();delete c.comparison;const r=validateCandidateCampaign(c);assert.equal(r.capacityAccepted,false);assert.equal(r.comparisonPassed,false);
});
test('wrong comparison source or altered raw bytes stays failed',()=>{
  const c=campaign();c.comparison.receipt.source='b'.repeat(40);assert.equal(validateCandidateCampaign(c).capacityAccepted,false);
});
test('unbound journal edits and omitted attempts cannot pass the retained closure hash',()=>{
  const c=campaign();const j=JSON.parse(c.journalRaw);j.attempts.splice(1,1);c.journalRaw=JSON.stringify(j);assert.throws(()=>validateCandidateCampaign(c));
});
test('later plan cannot retroactively register a prepared fixture',()=>{
  const c=campaign(undefined,b=>b.preparation.startedAt=timestamp(0));assert.throws(()=>validateCandidateCampaign(c));
});
test('loader cannot substitute another manifest or plan for a registered attempt',()=>{
  const c=campaign();const load=c.loadRun;c.loadRun=entry=>({...load(entry),receiptManifestSha256:sha('f')});assert.throws(()=>validateCandidateCampaign(c));
});
for(const [name,mutate] of Object.entries({
  'historical classroom-off profile':r=>{r.profile=COLD_OPEN_LOOP_PROFILE.name;r.metrics.profile=structuredClone(COLD_OPEN_LOOP_PROFILE);},
  'diagnostic combined':r=>{r.execution.diagnosticOnly=true;r.metrics.diagnosticOnly=true;},
  'profiled ingest':r=>{r.execution.phase='ingest';r.execution.collectApiCpuProfile=true;r.metrics.cpuProfile.enabled=true;},
  'larger native heap':r=>r.execution.nodeOldSpaceMiB=1024,
  'missing report':r=>r.metrics.phases[0].traffic.reports.pop(),
  'failed lifecycle':r=>r.metrics.phases[0].traffic.lifecycle.passed=false,
  'missing canonical API preflight':r=>delete r.metrics.preflightDrain,
  'preflight abort erased by phase reset':r=>r.metrics.preflightDrain.abortedResponses=1,
  'unconfirmed original cleanup':r=>delete r.cleanup.resources[0].confirmedAbsent,
  'comparison other source':r=>{r.source='b'.repeat(40);r.metrics.sourceRevision=r.source;r.execution.sourceRevision=r.source;},
  'comparison before streak closes':r=>{r.metrics.startedAt=timestamp(89);},
}))test(`separate comparison rejects ${name} even when hash-bound`,()=>{
  const result=validateCandidateCampaign(campaign(undefined,undefined,mutate));assert.equal(result.capacityAccepted,false);assert.equal(result.comparisonPassed,false);
});
test('predeclared comparison contains identities only, not a future receipt hash',()=>{
  const c=campaign();const declaration=JSON.parse(c.journalRaw).campaign.originalComparison;
  assert.equal('receiptSha256' in declaration,false);assert.equal(validateCandidateCampaign(c).capacityAccepted,true);
});
for(const [name,mutate] of Object.entries({
  'another final journal':r=>r.journalSha256=sha('f'),
  'another campaign':r=>r.campaignSha256=sha('f'),
  'changed comparison declaration':r=>r.comparisonDeclarationSha256=sha('f'),
  'another comparison receipt':r=>r.comparisonReceiptSha256=sha('f'),
  'closure before comparison completion':r=>r.closedAt=timestamp(171),
}))test(`immutable closure rejects ${name}`,()=>{
  const c=campaign(),closure=JSON.parse(c.closureRaw);mutate(closure);c.closureRaw=JSON.stringify(closure);c.trustedClosureSha256=hash(c.closureRaw);
  assert.equal(validateCandidateCampaign(c).capacityAccepted,false);
});
test('missing or unbound closure cannot approve a completed streak',()=>{
  const c=campaign();delete c.closureRaw;assert.equal(validateCandidateCampaign(c).capacityAccepted,false);
  const d=campaign();d.closureRaw+=' ';assert.equal(validateCandidateCampaign(d).capacityAccepted,false);
});
test('three otherwise valid receipts cannot reuse an overlapping measured interval',()=>{
  const c=campaign(undefined,(b,n)=>{if(n===1)b.metrics.startedAt=timestamp(8);});assert.throws(()=>validateCandidateCampaign(c));
});
test('next preparation and registration must follow actual prior cleanup',()=>{
  const c=campaign(undefined,(b,n)=>{if(n===0)b.cleanup.finishedAt=timestamp(1001);});assert.throws(()=>validateCandidateCampaign(c));
});
test('missing final cleanup time cannot certify nonoverlapping ownership',()=>{
  const c=campaign(undefined,(b,n)=>{if(n===1)delete b.cleanup.finishedAt;});assert.throws(()=>validateCandidateCampaign(c));
});

for(const name of Object.keys(releaseDrainGauges(server())))test('preflight gauges reject owned '+name+' despite idle label and final zero',()=>{
 const f=fixture();f.bundle.metrics.preflightDrain.gauges[name]=1;
 assert.equal(f.bundle.metrics.preflightDrain.physicallyIdle,true);
 assert.equal(validate(f).runPassed,false);
});
for(const value of [undefined,null,{}])test('preflight gauges require the complete canonical contract '+String(value),()=>{
 const f=fixture();f.bundle.metrics.preflightDrain.gauges=value;assert.equal(validate(f).runPassed,false);
});
