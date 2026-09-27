import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { schoolSettingsFixture } from './school-settings-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '../docs/images/settings-organization');
let vite, browser, base;
const authModule = `import{createContext,useContext}from'react';export const FixtureAuthContext=createContext(null);export const useAuth=()=>useContext(FixtureAuthContext);export const AuthProvider=({children})=>children;`;
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route,useLocation}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import{FixtureAuthContext}from'/src/contexts/AuthContext.jsx';import Layout from'/src/products/classpilot/components/admin/ClassPilotAdminShell.jsx';import Settings from'/src/products/classpilot/pages/Settings.jsx';import'/src/index.css';
const h=React.createElement,params=new URLSearchParams(location.search);history.replaceState({idx:0,key:'start',usr:{marker:'initial'}},'',params.get('route')||'/classpilot/settings?section=school');queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});window.queryClient=queryClient;
function Harness(){const[schoolId,setSchool]=useState('school-a'),[actor,setActor]=useState('viewer-a'),[role,setRole]=useState('school_admin'),[password,setPassword]=useState(true);window.setFixtureSchool=setSchool;window.setFixtureActor=setActor;window.setFixtureRole=setRole;window.setFixturePassword=setPassword;const location=useLocation();window.fixtureLocation=location;const user={id:actor,firstName:'Morgan',lastName:'Reed',email:'fixture@example.invalid'},activeMembership={schoolId,schoolName:schoolId==='school-a'?'Cedar Grove School':'Other School',schoolTimezone:'America/New_York',role,roles:[role],staffPasswordLoginEnabled:password};return h(FixtureAuthContext.Provider,{value:{user,activeSchoolId:schoolId,activeMembership,loading:false,refetchUser:async()=>{},logout:async()=>{window.loggedOut=true}}},h(Routes,null,h(Route,{element:h(Layout)},h(Route,{path:'/classpilot/settings',element:h(Settings)}),h(Route,{path:'/classpilot/admin',element:h('h2',null,'Overview fixture')})),h(Route,{path:'/classpilot',element:h('h1',null,'ClassPilot fixture')})));}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(Harness)))));`;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-admin-settings-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'settings-fixture', enforce: 'pre',
    transform(_code, id) { if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null }; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => { if (!req.url?.startsWith('/__settings')) return next(); res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`)); }); },
  }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });
