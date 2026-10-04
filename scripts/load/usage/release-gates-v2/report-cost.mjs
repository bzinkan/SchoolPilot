import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const normalize = value => value == null ? '' : String(value);
const scopeSql = "SELECT current_user AS role,current_database() AS database,current_setting('app.school_id',true) AS school,current_setting('app.is_super',true) AS is_super";
const fields = ['Node Type','Relation Name','Schema','Index Name','Join Type','Strategy','Actual Rows','Actual Loops',
  'Rows Removed by Filter','Rows Removed by Join Filter','Shared Hit Blocks','Shared Read Blocks','Shared Dirtied Blocks','Shared Written Blocks',
  'Temp Read Blocks','Temp Written Blocks','Hash Buckets','Hash Batches','Original Hash Batches','Peak Memory Usage','Disk Usage','Sort Method','Sort Space Used','Sort Space Type'];

/** Plans may contain literal tenant/student values. Retain only structural cost fields. */
export function contentFreeUsagePlan(plan) {
  const node = raw => ({ ...Object.fromEntries(fields.filter(key => raw[key] !== undefined).map(key => [key, raw[key]])),
    ...(raw.Plans ? { Plans: raw.Plans.map(node) } : {}) });
  assert.ok(plan?.Plan);
  return { planSha256: digest(plan), planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], plan: node(plan.Plan) };
}

async function applicationDependencies() {
  const { applicationRoot, moduleFromApplication, requireFromApplication } = await import('./application.mjs');
  const { getClasspilotDigitalUsage } = await moduleFromApplication('services/classpilotUsageRead.js');
  const { PgDialect } = requireFromApplication('drizzle-orm/pg-core');
  return { getReport: getClasspilotDigitalUsage, dialect: new PgDialect(), bindings: {
    compiledReportSha256: digest(readFileSync(resolve(applicationRoot, 'dist/services/classpilotUsageRead.js')).toString()),
    packageSha256: digest(readFileSync(resolve(applicationRoot, 'package.json')).toString()),
  } };
}

/**
 * Optional post-drain diagnostic. Borrow only the observer's existing pool.
 * The normal canonical report read is timed first; EXPLAIN replay is separate,
 * warm evidence. Neither replaces authenticated HTTP or capacity acceptance.
 * Dependency injection exists only for hermetic ownership/receipt tests.
 */
