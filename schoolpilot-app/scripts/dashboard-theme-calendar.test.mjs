import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CALENDAR_HOLIDAY_IDS, DEFAULT_CALENDAR_HOLIDAYS, adventStart, calendarPresetFor, easterSunday, holidayWindow,
  localDateParts, localDateString, normalizeLeadDays, teacherCalendarHolidays, thanksgivingDay,
} from '../src/shared/themes/calendar.js';

const ALL = [...CALENDAR_HOLIDAY_IDS];
const day = (year, month, d) => ({ year, month, day: d });

test('Easter, Thanksgiving and Advent land on known dates', () => {
  assert.deepEqual(easterSunday(2024), { month: 3, day: 31 });
  assert.deepEqual(easterSunday(2025), { month: 4, day: 20 });
  assert.deepEqual(easterSunday(2026), { month: 4, day: 5 });
  assert.deepEqual(easterSunday(2027), { month: 3, day: 28 });
  assert.deepEqual(thanksgivingDay(2024), { month: 11, day: 28 });
  assert.deepEqual(thanksgivingDay(2025), { month: 11, day: 27 });
  assert.deepEqual(thanksgivingDay(2026), { month: 11, day: 26 });
  assert.deepEqual(adventStart(2024), { month: 12, day: 1 });
  assert.deepEqual(adventStart(2025), { month: 11, day: 30 });
  assert.deepEqual(adventStart(2026), { month: 11, day: 29 });
});

