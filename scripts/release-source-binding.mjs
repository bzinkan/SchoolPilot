// Reviewed source/evidence bindings for the artifact-only controllers. No cloud I/O.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { SCANNER, scanCounts } from './verify-legacy-deploy-image.mjs';

export const IMAGE_INPUTS = Object.freeze(['src', 'package*.json', 'tsconfig.json', 'drizzle.config.ts', 'Dockerfile', '.dockerignore', 'config', 'docs/soc2']);
export const FRONTEND_INPUTS = Object.freeze(['schoolpilot-app']);
export const EXTENSION_IDENTITY = Object.freeze({ version: '2.9.7', id: 'iggbfegfcjkfieoemeolfmfnapepalca', source: '065be165b5df704d84eb716e3fb914c1fed17f98', mergedSource: '03a9c3633d1e1f7d763ea5cf910f870994400e02', tree: 'f7a3174e5631dcad9d02eb2357b245c5d2df714f', zipSha256: '82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575', zipBytes: 376052 });
export const POLICY_REFERENCE = Object.freeze({ path: 'docs/release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json', sha256: '965328a337fe35eaa505610ade00633075f7014fab610da8a869f6b514688f95' });
export const FALLBACK_FAILED_SCAN_AT = '2026-10-07T17:32:59.633Z';
export const BINDING_FILES = Object.freeze({ 'release-297-current-school-v2': 'docs/release-bindings/release-297-current-school-v2.json' });
export const REQUIRED_EVIDENCE = Object.freeze(['currentSchoolAcceptance', 'classroomAcceptance', 'normalLoadAcceptance', 'headroomAcceptance', 'ordinaryRecovery', 'restrictedRestoration', 'screenshotRuntime']);
const sha = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
export const bindingHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(sort(value))).digest('hex');
export const publicReceiptHash = bytes => bindingHash(bytes.toString('utf8').replaceAll('\r\n', '\n'));
const equal = (actual, expected, code) => assert.deepEqual(actual, expected, code);
const fallbackIdentity = fallback => Object.fromEntries(['source', 'localIndex', 'config', 'platform'].map(key => [key, fallback[key]]));

export function bindingSchema(input) {
  assert.ok(input?.schemaVersion === 1 || input?.schemaVersion === 2, 'BINDING_SCHEMA_UNSUPPORTED');
  if (input.schemaVersion === 1) assert.ok(input.releaseBindingId === undefined, 'LEGACY_BINDING_OVERRIDE_FORBIDDEN');
  else {
    assert.ok(Object.hasOwn(BINDING_FILES, input.releaseBindingId), 'RELEASE_BINDING_NOT_ALLOWLISTED');
    assert.ok(input.artifactSource === undefined, 'CALLER_ARTIFACT_SOURCE_FORBIDDEN');
  }
  return input.schemaVersion;
}

