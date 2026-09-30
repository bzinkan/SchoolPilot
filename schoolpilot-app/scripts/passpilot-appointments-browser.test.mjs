import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const pages = new Map();
const authModule = `import{useSyncExternalStore}from'react';export function usePassPilotAuth(){const scope=useSyncExternalStore(fn=>{window.addEventListener('scope-change',fn);return()=>window.removeEventListener('scope-change',fn)},()=>window.__scope);return{...scope,isAdmin:scope.role==='school_admin',isSchoolwideManager:['school_admin','office_staff'].includes(scope.role),isTeacher:scope.role==='teacher',isLoading:false,logout:async()=>{},refetchUser:()=>{}};}`;
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{MemoryRouter}from'react-router-dom';import Appointments from'/src/products/passpilot/pages/Appointments.jsx';import Reminders from'/src/products/passpilot/components/AppointmentReminders.jsx';import Year from'/src/products/passpilot/components/admin/SchoolYearSetup.jsx';import Shell from'/src/products/passpilot/components/AppShell.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import{usePassPilotAuth}from'/src/hooks/usePassPilotAuth.js';import'/src/index.css';const h=React.createElement;const cache=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});window.appointmentCapabilityReady=()=>cache.getQueryCache().findAll({queryKey:['passpilot-appointment-capabilities']}).some(q=>q.state.status==='success');window.appointmentCache=()=>cache.getQueryCache().findAll({queryKey:['passpilot-appointments']}).map(q=>q.state.data);function Harness(){const auth=usePassPilotAuth();const mode=new URLSearchParams(location.search).get('mode');const scope=auth.school.id+':'+auth.user.id;return h(React.Fragment,null,h('button',{onClick:()=>window.changeAppointmentSchool()},'Change school'),mode==='teacher'?h(Reminders,{key:scope,...auth,classId:'class-a',students:[{id:'student-a',name:'Synthetic Student'}]}):mode==='year'?h(Year):mode==='nav'?h(Shell,{currentTab:'myclass'},'Synthetic content'):h(Appointments));}createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:cache},h(MemoryRouter,null,h(ThemeProvider,null,h(Harness)))));`;
before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-passpilot-appointments-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'appointment-browser', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__appointments?')) return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__appointment-entry.jsx"></script></body></html>'));
    }); }, resolveId(id) { if (id === '/__appointment-entry.jsx') return '\0appointment-entry'; }, load(id) {
      const file = id.replace(/\\/g, '/');
      if (file.endsWith('/hooks/usePassPilotAuth.js')) return authModule;
      if (file.endsWith('/contexts/AuthContext.jsx')) return `export const useAuth=()=>({user:window.__scope.user,activeSchoolId:window.__scope.school.id});`;
      if (file.endsWith('/contexts/LicenseContext.jsx')) return `export const useLicenses=()=>({hasClassPilot:false,hasGoPilot:false});`;
      if (id === '\0appointment-entry') return entry;
    } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
async function closePage(page) { pages.get(page)?.releaseSave?.(); await page.unrouteAll({ behavior: 'wait' }); await page.close(); pages.delete(page); }
async function inspectLayout(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Staff appointment controls must fit a phone viewport');
  if (!process.env.PASSPILOT_APPOINTMENT_SCREENSHOTS) return;
  await mkdir(process.env.PASSPILOT_APPOINTMENT_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.PASSPILOT_APPOINTMENT_SCREENSHOTS, `${name}-phone.png`), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(process.env.PASSPILOT_APPOINTMENT_SCREENSHOTS, `${name}-desktop.png`), fullPage: true });
}
after(async () => { try { for (const page of pages.keys()) await closePage(page); } finally { await browser?.close(); await vite?.close(); } });

const appointment = patch => ({ id: 'appointment-a', studentId: 'student-a', studentName: 'Synthetic Student', revision: 2, status: 'scheduled',
  startsAt: new Date(Date.now() - 3600000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), duration: 5,
  schoolTimezone: 'America/New_York', destination: 'office', staffNotes: 'Private synthetic manager note', ...patch });
