import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hash} from './patch-coordinator.mjs';
import {PROFILE,assertExecutionMode} from './profile.mjs';
export function validateRelease(ready,release){
  assert.equal(ready.schemaVersion,2);assert.equal(release.schemaVersion,2);assert.equal(release.action,'release-role-measurement');
  for(const key of['nonce','run','source','imageId','bindingSha256','profile','mode','phase'])assert.equal(release[key],ready[key],key);
  const execution=assertExecutionMode({mode:ready.mode,phase:ready.phase,cpuProfile:false});
  assert.equal(release.diagnosticOnly,execution.diagnosticOnly);assert.equal(release.capacityAccepted,false);
}
export function validateAbort(ready,abort){
  assert.equal(ready.schemaVersion,2);assert.equal(abort.schemaVersion,2);
  assert.equal(abort.action,'abort-before-measurement');assert.equal(abort.intent,'preserve-prepared-snapshot');
  for(const key of['nonce','run','source','imageId','bindingSha256','harnessSha256','profile','mode','phase'])assert.equal(abort[key],ready[key],key);
  assert.match(ready.harnessSha256,/^[a-f0-9]{64}$/);
  const execution=assertExecutionMode({mode:ready.mode,phase:ready.phase,cpuProfile:false});
  assert.equal(abort.diagnosticOnly,execution.diagnosticOnly);assert.equal(abort.capacityAccepted,false);
}
export async function waitForRelease({output,run,source,bindingFile,phase,mode='diagnostic',nonce=randomUUID(),timeoutMs=900000,intervalMs=1000,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  assert.match(run,/^[a-f0-9]{12}$/);assert.match(source,/^[a-f0-9]{40}$/);assert.ok(['combined','ingest'].includes(phase));
  const bytes=readFileSync(bindingFile),binding=JSON.parse(bytes);assert.equal(binding.applicationSource,source);assert.equal(binding.schemaVersion,2);
  const execution=assertExecutionMode({mode,phase,cpuProfile:false});assert.ok(binding.allowedModes.includes(mode));
  assert.match(nonce,/^[a-f0-9-]{32,64}$/);
  assert.match(binding.harnessIdentity,/^[a-f0-9]{64}$/);
  const ready={schemaVersion:2,run,source,imageId:binding.roleImageId,bindingSha256:hash(bytes),harnessSha256:binding.harnessIdentity,profile:PROFILE,mode,phase,nonce,diagnosticOnly:execution.diagnosticOnly,capacityAccepted:false,preparedAt:new Date().toISOString()};
  const go=resolve(output,'measurement-go.json'),abort=resolve(output,'measurement-abort.json');
  assert.equal(existsSync(go),false);assert.equal(existsSync(abort),false);
  writeFileSync(resolve(output,'measurement-ready.json'),JSON.stringify(ready,null,2)+'\n',{flag:'wx'});
  const start=now();while(now()-start<timeoutMs){
    assert.ok(!(existsSync(go)&&existsSync(abort)),'AMBIGUOUS_MEASUREMENT_CONTROL');
    if(existsSync(abort)){
      const raw=readFileSync(abort),request=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));validateAbort(ready,request);
      assert.equal(hash(readFileSync(bindingFile)),ready.bindingSha256);assert.equal(existsSync(go),false,'AMBIGUOUS_MEASUREMENT_CONTROL');
      writeFileSync(resolve(output,'measurement-abort-receipt.json'),JSON.stringify({...ready,intent:request.intent,abortedAt:new Date().toISOString(),abortSha256:hash(raw),measurementStarted:false,code:'ABORTED_BEFORE_MEASUREMENT'},null,2)+'\n',{flag:'wx'});
      throw Object.assign(new Error('ABORTED_BEFORE_MEASUREMENT'),{code:'ABORTED_BEFORE_MEASUREMENT'});
    }
    if(existsSync(go)){
    const raw=readFileSync(go);validateRelease(ready,JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,'')));
    assert.equal(hash(readFileSync(bindingFile)),ready.bindingSha256);assert.equal(existsSync(abort),false,'AMBIGUOUS_MEASUREMENT_CONTROL');
    writeFileSync(resolve(output,'measurement-release-receipt.json'),JSON.stringify({...ready,releasedAt:new Date().toISOString(),releaseSha256:hash(raw)},null,2)+'\n',{flag:'wx'});return ready;
  }await sleep(intervalMs);}throw new Error('MEASUREMENT_RELEASE_EXPIRED');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const[output,run,source,bindingFile,phase]=process.argv.slice(2);await waitForRelease({output,run,source,bindingFile,phase});}
