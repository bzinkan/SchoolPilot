import assert from 'node:assert/strict';
import { canonicalHash, hash, validateCampaign } from './receipt-loader.mjs';
import { PROFILE, ROLE_LIMITS, POOL_LIMITS, FIXTURE_LIMITS, LIFECYCLE_EVENTS } from './profile.mjs';
import { RELEASE_ENABLED_PROFILE, capacityAcceptance } from '../release-enabled-profile.mjs';
import { OPEN_LOOP_HEARTBEATS } from '../open-loop-heartbeats.mjs';
import { RELEASE_DRAIN_OPERATIONS, releaseServerIsIdle, releaseDrainGauges } from '../release-enabled-drain.mjs';
import { verifyResourceSnapshot, resourceDelta } from './role-resources.mjs';

// Pure evidence validation. No run, image, database, receipt or activation is
// changed here. The loader's independently retained hashes establish custody;
// these checks establish what the bound owner receipts actually demonstrate.
const roles = Object.keys(ROLE_LIMITS);
const scopes = ['school', 'grade', 'class', 'student'];
const days = [1, 7, 30, 365];
const modernHeartbeatCapabilities = Object.freeze([
  'preciseRestrictionResourcesV1', 'focusTabV1', 'privateChatLifecycleV1',
  'lateSignInRestrictionSsoV1', 'restrictionAuthPassThroughV1', 'screenshotTrackingWindowLeaseV1',
]);
const sha = value => assert.match(value, /^[a-f0-9]{64}$/);
const digest = value => assert.match(value, /^sha256:[a-f0-9]{64}$/);
const source = value => assert.match(value, /^[a-f0-9]{40}$/);
const finite = value => assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0);
const count = value => { finite(value); assert.ok(Number.isSafeInteger(value)); };
const date = value => { assert.equal(typeof value, 'string'); const n = Date.parse(value); assert.ok(Number.isFinite(n)); return n; };
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const noError = value => { for (const key of ['error', 'failure', 'cleanupError']) assert.equal(value[key], undefined); };
const exact = (rows, key, values) => {
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, values.length);
  return values.map(value => { const found = rows.filter(row => row[key] === value); assert.equal(found.length, 1); return found[0]; });
};
const bounded = (value, limit, inclusive = true) => { finite(value); assert.ok(inclusive ? value <= limit : value < limit); };
const rawObject = (raw, expected, expectedHash) => { assert.equal(typeof raw, 'string'); sha(expectedHash); assert.equal(hash(raw), expectedHash); assert.deepEqual(JSON.parse(raw), expected); };

export const CAMPAIGN_CONTRACT_SHA256 = canonicalHash({
  profile: PROFILE, roles: ROLE_LIMITS, pools: POOL_LIMITS, fixtures: FIXTURE_LIMITS,
  offering: OPEN_LOOP_HEARTBEATS, reports: RELEASE_ENABLED_PROFILE.reportOffers,
  fullWorkerAcceptanceMs: 48_000, publicRequestDeadlineMs: 20_000,
  lifecycleEvents: LIFECYCLE_EVENTS, originalComparison: RELEASE_ENABLED_PROFILE.name,
  modernHeartbeats: { http200:6000, http204:0, initialObservationsPerSchool:6, finalObservationsPerSchool:3006, requiredCapabilities:modernHeartbeatCapabilities },
});

function identityCheck(identity) {
  keys(identity, ['candidate', 'helper', 'harness', 'profileSha256', 'validatorSha256', 'contractSha256', 'schemaSha256', 'registrySha256', 'migrationSha256']);
  keys(identity.candidate, ['indexDigest', 'platformManifestDigest', 'configDigest', 'scanReceiptSha256']);
  for (const key of ['indexDigest', 'platformManifestDigest', 'configDigest']) digest(identity.candidate[key]);
  sha(identity.candidate.scanReceiptSha256);
  keys(identity.helper, ['imageId', 'runtimeConfigDigest', 'bindingSha256', 'runtimeSha256']);
  digest(identity.helper.imageId); digest(identity.helper.runtimeConfigDigest);
  sha(identity.helper.bindingSha256); sha(identity.helper.runtimeSha256);
  keys(identity.harness, ['identity', 'files', 'executed']); sha(identity.harness.identity);
  assert.ok(Object.keys(identity.harness.files).length > 0);
  for (const [name, value] of Object.entries(identity.harness.files)) { assert.match(name, /^[a-z0-9][a-z0-9.-]+\.(?:mjs|ps1)$/); sha(value); }
  assert.equal(identity.harness.identity, hash(JSON.stringify(identity.harness.files)));
  keys(identity.harness.executed, roles); Object.values(identity.harness.executed).forEach(sha);
  for (const key of ['profileSha256', 'validatorSha256', 'schemaSha256', 'registrySha256', 'migrationSha256']) sha(identity[key]);
  assert.equal(identity.contractSha256, CAMPAIGN_CONTRACT_SHA256);
  assert.equal(identity.profileSha256, identity.harness.files['profile.mjs']);
  assert.equal(identity.validatorSha256, identity.harness.files['campaign-validation.mjs']);
}

