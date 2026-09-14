import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classes = [
  { id: 'homeroom-five', name: 'Grade 5 Homeroom', gradeLevel: '5' },
  { id: 'mixed-art', name: 'Mixed Art', gradeLevel: null },
  { id: 'homeroom-six', name: 'Grade 6 Homeroom', gradeLevel: '6' },
];

function student(id, name, grade, classIds, online = false) {
  return {
    assignmentId: `assignment-${id}`, studentId: id, studentName: name, studentEmail: `${id}@fixture.example`, gradeLevel: grade,
    classes: classes.filter(item => classIds.includes(item.id)), status: online ? 'online' : 'offline',
    isLoggedIn: online, loginState: online ? 'logged_in' : 'not_logged_in',
    lastSeenAt: online ? new Date().toISOString() : null,
    realtimeObservedAt: online ? new Date().toISOString() : null,
    assignedAt: new Date(Date.now() - 600_000).toISOString(), releasedAt: null,
    activeTabTitle: online ? 'Lesson' : null, activeTabUrl: online ? 'https://lesson.example/' : null,
    capabilities: { screenOnlyUnlockV1: true },
  };
}

async function fixture(t, options = {}) {
  const entry = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter,Routes,Route,useLocation} from 'react-router-dom';
    import {QueryClientProvider} from '@tanstack/react-query';
    import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';
    import {queryClient} from '/src/lib/queryClient.js';
    import Coverage from '/src/products/classpilot/pages/Coverage.jsx';
    import {Toaster} from '/src/components/ui/toaster.jsx';
    import '/src/index.css';
    queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});
    window.__coverageWorkflowClient=queryClient;
    function Bridge(){const {switchSchool}=useAuth();const location=useLocation();React.useEffect(()=>{window.__switchSchool=switchSchool;window.__coverageLocation={pathname:location.pathname,state:location.state};},[switchSchool,location]);return null;}
    function DashboardDestination(){return React.createElement('h1',null,'Dashboard destination');}
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(MemoryRouter,{initialEntries:['/classpilot/coverage']},React.createElement(React.Fragment,null,React.createElement(Bridge),React.createElement(Routes,null,React.createElement(Route,{path:'/classpilot/coverage',element:React.createElement(Coverage)}),React.createElement(Route,{path:'/classpilot',element:React.createElement(DashboardDestination)})),React.createElement(Toaster))))));
  `;
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'coverage-supervision-workflow-fixture',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__coverage-workflow-test') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__coverage-workflow-entry.jsx"></script></body></html>'));
      });
    },
    resolveId(id) { if (id === '/__coverage-workflow-entry.jsx') return '\0coverage-workflow-entry'; },
    load(id) { if (id === '\0coverage-workflow-entry') return entry; },
  }] });
  await vite.listen();
  let browser;
  const holds = new Set();
  t.after(async () => { for (const release of holds) release(); await browser?.close(); await vite.close(); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, colorScheme: options.dark ? 'dark' : 'light' });
  page.setDefaultTimeout(15_000);
  const state = {
    activeSchoolId: 'school', viewerId: 'teacher', role: options.role || 'teacher',
    reads: [], writes: [], errors: [], holdCreate: false, holdStudents: false,
    contexts: [{ id: 'other-context', name: 'Other fifth grade', contextType: 'other', assignedStaffId: 'teacher', assignedStaff: { displayName: 'Teacher Fixture' }, canManage: true, status: 'active', activeStudentCount: 4, endsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    students: [student('alpha', 'Alpha Offline', '5', ['homeroom-five', 'mixed-art']), student('beta', 'Beta Online', '5', ['homeroom-five'], true), student('gamma', 'Gamma Offline', '6', ['homeroom-six', 'mixed-art']), student('delta', 'Delta Ungraded', null, [])],
    available: [student('epsilon', 'Epsilon Available', '5', ['homeroom-five'], true), student('zeta', 'Zeta Available', '6', ['homeroom-six', 'mixed-art'], true), student('eta', 'Eta Available', null, [], true)],
  };
  const waitHeld = key => new Promise(resolve => {
    const release = () => { holds.delete(release); resolve(); };
    holds.add(release); state[key] = release;
  });
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url()), pathname = url.pathname;
    const schoolId = request.headers()['x-school-id'] || state.activeSchoolId;
    if (request.method() === 'GET') state.reads.push({ pathname, schoolId, search: url.search });
    if (pathname.endsWith('/auth/me')) {
      state.activeSchoolId = schoolId;
      return route.fulfill({ json: { user: { id: state.viewerId, email: 'teacher@fixture.example', firstName: 'Teacher', lastName: 'Fixture' }, activeSchoolId: schoolId, memberships: [{ id: 'membership', schoolId: 'school', role: state.role }, { id: 'other-membership', schoolId: 'other-school', role: state.role }], licenses: { classPilot: true } } });
    }
    if (pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture-csrf' } });
    if (pathname.endsWith('/monitoring-interruptions')) return route.fulfill({ json: { asOf: new Date().toISOString(), lastScannedAt: new Date().toISOString(), scanStatus: 'healthy', counts: { open: 0, last24Hours: 0 } } });
    if (pathname.endsWith('/coverage/capabilities')) return route.fulfill({ json: { canManageSupervisionSetup: state.role === 'school_admin' } });
    if (pathname.endsWith('/coverage/summary')) return route.fulfill({ json: { schoolId, viewerId: state.viewerId, claimedStudentCount: schoolId === 'school' ? state.students.filter(item => !item.releasedAt).length : 0, ownSupervisionContexts: schoolId === 'school' ? state.contexts : [], ownTestingContexts: [] } });
    if (pathname.endsWith('/coverage/unassigned') || pathname.endsWith('/coverage/available-students')) return route.fulfill({ json: { schoolId, viewerId: state.viewerId, students: schoolId === 'school' ? state.available : [] } });
    if (/\/coverage\/contexts\/[^/]+\/students$/.test(pathname)) {
      const rows = structuredClone(schoolId === 'school' ? state.students : []);
      if (state.holdStudents && schoolId === 'school') { state.studentsStarted?.(); await waitHeld('releaseStudents'); }
      return route.fulfill({ json: { schoolId, viewerId: state.viewerId, students: rows } });
    }
    if (pathname.endsWith('/coverage/contexts') && request.method() === 'GET') return route.fulfill({ json: { schoolId, viewerId: state.viewerId, contexts: schoolId === 'school' ? state.contexts : [] } });
    if (pathname.endsWith('/admin/users') || pathname.endsWith('/coverage/setup/staff')) return route.fulfill({ json: { users: [{ userId: 'teacher', displayName: 'Teacher Fixture', email: 'teacher@fixture.example' }, { userId: 'other-teacher', displayName: 'Other Teacher', email: 'other-teacher@fixture.example' }] } });
    if (pathname.endsWith('/coverage/setup/classes')) return route.fulfill({ json: { groups: classes } });
    if (pathname.endsWith('/coverage/supervision-groups')) return route.fulfill({ json: { groups: [] } });
    if (pathname.endsWith('/admin/teacher-students') || pathname.endsWith('/coverage/setup/students')) return route.fulfill({ json: { students: [] } });
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      state.writes.push({ pathname, body, schoolId });
      if (pathname.endsWith('/coverage/contexts')) {
        const context = { ...body, id: 'new-context', schoolId, assignedStaffId: body.assignedStaffId || state.viewerId, status: 'active', canManage: true, activeStudentCount: body.studentIds?.length || 0 };
        if (state.holdCreate) { state.createStarted?.(); await waitHeld('releaseCreate'); }
        state.contexts.push(context);
        return route.fulfill({ json: { context } });
      }
      if (pathname.endsWith('/release')) {
        assert.ok(body.studentIds.length > 0, 'Releasing requires explicit student IDs, never an empty whole-context fallback');
        state.students = state.students.map(row => body.studentIds.includes(row.studentId) ? { ...row, releasedAt: new Date().toISOString() } : row);
        return route.fulfill({ json: { released: state.students.filter(row => body.studentIds.includes(row.studentId)) } });
      }
      if (pathname.endsWith('/commands')) return route.fulfill({ json: { command: { id: 'command' }, targetCount: body.targetStudentIds?.length || 0, unavailableCount: 0, requestedCount: body.targetStudentIds?.length || 0 } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__coverage-workflow-test`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Claimed', exact: true }).waitFor();
  if (options.dark) await page.evaluate(() => document.documentElement.classList.add('dark'));
  return { page, state };
}

