import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PROFILES, profileHash, hash } from './contracts.mjs';
import { canonicalSchemaFingerprint } from '../release-schema-fingerprint.mjs';
import { remapObservedEnvironment, validateBaselineAdvertisement } from './environment.mjs';
import { baselineFixedEnvironment } from './baseline-environment-compatibility.mjs';
import { assertOutside } from './owner.mjs';
import { SCANNER, scanCounts } from '../../../verify-legacy-deploy-image.mjs';
import { CP_PROTECTED_SOURCE, CP_PROTECTED_ARTIFACT, CP_PROTECTED_BINDING_ID, BINDING_FILES, validateProtectedBuildDependencyAudit, BUILD_SECURITY_SOURCE, BUILD_SECURITY_ARTIFACT, BUILD_SECURITY_BINDING_ID, BUILD_SECURITY_APPLICATION_SOURCE, BUILD_SECURITY_ANCHOR_ARTIFACT, validateBuildSecurityOutputEquivalence, validateBuildSecurityMigrationOwnership } from '../../../release-source-binding.mjs';

// One reviewed successor, not a general source override. Historical profiles,
// their byte hashes and the DDC/54-entry lower-load contract remain unchanged.
export const ACCEPTANCE_SUCCESSOR_ID = 'release297-current-school-acceptance-ecf6ce01-v1';
export const CP_PROTECTED_ACCEPTANCE_ID = 'release297-current-school-acceptance-ecf6ce01-cp-protected-v2';
export const BUILD_SECURITY_ACCEPTANCE_ID = 'release297-current-school-acceptance-2001e888-cp-protected-build-v3';
const isProtectedAcceptance = id => [CP_PROTECTED_ACCEPTANCE_ID, BUILD_SECURITY_ACCEPTANCE_ID].includes(id);
const protectedAcceptancePins = id => id === BUILD_SECURITY_ACCEPTANCE_ID ? { source: BUILD_SECURITY_SOURCE, artifact: BUILD_SECURITY_ARTIFACT, id: BUILD_SECURITY_BINDING_ID, schemaVersion: 5 } : { source: CP_PROTECTED_SOURCE, artifact: CP_PROTECTED_ARTIFACT, id: CP_PROTECTED_BINDING_ID, schemaVersion: 4 };
const protectedFallbackIdentity = id => { const { source, artifact } = protectedAcceptancePins(id); assert.ok(artifact, 'CP_PROTECTED_ARTIFACT_PINS_PENDING'); return { source, image: artifact.localIndex, config: artifact.config, platform: artifact.platform, archiveSha256: artifact.archiveSha256 }; };
export const ACCEPTANCE_CANDIDATE = 'ecf6ce0100e758f5668c5a26427c1c0ea82ea0a2';
export const ACCEPTANCE_CANDIDATE_IDENTITIES = Object.freeze({ source: ACCEPTANCE_CANDIDATE,
  image: 'sha256:23f729573155904217586ff4f951d7978f0b29926ce2b76a320ce2106a844c3a',
  config: 'sha256:6b982c4db99aa807c972e834eac786001e7f34b9972273e3c64bbe39333a78f4',
  platform: 'sha256:59ab676f40521e9796ebe7fe543f997c76c0dc4c378bc772b23b0f4377e92de0',
  archiveSha256: '99647f52ecb2ef250e49ab20653fcc91753084dd89089295311d581dea1b0a41' });
export const BUILD_SECURITY_ACCEPTANCE_CANDIDATE_IDENTITIES = BUILD_SECURITY_ANCHOR_ARTIFACT && Object.freeze({source:BUILD_SECURITY_APPLICATION_SOURCE,image:BUILD_SECURITY_ANCHOR_ARTIFACT.localIndex,config:BUILD_SECURITY_ANCHOR_ARTIFACT.config,platform:BUILD_SECURITY_ANCHOR_ARTIFACT.platform,archiveSha256:BUILD_SECURITY_ANCHOR_ARTIFACT.archiveSha256});
const candidateIdentity = binding => binding.id === BUILD_SECURITY_ACCEPTANCE_ID ? BUILD_SECURITY_ACCEPTANCE_CANDIDATE_IDENTITIES : ACCEPTANCE_CANDIDATE_IDENTITIES;
export const ACCEPTANCE_BASELINE = '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678';
export const ACCEPTANCE_BASELINE_IMAGE = '135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8';
export const ACCEPTANCE_FALLBACK = 'd75fc1c48d0a3918857508d3965904c69023a153';
export const ACCEPTANCE_FALLBACK_IDENTITIES = Object.freeze({ source: ACCEPTANCE_FALLBACK,
  image: 'sha256:cf7ce08efaa73aed0e5322ae22fecf54e650e74db35eb2aea080d3afae70a459',
  config: 'sha256:f215c48e089bd83cb2306814b05f404c82038d2547a526dc7ae3e4e8fe5f9a84',
  platform: 'sha256:b5848846b7990714672e52f4785ac562a13fdcbcfce5fdc99e6439170268ecb6',
  archiveSha256: 'ad88fa8fb0aebb5ef2ee9bbffcfe20a0d64a94000b035da843ed028e9bd9ac58' });
