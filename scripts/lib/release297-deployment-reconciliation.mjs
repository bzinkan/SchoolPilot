// Pure documentation preparation. This module never writes files or runs release operations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateBuildSecurityCapacityBaselineRaw, validateBuildSecurityOperationalCompletion, validateBuildSecurityLatestRemoteMain, validateBuildSecurityLatestProduction } from '../release297-current-state.mjs';

export const COMPLETION_OPERATIONS = Object.freeze([
  'servingPublication', 'fallbackPublication', 'current129AnchorRegistration',
  'compatibleFallback129Registration', 'backendMigration', 'backendWorkerDeployment',
  'matchedFrontendDeployment', 'postdeploymentTaskAndFlagReadback', 'publicFrontendByteVerification',
]);
const PROFILE_SHA256 = '8d66e4be314d422014a72e496d40db2156f716e66429f807bffef3f2ba2fcfef';
const APPLICATION_SOURCE = '2001e8888992674493c3084981fa8aae27d70e1d';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const publicJsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const append = (values, added) => [...new Set([...values, ...added])];
const evidence = (file, bytes) => ({ path: file, gitBlobSha256: digest(bytes) });

function publicPath(value) {
  assert.ok(typeof value === 'string' && value.startsWith('docs/releases/release297/'), 'RECONCILIATION_PUBLIC_PATH_REQUIRED');
  assert.ok(!value.includes('\\') && !path.isAbsolute(value) && !value.split('/').includes('..') && value.endsWith('.json'), 'RECONCILIATION_PUBLIC_PATH_INVALID');
  assert.equal(path.posix.normalize(value), value, 'RECONCILIATION_PUBLIC_PATH_INVALID');
  assert.notEqual(value.toLowerCase(), 'docs/releases/release297/current-release.json', 'RECONCILIATION_FRESH_RECORD_REQUIRED');
}

/**
 * Prepare a draft only after actual completion and a separately authored review exist.
 * Receipt bytes are checked for custody, not interpreted as proof of every operation.
 * The independent review must replay those operation-specific proofs. Before any file
 * is published, callers must also run validateIndex against the complete staged tree.
 */
