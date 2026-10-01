import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import pg from 'pg';
import { summarize } from './local-usage-benchmark.mjs';

export function assertLocalScaleFixture(env) {
  assert.equal(env.USAGE_LOCAL_SCALE, '1'); assert.equal(env.NODE_ENV, 'test');
  assert.match(env.USAGE_SCALE_CONTAINER, /^schoolpilot-usage-scale-[a-f0-9]{12}$/);
  const urls = [env.DATABASE_URL, env.ADMIN_DATABASE_URL].map(value => new URL(value));
  for (const url of urls) {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.port, '5437');
    assert.match(url.pathname, /^\/schoolpilot_redesign_usage_scale_[a-f0-9]{12}$/);
  }
  assert.equal(urls[0].pathname, urls[1].pathname);
  assert.equal(urls[0].pathname.slice(-12), env.USAGE_SCALE_CONTAINER.slice(-12));
}

const wall = value => value.toISOString().replace('T', ' ').replace('Z', '');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export const currentObservationCutoff = (now = Date.now()) => new Date(Math.floor(now / 1000) * 1000);

export function usageAttributionDiagnosticSql(statement) {
  const marker = ',\ninserted AS (';
  const boundary = statement.indexOf(marker);
  assert.ok(boundary > 0 && statement.indexOf(marker, boundary + 1) === -1, 'Expected one aggregate insertion boundary');
  const prefix = statement.slice(0, boundary);
  const sql = prefix + (prefix.includes('\ngrains AS (')
    ? ` SELECT $4::date AS usage_date,COUNT(*)::bigint AS rows,SUM(seconds) AS seconds,SUM(heartbeat_count) AS heartbeats FROM grains`
    : `, grain AS (SELECT student_id,class_id,session_id,domain,classification,
        ROUND(SUM(GREATEST(attributed_seconds,0)))::int AS seconds,COUNT(*)::int AS heartbeats
        FROM attributed GROUP BY student_id,class_id,session_id,domain,classification)
      SELECT $4::date AS usage_date,COUNT(*)::bigint AS rows,SUM(seconds) AS seconds,SUM(heartbeats) AS heartbeats FROM grain`);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY|DO)\b/i, 'Attribution diagnostic must remain read-only');
  return sql;
}

export function apiStatementKind(text) {
  if (text.includes('GROUPING SETS')) return 'usageReport';
  if (/\bclasspilot_usage_rollup_days\b/.test(text)) return 'usageCoverage';
  if (/\bclasspilot_usage_rollups\b/.test(text)) return 'usageRows';
  if (/\baudit_logs\b/.test(text)) return 'audit';
  if (/\bheartbeats\b/.test(text)) return 'heartbeat';
  if (/\bsettings\b/.test(text)) return 'settings';
  if (/\bschool_memberships\b/.test(text)) return 'membership';
  if (/\bstudents\b/.test(text)) return 'studentDirectory';
  if (/\bdevices\b/.test(text)) return 'device';
  if (/\bteaching_sessions\b/.test(text)) return 'teachingSession';
  if (/\bschools\b/.test(text)) return 'school';
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SET|SELECT set_config)\b/i.test(text)) return 'transaction';
  return 'other';
}

// A separate small oracle over raw current-day observations. It intentionally
// does not use the application's SQL, classifications or aggregate rows.
export function currentObservationSeconds(rows, cutoff) {
  const timelines = new Map();
  for (const row of rows) {
    const at = new Date(row.timestamp).getTime();
    if (at >= cutoff.getTime()) continue;
    const timeline = timelines.get(row.student_id) || new Map();
    timeline.set(Math.floor(at / 1000), Math.min(at, timeline.get(Math.floor(at / 1000)) ?? Infinity));
    timelines.set(row.student_id, timeline);
  }
  return new Map([...timelines].map(([student, timeline]) => {
    const times = [...timeline.values()].sort((a, b) => a - b);
    const seconds = times.reduce((sum, at, index) => sum + Math.max(0, Math.min(15, ((times[index + 1] ?? cutoff.getTime()) - at) / 1000)), 0);
    return [student, Math.round(seconds)];
  }));
}

// Preserve pg's callback and Promise overloads while measuring actual API SQL
// and checkout time. Never retain statement text, parameters or credentials.
export function measureCall(target, name, record) {
  const original = target[name].bind(target);
  target[name] = (...args) => {
    const started = performance.now();
    const done = error => record(performance.now() - started, error, args[0]);
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === 'function') {
      const callback = args[callbackIndex];
      args[callbackIndex] = (...values) => { done(values[0]); callback(...values); };
      try { return original(...args); } catch (error) { done(error); throw error; }
    }
    try { return original(...args).then(value => { done(); return value; }, error => { done(error); throw error; }); }
    catch (error) { done(error); throw error; }
  };
}

