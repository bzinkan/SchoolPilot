import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {hash,PROFILES,profileHash} from './contracts.mjs';
import {prepareUsageSourceBinding,assertUsageSourceBinding,assertReviewedUsageSource,assertUsageSourceCheckout,
  assertUsageSourceDatabase,assertUsageSourceIdentity,assertUsageSourceReceipt,loadUsageSourceBinding,loadFixtureUsageSourceBinding} from './usage-source-binding.mjs';
import {verifyHelperUsageSourceBinding} from './build-helper.mjs';
import {declareCampaign,reserveAttempt,sourceBindingForArm,assertCampaignSourceBinding} from './campaign.mjs';
import {usagePostVerificationHash} from './usage-post-verification.mjs';
import {loadSnapshot} from '../roles/snapshot-contract.mjs';
import {loadReceipt} from './receipts.mjs';
import {validateDistinctRegistration,DISTINCT_SERVICE_LIMITS,distinctEndpointOperationHash,verifyDistinctEndpointReportResult,verifyDistinctPostProof} from './distinct-report-operation.mjs';
import {distinctReportContractHash} from './distinct-reports.mjs';
import {migrateBoundUsageFixture} from './migrate-bound-fixture.mjs';

const repo=fileURLToPath(new URL('../../../../',import.meta.url));
const json=(file,value)=>writeFileSync(file,JSON.stringify(value)+'\n');
function reviewed(binding){
  const bindingRaw=JSON.stringify(binding)+'\n',bindingSha256=hash(bindingRaw);
  const review={schemaVersion:1,kind:'usage_final_source_binding_review',bindingSha256,source:binding.source,
    disposition:'reviewed_for_synthetic_execution',reviewer:'synthetic-test-only',reviewedAtUtc:'2026-10-11T12:00:00Z',operationalAuthorization:false,capacityAccepted:false};
  const reviewRaw=JSON.stringify(review)+'\n';
  return {binding,bindingRaw,bindingSha256,review,reviewRaw,reviewSha256:hash(reviewRaw)};
}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'usage-source-binding-test-')),sourceDirectory=join(root,'source');mkdirSync(sourceDirectory);
  mkdirSync(join(sourceDirectory,'src/db'),{recursive:true});mkdirSync(join(sourceDirectory,'src/config'),{recursive:true});
  writeFileSync(join(sourceDirectory,'.gitignore'),'node_modules/\n');json(join(sourceDirectory,'package.json'),{type:'module'});
  writeFileSync(join(sourceDirectory,'src/config/rlsRegistry.json'),readFileSync(join(repo,'src/config/rlsRegistry.json')));
  writeFileSync(join(sourceDirectory,'src/db/migrations27.ts'),`const expand={id:'usage-expand',checksum:'${'a'.repeat(64)}',apply(){throw Error('MUST_NOT_APPLY')}};
export const schoolPilot27ExpandMigrations=[expand];
export const schoolPilot27Migrations=[expand,{id:'staff-contract',checksum:'${'b'.repeat(64)}',apply(){throw Error('MUST_NOT_APPLY')}}];\n`);
  symlinkSync(join(repo,'node_modules'),join(sourceDirectory,'node_modules'),process.platform==='win32'?'junction':'dir');
  const git=args=>execFileSync('git',['-C',sourceDirectory,...args],{encoding:'utf8',windowsHide:true}).trim();
  git(['init','-q']);git(['config','core.autocrlf','false']);git(['add','.']);git(['-c','user.name=Usage Test','-c','user.email=usage-test@example.invalid','-c','core.hooksPath='+join(root,'no-hooks'),'commit','-qm','synthetic source']);
  const source=git(['rev-parse','HEAD']),applicationImage='sha256:'+'c'.repeat(64),imageBindingFile=join(root,'image.json'),schemaFile=join(root,'schema.sql');
  json(imageBindingFile,{source,image:applicationImage,verified:true});writeFileSync(schemaFile,'CREATE TABLE synthetic_test(id text);\n');
  const options={sourceDirectory,source,applicationImage,imageBindingFile,imageBindingSha256:hash(readFileSync(imageBindingFile)),
    schemaFile,schemaSha256:hash(readFileSync(schemaFile)),rlsInventory:'classpilotPrivateChatLifecyclePostExpand',migrationStage:'expand'};
  return {root,sourceDirectory,git,options,dispose:()=>rmSync(root,{recursive:true,force:true})};
}
function envelopeFiles(root,envelope){
  const usageSourceBindingFile=join(root,'binding.json'),usageSourceReviewFile=join(root,'review.json');
  writeFileSync(usageSourceBindingFile,envelope.bindingRaw);writeFileSync(usageSourceReviewFile,envelope.reviewRaw);
  return {usageSourceBindingFile,usageSourceBindingSha256:envelope.bindingSha256,usageSourceReviewFile,usageSourceReviewSha256:envelope.reviewSha256};
}

