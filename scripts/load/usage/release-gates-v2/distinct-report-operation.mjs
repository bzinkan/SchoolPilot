import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROFILES } from './contracts.mjs';
import { runHeavyUsageWorkers } from './usage-checks.mjs';
import { checkPersistence } from './persistence.mjs';
import { DISTINCT_REPORT_CONTRACT, distinctReportContractHash, distinctReportCases, distinctCsvCases, distinctCanonicalKey,
  assertDistinctOracle, prepareDistinctReports, distinctPreparedStateHash, sanitizedDistinctReportFailure } from './distinct-reports.mjs';

// A future, separately registered operation after the three original cold
// runs. The shared router/owner implementation remains a separate slice.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const source = 'ddc5996b3b8645859fa51a9613486db52c481b7f';
export const DISTINCT_SERVICE_LIMITS = Object.freeze({
  apiTasks: 3, apiCpu: 1, apiMemoryBytes: 2 * 1024 ** 3, apiMainPool: 16, apiSessionPool: 2,
  workerCpu: .5, workerMemoryBytes: 1024 ** 3, workerMainPool: 2, workerSchedulerPool: 5, workerLockPool: 8,
  observerPool: 2, postgresCpu: 4, postgresMemoryBytes: 4 * 1024 ** 3,
  requestTimeoutMs: 20_000, acquisitionTimeoutMs: 5000, apiStatementTimeoutMs: 15_000,
  workerStatementTimeoutMs: 60_000, workerAcceptanceMs: 48_000,
  durabilityChanged: false, infrastructureChanged: false,
});
export const DISTINCT_ENDPOINT_OPERATION = Object.freeze({
  ...PROFILES.usage,
  name: 'release297-usage-shared-db-three-api-distinct64-v1', repetitions: 1,
  distinctReports: true, reportContractSha256: distinctReportContractHash(),
  originalColdRunsRequired: 3, freshRestoreRequired: true,
  coveragePreparation: 'actual-workers-before-timed-offers',
  firstComputationColdEvidence: false, original64MatrixChanged: false,
});
export const distinctEndpointOperationHash = () => digest(DISTINCT_ENDPOINT_OPERATION);
export const distinctCoverageHash = oracle => digest(oracle.schools.map(({ schoolIndex, coverage }) => ({ schoolIndex,
  coverage: coverage.map(({ date, isFinal, processedThrough }) => ({ date, isFinal, processedThrough })) })));
export const sanitizedDistinctOperationFailure = error => sanitizedDistinctReportFailure(error, 'DISTINCT_OPERATION_FAILED');
const safeError = sanitizedDistinctOperationFailure;
const allZero = value => value && Object.keys(value).length > 0 && Object.values(value).every(count => Number.isSafeInteger(count) && count === 0);

export function validateDistinctRegistration(registration, fixture, apis, { worker, observer, generator }) {
  assert.equal(registration.source, source); assert.equal(fixture.sourceRevision, source);
  assert.equal(registration.profile, DISTINCT_ENDPOINT_OPERATION.name);
  assert.equal(registration.operationContractSha256, distinctEndpointOperationHash());
  assert.equal(registration.reportContractSha256, distinctReportContractHash());
  for (const key of ['helperBindingSha256', 'snapshotManifestSha256', 'restorationReceiptSha256', 'operationalFixtureReceiptSha256'])
    assert.ok(validHash(registration[key]), key);
  assert.equal(registration.schemaInputSha256, '6b40d8811ce1f50eb3f33b3a5ca39256b404699b994c3802c48f86119d0542e3');
  assert.equal(registration.canonicalSourceSchemaSha256, '3afe69c3b2dcdeaae049f24d766c542c5e12cf762227b194db329dc0368df570');
  assert.equal(registration.actualRestorationPassed, true); assert.equal(registration.healthHookAppliedAfterOriginalVerification, true);
  assert.equal(registration.healthHookRelabeledCanonicalSchema, false); assert.equal(registration.sessionCookiePathVerified, true);
  assert.equal(registration.generatedEndpointOverrideVerified, true);
  assert.deepEqual(registration.serviceLimits, DISTINCT_SERVICE_LIMITS);
  assert.deepEqual(registration.nativeHeavyObservationCounts, [1_000_000, 1_000_000]);
  assert.match(registration.run, /^[a-f0-9]{12}$/); assert.match(registration.helperImage, /^sha256:[a-f0-9]{64}$/);
  assert.equal(apis.length, 3);
  const owners = [...apis, worker, observer, generator], roles = ['api0', 'api1', 'api2', 'worker', 'observer', 'generator'];
  assert.deepEqual(owners.map(owner => owner?.role), roles); assert.equal(new Set(owners.map(owner => owner.id)).size, 6);
  assert.equal(registration.ownerBindings.length, 6);
  for (const [index, owner] of owners.entries()) {
    assert.match(owner.id, /^[a-f0-9]{64}$/); assert.equal(typeof owner.rpc, 'function');
    assert.equal(owner.source, source); assert.equal(owner.helperImage, registration.helperImage);
    const binding = { run: registration.run, source, role: roles[index], containerId: owner.id };
    assert.deepEqual(owner.ready?.binding, binding);
    assert.deepEqual(registration.ownerBindings[index], { ...binding, helperImage: owner.helperImage });
  }
  return true;
}

