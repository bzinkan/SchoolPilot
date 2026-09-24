import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom'; import {QueryClientProvider} from '@tanstack/react-query';
    import {AuthProvider} from '/src/contexts/AuthContext.jsx'; import {queryClient} from '/src/lib/queryClient.js';
    import Settings from '/src/products/passpilot/components/KioskScheduleSettings.jsx'; import '/src/index.css';
    queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(MemoryRouter,null,React.createElement(Settings)))));
  `;
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'kiosk-schedule-fixture',
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__kiosk-schedule') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__kiosk-schedule-entry.jsx"></script></body></html>'));
    }); },
    resolveId(id) { if (id === '/__kiosk-schedule-entry.jsx') return '\0kiosk-schedule-entry'; },
    load(id) { if (id === '\0kiosk-schedule-entry') return entry; },
  }] });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await vite.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  return { page, errors, url: `http://127.0.0.1:${vite.httpServer.address().port}` };
}

for (const layout of ['simple', 'badge']) test(`${layout} kiosk changes activities, clears selections, supports return-only students and fails closed`, async t => {
  const { page, url, errors } = await fixture(t);
  await page.addInitScript(() => localStorage.setItem('pp_kiosk_pin', '4321'));
  let revision = 1, status = 'ready', classId = 'math', assignmentName = 'Mathematics', failSnapshot = false;
  let checkoutCount = 0, returns = 0, staleCheckout = false;
  const student = { id: 'student', firstName: 'Ada', lastName: 'Student', studentIdNumber: '1234', canReturn: true };
  const returning = { id: 'returning', firstName: 'Grace', lastName: 'Returning', studentIdNumber: '5678', returnOnly: true, canReturn: true,
    activePass: { id: 'pass', destination: 'bathroom', issuedAt: new Date().toISOString(), duration: 5, status: 'active' } };
  const activity = () => ({ mode: 'classpilot', status, timezone: 'UTC', serverTime: new Date().toISOString(),
    nextBoundaryAt: new Date(Date.now() + 60_000).toISOString(), overridden: false,
    current: status === 'ready' ? { id: classId || 'testing', classId, kind: classId ? 'class' : 'testing', name: assignmentName, endsAt: new Date(Date.now() + 60_000).toISOString() } : null });
  await page.route('**/api/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    if (pathname === '/api/auth/me') return route.fulfill({ status: 401, json: { error: 'Not signed in' } });
    if (pathname.endsWith('/kiosk/auth')) return route.fulfill({ json: { token: 'fixture-token', expiresInSeconds: 900 } });
    if (pathname.endsWith('/kiosk/session')) return route.fulfill({ json: { kioskStyle: layout, session: { id: 'session', status: 'active', classId: null, source: 'classpilot_groups', kioskName: 'Teacher kiosk' } } });
    if (pathname.endsWith('/kiosk/snapshot')) {
      assert.equal(req.headers()['x-passpilot-kiosk-activity'], 'scheduled-activities-v1');
      if (failSnapshot) return route.fulfill({ status: 503, json: { error: 'Temporary schedule outage' } });
      return route.fulfill({ headers: { ETag: `"snapshot-${revision}"` }, json: {
        kioskStyle: layout, source: 'classpilot_groups', classId, className: assignmentName, kioskName: 'Teacher kiosk',
        session: { id: 'session', status: 'active' }, activity: activity(), revision, assignmentRevision: `assignment-${revision}`,
        students: status === 'ready' ? [student, returning] : [returning],
      } });
    }
    if (pathname.endsWith('/kiosk/lookup')) {
      const found = req.postDataJSON().studentIdNumber === '5678' ? returning : student;
      return route.fulfill({ json: { student: found, activePass: found.activePass || null, classId, assignmentRevision: `assignment-${revision}`, activity: activity() } });
    }
    if (pathname.endsWith('/kiosk/checkout')) {
      checkoutCount++; assert.equal(req.postDataJSON().assignmentRevision, `assignment-${revision}`);
      return route.fulfill({ status: staleCheckout ? 409 : 201, json: staleCheckout ? { code: 'PASSPILOT_KIOSK_ASSIGNMENT_CHANGED', error: 'The kiosk assignment changed. Select the student again.' } : { pass: {} } });
    }
    if (pathname.endsWith('/kiosk/checkin')) { returns++; return route.fulfill({ json: { pass: { status: 'returned' } } }); }
    if (pathname.endsWith('/kiosk/client-health')) return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: pathname } });
  });
  await page.goto(`${url}/passpilot/kiosk${layout === 'simple' ? '/simple' : ''}?school=school`);
  await page.getByText(/Following schedule.*Mathematics/).waitFor();
  const choose = async (number = '1234') => {
    if (layout === 'simple') await page.getByRole('button', { name: number === '1234' ? /Student, Ada/ : /Returning, Grace/ }).click();
    else { await page.getByPlaceholder('Student ID').fill(number); await page.getByRole('button', { name: /Look Up/ }).click(); }
  };
  await choose(); await page.getByRole('button', { name: /Bathroom$|^General\/Restroom$/ }).waitFor();
  revision++; classId = null; assignmentName = 'MAP testing';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText(/Following schedule.*MAP testing/).waitFor();
  assert.equal(await page.getByRole('button', { name: /Bathroom$|^General\/Restroom$/ }).count(), 0, 'a bell change closes unfinished destination forms');
  await choose(); staleCheckout = true;
  await page.getByRole('button', { name: /Bathroom$|^General\/Restroom$/ }).click();
  await page.getByText(/The kiosk assignment changed/).waitFor();
  assert.equal(checkoutCount, 1, 'a stale checkout is never silently retried');
  if (layout === 'badge') await page.getByRole('button', { name: /Try Again|Start Over|Done/ }).click();
  revision++; status = 'idle'; assignmentName = null;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText(/No class scheduled/).waitFor();
  await choose('5678');
  if (layout === 'badge') await page.getByRole('button', { name: /Check In/ }).click();
  await page.getByText(/Welcome back/).waitFor();
  assert.equal(returns, 1);
  revision++; status = 'ready'; assignmentName = 'MAP testing'; failSnapshot = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByTestId('kiosk-offline-banner').waitFor();
  assert.equal(await page.getByRole('button', { name: /Bathroom$|^General\/Restroom$/ }).count(), 0);
  failSnapshot = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText(/Following schedule.*MAP testing/).waitFor();
  await mkdir(path.join(root, 'artifacts', 'kiosk-schedule'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts', 'kiosk-schedule', `${layout}.png`), fullPage: true });
  assert.deepEqual(errors, []);
});