function planCheck(b, trustedPlanSha256) {
  const p = b.plan; rawObject(b.planRaw, p, trustedPlanSha256);
  assert.equal(p.schemaVersion, 2); assert.match(p.run, /^[a-f0-9]{12}$/);
  assert.match(p.nonce, /^[a-f0-9-]{32,64}$/); source(p.source); date(p.declaredAt);
  sha(p.campaignSha256); sha(p.previousEntrySha256); count(p.ordinal); assert.ok(p.ordinal > 0);
  assert.equal(p.mode, 'capacity-candidate'); assert.equal(p.profile, PROFILE);
  assert.equal(p.phase, 'combined'); assert.equal(p.diagnosticOnly, false); assert.equal(p.cpuProfile, false);
  identityCheck(p.identity);
  const f = b.final;
  assert.equal(f.source, p.source); assert.equal(f.clean, true); assert.equal(f.unchanged, true);
  assert.equal(f.harnessSha256, p.identity.harness.identity);
}

function imageCheck(b) {
  const { identity: i, source: s } = b.plan, c = b.candidate, r = b.runtime;
  rawObject(c.scanRaw, c.scan, i.candidate.scanReceiptSha256);
  assert.equal(c.scan.passed, true); assert.equal(c.scan.sourceSha, s);
  assert.equal(c.scan.imageId, i.candidate.indexDigest); assert.equal(c.scan.configDigest, i.candidate.configDigest);
  assert.equal(c.scan.os, 'linux'); assert.equal(c.scan.architecture, 'amd64');
  assert.equal(c.scan.counts.HIGH, 0); assert.equal(c.scan.counts.CRITICAL, 0);
  for (const name of ['indexDigest', 'platformManifestDigest', 'configDigest']) assert.equal(c.image[name], i.candidate[name]);
  rawObject(r.bindingRaw, r.binding, i.helper.bindingSha256);
  const binding = r.binding;
  assert.equal(binding.applicationSource, s); assert.equal(binding.passed, true); assert.equal(binding.cleanupPassed, true);
  assert.equal(binding.applicationChanges, 0); assert.ok(binding.allowedModes.includes('capacity-candidate'));
  assert.equal(binding.candidateImageId, i.candidate.indexDigest); assert.equal(binding.candidateConfigDigest, i.candidate.configDigest);
  assert.equal(binding.candidateScanReceiptSha256, i.candidate.scanReceiptSha256);
  assert.equal(binding.roleImageId, i.helper.imageId); assert.equal(binding.runtimeConfigDigest, i.helper.runtimeConfigDigest);
  assert.equal(binding.runtimeSha256, i.helper.runtimeSha256); assert.equal(binding.harnessIdentity, i.harness.identity);
  assert.deepEqual(binding.roleHarnessSha256, i.harness.files); assert.deepEqual(binding.harnessHashes, i.harness.executed);
  assert.equal(r.proof.runtimeSha256, i.helper.runtimeSha256); assert.match(r.proof.node, /^v\d+\.\d+\.\d+$/);
}

