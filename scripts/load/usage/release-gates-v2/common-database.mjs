import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hash } from './contracts.mjs';
import { pause } from './application.mjs';

export async function withCommonDatabase(options, docker, use) {
  const { run, outputDirectory, privateDirectory } = options;
  const schema = readFileSync(options.schemaFile), schemaReceipt = JSON.parse(readFileSync(options.schemaReceiptFile));
  assert.equal(hash(schema), options.schemaSha256); assert.equal(hash(readFileSync(options.schemaReceiptFile)), options.schemaReceiptSha256);
  assert.equal(schemaReceipt.source, options.source); assert.equal(schemaReceipt.schemaSha256, options.schemaSha256); assert.equal(schemaReceipt.verified, true);
  const database = `schoolpilot_redesign_usage_scale_${run}`, owner = `v2_owner_${run}`, app = `v2_app_${run}`;
  const password = randomBytes(24).toString('hex'), appPassword = randomBytes(24).toString('hex');
  const envFile = join(privateDirectory, 'postgres-environment.private');
  writeFileSync(envFile, `POSTGRES_USER=${owner}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${database}\n`, { flag: 'wx', mode: 0o600 });
  const name = `schoolpilot-release297-v2-postgres-${run}`; let id;
  const find = async () => (await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--no-trunc', '--format', '{{.ID}}'])).trim();
  const verify = async found => {
    const row = JSON.parse(await docker(['inspect', found]))[0];
    assert.equal(row.Name, '/' + name); assert.equal(row.Config.Labels['codex.release297-v2'], run); assert.equal(row.Config.Labels['codex.release297-source'], options.source);
    assert.equal(row.HostConfig.NanoCpus, 4e9); assert.equal(row.HostConfig.Memory, 4 * 1024 ** 3); assert.equal(row.HostConfig.MemorySwap, 4 * 1024 ** 3);
    assert.equal(row.HostConfig.Privileged, false); assert.equal(row.Config.Image, options.postgresImage); return row;
  };
  let cleanup;
  try {
    assert.equal(await find(), '');
    try { id = (await docker(['run', '--detach', '--name', name, '--label', `codex.release297-v2=${run}`, '--label', `codex.release297-source=${options.source}`,
      '--cpus', '4', '--memory', '4g', '--memory-swap', '4g', '--env-file', envFile, options.postgresImage, 'postgres', '-p', '5437'])).trim(); }
    finally { const recovered = await find(); if (recovered) { await verify(recovered); id = recovered; } }
    assert.match(id, /^[a-f0-9]{64}$/);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await docker(['exec', id, 'pg_isready', '-h', '127.0.0.1', '-p', '5437', '-U', owner, '-d', database]); ready = true; break; } catch { await pause(500); }
    }
    assert.equal(ready, true);
    await docker(['exec', '-i', id, 'psql', '-p', '5437', '-U', owner, '-d', database, '-v', 'ON_ERROR_STOP=1'], { input: schema });
    assert.ok(Array.isArray(schemaReceipt.migrations) && schemaReceipt.migrations.length > 0);
    for (const migration of schemaReceipt.migrations) {
      assert.match(migration.id, /^[a-zA-Z0-9_.-]+$/); assert.match(migration.checksum, /^[a-f0-9]{64}$/); assert.equal(migration.status, 'complete');
    }
    // A schema-only native dump has no ledger rows. These are explicit
    // synthetic bootstrap records from the pinned source rehearsal receipt.
    await docker(['exec', '-i', id, 'psql', '-p', '5437', '-U', owner, '-d', database, '-v', 'ON_ERROR_STOP=1'], {
      input: 'INSERT INTO schema_migrations(id,checksum,status,mode,application_sha,completed_at) VALUES ' + schemaReceipt.migrations.map(row => `('${row.id}','${row.checksum}','complete','transactional','${options.source}',now())`).join(',') + ';' });
    writeFileSync(join(outputDirectory, 'synthetic-migration-bootstrap.json'), JSON.stringify({ source: options.source,
      schemaReceiptSha256: options.schemaReceiptSha256, syntheticBootstrap: true, fixtureLedgerMode: 'transactional', productionCatalogClaimed: false, migrations: schemaReceipt.migrations }) + '\n', { flag: 'wx' });
    await docker(['exec', '-i', id, 'psql', '-p', '5437', '-U', owner, '-d', database, '-v', 'ON_ERROR_STOP=1'], {
      input: `CREATE ROLE ${app} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${appPassword}'; GRANT USAGE ON SCHEMA public TO ${app}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${app}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app};
DO $owned_fixture$ BEGIN IF to_regprocedure('public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text)') IS NOT NULL THEN
REVOKE EXECUTE ON FUNCTION public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classpilot_heartbeat_screenshot_evidence_v1(text,text,text,text) TO ${app}; END IF; END $owned_fixture$;` });
    const configuration = { pgContainerId: id, schemaSha256: options.schemaSha256,
      adminUrl: `postgresql://${owner}:${password}@127.0.0.1:5437/${database}`, appUrl: `postgresql://${app}:${appPassword}@127.0.0.1:5437/${database}` };
    return await use(configuration, async () => {
      await docker(['exec', id, 'psql', '-p', '5437', '-U', owner, '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', 'ANALYZE']);
      const before = (await verify(id)).State; const started = new Date().toISOString();
      await docker(['stop', '--time', '30', id]); const stopped = (await verify(id)).State;
      assert.equal(stopped.Running, false); assert.equal(stopped.ExitCode, 0);
      await docker(['start', id]);
      let ready = false; for (let n = 0; n < 60; n++) { try { await docker(['exec', id, 'pg_isready', '-h', '127.0.0.1', '-p', '5437', '-U', owner, '-d', database]); ready = true; break; } catch { await pause(500); } }
      assert.equal(ready, true); const after = (await verify(id)).State; assert.notEqual(before.StartedAt, after.StartedAt);
      const receipt = { run, source: options.source, pgContainerId: id, before, stopped, after, startedAt: started,
        cleanStop: true, restarted: true, sharedBuffersCold: true, hostFilesystemCachesFlushed: false };
      writeFileSync(join(outputDirectory, 'cold-restart.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); return receipt;
    });
  } finally {
    const found = await find(); let volumes = [], forced = false, stopped = null;
    if (found) {
      const row = await verify(found); if (id) assert.equal(id, found); volumes = row.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name);
      try { if (row.State.Running) await docker(['stop', '--time', '30', found]); stopped = (await verify(found)).State; forced = stopped.Running || stopped.ExitCode !== 0; }
      catch { forced = true; }
      await docker(['rm', ...(forced ? ['--force'] : []), '--volumes', found]);
    }
    assert.equal(await find(), '');
    const existingVolumes = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).trim().split(/\r?\n/);
    assert.ok(volumes.every(volume => !existingVolumes.includes(volume)));
    cleanup = { run, source: options.source, pgContainerId: id ?? null, confirmedAbsent: true, stopped, forced,
      volumes: volumes.map(name => ({ name, confirmedAbsent: true })), cleanupPassed: !!id && !forced && stopped?.ExitCode === 0 };
    writeFileSync(join(outputDirectory, 'postgres-cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n', { flag: 'wx' });
  }
}
