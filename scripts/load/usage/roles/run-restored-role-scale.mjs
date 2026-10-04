import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,existsSync,renameSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {withRestoredSnapshot} from './restore-snapshot.mjs';
import {loadSnapshot} from './snapshot-contract.mjs';
import {hash} from './receipt-loader.mjs';
import {writeImageEnvelopes,writeRuntimeFacts,sealRunReceipts} from './receipt-writer.mjs';
import {PROFILE,assertExecutionMode} from './profile.mjs';
import {CAMPAIGN_CONTRACT_SHA256,validateCandidateRun} from './campaign-validation.mjs';
import {waitForRelease} from './measurement-gate.mjs';
import {launch} from './launch-role-scale.mjs';
import {cleanupRoles} from './cleanup-role-fixtures.mjs';
import {loadRegisteredAttempt} from './campaign-journal.mjs';

const read=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const save=(directory,name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function restoreWorkloadEnvironment({configuration,source,run,registry,preparedStateSha256,phase,mode='diagnostic',secret}){
  assert.match(source,/^[a-f0-9]{40}$/);assert.match(run,/^[a-f0-9]{12}$/);assert.match(preparedStateSha256,/^[a-f0-9]{64}$/);
  assert.ok(['ingest','combined'].includes(phase));assert.equal(typeof secret,'function');
  const execution=assertExecutionMode({mode,phase,cpuProfile:false});
  const tables=registry.inventories.classpilotPrivateChatLifecyclePostExpand.tables;assert.equal(tables.length,129);
  for(const name of ['appUrl','adminUrl']){const u=new URL(configuration[name]);assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'5437');assert.equal(u.pathname,'/schoolpilot_redesign_usage_scale_'+run);assert.equal(u.search,'');assert.equal(u.hash,'');}
  return {DATABASE_URL:configuration.appUrl,DATABASE_URL_PRIVILEGED:configuration.appUrl,ADMIN_DATABASE_URL:configuration.adminUrl,
    JWT_SECRET:secret(),SESSION_SECRET:secret(),STUDENT_TOKEN_SECRET:secret(),NODE_ENV:'test',REDIS_URL:'redis://127.0.0.1:6387',
    RLS_GUC_ENABLED:'true',RLS_ENABLED_TABLES:tables.join(','),SCHEDULER_ENABLED:'false',USAGE_LOCAL_SCALE:'1',USAGE_SCALE_CONTAINER:'schoolpilot-usage-scale-'+run,
    USAGE_SOURCE_REVISION:source,USAGE_SCALE_COLD_STATE_SHA256:preparedStateSha256,USAGE_SCALE_RLS_INVENTORY:'classpilotPrivateChatLifecyclePostExpand',
    CLASSPILOT_USAGE_ROLLUP_MODE:'on',CLASSPILOT_DIGITAL_USAGE_MODE:'on',CLASSPILOT_DAILY_USAGE_ROLLUP_MODE:'shadow',
    CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE:'off',PASSPILOT_RULES_MODE:'off',PASSPILOT_APPOINTMENTS_MODE:'off',PASSPILOT_REPORTS_MODE:'off',
    RUN_LEGACY_MIGRATIONS_ONLY:'false',RUN_MIGRATIONS_ONLY:'false',USAGE_RELEASE_PHASE:phase,USAGE_RELEASE_DIAGNOSTIC:execution.diagnosticOnly?'true':'false',USAGE_RELEASE_CPU_PROFILE:'false'};
}

export function combinedCleanupReceipt({run,roles,redis,postgres,finishedAt}){
  assert.match(run,/^[a-f0-9]{12}$/);assert.ok(Number.isFinite(Date.parse(finishedAt)));
  const resources=[{...postgres,role:'postgres'},{...redis,role:'redis'}];
  const fixtures={resources,cleanupPassed:resources.every(row=>row.cleanupPassed===true&&row.confirmedAbsent===true)};
  return {schemaVersion:1,run,finishedAt,roles,fixtures,cleanupPassed:roles.cleanupPassed===true&&fixtures.cleanupPassed,capacityAccepted:false};
}