function preparationCheck(b, trustedPlanSha256) {
  const p = b.plan, prep = b.preparation, cold = b.cold, gate = b.gate, e = b.execution, db = b.database;
  assert.equal(prep.run, p.run); assert.equal(prep.source, p.source); assert.equal(prep.mode, p.mode);
  assert.equal(prep.profile, p.profile); assert.equal(prep.planSha256, trustedPlanSha256); assert.equal(prep.fresh, true);
  sha(prep.pgContainerId); sha(prep.redisContainerId); assert.notEqual(prep.pgContainerId, prep.redisContainerId);
  assert.ok(date(prep.startedAt) > date(p.declaredAt)); assert.ok(date(prep.finishedAt) >= date(prep.startedAt));
  const restore = prep.restore, validation = restore.databaseValidation;
  assert.equal(restore.source, p.source); sha(restore.snapshotManifestSha256);
  assert.equal(restore.analyze, true); assert.equal(restore.clientsClosed, true);
  assert.equal(validation.source, p.source); assert.equal(validation.seedSource, p.source);
  assert.equal(validation.snapshotManifestSha256, restore.snapshotManifestSha256);
  assert.equal(validation.passed, true); assert.equal(validation.clientsClosed, true); assert.equal(validation.measurementStarted, false);
  assert.equal(validation.admittedTables, 129); assert.equal(validation.migrations, 53);
  assert.equal(validation.migrationsSha256, p.identity.migrationSha256);
  assert.deepEqual(validation.role, {sameUser:true, superuser:false, bypassRls:false, freshCredentialRole:true});
  for (const row of exact(validation.schools, 'index', [0, 1])) {
    for (const [key, value] of Object.entries({raw:1000001,aggregates:541500,currentSessions:100,rosterRows:500,staffBindings:100,staffIdentities:101,controls:500,exactLiveBindings:500})) assert.equal(row[key], value);
    assert.deepEqual(row.heavyBindings, {pairs:500,devices:500,invalid:0});
    assert.deepEqual(row.ai, {rows:10000,students:500,observations:10000,invalid:0,minperstudent:20,maxperstudent:20});
    assert.deepEqual(row.clocks, {schools:1,licenses:1,controls:500,sessions:100});
  }
  const schema = restore.schemaComparison;
  assert.equal(schema.passed, true); sha(schema.originalSha256); sha(schema.referenceSha256); sha(schema.restoredSha256);
  assert.equal(schema.originalCanonicalSha256, p.identity.schemaSha256);
  sha(schema.referenceNormalizedSha256); assert.equal(schema.restoredNormalizedSha256, schema.referenceNormalizedSha256);
  sha(schema.referenceCanonicalSha256); assert.equal(schema.restoredCanonicalSha256, schema.referenceCanonicalSha256);
  assert.equal(db.schemaSha256, p.identity.schemaSha256); assert.equal(db.registrySha256, p.identity.registrySha256);
  assert.equal(db.nativeRenderedSchemaSha256, schema.restoredNormalizedSha256);
  assert.equal(db.migrations.length, 53); assert.equal(new Set(db.migrations.map(row => row.id)).size, 53);
  assert.ok(db.migrations.every(row => typeof row.id === 'string' && row.id && row.status === 'complete'));
  db.migrations.forEach(row => sha(row.checksum)); assert.equal(hash(JSON.stringify(db.migrations)), p.identity.migrationSha256);
  assert.deepEqual(db.admission, {inventory:'classpilotPrivateChatLifecyclePostExpand',tables:129,forced:true,restrictedNonOwnerRole:true});
  assert.equal(cold.run, p.run); assert.equal(cold.pgContainerId, prep.pgContainerId);
  for (const key of ['clientsClosed', 'restarted', 'startedAfterValidation']) assert.equal(cold[key], true);
  for (const state of [cold.before, cold.after]) {
    assert.equal(state.Running, true); assert.equal(state.Paused, false); assert.equal(state.Restarting, false);
    assert.equal(state.OOMKilled, false); assert.equal(state.Dead, false); assert.equal(state.Error, '');
  }
  assert.ok(date(cold.after.StartedAt) > date(cold.before.StartedAt));
  assert.ok(date(cold.validatedAt) >= date(validation.finishedAt));
  assert.ok(date(cold.after.StartedAt) >= date(cold.restartedAt));
  assert.ok(date(cold.restartedAt) >= date(gate.releasedAt));
  assert.ok(date(gate.releasedAt) >= date(prep.finishedAt));
  // A released gate may trigger another read-only expiry check. Every such
  // check must finish before the cold restart, never warm the restarted DB.
  assert.ok(date(cold.validatedAt) <= date(cold.restartedAt));
  assert.ok(date(restore.validityHorizon) > date(b.metrics.finishedAt));
  assert.ok(date(b.metrics.startedAt) >= date(cold.after.StartedAt));
  assert.equal(prep.redis.containerId, prep.redisContainerId); assert.equal(prep.redis.pgContainerId, prep.pgContainerId);
  assert.equal(prep.redis.afterColdRestart, true);
  assert.ok(date(prep.redis.createdAt) >= date(cold.after.StartedAt));
  assert.ok(date(prep.redis.readyAt) >= date(prep.redis.createdAt));
  assert.ok(date(b.metrics.startedAt) >= date(prep.redis.readyAt));
  assert.equal(gate.schemaVersion, 2);
  for (const key of ['run', 'nonce', 'source', 'profile', 'mode', 'phase', 'diagnosticOnly']) assert.equal(gate[key], p[key]);
  assert.equal(gate.imageId, p.identity.helper.imageId); assert.equal(gate.bindingSha256, p.identity.helper.bindingSha256); sha(gate.releaseSha256);
  assert.equal(e.sourceRevision, p.source); assert.equal(e.workloadProfile, p.profile);
  assert.equal(e.candidateImageId, p.identity.candidate.indexDigest); assert.equal(e.diagnosticImageId, p.identity.helper.imageId);
  assert.equal(e.phase, 'combined'); assert.equal(e.diagnosticOnly, false); assert.equal(e.collectApiCpuProfile, false);
  assert.equal(e.coldPostgresRestart, true); assert.equal(e.hostFilesystemCachesFlushed, false);
  assert.equal(e.restrictedNonOwnerRole, true); assert.equal(e.rlsInventory, db.admission.inventory);
  assert.equal(e.admittedTables, 129); assert.equal(e.currentFixtureMigrations, true); assert.equal(e.registrySha256, p.identity.registrySha256);
  assert.equal(e.postgresCpu, 4); assert.equal(e.postgresMemoryBytes, 4294967296);
  assert.equal(e.roleNodeOldSpaceMiB, null); assert.equal(e.seederNodeOldSpaceMiB, 512);
  assert.equal(e.productionMutations, 0); assert.equal(e.exitCode, 0);
}

