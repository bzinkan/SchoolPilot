import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPACITY_SOURCE_FILES, captureCapacitySourceIdentity, verifyCapacitySourceIdentity } from '../scripts/load/paperwork/runner-provenance.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(run) {
  const root=mkdtempSync(join(tmpdir(),'schoolpilot-capacity-source-'));
  const app=join(root,'app'),tool=join(root,'tool'),external=join(root,'external');
  const commit=directory=>{git(directory,'add','.');git(directory,'-c','user.name=Capacity Test','-c','user.email=capacity@example.test','commit','-m','Synthetic source');return git(directory,'rev-parse','HEAD');};
  try {
    for(const directory of [app,tool]) {
      mkdirSync(directory);git(directory,'init','--initial-branch=main');git(directory,'config','core.autocrlf','false');
      writeFileSync(join(directory,'identity.txt'),directory===app?'application\n':'measurement tools\n');
    }
    const source=join(tool,'scripts/load/paperwork');mkdirSync(source,{recursive:true});mkdirSync(external);
    for(const file of CAPACITY_SOURCE_FILES) {
      writeFileSync(join(source,file),'// synthetic '+file+'\n');writeFileSync(join(external,file),'// external '+file+'\n');
    }
    const appSha=commit(app),toolSha=commit(tool),runner=join(source,'run-split.ps1');
    run({root,app,tool,external,source,appSha,toolSha,runner,commit});
  } finally { rmSync(root,{recursive:true,force:true}); }
}
const capture=f=>captureCapacitySourceIdentity({applicationRepositoryRoot:f.app,expectedApplicationRevision:f.appSha,runnerPath:f.runner});

test('capacity proof binds distinct clean application and canonical tracked tool commits',()=>fixture(f=>{
  const proof=capture(f);assert.equal(proof.repositoryRevision,f.appSha);assert.equal(proof.harnessRevision,f.toolSha);
  assert.notEqual(f.appSha,f.toolSha);assert.equal(proof.harnessSource,'reviewed_repository');
  assert.equal(proof.harnessRepositoryRoot,f.tool);assert.deepEqual(Object.keys(proof.files),CAPACITY_SOURCE_FILES);
  assert.equal(proof.runnerSourceSha256,proof.files['run-split.ps1'].sha256);assert.deepEqual(verifyCapacitySourceIdentity(proof),proof);
}));
test('same clean checkout remains compatible without fabricating a second identity',()=>fixture(f=>{
  const proof=captureCapacitySourceIdentity({applicationRepositoryRoot:f.tool,expectedApplicationRevision:f.toolSha,runnerPath:f.runner});
  assert.equal(proof.repositoryRevision,proof.harnessRevision);assert.equal(proof.repositoryRoot,proof.harnessRepositoryRoot);
}));
test('external scripts retain hashes but cannot acquire canonical tool identity from the application root',()=>fixture(f=>{
  const proof=captureCapacitySourceIdentity({applicationRepositoryRoot:f.app,expectedApplicationRevision:f.appSha,runnerPath:join(f.external,'run-split.ps1')});
  assert.equal(proof.harnessRevision,null);assert.equal(proof.harnessRepositoryRoot,null);assert.equal(proof.harnessSource,'external_diagnostic');
  assert.equal(Object.keys(proof.files).length,CAPACITY_SOURCE_FILES.length);
}));
test('wrong application revision and a nested application path are rejected',()=>fixture(f=>{
  assert.throws(()=>captureCapacitySourceIdentity({applicationRepositoryRoot:f.app,expectedApplicationRevision:f.toolSha,runnerPath:f.runner}));
  assert.throws(()=>captureCapacitySourceIdentity({applicationRepositoryRoot:f.source,expectedApplicationRevision:f.toolSha,runnerPath:f.runner}));
}));
for(const owner of ['app','tool']) test(`dirty ${owner} source cannot be frozen`,()=>fixture(f=>{
  writeFileSync(join(f[owner],'unreviewed.txt'),'unreviewed');assert.throws(()=>capture(f),/SOURCE_CHECKOUT_DIRTY/);
}));
test('untracked and missing canonical helpers cannot pass a clean-looking source proof',()=>fixture(f=>{
  git(f.tool,'rm','--cached','scripts/load/paperwork/latency-metrics.mjs');
  writeFileSync(join(f.tool,'.gitignore'),'scripts/load/paperwork/latency-metrics.mjs\n');f.commit(f.tool);
  assert.throws(()=>capture(f));rmSync(join(f.source,'latency-metrics.mjs'));assert.throws(()=>capture(f));
}));
for(const owner of ['app','tool']) test(`committed ${owner} source movement invalidates the after-run proof`,()=>fixture(f=>{
  const proof=capture(f);writeFileSync(join(f[owner],'identity.txt'),'new reviewed commit\n');f.commit(f[owner]);
  assert.throws(()=>verifyCapacitySourceIdentity(proof));
}));
test('editing a helper after capture fails even when application source is unchanged',()=>fixture(f=>{
  const proof=capture(f);writeFileSync(join(f.source,'latency-metrics.mjs'),'changed\n');assert.throws(()=>verifyCapacitySourceIdentity(proof));
}));
test('tampered source hashes and swapped identities cannot verify against real checkouts',()=>fixture(f=>{
  const proof=capture(f),hash=structuredClone(proof);hash.files['split.test.mjs'].sha256='0'.repeat(64);
  assert.throws(()=>verifyCapacitySourceIdentity(hash));
  const swapped=structuredClone(proof);swapped.repositoryRoot=f.tool;swapped.repositoryRevision=f.toolSha;
  swapped.harnessRepositoryRoot=f.app;swapped.harnessRevision=f.appSha;
  assert.throws(()=>verifyCapacitySourceIdentity(swapped));
}));