export async function cleanupWorkloadResources({roles,redis}){
  // A failed role cleanup (including its receipt write) must never prevent the
  // independent Redis cleanup. Preserve both outcomes before the PG owner exits.
  const outcomes=await Promise.allSettled([Promise.resolve().then(roles),Promise.resolve().then(redis)]);
  const result={};
  for(const [index,name]of ['roles','redis'].entries())result[name]=outcomes[index].status==='fulfilled'
    ? outcomes[index].value
    : {cleanupPassed:false,confirmedAbsent:false,failureCode:name==='roles'?'ROLE_CLEANUP_THREW':'REDIS_CLEANUP_THREW'};
  return {...result,cleanupPassed:result.roles?.cleanupPassed===true&&result.redis?.cleanupPassed===true};
}

export function assertPreparedSchemaIdentity(schema,expectedSourceFingerprint){
  assert.equal(schema.passed,true);assert.match(expectedSourceFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(schema.originalCanonicalSha256,expectedSourceFingerprint);
  for(const key of ['referenceNormalizedSha256','referenceCanonicalSha256'])assert.match(schema[key],/^[a-f0-9]{64}$/);
  assert.equal(schema.referenceNormalizedSha256,schema.restoredNormalizedSha256);
  assert.equal(schema.referenceCanonicalSha256,schema.restoredCanonicalSha256);
}

export async function prepareColdServices({release,restart,createRedis}){
  const gate=await release(),cold=await restart(gate);
  // Docker replaces the PostgreSQL network namespace at restart. Joining it
  // earlier leaves Redis unreachable from subsequently created role containers.
  const redis=await createRedis(cold);return{gate,cold,redis};
}

export function finalizeRunEvidence({directory,execution,expectedRuntime,trustedPlanSha256,collect=writeRuntimeFacts,seal=sealRunReceipts,validate=validateCandidateRun}){
  let exitCode=execution.exitCode,collectionFailure=false;
  try{collect(directory,expectedRuntime);}catch{collectionFailure=true;exitCode=1;}
  save(directory,'execution.json',{...execution,exitCode});
  if(!collectionFailure)try{const loaded=seal(directory,trustedPlanSha256),checked=validate(loaded.bundle,trustedPlanSha256);if(execution.diagnosticOnly===false&&execution.exitCode===0&&!checked.runPassed)throw Error('CANDIDATE_RECEIPT_VALIDATION_FAILED');save(directory,'validation-result.json',{...checked,diagnosticOnly:execution.diagnosticOnly===true,capacityAccepted:false,receiptManifestSha256:loaded.receiptManifestSha256});}
  catch{
    collectionFailure=true;exitCode=1;
    // Preserve the provisional bytes and any unverified manifest. Only the
    // corrected execution receipt remains at the final canonical path.
    renameSync(join(directory,'execution.json'),join(directory,'execution-before-receipt-failure.json'));
    if(existsSync(join(directory,'receipt-manifest.json')))renameSync(join(directory,'receipt-manifest.json'),join(directory,'receipt-manifest-unverified.json'));
    save(directory,'execution.json',{...execution,exitCode,receiptCollectionFailed:true});
  }
  if(collectionFailure)save(directory,'receipt-collection-failure.json',{code:'INCOMPLETE_OR_INVALID_OWNER_RECEIPTS',exitCode:1,capacityAccepted:false});
  return exitCode;
}

// Candidate runs require the immutable pending journal registration before any
// fixture side effect. Diagnostics never acquire a campaign identity afterward.
export async function runRestoredRoleScale(options){
  const execution=assertExecutionMode({mode:options.mode,phase:options.phase,cpuProfile:false});
  const registration=options.mode==='capacity-candidate'?loadRegisteredAttempt(options.campaignDirectory,{trustedCampaignSha256:options.trustedCampaignSha256,registrationSha256:options.registrationSha256,source:options.source,run:options.run,outputDirectory:options.evidenceDirectory}):null;
  const output=resolve(options.evidenceDirectory),privateDirectory=resolve(options.privateDirectory),bindingRaw=readFileSync(options.bindingFile),binding=JSON.parse(bindingRaw);
  assert.equal(hash(bindingRaw),options.bindingSha256);assert.equal(binding.applicationSource,options.source);assert.equal(binding.passed,true);assert.equal(binding.cleanupPassed,true);assert.ok(binding.allowedModes.includes(options.mode));
  if(registration)assert.equal(binding.predeclaredExecutionMode,'capacity-candidate');
  for(const[name,expected]of Object.entries(binding.roleHarnessSha256))assert.equal(hash(readFileSync(new URL(name,import.meta.url))),expected);
  const candidate=read(options.candidatePreparationFile);assert.equal(hash(readFileSync(options.candidatePreparationFile)),options.candidatePreparationSha256);assert.equal(candidate.passed,true);assert.equal(candidate.source,options.source);
  assert.equal(binding.candidateImageId,candidate.image.indexDigest);assert.equal(binding.candidateConfigDigest,candidate.image.configDigest);
  assert.equal(hash(readFileSync(options.runtimeProofFile)),options.runtimeProofSha256);assert.equal(read(options.runtimeProofFile).runtimeSha256,binding.runtimeSha256);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const snapshot=loadSnapshot(options.snapshotDirectory,options.snapshotManifestSha256,{source:options.source,today});
  const registryPath=join(options.sourceDirectory,'src/config/rlsRegistry.json'),registry=read(registryPath);
  assert.match(options.expectedSchemaSha256,/^[a-f0-9]{64}$/);
  assert.equal(options.expectedSchemaSha256,snapshot.data['schema-fingerprint.json'].canonicalSha256);
  const run=options.run??randomBytes(6).toString('hex'),nonce=registration?.plan.nonce??randomUUID();assert.match(run,/^[a-f0-9]{12}$/);
  const identity={candidate:{indexDigest:candidate.image.indexDigest,platformManifestDigest:candidate.image.platformManifestDigest,configDigest:candidate.image.configDigest,scanReceiptSha256:binding.candidateScanReceiptSha256},
    helper:{imageId:binding.roleImageId,runtimeConfigDigest:binding.runtimeConfigDigest,bindingSha256:options.bindingSha256,runtimeSha256:binding.runtimeSha256},
    harness:{identity:binding.harnessIdentity,files:binding.roleHarnessSha256,executed:binding.harnessHashes},profileSha256:binding.roleHarnessSha256['profile.mjs'],validatorSha256:binding.roleHarnessSha256['campaign-validation.mjs'],contractSha256:CAMPAIGN_CONTRACT_SHA256,
    schemaSha256:options.expectedSchemaSha256,registrySha256:hash(readFileSync(registryPath)),migrationSha256:hash(JSON.stringify(snapshot.data['preparation-fixture-contract.json'].migrations))};
  if(registration){assert.deepEqual(registration.plan.identity,identity);assert.equal(registration.plan.phase,options.phase);}
  const plan=registration?.plan??{schemaVersion:2,run,nonce,source:options.source,...execution,cpuProfile:false,declaredAt:new Date().toISOString(),identity};
  const planRaw=registration?.planRaw??JSON.stringify(plan,null,2)+'\n',planFile=output+'.predeclared-plan.json',planSha256=hash(planRaw);writeFileSync(planFile,planRaw,{flag:'wx'});
  // Make the observable fixture start strictly later than its immutable plan.
  while(Date.now()<=Date.parse(plan.declaredAt))await pause(1);
  const docker=options.docker??'docker',endpoint=options.endpoint,redisName='schoolpilot-usage-redis-'+run;
  assert.match(options.redisImage,/^sha256:[a-f0-9]{64}$/);
  const ambient={...process.env};for(const key of Object.keys(ambient))if(/^DOCKER_|^BUILDX_BUILDER$/.test(key))delete ambient[key];
  function call(args,{timeout=30000}={}){const result=spawnSync(docker,['--host',endpoint,...args],{env:ambient,encoding:'utf8',timeout,maxBuffer:8*1024**2});if(result.status!==0)throw Error('RESTORED_ROLE_DOCKER_FAILED');return result.stdout;}
  function inspect(selector){const isId=/^[a-f0-9]{64}$/.test(selector);if(!isId)assert.match(selector,/^schoolpilot-(?:role-(?:api|worker|generator|coordinator)|usage-redis|usage-scale)-[a-f0-9]{12}$/);const ids=call(['container','ls','--all','--filter',isId?'id='+selector:'name=^/'+selector+'$','--no-trunc','--format','{{.ID}}']).trim().split(/\r?\n/).filter(Boolean);assert.ok(ids.length<=1);if(!ids.length)return null;if(isId)assert.equal(ids[0],selector);return JSON.parse(call(['inspect',ids[0]]))[0];}
  const redisImage=JSON.parse(call(['image','inspect',options.redisImage]))[0];
  let redisId=null,redisCleanup={id:null,confirmedAbsent:false,cleanupPassed:false},roleCleanup={cleanupPassed:false,roles:[]},hostResult=null,exitCode=1,failure=null;
  function verifyRedis(found,pgId){assert.equal(found.Name,'/'+redisName);assert.match(found.Id,/^[a-f0-9]{64}$/);assert.equal(found.Config.Labels['codex.usage-scale'],run);assert.equal(found.Config.Image,options.redisImage);const actual=JSON.parse(call(['image','inspect',found.Image]))[0];assert.deepEqual(actual.RootFS,redisImage.RootFS);assert.deepEqual(actual.Config,redisImage.Config);assert.equal(found.HostConfig.NetworkMode,'container:'+pgId);assert.equal(found.HostConfig.NanoCpus,1e9);assert.equal(found.HostConfig.Memory,268435456);assert.equal(found.HostConfig.MemorySwap,268435456);return found;}
  try{
    await withRestoredSnapshot({...options,run,evidenceDirectory:output,privateDirectory,planFile,planSha256,purpose:options.mode==='diagnostic'?'Full source-bound restored Linux role diagnostic; never capacity acceptance':'Registered cold combined candidate attempt; only final campaign closure accepts capacity'},async context=>{
      const {ready,preparation,configurationFile,restartAfterRelease}=context;
      assertPreparedSchemaIdentity(preparation.restore.schemaComparison,identity.schemaSha256);assert.equal(preparation.restore.databaseValidation.migrationsSha256,identity.migrationSha256);
      for(const name of ['cold-fixture-state.json','release-control-preparation.json','preparation-fixture-contract.json','preparation-metrics.json'])copyFileSync(join(options.snapshotDirectory,name),join(output,name));
      const configuration=read(configurationFile),environment=restoreWorkloadEnvironment({configuration,source:options.source,run,registry,preparedStateSha256:hash(readFileSync(join(output,'cold-fixture-state.json'))),phase:options.phase,mode:options.mode,secret:()=>randomBytes(32).toString('hex')});
      try{
        writeImageEnvelopes({directory:output,...options});
        const{cold,redis}=await prepareColdServices({
          release:async()=>{await waitForRelease({output,run,source:options.source,bindingFile:options.bindingFile,phase:options.phase,mode:options.mode,nonce});const gate=read(join(output,'measurement-release-receipt.json'));assert.equal(gate.nonce,nonce);return gate;},
          restart:restartAfterRelease,
          createRedis:async cold=>{assert.equal(inspect(redisName),null);
            try{call(['run','--detach','--name',redisName,'--label','codex.usage-scale='+run,'--cpus','1','--memory','256m','--memory-swap','256m','--network','container:'+ready.pgContainerId,options.redisImage,'redis-server','--port','6387','--save','','--appendonly','no']);}finally{const found=inspect(redisName);if(found){verifyRedis(found,ready.pgContainerId);redisId=found.Id;}}
            assert.ok(redisId);const actual=inspect(redisId);verifyRedis(actual,ready.pgContainerId);assert.ok(Date.parse(actual.Created)>=Date.parse(cold.after.StartedAt));
            let readyRedis=false;for(let n=0;n<30;n++){try{if(call(['exec',redisId,'redis-cli','-p','6387','PING']).trim()==='PONG'){readyRedis=true;break;}}catch{}await pause(100);}assert.equal(readyRedis,true);
            return{containerId:redisId,pgContainerId:ready.pgContainerId,createdAt:actual.Created,readyAt:new Date().toISOString(),afterColdRestart:true};}
        });
        const preparationReceipt={...preparation,profile:PROFILE,planSha256,redisContainerId:redisId,redis,restore:{...preparation.restore,validityHorizon:cold.validityHorizon,preColdValidity:cold.validity}};save(output,'preparation-receipt.json',preparationReceipt);
        hostResult=await launch({docker,endpoint,bindingFile:options.bindingFile,run,pgContainerId:ready.pgContainerId,evidenceDirectory:output,controlDirectory:join(privateDirectory,'role-control'),environment,mode:options.mode});
        exitCode=hostResult.passed?0:1;
      }finally{
        const cleanups=await cleanupWorkloadResources({
          roles:()=>cleanupRoles({inspect:async selector=>inspect(selector),remove:async id=>call(['rm','--force','--volumes',id])},{run,output,image:binding.roleImageId}),
          redis:async()=>{const found=inspect(redisName);if(found){verifyRedis(found,ready.pgContainerId);if(redisId)assert.equal(found.Id,redisId);redisId=found.Id;call(['rm','--force','--volumes',redisId]);}assert.equal(inspect(redisName),null);if(redisId)assert.equal(inspect(redisId),null);return{id:redisId,confirmedAbsent:true,cleanupPassed:true};}
        });
        roleCleanup=cleanups.roles;redisCleanup={id:redisId,...cleanups.redis};
        if(!cleanups.cleanupPassed)throw Error('ROLE_OR_REDIS_CLEANUP_UNCONFIRMED');
      }
    });
  }catch(error){failure={code:typeof error?.code==='string'?error.code:'RESTORED_ROLE_RUN_FAILED'};exitCode=1;}
  if(existsSync(output)){
    const postgres=existsSync(join(output,'cleanup.json'))?read(join(output,'cleanup.json')):{cleanupPassed:false,confirmedAbsent:false};
    const cleanup=combinedCleanupReceipt({run,roles:roleCleanup,redis:redisCleanup,postgres:{id:postgres.containerId,confirmedAbsent:postgres.confirmedAbsent===true,cleanupPassed:postgres.cleanupPassed===true,volumes:postgres.volumes},finishedAt:new Date().toISOString()});save(output,'all-owned-role-fixtures-cleanup.json',cleanup);
    if(!cleanup.cleanupPassed)exitCode=1;
    const finalSource=execFileSync('git',['rev-parse','HEAD'],{cwd:options.sourceDirectory,encoding:'utf8'}).trim(),clean=execFileSync('git',['status','--porcelain'],{cwd:options.sourceDirectory,encoding:'utf8'}).trim()==='';
    const harnessUnchanged=Object.entries(binding.roleHarnessSha256).every(([name,expected])=>hash(readFileSync(new URL(name,import.meta.url)))===expected);
    save(output,'final-source-receipt.json',{source:finalSource,clean,unchanged:finalSource===options.source&&clean&&harnessUnchanged,harnessSha256:binding.harnessIdentity});
    const execution={sourceRevision:options.source,workloadProfile:PROFILE,candidateImageId:binding.candidateImageId,diagnosticImageId:binding.roleImageId,phase:options.phase,diagnosticOnly:options.mode==='diagnostic',collectApiCpuProfile:false,coldPostgresRestart:existsSync(join(output,'cold-restart-receipt.json')),hostFilesystemCachesFlushed:false,restrictedNonOwnerRole:true,rlsInventory:'classpilotPrivateChatLifecyclePostExpand',registrySha256:identity.registrySha256,admittedTables:129,currentFixtureMigrations:true,postgresCpu:4,postgresMemoryBytes:4294967296,roleNodeOldSpaceMiB:null,seederNodeOldSpaceMiB:512,productionMutations:0,exitCode,capacityAccepted:false,...(failure?{failure}:{})};
    exitCode=finalizeRunEvidence({directory:output,execution,expectedRuntime:{source:options.source,preloaderSha256:binding.roleHarnessSha256['runtime-facts.mjs']},trustedPlanSha256:planSha256});
  }
  return {run,output,exitCode,capacityAccepted:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{const result=await runRestoredRoleScale(read(process.argv[2]));process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.exitCode;}catch{process.stderr.write('RESTORED_ROLE_PREPARATION_FAILED\n');process.exitCode=1;}}
