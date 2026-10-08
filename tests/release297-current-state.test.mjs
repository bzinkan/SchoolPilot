import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BEGIN, END, CHECKLIST, INDEX, ROOT, validateIndex, renderStatus, updateChecklist } from '../scripts/release297-current-state.mjs';

const index = () => JSON.parse(readFileSync(path.join(ROOT, INDEX), 'utf8'));
function receiptFixture(work) {
  const candidate = index(), fixture = mkdtempSync(path.join(tmpdir(), 'release297-state-refresh-'));
  try {
    for (const entry of Object.values(candidate.evidence)) {
      const filename = path.join(fixture, entry.path); mkdirSync(path.dirname(filename), { recursive: true });
      copyFileSync(path.join(ROOT, entry.path), filename);
    }
    const read = id => JSON.parse(readFileSync(path.join(fixture, candidate.evidence[id].path), 'utf8'));
    const write = (id, value, relative = candidate.evidence[id].path) => {
      const bytes = JSON.stringify(value, null, 2) + '\n', filename = path.join(fixture, relative);
      mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, bytes);
      candidate.evidence[id] = { path: relative, gitBlobSha256: createHash('sha256').update(bytes).digest('hex') };
    };
    work(candidate, fixture, read, write);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()));
    assert.ok(path.basename(fixture).startsWith('release297-state-refresh-'));
    rmSync(fixture, { recursive: true, force: true });
  }
}
function advancedObservation(candidate, read, write) {
  const source = 'a'.repeat(40), current = read('reconciliation');
  current.schoolpilotRemoteMain = source;
  current.currentMainCi = { source, event: 'push', branch: 'main', status: 'pending', checks: [], workflowRuns: {} };
  current.recordedAsOf = { kind: 'before_closing_pr_merge', closingPullRequest: 619, closingMergeSha: null, pendingMergePullRequests: [619, 620], resultingMainCiStatus: 'pending' };
  current.preparationPullRequests = [616, 617, 619, 620].map(number => ({ number, state: 'OPEN', headRefOid: candidate.sources.schoolpilot.planningReference, mergeCommit: null, mergedAt: null }));
  candidate.sources.schoolpilot.remoteMainObserved = source;
  for (const pr of candidate.inclusionMatrix) if (pr.repository === 'SchoolPilot') pr.includedInSource = source;
  const gate = candidate.gates.find(entry => entry.id === 'current-main-preparation-ci');
  const next = { id: 'current-main-preparation-ci', label: 'Observed main preparation CI', status: 'pending', applicability: 'current_baseline', sourceSha: source, rationale: 'Fixture main changed; exact-push checks pending.', observedAtUtc: candidate.observedAtUtc, evidence: ['reconciliation'], nextAction: 'Wait for actual main push checks.' };
  if (gate) Object.assign(gate, next); else candidate.gates.push(next);
  write('reconciliation', current, 'docs/releases/release297/fixture-current-source.json');
  return current;
}
test('canonical current state verifies receipt hashes and generated checklist without writes', () => {
  const before = readFileSync(path.join(ROOT, CHECKLIST));
  validateIndex(index());
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release297-current-state.mjs'), '--check'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(path.join(ROOT, CHECKLIST)), before);
});
test('historical passing measurements cannot be assigned to a pending successor', () => {
  const candidate = index();
  const gate = candidate.gates.find(entry => entry.id === 'mixed-successor');
  gate.status = 'passed'; gate.evidence = ['classroomHistorical'];
  assert.throws(() => validateIndex(candidate), /PENDING_CANDIDATE_CANNOT_PASS/);
});
test('ordinary recovery cannot be relabeled as the optional 54-entry fixture', () => {
  const candidate = index(); candidate.compatibility.ordinaryMigrationPath = [43, 54];
  assert.throws(() => validateIndex(candidate), /ORDINARY_MIGRATION_PATH_CHANGED/);
});
test('current-state record cannot authorize an operation or substitute a fallback', () => {
  const candidate = index(); candidate.authorization.registryPublication = true;
  assert.throws(() => validateIndex(candidate), /INDEX_IS_NOT_OPERATIONAL_AUTHORIZATION/);
  candidate.authorization.registryPublication = false;
  candidate.compatibility.retainedFallbackSource = candidate.sources.schoolpilot.remoteMainObserved;
  assert.throws(() => validateIndex(candidate), /FALLBACK_SUBSTITUTED/);
});
test('CP-AI preparation renders the new observed main while preserving dated source reconciliation', () => {
  const candidate = index();
  const originalMain = candidate.sources.schoolpilot.remoteMainObserved;
  const cp = JSON.parse(readFileSync(path.join(ROOT, candidate.evidence.cpAiBoundaryPreparation.path), 'utf8'));
  const rendered = renderStatus(validateIndex(candidate));
  assert.match(rendered, new RegExp(`Newly observed SchoolPilot main baseline:.*${cp.observedMainBaseline.slice(0, 8)}`));
  assert.match(rendered, /Historical reconciled main snapshot/);
  assert.match(rendered, /Unchanged F restores the prior provider boundary/);
  assert.equal(candidate.sources.schoolpilot.remoteMainObserved, originalMain);
});
test('CP-AI source-only preparation cannot approve deployment, live protection or a changed historical recovery pair', () => {
  for (const field of ['reviewStatus', 'deploymentStatus', 'liveVerificationStatus']) {
    receiptFixture((candidate, fixture, read, write) => {
      const cp = read('cpAiBoundaryPreparation'); cp[field] = 'passed'; write('cpAiBoundaryPreparation', cp);
      const id = field === 'reviewStatus' ? 'review' : field === 'deploymentStatus' ? 'deployment' : 'live';
      const gate = candidate.gates.find(entry => entry.id === `cp-ai-001-${id}`);
      Object.assign(gate, {status: 'passed', applicability: 'preparation_only'});
      assert.throws(() => validateIndex(candidate, fixture), /CP_AI_PREPARATION_CANNOT_APPROVE_OPERATION/);
    });
  }
  receiptFixture((candidate, fixture, read, write) => {
    const cp = read('cpAiBoundaryPreparation'); cp.unchangedFallbackSourceF = 'f'.repeat(40); write('cpAiBoundaryPreparation', cp);
    assert.throws(() => validateIndex(candidate, fixture), /CP_AI_HISTORICAL_PAIR_CHANGED/);
  });
});
test('CP-AI synthetic success requires exact-source positive boundary execution and source hashes', () => {
  const completed = (candidate, read) => {
    const cp = read('cpAiBoundaryPreparation');
    cp.testedSource = 'a'.repeat(40);
    cp.syntheticValidationStatus = 'passed';
    cp.sourceAndTestHashes = Object.fromEntries(['src/services/classpilotAiRequestInput.ts', 'src/services/aiClassification.ts', 'tests/classpilot-provider-boundary-audit.test.ts'].map(filename => [filename, 'b'.repeat(64)]));
    cp.steps = [{id: 'boundary-focused', source: cp.testedSource, command: 'node --import tsx --test tests/classpilot-provider-boundary-audit.test.ts', status: 'passed', exitCode: 0, tests: 5, passed: 5, failed: 0, skipped: 0, logSha256: 'c'.repeat(64)}];
    for (const id of ['implementation', 'synthetic', 'review', 'deployment', 'live']) candidate.gates.find(entry => entry.id === `cp-ai-001-${id}`).sourceSha = cp.testedSource;
    candidate.gates.find(entry => entry.id === 'cp-ai-001-synthetic').status = 'passed';
    return cp;
  };
  receiptFixture((candidate, fixture, read, write) => {
    write('cpAiBoundaryPreparation', completed(candidate, read));
    validateIndex(candidate, fixture);
  });
  for (const [mutation, expected] of [
    [cp => { cp.steps = []; }, /CP_AI_SYNTHETIC_BOUNDARY_STEP_REQUIRED/],
    [cp => { cp.steps[0].source = 'd'.repeat(40); }, /CP_AI_SYNTHETIC_BOUNDARY_OUTCOME_CHANGED/],
    [cp => { cp.steps[0].failed = 1; }, /CP_AI_SYNTHETIC_BOUNDARY_OUTCOME_CHANGED/],
    [cp => { cp.steps[0].skipped = 1; }, /CP_AI_SYNTHETIC_BOUNDARY_OUTCOME_CHANGED/],
    [cp => { cp.steps[0].exitCode = 1; }, /CP_AI_SYNTHETIC_BOUNDARY_OUTCOME_CHANGED/],
    [cp => { cp.steps[0].tests = 0; cp.steps[0].passed = 0; }, /CP_AI_SYNTHETIC_POSITIVE_COUNTS_REQUIRED/],
    [cp => { cp.steps[0].command = 'node --test tests/unrelated.test.ts'; }, /CP_AI_SYNTHETIC_BOUNDARY_COMMAND_REQUIRED/],
    [cp => { delete cp.sourceAndTestHashes['src/services/classpilotAiRequestInput.ts']; }, /CP_AI_SYNTHETIC_SOURCE_HASH_REQUIRED/],
    [cp => { cp.sourceAndTestHashes['tests/classpilot-provider-boundary-audit.test.ts'] = 'invalid'; }, /CP_AI_SYNTHETIC_SOURCE_HASH_REQUIRED/],
  ]) {
    receiptFixture((candidate, fixture, read, write) => {
      const cp = completed(candidate, read); mutation(cp); write('cpAiBoundaryPreparation', cp);
      assert.throws(() => validateIndex(candidate, fixture), expected);
    });
  }
});
test('fresh main observations do not relabel the immutable original baseline receipts', () => {
  receiptFixture((candidate, fixture, read, write) => {
    advancedObservation(candidate, read, write);
    validateIndex(candidate, fixture);
    assert.notEqual(read('localArtifactsFresh').baseline, candidate.sources.schoolpilot.remoteMainObserved);
    candidate.gates.find(entry => entry.id === 'baseline-ci').applicability = 'current_baseline';
    assert.throws(() => validateIndex(candidate, fixture), /ORIGINAL_BASELINE_CI_RECLASSIFIED/);
    candidate.gates.find(entry => entry.id === 'baseline-ci').applicability = 'historical';
    candidate.gates.find(entry => entry.id === 'baseline-ci').sourceSha = candidate.sources.schoolpilot.remoteMainObserved;
    assert.throws(() => validateIndex(candidate, fixture), /ORIGINAL_BASELINE_CI_RECLASSIFIED/);
  });
});
test('scoped human merge request cannot authorize another PR or release operations', () => {
  receiptFixture((candidate, fixture, read, write) => {
    const request = read('mergeRequest'); request.pullRequests.push(621); write('mergeRequest', request);
    assert.throws(() => validateIndex(candidate, fixture), /MERGE_REQUEST_SCOPE_CHANGED/);
  });
  const candidate = index(); candidate.authorization.merge = true;
  assert.throws(() => validateIndex(candidate), /INDEX_IS_NOT_OPERATIONAL_AUTHORIZATION/);
});
test('operator Store version does not establish uploaded ZIP, independent capture or managed adoption', () => {
  for (const [field, value, error] of [['uploadedZipSha256', 'f'.repeat(64), 'STORE_REPORT_IS_NOT_PACKAGE_OR_ADOPTION_PROOF'], ['managedAdoptionState', 'passed', 'STORE_REPORT_IS_NOT_PACKAGE_OR_ADOPTION_PROOF'], ['verificationMethod', 'fresh_store_capture', 'STORE_OPERATOR_REPORT_CHANGED']]) {
    receiptFixture((candidate, fixture, read, write) => {
      const store = read('operatorStoreVersion'); store[field] = value; write('operatorStoreVersion', store);
      assert.throws(() => validateIndex(candidate, fixture), new RegExp(error));
    });
  }
});
test('PR workflow evidence and invented closing merge cannot satisfy exact-push main CI', () => {
  receiptFixture((candidate, fixture, read, write) => {
    const current = advancedObservation(candidate, read, write), ci = current.currentMainCi;
    ci.checks.push({ name: 'Backend (TypeScript + Build)', headSha: ci.source, status: 'completed', conclusion: 'success', url: 'https://github.com/bzinkan/SchoolPilot/actions/runs/123/job/456' });
    ci.workflowRuns['123'] = { id: 123, event: 'pull_request', head_branch: 'main', head_sha: ci.source, html_url: 'https://github.com/bzinkan/SchoolPilot/actions/runs/123' };
    write('reconciliation', current);
    assert.throws(() => validateIndex(candidate, fixture), /CURRENT_MAIN_WORKFLOW_IS_NOT_PUSH_MAIN/);
    ci.workflowRuns['123'].event = 'push'; ci.status = 'passed'; write('reconciliation', current);
    assert.throws(() => validateIndex(candidate, fixture), /CURRENT_MAIN_CI_OUTCOME_CHANGED/);
    ci.status = 'pending'; current.recordedAsOf.closingMergeSha = 'f'.repeat(40); write('reconciliation', current);
    assert.throws(() => validateIndex(candidate, fixture), /FUTURE_CLOSING_MERGE_REJECTED/);
  });
});

