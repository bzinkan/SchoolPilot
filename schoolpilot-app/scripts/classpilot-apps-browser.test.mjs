import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authModule = `import{createContext,useContext}from'react';export const FixtureAuth=createContext(null);export const useAuth=()=>useContext(FixtureAuth);`;
const entry = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route}from'react-router-dom';
import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{FixtureAuth}from'/src/contexts/AuthContext.jsx';
import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import MySettings from'/src/products/classpilot/pages/MySettings.jsx';
import TeachingToolsLayout from'/src/products/classpilot/components/TeachingToolsLayout.jsx';
import AppPicker from'/src/products/classpilot/components/AppPicker.jsx';
import AppLibraryManager from'/src/products/classpilot/components/AppLibraryManager.jsx';
import{useClasspilotApps}from'/src/products/classpilot/hooks/useClasspilotApps.js';
import{appendAppDomains}from'/src/products/classpilot/lib/appLibrary.js';import'/src/index.css';
const h=React.createElement,params=new URLSearchParams(location.search),surface=params.get('surface')||'picker';
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function Probe(){const library=useClasspilotApps();window.fixtureRetryApps=library.retry;window.fixtureCreateApp=library.createApp;return null;}
function Fixture(){const[school,setSchool]=useState('school-a'),[value,setValue]=useState('manual.example.org'),[impersonating,setImpersonating]=useState(false);window.fixtureSetSchool=setSchool;window.fixtureSetImpersonating=setImpersonating;
const role=params.get('role')||'teacher',auth={user:{id:'teacher-a',email:'teacher@example.org',impersonating},activeSchoolId:school,activeMembership:{schoolId:school,schoolName:'Test school',roles:[role],role,status:'active'},loading:false};
return h(FixtureAuth.Provider,{value:auth},surface==='support'?h(Probe):null,surface==='teaching'?h(ThemeProvider,null,h(Routes,null,h(Route,{element:h(TeachingToolsLayout)},h(Route,{path:'*',element:h(MySettings)})))):h('main',{className:'mx-auto max-w-3xl p-5'},h('label',null,'Manual destination',h('input',{'aria-label':'Manual destination',value,onChange:e=>setValue(e.target.value)})),
surface==='manager'||surface==='manager-picker'?h(React.Fragment,null,h(AppLibraryManager,{scope:'personal'}),surface==='manager-picker'?h(AppPicker,{selectedUrl:value,onSelect:app=>setValue(app.launchUrl)}):null):surface==='school-manager'?h(AppLibraryManager,{scope:'school'}):h(AppPicker,{mode:surface==='flight-path'?'flight-path':'url',selectedUrl:surface==='uncontrolled'?undefined:value,onSelect:app=>setValue(app.launchUrl),onAddDomains:domains=>setValue(old=>appendAppDomains(old,domains))}),h('output',{'data-testid':'selected-value'},value)));}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(BrowserRouter,null,h(Fixture))));`;

let vite, browser, base;
before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-classpilot-apps-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'classpilot-apps-fixture', enforce: 'pre', transform(_code, id) { if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null }; },
      configureServer(server) { server.middlewares.use(async (req, res, next) => { if (!req.url?.startsWith('/__apps_fixture')) return next(); res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`)); }); } }],
  });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

const app = (key, name, extra = {}) => ({ key, name, kind: 'app', source: 'common', launchUrl: 'https://www.ixl.com/', allowedDomains: ['ixl.com'], iconKey: 'ixl', saved: false, favorite: false, canEdit: false, revision: 1, ...extra });
const GOOGLE_WORK_DOMAINS = ['classroom.google.com', 'docs.google.com', 'drive.google.com', 'sheets.google.com', 'slides.google.com', 'forms.google.com', 'forms.gle'];
const initialApps = () => [
  app('builtin:ixl', 'IXL'),
  app('builtin:docs', 'Google Docs', { launchUrl: 'https://docs.google.com/document/', allowedDomains: ['docs.google.com'], iconKey: 'docs' }),
  app('builtin:slides', 'Google Slides', { launchUrl: 'https://docs.google.com/presentation/', allowedDomains: ['docs.google.com'], iconKey: 'slides' }),
  app('builtin:classroom-bundle', 'Google Classroom bundle', { kind: 'bundle', launchUrl: null, allowedDomains: GOOGLE_WORK_DOMAINS, iconKey: 'classroom', includedApps: ['Classroom', 'Docs', 'Slides', 'Sheets', 'Forms', 'Drive'] }),
  app('saved:school', 'School reading', { source: 'school', launchUrl: 'https://reading.example.org/', allowedDomains: ['reading.example.org'], canEdit: false }),
];

