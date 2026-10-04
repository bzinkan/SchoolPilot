import assert from 'node:assert/strict';
import { profileFor, profileHash, NONREGRESSION, PROFILES } from './contracts.mjs';
import { cpuWindow, negativeProbes } from './measurements.mjs';
const median = values => { const rows = [...values].sort((a, b) => a - b); return rows.length % 2 ? rows[(rows.length - 1) / 2] : (rows[rows.length / 2 - 1] + rows[rows.length / 2]) / 2; };
export function validateRound(round, profile, { diagnostic = false, baseline = false } = {}) {
  assert.deepEqual(profile, profileFor(profile.name)); const traffic = round.traffic?.heartbeats ?? round.traffic;
  const extra = round.traffic?.reconnect;
  const expected = profile.offering.expected + (round.reconnect ? (extra?.statusHistogram?.[200] ?? NaN) : 0);
  const ordinary = traffic && traffic.expected === profile.offering.expected && JSON.stringify(traffic.configured) === JSON.stringify(profile.offering)
    && traffic.accepted === true && traffic.started === profile.offering.expected && traffic.succeeded === profile.offering.expected
    && traffic.failed === 0 && traffic.refusedAtInFlightLimit === 0 && traffic.lateOffers === 0 && traffic.outstandingAfterDrain === 0
    && traffic.timings?.count === profile.offering.expected && traffic.timings.maxMs < 20_000;
  const reconnect = !round.reconnect || (extra?.expected === 133 && extra.accepted === true && extra.succeeded === 133 && extra.failed === 0 && extra.lateOffers === 0 && extra.outstandingAfterDrain === 0);
  const checks = { actualProfile: round.profile === profile.name && round.contractSha256 === profileHash(profile),
    offering: !!ordinary, reconnect: !!reconnect, persistence: round.invalidBindings === 0 && round.persistence?.passed === true
      && (round.continuousGlobal ? round.continuousGlobal.passed===true && round.continuousGlobal.actualPersisted===round.continuousGlobal.acknowledged200 : round.persisted===expected),
    capabilityAcknowledgements:traffic?.capabilityAcknowledgements200===profile.offering.expected,
    targetCounts:round.continuousGlobal ? round.continuousGlobal.targetCounts===true : round.api?.length===round.topology.active.length && round.api.every((row,n)=>
      (row.seenHeartbeatOffers??row.http?.seenHeartbeatOffers)===(traffic?.targetHistogram?.[round.topology.active[n]]??0)+(extra?.targetHistogram?.[round.topology.active[n]]??0)),
    drains: round.drains?.length > 0 && round.drains.every(row => row.complete === true),
    cpuBound: baseline || (round.measuredWindowMs===60_000 && round.cpuByRole?.length===round.topology.active.length
      && round.cpuByRole.every(row=>cpuWindow(row.window).meanFraction < NONREGRESSION.meanCpuFraction)
      && round.apiCpuMeanFraction===Math.max(...round.cpuByRole.map(row=>cpuWindow(row.window).meanFraction))),
    latency: traffic?.timings?.p95Ms <= NONREGRESSION.p95Ms,
    classroom: ['classroom', 'mixed', 'usage'].includes(profile.kind) ? round.traffic?.lifecycle?.passed === true&&negativeProbes(round.traffic).length===2 : true,
    database: round.errorCoverage?.length === round.topology.active.length+1+(profile.usage?1:0)
      && round.errorCoverage.every(row=>row.available===true && row.complete===true && row.errorCount===0 && /^[a-f0-9]{64}$/.test(row.sha256))
      && round.databaseFailures===0 };
  if (profile.kind === 'usage') {
    checks.reports = reportMatrix(round.traffic?.reports);
    checks.workers = round.workers?.length === 2 && [0,1].every(index=>round.workers.filter(row=>row.schoolIndex===index && row.correct===true && row.durationMs<=48_000).length===1);
    checks.correctness = round.correctness?.passed === true && round.correctness.audit?.passed===true && round.correctness.audit.auditRecords?.length===8;
    checks.workerDatabase=round.workerDatabase?.acquisitions?.count>0 && round.workerDatabase.acquisitions.failures===0
      && Object.keys(round.workerDatabase.statements??{}).length>0 && Object.values(round.workerDatabase.statements).every(row=>row.failures===0);
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
  return { checks, passed: Object.values(checks).every(Boolean), disposition: !controlsStable ? 'inconclusive-host-noise' : Object.values(checks).every(Boolean) ? 'accepted-synthetic-nonregression' : 'nonregression-failed', cpuRatios, p95Ratios, p95Increases };
}
// Avoid inferring the chosen contract from a result's rates.
export function validateMixedRuns(runs) {
  assert.equal(runs.length, 3); const profile = PROFILES.mixed;
  for (const run of runs) {
    assert.equal(run.profile, profile.name); assert.equal(run.rounds.length, 15); assert.equal(run.cleanupPassed, true);assert.equal(run.runPassed,true);assert.equal(run.failure,null);
    assert.equal(run.continuous?.passed,true);assert.equal(run.continuous.expected,11970);assert.equal(run.continuous.offered,11970);assert.equal(run.continuous.windowsContinuous,true);
    assert.equal(run.contractSha256, profileHash(profile)); assert.equal(run.sourceUnchanged, true);
    for (const round of run.rounds) assert.equal(validateRound(round, profile).passed, true);
    assert.deepEqual(run.transitions.map(row => [row.round,row.active.length,row.distribution]), [[0,1,'uniform'],[5,3,'uniform'],[7,3,'sticky80'],[10,2,'survivors']]);
    assert.equal(run.transitions.at(-1).lostRole, 'api0'); assert.equal(run.transitions.at(-1).cleanShutdown, true);
  }
  assert.equal(new Set(runs.map(row => row.source)).size, 1); assert.equal(new Set(runs.map(row => row.schemaSha256)).size, 1);
  return { passed: true, currentSchoolOnly: true, broaderCapacityClaimed: false };
}
export function reportMatrix(rows) {
  if (!Array.isArray(rows) || rows.length!==64 || !rows.every(row=>row.status===200 && row.correct===true && Number.isFinite(row.durationMs) && row.durationMs<20_000)) return false;
  for (const schoolIndex of [0,1]) for (const scope of ['school','grade','class','student']) for (const [wave,days] of [1,7,30,365].entries()) {
    if (rows.filter(row=>row.schoolIndex===schoolIndex && row.scope===scope && row.wave===wave && row.days===days).length!==2) return false;
  }
  return true;
}
