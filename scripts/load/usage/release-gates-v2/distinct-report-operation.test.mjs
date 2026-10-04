import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROFILES, OLD_CONTRACT_SHA256 } from './contracts.mjs';
import { patchDrainV2 } from './patch.mjs';
import { DISTINCT_REPORT_CONTRACT, distinctReportContractHash, distinctReportCases, distinctCsvCases, distinctCanonicalKey } from './distinct-reports.mjs';
import { DISTINCT_ENDPOINT_OPERATION, DISTINCT_SERVICE_LIMITS, distinctEndpointOperationHash, distinctCoverageHash,
  validateDistinctRegistration, verifyDistinctPostProof, verifyDistinctOwnerDrains, verifyDistinctEndpointReportResult,
  verifyDistinctWorkloadOverlap, sanitizedDistinctOperationFailure, runDistinctEndpointOperation } from './distinct-report-operation.mjs';

const source = 'ddc5996b3b8645859fa51a9613486db52c481b7f', hash = 'a'.repeat(64);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateBefore = days => new Date(Date.parse('2026-10-04T12:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
const fixture = { sourceRevision: source, today: '2026-10-04', heavyDate: dateBefore(2), emptyDate: dateBefore(3), gapDate: dateBefore(5),
  schools: [0, 1].map(index => ({ index, id: `school${index}`, staff: `staff${index}`,
    students: Array.from({ length: 500 }, (_, student) => `school${index}-student${student}`),
    groups: Array.from({ length: 100 }, (_, group) => `school${index}-group${group}`) })) };
const run = 'a'.repeat(12), helperImage = 'sha256:' + hash;
const owners = ['api0', 'api1', 'api2', 'worker', 'observer', 'generator'].map((role, index) => {
  const id = String(index + 1).repeat(64);
  return { role, id, source, helperImage, ready: { binding: { run, source, role, containerId: id } },
    rpc: () => { throw Error('No native RPC in a pure test'); } };
});
test('an unbound auxiliary owner is rejected before any source-bound role RPC is offered', async () => {
  let called = false;
  const guarded = owners.map(owner => ({ ...owner, rpc: async () => { called = true; throw Error('Unexpected RPC'); } }));
  const worker = { ...guarded[3], source: 'e'.repeat(40) };
  await assert.rejects(runDistinctEndpointOperation({ registration: registration(), fixture, apis: guarded.slice(0, 3),
    worker, observer: guarded[4], generator: guarded[5] }));
  assert.equal(called, false);
});
const apis = owners.slice(0, 3), auxiliaryOwners = { worker: owners[3], observer: owners[4], generator: owners[5] };
const registration = () => ({ source, profile: DISTINCT_ENDPOINT_OPERATION.name,
  run, helperImage, ownerBindings: owners.map(({ ready, helperImage }) => ({ ...ready.binding, helperImage })),
  operationContractSha256: distinctEndpointOperationHash(), reportContractSha256: distinctReportContractHash(),
  helperBindingSha256: hash, snapshotManifestSha256: hash, restorationReceiptSha256: hash, operationalFixtureReceiptSha256: hash,
  schemaInputSha256: '6b40d8811ce1f50eb3f33b3a5ca39256b404699b994c3802c48f86119d0542e3',
  canonicalSourceSchemaSha256: '3afe69c3b2dcdeaae049f24d766c542c5e12cf762227b194db329dc0368df570',
  actualRestorationPassed: true, healthHookAppliedAfterOriginalVerification: true, healthHookRelabeledCanonicalSchema: false,
  sessionCookiePathVerified: true, generatedEndpointOverrideVerified: true,
  nativeHeavyObservationCounts: [1_000_000, 1_000_000], serviceLimits: { ...DISTINCT_SERVICE_LIMITS } });

test('separate operation preserves original cold contract, offering and matrix without relabeling coverage preparation', () => {
  assert.equal(OLD_CONTRACT_SHA256, '10772ca928db810eda736c260f450cbe97ab76d1f130e7124c8e7e5e72815e92');
  assert.notEqual(DISTINCT_ENDPOINT_OPERATION.name, PROFILES.usage.name);
  assert.equal(PROFILES.usage.repetitions, 3); assert.equal(PROFILES.usage.reports, 64);
  assert.equal(DISTINCT_ENDPOINT_OPERATION.offering, PROFILES.usage.offering);
  assert.equal(DISTINCT_ENDPOINT_OPERATION.offering.expected, 6000); assert.equal(DISTINCT_ENDPOINT_OPERATION.offering.requestsPerSecond, 100);
  assert.equal(DISTINCT_ENDPOINT_OPERATION.apiTasks, 3); assert.equal(DISTINCT_ENDPOINT_OPERATION.rawPerSchool, 1_000_000);
  assert.equal(DISTINCT_ENDPOINT_OPERATION.original64MatrixChanged, false); assert.equal(DISTINCT_ENDPOINT_OPERATION.firstComputationColdEvidence, false);
  assert.equal(DISTINCT_ENDPOINT_OPERATION.freshRestoreRequired, true); assert.equal(DISTINCT_ENDPOINT_OPERATION.originalColdRunsRequired, 3);
});
test('registration rejects stale source, absent native custody, auth bypass and changed capacity limits', () => {
  assert.equal(validateDistinctRegistration(registration(), fixture, apis, auxiliaryOwners), true);
  for (const mutate of [row => row.source = 'e'.repeat(40), row => row.snapshotManifestSha256 = '',
    row => row.actualRestorationPassed = false, row => row.healthHookAppliedAfterOriginalVerification = false,
    row => row.healthHookRelabeledCanonicalSchema = true, row => row.sessionCookiePathVerified = false,
    row => row.generatedEndpointOverrideVerified = false, row => row.nativeHeavyObservationCounts[1]--,
    row => row.serviceLimits.apiMainPool++, row => row.serviceLimits.apiTasks = 2, row => row.serviceLimits.workerAcceptanceMs++]) {
    const row = registration(); mutate(row); assert.throws(() => validateDistinctRegistration(row, fixture, apis, auxiliaryOwners));
  }
  assert.throws(() => validateDistinctRegistration(registration(), fixture, [apis[0], apis[0], apis[2]], auxiliaryOwners));
  for (const role of ['worker', 'observer', 'generator']) for (const mutate of [row => row.id = apis[0].id,
    row => row.role = 'other', row => row.source = 'e'.repeat(40), row => row.helperImage = 'sha256:' + 'b'.repeat(64),
    row => row.ready.binding.run = 'b'.repeat(12), row => row.ready.binding.containerId = 'b'.repeat(64)]) {
    const owner = { ...auxiliaryOwners[role], ready: structuredClone(auxiliaryOwners[role].ready) }; mutate(owner);
    assert.throws(() => validateDistinctRegistration(registration(), fixture, apis, { ...auxiliaryOwners, [role]: owner }));
  }
  for (const mutate of [row => row.ownerBindings.pop(), row => row.ownerBindings[3].run = 'b'.repeat(12),
    row => row.ownerBindings[4].helperImage = 'sha256:' + 'b'.repeat(64), row => row.run = 'b'.repeat(12)]) {
    const row = registration(); mutate(row); assert.throws(() => validateDistinctRegistration(row, fixture, apis, auxiliaryOwners));
  }
});
const cleanDrain = () => ({ complete: true, physicallyIdle: true, physicallySettled: true, budgetMs: 20_000, elapsedMs: 10, passes: 2, abortedResponses: 0,
  gauges: Object.fromEntries(['activeOperations', 'pendingCheckouts', 'activeCheckouts', 'pendingAcquisitions', 'activeQueries',
    'poolWaiting', 'poolHeld', 'httpResponses', 'pendingTenantReleases', 'queuedHeartbeats', 'admittedHeartbeats'].map(key => [key, 0])) });
test('physical lease/callback/tenant ownership cannot be declared drained by an HTTP finish or empty gauge object', () => {
  assert.equal(verifyDistinctOwnerDrains(Array.from({ length: 4 }, cleanDrain)), true);
  for (const mutate of [row => row.complete = false, row => row.physicallyIdle = false, row => row.abortedResponses++,
    row => row.gauges.activeOperations++, row => row.gauges.poolHeld++, row => row.gauges.pendingTenantReleases++,
    row => row.physicallySettled = false, row => row.gauges.queuedHeartbeats++, row => row.gauges.admittedHeartbeats++,
    row => delete row.gauges.queuedHeartbeats, row => delete row.gauges.admittedHeartbeats, row => row.gauges.unknownGauge = 0,
    row => row.gauges = {}, row => row.elapsedMs = -1, row => row.elapsedMs = 20_000, row => row.budgetMs++, row => row.passes = 1,
    row => row.passes = Infinity]) {
    const rows = Array.from({ length: 4 }, cleanDrain); mutate(rows[0]); assert.throws(() => verifyDistinctOwnerDrains(rows));
  }
  assert.throws(() => verifyDistinctOwnerDrains(Array.from({ length: 3 }, cleanDrain)));
});
test('actual generated API and worker drains retain both heartbeat admission gauges and reject missing/nonzero owners', async () => {
  const canonical = readFileSync(new URL('../release-enabled-drain.mjs', import.meta.url), 'utf8');
  const actual = await import('data:text/javascript;base64,' + Buffer.from(patchDrainV2(canonical)).toString('base64'));
  const snapshot = role => ({ operations: { schemaVersion: 2,
    operations: Object.fromEntries(actual.RELEASE_DRAIN_OPERATIONS.map(key => [key, { activeOperations: 0, pendingCheckouts: 0, activeCheckouts: 0 }])) },
    database: { pools: { [role]: { waiting: 0, held: 0 } }, pendingAcquisitions: 0, activeQueries: 0 },
    http: { activeResponses: 0, abortedResponses: 0 }, tenantReleases: { pending: 0 },
    ...(role === 'api' ? { heartbeatAdmission: { active: 0, queued: 0 } } : {}) });
  const actualRows = ['api', 'api', 'api', 'scheduler'].map(role => ({ ...cleanDrain(), gauges: actual.releaseDrainGauges(snapshot(role)) }));
  assert.equal(verifyDistinctOwnerDrains(actualRows), true); assert.equal(Object.keys(actualRows[0].gauges).length, 11);
  for (const key of ['queuedHeartbeats', 'admittedHeartbeats']) {
    const changed = structuredClone(actualRows); changed[0].gauges[key]++; assert.throws(() => verifyDistinctOwnerDrains(changed));
    const missing = structuredClone(actualRows); delete missing[0].gauges[key]; assert.throws(() => verifyDistinctOwnerDrains(missing));
  }
  const missingAdmission = actual.releaseDrainGauges({ ...snapshot('api'), heartbeatAdmission: undefined }); assert.equal(missingAdmission, null);
});
const oracle = { source, cutoff: '2026-10-04T07:00:00.000Z', schools: [0, 1].map(schoolIndex => ({ schoolIndex,
  coverage: [{ date: fixture.today, isFinal: false, processedThrough: '2026-10-04T07:00:00.000Z' }] })) };
const postProof = () => ({ source, cutoff: oracle.cutoff, passed: true, coverageBeforeSha256: distinctCoverageHash(oracle),
  coverageAfterSha256: distinctCoverageHash(oracle), coverageUnchanged: true, rawOracleSha256: digest(oracle), auditCount: 8,
  expectedAuditKeysSha256: digest(distinctCsvCases(fixture).map(distinctCanonicalKey)), auditRecordsSha256: hash, privateRawProofSha256: hash,
  violations: { invalidRawBindings: 0, invalidClassificationOrRoster: 0, coverageDifferences: 0, auditDifferences: 0, rawOracleDifferences: 0 } });
test('post proof requires exact cutoff/coverage/raw/audit bindings and complete zero violation categories', () => {
  assert.equal(verifyDistinctPostProof(postProof(), oracle, fixture), true);
  for (const mutate of [row => row.cutoff = '2026-10-04T07:00:01.000Z', row => row.coverageAfterSha256 = 'b'.repeat(64),
    row => row.coverageUnchanged = false, row => row.rawOracleSha256 = 'b'.repeat(64), row => row.auditCount--,
    row => row.expectedAuditKeysSha256 = 'b'.repeat(64), row => row.privateRawProofSha256 = '',
    row => row.violations.auditDifferences++, row => delete row.violations.rawOracleDifferences, row => row.passed = false]) {
    const proof = postProof(); mutate(proof); assert.throws(() => verifyDistinctPostProof(proof, oracle, fixture));
  }
});
test('semantic coverage retains processed cutoff/finality/gaps while allowing legitimate computation timestamp updates', () => {
  const original = distinctCoverageHash(oracle), computed = structuredClone(oracle);
  computed.schools[0].coverage[0].computedAt = '2026-10-04T07:01:00.000Z'; assert.equal(distinctCoverageHash(computed), original);
  computed.schools[0].coverage[0].processedThrough = '2026-10-04T07:00:01.000Z'; assert.notEqual(distinctCoverageHash(computed), original);
  const gap = structuredClone(oracle); gap.schools[0].coverage.push({ date: fixture.gapDate, isFinal: true, processedThrough: fixture.gapDate + 'T23:59:59Z' });
  assert.notEqual(distinctCoverageHash(gap), original);
});
const prepared = { contractSha256: distinctReportContractHash(), preparedHash: hash, expectedSha256: hash, oracleSha256: digest(oracle) };
const startsAtMs = Date.parse('2026-10-04T07:00:00Z');
const reportResult = () => ({ source, startsAtMs, profile: DISTINCT_REPORT_CONTRACT.name, passed: true, capacityAcceptance: false,
  contractSha256: prepared.contractSha256, preparedHash: hash, expectedReportsSha256: hash, independentOracleSha256: digest(oracle),
  currentProcessedCutoff: oracle.cutoff, peakInFlight: 16,
  checks: Object.fromEntries(['all64ActualAuthenticatedEndpoints', 'allRequestsWithinUnchangedDeadline', 'actualDeclaredOffers',
    'uniqueRequestAndEffectiveKeys', 'all8CsvCorrect', 'drainedClientOffers', 'concurrentEndpointWorkObserved'].map(key => [key, true])),
  reportCases: distinctReportCases(fixture).map(item => ({ ...item, requestKeySha256: distinctCanonicalKey(item), effectiveKeySha256: distinctCanonicalKey(item),
    status: 200, correct: true, durationMs: 5, offerLatenessMs: 0, declaredOffsetMs: item.wave * 15_000, offeredOffsetMs: item.wave * 15_000 })),
  csvCases: distinctCsvCases(fixture).map(item => ({ ...item, requestKeySha256: distinctCanonicalKey(item), csvSha256: hash,
    status: 200, correct: true, durationMs: 5, offerLatenessMs: 0, declaredOffsetMs: 45_005, offeredOffsetMs: 45_005 })) });
test('a passed flag cannot hide missing/duplicate requests, overload, changed endpoints or deadline failures', () => {
  assert.equal(verifyDistinctEndpointReportResult(reportResult(), prepared, fixture, oracle), true);
  for (const mutate of [row => row.reportCases.pop(), row => row.reportCases[1] = row.reportCases[0], row => row.csvCases.pop(),
    row => row.reportCases[0].status = 503, row => row.reportCases[0].endpointIndex = 2,
    row => row.reportCases[0].effectiveKeySha256 = hash, row => row.reportCases[0].durationMs = 20_000,
    row => row.reportCases[0].offerLatenessMs = 101, row => row.reportCases[0].offeredOffsetMs = 200,
    row => delete row.csvCases[0].offeredOffsetMs, row => row.csvCases[0].correct = false,
    row => delete row.checks.all8CsvCorrect, row => row.checks.drainedClientOffers = false,
    row => row.preparedHash = 'b'.repeat(64), row => row.currentProcessedCutoff = '2026-10-04T07:00:01Z']) {
    const result = reportResult(); mutate(result); assert.throws(() => verifyDistinctEndpointReportResult(result, prepared, fixture, oracle));
  }
});
test('fulfilled worker/report promises do not substitute for actual native HTTP overlap or impose a new worker-start SLO', () => {
  const traffic = { heartbeats: { declaredStartedAtMs: startsAtMs, actualStartedAtMs: startsAtMs + 20, offerWindowMs: 60_000 } };
  const workers = [0, 1].map(schoolIndex => ({ schoolIndex, correct: true, durationMs: 1000,
    startedAtMs: startsAtMs + 30, finishedAtMs: startsAtMs + 1030 }));
  const reports = reportResult(); reports.reportCases.filter(row => row.wave === 0).forEach(row => { row.offeredOffsetMs = 25; row.durationMs = 100; });
  assert.equal(verifyDistinctWorkloadOverlap(workers, traffic, reports, startsAtMs).passed, true);
  const laterButOverlapping = structuredClone(workers); laterButOverlapping[0].startedAtMs = startsAtMs + 101;
  laterButOverlapping[0].finishedAtMs = startsAtMs + 1101;
  assert.equal(verifyDistinctWorkloadOverlap(laterButOverlapping, traffic, reports, startsAtMs).passed, true);
  for (const mutate of [rows => rows[0].startedAtMs = startsAtMs - 1,
    rows => { rows[0].startedAtMs = startsAtMs + 60_100; rows[0].finishedAtMs = startsAtMs + 61_100; },
    rows => rows[0].finishedAtMs = rows[0].startedAtMs, rows => delete rows[0].startedAtMs]) {
    const changed = structuredClone(workers); mutate(changed); assert.throws(() => verifyDistinctWorkloadOverlap(changed, traffic, reports, startsAtMs));
  }
  const missedHeartbeat = structuredClone(traffic); missedHeartbeat.heartbeats.actualStartedAtMs = startsAtMs + 101;
  assert.throws(() => verifyDistinctWorkloadOverlap(workers, missedHeartbeat, reports, startsAtMs));
  const missedReports = structuredClone(reports); missedReports.reportCases.forEach(row => row.offeredOffsetMs += 2000);
  assert.throws(() => verifyDistinctWorkloadOverlap(workers, traffic, missedReports, startsAtMs));
  const reboundStart = structuredClone(reports); reboundStart.startsAtMs++;
  assert.throws(() => verifyDistinctWorkloadOverlap(workers, traffic, reboundStart, startsAtMs));
});
test('public operation failures contain only bounded error names and uppercase machine codes', () => {
  assert.deepEqual(sanitizedDistinctOperationFailure({ name: 'AssertionError', code: 'ERR_ASSERTION' }), { name: 'AssertionError', code: 'ERR_ASSERTION' });
  for (const code of ['https://private.example/student', 'secret-name', 'A'.repeat(65), { toString: () => 'LEAK' }])
    assert.deepEqual(sanitizedDistinctOperationFailure({ name: 'private student name', code }), { name: 'Error', code: 'DISTINCT_OPERATION_FAILED' });
});
