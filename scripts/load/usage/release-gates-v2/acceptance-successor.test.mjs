import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROFILES, profileHash, hash } from './contracts.mjs';
import { validateRound } from './validation.mjs';
import { ACCEPTANCE_SUCCESSOR_ID, ACCEPTANCE_CANDIDATE, ACCEPTANCE_CANDIDATE_IDENTITIES, ACCEPTANCE_BASELINE, ACCEPTANCE_BASELINE_IMAGE, ACCEPTANCE_FALLBACK_IDENTITIES,
  SUCCESSOR_PROFILES, FIXED_ORDER, assertAcceptanceSuccessorIdentity, readPinnedSuccessorInput, acceptanceHarnessInventory, acceptanceToolDependencies, assertFrozenAcceptanceHarness,
  validateAcceptanceSuccessor, assertFreshSecurityScan, assertNativeSuccessorPreparation, assertOrdinarySuccessorRecovery, assertFrozenAcceptanceSource, assertSuccessorMixedSequence } from './acceptance-successor.mjs';
import { executeSuccessorBlock, assertWholeSuccessorAttempt, fixedSuccessorDisposition, evaluateApprovedCurrentSchool } from './execute-successor.mjs';
import { assertLowerMigrationVector, assertLowerPostRls, assertLowerSafetyPrerequisites } from './lower-load.mjs';
import { runV2 } from './run.mjs';
import { SCANNER } from '../../../verify-legacy-deploy-image.mjs';
import { imageInputInventory, frontendInputInventory } from '../../../release-source-binding.mjs';

const date = Date.parse('2026-10-08T17:00:00Z'), digest = 'a'.repeat(64), candidateImage = 'sha256:' + digest;
function identity() { return { schemaVersion: 1, id: ACCEPTANCE_SUCCESSOR_ID, kind: 'current_school_acceptance_successor_preparation', preparationReviewed: true,
  localSyntheticOnly: true, operationalAuthorization: false, releaseReady: false, candidate: { ...ACCEPTANCE_CANDIDATE_IDENTITIES }, baseline: { source: ACCEPTANCE_BASELINE, image: ACCEPTANCE_BASELINE_IMAGE },
  fallback: { ...ACCEPTANCE_FALLBACK_IDENTITIES }, audience: 'DeSales', clients: 133, extensionVersion: '2.9.7', order: [...FIXED_ORDER],
  profiles: Object.fromEntries(SUCCESSOR_PROFILES.map(profile => [profile.name, profileHash(profile)])),
  evidenceNotBefore: '2026-10-08T15:00:00Z', recordedAt: '2026-10-08T16:00:00Z', validity: { startsAt: '2026-10-08T16:00:00Z', expiresAt: '2026-10-09T16:00:00Z' } }; }
function scratch(use) { const root = mkdtempSync(join(tmpdir(), 'schoolpilot-successor-test-')); const cleanup = () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))); rmSync(root, { recursive: true, force: true }); };
  try { const result = use(root); if (result?.then) return result.finally(cleanup); cleanup(); return result; } catch (error) { cleanup(); throw error; } }
function writePin(root, name, value) { const file = join(root, name); writeFileSync(file, JSON.stringify(value) + '\n'); return { file, sha256: hash(readFileSync(file)) }; }
function migrations(count) { return Array.from({ length: count }, (_, index) => ({ id: 'migration_' + index, checksum: digest, status: 'complete' })); }
function native(count) { return { passed: true, restrictedRole: true, crossSchool: true, resetScope: true,
  catalog: Array.from({ length: 129 }, (_, index) => ({ relname: 'table_' + index, relrowsecurity: true, relforcerowsecurity: true })), migrations: migrations(count) }; }
