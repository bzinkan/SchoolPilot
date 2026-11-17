import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, origin;
const auth = `import React from 'react';export const FixtureAuth=React.createContext(null);export const useAuth=()=>React.useContext(FixtureAuth);`;
const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{FixtureAuth}from'/src/contexts/AuthContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import ITReadiness from'/src/products/classpilot/pages/ITReadiness.jsx';
function Fixture(){const[school,setSchool]=useState('school-a');window.setFixtureSchool=setSchool;return React.createElement(FixtureAuth.Provider,{value:{activeSchoolId:school,user:{id:'admin-a'},activeMembership:{schoolId:school,role:'admin',roles:['admin'],status:'active'}}},React.createElement(ITReadiness));}
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(BrowserRouter,null,React.createElement(ThemeProvider,null,React.createElement(Fixture)))));`;

before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-classroom-setup-${process.pid}`,
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'student-classroom-setup-fixture', enforce: 'pre',
      transform(_source, id) { if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: auth, map: null }; },
      configureServer(server) { server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__student_classroom_setup')) return next();
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
      }); },
    }] });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

async function fixture() {
  const page = await browser.newPage();
  const state = { writes: [], enabled: {}, errors: [], holdVerify: false, release: null };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedClassroomScopes = text; } } }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), schoolId = request.headers()['x-school-id'] || 'school-a';
    if (url.pathname.includes('/roster-connector/classroom-access')) {
      if (request.method() === 'GET') return route.fulfill({ json: { purpose: 'student_classroom_access', available: true,
        enabled: state.enabled[schoolId] === true, schoolDomain: 'example.edu', serviceAccountClientId: 'client-for-this-school',
        scopes: ['roster.readonly', 'classroom.readonly'], scopesCsv: 'roster.readonly,classroom.readonly',
        verificationStudents: [{ id: schoolId === 'school-a' ? 'student-a' : 'student-b', name: schoolId === 'school-a' ? 'Taylor Student' : 'Morgan Student' }],
        adminConsoleUrl: 'https://admin.google.com/ac/owl/domainwidedelegation', setupCopy: { description: 'Read published work without modifying student data.', revocation: 'Content access can be disabled separately from roster imports.' } } });
      const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
      state.writes.push({ path: url.pathname, method: request.method(), schoolId, ...(body ? { body } : {}) });
      if (state.holdVerify) await new Promise(resolve => { state.release = resolve; });
      state.enabled[schoolId] = request.method() === 'POST';
      return route.fulfill({ json: { classroomAccess: { enabled: state.enabled[schoolId], purpose: 'student_classroom_access' } } }).catch(() => {});
    }
    if (request.method() !== 'GET') state.writes.push({ path: url.pathname, method: request.method(), schoolId });
    if (url.pathname.endsWith('/roster-connector/setup-info')) return route.fulfill({ json: { serviceAccount: { configured: true }, connector: { status: 'verified' }, scopesCsv: 'roster.readonly', serviceAccountClientId: 'client-for-this-school' } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/__student_classroom_setup`);
  return { page, state };
}

test('administrator verifies a named school student with combined read scopes and disables only Classroom content', { timeout: 60_000 }, async () => {
  const { page, state } = await fixture();
  try {
    const card = page.getByTestId('student-classroom-access-setup');
    await card.waitFor({ timeout: 8_000 });
    await card.getByRole('button', { name: 'Copy combined scopes' }).click();
    assert.equal(await page.evaluate(() => window.copiedClassroomScopes), 'roster.readonly,classroom.readonly');
    await card.getByLabel('Student to verify', { exact: true }).selectOption('student-a');
    await card.getByRole('button', { name: 'Verify Classroom access', exact: true }).click();
    await card.getByText('Classroom assignment access enabled.', { exact: true }).waitFor();
    assert.deepEqual(state.writes[0], { path: '/api/google/roster-connector/classroom-access/verify', method: 'POST', schoolId: 'school-a', body: { studentId: 'student-a' } });
    await card.getByRole('button', { name: 'Disable Classroom access', exact: true }).click();
    await card.getByText('Classroom assignment access disabled.', { exact: true }).waitFor();
    assert.deepEqual(state.writes[1], { path: '/api/google/roster-connector/classroom-access', method: 'DELETE', schoolId: 'school-a' });
    assert.equal(state.writes.length, 2, 'content setup never writes or disables the roster connector');
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('a late content verification cannot update another school or restore its previous student selection', { timeout: 60_000 }, async () => {
  const { page, state } = await fixture();
  try {
    const card = page.getByTestId('student-classroom-access-setup');
    await card.getByLabel('Student to verify', { exact: true }).selectOption('student-a');
    state.holdVerify = true;
    await card.getByRole('button', { name: 'Verify Classroom access', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="student-classroom-access-setup"] button') && document.body.textContent.includes('Verifying'));
    await page.evaluate(() => window.setFixtureSchool('school-b'));
    await card.getByRole('option', { name: 'Morgan Student', exact: true }).waitFor({ state: 'attached' });
    assert.equal(await card.getByLabel('Student to verify', { exact: true }).inputValue(), '');
    state.release?.();
    await page.waitForTimeout(100);
    assert.equal(await card.getByText('Classroom assignment access enabled.', { exact: true }).count(), 0);
    assert.equal(await card.getByRole('button', { name: 'Verify Classroom access', exact: true }).isDisabled(), true);
    assert.deepEqual(state.errors, []);
  } finally { state.release?.(); await page.close(); }
});