test('post-closing observations require every actual merge and the exact closing main', () => {
  receiptFixture((candidate, fixture, read, write) => {
    const current = read('reconciliation');
    assert.equal(current.recordedAsOf.kind, 'after_closing_pr_merge');
    assert.equal(current.currentMainCi.status, 'passed');
    validateIndex(candidate, fixture);
    current.recordedAsOf.closingMergeSha = 'f'.repeat(40); write('reconciliation', current);
    assert.throws(() => validateIndex(candidate, fixture), /CLOSING_MERGE_OBSERVATION_CHANGED/);
  });
  receiptFixture((candidate, fixture, read, write) => {
    const current = read('reconciliation'), tooling = current.preparationPullRequests.find(pr => pr.number === 620);
    Object.assign(tooling, { state: 'OPEN', mergeCommit: null, mergedAt: null }); write('reconciliation', current);
    assert.throws(() => validateIndex(candidate, fixture), /CLOSING_MERGES_REQUIRED/);
  });
});

test('dependency-only successor source evidence cannot broaden the patch or select an artifact', () => {
  for (const [field, value, error] of [['changedPaths', ['package-lock.json', 'src/app.ts'], 'SUCCESSOR_SOURCE_SCOPE_BROADENED'], ['entireCurrentMainLockfileCopied', true, 'SUCCESSOR_LOCKFILE_REVIEW_INCOMPLETE'], ['humanReplacementSelectionRecorded', true, 'SUCCESSOR_SOURCE_REVIEW_IS_NOT_SELECTION']]) {
    receiptFixture((candidate, fixture, read, write) => {
      const review = read('successorSourceReview'); review[field] = value; write('successorSourceReview', review);
      assert.throws(() => validateIndex(candidate, fixture), new RegExp(error));
    });
  }
  const candidate = index(); candidate.gates.find(entry => entry.id === 'fallback-successor-source').applicability = 'current_baseline';
  assert.throws(() => validateIndex(candidate), /SUCCESSOR_SOURCE_GATE_CHANGED/);
});
test('new Usage activation, absent daily mode and unknown evidence fail validation', () => {
  let candidate = index(); candidate.usageModes.CLASSPILOT_USAGE_ROLLUP_MODE.requiredValue = 'on';
  assert.throws(() => validateIndex(candidate), /NEW_USAGE_MODE_MUST_STAY_OFF/);
  candidate = index(); delete candidate.usageModes.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE;
  assert.throws(() => validateIndex(candidate), /INDEX_FIELDS_INVALID/);
  candidate = index(); candidate.gates[0].evidence.push('inventedReceipt');
  assert.throws(() => validateIndex(candidate), /EVIDENCE_REFERENCE_UNKNOWN/);
});

