import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertLocalScaleFixture, currentObservationSeconds, currentObservationCutoff, measureCall, usageAttributionDiagnosticSql } from './local-usage-scale.mjs';

const run = '012345abcdef';
const local = { USAGE_LOCAL_SCALE: '1', NODE_ENV: 'test', USAGE_SCALE_CONTAINER: `schoolpilot-usage-scale-${run}`,
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${run}`,
  ADMIN_DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${run}` };
test('scale fixture rejects other databases, ports, ownership names and missing opt-in before I/O', () => {
  assert.doesNotThrow(() => assertLocalScaleFixture(local));
  for (const patch of [{ USAGE_LOCAL_SCALE: '0' }, { NODE_ENV: 'production' }, { USAGE_SCALE_CONTAINER: 'schoolpilot-db' },
    { USAGE_SCALE_CONTAINER: 'schoolpilot-usage-scale-abcdefabcdef' },
    { DATABASE_URL: local.DATABASE_URL.replace('127.0.0.1', 'db.example.test') },
    { DATABASE_URL: local.DATABASE_URL.replace('5437', '5435') }, { ADMIN_DATABASE_URL: local.ADMIN_DATABASE_URL.replace(run, 'abcdefabcdef') },
    { DATABASE_URL: local.DATABASE_URL.replace(`schoolpilot_redesign_usage_scale_${run}`, 'schoolpilot') }]) assert.throws(() => assertLocalScaleFixture({ ...local, ...patch }));
});
test('current-day oracle independently deduplicates and bounds gap and cutoff attribution', () => {
  const base = Date.parse('2026-09-30T12:00:00Z'), cutoff = new Date(base + 50_000);
  const rows = [0, 20, 20, 40, 55].map(second => ({ student_id: 'a', timestamp: new Date(base + second * 1000) }));
  rows.push({ student_id: 'b', timestamp: new Date(base + 48_000) });
  assert.deepEqual([...currentObservationSeconds(rows.reverse(), cutoff)], [['b', 2], ['a', 40]]);
});
test('dedicated runner verifies exact loopback port, caps and cleanup ownership without changing shared quotas', () => {
  const script = readFileSync(new URL('./run-local-usage-scale.ps1', import.meta.url), 'utf8');
  assert.match(script, /--cpus 4 --memory 4g --memory-swap 4g --publish '127\.0\.0\.1:5437:5432'/);
  assert.match(script, /node --max-old-space-size=512/);
  assert.match(script, /Cleanup refused without exact run ownership label/);
  assert.match(script, /docker rm --force --volumes \$container/);
  assert.doesNotMatch(script, /docker (?:rm|stop|update).*schoolpilot-db/);
  assert.match(script, /Choose an external evidence directory/);
});

test('current-day oracle does not grant fractional tail time beyond the established whole-second writer boundary', () => {
  const now = Date.parse('2026-09-30T12:00:50.999Z'), cutoff = currentObservationCutoff(now);
  assert.equal(cutoff.toISOString(), '2026-09-30T12:00:50.000Z');
  assert.deepEqual([...currentObservationSeconds([
    { student_id: 'a', timestamp: '2026-09-30T12:00:49.400Z' },
    { student_id: 'b', timestamp: '2026-09-30T12:00:50.200Z' },
  ], cutoff)], [['a', 1]]);
});

test('API timing preserves both pg overloads, returned values and failures', async () => {
  const records = [], expectedError = new Error('synthetic');
  const client = { query(...args) {
    const callback = args.at(-1), error = args[0] === 'fail' ? expectedError : undefined;
    if (typeof callback === 'function') { queueMicrotask(() => callback(error, 'callback-value')); return 'query-object'; }
    return error ? Promise.reject(error) : Promise.resolve('promise-value');
  } };
  measureCall(client, 'query', (duration, error) => records.push({ duration, error }));
  assert.equal(await client.query('ok'), 'promise-value');
  await assert.rejects(client.query('fail'), error => error === expectedError);
  await new Promise(done => assert.equal(client.query('ok', (error, value) => { assert.equal(error, undefined); assert.equal(value, 'callback-value'); done(); }), 'query-object'));
  assert.equal(records.length, 3); assert.ok(records.every(row => row.duration >= 0));
  assert.equal(records[1].error, expectedError);
});

test('both attribution shapes retain their correct heartbeat sums while diagnostics cannot insert rows', () => {
  const suffix = ',\ninserted AS (\n  INSERT INTO classpilot_usage_rollups SELECT 1) SELECT * FROM inserted';
  const baseline = usageAttributionDiagnosticSql('WITH observed AS MATERIALIZED (SELECT 1), attributed AS (SELECT 1)' + suffix);
  assert.match(baseline, /COUNT\(\*\)::int AS heartbeats/);
  assert.doesNotMatch(baseline, /INSERT INTO/);
  const bounded = usageAttributionDiagnosticSql('WITH school_sessions AS MATERIALIZED (SELECT 1),\ngrains AS (SELECT 1)' + suffix);
  assert.match(bounded, /SUM\(heartbeat_count\) AS heartbeats FROM grains/);
  assert.doesNotMatch(bounded, /INSERT INTO/);
  assert.throws(() => usageAttributionDiagnosticSql('DELETE FROM schools' + suffix));
  assert.throws(() => usageAttributionDiagnosticSql('SELECT 1'));
});
