import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createDistinctGeneratorRpc, createDistinctObserverRpc, DISTINCT_RAW_SQL, DISTINCT_ROSTER_SQL, DISTINCT_COVERAGE_SQL } from './distinct-report-rpc.mjs';
import { patchDistinctGeneratorRpc, patchDistinctObserverRpc, patchDistinctRoleEntryRpc } from './distinct-report-rpc-overlay.mjs';
import { patchGeneratorV2 } from './patch.mjs';
import { prepareDistinctReports, distinctReportContractHash, distinctPreparedStateHash, distinctReportCases, distinctCsvCases } from './distinct-reports.mjs';

const run = 'abcdef123456', source = 'ddc5996b3b8645859fa51a9613486db52c481b7f', cutoff = '2026-10-04T07:00:00.000Z';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateBefore = days => new Date(Date.parse('2026-10-04T12:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
function fixture() {
  return { sourceRevision: source, today: '2026-10-04', heavyDate: dateBefore(2), emptyDate: dateBefore(3), gapDate: dateBefore(5),
    apiBases: ['http://127.0.0.1:4000', 'http://127.0.0.1:4001', 'http://127.0.0.1:4002'],
    schools: [0, 1].map(index => ({ index, id: `school${index}`, staff: `staff${index}`, cookie: `schoolpilot.sid=private${index}`, csrf: 'private',
      students: Array.from({ length: 500 }, (_, n) => `student${index}-${n}`), devices: Array.from({ length: 500 }, (_, n) => `device${index}-${n}`),
      studentSessions: Array.from({ length: 500 }, (_, n) => `session${index}-${n}`), groups: Array.from({ length: 100 }, (_, n) => `class${index}-${n}`) })) };
}
function coverage(value, index) {
  return Array.from({ length: 365 }, (_, n) => dateBefore(364 - n)).filter(date => date !== value.gapDate)
    .map(date => ({ date, is_final: date !== value.today, processed_through: date === value.today ? cutoff : date + 'T23:59:59.000Z', valid_window: true }));
}
function raw(value, index) {
  const school = value.schools[index], end = BigInt(Date.parse(cutoff)) * 1000n;
  return [[0, end - 2_000_000n], [0, end - 1_999_999n], [1, end - 1_000_000n]].map(([student, at], n) => ({ id: `raw${index}-${n}`,
    school_id: school.id, student_id: school.students[student], device_id: school.devices[student], timestamp_microseconds: String(at),
    expected_url: true, expected_classification: true, expected_teacher_intent: true, valid_binding: true }));
}
function oracle(value) {
  return { kind: 'distinct-report-independent-raw-coverage-v1', source, cutoff,
    aggregateRowsUsedForExpected: false, productReportCodeUsedForExpected: false, preparedActualWorkersVerified: true, coverageFrozenForOffering: true,
    schools: value.schools.map(school => ({ schoolIndex: school.index, invalidRawBindings: 0, invalidClassificationOrRoster: 0,
      rawRows: 3, deduplicatedRows: 2, secondsByStudent: [[school.students[0], 13], [school.students[1], 22]],
      heartbeatsByStudent: [[school.students[0], 1], [school.students[1], 1]],
      coverage: coverage(value).map(row => ({ date: row.date, isFinal: row.is_final, processedThrough: row.processed_through })) })) };
}
const env = () => ({ NODE_ENV: 'test', USAGE_LOCAL_SCALE: '1', USAGE_SOURCE_REVISION: source,
  RELEASE297_PROFILE: 'release297-usage-shared-db-three-api-distinct64-v1',
  DATABASE_URL: `postgres://runtime_role:private@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${run}` });
const auditRecords = value => distinctCsvCases(value).map((item, id) => ({ id, action: 'classpilot.usage.export', school_id: item.schoolId,
  user_id: value.schools[item.schoolIndex].staff, entity_type: 'classpilot_usage_' + item.scope, entity_id: item.id ?? item.schoolId,
  metadata: { scope: item.scope, from: item.from, to: item.to } }));

function nativeFixture(value, customize = () => {}) {
  const clients = [], proofs = [], native = { audit: false }, database = `schoolpilot_redesign_usage_scale_${run}`;
  const pool = { options: { max: 2 }, async connect() {
    let school, active = false, local = false;
    const prior = { role: 'fixture_owner', database, school: '', is_super: '' };
    const client = { calls: [], releases: [], async query(sql, parameters) {
      client.calls.push({ sql, parameters });
      const injected = await customize({ sql, parameters, client, school, active, local, native });
      if (injected) return injected;
      if (sql.startsWith('SELECT current_user AS role,current_database()')) return { rows: [{ ...prior, ...(local ? { role: 'runtime_role', school, is_super: 'off' } : {}) }] };
      if (sql.startsWith('BEGIN')) { assert.equal(active, false); active = true; return { rows: [] }; }
      if (sql.startsWith('SET LOCAL ROLE')) { assert.equal(active, true); assert.equal(sql, 'SET LOCAL ROLE "runtime_role"'); local = true; return { rows: [] }; }
      if (sql.startsWith("SELECT set_config('app.school_id'")) { school = parameters[0]; assert.equal(local, true); return { rows: [] }; }
      if (sql.includes('FROM pg_roles WHERE rolname=current_user')) return { rows: [{ role: 'runtime_role', rolsuper: false, rolbypassrls: false, school, is_super: 'off' }] };
      if (sql.startsWith('WITH boundary AS')) {
        assert.deepEqual(parameters, [school, value.today]);
        return { rows: [{ zone: 'America/New_York', start: '2026-10-04 04:00:00', end: '2026-10-05 04:00:00',
          start_microseconds: String(BigInt(Date.parse('2026-10-04T04:00:00Z')) * 1000n), end_microseconds: String(BigInt(Date.parse('2026-10-05T04:00:00Z')) * 1000n) }] };
      }
      const index = value.schools.find(row => row.id === school)?.index;
      if (sql === DISTINCT_RAW_SQL) {
        assert.deepEqual(parameters.slice(0, 3), [school, '2026-10-04 04:00:00', '2026-10-04 07:00:00.000']);
        const expected = JSON.parse(parameters[3]); assert.equal(expected.length, 500);
        assert.deepEqual(expected[0], { student_id: value.schools[index].students[0], device_id: value.schools[index].devices[0], session_id: value.schools[index].studentSessions[0] });
        return { rows: raw(value, index) };
      }
      if (sql === DISTINCT_ROSTER_SQL) return { rows: [{ currentAiDecisionRows: 0, invalidRosterStudents: 0 }] };
      if (sql === DISTINCT_COVERAGE_SQL) { assert.deepEqual(parameters, [school, dateBefore(364), value.today, 'America/New_York']); return { rows: coverage(value, index) }; }
      if (sql.includes('COUNT(*)::int FROM students WHERE school_id<>')) return { rows: [{ students: 0, heartbeats: 0, coverage: 0 }] };
      if (sql.startsWith('SELECT id,action,school_id,user_id,entity_type,entity_id,metadata FROM audit_logs')) return { rows: native.audit ? auditRecords(value).filter(row => row.school_id === school) : [] };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { assert.equal(active, true); active = local = false; return { rows: [] }; }
      assert.fail('Unexpected SQL: ' + sql);
    }, release(broken) { assert.equal(active, false); client.releases.push(broken); } };
    clients.push(client); return client;
  } };
  const rpc = createDistinctObserverRpc({ pool, run, source, getFixture: () => value, env: env(),
    rawDependencies: async () => ({ seconds: rows => new Map(rows.filter((row, n) => n !== 1).map((row, n) => [row.student_id, n === 0 ? 13 : 22])),
      violations: () => ({ unexpectedStudents: 0, invalidUrl: 0, invalidClassification: 0, invalidTeacherIntent: 0, currentAiDecisionRows: 0, invalidRosterStudents: 0 }) }),
    persistPrivateProof: async record => { proofs.push(record); return digest(record); } });
  return { rpc, pool, clients, proofs, native };
}
const auditRequest = value => ({ source, cutoff, oracleSha256: digest(value),
  coverageBeforeSha256: digest(value.schools.map(({ schoolIndex, coverage }) => ({ schoolIndex, coverage }))) });

test('generator owns canonical preparedHash and rejects stale tokens or changed bindings before endpoints', async () => {
  const value = fixture(), data = oracle(value); let calls = 0;
  const rpc = createDistinctGeneratorRpc({ run, source, getFixture: () => value, getSchools: () => value.schools, staffRequest: async () => { calls++; } });
  const prepared = await rpc.prepare({ source, oracle: data, contractSha256: distinctReportContractHash() });
  assert.equal(prepared.preparedHash, distinctPreparedStateHash({ run, fixture: value, oracle: data, prepared: prepareDistinctReports(value, data) }));
  assert.equal(prepared.caseCount, 64); assert.equal(prepared.csvCount, 8);
  await assert.rejects(rpc.prepare({ source, oracle: data, contractSha256: distinctReportContractHash() }), error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.ok(error.actual === false);
    assert.equal(error.message, 'A registered operation cannot replace its prepared state');
    assert.ok(error.message.length < 128);
    for (const school of value.schools) {
      assert.equal(error.message.includes(school.cookie), false);
      assert.equal(error.message.includes(school.csrf), false);
    }
    assert.equal(error.message.includes('preparedHash'), false);
    assert.equal(error.message.includes('monitoredBrowserSeconds'), false);
    return true;
  });
  await assert.rejects(rpc.reports({ startsAtMs: 1000, preparedHash: 'a'.repeat(64) })); assert.equal(calls, 0);
  value.schools[0].studentSessions[0] = 'replacement';
  await assert.rejects(rpc.reports({ startsAtMs: 1000, preparedHash: prepared.preparedHash })); assert.equal(calls, 0);
});

function responseBody(expected) { return { schemaVersion: 1, measure: 'Monitored Browser Time', ...structuredClone(expected),
  scope: { ...expected.scope, label: 'Synthetic scope' }, generatedAt: cutoff, computedAt: cutoff }; }
function csvBody(expected) {
  const numbers = row => [...['monitoredBrowserSeconds', 'instructionalSeconds', 'offTaskSeconds', 'unknownSeconds'].map(key => (row[key] / 60).toFixed(1)), String(row.activeMonitoredStudents), String(row.heartbeatCount)];
  const rows = [['Report', 'Monitored Browser Time'], ['Scope', expected.scope.kind], ['Label', 'Synthetic scope'], ['From', expected.range.from], ['To', expected.range.to],
    ['Time zone', expected.range.timeZone], ['Retained from', expected.range.retainedFrom], ['Partially expired', 'no'], ['Computed from', expected.range.computedFrom],
    ['Computed days', expected.range.computedDays], ['Requested retained days', expected.range.requestedDays], ['Unavailable dates', expected.range.unavailableDates.join('; ')],
    ['Data state', expected.dataState], ['Generated at', cutoff], ['Note', 'Synthetic observation'], [],
    ['Date', 'Day state', 'Monitored Browser Time (minutes)', 'Instructional (minutes)', 'Off-task (minutes)', 'Unclassified (minutes)', 'Active monitored students', 'Heartbeats'],
    ...expected.byDay.map(row => [row.date, row.state, ...numbers(row)]), ['Total', '', ...numbers(expected.totals)], [],
    ['Top educational sites', 'Minutes'], ...expected.topEducationalDomains.map(row => [row.domain, (row.seconds / 60).toFixed(1)]), [],
    ['Top non-educational sites', 'Minutes'], ...expected.topNonEducationalDomains.map(row => [row.domain, (row.seconds / 60).toFixed(1)])];
  return '\uFEFF' + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
}
function nextVirtualClock(sleepers, now, iteration) {
  assert.ok(iteration < 128, 'Virtual endpoint scheduler exceeded its finite transition budget');
  assert.ok(sleepers.length, 'Virtual endpoint scheduler has no pending transition');
  const next = Math.min(...sleepers.map(row => row.at));
  assert.ok(Number.isFinite(next) && next > now, 'Virtual endpoint scheduler did not advance');
  return next;
}
async function waitForParkedQuery(entered, pending) {
  await Promise.race([entered, pending.then(() => assert.fail('Oracle completed before parked query'), error => { throw error; })]);
}
test('pure scheduling rejects stalled/nonfinite transitions and exhausted finite budget', () => {
  assert.equal(nextVirtualClock([{ at: 1005 }], 1000, 0), 1005);
  for (const args of [[[{ at: 1000 }], 1000, 0], [[{ at: NaN }], 1000, 0], [[], 1000, 0], [[{ at: 1005 }], 1000, 128]])
    assert.throws(() => nextVirtualClock(...args));
});
test('generator single claim retains staff cookie endpoint path and returns owned hash for all64 and8 CSV', async () => {
  const value = fixture(), data = oracle(value), expected = prepareDistinctReports(value, data), cases = distinctReportCases(value), calls = [], sleepers = [];
  let now = 1000, done = false, result, failure;
  const pause = ms => new Promise(resolve => sleepers.push({ at: now + ms, resolve }));
  const rpc = createDistinctGeneratorRpc({ run, source, getFixture: () => value, getSchools: () => value.schools,
    options: { clock: () => now, pause }, staffRequest: async (school, path, options) => {
      assert.match(school.cookie, /^schoolpilot\.sid=private/); assert.equal(school.csrf, 'private'); assert.ok(options.signal instanceof AbortSignal);
      const query = new URLSearchParams(path.split('?')[1]);
      const item = cases.find(row => row.schoolIndex === school.index && row.scope === query.get('scope') && row.id === query.get('id') && row.from === query.get('from') && row.to === query.get('to'));
      assert.ok(item); assert.equal(options.endpoint, value.apiBases[item.endpointIndex]); calls.push(item.ordinal); await pause(5);
      const body = expected.expectations.get(item.ordinal); return { status: 200, body: query.get('format') === 'csv' ? csvBody(body) : responseBody(body) };
    } });
  const prepared = await rpc.prepare({ source, oracle: data, contractSha256: distinctReportContractHash() });
  const pending = rpc.reports({ startsAtMs: now, preparedHash: prepared.preparedHash });
  await assert.rejects(rpc.reports({ startsAtMs: now, preparedHash: prepared.preparedHash }), /already consumed/);
  pending.then(answer => { result = answer; done = true; }, error => { failure = error; done = true; });
  let iteration = 0;
  while (!done) {
    for (let n = 0; n < 25; n++) await Promise.resolve(); if (done) break;
    now = nextVirtualClock(sleepers, now, iteration++);
    for (const row of sleepers.filter(row => row.at === now)) { sleepers.splice(sleepers.indexOf(row), 1); row.resolve(); }
  }
  if (failure) throw failure;
  assert.equal(result.passed, true); assert.equal(result.preparedHash, prepared.preparedHash); assert.equal(result.capacityAcceptance, false);
  assert.equal(calls.length, 72); assert.equal(new Set(calls).size, 64);
});

test('native observer uses existing pool, scoped repeatable-read role and unchanged raw/coverage with exact8 audits', async () => {
  const value = fixture(), native = nativeFixture(value), data = await native.rpc.oracle({ source, cutoff });
  assert.deepEqual(data, oracle(value)); assert.equal(native.clients.length, 2); assert.equal(native.proofs.length, 1);
  for (const client of native.clients) assert.deepEqual(client.releases, [false]);
  native.native.audit = true;
  const result = await native.rpc.audit(auditRequest(data)); assert.equal(result.passed, true); assert.equal(result.auditCount, 8);
  assert.equal(result.coverageBeforeSha256, result.coverageAfterSha256); assert.equal(result.rawOracleSha256, digest(data));
  assert.equal(native.proofs.length, 2); assert.equal(native.proofs[1].beforeProofSha256, digest(native.proofs[0]));
  assert.equal(native.proofs[0].rawPrefixSha256, native.proofs[1].rawPrefixSha256);
  assert.equal(native.clients.length, 4); for (const client of native.clients) assert.deepEqual(client.releases, [false]);
  const publicText = JSON.stringify(result); assert.ok(!publicText.includes('student0-') && !publicText.includes('raw0-')
    && !publicText.includes('schoolpilot.sid') && !publicText.includes('postgres:'));
  assert.ok(native.clients.every(client => client.calls.every(({ sql }) => !/classpilot_usage_rollups\b/.test(sql))));
  await assert.rejects(native.rpc.oracle({ source, cutoff })); await assert.rejects(native.rpc.audit(auditRequest(data)));
  assert.equal(native.clients.length, 4);
});

test('equal totals cannot hide replaced persisted raw identities during audited report offering', async () => {
  const value = fixture(), native = nativeFixture(value, ({ sql, school, native }) => sql === DISTINCT_RAW_SQL && native.audit
    ? { rows: raw(value, value.schools.find(row => row.id === school).index).map(row => ({ ...row, id: row.id + '-replaced' })) } : null);
  const data = await native.rpc.oracle({ source, cutoff }); native.native.audit = true;
  await assert.rejects(native.rpc.audit(auditRequest(data)), /raw-row identities changed/);
  assert.equal(native.proofs.length, 1); for (const client of native.clients) assert.deepEqual(client.releases, [false]);
});

test('native bounds, restricted scope and coverage failures cannot become measured zero', async () => {
  for (const modify of [
    rows => { rows[0].school_id = 'foreign'; }, rows => { rows[0].timestamp_microseconds = '1'; },
    rows => { rows[0].timestamp_microseconds = String(BigInt(Date.parse(cutoff)) * 1000n); },
  ]) {
    const value = fixture(), native = nativeFixture(value, ({ sql, school }) => {
      if (sql !== DISTINCT_RAW_SQL) return null;
      const rows = raw(value, value.schools.find(row => row.id === school).index); modify(rows); return { rows };
    });
    await assert.rejects(native.rpc.oracle({ source, cutoff })); assert.equal(native.clients.length, 1);
    assert.ok(native.clients[0].calls.some(({ sql }) => sql === 'ROLLBACK')); assert.deepEqual(native.clients[0].releases, [false]); assert.equal(native.proofs.length, 0);
  }
  for (const sqlKind of ['coverage', 'scope']) {
    const value = fixture(), native = nativeFixture(value, ({ sql }) => sqlKind === 'coverage' && sql === DISTINCT_COVERAGE_SQL
      ? { rows: [{ ...coverage(value)[0], valid_window: false }] }
      : sqlKind === 'scope' && sql.includes('COUNT(*)::int FROM students WHERE school_id<>') ? { rows: [{ students: 1, heartbeats: 0, coverage: 0 }] } : null);
    await assert.rejects(native.rpc.oracle({ source, cutoff })); assert.deepEqual(native.clients[0].releases, [false]); assert.equal(native.proofs.length, 0);
  }
});

test('transaction ownership survives an awaited query and cleanup failure destroys exactly one client', async () => {
  const value = fixture(); let releaseQuery, entered;
  const queryEntered = new Promise(resolve => { entered = resolve; });
  const native = nativeFixture(value, async ({ sql }) => {
    if (sql === DISTINCT_COVERAGE_SQL) { entered(); await new Promise(resolve => { releaseQuery = resolve; }); throw Object.assign(Error('Controlled SQL failure'), { code: '57014' }); }
  });
  const pending = native.rpc.oracle({ source, cutoff }); await waitForParkedQuery(queryEntered, pending);
  assert.equal(native.clients[0].releases.length, 0); releaseQuery(); await assert.rejects(pending, /Controlled SQL failure/);
  assert.deepEqual(native.clients[0].releases, [false]); assert.ok(native.clients[0].calls.some(({ sql }) => sql === 'ROLLBACK'));
  let reads = 0;
  const broken = nativeFixture(value, ({ sql }) => sql.startsWith('SELECT current_user AS role,current_database()') && ++reads > 1
    ? { rows: [{ role: 'wrong', database: `schoolpilot_redesign_usage_scale_${run}`, school: '', is_super: '' }] } : null);
  await assert.rejects(broken.rpc.oracle({ source, cutoff })); assert.deepEqual(broken.clients[0].releases, [true]); assert.equal(broken.proofs.length, 0);
});

test('an early oracle rejection reaches the ownership assertion instead of waiting forever for parked SQL', async () => {
  const value = fixture(); let parked = false;
  const queryEntered = new Promise(() => {});
  const native = nativeFixture(value, ({ sql }) => {
    if (sql.startsWith('WITH boundary AS')) throw Error('Oracle failed before parked SQL');
    if (sql === DISTINCT_COVERAGE_SQL) parked = true;
  });
  const pending = native.rpc.oracle({ source, cutoff });
  await assert.rejects(waitForParkedQuery(queryEntered, pending), /Oracle failed before parked SQL/);
  assert.equal(parked, false); assert.equal(native.clients.length, 1); assert.deepEqual(native.clients[0].releases, [false]);
  assert.ok(native.clients[0].calls.some(({ sql }) => sql === 'ROLLBACK')); assert.equal(native.proofs.length, 0);
});

test('wrong lifecycle bindings, missing coverage and audit failure propagate after owned SQL cleanup', async () => {
  for (const kind of ['binding', 'coverage']) {
    const value = fixture(), native = nativeFixture(value, ({ sql, school }) => kind === 'binding' && sql === DISTINCT_RAW_SQL
      ? { rows: raw(value, value.schools.find(row => row.id === school).index).map(row => ({ ...row, valid_binding: false })) }
      : kind === 'coverage' && sql === DISTINCT_COVERAGE_SQL ? { rows: coverage(value).slice(1) } : null);
    await assert.rejects(native.rpc.oracle({ source, cutoff })); for (const client of native.clients) assert.deepEqual(client.releases, [false]);
    assert.equal(native.proofs.length, 0);
  }
  const value = fixture(), native = nativeFixture(value), data = await native.rpc.oracle({ source, cutoff });
  // No exports were recorded: HTTP success alone cannot establish audited CSV.
  await assert.rejects(native.rpc.audit(auditRequest(data))); assert.equal(native.proofs.length, 1);
  for (const client of native.clients) assert.deepEqual(client.releases, [false]);
});

test('unbound environment and changed native fixture are rejected before borrowing a connection', async () => {
  const value = fixture(); let connects = 0;
  const pool = { options: { max: 2 }, connect: async () => { connects++; assert.fail('No checkout permitted'); } };
  for (const modify of [environment => environment.NODE_ENV = 'production', environment => environment.DATABASE_URL = env().DATABASE_URL.replace('127.0.0.1', 'example.test'),
    environment => environment.RELEASE297_PROFILE = 'historical', environment => environment.USAGE_SOURCE_REVISION = 'e'.repeat(40)]) {
    const environment = env(); modify(environment);
    const rpc = createDistinctObserverRpc({ pool, run, source, getFixture: () => value, env: environment });
    await assert.rejects(rpc.oracle({ source, cutoff }));
  }
  assert.equal(connects, 0);
  const native = nativeFixture(value), data = await native.rpc.oracle({ source, cutoff }); value.schools[0].devices[0] = 'replacement';
  await assert.rejects(native.rpc.audit(auditRequest(data))); assert.equal(native.clients.length, 2);
});

test('opt-in overlays retain generated cookie endpoint overrides and existing boundary/legacy RPC branches', () => {
  const generator = patchGeneratorV2(readFileSync(new URL('../release-enabled-generator.mjs', import.meta.url), 'utf8'));
  const observer = readFileSync(new URL('./observer.mjs', import.meta.url), 'utf8');
  const role = readFileSync(new URL('./role-entry.mjs', import.meta.url), 'utf8').replace("'queryPlans'", "'queryPlans', 'boundaryProof'");
  const patched = patchDistinctGeneratorRpc(generator), observed = patchDistinctObserverRpc(observer), owned = patchDistinctRoleEntryRpc(role);
  assert.ok(patched.includes('fetch(`${endpoint ?? base}${path}`'));
  assert.ok(patched.includes('cookie: teacher ? school.teacherCookie : school.cookie'));
  assert.ok(patched.includes('csrf: teacher ? school.teacherCsrf : school.csrf'));
  assert.ok(patched.includes('staffRequest: (...args) => staffRequest(...args)'));
  for (const operation of ['initialize', 'phase', 'correctness', 'shutdown']) assert.ok(patched.includes(`rpc.operation === '${operation}'`));
  for (const operation of ['seed', 'initialize', 'snapshot', 'verify', 'queryPlans', 'correctness']) assert.ok(observed.includes(`request.operation === '${operation}'`));
  for (const operation of ['boundaryProof', 'distinctOracle', 'distinctAudit', 'prepareDistinctReports', 'distinctReports']) assert.ok(owned.includes(`'${operation}'`));
  assert.equal((owned.match(/'distinctReports'/g) ?? []).length, 1);
  for (const patch of [patchDistinctGeneratorRpc, patchDistinctObserverRpc, patchDistinctRoleEntryRpc]) assert.throws(() => patch('missing anchors'));
  assert.throws(() => patchDistinctRoleEntryRpc(role + "\n'queryPlans'"));
});