function heartbeatCheck(h) {
  assert.deepEqual(h.configured, OPEN_LOOP_HEARTBEATS);
  for (const key of ['expected', 'offered', 'started', 'succeeded']) assert.equal(h[key], 6000);
  for (const key of ['failed', 'refusedAtInFlightLimit', 'lateOffers', 'outstandingAfterDrain']) assert.equal(h[key], 0);
  assert.equal(h.accepted, true); bounded(h.maxOfferLatenessMs, OPEN_LOOP_HEARTBEATS.maxOfferLatenessMs);
  bounded(h.peakInFlight, 1000); assert.ok(h.peakInFlight > 0);
  assert.equal(h.timings.count, 6000); bounded(h.timings.maxMs, 20000, false);
  for (const key of ['minMs', 'p50Ms', 'p95Ms']) bounded(h.timings[key], h.timings.maxMs);
  assert.ok(h.offerWindowMs >= 59990 && h.offerWindowMs <= 60090);
  finite(h.totalIncludingDrainMs); assert.ok(h.totalIncludingDrainMs >= h.offerWindowMs);
  assert.ok(h.totalIncludingDrainMs < 79990 + OPEN_LOOP_HEARTBEATS.maxOfferLatenessMs);
  keys(h.bySchool, ['0', '1']);
  for (const row of Object.values(h.bySchool)) assert.deepEqual(row, {offered:3000,started:3000,succeeded:3000,failed:0,refused:0});
  if (h.failureCodes !== undefined) { assert.equal(Object.keys(h.failureCodes).length, 0); }
}

function workerCheck(rows, current = false) {
  for (const row of exact(rows, 'schoolIndex', [0, 1])) {
    noError(row); assert.equal(row.correct, true); bounded(row.durationMs, 48000);
    if (!current) { assert.equal(row.rowCount, 84000); assert.equal(row.seconds, 10002500); assert.equal(row.heartbeatCount, 1000000); }
    else {
      keys(row.fixtureViolations, ['unexpectedStudents', 'unexpectedUrlObservations', 'unexpectedClassificationObservations', 'unexpectedTeacherIntentObservations', 'currentAiDecisionRows', 'invalidRosterStudents']);
      Object.values(row.fixtureViolations).forEach(value => assert.equal(value, 0));
      count(row.expectedSeconds); assert.equal(row.seconds, row.expectedSeconds); assert.equal(row.rowCount, 500);
      assert.equal(row.timestampPrecision.precision, 'integer_microseconds_text');
      assert.equal(row.timestampPrecision.exactRoundedSeconds, row.expectedSeconds);
      assert.equal(row.timestampPrecision.students, 500); count(row.heartbeatCount); assert.ok(row.heartbeatCount >= 2995);
    }
  }
}

function modernHeartbeatCheck(phase, workers) {
  const traffic = phase.traffic;
  assert.equal(traffic.heartbeatStatuses['200'], 6000);
  assert.equal(traffic.heartbeatStatuses['204'] ?? 0, 0);
  assert.equal(phase.insertedObservations, 6000);
  const proof = traffic.heartbeatCapabilityProof;
  assert.deepEqual(proof.requiredCapabilities, modernHeartbeatCapabilities);
  assert.equal(proof.validatedResponses, 6000);
  const rows = exact(workers, 'schoolIndex', [0, 1]);
  const ids = rows.map(row => row.schoolId);
  ids.forEach(id => assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/));
  assert.equal(new Set(ids).size, 2);
  const before = exact(phase.persistedBefore, 'school_id', ids);
  const after = exact(phase.persistedAfter, 'school_id', ids);
  for (const [index, row] of rows.entries()) {
    assert.equal(before[index].count, 6);
    assert.equal(after[index].count, 3006);
    // The raw observer count, database count and rollup result come from
    // independent reads; equal global totals cannot hide another school's loss.
    count(row.rawObservationCount); count(row.persistedObservationCount);
    assert.equal(row.persistedObservationCount, after[index].count);
    assert.equal(row.rawObservationCount, row.persistedObservationCount);
    assert.equal(row.heartbeatCount, row.rawObservationCount);
  }
  const beforeTotal = before.reduce((sum, row) => sum + row.count, 0);
  const afterTotal = after.reduce((sum, row) => sum + row.count, 0);
  assert.equal(beforeTotal, 12); assert.equal(afterTotal, 6012);
  assert.equal(afterTotal - beforeTotal, phase.insertedObservations);
}

