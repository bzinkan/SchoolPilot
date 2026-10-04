import test from 'node:test';
import assert from 'node:assert/strict';
import { contentFreeUsagePlan, recordUsageReportCosts } from '../scripts/load/usage/release-gates-v2/report-cost.mjs';

const database = 'schoolpilot_redesign_usage_scale_0123456789ab';
const fixture = { today: '2026-09-14', schools: [0, 1].map(index => ({ id: 'fixture-school-' + index,
  groups: ['fixture-class-' + index], students: ['fixture-student-' + index] })) };
const one = { schoolIndex: 0, scope: 'student', idIndex: 0, from: '2026-09-01', to: '2026-09-14' };
const input = cases => ({ source: 'a'.repeat(40), schemaSha256: 'b'.repeat(64), profile: 'usage-final-v2', cases });
const plan = { 'Planning Time': 0.5, 'Execution Time': 4,
  Plan: { 'Node Type': 'Aggregate', 'Actual Rows': 1, 'Actual Loops': 1, 'Temp Written Blocks': 3,
    'Output': ['private student name'], Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'classpilot_usage_rollups',
      'Index Cond': "student_id = 'fixture-student-0'", 'Actual Rows': 84000, 'Actual Loops': 1, 'Shared Read Blocks': 15 }] } };

function harness({ sqlFailure = false, rollbackFailure = false, resetFailure = false, bypass = false, duplicateSlices = false, empty = false, mutating = false } = {}) {
  const calls = [], releases = [];
  let role = 'fixture_owner', school = null, isSuper = null, time = 0, connects = 0;
  const error = new Error('synthetic SQL failure');
  const client = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT current_user AS role,current_database')) {
      if (resetFailure && calls.some(call => call.sql === 'COMMIT')) school = 'wrong-scope';
      return { rows: [{ role, database, school, is_super: isSuper }] };
    }
    if (sql.startsWith('SET LOCAL ROLE')) role = 'fixture_runtime';
    else if (sql.startsWith("SELECT set_config('app.school_id'")) { school = values[0]; isSuper = 'off'; }
    else if (sql.includes('FROM pg_roles')) return { rows: [{ role, rolsuper: false, rolbypassrls: bypass, pid: 42, school, is_super: isSuper }] };
    else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      if (sql === 'ROLLBACK' && rollbackFailure) throw new Error('synthetic rollback failure');
      role = 'fixture_owner'; school = null; isSuper = null;
    } else if (sql.startsWith('EXPLAIN ')) return { rows: [{ 'QUERY PLAN': [plan] }] };
    else if (sql.startsWith('WITH grouped')) { if (sqlFailure) throw error; return { rows: [{ privateName: 'private student name' }] }; }
    return { rows: [] };
  }, release(discard) { releases.push(discard); } };
  const pool = { async connect() { connects++; return client; } };
  const deps = { env: { NODE_ENV: 'test', USAGE_LOCAL_SCALE: '1',
    DATABASE_URL: 'postgresql://fixture_runtime:unused@127.0.0.1:5547/' + database,
    USAGE_SOURCE_REVISION: 'a'.repeat(40), RELEASE297_PROFILE: 'usage-final-v2' },
    clock: () => time++, bindings: { compiledReportSha256: 'c'.repeat(64), packageSha256: 'd'.repeat(64) },
    dialect: { sqlToQuery: statement => statement },
    async getReport(options) {
      await options.transaction.execute({ sql: mutating ? 'WITH changed AS (DELETE FROM students) SELECT 1' : 'WITH grouped AS MATERIALIZED (SELECT $1) SELECT * FROM grouped', params: [options.schoolId, options.id] });
      return { totals: { heartbeatCount: empty ? 0 : 123 }, byDay: empty ? [] : [{ date: '2026-09-14' }], dataState: empty ? 'unavailable' : 'final',
        range: { presentedFrom: duplicateSlices ? '2026-09-01' : options.from, presentedTo: duplicateSlices ? '2026-09-14' : options.to,
          computedDays: empty ? 0 : 14, unavailableDates: [] } };
    } };
  return { pool, deps, calls, releases, error, get connects() { return connects; } };
}

