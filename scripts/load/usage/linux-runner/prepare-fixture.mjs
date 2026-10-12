import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guard, SOURCES, FREEZE_SHA256, sha256, hashFile, readReference, verifyReference, safePath, writeNewJson, readCliRequest, isMain, cliFailure } from './relocation.mjs';
import { verifyFrozenInputs, verifyReview, assertNativeFixtureFacts, schoolDate } from './preflight.mjs';

export const SNAPSHOT_FILES = Object.freeze(['prepared-database.private.dump', 'synthetic-roles.private.sql', 'cold-fixture-state.json', 'release-control-preparation.json', 'preparation-fixture-contract.json', 'preparation-metrics.json', 'schema-fingerprint.json', 'post-convergence-schema.sql', 'measurement-ready.json']);
export function fixtureCommands(sourceDirectory) {
  return [
    { stage: 'original53-executor', args: [path.join(sourceDirectory, 'scripts/load/usage/release-gates-v2/migrate-bound-fixture.mjs'), sourceDirectory], timeout: 300_000 },
    { stage: 'full-original-cold-prepare', args: ['scripts/load/usage/bounded-fixture-step.mjs', '900000', '--max-old-space-size=512', '--import', './tests/test-environment.mjs', 'scripts/load/usage/local-cold-open-loop-scale.mjs'], timeout: 930_000 },
    { stage: 'canonical-release-control-backfill', args: ['scripts/load/usage/bounded-fixture-step.mjs', '120000', '--max-old-space-size=512', 'scripts/load/usage/prepare-release-control-ownership.mjs'], timeout: 150_000 },
  ];
}
export function cleanFixtureEnvironment(ambient) {
  // An allowlist, so AWS/provider credentials and development DB URLs cannot enter the child.
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => typeof ambient[key] === 'string').map(key => [key, ambient[key]]));
}
export function fixtureEnvironment({ output, run, endpoint, adminUrl, appUrl, envelopeFile, tables, secrets, ambient = process.env }) {
  guard(/^[a-f0-9]{12}$/.test(run), 'FIXTURE_RUN_ID');
  guard(/^unix:\/\/\/[^\s?#]+$/.test(endpoint) && !endpoint.slice(7).split('/').includes('..'), 'FIXTURE_DOCKER_ENDPOINT');
  for (const [url, user] of [[adminUrl, `scale_fixture_${run}`], [appUrl, `scale_app_${run}`]]) {
    const parsed = new URL(url); guard(parsed.protocol === 'postgresql:' && parsed.hostname === '127.0.0.1' && parsed.port === '5437' && parsed.username === user && parsed.pathname === `/schoolpilot_redesign_usage_scale_${run}` && !parsed.search && !parsed.hash, 'FIXTURE_DATABASE_ENDPOINT');
  }
  guard(Object.keys(secrets).sort().join(',') === 'JWT_SECRET,SESSION_SECRET,STUDENT_TOKEN_SECRET' && Object.values(secrets).every(value => /^[a-f0-9]{64}$/.test(value)), 'FIXTURE_SYNTHETIC_SECRET_SHAPE');
  return { ...cleanFixtureEnvironment(ambient), DOCKER_HOST: endpoint, NODE_ENV: 'test', REDIS_URL: '', RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: tables.join(','), SCHEDULER_ENABLED: 'false',
    USAGE_LOCAL_SCALE: '1', USAGE_SCALE_CONTAINER: `schoolpilot-usage-scale-${run}`, USAGE_SOURCE_REVISION: SOURCES.candidate,
    USAGE_SCALE_RLS_INVENTORY: 'classpilotPrivateChatLifecyclePostExpand', USAGE_SCALE_SOURCE_BINDING_FILE: envelopeFile,
    APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS: 'false', DATABASE_URL: appUrl, DATABASE_URL_PRIVILEGED: appUrl, ADMIN_DATABASE_URL: adminUrl,
    ...secrets, DOTENV_CONFIG_PATH: path.join(output, 'private', 'absent-dotenv'), DOTENV_CONFIG_QUIET: 'true', DB_POOL_MIN: '0', SESSION_DB_POOL_MIN: '0',
    CLASSPILOT_USAGE_ROLLUP_MODE: 'on', CLASSPILOT_DIGITAL_USAGE_MODE: 'on', CLASSPILOT_DAILY_USAGE_ROLLUP_MODE: 'shadow',
    CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE: 'off', PASSPILOT_RULES_MODE: 'off', PASSPILOT_APPOINTMENTS_MODE: 'off', PASSPILOT_REPORTS_MODE: 'off',
    CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1: 'false', CLASSPILOT_CAP_FOCUS_TAB_V1: 'false', CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1: 'false',
    CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: '{"preciseRestrictionResourcesV1":{"mode":"off"},"focusTabV1":{"mode":"off"},"privateChatLifecycleV1":{"mode":"off"}}',
    RUN_LEGACY_MIGRATIONS_ONLY: 'false', RUN_MIGRATIONS_ONLY: 'false', USAGE_RELEASE_PHASE: 'combined', USAGE_SCALE_COLD_PHASE: 'prepare',
    USAGE_SCALE_OUTPUT: path.join(output, 'preparation-metrics.json'), USAGE_SCALE_COLD_STATE: path.join(output, 'cold-fixture-state.json'), USAGE_SCALE_CAPS: path.join(output, 'resource-caps.json') };
}
export async function verifyCompiledApplication(ref, reviewRef, sourceDirectory, expectedImage) {
  const receipt = await readReference(ref, { privateMode: true });
  guard(receipt.schemaVersion === 1 && receipt.kind === 'usage_linux_full_compiled_application_extraction' && receipt.source === SOURCES.candidate && receipt.image === expectedImage, 'COMPILED_APPLICATION_IDENTITY');
  guard(receipt.files && typeof receipt.files === 'object' && !Array.isArray(receipt.files), 'COMPILED_APPLICATION_INVENTORY_REQUIRED');
  const root = safePath(path.join(sourceDirectory, 'dist'), { directory: true, privateMode: true });
  const actual = [];
  function list(directory, prefix = '') { for (const item of readdirSync(directory, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name; guard(!item.isSymbolicLink(), 'COMPILED_APPLICATION_SYMLINK');
    if (item.isDirectory()) list(safePath(path.join(directory, item.name), { root, directory: true, privateMode: true }), rel);
    else actual.push(rel);
  } }
  list(root); assert.deepEqual(actual.sort(), Object.keys(receipt.files).sort());
  for (const rel of actual) { guard(!rel.includes('..') && !rel.includes('\\'), 'COMPILED_APPLICATION_PATH'); guard(await hashFile(safePath(path.join(root, rel), { root, privateMode: true })) === receipt.files[rel], 'COMPILED_APPLICATION_DRIFT'); }
  for (const required of ['app.js', 'db.js', 'db/migrations27.js', 'db/migrationLedger.js', 'db/classpilotHeartbeatScreenshotEvidenceInstallation.js', 'services/classpilotUsageRollup.js', 'util/schoolTime.js']) guard(actual.includes(required), 'COMPILED_APPLICATION_INCOMPLETE');
  await verifyReview(reviewRef, ref.sha256, 'usage_linux_compiled_application_review');
  return receipt;
}

// These are narrow read-only results, retained before assertions. NULL expiry is
// preserved; active row coverage and every expiry count are independently checked.
export const AUTHORITY_SQL = `SELECT $1::text AS "schoolId", clock_timestamp()::text AS "observedAtUtc", $2::timestamptz::text AS "requiredValidUntil",
 (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') AS "otherClients",
 (SELECT COUNT(*)::int FROM schools WHERE id=$1 AND is_active AND status='active' AND deleted_at IS NULL AND disabled_at IS NULL) AS "schoolActiveRows",
 (SELECT COUNT(*)::int FROM product_licenses WHERE school_id=$1 AND product='CLASSPILOT' AND status='active') AS "licenseRows",
 (SELECT COUNT(*)::int FROM classpilot_student_control_states WHERE school_id=$1) AS "controlRows",
 (SELECT COUNT(*)::int FROM teaching_sessions WHERE school_id=$1 AND end_time IS NULL) AS "teachingRows",
 (SELECT COUNT(*)::int FROM student_sessions ss JOIN students s ON s.id=ss.student_id WHERE s.school_id=$1 AND ss.is_active AND ss.ended_at IS NULL AND ss.auth_kind='manual_shared') AS "manualSharedRows",
 (SELECT MIN(active_until)::text FROM schools WHERE id=$1) AS "schoolActiveUntil",
 (SELECT MIN(expires_at)::text FROM product_licenses WHERE school_id=$1 AND product='CLASSPILOT' AND status='active') AS "licenseExpiresAt",
 (SELECT MIN(hard_expires_at)::text FROM classpilot_student_control_states WHERE school_id=$1) AS "controlHardExpiry",
 (SELECT MIN(scheduled_end_at)::text FROM teaching_sessions WHERE school_id=$1 AND end_time IS NULL) AS "teachingScheduledEnd",
 (SELECT MIN(manual_lease_expires_at)::text FROM student_sessions ss JOIN students s ON s.id=ss.student_id WHERE s.school_id=$1 AND ss.is_active AND ss.ended_at IS NULL AND ss.auth_kind='manual_shared') AS "manualSharedLeaseUntil",
 (SELECT COUNT(*)::int FROM schools WHERE id=$1 AND active_until IS NOT NULL AND active_until<=$2::timestamptz AT TIME ZONE 'UTC') AS "schoolExpiries",
 (SELECT COUNT(*)::int FROM product_licenses WHERE school_id=$1 AND product='CLASSPILOT' AND expires_at IS NOT NULL AND expires_at<=$2::timestamptz AT TIME ZONE 'UTC') AS "licenseExpiries",
 (SELECT COUNT(*)::int FROM classpilot_student_control_states WHERE school_id=$1 AND hard_expires_at<=$2::timestamptz) AS "controlExpiries",
 (SELECT COUNT(*)::int FROM teaching_sessions WHERE school_id=$1 AND end_time IS NULL AND scheduled_end_at IS NOT NULL AND scheduled_end_at<=$2::timestamptz) AS "teachingExpiries",
 (SELECT COUNT(*)::int FROM student_sessions ss JOIN students s ON s.id=ss.student_id WHERE s.school_id=$1 AND ss.is_active AND ss.ended_at IS NULL AND ss.auth_kind='manual_shared' AND (ss.manual_lease_expires_at IS NULL OR ss.manual_lease_expires_at<=$2::timestamptz)) AS "manualSessionExpiries"`;

export async function collectNativeFacts({ Client, adminUrl, appUrl, schoolIds, tables, through, saveRaw }) {
  const roleClient = new Client({ connectionString: appUrl, connectionTimeoutMillis: 5000, statement_timeout: 120_000 }); let restrictedRole, roleRef;
  try { await roleClient.connect(); restrictedRole = (await roleClient.query('SELECT current_user AS "currentUser",session_user AS "expectedUser",rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0]; }
  finally { await roleClient.end(); if (restrictedRole !== undefined) roleRef = await saveRaw('restrictedRole', restrictedRole); }
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000, statement_timeout: 120_000 });
  const facts = { restrictedRole }, rawResults = {};
  try {
    await client.connect(); await client.query('BEGIN READ ONLY');
    facts.migrations = (await client.query('SELECT id,checksum,status FROM schema_migrations ORDER BY id')).rows;
    facts.catalog = (await client.query(`SELECT relname,relrowsecurity,relforcerowsecurity,
      EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation') AS "tenantPolicy"
      FROM pg_class c WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname`, [tables])).rows;
    facts.schoolCounts = (await client.query('SELECT school_id AS "schoolId",COUNT(*)::int AS observations FROM heartbeats GROUP BY school_id ORDER BY school_id')).rows;
    facts.heartbeatRows = facts.schoolCounts.reduce((n, row) => n + row.observations, 0);
    facts.runtime = (await client.query("SELECT current_setting('server_encoding') AS encoding,current_setting('TimeZone') AS timezone,current_setting('server_version') AS \"serverVersion\"")).rows[0];
    Object.assign(facts, facts.runtime);
    facts.authority = [];
    for (const id of schoolIds) facts.authority.push((await client.query(AUTHORITY_SQL, [id, new Date(through).toISOString()])).rows[0]);
    await client.query('COMMIT');
  } finally {
    await client.end();
    for (const key of ['migrations', 'catalog', 'schoolCounts', 'authority', 'runtime']) if (facts[key] !== undefined) rawResults[key] = await saveRaw(key, facts[key]);
  }
  rawResults.restrictedRole = roleRef;
  return { ...facts, rawResults };
}

const INSPECT = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Config":{"Image":{{json .Config.Image}},"Labels":{{json .Config.Labels}}},"HostConfig":{"NanoCpus":{{json .HostConfig.NanoCpus}},"Memory":{{json .HostConfig.Memory}},"MemorySwap":{{json .HostConfig.MemorySwap}},"Privileged":{{json .HostConfig.Privileged}},"PortBindings":{{json .HostConfig.PortBindings}}},"Mounts":{{json .Mounts}},"State":{"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"OOMKilled":{{json .State.OOMKilled}},"StartedAt":{{json .State.StartedAt}}}}';
export async function prepareFixture(request, { verifyInputs = verifyFrozenInputs, spawn = spawnSync, now = Date.now } = {}) {
  guard(request.schemaVersion === 1 && request.kind === 'usage_linux_fixture_preparation_request', 'FIXTURE_REQUEST_SCHEMA');
  const intent = await readReference(request.intent, { privateMode: true });
  await verifyReview(request.independentPreparationReview, request.intent.sha256, 'usage_linux_fixture_preparation_review');
  guard(intent.kind === 'usage_linux_fixture_preparation_intent' && intent.freezeSha256 === FREEZE_SHA256 && intent.outputRoot === request.outputRoot && intent.run === request.run && intent.inputsSha256 === request.inputs.sha256, 'FIXTURE_INTENT_BINDING');
  guard(intent.compiledApplicationSha256 === request.compiledApplication.sha256 && intent.compiledApplicationReviewSha256 === request.compiledApplicationReview.sha256, 'FIXTURE_COMPILED_INTENT_BINDING');
  for (const name of ['relocation', 'preflight', 'prepare-fixture']) guard(intent.toolSha256?.[name] === await hashFile(path.join(path.dirname(fileURLToPath(import.meta.url)), `${name}.mjs`)), 'FIXTURE_REVIEWED_TOOL_DRIFT');
  const input = await readReference(request.inputs, { privateMode: true }), context = await verifyInputs(input);
  const { freeze, canonical, envelope } = context;
  guard(/^[a-f0-9]{12}$/.test(request.run), 'FIXTURE_RUN_ID');
  const through = Date.parse(intent.validThroughUtc); guard(Number.isFinite(through) && through > now() && schoolDate(through - 1) === schoolDate(now()), 'FIXTURE_DATE_HORIZON');
  await verifyCompiledApplication(request.compiledApplication, request.compiledApplicationReview, freeze.sourceDirectory, envelope.binding.applicationImage);
  const output = safePath(request.outputRoot, { directory: true, privateMode: true }); guard(readdirSync(output).length === 0, 'FIXTURE_OUTPUT_NOT_FRESH');
  for (const dir of ['private', 'snapshot']) mkdirSync(path.join(output, dir), { mode: 0o700 });
  const snapshotDirectory = path.join(output, 'snapshot'), save = (name, value) => writeNewJson(path.join(output, name), value, output);
  const saveBytes = (name, bytes) => writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  const raw = (exe, args, options = {}) => { const result = spawn(exe, args, { encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 180_000, maxBuffer: 64 * 1024 ** 2, cwd: freeze.sourceDirectory, env: options.env ?? cleanFixtureEnvironment(process.env), input: options.input });
    if (options.log) saveBytes(options.log, (result.stdout ?? '') + (result.stderr ?? ''));
    guard(!result.error && result.status === 0 && !result.signal, 'FIXTURE_CHILD_OPERATION_FAILED'); return (result.stdout ?? '') + (exe === 'docker' && args.includes('logs') ? (result.stderr ?? '') : ''); };
  const docker = (args, options) => raw('docker', ['--host', input.endpoint, ...args], options);
  const run = request.run, name = `schoolpilot-usage-scale-${run}`, database = `schoolpilot_redesign_usage_scale_${run}`, owner = `scale_fixture_${run}`, app = `scale_app_${run}`;
  const password = randomBytes(24).toString('hex'), appPassword = randomBytes(24).toString('hex');
  const adminUrl = `postgresql://${owner}:${password}@127.0.0.1:5437/${database}`, appUrl = `postgresql://${app}:${appPassword}@127.0.0.1:5437/${database}`;
  const find = () => docker(['container', 'ls', '-a', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']).trim();
  let id, volumes = [], fresh = false, generationCleanup, stage = 'freshness', manifestSha256, passed = false, nativeFacts;
  const inspect = () => JSON.parse(docker(['inspect', '--format', INSPECT, id]));
  const verify = () => { const row = inspect(); guard(row.Id === id && row.Name === `/${name}` && row.Config.Image === freeze.postgresImage && row.Config.Labels['codex.fixture-preparation'] === run && row.Config.Labels['codex.usage-scale'] === run, 'FIXTURE_OWNERSHIP');
    guard(row.HostConfig.NanoCpus === 4e9 && row.HostConfig.Memory === 4 * 1024 ** 3 && row.HostConfig.MemorySwap === 4 * 1024 ** 3 && row.HostConfig.Privileged === false, 'FIXTURE_RESOURCE_CAPS');
    assert.deepEqual(row.HostConfig.PortBindings, { '5437/tcp': [{ HostIp: '127.0.0.1', HostPort: '5437' }] }); return row; };
  const result = { schemaVersion: 1, kind: 'usage_linux_fresh_fixture_generation', source: SOURCES.candidate, run, capacityAccepted: false, measuredLoadStarted: false, productionReadiness: false, cleanupPassed: false };
  const grant = `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${app}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}; REVOKE EXECUTE ON FUNCTION public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text) TO ${app};`;
  try {
    guard(find() === '', 'FIXTURE_NAME_PREEXISTS'); fresh = true;
    const envFile = path.join(output, 'private/postgres.env'); writeFileSync(envFile, `POSTGRES_USER=${owner}\nPOSTGRES_DB=${database}\nPOSTGRES_PASSWORD=${password}\nPGPORT=5437\n`, { flag: 'wx', mode: 0o600 });
    stage = 'create';
    try { id = docker(['run', '--detach', '--name', name, '--label', `codex.usage-scale=${run}`, '--label', `codex.fixture-preparation=${run}`, '--cpus', '4', '--memory', '4g', '--memory-swap', '4g', '--publish', '127.0.0.1:5437:5437', '--env-file', envFile, freeze.postgresImage, 'postgres', '-p', '5437'], { log: 'postgres-create.log' }).trim(); }
    finally { const found = find(); if (found) { guard(/^[a-f0-9]{64}$/.test(found), 'FIXTURE_ID'); id = found; verify(); } }
    const initial = verify(); volumes = initial.Mounts.filter(row => row.Type === 'volume').map(row => row.Name);
    guard(initial.Mounts.length === 1 && initial.Mounts[0].Type === 'volume' && initial.Mounts[0].Destination === '/var/lib/postgresql/data' && initial.Mounts[0].RW === true && /^[a-f0-9]{64}$/.test(volumes[0]), 'FIXTURE_VOLUME_IDENTITY');
    save('owned-postgres.json', { id, name, run, volumes, image: freeze.postgresImage }); save('resource-caps.json', initial.HostConfig);
    const { waitForPostgresReady } = await import(pathToFileURL(path.join(freeze.harnessDirectory, 'scripts/load/usage/release-gates-v2/postgres-readiness.mjs')));
    await waitForPostgresReady({ docker, id, owner, database, startedAt: initial.State.StartedAt, fresh: true });
    const psql = ['exec', '-i', id, 'psql', '-p', '5437', '-U', owner, '-d', database, '-v', 'ON_ERROR_STOP=1'];
    docker(psql, { input: readFileSync(freeze.schemaFile), log: 'schema-restore.log' });
    docker(psql, { input: `CREATE ROLE ${app} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${appPassword}'; GRANT USAGE ON SCHEMA public TO ${app}; ${grant}`, log: 'restricted-role.log' });
    save('usage-source-binding-envelope.json', envelope);
    const env = fixtureEnvironment({ output, run, endpoint: input.endpoint, adminUrl, appUrl, envelopeFile: path.join(output, 'usage-source-binding-envelope.json'), tables: envelope.binding.rlsTables,
      secrets: { JWT_SECRET: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'), STUDENT_TOKEN_SECRET: randomBytes(32).toString('hex') } });
    // Preserve selected registry order; the original producer validates this exact string.
    env.RLS_ENABLED_TABLES = JSON.parse(readFileSync(path.join(freeze.sourceDirectory, 'src/config/rlsRegistry.json'))).inventories.classpilotPrivateChatLifecyclePostExpand.tables.join(',');
    for (const command of fixtureCommands(freeze.sourceDirectory)) {
      stage = command.stage;
      if (stage === 'canonical-release-control-backfill') env.USAGE_SCALE_COLD_STATE_SHA256 = await hashFile(env.USAGE_SCALE_COLD_STATE);
      const commandEnv = stage === 'original53-executor' ? { ...env, DATABASE_URL: adminUrl, DATABASE_URL_PRIVILEGED: adminUrl } : env;
      raw(process.execPath, command.args, { env: commandEnv, timeout: command.timeout, log: `${stage}.log` });
      if (stage === 'original53-executor') { docker(psql, { input: grant }); const schema = docker(['exec', id, 'pg_dump', '-p', '5437', '-U', owner, '-d', database, '--schema-only', '--no-owner', '--no-privileges']); guard(canonical.canonicalSchemaFingerprint(schema) === envelope.binding.canonicalSourceSchemaSha256, 'FIXTURE_SOURCE_SCHEMA'); saveBytes('post-convergence-schema.sql', schema); }
    }
    stage = 'export'; const state = JSON.parse(readFileSync(env.USAGE_SCALE_COLD_STATE));
    const { Client } = createRequire(path.join(freeze.sourceDirectory, 'package.json'))('pg');
    const queryFacts = async prefix => collectNativeFacts({ Client, adminUrl, appUrl, schoolIds: state.schools.map(row => row.id), tables: envelope.binding.rlsTables, through, saveRaw: async (key, value) => {
      save(`${prefix}-${key}.json`, value); return { path: path.join(output, `${prefix}-${key}.json`), sha256: await hashFile(path.join(output, `${prefix}-${key}.json`)) }; } });
    const before = await queryFacts('generation-before');
    save('measurement-ready.json', { schemaVersion: 1, kind: 'explicit_prepare_only_snapshot_hold', source: SOURCES.candidate, run, preparedAt: new Date(now()).toISOString(), coldPhase: 'prepare', measurementGoAbsent: true, timingHeld: true, measurementStarted: false, capacityAccepted: false });
    for (const file of ['cold-fixture-state.json', 'release-control-preparation.json', 'preparation-fixture-contract.json', 'preparation-metrics.json', 'post-convergence-schema.sql', 'measurement-ready.json']) copyFileSync(path.join(output, file), path.join(snapshotDirectory, file));
    writeNewJson(path.join(snapshotDirectory, 'schema-fingerprint.json'), { canonicalSha256: envelope.binding.canonicalSourceSchemaSha256, source: SOURCES.candidate }, output);
    docker(['exec', id, 'pg_dump', '-p', '5437', '-U', owner, '-d', database, '--format=custom', '--no-owner', '--no-privileges', '--file=/tmp/prepared.private.dump'], { timeout: 300_000, log: 'database-export.log' });
    docker(['cp', `${id}:/tmp/prepared.private.dump`, path.join(snapshotDirectory, SNAPSHOT_FILES[0])], { timeout: 300_000, log: 'database-export-copy.log' });
    writeFileSync(path.join(snapshotDirectory, 'synthetic-roles.private.sql'), docker(['exec', id, 'pg_dumpall', '-p', '5437', '-U', owner, '--roles-only']), { flag: 'wx', mode: 0o600 });
    const facts = await queryFacts('generation-after');
    for (const key of ['migrations', 'catalog', 'restrictedRole', 'schoolCounts', 'heartbeatRows', 'encoding', 'timezone', 'serverVersion']) assert.deepEqual(facts[key], before[key]);
    const records = []; for (const file of SNAPSHOT_FILES) { const bytes = readFileSync(path.join(snapshotDirectory, file)); records.push({ file, bytes: bytes.length, sha256: sha256(bytes) }); }
    const manifest = { schemaVersion: 1, source: SOURCES.candidate, preparedSchoolLocalDate: state.today, sourceUnchanged: true, timingHeld: true, measurementGoAbsent: !existsSync(path.join(output, 'measurement-go.json')), readOnlyExport: true,
      otherClientsBefore: Math.max(...before.authority.map(row => row.otherClients)), otherClientsAfter: Math.max(...facts.authority.map(row => row.otherClients)), timezone: facts.timezone, databaseEncoding: facts.encoding, serverVersion: facts.serverVersion,
      heartbeatRows: facts.heartbeatRows, migrations: facts.migrations.length, schoolCounts: state.schools.map((school, schoolIndex) => ({ schoolIndex, observations: facts.schoolCounts.find(row => row.schoolId === school.id).observations })),
      pgImage: freeze.postgresImage, credentials: { restrictedRole: app, fixtureOwner: owner }, records, capacityAccepted: false };
    canonical.assertUsageSourceCheckout(envelope, freeze.sourceDirectory); canonical.assertSnapshotManifest(manifest, { source: SOURCES.candidate, today: schoolDate(now()), usageSourceBinding: envelope });
    writeNewJson(path.join(snapshotDirectory, 'manifest.json'), manifest, output); manifestSha256 = await hashFile(path.join(snapshotDirectory, 'manifest.json'));
    const snapshot = canonical.loadSnapshot(snapshotDirectory, manifestSha256, { source: SOURCES.candidate, today: schoolDate(now()), usageSourceBinding: envelope });
    assertNativeFixtureFacts({ ...facts, source: SOURCES.candidate, snapshotManifestSha256: manifestSha256 }, envelope.binding, snapshot, { now: now(), through }); passed = true;
  } catch (error) { result.failure = { stage, code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'FIXTURE_PREPARATION_FAILED' }; }
  finally {
    if (fresh) try {
      const found = find(); if (found) { if (id) guard(found === id, 'FIXTURE_CLEANUP_ID_CHANGED'); id = found; let row = verify();
        if (row.State.Running) docker(['stop', '--time', '30', id], { log: 'postgres-stop.log' }); row = verify();
        saveBytes('postgres-final.log', docker(['logs', '--timestamps', id])); guard(row.State.Running === false, 'FIXTURE_STILL_RUNNING');
        docker(['rm', '--volumes', id], { log: 'postgres-remove.log' });
        generationCleanup = { id, name, forced: false, exitCode: row.State.ExitCode, oomKilled: row.State.OOMKilled, confirmedAbsent: find() === '' };
      }
      const actualVolumes = docker(['volume', 'ls', '--format', '{{.Name}}']).trim().split(/\r?\n/);
      guard(volumes.every(volume => !actualVolumes.includes(volume)), 'FIXTURE_VOLUME_REMAINS');
      result.cleanupPassed = generationCleanup?.confirmedAbsent === true && generationCleanup.exitCode === 0 && generationCleanup.oomKilled === false && volumes.length === 1;
    } catch { result.cleanupFailure = 'FIXTURE_OWNED_CLEANUP_UNPROVEN'; }
    save('generation-result.json', { ...result, passed: passed && result.cleanupPassed, generationCleanup, volumes });
  }
  guard(passed && result.cleanupPassed, 'FIXTURE_GENERATION_NOT_ACCEPTABLE');
  const { withUsageSnapshotV2 } = await import(pathToFileURL(path.join(freeze.harnessDirectory, 'scripts/load/usage/release-gates-v2/restore.mjs')));
  const restoreOutput = path.join(output, 'restricted-restore-proof'), restorePrivate = path.join(output, 'private', 'restore'), restoreRun = randomBytes(6).toString('hex');
  await withUsageSnapshotV2({ run: restoreRun, source: SOURCES.candidate, sourceDirectory: freeze.sourceDirectory, snapshotDirectory, snapshotManifestSha256: manifestSha256,
    evidenceDirectory: restoreOutput, privateDirectory: restorePrivate, endpoint: input.endpoint, mode: 'diagnostic', purpose: 'Fresh Linux fixture restricted native restore proof only; no measured campaign offers', usageSourceBinding: envelope }, async context => {
    const config = JSON.parse(readFileSync(context.configurationFile)), snapshot = canonical.loadSnapshot(snapshotDirectory, manifestSha256, { source: SOURCES.candidate, today: schoolDate(now()), usageSourceBinding: envelope });
    const { Client } = createRequire(path.join(freeze.sourceDirectory, 'package.json'))('pg');
    nativeFacts = await collectNativeFacts({ Client, adminUrl: config.adminUrl, appUrl: config.appUrl, schoolIds: snapshot.data['cold-fixture-state.json'].schools.map(row => row.id), tables: envelope.binding.rlsTables, through,
      saveRaw: async (key, value) => { save(`native-${key}.json`, value); const file = path.join(output, `native-${key}.json`); return { path: file, sha256: await hashFile(file) }; } });
    assertNativeFixtureFacts({ ...nativeFacts, source: SOURCES.candidate, snapshotManifestSha256: manifestSha256 }, envelope.binding, snapshot, { now: now(), through });
  });
  const restoredCleanup = JSON.parse(readFileSync(path.join(restoreOutput, 'cleanup.json'))), owned = JSON.parse(readFileSync(path.join(restoreOutput, 'owned-pg.json')));
  guard(restoredCleanup.cleanupPassed === true && restoredCleanup.forced === false && restoredCleanup.stopped?.ExitCode === 0, 'NATIVE_RESTORE_CLEANUP');
  const containers = docker(['container', 'ls', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}']).trim().split(/\r?\n/).filter(Boolean).map(line => { const [id, name] = line.split('\t'); return { id, name }; });
  const remainingVolumes = docker(['volume', 'ls', '--format', '{{.Name}}']).trim().split(/\r?\n/).filter(Boolean); save('final-resource-inventory.json', { containers, volumes: remainingVolumes });
  const rawRef = async name => ({ path: path.join(output, name), sha256: await hashFile(path.join(output, name)) });
  const proof = { schemaVersion: 1, kind: 'usage_linux_native_fixture_proof', source: SOURCES.candidate, snapshotManifestSha256: manifestSha256, ...nativeFacts,
    nativeReferenceInputSha256: await hashFile(path.join(snapshotDirectory, 'post-convergence-schema.sql')),
    nativeSchema: await rawRef('restricted-restore-proof/restored-schema.sql'), nativeReferenceSchema: await rawRef('restricted-restore-proof/reference-rendered-schema.sql'),
    cleanup: { containers: [generationCleanup, { id: owned.id, name: owned.name, exitCode: restoredCleanup.stopped.ExitCode, oomKilled: restoredCleanup.stopped.OOMKilled, forced: false, confirmedAbsent: restoredCleanup.confirmedAbsent }],
      volumes: [...volumes, ...owned.anonymousVolumes].map(name => ({ name, forced: false, confirmedAbsent: !remainingVolumes.includes(name) })), rawInventory: await rawRef('final-resource-inventory.json') },
    capacityAccepted: false, productionReadiness: false, operationalAuthorization: false };
  save('native-fixture-proof.json', proof);
  const selection = { schemaVersion: 1, kind: 'usage_linux_fixture_selection_pending_review', directory: snapshotDirectory, manifestSha256, nativeProof: await rawRef('native-fixture-proof.json'), independentReview: null,
    source: SOURCES.candidate, verifiedForMeasurement: false, capacityAccepted: false, productionReadiness: false };
  save('fixture-selection-pending-review.json', selection); return selection;
}
if (isMain(import.meta.url)) {
  try { const { request } = await readCliRequest('prepare', 'usage_linux_fixture_preparation_request'); const result = await prepareFixture(request);
    process.stdout.write(JSON.stringify({ prepared: true, snapshotManifestSha256: result.manifestSha256, independentReviewPending: true, capacityAccepted: false }) + '\n');
  } catch (error) { cliFailure(error); }
}