function releaseMetricsCheck(m, p, nativeComparison = false) {
  noError(m);
  assert.equal(m.sourceRevision, p.source); assert.equal(m.sourceClean, true); assert.equal(m.sourceUnchangedAtFinish, true);
  assert.deepEqual(m.sourceAtFinish, {revision:p.source,clean:true}); assert.equal(m.diagnosticOnly, false); assert.equal(m.cpuProfile.enabled, false);
  if (nativeComparison) {
    assert.deepEqual(m.profile, RELEASE_ENABLED_PROFILE);
    keys(m.processes, ['api', 'worker', 'generator']);
    Object.values(m.processes).forEach(value => { count(value); assert.ok(value > 0); });
    assert.equal(m.capacityAccepted, true);
  } else {
    for (const key of ['profile', 'mode', 'phase', 'diagnosticOnly']) assert.equal(m.execution[key], p[key]);
    for (const key of ['roleOwnershipClean', 'roleResourceEvidenceComplete']) assert.equal(m[key], true);
  }
  assert.deepEqual(m.pools, POOL_LIMITS); assert.equal(m.prewarmed, 16);
  for (const key of ['readiness', 'redisReady', 'staffAuthenticationVerified', 'enabledCapabilitiesVerified', 'childShutdownClean']) assert.equal(m[key], true);
  assert.equal(m.phases.length, 1); const phase = m.phases[0]; assert.equal(phase.name, 'combined'); noError(phase);
  const all = capacityAcceptance(m); for (const [key, value] of Object.entries(all)) assert.equal(value, true, key);
  // Canonical preflight quiesces only the API after initialization. The final
  // measurement below still requires independent API and worker drains.
  assert.equal(m.preflightDrain.complete, true); assert.equal(m.preflightDrain.physicallyIdle, true);
  assert.equal(m.preflightDrain.abortedResponses, 0); noError(m.preflightDrain);
  // The pre-reset receipt is the sole evidence for this earlier boundary. Use
  // the canonical gauge keys, but inspect its own values rather than replacing
  // them with the final snapshot or trusting the physicallyIdle summary.
  const canonicalGauges = releaseDrainGauges(phase.api);
  assert.notEqual(canonicalGauges, null);
  assert.deepEqual(m.preflightDrain.gauges, Object.fromEntries(Object.keys(canonicalGauges).map(key => [key, 0])));
  const traffic = phase.traffic; noError(traffic); heartbeatCheck(traffic.heartbeats);
  assert.ok(Object.keys(traffic.heartbeatStatuses).every(key => ['200', '204'].includes(key)));
  const ok = traffic.heartbeatStatuses['200'], throttled = traffic.heartbeatStatuses['204'] ?? 0;
  count(ok); count(throttled); assert.ok(throttled <= 10); assert.equal(ok + throttled, 6000);
  assert.equal(phase.insertedObservations, ok); assert.ok(ok >= 5990);
  assert.equal(traffic.reports.length, 64);
  for (const row of traffic.reports) {
    noError(row); assert.equal(row.status, 200); assert.equal(row.correct, true); bounded(row.durationMs, 20000, false);
    assert.ok(Number.isInteger(row.wave) && row.wave >= 0 && row.wave < 4); assert.equal(row.days, days[row.wave]);
  }
  for (let wave = 0; wave < 4; wave++) for (const schoolIndex of [0, 1]) for (const scope of scopes) {
    assert.equal(traffic.reports.filter(row => row.wave === wave && row.days === days[wave] && row.schoolIndex === schoolIndex && row.scope === scope).length, 2);
  }
  noError(traffic.lifecycle); assert.equal(traffic.lifecycle.passed, true);
  assert.equal(traffic.lifecycle.simulatedClientAcknowledgements, true); assert.equal(traffic.lifecycle.browserEnforcementClaimed, false);
  assert.deepEqual(traffic.lifecycle.events, [...LIFECYCLE_EVENTS, ...LIFECYCLE_EVENTS]);
  workerCheck(phase.workers); workerCheck(m.correctness.currentDayWorkers, true);
  if (!nativeComparison) modernHeartbeatCheck(phase, m.correctness.currentDayWorkers);
  assert.equal(m.correctness.passed, true); assert.equal(m.correctness.csvAuditCount, 8); assert.equal(m.correctness.exports.length, 8);
  for (const schoolIndex of [0, 1]) for (const scope of scopes) {
    const rows = m.correctness.exports.filter(row => row.schoolIndex === schoolIndex && row.scope === scope); assert.equal(rows.length, 1);
    sha(rows[0].csvSha256); bounded(rows[0].durationMs, 20000, false); assert.equal(rows[0].report.scope.kind, scope);
  }
  for (const role of ['api', 'worker']) {
    const snapshot = phase[role], drain = phase.serverDrain[role];
    assert.equal(drain.complete, true); assert.equal(drain.physicallyIdle, true); assert.equal(drain.abortedResponses, 0); noError(drain);
    assert.equal(releaseServerIsIdle(snapshot), true); assert.equal(snapshot.http.abortedResponses, 0);
    assert.ok(snapshot.snapshotHrtimeMicroseconds >= snapshot.measurementStartedHrtimeMicroseconds);
    keys(snapshot.operations.operations, RELEASE_DRAIN_OPERATIONS);
    for (const op of Object.values(snapshot.operations.operations)) {
      for (const name of ['checkoutFailure', 'sqlFailure', 'admissionDenied', 'admissionCancelled', 'heartbeatOptionalTelemetryFailures', 'heartbeatHandlerFailures', 'heartbeatOptionalInboxFailures']) assert.equal(op.counters[name], 0);
    }
    assert.equal(snapshot.database.acquisitions.failures, 0); count(snapshot.database.acquisitions.count);
    bounded(snapshot.database.acquisitions.maxMs, role === 'api' ? 5000 : 10000);
    assert.ok(Object.keys(snapshot.database.statements).length > 0);
    for (const statement of Object.values(snapshot.database.statements)) { count(statement.count); assert.equal(statement.failures, 0); bounded(statement.maxMs, role === 'api' ? 15000 : 60000); }
  }
  if (!nativeComparison) for (const row of exact(m.poolReadiness, 'name', ['api', 'session', 'worker'])) {
    assert.equal(row.max, POOL_LIMITS[row.name]); assert.equal(row.acquisitionCalls, 1); assert.equal(row.queryCalls, 1);
    for (const key of ['sameRole', 'neutralSchool']) assert.equal(row[key], true);
    assert.equal(row.databaseSuperuser, false); assert.equal(row.databaseBypassRls, false);
    assert.equal(row.applicationSuperScope, row.name === 'worker');
    assert.equal(row.checkoutDeadlineMs, row.name === 'worker' ? 10000 : 5000); assert.equal(row.statementDeadlineMs, row.name === 'worker' ? 60000 : 15000);
  }
}