const activePanel = page => page.getByRole('tabpanel');
const rowFor = (page, name) => activePanel(page).getByText(name, { exact: true }).locator('..').locator('..');

test('Claimed and Available combine roster class, grade, and search filters and retain their separate display state', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByLabel('Claimed class', { exact: true }).selectOption('mixed-art');
  assert.equal(await activePanel(page).getByText('Alpha Offline', { exact: true }).count(), 1);
  assert.equal(await activePanel(page).getByText('Gamma Offline', { exact: true }).count(), 1);
  assert.equal(await activePanel(page).getByText('Beta Online', { exact: true }).count(), 0);
  await page.getByLabel('Claimed grade', { exact: true }).selectOption('5');
  await page.getByPlaceholder('Search claimed students').fill('alpha');
  assert.equal(await activePanel(page).getByRole('checkbox').count(), 1);

  await page.getByRole('tab', { name: 'Available', exact: true }).click();
  await page.getByLabel('Available class', { exact: true }).selectOption('homeroom-six');
  await page.getByLabel('Available grade', { exact: true }).selectOption('6');
  await page.getByPlaceholder('Search students', { exact: true }).fill('zeta');
  assert.equal(await activePanel(page).getByRole('checkbox').count(), 1);
  await page.getByRole('tab', { name: 'Claimed', exact: true }).click();
  assert.equal(await page.getByLabel('Claimed class', { exact: true }).inputValue(), 'mixed-art');
  assert.equal(await page.getByLabel('Claimed grade', { exact: true }).inputValue(), '5');
  assert.equal(await page.getByPlaceholder('Search claimed students').inputValue(), 'alpha');
  await activePanel(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await activePanel(page).getByRole('checkbox').count(), 4);
  await page.getByLabel('Claimed class', { exact: true }).selectOption('none');
  await page.getByLabel('Claimed grade', { exact: true }).selectOption('none');
  assert.equal(await activePanel(page).getByRole('checkbox').count(), 1);
  assert.equal(await activePanel(page).getByText('Delta Ungraded', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => window.__coverageWorkflowClient.isFetching() === 0);
  assert.equal(await page.getByLabel('Claimed class', { exact: true }).inputValue(), 'none');
  assert.equal(await page.getByLabel('Claimed grade', { exact: true }).inputValue(), 'none');
  await page.getByRole('tab', { name: 'Available', exact: true }).click();
  assert.equal(await page.getByPlaceholder('Search students', { exact: true }).inputValue(), 'zeta');
  await activePanel(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await activePanel(page).getByRole('checkbox').count(), 3);
  assert.equal(state.writes.length, 0, 'Display filters never change supervision or class membership');
  assert.deepEqual(state.errors, []);
});

