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
export async function waitForRelease({output,run,source,bindingFile,phase,mode='diagnostic',nonce=randomUUID(),timeoutMs=900000,intervalMs=1000,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  assert.match(run,/^[a-f0-9]{12}$/);assert.match(source,/^[a-f0-9]{40}$/);assert.ok(['combined','ingest'].includes(phase));
  const bytes=readFileSync(bindingFile),binding=JSON.parse(bytes);assert.equal(binding.applicationSource,source);assert.equal(binding.schemaVersion,2);
  const execution=assertExecutionMode({mode,phase,cpuProfile:false});assert.ok(binding.allowedModes.includes(mode));
  assert.match(nonce,/^[a-f0-9-]{32,64}$/);
  const ready={schemaVersion:2,run,source,imageId:binding.roleImageId,bindingSha256:hash(bytes),profile:PROFILE,mode,phase,nonce,diagnosticOnly:execution.diagnosticOnly,capacityAccepted:false,preparedAt:new Date().toISOString()};
  const go=resolve(output,'measurement-go.json');assert.equal(existsSync(go),false);
  writeFileSync(resolve(output,'measurement-ready.json'),JSON.stringify(ready,null,2)+'\n',{flag:'wx'});
  const start=now();while(now()-start<timeoutMs){if(existsSync(go)){
    const raw=readFileSync(go);validateRelease(ready,JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,'')));
    assert.equal(hash(readFileSync(bindingFile)),ready.bindingSha256);
    writeFileSync(resolve(output,'measurement-release-receipt.json'),JSON.stringify({...ready,releasedAt:new Date().toISOString(),releaseSha256:hash(raw)},null,2)+'\n',{flag:'wx'});return ready;
  }await sleep(intervalMs);}throw new Error('MEASUREMENT_RELEASE_EXPIRED');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const[output,run,source,bindingFile,phase]=process.argv.slice(2);await waitForRelease({output,run,source,bindingFile,phase});}
