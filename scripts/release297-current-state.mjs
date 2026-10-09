#!/usr/bin/env node
// Offline documentation generation only; no provider, runtime or release operations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CP_PROTECTED_BINDING_ID, CP_PROTECTED_SOURCE, CP_PROTECTED_ARTIFACT, CP_PROTECTED_SOURCE_REVIEW, BUILD_SECURITY_BINDING_ID, BUILD_SECURITY_APPLICATION_SOURCE, BUILD_SECURITY_ANCHOR_ARTIFACT, BUILD_SECURITY_ARTIFACT } from './release-source-binding.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX = 'docs/releases/release297/current-release.json';
export const CHECKLIST = 'docs/RELEASE_2_9_7_OPERATOR_CHECKLIST.md';
export const BEGIN = '<!-- release297-current-state:start -->';
export const END = '<!-- release297-current-state:end -->';
export const STATUSES = Object.freeze(['passed', 'failed', 'pending', 'unknown', 'waived_not_passed', 'not_applicable']);
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const REQUIRED_MAIN_CHECKS = ['Backend (TypeScript + Build)', 'Cross-tenant isolation tests', 'RLS-enabled cross-tenant tests', 'Frontend (Vite Build)', ...[1, 2, 3, 4].map(shard => `Frontend release-focused gates (shard ${shard})`), 'AWS rollout safety (PowerShell + Terraform)', 'SOC 2 privileged access evidence', 'SOC 2 deployment evidence', 'SOC 2 incident evidence', 'SOC 2 tenant isolation evidence', 'SOC 2 AI/privacy evidence', 'SOC 2 monitoring evidence', 'SOC 2 approval queue', 'Analyze (javascript-typescript)', 'Scan for secrets'];
const stamp = value => typeof value === 'string' && /^20\d\d-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1600 && !/[\r\n]/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sameKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'INDEX_FIELDS_INVALID');
const evidenceRefs = (record, evidence) => {
  assert.ok(Array.isArray(record.evidence), 'EVIDENCE_ARRAY_REQUIRED');
  for (const id of record.evidence) assert.ok(Object.hasOwn(evidence, id), 'EVIDENCE_REFERENCE_UNKNOWN');
};
function metadataOnly(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(!/^(studentId|studentName|studentEmail|deviceId|schoolId|email|token|password|secret|rawEnvironment|rawCapture|requestBody)$/i.test(key), 'PRIVATE_DATA_FIELD_REJECTED');
    metadataOnly(nested);
  }
}
export function validateBuildSecurityOperationalCompletion(index, observation, binding, completion, review) {
  metadataOnly(completion); metadataOnly(review);
  assert.deepEqual([binding.status,binding.preparation.status,binding.successorSelection.status,binding.blockers],['accepted','passed','approved',[]],'DEPLOYMENT_REQUIRES_ACCEPTED_BINDING');
  sameKeys(binding.evidence,['currentSchoolAcceptance','classroomAcceptance','normalLoadAcceptance','headroomAcceptance','ordinaryRecovery','restrictedRestoration','screenshotRuntime']);
  assert.ok(Object.values(binding.evidence).every(row=>row.status==='passed'),'DEPLOYMENT_REQUIRES_ALL_ORIGINAL_GATES');
  assert.equal(observation.currentMainCi.status,'passed','DEPLOYMENT_REQUIRES_EXACT_MAIN_CI');
  assert.deepEqual([observation.publicationExecuted,observation.inactiveRegistrationExecuted,observation.productionDeploymentExecuted],[true,true,true],'DEPLOYMENT_EXECUTION_OBSERVATION_REQUIRED');
  assert.deepEqual([completion.schemaVersion,completion.kind,completion.applicationSource,completion.mainSource,completion.releaseBindingId,completion.releaseBindingSha256,completion.artifactPair,completion.operationalOutcomeUncertain,completion.activationExecuted,completion.sampleBearingLiveAcceptanceComplete,completion.managedDeviceValidation,completion.releaseReady,completion.operationalAuthorization],[1,'release297_matched_deployment_completion',BUILD_SECURITY_APPLICATION_SOURCE,observation.mainSource,binding.id,index.evidence.buildSecurityBinding.gitBlobSha256,binding.artifacts,false,false,false,'waived_not_passed',false,false],'DEPLOYMENT_COMPLETION_IDENTITY_INVALID');
  assert.ok(stamp(completion.completedAtUtc)&&Date.parse(completion.completedAtUtc)<=Date.parse(observation.observedAtUtc),'DEPLOYMENT_COMPLETION_TIME_INVALID');
  assert.deepEqual(completion.frontend,{source:BUILD_SECURITY_APPLICATION_SOURCE,archiveSha256:observation.frontend.archiveSha256,fileInventorySha256:observation.frontend.fileInventorySha256,fileCount:171,publicStaticBytesVerified:true,alreadyOpenPageAdoption:'pending'},'DEPLOYMENT_MATCHED_FRONTEND_INVALID');
  assert.deepEqual(completion.fallbackFrontend,{source:'cce3f7b4eae30df13378337c01dc4ff2d5db3997',archiveSha256:'8d6379613dbb1c88783ee0f141ed41c34164fac5142172daee7da7f8d27cd72a',fileInventorySha256:'3484fa4f9848dc9e48e4e3bfeb384e959f17deccd10125e8b362fb094f29451e',fileCount:171,preparedAndReviewed:true},'DEPLOYMENT_FALLBACK_FRONTEND_INVALID');
  const operations=['servingPublication','fallbackPublication','current129AnchorRegistration','compatibleFallback129Registration','backendMigration','backendWorkerDeployment','matchedFrontendDeployment','postdeploymentTaskAndFlagReadback','publicFrontendByteVerification'];
  sameKeys(completion.operations,operations.slice());
  for(const name of operations){const row=completion.operations[name];assert.deepEqual([row.status,row.operationalOutcomeUncertain],['passed',false],'DEPLOYMENT_OPERATION_NOT_COMPLETE');const retained=row.receipt;assert.equal(retained?.storage,'private','DEPLOYMENT_ACTUAL_RECEIPT_REQUIRED');assert.equal(retained?.format,'json','DEPLOYMENT_ACTUAL_RECEIPT_REQUIRED');assert.match(retained?.sha256??'',hash,'DEPLOYMENT_ACTUAL_RECEIPT_REQUIRED');assert.ok(typeof retained.path==='string'&&retained.path.length>0&&!path.isAbsolute(retained.path)&&!retained.path.split(/[\\/]/).includes('..'),'DEPLOYMENT_ACTUAL_RECEIPT_PATH_INVALID');}
  const post=completion.postdeployment;
  assert.deepEqual([post.admissionCount,post.completedMigrations,post.capabilityModesPreserved,post.desiredCountsPreserved,post.migrationConnectionClosed],[129,53,true,true,true],'DEPLOYMENT_POSTSTATE_CONTRACT_INVALID');
  assert.deepEqual(post.usageModes,{CLASSPILOT_USAGE_ROLLUP_MODE:'off',CLASSPILOT_DIGITAL_USAGE_MODE:'off',CLASSPILOT_DAILY_USAGE_ROLLUP_MODE:'omitted'},'DEPLOYMENT_USAGE_MODES_CHANGED');
  sameKeys(post.registry,['serving-anchor','fallback']);
  for(const role of ['serving-anchor','fallback']){const actual=post.registry[role],expected=binding.artifacts[role];assert.match(actual.digest??'',/^sha256:[a-f0-9]{64}$/,'DEPLOYMENT_REGISTRY_DIGEST_REQUIRED');assert.deepEqual([actual.source,actual.localIndex,actual.config,actual.platform,actual.archiveSha256],[expected.source,expected.localIndex,expected.config,expected.platform,expected.archiveSha256],'DEPLOYMENT_REGISTRY_ROLE_CHANGED');}
  const taskArn=(value,family)=>typeof value==='string'&&new RegExp('^arn:aws:ecs:us-east-1:135775632425:task-definition/'+family+':[1-9][0-9]*$').test(value);
  const fallback=completion.registeredFallback;assert.deepEqual([fallback.source,fallback.admissionCount,fallback.inactive,fallback.registrationOutcomeUncertain],[BUILD_SECURITY_ARTIFACT.source,129,true,false],'DEPLOYMENT_FALLBACK_REGISTRATION_INVALID');assert.ok(taskArn(fallback.apiTaskDefinition,'schoolpilot-production-api-emergency')&&taskArn(fallback.workerTaskDefinition,'schoolpilot-production-scheduler-worker'),'DEPLOYMENT_FALLBACK_TASK_PAIR_REQUIRED');
  sameKeys(post.services,['api','scheduler-worker']);
  for(const role of ['api','scheduler-worker']){const service=post.services[role];assert.ok(taskArn(service.taskDefinition,role==='api'?'schoolpilot-production-api-emergency':'schoolpilot-production-scheduler-worker'),'DEPLOYMENT_TASK_PAIR_REQUIRED');assert.ok(role==='api'?service.desiredCount===3:service.desiredCount===1,'DEPLOYMENT_TASK_COUNT_INVALID');assert.deepEqual([service.runningCount,service.pendingCount,service.rolloutState,service.allTasksHealthy,service.runtimeSource],[service.desiredCount,0,'COMPLETED',true,observation.mainSource],'DEPLOYMENT_TASKS_NOT_CONVERGED');assert.ok([post.registry['serving-anchor'].digest,binding.artifacts['serving-anchor'].platform].includes(service.imageDigest),'DEPLOYMENT_TASK_IMAGE_CHANGED');assert.notEqual(service.taskDefinition,role==='api'?fallback.apiTaskDefinition:fallback.workerTaskDefinition,'DEPLOYMENT_SERVING_PAIR_IS_FALLBACK');}
  const sequence=completion.sequence;assert.ok(Array.isArray(sequence)&&sequence.length===3,'DEPLOYMENT_SEQUENCE_REQUIRED');assert.deepEqual(sequence.map(row=>row.stage),['migration','api-worker-convergence','matched-frontend'],'DEPLOYMENT_MIGRATION_FIRST_REQUIRED');let last=-Infinity;for(const row of sequence){assert.ok(stamp(row.startedAtUtc)&&stamp(row.completedAtUtc),'DEPLOYMENT_STAGE_TIME_REQUIRED');const start=Date.parse(row.startedAtUtc),end=Date.parse(row.completedAtUtc);assert.ok(last<=start&&start<=end&&end<=Date.parse(completion.completedAtUtc),'DEPLOYMENT_STAGE_ORDER_INVALID');last=end;}
  assert.deepEqual([review.schemaVersion,review.kind,review.passed,review.independentFromProducer,review.humanApprovalAsserted,review.applicationSource,review.mainSource,review.releaseBindingId,review.completionSha256,review.actualPrivateReceiptsReplayed,review.releaseReady,review.operationalAuthorization],[1,'independent_release297_matched_deployment_completion_review',true,true,false,BUILD_SECURITY_APPLICATION_SOURCE,observation.mainSource,binding.id,index.evidence.buildSecurityDeploymentCompletion.gitBlobSha256,true,false,false],'DEPLOYMENT_INDEPENDENT_REVIEW_REQUIRED');
  assert.deepEqual(review.operationReceiptSha256s,Object.fromEntries(operations.map(name=>[name,completion.operations[name].receipt.sha256])),'DEPLOYMENT_REVIEW_RECEIPTS_CHANGED');
  assert.ok(stamp(review.reviewedAtUtc)&&Date.parse(completion.completedAtUtc)<=Date.parse(review.reviewedAtUtc)&&Date.parse(review.reviewedAtUtc)<=Date.parse(observation.observedAtUtc),'DEPLOYMENT_REVIEW_TIME_INVALID');
  for(const id of ['implementation','testing','packaging','publication','deployment']){const stage=index.stages.find(row=>row.id===id);assert.ok(stage&&stage.status==='passed'&&stage.applicability==='current_baseline'&&stage.evidence.includes('buildSecurityDeploymentCompletion')&&stage.evidence.includes('buildSecurityDeploymentReview'),'DEPLOYMENT_STAGE_EVIDENCE_REQUIRED');}
  assert.deepEqual([index.stages.find(row=>row.id==='publication').sourceSha,index.stages.find(row=>row.id==='deployment').sourceSha],[observation.mainSource,BUILD_SECURITY_APPLICATION_SOURCE],'DEPLOYMENT_STAGE_SOURCE_CHANGED');
  assert.deepEqual([index.stages.find(row=>row.id==='activation').status,index.stages.find(row=>row.id==='live').status],['pending','pending'],'DEPLOYMENT_IS_NOT_ACTIVATION_OR_LIVE_ACCEPTANCE');
  return completion;
}

