import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import {
  activeFlightPathAllowedDomains,
  mergeTeachingResourceOptions,
  teachingResourceBadge,
  teachingResourceErrorMessage,
  teachingResourceList,
} from '../src/products/classpilot/lib/teachingResourceLibrary.js';
import { isStudentUrlOffTask } from '../src/products/classpilot/lib/dashboardCommandContext.js';

// School Library UI: the server decides what is shared, official, editable or
// copyable; the page renders only what the list responses carry, and nothing
// new appears while the library is off (no `features` key).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('School Library view models', () => {
  test('keep the previous list shape when the library is off', () => {
    const own = [{ id: 'fp-1', flightPathName: 'Research' }];
    const legacy = teachingResourceList({ flightPaths: own }, 'flightPaths');
    assert.equal(legacy.own, own);
    assert.deepEqual(legacy.library, []);
    assert.equal(legacy.libraryEnabled, false);
    // A library key without the features flag is ignored.
    assert.deepEqual(teachingResourceList({ flightPaths: own, library: [{ id: 'x' }] }, 'flightPaths').library, []);
    assert.equal(teachingResourceList(own, 'flightPaths').own, own);
    assert.deepEqual(teachingResourceList(undefined, 'blockLists'), { own: [], library: [], libraryEnabled: false });
    assert.equal(mergeTeachingResourceOptions({ flightPaths: own }, 'flightPaths'), own, 'no library means the same list');
  });

  test('merge School Library items after the teacher\'s own items with badges', () => {
    const data = {
      blockLists: [{ id: 'own', name: 'Mine', visibility: 'school', official: false }],
      library: [
        { id: 'own', name: 'Duplicate id' },
        { id: 'shared', name: 'Shared', visibility: 'school', official: false },
        { id: 'official', name: 'Official', visibility: 'private', official: true },
      ],
      features: { sharedTeachingResources: true },
    };
    const merged = mergeTeachingResourceOptions(data, 'blockLists');
    assert.deepEqual(merged.map((item) => item.id), ['own', 'shared', 'official']);
    assert.equal(merged[0].fromSchoolLibrary, undefined);
    assert.equal(merged[1].fromSchoolLibrary, true);
    assert.deepEqual(merged.map(teachingResourceBadge), ['Shared', 'Shared', 'Official']);
    assert.equal(teachingResourceBadge({ visibility: 'private', official: false }), null);
  });

  test('match the active Flight Path for the off-task hint without guessing between same-named items', () => {
    const own = { id: 'own', flightPathName: 'Research', allowedDomains: ['own.example.test'] };
    const shared = { id: 'shared', flightPathName: 'Research', allowedDomains: ['shared.example.test'], fromSchoolLibrary: true };
    const student = { flightPathActive: true, activeFlightPathName: 'Research', activeTabUrl: 'https://shared.example.test/page', aiClassification: { category: 'non-educational' } };

    // Library off: unchanged name matching among the teacher's own Flight Paths.
    assert.deepEqual(activeFlightPathAllowedDomains(student, [own]), ['own.example.test']);
    assert.equal(isStudentUrlOffTask({ student, flightPaths: [own] }), true);

    // Library on and names collide: the applied classroom-state domains win.
    const withState = { ...student, classroomState: { restrictions: { flightPath: { active: true, allowedDomains: ['shared.example.test'], name: 'Research' } } } };
    assert.deepEqual(activeFlightPathAllowedDomains(withState, [own, shared]), ['shared.example.test']);
    assert.equal(isStudentUrlOffTask({ student: withState, flightPaths: [own, shared] }), false);

    // Without classroom state an ambiguous name never borrows another item's domains.
    assert.deepEqual(activeFlightPathAllowedDomains(student, [own, shared]), []);
    assert.equal(isStudentUrlOffTask({ student, flightPaths: [own, shared] }), true);

    // A known Flight Path id matches exactly.
    assert.deepEqual(activeFlightPathAllowedDomains({ ...student, activeFlightPathId: 'shared' }, [own, shared]), ['shared.example.test']);
    // A unique name still resolves with the library on.
    assert.deepEqual(activeFlightPathAllowedDomains({ ...student, activeFlightPathName: 'Other' }, [own, { ...shared, flightPathName: 'Other' }]), ['shared.example.test']);
  });

  test('surface the server\'s explanation for refused actions', () => {
    assert.equal(teachingResourceErrorMessage({ response: { data: { error: 'Official Flight Paths are managed by administrators.' } }, message: 'Request failed with status code 403' }), 'Official Flight Paths are managed by administrators.');
    assert.equal(teachingResourceErrorMessage({ message: 'Network Error' }), 'Network Error');
  });
});