export function validateBindingProfile(profile, id, fallback) {
  equal([profile.schemaVersion, profile.kind, profile.id], [2, 'reviewed_release_source_binding', id], 'BINDING_IDENTITY_INVALID');
  assert.match(profile.applicationSource ?? '', sha, 'BINDING_APPLICATION_SOURCE_REQUIRED');
  equal(profile.imageInputs, IMAGE_INPUTS, 'BINDING_INPUT_SCOPE_CHANGED');
  equal(profile.frontendInputs, FRONTEND_INPUTS, 'BINDING_FRONTEND_SCOPE_CHANGED');
  equal(profile.extension, EXTENSION_IDENTITY, 'BINDING_EXTENSION_CHANGED');
  equal(profile.policy, POLICY_REFERENCE, 'BINDING_APPROVED_POLICY_CHANGED');
  assert.match(profile.inventory?.sha256 ?? '', hashPattern, 'BINDING_INVENTORY_REQUIRED');
  assert.ok(Number.isSafeInteger(profile.inventory.fileCount) && profile.inventory.fileCount > 0, 'BINDING_INVENTORY_REQUIRED');
  assert.match(profile.frontendInventory?.sha256 ?? '', hashPattern, 'BINDING_FRONTEND_INVENTORY_REQUIRED');
  assert.ok(Number.isSafeInteger(profile.frontendInventory.fileCount) && profile.frontendInventory.fileCount > 0, 'BINDING_FRONTEND_INVENTORY_REQUIRED');
  equal(profile.fallback, fallbackIdentity(fallback), 'BINDING_FALLBACK_CHANGED');
  equal(profile.schema, { staffIdentityContract: 'deferred', baselineMigrations: 43, candidateMigrations: 53, fallbackDeclaredMigrations: 52, retainedCompletedMigrations: 53, admissionCounts: [121, 125, 126, 127, 128, 129] }, 'BINDING_SCHEMA_CHANGED');
  equal(profile.scope, { school: 'St. Francis DeSales', clients: 133, usageRollupMode: 'off', digitalUsageMode: 'off', managedChromebookGate: 'waived_not_passed', liveAcceptanceMinutes: 30 }, 'BINDING_SCOPE_CHANGED');
  equal(profile.operationalAuthorization, false, 'BINDING_IS_NOT_AUTHORIZATION');
  equal(Object.keys(profile.evidence ?? {}).sort(), [...REQUIRED_EVIDENCE].sort(), 'BINDING_EVIDENCE_SET_CHANGED');
  assert.ok(profile.status === 'accepted' && REQUIRED_EVIDENCE.every(key => profile.evidence[key]?.status === 'passed'), 'RELEASE_BINDING_EVIDENCE_PENDING');
  equal(profile.blockers, [], 'RELEASE_BINDING_BLOCKED');
  equal(profile.sourceStatus, 'frozen-and-native-tested', 'RELEASE_BINDING_SOURCE_NOT_FROZEN');
  assert.match(profile.testedApplicationImage ?? '', /^sha256:[a-f0-9]{64}$/, 'BINDING_TESTED_IMAGE_REQUIRED');
  assert.match(profile.testedApplicationConfig ?? '', /^sha256:[a-f0-9]{64}$/, 'BINDING_TESTED_CONFIG_REQUIRED');
  equal(profile.fallbackScan?.status, 'passed', 'BINDING_FRESH_FALLBACK_SCAN_REQUIRED');
  assert.equal(profile.sourceApplicability?.status, 'approved', 'RELEASE_BINDING_SOURCE_APPLICABILITY_PENDING');
  for (const record of [profile.policy, profile.sourceApplicability, ...REQUIRED_EVIDENCE.map(key => profile.evidence[key])]) {
    assert.ok(typeof record?.path === 'string' && /^docs\/release-evidence\/[A-Za-z0-9_./-]+\.json$/.test(record.path) && !record.path.split('/').includes('..'), 'BINDING_EVIDENCE_PATH_INVALID');
    assert.match(record.sha256 ?? '', hashPattern, 'BINDING_EVIDENCE_HASH_REQUIRED');
  }
}

async function git(run, directory, args) {
  const result = await run('git', ['-C', directory, ...args]);
  assert.equal(result.code, 0, 'BINDING_GIT_FAILED');
  return result.stdout;
}

