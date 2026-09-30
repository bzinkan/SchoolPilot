import assert from 'node:assert/strict';
import test from 'node:test';
import { reportDateBoundary, reportDuration, reportFilters, reportRatio, reportScope, shiftReportDate, validateReportPage } from '../src/products/passpilot/reportModel.js';
test('school dates preserve DST elapsed boundaries including midnight transitions', () => {
  const spring = reportFilters({ fromDate: '2027-03-14', throughDate: '2027-03-14' }, 'America/New_York');
  const fall = reportFilters({ fromDate: '2026-11-01', throughDate: '2026-11-01' }, 'America/New_York');
  assert.equal(Date.parse(spring.through) - Date.parse(spring.from), 23 * 3600000);
  assert.equal(Date.parse(fall.through) - Date.parse(fall.from), 25 * 3600000);
  assert.equal(reportDateBoundary('2018-11-04', 'America/Sao_Paulo'), '2018-11-04T03:00:00.000Z');
  assert.throws(() => reportDateBoundary('2011-12-30', 'Pacific/Apia'));
});
test('invalid/inverted/excessive ranges fail instead of issuing a broad report', () => {
  assert.throws(() => shiftReportDate('2026-02-30', 1));
  assert.throws(() => reportFilters({ fromDate: '2026-10-02', throughDate: '2026-10-01' }, 'UTC'));
  assert.throws(() => reportFilters({ fromDate: '2025-01-01', throughDate: '2026-01-02' }, 'UTC'));
  assert.throws(() => reportFilters({ fromDate: '2026-09-30', throughDate: '2026-09-30', classFilter: 'schoolId:school-b' }, 'UTC'));
});
test('only reviewed filters are sent and legacy class identifiers retain their boundary', () => {
  const params = reportFilters({ fromDate: '2026-09-30', throughDate: '2026-09-30', classFilter: 'gradeId:grade-a', studentId: 'student-a', teacherId: 'teacher-a', issuedVia: 'kiosk', destination: 'office', schoolId: 'foreign', ruleCode: 'encounter' }, 'UTC');
  assert.equal(params.gradeId, 'grade-a'); assert.equal(params.classId, undefined); assert.equal(params.schoolId, undefined); assert.equal(params.ruleCode, undefined);
});
test('ratios and durations keep no-data unavailable and retain raw duration precision', () => {
  assert.equal(reportRatio({ numerator: 0, denominator: 0, ratio: null }), 'Unavailable — no eligible outcomes');
  assert.equal(reportRatio({ numerator: 1, denominator: 3, ratio: 1 / 3 }), '33.3% (1/3)');
  assert.equal(reportDuration(null), 'Unavailable'); assert.equal(reportDuration(61.5), '1.0 min');
});
test('scope keys isolate school, viewer, role and auth version; incomplete pages fail', () => {
  const user = { id: 'staff-a', authVersion: 2, roles: ['teacher'] };
  assert.notDeepEqual(reportScope(user, { id: 'school-a' }), reportScope({ ...user, authVersion: 3 }, { id: 'school-a' }));
  assert.throws(() => validateReportPage({ version: 2, passes: [], hasMore: true, nextCursor: null }));
  assert.throws(() => validateReportPage({ version: 1, passes: [], hasMore: false }));
});