function baselineOptions(files){return Object.fromEntries(Object.entries(files).map(([key,value])=>['baseline'+key[0].toUpperCase()+key.slice(1),value]));}
test('paired current-production baseline reserves its own independently reviewed source and ledger',()=>{
  const f=fixture();try{
    const binding=prepareUsageSourceBinding(f.options),baseline=reviewed(binding);
    const candidate=reviewed({...binding,source:'e'.repeat(40),applicationImage:'sha256:'+'f'.repeat(64)});
    const baselineRoot=join(f.root,'baseline'),candidateRoot=join(f.root,'candidate');mkdirSync(baselineRoot);mkdirSync(candidateRoot);
    const directory=join(f.root,'paired'),contract=declareCampaign({directory,kind:'paired',profile:PROFILES.normal.name,
      candidateSource:candidate.binding.source,baselineSource:baseline.binding.source,observedFlagsSha256:'1'.repeat(64),
      ...envelopeFiles(candidateRoot,candidate),...baselineOptions(envelopeFiles(baselineRoot,baseline))});
    assert.deepEqual(contract.order,['A','A','A','B','B','A','A','B']);
    assert.deepEqual(sourceBindingForArm(contract,'A'),baseline);assert.deepEqual(sourceBindingForArm(contract,'B'),candidate);
    const reserved=reserveAttempt({directory,run:'123456abcdef',receiptDirectory:join(f.root,'receipt'),privateDirectory:join(f.root,'private')});
    const reservation=JSON.parse(readFileSync(reserved.reservationFile));
    assert.equal(reservation.source,baseline.binding.source);assert.equal(reservation.usageSourceBindingSha256,baseline.bindingSha256);
    assert.equal(reservation.usageSourceReviewSha256,baseline.reviewSha256);
    assertCampaignSourceBinding(contract,{arm:'A',usageSourceBinding:baseline});
    assert.throws(()=>assertCampaignSourceBinding(contract,{arm:'A',usageSourceBinding:candidate}));
    assert.throws(()=>assertCampaignSourceBinding(contract,{arm:'A'}));
    assert.throws(()=>assertCampaignSourceBinding(contract,{arm:'B',usageSourceBinding:baseline}));
  }finally{f.dispose();}
});
test('baseline binding refuses wrong source, incomplete hashes and use outside a paired campaign before declaration',()=>{
  const f=fixture();try{
    const binding=prepareUsageSourceBinding(f.options),files=baselineOptions(envelopeFiles(f.root,reviewed(binding)));
    const base={directory:join(f.root,'must-not-exist'),kind:'paired',profile:PROFILES.normal.name,candidateSource:'e'.repeat(40),baselineSource:binding.source,observedFlagsSha256:'1'.repeat(64),...files};
    assert.throws(()=>declareCampaign({...base,baselineSource:'f'.repeat(40)}));
    assert.throws(()=>declareCampaign({...base,baselineUsageSourceReviewSha256:undefined}));
    assert.throws(()=>declareCampaign({...base,kind:'mixed',profile:PROFILES.mixed.name}));
    assert.equal(existsSync(base.directory),false);
  }finally{f.dispose();}
});
test('historical paired campaigns retain absent baseline envelopes and reservation fields',()=>{
  const f=fixture();try{
    const directory=join(f.root,'historical'),contract=declareCampaign({directory,kind:'paired',profile:PROFILES.normal.name,
      candidateSource:'e'.repeat(40),baselineSource:'f'.repeat(40),observedFlagsSha256:'1'.repeat(64)});
    assert.equal(Object.hasOwn(contract,'baselineUsageSourceBinding'),false);
    const reserved=reserveAttempt({directory,run:'123456abcdef',receiptDirectory:join(f.root,'receipt'),privateDirectory:join(f.root,'private')});
    const reservation=JSON.parse(readFileSync(reserved.reservationFile));
    assert.equal(Object.hasOwn(reservation,'usageSourceBindingSha256'),false);
    assert.equal(Object.hasOwn(reservation,'usageSourceReviewSha256'),false);
  }finally{f.dispose();}
});