export function verifyDistinctOwnerDrains(rows) {
  assert.equal(rows.length, 4);
  const keys = ['activeOperations', 'pendingCheckouts', 'activeCheckouts', 'pendingAcquisitions', 'activeQueries',
    'poolWaiting', 'poolHeld', 'httpResponses', 'pendingTenantReleases', 'queuedHeartbeats', 'admittedHeartbeats'].sort();
  for (const row of rows) {
    assert.equal(row.complete, true); assert.equal(row.physicallyIdle, true); assert.equal(row.physicallySettled, true); assert.equal(row.budgetMs, 20_000);
    assert.equal(row.abortedResponses, 0); assert.ok(Number.isSafeInteger(row.passes) && row.passes >= 2
      && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs < 20_000);
    assert.deepEqual(Object.keys(row.gauges).sort(), keys); assert.ok(allZero(row.gauges));
  }
  return true;
}
function requireWorkers(rows) {
  assert.equal(rows.length, 2);
  for (const index of [0, 1]) {
    const found = rows.filter(row => row.schoolIndex === index); assert.equal(found.length, 1);
    assert.equal(found[0].correct, true); assert.ok(Number.isFinite(found[0].durationMs) && found[0].durationMs <= 48_000);
  }
}
function requireDatabase(snapshot) {
  assert.ok(snapshot.database.acquisitions.count > 0); assert.equal(snapshot.database.acquisitions.failures, 0);
  const statements = Object.values(snapshot.database.statements); assert.ok(statements.length > 0);
  assert.ok(statements.every(row => row.failures === 0));
}
export function verifyDistinctHeartbeatTraffic(traffic) {
  const offered = traffic.heartbeats;
  assert.deepEqual(offered.configured, PROFILES.usage.offering);
  for (const key of ['expected', 'started', 'succeeded', 'capabilityAcknowledgements200']) assert.equal(offered[key], 6000);
  for (const key of ['failed', 'refusedAtInFlightLimit', 'lateOffers', 'outstandingAfterDrain']) assert.equal(offered[key], 0);
  assert.equal(offered.accepted, true); assert.equal(offered.timings.count, 6000); assert.ok(offered.timings.maxMs < 20_000);
  assert.equal(offered.startAlignmentAccepted, true); assert.ok(offered.declaredStartLatenessMs >= 0 && offered.declaredStartLatenessMs <= 100);
  assert.deepEqual(offered.targetHistogram, { 0: 2004, 1: 1998, 2: 1998 });
  assert.equal(traffic.lifecycle.passed, true);
  assert.equal(traffic.lifecycle.expectedNegativeProbes?.length, 2);
  assert.equal(new Set(traffic.lifecycle.expectedNegativeProbes.map(row=>row.requestId)).size,2);
  for(const row of traffic.lifecycle.expectedNegativeProbes){
    assert.match(row.requestId,/^[a-f0-9-]{36}$/);assert.equal(row.status,409);assert.equal(row.code,'PRIVATE_CHAT_LIFECYCLE_STALE');
  }
  assert.equal(traffic.reports.length, 0, 'The original64 matrix must not run inside the separate distinct operation');
}

