import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, createWriteStream, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import pg from 'pg';
import { RELEASE_PG_APPLICATION_NAMES, POSTGRES_PRESSURE_SAMPLE_INTERVAL_MS, POSTGRES_PRESSURE_MAX_SAMPLES, POSTGRES_ROLE_WAITS_SQL, readPostgresPressure, postgresPressureDelta } from './release-enabled-postgres-pressure.mjs';
import { hash } from 'bcryptjs';
import { assertLocalScaleFixture, currentObservationSeconds, currentObservationDiagnostics, currentObservationFixtureViolations, currentObservationCutoff } from './local-usage-scale.mjs';
import { schoolDayOracle } from './school-day-profile.mjs';
import { RELEASE_ENABLED_PROFILE, enabledReleaseEnvironment, capacityAcceptance, releaseTrafficOptions } from './release-enabled-profile.mjs';

assertLocalScaleFixture(process.env);
const root = fileURLToPath(new URL('../../../', import.meta.url)), output = process.env.USAGE_SCALE_OUTPUT;
const directory = dirname(output), digest = data => createHash('sha256').update(data).digest('hex');
const write = (path, value) => writeFileSync(resolve(directory, path), JSON.stringify(value, null, 2) + '\n');
const env = enabledReleaseEnvironment(process.env);
const phaseName = process.env.USAGE_RELEASE_PHASE || 'combined';
const trafficOptions = releaseTrafficOptions(process.env);
const collectCpuProfile = process.env.USAGE_RELEASE_CPU_PROFILE === 'true';
assert.ok(['combined', 'ingest', 'reports', 'worker', 'preflight'].includes(phaseName));
const sourceClean = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
assert.ok(sourceClean || process.env.USAGE_RELEASE_DIAGNOSTIC === 'true', 'Capacity evidence requires clean source');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(source, process.env.USAGE_SOURCE_REVISION);
const files = readdirSync(resolve(root, 'scripts/load/usage')).filter(name => name.startsWith('release-enabled-') || name === 'run-release-enabled-scale.ps1' || name === 'prepare-release-control-ownership.mjs' || name === 'local-usage-scale.mjs');
const sourceHashes = Object.fromEntries(files.map(name => [name, digest(readFileSync(resolve(root, 'scripts/load/usage', name)))]));
const metrics = { schemaVersion: 1, profile: RELEASE_ENABLED_PROFILE, sourceRevision: source, sourceClean, sourceHashes,
  startedAt: new Date().toISOString(), productionReadiness: false, capacityAccepted: false, diagnosticOnly: process.env.USAGE_RELEASE_DIAGNOSTIC === 'true', phases: [],
  cpuProfile: { enabled: collectCpuProfile, ...(collectCpuProfile ? { file: 'api.cpuprofile', samplingIntervalMicroseconds: 1000, includesStartupAndDrain: true, capacityEvidence: false } : {}) },
  limitations: ['Local PostgreSQL quotas are not RDS I/O proof.', 'Generator, API and worker use separate Node processes with512MiB heap caps; Windows process CPU and RSS are not hard-limited.',
    'Managed-browser enforcement is not simulated-client ACK evidence.', 'Cold PostgreSQL shared buffers; host filesystem caches are not flushed. Real login/capability/report preflights happen before the measured traffic.',
    'The scheduler fleet and all other hourly jobs are outside this bounded two-school operation test.'],
};
const save = () => writeFileSync(output, JSON.stringify(metrics, null, 2) + '\n');
const children = [], observer = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 2, statement_timeout: 15_000, application_name: RELEASE_PG_APPLICATION_NAMES.observer });
let sequence = 0, sampling, samplePending = false;
async function child(name, file, extraEnv) {
  const stdout = createWriteStream(resolve(directory, `${name}.log`), { flags: 'wx' });
  const processChild = fork(resolve(root, `scripts/load/usage/${file}`), [], { cwd: root, env: { ...env, ...extraEnv, ...(RELEASE_PG_APPLICATION_NAMES[name] ? { PGAPPNAME: RELEASE_PG_APPLICATION_NAMES[name] } : {}) },
    execArgv: ['--max-old-space-size=512', ...(collectCpuProfile && name === 'api' ? ['--cpu-prof', `--cpu-prof-dir=${directory}`, '--cpu-prof-name=api.cpuprofile', '--cpu-prof-interval=1000'] : [])], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  processChild.stdout.pipe(stdout, { end: false }); processChild.stderr.pipe(stdout, { end: false });
  const closed = new Promise(resolve => processChild.once('close', (code, signal) => { stdout.end(); resolve({ code, signal }); }));
  const pending = new Map(); let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(new Error(`${name} startup exceeded30seconds`)), 30_000);
  processChild.on('message', message => {
    if (message.kind === 'ready') { clearTimeout(readyTimer); readyResolve(message); }
    else if (pending.has(message.id)) { const call = pending.get(message.id); pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(Object.assign(new Error(message.error.message), message.error)); else call.resolve(message.value); }
  });
  processChild.on('error', error => readyReject(error));
  processChild.on('exit', code => { clearTimeout(readyTimer); if (code !== 0) readyReject(new Error(`${name} exited${code}`));
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`${name} exited${code}`)); } pending.clear(); });
  const rpc = (operation, value, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name}/${operation} operation deadline`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); processChild.send({ id, operation, value });
  });
  const owner = { process: processChild, rpc, ready, closed, stdout }; children.push(owner); return owner;
}
try {
  const snapshot = JSON.parse(readFileSync(process.env.USAGE_SCALE_COLD_STATE, 'utf8'));
  assert.equal(digest(readFileSync(process.env.USAGE_SCALE_COLD_STATE)), process.env.USAGE_SCALE_COLD_STATE_SHA256);
  assert.equal(snapshot.sourceRevision, source); assert.equal(snapshot.schools.length, 2);
  // Canonical class ownership is prepared and verified before the cold restart,
  // rather than invented by transport probes or patched after measuring begins.
  const controlPreparation = JSON.parse(readFileSync(resolve(directory, 'release-control-preparation.json'), 'utf8'));
  assert.equal(controlPreparation.passed, true); assert.equal(controlPreparation.poolsClosed, true);
  assert.equal(controlPreparation.sourceRevision, source);
  assert.equal(controlPreparation.coldFixtureSha256, process.env.USAGE_SCALE_COLD_STATE_SHA256);
  assert.equal(controlPreparation.scriptSha256, sourceHashes['prepare-release-control-ownership.mjs']);
  assert.equal(controlPreparation.schools.length, snapshot.schools.length);
  for (const school of snapshot.schools) {
    const prepared = controlPreparation.schools.filter(row => row.schoolIndex === school.index);
    assert.equal(prepared.length, 1);
    assert.deepEqual(prepared[0], { schoolIndex: school.index, currentSessions: school.groups.length,
      rosterRows: school.students.length, staffBindings: school.groups.length, controlRows: school.students.length,
      invalidBindings: 0, nonemptyRestrictions: 0, backfilledSessions: school.groups.length });
  }
  metrics.canonicalActiveControlPreparation = controlPreparation;
  // These counts were collected and independently checked before PostgreSQL's
  // cold restart. Re-scanning raw tables here would warm the worker workload.
  assert.equal(snapshot.preparation?.fixtureCounts?.length, 2);
  assert.ok(snapshot.preparation.fixtureCounts.every(row => Number(row.raw) === 1_000_001 && Number(row.aggregates) === 541_500));
  assert.ok(snapshot.preparation.heavyDeviceBindings?.length === 2 && snapshot.preparation.heavyDeviceBindings.every(row => row.pairs === 500 && row.devices === 500 && row.invalid === 0));
  assert.ok(snapshot.preparation.aiDecisionBindings?.length === 2 && snapshot.preparation.aiDecisionBindings.every(row => row.rows === 10_000 && row.students === 500 && row.invalid === 0));
  metrics.fixturePreparation = snapshot.preparation;
  metrics.preparedStateSha256 = process.env.USAGE_SCALE_COLD_STATE_SHA256;
  metrics.resourceCaps = JSON.parse(readFileSync(process.env.USAGE_SCALE_CAPS, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(metrics.resourceCaps.NanoCpus, 4_000_000_000); assert.equal(metrics.resourceCaps.Memory, 4_294_967_296);
  const time = await import('../../../dist/util/schoolTime.js');
  const today = time.localDateInTimeZone(new Date(), 'America/New_York'); assert.equal(snapshot.today, today, 'Fixture must not cross a school-local date boundary');
  const heavyDate = time.addLocalDays(today, -2), emptyDate = time.addLocalDays(today, -3), gapDate = time.addLocalDays(today, -5);
  const fixture = { schools: snapshot.schools, today, heavyDate, emptyDate, gapDate, from: time.addLocalDays(today, -365), historyDays: 361,
    password: randomBytes(24).toString('hex') };
  const passwordHash = await hash(fixture.password, 10);
  for (const school of fixture.schools) {
    await observer.query('UPDATE users SET password=$1 WHERE id=ANY($2::text[])', [passwordHash, [school.staff, school.teachers[0]]]);
    const sessions = (await observer.query('SELECT id FROM teaching_sessions WHERE school_id=$1 AND group_id=$2 AND end_time IS NULL', [school.id, school.groups[0]])).rows;
    assert.equal(sessions.length, 1); school.currentSession = sessions[0].id;
    // The before-restart canonical preparation already captured staff and
    // initialized every current class's revisioned student control ownership.
  }
  const catalog = (await observer.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname", [env.RLS_ENABLED_TABLES.split(',')])).rows;
  assert.equal(catalog.length, 129); assert.ok(catalog.every(row => row.relrowsecurity && row.relforcerowsecurity));
  metrics.catalog = catalog; metrics.migrations = (await observer.query('SELECT id,checksum,status FROM schema_migrations ORDER BY id')).rows;
  assert.ok(metrics.migrations.every(row => row.status === 'complete'));
  const api = await child('api', 'release-enabled-process.mjs', { SCHEDULER_ENABLED: 'false', USAGE_RELEASE_ROLE: 'api' });
  const worker = await child('worker', 'release-enabled-process.mjs', { SCHEDULER_ENABLED: 'true', USAGE_RELEASE_ROLE: 'worker' });
  const generator = await child('generator', 'release-enabled-generator.mjs', { SCHEDULER_ENABLED: 'false', USAGE_RELEASE_ROLE: 'generator' });
  const [apiReady, workerReady, generatorReady] = await Promise.all([api.ready, worker.ready, generator.ready]);
  metrics.processes = { api: apiReady.pid, worker: workerReady.pid, generator: generatorReady.pid };
  metrics.pools = { ...apiReady.pools, ...workerReady.pools, observer: 2 };
  metrics.postgresApplicationNames = { api: apiReady.postgresApplicationName, worker: workerReady.postgresApplicationName, observer: RELEASE_PG_APPLICATION_NAMES.observer };
  metrics.prewarmed = apiReady.prewarmed; metrics.readiness = apiReady.readiness; metrics.redisReady = apiReady.redis;
  const auth = await generator.rpc('initialize', { ...fixture, base: apiReady.base });
  metrics.staffAuthenticationVerified = auth.realSessionCookies; metrics.enabledCapabilitiesVerified = auth.acceptedCapabilities;
  // A shutdown flush permanently disables batching. Preflight must leave the
  // live process's normal batching policy intact for the measured traffic.
  metrics.preflightDrain = await api.rpc('quiesce');
  assert.equal(metrics.preflightDrain.complete, true, 'Preflight server work did not drain');
  const phase = { name: phaseName, startedAt: new Date().toISOString(), pgWaitSamples: [], workers: [] }; metrics.phases.push(phase); save();
  const currentCounts = async () => (await observer.query('SELECT school_id,COUNT(*)::int AS count FROM heartbeats WHERE timestamp >= $1::timestamp GROUP BY school_id ORDER BY school_id',
    [time.localDateStartUtc(today, 'America/New_York').toISOString().replace('T', ' ').replace('Z', '')])).rows;
  phase.persistedBefore = await currentCounts();
  phase.postgresPressure = { baseline: await readPostgresPressure(observer), samples: [],
    sampleIntervalMs: POSTGRES_PRESSURE_SAMPLE_INTERVAL_MS, maxSamples: POSTGRES_PRESSURE_MAX_SAMPLES };
  await Promise.all([api.rpc('reset'), worker.rpc('reset')]);
  const start = performance.now();
  let nextPressureSampleAt = start + POSTGRES_PRESSURE_SAMPLE_INTERVAL_MS;
  sampling = setInterval(async () => {
    if (samplePending || phase.pgWaitSamples.length >= 720) return; samplePending = true;
    try {
      const rows = (await observer.query(POSTGRES_ROLE_WAITS_SQL)).rows;
      phase.pgWaitSamples.push({ elapsedMs: performance.now() - start, rows });
      if (performance.now() >= nextPressureSampleAt && phase.postgresPressure.samples.length < POSTGRES_PRESSURE_MAX_SAMPLES) {
        // Never catch up missed samples with a burst, and never add a probe pool.
        nextPressureSampleAt = performance.now() + POSTGRES_PRESSURE_SAMPLE_INTERVAL_MS;
        const snapshot = await readPostgresPressure(observer);
        phase.postgresPressure.samples.push({ elapsedMs: performance.now() - start, snapshot });
      }
    } catch (error) { phase.samplingFailure = { code: error.code || 'SAMPLING_FAILURE' }; }
    finally { samplePending = false; }
  }, 250); sampling.unref();
  const traffic = generator.rpc('phase', { ingest: ['combined', 'ingest'].includes(phaseName), reports: ['combined', 'reports'].includes(phaseName),
    lifecycle: phaseName === 'combined' || phaseName === 'preflight', ...trafficOptions });
  const oracle = schoolDayOracle('school');
  const workers = ['combined', 'worker'].includes(phaseName) ? fixture.schools.map(async school => {
    const result = await worker.rpc('rollup', { schoolId: school.id, date: heavyDate, cutoff: time.localDateStartUtc(time.addLocalDays(heavyDate, 1), 'America/New_York').toISOString() });
    return { schoolIndex: school.index, ...result, correct: result.seconds === oracle.monitored && result.heartbeatCount === oracle.heartbeats && result.rowCount === oracle.grains };
  }) : [];
  const settled = await Promise.allSettled([traffic, ...workers]);
  phase.traffic = settled[0].status === 'fulfilled' ? settled[0].value : { error: { message: settled[0].reason.message } };
  phase.workers = settled.slice(1).map((result, index) => result.status === 'fulfilled' ? result.value : { schoolIndex: index, correct: false, error: { message: result.reason.message } });
  phase.clientWorkCompletedMs = performance.now() - start;
  const [apiDrain, workerDrain] = await Promise.all([api.rpc('drain'), worker.rpc('drain')]);
  phase.serverDrain = { api: apiDrain, worker: workerDrain };
  phase.durationMs = performance.now() - start; clearInterval(sampling); while (samplePending) await new Promise(resolve => setTimeout(resolve, 10));
  phase.api = await api.rpc('snapshot'); phase.worker = await worker.rpc('snapshot');
  phase.postgresPressure.final = await readPostgresPressure(observer);
  phase.postgresPressure.delta = postgresPressureDelta(phase.postgresPressure.baseline, phase.postgresPressure.final,
    phase.postgresPressure.samples.map(sample => sample.snapshot));
  phase.postgresPressure.valid = !phase.samplingFailure && phase.postgresPressure.delta.valid;
  save();
  assert.ok(apiDrain.complete && workerDrain.complete, 'Server work remained active after bounded drain; metrics preserved');
  phase.persistedAfter = await currentCounts();
  phase.insertedObservations = phase.persistedAfter.reduce((sum, row) => sum + row.count - (phase.persistedBefore.find(before => before.school_id === row.school_id)?.count || 0), 0);
  const finishSource = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const finishClean = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
  metrics.sourceAtFinish = { revision: finishSource, clean: finishClean };
  metrics.sourceUnchangedAtFinish = finishSource === source && finishClean && files.every(name => digest(readFileSync(resolve(root, 'scripts/load/usage', name))) === sourceHashes[name]);
  if (phaseName !== 'combined') {
    metrics.diagnosticOnly = true; metrics.finishedAt = new Date().toISOString(); save();
    assert.ok(!phase.traffic.error, 'Diagnostic traffic failed');
    if (phaseName === 'preflight') assert.equal(phase.traffic.lifecycle?.passed, true, 'Diagnostic lifecycle preflight failed');
    if (phaseName === 'ingest') assert.equal(phase.traffic.heartbeats?.accepted, true, 'Diagnostic ingestion failed');
    if (phaseName === 'reports') assert.ok(phase.traffic.reports?.length === 64 && phase.traffic.reports.every(row => row.correct && row.status === 200), 'Diagnostic reports failed');
    if (phaseName === 'worker') assert.ok(phase.workers.length === 2 && phase.workers.every(row => row.correct), 'Diagnostic workers failed');
  }
  else {
    const cutoff = currentObservationCutoff(), liveBySchool = new Map(), currentDayWorkers = [];
    metrics.correctness = { passed: false, currentObservationCutoff: cutoff.toISOString(), currentDayWorkers };
    for (const school of fixture.schools) {
      const observationBounds = [school.id, time.localDateStartUtc(today, 'America/New_York').toISOString().replace('T', ' ').replace('Z', ''), cutoff.toISOString().replace('T', ' ').replace('Z', '')];
      const raw = (await observer.query(`SELECT student_id,(EXTRACT(EPOCH FROM timestamp)*1000000)::bigint::text AS timestamp_microseconds,
        active_tab_url IS NOT DISTINCT FROM 'https://ixl.com/lesson' AS expected_url,
        ai_category IS NOT DISTINCT FROM 'educational' AS expected_classification,
        NULLIF(teacher_intent_source,'') IS NULL AS expected_teacher_intent
        FROM heartbeats WHERE school_id=$1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp ORDER BY student_id,timestamp,id`, observationBounds)).rows;
      // Reject fixture drift instead of rounding across multiple real grains.
      // These checks read raw observations and frozen membership, not rollups.
      const fixtureCounts = (await observer.query(`WITH observed AS (
        SELECT student_id,MIN(timestamp) AS first_at,MAX(timestamp) AS last_at
        FROM heartbeats WHERE school_id=$1 AND timestamp >= $2::timestamp AND timestamp < $3::timestamp GROUP BY student_id
      ), expected AS (
        SELECT student_id,group_id FROM jsonb_to_recordset($4::jsonb) AS item(student_id text,group_id text)
      ), roster AS (
        SELECT member.student_id,member.group_id,member.captured_at,session.start_time,session.end_time,session.scheduled_end_at
        FROM classpilot_session_students member JOIN teaching_sessions session
          ON session.id=member.teaching_session_id AND session.school_id=member.school_id
        JOIN groups class ON class.id=member.group_id AND class.school_id=member.school_id
        WHERE member.school_id=$1 AND session.start_time >= $2::timestamp-interval '12 hours'
          AND session.start_time < $3::timestamp AND (session.end_time IS NULL OR session.end_time >= $2::timestamp)
      ), checked AS (
        SELECT observed.student_id,COUNT(roster.student_id) AS memberships,
          BOOL_AND(roster.group_id=expected.group_id AND roster.start_time <= observed.first_at
            AND roster.captured_at AT TIME ZONE 'UTC' <= observed.first_at
            AND (roster.end_time IS NULL OR roster.end_time > observed.last_at)
            AND (roster.scheduled_end_at IS NULL OR roster.scheduled_end_at AT TIME ZONE 'UTC' > observed.last_at)
            AND roster.start_time+interval '12 hours' > observed.last_at) AS covers_observations
        FROM observed LEFT JOIN expected USING(student_id) LEFT JOIN roster USING(student_id) GROUP BY observed.student_id
      ) SELECT (SELECT COUNT(*)::int FROM classpilot_ai_decisions WHERE school_id=$1 AND created_at >= $2::timestamp) AS "currentAiDecisionRows",
        (SELECT COUNT(*)::int FROM checked WHERE memberships<>1 OR covers_observations IS DISTINCT FROM true) AS "invalidRosterStudents"`,
      [...observationBounds, JSON.stringify(school.students.map((student_id, index) => ({ student_id, group_id: school.groups[Math.floor(index / 5)] })))])).rows[0];
      const fixtureViolations = currentObservationFixtureViolations(raw, school.students, fixtureCounts);
      const verification = { schoolIndex: school.index, fixtureViolations, correct: false };
      currentDayWorkers.push(verification); save();
      assert.ok(Object.values(fixtureViolations).every(count => count === 0), 'Current-day one-grain fixture invariant failed');
      const observed = currentObservationSeconds(raw, cutoff); liveBySchool.set(school.index, observed);
      const expectedSeconds = [...observed.values()].reduce((sum, value) => sum + value, 0);
      Object.assign(verification, { expectedSeconds, timestampPrecision: currentObservationDiagnostics(raw, cutoff) }); save();
      const result = await worker.rpc('rollup', { schoolId: school.id, date: today, cutoff: cutoff.toISOString() });
      Object.assign(verification, result, { correct: result.seconds === expectedSeconds }); save();
      assert.equal(result.seconds, expectedSeconds);
      assert.ok(result.durationMs <= RELEASE_ENABLED_PROFILE.fullWorkerAcceptanceMs, 'Current-day complete rollup exceeded48seconds');
    }
    const exports = await generator.rpc('correctness');
    for (const row of exports) {
      const school = fixture.schools[row.schoolIndex], live = liveBySchool.get(row.schoolIndex), size = { school: 500, grade: 100, class: 5, student: 1 }[row.scope];
      const included = school.students.filter((_, i) => row.scope === 'school' || (row.scope === 'grade' ? i % 5 === 0 : row.scope === 'class' ? i < 5 : i === 0));
      const currentSeconds = included.reduce((sum, id) => sum + (live.get(id) || 0), 0);
      const expected = fixture.historyDays * 90 * size + schoolDayOracle(row.scope).monitored + currentSeconds;
      assert.equal(row.report.totals.monitoredBrowserSeconds, expected);
      assert.equal(row.report.byDay.find(day => day.date === today)?.monitoredBrowserSeconds, currentSeconds);
      assert.ok(row.csv.includes(`\"Total\",\"\",\"${(expected / 60).toFixed(1)}\"`));
      delete row.csv;
    }
    for (const school of fixture.schools) assert.equal((await observer.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE school_id=$1 AND action='classpilot.usage.export'", [school.id])).rows[0].count, 4);
    metrics.correctness = { passed: true, currentObservationCutoff: cutoff.toISOString(), currentDayWorkers, csvAuditCount: 8, exports };
    const finalRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const finalClean = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
    metrics.sourceAtFinish = { revision: finalRevision, clean: finalClean };
    metrics.sourceUnchangedAtFinish = finalRevision === source && finalClean && files.every(name => digest(readFileSync(resolve(root, 'scripts/load/usage', name))) === sourceHashes[name]);
    metrics.acceptance = capacityAcceptance(metrics); metrics.capacityAccepted = Object.values(metrics.acceptance).every(Boolean);
    metrics.finishedAt = new Date().toISOString(); save();
    assert.equal(metrics.capacityAccepted, true, 'Release-enabled capacity acceptance failed; preserved full diagnostic evidence');
  }
} catch (error) {
  metrics.failure = { name: error.name, code: error.code || 'FIXTURE_FAILURE', message: String(error.message).slice(0, 800) }; save(); process.exitCode = 1;
} finally {
  clearInterval(sampling);
  for (const owner of children.reverse()) {
    if (owner.process.exitCode === null && owner.process.connected) {
      try { await owner.rpc('shutdown', undefined, 15_000); } catch { owner.process.kill(); }
    }
    const watchdog = setTimeout(() => owner.process.kill(), 15_000);
    const exit = await owner.closed; clearTimeout(watchdog); await finished(owner.stdout);
    if (exit.code !== 0) { metrics.childCleanupFailure = true; process.exitCode = 1; }
  }
  await observer.end();
  if (collectCpuProfile) {
    try {
      const bytes = readFileSync(resolve(directory, 'api.cpuprofile')), profile = JSON.parse(bytes.toString('utf8'));
      assert.ok(profile.nodes?.length > 0 && profile.samples?.length > 0, 'API CPU profile must contain real samples');
      Object.assign(metrics.cpuProfile, { sha256: digest(bytes), bytes: bytes.length, samples: profile.samples.length, startTime: profile.startTime, endTime: profile.endTime });
    } catch (error) { metrics.cpuProfile.collectionFailure = String(error.message).slice(0, 300); process.exitCode = 1; }
  }
  metrics.childShutdownClean = metrics.childCleanupFailure !== true;
  if (metrics.acceptance) metrics.acceptance.ownedProcessCleanup = metrics.childShutdownClean;
  if (!metrics.childShutdownClean) metrics.capacityAccepted = false;
  save();
  console.log(JSON.stringify({ event: 'release_enabled_usage_complete', sourceRevision: source, capacityAccepted: metrics.capacityAccepted, diagnosticOnly: metrics.diagnosticOnly === true, output }));
}
