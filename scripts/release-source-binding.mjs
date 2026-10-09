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
export const BUILD_SECURITY_BINDING_ID = 'release-297-current-school-cp-protected-build-fallback-v5';
export const BUILD_SECURITY_APPLICATION_SOURCE = '2001e8888992674493c3084981fa8aae27d70e1d';
export const BUILD_SECURITY_ANCHOR_ARTIFACT = Object.freeze({source:BUILD_SECURITY_APPLICATION_SOURCE,localIndex:'sha256:88d012d047e47a4bc33352290baf1800772777ee4260a4be64f5caacd7a249cc',config:'sha256:ae1680620e484439e10298b7cac433ab501f2a00ce4ecbc2251a9c3b0ee5c943',platform:'sha256:5e061a32ad491557e7685bfcb8876b031a197c76594e1b03be76c55774e543fb',archiveSha256:'b228d66a208de3e49f0bb0751ad2d1501d3f1185fceece754adcdaa5c723ec6e'});
export const BUILD_SECURITY_APPLICATION_INVENTORY = Object.freeze({sha256:'fd578e2f411ca2792a947263e63db6ae01b8c37e015cb2724661925c34969c01',fileCount:564});
export const BUILD_SECURITY_FRONTEND_INVENTORY = Object.freeze({sha256:'fd8d5e9fcf438c57735e19b524039401324d36c051934af63428775b8c21a6e4',fileCount:637});
// v5 pins are separate review inputs. Missing pins never establish preparation.
export const BUILD_SECURITY_SOURCE = "392970b7ccfea365faadf1eba07da4ad26964c09";
export const BUILD_SECURITY_SOURCE_CREATED_AT = '2026-10-09T12:58:29Z';
export const BUILD_SECURITY_SOURCE_REVIEW = Object.freeze({
  "baseline": "6259e768553e55346ba14a6453340772198a3d6b",
  "source": "392970b7ccfea365faadf1eba07da4ad26964c09",
  "files": [
    {
      "path": "package-lock.json",
      "before": {
        "mode": "100644",
        "object": "608236c5f8366de630cba68ee96951edba5eb7a7"
      },
      "after": {
        "mode": "100644",
        "object": "8c1744a6567b67a7b73164c695afd4c5a9e2bc3a"
      }
    },
    {
      "path": "package.json",
      "before": {
        "mode": "100644",
        "object": "5e847f1eddda47d28682cb2e977528348e5e514c"
      },
      "after": {
        "mode": "100644",
        "object": "965f6d1e914114482774d8dff9dd497945aec4b0"
      }
    }
  ],
  "patchSha256": "2184fac4c1fa58736afe999f5da094a9e478467e7c86e5f7d906523aa55688d0"
});
export const BUILD_SECURITY_ARTIFACT = Object.freeze({
  "source": "392970b7ccfea365faadf1eba07da4ad26964c09",
  "localIndex": "sha256:6a039cf5ec60efcfa054bde5166e04dd62d70dbdd8e9785a6954accf7eeb684e",
  "config": "sha256:2452ce7a09e2e97765a1217670ba69cd6a72350efa4e054c85e8b0a31079343b",
  "platform": "sha256:4073299e7bdea7ac0886c9875ae29989c1007769565424328b63f66a7bdbb41a",
  "archiveSha256": "e74e71e1d73af9aa8ecc5210ba012b78aca4aab12a4e54ec03d7d95dcbc1b06b"
});
export const BUILD_SECURITY_CURRENT_RUNTIME = Object.freeze({
  source: '55f91b620d2d48de5ed164a72250ec133450bc0f',
  image: 'sha256:a939d0af0f109f3765355be53137e88cab1859af82ce875aeeff455a4d55c8f3',
  admissionCount: 129,
  controls: { storage: 'private', path: 'current-serving-129-A3/controls.private.json', sha256: '4292b4c8ff0719abda45003d02f95718d9e205ca2e4c2ef9c71fccfd0ae20051', format: 'json' },
  review: { storage: 'private', path: 'current-serving-129-A3/state-review.private.json', sha256: '91cd89c76d2aeb0361c497a261ea86839d98044e99b47048dc1a7f6fe319936c', format: 'json' }
});
export const BUILD_SECURITY_OPERATION_DEPENDENCIES = Object.freeze(['scripts/validate-release297-deployment-artifact.mjs', 'scripts/deploy.sh']);
export const buildSecurityOperationHashes = root => Object.fromEntries(BUILD_SECURITY_OPERATION_DEPENDENCIES.map(file => [file, bindingHash(readFileSync(path.join(root, file)))]));
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
export const BINDING_FILES = Object.freeze({ 'release-297-current-school-v2': 'docs/release-bindings/release-297-current-school-v2.json', [SUCCESSOR_BINDING_ID]: 'docs/release-bindings/release-297-current-school-fallback-v3.json', [CP_PROTECTED_BINDING_ID]: 'docs/release-bindings/release-297-current-school-cp-protected-fallback-v4.json', [BUILD_SECURITY_BINDING_ID]: 'docs/release-bindings/release-297-current-school-cp-protected-build-fallback-v5.json' });
export const isSuccessorSchema = schemaVersion => schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5;
const isProtectedSchema = schemaVersion => schemaVersion === 4 || schemaVersion === 5;
const protectedSource = profile => profile.schemaVersion === 5 ? BUILD_SECURITY_SOURCE : CP_PROTECTED_SOURCE;
const protectedBindingId = profile => profile.schemaVersion === 5 ? BUILD_SECURITY_BINDING_ID : CP_PROTECTED_BINDING_ID;
const protectedSourceTime = profile => profile.schemaVersion === 5 ? BUILD_SECURITY_SOURCE_CREATED_AT : '2026-10-08T23:33:09Z';
export const REQUIRED_EVIDENCE = Object.freeze(['currentSchoolAcceptance', 'classroomAcceptance', 'normalLoadAcceptance', 'headroomAcceptance', 'ordinaryRecovery', 'restrictedRestoration', 'screenshotRuntime']);
const sha = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
export const bindingHash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(sort(value))).digest('hex');
export const publicReceiptHash = bytes => bindingHash(bytes.toString('utf8').replaceAll('\r\n', '\n'));
const equal = (actual, expected, code) => assert.deepEqual(actual, expected, code);
const fallbackIdentity = fallback => Object.fromEntries(['source', 'localIndex', 'config', 'platform'].map(key => [key, fallback[key]]));