async function setup(mode = 'manager', options = {}) {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  const state = { role: mode === 'teacher' ? 'teacher' : 'school_admin', rows: [appointment()], ...options }, requests = [], errors = [];
  pages.set(page, state); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(role => {
    localStorage.setItem('sp_activeSchoolId', 'school-a');
    window.__scope = { role, school: { id: 'school-a', name: 'Synthetic School', defaultPassDuration: 5, schoolTimezone: 'America/New_York' }, user: { id: 'staff-a', roles: [role], role, displayName: 'Synthetic Staff' } };
    window.changeAppointmentSchool = () => { window.__scope = { ...window.__scope, school: { ...window.__scope.school, id: 'school-b' } }; localStorage.setItem('sp_activeSchoolId', 'school-b'); window.dispatchEvent(new Event('scope-change')); };
  }, state.role);
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method(), school = req.headers()['x-school-id'];
    const body = method === 'GET' ? undefined : req.postDataJSON(); requests.push({ path: url.pathname, method, body, school, params: Object.fromEntries(url.searchParams) });
    const json = (value, status = 200) => route.fulfill({ json: value, status });
    if (url.pathname.endsWith('/csrf')) return json({ csrfToken: 'synthetic' });
    if (url.pathname.endsWith('/appointments/capabilities')) return state.off ? json({ error: 'Unknown route' }, 404) : json({ enabled: true,
      manager: state.role !== 'teacher', teacherReminders: state.role === 'teacher', schoolTimezone: 'America/New_York', schoolYearConfigured: true });
    if (url.pathname.endsWith('/kiosk/sessions')) return json({ sessions: [] });
    if (url.pathname === '/api/students') return json({ students: [{ id: 'student-a', firstName: 'Synthetic', lastName: 'Student', gradeLevel: '5' }] });
    if (url.pathname.endsWith('/appointments') && method === 'GET') {
      if (state.denyList) return json({ error: 'Current appointment access changed.' }, 403);
      if (school === 'school-b') return json({ appointments: [], nextCursor: null });
      if (state.paged && !url.searchParams.get('cursor')) return json({ appointments: [appointment({ id: 'other-class', studentId: 'student-b', studentName: 'Other Class Student' })], nextCursor: 'second-page' });
      return json({ appointments: state.rows, nextCursor: null });
    }
    if (url.pathname.endsWith('/appointments') && method === 'POST') {
      if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
      const row = appointment({ ...body, id: 'new-appointment', revision: 1 }); state.rows.push(row); return json({ appointment: row }, 201);
    }
    if (url.pathname.endsWith('/activate')) {
      if (state.denyActivation) return json({ error: 'Current appointment access changed.' }, 403);
      state.rows[0].status = 'activated'; return json({ appointment: state.rows[0], pass: { id: 'pass-a', status: 'active' } }, 201);
    }
    if (url.pathname.endsWith('/cancel')) { state.rows[0].status = 'cancelled'; state.rows[0].revision++; return json({ appointment: state.rows[0] }); }
    if (method === 'PATCH') { Object.assign(state.rows[0], body, { revision: state.rows[0].revision + 1 }); return json({ appointment: state.rows[0] }); }
    if (url.pathname.endsWith('/school-year/preview')) return json({ yearStart: body.yearStart, yearEnd: body.yearEnd, revision: 4, previewToken: 'a'.repeat(64), changedOccurrences: 3, blockers: state.yearBlocked ? [{ message: 'An active scheduled class prevents this change.' }] : [] });
    if (url.pathname.endsWith('/school-year') && method === 'GET') return json({ yearStart: '2026-09-01', yearEnd: '2027-06-30', revision: 4, schoolTimezone: 'America/New_York' });
    if (url.pathname.endsWith('/school-year') && method === 'PUT') return state.staleYear ? json({ error: 'School calendar changed. Preview again.' }, 409) : json({ ...body, revision: 5, schoolTimezone: 'America/New_York' });
    return json({ error: 'Unexpected synthetic request' }, 404);
  });
  await page.goto(`${base}/__appointments?mode=${mode}`); return { page, state, requests, errors };
}