test('deterministic preparation derives the exact source-selected full ledger without calling migrations',()=>{
  const f=fixture();try{
    const binding=prepareUsageSourceBinding(f.options);assert.deepEqual(prepareUsageSourceBinding(f.options),binding);
    assert.equal(binding.expectedMigrations.length,1);assert.equal(binding.expectedMigrations[0].id,'usage-expand');
    assert.equal(binding.status,'prepared_not_approved');for(const key of ['capacityAccepted','productionReadiness','operationalAuthorization'])assert.equal(binding[key],false);
    assert.deepEqual(binding.profiles,Object.fromEntries(['usage','usageDistinct','broader','broaderConcentrated'].map(key=>[key,profileHash(PROFILES[key])])));
    const contract=prepareUsageSourceBinding({...f.options,migrationStage:'contract'});assert.equal(contract.expectedMigrations.length,2);
    assert.notEqual(contract.migrationManifestSha256,binding.migrationManifestSha256);assert.deepEqual(assertUsageSourceCheckout(reviewed(binding),f.sourceDirectory),binding);
    assert.throws(()=>prepareUsageSourceBinding({...f.options,source:'d'.repeat(40)}));
    assert.throws(()=>prepareUsageSourceBinding({...f.options,rlsInventory:'passpilotAppointmentsPostExpand'}));
    writeFileSync(join(f.sourceDirectory,'src/db/uncommitted.ts'),'uncommitted');assert.throws(()=>prepareUsageSourceBinding(f.options),/Freeze and commit/);
  }finally{f.dispose();}
});

test('source rederivation rejects self-consistent forged ledger, registry, tree, and source-input bindings',()=>{
  const f=fixture();try{
    const binding=prepareUsageSourceBinding(f.options);
    for(const mutate of [row=>{row.expectedMigrations[0].checksum='d'.repeat(64);row.migrationManifestSha256=hash(JSON.stringify(row.expectedMigrations));},
      row=>row.registrySha256='d'.repeat(64),row=>row.sourceInputsSha256='d'.repeat(64),row=>row.sourceTree='d'.repeat(40)]){
      const changed=structuredClone(binding);mutate(changed);const forged=reviewed(changed);
      assertReviewedUsageSource(forged);assert.throws(()=>assertUsageSourceCheckout(forged,f.sourceDirectory));
    }
  }finally{f.dispose();}
});

test('review hashes, profile bindings, approval claims, and complete ledger vectors cannot be forged or omitted',()=>{
  const f=fixture();try{
    const envelope=reviewed(prepareUsageSourceBinding(f.options)),files=envelopeFiles(f.root,envelope);
    assert.deepEqual(loadUsageSourceBinding(files),envelope);assert.equal(loadUsageSourceBinding({}),null);
    assert.throws(()=>loadUsageSourceBinding({},{required:true}));assert.throws(()=>loadUsageSourceBinding({usageSourceBindingFile:files.usageSourceBindingFile}));
    for(const mutate of [row=>row.bindingRaw+=' ',row=>row.bindingSha256='0'.repeat(64),row=>row.review.bindingSha256='0'.repeat(64),
      row=>row.reviewRaw+=' ',row=>row.reviewSha256='0'.repeat(64)]){const changed=structuredClone(envelope);mutate(changed);assert.throws(()=>assertReviewedUsageSource(changed));}
    for(const mutate of [row=>row.capacityAccepted=true,row=>row.status='approved',row=>row.profiles.usage='0'.repeat(64),
      row=>row.expectedMigrations=[],row=>row.expectedMigrations[0].status='failed',row=>row.expectedMigrations.push(row.expectedMigrations[0])]){
      const changed=structuredClone(envelope.binding);mutate(changed);assert.throws(()=>assertUsageSourceBinding(changed));
    }
    assert.throws(()=>assertUsageSourceIdentity(envelope,{source:'d'.repeat(40)}));
    assert.throws(()=>assertUsageSourceDatabase(envelope,{migrations:[],tables:envelope.binding.rlsTables}));
    const sameCount=structuredClone(envelope.binding.expectedMigrations);sameCount[0].checksum='e'.repeat(64);
    assert.throws(()=>assertUsageSourceDatabase(envelope,{migrations:sameCount,tables:envelope.binding.rlsTables}));
  }finally{f.dispose();}
});

