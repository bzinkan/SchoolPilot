import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {profileHash,hash} from './contracts.mjs';
import {LOWER_LEVELS,LOWER_CONTRACT,lowerContractHash,assertLowerConfirmation,lowerHeadroom,assertLowerRun} from './lower-load.mjs';
import {loadReceipt} from './receipts.mjs';
import {runV2} from './run.mjs';
import {remapObservedEnvironment} from './environment.mjs';

const read=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const save=(directory,name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const git=(directory,args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',windowsHide:true}).trim();
export function lowerScreenDisposition(record){
  const checks=record.rounds?.[0]?.acceptance?.checks;
  const safe=record.cleanupPassed===true&&record.sourceUnchanged===true&&record.hostHarnessSourceUnchanged===true
    &&record.lowerAcquisitionLogEvidence?.passed===true
    &&record.expectedNegativeLogCoverage===true&&record.errorCoverage?.length>1&&record.errorCoverage.every(row=>row.complete&&row.available&&row.errorCount===0)
    &&record.rounds?.length===1&&record.postLowerRlsVerification?.passed===true&&checks
    &&Object.entries(checks).filter(([key])=>!['cpuBound','latency'].includes(key)).every(([,value])=>value===true);
  if(!safe)return{continueUpward:false,fatal:true,reason:'SAFETY_OR_UNCLASSIFIED_FAILURE'};
  if(record.runPassed!==true){
    const capacityOnly=record.failure==='V2_NUMERICAL_ACCEPTANCE_FAILED'&&(checks.cpuBound===false||checks.latency===false);
    return{continueUpward:false,fatal:!capacityOnly,reason:capacityOnly?'CPU_OR_LATENCY_CUTOFF':'SAFETY_OR_UNCLASSIFIED_FAILURE'};
  }
  if(!lowerHeadroom(record))return{continueUpward:false,reason:'HEADROOM_LOST'};
  return{continueUpward:true,reason:'HEADROOM_RETAINED'};
}
export function assertLowerRecordedResult(record,verified){
  assert.equal(record.state,'recorded');assert.equal(record.verificationCompleted,true);assert.ok(verified);
  assert.equal(record.runPassed,verified.runPassed);assert.equal(record.cleanupPassed,verified.cleanupPassed);
  assert.equal(verified.run,record.run);assert.equal(verified.profile,record.profile);assert.equal(verified.reservationSha256,record.reservationSha256);assert.equal(verified.quietWindowSha256,record.quietWindowSha256);
  assert.equal(verified.cleanupPassed,true);assert.equal(verified.sourceUnchanged,true);assert.equal(verified.postLowerRlsVerification?.passed,true);
  return verified;
}
export async function executeLowerSweep(preparation){
  const root=resolve(preparation.outputDirectory),base=read(preparation.optionsFile),window=read(preparation.quietWindowFile);
  assert.equal(hash(readFileSync(preparation.optionsFile)),preparation.optionsSha256);
  assert.equal(hash(readFileSync(preparation.quietWindowFile)),preparation.quietWindowSha256);
  assert.equal(preparation.contractSha256,lowerContractHash());assert.equal(existsSync(root),false);
  assert.equal(window.localSyntheticOnly,true);assert.equal(window.source,base.source);assert.equal(window.noOtherLoadOrBuilds,true);
  assert.equal(window.lowerLoadContractSha256,lowerContractHash());assert.equal(window.hostHarnessSource,base.hostHarnessSource);
  assert.equal(base.arm,'B');assert.equal(base.lowerLoad.hostHarnessSource,base.hostHarnessSource);
  assertLowerRun(base,LOWER_LEVELS[0]);
  const host=resolve(fileURLToPath(new URL('../../../..',import.meta.url))),declaredDate=today();
  function assertFrozen(){assert.equal(git(host,['rev-parse','HEAD']),base.hostHarnessSource);assert.equal(git(host,['status','--porcelain']),'');assert.equal(today(),declaredDate);}
  assertFrozen();mkdirSync(root);
  const contract={...LOWER_CONTRACT,source:base.source,applicationImage:'sha256:8ae47ef898382883c20406c83a97728168d115d47345b7790701cb266fd7c835',
    helperImage:base.helperImage,hostHarnessSource:base.hostHarnessSource,lowerLoadBindingSha256:hash(JSON.stringify(base.lowerLoad)),
    optionsSha256:preparation.optionsSha256,quietWindowSha256:preparation.quietWindowSha256,declaredDate,
    declaredAt:new Date().toISOString(),policyApproved:false,capacityAccepted:false,productionReadiness:false};
  save(root,'contract.json',contract);const contractSha256=hash(readFileSync(join(root,'contract.json'))),journal={contractSha256,attempts:[],closed:false};
  function checkpoint(){const temp=join(root,'journal.next');writeFileSync(temp,JSON.stringify(journal,null,2)+'\n');renameSync(temp,join(root,'journal.json'));}
  checkpoint();let chosen=0,reason='LOWEST_DECLARED_LEVEL',completed=false,failure=null;
  async function attempt(profile,phase,index){
    assertFrozen();assert.ok(Date.now()>=Date.parse(window.startsAt));assert.ok(Date.parse(window.expiresAt)-Date.now()>=LOWER_CONTRACT.fullAttemptReserveMs,'Whole attempt reserve unavailable');
    const run=randomBytes(6).toString('hex'),directory=join(root,`${journal.attempts.length+1}-${phase}-${index}`),receipt=join(directory,'receipt'),privateDirectory=join(directory,'private');mkdirSync(directory);
    const observed=remapObservedEnvironment(read(base.observedEnvironmentFile),base.scopeBinding,declaredDate);
    const reservation={run,source:base.source,arm:'B',profile:profile.name,contractSha256:profileHash(profile),campaignContractSha256:contractSha256,
      preparationSmoke:false,observedFlagsSha256:observed.observedFlagsSha256,receiptDirectory:receipt,privateDirectory,
      lowerLoadContractSha256:lowerContractHash(),hostHarnessSource:base.hostHarnessSource,lowerLoadBindingSha256:contract.lowerLoadBindingSha256};
    save(directory,'reservation.json',reservation);const reservationSha256=hash(readFileSync(join(directory,'reservation.json')));
    const record={phase,index,run,profile:profile.name,reservationSha256,state:'reserved',receiptDirectory:receipt,privateDirectory};journal.attempts.push(record);checkpoint();
    const runWindow={...window,profile:profile.name};save(directory,'quiet-window.json',runWindow);
    record.quietWindowSha256=hash(readFileSync(join(directory,'quiet-window.json')));checkpoint();
    process.stdout.write(JSON.stringify({event:'lower_started',phase,index,run,clients:profile.offering.schoolDevices[0],offered:profile.offering.expected})+'\n');
    let result,verified;
    try{
      result=await runV2({...base,profile:profile.name,run,outputDirectory:receipt,privateDirectory,reservationFile:join(directory,'reservation.json'),reservationSha256,
        quietWindowFile:join(directory,'quiet-window.json'),quietWindowSha256:hash(readFileSync(join(directory,'quiet-window.json')))});
      record.receiptManifestSha256=hash(readFileSync(join(receipt,'receipt-manifest.json')));
      verified=loadReceipt(receipt,record.receiptManifestSha256,privateDirectory);
      assert.equal(verified.run,run);assert.equal(verified.reservationSha256,reservationSha256);assert.equal(verified.campaignContractSha256,contractSha256);
      assert.equal(verified.hostHarnessSource,base.hostHarnessSource);assert.deepEqual(verified.lowerLoad,base.lowerLoad);
      assert.equal(verified.source,base.source);assert.equal(verified.applicationImage,contract.applicationImage);assert.equal(verified.helperImage,base.helperImage);
      assert.equal(verified.schemaSha256,base.lowerLoad.sourceSchemaSha256);assert.equal(verified.observedFlagsSha256,observed.observedFlagsSha256);
      assert.equal(verified.clientAdvertisementSha256,base.clientAdvertisementSha256);assert.ok(Date.now()<Date.parse(window.expiresAt));
      assertFrozen();record.state='recorded';record.runPassed=verified.runPassed;record.cleanupPassed=verified.cleanupPassed;
      record.headroomPassed=lowerHeadroom(verified);record.disposition=lowerScreenDisposition(verified);record.verificationCompleted=true;
    }catch{verified=undefined;record.state='recorded';record.verificationCompleted=false;record.runPassed=false;record.disposition={continueUpward:false,reason:'RECEIPT_OR_EXECUTION_FAILED'};}
    record.completedAt=new Date().toISOString();checkpoint();save(directory,'disposition.json',record);
    process.stdout.write(JSON.stringify({event:'lower_completed',phase,index,run,runPassed:record.runPassed,headroomPassed:record.headroomPassed??false,cleanupPassed:record.cleanupPassed??false,reason:record.disposition.reason})+'\n');
    return assertLowerRecordedResult(record,verified);
  }
  try{
    const initial=[];for(let i=0;i<3;i++){const record=await attempt(LOWER_LEVELS[0],'desales133-confirmation',i+1);initial.push(record);if(!record.runPassed)throw Error('INITIAL_133_HARD_FAILURE');}
    assertLowerConfirmation(initial,LOWER_LEVELS[0]);
    for(let level=1;level<LOWER_LEVELS.length;level++){
      const record=await attempt(LOWER_LEVELS[level],'screen',level),disposition=lowerScreenDisposition(record);
      if(!disposition.continueUpward){reason=disposition.reason;journal.heldLevels=LOWER_LEVELS.slice(level+1).map(row=>row.name);if(disposition.fatal)throw Error('SCREEN_SAFETY_OR_UNCLASSIFIED_FAILURE');break;}
      chosen=level;reason='HIGHEST_SCREEN_WITH_DECLARED_MARGIN';
    }
    if(chosen>0){const confirmation=[];for(let i=0;i<3;i++){const record=await attempt(LOWER_LEVELS[chosen],'selected-confirmation',i+1);confirmation.push(record);if(!record.runPassed||!lowerHeadroom(record))throw Error('SELECTED_HEADROOM_CONFIRMATION_FAILED');}assertLowerConfirmation(confirmation,LOWER_LEVELS[chosen]);}
    assertFrozen();
    const replay=journal.attempts.map(row=>assertLowerRecordedResult(row,loadReceipt(row.receiptDirectory,row.receiptManifestSha256,row.privateDirectory)));
    assertLowerConfirmation(replay.filter((row,n)=>journal.attempts[n].phase==='desales133-confirmation'),LOWER_LEVELS[0]);
    if(chosen>0)assertLowerConfirmation(replay.filter((row,n)=>journal.attempts[n].phase==='selected-confirmation'),LOWER_LEVELS[chosen]);
    assertFrozen();completed=true;
  }catch(error){failure=/^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)?error.message:'LOWER_SWEEP_FAILED';}
  finally{
    journal.closed=true;journal.completed=completed;journal.failure=failure;journal.completedAt=new Date().toISOString();checkpoint();
    save(root,'closure.json',{contractSha256,journalSha256:hash(readFileSync(join(root,'journal.json'))),completed,
      supportedHeartbeatEnvelopeClients:completed?LOWER_LEVELS[chosen].offering.schoolDevices[0]:null,reason,failure,
      deploymentPopulation:133,headroomRequired:true,policyApproved:false,pairedComparisonAccepted:false,
      higherFleetClassroomOrSurvivalClaim:false,capacityAccepted:false,productionReadiness:false});
  }return{completed,failure,outputDirectory:root,capacityAccepted:false,productionReadiness:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{const result=await executeLowerSweep(read(process.argv[2]));process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.completed?0:1;}
  catch{process.stderr.write('LOWER_SWEEP_PREPARATION_FAILED\n');process.exitCode=1;}
}
