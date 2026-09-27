import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { teacherTabLimitSeed, teachingToolsQuery } from '../src/products/classpilot/lib/teachingTools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.resolve(root, '../docs/images/settings-organization');
let vite, browser, base;
const authModule = `import{createContext,useContext}from'react';export const FixtureAuth=createContext(null);export const useAuth=()=>useContext(FixtureAuth);`;
const entry = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{BrowserRouter,Routes,Route,Link,useLocation}from'react-router-dom';
import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';
import{FixtureAuth}from'/src/contexts/AuthContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';
import TeachingToolsLayout from'/src/products/classpilot/components/TeachingToolsLayout.jsx';
import MySettings from'/src/products/classpilot/pages/MySettings.jsx';import{useRosterGradeSettings}from'/src/products/classpilot/hooks/useRosterGradeSettings.js';import'/src/index.css';
const h=React.createElement,params=new URLSearchParams(location.search);
history.replaceState({idx:0,key:'initial',usr:{marker:'preserved'}},'',params.get('route')||'/classpilot/my-settings');
window.queryClient=queryClient;
function Location(){const route=useLocation();window.fixtureLocation=route;return null;}
function Grades({school,viewer,role}){const[draft,setDraft]=useState(''),[message,setMessage]=useState('');const[enabled,setEnabled]=useState(true);window.fixtureGradesEnabled=setEnabled;
const{query,mutation}=useRosterGradeSettings({schoolId:school,viewerId:viewer,enabled,canWrite:['admin','school_admin'].includes(role),onSaved:()=>{setDraft('');setMessage('Grade saved');},onError:setMessage});
return h('section',null,h('h1',null,'Grade fixture'),h('output',{'data-testid':'grade-scope'},school+':'+role+':'+enabled),h('output',{'data-testid':'grade-list'},(query.data?.gradeLevels||[]).join(',')),h('input',{'aria-label':'New grade',value:draft,onChange:event=>setDraft(event.target.value)}),h('button',{disabled:!query.data||query.isFetching||mutation.isPending,onClick:()=>mutation.mutate([...(query.data?.gradeLevels||[]),draft])},'Save grade'),h('p',{role:'status'},message));}
function Harness(){const[school,setSchool]=useState('school-a'),[viewer,setViewer]=useState('teacher-a'),[role,setRole]=useState(params.get('role')||'teacher');
window.fixtureSchool=setSchool;window.fixtureViewer=setViewer;window.fixtureRole=setRole;
const value={user:{id:viewer,firstName:'Taylor',lastName:'Woods'},activeSchoolId:school,activeMembership:{schoolId:school,schoolName:'Cedar Grove School',roles:[role],role,status:'active'},loading:false,logout:async()=>{window.fixtureLoggedOut=true;}};
return h(FixtureAuth.Provider,{value},h(Location),h(Routes,null,h(Route,{path:'/grades',element:h(Grades,{school,viewer,role})}),h(Route,{element:h(TeachingToolsLayout)},h(Route,{path:'/classpilot/my-settings',element:h(MySettings)}),h(Route,{path:'/classpilot/my-settings/guide',element:h('h1',null,'Teacher guide')})),h(Route,{path:'/classpilot',element:h('section',null,h('h1',null,'Teacher Dashboard'),h(Link,{to:'/classpilot/my-settings?section=defaults'},'Teaching tools'))})));}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(Harness)))));
`;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-teaching-tools-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'teaching-tools-fixture', enforce: 'pre', transform(_code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null };
    }, configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__teaching_tools')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
    }); } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

async function open({ route = '/classpilot/my-settings', role = 'teacher' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const state = { requests: [], errors: [], preference: { revision: 0, maxTabsPerStudent: null, schoolMaxTabsPerStudent: 6, effectiveMaxTabsPerStudent: 6 }, conflict: null, holdSave: false, releaseSave: null, groupsRevoked: false, holdClassSave: false, gradeVersion: "grades-v1", gradeLevels: ["5"] };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), schoolId = req.headers()['x-school-id'];
    const body = req.method() === 'GET' ? null : req.postDataJSON();
    state.requests.push({ method: req.method(), path: url.pathname, search: url.search, schoolId, body });
    if (url.pathname.endsWith('/teacher/preferences')) {
      if (req.method() === 'PATCH') {
        if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
        if (state.conflict) { const current = state.conflict; state.conflict = null; return route.fulfill({ status: 409, json: { code: 'CLASSPILOT_PREFERENCES_CONFLICT', current } }); }
        const saved = { schoolId, revision: body.expectedRevision + 1, maxTabsPerStudent: body.maxTabsPerStudent, schoolMaxTabsPerStudent: 6, effectiveMaxTabsPerStudent: body.maxTabsPerStudent ?? 6 };
        if (schoolId === 'school-a') state.preference = saved;
        return route.fulfill({ json: saved });
      }
      return route.fulfill({ json: schoolId === 'school-b' ? { schoolId, revision: 0, maxTabsPerStudent: null, schoolMaxTabsPerStudent: 3, effectiveMaxTabsPerStudent: 3 } : { schoolId, ...state.preference } });
    }
    if (url.pathname.endsWith('/admin/settings')) return route.fulfill({ json: { schoolId, sections: { rosterGrades: { version: state.gradeVersion, gradeLevels: state.gradeLevels } }, schoolName: 'Cedar Grove' } });
    if (url.pathname.endsWith('/admin/settings/rosterGrades')) {
      if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
      if (state.gradeConflict) { state.gradeConflict = false; state.gradeVersion = 'grades-v2'; state.gradeLevels = ['5','6']; return route.fulfill({ status: 409, json: { code: 'CLASSPILOT_SETTINGS_CONFLICT', current: { version: state.gradeVersion, gradeLevels: state.gradeLevels } } }); }
      state.gradeVersion = 'grades-v3'; state.gradeLevels = body.gradeLevels;
      return route.fulfill({ json: { schoolId, version: state.gradeVersion, gradeLevels: state.gradeLevels } });
    }
    if (url.pathname.endsWith('/flight-paths')) return route.fulfill({ json: { flightPaths: [{ id: 'flight-a', flightPathName: 'Research destinations', allowedDomains: ['science.example.test'] }] } });
    if (url.pathname.endsWith('/block-lists')) return route.fulfill({ json: { blockLists: [{ id: 'block-a', name: 'Independent work', blockedDomains: ['games.example.test'] }] } });
    if (url.pathname.endsWith('/teacher/groups')) return route.fulfill({ json: { groups: [...(state.groupsRevoked ? [] : [{ id: 'own-a', name: 'My Science', teacherId: 'teacher-a', groupType: 'teacher_group' }]), { id: 'official-a', name: 'Official Biology', teacherId: 'teacher-a', groupType: 'admin_class' }] } });
    if (url.pathname.endsWith('/subgroups')) { if (req.method() === 'POST' && state.holdClassSave) await new Promise(resolve => { state.releaseClassSave = resolve; }); return route.fulfill({ json: { subgroups: [] } }); }
    if (url.pathname.endsWith('/students')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/users/teachers')) return route.fulfill({ json: { teachers: [{ userId: 'teacher-b', role: 'teacher', user: { firstName: 'Morgan', lastName: 'Reed' } }] } });
    if (url.pathname.endsWith('/teachers')) return route.fulfill({ json: { teachers: [] } });
    if (url.pathname.endsWith('/classroom/courses')) return route.fulfill({ json: { courses: [{ id: 'course-a', name: 'Biology resources' }] } });
    if (url.pathname.endsWith('/resources')) return route.fulfill({ json: { resources: [{ id: 'resource-a', title: 'Plant cells', resourceType: 'material', links: [{ url: 'https://science.example.test/cells' }] }] } });
    if (url.pathname.endsWith('/from-classroom')) return route.fulfill({ json: { flightPath: { id: 'from-classroom-a' } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/__teaching_tools?${new URLSearchParams({ route, role })}`);
  await page.waitForFunction(() => window.fixtureLocation);
  return { page, state };
}
async function custom(page, value) {
  await page.getByRole('radio', { name: 'Custom limit', exact: true }).check();
  await page.getByTestId('input-max-tabs').fill(value);
}
const writes = state => state.requests.filter(row => row.method !== 'GET');

