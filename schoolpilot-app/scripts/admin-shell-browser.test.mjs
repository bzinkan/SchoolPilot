import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { ADMIN_NAVIGATION, adminLegacyDestination, adminNavigationTarget, adminRoute } from '../src/products/classpilot/lib/adminNavigation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(os.tmpdir(), 'schoolpilot-admin-panel-organization');
let vite, browser, base;
const authModule = `import {createContext,useContext} from 'react'; export const FixtureAuthContext=createContext(null); export const useAuth=()=>useContext(FixtureAuthContext); export const AuthProvider=({children})=>children;`;
const entry = `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{BrowserRouter,Routes,Route,Link,useLocation}from'react-router-dom';
import{QueryClientProvider,useQuery}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';
import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import{FixtureAuthContext}from'/src/contexts/AuthContext.jsx';
import Layout from'/src/products/classpilot/components/admin/ClassPilotAdminShell.jsx';
import Boundary from'/src/products/classpilot/components/admin/AdminQueryBoundary.jsx';
import Admin from'/src/products/classpilot/pages/Admin.jsx';
import AdminClasses from'/src/products/classpilot/pages/AdminClasses.jsx';
import{useAdminShell,useAdminNavigation,useAdminNavigationBlocker}from'/src/products/classpilot/hooks/useAdminNavigation.js';
import{adminIdentityKey,adminRoute}from'/src/products/classpilot/lib/adminNavigation.js';import'/src/index.css';
const h=React.createElement,params=new URLSearchParams(location.search),mode=params.get('mode')||'guard';
const initial=params.get('route')||'/classpilot/admin/scheduling?section=school-year';
history.replaceState({idx:0,key:'fixture-start',usr:{marker:'initial'}},'',initial);
window.__discards=0;window.__actions=0;window.queryClient=queryClient;
function CommittedChild(){const owner=useAdminNavigationBlocker({id:'committed-child',dirty:true,busy:false});window.committedChildNavigate=owner.navigateAfterCommit;return null;}
function Editor(){const route=useLocation();const shell=useAdminShell(),navigation=useAdminNavigation();
const[draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[other,setOther]=useState(false);
const[child,setChild]=useState(false);window.fixtureChild=setChild;
const commit=useAdminNavigationBlocker({id:'fixture-editor',dirty:Boolean(draft),busy,
shouldBlock:({nextLocation,kind})=>kind==='action'||!nextLocation||nextLocation.pathname!==route.pathname||new URLSearchParams(nextLocation.search).get('month')!==new URLSearchParams(route.search).get('month'),
onDiscard:async()=>{if(window.__veto)return false;if(window.__defer)await new Promise(resolve=>window.__resolveDiscard=resolve);window.__discards++;setDraft('');}});
useAdminNavigationBlocker({id:'other-editor',dirty:other,busy:false,onDiscard:()=>setOther(false)});
window.fixtureBusy=setBusy;window.fixtureOther=setOther;window.fixtureGuardedNavigate=navigation.navigate;
window.fixtureAction=()=>navigation.requestAction(async()=>{window.__actions++;return !window.__actionVeto;},{id:'fixture-action'}).then(value=>window.__actionResult=value);
window.fixtureOldCommit=commit.navigateAfterCommit;
return h('section',{'data-testid':'fixture-editor','data-busy':String(busy),'data-child':String(child),className:'space-y-4 rounded-xl border bg-card p-6'},child&&h(CommittedChild),h('h2',{className:'text-lg font-semibold'},shell?'Synthetic editor':'Teacher workspace'),
h('label',{className:'block'},'Draft',h('input',{'aria-label':'Draft',className:'ml-3 rounded border p-2',value:draft,onChange:event=>setDraft(event.target.value)})),
h(Link,{to:'/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses',state:{marker:'link-state'},className:'block underline'},'Local return with state'),
h('button',{onClick:()=>navigation.navigate('/classpilot/admin/classes',{state:{marker:'button-state'}})},'Guarded return'),
h('button',{onClick:()=>{setDraft('');void commit.navigateAfterCommit('/classpilot/admin/classes',{state:{marker:'committed'}})}},'Save and leave'),
h('button',{onClick:()=>window.print()},'Print fixture'),h('a',{href:'data:text/plain,fixture',download:'fixture.txt'},'Download fixture'),
h('a',{href:'/classpilot/admin/classes',target:'_blank'},'Open new tab'));}
function Destination(){return h('section',null,h('h2',null,'Destination'),h(Link,{to:'/classpilot/admin/scheduling?section=school-year',state:{marker:'editor-link'}},'Open editor'));}
function LegacyQuery({identity}){const query=useQuery({queryKey:['/api/admin/teacher-students'],queryFn:({signal})=>new Promise(resolve=>{window.__requests??=[];const call={identity,aborted:false};window.__requests.push(call);signal.addEventListener('abort',()=>call.aborted=true);window['resolve-'+identity]=()=>resolve({name:identity});}),retry:false});return h('output',{'aria-label':'Legacy data'},query.data?.name||'Loading roster');}
function RouteOutput(){const route=useLocation();window.__route=route;return null;}
function Harness(){const route=useLocation();const[identity,setIdentity]=useState('school-a'),[role,setRole]=useState(params.get('role')||'school_admin');
const user={id:'viewer-a',firstName:'Morgan',lastName:'Reed',email:'synthetic@example.invalid'};
const activeMembership={schoolId:identity,schoolName:'Cedar Grove School',schoolTimezone:'America/New_York',role,roles:[role],mailpilotEntitled:true,classpilotEmailMonitoring:false};
const value={user,activeMembership,activeSchoolId:identity,loading:false,token:'synthetic-token',logout:async()=>{window.__signedOut=true},refetchUser:async()=>{}};
window.fixtureIdentity=setIdentity;window.fixtureRole=setRole;
return h(FixtureAuthContext.Provider,{value},h(Boundary,{scopeKey:adminIdentityKey(user,activeMembership,identity),blockChildren:Boolean(adminRoute(route))},h(RouteOutput),h(Routes,null,h(Route,{element:h(Layout)},
h(Route,{path:'/classpilot/admin',element:mode==='overview'?h(Admin):h(Editor)}),
h(Route,{path:'/classpilot/admin/scheduling',element:mode==='identity'?h(LegacyQuery,{identity}):h(Editor)}),
h(Route,{path:'/classpilot/admin/classes/scheduling',element:h(Editor)}),h(Route,{path:'/classpilot/admin/classes',element:mode==='classes'?h(AdminClasses):h(Destination)}),
h(Route,{path:'/classpilot/students',element:h(Destination)}),h(Route,{path:'/classpilot/discipline-records',element:h(Editor)}),
h(Route,{path:'/classpilot/coverage',element:h(Editor)}),h(Route,{path:'/classpilot/settings',element:h(Destination)})),
h(Route,{path:'/classpilot',element:h('h1',null,'ClassPilot dashboard')}))));}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(Harness)))));
`;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-admin-shell-${process.pid}`,
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'admin-shell-fixture', enforce: 'pre',
      transform(_code, id) { if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null }; },
      configureServer(server) { server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__admin_shell')) return next();
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, `<html><head></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
      }); },
    }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

