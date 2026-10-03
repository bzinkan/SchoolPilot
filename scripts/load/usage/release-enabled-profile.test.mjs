import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RELEASE_ENABLED_PROFILE, enabledReleaseEnvironment, capacityAcceptance, assertEnabledReleaseRuntime, releaseRangeFixture, releaseTrafficOptions } from './release-enabled-profile.mjs';
import { measureMethod } from './release-enabled-instrumentation.mjs';
import { RELEASE_PG_APPLICATION_NAMES, POSTGRES_PRESSURE_SAMPLE_INTERVAL_MS, POSTGRES_PRESSURE_MAX_SAMPLES, POSTGRES_PRESSURE_SQL, POSTGRES_ROLE_WAITS_SQL, postgresPressureSnapshot, readPostgresPressure, postgresPressureDelta } from './release-enabled-postgres-pressure.mjs';
import { canonicalSchemaFingerprint } from './release-schema-fingerprint.mjs';
import { commandTransportAcknowledgement, assertPrivateLifecycleAdvanced } from './release-enabled-protocol.mjs';

test('schema fingerprint ignores only pg_dump security nonce and newline encoding', () => {
  const a = '\\restrict first123\nCREATE TABLE usage (id text);\n\\unrestrict first123\n';
  assert.equal(canonicalSchemaFingerprint(a), canonicalSchemaFingerprint(a.replaceAll('first123', 'second456').replaceAll('\n', '\r\n')));
  assert.notEqual(canonicalSchemaFingerprint(a), canonicalSchemaFingerprint(a.replace('id text', 'id integer')));
});
test('range oracle intersects known synthetic coverage independently for every supported window', () => {
  const fixture = { today: '2026-10-02', heavyDate: '2026-09-30', emptyDate: '2026-09-29', gapDate: '2026-09-27' };
  for (const [days, historical] of [[1, 0], [7, 3], [30, 26], [365, 361]]) {
    const range = releaseRangeFixture(fixture, days);
    assert.equal(range.dates.length, days); assert.equal(range.historyDates.length, historical);
    assert.equal(range.includesHeavy, days !== 1); assert.equal(range.includesGap, days !== 1);
  }
});
test('synthetic ACKs require received command authority and exact generation changes', () => {
  const school = { id: 'school', students: ['student'], studentSessions: ['session'], devices: ['device'] };
  const frame = { commandId: 'command', command: { commandId: 'command' }, studentId: 'student', studentSessionId: 'session',
    exactBinding: { schoolId: 'school', studentId: 'student', studentSessionId: 'session', deviceId: 'device', controlRevision: 7 },
    classroomState: { authPassThroughPolicyRevision: 2 } };
  assert.deepEqual(commandTransportAcknowledgement(frame, school, 0, 'focus-tab', 'command'), { controlRevision: 7, appliedAuthPolicyRevision: 2 });
  for (const mutate of [f => delete f.exactBinding, f => f.exactBinding.controlRevision = undefined,
    f => f.exactBinding.studentId = 'other', f => f.command.commandId = 'other', f => f.studentSessionId = 'old']) {
    const bad = structuredClone(frame); mutate(bad); assert.throws(() => commandTransportAcknowledgement(bad, school, 0, 'focus-tab', 'command'));
  }
  const token = { threadId: 'thread', schoolEpoch: 1, activityEpoch: 3, threadGeneration: 5 };
  assert.doesNotThrow(() => assertPrivateLifecycleAdvanced(token, { ...token, threadGeneration: 6 }));
  assert.throws(() => assertPrivateLifecycleAdvanced(token, token));
  assert.throws(() => assertPrivateLifecycleAdvanced(token, { ...token, schoolEpoch: 2, threadGeneration: 6 }));
});
test('Docker locality guard rejects remote daemons and every daemon operation pins the validated endpoint', () => {
  const runner = readFileSync(new URL('./run-release-enabled-scale.ps1', import.meta.url), 'utf8');
  const guard = runner.match(/function Assert-LocalDockerEndpoint \{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(guard);
  assert.match(runner, /\$dockerExecutable = \(Get-Command docker -CommandType Application -ErrorAction Stop \| Select-Object -First 1\)\.Source/,
    'Windows can resolve both docker.exe and docker; pin exactly one executable path');
  const patterns = [...guard.matchAll(/-cnotmatch '([^']+)'/g)].map(match => new RegExp(match[1]));
  assert.equal(patterns.length, 2);
  for (const endpoint of ['npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe://./pipe/docker_engine', 'unix:///var/run/docker.sock']) assert.ok(patterns.some(pattern => pattern.test(endpoint)));
  for (const endpoint of ['tcp://production:2376', 'tcp://127.0.0.1:2375', 'ssh://operator@production', 'npipe:////server/pipe/docker_engine', 'unix://server/socket', '', 'npipe:////./pipe/docker_engine?context=remote']) assert.equal(patterns.some(pattern => pattern.test(endpoint)), false);
  assert.match(runner, /Assert-LocalDockerEndpoint \$pinnedDockerHost[\s\S]*?\$schema =/);
  assert.doesNotMatch(runner, /\bdocker (exec|inspect|run|restart|rm|stats)\b/);
  const actions = [...runner.matchAll(/& \$dockerExecutable (?!--host \$pinnedDockerHost )([^\r\n]+)/g)].map(match => match[1]);
  assert.equal(actions.length, 2); assert.ok(actions.every(action => action.startsWith('context ')), 'Only local context metadata may precede endpoint pinning');
  assert.match(runner, /'DOCKER_CONTEXT','DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_TLS'/);
});
test('CPU profiling preserves all6000offers and cannot become acceptance evidence', () => {
  assert.deepEqual(releaseTrafficOptions({ USAGE_RELEASE_CPU_PROFILE: 'true', USAGE_RELEASE_DIAGNOSTIC: 'true', USAGE_RELEASE_PHASE: 'ingest' }), {});
  assert.deepEqual(releaseTrafficOptions({ USAGE_RELEASE_DIAGNOSTIC: 'true', USAGE_RELEASE_PHASE: 'preflight' }), { durationMs: 10000 });
  assert.throws(() => releaseTrafficOptions({ USAGE_RELEASE_CPU_PROFILE: 'true', USAGE_RELEASE_PHASE: 'ingest' }));
  assert.throws(() => releaseTrafficOptions({ USAGE_RELEASE_CPU_PROFILE: 'true', USAGE_RELEASE_DIAGNOSTIC: 'true', USAGE_RELEASE_PHASE: 'combined' }));
  const result = accepted(); result.cpuProfile = { enabled: true }; assert.equal(capacityAcceptance(result).acceptanceRun, false);
});
test('preflight quiescence preserves normal batching until traffic completes', () => {
  const processSource = readFileSync(new URL('./release-enabled-process.mjs', import.meta.url), 'utf8');
  const coordinator = readFileSync(new URL('./release-enabled-scale.mjs', import.meta.url), 'utf8');
  assert.match(processSource, /quiesce = batch\.drainHeartbeatClassificationBatches/);
  assert.match(processSource, /flush = batch\.flushHeartbeatClassificationBatches/);
  assert.match(processSource, /request\.operation === 'quiesce'\) await quiesce\(\)/);
  const preflight = coordinator.indexOf("await api.rpc('quiesce')");
  const measuredTraffic = coordinator.indexOf("generator.rpc('phase'");
  const terminalDrain = coordinator.indexOf("await api.rpc('drain')");
  assert.ok(preflight > 0 && preflight < measuredTraffic);
  assert.ok(terminalDrain > measuredTraffic, 'terminal flush cannot precede measured traffic');
});

test('lazy worker proxy checkouts preserve the real receiver, both pg overloads and failures', async () => {
  class Pool {
    constructor(label) { this.options = { label }; }
    connect(callback) { const result = { scope: this.options.label }; if (callback) { queueMicrotask(() => callback(null, result)); return 'callback-token'; } return Promise.resolve(result); }
  }
  const real = new Pool('worker'), other = new Pool('other'), options = real.options, observations = [];
  const lazy = new Proxy(Object.create(Pool.prototype), { get(_target, name) { const value = real[name]; return typeof value === 'function' ? value.bind(real) : value; } });
  measureMethod(Pool.prototype, 'connect', (duration, error) => observations.push({ duration, error }), { appliesTo: receiver => receiver.options === options });
  assert.deepEqual(await lazy.connect(), { scope: 'worker' });
  await new Promise((resolve, reject) => { assert.equal(lazy.connect((error, client) => { if (error) reject(error); else { assert.equal(client.scope, 'worker'); resolve(); } }), 'callback-token'); });
  assert.deepEqual(await other.connect(), { scope: 'other' }); assert.equal(observations.length, 2); assert.ok(observations.every(row => row.duration >= 0 && !row.error));
  const failure = new Error('checkout failed'), rejected = { connect(callback) { if (callback) return callback(failure); return Promise.reject(failure); } }, failures = [];
  measureMethod(rejected, 'connect', (_duration, error) => failures.push(error));
  await assert.rejects(rejected.connect(), error => error === failure); rejected.connect(error => assert.equal(error, failure));
  assert.deepEqual(failures, [failure, failure]);
});

function accepted() {
  const database = () => ({ acquisitions: { count: 2, failures: 0, maxMs: 10 }, statements: { select: { failures: 0, maxMs: 10 } } });
  return { sourceClean: true, sourceUnchangedAtFinish: true, processes: { api: 1, worker: 2, generator: 3 }, enabledCapabilitiesVerified: true,
    staffAuthenticationVerified: true, pools: { api: 16, session: 2, worker: 5 }, correctness: { passed: true, currentDayWorkers: [{ durationMs: 48_000, correct: true }, { durationMs: 5, correct: true }] },
    phases: [{ name: 'combined', insertedObservations: 6000, api: { database: database(),
      operations: { operations: { heartbeat_background: { counters: { heartbeatOptionalTelemetryFailures: 0 } } } } }, worker: { database: database() },
      workers: [{ durationMs: 48_000, correct: true }, { durationMs: 23_000, correct: true }],
      traffic: { heartbeats: { accepted: true, expected: 6000, timings: { count: 6000, maxMs: 19999 } }, heartbeatStatuses: { 200: 6000 },
        reports: [1, 7, 30, 365].flatMap(days => [0, 1].flatMap(schoolIndex => ['school', 'grade', 'class', 'student'].flatMap(scope => [0, 1].map(() => ({ days, schoolIndex, scope, status: 200, correct: true, durationMs: 100 }))))), lifecycle: { passed: true } } }] };
}
test('release-enabled acceptance refuses successful workers masking failed/off/disabled traffic', () => {
  assert.ok(Object.values(capacityAcceptance(accepted())).every(Boolean));
  for (const corrupt of [r => r.sourceClean = false, r => r.sourceUnchangedAtFinish = false, r => r.diagnosticOnly = true, r => r.processes.generator = 1,
    r => r.enabledCapabilitiesVerified = false, r => r.staffAuthenticationVerified = false,
    r => r.pools.api = 18, r => r.pools.worker = 8, r => r.phases[0].workers[0].durationMs = 48_001,
    r => r.phases[0].traffic.heartbeats.accepted = false, r => r.phases[0].traffic.heartbeats.expected = 1000,
    r => r.phases[0].traffic.heartbeats.timings.maxMs = 20000, r => r.phases[0].traffic.heartbeats.timings.count = 5999,
    r => delete r.phases[0].traffic.heartbeats.timings, r => r.correctness.currentDayWorkers[0].durationMs = 48001,
    r => r.correctness.currentDayWorkers.pop(), r => r.correctness.currentDayWorkers[0].correct = false,
    r => r.phases[0].traffic.reports[0].status = 503, r => r.phases[0].traffic.reports[0].correct = false,
    r => r.phases[0].traffic.reports[0].durationMs = 20_000, r => r.phases[0].traffic.reports.pop(),
    r => r.phases[0].traffic.reports[0].days = 365, r => r.phases[0].traffic.reports[0].scope = 'school-only',
    r => r.phases[0].traffic.lifecycle.passed = false, r => r.phases[0].api.database.acquisitions.failures++,
    r => r.phases[0].api.operations.operations.heartbeat_background.counters.heartbeatOptionalTelemetryFailures++,
    r => delete r.phases[0].api.operations,
    r => r.phases[0].worker.database.acquisitions.failures++, r => r.phases[0].api.database.acquisitions.maxMs = 5001,
    r => r.phases[0].worker.database.acquisitions.count = 0,
    r => r.phases[0].worker.database.acquisitions.maxMs = 10001, r => r.phases[0].api.database.statements.select.failures++,
    r => r.phases[0].worker.database.statements.select.failures++, r => r.phases[0].api.database.statements.select.maxMs = 15001,
    r => r.phases[0].worker.database.statements.select.maxMs = 60001, r => r.phases[0].worker.database.statements = {},
    r => r.phases[0].traffic.heartbeatStatuses = { 204: 6000 }, r => r.phases[0].insertedObservations = 0,
    r => r.phases[0].insertedObservations = 5999,
    r => r.correctness.passed = false]) {
    const result = accepted(); corrupt(result); assert.ok(Object.values(capacityAcceptance(result)).some(value => !value));
  }
});
test('a cleared minute summary cannot hide an earlier optional telemetry failure', () => {
  const result = accepted();
  result.phases[0].api.hotPath = { counters: { heartbeatOptionalTelemetryFailures: 0 } };
  assert.equal(capacityAcceptance(result).noOptionalTelemetryFailures, true);
  result.phases[0].api.operations.operations.heartbeat_background.counters.heartbeatOptionalTelemetryFailures = 1;
  assert.equal(capacityAcceptance(result).noOptionalTelemetryFailures, false);
  delete result.phases[0].api.operations.operations.heartbeat_background.counters.heartbeatOptionalTelemetryFailures;
  assert.equal(capacityAcceptance(result).noOptionalTelemetryFailures, false);
});
test('new profile preserves old workload and explicit fixed pool budgets', () => {
  assert.equal(RELEASE_ENABLED_PROFILE.httpOffering.requestsPerSecond, 100);
  assert.equal(RELEASE_ENABLED_PROFILE.rawPerSchool, 1_000_000);
  assert.equal(RELEASE_ENABLED_PROFILE.fullWorkerAcceptanceMs, 48_000);
  const env = enabledReleaseEnvironment({ DB_POOL_MAX: '200', SCHEDULER_DB_POOL_MAX: '200' });
  assert.equal(env.DB_POOL_MAX, '16'); assert.equal(env.SCHEDULER_DB_POOL_MAX, '5');
  const rollout = JSON.parse(env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON);
  for (const capability of ['scopedAuthorityChecksV1', 'studentChatIdempotencyV1', 'preciseRestrictionResourcesV1', 'focusTabV1', 'privateChatLifecycleV1']) assert.deepEqual(rollout[capability], { mode: 'on' });
});
test('runtime proof rejects inactive capability or nonlocal shared Redis', () => {
  const env = enabledReleaseEnvironment({ REDIS_URL: 'redis://127.0.0.1:6387', RLS_GUC_ENABLED: 'true' });
  const protocol = { assertClasspilotCapabilityRolloutsEnv() {}, classpilotCapabilityRolloutMode: () => 'on', isClasspilotCapabilityActive: () => true };
  assert.doesNotThrow(() => assertEnabledReleaseRuntime(protocol, env));
  assert.throws(() => assertEnabledReleaseRuntime({ ...protocol, isClasspilotCapabilityActive: () => false }, env));
  for (const REDIS_URL of ['redis://127.0.0.1:6380', 'redis://shared.example:6387']) assert.throws(() => assertEnabledReleaseRuntime(protocol, { ...env, REDIS_URL }));
});

test('PostgreSQL pressure counters preserve precision and do not invent disabled I/O timings', () => {
  const row = pressureRow();
  const before = postgresPressureSnapshot(row), afterRow = structuredClone(row);
  afterRow.wal.wal_bytes = '9007199254741999';
  const after = postgresPressureSnapshot(afterRow), delta = postgresPressureDelta(before, after);
  assert.equal(delta.valid, true); assert.equal(delta.groups.wal.counters.wal_bytes, '1000');
  assert.equal(before.wal.timingAvailable, false); assert.equal(before.wal.timingsMs, null);
  assert.equal(delta.groups.wal.timingsMs, null); assert.equal(delta.groups.database.timingsMs, null);
  assert.equal(delta.groups.bgwriter.timingAvailable, true);
  const enabled = pressureRow(); enabled.settings.track_wal_io_timing = 'on'; enabled.wal.wal_write_time = '7.5';
  const enabledNext = structuredClone(enabled); enabledNext.wal.wal_write_time = '9.75';
  assert.equal(postgresPressureDelta(postgresPressureSnapshot(enabled), postgresPressureSnapshot(enabledNext)).groups.wal.timingsMs.wal_write_time, 2.25);
});

test('PostgreSQL pressure deltas reject resets, counter regression and settings changes anywhere in the window', () => {
  const baseline = postgresPressureSnapshot(pressureRow());
  for (const mutate of [row => row.wal.stats_reset = '2026-10-03 01:01:00+00', row => row.wal.wal_bytes = '1',
    row => row.bgwriter.checkpoints_req = '0', row => row.settings.fsync = 'off']) {
    const changed = pressureRow(); mutate(changed);
    const delta = postgresPressureDelta(baseline, baseline, [postgresPressureSnapshot(changed)]);
    assert.equal(delta.valid, false); assert.equal(delta.groups.wal.valid && delta.groups.bgwriter.valid && delta.groups.database.valid, false);
  }
});

test('pressure instrumentation reads fixed aggregate views using the existing observer and fixed role labels', async () => {
  const queries = [];
  await readPostgresPressure({ query: async text => { queries.push(text); return { rows: [pressureRow()] }; } });
  assert.deepEqual(queries, [POSTGRES_PRESSURE_SQL]);
  assert.doesNotMatch(POSTGRES_PRESSURE_SQL, /\b(?:ALTER|SET|RESET|CHECKPOINT|pg_stat_reset|pg_stat_clear_snapshot)\b/i);
  assert.doesNotMatch(POSTGRES_ROLE_WAITS_SQL, /\b(?:query|usename|client_addr|pid)\s*(?:,|AS)/i);
  assert.equal(POSTGRES_PRESSURE_SAMPLE_INTERVAL_MS, 1000); assert.equal(POSTGRES_PRESSURE_MAX_SAMPLES, 180);
  assert.deepEqual(Object.keys(RELEASE_PG_APPLICATION_NAMES), ['api', 'worker', 'observer']);
  const coordinator = readFileSync(new URL('./release-enabled-scale.mjs', import.meta.url), 'utf8');
  assert.match(coordinator, /max: 2, statement_timeout: 15_000, application_name: RELEASE_PG_APPLICATION_NAMES\.observer/);
  assert.match(coordinator, /PGAPPNAME: RELEASE_PG_APPLICATION_NAMES\[name\]/);
  assert.match(coordinator, /postgresPressureDelta\(phase\.postgresPressure\.baseline, phase\.postgresPressure\.final,/);
});

function pressureRow() {
  const integer = keys => Object.fromEntries(keys.map(key => [key, '1']));
  return { observed_at: '2026-10-03 01:00:00+00', settings: { fsync: 'on', track_wal_io_timing: 'off', track_io_timing: 'off' },
    wal: { stats_reset: '2026-10-03 00:00:00+00', ...integer(['wal_records', 'wal_fpi', 'wal_buffers_full', 'wal_write', 'wal_sync']), wal_bytes: '9007199254740999', wal_write_time: '0', wal_sync_time: '0' },
    bgwriter: { stats_reset: null, ...integer(['checkpoints_timed', 'checkpoints_req', 'buffers_checkpoint', 'buffers_clean', 'maxwritten_clean', 'buffers_backend', 'buffers_backend_fsync', 'buffers_alloc']), checkpoint_write_time: '1.5', checkpoint_sync_time: '0.5' },
    database: { stats_reset: null, ...integer(['xact_commit', 'xact_rollback', 'blks_read', 'blks_hit', 'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated', 'tup_deleted', 'temp_files', 'temp_bytes', 'deadlocks']), blk_read_time: '0', blk_write_time: '0' } };
}