export function bindingSchema(input) {
  assert.ok([1, 2, 3, 4, 5].includes(input?.schemaVersion), 'BINDING_SCHEMA_UNSUPPORTED');
  if (input.schemaVersion === 1) assert.ok(input.releaseBindingId === undefined, 'LEGACY_BINDING_OVERRIDE_FORBIDDEN');
  else {
    assert.ok(Object.hasOwn(BINDING_FILES, input.releaseBindingId), 'RELEASE_BINDING_NOT_ALLOWLISTED');
    equal(input.releaseBindingId, input.schemaVersion === 5 ? BUILD_SECURITY_BINDING_ID : input.schemaVersion === 4 ? CP_PROTECTED_BINDING_ID : input.schemaVersion === 3 ? SUCCESSOR_BINDING_ID : 'release-297-current-school-v2', 'BINDING_VERSION_ID_MISMATCH');
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
  const currentRuntime = profile.schemaVersion === 5 ? await loadBuildSecurityCurrentRuntime(profile, load) : undefined;
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
    return { ...binding, ...(profile.schemaVersion === 5 ? { operationToolDependencies: buildSecurityOperationHashes(root), currentRuntime } : {}), schemaVersion: profile.schemaVersion, artifactRole, artifactSource: artifact.source, artifact, artifactPair: successorArtifactPair(profile), fallback: profile.fallback, servingSource: applicationMain, preparation: profile.preparation, successorSelection: profile.successorSelection };
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
  const buildFallback = profile.schemaVersion === 5;
  const protectedFallback = isProtectedSchema(profile.schemaVersion);
  const source = protectedFallback ? protectedSource(profile) : SUCCESSOR_SOURCE;
  const checks = protectedFallback ? CP_PROTECTED_PREPARATION_CHECKS : SUCCESSOR_PREPARATION_CHECKS;
  equal([profile.schemaVersion, profile.kind, profile.id], [buildFallback ? 5 : protectedFallback ? 4 : 3, 'reviewed_release_source_binding', protectedFallback ? protectedBindingId(profile) : SUCCESSOR_BINDING_ID], 'SUCCESSOR_PROFILE_INVALID');
  equal(profile.historicalFallback, fallbackIdentity(historicalFallback), 'SUCCESSOR_HISTORY_CHANGED');
  if (protectedFallback) {
    equal(profile.previousFallback, buildFallback ? fallbackIdentity(CP_PROTECTED_ARTIFACT) : { source: SUCCESSOR_SOURCE, localIndex: 'sha256:cf7ce08efaa73aed0e5322ae22fecf54e650e74db35eb2aea080d3afae70a459', config: 'sha256:f215c48e089bd83cb2306814b05f404c82038d2547a526dc7ae3e4e8fe5f9a84', platform: 'sha256:b5848846b7990714672e52f4785ac562a13fdcbcfce5fdc99e6439170268ecb6' }, 'CP_PROTECTED_PREVIOUS_FALLBACK_CHANGED');
    equal(profile.credentialBoundary, { reviewedSource: '9f3657c6ce0bb13eda62df07924d81bafb85ea60', mergedSource: '092f8fbfe96dd7deed52c279d0b916676e0fc102', policy: 'classpilot-ai-request-input-2026-10-08.1', retainedOnRollback: true }, 'CP_PROTECTED_CREDENTIAL_BOUNDARY_CHANGED');
    equal(profile.applicationSource, buildFallback ? BUILD_SECURITY_APPLICATION_SOURCE : 'ecf6ce0100e758f5668c5a26427c1c0ea82ea0a2', 'CP_PROTECTED_APPLICATION_SOURCE_CHANGED');
    // A draft with missing artifact/evidence pins is never usable preparation.
    equal(profile.preparation?.status, 'passed', 'SUCCESSOR_PREPARATION_PENDING');
    equal(profile.buildDependencyAudit?.status, 'passed', 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
    equal([profile.buildDependencyAudit.source, profile.buildDependencyAudit.lockfileGitBlob, profile.buildDependencyAudit.inventory], [source, buildFallback ? BUILD_SECURITY_SOURCE_REVIEW?.files.find(row => row.path === 'package-lock.json')?.after.object : '608236c5f8366de630cba68ee96951edba5eb7a7', profile.fallbackInventory], 'CP_PROTECTED_BUILD_AUDIT_SOURCE_CHANGED');
    for (const field of ['audit', 'sourceChecks']) {
      const record = profile.buildDependencyAudit[field];
      equal(record?.storage, 'private', 'CP_PROTECTED_BUILD_AUDIT_RAW_REQUIRED');
      assert.match(record?.sha256 ?? '', hashPattern, 'CP_PROTECTED_BUILD_AUDIT_RAW_REQUIRED');
      assert.ok(typeof record.path === 'string' && /^[A-Za-z0-9_./-]+\.json$/.test(record.path) && !record.path.split('/').includes('..'), 'CP_PROTECTED_BUILD_AUDIT_RAW_REQUIRED');
    }
    assert.ok(buildFallback ? BUILD_SECURITY_SOURCE_REVIEW && BUILD_SECURITY_ARTIFACT && BUILD_SECURITY_SOURCE_CREATED_AT : CP_PROTECTED_SOURCE_REVIEW && CP_PROTECTED_ARTIFACT, 'CP_PROTECTED_REVIEW_PINS_PENDING');
    equal(profile.sourceDelta, buildFallback ? BUILD_SECURITY_SOURCE_REVIEW : CP_PROTECTED_SOURCE_REVIEW, 'CP_PROTECTED_SOURCE_REVIEW_CHANGED');
    equal(profile.artifacts?.fallback, buildFallback ? BUILD_SECURITY_ARTIFACT : CP_PROTECTED_ARTIFACT, 'CP_PROTECTED_ARTIFACT_CHANGED');
    if (buildFallback) {
      equal(profile.currentRuntime, BUILD_SECURITY_CURRENT_RUNTIME, 'BUILD_SECURITY_CURRENT_RUNTIME_CHANGED');
      assert.ok(BUILD_SECURITY_ANCHOR_ARTIFACT, 'BUILD_SECURITY_ANCHOR_PINS_PENDING');
      equal(profile.artifacts?.['serving-anchor'], BUILD_SECURITY_ANCHOR_ARTIFACT, 'BUILD_SECURITY_ANCHOR_CHANGED');
      equal(profile.inventory, BUILD_SECURITY_APPLICATION_INVENTORY, 'BUILD_SECURITY_APPLICATION_INVENTORY_CHANGED');
      equal(profile.frontendInventory, BUILD_SECURITY_FRONTEND_INVENTORY, 'BUILD_SECURITY_FRONTEND_INVENTORY_CHANGED');
      equal(profile.inheritedCredentialDelta, CP_PROTECTED_SOURCE_REVIEW, 'BUILD_SECURITY_CREDENTIAL_DELTA_CHANGED');
      equal(profile.compiledOutputEquivalence?.status, 'passed', 'BUILD_SECURITY_OUTPUT_EQUIVALENCE_PENDING');
      for (const field of ['execution', 'beforeAlias', 'afterAlias', 'successor', 'independentReview']) {
        const record = profile.compiledOutputEquivalence[field];
        equal(record?.storage, 'private', 'BUILD_SECURITY_OUTPUT_RAW_REQUIRED');
        assert.match(record?.sha256 ?? '', hashPattern, 'BUILD_SECURITY_OUTPUT_RAW_REQUIRED');
        assert.ok(typeof record.path === 'string' && /^[A-Za-z0-9_./-]+\.json$/.test(record.path) && !record.path.split('/').includes('..'), 'BUILD_SECURITY_OUTPUT_RAW_REQUIRED');
      }
    }
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

async function loadBuildSecurityCurrentRuntime(profile, load) {
  const review = await load(profile.currentRuntime.review), capabilities = await load(profile.currentRuntime.controls);
  equal([review.schemaVersion, review.kind, review.source, review.image, review.admissionCount, review.controls, review.newUsageModes, review.dailyUsageRollup, review.newRuntimeActivationAuthorized, review.humanApprovalAsserted, review.operationalAuthorization, review.releaseReady],
    [1, 'reviewed_existing_current129_serving_state', profile.currentRuntime.source, profile.currentRuntime.image, 129, profile.currentRuntime.controls, 'off/off', 'omitted->shadow', false, false, false, false], 'CURRENT129_REVIEW_CHANGED');
  assert.ok(capabilities && !Array.isArray(capabilities) && typeof capabilities === 'object' && Object.keys(capabilities).length > 0, 'CURRENT129_CONTROLS_REQUIRED');
  const controls = value => Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith('CLASSPILOT_CAP_') || key === 'CLASSPILOT_CAPABILITY_ROLLOUTS_JSON' || key === 'CLASSPILOT_PROTOCOL_V3_ENABLED'));
  equal(controls(capabilities), capabilities, 'CURRENT129_UNKNOWN_CONTROL');
  const services = await load(review.services);
  equal(services.services?.map(row => row.serviceName).sort(), ['schoolpilot-production-api','schoolpilot-production-scheduler-worker'], 'CURRENT129_SERVICE_CAPTURE_INVALID');
  for (const role of ['api','scheduler-worker']) {
    const response = await load(review.definitions[role]), task = response.taskDefinition;
    const container = task?.containerDefinitions?.find(row => row.name === role), values = Object.fromEntries((container?.environment ?? []).map(row => [row.name,row.value]));
    equal([values.GIT_SHA,container?.image,values.RLS_GUC_ENABLED,values.CLASSPILOT_USAGE_ROLLUP_MODE,values.CLASSPILOT_DIGITAL_USAGE_MODE,values.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE], [profile.currentRuntime.source,`135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@${profile.currentRuntime.image}`,'true','off','off',undefined], 'CURRENT129_CAPTURE_CHANGED');
    assert.ok(values.RLS_ENABLED_TABLES?.split(',').length === 129 && new Set(values.RLS_ENABLED_TABLES.split(',')).size === 129, 'CURRENT129_CAPTURE_ADMISSION_CHANGED');
    equal(controls(values), capabilities, 'CURRENT129_CAPTURE_CONTROLS_CHANGED');
    const service = services.services.find(row => row.serviceName === `schoolpilot-production-${role}`);
    equal(service?.taskDefinition,task.taskDefinitionArn,'CURRENT129_CAPTURE_SERVICE_CHANGED');
    assert.ok(service.status === 'ACTIVE' && service.desiredCount > 0 && service.runningCount === service.desiredCount && service.pendingCount === 0 && service.deployments?.length === 1 && service.deployments[0].rolloutState === 'COMPLETED', 'CURRENT129_CAPTURE_UNSTABLE');
  }
  return {...profile.currentRuntime,capabilityEnvironment:capabilities};
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
// Only two reviewed manifests may differ from F2. Re-prove the inherited CP
// patch against its original parent rather than trusting a copied receipt.
export async function validateBuildSecuritySuccessorSourceDelta(directory, run) {
  assert.ok(BUILD_SECURITY_SOURCE_REVIEW && BUILD_SECURITY_SOURCE, 'BUILD_SECURITY_REVIEW_PINS_PENDING');
  equal((await git(run, directory, ['rev-parse', 'HEAD'])).trim(), BUILD_SECURITY_SOURCE, 'SUCCESSOR_SOURCE_MOVED');
  equal((await git(run, directory, ['status', '--porcelain'])).trim(), '', 'SUCCESSOR_SOURCE_DIRTY');
  equal((await git(run, directory, ['rev-parse', `${BUILD_SECURITY_SOURCE}^`])).trim(), CP_PROTECTED_SOURCE, 'BUILD_SECURITY_PARENT_CHANGED');
  equal(BUILD_SECURITY_SOURCE_REVIEW.baseline, CP_PROTECTED_SOURCE, 'BUILD_SECURITY_PARENT_CHANGED');
  equal(BUILD_SECURITY_SOURCE_REVIEW.files.map(row => row.path).sort(), ['package-lock.json', 'package.json'], 'BUILD_SECURITY_MANIFEST_ONLY_REQUIRED');
  await validateReviewedProtectedDelta(directory, CP_PROTECTED_SOURCE_REVIEW, run);
  const delta = await validateReviewedProtectedDelta(directory, BUILD_SECURITY_SOURCE_REVIEW, run);
  const manifest = async ref => JSON.parse(await git(run, directory, ['show', `${ref}:package.json`]));
  validateCompilerOnlyManifestDelta(await manifest(CP_PROTECTED_SOURCE), await manifest(BUILD_SECURITY_SOURCE));
  const lock = async ref => JSON.parse(await git(run, directory, ['show', `${ref}:package-lock.json`]));
  validateCompilerOnlyLockDelta(await lock(CP_PROTECTED_SOURCE), await lock(BUILD_SECURITY_SOURCE));
  return delta;
}
export function validateCompilerOnlyManifestDelta(before, after) {
  equal(before.scripts?.build, 'tsc && tsc-alias', 'BUILD_SECURITY_ORIGINAL_BUILD_CHANGED');
  equal(after.scripts?.build, 'tsc', 'BUILD_SECURITY_BUILD_CHANGED');
  assert.ok(typeof before.devDependencies?.['tsc-alias'] === 'string', 'BUILD_SECURITY_COMPILER_DEPENDENCY_REQUIRED');
  const expected = structuredClone(before); expected.scripts.build = 'tsc'; delete expected.devDependencies['tsc-alias'];
  equal(after, expected, 'BUILD_SECURITY_MANIFEST_DELTA_EXCEEDED');
}
export function validateCompilerOnlyLockDelta(before, after) {
  const expected = structuredClone(before);
  assert.ok(expected.packages?.['']?.devDependencies?.['tsc-alias'], 'BUILD_SECURITY_LOCK_COMPILER_REQUIRED');
  delete expected.packages[''].devDependencies['tsc-alias'];
  const removed = Object.keys(expected.packages).filter(key => !Object.hasOwn(after.packages ?? {}, key));
  assert.ok(removed.length > 0 && removed.includes('node_modules/tsc-alias'), 'BUILD_SECURITY_LOCK_REMOVALS_REQUIRED');
  for (const key of removed) {
    equal(expected.packages[key].dev, true, 'BUILD_SECURITY_RUNTIME_PACKAGE_REMOVAL_FORBIDDEN');
    delete expected.packages[key];
  }
  equal(after, expected, 'BUILD_SECURITY_LOCK_DELTA_EXCEEDED');
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
export async function replayBuildSecurityRawEvidence(records, load) {
  const failures = [];
  for (let offset = 0; offset < records.length; offset += 4) {
    const results = await Promise.allSettled(records.slice(offset, offset + 4).map(record => Promise.resolve().then(() => load(record))));
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw failures[0];
}
function successorEvidenceIdentity(value, profile, key) {
  equal([value.releaseBindingId, value.evidenceKind, value.artifactPair, value.passed], [profile.id, key, successorArtifactPair(profile), true], 'SUCCESSOR_EVIDENCE_IDENTITY_CHANGED');
  const observed = Date.parse(value.observedAtUtc);
  assert.ok(Number.isFinite(observed) && observed > Date.parse(FALLBACK_FAILED_SCAN_AT), 'SUCCESSOR_EVIDENCE_STALE');
  if (isProtectedSchema(profile.schemaVersion)) assert.ok(observed >= Date.parse(protectedSourceTime(profile)), 'CP_PROTECTED_EVIDENCE_PREDATES_SOURCE');
}
export async function validateBuildSecurityExecutionPair(execution, native, profile, retainedDirectory, load) {
  equal(profile.schemaVersion, 5, 'BUILD_SECURITY_PAIR_SCHEMA_REQUIRED');
  const record = native.artifactPairBinding;
  assert.ok(record?.storage === 'private' && record.format === 'json' && hashPattern.test(record.sha256 ?? ''), 'BUILD_SECURITY_RAW_PAIR_REQUIRED');
  assert.ok(native.rawEvidence?.some(row => row.storage === record.storage && row.path === record.path && row.sha256 === record.sha256 && row.format === record.format), 'BUILD_SECURITY_RAW_PAIR_REQUIRED');
  const reference = execution.artifactPairBinding;
  assert.ok(reference && reference.sha256 === record.sha256 && path.resolve(retainedDirectory, reference.path) === path.resolve(retainedDirectory, record.path), 'BUILD_SECURITY_EXECUTION_PAIR_CHANGED');
  const pair = await load(record);
  equal(Object.keys(pair).sort(), ['fallback', 'serving-anchor'], 'BUILD_SECURITY_RAW_PAIR_ROLES_CHANGED');
  const fields = ['source', 'localIndex', 'config', 'platform', 'archiveSha256'];
  const projected = Object.fromEntries(['serving-anchor', 'fallback'].map(role => [role, Object.fromEntries(fields.map(field => [field, pair[role]?.[field]]))]));
  equal(projected, successorArtifactPair(profile), 'BUILD_SECURITY_RAW_PAIR_CHANGED');
  equal(projected, native.artifactPair, 'BUILD_SECURITY_RAW_PAIR_CHANGED');
}
export function validateProtectedExecutionEvidence(execution, native, profile, key) {
  const source = protectedSource(profile), bindingId = protectedBindingId(profile);
  const start = Date.parse(execution.startedAt ?? execution.startedAtUtc), end = Date.parse(execution.completedAt ?? execution.completedAtUtc);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && start >= Date.parse(protectedSourceTime(profile)) && start < end && end <= Date.parse(native.observedAtUtc), 'CP_PROTECTED_RAW_EXECUTION_STALE');
  equal(execution.passed, true, 'CP_PROTECTED_RAW_EXECUTION_FAILED');
  equal(execution.schemaVersion, 1, 'CP_PROTECTED_RAW_EXECUTION_SCHEMA_CHANGED');
  if (['screenshotRuntime', 'requestIpRateLimit', 'credentialBoundary'].includes(key)) {
    equal([execution.source, execution.image, execution.artifactRole, execution.syntheticFixturesOnly, execution.productionMutations], [source, profile.fallback.localIndex, 'fallback', true, 0], 'CP_PROTECTED_RAW_EXECUTION_ROLE_CHANGED');
    equal(key === 'credentialBoundary' ? execution.externalProviderRequests : execution.providerRequests, 0, 'CP_PROTECTED_EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN');
    for (const field of ['providerRequests', 'externalProviderRequests']) if (Object.hasOwn(execution, field)) equal(execution[field], 0, 'CP_PROTECTED_EXTERNAL_PROVIDER_REQUESTS_FORBIDDEN');
    equal(execution.cleanup?.forced, false, 'CP_PROTECTED_RAW_EXECUTION_FORCED');
    equal(execution.cleanup?.containerAbsent, true, 'CP_PROTECTED_RAW_EXECUTION_CLEANUP_REQUIRED');
    if (key === 'credentialBoundary') {
      equal([execution.kind, execution.releaseBindingId, execution.actualCompiledClassifier, execution.syntheticProviderInterceptPassed], [profile.schemaVersion === 5 ? 'release297_f3_image_credential_boundary' : 'release297_f2_image_credential_boundary', bindingId, true, true], 'CP_PROTECTED_COMPILED_BOUNDARY_REQUIRED');
      assert.ok(Number.isSafeInteger(execution.tests) && execution.tests > 0 && execution.tests === execution.passedTests && execution.failedTests === 0 && execution.skippedTests === 0, 'CP_PROTECTED_COMPILED_BOUNDARY_TESTS_FAILED');
      equal([execution.cleanup.exitCode, execution.cleanup.oomKilled, execution.cleanup.unforcedRemoval], [0, false, true], 'CP_PROTECTED_COMPILED_BOUNDARY_CLEANUP_FAILED');
    } else {
      equal(execution.kind, 'release297_successor_independent_native_execution', 'CP_PROTECTED_NATIVE_EXECUTION_REQUIRED');
      equal(execution.resources?.network, 'none', 'CP_PROTECTED_NATIVE_NETWORK_REQUIRED');
      equal(execution.exit, { attachCode: 0, daemonExitCode: 0, running: false, oomKilled: false }, 'CP_PROTECTED_NATIVE_EXIT_REQUIRED');
    }
  }
  if (key === 'ordinaryRecovery') {
    equal([execution.source, execution.releaseBindingId, execution.productionMutations, execution.capacityAccepted, execution.actualApiWorkerProcesses, execution.syntheticSchemaOnly, execution.operationalAuthorization, execution.releaseReady, execution.providerAccessDisabled, execution.completedInsideAuthorizedWindow], [profile.applicationSource, bindingId, 0, false, true, true, false, false, true, true], 'CP_PROTECTED_RAW_RECOVERY_IDENTITY_CHANGED');
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
    if (profile.schemaVersion === 5) {
      validateBuildSecurityMigrationOwnership(execution);
      const baseline = { source: '7af9d0dd5bc2bd3e13b96d35a577725e07f8b678', localIndex: '135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@sha256:c87433cdf3d88e0c291a50d1ae74fbc116f167048f7db9d6c2d1d0ebfc52b9e8' };
      for (const [arm, count, artifact] of [['baseline', 43, baseline], ['candidate', 53, profile.artifacts['serving-anchor']]]) {
        const proof = execution.sourceSpecificNative[arm], rows = proof.nativeCompletedMigrations;
        equal([proof.passed, proof.clientEnded, proof.source, proof.applicationImage], [true, true, artifact.source, artifact.localIndex], 'BUILD_SECURITY_NATIVE_MIGRATION_FAILED');
        assert.ok(rows.length === count && new Set(rows.map(row => row.id)).size === count && rows.every(row => typeof row.id === 'string' && row.id.length > 0 && hashPattern.test(row.checksum ?? '') && row.status === 'complete'), 'BUILD_SECURITY_NATIVE_LEDGER_INVALID');
      }
      assert.ok(Array.isArray(execution.migrationExecutions) && execution.migrationExecutions.length === 8, 'BUILD_SECURITY_MIGRATION_EXECUTIONS_REQUIRED');
      equal(execution.migrationExecutions.map(row => row.arm), ['baseline', 'candidate', 'candidate', 'candidate', 'candidate', 'candidate', 'fallback', 'candidate'], 'BUILD_SECURITY_MIGRATION_EXECUTIONS_REQUIRED');
      for (const row of execution.migrationExecutions) {
        const artifact = row.arm === 'baseline' ? baseline : profile.artifacts[row.arm === 'fallback' ? 'fallback' : 'serving-anchor'];
        equal([row.source, row.image, row.exitCode, row.oomKilled, row.namedSqlConnections, row.actualEntrypoint, row.NODE_ENV], [artifact.source, artifact.localIndex, 0, false, 0, 'node dist/index.js', 'production'], 'BUILD_SECURITY_MIGRATION_EXECUTION_FAILED');
      }
      assert.ok(Array.isArray(execution.cleanup) && execution.cleanup.length > 0 && execution.cleanup.every(row => row.removed === true && row.graceful === true && row.forced === false && row.exitCode === 0 && row.oomKilled === false), 'BUILD_SECURITY_RECOVERY_OWNED_CLEANUP_FAILED');
    }
  }
  if (key === 'restrictedRestoration') {
    equal([execution.kind, execution.exactFallbackSource, execution.releaseBindingId, execution.productionMutations, execution.operationalAuthorization, execution.releaseReady, execution.ownerPoolEnded, execution.cleanupPassed], ['release297_cp_protected_fallback_restricted_owner_restoration', source, bindingId, 0, false, false, true, true], 'CP_PROTECTED_RAW_RESTORATION_IDENTITY_CHANGED');
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
export function validateBuildSecurityMigrationOwnership(execution) {
  const rows = execution.migrationOwnershipChecks;
  assert.ok(Array.isArray(rows) && rows.length === 5, 'BUILD_SECURITY_QUERIED_MIGRATION_OWNERSHIP_REQUIRED');
  equal(rows.map(row => row.phase), ['constructor','baseline43','candidate53','fallbackRetains53','candidateReturn53'], 'BUILD_SECURITY_QUERIED_MIGRATION_OWNERSHIP_REQUIRED');
  const roleName = rows[0].role?.role;
  assert.ok(typeof roleName === 'string' && /^[a-z][a-z0-9_]+$/.test(roleName), 'BUILD_SECURITY_QUERIED_MIGRATION_ROLE_INVALID');
  for (const row of rows) {
    equal([row.role?.role,row.role?.rolsuper,row.role?.rolbypassrls,row.role?.rolinherit,row.role?.schema_owner,row.role?.schema_usage,row.role?.schema_create,row.allApplicationTablesOwned,row.excludedSourceApplicationTables,row.clientEnded,row.namedMigrationOwnershipConnections], [roleName,false,false,false,false,true,true,true,0,true,0], 'BUILD_SECURITY_QUERIED_MIGRATION_ROLE_CHANGED');
    assert.ok(Array.isArray(row.applicationTables) && row.applicationTables.length > 0 && row.applicationTables.length === row.applicationTableCount && new Set(row.applicationTables.map(table => table.table_name)).size === row.applicationTableCount && row.applicationTables.every(table => typeof table.table_name === 'string' && table.table_name !== '_health_sentinel' && table.owner === roleName && table.owned === true), 'BUILD_SECURITY_QUERIED_TABLE_OWNERSHIP_CHANGED');
    assert.ok(Array.isArray(row.excludedOperationalFixtureTables) && row.excludedOperationalFixtureTables.length <= 1 && row.excludedOperationalFixtureTables.every(table => table.table_name === '_health_sentinel'), 'BUILD_SECURITY_UNREVIEWED_TABLE_EXCLUSION');
    const observed = Date.parse(row.observedAtUtc);
    assert.ok(Number.isFinite(observed) && observed >= Date.parse(execution.startedAt ?? execution.startedAtUtc) && observed <= Date.parse(execution.completedAt ?? execution.completedAtUtc), 'BUILD_SECURITY_QUERIED_ROLE_EVIDENCE_STALE');
  }
  return true;
}
export function validateBuildSecurityRestrictedReplayApplicability(prior, current, priorFallback, currentFallback, applicability, restrictedExecution, profile) {
  equal([applicability?.unchangedExactArtifactRoles,applicability?.unchangedNative43And53MigrationLedger,applicability?.unchangedCanonicalSourceSchema,applicability?.allSixRestrictedRoundsRetainedWithoutRelabeling], [true,true,true,true], 'BUILD_SECURITY_RESTRICTED_REPLAY_APPLICABILITY_REQUIRED');
  equal(restrictedExecution.sealedServiceReplay?.sha256, applicability.priorActualReplay?.sha256, 'BUILD_SECURITY_RESTRICTED_PRIOR_REPLAY_CHANGED');
  for (const value of [prior,current]) {
    equal([value.source,value.releaseBindingId,value.passed,value.cleanupPassed,value.gracefulCleanupPassed,value.networkCleanupPassed,value.productionMutations,value.operationalAuthorization,value.releaseReady,value.artifactRoles], [profile.applicationSource,profile.id,true,true,true,true,0,false,false,{candidate:'serving-anchor',fallback:'fallback'}], 'BUILD_SECURITY_RESTRICTED_PAIR_CHANGED');
    assert.ok(Array.isArray(value.drains) && value.drains.length === 8 && value.drains.every(row => row.exitCode === 0 && row.oomKilled === false && row.forced === false && row.sqlConnections === 0), 'BUILD_SECURITY_RESTRICTED_PRIOR_DRAIN_FAILED');
    assert.ok(Array.isArray(value.cleanup) && value.cleanup.length > 0 && value.cleanup.every(row => row.removed === true && row.graceful === true && row.forced === false && row.exitCode === 0 && row.oomKilled === false), 'BUILD_SECURITY_RESTRICTED_PRIOR_CLEANUP_FAILED');
  }
  equal(prior.artifactPairBinding,current.artifactPairBinding,'BUILD_SECURITY_RESTRICTED_PAIR_CHANGED');
  equal(current.ownershipEvidenceCapture?.priorExecution, {path:applicability.priorActualReplay.path,sha256:applicability.priorActualReplay.sha256}, 'BUILD_SECURITY_RESTRICTED_OWNERSHIP_CORRECTION_CHANGED');
  equal(current.ownershipEvidenceCapture?.onlyReadOnlyAssertionsAdded,true,'BUILD_SECURITY_RESTRICTED_OWNERSHIP_CORRECTION_CHANGED');
  for (const arm of ['baseline','candidate']) {
    const previous=prior.sourceSpecificNative?.[arm],next=current.sourceSpecificNative?.[arm],count=arm==='baseline'?43:53;
    equal([previous?.passed,previous?.clientEnded,previous?.source,previous?.applicationImage], [true,true,next?.source,next?.applicationImage], 'BUILD_SECURITY_RESTRICTED_NATIVE_SOURCE_CHANGED');
    equal(previous.nativeCompletedMigrations,next.nativeCompletedMigrations,'BUILD_SECURITY_RESTRICTED_NATIVE_LEDGER_CHANGED');
    equal(previous.nativeCompletedMigrations.length,count,'BUILD_SECURITY_RESTRICTED_NATIVE_LEDGER_CHANGED');
    assert.match(prior[`${arm}Default`]?.canonicalSchemaSha256 ?? '',hashPattern,'BUILD_SECURITY_RESTRICTED_SCHEMA_REQUIRED');
    equal(prior[`${arm}Default`].canonicalSchemaSha256,current[`${arm}Default`]?.canonicalSchemaSha256,'BUILD_SECURITY_RESTRICTED_SCHEMA_CHANGED');
  }
  for (const proof of [priorFallback,currentFallback]) {
    equal([proof.source,proof.applicationImage,proof.passed,proof.clientEnded], [profile.fallback.source,profile.fallback.localIndex,true,true], 'BUILD_SECURITY_RESTRICTED_FALLBACK_SOURCE_CHANGED');
    equal(proof.nativeCompletedMigrations.length,53,'BUILD_SECURITY_RESTRICTED_FALLBACK_LEDGER_CHANGED');
  }
  equal(priorFallback.nativeCompletedMigrations,currentFallback.nativeCompletedMigrations,'BUILD_SECURITY_RESTRICTED_FALLBACK_LEDGER_CHANGED');
  validateBuildSecurityMigrationOwnership(current);
  return true;
}
export function validateProtectedBuildDependencyAudit(audit, sourceChecks, profile) {
  const source = protectedSource(profile), lockBlob = profile.schemaVersion === 5 ? BUILD_SECURITY_SOURCE_REVIEW?.files.find(row => row.path === 'package-lock.json')?.after.object : '608236c5f8366de630cba68ee96951edba5eb7a7';
  equal([profile.buildDependencyAudit.source, profile.buildDependencyAudit.lockfileGitBlob, profile.buildDependencyAudit.inventory], [source, lockBlob, profile.fallbackInventory], 'CP_PROTECTED_BUILD_AUDIT_SOURCE_CHANGED');
  equal([sourceChecks.schemaVersion, sourceChecks.evidenceKind, sourceChecks.source, sourceChecks.cleanSource], [1, 'protected-fallback-source-checks', source, true], 'CP_PROTECTED_BUILD_SOURCE_CHECKS_REQUIRED');
  const checked = sourceChecks.checks?.fullDependencyAudit;
  equal([checked?.status, checked?.exitCode, checked?.high, checked?.critical, checked?.evidence?.sha256], ['passed', 0, 0, 0, profile.buildDependencyAudit.audit.sha256], 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
  equal(audit.auditReportVersion, 2, 'CP_PROTECTED_BUILD_AUDIT_FORMAT_REQUIRED');
  assert.ok(audit.vulnerabilities && typeof audit.vulnerabilities === 'object', 'CP_PROTECTED_BUILD_AUDIT_FINDINGS_REQUIRED');
  const counts = audit.metadata?.vulnerabilities;
  assert.ok(counts && ['info', 'low', 'moderate', 'high', 'critical', 'total'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0), 'CP_PROTECTED_BUILD_AUDIT_COUNTS_REQUIRED');
  equal([counts.high, counts.critical], [0, 0], 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
  assert.ok(Object.values(audit.vulnerabilities).every(value => !['high', 'critical'].includes(value.severity)), 'CP_PROTECTED_BUILD_DEPENDENCY_AUDIT_FAILED');
  if (profile.schemaVersion === 5) {
    equal(profile.buildDependencyAudit.counts, { high: counts.high, critical: counts.critical, moderate: counts.moderate }, 'BUILD_SECURITY_AUDIT_FINDING_COUNTS_CHANGED');
    for (const key of ['dependencyInstall', 'backendType', 'backendBuild', 'credentialBoundarySynthetic']) {
      const result = sourceChecks.checks?.[key];
      equal([result?.status, result?.exitCode], ['passed', 0], 'BUILD_SECURITY_SOURCE_CHECK_FAILED');
      assert.match(result.evidence?.sha256 ?? '', hashPattern, 'BUILD_SECURITY_SOURCE_CHECK_RAW_REQUIRED');
    }
    const unit = sourceChecks.checks?.unit;
    assert.ok(['passed', 'passed_with_explicit_skips'].includes(unit?.status) && unit.exitCode === 0, 'BUILD_SECURITY_UNIT_CHECK_FAILED');
    assert.match(unit.evidence?.sha256 ?? '', hashPattern, 'BUILD_SECURITY_SOURCE_CHECK_RAW_REQUIRED');
    for (const key of ['unit', 'credentialBoundarySynthetic']) {
      const counts = sourceChecks.checks[key].evidence;
      assert.ok(['tests', 'passed', 'failed', 'skipped', 'cancelled'].every(field => Number.isSafeInteger(counts[field]) && counts[field] >= 0) && counts.tests > 0 && counts.tests === counts.passed + counts.skipped && counts.failed === 0 && counts.cancelled === 0, 'BUILD_SECURITY_SOURCE_TEST_COUNTS_FAILED');
    }
    assert.ok(Array.isArray(sourceChecks.rawEvidence) && sourceChecks.rawEvidence.length > 0 && sourceChecks.rawEvidence.length <= 64, 'BUILD_SECURITY_SOURCE_RAW_REQUIRED');
    for (const result of Object.values(sourceChecks.checks)) assert.ok(sourceChecks.rawEvidence.some(row => row.path === result.evidence?.path && row.sha256 === result.evidence?.sha256), 'BUILD_SECURITY_SOURCE_RAW_REQUIRED');
  }
}
export function validateBuildSecurityTestLog(text, evidence) {
  for (const [field, label] of [['tests', 'tests'], ['passed', 'pass'], ['failed', 'fail'], ['skipped', 'skipped'], ['cancelled', 'cancelled']]) {
    const found = [...text.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm'))];
    assert.ok(found.length > 0, 'BUILD_SECURITY_ACTUAL_TEST_LOG_REQUIRED');
    equal(Number(found.at(-1)[1]), evidence[field], 'BUILD_SECURITY_TEST_LOG_COUNTS_CHANGED');
  }
}
export function validateBuildSecurityOutputEquivalence(execution, beforeAlias, afterAlias, successor, review, profile) {
  const pins = profile.compiledOutputEquivalence;
  equal([profile.schemaVersion, profile.id, pins?.status], [5, BUILD_SECURITY_BINDING_ID, 'passed'], 'BUILD_SECURITY_OUTPUT_EQUIVALENCE_PENDING');
  equal([execution.schemaVersion, execution.kind, execution.f2Source, execution.f3Source, execution.source, execution.artifactRole, execution.complete, execution.passed, execution.cleanSources, execution.cleanSource, execution.runtimeDependenciesEqual, execution.failedTests], [1, 'actual_fallback_compiled_output_equivalence', CP_PROTECTED_SOURCE, BUILD_SECURITY_SOURCE, BUILD_SECURITY_SOURCE, 'fallback', true, true, true, true, true, 0], 'BUILD_SECURITY_OUTPUT_EXECUTION_FAILED');
  equal([execution.npmCiExitCode, execution.f2NpmCiExitCode, execution.f3NpmCiExitCode, execution.f2BuildExitCode, execution.aliasExitCode, execution.f3BuildExitCode, execution.buildExitCode], [0, 0, 0, 0, 0, 0, 0], 'BUILD_SECURITY_OUTPUT_COMMAND_FAILED');
  assert.ok(Array.isArray(execution.commands) && execution.commands.length >= 2 && execution.commands.every(row => row.exitCode === 0), 'BUILD_SECURITY_OUTPUT_COMMAND_FAILED');
  equal(execution.changedCompiledFiles, [], 'BUILD_SECURITY_COMPILED_OUTPUT_CHANGED');
  equal([execution.beforeAliasSha256, execution.afterAliasSha256, execution.successorSha256], [pins.beforeAlias.sha256, pins.afterAlias.sha256, pins.successor.sha256], 'BUILD_SECURITY_OUTPUT_INVENTORY_CHANGED');
  const end = Date.parse(execution.observedAtUtc);
  assert.ok(Number.isFinite(end) && end >= Date.parse(BUILD_SECURITY_SOURCE_CREATED_AT), 'BUILD_SECURITY_OUTPUT_TIME_INVALID');
  for (const [record, source, phase] of [[beforeAlias, CP_PROTECTED_SOURCE, 'beforeAlias'], [afterAlias, CP_PROTECTED_SOURCE, 'afterAlias'], [successor, BUILD_SECURITY_SOURCE, 'successor']]) {
    equal([record.source, record.phase], [source, phase], 'BUILD_SECURITY_OUTPUT_SOURCE_CHANGED');
    assert.ok(Array.isArray(record.files) && record.files.length > 0 && record.files.length <= 10_000, 'BUILD_SECURITY_OUTPUT_FILES_REQUIRED');
    equal(new Set(record.files.map(row => row.path)).size, record.files.length, 'BUILD_SECURITY_OUTPUT_FILES_DUPLICATED');
    for (const file of record.files) {
      assert.ok(typeof file.path === 'string' && /^[A-Za-z0-9_./-]+$/.test(file.path) && !file.path.split('/').some(part => !part || part === '.' || part === '..'), 'BUILD_SECURITY_OUTPUT_PATH_INVALID');
      assert.match(file.sha256 ?? '', hashPattern, 'BUILD_SECURITY_OUTPUT_FILE_HASH_REQUIRED');
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'BUILD_SECURITY_OUTPUT_FILE_SIZE_REQUIRED');
    }
  }
  equal(execution.fileCount, beforeAlias.files.length, 'BUILD_SECURITY_OUTPUT_FILE_COUNT_CHANGED');
  equal(beforeAlias.files, afterAlias.files, 'BUILD_SECURITY_ALIAS_CHANGED_OUTPUT');
  equal(afterAlias.files, successor.files, 'BUILD_SECURITY_COMPILED_OUTPUT_CHANGED');
  equal([review.schemaVersion, review.kind, review.passed, review.fullIndependentReviewComplete, review.independentFromProducer, review.executionSha256], [1, 'release297_build_security_compiled_output_independent_review', true, true, true, pins.execution.sha256], 'BUILD_SECURITY_OUTPUT_REVIEW_REQUIRED');
  assert.ok(typeof review.producer === 'string' && review.producer.length > 0 && typeof review.reviewer === 'string' && review.reviewer.length > 0 && review.producer !== review.reviewer, 'BUILD_SECURITY_OUTPUT_REVIEW_NOT_INDEPENDENT');
  assert.ok(Date.parse(review.observedAtUtc) >= end, 'BUILD_SECURITY_OUTPUT_REVIEW_STALE');
}
export async function validateSuccessorPreparation(input, { root, run, fallback, sourceDirectory, source, now = Date.now }) {
  assert.ok(isSuccessorSchema(bindingSchema(input)), 'SUCCESSOR_PREPARATION_SCHEMA_REQUIRED');
  const filename = BINDING_FILES[input.releaseBindingId], local = JSON.parse(ordinaryText(root, filename));
  validateSuccessorProfile(local, fallback);
  const profileRecord = await committedJson(root, filename, run), profile = profileRecord.value;
  const buildFallback = profile.schemaVersion === 5;
  const protectedFallback = isProtectedSchema(profile.schemaVersion);
  const fallbackSource = protectedFallback ? protectedSource(profile) : SUCCESSOR_SOURCE;
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
  const sourceDelta = buildFallback ? await validateBuildSecuritySuccessorSourceDelta(input.fallbackDirectory, run) : protectedFallback ? await validateProtectedSuccessorSourceDelta(input.fallbackDirectory, run) : await validateSuccessorSourceDelta(input.fallbackDirectory, fallback, run);
  equal(await imageInputInventory(input.fallbackDirectory, fallbackSource, run), profile.fallbackInventory, 'SUCCESSOR_INVENTORY_CHANGED');
  equal(sourceDelta, profile.sourceDelta, 'SUCCESSOR_SOURCE_DELTA_RECEIPT_CHANGED');
  const context = { fallback, sourceDirectory: applicationDirectory, outputDirectory: input.outputDirectory, extraSourceDirectories: [input.fallbackDirectory] };
  if (buildFallback) await loadBuildSecurityCurrentRuntime(profile, record => retainedArtifact(record, root, input, run, context));
  if (protectedFallback) {
    const audit = await retainedArtifact(profile.buildDependencyAudit.audit, root, input, run, context);
    const sourceChecks = await retainedArtifact(profile.buildDependencyAudit.sourceChecks, root, input, run, context);
    validateProtectedBuildDependencyAudit(audit, sourceChecks, profile);
    equal((await git(run, input.fallbackDirectory, ['rev-parse', `${fallbackSource}:package-lock.json`])).trim(), profile.buildDependencyAudit.lockfileGitBlob, 'CP_PROTECTED_BUILD_AUDIT_SOURCE_CHANGED');
    if (buildFallback) {
      await replayBuildSecurityRawEvidence(sourceChecks.rawEvidence, record => retainedArtifact(record, root, input, run, context));
      for (const key of ['unit', 'credentialBoundarySynthetic']) {
        const result = sourceChecks.checks[key], filename = await retainedArtifact(result.evidence, root, input, run, context);
        validateBuildSecurityTestLog(readFileSync(filename, 'utf8'), result.evidence);
      }
    }
  }
  if (buildFallback) {
    const records = await Promise.all(['execution', 'beforeAlias', 'afterAlias', 'successor', 'independentReview'].map(key => retainedArtifact(profile.compiledOutputEquivalence[key], root, input, run, context)));
    validateBuildSecurityOutputEquivalence(...records, profile);
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
    if (buildFallback) await replayBuildSecurityRawEvidence(native.rawEvidence, load);
    else for (const record of native.rawEvidence) await load(record);
    if (protectedFallback && key !== 'successorScan') {
      assert.ok(native.executionReceipt && native.rawEvidence.some(record => record.sha256 === native.executionReceipt.sha256 && record.path === native.executionReceipt.path), 'CP_PROTECTED_EXECUTION_RECEIPT_REQUIRED');
      const execution = await load(native.executionReceipt);
      if (buildFallback && ['ordinaryRecovery', 'restrictedRestoration'].includes(key)) await validateBuildSecurityExecutionPair(execution, native, profile, input.retainedEvidenceDirectory, load);
      validateProtectedExecutionEvidence(execution, native, profile, key);
      if (key === 'restrictedRestoration') {
        assert.ok(native.serviceExecutionReceipt && native.rawEvidence.some(record => record.sha256 === native.serviceExecutionReceipt.sha256 && record.path === native.serviceExecutionReceipt.path), 'CP_PROTECTED_EXECUTION_RECEIPT_REQUIRED');
        const serviceExecution = await load(native.serviceExecutionReceipt);
        if (buildFallback) await validateBuildSecurityExecutionPair(serviceExecution, native, profile, input.retainedEvidenceDirectory, load);
        if (buildFallback && execution.sealedServiceReplay?.sha256 !== native.serviceExecutionReceipt.sha256) {
          const applicability = native.restrictedReplayApplicability;
          equal(applicability?.currentActualReplay,native.serviceExecutionReceipt,'BUILD_SECURITY_RESTRICTED_CURRENT_REPLAY_CHANGED');
          const priorRecord = applicability?.priorActualReplay;
          assert.ok(priorRecord && native.rawEvidence.some(record => record.sha256 === priorRecord.sha256 && record.path === priorRecord.path), 'BUILD_SECURITY_RESTRICTED_PRIOR_REPLAY_REQUIRED');
          const prior = await load(priorRecord);
          const fallbackProof = async value => {
            const record = native.rawEvidence.find(record => path.resolve(input.retainedEvidenceDirectory,record.path) === path.resolve(value.fallbackDefault.file) && record.sha256 === value.fallbackDefault.sha256);
            assert.ok(record,'BUILD_SECURITY_RESTRICTED_FALLBACK_PROOF_REQUIRED'); return load(record);
          };
          validateBuildSecurityRestrictedReplayApplicability(prior,serviceExecution,await fallbackProof(prior),await fallbackProof(serviceExecution),applicability,execution,profile);
        } else equal(execution.sealedServiceReplay?.sha256, native.serviceExecutionReceipt.sha256, 'CP_PROTECTED_RESTORATION_SERVICE_REPLAY_CHANGED');
        validateProtectedExecutionEvidence(serviceExecution, native, profile, 'ordinaryRecovery');
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
