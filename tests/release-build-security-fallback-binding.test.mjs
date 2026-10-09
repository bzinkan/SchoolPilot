import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_SECURITY_BINDING_ID, BUILD_SECURITY_SOURCE, BUILD_SECURITY_SOURCE_REVIEW,
  CP_PROTECTED_BINDING_ID, BINDING_FILES, bindingSchema, bindingHash, validateReviewedProtectedDelta,
  validateCompilerOnlyManifestDelta, validateCompilerOnlyLockDelta, validateSuccessorPreparation, validateProtectedBuildDependencyAudit,
  validateBuildSecurityOutputEquivalence, validateBuildSecurityTestLog, validateSuccessorProfile, validateBindingProfile, validateProtectedExecutionEvidence, successorArtifactPair, validateBuildSecurityRestrictedReplayApplicability, validateBuildSecurityExecutionPair,
  bindingForRole, assertBoundPublication, assertBoundScan, assertBindingReplay, resolveReleaseBinding, replayBuildSecurityRawEvidence } from '../scripts/release-source-binding.mjs';
import { FALLBACK, createPlan, createAnchor128Plan, retainSuccessorRegistration, inventoryFor, renderRequest, validateSourceResponse } from '../scripts/register-compatible-fallback-inactive.mjs';
import { planPublication, planUnused121, planCurrent129Anchor, renderCurrent129Pair } from '../scripts/prepare-release-artifacts.mjs';
import { BUILD_SECURITY_ACCEPTANCE_ID, CP_PROTECTED_ACCEPTANCE_ID, BUILD_SECURITY_ACCEPTANCE_CANDIDATE_IDENTITIES as ACCEPTANCE_CANDIDATE_IDENTITIES, ACCEPTANCE_CANDIDATE_IDENTITIES as HISTORICAL_CANDIDATE_IDENTITIES,
  ACCEPTANCE_BASELINE, ACCEPTANCE_BASELINE_IMAGE, FIXED_ORDER, SUCCESSOR_PROFILES,
  assertAcceptanceSuccessorIdentity, assertProtectedAcceptanceBuildSecurity, assertOrdinaryMigrationConnectionRole } from '../scripts/load/usage/release-gates-v2/acceptance-successor.mjs';
import { profileHash } from '../scripts/load/usage/release-gates-v2/contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = { schemaVersion: 5, releaseBindingId: BUILD_SECURITY_BINDING_ID };
const shipped = () => JSON.parse(readFileSync(path.join(root, BINDING_FILES[BUILD_SECURITY_BINDING_ID])));
const digest = text => 'sha256:' + bindingHash(text);

test('v5 raw replay bounds concurrency at four and checks every record before any permitted mutation', async () => {
  const records=Array.from({length:11},(_,index)=>({index}));
  for (const fail of [false,true,'synchronous']) {
    let active=0,maximum=0,mutations=0;const started=[],finished=[];
    const load=record=>{started.push(record.index);active++;maximum=Math.max(maximum,active);if(fail==='synchronous'&&[1,7].includes(record.index)){active--;finished.push(record.index);throw Error('synthetic rejected raw check');}return new Promise(resolve=>setTimeout(resolve,2)).then(()=>{active--;finished.push(record.index);if(fail===true&&[1,7].includes(record.index))throw Error('synthetic rejected raw check');return record;});};
    const operation=async()=>{await replayBuildSecurityRawEvidence(records,load);mutations++;};
    if(fail)await assert.rejects(operation(),/synthetic rejected raw check/);else await operation();
    assert.equal(maximum,4);assert.equal(active,0);assert.deepEqual(started,records.map(row=>row.index));assert.deepEqual(finished.sort((a,b)=>a-b),records.map(row=>row.index));assert.equal(mutations,fail?0:1);
  }
});

test('v5 replays raw recovery pair JSON rather than accepting the claimed current pair beside an older reference', async () => {
  const profile = shipped(), pair = successorArtifactPair(profile), directory = path.resolve(tmpdir(), 'synthetic-pair-root');
  const record = {storage:'private',path:'pair-A2.json',sha256:bindingHash('synthetic A2 pair'),format:'json'};
  const native = {artifactPair:pair,artifactPairBinding:record,rawEvidence:[record]};
  const execution = {artifactPairBinding:{path:path.join(directory,record.path),sha256:record.sha256}};
  const check = (n=native,e=execution,value=pair) => validateBuildSecurityExecutionPair(e,n,profile,directory,async pinned=>{assert.deepEqual(pinned,n.artifactPairBinding);return value;});
  await check();
  const priorPair=structuredClone(pair);priorPair['serving-anchor'].source='ecf6ce0100e758f5668c5a26427c1c0ea82ea0a2';
  await assert.rejects(check(native,execution,priorPair),/BUILD_SECURITY_RAW_PAIR_CHANGED/);
  for (const field of ['localIndex','config','platform','archiveSha256']) { const changed=structuredClone(pair);changed.fallback[field]=bindingHash('substitution');await assert.rejects(check(native,execution,changed),/BUILD_SECURITY_RAW_PAIR_CHANGED/); }
  await assert.rejects(check({...native,artifactPairBinding:{...record,path:'old-pair.json',sha256:bindingHash('old pair')}},execution),/BUILD_SECURITY_RAW_PAIR_REQUIRED/);
  await assert.rejects(check(native,{artifactPairBinding:{path:path.join(directory,'old-pair.json'),sha256:record.sha256}}),/BUILD_SECURITY_EXECUTION_PAIR_CHANGED/);
  await assert.rejects(check({...native,rawEvidence:[]},execution),/BUILD_SECURITY_RAW_PAIR_REQUIRED/);
  await assert.rejects(check(native,execution,{...pair,other:pair.fallback}),/BUILD_SECURITY_RAW_PAIR_ROLES_CHANGED/);
});