// Fulfilled promises do not establish concurrency. These timestamps originate
// in the actual worker and authenticated generator, rather than the timer that
// requested their work. Every school operation must overlap real HTTP offers.
export function verifyDistinctWorkloadOverlap(workers, traffic, reports, startsAtMs) {
  requireWorkers(workers); assert.ok(Number.isFinite(startsAtMs));
  const offered = traffic.heartbeats;
  assert.equal(offered.declaredStartedAtMs, startsAtMs);
  assert.ok(Number.isFinite(offered.actualStartedAtMs) && offered.actualStartedAtMs >= startsAtMs
    && offered.actualStartedAtMs - startsAtMs <= PROFILES.usage.offering.maxOfferLatenessMs);
  assert.ok(Number.isFinite(offered.offerWindowMs) && offered.offerWindowMs >= PROFILES.usage.offering.durationMs);
  assert.equal(reports.startsAtMs, startsAtMs); assert.equal(reports.reportCases.length, 64);
  const heartbeatEnd = offered.actualStartedAtMs + offered.offerWindowMs;
  for (const worker of workers) {
    assert.ok(Number.isFinite(worker.startedAtMs) && Number.isFinite(worker.finishedAtMs)
      && worker.finishedAtMs > worker.startedAtMs);
    assert.ok(worker.startedAtMs >= startsAtMs, 'Native rollup preceded the declared offering');
    assert.ok(worker.startedAtMs < heartbeatEnd && worker.finishedAtMs > offered.actualStartedAtMs, 'Native rollup did not overlap actual heartbeat offering');
    assert.ok(reports.reportCases.some(row => Number.isFinite(row.offeredOffsetMs) && row.offeredOffsetMs >= 0
      && Number.isFinite(row.durationMs) && row.durationMs > 0
      && worker.startedAtMs < startsAtMs + row.offeredOffsetMs + row.durationMs
      && worker.finishedAtMs > startsAtMs + row.offeredOffsetMs), 'Native rollup did not overlap an actual authenticated report');
  }
  return { passed: true, startsAtMs, heartbeatStartedAtMs: offered.actualStartedAtMs, heartbeatOfferingEndedAtMs: heartbeatEnd,
    workers: workers.map(({ schoolIndex, startedAtMs, finishedAtMs }) => ({ schoolIndex, startedAtMs, finishedAtMs,
      startDelayMs: startedAtMs - startsAtMs })) };
}

export function verifyDistinctEndpointReportResult(value, prepared, fixture, oracle) {
  assert.equal(value.source, source); assert.equal(value.profile, DISTINCT_REPORT_CONTRACT.name);
  assert.equal(value.passed, true); assert.equal(value.capacityAcceptance, false);
  assert.equal(value.contractSha256, prepared.contractSha256); assert.equal(value.preparedHash, prepared.preparedHash);
  assert.equal(value.expectedReportsSha256, prepared.expectedSha256); assert.equal(value.independentOracleSha256, prepared.oracleSha256);
  assert.equal(value.currentProcessedCutoff, oracle.cutoff);
  const requiredChecks = ['all64ActualAuthenticatedEndpoints', 'allRequestsWithinUnchangedDeadline', 'actualDeclaredOffers',
    'uniqueRequestAndEffectiveKeys', 'all8CsvCorrect', 'drainedClientOffers', 'concurrentEndpointWorkObserved'];
  assert.deepEqual(Object.keys(value.checks).sort(), requiredChecks.sort()); assert.ok(Object.values(value.checks).every(check => check === true));
  assert.ok(Number.isSafeInteger(value.peakInFlight) && value.peakInFlight >= 16);
  for (const [rows, cases, csv] of [[value.reportCases, distinctReportCases(fixture), false], [value.csvCases, distinctCsvCases(fixture), true]]) {
    assert.equal(rows.length, cases.length); assert.equal(new Set(rows.map(row => row.ordinal)).size, cases.length);
    for (const item of cases) {
      const row = rows.find(result => result.ordinal === item.ordinal); assert.ok(row);
      for (const key of ['wave', 'schoolIndex', 'scope', 'targetOrdinal', 'days', 'endpointIndex']) assert.equal(row[key], item[key]);
      assert.equal(row.requestKeySha256, distinctCanonicalKey(item)); assert.equal(row.status, 200); assert.equal(row.correct, true);
      assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs < 20_000);
      assert.ok(Number.isFinite(row.offerLatenessMs) && row.offerLatenessMs >= 0 && row.offerLatenessMs <= 100);
      assert.ok(Number.isFinite(row.offeredOffsetMs) && row.offeredOffsetMs >= 0 && Number.isFinite(row.declaredOffsetMs)
        && row.declaredOffsetMs >= 0 && Math.abs(row.offeredOffsetMs - row.declaredOffsetMs - row.offerLatenessMs) < .01);
      if (csv) assert.ok(validHash(row.csvSha256)); else {
        assert.equal(row.effectiveKeySha256, row.requestKeySha256);
        assert.equal(row.declaredOffsetMs, DISTINCT_REPORT_CONTRACT.waveOffsetsMs[row.wave]);
      }
    }
  }
  assert.equal(new Set(value.reportCases.map(row => row.effectiveKeySha256)).size, 64);
  return true;
}

