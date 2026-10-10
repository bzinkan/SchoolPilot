// Synthetic controls and offline public-record consistency checks never execute deployment operations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { COMPLETION_OPERATIONS, buildDeploymentReconciliationDraft, appendLatestProductionObservation, publicJsonBytes } from '../scripts/lib/release297-deployment-reconciliation.mjs';
import { validateBuildSecurityLatestRemoteMain, validateBuildSecurityLatestProduction, validateIndex, renderStatus } from '../scripts/release297-current-state.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(readFileSync(new URL('../' + file, import.meta.url)));
const main = 'f3af52c741e31ea74d5654888129795fb9d45438';
const arn = (family, revision) => 'arn:aws:ecs:us-east-1:135775632425:task-definition/' + family + ':' + revision;
function fixture() {
  // Reconciliation consumes the immutable predecessor, including after current-release advances.
  const previousIndex = readJson('docs/releases/release297/history/current-release-e22c790a-predeployment-20261010.json');
  const bindingBytes = readFileSync(new URL('../docs/release-bindings/release-297-current-school-cp-protected-build-fallback-v5.json', import.meta.url));
  const binding = JSON.parse(bindingBytes);
  const observation = readJson(previousIndex.evidence.buildSecurityCurrentObservation.path);
  Object.assign(observation, { schemaVersion: 2, kind: 'release297_build_security_operational_observation', mainSource: main, observedAtUtc: '2026-10-10T04:00:00.000Z', publicationExecuted: true, inactiveRegistrationExecuted: true, productionDeploymentExecuted: true, currentMainCi: { status: 'passed', source: main }, mainEquivalence: { status: 'passed', applicationReference: binding.applicationSource, mainSource: main, backendInventory: binding.inventory, frontendInventory: binding.frontendInventory } });
  const operationReceiptBytes = Object.fromEntries(COMPLETION_OPERATIONS.map(name => [name, publicJsonBytes({ kind: 'synthetic_test_only', operation: name })]));
  const operations = Object.fromEntries(COMPLETION_OPERATIONS.map(name => [name, { status: 'passed', operationalOutcomeUncertain: false, receipt: { storage: 'private', format: 'json', path: 'synthetic-test/' + name + '.json', sha256: sha(operationReceiptBytes[name]) } }]));
  const registry = Object.fromEntries(Object.entries(binding.artifacts).map(([role, value]) => [role, { ...value, digest: value.platform }]));
  const taskDefinitions = { api: arn('schoolpilot-production-api-emergency', 180), 'scheduler-worker': arn('schoolpilot-production-scheduler-worker', 196) };
  const desiredCounts = { api: 1, 'scheduler-worker': 1 };
  const rawServices = { failures: [], services: Object.entries(desiredCounts).map(([role, count]) => ({ serviceName: 'schoolpilot-production-' + role, clusterArn: 'arn:aws:ecs:us-east-1:135775632425:cluster/schoolpilot-production-cluster', status: 'ACTIVE', taskDefinition: taskDefinitions[role], desiredCount: count, runningCount: count, pendingCount: 0, deployments: [{ status: 'PRIMARY', taskDefinition: taskDefinitions[role], desiredCount: count, runningCount: count, pendingCount: 0, failedTasks: 0, rolloutState: 'COMPLETED' }] })) };
  const baselineServicesBytes = publicJsonBytes(rawServices);
  const capacityBaseline = { observedAtUtc: '2026-10-10T03:05:00.000Z', servicesReceipt: { storage: 'private', format: 'json', path: 'synthetic-test/baseline.json', sha256: sha(baselineServicesBytes) }, desiredCounts, taskDefinitions };
  const service = (family, revision) => ({ taskDefinition: arn(family, revision), desiredCount: 1, runningCount: 1, pendingCount: 0, rolloutState: 'COMPLETED', allTasksHealthy: true, runtimeSource: main, imageDigest: registry['serving-anchor'].digest });
  const completion = { schemaVersion: 2, kind: 'release297_matched_deployment_completion', applicationSource: binding.applicationSource, mainSource: main, releaseBindingId: binding.id, releaseBindingSha256: previousIndex.evidence.buildSecurityBinding.gitBlobSha256, artifactPair: structuredClone(binding.artifacts), operationalOutcomeUncertain: false, activationExecuted: false, sampleBearingLiveAcceptanceComplete: false, managedDeviceValidation: 'waived_not_passed', releaseReady: false, operationalAuthorization: false, completedAtUtc: '2026-10-10T03:45:00.000Z', capacityBaseline, operations,
    frontend: { source: binding.applicationSource, archiveSha256: observation.frontend.archiveSha256, fileInventorySha256: observation.frontend.fileInventorySha256, fileCount: 171, publicStaticBytesVerified: true, alreadyOpenPageAdoption: 'pending' },
    fallbackFrontend: { source: 'cce3f7b4eae30df13378337c01dc4ff2d5db3997', archiveSha256: '8d6379613dbb1c88783ee0f141ed41c34164fac5142172daee7da7f8d27cd72a', fileInventorySha256: '3484fa4f9848dc9e48e4e3bfeb384e959f17deccd10125e8b362fb094f29451e', fileCount: 171, preparedAndReviewed: true },
    registeredFallback: { source: binding.artifacts.fallback.source, admissionCount: 129, inactive: true, registrationOutcomeUncertain: false, apiTaskDefinition: arn('schoolpilot-production-api-emergency', 980), workerTaskDefinition: arn('schoolpilot-production-scheduler-worker', 981) },
    postdeployment: { admissionCount: 129, completedMigrations: 53, capabilityModesPreserved: true, desiredCountsPreserved: true, migrationConnectionClosed: true, usageModes: { CLASSPILOT_USAGE_ROLLUP_MODE: 'off', CLASSPILOT_DIGITAL_USAGE_MODE: 'off', CLASSPILOT_DAILY_USAGE_ROLLUP_MODE: 'omitted' }, registry, services: { api: service('schoolpilot-production-api-emergency', 982), 'scheduler-worker': service('schoolpilot-production-scheduler-worker', 983) } },
    sequence: ['migration', 'api-worker-convergence', 'matched-frontend'].map((stage, i) => ({ stage, startedAtUtc: `2026-10-10T03:${10 + i * 10}:00.000Z`, completedAtUtc: `2026-10-10T03:${15 + i * 10}:00.000Z` })) };
  const review = { schemaVersion: 2, kind: 'independent_release297_matched_deployment_completion_review', passed: true, independentFromProducer: true, humanApprovalAsserted: false, applicationSource: binding.applicationSource, mainSource: main, releaseBindingId: binding.id, completionSha256: sha(publicJsonBytes(completion)), actualPrivateReceiptsReplayed: true, releaseReady: false, operationalAuthorization: false, operationReceiptSha256s: Object.fromEntries(COMPLETION_OPERATIONS.map(name => [name, operations[name].receipt.sha256])), reviewedAtUtc: '2026-10-10T03:50:00.000Z', baselineServicesSha256: sha(baselineServicesBytes), actualCapacityBaselineServicesReplayed: true, capacityBaselineObservedAtUtc: capacityBaseline.observedAtUtc, capacityBaselineDesiredCounts: desiredCounts, capacityBaselineTaskDefinitions: taskDefinitions };
  return { previousIndex, bindingBytes, observation, completion, review, operationReceiptBytes, baselineServicesBytes, publicPaths: { completion: 'docs/releases/release297/synthetic-completion.json', review: 'docs/releases/release297/synthetic-review.json', observation: 'docs/releases/release297/synthetic-observation.json', history: 'docs/releases/release297/history/synthetic-predeployment-index.json' } };
}
test('preparation builds schema2 API1 draft without writes, preserving historical evidence, profile and actual runtime identity', () => {
  const f = fixture(), before = publicJsonBytes(f.previousIndex), result = buildDeploymentReconciliationDraft(f);
  assert.equal(result.filesWritten, 0); assert.equal(result.requiresFullIndexValidation, true); assert.equal(result.operationalAuthorization, false);
  assert.deepEqual(publicJsonBytes(f.previousIndex), before);
  assert.deepEqual(result.records[f.publicPaths.history], before);
  assert.deepEqual(result.index.evidence.buildSecurityPreviousIndex, f.previousIndex.evidence.buildSecurityPreviousIndex);
  for (const [id, value] of Object.entries(f.previousIndex.evidence)) if (id !== 'buildSecurityCurrentObservation') assert.deepEqual(result.index.evidence[id], value);
  for (const prior of f.previousIndex.gates) if (prior.id !== 'build-security-main-ci') assert.deepEqual(result.index.gates.find(row => row.id === prior.id), prior);
  for (const row of f.previousIndex.artifacts) assert.deepEqual(result.index.artifacts.find(next => next.id === row.id).identity, row.identity);
  assert.equal(result.index.sources.schoolpilot.remoteMainObserved, main);
  assert.equal(JSON.parse(result.records[f.publicPaths.completion]).postdeployment.services.api.runtimeSource, main);
  assert.deepEqual(result.index.sources.classpilot, f.previousIndex.sources.classpilot);
  for (const id of ['activation', 'live']) assert.deepEqual(result.index.stages.find(row => row.id === id), f.previousIndex.stages.find(row => row.id === id));
});
const invalid = [
  ['unresolved completion', f => { f.completion = null; }, /RECONCILIATION_FACTS_REQUIRED/],
  ['unresolved independent review', f => { f.review = null; }, /RECONCILIATION_FACTS_REQUIRED/],
  ['altered accepted profile', f => { f.bindingBytes = Buffer.from('{}'); }, /RECONCILIATION_ACCEPTED_PROFILE_CHANGED/],
  ['legacy fixed-capacity schema', f => { f.completion.schemaVersion = 1; }, /RECONCILIATION_SCHEMA2_REQUIRED/],
  ['pending main CI', f => { f.observation.currentMainCi.status = 'pending'; }, /RECONCILIATION_EXACT_MAIN_CI_REQUIRED/],
  ['later docs SHA as CI identity', f => { f.observation.currentMainCi.source = '0'.repeat(40); }, /RECONCILIATION_EXACT_MAIN_CI_REQUIRED/],
  ['different source equivalence', f => { f.observation.mainEquivalence.mainSource = '0'.repeat(40); }, /RECONCILIATION_EXACT_MAIN_EQUIVALENCE_REQUIRED/],
  ['missing actual ninth receipt', f => { delete f.operationReceiptBytes.backendMigration; }, /RECONCILIATION_NINE_ACTUAL_RECEIPTS_REQUIRED/],
  ['changed raw receipt bytes', f => { f.operationReceiptBytes.backendMigration = Buffer.from('{}'); }, /RECONCILIATION_ACTUAL_RECEIPT_HASH_CHANGED/],
  ['changed raw baseline', f => { f.baselineServicesBytes = Buffer.from('{}'); }, /DEPLOYMENT_CAPACITY_RAW_HASH_CHANGED/],
  ['stale reviewed completion', f => { f.review.completionSha256 = '0'.repeat(64); }, /RECONCILIATION_COMPLETION_REVIEW_HASH_CHANGED/],
  ['overwrite current index', f => { f.publicPaths.history = 'docs/releases/release297/current-release.json'; }, /RECONCILIATION_FRESH_RECORD_REQUIRED/],
  ['Windows case alias of current index', f => { f.publicPaths.history = 'docs/releases/release297/CURRENT-RELEASE.json'; }, /RECONCILIATION_FRESH_RECORD_REQUIRED/],
  ['overwrite original predecessor', f => { f.publicPaths.history = f.previousIndex.evidence.buildSecurityPreviousIndex.path; }, /RECONCILIATION_FRESH_RECORD_REQUIRED/],
  ['path traversal', f => { f.publicPaths.completion = 'docs/releases/release297/../other.json'; }, /RECONCILIATION_PUBLIC_PATH_INVALID/],
  ['normalized path alias', f => { f.publicPaths.completion = 'docs/releases/release297//synthetic-completion.json'; }, /RECONCILIATION_PUBLIC_PATH_INVALID/],
  ['Windows case alias of historical record', f => { f.publicPaths.history = f.previousIndex.evidence.buildSecurityPreviousIndex.path.replace('history/', 'HISTORY/'); }, /RECONCILIATION_FRESH_RECORD_REQUIRED/],
  ['duplicate outputs', f => { f.publicPaths.review = f.publicPaths.completion; }, /RECONCILIATION_DISTINCT_RECORDS_REQUIRED/],
  ['Windows case alias of new output', f => { f.publicPaths.review = f.publicPaths.completion.replace('synthetic-completion', 'SYNTHETIC-COMPLETION'); }, /RECONCILIATION_DISTINCT_RECORDS_REQUIRED/],
  ['unreviewed new merge', f => { f.observation.addedPullRequests.push({ number: 999 }); }, /RECONCILIATION_REVIEWED_MERGE_ROW_MISSING/],
  ['unobserved merge row', f => { f.addedMergeRows = [{ repository: 'SchoolPilot', number: 999 }]; }, /RECONCILIATION_UNOBSERVED_MERGE_ROW/],
];
for (const [name, mutate, expected] of invalid) test('preparation rejects ' + name + ' before returning a draft', () => { const f = fixture(); mutate(f); assert.throws(() => buildDeploymentReconciliationDraft(f), expected); });

