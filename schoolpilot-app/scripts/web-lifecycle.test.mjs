import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { formatLivePassDuration } from '../src/products/passpilot/passDuration.js';

test('live pass duration hides seconds while counting only completed minutes', () => {
  const issuedAt = '2026-10-21T15:17:25.000Z';
  const issuedMs = Date.parse(issuedAt);
  for (const [elapsedMs, expected] of [
    [0, '<1 min'],
    [999, '<1 min'],
    [35_999, '<1 min'],
    [59_999, '<1 min'],
    [60_000, '1 min'],
    [60_999, '1 min'],
    [275_999, '4 min'],
    [299_999, '4 min'],
    [300_000, '5 min'],
    [310_999, '5 min'],
    [3_661_000, '61 min'],
  ]) {
    assert.equal(formatLivePassDuration(issuedAt, issuedMs + elapsedMs), expected);
  }
});

test('live pass duration reconciles the screenshot start time with the current clock', () => {
  const issuedAt = '2026-10-21T15:17:25.000Z';
  assert.equal(
    formatLivePassDuration(issuedAt, Date.parse('2026-10-21T15:22:00.000Z')),
    '4 min',
  );
  assert.equal(
    formatLivePassDuration(issuedAt, Date.parse('2026-10-21T15:22:35.000Z')),
    '5 min',
  );
});

test('live pass duration distinguishes unknown times from a new pass and clamps clock skew', () => {
  const now = Date.parse('2026-10-21T15:22:00.000Z');
  for (const issuedAt of [undefined, null, '', 'invalid', new Date('invalid')]) {
    assert.equal(formatLivePassDuration(issuedAt, now), '—');
  }
  for (const invalidNow of [Number.NaN, Infinity, -Infinity, null, 'invalid']) {
    assert.equal(formatLivePassDuration('2026-10-21T15:17:25.000Z', invalidNow), '—');
  }
  assert.equal(formatLivePassDuration('2026-10-21T15:22:01.000Z', now), '<1 min');
});

test('live pass duration measures absolute elapsed time across timezone offsets and DST', () => {
  assert.equal(
    formatLivePassDuration('2026-10-21T11:17:25-04:00', Date.parse('2026-10-21T15:22:00.000Z')),
    '4 min',
  );
  assert.equal(
    formatLivePassDuration('2026-11-01T01:59:30-04:00', Date.parse('2026-11-01T01:00:30-05:00')),
    '1 min',
  );
});

test('PassPilot staff surfaces share one external-store clock and retain data polling', async () => {
  const myClass = await readFile(
    new URL('../src/products/passpilot/components/tabs/MyClassTab.jsx', import.meta.url),
    'utf8',
  );
  const passes = await readFile(
    new URL('../src/products/passpilot/components/tabs/PassesTab.jsx', import.meta.url),
    'utf8',
  );
  const ticker = await readFile(
    new URL('../src/products/passpilot/components/LivePassDuration.jsx', import.meta.url),
    'utf8',
  );

  assert.match(myClass, /refetchInterval: 3000/);
  assert.match(myClass, /structuralSharing: true/);
  assert.match(myClass, /const nowMs = usePassNow\(\)/);
  assert.match(passes, /const nowMs = usePassNow\(\)/);
  assert.match(ticker, /export function usePassNow\(\)/);
  assert.doesNotMatch(myClass, /currentTime|setInterval\s*\(/);
  assert.doesNotMatch(passes, /setInterval\s*\(/);
  assert.equal((ticker.match(/setInterval\s*\(/g) || []).length, 1);
  assert.equal((ticker.match(/clearInterval\s*\(/g) || []).length, 1);
});

test('PassPilot staff UI exposes overdue resolution and guarded duration settings', async () => {
  const myClass = await readFile(
    new URL('../src/products/passpilot/components/tabs/MyClassTab.jsx', import.meta.url),
    'utf8',
  );
  const passes = await readFile(
    new URL('../src/products/passpilot/components/tabs/PassesTab.jsx', import.meta.url),
    'utf8',
  );
  const setup = await readFile(
    new URL('../src/products/passpilot/components/admin/SetupView.jsx', import.meta.url),
    'utf8',
  );

  for (const surface of [myClass, passes]) {
    assert.match(surface, /Mark Returned/);
    assert.match(surface, /Cancel Pass/);
    assert.match(surface, /does not mark the student returned/);
  }
  assert.match(myClass, /`\/passes\/\$\{passId\}\/cancel`/);
  assert.match(passes, /`\/passes\/\$\{pass\.id\}\/\$\{action\}`/);
  assert.match(setup, /settings\.defaultPassDuration !== undefined/);
  assert.match(setup, />Overdue after \(minutes\)<\/Label>/);
  assert.match(setup, /defaultPassDuration >= 1/);
  assert.match(setup, /defaultPassDuration <= 240/);
  assert.match(setup, /Changes apply only to new passes/);
});

test('Rosters fetch only the active surface and use server cursor pagination', async () => {
  const roster = await readFile(
    new URL('../src/products/classpilot/pages/Roster.jsx', import.meta.url),
    'utf8',
  );

  assert.match(roster, /const ROSTER_PAGE_SIZE = 100/);
  assert.match(roster, /const ROSTER_MAX_PAGE_SIZE = 200/);
  assert.match(roster, /enabled: activeTab === "students"/);
  assert.match(roster, /enabled: isAdmin && activeTab === "extensions"/);
  assert.match(roster, /\/classpilot\/roster\/students\?\$\{params\}/);
  assert.match(roster, /pageInfo\.nextCursor/);
  assert.doesNotMatch(roster, /filteredStudents\.slice\(/);
  assert.match(roster, /visibleStudents\.map/);

  const studentForm = roster.match(/function blankStudentForm\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(studentForm, /deviceId|deviceName|classId/);
});
