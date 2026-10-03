import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,statSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {hash,loadBoundRun} from './receipt-loader.mjs';

export const RUN_RECORDS=Object.freeze({plan:'run-plan.json',metrics:'usage-scale.json',preparation:'preparation-receipt.json',cold:'cold-restart-receipt.json',gate:'measurement-release-receipt.json',execution:'execution.json',final:'final-source-receipt.json',candidate:'candidate-receipt.json',runtime:'runtime-receipt.json',roles:'role-host-result.json',cleanup:'all-owned-role-fixtures-cleanup.json',database:'database-receipt.json',runtimeFlags:'runtime-flags.json'});
const roles=['api','worker','generator','coordinator'];
const sha=value=>assert.match(value,/^[a-f0-9]{64}$/);
const read=(path,maximum=4*1024**2)=>{const stat=statSync(path);assert.ok(stat.isFile()&&stat.size>0&&stat.size<=maximum);return readFileSync(path);};
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});

export function collectRuntimeFacts(logs,{source,preloaderSha256}){
  sha(preloaderSha256);assert.match(source,/^[a-f0-9]{40}$/);assert.deepEqual(Object.keys(logs).sort(),[...roles].sort());
  return Object.fromEntries(roles.map(role=>{
    assert.equal(typeof logs[role],'string');
    const rows=logs[role].split(/\r?\n/).filter(line=>line.startsWith('USAGE_ROLE_RUNTIME ')).map(line=>JSON.parse(line.slice('USAGE_ROLE_RUNTIME '.length)));
    assert.ok(rows.length>0&&rows.length<=8);const stages=new Set();
    for(const row of rows){assert.equal(row.role,role);assert.equal(row.source,source);assert.equal(row.preloaderSha256,preloaderSha256);assert.ok(!stages.has(row.stage));stages.add(row.stage);assert.ok(['startup','phase_reset','phase_snapshot','phase_start','shutdown','exit'].includes(row.stage));}
    return[role,rows];
  }));
}

// These envelopes preserve the exact raw owner receipts. They do not manufacture
// success booleans or convert a diagnostic binding into a candidate binding.
export function writeImageEnvelopes({directory,candidatePreparationFile,candidatePreparationSha256,bindingFile,bindingSha256,runtimeProofFile,runtimeProofSha256}){
  for(const expected of [candidatePreparationSha256,bindingSha256,runtimeProofSha256])sha(expected);
  const candidateRaw=read(candidatePreparationFile).toString('utf8'),bindingRaw=read(bindingFile).toString('utf8'),proofRaw=read(runtimeProofFile).toString('utf8');
  assert.equal(hash(candidateRaw),candidatePreparationSha256);assert.equal(hash(bindingRaw),bindingSha256);assert.equal(hash(proofRaw),runtimeProofSha256);
  const candidate=JSON.parse(candidateRaw),binding=JSON.parse(bindingRaw),proof=JSON.parse(proofRaw),scanRaw=read(candidate.scan.receiptPath).toString('utf8'),scan=JSON.parse(scanRaw);
  assert.equal(hash(scanRaw),candidate.scan.receiptSha256);assert.equal(binding.candidateScanReceiptSha256,hash(scanRaw));
  assert.equal(candidate.source,binding.applicationSource);assert.equal(scan.sourceSha,binding.applicationSource);
  assert.equal(scan.imageId,candidate.image.indexDigest);assert.equal(scan.configDigest,candidate.image.configDigest);
  assert.equal(binding.candidateImageId,candidate.image.indexDigest);assert.equal(binding.candidateConfigDigest,candidate.image.configDigest);
  assert.equal(proof.runtimeSha256,binding.runtimeSha256);
  write(join(directory,RUN_RECORDS.candidate),{scanRaw,scan,image:candidate.image,preparationRaw:candidateRaw,preparation:candidate,preparationSha256:candidatePreparationSha256});
  write(join(directory,RUN_RECORDS.runtime),{bindingRaw,binding,proofRaw,proof,proofSha256:runtimeProofSha256});
}

export function writeRuntimeFacts(directory,expected){
  const logs=Object.fromEntries(roles.map(role=>[role,read(join(directory,role+'.log'),64*1024**2).toString('utf8')]));
  const facts=collectRuntimeFacts(logs,expected);write(join(directory,RUN_RECORDS.runtimeFlags),facts);return facts;
}

// Called only after all owners have finished and emitted their own receipts.
// Missing/failed receipts are retained as failure; no replacement defaults.
export function sealRunReceipts(directory,trustedPlanSha256){
  sha(trustedPlanSha256);const root=realpathSync(directory),records={};
  assert.equal(existsSync(join(root,'receipt-manifest.json')),false);
  for(const [name,file]of Object.entries(RUN_RECORDS)){
    const path=realpathSync(resolve(root,file)),rel=relative(root,path);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    const raw=read(path,name==='metrics'?64*1024**2:4*1024**2);JSON.parse(raw);
    records[name]={file,sha256:hash(raw)};
  }
  assert.equal(records.plan.sha256,trustedPlanSha256);
  const raw=JSON.stringify({schemaVersion:2,records},null,2)+'\n';
  writeFileSync(join(root,'receipt-manifest.json'),raw,{flag:'wx'});
  return loadBoundRun(root,hash(raw),trustedPlanSha256);
}
