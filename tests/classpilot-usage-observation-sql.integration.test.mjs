import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { tsImport } from 'tsx/esm/api';
import { buildLedgerObservationSql, effectiveRetentionHoursSql, localDayBounds } from '../scripts/collect-classpilot-usage-observation.mjs';
import { buildRetainedRecountInputSql, buildRetainedRecountSql } from '../scripts/classpilot-usage-retained-recount.mjs';

// DB_SERIAL. Every table used by generated SQL is copied into a unique local
// schema; fixture writes and cleanup never use the application's public data.
const schema = `usage_observation_sql_${randomUUID().replaceAll('-', '')}`;
const tables = ['schools', 'product_licenses', 'settings', 'students', 'heartbeats',
  'classpilot_monitoring_events', 'classpilot_ai_decisions', 'teaching_sessions',
  'classpilot_session_students', 'groups', 'classpilot_usage_rollups', 'classpilot_usage_rollup_days'];
const schoolId = randomUUID(), foreignSchoolId = randomUUID(), studentId = randomUUID();
const directory = mkdtempSync(join(tmpdir(), 'usage-observation-sql-test-'));
let admin, fixture, connection, application, retention, spec, context, contextBytes, recountSql;

function identifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]+$/);
  return `"${value}"`;
}

function sql(name, statement, { fails = false } = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^PG/.test(key)) delete environment[key];
  Object.assign(environment, {
    PGHOST: connection.hostname.replace(/^\[|\]$/g, ''), PGPORT: connection.port || '5432',
    PGDATABASE: decodeURIComponent(connection.pathname.slice(1)), PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password), PGOPTIONS: `-c search_path=${schema},public`,
    PGPASSFILE: join(directory, 'absent-pgpass'),
  });
  const result = spawnSync(process.env.PSQL_BINARY || 'psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], {
    cwd: directory, env: environment, input: statement, encoding: 'utf8', windowsHide: true,
    timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (fails) {
    assert.notEqual(result.status, 0, `${name} must fail closed`);
    assert.match(result.stderr || '', /division by zero|read-only transaction/i, `${name}: ${result.stderr}`);
  } else {
    assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr}`);
  }
  return result.stdout;
}

function json(name, statement) { return JSON.parse(sql(name, statement).trim()); }

before(async () => {
  assert.match(schema, /^usage_observation_sql_[a-f0-9]{32}$/);
  const applicationUrl = new URL(process.env.DATABASE_URL || '');
  connection = new URL(process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || '');
  for (const target of [applicationUrl, connection]) {
    assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
    assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname), 'Only local fixture PostgreSQL is permitted');
    assert.equal(target.search, ''); assert.equal(target.hash, '');
  }
  assert.deepEqual([applicationUrl.hostname, applicationUrl.port || '5432', applicationUrl.pathname],
    [connection.hostname, connection.port || '5432', connection.pathname], 'Admin and app must target the same local fixture database');
  const clientVersion = spawnSync(process.env.PSQL_BINARY || 'psql', ['--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(clientVersion.status, 0, 'Generated SQL regression requires the native psql client on PATH (or PSQL_BINARY)');
  application = await tsImport(new URL('../src/services/classpilotUsageRollup.ts', import.meta.url).href, import.meta.url);
  retention = await tsImport(new URL('../src/util/classpilotRetention.ts', import.meta.url).href, import.meta.url);
  admin = new pg.Pool({ connectionString: connection.href, max: 1 });
  assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, decodeURIComponent(connection.pathname.slice(1)));
  await admin.query(`CREATE SCHEMA ${identifier(schema)}`);
  for (const table of tables) await admin.query(`CREATE TABLE ${identifier(schema)}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`);
  fixture = new pg.Pool({ connectionString: connection.href, max: 2, options: `-c search_path=${schema},public` });
  const actualType = (await fixture.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='settings' AND column_name='retention_hours'", [schema])).rows[0].data_type;
  assert.equal(actualType, 'text', 'Exercise the real settings type, not a numeric mock');
  let date = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = new Date(Date.parse(`${date}T00:00:00Z`) - 24 * 3_600_000).toISOString().slice(0, 10);
  const bounds = localDayBounds(date, 'UTC');
  spec = {
    schemaVersion: 1,
    serving: { appSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
      apiArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/native-sql-fixture-api:1',
      workerArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/native-sql-fixture-worker:1' },
    workerLogStreams: [`scheduler-worker/scheduler-worker/${'c'.repeat(32)}`],
    startedAt: new Date(bounds.start).toISOString(), endedAt: new Date(bounds.end + 3_600_000).toISOString(),
    reviewedAt: new Date().toISOString().replace(/(\.\d{3})Z$/, '$10000Z'), reviewReference: 'synthetic/native-sql-regression',
    schoolDays: [{ schoolId, date, timeZone: 'UTC' }],
  };
  await fixture.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'SQL fixture','active',true,'active','UTC'),($2,'Foreign inactive fixture','inactive',false,'active','UTC')", [schoolId, foreignSchoolId]);
  await fixture.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  await fixture.query("INSERT INTO settings(school_id,school_name,ws_shared_key,retention_hours,enable_tracking_hours) VALUES($1,'SQL fixture','fixture',' 720 ',false)", [schoolId]);
  await fixture.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'SQL','Fixture','active')", [studentId, schoolId]);
  await fixture.query("INSERT INTO heartbeats(school_id,student_id,device_id,timestamp,active_tab_title,active_tab_url,ai_category) VALUES($1,$2,'sql-fixture',$3::timestamp,'synthetic','https://example.test/lesson','educational'),($4,$2,'foreign-fixture',$3::timestamp,'synthetic','https://foreign.example.test/lesson','educational')",
    [schoolId, studentId, new Date(bounds.start + 10 * 3_600_000).toISOString().replace('T', ' ').replace('Z', ''), foreignSchoolId]);
  const result = await application.rollupClasspilotUsageDay(fixture, { schoolId, day: application.classpilotUsageRollupDay(date, 'UTC'), windowEndUtc: new Date(bounds.end), exclusions: [] });
  assert.deepEqual([result.seconds, result.heartbeatCount], [15, 1]);
});

after(async () => {
  await fixture?.end();
  if (admin) {
    assert.match(schema, /^usage_observation_sql_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
    assert.equal((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists', [schema])).rows[0].exists, false);
    await admin.end();
  }
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
  assert.match(basename(directory), /^usage-observation-sql-test-/);
  rmSync(directory, { recursive: true, force: true });
});

test('generated acquisition and canonical recount execute on native PostgreSQL with TEXT settings', async t => {
  await t.test('retention SQL matches the source parser including malformed, Unicode, overflow and leading zeros', async () => {
    const values = [null, '24', ' 720 ', '\t00024\r\n', '\u00a0720\ufeff', '8760', '25', '0', '-24', '24.0', '1e3',
      '9999999999999999999999999999999', '000000000000000000000000000720', ''];
    for (const value of values) {
      const literal = value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
      const expected = retention.parseClasspilotRetentionDays(value) * 24;
      assert.equal(Number(sql('retention expression', `BEGIN READ ONLY; SELECT ${effectiveRetentionHoursSql('input.value')} FROM (SELECT ${literal}::text AS value) AS input; COMMIT;`).trim()), expected, JSON.stringify(value));
      if (value !== null) {
        await fixture.query('UPDATE settings SET retention_hours=$2 WHERE school_id=$1', [schoolId, value]);
        assert.equal(json('actual recount context retention', buildRetainedRecountInputSql(spec, schoolId)).retentionHours, expected);
        assert.equal(json('actual ledger retention', buildLedgerObservationSql(spec)).schools[0].retentionHours, expected);
      }
    }
    await fixture.query("UPDATE settings SET retention_hours=' 720 ' WHERE school_id=$1", [schoolId]);
  });

  await t.test('actual acquisition output contains only the exact eligible school and preserves text settings', () => {
    const ledger = json('ledger acquisition', buildLedgerObservationSql(spec));
    assert.equal(ledger.eligibleSchoolCount, 1); assert.equal(ledger.days.length, 1);
    assert.equal(ledger.schools[0].schoolId, schoolId); assert.equal(ledger.schools[0].retentionHours, 720);
    assert.equal(ledger.days[0].isFinal, true);
    contextBytes = Buffer.from(sql('recount context acquisition', buildRetainedRecountInputSql(spec, schoolId)));
    context = JSON.parse(contextBytes.toString().trim());
    assert.equal(context.trackingSettings.retention_hours, ' 720 ');
    assert.equal(context.trackingEventsTruncated, false); assert.deepEqual(context.trackingEvents, []);
  });

  await t.test('actual canonical SQL matches persisted totals and excludes foreign heartbeats', () => {
    recountSql = buildRetainedRecountSql({ spec, context, contextBytes, now: new Date(), application });
    const result = json('retained recount', recountSql);
    assert.deepEqual([result.recountSeconds, result.persistedSeconds, result.rawHeartbeatCount, result.recountHeartbeatCount, result.persistedHeartbeatCount], [15, 15, 1, 1, 1]);
    assert.equal(result.secondsMatch, true); assert.equal(result.heartbeatCountMatch, true);
    assert.equal(result.rawDayWhollyRetained, true); assert.equal(result.trackingEventsComplete, true);
  });

  await t.test('same-snapshot policy drift and invalidated ledger guards refuse actual SQL', async () => {
    await fixture.query("UPDATE settings SET tracking_start_time='09:00' WHERE school_id=$1", [schoolId]);
    sql('changed policy guard', recountSql, { fails: true });
    await fixture.query("UPDATE settings SET tracking_start_time='08:00' WHERE school_id=$1", [schoolId]);
    await fixture.query('DELETE FROM classpilot_usage_rollup_days WHERE school_id=$1', [schoolId]);
    sql('invalidated final ledger guard', recountSql, { fails: true });
  });
});
