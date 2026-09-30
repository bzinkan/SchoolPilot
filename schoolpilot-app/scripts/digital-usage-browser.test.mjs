import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { usageAddDays } from '../src/products/classpilot/lib/digitalUsage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(os.tmpdir(), 'schoolpilot-digital-usage');
let vite, browser, base;
const authModule = `import {createContext,useContext} from 'react';export const FixtureAuthContext=createContext(null);export const useAuth=()=>useContext(FixtureAuthContext);`;
const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route}from'react-router-dom';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import{FixtureAuthContext}from'/src/contexts/AuthContext.jsx';
import Layout from'/src/products/classpilot/components/admin/ClassPilotAdminShell.jsx';import Usage from'/src/products/classpilot/pages/AdminUsage.jsx';import'/src/index.css';
const h=React.createElement,params=new URLSearchParams(location.search),zone=params.get('zone')||'America/New_York';history.replaceState(null,'','/classpilot/admin/usage');
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});function Harness(){const[school,setSchool]=useState('school-a'),[role,setRole]=useState(params.get('role')||'school_admin');
window.fixtureSchool=setSchool;window.fixtureRole=setRole;const membership={schoolId:school,schoolName:school==='school-a'?'Cedar Grove School':'Maple School',schoolTimezone:zone,roles:[role],role,status:'active'};
return h(FixtureAuthContext.Provider,{value:{user:{id:'viewer-a',firstName:'Morgan',lastName:'Reed'},activeSchoolId:school,activeMembership:membership,loading:false}},h(Routes,null,h(Route,{element:h(Layout)},h(Route,{path:'/classpilot/admin/usage',element:h(Usage)}))));}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(BrowserRouter,null,h(ThemeProvider,null,h(Harness)))));`;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-usage-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'usage-fixture', enforce: 'pre', transform(_code, id) { if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null }; },
      configureServer(server) { server.middlewares.use(async (req, res, next) => { if (!req.url?.startsWith('/__usage')) return next(); res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module">${entry}</script></body></html>`)); }); } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

function reportFor(url, schoolId, mode = 'partial') {
  const from = url.searchParams.get('from'), to = url.searchParams.get('to'), scope = url.searchParams.get('scope'), id = url.searchParams.get('id');
  const dates = []; for (let date = from; date <= to; date = usageAddDays(date, 1)) dates.push(date);
  const covered = mode === 'unavailable' ? [] : mode === 'empty' ? dates : dates.filter((_, index) => index === 0 || index === 3 || index === dates.length - 1);
  const byDay = covered.map((date, index) => ({ date, state: date === to ? 'live' : 'final', monitoredBrowserSeconds: mode === 'empty' || index === 1 ? 0 : index === 0 ? 3600 : 1200,
    instructionalSeconds: mode === 'empty' || index === 1 ? 0 : index === 0 ? 3600 : 0, offTaskSeconds: mode !== 'empty' && index === 2 ? 900 : 0, unknownSeconds: mode !== 'empty' && index === 2 ? 300 : 0,
    activeMonitoredStudents: mode === 'empty' || index === 1 ? 0 : 2, heartbeatCount: mode === 'empty' || index === 1 ? 0 : 240 }));
  const totals = Object.fromEntries(['monitoredBrowserSeconds', 'instructionalSeconds', 'offTaskSeconds', 'unknownSeconds', 'heartbeatCount'].map(key => [key, byDay.reduce((sum, day) => sum + day[key], 0)]));
  return { schemaVersion: 1, measure: 'Monitored Browser Time', scope: { kind: scope, id, label: scope === 'school' ? schoolId === 'school-a' ? 'Cedar Grove School' : 'Maple School' : `${scope}: ${id}` },
    range: { from, to, today: to, timeZone: 'America/New_York', retentionDays: 30, retainedFrom: '2026-09-02', partiallyExpired: from < '2026-09-02', computedFrom: covered[0] || null,
      partiallyComputed: covered.length < dates.length, requestedDays: dates.length, computedDays: covered.length, unavailableDates: dates.filter(date => !covered.includes(date)), presentedFrom: covered[0] || null, presentedTo: covered.at(-1) || null },
    dataState: covered.length ? 'live' : 'unavailable', generatedAt: '2026-09-30T12:00Z', computedAt: covered.length ? '2026-09-30T11:00Z' : null, totals: { ...totals, activeMonitoredStudents: mode === 'empty' ? 0 : 2 }, byDay,
    topEducationalDomains: mode === 'empty' ? [] : [{ domain: 'ixl.com', seconds: 3600 }], topNonEducationalDomains: mode === 'empty' ? [] : [{ domain: 'games.example.test', seconds: 900 }] };
}