test('v5 admits only the build security ID without changing earlier version pairs', () => {
  assert.equal(bindingSchema(input), 5);
  for (const change of [{releaseBindingId:CP_PROTECTED_BINDING_ID}, {releaseBindingId:'unknown'}, {schemaVersion:4}, {artifactSource:BUILD_SECURITY_SOURCE}]) assert.throws(() => bindingSchema({...input,...change}));
  assert.equal(bindingSchema({schemaVersion:4,releaseBindingId:CP_PROTECTED_BINDING_ID}),4);
  assert.equal(bindingSchema({schemaVersion:1}),1);
});

test('v5 restricted migration review records queried table ownership without claiming public-schema ownership', () => {
  const role = { superuser:false, bypassRls:false, inherit:false, schemaOwner:false, applicationTableOwner:true, schemaUsageAndCreate:true };
  assertOrdinaryMigrationConnectionRole(role, {id:BUILD_SECURITY_ACCEPTANCE_ID});
  for (const key of Object.keys(role)) assert.throws(() => assertOrdinaryMigrationConnectionRole({...role,[key]:!role[key]}, {id:BUILD_SECURITY_ACCEPTANCE_ID}));
  assert.throws(() => assertOrdinaryMigrationConnectionRole({...role,applicationTableOwner:undefined}, {id:BUILD_SECURITY_ACCEPTANCE_ID}));
  const historical = {superuser:false,bypassRls:false,inherit:false,schemaOwner:true,schemaUsageAndCreate:true};
  assertOrdinaryMigrationConnectionRole(historical,{id:CP_PROTECTED_ACCEPTANCE_ID});
  assert.throws(() => assertOrdinaryMigrationConnectionRole(role,{id:CP_PROTECTED_ACCEPTANCE_ID}));
});

test('pending v5 evidence and invalid operational Plans reject before commands, cloud mutation or output creation', async () => {
  const calls = [], run = async (...args) => {calls.push(args);throw Error('unexpected external work');};
  const directory=mkdtempSync(path.join(tmpdir(),'sp-build-security-pending-')); const profile=shipped();profile.preparation.status='pending';
  try {const file=path.join(directory,BINDING_FILES[BUILD_SECURITY_BINDING_ID]);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(profile));await assert.rejects(resolveReleaseBinding(input,{root:directory,run,fallback:FALLBACK}),/SUCCESSOR_PREPARATION_PENDING/);}
  finally {assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(directory).startsWith('sp-build-security-pending-'));rmSync(directory,{recursive:true});}
  for (const operation of [planPublication, planCurrent129Anchor, createPlan, createAnchor128Plan]) await assert.rejects(operation({...input,releaseBindingId:'unknown',kind:'serving-anchor'}, {run}), /RELEASE_BINDING_NOT_ALLOWLISTED/);
  await assert.rejects(planUnused121(input,{run}),/CURRENT129_OPERATION_REQUIRED/);
  assert.deepEqual(calls, []);
  assert.equal(shipped().operationalAuthorization,false);
});

test('compiler-only manifest correction cannot change runtime packages, source scripts or other metadata', () => {
  const before={name:'synthetic',scripts:{build:'tsc && tsc-alias',start:'node dist/index.js'},dependencies:{sharp:'synthetic'},devDependencies:{'tsc-alias':'synthetic',typescript:'synthetic'}};
  const after=structuredClone(before);after.scripts.build='tsc';delete after.devDependencies['tsc-alias'];
  validateCompilerOnlyManifestDelta(before,after);
  for (const mutate of [v=>{v.dependencies.sharp='different';},v=>{v.scripts.start='different';},v=>{v.name='different';},v=>{v.scripts.build='tsc --skipLibCheck';},v=>{v.devDependencies.typescript='different';}]) {const copy=structuredClone(after);mutate(copy);assert.throws(()=>validateCompilerOnlyManifestDelta(before,copy));}
});
test('compiler lock correction permits only removed development records and preserves every retained runtime record', () => {
  const before={lockfileVersion:3,packages:{'':{devDependencies:{'tsc-alias':'synthetic',typescript:'synthetic'}},'node_modules/tsc-alias':{version:'synthetic',dev:true},'node_modules/dev-child':{version:'synthetic',dev:true},'node_modules/runtime':{version:'synthetic'}}};
  const after=structuredClone(before);delete after.packages[''].devDependencies['tsc-alias'];delete after.packages['node_modules/tsc-alias'];delete after.packages['node_modules/dev-child'];validateCompilerOnlyLockDelta(before,after);
  for(const mutate of [v=>{delete v.packages['node_modules/runtime'];},v=>{v.packages['node_modules/runtime'].version='changed';},v=>{v.packages['node_modules/new']={version:'unreviewed',dev:true};},v=>{v.lockfileVersion=2;}]){const copy=structuredClone(after);mutate(copy);assert.throws(()=>validateCompilerOnlyLockDelta(before,copy));}
});

