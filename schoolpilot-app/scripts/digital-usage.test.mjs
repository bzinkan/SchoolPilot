import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUsageTime, requireUsageReport, usageCalendar, usageDateRange, usageGrades, usageLocalDate, usagePresentationState, usageQuery } from '../src/products/classpilot/lib/digitalUsage.js';

test('presets count inclusive school calendar dates across DST and UTC boundaries', () => {
  const today = usageLocalDate(new Date('2026-03-09T03:00:00Z'), 'America/Los_Angeles');
  assert.equal(today, '2026-03-08');
  assert.deepEqual(usageDateRange('7d', today), { from: '2026-03-02', to: '2026-03-08' });
  assert.deepEqual(usageDateRange('30d', '2026-11-02'), { from: '2026-10-04', to: '2026-11-02' });
  assert.equal(usageLocalDate(new Date('2026-09-30T23:30Z'), 'Asia/Tokyo'), '2026-10-01');
});

test('custom dates reject invalid/reversed/oversized ranges and accept exactly 366 days', () => {
  for (const custom of [{ from: '', to: '2026-09-30' }, { from: '2026-02-30', to: '2026-03-02' },
    { from: '2026-10-01', to: '2026-09-30' }, { from: '2025-09-29', to: '2026-09-30' }]) {
    assert.ok(usageDateRange('custom', '2026-09-30', custom).error);
  }
  assert.deepEqual(usageDateRange('custom', '2026-09-30', { from: '2025-09-30', to: '2026-09-30' }), { from: '2025-09-30', to: '2026-09-30' });
});

test('queries use the canonical scope/id/format contract and never broaden missing choices', () => {
  const range = { from: '2026-09-25', to: '2026-09-30' };
  assert.equal(new URLSearchParams(usageQuery('school', 'old-student', range)).has('id'), false);
  for (const scope of ['grade', 'class', 'student']) {
    assert.equal(usageQuery(scope, '', range), null);
    const query = new URLSearchParams(usageQuery(scope, 'same-school-id', range, 'csv'));
    assert.equal(query.get('id'), 'same-school-id'); assert.equal(query.get('scope'), scope); assert.equal(query.get('format'), 'csv');
  }
  assert.equal(usageQuery('school', '', { error: 'invalid' }), null);
});

test('internal holes, retention and future dates never acquire numeric zeros', () => {
  const computed = { date: '2026-09-27', state: 'final', monitoredBrowserSeconds: 0, activeMonitoredStudents: 0 };
  const days = usageCalendar({ range: { from: '2026-09-25', to: '2026-09-30', today: '2026-09-29', retainedFrom: '2026-09-26' }, byDay: [computed, { date: '2026-09-29', state: 'live', monitoredBrowserSeconds: 15 }] });
  assert.deepEqual(days.map(day => day.state), ['expired', 'unavailable', 'final', 'unavailable', 'live', 'future']);
  assert.deepEqual(days.map(day => day.monitoredBrowserSeconds), [null, null, 0, null, 15, null]);
  assert.equal(days[2], computed); assert.equal(formatUsageTime(days[1].monitoredBrowserSeconds), '—');
});

test('configured empty grades remain selectable and duration formatting preserves observed seconds', () => {
  assert.deepEqual(usageGrades([{ gradeLevel: '10' }, { gradeLevel: '2' }, { gradeLevel: null }], ['6', '2']), ['2', '6', '10']);
  assert.equal(formatUsageTime(0), '0s'); assert.equal(formatUsageTime(15), '15s'); assert.equal(formatUsageTime(61), '1m 1s'); assert.equal(formatUsageTime(3660), '1h 1m');
});

test('pre-ledger API responses cannot display interpolated zeros without coverage metadata', () => {
  assert.throws(() => requireUsageReport({ totals: { monitoredBrowserSeconds: 0 }, byDay: [] }), /Report coverage is unavailable/);
  const report = { schemaVersion: 1, range: { unavailableDates: ['2026-09-30'], computedDays: 0, requestedDays: 1 } };
  assert.equal(requireUsageReport(report), report);
});

test('final computed days never make an incomplete or expired requested report final', () => {
  const report = { dataState: 'final', range: { partiallyComputed: false, partiallyExpired: false, to: '2026-09-30', today: '2026-09-30' } };
  assert.equal(usagePresentationState(report), 'Final');
  assert.equal(usagePresentationState({ ...report, range: { ...report.range, partiallyComputed: true } }), 'Partial');
  assert.equal(usagePresentationState({ ...report, range: { ...report.range, partiallyExpired: true } }), 'Partial');
  assert.equal(usagePresentationState({ ...report, range: { ...report.range, to: '2026-10-01' } }), 'Partial');
  assert.equal(usagePresentationState({ ...report, dataState: 'unavailable' }), 'Unavailable');
});