const authModule = `import{createContext,useContext}from'react';export const FixtureAuth=createContext(null);export const useAuth=()=>useContext(FixtureAuth);`;
const entry = `
import React from'react';import{createRoot}from'react-dom/client';
import{BrowserRouter,Routes,Route,useLocation}from'react-router-dom';
import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';
import{FixtureAuth}from'/src/contexts/AuthContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';
import{Toaster}from'/src/components/ui/toaster.jsx';
import TeachingToolsLayout from'/src/products/classpilot/components/TeachingToolsLayout.jsx';
import'/src/index.css';
// Match AppRoutes: the page loads lazily inside an outer Suspense boundary.
// A static import cannot expose layout-effect cleanup when that page suspends.
const MySettings=React.lazy(async()=>{await new Promise(resolve=>setTimeout(resolve,250));return import('/src/products/classpilot/pages/MySettings.jsx');});
const h=React.createElement,params=new URLSearchParams(location.search),role=params.get('role')||'teacher';
history.replaceState({idx:0,key:'initial'},'','/classpilot/my-settings');
function Location(){window.fixtureLocation=useLocation();return null;}
const value={user:{id:'teacher-a',firstName:'Taylor',lastName:'Woods'},activeSchoolId:'school-a',activeMembership:{schoolId:'school-a',schoolName:'Cedar Grove School',roles:[role],role,status:'active'},loading:false,logout:async()=>{}};
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(FixtureAuth.Provider,{value},h(Location),h(React.Suspense,{fallback:h('p',null,'Loading teaching page…')},h(Routes,null,h(Route,{element:h(TeachingToolsLayout)},h(Route,{path:'/classpilot/my-settings',element:h(MySettings)})))),h(Toaster))))));
`;

let vite;
let browser;
let base;

