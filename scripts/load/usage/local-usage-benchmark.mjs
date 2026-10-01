import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

export function assertLocalUsageFixture(env) {
  assert.equal(env.USAGE_LOCAL_BENCHMARK, '1', 'Explicit local benchmark opt-in required');
  assert.equal(env.NODE_ENV, 'test');
  const urls = [env.DATABASE_URL, env.ADMIN_DATABASE_URL].map(value => new URL(value));
  for (const url of urls) {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Loopback database only');
    assert.equal(url.port, '5435', 'Repository local Docker database only');
    assert.match(url.pathname, /^\/schoolpilot_redesign_usage_capacity_[a-f0-9]{12}$/);
  }
  assert.equal(urls[0].pathname, urls[1].pathname, 'Application and fixture database must match');
}

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, minMs: sorted[0], p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
}

const wall = date => date.toISOString().slice(0, 19).replace('T', ' ');
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export async function runLocalUsageBenchmark() {
  assertLocalUsageFixture(process.env);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const output = process.env.USAGE_BENCHMARK_OUTPUT;
  assert.ok(output, 'External evidence output required');
  const studentsCount = 500, uniquePerStudent = 1000, rawCount = studentsCount * uniquePerStudent * 2;
  const metrics = {
    version: 1, sourceRevision: process.env.USAGE_SOURCE_REVISION, startedAt: new Date().toISOString(),
    sourceHashes: Object.fromEntries(['src/services/classpilotUsageRollup.ts', 'src/services/classpilotUsageRead.ts', 'src/services/scheduler.ts', 'src/db/classpilotUsageRollupDaysMigration.ts', 'scripts/load/usage/local-usage-benchmark.mjs'].map(file => [file, sha256(resolve(root, file))])),
    topology: 'Local Windows Node driver and actual createApp HTTP server in one process; separate role-capped API/scheduler pools; local Docker PostgreSQL',
    dataset: { schools: 2, students: studentsCount, rawHeartbeats: rawCount, uniqueObservations: studentsCount * uniquePerStudent, samplesPerStudent: uniquePerStudent, duplicateFactor: 2, expiredHeartbeats: 50_000, aiDecisions: 10_000, officialClasses: 2 },
    limits: ['No production traffic, student data or cloud mutations.', 'Shared local process/DB has no production CPU/memory quota or RDS I/O guarantee.', 'This measures the actual one-day writer, HTTP read/export route and bounded retention SQL, not the whole hourly scheduler fleet, Redis or production capacity.'],
    productionReadiness: false, passed: false,
  };
  assert.match(metrics.sourceRevision, /^[a-f0-9]{40}$/);
  const admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2, statement_timeout: 120_000 });
  const worker = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, statement_timeout: 60_000, options: '-c app.is_super=on' });
  let server, appPool, sessionPool, sampler;
  const save = () => writeFileSync(output, JSON.stringify(metrics, null, 2));
  try {
    assert.equal((await admin.query('SELECT COUNT(*)::int AS count FROM schools')).rows[0].count, 0, 'Fresh empty schema-only fixture required');
    const role = (await worker.query('SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    const policies = await worker.query("SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname IN ('heartbeats','classpilot_usage_rollups','classpilot_usage_rollup_days') ORDER BY relname");
    assert.equal(policies.rows.length, 3); assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table));
    metrics.database = (await admin.query("SELECT version() AS version, current_setting('shared_buffers') AS shared_buffers, current_setting('work_mem') AS work_mem, current_setting('max_connections') AS max_connections")).rows[0];
    metrics.rls = { restrictedNonOwner: true, policies: policies.rows };
    const rollup = await import('../../../dist/services/classpilotUsageRollup.js');
    const time = await import('../../../dist/util/schoolTime.js');
    const { createApp } = await import('../../../dist/app.js');
    ({ pool: appPool, sessionPool } = await import('../../../dist/db.js'));
    const { signUserToken } = await import('../../../dist/services/jwt.js');
    const zone = 'America/New_York', today = time.localDateInTimeZone(new Date(), zone), date = time.addLocalDays(today, -2);
    const day = rollup.classpilotUsageRollupDay(date, zone);
    const schoolId = randomUUID(), canary = randomUUID(), staff = randomUUID(), teacher = randomUUID();
    const students = Array.from({ length: studentsCount }, () => randomUUID()), groups = [randomUUID(), randomUUID()], sessions = [randomUUID(), randomUUID()];
    const email = `benchmark-${staff}@example.test`;
    const seedStarted = performance.now();
    for (const [id, name] of [[schoolId, 'Synthetic Usage Capacity'], [canary, 'Synthetic Usage Canary']]) {
      await admin.query("INSERT INTO schools(id,name,domain,status,is_active,plan_status,school_timezone) VALUES($1,$2,'example.test','active',true,'active',$3)", [id, name, zone]);
      await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [id]);
      await admin.query("INSERT INTO settings(school_id,school_name,ws_shared_key,retention_hours,enable_tracking_hours,grade_levels) VALUES($1,$2,'synthetic','720',false,'{6}')", [id, name]);
    }
    for (const [id, address, roleName] of [[staff, email, 'school_admin'], [teacher, `teacher-${teacher}@example.test`, 'teacher']]) {
      await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Synthetic','Usage')", [id, address]);
      await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, roleName]);
    }
    // Exercise real authentication/entitlement before the expensive raw fixture.
    server = createServer(createApp()); await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const origin = `http://127.0.0.1:${server.address().port}/api/classpilot/admin/usage`;
    const token = signUserToken({ userId: staff, email, isSuperAdmin: false });
    const range = { from: time.addLocalDays(date, -1), to: time.addLocalDays(date, 1) };
    const get = async (scope = 'school', id, format = 'json') => {
      const query = new URLSearchParams({ scope, ...range, format }); if (id) query.set('id', id);
      const started = performance.now(), response = await fetch(`${origin}?${query}`, { headers: { Authorization: `Bearer ${token}`, 'X-School-Id': schoolId } });
      const payload = format === 'json' ? await response.json() : await response.text();
      assert.equal(response.status, 200, `Usage ${scope}/${format} status ${response.status}`);
      return { durationMs: performance.now() - started, payload, headers: response.headers };
    };
    assert.equal((await get()).payload.dataState, 'unavailable');
    await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status,grade_level) SELECT id,$2,'Synthetic','Usage','active','6' FROM unnest($1::text[]) id", [students, schoolId]);
    for (let index = 0; index < 2; index++) {
      await admin.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type) VALUES($1,$2,$3,$4,'admin_class')", [groups[index], schoolId, teacher, `Synthetic Class ${index + 1}`]);
      await admin.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time) VALUES($1,$2,$3,$4,$5::timestamp,$6::timestamp)", [sessions[index], schoolId, groups[index], teacher, wall(new Date(day.dayStartUtc.getTime() + 8 * 3600_000)), wall(new Date(day.dayStartUtc.getTime() + 15 * 3600_000))]);
      await admin.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) SELECT $1,$2,$3,id,$5::timestamptz FROM unnest($4::text[]) id", [schoolId, sessions[index], groups[index], students.slice(index * 250, (index + 1) * 250), new Date(day.dayStartUtc.getTime() + 8 * 3600_000).toISOString()]);
    }
    await admin.query(`INSERT INTO heartbeats(id,device_id,student_id,school_id,active_tab_title,active_tab_url,ai_category,teacher_intent_source,timestamp)
      SELECT 'synthetic-'||lpad(student.ordinality::text,4,'0')||'-'||lpad(sample.n::text,4,'0')||'-'||duplicate.n,
        'synthetic-device-'||duplicate.n,student.id,$2,'synthetic',
        CASE WHEN duplicate.n=1 THEN 'https://ignored.example.test/duplicate' WHEN sample.n%4=0 THEN 'https://ixl.com/lesson' WHEN sample.n%4=2 THEN 'https://unknown.example.test/' ELSE 'https://games.example.test/' END,
        CASE WHEN sample.n%4=0 THEN 'educational' WHEN sample.n%4=2 THEN NULL ELSE 'non-educational' END,
        CASE WHEN sample.n%4=3 THEN 'flight_path' ELSE NULL END,
        $3::timestamp + interval '8 hours' + sample.n * interval '20 seconds'
      FROM unnest($1::text[]) WITH ORDINALITY AS student(id,ordinality) CROSS JOIN generate_series(0,999) sample(n) CROSS JOIN generate_series(0,1) duplicate(n)`, [students, schoolId, wall(day.dayStartUtc)]);
    // Newest and older AI decisions exercise the real newest-decision join;
    // their final classification stays educational for the independent oracle.
    await admin.query(`INSERT INTO classpilot_ai_decisions(school_id,student_id,heartbeat_id,category,created_at)
      SELECT $1,student_id,id,CASE WHEN version.n=1 THEN 'educational' ELSE 'non-educational' END,timestamp+version.n*interval '1 second'
      FROM heartbeats CROSS JOIN generate_series(0,1) version(n) WHERE school_id=$1 AND id LIKE '%-0' AND substring(id from 16 for 4)::int%100=0`, [schoolId]);
    await admin.query(`INSERT INTO heartbeats(device_id,school_id,student_id,active_tab_title,active_tab_url,timestamp)
      SELECT 'synthetic-expired',$1,$2,'synthetic','https://old.example.test/',now()-interval '40 days'+n*interval '1 second' FROM generate_series(1,50000) n`, [schoolId, students[0]]);
    await admin.query("INSERT INTO heartbeats(device_id,school_id,active_tab_title,active_tab_url,timestamp) VALUES('synthetic-canary',$1,'synthetic','https://canary.example.test/',$2::timestamp)", [canary, wall(new Date(day.dayStartUtc.getTime() + 8 * 3600_000))]);
    await admin.query('ANALYZE');
    metrics.seedMs = performance.now() - seedStarted;
    const counts = await admin.query('SELECT (SELECT COUNT(*) FROM heartbeats WHERE school_id=$1 AND timestamp >= $2::timestamp)::int AS heartbeats,(SELECT COUNT(*) FROM classpilot_ai_decisions WHERE school_id=$1)::int AS decisions', [schoolId, wall(day.dayStartUtc)]);
    assert.equal(counts.rows[0].heartbeats, rawCount); assert.equal(counts.rows[0].decisions, 10_000);
    metrics.indexes = (await admin.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE tablename IN ('heartbeats','classpilot_usage_rollups','classpilot_usage_rollup_days','classpilot_ai_decisions','classpilot_session_students') ORDER BY tablename,indexname")).rows;
    const beforeDb = (await admin.query('SELECT blks_read,blks_hit,temp_files,temp_bytes,tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted FROM pg_stat_database WHERE datname=current_database()')).rows[0];
    metrics.poolMax = { api: appPool.options.max, scheduler: worker.options.max, mainWaiting: 0, schedulerWaiting: 0 };
    metrics.peakRssBytes = process.memoryUsage().rss;
    sampler = setInterval(() => { metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss); metrics.poolMax.mainWaiting = Math.max(metrics.poolMax.mainWaiting, appPool.waitingCount); metrics.poolMax.schedulerWaiting = Math.max(metrics.poolMax.schedulerWaiting, worker.waitingCount); }, 20); sampler.unref();
    const cpu = process.cpuUsage();
    const initialStarted = performance.now();
    const first = await rollup.rollupClasspilotUsageDay(worker, { schoolId, day, windowEndUtc: new Date(day.dayStartUtc.getTime() + 14 * 3600_000), exclusions: [] });
    metrics.liveRewrite = { durationMs: performance.now() - initialStarted, ...first };
    assert.equal(first.seconds, 7_500_000); assert.equal(first.heartbeatCount, 500_000);
    const expected = { school: 7_500_000, grade: 7_500_000, class: 3_750_000, student: 15_000 };
    const ids = { school: undefined, grade: '6', class: groups[0], student: students[0] };
    metrics.reads = {};
    for (const scope of Object.keys(expected)) {
      const timings = [];
      for (let repeat = 0; repeat < 8; repeat++) {
        const read = await get(scope, ids[scope]); assert.equal(read.payload.totals.monitoredBrowserSeconds, expected[scope]); assert.equal(read.payload.range.computedDays, 1); assert.equal(read.payload.range.unavailableDates.length, 2); timings.push(read.durationMs);
        assert.equal(read.payload.totals.instructionalSeconds, expected[scope] / 2); assert.equal(read.payload.totals.offTaskSeconds, expected[scope] / 4); assert.equal(read.payload.totals.unknownSeconds, expected[scope] / 4);
      }
      metrics.reads[scope] = summarize(timings);
    }
    const csv = await get('school', undefined, 'csv'); assert.match(csv.payload, /Monitored Browser Time/); assert.equal(csv.headers.get('cache-control'), 'no-store, private');
    assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [schoolId])).rows[0].count, 1);
    metrics.export = { durationMs: csv.durationMs, bytes: Buffer.byteLength(csv.payload), strictAuditRecorded: true };
    // Snapshot reads overlap the actual final-day replacement transaction.
    const concurrentStarted = performance.now();
    const rewrite = rollup.rollupClasspilotUsageDay(worker, { schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
    const loaded = await Promise.all(Array.from({ length: 32 }, async () => { const read = await get(); assert.equal(read.payload.totals.monitoredBrowserSeconds, expected.school); return read.durationMs; }));
    const final = await rewrite;
    metrics.finalRewriteWithReads = { durationMs: performance.now() - concurrentStarted, ...final, concurrentReads: summarize(loaded) };
    const empty = rollup.classpilotUsageRollupDay(time.addLocalDays(date, 1), zone);
    await rollup.rollupClasspilotUsageDay(worker, { schoolId, day: empty, windowEndUtc: empty.dayEndUtc, exclusions: [] });
    const completed = await get(); assert.equal(completed.payload.range.computedDays, 2); assert.equal(completed.payload.byDay[1].monitoredBrowserSeconds, 0); assert.equal(completed.payload.range.unavailableDates.length, 1); assert.equal(completed.payload.dataState, 'final');
    const canaryToken = signUserToken({ userId: staff, email, isSuperAdmin: false });
    const forbidden = await fetch(`${origin}?scope=school&${new URLSearchParams(range)}`, { headers: { Authorization: `Bearer ${canaryToken}`, 'X-School-Id': canary } }); assert.equal(forbidden.status, 403); await forbidden.text();
    metrics.correctness = { exactIndependentTotals: true, deterministicDedup: true, teacherIntentExemption: true, frozenOfficialClassAttribution: true, newestAiDecision: true, successfulEmptyDay: true, internalGapWithheld: true, crossSchoolDenied: true, snapshotReadsDuringAtomicRewrite: true };
    const planClient = await worker.connect();
    try {
      await planClient.query('BEGIN'); await planClient.query(rollup.CLASSPILOT_USAGE_ROLLUP_DELETE_SQL, [schoolId, date]);
      const plan = await planClient.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${rollup.CLASSPILOT_USAGE_ROLLUP_INSERT_SQL}`, [schoolId, wall(day.dayStartUtc), wall(day.dayEndUtc), date, '[]']);
      metrics.rollupExplain = plan.rows[0]['QUERY PLAN'];
    } finally { await planClient.query('ROLLBACK'); planClient.release(); }
    const readPlanClient = await worker.connect();
    try {
      metrics.representativeDayGroupingExplain = (await readPlanClient.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT usage_date,SUM(seconds),COUNT(DISTINCT student_id) FROM classpilot_usage_rollups rollup JOIN classpilot_usage_rollup_days day USING(school_id,usage_date) WHERE school_id=$1 AND usage_date BETWEEN $2::date AND $3::date GROUP BY usage_date`, [schoolId, range.from, range.to])).rows[0]['QUERY PLAN'];
    } finally { readPlanClient.release(); }
    const retentionStart = performance.now();
    let removed = 0, batches = 0;
    do {
      // Same bounded heartbeat deletion form as purgeExpiredHeartbeats.
      const result = await worker.query(`DELETE FROM heartbeats WHERE id IN (SELECT id FROM heartbeats WHERE school_id=$1 AND timestamp < $2::timestamp LIMIT 5000)`, [schoolId, wall(new Date(day.dayStartUtc.getTime() - 30 * 86400_000))]);
      if (result.rowCount > 0) await new Promise(done => setTimeout(done, 100));
      removed += result.rowCount; batches++; if (result.rowCount < 5000) break;
    } while (batches <= 11);
    assert.equal(removed, 50_000);
    const sql = 'WITH removed AS (DELETE FROM classpilot_usage_rollups WHERE school_id = $1 AND usage_date < $2::date) DELETE FROM classpilot_usage_rollup_days WHERE school_id = $1 AND usage_date < $2::date';
    const cleanup = await worker.query(sql, [schoolId, time.addLocalDays(date, 2)]);
    assert.ok(cleanup.rowCount >= 1, 'The successful empty-day ledger must be removed explicitly');
    assert.equal((await worker.query('SELECT COUNT(*)::int AS count FROM classpilot_usage_rollup_days WHERE school_id=$1', [schoolId])).rows[0].count, 0);
    metrics.retention = { durationMs: performance.now() - retentionStart, expiredHeartbeatsRemoved: removed, batches, aggregateAndEmptyLedgerCleared: true, sqlMatchesScheduler: readFileSync(resolve(root, 'src/services/scheduler.ts'), 'utf8').includes(sql) };
    assert.equal(metrics.retention.sqlMatchesScheduler, true);
    const afterDb = (await admin.query('SELECT blks_read,blks_hit,temp_files,temp_bytes,tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted FROM pg_stat_database WHERE datname=current_database()')).rows[0];
    metrics.databaseCountersDelta = Object.fromEntries(Object.keys(beforeDb).map(key => [key, Number(afterDb[key]) - Number(beforeDb[key])]));
    metrics.databaseBytes = Number((await admin.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
    metrics.cpuMicroseconds = process.cpuUsage(cpu);
    metrics.finishedAt = new Date().toISOString(); metrics.passed = true; save();
    console.log(JSON.stringify({ event: 'local_usage_benchmark_complete', sourceRevision: metrics.sourceRevision, rawHeartbeats: rawCount, liveRewriteMs: metrics.liveRewrite.durationMs, finalRewriteMs: metrics.finalRewriteWithReads.durationMs, readP95Ms: Object.fromEntries(Object.entries(metrics.reads).map(([scope, data]) => [scope, data.p95Ms])), retentionMs: metrics.retention.durationMs, productionReadiness: false }));
  } catch (error) { metrics.failure = { name: error.name, code: error.code || 'BENCHMARK_ASSERTION', message: error.message }; save(); throw error; }
  finally {
    clearInterval(sampler); server?.closeAllConnections(); if (server) await new Promise(done => server.close(done));
    await Promise.allSettled([appPool?.end(), sessionPool?.end(), worker.end(), admin.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runLocalUsageBenchmark().catch(error => { console.error(JSON.stringify({ event: 'local_usage_benchmark_failed', name: error.name, code: error.code || 'BENCHMARK_ASSERTION', message: error.message })); process.exitCode = 1; });
}
