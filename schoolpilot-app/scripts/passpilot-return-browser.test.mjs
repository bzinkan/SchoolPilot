import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const match = { passId: 'foreign-pass', studentId: 'outside-student', firstName: 'River', lastName: 'Student', studentIdNumber: '9876' };
const activePass = { id: match.passId, studentId: match.studentId, status: 'active', destination: 'office', issuedAt: '2026-10-21T13:00:00Z' };
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import Badge from'/src/products/passpilot/pages/Kiosk.jsx';import Simple from'/src/products/passpilot/pages/KioskSimple.jsx';import MyClass from'/src/products/passpilot/components/tabs/MyClassTab.jsx';import Passes from'/src/products/passpilot/components/tabs/PassesTab.jsx';import'/src/index.css';queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});const h=React.createElement,mode=new URLSearchParams(location.search).get('mode');createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(MemoryRouter,null,h({badge:Badge,simple:Simple,myclass:MyClass,passes:Passes}[mode]))));`;
const auth = `import{useSyncExternalStore}from'react';export function useAuth(){const scope=useSyncExternalStore(fn=>{window.addEventListener('auth-change',fn);return()=>window.removeEventListener('auth-change',fn)},()=>window.__auth);return{...scope,loading:false,logout:async()=>{},refetchUser:async()=>{}};}`;
let vite, browser, base;
const pages = new Set();
before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-passpilot-return-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'return-browser-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__returns?')) return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__return-entry.jsx"></script></body></html>'));
    }); }, resolveId(id) { if (id === '/__return-entry.jsx') return '\0return-entry'; }, load(id) {
      const file = id.replace(/\\/g, '/');
      if (file.endsWith('/contexts/AuthContext.jsx')) return auth;
      if (file.endsWith('/shared/hooks/useStudentImportHome.js')) return 'export const useStudentImportHome=()=>({canLinkToClassPilot:false});';
      if (id === '\0return-entry') return entry;
    },
  }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
async function close(page) { await page.unrouteAll({ behavior: 'wait' }); await page.close(); pages.delete(page); }
after(async () => { try { for (const page of pages) await close(page); } finally { await browser?.close(); await vite?.close(); } });

async function setup(mode, options = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); pages.add(page);
  const state = { classId: null, activity: null, revision: 1, showRosterPass: false, ...options }, requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ withoutPin }) => {
    if (!withoutPin) localStorage.setItem('pp_kiosk_pin', '4321');
    localStorage.setItem('sp_activeSchoolId', 'school-a');
    window.__auth = { user: { id: 'teacher-a', authVersion: 1 }, activeSchoolId: 'school-a', activeMembership: { schoolId: 'school-a', role: 'teacher', roles: ['teacher'], schoolTimezone: 'America/New_York' } };
    window.changeAuth = () => { window.__auth = { ...window.__auth, user: { ...window.__auth.user, authVersion: 2 } }; window.dispatchEvent(new Event('auth-change')); };
  }, { withoutPin: Boolean(state.withoutPin) });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const body = request.method() === 'GET' ? undefined : request.postDataJSON();
    requests.push({ pathname, body, method: request.method(), school: request.headers()['x-school-id'] });
    const json = (data, status = 200) => route.fulfill({ json: data, status });
    if (pathname.endsWith('/kiosk/auth')) return json({ token: 'fixture-token', expiresInSeconds: 900 });
    if (pathname.endsWith('/kiosk/session')) return json({ kioskStyle: mode, session: { id: 'session-a', status: state.unclaimed ? 'unclaimed' : 'active', claimCode: '123456', classId: state.classId, source: 'classpilot_groups', kioskName: 'Synthetic kiosk' } });
    if (pathname.endsWith('/kiosk/snapshot')) {
      if (state.snapshotFailure) return json({ error: 'Schedule temporarily unavailable' }, 503);
      if (state.inactiveClass) return json({ error: 'Class is no longer active', code: 'PASSPILOT_KIOSK_CLASS_INACTIVE' }, 409);
      return json({ kioskStyle: mode, source: 'classpilot_groups', classId: state.classId, className: state.classId ? 'New class' : null,
        session: { id: 'session-a', status: 'active' }, activity: state.activity,
        assignmentRevision: `revision-${state.revision}`, revision: state.revision,
        students: state.rosterRows || (state.showRosterPass ? [{ id: match.studentId, firstName: match.firstName, lastName: match.lastName, studentIdNumber: match.studentIdNumber, activePass, canReturn: true }] : []) });
    }
    if (pathname.endsWith('/returns/lookup')) {
      if (state.rejectLookup) return json({ error: 'Kiosk PIN changed' }, 401);
      if (state.expiredLookup) { state.unclaimed = true; return json({ error: 'Kiosk session expired', code: 'PASSPILOT_KIOSK_SESSION_EXPIRED' }, 404); }
      return json({ matches: state.empty ? [] : [match], hasMore: false });
    }
    if (pathname.endsWith('/kiosk/lookup')) return json({ student: { ...match, id: match.studentId, returnOnly: true, canReturn: true },
      activePass: { id: activePass.id, studentId: activePass.studentId, status: activePass.status, issuedAt: activePass.issuedAt } });
    if (pathname.endsWith('/kiosk/checkin')) {
      if (state.rosterRows) state.rosterRows = state.rosterRows.filter(student => student.id !== body.studentId);
      state.revision++;
      return json({ pass: { ...activePass, id: body.passId || activePass.id, studentId: body.studentId, status: 'returned' } });
    }
    if (pathname.endsWith('/foreign-pass/return')) return json({ ...activePass, status: 'returned' });
    if (pathname.endsWith('/kiosk/client-health')) return json({ ok: true });
    if (pathname.endsWith('/passpilot/classes')) return json({ source: 'classpilot_groups', classes: [] });
    if (pathname.endsWith('/passes/active')) return json({ passes: [] });
    if (pathname.endsWith('/admin/attendance')) return json({ records: [] });
    if (pathname.endsWith('/kiosk/sessions/mine')) return json({ sessions: [] });
    return json({ error: 'Unexpected fixture request' }, 404);
  });
  await page.goto(`${base}/__returns?mode=${mode}&school=school-a`);
  return { page, state, requests, errors };
}

async function selectReturn(page, search = 'River') {
  const region = page.getByRole('region', { name: 'Return a pass', exact: true });
  await region.getByRole('button', { name: 'Return a pass', exact: true }).click();
  await region.getByLabel('Name or student ID').fill(search);
  await region.getByLabel('Name or student ID').press('Enter');
  await region.getByRole('button', { name: 'River Student · ID 9876', exact: true }).click();
  await region.getByText('Mark River Student returned?', { exact: true }).waitFor();
  return region;
}

for (const mode of ['simple', 'badge']) {
  test(`${mode} returns an out-of-roster pass without a class and keeps the review through a bell change`, async () => {
    const { page, state, requests, errors } = await setup(mode);
    try {
      await page.getByText(/Waiting for a class/).waitFor();
      assert.equal(requests.some(request => request.pathname.endsWith('/returns/lookup')), false);
      assert.equal(await page.getByText('River Student', { exact: true }).count(), 0, 'no school-wide list is loaded');
      const region = await selectReturn(page);
      state.classId = 'class-b'; state.revision++;
      state.activity = { mode: 'classpilot', status: 'idle', timezone: 'America/New_York', current: null, nextBoundaryAt: null };
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.getByText(/No class scheduled/).waitFor();
      await region.getByText('Mark River Student returned?', { exact: true }).waitFor();
      state.snapshotFailure = true;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.getByTestId('kiosk-offline-banner').waitFor();
      if (process.env.PASSPILOT_RETURN_SCREENSHOTS && mode === 'simple') {
        await mkdir(process.env.PASSPILOT_RETURN_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PASSPILOT_RETURN_SCREENSHOTS, 'return-confirm-phone.png'), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: path.join(process.env.PASSPILOT_RETURN_SCREENSHOTS, 'return-confirm-desktop.png'), fullPage: true });
      }
      await region.getByRole('button', { name: 'Mark Returned', exact: true }).click();
      await region.getByRole('status').filter({ hasText: 'River Student has been marked returned.' }).waitFor();
      const lookup = requests.find(request => request.pathname.endsWith('/returns/lookup'));
      assert.deepEqual(lookup.body, { search: 'River' });
      const returned = requests.find(request => request.pathname.endsWith('/kiosk/checkin'));
      assert.deepEqual(returned.body, { studentId: match.studentId, passId: match.passId });
      assert.equal(returned.school, 'school-a');
      assert.equal(requests.some(request => request.pathname.endsWith('/kiosk/checkout')), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
    } finally { await close(page); }
  });

  test(`${mode} return lookup works when its scheduled class is unavailable and clears on PIN rejection`, async () => {
    const { page, state, errors } = await setup(mode, { classId: 'old-class', inactiveClass: true });
    try {
      const region = await selectReturn(page, '9876');
      await region.getByRole('button', { name: 'Choose another student' }).click();
      state.rejectLookup = true;
      await region.getByLabel('Name or student ID').press('Enter');
      await page.getByPlaceholder('PIN').waitFor();
      assert.equal(await page.getByRole('region', { name: 'Return a pass', exact: true }).count(), 0);
      assert.equal(await page.getByText('River Student · ID 9876', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await close(page); }
  });

  test(`${mode} does not offer return lookup before a kiosk is claimed`, async () => {
    const { page, requests } = await setup(mode, { unclaimed: true });
    try {
      await page.getByTestId('kiosk-claim-code').waitFor();
      assert.equal(await page.getByRole('region', { name: 'Return a pass', exact: true }).count(), 0);
      assert.equal(requests.some(request => request.pathname.endsWith('/returns/lookup')), false);
    } finally { await close(page); }
  });
}

test('a kiosk requires its PIN before offering return lookup', async () => {
  const { page, requests } = await setup('simple', { withoutPin: true });
  try {
    await page.getByPlaceholder('PIN').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Return a pass', exact: true }).count(), 0);
    assert.equal(requests.some(request => request.pathname.endsWith('/returns/lookup')), false);
  } finally { await close(page); }
});

test('an expired kiosk session clears lookup results and requires a new claim', async () => {
  const { page, state, requests } = await setup('badge');
  try {
    const region = await selectReturn(page);
    await region.getByRole('button', { name: 'Choose another student' }).click();
    state.expiredLookup = true;
    await region.getByLabel('Name or student ID').press('Enter');
    await page.getByTestId('kiosk-claim-code').waitFor();
    assert.equal(await page.getByText('River Student · ID 9876', { exact: true }).count(), 0);
    assert.equal(requests.some(request => request.pathname.endsWith('/kiosk/checkin')), false);
  } finally { await close(page); }
});

for (const mode of ['myclass', 'passes']) test(`${mode} teacher can find and return a pass with no assigned class; auth changes clear reviews`, async () => {
  const { page, requests, errors } = await setup(mode);
  try {
    const region = await selectReturn(page);
    await page.evaluate(() => window.changeAuth());
    await region.getByRole('button', { name: 'Return a pass', exact: true }).waitFor();
    assert.equal(await region.getByText('Mark River Student returned?', { exact: true }).count(), 0);
    await selectReturn(page, '9876');
    await region.getByRole('button', { name: 'Mark Returned', exact: true }).click();
    await region.getByRole('status').filter({ hasText: 'River Student has been marked returned.' }).waitFor();
    const lookup = requests.find(request => request.pathname === '/api/passes/returns/lookup');
    assert.ok(lookup); assert.equal(lookup.school, 'school-a');
    assert.ok(requests.some(request => request.pathname === '/api/passes/foreign-pass/return' && request.method === 'PATCH'));
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});

test('simple class roster returns four custom passes issued by another teacher without lookup restrictions', async () => {
  const rosterRows = ['Adams', 'Baker', 'Clark', 'Davis'].map((lastName, index) => ({
    id: `student-${index}`, firstName: 'Synthetic', lastName, canReturn: true,
    activePass: { ...activePass, id: `custom-pass-${index}`, studentId: `student-${index}`, teacherId: 'another-teacher', destination: 'custom', customDestination: 'Original teacher' },
  }));
  const { page, requests, errors } = await setup('simple', { classId: 'class-a', rosterRows });
  try {
    for (const student of rosterRows) {
      const row = page.getByRole('button', { name: new RegExp(`${student.lastName}, Synthetic`) });
      await row.waitFor(); assert.equal(await row.isEnabled(), true);
      await row.click();
      await row.waitFor({ state: 'detached' });
    }
    const returned = requests.filter(request => request.pathname.endsWith('/kiosk/checkin'));
    assert.equal(returned.length, 4);
    assert.deepEqual(returned.map(request => request.body), rosterRows.map(student => ({ studentId: student.id, passId: student.activePass.id })));
    assert.equal(requests.some(request => request.pathname.endsWith('/returns/lookup')), false);
    assert.equal(await page.getByText('Return at issuing teacher’s kiosk', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});

test('badge lookup of an existing pass remains returnable after the displayed assignment changes', async () => {
  const { page, state, requests, errors } = await setup('badge', { classId: 'class-a' });
  try {
    await page.getByPlaceholder('Student ID').fill('9876');
    await page.getByRole('button', { name: 'Look Up', exact: true }).click();
    await page.getByRole('button', { name: 'Check In (Return Pass)' }).waitFor();
    await page.getByText('Currently out: Hall pass', { exact: true }).waitFor();
    state.revision++; state.activity = { mode: 'classpilot', status: 'idle', timezone: 'UTC', current: null };
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.getByText(/No class scheduled/).waitFor();
    await page.getByRole('button', { name: 'Check In (Return Pass)' }).click();
    await page.getByText('Welcome back! Pass returned.', { exact: true }).waitFor();
    assert.deepEqual(requests.find(request => request.pathname.endsWith('/kiosk/checkin')).body, { studentId: match.studentId, passId: match.passId });
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});
