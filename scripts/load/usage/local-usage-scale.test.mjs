import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertFreshEvidenceDirectory } from './assert-fresh-evidence-directory.mjs';
import { assertLocalScaleFixture, currentObservationSeconds, currentObservationDiagnostics, currentObservationFixtureViolations, currentObservationCutoff, measureCall, usageAttributionDiagnosticSql, apiStatementKind } from './local-usage-scale.mjs';

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
  const rows = [0, 20, 20, 40, 55].map(second => ({ student_id: 'a', timestamp_microseconds: (BigInt(base + second * 1000) * 1000n).toString() }));
  rows.push({ student_id: 'b', timestamp_microseconds: (BigInt(base + 48_000) * 1000n).toString() });
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
  assert.match(script, /pg_isready -h 127\.0\.0\.1 -p 5432/, 'Wait for final TCP server, not the temporary Unix-socket initialization server');
});

test('current-day oracle does not grant fractional tail time beyond the established whole-second writer boundary', () => {
  const now = Date.parse('2026-09-30T12:00:50.999Z'), cutoff = currentObservationCutoff(now);
  assert.equal(cutoff.toISOString(), '2026-09-30T12:00:50.000Z');
  assert.deepEqual([...currentObservationSeconds([
    { student_id: 'a', timestamp_microseconds: (BigInt(Date.parse('2026-09-30T12:00:49.400Z')) * 1000n).toString() },
    { student_id: 'b', timestamp_microseconds: (BigInt(Date.parse('2026-09-30T12:00:50.200Z')) * 1000n).toString() },
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

test('API diagnostics retain fixed family labels rather than SQL or parameters', () => {
  assert.equal(apiStatementKind('WITH scoped AS (SELECT * FROM classpilot_usage_rollups JOIN classpilot_usage_rollup_days ON true) SELECT COUNT(*) GROUP BY GROUPING SETS (())'), 'usageReport');
  assert.equal(apiStatementKind('SELECT computed_at FROM classpilot_usage_rollup_days WHERE school_id=$1'), 'usageCoverage');
  assert.equal(apiStatementKind('SELECT * FROM schools JOIN settings ON true WHERE id=$1'), 'settings');
  assert.equal(apiStatementKind('INSERT INTO heartbeats VALUES($1)'), 'heartbeat');
  assert.equal(apiStatementKind('SELECT set_config($1,$2,true)'), 'transaction');
});

test('fresh output guard preserves existing failure artifacts and refuses files and hidden entries before output writes', () => {
  const directory = mkdtempSync(join(tmpdir(),'schoolpilot-evidence-guard-'));
  try {
    assert.doesNotThrow(() => assertFreshEvidenceDirectory(join(directory,'new')));
    const empty = join(directory,'empty'); mkdirSync(empty);
    assert.doesNotThrow(() => assertFreshEvidenceDirectory(empty));
    const marker = join(directory,'failed-profile.json'), original = '{"passed":false,"immutable":true}\n';
    writeFileSync(marker,original);
    assert.throws(() => assertFreshEvidenceDirectory(directory),/fresh empty evidence directory/);
    assert.throws(() => assertFreshEvidenceDirectory(marker),/fresh empty evidence directory/);
    writeFileSync(join(empty,'.hidden-artifact'),'preserve');
    assert.throws(() => assertFreshEvidenceDirectory(empty),/fresh empty evidence directory/);
    const result = spawnSync(process.execPath,[fileURLToPath(new URL('./assert-fresh-evidence-directory.mjs',import.meta.url)),directory],{encoding:'utf8'});
    assert.equal(result.status,1); assert.match(result.stderr,/existing artifacts will not be overwritten/);
    assert.equal(readFileSync(marker,'utf8'),original);
    assert.deepEqual(readdirSync(directory).sort(),['empty','failed-profile.json']);
    const script = readFileSync(new URL('./run-local-usage-scale.ps1',import.meta.url),'utf8');
    assert.ok(script.indexOf('assert-fresh-evidence-directory.mjs') < script.indexOf('New-Item -ItemType Directory'), 'Guard must run before the first output mutation');
  } finally {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute),resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('schoolpilot-evidence-guard-'));
    rmSync(absolute,{recursive:true,force:true});
  }
});

test('current-day oracle preserves microseconds below a half-second rounding boundary', () => {
  const cutoff = new Date('2026-10-03T02:02:33Z');
  const rows = [{ student_id: 'synthetic', timestamp: new Date('2026-10-03T02:02:32.500001Z'), timestamp_microseconds: '1790992952500001' }];
  assert.deepEqual([...currentObservationSeconds(rows, cutoff)], [['synthetic', 0]]);
});

test('exact oracle rounds both sides of a half-second and retains an exact half', () => {
  const cutoff = new Date('2026-10-03T02:02:33Z');
  const rows = [
    { student_id: 'below', timestamp_microseconds: '1790992952500001' },
    { student_id: 'half', timestamp_microseconds: '1790992952500000' },
    { student_id: 'above', timestamp_microseconds: '1790992952499999' },
  ];
  assert.deepEqual([...currentObservationSeconds(rows, cutoff)], [['below', 0], ['half', 1], ['above', 1]]);
});

test('exact oracle deduplicates by second and sums microsecond gaps before rounding', () => {
  const cutoff = new Date('2026-10-03T02:02:33Z');
  const rows = [
    { student_id: 'synthetic', timestamp_microseconds: '1790992951500002' },
    { student_id: 'synthetic', timestamp_microseconds: '1790992951500001' },
    { student_id: 'synthetic', timestamp_microseconds: '1790992952000001' },
    { student_id: 'synthetic', timestamp_microseconds: '1790992953000000' },
  ];
  assert.deepEqual([...currentObservationSeconds(rows, cutoff)], [['synthetic', 1]]);
  const diagnostics = currentObservationDiagnostics(rows, cutoff);
  assert.equal(diagnostics.includedObservations, 3);
  assert.equal(diagnostics.deduplicatedObservations, 2);
  assert.equal(diagnostics.exactRoundedSeconds, 1);
  assert.equal(diagnostics.legacyRoundedSeconds, 2);
});

test('oracle precision diagnostics remain bounded and contain no identity or raw timestamp', () => {
  const rows = [{ student_id: 'private-synthetic-identifier', timestamp_microseconds: '1790992952500001' }];
  const result = currentObservationDiagnostics(rows, new Date('2026-10-03T02:02:33Z'));
  assert.deepEqual(result, { precision: 'integer_microseconds_text', rawObservations: 1, includedObservations: 1,
    submillisecondObservations: 1, deduplicatedObservations: 1, students: 1,
    exactRoundedSeconds: 0, legacyRoundedSeconds: 1, roundingSensitiveStudents: 1 });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private-synthetic-identifier|1790992952500001|02:02:32/);
  assert.ok(serialized.length < 400);
});

test('oracle refuses lossy Date inputs and every raw-query caller requests exact text', () => {
  const cutoff = new Date('2026-10-03T02:02:33Z');
  assert.throws(() => currentObservationSeconds([{ student_id: 'a', timestamp: new Date() }], cutoff), /timestamp_microseconds/);
  for (const value of [1790992952500001, '1.2', '1e6', 'not-a-time']) {
    assert.throws(() => currentObservationSeconds([{ student_id: 'a', timestamp_microseconds: value }], cutoff));
  }
  for (const name of ['local-usage-scale.mjs', 'local-school-day-scale.mjs', 'release-enabled-scale.mjs']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.match(source, /EXTRACT\(EPOCH FROM timestamp\)\*1000000\)::bigint::text AS timestamp_microseconds/);
    assert.doesNotMatch(source, /timestamp AT TIME ZONE.*AS timestamp FROM heartbeats/);
  }
  const release = readFileSync(new URL('release-enabled-scale.mjs', import.meta.url), 'utf8');
  assert.match(release, /assert\.equal\(result\.seconds, expectedSeconds\)/);
  assert.match(release, /timestampPrecision: currentObservationDiagnostics\(raw, cutoff\)/);
});

test('current-day fixture refuses nonconstant grains and emits only fixed violation counts', () => {
  const valid = { student_id: 'synthetic-private-id', expected_url: true, expected_classification: true, expected_teacher_intent: true };
  const counts = { currentAiDecisionRows: 0, invalidRosterStudents: 0 };
  const check = (rows, db = counts) => currentObservationFixtureViolations(rows, [valid.student_id], db);
  assert.ok(Object.values(check([valid])).every(value => value === 0));
  for (const [field, counter] of [['expected_url', 'unexpectedUrlObservations'], ['expected_classification', 'unexpectedClassificationObservations'], ['expected_teacher_intent', 'unexpectedTeacherIntentObservations']]) {
    assert.equal(check([{ ...valid, [field]: false }])[counter], 1);
    assert.equal(check([{ ...valid, [field]: undefined }])[counter], 1);
  }
  const result = check([valid, { ...valid, student_id: 'foreign-id' }], { currentAiDecisionRows: 1, invalidRosterStudents: 2 });
  assert.equal(result.unexpectedStudents, 1); assert.equal(result.currentAiDecisionRows, 1); assert.equal(result.invalidRosterStudents, 2);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-id|foreign-id|https?:/);
  assert.equal(Object.keys(result).length, 6);
  assert.throws(() => check([valid], { ...counts, invalidRosterStudents: '0' }), /Invalid fixture violation count/);
  const source = readFileSync(new URL('./release-enabled-scale.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf("'Current-day one-grain fixture invariant failed'") < source.indexOf('const observed = currentObservationSeconds(raw, cutoff)'));
});