async function open({ mode = 'partial', role = 'school_admin', zone = 'America/New_York', now = '2026-09-30T12:00Z', handler } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.clock.install({ time: new Date(now) });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), schoolId = request.headers()['x-school-id'];
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), schoolId });
    if (handler && await handler(route, url, schoolId)) return;
    if (url.pathname.endsWith('/admin/usage')) {
      if (url.searchParams.get('format') === 'csv') return route.fulfill({ contentType: 'text/csv', headers: { 'content-disposition': 'attachment; filename=fixture.csv' }, body: '\ufeffMeasure,Monitored Browser Time\r\n' });
      return route.fulfill({ json: reportFor(url, schoolId, mode) });
    }
    if (url.pathname.endsWith('/classpilot/roster/students')) return route.fulfill({ json: { students: [{ id: `${schoolId}-student`, firstName: schoolId === 'school-a' ? 'Avery' : 'Jamie', lastName: 'Brooks', gradeLevel: '6' }] } });
    if (url.pathname.endsWith('/admin/settings')) return route.fulfill({ json: { sections: { rosterGrades: { gradeLevels: ['6', '9'] } } } });
    if (url.pathname.endsWith('/admin/classes')) return route.fulfill({ json: { classes: [{ id: `${schoolId}-class`, name: 'Biology', status: 'active' }] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/__usage?${new URLSearchParams({ role, zone })}`); await page.waitForLoadState('networkidle');
  return { page, errors, requests };
}

test('partial report preserves the internal gap and successful empty day, exports canonical audited endpoint, and fits mobile', async () => {
  const { page, errors, requests } = await open();
  try {
    await page.getByTestId('usage-total').waitFor();
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Monitored Browser Time');
    await page.getByText('3 of 7 retained days computed', { exact: false }).waitFor();
    assert.match(await page.getByTestId('usage-day-2026-09-26').textContent(), /Unavailable—/);
    assert.match(await page.getByTestId('usage-day-2026-09-27').textContent(), /Final0s0/);
    assert.equal(await page.getByTestId('usage-total').textContent(), '1h 20m');
    assert.equal(await page.getByText('ixl.com', { exact: true }).isVisible(), true);
    const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
    const download = await downloaded; assert.match(await readFile(await download.path(), 'utf8'), /Monitored Browser Time/);
    assert.equal(requests.at(-1).params.format, 'csv'); assert.equal(requests.at(-1).schoolId, 'school-a'); assert.equal('id' in requests[0].params, false);
    await page.screenshot({ path: path.join(artifacts, 'usage-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'usage-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('scope choices use canonical same-school IDs and no missing selection triggers a school-wide fallback', async () => {
  const { page, requests, errors } = await open();
  try {
    const count = () => requests.filter(row => row.path.endsWith('/admin/usage')).length;
    const baseline = count(); await page.getByLabel('Scope', { exact: true }).selectOption('class');
    await page.getByLabel('Official class', { exact: true }).selectOption('school-a-class');
    await page.getByText('class: school-a-class', { exact: true }).waitFor();
    assert.equal(count(), baseline + 1); assert.deepEqual(requests.at(-1).params, { scope: 'class', from: '2026-09-24', to: '2026-09-30', format: 'json', id: 'school-a-class' });
    await page.getByText('Supervision observations count', { exact: false }).waitFor();
    await page.getByLabel('Scope', { exact: true }).selectOption('grade'); await page.getByLabel('Grade', { exact: true }).selectOption('9');
    await page.getByText('grade: 9', { exact: true }).waitFor(); assert.equal(requests.at(-1).params.id, '9');
    await page.getByLabel('Scope', { exact: true }).selectOption('student'); await page.getByLabel('Find a student').fill('Avery');
    await page.getByLabel('Student', { exact: true }).selectOption('school-a-student'); await page.getByText('student: school-a-student', { exact: true }).waitFor();
    assert.equal(requests.at(-1).params.scope, 'student'); assert.equal(requests.at(-1).schoolId, 'school-a');
    assert.equal(requests.some(request => request.path.includes('teacher-students')), false, 'The usage page never requests the decrypted-PIN directory');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('unavailable and feature-off responses expose no numeric totals/export; computed empty days honestly show zero', async () => {
  for (const mode of ['unavailable', 'empty', 'off']) {
    const { page, errors } = await open({ mode, handler: mode === 'off' ? async (route, url) => {
      if (!url.pathname.endsWith('/admin/usage')) return false;
      await route.fulfill({ status: 404, json: { error: 'Not found' } }); return true;
    } : undefined });
    try {
      if (mode === 'empty') { await page.getByText('No browser activity observed in the computed days.').waitFor(); assert.equal(await page.getByTestId('usage-total').textContent(), '0s'); }
      else { await page.getByText(mode === 'off' ? 'Monitored Browser Time is not available for this school yet.' : 'No report available for this range', { exact: false }).waitFor(); assert.equal(await page.getByTestId('usage-total').count(), 0); assert.equal(await page.getByRole('button', { name: 'Export CSV', exact: true }).isDisabled(), true); }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('school-local presets and invalid custom ranges do not issue malformed requests', async () => {
  const { page, requests, errors } = await open({ zone: 'America/Los_Angeles', now: '2026-03-09T03:00Z' });
  try {
    assert.equal(requests[0].params.to, '2026-03-08'); assert.equal(requests[0].params.from, '2026-03-02');
    await page.getByLabel('Date range').selectOption('today'); await page.getByTestId('usage-report').waitFor();
    await page.getByLabel('Date range').selectOption('custom'); await page.getByLabel('Start date').fill('2026-03-10');
    await page.getByText('Choose an ordered range of at most 366 days.').waitFor();
    const count = requests.length; await page.getByLabel('End date').fill('2025-03-01');
    assert.equal(requests.length, count); assert.equal(await page.getByTestId('usage-report').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('read and audited export failures stay visible, retry recovers, and old coverage contracts fail closed', async () => {
  let failing = true;
  const { page, errors } = await open({ handler: async (route, url, schoolId) => {
    if (!url.pathname.endsWith('/admin/usage')) return false;
    if (failing || url.searchParams.get('format') === 'csv') {
      await route.fulfill({ status: 503, json: { error: 'Synthetic report unavailable' } }); return true;
    }
    const report = reportFor(url, schoolId, 'empty'); report.dataState = 'final'; report.byDay.forEach(day => { day.state = 'final'; });
    await route.fulfill({ json: report }); return true;
  } });
  try {
    await page.getByText('Synthetic report unavailable', { exact: false }).waitFor(); assert.equal(await page.getByTestId('usage-total').count(), 0);
    failing = false; await page.getByRole('button', { name: 'Try again', exact: true }).click(); await page.getByTestId('usage-total').waitFor();
    assert.equal(await page.getByTestId('usage-report-state').textContent(), 'Final');
    await page.getByText('Computed days: Final', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click(); await page.getByText('CSV was not exported.', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
  const old = await open({ handler: async (route, url) => {
    if (!url.pathname.endsWith('/admin/usage')) return false;
    await route.fulfill({ json: { totals: { monitoredBrowserSeconds: 0 }, byDay: [] } }); return true;
  } });
  try { await old.page.getByText('Report coverage is unavailable.', { exact: false }).waitFor(); assert.equal(await old.page.getByTestId('usage-total').count(), 0); assert.deepEqual(old.errors, []); }
  finally { await old.page.close(); }
});

test('missing or expired requested days keep the overall report Partial while computed rows remain Final', async () => {
  for (const expired of [false, true]) {
    const { page, errors } = await open({ handler: async (route, url, schoolId) => {
      if (!url.pathname.endsWith('/admin/usage')) return false;
      const report = reportFor(url, schoolId, expired ? 'empty' : 'partial');
      report.dataState = 'final'; report.byDay.forEach(day => { day.state = 'final'; }); report.range.partiallyExpired = expired;
      await route.fulfill({ json: report }); return true;
    } });
    try { await page.getByTestId('usage-report-state').waitFor(); assert.equal(await page.getByTestId('usage-report-state').textContent(), 'Partial'); await page.getByText('Computed days: Final', { exact: true }).waitFor(); assert.deepEqual(errors, []); }
    finally { await page.close(); }
  }
});

test('teacher and office roles make no usage/directory requests; losing authority removes an already displayed report', async () => {
  for (const role of ['teacher', 'office_staff']) {
    const { page, requests } = await open({ role });
    try { await page.getByText('Administrator access is required for Monitored Browser Time.').waitFor(); assert.deepEqual(requests, []); }
    finally { await page.close(); }
  }
  const { page, requests } = await open();
  try { await page.getByTestId('usage-total').waitFor(); const count = requests.length; await page.evaluate(() => window.fixtureRole('teacher')); await page.getByText('Administrator access is required for Monitored Browser Time.').waitFor(); assert.equal(await page.getByTestId('usage-total').count(), 0); assert.equal(requests.length, count); }
  finally { await page.close(); }
});

test('school change resets selection, binds headers and prevents delayed old-school data from appearing', async () => {
  let release;
  const { page, requests, errors } = await open({ handler: async (route, url, schoolId) => {
    if (!url.pathname.endsWith('/admin/usage') || url.searchParams.get('scope') !== 'student' || schoolId !== 'school-a') return false;
    await new Promise(resolve => { release = resolve; }); await route.fulfill({ json: reportFor(url, schoolId) }).catch(() => {}); return true;
  } });
  try {
    await page.getByLabel('Scope', { exact: true }).selectOption('student'); await page.getByLabel('Student', { exact: true }).selectOption('school-a-student');
    await page.waitForFunction(() => document.body.textContent.includes('Loading Monitored Browser Time'));
    await page.evaluate(() => window.fixtureSchool('school-b')); await page.getByRole('heading', { name: 'Maple School', exact: true }).waitFor();
    release(); await page.waitForLoadState('networkidle');
    assert.equal(await page.getByLabel('Scope', { exact: true }).inputValue(), 'school'); assert.equal(await page.getByText('student: school-a-student', { exact: true }).count(), 0);
    assert.equal(requests.at(-1).schoolId, 'school-b'); assert.equal(requests.at(-1).params.scope, 'school'); assert.deepEqual(errors, []);
  } finally { release?.(); await page.close(); }
});
