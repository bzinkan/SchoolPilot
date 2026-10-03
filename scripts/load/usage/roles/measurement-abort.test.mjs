import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {waitForRelease,validateAbort} from './measurement-gate.mjs';
import {hash} from './patch-coordinator.mjs';
const source='a'.repeat(40),run='b'.repeat(12),nonce='c'.repeat(32);
const request=ready=>({...ready,action:'abort-before-measurement',intent:'preserve-prepared-snapshot'});
async function exercise(write){
  const directory=mkdtempSync(join(tmpdir(),'role-gate-abort-'));
  try{
    const bindingFile=join(directory,'binding.json');writeFileSync(bindingFile,JSON.stringify({applicationSource:source,schemaVersion:2,allowedModes:['diagnostic'],roleImageId:'sha256:'+'d'.repeat(64),harnessIdentity:'e'.repeat(64)}));
    let time=0;
    const promise=waitForRelease({output:directory,run,source,bindingFile,phase:'combined',nonce,now:()=>time,timeoutMs:100,sleep:async()=>{time++;await write(directory,JSON.parse(readFileSync(join(directory,'measurement-ready.json'))));}});
    return await write.result(promise,directory);
  }finally{assert.equal(dirname(directory),tmpdir());rmSync(directory,{recursive:true,force:true});}
}
test('exact owned snapshot abort preserves receipt and never releases measurement',async()=>{
  const write=(dir,ready)=>writeFileSync(join(dir,'measurement-abort.json'),JSON.stringify(request(ready)));
  write.result=async(promise,dir)=>{await assert.rejects(promise,{code:'ABORTED_BEFORE_MEASUREMENT'});const receipt=JSON.parse(readFileSync(join(dir,'measurement-abort-receipt.json')));assert.equal(receipt.abortSha256,hash(readFileSync(join(dir,'measurement-abort.json'))));assert.equal(receipt.measurementStarted,false);assert.equal(receipt.capacityAccepted,false);assert.equal(existsSync(join(dir,'measurement-release-receipt.json')),false);assert.equal(existsSync(join(dir,'measurement-go.json')),false);};
  await exercise(write);
});
for(const key of['nonce','run','source','imageId','bindingSha256','harnessSha256','profile','mode','phase','intent','action','schemaVersion','diagnosticOnly','capacityAccepted']){
  test('abort refuses changed '+key,async()=>{
    const write=(dir,ready)=>{const value=request(ready);validateAbort(ready,value);value[key]='changed';writeFileSync(join(dir,'measurement-abort.json'),JSON.stringify(value));};
    write.result=async(promise,dir)=>{await assert.rejects(promise);assert.equal(existsSync(join(dir,'measurement-abort-receipt.json')),false);assert.equal(existsSync(join(dir,'measurement-release-receipt.json')),false);};await exercise(write);
  });
}
test('go plus abort is ambiguous and preserves neither success receipt',async()=>{
  const write=(dir,ready)=>{writeFileSync(join(dir,'measurement-abort.json'),JSON.stringify(request(ready)));writeFileSync(join(dir,'measurement-go.json'),JSON.stringify({...ready,action:'release-role-measurement'}));};
  write.result=async(promise,dir)=>{await assert.rejects(promise,/AMBIGUOUS_MEASUREMENT_CONTROL/);for(const name of['measurement-abort-receipt.json','measurement-release-receipt.json'])assert.equal(existsSync(join(dir,name)),false);};await exercise(write);
});
test('changed binding after ready cannot authorize snapshot abort',async()=>{
  const write=(dir,ready)=>{writeFileSync(join(dir,'measurement-abort.json'),JSON.stringify(request(ready)));writeFileSync(join(dir,'binding.json'),'{}');};
  write.result=async(promise,dir)=>{await assert.rejects(promise);assert.equal(existsSync(join(dir,'measurement-abort-receipt.json')),false);};await exercise(write);
});
