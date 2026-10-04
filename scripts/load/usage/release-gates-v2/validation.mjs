import assert from 'node:assert/strict';
import { profileFor, profileHash, NONREGRESSION, PROFILES,stickyTarget } from './contracts.mjs';
import { cpuWindow, negativeProbes } from './measurements.mjs';
import { lostReconnectBindings } from './reconnect.mjs';
import { lifecycleAudience } from './lifecycle-audience.mjs';
import { expectedTargetsBefore } from './routing.mjs';
const median = values => { const rows = [...values].sort((a, b) => a - b); return rows.length % 2 ? rows[(rows.length - 1) / 2] : (rows[rows.length / 2 - 1] + rows[rows.length / 2]) / 2; };
export function expectedTopologyCounts(profile,stage){
  const counts={};for(let schoolIndex=0;schoolIndex<2;schoolIndex++)for(let deviceIndex=0;deviceIndex<profile.offering.schoolDevices[schoolIndex];deviceIndex++){
    const target=stickyTarget(schoolIndex*500+deviceIndex,stage.active,stage.distribution);counts[target]=(counts[target]??0)+60_000/profile.offering.deviceCadenceMs;
  }return counts;
}
export function validateLostReconnectEvidence(extra,profile){
  try{
    const evidence=extra.lostBindingEvidence,selected=lostReconnectBindings(evidence.observedSamples,profile,evidence.startsAtMs);
    assert.deepEqual(evidence,selected);const stage=profile.stages.find(row=>row.reconnectLostOnly);
    const targets={};for(const samples of selected.schools)for(const sample of samples){
      const target=stickyTarget(sample.schoolIndex*500+sample.deviceIndex,stage.active,stage.distribution);targets[target]=(targets[target]??0)+1;
    }
    assert.equal(extra.offered,stage.reconnectOffers);assert.deepEqual(extra.targetHistogram,targets);
    assert.deepEqual(Object.keys(extra.bindings).sort(),selected.schools.flatMap((samples,schoolIndex)=>samples.map(row=>`${schoolIndex}:${row.deviceIndex}`)).sort());
    return true;
  }catch{return false;}
}
export function validateRound(round, profile, { diagnostic = false, baseline = false } = {}) {
  assert.deepEqual(profile, profileFor(profile.name)); const traffic = round.traffic?.heartbeats ?? round.traffic;
  const extra = round.traffic?.reconnect;
  const expected = profile.offering.expected + (round.reconnect ? (extra?.statusHistogram?.[200] ?? NaN) : 0);
  const ordinary = traffic && traffic.expected === profile.offering.expected && JSON.stringify(traffic.configured) === JSON.stringify(profile.offering)
    && traffic.accepted === true && traffic.started === profile.offering.expected && traffic.succeeded === profile.offering.expected
    && traffic.failed === 0 && traffic.refusedAtInFlightLimit === 0 && traffic.lateOffers === 0 && traffic.outstandingAfterDrain === 0
    && traffic.timings?.count === profile.offering.expected && traffic.timings.maxMs < 20_000;
  const reconnect = !round.reconnect || (extra?.expected === round.topology.reconnectOffers && extra.accepted === true && extra.succeeded === round.topology.reconnectOffers && extra.failed === 0 && extra.lateOffers === 0 && extra.outstandingAfterDrain === 0);
  const checks = { actualProfile: round.profile === profile.name && round.contractSha256 === profileHash(profile),
    offering: !!ordinary, reconnect: !!reconnect, persistence: round.invalidBindings === 0 && round.persistence?.passed === true
      && (round.continuousGlobal ? round.continuousGlobal.passed===true && round.continuousGlobal.actualPersisted===round.continuousGlobal.acknowledged200 : round.persisted===expected),
    declaredStartAlignment:traffic?.declaredStartedAtMs==null||(traffic.startAlignmentAccepted===true
      &&traffic.declaredStartLatenessMs===traffic.actualStartedAtMs-traffic.declaredStartedAtMs
      &&traffic.declaredStartLatenessMs>=0&&traffic.declaredStartLatenessMs<=profile.offering.maxOfferLatenessMs),
    capabilityAcknowledgements:traffic?.capabilityAcknowledgements200===profile.offering.expected,
    targetCounts:round.continuousGlobal ? round.continuousGlobal.targetCounts===true : round.api?.length===round.topology.active.length && round.api.every((row,n)=>
      (row.seenHeartbeatOffers??row.http?.seenHeartbeatOffers)===(traffic?.targetHistogram?.[round.topology.active[n]]??0)+(extra?.targetHistogram?.[round.topology.active[n]]??0)),
    declaredDistribution:profile.kind!=='mixed'||JSON.stringify(traffic?.targetHistogram)===JSON.stringify(expectedTopologyCounts(profile,round.topology)),
    drains: round.drains?.length > 0 && round.drains.every(row => row.complete === true),
    cpuBound: profile.usage || baseline || (round.measuredWindowMs===60_000 && round.cpuByRole?.length===round.topology.active.length
      && round.cpuByRole.every(row=>cpuWindow(row.window).meanFraction < NONREGRESSION.meanCpuFraction)
      && round.apiCpuMeanFraction===Math.max(...round.cpuByRole.map(row=>cpuWindow(row.window).meanFraction))),
    latency: traffic?.timings?.p95Ms <= NONREGRESSION.p95Ms,
    classroom: ['classroom', 'mixed', 'usage'].includes(profile.kind) ? round.traffic?.lifecycle?.passed === true
      &&negativeProbes(round.traffic).length===lifecycleAudience(profile).schoolIndices.length : true,
    database: round.errorCoverage?.length === round.topology.active.length+1+(profile.usage?1:0)
      && round.errorCoverage.every(row=>row.available===true && row.complete===true && row.errorCount===0 && /^[a-f0-9]{64}$/.test(row.sha256))
      && round.databaseFailures===0 };
  if(profile.classroomBindingOracle)checks.nativeClassroomBindings=(round.classroomBindings??round.continuousGlobal?.classroom)?.passed===true
    &&/^[a-f0-9]{64}$/.test((round.classroomBindings??round.continuousGlobal?.classroom)?.nativeRowsSha256??'');
  if(profile.lowerLoadEnvelope)checks.scopedTeacherReads=traffic?.lowerStaffReads?.passed===true
    &&traffic.lowerStaffReads.ownSessionReads===6&&traffic.lowerStaffReads.foreignSessionDenials===6
    &&traffic.lowerStaffReads.offered===12&&traffic.lowerStaffReads.sameApi===true&&traffic.lowerStaffReads.schoolIndex===0
    &&/^[a-f0-9]{64}$/.test(traffic.lowerStaffReads.nativeProofSha256??'');
  if(profile.broaderCapacityGate&&round.reconnect)checks.exactLostReconnects=validateLostReconnectEvidence(extra,profile);
  if (profile.usage) {
    const usage=round.continuousGlobal?.usage??round;
    checks.reports = reportMatrix(usage.traffic?.reports??usage.reports);
    checks.workers = usage.workers?.length === 2 && [0,1].every(index=>usage.workers.filter(row=>row.schoolIndex===index && row.correct===true && row.durationMs<=48_000).length===1);
    checks.correctness = usage.correctness?.passed === true && usage.correctness.audit?.passed===true && usage.correctness.audit.auditRecords?.length===8;
    checks.workerDatabase=usage.workerDatabase?.acquisitions?.count>0 && usage.workerDatabase.acquisitions.failures===0
      && Object.keys(usage.workerDatabase.statements??{}).length>0 && Object.values(usage.workerDatabase.statements).every(row=>row.failures===0);
    if(profile.kind==='mixed'){
      checks.scheduledUsageWaves=usage.reports?.every(row=>row.scheduledOffsetMs===profile.reportWaveOffsetsMs[row.wave]
        &&row.offeredOffsetMs>=row.scheduledOffsetMs&&row.endpointIndex===stickyTarget(row.schoolIndex*500,stageForReport(profile,row.wave).active,stageForReport(profile,row.wave).distribution));
      checks.lossConcurrentWorker=usage.workerStartAtMs===profile.workerStartAtMs&&usage.workerStartedOffsetMs>=profile.workerStartAtMs
        &&usage.workerStartedOffsetMs<profile.workerStartAtMs+1000&&workerLossOverlap(usage,profile);
    }
    // Usage capacity has unchanged deadlines, not the release CPU/500ms SLO.
    // These observations still travel in the receipt but do not redefine it.
    delete checks.cpuBound; delete checks.latency;
  }
  return { checks, passed: !diagnostic && Object.values(checks).every(value => value === true), diagnosticOnly: diagnostic };
}
export function validatePairs(records, { profile, baselineSource, candidateSource, observedFlagsSha256 }) {
  assert.ok([PROFILES.sole.name, PROFILES.normal.name].includes(profile.name));
  assert.equal(records.length, 8, 'Exactly two A/A controls followed by three A/B pairs');
  for (const record of records) {
    assert.equal(record.profile, profile.name); assert.equal(record.contractSha256, profileHash(profile)); assert.equal(record.observedFlagsSha256, observedFlagsSha256);
    assert.equal(record.source, record.arm === 'A' ? baselineSource : candidateSource);
    assert.equal(record.runPassed, true); assert.equal(record.cleanupPassed, true); assert.equal(record.sourceUnchanged, true);
    assert.ok(record.cpuMsPer200 > 0 && Number.isFinite(record.cpuMsPer200)); assert.ok(record.p95Ms > 0 && record.p95Ms <= 500);
    assert.equal(record.wholeOwnedCpuIncludesFinalClassificationFlush,true);assert.ok(Number.isFinite(record.wholeOwnedApiCpuMicroseconds)&&record.wholeOwnedApiCpuMicroseconds>0);
    assert.equal(record.cpuMsPer200,record.wholeOwnedApiCpuMicroseconds/1000/profile.offering.expected);
    assert.match(record.verifiedReceiptManifestSha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(records.map(row => row.arm), ['A', 'A', 'A', 'B', 'B', 'A', 'A', 'B']);
  assert.equal(new Set(records.map(row => row.fixtureLogicalSha256)).size, 1); assert.equal(new Set(records.map(row => row.nodeVersion)).size, 1);
  assert.equal(new Set(records.map(row=>row.harnessSource)).size,1);assert.ok(records.every(row=>/^[a-f0-9]{40}$/.test(row.harnessSource)));
  for(const arm of ['A','B']){const sameArm=records.filter(row=>row.arm===arm);assert.equal(new Set(sameArm.map(row=>row.schemaSha256)).size,1);assert.ok(sameArm.every(row=>/^[a-f0-9]{64}$/.test(row.schemaSha256)));
    assert.equal(new Set(sameArm.map(row=>row.applicationImage)).size,1);assert.ok(sameArm.every(row=>/^(?:sha256:|[a-zA-Z0-9./:_-]+@sha256:)[a-f0-9]{64}$/.test(row.applicationImage)));}
  assert.equal(new Set(records.map(row=>row.clientAdvertisementSha256)).size,1);assert.ok(records.every(row=>/^[a-f0-9]{64}$/.test(row.clientAdvertisementSha256)&&row.clientAdvertisementVersion==='2.9.6'));
  const controls = records.slice(0, 2), pairs = [[records[2], records[3]], [records[5], records[4]], [records[6], records[7]]];
  const ratio = (a, b, key) => b[key] / a[key];
  const controlsStable = Math.max(...controls.map(row => row.cpuMsPer200)) / Math.min(...controls.map(row => row.cpuMsPer200)) <= 1.05
    && Math.abs(controls[0].p95Ms - controls[1].p95Ms) <= 50;
  const cpuRatios = pairs.map(([a, b]) => ratio(a, b, 'cpuMsPer200'));
  const p95Ratios = pairs.map(([a, b]) => ratio(a, b, 'p95Ms'));
  const p95Increases = pairs.map(([a, b]) => b.p95Ms - a.p95Ms);
  const checks = { controlsStable, medianCpu: median(cpuRatios) <= 1.05, medianP95: median(p95Ratios) <= 1.10,
    medianP95Increase: median(p95Increases) <= 50, individualCpu: cpuRatios.every(value => value <= 1.10), individualP95: p95Increases.every(value => value <= 100) };
  return { checks, passed: Object.values(checks).every(Boolean), disposition: !controlsStable ? 'inconclusive-control-variance' : Object.values(checks).every(Boolean) ? 'accepted-synthetic-nonregression' : 'nonregression-failed', cpuRatios, p95Ratios, p95Increases };
}
// Avoid inferring the chosen contract from a result's rates.
export function validateMixedRuns(runs) {
  assert.equal(runs.length, 3); const profile = profileFor(runs[0].profile);assert.ok([PROFILES.mixed.name,PROFILES.mixedNative.name,PROFILES.broader.name,PROFILES.broaderConcentrated.name].includes(profile.name));
  for (const run of runs) {
    assert.equal(run.profile, profile.name); assert.equal(run.rounds.length, profile.rounds); assert.equal(run.cleanupPassed, true);assert.equal(run.runPassed,true);assert.equal(run.failure,null);
    assert.equal(run.continuous?.passed,true);assert.equal(run.continuous.expected,profile.continuousOffering.expected);assert.equal(run.continuous.offered,profile.continuousOffering.expected);assert.equal(run.continuous.windowsContinuous,true);
    assert.equal(run.contractSha256, profileHash(profile)); assert.equal(run.sourceUnchanged, true);
    for (const round of run.rounds) assert.equal(validateRound(round, profile).passed, true);
    assert.deepEqual(run.transitions.map(row => [row.round,row.active.length,row.distribution]),profile.stages.map(row=>[row.fromRound,row.active.length,row.distribution]));
    validatePhysicalLoss(run,profile);
  }
  assert.equal(new Set(runs.map(row => row.source)).size, 1); assert.equal(new Set(runs.map(row => row.schemaSha256)).size, 1);
  assert.equal(new Set(runs.map(row=>row.applicationImage)).size,1);
  assert.equal(new Set(runs.map(row=>row.harnessSource)).size,1);assert.ok(runs.every(row=>/^[a-f0-9]{40}$/.test(row.harnessSource)));
  return { passed: true, currentSchoolOnly: !profile.broaderCapacityGate,broaderVariant:profile.broaderVariant??null,
    broaderVariantPassed:profile.broaderCapacityGate===true,broaderSyntheticCapacityGatePassed:false,broaderCapacityClaimed:false };
}
export function validatePhysicalLoss(run,profile) {
  const loss=profile.stages.find(stage=>stage.lost!==undefined),transition=run.transitions.find(row=>row.round===loss.fromRound);
  assert.equal(transition.lostRole,'api'+loss.lost);assert.equal(transition.cleanShutdown,true);
  const epoch=run.continuous.traffic.heartbeats.declaredStartedAtMs,lossAtMs=epoch+loss.fromRound*60_000,
    reconnectAtMs=lossAtMs+loss.reconnectStartDelayMs,handoff=transition.ingressHandoff,
    expected=expectedTargetsBefore(profile,loss.fromRound*60_000)[loss.lost];
  assert.ok(Number.isFinite(epoch)&&epoch>0);assert.equal(handoff.expected,expected);assert.equal(handoff.observed,expected);
  assert.equal(handoff.actualServerOwnership,true);assert.ok(Number.isFinite(handoff.startedAtMs)&&Number.isFinite(handoff.completedAtMs));
  assert.ok(handoff.startedAtMs>=lossAtMs&&handoff.completedAtMs>=handoff.startedAtMs&&handoff.completedAtMs<reconnectAtMs);
  assert.ok(Array.isArray(handoff.observations)&&handoff.observations.length>0);
  assert.ok(handoff.observations.every(row=>Number.isFinite(row.atMs)&&row.atMs>=handoff.startedAtMs&&row.atMs<=handoff.completedAtMs
    &&Number.isSafeInteger(row.count)&&row.count>=0&&row.count<=expected));
  assert.equal(handoff.observations.at(-1).count,expected);assert.equal(handoff.observations.at(-1).atMs,handoff.completedAtMs);
  assert.ok(Number.isFinite(transition.shutdownCompletedAtMs)&&transition.shutdownCompletedAtMs>=handoff.completedAtMs
    &&transition.shutdownCompletedAtMs<reconnectAtMs,'Physical API loss must precede declared reconnect offers');
  return true;
}
const stageForReport=(profile,wave)=>[...profile.stages].reverse().find(stage=>stage.fromRound*60_000<=profile.reportWaveOffsetsMs[wave]);
export function workerLossOverlap(usage,profile){
  if(!Number.isFinite(usage.startsAtMs)||!Array.isArray(usage.workers)||usage.workers.length!==2)return false;
  const loss=profile.stages.find(stage=>stage.reconnectLostOnly),reconnectStart=loss.fromRound*60_000+loss.reconnectStartDelayMs,
    reconnectEnd=reconnectStart+loss.reconnectWindowMs,lossWave=profile.reportWaveOffsetsMs.indexOf(profile.workerStartAtMs),reports=usage.reports?.filter(row=>row.wave===lossWave);
  if(reports?.length!==16)return false;
  return usage.workers.every(worker=>{
    const start=worker.startedAtMs-usage.startsAtMs,end=worker.finishedAtMs-usage.startsAtMs;
    return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&start<reconnectEnd&&end>reconnectStart
      &&reports.some(report=>Number.isFinite(report.offeredOffsetMs)&&Number.isFinite(report.durationMs)&&start<report.offeredOffsetMs+report.durationMs&&end>report.offeredOffsetMs);
  });
}
export function reportMatrix(rows) {
  if (!Array.isArray(rows) || rows.length!==64 || !rows.every(row=>row.status===200 && row.correct===true && Number.isFinite(row.durationMs) && row.durationMs<20_000)) return false;
  for (const schoolIndex of [0,1]) for (const scope of ['school','grade','class','student']) for (const [wave,days] of [1,7,30,365].entries()) {
    if (rows.filter(row=>row.schoolIndex===schoolIndex && row.scope===scope && row.wave===wave && row.days===days).length!==2) return false;
  }
  return true;
}