test('manager scheduling preserves an explicit repeated-time offset and sends private notes only to the appointment API', async () => {
  const { page, requests, errors } = await setup();
  try {
    await page.getByRole('button', { name: 'Schedule appointment', exact: true }).click();
    await page.getByLabel('Search students').fill('Synthetic'); await page.getByRole('button', { name: 'Synthetic Student — Grade 5' }).click();
    await page.getByLabel('Window start', { exact: true }).fill('2026-11-01T01:30'); await page.getByLabel('Window end', { exact: true }).fill('2026-11-01T02:30');
    await page.getByLabel('Choose window start offset').selectOption('2026-11-01T06:30:00.000Z');
    await page.getByLabel('Private manager note').fill('Reviewed confidential appointment context');
    await inspectLayout(page, 'manager-appointment');
    await page.getByRole('form', { name: 'Schedule appointment' }).getByRole('button', { name: 'Schedule appointment', exact: true }).click();
    await page.getByText('Appointment saved.', { exact: true }).waitFor();
    const request = requests.find(value => value.path.endsWith('/appointments') && value.method === 'POST');
    assert.equal(request.body.startsAt, '2026-11-01T06:30:00.000Z'); assert.equal(request.body.endsAt, '2026-11-01T07:30:00.000Z');
    assert.equal(request.body.staffNotes, 'Reviewed confidential appointment context'); assert.equal(request.school, 'school-a');
    assert.ok(request.body.requestId); assert.equal('schoolTimezone' in request.body, false); assert.equal(requests.some(value => value.path.includes('/passes')), false);
    assert.deepEqual(errors, []);
  } finally { await closePage(page); }
});

test('nonexistent school wall times block scheduling without an API write', async () => {
  const { page, requests } = await setup();
  try {
    await page.getByRole('button', { name: 'Schedule appointment', exact: true }).click(); await page.getByLabel('Search students').fill('Synthetic');
    await page.getByRole('button', { name: 'Synthetic Student — Grade 5' }).click();
    await page.getByLabel('Window start', { exact: true }).fill('2027-03-14T02:30'); await page.getByLabel('Window end', { exact: true }).fill('2027-03-14T04:00');
    await page.getByRole('form', { name: 'Schedule appointment' }).getByRole('button', { name: 'Schedule appointment', exact: true }).click();
    await page.getByText('This time does not exist in America/New_York. Choose another time.').waitFor();
    assert.equal(requests.some(value => value.path.endsWith('/appointments') && value.method === 'POST'), false);
  } finally { await closePage(page); }
});

test('manager edits and cancellation preserve the displayed revision', async () => {
  const { page, requests } = await setup();
  try {
    await page.getByRole('button', { name: 'Edit appointment' }).click(); await page.getByLabel('Private manager note').fill('Changed private context');
    await page.getByRole('button', { name: 'Save appointment changes' }).click(); await page.getByText('Appointment saved.', { exact: true }).waitFor();
    assert.equal(requests.find(value => value.method === 'PATCH').body.expectedRevision, 2);
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Cancel appointment', exact: true }).click();
    await page.getByText('Appointment cancelled.', { exact: true }).waitFor();
    assert.equal(requests.find(value => value.path.endsWith('/cancel')).body.expectedRevision, 3);
  } finally { await closePage(page); }
});

test('teacher reminders drain pages, include overnight windows, omit manager notes and activate only the current class', async () => {
  const { page, requests, errors } = await setup('teacher', { paged: true, rows: [appointment({ startsAt: new Date(Date.now() - 23 * 3600000).toISOString(), endsAt: new Date(Date.now() + 1800000).toISOString() })] });
  try {
    await page.getByRole('button', { name: 'Open appointment pass' }).waitFor();
    assert.equal(await page.getByText('Private synthetic manager note', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Other Class Student', { exact: false }).count(), 0);
    const list = requests.find(value => value.path.endsWith('/appointments') && value.method === 'GET');
    assert.ok(Date.now() - Date.parse(list.params.from) >= 23.9 * 3600000); assert.equal(list.params.status, 'scheduled');
    assert.ok(requests.some(value => value.params.cursor === 'second-page'));
    await inspectLayout(page, 'teacher-reminder');
    await page.getByRole('button', { name: 'Open appointment pass' }).click(); await page.getByText('Appointment pass opened.', { exact: true }).waitFor();
    const activations = requests.filter(value => value.path.endsWith('/activate')); assert.equal(activations.length, 1);
    assert.deepEqual(activations[0].body, { expectedRevision: 2, classId: 'class-a' }); assert.deepEqual(errors, []);
  } finally { await closePage(page); }
});

test('known teacher authority failure removes reminders and activation controls', async () => {
  const { page, state } = await setup('teacher', { denyActivation: true });
  try {
    await page.getByRole('button', { name: 'Open appointment pass' }).click();
    await page.getByText('Current appointment access changed. Refresh this page before continuing.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Open appointment pass' }).count(), 0);
    assert.equal(await page.getByText('Synthetic Student — Office', { exact: true }).count(), 0); state.denyActivation = false;
  } finally { await closePage(page); }
});