test('successful successor preparation cannot select, authorize or relabel the fallback artifact', () => {
  const candidate = index();
  candidate.gates.find(entry => entry.id === 'fallback-successor-selection').status = 'passed';
  assert.throws(() => validateIndex(candidate), /SUCCESSOR_SELECTION_CANNOT_BE_INFERRED/);
  candidate.gates.find(entry => entry.id === 'fallback-successor-selection').status = 'pending';
  candidate.artifacts.find(entry => entry.id === 'fallback-successor-artifact').sourceSha = candidate.artifacts.find(entry => entry.id === 'backend-successor-anchor').sourceSha;
  assert.throws(() => validateIndex(candidate), /SUCCESSOR_ARTIFACT_ROLE_CHANGED/);
  receiptFixture((candidate, fixture, read, write) => {
    const proof = read('successorPreparationObservation'); proof.operationalAuthorization = true;
    write('successorPreparationObservation', proof);
    assert.throws(() => validateIndex(candidate, fixture), /SUCCESSOR_PREPARATION_IS_NOT_SELECTION/);
  });
  receiptFixture((candidate, fixture, read, write) => {
    const proof = read('successorPreparationObservation'); proof.cloudMutations = 1;
    write('successorPreparationObservation', proof);
    assert.throws(() => validateIndex(candidate, fixture), /SUCCESSOR_PREPARATION_MUST_REMAIN_OFFLINE/);
  });
});

