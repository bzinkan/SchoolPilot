import assert from 'node:assert/strict';
import test from 'node:test';
import { schoolYearSummary } from '../src/products/classpilot/lib/adminSchoolYear.js';

test('school-year notices use only valid saved bounds and the school-local date', () => {
  const saved = { yearStart: '2026-08-19', yearEnd: '2027-05-28' };
  for (const today of ['2026-08-19', '2027-05-28']) {
    assert.equal(schoolYearSummary(saved, today).status, 'current');
  }
  assert.equal(schoolYearSummary(saved, '2026-08-18').status, 'upcoming');
  assert.equal(schoolYearSummary(saved, '2027-05-29').status, 'ended');
  assert.equal(schoolYearSummary(saved, undefined).status, 'unknown');
  assert.equal(schoolYearSummary({}, '2026-09-01').status, 'missing');
  for (const config of [
    { yearStart: '2026-08-19' },
    { yearStart: '2026-02-30', yearEnd: '2027-05-28' },
    { yearStart: '2027-05-29', yearEnd: '2027-05-28' },
  ]) assert.equal(schoolYearSummary(config, '2026-09-01').status, 'invalid');
  assert.equal(schoolYearSummary({}, '2026-09-01').start, undefined, 'missing dates must not be inferred');
});
