import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SOURCES, sha256 } from './relocation.mjs';
import { SNAPSHOT_FILES, fixtureCommands, cleanFixtureEnvironment, fixtureEnvironment, verifyCompiledApplication, collectNativeFacts, AUTHORITY_SQL } from './prepare-fixture.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(path.join(parent, 'usage-linux-producer-'));
  t.after(() => { const resolved = realpathSync(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^usage-linux-producer-/); rmSync(resolved, { recursive: true }); }); return root;
}
function put(root, file, value) {
  const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const bytes = typeof value === 'string' ? value : JSON.stringify(value); writeFileSync(target, bytes, { mode: 0o600 }); return { path: target, sha256: sha256(bytes) };
}

test('producer preserves original expand executor, bounded full cold seeder/control commands, and nine native payloads', () => {
  const root = path.resolve('source'), commands = fixtureCommands(root);
  assert.deepEqual(commands, [
    { stage: 'original53-executor', args: [path.join(root, 'scripts/load/usage/release-gates-v2/migrate-bound-fixture.mjs'), root], timeout: 300000 },
    { stage: 'full-original-cold-prepare', args: ['scripts/load/usage/bounded-fixture-step.mjs', '900000', '--max-old-space-size=512', '--import', './tests/test-environment.mjs', 'scripts/load/usage/local-cold-open-loop-scale.mjs'], timeout: 930000 },
    { stage: 'canonical-release-control-backfill', args: ['scripts/load/usage/bounded-fixture-step.mjs', '120000', '--max-old-space-size=512', 'scripts/load/usage/prepare-release-control-ownership.mjs'], timeout: 150000 },
  ]);
  assert.equal(SNAPSHOT_FILES.length, 9); assert.ok(SNAPSHOT_FILES.includes('prepared-database.private.dump'));
  assert.ok(SNAPSHOT_FILES.includes('synthetic-roles.private.sql')); assert.ok(SNAPSHOT_FILES.includes('post-convergence-schema.sql'));
});

function environment() {
  const run = 'a'.repeat(12), password = 'synthetic';
  return { run, output: path.resolve('output'), endpoint: 'unix:///var/run/docker.sock', envelopeFile: path.resolve('envelope.json'), tables: ['one'],
    adminUrl: `postgresql://scale_fixture_${run}:${password}@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${run}`,
    appUrl: `postgresql://scale_app_${run}:${password}@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${run}`,
    secrets: { JWT_SECRET: '1'.repeat(64), SESSION_SECRET: '2'.repeat(64), STUDENT_TOKEN_SECRET: '3'.repeat(64) },
    ambient: { PATH: '/usr/bin', HOME: '/home/ubuntu', AWS_ACCESS_KEY_ID: 'do-not-inherit', SENDGRID_API_KEY: 'do-not-inherit', NODE_OPTIONS: '--import malicious', DATABASE_URL: 'production', DOCKER_CONTEXT: 'remote' } };
}
test('fixture children inherit only bounded ambient keys and exact synthetic local DB/Unix endpoint, never operator credentials', () => {
  const options = environment(), env = fixtureEnvironment(options);
  assert.deepEqual(cleanFixtureEnvironment(options.ambient), { PATH: '/usr/bin', HOME: '/home/ubuntu' });
  for (const key of ['AWS_ACCESS_KEY_ID', 'SENDGRID_API_KEY', 'NODE_OPTIONS', 'DOCKER_CONTEXT']) assert.equal(env[key], undefined);
  assert.equal(env.DOCKER_HOST, options.endpoint); assert.equal(env.DATABASE_URL, options.appUrl); assert.equal(env.ADMIN_DATABASE_URL, options.adminUrl);
  assert.equal(env.CLASSPILOT_USAGE_ROLLUP_MODE, 'on'); assert.equal(env.CLASSPILOT_DIGITAL_USAGE_MODE, 'on');
  assert.equal(env.SCHEDULER_ENABLED, 'false'); assert.equal(env.APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS, 'false');
  assert.equal(env.USAGE_SCALE_COLD_PHASE, 'prepare'); assert.equal(env.USAGE_SOURCE_REVISION, SOURCES.candidate);
});
test('fixture producer refuses remote/foreign databases, remote daemon, and arbitrary secret environment injection', () => {
  const options = environment();
  for (const patch of [{ appUrl: options.appUrl.replace('127.0.0.1', 'database.example') }, { adminUrl: options.adminUrl.replace('5437', '5435') }, { endpoint: 'tcp://remote:2375' }, { secrets: { ...options.secrets, SENDGRID_API_KEY: 'real' } }]) assert.throws(() => fixtureEnvironment({ ...options, ...patch }));
});