test('offline students can be bulk-released by the exact filtered selection and individually without browser eligibility', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByLabel('Claimed class', { exact: true }).selectOption('mixed-art');
  await activePanel(page).getByRole('button', { name: 'Select all matching students', exact: true }).click();
  const release = activePanel(page).getByRole('button', { name: 'Release selected (2)', exact: true });
  assert.equal(await release.isEnabled(), true);
  await release.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Release', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const first = state.writes.find(write => write.pathname.endsWith('/release'));
  assert.deepEqual(first.body.studentIds.slice().sort(), ['alpha', 'gamma']);
  assert.equal(first.body.releaseReason, 'returned_to_class');
  assert.equal(first.schoolId, 'school');
  assert.equal(state.students.find(item => item.studentId === 'beta').releasedAt, null, 'Hidden students remain assigned');
  await activePanel(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await rowFor(page, 'Delta Ungraded').getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(state.writes.filter(write => write.pathname.endsWith('/release')).at(-1).body.studentIds, ['delta']);
  assert.deepEqual(state.errors, []);
});

test('filtered command actions never include hidden students or fall back to a whole context when no eligible rows remain', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByLabel('Claimed class', { exact: true }).selectOption('homeroom-five');
  await page.getByPlaceholder('Search claimed students').fill('beta');
  await activePanel(page).getByRole('button', { name: 'Select all matching students', exact: true }).click();
  await activePanel(page).getByRole('button', { name: 'Close Tabs', exact: true }).click();
  await page.waitForFunction(() => window.__coverageWorkflowClient.isMutating() === 0);
  const command = state.writes.find(write => write.pathname.endsWith('/commands'));
  assert.ok(command, 'The selected online student receives an explicit command');
  assert.equal(command.body.targetScope, 'students');
  assert.deepEqual(command.body.targetStudentIds, ['beta']);
  await page.getByPlaceholder('Search claimed students').fill('nobody matches');
  const close = activePanel(page).getByRole('button', { name: 'Close Tabs', exact: true });
  assert.equal(await close.isDisabled(), true);
  assert.equal(state.writes.filter(write => write.pathname.endsWith('/commands')).length, 1);
  await page.getByPlaceholder('Search claimed students').fill('alpha');
  await activePanel(page).getByRole('button', { name: 'Select all matching students', exact: true }).click();
  assert.equal(await activePanel(page).getByRole('button', { name: 'Release selected (1)', exact: true }).isEnabled(), true);
  assert.equal(await close.isDisabled(), true, 'Release eligibility does not enable online-only browser commands');
});