const metricsCheck = b => releaseMetricsCheck(b.metrics, b.plan);

function ownershipCheck(b) {
  const p = b.plan, i = p.identity, host = b.roles; noError(host);
  assert.equal(host.run, p.run); assert.equal(host.source, p.source); assert.equal(host.imageId, i.helper.imageId);
  assert.equal(host.mode, 'combined'); assert.equal(host.pgContainerId, b.preparation.pgContainerId); assert.equal(host.passed, true);
  const seen = new Set([b.preparation.pgContainerId, b.preparation.redisContainerId]);
  for (const row of exact(host.roles, 'role', roles)) {
    const id = row.containerId; sha(id); assert.ok(!seen.has(id)); seen.add(id);
    if (row.role !== 'coordinator') assert.match(b.metrics.processes[row.role], new RegExp(`^${id}:[1-9][0-9]*$`));
    const expectedCaps = {nanoCpus:ROLE_LIMITS[row.role].cpu * 1e9,memoryBytes:ROLE_LIMITS[row.role].memory,memorySwapBytes:ROLE_LIMITS[row.role].memory,heapMiB:null};
    assert.deepEqual(row.caps, expectedCaps);
    const inspected = row.inspection;
    for (const [key, value] of Object.entries({run:p.run,source:p.source,containerId:id,imageId:i.helper.imageId,runtimeConfigDigest:i.helper.runtimeConfigDigest,pgContainerId:b.preparation.pgContainerId})) assert.equal(inspected[key], value);
    assert.deepEqual(inspected.caps, expectedCaps);
    assert.deepEqual(inspected.checks, {command:true,mounts:true,environment:true,security:true,identity:true,resources:true,network:true});
    const exit = row.exit;
    for (const [key, value] of Object.entries({role:row.role,run:p.run,source:p.source,containerId:id,imageId:i.helper.imageId,inspected:true,running:false,logsClosed:true,exitCode:0,attachExitCode:0,forced:false,oomKilled:false,clean:true})) assert.equal(exit[key], value);
    const pair = b.metrics.roleResources[row.role], binding = {role:row.role,containerId:id,source:p.source,imageId:i.helper.imageId,runtimeSha256:i.helper.runtimeSha256,harnessSha256:i.harness.executed[row.role]};
    verifyResourceSnapshot(pair.before, binding); verifyResourceSnapshot(pair.after, binding);
    for (const snapshot of [pair.before, pair.after]) {
      for (const name of ['usage_usec', 'user_usec', 'system_usec', 'nr_periods', 'nr_throttled', 'throttled_usec']) count(snapshot.cpu[name]);
      for (const name of ['oom', 'oom_kill', 'high', 'max']) count(snapshot.memory.events[name]);
      count(snapshot.memory.current); count(snapshot.memory.peak); assert.ok(snapshot.memory.peak >= snapshot.memory.current);
    }
    const delta = resourceDelta(pair.before, pair.after);
    assert.ok(delta.durationMicroseconds > 0); assert.equal(delta.memoryEvents.oom, 0); assert.equal(delta.memoryEvents.oom_kill, 0);
    assert.ok(delta.memoryPeakBytes <= ROLE_LIMITS[row.role].memory);
    const flags = b.runtimeFlags[row.role]; assert.ok(Array.isArray(flags));
    const required = row.role === 'coordinator' ? ['startup', 'exit'] : row.role === 'generator' ? ['startup', 'phase_start', 'shutdown', 'exit'] : ['startup', 'phase_reset', 'phase_snapshot', 'shutdown', 'exit'];
    assert.equal(new Set(flags.map(record => record.stage)).size, flags.length);
    for (const stage of required) assert.equal(flags.filter(record => record.stage === stage).length, 1);
    for (const record of flags) {
      assert.equal(record.role, row.role); assert.equal(record.source, p.source); assert.equal(record.profile, PROFILE);
      assert.equal(record.node, b.runtime.proof.node.slice(1)); assert.equal(record.diagnosticOnly, false);
      assert.equal(record.preloaderSha256, i.harness.files['runtime-facts.mjs']);
      assert.deepEqual(record.execArgv, ['--import', '/prototype/runtime-facts.mjs']); assert.equal(record.nodeOptionsPresent, false); assert.equal(record.oldSpaceOverrideMiB, null);
      count(record.heap.heap_size_limit); assert.ok(record.heap.heap_size_limit > 0); finite(record.hrtimeMicroseconds);
      if (record.stage === 'exit') assert.equal(record.exitCode, 0);
    }
  }
  assert.equal(host.cleanup.cleanupPassed, true); assert.equal(host.cleanup.clean, true);
  for (const row of exact(host.cleanup.roles, 'role', roles)) {
    assert.equal(row.containerId, host.roles.find(value => value.role === row.role).containerId);
    assert.equal(row.cleanupPassed, true); assert.equal(row.cleanExit, true); assert.equal(row.forced, false); noError(row);
  }
  const cleanup = b.cleanup; assert.equal(cleanup.run, p.run); assert.equal(cleanup.cleanupPassed, true);
  assert.ok(date(cleanup.finishedAt) >= date(b.metrics.finishedAt));
  assert.equal(cleanup.roles.cleanupPassed, true); assert.equal(cleanup.fixtures.cleanupPassed, true);
  for (const row of exact(cleanup.roles.roles, 'role', roles)) {
    assert.equal(row.id, host.roles.find(value => value.role === row.role).containerId);
    assert.equal(row.confirmedAbsent, true); assert.equal(row.cleanupPassed, true); assert.equal(row.forced, false);
  }
  for (const row of exact(cleanup.fixtures.resources, 'role', ['postgres', 'redis'])) {
    assert.equal(row.id, row.role === 'postgres' ? b.preparation.pgContainerId : b.preparation.redisContainerId);
    assert.equal(row.confirmedAbsent, true); assert.equal(row.cleanupPassed, true);
  }
}

