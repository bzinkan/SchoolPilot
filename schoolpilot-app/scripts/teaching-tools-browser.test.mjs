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
const previewArtifacts = path.resolve(process.env.TEMP || '/tmp', 'schoolpilot-precise-scopes');
const manualTodayArtifacts = path.resolve(process.env.MANUAL_TODAY_QA_DIR || path.join(process.env.TEMP || '/tmp', 'schoolpilot-manual-today-tools'));
let vite, browser, base;
const authModule = `import{createContext,useContext}from'react';export const FixtureAuth=createContext(null);export const useAuth=()=>useContext(FixtureAuth);`;
const entry = `
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{BrowserRouter,Routes,Route,Link,useLocation}from'react-router-dom';
import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';
import{FixtureAuth}from'/src/contexts/AuthContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';
import TeachingToolsLayout from'/src/products/classpilot/components/TeachingToolsLayout.jsx';
import ManualToday from'/src/products/classpilot/pages/ManualToday.jsx';import TodaySchedule from'/src/products/classpilot/pages/TodaySchedule.jsx';
import MySettings from'/src/products/classpilot/pages/MySettings.jsx';import{useRosterGradeSettings}from'/src/products/classpilot/hooks/useRosterGradeSettings.js';import'/src/index.css';
const h=React.createElement,params=new URLSearchParams(location.search);
const initialRole=params.get('role')||sessionStorage.getItem('teaching-tools-fixture-role')||'teacher';sessionStorage.setItem('teaching-tools-fixture-role',initialRole);
history.replaceState({idx:0,key:'initial',usr:{marker:'preserved'}},'',params.get('route')||(location.pathname==='/__teaching_tools'?'/classpilot/my-settings':location.pathname+location.search+location.hash));
window.queryClient=queryClient;
function Location(){const route=useLocation();window.fixtureLocation=route;return null;}
function Grades({school,viewer,role}){const[draft,setDraft]=useState(''),[message,setMessage]=useState('');const[enabled,setEnabled]=useState(true);window.fixtureGradesEnabled=setEnabled;
const{query,mutation}=useRosterGradeSettings({schoolId:school,viewerId:viewer,enabled,canWrite:['admin','school_admin'].includes(role),onSaved:()=>{setDraft('');setMessage('Grade saved');},onError:setMessage});
return h('section',null,h('h1',null,'Grade fixture'),h('output',{'data-testid':'grade-scope'},school+':'+role+':'+enabled),h('output',{'data-testid':'grade-list'},(query.data?.gradeLevels||[]).join(',')),h('input',{'aria-label':'New grade',value:draft,onChange:event=>setDraft(event.target.value)}),h('button',{disabled:!query.data||query.isFetching||mutation.isPending,onClick:()=>mutation.mutate([...(query.data?.gradeLevels||[]),draft])},'Save grade'),h('p',{role:'status'},message));}
function Harness(){const[school,setSchool]=useState('school-a'),[viewer,setViewer]=useState('teacher-a'),[role,setRole]=useState(initialRole);
window.fixtureSchool=setSchool;window.fixtureViewer=setViewer;window.fixtureRole=setRole;
const value={user:{id:viewer,firstName:'Taylor',lastName:'Woods'},activeSchoolId:school,activeMembership:{schoolId:school,schoolName:'Cedar Grove School',roles:[role],role,status:'active'},loading:false,logout:async()=>{window.fixtureLoggedOut=true;}};
return h(FixtureAuth.Provider,{value},h(Location),h(Routes,null,h(Route,{path:'/grades',element:h(Grades,{school,viewer,role})}),h(Route,{element:h(TeachingToolsLayout)},h(Route,{path:'/classpilot/my-settings',element:h(MySettings)}),h(Route,{path:'/classpilot/my-settings/manual-today',element:h(ManualToday)}),h(Route,{path:'/classpilot/my-settings/today',element:h(TodaySchedule)}),h(Route,{path:'/classpilot/my-settings/guide',element:h('h1',null,'Teacher guide')})),h(Route,{path:'/classpilot',element:h('section',null,h('h1',null,'Teacher Dashboard'),h(Link,{to:'/classpilot/my-settings?section=defaults'},'Teaching tools'))})));}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(Harness)))));
`;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  await mkdir(previewArtifacts, { recursive: true });
  await mkdir(manualTodayArtifacts, { recursive: true });
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-teaching-tools-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'teaching-tools-fixture', enforce: 'pre', transform(_code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null };
    }, configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__teaching_tools') && !/^\/classpilot\/my-settings\/(?:manual-today|today)(?:[?#]|$)/.test(req.url || '')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
    }); } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

const PRECISE_VIDEO = {
  type: 'resource', hostname: 'youtube.com', includeSubdomains: false, provider: 'youtube',
  resourceId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
};

