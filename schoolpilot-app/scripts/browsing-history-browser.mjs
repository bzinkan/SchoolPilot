import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageEmptyText = 'No page details were recorded in the selected accessible dates. Include observations without page details to check for monitoring activity.';
const rawEmptyText = 'No observations were recorded in the selected accessible dates.';
const observation = (id, title, url = 'https://classroom.google.com') => ({
  id, timestamp: '2026-09-01T13:00:00.123456Z', activeTabUrl: url, activeTabTitle: title,
  aiCategory: 'educational', contentCategory: null, estimatedSeconds: 0,
});
const visit = (id, title, url, start, end, observationCount, estimatedSeconds) => ({
  ...observation(id, title, url), timestamp: end, startedAt: start, endedAt: end,
  observationCount, estimatedSeconds,
});
const continuousVisit = (id, title) => visit(id, title, 'https://classroom.google.com',
  '2026-09-01T13:00:00Z', '2026-09-01T13:05:00.004Z', 31, 300.004);
const separateVisits = [
  visit('after-gap', 'Signing in', 'https://clever.com', '2026-08-25T13:08:00Z', '2026-08-25T13:08:20Z', 3, 20),
  visit('returned', 'Signing in', 'https://clever.com', '2026-08-25T13:05:00Z', '2026-08-25T13:05:30Z', 3, 30),
  { ...visit('different-page', 'Classroom assignment', 'https://classroom.google.com/c/assignment', '2026-08-25T13:04:00Z', '2026-08-25T13:05:00Z', 6, 60), aiCategory: null, hasOffTaskObservation: true },
  visit('first-visit', 'Signing in', 'https://clever.com', '2026-08-25T13:00:00Z', '2026-08-25T13:04:00Z', 24, 240),
];
const blankObservations = [
  observation('blank-first', 'Page details unavailable', null),
  observation('blank-second', 'Page details unavailable', null),
];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' });
  const errors = [], requests = [], aborted = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => aborted.push(new URL(request.url())));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes('browsing-history')) {
      await route.fulfill({ json: { user: { id: 'teacher-a' }, memberships: [{ id: 'membership-a', schoolId: 'school-a', role: 'teacher' }], licenses: {}, events: [], csrfToken: 'fixture-token' } });
      return;
    }
    const start = url.searchParams.get('startDate') || '2026-09-01';
    const cursor = url.searchParams.get('cursor');
    const view = url.searchParams.get('view');
    const grouping = url.searchParams.get('grouping');
    const isDomains = url.pathname.endsWith('/domains');
    requests.push({ start, cursor, view, grouping, isDomains });
    const meta = { studentId: 'student-a', timeZone: 'America/New_York', startDate: start,
      endDate: url.searchParams.get('endDate') || start, today: '2026-09-01', retentionDays: 30,
      scope: 'supervised_intervals', partiallyExpired: false };
    // Model complete server-grouped visits; adjacency, gaps and cursor boundaries are covered by backend tests.
    // An omitted view deliberately returns the legacy raw list so the UI must request pages.
    const pagesOnly = view === 'pages';
    const delayed = !isDomains && pagesOnly && ['2026-08-21', '2026-08-20'].includes(start);
    let status = 200, body;
    if (isDomains) {
      body = { ...meta, state: 'available', days: [{ date: start, computedAt: '2026-09-01T18:00:00Z', domains: [{ domain: 'classroom.google.com', seconds: 120, contentCategory: null }] }] };
    } else if (start === '2026-08-31') {
      body = { ...meta, state: pagesOnly ? 'empty' : 'available', entries: pagesOnly ? [] : blankObservations, nextCursor: null };
    } else if (start === '2026-08-26') {
      body = { ...meta, state: 'empty', entries: [], nextCursor: null };
    } else if (start === '2026-08-25') {
      body = { ...meta, state: 'available', entries: separateVisits, nextCursor: null };
    } else if (start === '2026-08-01') {
      body = { ...meta, state: 'expired', entries: [], nextCursor: null };
    } else if (start === '2026-08-27') {
      body = { ...meta, state: 'available', nextCursor: null, entries: [
        { id: 'search', activeTabTitle: 'Unknown', activeTabUrl: 'https://www.google.com/search?q=photosynthesis+for+kids' },
        { id: 'document', activeTabTitle: null, activeTabUrl: 'https://docs.google.com/document/d/fixture/edit' },
        { id: 'missing', activeTabTitle: 'Unknown', activeTabUrl: null },
        { id: 'reported', activeTabTitle: 'Our science project', activeTabUrl: 'https://docs.google.com/document/d/fixture-2/edit' },
      ].filter(entry => !pagesOnly || entry.id !== 'missing')
        .map(entry => ({ ...entry, timestamp: '2026-08-27T13:00:00Z', estimatedSeconds: 0, aiCategory: 'unknown' })) };
    } else if (['2026-08-30', '2026-08-29', '2026-08-28'].includes(start)) {
      const [state, responseStatus] = { '2026-08-30': ['denied', 403], '2026-08-29': ['unavailable', 503], '2026-08-28': ['failed', 500] }[start];
      status = responseStatus;
      body = { state, error: 'Fixture response' };
    } else {
      if (delayed) await delay(1000);
      const entries = pagesOnly
        ? [cursor ? observation('older-page', 'Older page') : continuousVisit('current-page', delayed ? 'Stale page' : 'Current page')]
        : cursor ? [observation('older-raw', 'Older raw observation')]
          : [...blankObservations, continuousVisit('current-raw', 'Current raw observation')];
      body = { ...meta, state: 'available', entries, nextCursor: cursor ? null : pagesOnly ? 'next-pages-cursor' : 'next-all-cursor' };
    }
    try { await route.fulfill({ status, json: body }); }
    catch (error) { if (!delayed) throw error; }
  });
  await page.goto('http://127.0.0.1:4188/browsing-history-regression.html', { waitUntil: 'networkidle' });
  await page.getByTestId('tab-history').click();
  const includeUnavailable = page.getByRole('checkbox', { name: 'Include observations without page details', exact: true });
  const historyRows = page.getByTestId('history-observation');
  const blankRows = page.getByText('No page URL recorded', { exact: true });
  const startDate = page.getByLabel('History start date');
  const loadOlder = page.getByRole('button', { name: 'Load older visits' });
  const historyRequests = () => requests.filter(item => !item.isDomains);
  const domainRequests = () => requests.filter(item => item.isDomains);

  await page.getByText('Current page', { exact: true }).waitFor();
  assert.equal(await includeUnavailable.isChecked(), false);
  assert.equal(await blankRows.count(), 0);
  assert.equal(await startDate.inputValue(), '2026-09-01');
  assert.match(await page.getByTestId('student-browsing-history').innerText(), /America\/New_York/);
  assert.match(await page.getByTestId('student-browsing-history').innerText(), /Only your supervised intervals are included/);
  assert.deepEqual(historyRequests().map(({ view, cursor, grouping }) => ({ view, cursor, grouping })), [{ view: 'pages', cursor: null, grouping: 'visits' }]);
  assert.equal(await historyRows.count(), 1, 'Thirty-one same-page observations appear as one complete visit');
  const currentRange = await historyRows.first().getByTestId('history-visit-range').innerText();
  assert.match(currentRange, /Sep 1/);
  assert.match(currentRange, /9:00:00/);
  assert.match(currentRange, /9:05:00/);
  assert.match(await historyRows.first().innerText(), /~5m/);
  assert.match(await historyRows.first().innerText(), /31 observations/);
  assert.doesNotMatch(await historyRows.first().innerText(), /300\.004|10\.004/);
  await page.getByText('Showing 1 visit', { exact: true }).waitFor();
  await loadOlder.click();
  await page.getByText('Older page', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 2);
  assert.ok(historyRequests().some(item => item.view === 'pages' && item.cursor === 'next-pages-cursor'));

  // Changing views starts the new view's pagination and preserves access to raw observations.
  const domainsBeforeToggle = domainRequests().length;
  await includeUnavailable.check();
  await page.getByText('Current raw observation', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 3);
  assert.equal(await blankRows.count(), 2);
  assert.equal(await page.getByText('Older page', { exact: true }).count(), 0);
  assert.deepEqual(historyRequests().filter(item => item.view === 'all').map(item => item.cursor), [null]);
  await loadOlder.click();
  await page.getByText('Older raw observation', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 4);
  assert.ok(historyRequests().some(item => item.view === 'all' && item.cursor === 'next-all-cursor'));
  const pageRequestsBeforeReturn = historyRequests().filter(item => item.view === 'pages' && item.cursor === null).length;
  await includeUnavailable.uncheck();
  await page.getByText('Current page', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 1, 'Returning to a view starts fresh authorization and pagination');
  assert.ok(historyRequests().filter(item => item.view === 'pages' && item.cursor === null).length > pageRequestsBeforeReturn);
  await loadOlder.click();
  await page.getByText('Older page', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 2);
  assert.equal(await blankRows.count(), 0);
  assert.equal(await page.getByText('Older raw observation', { exact: true }).count(), 0);
  assert.equal(domainRequests().length, domainsBeforeToggle, 'View changes do not refetch or change domain summaries');
  assert.ok(domainRequests().every(item => item.view === null && item.cursor === null && item.grouping === null));

  // The UI preserves server visit boundaries even when separated visits share the exact same URL.
  await startDate.fill('2026-08-25');
  await page.getByText('Classroom assignment', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 4);
  assert.equal(await page.getByText('Signing in', { exact: true }).count(), 3, 'Returning visits and connection gaps remain separate cards');
  assert.match(await historyRows.nth(0).innerText(), /~20s/);
  assert.match(await historyRows.nth(1).innerText(), /~30s/);
  assert.match(await historyRows.nth(3).innerText(), /~4m/);
  await page.getByText('Off-task observed', { exact: true }).waitFor();
  await page.getByText('Showing 4 visits · End of retained results', { exact: true }).waitFor();
  assert.equal(await loadOlder.count(), 0);

  // A date containing only blank observations is empty in pages view, with an explicit way to inspect activity.
  await startDate.fill('2026-08-31');
  await page.getByText(pageEmptyText, { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 0);
  await includeUnavailable.check();
  await blankRows.first().waitFor();
  assert.equal(await historyRows.count(), 2);
  assert.equal(await page.getByText(pageEmptyText, { exact: true }).count(), 0);
  assert.equal(await loadOlder.count(), 0);
  await startDate.fill('2026-08-26');
  await page.getByText(rawEmptyText, { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 0);
  await includeUnavailable.uncheck();
  await page.getByText(pageEmptyText, { exact: true }).waitFor();

  for (const [date, text] of [['2026-08-01', 'outside the school’s browsing retention'],
    ['2026-08-30', 'You can view browsing only'], ['2026-08-29', 'temporarily unavailable'], ['2026-08-28', 'history request failed']]) {
    await startDate.fill(date);
    await page.getByText(text, { exact: false }).last().waitFor();
    assert.equal(await historyRows.count(), 0);
    assert.equal(await page.getByText(pageEmptyText, { exact: true }).count(), 0, 'Failure and retention states are not presented as empty browsing');
  }

  // A delayed response from a superseded date cannot repopulate the selected date.
  const dateRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname.endsWith('/browsing-history') && url.searchParams.get('startDate') === '2026-08-21';
  });
  await startDate.fill('2026-08-21');
  await dateRequest;
  await startDate.fill('2026-08-31');
  await page.getByText(pageEmptyText, { exact: true }).waitFor();
  await delay(1200);
  assert.equal(await page.getByText('Stale page', { exact: true }).count(), 0);
  assert.ok(aborted.some(url => url.searchParams.get('startDate') === '2026-08-21' && url.searchParams.get('view') === 'pages'), 'Superseded date request was aborted');

  // Changing view also aborts in-flight requests and starts at that view's first page.
  const modeRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname.endsWith('/browsing-history') && url.searchParams.get('startDate') === '2026-08-20' && url.searchParams.get('view') === 'pages';
  });
  await startDate.fill('2026-08-20');
  await modeRequest;
  await includeUnavailable.check();
  await page.getByText('Current raw observation', { exact: true }).waitFor();
  await delay(1200);
  assert.equal(await historyRows.count(), 3);
  assert.equal(await page.getByText('Stale page', { exact: true }).count(), 0);
  assert.ok(aborted.some(url => url.searchParams.get('startDate') === '2026-08-20' && url.searchParams.get('view') === 'pages'), 'Superseded view request was aborted');
  assert.deepEqual(historyRequests().filter(item => item.start === '2026-08-20' && item.view === 'all').map(item => item.cursor), [null]);

  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByText('Current raw observation', { exact: true }).waitFor();
  await includeUnavailable.uncheck();
  await page.getByText('Current page', { exact: true }).waitFor();
  assert.equal(await blankRows.count(), 0);
  assert.equal(await startDate.inputValue(), '2026-09-01');
  const artifacts = path.join(root, 'artifacts', 'classpilot-roadmap');
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'browsing-history.png'), fullPage: true });
  await page.getByLabel('History start date').fill('2026-08-27');
  await page.getByText('Google search: photosynthesis for kids', { exact: true }).waitFor();
  await page.getByText('Google Docs document', { exact: true }).waitFor();
  await page.getByText('Our science project', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 3);
  assert.equal(await page.getByText('Page details unavailable', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Unknown', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Off-task', { exact: true }).count(), 0, 'Fallback labels do not change classification');
  assert.equal(await page.getByRole('link', { name: 'https://www.google.com/search?q=photosynthesis+for+kids', exact: true }).getAttribute('href'), 'https://www.google.com/search?q=photosynthesis+for+kids');
  await page.screenshot({ path: path.join(artifacts, 'browsing-history-labels.png'), fullPage: true });
  await includeUnavailable.check();
  await page.getByText('Page details unavailable', { exact: true }).waitFor();
  assert.equal(await historyRows.count(), 4);
  assert.equal(await page.getByText('Unknown', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Off-task', { exact: true }).count(), 0, 'Missing-page fallback labels do not change classification');
  assert.ok(historyRequests().every(item => item.grouping === 'visits'), 'Every history view and cursor explicitly requests server-grouped visits');
  assert.deepEqual(errors, []);
  console.log('Browsing history browser: complete grouped visit ranges/durations/counts, separate return/gap visits, mixed off-task evidence, page-only default, individual blank observation access, view-specific pagination/cache, blank-only dates, unchanged domains, timezone/authority/error states, stale date/view request abortion, and descriptive page labels passed.');
} finally {
  await browser.close();
}