export async function recordUsageReportCosts({ pool, fixture, request }, dependencies) {
  const env = dependencies?.env ?? process.env, clock = dependencies?.clock ?? (() => performance.now());
  assert.equal(env.NODE_ENV, 'test'); assert.equal(env.USAGE_LOCAL_SCALE, '1');
  const url = new URL(env.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname), 'Only the owned local fixture is supported');
  assert.match(url.pathname, /^\/schoolpilot_redesign_usage_scale_[a-f0-9]{12}$/);
  const runtimeRole = decodeURIComponent(url.username);
  assert.match(runtimeRole, /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/);
  assert.match(request.source, /^[a-f0-9]{40}$/); assert.equal(request.source, env.USAGE_SOURCE_REVISION);
  assert.match(request.schemaSha256, /^[a-f0-9]{64}$/); assert.equal(request.profile, env.RELEASE297_PROFILE);
  assert.ok(Array.isArray(request.cases) && request.cases.length > 0 && request.cases.length <= 64);
  assert.ok(Array.isArray(fixture.schools) && fixture.schools.length === 2 && date(fixture.today));
  const cases = request.cases.map(item => {
    assert.ok(Number.isInteger(item.schoolIndex) && item.schoolIndex >= 0 && item.schoolIndex < fixture.schools.length);
    const school = fixture.schools[item.schoolIndex];
    assert.ok(['school', 'grade', 'class', 'student'].includes(item.scope));
    assert.ok(date(item.from) && date(item.to) && item.from <= item.to);
    const days = (Date.parse(item.to) - Date.parse(item.from)) / 86_400_000 + 1;
    assert.ok(days <= 366);
    let id = item.id ?? null;
    if (item.scope === 'school') assert.equal(id, null);
    else if (item.scope === 'grade') assert.ok(typeof id === 'string' && /^[A-Za-z0-9 .:-]{1,128}$/.test(id));
    else {
      const members = item.scope === 'class' ? school.groups : school.students;
      if (id === null && Number.isInteger(item.idIndex)) id = members[item.idIndex];
      assert.ok(typeof id === 'string' && members.includes(id), 'Diagnostic targets must belong to the fixture school');
    }
    return { schoolId: school.id, schoolIndex: item.schoolIndex, scope: item.scope, id,
      from: item.from, to: item.to, requestedDays: days, allowEmpty: item.allowEmpty === true };
  });
  assert.equal(new Set(cases.map(item => digest(item))).size, cases.length, 'Requested cases must be distinct');
  const { getReport, dialect, bindings } = dependencies ?? await applicationDependencies();
  assert.match(bindings.compiledReportSha256, /^[a-f0-9]{64}$/); assert.match(bindings.packageSha256, /^[a-f0-9]{64}$/);
  const effective = new Set(), results = [];
  for (const item of cases) {
    const client = await pool.connect();
    let before, began = false, broken = false, failure, result;
    try {
      before = (await client.query(scopeSql)).rows[0];
      assert.equal(before.database, url.pathname.slice(1));
      began = true; await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
      await client.query("SELECT set_config('app.school_id',$1,true),set_config('app.is_super','off',true),set_config('statement_timeout','15000',true)", [item.schoolId]);
      const role = (await client.query("SELECT current_user AS role,rolsuper,rolbypassrls,pg_backend_pid() AS pid,current_setting('app.school_id') AS school,current_setting('app.is_super') AS is_super FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(role.role, runtimeRole); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
      assert.equal(role.school, item.schoolId); assert.equal(role.is_super, 'off'); assert.ok(Number.isInteger(role.pid));
      const captured = [];
      const transaction = { async execute(statement) {
        const query = dialect.sqlToQuery(statement);
        assert.match(query.sql.trimStart(), /^(?:SELECT|WITH)\b/i);
        assert.doesNotMatch(query.sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY|TRUNCATE)\b/i);
        const started = clock(), answer = await client.query(query.sql, query.params);
        captured.push({ query, normalSqlMs: clock() - started, rowCount: answer.rows.length });
        return answer;
      } };
      const started = clock();
      const report = await getReport({ schoolId: item.schoolId, scope: item.scope, id: item.id, from: item.from, to: item.to,
        now: new Date(fixture.today + 'T16:00:00Z'), transaction });
      const normalServiceMs = clock() - started;
      if (!item.allowEmpty) assert.ok(report.totals.heartbeatCount > 0 && report.byDay.length > 0, 'A populated diagnostic may not silently become a cheap empty report');
      const effectiveKey = digest([item.schoolId, item.scope, item.id, report.range.presentedFrom, report.range.presentedTo]);
      assert.ok(!effective.has(effectiveKey), 'Retention/coverage clipping produced a duplicate effective data slice'); effective.add(effectiveKey);
      const statements = [];
      for (const entry of captured) {
        const plan = (await client.query('EXPLAIN (ANALYZE, BUFFERS, TIMING FALSE, FORMAT JSON) ' + entry.query.sql, entry.query.params)).rows[0]['QUERY PLAN'][0];
        statements.push({ ordinal: statements.length, sqlSha256: digest(entry.query.sql), parameterSha256: digest(entry.query.params),
          parameterCount: entry.query.params.length, normalSqlMs: entry.normalSqlMs, normalReturnedRows: entry.rowCount, ...contentFreeUsagePlan(plan) });
      }
      result = { ordinal: results.length, caseSha256: digest(item), effectiveSliceSha256: effectiveKey, schoolIndex: item.schoolIndex,
        scope: item.scope, requestedDays: item.requestedDays, effectiveFrom: report.range.presentedFrom, effectiveTo: report.range.presentedTo,
        computedDays: report.range.computedDays, unavailableDays: report.range.unavailableDates.length, dataState: report.dataState,
        backendPid: role.pid, restrictedRoleVerified: true, tenantScopeVerified: true,
        heartbeatCount: report.totals.heartbeatCount, populated: report.totals.heartbeatCount > 0, normalServiceMs, statements };
      await client.query('COMMIT'); began = false;
    } catch (error) {
      failure = error;
      if (began) try { await client.query('ROLLBACK'); } catch { broken = true; }
    } finally {
      if (!before) broken = true;
      if (!broken) try {
        const after = (await client.query(scopeSql)).rows[0];
        assert.equal(after.role, before.role); assert.equal(after.database, before.database);
        assert.equal(normalize(after.school), normalize(before.school)); assert.equal(normalize(after.is_super), normalize(before.is_super));
      } catch (error) { broken = true; failure ??= error; }
      client.release(broken);
    }
    if (failure) throw failure;
    results.push(result);
  }
  return { schemaVersion: 1, kind: 'usage_report_cost_diagnostic', capacityAcceptance: false, source: request.source,
    schemaSha256: request.schemaSha256, profile: request.profile, runtimeRole, ...bindings, statementTimeoutMs: 15_000,
    requestedCases: cases.length, distinctEffectiveSlices: effective.size, cases: results,
    limitations: ['Normal service reads exclude HTTP authentication, admission, formatting and CSV audit',
      'EXPLAIN replays are warm diagnostics after the normal read; no cache was cleared',
      'Report evaluation uses the declared fixture school date; this is not live correctness evidence',
      'No performance threshold or capacity conclusion is inferred'] };
}
