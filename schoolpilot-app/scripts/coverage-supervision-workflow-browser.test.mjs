import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createSupervisionDashboardIntent, createObservedActivityDashboardIntent, createDashboardWorkspaceIntent, consumeSupervisionDashboardIntent } from '../src/products/classpilot/lib/supervisionDashboardNavigation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = () => Date.now();
function context(id, overrides = {}) {
  return { id, name: id === 'claim' ? 'Claimed students' : 'Reading support', purpose: 'supervision', contextType: 'other',
    assignedStaffId: 'teacher', assignedStaff: { displayName: 'Teacher Fixture' }, canManage: true, status: 'active',
    activeStudentCount: 2, students: [{studentId:'student-one',studentName:'First Student'},{studentId:'student-two',studentName:'Second Student'}], classroomAuthorityRevision: '4', startsAt: new Date(now() - 60_000).toISOString(), endsAt: new Date(now() + 3_600_000).toISOString(), ...overrides };
}
async function fixture(t, options = {}) {
  const entry = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryRouter,Routes,Route,useLocation,useNavigate} from 'react-router-dom';
    import {QueryClientProvider} from '@tanstack/react-query'; import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';
    import {queryClient} from '/src/lib/queryClient.js'; import Coverage from '/src/products/classpilot/pages/Coverage.jsx';
    import {Toaster} from '/src/components/ui/toaster.jsx'; import '/src/index.css';
    queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}}); window.__client=queryClient;
    function Bridge(){const {switchSchool}=useAuth();const location=useLocation();const navigate=useNavigate();React.useEffect(()=>{window.__switchSchool=switchSchool;window.__navigate=navigate;window.__location={pathname:location.pathname,search:location.search,state:location.state};},[switchSchool,location,navigate]);return null;}
    function Destination(){return React.createElement('h1',null,'Dashboard destination');}
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(MemoryRouter,{initialEntries:[${JSON.stringify(options.path || '/classpilot/coverage')}]},React.createElement(React.Fragment,null,React.createElement(Bridge),React.createElement(Routes,null,React.createElement(Route,{path:'/classpilot/coverage',element:React.createElement(Coverage)}),React.createElement(Route,{path:'/classpilot',element:React.createElement(Destination)}),React.createElement(Route,{path:'/classpilot/admin/scheduling',element:React.createElement('h1',null,'Scheduling destination')})),React.createElement(Toaster))))));
  `;
  const vite = await createServer({ cacheDir: path.join(root, "node_modules", `.vite-supervision-hub-${process.pid}`), root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'supervision-hub-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__hub') return next(); res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__hub-entry.jsx"></script></body></html>'));
    }); }, resolveId(id) { if (id === '/__hub-entry.jsx') return '\0hub-entry'; }, load(id) { if (id === '\0hub-entry') return entry; },
  }] });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await vite.close(); });
  const page = await browser.newPage({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 } });
  page.setDefaultTimeout(15_000);
  if (options.clock) await page.clock.install({ time: new Date() });
  const state = { role: options.role || 'teacher', schoolId: 'school', reads: [], writes: [], errors: [],
    contexts: options.contexts || [context('claim', { purpose: 'claim' })],
    groups: options.groups || [], canSetup: options.role === 'school_admin' || !!options.canSetup,
    scheduled: [{ id: 'applied', name: 'Applied MAP testing', purpose: 'testing', source: 'schedule_profile', state: 'scheduled', startsAt: '2026-09-23T13:00:00Z', endsAt: '2026-09-23T14:00:00Z', assignedStaff: { id: 'teacher', name: 'Teacher Fixture' } }],
  };
  page.on('pageerror', e => state.errors.push(e.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    const schoolId = request.headers()['x-school-id'] || state.schoolId;
    if (request.method() === 'GET') state.reads.push({ pathname, search: url.search, schoolId });
    else state.writes.push({ pathname, schoolId, revision: request.headers()['x-classpilot-context-authority-revision'], body: request.postDataJSON() });
    if (pathname.endsWith('/auth/me')) { state.schoolId = schoolId; return route.fulfill({ json: { user: { id: 'teacher', email: 'teacher@fixture.example', firstName: 'Teacher', lastName: 'Fixture' }, activeSchoolId: schoolId, memberships: ['school','other-school'].map(id => ({ id, schoolId:id, role:state.role })), licenses: { classPilot:true } } }); }
    if (pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken:'fixture' } });
    if (pathname.endsWith('/coverage/capabilities')) return route.fulfill({ json: { canManageSupervisionSetup:state.canSetup } });
    if (pathname.endsWith('/coverage/contexts') && request.method() === 'GET') return route.fulfill(state.failContexts ? { status:503,json:{error:'Temporarily unavailable'} } : { json: { contexts: schoolId === 'school' ? state.contexts : [] } });
    if (pathname.endsWith('/observable-activities')) return route.fulfill({ json: { activities: state.contexts.map(c => ({ id:c.id,name:c.name,purpose:c.purpose,authority:{teachingSessionId:null,supervisionContextId:c.id,contextAuthorityRevision:c.classroomAuthorityRevision} })) } });
    if (pathname.endsWith('/coverage/scheduled')) return route.fulfill({ json: { date:url.searchParams.get('date') || '2026-09-23',timeZone:'America/New_York',items:schoolId === 'school' ? state.scheduled : [] } });
    if (pathname.endsWith('/coverage/supervision-groups/browse')) return route.fulfill({ json: { groups:schoolId === 'school' ? state.groups : [],total:state.groups.length,page:1,totalPages:1,facets:{categories:[],grades:[],staff:[]} } });
    if (pathname.endsWith('/coverage/assignments')) return route.fulfill({ json: { assignments:[] } });
    if (pathname.endsWith('/release')) { const id = pathname.split('/').at(-2); state.contexts = state.contexts.filter(c => c.id !== id); return route.fulfill({ json: { released:[] } }); }
    if (pathname.endsWith('/history')) return route.fulfill({ json: { events:[] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__hub`);
  await page.waitForLoadState('networkidle');
  return {page,state};
}