test('full dist inventory and separate exact review are required; four selected files or one changed byte cannot pass', async t => {
  const root = fixture(t), files = {};
  for (const rel of ['app.js', 'db.js', 'db/migrations27.js', 'db/migrationLedger.js', 'db/classpilotHeartbeatScreenshotEvidenceInstallation.js', 'services/classpilotUsageRollup.js', 'util/schoolTime.js']) {
    files[rel] = put(root, `dist/${rel}`, `actual-image:${rel}`).sha256;
  }
  const image = `sha256:${'a'.repeat(64)}`, ref = put(root, 'extraction.json', { schemaVersion: 1, kind: 'usage_linux_full_compiled_application_extraction', source: SOURCES.candidate, image, files });
  const review = put(root, 'review.json', { schemaVersion: 1, kind: 'usage_linux_compiled_application_review', subjectSha256: ref.sha256, disposition: 'reviewed_for_synthetic_execution', reviewer: 'independent test fixture', reviewedAtUtc: '2026-10-12T12:00:00Z', capacityAccepted: false, productionReadiness: false, operationalAuthorization: false });
  await verifyCompiledApplication(ref, review, root, image);
  await assert.rejects(verifyCompiledApplication(ref, review, root, `sha256:${'b'.repeat(64)}`), /COMPILED_APPLICATION_IDENTITY/);
  put(root, 'dist/app.js', 'different'); await assert.rejects(verifyCompiledApplication(ref, review, root, image), /COMPILED_APPLICATION_DRIFT/);
});

function fakeDatabase({ failCatalog = false } = {}) {
  const calls = [], closed = [], role = { currentUser: 'restricted', expectedUser: 'restricted', rolsuper: false, rolbypassrls: false, rolinherit: false };
  class Client {
    constructor({ connectionString }) { this.url = connectionString; }
    async connect() { calls.push(['connect', this.url]); }
    async end() { closed.push(this.url); }
    async query(sql, values) {
      calls.push([sql, values]);
      if (this.url === 'app') return { rows: [role] };
      if (sql === 'BEGIN READ ONLY' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('schema_migrations')) return { rows: [{ id: 'expand', checksum: 'a'.repeat(64), status: 'complete' }] };
      if (sql.includes('FROM pg_class')) { if (failCatalog) throw Object.assign(Error('synthetic query refusal'), { code: '42501' }); return { rows: [{ relname: 'one', relrowsecurity: true, relforcerowsecurity: true, tenantPolicy: true }] }; }
      if (sql.includes('FROM heartbeats')) return { rows: [{ schoolId: 'a', observations: 1000001 }, { schoolId: 'b', observations: 1000001 }] };
      if (sql.includes('server_encoding')) return { rows: [{ encoding: 'UTF8', timezone: 'UTC', serverVersion: '16.15' }] };
      assert.equal(sql, AUTHORITY_SQL); return { rows: [{ schoolId: values[0], otherClients: 0, requiredValidUntil: values[1] }] };
    }
  }
  return { Client, calls, closed, role };
}
test('native fact collection uses restricted real-role connection first, one read-only transaction, parameterized school/expiry SQL, and all raw rows', async () => {
  const db = fakeDatabase(), raw = {}, through = Date.parse('2026-10-12T20:00:00Z');
  const facts = await collectNativeFacts({ ...db, adminUrl: 'admin', appUrl: 'app', schoolIds: ['a', 'b'], tables: ['one'], through, saveRaw: async (key, value) => { assert.equal(raw[key], undefined); raw[key] = value; return { path: key, sha256: sha256(JSON.stringify(value)) }; } });
  assert.deepEqual(db.closed, ['app', 'admin']); assert.equal(facts.heartbeatRows, 2000002);
  assert.deepEqual(Object.keys(raw).sort(), ['authority', 'catalog', 'migrations', 'restrictedRole', 'runtime', 'schoolCounts']);
  for (const key of Object.keys(raw)) assert.deepEqual(raw[key], facts[key]);
  const queries = db.calls.filter(row => row[0] === AUTHORITY_SQL); assert.deepEqual(queries.map(row => row[1]), [['a', new Date(through).toISOString()], ['b', new Date(through).toISOString()]]);
  assert.ok(db.calls.some(row => row[0] === 'BEGIN READ ONLY')); assert.ok(db.calls.some(row => row[0] === 'COMMIT'));
  assert.ok(!db.calls.some(row => /\b(?:INSERT|UPDATE|DELETE|ALTER)\b/.test(row[0])));
});
test('a query failure retains already selected ledger/role rows and closes both connections without inventing later evidence', async () => {
  const db = fakeDatabase({ failCatalog: true }), raw = {};
  await assert.rejects(collectNativeFacts({ ...db, adminUrl: 'admin', appUrl: 'app', schoolIds: ['a', 'b'], tables: ['one'], through: Date.now(), saveRaw: async (key, value) => { raw[key] = value; return { path: key, sha256: sha256(JSON.stringify(value)) }; } }), { code: '42501' });
  assert.deepEqual(db.closed, ['app', 'admin']); assert.deepEqual(Object.keys(raw).sort(), ['migrations', 'restrictedRole']);
  assert.equal(raw.catalog, undefined); assert.equal(raw.authority, undefined);
});