function cpuWindow(fraction) { return { declaredDurationMs: 60_000, start: { cpu: { usage_usec: 0 }, hrtimeMicroseconds: 1_000_000 }, end: { cpu: { usage_usec: Math.round(fraction * 60_000_000) }, hrtimeMicroseconds: 61_000_000 }, startDelayMs: 0, endDelayMs: 0 }; }
function pairFixture() {
  const binding = { candidate: { source: ACCEPTANCE_CANDIDATE, image: candidateImage, schema: { canonicalSha256: digest } },
    baseline: { source: ACCEPTANCE_BASELINE, image: ACCEPTANCE_BASELINE_IMAGE, schema: { canonicalSha256: 'b'.repeat(64) } },
    helpers: { candidate: { helperImage: 'sha256:' + 'c'.repeat(64) }, baseline: { helperImage: 'sha256:' + 'd'.repeat(64) } },
    harness: { source: 'e'.repeat(40) }, environment: { observedFlagsSha256: 'f'.repeat(64) }, clientAdvertisement: { sha256: '1'.repeat(64) }, policy: { sha256: '2'.repeat(64) } };
  const successor = { binding, input: { sha256: '3'.repeat(64) } };
  const records = FIXED_ORDER.map((arm, index) => {
    const role = arm === 'A' ? binding.baseline : binding.candidate, helper = arm === 'A' ? binding.helpers.baseline : binding.helpers.candidate, p95Ms = arm === 'A' ? 1200 : 100;
    const traffic = { expected: 798, configured: PROFILES.sole.offering, accepted: true, started: 798, succeeded: 798, failed: 0, refusedAtInFlightLimit: 0, lateOffers: 0,
      outstandingAfterDrain: 0, timings: { count: 798, maxMs: 1400, p95Ms }, capabilityAcknowledgements200: 798, targetHistogram: { 0: 798 } };
    const errorCoverage = [{ complete: true, available: true, errorCount: 0, sha256: digest }, { complete: true, available: true, errorCount: 0, sha256: digest }];
    const round = { profile: PROFILES.sole.name, contractSha256: profileHash(PROFILES.sole), topology: { active: [0] }, traffic, persisted: 798, invalidBindings: 0, persistence: { passed: true },
      api: [{ seenHeartbeatOffers: 798 }], drains: [{ complete: true }], measuredWindowMs: 60_000, cpuByRole: [{ window: cpuWindow(.2) }], apiCpuMeanFraction: .2, errorCoverage, databaseFailures: 0 };
    round.acceptance = validateRound(round, PROFILES.sole, { baseline: arm === 'A' });
    const cpuMsPer200 = arm === 'A' ? 10 : 5;
    return { run: index.toString(16).padStart(12, '0'), arm, source: role.source, applicationImage: role.image, schemaSha256: role.schema.canonicalSha256, helperImage: helper.helperImage,
      harnessSource: binding.harness.source, hostHarnessSourceUnchanged: true, sourceUnchanged: true, profile: round.profile, contractSha256: round.contractSha256,
      observedFlagsSha256: binding.environment.observedFlagsSha256, clientAdvertisementSha256: binding.clientAdvertisement.sha256, clientAdvertisementVersion: '2.9.6',
      verifiedReceiptManifestSha256: String(index).repeat(64), fixtureLogicalSha256: digest, nodeVersion: 'v22.23.3', p95Ms, cpuMsPer200,
      wholeOwnedApiCpuMicroseconds: cpuMsPer200 * 1000 * 798, wholeOwnedCpuIncludesFinalClassificationFlush: true,
      acceptanceSuccessor: { sha256: successor.input.sha256, policyReceiptSha256: binding.policy.sha256 }, rounds: [round], errorCoverage,
      runPassed: arm === 'B', cleanupPassed: true, expectedNegativeLogCoverage: true, failure: arm === 'A' ? 'V2_NUMERICAL_ACCEPTANCE_FAILED' : null };
  });
  return { successor, records };
}