async function screenshot(page, name) {
  if (!process.env.CLASSPILOT_HUB_SCREENSHOTS) return;
  await mkdir(process.env.CLASSPILOT_HUB_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.CLASSPILOT_HUB_SCREENSHOTS, `${name}.png`), fullPage: true });
}

const row = (page,id) => page.getByTestId(`live-session-${id}`);

test('hub shows only current nonempty sessions and owner actions, without duplicate student consoles', {timeout:90_000}, async t => {
  const {page,state} = await fixture(t, {contexts:[context('claim',{purpose:'claim'}),context('empty',{activeStudentCount:0}),context('future',{startsAt:new Date(now()+600_000).toISOString()}),context('ended',{status:'ended'}),context('expired',{endsAt:new Date(now()-1000).toISOString()})]});
  await row(page,'claim').waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Live now','Scheduled']);
  assert.equal(await page.locator('[data-testid^="live-session-"]').count(),1);
  await row(page,'claim').getByText('Supervisor: Teacher Fixture',{exact:true}).waitFor();
  await row(page,'claim').getByRole('button',{name:'Release all',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'End testing',exact:true}).count(),0);
  assert.equal(state.reads.some(r=>r.pathname.endsWith('/coverage/unassigned')||r.pathname.endsWith('/students')),false,'Hub does not run a competing student console');
  await row(page,'claim').getByRole('button',{name:'Open',exact:true}).click();
  await page.getByRole('heading',{name:'Dashboard destination'}).waitFor();
  const intent=await page.evaluate(()=>window.__location.state.classpilotSupervisionDashboard);
  assert.deepEqual(intent.contexts.map(c=>c.id),['claim']); assert.equal(intent.contexts[0].purpose,'claim'); assert.equal(intent.contexts[0].authority.contextAuthorityRevision,'4'); assert.equal(intent.viewerId,'teacher'); assert.equal(intent.schoolId,'school'); assert.deepEqual(state.errors,[]);
});