test('successor status rejects changed binding and cross-role evidence even with updated file hashes', () => {
  receiptFixture((candidate, fixture, read, write) => {
    const proof = read('successorPreparationObservation');
    const ref = proof.preparationEvidence.ordinaryRecovery, native = read(ref);
    native.artifactPair.fallback = structuredClone(native.artifactPair['serving-anchor']);
    write(ref, native);
    assert.throws(() => validateIndex(candidate, fixture), /SUCCESSOR_BINDING_RECEIPT_CHANGED/);
    const binding = read('successorBinding');
    binding.preparation.evidence.ordinaryRecovery.sha256 = candidate.evidence[ref].gitBlobSha256;
    write('successorBinding', binding); proof.bindingSha256 = candidate.evidence.successorBinding.gitBlobSha256;
    write('successorPreparationObservation', proof);
    assert.throws(() => validateIndex(candidate, fixture), /SUCCESSOR_PREPARATION_ROLE_OR_RECEIPT_CHANGED/);
  });
  receiptFixture((candidate, fixture, read, write) => {
    const binding = read('successorBinding'); binding.status = 'accepted'; write('successorBinding', binding);
    const proof = read('successorPreparationObservation'); proof.bindingSha256 = candidate.evidence.successorBinding.gitBlobSha256;
    write('successorPreparationObservation', proof);
    assert.throws(() => validateIndex(candidate, fixture), /SUCCESSOR_BINDING_IS_NOT_RELEASE_ACCEPTANCE/);
  });
  receiptFixture((candidate, fixture, read, write) => {
    const proof = read('successorPreparationObservation'), ref = proof.preparationEvidence.successorScan, native = read(ref);
    native.operationalAuthorization = true; write(ref, native);
    const binding = read('successorBinding'); binding.preparation.evidence.successorScan.sha256 = candidate.evidence[ref].gitBlobSha256;
    write('successorBinding', binding); proof.bindingSha256 = candidate.evidence.successorBinding.gitBlobSha256;
    write('successorPreparationObservation', proof);
    assert.throws(() => validateIndex(candidate, fixture), /SUCCESSOR_WRAPPER_IS_NOT_AUTHORIZATION/);
  });
});
test('public metadata rejects private records and escaping receipt paths', () => {
  let candidate = index(); candidate.artifacts[0].studentEmail = 'synthetic@example.invalid';
  assert.throws(() => validateIndex(candidate), /PRIVATE_DATA_FIELD_REJECTED/);
  candidate = index(); candidate.evidence.reconciliation.path = 'docs/../private-capture.json';
  assert.throws(() => validateIndex(candidate), /PUBLIC_EVIDENCE_PATH_REQUIRED/);
});

