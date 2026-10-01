import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base; const pages = new Map();
const auth = `import{useSyncExternalStore}from'react';export function useAuth(){const scope=useSyncExternalStore(fn=>{window.addEventListener('scope-change',fn);return()=>window.removeEventListener('scope-change',fn)},()=>window.__scope);return{user:scope.user,activeSchoolId:scope.school.id,activeMembership:{...scope.school,schoolId:scope.school.id,role:scope.user.role,roles:scope.user.roles},loading:false,logout:async()=>{},refetchUser:async()=>{}};}`;
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{MemoryRouter}from'react-router-dom';import Reports from'/src/products/passpilot/components/tabs/ReportsTab.jsx';import'/src/index.css';const h=React.createElement;const cache=new QueryClient({defaultOptions:{queries:{retry:false}}});window.reportCache=()=>cache.getQueryCache().findAll({queryKey:['passpilot-reports-v2']}).map(q=>q.state.data);createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:cache},h(MemoryRouter,null,h(React.Fragment,null,h('button',{onClick:()=>window.changeSchool()},'Change school'),h('button',{onClick:()=>window.changeAuthVersion()},'Change auth version'),h(Reports)))));`;
before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-reports-v2-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'reports-v2-test',
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url === '/login') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><main>Sign in</main>'); return; }
      if (!req.url?.startsWith('/__reports')) return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__report-entry.jsx"></script></body></html>'));
    }); }, resolveId(id) { if (id === '/__report-entry.jsx') return '\0report-entry'; }, load(id) {
      const name = id.replace(/\\/g, '/');
      if (name.endsWith('/contexts/AuthContext.jsx')) return auth;
      if (id === '\0report-entry') return entry;
    } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
async function close(page) { pages.get(page)?.releaseSummary?.(); pages.get(page)?.releaseExport?.(); await page.unrouteAll({ behavior: 'wait' }); await page.close(); pages.delete(page); }
after(async () => { try { for (const page of pages.keys()) await close(page); } finally { await browser?.close(); await vite?.close(); } });
const summary = patch => ({ version: 2, asOf: new Date().toISOString(), schoolTimezone: 'America/New_York', scope: 'school',
  counts: { total: 6, active: 2, returned: 3, canceled: 1 }, completedDuration: { count: 3, totalSeconds: 901.5, averageSeconds: 300.5 },
  completedOverdueRate: { numerator: 1, denominator: 3, ratio: 1 / 3 }, openCount: 2, currentlyOverdueCount: 1,
  destinations: [{ destination: 'office', count: 6 }], periods: { kind: 'school_local_hour', buckets: [{ hour: 9, label: '09:00–09:59', count: 6 }] },
  recordedDenials: { count: 4, coverage: 'best_effort' }, overrides: { count: 999 }, appointments: null,
  coverage: { state: 'partial', codes: ['RECORDED_DENIALS_BEST_EFFORT', 'HISTORICAL_BELL_PERIODS_UNAVAILABLE'] }, ...patch });
const pass = (id, name) => ({ id, studentId: `student-${id}`, studentName: name, teacherName: 'Synthetic Teacher', className: 'History Class', destination: 'office', status: 'returned', issuedAt: '2026-09-30T13:00:00Z', returnedAt: '2026-09-30T13:05:01.500Z', completedDurationSeconds: 301.5, staffNotes: 'Private encounter note', ruleOverrideCode: 'encounter' });
async function setup(options = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), state = { ...options }, requests = [], errors = [];
  state.exportReady = new Promise(resolve => { state.notifyExport = resolve; });
  pages.set(page, state); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('sp_activeSchoolId', 'school-a');
    window.__scope = { user: { id: 'office-a', role: 'office_staff', roles: ['office_staff'], authVersion: 1 }, school: { id: 'school-a', schoolTimezone: 'America/New_York' } };
    window.changeSchool = () => { window.__scope = { ...window.__scope, school: { ...window.__scope.school, id: 'school-b' } }; localStorage.setItem('sp_activeSchoolId', 'school-b'); window.dispatchEvent(new Event('scope-change')); };
    window.changeAuthVersion = () => { window.__scope = { ...window.__scope, user: { ...window.__scope.user, authVersion: window.__scope.user.authVersion + 1 } }; window.dispatchEvent(new Event('scope-change')); };
  });
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), school = req.headers()['x-school-id'];
    requests.push({ path: url.pathname, school, params: Object.fromEntries(url.searchParams), classContract: req.headers()['x-passpilot-class-model'] });
    const json = (data, status = 200) => route.fulfill({ json: data, status });
    if (url.pathname.endsWith('/reports/capabilities')) return state.denyCapabilities ? json({ error: 'Access changed' }, 403) : json({ enabled: true, version: 2, schoolTimezone: 'America/New_York', scope: 'school', administratorEvidence: false });
    if (url.pathname.endsWith('/classes')) return json({ classes: [{ id: 'class-a', name: 'History Class', filterKey: { type: 'classId', value: 'class-a' } }] });
    if (url.pathname.endsWith('/passes/issuers')) return json({ issuers: [{ id: 'teacher-a', displayName: 'Synthetic Teacher' }] });
    if (url.pathname.endsWith('/reports/summary')) {
      if (school === 'school-a' && state.holdSummary) await new Promise(resolve => { state.releaseSummary = resolve; });
      if (state.summaryFailure) return json({ error: 'Report request could not be authorized consistently.', ...state.summaryFailure.body }, state.summaryFailure.status);
      return json(school === 'school-b' ? summary({ counts: { total: 0, canceled: 0 }, completedDuration: { averageSeconds: null }, completedOverdueRate: { numerator: 0, denominator: 0, ratio: null }, destinations: [], periods: { buckets: [] }, coverage: { state: 'no_data', codes: [] } }) : summary());
    }
    if (url.pathname.endsWith('/reports/passes')) return json({ version: 2, passes: school === 'school-b' ? [] : [url.searchParams.has('cursor') ? pass('b', 'Second Student') : pass('a', 'Synthetic Student')], hasMore: school !== 'school-b' && !url.searchParams.has('cursor'), nextCursor: school !== 'school-b' && !url.searchParams.has('cursor') ? 'next-page' : null });
    if (url.pathname.endsWith('/reports/export.csv')) {
      if (state.holdExport) { state.notifyExport(); await new Promise(resolve => { state.releaseExport = resolve; }); }
      return state.snapshotChanged ? json({ error: 'Records changed during export.', code: 'PASSPILOT_REPORT_SNAPSHOT_CHANGED' }, 409) : state.exportLimit ? json({ error: 'Too many rows. Narrow the report range.', code: 'PASSPILOT_REPORT_EXPORT_LIMIT' }, 409) : route.fulfill({ contentType: 'text/csv', body: 'Metric,Value\nRetained passes,6\n' });
    }
    return json({ error: 'Unexpected request' }, 404);
  });
  await page.goto(`${base}/__reports`); return { page, state, requests, errors };
}
test('office reports distinguish completed outcomes, current overdue, partial coverage and complete pagination without private metadata', async () => {
  const { page, requests, errors } = await setup();
  try {
    await page.getByText('33.3% (1/3)', { exact: true }).waitFor(); await page.getByText('1 of 2 open', { exact: true }).waitFor();
    assert.equal(await page.getByText('Recorded rule overrides', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Private encounter note', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Load more passes' }).click(); await page.getByRole('button', { name: 'Filter to Second Student' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Load more passes' }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.PASSPILOT_REPORT_SCREENSHOTS) { await mkdir(process.env.PASSPILOT_REPORT_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.PASSPILOT_REPORT_SCREENSHOTS, 'reports-mobile.png'), fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(process.env.PASSPILOT_REPORT_SCREENSHOTS, 'reports-desktop.png'), fullPage: true }); }
    assert.ok(requests.filter(value => value.path.includes('/reports/')).every(value => value.school === 'school-a' && value.classContract === 'classpilot-groups-v1')); assert.deepEqual(errors, []);
  } finally { await close(page); }
});
test('reviewed student/class/channel filters reach summary, paginated history and audited CSV consistently', async () => {
  const { page, requests, errors } = await setup();
  try {
    await page.getByRole('button', { name: 'Filter to Synthetic Student' }).click(); await page.getByLabel('Class', { exact: true }).selectOption('classId:class-a'); await page.getByLabel('Issued through').selectOption('kiosk');
    await page.getByRole('button', { name: 'Export summary CSV' }).waitFor();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export summary CSV' }).click(); await download;
    await page.getByText('CSV downloaded. The server recorded this export.', { exact: true }).waitFor();
    const exported = requests.find(value => value.path.endsWith('/export.csv'));
    assert.equal(exported.params.classId, 'class-a'); assert.equal(exported.params.studentId, 'student-a'); assert.equal(exported.params.issuedVia, 'kiosk'); assert.equal(exported.params.kind, 'summary');
    assert.equal(exported.params.ruleCode, undefined); assert.equal(exported.params.schoolTimezone, undefined); assert.deepEqual(errors, []);
  } finally { await close(page); }
});
test('server export limits are shown without a partial download', async () => {
  const { page } = await setup({ exportLimit: true }); let downloaded = false; page.on('download', () => { downloaded = true; });
  try { await page.getByRole('button', { name: 'Export passes CSV' }).click(); await page.getByText('Too many rows. Narrow the report range.', { exact: true }).waitFor(); assert.equal(downloaded, false); }
  finally { await close(page); }
});
test('a late previous-school summary cannot restore old rows or private cache', async () => {
  const { page, state } = await setup({ holdSummary: true });
  try {
    await page.getByRole('button', { name: 'Filter to Synthetic Student' }).waitFor(); await page.getByRole('button', { name: 'Change school' }).click();
    await page.getByText('No retained records in this range;', { exact: false }).waitFor(); state.releaseSummary();
    assert.equal(await page.getByRole('button', { name: 'Filter to Synthetic Student' }).count(), 0);
    assert.equal(JSON.stringify(await page.evaluate(() => window.reportCache())).includes('Synthetic Student'), false);
  } finally { await close(page); }
});
test('known capability denial never falls back to an unverified legacy report', async () => {
  const { page, requests } = await setup({ denyCapabilities: true });
  try { await page.getByText('Report access could not be verified.', { exact: true }).waitFor(); assert.equal(requests.some(value => value.path.endsWith('/passes/history')), false); assert.equal(requests.some(value => value.path.endsWith('/reports/summary')), false); }
  finally { await close(page); }
});
test('actual PassPilot adapter propagates auth-version changes and aborts a held old-version export', async () => {
  const { page, state, requests } = await setup({ holdExport: true }); let downloaded = false; page.on('download', () => { downloaded = true; });
  try {
    await page.getByRole('button', { name: 'Export passes CSV' }).click();
    await state.exportReady;
    // The request may already have reached the route while its response is held.
    assert.ok(requests.some(value => value.path.endsWith('/export.csv')));
    await page.getByRole('button', { name: 'Change auth version' }).click();
    await page.getByRole('button', { name: 'Export passes CSV' }).waitFor(); state.releaseExport();
    assert.equal(downloaded, false);
    assert.ok(requests.filter(value => value.path.endsWith('/reports/capabilities')).length >= 2);
    assert.equal(await page.getByText('CSV downloaded. The server recorded this export.', { exact: true }).count(), 0);
  } finally { await close(page); }
});
test('a changed export snapshot removes displayed rows and requires a fresh consistent report', async () => {
  const { page, state } = await setup({ snapshotChanged: true });
  try {
    await page.getByRole('button', { name: 'Export passes CSV' }).click(); await page.getByText('Report records changed during the request.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Filter to Synthetic Student' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Load more passes' }).isDisabled(), true);
    assert.equal(await page.getByText('No retained pass history for these filters.', { exact: true }).count(), 0, 'A snapshot conflict cannot establish an empty history');
    state.snapshotChanged = false; await page.getByRole('button', { name: 'Refresh report', exact: true }).click(); await page.getByRole('button', { name: 'Filter to Synthetic Student' }).waitFor();
  } finally { await close(page); }
});

for (const failure of [{ status: 401 }, { status: 403 }, { status: 409, body: { code: 'PASSPILOT_REPORT_SNAPSHOT_CHANGED' } }]) {
test(`a known ${failure.status} report failure aborts a held export before it can download`, async () => {
  const { page, state, errors } = await setup({ holdExport: true });
  let downloaded = false; page.on('download', () => { downloaded = true; });
  try {
    await page.getByRole('button', { name: 'Export passes CSV' }).click();
    await state.exportReady;
    state.summaryFailure = failure;
    const exportAborted = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname.endsWith('/reports/export.csv'), timeout: 10_000 });
    void exportAborted.catch(() => {});
    await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
    if (failure.status === 401) await page.waitForURL('**/login');
    else await page.getByText(failure.status === 409
      ? 'Report records changed during the request. Refresh the report to load a consistent snapshot.'
      : 'Report access changed. Refresh this page before continuing.', { exact: true }).waitFor();
    await exportAborted;
    state.releaseExport();
    await page.waitForLoadState('networkidle');
    assert.equal(downloaded, false, 'a verified authority or snapshot failure must retire the pending export');
    assert.equal(await page.getByText('CSV downloaded. The server recorded this export.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Filter to Synthetic Student' }).count(), 0);
    if (failure.status === 409) {
      state.summaryFailure = null;
      await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
      await page.getByText('33.3% (1/3)', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Export passes CSV' }).isEnabled(), true, 'an aborted export must not keep the refreshed interface busy');
    }
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});
}