before(async () => {
  vite = await createServer({
    root, logLevel: 'error', cacheDir: `node_modules/.vite-teaching-library-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'teaching-library-fixture', enforce: 'pre',
      transform(_code, id) {
        if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null };
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/__teaching_library')) return next();
          res.setHeader('content-type', 'text/html');
          res.end(await server.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
        });
      },
    }],
  });
  await vite.listen();
  base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => { await browser?.close(); await vite?.close(); });

function flightPaths(role) {
  const admin = role === 'admin';
  return {
    flightPaths: [
      { id: 'own-private', schoolId: 'school-a', teacherId: 'teacher-a', flightPathName: 'Research destinations', description: null, allowedDomains: ['science.example.test'], blockedDomains: [], isDefault: false, visibility: 'private', official: false, publishedAt: null, canEdit: true, canShare: true, canMarkOfficial: admin },
      { id: 'own-official', schoolId: 'school-a', teacherId: 'teacher-a', flightPathName: 'Official research', description: null, allowedDomains: ['official.example.test'], blockedDomains: [], isDefault: false, visibility: 'school', official: true, publishedAt: '2026-09-20T12:00:00.000Z', canEdit: admin, canShare: admin, canMarkOfficial: admin },
    ],
    library: [
      { id: 'lib-shared', flightPathName: 'Shared lab sites', description: 'From the science team', allowedDomains: ['lab.example.test'], blockedDomains: [], visibility: 'school', official: false, publishedAt: '2026-09-21T12:00:00.000Z', createdAt: '2026-09-01T12:00:00.000Z', ownerName: 'Morgan Reed', canEdit: admin, canShare: false, canMarkOfficial: admin },
      { id: 'lib-official', flightPathName: 'District reading', description: null, allowedDomains: ['reading.example.test'], blockedDomains: [], visibility: 'private', official: true, publishedAt: '2026-09-22T12:00:00.000Z', createdAt: '2026-09-01T12:00:00.000Z', ownerName: null, canEdit: admin, canShare: false, canMarkOfficial: admin },
    ],
    features: { sharedTeachingResources: true },
  };
}

function blockLists(role) {
  const admin = role === 'admin';
  return {
    blockLists: [
      { id: 'own-list', schoolId: 'school-a', teacherId: 'teacher-a', name: 'Independent work', description: null, blockedDomains: ['games.example.test'], isDefault: false, visibility: 'private', official: false, publishedAt: null, canEdit: true, canShare: true, canMarkOfficial: admin },
    ],
    library: [
      { id: 'lib-list', name: 'Testing week', description: null, blockedDomains: ['video.example.test'], visibility: 'school', official: false, publishedAt: '2026-09-21T12:00:00.000Z', createdAt: '2026-09-01T12:00:00.000Z', ownerName: 'Morgan Reed', canEdit: admin, canShare: false, canMarkOfficial: admin },
    ],
    features: { sharedTeachingResources: true },
  };
}

async function open({ role = 'teacher', library = true, empty = false, precise = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const state = { requests: [], errors: [], refuseNext: null };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.method() === 'GET' ? null : req.postDataJSON();
    state.requests.push({ method: req.method(), path: url.pathname, schoolId: req.headers()['x-school-id'], body });
    if (req.method() === 'POST' && state.refuseNext) {
      const refusal = state.refuseNext; state.refuseNext = null;
      return route.fulfill({ status: refusal.status, json: { error: refusal.error, code: refusal.code } });
    }
    if (url.pathname === '/api/flight-paths') {
      if (empty) return route.fulfill({ json: { flightPaths: [], library: [], features: { sharedTeachingResources: library, preciseRestrictionResources: precise } } });
      return route.fulfill({ json: library ? flightPaths(role) : { flightPaths: [{ id: 'own-private', flightPathName: 'Research destinations', allowedDomains: ['science.example.test'] }] } });
    }
    if (url.pathname === '/api/block-lists') {
      if (empty) return route.fulfill({ json: { blockLists: [], library: [], features: { sharedTeachingResources: library } } });
      return route.fulfill({ json: library ? blockLists(role) : { blockLists: [{ id: 'own-list', name: 'Independent work', blockedDomains: ['games.example.test'] }] } });
    }
    if (/^\/api\/(flight-paths|block-lists)\/[^/]+\/(visibility|official|copy)$/.test(url.pathname)) {
      const key = url.pathname.startsWith('/api/flight-paths') ? 'flightPath' : 'blockList';
      return route.fulfill({ status: url.pathname.endsWith('/copy') ? 201 : 200, json: { [key]: { id: 'result' } } });
    }
    if (url.pathname.endsWith('/teacher/groups')) return route.fulfill({ json: { groups: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/__teaching_library?${new URLSearchParams({ role })}`);
  await page.waitForFunction(() => window.fixtureLocation);
  if (empty) await page.getByTestId('card-flight-paths').waitFor();
  else await page.getByText('Research destinations', { exact: true }).waitFor();
  return { page, state };
}

const posts = (state) => state.requests.filter((row) => row.method !== 'GET');
const gets = (state, pathname) => state.requests.filter((row) => row.method === 'GET' && row.path === pathname).length;

describe('Teaching tools School Library', { concurrency: false }, () => {
  test('keeps the School Library after lazy loading for an administrator with empty lists and precise resources', async () => {
    const { page, state } = await open({ role: 'admin', empty: true, precise: true });
    try {
      await page.getByTestId('card-school-library').waitFor({ timeout: 5_000 });
      assert.equal(await page.getByText('No shared Flight Paths yet.', { exact: true }).count(), 1);
      assert.equal(await page.getByText('No shared Block Lists yet.', { exact: true }).count(), 1);
      assert.ok(gets(state, '/api/flight-paths') > 0);
      assert.ok(gets(state, '/api/block-lists') > 0);
      assert.deepEqual(posts(state), []);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  test('shows the School Library, badges, owner sharing and copies for a teacher, and posts only scoped library actions', async () => {
    const { page, state } = await open();
    try {
      const library = page.getByTestId('card-school-library');
      await library.waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'Teaching tools sections' }).getByRole('link').count(), 3, 'no new Teaching tools tab');
      for (const id of ['lib-shared', 'lib-official']) assert.equal(await page.getByTestId(`library-flight-path-${id}`).count(), 1);
      assert.equal(await page.getByTestId('library-block-list-lib-list').count(), 1);
      assert.equal(await page.getByTestId('badge-shared-lib-shared').innerText(), 'Shared');
      assert.equal(await page.getByTestId('badge-official-lib-official').innerText(), 'Official');
      assert.equal(await page.getByTestId('badge-official-own-official').innerText(), 'Official');
      assert.equal(await page.getByTestId('badge-shared-lib-list').innerText(), 'Shared');
      assert.equal(await page.getByTestId('badge-shared-own-private').count(), 0);
      assert.equal(await library.getByText('From Morgan Reed').count(), 2);
      assert.equal(await page.locator('[data-testid^="button-official-"]').count(), 0, 'teachers never see official controls');

      // Official items stay administrator-managed.
      assert.equal(await page.getByTestId('button-edit-flight-path-own-official').isDisabled(), true);
      assert.equal(await page.getByTestId('button-delete-flight-path-own-official').isDisabled(), true);
      assert.equal(await page.getByTestId('button-share-flight-path-own-official').count(), 0);
      assert.equal(await page.getByTestId('button-edit-flight-path-own-private').isDisabled(), false);

      const share = page.getByTestId('button-share-flight-path-own-private');
      assert.equal(await share.innerText(), 'Share with school');
      const listsBefore = gets(state, '/api/flight-paths');
      await share.click();
      await page.getByText('Flight Path shared', { exact: true }).waitFor();
      await page.getByTestId('button-copy-flight-path-lib-shared').click();
      await page.getByText('Flight Path copied', { exact: true }).waitFor();
      await page.getByTestId('button-share-block-list-own-list').click();
      await page.getByText('Block List shared', { exact: true }).waitFor();
      await page.getByTestId('button-copy-block-list-lib-list').click();
      await page.getByText('Block List copied', { exact: true }).waitFor();
      assert.deepEqual(posts(state).map(({ path: pathname, body, schoolId }) => ({ pathname, body, schoolId })), [
        { pathname: '/api/flight-paths/own-private/visibility', body: { visibility: 'school' }, schoolId: 'school-a' },
        { pathname: '/api/flight-paths/lib-shared/copy', body: {}, schoolId: 'school-a' },
        { pathname: '/api/block-lists/own-list/visibility', body: { visibility: 'school' }, schoolId: 'school-a' },
        { pathname: '/api/block-lists/lib-list/copy', body: {}, schoolId: 'school-a' },
      ]);
      assert.ok(gets(state, '/api/flight-paths') > listsBefore, 'library actions refresh the lists');

      // A refusal shows the server's explanation instead of a generic status.
      state.refuseNext = { status: 403, error: 'Only teaching staff can copy items into their own Teaching tools', code: 'CLASS_TEACHER_NOT_FOUND' };
      await page.getByTestId('button-copy-flight-path-lib-official').click();
      await page.getByText('Only teaching staff can copy items into their own Teaching tools', { exact: true }).waitFor();

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  test('offers official marking to administrators on shared items', async () => {
    const { page, state } = await open({ role: 'admin' });
    try {
      await page.getByTestId('card-school-library').waitFor();
      const mark = page.getByTestId('button-official-flight-path-lib-shared');
      assert.equal(await mark.innerText(), 'Mark official');
      assert.equal(await page.getByTestId('button-official-flight-path-lib-official').innerText(), 'Remove official');
      assert.equal(await page.getByTestId('button-edit-flight-path-own-official').isDisabled(), false);
      await mark.click();
      await page.getByText('Flight Path marked official', { exact: true }).waitFor();
      await page.getByTestId('button-official-block-list-lib-list').click();
      await page.getByText('Block List marked official', { exact: true }).waitFor();
      assert.deepEqual(posts(state).map(({ path: pathname, body }) => ({ pathname, body })), [
        { pathname: '/api/flight-paths/lib-shared/official', body: { official: true } },
        { pathname: '/api/block-lists/lib-list/official', body: { official: true } },
      ]);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });

  test('renders exactly today\'s Website tools while the library is off', async () => {
    const { page, state } = await open({ library: false });
    try {
      await page.getByText('Independent work', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('card-school-library').count(), 0);
      assert.equal(await page.locator('[data-testid^="badge-shared-"], [data-testid^="badge-official-"]').count(), 0);
      assert.equal(await page.locator('[data-testid^="button-share-"], [data-testid^="button-official-"], [data-testid^="button-copy-"]').count(), 0);
      assert.equal(await page.getByTestId('button-edit-flight-path-own-private').isDisabled(), false);
      assert.equal(await page.getByTestId('button-delete-block-list-own-list').isDisabled(), false);
      assert.deepEqual(posts(state), []);
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
});
