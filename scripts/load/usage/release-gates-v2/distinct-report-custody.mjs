import assert from 'node:assert/strict';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { hash, PROFILES, profileHash } from './contracts.mjs';
import { currentObservationSeconds, currentObservationFixtureViolations } from '../local-usage-scale.mjs';
import { schoolDayOracle } from '../school-day-profile.mjs';
import { verifyClassroomBindings } from './lifecycle-audience.mjs';
import { checkPersistence } from './persistence.mjs';
import { assertDistinctOracle, countDistinctCurrentObservations, assertDistinctAuditRecords,
  prepareDistinctReports, distinctPreparedStateHash } from './distinct-reports.mjs';
import { DISTINCT_SERVICE_LIMITS, distinctEndpointOperationHash, verifyDistinctEndpointReportResult,
  verifyDistinctPostProof, verifyDistinctOwnerDrains, verifyDistinctWorkloadOverlap, verifyDistinctHeartbeatTraffic, validateDistinctRegistration } from './distinct-report-operation.mjs';

const digest = value => hash(JSON.stringify(value));
const contained = (root, name) => {
  const file = realpathSync(join(root, name)), rel = relative(root, file);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'), 'Distinct proof escaped its custody root');
  return file;
};
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const dayAfter = date => new Date(Date.parse(date + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
function localBoundary(microseconds, date) {
  assert.match(microseconds, /^\d+$/); const at = BigInt(microseconds); assert.equal(at % 1000n, 0n);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Number(at / 1000n)));
  const value = name => parts.find(part => part.type === name)?.value;
  assert.equal(['year', 'month', 'day'].map(value).join('-'), date);
  assert.equal(['hour', 'minute', 'second'].map(value).join(':'), '00:00:00');
  return at;
}

// Recompute expectations from the retained exact native rows. Equal totals or
// hash-shaped response fields alone cannot certify school-local attribution.
export function replayDistinctNativeRecord(record, fixture, { run, source, runtimeRole }) {
  assert.equal(record.run, run); assert.equal(record.source, source); assert.equal(record.cutoff, record.oracle.cutoff);
  assertDistinctOracle(fixture, record.oracle); assert.equal(record.native.length, 2);
  const reconstructed = [];
  for (const school of fixture.schools) {
    const rows = record.native.filter(row => row.schoolIndex === school.index); assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual(row.role, { role: runtimeRole, rolsuper: false, rolbypassrls: false, school: school.id, is_super: 'off' });
    assert.deepEqual(row.scoped, { students: 0, heartbeats: 0, coverage: 0 }); assert.equal(row.window.zone, 'America/New_York');
    const start = localBoundary(row.window.start_microseconds, fixture.today);
    const end = localBoundary(row.window.end_microseconds, dayAfter(fixture.today));
    const cutoff = BigInt(Date.parse(record.cutoff)) * 1000n; assert.ok(cutoff >= start && cutoff < end);
    const students = new Map(school.students.map((id, index) => [id, school.devices[index]]));
    assert.ok(Array.isArray(row.raw) && new Set(row.raw.map(item => item.id)).size === row.raw.length);
    for (const item of row.raw) {
      assert.ok(typeof item.id === 'string' && item.id.length > 0); assert.equal(item.school_id, school.id);
      assert.equal(item.device_id, students.get(item.student_id)); assert.equal(item.valid_binding, true);
      assert.match(item.timestamp_microseconds, /^\d+$/);
      assert.ok(BigInt(item.timestamp_microseconds) >= start && BigInt(item.timestamp_microseconds) < cutoff);
    }
    const violations = currentObservationFixtureViolations(row.raw, school.students, row.counts);
    assert.deepEqual(row.violations, violations); assert.ok(Object.values(violations).every(count => count === 0));
    assert.ok(row.coverage.every(item => item.valid_window === true));
    for (const item of row.coverage) if (item.is_final) {
      localBoundary(String(BigInt(Date.parse(item.processed_through)) * 1000n), dayAfter(item.date));
    }
    reconstructed.push({ schoolIndex: school.index, invalidRawBindings: 0, invalidClassificationOrRoster: 0,
      ...countDistinctCurrentObservations(row.raw, record.cutoff),
      secondsByStudent: [...currentObservationSeconds(row.raw, new Date(record.cutoff))].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      coverage: row.coverage.map(item => ({ date: item.date, isFinal: item.is_final, processedThrough: new Date(item.processed_through).toISOString() })) });
  }
  assert.deepEqual(record.oracle.schools, reconstructed);
  assert.equal(record.rawPrefixSha256, digest(record.native.map(({ schoolIndex, raw }) => ({ schoolIndex, raw }))));
  assert.deepEqual(record.audits, record.native.flatMap(row => row.auditRecords));
  return record.oracle;
}