// Hash Git objects, modes and paths, not checkout bytes (Windows CRLF is irrelevant).
export async function imageInputInventory(directory, source, run) {
  return gitInventory(directory, source, run, IMAGE_INPUTS);
}
export async function frontendInputInventory(directory, source, run) {
  return gitInventory(directory, source, run, FRONTEND_INPUTS);
}
async function gitInventory(directory, source, run, inputs) {
  assert.match(source ?? '', sha, 'BINDING_FULL_SOURCE_REQUIRED');
  const raw = await git(run, directory, ['ls-tree', '-r', '-z', source]);
  const entries = raw.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|commit|tree) ([a-f0-9]{40})\t([^\0]+)$/.exec(line);
    assert.ok(match, 'BINDING_GIT_TREE_INVALID');
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  }).filter(entry => inputs.some(input => input === 'package*.json' ? /^package[^/]*\.json$/.test(entry.path) : entry.path === input || entry.path.startsWith(input + '/'))).map(entry => {
    const match = entry.type === 'blob' && ['100644', '100755'].includes(entry.mode);
    assert.ok(match, 'BINDING_NON_ORDINARY_GIT_INPUT');
    return { mode: entry.mode, object: entry.object, path: entry.path };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.ok(entries.length > 0, 'BINDING_EMPTY_INVENTORY');
  return { sha256: bindingHash(entries), fileCount: entries.length };
}

function ordinaryText(root, relative, normalize = true) {
  const filename = path.resolve(root, relative), base = path.resolve(root) + path.sep;
  assert.ok(filename.startsWith(base), 'BINDING_PATH_ESCAPE');
  for (let current = filename; ; current = path.dirname(current)) {
    assert.ok(!lstatSync(current).isSymbolicLink(), 'BINDING_REPARSE_PATH');
    if (current === path.dirname(current)) break;
  }
  assert.ok(lstatSync(filename).isFile(), 'BINDING_FILE_REQUIRED');
  const raw = readFileSync(filename, 'utf8');
  return normalize ? raw.replaceAll('\r\n', '\n') : raw;
}

async function committedJson(root, relative, run) {
  const local = ordinaryText(root, relative);
  const committed = (await git(run, root, ['show', `HEAD:${relative}`])).replaceAll('\r\n', '\n');
  equal(local, committed, 'BINDING_UNCOMMITTED_BYTES');
  return { value: JSON.parse(local), sha256: publicReceiptHash(committed) };
}

export function validateOrdinaryRecovery(stage, profile, fallback) {
  equal([stage.schemaVersion, stage.kind, stage.applicationSource, stage.inventorySha256], [1, 'release_binding_ordinary_recovery', profile.applicationSource, profile.inventory.sha256], 'BINDING_RECOVERY_IDENTITY_CHANGED');
  equal(stage.fallbackSource, fallback.source, 'BINDING_RECOVERY_FALLBACK_CHANGED');
  equal(stage.schema, profile.schema, 'BINDING_RECOVERY_SCHEMA_CHANGED');
  equal(stage.phases, ['baseline43', 'candidate53-dark128', 'candidate53-adopt129', 'fallback-retains53', 'candidate-return53'], 'BINDING_RECOVERY_PHASES_CHANGED');
  for (const key of ['passed', 'restrictedRoleVerified', 'retainedScreenshotFunctionBodyAndAcl', 'privateChatHistoryAndFencesPreserved', 'exactFocusCleanupPassed', 'allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections']) assert.equal(stage[key], true, 'BINDING_RECOVERY_NOT_ACCEPTED');
}

function evidenceIdentity(value, profile, key) {
  equal([value.releaseBindingId, value.evidenceKind, value.applicationSource, value.inventorySha256, value.frontendInventorySha256, value.policySha256, value.extension, value.schema, value.scope], [profile.id, key, profile.applicationSource, profile.inventory.sha256, profile.frontendInventory.sha256, profile.policy.sha256, profile.extension, profile.schema, profile.scope], 'BINDING_NATIVE_IDENTITY_CHANGED');
}

export const CAMPAIGN_TOPOLOGY = Object.freeze({
  currentSchoolAcceptance: { arms: ['A', 'A', 'A', 'B', 'B', 'A', 'A', 'B'], clients: 133, durationMs: 60000, offered: 798 },
  classroomAcceptance: { arms: ['B', 'B', 'B'], clients: 133, durationMs: 900000, offered: 12103 },
  normalLoadAcceptance: { arms: ['B'], clients: 340, durationMs: 60000, offered: 2040 },
  headroomAcceptance: { arms: ['B', 'B', 'B'], clients: 250, durationMs: 60000, offered: 1500 },
});

function validateCampaignRuns(key, runs, profile) {
  const topology = CAMPAIGN_TOPOLOGY[key];
  if (!topology) return;
  equal(runs.map(value => value.arm), topology.arms, 'BINDING_CAMPAIGN_ORDER_CHANGED');
  let previousEnd = -Infinity;
  for (const [index, value] of runs.entries()) {
    equal([value.index, value.clients, value.measuredWindowMs, value.offered, value.succeeded, value.persisted], [index + 1, topology.clients, topology.durationMs, topology.offered, topology.offered, topology.offered], 'BINDING_CAMPAIGN_DIMENSIONS_CHANGED');
    for (const field of ['failed', 'refused', 'lateOffers', 'invalidBindings', 'outstandingAfterDrain']) equal(value[field], 0, 'BINDING_CAMPAIGN_ERRORS');
    assert.ok(Number.isFinite(value.startedAtMs) && Number.isFinite(value.finishedAtMs) && value.startedAtMs >= previousEnd && value.finishedAtMs - value.startedAtMs >= topology.durationMs, 'BINDING_CAMPAIGN_WINDOW_INVALID');
    previousEnd = value.finishedAtMs;
    const baseline = value.arm === 'A';
    equal([value.measuredSource, value.migrations, value.forcedRlsTables], [baseline ? '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678' : profile.applicationSource, baseline ? 43 : 53, baseline ? 121 : 129], 'BINDING_CAMPAIGN_SCHEMA_CHANGED');
    equal(value.measuredImage, baseline ? 'sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8' : profile.testedApplicationImage, 'BINDING_CAMPAIGN_IMAGE_CHANGED');
    assert.equal(typeof value.absolutePassed, 'boolean', 'BINDING_ABSOLUTE_RESULT_REQUIRED');
    // The amended gate explicitly permits baseline absolute-latency failures.
    if (!baseline) assert.equal(value.absolutePassed, true, 'BINDING_CANDIDATE_ABSOLUTE_FAILED');
    if (key === 'classroomAcceptance') equal([value.rounds, value.ordinaryOffered, value.reconnectOffered], [15, 11970, 133], 'BINDING_CLASSROOM_ROUNDS_CHANGED');
    if (key === 'headroomAcceptance') equal(value.headroomPassed, true, 'BINDING_HEADROOM_FAILED');
  }
}

// These are fresh native runner receipt requirements, not an adapter that relabels
// historical DDC summaries. Native runners and independent review must emit them.
export const NATIVE_CHECKS = Object.freeze({
  currentSchoolAcceptance: ['boundedCriteriaPassed', 'allEightSafetyPassed', 'allEightCleanupPassed', 'allOwnedExit0NoOomUnforced'],
  classroomAcceptance: ['allClassroomRoundsPassed', 'exactTargetAuthorityPassed', 'privateHistoryAndFencesPreserved', 'exactFocusCleanupPassed', 'allOwnedExit0NoOomUnforced'],
  normalLoadAcceptance: ['syntheticAcceptancePassed', 'completeErrorCoverage', 'nativeClassroomPassed', 'cleanupPassed'],
  headroomAcceptance: ['threeFresh250HeadroomPasses', 'nativeRlsAndExactTuplesReplayed', 'unforcedOwnedCleanup'],
  ordinaryRecovery: ['restrictedRoleVerified', 'retainedScreenshotFunctionBodyAndAcl', 'privateChatHistoryAndFencesPreserved', 'exactFocusCleanupPassed', 'allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections'],
  restrictedRestoration: ['nativeRestoreAccepted', 'schemaSerializationContinuity', 'actualServicePairsReplayed', 'exit0NoOomUnforced'],
  screenshotRuntime: ['runtimeExecutionPassed', 'zeroHighCriticalRuntimeVulnerabilities', 'exactImageAndProductionDependenciesVerified', 'cleanupPassed'],
});

async function retainedJson(record, root, privateDirectory, run, context) {
  assert.match(record?.sha256 ?? '', hashPattern, 'BINDING_RETAINED_HASH_REQUIRED');
  assert.ok(typeof record.path === 'string' && /^[A-Za-z0-9_./-]+\.json$/.test(record.path) && !record.path.split('/').some(part => !part || part === '..' || part === '.'), 'BINDING_RETAINED_PATH_INVALID');
  if (record.storage === 'committed') {
    assert.ok(record.path.startsWith('docs/release-evidence/'), 'BINDING_RETAINED_PATH_INVALID');
    const result = await committedJson(root, record.path, run);
    equal(result.sha256, record.sha256, 'BINDING_RETAINED_BYTES_CHANGED');
    return result.value;
  }
  equal(record.storage, 'private', 'BINDING_RETAINED_STORAGE_INVALID');
  assert.ok(typeof privateDirectory === 'string' && path.isAbsolute(privateDirectory), 'BINDING_PRIVATE_DIRECTORY_REQUIRED');
  const privateRoot = path.resolve(privateDirectory);
  for (const directory of [root, context.sourceDirectory, context.outputDirectory].filter(Boolean)) {
    const relative = path.relative(path.resolve(directory), privateRoot), reverse = path.relative(privateRoot, path.resolve(directory));
    assert.ok(relative.startsWith('..') && !path.isAbsolute(relative) && reverse.startsWith('..') && !path.isAbsolute(reverse), 'BINDING_PRIVATE_DIRECTORY_OVERLAP');
  }
  const helper = path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1');
  assert.ok([context.fallback.permissionHelperSha256, context.fallback.permissionHelperLfSha256].includes(bindingHash(readFileSync(helper))), 'BINDING_PERMISSION_HELPER_CHANGED');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference = 'Stop'; . ${literal(helper)}; [void](Assert-PrivateInputPath -Path ${literal(path.join(privateRoot, record.path))} -RepositoryRoot ${literal(root)})`;
  const permissions = await run('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  equal(permissions.code, 0, 'BINDING_PRIVATE_PERMISSIONS_REQUIRED');
  const raw = ordinaryText(privateDirectory, record.path, false);
  equal(bindingHash(raw), record.sha256, 'BINDING_RETAINED_BYTES_CHANGED');
  return JSON.parse(raw);
}

async function replayNativeEvidence(receipt, profile, key, root, input, run, context) {
  evidenceIdentity(receipt, profile, key);
  equal(Object.keys(receipt.retainedEvidence ?? {}).sort(), ['independentReview', 'nativeResult'], 'BINDING_RETAINED_EVIDENCE_REQUIRED');
  const load = record => retainedJson(record, root, input.retainedEvidenceDirectory, run, context);
  const native = await load(receipt.retainedEvidence.nativeResult);
  const review = await load(receipt.retainedEvidence.independentReview);
  equal([native.schemaVersion, native.kind, native.passed], [1, 'release_binding_native_result', true], 'BINDING_NATIVE_RESULT_INVALID');
  equal([review.schemaVersion, review.kind, review.passed, review.fullIndependentReviewComplete], [1, 'release_binding_independent_review', true, true], 'BINDING_INDEPENDENT_REVIEW_REQUIRED');
  evidenceIdentity(native, profile, key); evidenceIdentity(review, profile, key);
  equal(review.nativeResultSha256, receipt.retainedEvidence.nativeResult.sha256, 'BINDING_REVIEW_NATIVE_CHANGED');
  equal(native.applicationImage, profile.testedApplicationImage, 'BINDING_NATIVE_IMAGE_CHANGED');
  equal(review.applicationImage, native.applicationImage, 'BINDING_NATIVE_IMAGE_CHANGED');
  for (const check of NATIVE_CHECKS[key]) equal(native.checks?.[check], true, 'BINDING_NATIVE_CHECK_FAILED');
  assert.ok(Array.isArray(native.runs) && native.runs.length > 0 && native.runs.length <= 100, 'BINDING_NATIVE_RUNS_REQUIRED');
  assert.equal(new Set(native.runs.map(record => record.sha256)).size, native.runs.length, 'BINDING_DUPLICATE_NATIVE_RUN');
  equal(review.runSha256s, native.runs.map(record => record.sha256), 'BINDING_REVIEW_RUNS_CHANGED');
  const runs = [];
  for (const record of native.runs) {
    const nativeRun = await load(record);
    evidenceIdentity(nativeRun, profile, key);
    equal([nativeRun.schemaVersion, nativeRun.kind, nativeRun.applicationImage, nativeRun.complete, nativeRun.safetyPassed, nativeRun.completeErrorCoverage, nativeRun.cleanupPassed], [1, 'release_binding_native_run', native.applicationImage, true, true, true, true], 'BINDING_NATIVE_RUN_INVALID');
    assert.ok(typeof nativeRun.runId === 'string' && nativeRun.runId.length > 0, 'BINDING_NATIVE_RUN_ID_REQUIRED');
    runs.push(nativeRun);
  }
  assert.equal(new Set(runs.map(value => value.runId)).size, runs.length, 'BINDING_DUPLICATE_NATIVE_RUN');
  validateCampaignRuns(key, runs, profile);
  if (key === 'ordinaryRecovery') validateOrdinaryRecovery(native.recovery, profile, profile.fallback);
}

export async function resolveReleaseBinding(input, { root, run, fallback, sourceDirectory, source }) {
  if (bindingSchema(input) === 1) return undefined;
  const filename = BINDING_FILES[input.releaseBindingId];
  // Pending profiles fail before Git, scans or any external command is needed.
  const profile = JSON.parse(ordinaryText(root, filename));
  validateBindingProfile(profile, input.releaseBindingId, fallback);
  const committed = await committedJson(root, filename, run);
  equal(profile, committed.value, 'BINDING_PROFILE_CHANGED');
  const policy = await committedJson(root, profile.policy.path, run);
  equal(policy.sha256, profile.policy.sha256, 'BINDING_POLICY_CHANGED');
  assert.equal(policy.value.status, 'APPROVED_READINESS_CRITERIA_ONLY', 'BINDING_POLICY_NOT_APPROVED');
  const applicability = await committedJson(root, profile.sourceApplicability.path, run);
  equal(applicability.sha256, profile.sourceApplicability.sha256, 'BINDING_SOURCE_APPLICABILITY_CHANGED');
  equal([applicability.value.schemaVersion, applicability.value.kind, applicability.value.status, applicability.value.applicationSource, applicability.value.inventorySha256, applicability.value.policySha256, applicability.value.operationalAuthorization], [1, 'owner_release_source_applicability', 'APPROVED_READINESS_SOURCE_ONLY', profile.applicationSource, profile.inventory.sha256, profile.policy.sha256, false], 'BINDING_SOURCE_APPLICABILITY_INVALID');
  equal([applicability.value.releaseBindingId, applicability.value.frontendInventorySha256, applicability.value.extension, applicability.value.schema], [profile.id, profile.frontendInventory.sha256, profile.extension, profile.schema], 'BINDING_SOURCE_APPLICABILITY_IDENTITY_CHANGED');
  const context = { fallback, sourceDirectory, outputDirectory: input.outputDirectory };
  const load = record => retainedJson(record, root, input.retainedEvidenceDirectory, run, context);
  const fallbackScan = await load(profile.fallbackScan.scan), fallbackReport = await load(profile.fallbackScan.report), fallbackCleanup = await load(profile.fallbackScan.cleanup);
  assert.ok(Number.isFinite(Date.parse(fallbackScan.createdAt)) && Date.parse(fallbackScan.createdAt) > Date.parse(FALLBACK_FAILED_SCAN_AT), 'BINDING_FALLBACK_SCAN_STALE');
  equal([fallbackScan.schemaVersion, fallbackScan.passed, fallbackScan.sourceSha, fallbackScan.imageId, fallbackScan.configDigest, fallbackScan.scanner, fallbackScan.os, fallbackScan.architecture, fallbackScan.reportSha256], [1, true, fallback.source, fallback.localIndex, fallback.config, SCANNER, 'linux', 'amd64', profile.fallbackScan.report.sha256], 'BINDING_FALLBACK_SCAN_CHANGED');
  const counts = scanCounts(fallbackReport, fallback.config);
  equal(fallbackScan.counts, counts, 'BINDING_FALLBACK_SCAN_COUNTS_CHANGED');
  equal([counts.HIGH, counts.CRITICAL], [0, 0], 'BINDING_FALLBACK_SCAN_FAILED');
  equal([fallbackCleanup.schemaVersion, fallbackCleanup.complete, fallbackCleanup.forced, fallbackCleanup.exactOwned, fallbackCleanup.scannerExitCode, fallbackCleanup.ownedScannerAbsent, fallbackCleanup.scanSha256], [1, true, false, true, 0, true, profile.fallbackScan.scan.sha256], 'BINDING_FALLBACK_SCAN_CLEANUP_REQUIRED');
  const receipts = {};
  for (const key of REQUIRED_EVIDENCE) {
    const record = profile.evidence[key], receipt = await committedJson(root, record.path, run);
    equal(receipt.sha256, record.sha256, 'BINDING_EVIDENCE_CHANGED');
    receipts[key] = receipt.value;
    if (key === 'ordinaryRecovery') validateOrdinaryRecovery(receipt.value, profile, fallback);
    else {
      equal([receipt.value.schemaVersion, receipt.value.kind, receipt.value.evidenceKind, receipt.value.applicationSource, receipt.value.inventorySha256, receipt.value.policySha256, receipt.value.passed], [1, 'release_binding_acceptance', key, profile.applicationSource, profile.inventory.sha256, profile.policy.sha256, true], 'BINDING_ACCEPTANCE_INVALID');
    }
    await replayNativeEvidence(receipt.value, profile, key, root, input, run, context);
  }
  equal(await imageInputInventory(sourceDirectory, profile.applicationSource, run), profile.inventory, 'BINDING_REFERENCE_INVENTORY_CHANGED');
  equal(await imageInputInventory(sourceDirectory, source, run), profile.inventory, 'APPLICATION_BYTES_CHANGED');
  equal(await frontendInputInventory(sourceDirectory, profile.applicationSource, run), profile.frontendInventory, 'BINDING_REFERENCE_FRONTEND_CHANGED');
  equal(await frontendInputInventory(sourceDirectory, source, run), profile.frontendInventory, 'FRONTEND_BYTES_CHANGED');
  return { id: profile.id, sha256: committed.sha256, validatorSha256: bindingHash(readFileSync(path.join(root, 'scripts/release-source-binding.mjs'))), applicationSource: profile.applicationSource, inventory: profile.inventory, frontendInventory: profile.frontendInventory, extension: profile.extension, testedApplicationImage: profile.testedApplicationImage, testedApplicationConfig: profile.testedApplicationConfig, fallbackScan: { scanSha256: profile.fallbackScan.scan.sha256, reportSha256: profile.fallbackScan.report.sha256, cleanupSha256: profile.fallbackScan.cleanup.sha256 }, ordinaryRecoverySha256: profile.evidence.ordinaryRecovery.sha256 };
}

// Read-only; called on v2 recovery Apply before AWS reads and before each write.
export async function verifyCurrentReleaseMain(source, run) {
  const call = async args => { const result = await run('gh', args); equal(result.code, 0, 'BINDING_MAIN_CI_UNAVAILABLE'); return JSON.parse(result.stdout); };
  const branch = await call(['api', 'repos/bzinkan/SchoolPilot/branches/main']);
  equal(branch.commit?.sha, source, 'REMOTE_MAIN_CHANGED');
  const runs = await call(['run', 'list', '--repo', 'bzinkan/SchoolPilot', '--commit', source, '--event', 'push', '--limit', '100', '--json', 'headSha,headBranch,event,status,conclusion,workflowName']);
  assert.ok(Array.isArray(runs) && runs.length > 0 && runs.length <= 100, 'MAIN_CI_REQUIRED');
  const latest = new Map();
  for (const value of runs) {
    equal([value.headSha, value.headBranch, value.event], [source, 'main', 'push'], 'MAIN_CI_RUN_IDENTITY_INVALID');
    assert.ok(typeof value.workflowName === 'string' && value.workflowName.length > 0, 'MAIN_CI_WORKFLOW_INVALID');
    if (!latest.has(value.workflowName)) latest.set(value.workflowName, value);
  }
  assert.ok(latest.has('CI') && latest.get('CI').conclusion === 'success', 'MAIN_CI_REQUIRED');
  for (const value of latest.values()) assert.ok(value.status === 'completed' && ['success', 'skipped', 'neutral'].includes(value.conclusion), 'MAIN_CI_NOT_GREEN');
}

export function assertBindingReplay(input, recorded, actual) {
  bindingSchema(input);
  equal(recorded, actual, 'RELEASE_BINDING_CHANGED');
}

export function assertBoundPublication(receipt, binding, source, digest) {
  assert.ok(binding, 'PUBLICATION_BINDING_REQUIRED');
  equal(receipt.releaseBinding, binding, 'PUBLICATION_RELEASE_BINDING_CHANGED');
  equal([receipt.schemaVersion, receipt.source, receipt.registryDigest, receipt.status, receipt.publicationOutcomeUncertain], [2, source, digest, 'published', false], 'BOUND_PUBLICATION_REQUIRED');
  equal([receipt.operation, receipt.servicesUpdated, receipt.tasksLaunched, receipt.productionDatabaseOperations], ['PublishImage', 0, 0, 0], 'BOUND_PUBLICATION_SCOPE_CHANGED');
  equal(receipt.artifactSource, binding.applicationSource, 'BOUND_PUBLICATION_ARTIFACT_SOURCE_CHANGED');
}

export function assertBoundScan(scan, binding) {
  assert.ok(binding, 'SCAN_BINDING_REQUIRED');
  equal([scan.sourceSha, scan.imageId, scan.configDigest, scan.passed], [binding.applicationSource, binding.testedApplicationImage, binding.testedApplicationConfig, true], 'BOUND_TESTED_IMAGE_REQUIRED');
}

export function assertBoundFallbackScan(input, scan, binding) {
  equal([input.scan.sha256, scan.reportSha256, input.scanCleanup.sha256], [binding.fallbackScan.scanSha256, binding.fallbackScan.reportSha256, binding.fallbackScan.cleanupSha256], 'BOUND_FRESH_FALLBACK_SCAN_REQUIRED');
}
