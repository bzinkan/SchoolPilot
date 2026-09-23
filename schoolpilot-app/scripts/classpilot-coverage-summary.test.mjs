import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../src/products/classpilot/${path}`, import.meta.url), 'utf8');
const hub = source('pages/Coverage.jsx');
const dashboard = source('pages/Dashboard.jsx');
const summary = source('lib/useScheduledTestingView.js');
const review = source('components/SupervisionSessionDialog.jsx');

test('supervision student counts remain distinct from counts of live sessions', () => {
  // The duplicate console is gone; counts now live on each session and the
  // dashboard Claimed badge. Two students in one context must still mean two.
  assert.match(hub, /\{context\.activeStudentCount\} student/,
    'each session must display its server-supplied student count');
  assert.match(dashboard, /claimedCount=\{ownSupervisionStudentCount\}/,
    'the Claimed badge must use the student count, never the context count');
  assert.match(summary, /ownSupervisionStudentCount[\s\S]{0,180}ownSupervisionContexts\.reduce\(\(total, context\) => total \+ context\.activeStudentCount, 0\)/,
    'the owner student total must sum authoritative roster counts');
  assert.match(dashboard, /coverageCount=\{activeCoverageCount\}/,
    'the separate Supervision badge may count live contexts');
});

test('hub and reviewed mutations invalidate the scoped dashboard supervision summary', () => {
  assert.match(hub, /queryClient\.invalidateQueries\(\{ queryKey: \["\/api\/coverage\/summary"\] \}\)/,
    'hub mutations must invalidate the lightweight dashboard summary');
  assert.match(review, /const roots = \[[^\n]*'\/api\/coverage\/summary'/,
    'reviewed Start/Send/end-time changes must refresh the same summary');
  assert.match(summary, /\['\/api\/coverage\/summary', schoolId, viewerId\]/,
    'summary cache identity must isolate school and viewer');
  assert.match(summary, /apiRequest\('GET', '\/coverage\/summary', undefined, \{[\s\S]{0,100}headers: \{ 'X-School-Id': schoolId \}/,
    'summary reads must retain their exact school request scope');
  assert.match(hub, /queryKey: \["\/api\/coverage\/contexts", schoolId, currentUser\?\.id\]/,
    'the hub live-session query must also isolate school and viewer');
});