test('a removed explicit selection stays empty until the teacher deliberately clears it', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  state.students = state.students.map(row => row.studentId === 'gamma'
    ? student('gamma', 'Gamma Online', '6', ['homeroom-six', 'mixed-art'], true) : row);
  let refreshed = page.waitForResponse(response => response.url().endsWith('/other-context/students') && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await refreshed;
  await page.waitForFunction(() => window.__coverageWorkflowClient.isFetching() === 0);
  await page.getByRole('checkbox', { name: 'Select Beta Online', exact: true }).check();
  assert.equal(await activePanel(page).getByRole('button', { name: 'Close Tabs', exact: true }).isEnabled(), true);

  state.students = state.students.filter(row => row.studentId !== 'beta');
  refreshed = page.waitForResponse(response => response.url().endsWith('/other-context/students') && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await refreshed;
  await page.waitForFunction(() => window.__coverageWorkflowClient.isFetching() === 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await activePanel(page).getByRole('button', { name: 'Close Tabs', exact: true }).isDisabled(), true,
    'Removing the only selected student must not retarget the other online student');
  assert.equal(await activePanel(page).getByRole('button', { name: 'Release selected (0)', exact: true }).isDisabled(), true);
  assert.equal(await activePanel(page).getByRole('button', { name: 'Clear selection', exact: true }).isEnabled(), true,
    'A teacher can deliberately leave the empty explicit selection');
  assert.equal(state.writes.length, 0);
  await activePanel(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
  await activePanel(page).getByRole('button', { name: 'Close Tabs', exact: true }).click();
  await page.waitForFunction(() => window.__coverageWorkflowClient.isMutating() === 0);
  const command = state.writes.find(write => write.pathname.endsWith('/commands'));
  assert.deepEqual(command.body.targetStudentIds, ['gamma']);
  assert.equal(command.body.targetScope, 'students');
});

test('release and rejoin under a new assignment cannot revive a selection or reuse a stale release confirmation', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByRole('checkbox', { name: 'Select Alpha Offline', exact: true }).check();
  state.students = state.students.map(row => row.studentId === 'alpha'
    ? { ...row, assignmentId: 'alpha-rejoined', assignedAt: new Date().toISOString() } : row);
  let refreshed = page.waitForResponse(response => response.url().endsWith('/other-context/students') && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await refreshed;
  await page.waitForFunction(() => window.__coverageWorkflowClient.isFetching() === 0);
  assert.equal(await page.getByRole('checkbox', { name: 'Select Alpha Offline', exact: true }).getAttribute('aria-checked'), 'false');
  assert.equal(await activePanel(page).getByRole('button', { name: 'Release selected (0)', exact: true }).isDisabled(), true);
  assert.equal(await activePanel(page).getByRole('button', { name: 'Close Tabs', exact: true }).isDisabled(), true);

  await page.getByRole('checkbox', { name: 'Select Alpha Offline', exact: true }).check();
  await activePanel(page).getByRole('button', { name: 'Release selected (1)', exact: true }).click();
  state.students = state.students.map(row => row.studentId === 'alpha'
    ? { ...row, assignmentId: 'alpha-rejoined-again', assignedAt: new Date().toISOString() } : row);
  refreshed = page.waitForResponse(response => response.url().endsWith('/other-context/students') && response.request().method() === 'GET');
  await page.evaluate(() => window.__coverageWorkflowClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] }));
  await refreshed;
  await page.waitForFunction(() => window.__coverageWorkflowClient.isFetching() === 0);
  await page.getByRole('dialog').getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByText('Supervision changed', { exact: true }).waitFor();
  assert.equal(state.writes.length, 0, 'The new assignment requires a new release confirmation');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('an open command dialog closes when its supervision context expires instead of targeting the replacement', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  await activePanel(page).getByRole('button', { name: 'Open Tab', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  state.contexts = [{
    id: 'replacement-context', name: 'Replacement supervision', contextType: 'other',
    assignedStaffId: 'teacher', assignedStaff: { displayName: 'Teacher Fixture' },
    canManage: true, status: 'active', activeStudentCount: 1,
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
  }];
  state.students = [student('replacement-student', 'Replacement Student', '6', ['homeroom-six'], true)];
  const refreshed = page.waitForResponse(response => response.url().endsWith('/replacement-context/students') && response.request().method() === 'GET');
  await page.evaluate(() => window.__coverageWorkflowClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] }));
  await refreshed;
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await activePanel(page).getByText('Replacement Student', { exact: true }).waitFor();
  assert.equal(state.writes.length, 0, 'Expiry and fallback must never submit the old command to replacement students');

  // A deliberate new dialog in the replacement context remains usable.
  await activePanel(page).getByRole('button', { name: 'Open Tab', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.errors, []);
});