test('allowlist retains one exact source pair, profiles, audience and fixed order', () => {
  assert.equal(assertAcceptanceSuccessorIdentity(identity(), date), true);
  for (const change of [row => row.id = 'arbitrary', row => row.candidate.source = 'd'.repeat(40), row => row.candidate.image = candidateImage, row => row.candidate.config = candidateImage, row => row.baseline.source = 'e'.repeat(40), row => row.baseline.image = candidateImage,
    row => row.fallback.image = candidateImage, row => row.fallback.config = candidateImage, row => row.fallback.platform = candidateImage, row => row.fallback.archiveSha256 = digest,
    row => row.clients = 250, row => row.extensionVersion = '2.9.8', row => row.order.reverse(), row => row.profiles[PROFILES.sole.name] = digest,
    row => row.releaseReady = true, row => row.operationalAuthorization = true, row => row.preparationReviewed = false]) {
    const binding = identity(); change(binding); assert.throws(() => assertAcceptanceSuccessorIdentity(binding, date));
  }
});
test('expired, future, malformed and unbounded preparation windows reject', () => {
  assert.throws(() => assertAcceptanceSuccessorIdentity(identity(), date + 48 * 60 * 60 * 1000));
  for (const change of [row => row.recordedAt = '2026-10-09T00:00:00Z', row => row.evidenceNotBefore = '2026-10-09T00:00:00Z', row => row.validity.startsAt = 'unknown', row => row.validity.expiresAt = '2026-10-12T00:00:00Z']) {
    const binding = identity(); change(binding); assert.throws(() => assertAcceptanceSuccessorIdentity(binding, date));
  }
});
test('hash pin rejects tampered and cross-binding input bytes', () => scratch(root => {
  const first = writePin(root, 'first.json', { value: 'first' }), second = writePin(root, 'second.json', { value: 'second' });
  assert.equal(readPinnedSuccessorInput(first).value.value, 'first');
  assert.throws(() => readPinnedSuccessorInput({ file: second.file, sha256: first.sha256 }));
  writeFileSync(first.file, '{}'); assert.throws(() => readPinnedSuccessorInput(first));
}));
test('fresh F scan rejects High/Critical, redated October 7 raw evidence, expired databases and switched roles', () => scratch(root => {
  const rawConfig = writePin(root, 'config.json', { os: 'linux', architecture: 'amd64', config: { Labels: { 'org.opencontainers.image.revision': ACCEPTANCE_FALLBACK_IDENTITIES.source } } });
  const archive = writePin(root, 'archive.json', { syntheticArchive: true });
  const role = { source: ACCEPTANCE_FALLBACK_IDENTITIES.source, image: ACCEPTANCE_FALLBACK_IDENTITIES.image, config: 'sha256:' + rawConfig.sha256, platform: 'sha256:' + 'c'.repeat(64), archiveSha256: archive.sha256 };
  const rawScan = writePin(root, 'raw-scan.json', { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: role.config }, Results: [{ Target: 'synthetic target', Vulnerabilities: [{ Severity: 'MEDIUM', VulnerabilityID: 'SYNTHETIC-TEST' }] }] });
  const scanReceipt = writePin(root, 'scan-receipt.json', { sourceSha: role.source, imageId: role.image, configDigest: role.config, scanner: SCANNER, passed: true, os: 'linux', architecture: 'amd64', reportSha256: rawScan.sha256, archiveSha256: archive.sha256,
    createdAt: '2026-10-08T15:25:00Z', counts: { UNKNOWN: 0, LOW: 0, MEDIUM: 1, HIGH: 0, CRITICAL: 0 } });
  const databaseMetadata = { Version: 2, UpdatedAt: '2026-10-08T14:00:00Z', DownloadedAt: '2026-10-08T15:15:00Z', NextUpdate: '2026-10-09T14:00:00Z' }, databaseMetadataInput = writePin(root, 'database.json', databaseMetadata);
  const proof = { kind: 'exact_artifact_security_scan', source: role.source, applicationImage: role.image, config: role.config, platform: role.platform, completed: true,
    high: 0, critical: 0, medium: 1, low: 0, unknown: 0, scannerIdentity: SCANNER, databaseMetadata, databaseMetadataInput, completedAt: '2026-10-08T15:30:00Z', rawScan, scanReceipt, archive, rawConfig };
  const pin = writePin(root, 'scan-summary.json', proof); assert.equal(assertFreshSecurityScan(pin, role, identity(), date), true);
  for (const change of [row => row.high = 1, row => row.critical = 1, row => row.source = ACCEPTANCE_BASELINE, row => row.applicationImage = ACCEPTANCE_BASELINE_IMAGE,
    row => row.config = candidateImage, row => row.scannerIdentity = 'wrong', row => row.completedAt = '2026-10-07T15:30:00Z', row => row.medium = 0, row => row.completed = false]) {
    const modified = structuredClone(proof); change(modified); const altered = writePin(root, 'modified-scan.json', modified); assert.throws(() => assertFreshSecurityScan(altered, role, identity(), date));
  }
  const highRaw = writePin(root, 'high-raw.json', { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: role.config }, Results: [{ Target: 'synthetic target', Vulnerabilities: [{ Severity: 'HIGH', VulnerabilityID: 'SYNTHETIC-HIGH' }] }] });
  const falselyZero = writePin(root, 'falsely-zero.json', { ...proof, medium: 0, rawScan: highRaw }); assert.throws(() => assertFreshSecurityScan(falselyZero, role, identity(), date));
  const wrongConfigScan = writePin(root, 'wrong-config-scan.json', { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: candidateImage }, Results: [{ Target: 'synthetic target' }] });
  assert.throws(() => assertFreshSecurityScan(writePin(root, 'wrong-config-summary.json', { ...proof, medium: 0, rawScan: wrongConfigScan }), role, identity(), date));
  const receipt = readPinnedSuccessorInput(scanReceipt).value;
  const oldPassedReceipt = writePin(root, 'oct7-passed-receipt.json', { ...receipt, createdAt: '2026-10-07T15:25:00Z' });
  assert.throws(() => assertFreshSecurityScan(writePin(root, 'redated-old-scan-wrapper.json', { ...proof, scanReceipt: oldPassedReceipt }), role, identity(), date));
  for (const change of [row => row.Version = 1, row => row.UpdatedAt = 'invalid', row => row.DownloadedAt = '2026-10-07T15:15:00Z', row => row.DownloadedAt = '2026-10-08T15:26:00Z',
    row => row.UpdatedAt = '2026-10-08T15:20:00Z', row => row.NextUpdate = '2026-10-08T16:30:00Z']) {
    const database = structuredClone(databaseMetadata); change(database);
    const modified = { ...proof, databaseMetadata: database, databaseMetadataInput: writePin(root, 'altered-db.json', database) };
    assert.throws(() => assertFreshSecurityScan(writePin(root, 'altered-db-wrapper.json', modified), role, identity(), date));
  }
}));
test('real temporary Git repository rejects dirty tools, changed inventory and moved harness source', () => scratch(root => {
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'scripts/load/usage'), { recursive: true }); writeFileSync(join(repo, 'scripts/load/usage/tool.mjs'), 'export const value=1;\n');
  writeFileSync(join(repo, 'scripts/verify-legacy-deploy-image.mjs'), 'export const scanner=1;\n'); writeFileSync(join(repo, 'scripts/release-source-binding.mjs'), 'export const binding=1;\n');
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '--quiet']); git(['config', 'user.name', 'Synthetic Fixture']); git(['config', 'user.email', 'synthetic@example.test']); git(['config', 'core.autocrlf', 'false']);
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic initial source']);
  const binding = { directory: repo, source: git(['rev-parse', 'HEAD']), files: acceptanceHarnessInventory(repo), dependencies: acceptanceToolDependencies(repo) }; assert.equal(assertFrozenAcceptanceHarness(binding), true);
  writeFileSync(join(repo, 'scripts/load/usage/tool.mjs'), 'export const value=2;\n'); assert.throws(() => assertFrozenAcceptanceHarness(binding));
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic moved source']); assert.throws(() => assertFrozenAcceptanceHarness(binding));
  assert.throws(() => assertFrozenAcceptanceHarness({ ...binding, source: git(['rev-parse', 'HEAD']) }));
  assert.equal(assertFrozenAcceptanceHarness({ directory: repo, source: git(['rev-parse', 'HEAD']), files: acceptanceHarnessInventory(repo), dependencies: acceptanceToolDependencies(repo) }), true);
}));
test('real Git application inventories prove tooling-only equivalence and reject source changes and dirty sources', () => scratch(async root => {
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'scripts/load/usage'), { recursive: true }); mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'schoolpilot-app'));
  writeFileSync(join(repo, 'src/application.mjs'), 'export const application=1;\n'); writeFileSync(join(repo, 'schoolpilot-app/index.html'), '<p>synthetic fixture</p>\n');
  writeFileSync(join(repo, 'scripts/load/usage/tool.mjs'), 'export const tool=1;\n');
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const run = async (command, args) => ({ code: 0, stdout: execFileSync(command, args, { encoding: 'utf8', windowsHide: true }), stderr: '' });
  git(['init', '--quiet']); git(['config', 'user.name', 'Synthetic Fixture']); git(['config', 'user.email', 'synthetic@example.test']); git(['config', 'core.autocrlf', 'false']);
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic application reference']); const original = git(['rev-parse', 'HEAD']);
  const backend = await imageInputInventory(repo, original, run), frontend = await frontendInputInventory(repo, original, run);
  assert.equal(assertFrozenAcceptanceSource({ sourceDirectory: repo, source: original }), true);
  writeFileSync(join(repo, 'src/application.mjs'), 'export const application=2;\n'); assert.throws(() => assertFrozenAcceptanceSource({ sourceDirectory: repo, source: original }));
  git(['restore', '--', 'src/application.mjs']); writeFileSync(join(repo, 'scripts/load/usage/tool.mjs'), 'export const tool=2;\n');
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic tooling-only change']); const tooling = git(['rev-parse', 'HEAD']);
  assert.deepEqual(await imageInputInventory(repo, tooling, run), backend); assert.deepEqual(await frontendInputInventory(repo, tooling, run), frontend);
  assert.throws(() => assertFrozenAcceptanceSource({ sourceDirectory: repo, source: original }));
  writeFileSync(join(repo, 'src/application.mjs'), 'export const application=2;\n'); git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic application change']);
  assert.notDeepEqual(await imageInputInventory(repo, git(['rev-parse', 'HEAD']), run), backend);
}));
test('a current-source wrapper cannot relabel stale or fallback-role native processing results', () => scratch(root => {
  const binding = { ...identity(), candidate: { ...ACCEPTANCE_CANDIDATE_IDENTITIES } };
  const names = ['linux-amd64-musl-and-exact-production-dependencies', 'native-synthetic-screenshot-jpeg-png-resize', 'actual-private-image-normalization-and-metadata-removal',
    'actual-private-pdf-inspection-and-preserved-document-bytes', 'actual-private-pdf-rendering-and-color-continuity', 'private-pdf-invalid-encrypted-and-over-page-limit-rejection',
    'express-proxy-depth-selection-and-spoofed-extra-hop-boundary', 'actual-auth-rate-limiter-ipv6-grouping-and-independent-client-boundary', 'actual-api-rate-limiter-verified-staff-and-invalid-token-identity'];
  const result = { kind: 'release297_successor_native_processing_result', source: ACCEPTANCE_CANDIDATE, image: binding.candidate.image, artifactRole: 'serving-anchor', passed: true,
    syntheticFixturesOnly: true, providerRequests: 0, productionMutations: 0, networkIsolation: 'none', checks: names.map(name => ({ name, passed: true })),
    startedAt: '2026-10-08T15:10:00Z', completedAt: '2026-10-08T15:15:00Z', cleanup: { localHttpServersClosed: true, dbQueries: 0, remainingDatabaseConnections: 0, privateTempDirectoriesRemoved: true } };
  const inspect = { Id: binding.candidate.image, Config: { Labels: { 'org.opencontainers.image.revision': ACCEPTANCE_CANDIDATE } } };
  const nativeResult = writePin(root, 'native.json', result), imageInspect = writePin(root, 'inspect.json', inspect);
  const executionValue = { kind: 'release297_successor_independent_native_execution', source: ACCEPTANCE_CANDIDATE, image: binding.candidate.image, artifactRole: 'serving-anchor', passed: true,
    startedAt: '2026-10-08T15:05:00Z', completedAt: '2026-10-08T15:20:00Z', syntheticFixturesOnly: true, providerRequests: 0, productionMutations: 0, resultSha256: nativeResult.sha256, resources: { network: 'none', readonlyRoot: true },
    cleanup: { forced: false, containerAbsent: true, exactOwned: true, complete: true }, exit: { attachCode: 0, daemonExitCode: 0, running: false, oomKilled: false } };
  const execution = writePin(root, 'execution.json', executionValue), proof = { nativeResult, imageInspect, execution, completedAt: '2026-10-08T15:25:00Z' };
  assert.equal(assertNativeSuccessorPreparation(proof, binding), true);
  assert.equal(assertNativeSuccessorPreparation({ ...proof, imageInspect: writePin(root, 'array-inspect.json', [inspect]) }, binding), true);
  assert.throws(() => assertNativeSuccessorPreparation({ ...proof, imageInspect: writePin(root, 'mixed-inspect.json', [inspect, inspect]) }, binding));
  for (const change of [row => row.source = ACCEPTANCE_BASELINE, row => row.image = ACCEPTANCE_FALLBACK_IDENTITIES.image, row => row.artifactRole = 'fallback', row => row.checks = [], row => row.checks[0].passed = false,
    row => row.cleanup.remainingDatabaseConnections = 1, row => row.providerRequests = 1, row => row.startedAt = '2026-10-07T15:10:00Z', row => row.completedAt = '2026-10-08T15:21:00Z']) {
    const stale = structuredClone(result); change(stale); const altered = writePin(root, 'stale-native.json', stale); assert.throws(() => assertNativeSuccessorPreparation({ ...proof, nativeResult: altered }, binding));
  }
  for (const change of [row => row.source = ACCEPTANCE_BASELINE, row => row.cleanup.forced = true, row => row.exit.oomKilled = true, row => row.resultSha256 = digest, row => row.startedAt = '2026-10-07T15:05:00Z', row => row.completedAt = '2026-10-08T15:30:00Z']) {
    const altered = structuredClone(executionValue); change(altered); assert.throws(() => assertNativeSuccessorPreparation({ ...proof, execution: writePin(root, 'bad-execution.json', altered) }, binding));
  }
}));
test('actual recovery artifact pair, source phases and raw native evidence prevent old-pair relabeling', () => scratch(root => {
  const binding = { ...identity(), candidate: { ...ACCEPTANCE_CANDIDATE_IDENTITIES, sourceDirectory: join(root, 'candidate-source') }, fallback: { ...ACCEPTANCE_FALLBACK_IDENTITIES }, harness: { directory: join(root, 'harness-source') } };
  const retained = join(root, 'retained'); mkdirSync(retained); const raw = writePin(retained, 'raw.json', { syntheticNativeData: true });
  const pair = { 'serving-anchor': { source: binding.candidate.source, localIndex: binding.candidate.image, config: binding.candidate.config, platform: binding.candidate.platform, archiveSha256: binding.candidate.archiveSha256 },
    fallback: { source: binding.fallback.source, localIndex: binding.fallback.image, config: binding.fallback.config, platform: binding.fallback.platform, archiveSha256: binding.fallback.archiveSha256 } };
  const migrationValue = { kind: 'release_migration_role_independent_review', observedAtUtc: '2026-10-08T15:30:00Z', passed: true, artifactPair: pair,
    verified: { migrationConnectionRole: { superuser: false, bypassRls: false, inherit: false, schemaOwner: true, schemaUsageAndCreate: true }, actualVersionedMigrationExecutions: 8, ordinary43to53AndFallbackRetains53: true, zeroNamedMigrationSqlConnections: true },
    rawEvidence: [{ storage: 'private', path: 'raw.json', sha256: raw.sha256 }] };
  const migrationProof = writePin(retained, 'migrationRole.review.json', migrationValue), restrictedMigrationEvidence = { storage: 'private', path: 'migrationRole.review.json', sha256: migrationProof.sha256, format: 'json' };
  const nativeValue = { kind: 'release_successor_native_result', evidenceKind: 'ordinaryRecovery', passed: true, artifactPair: pair, observedAtUtc: '2026-10-08T15:35:00Z', restrictedMigrationEvidence,
    rawEvidence: [{ storage: 'private', path: 'raw.json', sha256: raw.sha256, format: 'json' }, restrictedMigrationEvidence],
    checks: Object.fromEntries(['restrictedRoleVerified', 'retainedScreenshotFunctionBodyAndAcl', 'privateChatHistoryAndFencesPreserved', 'exactFocusCleanupPassed', 'capabilityEqualityPassed', 'privateChatCompatibilityFloorsPassed', 'allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections'].map(key => [key, true])),
    recovery: { baselineMigrations: 43, candidateMigrations: 53, fallbackDeclaredMigrations: 52, retainedCompletedMigrations: 53, admissionCounts: [121, 125, 126, 127, 128, 129],
      phases: ['baseline43', 'candidate53-dark128', 'candidate53-adopt129', 'fallback-retains53', 'candidate-return53'], sequence: [binding.candidate.source, binding.fallback.source, binding.candidate.source] },
    actualApiWorkerProcesses: 8, gracefulDrains: 8, migration: { role: { rolsuper: false, rolbypassrls: false }, baselineMigrations: 43, ordinaryPath: true, completedMigrations: 53 } };
  const nativeResult = writePin(root, 'native-recovery.json', nativeValue);
  const review = { kind: 'release_successor_independent_review', evidenceKind: 'ordinaryRecovery', passed: true, artifactPair: pair, nativeResultSha256: nativeResult.sha256,
    observedAtUtc: '2026-10-08T15:40:00Z', fullIndependentReviewComplete: true, independentFromProducer: true, rawEvidenceSha256s: [raw.sha256, migrationProof.sha256] };
  const independentReview = writePin(root, 'review.json', review);
  const services = ['bridge128', 'adopt129', 'fallback129', 'return129'].flatMap(phase => ['api', 'worker'].map(service => {
    const role = phase === 'fallback129' ? binding.fallback : binding.candidate;
    return { phase, service, containerId: phase + '-' + service, source: role.source, image: role.image, runtimeImage: role.image, inventoryCount: phase === 'bridge128' ? 128 : 129 };
  }));
  const executionValue = { source: binding.candidate.source, passed: true, productionMutations: 0, startedAt: '2026-10-08T15:05:00Z', completedAt: '2026-10-08T15:25:00Z', cleanupPassed: true, gracefulCleanupPassed: true, networkCleanupPassed: true, completedInsideAuthorizedWindow: true,
    actualApiWorkerProcesses: true, services, drains: services.map(row => ({ phase: row.phase, service: row.service, containerId: row.containerId, sourceImage: row.image, exitCode: 0, oomKilled: false, sqlConnections: 0, forced: false })),
    sourceSpecificNative: { baseline: { source: ACCEPTANCE_BASELINE, applicationImage: ACCEPTANCE_BASELINE_IMAGE, passed: true, nativeCompletedMigrations: migrations(43) }, candidate: { source: binding.candidate.source, applicationImage: binding.candidate.image, passed: true, nativeCompletedMigrations: migrations(53) } },
    cleanup: [{ graceful: true, removed: true, forced: false, exitCode: 0, oomKilled: false }] };
  const execution = writePin(root, 'recovery-execution.json', executionValue), proof = { nativeResult, independentReview, execution, retainedEvidenceDirectory: retained, completedAt: '2026-10-08T15:45:00Z' };
  assert.equal(assertOrdinarySuccessorRecovery(proof, binding), true);
  for (const change of [row => row.artifactPair['serving-anchor'].source = ACCEPTANCE_BASELINE, row => row.recovery.candidateMigrations = 54, row => row.recovery.retainedCompletedMigrations = 54,
    row => row.recovery.sequence[0] = ACCEPTANCE_BASELINE, row => row.checks.capabilityEqualityPassed = false, row => row.migration.role.rolbypassrls = true]) {
    const altered = structuredClone(nativeValue); change(altered); assert.throws(() => assertOrdinarySuccessorRecovery({ ...proof, nativeResult: writePin(root, 'old-pair.json', altered) }, binding));
  }
  for (const change of [row => row.source = ACCEPTANCE_BASELINE, row => row.services[0].source = ACCEPTANCE_BASELINE, row => row.services[0].runtimeImage = binding.fallback.image,
    row => row.drains[0].sqlConnections = 1, row => row.drains[0].forced = true, row => row.cleanup[0].oomKilled = true, row => row.actualApiWorkerProcesses = 8,
    row => row.services[0].containerId = row.services[1].containerId, row => row.drains[0].service = 'worker', row => row.sourceSpecificNative.candidate.nativeCompletedMigrations.push(migrations(54)[53]),
    row => row.startedAt = '2026-10-07T15:05:00Z', row => row.completedAt = '2026-10-08T15:50:00Z']) {
    const altered = structuredClone(executionValue); change(altered); assert.throws(() => assertOrdinarySuccessorRecovery({ ...proof, execution: writePin(root, 'bad-recovery-execution.json', altered) }, binding));
  }
  for (const change of [row => row.observedAtUtc = '2026-10-07T15:40:00Z', row => row.observedAtUtc = '2026-10-08T15:50:00Z']) {
    const altered = structuredClone(review); change(altered); assert.throws(() => assertOrdinarySuccessorRecovery({ ...proof, independentReview: writePin(root, 'stale-review.json', altered) }, binding));
  }
  const staleMigration = { ...migrationValue, observedAtUtc: '2026-10-07T15:30:00Z' }, staleMigrationPin = writePin(retained, 'stale-migration-review.json', staleMigration);
  const staleReference = { storage: 'private', path: 'stale-migration-review.json', sha256: staleMigrationPin.sha256, format: 'json' };
  const rewrappedNative = writePin(root, 'rewrapped-native.json', { ...nativeValue, restrictedMigrationEvidence: staleReference, rawEvidence: [nativeValue.rawEvidence[0], staleReference] });
  const rewrappedReview = writePin(root, 'rewrapped-review.json', { ...review, nativeResultSha256: rewrappedNative.sha256, rawEvidenceSha256s: [raw.sha256, staleMigrationPin.sha256] });
  assert.throws(() => assertOrdinarySuccessorRecovery({ ...proof, nativeResult: rewrappedNative, independentReview: rewrappedReview }, binding));
  writeFileSync(raw.file, '{}'); assert.throws(() => assertOrdinarySuccessorRecovery(proof, binding));
}));
test('successor mixed acceptance requires three distinct chronological attempts from the same campaign', () => {
  const binding = identity(), completedAt = '2026-10-08T15:55:00Z';
  const records = [0, 1, 2].map(index => ({ run: index.toString().padStart(12, '0'), verifiedReceiptManifestSha256: String(index + 1).repeat(64), reservationSha256: String(index + 4).repeat(64), campaignContractSha256: digest,
    startedAt: `2026-10-08T15:${String(index * 16).padStart(2, '0')}:00Z`, finishedAt: `2026-10-08T15:${String(index * 16 + 15).padStart(2, '0')}:00Z` }));
  assert.equal(assertSuccessorMixedSequence(records, binding, completedAt), true);
  assert.throws(() => assertSuccessorMixedSequence([records[0], records[0], records[0]], binding, completedAt));
  for (const change of [rows => rows[1].run = rows[0].run, rows => rows[1].verifiedReceiptManifestSha256 = rows[0].verifiedReceiptManifestSha256,
    rows => rows[1].reservationSha256 = rows[0].reservationSha256, rows => rows[1].campaignContractSha256 = 'b'.repeat(64), rows => rows[1].startedAt = '2026-10-08T15:14:00Z',
    rows => rows.reverse(), rows => rows[0].startedAt = '2026-10-07T15:00:00Z', rows => rows[2].finishedAt = '2026-10-08T15:56:00Z', rows => rows.pop()]) {
    const altered = structuredClone(records); change(altered); assert.throws(() => assertSuccessorMixedSequence(altered, binding, completedAt));
  }
});
test('empty normal checks and self-asserted mixed summaries cannot establish lower-load prerequisites', () => scratch(root => {
  const successor = { binding: { candidate: { source: ACCEPTANCE_CANDIDATE, image: candidateImage } }, input: { sha256: digest } };
  const classroom = writePin(root, 'classroom.json', { source: ACCEPTANCE_CANDIDATE, applicationImage: candidateImage, syntheticAcceptancePassed: true, profile: PROFILES.classroomNative.name,
    profileSha256: profileHash(PROFILES.classroomNative), offered: 2040, succeeded: 2040, allRoundChecks: {}, runs: [] });
  assert.throws(() => assertLowerSafetyPrerequisites([{ ...classroom, kind: 'classroom' }, { kind: 'mixed' }, { kind: 'recovery' }], successor));
  const mixed = writePin(root, 'mixed.json', { source: ACCEPTANCE_CANDIDATE, applicationImage: candidateImage, passed: true, currentSchoolOnly: true, profile: PROFILES.mixedNative.name,
    profileSha256: profileHash(PROFILES.mixedNative), aggregate: { passed: true }, runs: [{}, {}, {}] });
  assert.throws(() => assertLowerSafetyPrerequisites([{ ...mixed, kind: 'mixed' }, { kind: 'classroom' }, { kind: 'recovery' }], successor));
}));
test('ordinary53 and historical54 ledgers cannot substitute for each other', () => {
  assert.equal(assertLowerMigrationVector(migrations(53), migrations(53), 53), true);
  assert.equal(assertLowerMigrationVector(migrations(54), migrations(54), 54), true);
  assert.throws(() => assertLowerMigrationVector(migrations(54), migrations(54), 53)); assert.throws(() => assertLowerMigrationVector(migrations(53), migrations(53), 54));
  assert.throws(() => assertLowerPostRls(native(53), native(53))); assert.equal(assertLowerPostRls(native(54), native(54)), true);
  for (const change of [rows => rows[1].id = rows[0].id, rows => rows[1].checksum = 'bad', rows => rows[1].status = 'failed']) { const rows = migrations(53); change(rows); assert.throws(() => assertLowerMigrationVector(rows, rows, 53)); }
});
test('only the approved baseline latency exception continues; candidate and safety failures stop', () => {
  const { records } = pairFixture(); assert.equal(fixedSuccessorDisposition(records[0]).baselineAbsoluteLatencyException, true); assert.equal(fixedSuccessorDisposition(records[3]).originalRunPassed, true);
  for (const change of [row => row.cleanupPassed = false, row => row.sourceUnchanged = false, row => row.hostHarnessSourceUnchanged = false, row => row.errorCoverage[0].errorCount = 1,
    row => row.rounds[0].traffic.failed = 1, row => row.rounds[0].invalidBindings = 1, row => row.rounds[0].drains[0].complete = false]) {
    const row = structuredClone(records[0]); change(row); row.rounds[0].acceptance = validateRound(row.rounds[0], PROFILES.sole, { baseline: true }); assert.throws(() => fixedSuccessorDisposition(row));
  }
  const candidate = structuredClone(records[3]); candidate.rounds[0].traffic.timings.p95Ms = 501; candidate.rounds[0].acceptance = validateRound(candidate.rounds[0], PROFILES.sole); candidate.runPassed = false; candidate.failure = 'V2_NUMERICAL_ACCEPTANCE_FAILED';
  assert.throws(() => fixedSuccessorDisposition(candidate));
});
test('approved bounded policy evaluates all five baselines and all three candidates without relabeling failures', () => {
  const { records, successor } = pairFixture(), before = JSON.stringify(records); const result = evaluateApprovedCurrentSchool(records, successor);
  assert.equal(result.passed, true); assert.equal(result.strictComparisonReclassified, false); assert.equal(result.releaseReady, false); assert.equal(JSON.stringify(records), before);
  const noisy = structuredClone(records); noisy[1].cpuMsPer200 = 10.6; noisy[1].wholeOwnedApiCpuMicroseconds = 10.6 * 1000 * 798;
  assert.equal(evaluateApprovedCurrentSchool(noisy, successor).passed, false);
  const allRuns = structuredClone(records); allRuns[6].cpuMsPer200 = 4; allRuns[6].wholeOwnedApiCpuMicroseconds = 4 * 1000 * 798;
  assert.equal(evaluateApprovedCurrentSchool(allRuns, successor).checks.conservativeAllRunsCpu, false);
  for (const change of [rows => rows[3].source = ACCEPTANCE_BASELINE, rows => rows[3].applicationImage = ACCEPTANCE_BASELINE_IMAGE, rows => rows[3].acceptanceSuccessor.sha256 = digest, rows => rows[1].arm = 'B', rows => rows[1].run = rows[0].run]) {
    const altered = structuredClone(records); change(altered); assert.throws(() => evaluateApprovedCurrentSchool(altered, successor));
  }
});
test('whole attempt reserve cannot be replaced by a short or expired window', () => {
  const window = { startsAt: new Date(date - 1).toISOString(), expiresAt: new Date(date + 1_200_000).toISOString() };
  assert.equal(assertWholeSuccessorAttempt(window, PROFILES.mixedNative, date), true);
  assert.throws(() => assertWholeSuccessorAttempt({ ...window, expiresAt: new Date(date + 1_199_999).toISOString() }, PROFILES.mixedNative, date));
  assert.throws(() => assertWholeSuccessorAttempt({ ...window, startsAt: new Date(date + 1).toISOString() }, PROFILES.sole, date));
});
test('incomplete and unknown successor preparations reject before any Docker or output mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'schoolpilot-successor-no-mutation-'));
  try {
    const binding = identity(); binding.id = 'unknown'; const pin = writePin(root, 'binding.json', binding), outputDirectory = join(root, 'must-not-exist');
    assert.throws(() => validateAcceptanceSuccessor(pin, { at: date }));
    await assert.rejects(runV2({ profile: PROFILES.sole.name, outputDirectory, privateDirectory: join(root, 'private'), acceptanceSuccessor: pin, docker: join(root, 'must-not-execute') }));
    const request = writePin(root, 'request.json', { block: 'fixed133', binding: pin, outputDirectory }); await assert.rejects(executeSuccessorBlock(request));
    assert.equal(existsSync(outputDirectory), false); assert.equal(existsSync(join(root, 'private')), false);
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))); rmSync(root, { recursive: true, force: true }); }
});
test('fresh exact-F High failure rejects before Git, Docker and output creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'schoolpilot-successor-failed-F-'));
  try {
    const now = Date.now(), binding = identity(); binding.recordedAt = new Date(now - 30_000).toISOString(); binding.evidenceNotBefore = new Date(now - 90_000).toISOString();
    binding.validity = { startsAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 86400_000).toISOString() };
    const failed = writePin(root, 'failed-F.json', { kind: 'exact_artifact_security_scan', source: binding.fallback.source, applicationImage: binding.fallback.image,
      config: binding.fallback.config, platform: binding.fallback.platform, completed: true, high: 1, critical: 0 });
    binding.securityScans = { fallback: failed }; const pin = writePin(root, 'binding.json', binding), outputDirectory = join(root, 'must-not-exist');
    assert.throws(() => validateAcceptanceSuccessor(pin), /1 !== 0/);
    await assert.rejects(runV2({ profile: PROFILES.sole.name, outputDirectory, privateDirectory: join(root, 'private'), acceptanceSuccessor: pin, docker: join(root, 'must-not-execute') }), /1 !== 0/);
    assert.equal(existsSync(outputDirectory), false); assert.equal(existsSync(join(root, 'private')), false);
  } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))); rmSync(root, { recursive: true, force: true }); }
});
