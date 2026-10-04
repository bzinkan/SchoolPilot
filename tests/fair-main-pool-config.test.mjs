import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldScheduleUsagePool } from '../src/db/fairMainPool.ts';

const admitted = {
  CLASSPILOT_USAGE_ROLLUP_MODE: 'on', CLASSPILOT_DIGITAL_USAGE_MODE: 'on',
  RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: 'classpilot_usage_rollups,classpilot_usage_rollup_days',
};
test('only admitted Usage-on API processes select fair main scheduling including rollup-only', () => {
  assert.equal(shouldScheduleUsagePool('api', admitted), true);
  assert.equal(shouldScheduleUsagePool('api', { ...admitted, CLASSPILOT_DIGITAL_USAGE_MODE: 'off' }), true);
  for (const env of [{},
    { ...admitted, CLASSPILOT_USAGE_ROLLUP_MODE: 'off' }, { ...admitted, CLASSPILOT_DIGITAL_USAGE_MODE: 'ON' },
    { ...admitted, RLS_GUC_ENABLED: 'false' }, { ...admitted, RLS_ENABLED_TABLES: 'classpilot_usage_rollups' },
    { ...admitted, RLS_ENABLED_TABLES: 'classpilot_usage_rollup_days' },
    { ...admitted, CLASSPILOT_USAGE_ROLLUP_MODE: 'invalid' }]) {
    assert.equal(shouldScheduleUsagePool('api', env), false);
    assert.equal(shouldScheduleUsagePool('worker', env), false);
  }
  assert.equal(shouldScheduleUsagePool('worker', admitted), false);
});
test('actual pool construction selects once and leaves session and worker scheduler factories native', () => {
  const db = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8');
  assert.match(db, /const MainPool = shouldScheduleUsagePool\(poolLimits.role\)[\s\S]*?createFairMainPoolClass\(pg.Pool, \{ readOperation: getUsageCapacityOperation \}\)[\s\S]*?: pg.Pool;/);
  assert.match(db, /const pool = new MainPool\(\{[\s\S]*?max: poolLimits.main,[\s\S]*?min: poolMinimums.main,[\s\S]*?connectionTimeoutMillis: 5000,[\s\S]*?statement_timeout: 15000,/);
  assert.match(db, /const sessionPool = new pg.Pool\(/);
  const scheduler = readFileSync(new URL('../src/services/schedulerDb.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(scheduler, /createFairMainPoolClass|shouldScheduleUsagePool/);
});