test('settings edit weekly blocks, days off, administrator teacher selection and revision failures accessibly', async t => {
  const { page, url, errors } = await fixture(t);
  let preference = { mode: 'manual', revision: 0, schedule: { blocks: [], exceptions: [] } };
  let rejectSave = false; const writes = [], teacherReads = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), parsed = new URL(req.url()), pathname = parsed.pathname;
    if (pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'admin', email: 'admin@example.test' }, activeSchoolId: 'school', memberships: [{ id: 'membership', schoolId: 'school', role: 'school_admin' }], licenses: { passPilot: true } } });
    if (pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture' } });
    if (pathname.endsWith('/preferences/teachers')) return route.fulfill({ json: { teachers: [{ id: 'admin', name: 'Administrator' }, { id: 'teacher', name: 'Teacher One' }] } });
    if (pathname.endsWith('/preferences/resume')) return route.fulfill({ json: { ok: true } });
    if (pathname.endsWith('/preferences')) {
      if (req.method() === 'GET') { teacherReads.push(parsed.searchParams.get('teacherId')); return route.fulfill({ json: { preference, source: 'legacy_grades', classes: [{ id: 'math', name: 'Mathematics' }], preview: { timezone: 'America/New_York', status: 'idle' } } }); }
      writes.push(req.postDataJSON());
      if (rejectSave) return route.fulfill({ status: 409, json: { error: 'The schedule changed. Reload before saving.' } });
      preference = { ...req.postDataJSON(), revision: preference.revision + 1 };
      return route.fulfill({ json: { preference } });
    }
    return route.fulfill({ status: 404, json: { error: pathname } });
  });
  await page.goto(`${url}/__kiosk-schedule`); await page.getByRole('heading', { name: 'Kiosk schedule', exact: true }).waitFor();
  await page.getByLabel('Teacher', { exact: true }).selectOption('teacher');
  await page.getByLabel('Kiosk mode').selectOption('passpilot');
  await page.getByRole('button', { name: 'Add weekly block' }).click();
  await page.getByLabel('Class', { exact: true }).selectOption('math');
  await page.getByLabel('Start time', { exact: true }).fill('09:00');
  await page.getByLabel('End time', { exact: true }).fill('10:00');
  await page.getByRole('button', { name: 'Add dated exception' }).click();
  await page.getByLabel('Exception date').fill('2026-12-24');
  await page.getByRole('button', { name: 'Save kiosk schedule' }).click();
  await page.getByRole('button', { name: 'Resume automatic on all kiosks' }).waitFor();
  assert.equal(writes[0].expectedRevision, 0); assert.equal(writes[0].mode, 'passpilot');
  assert.deepEqual(writes[0].schedule.exceptions, [{ date: '2026-12-24', blocks: [] }]);
  assert.ok(teacherReads.includes('teacher'));
  rejectSave = true;
  await page.getByLabel('End time', { exact: true }).fill('10:30');
  await page.getByRole('button', { name: 'Save kiosk schedule' }).click();
  await page.getByRole('alert').filter({ hasText: 'The schedule changed' }).waitFor();
  assert.equal(await page.getByLabel('End time', { exact: true }).inputValue(), '10:30', 'failed saving preserves the edit for review');
  await mkdir(path.join(root, 'artifacts', 'kiosk-schedule'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'artifacts', 'kiosk-schedule', 'settings.png'), fullPage: true });
  assert.deepEqual(errors, []);
});
