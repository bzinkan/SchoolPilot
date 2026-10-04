import test from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL, classpilotUsageSchoolWriteLock,
  withClasspilotUsageSchoolWrite } from '../src/services/classpilotUsageWriteLock.ts';

test('Drizzle cleanup and native rollup/retention take the exact same school lock', () => {
  const statement = new PgDialect().sqlToQuery(classpilotUsageSchoolWriteLock('school-A'));
  assert.equal(statement.sql, CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL);
  assert.deepEqual(statement.params, ['school-A']);
});
test('retention owns commit and release after the bounded batch completes', async () => {
  const calls = [], releases = [];
  let finish;
  const batch = new Promise(resolve => { finish = resolve; });
  const client = { query: async (text, values) => { calls.push([text, values]); return { rows: [] }; }, release: error => releases.push(error) };
  const pending = withClasspilotUsageSchoolWrite({ connect: async () => client }, 'school-A', async selected => {
    assert.equal(selected, client); await batch; return 5000;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['BEGIN', undefined], [CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL, ['school-A']]]);
  assert.deepEqual(releases, []); finish();
  assert.equal(await pending, 5000); assert.equal(calls.at(-1)[0], 'COMMIT'); assert.deepEqual(releases, [false]);
});
test('retention failure rolls back and keeps the original error; failed rollback discards once', async () => {
  for (const failRollback of [false, true]) {
    const failure = new Error('batch failed'), calls = [], releases = [];
    const client = { query: async text => { calls.push(text); if (text === 'ROLLBACK' && failRollback) throw new Error('connection lost'); return { rows: [] }; }, release: error => releases.push(error) };
    await assert.rejects(withClasspilotUsageSchoolWrite({ connect: async () => client }, 'school-A', async () => { throw failure; }), error => error === failure);
    assert.deepEqual(calls, ['BEGIN', CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL, 'ROLLBACK']);
    assert.deepEqual(releases, [failRollback]);
  }
});