test('Teaching tools keeps section drafts, saves scoped inherited preferences without commands, and renders both sizes', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?keep=original#tools' });
  try {
    await page.getByText('Research destinations', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('classpilot-admin-shell').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Teaching tools', exact: true }).count(), 1);
    assert.equal(await page.getByRole('navigation', { name: 'Teaching tools sections' }).getByRole('link').count(), 3);
    await page.getByRole('button', { name: 'Back to ClassPilot', exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'teaching-tools-websites-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('link', { name: 'Classroom defaults', exact: true }).click();
    await custom(page, '9');
    await page.getByRole('link', { name: 'Website tools', exact: true }).click();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    await page.getByRole('link', { name: 'Classroom defaults', exact: true }).click();
    assert.equal(await page.getByTestId('input-max-tabs').inputValue(), '9');
    assert.equal(new URL(page.url()).searchParams.get('keep'), 'original');
    assert.equal(new URL(page.url()).hash, '#tools');
    assert.deepEqual(await page.evaluate(() => window.fixtureLocation.state), { marker: 'preserved' });
    await page.getByRole('button', { name: 'Save classroom defaults', exact: true }).click();
    await page.getByText('Personal default saved.', { exact: false }).waitFor();
    assert.deepEqual(writes(state).map(row => row.body), [{ expectedRevision: 0, maxTabsPerStudent: 9 }]);
    await page.getByRole('radio', { name: 'Use school default', exact: true }).check();
    await page.getByRole('button', { name: 'Save classroom defaults', exact: true }).click();
    await page.getByText('Personal default saved.', { exact: false }).waitFor();
    assert.deepEqual(writes(state).at(-1).body, { expectedRevision: 1, maxTabsPerStudent: null });
    assert(writes(state).every(row => row.path === '/api/classpilot/teacher/preferences' && row.schoolId === 'school-a'));
    await page.screenshot({ path: path.join(artifacts, 'teaching-tools-defaults-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'teaching-tools-defaults-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('link', { name: 'Website tools', exact: true }).click();
    await page.getByText('Research destinations', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'teaching-tools-websites-mobile.png'), fullPage: true, animations: 'disabled' });
    assert(!state.requests.some(row => row.path.includes('/teacher/settings')));
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('preference conflicts preserve and compare the draft until an explicit new baseline is accepted', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=defaults' });
  try {
    await custom(page, '9');
    state.conflict = { schoolId: 'school-a', revision: 3, maxTabsPerStudent: 12, schoolMaxTabsPerStudent: 6, effectiveMaxTabsPerStudent: 12 };
    await page.getByRole('button', { name: 'Save classroom defaults', exact: true }).click();
    await page.getByText('Your draft: 9 tabs. Latest saved: 12 tabs.').waitFor();
    assert.equal(await page.getByTestId('input-max-tabs').inputValue(), '9');
    await page.getByRole('button', { name: 'Keep my draft with latest version' }).click();
    await page.getByRole('button', { name: 'Save classroom defaults', exact: true }).click();
    await page.getByText('Personal default saved.', { exact: false }).waitFor();
    assert.deepEqual(writes(state).at(-1).body, { expectedRevision: 3, maxTabsPerStudent: 9 });
    await custom(page, '101');
    assert.equal(await page.getByRole('button', { name: 'Save classroom defaults' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByTestId('input-max-tabs').inputValue(), '9');
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('browser Back and logout protect a draft, and busy saves cannot lose edits or reuse a new identity', async () => {
  const { page, state } = await open({ route: '/classpilot' });
  try {
    await page.getByRole('link', { name: 'Teaching tools' }).click();
    await custom(page, '8');
    await page.evaluate(() => history.back());
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await page.getByTestId('input-max-tabs').inputValue(), '8');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await page.evaluate(() => Boolean(window.fixtureLoggedOut)), false);
    state.holdSave = true;
    await page.getByRole('button', { name: 'Save classroom defaults' }).click();
    await page.getByRole('button', { name: 'Saving…' }).waitFor();
    assert.equal(await page.getByTestId('input-max-tabs').isDisabled(), true);
    await page.evaluate(() => history.back());
    await page.getByText('Wait for the current operation to finish before leaving.').waitFor();
    await page.evaluate(() => window.fixtureSchool('school-b'));
    await page.getByText('school default: 3 tabs', { exact: false }).waitFor();
    state.releaseSave();
    await page.waitForFunction(() => window.queryClient.getMutationCache().getAll().every(mutation => mutation.state.status !== 'pending'));
    assert.equal(await page.getByRole('radio', { name: 'Use school default', exact: true }).isChecked(), true);
    assert.equal(await page.getByText('Personal default saved.', { exact: false }).count(), 0);
    assert.equal(writes(state)[0].schoolId, 'school-a');
    assert.deepEqual(state.errors, []);
  } finally { state.releaseSave?.(); await page.close(); }
});

test('class tools use one selection, confirm unfinished co-teacher changes and preserve official restrictions', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=classes' });
  try {
    const selector = page.getByTestId('select-teaching-class');
    await selector.click(); await page.getByRole('option', { name: 'My Science', exact: true }).click();
    assert.equal(await page.getByTestId('select-co-teacher-class').count(), 0);
    await page.getByTestId('select-co-teacher-to-add').click(); await page.getByRole('option', { name: 'Morgan Reed' }).click();
    await selector.click(); await page.getByRole('option', { name: 'Official Biology', exact: true }).click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.match(await selector.textContent(), /My Science/);
    await selector.click(); await page.getByRole('option', { name: 'Official Biology', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.getByText('Co-teachers for official or shared classes are managed', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('select-co-teacher-to-add').count(), 0);
    assert.equal(writes(state).length, 0);
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('website dialog close keeps edits until confirmed and Classroom import uses only personal resource authority', async () => {
  const { page, state } = await open();
  try {
    await page.getByTestId('button-create-flight-path').click();
    await page.getByTestId('input-flight-path-name').fill('An unsaved path');
    await page.getByTestId('button-cancel-flight-path').click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await page.getByTestId('input-flight-path-name').inputValue(), 'An unsaved path');
    await page.getByTestId('button-cancel-flight-path').click();
    await page.getByRole('button', { name: 'Discard changes and leave' }).click();
    await page.getByTestId('button-import-classroom-flight-path').click();
    await page.getByLabel('Course', { exact: true }).selectOption('course-a');
    await page.getByRole('checkbox', { name: 'Plant cells', exact: false }).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Create Flight Path', exact: true }).click();
    await page.getByText('Flight Path created.', { exact: false }).waitFor();
    const write = writes(state).at(-1);
    assert.equal(write.path, '/api/flight-paths/from-classroom');
    assert.equal(write.schoolId, 'school-a');
    assert.deepEqual(write.body.selectedResourceIds, ['resource-a']);
    assert(state.requests.some(row => row.path === '/api/classroom/courses' && row.search === '?purpose=classroom_resources'));
    assert(!state.requests.some(row => /roster-connector|workspace_import/.test(row.path + row.search)));
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('legacy class links validate access, preserve context, and remove a revoked class draft and late callback', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?tab=subgroups&groupId=own-a&keep=legacy#class' });
  try {
    const selector = page.getByTestId('select-teaching-class');
    await page.getByTestId('button-create-subgroup').waitFor();
    assert.match(await selector.textContent(), /My Science/);
    await page.getByRole('link', { name: 'Classroom defaults', exact: true }).click();
    await page.getByRole('link', { name: 'Class setup', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('groupId'), 'own-a');
    await page.getByTestId('button-create-subgroup').click();
    await page.getByTestId('input-subgroup-name').fill('Unsaved subgroup');
    state.holdClassSave = true;
    await page.getByTestId('button-save-subgroup').click();
    await page.waitForFunction(() => window.queryClient.getMutationCache().getAll().some(mutation => mutation.state.status === 'pending'));
    state.groupsRevoked = true;
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'] }));
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.match(await selector.textContent(), /Select a class/);
    assert.equal(await page.getByTestId('button-create-subgroup').count(), 0);
    await selector.click(); await page.getByRole('option', { name: 'Official Biology' }).click();
    await page.getByText('Wait for the current operation to finish before leaving.').waitFor();
    state.releaseClassSave();
    await page.waitForFunction(() => window.queryClient.getMutationCache().getAll().every(mutation => mutation.state.status !== 'pending'));
    await selector.click(); await page.getByRole('option', { name: 'Official Biology' }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('classId') === 'official-a');
    assert.equal(new URL(page.url()).searchParams.get('groupId'), null);
    assert.equal(new URL(page.url()).searchParams.get('keep'), 'legacy');
    assert.equal(new URL(page.url()).hash, '#class');
    assert.deepEqual(await page.evaluate(() => window.fixtureLocation.state), { marker: 'preserved' });
    assert.equal(await page.evaluate(() => window.queryClient.getQueryCache().getAll().some(query => query.queryKey[0] === '/api/groups' && query.queryKey[1] === 'own-a')), false);
    assert.deepEqual(state.errors, []);
  } finally { state.releaseClassSave?.(); await page.close(); }
});

test('invalid class IDs never request class data and school/viewer/role transitions clear only scoped tool caches', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=classes&classId=unavailable' });
  try {
    await page.getByTestId('select-teaching-class').waitFor();
    assert.match(await page.getByTestId('select-teaching-class').textContent(), /Select a class/);
    assert(!state.requests.some(row => row.path.includes('/groups/unavailable/')));
    await page.evaluate(() => { window.queryClient.setQueryData(['unrelated-product'], { retained: true }); window.fixtureSchool('school-b'); });
    await page.waitForFunction(() => window.queryClient.getQueryData(['/api/teacher/groups','school-b','teacher-a']));
    assert.equal(await page.evaluate(() => window.queryClient.getQueryCache().getAll().some(query => query.queryKey.at(-2) === 'school-a' && query.queryKey.at(-1) === 'teacher-a')), false);
    await page.evaluate(() => window.fixtureViewer('teacher-b'));
    await page.waitForFunction(() => window.queryClient.getQueryData(['/api/teacher/groups','school-b','teacher-b']));
    assert.equal(await page.evaluate(() => window.queryClient.getQueryCache().getAll().some(query => query.queryKey.at(-1) === 'teacher-a')), false);
    await page.evaluate(() => window.fixtureRole('staff'));
    await page.getByText('Sign in with an active school teaching account', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.queryClient.getQueryCache().getAll().some(query => query.queryKey[0] === '/api/teacher/groups')), false);
    assert.deepEqual(await page.evaluate(() => window.queryClient.getQueryData(['unrelated-product'])), { retained: true });
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('roster grade writer sends only its versioned section and preserves drafts on conflict', async () => {
  const { page, state } = await open({ route: '/grades', role: 'school_admin' });
  try {
    await page.getByTestId('grade-list').getByText('5', { exact: true }).waitFor();
    await page.getByLabel('New grade').fill('7'); state.gradeConflict = true;
    await page.getByRole('button', { name: 'Save grade' }).click();
    await page.getByText('The grade list changed elsewhere.', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('New grade').inputValue(), '7');
    assert.deepEqual(writes(state)[0].body, { expectedVersion: 'grades-v1', gradeLevels: ['5','7'] });
    await page.getByRole('button', { name: 'Save grade' }).click();
    await page.getByText('Grade saved', { exact: true }).waitFor();
    assert.deepEqual(writes(state).at(-1).body, { expectedVersion: 'grades-v2', gradeLevels: ['5','6','7'] });
    assert(writes(state).every(row => row.path === '/api/classpilot/admin/settings/rosterGrades' && row.schoolId === 'school-a'));
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('grade callbacks cannot cross A→B→A, dialog close or write-authority loss', async () => {
  for (const transition of ['school-roundtrip','closed','role']) {
    const { page, state } = await open({ route: '/grades', role: 'school_admin' });
    try {
      await page.getByLabel('New grade').fill('7');
      await page.getByRole('button', { name: 'Save grade' }).waitFor({ state: 'visible' });
      state.holdSave = true;
      await page.getByRole('button', { name: 'Save grade' }).click();
      await page.waitForFunction(() => window.queryClient.getMutationCache().getAll().some(mutation => mutation.state.status === 'pending'));
      if (transition === 'school-roundtrip') {
        await page.evaluate(() => window.fixtureSchool('school-b'));
        await page.getByTestId('grade-scope').getByText('school-b:school_admin:true', { exact: true }).waitFor();
        await page.evaluate(() => window.fixtureSchool('school-a'));
        await page.getByTestId('grade-scope').getByText('school-a:school_admin:true', { exact: true }).waitFor();
      } else if (transition === 'closed') {
        await page.evaluate(() => window.fixtureGradesEnabled(false));
        await page.getByTestId('grade-scope').getByText('school-a:school_admin:false', { exact: true }).waitFor();
      } else {
        await page.evaluate(() => window.fixtureRole('teacher'));
        await page.getByTestId('grade-scope').getByText('school-a:teacher:true', { exact: true }).waitFor();
      }
      await page.getByLabel('New grade').fill('Newer draft');
      state.releaseSave();
      await page.waitForFunction(() => window.queryClient.getMutationCache().getAll().every(mutation => mutation.state.status !== 'pending'));
      assert.equal(await page.getByLabel('New grade').inputValue(), 'Newer draft');
      assert.equal(await page.getByText('Grade saved', { exact: true }).count(), 0);
      assert.deepEqual(state.errors, []);
    } finally { state.releaseSave?.(); await page.close(); }
  }
});

test('Manage Tabs honors resolved unlimited and cleanup distinguishes scoped tools from unrelated Dashboard caches', () => {
  assert.equal(teacherTabLimitSeed(undefined, 6), '6');
  assert.equal(teacherTabLimitSeed({ maxTabsPerStudent: 9, effectiveMaxTabsPerStudent: 9 }, 6), '9');
  assert.equal(teacherTabLimitSeed({ maxTabsPerStudent: null, effectiveMaxTabsPerStudent: 6 }), '6');
  assert.equal(teacherTabLimitSeed({ maxTabsPerStudent: null, effectiveMaxTabsPerStudent: null }, 20), '');
  assert.equal(teacherTabLimitSeed(undefined, null), '');
  assert.equal(teachingToolsQuery({ queryKey: ['/api/groups','class-a','students'] }), false);
  assert.equal(teachingToolsQuery({ queryKey: ['/api/groups','class-a','students','school-a','teacher-a'] }), true);
  assert.equal(teachingToolsQuery({ queryKey: ['/api/flight-paths'] }), false);
});
