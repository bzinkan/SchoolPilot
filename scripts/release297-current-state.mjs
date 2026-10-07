#!/usr/bin/env node
// Offline documentation generation only; no provider, runtime or release operations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX = 'docs/releases/release297/current-release.json';
export const CHECKLIST = 'docs/RELEASE_2_9_7_OPERATOR_CHECKLIST.md';
export const BEGIN = '<!-- release297-current-state:start -->';
export const END = '<!-- release297-current-state:end -->';
export const STATUSES = Object.freeze(['passed', 'failed', 'pending', 'unknown', 'waived_not_passed', 'not_applicable']);
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
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
export function validateIndex(index, root = ROOT) {
  sameKeys(index, ['schemaVersion', 'kind', 'releaseId', 'observedAtUtc', 'audience', 'authorization', 'sources', 'usageModes', 'compatibility', 'artifacts', 'stages', 'gates', 'inclusionMatrix', 'evidence']);
  assert.equal(index.schemaVersion, 1, 'INDEX_SCHEMA_INVALID');
  assert.equal(index.kind, 'current_release_index', 'INDEX_KIND_INVALID');
  assert.equal(index.releaseId, 'release297-desales133-usage-off', 'RELEASE_ID_INVALID');
  assert.ok(stamp(index.observedAtUtc), 'OBSERVATION_TIME_REQUIRED');
  assert.deepEqual(index.audience, { school: 'DeSales', clients: 133, validationLevel: 'synthetic_only', managedValidation: 'waived_not_passed' }, 'AUDIENCE_CHANGED');
  sameKeys(index.authorization, ['merge', 'productionDeployment', 'registryPublication', 'inactiveRegistration', 'storeSubmission', 'runtimeActivation', 'githubSettings']);
  assert.ok(Object.values(index.authorization).every(value => value === false), 'INDEX_IS_NOT_OPERATIONAL_AUTHORIZATION');
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
          const keys = record.id === 'frontend-historical' ? ['archiveSha256'] : record.id === 'frontend-preparation' ? ['archiveSha256', 'fileInventorySha256'] : record.id === 'backend-preparation' ? ['localImageId', 'configDigest', 'archiveSha256', 'reportSha256'] : ['indexDigest', 'platformManifestDigest', 'configDigest', 'archiveSha256'];
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
  const receipt = id => JSON.parse(readFileSync(path.join(root, index.evidence[id].path), 'utf8'));
  const reconciliation = receipt('reconciliation');
  assert.equal(index.sources.schoolpilot.remoteMainObserved, reconciliation.schoolpilotRemoteMain, 'SOURCE_OBSERVATION_CHANGED');
  assert.equal(index.sources.classpilot.remoteMainObserved, reconciliation.classpilotRemoteMain, 'SOURCE_OBSERVATION_CHANGED');
  for (const entry of index.inclusionMatrix) {
    const observed = entry.repository === 'SchoolPilot' ? reconciliation.schoolpilotPullRequests.find(pr => pr.number === entry.number) : reconciliation.classpilotPullRequest;
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
  assert.deepEqual([local.schemaVersion, local.kind, local.baseline, local.frozenReleaseReference, local.applicability.releaseReady, local.applicability.preparationSourceIsCurrentMain], [1, 'local_preparation_artifact_observation', index.sources.schoolpilot.remoteMainObserved, null, false, false], 'PREPARATION_APPLICABILITY_CHANGED');
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
  assert.deepEqual([focused.kind, focused.baselineSource, focused.originalInfrastructure.status, focused.originalInfrastructure.counts, focused.fullInfrastructureRerun, focused.releaseReadiness], ['focused_coordinator_newline_tooling_check', index.sources.schoolpilot.remoteMainObserved, 'failed', { tests: 1051, pass: 1048, fail: 3, skipped: 0 }, 'pending', false], 'FULL_INFRASTRUCTURE_HISTORY_CHANGED');
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
  assert.deepEqual([followups.baseline.source, followups.baseline.backendType, followups.baseline.backendBuild, followups.baseline.unit.status, followups.baseline.unit.counts, followups.baseline.governance.status], [index.sources.schoolpilot.remoteMainObserved, 'passed', 'passed', 'passed', { tests: 2276, pass: 2272, fail: 0, skipped: 4 }, 'passed'], 'BASELINE_PREPARATION_RESULTS_CHANGED');
  state('baseline-local-checks', 'passed', followups.baseline.source, ['preparationFollowups'], 'BASELINE_PREPARATION_APPLICABILITY_CHANGED');
  assert.deepEqual([followups.publicCopyCi.pullRequest, followups.publicCopyCi.event, followups.publicCopyCi.exactMainCi, followups.publicCopyCi.applicableChecksPassed, followups.publicCopyCi.emittedChecks, followups.publicCopyCi.successes, followups.publicCopyCi.failures, followups.publicCopyCi.skipped], [617, 'pull_request', false, true, 19, 18, 0, 1], 'PR_PREPARATION_CI_CHANGED');
  state('public-copy-preparation-ci', 'passed', followups.publicCopyCi.headSha, ['preparationFollowups'], 'PR_CI_IS_NOT_EXACT_MAIN');
  assert.deepEqual([followups.database.source, followups.database.scope, followups.database.productionAccess, followups.database.originalOrdinary.fail, followups.database.correctedRedis.pass, followups.database.correctedRedis.fail, followups.database.restrictedLocal.pass, followups.database.restrictedLocal.fail, followups.database.restrictedLocal.rolsuper, followups.database.restrictedLocal.rolbypassrls, followups.database.restrictedLocal.uniqueAllowlist, followups.database.ciOrdinary.skipped, followups.database.ciRestricted.skipped, followups.database.extensionCaptureFixture.version], [followups.publicCopyCi.headSha, 'source_bound_full_schema_fixture_only', false, 4, 4, 0, 513, 0, false, false, 129, 8, 1, '2.9.3'], 'DATABASE_PREPARATION_HISTORY_CHANGED');
  state('restricted-database-preparation', 'passed', followups.database.source, ['preparationFollowups'], 'DATABASE_FIXTURE_IS_NOT_RELEASE_RECOVERY');
  return index;
}
const cell = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const short = value => value === null ? 'pending' : `\`${value.slice(0, 8)}\``;
export function renderStatus(index) {
  const lines = [BEGIN, '## Current release status', '', `Observed **${index.observedAtUtc}**. The [machine-readable index](releases/release297/current-release.json) is the current preparation record; dated evidence below remains historical. Regenerate with \`node scripts/release297-current-state.mjs\`; verify with \`--check\`.`, '', '**DeSales: 133 clients; both new Usage modes must be off. Candidate freeze and refreshed acceptance are pending. This record grants no operational authorization.**', '', '| Source | Current main observed | Historical tested application | Frozen successor |', '|---|---|---|---|'];
  if (index.gates.find(entry => entry.id === 'fallback-scan-current')?.status === 'failed') lines.splice(7, 0, '**Release blocker: the exact retained C578 fallback freshly fails its security scan. Its historical passing scan does not clear the failure; substituting another fallback is not authorized.**', '');
  for (const [repository, source] of Object.entries(index.sources)) lines.push(`| ${repository} | ${short(source.remoteMainObserved)} | ${short(source.testedHistorical)} | ${short(source.frozenApplicationReference)} |`);
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
  const after = updateChecklist(before, renderStatus(index));
  if (args[0] === '--check') assert.equal(before, after, 'GENERATED_CURRENT_STATUS_STALE');
  else if (before !== after) writeFileSync(filename, after);
  console.log(args[0] === '--check' ? 'Release297 current index/evidence/status verified (offline).' : 'Release297 current status generated (offline).');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
