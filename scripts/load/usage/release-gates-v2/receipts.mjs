import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { hash, profileFor, profileHash } from './contracts.mjs';
import { validateRound } from './validation.mjs';
import { classifyLog } from './measurements.mjs';
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
  assert.equal(metrics.profile,profile.name);assert.equal(metrics.contractSha256,profileHash(profile));
  assert.equal(metrics.source,manifest.source);assert.equal(metrics.run,manifest.run);assert.equal(metrics.planSha256,manifest.planSha256);
  for(const exit of cleanup.exits) {
    assert.equal(exit.run,metrics.run);assert.equal(exit.source,metrics.source);
    assert.deepEqual(exit,json(join(root,exit.role+'-exit.json')));
    const logs=readFileSync(join(privateDirectory,exit.role+'-log.private'),'utf8');assert.equal(hash(logs),exit.logsSha256);
    if(exit.role.startsWith('api')){
      const coverage=metrics.errorCoverage.find(row=>row.role===exit.role);assert.ok(coverage);
      const actual=classifyLog(logs,'api',{complete:exit.clean});
      for(const key of ['sha256','errorCount','complete','available','bytes']) assert.equal(coverage[key],actual[key]);
    }
  }
  const pgLog=readFileSync(join(privateDirectory,'postgres-log.private'),'utf8');
  const postgres=metrics.errorCoverage.find(row=>row.kind==='postgres');assert.equal(postgres.sha256,hash(pgLog));
  assert.equal(new Set(cleanup.exits.map(row=>row.containerId)).size,cleanup.exits.length);
  assert.equal(cleanup.confirmedAbsent,true);assert.equal(metrics.cleanupPassed,cleanup.cleanupPassed===true && json(join(root,manifest.records['postgres-cleanup.json']?'postgres-cleanup.json':'cleanup.json')).cleanupPassed===true);
  for(const round of metrics.rounds) assert.deepEqual(round.acceptance,validateRound(round,profile,{diagnostic:profile.kind==='diagnostic',baseline:metrics.arm==='A'}));
  if(metrics.runPassed) {assert.equal(metrics.rounds.length,profile.rounds??1);assert.equal(metrics.sourceUnchanged,true);assert.equal(metrics.cleanupPassed,true);assert.ok(metrics.rounds.every(round=>round.acceptance.passed));}
  return {...metrics,verifiedReceiptManifestSha256:manifestSha256};
}
