import assert from 'node:assert/strict';
import test from 'node:test';
import { appointmentReminderRange, currentClassReminders, chosenSchoolInstant, schoolWallTime,
  schoolWallTimeCandidates, loadAppointmentPages, schoolDateBoundary, shiftSchoolDate } from '../src/products/passpilot/appointmentModel.js';

test('school-local DST folds require an explicit offset and preserve the selected instant', () => {
  const choices = schoolWallTimeCandidates('2026-11-01T01:30', 'America/New_York');
  assert.deepEqual(choices, [{ instant: '2026-11-01T05:30:00.000Z', offset: '-04:00' }, { instant: '2026-11-01T06:30:00.000Z', offset: '-05:00' }]);
  assert.throws(() => chosenSchoolInstant('2026-11-01T01:30', '', 'America/New_York'), /occurs twice/);
  for (const choice of choices) assert.equal(chosenSchoolInstant('2026-11-01T01:30', choice.instant, 'America/New_York'), choice.instant);
  assert.equal(schoolWallTime(choices[1].instant, 'America/New_York'), '2026-11-01T01:30');
});

test('school-local gaps and invalid dates cannot silently shift to another time', () => {
  for (const value of ['2026-03-08T02:30', '2026-02-30T10:00', '2026-11-01T24:00', 'bad']) {
    assert.deepEqual(schoolWallTimeCandidates(value, 'America/New_York'), []);
    assert.throws(() => chosenSchoolInstant(value, '', 'America/New_York'), /real date and time/);
  }
  assert.equal(chosenSchoolInstant('2026-09-30T10:00', '', 'Asia/Kathmandu'), '2026-09-30T04:15:00.000Z');
});

test('calendar date filters span the full local day across DST and reject invalid civil dates', () => {
  const start = schoolDateBoundary('2026-11-01', 'America/New_York');
  const end = schoolDateBoundary(shiftSchoolDate('2026-11-01', 1), 'America/New_York');
  assert.equal(start, '2026-11-01T04:00:00.000Z'); assert.equal(end, '2026-11-02T05:00:00.000Z');
  assert.equal(Date.parse(end) - Date.parse(start), 25 * 3600000);
  assert.equal(shiftSchoolDate('2028-02-28', 1), '2028-02-29');
  assert.throws(() => shiftSchoolDate('2026-02-30', 1), /valid date/);
});

test('teacher reminders include prior-day open windows and only current-class students', () => {
  const now = Date.parse('2026-10-01T00:15:00Z'), range = appointmentReminderRange(now);
  assert.equal(range.from, '2026-09-30T00:15:00.000Z');
  const rows = [
    { id: 'overnight', studentId: 'mine', status: 'scheduled', startsAt: '2026-09-30T23:00:00Z', endsAt: '2026-10-01T01:00:00Z' },
    { id: 'expired', studentId: 'mine', status: 'scheduled', endsAt: '2026-10-01T00:00:00Z' },
    { id: 'other-class', studentId: 'other', status: 'scheduled', endsAt: '2026-10-01T01:00:00Z' },
    { id: 'issued', studentId: 'mine', status: 'activated', endsAt: '2026-10-01T01:00:00Z' },
  ];
  assert.deepEqual(currentClassReminders(rows, [{ id: 'mine' }], now).map(row => row.id), ['overnight']);
});

test('teacher reminders drain every page and surface cyclic or malformed pagination', async () => {
  const calls = [], controller = new AbortController();
  const rows = await loadAppointmentPages(async (params, signal) => {
    calls.push(params); assert.equal(signal, controller.signal);
    return params.cursor ? { appointments: [{ id: 'second' }], nextCursor: null } : { appointments: [{ id: 'first' }], nextCursor: 'next' };
  }, { status: 'scheduled' }, controller.signal);
  assert.deepEqual(rows.map(row => row.id), ['first', 'second']); assert.equal(calls[1].cursor, 'next');
  await assert.rejects(loadAppointmentPages(async () => ({ appointments: [], nextCursor: 'same' }), {}), /did not advance/);
  await assert.rejects(loadAppointmentPages(async () => ({}), {}), /could not be loaded/);
  controller.abort();
  await assert.rejects(loadAppointmentPages(async () => assert.fail('Aborted fetch must not run'), {}, controller.signal), { name: 'AbortError' });
});
