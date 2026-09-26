import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { sharedRecordQuery } from '../src/products/classpilot/lib/sharedRecordRefresh.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const entry = `import React,{useEffect}from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient';import{SharedRecordAccessSession}from'/src/products/classpilot/components/SharedRecordAccessBoundary';import Profile from'/src/products/classpilot/components/StudentContactProfileEditor';
const h=React.createElement;queryClient.setQueryData(['mydesk-private','school-a','teacher-a','history','student-a'],{private:true});window.privateHistory=()=>queryClient.getQueryData(['mydesk-private','school-a','teacher-a','history','student-a']);window.sharedCache=()=>queryClient.getQueriesData({predicate:q=>q.queryKey[3]==='student-information'});
function Preview(){useEffect(()=>{const url=URL.createObjectURL(new Blob(['synthetic']));return()=>URL.revokeObjectURL(url);},[]);return null;}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(MemoryRouter,null,h(SharedRecordAccessSession,{schoolId:'school-a',viewerId:'teacher-a',token:'synthetic-token',role:'teacher'},h(Profile,{schoolId:'school-a',viewerId:'teacher-a',studentId:'student-a'}),h(Preview)))));`;

before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-shared-access-${process.pid}`,
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'shared-access-browser', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__shared') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__shared-entry.jsx"></script></body></html>'));
      });
    }, resolveId(id) { if (id === '/__shared-entry.jsx') return '\0shared-entry'; }, load(id) { if (id === '\0shared-entry') return entry; } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

test('shared cache selection is exact to actor and the explicitly selected discipline import', () => {
  const matches = (...key) => sharedRecordQuery({ queryKey: key }, 'school-a', 'teacher-a', 'discipline-import');
  for (const kind of ['discipline', 'student-information']) assert.equal(matches('mydesk-private', 'school-a', 'teacher-a', kind), true);
  for (const kind of ['import', 'import-asset', 'import-duplicates']) {
    assert.equal(matches('mydesk-private', 'school-a', 'teacher-a', kind, 'discipline-import'), true);
    assert.equal(matches('mydesk-private', 'school-a', 'teacher-a', kind, 'private-import'), false);
  }
  for (const kind of ['notes', 'history', 'attachment', 'seating-chart']) assert.equal(matches('mydesk-private', 'school-a', 'teacher-a', kind), false);
  assert.equal(matches('mydesk-private', 'school-b', 'teacher-a', 'discipline'), false);
  assert.equal(matches('mydesk-private', 'school-a', 'teacher-b', 'student-information'), false);
});

async function setup() {
  const page = await browser.newPage(), errors = [], state = { denied: false, saves: 0 };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('sp_activeSchoolId', 'school-a');
    window.revoked = 0;
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = value => { window.revoked++; revoke(value); };
    class MockSocket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      constructor() { super(); window.latestSocket = this; setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
      send(frame) { if (JSON.parse(frame).type === 'auth') setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: '{"type":"auth-success"}' })), 0); }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    window.WebSocket = MockSocket;
    window.accessEvent = schoolId => window.latestSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'shared-record-access-changed', schoolId }) }));
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'synthetic' } });
    if (request.method() === 'PATCH') {
      state.saves++;
      await new Promise(resolve => { state.releaseSave = resolve; });
    }
    if (state.denied) return route.fulfill({ status: 403, json: { error: 'Current student access has ended.' } });
    if (url.pathname.endsWith('/history')) return route.fulfill({ json: { versions: [], nextCursor: null } });
    return route.fulfill({ json: { student: { id: 'student-a', name: 'Synthetic Student', gradeLevel: '5' }, profile: { revision: 1, data: { contacts: [{ id: 'guardian-a', name: 'Synthetic Guardian', relationship: 'Parent', phones: ['555-0100'], emails: [], preferred: null, emergency: null, preferredMethod: null, language: null }] } } } });
  });
  await page.goto(`${base}/__shared`);
  await page.getByRole('heading', { name: 'Synthetic Student' }).waitFor();
  return { page, state, errors };
}

test('roster notification hides denied contact fields, cancels shared cache, and preserves private historical notes', async () => {
  const { page, state, errors } = await setup();
  try {
    await page.getByLabel('Phone numbers, one per line').fill('555-0199');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('Phone numbers, one per line').inputValue(), '555-0199');
    await page.evaluate(() => window.accessEvent('another-school'));
    assert.equal(await page.getByLabel('Phone numbers, one per line').inputValue(), '555-0199');
    state.denied = true;
    await page.evaluate(() => window.accessEvent('school-a'));
    await page.getByRole('alert').filter({ hasText: 'Current student access has ended.' }).waitFor();
    assert.equal(await page.getByLabel('Phone numbers, one per line').count(), 0);
    assert.equal(await page.evaluate(() => window.revoked > 0), true);
    assert.deepEqual(await page.evaluate(() => window.privateHistory()), { private: true });
    assert.equal(await page.evaluate(() => window.sharedCache().some(([, data]) => data?.profile?.data)), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('notification aborts a late save and reconnect refreshes editors without restoring the prior draft', async () => {
  const { page, state, errors } = await setup();
  try {
    await page.getByLabel('Phone numbers, one per line').fill('555-0199');
    await page.getByLabel('Reason for this update').fill('Reviewed synthetic change');
    await page.getByRole('button', { name: 'Save reviewed changes' }).click();
    await page.waitForTimeout(50);
    assert.equal(state.saves, 1);
    await page.evaluate(() => window.accessEvent('school-a'));
    await page.getByLabel('Phone numbers, one per line').waitFor();
    state.releaseSave();
    await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('Phone numbers, one per line').inputValue(), '555-0100');
    await page.getByLabel('Phone numbers, one per line').fill('555-0188');
    await page.evaluate(() => window.latestSocket.close());
    await page.waitForTimeout(1300);
    assert.equal(await page.getByLabel('Phone numbers, one per line').inputValue(), '555-0100');
    assert.deepEqual(errors, []);
  } finally { state.releaseSave?.(); await page.close(); }
});