test('binding bytes participate in helper custody and independent receipt/database replay',()=>{
  const f=fixture();try{
    const envelope=reviewed(prepareUsageSourceBinding(f.options)),name='scripts/load/usage/release-gates-v2/usage-source-binding.json',context=join(f.root,'helper');
    mkdirSync(join(context,'overlay/scripts/load/usage/release-gates-v2'),{recursive:true});json(join(context,'overlay',name),envelope);
    const preparation={applicationSource:envelope.binding.source,applicationImage:envelope.binding.applicationImage,imageBindingSha256:envelope.binding.imageBindingSha256,
      usageSourceBinding:envelope,executedFiles:{[name]:hash(readFileSync(join(context,'overlay',name)))}};
    assert.deepEqual(verifyHelperUsageSourceBinding(preparation,context),envelope);
    assert.throws(()=>verifyHelperUsageSourceBinding({...preparation,usageSourceBinding:undefined},context));
    assert.throws(()=>verifyHelperUsageSourceBinding({...preparation,executedFiles:{[name]:'0'.repeat(64)}},context));
    const receipt=join(f.root,'receipt');mkdirSync(receipt);json(join(receipt,'usage-source-binding.json'),envelope);
    const metrics={source:envelope.binding.source,applicationImage:envelope.binding.applicationImage,schemaSha256:envelope.binding.canonicalSourceSchemaSha256,
      schemaInputSha256:envelope.binding.schemaInputSha256,usageSourceBinding:envelope,databasePreparation:{migrations:envelope.binding.expectedMigrations,
        catalog:envelope.binding.rlsTables.map(relname=>({relname})),registrySha256:envelope.binding.registrySha256}};
    assert.deepEqual(assertUsageSourceReceipt(receipt,metrics),envelope);
    assert.throws(()=>assertUsageSourceReceipt(receipt,{...metrics,usageSourceBinding:undefined}));
    assert.throws(()=>assertUsageSourceReceipt(receipt,{...metrics,schemaSha256:'0'.repeat(64)}));
    assert.throws(()=>assertUsageSourceReceipt(receipt,{...metrics,databasePreparation:{...metrics.databasePreparation,migrations:[]}}));
    // Paired Usage-off candidates bind the same canonical schema; they do not
    // claim the cold fixture's raw input-schema file.
    assert.deepEqual(assertUsageSourceReceipt(receipt,{...metrics,schemaInputSha256:null}),envelope);
    json(join(receipt,'usage-source-binding.json'),{...envelope,reviewSha256:'0'.repeat(64)});assert.throws(()=>assertUsageSourceReceipt(receipt,metrics));
  }finally{f.dispose();}
});

test('successor cold campaigns require reviewed bindings and the unchanged full classroom postcondition',()=>{
  const f=fixture();try{
    const envelope=reviewed(prepareUsageSourceBinding(f.options)),files=envelopeFiles(f.root,envelope);
    const options={directory:join(f.root,'campaign'),kind:'usage',profile:PROFILES.usage.name,candidateSource:f.options.source,observedFlagsSha256:'f'.repeat(64)};
    assert.throws(()=>declareCampaign(options),/reviewed source\/ledger binding/);
    assert.throws(()=>declareCampaign({...options,...files}),/classroom post-verification/);
    const contract=declareCampaign({...options,...files,usagePostVerificationContractSha256:usagePostVerificationHash(),hostHarnessSource:'e'.repeat(40)});
    assert.deepEqual(contract.order,['C','C','C']);assert.equal(contract.contractSha256,profileHash(PROFILES.usage));
    const reserved=reserveAttempt({directory:options.directory,run:'0123456789ab',receiptDirectory:join(f.root,'cold-receipt'),privateDirectory:join(f.root,'private')});
    const reservation=JSON.parse(readFileSync(reserved.reservationFile));assert.equal(reservation.usageSourceBindingSha256,envelope.bindingSha256);assert.equal(reservation.usageSourceReviewSha256,envelope.reviewSha256);
    assert.equal(reservation.usagePostVerificationContractSha256,usagePostVerificationHash());
    const paired=join(f.root,'paired');declareCampaign({...options,...files,directory:paired,kind:'paired',profile:PROFILES.normal.name,baselineSource:'e'.repeat(40)});
    const first=reserveAttempt({directory:paired,run:'0123456789ac',receiptDirectory:join(f.root,'a-receipt'),privateDirectory:join(f.root,'a-private')});
    assert.equal(JSON.parse(readFileSync(first.reservationFile)).usageSourceBindingSha256,undefined);
  }finally{f.dispose();}
});

