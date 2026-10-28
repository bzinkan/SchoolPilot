import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminClassSortStorageKey,
  readAdminClassSortPreference,
  sortAdminClassesByTime,
  writeAdminClassSortPreference,
} from '../src/products/classpilot/lib/adminClassSort.js';

test('time sorting orders displayed start times and puts unscheduled classes last by name', () => {
  const rows = [
    { name: 'Later', scheduleEnabled: true, blockStartTime: '13:00', blockEndTime: '14:00' },
    { name: 'No schedule', scheduleEnabled: false, blockStartTime: '07:00', blockEndTime: '08:00' },
    { name: 'Same time, B', scheduleEnabled: true, blockStartTime: '08:30', blockEndTime: '09:15' },
    { name: 'Missing end', scheduleEnabled: true, blockStartTime: '06:30', blockEndTime: null },
    { name: 'Earlier', scheduleEnabled: true, blockStartTime: '07:45', blockEndTime: '08:25' },
    { name: 'Same time, A', scheduleEnabled: true, blockStartTime: '08:30', blockEndTime: '09:15' },
  ];

  assert.deepEqual(sortAdminClassesByTime(rows).map(row => row.name), [
    'Earlier', 'Same time, A', 'Same time, B', 'Later', 'Missing end', 'No schedule',
  ]);
});

test('sort preference is keyed by school and user and invalid values default to name', () => {
  const key = adminClassSortStorageKey('school/one', 'viewer:one');
  assert.equal(key, 'classpilot-admin-classes-sort:v1:school%2Fone:viewer%3Aone');
  assert.equal(adminClassSortStorageKey('', 'viewer'), null);
  const values = new Map();
  const storage = {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
  };

  assert.equal(readAdminClassSortPreference(key, storage), 'name');
  assert.equal(writeAdminClassSortPreference(key, 'time', storage), true);
  assert.equal(readAdminClassSortPreference(key, storage), 'time');
  storage.setItem(key, 'unknown');
  assert.equal(readAdminClassSortPreference(key, storage), 'name');
  assert.equal(writeAdminClassSortPreference(key, 'unknown', storage), false);
});

test('sort preference storage failures fall back to name without interrupting the page', () => {
  const unavailable = {
    getItem() { throw new Error('storage unavailable'); },
    setItem() { throw new Error('storage unavailable'); },
  };

  assert.equal(readAdminClassSortPreference('key', unavailable), 'name');
  assert.equal(writeAdminClassSortPreference('key', 'time', unavailable), false);
});
