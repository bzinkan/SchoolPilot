import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RELEASE_ENABLED_PROFILE, enabledReleaseEnvironment, capacityAcceptance, assertEnabledReleaseRuntime, releaseRangeFixture, releaseTrafficOptions } from './release-enabled-profile.mjs';
import { measureMethod } from './release-enabled-instrumentation.mjs';
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
    phases: [{ name: 'combined', insertedObservations: 6000, api: { database: database() }, worker: { database: database() },
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
