import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const coverageSource = readFileSync(
  new URL('../src/products/classpilot/pages/Coverage.jsx', import.meta.url),
  'utf8',
);

test('the Claimed Students card counts students, never supervision contexts', () => {
  // Regression guard. The card used to render
  // `contexts.filter((c) => c.status === "active").length`, which is a count of
  // supervision groups: two students claimed into one group displayed as 1 while
  // the group card, the targeted badge, the student table and the dashboard tab
  // strip all correctly said 2.
  const cardIndex = coverageSource.indexOf('Claimed Students');
  assert.ok(cardIndex > 0, 'the Claimed Students card must exist');
  const card = coverageSource.slice(cardIndex, cardIndex + 400);

  assert.doesNotMatch(
    card,
    /contexts\s*\.?\s*filter\([\s\S]{0,120}\)\.length/,
    'the student count must never be derived from the number of supervision contexts',
  );
  assert.match(
    card,
    /summaryQuery\.data\?\.claimedStudentCount/,
    'the card must render the distinct-student count the server computes',
  );
});

test('the coverage summary is read from the same cache entry the dashboard uses', () => {
  // Sharing the queryKey with the dashboard is what keeps the two surfaces from
  // disagreeing, and it means the extra card costs no additional round trip.
  assert.match(
    coverageSource,
    /queryKey:\s*\["\/api\/coverage\/summary"\]/,
    'the summary query must use the shared /api/coverage/summary cache key',
  );
  assert.match(
    coverageSource,
    /queryFn:\s*\(\)\s*=>\s*apiRequest\("GET",\s*"\/coverage\/summary"\)/,
    'the summary query must call the coverage summary endpoint',
  );
});