function rpcRecords(root, role, metrics) {
  const control = contained(root, role), binding = read(contained(control, 'binding.json'));
  assert.equal(binding.run, metrics.run); assert.equal(binding.source, metrics.source); assert.equal(binding.role, role);
  const exit = metrics.roleCleanup.exits.find(row => row.role === role); assert.equal(exit?.containerId, binding.containerId);
  const records = [];
  const names = readdirSync(control).filter(name => /^request-\d+\.json$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const [index, name] of names.entries()) {
    const request = read(contained(control, name)); assert.equal(request.nonce, binding.nonce);
    assert.equal(request.id, index + 1);
    const response = read(contained(control, `response-${request.id}.json`)); assert.equal(response.id, request.id);
    assert.deepEqual(response.binding, { run: metrics.run, source: metrics.source, role, containerId: binding.containerId });
    assert.equal(response.error, undefined, 'A failed owned RPC cannot certify distinct acceptance');
    records.push({ request, value: response.value });
  }
  return records;
}
function only(records, operation) { const matching = records.filter(row => row.request.operation === operation); assert.equal(matching.length, 1); return matching[0]; }

export function verifyDistinctReceiptCustody(receiptDirectory, privateDirectory, metrics) {
  assert.equal(metrics.profile, PROFILES.usageDistinct.name); assert.equal(metrics.contractSha256, profileHash(PROFILES.usageDistinct));
  assert.equal(metrics.distinctReportRpc, true); assert.equal(metrics.originalColdRunPrerequisites?.length, 3);
  assert.equal(new Set(metrics.originalColdRunPrerequisites.map(row => row.run)).size, 3);
  const root = realpathSync(privateDirectory), receiptRoot = realpathSync(receiptDirectory);
  const recorded = read(contained(receiptRoot, 'distinct-endpoint-operation.json'));
  assert.deepEqual(recorded, metrics.distinctOperation); assert.equal(recorded.passed, true);
  assert.equal(recorded.operationContractSha256, distinctEndpointOperationHash());
  const registration = read(contained(receiptRoot, 'distinct-registration.json'));
  assert.equal(digest(registration), recorded.registrationSha256);
  assert.deepEqual(registration.serviceLimits, DISTINCT_SERVICE_LIMITS);
  assert.equal(registration.source, metrics.source); assert.equal(registration.run, metrics.run);
  assert.equal(registration.helperImage, metrics.helperImage); assert.equal(registration.helperBindingSha256, metrics.helperBindingSha256);
  assert.equal(registration.snapshotManifestSha256, metrics.snapshotManifestSha256);
  assert.deepEqual(registration.ownerBindings.map(row => row.role), ['api0', 'api1', 'api2', 'worker', 'observer', 'generator']);
  for (const row of registration.ownerBindings) {
    const control = contained(root, row.role), actual = read(contained(control, 'binding.json'));
    const ready = read(contained(control, 'ready.json')), exit = metrics.roleCleanup.exits.find(item => item.role === row.role);
    const expected = { run: metrics.run, source: metrics.source, role: row.role, containerId: actual.containerId };
    assert.deepEqual(row, { ...expected, helperImage: metrics.helperImage }); assert.deepEqual(ready.binding, expected);
    assert.equal(exit?.containerId, actual.containerId); assert.equal(exit.helperImage, metrics.helperImage);
    assert.equal(exit.clean, true);
  }
  const restoreBytes = readFileSync(contained(receiptRoot, 'ready.json')), restore = JSON.parse(restoreBytes);
  assert.equal(hash(restoreBytes), registration.restorationReceiptSha256); assert.equal(restore.restorationPassed, true);
  assert.equal(restore.source, metrics.source); assert.equal(restore.run, metrics.run); assert.equal(restore.snapshotManifestSha256, metrics.snapshotManifestSha256);
  const bootstrapBytes = readFileSync(contained(receiptRoot, 'operational-fixture-bootstrap.json'));
  assert.equal(hash(bootstrapBytes), registration.operationalFixtureReceiptSha256);
  assert.equal(JSON.parse(bootstrapBytes).originalSnapshotRestore.restorationPassed, true);
  const validated = read(contained(receiptRoot, 'database-validation.json')), comparison = read(contained(receiptRoot, 'schema-comparison.json'));
  assert.equal(validated.passed, true); assert.equal(validated.clientsClosed, true); assert.equal(validated.source, metrics.source);
  assert.equal(validated.snapshotManifestSha256, metrics.snapshotManifestSha256);
  assert.equal(validated.schools.length, 2); assert.ok(validated.schools.every(row => row.raw === 1_000_001 && row.heavyBindings.invalid === 0));
  assert.equal(validated.migrations,54);assert.equal(validated.admittedTables,129);assert.deepEqual(validated.migrationRows,metrics.databasePreparation.migrations);
  assert.equal(validated.role.superuser,false);assert.equal(validated.role.bypassRls,false);assert.equal(validated.role.freshCredentialRole,true);
  assert.deepEqual(validated.screenshotEvidence,{signature:'public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)',
    runtimeExecute:true,publicExecute:false,exactDefinition:true});
  assert.equal(comparison.passed, true);
  for (const key of ['originalCanonicalSha256', 'referenceCanonicalSha256', 'restoredCanonicalSha256']) assert.equal(comparison[key], metrics.schemaSha256);
  const restarted = read(contained(receiptRoot, 'cold-restart-receipt.json'));
  assert.equal(restarted.run, metrics.run); assert.equal(restarted.restarted, true); assert.equal(restarted.clientsClosed, true);
  assert.equal(metrics.databasePreparation.restrictedRole, true); assert.equal(metrics.databasePreparation.crossSchool, true);
  assert.deepEqual(metrics.databasePreparation.distinctHeavyRows, [{ schoolIndex: 0, count: 1_000_000 }, { schoolIndex: 1, count: 1_000_000 }]);

  const observer = rpcRecords(root, 'observer', metrics), generator = rpcRecords(root, 'generator', metrics);
  const fixture = only(observer, 'initialize').value; assert.equal(fixture.sourceRevision, metrics.source);
  assert.equal(validated.database.today,fixture.today);
  const owners=registration.ownerBindings.map(row=>({role:row.role,id:row.containerId,source:metrics.source,helperImage:metrics.helperImage,
    ready:read(contained(root,row.role+'/ready.json')),rpc:()=>{throw Error('Custody replay never invokes a role');}}));
  validateDistinctRegistration(registration,fixture,owners.slice(0,3),{worker:owners[3],observer:owners[4],generator:owners[5]});
  assert.equal(digest(fixture), metrics.distinctFixtureSha256);
  assert.deepEqual(only(generator, 'initialize').request.value, fixture);
  const beforeBytes = readFileSync(contained(root, 'observer/distinct-native-1.private.json'));
  const afterBytes = readFileSync(contained(root, 'observer/distinct-native-2.private.json'));
  const before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes);
  assert.equal(before.kind, 'distinct-report-native-before'); assert.equal(after.kind, 'distinct-report-native-after');
  assert.equal(after.beforeProofSha256, hash(beforeBytes)); assert.equal(after.cutoff, before.cutoff);
  const oracle = replayDistinctNativeRecord(before, fixture, { ...metrics, runtimeRole: restore.freshRole });
  replayDistinctNativeRecord(after, fixture, { ...metrics, runtimeRole: restore.freshRole });
  assert.deepEqual(after.oracle, before.oracle); assert.equal(after.rawPrefixSha256, before.rawPrefixSha256);
  assert.equal(before.audits.length, 0); const audits = assertDistinctAuditRecords(fixture, after.audits);
  const native = only(observer, 'distinctAudit').value; assert.equal(native.privateRawProofSha256, hash(afterBytes));
  assert.equal(native.auditRecordsSha256, digest(after.audits)); assert.equal(native.expectedAuditKeysSha256, audits.expectedKeysSha256);
  assert.deepEqual(recorded.native, native); verifyDistinctPostProof(native, oracle, fixture);
  assert.deepEqual(only(observer, 'distinctOracle').value, oracle);
  const prepared = only(generator, 'prepareDistinctReports').value, canonical = prepareDistinctReports(fixture, oracle);
  assert.equal(prepared.preparedHash, distinctPreparedStateHash({ run: metrics.run, fixture, oracle, prepared: canonical }));
  const reports = only(generator, 'distinctReports'); assert.equal(reports.request.value.preparedHash, prepared.preparedHash);
  assert.deepEqual(reports.value, recorded.reports); verifyDistinctEndpointReportResult(reports.value, prepared, fixture, oracle);
  const phase = only(generator, 'phase').value; assert.deepEqual(phase, metrics.continuousTraffic);
  assert.ok(only(generator,'initialize').request.id<only(generator,'prepareDistinctReports').request.id
    &&only(generator,'prepareDistinctReports').request.id<only(generator,'phase').request.id
    &&only(generator,'prepareDistinctReports').request.id<reports.request.id);
  verifyDistinctHeartbeatTraffic(phase);
  assert.equal(recorded.concurrent[0].valueSha256, digest(phase)); assert.equal(recorded.concurrent[1].valueSha256, digest(reports.value));
  const workerRecords = rpcRecords(root, 'worker', metrics);
  const currentWorkers = workerRecords.filter(row => row.request.operation === 'rollup' && row.request.value.date === fixture.today);
  assert.equal(currentWorkers.length, 2);
  for (const record of currentWorkers) {
    assert.equal(record.request.value.cutoff, before.cutoff);
    const school = fixture.schools.find(row => row.id === record.request.value.schoolId); assert.ok(school);
    const expected = oracle.schools.find(row => row.schoolIndex === school.index);
    assert.equal(record.value.seconds, expected.secondsByStudent.reduce((sum, [, seconds]) => sum + seconds, 0));
    assert.equal(record.value.heartbeatCount, expected.deduplicatedRows);
    assert.ok(record.value.durationMs <= 48_000);
  }
  const heavyRecords = workerRecords.filter(row => row.request.operation === 'rollup' && row.request.value.date === fixture.heavyDate);
  assert.equal(heavyRecords.length, 4);
  const preparedWorkers=heavyRecords.slice(0,2).map(row=>({schoolIndex:fixture.schools.find(school=>school.id===row.request.value.schoolId)?.index,...row.value,correct:true}));
  assert.deepEqual(preparedWorkers,recorded.preparation.heavyWorkers);
  const workers = heavyRecords
    .slice(-2).map(row => ({ schoolIndex: fixture.schools.find(school => school.id === row.request.value.schoolId)?.index, ...row.value, correct: true }));
  // The live coordinator already checked independent heavy totals. Replay the
  // same native worker replies and concurrency intervals, including raw totals.
  for (const row of workers) {
    const independent = schoolDayOracle('school');
    assert.equal(row.seconds, independent.monitored); assert.equal(row.heartbeatCount, independent.heartbeats); assert.equal(row.rowCount, independent.grains);
    const declared = recorded.preparation.heavyWorkers.find(item => item.schoolIndex === row.schoolIndex);
    for (const key of ['seconds', 'heartbeatCount', 'rowCount']) assert.equal(row[key], declared[key]);
  }
  for (const row of recorded.preparation.heavyWorkers) {
    const expected = schoolDayOracle('school');
    assert.equal(row.correct, true); assert.ok(row.durationMs <= 48_000);
    assert.equal(row.seconds, expected.monitored); assert.equal(row.heartbeatCount, expected.heartbeats); assert.equal(row.rowCount, expected.grains);
  }
  assert.equal(recorded.concurrent[2].valueSha256, digest(workers));
  assert.deepEqual(verifyDistinctWorkloadOverlap(workers, phase, reports.value, reports.request.value.startsAtMs), recorded.actualWorkloadOverlap);
  verifyDistinctOwnerDrains(recorded.drains); verifyDistinctOwnerDrains(recorded.finalDrains);
  const observedSnapshots=observer.filter(row=>row.request.operation==='snapshot');assert.equal(observedSnapshots.length,2);
  assert.ok(only(observer,'distinctOracle').request.id<observedSnapshots[0].request.id
    &&observedSnapshots[0].request.id<observedSnapshots[1].request.id&&observedSnapshots[1].request.id<only(observer,'distinctAudit').request.id
    &&only(observer,'distinctAudit').request.id<only(observer,'correctness').request.id);
  const persistence=checkPersistence(observedSnapshots[0].value,observedSnapshots[1].value,phase,fixture);
  assert.equal(persistence.passed,true);assert.deepEqual(persistence,recorded.persistence);
  assert.equal(observedSnapshots[1].value.total-observedSnapshots[0].value.total,6000);assert.equal(observedSnapshots[1].value.invalid,0);
  const roles=['api0','api1','api2','worker'],initialDrains=[],drains=[],finalDrains=[];
  for(const role of roles){
    const records=role==='worker'?workerRecords:rpcRecords(root,role,metrics);
    const actualDrains=records.filter(row=>row.request.operation==='drain');assert.equal(actualDrains.length,3);
    initialDrains.push(actualDrains[0].value);drains.push(actualDrains[1].value);finalDrains.push(actualDrains[2].value);
    const snapshot=only(records,'snapshot').value;
    assert.ok(snapshot.database.acquisitions.count>0);assert.equal(snapshot.database.acquisitions.failures,0);
    assert.ok(Object.keys(snapshot.database.statements).length>0);assert.ok(Object.values(snapshot.database.statements).every(row=>row.failures===0));
    if(role==='worker')assert.deepEqual(snapshot,recorded.workerSnapshot);
    else{const index=Number(role.slice(-1));assert.deepEqual(snapshot,recorded.apiSnapshots[index]);
      assert.equal(snapshot.seenHeartbeatOffers??snapshot.http?.seenHeartbeatOffers,phase.heartbeats.targetHistogram[index]);}
  }
  verifyDistinctOwnerDrains(initialDrains);
  assert.deepEqual(drains,recorded.drains);assert.deepEqual(finalDrains,recorded.finalDrains);
  const classroomBytes = readFileSync(contained(root, 'observer/classroom-bindings.private.json'));
  const classroom = { ...verifyClassroomBindings({ ...JSON.parse(classroomBytes), fixture, profile: PROFILES.usageDistinct }), nativeRowsSha256: hash(classroomBytes) };
  assert.deepEqual(classroom, metrics.distinctClassroomBindings); assert.equal(classroom.passed, true);
  assert.deepEqual(only(observer, 'correctness').value, classroom);
  const copy = read(contained(receiptRoot, 'distinct-classroom-bindings.json')); assert.deepEqual(copy, classroom);
  return { verified: true, beforeProofSha256: hash(beforeBytes), afterProofSha256: hash(afterBytes),
    nativeRowsSha256: hash(classroomBytes), reportPreparedHash: prepared.preparedHash };
}
