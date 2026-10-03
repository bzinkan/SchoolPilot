// Synthetic baseline-to-candidate rehearsal. Never accepts a database URL,
// AWS credentials, existing container, or production records.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { rehearsalBuildSteps } from './rehearsal-build-steps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [baselineArg, baselineSha, outputArg, rollbackArg, rollbackSha] = process.argv.slice(2);
assert.ok(baselineArg && outputArg && /^[a-f0-9]{40}$/.test(baselineSha || ''),
  'Usage: node scripts/release/rehearse-local-upgrade.mjs <baseline-worktree> <verified-baseline-sha> <new-external-evidence-directory> [compatible-rollback-worktree compatible-rollback-sha]');
assert.ok((!rollbackArg && !rollbackSha) || (rollbackArg && /^[a-f0-9]{40}$/.test(rollbackSha || '')), 'Specify both rollback worktree and exact SHA');
const baseline = path.resolve(baselineArg), output = path.resolve(outputArg);
const rollback = rollbackArg ? path.resolve(rollbackArg) : null;
assert.ok(!output.toLowerCase().startsWith(root.toLowerCase() + path.sep) && output.toLowerCase() !== root.toLowerCase());
await mkdir(output, { recursive: true });
assert.deepEqual(await readdir(output), [], 'Evidence directory must be empty');
const runId = randomBytes(6).toString('hex');
const container = `schoolpilot-release-rehearsal-${runId}`;
const database = `schoolpilot_redesign_release_rehearsal_${runId}`;
const password = randomBytes(24).toString('hex');
const role = `rehearsal_app_${runId}`;
const appPassword = randomBytes(24).toString('hex');
const requestedDockerContext = process.env.DOCKER_CONTEXT?.trim();
const requestedDockerHost = process.env.DOCKER_HOST?.trim();
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SystemRoot|WINDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|COMSPEC|PATHEXT)$/i.test(key)));
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), baselineSha,
  candidateSha: null, productionMutations: 0, syntheticEmptyBaseline: true,
  liveCatalogProven: false, steps: [], passed: false };
let created = false, owner;
let pinnedDockerHost;

