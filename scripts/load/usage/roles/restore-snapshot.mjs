import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {loadSnapshot,normalizeSnapshotSchema,snapshotHash} from './snapshot-contract.mjs';
import {verifySnapshotValidityHorizon} from './snapshot-validity-horizon.mjs';
import {canonicalSchemaFingerprint} from '../release-schema-fingerprint.mjs';
import {loadRegisteredAttempt} from './campaign-journal.mjs';

export function assertUnexpiredRestoreGate({ready,gate,validityHorizon,now=Date.now(),minimumRemainingMs=15*60*1000}){
  assert.ok(Number.isFinite(now));assert.ok(Number.isSafeInteger(minimumRemainingMs)&&minimumRemainingMs>=120000);
  const readyAt=Date.parse(ready.readyAt),expiresAt=Date.parse(ready.expiresAt),releasedAt=Date.parse(gate.releasedAt),validUntil=Date.parse(validityHorizon);
  for(const value of [readyAt,expiresAt,releasedAt,validUntil])assert.ok(Number.isFinite(value));
  assert.ok(releasedAt>=readyAt&&releasedAt<=now&&now<expiresAt,'Restore gate expired or has an invalid release time');
  assert.ok(validUntil>=now+minimumRemainingMs,'Snapshot authority horizon is too short for the workload');
}

const ownDirectory=dirname(fileURLToPath(import.meta.url));
const maximumHandoffMs=15*60*1000;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const disjoint=(a,b)=>{for(const [parent,child]of [[a,b],[b,a]]){const rel=relative(resolve(parent),resolve(child));assert.ok(rel&&(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)),'Snapshot paths must be disjoint');}};
const save=(directory,name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});