test('native snapshots replay the complete stage-selected ledger rather than accepting a substituted row count',()=>{
  const f=fixture();try{
    const envelope=reviewed(prepareUsageSourceBinding(f.options)),dir=join(f.root,'snapshot');mkdirSync(dir);
    const data={'prepared-database.private.dump':'synthetic','synthetic-roles.private.sql':'synthetic',
      'cold-fixture-state.json':{},'release-control-preparation.json':{},'preparation-fixture-contract.json':{migrations:envelope.binding.expectedMigrations,rlsContract:{tables:envelope.binding.rlsTables}},
      'preparation-metrics.json':{},'schema-fingerprint.json':{canonicalSha256:envelope.binding.canonicalSourceSchemaSha256},'post-convergence-schema.sql':'synthetic','measurement-ready.json':{}};
    for(const [name,value] of Object.entries(data))writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value));
    const manifest={schemaVersion:1,source:f.options.source,preparedSchoolLocalDate:'2026-10-11',sourceUnchanged:true,timingHeld:true,measurementGoAbsent:true,readOnlyExport:true,
      otherClientsBefore:0,otherClientsAfter:0,timezone:'UTC',databaseEncoding:'UTF8',serverVersion:'16.15',heartbeatRows:2_000_002,migrations:envelope.binding.expectedMigrations.length,
      schoolCounts:[{schoolIndex:0,observations:1_000_001},{schoolIndex:1,observations:1_000_001}],pgImage:'sha256:'+'c'.repeat(64),records:[]};
    const saveManifest=()=>{manifest.records=Object.keys(data).map(file=>{const bytes=readFileSync(join(dir,file));return {file,sha256:hash(bytes),bytes:bytes.length};});json(join(dir,'manifest.json'),manifest);return hash(readFileSync(join(dir,'manifest.json')));};
    assert.equal(loadSnapshot(dir,saveManifest(),{source:f.options.source,today:'2026-10-11',usageSourceBinding:envelope}).manifest.migrations,1);
    data['preparation-fixture-contract.json'].migrations=[{...envelope.binding.expectedMigrations[0],checksum:'0'.repeat(64)}];json(join(dir,'preparation-fixture-contract.json'),data['preparation-fixture-contract.json']);
    assert.throws(()=>loadSnapshot(dir,saveManifest(),{source:f.options.source,today:'2026-10-11',usageSourceBinding:envelope}),/Full migration ledger/);
  }finally{f.dispose();}
});

test('fixture stage must match its reviewed source and a successor receipt cannot strip its binding',()=>{
  const f=fixture();try{
    const envelope=reviewed(prepareUsageSourceBinding(f.options)),file=join(f.root,'fixture-envelope.json');json(file,envelope);
    const env={USAGE_SCALE_SOURCE_BINDING_FILE:file,USAGE_SOURCE_REVISION:f.options.source,APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS:'false'};
    assert.deepEqual(loadFixtureUsageSourceBinding(env),envelope);assert.throws(()=>loadFixtureUsageSourceBinding({...env,APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS:'true'}));
    const root=join(f.root,'stripped');mkdirSync(root);const metrics={source:f.options.source,run:'0123456789ab',profile:PROFILES.usage.name,contractSha256:profileHash(PROFILES.usage),planSha256:'0'.repeat(64)};
    json(join(root,'metrics.json'),metrics);json(join(root,'role-cleanup.json'),{exits:[]});const manifest={schemaVersion:2,source:metrics.source,run:metrics.run,profile:metrics.profile,planSha256:metrics.planSha256,
      records:Object.fromEntries(['metrics.json','role-cleanup.json'].map(name=>[name,hash(readFileSync(join(root,name)))]))};json(join(root,'receipt-manifest.json'),manifest);
    assert.throws(()=>loadReceipt(root,hash(readFileSync(join(root,'receipt-manifest.json'))),join(f.root,'unused-private')),/omitted its reviewed binding/);
  }finally{f.dispose();}
});

