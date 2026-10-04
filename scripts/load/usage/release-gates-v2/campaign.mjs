import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { profileFor, profileHash, OLD_CONTRACT_SHA256, OLD_CLOSED_JOURNAL_SHA256, PROFILES, hash } from './contracts.mjs';
import { loadReceipt } from './receipts.mjs';
import { validatePairs, validateMixedRuns } from './validation.mjs';
const read=path=>JSON.parse(readFileSync(path,'utf8'));
export function declareCampaign(options) {
  const profile=profileFor(options.profile), directory=resolve(options.directory);
  assert.equal(existsSync(directory),false);assert.ok(['paired','mixed','usage','classroom','preparation'].includes(options.kind));
  if(options.kind!=='preparation')assert.equal(options.kind==='paired',['blackbox','diagnostic'].includes(profile.kind));
  assert.match(options.candidateSource,/^[a-f0-9]{40}$/);if(options.kind==='paired')assert.match(options.baselineSource,/^[a-f0-9]{40}$/);
  assert.match(options.observedFlagsSha256,/^[a-f0-9]{64}$/);mkdirSync(directory);
  const contract={schemaVersion:2,declaredAt:new Date().toISOString(),kind:options.kind,profile:profile.name,contractSha256:profileHash(profile),
    candidateSource:options.candidateSource,baselineSource:options.baselineSource??null,observedFlagsSha256:options.observedFlagsSha256,
    originalFailedContractSha256:OLD_CONTRACT_SHA256,order:options.kind==='preparation'?[options.arm||'C']:options.kind==='paired'?['A','A','A','B','B','A','A','B']:['C','C','C'].slice(0,options.kind==='classroom'?1:3),
    pairedReleaseComparisonRequired:options.kind==='usage',historicalSingleTaskDiagnosticOnly:true,capacityAccepted:false,productionReadiness:false};
  writeFileSync(join(directory,'contract.json'),JSON.stringify(contract,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(directory,'journal.json'),JSON.stringify({contractSha256:hash(readFileSync(join(directory,'contract.json'))),attempts:[],closed:false},null,2)+'\n',{flag:'wx'});
  return contract;
}
export function registerAttempt(options) {
  const directory=resolve(options.directory), contract=read(join(directory,'contract.json')), journal=read(join(directory,'journal.json'));
  assert.equal(journal.closed,false);assert.equal(journal.contractSha256,hash(readFileSync(join(directory,'contract.json'))));
  const index=journal.attempts.length-1;assert.ok(index>=0&&index<contract.order.length);assert.equal(journal.attempts[index].state,'reserved');
  const reservation=journal.attempts[index];assert.equal(resolve(options.receiptDirectory),reservation.receiptDirectory);
  let receipt, verificationFailure;
  try {
  receipt=loadReceipt(options.receiptDirectory,options.receiptManifestSha256,options.privateDirectory);
  assert.equal(receipt.profile,contract.profile);assert.equal(receipt.contractSha256,contract.contractSha256);
  assert.equal(receipt.arm,contract.order[index]);assert.equal(receipt.source,receipt.arm==='A'?contract.baselineSource:contract.candidateSource);
  assert.equal(receipt.observedFlagsSha256,contract.observedFlagsSha256);
  assert.equal(receipt.run,reservation.run);assert.equal(receipt.reservationSha256,reservation.reservationSha256);
  } catch { verificationFailure='RECEIPT_UNAVAILABLE_OR_INVALID'; receipt={run:reservation.run,source:reservation.source,profile:contract.profile,arm:reservation.arm,runPassed:false,cleanupPassed:false,verificationFailure}; }
  const previousJournalSha256=hash(readFileSync(join(directory,'journal.json')));
  const attempt={index,run:reservation.run,registeredAt:new Date().toISOString(),receiptDirectory:resolve(options.receiptDirectory),receiptManifestSha256:options.receiptManifestSha256,
    previousJournalSha256,receipt,state:'recorded',reservationSha256:reservation.reservationSha256};
  writeFileSync(join(directory,`attempt-${index+1}.json`),JSON.stringify(attempt,null,2)+'\n',{flag:'wx'});
  journal.attempts[index]=attempt;writeFileSync(join(directory,'journal.next'),JSON.stringify(journal,null,2)+'\n',{flag:'wx'});renameSync(join(directory,'journal.next'),join(directory,'journal.json'));
  return{index,runPassed:receipt.runPassed,preserved:true};
}
export function reserveAttempt(options) {
  const directory=resolve(options.directory),contract=read(join(directory,'contract.json')),journal=read(join(directory,'journal.json'));
  assert.equal(journal.closed,false);assert.equal(journal.contractSha256,hash(readFileSync(join(directory,'contract.json'))));
  assert.ok(journal.attempts.every(row=>row.state==='recorded'));const index=journal.attempts.length;assert.ok(index<contract.order.length);
  assert.match(options.run,/^[a-f0-9]{12}$/);assert.ok(!journal.attempts.some(row=>row.run===options.run));
  assert.equal(existsSync(options.receiptDirectory),false);assert.equal(existsSync(options.privateDirectory),false);
  const arm=contract.order[index],reservation={index,run:options.run,arm,source:arm==='A'?contract.baselineSource:contract.candidateSource,
    profile:contract.profile,contractSha256:contract.contractSha256,campaignContractSha256:journal.contractSha256,preparationSmoke:contract.kind==='preparation',
    observedFlagsSha256:contract.observedFlagsSha256,receiptDirectory:resolve(options.receiptDirectory),privateDirectory:resolve(options.privateDirectory),reservedAt:new Date().toISOString()};
  const file=join(directory,`reservation-${index+1}.json`);writeFileSync(file,JSON.stringify(reservation,null,2)+'\n',{flag:'wx'});
  const reservationSha256=hash(readFileSync(file));journal.attempts.push({...reservation,reservationSha256,state:'reserved'});
  writeFileSync(join(directory,'journal.next'),JSON.stringify(journal,null,2)+'\n',{flag:'wx'});renameSync(join(directory,'journal.next'),join(directory,'journal.json'));
  return{reservationFile:file,reservationSha256,run:options.run,arm,source:reservation.source};
}
export function verifyPairedClosure(input,{profile,candidateSource,observedFlagsSha256}){
  const directory=resolve(input.directory),closureBytes=readFileSync(join(directory,'closure.json'));
  assert.equal(hash(closureBytes),input.closureSha256);const closure=JSON.parse(closureBytes),contract=read(join(directory,'contract.json')),journal=read(join(directory,'journal.json'));
  assert.equal(contract.kind,'paired');assert.equal(contract.profile,profile.name);assert.equal(contract.candidateSource,candidateSource);
  assert.equal(contract.observedFlagsSha256,observedFlagsSha256);assert.equal(contract.contractSha256,profileHash(profile));
  assert.equal(closure.contractSha256,hash(readFileSync(join(directory,'contract.json'))));assert.equal(closure.journalSha256,hash(readFileSync(join(directory,'journal.json'))));
  assert.equal(journal.contractSha256,closure.contractSha256);assert.equal(journal.closed,true);assert.equal(closure.passed,true);
  assert.equal(journal.attempts.length,8);assert.equal(input.privateDirectories?.length,8);
  const records=journal.attempts.map((attempt,index)=>{assert.equal(attempt.state,'recorded');assert.ok(!attempt.receipt.verificationFailure);
    return loadReceipt(attempt.receiptDirectory,attempt.receiptManifestSha256,input.privateDirectories[index]);});
  const result=validatePairs(records,{profile,baselineSource:contract.baselineSource,candidateSource,observedFlagsSha256});assert.equal(result.passed,true);
  assert.deepEqual(closure.checks,result.checks);
  return{profile:profile.name,candidateSource,baselineSource:contract.baselineSource,closureSha256:input.closureSha256,passed:true};
}
export function verifyUsageComparisons(options,contract){
  assert.equal(options.pairedReleaseComparisons?.length,2);
  const comparisons=[PROFILES.sole,PROFILES.normal].map(profile=>{
    const matching=options.pairedReleaseComparisons.filter(input=>read(join(resolve(input.directory),'contract.json')).profile===profile.name);assert.equal(matching.length,1);
    return verifyPairedClosure(matching[0],{profile,candidateSource:contract.candidateSource,observedFlagsSha256:contract.observedFlagsSha256});
  });
  assert.equal(new Set(comparisons.map(row=>row.baselineSource)).size,1);
  assert.equal(options.preservedDiagnosticJournalSha256,OLD_CLOSED_JOURNAL_SHA256);
  assert.equal(hash(readFileSync(options.preservedDiagnosticJournalFile)),OLD_CLOSED_JOURNAL_SHA256);
  return{comparisons,historicalDiagnostic:{journalSha256:OLD_CLOSED_JOURNAL_SHA256,originalContractSha256:OLD_CONTRACT_SHA256,reinterpreted:false,activationGate:false}};
}
export function closeCampaign(options) {
  const directory=resolve(options.directory), contract=read(join(directory,'contract.json')), journal=read(join(directory,'journal.json'));
  assert.equal(journal.closed,false);assert.equal(journal.contractSha256,hash(readFileSync(join(directory,'contract.json'))));
  assert.equal(journal.attempts.length,contract.order.length);
  // Revalidate immutable original receipts before making any campaign claim.
  const records=journal.attempts.map((attempt,index)=>{assert.equal(attempt.state,'recorded');assert.deepEqual(attempt,read(join(directory,`attempt-${index+1}.json`)));
    if(attempt.receipt.verificationFailure)return attempt.receipt;
    return loadReceipt(attempt.receiptDirectory,attempt.receiptManifestSha256,options.privateDirectories[index]);});
  let result;
  if(records.some(row=>row.verificationFailure)) result={passed:false,disposition:'failed-attempts-preserved',capacityAccepted:false};
  else if(contract.kind==='paired'&&contract.profile!==PROFILES.overload.name) result=validatePairs(records,{profile:profileFor(contract.profile),baselineSource:contract.baselineSource,candidateSource:contract.candidateSource,observedFlagsSha256:contract.observedFlagsSha256});
  else if(contract.kind==='mixed') result=validateMixedRuns(records);
  else if(contract.kind==='usage') {
    const evidence=verifyUsageComparisons(options,contract);
    result={passed:records.every(record=>record.runPassed&&record.cleanupPassed&&record.sourceUnchanged)&&new Set(records.map(record=>record.schemaSha256)).size===1,
      ...evidence,capacityAccepted:false};
  } else if(contract.kind==='paired') {
    result={passed:false,diagnosticOnly:true,recordsComplete:records.length===8,
      safetyAndRecoveryPassed:records.every(record=>record.cleanupPassed&&record.sourceUnchanged&&record.rounds.every(round=>round.persistence?.passed&&round.drains.every(drain=>drain.complete))),capacityAccepted:false};
  } else result={passed:records.length===1&&(contract.kind==='preparation'?records[0].smokePassed:records[0].runPassed),preparationOnly:contract.kind==='preparation',capacityAccepted:false};
  journal.closed=true;journal.result=result;writeFileSync(join(directory,'journal.next'),JSON.stringify(journal,null,2)+'\n',{flag:'wx'});renameSync(join(directory,'journal.next'),join(directory,'journal.json'));
  writeFileSync(join(directory,'closure.json'),JSON.stringify({contractSha256:journal.contractSha256,journalSha256:hash(readFileSync(join(directory,'journal.json'))),...result,productionReadiness:false},null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const operations={declare:declareCampaign,reserve:reserveAttempt,register:registerAttempt,close:closeCampaign};assert.ok(operations[process.argv[2]]);const result=operations[process.argv[2]](read(process.argv[3]));process.stdout.write(JSON.stringify(result)+'\n');}catch{process.stderr.write('V2_CAMPAIGN_OPERATION_FAILED\n');process.exitCode=1;}}
