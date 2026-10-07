import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BEGIN, END, CHECKLIST, INDEX, ROOT, validateIndex, renderStatus, updateChecklist } from '../scripts/release297-current-state.mjs';

const index = () => JSON.parse(readFileSync(path.join(ROOT, INDEX), 'utf8'));
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
test('new Usage activation, absent daily mode and unknown evidence fail validation', () => {
  let candidate = index(); candidate.usageModes.CLASSPILOT_USAGE_ROLLUP_MODE.requiredValue = 'on';
  assert.throws(() => validateIndex(candidate), /NEW_USAGE_MODE_MUST_STAY_OFF/);
  candidate = index(); delete candidate.usageModes.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE;
  assert.throws(() => validateIndex(candidate), /INDEX_FIELDS_INVALID/);
  candidate = index(); candidate.gates[0].evidence.push('inventedReceipt');
  assert.throws(() => validateIndex(candidate), /EVIDENCE_REFERENCE_UNKNOWN/);
});
test('public metadata rejects private records and escaping receipt paths', () => {
  let candidate = index(); candidate.artifacts[0].studentEmail = 'synthetic@example.invalid';
  assert.throws(() => validateIndex(candidate), /PRIVATE_DATA_FIELD_REJECTED/);
  candidate = index(); candidate.evidence.reconciliation.path = 'docs/../private-capture.json';
  assert.throws(() => validateIndex(candidate), /PUBLIC_EVIDENCE_PATH_REQUIRED/);
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