test('distinct endpoint registration accepts only the reviewed successor source and exact schema while retaining all workload limits',()=>{
  const f=fixture();try{
    const envelope=reviewed(prepareUsageSourceBinding(f.options)),source=envelope.binding.source,run='0123456789ab',helperImage='sha256:'+'f'.repeat(64);
    const owners=['api0','api1','api2','worker','observer','generator'].map((role,index)=>{const id=String(index+1).repeat(64);return {role,id,source,helperImage,
      ready:{binding:{run,source,role,containerId:id}},rpc:()=>{throw Error('No RPC in pure registration test');}};});
    const registration={usageSourceBinding:envelope,source,run,helperImage,profile:PROFILES.usageDistinct.name,
      ownerBindings:owners.map(({ready,helperImage})=>({...ready.binding,helperImage})),operationContractSha256:distinctEndpointOperationHash(),reportContractSha256:distinctReportContractHash(),
      helperBindingSha256:'a'.repeat(64),snapshotManifestSha256:'b'.repeat(64),restorationReceiptSha256:'c'.repeat(64),operationalFixtureReceiptSha256:'d'.repeat(64),
      schemaInputSha256:envelope.binding.schemaInputSha256,canonicalSourceSchemaSha256:envelope.binding.canonicalSourceSchemaSha256,
      actualRestorationPassed:true,healthHookAppliedAfterOriginalVerification:true,healthHookRelabeledCanonicalSchema:false,sessionCookiePathVerified:true,
      generatedEndpointOverrideVerified:true,nativeHeavyObservationCounts:[1_000_000,1_000_000],serviceLimits:{...DISTINCT_SERVICE_LIMITS}};
    const auxiliary={worker:owners[3],observer:owners[4],generator:owners[5]},fixture={sourceRevision:source};
    assert.equal(validateDistinctRegistration(registration,fixture,owners.slice(0,3),auxiliary),true);
    assert.throws(()=>verifyDistinctEndpointReportResult({source},{},fixture,{}));
    assert.throws(()=>verifyDistinctPostProof({source},{},fixture));
    for(const mutate of [row=>delete row.usageSourceBinding,row=>row.schemaInputSha256='0'.repeat(64),row=>row.canonicalSourceSchemaSha256='0'.repeat(64),
      row=>row.serviceLimits.workerAcceptanceMs++,row=>row.nativeHeavyObservationCounts[0]--]){const changed=structuredClone(registration);mutate(changed);
      assert.throws(()=>validateDistinctRegistration(changed,fixture,owners.slice(0,3),auxiliary));}
  }finally{f.dispose();}
});

test('bound fixture executor selects the exact expand plan under test mode and never invokes contract apply',async()=>{
  const f=fixture();try{
    const envelope=reviewed(prepareUsageSourceBinding(f.options)),calls=[],expand={...envelope.binding.expectedMigrations[0],apply:async()=>calls.push('expand')},
      contract={id:'staff-contract',checksum:'b'.repeat(64),apply:async()=>calls.push('contract')};
    const manifest={schoolPilot27ExpandMigrations:[expand],schoolPilot27Migrations:[expand,contract]};let rows=[];
    const pool={query:async sql=>({rows:sql.includes('pg_class')?envelope.binding.rlsTables.map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true})):rows})};
    const executeLedger=async({migrations,applicationSha})=>{assert.equal(applicationSha,envelope.binding.source);for(const migration of migrations)await migration.apply();rows=migrations.map(({id,checksum})=>({id,checksum,status:'complete'}));};
    const result=await migrateBoundUsageFixture({envelope,manifest,pool,executeLedger,registrySha256:envelope.binding.registrySha256});
    assert.deepEqual(calls,['expand']);assert.equal(result.migrationStage,'expand');assert.equal(result.completedMigrations,1);assert.equal(result.capacityAccepted,false);
    rows=[];calls.length=0;
    await assert.rejects(migrateBoundUsageFixture({envelope,manifest:{...manifest,schoolPilot27ExpandMigrations:[expand,contract]},pool,executeLedger,registrySha256:envelope.binding.registrySha256}),/Compiled fixture manifest/);
    assert.deepEqual(calls,[]);
    for(const name of ['run-local-usage-scale.ps1','roles/run-role-scale.ps1']){
      const script=readFileSync(join(repo,'scripts/load/usage',name),'utf8');
      assert.match(script,/if \(\$UsageSourceBindingConfig\) \{\s*\$env:USAGE_LOCAL_SCALE = '1'; \$env:USAGE_SCALE_CONTAINER = \$container[\s\S]*?migrate-bound-fixture\.mjs[\s\S]*?\} else \{\s*\$env:RUN_LEGACY_MIGRATIONS_ONLY = 'true'/);
    }
  }finally{f.dispose();}
});
