// Reviewed source/evidence bindings for the artifact-only controllers. No cloud I/O.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { SCANNER, scanCounts, archiveConfigDigest } from './verify-legacy-deploy-image.mjs';

export const IMAGE_INPUTS = Object.freeze(['src', 'package*.json', 'tsconfig.json', 'drizzle.config.ts', 'Dockerfile', '.dockerignore', 'config', 'docs/soc2']);
export const FRONTEND_INPUTS = Object.freeze(['schoolpilot-app']);
export const EXTENSION_IDENTITY = Object.freeze({ version: '2.9.7', id: 'iggbfegfcjkfieoemeolfmfnapepalca', source: '065be165b5df704d84eb716e3fb914c1fed17f98', mergedSource: '03a9c3633d1e1f7d763ea5cf910f870994400e02', tree: 'f7a3174e5631dcad9d02eb2357b245c5d2df714f', zipSha256: '82352b04020b5fefdee06aa46cc3ba963ddac0d6c7eab4e241fca2cf6ca61575', zipBytes: 376052 });
export const POLICY_REFERENCE = Object.freeze({ path: 'docs/release-evidence/release-297/release-gate-policy-20261003/current-school-gate-amendment-approved.json', sha256: '965328a337fe35eaa505610ade00633075f7014fab610da8a869f6b514688f95' });
export const FALLBACK_FAILED_SCAN_AT = '2026-10-07T17:32:59.633Z';
export const SUCCESSOR_BINDING_ID = 'release-297-current-school-fallback-v3';
export const SUCCESSOR_SOURCE = 'd75fc1c48d0a3918857508d3965904c69023a153';
export const SUCCESSOR_CORRECTION = '86ea5c5ca5f76406300f5170d2ecb3e3554baeb3';
export const CP_PROTECTED_BINDING_ID = 'release-297-current-school-cp-protected-fallback-v4';
// The separate source and artifact are exact review inputs. Their presence
// does not establish preparation, selection, applicability or authorization.
export const CP_PROTECTED_SOURCE = '6259e768553e55346ba14a6453340772198a3d6b';
export const CP_PROTECTED_SOURCE_REVIEW = Object.freeze({
  "baseline": "d75fc1c48d0a3918857508d3965904c69023a153",
  "source": "6259e768553e55346ba14a6453340772198a3d6b",
  "files": [
    {
      "path": "src/services/aiClassification.ts",
      "before": {
        "mode": "100644",
        "object": "39ca4ac7d4832e923f045ad3d54bb207f3e87a65"
      },
      "after": {
        "mode": "100644",
        "object": "19e32a35518d1c0c1b3f7fa3ca39ac94c586b06a"
      }
    },
    {
      "path": "src/services/classpilotAiRequestInput.ts",
      "before": null,
      "after": {
        "mode": "100644",
        "object": "f9ae070890980795d874ea9a60338ed75e4fa2d3"
      }
    },
    {
      "path": "tests/classpilot-after-hours-ai-boundary.test.ts",
      "before": null,
      "after": {
        "mode": "100644",
        "object": "68ad5f321a0ea9499d3259efd0d22ab6e90ef4d6"
      }
    },
    {
      "path": "tests/classpilot-ai-request-input.test.ts",
      "before": null,
      "after": {
        "mode": "100644",
        "object": "ce2f7d33056dbd0a4d904bed74798d7cb357c5ee"
      }
    },
    {
      "path": "tests/classpilot-heartbeat-classification-delivery.test.ts",
      "before": {
        "mode": "100644",
        "object": "a702141092e911d53eb3b65daa21e101852602d3"
      },
      "after": {
        "mode": "100644",
        "object": "eeba8b69e6e112ef90110cd914620cd9befa27e2"
      }
    },
    {
      "path": "tests/classpilot-provider-boundary-audit.test.ts",
      "before": null,
      "after": {
        "mode": "100644",
        "object": "6ed8d42e11ae12e3bf1da1fd20f055f867e017de"
      }
    },
    {
      "path": "tests/gemini-url-classification-budget.test.ts",
      "before": {
        "mode": "100644",
        "object": "889288fe4915e328584177d9b84b56dd913254c1"
      },
      "after": {
        "mode": "100644",
        "object": "fd7f062e8e85aa6e1bd9055ceccd207bc58616b9"
      }
    },
    {
      "path": "tests/gemini-url-classification.test.ts",
      "before": {
        "mode": "100644",
        "object": "b063fc6e91dddef0cdd4afa9728fa81c4aafacf6"
      },
      "after": {
        "mode": "100644",
        "object": "cf8bc61633672dae0764e6c7f8475dc1f8c0f40b"
      }
    }
  ],
  "patchSha256": "488454d7ac7b2cb754ea91acdad8c01d345a720e0754d5ec271720eb35df32ac"
});
export const CP_PROTECTED_ARTIFACT = Object.freeze({
  "source": "6259e768553e55346ba14a6453340772198a3d6b",
  "localIndex": "sha256:0eebe8c88bbc8304debaeb50644d008e1d3ad8212b0fee22a3a00eac1d04e264",
  "config": "sha256:849b9e9ecc822e8e5b4b46a31ab31c2df13420ec7231435d8dc9f6567cf11738",
  "platform": "sha256:bd70e6f4a091620936cb582c56d131f884fbe0aee5863d98259eadd5323e5048",
  "archiveSha256": "8a17801e557886ee49688b18d7a678cb12f22fa84b16d457d532a21e6de0cc0c"
});
export const BINDING_FILES = Object.freeze({ 'release-297-current-school-v2': 'docs/release-bindings/release-297-current-school-v2.json', [SUCCESSOR_BINDING_ID]: 'docs/release-bindings/release-297-current-school-fallback-v3.json', [CP_PROTECTED_BINDING_ID]: 'docs/release-bindings/release-297-current-school-cp-protected-fallback-v4.json' });
export const isSuccessorSchema = schemaVersion => schemaVersion === 3 || schemaVersion === 4;
export const REQUIRED_EVIDENCE = Object.freeze(['currentSchoolAcceptance', 'classroomAcceptance', 'normalLoadAcceptance', 'headroomAcceptance', 'ordinaryRecovery', 'restrictedRestoration', 'screenshotRuntime']);
const sha = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
export const bindingHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(sort(value))).digest('hex');
export const publicReceiptHash = bytes => bindingHash(bytes.toString('utf8').replaceAll('\r\n', '\n'));
const equal = (actual, expected, code) => assert.deepEqual(actual, expected, code);
const fallbackIdentity = fallback => Object.fromEntries(['source', 'localIndex', 'config', 'platform'].map(key => [key, fallback[key]]));

export function bindingSchema(input) {
  assert.ok([1, 2, 3, 4].includes(input?.schemaVersion), 'BINDING_SCHEMA_UNSUPPORTED');
  if (input.schemaVersion === 1) assert.ok(input.releaseBindingId === undefined, 'LEGACY_BINDING_OVERRIDE_FORBIDDEN');
  else {
    assert.ok(Object.hasOwn(BINDING_FILES, input.releaseBindingId), 'RELEASE_BINDING_NOT_ALLOWLISTED');
    equal(input.releaseBindingId, input.schemaVersion === 4 ? CP_PROTECTED_BINDING_ID : input.schemaVersion === 3 ? SUCCESSOR_BINDING_ID : 'release-297-current-school-v2', 'BINDING_VERSION_ID_MISMATCH');
    assert.ok(input.artifactSource === undefined, 'CALLER_ARTIFACT_SOURCE_FORBIDDEN');
  }
  return input.schemaVersion;
}