test('administrator observes another supervisor without receiving owner controls', {timeout:90_000}, async t => {
  const {page,state}=await fixture(t,{role:'school_admin',contexts:[context('testing',{purpose:'testing',assignedStaffId:'other-teacher',assignedStaff:{displayName:'Other Teacher'}})]});
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['Live now','Scheduled','Saved groups','Staff access']);
  await row(page,'testing').getByRole('button',{name:'Observe',exact:true}).waitFor();
  assert.equal(await row(page,'testing').getByRole('button',{name:/^(End|Open|Change)/}).count(),0);
  await screenshot(page, 'supervision-live-now');
  await row(page,'testing').getByRole('button',{name:'Observe',exact:true}).click();
  await page.getByRole('heading',{name:'Dashboard destination'}).waitFor();
  const intent=await page.evaluate(()=>window.__location.state.classpilotSupervisionDashboard);
  assert.equal(intent.mode,'observe');assert.equal(intent.activity.authority.supervisionContextId,'testing');assert.equal(intent.activity.authority.contextAuthorityRevision,'4');assert.equal(state.writes.length,0);assert.deepEqual(state.errors,[]);
});

test('Saved groups separates reusable membership and authorized staff from running sessions', {timeout:90_000}, async t=>{
  const group={id:'map',name:'Mr Burba MAP Test B',active:true,studentCount:12,staff:[{id:'other',displayName:'Mr Burba'}],updatedAt:'2026-09-23T01:00:00.000Z'};
  const {page,state}=await fixture(t,{role:'school_admin',groups:[group],contexts:[context('claim',{purpose:'claim'})],path:'/classpilot/coverage?tab=groups',mobile:true});
  const saved=page.getByTestId('supervision-group-map'); await saved.getByText('Not running',{exact:true}).waitFor();
  await saved.getByText('Enabled',{exact:true}).waitFor();await saved.getByText('Authorized staff: Mr Burba',{exact:true}).waitFor();assert.match(await saved.innerText(),/Saved roster: 12 students/);
  assert.equal(state.writes.length,0);assert.equal(await saved.getByRole('button',{name:'Start session',exact:true}).isEnabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'Hub fits narrow viewport');
  await screenshot(page, 'supervision-saved-groups-mobile');
  await saved.getByRole('button',{name:'Schedule testing',exact:true}).click();
  await page.getByRole('heading',{name:'Scheduling destination'}).waitFor();
  const intent=await page.evaluate(()=>window.__location.state.testingGroupPrefill);
  assert.equal(intent.groupId,'map');assert.equal(intent.schoolId,'school');assert.equal(intent.actorId,'teacher');assert.equal(state.writes.length,0);
  assert.deepEqual(state.errors,[]);
});

test('Scheduled tab uses server school date and timezone and keeps date/tab bookmarkable', {timeout:90_000}, async t=>{
  const {page,state}=await fixture(t,{path:'/classpilot/coverage?tab=scheduled'});
  await page.getByRole('heading',{name:'Applied MAP testing'}).waitFor();
  assert.equal(await page.getByLabel('Scheduled date').inputValue(),'2026-09-23');
  await page.getByText('Testing · 9:00 AM–10:00 AM',{exact:true}).waitFor();
  assert.equal(state.reads.find(r=>r.pathname.endsWith('/coverage/scheduled')).search,'');
  await page.getByLabel('Scheduled date').fill('2026-09-24');
  await page.waitForFunction(()=>window.__location.search.includes('date=2026-09-24'));
  await page.getByRole('tab',{name:'Live now',exact:true}).click();
  await page.waitForFunction(()=>window.__location.search.includes('tab=live'));
  await page.getByRole('tab',{name:'Scheduled',exact:true}).click();
  assert.equal(await page.getByLabel('Scheduled date').inputValue(),'2026-09-24');
  assert.equal(state.writes.length,0);assert.deepEqual(state.errors,[]);
});

