import assert from 'node:assert/strict';
import {readFileSync,realpathSync,readdirSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROFILES,profileHash,hash} from './contracts.mjs';
import {checkLowerStaffRows} from './lower-staff.mjs';
import {checkPersistence} from './persistence.mjs';
import {validateAcceptanceSuccessor,assertSuccessorRunBinding,readPinnedSuccessorInput,assertSuccessorMixedSequence} from './acceptance-successor.mjs';
import {loadReceipt} from './receipts.mjs';
import {validateMixedRuns} from './validation.mjs';

export const LOWER_LEVELS=Object.freeze([PROFILES.lower133,PROFILES.lower250,PROFILES.lower340,PROFILES.lower500]);
export const LOWER_CONTRACT=Object.freeze({name:'release297-usage-off-lower-heartbeat-envelope-v1',
  levels:LOWER_LEVELS.map(profile=>({profile:profile.name,sha256:profileHash(profile)})),
  initial133ConfirmationRuns:3,selectedLevelConfirmationRuns:3,stopUpwardOnHardFailure:true,stopUpwardOnHeadroomLoss:true,
  selectionHeadroom:{maxApiMeanCpuFraction:.50,maxP95Ms:400},hardLimits:{maxApiMeanCpuFractionExclusive:.60,maxP95Ms:500},
  extensionVersion:'2.9.6',advertisedCapabilities:36,usage:false,newPilots:false,apiTasks:1,mainPool:16,sessionPool:2,
  queryRecorder:false,cpuProfiler:false,indirectAcquisitionLogProofRequired:true,activeSchoolIndex:0,foreignSchoolIndex:1,staffReadsPerRun:12,
  trackingHoursDisabled:true,trackingHoursPostureSource:'operator_report_2026-10-04_about_14:10Z',productionSchoolSettingsRead:false,
  capacityScope:'UsageOFF heartbeat envelope with scoped teacher reads only',
  deploymentPopulation:133,higherFleetClassroomOrSurvivalClaim:false,comparisonPolicyAmended:false,fullAttemptReserveMs:600000});
