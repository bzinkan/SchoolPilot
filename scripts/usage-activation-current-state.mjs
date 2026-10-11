#!/usr/bin/env node
// Offline status reporting. This record never authorizes an AWS operation or
// substitutes for the canonical campaign/evidence validators.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE_SUCCESSOR = 'docs/releases/usage-activation/current.json';
const SYNTHETIC_GATES = Object.freeze(['finalSourceBinding', 'pairedSole133', 'pairedNormal34', 'classroomUsageOff',
  'threeColdUsageRuns', 'distinct64', 'broaderOrdinary', 'broaderConcentrated']);
export const USAGE_GATES = Object.freeze([...SYNTHETIC_GATES, 'guardedOffRehearsal', 'threeDailyShadowDays',
  'baselineSchoolDay', 'ledgerObservation', 'walkthrough', 'fiveDayFollowup']);
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const exact = (value, keys) => assert.deepEqual(Object.keys(value ?? {}).sort(), [...keys].sort(), 'USAGE_SUCCESSOR_FIELDS_INVALID');
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value));
const privateReference = value => {
  exact(value, ['storage', 'path', 'sha256']);
  assert.equal(value.storage, 'private', 'USAGE_PRIVATE_RECEIPT_REQUIRED');
  assert.ok(typeof value.path === 'string' && /^[a-zA-Z0-9._/-]+\.json$/.test(value.path)
    && !path.posix.isAbsolute(value.path) && path.posix.normalize(value.path) === value.path
    && !value.path.split('/').includes('..'), 'USAGE_RECEIPT_PATH_INVALID');
  assert.match(value.sha256 ?? '', hash, 'USAGE_RECEIPT_HASH_REQUIRED');
};

export function validateUsageSuccessor(record) {
  exact(record, ['schemaVersion', 'kind', 'policyDecisionDate', 'policy', 'operationalAuthorization', 'candidate', 'gates', 'productionObservation']);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.kind, 'classpilot_usage_activation_successor');
  assert.match(record.policyDecisionDate ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(record.policy, { scope: 'global', syntheticGate: 'full_existing', both800VariantsRequired: true,
    ledgerProofForEveryEligibleSchool: true, exactPlanApprovalRequired: true, offAuthority: 'time_limited_governed',
    productionFirstWaiver: false, schoolSizedWaiver: false }, 'USAGE_POLICY_CANNOT_BE_WEAKENED');
  assert.equal(record.operationalAuthorization, false, 'USAGE_STATUS_IS_NOT_AUTHORIZATION');
  if (record.candidate !== null) {
    exact(record.candidate, ['sourceSha', 'imageDigest', 'schemaSha256', 'migrationLedgerSha256', 'migrationStage']);
    assert.match(record.candidate.sourceSha ?? '', sha);
    assert.match(record.candidate.imageDigest ?? '', /^sha256:[a-f0-9]{64}$/);
    for (const name of ['schemaSha256', 'migrationLedgerSha256']) assert.match(record.candidate[name] ?? '', hash);
    assert.ok(['expand', 'contract'].includes(record.candidate.migrationStage));
  }
  exact(record.gates, USAGE_GATES);
  for (const gate of Object.values(record.gates)) {
    exact(gate, ['status', 'sourceSha', 'evidence', 'independentReview']);
    assert.ok(['pending', 'failed', 'passed'].includes(gate.status));
    assert.ok(gate.sourceSha === null || sha.test(gate.sourceSha));
    assert.ok(Array.isArray(gate.evidence));
    gate.evidence.forEach(privateReference);
    if (gate.independentReview !== null) privateReference(gate.independentReview);
    if (gate.status === 'passed') {
      assert.ok(record.candidate && gate.sourceSha === record.candidate.sourceSha, 'USAGE_GATE_SOURCE_REQUIRED');
      assert.ok(gate.evidence.length > 0 && gate.independentReview !== null, 'USAGE_GATE_REPLAY_REFERENCES_REQUIRED');
    }
  }
  // Observations describe reality even if a switch occurred without accepted
  // evidence. Never reject an ON observation merely to preserve an OFF claim.
  if (record.productionObservation !== null) {
    const observed = record.productionObservation;
    exact(observed, ['observedAtUtc', 'sourceSha', 'imageDigest', 'rollupMode', 'digitalUsageMode', 'receipt']);
    assert.ok(stamp(observed.observedAtUtc));
    assert.match(observed.sourceSha ?? '', sha);
    assert.match(observed.imageDigest ?? '', /^sha256:[a-f0-9]{64}$/);
    for (const name of ['rollupMode', 'digitalUsageMode']) assert.ok(['off', 'on'].includes(observed[name]));
    privateReference(observed.receipt);
  }
  return record;
}

export function readUsageSuccessor(root) {
  const filename = path.join(root, USAGE_SUCCESSOR);
  return existsSync(filename) ? validateUsageSuccessor(JSON.parse(readFileSync(filename, 'utf8'))) : null;
}

export function renderUsageSuccessor(record) {
  validateUsageSuccessor(record);
  const observation = record.productionObservation;
  const pending = Object.entries(record.gates).filter(([, gate]) => gate.status !== 'passed').map(([name]) => name);
  const failed = Object.entries(record.gates).filter(([, gate]) => gate.status === 'failed').map(([name]) => name);
  const lines = ['', '### Separate global Usage activation', '',
    `Owner-selected policy dated **${record.policyDecisionDate}**: full existing acceptance, both 800-client variants, and ledger proof for every eligible school.`,
    'The release297 Usage values above are dated historical evidence. The [separate Usage successor](releases/usage-activation/current.json) records later preparation and observations; it grants no operational authorization.', '',
    observation ? `Usage observation **${observation.observedAtUtc}**: rollup **${observation.rollupMode}**, reports **${observation.digitalUsageMode}**, source \`${observation.sourceSha.slice(0, 8)}\`.`
      : 'Current production Usage state has **not been observed by this preparation**. No activation is claimed.',
    `Gate records awaiting completion: ${pending.length ? pending.join(', ') : 'none; validate the actual private receipts before any operation'}.`,
    'Status records are metadata. Canonical receipt replay, fresh production preflight and approval of each exact activation plan remain required.'];
  if (failed.length) lines.push('', `**Failed Usage gates: ${failed.join(', ')}. Usage activation remains blocked; preserve the original receipts and blocker report.**`);
  if (observation && (observation.rollupMode === 'on' || observation.digitalUsageMode === 'on')) {
    // The off rehearsal follows the first rollup-on operation; it is required
    // before reporting-on, rather than a prerequisite to rehearsing itself.
    const prerequisiteNames = [...SYNTHETIC_GATES, 'threeDailyShadowDays', 'baselineSchoolDay',
      ...(observation.digitalUsageMode === 'on' ? ['guardedOffRehearsal', 'ledgerObservation'] : [])];
    if (prerequisiteNames.some(name => record.gates[name].status !== 'passed')) lines.push('', '**Usage is observed enabled with incomplete prerequisite records. Treat this as an incident; do not infer approval from the observation.**');
    if (observation.digitalUsageMode === 'on' && observation.rollupMode !== 'on') lines.push('', '**Observed Usage flags are inconsistent; inspect the serving definitions.**');
    if (record.candidate && (observation.sourceSha !== record.candidate.sourceSha || observation.imageDigest !== record.candidate.imageDigest)) lines.push('', '**Observed serving identity differs from the prepared candidate; acceptance does not transfer.**');
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/usage-activation-current-state.mjs');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const record = readUsageSuccessor(root);
  assert.ok(record, 'Usage successor record is missing');
  console.log(renderUsageSuccessor(record));
}