export function buildDeploymentReconciliationDraft(input) {
  assert.ok(input && typeof input === 'object', 'RECONCILIATION_FACTS_REQUIRED');
  const { previousIndex, observation, completion, review, bindingBytes, operationReceiptBytes, baselineServicesBytes, publicPaths, addedMergeRows = [] } = input;
  for (const value of [previousIndex, observation, completion, review, publicPaths]) assert.ok(value && typeof value === 'object', 'RECONCILIATION_FACTS_REQUIRED');
  assert.ok(Buffer.isBuffer(bindingBytes), 'RECONCILIATION_PROFILE_BYTES_REQUIRED');
  const normalizedBinding = Buffer.from(bindingBytes.toString('utf8').replaceAll('\r\n', '\n'));
  assert.equal(digest(normalizedBinding), PROFILE_SHA256, 'RECONCILIATION_ACCEPTED_PROFILE_CHANGED');
  const binding = JSON.parse(normalizedBinding);
  assert.equal(previousIndex.evidence.buildSecurityBinding.gitBlobSha256, PROFILE_SHA256, 'RECONCILIATION_INDEX_PROFILE_CHANGED');
  assert.ok([2, 3].includes(completion.schemaVersion), 'RECONCILIATION_SCHEMA2_REQUIRED');
  assert.equal(review.schemaVersion, completion.schemaVersion, 'RECONCILIATION_SCHEMA2_REQUIRED');
  assert.equal(observation.schemaVersion, 2, 'RECONCILIATION_OPERATIONAL_OBSERVATION_REQUIRED');
  assert.equal(observation.kind, 'release297_build_security_operational_observation', 'RECONCILIATION_OPERATIONAL_OBSERVATION_REQUIRED');
  assert.match(observation.mainSource ?? '', /^[a-f0-9]{40}$/, 'RECONCILIATION_RUNTIME_SOURCE_REQUIRED');
  assert.equal(observation.currentMainCi?.source, observation.mainSource, 'RECONCILIATION_EXACT_MAIN_CI_REQUIRED');
  assert.equal(observation.currentMainCi?.status, 'passed', 'RECONCILIATION_EXACT_MAIN_CI_REQUIRED');
  assert.equal(observation.mainEquivalence?.mainSource, observation.mainSource, 'RECONCILIATION_EXACT_MAIN_EQUIVALENCE_REQUIRED');
  assert.deepEqual(observation.mainEquivalence, { status: 'passed', applicationReference: APPLICATION_SOURCE, mainSource: observation.mainSource, backendInventory: binding.inventory, frontendInventory: binding.frontendInventory }, 'RECONCILIATION_EXACT_MAIN_EQUIVALENCE_REQUIRED');
  const latestMain = validateBuildSecurityLatestRemoteMain(observation);
  assert.deepEqual(Object.keys(publicPaths).sort(), latestMain ? ['completion', 'history', 'latestMain', 'observation', 'review'] : ['completion', 'history', 'observation', 'review'], 'RECONCILIATION_RECORD_PATHS_REQUIRED');
  const used = new Set(Object.values(previousIndex.evidence).map(row => row.path.toLowerCase()));
  for (const file of Object.values(publicPaths)) { publicPath(file); assert.ok(!used.has(file.toLowerCase()), 'RECONCILIATION_FRESH_RECORD_REQUIRED'); }
  assert.equal(new Set(Object.values(publicPaths).map(file => file.toLowerCase())).size, latestMain ? 5 : 4, 'RECONCILIATION_DISTINCT_RECORDS_REQUIRED');
  assert.deepEqual(Object.keys(operationReceiptBytes ?? {}).sort(), [...COMPLETION_OPERATIONS].sort(), 'RECONCILIATION_NINE_ACTUAL_RECEIPTS_REQUIRED');
  for (const name of COMPLETION_OPERATIONS) {
    const bytes = operationReceiptBytes[name];
    assert.ok(Buffer.isBuffer(bytes), 'RECONCILIATION_ACTUAL_RECEIPT_BYTES_REQUIRED');
    assert.equal(digest(bytes), completion.operations?.[name]?.receipt?.sha256, 'RECONCILIATION_ACTUAL_RECEIPT_HASH_CHANGED');
    const value = JSON.parse(bytes.toString('utf8'));
    assert.ok(value && !Array.isArray(value) && typeof value === 'object', 'RECONCILIATION_ACTUAL_RECEIPT_JSON_REQUIRED');
  }
  if (completion.schemaVersion === 3) {
    const actual = JSON.parse(operationReceiptBytes.postdeploymentTaskAndFlagReadback.toString('utf8'));
    assert.deepEqual([actual.schemaVersion, actual.kind, actual.status, actual.mainSource, actual.applicationSource, actual.publicationSha256, actual.fallbackRegistrationSha256, actual.roleHealthContractsPassed, actual.allActualTasksRunning, actual.wholeEnvironmentAndSecretReferencesPreserved, actual.capabilityModesPreserved, actual.admissionCount, actual.cloudMutations, actual.operationalOutcomeUncertain], [2, 'actual_matched_A3_service_task_environment_readback', 'passed', observation.mainSource, APPLICATION_SOURCE, completion.operations.servingPublication.receipt.sha256, completion.operations.compatibleFallback129Registration.receipt.sha256, true, true, true, true, 129, 0, false], 'RECONCILIATION_ACTUAL_ROLE_READBACK_REQUIRED');
    assert.ok(!Object.hasOwn(actual, 'allActualTasksHealthy'), 'RECONCILIATION_BLANKET_HEALTH_CLAIM_REJECTED');
    assert.deepEqual(actual.services, completion.postdeployment.services, 'RECONCILIATION_ROLE_READBACK_SERVICES_CHANGED');
    assert.deepEqual(actual.usageModes, completion.postdeployment.usageModes, 'RECONCILIATION_ROLE_READBACK_USAGE_CHANGED');
  }
  validateBuildSecurityCapacityBaselineRaw(completion.capacityBaseline, baselineServicesBytes, completion.sequence?.[0]?.startedAtUtc);
  const index = structuredClone(previousIndex);
  const completionBytes = publicJsonBytes(completion), reviewBytes = publicJsonBytes(review), observationBytes = publicJsonBytes(observation), historyBytes = publicJsonBytes(previousIndex);
  assert.equal(review.completionSha256, digest(completionBytes), 'RECONCILIATION_COMPLETION_REVIEW_HASH_CHANGED');
  const ids = ['buildSecurityDeploymentCompletion', 'buildSecurityDeploymentReview'];
  for (const id of [...ids, 'buildSecurityPredeploymentIndex', 'buildSecurityPredeploymentObservation']) assert.ok(!Object.hasOwn(index.evidence, id), 'RECONCILIATION_COMPLETION_ALREADY_RECORDED');
  index.evidence.buildSecurityPredeploymentIndex = evidence(publicPaths.history, historyBytes);
  index.evidence.buildSecurityPredeploymentObservation = structuredClone(previousIndex.evidence.buildSecurityCurrentObservation);
  index.evidence.buildSecurityDeploymentCompletion = evidence(publicPaths.completion, completionBytes);
  index.evidence.buildSecurityDeploymentReview = evidence(publicPaths.review, reviewBytes);
  index.evidence.buildSecurityCurrentObservation = evidence(publicPaths.observation, observationBytes);
  const latestMainRecords = latestMain ? { [publicPaths.latestMain]: publicJsonBytes(latestMain) } : {};
  if (latestMain) index.evidence.buildSecurityLatestRemoteMain = evidence(publicPaths.latestMain, latestMainRecords[publicPaths.latestMain]);
  index.observedAtUtc = observation.observedAtUtc;
  const observedMainSource = latestMain?.source ?? observation.mainSource;
  index.sources.schoolpilot.remoteMainObserved = observedMainSource;
  index.sources.schoolpilot.evidence = append(index.sources.schoolpilot.evidence, latestMain ? [...ids, 'buildSecurityLatestRemoteMain'] : ids);
  for (const row of index.inclusionMatrix) if (row.repository === 'SchoolPilot') row.includedInSource = observedMainSource;
  assert.ok(Array.isArray(addedMergeRows), 'RECONCILIATION_REVIEWED_MERGE_ROWS_REQUIRED');
  assert.equal(new Set(addedMergeRows.map(row => row.number)).size, addedMergeRows.length, 'RECONCILIATION_DUPLICATE_MERGE_ROW');
  for (const row of addedMergeRows) {
    assert.equal(row.repository, 'SchoolPilot', 'RECONCILIATION_REVIEWED_MERGE_ROWS_REQUIRED');
    assert.ok(!index.inclusionMatrix.some(prior => prior.repository === row.repository && prior.number === row.number), 'RECONCILIATION_HISTORICAL_MERGE_REPLACED');
    const pr = observation.addedPullRequests?.find(prior => prior.number === row.number);
    assert.ok(pr, 'RECONCILIATION_UNOBSERVED_MERGE_ROW');
    assert.deepEqual([row.headSha, row.mergeSha, row.mergedAtUtc, row.state, row.includedInSource], [pr.headRefOid, pr.mergeCommit?.oid, pr.mergedAt, 'MERGED', observedMainSource], 'RECONCILIATION_MERGE_IDENTITY_CHANGED');
    index.inclusionMatrix.push(structuredClone(row));
  }
  for (const pr of observation.addedPullRequests ?? []) {
    const old = index.inclusionMatrix.find(row => row.repository === 'SchoolPilot' && row.number === pr.number);
    if (old) {
      assert.deepEqual([old.headSha, old.mergeSha, old.mergedAtUtc, old.state], [pr.headRefOid, pr.mergeCommit?.oid, pr.mergedAt, 'MERGED'], 'RECONCILIATION_MERGE_IDENTITY_CHANGED');
    } else {
      assert.fail('RECONCILIATION_REVIEWED_MERGE_ROW_MISSING');
    }
  }
  for (const stage of index.stages) if (['implementation', 'testing', 'packaging', 'publication', 'deployment'].includes(stage.id)) {
    Object.assign(stage, { status: 'passed', applicability: 'current_baseline', observedAtUtc: observation.observedAtUtc, evidence: append(stage.evidence, ids), nextAction: 'Retain the actual completion evidence; already-open page adoption and sample-bearing live acceptance remain pending.' });
    if (['implementation', 'publication'].includes(stage.id)) stage.sourceSha = observation.mainSource;
    if (stage.id === 'deployment') stage.sourceSha = APPLICATION_SOURCE;
    stage.rationale = 'Actual independently reviewed matched deployment completion records the exact runtime source and artifact pair; activation and live acceptance remain separate.';
  }
  const mainGate = index.gates.find(row => row.id === 'build-security-main-ci');
  assert.ok(mainGate, 'RECONCILIATION_CURRENT_MAIN_GATE_REQUIRED');
  Object.assign(mainGate, { status: 'passed', sourceSha: observation.mainSource, observedAtUtc: observation.observedAtUtc, evidence: append(mainGate.evidence, ids), nextAction: 'Keep this dated CI observation bound to the deployed runtime source.' });
  if (latestMain) {
    mainGate.label = 'Deployed source CI and input equivalence';
    index.gates.push({ id: 'build-security-later-main-applicability', label: 'Later remote main artifact and release applicability', status: 'pending', applicability: 'equivalence_required', sourceSha: latestMain.source, observedAtUtc: latestMain.observedAtUtc, evidence: ['buildSecurityLatestRemoteMain'], rationale: 'Later remote main changes backend and frontend inputs; the deployed B5 evidence retains its exact runtime scope.', nextAction: 'Obtain source-specific CI, artifacts and affected recovery and acceptance before publication or deployment. Review the new temporary_room rollback floor before any future F3 reuse; this later source is not deployed.' });
  }
  assert.ok(!index.gates.some(row => row.id === 'build-security-operational-completion'), 'RECONCILIATION_COMPLETION_ALREADY_RECORDED');
  index.gates.push({ id: 'build-security-operational-completion', label: 'Actual matched backend, worker and frontend deployment', status: 'passed', applicability: 'current_baseline', sourceSha: APPLICATION_SOURCE, observedAtUtc: observation.observedAtUtc, evidence: ids, rationale: 'Nine actual operation receipts and independent completion review passed, preserving admission129, ordinary53 and the observed capacity baseline.', nextAction: 'Already-open page adoption and sample-bearing live acceptance remain pending.' });
  for (const row of index.artifacts) if (['backend-current-a3', 'frontend-current-a3', 'fallback-build-security-f3'].includes(row.id)) row.evidence = append(row.evidence, ids);
  for (const value of Object.values(index.usageModes)) value.evidence = append(value.evidence, ids);
  // The original predecessor is intentionally retained; the new history snapshot
  // must never replace it and create a recursively overlaid build-security index.
  assert.deepEqual(index.evidence.buildSecurityPreviousIndex, previousIndex.evidence.buildSecurityPreviousIndex);
  validateBuildSecurityOperationalCompletion(index, observation, binding, completion, review);
  return { index, records: { [publicPaths.completion]: completionBytes, [publicPaths.review]: reviewBytes, [publicPaths.observation]: observationBytes, [publicPaths.history]: historyBytes, ...latestMainRecords }, requiresFullIndexValidation: true, filesWritten: 0, operationalAuthorization: false };
}

