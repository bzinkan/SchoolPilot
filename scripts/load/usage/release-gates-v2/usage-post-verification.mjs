import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {PROFILES,profileHash,hash} from './contracts.mjs';
import {verifyClassroomBindings} from './lifecycle-audience.mjs';

// Additional custody is declared independently. The original Usage workload
// and profile hash remain unchanged, as do all archived receipts.
export const USAGE_POST_VERIFICATION_CONTRACT=Object.freeze({
  schemaVersion:1,name:'release297-usage-post-load-native-classroom-v1',
  originalProfile:PROFILES.usage.name,originalProfileSha256:profileHash(PROFILES.usage),
  oracle:'durable-delivery-relational-lifecycle-v1',stage:'after-original-usage-correctness-before-role-cleanup',
  schoolIndices:Object.freeze([0,1]),repetitions:1,commands:8,privateMessages:4,
  extraMeasuredOffers:0,originalMeasuredWorkloadUnchanged:true,
});
export const usagePostVerificationHash=()=>hash(JSON.stringify(USAGE_POST_VERIFICATION_CONTRACT));
export function assertUsagePostVerificationBinding(value,profile=PROFILES.usage){
  assert.equal(profile.name,PROFILES.usage.name,'Usage post-verification is bound to the frozen original Usage profile');
  assert.equal(value,usagePostVerificationHash(),'Unknown Usage post-verification contract');
  return value;
}
export function assertUsagePostVerificationReservation(reservation,options,profile=PROFILES.usage){
  assert.equal(reservation.usagePostVerificationContractSha256,options.usagePostVerificationContractSha256,'Declared Usage post-verification cannot be omitted or rebound');
  if(options.usagePostVerificationContractSha256){
    assertUsagePostVerificationBinding(options.usagePostVerificationContractSha256,profile);
    assert.equal(reservation.hostHarnessSource,options.hostHarnessSource);assert.match(options.hostHarnessSource,/^[a-f0-9]{40}$/);
    return true;
  }
  return false;
}
export function assertUsagePostVerificationReceiptBinding(contract,receipt){
  assert.equal(receipt.usagePostVerificationContractSha256,contract.usagePostVerificationContractSha256,'Campaign requires its declared Usage post-verification');
  if(contract.usagePostVerificationContractSha256){
    assertUsagePostVerificationBinding(contract.usagePostVerificationContractSha256);
    assert.equal(receipt.hostHarnessSource,contract.hostHarnessSource);
    if(receipt.runPassed)assertUsagePostVerificationEvidence(receipt);
  }
  return true;
}
export function assertUsagePostVerificationEvidence(metrics){
  if(metrics.usagePostVerificationContractSha256===undefined)return null;
  assertUsagePostVerificationBinding(metrics.usagePostVerificationContractSha256);
  const evidence=metrics.usagePostVerification;
  assert.equal(evidence?.schemaVersion,1);assert.equal(evidence.contractSha256,metrics.usagePostVerificationContractSha256);
  for(const key of ['run','source','helperImage','hostHarnessSource'])assert.equal(evidence[key],metrics[key]);
  assert.match(metrics.hostHarnessSource,/^[a-f0-9]{40}$/);
  assert.equal(evidence.originalProfileSha256,metrics.contractSha256);
  assert.equal(evidence.originalProfileSha256,USAGE_POST_VERIFICATION_CONTRACT.originalProfileSha256);
  assert.equal(evidence.extraMeasuredOffers,0);assert.equal(evidence.originalMeasuredWorkloadUnchanged,true);
  assert.equal(evidence.passed,true);assert.match(evidence.fixtureSha256,/^[a-f0-9]{64}$/);
  const native=evidence.classroomBindings;
  assert.equal(native?.passed,true);assert.deepEqual(native.declaredSchoolIndices,[0,1]);
  assert.equal(native.repetitions,1);assert.equal(native.observedCommands,8);assert.equal(native.expectedCommands,8);
  assert.equal(native.observedMessages,4);assert.equal(native.expectedMessages,4);
  assert.equal(native.commandTargetsChecked,8);assert.equal(native.privateBindingsChecked,4);assert.equal(native.exactRecipientOnly,true);
  assert.match(native.nativeRowsSha256,/^[a-f0-9]{64}$/);
  return evidence;
}
export async function verifyUsageClassroomAfterLoad({observer,fixture,metrics,save}){
  assertUsagePostVerificationBinding(metrics.usagePostVerificationContractSha256);
  let classroomBindings;
  try{classroomBindings=await observer.rpc('correctness',{classroom:true});}
  catch(error){
    if(error.classroomOracleFailure){metrics.usagePostVerificationFailure=error.classroomOracleFailure;save('usage-classroom-post-verification-failure.json',error.classroomOracleFailure);}
    throw error;
  }
  const evidence={schemaVersion:1,contractSha256:metrics.usagePostVerificationContractSha256,
    originalProfileSha256:metrics.contractSha256,run:metrics.run,source:metrics.source,helperImage:metrics.helperImage,hostHarnessSource:metrics.hostHarnessSource,
    fixtureSha256:hash(JSON.stringify(fixture)),extraMeasuredOffers:0,originalMeasuredWorkloadUnchanged:true,
    classroomBindings,passed:classroomBindings.passed===true};
  metrics.usagePostVerification=evidence;
  save('usage-classroom-post-verification.json',evidence);
  assertUsagePostVerificationEvidence(metrics);
  return evidence;
}
const contained=(root,path)=>{
  const file=realpathSync(path),rel=relative(root,file);
  assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'),'Usage post-verification proof escaped its custody root');
  return file;
};
export function verifyUsagePostVerificationCustody(receiptDirectory,privateDirectory,metrics){
  const evidence=assertUsagePostVerificationEvidence(metrics);if(!evidence)return null;
  const receiptRoot=realpathSync(receiptDirectory),privateRoot=realpathSync(privateDirectory);
  const recorded=JSON.parse(readFileSync(contained(receiptRoot,join(receiptRoot,'usage-classroom-post-verification.json')),'utf8'));
  assert.deepEqual(recorded,evidence);
  const nativeBytes=readFileSync(contained(privateRoot,join(privateRoot,'observer','classroom-bindings.private.json')));
  assert.equal(hash(nativeBytes),evidence.classroomBindings.nativeRowsSha256);
  const fixture=JSON.parse(readFileSync(contained(privateRoot,join(privateRoot,'observer','response-1.json')),'utf8')).value;
  assert.equal(hash(JSON.stringify(fixture)),evidence.fixtureSha256);
  const actual=verifyClassroomBindings({...JSON.parse(nativeBytes),fixture,profile:PROFILES.usage});
  assert.deepEqual({...actual,nativeRowsSha256:hash(nativeBytes)},evidence.classroomBindings);
  return{verified:true,contractSha256:evidence.contractSha256,nativeRowsSha256:hash(nativeBytes)};
}
export function assertUsagePostVerificationSet(records,declaredSha256){
  assertUsagePostVerificationBinding(declaredSha256);assert.equal(records.length,3);
  for(const record of records){assert.equal(record.usagePostVerificationContractSha256,declaredSha256);assertUsagePostVerificationEvidence(record);}
  for(const record of records)assert.equal(record.hostHarnessSourceUnchanged,true);
  for(const key of ['source','applicationImage','schemaSha256','harnessSource','helperImage','hostHarnessSource'])assert.equal(new Set(records.map(row=>row[key])).size,1);
  return{passed:true,contractSha256:declaredSha256,extraMeasuredOffers:0};
}
