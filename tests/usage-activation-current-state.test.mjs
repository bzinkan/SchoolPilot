import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { USAGE_SUCCESSOR, validateUsageSuccessor, renderUsageSuccessor } from '../scripts/usage-activation-current-state.mjs';

const fixture = () => JSON.parse(readFileSync(new URL(`../${USAGE_SUCCESSOR}`, import.meta.url), 'utf8'));
const reference = () => ({ storage: 'private', path: 'synthetic-test/receipt.json', sha256: 'b'.repeat(64) });

test('successor preserves full global policy and claims no unexecuted production work', () => {
  const record = fixture();
  assert.equal(validateUsageSuccessor(record), record);
  assert.equal(record.productionObservation.rollupMode, 'off');
  assert.equal(record.productionObservation.digitalUsageMode, 'off');
  assert.match(renderUsageSuccessor(record), /rollup \*\*off\*\*, reports \*\*off\*\*/);
  record.productionObservation = null;
  assert.match(renderUsageSuccessor(record), /not been observed/);
  assert.equal(Object.values(record.gates).every(gate => gate.status === 'pending'), true);
});
test('status metadata cannot waive capacity, authorize operations or promote unsupported gates', () => {
  for (const change of [r => { r.policy.both800VariantsRequired = false; }, r => { r.operationalAuthorization = true; },
    r => { r.gates.threeColdUsageRuns.status = 'passed'; }]) {
    const record = fixture(); change(record); assert.throws(() => validateUsageSuccessor(record));
  }
});
test('unexpected ON observations remain reportable and never inherit historical OFF acceptance', () => {
  const record = fixture();
  record.productionObservation = { observedAtUtc: '2026-10-11T14:00:00Z', sourceSha: 'a'.repeat(40),
    imageDigest: `sha256:${'c'.repeat(64)}`, rollupMode: 'on', digitalUsageMode: 'on', receipt: reference() };
  assert.match(renderUsageSuccessor(record), /incomplete prerequisite records/);
  assert.equal(record.operationalAuthorization, false);
});
test('failed gates stay visibly failed instead of being rendered only as pending', () => {
  const record = fixture();
  record.gates.threeColdUsageRuns.status = 'failed';
  record.gates.threeColdUsageRuns.sourceSha = 'a'.repeat(40);
  record.gates.threeColdUsageRuns.evidence = [reference()];
  assert.match(renderUsageSuccessor(record), /Failed Usage gates: threeColdUsageRuns/);
  assert.match(renderUsageSuccessor(record), /activation remains blocked/);
});
test('Switch 1 can precede its off rehearsal, while Switch 2 requires the rehearsal and ledger', () => {
  const record = fixture();
  record.candidate = { sourceSha: record.productionObservation.sourceSha, imageDigest: record.productionObservation.imageDigest,
    schemaSha256: 'd'.repeat(64), migrationLedgerSha256: 'e'.repeat(64), migrationStage: 'expand' };
  for (const [name, gate] of Object.entries(record.gates)) {
    if (['guardedOffRehearsal', 'ledgerObservation', 'walkthrough', 'fiveDayFollowup'].includes(name)) continue;
    Object.assign(gate, { status: 'passed', sourceSha: record.candidate.sourceSha, evidence: [reference()], independentReview: reference() });
  }
  record.productionObservation.rollupMode = 'on';
  assert.doesNotMatch(renderUsageSuccessor(record), /incomplete prerequisite records/);
  record.gates.classroomUsageOff.status = 'pending';
  assert.match(renderUsageSuccessor(record), /incomplete prerequisite records/);
  record.gates.classroomUsageOff.status = 'passed';
  record.productionObservation.digitalUsageMode = 'on';
  assert.match(renderUsageSuccessor(record), /incomplete prerequisite records/);
});
test('passed metadata requires source and private independent replay references', () => {
  const record = fixture(); record.candidate = { sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'c'.repeat(64)}`,
    schemaSha256: 'd'.repeat(64), migrationLedgerSha256: 'e'.repeat(64), migrationStage: 'expand' };
  const gate = record.gates.finalSourceBinding; gate.status = 'passed'; gate.sourceSha = record.candidate.sourceSha;
  assert.throws(() => validateUsageSuccessor(record), /REPLAY_REFERENCES/);
  gate.evidence = [reference()]; gate.independentReview = reference(); validateUsageSuccessor(record);
  gate.sourceSha = 'f'.repeat(40); assert.throws(() => validateUsageSuccessor(record), /GATE_SOURCE/);
  gate.sourceSha = record.candidate.sourceSha; gate.evidence[0].path = '../other.json';
  assert.throws(() => validateUsageSuccessor(record), /PATH_INVALID/);
});