async function open({ mode = 'guard', route, role, year = 'current' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async request => {
    const url = new URL(request.request().url()); requests.push(url.pathname);
    if (url.pathname.endsWith('/classpilot/admin/classes/classroom/import-preview')) {
      return request.fulfill({ json: { enabled: true, courses: [{ googleCourseId: 'course-a', name: 'Synthetic Biology', studentCount: 2, matchedTeacher: { id: 'teacher-a' } }] } });
    }
    if (url.pathname.endsWith('/admin/teachers')) {
      return request.fulfill({ json: { teachers: [{ id: 'teacher-a', firstName: 'Taylor', lastName: 'Woods', role: 'teacher' }] } });
    }
    if (url.pathname.endsWith('/classpilot/admin/classes')) return request.fulfill({ json: { classes: [] } });
    if (url.pathname.endsWith('/admin/teacher-students')) return request.fulfill({ json: { students: [] } });
    if (url.pathname.endsWith('/classpilot/admin/scheduling')) {
      return request.fulfill({ status: year === 'error' ? 503 : 200, json: year === 'error' ? { error: 'synthetic unavailable' } : {
        config: { yearStart: year === 'missing' ? null : '2026-08-19', yearEnd: year === 'missing' ? null : '2027-05-28' },
        revision: 49, schoolLocalToday: '2026-09-27', schoolTimezone: 'America/New_York',
      } });
    }
    return request.fulfill({ json: {} });
  });
  const params = new URLSearchParams({ mode, ...(route ? { route } : {}), ...(role ? { role } : {}) });
  await page.goto(`${base}/__admin_shell?${params}`);
  await page.waitForFunction(() => window.__route !== undefined);
  return { page, errors, requests };
}