export const ACCEPTANCE_POLICY_SHA256 = '965328a337fe35eaa505610ade00633075f7014fab610da8a869f6b514688f95';
export const FIXED_ORDER = Object.freeze(['A', 'A', 'A', 'B', 'B', 'A', 'A', 'B']);
export const SUCCESSOR_PROFILES = Object.freeze([PROFILES.sole, PROFILES.boundaryPreparation, PROFILES.classroomNative, PROFILES.mixedNative, PROFILES.lower250]);
export const ACCEPTANCE_TOOL_DEPENDENCIES = Object.freeze(['scripts/verify-legacy-deploy-image.mjs', 'scripts/release-source-binding.mjs']);
const directory = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 ** 2 }).trim();
const json = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);
const image = value => assert.match(value, /^(?:sha256:|[a-zA-Z0-9./:_-]+@sha256:)[a-f0-9]{64}$/);
function evidenceTime(value) {
  assert.equal(typeof value, 'string'); assert.match(value, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const time = Date.parse(value); assert.ok(Number.isFinite(time)); return time;
}
function evidenceWindow(binding, at = Date.now()) {
  const floor = evidenceTime(binding.evidenceNotBefore), ceiling = evidenceTime(binding.recordedAt);
  assert.ok(Number.isFinite(at) && floor <= ceiling && ceiling <= at); return { floor, ceiling };
}
function withinEvidence(value, binding, at) {
  const time = evidenceTime(value), { floor, ceiling } = evidenceWindow(binding, at);
  assert.ok(time >= floor && time <= ceiling); return time;
}
function evidenceInterval(value, binding, at) {
  const start = withinEvidence(value.startedAt, binding, at), end = withinEvidence(value.completedAt, binding, at);
  assert.ok(start < end); return { start, end };
}
export function readPinnedSuccessorInput(input) {
  const bytes = readPinnedSuccessorBytes(input);
  return { bytes, value: json(bytes) };
}
export function readPinnedSuccessorBytes(input) {
  digest(input?.sha256); assert.equal(typeof input.file, 'string');
  const bytes = readFileSync(input.file); assert.equal(hash(bytes), input.sha256);
  return bytes;
}
export function acceptanceHarnessInventory(root = directory) {
  const files = git(root, ['ls-files', 'scripts/load/usage']).split('\n').filter(Boolean).sort();
  assert.ok(files.length > 0);
  return Object.fromEntries(files.map(name => [name, hash(readFileSync(join(root, name)))]));
}
export function acceptanceToolDependencies(root = directory) {
  return Object.fromEntries(ACCEPTANCE_TOOL_DEPENDENCIES.map(name => [name, hash(readFileSync(join(root, name)))]));
}
export function assertFrozenAcceptanceHarness(binding) {
  assert.match(binding.source, /^[a-f0-9]{40}$/);
  assert.equal(git(binding.directory, ['rev-parse', 'HEAD']), binding.source);
  assert.equal(git(binding.directory, ['status', '--porcelain']), '');
  assert.deepEqual(acceptanceHarnessInventory(binding.directory), binding.files);
  assert.deepEqual(acceptanceToolDependencies(binding.directory), binding.dependencies);
  return true;
}
export function assertFrozenAcceptanceSource(role) {
  assert.equal(git(role.sourceDirectory, ['rev-parse', 'HEAD']), role.source);
  assert.equal(git(role.sourceDirectory, ['status', '--porcelain']), '');
  return true;
}
function assertRole(role, count, tables) {
  assertFrozenAcceptanceSource(role);
  image(role.image); image(role.config); image(role.platform);
  const proof = readPinnedSuccessorInput(role.imageBinding).value;
  assert.equal(proof.source, role.source); assert.equal(proof.image, role.image); assert.equal(proof.verified, true);
  assert.equal(proof.config, role.config); assert.equal(proof.platform, role.platform);
  digest(role.schema.sha256); digest(role.schema.canonicalSha256);
  const schema = readFileSync(role.schema.file); assert.equal(hash(schema), role.schema.sha256);
  assert.equal(canonicalSchemaFingerprint(schema.toString('utf8')), role.schema.canonicalSha256);
  const receipt = readPinnedSuccessorInput(role.schema.receipt).value;
  assert.equal(receipt.source, role.source); assert.equal(receipt.schemaSha256, role.schema.sha256); assert.equal(receipt.verified, true);
  assert.equal(receipt.migrations?.length, count); assert.equal(new Set(receipt.migrations.map(row => row.id)).size, count);
  for (const row of receipt.migrations) { assert.equal(row.status, 'complete'); digest(row.checksum); }
  assert.equal(receipt.rlsTables?.length, tables); assert.equal(new Set(receipt.rlsTables).size, tables);
  return receipt;
}
function assertHelper(helper, role, harness) {
  const proof = readPinnedSuccessorInput(helper.binding).value;
  assert.equal(proof.verified, true); assert.equal(proof.cleanupPassed, true); assert.equal(proof.applicationChanges, 0);
  assert.equal(proof.applicationSource, role.source); assert.equal(proof.applicationImage, role.image);
  for (const key of ['helperImage', 'helperConfigDigest', 'helperContainerImage']) { image(helper[key]); assert.equal(proof[key], helper[key]); }
  const preparation = readPinnedSuccessorInput(helper.preparation).value;
  assert.equal(proof.preparationSha256, helper.preparation.sha256);
  assert.equal(preparation.applicationSource, role.source); assert.equal(preparation.applicationImage, role.image);
  assert.equal(preparation.harnessSource, harness.source); assert.deepEqual(preparation.canonicalFiles, harness.files);
  assert.equal(preparation.originalContractUnchanged, true);
}
function assertPreparedEvidence(input, binding, kind) {
  const proof = readPinnedSuccessorInput(input).value;
  assert.equal(proof.kind, kind); assert.equal(proof.source, binding.candidate.source); assert.equal(proof.applicationImage, binding.candidate.image);
  assert.equal(proof.passed, true); assert.equal(proof.cleanupPassed, true); assert.equal(proof.forcedCleanup, false);
  assert.ok(Array.isArray(proof.inputs) && proof.inputs.length > 0);
  for (const reference of proof.inputs) readPinnedSuccessorBytes(reference);
  withinEvidence(proof.completedAt, binding);
  return proof;
}
export function assertNativeSuccessorPreparation(proof, binding) {
  const result = readPinnedSuccessorInput(proof.nativeResult).value, execution = readPinnedSuccessorInput(proof.execution).value;
  const run = evidenceInterval(execution, binding), probe = evidenceInterval(result, binding);
  assert.ok(run.start <= probe.start && probe.end <= run.end);
  assert.ok(run.end <= withinEvidence(proof.completedAt, binding));
  for (const value of [result, execution]) {
    assert.equal(value.source, binding.candidate.source); assert.equal(value.image, binding.candidate.image); assert.equal(value.artifactRole, 'serving-anchor');
    assert.equal(value.passed, true); assert.equal(value.syntheticFixturesOnly, true); assert.equal(value.providerRequests, 0); assert.equal(value.productionMutations, 0);
  }
  assert.equal(result.kind, 'release297_successor_native_processing_result'); assert.equal(execution.kind, 'release297_successor_independent_native_execution');
  assert.equal(execution.resultSha256, proof.nativeResult.sha256);
  assert.equal(result.networkIsolation, 'none'); assert.equal(execution.resources.network, 'none'); assert.equal(execution.resources.readonlyRoot, true);
  const required = ['linux-amd64-musl-and-exact-production-dependencies', 'native-synthetic-screenshot-jpeg-png-resize',
    'actual-private-image-normalization-and-metadata-removal', 'actual-private-pdf-inspection-and-preserved-document-bytes',
    'actual-private-pdf-rendering-and-color-continuity', 'private-pdf-invalid-encrypted-and-over-page-limit-rejection',
    'express-proxy-depth-selection-and-spoofed-extra-hop-boundary', 'actual-auth-rate-limiter-ipv6-grouping-and-independent-client-boundary',
    'actual-api-rate-limiter-verified-staff-and-invalid-token-identity'];
  assert.deepEqual(result.checks.map(row => row.name).sort(), required.sort()); assert.ok(result.checks.every(row => row.passed === true));
  assert.equal(result.cleanup.localHttpServersClosed, true); assert.equal(result.cleanup.dbQueries, 0); assert.equal(result.cleanup.remainingDatabaseConnections, 0); assert.equal(result.cleanup.privateTempDirectoriesRemoved, true);
  assert.equal(execution.cleanup.forced, false); assert.equal(execution.cleanup.containerAbsent, true); assert.equal(execution.cleanup.exactOwned, true); assert.equal(execution.cleanup.complete, true);
  assert.deepEqual(execution.exit, { attachCode: 0, daemonExitCode: 0, running: false, oomKilled: false });
  const inspection = readPinnedSuccessorInput(proof.imageInspect).value;
  if (Array.isArray(inspection)) assert.equal(inspection.length, 1);
  const inspect = Array.isArray(inspection) ? inspection[0] : inspection;
  assert.ok(inspect && typeof inspect === 'object');
  assert.equal(inspect.Id, binding.candidate.image); assert.equal(inspect.Config.Labels['org.opencontainers.image.revision'], binding.candidate.source);
  return true;
}
export function assertOrdinaryMigrationConnectionRole(role, binding) {
  assert.deepEqual(role, binding.id === BUILD_SECURITY_ACCEPTANCE_ID
    ? { superuser: false, bypassRls: false, inherit: false, schemaOwner: false, applicationTableOwner: true, schemaUsageAndCreate: true }
    : { superuser: false, bypassRls: false, inherit: false, schemaOwner: true, schemaUsageAndCreate: true });
}
export function assertOrdinarySuccessorRecovery(proof, binding) {
  const native = readPinnedSuccessorInput(proof.nativeResult).value, review = readPinnedSuccessorInput(proof.independentReview).value, execution = readPinnedSuccessorInput(proof.execution).value;
  const run = evidenceInterval(execution, binding), observed = withinEvidence(native.observedAtUtc, binding), reviewed = withinEvidence(review.observedAtUtc, binding);
  assert.ok(run.end <= observed && observed <= reviewed && reviewed <= withinEvidence(proof.completedAt, binding));
  const pair = { 'serving-anchor': { source: binding.candidate.source, localIndex: binding.candidate.image, config: binding.candidate.config, platform: binding.candidate.platform, archiveSha256: binding.candidate.archiveSha256 },
    fallback: { source: binding.fallback.source, localIndex: binding.fallback.image, config: binding.fallback.config, platform: binding.fallback.platform, archiveSha256: binding.fallback.archiveSha256 } };
  for (const value of [native, review]) { assert.equal(value.evidenceKind, 'ordinaryRecovery'); assert.equal(value.passed, true); assert.deepEqual(value.artifactPair, pair); }
  assert.equal(native.kind, 'release_successor_native_result'); assert.equal(review.kind, 'release_successor_independent_review');
  assert.equal(review.nativeResultSha256, proof.nativeResult.sha256); assert.equal(review.fullIndependentReviewComplete, true); assert.equal(review.independentFromProducer, true);
  assert.deepEqual(review.rawEvidenceSha256s, native.rawEvidence.map(row => row.sha256));
  assertOutside(binding.candidate.sourceDirectory, proof.retainedEvidenceDirectory); assertOutside(binding.harness.directory, proof.retainedEvidenceDirectory);
  const retainedInput = (row, requireFormat = true) => {
    assert.equal(row.storage, 'private');
    if (requireFormat || row.format !== undefined) assert.ok(['json', 'text'].includes(row.format));
    else assert.match(row.path, /\.(json|log|mjs|sql)$/);
    const path = resolve(proof.retainedEvidenceDirectory, row.path), rel = relative(resolve(proof.retainedEvidenceDirectory), path);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..'));
    return { file: path, sha256: row.sha256 };
  };
  for (const row of native.rawEvidence) readPinnedSuccessorBytes(retainedInput(row));
  const migrationPin = native.restrictedMigrationEvidence;
  assert.ok(native.rawEvidence.some(row => row.path === migrationPin.path && row.sha256 === migrationPin.sha256));
  const migration = readPinnedSuccessorInput(retainedInput(migrationPin)).value;
  assert.equal(migration.kind, 'release_migration_role_independent_review'); assert.equal(migration.passed, true); assert.deepEqual(migration.artifactPair, pair);
  const migrationAt = withinEvidence(migration.observedAtUtc, binding); assert.ok(run.end <= migrationAt && migrationAt <= observed);
  assertOrdinaryMigrationConnectionRole(migration.verified.migrationConnectionRole, binding);
  if (binding.id === BUILD_SECURITY_ACCEPTANCE_ID) validateBuildSecurityMigrationOwnership(execution);
  assert.equal(migration.verified.actualVersionedMigrationExecutions, 8); assert.equal(migration.verified.ordinary43to53AndFallbackRetains53, true);
  assert.equal(migration.verified.zeroNamedMigrationSqlConnections, true); assert.ok(migration.rawEvidence.length > 0);
  for (const row of migration.rawEvidence) readPinnedSuccessorBytes(retainedInput(row, false));
  for (const key of ['restrictedRoleVerified', 'retainedScreenshotFunctionBodyAndAcl', 'privateChatHistoryAndFencesPreserved', 'exactFocusCleanupPassed', 'capabilityEqualityPassed',
    'privateChatCompatibilityFloorsPassed', 'allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections']) assert.equal(native.checks[key], true);
  assert.deepEqual(native.recovery, { baselineMigrations: 43, candidateMigrations: 53, fallbackDeclaredMigrations: 52, retainedCompletedMigrations: 53,
    admissionCounts: [121, 125, 126, 127, 128, 129], phases: ['baseline43', 'candidate53-dark128', 'candidate53-adopt129', 'fallback-retains53', 'candidate-return53'],
    sequence: [binding.candidate.source, binding.fallback.source, binding.candidate.source] });
  assert.equal(native.actualApiWorkerProcesses, 8); assert.equal(native.gracefulDrains, 8); assert.equal(native.migration.role.rolsuper, false); assert.equal(native.migration.role.rolbypassrls, false);
  assert.equal(native.migration.ordinaryPath, true); assert.equal(native.migration.baselineMigrations, 43); assert.equal(native.migration.completedMigrations, 53);
  for (const [arm, count, source] of [['baseline', 43, ACCEPTANCE_BASELINE], ['candidate', 53, binding.candidate.source]]) {
    const actual = execution.sourceSpecificNative[arm]; assert.equal(actual.passed, true); assert.equal(actual.source, source);
    assert.equal(actual.applicationImage, arm === 'baseline' ? binding.baseline.image : binding.candidate.image);
    const rows = actual.nativeCompletedMigrations; assert.equal(rows.length, count); assert.equal(new Set(rows.map(row => row.id)).size, count);
    for (const row of rows) { assert.equal(row.status, 'complete'); digest(row.checksum); }
  }
  assert.equal(execution.source, binding.candidate.source); assert.equal(execution.passed, true); assert.equal(execution.productionMutations, 0);
  assert.equal(execution.cleanupPassed, true); assert.equal(execution.gracefulCleanupPassed, true); assert.equal(execution.networkCleanupPassed, true); assert.equal(execution.completedInsideAuthorizedWindow, true);
  assert.equal(execution.actualApiWorkerProcesses, true); assert.equal(execution.services.length, 8); assert.equal(execution.drains.length, 8);
  assert.equal(new Set(execution.services.map(row => row.containerId)).size, 8);
  for (const phase of ['bridge128', 'adopt129', 'fallback129', 'return129']) {
    const role = phase === 'fallback129' ? binding.fallback : binding.candidate, rows = execution.services.filter(row => row.phase === phase);
    assert.deepEqual(rows.map(row => row.service).sort(), ['api', 'worker']);
    for (const row of rows) { assert.equal(row.source, role.source); assert.equal(row.image, role.image); assert.equal(row.runtimeImage, role.image); assert.equal(row.inventoryCount, phase === 'bridge128' ? 128 : 129); }
  }
  for (const row of execution.services) {
    assert.equal(typeof row.containerId, 'string'); assert.ok(row.containerId.length > 0);
    const drains = execution.drains.filter(drain => drain.phase === row.phase && drain.service === row.service && drain.containerId === row.containerId); assert.equal(drains.length, 1);
    const drain = drains[0]; assert.equal(drain.sourceImage, row.image); assert.equal(drain.exitCode, 0); assert.equal(drain.oomKilled, false); assert.equal(drain.sqlConnections, 0); assert.equal(drain.forced, false);
  }
  assert.ok(execution.cleanup.length > 0 && execution.cleanup.every(row => row.graceful === true && row.removed === true && row.forced === false && row.exitCode === 0 && row.oomKilled === false));
  return true;
}
export function assertFreshSecurityScan(input, role, binding, at = Date.now()) {
  const proof = readPinnedSuccessorInput(input).value;
  assert.equal(proof.kind, 'exact_artifact_security_scan'); assert.equal(proof.source, role.source); assert.equal(proof.applicationImage, role.image);
  assert.equal(proof.config, role.config); assert.equal(proof.platform, role.platform);
  assert.equal(proof.completed, true); assert.equal(proof.high, 0); assert.equal(proof.critical, 0);
  for (const severity of ['medium', 'low', 'unknown']) assert.ok(Number.isSafeInteger(proof[severity]) && proof[severity] >= 0);
  assert.equal(proof.scannerIdentity, SCANNER);
  assert.deepEqual(proof.databaseMetadata, readPinnedSuccessorInput(proof.databaseMetadataInput).value);
  const completed = withinEvidence(proof.completedAt, binding, at);
  const raw = readPinnedSuccessorInput(proof.rawScan).value;
  const counts = scanCounts(raw, role.config);
  for (const severity of ['critical', 'high', 'medium', 'low', 'unknown']) assert.equal(proof[severity], counts[severity.toUpperCase()]);
  const receipt = readPinnedSuccessorInput(proof.scanReceipt).value;
  assert.equal(receipt.sourceSha, role.source); assert.equal(receipt.imageId, role.image); assert.equal(receipt.configDigest, role.config);
  assert.equal(receipt.scanner, SCANNER); assert.equal(receipt.passed, true); assert.equal(receipt.os, 'linux'); assert.equal(receipt.architecture, 'amd64');
  assert.equal(receipt.reportSha256, proof.rawScan.sha256); assert.equal(receipt.archiveSha256, role.archiveSha256); assert.deepEqual(receipt.counts, counts);
  const scanned = withinEvidence(receipt.createdAt, binding, at), database = proof.databaseMetadata;
  assert.equal(database.Version, 2);
  const updated = evidenceTime(database.UpdatedAt), downloaded = withinEvidence(database.DownloadedAt, binding, at), next = evidenceTime(database.NextUpdate);
  assert.ok(updated <= downloaded && downloaded <= scanned && scanned <= completed && scanned < next && at < next);
  assert.equal(proof.archive.sha256, role.archiveSha256); readPinnedSuccessorBytes(proof.archive);
  assert.equal(proof.rawConfig.sha256, role.config.slice(7));
  const config = readPinnedSuccessorInput(proof.rawConfig).value;
  assert.equal(config.os, 'linux'); assert.equal(config.architecture, 'amd64'); assert.equal(config.config.Labels['org.opencontainers.image.revision'], role.source);
  return true;
}
// Separate from historical validateMixedRuns: only the reviewed successor
// requires fresh, distinct, sequential attempts from one declared campaign.
export function assertSuccessorMixedSequence(records, binding, completedAt) {
  assert.equal(records.length, 3);
  for (const field of ['run', 'verifiedReceiptManifestSha256', 'reservationSha256']) assert.equal(new Set(records.map(row => row[field])).size, 3);
  const campaign = records[0].campaignContractSha256; digest(campaign);
  let previousEnd = null;
  for (const row of records) {
    assert.match(row.run, /^[a-f0-9]{12}$/); digest(row.verifiedReceiptManifestSha256); digest(row.reservationSha256); assert.equal(row.campaignContractSha256, campaign);
    const start = evidenceTime(row.startedAt), end = evidenceTime(row.finishedAt);
    assert.ok(start >= evidenceTime(binding.evidenceNotBefore) && start < end && end <= evidenceTime(completedAt));
    if (previousEnd !== null) assert.ok(previousEnd <= start); previousEnd = end;
  }
  return true;
}
export function assertAcceptanceSuccessorIdentity(binding, at = Date.now()) {
  assert.equal(binding.schemaVersion, 1); assert.ok([ACCEPTANCE_SUCCESSOR_ID, CP_PROTECTED_ACCEPTANCE_ID, BUILD_SECURITY_ACCEPTANCE_ID].includes(binding.id), 'ACCEPTANCE_BINDING_NOT_ALLOWLISTED');
  assert.equal(binding.kind, 'current_school_acceptance_successor_preparation');
  assert.equal(binding.preparationReviewed, true); assert.equal(binding.localSyntheticOnly, true);
  assert.equal(binding.operationalAuthorization, false); assert.equal(binding.releaseReady, false);
  assert.ok(candidateIdentity(binding), 'BUILD_SECURITY_ANCHOR_PINS_PENDING');
  for (const [key, value] of Object.entries(candidateIdentity(binding))) assert.equal(binding.candidate[key], value);
  assert.equal(binding.baseline.source, ACCEPTANCE_BASELINE);
  assert.equal(binding.baseline.image, ACCEPTANCE_BASELINE_IMAGE); assert.deepEqual(binding.fallback, isProtectedAcceptance(binding.id) ? protectedFallbackIdentity(binding.id) : ACCEPTANCE_FALLBACK_IDENTITIES);
  if (isProtectedAcceptance(binding.id)) { assert.equal(binding.releaseBindingId, protectedAcceptancePins(binding.id).id); assert.equal(binding.credentialBoundaryRetainedOnRollback, true); }
  assert.equal(binding.audience, 'DeSales'); assert.equal(binding.clients, 133); assert.equal(binding.extensionVersion, '2.9.7');
  assert.deepEqual(binding.order, FIXED_ORDER);
  assert.deepEqual(binding.profiles, Object.fromEntries(SUCCESSOR_PROFILES.map(profile => [profile.name, profileHash(profile)])));
  assert.ok(Number.isFinite(at)); assert.ok(at >= Date.parse(binding.validity.startsAt) && at < Date.parse(binding.validity.expiresAt));
  assert.ok(Date.parse(binding.evidenceNotBefore) <= Date.parse(binding.recordedAt));
  assert.ok(Date.parse(binding.recordedAt) <= at);
  assert.ok(Date.parse(binding.validity.expiresAt) - Date.parse(binding.validity.startsAt) <= 48 * 60 * 60 * 1000);
  return true;
}
export function assertProtectedAcceptanceBuildSecurity(binding) {
  const pins = protectedAcceptancePins(binding.id);
  const filename = join(binding.harness.directory, BINDING_FILES[pins.id]);
  assert.equal(resolve(binding.releaseSourceBinding?.file ?? ''), resolve(filename), 'CP_PROTECTED_ACCEPTANCE_PROFILE_SUBSTITUTED');
  const { value: profile } = readPinnedSuccessorInput(binding.releaseSourceBinding);
  assert.deepEqual([profile.schemaVersion, profile.id, profile.applicationSource, profile.artifacts?.fallback, profile.operationalAuthorization], [pins.schemaVersion, pins.id, candidateIdentity(binding)?.source, pins.artifact, false], 'CP_PROTECTED_ACCEPTANCE_PROFILE_CHANGED');
  assert.equal(profile.preparation?.status, 'passed', 'CP_PROTECTED_ACCEPTANCE_PREPARATION_PENDING');
  assert.equal(profile.buildDependencyAudit?.status, 'passed', 'CP_PROTECTED_ACCEPTANCE_BUILD_AUDIT_FAILED');
  assert.equal(binding.buildDependencyAudit.audit.sha256, profile.buildDependencyAudit.audit.sha256, 'CP_PROTECTED_ACCEPTANCE_AUDIT_SUBSTITUTED');
  assert.equal(binding.buildDependencyAudit.sourceChecks.sha256, profile.buildDependencyAudit.sourceChecks.sha256, 'CP_PROTECTED_ACCEPTANCE_AUDIT_SUBSTITUTED');
  validateProtectedBuildDependencyAudit(readPinnedSuccessorInput(binding.buildDependencyAudit.audit).value, readPinnedSuccessorInput(binding.buildDependencyAudit.sourceChecks).value, profile);
  if (binding.id === BUILD_SECURITY_ACCEPTANCE_ID) {
    const keys = ['execution', 'beforeAlias', 'afterAlias', 'successor', 'independentReview'];
    for (const key of keys) assert.equal(binding.compiledOutputEquivalence?.[key]?.sha256, profile.compiledOutputEquivalence?.[key]?.sha256, 'BUILD_SECURITY_ACCEPTANCE_OUTPUT_SUBSTITUTED');
    validateBuildSecurityOutputEquivalence(...keys.map(key => readPinnedSuccessorInput(binding.compiledOutputEquivalence[key]).value), profile);
  }
  return true;
}
export function validateAcceptanceSuccessor(input, { at = Date.now() } = {}) {
  const { value: binding } = readPinnedSuccessorInput(input);
  assertAcceptanceSuccessorIdentity(binding, at);
  if (isProtectedAcceptance(binding.id)) assertProtectedAcceptanceBuildSecurity(binding);
  // Failed exact fallback security evidence is fatal before Git or Docker work.
  assertFreshSecurityScan(binding.securityScans.fallback, binding.fallback, binding, at);
  assertOutside(binding.candidate.sourceDirectory, input.file); assertOutside(binding.harness.directory, input.file);
  assertFrozenAcceptanceHarness(binding.harness);
  assertRole(binding.candidate, 53, 129); assertRole(binding.baseline, 43, 121);
  assertFreshSecurityScan(binding.securityScans.candidate, binding.candidate, binding, at);
  assertHelper(binding.helpers.candidate, binding.candidate, binding.harness);
  assertHelper(binding.helpers.baseline, binding.baseline, binding.harness);
  assert.equal(binding.policy.sha256, ACCEPTANCE_POLICY_SHA256);
  const policy = readPinnedSuccessorInput(binding.policy).value;
  assert.equal(policy.ownerPolicyAmendmentApproved, true); assert.equal(policy.status, 'APPROVED_READINESS_CRITERIA_ONLY');
  assert.equal(policy.originalFailuresReclassified, false); assert.equal(policy.historicalStrictComparisonRemainsFailed, true);
  const review = readPinnedSuccessorInput(binding.applicabilityReview).value;
  assert.equal(review.source, binding.candidate.source); assert.equal(review.applicationImage, binding.candidate.image);
  assert.equal(review.policyReceiptSha256, ACCEPTANCE_POLICY_SHA256); assert.equal(review.criteriaChanged, false);
  assert.equal(review.applicable, true); assert.equal(review.operationalAuthorization, false);
  const native = assertPreparedEvidence(binding.nativePreparation, binding, 'candidate_native_processing_preparation');
  assert.equal(native.screenshotProcessing, true); assert.equal(native.privateFilesAndPdf, true);
  assertNativeSuccessorPreparation(native, binding);
  const recovery = assertPreparedEvidence(binding.ordinaryRecovery, binding, 'candidate_fallback_candidate_ordinary_recovery');
  assert.deepEqual(recovery.sources, [binding.candidate.source, binding.fallback.source, binding.candidate.source]);
  assert.equal(recovery.fallbackImage, binding.fallback.image); assert.equal(recovery.fallbackConfig, binding.fallback.config); assert.equal(recovery.fallbackPlatform, binding.fallback.platform);
  assert.deepEqual(recovery.migrationPhases, [43, 53]); assert.deepEqual(recovery.admissionPhases, [121, 125, 126, 127, 128, 129]);
  assert.equal(recovery.retainedCompletedMigrations, 53); assert.equal(recovery.namedSqlConnectionsAfterCleanup, 0);
  for (const key of ['restrictedRole', 'crossSchool', 'resetScope', 'capabilityEquality', 'privateChatFloors', 'focusCleanup', 'screenshotFunctionPermissions', 'privateMessageExpiryAndHistory']) assert.equal(recovery[key], true);
  assertOrdinarySuccessorRecovery(recovery, binding);
  if (isProtectedAcceptance(binding.id)) {
    const protection = readPinnedSuccessorInput(binding.credentialBoundaryReview).value;
    assert.equal(protection.releaseBindingId, protectedAcceptancePins(binding.id).id); assert.equal(protection.source, protectedAcceptancePins(binding.id).source); assert.equal(protection.applicationImage, binding.fallback.image);
    assert.equal(protection.passed, true); assert.equal(protection.syntheticFixturesOnly, true); assert.equal(protection.providerRequests, 0);
    assert.equal(protection.operationalAuthorization, false); assert.equal(protection.retainedOnRollback, true); withinEvidence(protection.completedAt, binding, at);
    assert.ok(Array.isArray(protection.inputs) && protection.inputs.length > 0); for (const record of protection.inputs) readPinnedSuccessorBytes(record);
  }
  const capture = readPinnedSuccessorInput(binding.environment.capture).value;
  const mapped = remapObservedEnvironment(capture, binding.environment.scopeBinding, binding.schoolLocalDate);
  assert.equal(mapped.observedFlagsSha256, binding.environment.observedFlagsSha256);
  const flags = readPinnedSuccessorInput(binding.environment.flagsBinding).value;
  assert.equal(flags.currentFlagsFileSha256, binding.environment.capture.sha256);
  assert.equal(flags.classpilotUsageRollupMode, 'off'); assert.equal(flags.classpilotDigitalUsageMode, 'off');
  assert.equal(typeof flags.classpilotDailyUsageRollupSetting, 'string'); assert.equal(typeof flags.classpilotDailyUsageRollupEffective, 'string');
  validateBaselineAdvertisement(readPinnedSuccessorInput(binding.clientAdvertisement).value);
  return { binding, input: { ...input }, preparationPassed: true, releaseReady: false, operationalAuthorization: false };
}
export function assertSuccessorRunBinding(options, profile, result) {
  const binding = result.binding, role = options.arm === 'A' ? binding.baseline : binding.candidate;
  const helper = options.arm === 'A' ? binding.helpers.baseline : binding.helpers.candidate;
  assert.equal(binding.profiles[profile.name], profileHash(profile)); assert.equal(profile.usage, false);
  assert.equal(options.preparationSmoke === true, profile.preparationOnly === true);
  assert.equal(options.source, role.source); assert.equal(resolve(options.sourceDirectory), resolve(role.sourceDirectory));
  assert.equal(options.helperImage, helper.helperImage); assert.equal(options.helperConfigDigest, helper.helperConfigDigest);
  assert.equal(options.helperBindingSha256, helper.binding.sha256); assert.equal(resolve(options.helperBindingFile), resolve(helper.binding.file));
  assert.equal(resolve(options.preparationFile), resolve(helper.preparation.file));
  assert.equal(options.schemaSha256, role.schema.sha256); assert.equal(resolve(options.schemaFile), resolve(role.schema.file));
  assert.equal(options.schemaReceiptSha256, role.schema.receipt.sha256); assert.equal(resolve(options.schemaReceiptFile), resolve(role.schema.receipt.file));
  assert.equal(options.observedEnvironmentSha256, binding.environment.capture.sha256);
  assert.equal(resolve(options.observedEnvironmentFile), resolve(binding.environment.capture.file));
  assert.deepEqual(options.scopeBinding, binding.environment.scopeBinding);
  if (profile.kind === 'blackbox') {
    assert.equal(options.clientAdvertisementSha256, binding.clientAdvertisement.sha256);
    assert.equal(resolve(options.clientAdvertisementFile), resolve(binding.clientAdvertisement.file));
  }
  assert.equal(options.hostHarnessSource, binding.harness.source);
  assert.equal(options.snapshotDirectory, undefined); assert.equal(options.cpuProfiler, undefined); assert.equal(options.reportCostCases, undefined);
  return { id: binding.id, sha256: result.input.sha256, file: result.input.file, hostHarnessSource: binding.harness.source, candidateSource: binding.candidate.source, candidateImage: binding.candidate.image,
    policyReceiptSha256: binding.policy.sha256, ordinaryMigrationCount: 53, releaseReady: false, operationalAuthorization: false };
}
export function assertSuccessorReceiptBinding(metrics) {
  const successor = metrics.acceptanceSuccessor;
  if (!successor) return;
  const result = validateAcceptanceSuccessor({ file: successor.file, sha256: successor.sha256 }, { at: Date.parse(metrics.startedAt) });
  const { binding } = result, role = metrics.arm === 'A' ? binding.baseline : binding.candidate;
  const helper = metrics.arm === 'A' ? binding.helpers.baseline : binding.helpers.candidate;
  assert.equal(successor.id, binding.id); assert.equal(metrics.source, role.source); assert.equal(metrics.applicationImage, role.image);
  assert.equal(metrics.schemaSha256, role.schema.canonicalSha256); assert.equal(metrics.helperImage, helper.helperImage);
  assert.equal(metrics.helperBindingSha256, helper.binding.sha256); assert.equal(metrics.hostHarnessSource, binding.harness.source);
  assert.equal(metrics.hostHarnessSourceUnchanged, true); assert.equal(metrics.harnessSource, binding.harness.source);
  assert.equal(metrics.observedFlagsSha256, binding.environment.observedFlagsSha256);
  if (binding.id === BUILD_SECURITY_ACCEPTANCE_ID) {
    const profile = Object.values(PROFILES).find(value => value.name === metrics.profile); assert.ok(profile);
    const capture = readPinnedSuccessorInput(binding.environment.capture).value;
    const remapped = remapObservedEnvironment(capture, binding.environment.scopeBinding, binding.schoolLocalDate);
    const compatibility = baselineFixedEnvironment({environment:remapped.environment,source:metrics.source,arm:metrics.arm,profile,successorId:binding.id});
    assert.deepEqual(metrics.baselineEnvironmentCompatibility ?? null, compatibility.proof, 'BASELINE_COMPATIBILITY_RECEIPT_CHANGED');
  }
  assert.ok(Date.parse(metrics.finishedAt) < Date.parse(binding.validity.expiresAt));
  return result;
}