async function startOther(page, { assignedStaff } = {}) {
  await page.getByRole('tab', { name: 'Available', exact: true }).click();
  await page.getByLabel('Available class', { exact: true }).selectOption('homeroom-five');
  await activePanel(page).getByRole('button', { name: 'Select all matching students', exact: true }).click();
  await activePanel(page).getByRole('button', { name: 'Start Supervision', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Supervision', exact: true });
  await dialog.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Other', exact: true }).click();
  if (assignedStaff) {
    await dialog.getByRole('combobox').nth(1).click();
    await page.getByRole('option', { name: assignedStaff, exact: true }).click();
  }
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
}

test('starting an owned Other session navigates with a school-and-viewer-bound dashboard intent', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  await startOther(page);
  await page.getByRole('heading', { name: 'Dashboard destination', exact: true }).waitFor();
  const destination = await page.evaluate(() => window.__coverageLocation);
  assert.equal(destination.pathname, '/classpilot');
  const intent = destination.state.classpilotSupervisionDashboard;
  assert.equal(intent.schoolId, 'school');
  assert.equal(intent.viewerId, 'teacher');
  assert.ok(intent.id);
  assert.deepEqual(intent.contexts.map(item => item.id), ['new-context']);
  assert.equal(intent.contexts[0].assignedStaffId, 'teacher');
  assert.deepEqual(state.writes.find(write => write.pathname.endsWith('/coverage/contexts')).body.studentIds, ['epsilon']);
  assert.deepEqual(state.errors, []);
});

test('an administrator starting supervision for another teacher stays in Coverage', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t, { role: 'school_admin' });
  await startOther(page, { assignedStaff: 'Other Teacher' });
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await page.evaluate(() => window.__coverageLocation)).pathname, '/classpilot/coverage');
  assert.equal(await page.getByRole('heading', { name: 'Dashboard destination', exact: true }).count(), 0);
  assert.equal(state.writes.find(write => write.pathname.endsWith('/coverage/contexts')).body.assignedStaffId, 'other-teacher');
  assert.deepEqual(state.errors, []);
});