function validateBuildSecurityIndex(index, root) {
  const receipt = id => JSON.parse(readFileSync(path.join(root, index.evidence[id].path), 'utf8'));
  const observation = receipt('buildSecurityCurrentObservation'), previous = receipt('buildSecurityPreviousIndex'), binding = receipt('buildSecurityBinding');
  metadataOnly(observation);
  assert.ok(stamp(observation.observedAtUtc)&&Date.parse(observation.observedAtUtc)<=Date.parse(index.observedAtUtc),'BUILD_SECURITY_OBSERVATION_TIME_REQUIRED');
  assert.ok(!previous.evidence.buildSecurityCurrentObservation, 'HISTORICAL_INDEX_MUST_NOT_RECURSE');
  validateIndex(previous, root);
  const operationalObservation=observation.schemaVersion===2;
  assert.deepEqual([observation.schemaVersion, observation.kind, observation.applicationSource, observation.releaseBindingId, observation.releaseReady, observation.operationalAuthorization, observation.productionDeploymentExecuted], [operationalObservation?2:1, operationalObservation?'release297_build_security_operational_observation':'release297_build_security_current_observation', BUILD_SECURITY_APPLICATION_SOURCE, BUILD_SECURITY_BINDING_ID, false, false, operationalObservation], 'BUILD_SECURITY_CURRENT_OBSERVATION_INVALID');
  assert.deepEqual([observation.humanApprovalAsserted, observation.directUserRequest], [false, 'fix this and deploy'], 'DIRECT_USER_REQUEST_PROVENANCE_REQUIRED');
  assert.deepEqual(index.authorization, {merge:true,productionDeployment:true,registryPublication:true,inactiveRegistration:true,storeSubmission:false,runtimeActivation:false,githubSettings:false}, 'BUILD_SECURITY_AUTHORIZATION_SCOPE_CHANGED');
  assert.deepEqual(observation.authorization, index.authorization, 'BUILD_SECURITY_REQUEST_SCOPE_CHANGED');
  assert.deepEqual([index.sources.schoolpilot.remoteMainObserved,index.sources.schoolpilot.frozenApplicationReference], [observation.mainSource, BUILD_SECURITY_APPLICATION_SOURCE], 'BUILD_SECURITY_CURRENT_SOURCE_CHANGED');
  assert.deepEqual(index.sources.classpilot, previous.sources.classpilot, 'EXTENSION_SOURCE_CHANGED');
  assert.deepEqual(binding.artifacts, {'serving-anchor':BUILD_SECURITY_ANCHOR_ARTIFACT,fallback:BUILD_SECURITY_ARTIFACT}, 'BUILD_SECURITY_CURRENT_ARTIFACT_CHANGED');
  assert.deepEqual([binding.schemaVersion,binding.id,binding.applicationSource], [5,BUILD_SECURITY_BINDING_ID,BUILD_SECURITY_APPLICATION_SOURCE], 'BUILD_SECURITY_CURRENT_BINDING_CHANGED');
  assert.deepEqual(observation.artifactPair,binding.artifacts,'BUILD_SECURITY_OBSERVED_ARTIFACT_CHANGED');
  assert.deepEqual(observation.inventory,binding.inventory,'BUILD_SECURITY_OBSERVED_INPUTS_CHANGED');
  assert.deepEqual(observation.frontendInventory,binding.frontendInventory,'BUILD_SECURITY_OBSERVED_FRONTEND_CHANGED');
  assert.deepEqual([observation.preparationStatus,observation.selectionStatus,observation.originalCampaignStatuses],[binding.preparation.status,binding.successorSelection.status,Object.fromEntries(['currentSchoolAcceptance','classroomAcceptance','normalLoadAcceptance','headroomAcceptance'].map(key=>[key,binding.evidence[key].status]))],'BUILD_SECURITY_OBSERVED_GATE_STATE_CHANGED');
  if (observation.mainSource !== BUILD_SECURITY_APPLICATION_SOURCE) {
    assert.deepEqual(observation.mainEquivalence, {status:'passed',applicationReference:BUILD_SECURITY_APPLICATION_SOURCE,mainSource:observation.mainSource,backendInventory:binding.inventory,frontendInventory:binding.frontendInventory}, 'BUILD_SECURITY_RESULTING_MAIN_EQUIVALENCE_REQUIRED');
  }
  const ci = observation.currentMainCi;
  assert.deepEqual([ci.source,ci.branch,ci.event],[observation.mainSource,'main','push'],'BUILD_SECURITY_MAIN_CI_REQUIRED');
  assert.ok(Array.isArray(ci.checks)&&ci.checks.length>0&&ci.checks.length<=21&&new Set(ci.checks.map(row=>row.name)).size===ci.checks.length&&ci.checks.every(row=>row.headSha===ci.source),'BUILD_SECURITY_MAIN_CHECK_SET_CHANGED');
  assert.deepEqual([ci.successes,ci.expectedSkips],[ci.checks.filter(row=>row.conclusion==='success').length,ci.checks.filter(row=>row.conclusion==='skipped').length],'BUILD_SECURITY_MAIN_CHECK_COUNTS_CHANGED');
  for (const check of ci.checks) {
    assert.ok(['queued','in_progress','completed'].includes(check.status),'BUILD_SECURITY_MAIN_CHECK_STATUS_INVALID');
    assert.ok(check.status==='completed'?['success','skipped','neutral','failure','cancelled','timed_out','action_required','stale','startup_failure'].includes(check.conclusion):check.conclusion===null||check.conclusion==='','BUILD_SECURITY_MAIN_CHECK_CONCLUSION_INVALID');
    const match=check.url.match(/^https:\/\/github\.com\/bzinkan\/SchoolPilot\/actions\/runs\/(\d+)\/job\/\d+$/); assert.ok(match,'BUILD_SECURITY_MAIN_CHECK_URL_REQUIRED');
    const workflow=ci.workflowRuns[match[1]];assert.ok(workflow,'BUILD_SECURITY_MAIN_WORKFLOW_REQUIRED');
    assert.deepEqual([workflow.id,workflow.event,workflow.head_branch,workflow.head_sha,workflow.html_url],[Number(match[1]),check.name==='Build, scan, sign, and publish once'?'workflow_run':'push','main',ci.source,`https://github.com/bzinkan/SchoolPilot/actions/runs/${match[1]}`],'BUILD_SECURITY_MAIN_WORKFLOW_CHANGED');
    assert.ok(['queued','in_progress','completed'].includes(workflow.status),'BUILD_SECURITY_MAIN_WORKFLOW_STATUS_INVALID');
    assert.ok(workflow.status==='completed'?['success','skipped','neutral','failure','cancelled','timed_out','action_required','stale','startup_failure'].includes(workflow.conclusion):workflow.conclusion===null||workflow.conclusion==='','BUILD_SECURITY_MAIN_WORKFLOW_CONCLUSION_INVALID');
    if(check.conclusion==='skipped')assert.ok(['Detect changed paths','Build, scan, sign, and publish once'].includes(check.name),'BUILD_SECURITY_UNKNOWN_SKIP');
  }
  const failed=ci.checks.some(check=>check.status==='completed'&&!['success','skipped'].includes(check.conclusion))||Object.values(ci.workflowRuns).some(run=>run.status==='completed'&&!['success','skipped'].includes(run.conclusion));
  const passed=!failed&&ci.checks.length===21&&ci.successes===19&&ci.expectedSkips===2&&[...REQUIRED_MAIN_CHECKS,'Scan Docker image'].every(name=>ci.checks.some(check=>check.name===name&&check.status==='completed'&&check.conclusion==='success'))&&ci.checks.every(check=>check.status==='completed')&&Object.values(ci.workflowRuns).every(run=>run.status==='completed'&&['success','skipped'].includes(run.conclusion));
  assert.equal(ci.status,failed?'failed':passed?'passed':'pending','BUILD_SECURITY_MAIN_CI_OUTCOME_CHANGED');
  for(const [id,entry]of Object.entries(previous.evidence))assert.deepEqual(index.evidence[id],entry,'HISTORICAL_EVIDENCE_CHANGED');
  for(const group of ['artifacts','gates'])for(const prior of previous[group]){
    const current=index[group].find(row=>row.id===prior.id);assert.ok(current,'HISTORICAL_RECORD_REMOVED');
    assert.deepEqual([current.status,current.sourceSha,current.evidence],[prior.status,prior.sourceSha,prior.evidence],'HISTORICAL_OUTCOME_RELABELLED');
    if(group==='artifacts')assert.deepEqual([Object.hasOwn(current,'identity'),current.identity],[Object.hasOwn(prior,'identity'),prior.identity],'HISTORICAL_ARTIFACT_IDENTITY_CHANGED');
  }
  for(const prior of previous.inclusionMatrix){const current=index.inclusionMatrix.find(row=>row.repository===prior.repository&&row.number===prior.number);assert.ok(current,'HISTORICAL_MERGE_REMOVED');assert.deepEqual({...current,includedInSource:prior.includedInSource},prior,'HISTORICAL_MERGE_CHANGED');}
  for(const pr of observation.addedPullRequests){const row=index.inclusionMatrix.find(row=>row.repository==='SchoolPilot'&&row.number===pr.number);assert.ok(row,'CURRENT_MERGE_REQUIRED');assert.deepEqual([row.headSha,row.mergeSha,row.mergedAtUtc,row.state],[pr.headRefOid,pr.mergeCommit.oid,pr.mergedAt,'MERGED'],'CURRENT_MERGE_IDENTITY_CHANGED');}
  for(const [id,role]of [['backend-current-a3','serving-anchor'],['fallback-build-security-f3','fallback']]){const row=index.artifacts.find(row=>row.id===id),pins=binding.artifacts[role];assert.ok(row,'CURRENT_ARTIFACT_REQUIRED');assert.deepEqual([row.status,row.sourceSha,row.identity],['passed',pins.source,{indexDigest:pins.localIndex,platformManifestDigest:pins.platform,configDigest:pins.config,archiveSha256:pins.archiveSha256}],'CURRENT_ARTIFACT_ROLE_CHANGED');}
  const frontend=index.artifacts.find(row=>row.id==='frontend-current-a3');assert.ok(frontend,'CURRENT_FRONTEND_REQUIRED');assert.equal(frontend.sourceSha,BUILD_SECURITY_APPLICATION_SOURCE,'CURRENT_FRONTEND_SOURCE_CHANGED');
  if(observation.frontend){assert.deepEqual([observation.frontend.source,observation.frontend.buildPassed,frontend.status,frontend.identity],[BUILD_SECURITY_APPLICATION_SOURCE,true,'passed',{archiveSha256:observation.frontend.archiveSha256,fileInventorySha256:observation.frontend.fileInventorySha256}],'CURRENT_FRONTEND_ARTIFACT_CHANGED');}else assert.equal(frontend.status,'pending','CURRENT_FRONTEND_EVIDENCE_REQUIRED');
  assert.ok(index.inclusionMatrix.some(row=>row.repository==='SchoolPilot'&&row.number===627&&row.mergeSha==='55f91b620d2d48de5ed164a72250ec133450bc0f'),'PR627_INVALIDATION_REQUIRED');
  assert.ok(index.inclusionMatrix.some(row=>row.repository==='SchoolPilot'&&row.number===628&&row.mergeSha===BUILD_SECURITY_APPLICATION_SOURCE),'PR628_INVALIDATION_REQUIRED');
  const gate=(id,status,source=BUILD_SECURITY_APPLICATION_SOURCE)=>{const row=index.gates.find(value=>value.id===id);assert.ok(row,'BUILD_SECURITY_GATE_REQUIRED');assert.deepEqual([row.status,row.sourceSha],[status,source],'BUILD_SECURITY_GATE_CHANGED');};
  gate('build-security-main-ci',ci.status,observation.mainSource);gate('build-security-candidate-freeze','passed');
  gate('build-security-source-applicability',binding.sourceApplicability.status==='approved'?'passed':'pending');
  gate('build-security-full-audit',binding.buildDependencyAudit.status,BUILD_SECURITY_ARTIFACT.source);
  gate('build-security-output-equivalence',binding.compiledOutputEquivalence.status,BUILD_SECURITY_ARTIFACT.source);
  for(const [key,value]of Object.entries(binding.preparation.evidence))gate('build-security-'+key,value.status, key==='ordinaryRecovery'||key==='restrictedRestoration'?BUILD_SECURITY_APPLICATION_SOURCE:BUILD_SECURITY_ARTIFACT.source);
  gate('build-security-preparation',binding.preparation.status);gate('build-security-selection',binding.successorSelection.status==='approved'?'passed':binding.successorSelection.status,BUILD_SECURITY_ARTIFACT.source);
  if(binding.successorSelection.status==='approved'){
    const selection=receipt('buildSecuritySuccessorSelection'),selectedFrontend=selection.matchedRecoveryFrontend;
    assert.deepEqual([selection.schemaVersion,selection.kind,selection.releaseBindingId,selection.status,selection.artifactPair,selection.humanApprovalAsserted,selection.releaseReady,selection.operationalAuthorization],[1,'reviewed_fallback_successor_selection',binding.id,'APPROVED_EXACT_SUCCESSOR',binding.artifacts,false,false,false],'BUILD_SECURITY_EXACT_SELECTION_REQUIRED');
    assert.deepEqual(binding.successorSelection,{status:'approved',path:index.evidence.buildSecuritySuccessorSelection.path,sha256:index.evidence.buildSecuritySuccessorSelection.gitBlobSha256},'BUILD_SECURITY_SELECTION_RECEIPT_CHANGED');
    assert.deepEqual(selectedFrontend,{role:'fallback-frontend',source:'cce3f7b4eae30df13378337c01dc4ff2d5db3997',backendSource:BUILD_SECURITY_ARTIFACT.source,archiveSha256:'8d6379613dbb1c88783ee0f141ed41c34164fac5142172daee7da7f8d27cd72a',inventorySha256:'3484fa4f9848dc9e48e4e3bfeb384e959f17deccd10125e8b362fb094f29451e',files:171},'BUILD_SECURITY_MATCHED_C_SELECTION_CHANGED');
    const compatibleFrontend=index.artifacts.find(row=>row.id==='frontend-compatible-f3-c');assert.ok(compatibleFrontend,'BUILD_SECURITY_MATCHED_C_ARTIFACT_REQUIRED');
    assert.deepEqual([compatibleFrontend.status,compatibleFrontend.applicability,compatibleFrontend.sourceSha,compatibleFrontend.identity],['passed','preparation_only',selectedFrontend.source,{archiveSha256:selectedFrontend.archiveSha256,fileInventorySha256:selectedFrontend.inventorySha256}],'BUILD_SECURITY_MATCHED_C_ARTIFACT_CHANGED');
    assert.ok(compatibleFrontend.evidence.includes('buildSecuritySuccessorSelection'),'BUILD_SECURITY_MATCHED_C_SELECTION_REFERENCE_REQUIRED');
    gate('build-security-compatible-frontend-preparation','passed',selectedFrontend.source);
    assert.equal(observation.rollbackFrontendApplicability.compatibleFrontendSelection,'approved','BUILD_SECURITY_MATCHED_C_APPLICABILITY_REQUIRED');
  }
  for(const key of ['currentSchoolAcceptance','classroomAcceptance','normalLoadAcceptance','headroomAcceptance'])gate('build-security-'+key,binding.evidence[key].status==='unknown'?'pending':binding.evidence[key].status);
  for(const key of ['ordinaryRecovery','restrictedRestoration','screenshotRuntime'])if(binding.evidence[key].status==='passed'){
    const evidenceId='buildSecurityOriginal'+key[0].toUpperCase()+key.slice(1),record=receipt(evidenceId);
    assert.deepEqual(binding.evidence[key],{status:'passed',path:index.evidence[evidenceId].path,sha256:index.evidence[evidenceId].gitBlobSha256},'BUILD_SECURITY_ORIGINAL_GATE_RECEIPT_CHANGED');
    assert.deepEqual([record.schemaVersion,record.kind,record.releaseBindingId,record.evidenceKind,record.applicationSource,record.inventorySha256,record.frontendInventorySha256,record.policySha256,record.extension,record.schema,record.scope,record.passed,record.releaseReady,record.operationalAuthorization],[1,key==='ordinaryRecovery'?'release_binding_ordinary_recovery':'release_binding_acceptance',binding.id,key,binding.applicationSource,binding.inventory.sha256,binding.frontendInventory.sha256,binding.policy.sha256,binding.extension,binding.schema,binding.scope,true,false,false],'BUILD_SECURITY_ORIGINAL_GATE_IDENTITY_CHANGED');
    for(const field of ['nativeResult','independentReview']){const retained=record.retainedEvidence?.[field];assert.equal(retained?.storage,'private','BUILD_SECURITY_ORIGINAL_GATE_NATIVE_REQUIRED');assert.match(retained.sha256??'',hash,'BUILD_SECURITY_ORIGINAL_GATE_NATIVE_REQUIRED');assert.ok(typeof retained.path==='string'&&!path.isAbsolute(retained.path)&&!retained.path.split(/[\\/]/).includes('..'),'BUILD_SECURITY_ORIGINAL_GATE_NATIVE_PATH_INVALID');}
    gate('build-security-original-'+key,'passed');
    assert.ok(index.gates.find(row=>row.id==='build-security-original-'+key).evidence.includes(evidenceId),'BUILD_SECURITY_ORIGINAL_GATE_REFERENCE_REQUIRED');
  }
  for(const name of ['CLASSPILOT_USAGE_ROLLUP_MODE','CLASSPILOT_DIGITAL_USAGE_MODE'])assert.deepEqual([index.usageModes[name].observedValue,index.usageModes[name].status],['off','passed'],'CURRENT_NEW_USAGE_SETTING_CHANGED');
  assert.deepEqual([index.usageModes.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE.observedValue,observation.dailyRollup.setting,observation.dailyRollup.effectiveAtCurrentServingSource],['shadow','omitted','shadow'],'CURRENT_DAILY_SETTING_CHANGED');
  assert.ok(observation.rollbackFrontendApplicability.laterManualRollbackAfterMatchedFrontendRequiresCompatibleFrontend&&observation.rollbackFrontendApplicability.automaticBackendRecoveryBeforeMatchedFrontend,'ROLLBACK_FRONTEND_APPLICABILITY_REQUIRED');
  if(operationalObservation)validateBuildSecurityOperationalCompletion(index,observation,binding,receipt('buildSecurityDeploymentCompletion'),receipt('buildSecurityDeploymentReview'));
  else {
    assert.deepEqual([observation.publicationExecuted,observation.inactiveRegistrationExecuted],[false,false],'PREPARATION_IS_NOT_PUBLICATION_OR_REGISTRATION');
  assert.deepEqual([index.stages.find(row=>row.id==='deployment').status,index.stages.find(row=>row.id==='activation').status,index.stages.find(row=>row.id==='live').status],['pending','pending','pending'],'PREPARATION_IS_NOT_DEPLOYMENT');
  }
  return index;
}
export function validateIndex(index, root = ROOT) {
  const successorReceiptApplicability = index.evidence?.candidateRefresh ? 'historical' : 'preparation_only';
  sameKeys(index, ['schemaVersion', 'kind', 'releaseId', 'observedAtUtc', 'audience', 'authorization', 'sources', 'usageModes', 'compatibility', 'artifacts', 'stages', 'gates', 'inclusionMatrix', 'evidence']);
  assert.equal(index.schemaVersion, 1, 'INDEX_SCHEMA_INVALID');
  assert.equal(index.kind, 'current_release_index', 'INDEX_KIND_INVALID');
  assert.equal(index.releaseId, 'release297-desales133-usage-off', 'RELEASE_ID_INVALID');
  assert.ok(stamp(index.observedAtUtc), 'OBSERVATION_TIME_REQUIRED');
  assert.deepEqual(index.audience, { school: 'DeSales', clients: 133, validationLevel: 'synthetic_only', managedValidation: 'waived_not_passed' }, 'AUDIENCE_CHANGED');
  sameKeys(index.authorization, ['merge', 'productionDeployment', 'registryPublication', 'inactiveRegistration', 'storeSubmission', 'runtimeActivation', 'githubSettings']);
  // A dated direct-user observation may record an existing deployment request.
  // Recording it never supplies controller authority, execution, or readiness.
  assert.ok(Object.entries(index.authorization).every(([key, value]) => value === false || (key === 'productionDeployment' && value === true && index.evidence.candidateRefresh) || (index.evidence.buildSecurityCurrentObservation && ['merge','productionDeployment','registryPublication','inactiveRegistration'].includes(key) && value===true)), 'INDEX_IS_NOT_OPERATIONAL_AUTHORIZATION');
  metadataOnly(index);
  sameKeys(index.sources, ['schoolpilot', 'classpilot']);
  for (const source of Object.values(index.sources)) {
    sameKeys(source, ['planningReference', 'remoteMainObserved', 'reviewedHistorical', 'testedHistorical', 'frozenApplicationReference', 'evidence']);
    for (const key of ['planningReference', 'remoteMainObserved', 'reviewedHistorical', 'testedHistorical']) assert.match(source[key], sha, 'SOURCE_SHA_INVALID');
    assert.ok(source.frozenApplicationReference === null || sha.test(source.frozenApplicationReference), 'FREEZE_SHA_INVALID');
    evidenceRefs(source, index.evidence);
  }
  sameKeys(index.usageModes, ['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE', 'CLASSPILOT_USAGE_ROLLUP_MODE', 'CLASSPILOT_DIGITAL_USAGE_MODE']);
  for (const [name, mode] of Object.entries(index.usageModes)) {
    sameKeys(mode, ['requiredValue', 'observedValue', 'status', 'rationale', 'evidence', 'nextAction']);
    assert.ok(STATUSES.includes(mode.status) && text(mode.rationale) && text(mode.nextAction), 'USAGE_METADATA_REQUIRED');
    if (name !== 'CLASSPILOT_DAILY_USAGE_ROLLUP_MODE') assert.equal(mode.requiredValue, 'off', 'NEW_USAGE_MODE_MUST_STAY_OFF');
    else assert.equal(mode.requiredValue, 'preserve_observed_value', 'DAILY_MODE_IS_SEPARATE');
    assert.ok(mode.observedValue === null || ['off', 'on', 'shadow', 'legacy', 'set_based'].includes(mode.observedValue), 'USAGE_VALUE_INVALID');
    evidenceRefs(mode, index.evidence);
  }
  sameKeys(index.compatibility, ['ordinaryMigrationPath', 'admissionPath', 'historicalFullManifestLedger', 'retainedFallbackSource', 'neverShrinkAdmission', 'preservePrivateChatFloor', 'capabilityEqualityRequired', 'phase128Before129', 'privateChatFloor', 'optionalStaffIdentityContract', 'screenshotFunction']);
  assert.deepEqual(index.compatibility.privateChatFloor, { lifecycleWriterVersion: 1, bridgeVersion: 1, relayVersion: 1 }, 'PRIVATE_CHAT_FLOOR_CHANGED');
  assert.deepEqual(index.compatibility.ordinaryMigrationPath, [43, 53], 'ORDINARY_MIGRATION_PATH_CHANGED');
  assert.deepEqual(index.compatibility.admissionPath, [121, 125, 126, 127, 128, 129], 'ADMISSION_PATH_CHANGED');
  assert.equal(index.compatibility.historicalFullManifestLedger, 54, 'HISTORICAL_LEDGER_CHANGED');
  assert.equal(index.compatibility.retainedFallbackSource, 'c578120d980d4c2405a72f4f40b2d3c29a07e20b', 'FALLBACK_SUBSTITUTED');
  assert.ok(index.compatibility.neverShrinkAdmission && index.compatibility.preservePrivateChatFloor && index.compatibility.capabilityEqualityRequired, 'RECOVERY_GUARDS_REQUIRED');
  const ids = new Set();
  for (const group of ['artifacts', 'stages', 'gates']) {
    assert.ok(Array.isArray(index[group]) && index[group].length > 0, 'STATE_ARRAY_REQUIRED');
    for (const record of index[group]) {
      sameKeys(record, ['id', 'label', 'status', 'applicability', 'sourceSha', 'rationale', 'observedAtUtc', 'evidence', 'nextAction', ...(Object.hasOwn(record, 'identity') && group === 'artifacts' ? ['identity'] : [])]);
      assert.ok(text(record.id) && !ids.has(record.id), 'STATE_ID_DUPLICATED'); ids.add(record.id);
      assert.ok(text(record.label) && STATUSES.includes(record.status), 'STATE_STATUS_INVALID');
      assert.ok(['historical', 'current_baseline', 'candidate_pending', 'policy_definition', 'equivalence_required', 'preparation_only'].includes(record.applicability), 'APPLICABILITY_REQUIRED');
      assert.ok(text(record.rationale) && text(record.nextAction) && stamp(record.observedAtUtc), 'STATE_CONTEXT_REQUIRED');
      assert.ok(Date.parse(record.observedAtUtc) <= Date.parse(index.observedAtUtc), 'FUTURE_OBSERVATION_REJECTED');
      assert.ok(record.sourceSha === null || sha.test(record.sourceSha), 'STATE_SOURCE_INVALID');
      assert.ok(record.status !== 'passed' || record.evidence.length > 0, 'PASS_REQUIRES_EVIDENCE');
      assert.ok(record.status !== 'passed' || record.applicability !== 'candidate_pending', 'PENDING_CANDIDATE_CANNOT_PASS');
      if (record.applicability === 'historical') assert.ok(record.sourceSha !== null, 'HISTORICAL_SOURCE_REQUIRED');
      evidenceRefs(record, index.evidence);
      if (record.identity) {
        if (record.id === 'extension') {
          sameKeys(record.identity, ['version', 'extensionId', 'bytes', 'zipSha256', 'gitTree']);
          assert.equal(record.identity.version, '2.9.7', 'EXTENSION_VERSION_CHANGED');
          assert.equal(record.identity.extensionId, 'iggbfegfcjkfieoemeolfmfnapepalca', 'EXTENSION_ID_CHANGED');
          assert.equal(record.identity.bytes, 376052, 'EXTENSION_SIZE_CHANGED');
          assert.match(record.identity.zipSha256, hash, 'ZIP_HASH_INVALID');
          assert.match(record.identity.gitTree, sha, 'EXTENSION_TREE_INVALID');
        } else {
          const keys = record.id === 'frontend-historical' ? ['archiveSha256'] : ['frontend-preparation', 'frontend-successor', 'frontend-current-a2', 'frontend-current-a3', 'frontend-compatible-f3-c'].includes(record.id) ? ['archiveSha256', 'fileInventorySha256'] : record.id === 'backend-preparation' ? ['localImageId', 'configDigest', 'archiveSha256', 'reportSha256'] : ['indexDigest', 'platformManifestDigest', 'configDigest', 'archiveSha256'];
          sameKeys(record.identity, keys);
          for (const [key, value] of Object.entries(record.identity)) assert.match(value, ['archiveSha256', 'fileInventorySha256', 'reportSha256'].includes(key) ? hash : /^sha256:[a-f0-9]{64}$/, 'ARTIFACT_IDENTITY_INVALID');
        }
      }
    }
  }
  for (const entry of index.inclusionMatrix) {
    sameKeys(entry, ['repository', 'number', 'title', 'state', 'headSha', 'mergeSha', 'mergedAtUtc', 'includedInSource', 'affectedArtifacts', 'reusableEvidence', 'requiredReruns']);
    assert.ok(['SchoolPilot', 'ClassPilot'].includes(entry.repository) && Number.isInteger(entry.number), 'PR_ID_INVALID');
    assert.equal(entry.state, 'MERGED', 'MERGE_NOT_OBSERVED');
    for (const key of ['headSha', 'mergeSha', 'includedInSource']) assert.match(entry[key], sha, 'PR_SOURCE_INVALID');
    assert.ok(stamp(entry.mergedAtUtc) && text(entry.title) && text(entry.reusableEvidence) && text(entry.requiredReruns), 'PR_CONTEXT_REQUIRED');
    assert.ok(Array.isArray(entry.affectedArtifacts) && entry.affectedArtifacts.length > 0, 'PR_SCOPE_REQUIRED');
    assert.equal(entry.includedInSource, index.sources[entry.repository.toLowerCase()].remoteMainObserved, 'MATRIX_SOURCE_CHANGED');
  }
  for (const entry of Object.values(index.evidence)) {
    sameKeys(entry, ['path', 'gitBlobSha256']);
    assert.ok(/^docs\/[A-Za-z0-9_./-]+$/.test(entry.path) && !entry.path.split('/').includes('..'), 'PUBLIC_EVIDENCE_PATH_REQUIRED');
    assert.match(entry.gitBlobSha256, hash, 'EVIDENCE_HASH_INVALID');
    const filename = path.resolve(root, entry.path);
    assert.ok(filename.startsWith(`${path.resolve(root)}${path.sep}`) && !lstatSync(filename).isSymbolicLink() && realpathSync(filename) === filename, 'ORDINARY_EVIDENCE_REQUIRED');
    // All indexed receipts are UTF-8 JSON tracked as text. Compare canonical Git
    // blob bytes, preserving explicit CRLF artifact differences elsewhere.
    assert.equal(digest(readFileSync(filename, 'utf8').replaceAll('\r\n', '\n')), entry.gitBlobSha256, 'EVIDENCE_BYTES_CHANGED');
  }
  if(index.evidence.buildSecurityCurrentObservation)return validateBuildSecurityIndex(index,root);
  const receipt = id => JSON.parse(readFileSync(path.join(root, index.evidence[id].path), 'utf8'));
  const reconciliation = receipt('reconciliation');
  const resultingMain = index.evidence.resultingMainObservation ? receipt('resultingMainObservation') : null;
  const historicalReconciliation = receipt('reconciliationHistorical');
  assert.equal(historicalReconciliation.schoolpilotRemoteMain, index.sources.schoolpilot.planningReference, 'ORIGINAL_BASELINE_SOURCE_CHANGED');
  assert.equal(index.sources.schoolpilot.remoteMainObserved, resultingMain?.resultingMainSourceB ?? reconciliation.schoolpilotRemoteMain, 'SOURCE_OBSERVATION_CHANGED');
  assert.equal(index.sources.classpilot.remoteMainObserved, reconciliation.classpilotRemoteMain, 'SOURCE_OBSERVATION_CHANGED');
  const baselineCi = index.gates.find(entry => entry.id === 'baseline-ci');
  assert.deepEqual([baselineCi.status, baselineCi.applicability, baselineCi.sourceSha, baselineCi.evidence], ['passed', 'historical', historicalReconciliation.schoolpilotRemoteMain, ['reconciliationHistorical']], 'ORIGINAL_BASELINE_CI_RECLASSIFIED');
  if (reconciliation.schoolpilotRemoteMain !== historicalReconciliation.schoolpilotRemoteMain || Object.hasOwn(reconciliation, 'currentMainCi')) {
    const ci = reconciliation.currentMainCi;
    assert.ok(ci, 'CURRENT_MAIN_CI_OBSERVATION_REQUIRED');
    assert.deepEqual([ci.source, ci.event, ci.branch], [reconciliation.schoolpilotRemoteMain, 'push', 'main'], 'CURRENT_MAIN_CI_IS_NOT_PR_CI');
    assert.ok(Array.isArray(ci.checks), 'CURRENT_MAIN_CHECKS_REQUIRED');
    assert.ok(ci.workflowRuns && typeof ci.workflowRuns === 'object' && !Array.isArray(ci.workflowRuns), 'CURRENT_MAIN_WORKFLOW_PROVENANCE_REQUIRED');
    const names = new Set();
    for (const check of ci.checks) {
      assert.ok(text(check.name) && !names.has(check.name), 'CURRENT_MAIN_CHECK_DUPLICATED'); names.add(check.name);
      assert.equal(check.headSha, ci.source, 'CURRENT_MAIN_CHECK_SOURCE_CHANGED');
      assert.ok(['queued', 'in_progress', 'completed'].includes(check.status), 'CURRENT_MAIN_CHECK_STATUS_INVALID');
      const url = check.url.match(/^https:\/\/github\.com\/bzinkan\/SchoolPilot\/actions\/runs\/(\d+)\/job\/\d+$/);
      assert.ok(url, 'CURRENT_MAIN_CHECK_URL_REQUIRED');
      const workflow = ci.workflowRuns[url[1]];
      assert.ok(workflow, 'CURRENT_MAIN_WORKFLOW_PROVENANCE_REQUIRED');
      assert.deepEqual([workflow.id, workflow.event, workflow.head_branch, workflow.head_sha, workflow.html_url], [Number(url[1]), 'push', 'main', ci.source, `https://github.com/bzinkan/SchoolPilot/actions/runs/${url[1]}`], 'CURRENT_MAIN_WORKFLOW_IS_NOT_PUSH_MAIN');
    }
    const failed = ci.checks.some(check => check.status === 'completed' && !['success', 'skipped'].includes(check.conclusion));
    const passed = !failed && REQUIRED_MAIN_CHECKS.every(name => ci.checks.some(check => check.name === name && check.status === 'completed' && check.conclusion === 'success')) && ci.checks.every(check => check.status === 'completed') && Object.values(ci.workflowRuns).every(workflow => workflow.status === 'completed' && workflow.conclusion === 'success');
    assert.equal(ci.status, failed ? 'failed' : passed ? 'passed' : 'pending', 'CURRENT_MAIN_CI_OUTCOME_CHANGED');
    const gate = index.gates.find(entry => entry.id === 'current-main-preparation-ci');
    assert.ok(gate, 'CURRENT_MAIN_CI_GATE_REQUIRED');
    assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, gate.evidence], [ci.status, resultingMain ? 'historical' : 'current_baseline', ci.source, ['reconciliation']], 'CURRENT_MAIN_CI_GATE_CHANGED');
    const afterSuccessors = reconciliation.recordedAsOf.kind === 'after_successor_merges';
    const afterClosing = reconciliation.recordedAsOf.kind === 'after_closing_pr_merge' || afterSuccessors;
    if (afterClosing) {
      assert.deepEqual([reconciliation.recordedAsOf.closingPullRequest, reconciliation.recordedAsOf.resultingMainCiStatus, reconciliation.recordedAsOf.pendingMergePullRequests], [619, ci.status, []], 'CLOSING_OBSERVATION_SCOPE_CHANGED');
      assert.match(reconciliation.recordedAsOf.closingMergeSha ?? '', sha, 'CLOSING_MERGE_SOURCE_REQUIRED');
    } else {
      assert.deepEqual([reconciliation.recordedAsOf.kind, reconciliation.recordedAsOf.closingPullRequest, reconciliation.recordedAsOf.closingMergeSha, reconciliation.recordedAsOf.resultingMainCiStatus], ['before_closing_pr_merge', 619, null, 'pending'], 'FUTURE_CLOSING_MERGE_REJECTED');
      assert.deepEqual(reconciliation.recordedAsOf.pendingMergePullRequests, [619, 620], 'PENDING_SOURCE_MERGE_SCOPE_CHANGED');
    }
    assert.deepEqual(reconciliation.preparationPullRequests.map(pr => pr.number).sort((a, b) => a - b), [616, 617, 619, 620], 'PREPARATION_PR_SCOPE_CHANGED');
    for (const pr of reconciliation.preparationPullRequests) {
      assert.ok(['OPEN', 'MERGED'].includes(pr.state), 'PREPARATION_PR_STATE_INVALID');
      assert.match(pr.headRefOid, sha, 'PREPARATION_PR_SOURCE_REQUIRED');
      if (pr.state === 'MERGED') {
        assert.match(pr.mergeCommit?.oid ?? '', sha, 'PREPARATION_PR_MERGE_SOURCE_REQUIRED');
        assert.ok(stamp(pr.mergedAt), 'PREPARATION_PR_MERGE_TIME_REQUIRED');
      } else assert.deepEqual([pr.mergeCommit, pr.mergedAt], [null, null], 'PENDING_PR_CANNOT_BE_MERGED');
    }
    const closing = reconciliation.preparationPullRequests.find(pr => pr.number === 619);
    const tooling = reconciliation.preparationPullRequests.find(pr => pr.number === 620);
    if (afterClosing) {
      assert.ok(reconciliation.preparationPullRequests.every(pr => pr.state === 'MERGED'), 'CLOSING_MERGES_REQUIRED');
      assert.equal(closing.mergeCommit.oid, reconciliation.recordedAsOf.closingMergeSha, 'CLOSING_MERGE_OBSERVATION_CHANGED');
      if (afterSuccessors) {
        assert.deepEqual(reconciliation.recordedAsOf.successorPullRequests, [621, 622, 623], 'SUCCESSOR_MERGE_SCOPE_CHANGED');
        const successors = reconciliation.schoolpilotPullRequests.filter(pr => reconciliation.recordedAsOf.successorPullRequests.includes(pr.number));
        assert.equal(successors.length, 3, 'SUCCESSOR_MERGES_REQUIRED');
        for (const pr of successors) {
          assert.equal(pr.state, 'MERGED', 'SUCCESSOR_MERGES_REQUIRED');
          assert.match(pr.mergeCommit?.oid ?? '', sha, 'SUCCESSOR_MERGE_SOURCE_REQUIRED');
          assert.ok(stamp(pr.mergedAt), 'SUCCESSOR_MERGE_TIME_REQUIRED');
        }
        assert.equal(reconciliation.schoolpilotRemoteMain, successors.find(pr => pr.number === 623).mergeCommit.oid, 'SUCCESSOR_MAIN_SOURCE_CHANGED');
      } else assert.equal(reconciliation.schoolpilotRemoteMain, closing.mergeCommit.oid, 'CLOSING_MAIN_SOURCE_CHANGED');
      assert.ok(tooling.mergeCommit.oid !== closing.mergeCommit.oid, 'DISTINCT_TOOLING_MERGE_REQUIRED');
    } else {
      assert.deepEqual([closing.state, closing.mergeCommit, closing.mergedAt], ['OPEN', null, null], 'FUTURE_CLOSING_MERGE_REJECTED');
      assert.deepEqual([tooling.state, tooling.mergeCommit, tooling.mergedAt], ['OPEN', null, null], 'FUTURE_TOOLING_MERGE_REJECTED');
    }
  }
  for (const entry of index.inclusionMatrix) {
    const observed = entry.repository === 'SchoolPilot' ? entry.number === resultingMain?.pullRequest.number ? resultingMain.pullRequest : reconciliation.schoolpilotPullRequests.find(pr => pr.number === entry.number) : reconciliation.classpilotPullRequest;
    assert.ok(observed && observed.number === entry.number, 'MERGE_OBSERVATION_MISSING');
    assert.deepEqual([entry.state, entry.headSha, entry.mergeSha, entry.mergedAtUtc], [observed.state, observed.headRefOid, observed.mergeCommit.oid, observed.mergedAt], 'MERGE_OBSERVATION_CHANGED');
  }
  const facts = receipt('artifactsHistorical');
  for (const [id, role] of [['backend-ddc', 'serving'], ['fallback-c578', 'fallback']]) {
    const artifact = index.artifacts.find(entry => entry.id === id), fact = facts[role];
    assert.equal(artifact.sourceSha, fact.source, 'ARTIFACT_SOURCE_CHANGED');
    assert.deepEqual(artifact.identity, { indexDigest: fact.imageIdentities.indexDigest, platformManifestDigest: fact.imageIdentities.platformManifestDigest, configDigest: fact.imageIdentities.configDigest, archiveSha256: fact.archiveSha256 }, 'ARTIFACT_RECEIPT_CHANGED');
  }
  const extension = index.artifacts.find(entry => entry.id === 'extension'), fresh = receipt('extensionFresh');
  assert.deepEqual([extension.sourceSha, extension.identity.zipSha256, extension.identity.bytes], [fresh.source, fresh.zipSha256, fresh.zipBytes], 'EXTENSION_RECEIPT_CHANGED');
  assert.equal(fresh.canonicalVerifier.status, 'passed', 'CANONICAL_PACKAGE_UNVERIFIED');
  assert.equal(index.gates.find(entry => entry.id === 'extension-raw-git').status, 'failed', 'RAW_PACKAGE_FAILURE_RECLASSIFIED');
  const local = receipt('localArtifactsFresh');
  assert.deepEqual([local.schemaVersion, local.kind, local.baseline, local.frozenReleaseReference, local.applicability.releaseReady, local.applicability.preparationSourceIsCurrentMain], [1, 'local_preparation_artifact_observation', historicalReconciliation.schoolpilotRemoteMain, null, false, false], 'PREPARATION_APPLICABILITY_CHANGED');
  const preparationBackend = index.artifacts.find(entry => entry.id === 'backend-preparation');
  const preparationFrontend = index.artifacts.find(entry => entry.id === 'frontend-preparation');
  assert.deepEqual([preparationBackend.status, preparationBackend.applicability, preparationBackend.sourceSha, preparationBackend.identity], ['passed', 'preparation_only', local.preparationSource, { localImageId: local.backend.imageId, configDigest: local.backend.configDigest, archiveSha256: local.backend.archiveSha256, reportSha256: local.backend.reportSha256 }], 'PREPARATION_BACKEND_RECEIPT_CHANGED');
  assert.deepEqual([preparationFrontend.status, preparationFrontend.applicability, preparationFrontend.sourceSha, preparationFrontend.identity], ['passed', 'preparation_only', local.frontend.builtFrom, { archiveSha256: local.frontend.archiveSha256, fileInventorySha256: local.frontend.fileInventorySha256 }], 'PREPARATION_FRONTEND_RECEIPT_CHANGED');
  const retained = index.artifacts.find(entry => entry.id === 'fallback-c578');
  assert.deepEqual([local.retainedFallback.sourceSha, local.retainedFallback.imageId, local.retainedFallback.configDigest], [retained.sourceSha, retained.identity.indexDigest, retained.identity.configDigest], 'FRESH_FALLBACK_SUBSTITUTED');
  assert.deepEqual([local.retainedFallback.status, local.retainedFallback.passed, local.retainedFallback.counts.CRITICAL, local.retainedFallback.counts.HIGH, local.applicability.fallbackGate, local.applicability.historicalFallbackScanRetained], ['failed', false, 1, 1, 'failed', true], 'FRESH_FALLBACK_FAILURE_RECLASSIFIED');
  const fallbackGate = index.gates.find(entry => entry.id === 'fallback-scan-current');
  assert.deepEqual([fallbackGate.status, fallbackGate.applicability, fallbackGate.sourceSha, fallbackGate.evidence, retained.status, retained.applicability], ['failed', 'current_baseline', retained.sourceSha, ['localArtifactsFresh'], 'passed', 'historical'], 'FALLBACK_SCAN_HISTORY_RECLASSIFIED');
  for (const [id, proof] of [['backend-scan-preparation', local.backend], ['screenshot-preparation', local.screenshotProcessing]]) {
    const gate = index.gates.find(entry => entry.id === id);
    assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, proof.passed], ['passed', 'preparation_only', local.preparationSource, true], 'PREPARATION_GATE_RECEIPT_CHANGED');
  }
  assert.ok([local.backend, local.retainedFallback].every(proof => proof.custody.scannerExitCode === 0 && proof.custody.exactOwnedContainer === true && proof.custody.forcedRemoval === false && proof.custody.unforcedRemoval === true && proof.custody.removalExitCode === 0), 'FRESH_SCAN_CUSTODY_REQUIRED');
  const focused = receipt('coordinatorNewline'), followups = receipt('preparationFollowups');
  assert.deepEqual([focused.kind, focused.baselineSource, focused.originalInfrastructure.status, focused.originalInfrastructure.counts, focused.fullInfrastructureRerun, focused.releaseReadiness], ['focused_coordinator_newline_tooling_check', historicalReconciliation.schoolpilotRemoteMain, 'failed', { tests: 1051, pass: 1048, fail: 3, skipped: 0 }, 'pending', false], 'FULL_INFRASTRUCTURE_HISTORY_CHANGED');
  assert.ok(focused.committedToolReference.exactTestedPatchFilesMatch && sha.test(focused.committedToolReference.commit), 'TESTED_TOOL_COMMIT_REQUIRED');
  assert.deepEqual(focused.checks.map(check => [check.status, check.counts]), [['passed', { tests: 35, pass: 35, fail: 0, skipped: 0 }], ['passed', { tests: 339, pass: 339, fail: 0, skipped: 0 }]], 'FOCUSED_TOOLING_RESULTS_CHANGED');
  const state = (id, status, source, evidence, error) => {
    const gate = index.gates.find(entry => entry.id === id);
    assert.ok(gate, error);
    assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, gate.evidence], [status, 'preparation_only', source, evidence], error);
  };
  state('baseline-infrastructure', 'failed', focused.baselineSource, ['coordinatorNewline'], 'FULL_INFRASTRUCTURE_FAILURE_RECLASSIFIED');
  state('focused-role-rerun', 'passed', focused.committedToolReference.commit, ['coordinatorNewline'], 'FOCUSED_RERUN_APPLICABILITY_CHANGED');
  state('full-infrastructure-after-fix', 'pending', focused.committedToolReference.commit, ['coordinatorNewline'], 'FOCUSED_RERUN_IS_NOT_FULL_INFRASTRUCTURE');
  assert.deepEqual([followups.schemaVersion, followups.kind, followups.operationalAuthorization], [1, 'cross_pr_preparation_summary', false], 'FOLLOWUP_APPLICABILITY_CHANGED');
  for (const reference of [focused.originalInfrastructure.canonicalEvidence, ...Object.values(followups.canonicalReferences)]) {
    assert.equal(reference.repository, 'bzinkan/SchoolPilot', 'CANONICAL_RECEIPT_REPOSITORY_CHANGED');
    assert.match(reference.commit, sha, 'CANONICAL_RECEIPT_COMMIT_REQUIRED');
    assert.match(reference.gitBlobSha256, hash, 'CANONICAL_RECEIPT_HASH_REQUIRED');
    assert.ok(/^docs\/release-evidence\/[A-Za-z0-9_./-]+$/.test(reference.path) && !reference.path.split('/').includes('..'), 'CANONICAL_RECEIPT_PATH_REQUIRED');
    assert.equal(reference.url, `https://github.com/bzinkan/SchoolPilot/blob/${reference.commit}/${reference.path}`, 'CANONICAL_RECEIPT_LINK_CHANGED');
  }
  assert.deepEqual([followups.baseline.source, followups.baseline.backendType, followups.baseline.backendBuild, followups.baseline.unit.status, followups.baseline.unit.counts, followups.baseline.governance.status], [historicalReconciliation.schoolpilotRemoteMain, 'passed', 'passed', 'passed', { tests: 2276, pass: 2272, fail: 0, skipped: 4 }, 'passed'], 'BASELINE_PREPARATION_RESULTS_CHANGED');
  state('baseline-local-checks', 'passed', followups.baseline.source, ['preparationFollowups'], 'BASELINE_PREPARATION_APPLICABILITY_CHANGED');
  assert.deepEqual([followups.publicCopyCi.pullRequest, followups.publicCopyCi.event, followups.publicCopyCi.exactMainCi, followups.publicCopyCi.applicableChecksPassed, followups.publicCopyCi.emittedChecks, followups.publicCopyCi.successes, followups.publicCopyCi.failures, followups.publicCopyCi.skipped], [617, 'pull_request', false, true, 19, 18, 0, 1], 'PR_PREPARATION_CI_CHANGED');
  state('public-copy-preparation-ci', 'passed', followups.publicCopyCi.headSha, ['preparationFollowups'], 'PR_CI_IS_NOT_EXACT_MAIN');
  assert.deepEqual([followups.database.source, followups.database.scope, followups.database.productionAccess, followups.database.originalOrdinary.fail, followups.database.correctedRedis.pass, followups.database.correctedRedis.fail, followups.database.restrictedLocal.pass, followups.database.restrictedLocal.fail, followups.database.restrictedLocal.rolsuper, followups.database.restrictedLocal.rolbypassrls, followups.database.restrictedLocal.uniqueAllowlist, followups.database.ciOrdinary.skipped, followups.database.ciRestricted.skipped, followups.database.extensionCaptureFixture.version], [followups.publicCopyCi.headSha, 'source_bound_full_schema_fixture_only', false, 4, 4, 0, 513, 0, false, false, 129, 8, 1, '2.9.3'], 'DATABASE_PREPARATION_HISTORY_CHANGED');
  state('restricted-database-preparation', 'passed', followups.database.source, ['preparationFollowups'], 'DATABASE_FIXTURE_IS_NOT_RELEASE_RECOVERY');
  const mergeRequest = receipt('mergeRequest');
  assert.deepEqual([mergeRequest.schemaVersion, mergeRequest.kind, mergeRequest.verificationMethod, mergeRequest.repository, mergeRequest.pullRequests, mergeRequest.completionRequiredBeforeMerge, mergeRequest.releaseOperationsAuthorized], [1, 'operator_scoped_source_merge_request', 'operator_report', 'bzinkan/SchoolPilot', [616, 617, 619, 620], true, false], 'MERGE_REQUEST_SCOPE_CHANGED');
  const store = receipt('operatorStoreVersion');
  assert.deepEqual([store.schemaVersion, store.kind, store.verificationMethod, store.product, store.liveVersion, store.independentStoreCapture], [1, 'operator_confirmed_extension_store_version', 'operator_report', 'ClassPilot', '2.9.7', false], 'STORE_OPERATOR_REPORT_CHANGED');
  assert.deepEqual([store.uploadedZipSha256, store.pendingSubmissionState, store.managedAdoptionState, store.managedValidation, store.unchangedCandidateUploadRequired, store.releaseOperationsAuthorized], [null, 'unknown', 'pending', 'waived_not_passed', false, false], 'STORE_REPORT_IS_NOT_PACKAGE_OR_ADOPTION_PROOF');
  for (const observation of [mergeRequest, store]) assert.ok(stamp(observation.observedAtUtc) && Date.parse(observation.observedAtUtc) <= Date.parse(index.observedAtUtc), 'AUTHORITY_OBSERVATION_TIME_REQUIRED');
  for (const [id, status, applicability, source, evidence] of [['merge-request', 'passed', 'policy_definition', null, ['mergeRequest']], ['store-live-version', 'passed', 'current_baseline', null, ['operatorStoreVersion']], ['store', 'unknown', 'equivalence_required', null, ['operatorStoreVersion']], ['store-unchanged-upload', 'not_applicable', 'equivalence_required', index.sources.classpilot.remoteMainObserved, ['operatorStoreVersion', 'extensionFresh']]]) {
    const gate = index.gates.find(entry => entry.id === id);
    assert.ok(gate, 'AUTHORITY_GATE_REQUIRED');
    assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, gate.evidence], [status, applicability, source, evidence], 'AUTHORITY_GATE_APPLICABILITY_CHANGED');
  }
  if (index.evidence.successorSourceReview) {
    const review = receipt('successorSourceReview');
    assert.deepEqual([review.schemaVersion, review.kind, review.status, review.passed, review.baseSource, review.successorSource, review.referencePatchSource], [1, 'release297_successor_source_delta_independent_review', 'passed', true, 'c578120d980d4c2405a72f4f40b2d3c29a07e20b', 'd75fc1c48d0a3918857508d3965904c69023a153', '86ea5c5ca5f76406300f5170d2ecb3e3554baeb3'], 'SUCCESSOR_SOURCE_REVIEW_CHANGED');
    assert.deepEqual(review.changedPaths, ['package-lock.json'], 'SUCCESSOR_SOURCE_SCOPE_BROADENED');
    assert.equal(review.changedPackageCount, 28, 'SUCCESSOR_DEPENDENCY_DELTA_CHANGED');
    assert.deepEqual(review.dependencyVersions, { 'proxy-addr': '2.0.8', sharp: '0.35.5', sharpNative: '0.35.5', sharpLibvips: '1.3.4' }, 'SUCCESSOR_PATCH_VERSIONS_CHANGED');
    assert.deepEqual([review.parentIsExactC578, review.cleanSourceVerified, review.referencePackageRecordsMatchExactly, review.unrelatedLockfileRecordsAndMetadataUnchanged, review.entireCurrentMainLockfileCopied], [true, true, true, true, false], 'SUCCESSOR_LOCKFILE_REVIEW_INCOMPLETE');
    assert.ok(Object.values(review.unchangedInputs).every(value => value === true), 'SUCCESSOR_APPLICATION_INPUTS_CHANGED');
    assert.deepEqual([review.releaseReady, review.operationalAuthorization, review.humanReplacementSelectionRecorded], [false, false, false], 'SUCCESSOR_SOURCE_REVIEW_IS_NOT_SELECTION');
    assert.ok(stamp(review.observedAt) && Date.parse(review.observedAt) <= Date.parse(index.observedAtUtc), 'SUCCESSOR_SOURCE_OBSERVATION_TIME_REQUIRED');
    const gate = index.gates.find(entry => entry.id === 'fallback-successor-source');
    assert.ok(gate, 'SUCCESSOR_SOURCE_GATE_REQUIRED');
    assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, gate.evidence], ['passed', successorReceiptApplicability, review.successorSource, ['successorSourceReview']], 'SUCCESSOR_SOURCE_GATE_CHANGED');
  }
  if (index.evidence.successorPreparationObservation) {
    const proof = receipt('successorPreparationObservation');
    metadataOnly(proof);
    assert.deepEqual([proof.schemaVersion, proof.kind, proof.releaseBindingId, proof.preparationPassed, proof.releaseReady, proof.operationalAuthorization, proof.successorSelection], [1, 'release297_successor_preparation_observation', 'release-297-current-school-fallback-v3', true, false, false, 'pending_exact_artifact_review'], 'SUCCESSOR_PREPARATION_IS_NOT_SELECTION');
    assert.equal(proof.cloudMutations, 0, 'SUCCESSOR_PREPARATION_MUST_REMAIN_OFFLINE');
    assert.ok(stamp(proof.observedAtUtc) && Date.parse(proof.observedAtUtc) <= Date.parse(index.observedAtUtc), 'SUCCESSOR_PREPARATION_TIME_REQUIRED');
    for (const value of [proof.bindingSha256, proof.validatorSha256, proof.validationResultSha256]) assert.match(value, hash, 'SUCCESSOR_PREPARATION_HASH_REQUIRED');
    assert.match(proof.testedToolingSource, sha, 'SUCCESSOR_TOOLING_SOURCE_REQUIRED');
    const binding = receipt('successorBinding');
    metadataOnly(binding);
    assert.equal(index.evidence.successorBinding.gitBlobSha256, proof.bindingSha256, 'SUCCESSOR_BINDING_HASH_CHANGED');
    assert.deepEqual([binding.schemaVersion, binding.id, binding.status, binding.preparation.status, binding.operationalAuthorization, binding.successorSelection.status], [3, proof.releaseBindingId, 'pending', 'passed', false, 'pending'], 'SUCCESSOR_BINDING_IS_NOT_RELEASE_ACCEPTANCE');
    assert.deepEqual(Object.keys(proof.artifactPair).sort(), ['fallback', 'serving-anchor'], 'SUCCESSOR_ARTIFACT_ROLES_REQUIRED');
    assert.deepEqual(proof.artifactPair, Object.fromEntries(['serving-anchor', 'fallback'].map(role => [role, Object.fromEntries(['source', 'localIndex', 'config', 'platform', 'archiveSha256'].map(key => [key, binding.artifacts[role][key]]))])), 'SUCCESSOR_PROFILE_ARTIFACT_PAIR_CHANGED');
    assert.equal(proof.artifactPair.fallback.source, 'd75fc1c48d0a3918857508d3965904c69023a153', 'SUCCESSOR_FALLBACK_SOURCE_CHANGED');
    assert.equal(proof.artifactPair['serving-anchor'].source, 'a5161eb14939132776e0b77eac8e3c485091432c', 'SUCCESSOR_APPLICATION_SOURCE_CHANGED');
    const kinds = ['successorScan', 'screenshotRuntime', 'requestIpRateLimit', 'ordinaryRecovery', 'restrictedRestoration'];
    assert.deepEqual(Object.keys(proof.preparationEvidence).sort(), kinds.sort(), 'SUCCESSOR_PREPARATION_EVIDENCE_REQUIRED');
    for (const kind of kinds) {
      const ref = proof.preparationEvidence[kind], native = receipt(ref);
      metadataOnly(native);
      assert.equal(native.operationalAuthorization, false, 'SUCCESSOR_WRAPPER_IS_NOT_AUTHORIZATION');
      assert.deepEqual([binding.preparation.evidence[kind].path, binding.preparation.evidence[kind].sha256, binding.preparation.evidence[kind].status], [index.evidence[ref].path, index.evidence[ref].gitBlobSha256, 'passed'], 'SUCCESSOR_BINDING_RECEIPT_CHANGED');
      assert.deepEqual([native.schemaVersion, native.kind, native.releaseBindingId, native.evidenceKind, native.artifactPair, native.passed], [1, 'release_successor_preparation_evidence', proof.releaseBindingId, kind, proof.artifactPair, true], 'SUCCESSOR_PREPARATION_ROLE_OR_RECEIPT_CHANGED');
      assert.ok(stamp(native.observedAtUtc) && Date.parse(native.observedAtUtc) <= Date.parse(proof.observedAtUtc), 'SUCCESSOR_NATIVE_OBSERVATION_TIME_REQUIRED');
      assert.deepEqual(Object.keys(native.retainedEvidence).sort(), ['independentReview', 'nativeResult'], 'SUCCESSOR_NATIVE_REVIEW_REQUIRED');
      for (const evidence of Object.values(native.retainedEvidence)) assert.match(evidence.sha256, hash, 'SUCCESSOR_NATIVE_REVIEW_HASH_REQUIRED');
      const gate = index.gates.find(entry => entry.id === `fallback-successor-${kind}`);
      assert.ok(gate, 'SUCCESSOR_PREPARATION_GATE_REQUIRED');
      assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, gate.evidence], ['passed', successorReceiptApplicability, proof.artifactPair.fallback.source, [ref]], 'SUCCESSOR_PREPARATION_GATE_CHANGED');
    }
    for (const [role, id] of [['serving-anchor', 'backend-successor-anchor'], ['fallback', 'fallback-successor-artifact']]) {
      const artifact = index.artifacts.find(entry => entry.id === id), exact = proof.artifactPair[role];
      assert.ok(artifact, 'SUCCESSOR_ARTIFACT_REQUIRED');
      assert.deepEqual([artifact.status, artifact.applicability, artifact.sourceSha, artifact.evidence, artifact.identity], ['passed', successorReceiptApplicability, exact.source, ['successorPreparationObservation'], { indexDigest: exact.localIndex, platformManifestDigest: exact.platform, configDigest: exact.config, archiveSha256: exact.archiveSha256 }], 'SUCCESSOR_ARTIFACT_ROLE_CHANGED');
    }
    for (const [id, status] of [['fallback-successor-preparation', 'passed'], ['fallback-successor-selection', 'pending']]) {
      const gate = index.gates.find(entry => entry.id === id);
      assert.ok(gate, 'SUCCESSOR_SELECTION_GATE_REQUIRED');
      assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, gate.evidence], [status, id === 'fallback-successor-preparation' ? successorReceiptApplicability : 'preparation_only', proof.artifactPair.fallback.source, ['successorPreparationObservation']], 'SUCCESSOR_SELECTION_CANNOT_BE_INFERRED');
    }
    if (index.evidence.successorOperationalRejections) {
      const rejected = receipt('successorOperationalRejections');
      metadataOnly(rejected);
      assert.deepEqual([rejected.schemaVersion, rejected.kind, rejected.bindingSha256, rejected.preparationCanPassWhileOperationalPlansReject, rejected.releaseReady, rejected.operationalAuthorization], [1, 'pending_successor_operational_plan_rejections', proof.bindingSha256, true, false, false], 'SUCCESSOR_OPERATIONAL_REJECTIONS_CHANGED');
      assert.deepEqual(rejected.records.map(entry => [entry.operation, entry.rejected, entry.reason, entry.externalCommands, entry.cloudMutations]), ['PlanPublicationServing', 'PlanPublicationFallback', 'PlanUnused121', 'PlanAnchor128', 'PlanCompatibleFallback'].map(operation => [operation, true, 'SUCCESSOR_SELECTION_PENDING', 0, 0]), 'SUCCESSOR_PENDING_PLANS_MUST_REJECT_OFFLINE');
    }
  }
  if (index.evidence.successorSourceChecks) {
    const checks = receipt('successorSourceChecks'), proof = receipt('successorPreparationObservation');
    metadataOnly(checks);
    assert.deepEqual([checks.schemaVersion, checks.kind, checks.source, checks.artifactPair, checks.releaseReady, checks.operationalAuthorization, checks.productionMutations], [1, 'release297_fallback_successor_source_specific_checks', proof.artifactPair.fallback.source, proof.artifactPair, false, false, 0], 'SUCCESSOR_SOURCE_CHECKS_IDENTITY_CHANGED');
    assert.ok(stamp(checks.observedAtUtc) && Date.parse(checks.observedAtUtc) <= Date.parse(index.observedAtUtc), 'SUCCESSOR_SOURCE_CHECK_TIME_REQUIRED');
    assert.deepEqual(checks.sourceDelta.changedPaths, ['package-lock.json'], 'SUCCESSOR_LOCK_ONLY_DELTA_REQUIRED');
    assert.equal(checks.sourceDelta.applicationMigrationsDockerfileAndBuildUnchanged, true, 'SUCCESSOR_LOCK_ONLY_DELTA_REQUIRED');
    const step = command => {
      const matches = checks.steps.filter(entry => entry.command === command);
      assert.equal(matches.length, 1, 'SUCCESSOR_CHECK_COMMAND_REQUIRED');
      assert.match(matches[0].evidence.sha256, hash, 'SUCCESSOR_CHECK_HASH_REQUIRED');
      return matches[0];
    };
    for (const [id, command, outcome, exitCode, gateStatus] of [
      ['type', 'npm run check', 'passed', 0, 'passed'],
      ['build', 'npm run build', 'passed', 0, 'passed'],
      ['unit', 'npm run test:unit', 'passed_with_explicit_skips', 0, 'passed'],
      ['db', 'npm run test:db-serial', 'failed', 1, 'failed'],
      ['rls', 'npm run test:rls-serial', 'passed', 0, 'passed'],
      ['full-audit', 'npm audit --json', 'failed', 1, 'failed'],
      ['production-default-audit', 'npm audit --omit=dev --json', 'failed', 1, 'failed'],
      ['production-high-audit', 'npm audit --omit=dev --audit-level=high --json', 'passed', 0, 'passed']
    ]) {
      assert.deepEqual([step(command).status, step(command).exitCode], [outcome, exitCode], 'SUCCESSOR_ORIGINAL_CHECK_OUTCOME_CHANGED');
      const gate = index.gates.find(entry => entry.id === `fallback-successor-f-${id}`);
      assert.ok(gate, 'SUCCESSOR_SOURCE_CHECK_GATE_REQUIRED');
      assert.deepEqual([gate.status, gate.applicability, gate.sourceSha, gate.evidence], [gateStatus, successorReceiptApplicability, checks.source, ['successorSourceChecks']], 'SUCCESSOR_SOURCE_CHECK_GATE_RECLASSIFIED');
    }
    for (const [command, counts] of [['npm run test:unit', [1732, 0, 4]], ['npm run test:db-serial', [1400, 1, 8]], ['npm run test:rls-serial', [383, 0, 0]]]) {
      const recorded = step(command).counts;
      assert.deepEqual([recorded.pass, recorded.fail, recorded.skipped], counts, 'SUCCESSOR_ORIGINAL_TEST_COUNTS_CHANGED');
    }
    const fixture = checks.correctedScreenshotFixture, review = receipt('successorDatabaseFixtureReview');
    metadataOnly(review);
    assert.deepEqual([fixture.status, fixture.applicationSource, fixture.fixtureSource, fixture.reviewedCorrection, fixture.exitCode, fixture.counts.pass, fixture.counts.fail, fixture.counts.skipped, fixture.fullExactFDatabaseCommandRelabeled], ['passed', checks.source, proof.artifactPair['serving-anchor'].source, 'bcded1cfeea7b2b10f3d239eceec09d41748486c', 0, 8, 0, 0, false], 'SUCCESSOR_TARGETED_FIXTURE_IS_SEPARATE');
    assert.deepEqual([fixture.compiledModuleIdentity.byteExactCompiledFiles, fixture.compiledModuleIdentity.hostInventorySha256, fixture.compiledModuleIdentity.imageInventorySha256, fixture.ownedCleanupPassed], [1571, '8635335700e94423c2072defb607607e0302ae98c9f69a085618290d8ccdbce4', '8635335700e94423c2072defb607607e0302ae98c9f69a085618290d8ccdbce4', true], 'SUCCESSOR_FIXTURE_REQUIRES_IMAGE_EQUIVALENCE');
    assert.deepEqual([review.kind, review.passed, review.applicationSource, review.applicationImage, review.reviewedFixtureSource, review.reviewedCorrection, review.fullExactFDatabase.status, review.fullExactFDatabase.fail, review.releaseReady, review.operationalAuthorization], ['exact_f_database_fixture_correction_independent_review', true, checks.source, proof.artifactPair.fallback.localIndex, fixture.fixtureSource, fixture.reviewedCorrection, 'failed', 1, false, false], 'SUCCESSOR_FIXTURE_REVIEW_CHANGED');
    assert.equal(review.verified.FRemainsC578PlusLockfile, true, 'SUCCESSOR_LOCK_ONLY_DELTA_REQUIRED');
    const fixtureGate = index.gates.find(entry => entry.id === 'fallback-successor-f-reviewed-fixture');
    assert.ok(fixtureGate, 'SUCCESSOR_FIXTURE_GATE_REQUIRED');
    assert.deepEqual([fixtureGate.status, fixtureGate.applicability, fixtureGate.sourceSha, fixtureGate.evidence], ['passed', successorReceiptApplicability, checks.source, ['successorSourceChecks', 'successorDatabaseFixtureReview']], 'SUCCESSOR_FIXTURE_IS_NOT_FULL_DATABASE');
  }
  if (index.evidence.cpAiBoundaryPreparation) {
    const cp = receipt('cpAiBoundaryPreparation');
    metadataOnly(cp);
    assert.deepEqual([cp.schemaVersion, cp.kind, cp.releaseReady, cp.operationalAuthorization, cp.productionMutations], [1, 'classpilot_ai_browser_boundary_preparation', false, false, 0], 'CP_AI_PREPARATION_IS_NOT_AUTHORIZATION');
    assert.ok(stamp(cp.observedAtUtc) && Date.parse(cp.observedAtUtc) <= Date.parse(index.observedAtUtc), 'CP_AI_OBSERVATION_TIME_REQUIRED');
    assert.match(cp.observedMainBaseline, sha, 'CP_AI_MAIN_SOURCE_REQUIRED');
    assert.ok(cp.testedSource === null || sha.test(cp.testedSource), 'CP_AI_TESTED_SOURCE_REQUIRED');
    assert.deepEqual([cp.credentialAndTokenScopeOnly, cp.ordinaryEmailsAndSearchTermsRemain, cp.originalInputsRetainedForLocalClassificationAndRestrictions, cp.applicationInputsChanged, cp.fallbackRollbackRestoresPriorProviderBoundary], [true, true, true, true, true], 'CP_AI_SCOPE_OR_APPLICABILITY_CHANGED');
    assert.deepEqual([cp.priorApplicationReferenceA, cp.unchangedFallbackSourceF, cp.recoveryEvidenceApplicability], [receipt('successorPreparationObservation').artifactPair['serving-anchor'].source, receipt('successorPreparationObservation').artifactPair.fallback.source, 'historical_A_F_pair_only'], 'CP_AI_HISTORICAL_PAIR_CHANGED');
    assert.equal(cp.policyVersion, 'classpilot-ai-request-input-2026-10-08.1', 'CP_AI_POLICY_VERSION_CHANGED');
    if (cp.syntheticValidationStatus === 'passed') {
      for (const filename of ['src/services/classpilotAiRequestInput.ts', 'src/services/aiClassification.ts', 'tests/classpilot-provider-boundary-audit.test.ts']) {
        assert.match(cp.sourceAndTestHashes?.[filename] ?? '', hash, 'CP_AI_SYNTHETIC_SOURCE_HASH_REQUIRED');
      }
      assert.ok(Array.isArray(cp.steps), 'CP_AI_SYNTHETIC_STEPS_REQUIRED');
      const focused = cp.steps.filter(step => step.id === 'boundary-focused');
      assert.equal(focused.length, 1, 'CP_AI_SYNTHETIC_BOUNDARY_STEP_REQUIRED');
      const step = focused[0];
      assert.deepEqual([step.source, step.status, step.exitCode, step.failed, step.skipped], [cp.testedSource, 'passed', 0, 0, 0], 'CP_AI_SYNTHETIC_BOUNDARY_OUTCOME_CHANGED');
      assert.ok(text(step.command) && step.command.includes('tests/classpilot-provider-boundary-audit.test.ts'), 'CP_AI_SYNTHETIC_BOUNDARY_COMMAND_REQUIRED');
      assert.ok(Number.isInteger(step.tests) && step.tests > 0 && step.passed === step.tests, 'CP_AI_SYNTHETIC_POSITIVE_COUNTS_REQUIRED');
      assert.match(step.logSha256 ?? '', hash, 'CP_AI_SYNTHETIC_LOG_HASH_REQUIRED');
    }
    for (const [id, field] of [['implementation', 'implementationStatus'], ['synthetic', 'syntheticValidationStatus'], ['review', 'reviewStatus'], ['deployment', 'deploymentStatus'], ['live', 'liveVerificationStatus']]) {
      const gate = index.gates.find(entry => entry.id === `cp-ai-001-${id}`);
      assert.ok(gate, 'CP_AI_SEPARATE_GATE_REQUIRED');
      assert.ok(['pending', 'passed', 'failed'].includes(cp[field]), 'CP_AI_GATE_STATUS_REQUIRED');
      const currentReview = id === 'review' && index.evidence.candidateRefresh;
      assert.deepEqual([gate.status, gate.sourceSha, gate.evidence], [currentReview ? 'passed' : cp[field], cp.testedSource, [currentReview ? 'candidateRefresh' : 'cpAiBoundaryPreparation']], 'CP_AI_GATE_RECEIPT_CHANGED');
      if (['review', 'deployment', 'live'].includes(id)) assert.equal(cp[field], 'pending', 'CP_AI_PREPARATION_CANNOT_APPROVE_OPERATION');
      if (cp[field] === 'passed') assert.match(cp.testedSource ?? '', sha, 'CP_AI_PASS_REQUIRES_TESTED_SOURCE');
    }
  }
  if (index.evidence.candidateRefresh) {
    const current = receipt('candidateRefresh');
    metadataOnly(current);
    assert.deepEqual([current.schemaVersion, current.kind, current.releaseReady, current.operationalAuthorizationReceipt, current.productionDeploymentExecuted], [1, 'release297_current_candidate_observation', false, false, false], 'CURRENT_OBSERVATION_IS_NOT_RELEASE_AUTHORITY');
    assert.ok(stamp(current.observedAtUtc) && Date.parse(current.observedAtUtc) <= Date.parse(index.observedAtUtc), 'CURRENT_OBSERVATION_TIME_REQUIRED');
    assert.deepEqual([current.applicationReferenceA, current.extensionSource, current.extensionVersion, current.cleanSourceAtFreeze], [resultingMain?.applicationReferenceA ?? index.sources.schoolpilot.remoteMainObserved, index.sources.classpilot.remoteMainObserved, '2.9.7', true], 'CURRENT_FREEZE_SOURCE_CHANGED');
    assert.deepEqual([index.sources.schoolpilot.frozenApplicationReference, index.sources.classpilot.frozenApplicationReference], [current.applicationReferenceA, current.extensionSource], 'CURRENT_FREEZE_REQUIRED');
    for (const inventory of [current.backendInventory, current.frontendInventory]) {
      assert.match(inventory.sha256 ?? '', hash, 'CURRENT_FREEZE_INVENTORY_REQUIRED');
      assert.ok(Number.isSafeInteger(inventory.fileCount) && inventory.fileCount > 0, 'CURRENT_FREEZE_INVENTORY_REQUIRED');
    }
    assert.deepEqual([current.authorization.verificationMethod, current.authorization.directUserInstruction, current.authorization.productionDeployment, current.authorization.executionCompleted, current.authorization.controllerReceiptGenerated], ['direct_user_request', 'confirm Cl, merge to main, deploy, clean/remove branch', true, false, false], 'DIRECT_DEPLOYMENT_REQUEST_REQUIRED');
    assert.deepEqual(index.authorization, { merge: false, productionDeployment: true, registryPublication: false, inactiveRegistration: false, storeSubmission: false, runtimeActivation: false, githubSettings: false }, 'DIRECT_DEPLOYMENT_SCOPE_CHANGED');
    const merged = reconciliation.schoolpilotPullRequests.find(pr => pr.number === 622);
    assert.deepEqual([current.cpAiPullRequest, current.cpAiMergeSource, current.cpAiTestedSource, current.cpAiReviewStatus], [622, merged.mergeCommit.oid, receipt('cpAiBoundaryPreparation').testedSource, 'passed'], 'CP_AI_MERGED_REVIEW_OBSERVATION_CHANGED');
    assert.ok(reconciliation.currentMainCi.checks.some(check => check.name === 'Scan Docker image' && check.conclusion === 'success'), 'CURRENT_CANDIDATE_MAIN_SCAN_CHECK_REQUIRED');
    assert.deepEqual([current.fallbackSourceF, current.fallbackSelection, current.fallbackRollbackRestoresPriorProviderBoundary], [receipt('successorPreparationObservation').artifactPair.fallback.source, 'pending_exact_artifact_and_applicability_review', true], 'CURRENT_FALLBACK_APPLICABILITY_CHANGED');
    const freeze = index.gates.find(gate => gate.id === 'candidate-freeze');
    assert.deepEqual([freeze?.status, freeze?.applicability, freeze?.sourceSha, freeze?.evidence], ['passed', 'current_baseline', current.applicationReferenceA, ['candidateRefresh']], 'CURRENT_FREEZE_GATE_CHANGED');
    assert.deepEqual([current.productionObservation.metadataOnly, current.productionObservation.catalogVerified, current.productionObservation.ledgerVerified, current.productionObservation.restoreVerified], [true, false, false, false], 'PRODUCTION_METADATA_IS_NOT_CATALOG_OR_RESTORE_PROOF');
    assert.deepEqual(current.productionObservation.usageModes, { CLASSPILOT_DAILY_USAGE_ROLLUP_MODE: { configuredValue: null, effectiveDefault: 'shadow' }, CLASSPILOT_USAGE_ROLLUP_MODE: { configuredValue: 'off' }, CLASSPILOT_DIGITAL_USAGE_MODE: { configuredValue: 'off' } }, 'CURRENT_USAGE_OBSERVATION_CHANGED');
    for (const [name, value] of [['CLASSPILOT_DAILY_USAGE_ROLLUP_MODE', 'shadow'], ['CLASSPILOT_USAGE_ROLLUP_MODE', 'off'], ['CLASSPILOT_DIGITAL_USAGE_MODE', 'off']]) {
      assert.deepEqual([index.usageModes[name].observedValue, index.usageModes[name].status, index.usageModes[name].evidence], [value, 'passed', ['candidateRefresh']], 'CURRENT_USAGE_GATE_CHANGED');
    }
  }
  if (resultingMain) {
    metadataOnly(resultingMain);
    assert.ok(index.evidence.candidateRefresh, 'RESULTING_MAIN_REQUIRES_FROZEN_REFERENCE');
    assert.deepEqual([resultingMain.schemaVersion, resultingMain.kind, resultingMain.releaseReady, resultingMain.operationalAuthorization, resultingMain.productionDeploymentExecuted], [1, 'release297_resulting_main_observation', false, false, false], 'RESULTING_MAIN_IS_NOT_AUTHORITY');
    assert.ok(stamp(resultingMain.observedAtUtc) && Date.parse(resultingMain.observedAtUtc) <= Date.parse(index.observedAtUtc), 'RESULTING_MAIN_OBSERVATION_TIME_REQUIRED');
    const frozen = receipt('candidateRefresh'), source = resultingMain.resultingMainSourceB;
    assert.match(source, sha, 'RESULTING_MAIN_SOURCE_REQUIRED');
    assert.deepEqual([resultingMain.applicationReferenceA, resultingMain.remoteMainObserved, source], [frozen.applicationReferenceA, source, index.sources.schoolpilot.remoteMainObserved], 'RESULTING_MAIN_PAIR_CHANGED');
    assert.equal(resultingMain.applicationReferenceA, reconciliation.schoolpilotRemoteMain, 'RESULTING_MAIN_APPLICATION_REFERENCE_CHANGED');
    const pr = resultingMain.pullRequest;
    assert.deepEqual([pr.number, pr.state, pr.mergeCommit?.oid], [624, 'MERGED', source], 'RESULTING_MAIN_MERGE_REQUIRED');
    assert.match(pr.headRefOid, sha, 'RESULTING_MAIN_REVIEWED_HEAD_REQUIRED');
    assert.ok(stamp(pr.mergedAt) && Date.parse(pr.mergedAt) <= Date.parse(resultingMain.observedAtUtc), 'RESULTING_MAIN_MERGE_TIME_REQUIRED');
    const equivalence = resultingMain.applicationEquivalence;
    assert.deepEqual([equivalence.cleanToolingSource, equivalence.reviewedPrTreeExactlyPreserved, equivalence.backendInputsEquivalent, equivalence.frontendInputsEquivalent, equivalence.reviewedAcceptanceToolCanonicalGitBytesUnchanged], [true, true, true, true, true], 'RESULTING_MAIN_APPLICATION_EQUIVALENCE_REQUIRED');
    assert.deepEqual([equivalence.backend, equivalence.frontend], [frozen.backendInventory, frozen.frontendInventory], 'RESULTING_MAIN_APPLICATION_INVENTORY_CHANGED');
    for (const value of Object.values(resultingMain.retainedInputs)) assert.match(value, hash, 'RESULTING_MAIN_RETAINED_PROOF_REQUIRED');
    sameKeys(resultingMain.retainedInputs, ['ciSummarySha256', 'equivalenceSha256']);
    const ci = resultingMain.currentMainCi;
    assert.deepEqual([ci.source, ci.status], [source, 'passed'], 'RESULTING_MAIN_CI_REQUIRED');
    assert.ok(Array.isArray(ci.workflowRuns) && ci.workflowRuns.length === 5, 'RESULTING_MAIN_WORKFLOW_PROVENANCE_REQUIRED');
    const workflows = new Map();
    for (const workflow of ci.workflowRuns) {
      assert.ok(!workflows.has(workflow.role) && Number.isSafeInteger(workflow.id) && workflow.id > 0, 'RESULTING_MAIN_WORKFLOW_DUPLICATED');
      const publisher = workflow.role === 'ImmutableReleaseImage';
      assert.deepEqual([workflow.source, workflow.event, workflow.status, workflow.conclusion, workflow.url], [source, publisher ? 'workflow_run' : 'push', 'completed', publisher ? 'skipped' : 'success', `https://github.com/bzinkan/SchoolPilot/actions/runs/${workflow.id}`], 'RESULTING_MAIN_WORKFLOW_TRIGGER_CHANGED');
      workflows.set(workflow.role, workflow);
    }
    assert.deepEqual([...workflows.keys()].sort(), ['CI', 'CodeQL', 'Gitleaks', 'ImmutableReleaseImage', 'Trivy'], 'RESULTING_MAIN_WORKFLOW_PROVENANCE_REQUIRED');
    assert.ok(Array.isArray(ci.checks), 'RESULTING_MAIN_CHECKS_REQUIRED');
    const names = new Set();
    for (const check of ci.checks) {
      assert.ok(text(check.name) && !names.has(check.name), 'RESULTING_MAIN_CHECK_DUPLICATED'); names.add(check.name);
      const workflow = workflows.get(check.name === 'Build, scan, sign, and publish once' ? 'ImmutableReleaseImage' : check.name === 'Analyze (javascript-typescript)' ? 'CodeQL' : check.name === 'Scan for secrets' ? 'Gitleaks' : check.name === 'Scan Docker image' ? 'Trivy' : 'CI');
      assert.ok(new RegExp(`^https://github\\.com/bzinkan/SchoolPilot/actions/runs/${workflow.id}/job/\\d+$`).test(check.url), 'RESULTING_MAIN_CHECK_URL_REQUIRED');
      const skipped = ['Detect changed paths', 'Build, scan, sign, and publish once'].includes(check.name);
      assert.deepEqual([check.source, check.status, check.conclusion], [source, 'completed', skipped ? 'skipped' : 'success'], 'RESULTING_MAIN_CHECK_OUTCOME_CHANGED');
    }
    assert.deepEqual([...names].sort(), [...REQUIRED_MAIN_CHECKS, 'Scan Docker image', 'Detect changed paths', 'Build, scan, sign, and publish once'].sort(), 'RESULTING_MAIN_REQUIRED_CHECK_MISSING');
    assert.deepEqual(ci.jobCounts, { success: 19, skipped: 2, failed: 0 }, 'RESULTING_MAIN_CHECK_COUNTS_CHANGED');
    assert.ok(Array.isArray(ci.emittedTestLanes) && ci.emittedTestLanes.length > 0 && text(ci.testSkipDistinction), 'RESULTING_MAIN_TEST_LANES_REQUIRED');
    for (const lane of ci.emittedTestLanes) {
      assert.ok(lane.workflow === 'CI' && names.has(lane.job) && text(lane.step), 'RESULTING_MAIN_TEST_LANE_PROVENANCE_REQUIRED');
      for (const field of ['emittedOuterSuites', 'tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']) assert.ok(Number.isSafeInteger(lane[field]) && lane[field] >= 0, 'RESULTING_MAIN_TEST_COUNTS_REQUIRED');
      assert.ok(lane.tests > 0 && lane.emittedOuterSuites > 0 && lane.tests === lane.passed + lane.failed + lane.cancelled + lane.skipped + lane.todo && lane.failed === 0 && lane.cancelled === 0, 'RESULTING_MAIN_TEST_COUNTS_CHANGED');
    }
    assert.deepEqual(resultingMain.branchCleanup, { localBranchRemoved: true, remoteBranchRemoved: true }, 'RESULTING_MAIN_BRANCH_CLEANUP_REQUIRED');
    for (const id of ['resulting-tooling-main-ci', 'final-main-ci']) {
      const gate = index.gates.find(entry => entry.id === id);
      assert.deepEqual([gate?.status, gate?.applicability, gate?.sourceSha, gate?.evidence], ['passed', 'current_baseline', source, ['resultingMainObservation']], 'RESULTING_MAIN_CI_GATE_CHANGED');
    }
  }
  if (index.evidence.currentArtifactsScan) {
    const scan = receipt('currentArtifactsScan');
    metadataOnly(scan);
    assert.ok(index.evidence.candidateRefresh, 'CURRENT_ARTIFACT_SCAN_REQUIRES_FREEZE');
    assert.deepEqual([scan.schemaVersion, scan.kind, scan.releaseReady, scan.operationalAuthorization, scan.productionMutations], [1, 'release297_current_artifact_scan_observation', false, false, 0], 'CURRENT_ARTIFACT_SCAN_IS_NOT_AUTHORITY');
    assert.ok(stamp(scan.observedAtUtc) && Date.parse(scan.observedAtUtc) <= Date.parse(index.observedAtUtc), 'CURRENT_ARTIFACT_SCAN_TIME_REQUIRED');
    const pair = receipt('successorPreparationObservation').artifactPair;
    for (const [field, role, source, artifactId, gateId, status] of [['candidate', 'serving-anchor', index.sources.schoolpilot.frozenApplicationReference, 'backend-successor', 'backend-successor-scan-fresh', 'passed'], ['fallback', 'fallback', pair.fallback.source, 'fallback-successor-current-scan', 'fallback-successor-scan-fresh', 'failed']]) {
      const fact = scan[field];
      assert.deepEqual([fact.artifactRole, fact.source, fact.status], [role, source, status], 'CURRENT_SCAN_ARTIFACT_ROLE_CHANGED');
      const identity = { indexDigest: fact.localIndex, platformManifestDigest: fact.platform, configDigest: fact.config, archiveSha256: fact.archiveSha256 };
      const artifact = index.artifacts.find(entry => entry.id === artifactId);
      assert.deepEqual([artifact?.status, artifact?.applicability, artifact?.sourceSha, artifact?.identity, artifact?.evidence], [status, status === 'passed' ? 'preparation_only' : index.evidence.protectedFallbackObservation ? 'historical' : 'current_baseline', source, identity, ['currentArtifactsScan']], 'CURRENT_SCAN_ARTIFACT_IDENTITY_CHANGED');
      const gate = index.gates.find(entry => entry.id === gateId);
      assert.deepEqual([gate?.status, gate?.sourceSha, gate?.evidence], [status, source, ['currentArtifactsScan']], 'CURRENT_SCAN_GATE_CHANGED');
      assert.deepEqual(fact.exactOwnedScannerCleanup, { exitCode: 0, unforced: true, containerAbsentAfterRemoval: true }, 'CURRENT_SCAN_CLEANUP_REQUIRED');
      for (const severity of ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) assert.equal(fact.counts[severity], fact.findings.filter(finding => finding.severity === severity).length, 'CURRENT_SCAN_FINDING_COUNTS_CHANGED');
      if (field === 'candidate') assert.deepEqual([fact.counts.HIGH, fact.counts.CRITICAL], [0, 0], 'CURRENT_CANDIDATE_SCAN_MUST_PASS');
      else {
        assert.ok(fact.counts.HIGH + fact.counts.CRITICAL > 0, 'CURRENT_F_FAILURE_RECLASSIFIED');
        assert.deepEqual([fact.localIndex, fact.config, fact.platform, fact.archiveSha256], [pair.fallback.localIndex, pair.fallback.config, pair.fallback.platform, pair.fallback.archiveSha256], 'CURRENT_F_SCAN_SUBSTITUTED');
      }
    }
    assert.ok(Object.entries(scan.acceptanceDisposition).filter(([key]) => key !== 'reason').every(([, value]) => value === 'held_before_execution'), 'FAILED_F_ACCEPTANCE_MUST_STOP');
  }
  if (index.evidence.currentSuccessorBinding) {
    const current = receipt('candidateRefresh'), binding = receipt('currentSuccessorBinding'), scan = receipt('currentArtifactsScan');
    assert.deepEqual([binding.schemaVersion, binding.id, binding.status, binding.applicationSource, binding.inventory, binding.frontendInventory, binding.preparation.status, binding.preparation.evidence.successorScan.status, binding.fallbackScan.status, binding.successorSelection.status, binding.operationalAuthorization], [3, 'release-297-current-school-fallback-v3', 'pending', current.applicationReferenceA, current.backendInventory, current.frontendInventory, 'pending', 'failed', 'failed', 'pending', false], 'CURRENT_BINDING_MUST_FAIL_CLOSED');
    assert.deepEqual([binding.historicalPreparation.profile.path, binding.historicalPreparation.profile.sha256, binding.historicalPreparation.applicableToCurrentA], [index.evidence.successorBinding.path, index.evidence.successorBinding.gitBlobSha256, false], 'HISTORICAL_BINDING_MUST_REMAIN_SEPARATE');
    for (const [role, field] of [['serving-anchor', 'candidate'], ['fallback', 'fallback']]) assert.deepEqual(binding.artifacts[role], Object.fromEntries(['source', 'localIndex', 'config', 'platform', 'archiveSha256'].map(key => [key, scan[field][key]])), 'CURRENT_BINDING_ARTIFACT_PAIR_CHANGED');
    for (const key of ['screenshotRuntime', 'requestIpRateLimit', 'ordinaryRecovery', 'restrictedRestoration']) assert.deepEqual(binding.preparation.evidence[key], {status:'pending', path:null, sha256:null}, 'HISTORICAL_PAIR_EVIDENCE_CANNOT_PASS_CURRENT_PREPARATION');
  }
  if (index.evidence.currentCandidateNative) {
    const native = receipt('currentCandidateNative'), exact = receipt('currentArtifactsScan').candidate;
    assert.deepEqual([native.kind, native.status, native.artifactRole, native.source, native.localIndex, native.config, native.platform, native.archiveSha256, native.actualChecks.length, native.productionMutations, native.releaseReady, native.operationalAuthorization], ['release297_current_candidate_native_processing', 'passed', 'serving-anchor', exact.source, exact.localIndex, exact.config, exact.platform, exact.archiveSha256, 9, 0, false, false], 'CURRENT_NATIVE_SOURCE_OR_ROLE_CHANGED');
    assert.ok(native.actualChecks.every(check => check.passed === true) && Object.values(native.checks).every(value => value === true), 'CURRENT_NATIVE_CHECKS_REQUIRED');
    assert.deepEqual([native.ownedCleanup.exitCode, native.ownedCleanup.unforced, native.ownedCleanup.containerAbsentByFreshDockerRead, native.ownedCleanup.privateTempDirectoriesRemoved, native.limits.FSelected, native.limits.productionCatalogProven], [0, true, true, true, false, false], 'CURRENT_NATIVE_CANNOT_ESTABLISH_PAIR_OR_PRODUCTION');
  }
  if (index.evidence.currentFrontend) {
    const frontend = receipt('currentFrontend'), frozen = receipt('candidateRefresh'), artifact = index.artifacts.find(entry => entry.id === 'frontend-successor');
    assert.deepEqual([frontend.source, frontend.frontendGitInventorySha256, frontend.allArchiveEntriesMatchBuiltFiles, frontend.published, frontend.adoptionVerified, frontend.releaseReady, frontend.operationalAuthorization], [frozen.applicationReferenceA, frozen.frontendInventory.sha256, true, false, false, false, false], 'CURRENT_FRONTEND_IS_NOT_PUBLICATION_OR_ADOPTION');
    assert.ok(frontend.fileCount > 0 && frontend.archiveBytes > 0, 'CURRENT_FRONTEND_ARCHIVE_REQUIRED');
    assert.deepEqual([artifact.status, artifact.applicability, artifact.sourceSha, artifact.identity, artifact.evidence], ['passed', 'preparation_only', frontend.source, { archiveSha256: frontend.archiveSha256, fileInventorySha256: frontend.fileInventorySha256 }, ['currentFrontend']], 'CURRENT_FRONTEND_ARTIFACT_CHANGED');
  }
  if (index.evidence.currentExtensionApplicability) {
    const current = receipt('currentExtensionApplicability'), extension = index.artifacts.find(entry => entry.id === 'extension');
    assert.deepEqual([current.schemaVersion, current.kind, current.source, current.extensionTree, current.version, current.zipSha256, current.zipBytes, current.files], [1, 'retained_extension_current_applicability_observation', extension.sourceSha, extension.identity.gitTree, '2.9.7', extension.identity.zipSha256, extension.identity.bytes, 24], 'CURRENT_EXTENSION_IDENTITY_CHANGED');
    assert.deepEqual([current.sourceAndZipIdentityEqualToOctober7Evidence, current.allPackagedGitBlobsMatchAfterDeclaredCrLfNormalization, current.rawGitBlobEquality, current.crlfOnlyDifferences.length, current.otherDifferences], [true, true, false, 20, []], 'CURRENT_EXTENSION_NORMALIZATION_SCOPE_CHANGED');
    assert.deepEqual([current.freshCanonicalAttempt.status, current.priorCanonicalPass.path, current.managedAdoption, current.newUploadPerformed, current.extensionChanged, current.releaseReady, current.operationalAuthorization], ['failed', index.evidence.extensionFresh.path, 'unknown', false, false, false, false], 'CURRENT_EXTENSION_ATTEMPT_MUST_REMAIN_FAILED');
    assert.match(current.freshCanonicalAttempt.logSha256 ?? '', hash, 'CURRENT_EXTENSION_FAILURE_LOG_REQUIRED');
    for (const [id, status] of [['extension-current-identity-applicability', 'passed'], ['extension-current-canonical-attempt', 'failed']]) {
      const gate = index.gates.find(entry => entry.id === id);
      assert.deepEqual([gate?.status, gate?.sourceSha, gate?.evidence], [status, current.source, ['currentExtensionApplicability']], 'CURRENT_EXTENSION_GATE_CHANGED');
    }
  }
  if (index.evidence.protectedFallbackObservation) {
    const observed = receipt('protectedFallbackObservation'), binding = receipt('protectedFallbackBinding'), sourceReview = receipt('protectedFallbackSourceReview');
    metadataOnly(observed); metadataOnly(sourceReview);
    assert.deepEqual([observed.schemaVersion, observed.kind, observed.releaseBindingId, observed.releaseReady, observed.operationalAuthorization, observed.productionMutations, observed.operationalPlansCreated, observed.registryArtifactPublished], [1, 'release297_cp_protected_fallback_observation', CP_PROTECTED_BINDING_ID, false, false, 0, false, false], 'PROTECTED_OBSERVATION_IS_NOT_AUTHORITY');
    assert.ok(stamp(observed.observedAtUtc) && Date.parse(observed.observedAtUtc) <= Date.parse(index.observedAtUtc), 'PROTECTED_OBSERVATION_TIME_REQUIRED');
    assert.deepEqual([binding.schemaVersion, binding.id, binding.status, binding.preparation.status, binding.successorSelection.status, binding.operationalAuthorization], [4, CP_PROTECTED_BINDING_ID, 'pending', 'pending', 'pending', false], 'PROTECTED_BINDING_MUST_FAIL_CLOSED');
    assert.deepEqual([binding.applicationSource, binding.artifacts, binding.artifacts.fallback, binding.sourceDelta], [index.sources.schoolpilot.frozenApplicationReference, observed.artifactPair, CP_PROTECTED_ARTIFACT, CP_PROTECTED_SOURCE_REVIEW], 'PROTECTED_ARTIFACT_PAIR_CHANGED');
    assert.deepEqual([observed.preparationStatus, observed.selectionStatus, observed.historicalC578AndF1ScansRemainFailed], ['pending', 'pending', true], 'PROTECTED_PREPARATION_CANNOT_SELECT');
    assert.deepEqual([observed.sourceDelta.baseline, observed.sourceDelta.source, observed.sourceDelta.changedPathCount, observed.sourceDelta.patchSha256, observed.sourceDelta.backendInventory, observed.sourceDelta.unchangedLockfileDockerfileBuildMigrationsCapabilitiesMatcherAndFrontend], [CP_PROTECTED_SOURCE_REVIEW.baseline, CP_PROTECTED_SOURCE, 8, CP_PROTECTED_SOURCE_REVIEW.patchSha256, binding.fallbackInventory, true], 'PROTECTED_SOURCE_DELTA_CHANGED');
    assert.deepEqual([sourceReview.sources.protectedFallback, sourceReview.sourceOnly, sourceReview.syntheticTests.artifactExecution, sourceReview.comparison.changedPathCount, sourceReview.comparison.rawGitDiffSha256], [CP_PROTECTED_SOURCE, true, false, 8, CP_PROTECTED_SOURCE_REVIEW.patchSha256], 'PROTECTED_SOURCE_REVIEW_CHANGED');
    assert.deepEqual([observed.sourceChecks.sourceOnly, observed.sourceChecks.producerBoundary, observed.sourceChecks.independentBoundary, observed.sourceChecks.fullUnit], [true, { tests:175, passed:175, failed:0, skipped:0 }, { tests:366, passed:366, failed:0, skipped:0 }, { tests:1824, passed:1820, failed:0, skipped:4 }], 'PROTECTED_SOURCE_TEST_SCOPE_CHANGED');
    assert.deepEqual([observed.credentialBoundary.retainedOnRollback, observed.credentialBoundary.actualCompiledImage, observed.credentialBoundary.tests, observed.credentialBoundary.passed, observed.credentialBoundary.failed, observed.credentialBoundary.skipped, observed.credentialBoundary.externalProviderRequests, observed.credentialBoundary.syntheticFixturesOnly], [true, true, 53, 53, 0, 0, 0, true], 'PROTECTED_COMPILED_TEST_SCOPE_CHANGED');
    assert.deepEqual(observed.scan.counts, { UNKNOWN:0, LOW:0, MEDIUM:1, HIGH:0, CRITICAL:0 }, 'PROTECTED_RUNTIME_SCAN_COUNTS_CHANGED');
    assert.deepEqual(observed.scan.findings, [{ id:'CVE-2026-97058', package:'sprintf-js', installedVersion:'1.0.3', severity:'MEDIUM' }], 'PROTECTED_RUNTIME_SCAN_FINDINGS_CHANGED');
    assert.ok(observed.native.actualImageExecution && observed.native.unforcedCleanupPassed && observed.native.checks.length === 9 && observed.native.checks.every(check => check.passed === true), 'PROTECTED_NATIVE_CHECKS_REQUIRED');
    const audit = observed.buildDependencyAudit;
    assert.deepEqual([audit.status, audit.counts, audit.runtimeCounts, audit.advisory, audit.cve, audit.issue, audit.rawAuditSha256, audit.waiver], ['failed', {high:6,critical:0,moderate:7}, {high:0,critical:0,moderate:3}, 'GHSA-vfj7-8cjw-p6xm', 'CVE-2026-93687', 'https://github.com/bzinkan/SchoolPilot/issues/625', '14a28f84ba2fc64fb5d1804b3ef24aa1aae42712714364cb137fc4ec019dc6ba', false], 'PROTECTED_BUILD_AUDIT_CANNOT_BE_WAIVED');
    assert.deepEqual([binding.buildDependencyAudit.status, binding.buildDependencyAudit.counts, binding.buildDependencyAudit.source, binding.buildDependencyAudit.audit.sha256], ['failed', audit.counts, CP_PROTECTED_SOURCE, audit.rawAuditSha256], 'PROTECTED_BINDING_AUDIT_CHANGED');
    assert.deepEqual([observed.ordinaryRecovery.status, observed.ordinaryRecovery.sequence, observed.ordinaryRecovery.ordinaryMigrations, observed.ordinaryRecovery.retainedCompletedMigrations, observed.ordinaryRecovery.admissionCounts, observed.ordinaryRecovery.actualApiWorkerProcesses, observed.ordinaryRecovery.gracefulDrains, observed.ordinaryRecovery.namedSqlConnectionsAfterDrains, observed.ordinaryRecovery.providerAccessDisabled], ['passed', [binding.applicationSource,CP_PROTECTED_SOURCE,binding.applicationSource], [43,53], 53, [121,125,126,127,128,129], 8, 8, 0, true], 'PROTECTED_ORDINARY_RECOVERY_CHANGED');
    assert.deepEqual([observed.restrictedRestoration.status, observed.restrictedRestoration.rounds, observed.restrictedRestoration.restrictedDdlAndRuntimeRoles, observed.restrictedRestoration.stableSerializationSecondRoundtrip, observed.restrictedRestoration.zeroNamedSqlConnections, observed.restrictedRestoration.unforcedCleanup, observed.restrictedRestoration.fullHistoricalDatabaseCommandsRepeated], ['passed',6,true,true,true,true,false], 'PROTECTED_RESTORATION_SCOPE_CHANGED');
    for (const key of ['successorScan', 'screenshotRuntime', 'requestIpRateLimit', 'credentialBoundary', 'ordinaryRecovery', 'restrictedRestoration']) {
      const evidenceId = 'protectedFallback' + key[0].toUpperCase() + key.slice(1), leaf = receipt(evidenceId), record = observed.leafEvidence[key];
      assert.deepEqual([leaf.schemaVersion, leaf.kind, leaf.releaseBindingId, leaf.evidenceKind, leaf.artifactPair, leaf.passed, leaf.releaseReady, leaf.operationalAuthorization], [1, 'release_successor_preparation_evidence', CP_PROTECTED_BINDING_ID, key, observed.artifactPair, true, false, false], 'PROTECTED_LEAF_IDENTITY_CHANGED');
      assert.ok(stamp(leaf.observedAtUtc) && Date.parse(leaf.observedAtUtc) >= Date.parse('2026-10-08T23:33:09Z') && Date.parse(leaf.observedAtUtc) <= Date.parse(index.observedAtUtc), 'PROTECTED_LEAF_TIME_REQUIRED');
      assert.deepEqual([record.path, record.sha256, binding.preparation.evidence[key]], [index.evidence[evidenceId].path, index.evidence[evidenceId].gitBlobSha256, {status:'passed',path:record.path,sha256:record.sha256}], 'PROTECTED_LEAF_HASH_CHANGED');
      for (const field of ['nativeResult', 'independentReview']) assert.match(leaf.retainedEvidence[field]?.sha256 ?? '', hash, 'PROTECTED_RETAINED_HASH_REQUIRED');
      const gate = index.gates.find(entry => entry.id === 'cp-protected-' + key);
      assert.deepEqual([gate?.status, gate?.applicability, gate?.sourceSha, gate?.evidence], ['passed', 'preparation_only', CP_PROTECTED_SOURCE, [evidenceId,'protectedFallbackObservation']], 'PROTECTED_LEAF_GATE_CHANGED');
    }
    const artifact = index.artifacts.find(entry => entry.id === 'fallback-cp-protected-artifact');
    assert.deepEqual([artifact?.status, artifact?.applicability, artifact?.sourceSha, artifact?.identity], ['passed', 'preparation_only', CP_PROTECTED_SOURCE, { indexDigest:CP_PROTECTED_ARTIFACT.localIndex, platformManifestDigest:CP_PROTECTED_ARTIFACT.platform, configDigest:CP_PROTECTED_ARTIFACT.config, archiveSha256:CP_PROTECTED_ARTIFACT.archiveSha256 }], 'PROTECTED_ARTIFACT_GATE_CHANGED');
    for (const [id, status] of [['cp-protected-build-dependency-audit','failed'], ['cp-protected-preparation','pending'], ['cp-protected-selection','pending']]) {
      const gate = index.gates.find(entry => entry.id === id);
      assert.deepEqual([gate?.status, gate?.sourceSha], [status, CP_PROTECTED_SOURCE], 'PROTECTED_SECURITY_AND_SELECTION_GATES_REQUIRED');
    }
  }
  return index;
}
const cell = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const short = value => value === null ? 'pending' : `\`${value.slice(0, 8)}\``;
function renderBuildSecurityStatus(index) {
  const deployed=Boolean(index.stages.find(row=>row.id==='deployment')?.status==='passed'&&index.evidence.buildSecurityDeploymentCompletion&&index.evidence.buildSecurityDeploymentReview);
  const acceptanceComplete=index.stages.find(row=>row.id==='testing')?.status==='passed'&&['preparation','selection','currentSchoolAcceptance','classroomAcceptance','normalLoadAcceptance','headroomAcceptance','original-ordinaryRecovery','original-restrictedRestoration','original-screenshotRuntime'].every(id=>index.gates.find(row=>row.id==='build-security-'+id)?.status==='passed');
  const lead=deployed?`**Exact matched A3 backend/worker and frontend ${short(index.sources.schoolpilot.frozenApplicationReference)} are deployed.** Original release gates, exact artifact publication and inactive129F3 registration are verified in the dated completion evidence. Already-open page adoption and sample-bearing live acceptance remain pending; managed-device validation stays \`waived_not_passed\`. ClassPilot 2.9.7 is unchanged and needs no new Store upload.`:`**DeSales: 133 clients. A3 is ${short(index.sources.schoolpilot.frozenApplicationReference)}; F3 retains CP-AI protection and corrects the failed F2 build dependency chain.** Preparation, exact selection and original classroom/capacity acceptance are separate gates. ClassPilot 2.9.7 is unchanged and needs no new Store upload.`;
  const mergeHistory=deployed?'PR #628 invalidated the earlier A2 freeze; the deployed A3 combination has fresh source-bound preparation and original acceptance evidence. Exact A2/25964241 artifacts remain historical. PR #627 remains included. C578 and F1 scans and F2’s six-High full audit remain failed historical records. See the [F3 review packet](RELEASE_297_BUILD_SECURITY_FALLBACK.md).':acceptanceComplete?'PR #628 invalidated the earlier A2 freeze. Fresh A3 preparation and all seven original release gates are complete for the exact selected A3/F3/C combination. Exact publication and backend/frontend deployment remain pending. Exact A2/25964241 artifacts remain historical. PR #627 remains included. C578 and F1 scans and F2’s six-High full audit remain failed historical records. See the [F3 review packet](RELEASE_297_BUILD_SECURITY_FALLBACK.md).':'PR #628 changed five backend and frontend inputs after the A2 freeze. Exact A2/25964241 artifacts and preparation are historical; fresh A3 evidence is required. PR #627 remains included. C578 and F1 scans and F2’s six-High full audit remain failed historical records. See the [F3 review packet](RELEASE_297_BUILD_SECURITY_FALLBACK.md).';
  const recoveryNarrative='Ordinary recovery retains **43→53** migrations and **121→125→126→127→128→129** admission. The 54-entry rehearsal stays historical. '+(deployed?'The completed deployment preserved admission129 and the reviewed classroom capability modes and environment; both new Usage modes remain off. The exact inactive F3 pair and compatible C frontend are recorded for recovery.':'Actual current production already admits 129 with reviewed classroom capability modes on; v5 prepares inactive 129 definitions while preserving their exact environment.')+' Current A2/A3 frontend page-view and cursor behavior is incompatible with F3. Any F3 backend recovery requires the separately reviewed exact compatible C frontend; publish that frontend and reload already-open A2/A3 pages with history cursors reset. A later manual F3 rollback has the same matched-frontend requirement. Public bytes and task health do not prove managed adoption or live classroom acceptance.';
  const lines=[BEGIN,'## Current release status','',`Observed **${index.observedAtUtc}**. The [current-release index](releases/release297/current-release.json) contains exact identities, evidence and historical outcomes. Regenerate with \`node scripts/release297-current-state.mjs\`; verify with \`--check\`.`, '', lead, '', 'The user authorized the necessary correction merge, exact publication, compatible inactive registration and backend/frontend deployment by requesting “fix this and deploy.” Execution remains gated by exact evidence, fresh state and reviewed operation windows. Activation, Store submission and GitHub settings remain separately unauthorized; this index is not a controller authorization receipt.', '', '| Source | Current main observed | Frozen application |','|---|---|---|'];
  for(const[name,source]of Object.entries(index.sources))lines.push(`| ${name} | ${short(source.remoteMainObserved)} | ${short(source.frozenApplicationReference)} |`);
  lines.push('', mergeHistory, '', '| Stage | Status | Next action |','|---|---|---|');
  for(const row of index.stages)lines.push(`| ${cell(row.label)} | ${row.status} | ${cell(row.nextAction)} |`);
  lines.push('', '| Usage setting | Required | Observed |','|---|---|---|');for(const[name,row]of Object.entries(index.usageModes))lines.push(`| \`${name}\` | ${row.requiredValue} | ${row.observedValue??'unknown'} |`);
  lines.push('', 'The daily setting is independently omitted and defaults to shadow; both new modes off does not establish zero rollup workload.', '', '| Current gate | Status | Evidence and next action |','|---|---|---|');
  for(const row of index.gates.filter(row=>row.id.startsWith('build-security-')||['managed','store-live-version','store-unchanged-upload','store','live-acceptance','production-fresh','repository-protections','cp-ai-001-deployment','cp-ai-001-live'].includes(row.id))){const refs=row.evidence.map(id=>`[${id}](${index.evidence[id].path.replace(/^docs\//,'')})`).join(', ');lines.push(`| ${cell(row.label)} | ${row.status} | ${refs}${refs?'. ':''}${cell(row.nextAction)} |`);}
  lines.push('', '### Candidate artifacts', '', '| Artifact | Status | Source | Exact identity and applicability |','|---|---|---|');for(const row of index.artifacts.filter(row=>['backend-current-a3','frontend-current-a3','fallback-build-security-f3','frontend-compatible-f3-c','extension'].includes(row.id)))lines.push(`| ${cell(row.label)} | ${row.status} | ${short(row.sourceSha)} | ${cell(row.identity?JSON.stringify(row.identity):'Identity pending')} ${cell(row.rationale)} |`);
  lines.push('', '### Inclusion and evidence invalidation', '', '| Merge | Change | Affected inputs | Required reruns |','|---|---|---|');for(const row of index.inclusionMatrix)lines.push(`| [${row.repository} #${row.number}](https://github.com/bzinkan/${row.repository}/pull/${row.number}) ${short(row.mergeSha)} | ${cell(row.title)} | ${cell(row.affectedArtifacts.join(', '))} | ${cell(row.requiredReruns)} |`);
  lines.push('', recoveryNarrative, '', END);return lines.join('\n');
}
export function renderStatus(index, root = ROOT) {
  if(index.evidence.buildSecurityCurrentObservation)return renderBuildSecurityStatus(index);
  const refreshed = index.evidence.candidateRefresh;
  const lines = [BEGIN, '## Current release status', '', `Observed **${index.observedAtUtc}**. The [machine-readable index](releases/release297/current-release.json) is the current preparation record; dated evidence below remains historical. Regenerate with \`node scripts/release297-current-state.mjs\`; verify with \`--check\`.`, '', refreshed ? '**DeSales: 133 clients; both new Usage modes must be off. The exact application/extension sources are frozen for validation; artifact and runtime acceptance remain separately gated. This record is not a controller authorization receipt.**' : '**DeSales: 133 clients; both new Usage modes must be off. Candidate freeze and refreshed acceptance are pending. This record grants no operational authorization.**', '', '| Source | Current main observed | Historical tested application | Frozen successor |', '|---|---|---|---|'];
  if (index.gates.find(entry => entry.id === 'fallback-scan-current')?.status === 'failed') lines.splice(7, 0, '**Release blocker: the exact retained C578 fallback freshly fails its security scan. Its historical passing scan does not clear the failure; substituting another fallback is not authorized.**', '');
  if (index.evidence.successorPreparationObservation) lines.splice(7, 0, '**The dependency-only C578 successor passed historical bounded security/native recovery preparation for its exact earlier pair. Current security/applicability checks, exact-artifact selection and original release acceptance remain separate.** See the [successor review packet](RELEASE_297_FALLBACK_SUCCESSOR_REVIEW.md).', '');
  if (index.gates.find(entry => entry.id === 'fallback-successor-scan-fresh')?.status === 'failed') lines.splice(7, 0, '**The latest scan of unchanged F failed the zero High/Critical criterion. That A/F1 pair cannot pass release acceptance; its earlier passing preparation remains historical and completed local A/F2 preparation is recorded separately. Preserve the failed F1 artifact and scan.**', '');
  if (index.evidence.resultingMainObservation) lines.splice(7, 0, `**Preparation PR #624 is merged at ${short(index.sources.schoolpilot.remoteMainObserved)}. Exact resulting-main CI passed and real Git inventories prove application inputs remain equal to frozen A ${short(index.sources.schoolpilot.frozenApplicationReference)}.** This dated observation does not transfer evidence to changed application inputs.`, '');
  if (index.evidence.protectedFallbackObservation) lines.splice(7, 0, '**Protected fallback F2 retains CP-AI protection and passed the exact runtime scan, nine native checks, 53 compiled-provider fixtures, actual A→F2→A recovery and six restricted restoration rounds. Overall preparation remains pending: its full development/build audit failed with six High findings in [issue #625](https://github.com/bzinkan/SchoolPilot/issues/625). Selection, original acceptance and deployment remain held.** See the [protected fallback packet](RELEASE_297_CP_PROTECTED_FALLBACK.md); historical C578/F1 failures remain preserved.', '');
  if (index.evidence.cpAiBoundaryPreparation) {
    const cp = JSON.parse(readFileSync(path.join(root, index.evidence.cpAiBoundaryPreparation.path), 'utf8'));
    const table = lines.findIndex(line => line === '| Source | Current main observed | Historical tested application | Frozen successor |');
    if (refreshed) lines.splice(table, 0, `**CP-AI-001 is merged in #622; the current frozen source ${short(index.sources.schoolpilot.frozenApplicationReference)} also includes #621 and #623. CP-AI-001 synthetic evidence remains bound to ${short(cp.testedSource)}.** The [browser-boundary preparation](CLASSPILOT_AI_REQUEST_BOUNDARY.md) changes application/image inputs; source-specific image/scan and applicable recovery/classroom acceptance remain separate. Unchanged F restores the prior provider boundary on rollback and requires exact-artifact selection/applicability review.`, '');
    else {
      lines[table] = '| Source | Historical reconciled main snapshot | Historical tested application | Frozen successor |';
      lines.splice(table, 0, `**Newly observed SchoolPilot main baseline: ${short(cp.observedMainBaseline)}. CP-AI-001 tested source: ${short(cp.testedSource)}.** The source rows below retain dated historical reconciliation. The [browser-boundary preparation](CLASSPILOT_AI_REQUEST_BOUNDARY.md) changes application/image inputs; new candidate equivalence, image/scan and applicable recovery/classroom acceptance remain pending. Unchanged F restores the prior provider boundary on rollback and requires selection/applicability review.`, '');
    }
  }
  for (const [repository, source] of Object.entries(index.sources)) lines.push(`| ${repository} | ${short(source.remoteMainObserved)} | ${short(source.testedHistorical)} | ${short(source.frozenApplicationReference)} |`);
  if (index.evidence.mergeRequest) {
    const merged = index.gates.find(entry => entry.id === 'preparation-merges')?.status === 'passed';
    lines.push('', `${merged ? 'All four authorized source preparation PRs **#616, #617, #619 and #620** are merged, with exact resulting-main push checks recorded.' : 'The operator requested source merges **#616, #617, #619 and #620** after their preparation checks.'} ${refreshed ? 'The prior direct user request authorizes production deployment after required gates pass; deployment has not executed. Publication, unused registration, activation, Store submission and settings application remain separate, unexecuted decisions. This index cannot be submitted as operational authority.' : 'Every release-operation authorization flag remains false.'} The observed main is a dated snapshot; refresh [live main checks](https://github.com/bzinkan/SchoolPilot/actions?query=branch%3Amain) before later release operations.`);
  }
  if (index.evidence.operatorStoreVersion) lines.push('', '**Store version 2.9.7 is operator-reported live.** Uploaded ZIP identity and pending submissions remain unknown; managed adoption remains pending and managed validation `waived_not_passed`. The unchanged candidate does not require another upload.');
  lines.push('', '| Stage | Status | Applicability | Next action |', '|---|---|---|---|');
  for (const entry of index.stages) lines.push(`| ${cell(entry.label)} | ${entry.status} | ${cell(entry.applicability)} | ${cell(entry.nextAction)} |`);
  lines.push('', '| Usage setting | Required value | Fresh observed value | Next action |', '|---|---|---|---|');
  for (const [name, entry] of Object.entries(index.usageModes)) lines.push(`| \`${name}\` | ${entry.requiredValue} | ${entry.observedValue ?? 'unknown'} | ${cell(entry.nextAction)} |`);
  lines.push('', 'The existing daily/shadow rollup can still run with both new modes off. Preserve its actual observed setting separately.', '', '| Gate | Status | Applicability/source | Evidence and next action |', '|---|---|---|---|');
  for (const entry of index.gates) {
    const refs = entry.evidence.map(id => `[${id}](${index.evidence[id].path.replace(/^docs\//, '')})`).join(', ');
    lines.push(`| ${cell(entry.label)} | ${entry.status} | ${entry.applicability}; ${short(entry.sourceSha)} | ${refs}${refs ? '. ' : ''}${cell(entry.nextAction)} |`);
  }
  lines.push('', '### Inclusion and evidence invalidation', '', 'Every listed merge is included in the observed main. CI and historical receipts do not transfer measured acceptance to changed application inputs.', '', '| Merge | Included change | Affected artifacts | Reusable evidence | Required reruns |', '|---|---|---|---|---|');
  for (const entry of index.inclusionMatrix) lines.push(`| [${entry.repository} #${entry.number}](https://github.com/bzinkan/${entry.repository}/pull/${entry.number}) ${short(entry.mergeSha)} | ${cell(entry.title)} | ${cell(entry.affectedArtifacts.join(', '))} | ${cell(entry.reusableEvidence)} | ${cell(entry.requiredReruns)} |`);
  lines.push('', '### Artifact selection', '', '| Artifact | Status | Source | Identity and limitation |', '|---|---|---|---|');
  for (const entry of index.artifacts) lines.push(`| ${cell(entry.label)} | ${entry.status} | ${short(entry.sourceSha)} | ${cell(entry.rationale)} ${cell(entry.nextAction)} |`);
  lines.push('', 'Ordinary migration/recovery uses **43 → 53** completed entries and admission **121 → 125 → 126 → 127 → 128 → 129**. The earlier 54-entry rehearsal remains historical. Preserve C578, equal capabilities and private-chat compatibility floors; never shrink admission during recovery.', '', END);
  return lines.join('\n');
}
export function updateChecklist(checklist, generated) {
  const begin = checklist.indexOf(BEGIN), end = checklist.indexOf(END);
  assert.ok(begin >= 0 && end > begin && checklist.lastIndexOf(BEGIN) === begin && checklist.lastIndexOf(END) === end, 'GENERATED_MARKERS_INVALID');
  return `${checklist.slice(0, begin)}${generated}${checklist.slice(end + END.length)}`;
}
export function main(args = process.argv.slice(2), root = ROOT) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--check'), 'USAGE: release297-current-state.mjs [--check]');
  const index = validateIndex(JSON.parse(readFileSync(path.join(root, INDEX), 'utf8')), root);
  const filename = path.join(root, CHECKLIST), before = readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
  const after = updateChecklist(before, renderStatus(index, root));
  if (args[0] === '--check') assert.equal(before, after, 'GENERATED_CURRENT_STATUS_STALE');
  else if (before !== after) writeFileSync(filename, after);
  console.log(args[0] === '--check' ? 'Release297 current index/evidence/status verified (offline).' : 'Release297 current status generated (offline).');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