test('school switches clear pending manager notes and pin an in-flight write to its original school', async () => {
  const { page, state, requests } = await setup('manager', { holdSave: true });
  try {
    await page.getByRole('button', { name: 'Schedule appointment', exact: true }).click(); await page.getByLabel('Search students').fill('Synthetic');
    await page.getByRole('button', { name: 'Synthetic Student — Grade 5' }).click(); await page.getByLabel('Private manager note').fill('Old school private note');
    await page.getByRole('form', { name: 'Schedule appointment' }).getByRole('button', { name: 'Schedule appointment', exact: true }).click();
    const deadline = Date.now() + 5000; while (!state.releaseSave && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof state.releaseSave, 'function'); await page.getByRole('button', { name: 'Change school' }).click();
    await page.getByRole('button', { name: 'Schedule appointment', exact: true }).waitFor(); state.releaseSave();
    assert.equal(await page.getByLabel('Private manager note').count(), 0); assert.equal(await page.getByText('Old school private note').count(), 0);
    const save = requests.find(value => value.method === 'POST' && value.path.endsWith('/appointments')); assert.equal(save.school, 'school-a');
    await page.waitForFunction(() => !JSON.stringify(window.appointmentCache()).includes('Private synthetic manager note'));
  } finally { await closePage(page); }
});

test('a known manager list authority failure clears private editor content and caches', async () => {
  const { page, state } = await setup();
  try {
    await page.getByRole('button', { name: 'Edit appointment' }).click();
    assert.equal(await page.getByLabel('Private manager note').inputValue(), 'Private synthetic manager note');
    state.denyList = true; await page.getByRole('button', { name: 'Refresh appointments' }).click();
    await page.getByText('Current appointment access changed.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Private manager note').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit appointment' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Schedule appointment', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => JSON.stringify(window.appointmentCache()).includes('Private synthetic manager note')), false);
  } finally { await closePage(page); }
});

test('school-year setup previews exact changes, blocks conflicts and invalidates stale preview tokens', async () => {
  const { page, state, requests } = await setup('year', { yearBlocked: true });
  try {
    await page.getByLabel('School-year end').fill('2027-07-01'); await page.getByRole('button', { name: 'Preview date changes' }).click();
    await page.getByText('An active scheduled class prevents this change.').waitFor(); assert.equal(await page.getByRole('button', { name: 'Save reviewed school-year dates' }).isDisabled(), true);
    state.yearBlocked = false; await page.getByRole('button', { name: 'Preview date changes' }).click(); await page.getByText('The preview found no scheduling blockers.').waitFor();
    state.staleYear = true; await page.getByRole('button', { name: 'Save reviewed school-year dates' }).click(); await page.getByText('School calendar changed. Preview again.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save reviewed school-year dates' }).count(), 0);
    const save = requests.find(value => value.method === 'PUT'); assert.equal(save.body.expectedRevision, 4); assert.equal(save.body.previewToken, 'a'.repeat(64)); assert.equal('schoolTimezone' in save.body, false);
    state.staleYear = false; await page.getByRole('button', { name: 'Preview date changes' }).click(); await page.getByRole('button', { name: 'Save reviewed school-year dates' }).click(); await page.getByText('School-year dates saved.').waitFor();
  } finally { await closePage(page); }
});

test('mode off and staff roles gate navigation and reminder surfaces', async () => {
  for (const options of [{ off: true, role: 'school_admin' }, { role: 'teacher' }, { role: 'office_staff' }]) {
    const { page } = await setup('nav', options);
    try {
      await page.getByText('Synthetic content').waitFor();
      if (options.role === 'office_staff') await page.getByRole('link', { name: 'Appointments', exact: true }).first().waitFor();
      else { await page.waitForFunction(() => window.appointmentCapabilityReady()); assert.equal(await page.getByRole('link', { name: 'Appointments', exact: true }).count(), 0); }
    } finally { await closePage(page); }
  }
  const { page, requests } = await setup('teacher', { role: 'office_staff' });
  try { await page.waitForFunction(() => window.appointmentCapabilityReady()); assert.equal(await page.getByRole('region', { name: 'Class appointment reminders' }).count(), 0); assert.equal(requests.some(value => value.path.endsWith('/appointments')), false); }
  finally { await closePage(page); }
});
