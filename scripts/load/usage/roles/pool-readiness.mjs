import assert from 'node:assert/strict';

// Called before measurement on the actual API main/session or scheduler pool.
// It creates no pool and acquires exactly one owned client through its public API.
export async function proveActualPool(pool, { name, max, applicationName, worker = false }) {
  assert.ok(['api', 'session', 'worker'].includes(name));
  assert.equal(max, { api: 16, session: 2, worker: 5 }[name]);
  assert.equal(worker, name === 'worker');
  assert.equal(pool.options.max, max);
  assert.equal(pool.options.connectionTimeoutMillis, worker ? 10000 : 5000);
  assert.equal(pool.options.statement_timeout, worker ? 60000 : 15000);
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT current_user = session_user AS same_role,
      r.rolsuper, r.rolbypassrls,
      current_setting('application_name') AS application_name,
      current_setting('app.school_id', true) AS school,
      current_setting('app.is_super', true) AS is_super
      FROM pg_roles r WHERE r.rolname = current_user`);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.same_role, true); assert.equal(row.rolsuper, false); assert.equal(row.rolbypassrls, false);
    assert.equal(row.application_name, applicationName);
    assert.ok(row.school === null || row.school === '');
    if (worker) assert.equal(row.is_super, 'on');
    else assert.ok(row.is_super === null || row.is_super === '' || row.is_super === 'off');
    return { name, max, acquisitionCalls: 1, queryCalls: 1, sameRole: true, databaseSuperuser: false,
      databaseBypassRls: false, neutralSchool: true, applicationSuperScope: worker,
      applicationName, checkoutDeadlineMs: pool.options.connectionTimeoutMillis,
      statementDeadlineMs: pool.options.statement_timeout };
  } finally { client.release(); }
}