test('v5 zero-count audit cannot hide High entries or failed exact-source builds/tests', () => {
  const profile=shipped(),record=(name)=>({storage:'private',format:'text',path:`source-checks/${name}.log`,sha256:bindingHash(name)}),checks={};
  for(const name of ['dependencyInstall','backendType','backendBuild','credentialBoundarySynthetic','unit'])checks[name]={status:'passed',exitCode:0,evidence:{...record(name),tests:1,passed:1,failed:0,skipped:0,cancelled:0}};
  checks.fullDependencyAudit={status:'passed',exitCode:0,high:0,critical:0,evidence:profile.buildDependencyAudit.audit};
  const sourceChecks={schemaVersion:1,evidenceKind:'protected-fallback-source-checks',source:BUILD_SECURITY_SOURCE,cleanSource:true,checks,rawEvidence:Object.values(checks).map(row=>row.evidence)};
  const audit={auditReportVersion:2,vulnerabilities:{},metadata:{vulnerabilities:{info:0,low:0,moderate:7,high:0,critical:0,total:7}}};validateProtectedBuildDependencyAudit(audit,sourceChecks,profile);
  for(const mutate of [v=>{v.audit.vulnerabilities.synthetic={severity:'high'};},v=>{v.audit.metadata.vulnerabilities.high=1;},v=>{v.sourceChecks.source=profile.previousFallback.source;},v=>{v.sourceChecks.checks.backendBuild.exitCode=1;},v=>{v.sourceChecks.checks.unit.evidence.failed=1;},v=>{v.sourceChecks.checks.unit.evidence.tests=2;},v=>{v.sourceChecks.rawEvidence=[];},v=>{v.profile.buildDependencyAudit.lockfileGitBlob='a'.repeat(40);}]){const copy=structuredClone({profile,audit,sourceChecks});mutate(copy);assert.throws(()=>validateProtectedBuildDependencyAudit(copy.audit,copy.sourceChecks,copy.profile));}
  const log='# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# cancelled 0\n';validateBuildSecurityTestLog(log,{tests:2,passed:1,failed:0,skipped:1,cancelled:0});assert.throws(()=>validateBuildSecurityTestLog(log.replace('# fail 0','# fail 1'),{tests:2,passed:1,failed:0,skipped:1,cancelled:0}));
});

test('passed preparation profile never substitutes for pending selection or original candidate campaigns', () => {
  const profile=shipped();profile.preparation.status='passed';
  profile.successorSelection={status:'pending',path:null,sha256:null};
  for(const [key,value]of Object.entries(profile.preparation.evidence))Object.assign(value,{status:'passed',path:`docs/release-evidence/synthetic-v5/${key}.json`,sha256:bindingHash(`synthetic-${key}`)});
  validateSuccessorProfile(profile,FALLBACK);
  assert.throws(()=>validateBindingProfile(profile,BUILD_SECURITY_BINDING_ID,FALLBACK),/SUCCESSOR_SELECTION_PENDING|RELEASE_BINDING_EVIDENCE_PENDING/);
  for(const mutate of [v=>{v.currentRuntime.source='a'.repeat(40);},v=>{v.currentRuntime.controls.sha256=bindingHash('substituted controls');},v=>{v.currentRuntime.admissionCount=128;}]){const value=structuredClone(profile);mutate(value);assert.throws(()=>validateSuccessorProfile(value,FALLBACK),/BUILD_SECURITY_CURRENT_RUNTIME_CHANGED/);}
});

test('v5 current A3 contract rejects earlier A2 candidate and superseded179/195 runtime references',()=>{
  const profile=shipped();profile.preparation.status='passed';
  const priorCandidate=structuredClone(profile);priorCandidate.applicationSource='55f91b620d2d48de5ed164a72250ec133450bc0f';
  assert.throws(()=>validateSuccessorProfile(priorCandidate,FALLBACK),/CP_PROTECTED_APPLICATION_SOURCE_CHANGED/);
  for(const mutate of [value=>{value.currentRuntime.source='a14759a231ef47ad01951e8b9519c87de39433bc';},value=>{value.currentRuntime.review.path='current-serving-129/state-review.private.json';value.currentRuntime.review.sha256='719cdcc5d4dd547a07127def1212091374d581fbae13ed1ed1756aff31955edc';}]){
    const value=structuredClone(profile);mutate(value);assert.throws(()=>validateSuccessorProfile(value,FALLBACK),/BUILD_SECURITY_CURRENT_RUNTIME_CHANGED/);
  }
});

