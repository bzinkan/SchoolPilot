import test from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL, classpilotUsageSchoolWriteLock }
  from '../src/services/classpilotUsageWriteLock.ts';
import { CLASSPILOT_USAGE_ROLLUP_LOCK_SQL } from '../src/services/classpilotUsageRollup.ts';

test('compatible cleanup and the retained rollup writer use the identical school lock', () => {
  const query = new PgDialect().sqlToQuery(classpilotUsageSchoolWriteLock('school-A'));
  assert.equal(query.sql, CLASSPILOT_USAGE_SCHOOL_WRITE_LOCK_SQL);
  assert.equal(query.sql, CLASSPILOT_USAGE_ROLLUP_LOCK_SQL);
  assert.deepEqual(query.params, ['school-A']);
});
