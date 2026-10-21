import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date('2026-10-21T15:22:00.000Z');
const students = [
  { id: 'student-a', firstName: 'Synthetic', lastName: 'Adams' },
  { id: 'student-b', firstName: 'Synthetic', lastName: 'Baker' },
  { id: 'student-c', firstName: 'Synthetic', lastName: 'Clark' },
];
const passes = [
  { id: 'pass-a', studentId: 'student-a', destination: 'bathroom', issuedAt: '2026-10-21T15:17:25.000Z' },
  { id: 'pass-b', studentId: 'student-b', destination: 'custom', customDestination: 'Synthetic Library', issuedAt: '2026-10-21T15:11:27.000Z' },
  { id: 'pass-c', studentId: 'student-c', destination: 'office', issuedAt: '2026-10-21T15:21:35.000Z' },
].map(pass => ({ ...pass, status: 'active', classpilotGroupId: 'class-a', expiresAt: '2026-10-21T16:00:00.000Z', student: students.find(student => student.id === pass.studentId) }));
const entry = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { queryClient } from '/src/lib/queryClient.js';
import MyClassTab from '/src/products/passpilot/components/tabs/MyClassTab.jsx';
import PassesTab from '/src/products/passpilot/components/tabs/PassesTab.jsx';
import '/src/index.css';
queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});
const mode = new URLSearchParams(location.search).get('mode');
const h = React.createElement;
createRoot(document.getElementById('root')).render(h(QueryClientProvider, {client:queryClient},
  h(MemoryRouter, {initialEntries:['/passpilot?classId=class-a']}, h(mode === 'passes' ? PassesTab : MyClassTab))));`;
const auth = `export function useAuth(){return {
  user:{id:'teacher-a',firstName:'Synthetic',lastName:'Teacher'},
  activeSchoolId:'school-a',loading:false,
  activeMembership:{schoolId:'school-a',schoolName:'Synthetic School',role:'teacher',roles:['teacher'],schoolTimezone:'America/New_York'},
  logout:async()=>{},refetchUser:async()=>{}
};}`;
let vite, browser, base;
const pages = new Set();

before(async () => {
  vite = await createServer({
    root,
    logLevel: 'error',
    cacheDir: `node_modules/.vite-passpilot-times-${process.pid}`,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'passpilot-time-browser-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/__pass-times?')) return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__time-entry.jsx"></script></body></html>'));
        });
      },
      resolveId(id) { if (id === '/__time-entry.jsx') return '\0time-entry'; },
      load(id) {
        const file = id.replace(/\\/g, '/');
        if (file.endsWith('/contexts/AuthContext.jsx')) return auth;
        if (file.endsWith('/shared/hooks/useStudentImportHome.js')) return 'export const useStudentImportHome=()=>({canLinkToClassPilot:false});';
        if (id === '\0time-entry') return entry;
      },
    }],
  });
  await vite.listen();
  base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

async function close(page) {
  await page.unrouteAll({ behavior: 'wait' });
  await page.close();
  pages.delete(page);
}

after(async () => {
  try { for (const page of pages) await close(page); }
  finally { await browser?.close(); await vite?.close(); }
});

async function setup(mode = 'myclass') {
  // Device time zone differs deliberately; departures must stay in school time.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' });
  pages.add(page);
  const requests = [], errors = [], state = { blockPassReads: false, passResponses: 0 };
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(now);
  await page.addInitScript(() => localStorage.setItem('sp_activeSchoolId', 'school-a'));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const json = (value, status = 200) => route.fulfill({ json: value, status });
    if (url.pathname.endsWith('/passpilot/classes')) return json({ source: 'classpilot_groups', classes: [{ id: 'class-a', name: '6th', studentCount: 3 }] });
    if (url.pathname.endsWith('/passpilot/classes/class-a/students')) return json({ students });
    if (url.pathname.endsWith('/passes/active')) {
      if (state.blockPassReads) return route.abort('internetdisconnected');
      state.passResponses++;
      return json({ classId: 'class-a', passes });
    }
    if (url.pathname.endsWith('/admin/attendance')) return json({ records: [] });
    if (url.pathname.endsWith('/kiosk/sessions/mine')) return json({ sessions: [] });
    if (url.pathname.endsWith('/appointments/capabilities')) return json({ error: 'Unknown route' }, 404);
    return json({ error: 'Unexpected synthetic request' }, 404);
  });
  await page.goto(`${base}/__pass-times?mode=${mode}`);
  await page.getByTestId('pass-duration-pass-a').waitFor();
  return { page, requests, errors, state };
}

async function durationEquals(page, passId, expected, timeout = 1500) {
  await page.waitForFunction(({ id, text }) => document.querySelector(`[data-testid="pass-duration-${id}"]`)?.textContent === text,
    { id: passId, text: expected }, { timeout });
}

test('My Class hides seconds for normal, custom, and subminute passes in school time', async () => {
  const { page, errors } = await setup();
  try {
    assert.equal(await page.getByTestId('pass-duration-pass-a').textContent(), '4 min');
    assert.equal(await page.getByTestId('pass-duration-pass-b').textContent(), '10 min');
    assert.equal(await page.getByTestId('pass-duration-pass-c').textContent(), '<1 min');
    const customDetails = await page.getByTestId('pass-duration-pass-b').locator('..').textContent();
    assert.match(customDetails, /Out for 10 min/);
    assert.match(customDetails, /Synthetic Library/);
    assert.match(customDetails, /Since 11:11 AM/);
    for (const pass of passes) {
      const details = await page.getByTestId(`pass-duration-${pass.id}`).locator('..').textContent();
      assert.doesNotMatch(details, /\bsec\b|Since \d{1,2}:\d{2}:\d{2}/);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.PASSPILOT_TIME_SCREENSHOTS) {
      await mkdir(process.env.PASSPILOT_TIME_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PASSPILOT_TIME_SCREENSHOTS, 'pass-times-phone.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: path.join(process.env.PASSPILOT_TIME_SCREENSHOTS, 'pass-times-desktop.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});

test('elapsed minutes retain departure seconds and advance at the exact elapsed-minute boundary', async () => {
  const { page, errors } = await setup();
  try {
    // The stored departure is 11:17:25 AM. Hiding its seconds must not make
    // the fifth elapsed minute start early at the 11:22 AM clock boundary.
    await page.clock.setFixedTime(new Date('2026-10-21T15:22:24.999Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await durationEquals(page, 'pass-a', '4 min', 500);
    const details = await page.getByTestId('pass-duration-pass-a').locator('..').textContent();
    assert.match(details, /Since 11:17 AM/);
    await page.clock.setFixedTime(new Date('2026-10-21T15:22:25.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await durationEquals(page, 'pass-a', '5 min', 500);
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});

test('live timers advance and recover immediately on focus and visibility without changed pass data', async () => {
  const { page, requests, errors, state } = await setup();
  try {
    state.blockPassReads = true;
    const responsesBefore = state.passResponses;
    // Wall-clock changes do not execute timers themselves. The shared ticker
    // must recalculate elapsed time instead of incrementing an old counter.
    await page.clock.setFixedTime(new Date('2026-10-21T15:22:35.000Z'));
    await durationEquals(page, 'pass-a', '5 min');
    await durationEquals(page, 'pass-c', '1 min');
    await page.clock.setFixedTime(new Date('2026-10-21T15:24:00.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await durationEquals(page, 'pass-a', '6 min', 500);
    await page.clock.setFixedTime(new Date('2026-10-21T15:26:00.000Z'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await durationEquals(page, 'pass-a', '8 min', 500);
    await durationEquals(page, 'pass-b', '14 min', 500);
    assert.ok(requests.includes('/api/passes/active'));
    assert.equal(state.passResponses, responsesBefore, 'Elapsed labels must recover without another active-pass response');
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});

test('the schoolwide Passes tab uses the same minute-only elapsed labels', async () => {
  const { page, errors } = await setup('passes');
  try {
    assert.equal(await page.getByTestId('pass-duration-pass-a').textContent(), '4 min');
    assert.equal(await page.getByTestId('pass-duration-pass-c').textContent(), '<1 min');
    assert.deepEqual(errors, []);
  } finally { await close(page); }
});
