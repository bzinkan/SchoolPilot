import assert from 'node:assert/strict';
import test from 'node:test';
import { adventStart, calendarPresetFor, easterSunday, localDateParts, thanksgivingDay } from '../src/shared/themes/calendar.js';

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

test('every day of a leap year resolves to exactly one shipped preset id', () => {
  const ids = new Set(['halloween', 'thanksgiving', 'christmas', 'advent', 'valentines', 'st-patricks', 'easter', 'spring', 'summer', 'fall', 'winter']);
  for (const liturgical of [false, true]) {
    for (let day = 0; day < 366; day += 1) {
      const date = new Date(Date.UTC(2024, 0, 1 + day));
      const today = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
      const preset = calendarPresetFor(today, { liturgical });
      assert.ok(ids.has(preset), `${JSON.stringify(today)} → ${preset}`);
      if (!liturgical) assert.notEqual(preset, 'advent', 'Advent is only offered to schools that ask for it');
    }
  }
});

test('holidays win over their season and seasons cover the rest', () => {
  assert.equal(calendarPresetFor({ year: 2026, month: 10, day: 16 }), 'halloween');
  assert.equal(calendarPresetFor({ year: 2026, month: 10, day: 2 }), 'fall');
  assert.equal(calendarPresetFor({ year: 2026, month: 11, day: 20 }), 'thanksgiving');
  assert.equal(calendarPresetFor({ year: 2026, month: 11, day: 27 }), 'fall');
  assert.equal(calendarPresetFor({ year: 2026, month: 12, day: 10 }), 'christmas');
  assert.equal(calendarPresetFor({ year: 2026, month: 12, day: 10 }, { liturgical: true }), 'advent');
  assert.equal(calendarPresetFor({ year: 2026, month: 12, day: 25 }, { liturgical: true }), 'christmas');
  assert.equal(calendarPresetFor({ year: 2026, month: 2, day: 14 }), 'valentines');
  assert.equal(calendarPresetFor({ year: 2026, month: 3, day: 17 }), 'st-patricks');
  assert.equal(calendarPresetFor({ year: 2026, month: 4, day: 5 }), 'easter');
  assert.equal(calendarPresetFor({ year: 2026, month: 3, day: 24 }), 'easter', 'two weeks before Easter Sunday');
  assert.equal(calendarPresetFor({ year: 2026, month: 5, day: 10 }), 'spring');
  assert.equal(calendarPresetFor({ year: 2026, month: 7, day: 4 }), 'summer');
  assert.equal(calendarPresetFor({ year: 2026, month: 1, day: 20 }), 'winter');
});

test('local date parts follow the school time zone, not UTC', () => {
  const lateEvening = new Date('2026-10-17T02:30:00Z'); // 22:30 on Oct 16 in New York
  assert.deepEqual(localDateParts(lateEvening, 'America/New_York'), { year: 2026, month: 10, day: 16 });
  assert.deepEqual(localDateParts(lateEvening, 'UTC'), { year: 2026, month: 10, day: 17 });
});
