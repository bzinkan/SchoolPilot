import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date('2026-11-12T15:00:00.000Z');
const closed = {
  schoolLocalDate: '2026-11-12', schoolTimezone: 'America/New_York',
  evaluatedAt: now.toISOString(), validUntil: '2026-11-13T05:00:00.000Z',
  calendarClosed: true, classpilotInstructionalOverride: null,
};
const authModule = `import {useSyncExternalStore} from 'react';
const role=new URLSearchParams(location.search).get('surface')==='office'?'office_staff':'teacher';
let state={user:{id:'teacher-a',authVersion:1,firstName:'Synthetic',lastName:'Teacher'},token:null,loading:false,
activeSchoolId:'school-a',memberships:[],activeMembership:{id:'membership-a',schoolId:'school-a',schoolName:'Synthetic School',schoolTimezone:'America/New_York',role,roles:[role],gopilotRole:role}};
const listeners=new Set();
window.changeClosureIdentity=(next)=>{state={...state,...next};for(const listener of listeners)listener();};
export function useAuth(){return {...useSyncExternalStore(listener=>{listeners.add(listener);return ()=>listeners.delete(listener)},()=>state),logout:async()=>{},refetchUser:async()=>{}};}`;
const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {queryClient} from '/src/lib/queryClient.js';
import {ThemeProvider} from '/src/contexts/ThemeContext.jsx';
import '/src/index.css';
const params=new URLSearchParams(location.search), surface=params.get('surface')||'passpilot';
const paths={classpilot:'/src/products/classpilot/pages/Dashboard.jsx',passpilot:'/src/products/passpilot/pages/Dashboard.jsx',teacher:'/src/products/gopilot/pages/TeacherView.jsx','teacher-no-homeroom':'/src/products/gopilot/pages/TeacherView.jsx',office:'/src/products/gopilot/pages/DismissalDashboard.jsx',notice:'/src/shared/components/SchoolDayClosureNotice.jsx'};
const Component=(await import(/* @vite-ignore */ paths[['calendar','scheduling'].includes(surface)?'notice':surface])).default;
const Calendar=surface==='calendar'?(await import('/src/products/classpilot/components/SchoolCalendarMonth.jsx')).default:null;
const Scheduling=surface==='scheduling'?(await import('/src/products/classpilot/pages/AdminScheduling.jsx')).default:null;
queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});
window.closureQueryClient=queryClient;
const h=React.createElement;
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(ThemeProvider,null,h(MemoryRouter,{initialEntries:[Scheduling?'/classpilot/admin/classes/scheduling?section=calendar&month=2026-11':'/passpilot/my-class']},h(Component,{product:params.get('product')||'classpilot'}),Calendar?h(Calendar,{month:'2026-11',onMonthChange:()=>{}}):null,Scheduling?h(Scheduling):null))));`;
let vite, browser, base;
const pages = new Set();

before(async () => {
  vite = await createServer({
    root, logLevel: 'error', cacheDir: `node_modules/.vite-school-day-${process.pid}`,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'school-day-closure-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/__school-day?')) return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__school-day-entry.jsx"></script></body></html>'));
        });
      },
      resolveId(id) { if (id === '/__school-day-entry.jsx') return '\0school-day-entry'; },
      load(id) {
        const file = id.replace(/\\/g, '/');
        if (file.endsWith('/contexts/AuthContext.jsx')) return authModule;
        if (file.endsWith('/contexts/LicenseContext.jsx')) return 'export const useLicenses=()=>({hasClassPilot:false,hasPassPilot:false,hasGoPilot:false});';
        if (file.endsWith('/contexts/NativeContext.jsx')) return 'export const useNative=()=>({isNative:false});';
        if (file.endsWith('/contexts/SocketContext.jsx')) return 'export const useSocket=()=>null;';
        if (id === '\0school-day-entry') return entry;
      },
    }],
  });
  await vite.listen();
  base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  for (const page of pages) await page.close();
  await browser?.close();
  await vite?.close();
});

async function setup(surface = 'notice', product = 'classpilot', response = closed) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles' });
  pages.add(page);
  const state = { response, status: 200, hold: false, reads: [], errors: [], calendar: {
    month: '2026-11', schoolTimezone: 'America/New_York', schoolLocalToday: '2026-11-12',
    nonInstructionalDates: ['2026-11-12'], revision: 1, updatedAt: null,
  }, scheduling: { revision: 1, schoolTimezone: 'America/New_York', schoolLocalToday: '2026-11-12', config: {
    schemaVersion: 1, yearStart: '2026-09-01', yearEnd: '2027-06-30', cycleAnchorDate: null, cycleAnchorDay: 'A',
    periods: [], profiles: [], defaultProfileId: null, weekdayProfiles: {}, dateOverrides: {}, scheduleProfiles: [], profileApplications: [],
  } } };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.clock.install({ time: now });
  await page.routeWebSocket('**/ws*', socket => socket.close());
  await page.addInitScript(() => localStorage.setItem('sp_activeSchoolId', 'school-a'));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = value => route.fulfill({ json: value });
    if (url.pathname.endsWith('/school-day-status')) {
      state.reads.push({ url: url.pathname, school: route.request().headers()['x-school-id'] });
      if (state.hold) return;
      return route.fulfill({ json: state.response, status: state.status });
    }
    if (url.pathname.startsWith('/api/classpilot/admin/instructional-calendar')) {
      if (url.pathname.endsWith('/preview')) return json({ previewToken: 'synthetic-preview', changedOccurrences: 0, changes: [], blockers: [] });
      if (route.request().method() === 'PUT') {
        const { nonInstructionalDates } = route.request().postDataJSON();
        state.calendar = { ...state.calendar, nonInstructionalDates, revision: 2, updatedAt: now.toISOString() };
        state.response = { ...closed, calendarClosed: nonInstructionalDates.includes('2026-11-12') };
      }
      return json(state.calendar);
    }
    if (url.pathname === '/api/classpilot/admin/scheduling/preview') return json({
      revision: 1, previewToken: 'synthetic-schedule-preview', schoolTimezone: 'America/New_York',
      fromDate: '2026-11-12', changedOccurrences: 0, blockers: [], changes: [], days: [],
    });
    if (url.pathname === '/api/classpilot/admin/scheduling') {
      if (route.request().method() === 'PUT') {
        state.scheduling = { ...state.scheduling, revision: 2, config: route.request().postDataJSON().config };
        state.response = { ...closed, classpilotInstructionalOverride: state.scheduling.config.dateOverrides['2026-11-12']?.instructional ?? null };
      }
      return json(state.scheduling);
    }
    if (url.pathname === '/api/passpilot/classes') return json({ source: 'classpilot_groups', classes: [] });
    if (url.pathname === '/api/gopilot/homerooms/mine') return json({ homerooms: surface === 'teacher-no-homeroom' ? [] : [{ id: 'room-a', name: 'Synthetic Class' }] });
    if (url.pathname === '/api/gopilot/students') return json({ students: [] });
    if (url.pathname.endsWith('/sessions/today')) return json({ session: null });
    if (url.pathname.endsWith('/homerooms')) return json({ homerooms: [] });
    if (url.pathname.endsWith('/custody-alerts')) return json({ alerts: [] });
    if (url.pathname.endsWith('/bus-routes')) return json({ routes: [] });
    if (url.pathname === '/api/gopilot/settings') return json({ dismissalTime: '15:00', pickupZones: [], revision: 1 });
    if (url.pathname.endsWith('/pickups/all')) return json({ pickups: [] });
    if (url.pathname.endsWith('/attendance')) return json({ records: [] });
    if (url.pathname.endsWith('/kiosk/sessions/mine')) return json({ sessions: [] });
    if (url.pathname.endsWith('/dashboard-activity')) return json({ activity: null, capabilities: {} });
    if (url.pathname.endsWith('/groups')) return json({ groups: [] });
    if (url.pathname.endsWith('/sessions/active')) return json({ session: null });
    return route.fulfill({ status: 404, json: { error: 'Unavailable synthetic data' } });
  });
  await page.goto(`${base}/__school-day?surface=${surface}&product=${product}`);
  return { page, state, notice: page.getByTestId('school-day-closure-notice') };
}

async function finish(page, state) {
  assert.deepEqual(state.errors, []);
  await page.close();
  pages.delete(page);
}
async function refresh(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function waitForReads(state, count) {
  const deadline = Date.now() + 5000;
  while (state.reads.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(state.reads.length >= count, `expected ${count} school-day reads, got ${state.reads.length}`);
}

for (const [surface, product] of [['passpilot', 'passpilot'], ['classpilot', 'classpilot'], ['teacher', 'gopilot'], ['office', 'gopilot']]) {
  test(`${surface} dashboard shows the explicit shared school closure`, async () => {
    const { page, state, notice } = await setup(surface, product);
    await notice.waitFor({ timeout: 15000 });
    assert.equal(await notice.textContent(), 'School is closed today.');
    assert.equal(await notice.getAttribute('role'), 'status');
    assert.deepEqual(state.reads[0], { url: `/api/${product}/school-day-status`, school: 'school-a' });
    assert.equal(await page.locator('button:enabled').count() > 0, true, 'closure does not disable dashboard controls');
    if (process.env.SCHOOL_DAY_SCREENSHOTS) {
      await mkdir(process.env.SCHOOL_DAY_SCREENSHOTS, { recursive: true });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: path.join(process.env.SCHOOL_DAY_SCREENSHOTS, `${surface}-${width}.png`), fullPage: true });
      }
    }
    await finish(page, state);
  });
}

test('ClassPilot distinguishes instructional overrides from school closure', async () => {
  const { page, state, notice } = await setup();
  await notice.waitFor();
  state.response = { ...closed, classpilotInstructionalOverride: true };
  await refresh(page);
  await page.getByText('School calendar marks today as closed. ClassPilot has an instructional-day override.').waitFor();
  state.response = { ...closed, calendarClosed: false, classpilotInstructionalOverride: false };
  await refresh(page);
  await page.getByText('ClassPilot classes are not scheduled today.').waitFor();
  state.response = { ...closed, calendarClosed: false, classpilotInstructionalOverride: null };
  await refresh(page);
  await notice.waitFor({ state: 'detached' });
  await finish(page, state);
});

test('GoPilot teacher without a homeroom still sees the school calendar closure', async () => {
  const { page, state, notice } = await setup('teacher-no-homeroom', 'gopilot');
  await page.getByRole('heading', { name: 'No GoPilot Homeroom Assigned', exact: true }).waitFor();
  await notice.waitFor({ timeout: 2000 });
  assert.equal(await notice.textContent(), 'School is closed today.');
  await finish(page, state);
});

test('other products ignore ClassPilot-only closure and failed refresh removes a previous notice', async () => {
  const { page, state, notice } = await setup('notice', 'passpilot');
  await notice.waitFor();
  state.status = 503;
  await refresh(page);
  await notice.waitFor({ state: 'detached' });
  state.status = 200;
  state.response = { ...closed, calendarClosed: false, classpilotInstructionalOverride: false };
  await refresh(page);
  await waitForReads(state, 3);
  assert.equal(await notice.count(), 0);
  state.response = closed;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await notice.waitFor();
  await finish(page, state);
});

test('school and user changes hide old closures while their own requests are pending', async () => {
  const { page, state, notice } = await setup();
  await notice.waitFor();
  state.hold = true;
  await page.evaluate(() => window.changeClosureIdentity({ activeSchoolId: 'school-b', activeMembership: { schoolId: 'school-b', role: 'teacher' } }));
  await waitForReads(state, 2);
  assert.equal(await notice.count(), 0);
  assert.equal(state.reads[1].school, 'school-b');
  await page.evaluate(() => window.changeClosureIdentity({ user: { id: 'teacher-b', authVersion: 1 } }));
  await waitForReads(state, 3);
  assert.equal(await notice.count(), 0);
  await page.evaluate(() => window.changeClosureIdentity({ user: null }));
  await page.clock.runFor(300_000);
  assert.equal(state.reads.length, 3, 'signed-out views make no status requests');
  await finish(page, state);
});

test('the school midnight expires closure without waiting for polling or a new response', async () => {
  const { page, state, notice } = await setup('notice', 'gopilot', { ...closed, schoolTimezone: 'Pacific/Honolulu', schoolLocalDate: '2026-11-12', validUntil: '2026-11-13T10:00:00.000Z' });
  await notice.waitFor();
  state.hold = true;
  await page.clock.fastForward(19 * 60 * 60 * 1000);
  await notice.waitFor({ state: 'detached' });
  await finish(page, state);
});

test('stale school date and malformed responses cannot claim a closure; polling is bounded', async () => {
  const { page, state, notice } = await setup();
  await notice.waitFor();
  await page.clock.runFor(59_000);
  assert.equal(state.reads.length, 1, 'no aggressive status polling');
  state.response = { ...closed, schoolLocalDate: '2026-11-11' };
  await page.clock.runFor(241_001);
  await waitForReads(state, 2);
  await notice.waitFor({ state: 'detached' });
  state.response = { ...closed, calendarClosed: 'true' };
  await refresh(page);
  await waitForReads(state, 3);
  assert.equal(await notice.count(), 0);
  await finish(page, state);
});

test('verified calendar saves refresh today status across product dashboards immediately', async () => {
  const { page, state, notice } = await setup('calendar', 'passpilot');
  await notice.waitFor();
  await page.getByTestId('calendar-day-2026-11-12').click();
  await page.getByRole('button', { name: 'Preview month changes', exact: true }).click();
  await page.getByRole('button', { name: 'Save reviewed month', exact: true }).click();
  await page.getByTestId('calendar-dirty-bar').waitFor({ state: 'detached' });
  await notice.waitFor({ state: 'detached', timeout: 2000 });
  assert.equal(state.reads.length, 2, 'calendar verification refreshes the current product status');
  await finish(page, state);
});

test('saved ClassPilot overrides refresh the notice without publishing unsaved drafts', async () => {
  const { page, state, notice } = await setup('scheduling');
  await notice.waitFor();
  await page.getByLabel('Override date', { exact: true }).fill('2026-11-12');
  await page.getByRole('button', { name: 'Add date', exact: true }).click();
  await page.getByLabel('2026-11-12 instructional status', { exact: true }).selectOption('true');
  assert.equal(await notice.textContent(), 'School is closed today.', 'draft override cannot change the dashboard notice');
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
  await page.getByText('School schedule saved.', { exact: true }).waitFor();
  await page.getByText('School calendar marks today as closed. ClassPilot has an instructional-day override.').waitFor({ timeout: 2000 });
  await finish(page, state);
});
