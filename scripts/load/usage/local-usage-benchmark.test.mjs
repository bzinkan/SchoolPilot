import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertLocalUsageFixture, summarize } from './local-usage-benchmark.mjs';

const db = 'schoolpilot_redesign_usage_capacity_012345abcdef';
const safe = { USAGE_LOCAL_BENCHMARK: '1', NODE_ENV: 'test', DATABASE_URL: `postgres://fixture@127.0.0.1:5435/${db}`, ADMIN_DATABASE_URL: `postgres://admin@localhost:5435/${db}` };
test('load gate refuses remote/nonfixture databases, wrong ports and missing explicit local opt-in before I/O', () => {
  assert.doesNotThrow(() => assertLocalUsageFixture(safe));
  for (const patch of [{ USAGE_LOCAL_BENCHMARK: '0' }, { NODE_ENV: 'production' }, { DATABASE_URL: `postgres://fixture@example.com:5435/${db}` },
    { DATABASE_URL: `postgres://fixture@localhost:5432/${db}` }, { DATABASE_URL: 'postgres://fixture@localhost:5435/schoolpilot' },
    { ADMIN_DATABASE_URL: 'postgres://fixture@localhost:5435/schoolpilot_redesign_usage_capacity_abcdef012345' }]) {
    assert.throws(() => assertLocalUsageFixture({ ...safe, ...patch }));
  }
});
test('latency summary retains nearest-rank p95 and does not mutate source observations', () => {
  const values = [100, 1, 3, 2, 5]; assert.deepEqual(summarize(values), { count: 5, minMs: 1, p50Ms: 3, p95Ms: 100, maxMs: 100 }); assert.deepEqual(values, [100, 1, 3, 2, 5]);
});
test('PowerShell runner refuses evidence inside the checkout before any fixture I/O', { skip: process.platform !== 'win32' }, () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const runner = fileURLToPath(new URL('./run-local-usage-benchmark.ps1', import.meta.url));
  for (const output of [repository, join(repository, 'must-not-be-created')]) {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', runner, '-OutputDirectory', output], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Choose an external evidence directory/);
  }
});
