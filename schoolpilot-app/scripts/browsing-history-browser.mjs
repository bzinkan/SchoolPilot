import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  const errors = [], requests = [], aborted = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => aborted.push(request.url()));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes('browsing-history')) {
      await route.fulfill({ json: { user: { id: 'teacher-a' }, memberships: [{ id: 'membership-a', schoolId: 'school-a', role: 'teacher' }], licenses: {}, events: [], csrfToken: 'fixture-token' } });
      return;
    }
    const start = url.searchParams.get('startDate') || '2026-09-01';
    const cursor = url.searchParams.get('cursor');
    requests.push({ start, cursor, path: url.pathname });
    const meta = { studentId: 'student-a', timeZone: 'America/New_York', startDate: start,
      endDate: url.searchParams.get('endDate') || start, today: '2026-09-01', retentionDays: 30,
      scope: 'supervised_intervals', partiallyExpired: false };
    let status = 200, body;
    if (url.pathname.endsWith('/domains')) {
      body = { ...meta, state: 'available', days: [{ date: start, computedAt: '2026-09-01T18:00:00Z', domains: [{ domain: 'classroom.google.com', seconds: 120, contentCategory: null }] }] };
    } else if (start === '2026-08-31') {
      body = { ...meta, state: 'empty', entries: [], nextCursor: null };
    } else if (start === '2026-08-01') {
      body = { ...meta, state: 'expired', entries: [], nextCursor: null };
    } else if (start === '2026-08-27') {
      body = { ...meta, state: 'available', nextCursor: null, entries: [
        { id: 'search', activeTabTitle: 'Unknown', activeTabUrl: 'https://www.google.com/search?q=photosynthesis+for+kids' },
        { id: 'document', activeTabTitle: null, activeTabUrl: 'https://docs.google.com/document/d/fixture/edit' },
        { id: 'missing', activeTabTitle: 'Unknown', activeTabUrl: null },
        { id: 'reported', activeTabTitle: 'Our science project', activeTabUrl: 'https://docs.google.com/document/d/fixture-2/edit' },
      ].map(entry => ({ ...entry, timestamp: '2026-08-27T13:00:00Z', estimatedSeconds: 0, aiCategory: 'unknown' })) };
    } else if (['2026-08-30', '2026-08-29', '2026-08-28'].includes(start)) {
      const [state, responseStatus] = { '2026-08-30': ['denied', 403], '2026-08-29': ['unavailable', 503], '2026-08-28': ['failed', 500] }[start];
      status = responseStatus;
      body = { state, error: 'Fixture response' };
    } else {
      if (start === '2026-08-21') await delay(1500);
      body = { ...meta, state: 'available', entries: [{ id: cursor ? 'older' : 'first', timestamp: '2026-09-01T13:00:00.123456Z',
        activeTabUrl: 'https://classroom.google.com', activeTabTitle: cursor ? 'Older observation' : start === '2026-08-21' ? 'Stale observation' : 'Current observation',
        aiCategory: 'educational', contentCategory: null, estimatedSeconds: cursor ? 5 : 0 }], nextCursor: cursor ? null : 'next-fixture-cursor' };
    }
    try { await route.fulfill({ status, json: body }); }
    catch (error) { if (start !== '2026-08-21') throw error; }
  });
  await page.goto('http://127.0.0.1:4188/browsing-history-regression.html', { waitUntil: 'networkidle' });
  await page.getByTestId('tab-history').click();
  await page.getByText('Current observation', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('History start date').inputValue(), '2026-09-01');
  assert.match(await page.getByTestId('student-browsing-history').innerText(), /America\/New_York/);
  await page.getByRole('button', { name: 'Load older observations' }).click();
  await page.getByText('Older observation', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('history-observation').count(), 2);
  assert.ok(requests.some((item) => item.cursor === 'next-fixture-cursor'));
  for (const [date, text] of [['2026-08-31', 'No observations were recorded'], ['2026-08-01', 'outside the school’s browsing retention'],
    ['2026-08-30', 'You can view browsing only'], ['2026-08-29', 'temporarily unavailable'], ['2026-08-28', 'history request failed']]) {
    await page.getByLabel('History start date').fill(date);
    await page.getByText(text, { exact: false }).last().waitFor();
    assert.equal(await page.getByTestId('history-observation').count(), 0);
  }
  const supersededRequest = page.waitForRequest((request) => request.url().includes('/browsing-history') && request.url().includes('startDate=2026-08-21'));
  await page.getByLabel('History start date').fill('2026-08-21');
  await supersededRequest;
  await page.getByLabel('History start date').fill('2026-08-31');
  await page.getByText('No observations were recorded', { exact: false }).waitFor();
  await page.waitForTimeout(1700);
  assert.equal(await page.getByText('Stale observation', { exact: true }).count(), 0);
  assert.ok(aborted.some((url) => url.includes('startDate=2026-08-21')), 'Superseded history request was aborted');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByText('Current observation', { exact: true }).waitFor();
  const artifacts = path.join(root, 'artifacts', 'classpilot-roadmap');
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'browsing-history.png'), fullPage: true });
  await page.getByLabel('History start date').fill('2026-08-27');
  await page.getByText('Google search: photosynthesis for kids', { exact: true }).waitFor();
  await page.getByText('Google Docs document', { exact: true }).waitFor();
  await page.getByText('Page details unavailable', { exact: true }).waitFor();
  await page.getByText('Our science project', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('history-observation').count(), 4);
  assert.equal(await page.getByText('Unknown', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Off-task', { exact: true }).count(), 0, 'Fallback labels do not change classification');
  assert.equal(await page.getByRole('link', { name: 'https://www.google.com/search?q=photosynthesis+for+kids', exact: true }).getAttribute('href'), 'https://www.google.com/search?q=photosynthesis+for+kids');
  await page.screenshot({ path: path.join(artifacts, 'browsing-history-labels.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browsing history browser: actual drawer dates, pagination, school timezone, all states, stale-request abortion and descriptive page labels passed.');
} finally {
  await browser.close();
}