// Append a later read-only production observation without changing any completed
// operation receipt or reusing its acceptance for the newly observed source.
export function appendLatestProductionObservation(previousIndex, completion, latest, file) {
  assert.ok(previousIndex.evidence.buildSecurityDeploymentCompletion && !previousIndex.evidence.buildSecurityLatestProduction, 'LATER_PRODUCTION_FRESH_RECORD_REQUIRED');
  publicPath(file);
  assert.ok(!Object.values(previousIndex.evidence).some(row => row.path.toLowerCase() === file.toLowerCase()), 'LATER_PRODUCTION_FRESH_RECORD_REQUIRED');
  validateBuildSecurityLatestProduction(latest, completion, latest.observedAtUtc);
  assert.ok(Date.parse(previousIndex.observedAtUtc) <= Date.parse(latest.observedAtUtc), 'LATER_PRODUCTION_OBSERVATION_BACKDATED');
  assert.equal(previousIndex.evidence.buildSecurityDeploymentCompletion.gitBlobSha256, digest(publicJsonBytes(completion)), 'LATER_PRODUCTION_COMPLETION_CHANGED');
  const index = structuredClone(previousIndex), bytes = publicJsonBytes(latest);
  index.observedAtUtc = latest.observedAtUtc;
  index.evidence.buildSecurityLatestProduction = evidence(file, bytes);
  for (const row of index.stages) if (['implementation', 'testing', 'packaging', 'publication', 'deployment'].includes(row.id)) row.applicability = 'historical';
  const completed = index.gates.find(row => row.id === 'build-security-operational-completion');
  assert.ok(completed && completed.status === 'passed', 'LATER_PRODUCTION_COMPLETION_REQUIRED');
  completed.applicability = 'historical';
  index.gates.find(row => row.id === 'build-security-main-ci').applicability = 'historical';
  const laterMain = index.gates.find(row => row.id === 'build-security-later-main-applicability');
  if (laterMain) laterMain.nextAction = 'Review source-specific artifacts, affected acceptance and recovery compatibility for the later observed production. Review the temporary_room rollback floor before any future F3 reuse; B5 evidence does not transfer.';
  index.gates.push({ id: 'build-security-later-production-applicability', label: 'Later production release acceptance and frontend applicability', status: 'pending', applicability: 'equivalence_required', sourceSha: latest.source, observedAtUtc: latest.observedAtUtc, evidence: ['buildSecurityLatestProduction'], rationale: 'Read-only observation records a later API/worker pair; no B5 CI, artifact acceptance or frontend verification transfers.', nextAction: 'Obtain source-specific release and frontend evidence and review the temporary_room rollback floor before future recovery. Preserve the dated B5 completion.' });
  return { index, records: { [file]: bytes }, filesWritten: 0, operationalAuthorization: false };
}