export const lowerContractHash=()=>hash(JSON.stringify(LOWER_CONTRACT));
export function lowerAcquisitionLogProof(logs,{source,measuredEndsAtMs,complete}){
  assert.equal(complete,true);assert.equal(typeof logs,'string');assert.ok(Number.isFinite(measuredEndsAtMs));
  assert.ok(!logs.includes('[ErrorMonitor] ALERT:'));
  const records=[];
  for(const line of logs.split(/\r?\n/)){
    let record;try{record=JSON.parse(line);}catch{if(line.includes('SchoolPilot/Monitoring'))throw Error('LOWER_MONITOR_EMF_INVALID');continue;}
    if(record.event==='api_pool_readiness_transition')assert.ok(!['probe_deferred','pool_stalled'].includes(record.state));
    assert.notEqual(record.event,'api_pool_readiness_sample_failed');
    if(!record._aws?.CloudWatchMetrics?.some(row=>row.Namespace==='SchoolPilot/Monitoring'))continue;
    assert.equal(record.Release,source);assert.equal(record.Service,'api');assert.equal(record.Environment,'test');
    assert.match(record.InstanceId,/^[a-f0-9-]{36}$/);
    assert.ok(Number.isSafeInteger(record._aws.Timestamp)&&record._aws.Timestamp>0);
    for(const key of ['DatabaseConnectivityMonitorCapturedInterval','MonitorCaptured','MonitorCapturedInterval']){assert.ok(Number.isSafeInteger(record[key])&&record[key]>=0);assert.equal(record[key],0);}
    if(record.DatabaseConnectivityMonitorCaptured!==undefined){assert.ok(Number.isSafeInteger(record.DatabaseConnectivityMonitorCaptured)&&record.DatabaseConnectivityMonitorCaptured>=0);assert.equal(record.DatabaseConnectivityMonitorCaptured,0);}
    records.push(record);
  }
  assert.ok(records.length>0,'Final source-defined monitor evidence unavailable');
  assert.equal(new Set(records.map(record=>record.InstanceId)).size,1);
  const lastEmfAtMs=Math.max(...records.map(row=>row._aws.Timestamp));assert.ok(lastEmfAtMs>=measuredEndsAtMs);
  return{passed:true,sha256:hash(logs),emfRecords:records.length,lastEmfAtMs,databaseConnectivityCapturedIntervals:0,
    recoveredAcquisitionEvidence:'source-defined final ErrorMonitor/readiness logs',rawAcquisitionCountersAvailable:false};
}
export function assertLowerSafetyPrerequisites(inputs,successor){
  assert.deepEqual(inputs.map(row=>row.kind).sort(),['classroom','mixed','recovery']);
  if(successor){
    const binding=successor.binding;
    for(const input of inputs){const proof=readPinnedSuccessorInput(input).value;
      assert.equal(proof.source??proof.servingSource,binding.candidate.source);assert.equal(proof.applicationImage??proof.servingImage,binding.candidate.image);
      if(input.kind==='classroom'){
        assert.equal(proof.syntheticAcceptancePassed,true);assert.equal(proof.profile,PROFILES.classroomNative.name);assert.equal(proof.profileSha256,profileHash(PROFILES.classroomNative));assert.equal(proof.offered,2040);assert.equal(proof.succeeded,2040);
        assert.ok(Object.keys(proof.allRoundChecks).length>=14);assert.ok(Object.values(proof.allRoundChecks).every(value=>value===true));
        assert.equal(proof.runs.length,1);const row=proof.runs[0],record=loadReceipt(row.receiptDirectory,row.receiptManifestSha256,row.privateDirectory);
        assert.equal(record.profile,PROFILES.classroomNative.name);assert.equal(record.runPassed,true);assert.equal(record.source,binding.candidate.source);assert.equal(record.applicationImage,binding.candidate.image);assert.equal(record.acceptanceSuccessor.sha256,successor.input.sha256);
        assert.equal(record.rounds.length,1);assert.equal(record.rounds[0].traffic.heartbeats.expected,2040);assert.equal(record.rounds[0].traffic.heartbeats.succeeded,2040);
        assert.deepEqual(proof.allRoundChecks,record.rounds[0].acceptance.checks);assert.ok(Object.keys(proof.allRoundChecks).length>=14);assert.ok(Object.values(proof.allRoundChecks).every(value=>value===true));
      }
      if(input.kind==='mixed'){
        assert.equal(proof.passed,true);assert.equal(proof.currentSchoolOnly,true);assert.equal(proof.profile,PROFILES.mixedNative.name);assert.equal(proof.profileSha256,profileHash(PROFILES.mixedNative));assert.equal(proof.runs.length,3);
        const records=proof.runs.map(row=>loadReceipt(row.receiptDirectory,row.receiptManifestSha256,row.privateDirectory));
        assertSuccessorMixedSequence(records,binding,proof.completedAt);
        for(const record of records){assert.equal(record.source,binding.candidate.source);assert.equal(record.applicationImage,binding.candidate.image);assert.equal(record.acceptanceSuccessor.sha256,successor.input.sha256);}
        const contract=readPinnedSuccessorInput(proof.campaignContract).value,journal=readPinnedSuccessorInput(proof.campaignJournal).value;
        assert.equal(proof.campaignContract.sha256,records[0].campaignContractSha256);assert.equal(journal.contractSha256,proof.campaignContract.sha256);
        assert.equal(contract.kind,'mixed');assert.equal(contract.profile,PROFILES.mixedNative.name);assert.equal(contract.candidateSource,binding.candidate.source);assert.deepEqual(contract.order,['C','C','C']);
        assert.equal(journal.closed,true);assert.equal(journal.attempts.length,3);
        for(const [index,attempt]of journal.attempts.entries()){assert.equal(attempt.index,index);assert.equal(attempt.state,'recorded');assert.equal(attempt.run,records[index].run);assert.equal(attempt.receiptManifestSha256,records[index].verifiedReceiptManifestSha256);assert.equal(attempt.reservationSha256,records[index].reservationSha256);assert.equal(attempt.receipt.runPassed,true);assert.equal(attempt.receipt.failure,null);}
        assert.deepEqual(proof.aggregate,validateMixedRuns(records));assert.equal(proof.aggregate.passed,true);
        const review=readPinnedSuccessorInput(proof.independentFullReview).value;assert.equal(review.fullIndependentReviewComplete,true);assert.equal(review.passed,true);assert.equal(review.source,binding.candidate.source);assert.equal(review.applicationImage,binding.candidate.image);assert.deepEqual(review.receiptManifestSha256s,proof.runs.map(row=>row.receiptManifestSha256));
      }
      if(input.kind==='recovery'){assert.equal(input.file,binding.ordinaryRecovery.file);assert.equal(input.sha256,binding.ordinaryRecovery.sha256);assert.equal(proof.passed,true);assert.deepEqual(proof.admissionPhases,[121,125,126,127,128,129]);assert.equal(proof.retainedCompletedMigrations,53);}
      assert.ok(Date.parse(proof.completedAt)>=Date.parse(binding.evidenceNotBefore));
    }return true;
  }
  const source='ddc5996b3b8645859fa51a9613486db52c481b7f',image='sha256:8ae47ef898382883c20406c83a97728168d115d47345b7790701cb266fd7c835';
  for(const input of inputs){assert.match(input.sha256,/^[a-f0-9]{64}$/);const bytes=readFileSync(input.file);assert.equal(hash(bytes),input.sha256);const proof=JSON.parse(bytes);
    assert.equal(proof.source??proof.servingSource,source);assert.equal(proof.applicationImage??proof.servingImage,image);
    if(input.kind==='classroom'){assert.equal(proof.syntheticAcceptancePassed,true);assert.equal(proof.profile,PROFILES.classroomNative.name);assert.equal(proof.profileSha256,profileHash(PROFILES.classroomNative));assert.equal(proof.offered,2040);assert.equal(proof.succeeded,2040);assert.ok(Object.values(proof.allRoundChecks).every(value=>value===true));}
    if(input.kind==='mixed'){assert.equal(proof.passed,true);assert.equal(proof.currentSchoolOnly,true);assert.equal(proof.profile,PROFILES.mixedNative.name);assert.equal(proof.profileSha256,profileHash(PROFILES.mixedNative));assert.equal(proof.runs.length,3);assert.equal(proof.aggregate.passed,true);assert.match(proof.independentFullReviewSha256,/^[a-f0-9]{64}$/);}
    if(input.kind==='recovery'){assert.equal(proof.passed,true);assert.deepEqual(proof.phases.map(row=>row.name),['bridge128','adopt129','fallback129','return129']);}
  }return true;
}
export function assertLowerReservation(reservation,binding){
  assert.equal(reservation.lowerLoadContractSha256,lowerContractHash());assert.equal(reservation.hostHarnessSource,binding.hostHarnessSource);
  assert.equal(reservation.lowerLoadBindingSha256,hash(JSON.stringify(binding)));
}
export function assertLowerRun(options,profile){
  const binding=options.lowerLoad;
  if(options.acceptanceSuccessor){
    const successor=validateAcceptanceSuccessor(options.acceptanceSuccessor);
    assertSuccessorRunBinding(options,profile,successor);
    assert.equal(profile.name,PROFILES.lower250.name);assert.equal(profile.lowerLoadEnvelope,true);assert.equal(options.arm,'B');
    assert.equal(binding.contractSha256,lowerContractHash());assert.equal(binding.hostHarnessSource,successor.binding.harness.source);
    assert.deepEqual(binding.acceptanceSuccessor,options.acceptanceSuccessor);
    assert.equal(binding.detailedQueryRecorder,false);assert.equal(binding.cpuProfiler,false);
    assert.equal(binding.helperImage,successor.binding.helpers.candidate.helperImage);assert.equal(binding.sourceSchemaSha256,successor.binding.candidate.schema.canonicalSha256);
    assert.equal(binding.flagsBindingSha256,successor.binding.environment.flagsBinding.sha256);assert.equal(binding.flagsBindingFile,successor.binding.environment.flagsBinding.file);
    assert.equal(binding.contractsSha256,hash(readFileSync(binding.contractsFile)));assert.equal(binding.contractsSha256,hash(readFileSync(fileURLToPath(new URL('./contracts.mjs',import.meta.url)))));
    assertLowerSafetyPrerequisites(binding.safetyPrerequisites,successor);
    assert.deepEqual(binding.overlays.map(row=>row.name).sort(),['blackbox-generator.mjs','lower-staff.mjs']);
    for(const overlay of binding.overlays){assert.equal(hash(readFileSync(overlay.file)),overlay.sha256);assert.equal(hash(readFileSync(fileURLToPath(new URL('./'+overlay.name,import.meta.url)))),overlay.sha256);}
    return binding;
  }
  assert.equal(binding?.acceptanceSuccessor,undefined,'Successor evidence requires its explicit outer binding');
  assert.equal(profile.lowerLoadEnvelope,true);assert.equal(profile.kind,'blackbox');assert.equal(profile.usage,false);assert.equal(profile.apiTasks,1);
  assert.equal(options.arm,'B');assert.equal(options.preparationSmoke===true,false);assert.equal(options.snapshotDirectory,undefined);
  assert.equal(binding?.contractSha256,lowerContractHash());assert.equal(binding.detailedQueryRecorder,false);assert.equal(binding.cpuProfiler,false);
  assert.equal(binding.hostHarnessSource,options.hostHarnessSource);assert.match(binding.hostHarnessSource,/^[a-f0-9]{40}$/);
  assert.equal(binding.contractsSha256,hash(readFileSync(binding.contractsFile)));
  assert.equal(binding.contractsSha256,hash(readFileSync(fileURLToPath(new URL('./contracts.mjs',import.meta.url)))));
  assert.equal(binding.helperImage,'sha256:53154562058f524cf801c5d49406f566be2574a2ffd7ba6cc850263cb4338617');
  assert.equal(options.helperImage,binding.helperImage);assert.equal(options.source,'ddc5996b3b8645859fa51a9613486db52c481b7f');
  assert.equal(options.observedEnvironmentSha256,'f14980230e4431ab2155650b439dfced109b12da9c9b72fc41519a93698c9a26');
  assert.equal(binding.flagsBindingSha256,'45477bcf7fb7abdb4077124d843ece18a1f966d21fa9052e85ea2453e040f242');
  assert.equal(hash(readFileSync(binding.flagsBindingFile)),binding.flagsBindingSha256);
  assert.equal(JSON.parse(readFileSync(binding.flagsBindingFile)).currentFlagsFileSha256,options.observedEnvironmentSha256);
  assert.equal(binding.sourceSchemaSha256,'3afe69c3b2dcdeaae049f24d766c542c5e12cf762227b194db329dc0368df570');
  assertLowerSafetyPrerequisites(binding.safetyPrerequisites);
  assert.deepEqual(binding.overlays.map(row=>row.name).sort(),['blackbox-generator.mjs','lower-staff.mjs']);
  for(const overlay of binding.overlays){assert.equal(hash(readFileSync(overlay.file)),overlay.sha256);assert.equal(hash(readFileSync(fileURLToPath(new URL('./'+overlay.name,import.meta.url)))),overlay.sha256);}
  return binding;
}
export function lowerCreateArguments(args,binding){
  assert.ok(args[0]!=='kill'&&!(args[0]==='rm'&&args.includes('--force')),'Lower runs cannot force owners');
  if(args[0]!=='create')return args;
  const label=args.find(value=>value.startsWith('codex.release297-role='));assert.match(label||'',/^codex.release297-role=(?:api0|generator|observer|seeder)$/);
  assert.ok(!args.some(value=>value.includes('--cpu-prof')||value.includes('--inspect')));
  const result=[...args],entry=result.indexOf('/harness/role-entry.mjs');assert.equal(entry,result.length-1);
  result.splice(entry-1,0,'--mount',`type=bind,source=${binding.contractsFile},target=/diagnostic/scripts/load/usage/release-gates-v2/contracts.mjs,readonly`);
  if(label==='codex.release297-role=generator')for(const overlay of binding.overlays)result.splice(result.length-2,0,'--mount',`type=bind,source=${overlay.file},target=/diagnostic/scripts/load/usage/release-gates-v2/${overlay.name},readonly`);
  return result;
}
export function assertLowerPostRls(actual,initial,binding,at=Date.now()){
  let expectedMigrations=54;
  if(binding?.acceptanceSuccessor){validateAcceptanceSuccessor(binding.acceptanceSuccessor,{at});expectedMigrations=53;}
  for(const key of ['passed','restrictedRole','crossSchool','resetScope'])assert.equal(actual[key],true);
  assert.deepEqual(actual.catalog,initial.catalog);assert.equal(actual.catalog.length,129);assert.equal(new Set(actual.catalog.map(row=>row.relname)).size,129);
  assert.ok(actual.catalog.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
  assertLowerMigrationVector(actual.migrations,initial.migrations,expectedMigrations);return true;
}
export function assertLowerMigrationVector(actual,initial,expected){
  assert.ok([53,54].includes(expected));assert.deepEqual(actual,initial);assert.equal(actual.length,expected);assert.equal(new Set(actual.map(row=>row.id)).size,expected);
  assert.ok(actual.every(row=>row.status==='complete'&&/^[a-f0-9]{64}$/.test(row.checksum)));return true;
}
function contained(root,path){const base=realpathSync(root),file=realpathSync(path),rel=relative(base,file);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));return file;}
export function verifyLowerNativeCustody(privateDirectory,metrics,profile){
  const fixtureFile=contained(privateDirectory,join(privateDirectory,'generator','request-1.json'));
  const fixtureBytes=readFileSync(fixtureFile);assert.equal(hash(fixtureBytes),metrics.lowerStaffFixtureSha256);const request=JSON.parse(fixtureBytes);assert.equal(request.operation,'initialize');
  const path=contained(privateDirectory,join(privateDirectory,'generator','lower-staff-reads.private.json')),bytes=readFileSync(path),proof=JSON.parse(bytes);
  const actual=checkLowerStaffRows(proof.rows,request.value,profile);assert.deepEqual(actual,proof.summary);
  assert.equal(proof.run,metrics.run);assert.equal(proof.source,metrics.source);assert.equal(proof.profile,profile.name);
  assert.deepEqual(metrics.rounds[0].traffic.lowerStaffReads,{...actual,nativeProofSha256:hash(bytes)});return true;
}
export function lowerPersistenceCustody(privateDirectory){
  const directory=join(privateDirectory,'observer');
  const requests=readdirSync(directory).filter(name=>/^request-\d+\.json$/.test(name)).map(name=>({name,request:JSON.parse(readFileSync(join(directory,name)))}))
    .filter(row=>row.request.operation==='snapshot').sort((a,b)=>a.request.id-b.request.id);
  assert.equal(requests.length,2);return requests.map(row=>({request:'observer/'+row.name,response:`observer/response-${row.request.id}.json`,
    requestSha256:hash(readFileSync(join(directory,row.name))),responseSha256:hash(readFileSync(join(directory,`response-${row.request.id}.json`)))}));
}
export function verifyLowerPersistenceCustody(privateDirectory,metrics){
  assert.equal(metrics.lowerPersistenceCustody.length,2);const snapshots=metrics.lowerPersistenceCustody.map(row=>{
    const request=JSON.parse(readFileSync(contained(privateDirectory,join(privateDirectory,row.request))));assert.equal(request.operation,'snapshot');
    assert.equal(hash(readFileSync(contained(privateDirectory,join(privateDirectory,row.request)))),row.requestSha256);
    const bytes=readFileSync(contained(privateDirectory,join(privateDirectory,row.response)));assert.equal(hash(bytes),row.responseSha256);
    const response=JSON.parse(bytes);assert.equal(response.id,request.id);assert.deepEqual(response.binding,{run:metrics.run,source:metrics.source,role:'observer',containerId:metrics.roleCleanup.exits.find(exit=>exit.role==='observer').containerId});
    return response.value;
  });
  const fixture=JSON.parse(readFileSync(contained(privateDirectory,join(privateDirectory,'generator','request-1.json')))).value;
  const actual=checkPersistence(snapshots[0],snapshots[1],metrics.rounds[0].traffic,fixture);
  assert.deepEqual(actual,metrics.rounds[0].persistence);assert.equal(actual.passed,true);
  assert.equal(metrics.rounds[0].persisted,snapshots[1].total-snapshots[0].total);assert.equal(snapshots[1].invalid,0);return true;
}
export function lowerHeadroom(record){
  return record.runPassed===true&&record.rounds?.length===1&&record.rounds[0].cpuByRole?.length===1
    &&record.rounds[0].apiCpuMeanFraction<=LOWER_CONTRACT.selectionHeadroom.maxApiMeanCpuFraction
    &&record.p95Ms<=LOWER_CONTRACT.selectionHeadroom.maxP95Ms;
}
export function assertLowerConfirmation(records,profile,{requireHeadroom=true}={}){
  assert.equal(records.length,3);assert.equal(new Set(records.map(row=>row.run)).size,3);
  for(const row of records){assert.equal(row.profile,profile.name);assert.equal(row.contractSha256,profileHash(profile));
    assert.equal(row.arm,'B');assert.equal(row.runPassed,true);assert.equal(row.cleanupPassed,true);assert.equal(row.hostHarnessSourceUnchanged,true);
    assert.equal(row.lowerLoad?.contractSha256,lowerContractHash());assertLowerPostRls(row.postLowerRlsVerification,row.databasePreparation,row.lowerLoad,Date.parse(row.startedAt));
    assert.match(row.verifiedReceiptManifestSha256,/^[a-f0-9]{64}$/);assert.equal(row.rounds[0].traffic.lowerStaffReads.passed,true);}
  for(const key of ['source','applicationImage','schemaSha256','helperImage','harnessSource','hostHarnessSource','observedFlagsSha256','clientAdvertisementSha256'])
    assert.equal(new Set(records.map(row=>row[key])).size,1,key);
  const headroomPassed=records.every(lowerHeadroom);if(requireHeadroom)assert.equal(headroomPassed,true);
  return{hardGatePassed:true,headroomPassed,heartbeatEnvelopeOnly:true,productionReadiness:false};
}