export async function runLocalScale() {
  assertLocalScaleFixture(process.env);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const output = process.env.USAGE_SCALE_OUTPUT; assert.ok(output);
  const caps = JSON.parse(readFileSync(process.env.USAGE_SCALE_CAPS, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(caps.NanoCpus, 4_000_000_000); assert.equal(caps.Memory, 4_294_967_296);
  assert.ok(getHeapStatistics().heap_size_limit <= 600 * 1024 ** 2, 'Node512MiB V8 heap cap required');
  const metrics = { version: 1, sourceRevision: process.env.USAGE_SOURCE_REVISION, startedAt: new Date().toISOString(), passed: false,
    productionReadiness: false, profile: { postgresCpus: 4, postgresMemoryBytes: caps.Memory, nodeV8OldSpaceMiB: 512, nodeHeapLimitBytes: getHeapStatistics().heap_size_limit,
      apiStatementDeadlineMs: 15_000, apiAcquisitionDeadlineMs: 5_000, workerStatementDeadlineMs: 60_000, workerAcquisitionDeadlineMs: 10_000 },
    sourceHashes: Object.fromEntries(['src/services/classpilotUsageRollup.ts', 'src/services/classpilotUsageRead.ts', 'src/routes/classpilot/devices.ts', 'scripts/load/usage/local-usage-scale.mjs', 'scripts/load/usage/reference-attribution-20260930.sql'].map(file => [file, hash(resolve(root, file))])),
    limitations: ['Local DockerCPU/memory caps do not represent RDS I/O.', 'Node heap cap is not a Windows CPU or total RSS quota.', 'The hourly scheduler fleet, preceding heavy jobs, Redis distribution, managed devices and production rollout remain unverified.'],
    writerQueries: [], reads: {}, readFailures: [], apiDatabase: { acquisitions: { count: 0, failures: 0, maxMs: 0 }, statements: {} },
    ingest: { requests: 0, insertedHeartbeats: 0, bySchool: {}, timingsMs: [], statuses: {} }, peakRssBytes: process.memoryUsage().rss };
  assert.match(metrics.sourceRevision, /^[a-f0-9]{40}$/);
  const save = () => writeFileSync(output, JSON.stringify(metrics, null, 2));
  const admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2, statement_timeout: 120_000 });
  const worker = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000, statement_timeout: 60_000, options: '-c app.is_super=on' });
  let server, appPool, sessionPool, sampler, ingestRunning = false, ingestion = [], readTimings, phaseStarted, concurrentMeasurement = false;
  const wrapped = new WeakSet(), connect = worker.connect.bind(worker);
  const measuredWorker = { connect: async () => {
    const client = await connect();
    if (!wrapped.has(client)) {
      wrapped.add(client); const query = client.query.bind(client);
      client.query = async (...args) => {
        const started = performance.now();
        try { return await query(...args); }
        finally { if (typeof args[0] === 'string' && args[0].includes('\ninserted AS (\n  INSERT INTO classpilot_usage_rollups')) metrics.writerQueries.push({ durationMs: performance.now() - started, schoolId: args[1]?.[0] }); }
      };
    }
    return client;
  } };
  try {
    assert.equal((await admin.query('SELECT COUNT(*)::int AS count FROM schools')).rows[0].count, 0);
    const role = (await worker.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    metrics.rls = (await worker.query("SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname IN ('heartbeats','classpilot_usage_rollups','classpilot_usage_rollup_days') ORDER BY relname")).rows;
    assert.equal(metrics.rls.length, 3); assert.ok(metrics.rls.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table));
    metrics.database = (await admin.query("SELECT version(),current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem,current_setting('max_connections') AS max_connections")).rows[0];
    const rollup = await import('../../../dist/services/classpilotUsageRollup.js');
    const time = await import('../../../dist/util/schoolTime.js');
    const { createApp } = await import('../../../dist/app.js');
    ({ pool: appPool, sessionPool } = await import('../../../dist/db.js'));
    const record = (target, durationMs, error) => {
      if (!concurrentMeasurement) return;
      target.count++; target.maxMs = Math.max(target.maxMs, durationMs); if (error) target.failures++;
      if (error) {
        const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'UNKNOWN';
        target.failureCodes ??= {}; target.failureCodes[code] = (target.failureCodes[code] || 0) + 1;
      }
    };
    measureCall(appPool, 'connect', (durationMs, error) => record(metrics.apiDatabase.acquisitions, durationMs, error));
    appPool.on('connect', client => measureCall(client, 'query', (durationMs, error, input) => {
      const text = typeof input === 'string' ? input : input?.text || '';
      const kind = apiStatementKind(text);
      const target = metrics.apiDatabase.statements[kind] ??= { count: 0, failures: 0, maxMs: 0 };
      record(target, durationMs, error);
    }));
    const { signUserToken } = await import('../../../dist/services/jwt.js');
    const { createStudentToken } = await import('../../../dist/services/deviceJwt.js');
    const { flushHeartbeatClassificationBatches } = await import('../../../dist/services/heartbeatClassificationBatcher.js');
    const zone = 'America/New_York', today = time.localDateInTimeZone(new Date(), zone);
    const heavyDate = time.addLocalDays(today, -2), emptyDate = time.addLocalDays(today, -3), gapDate = time.addLocalDays(today, -5);
    const day = rollup.classpilotUsageRollupDay(heavyDate, zone);
    const retained = time.addLocalDays(today, -364), range = { from: time.addLocalDays(today, -365), to: today };
    const historyDates = Array.from({ length: 364 }, (_, i) => time.addLocalDays(retained, i)).filter(date => ![heavyDate, emptyDate, gapDate].includes(date));
    const schools = Array.from({ length: 2 }, (_, index) => ({ index, id: randomUUID(), staff: randomUUID(), teachers: Array.from({ length: 100 }, () => randomUUID()),
      students: Array.from({ length: 500 }, () => randomUUID()), groups: Array.from({ length: 100 }, () => randomUUID()), devices: Array.from({ length: 500 }, () => `synthetic-scale-${randomUUID()}`),
      studentSessions: Array.from({ length: 500 }, () => randomUUID()) }));
    metrics.dataset = { substantialSchools: 2, studentsPerSchool: 500, rawHeavyDayPerSchool: 1_000_000, uniqueHeavyDayPerSchool: 500_000,
      officialClassesPerSchool: 100, historicalDenseDays: historyDates.length, historicalRowsPerSchool: historyDates.length * 500 * 3,
      requestedInclusiveDays: 366, retainedInclusiveDays: 365, successfulEmptyDate: emptyDate, unavailableDate: gapDate, heavyDate, today, dateRange: range };
    server = createServer(createApp()); await new Promise(done => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}/api/classpilot`;
    const get = async (school, scope, format = 'json', customRange = range, customId) => {
      const id = customId ?? ({ grade: '6', class: school.groups[0], student: school.students[0] })[scope];
      const query = new URLSearchParams({ scope, format, ...customRange }); if (id) query.set('id', id);
      const started = performance.now(), response = await fetch(`${base}/admin/usage?${query}`, { headers: { Authorization: `Bearer ${school.token}`, 'X-School-Id': school.id } });
      const body = format === 'json' ? await response.json() : await response.text();
      return { status: response.status, body, durationMs: performance.now() - started, headers: response.headers };
    };
    const ingestOne = async (school, index) => {
      const started = performance.now();
      const response = await fetch(`${base}/device/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${school.deviceTokens[index]}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientProtocolVersion: 3, extensionVersion: '2.10.0', capabilities: [], activeTabUrl: 'https://ixl.com/lesson', activeTabTitle: 'Synthetic current scope' }) });
      await response.text(); metrics.ingest.requests++; metrics.ingest.timingsMs.push(performance.now() - started);
      metrics.ingest.bySchool[school.index] = (metrics.ingest.bySchool[school.index] || 0) + 1;
      metrics.ingest.statuses[response.status] = (metrics.ingest.statuses[response.status] || 0) + 1;
      assert.ok(response.status === 200 || response.status === 204, `Synthetic heartbeat status ${response.status}`);
    };
    const seedStarted = performance.now();
    for (const school of schools) {
      await admin.query("INSERT INTO schools(id,name,domain,status,is_active,plan_status,school_timezone) VALUES($1,$2,'example.test','active',true,'active',$3)", [school.id, `Synthetic Scale ${school.index}`, zone]);
      await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [school.id]);
      await admin.query("INSERT INTO settings(school_id,school_name,ws_shared_key,retention_hours,enable_tracking_hours,grade_levels) VALUES($1,'Synthetic Scale','synthetic','8760',false,'{6,7,8,9,10}')", [school.id]);
      school.email = `scale-${school.staff}@example.test`;
      await admin.query("INSERT INTO users(id,email,first_name,last_name) SELECT id,'scale-'||id||'@example.test','Synthetic','Scale' FROM unnest($1::text[]) id", [[school.staff, ...school.teachers]]);
      await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) SELECT $1,id,CASE WHEN id=$2 THEN 'school_admin' ELSE 'teacher' END,'active' FROM unnest($3::text[]) id", [school.id, school.staff, [school.staff, ...school.teachers]]);
      await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status,grade_level,email) SELECT id,$2,'Synthetic','Scale','active',(6+(ordinality-1)%5)::text,'scale-'||id||'@example.test' FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality)", [school.students, school.id]);
      await admin.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type) SELECT id,$2,($3::text[])[ordinality::int],'Synthetic Class '||ordinality,'admin_class' FROM unnest($1::text[]) WITH ORDINALITY class(id,ordinality)", [school.groups, school.id, school.teachers]);
      await admin.query("INSERT INTO group_students(student_id,group_id) SELECT id,($2::text[])[((ordinality-1)/5)::int+1] FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality)", [school.students, school.groups]);
      await admin.query("INSERT INTO devices(device_id,school_id,class_id) SELECT id,$2,($3::text[])[((ordinality-1)/5)::int+1] FROM unnest($1::text[]) WITH ORDINALITY device(id,ordinality)", [school.devices, school.id, school.groups]);
      await admin.query("INSERT INTO student_sessions(id,student_id,device_id,auth_kind,is_active) SELECT id,($2::text[])[ordinality::int],($3::text[])[ordinality::int],'managed_profile',true FROM unnest($1::text[]) WITH ORDINALITY session(id,ordinality)", [school.studentSessions, school.students, school.devices]);
      school.token = signUserToken({ userId: school.staff, email: school.email, isSuperAdmin: false });
      school.deviceTokens = school.students.map((studentId, i) => createStudentToken({ studentId, schoolId: school.id, deviceId: school.devices[i], sessionId: school.studentSessions[i], studentEmail: `scale-${studentId}@example.test` }));
      assert.equal((await get(school, 'school')).status, 200);
      await ingestOne(school, 0);
      console.log(JSON.stringify({ event: 'local_usage_scale_auth_preflight', schoolIndex: school.index }));
      // Ten nonoverlapping heavy-day windows per class; each observation has
      // exactly one frozen official class/session. Large historical/current
      // scope inventories remain present while the real writer selects its day.
      for (const dates of [historyDates, [heavyDate], [today]]) {
        const sessions = dates.flatMap(date => school.groups.flatMap((group, i) => Array.from({ length: date === heavyDate ? 10 : 1 }, (_, window) => ({ id: randomUUID(), group, teacher: school.teachers[i], date, window, index: i }))));
        for (let offset = 0; offset < sessions.length; offset += 2000) {
          const rows = sessions.slice(offset, offset + 2000).map(session => {
            const start = session.date === today ? new Date(Date.now() - 3600_000) : new Date(time.localDateStartUtc(session.date, zone).getTime() + 8 * 3600_000 + session.window * 2000_000);
            return { ...session, start: wall(start), end: session.date === today ? null : wall(new Date(start.getTime() + (session.date === heavyDate ? 2000_000 : 7 * 3600_000))) };
          });
          await admin.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time) SELECT id,$1,\"group\",teacher,start::timestamp,\"end\"::timestamp FROM jsonb_to_recordset($2::jsonb) AS item(id text,\"group\" text,teacher text,start text,\"end\" text)", [school.id, JSON.stringify(rows)]);
          await admin.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) SELECT $1,item.id,item.\"group\",($3::text[])[item.index*5+member.n+1],item.start::timestamptz FROM jsonb_to_recordset($2::jsonb) AS item(id text,\"group\" text,index int,start text) CROSS JOIN generate_series(0,4) member(n)", [school.id, JSON.stringify(rows), school.students]);
        }
      }
      // Finished history is a reader-cardinality fixture, not a claim of
      // replaying a full year of raw heartbeats through the writer.
      for (let offset = 0; offset < historyDates.length; offset += 30) {
        await admin.query(`INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,class_id,domain,classification,seconds,heartbeat_count)
          SELECT $1,date::date,student.id,($4::text[])[((ordinality-1)/5)::int+1],'history-'||((ordinality-1)%200)||'.example.test',category,30,1
          FROM unnest($2::text[]) date CROSS JOIN unnest($3::text[]) WITH ORDINALITY student(id,ordinality) CROSS JOIN unnest('{educational,non-educational,unknown}'::text[]) category`, [school.id, historyDates.slice(offset, offset + 30), school.students, school.groups]);
      }
      const coverageDates = [...historyDates, emptyDate];
      await admin.query(`INSERT INTO classpilot_usage_rollup_days(school_id,usage_date,day_start_at,day_end_at,processed_through,is_final)
        SELECT $1,date::date,date::date::timestamp AT TIME ZONE $3,(date::date+1)::timestamp AT TIME ZONE $3,(date::date+1)::timestamp AT TIME ZONE $3,true FROM unnest($2::text[]) date`, [school.id, coverageDates, zone]);
      await admin.query(`INSERT INTO heartbeats(id,device_id,student_id,school_id,active_tab_title,active_tab_url,ai_category,teacher_intent_source,timestamp)
        SELECT 'scale-'||$4||'-'||lpad(student.ordinality::text,4,'0')||'-'||lpad(sample.n::text,4,'0')||'-'||duplicate.n,
          'synthetic-old-'||duplicate.n,student.id,$2,'synthetic','https://lesson-'||(sample.n%200)||'.example.test/',
          CASE WHEN sample.n%4=0 THEN 'educational' WHEN sample.n%4=2 THEN NULL ELSE 'non-educational' END,CASE WHEN sample.n%4=3 THEN 'flight_path' ELSE NULL END,
          $3::timestamp+interval '8 hours'+sample.n*interval '20 seconds'
        FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality) CROSS JOIN generate_series(0,999) sample(n) CROSS JOIN generate_series(0,1) duplicate(n)`, [school.students, school.id, wall(day.dayStartUtc), school.index]);
      console.log(JSON.stringify({ event: 'local_usage_scale_school_seeded', schoolIndex: school.index }));
    }
    await admin.query('ANALYZE'); metrics.seedMs = performance.now() - seedStarted;
    metrics.fixtureCounts = (await admin.query('SELECT id AS school_id,(SELECT COUNT(*) FROM heartbeats WHERE school_id=schools.id) AS raw,(SELECT COUNT(*) FROM teaching_sessions WHERE school_id=schools.id) AS sessions,(SELECT COUNT(*) FROM classpilot_session_students WHERE school_id=schools.id) AS frozen_roster_rows,(SELECT COUNT(*) FROM classpilot_usage_rollups WHERE school_id=schools.id) AS aggregates FROM schools')).rows;
    assert.ok(metrics.fixtureCounts.every(row => Number(row.raw) === 1_000_001 && Number(row.aggregates) === metrics.dataset.historicalRowsPerSchool));
    if (process.env.USAGE_SCALE_PREPARE_ONLY === '1') {
      metrics.fixturePreparationOnly = true; save();
      console.log(JSON.stringify({ event: 'local_usage_scale_prepared', sourceRevision: metrics.sourceRevision, capacityMeasured: false }));
      return;
    }
    const size = scope => ({ school: 500, grade: 100, class: 5, student: 1 })[scope];
    const checkReport = (read, scope, allowHeavy = false) => {
      assert.equal(read.status, 200); assert.equal(read.body.range.retentionDays, 365); assert.equal(read.body.range.requestedDays, 365); assert.equal(read.body.range.partiallyExpired, true);
      const heavy = read.body.byDay.find(row => row.date === heavyDate);
      if (!allowHeavy) assert.ok(heavy);
      const n = size(scope), baseSeconds = historyDates.length * 90 * n;
      assert.equal(read.body.totals.monitoredBrowserSeconds, baseSeconds + (heavy ? 15000 * n : 0));
      assert.equal(read.body.totals.instructionalSeconds, historyDates.length * 30 * n + (heavy ? 7500 * n : 0));
      assert.equal(read.body.totals.offTaskSeconds, historyDates.length * 30 * n + (heavy ? 3750 * n : 0));
      assert.equal(read.body.totals.unknownSeconds, historyDates.length * 30 * n + (heavy ? 3750 * n : 0));
      assert.equal(read.body.range.computedDays, historyDates.length + 1 + (heavy ? 1 : 0));
      assert.equal(read.body.byDay.find(row => row.date === emptyDate).monitoredBrowserSeconds, 0);
      assert.equal(read.body.byDay.some(row => row.date === gapDate), false);
      assert.equal(read.body.range.unavailableDates.includes(gapDate), true);
      for (const date of historyDates) {
        const row = read.body.byDay.find(row => row.date === date); assert.ok(row);
        assert.equal(row.monitoredBrowserSeconds, 90 * n); assert.equal(row.instructionalSeconds, 30 * n);
        assert.equal(row.offTaskSeconds, 30 * n); assert.equal(row.unknownSeconds, 30 * n); assert.equal(row.state, 'final');
      }
      assert.equal(read.body.byDay.some(row => row.date === range.from), false);
      return read;
    };
    // Validate the product's real maximum range and actual device auth before
    // launching expensive writers. A 367-day range must remain rejected.
    for (const school of schools) {
      assert.equal((await get(school, 'school')).status, 200);
      assert.equal((await get(school, 'school', 'json', { ...range, from: time.addLocalDays(range.from, -1) })).status, 400);
      await ingestOne(school, 0);
      const other = schools[1 - school.index];
      assert.equal((await get(school, 'class', 'json', range, other.groups[0])).status, 404);
      assert.equal((await get(school, 'student', 'json', range, other.students[0])).status, 404);
    }
    metrics.poolMax = { api: appPool.options.max, worker: worker.options.max, apiWaitingPeak: 0, workerWaitingPeak: 0 };
    sampler = setInterval(() => { metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.memoryUsage().rss); metrics.poolMax.apiWaitingPeak = Math.max(metrics.poolMax.apiWaitingPeak, appPool.waitingCount); metrics.poolMax.workerWaitingPeak = Math.max(metrics.poolMax.workerWaitingPeak, worker.waitingCount); }, 20); sampler.unref();
    const beforeStats = (await admin.query('SELECT temp_bytes,temp_files,blks_read,blks_hit FROM pg_stat_database WHERE datname=current_database()')).rows[0];
    const started = performance.now(), ingestDeadline = started + 60_000; phaseStarted = started; ingestRunning = true; concurrentMeasurement = true; let nextDevice = 1;
    ingestion = Array.from({ length: 4 }, async () => {
      while (ingestRunning && performance.now() < ingestDeadline) {
        const sequence = nextDevice++; await ingestOne(schools[sequence % 2], Math.floor(sequence / 2) % 500); await sleep(50);
      }
    });
    // Both substantial schools aggregate at the same time as live HTTP ingest
    // and long-range reads. Snapshot totals may show either full old coverage
    // or the full committed heavy day; never partial aggregate/completion data.
    const writes = schools.map(async school => {
      const started = performance.now(), result = await rollup.rollupClasspilotUsageDay(measuredWorker, { schoolId: school.id, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
      assert.equal(result.seconds, 7_500_000); assert.equal(result.heartbeatCount, 500_000);
      return { schoolIndex: school.index, durationMs: performance.now() - started, ...result };
    });
    const requestScopes = schools.flatMap(school => ['school', 'grade', 'class', 'student'].map(scope => ({ school, scope })));
    readTimings = new Map(requestScopes.map(({ school, scope }) => [`${school.index}/${scope}`, []]));
    const readers = (async () => {
      let failure;
      for (let wave = 0; wave < 4; wave++) {
        const results = await Promise.allSettled(requestScopes.flatMap(({ school, scope }) => Array.from({ length: 2 }, async () => {
          const read = await get(school, scope);
          try { checkReport(read, scope, true); readTimings.get(`${school.index}/${scope}`).push(read.durationMs); }
          catch (error) { metrics.readFailures.push({ schoolIndex: school.index, scope, status: read.status, durationMs: read.durationMs, code: read.body?.code ?? error.code }); throw error; }
        })));
        failure ??= results.find(result => result.status === 'rejected')?.reason;
        await sleep(500);
      }
      if (failure) throw failure;
    })();
    const outcomes = await Promise.allSettled([...writes, readers, ...ingestion]);
    ingestRunning = false; concurrentMeasurement = false;
    metrics.concurrentPhaseMs = performance.now() - started;
    metrics.reads = Object.fromEntries([...readTimings].filter(([, timings]) => timings.length).map(([key, timings]) => [key, summarize(timings)]));
    metrics.phaseOutcomes = outcomes.map((outcome, index) => ({ kind: index < 2 ? 'writer' : index === 2 ? 'read_waves' : 'ingest', status: outcome.status,
      ...(outcome.status === 'rejected' ? { error: { name: outcome.reason.name, code: outcome.reason.code || 'SCALE_ASSERTION', message: outcome.reason.message } } : {}) }));
    const failedPhase = outcomes.find(outcome => outcome.status === 'rejected');
    metrics.concurrentWriters = outcomes.slice(0, 2).filter(result => result.status === 'fulfilled').map(result => result.value);
    metrics.reads = Object.fromEntries([...readTimings].map(([key, timings]) => [key, summarize(timings)]));
    // A bounded, read-only plan isolates attribution/grouping from aggregate
    // insertion/index/FK work. Collect before later diagnostic assertions, so
    // an unrelated oracle failure cannot hide the expensive query's evidence.
    const attributedSql = usageAttributionDiagnosticSql(rollup.CLASSPILOT_USAGE_ROLLUP_INSERT_SQL);
    try {
      metrics.attributionPlan = (await worker.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ' + attributedSql, [schools[0].id, wall(day.dayStartUtc), wall(day.dayEndUtc), heavyDate, '[]'])).rows;
    } catch (error) { metrics.attributionPlanFailure = { code: error.code, message: error.message }; }
    const reference = readFileSync(resolve(root, 'scripts/load/usage/reference-attribution-20260930.sql'), 'utf8');
    assert.match(reference, /WITH observed AS MATERIALIZED/);
    assert.doesNotMatch(reference, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY|DO)\b/i, 'The immutable baseline diagnostic must remain read-only');
    try {
      metrics.baselineAttributionPlan = (await worker.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ' + reference, [schools[0].id, wall(day.dayStartUtc), wall(day.dayEndUtc), heavyDate, '[]'])).rows;
    } catch (error) { metrics.baselineAttributionPlanFailure = { code: error.code, message: error.message }; }
    save();
    await flushHeartbeatClassificationBatches();
    // The established writer compares UTC wall-clock timestamps at whole-second
    // precision. Use that same explicit input boundary in the independent raw
    // oracle rather than granting fractional tail time beyond its actual cutoff.
    const cutoff = currentObservationCutoff(), currentDay = rollup.classpilotUsageRollupDay(today, zone);
    metrics.currentDayWriters = [];
    metrics.heavyDayAtomicity = [];
    for (const school of schools) {
      const heavySucceeded = outcomes[school.index].status === 'fulfilled';
      const heavySeconds = heavySucceeded ? 15000 : 0;
      const heavyRows = (await admin.query('SELECT COUNT(*)::int AS count FROM classpilot_usage_rollups WHERE school_id=$1 AND usage_date=$2::date', [school.id, heavyDate])).rows[0].count;
      const heavyCoverage = (await admin.query('SELECT COUNT(*)::int AS count FROM classpilot_usage_rollup_days WHERE school_id=$1 AND usage_date=$2::date', [school.id, heavyDate])).rows[0].count;
      assert.equal(heavyCoverage, heavySucceeded ? 1 : 0);
      if (!heavySucceeded) assert.equal(heavyRows, 0, 'A timed-out insertion must roll back aggregate rows and completion');
      metrics.heavyDayAtomicity.push({ schoolIndex: school.index, writerCommitted: heavySucceeded, aggregateRows: heavyRows, completionRows: heavyCoverage });
      for (const scope of ['school', 'grade', 'class', 'student']) checkReport(await get(school, scope), scope, !heavySucceeded);
      const raw = (await admin.query('SELECT student_id,timestamp AT TIME ZONE \'UTC\' AS timestamp FROM heartbeats WHERE school_id=$1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp ORDER BY student_id,timestamp,id', [school.id, wall(currentDay.dayStartUtc), wall(cutoff)])).rows;
      metrics.ingest.insertedHeartbeats += raw.length;
      metrics.ingest.bySchoolInserted ??= {}; metrics.ingest.bySchoolInserted[school.index] = raw.length;
      assert.ok(raw.length > 2, 'Both schools must contain real concurrently ingested observations beyond their preflights');
      const oracle = currentObservationSeconds(raw, cutoff);
      const started = performance.now(), result = await rollup.rollupClasspilotUsageDay(measuredWorker, { schoolId: school.id, day: currentDay, windowEndUtc: cutoff, exclusions: [] });
      metrics.currentDayWriters.push({ schoolIndex: school.index, durationMs: performance.now() - started, ...result });
      assert.equal(result.seconds, [...oracle.values()].reduce((sum, seconds) => sum + seconds, 0));
      for (const scope of ['school', 'grade', 'class', 'student']) {
        const indices = school.students.map((_, i) => i).filter(i => scope === 'school' || (scope === 'grade' ? i % 5 === 0 : scope === 'class' ? i < 5 : i === 0));
        const liveSeconds = indices.reduce((sum, i) => sum + (oracle.get(school.students[i]) || 0), 0);
        const read = await get(school, scope); assert.equal(read.status, 200); assert.equal(read.body.dataState, 'live');
        assert.equal(read.body.totals.monitoredBrowserSeconds, historyDates.length * 90 * size(scope) + heavySeconds * size(scope) + liveSeconds);
        assert.equal(read.body.byDay.find(row => row.date === today).monitoredBrowserSeconds, liveSeconds);
        assert.equal(read.body.range.computedDays, historyDates.length + 2 + (heavySucceeded ? 1 : 0));
        assert.deepEqual(read.body.range.unavailableDates, [gapDate, ...(!heavySucceeded ? [heavyDate] : [])].sort());
        const csv = await get(school, scope, 'csv'); assert.equal(csv.status, 200); assert.match(csv.body, /Monitored Browser Time/); assert.equal(csv.headers.get('cache-control'), 'no-store, private');
        const expectedTotalMinutes = ((historyDates.length * 90 * size(scope) + heavySeconds * size(scope) + liveSeconds) / 60).toFixed(1);
        assert.ok(csv.body.includes(`"Total","","${expectedTotalMinutes}"`), 'CSV totals must match the independent scope oracle');
        assert.ok(csv.body.includes(`"${emptyDate}","final","0.0"`));
        assert.equal(csv.body.includes(`"${gapDate}",`), false);
        metrics.reads[`${school.index}/${scope}`].afterLiveMs = read.durationMs; metrics.reads[`${school.index}/${scope}`].csvMs = csv.durationMs;
        metrics.reads[`${school.index}/${scope}`].expected = { completedHistoricalDays: historyDates.length, historySeconds: historyDates.length * 90 * size(scope), heavyDaySeconds: heavySeconds * size(scope), currentObservedSeconds: liveSeconds, csvTotalMinutes: expectedTotalMinutes };
      }
      assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [school.id])).rows[0].count, 4);
    }
    metrics.ingest.timings = summarize(metrics.ingest.timingsMs); delete metrics.ingest.timingsMs;
    metrics.databaseBytes = Number((await admin.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
    const afterStats = (await admin.query('SELECT temp_bytes,temp_files,blks_read,blks_hit FROM pg_stat_database WHERE datname=current_database()')).rows[0];
    metrics.databaseCountersDelta = Object.fromEntries(Object.keys(beforeStats).map(key => [key, Number(afterStats[key]) - Number(beforeStats[key])]));
    metrics.correctness = { realMaxRangeAccepted: true, nextLongerRangeRejected: true, independentAllScopeTotals: true, concurrentSchoolWriters: true, actualHttpIngest: true,
      successfulEmptyDay: true, gapWithheld: true, expiredDateWithheld: true, atomicSnapshotReads: true, currentDayRawOracle: true, crossSchoolIdsDenied: true, csvStrictAuditRecorded: true };
    metrics.correctness.concurrentSchoolWriters = !outcomes.slice(0, 2).some(outcome => outcome.status === 'rejected');
    metrics.finishedAt = new Date().toISOString(); save();
    if (failedPhase) throw failedPhase.reason;
    metrics.finishedAt = new Date().toISOString(); metrics.passed = true; save();
    console.log(JSON.stringify({ event: 'local_usage_scale_complete', sourceRevision: metrics.sourceRevision, writerMs: metrics.concurrentWriters.map(row => row.durationMs), ingestRequests: metrics.ingest.requests, insertedHeartbeats: metrics.ingest.insertedHeartbeats, productionReadiness: false }));
  } catch (error) {
    metrics.failure = { name: error.name, code: error.code || 'SCALE_ASSERTION', message: error.message };
    if (phaseStarted && metrics.concurrentPhaseMs === undefined) metrics.concurrentPhaseMs = performance.now() - phaseStarted;
    if (metrics.ingest.timingsMs?.length) { metrics.ingest.timings = summarize(metrics.ingest.timingsMs); delete metrics.ingest.timingsMs; }
    save(); throw error;
  }
  finally {
    ingestRunning = false; await Promise.allSettled(ingestion); clearInterval(sampler);
    server?.closeAllConnections(); if (server) await new Promise(done => server.close(done));
    await Promise.allSettled([appPool?.end(), sessionPool?.end(), worker.end(), admin.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runLocalScale().catch(error => { console.error(JSON.stringify({ event: 'local_usage_scale_failed', name: error.name, code: error.code || 'SCALE_ASSERTION', message: error.message })); process.exitCode = 1; });
}