test('the default school calendar never shows a faith holiday, on any day of a leap year', () => {
  const seasons = new Set(['spring', 'summer', 'fall', 'winter']);
  for (let offset = 0; offset < 366; offset += 1) {
    const date = new Date(Date.UTC(2024, 0, 1 + offset));
    const today = day(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const preset = calendarPresetFor(today);
    assert.ok(seasons.has(preset) || DEFAULT_CALENDAR_HOLIDAYS.includes(preset), `${JSON.stringify(today)} -> ${preset}`);
  }
  assert.equal(calendarPresetFor(day(2024, 12, 20)), 'winter', 'December stays Winter without Christmas listed');
  assert.equal(calendarPresetFor(day(2024, 3, 25)), 'spring', 'the Easter run-up stays Spring without Easter listed');
});

test('a holiday opens ten days before its date and the season returns the day after', () => {
  assert.equal(calendarPresetFor(day(2026, 10, 20)), 'fall');
  assert.equal(calendarPresetFor(day(2026, 10, 21)), 'halloween', 'ten days before');
  assert.equal(calendarPresetFor(day(2026, 10, 31)), 'halloween');
  assert.equal(calendarPresetFor(day(2026, 11, 1)), 'fall', 'the day after');
  assert.equal(calendarPresetFor(day(2026, 11, 15)), 'fall');
  assert.equal(calendarPresetFor(day(2026, 11, 16)), 'thanksgiving');
  assert.equal(calendarPresetFor(day(2026, 11, 26)), 'thanksgiving');
  assert.equal(calendarPresetFor(day(2026, 11, 27)), 'fall');
  assert.equal(calendarPresetFor(day(2026, 2, 3)), 'winter');
  assert.equal(calendarPresetFor(day(2026, 2, 4)), 'valentines');
  assert.equal(calendarPresetFor(day(2026, 2, 15)), 'winter');
  assert.equal(calendarPresetFor(day(2026, 3, 7)), 'st-patricks');
  assert.equal(calendarPresetFor(day(2026, 3, 18)), 'spring');
  assert.equal(calendarPresetFor(day(2026, 12, 15), { allowed: ALL }), 'christmas');
  assert.equal(calendarPresetFor(day(2026, 12, 14), { allowed: ['christmas'] }), 'winter');
  assert.equal(calendarPresetFor(day(2026, 12, 25), { allowed: ALL }), 'christmas');
  assert.equal(calendarPresetFor(day(2026, 12, 26), { allowed: ALL }), 'winter');
  assert.equal(calendarPresetFor(day(2026, 3, 26), { allowed: ALL }), 'easter', 'ten days before Easter Sunday 2026 (Apr 5)');
  assert.equal(calendarPresetFor(day(2026, 4, 5), { allowed: ALL }), 'easter');
  assert.equal(calendarPresetFor(day(2026, 4, 6), { allowed: ALL }), 'spring');
});

test('the lead time is adjustable and clamped', () => {
  assert.equal(calendarPresetFor(day(2026, 10, 30), { leadDays: 0 }), 'fall');
  assert.equal(calendarPresetFor(day(2026, 10, 31), { leadDays: 0 }), 'halloween');
  assert.equal(calendarPresetFor(day(2026, 10, 1), { leadDays: 30 }), 'halloween');
  assert.equal(calendarPresetFor(day(2026, 10, 1), { leadDays: 90 }), 'halloween', 'clamped to 30');
  assert.equal(calendarPresetFor(day(2026, 9, 30), { leadDays: 90 }), 'fall');
  assert.equal(normalizeLeadDays('abc'), 10);
  assert.equal(normalizeLeadDays(-4), 0);
  assert.equal(normalizeLeadDays(12.6), 13);
});

test('an early start opens the window on that date and the window still closes by itself', () => {
  const starts = { halloween: '2026-10-19', christmas: '2026-12-11' };
  assert.equal(calendarPresetFor(day(2026, 10, 18), { starts }), 'fall');
  assert.equal(calendarPresetFor(day(2026, 10, 19), { starts }), 'halloween', 'Monday, two days ahead of the lead');
  assert.equal(calendarPresetFor(day(2026, 10, 21), { starts }), 'halloween', 'the automatic trigger changes nothing');
  assert.equal(calendarPresetFor(day(2026, 11, 1), { starts }), 'fall', 'the end is still automatic');
  assert.equal(calendarPresetFor(day(2026, 12, 10), { allowed: ALL, starts }), 'advent');
  assert.equal(calendarPresetFor(day(2026, 12, 11), { allowed: ALL, starts }), 'christmas', 'Friday Dec 11');
  assert.equal(calendarPresetFor(day(2026, 12, 26), { allowed: ALL, starts }), 'winter');
  assert.equal(calendarPresetFor(day(2027, 10, 19), { starts }), 'fall', 'a start date from another year is ignored');
  assert.equal(calendarPresetFor(day(2026, 10, 19), { starts: { halloween: '2026-11-02' } }), 'fall', 'a start after the holiday is ignored');
  assert.equal(calendarPresetFor(day(2026, 10, 19), { starts: { halloween: 'Monday' } }), 'fall', 'malformed dates are ignored');
  assert.deepEqual(holidayWindow('halloween', 2026, { starts }), { from: { month: 10, day: 19 }, to: { month: 10, day: 31 } });
});

test('Advent runs from Advent Sunday to the day before the Christmas window and implies Christmas', () => {
  assert.equal(calendarPresetFor(day(2026, 11, 28), { allowed: ['advent'] }), 'fall');
  assert.equal(calendarPresetFor(day(2026, 11, 29), { allowed: ['advent'] }), 'advent');
  assert.equal(calendarPresetFor(day(2026, 12, 14), { allowed: ['advent'] }), 'advent');
  assert.equal(calendarPresetFor(day(2026, 12, 15), { allowed: ['advent'] }), 'christmas', 'listing Advent implies Christmas');
  assert.deepEqual(holidayWindow('advent', 2026), { from: { month: 11, day: 29 }, to: { month: 12, day: 14 } });
  assert.equal(holidayWindow('advent', 2026, { starts: { christmas: '2026-11-20' } }), null, 'an early Christmas can swallow Advent');
  assert.equal(calendarPresetFor(day(2026, 12, 20), { allowed: ['advent', 'christmas'], leadDays: 0 }), 'advent', 'with no lead, Advent runs to Dec 24');
  assert.equal(calendarPresetFor(day(2026, 12, 25), { allowed: ['advent', 'christmas'], leadDays: 0 }), 'christmas');
});

test('overlapping windows go to the nearer holiday', () => {
  // Easter Sunday 2008 was Mar 23: its ten-day window overlaps St. Patrick's.
  assert.deepEqual(easterSunday(2008), { month: 3, day: 23 });
  assert.equal(calendarPresetFor(day(2008, 3, 15), { allowed: ALL }), 'st-patricks');
  assert.equal(calendarPresetFor(day(2008, 3, 17), { allowed: ALL }), 'st-patricks');
  assert.equal(calendarPresetFor(day(2008, 3, 18), { allowed: ALL }), 'easter');
  assert.equal(calendarPresetFor(day(2008, 3, 24), { allowed: ALL }), 'spring');
});

test('a teacher\'s own calendar may use every holiday, Advent only when hinted', () => {
  assert.deepEqual(teacherCalendarHolidays('advent'), ALL);
  assert.deepEqual(teacherCalendarHolidays('fall'), ALL.filter(id => id !== 'advent'));
  assert.equal(calendarPresetFor(day(2026, 12, 20), { allowed: teacherCalendarHolidays('fall') }), 'christmas');
  assert.equal(calendarPresetFor(day(2026, 12, 10), { allowed: teacherCalendarHolidays('fall') }), 'winter');
  assert.equal(calendarPresetFor(day(2026, 12, 10), { allowed: teacherCalendarHolidays('advent') }), 'advent');
});

test('every day of several years resolves to one shipped preset for every allowlist', () => {
  const ids = new Set(['halloween', 'thanksgiving', 'christmas', 'advent', 'valentines', 'st-patricks', 'easter', 'spring', 'summer', 'fall', 'winter']);
  for (const allowed of [[], DEFAULT_CALENDAR_HOLIDAYS, ALL]) {
    for (const year of [2024, 2026, 2027]) {
      for (let offset = 0; offset < 366; offset += 1) {
        const date = new Date(Date.UTC(year, 0, 1 + offset));
        if (date.getUTCFullYear() !== year) break;
        const today = day(year, date.getUTCMonth() + 1, date.getUTCDate());
        const preset = calendarPresetFor(today, { allowed });
        assert.ok(ids.has(preset), `${JSON.stringify(today)} ${allowed.length} -> ${preset}`);
        if (allowed.length === 0) assert.ok(['spring', 'summer', 'fall', 'winter'].includes(preset));
      }
    }
  }
});

test('local date parts and the start-now string follow the school time zone, not UTC', () => {
  const lateEvening = new Date('2026-10-17T02:30:00Z'); // 22:30 on Oct 16 in New York
  assert.deepEqual(localDateParts(lateEvening, 'America/New_York'), { year: 2026, month: 10, day: 16 });
  assert.deepEqual(localDateParts(lateEvening, 'UTC'), { year: 2026, month: 10, day: 17 });
  assert.deepEqual(localDateParts(lateEvening, 'Not/AZone'), { year: 2026, month: 10, day: 16 });
  assert.equal(localDateString(lateEvening, 'America/New_York'), '2026-10-16');
});