test('targeted fixture success cannot relabel the failed complete F database command', () => {
  const candidate = index();
  candidate.gates.find(entry => entry.id === 'fallback-successor-f-db').status = 'passed';
  assert.throws(() => validateIndex(candidate), /SUCCESSOR_SOURCE_CHECK_GATE_RECLASSIFIED/);
  receiptFixture((current, fixture, read, write) => {
    const checks = read('successorSourceChecks');
    checks.steps.find(entry => entry.command === 'npm run test:db-serial').counts.fail = 0;
    write('successorSourceChecks', checks);
    assert.throws(() => validateIndex(current, fixture), /SUCCESSOR_ORIGINAL_TEST_COUNTS_CHANGED/);
  });
  receiptFixture((current, fixture, read, write) => {
    const checks = read('successorSourceChecks');
    checks.correctedScreenshotFixture.compiledModuleIdentity.imageInventorySha256 = '0'.repeat(64);
    write('successorSourceChecks', checks);
    assert.throws(() => validateIndex(current, fixture), /SUCCESSOR_FIXTURE_REQUIRES_IMAGE_EQUIVALENCE/);
  });
});
test('retained receipt modification is detected without modifying the original', () => {
  const candidate = index(), fixture = mkdtempSync(path.join(tmpdir(), 'release297-state-'));
  try {
    for (const entry of Object.values(candidate.evidence)) {
      const filename = path.join(fixture, entry.path); mkdirSync(path.dirname(filename), { recursive: true });
      copyFileSync(path.join(ROOT, entry.path), filename);
    }
    validateIndex(candidate, fixture);
    // Windows text checkouts and Linux Git blobs must identify the same receipt.
    const observation = path.join(fixture, candidate.evidence.reconciliation.path);
    writeFileSync(observation, readFileSync(observation, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    validateIndex(candidate, fixture);
    writeFileSync(path.join(fixture, candidate.evidence.classroomHistorical.path), '{}\n');
    assert.throws(() => validateIndex(candidate, fixture), /EVIDENCE_BYTES_CHANGED/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
test('artifact metadata cannot detach from the retained receipt or reclassify a raw package failure', () => {
  let candidate = index(); candidate.artifacts.find(entry => entry.id === 'backend-ddc').identity.archiveSha256 = '0'.repeat(64);
  assert.throws(() => validateIndex(candidate), /ARTIFACT_RECEIPT_CHANGED/);
  candidate = index(); candidate.gates.find(entry => entry.id === 'extension-raw-git').status = 'passed';
  assert.throws(() => validateIndex(candidate), /RAW_PACKAGE_FAILURE_RECLASSIFIED/);
});

test('fresh retained-fallback failure remains a blocker beside historical scan evidence', () => {
  let candidate = index();
  assert.equal(candidate.artifacts.find(entry => entry.id === 'fallback-c578').status, 'passed');
  assert.equal(candidate.gates.find(entry => entry.id === 'fallback-scan-current').status, 'failed');
  candidate.gates.find(entry => entry.id === 'fallback-scan-current').status = 'passed';
  assert.throws(() => validateIndex(candidate), /FALLBACK_SCAN_HISTORY_RECLASSIFIED/);
  candidate = index(); candidate.artifacts.find(entry => entry.id === 'fallback-c578').status = 'failed';
  assert.throws(() => validateIndex(candidate), /FALLBACK_SCAN_HISTORY_RECLASSIFIED/);
  assert.match(renderStatus(index()), /Release blocker: the exact retained C578 fallback freshly fails/);
});

test('preparation artifacts and screenshot checks cannot become frozen-candidate evidence', () => {
  let candidate = index();
  candidate.artifacts.find(entry => entry.id === 'backend-preparation').sourceSha = candidate.sources.schoolpilot.remoteMainObserved;
  assert.throws(() => validateIndex(candidate), /PREPARATION_BACKEND_RECEIPT_CHANGED/);
  candidate = index(); candidate.artifacts.find(entry => entry.id === 'frontend-preparation').identity.archiveSha256 = '0'.repeat(64);
  assert.throws(() => validateIndex(candidate), /PREPARATION_FRONTEND_RECEIPT_CHANGED/);
  candidate = index(); candidate.gates.find(entry => entry.id === 'screenshot-preparation').applicability = 'current_baseline';
  assert.throws(() => validateIndex(candidate), /PREPARATION_GATE_RECEIPT_CHANGED/);
});
test('focused newline reruns preserve original full infrastructure failure and pending full rerun', () => {
  let candidate = index();
  candidate.gates.find(entry => entry.id === 'baseline-infrastructure').status = 'passed';
  assert.throws(() => validateIndex(candidate), /FULL_INFRASTRUCTURE_FAILURE_RECLASSIFIED/);
  candidate = index(); candidate.gates.find(entry => entry.id === 'full-infrastructure-after-fix').status = 'passed';
  assert.throws(() => validateIndex(candidate), /FOCUSED_RERUN_IS_NOT_FULL_INFRASTRUCTURE/);
  candidate = index(); candidate.gates.find(entry => entry.id === 'focused-role-rerun').sourceSha = candidate.sources.schoolpilot.remoteMainObserved;
  assert.throws(() => validateIndex(candidate), /FOCUSED_RERUN_APPLICABILITY_CHANGED/);
});
test('PR CI and full-schema RLS fixture passes cannot establish exact-main or release recovery', () => {
  let candidate = index();
  candidate.gates.find(entry => entry.id === 'public-copy-preparation-ci').applicability = 'current_baseline';
  assert.throws(() => validateIndex(candidate), /PR_CI_IS_NOT_EXACT_MAIN/);
  candidate = index(); candidate.gates.find(entry => entry.id === 'restricted-database-preparation').applicability = 'current_baseline';
  assert.throws(() => validateIndex(candidate), /DATABASE_FIXTURE_IS_NOT_RELEASE_RECOVERY/);
});
test('moved dated summaries retain their recorded canonical content hashes', () => {
  const history = readFileSync(path.join(ROOT, 'docs/RELEASE_2_9_7_PREPARATION_HISTORY.md'), 'utf8').replaceAll('\r\n', '\n');
  const pattern = /Canonical block SHA-256: `([a-f0-9]{64})`\. Only line endings are normalized\.\n\n<!-- historical-block:([^:]+):start -->\n([\s\S]*?)<!-- historical-block:\2:end -->/g;
  const blocks = [...history.matchAll(pattern)];
  assert.equal(blocks.length, 4);
  for (const [, hash, , block] of blocks) assert.equal(createHash('sha256').update(block).digest('hex'), hash, 'ARCHIVED_CHECKPOINT_CHANGED');
});
test('rendering preserves historical text and refuses duplicate/missing markers', () => {
  const prefix = '# Checklist\n\n', suffix = '\n\n## Historical\nOriginal failed status.\n';
  const before = `${prefix}${BEGIN}\nold\n${END}${suffix}`;
  const rendered = renderStatus(index());
  const after = updateChecklist(before, rendered);
  assert.equal(after, `${prefix}${rendered}${suffix}`);
  assert.equal(updateChecklist(after, rendered), after);
  assert.throws(() => updateChecklist(after + BEGIN, rendered), /GENERATED_MARKERS_INVALID/);
  assert.throws(() => updateChecklist(prefix + suffix, rendered), /GENERATED_MARKERS_INVALID/);
  assert.match(rendered, /waived_not_passed/);
  assert.match(rendered, /SchoolPilot #603/);
  assert.match(rendered, /historical; `ddc5996b`/);
});