function current129Fixture() {
  const profile=shipped(),controls={CLASSPILOT_CAP_FOCUS_TAB_V1:'true',CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1:'true',CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1:'true',CLASSPILOT_PROTOCOL_V3_ENABLED:'true',CLASSPILOT_CAPABILITY_ROLLOUTS_JSON:JSON.stringify({focusTabV1:{mode:'on'},preciseRestrictionResourcesV1:{mode:'on'},privateChatLifecycleV1:{mode:'on'}})};
  const binding={schemaVersion:5,id:BUILD_SECURITY_BINDING_ID,currentRuntime:{...profile.currentRuntime,capabilityEnvironment:controls}},sources={};
  for(const role of ['api','scheduler-worker']){const family=role==='api'?'schoolpilot-production-api-emergency':'schoolpilot-production-scheduler-worker';sources[role]={taskDefinition:{taskDefinitionArn:`arn:aws:ecs:${FALLBACK.region}:${FALLBACK.account}:task-definition/${family}:200`,status:'ACTIVE',family,cpu:role==='api'?'1024':'512',memory:role==='api'?'2048':'1024',networkMode:'awsvpc',requiresCompatibilities:['FARGATE'],containerDefinitions:[{name:role,image:`${FALLBACK.account}.dkr.ecr.${FALLBACK.region}.amazonaws.com/${FALLBACK.repository}@${profile.currentRuntime.image}`,command:['node',role==='api'?'dist/index.js':'dist/worker.js'],secrets:[{name:'DATABASE_URL',valueFrom:'synthetic-secret-reference'}],environment:Object.entries({...controls,GIT_SHA:profile.currentRuntime.source,SERVICE_NAME:role,RLS_GUC_ENABLED:'true',RLS_ENABLED_TABLES:inventoryFor(129).join(','),CLASSPILOT_USAGE_ROLLUP_MODE:'off',CLASSPILOT_DIGITAL_USAGE_MODE:'off',UNRELATED_SYNTHETIC_SETTING:'preserve-exactly'}).map(([name,value])=>({name,value}))}]}};}
  const live={services:Object.entries(sources).map(([role,response])=>({serviceName:`schoolpilot-production-${role}`,taskDefinition:response.taskDefinition.taskDefinitionArn,status:'ACTIVE',runningCount:1,desiredCount:1,pendingCount:0,deployments:[{status:'PRIMARY',rolloutState:'COMPLETED'}]})),failures:[]};return {profile,binding,sources,live};
}
test('v5 current129 anchor preserves existing enabled capabilities and every unrelated environment/secret field', () => {
  const f=current129Fixture(),target=f.profile.artifacts['serving-anchor'];
  const requests=renderCurrent129Pair(f.sources,f.live,target.source,target.platform,f.binding);
  for(const role of ['api','scheduler-worker']){const original=f.sources[role].taskDefinition.containerDefinitions[0],actual=requests[role].containerDefinitions[0];assert.deepEqual(actual.secrets,original.secrets);assert.deepEqual(actual.command,original.command);assert.deepEqual(actual.environment.filter(row=>row.name!=='GIT_SHA'),original.environment.filter(row=>row.name!=='GIT_SHA'));assert.equal(actual.environment.find(row=>row.name==='GIT_SHA').value,target.source);assert.equal(actual.image,`${FALLBACK.account}.dkr.ecr.${FALLBACK.region}.amazonaws.com/${FALLBACK.repository}@${target.platform}`);}
  for(const mutate of [v=>{v.binding.schemaVersion=4;},v=>{v.binding.id='unknown';},v=>{v.sources.api.taskDefinition.containerDefinitions[0].environment.find(row=>row.name==='CLASSPILOT_CAP_FOCUS_TAB_V1').value='false';},v=>{v.sources.api.taskDefinition.containerDefinitions[0].environment.find(row=>row.name==='RLS_ENABLED_TABLES').value=inventoryFor(128).join(',');},v=>{v.sources.api.taskDefinition.containerDefinitions[0].environment.find(row=>row.name==='CLASSPILOT_USAGE_ROLLUP_MODE').value='on';},v=>{v.live.services[0].runningCount=0;},v=>{v.sources.api.taskDefinition.containerDefinitions[0].environment.find(row=>row.name==='GIT_SHA').value=target.source;},v=>{v.sources.api.taskDefinition.containerDefinitions[0].image='synthetic-substitution';}]){const copy=structuredClone(f);mutate(copy);assert.throws(()=>renderCurrent129Pair(copy.sources,copy.live,target.source,target.platform,copy.binding));}
  assert.throws(()=>validateSourceResponse(f.sources.api,'api',f.profile.currentRuntime.source,f.profile.currentRuntime.image,inventoryFor(129)),/NEW_ISSUANCE_MUST_BE_OFF/);
  const response=structuredClone(f.sources.api);response.taskDefinition.containerDefinitions[0].image=`${FALLBACK.account}.dkr.ecr.${FALLBACK.region}.amazonaws.com/${FALLBACK.repository}@${target.platform}`;response.taskDefinition.containerDefinitions[0].environment.find(row=>row.name==='GIT_SHA').value=target.source;
  const fallback=renderRequest(response,'api',target.source,target.platform,f.profile.fallback.platform,129,f.binding);assert.deepEqual(fallback.containerDefinitions[0].environment,response.taskDefinition.containerDefinitions[0].environment);
  assert.throws(()=>renderRequest(response,'api',target.source,target.platform,f.profile.fallback.platform,128,f.binding));
  const daily=structuredClone(f);daily.sources.api.taskDefinition.containerDefinitions[0].environment.push({name:'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE',value:'on'});assert.throws(()=>renderCurrent129Pair(daily.sources,daily.live,target.source,target.platform,daily.binding),/CURRENT129_DAILY_ROLLUP_DRIFT/);
});