async function fixture(t, route = '/classpilot/settings?section=browsing') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(12000);
  const state = { settings: schoolSettingsFixture('recipient-a'), writes: [], errors: [], readError: false, readStatus: 503, omitCurrent: false, reject: null, pending: null, release: null, digest: { digestEnabled: false, revision: 0 } };
  t.after(async () => { state.release?.(); await page.close(); }); page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method(), schoolId = request.headers()['x-school-id'];
    if (pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture' } });
    if (method !== 'GET') state.writes.push({ pathname, method, body: request.postDataJSON(), schoolId });
    if (state.pending === pathname && method !== 'GET') await new Promise(resolve => { state.release = resolve; });
    if (pathname === '/api/classpilot/admin/settings' && method === 'GET') return route.fulfill(state.readError ? { status: state.readStatus, json: { error: 'Synthetic refresh unavailable' } } : { json: { ...state.settings, schoolId, schoolName: schoolId === 'school-b' ? 'Other School' : state.settings.schoolName } });
    if (pathname.startsWith('/api/classpilot/admin/settings/') && method === 'PATCH') {
      const section = pathname.split('/').at(-1), body = request.postDataJSON(), existing = state.settings.sections[section];
      if (state.reject) return route.fulfill({ status: state.reject, json: { error: 'Synthetic conflict', ...(state.omitCurrent ? {} : { current: existing }) } });
      assert.equal(body[section === 'blockedWebsites' ? 'policyRevision' : 'expectedVersion'], existing[section === 'blockedWebsites' ? 'policyRevision' : 'version']);
      const { expectedVersion, policyRevision, ...fields } = body;
      state.settings.sections[section] = { ...fields, ...(section === 'blockedWebsites' ? { policyRevision: policyRevision + 1 } : { version: `${expectedVersion}-next` }) };
      return route.fulfill({ json: { schoolId, ...state.settings.sections[section] } });
    }
    if (pathname === '/api/admin/users') return route.fulfill({ json: { users: [{ userId: 'recipient-a', user: { id: 'recipient-a', firstName: 'Casey', lastName: 'Copy', email: 'copy@example.invalid' } }, { id: 'recipient-b', name: 'Second recipient', email: 'second@example.invalid' }] } });
    if (pathname === '/api/classpilot/enrollment-key') return route.fulfill({ json: { key: 'synthetic-key', schoolId, schoolSlug: 'cedar-grove' } });
    if (pathname.endsWith('/enrollment-key/rotate')) return route.fulfill({ json: { key: 'synthetic-new-key' } });
    if (pathname.endsWith('/monitoring-interruptions/settings')) { if (method === 'PUT') state.digest = { digestEnabled: request.postDataJSON().digestEnabled, revision: state.digest.revision + 1 }; return route.fulfill({ json: state.digest }); }
    if (pathname.endsWith('/staff-password-login')) return route.fulfill({ json: { school: { staffPasswordLoginEnabled: request.postDataJSON().enabled } } });
    if (pathname.endsWith('/cleanup-students')) return route.fulfill({ json: { success: true } });
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture route: ${pathname}` } });
  });
  await page.goto(`${base}/__settings?route=${encodeURIComponent(route)}`); await page.getByTestId('school-settings-workspace').waitFor(); return { page, state };
}
async function section(page, label) { await page.getByRole('link', { name: label, exact: true }).click(); }

test('school settings retain separate drafts across sections and save only the selected group', { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByLabel('Maximum tabs per student').fill('7'); await page.getByLabel('Website domains (comma-separated)').fill('games.example,other.example');
  await section(page, 'Staff notifications'); await page.getByLabel('Copy recipient').selectOption('recipient-b');
  await section(page, 'Browsing & monitoring'); assert.equal(await page.getByLabel('Maximum tabs per student').inputValue(), '7');
  await page.getByRole('button', { name: 'Save browsing defaults', exact: true }).click(); await page.getByRole('button', { name: 'Save browsing defaults' }).waitFor();
  await page.waitForFunction(() => document.getElementById('school-max-tabs')?.disabled === false);
  assert.equal(state.writes.length, 1); assert.deepEqual(state.writes[0].body, { maxTabsPerStudent: 7, allowedDomains: ['wikipedia.org'], expectedVersion: 'classroom-1' });
  await page.getByLabel('Maximum tabs per student').fill('101'); assert.equal(await page.getByRole('button', { name: 'Save browsing defaults' }).isDisabled(), true);
  await page.getByLabel('Maximum tabs per student').fill('7');
  assert.equal(await page.getByLabel('Website domains (comma-separated)').inputValue(), 'games.example,other.example');
  await section(page, 'Staff notifications'); assert.equal(await page.getByLabel('Copy recipient').inputValue(), 'recipient-b');
  await page.getByRole('link', { name: 'Overview', exact: true }).click(); await page.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByRole('button', { name: 'Save email recipient' }).click(); await page.waitForFunction(() => document.querySelector('#central-email-recipient')?.disabled === false);
  assert.equal(state.writes[1].body.centralEmailRecipientUserId, 'recipient-b'); assert.equal(state.writes[1].body.expectedVersion, 'email-1');
  assert.deepEqual(state.errors, []);
});

test('remote changes compare against retained drafts and failed refresh does not discard them', { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t); await page.getByLabel('Maximum tabs per student').fill('8');
  state.settings.sections.classroom = { version: 'remote-2', maxTabsPerStudent: 5, allowedDomains: ['saved.example'] };
  await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/admin/settings'] }));
  await page.getByText('These settings changed elsewhere.', { exact: false }).waitFor(); assert.equal(await page.getByLabel('Maximum tabs per student').inputValue(), '8');
  await page.getByRole('button', { name: 'Compare changes' }).click(); assert.ok((await page.getByRole('table').textContent()).includes('saved.example'));
  await page.getByRole('button', { name: 'Keep my draft' }).click(); state.readError = true;
  await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/admin/settings'] }));
  await page.getByText('Could not refresh settings.', { exact: false }).waitFor(); assert.equal(await page.getByLabel('Maximum tabs per student').inputValue(), '8');
  await page.getByRole('button', { name: 'Save browsing defaults' }).click(); await page.getByText('Changes saved.', { exact: true }).waitFor();
  assert.equal(state.writes[0].body.expectedVersion, 'remote-2'); assert.equal(state.writes[0].body.maxTabsPerStudent, 8); assert.deepEqual(state.errors, []);
});

test('blocked-policy conflict with failed refresh can discard without replacing the saved baseline', { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByLabel('Website domains (comma-separated)').fill('changed.example');
  state.reject = 409; state.omitCurrent = true; state.readError = true;
  await page.getByRole('button', { name: 'Save blocked websites' }).click();
  await page.getByRole('button', { name: 'Load latest values to compare' }).waitFor();
  assert.equal(await page.getByLabel('Website domains (comma-separated)').inputValue(), 'changed.example');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  assert.equal(await page.getByLabel('Website domains (comma-separated)').inputValue(), 'games.example');
  assert.equal(await page.getByRole('button', { name: 'Save blocked websites' }).isDisabled(), true);
  assert.deepEqual(state.errors, []);
});

test('server access denial removes drafts and protected snapshots instead of offering retry', { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByLabel('Maximum tabs per student').fill('8');
  state.readError = true; state.readStatus = 403;
  await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/admin/settings'] }));
  await page.getByText('School settings access is no longer available.', { exact: false }).waitFor();
  assert.equal(await page.getByTestId('school-settings-workspace').count(), 0);
  assert.equal(await page.evaluate(() => window.queryClient.getQueryData(['/api/classpilot/admin/settings', 'school-a', 'viewer-a']) === undefined), true);
  assert.equal(state.writes.length, 0); assert.deepEqual(state.errors, []);
});

test('switches require their own save and key rotation is explicitly confirmed', { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t, '/classpilot/settings?section=notifications');
  await page.getByRole('switch', { name: 'Daily monitoring interruption digest' }).click(); assert.equal(state.writes.length, 0);
  await page.getByRole('button', { name: 'Save monitoring digest' }).click(); await page.getByText('Changes saved.', { exact: true }).waitFor();
  assert.deepEqual(state.writes[0].body, { digestEnabled: true, expectedRevision: 0 });
  await section(page, 'Sign-in & devices'); await page.getByLabel('Allow staff to sign in with email and password').uncheck(); await page.getByLabel('Enable shared Chromebook sign-in').check(); assert.equal(state.writes.length, 1);
  await page.getByRole('button', { name: 'Save staff sign-in' }).click(); await page.getByRole('button', { name: 'Save shared Chromebook sign-in' }).click();
  await page.getByRole('button', { name: 'Rotate setup key' }).click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(state.writes.filter(write => write.pathname.endsWith('/rotate')).length, 0);
  await page.getByRole('button', { name: 'Rotate setup key' }).click(); await page.getByRole('button', { name: 'Save new setup key' }).click(); await page.getByText('Setup key saved.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Setup key', { exact: true }).inputValue(), 'synthetic-new-key'); assert.equal(state.writes.filter(write => write.pathname.endsWith('/rotate')).length, 1); assert.deepEqual(state.errors, []);
});

test('pending save blocks exits and an old identity response cannot replace new school state', { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t); state.pending = '/api/classpilot/admin/settings/classroom';
  await page.getByLabel('Maximum tabs per student').fill('9'); await page.getByRole('button', { name: 'Save browsing defaults' }).click();
  await page.getByRole('link', { name: 'Overview', exact: true }).click(); await page.getByText('Wait for the current operation', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Maximum tabs per student').isDisabled(), true);
  const oldWorkspace = await page.getByTestId('school-settings-workspace').elementHandle();
  const newSchoolRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/classpilot/admin/settings'
    && response.request().method() === 'GET' && response.request().headers()['x-school-id'] === 'school-b');
  await page.evaluate(() => window.setFixtureSchool('school-b'));
  // The heading and test id are shared by both schools. Wait for the old owner
  // to unmount and the new school's read before inspecting the replacement.
  await page.waitForFunction(element => !element.isConnected, oldWorkspace);
  await newSchoolRead;
  await page.locator('header').getByText('Other School', { exact: true }).waitFor();
  await page.getByTestId('school-settings-workspace').waitFor();
  assert.equal(await page.getByLabel('Maximum tabs per student').inputValue(), '');
  assert.equal(await page.getByLabel('Maximum tabs per student').isDisabled(), false, 'The new identity has no pending save');
  const oldSave = page.waitForResponse(response => new URL(response.url()).pathname === state.pending
    && response.request().method() === 'PATCH' && response.request().headers()['x-school-id'] === 'school-a');
  state.release();
  await (await oldSave).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByLabel('Maximum tabs per student').inputValue(), '');
  assert.equal(await page.evaluate(() => window.queryClient.getQueryData(['/api/classpilot/admin/settings', 'school-b', 'viewer-a'])?.sections.classroom.maxTabsPerStudent), null, 'The old response cannot replace the new school snapshot');
  assert.equal(await page.getByText('Changes saved.', { exact: true }).count(), 0, 'The old response cannot announce success in the new identity');
  assert.equal(state.writes[0].schoolId, 'school-a');
  await page.evaluate(() => window.setFixtureRole('teacher')); await page.getByRole('heading', { name: 'ClassPilot fixture' }).waitFor(); assert.equal(await page.getByTestId('school-settings-workspace').count(), 0); assert.deepEqual(state.errors, []);
});

test('maintenance compatibility and real shell settings stay clear on desktop and mobile', { timeout: 60000 }, async t => {
  const { page, state } = await fixture(t, '/classpilot/admin?tab=maintenance&keep=1#old');
  assert.equal(new URL(page.url()).searchParams.get('section'), 'data'); assert.equal(new URL(page.url()).searchParams.get('keep'), '1');
  assert.equal(await page.getByTestId('button-cleanup-students').count(), 0, 'school_admin does not gain admin-only cleanup authority');
  await page.evaluate(() => window.setFixtureRole('admin'));
  await page.getByTestId('button-cleanup-students').click(); await page.getByTestId('button-cancel-cleanup').click(); assert.equal(state.writes.length, 0);
  await section(page, 'School details'); assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1); assert.equal(await page.getByRole('textbox', { name: 'School name' }).count(), 0); assert.equal(await page.getByRole('link', { name: 'Open school profile' }).count(), 0);
  await page.getByRole('heading', { level: 1, name: 'School details', exact: true }).waitFor(); await page.mouse.move(1400, 0); await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(artifacts, 'school-settings-desktop.png'), fullPage: true });
  await section(page, 'Browsing & monitoring'); await page.getByRole('heading', { level: 1, name: 'Browsing & monitoring' }).waitFor(); await page.mouse.move(1400, 0); await page.waitForTimeout(250); await page.screenshot({ path: path.join(artifacts, 'browsing-settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(artifacts, 'browsing-settings-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: 'Admin menu', exact: true }).click(); await page.getByRole('dialog').getByRole('link', { name: 'Staff notifications', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Staff notifications' }).waitFor(); await page.screenshot({ path: path.join(artifacts, 'notifications-settings-mobile.png'), fullPage: true }); assert.deepEqual(state.errors, []);
});
