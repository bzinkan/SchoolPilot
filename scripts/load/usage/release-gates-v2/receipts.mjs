import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { hash, profileFor, profileHash } from './contracts.mjs';
import { validateRound } from './validation.mjs';
import { classifyLog, runNegativeProbes, negativeLogCoverage } from './measurements.mjs';
import { verifyOperationalFixtureCustody } from './operational-fixture.mjs';
import { verifyClassroomNativeCustody } from './classroom-bindings.mjs';
import {verifyUsagePostVerificationCustody} from './usage-post-verification.mjs';
import {verifyDistinctReceiptCustody} from './distinct-report-custody.mjs';
import {lowerContractHash,assertLowerPostRls,verifyLowerNativeCustody,verifyLowerPersistenceCustody,lowerAcquisitionLogProof} from './lower-load.mjs';
import {assertSuccessorReceiptBinding} from './acceptance-successor.mjs';
const json=path=>JSON.parse(readFileSync(path,'utf8'));
export function loadReceipt(directory, manifestSha256, privateDirectory) {
  const root=realpathSync(directory), path=join(root,'receipt-manifest.json'), bytes=readFileSync(path);
  assert.match(manifestSha256,/^[a-f0-9]{64}$/);assert.equal(hash(bytes),manifestSha256);
  const manifest=JSON.parse(bytes);assert.equal(manifest.schemaVersion,2);
  const profile=profileFor(manifest.profile);assert.match(manifest.source,/^[a-f0-9]{40}$/);assert.match(manifest.run,/^[a-f0-9]{12}$/);
  assert.ok(manifest.records['metrics.json'] && manifest.records['role-cleanup.json']);
  assert.deepEqual(readdirSync(root).filter(name=>name.endsWith('.json')&&name!=='receipt-manifest.json').sort(),Object.keys(manifest.records).sort());
  for(const [name,expected] of Object.entries(manifest.records)) {
    assert.match(name,/^[a-zA-Z0-9_.-]+\.json$/);assert.match(expected,/^[a-f0-9]{64}$/);
    const file=realpathSync(join(root,name)), rel=relative(root,file);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));
    assert.equal(hash(readFileSync(file)),expected);
  }
  const metrics=json(join(root,'metrics.json')), cleanup=json(join(root,'role-cleanup.json'));
  if(profile.distinctReports)assert.deepEqual(metrics.roleCleanup,cleanup);
  assert.equal(metrics.profile,profile.name);assert.equal(metrics.contractSha256,profileHash(profile));
  assert.equal(metrics.source,manifest.source);assert.equal(metrics.run,manifest.run);assert.equal(metrics.planSha256,manifest.planSha256);
  assertSuccessorReceiptBinding(metrics);
  if(profile.lowerLoadEnvelope){assert.equal(metrics.lowerLoad?.contractSha256,lowerContractHash());assert.ok(manifest.records['lower-post-rls-verification.json']);
    assert.equal(metrics.lowerLoad.detailedQueryRecorder,false);assert.equal(metrics.lowerLoad.cpuProfiler,false);assert.equal(metrics.arm,'B');
    assert.deepEqual(json(join(root,'lower-post-rls-verification.json')),metrics.postLowerRlsVerification);
    assert.ok(Date.parse(metrics.startedAt)>=Date.parse(metrics.lowerAuthorizedWindow?.startsAt));assert.ok(Date.parse(metrics.finishedAt)<Date.parse(metrics.lowerAuthorizedWindow?.expiresAt));
    assert.equal(metrics.lowerLogCustodyFailure===true,false);assert.equal(metrics.lowerRecoveredOwner===true,false);
    assert.deepEqual(cleanup.exits.map(row=>row.role).sort(),['api0','generator','observer','seeder']);
    assertLowerPostRls(metrics.postLowerRlsVerification,metrics.databasePreparation,metrics.lowerLoad,Date.parse(metrics.startedAt));assert.equal(metrics.hostHarnessSourceUnchanged,true);
    verifyLowerNativeCustody(privateDirectory,metrics,profile);verifyLowerPersistenceCustody(privateDirectory,metrics);}
  if(profile.lowerLoadEnvelope)assert.deepEqual(metrics.lowerAcquisitionLogEvidence,lowerAcquisitionLogProof(readFileSync(join(privateDirectory,'api0-log.private'),'utf8'),{
    source:metrics.source,measuredEndsAtMs:metrics.rounds[0].traffic.actualStartedAtMs+profile.offering.durationMs,complete:cleanup.exits.find(exit=>exit.role==='api0')?.clean===true}));
  if(metrics.operationalFixtureBootstrapRequired)assert.ok(manifest.records['operational-fixture-bootstrap.json']);
  if(manifest.records['operational-fixture-bootstrap.json'])verifyOperationalFixtureCustody(root,metrics);
  if(metrics.runPassed||metrics.smokePassed)verifyClassroomNativeCustody(privateDirectory,metrics);
  if(metrics.usagePostVerificationContractSha256&&(metrics.runPassed||metrics.usagePostVerification)){
    assert.ok(manifest.records['usage-classroom-post-verification.json']);verifyUsagePostVerificationCustody(root,privateDirectory,metrics);
    assert.equal(metrics.hostHarnessSourceUnchanged,true);
  }
  for(const exit of cleanup.exits) {
    assert.equal(exit.run,metrics.run);assert.equal(exit.source,metrics.source);
    assert.deepEqual(exit,json(join(root,exit.role+'-exit.json')));
    const logs=readFileSync(join(privateDirectory,exit.role+'-log.private'),'utf8');assert.equal(hash(logs),exit.logsSha256);
    if(exit.role.startsWith('api')||profile.distinctReports){
      const coverage=metrics.errorCoverage.find(row=>row.role===exit.role);assert.ok(coverage);
      const actual=classifyLog(logs,'api',{complete:exit.clean,expectedNegativeProbes:exit.role.startsWith('api')?runNegativeProbes(metrics):[]});
      for(const key of ['sha256','errorCount','complete','available','bytes']) assert.equal(coverage[key],actual[key]);
      assert.deepEqual(coverage.expectedNegativeRequestIds,actual.expectedNegativeRequestIds);
    }
  }
  const pgLog=readFileSync(join(privateDirectory,'postgres-log.private'),'utf8');
  const postgres=metrics.errorCoverage.find(row=>row.kind==='postgres');assert.equal(postgres.sha256,hash(pgLog));
  if(profile.distinctReports){
    const actual=classifyLog(pgLog,'postgres',{complete:true});
    for(const key of ['sha256','errorCount','complete','available','bytes'])assert.equal(postgres[key],actual[key]);
    assert.deepEqual(postgres.categories,actual.categories);
  }
  assert.equal(new Set(cleanup.exits.map(row=>row.containerId)).size,cleanup.exits.length);
  assert.equal(metrics.expectedNegativeLogCoverage,negativeLogCoverage(metrics.errorCoverage,runNegativeProbes(metrics)));
  assert.equal(cleanup.confirmedAbsent,true);assert.equal(metrics.cleanupPassed,cleanup.cleanupPassed===true && json(join(root,manifest.records['postgres-cleanup.json']?'postgres-cleanup.json':'cleanup.json')).cleanupPassed===true);
  for(const round of metrics.rounds) assert.deepEqual(round.acceptance,validateRound(round,profile,{diagnostic:profile.kind==='diagnostic',baseline:metrics.arm==='A'}));
  if(metrics.runPassed||metrics.smokePassed){assert.equal(metrics.expectedNegativeLogCoverage,true);assert.ok(metrics.errorCoverage.every(row=>row.complete&&row.available&&row.errorCount===0));}
  if(metrics.runPassed) {
    assert.equal(metrics.sourceUnchanged,true);assert.equal(metrics.cleanupPassed,true);
    if(profile.distinctReports){
      assert.equal(metrics.rounds.length,0);assert.equal(metrics.hostHarnessSourceUnchanged,true);assert.equal(metrics.errorCoverage.length,8);
      assert.deepEqual(cleanup.exits.map(row=>row.role).sort(),['seeder','observer','api0','api1','api2','worker','generator'].sort());
      assert.ok(cleanup.exits.every(row=>row.clean===true&&row.exitCode===0&&row.oomKilled===false&&row.forced===false
        &&row.acknowledged===true&&row.expired===0&&row.unsettledAtExit===0));
      assert.deepEqual(verifyDistinctReceiptCustody(root,privateDirectory,metrics),metrics.distinctNativeCustody);
    }else{assert.equal(metrics.rounds.length,profile.rounds??1);assert.ok(metrics.rounds.every(round=>round.acceptance.passed));}
  }
  return {...metrics,verifiedReceiptManifestSha256:manifestSha256};
}