function sealRoleFixture(f, syncServices = true) {
  if (syncServices) f.actualReadback.services = structuredClone(f.completion.postdeployment.services);
  const bytes = publicJsonBytes(f.actualReadback), hash = sha(bytes);
  f.operationReceiptBytes.postdeploymentTaskAndFlagReadback = bytes;
  f.completion.operations.postdeploymentTaskAndFlagReadback.receipt.sha256 = hash;
  f.review.operationReceiptSha256s.postdeploymentTaskAndFlagReadback = hash;
  f.review.roleHealthReadbackSha256 = hash;
  f.review.completionSha256 = sha(publicJsonBytes(f.completion));
  return f;
}
function roleFixture() {
  const f = fixture();
  f.completion.schemaVersion = f.review.schemaVersion = 3;
  Object.assign(f.completion.postdeployment, { roleHealthContractsPassed: true, allActualTasksRunning: true });
  f.completion.postdeployment.migrationConnectionClosureScope = 'Three observed zero counts for both verified principals at the exact stopped-task IP under recorded visibility; this does not prove migrator pool.end completion. The inspector connectionClosed field records only inspector client shutdown.';
  for (const role of ['api', 'scheduler-worker']) {
    const api = role === 'api', service = f.completion.postdeployment.services[role];
    delete service.allTasksHealthy;
    Object.assign(service, { taskDefinition: arn(api ? 'schoolpilot-production-api-emergency' : 'schoolpilot-production-scheduler-worker', api ? 185 : 201), roleHealthContractPassed: true, healthCheckConfigured: api, taskHealthStatus: api ? 'HEALTHY' : 'UNKNOWN', containerHealthStatus: api ? 'HEALTHY' : 'UNKNOWN' });
  }
  f.review.actualRoleHealthContractsReplayed = true;
  f.review.actualRoleHealthDefinitionsAndTasksReplayed = true;
  f.review.actualWorkerBaselineHealthCheckAbsenceReplayed = true;
  f.actualReadback = { schemaVersion: 2, kind: 'actual_matched_A3_service_task_environment_readback', status: 'passed', mainSource: f.observation.mainSource, applicationSource: f.completion.applicationSource, publicationSha256: f.completion.operations.servingPublication.receipt.sha256, fallbackRegistrationSha256: f.completion.operations.compatibleFallback129Registration.receipt.sha256, roleHealthContractsPassed: true, allActualTasksRunning: true, wholeEnvironmentAndSecretReferencesPreserved: true, capabilityModesPreserved: true, admissionCount: 129, cloudMutations: 0, operationalOutcomeUncertain: false, services: {}, usageModes: structuredClone(f.completion.postdeployment.usageModes) };
  return sealRoleFixture(f);
}
test('schema3 preserves actual API HEALTHY and unconfigured worker UNKNOWN without inventing a worker health probe', () => {
  const f = roleFixture(), result = buildDeploymentReconciliationDraft(f);
  const record = JSON.parse(result.records[f.publicPaths.completion]);
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.postdeployment.services.api.healthCheckConfigured, true);
  assert.equal(record.postdeployment.services.api.taskHealthStatus, 'HEALTHY');
  assert.equal(record.postdeployment.services['scheduler-worker'].healthCheckConfigured, false);
  assert.equal(record.postdeployment.services['scheduler-worker'].taskHealthStatus, 'UNKNOWN');
  assert.equal(Object.hasOwn(record.postdeployment.services['scheduler-worker'], 'allTasksHealthy'), false);
  assert.equal(result.filesWritten, 0);
  assert.deepEqual(result.index.evidence.buildSecurityPreviousIndex, f.previousIndex.evidence.buildSecurityPreviousIndex);
});
for (const [name, mutate, expected] of [
  ['missing observed SQL scope', f => { delete f.completion.postdeployment.migrationConnectionClosureScope; }, /DEPLOYMENT_MIGRATION_CONNECTION_SCOPE_REQUIRED/],
  ['migrator pool.end fulfillment claim', f => { f.completion.postdeployment.migrationConnectionClosureScope = 'All migrator pool.end promises fulfilled.'; }, /DEPLOYMENT_MIGRATION_CONNECTION_SCOPE_REQUIRED/],
  ['unknown API', f => { f.completion.postdeployment.services.api.taskHealthStatus = 'UNKNOWN'; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['unknown API container', f => { f.completion.postdeployment.services.api.containerHealthStatus = 'UNKNOWN'; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['unconfigured API probe', f => { f.completion.postdeployment.services.api.healthCheckConfigured = false; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['unexpected worker probe', f => { f.completion.postdeployment.services['scheduler-worker'].healthCheckConfigured = true; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['unhealthy worker', f => { f.completion.postdeployment.services['scheduler-worker'].taskHealthStatus = 'UNHEALTHY'; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['fabricated worker healthy', f => { f.completion.postdeployment.services['scheduler-worker'].containerHealthStatus = 'HEALTHY'; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['worker blanket health claim', f => { f.completion.postdeployment.services['scheduler-worker'].allTasksHealthy = true; }, /DEPLOYMENT_BLANKET_HEALTH_CLAIM_REJECTED/],
  ['poststate blanket health claim', f => { f.completion.postdeployment.allActualTasksHealthy = true; }, /DEPLOYMENT_BLANKET_HEALTH_CLAIM_REJECTED/],
  ['substituted worker definition', f => { f.completion.postdeployment.services['scheduler-worker'].taskDefinition = arn('schoolpilot-production-scheduler-worker', 200); }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['substituted API definition', f => { f.completion.postdeployment.services.api.taskDefinition = arn('schoolpilot-production-api-emergency', 184); }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['worker not running', f => { f.completion.postdeployment.services['scheduler-worker'].runningCount = 0; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['incomplete convergence', f => { f.completion.postdeployment.services.api.rolloutState = 'IN_PROGRESS'; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['false all-running claim', f => { f.completion.postdeployment.allActualTasksRunning = false; }, /DEPLOYMENT_ROLE_HEALTH_CONTRACT_INVALID/],
  ['worker image substitution', f => { f.completion.postdeployment.services['scheduler-worker'].imageDigest = 'sha256:' + '0'.repeat(64); }, /DEPLOYMENT_TASK_IMAGE_CHANGED/],
]) test('schema3 rejects ' + name, () => { const f = roleFixture(); mutate(f); sealRoleFixture(f); assert.throws(() => buildDeploymentReconciliationDraft(f), expected); });
for (const [name, mutate, expected] of [
  ['legacy actual readback', f => { f.actualReadback.schemaVersion = 1; }, /RECONCILIATION_ACTUAL_ROLE_READBACK_REQUIRED/],
  ['readback fabricated blanket healthy', f => { f.actualReadback.allActualTasksHealthy = true; }, /RECONCILIATION_BLANKET_HEALTH_CLAIM_REJECTED/],
  ['readback all-running false', f => { f.actualReadback.allActualTasksRunning = false; }, /RECONCILIATION_ACTUAL_ROLE_READBACK_REQUIRED/],
  ['readback publication substitution', f => { f.actualReadback.publicationSha256 = '0'.repeat(64); }, /RECONCILIATION_ACTUAL_ROLE_READBACK_REQUIRED/],
  ['readback services substitution', f => { f.actualReadback.services.api.taskDefinition = arn('schoolpilot-production-api-emergency', 184); }, /RECONCILIATION_ROLE_READBACK_SERVICES_CHANGED/],
  ['readback Usage substitution', f => { f.actualReadback.usageModes.CLASSPILOT_DIGITAL_USAGE_MODE = 'on'; }, /RECONCILIATION_ROLE_READBACK_USAGE_CHANGED/],
]) test('schema3 rejects ' + name, () => { const f = roleFixture(); mutate(f); sealRoleFixture(f, false); assert.throws(() => buildDeploymentReconciliationDraft(f), expected); });
for (const [name, mutate] of [
  ['missing independent role replay', f => { delete f.review.actualRoleHealthContractsReplayed; }],
  ['missing independent raw definition and task replay', f => { delete f.review.actualRoleHealthDefinitionsAndTasksReplayed; }],
  ['missing independent baseline probe absence replay', f => { delete f.review.actualWorkerBaselineHealthCheckAbsenceReplayed; }],
  ['substituted independent role readback hash', f => { f.review.roleHealthReadbackSha256 = '0'.repeat(64); }],
]) test('schema3 rejects ' + name, () => { const f = roleFixture(); mutate(f); assert.throws(() => buildDeploymentReconciliationDraft(f), /DEPLOYMENT_ROLE_HEALTH_REVIEW_REQUIRED/); });

function laterObservation() {
  const source = '96f136e6953c60b8ca2effeea88f0cbdef5e91c7';
  const ref = name => ({ storage: 'private', format: 'json', path: 'synthetic-test/' + name + '.json', sha256: sha(name) });
  return { schemaVersion: 2, mainSource: main, observedAtUtc: '2026-10-10T04:00:00.000Z', latestRemoteMain: { schemaVersion: 1, kind: 'release297_later_remote_main_observation', source, deployedMainSource: main, applicationSource: '2001e8888992674493c3084981fa8aae27d70e1d', parent: main, observedAtUtc: '2026-10-10T03:56:00.000Z', applicationInputsChanged: true, frontendInputsChanged: true, equivalenceClaimed: false, acceptanceTransferClaimed: false, releasePublicationOrDeploymentAuthorized: false, releaseReady: false, operationalAuthorization: false, currentMainCi: { source, status: 'unknown', rationale: 'CI for this later source was not observed; deployed runtime CI does not transfer.' }, pullRequest: { number: 631, title: 'Synthetic later application change', headRefOid: '1'.repeat(40), mergeCommit: { oid: source }, mergedAt: '2026-10-10T03:55:00.000Z', state: 'MERGED', url: 'https://github.com/bzinkan/SchoolPilot/pull/631' }, retainedEvidence: { actualObservation: ref('latest-main'), independentReview: ref('latest-main-review') } } };
}
test('later remote main has separate dated source and unobserved CI without changing historical observations', () => {
  const value = laterObservation(), before = publicJsonBytes(value);
  assert.equal(validateBuildSecurityLatestRemoteMain(value), value.latestRemoteMain);
  assert.deepEqual(publicJsonBytes(value), before);
  assert.equal(validateBuildSecurityLatestRemoteMain({ schemaVersion: 1 }), null);
});
for (const [name, mutate, expected] of [
  ['runtime substitution', x => { x.latestRemoteMain.deployedMainSource = x.latestRemoteMain.source; }, /LATER_MAIN_RUNTIME_DISTINCTION_REQUIRED/],
  ['parent substitution', x => { x.latestRemoteMain.parent = '0'.repeat(40); }, /LATER_MAIN_RUNTIME_DISTINCTION_REQUIRED/],
  ['application equivalence transfer', x => { x.latestRemoteMain.equivalenceClaimed = true; }, /LATER_MAIN_RUNTIME_DISTINCTION_REQUIRED/],
  ['acceptance transfer', x => { x.latestRemoteMain.acceptanceTransferClaimed = true; }, /LATER_MAIN_RUNTIME_DISTINCTION_REQUIRED/],
  ['deployment authorization transfer', x => { x.latestRemoteMain.releasePublicationOrDeploymentAuthorized = true; }, /LATER_MAIN_RUNTIME_DISTINCTION_REQUIRED/],
  ['B5 CI transfer', x => { x.latestRemoteMain.currentMainCi.source = x.mainSource; }, /LATER_MAIN_CI_NOT_TRANSFERABLE/],
  ['unobserved CI pass', x => { x.latestRemoteMain.currentMainCi.status = 'passed'; }, /LATER_MAIN_CI_NOT_TRANSFERABLE/],
  ['missing unknown CI rationale', x => { delete x.latestRemoteMain.currentMainCi.rationale; }, /LATER_MAIN_CI_NOT_TRANSFERABLE/],
  ['Windows absolute proof path', x => { x.latestRemoteMain.retainedEvidence.actualObservation.path = 'C:/private/proof.json'; }, /LATER_MAIN_RETAINED_PROOF_REQUIRED/],
  ['noncanonical proof path', x => { x.latestRemoteMain.retainedEvidence.actualObservation.path = 'proof/./observation.json'; }, /LATER_MAIN_RETAINED_PROOF_REQUIRED/],
  ['same source', x => { x.latestRemoteMain.source = x.mainSource; }, /LATER_MAIN_DISTINCT_SOURCE_REQUIRED/],
  ['unobserved merge', x => { x.latestRemoteMain.pullRequest.mergeCommit.oid = '0'.repeat(40); }, /LATER_MAIN_MERGE_REQUIRED/],
  ['future observation', x => { x.latestRemoteMain.observedAtUtc = '2026-10-11T00:00:00.000Z'; }, /LATER_MAIN_OBSERVATION_TIME_INVALID/],
  ['missing independent source proof', x => { delete x.latestRemoteMain.retainedEvidence.independentReview; }, /LATER_MAIN_RETAINED_PROOF_REQUIRED/],
]) test('later remote main rejects ' + name, () => { const value = laterObservation(); mutate(value); assert.throws(() => validateBuildSecurityLatestRemoteMain(value), expected); });

test('reconciliation distinguishes deployed runtime from later remote main and leaves future-source applicability pending', () => {
  const f = roleFixture(), later = laterObservation().latestRemoteMain;
  f.observation.latestRemoteMain = later;
  f.observation.addedPullRequests.push(later.pullRequest);
  f.publicPaths.latestMain = 'docs/releases/release297/synthetic-later-main.json';
  f.addedMergeRows = [{ repository: 'SchoolPilot', number: later.pullRequest.number, title: later.pullRequest.title, state: 'MERGED', headSha: later.pullRequest.headRefOid, mergeSha: later.source, mergedAtUtc: later.pullRequest.mergedAt, includedInSource: later.source, affectedArtifacts: ['backend', 'frontend'], reusableEvidence: 'Historical runtime evidence only.', requiredReruns: 'Fresh affected source-specific validation required.' }];
  const result = buildDeploymentReconciliationDraft(f);
  assert.equal(result.index.sources.schoolpilot.remoteMainObserved, later.source);
  assert.equal(result.index.gates.find(row => row.id === 'build-security-main-ci').sourceSha, main);
  assert.equal(result.index.gates.find(row => row.id === 'build-security-main-ci').label, 'Deployed source CI and input equivalence');
  assert.equal(result.index.gates.find(row => row.id === 'build-security-later-main-applicability').status, 'pending');
  assert.equal(JSON.parse(result.records[f.publicPaths.completion]).mainSource, main);
  assert.equal(JSON.parse(result.records[f.publicPaths.observation]).currentMainCi.source, main);
  assert.deepEqual(JSON.parse(result.records[f.publicPaths.latestMain]), later);
  const rendered = renderStatus(result.index);
  assert.match(rendered, /Later remote main `96f136e6` changes backend and frontend inputs/);
  assert.match(rendered, /runtime `f3af52c7` and tested A3 artifacts/);
});

test('published completion keeps actual B5 runtime separate from later observed main and its pending applicability', () => {
  const index = readJson('docs/releases/release297/current-release.json');
  validateIndex(index);
  const observation = readJson(index.evidence.buildSecurityCurrentObservation.path);
  const completion = readJson(index.evidence.buildSecurityDeploymentCompletion.path);
  const latest = readJson(index.evidence.buildSecurityLatestRemoteMain.path);
  assert.equal(completion.mainSource, 'e22c790aee125a5312c0b4ec37ea594ff56ed999');
  assert.equal(observation.currentMainCi.source, completion.mainSource);
  assert.equal(completion.applicationSource, '2001e8888992674493c3084981fa8aae27d70e1d');
  assert.equal(latest.source, '96f136e6953c60b8ca2effeea88f0cbdef5e91c7');
  assert.equal(latest.currentMainCi.status, 'unknown');
  assert.equal(latest.equivalenceClaimed, false);
  const production = readJson(index.evidence.buildSecurityLatestProduction.path);
  assert.equal(production.source, latest.source);
  assert.equal(production.acceptanceStatus, 'unknown');
  assert.equal(production.frontendVerification, 'unknown');
  assert.equal(index.stages.find(row => row.id === 'deployment').applicability, 'historical');
  assert.equal(index.gates.find(row => row.id === 'build-security-later-production-applicability').status, 'pending');
  assert.match(renderStatus(index), /were deployed in the dated B5 release/);
  assert.match(renderStatus(index), /Later production observation .*API 186 \/ worker 202, source `96f136e6`/);
  assert.doesNotMatch(renderStatus(index), /are deployed\.\*\*/);
  assert.equal(index.gates.find(row => row.id === 'build-security-later-main-applicability').status, 'pending');
  assert.equal(index.stages.find(row => row.id === 'activation').status, 'pending');
  assert.equal(index.stages.find(row => row.id === 'live').status, 'pending');
  assert.match(renderStatus(index), /exact registered, unused F3 pair/);
  assert.match(renderStatus(index), /Historical CP-AI-001 production backend protection \(2026-10-08\)/);
  assert.match(renderStatus(index), /PR #630 is merged and included/);
  assert.doesNotMatch(renderStatus(index), /Review\/merge PR630/);
  assert.match(renderStatus(index), /Historical Fresh production, backups, flags and window/);
  assert.match(renderStatus(index), /Historical Current frontend compatibility with F3 recovery/);
  assert.match(renderStatus(index), /Bind approved sample-bearing live evidence to the exact currently observed production source/);
  assert.match(renderStatus(index), /Dated B5 source CI and input equivalence/);
  assert.match(renderStatus(index), /Rows marked Historical retain their dated preparation statuses/);
  assert.deepEqual(index.evidence.buildSecurityPreviousIndex, { path: 'docs/releases/release297/history/current-release-0fc57be1-20261009.json', gitBlobSha256: '63e50a638928f7e29e67b2dcb8cb46589e21fda2db380f17ae31d88a95278075' });
});

function laterProduction(completion) {
  const retained = name => ({ storage: 'private', format: 'json', path: 'synthetic-test/' + name + '.json', sha256: sha(name) });
  return { schemaVersion: 1, kind: 'release297_later_production_observation', observedAtUtc: '2026-10-10T09:00:00.000Z', completedReleaseMainSource: completion.mainSource, completedReleaseCompletionSha256: sha(publicJsonBytes(completion)), source: '96f136e6953c60b8ca2effeea88f0cbdef5e91c7', acceptanceStatus: 'unknown', frontendVerification: 'unknown', equivalenceClaimed: false, acceptanceTransferClaimed: false, releaseReady: false, operationalAuthorization: false, services: Object.fromEntries(['api', 'scheduler-worker'].map(role => { const api = role === 'api'; return [role, { taskDefinition: arn(api ? 'schoolpilot-production-api-emergency' : 'schoolpilot-production-scheduler-worker', api ? 186 : 202), imageDigest: 'sha256:' + 'c'.repeat(64), desiredCount: 1, runningCount: 1, pendingCount: 0, rolloutState: 'COMPLETED', healthCheckConfigured: api, taskHealthStatus: api ? 'HEALTHY' : 'UNKNOWN', containerHealthStatus: api ? 'HEALTHY' : 'UNKNOWN' }]; })), usageModes: { CLASSPILOT_USAGE_ROLLUP_MODE: 'off', CLASSPILOT_DIGITAL_USAGE_MODE: 'off', CLASSPILOT_DAILY_USAGE_ROLLUP_MODE: 'shadow' }, retainedEvidence: { actualObservation: retained('latest-production'), independentReview: retained('latest-production-review') } };
}
test('later production appends separate evidence and preserves all dated completion bytes and statuses', () => {
  const f = roleFixture(), draft = buildDeploymentReconciliationDraft(f), latest = laterProduction(f.completion), original = publicJsonBytes(draft.index), completed = publicJsonBytes(f.completion);
  const result = appendLatestProductionObservation(draft.index, f.completion, latest, 'docs/releases/release297/synthetic-later-production.json');
  assert.deepEqual(publicJsonBytes(draft.index), original);
  assert.deepEqual(publicJsonBytes(f.completion), completed);
  assert.equal(result.index.stages.find(row => row.id === 'deployment').status, 'passed');
  assert.equal(result.index.stages.find(row => row.id === 'deployment').applicability, 'historical');
  assert.equal(result.index.gates.find(row => row.id === 'build-security-later-production-applicability').status, 'pending');
  assert.equal(result.index.evidence.buildSecurityDeploymentCompletion.gitBlobSha256, sha(completed));
});
for (const [name, mutate, expected] of [
  ['completion substitution', x => { x.completedReleaseCompletionSha256 = '0'.repeat(64); }, /LATER_PRODUCTION_COMPLETION_DISTINCTION_REQUIRED/],
  ['old runtime substituted', x => { x.source = roleFixture().completion.mainSource; }, /LATER_PRODUCTION_SOURCE_REQUIRED/],
  ['acceptance transfer', x => { x.acceptanceTransferClaimed = true; }, /LATER_PRODUCTION_EVIDENCE_NOT_TRANSFERABLE/],
  ['unobserved frontend pass', x => { x.frontendVerification = 'passed'; }, /LATER_PRODUCTION_EVIDENCE_NOT_TRANSFERABLE/],
  ['release readiness', x => { x.releaseReady = true; }, /LATER_PRODUCTION_EVIDENCE_NOT_TRANSFERABLE/],
  ['API unknown', x => { x.services.api.taskHealthStatus = 'UNKNOWN'; }, /LATER_PRODUCTION_ROLE_STATE_REQUIRED/],
  ['invented worker health', x => { x.services['scheduler-worker'].taskHealthStatus = 'HEALTHY'; }, /LATER_PRODUCTION_ROLE_STATE_REQUIRED/],
  ['old pair substituted', x => { x.services.api.taskDefinition = roleFixture().completion.postdeployment.services.api.taskDefinition; }, /LATER_PRODUCTION_TASK_PAIR_REQUIRED/],
  ['pending deployment', x => { x.services.api.pendingCount = 1; }, /LATER_PRODUCTION_ROLE_STATE_REQUIRED/],
  ['missing independent review', x => { delete x.retainedEvidence.independentReview; }, /LATER_PRODUCTION_RETAINED_PROOF_REQUIRED/],
  ['outside private ref', x => { x.retainedEvidence.actualObservation.path = '../capture.json'; }, /LATER_PRODUCTION_RETAINED_PROOF_REQUIRED/],
  ['unknown image', x => { x.services.api.imageDigest = null; }, /LATER_PRODUCTION_IMAGE_REQUIRED/],
]) test('later production rejects ' + name, () => { const completion = roleFixture().completion, latest = laterProduction(completion); mutate(latest); assert.throws(() => validateBuildSecurityLatestProduction(latest, completion, latest.observedAtUtc), expected); });