test('a delayed own-supervision creation cannot navigate into a replacement school', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  state.holdCreate = true;
  const started = new Promise(resolve => { state.createStarted = resolve; });
  await startOther(page);
  await started;
  await page.evaluate(() => window.__switchSchool('other-school'));
  state.releaseCreate();
  await page.waitForFunction(() => window.__coverageWorkflowClient.isMutating() === 0);
  assert.equal((await page.evaluate(() => window.__coverageLocation)).pathname, '/classpilot/coverage');
  assert.equal(await page.getByRole('heading', { name: 'Dashboard destination', exact: true }).count(), 0);
  assert.equal(state.writes[0].schoolId, 'school');
  assert.equal(await activePanel(page).getByText('Alpha Offline', { exact: true }).count(), 0);
});

test('a delayed old-school roster cannot restore old students or selections after school switching', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t);
  await page.getByLabel('Claimed class', { exact: true }).selectOption('mixed-art');
  await activePanel(page).getByRole('button', { name: 'Select all matching students', exact: true }).click();
  state.holdStudents = true;
  const started = new Promise(resolve => { state.studentsStarted = resolve; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await started;
  await page.evaluate(() => window.__switchSchool('other-school'));
  state.releaseStudents();
  await page.waitForFunction(() => window.__coverageWorkflowClient.isFetching() === 0);
  assert.equal(await activePanel(page).getByText('Alpha Offline', { exact: true }).count(), 0);
  assert.equal(await activePanel(page).getByRole('button', { name: /Release selected \([1-9]/ }).count(), 0);
  assert.equal(state.writes.length, 0);
});

test('Coverage filters and release controls remain accessible on desktop and mobile in both themes', { timeout: 90_000 }, async t => {
  const { page, state } = await fixture(t, { mobile: true, dark: true });
  const classFilter = page.getByLabel('Claimed class', { exact: true });
  await classFilter.focus();
  assert.equal(await classFilter.evaluate(element => element === document.activeElement), true);
  await classFilter.selectOption('mixed-art');
  await page.getByLabel('Claimed grade', { exact: true }).selectOption('5');
  const checkbox = activePanel(page).getByRole('checkbox');
  await checkbox.focus();
  await page.keyboard.press('Space');
  assert.equal(await checkbox.getAttribute('aria-checked'), 'true');
  assert.equal(await activePanel(page).getByRole('button', { name: 'Release selected (1)', exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel('Available class', { exact: true }).count(), 0, 'Inactive panels are not exposed as controls');
  const artifacts = path.join(root, 'artifacts', 'coverage-workflow');
  await mkdir(artifacts, { recursive: true });
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      await page.screenshot({ path: path.join(artifacts, `${size}-${theme}.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await classFilter.isVisible(), true);
      assert.equal(await activePanel(page).getByRole('button', { name: 'Release selected (1)', exact: true }).isEnabled(), true);
    }
  }
  assert.deepEqual(state.errors, []);
});
