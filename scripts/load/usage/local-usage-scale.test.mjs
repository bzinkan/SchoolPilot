import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assertLocalScaleFixture, currentObservationSeconds } from './local-usage-scale.mjs';

const run = '012345abcdef';
const local = { USAGE_LOCAL_SCALE: '1', NODE_ENV: 'test', USAGE_SCALE_CONTAINER: `schoolpilot-usage-scale-${run}`,
  DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${run}`,
  ADMIN_DATABASE_URL: `postgres://synthetic:synthetic@127.0.0.1:5437/schoolpilot_redesign_usage_scale_${run}` };
test('scale fixture rejects other databases, ports, ownership names and missing opt-in before I/O', () => {
  assert.doesNotThrow(() => assertLocalScaleFixture(local));
  for (const patch of [{ USAGE_LOCAL_SCALE: '0' }, { NODE_ENV: 'production' }, { USAGE_SCALE_CONTAINER: 'schoolpilot-db' },
    { USAGE_SCALE_CONTAINER: 'schoolpilot-usage-scale-abcdefabcdef' },
    { DATABASE_URL: local.DATABASE_URL.replace('127.0.0.1', 'db.example.test') },
    { DATABASE_URL: local.DATABASE_URL.replace('5437', '5435') }, { ADMIN_DATABASE_URL: local.ADMIN_DATABASE_URL.replace(run, 'abcdefabcdef') },
    { DATABASE_URL: local.DATABASE_URL.replace(`schoolpilot_redesign_usage_scale_${run}`, 'schoolpilot') }]) assert.throws(() => assertLocalScaleFixture({ ...local, ...patch }));
});
test('current-day oracle independently deduplicates and bounds gap and cutoff attribution', () => {
  const base = Date.parse('2026-09-30T12:00:00Z'), cutoff = new Date(base + 50_000);
  const rows = [0, 20, 20, 40, 55].map(second => ({ student_id: 'a', timestamp: new Date(base + second * 1000) }));
  rows.push({ student_id: 'b', timestamp: new Date(base + 48_000) });
  assert.deepEqual([...currentObservationSeconds(rows.reverse(), cutoff)], [['b', 2], ['a', 40]]);
});
test('dedicated runner verifies exact loopback port, caps and cleanup ownership without changing shared quotas', () => {
  const script = readFileSync(new URL('./run-local-usage-scale.ps1', import.meta.url), 'utf8');
  assert.match(script, /--cpus 4 --memory 4g --memory-swap 4g --publish '127\.0\.0\.1:5437:5432'/);
  assert.match(script, /node --max-old-space-size=512/);
  assert.match(script, /Cleanup refused without exact run ownership label/);
  assert.match(script, /docker rm --force --volumes \$container/);
  assert.doesNotMatch(script, /docker (?:rm|stop|update).*schoolpilot-db/);
  assert.match(script, /Choose an external evidence directory/);
});
