import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash,loadBoundRun} from './receipt-loader.mjs';
import {RUN_RECORDS,collectRuntimeFacts,sealRunReceipts,writeImageEnvelopes} from './receipt-writer.mjs';
const source='a'.repeat(40),preloaderSha256='b'.repeat(64);
const roles=['api','worker','generator','coordinator'];
const row=role=>({role,source,preloaderSha256,stage:'startup',diagnosticOnly:true,capacityAccepted:false});
test('runtime collector retains actual diagnostic flags and ignores unrelated content',()=>{const logs=Object.fromEntries(roles.map(role=>[role,'unrelated payload must never enter receipt\nUSAGE_ROLE_RUNTIME '+JSON.stringify(row(role))+'\n']));const result=collectRuntimeFacts(logs,{source,preloaderSha256});assert.deepEqual(result,Object.fromEntries(roles.map(role=>[role,[row(role)]])));for(const mutate of [r=>r.source='c'.repeat(40),r=>r.preloaderSha256='d'.repeat(64),r=>r.role='other',r=>r.stage='request_payload']){const bad=structuredClone(logs),r=row('api');mutate(r);bad.api='USAGE_ROLE_RUNTIME '+JSON.stringify(r);assert.throws(()=>collectRuntimeFacts(bad,{source,preloaderSha256}));}assert.throws(()=>collectRuntimeFacts({...logs,api:logs.api+logs.api},{source,preloaderSha256}));});
function rawDirectory(){const dir=mkdtempSync(join(tmpdir(),'schoolpilot-role-receipts-'));for(const [name,file]of Object.entries(RUN_RECORDS))writeFileSync(join(dir,file),JSON.stringify({owner:name,diagnosticOnly:true,capacityAccepted:false})+'\n');return{dir,planHash:hash(readFileSync(join(dir,RUN_RECORDS.plan)))};}
test('sealing binds every exact raw receipt without accepting a diagnostic',()=>{const {dir,planHash}=rawDirectory();try{const result=sealRunReceipts(dir,planHash);assert.equal(result.bundle.metrics.diagnosticOnly,true);assert.equal(result.bundle.metrics.capacityAccepted,false);assert.equal(Object.keys(result.bundle).length,14);assert.throws(()=>sealRunReceipts(dir,planHash));writeFileSync(join(dir,RUN_RECORDS.metrics),'{}');assert.throws(()=>loadBoundRun(dir,result.receiptManifestSha256,planHash));}finally{rmSync(dir,{recursive:true,force:true});}});
for(const mode of ['missing','plan-mismatch','malformed'])test(`receipt seal rejects ${mode} without a success manifest`,()=>{const {dir,planHash}=rawDirectory();try{if(mode==='missing')unlinkSync(join(dir,RUN_RECORDS.cleanup));if(mode==='malformed')writeFileSync(join(dir,RUN_RECORDS.database),'{broken');assert.throws(()=>sealRunReceipts(dir,mode==='plan-mismatch'?'c'.repeat(64):planHash));assert.throws(()=>readFileSync(join(dir,'receipt-manifest.json')));}finally{rmSync(dir,{recursive:true,force:true});}});
test('image envelopes retain exact scan/preparation/binding bytes and cannot relabel allowed modes',()=>{const dir=mkdtempSync(join(tmpdir(),'schoolpilot-role-images-'));try{
  const write=(name,value)=>{const path=join(dir,name);writeFileSync(path,JSON.stringify(value,null,2)+'\n');return path;};
  const digest='sha256:'+'1'.repeat(64),config='sha256:'+'2'.repeat(64),runtime='3'.repeat(64);
  const scanFile=write('scan.json',{sourceSha:source,imageId:digest,configDigest:config,passed:false}),scanRaw=readFileSync(scanFile,'utf8');
  const candidatePreparationFile=write('preparation.json',{source,image:{indexDigest:digest,configDigest:config},scan:{receiptPath:scanFile,receiptSha256:hash(scanRaw)}});
  const bindingFile=write('binding.json',{applicationSource:source,candidateImageId:digest,candidateConfigDigest:config,candidateScanReceiptSha256:hash(scanRaw),runtimeSha256:runtime,allowedModes:['diagnostic']}),runtimeProofFile=write('proof.json',{runtimeSha256:runtime});
  const input={directory:dir,candidatePreparationFile,candidatePreparationSha256:hash(readFileSync(candidatePreparationFile)),bindingFile,bindingSha256:hash(readFileSync(bindingFile)),runtimeProofFile,runtimeProofSha256:hash(readFileSync(runtimeProofFile))};
  writeImageEnvelopes(input);const saved=JSON.parse(readFileSync(join(dir,RUN_RECORDS.candidate)));assert.equal(saved.scanRaw,scanRaw);assert.equal(saved.scan.passed,false);assert.deepEqual(JSON.parse(readFileSync(join(dir,RUN_RECORDS.runtime))).binding.allowedModes,['diagnostic']);assert.throws(()=>writeImageEnvelopes({...input,bindingSha256:'0'.repeat(64)}));
}finally{rmSync(dir,{recursive:true,force:true});}});