export function verifyDistinctPostProof(proof, oracle, fixture) {
  assert.equal(proof.source, source); assert.equal(proof.cutoff, oracle.cutoff); assert.equal(proof.passed, true);
  assert.equal(proof.coverageBeforeSha256, distinctCoverageHash(oracle));
  assert.equal(proof.coverageAfterSha256, proof.coverageBeforeSha256); assert.equal(proof.coverageUnchanged, true);
  assert.equal(proof.rawOracleSha256, digest(oracle)); assert.equal(proof.auditCount, 8);
  assert.equal(proof.expectedAuditKeysSha256, digest(distinctCsvCases(fixture).map(distinctCanonicalKey)));
  assert.ok(validHash(proof.auditRecordsSha256) && validHash(proof.privateRawProofSha256));
  assert.deepEqual(Object.keys(proof.violations).sort(), ['invalidRawBindings', 'invalidClassificationOrRoster',
    'coverageDifferences', 'auditDifferences', 'rawOracleDifferences'].sort());
  assert.ok(allZero(proof.violations)); return true;
}

/**
 * Uses already owned source-bound roles from the future fresh-restored profile.
 * It never creates/removes resources or owns shutdown. The outer runner must
 * preserve every response, complete log checks and graceful resource teardown.
 * No shared RPC is installed by importing this module.
 */
