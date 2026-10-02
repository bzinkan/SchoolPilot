import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import pg from 'pg';
import { summarize } from './local-usage-benchmark.mjs';

import { assertLocalScaleFixture, currentObservationCutoff, usageAttributionDiagnosticSql, apiStatementKind, currentObservationSeconds, measureCall } from './local-usage-scale.mjs';
import { SCHOOL_DAY_PROFILE, schoolDayOracle, schoolDayRangeDomains, schoolDaySessionRoster, schoolDaySeedStudentWindows } from './school-day-profile.mjs';
import { SCHOOL_DAY_AI_PROFILE, schoolDayAiDecisionSamples } from './school-day-ai-profile.mjs';
import { fixtureRlsContract, assertFixtureRuntimeModes, assertCompleteFixtureCatalog } from './fixture-rls-contract.mjs';
import { offerOpenLoopHeartbeats } from './open-loop-heartbeats.mjs';
import { COLD_OPEN_LOOP_PROFILE, assertColdFixtureSnapshot } from './cold-open-loop-profile.mjs';
const wall = value => value.toISOString().replace('T',' ').replace('Z','');
const sleep = ms => new Promise(done => setTimeout(done,ms));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const heavyOracles = Object.fromEntries(['school','grade','class','student'].map(scope => [scope, schoolDayOracle(scope)]));
export async function runSchoolDayScale({ aiScenario = false, openLoop = false, coldPhase = null } = {}) {
  assertLocalScaleFixture(process.env);
  assert.equal(typeof aiScenario, 'boolean');
  assert.equal(typeof openLoop, 'boolean');
  assert.ok(coldPhase === null || (openLoop && aiScenario && ['prepare','measure'].includes(coldPhase)));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const registryPath = resolve(root,'src/config/rlsRegistry.json');
  const rlsContract = fixtureRlsContract(JSON.parse(readFileSync(registryPath,'utf8')),hash(registryPath),process.env);
  if (openLoop) {
    rlsContract.heartbeatOfferedCapabilities = [...COLD_OPEN_LOOP_PROFILE.classPilot.capabilities];
    rlsContract.heartbeatExtensionIdentity = Object.fromEntries(Object.entries(COLD_OPEN_LOOP_PROFILE.classPilot).filter(([key]) => key !== 'capabilities'));
  }
  const output = process.env.USAGE_SCALE_OUTPUT; assert.ok(output);
  const caps = JSON.parse(readFileSync(process.env.USAGE_SCALE_CAPS, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(caps.NanoCpus, 4_000_000_000); assert.equal(caps.Memory, 4_294_967_296);
  assert.ok(getHeapStatistics().heap_size_limit <= 600 * 1024 ** 2, 'Node512MiB V8 heap cap required');
  const metrics = { version: 1, sourceRevision: process.env.USAGE_SOURCE_REVISION, startedAt: new Date().toISOString(), passed: false,
    productionReadiness: false, rlsContract, profile: { workload: openLoop ? COLD_OPEN_LOOP_PROFILE : aiScenario ? SCHOOL_DAY_AI_PROFILE : SCHOOL_DAY_PROFILE, postgresCpus: 4, postgresMemoryBytes: caps.Memory, nodeV8OldSpaceMiB: 512, nodeHeapLimitBytes: getHeapStatistics().heap_size_limit,
      apiStatementDeadlineMs: 15_000, apiAcquisitionDeadlineMs: 5_000, workerStatementDeadlineMs: 60_000, workerAcquisitionDeadlineMs: 10_000 },
    sourceHashes: Object.fromEntries(['src/services/classpilotUsageRollup.ts', 'src/services/classpilotUsageRead.ts', 'src/routes/classpilot/devices.ts', 'scripts/load/usage/local-school-day-scale.mjs', 'scripts/load/usage/school-day-profile.mjs', 'scripts/load/usage/school-day-ai-profile.mjs', 'scripts/load/usage/local-usage-scale.mjs', 'scripts/load/usage/reference-attribution-20260930.sql', ...(aiScenario ? ['scripts/load/usage/local-school-day-ai-scale.mjs'] : [])].map(file => [file, hash(resolve(root, file))])),
    limitations: ['Local DockerCPU/memory caps do not represent RDS I/O.', 'Node heap cap is not a Windows CPU or total RSS quota.', 'The hourly scheduler fleet, preceding heavy jobs, Redis distribution, managed devices and production rollout remain unverified.'],
    writerQueries: [], reads: {}, readFailures: [], apiDatabase: { acquisitions: { count: 0, failures: 0, maxMs: 0 }, statements: {} },
    ingest: { requests: 0, insertedHeartbeats: 0, bySchool: {}, timingsMs: [], statuses: {} }, peakRssBytes: process.memoryUsage().rss };
  assert.match(metrics.sourceRevision, /^[a-f0-9]{40}$/);
  if (openLoop) {
    assert.equal(resolve(process.env.USAGE_SCALE_COLD_STATE || ''),resolve(dirname(output),'cold-fixture-state.json'),'Cold state must stay in the owned fresh evidence directory');
    for (const file of ['scripts/load/usage/open-loop-heartbeats.mjs','scripts/load/usage/cold-open-loop-profile.mjs','scripts/load/usage/classpilot-297-advertised-capabilities.json','scripts/load/usage/local-cold-open-loop-scale.mjs']) metrics.sourceHashes[file]=hash(resolve(root,file));
    assert.equal(rlsContract.name,'classpilotPrivateChatLifecyclePostExpand','Final acceptance requires the reviewed full129 schema');
  }
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
    assert.equal((await admin.query('SELECT COUNT(*)::int AS count FROM schools')).rows[0].count, coldPhase === 'measure' ? 2 : 0);
    const role = (await worker.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    metrics.selectedInventoryCatalog = (await worker.query("SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname",[rlsContract.tables])).rows;
    assertCompleteFixtureCatalog(rlsContract,metrics.selectedInventoryCatalog);
    if (rlsContract.name !== 'classpilotUsageRollupDaysPostExpand') {
      metrics.currentContractMigrations = (await admin.query('SELECT id,checksum,status FROM schema_migrations ORDER BY id')).rows;
      assert.ok(metrics.currentContractMigrations.length > 0 && metrics.currentContractMigrations.every(row => row.status === 'complete'));
      for (const id of ['20260824_staff_identity_integrity_contract','classpilot-usage-rollup-days-20260930','passpilot-appointments-expand-20260930']) assert.ok(metrics.currentContractMigrations.some(row => row.id === id),'Current constraint/ledger/admission migrations required');
      if(rlsContract.name==='classpilotPrivateChatLifecyclePostExpand') assert.ok(metrics.currentContractMigrations.some(row=>row.id==='classpilot-private-chat-lifecycle-20261002'),'Current129 lifecycle migration required');
    }
    const rlsTables = ['heartbeats','classpilot_usage_rollups','classpilot_usage_rollup_days', ...(aiScenario ? ['classpilot_ai_decisions'] : [])];
    metrics.rls = (await worker.query("SELECT relname,relrowsecurity,relforcerowsecurity,relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_table FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname", [rlsTables])).rows;
    assert.equal(metrics.rls.length, rlsTables.length); assert.ok(metrics.rls.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.owns_table));
    metrics.database = (await admin.query("SELECT version(),current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem,current_setting('max_connections') AS max_connections")).rows[0];
    const rollup = await import('../../../dist/services/classpilotUsageRollup.js');
    const time = await import('../../../dist/util/schoolTime.js');
    const { createApp } = await import('../../../dist/app.js');
    ({ pool: appPool, sessionPool } = await import('../../../dist/db.js'));
    if (rlsContract.name !== 'classpilotUsageRollupDaysPostExpand') assertFixtureRuntimeModes(rlsContract,await import('../../../dist/services/classpilotDailyUsageRollup.js'),await import('../../../dist/services/classpilotProtocol.js'),process.env);
    const contractSnapshot = JSON.stringify({rlsContract,catalog:metrics.selectedInventoryCatalog,migrations:metrics.currentContractMigrations ?? null,role},null,2)+'\n';
    writeFileSync(resolve(dirname(output),coldPhase === 'prepare' ? 'preparation-fixture-contract.json' : 'fixture-contract.json'),contractSnapshot);
    metrics.fixtureContractSnapshotSha256 = createHash('sha256').update(contractSnapshot).digest('hex');
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
    // Compute independent expectations before the measured concurrent phase.
    const domainOracles = Object.fromEntries(['school','grade','class','student'].map(scope => [scope, {
      withHeavy: schoolDayRangeDomains(scope, historyDates.length, true, heavyOracles[scope]),
      withoutHeavy: schoolDayRangeDomains(scope, historyDates.length, false, heavyOracles[scope]),
    }]));
    const resume = coldPhase === 'measure' ? (()=>{
      assert.match(process.env.USAGE_SCALE_COLD_STATE_SHA256 || '',/^[a-f0-9]{64}$/);
      assert.equal(hash(process.env.USAGE_SCALE_COLD_STATE),process.env.USAGE_SCALE_COLD_STATE_SHA256,'Prepared fixture bytes must remain unchanged');
      return assertColdFixtureSnapshot(JSON.parse(readFileSync(process.env.USAGE_SCALE_COLD_STATE,'utf8')),
        {sourceRevision:metrics.sourceRevision,sourceHashes:metrics.sourceHashes,today,registrySha256:rlsContract.registrySha256});
    })() : null;
    const schools = resume ? resume.schools : Array.from({ length: 2 }, (_, index) => ({ index, id: randomUUID(), staff: randomUUID(), teachers: Array.from({ length: 100 }, () => randomUUID()),
      students: Array.from({ length: 500 }, () => randomUUID()), groups: Array.from({ length: 100 }, () => randomUUID()), devices: Array.from({ length: 500 }, () => `synthetic-scale-${randomUUID()}`),
      studentSessions: Array.from({ length: 500 }, () => randomUUID()) }));
    metrics.dataset = { substantialSchools: 2, studentsPerSchool: 500, rawHeavyDayPerSchool: 1_000_000, uniqueHeavyDayPerSchool: 1_000_000, expectedHeavyGrainsPerSchool: heavyOracles.school.grains,
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
    const ingestOne = async (school, index, signal) => {
      const started = performance.now();
      const response = await fetch(`${base}/device/heartbeat`, { method: 'POST', signal, headers: { Authorization: `Bearer ${school.deviceTokens[index]}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientProtocolVersion: 3, extensionVersion: openLoop ? COLD_OPEN_LOOP_PROFILE.classPilot.extensionVersion : '2.10.0', capabilities: openLoop ? COLD_OPEN_LOOP_PROFILE.classPilot.capabilities : [], activeTabUrl: 'https://ixl.com/lesson', activeTabTitle: 'Synthetic current scope' }) });
      await response.text(); metrics.ingest.requests++; metrics.ingest.timingsMs.push(performance.now() - started);
      metrics.ingest.bySchool[school.index] = (metrics.ingest.bySchool[school.index] || 0) + 1;
      metrics.ingest.statuses[response.status] = (metrics.ingest.statuses[response.status] || 0) + 1;
      assert.ok(response.status === 200 || response.status === 204, `Synthetic heartbeat status ${response.status}`);
    };
    const seedStarted = performance.now();
    if (!resume) {
    for (const school of schools) {
      metrics.preparationStage = { schoolIndex: school.index, kind: 'identity-and-current-bindings' };
      await admin.query("INSERT INTO schools(id,name,domain,status,is_active,plan_status,school_timezone) VALUES($1,$2,'example.test','active',true,'active',$3)", [school.id, `Synthetic Scale ${school.index}`, zone]);
      await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [school.id]);
      await admin.query("INSERT INTO settings(school_id,school_name,ws_shared_key,retention_hours,enable_tracking_hours,grade_levels) VALUES($1,'Synthetic Scale','synthetic','8760',false,'{6,7,8,9,10}')", [school.id]);
      school.email = `scale-${school.staff}@example.test`;
      await admin.query("INSERT INTO users(id,email,first_name,last_name) SELECT id,'scale-'||id||'@example.test','Synthetic','Scale' FROM unnest($1::text[]) id", [[school.staff, ...school.teachers]]);
      await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) SELECT $1,id,CASE WHEN id=$2 THEN 'school_admin' ELSE 'teacher' END,'active' FROM unnest($3::text[]) id", [school.id, school.staff, [school.staff, ...school.teachers]]);
      await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status,grade_level,email) SELECT id,$2,'Synthetic','Scale','active',(6+(ordinality-1)%5)::text,'scale-'||id||'@example.test' FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality)", [school.students, school.id]);
      const classWriter = await admin.connect();
      try {
        await classWriter.query('BEGIN');
        await classWriter.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type) SELECT id,$2,($3::text[])[ordinality::int],'Synthetic Class '||ordinality,'admin_class' FROM unnest($1::text[]) WITH ORDINALITY class(id,ordinality)", [school.groups, school.id, school.teachers]);
        await classWriter.query("INSERT INTO group_teachers(group_id,teacher_id,role) SELECT id,($2::text[])[ordinality::int],'primary' FROM unnest($1::text[]) WITH ORDINALITY class(id,ordinality)", [school.groups, school.teachers]);
        await classWriter.query('COMMIT');
      } catch (error) { await classWriter.query('ROLLBACK'); throw error; }
      finally { classWriter.release(); }
      await admin.query("INSERT INTO group_students(student_id,group_id) SELECT id,($2::text[])[((ordinality-1)/5)::int+1] FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality)", [school.students, school.groups]);
      await admin.query("INSERT INTO devices(device_id,school_id,class_id) SELECT id,$2,($3::text[])[((ordinality-1)/5)::int+1] FROM unnest($1::text[]) WITH ORDINALITY device(id,ordinality)", [school.devices, school.id, school.groups]);
      await admin.query("INSERT INTO student_sessions(id,student_id,device_id,auth_kind,is_active) SELECT id,($2::text[])[ordinality::int],($3::text[])[ordinality::int],'managed_profile',true FROM unnest($1::text[]) WITH ORDINALITY session(id,ordinality)", [school.studentSessions, school.students, school.devices]);
      school.token = signUserToken({ userId: school.staff, email: school.email, isSuperAdmin: false });
      school.deviceTokens = school.students.map((studentId, i) => createStudentToken({ studentId, schoolId: school.id, deviceId: school.devices[i], sessionId: school.studentSessions[i], studentEmail: `scale-${studentId}@example.test` }));
      assert.equal((await get(school, 'school')).status, 200);
      await ingestOne(school, 0);
      console.log(JSON.stringify({ event: 'local_school_day_scale_auth_preflight', schoolIndex: school.index }));
      metrics.preparationStage = { schoolIndex: school.index, kind: 'frozen-sessions' };
      // Six 50-minute lessons with 10-minute passing gaps. Each five-student
      // cohort rotates to the next official class each period. All historical
      // and current scope inventories stay present during the actual workload.
      for (const dates of [historyDates, [heavyDate], [today]]) {
        const sessions = dates.flatMap(date => school.groups.flatMap((group, i) => Array.from({ length: date === heavyDate ? 6 : 1 }, (_, window) => ({ id: randomUUID(), group, teacher: school.teachers[i], date, window, index: i }))));
        for (let offset = 0; offset < sessions.length; offset += 2000) {
          const rows = sessions.slice(offset, offset + 2000).map(session => {
            const start = session.date === today ? new Date(Date.now() - 3600_000) : new Date(time.localDateStartUtc(session.date, zone).getTime() + 8 * 3600_000 + session.window * 3600_000);
            return { ...session, start: wall(start), end: session.date === today ? null : wall(new Date(start.getTime() + (session.date === heavyDate ? 3000_000 : 7 * 3600_000))) };
          });
          await admin.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time) SELECT id,$1,\"group\",teacher,start::timestamp,\"end\"::timestamp FROM jsonb_to_recordset($2::jsonb) AS item(id text,\"group\" text,teacher text,start text,\"end\" text)", [school.id, JSON.stringify(rows)]);
          const frozenRows = rows.flatMap(session => (session.date === heavyDate ? schoolDaySessionRoster(session.index, session.window) : Array.from({length:5},(_,member) => session.index*5+member)).map(index => ({ id: session.id, group: session.group, student: school.students[index], start: session.start })));
          await admin.query('INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) SELECT $1,id,"group",student,start::timestamptz FROM jsonb_to_recordset($2::jsonb) AS item(id text,"group" text,student text,start text)', [school.id, JSON.stringify(frozenRows)]);
        }
      }
      // Finished history is a reader-cardinality fixture, not a claim of
      // replaying a full year of raw heartbeats through the writer.
      metrics.preparationStage = { schoolIndex: school.index, kind: 'historical-aggregates' };
      for (let offset = 0; offset < historyDates.length; offset += 30) {
        await admin.query(`INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,class_id,domain,classification,seconds,heartbeat_count)
          SELECT $1,date::date,student.id,($4::text[])[((ordinality-1)/5)::int+1],'history-'||((ordinality-1)%200)||'.example.test',category,30,1
          FROM unnest($2::text[]) date CROSS JOIN unnest($3::text[]) WITH ORDINALITY student(id,ordinality) CROSS JOIN unnest('{educational,non-educational,unknown}'::text[]) category`, [school.id, historyDates.slice(offset, offset + 30), school.students, school.groups]);
      }
      const coverageDates = [...historyDates, emptyDate];
      await admin.query(`INSERT INTO classpilot_usage_rollup_days(school_id,usage_date,day_start_at,day_end_at,processed_through,is_final)
        SELECT $1,date::date,date::date::timestamp AT TIME ZONE $3,(date::date+1)::timestamp AT TIME ZONE $3,(date::date+1)::timestamp AT TIME ZONE $3,true FROM unnest($2::text[]) date`, [school.id, coverageDates, zone]);
      for (const batch of schoolDaySeedStudentWindows()) {
        metrics.preparationStage = { schoolIndex: school.index, kind: 'heavy-heartbeats', studentFrom: batch.from, studentTo: batch.to };
        await admin.query(`INSERT INTO heartbeats(id,device_id,student_id,school_id,active_tab_title,active_tab_url,ai_category,teacher_intent_source,timestamp)
        SELECT 'school-day-'||$4||'-'||lpad(student.ordinality::text,4,'0')||'-'||lpad(sample.n::text,4,'0'),
          ($5::text[])[student.ordinality::int],student.id,$2,'synthetic','https://lesson-'||(((student.ordinality-1)%25)*8+(sample.n/20)%8)||'.example.test/',
          CASE WHEN sample.n%4=0 THEN 'educational' WHEN sample.n%4=2 THEN NULL ELSE 'non-educational' END,CASE WHEN sample.n%4=3 THEN 'flight_path' ELSE NULL END,
          $3::timestamp+interval '8 hours'+sample.n*interval '10 seconds'
        FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality) CROSS JOIN generate_series(0,1999) sample(n)
        WHERE student.ordinality BETWEEN $6::int AND $7::int`, [school.students, school.id, wall(day.dayStartUtc), school.index, school.devices, batch.from, batch.to]);
      }
      if (aiScenario) {
        metrics.preparationStage = { schoolIndex: school.index, kind: 'sampled-ai-decisions' };
        await admin.query(`INSERT INTO classpilot_ai_decisions(id,school_id,student_id,device_id,heartbeat_id,url,category,teacher_intent_source,created_at)
          SELECT 'school-day-ai-'||$3||'-'||lpad(student.ordinality::text,4,'0')||'-'||lpad(sample.n::text,4,'0'),
            $2,student.id,heartbeat.device_id,heartbeat.id,heartbeat.active_tab_url,heartbeat.ai_category,heartbeat.teacher_intent_source,heartbeat.timestamp+interval '1 second'
          FROM unnest($1::text[]) WITH ORDINALITY student(id,ordinality) CROSS JOIN unnest($4::int[]) sample(n)
          JOIN heartbeats AS heartbeat ON heartbeat.school_id=$2 AND heartbeat.student_id=student.id
            AND heartbeat.id='school-day-'||$3||'-'||lpad(student.ordinality::text,4,'0')||'-'||lpad(sample.n::text,4,'0')
          WHERE heartbeat.timestamp >= $5::timestamp AND heartbeat.timestamp < $6::timestamp`,
          [school.students, school.id, school.index, schoolDayAiDecisionSamples(), wall(day.dayStartUtc), wall(day.dayEndUtc)]);
        const binding = (await admin.query(`WITH decisions AS (
          SELECT * FROM classpilot_ai_decisions WHERE school_id=$1 AND created_at >= $2::timestamp AND created_at < $3::timestamp
        ), per_student AS (SELECT student_id,COUNT(*)::int AS count FROM decisions GROUP BY student_id)
        SELECT COUNT(decision.id)::int AS rows,COUNT(DISTINCT decision.student_id)::int AS students,COUNT(DISTINCT decision.heartbeat_id)::int AS observations,
          COUNT(*) FILTER (WHERE heartbeat.id IS NULL OR heartbeat.school_id IS DISTINCT FROM decision.school_id
            OR heartbeat.student_id IS DISTINCT FROM decision.student_id OR heartbeat.device_id IS DISTINCT FROM decision.device_id
            OR heartbeat.active_tab_url IS DISTINCT FROM decision.url OR heartbeat.ai_category IS DISTINCT FROM decision.category
            OR heartbeat.teacher_intent_source IS DISTINCT FROM decision.teacher_intent_source
            OR decision.created_at IS DISTINCT FROM heartbeat.timestamp+interval '1 second')::int AS invalid,
          (SELECT MIN(count) FROM per_student) AS minPerStudent,(SELECT MAX(count) FROM per_student) AS maxPerStudent
        FROM decisions AS decision LEFT JOIN heartbeats AS heartbeat ON heartbeat.id=decision.heartbeat_id`,
          [school.id, wall(day.dayStartUtc), wall(day.dayEndUtc)])).rows[0];
        assert.deepEqual(binding,{rows:10_000,students:500,observations:10_000,invalid:0,minperstudent:20,maxperstudent:20});
        metrics.aiDecisionBindings ??= []; metrics.aiDecisionBindings.push({schoolIndex:school.index,...binding});
      }
      console.log(JSON.stringify({ event: 'local_school_day_scale_school_seeded', schoolIndex: school.index }));
    }
    metrics.preparationStage = { kind: 'analyze-and-cardinality-validation' };
    await admin.query('ANALYZE'); metrics.seedMs = performance.now() - seedStarted;
    metrics.fixtureCounts = (await admin.query('SELECT id AS school_id,(SELECT COUNT(*) FROM heartbeats WHERE school_id=schools.id) AS raw,(SELECT COUNT(*) FROM teaching_sessions WHERE school_id=schools.id) AS sessions,(SELECT COUNT(*) FROM classpilot_session_students WHERE school_id=schools.id) AS frozen_roster_rows,(SELECT COUNT(*) FROM classpilot_usage_rollups WHERE school_id=schools.id) AS aggregates FROM schools')).rows;
    assert.ok(metrics.fixtureCounts.every(row => Number(row.raw) === 1_000_001 && Number(row.aggregates) === metrics.dataset.historicalRowsPerSchool));
    metrics.heavyDeviceBindings = [];
    for (const school of schools) {
      const bindings = (await admin.query(`WITH bindings AS (
        SELECT DISTINCT student_id,device_id FROM heartbeats
        WHERE school_id=$1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp
      ) SELECT COUNT(*)::int AS pairs,COUNT(DISTINCT binding.device_id)::int AS devices,
          COUNT(*) FILTER (WHERE device.device_id IS NULL OR session.id IS NULL)::int AS invalid
        FROM bindings AS binding
        LEFT JOIN devices AS device ON device.device_id=binding.device_id AND device.school_id=$1
        LEFT JOIN student_sessions AS session ON session.student_id=binding.student_id AND session.device_id=binding.device_id
        LEFT JOIN students AS student ON student.id=binding.student_id AND student.school_id=$1
        WHERE student.id IS NOT NULL`, [school.id,wall(day.dayStartUtc),wall(day.dayEndUtc)])).rows[0];
      assert.deepEqual(bindings,{pairs:500,devices:500,invalid:0});
      metrics.heavyDeviceBindings.push({schoolIndex:school.index,...bindings});
    }
    metrics.preparationStage = { kind: 'complete' };
    } else {
      Object.assign(metrics,resume.preparation);
      for(const school of schools) {
        school.token=signUserToken({userId:school.staff,email:school.email,isSuperAdmin:false});
        school.deviceTokens=school.students.map((studentId,i)=>createStudentToken({studentId,schoolId:school.id,deviceId:school.devices[i],sessionId:school.studentSessions[i],studentEmail:`scale-${studentId}@example.test`}));
      }
      metrics.coldResume={preparedStateSha256:process.env.USAGE_SCALE_COLD_STATE_SHA256,postgresSharedBuffersReset:true,hostFilesystemCachesFlushed:false};
    }
    if(coldPhase === 'prepare') {
      const preparation=Object.fromEntries(['seedMs','fixtureCounts','heavyDeviceBindings','aiDecisionBindings','preparationStage'].map(key=>[key,metrics[key]]));
      const state={version:1,sourceRevision:metrics.sourceRevision,sourceHashes:metrics.sourceHashes,today,registrySha256:rlsContract.registrySha256,profileName:COLD_OPEN_LOOP_PROFILE.name,
        schools:schools.map(({token,deviceTokens,...school})=>school),preparation};
      writeFileSync(process.env.USAGE_SCALE_COLD_STATE,JSON.stringify(state,null,2));
      metrics.fixturePreparationOnly=true; metrics.capacityMeasured=false; save();
      console.log(JSON.stringify({event:'local_school_day_scale_cold_prepared',sourceRevision:metrics.sourceRevision,capacityMeasured:false}));
      return;
    }
    if (process.env.USAGE_SCALE_PREPARE_ONLY === '1') {
      metrics.fixturePreparationOnly = true; save();
      console.log(JSON.stringify({ event: 'local_school_day_scale_prepared', sourceRevision: metrics.sourceRevision, capacityMeasured: false }));
      return;
    }
    const size = scope => ({ school: 500, grade: 100, class: 5, student: 1 })[scope];
    const checkReport = (read, scope, allowHeavy = false) => {
      assert.equal(read.status, 200); assert.equal(read.body.range.retentionDays, 365); assert.equal(read.body.range.requestedDays, 365); assert.equal(read.body.range.partiallyExpired, true);
      const heavy = read.body.byDay.find(row => row.date === heavyDate);
      if (!allowHeavy) assert.ok(heavy);
      const n = size(scope), baseSeconds = historyDates.length * 90 * n;
      assert.equal(read.body.totals.monitoredBrowserSeconds, baseSeconds + (heavy ? heavyOracles[scope].monitored : 0));
      assert.equal(read.body.totals.instructionalSeconds, historyDates.length * 30 * n + (heavy ? heavyOracles[scope].instructional : 0));
      assert.equal(read.body.totals.offTaskSeconds, historyDates.length * 30 * n + (heavy ? heavyOracles[scope].offTask : 0));
      assert.equal(read.body.totals.unknownSeconds, historyDates.length * 30 * n + (heavy ? heavyOracles[scope].unknown : 0));
      const expectedDomains = domainOracles[scope][heavy ? 'withHeavy' : 'withoutHeavy'];
      assert.deepEqual(read.body.topEducationalDomains, expectedDomains.educational);
      assert.deepEqual(read.body.topNonEducationalDomains, expectedDomains.nonEducational);
      assert.equal(read.body.totals.activeMonitoredStudents, heavy ? heavyOracles[scope].students : n);
      assert.equal(read.body.totals.heartbeatCount, historyDates.length * 3 * n + (heavy ? heavyOracles[scope].heartbeats : 0));
      if (heavy) {
        assert.equal(heavy.monitoredBrowserSeconds, heavyOracles[scope].monitored);
        assert.equal(heavy.instructionalSeconds, heavyOracles[scope].instructional);
        assert.equal(heavy.offTaskSeconds, heavyOracles[scope].offTask);
        assert.equal(heavy.unknownSeconds, heavyOracles[scope].unknown);
        assert.equal(heavy.activeMonitoredStudents, heavyOracles[scope].students);
        assert.equal(heavy.heartbeatCount, heavyOracles[scope].heartbeats);
      }
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
    ingestion = openLoop ? [offerOpenLoopHeartbeats((offering,signal)=>ingestOne(schools[offering.schoolIndex],offering.deviceIndex,signal)).then(result=>{
      result.timings=summarize(result.timingsMs); delete result.timingsMs; metrics.openLoop=result;
    })] : Array.from({ length: 4 }, async () => {
      while (ingestRunning && performance.now() < ingestDeadline) {
        const sequence = nextDevice++; await ingestOne(schools[sequence % 2], Math.floor(sequence / 2) % 500); await sleep(50);
      }
    });
    // Both substantial schools aggregate at the same time as live HTTP ingest
    // and long-range reads. Snapshot totals may show either full old coverage
    // or the full committed heavy day; never partial aggregate/completion data.
    const writes = schools.map(async school => {
      const started = performance.now(), result = await rollup.rollupClasspilotUsageDay(measuredWorker, { schoolId: school.id, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
      assert.equal(result.seconds, heavyOracles.school.monitored); assert.equal(result.heartbeatCount, heavyOracles.school.heartbeats); assert.equal(result.rowCount, heavyOracles.school.grains);
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
    metrics.deadlineAcceptance = {
      fullWorkerOperations: metrics.concurrentWriters.length === 2 && metrics.concurrentWriters.every(row => row.durationMs < 60_000),
      apiStatements: Object.values(metrics.apiDatabase.statements).every(row => row.failures === 0 && row.maxMs < 15_000),
      apiAcquisitions: metrics.apiDatabase.acquisitions.failures === 0 && metrics.apiDatabase.acquisitions.maxMs < 5_000,
    };
    if(openLoop) metrics.performanceAcceptance={fullWorkerTwentyPercentHeadroom:metrics.concurrentWriters.length===2 && metrics.concurrentWriters.every(row=>row.durationMs<=48_000),
      actualOpenLoop100Rps:metrics.openLoop?.accepted===true};
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
      const heavySeconds = scope => heavySucceeded ? heavyOracles[scope].monitored : 0;
      const heavyRows = (await admin.query('SELECT COUNT(*)::int AS count FROM classpilot_usage_rollups WHERE school_id=$1 AND usage_date=$2::date', [school.id, heavyDate])).rows[0].count;
      const heavyCoverage = (await admin.query('SELECT COUNT(*)::int AS count FROM classpilot_usage_rollup_days WHERE school_id=$1 AND usage_date=$2::date', [school.id, heavyDate])).rows[0].count;
      assert.equal(heavyCoverage, heavySucceeded ? 1 : 0);
      if (heavySucceeded) assert.equal(heavyRows, heavyOracles.school.grains);
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
        assert.equal(read.body.totals.monitoredBrowserSeconds, historyDates.length * 90 * size(scope) + heavySeconds(scope) + liveSeconds);
        assert.equal(read.body.byDay.find(row => row.date === today).monitoredBrowserSeconds, liveSeconds);
        assert.equal(read.body.range.computedDays, historyDates.length + 2 + (heavySucceeded ? 1 : 0));
        assert.deepEqual(read.body.range.unavailableDates, [gapDate, ...(!heavySucceeded ? [heavyDate] : [])].sort());
        const csv = await get(school, scope, 'csv'); assert.equal(csv.status, 200); assert.match(csv.body, /Monitored Browser Time/); assert.equal(csv.headers.get('cache-control'), 'no-store, private');
        const expectedTotalMinutes = ((historyDates.length * 90 * size(scope) + heavySeconds(scope) + liveSeconds) / 60).toFixed(1);
        assert.ok(csv.body.includes(`"Total","","${expectedTotalMinutes}"`), 'CSV totals must match the independent scope oracle');
        assert.ok(csv.body.includes(`"${emptyDate}","final","0.0"`));
        assert.equal(csv.body.includes(`"${gapDate}",`), false);
        metrics.reads[`${school.index}/${scope}`].afterLiveMs = read.durationMs; metrics.reads[`${school.index}/${scope}`].csvMs = csv.durationMs;
        metrics.reads[`${school.index}/${scope}`].expected = { completedHistoricalDays: historyDates.length, historySeconds: historyDates.length * 90 * size(scope), heavyDaySeconds: heavySeconds(scope), currentObservedSeconds: liveSeconds, csvTotalMinutes: expectedTotalMinutes };
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
    assert.ok(Object.values(metrics.deadlineAcceptance).every(Boolean), 'Every full writer operation and measured API deadline must pass');
    if(openLoop) assert.ok(Object.values(metrics.performanceAcceptance).every(Boolean),'Final129 cold/open-loop acceptance requires20% full worker headroom and all100rps offers');
    metrics.finishedAt = new Date().toISOString(); metrics.passed = true; save();
    console.log(JSON.stringify({ event: 'local_school_day_scale_complete', sourceRevision: metrics.sourceRevision, writerMs: metrics.concurrentWriters.map(row => row.durationMs), ingestRequests: metrics.ingest.requests, insertedHeartbeats: metrics.ingest.insertedHeartbeats, productionReadiness: false }));
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
  await runSchoolDayScale().catch(error => { console.error(JSON.stringify({ event: 'local_school_day_scale_failed', name: error.name, code: error.code || 'SCALE_ASSERTION', message: error.message })); process.exitCode = 1; });
}