export function assertRestoreOptions(options){
  assert.match(options.run,/^[a-f0-9]{12}$/);assert.match(options.source,/^[a-f0-9]{40}$/);
  assert.match(options.snapshotManifestSha256,/^[a-f0-9]{64}$/);
  assert.match(options.endpoint,/^(?:npipe:\/{2,4}\.\/pipe\/[a-zA-Z0-9_.-]+|unix:\/\/\/[^\s?#]+)$/);
  for(const key of ['sourceDirectory','snapshotDirectory','evidenceDirectory','privateDirectory'])assert.ok(typeof options[key]==='string'&&isAbsolute(options[key])&&!/[\r\n,]/.test(options[key]));
  const paths=['sourceDirectory','snapshotDirectory','evidenceDirectory','privateDirectory'];
  for(let a=0;a<paths.length;a++)for(let b=a+1;b<paths.length;b++)disjoint(options[paths[a]],options[paths[b]]);
  assert.ok(['diagnostic','capacity-candidate'].includes(options.mode));
  if(options.mode==='capacity-candidate'){
    const registered=loadRegisteredAttempt(options.campaignDirectory,{trustedCampaignSha256:options.trustedCampaignSha256,registrationSha256:options.registrationSha256,source:options.source,run:options.run,outputDirectory:options.evidenceDirectory});
    assert.equal(options.planSha256,registered.planSha256);assert.equal(readFileSync(options.planFile,'utf8'),registered.planRaw);
  }
  assert.ok(typeof options.purpose==='string'&&options.purpose.length>0&&options.purpose.length<=256&&!/[\r\n]/.test(options.purpose));
  return options;
}

export function compareNativeSchemas(original,reference,restored){
  const referenceNormalized=normalizeSnapshotSchema(reference),restoredNormalized=normalizeSnapshotSchema(restored);
  assert.equal(restoredNormalized,referenceNormalized,'Full native-rendered schema comparison failed');
  assert.equal(canonicalSchemaFingerprint(reference),canonicalSchemaFingerprint(restored),'Full native schema fingerprints differ');
  return {passed:true,normalization:'Full schemas rendered by the same PostgreSQL parser; only BOM/LF and pg_dump restrict nonce directives removed',
    originalSha256:snapshotHash(original),referenceSha256:snapshotHash(reference),restoredSha256:snapshotHash(restored),
    originalCanonicalSha256:canonicalSchemaFingerprint(original),referenceCanonicalSha256:canonicalSchemaFingerprint(reference),restoredCanonicalSha256:canonicalSchemaFingerprint(restored),
    referenceNormalizedSha256:snapshotHash(referenceNormalized),restoredNormalizedSha256:snapshotHash(restoredNormalized)};
}

export function verifyOwnedSnapshotContainer(found,{run,name,image,imageInspect},actualImage){
  assert.equal(found.Name,'/'+name);assert.match(found.Id,/^[a-f0-9]{64}$/);
  assert.equal(found.Config.Labels['codex.usage-snapshot-restore'],run);assert.equal(found.Config.Image,image);
  assert.equal(found.Config.Labels['codex.usage-scale'],run);
  assert.deepEqual(actualImage.RootFS,imageInspect.RootFS);assert.deepEqual(actualImage.Config,imageInspect.Config);
  assert.equal(found.HostConfig.NanoCpus,4e9);assert.equal(found.HostConfig.Memory,4*1024**3);assert.equal(found.HostConfig.MemorySwap,4*1024**3);
  assert.equal(found.HostConfig.Privileged,false);
  assert.equal(found.HostConfig.Binds,null);assert.deepEqual(found.HostConfig.Mounts??[],[]);
  assert.deepEqual(found.HostConfig.PortBindings,{'5437/tcp':[{HostIp:'127.0.0.1',HostPort:'5437'}]});
  assert.equal(found.Mounts.length,1);assert.equal(found.Mounts[0].Type,'volume');assert.equal(found.Mounts[0].Destination,'/var/lib/postgresql/data');assert.match(found.Mounts[0].Name,/^[a-f0-9]{64}$/);assert.equal(found.Mounts[0].RW,true);
  return found;
}

// Absence is established only by a successful exact-name list, never an inspect
// exception. Unknown create outcomes still recover and verify the owned object.
export async function cleanupRestoredSnapshot({find,verify,remove,verifyVolumesAbsent,saveReceipt,run,name,id,created,handoffPassed,failure}){
  let actualId=id??null;
  try{const found=await find();if(found){await verify(found);if(actualId)assert.equal(found.Id,actualId);actualId=found.Id;await remove(actualId);}assert.equal(await find(),null);
    const volumes=verifyVolumesAbsent?await verifyVolumesAbsent():undefined;
    const receipt={run,name,containerId:actualId,created,cleanupPassed:true,handoffPassed,confirmedAbsent:true,...(volumes?{volumes}:{}),failure};saveReceipt(receipt);return receipt;
  }catch{const receipt={run,name,containerId:actualId,created,cleanupPassed:false,handoffPassed,confirmedAbsent:false,failure:failure??{stage:'cleanup',code:'OWNED_CLEANUP_UNCONFIRMED'}};saveReceipt(receipt);throw Error('SNAPSHOT_CLEANUP_UNCONFIRMED');}
}

// Executes only against a newly created local fixture. The callback owns any
// subsequent diagnostic clients and must settle before returning; the owner
// retains cleanup even after callback failure. This does not certify capacity.
export async function withRestoredSnapshot(rawOptions,useFixture){
  const options=assertRestoreOptions(rawOptions);assert.equal(typeof useFixture,'function');
  const {run,source,sourceDirectory,snapshotDirectory,snapshotManifestSha256,evidenceDirectory:output,privateDirectory,endpoint}=options;
  const startedAt=new Date().toISOString();
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const snapshot=loadSnapshot(snapshotDirectory,snapshotManifestSha256,{source,today});
  assert.equal(realpathSync(sourceDirectory),resolve(sourceDirectory));
  assert.ok(existsSync(join(sourceDirectory,'.git')));assert.equal(existsSync(join(sourceDirectory,'.git/objects/info/alternates')),false);
  mkdirSync(output,{recursive:false});mkdirSync(privateDirectory,{recursive:false});
  if(options.planFile){const raw=readFileSync(options.planFile);assert.equal(snapshotHash(raw),options.planSha256);const plan=JSON.parse(raw);assert.equal(plan.run,run);assert.equal(plan.source,source);assert.equal(plan.mode,options.mode);assert.ok(Date.parse(plan.declaredAt)<Date.parse(startedAt));writeFileSync(join(output,'run-plan.json'),raw,{flag:'wx'});}
  const environment={...process.env};for(const key of Object.keys(environment))if(/^DOCKER_|^BUILDX_BUILDER$/.test(key))delete environment[key];
  const docker=options.docker??'docker',image=snapshot.manifest.pgImage,name='schoolpilot-usage-scale-'+run,database='schoolpilot_redesign_usage_scale_'+run;
  const owner='restore_owner_'+run,role='restore_app_'+run,ownerPassword=randomBytes(24).toString('hex'),appPassword=randomBytes(24).toString('hex');
  const adminUrl=`postgresql://${owner}:${ownerPassword}@127.0.0.1:5437/${database}`,appUrl=`postgresql://${role}:${appPassword}@127.0.0.1:5437/${database}`;
  function call(args,{input,log,timeout=120000}={}){const result=spawnSync(docker,['--host',endpoint,...args],{env:environment,input,encoding:'utf8',maxBuffer:16*1024*1024,timeout});if(log)writeFileSync(join(output,log),(result.stdout||'')+(result.stderr||''),{flag:'wx'});if(result.status!==0)throw Object.assign(Error('DOCKER_STEP_FAILED'),{code:'DOCKER_STEP_FAILED'});return result.stdout;}
  function find(){const ids=call(['container','ls','--all','--filter','name=^/'+name+'$','--format','{{.ID}}'],{timeout:30000}).trim().split(/\r?\n/).filter(Boolean);if(ids.length===0)return null;assert.equal(ids.length,1);return JSON.parse(call(['inspect',ids[0]],{timeout:30000}))[0];}
  const imageInspect=JSON.parse(call(['image','inspect',image]))[0];
  let volumeNames;
  const verify=found=>{const checked=verifyOwnedSnapshotContainer(found,{run,name,image,imageInspect},JSON.parse(call(['image','inspect',found.Image]))[0]);const names=checked.Mounts.map(row=>row.Name);if(volumeNames)assert.deepEqual(names,volumeNames);else volumeNames=names;return checked;};
  const sourceFiles=['restore-snapshot.mjs','snapshot-contract.mjs','snapshot-validity-horizon.mjs','validate-snapshot-database.mjs','../release-schema-fingerprint.mjs'];
  const sourceHashes=Object.fromEntries(sourceFiles.map(name=>[name,snapshotHash(readFileSync(join(ownDirectory,name)))]));
  save(output,'restore-sources.json',{source,files:sourceHashes});
  const {Client}=createRequire(join(sourceDirectory,'package.json'))('pg');
  async function assertNoClients(){const client=new Client({connectionString:adminUrl,connectionTimeoutMillis:5000,statement_timeout:60000});try{await client.connect();assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].count,0);}finally{await client.end();}}
  async function noClientsAndHorizon(horizonMs){const client=new Client({connectionString:adminUrl,connectionTimeoutMillis:5000,statement_timeout:60000});let horizon;try{await client.connect();await client.query('BEGIN READ ONLY');horizon=await verifySnapshotValidityHorizon(client,snapshot.data['cold-fixture-state.json'].schools,horizonMs);await client.query('COMMIT');assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].count,0);}finally{await client.end();}return {...horizon,clientsClosed:true};}
  let created=false,id=null,passed=false,stage='create',failure=null,value;
  try{
    assert.equal(find(),null);
    const envFile=join(privateDirectory,'postgres.env');writeFileSync(envFile,`POSTGRES_DB=${database}\nPOSTGRES_USER=${owner}\nPOSTGRES_PASSWORD=${ownerPassword}\nPGPORT=5437\n`,{flag:'wx'});
    try{call(['run','--detach','--name',name,'--label',`codex.usage-snapshot-restore=${run}`,'--label',`codex.usage-scale=${run}`,'--cpus','4','--memory','4g','--memory-swap','4g','--publish','127.0.0.1:5437:5437','--env-file',envFile,image,'postgres','-p','5437'],{log:'create.log'});}finally{const found=find();if(found){verify(found);id=found.Id;created=true;}}
    stage='readiness';let ready=false;for(let n=0;n<60;n++){const result=spawnSync(docker,['--host',endpoint,'exec',name,'pg_isready','-h','127.0.0.1','-p','5437','-U',owner,'-d',database],{env:environment,encoding:'utf8',timeout:10000});if(result.status===0){ready=true;break;}await pause(500);}assert.equal(ready,true);
    const owned=verify(find());save(output,'owned-pg.json',{run,name,id,imageRequested:image,imageActual:owned.Image,caps:{cpu:4,memoryBytes:4*1024**3,memorySwapBytes:4*1024**3},port:owned.NetworkSettings.Ports['5437/tcp'],anonymousVolumes:volumeNames});
    save(output,'resource-caps.json',{NanoCpus:owned.HostConfig.NanoCpus,Memory:owned.HostConfig.Memory,MemorySwap:owned.HostConfig.MemorySwap});
    stage='restore';call(['cp',join(snapshotDirectory,'prepared-database.private.dump'),`${name}:/tmp/prepared.private.dump`],{log:'copy.log'});
    call(['exec',name,'pg_restore','--exit-on-error','--no-owner','--no-privileges','-U',owner,'-d',database,'/tmp/prepared.private.dump'],{log:'restore.log',timeout:300000});
    stage='fresh-role';call(['exec','-i',name,'psql','-U',owner,'-d',database,'-v','ON_ERROR_STOP=1'],{input:`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${appPassword}'; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};`,log:'fresh-role.log'});
    stage='schema';const original=readFileSync(join(snapshotDirectory,'post-convergence-schema.sql'),'utf8');
    const restored=call(['exec',name,'pg_dump','-U',owner,'-d',database,'--schema-only','--no-owner','--no-privileges']);writeFileSync(join(output,'restored-schema.sql'),restored,{flag:'wx'});
    const referenceDatabase='schoolpilot_snapshot_reference_'+run;call(['exec',name,'createdb','-U',owner,referenceDatabase],{log:'reference-create.log'});
    call(['exec','-i',name,'psql','-U',owner,'-d',referenceDatabase,'-v','ON_ERROR_STOP=1'],{input:original,log:'reference-restore.log'});
    const reference=call(['exec',name,'pg_dump','-U',owner,'-d',referenceDatabase,'--schema-only','--no-owner','--no-privileges']);writeFileSync(join(output,'reference-rendered-schema.sql'),reference,{flag:'wx'});
    const schemaComparison=compareNativeSchemas(original,reference,restored);save(output,'schema-comparison.json',schemaComparison);
    call(['exec',name,'dropdb','-U',owner,referenceDatabase],{log:'reference-drop.log'});
    stage='data-validation';const configuration={sourceDirectory,snapshotDirectory,snapshotManifestSha256,adminUrl,appUrl,resultFile:join(output,'database-validation.json')},configurationFile=join(privateDirectory,'validation.json');save(privateDirectory,'validation.json',configuration);
    const result=spawnSync(process.execPath,[join(ownDirectory,'validate-snapshot-database.mjs'),configurationFile],{env:{...environment,NODE_ENV:'test',SCHEDULER_ENABLED:'false',DATABASE_URL:appUrl,DATABASE_URL_PRIVILEGED:appUrl,ADMIN_DATABASE_URL:adminUrl,DOTENV_CONFIG_QUIET:'true',DOTENV_CONFIG_PATH:join(privateDirectory,'absent-dotenv')},encoding:'utf8',maxBuffer:2*1024*1024,timeout:180000});writeFileSync(join(output,'database-validation.log'),(result.stdout||'')+(result.stderr||''),{flag:'wx'});assert.equal(result.status,0);
    const databaseValidation=JSON.parse(readFileSync(configuration.resultFile));assert.equal(databaseValidation.passed,true);assert.equal(databaseValidation.clientsClosed,true);
    assert.equal(schemaComparison.originalCanonicalSha256,snapshot.data['schema-fingerprint.json'].canonicalSha256);
    save(output,'database-receipt.json',{schemaSha256:schemaComparison.originalCanonicalSha256,nativeRenderedSchemaSha256:schemaComparison.restoredNormalizedSha256,registrySha256:databaseValidation.registrySha256,migrations:databaseValidation.migrationRows,admission:databaseValidation.admission});
    stage='analyze';call(['exec',name,'psql','-U',owner,'-d',database,'-v','ON_ERROR_STOP=1','-c','ANALYZE'],{log:'analyze.log',timeout:120000});
    stage='validity-horizon';const validity=await noClientsAndHorizon(maximumHandoffMs+60000);save(output,'validity-horizon.json',{run,source,snapshotManifestSha256,...validity});
    const readyAt=new Date().toISOString(),nonce=randomBytes(24).toString('hex');
    const preparation={schemaVersion:1,run,source,startedAt,finishedAt:readyAt,mode:options.mode,pgContainerId:id,fresh:true,restore:{source,snapshotManifestSha256,databaseValidation,schemaComparison,validityHorizon:validity.rows.map(row=>new Date(row.required_valid_until).toISOString()).sort()[0],analyze:true,clientsClosed:true}};
    save(output,'snapshot-preparation.json',preparation);
    const readyReceipt={schemaVersion:1,run,source,snapshotManifestSha256,pgContainer:name,pgContainerId:id,pgImage:image,database,privateConfigurationFile:configurationFile,freshRole:role,allValidationClientsClosed:true,otherClientsBeforeHandoff:0,nonce,readyAt,expiresAt:new Date(Date.now()+maximumHandoffMs).toISOString(),purpose:options.purpose,restorationPassed:true,capacityAccepted:false};save(output,'ready.json',readyReceipt);
    let restarted=false;
    async function restartAfterRelease(gate){
      assert.equal(restarted,false);assert.equal(gate.run,run);assert.equal(gate.source,source);assert.ok(Date.parse(gate.releasedAt)>=Date.parse(readyAt));
      // A long human hold must not start stale authority. This reads the current
      // DB clock without refreshing any session/control/entitlement timestamp.
      assert.ok(Date.now()<Date.parse(readyReceipt.expiresAt),'Restore gate expired');
      const coldValidity=await noClientsAndHorizon(maximumHandoffMs+60000);
      const coldValidityHorizon=coldValidity.rows.map(row=>new Date(row.required_valid_until).toISOString()).sort()[0];
      assertUnexpiredRestoreGate({ready:readyReceipt,gate,validityHorizon:coldValidityHorizon});
      await assertNoClients();const before=verify(find());assert.equal(before.Id,id);assert.equal(before.State.Running,true);
      assertUnexpiredRestoreGate({ready:readyReceipt,gate,validityHorizon:coldValidityHorizon});
      const validatedAt=new Date().toISOString();save(output,'pre-cold-validity-horizon.json',{run,source,snapshotManifestSha256,...coldValidity,validatedAt});
      const restartedAt=new Date().toISOString();call(['restart',id],{log:'cold-restart.log'});restarted=true;
      let ready=false;for(let n=0;n<60;n++){const result=spawnSync(docker,['--host',endpoint,'exec',id,'pg_isready','-h','127.0.0.1','-p','5437','-U',owner,'-d',database],{env:environment,encoding:'utf8',timeout:10000});if(result.status===0){ready=true;break;}await pause(500);}assert.equal(ready,true);
      const after=verify(find());assert.equal(after.Id,id);assert.equal(after.State.Running,true);assert.ok(Date.parse(after.State.StartedAt)>Date.parse(before.State.StartedAt));
      const receipt={run,pgContainerId:id,before:before.State,after:after.State,clientsClosed:true,restarted:true,startedAfterValidation:true,validatedAt,restartedAt,validityHorizon:coldValidityHorizon,validity:coldValidity};
      save(output,'cold-restart-receipt.json',receipt);return receipt;
    }
    stage='handoff';value=await useFixture({ready:readyReceipt,preparation,configurationFile,output,refreshReadOnlyHorizon:noClientsAndHorizon,restartAfterRelease});
    stage='final-client-drain';await assertNoClients();save(output,'final-client-drain.json',{run,source,otherClients:0,clientsClosed:true,observedAt:new Date().toISOString()});
    for(const [name,hash]of Object.entries(sourceHashes))assert.equal(snapshotHash(readFileSync(join(ownDirectory,name))),hash,'Restore source changed while its fixture was owned');
    passed=true;
  }catch(error){failure={stage,name:error?.name??'Error',code:typeof error?.code==='string'?error.code:'RESTORE_ASSERTION'};save(output,'failure.json',failure);throw Object.assign(Error('SNAPSHOT_RESTORE_FAILED'),{cause:error});}
  finally{await cleanupRestoredSnapshot({find,verify,remove:actualId=>call(['rm','--force','--volumes',actualId],{log:'remove.log'}),verifyVolumesAbsent:()=>{const names=call(['volume','ls','--format','{{.Name}}'],{timeout:30000}).trim().split(/\r?\n/);for(const name of volumeNames??[])assert.equal(names.includes(name),false);return(volumeNames??[]).map(name=>({name,confirmedAbsent:true}));},saveReceipt:receipt=>save(output,'cleanup.json',receipt),run,name,id,created,handoffPassed:passed,failure});}
  return value;
}

// Native proof entrypoint. Input contains only local paths and source identities;
// credentials are freshly generated into the separate private directory.
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{const options=JSON.parse(readFileSync(process.argv[2],'utf8'));await withRestoredSnapshot(options,async({ready,output})=>{
    process.stdout.write(JSON.stringify({event:'snapshot_restore_ready',run:ready.run,output,readySha256:snapshotHash(readFileSync(join(output,'ready.json'))),capacityAccepted:false})+'\n');
    const completion=join(output,'handoff-complete.json'),deadline=Date.parse(ready.expiresAt);
    while(!existsSync(completion)&&Date.now()<deadline)await pause(500);
    assert.ok(existsSync(completion),'Bounded diagnostic handoff expired');const done=JSON.parse(readFileSync(completion));assert.equal(done.run,ready.run);assert.equal(done.nonce,ready.nonce);assert.equal(done.clientsClosed,true);
  });process.stdout.write('SNAPSHOT_RESTORE_AND_HANDOFF_PASSED\n');}catch{process.stderr.write('SNAPSHOT_RESTORE_OR_HANDOFF_FAILED\n');process.exitCode=1;}
}
