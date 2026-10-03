import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

test('admitted API fair pool preserves native RLS/reset, FIFO and report cancellation ownership', { timeout: 25_000 }, async t => {
  assert.ok(process.env.DATABASE_URL, 'native lane requires its owned database');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname));
  Object.assign(process.env, { NODE_ENV: 'test', SCHEDULER_ENABLED: 'false', DB_POOL_MAX: '1',
    RLS_GUC_ENABLED: 'true', RLS_ENABLED_TABLES: 'classpilot_usage_rollups,classpilot_usage_rollup_days',
    CLASSPILOT_USAGE_ROLLUP_MODE: 'on', CLASSPILOT_DIGITAL_USAGE_MODE: 'on' });
  const { db, pool, sessionPool } = await import('../src/db.ts');
  const { runWithTenantContext, drainTenantContextReleases } = await import('../src/middleware/tenantContext.ts');
  const { getTenantStore } = await import('../src/db/tenantContext.ts');
  const { runWithUsageCapacityOperation } = await import('../src/services/usageCapacityDiagnostics.ts');
  const { runClasspilotUsageExecution } = await import('../src/services/classpilotUsageExecution.ts');
  const schools = [randomUUID(), randomUUID()];
  let initial, held, replacementPromise, releaseBarrier;
  try {
    assert.equal(pool.schedulingSnapshot().max, 1, 'actual startup retains configured lower cap');
    initial = await pool.connect();
    const role = (await initial.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    const restricted = !role.rolsuper && !role.rolbypassrls;
    if (process.env.RLS_TEST_ROLE) assert.equal(restricted, true, 'restricted lane must be NOSUPERUSER NOBYPASSRLS');
    t.diagnostic(restricted ? 'Actual restricted-role FORCE RLS proof' : 'Owner plumbing only; restricted lane proves RLS');
    await initial.query('CREATE TEMP TABLE fair_pool_tenant_fixture(school_id text NOT NULL,payload text NOT NULL)');
    await initial.query('INSERT INTO fair_pool_tenant_fixture VALUES ($1,$1),($2,$2)', schools);
    await initial.query('ALTER TABLE fair_pool_tenant_fixture ENABLE ROW LEVEL SECURITY');
    await initial.query('ALTER TABLE fair_pool_tenant_fixture FORCE ROW LEVEL SECURITY');
    await initial.query("CREATE POLICY tenant ON fair_pool_tenant_fixture USING (school_id=current_setting('app.school_id',true))");
    initial.release(); initial = undefined;
    await Promise.all(Array.from({ length: 64 }, (_, i) => runWithTenantContext({ schoolId: schools[i % 2],
      operation: i % 3 ? 'heartbeat_background' : 'usage_report' }, async () => {
      assert.equal(getTenantStore().schoolId, schools[i % 2]);
      const rows = await db.execute(sql`SELECT school_id,payload FROM fair_pool_tenant_fixture ORDER BY school_id`);
      if (restricted) assert.deepEqual(rows.rows, [{ school_id: schools[i % 2], payload: schools[i % 2] }]);
      const guc = await db.execute(sql`SELECT current_setting('app.school_id') AS school`);
      assert.equal(guc.rows[0].school, schools[i % 2]);
    })));
    const unbound = await pool.query("SELECT current_setting('app.school_id',true) AS school,current_setting('app.is_super',true) AS super");
    assert.deepEqual(unbound.rows, [{ school: '', super: 'off' }]);
    if (restricted) assert.equal((await pool.query('SELECT * FROM fair_pool_tenant_fixture')).rowCount, 0);

    held = await pool.connect();
    const order = [];
    const pending = ['d0','d1','d2','r0','r1'].map(id => runWithUsageCapacityOperation(id[0] === 'r' ? 'usage_report' : 'auth', async () => {
      await pool.query('SELECT 1'); order.push(id);
    }));
    assert.equal(pool.waitingCount, 5);
    held.release(); held = undefined; await Promise.all(pending);
    assert.deepEqual(order, ['r0','d0','r1','d1','d2']);

    const controller = new AbortController(), reason = new Error('synthetic report cancellation');
    let signalStarted, signalQueryEnded;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const queryEnded = new Promise(resolve => { signalQueryEnded = resolve; });
    const barrier = new Promise(resolve => { releaseBarrier = resolve; });
    const report = runWithUsageCapacityOperation('usage_report', () => runClasspilotUsageExecution({
      schoolId: schools[0], signal: controller.signal, deadlineAt: performance.now() + 15_000,
    }, async () => {
      const query = getTenantStore().client.query('SELECT pg_sleep(10)');
      signalStarted();
      try { await query; assert.fail('cancelled PostgreSQL work must not complete'); }
      catch (error) { signalQueryEnded(); await barrier; throw error; }
    }));
    const rejected = assert.rejects(report, error => error === reason);
    await started;
    controller.abort(reason); await queryEnded;
    let acquired = false;
    const after = pool.connect().then(client => { acquired = true; return client; });
    replacementPromise = after;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acquired, false, 'response/abort cannot release a still-running report callback');
    assert.equal(pool.schedulingSnapshot().ownedSlots, 1);
    assert.equal(pool.waitingCount, 1);
    releaseBarrier(); await rejected;
    const replacement = await after;
    const clean = await replacement.query("SELECT current_setting('app.school_id',true) AS school");
    assert.ok(clean.rows[0].school === null || clean.rows[0].school === '');
    replacement.release(); replacementPromise = undefined;
    await drainTenantContextReleases();
    assert.equal(pool.schedulingSnapshot().ownedSlots, 0);
    assert.equal(pool.waitingCount, 0);
  } finally {
    releaseBarrier?.(); initial?.release(); held?.release();
    if (replacementPromise) await replacementPromise.then(client => client.release(), () => {});
    await drainTenantContextReleases();
    await Promise.all([pool.end(), sessionPool.end()]);
  }
});