export async function runDistinctEndpointOperation({ registration, fixture, apis, worker, observer, generator,
  now = Date.now, pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  const checkOwners = () => validateDistinctRegistration(registration, fixture, apis, { worker, observer, generator });
  checkOwners();
  // ownRole revalidates every RPC response binding. Recheck the registered
  // identities before each invocation as well, including background workers.
  const rpc = async (owner, operation, value) => { checkOwners(); return owner.rpc(operation, value); };
  const workerRpc = { rpc: (...args) => rpc(worker, ...args) };
  const result = { schemaVersion: 1, source, profile: DISTINCT_ENDPOINT_OPERATION.name,
    operationContractSha256: distinctEndpointOperationHash(), reportContractSha256: distinctReportContractHash(),
    registrationSha256: digest(registration), passed: false, capacityAcceptance: false,
    original64MatrixChanged: false, firstComputationColdEvidence: false,
    finalOwnerLogsAndGracefulTeardownRequired: true, phases: [] };
  const drain = () => Promise.all([...apis, worker].map(owner => rpc(owner, 'drain')));
  try {
    verifyDistinctOwnerDrains(await drain());
    const preparedHeavy = await runHeavyUsageWorkers(workerRpc, fixture); requireWorkers(preparedHeavy);
    const cutoff = new Date(Math.floor(now() / 1000) * 1000).toISOString(), currentWorkers = [];
    for (const school of fixture.schools) {
      const row = await rpc(worker, 'rollup', { schoolId: school.id, date: fixture.today, cutoff });
      currentWorkers.push({ schoolIndex: school.index, ...row });
    }
    const oracle = await rpc(observer, 'distinctOracle', { source, cutoff }); assertDistinctOracle(fixture, oracle);
    for (const row of currentWorkers) {
      const expected = oracle.schools.find(school => school.schoolIndex === row.schoolIndex);
      row.correct = row.seconds === expected.secondsByStudent.reduce((sum, [, seconds]) => sum + seconds, 0)
        && row.heartbeatCount === expected.deduplicatedRows;
    }
    requireWorkers(currentWorkers);
    const canonical = prepareDistinctReports(fixture, oracle);
    const prepared = await rpc(generator, 'prepareDistinctReports', { source, oracle, contractSha256: distinctReportContractHash() });
    assert.equal(prepared.prepared, true); assert.equal(prepared.contractSha256, canonical.contractSha256);
    assert.equal(prepared.casesSha256, canonical.caseManifestSha256); assert.equal(prepared.expectedSha256, canonical.expectedReportsSha256);
    assert.equal(prepared.oracleSha256, canonical.oracleSha256); assert.equal(prepared.caseCount, 64); assert.equal(prepared.csvCount, 8);
    assert.equal(prepared.preparedHash, distinctPreparedStateHash({ run: registration.run, fixture, oracle, prepared: canonical }));
    result.preparation = { heavyWorkers: preparedHeavy, currentWorkers, ...prepared, cutoff };
    result.phases.push('actual-worker-coverage-and-independent-oracle-prepared');
    const since = new Date(now() - 86_400_000).toISOString(), before = await rpc(observer, 'snapshot', { since });
    await Promise.all([...apis, worker].map(owner => rpc(owner, 'reset')));
    const startsAtMs = now() + 1500;
    const offering = rpc(generator, 'phase', { startsAtMs, offering: PROFILES.usage.offering,
      topology: { active: [0, 1, 2], distribution: 'uniform' }, ingest: true, reports: false, lifecycle: true, reconnect: false });
    const reports = rpc(generator, 'distinctReports', { startsAtMs, preparedHash: prepared.preparedHash });
    const recomputation = (async () => { while (now() < startsAtMs) await pause(Math.max(1, startsAtMs - now())); return runHeavyUsageWorkers(workerRpc, fixture); })();
    // Settling all three owners precedes every drain; an HTTP/RPC timeout never
    // transfers ownership or certifies callbacks have stopped using a lease.
    const settled = await Promise.allSettled([offering, reports, recomputation]);
    // Actual RPC bodies stay in the owner's immutable private control records.
    // A lifecycle assertion may mention bindings on failure; publish only hashes.
    result.concurrent = settled.map(row => row.status === 'fulfilled' ? { status: row.status, valueSha256: digest(row.value) } : { status: row.status, error: safeError(row.reason) });
    assert.ok(settled.every(row => row.status === 'fulfilled'));
    const [traffic, distinct, workers] = settled.map(row => row.value);
    verifyDistinctHeartbeatTraffic(traffic); requireWorkers(workers);
    verifyDistinctEndpointReportResult(distinct, prepared, fixture, oracle);
    result.actualWorkloadOverlap = verifyDistinctWorkloadOverlap(workers, traffic, distinct, startsAtMs);
    result.reports = distinct;
    result.phases.push('6000-offers-distinct64-csv8-and-recomputation-settled');
    result.drains = await drain(); verifyDistinctOwnerDrains(result.drains);
    const after = await rpc(observer, 'snapshot', { since });
    result.persistence = checkPersistence(before, after, traffic, fixture); assert.equal(result.persistence.passed, true);
    assert.equal(after.total - before.total, 6000); assert.equal(after.invalid, 0);
    const native = await rpc(observer, 'distinctAudit', { source, cutoff, oracleSha256: canonical.oracleSha256,
      coverageBeforeSha256: distinctCoverageHash(oracle) });
    verifyDistinctPostProof(native, oracle, fixture);
    result.native = Object.fromEntries(['source', 'cutoff', 'passed', 'coverageBeforeSha256', 'coverageAfterSha256', 'coverageUnchanged',
      'rawOracleSha256', 'auditCount', 'expectedAuditKeysSha256', 'auditRecordsSha256', 'privateRawProofSha256', 'violations'].map(key => [key, native[key]]));
    result.apiSnapshots = await Promise.all(apis.map(owner => rpc(owner, 'snapshot')));
    result.workerSnapshot = await rpc(worker, 'snapshot'); requireDatabase(result.workerSnapshot);
    for (const [index, snapshot] of result.apiSnapshots.entries()) {
      requireDatabase(snapshot);
      assert.equal(snapshot.seenHeartbeatOffers ?? snapshot.http?.seenHeartbeatOffers, traffic.heartbeats.targetHistogram[index]);
    }
    result.phases.push('native-audit-coverage-persistence-and-database-verified'); result.passed = true;
  } catch (error) { result.failure = safeError(error); }
  finally {
    const finalDrains = await Promise.allSettled([...apis, worker].map(async owner => rpc(owner, 'drain')));
    result.finalDrains = finalDrains.map(row => row.status === 'fulfilled' ? row.value : { complete: false, error: safeError(row.reason) });
    try { verifyDistinctOwnerDrains(result.finalDrains); } catch { result.passed = false; result.failure ??= { code: 'DISTINCT_OWNER_DRAIN_FAILED', name: 'AssertionError' }; }
  }
  return result;
}