test('ending a live session requires review and retains saved roster', {timeout:90_000},async t=>{
  const {page,state}=await fixture(t,{role:'school_admin',contexts:[context('testing',{purpose:'testing',coverageGroupId:'map'})],groups:[{id:'map',name:'Saved MAP roster',studentCount:12,staff:[],active:true}]});
  await row(page,'testing').getByRole('button',{name:'End testing',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByText(/The saved roster and history remain/).waitFor();
  assert.equal(state.writes.length,0);await dialog.getByRole('button',{name:'End testing',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(state.writes.length,1);assert.match(state.writes[0].pathname,/testing\/release$/);assert.deepEqual(state.writes[0].body.studentIds,[]);assert.deepEqual(state.writes[0].body.expectedStudentIds,['student-one','student-two']);assert.equal(state.writes[0].revision,'4','Release commits against the exact reviewed supervision revision');assert.equal(state.groups[0].studentCount,12);
  await page.getByRole('tab',{name:'Saved groups',exact:true}).click();await page.getByTestId('supervision-group-map').getByText('Not running',{exact:true}).waitFor();assert.deepEqual(state.errors,[]);
});

test('school change clears live data and legacy operational routes redirect to dashboard', {timeout:90_000},async t=>{
  const {page,state}=await fixture(t);
  await row(page,'claim').waitFor();await page.evaluate(()=>window.__switchSchool('other-school'));
  await page.getByText(/No supervision is running/).waitFor();assert.equal(await row(page,'claim').count(),0);
  await page.evaluate(()=>window.__navigate('/classpilot/coverage?tab=unassigned'));
  await page.getByRole('heading',{name:'Dashboard destination'}).waitFor();
  const intent=await page.evaluate(()=>window.__location.state.classpilotSupervisionDashboard);assert.equal(intent.view,'available');assert.equal(intent.schoolId,'other-school');assert.deepEqual(state.errors,[]);
});

test('navigation intents are one-use, authority-bound hints with administrator-only Observe',()=>{
  const own=createSupervisionDashboardIntent({schoolId:'school',viewerId:'teacher',contexts:[context('own'),context('other',{assignedStaffId:'other'})]});
  assert.deepEqual(consumeSupervisionDashboardIntent(own,{schoolId:'school',viewerId:'teacher'}).contexts.map(c=>c.id),['own']);assert.equal(consumeSupervisionDashboardIntent(own,{schoolId:'school',viewerId:'teacher'}),null);
  const observed=()=>createObservedActivityDashboardIntent({schoolId:'school',viewerId:'teacher',activity:{id:'other',authority:{supervisionContextId:'other',contextAuthorityRevision:'4'}}});
  assert.equal(consumeSupervisionDashboardIntent(observed(),{schoolId:'school',viewerId:'teacher',isAdmin:false}),null);
  assert.equal(consumeSupervisionDashboardIntent(observed(),{schoolId:'other-school',viewerId:'teacher',isAdmin:true}),null);
  assert.equal(consumeSupervisionDashboardIntent(observed(),{schoolId:'school',viewerId:'teacher',isAdmin:true}).mode,'observe');
  const workspace=createDashboardWorkspaceIntent({schoolId:'school',viewerId:'teacher',view:'claimed'});assert.equal(consumeSupervisionDashboardIntent(workspace,{schoolId:'school',viewerId:'teacher'}).view,'claimed');
});


test('live session expiry removes stale rows during a read failure without starting future sessions locally', {timeout:90_000}, async t=>{
  const {page,state}=await fixture(t,{clock:true,contexts:[context('claim',{purpose:'claim'}),context('future',{startsAt:new Date(now()+7_200_000).toISOString(),endsAt:new Date(now()+10_800_000).toISOString()})]});
  await row(page,'claim').waitFor();
  state.failContexts=true;
  await page.clock.fastForward(3_700_000);
  await row(page,'claim').waitFor({state:'hidden'});
  assert.equal(await row(page,'future').count(),0);
  assert.equal(state.writes.length,0);
  assert.deepEqual(state.errors,[]);
});


test('release review keeps its exact students when the roster changes without an authority revision change', {timeout:90_000},async t=>{
  const {page,state}=await fixture(t);
  await row(page,'claim').getByRole('button',{name:'Release all',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('list',{name:'Students leaving supervision'}).getByText('First Student',{exact:true}).waitFor();
  state.contexts=[context('claim',{purpose:'claim',students:[{studentId:'student-one',studentName:'First Student'},{studentId:'student-new',studentName:'New Student'}]})];
  await page.evaluate(()=>window.__client.invalidateQueries({queryKey:['/api/coverage/contexts']}));
  await dialog.getByRole('button',{name:'Release all',exact:true}).click();
  await page.getByText('Close this confirmation and review the current session again.',{exact:true}).waitFor();
  assert.equal(state.writes.length,0,'A newly assigned student is never included in an earlier Release all review');
  assert.deepEqual(state.errors,[]);
});
