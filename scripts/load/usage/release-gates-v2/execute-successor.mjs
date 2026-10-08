import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PROFILES, profileHash, hash } from './contracts.mjs';
import { validateRound, validatePairs } from './validation.mjs';
import { validateAcceptanceSuccessor, readPinnedSuccessorInput, assertFrozenAcceptanceHarness, assertSuccessorRunBinding, assertSuccessorMixedSequence, FIXED_ORDER } from './acceptance-successor.mjs';
import { runV2 } from './run.mjs';
import { declareCampaign, reserveAttempt, registerAttempt, closeCampaign } from './campaign.mjs';
import { loadReceipt } from './receipts.mjs';
import { lowerPersistenceCustody, verifyLowerPersistenceCustody, assertLowerConfirmation, lowerHeadroom, lowerContractHash, LOWER_CONTRACT } from './lower-load.mjs';
import { lowerScreenDisposition } from './lower-sweep.mjs';
import { assertOutside } from './owner.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
export const SUCCESSOR_BLOCKS = Object.freeze({ fixed133: PROFILES.sole, boundary: PROFILES.boundaryPreparation, normal: PROFILES.classroomNative, classroom: PROFILES.mixedNative, headroom250: PROFILES.lower250 });
export function assertWholeSuccessorAttempt(window, profile, now = Date.now()) {
  const reserve = profile.kind === 'mixed' && !profile.preparationOnly ? 1_200_000 : LOWER_CONTRACT.fullAttemptReserveMs;
  assert.ok(now >= Date.parse(window.startsAt)); assert.ok(Date.parse(window.expiresAt) - now >= reserve, 'Whole attempt reserve unavailable');
  return true;
}
// Only baseline absolute latency is excused by the recorded policy. A failed
// candidate or any tenancy, persistence, offering, error or cleanup defect holds
// the rest of the block. Original run/strict-comparison results are retained.
export function fixedSuccessorDisposition(record) {
  assert.equal(record.cleanupPassed, true); assert.equal(record.sourceUnchanged, true); assert.equal(record.hostHarnessSourceUnchanged, true);
  assert.equal(record.expectedNegativeLogCoverage, true);
  assert.ok(record.errorCoverage.length > 1 && record.errorCoverage.every(row => row.complete && row.available && row.errorCount === 0));
  assert.equal(record.rounds.length, 1);
  const checked = validateRound(record.rounds[0], PROFILES.sole, { baseline: record.arm === 'A' });
  assert.deepEqual(checked, record.rounds[0].acceptance);
  const failed = Object.entries(checked.checks).filter(([, value]) => value !== true).map(([name]) => name);
  if (record.arm === 'A' && failed.length === 1 && failed[0] === 'latency') {
    assert.equal(record.runPassed, false); assert.equal(record.failure, 'V2_NUMERICAL_ACCEPTANCE_FAILED');
    return { continueFixedOrder: true, baselineAbsoluteLatencyException: true, originalRunPassed: false };
  }
  assert.equal(record.failure, null); assert.equal(record.runPassed, true); assert.equal(failed.length, 0);
  return { continueFixedOrder: true, baselineAbsoluteLatencyException: false, originalRunPassed: true };
}
export function evaluateApprovedCurrentSchool(records, successor) {
  const { binding } = successor; assert.equal(records.length, 8); assert.deepEqual(records.map(row => row.arm), FIXED_ORDER);
  for (const row of records) {
    fixedSuccessorDisposition(row);
    const role = row.arm === 'A' ? binding.baseline : binding.candidate;
    const helper = row.arm === 'A' ? binding.helpers.baseline : binding.helpers.candidate;
    assert.equal(row.source, role.source); assert.equal(row.applicationImage, role.image); assert.equal(row.schemaSha256, role.schema.canonicalSha256);
    assert.equal(row.helperImage, helper.helperImage); assert.equal(row.harnessSource, binding.harness.source);
    assert.equal(row.profile, PROFILES.sole.name); assert.equal(row.contractSha256, profileHash(PROFILES.sole));
    assert.equal(row.observedFlagsSha256, binding.environment.observedFlagsSha256);
    assert.equal(row.acceptanceSuccessor.sha256, successor.input.sha256); assert.equal(row.acceptanceSuccessor.policyReceiptSha256, binding.policy.sha256);
    assert.match(row.verifiedReceiptManifestSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(row.p95Ms) && row.p95Ms > 0);
    assert.ok(Number.isFinite(row.wholeOwnedApiCpuMicroseconds) && row.wholeOwnedApiCpuMicroseconds > 0);
    assert.equal(row.wholeOwnedCpuIncludesFinalClassificationFlush, true);
    assert.equal(row.cpuMsPer200, row.wholeOwnedApiCpuMicroseconds / 1000 / PROFILES.sole.offering.expected);
    assert.equal(row.clientAdvertisementSha256, binding.clientAdvertisement.sha256); assert.equal(row.clientAdvertisementVersion, '2.9.6');
  }
  assert.equal(new Set(records.map(row => row.run)).size, 8);
  for (const row of records) { assert.match(row.fixtureLogicalSha256, /^[a-f0-9]{64}$/); assert.match(row.nodeVersion, /^v[0-9]+\.[0-9]+\.[0-9]+$/); }
  for (const field of ['fixtureLogicalSha256', 'nodeVersion', 'harnessSource']) assert.equal(new Set(records.map(row => row[field])).size, 1);
  const baseline = records.filter(row => row.arm === 'A'), candidate = records.filter(row => row.arm === 'B');
  const pairs = [[records[2], records[3]], [records[5], records[4]], [records[6], records[7]]];
  const cpu = pairs.map(([a, b]) => b.cpuMsPer200 / a.cpuMsPer200), latency = pairs.map(([a, b]) => b.p95Ms / a.p95Ms), increases = pairs.map(([a, b]) => b.p95Ms - a.p95Ms);
  const conservativeCpu = Math.max(...candidate.map(row => row.cpuMsPer200)) / Math.min(...baseline.map(row => row.cpuMsPer200));
  const conservativeP95 = Math.max(...candidate.map(row => row.p95Ms)) / Math.min(...baseline.map(row => row.p95Ms));
  const checks = {
    candidateThreeAbsolutePasses: candidate.length === 3 && candidate.every(row => row.runPassed === true && row.p95Ms <= 500 && row.rounds[0].apiCpuMeanFraction < .60),
    cpuControls: Math.max(...records.slice(0, 2).map(row => row.cpuMsPer200)) / Math.min(...records.slice(0, 2).map(row => row.cpuMsPer200)) <= 1.05,
    everyPairedCpu: cpu.every(value => value <= 1.10), medianPairedCpu: median(cpu) <= 1.05,
    everyPairedLatencyIncrease: increases.every(value => value <= 100), medianPairedLatencyIncrease: median(increases) <= 50,
    medianPairedP95Ratio: median(latency) <= 1.10, conservativeAllRunsCpu: conservativeCpu <= 1.05, conservativeAllRunsP95: conservativeP95 <= 1.10,
  };
  return { passed: Object.values(checks).every(Boolean), checks, cpuRatios: cpu, p95Ratios: latency, p95Increases: increases,
    conservativeAllRunsCpuRatio: conservativeCpu, conservativeAllRunsP95Ratio: conservativeP95,
    policyReceiptSha256: binding.policy.sha256, historicalFailuresReclassified: false, strictComparisonReclassified: false, releaseReady: false, operationalAuthorization: false };
}
function assertUnforcedNativeCleanup(record, receipt, privateDirectory) {
  const cleanup = read(join(receipt, 'role-cleanup.json')), pg = read(join(receipt, 'postgres-cleanup.json'));
  assert.ok(cleanup.exits.every(row => row.clean === true && row.forced !== true && row.oomKilled !== true));
  assert.equal(pg.forced, false); assert.equal(pg.stopped.ExitCode, 0); assert.equal(pg.stopped.OOMKilled, false); assert.ok(pg.volumes.every(row => row.confirmedAbsent === true));
  if (record.profile === PROFILES.sole.name) {
    const custody = lowerPersistenceCustody(privateDirectory);
    verifyLowerPersistenceCustody(privateDirectory, { ...record, lowerPersistenceCustody: custody });
    return { persistenceCustody: custody, persistenceReplayed: true, unforcedCleanupPassed: true };
  }
  return { unforcedCleanupPassed: true };
}
export async function executeSuccessorBlock(input) {
  const request = readPinnedSuccessorInput(input).value, profile = SUCCESSOR_BLOCKS[request.block]; assert.ok(profile, 'Unknown successor block');
  const successor = validateAcceptanceSuccessor(request.binding), { binding } = successor;
  assert.equal(request.schemaVersion, 1); assert.equal(request.kind, 'local_acceptance_successor_block');
  assert.equal(request.driverSha256, hash(readFileSync(new URL(import.meta.url))));
  assert.equal(resolve(binding.harness.directory), resolve(fileURLToPath(new URL('../../../../', import.meta.url))));
  assert.equal(day(), binding.schoolLocalDate);
  const window = readPinnedSuccessorInput(request.quietWindow).value;
  assert.equal(window.localSyntheticOnly, true); assert.equal(window.noOtherLoadOrBuilds, true); assert.equal(window.hostHarnessSource, binding.harness.source);
  assert.equal(window.source, binding.candidate.source); assert.equal(window.baselineSource, binding.baseline.source);
  assert.ok(Date.parse(window.startsAt) >= Date.parse(binding.validity.startsAt)); assert.ok(Date.parse(window.expiresAt) <= Date.parse(binding.validity.expiresAt));
  const templates = { B: readPinnedSuccessorInput(request.templates.candidate).value };
  if (request.block === 'fixed133') templates.A = readPinnedSuccessorInput(request.templates.baseline).value;
  for (const [arm, template] of Object.entries(templates)) {
    assert.equal(template.arm, request.block === 'fixed133' || request.block === 'headroom250' ? arm : 'C');
    assert.deepEqual(template.acceptanceSuccessor, request.binding); assertSuccessorRunBinding(template, profile, successor);
  }
  if (['normal', 'classroom'].includes(request.block)) {
    const proof = request.lossBoundaryProof;
    const native = loadReceipt(proof.receiptDirectory, proof.receiptManifestSha256, proof.privateDirectory);
    assert.equal(native.profile, PROFILES.boundaryPreparation.name); assert.equal(native.smokePassed, true); assert.equal(native.cleanupPassed, true);
    assert.equal(native.source, binding.candidate.source); assert.equal(native.applicationImage, binding.candidate.image);
    assert.equal(native.helperImage, binding.helpers.candidate.helperImage); assert.equal(native.acceptanceSuccessor.sha256, request.binding.sha256);
    assert.equal(native.preparationSmokeResult.passed, true);
  }
  const root = resolve(request.outputDirectory); assertOutside(binding.harness.directory, root); assertOutside(binding.candidate.sourceDirectory, root);
  assert.equal(existsSync(root), false); assertWholeSuccessorAttempt(window, profile); mkdirSync(root);
  const campaignDirectory = join(root, 'campaign'), paired = request.block === 'fixed133', lower = request.block === 'headroom250';
  const order = paired ? [...FIXED_ORDER] : ['classroom', 'headroom250'].includes(request.block) ? ['C', 'C', 'C'] : ['C'];
  let contract;
  if (lower) {
    order.fill('B'); contract = { schemaVersion: 1, kind: 'headroom250', profile: profile.name, contractSha256: profileHash(profile), order,
      acceptanceSuccessor: request.binding, lowerLoadContractSha256: lowerContractHash(), source: binding.candidate.source, applicationImage: binding.candidate.image,
      maximumAttempts: 3, requireThreeFreshPasses: true, higherFleetClassroomOrSurvivalClaim: false, releaseReady: false };
    mkdirSync(campaignDirectory); save(join(campaignDirectory, 'contract.json'), contract);
  } else contract = declareCampaign({ directory: campaignDirectory, kind: paired ? 'paired' : profile.preparationOnly ? 'preparation' : profile.kind, profile: profile.name,
    candidateSource: binding.candidate.source, baselineSource: binding.baseline.source, observedFlagsSha256: binding.environment.observedFlagsSha256 });
  assert.deepEqual(contract.order, order);
  const contractSha256 = hash(readFileSync(join(campaignDirectory, 'contract.json'))), journal = { contractSha256, binding: request.binding, attempts: [], closed: false };
  save(join(root, 'preparation-binding.json'), { preparation: input, driverSha256: request.driverSha256, binding: request.binding, quietWindow: request.quietWindow, profile: profile.name, profileSha256: profileHash(profile), releaseReady: false, operationalAuthorization: false });
  const checkpoint = () => { writeFileSync(join(root, 'journal.next'), JSON.stringify(journal, null, 2) + '\n'); renameSync(join(root, 'journal.next'), join(root, 'journal.json')); };
  checkpoint(); const records = [], privateDirectories = []; let failure = null, result = null, strictComparison = null;
  try {
    for (let index = 0; index < order.length; index++) {
      assertFrozenAcceptanceHarness(binding.harness); assert.equal(day(), binding.schoolLocalDate); assertWholeSuccessorAttempt(window, profile);
      const arm = order[index], base = structuredClone(templates[arm === 'A' ? 'A' : 'B']), run = randomBytes(6).toString('hex');
      const attempt = join(root, `attempt-${index + 1}`), outputDirectory = join(attempt, 'receipt'), privateDirectory = join(attempt, 'private'); mkdirSync(attempt); privateDirectories.push(privateDirectory);
      let reservation;
      if (lower) {
        const value = { run, arm, source: binding.candidate.source, profile: profile.name, contractSha256: profileHash(profile), campaignContractSha256: contractSha256,
          preparationSmoke: false, observedFlagsSha256: binding.environment.observedFlagsSha256, receiptDirectory: outputDirectory, privateDirectory,
          lowerLoadContractSha256: lowerContractHash(), hostHarnessSource: binding.harness.source, lowerLoadBindingSha256: hash(JSON.stringify(base.lowerLoad)) };
        const file = join(attempt, 'reservation.json'); save(file, value); reservation = { reservationFile: file, reservationSha256: hash(readFileSync(file)) };
      } else reservation = reserveAttempt({ directory: campaignDirectory, run, receiptDirectory: outputDirectory, privateDirectory });
      const quietWindowFile = join(attempt, 'quiet-window.json'); save(quietWindowFile, { ...window, source: base.source, profile: profile.name, preparationSmoke: profile.preparationOnly === true });
      Object.assign(base, { run, arm, profile: profile.name, outputDirectory, privateDirectory, reservationFile: reservation.reservationFile,
        reservationSha256: reservation.reservationSha256, quietWindowFile, quietWindowSha256: hash(readFileSync(quietWindowFile)) });
      save(join(attempt, 'run-config.private.json'), base);
      const entry = { index: index + 1, run, arm, state: 'reserved', receiptDirectory: outputDirectory, privateDirectory, reservationSha256: reservation.reservationSha256 }; journal.attempts.push(entry); checkpoint();
      process.stdout.write(JSON.stringify({ event: 'successor_attempt_started', block: request.block, index: index + 1, run, arm }) + '\n');
      try { await runV2(base); } catch { entry.executionFailure = 'SUCCESSOR_RUN_THROW'; }
      const manifestFile = join(outputDirectory, 'receipt-manifest.json'), manifestSha256 = existsSync(manifestFile) ? hash(readFileSync(manifestFile)) : '0'.repeat(64);
      if (!lower) registerAttempt({ directory: campaignDirectory, receiptDirectory: outputDirectory, receiptManifestSha256: manifestSha256, privateDirectory });
      entry.state = 'recorded'; entry.receiptManifestSha256 = manifestSha256; checkpoint();
      const record = loadReceipt(outputDirectory, manifestSha256, privateDirectory); assert.equal(record.reservationSha256, reservation.reservationSha256); assert.equal(record.campaignContractSha256, contractSha256);
      assert.equal(record.acceptanceSuccessor.sha256, request.binding.sha256); assert.equal(record.quietWindowSha256, base.quietWindowSha256);
      const supplement = assertUnforcedNativeCleanup(record, outputDirectory, privateDirectory); save(join(attempt, 'supplemental-verification.json'), supplement);
      if (paired) entry.disposition = fixedSuccessorDisposition(record);
      else if (profile.preparationOnly) assert.equal(record.smokePassed, true);
      else { assert.equal(record.runPassed, true); assert.equal(record.failure, null); }
      if (lower) { entry.disposition = lowerScreenDisposition(record); assert.equal(entry.disposition.continueUpward, true); assert.equal(lowerHeadroom(record), true); }
      assert.equal(Date.now() < Date.parse(window.expiresAt), true); assertFrozenAcceptanceHarness(binding.harness); assert.equal(day(), binding.schoolLocalDate);
      entry.runPassed = record.runPassed; entry.cleanupPassed = record.cleanupPassed; entry.verificationCompleted = true; checkpoint(); records.push(record);
      process.stdout.write(JSON.stringify({ event: 'successor_attempt_completed', block: request.block, index: index + 1, run, runPassed: record.runPassed, cleanupPassed: record.cleanupPassed }) + '\n');
    }
    const replay = journal.attempts.map(entry => { const record = loadReceipt(entry.receiptDirectory, entry.receiptManifestSha256, entry.privateDirectory); assert.deepEqual(record, records[entry.index - 1]); assertUnforcedNativeCleanup(record, entry.receiptDirectory, entry.privateDirectory); return record; });
    if (paired) {
      try { strictComparison = validatePairs(replay, { profile, candidateSource: binding.candidate.source, baselineSource: binding.baseline.source, observedFlagsSha256: binding.environment.observedFlagsSha256 }); }
      catch { strictComparison = { passed: false, disposition: 'strict-validator-rejected-original-run-results', originalResultsPreserved: true }; }
      save(join(root, 'strict-comparison-result.json'), strictComparison);
      try { closeCampaign({ directory: campaignDirectory, privateDirectories }); } catch { save(join(root, 'strict-closure-rejected.json'), { passed: false, originalResultsPreserved: true, journalSha256: hash(readFileSync(join(campaignDirectory, 'journal.json'))) }); }
      result = evaluateApprovedCurrentSchool(replay, successor);
      save(join(root, 'approved-policy-evaluation.json'), result); assert.equal(result.passed, true, 'Approved current-school comparison failed');
    } else if (lower) result = { ...assertLowerConfirmation(replay, profile), passed: true };
    else {
      if (profile.name === PROFILES.mixedNative.name) assertSuccessorMixedSequence(replay, binding, new Date().toISOString());
      result = closeCampaign({ directory: campaignDirectory, privateDirectories }); assert.equal(result.passed, true);
    }
  } catch { failure = 'SUCCESSOR_BLOCK_FAILED_REMAINING_ATTEMPTS_HELD'; }
  finally {
    journal.closed = true; journal.failure = failure; journal.remainingAttemptsHeld = order.length - journal.attempts.length; journal.completedAt = new Date().toISOString(); checkpoint();
    save(join(root, 'closure.json'), { schemaVersion: 1, block: request.block, profile: profile.name, profileSha256: profileHash(profile), source: binding.candidate.source, applicationImage: binding.candidate.image,
      binding: request.binding, request: input, contractSha256, journalSha256: hash(readFileSync(join(root, 'journal.json'))), passed: !failure && result?.passed === true,
      result, strictComparison, failure, attemptsRecorded: journal.attempts.length, remainingAttemptsHeld: journal.remainingAttemptsHeld,
      historicalFailuresReclassified: false, releaseReady: false, operationalAuthorization: false });
  }
  return { passed: !failure && result?.passed === true, failure, outputDirectory: root, releaseReady: false, operationalAuthorization: false };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await executeSuccessorBlock({ file: process.argv[2], sha256: process.argv[3] }); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.passed ? 0 : 1; }
  catch { process.stderr.write('SUCCESSOR_BLOCK_PREPARATION_REJECTED\n'); process.exitCode = 1; }
}