function assertLocalDockerHost(host) {
  // Named pipes must address this machine, never a UNC server. Unix sockets
  // are also local; TCP/SSH contexts (including forwarded ports) are refused.
  assert.ok(typeof host === 'string' && (
    /^npipe:\/{2,4}\.\/pipe\/[a-z0-9_.-]+$/i.test(host)
    || /^unix:\/\/\/[^\s?#]+$/.test(host)
  ), 'Rehearsal requires a local named-pipe or Unix-socket Docker daemon');
}

async function command(executable, args, { cwd = root, env = baseEnv, log, allowFailure = false } = {}) {
  if (executable === 'docker') {
    if (pinnedDockerHost) {
      assertLocalDockerHost(pinnedDockerHost);
      args = ['--host', pinnedDockerHost, ...args];
    } else {
      // Context metadata is read locally before any daemon operation. Every
      // inspect/run/exec/restart/remove thereafter uses the pinned endpoint.
      assert.ok(args[0] === 'context' && ['show', 'inspect'].includes(args[1]), 'Validate the local Docker daemon first');
    }
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  if (log) {
    const contents = result.stdout + result.stderr;
    assert.ok(!contents.includes(password) && !contents.includes(appPassword), 'Refuse to persist fixture credentials');
    await writeFile(path.join(output, log), contents);
    evidence.steps.push({ name: log, exitCode: result.code, sha256: createHash('sha256').update(contents).digest('hex') });
  }
  if (!allowFailure) assert.equal(result.code, 0, `${log || executable} failed: ${result.stderr.slice(-1000)}`);
  return result;
}

async function compileTarget(cwd, env, prefix) {
  const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
  for (const step of rehearsalBuildSteps(manifest)) {
    await command(process.execPath, [step.entrypoint], { cwd, env, log: `${prefix}-${step.name}.log` });
  }
}

try {
  assert.equal((await command('git', ['rev-parse', 'HEAD'], { cwd: baseline })).stdout.trim(), baselineSha);
  assert.equal((await command('git', ['status', '--porcelain'], { cwd: baseline })).stdout.trim(), '');
  if (rollback) {
    assert.equal((await command('git', ['rev-parse', 'HEAD'], { cwd: rollback })).stdout.trim(), rollbackSha);
    assert.equal((await command('git', ['status', '--porcelain'], { cwd: rollback })).stdout.trim(), '');
    evidence.compatibleRollbackSha = rollbackSha;
  }
  evidence.candidateSha = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal((await command('git', ['status', '--porcelain'])).stdout.trim(), '', 'Freeze candidate source first');
  const oldRegistry = JSON.parse(await readFile(path.join(baseline, 'src/config/rlsRegistry.json'), 'utf8'));
  const registry = JSON.parse(await readFile(path.join(root, 'src/config/rlsRegistry.json'), 'utf8'));
  const oldTables = oldRegistry.inventories.importProcessingStagesPostExpand.tables;
  const currentTables = registry.inventories.classpilotPrivateChatLifecyclePostExpand.tables;
  assert.equal(oldTables.length, 121); assert.equal(currentTables.length, 129);
  let context = requestedDockerContext;
  if (!context && requestedDockerHost) {
    assertLocalDockerHost(requestedDockerHost);
    pinnedDockerHost = requestedDockerHost;
  } else {
    context ??= (await command('docker', ['context', 'show'])).stdout.trim();
    assert.match(context, /^[a-z0-9][a-z0-9_.-]{0,127}$/i, 'Invalid Docker context name');
    const contexts = JSON.parse((await command('docker', ['context', 'inspect', context])).stdout);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].Name, context);
    assertLocalDockerHost(contexts[0].Endpoints?.docker?.Host);
    pinnedDockerHost = contexts[0].Endpoints.docker.Host;
  }
  evidence.localDockerDaemon = { context: context || null, endpoint: pinnedDockerHost, pinnedForEveryAction: true };
  const image = (await command('docker', ['inspect', 'schoolpilot-db', '--format', '{{.Image}}'])).stdout.trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  evidence.postgresImageId = image;
  const creation = await command('docker', ['run', '--detach', '--name', container, '--label', `codex.release-rehearsal=${runId}`,
    '--cpus', '4', '--memory', '4g', '--memory-swap', '4g', '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_DB=${database}`, '--env', 'POSTGRES_USER=rehearsal_owner', '--env', `POSTGRES_PASSWORD=${password}`, image], { allowFailure: true });
  const inspection = await command('docker', ['inspect', container], { allowFailure: true });
  if (inspection.code === 0) created = JSON.parse(inspection.stdout)[0].Config.Labels['codex.release-rehearsal'] === runId;
  assert.equal(creation.code, 0, 'Owned container creation failed');
  assert.ok(created, 'Owned container identity missing');
  const inspect = JSON.parse(inspection.stdout)[0];
  assert.equal(inspect.Config.Labels['codex.release-rehearsal'], runId);
  const portBinding = inspect.NetworkSettings.Ports['5432/tcp'][0];
  assert.equal(portBinding.HostIp, '127.0.0.1');
  const url = `postgresql://rehearsal_owner:${password}@127.0.0.1:${portBinding.HostPort}/${database}`;
  let ready = false;
  for (let n = 0; n < 60; n++) {
    const result = await command('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'rehearsal_owner', '-d', database], { allowFailure: true });
    if (result.code === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Owned PostgreSQL did not start');
  const secret = randomBytes(32).toString('hex');
  const env = { ...baseEnv, DATABASE_URL: url, DATABASE_URL_PRIVILEGED: url,
    JWT_SECRET: secret, SESSION_SECRET: secret, STUDENT_TOKEN_SECRET: secret,
    NODE_ENV: 'test', REDIS_URL: '', SCHEDULER_ENABLED: 'false', RUN_MIGRATIONS_ON_STARTUP: 'false',
    RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: oldTables.join(','), DOTENV_CONFIG_PATH: path.join(output, 'absent.env') };
  await compileTarget(baseline, env, 'baseline');
  await command(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'push', '--force'], { cwd: baseline, env, log: 'baseline-schema.log' });
  await command(process.execPath, ['dist/index.js'], { cwd: baseline, env: { ...env, RUN_LEGACY_MIGRATIONS_ONLY: 'true' }, log: 'baseline-legacy.log' });
  // The disposable legacy bootstrap also runs its versioned migrations and may
  // already adopt staff identity contracts. Production-mode re-entry verifies
  // that reconstructed state; it does not prove production's actual contract
  // adoption state or rehearse an unadopted-to-adopted transition.
  await command(process.execPath, ['dist/index.js'], { cwd: baseline, env: { ...env, NODE_ENV: 'production', RUN_MIGRATIONS_ONLY: 'true', GIT_SHA: baselineSha }, log: 'baseline-versioned.log' });
  owner = new pg.Client({ connectionString: url }); await owner.connect();
  const snapshot = async name => {
    const ledger = (await owner.query('SELECT id,checksum,mode,status,application_sha FROM schema_migrations ORDER BY id')).rows;
    const catalog = (await owner.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)).rows;
    const content = JSON.stringify({ ledger, catalog }, null, 2) + '\n';
    await writeFile(path.join(output, `${name}.json`), content);
    evidence.steps.push({ name: `${name}.json`, sha256: createHash('sha256').update(content).digest('hex') });
    return { ledger, catalog };
  };
  const before = await snapshot('baseline-contract');
  assert.ok(before.ledger.every(row => row.status === 'complete'));
  assert.equal(before.catalog.filter(row => row.relrowsecurity && oldTables.includes(row.relname)).length, 121);
  const currentEnv = { ...env, NODE_ENV: 'production', RUN_MIGRATIONS_ONLY: 'true', GIT_SHA: evidence.candidateSha,
    RLS_ENABLED_TABLES: currentTables.join(',') };
  // dist is ignored and may belong to an older build even on a clean checkout.
  // Compile the candidate within this run before certifying its source binding.
  await compileTarget(root, env, 'candidate');
  await command(process.execPath, ['dist/index.js'], { env: currentEnv, log: 'candidate-versioned.log' });
  const after = await snapshot('candidate-contract');
  for (const original of before.ledger) assert.deepEqual(after.ledger.find(row => row.id === original.id), original);
  assert.ok(after.ledger.every(row => row.status === 'complete'));
  const { readRlsCatalog, hasCanonicalTenantPolicy } = await import(pathToFileURL(path.join(root, 'dist/db/rlsEnforcement.js')));
  const catalog = await readRlsCatalog(owner, currentTables);
  assert.equal(catalog.length, currentTables.length); assert.ok(catalog.every(hasCanonicalTenantPolicy));
  await command(process.execPath, ['dist/index.js'], { env: currentEnv, log: 'candidate-repeat.log' });
  assert.deepEqual((await snapshot('candidate-repeat-contract')).ledger, after.ledger, 'Repeat must not rewrite ledger history');
  // A later compatible image must retain every applied checksum and force-RLS
  // table; no reverse migration or historical inventory rewrite is permitted.
  await owner.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${appPassword}'`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  const reader = new pg.Client({ connectionString: `postgresql://${role}:${appPassword}@127.0.0.1:${portBinding.HostPort}/${database}` });
  await reader.connect();
  try {
    const flags = (await reader.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(flags.rolsuper, false); assert.equal(flags.rolbypassrls, false);
    for (const table of currentTables) {
      assert.match(table, /^[a-z_][a-z0-9_]*$/);
      assert.equal(Number((await reader.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count), 0);
    }
  } finally { await reader.end(); }
  // Verify explicit contract-request re-entry and subsequent compatible reruns.
  // When bootstrap already adopted the contract this proves idempotence only.
  await command(process.execPath, ['dist/index.js'], { env: { ...currentEnv, APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS: 'true' }, log: 'candidate-contract-adoption.log' });
  const adopted = await snapshot('candidate-adopted-contract');
  await command(process.execPath, ['dist/index.js'], { env: currentEnv, log: 'candidate-retained-contract.log' });
  assert.deepEqual((await snapshot('candidate-retained-contract')).ledger, adopted.ledger);
  if (rollback) {
    await compileTarget(rollback, env, 'rollback');
    await command(process.execPath, ['dist/index.js'], { cwd: rollback, env: { ...currentEnv, GIT_SHA: rollbackSha }, log: 'compatible-rollback-migrations.log' });
    assert.deepEqual((await snapshot('compatible-rollback-contract')).ledger, adopted.ledger, 'Compatible rollback must retain every migration record');
    assert.ok((await readRlsCatalog(owner, currentTables)).every(hasCanonicalTenantPolicy));
    await command(process.execPath, ['dist/index.js'], { env: currentEnv, log: 'candidate-after-rollback.log' });
    assert.deepEqual((await snapshot('candidate-after-rollback-contract')).ledger, adopted.ledger);
    assert.equal((await command('git', ['rev-parse', 'HEAD'], { cwd: rollback })).stdout.trim(), rollbackSha);
    assert.equal((await command('git', ['status', '--porcelain'], { cwd: rollback })).stdout.trim(), '');
    evidence.compatibleRollbackMigrationReentry = true;
  }
  evidence.baselineMigrations = before.ledger.length;
  evidence.candidateExpandMigrations = after.ledger.length;
  evidence.candidateAdoptedMigrations = adopted.ledger.length;
  evidence.retainedTenantTables = currentTables.length;
  evidence.restrictedRoleCheck = 'Empty-fixture catalog/permission smoke only; populated cross-school isolation requires the separate RLS test suite.';
  evidence.rollbackLimit = 'Checksum/admission retention proved locally; live image/task-pair rollback requires separately authorized execution.';
  assert.equal((await command('git', ['rev-parse', 'HEAD'])).stdout.trim(), evidence.candidateSha);
  assert.equal((await command('git', ['status', '--porcelain'])).stdout.trim(), '', 'Source changed during rehearsal');
  evidence.passed = true;
} catch (error) {
  evidence.failure = { name: error.name, message: String(error.message).replaceAll(password, '[redacted]').replaceAll(appPassword, '[redacted]') };
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  try { await owner?.end(); } catch (error) { cleanupErrors.push(`Database close: ${error.name}`); }
  try {
    if (created) {
      assert.equal(container, `schoolpilot-release-rehearsal-${runId}`);
      const labels = JSON.parse((await command('docker', ['inspect', container, '--format', '{{json .Config.Labels}}'])).stdout);
      assert.equal(labels['codex.release-rehearsal'], runId, 'Refuse unowned cleanup');
      await command('docker', ['rm', '--force', '--volumes', container]);
      evidence.generatedContainerRemoved = true;
    }
  } catch (error) { cleanupErrors.push(`Container cleanup: ${error.name}`); }
  if (cleanupErrors.length) {
    evidence.cleanupErrors = cleanupErrors;
    evidence.passed = false;
    process.exitCode = 1;
  }
  evidence.completedAt = new Date().toISOString();
  await writeFile(path.join(output, 'rehearsal.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