test('fixed aliases and scheduling sections preserve query, hash, state and explicit destinations', () => {
  const state = { testingGroupPrefill: { groupId: 'fixture' } };
  const legacy = adminLegacyDestination({ pathname: '/classpilot/admin/classes/scheduling', search: '?section=profiles&month=2027-02', hash: '#preview', state });
  assert.deepEqual(legacy, { pathname: '/classpilot/admin/scheduling', search: '?section=profiles&month=2027-02', hash: '#preview', state });
  assert.equal(adminLegacyDestination({ pathname: '/classpilot/admin', search: '?tab=students&returnTo=https://example.invalid', hash: '', state }).pathname, '/classpilot/students');
  const bells = ADMIN_NAVIGATION.flatMap(group => group.items).find(item => item.id === 'bells');
  const target = adminNavigationTarget(bells, legacy);
  assert.equal(target.search, '?section=bells&month=2027-02'); assert.equal(target.hash, '#preview'); assert.equal(target.state, state);
});

test('every approved Admin tool is reachable through an expanded group and a registered App route', async () => {
  const appSource = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  const appPaths = new Set([...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1]));
  const { page, errors } = await open({ mode: 'overview', route: '/classpilot/admin' });
  try {
    const nav = page.getByRole('navigation', { name: 'Admin navigation', exact: true });
    await nav.waitFor();
    assert.deepEqual(ADMIN_NAVIGATION.map(group => group.label), ['Overview', 'People & classes', 'Calendar & schedules', 'Discipline logs', 'School operations', 'Reports', 'Settings']);
    for (const group of ADMIN_NAVIGATION) {
      if (group.items.length > 1) await nav.getByRole('button', { name: group.label, exact: true }).click();
      for (const item of group.items) {
        const link = nav.getByRole('link', { name: item.label, exact: true });
        assert.equal(await link.isVisible(), true, `${item.label} must remain discoverable`);
        assert.equal(await link.getAttribute('href'), item.to);
        const target = new URL(item.to, base);
        assert.equal(appPaths.has(target.pathname), true, `${item.label} must have an App route`);
        assert.equal(adminRoute(target)?.id, item.id, `${item.label} must select the matching shell page`);
      }
    }
    assert.equal(adminRoute(new URL('/classpilot/my-desk/student-information/student-a', base)), null);
    assert.equal(adminRoute(new URL('/classpilot/my-desk/imports/import-a', base)), null);
    assert.equal(adminRoute(new URL('/classpilot/students/student-a/profile', base))?.id, 'students');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('actual Overview fetches only school-year readiness and renders desktop/mobile shell', async () => {
  const { page, errors, requests } = await open({ mode: 'overview', route: '/classpilot/admin' });
  try {
    await page.getByText('Current school year', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Overview');
    assert.deepEqual(requests, ['/api/classpilot/admin/scheduling']);
    const nav = page.getByRole('navigation', { name: 'Admin navigation', exact: true });
    await nav.getByRole('button', { name: 'School operations' }).click();
    assert.equal(await nav.getByRole('link', { name: 'Email monitoring' }).isVisible(), true, 'An entitled school can discover setup before enabling monitoring');
    await nav.getByRole('button', { name: 'School operations' }).click();
    await page.screenshot({ path: path.join(artifacts, 'overview-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'overview-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Admin menu' }).click();
    const dialog = page.getByRole('dialog', { name: 'Admin Panel' });
    await dialog.getByRole('button', { name: 'Calendar & schedules' }).click();
    await page.screenshot({ path: path.join(artifacts, 'admin-mobile-menu.png'), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Admin menu' }).evaluate(element => element === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Overview distinguishes missing school-year dates from a failed read', async () => {
  for (const year of ['missing', 'error']) {
    const { page, errors } = await open({ mode: 'overview', route: '/classpilot/admin', year });
    try {
      await page.getByText(year === 'missing' ? 'School year needs dates' : 'School-year dates could not be loaded. This does not mean they are missing.', { exact: true }).waitFor();
      assert.equal(await page.getByText(year === 'missing' ? 'School-year dates could not be loaded. This does not mean they are missing.' : 'School year needs dates', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('legacy URL redirects and section links preserve history state and mounted drafts', async () => {
  const { page, errors } = await open({ route: '/classpilot/admin/classes/scheduling?section=school-year&month=2027-02#preview' });
  try {
    await page.getByLabel('Draft').fill('Keep the year draft');
    await page.getByRole('navigation', { name: 'Admin navigation', exact: true }).getByRole('link', { name: 'Bells & rotation' }).click();
    await page.waitForFunction(() => window.__route.search.includes('section=bells'));
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'Keep the year draft');
    const result = await page.evaluate(() => window.__route);
    assert.equal(result.pathname, '/classpilot/admin/scheduling'); assert.equal(result.search, '?section=bells&month=2027-02'); assert.equal(result.hash, '#preview'); assert.deepEqual(result.state, { marker: 'initial' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('anchor and button exits share discard confirmation, retaining original Link state', async () => {
  const { page, errors } = await open();
  try {
    await page.getByLabel('Draft').fill('Unsaved');
    await page.getByRole('button', { name: 'Guarded return' }).click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await page.getByLabel('Draft').inputValue(), 'Unsaved');
    await page.getByRole('link', { name: 'Local return with state' }).click();
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.getByRole('heading', { name: 'Destination' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__route.state), { marker: 'link-state' });
    assert.equal(await page.evaluate(() => window.__discards), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('busy state and asynchronous discard veto keep the editor and settle the request', async () => {
  const { page, errors } = await open();
  try {
    await page.getByLabel('Draft').fill('Unsaved');
    await page.evaluate(() => window.fixtureBusy(true));
    await page.getByRole('button', { name: 'Guarded return' }).click();
    await page.getByText('Wait for the current operation to finish before leaving.').waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.evaluate(() => { window.fixtureBusy(false); window.__veto = true; });
    await page.waitForFunction(() => document.querySelector('[data-testid="fixture-editor"]')?.dataset.busy === 'false');
    await page.getByLabel('Draft').fill('Unsaved');
    await page.evaluate(() => { void window.fixtureAction(); });
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.waitForFunction(() => window.__actionResult === false);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'Unsaved');
    assert.equal(await page.evaluate(() => window.__actions), 0);
    await page.evaluate(() => { window.__veto = false; window.__defer = true; void window.fixtureAction(); });
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.waitForFunction(() => Boolean(window.__resolveDiscard));
    assert.equal(await page.getByRole('button', { name: 'Leaving…' }).isDisabled(), true);
    await page.evaluate(() => window.__resolveDiscard());
    await page.waitForFunction(() => window.__actionResult === true);
    assert.equal(await page.evaluate(() => window.__actions), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('acknowledged-save navigation bypasses only its own stale guard', async () => {
  const { page, errors } = await open();
  try {
    await page.getByLabel('Draft').fill('Saved at the server');
    await page.evaluate(() => window.fixtureOther(true));
    await page.getByRole('button', { name: 'Save and leave' }).click();
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await page.evaluate(() => window.fixtureOther(false));
    await page.getByLabel('Draft').fill('Another saved value');
    await page.getByRole('button', { name: 'Save and leave' }).click();
    await page.getByRole('heading', { name: 'Destination' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__route.state), { marker: 'committed' });
    assert.equal(await page.evaluate(() => window.__discards), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Back restores the draft before confirmation and accepted traversal preserves Forward and state', async () => {
  const { page, errors } = await open({ route: '/classpilot/admin/classes' });
  try {
    await page.getByRole('link', { name: 'Open editor' }).click();
    await page.getByLabel('Draft').fill('History draft');
    await page.evaluate(() => history.back());
    await page.getByRole('alertdialog').waitFor();
    assert.equal(await page.getByLabel('Draft').inputValue(), 'History draft');
    assert.equal(new URL(page.url()).pathname, '/classpilot/admin/scheduling');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await page.evaluate(() => history.back());
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.getByRole('heading', { name: 'Destination' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__route.state), { marker: 'initial' });
    await page.evaluate(() => history.forward());
    await page.getByLabel('Draft').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__route.state), { marker: 'editor-link' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Classroom import keeps course selections and assignment edits on cancelled browser Back', async () => {
  const { page, errors } = await open({ mode: 'classes', route: '/classpilot/admin' });
  try {
    await page.getByLabel('Draft').waitFor();
    await page.evaluate(() => window.fixtureGuardedNavigate('/classpilot/admin/classes'));
    await page.getByRole('button', { name: 'Import Classroom', exact: true }).click();
    await page.getByRole('combobox', { name: 'Grade for Synthetic Biology' }).click();
    await page.getByRole('option', { name: 'Grade 9', exact: true }).click();
    await page.evaluate(() => history.back());
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.match(await page.getByRole('combobox', { name: 'Grade for Synthetic Biology' }).textContent(), /Grade 9/);
    await page.getByRole('checkbox', { name: 'Select Synthetic Biology' }).check();
    await page.evaluate(() => history.back());
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await page.getByRole('checkbox', { name: 'Select Synthetic Biology' }).isChecked(), true);
    await page.evaluate(() => history.back());
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.getByLabel('Draft').waitFor();
    await page.evaluate(() => history.forward());
    await page.getByRole('button', { name: 'Import Classroom', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: 'Select Synthetic Biology' }).isChecked(), false);
    assert.match(await page.getByRole('combobox', { name: 'Grade for Synthetic Biology' }).textContent(), /Keep existing or ungraded/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Classroom import blocks browser Back until the submitted import finishes', async () => {
  const { page, errors } = await open({ mode: 'classes', route: '/classpilot/admin' });
  let finishImport;
  try {
    await page.route('**/api/classpilot/admin/classes/classroom/import', async request => {
      await new Promise(resolve => { finishImport = resolve; });
      await request.fulfill({ json: { importedCourses: 1, updatedCourses: 0, totalImported: 2 } });
    });
    await page.getByLabel('Draft').waitFor();
    await page.evaluate(() => window.fixtureGuardedNavigate('/classpilot/admin/classes'));
    await page.getByRole('button', { name: 'Import Classroom', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Select Synthetic Biology' }).check();
    await page.getByRole('button', { name: 'Import 1 Course', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"] button svg.animate-spin'));
    await page.evaluate(() => history.back());
    await page.getByText('Wait for the current operation to finish before leaving.').waitFor();
    assert.equal(new URL(page.url()).pathname, '/classpilot/admin/classes');
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    finishImport();
    await page.getByRole('dialog', { name: 'Import from Google Classroom' }).waitFor({ state: 'hidden' });
    await page.evaluate(() => history.back());
    await page.getByLabel('Draft').waitFor();
    assert.deepEqual(errors, []);
  } finally { finishImport?.(); await page.close(); }
});

test('a queued committed-owner navigation is vetoed if that editor unmounts before approval', async () => {
  const { page, errors } = await open();
  try {
    await page.getByLabel('Draft').fill('A different editor still has work');
    await page.evaluate(() => window.fixtureChild(true));
    await page.waitForFunction(() => typeof window.committedChildNavigate === 'function');
    await page.evaluate(() => { void window.committedChildNavigate('/classpilot/admin/classes').then(result => window.__childResult = result); });
    await page.getByRole('alertdialog').waitFor();
    await page.evaluate(() => window.fixtureChild(false));
    await page.waitForFunction(() => document.querySelector('[data-testid="fixture-editor"]')?.dataset.child === 'false');
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.waitForFunction(() => window.__childResult === false);
    assert.equal(await page.getByRole('heading', { name: 'Destination' }).count(), 0);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'A different editor still has work');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('committed-owner unmount during asynchronous discard cancels its continuation', async () => {
  const { page, errors } = await open();
  try {
    await page.getByLabel('Draft').fill('Other draft');
    await page.evaluate(() => { window.fixtureChild(true); window.__defer = true; });
    await page.waitForFunction(() => typeof window.committedChildNavigate === 'function');
    await page.evaluate(() => { void window.committedChildNavigate('/classpilot/admin/classes').then(result => window.__childResult = result); });
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.waitForFunction(() => typeof window.__resolveDiscard === 'function');
    await page.evaluate(() => window.fixtureChild(false));
    await page.waitForFunction(() => document.querySelector('[data-testid="fixture-editor"]')?.dataset.child === 'false');
    await page.evaluate(() => window.__resolveDiscard());
    await page.waitForFunction(() => window.__childResult === false);
    assert.equal(await page.getByRole('heading', { name: 'Destination' }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('mobile menu links respect dirty confirmation and Escape keeps the draft', async () => {
  const { page, errors } = await open();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Draft').fill('Mobile draft');
    await page.getByRole('button', { name: 'Admin menu' }).click();
    const menu = page.getByRole('dialog', { name: 'Admin Panel' });
    await menu.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await menu.isVisible(), true);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Admin menu');
    assert.equal(await page.getByRole('button', { name: 'Admin menu' }).evaluate(element => element === document.activeElement), true);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'Mobile draft');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('identity/access changes clear drafts, cancel relevant cache work and retain unrelated queries', async () => {
  const { page, errors } = await open({ mode: 'identity' });
  try {
    await page.waitForFunction(() => window['resolve-school-a']);
    await page.evaluate(() => { window.queryClient.setQueryData(['unrelated-fixture'], 'retain'); window.fixtureIdentity('school-b'); });
    await page.waitForFunction(() => window['resolve-school-b']);
    assert.equal(await page.evaluate(() => window.__requests[0].aborted), true);
    await page.evaluate(() => { window['resolve-school-a'](); window['resolve-school-b'](); });
    await page.waitForFunction(() => document.querySelector('[aria-label="Legacy data"]')?.textContent === 'school-b');
    assert.equal(await page.evaluate(() => window.queryClient.getQueryData(['unrelated-fixture'])), 'retain');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
  const fixture = await open({ route: '/classpilot/discipline-records?entry=admin' });
  try {
    await fixture.page.getByLabel('Draft').fill('Private unfinished draft');
    await fixture.page.evaluate(() => { window.staleCommit = window.fixtureOldCommit; window.fixtureRole('teacher'); });
    await fixture.page.getByRole('heading', { name: 'Teacher workspace' }).waitFor();
    assert.equal(await fixture.page.getByTestId('classpilot-admin-shell').count(), 0);
    assert.equal(await fixture.page.getByLabel('Draft').inputValue(), '');
    assert.equal(await fixture.page.evaluate(() => window.staleCommit('/classpilot/admin/classes')), false);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.page.close(); }
});

test('nonadmin route lifetimes stay mounted while identity cache cleanup runs', async () => {
  const { page, errors } = await open({ role: 'teacher', route: '/classpilot/coverage' });
  try {
    await page.getByLabel('Draft').fill('A page with its own identity lifecycle');
    await page.evaluate(() => {
      window.queryClient.setQueryData(['/api/admin/teacher-students'], { school: 'old' });
      window.fixtureIdentity('school-b');
    });
    await page.waitForFunction(() => window.queryClient.getQueryData(['/api/admin/teacher-students']) === undefined);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'A page with its own identity lifecycle');
    assert.equal(await page.getByTestId('classpilot-admin-shell').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('admin origin does not add admin chrome to teacher flows and print/download remain native', async () => {
  const teacher = await open({ role: 'teacher', route: '/classpilot/discipline-records?entry=admin' });
  try { await teacher.page.getByRole('heading', { name: 'Teacher workspace' }).waitFor(); assert.equal(await teacher.page.getByTestId('classpilot-admin-shell').count(), 0); assert.deepEqual(teacher.errors, []); }
  finally { await teacher.page.close(); }
  const { page, errors } = await open();
  try {
    await page.getByLabel('Draft').fill('Keep on print');
    await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
    await page.getByRole('button', { name: 'Print fixture' }).click();
    assert.equal(await page.evaluate(() => window.__printed), true);
    const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download fixture' }).click(); await download;
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.getByRole('navigation', { name: 'Admin navigation', exact: true }).isVisible(), false);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'Keep on print');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