export function validateBindingProfile(profile, id, fallback) {
  if (isSuccessorSchema(profile.schemaVersion)) {
    validateSuccessorProfile(profile, fallback);
    assert.equal(profile.preparation.status, 'passed', 'SUCCESSOR_PREPARATION_PENDING');
    assert.equal(profile.successorSelection?.status, 'approved', 'SUCCESSOR_SELECTION_PENDING');
    assert.ok(typeof profile.successorSelection.path === 'string' && /^docs\/release-evidence\/[A-Za-z0-9_./-]+\.json$/.test(profile.successorSelection.path) && !profile.successorSelection.path.split('/').includes('..'), 'SUCCESSOR_SELECTION_PATH_INVALID');
    assert.match(profile.successorSelection.sha256 ?? '', hashPattern, 'SUCCESSOR_SELECTION_HASH_REQUIRED');
    fallback = profile.fallback;
    profile = { ...profile, schemaVersion: 2 };
  }
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
  for (const directory of [root, context.sourceDirectory, context.outputDirectory, ...(context.extraSourceDirectories ?? [])].filter(Boolean)) {
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

export async function resolveReleaseBinding(input, { root, run, fallback, sourceDirectory, source, now = Date.now }) {
  if (bindingSchema(input) === 1) return undefined;
  const filename = BINDING_FILES[input.releaseBindingId];
  // Pending profiles fail before Git, scans or any external command is needed.
  const profile = JSON.parse(ordinaryText(root, filename));
  validateBindingProfile(profile, input.releaseBindingId, fallback);
  if (isSuccessorSchema(input.schemaVersion)) {
    await validateSuccessorPreparation(input, { root, run, fallback, sourceDirectory, source, now });
    fallback = { ...fallback, ...profile.fallback };
    const selection = await committedJson(root, profile.successorSelection.path, run);
    equal(selection.sha256, profile.successorSelection.sha256, 'SUCCESSOR_SELECTION_CHANGED');
    equal([selection.value.schemaVersion, selection.value.kind, selection.value.releaseBindingId, selection.value.status, selection.value.artifactPair, selection.value.operationalAuthorization], [1, 'reviewed_fallback_successor_selection', profile.id, 'APPROVED_EXACT_SUCCESSOR', successorArtifactPair(profile), false], 'SUCCESSOR_SELECTION_INVALID');
    const mainDirectory = input.kind === 'fallback' ? input.mainDirectory : sourceDirectory;
    const mainSource = input.kind === 'fallback' ? input.mainSource : source;
    equal((await git(run, mainDirectory, ['rev-parse', 'HEAD'])).trim(), mainSource, 'SOURCE_MOVED');
    equal((await git(run, mainDirectory, ['status', '--porcelain'])).trim(), '', 'SOURCE_DIRTY');
    equal((await git(run, root, ['rev-parse', 'HEAD'])).trim(), mainSource, 'BINDING_TOOL_NOT_CURRENT_MAIN');
    equal((await git(run, mainDirectory, ['rev-parse', 'origin/main'])).trim(), mainSource, 'BINDING_LOCAL_REMOTE_MAIN_CHANGED');
    assert.ok(path.isAbsolute(input.mainCi?.path ?? ''), 'SUCCESSOR_MAIN_CI_SNAPSHOT_REQUIRED');
    const ciPath = path.resolve(input.mainCi.path);
    for (const directory of [root, mainDirectory]) { const relative = path.relative(directory, ciPath); assert.ok(relative.startsWith('..') && !path.isAbsolute(relative), 'SUCCESSOR_MAIN_CI_PRIVATE_PATH_REQUIRED'); }
    const permissionHelper = path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1');
    assert.ok([fallback.permissionHelperSha256, fallback.permissionHelperLfSha256].includes(bindingHash(readFileSync(permissionHelper))), 'BINDING_PERMISSION_HELPER_CHANGED');
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const permissions = await run('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; . ${literal(permissionHelper)}; [void](Assert-PrivateInputPath -Path ${literal(ciPath)} -RepositoryRoot ${literal(root)})`, 'utf16le').toString('base64')]);
    equal(permissions.code, 0, 'BINDING_PRIVATE_PERMISSIONS_REQUIRED');
    const ciBytes = ordinaryText(path.dirname(ciPath), path.basename(ciPath), false);
    equal(bindingHash(ciBytes), input.mainCi.sha256, 'SUCCESSOR_MAIN_CI_SNAPSHOT_CHANGED');
    const ci = JSON.parse(ciBytes);
    validateSuccessorMainCiSnapshot(ci, mainSource, now);
  }
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
  const applicationDirectory = isSuccessorSchema(input.schemaVersion) && input.kind === 'fallback' ? input.mainDirectory : sourceDirectory;
  const applicationMain = isSuccessorSchema(input.schemaVersion) && input.kind === 'fallback' ? input.mainSource : source;
  equal(await imageInputInventory(applicationDirectory, profile.applicationSource, run), profile.inventory, 'BINDING_REFERENCE_INVENTORY_CHANGED');
  equal(await imageInputInventory(applicationDirectory, applicationMain, run), profile.inventory, 'APPLICATION_BYTES_CHANGED');
  equal(await frontendInputInventory(applicationDirectory, profile.applicationSource, run), profile.frontendInventory, 'BINDING_REFERENCE_FRONTEND_CHANGED');
  equal(await frontendInputInventory(applicationDirectory, applicationMain, run), profile.frontendInventory, 'FRONTEND_BYTES_CHANGED');
  const binding = { id: profile.id, sha256: committed.sha256, validatorSha256: bindingHash(readFileSync(path.join(root, 'scripts/release-source-binding.mjs'))), applicationSource: profile.applicationSource, inventory: profile.inventory, frontendInventory: profile.frontendInventory, extension: profile.extension, testedApplicationImage: profile.testedApplicationImage, testedApplicationConfig: profile.testedApplicationConfig, fallbackScan: { scanSha256: profile.fallbackScan.scan.sha256, reportSha256: profile.fallbackScan.report.sha256, cleanupSha256: profile.fallbackScan.cleanup.sha256 }, ordinaryRecoverySha256: profile.evidence.ordinaryRecovery.sha256 };
  if (isSuccessorSchema(input.schemaVersion)) {
    const artifactRole = input.kind ?? 'serving-anchor';
    equal(['serving-anchor', 'fallback'].includes(artifactRole), true, 'BINDING_ARTIFACT_ROLE_INVALID');
    const artifact = profile.artifacts[artifactRole];
    return { ...binding, schemaVersion: profile.schemaVersion, artifactRole, artifactSource: artifact.source, artifact, artifactPair: successorArtifactPair(profile), fallback: profile.fallback, servingSource: applicationMain, preparation: profile.preparation, successorSelection: profile.successorSelection };
  }
  return binding;
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
  equal([receipt.schemaVersion, receipt.source, receipt.registryDigest, receipt.status, receipt.publicationOutcomeUncertain], [binding.schemaVersion ?? 2, source, digest, 'published', false], 'BOUND_PUBLICATION_REQUIRED');
  equal([receipt.operation, receipt.servicesUpdated, receipt.tasksLaunched, receipt.productionDatabaseOperations], ['PublishImage', 0, 0, 0], 'BOUND_PUBLICATION_SCOPE_CHANGED');
  equal(receipt.artifactSource, boundArtifactSource(binding), 'BOUND_PUBLICATION_ARTIFACT_SOURCE_CHANGED');
  if (isSuccessorSchema(binding.schemaVersion)) equal(receipt.artifactRole, binding.artifactRole, 'BOUND_PUBLICATION_ARTIFACT_ROLE_CHANGED');
}

export function assertBoundScan(scan, binding) {
  assert.ok(binding, 'SCAN_BINDING_REQUIRED');
  equal([scan.sourceSha, scan.imageId, scan.configDigest, scan.passed], [boundArtifactSource(binding), binding.artifact?.localIndex ?? binding.testedApplicationImage, binding.artifact?.config ?? binding.testedApplicationConfig, true], 'BOUND_TESTED_IMAGE_REQUIRED');
}

export function assertBoundFallbackScan(input, scan, binding) {
  equal([input.scan.sha256, scan.reportSha256, input.scanCleanup.sha256], [binding.fallbackScan.scanSha256, binding.fallbackScan.reportSha256, binding.fallbackScan.cleanupSha256], 'BOUND_FRESH_FALLBACK_SCAN_REQUIRED');
}

export const boundArtifactSource = binding => binding?.artifactSource ?? binding?.applicationSource;
export function validateSuccessorMainCiSnapshot(proof, source, now = Date.now) {
  equal([proof?.repository, proof?.branch, proof?.source], ['bzinkan/SchoolPilot', 'main', source], 'MAIN_CI_IDENTITY_INVALID');
  const observed = Date.parse(proof.observedAtUtc);
  assert.ok(Number.isFinite(observed) && now() - observed >= 0 && now() - observed <= 7_200_000, 'SUCCESSOR_MAIN_CI_SNAPSHOT_STALE');
  assert.ok(Array.isArray(proof.runs) && proof.runs.length > 0 && proof.runs.length <= 100, 'MAIN_CI_REQUIRED');
  const latest = new Map();
  for (const value of proof.runs) {
    equal([value.headSha, value.headBranch, value.event], [source, 'main', 'push'], 'MAIN_CI_RUN_IDENTITY_INVALID');
    assert.ok(typeof value.workflowName === 'string' && value.workflowName.length > 0, 'MAIN_CI_WORKFLOW_INVALID');
    if (!latest.has(value.workflowName)) latest.set(value.workflowName, value);
  }
  assert.ok(latest.has('CI') && latest.get('CI').conclusion === 'success', 'MAIN_CI_REQUIRED');
  for (const value of latest.values()) assert.ok(value.status === 'completed' && ['success', 'skipped', 'neutral'].includes(value.conclusion), 'MAIN_CI_NOT_GREEN');
}
export function bindingForRole(binding, role) {
  if (!isSuccessorSchema(binding?.schemaVersion)) return binding;
  assert.ok(['serving-anchor', 'fallback'].includes(role), 'BINDING_ARTIFACT_ROLE_INVALID');
  const artifact = binding.artifactPair[role];
  return { ...binding, artifactRole: role, artifactSource: artifact.source, artifact };
}
export const successorArtifactPair = profile => Object.fromEntries(['serving-anchor', 'fallback'].map(role => [role, Object.fromEntries(['source', 'localIndex', 'config', 'platform', 'archiveSha256'].map(key => [key, profile.artifacts[role][key]]))]));
export const SUCCESSOR_PREPARATION_CHECKS = Object.freeze({
  successorScan: ['zeroHighCritical', 'pinnedScanner', 'databaseProvenanceRecorded', 'exactArchiveAndConfig', 'unforcedScannerCleanup'],
  screenshotRuntime: ['screenshotPassed', 'imagePassed', 'privateFilePassed', 'pdfPassed', 'nativeMuslPassed', 'cleanupPassed'],
  requestIpRateLimit: ['expressClientIpPassed', 'rateLimitPassed', 'cleanupPassed'],
  ordinaryRecovery: ['restrictedRoleVerified', 'retainedScreenshotFunctionBodyAndAcl', 'privateChatHistoryAndFencesPreserved', 'exactFocusCleanupPassed', 'capabilityEqualityPassed', 'privateChatCompatibilityFloorsPassed', 'allDrainsExitZeroNoOomNoForceAndZeroNamedSqlConnections'],
  restrictedRestoration: ['nativeRestoreAccepted', 'schemaSerializationContinuity', 'actualServicePairsReplayed', 'exit0NoOomUnforced'],
});
export const CP_PROTECTED_PREPARATION_CHECKS = Object.freeze({ ...SUCCESSOR_PREPARATION_CHECKS,
  credentialBoundary: ['syntheticProviderInterceptPassed', 'credentialRequestsPrevented', 'sensitiveDiagnosticsAbsent', 'allowedContextPreserved', 'unavailableCompletionPassed', 'originalMatchingInputsPreserved'],
});
const successorSchema = { staffIdentityContract: 'deferred', baselineMigrations: 43, candidateMigrations: 53, fallbackDeclaredMigrations: 52, retainedCompletedMigrations: 53, admissionCounts: [121, 125, 126, 127, 128, 129] };

export function validateSuccessorProfile(profile, historicalFallback) {
  const protectedFallback = profile.schemaVersion === 4;
  const source = protectedFallback ? CP_PROTECTED_SOURCE : SUCCESSOR_SOURCE;
  const checks = protectedFallback ? CP_PROTECTED_PREPARATION_CHECKS : SUCCESSOR_PREPARATION_CHECKS;
  equal([profile.schemaVersion, profile.kind, profile.id], [protectedFallback ? 4 : 3, 'reviewed_release_source_binding', protectedFallback ? CP_PROTECTED_BINDING_ID : SUCCESSOR_BINDING_ID], 'SUCCESSOR_PROFILE_INVALID');
  equal(profile.historicalFallback, fallbackIdentity(historicalFallback), 'SUCCESSOR_HISTORY_CHANGED');
  if (protectedFallback) {
    equal(profile.previousFallback, { source: SUCCESSOR_SOURCE, localIndex: 'sha256:cf7ce08efaa73aed0e5322ae22fecf54e650e74db35eb2aea080d3afae70a459', config: 'sha256:f215c48e089bd83cb2306814b05f404c82038d2547a526dc7ae3e4e8fe5f9a84', platform: 'sha256:b5848846b7990714672e52f4785ac562a13fdcbcfce5fdc99e6439170268ecb6' }, 'CP_PROTECTED_PREVIOUS_FALLBACK_CHANGED');
    equal(profile.credentialBoundary, { reviewedSource: '9f3657c6ce0bb13eda62df07924d81bafb85ea60', mergedSource: '092f8fbfe96dd7deed52c279d0b916676e0fc102', policy: 'classpilot-ai-request-input-2026-10-08.1', retainedOnRollback: true }, 'CP_PROTECTED_CREDENTIAL_BOUNDARY_CHANGED');
    equal(profile.applicationSource, 'ecf6ce0100e758f5668c5a26427c1c0ea82ea0a2', 'CP_PROTECTED_APPLICATION_SOURCE_CHANGED');
    // A draft with missing artifact/evidence pins is never usable preparation.
    equal(profile.preparation?.status, 'passed', 'SUCCESSOR_PREPARATION_PENDING');
    equal(profile.buildDependencyAudit?.status, 'passed', 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
    equal([profile.buildDependencyAudit.source, profile.buildDependencyAudit.lockfileGitBlob, profile.buildDependencyAudit.inventory], [CP_PROTECTED_SOURCE, '608236c5f8366de630cba68ee96951edba5eb7a7', profile.fallbackInventory], 'CP_PROTECTED_BUILD_AUDIT_SOURCE_CHANGED');
    for (const field of ['audit', 'sourceChecks']) {
      const record = profile.buildDependencyAudit[field];
      equal(record?.storage, 'private', 'CP_PROTECTED_BUILD_AUDIT_RAW_REQUIRED');
      assert.match(record?.sha256 ?? '', hashPattern, 'CP_PROTECTED_BUILD_AUDIT_RAW_REQUIRED');
      assert.ok(typeof record.path === 'string' && /^[A-Za-z0-9_./-]+\.json$/.test(record.path) && !record.path.split('/').includes('..'), 'CP_PROTECTED_BUILD_AUDIT_RAW_REQUIRED');
    }
    assert.ok(CP_PROTECTED_SOURCE_REVIEW && CP_PROTECTED_ARTIFACT, 'CP_PROTECTED_REVIEW_PINS_PENDING');
    equal(profile.sourceDelta, CP_PROTECTED_SOURCE_REVIEW, 'CP_PROTECTED_SOURCE_REVIEW_CHANGED');
    equal(profile.artifacts?.fallback, CP_PROTECTED_ARTIFACT, 'CP_PROTECTED_ARTIFACT_CHANGED');
  } else equal(profile.correctionSource, SUCCESSOR_CORRECTION, 'SUCCESSOR_CORRECTION_CHANGED');
  equal(profile.fallback.source, source, 'SUCCESSOR_SOURCE_CHANGED');
  equal(profile.imageInputs, IMAGE_INPUTS, 'BINDING_INPUT_SCOPE_CHANGED');
  equal(profile.frontendInputs, FRONTEND_INPUTS, 'BINDING_FRONTEND_SCOPE_CHANGED');
  equal(profile.extension, EXTENSION_IDENTITY, 'BINDING_EXTENSION_CHANGED');
  equal(profile.policy, POLICY_REFERENCE, 'BINDING_APPROVED_POLICY_CHANGED');
  equal(profile.schema, successorSchema, 'BINDING_SCHEMA_CHANGED');
  equal(profile.scope, { school: 'St. Francis DeSales', clients: 133, usageRollupMode: 'off', digitalUsageMode: 'off', managedChromebookGate: 'waived_not_passed', liveAcceptanceMinutes: 30 }, 'BINDING_SCOPE_CHANGED');
  equal(profile.operationalAuthorization, false, 'BINDING_IS_NOT_AUTHORIZATION');
  assert.ok(['pending', 'accepted'].includes(profile.status), 'SUCCESSOR_PROFILE_STATUS_INVALID');
  assert.match(profile.applicationSource ?? '', sha, 'BINDING_APPLICATION_SOURCE_REQUIRED');
  for (const inventory of [profile.inventory, profile.frontendInventory, profile.fallbackInventory]) {
    assert.match(inventory?.sha256 ?? '', hashPattern, 'SUCCESSOR_INVENTORY_REQUIRED');
    assert.ok(Number.isSafeInteger(inventory.fileCount) && inventory.fileCount > 0, 'SUCCESSOR_INVENTORY_REQUIRED');
  }
  equal(Object.keys(profile.artifacts ?? {}).sort(), ['fallback', 'serving-anchor'], 'SUCCESSOR_ARTIFACT_ROLES_REQUIRED');
  for (const role of ['serving-anchor', 'fallback']) {
    const artifact = profile.artifacts[role];
    equal(artifact.source, role === 'fallback' ? source : profile.applicationSource, 'SUCCESSOR_ARTIFACT_SOURCE_CHANGED');
    for (const key of ['localIndex', 'config', 'platform']) assert.match(artifact[key] ?? '', /^sha256:[a-f0-9]{64}$/, 'SUCCESSOR_ARTIFACT_DIGEST_REQUIRED');
    assert.match(artifact.archiveSha256 ?? '', hashPattern, 'SUCCESSOR_ARTIFACT_ARCHIVE_REQUIRED');
  }
  equal(profile.fallback, fallbackIdentity(profile.artifacts.fallback), 'SUCCESSOR_FALLBACK_IDENTITY_CHANGED');
  equal([profile.testedApplicationImage, profile.testedApplicationConfig], [profile.artifacts['serving-anchor'].localIndex, profile.artifacts['serving-anchor'].config], 'SUCCESSOR_ANCHOR_IDENTITY_CHANGED');
  equal(Object.keys(profile.preparation?.evidence ?? {}).sort(), Object.keys(checks).sort(), 'SUCCESSOR_PREPARATION_EVIDENCE_SET_CHANGED');
  equal(profile.preparation.status, 'passed', 'SUCCESSOR_PREPARATION_PENDING');
  for (const value of Object.values(profile.preparation.evidence)) {
    equal(value.status, 'passed', 'SUCCESSOR_PREPARATION_EVIDENCE_PENDING');
    assert.ok(typeof value.path === 'string' && /^docs\/release-evidence\/[A-Za-z0-9_./-]+\.json$/.test(value.path) && !value.path.split('/').includes('..'), 'SUCCESSOR_RECEIPT_PATH_INVALID');
    assert.match(value.sha256 ?? '', hashPattern, 'SUCCESSOR_RECEIPT_HASH_REQUIRED');
  }
}

// Compare semantic leaf deltas, so retaining C578's unrelated tsc-alias does not
// import the correction commit's newer application or its complete lockfile.
export function lockfileChanges(before, after, prefix = '') {
  const result = [];
  for (const key of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
    const left = before?.[key], right = after?.[key], field = prefix + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) result.push(...lockfileChanges(left, right, field));
    else if (JSON.stringify(sort(left)) !== JSON.stringify(sort(right))) result.push({ path: field, before: left ?? null, after: right ?? null });
  }
  return result;
}
export async function validateSuccessorSourceDelta(directory, historicalFallback, run) {
  equal((await git(run, directory, ['rev-parse', 'HEAD'])).trim(), SUCCESSOR_SOURCE, 'SUCCESSOR_SOURCE_MOVED');
  equal((await git(run, directory, ['status', '--porcelain'])).trim(), '', 'SUCCESSOR_SOURCE_DIRTY');
  equal((await git(run, directory, ['rev-parse', `${SUCCESSOR_SOURCE}^`])).trim(), historicalFallback.source, 'SUCCESSOR_PARENT_CHANGED');
  return validateLockfileOnlyDelta(directory, { baseline: historicalFallback.source, source: SUCCESSOR_SOURCE, correction: SUCCESSOR_CORRECTION }, run);
}
// Production callers use the single immutable review manifest above. The pure
// comparison also accepts an explicit manifest for disposable real-Git tests;
// no controller input can provide or override that production review.
export async function validateReviewedProtectedDelta(directory, { baseline, source, files, patchSha256 }, run) {
  for (const value of [baseline, source]) assert.match(value ?? '', sha, 'BINDING_FULL_SOURCE_REQUIRED');
  assert.match(patchSha256 ?? '', hashPattern, 'CP_PROTECTED_PATCH_HASH_REQUIRED');
  assert.ok(Array.isArray(files) && files.length > 0 && new Set(files.map(value => value.path)).size === files.length, 'CP_PROTECTED_FILE_SET_REQUIRED');
  equal((await git(run, directory, ['diff', '--name-only', baseline, source])).trim().split('\n').sort(), files.map(value => value.path).sort(), 'CP_PROTECTED_SOURCE_DELTA_EXCEEDED');
  for (const file of files) {
    assert.ok(typeof file.path === 'string' && !file.path.split('/').includes('..'), 'CP_PROTECTED_FILE_PATH_INVALID');
    for (const [reference, expected] of [[baseline, file.before], [source, file.after]]) {
      const entry = (await git(run, directory, ['ls-tree', reference, '--', file.path])).trim();
      equal(entry, expected === null ? '' : `${expected.mode} blob ${expected.object}\t${file.path}`, 'CP_PROTECTED_REVIEWED_BLOB_CHANGED');
    }
  }
  const patch = await git(run, directory, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', baseline, source]);
  equal(bindingHash(patch.replaceAll('\r\n', '\n')), patchSha256, 'CP_PROTECTED_REVIEWED_PATCH_CHANGED');
  return { baseline, source, files, patchSha256 };
}
export async function validateProtectedSuccessorSourceDelta(directory, run) {
  assert.ok(CP_PROTECTED_SOURCE_REVIEW, 'CP_PROTECTED_REVIEW_PINS_PENDING');
  equal((await git(run, directory, ['rev-parse', 'HEAD'])).trim(), CP_PROTECTED_SOURCE, 'SUCCESSOR_SOURCE_MOVED');
  equal((await git(run, directory, ['status', '--porcelain'])).trim(), '', 'SUCCESSOR_SOURCE_DIRTY');
  equal((await git(run, directory, ['rev-parse', `${CP_PROTECTED_SOURCE}^`])).trim(), SUCCESSOR_SOURCE, 'CP_PROTECTED_PARENT_CHANGED');
  return validateReviewedProtectedDelta(directory, CP_PROTECTED_SOURCE_REVIEW, run);
}
export async function validateLockfileOnlyDelta(directory, { baseline, source, correction }, run) {
  for (const value of [baseline, source, correction]) assert.match(value ?? '', sha, 'BINDING_FULL_SOURCE_REQUIRED');
  equal((await git(run, directory, ['diff', '--name-only', baseline, source])).trim(), 'package-lock.json', 'SUCCESSOR_SOURCE_DELTA_EXCEEDED');
  const lock = async ref => JSON.parse(await git(run, directory, ['show', `${ref}:package-lock.json`]));
  const [before, after, correctionBefore, correctionAfter] = await Promise.all([lock(baseline), lock(source), lock(correction + '^'), lock(correction)]);
  const changes = lockfileChanges(before, after), expected = lockfileChanges(correctionBefore, correctionAfter);
  assert.ok(changes.length > 0, 'SUCCESSOR_EMPTY_PATCH');
  equal(changes, expected, 'SUCCESSOR_LOCK_DELTA_CHANGED');
  equal([after.packages?.['node_modules/proxy-addr']?.version, after.packages?.['node_modules/sharp']?.version], ['2.0.8', '0.35.5'], 'SUCCESSOR_FIXES_MISSING');
  return { files: ['package-lock.json'], changesSha256: bindingHash(changes), changeCount: changes.length, correctionSource: correction };
}

async function retainedArtifact(record, root, input, run, context) {
  if (record.format === 'json' || record.format === undefined) return retainedJson(record, root, input.retainedEvidenceDirectory, run, context);
  equal(record.storage, 'private', 'SUCCESSOR_RAW_STORAGE_INVALID');
  assert.ok(['text', 'binary'].includes(record.format) && typeof record.path === 'string' && /^[A-Za-z0-9_./-]+$/.test(record.path) && !record.path.split('/').some(value => !value || value === '.' || value === '..'), 'SUCCESSOR_RAW_PATH_INVALID');
  assert.match(record.sha256 ?? '', hashPattern, 'SUCCESSOR_RAW_HASH_REQUIRED');
  const privateRoot = path.resolve(input.retainedEvidenceDirectory ?? '');
  assert.ok(path.isAbsolute(input.retainedEvidenceDirectory ?? ''), 'BINDING_PRIVATE_DIRECTORY_REQUIRED');
  for (const directory of [root, context.sourceDirectory, context.outputDirectory, ...(context.extraSourceDirectories ?? [])].filter(Boolean)) {
    const relative = path.relative(path.resolve(directory), privateRoot), reverse = path.relative(privateRoot, path.resolve(directory));
    assert.ok(relative.startsWith('..') && !path.isAbsolute(relative) && reverse.startsWith('..') && !path.isAbsolute(reverse), 'BINDING_PRIVATE_DIRECTORY_OVERLAP');
  }
  const filename = path.resolve(privateRoot, record.path);
  assert.ok(filename.startsWith(privateRoot + path.sep), 'BINDING_PATH_ESCAPE');
  for (let current = filename; ; current = path.dirname(current)) { assert.ok(!lstatSync(current).isSymbolicLink(), 'BINDING_REPARSE_PATH'); if (current === path.dirname(current)) break; }
  assert.ok(lstatSync(filename).isFile(), 'BINDING_FILE_REQUIRED');
  const helper = path.join(root, 'scripts/deploy-classpilot-runtime-config.ps1');
  assert.ok([context.fallback.permissionHelperSha256, context.fallback.permissionHelperLfSha256].includes(bindingHash(readFileSync(helper))), 'BINDING_PERMISSION_HELPER_CHANGED');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const permissions = await run('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; . ${literal(helper)}; [void](Assert-PrivateInputPath -Path ${literal(filename)} -RepositoryRoot ${literal(root)})`, 'utf16le').toString('base64')]);
  equal(permissions.code, 0, 'BINDING_PRIVATE_PERMISSIONS_REQUIRED');
  const digest = createHash('sha256'); for await (const chunk of createReadStream(filename)) digest.update(chunk);
  equal(digest.digest('hex'), record.sha256, 'BINDING_RETAINED_BYTES_CHANGED');
  return filename;
}
function successorEvidenceIdentity(value, profile, key) {
  equal([value.releaseBindingId, value.evidenceKind, value.artifactPair, value.passed], [profile.id, key, successorArtifactPair(profile), true], 'SUCCESSOR_EVIDENCE_IDENTITY_CHANGED');
  const observed = Date.parse(value.observedAtUtc);
  assert.ok(Number.isFinite(observed) && observed > Date.parse(FALLBACK_FAILED_SCAN_AT), 'SUCCESSOR_EVIDENCE_STALE');
  if (profile.schemaVersion === 4) assert.ok(observed >= Date.parse('2026-10-08T23:33:09Z'), 'CP_PROTECTED_EVIDENCE_PREDATES_SOURCE');
}
export function validateProtectedExecutionEvidence(execution, native, profile, key) {
  const start = Date.parse(execution.startedAt ?? execution.startedAtUtc), end = Date.parse(execution.completedAt ?? execution.completedAtUtc);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start >= Date.parse('2026-10-08T23:33:09Z') && start < end && end <= Date.parse(native.observedAtUtc), 'CP_PROTECTED_RAW_EXECUTION_STALE');
  equal(execution.passed, true, 'CP_PROTECTED_RAW_EXECUTION_FAILED');
  equal(execution.schemaVersion, 1, 'CP_PROTECTED_RAW_EXECUTION_SCHEMA_CHANGED');
  if (['screenshotRuntime', 'requestIpRateLimit', 'credentialBoundary'].includes(key)) {
    equal([execution.source, execution.image, execution.artifactRole, execution.syntheticFixturesOnly, execution.productionMutations], [CP_PROTECTED_SOURCE, profile.fallback.localIndex, 'fallback', true, 0], 'CP_PROTECTED_RAW_EXECUTION_ROLE_CHANGED');
    equal(key === 'credentialBoundary' ? execution.externalProviderRequests : execution.providerRequests, 0, 'CP_PROTECTED_EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN');
    for (const field of ['providerRequests', 'externalProviderRequests']) if (Object.hasOwn(execution, field)) equal(execution[field], 0, 'CP_PROTECTED_EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN');
    equal(execution.cleanup?.forced, false, 'CP_PROTECTED_RAW_EXECUTION_FORCED');
    equal(execution.cleanup?.containerAbsent, true, 'CP_PROTECTED_RAW_EXECUTION_CLEANUP_REQUIRED');
    if (key === 'credentialBoundary') {
      equal([execution.kind, execution.releaseBindingId, execution.actualCompiledClassifier, execution.syntheticProviderInterceptPassed], ['release297_f2_image_credential_boundary', CP_PROTECTED_BINDING_ID, true, true], 'CP_PROTECTED_COMPILED_BOUNDARY_REQUIRED');
      assert.ok(Number.isSafeInteger(execution.tests) && execution.tests > 0 && execution.tests === execution.passedTests && execution.failedTests === 0 && execution.skippedTests === 0, 'CP_PROTECTED_COMPILED_BOUNDARY_TESTS_FAILED');
      equal([execution.cleanup.exitCode, execution.cleanup.oomKilled, execution.cleanup.unforcedRemoval], [0, false, true], 'CP_PROTECTED_COMPILED_BOUNDARY_CLEANUP_FAILED');
    } else {
      equal(execution.kind, 'release297_successor_independent_native_execution', 'CP_PROTECTED_NATIVE_EXECUTION_REQUIRED');
      equal(execution.resources?.network, 'none', 'CP_PROTECTED_NATIVE_NETWORK_REQUIRED');
      equal(execution.exit, { attachCode: 0, daemonExitCode: 0, running: false, oomKilled: false }, 'CP_PROTECTED_NATIVE_EXIT_REQUIRED');
    }
  }
  if (key === 'ordinaryRecovery') {
    equal([execution.source, execution.releaseBindingId, execution.productionMutations, execution.capacityAccepted, execution.actualApiWorkerProcesses, execution.syntheticSchemaOnly, execution.operationalAuthorization, execution.releaseReady, execution.providerAccessDisabled, execution.completedInsideAuthorizedWindow], [profile.applicationSource, CP_PROTECTED_BINDING_ID, 0, false, true, true, false, false, true, true], 'CP_PROTECTED_RAW_RECOVERY_IDENTITY_CHANGED');
    equal(execution.admissionChain?.map(row => row.count), [121, 125, 126, 127, 128, 129], 'CP_PROTECTED_RAW_ADMISSION_CHANGED');
    const phases = ['bridge128', 'adopt129', 'fallback129', 'return129'];
    assert.ok(Array.isArray(execution.services) && execution.services.length === 8 && Array.isArray(execution.drains) && execution.drains.length === 8, 'CP_PROTECTED_ACTUAL_SERVICE_PAIRS_REQUIRED');
    for (const rows of [execution.services, execution.drains]) assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.containerId ?? '')) && new Set(rows.map(row => row.containerId)).size === 8, 'CP_PROTECTED_ACTUAL_SERVICE_IDS_REQUIRED');
    equal(execution.services.map(row => `${row.phase}:${row.service}`).sort(), phases.flatMap(phase => [`${phase}:api`, `${phase}:worker`]).sort(), 'CP_PROTECTED_ACTUAL_SERVICE_PAIRS_REQUIRED');
    for (const service of execution.services) {
      const artifact = profile.artifacts[service.phase === 'fallback129' ? 'fallback' : 'serving-anchor'];
      equal([service.source, service.image, service.inventoryCount, service.privateEnabled], [artifact.source, artifact.localIndex, service.phase === 'bridge128' ? 128 : 129, service.phase === 'adopt129'], 'CP_PROTECTED_RAW_SERVICE_ROLE_CHANGED');
      if (service.service === 'api') equal(service.readyzStatus, 200, 'CP_PROTECTED_RAW_API_READINESS_FAILED');
      const drain = execution.drains.filter(row => row.containerId === service.containerId && row.phase === service.phase && row.service === service.service);
      equal(drain.length, 1, 'CP_PROTECTED_RAW_SERVICE_DRAIN_REQUIRED');
      equal([drain[0].sourceImage, drain[0].exitCode, drain[0].oomKilled, drain[0].forced, drain[0].sqlConnections], [artifact.localIndex, 0, false, false, 0], 'CP_PROTECTED_RAW_SERVICE_DRAIN_FAILED');
    }
    equal([execution.sourceSpecificNative?.baseline?.nativeCompletedMigrations?.length, execution.sourceSpecificNative?.candidate?.nativeCompletedMigrations?.length], [43, 53], 'CP_PROTECTED_RAW_ORDINARY_MIGRATIONS_CHANGED');
    equal([execution.cleanupPassed, execution.gracefulCleanupPassed, execution.networkCleanupPassed, execution.localAdmissionFloorVerified], [true, true, true, true], 'CP_PROTECTED_RAW_RECOVERY_CLEANUP_FAILED');
  }
  if (key === 'restrictedRestoration') {
    equal([execution.kind, execution.exactFallbackSource, execution.releaseBindingId, execution.productionMutations, execution.operationalAuthorization, execution.releaseReady, execution.ownerPoolEnded, execution.cleanupPassed], ['release297_cp_protected_fallback_restricted_owner_restoration', CP_PROTECTED_SOURCE, CP_PROTECTED_BINDING_ID, 0, false, false, true, true], 'CP_PROTECTED_RAW_RESTORATION_IDENTITY_CHANGED');
    equal(execution.restorationOwner, { superuser:false, bypassRls:false, inherit:false }, 'CP_PROTECTED_RAW_RESTORATION_ROLE_CHANGED');
    equal(execution.runtimeRole, { superuser:false, bypassRls:false, inherit:false, noSchemaCreate:true, ownsNoTables:true }, 'CP_PROTECTED_RAW_RESTORATION_ROLE_CHANGED');
    assert.ok(Array.isArray(execution.rounds) && execution.rounds.length === 6, 'CP_PROTECTED_RAW_RESTORATION_ROUNDS_REQUIRED');
    for (const arm of ['baseline', 'candidate', 'fallback']) {
      const rounds = execution.rounds.filter(row => row.arm === arm);
      equal(rounds.length, 2, 'CP_PROTECTED_RAW_RESTORATION_ROUNDS_REQUIRED');
      equal(rounds.map(row => row.round).sort(), [1, 2], 'CP_PROTECTED_RAW_RESTORATION_ROUNDS_REQUIRED');
      const first = rounds.find(row => row.round === 1), second = rounds.find(row => row.round === 2);
      for (const round of rounds) for (const key of ['inputSchema', 'exportSchema']) assert.match(round[key]?.sha256 ?? '', hashPattern, 'CP_PROTECTED_RESTORATION_SCHEMA_PINS_REQUIRED');
      equal(second.inputSchema.sha256, first.exportSchema.sha256, 'CP_PROTECTED_RESTORATION_ROUND_CHAIN_CHANGED');
      assert.match(first.continuity?.restoredCanonicalSha256 ?? '', hashPattern, 'CP_PROTECTED_RESTORATION_CANONICAL_PINS_REQUIRED');
      equal([second.continuity?.exactCanonicalBytesEqual, second.continuity?.inputCanonical, second.continuity?.exportCanonical], [true, first.continuity.restoredCanonicalSha256, first.continuity.restoredCanonicalSha256], 'CP_PROTECTED_RESTORATION_STABLE_ROUNDTRIP_REQUIRED');
      for (const round of rounds) {
        const source = arm === 'baseline' ? '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678' : profile.artifacts[arm === 'fallback' ? 'fallback' : 'serving-anchor'].source;
        equal([round.source, round.ledgerRows, round.effectiveDdlRole?.rolsuper, round.effectiveDdlRole?.rolbypassrls, round.allSchemaTablesOwnedByRestrictedOwner, round.ledgerCopiedOnlyFromActualFreshReplay, round.zeroNamedSqlConnections, round.databaseDropped, round.continuity?.verified], [source, arm === 'baseline' ? 43 : 53, false, false, true, true, true, true, true], 'CP_PROTECTED_RAW_RESTORATION_FACTS_CHANGED');
        if (arm !== 'baseline') equal(round.image, profile.artifacts[arm === 'fallback' ? 'fallback' : 'serving-anchor'].localIndex, 'CP_PROTECTED_RAW_RESTORATION_IMAGE_CHANGED');
      }
    }
    assert.ok(Array.isArray(execution.cleanup) && execution.cleanup.length > 0 && execution.cleanup.every(row => row.removed === true && row.exitCode === 0 && row.oomKilled === false && row.forced === false), 'CP_PROTECTED_RAW_RESTORATION_CLEANUP_FAILED');
  }
}
export function validateProtectedBuildDependencyAudit(audit, sourceChecks, profile) {
  equal([profile.buildDependencyAudit.source, profile.buildDependencyAudit.lockfileGitBlob, profile.buildDependencyAudit.inventory], [CP_PROTECTED_SOURCE, '608236c5f8366de630cba68ee96951edba5eb7a7', profile.fallbackInventory], 'CP_PROTECTED_BUILD_AUDIT_SOURCE_CHANGED');
  equal([sourceChecks.schemaVersion, sourceChecks.evidenceKind, sourceChecks.source, sourceChecks.cleanSource], [1, 'protected-fallback-source-checks', CP_PROTECTED_SOURCE, true], 'CP_PROTECTED_BUILD_SOURCE_CHECKS_REQUIRED');
  const checked = sourceChecks.checks?.fullDependencyAudit;
  equal([checked?.status, checked?.exitCode, checked?.high, checked?.critical, checked?.evidence?.sha256], ['passed', 0, 0, 0, profile.buildDependencyAudit.audit.sha256], 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
  equal(audit.auditReportVersion, 2, 'CP_PROTECTED_BUILD_AUDIT_FORMAT_REQUIRED');
  assert.ok(audit.vulnerabilities && typeof audit.vulnerabilities === 'object', 'CP_PROTECTED_BUILD_AUDIT_FINDINGS_REQUIRED');
  const counts = audit.metadata?.vulnerabilities;
  assert.ok(counts && ['info', 'low', 'moderate', 'high', 'critical', 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0), 'CP_PROTECTED_BUILD_AUDIT_COUNTS_REQUIRED');
  equal([counts.high, counts.critical], [0, 0], 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
  assert.ok(Object.values(audit.vulnerabilities).every(value => !['high', 'critical'].includes(value.severity)), 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
}
export async function validateSuccessorPreparation(input, { root, run, fallback, sourceDirectory, source, now = Date.now }) {
  assert.ok(isSuccessorSchema(bindingSchema(input)), 'SUCCESSOR_PREPARATION_SCHEMA_REQUIRED');
  const filename = BINDING_FILES[input.releaseBindingId], local = JSON.parse(ordinaryText(root, filename));
  validateSuccessorProfile(local, fallback);
  const profileRecord = await committedJson(root, filename, run), profile = profileRecord.value;
  const protectedFallback = profile.schemaVersion === 4;
  const fallbackSource = protectedFallback ? CP_PROTECTED_SOURCE : SUCCESSOR_SOURCE;
  const preparationChecks = protectedFallback ? CP_PROTECTED_PREPARATION_CHECKS : SUCCESSOR_PREPARATION_CHECKS;
  equal(local, profile, 'BINDING_PROFILE_CHANGED');
  equal((await git(run, root, ['status', '--porcelain'])).trim(), '', 'TOOL_DIRTY');
  const toolSource = (await git(run, root, ['rev-parse', 'HEAD'])).trim();
  const validatorSha256 = bindingHash(readFileSync(path.join(root, 'scripts/release-source-binding.mjs')));
  equal(await imageInputInventory(root, toolSource, run), profile.inventory, 'SUCCESSOR_TOOL_APPLICATION_BYTES_CHANGED');
  equal(await frontendInputInventory(root, toolSource, run), profile.frontendInventory, 'SUCCESSOR_TOOL_FRONTEND_BYTES_CHANGED');
  const policy = await committedJson(root, profile.policy.path, run);
  equal(policy.sha256, profile.policy.sha256, 'BINDING_POLICY_CHANGED');
  equal(policy.value.status, 'APPROVED_READINESS_CRITERIA_ONLY', 'BINDING_POLICY_NOT_APPROVED');
  let applicationDirectory, applicationMain;
  if (input.kind === 'fallback') {
    assert.ok(input.anchorDirectory === undefined && input.anchorSource === undefined, 'SUCCESSOR_AMBIGUOUS_SOURCE_DIRECTORIES');
    applicationDirectory = input.mainDirectory; applicationMain = input.mainSource;
  } else {
    assert.ok(input.mainDirectory === undefined && input.mainSource === undefined, 'SUCCESSOR_AMBIGUOUS_SOURCE_DIRECTORIES');
    if (sourceDirectory && input.anchorDirectory) equal(path.resolve(sourceDirectory), path.resolve(input.anchorDirectory), 'SUCCESSOR_AMBIGUOUS_SOURCE_DIRECTORIES');
    if (source && input.anchorSource) equal(source, input.anchorSource, 'SUCCESSOR_AMBIGUOUS_SOURCE_DIRECTORIES');
    applicationDirectory = sourceDirectory ?? input.sourceDirectory ?? input.anchorDirectory;
    applicationMain = source ?? input.source ?? input.anchorSource;
  }
  assert.ok(path.isAbsolute(applicationDirectory ?? '') && path.isAbsolute(input.fallbackDirectory ?? ''), 'SUCCESSOR_SOURCE_DIRECTORIES_REQUIRED');
  equal((await git(run, applicationDirectory, ['rev-parse', 'HEAD'])).trim(), applicationMain, 'SOURCE_MOVED');
  equal((await git(run, applicationDirectory, ['status', '--porcelain'])).trim(), '', 'SOURCE_DIRTY');
  equal(await imageInputInventory(applicationDirectory, profile.applicationSource, run), profile.inventory, 'BINDING_REFERENCE_INVENTORY_CHANGED');
  equal(await imageInputInventory(applicationDirectory, applicationMain, run), profile.inventory, 'APPLICATION_BYTES_CHANGED');
  equal(await frontendInputInventory(applicationDirectory, applicationMain, run), profile.frontendInventory, 'FRONTEND_BYTES_CHANGED');
  equal(await frontendInputInventory(applicationDirectory, profile.applicationSource, run), profile.frontendInventory, 'BINDING_REFERENCE_FRONTEND_CHANGED');
  const sourceDelta = protectedFallback ? await validateProtectedSuccessorSourceDelta(input.fallbackDirectory, run) : await validateSuccessorSourceDelta(input.fallbackDirectory, fallback, run);
  equal(await imageInputInventory(input.fallbackDirectory, fallbackSource, run), profile.fallbackInventory, 'SUCCESSOR_INVENTORY_CHANGED');
  equal(sourceDelta, profile.sourceDelta, 'SUCCESSOR_SOURCE_DELTA_RECEIPT_CHANGED');
  const context = { fallback, sourceDirectory: applicationDirectory, outputDirectory: input.outputDirectory, extraSourceDirectories: [input.fallbackDirectory] };
  if (protectedFallback) {
    const audit = await retainedArtifact(profile.buildDependencyAudit.audit, root, input, run, context);
    const sourceChecks = await retainedArtifact(profile.buildDependencyAudit.sourceChecks, root, input, run, context);
    validateProtectedBuildDependencyAudit(audit, sourceChecks, profile);
    equal((await git(run, input.fallbackDirectory, ['rev-parse', `${fallbackSource}:package-lock.json`])).trim(), profile.buildDependencyAudit.lockfileGitBlob, 'CP_PROTECTED_BUILD_AUDIT_SOURCE_CHANGED');
  }
  const nativeHashes = {};
  for (const [key, checks] of Object.entries(preparationChecks)) {
    const pinned = profile.preparation.evidence[key], receipt = await committedJson(root, pinned.path, run);
    equal(receipt.sha256, pinned.sha256, 'SUCCESSOR_EVIDENCE_CHANGED');
    equal([receipt.value.schemaVersion, receipt.value.kind], [1, 'release_successor_preparation_evidence'], 'SUCCESSOR_PREPARATION_RECEIPT_INVALID');
    successorEvidenceIdentity(receipt.value, profile, key);
    const retained = receipt.value.retainedEvidence;
    equal(Object.keys(retained ?? {}).sort(), ['independentReview', 'nativeResult'], 'SUCCESSOR_RETAINED_EVIDENCE_REQUIRED');
    const load = record => retainedArtifact(record, root, input, run, context);
    const native = await load(retained.nativeResult), review = await load(retained.independentReview);
    equal([native.schemaVersion, native.kind], [1, 'release_successor_native_result'], 'SUCCESSOR_NATIVE_RESULT_INVALID');
    equal([review.schemaVersion, review.kind, review.fullIndependentReviewComplete, review.independentFromProducer], [1, 'release_successor_independent_review', true, true], 'SUCCESSOR_INDEPENDENT_REVIEW_REQUIRED');
    successorEvidenceIdentity(native, profile, key); successorEvidenceIdentity(review, profile, key);
    assert.ok(typeof native.producer === 'string' && native.producer.length > 0 && typeof review.reviewer === 'string' && review.reviewer.length > 0 && review.reviewer !== native.producer, 'SUCCESSOR_REVIEWER_NOT_INDEPENDENT');
    assert.ok(Date.parse(review.observedAtUtc) >= Date.parse(native.observedAtUtc) && Date.parse(review.observedAtUtc) <= now() + 300_000, 'SUCCESSOR_REVIEW_TIME_INVALID');
    equal(review.nativeResultSha256, retained.nativeResult.sha256, 'SUCCESSOR_REVIEW_NATIVE_CHANGED');
    for (const check of checks) equal(native.checks?.[check], true, 'SUCCESSOR_NATIVE_CHECK_FAILED');
    if (key === 'credentialBoundary') equal([native.syntheticFixturesOnly, native.providerRequests, native.policyVersion], [true, 0, 'classpilot-ai-request-input-2026-10-08.1'], 'CP_PROTECTED_NATIVE_BOUNDARY_REQUIRED');
    if (key === 'screenshotRuntime' || key === 'requestIpRateLimit' || key === 'credentialBoundary') equal([native.testedArtifactRole, native.source, native.applicationImage], ['fallback', fallbackSource, profile.fallback.localIndex], 'SUCCESSOR_NATIVE_ARTIFACT_ROLE_CHANGED');
    assert.ok(Array.isArray(native.rawEvidence) && native.rawEvidence.length > 0 && native.rawEvidence.length <= 256 && new Set(native.rawEvidence.map(value => `${value.storage}:${value.path}`)).size === native.rawEvidence.length, 'SUCCESSOR_RAW_EVIDENCE_REQUIRED');
    equal(review.rawEvidenceSha256s, native.rawEvidence.map(value => value.sha256), 'SUCCESSOR_REVIEW_RAW_CHANGED');
    for (const record of native.rawEvidence) await load(record);
    if (protectedFallback && key !== 'successorScan') {
      assert.ok(native.executionReceipt && native.rawEvidence.some(record => record.sha256 === native.executionReceipt.sha256 && record.path === native.executionReceipt.path), 'CP_PROTECTED_EXECUTION_RECEIPT_REQUIRED');
      const execution = await load(native.executionReceipt);
      validateProtectedExecutionEvidence(execution, native, profile, key);
      if (key === 'restrictedRestoration') {
        assert.ok(native.serviceExecutionReceipt && native.rawEvidence.some(record => record.sha256 === native.serviceExecutionReceipt.sha256 && record.path === native.serviceExecutionReceipt.path), 'CP_PROTECTED_EXECUTION_RECEIPT_REQUIRED');
        equal(execution.sealedServiceReplay?.sha256, native.serviceExecutionReceipt.sha256, 'CP_PROTECTED_RESTORATION_SERVICE_REPLAY_CHANGED');
        validateProtectedExecutionEvidence(await load(native.serviceExecutionReceipt), native, profile, 'ordinaryRecovery');
      }
    }
    if (key === 'ordinaryRecovery') equal(native.recovery, { baselineMigrations: 43, candidateMigrations: 53, fallbackDeclaredMigrations: 52, retainedCompletedMigrations: 53, admissionCounts: [121, 125, 126, 127, 128, 129], phases: ['baseline43', 'candidate53-dark128', 'candidate53-adopt129', 'fallback-retains53', 'candidate-return53'], sequence: [profile.applicationSource, fallbackSource, profile.applicationSource] }, 'SUCCESSOR_ORDINARY_RECOVERY_CHANGED');
    if (key === 'ordinaryRecovery') equal(native.migration, { role: { rolsuper: false, rolbypassrls: false }, baselineMigrations: 43, completedMigrations: 53, ordinaryPath: true }, 'SUCCESSOR_RESTRICTED_MIGRATION_REQUIRED');
    if (key === 'restrictedRestoration') equal(native.restoration, { ddlOwner: { rolsuper: false, rolbypassrls: false }, probeRole: { rolsuper: false, rolbypassrls: false }, ordinaryMigrationCounts: [43, 53], stableSerializationRoundtrip: true }, 'SUCCESSOR_RESTRICTED_RESTORATION_REQUIRED');
    if (key === 'successorScan') {
      equal(Object.keys(native.scanArtifacts ?? {}).sort(), ['archive', 'cleanup', 'custody', 'databaseMetadata', 'report', 'scan'], 'SUCCESSOR_SCAN_RAW_REQUIRED');
      const scan = await load(native.scanArtifacts.scan), report = await load(native.scanArtifacts.report), cleanup = await load(native.scanArtifacts.cleanup), custody = await load(native.scanArtifacts.custody), database = await load(native.scanArtifacts.databaseMetadata);
      assert.ok(Date.parse(scan.createdAt) > Date.parse(FALLBACK_FAILED_SCAN_AT) && now() - Date.parse(scan.createdAt) >= 0 && now() - Date.parse(scan.createdAt) <= 86_400_000, 'SUCCESSOR_SCAN_STALE');
      equal([scan.schemaVersion, scan.sourceSha, scan.imageId, scan.configDigest, scan.passed, scan.scanner, scan.os, scan.architecture, scan.archiveSha256, scan.reportSha256], [1, fallbackSource, profile.fallback.localIndex, profile.fallback.config, true, SCANNER, 'linux', 'amd64', profile.artifacts.fallback.archiveSha256, native.scanArtifacts.report.sha256], 'SUCCESSOR_SCAN_IDENTITY_CHANGED');
      equal(scanCounts(report, profile.fallback.config), scan.counts, 'SUCCESSOR_SCAN_COUNTS_CHANGED');
      equal([scan.counts.HIGH, scan.counts.CRITICAL], [0, 0], 'SUCCESSOR_SCAN_FAILED');
      equal([custody.schemaVersion, custody.complete, custody.forced, custody.exactOwned, custody.scannerExitCode, custody.ownedScannerAbsent, custody.scanSha256], [1, true, false, true, 0, true, native.scanArtifacts.scan.sha256], 'SUCCESSOR_SCAN_CUSTODY_REQUIRED');
      equal([cleanup.complete, cleanup.ownedScanner], [true, custody.ownedScanner], 'SUCCESSOR_SCAN_CLEANUP_REQUIRED');
      assert.match(custody.ownedScanner ?? '', /^schoolpilot-image-scan-[a-f0-9-]+$/, 'SUCCESSOR_SCAN_OWNER_INVALID');
      assert.ok(database.Version === 2 && Number.isFinite(Date.parse(database.UpdatedAt)) && Number.isFinite(Date.parse(database.NextUpdate)) && Date.parse(database.NextUpdate) >= Date.parse(scan.createdAt), 'SUCCESSOR_SCAN_DATABASE_INVALID');
      if (protectedFallback) assert.ok(Date.parse(database.UpdatedAt) <= Date.parse(scan.createdAt) && Date.parse(database.NextUpdate) >= now(), 'CP_PROTECTED_SCAN_DATABASE_STALE');
      const archive = await load(native.scanArtifacts.archive);
      equal(native.scanArtifacts.archive.sha256, scan.archiveSha256, 'SUCCESSOR_SCAN_ARCHIVE_CHANGED');
      equal(await archiveConfigDigest(archive, fallbackSource), profile.fallback.config, 'SUCCESSOR_SCAN_ARCHIVE_CONFIG_CHANGED');
      equal([profile.fallbackScan.scan.sha256, profile.fallbackScan.report.sha256, profile.fallbackScan.cleanup.sha256], [native.scanArtifacts.scan.sha256, native.scanArtifacts.report.sha256, native.scanArtifacts.custody.sha256], 'SUCCESSOR_SCAN_PROFILE_CHANGED');
    }
    nativeHashes[key] = retained.nativeResult.sha256;
  }
  equal((await git(run, root, ['rev-parse', 'HEAD'])).trim(), toolSource, 'SUCCESSOR_TOOL_SOURCE_MOVED');
  equal(bindingHash(readFileSync(path.join(root, 'scripts/release-source-binding.mjs'))), validatorSha256, 'SUCCESSOR_VALIDATOR_CHANGED');
  equal((await git(run, root, ['status', '--porcelain'])).trim(), '', 'TOOL_DIRTY');
  equal((await git(run, applicationDirectory, ['rev-parse', 'HEAD'])).trim(), applicationMain, 'SOURCE_MOVED');
  equal((await git(run, applicationDirectory, ['status', '--porcelain'])).trim(), '', 'SOURCE_DIRTY');
  equal((await git(run, input.fallbackDirectory, ['rev-parse', 'HEAD'])).trim(), fallbackSource, 'SUCCESSOR_SOURCE_MOVED');
  equal((await git(run, input.fallbackDirectory, ['status', '--porcelain'])).trim(), '', 'SUCCESSOR_SOURCE_DIRTY');
  return { schemaVersion: profile.schemaVersion, operation: 'ValidateSuccessorPreparation', releaseBindingId: profile.id, bindingSha256: profileRecord.sha256, validatorSha256, toolSource, artifactPair: successorArtifactPair(profile), sourceDelta, nativeHashes, preparationPassed: true, releaseReady: false, operationalAuthorization: false, pendingAcceptance: REQUIRED_EVIDENCE.filter(key => profile.evidence[key]?.status !== 'passed'), successorSelection: profile.successorSelection.status, cloudMutations: 0 };
}