test('real Git fixture pins the exact two manifests, modes and patch while runtime inputs stay unchanged', async () => {
  const directory=mkdtempSync(path.join(tmpdir(),'sp-build-security-git-'));
  const git=args=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',windowsHide:true});
  const run=async(executable,args)=>({code:0,stdout:execFileSync(executable,args,{encoding:'utf8',windowsHide:true})});
  const commit=()=>{git(['add','.']);git(['-c','core.hooksPath=NUL','commit','-qm','Synthetic manifest fixture']);return git(['rev-parse','HEAD']).trim();};
  try {
    git(['init','-q']);git(['config','user.name','Synthetic fixture']);git(['config','user.email','fixture@example.invalid']);git(['config','core.autocrlf','false']);
    writeFileSync(path.join(directory,'package.json'),'{"scripts":{"build":"tsc && tsc-alias"}}\n');writeFileSync(path.join(directory,'package-lock.json'),'{"synthetic":"before"}\n');writeFileSync(path.join(directory,'Dockerfile'),'FROM synthetic.invalid/pinned\n');const baseline=commit();
    writeFileSync(path.join(directory,'package.json'),'{"scripts":{"build":"tsc"}}\n');writeFileSync(path.join(directory,'package-lock.json'),'{"synthetic":"after"}\n');const source=commit();
    const entry=(ref,name)=>{const row=/^(\d{6}) blob ([a-f0-9]{40})\t/.exec(git(['ls-tree',ref,'--',name]).trim());return{mode:row[1],object:row[2]};};
    const review={baseline,source,files:['package-lock.json','package.json'].map(name=>({path:name,before:entry(baseline,name),after:entry(source,name)})),patchSha256:bindingHash(git(['diff','--binary','--full-index','--no-ext-diff','--no-textconv',baseline,source]))};
    assert.deepEqual(await validateReviewedProtectedDelta(directory,review,run),review);
    const swapped=structuredClone(review);swapped.files[0].after.object='a'.repeat(40);await assert.rejects(validateReviewedProtectedDelta(directory,swapped,run),/REVIEWED_BLOB_CHANGED/);
    await assert.rejects(validateReviewedProtectedDelta(directory,{...review,patchSha256:bindingHash('tampered')},run),/REVIEWED_PATCH_CHANGED/);
    writeFileSync(path.join(directory,'Dockerfile'),'FROM synthetic.invalid/unreviewed\n');const moved=commit();await assert.rejects(validateReviewedProtectedDelta(directory,{...review,source:moved},run),/SOURCE_DELTA_EXCEEDED/);
  } finally {const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('sp-build-security-git-'));rmSync(resolved,{recursive:true});}
});

function outputFixture() {
  const profile=shipped(),pins=profile.compiledOutputEquivalence,files=[{path:'services/example.js',bytes:12,sha256:bindingHash('synthetic compiled output')}];
  const execution={schemaVersion:1,kind:'actual_fallback_compiled_output_equivalence',f2Source:profile.previousFallback.source,f3Source:BUILD_SECURITY_SOURCE,source:BUILD_SECURITY_SOURCE,artifactRole:'fallback',complete:true,passed:true,cleanSources:true,cleanSource:true,runtimeDependenciesEqual:true,failedTests:0,npmCiExitCode:0,f2NpmCiExitCode:0,f3NpmCiExitCode:0,f2BuildExitCode:0,aliasExitCode:0,f3BuildExitCode:0,buildExitCode:0,beforeAliasSha256:pins.beforeAlias.sha256,afterAliasSha256:pins.afterAlias.sha256,successorSha256:pins.successor.sha256,observedAtUtc:'2026-10-09T13:01:00Z',commands:[{exitCode:0},{exitCode:0}],changedCompiledFiles:[],fileCount:1};
  const inventories=['beforeAlias','afterAlias','successor'].map(phase=>({source:phase==='successor'?BUILD_SECURITY_SOURCE:profile.previousFallback.source,phase,files:structuredClone(files)}));
  const review={schemaVersion:1,kind:'release297_build_security_compiled_output_independent_review',passed:true,fullIndependentReviewComplete:true,independentFromProducer:true,executionSha256:pins.execution.sha256,reviewer:'synthetic independent reviewer',producer:'synthetic producer',observedAtUtc:'2026-10-09T13:02:00Z'};
  return{profile,execution,inventories,review};
}
test('actual compiled-output contract rejects failure flags, omitted files, byte changes and self-review', () => {
  const fixture=outputFixture(),check=value=>validateBuildSecurityOutputEquivalence(value.execution,...value.inventories,value.review,value.profile);check(fixture);
  for (const mutate of [v=>{v.execution.f3BuildExitCode=1;},v=>{v.execution.complete=false;},v=>{v.execution.cleanSources=false;},v=>{v.execution.runtimeDependenciesEqual=false;},v=>{v.execution.beforeAliasSha256=bindingHash('wrong');},v=>{v.inventories[0].files=[];},v=>{v.inventories[1].files[0].bytes=13;},v=>{v.inventories[2].files[0].sha256=bindingHash('changed');},v=>{v.inventories[2].source=v.profile.previousFallback.source;},v=>{v.review.reviewer=v.review.producer;},v=>{v.review.passed=false;}]) {const copy=structuredClone(fixture);mutate(copy);assert.throws(()=>check(copy));}
});

