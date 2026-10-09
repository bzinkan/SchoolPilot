// Synthetic metadata tests only. No operational receipt, Plan or deployment is created.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {test} from 'node:test';
import {ROOT,validateBuildSecurityOperationalCompletion,validateBuildSecurityCapacityBaselineRaw,renderStatus} from '../scripts/release297-current-state.mjs';
import {BUILD_SECURITY_APPLICATION_SOURCE as A,BUILD_SECURITY_ARTIFACT as F} from '../scripts/release-source-binding.mjs';
const main='6e33a19662fec14e719a806e73160a84816f120e';
const sha=value=>createHash('sha256').update(value).digest('hex');
const arn=(family,revision)=>'arn:aws:ecs:us-east-1:135775632425:task-definition/'+family+':'+revision;
function fixture(){
 const binding=JSON.parse(readFileSync(join(ROOT,'docs/release-bindings/release-297-current-school-cp-protected-build-fallback-v5.json'),'utf8'));
 binding.status='accepted';binding.blockers=[];binding.preparation.status='passed';binding.successorSelection.status='approved';for(const entry of Object.values(binding.evidence))entry.status='passed';
 const index={evidence:{buildSecurityBinding:{gitBlobSha256:sha('synthetic-accepted-binding')},buildSecurityDeploymentCompletion:{gitBlobSha256:sha('synthetic-public-completion')}},stages:['implementation','testing','packaging','publication','deployment','activation','live'].map(id=>({id,status:['activation','live'].includes(id)?'pending':'passed',applicability:'current_baseline',sourceSha:id==='publication'?main:A,evidence:['buildSecurityDeploymentCompletion','buildSecurityDeploymentReview']}))};
 const observation={mainSource:main,observedAtUtc:'2026-10-09T18:00:00.000Z',currentMainCi:{status:'passed'},publicationExecuted:true,inactiveRegistrationExecuted:true,productionDeploymentExecuted:true,frontend:{archiveSha256:'ca200bf37c33277a49c0cd83707ddfa2c123634eaf1d881b417778b334adb41d',fileInventorySha256:'3035336e3f9836c437a893b368e3aba7b7e4a118b51dfca2ac5dfd2cf25733f3'}};
 const operations=Object.fromEntries(['servingPublication','fallbackPublication','current129AnchorRegistration','compatibleFallback129Registration','backendMigration','backendWorkerDeployment','matchedFrontendDeployment','postdeploymentTaskAndFlagReadback','publicFrontendByteVerification'].map(name=>[name,{status:'passed',operationalOutcomeUncertain:false,receipt:{storage:'private',format:'json',path:'synthetic-test/'+name+'.json',sha256:sha(name)}}]));
 const registry=Object.fromEntries(Object.entries(binding.artifacts).map(([role,value])=>[role,{...value,digest:value.platform}]));
 const service=(family,revision,desired)=>({taskDefinition:arn(family,revision),desiredCount:desired,runningCount:desired,pendingCount:0,rolloutState:'COMPLETED',allTasksHealthy:true,runtimeSource:main,imageDigest:registry['serving-anchor'].digest});
 const completion={schemaVersion:1,kind:'release297_matched_deployment_completion',applicationSource:A,mainSource:main,releaseBindingId:binding.id,releaseBindingSha256:index.evidence.buildSecurityBinding.gitBlobSha256,artifactPair:structuredClone(binding.artifacts),operationalOutcomeUncertain:false,activationExecuted:false,sampleBearingLiveAcceptanceComplete:false,managedDeviceValidation:'waived_not_passed',releaseReady:false,operationalAuthorization:false,completedAtUtc:'2026-10-09T17:30:00.000Z',frontend:{source:A,...observation.frontend,fileCount:171,publicStaticBytesVerified:true,alreadyOpenPageAdoption:'pending'},fallbackFrontend:{source:'cce3f7b4eae30df13378337c01dc4ff2d5db3997',archiveSha256:'8d6379613dbb1c88783ee0f141ed41c34164fac5142172daee7da7f8d27cd72a',fileInventorySha256:'3484fa4f9848dc9e48e4e3bfeb384e959f17deccd10125e8b362fb094f29451e',fileCount:171,preparedAndReviewed:true},operations,registeredFallback:{source:F.source,admissionCount:129,inactive:true,registrationOutcomeUncertain:false,apiTaskDefinition:arn('schoolpilot-production-api-emergency',981),workerTaskDefinition:arn('schoolpilot-production-scheduler-worker',981)},postdeployment:{admissionCount:129,completedMigrations:53,capabilityModesPreserved:true,desiredCountsPreserved:true,migrationConnectionClosed:true,usageModes:{CLASSPILOT_USAGE_ROLLUP_MODE:'off',CLASSPILOT_DIGITAL_USAGE_MODE:'off',CLASSPILOT_DAILY_USAGE_ROLLUP_MODE:'omitted'},registry,services:{api:service('schoolpilot-production-api-emergency',982,3),'scheduler-worker':service('schoolpilot-production-scheduler-worker',982,1)}},sequence:[{stage:'migration',startedAtUtc:'2026-10-09T17:00:00.000Z',completedAtUtc:'2026-10-09T17:05:00.000Z'},{stage:'api-worker-convergence',startedAtUtc:'2026-10-09T17:05:00.000Z',completedAtUtc:'2026-10-09T17:20:00.000Z'},{stage:'matched-frontend',startedAtUtc:'2026-10-09T17:20:00.000Z',completedAtUtc:'2026-10-09T17:30:00.000Z'}]};
 const review={schemaVersion:1,kind:'independent_release297_matched_deployment_completion_review',passed:true,independentFromProducer:true,humanApprovalAsserted:false,applicationSource:A,mainSource:main,releaseBindingId:binding.id,completionSha256:index.evidence.buildSecurityDeploymentCompletion.gitBlobSha256,actualPrivateReceiptsReplayed:true,releaseReady:false,operationalAuthorization:false,operationReceiptSha256s:Object.fromEntries(Object.entries(operations).map(([name,row])=>[name,row.receipt.sha256])),reviewedAtUtc:'2026-10-09T17:40:00.000Z'};
 return {index,observation,binding,completion,review};
}
const validate=f=>validateBuildSecurityOperationalCompletion(f.index,f.observation,f.binding,f.completion,f.review);
test('exact reviewed emergency serving/fallback pairs permit deployment status while activation and live remain pending',()=>{const f=fixture();assert.equal(validate(f),f.completion);assert.equal(f.index.stages.find(row=>row.id==='activation').status,'pending');assert.equal(f.index.stages.find(row=>row.id==='live').status,'pending');});
const invalid=[
 ['unaccepted binding',f=>f.binding.status='pending',/DEPLOYMENT_REQUIRES_ACCEPTED_BINDING/],
 ['remaining release blocker',f=>f.binding.blockers=['campaign-pending'],/DEPLOYMENT_REQUIRES_ACCEPTED_BINDING/],
 ['missing original gate',f=>delete f.binding.evidence.ordinaryRecovery,/INDEX_FIELDS_INVALID/],
 ['unpassed original gate',f=>f.binding.evidence.classroomAcceptance.status='unknown',/DEPLOYMENT_REQUIRES_ALL_ORIGINAL_GATES/],
 ['failed headroom despite other passed gates',f=>f.binding.evidence.headroomAcceptance.status='failed',/DEPLOYMENT_REQUIRES_ALL_ORIGINAL_GATES/],
 ['incomplete main CI',f=>f.observation.currentMainCi.status='pending',/DEPLOYMENT_REQUIRES_EXACT_MAIN_CI/],
 ['no actual execution observation',f=>f.observation.productionDeploymentExecuted=false,/DEPLOYMENT_EXECUTION_OBSERVATION_REQUIRED/],
 ['wrong binding hash',f=>f.completion.releaseBindingSha256=sha('other-binding'),/DEPLOYMENT_COMPLETION_IDENTITY_INVALID/],
 ['mixed backend artifact roles',f=>f.completion.artifactPair['serving-anchor'].config=F.config,/DEPLOYMENT_COMPLETION_IDENTITY_INVALID/],
 ['substituted frontend archive',f=>f.completion.frontend.archiveSha256=sha('other-front'),/DEPLOYMENT_MATCHED_FRONTEND_INVALID/],
 ['unverified public static bytes',f=>f.completion.frontend.publicStaticBytesVerified=false,/DEPLOYMENT_MATCHED_FRONTEND_INVALID/],
 ['claimed open-page adoption',f=>f.completion.frontend.alreadyOpenPageAdoption='passed',/DEPLOYMENT_MATCHED_FRONTEND_INVALID/],
 ['substituted recovery frontend',f=>f.completion.fallbackFrontend.source=A,/DEPLOYMENT_FALLBACK_FRONTEND_INVALID/],
 ['missing actual operation receipt',f=>delete f.completion.operations.backendMigration,/INDEX_FIELDS_INVALID/],
 ['partial operation',f=>f.completion.operations.matchedFrontendDeployment.status='partial',/DEPLOYMENT_OPERATION_NOT_COMPLETE/],
 ['uncertain operation',f=>f.completion.operations.fallbackPublication.operationalOutcomeUncertain=true,/DEPLOYMENT_OPERATION_NOT_COMPLETE/],
 ['receipt path traversal',f=>f.completion.operations.backendMigration.receipt.path='../other.json',/DEPLOYMENT_ACTUAL_RECEIPT_PATH_INVALID/],
 ['ordinary53 relabeled54',f=>f.completion.postdeployment.completedMigrations=54,/DEPLOYMENT_POSTSTATE_CONTRACT_INVALID/],
 ['daily mode drift',f=>f.completion.postdeployment.usageModes.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE='on',/DEPLOYMENT_USAGE_MODES_CHANGED/],
 ['new Usage activation',f=>f.completion.postdeployment.usageModes.CLASSPILOT_DIGITAL_USAGE_MODE='on',/DEPLOYMENT_USAGE_MODES_CHANGED/],
 ['substituted fallback registry configuration',f=>f.completion.postdeployment.registry.fallback.config=f.completion.postdeployment.registry['serving-anchor'].config,/DEPLOYMENT_REGISTRY_ROLE_CHANGED/],
 ['standard API family substituted for registered emergency fallback',f=>f.completion.registeredFallback.apiTaskDefinition=arn('schoolpilot-production-api',981),/DEPLOYMENT_FALLBACK_TASK_PAIR_REQUIRED/],
 ['standard API family substituted for serving emergency task',f=>f.completion.postdeployment.services.api.taskDefinition=arn('schoolpilot-production-api',982),/DEPLOYMENT_TASK_PAIR_REQUIRED/],
 ['false preserved count with API1',f=>{f.completion.postdeployment.services.api.desiredCount=1;f.completion.postdeployment.services.api.runningCount=1;},/DEPLOYMENT_TASK_COUNT_INVALID/],
 ['false preserved count with API2',f=>{f.completion.postdeployment.services.api.desiredCount=2;f.completion.postdeployment.services.api.runningCount=2;},/DEPLOYMENT_TASK_COUNT_INVALID/],
 ['worker not converged',f=>f.completion.postdeployment.services['scheduler-worker'].pendingCount=1,/DEPLOYMENT_TASKS_NOT_CONVERGED/],
 ['fallback serving image',f=>f.completion.postdeployment.services.api.imageDigest=F.platform,/DEPLOYMENT_TASK_IMAGE_CHANGED/],
 ['fallback ARN relabeled as serving',f=>f.completion.postdeployment.services.api.taskDefinition=f.completion.registeredFallback.apiTaskDefinition,/DEPLOYMENT_SERVING_PAIR_IS_FALLBACK/],
 ['frontend before backend convergence',f=>f.completion.sequence[2].startedAtUtc='2026-10-09T17:10:00.000Z',/DEPLOYMENT_STAGE_ORDER_INVALID/],
 ['migration not first',f=>f.completion.sequence.reverse(),/DEPLOYMENT_MIGRATION_FIRST_REQUIRED/],
 ['review targets another completion',f=>f.review.completionSha256=sha('different-completion'),/DEPLOYMENT_INDEPENDENT_REVIEW_REQUIRED/],
 ['review omits actual receipt replay',f=>f.review.actualPrivateReceiptsReplayed=false,/DEPLOYMENT_INDEPENDENT_REVIEW_REQUIRED/],
 ['cross-pair reviewed receipt',f=>f.review.operationReceiptSha256s.fallbackPublication=sha('different-fallback'),/DEPLOYMENT_REVIEW_RECEIPTS_CHANGED/],
 ['review predates actual deployment',f=>f.review.reviewedAtUtc='2026-10-09T16:00:00.000Z',/DEPLOYMENT_REVIEW_TIME_INVALID/],
 ['deployment promoted to live acceptance',f=>f.index.stages.find(row=>row.id==='live').status='passed',/DEPLOYMENT_IS_NOT_ACTIVATION_OR_LIVE_ACCEPTANCE/],
 ['managed waiver relabeled passed',f=>f.completion.managedDeviceValidation='passed',/DEPLOYMENT_COMPLETION_IDENTITY_INVALID/],
];
for(const [name,mutate,expected]of invalid)test('operational metadata rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validate(f),expected);});

function renderingFixture(){
 const current=JSON.parse(readFileSync(join(ROOT,'docs/releases/release297/current-release.json'),'utf8'));
 current.sources.schoolpilot.remoteMainObserved=main;
 return current;
}
test('completed deployment renders the exact matched source while preserving pending adoption and live acceptance',()=>{
 const current=renderingFixture();
 current.stages.find(row=>row.id==='deployment').status='passed';
 current.evidence.buildSecurityDeploymentCompletion={path:'docs/releases/release297/synthetic-render-completion.json',gitBlobSha256:sha('synthetic-render-completion')};
 current.evidence.buildSecurityDeploymentReview={path:'docs/releases/release297/synthetic-render-review.json',gitBlobSha256:sha('synthetic-render-review')};
 const output=renderStatus(current);
 assert.match(output,/Exact matched A3 backend\/worker and frontend `2001e888` are deployed/);
 assert.match(output,/Original release gates, exact artifact publication and inactive129F3 registration are verified/);
 assert.match(output,/Already-open page adoption and sample-bearing live acceptance remain pending/);
 assert.match(output,/managed-device validation stays `waived_not_passed`/);
 assert.match(output,/PR #628 invalidated the earlier A2 freeze/);
 assert.match(output,/completed deployment preserved admission129/);
 assert.doesNotMatch(output,/fresh A3 evidence is required|v5 prepares inactive 129 definitions/);
 const artifacts=output.split('### Candidate artifacts')[1].split('### Inclusion and evidence invalidation')[0];
 assert.match(artifacts,/2001e888/);
 assert.match(artifacts,/88d012d047e47a4bc33352290baf1800772777ee4260a4be64f5caacd7a249cc/);
 assert.match(artifacts,/ca200bf37c33277a49c0cd83707ddfa2c123634eaf1d881b417778b334adb41d/);
 assert.doesNotMatch(artifacts,/8303500d39eb68531c30d4005b4b62eb4f4e0e202f10957d8dfe10cf1459a161|a107df178142707491f3797d9ebc3dd8270bbd1ad8349b964aeef90bff4e5ea9/);
});
for(const absent of ['completion','review'])test('rendering does not infer deployment from status alone when '+absent+' evidence is absent',()=>{
 const current=renderingFixture();current.stages.find(row=>row.id==='deployment').status='passed';
 const kept=absent==='completion'?'buildSecurityDeploymentReview':'buildSecurityDeploymentCompletion';
 current.evidence[kept]={path:'docs/releases/release297/synthetic-render-only-one.json',gitBlobSha256:sha('synthetic-render-only-one')};
 delete current.evidence[absent==='completion'?'buildSecurityDeploymentCompletion':'buildSecurityDeploymentReview'];
 const output=renderStatus(current);
 assert.doesNotMatch(output,/Exact matched A3 backend\/worker and frontend .* are deployed/);
 assert.match(output,/fresh A3 evidence is required/);assert.match(output,/v5 prepares inactive 129 definitions/);
});
test('preparation rendering retains current unexecuted language until actual deployment evidence exists',()=>{
 const current=renderingFixture();current.stages.find(row=>row.id==='deployment').status='pending';
 delete current.evidence.buildSecurityDeploymentCompletion;delete current.evidence.buildSecurityDeploymentReview;
 const output=renderStatus(current);assert.match(output,/fresh A3 evidence is required/);assert.match(output,/v5 prepares inactive 129 definitions/);assert.doesNotMatch(output,/Exact matched A3 backend\/worker and frontend .* are deployed/);
});

test('complete preparation and all seven original gates render accepted evidence while publication and deployment stay pending',()=>{
 const current=renderingFixture();current.stages.find(row=>row.id==='testing').status='passed';
 for(const key of ['preparation','selection','currentSchoolAcceptance','classroomAcceptance','normalLoadAcceptance','headroomAcceptance','original-ordinaryRecovery','original-restrictedRestoration','original-screenshotRuntime']){
  let gate=current.gates.find(row=>row.id==='build-security-'+key);
  if(!gate){gate={id:'build-security-'+key,label:key,evidence:[],nextAction:'Synthetic accepted evidence.'};current.gates.push(gate);}
  gate.status='passed';
 }
 current.stages.find(row=>row.id==='deployment').status='pending';delete current.evidence.buildSecurityDeploymentCompletion;delete current.evidence.buildSecurityDeploymentReview;
 const output=renderStatus(current);
 assert.match(output,/Fresh A3 preparation and all seven original release gates are complete/);
 assert.match(output,/Exact publication and backend\/frontend deployment remain pending/);
 assert.match(output,/PR #628 invalidated the earlier A2 freeze/);
 assert.doesNotMatch(output,/fresh A3 evidence is required|Exact matched A3 backend\/worker and frontend .* are deployed/);
 current.gates.find(row=>row.id==='build-security-headroomAcceptance').status='failed';
 assert.match(renderStatus(current),/fresh A3 evidence is required/);
 assert.doesNotMatch(renderStatus(current),/all seven original release gates are complete/);
});

test('failed headroom is rendered as a blocker without changing completed original gates or claiming deployment',()=>{
 const current=renderingFixture(),failed=current.gates.find(row=>row.id==='build-security-headroomAcceptance');
 Object.assign(failed,{status:'failed',rationale:'p95 544.682706ms exceeds400ms; remaining2attempts held.',nextAction:'Establish a reviewed falsifiable correction before a new attempt.'});
 for(const key of ['currentSchoolAcceptance','classroomAcceptance','normalLoadAcceptance'])current.gates.find(row=>row.id==='build-security-'+key).status='passed';
 current.stages.find(row=>row.id==='deployment').status='pending';
 delete current.evidence.buildSecurityDeploymentCompletion;delete current.evidence.buildSecurityDeploymentReview;
 const output=renderStatus(current);
 assert.match(output,/\| [^\n]*headroom[^\n]* \| failed \|/i);
 assert.match(output,/Establish a reviewed falsifiable correction before a new attempt/);
 for(const key of ['currentSchoolAcceptance','classroomAcceptance','normalLoadAcceptance'])assert.equal(current.gates.find(row=>row.id==='build-security-'+key).status,'passed');
 assert.doesNotMatch(output,/Exact matched A3 backend\/worker and frontend .* are deployed/);
});

function capacityFixture(apiCount=3) {
 const f=fixture();f.completion.schemaVersion=2;f.review.schemaVersion=2;
 const taskDefinitions={api:arn('schoolpilot-production-api-emergency',180),'scheduler-worker':arn('schoolpilot-production-scheduler-worker',196)};
 const desiredCounts={api:apiCount,'scheduler-worker':1};
 const services=Object.entries(desiredCounts).map(([role,count])=>({serviceName:'schoolpilot-production-'+role,clusterArn:'arn:aws:ecs:us-east-1:135775632425:cluster/schoolpilot-production-cluster',status:'ACTIVE',taskDefinition:taskDefinitions[role],desiredCount:count,runningCount:count,pendingCount:0,deployments:[{status:'PRIMARY',taskDefinition:taskDefinitions[role],desiredCount:count,runningCount:count,pendingCount:0,failedTasks:0,rolloutState:'COMPLETED'}]}));
 const raw={services,failures:[]};const rawBytes=Buffer.from(JSON.stringify(raw));
 f.completion.capacityBaseline={observedAtUtc:'2026-10-09T16:55:00.000Z',servicesReceipt:{storage:'private',format:'json',path:'synthetic-test/capacity-services.json',sha256:sha(rawBytes)},desiredCounts,taskDefinitions};
 Object.assign(f.review,{baselineServicesSha256:sha(rawBytes),actualCapacityBaselineServicesReplayed:true,capacityBaselineObservedAtUtc:f.completion.capacityBaseline.observedAtUtc,capacityBaselineDesiredCounts:structuredClone(desiredCounts),capacityBaselineTaskDefinitions:structuredClone(taskDefinitions)});
 Object.assign(f.completion.postdeployment.services.api,{desiredCount:apiCount,runningCount:apiCount});
 return {...f,raw,rawBytes};
}
for(const count of [1,2,3])test('schema2 records exact reviewed API'+count+'/worker1 capacity without changing schema1 fixed3/1',()=>{
 const f=capacityFixture(count);assert.equal(validate(f),f.completion);
 const result=validateBuildSecurityCapacityBaselineRaw(f.completion.capacityBaseline,f.rawBytes,f.completion.sequence[0].startedAtUtc);
 assert.deepEqual(result.desiredCounts,{api:count,'scheduler-worker':1});assert.equal(result.passed,true);
 assert.match(result.scope,/individual task health requires its separate actual readback/);
});
const invalidCapacity=[
 ['missing baseline',f=>delete f.completion.capacityBaseline,/DEPLOYMENT_CAPACITY_BASELINE_REQUIRED/],
 ['missing raw receipt hash',f=>delete f.completion.capacityBaseline.servicesReceipt.sha256,/DEPLOYMENT_CAPACITY_BASELINE_RECEIPT_REQUIRED/],
 ['unreviewed raw baseline',f=>f.review.actualCapacityBaselineServicesReplayed=false,/DEPLOYMENT_CAPACITY_BASELINE_REVIEW_REQUIRED/],
 ['cross-baseline reviewed hash',f=>f.review.baselineServicesSha256=sha('other-baseline'),/DEPLOYMENT_CAPACITY_BASELINE_REVIEW_REQUIRED/],
 ['cross-baseline reviewed counts',f=>f.review.capacityBaselineDesiredCounts.api=2,/DEPLOYMENT_CAPACITY_BASELINE_REVIEW_REQUIRED/],
 ['cross-baseline reviewed task definitions',f=>f.review.capacityBaselineTaskDefinitions.api=arn('schoolpilot-production-api-emergency',179),/DEPLOYMENT_CAPACITY_BASELINE_REVIEW_REQUIRED/],
 ['baseline after migration',f=>f.completion.capacityBaseline.observedAtUtc='2026-10-09T17:01:00.000Z',/DEPLOYMENT_CAPACITY_BASELINE_STALE/],
 ['baseline older than30min',f=>f.completion.capacityBaseline.observedAtUtc='2026-10-09T16:29:59.999Z',/DEPLOYMENT_CAPACITY_BASELINE_STALE/],
 ['API0 baseline',f=>f.completion.capacityBaseline.desiredCounts.api=0,/DEPLOYMENT_CAPACITY_BASELINE_COUNT_INVALID/],
 ['API4 baseline',f=>f.completion.capacityBaseline.desiredCounts.api=4,/DEPLOYMENT_CAPACITY_BASELINE_COUNT_INVALID/],
 ['worker2 baseline',f=>f.completion.capacityBaseline.desiredCounts['scheduler-worker']=2,/DEPLOYMENT_CAPACITY_BASELINE_COUNT_INVALID/],
 ['changed predeployment task pair',f=>f.completion.capacityBaseline.taskDefinitions.api=arn('schoolpilot-production-api-emergency',179),/DEPLOYMENT_CAPACITY_BASELINE_TASK_PAIR_CHANGED/],
 ['false preserved postcounts',f=>{f.completion.postdeployment.services.api.desiredCount=1;f.completion.postdeployment.services.api.runningCount=1;},/DEPLOYMENT_TASK_COUNT_INVALID/],
 ['private baseline traversal',f=>f.completion.capacityBaseline.servicesReceipt.path='../other.json',/DEPLOYMENT_CAPACITY_BASELINE_PATH_INVALID/],
];
for(const [name,mutate,expected]of invalidCapacity)test('schema2 rejects '+name,()=>{const f=capacityFixture();mutate(f);assert.throws(()=>validate(f),expected);});
const invalidCapacityRaw=[
 ['substituted hash',f=>{f.raw.services[0].desiredCount=2;},/DEPLOYMENT_CAPACITY_RAW_HASH_CHANGED/,false],
 ['foreign cluster',f=>f.raw.services[0].clusterArn='arn:aws:ecs:us-east-1:135775632425:cluster/other',/DEPLOYMENT_CAPACITY_RAW_CLUSTER_CHANGED/],
 ['wrong service',f=>f.raw.services[0].serviceName='schoolpilot-production-other',/DEPLOYMENT_CAPACITY_RAW_SERVICE_CHANGED/],
 ['wrong task definition',f=>f.raw.services[0].taskDefinition=arn('schoolpilot-production-api',180),/DEPLOYMENT_CAPACITY_RAW_SERVICE_NOT_CONVERGED/],
 ['API raw counts differ from baseline',f=>f.raw.services[0].runningCount=2,/DEPLOYMENT_CAPACITY_RAW_SERVICE_NOT_CONVERGED/],
 ['pending service task',f=>f.raw.services[0].pendingCount=1,/DEPLOYMENT_CAPACITY_RAW_SERVICE_NOT_CONVERGED/],
 ['nonactive service',f=>f.raw.services[0].status='DRAINING',/DEPLOYMENT_CAPACITY_RAW_SERVICE_NOT_CONVERGED/],
 ['multiple deployments',f=>f.raw.services[0].deployments.push(structuredClone(f.raw.services[0].deployments[0])),/DEPLOYMENT_CAPACITY_RAW_DEPLOYMENTS_REQUIRED/],
 ['failed deployment task',f=>f.raw.services[0].deployments[0].failedTasks=1,/DEPLOYMENT_CAPACITY_RAW_DEPLOYMENT_NOT_CONVERGED/],
 ['incomplete deployment',f=>f.raw.services[0].deployments[0].rolloutState='IN_PROGRESS',/DEPLOYMENT_CAPACITY_RAW_DEPLOYMENT_NOT_CONVERGED/],
 ['nonprimary deployment',f=>f.raw.services[0].deployments[0].status='ACTIVE',/DEPLOYMENT_CAPACITY_RAW_DEPLOYMENT_NOT_CONVERGED/],
 ['wrong deployment task definition',f=>f.raw.services[0].deployments[0].taskDefinition=arn('schoolpilot-production-api-emergency',179),/DEPLOYMENT_CAPACITY_RAW_DEPLOYMENT_NOT_CONVERGED/],
 ['AWS lookup failure',f=>f.raw.failures.push({reason:'MISSING'}),/DEPLOYMENT_CAPACITY_RAW_FAILURES/],
 ['missing service',f=>f.raw.services.pop(),/DEPLOYMENT_CAPACITY_RAW_SERVICES_REQUIRED/],
];
for(const [name,mutate,expected,repin=true]of invalidCapacityRaw)test('actual raw capacity replay rejects '+name,()=>{
 const f=capacityFixture();mutate(f);const bytes=Buffer.from(JSON.stringify(f.raw));if(repin)f.completion.capacityBaseline.servicesReceipt.sha256=sha(bytes);
 assert.throws(()=>validateBuildSecurityCapacityBaselineRaw(f.completion.capacityBaseline,bytes,f.completion.sequence[0].startedAtUtc),expected);
});
test('capacity baseline freshness includes exactly30minutes and rejects metadata substitution after raw replay',()=>{
 const f=capacityFixture(1);f.completion.capacityBaseline.observedAtUtc='2026-10-09T16:30:00.000Z';f.review.capacityBaselineObservedAtUtc=f.completion.capacityBaseline.observedAtUtc;
 assert.equal(validate(f),f.completion);assert.equal(validateBuildSecurityCapacityBaselineRaw(f.completion.capacityBaseline,f.rawBytes,f.completion.sequence[0].startedAtUtc).passed,true);
 f.completion.capacityBaseline.desiredCounts.api=2;assert.throws(()=>validateBuildSecurityCapacityBaselineRaw(f.completion.capacityBaseline,f.rawBytes,f.completion.sequence[0].startedAtUtc),/DEPLOYMENT_CAPACITY_RAW_SERVICE_NOT_CONVERGED/);
});
