import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { formatLivePassDuration } from '../src/products/passpilot/passDuration.js';

test('live pass duration preserves the existing minute label behavior', () => {
  const now = Date.parse('2026-08-22T12:05:30.000Z');
  assert.equal(formatLivePassDuration('2026-08-22T12:00:00.000Z', now), '5 min');
  assert.equal(formatLivePassDuration('invalid', now), '0 min');
});

test('MyClass isolates its clock while retaining the three-second data cadence', async () => {
  const myClass = await readFile(
    new URL('../src/products/passpilot/components/tabs/MyClassTab.jsx', import.meta.url),
    'utf8',
  );
  const ticker = await readFile(
    new URL('../src/products/passpilot/components/LivePassDuration.jsx', import.meta.url),
    'utf8',
  );

  assert.match(myClass, /refetchInterval: 3000/);
  assert.match(myClass, /structuralSharing: true/);
  assert.match(myClass, /<LivePassDuration issuedAt=\{pass\.issuedAt\}/);
  assert.doesNotMatch(myClass, /currentTime|setInterval\s*\(/);
  assert.equal((ticker.match(/setInterval\s*\(/g) || []).length, 1);
  assert.equal((ticker.match(/clearInterval\s*\(/g) || []).length, 1);
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