test('v5 artifact roles, validator dependencies and partial registration uncertainty remain exact', () => {
  const pair=successorArtifactPair(shipped()),binding={id:BUILD_SECURITY_BINDING_ID,schemaVersion:5,sha256:bindingHash('synthetic profile'),validatorSha256:bindingHash('synthetic validator'),artifactPair:pair,operationToolDependencies:{'scripts/deploy.sh':bindingHash('synthetic deployment')}};
  const fallback=bindingForRole(binding,'fallback'),anchor=bindingForRole(binding,'serving-anchor');
  const receipt={schemaVersion:5,releaseBinding:fallback,artifactSource:pair.fallback.source,artifactRole:'fallback',source:pair.fallback.source,registryDigest:pair.fallback.platform,status:'published',publicationOutcomeUncertain:false,operation:'PublishImage',servicesUpdated:0,tasksLaunched:0,productionDatabaseOperations:0};
  assertBoundPublication(receipt,fallback,pair.fallback.source,pair.fallback.platform);
  assert.throws(()=>assertBoundPublication({...receipt,releaseBinding:anchor},fallback,pair.fallback.source,pair.fallback.platform));
  assert.throws(()=>assertBoundPublication({...receipt,artifactRole:'serving-anchor'},fallback,pair.fallback.source,pair.fallback.platform));
  assertBoundScan({sourceSha:pair.fallback.source,imageId:pair.fallback.localIndex,configDigest:pair.fallback.config,passed:true},fallback);
  assert.throws(()=>assertBoundScan({sourceSha:pair['serving-anchor'].source,imageId:pair['serving-anchor'].localIndex,configDigest:pair['serving-anchor'].config,passed:true},fallback));
  assert.throws(()=>assertBindingReplay(input,fallback,{...fallback,operationToolDependencies:{'scripts/deploy.sh':bindingHash('changed deployment')}}));
  const result={schemaVersion:5,registered:[],registrationOutcomeUncertain:true};assert.equal(retainSuccessorRegistration(result,'api',{taskDefinition:{taskDefinitionArn:'uncertain-returned-identity'}},bindingHash('request'),'expected-family'),'uncertain-returned-identity');assert.equal(result.registered[0].arn,'uncertain-returned-identity');assert.equal(result.registrationOutcomeUncertain,true);
});