async function open({ surface = 'picker', role = 'teacher', fail = false, personal = false, extraApps = [] } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const state = { apps: [...initialApps(), ...extraApps], requests: [], errors: [], fail, waitForCreate: null };
  if (personal) state.apps.push(app('saved:private', 'Private reading', { source: 'personal', saved: true, canEdit: true, launchUrl: 'https://private.example.org/', allowedDomains: ['private.example.org'] }));
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    const row = { method, path: url.pathname, schoolId: req.headers()['x-school-id'], body: method === 'GET' ? null : req.postDataJSON() };
    state.requests.push(row);
    if (url.pathname === '/api/auth/csrf') return route.fulfill({ json: { csrfToken: 'test-csrf' } });
    if (url.pathname === '/api/flight-paths') {
      if (method === 'POST') return route.fulfill({ status: 201, json: { flightPath: { id: 'new-flight-path', ...row.body } } });
      return route.fulfill({ json: { flightPaths: [] } });
    }
    if (url.pathname === '/api/block-lists') return route.fulfill({ json: { blockLists: [] } });
    if (url.pathname === '/api/teacher/groups') return route.fulfill({ json: { groups: [] } });
    if (url.pathname === '/api/classpilot/apps' && method === 'GET') {
      if (state.fail) return route.fulfill({ status: 503, json: { error: 'Library unavailable' } });
      return route.fulfill({ json: { apps: row.schoolId === 'school-b' ? [app('saved:other', 'Other school app', { source: 'school' })] : state.apps, canManageSchoolApps: role === 'admin' } });
    }
    if (url.pathname === '/api/classpilot/apps' && method === 'POST') {
      if (state.waitForCreate) await state.waitForCreate;
      const created = app('saved:new', row.body.name, { source: row.body.scope, launchUrl: row.body.launchUrl.startsWith('http') ? row.body.launchUrl : `https://${row.body.launchUrl}/`, allowedDomains: [row.body.launchUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')], canEdit: true, saved: true });
      state.apps.push(created); return route.fulfill({ status: 201, json: { app: created } });
    }
    const key = decodeURIComponent(url.pathname.split('/')[4] || '');
    if (method === 'PUT' && url.pathname.endsWith('/preferences')) { state.apps = state.apps.map(value => value.key === key ? { ...value, ...row.body } : value); return route.fulfill({ json: { app: state.apps.find(value => value.key === key) } }); }
    if (method === 'PATCH' || method === 'DELETE') {
      const current = state.apps.find(value => value.key === key);
      if (!current || row.body?.expectedRevision !== current.revision) return route.fulfill({ status: 409, json: { error: 'This website button changed elsewhere.', code: 'CLASSPILOT_APP_CONFLICT' } });
      if (method === 'PATCH') { state.apps = state.apps.map(value => value.key === key ? { ...value, name: row.body.name, launchUrl: row.body.launchUrl, revision: value.revision + 1 } : value); return route.fulfill({ json: { app: state.apps.find(value => value.key === key) } }); }
      state.apps = state.apps.filter(value => value.key !== key); return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected API request' } });
  });
  await page.goto(`${base}/__apps_fixture?${new URLSearchParams({ surface, role })}`);
  if (surface === 'teaching') await page.getByTestId('card-flight-paths').waitFor();
  else await page.getByRole('textbox', { name: 'Manual destination' }).waitFor();
  return { page, state };
}
const writes = state => state.requests.filter(row => row.method !== 'GET');

describe('ClassPilot app buttons', { concurrency: false }, () => {
  test('chooses a destination without issuing a classroom command and hides bundles for URL actions', async () => {
    const { page, state } = await open();
    try {
      await page.getByRole('button', { name: 'Choose IXL', exact: true }).click();
      assert.equal(await page.getByTestId('selected-value').textContent(), 'https://www.ixl.com/');
      assert.equal(await page.getByRole('button', { name: 'Choose Google Classroom bundle', exact: true }).count(), 0);
      assert.deepEqual(writes(state), []); assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('single-app highlighting follows the parent URL when it is edited manually', async () => {
    const { page, state } = await open();
    try {
      const ixl = page.getByRole('button', { name: 'Choose IXL', exact: true });
      await ixl.click(); assert.equal(await ixl.getAttribute('aria-pressed'), 'true');
      await page.getByRole('textbox', { name: 'Manual destination' }).fill('https://www.quill.org/');
      assert.equal(await ixl.getAttribute('aria-pressed'), 'false');
      await page.getByRole('textbox', { name: 'Manual destination' }).fill('https://docs.google.com/document/');
      assert.equal(await page.getByRole('button', { name: 'Choose Google Docs', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.deepEqual(writes(state), []);
    } finally { await page.close(); }
    const uncontrolled = await open({ surface: 'uncontrolled' });
    try {
      const ixl = uncontrolled.page.getByRole('button', { name: 'Choose IXL', exact: true });
      await ixl.click(); assert.equal(await ixl.getAttribute('aria-pressed'), 'true');
    } finally { await uncontrolled.page.close(); }
  });
  test('adds an explicit deduplicated set of apps and keeps manual domains when selections change', async () => {
    const { page, state } = await open({ surface: 'flight-path' });
    try {
      await page.getByRole('button', { name: 'Select Google Docs', exact: true }).click();
      await page.getByRole('button', { name: 'Select Google Slides', exact: true }).click();
      await page.getByRole('button', { name: 'Select Google Classroom bundle', exact: true }).click();
      assert.equal(await page.getByTestId('selected-value').textContent(), 'manual.example.org');
      await page.getByRole('button', { name: 'Add selected apps', exact: true }).click();
      const savedDraft = await page.getByTestId('selected-value').textContent();
      assert.deepEqual(savedDraft.split(', ').sort(), ['manual.example.org', ...GOOGLE_WORK_DOMAINS].sort());
      await page.getByRole('button', { name: 'Select Google Docs', exact: true }).click();
      await page.getByRole('button', { name: 'Select Google Docs', exact: true }).click();
      assert.equal(await page.getByTestId('selected-value').textContent(), savedDraft);
      assert.deepEqual(writes(state), []); assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('saves favorites privately and creates a custom button without a student command', async () => {
    const { page, state } = await open();
    try {
      await page.getByRole('button', { name: 'Favorite IXL', exact: true }).click();
      await page.getByRole('button', { name: 'Unfavorite IXL', exact: true }).waitFor();
      assert.deepEqual(writes(state)[0].body, { saved: true, favorite: true });
      await page.getByRole('button', { name: 'Add website', exact: true }).click();
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('Math practice');
      await page.getByRole('textbox', { name: 'Website address', exact: true }).fill('https://math.example.org/');
      await page.getByRole('button', { name: 'Save website', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="selected-value"]').textContent === 'https://math.example.org/');
      assert.deepEqual(writes(state).map(row => row.path), ['/api/classpilot/apps/builtin%3Aixl/preferences', '/api/classpilot/apps']);
      assert.equal(writes(state)[1].body.scope, 'personal');
      assert.ok(state.requests.filter(row => row.path.startsWith('/api/classpilot/apps')).every(row => row.schoolId === 'school-a'));
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('keeps manual input usable on library failure and recovers through Retry', async () => {
    const { page, state } = await open({ fail: true });
    try {
      await page.getByRole('button', { name: 'Retry app library', exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Manual destination' }).fill('manual-still-works.example.org');
      assert.equal(await page.getByTestId('selected-value').textContent(), 'manual-still-works.example.org');
      state.fail = false; await page.getByRole('button', { name: 'Retry app library', exact: true }).click();
      await page.getByRole('button', { name: 'Choose IXL', exact: true }).waitFor();
      assert.deepEqual(writes(state), []);
    } finally { await page.close(); }
  });
  test('keeps the picker usable on a narrow screen and exposes Google website scope', async () => {
    const { page, state } = await open({ surface: 'flight-path' });
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole('button', { name: 'Select Google Docs', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.getByRole('textbox', { name: 'Search apps', exact: true }).fill('slides');
      await page.getByRole('button', { name: 'Select Google Slides', exact: true }).click();
      assert.match(await page.getByRole('button', { name: 'Select Google Slides', exact: true }).innerText(), /Docs, Slides, Sheets, and Forms/);
      await page.getByRole('button', { name: 'Add selected apps', exact: true }).click();
      assert.equal(await page.getByTestId('selected-value').textContent(), 'manual.example.org, docs.google.com');
      assert.deepEqual(writes(state), []);
    } finally { await page.close(); }
  });
  test('switches schools without showing the previous school apps', async () => {
    const { page, state } = await open();
    try {
      await page.getByRole('button', { name: 'Choose School reading', exact: true }).waitFor();
      await page.evaluate(() => window.fixtureSetSchool('school-b'));
      await page.getByRole('button', { name: 'Choose Other school app', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Choose School reading', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Choose IXL', exact: true }).count(), 0);
      assert.equal(state.requests.at(-1).schoolId, 'school-b');
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('hides cached private and school buttons and guards current and stale retries in support mode', async () => {
    const { page, state } = await open({ surface: 'support', personal: true });
    try {
      await page.getByRole('button', { name: 'Choose Private reading', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Choose School reading', exact: true }).waitFor();
      await page.evaluate(() => { window.fixtureOldRetryApps = window.fixtureRetryApps; });
      const reads = state.requests.filter(row => row.method === 'GET' && row.path === '/api/classpilot/apps').length;
      await page.evaluate(() => window.fixtureSetImpersonating(true));
      await page.getByText('App buttons are unavailable in support sessions.', { exact: false }).waitFor();
      assert.equal(await page.getByTestId('app-picker').getByRole('button').count(), 0);
      await page.evaluate(async () => {
        await window.fixtureRetryApps(); await window.fixtureOldRetryApps();
        await window.fixtureCreateApp('personal', { name: 'Forbidden support button', launchUrl: 'https://forbidden.example.org/' }).catch(() => {});
      });
      assert.equal(state.requests.filter(row => row.method === 'GET' && row.path === '/api/classpilot/apps').length, reads);
      assert.deepEqual(writes(state), []);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('aborts pending app writes when the same school and viewer enter support mode', async () => {
    const { page, state } = await open({ surface: 'support', personal: true });
    let release;
    state.waitForCreate = new Promise(resolve => { release = resolve; });
    try {
      await page.getByRole('button', { name: 'Choose Private reading', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Add website', exact: true }).click();
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('Pending private button');
      await page.getByRole('textbox', { name: 'Website address', exact: true }).fill('https://pending.example.org/');
      const requested = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/classpilot/apps'));
      await page.getByRole('button', { name: 'Save website', exact: true }).click(); await requested;
      const reads = state.requests.filter(row => row.method === 'GET' && row.path === '/api/classpilot/apps').length;
      const aborted = page.waitForEvent('requestfailed', request => request.method() === 'POST' && request.url().endsWith('/api/classpilot/apps'));
      await page.evaluate(() => window.fixtureSetImpersonating(true));
      await aborted; release();
      await page.getByText('App buttons are unavailable in support sessions.', { exact: false }).waitFor();
      assert.equal(await page.getByTestId('selected-value').textContent(), 'manual.example.org');
      assert.equal(await page.getByRole('textbox', { name: 'Website name', exact: true }).count(), 0);
      assert.equal(state.requests.filter(row => row.method === 'GET' && row.path === '/api/classpilot/apps').length, reads);
      assert.equal(writes(state).length, 1);
      assert.deepEqual(state.errors, []);
    } finally { release(); await page.close(); }
  });
  test('aborts a pending personal-button creation when the school changes', async () => {
    const { page, state } = await open();
    let release;
    state.waitForCreate = new Promise(resolve => { release = resolve; });
    try {
      await page.getByRole('button', { name: 'Add website', exact: true }).click();
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('Old school button');
      await page.getByRole('textbox', { name: 'Website address', exact: true }).fill('https://old.example.org/');
      const requested = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/classpilot/apps'));
      await page.getByRole('button', { name: 'Save website', exact: true }).click();
      await requested;
      const aborted = page.waitForEvent('requestfailed', request => request.method() === 'POST' && request.url().endsWith('/api/classpilot/apps'));
      await page.evaluate(() => window.fixtureSetSchool('school-b'));
      await aborted; release();
      await page.getByRole('button', { name: 'Choose Other school app', exact: true }).waitFor();
      assert.equal(await page.getByTestId('selected-value').textContent(), 'manual.example.org');
      assert.equal(await page.getByRole('textbox', { name: 'Website name', exact: true }).count(), 0);
      assert.deepEqual(state.errors, []);
    } finally { release(); await page.close(); }
  });
  test('adds a bundle to a real Flight Path draft without saving until confirmed', async () => {
    const { page, state } = await open({ surface: 'teaching' });
    try {
      await page.getByTestId('button-create-flight-path').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByTestId('input-flight-path-name').fill('Math websites');
      await dialog.getByTestId('input-flight-path-domains').fill('manual.example.org');
      await dialog.getByRole('button', { name: 'Select Google Classroom bundle', exact: true }).click();
      await dialog.getByRole('button', { name: 'Add selected apps', exact: true }).click();
      assert.equal(await dialog.getByTestId('input-flight-path-domains').inputValue(), ['manual.example.org', ...GOOGLE_WORK_DOMAINS].join(', '));
      assert.equal(writes(state).length, 0);
      await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/flight-paths') && response.request().method() === 'POST'), dialog.getByTestId('button-save-flight-path').click()]);
      assert.deepEqual(writes(state).find(row => row.path === '/api/flight-paths').body.allowedDomains, ['manual.example.org', ...GOOGLE_WORK_DOMAINS]);
      assert.ok(!writes(state).some(row => row.path.includes('/commands')));
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('preserves an unsaved personal website form through the existing Teaching tools navigation guard', async () => {
    const { page, state } = await open({ surface: 'teaching' });
    try {
      const manager = page.getByTestId('card-my-apps');
      await manager.getByRole('button', { name: 'Add website', exact: true }).click();
      await manager.getByRole('textbox', { name: 'Website name', exact: true }).fill('Unsaved personal button');
      await page.getByText('Advanced', { exact: true }).click();
      await page.getByRole('link', { name: 'Planned time swaps', exact: true }).click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.getByRole('heading', { name: 'Leave with unsaved changes?' }).waitFor();
      await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await manager.getByRole('textbox', { name: 'Website name', exact: true }).inputValue(), 'Unsaved personal button');
      assert.deepEqual(writes(state), []);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('removing a personal button from My Apps also removes it from the picker My Apps collection while keeping it manageable', async () => {
    const { page, state } = await open({ surface: 'manager-picker' });
    try {
      const manager = page.getByTestId('card-my-apps'), picker = page.getByTestId('app-picker');
      await manager.getByRole('button', { name: 'Add website', exact: true }).click();
      await manager.getByRole('textbox', { name: 'Website name', exact: true }).fill('Personal practice');
      await manager.getByRole('textbox', { name: 'Website address', exact: true }).fill('https://practice.example.org/');
      await manager.getByRole('button', { name: 'Save website', exact: true }).click();
      await manager.getByRole('button', { name: 'Remove Personal practice from My Apps', exact: true }).click();
      await manager.getByRole('button', { name: 'Add Personal practice to My Apps', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
      assert.equal(await manager.getByRole('list', { name: 'My Apps', exact: true }).count(), 0);
      assert.equal(await manager.getByRole('button', { name: 'Edit Personal practice', exact: true }).isVisible(), false);
      await picker.getByRole('button', { name: 'My Apps', exact: true }).click();
      assert.equal(await picker.getByRole('button', { name: 'Choose Personal practice', exact: true }).count(), 0);
      await manager.getByText('Browse and manage other apps', { exact: true }).click();
      await manager.getByRole('button', { name: 'Edit Personal practice', exact: true }).waitFor();
      await manager.getByRole('button', { name: 'Delete Personal practice', exact: true }).waitFor();
      assert.equal(writes(state).at(-1).body.saved, false);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('retains website drafts on revision conflicts and requires explicitly reopening the latest saved version', async () => {
    const { page, state } = await open({ surface: 'school-manager', role: 'admin' });
    try {
      await page.getByRole('button', { name: 'Add school website', exact: true }).click();
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('Shared math');
      await page.getByRole('textbox', { name: 'Website address', exact: true }).fill('https://math.example.org/');
      await page.getByRole('button', { name: 'Save website', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Shared math', exact: true }).click();
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('My unsaved name');
      state.apps = state.apps.map(value => value.key === 'saved:new' ? { ...value, name: 'External math', revision: 2 } : value);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Website name', exact: true }).inputValue(), 'My unsaved name');
      assert.equal(writes(state).at(-1).body.expectedRevision, 1);
      assert.equal(writes(state).filter(row => row.method === 'PATCH').length, 1);
      assert.match(await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).innerText(), /Cancel and reopen/);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Edit External math', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Website name', exact: true }).inputValue(), 'External math');
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('Reviewed math');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByRole('button', { name: 'Delete Reviewed math', exact: true }).waitFor();
      assert.equal(writes(state).at(-1).body.expectedRevision, 2);
      await page.getByRole('button', { name: 'Delete Reviewed math', exact: true }).click();
      state.apps = state.apps.map(value => value.key === 'saved:new' ? { ...value, name: 'Newer math', revision: 4 } : value);
      await page.getByRole('button', { name: 'Confirm delete Reviewed math', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
      assert.equal(writes(state).at(-1).body.expectedRevision, 3);
      assert.ok(state.apps.some(value => value.key === 'saved:new'));
      await page.getByRole('button', { name: 'Confirm delete Reviewed math', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Confirm delete Newer math', exact: true }).count(), 0);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
  test('school button management is administrator-only', async () => {
    const denied = await open({ surface: 'school-manager' });
    try { await denied.page.getByText('Only school administrators can manage school apps.').waitFor(); assert.equal(await denied.page.getByRole('button', { name: 'Add school website' }).count(), 0); }
    finally { await denied.page.close(); }
    const { page, state } = await open({ surface: 'school-manager', role: 'admin' });
    try {
      await page.getByRole('button', { name: 'Add school website', exact: true }).click();
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('School math');
      await page.getByRole('textbox', { name: 'Website address', exact: true }).fill('https://school-math.example.org/');
      await page.getByRole('button', { name: 'Save website', exact: true }).click();
      await page.getByRole('button', { name: 'Edit School math', exact: true }).waitFor();
      assert.equal(writes(state)[0].body.scope, 'school');
      await page.getByRole('button', { name: 'Edit School math', exact: true }).click();
      await page.getByRole('textbox', { name: 'Website name', exact: true }).fill('Updated math');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByRole('button', { name: 'Delete Updated math', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm delete Updated math', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Edit Updated math"]'));
      assert.deepEqual(writes(state).map(row => row.method), ['POST', 'PATCH', 'DELETE']);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
});

test('individual and custom Classroom apps preserve authoring while showing effective Google work access', async () => {
  const { page, state } = await open({ surface: 'teaching', extraApps: [
    app('builtin:classroom', 'Google Classroom', { launchUrl: 'https://classroom.google.com/', allowedDomains: ['classroom.google.com'], effectiveAllowedDomains: GOOGLE_WORK_DOMAINS, iconKey: 'classroom' }),
    app('saved:my-classroom', 'My Classroom', { source: 'personal', launchUrl: 'https://classroom.google.com/u/0/', allowedDomains: ['classroom.google.com'], effectiveAllowedDomains: GOOGLE_WORK_DOMAINS, iconKey: 'website', saved: true, canEdit: true }),
  ] });
  try {
    await page.getByTestId('button-create-flight-path').click();
    const dialog = page.getByRole('dialog'), domains = dialog.getByTestId('input-flight-path-domains');
    await dialog.getByTestId('input-flight-path-name').fill('Classroom authoring');
    await domains.fill('manual.example.org');
    for (const key of ['builtin:classroom', 'saved:my-classroom']) {
      const tile = dialog.getByTestId(`app-button-${key}`);
      assert.match(await tile.innerText(), /forms.gle/, 'the actual website projection stays visible');
      await tile.click();
      await dialog.getByRole('button', { name: 'Add selected apps', exact: true }).click();
      assert.equal(await domains.inputValue(), 'manual.example.org, classroom.google.com');
      await domains.fill('manual.example.org');
    }
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/flight-paths') && response.request().method() === 'POST'), dialog.getByTestId('button-save-flight-path').click()]);
    assert.deepEqual(writes(state).find(row => row.path === '/api/flight-paths').body.allowedDomains, ['manual.example.org'], 'removing Classroom leaves no implicit Google work grants behind');
    assert.ok(!writes(state).some(row => row.path.includes('/commands')));
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});
