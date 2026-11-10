// Native proof uses a new empty database on an existing loopback PostgreSQL
// service. It never changes the source database or creates a server/container.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), '../..');

export function localHeartbeatPrefixIndexSource(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A loopback PostgreSQL fixture URL is required'); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Only PostgreSQL is allowed');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only loopback PostgreSQL is allowed');
  assert.ok(['5432', '5435'].includes(url.port), 'Only the existing CI/local PostgreSQL ports are allowed');
  assert.ok(!url.search && !url.hash, 'Fixture URL options and fragments are prohibited');
  return url;
}

export function redactHeartbeatPrefixIndexOutput(value, secrets) {
  let text = String(value);
  for (const secret of [...new Set(secrets.filter(value => typeof value === 'string' && value.length))].sort((a,b) => b.length-a.length)) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]');
}

function stopOwnedChild(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1 || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

async function nativeChild(env, redact) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', './tests/test-environment.mjs', '--import', 'tsx',
      '--test', '--test-concurrency=1', '--test-timeout=45000',
      'tests/heartbeat-prefix-index-retirement.integration.test.ts'], {
      cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timedOut = false;
    const collect = data => {
      if (timedOut) return;
      output += data.toString();
      if (output.length > 2_000_000) { output = ''; timedOut = true; stopOwnedChild(child); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const deadline = setTimeout(() => { timedOut = true; stopOwnedChild(child); }, 120_000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => {
      clearTimeout(deadline);
      process.stdout.write(timedOut ? 'Native index proof exceeded its bounded output/time limit\n' : redact(output));
      done({ code, timedOut });
    });
  });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') throw new Error('Use --execute for the owned native fixture');
  const original = localHeartbeatPrefixIndexSource(process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || '');
  for (const name of ['heartbeatPrefixIndexRetirement', 'heartbeatPrefixIndexRetirementMigration']) {
    const source = statSync(resolve(root, `src/db/${name}.ts`));
    const built = statSync(resolve(root, `dist/db/${name}.js`));
    assert.ok(built.mtimeMs >= source.mtimeMs, 'Build the current backend before the native index proof');
  }
  const nonce = randomBytes(6).toString('hex');
  const name = `schoolpilot_heartbeat_prefix_index_${nonce}`;
  const marker = `schoolpilot:heartbeat-prefix-index-test:${nonce}`;
  assert.match(name, /^schoolpilot_heartbeat_prefix_index_[a-f0-9]{12}$/);
  const maintenanceUrl = new URL(original); maintenanceUrl.pathname = '/postgres';
  const targetUrl = new URL(original); targetUrl.pathname = `/${name}`;
  const secrets = [original.toString(), maintenanceUrl.toString(), targetUrl.toString(), decodeURIComponent(original.password)];
  const redact = value => redactHeartbeatPrefixIndexOutput(value, secrets);
  const require = createRequire(import.meta.url);
  const pg = require('pg');
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString(), connectionTimeoutMillis: 5000,
    statement_timeout: 20000, application_name: `heartbeat-prefix-index-proof-${nonce}` });
  let connected = false, created = false, oid, cleanupComplete = false;
  try {
    await maintenance.connect(); connected = true;
    assert.equal((await maintenance.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rowCount, 0,
      'Never reuse or replace an existing database');
    await maintenance.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    oid = (await maintenance.query('SELECT oid::text FROM pg_database WHERE datname=$1', [name])).rows[0]?.oid;
    assert.ok(oid);
    await maintenance.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
    console.log(JSON.stringify({ event: 'heartbeat_prefix_index_native_started', runtime: process.version, databaseCreated: true, serviceCreated: false }));
    const result = await nativeChild({ ...process.env, DATABASE_URL: targetUrl.toString(), ADMIN_DATABASE_URL: targetUrl.toString(),
      DATABASE_URL_PRIVILEGED: targetUrl.toString(), HEARTBEAT_PREFIX_INDEX_TEST_DATABASE_URL: targetUrl.toString(),
      HEARTBEAT_PREFIX_INDEX_TEST_OWNERSHIP: marker, REDIS_URL: '', NODE_ENV: 'test',
      SENDGRID_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' }, redact);
    assert.ok(!result.timedOut && result.code === 0, 'Native heartbeat index retirement proof failed');
  } finally {
    try {
      if (created && connected) {
        const owned = (await maintenance.query(`SELECT oid::text,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [name])).rows[0];
        assert.ok(owned && owned.oid === oid && owned.marker === marker, 'Cleanup ownership changed; retain the database');
        let connections;
        for (let attempt=0; attempt<20; attempt++) {
          connections = (await maintenance.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0]?.count;
          if (connections === 0) break;
          await new Promise(done => setTimeout(done,250));
        }
        assert.equal(connections,0,'Child pools remain open; do not force-drop the database');
        await maintenance.query(`DROP DATABASE "${name}"`); cleanupComplete = true;
      }
    } finally {
      if (connected) await maintenance.end();
      console.log(JSON.stringify({ event: 'heartbeat_prefix_index_native_cleanup', databaseCreated: created, cleanupComplete, serviceCreated: false }));
    }
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === scriptPath.toLowerCase() : invoked === scriptPath)) {
  main().catch(error => {
    const secrets = [process.env.ADMIN_DATABASE_URL,process.env.DATABASE_URL].filter(Boolean);
    for (const value of [...secrets]) { try { secrets.push(decodeURIComponent(new URL(value).password)); } catch {} }
    console.error(redactHeartbeatPrefixIndexOutput(error instanceof Error ? error.message : 'Native heartbeat index proof failed',secrets));
    process.exitCode = 1;
  });
}