test('v5 ordinary recovery rejects F2 images, historical54, mixed pairs, repeated IDs and unclean drains', () => {
  const profile=shipped(),execution={schemaVersion:1,source:profile.applicationSource,releaseBindingId:BUILD_SECURITY_BINDING_ID,productionMutations:0,capacityAccepted:false,actualApiWorkerProcesses:true,syntheticSchemaOnly:true,operationalAuthorization:false,releaseReady:false,providerAccessDisabled:true,completedInsideAuthorizedWindow:true,startedAt:'2026-10-09T13:10:00Z',completedAt:'2026-10-09T13:11:00Z',passed:true,cleanupPassed:true,gracefulCleanupPassed:true,networkCleanupPassed:true,localAdmissionFloorVerified:true,admissionChain:[121,125,126,127,128,129].map(count=>({count})),sourceSpecificNative:{baseline:{nativeCompletedMigrations:Array.from({length:43},(_,i)=>i)},candidate:{nativeCompletedMigrations:Array.from({length:53},(_,i)=>i)}},services:[],drains:[]};
  for(const phase of ['bridge128','adopt129','fallback129','return129'])for(const service of ['api','worker']){const artifact=profile.artifacts[phase==='fallback129'?'fallback':'serving-anchor'],containerId=bindingHash(`synthetic-v5-${phase}-${service}`);execution.services.push({phase,service,containerId,source:artifact.source,image:artifact.localIndex,inventoryCount:phase==='bridge128'?128:129,privateEnabled:phase==='adopt129',...(service==='api'?{readyzStatus:200}:{})});execution.drains.push({phase,service,containerId,sourceImage:artifact.localIndex,exitCode:0,oomKilled:false,forced:false,sqlConnections:0});}
  const baseline={source:ACCEPTANCE_BASELINE,localIndex:ACCEPTANCE_BASELINE_IMAGE};
  for(const [arm,count,artifact]of [['baseline',43,baseline],['candidate',53,profile.artifacts['serving-anchor']]])Object.assign(execution.sourceSpecificNative[arm],{passed:true,clientEnded:true,source:artifact.source,applicationImage:artifact.localIndex,nativeCompletedMigrations:Array.from({length:count},(_,i)=>({id:`synthetic-migration-${i}`,checksum:bindingHash(`synthetic-${arm}-${i}`),status:'complete'}))});
  execution.migrationExecutions=['baseline','candidate','candidate','candidate','candidate','candidate','fallback','candidate'].map(arm=>{const artifact=arm==='baseline'?baseline:profile.artifacts[arm==='fallback'?'fallback':'serving-anchor'];return{arm,source:artifact.source,image:artifact.localIndex,exitCode:0,oomKilled:false,namedSqlConnections:0,actualEntrypoint:'node dist/index.js',NODE_ENV:'production'};});
  execution.cleanup=[{removed:true,graceful:true,forced:false,exitCode:0,oomKilled:false}];
  execution.migrationOwnershipChecks=['constructor','baseline43','candidate53','fallbackRetains53','candidateReturn53'].map(phase=>({phase,observedAtUtc:'2026-10-09T13:10:30Z',role:{role:'synthetic_migration_owner',rolsuper:false,rolbypassrls:false,rolinherit:false,schema_owner:false,schema_usage:true,schema_create:true},applicationTables:[{table_name:'synthetic_source_table',owner:'synthetic_migration_owner',owned:true}],applicationTableCount:1,allApplicationTablesOwned:true,excludedOperationalFixtureTables:[],excludedSourceApplicationTables:0,clientEnded:true,namedMigrationOwnershipConnections:0}));
  const native={observedAtUtc:'2026-10-09T13:12:00Z'};validateProtectedExecutionEvidence(execution,native,profile,'ordinaryRecovery');
  for(const mutate of [v=>{v.sourceSpecificNative.candidate.nativeCompletedMigrations.push(53);},v=>{v.releaseBindingId=CP_PROTECTED_BINDING_ID;},v=>{v.services[4].source=profile.previousFallback.source;},v=>{v.services[4].image=profile.previousFallback.localIndex;},v=>{v.services[4].image=profile.artifacts['serving-anchor'].localIndex;},v=>{for(const row of [...v.services,...v.drains])row.containerId='a'.repeat(64);},v=>{v.drains[4].sqlConnections=1;},v=>{v.drains[4].forced=true;},v=>{v.startedAt='2026-10-08T23:59:00Z';},v=>{v.sourceSpecificNative.candidate.passed=false;},v=>{v.migrationExecutions[6].exitCode=1;},v=>{v.migrationExecutions[6].namedSqlConnections=1;},v=>{v.cleanup[0].forced=true;},v=>{delete v.migrationOwnershipChecks;},v=>{v.migrationOwnershipChecks[2].role.schema_owner=true;},v=>{v.migrationOwnershipChecks[3].applicationTables[0].owned=false;},v=>{v.migrationOwnershipChecks[3].excludedOperationalFixtureTables=[{table_name:'source_table'}];},v=>{v.migrationOwnershipChecks[4].namedMigrationOwnershipConnections=1;}]){const copy=structuredClone(execution);mutate(copy);assert.throws(()=>validateProtectedExecutionEvidence(copy,native,profile,'ordinaryRecovery'));}
});

test('build protected acceptance uses its own immutable artifact pair and rejects v4/F2 receipts', () => {
  const profile=shipped(),artifact=profile.artifacts.fallback,binding={schemaVersion:1,id:BUILD_SECURITY_ACCEPTANCE_ID,kind:'current_school_acceptance_successor_preparation',preparationReviewed:true,localSyntheticOnly:true,operationalAuthorization:false,releaseReady:false,candidate:{...ACCEPTANCE_CANDIDATE_IDENTITIES},baseline:{source:ACCEPTANCE_BASELINE,image:ACCEPTANCE_BASELINE_IMAGE},fallback:{source:artifact.source,image:artifact.localIndex,config:artifact.config,platform:artifact.platform,archiveSha256:artifact.archiveSha256},releaseBindingId:BUILD_SECURITY_BINDING_ID,credentialBoundaryRetainedOnRollback:true,audience:'DeSales',clients:133,extensionVersion:'2.9.7',order:[...FIXED_ORDER],profiles:Object.fromEntries(SUCCESSOR_PROFILES.map(value=>[value.name,profileHash(value)])),evidenceNotBefore:'2026-10-09T13:00:00Z',recordedAt:'2026-10-09T13:10:00Z',validity:{startsAt:'2026-10-09T13:10:00Z',expiresAt:'2026-10-10T13:10:00Z'}};
  assertAcceptanceSuccessorIdentity(binding,Date.parse('2026-10-09T13:11:00Z'));
  for(const mutate of [v=>{v.id=CP_PROTECTED_ACCEPTANCE_ID;},v=>{v.releaseBindingId=CP_PROTECTED_BINDING_ID;},v=>{v.fallback.source=profile.previousFallback.source;},v=>{v.fallback.image=profile.previousFallback.localIndex;},v=>{v.credentialBoundaryRetainedOnRollback=false;},v=>{v.candidate={...HISTORICAL_CANDIDATE_IDENTITIES};}]){const copy=structuredClone(binding);mutate(copy);assert.throws(()=>assertAcceptanceSuccessorIdentity(copy,Date.parse('2026-10-09T13:11:00Z')));}
});

