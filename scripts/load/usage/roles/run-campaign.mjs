import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {createCampaign,registerAttempt,finishAttempt,closeJournal,closeCampaign} from './campaign-journal.mjs';
import {runRestoredRoleScale} from './run-restored-role-scale.mjs';
import {hash,loadBoundRun} from './receipt-loader.mjs';
import {validateCandidateRun} from './campaign-validation.mjs';

const read=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));

// One invocation owns exactly one pre-registered attempt. It never releases its
// measurement gate, retries a failure, or selects successful historical runs.
export async function runCampaignAttempt(options,{runOwner=runRestoredRoleScale}={}){
  assert.equal(options.mode,'capacity-candidate');assert.equal(options.phase,'combined');
  const run=options.run??randomBytes(6).toString('hex'),nonce=randomUUID();
  const registration=registerAttempt(options.campaignDirectory,{trustedCampaignSha256:options.trustedCampaignSha256,run,nonce,source:options.source,outputDirectory:options.evidenceDirectory});
  let result,failure;
  try{result=await runOwner({...options,run,registrationSha256:registration.registrationSha256});assert.equal(result.run,run);assert.ok([0,1].includes(result.exitCode));}
  catch(error){failure=error?.name==='AbortError'?'CANDIDATE_ATTEMPT_ABORTED':'CANDIDATE_ATTEMPT_FAILED';}
  const cleanupPath=join(options.evidenceDirectory,'all-owned-role-fixtures-cleanup.json');
  let cleanupRaw,cleanup;
  try{cleanupRaw=readFileSync(cleanupPath,'utf8');cleanup=JSON.parse(cleanupRaw);assert.equal(cleanup.run,run);assert.equal(typeof cleanup.cleanupPassed,'boolean');assert.ok(Number.isFinite(Date.parse(cleanup.finishedAt)));}
  catch{cleanup={run,finishedAt:new Date().toISOString(),cleanupPassed:false,failureCode:'OWNER_CLEANUP_UNCONFIRMED',...(cleanupRaw?{originalReceiptSha256:hash(cleanupRaw)}:{})};cleanupRaw=JSON.stringify(cleanup);}
  const manifestPath=join(options.evidenceDirectory,'receipt-manifest.json');
  let loaded,receiptManifestSha256;
  if(existsSync(manifestPath)){
    receiptManifestSha256=hash(readFileSync(manifestPath));
    try{loaded=loadBoundRun(options.evidenceDirectory,receiptManifestSha256,registration.planSha256);}
    catch{failure='CANDIDATE_RECEIPTS_UNCONFIRMED';}
  }
  if(loaded&&result&&loaded.bundle.execution.exitCode!==result.exitCode)failure='CANDIDATE_OWNER_EXIT_MISMATCH';
  const status=!failure&&loaded&&cleanup.cleanupPassed===true?'completed':failure==='CANDIDATE_ATTEMPT_ABORTED'?'aborted':existsSync(join(options.evidenceDirectory,'measurement-release-receipt.json'))?'run-failed':'setup-failed';
  const entry=finishAttempt(options.campaignDirectory,{trustedCampaignSha256:options.trustedCampaignSha256,registrationSha256:registration.registrationSha256,status,cleanupRaw,
    ...(loaded?{receiptManifestSha256}:{}),...(status==='completed'?{}:{failureCode:failure??'CANDIDATE_ATTEMPT_INCOMPLETE'})});
  const checked=loaded?validateCandidateRun(loaded.bundle,registration.planSha256):{runPassed:false};
  return{run,entry,attemptPassed:status==='completed'&&checked.runPassed===true&&result?.exitCode===0,exitCode:status==='completed'&&checked.runPassed===true&&result?.exitCode===0?0:1,capacityAccepted:false};
}

export async function campaignCommand(command,configuration){
  if(command==='declare')return createCampaign(configuration.campaignDirectory,configuration.declaration);
  if(command==='attempt')return runCampaignAttempt(configuration);
  if(command==='close-journal')return closeJournal(configuration.campaignDirectory,{trustedCampaignSha256:configuration.trustedCampaignSha256});
  if(command==='close')return closeCampaign(configuration.campaignDirectory,{trustedCampaignSha256:configuration.trustedCampaignSha256,trustedJournalSha256:configuration.trustedJournalSha256,comparisonRaw:readFileSync(configuration.comparisonFile,'utf8')});
  throw Error('UNKNOWN_CAMPAIGN_COMMAND');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{const result=await campaignCommand(process.argv[2],read(process.argv[3]));process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.exitCode??0;}
  catch{process.stderr.write('CAMPAIGN_OPERATION_FAILED; immutable registrations and owner receipts retained\n');process.exitCode=1;}
}