/** Failed numerical or owner evidence remains a failed attempt, not an exception
 * that a caller can mistake for a missing run. Malformed custodied JSON is still
 * rejected by receipt-loader before reaching this function. */
export function validateCandidateRun(bundle, trustedPlanSha256) {
  const failures = [];
  for (const [name, check] of Object.entries({plan:planCheck,image:imageCheck,preparation:preparationCheck,metrics:metricsCheck,ownership:ownershipCheck})) {
    try { check(bundle, trustedPlanSha256); } catch { failures.push(name); }
  }
  return {runPassed:failures.length === 0, failures, capacityAccepted:false};
}

function comparisonCheck(comparison, expected, campaign, receiptSha256) {
  keys(expected, ['source','schemaSha256','profile','phase','diagnosticOnly','collectApiCpuProfile','nodeOldSpaceMiB','scriptHashes']);
  assert.equal(expected.source, campaign.source); assert.equal(expected.schemaSha256, campaign.identity.schemaSha256);
  assert.equal(expected.profile, RELEASE_ENABLED_PROFILE.name); assert.equal(expected.phase, 'combined');
  assert.equal(expected.diagnosticOnly, false); assert.equal(expected.collectApiCpuProfile, false); assert.equal(expected.nodeOldSpaceMiB, 512);
  rawObject(comparison.raw, comparison.receipt, receiptSha256);
  const r = comparison.receipt, m = r.metrics;
  assert.equal(r.source, campaign.source); assert.equal(r.schemaSha256, campaign.identity.schemaSha256);
  assert.equal(r.profile, RELEASE_ENABLED_PROFILE.name); assert.deepEqual(r.scriptHashes, expected.scriptHashes);
  for (const key of ['run-release-enabled-scale.ps1', 'release-enabled-scale.mjs', 'release-enabled-generator.mjs', 'release-enabled-process.mjs', 'release-enabled-profile.mjs']) sha(r.scriptHashes[key]);
  Object.values(r.scriptHashes).forEach(sha); assert.deepEqual(m.sourceHashes, r.scriptHashes);
  assert.equal(r.exitCode, 0); assert.equal(r.cleanupPassed, true);
  const e = r.execution;
  assert.equal(e.sourceRevision, campaign.source); assert.equal(e.workloadProfile, RELEASE_ENABLED_PROFILE.name);
  assert.equal(e.phase, 'combined'); assert.equal(e.diagnosticOnly, false); assert.equal(e.collectApiCpuProfile, false);
  assert.equal(e.nodeOldSpaceMiB, 512); assert.equal(e.exitCode, 0); assert.equal(e.productionMutations, 0);
  assert.equal(e.coldPostgresRestart, true); assert.equal(e.hostFilesystemCachesFlushed, false);
  assert.equal(e.restrictedNonOwnerRole, true); assert.equal(e.admittedTables, 129);
  assert.equal(e.registrySha256, campaign.identity.registrySha256);
  assert.equal(e.postgresCpu, 4); assert.equal(e.postgresMemoryBytes, 4294967296);
  assert.equal(r.schemaFingerprint.canonicalSha256, campaign.identity.schemaSha256);
  const ids = new Set();
  for (const row of exact(r.cleanup.resources, 'role', ['postgres', 'redis'])) {
    sha(row.id); assert.ok(!ids.has(row.id)); ids.add(row.id); assert.equal(row.confirmedAbsent, true); assert.equal(row.cleanupPassed, true);
  }
  releaseMetricsCheck(m, {source:campaign.source}, true);
}