test('report-cost receipt removes values and marks warm replay separately from acceptance', async () => {
  const h = harness();
  const result = await recordUsageReportCosts({ pool: h.pool, fixture, request: input([one,
    { schoolIndex: 1, scope: 'school', from: '2026-06-01', to: '2026-09-14' }]) }, h.deps);
  assert.equal(result.capacityAcceptance, false); assert.equal(result.cases.length, 2);
  assert.equal(result.distinctEffectiveSlices, 2); assert.equal(result.statementTimeoutMs, 15000);
  assert.ok(result.cases.every(item => item.restrictedRoleVerified && item.tenantScopeVerified && item.backendPid === 42));
  assert.ok(result.cases.every(item => item.statements[0].normalSqlMs === 1 && item.statements[0].executionMs === 4));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private student name|fixture-student|fixture-school|Index Cond|Output|unused/);
  assert.deepEqual(h.releases, [false, false]);
  assert.equal(h.calls.filter(call => call.sql === 'COMMIT').length, 2);
  assert.equal(h.calls.filter(call => call.sql.startsWith('EXPLAIN ')).length, 2);
  assert.ok(h.calls.every(call => !/^CREATE|^INSERT|^UPDATE|^DELETE/.test(call.sql)));
});

test('plan sanitizer preserves scan/spill costs while excluding literal expressions', () => {
  const sanitized = contentFreeUsagePlan(plan);
  assert.equal(sanitized.plan['Temp Written Blocks'], 3);
  assert.equal(sanitized.plan.Plans[0]['Actual Rows'], 84000);
  assert.equal(sanitized.plan.Plans[0]['Shared Read Blocks'], 15);
  assert.match(sanitized.planSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(sanitized), /Index Cond|private student|fixture-student/);
});

test('stale source, foreign targets and production-shaped URLs fail before any checkout', async () => {
  for (const variant of ['source', 'target', 'url']) {
    const h = harness(), request = input([structuredClone(one)]);
    if (variant === 'source') request.source = 'f'.repeat(40);
    if (variant === 'target') { delete request.cases[0].idIndex; request.cases[0].id = fixture.schools[1].students[0]; }
    if (variant === 'url') h.deps.env.DATABASE_URL = 'postgresql://fixture_runtime:unused@production.example/schoolpilot';
    await assert.rejects(recordUsageReportCosts({ pool: h.pool, fixture, request }, h.deps));
    assert.equal(h.connects, 0); assert.deepEqual(h.releases, []);
  }
});

test('normal SQL failure finishes rollback and returns its original error before release', async () => {
  const h = harness({ sqlFailure: true });
  await assert.rejects(recordUsageReportCosts({ pool: h.pool, fixture, request: input([one]) }, h.deps), error => error === h.error);
  assert.ok(h.calls.some(call => call.sql === 'ROLLBACK')); assert.deepEqual(h.releases, [false]);
});

test('failed rollback or leaked local role/GUC state discards the borrowed client exactly once', async () => {
  for (const options of [{ sqlFailure: true, rollbackFailure: true }, { resetFailure: true }]) {
    const h = harness(options);
    await assert.rejects(recordUsageReportCosts({ pool: h.pool, fixture, request: input([one]) }, h.deps));
    assert.deepEqual(h.releases, [true]);
  }
});

test('duplicate effective ranges, privileged runtime roles, silent empty work and mutating SQL cannot produce accepted receipts', async () => {
  for (const variant of ['duplicate', 'role', 'empty', 'mutation']) {
    const h = harness({ duplicateSlices: variant === 'duplicate', bypass: variant === 'role', empty: variant === 'empty', mutating: variant === 'mutation' });
    const cases = variant === 'duplicate' ? [one, { ...one, from: '2026-08-01' }] : [one];
    await assert.rejects(recordUsageReportCosts({ pool: h.pool, fixture, request: input(cases) }, h.deps));
    assert.ok(h.calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(h.releases.every(discard => discard === false));
    if (variant === 'mutation') assert.ok(h.calls.every(call => !call.sql.includes('DELETE FROM students')));
  }
});