async function open({ route = '/classpilot/my-settings', role = 'teacher', precise = false, themes = true, uploads = false, locked = false, library = [], theme = null, automaticPrimaryTeacherId = 'teacher-a', automaticLibrary = false, manualTodayAllowed = true, manualTodayDenied = false, manualTodayStale = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  if (route.startsWith('/classpilot/my-settings/manual-today')) await page.clock.setFixedTime(new Date('2026-10-30T18:00:00.000Z'));
  const state = { requests: [], errors: [], preference: { revision: 0, maxTabsPerStudent: null, schoolMaxTabsPerStudent: 6, effectiveMaxTabsPerStudent: 6, dashboardTheme: theme, dashboardThemeAssets: library, dashboardThemeLibraryLimit: 5, effectiveDashboardTheme: null, schoolTheme: null, schoolCalendar: { autoCalendar: true, holidays: ['halloween', 'thanksgiving', 'valentines', 'st-patricks'], leadDays: 10, starts: {}, signInGateTheme: true }, dashboardThemesEnabled: themes, dashboardThemeUploadsEnabled: uploads, dashboardThemeLocked: locked, schoolDashboardTheme: locked ? { kind: 'preset', preset: 'christmas' } : null, dashboardThemeAsset: null }, conflict: null, holdSave: false, releaseSave: null, groupsRevoked: false, holdClassSave: false, gradeVersion: "grades-v1", gradeLevels: ["5"] };
  page.on('pageerror', error => state.errors.push(error.message));
  state.precise = precise;
  state.manualToday = { schoolDate: '2026-10-30', timezone: 'America/New_York', resumesOn: '2026-10-31', resumesAt: '2026-10-31T04:00:00.000Z',
    canManageManualToday: ['admin', 'school_admin'].includes(role) || manualTodayAllowed, teacherManualTodayAllowed: manualTodayAllowed,
    classes: [{ id: 'official-a', name: 'Official Biology' }, { id: 'own-a', name: 'My Science' }].map(group => ({ ...group,
      scheduleEnabled: true, scheduleManualDate: null, isManualToday: false, activeScheduledSessionId: null })) };
  state.manualTodayDenied = manualTodayDenied;
  state.manualTodayStale = manualTodayStale;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), schoolId = req.headers()['x-school-id'];
    let body = null;
    if (req.method() !== 'GET') { try { body = req.postDataJSON(); } catch { body = null; } }
    state.requests.push({ method: req.method(), path: url.pathname, search: url.search, schoolId, body });
    if (url.pathname === '/api/classpilot/groups/manual-today' && req.method() === 'GET') return route.fulfill({ json: state.manualToday });
    const manualTodayMatch = url.pathname.match(/^\/api\/classpilot\/groups\/([^/]+)\/manual-today$/);
    if (manualTodayMatch && req.method() === 'POST') {
      if (state.holdManualSave) await new Promise(resolve => { state.releaseManualSave = resolve; });
      if (state.manualTodayDenied) {
        state.manualToday = { ...state.manualToday, canManageManualToday: false, teacherManualTodayAllowed: false };
        return route.fulfill({ status: 403, json: { code: 'MANUAL_TODAY_TEACHER_DISABLED', error: 'Teacher adjustments are no longer allowed.' } });
      }
      if (state.manualTodayStale) {
        state.manualToday = { ...state.manualToday, schoolDate: '2026-10-31', resumesOn: '2026-11-01', resumesAt: '2026-11-01T04:00:00.000Z' };
        return route.fulfill({ status: 409, json: { code: 'MANUAL_TODAY_DATE_CHANGED', error: 'The school date changed. Review Manual for today again.' } });
      }
      const groupId = decodeURIComponent(manualTodayMatch[1]);
      state.manualToday = { ...state.manualToday, classes: state.manualToday.classes.map(group => group.id === groupId
        ? { ...group, isManualToday: true, scheduleManualDate: state.manualToday.schoolDate, activeScheduledSessionId: null } : group) };
      return route.fulfill({ json: { ...state.manualToday, class: state.manualToday.classes.find(group => group.id === groupId), endedScheduledSessionIds: [] } });
    }
    if (url.pathname.endsWith('/preview-resources')) {
      if (state.holdPreview) await new Promise(resolve => { state.releasePreview = resolve; });
      if (state.previewError) return route.fulfill({ status: 400, json: { error: 'The resource could not be limited. Paste its full link.' } });
      const source = body.purpose === 'classroom' ? body.resources.flatMap(item => item.links) : body.resources || [];
      const canonical = source.map(item => ({ url: item.url.includes('forms.gle') ? 'https://docs.google.com/forms/d/reviewed-form/viewform' : item.url.replace('www.nasa.gov', 'nasa.gov') }));
      const resourceScopes = canonical.map(item => {
        const url = new URL(item.url), form = url.hostname === 'docs.google.com' && url.pathname.startsWith('/forms/'), video = url.hostname.endsWith('youtube.com');
        const label = form ? 'Google Form' : video ? 'YouTube video' : 'Section';
        return { type: form || video ? 'resource' : 'section', hostname: url.hostname, url: item.url, label,
          description: form || video ? `Only this ${label.toLowerCase()} is allowed.` : `${url.hostname}${url.pathname} and paths below that section; other sections and subdomains are excluded.` };
      });
      const domains = body.purpose === 'classroom' && body.boundary === 'website' ? ['science.example.test'] : body.allowedDomains || [];
      return route.fulfill({ json: { schemaVersion: 1, purpose: body.purpose, ...(body.boundary ? { boundary: body.boundary } : {}),
        scopes: [...domains.map(hostname => ({ type: 'website', hostname, url: `https://${hostname}`, label: 'Entire website', description: `Every page on ${hostname} and its subdomains is allowed.` })), ...((body.boundary === 'website') ? [] : resourceScopes)],
        warnings: domains.map(hostname => ({ hostname, code: 'BROADER_WEBSITE', message: `${hostname} allows other pages. Specific entries alongside it do not narrow that broader access.` })),
        skipped: state.skipped || [], authoring: { allowedDomains: domains, resources: canonical, ...(body.purpose === 'classroom' ? { resourceLinks: body.boundary === 'website' ? domains.map(domain => `https://${domain}`) : canonical.map(item => item.url) } : {}) },
      } });
    }
    if (url.pathname.includes('/teacher/theme-asset')) {
      if (req.method() === 'POST') { state.assetReserve = body; state.asset = { id: 'asset-1', status: 'reserved', contentType: body.contentType, byteSize: body.size }; return route.fulfill({ status: 201, json: { asset: state.asset } }); }
      if (req.method() === 'PUT' && state.uploadFailure) return route.fulfill(state.uploadFailure);
      if (req.method() === 'PUT') { state.uploadContentType = req.headers()['content-type']; state.asset = { id: 'asset-1', status: 'ready', contentType: 'image/webp', byteSize: 1234, width: 1600, height: 900 };
        const summary = { id: 'asset-1', contentType: 'image/webp', byteSize: 1234, width: 1600, height: 900 };
        state.preference = { ...state.preference, dashboardThemeAsset: summary, dashboardThemeAssets: [...(state.preference.dashboardThemeAssets || []).filter(entry => entry.id !== 'asset-1'), summary] }; return route.fulfill({ json: { asset: state.asset } }); }
      if (req.method() === 'DELETE') { const removed = url.pathname.split('/').pop(); state.removed = [...(state.removed || []), removed];
        state.preference = { ...state.preference, dashboardThemeAsset: null, dashboardThemeAssets: (state.preference.dashboardThemeAssets || []).filter(entry => entry.id !== removed), dashboardTheme: null, effectiveDashboardTheme: null, revision: state.preference.revision + 1 }; return route.fulfill({ json: { preferences: { schoolId, ...state.preference } } }); }
      return route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
    }
    if (url.pathname.endsWith('/teacher/preferences')) {
      if (req.method() === 'PATCH') {
        if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
        if (state.conflict) { const current = state.conflict; state.conflict = null; return route.fulfill({ status: 409, json: { code: 'CLASSPILOT_PREFERENCES_CONFLICT', current } }); }
        const saved = { ...state.preference, schoolId, revision: body.expectedRevision + 1,
          ...('maxTabsPerStudent' in body ? { maxTabsPerStudent: body.maxTabsPerStudent, effectiveMaxTabsPerStudent: body.maxTabsPerStudent ?? 6 } : {}),
          ...('dashboardTheme' in body ? { dashboardTheme: body.dashboardTheme, effectiveDashboardTheme: body.dashboardTheme } : {}) };
        if (schoolId === 'school-a') state.preference = saved;
        return route.fulfill({ json: saved });
      }
      return route.fulfill({ json: schoolId === 'school-b' ? { schoolId, revision: 0, maxTabsPerStudent: null, schoolMaxTabsPerStudent: 3, effectiveMaxTabsPerStudent: 3 } : { schoolId, ...state.preference } });
    }
    if (url.pathname === '/api/classpilot/today-schedule') return route.fulfill({ json: { enabled: false, schoolDate: '2026-10-30', timeZone: 'UTC', canRequest: false, classes: [], changes: [] } });
    if (url.pathname.endsWith('/admin/settings')) return route.fulfill({ json: { schoolId, sections: { rosterGrades: { version: state.gradeVersion, gradeLevels: state.gradeLevels } }, schoolName: 'Cedar Grove' } });
    if (url.pathname.endsWith('/automatic-flight-path')) {
      state.automaticPolicy ||= { schemaVersion: 1, revision: 0, enabled: false, flightPathId: null, updatedBy: null };
      if (req.method() === 'PATCH') {
        if (state.automaticConflict) { state.automaticConflict = false; state.automaticPolicy = { ...state.automaticPolicy, revision: 2 }; return route.fulfill({ status: 409, json: { error: 'Class preset changed elsewhere.' } }); }
        state.automaticPolicy = { ...state.automaticPolicy, revision: body.expectedRevision + 1, enabled: body.enabled, flightPathId: body.flightPathId, updatedBy: 'teacher-a' };
      }
      return route.fulfill({ json: { policy: state.automaticPolicy, canManage: !state.coTeacher, eligible: state.automaticEligible ?? url.pathname.includes('/official-a/'),
        reasonCode: 'AUTOMATIC_FLIGHT_PATH_SCHEDULED_CLASS_REQUIRED', flightPath: state.automaticPolicy.flightPathId ? { id: state.automaticPolicy.flightPathId, flightPathName: state.automaticPolicy.flightPathId === 'primary-private' ? 'Primary teacher preset' : 'Research destinations' } : null } });
    }
    if (url.pathname.endsWith('/admin/settings/rosterGrades')) {
      if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
      if (state.gradeConflict) { state.gradeConflict = false; state.gradeVersion = 'grades-v2'; state.gradeLevels = ['5','6']; return route.fulfill({ status: 409, json: { code: 'CLASSPILOT_SETTINGS_CONFLICT', current: { version: state.gradeVersion, gradeLevels: state.gradeLevels } } }); }
      state.gradeVersion = 'grades-v3'; state.gradeLevels = body.gradeLevels;
      return route.fulfill({ json: { schoolId, version: state.gradeVersion, gradeLevels: state.gradeLevels } });
    }
    if (url.pathname.endsWith('/flight-paths') && automaticLibrary) return route.fulfill({ json: {
      flightPaths: [{ id: 'flight-a', flightPathName: 'My private destinations', allowedDomains: ['private.example.test'] }],
      library: [{ id: 'shared-flight', flightPathName: 'Shared science', allowedDomains: ['science.example.test'], visibility: 'school' }],
      features: { sharedTeachingResources: true },
    } });
    if (url.pathname.endsWith('/flight-paths')) return route.fulfill({ json: state.precise
      ? {
          flightPaths: [{ id: 'flight-a', flightPathName: 'Research destinations', allowedDomains: ['science.example.test'], resources: [PRECISE_VIDEO] }],
          features: { preciseRestrictionResources: true },
        }
      : { flightPaths: [{ id: 'flight-a', flightPathName: 'Research destinations', allowedDomains: ['science.example.test'] }] } });
    if (url.pathname.endsWith('/block-lists')) return route.fulfill({ json: { blockLists: [{ id: 'block-a', name: 'Independent work', blockedDomains: ['games.example.test'] }] } });
    if (url.pathname.endsWith('/teacher/groups')) return route.fulfill({ json: { groups: [...(state.groupsRevoked ? [] : [{ id: 'own-a', name: 'My Science', teacherId: 'teacher-a', groupType: 'teacher_group' }]), { id: 'official-a', name: 'Official Biology', teacherId: automaticPrimaryTeacherId, groupType: 'admin_class' }] } });
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
    assert.equal(await page.getByRole('navigation', { name: 'Teaching tools sections' }).getByRole('link').count(), 5);
    await page.getByRole('navigation', { name: 'Teaching tools sections' }).getByRole('link', { name: 'Today’s schedule', exact: true }).waitFor();
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
    await page.getByTestId('button-review-restriction-scope').click();
    await page.getByRole('region', { name: 'Reviewed allowed scope' }).waitFor();
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

async function recorded(state, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = writes(state).find(predicate);
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('expected write was not recorded');
}

test('precise Flight Path entries are editable only with the feature and are sent as one {url} per line', async () => {
  const off = await open();
  try {
    await off.page.getByTestId('button-create-flight-path').click();
    await off.page.getByTestId('input-flight-path-name').fill('Websites only');
    assert.equal(await off.page.getByTestId('textarea-flight-path-resources').count(), 0);
    await off.page.getByTestId('button-save-flight-path').click();
    const created = await recorded(off.state, row => row.method === 'POST' && row.path === '/api/flight-paths');
    assert.equal('resources' in created.body, false, 'no resources key while the feature is off');
  } finally { await off.page.close(); }

  const { page, state } = await open({ precise: true });
  try {
    await page.getByTestId('flight-path-resource-flight-a-0').waitFor();
    assert.match(await page.getByTestId('flight-path-resource-flight-a-0').innerText(), /YouTube video dQw4w9WgXcQ/);
    await page.getByTestId('button-edit-flight-path-flight-a').click();
    assert.equal(await page.getByTestId('textarea-flight-path-resources').inputValue(), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await page.getByTestId('textarea-flight-path-resources').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n  https://www.nasa.gov/solar-system  ');
    assert.equal(await page.getByTestId('button-save-flight-path').isDisabled(), true);
    await page.getByTestId('button-review-restriction-scope').click();
    await page.getByRole('region', { name: 'Reviewed allowed scope' }).waitFor();
    await page.getByTestId('button-save-flight-path').click();
    const patched = await recorded(state, row => row.method === 'PATCH' && row.path === '/api/flight-paths/flight-a');
    assert.deepEqual(patched.body.resources, [
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { url: 'https://nasa.gov/solar-system' },
    ]);
    assert.deepEqual(patched.body.allowedDomains, ['science.example.test']);
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('Flight Path review sends canonical links and is discarded on edits, errors and school changes', async () => {
  const { page, state } = await open({ precise: true });
  try {
    await page.getByTestId('button-create-flight-path').click();
    await page.getByTestId('input-flight-path-name').fill('Reviewed science');
    await page.getByTestId('input-flight-path-domains').fill('docs.google.com');
    await page.getByTestId('textarea-flight-path-resources').fill('https://forms.gle/AbCdEfGhIj');
    const review = page.getByTestId('button-review-restriction-scope'), save = page.getByTestId('button-save-flight-path');
    assert.equal(await save.isDisabled(), true);
    await review.click();
    await page.getByRole('region', { name: 'Reviewed allowed scope' }).waitFor();
    assert.match(await page.getByRole('region', { name: 'Reviewed allowed scope' }).innerText(), /do not narrow/);
    await save.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(previewArtifacts, 'flight-path-desktop.png'), fullPage: true });
    await page.getByTestId('input-flight-path-name').fill('Changed name');
    assert.equal(await save.isDisabled(), true);
    assert.equal(await page.getByRole('region', { name: 'Reviewed allowed scope' }).count(), 0);
    await page.getByTestId('input-flight-path-name').fill('Reviewed science');
    assert.equal(await save.isDisabled(), true, 'undoing an edit must not resurrect the old review');
    state.previewError = true;
    await review.click(); await page.getByText('The resource could not be limited. Paste its full link.').waitFor();
    assert.equal(await save.isDisabled(), true);
    state.previewError = false;
    await review.click(); await page.getByRole('region', { name: 'Reviewed allowed scope' }).waitFor();
    await save.click();
    const created = await recorded(state, row => row.method === 'POST' && row.path === '/api/flight-paths');
    assert.deepEqual(created.body.resources, [{ url: 'https://docs.google.com/forms/d/reviewed-form/viewform' }]);
    assert.equal(JSON.stringify(created.body).includes('forms.gle'), false);
    assert.equal(state.requests.filter(row => row.path.endsWith('/preview-resources')).every(row => row.schoolId === 'school-a'), true);
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('a held scope preview cannot return after a resource edit or restore an old-school draft', async () => {
  const { page, state } = await open({ precise: true });
  try {
    await page.getByTestId('button-create-flight-path').click();
    await page.getByTestId('input-flight-path-name').fill('Pending review');
    await page.getByTestId('textarea-flight-path-resources').fill('https://www.nasa.gov/solar-system');
    state.holdPreview = true;
    await page.getByTestId('button-review-restriction-scope').click();
    await recorded(state, row => row.path.endsWith('/preview-resources'));
    await page.getByTestId('textarea-flight-path-resources').fill('https://www.nasa.gov/missions');
    state.releasePreview(); state.holdPreview = false;
    await page.getByTestId('button-review-restriction-scope').click();
    await page.getByRole('region', { name: 'Reviewed allowed scope' }).waitFor();
    assert.match(await page.getByRole('region', { name: 'Reviewed allowed scope' }).innerText(), /missions/);
    assert.doesNotMatch(await page.getByRole('region', { name: 'Reviewed allowed scope' }).innerText(), /solar-system/);
    await page.evaluate(() => window.fixtureSchool('school-b'));
    await page.getByTestId('button-create-flight-path').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Reviewed allowed scope' }).count(), 0);
    assert(!writes(state).some(row => row.path === '/api/flight-paths'));
    assert.deepEqual(state.errors, []);
  } finally { state.releasePreview?.(); await page.close(); }
});

test('Classroom resource review keeps canonical boundaries, reports skipped links and omits original link inputs', async () => {
  const { page, state } = await open({ precise: true });
  try {
    await page.getByTestId('button-import-classroom-flight-path').click();
    await page.getByLabel('Course', { exact: true }).selectOption('course-a');
    await page.getByRole('checkbox', { name: 'Plant cells', exact: false }).check();
    await page.getByRole('radio', { name: /^Resource/ }).check();
    state.skipped = [{ url: 'https://youtube.com/results?search_query=math', code: 'RESOURCE_URL_INVALID' }];
    const save = page.getByRole('dialog').getByRole('button', { name: 'Create Flight Path', exact: true });
    assert.equal(await save.isDisabled(), true);
    await page.getByTestId('button-review-restriction-scope').click();
    await page.getByRole('region', { name: 'Reviewed allowed scope' }).waitFor();
    await page.getByText('1 linked item left out', { exact: false }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(previewArtifacts, 'classroom-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('checkbox', { name: 'Plant cells', exact: false }).uncheck();
    await page.getByRole('checkbox', { name: 'Plant cells', exact: false }).check();
    assert.equal(await save.isDisabled(), true, 'restoring a selection must not restore its prior scope review');
    assert.equal(await page.getByRole('region', { name: 'Reviewed allowed scope' }).count(), 0);
    await page.getByRole('radio', { name: /^Website/ }).check();
    assert.equal(await save.isDisabled(), true);
    await page.getByRole('radio', { name: /^Resource/ }).check();
    assert.equal(await save.isDisabled(), true);
    await page.getByTestId('button-review-restriction-scope').click();
    await page.getByRole('region', { name: 'Reviewed allowed scope' }).waitFor();
    await save.click();
    const created = await recorded(state, row => row.path.endsWith('/from-classroom'));
    assert.deepEqual(created.body.resources, [{ id: 'resource-a' }]);
    assert.deepEqual(created.body.selectedResourceIds, ['resource-a']);
    assert.deepEqual(created.body.resourceLinks, ['https://science.example.test/cells']);
    assert.equal(created.body.boundary, 'resource');
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('precise feature loss preserves retained Flight Path entries and keeps Classroom website-only', async () => {
  const { page, state } = await open({ precise: true });
  try {
    await page.getByTestId('button-edit-flight-path-flight-a').click();
    await page.getByTestId('textarea-flight-path-resources').waitFor();
    state.precise = false;
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] }));
    await page.getByTestId('flight-path-resources-kept').waitFor();
    assert.equal(await page.getByTestId('textarea-flight-path-resources').count(), 0);
    await page.getByTestId('input-flight-path-name').fill('Rename retained entries');
    await page.getByTestId('button-save-flight-path').click();
    const patched = await recorded(state, row => row.method === 'PATCH' && row.path === '/api/flight-paths/flight-a');
    assert.equal('resources' in patched.body, false);
    await page.getByTestId('button-import-classroom-flight-path').click();
    assert.equal(await page.getByRole('radio', { name: /^Resource/ }).count(), 0);
    assert.equal(await page.getByRole('radio', { name: /^Website/ }).isChecked(), true);
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

test('automatic class preset starts off, saves the selected class version for next session, and persists after reload', async () => {
  const route = '/classpilot/my-settings?section=classes&classId=official-a';
  const { page, state } = await open({ route });
  try {
    const card = page.getByTestId('card-automatic-flight-path');
    await card.getByRole('radio', { name: 'Off', exact: true }).waitFor();
    assert.equal(await card.getByRole('radio', { name: 'Off', exact: true }).isChecked(), true);
    assert.deepEqual(writes(state), []);
    await card.getByRole('radio', { name: 'Use a saved Flight Path' }).check();
    await card.getByLabel('Saved Flight Path', { exact: true }).selectOption('flight-a');
    await card.getByLabel('Automatic Flight Path allowed scope').getByText(/science.example.test/).waitFor();
    await card.getByRole('button', { name: 'Save class preset' }).click();
    await card.getByText('Class preset saved. It takes effect at the next scheduled session.').waitFor();
    assert.deepEqual(writes(state).map(({ path, schoolId, body }) => ({ path, schoolId, body })), [{ path: '/api/groups/official-a/automatic-flight-path', schoolId: 'school-a', body: { expectedRevision: 0, enabled: true, flightPathId: 'flight-a' } }]);
    await page.goto(`${base}/__teaching_tools?${new URLSearchParams({ route })}`);
    await card.getByRole('radio', { name: 'Use a saved Flight Path' }).waitFor();
    assert.equal(await card.getByRole('radio', { name: 'Use a saved Flight Path' }).isChecked(), true);
    assert.equal(await card.getByLabel('Saved Flight Path', { exact: true }).inputValue(), 'flight-a');
    if (process.env.AUTOMATIC_FLIGHT_PATH_QA_DIR) { await mkdir(process.env.AUTOMATIC_FLIGHT_PATH_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.AUTOMATIC_FLIGHT_PATH_QA_DIR, 'automatic-flight-path-setup-desktop.png'), fullPage: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.AUTOMATIC_FLIGHT_PATH_QA_DIR) await page.screenshot({ path: path.join(process.env.AUTOMATIC_FLIGHT_PATH_QA_DIR, 'automatic-flight-path-setup-mobile.png'), fullPage: true });
    assert.equal(state.requests.some(row => row.path.includes('/commands')), false);
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('automatic preset conflicts retain drafts; co-teachers see the saved name without write controls', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=classes&classId=official-a' });
  try {
    const card = page.getByTestId('card-automatic-flight-path');
    await card.getByRole('radio', { name: 'Use a saved Flight Path' }).check();
    await card.getByLabel('Saved Flight Path', { exact: true }).selectOption('flight-a');
    await page.getByTestId('select-teaching-class').click();
    await page.getByRole('option', { name: 'My Science', exact: true }).click();
    await page.getByRole('alertdialog').getByText('Leave with unsaved changes?').waitFor();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('classId'), 'official-a');
    assert.equal(await card.getByLabel('Saved Flight Path', { exact: true }).inputValue(), 'flight-a');
    state.automaticConflict = true;
    await card.getByRole('button', { name: 'Save class preset' }).click();
    await card.getByText(/This class preset changed elsewhere/).waitFor();
    assert.equal(await card.getByLabel('Saved Flight Path', { exact: true }).inputValue(), 'flight-a');
    assert.equal(await card.getByRole('button', { name: 'Save class preset' }).isDisabled(), true);
    await card.getByRole('button', { name: 'Reload saved preset' }).click();
    await card.getByRole('radio', { name: 'Off', exact: true }).waitFor();
    state.coTeacher = true;
    state.automaticPolicy = { ...state.automaticPolicy, enabled: true, flightPathId: 'private-other-teacher' };
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/groups','official-a','automatic-flight-path'] }));
    await card.getByText('On · Research destinations').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Save class preset' }).count(), 0);
    assert.equal(await card.getByRole('radio').count(), 0);
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('automatic class preset lets a non-primary administrator choose shared paths while preserving the approved private name', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=classes&classId=official-a', role: 'school_admin', automaticPrimaryTeacherId: 'teacher-b', automaticLibrary: true });
  try {
    const card = page.getByTestId('card-automatic-flight-path');
    await card.getByRole('radio', { name: 'Off', exact: true }).waitFor();
    state.automaticPolicy = { schemaVersion: 1, revision: 0, enabled: true, flightPathId: 'primary-private' };
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/groups','official-a','automatic-flight-path'] }));
    const choice = card.getByLabel('Saved Flight Path', { exact: true });
    await choice.waitFor();
    await card.getByText('For another teacher’s class, choose a shared school Flight Path.').waitFor();
    assert.equal(await choice.locator('option[value="flight-a"]').count(), 0, 'administrator personal paths must not be offered for another teacher');
    assert.equal(await choice.locator('option[value="primary-private"]').isDisabled(), true);
    assert.equal(await choice.locator('option[value="primary-private"]').innerText(), 'Primary teacher preset');
    await choice.selectOption('shared-flight');
    await card.getByRole('button', { name: 'Save class preset' }).click();
    await card.getByText('Class preset saved. It takes effect at the next scheduled session.').waitFor();
    assert.deepEqual(writes(state).map(row => row.body), [{ expectedRevision: 0, enabled: true, flightPathId: 'shared-flight' }]);
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('automatic class preset can be disabled after its schedule is removed without enabling or choosing another path', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=classes&classId=official-a' });
  try {
    const card = page.getByTestId('card-automatic-flight-path');
    await card.getByRole('radio', { name: 'Off', exact: true }).waitFor();
    state.automaticPolicy = { schemaVersion: 1, revision: 3, enabled: true, flightPathId: 'flight-a' };
    state.automaticEligible = false;
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/groups','official-a','automatic-flight-path'] }));
    await card.getByText('Choose a teaching class with an active class schedule.').waitFor();
    assert.equal(await card.getByRole('radio', { name: 'Use a saved Flight Path' }).isDisabled(), true);
    assert.equal(await card.getByLabel('Saved Flight Path', { exact: true }).isDisabled(), true);
    await card.getByRole('radio', { name: 'Off', exact: true }).check();
    await card.getByRole('button', { name: 'Save class preset' }).click();
    await card.getByText('Class preset saved. It takes effect at the next scheduled session.').waitFor();
    assert.deepEqual(writes(state).map(({ path, body }) => ({ path, body })), [{ path: '/api/groups/official-a/automatic-flight-path', body: { expectedRevision: 3, enabled: false, flightPathId: null } }]);
    assert.equal(await card.getByRole('radio').count(), 0, 'an unconfigured ineligible class offers no enable controls');
    state.coTeacher = true;
    state.automaticPolicy = { schemaVersion: 1, revision: 5, enabled: true, flightPathId: 'flight-a' };
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/groups','official-a','automatic-flight-path'] }));
    await card.getByText('On · Research destinations').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Save class preset' }).count(), 0);
    assert.equal(await card.getByRole('radio').count(), 0);
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});

test('Appearance saves a personal dashboard theme through the preference writer and hides choices when themes are off', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=appearance' });
  try {
    await page.getByTestId('card-dashboard-theme').waitFor();
    await page.getByText('Preloaded themes', { exact: true }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Teaching tools sections' }).getByRole('link', { name: 'Appearance', exact: true }).count(), 1);
    assert.equal(await page.getByTestId('dashboard-theme-choice-default').getAttribute('aria-checked'), 'true');
    await page.getByTestId('dashboard-theme-choice-halloween').click();
    await page.getByTestId('input-dashboard-theme-name').fill('Who Dey');
    assert.equal(await page.getByTestId('checkbox-dashboard-theme-kiosk').isChecked(), true, 'the kiosk follows the theme by default');
    await page.getByTestId('checkbox-dashboard-theme-kiosk').uncheck();
    await page.getByText('Unsaved theme', { exact: true }).waitFor();
    await page.getByTestId('button-save-dashboard-theme').click();
    await page.getByText('Unsaved theme', { exact: true }).waitFor({ state: 'detached' });
    await page.getByText('Dashboard theme saved.', { exact: true }).waitFor();
    assert.deepEqual(writes(state).map(row => row.body), [{ expectedRevision: 0, dashboardTheme: { kind: 'preset', preset: 'halloween', name: 'Who Dey', kiosk: false } }]);
    assert.equal(await page.getByTestId('checkbox-dashboard-theme-kiosk').isChecked(), false, 'the saved switch state is shown');
    assert.equal(await page.getByTestId('dashboard-theme-choice-halloween').getAttribute('aria-checked'), 'true');
    await page.getByTestId('dashboard-theme-choice-default').click();
    await page.getByText('Unsaved theme', { exact: true }).waitFor();
    await page.getByTestId('button-save-dashboard-theme').click();
    await page.getByText('Unsaved theme', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(writes(state).at(-1).body, { expectedRevision: 1, dashboardTheme: null });
    assert.equal(await page.getByTestId('dashboard-theme-hint-default').textContent(), 'No school theme today');
    // Plain is its own saved choice, distinct from following the school.
    await page.getByTestId('dashboard-theme-choice-none').click();
    assert.equal(await page.getByTestId('input-dashboard-theme-name').isDisabled(), true, 'a plain dashboard has no name or kiosk switch');
    assert.equal(await page.getByTestId('checkbox-dashboard-theme-kiosk').count(), 0);
    await page.getByTestId('button-save-dashboard-theme').click();
    await page.getByText('Unsaved theme', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(writes(state).at(-1).body, { expectedRevision: 2, dashboardTheme: { kind: 'none' } });
    assert.equal(await page.getByTestId('dashboard-theme-choice-none').getAttribute('aria-checked'), 'true');
    assert(writes(state).every(row => row.path === '/api/classpilot/teacher/preferences' && row.schoolId === 'school-a'));
    assert(!state.requests.some(row => row.path.includes('/commands')), 'saving a theme never sends a student command');
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
  const off = await open({ route: '/classpilot/my-settings?section=appearance', themes: false });
  try {
    await off.page.getByTestId('dashboard-theme-disabled').waitFor();
    assert.equal(await off.page.getByTestId('dashboard-theme-choice-halloween').count(), 0);
    assert.deepEqual(writes(off.state), []);
    assert.deepEqual(off.state.errors, []);
  } finally { await off.page.close(); }
});

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
test('a teacher uploads one background through reserve and content, then saves it as the image theme; a school lock hides the editor', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings?section=appearance', uploads: true });
  try {
    await page.getByTestId('card-dashboard-theme').waitFor();
    await page.getByTestId('input-dashboard-theme-file').setInputFiles({ name: 'mascot.png', mimeType: 'image/png', buffer: TINY_PNG });
    await page.getByText('Background ready. Save to use it.', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('dashboard-theme-choice-image-asset-1').getAttribute('aria-checked'), 'true', 'the new upload is picked as a library tile');
    assert.equal(await page.getByTestId('dashboard-theme-library-count').innerText(), '1 of 5');
    await page.getByTestId('radio-dashboard-theme-fit-contain').check();
    assert.ok(state.assetReserve && /^image\/(webp|jpeg)$/.test(state.assetReserve.contentType), 'the browser downsizes to WebP or JPEG before reserving');
    assert.ok(/^image\/(webp|jpeg)/.test(state.uploadContentType || ''), 'the bytes are sent with the prepared image type');
    await page.getByTestId('button-save-dashboard-theme').click();
    await page.getByText('Dashboard theme saved.', { exact: true }).waitFor();
    assert.deepEqual(writes(state).filter(row => row.method === 'PATCH').map(row => row.body), [{ expectedRevision: 0, dashboardTheme: { kind: 'image', imageAssetId: 'asset-1', fit: 'contain' } }]);
    await page.getByTestId('button-remove-dashboard-background-asset-1').click();
    await page.getByText('Background removed.', { exact: true }).waitFor();
    // A refused upload shows the server's own sentence, not the generic line.
    state.uploadFailure = { status: 503, json: { error: 'Background images are temporarily unavailable. Please retry.', code: 'CLASSPILOT_DASHBOARD_THEME_ASSET_UNAVAILABLE' } };
    await page.getByTestId('input-dashboard-theme-file').setInputFiles({ name: 'mascot.png', mimeType: 'image/png', buffer: TINY_PNG });
    await page.getByText('Background images are temporarily unavailable. Please retry.', { exact: true }).waitFor();
    state.uploadFailure = null;
    assert.equal(await page.getByTestId('dashboard-theme-choice-image-asset-1').count(), 0);
    assert.deepEqual(state.removed, ['asset-1'], 'remove names the tile\'s own asset');
    assert(!state.requests.some(row => row.path.includes('/commands')), 'themes never send a student command');
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
  // A full library: five tiles, the picked one restored with its fit, and the upload control closed until one is removed.
  const five = ['a', 'b', 'c', 'd', 'e'].map(letter => ({ id: `asset-${letter}`, contentType: 'image/webp', byteSize: 1000, width: 1600, height: 900 }));
  const fullLibrary = await open({ route: '/classpilot/my-settings?section=appearance', uploads: true, library: five, theme: { kind: 'image', imageAssetId: 'asset-c', fit: 'tile' } });
  try {
    await fullLibrary.page.getByTestId('card-dashboard-theme').waitFor();
    assert.equal(await fullLibrary.page.locator('[data-testid^="dashboard-theme-choice-image-"]').count(), 5);
    assert.equal(await fullLibrary.page.getByTestId('dashboard-theme-choice-image-asset-c').getAttribute('aria-checked'), 'true');
    assert.equal(await fullLibrary.page.getByTestId('radio-dashboard-theme-fit-tile').isChecked(), true, 'the saved fit is restored');
    assert.equal(await fullLibrary.page.getByTestId('dashboard-theme-library-count').innerText(), '5 of 5');
    await fullLibrary.page.getByTestId('dashboard-theme-library-full').waitFor();
    assert.equal(await fullLibrary.page.getByTestId('input-dashboard-theme-file').isDisabled(), true, 'a sixth upload is refused in the browser');
    assert.deepEqual(writes(fullLibrary.state), []);
    assert.deepEqual(fullLibrary.state.errors, []);
  } finally { await fullLibrary.page.close(); }
  const locked = await open({ route: '/classpilot/my-settings?section=appearance', locked: true });
  try {
    await locked.page.getByTestId('dashboard-theme-locked').waitFor();
    assert.equal(await locked.page.getByTestId('dashboard-theme-choice-halloween').count(), 0);
    assert.deepEqual(writes(locked.state), []);
    assert.deepEqual(locked.state.errors, []);
  } finally { await locked.page.close(); }
});