/** The original comparison runs after the streak. Its future receipt hash is
 * bound only at closure, never predicted or patched into the predeclaration.
 * The independently retained closure binds both the immutable declaration and
 * the complete, closed attempt journal. It never supplies a streak attempt. */
export function validateCandidateCampaign(options) {
  const journal = JSON.parse(options.journalRaw), campaign = journal.campaign;
  identityCheck(campaign.identity); source(campaign.source); assert.equal(campaign.profile, PROFILE);
  assert.equal(campaign.phase, 'combined'); assert.equal(campaign.diagnosticOnly, false);
  const checked = new Map();
  let priorCleanupFinishedAt = -Infinity;
  const priorCleanupByRun = new Map();
  const journalClosedAt = date(journal.closedAt);
  for (const entry of journal.attempts) {
    assert.equal(entry.ownershipReleased, true, 'Every attempt must have confirmed owner cleanup');
    sha(entry.cleanupSha256);
    const registeredAt = date(entry.registeredAt), cleanupFinishedAt = date(entry.cleanupFinishedAt), finishedAt = date(entry.finishedAt);
    assert.ok(registeredAt > priorCleanupFinishedAt, 'Register the next attempt after the prior owned cleanup');
    assert.ok(cleanupFinishedAt >= registeredAt && finishedAt >= cleanupFinishedAt, 'Every attempt must retain ordered cleanup and completion times');
    assert.ok(journalClosedAt >= finishedAt);
    if (entry.status !== 'completed') assert.match(entry.failureCode, /^[A-Z][A-Z0-9_]{0,95}$/);
    priorCleanupByRun.set(entry.run, priorCleanupFinishedAt); priorCleanupFinishedAt = cleanupFinishedAt;
  }
  const result = validateCampaign({...options, loadRun:entry => {
    sha(entry.receiptManifestSha256); sha(entry.planSha256);
    const loaded = options.loadRun(entry);
    assert.equal(loaded.receiptManifestSha256, entry.receiptManifestSha256);
    assert.equal(loaded.trustedPlanSha256, entry.planSha256);
    const priorCleanup = priorCleanupByRun.get(entry.run);
    assert.ok(date(loaded.bundle.preparation.startedAt) > priorCleanup, 'Cold preparations must not overlap');
    assert.ok(date(loaded.bundle.metrics.startedAt) > priorCleanup, 'Measurements must not overlap prior ownership');
    assert.equal(loaded.bundle.cleanup.finishedAt, entry.cleanupFinishedAt);
    assert.equal(hash(loaded.cleanupRaw), entry.cleanupSha256);
    assert.deepEqual(JSON.parse(loaded.cleanupRaw), loaded.bundle.cleanup);
    assert.ok(date(entry.cleanupFinishedAt) >= date(loaded.bundle.metrics.finishedAt));
    return loaded;
  }, validateRun:(bundle, trustedPlanSha256) => {
    assert.ok(journalClosedAt >= date(bundle.metrics.finishedAt));
    const value = validateCandidateRun(bundle, trustedPlanSha256); checked.set(bundle.plan.run, value); return value;
  }});
  let comparisonPassed = false;
  try {
    assert.equal(result.capacityAccepted, true, 'The native comparison follows three consecutive successful candidates');
    const closure = JSON.parse(options.closureRaw);
    rawObject(options.closureRaw, closure, options.trustedClosureSha256);
    keys(closure, ['schemaVersion','campaignSha256','journalSha256','comparisonDeclarationSha256','comparisonReceiptSha256','closedAt']);
    assert.equal(closure.schemaVersion, 1); assert.equal(closure.campaignSha256, options.trustedCampaignSha256);
    assert.equal(closure.journalSha256, options.trustedJournalSha256);
    assert.equal(closure.comparisonDeclarationSha256, canonicalHash(campaign.originalComparison));
    comparisonCheck(options.comparison, campaign.originalComparison, campaign, closure.comparisonReceiptSha256);
    assert.ok(date(options.comparison.receipt.metrics.startedAt) > journalClosedAt);
    assert.ok(date(options.comparison.receipt.metrics.finishedAt) >= date(options.comparison.receipt.metrics.startedAt));
    assert.ok(date(closure.closedAt) >= date(options.comparison.receipt.metrics.finishedAt));
    comparisonPassed = true;
  } catch { /* Retain the failed or absent comparison/closure in the result. */ }
  const attemptResults = journal.attempts.map(entry => ({ordinal:entry.ordinal,run:entry.run,status:entry.status,
    ...(checked.get(entry.run) ?? {runPassed:false,failures:[entry.status]})}));
  return {...result, capacityAccepted:result.capacityAccepted && comparisonPassed, comparisonPassed, attemptResults,
    ...(comparisonPassed ? {closureSha256:options.trustedClosureSha256} : {})};
}