test('v5 restricted-round reuse requires actual identical source schemas, migration ledgers, artifact pair and fresh queried ownership', () => {
  const profile=shipped(),pins={priorActualReplay:{storage:'private',path:'synthetic/prior.json',sha256:bindingHash('prior'),format:'json'},currentActualReplay:{storage:'private',path:'synthetic/current.json',sha256:bindingHash('current'),format:'json'},unchangedExactArtifactRoles:true,unchangedNative43And53MigrationLedger:true,unchangedCanonicalSourceSchema:true,allSixRestrictedRoundsRetainedWithoutRelabeling:true};
  const execution={source:profile.applicationSource,releaseBindingId:profile.id,passed:true,cleanupPassed:true,gracefulCleanupPassed:true,networkCleanupPassed:true,productionMutations:0,operationalAuthorization:false,releaseReady:false,artifactRoles:{candidate:'serving-anchor',fallback:'fallback'},artifactPairBinding:{path:'synthetic/pair.json',sha256:bindingHash('same exact pair')},drains:Array.from({length:8},()=>({exitCode:0,oomKilled:false,forced:false,sqlConnections:0})),cleanup:[{removed:true,graceful:true,forced:false,exitCode:0,oomKilled:false}],sourceSpecificNative:{}};
  for(const arm of ['baseline','candidate']){execution.sourceSpecificNative[arm]={passed:true,clientEnded:true,source:arm==='baseline'?ACCEPTANCE_BASELINE:profile.applicationSource,applicationImage:arm==='baseline'?ACCEPTANCE_BASELINE_IMAGE:profile.testedApplicationImage,nativeCompletedMigrations:Array.from({length:arm==='baseline'?43:53},(_,i)=>({id:`migration-${i}`,checksum:bindingHash(`${arm}-${i}`),status:'complete'}))};execution[`${arm}Default`]={canonicalSchemaSha256:bindingHash(`${arm} canonical schema`)};}
  const prior=structuredClone(execution),current=structuredClone(execution);current.startedAt='2026-10-09T13:10:00Z';current.completedAt='2026-10-09T13:11:00Z';current.ownershipEvidenceCapture={priorExecution:{path:pins.priorActualReplay.path,sha256:pins.priorActualReplay.sha256},onlyReadOnlyAssertionsAdded:true};current.migrationOwnershipChecks=['constructor','baseline43','candidate53','fallbackRetains53','candidateReturn53'].map(phase=>({phase,observedAtUtc:'2026-10-09T13:10:30Z',role:{role:'synthetic_migration_owner',rolsuper:false,rolbypassrls:false,rolinherit:false,schema_owner:false,schema_usage:true,schema_create:true},applicationTables:[{table_name:'synthetic_source_table',owner:'synthetic_migration_owner',owned:true}],applicationTableCount:1,allApplicationTablesOwned:true,excludedOperationalFixtureTables:[],excludedSourceApplicationTables:0,clientEnded:true,namedMigrationOwnershipConnections:0}));
  const fallback={source:profile.fallback.source,applicationImage:profile.fallback.localIndex,passed:true,clientEnded:true,nativeCompletedMigrations:structuredClone(current.sourceSpecificNative.candidate.nativeCompletedMigrations)},restricted={sealedServiceReplay:pins.priorActualReplay};const fixture={prior,current,priorFallback:structuredClone(fallback),currentFallback:structuredClone(fallback),pins,restricted,profile},check=v=>validateBuildSecurityRestrictedReplayApplicability(v.prior,v.current,v.priorFallback,v.currentFallback,v.pins,v.restricted,v.profile);check(fixture);
  for(const mutate of [v=>{v.pins.allSixRestrictedRoundsRetainedWithoutRelabeling=false;},v=>{v.current.artifactPairBinding.sha256=bindingHash('changed');},v=>{v.current.candidateDefault.canonicalSchemaSha256=bindingHash('changed');},v=>{v.current.sourceSpecificNative.candidate.nativeCompletedMigrations[0].checksum=bindingHash('changed');},v=>{v.currentFallback.nativeCompletedMigrations[0].checksum=bindingHash('changed');},v=>{v.prior.drains[0].forced=true;},v=>{v.current.migrationOwnershipChecks[0].role.schema_owner=true;},v=>{v.restricted.sealedServiceReplay.sha256=bindingHash('changed');}]){const value=structuredClone(fixture);mutate(value);assert.throws(()=>check(value));}
});
