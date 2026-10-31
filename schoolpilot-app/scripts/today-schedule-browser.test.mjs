import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(tmpdir(), 'schoolpilot-today-schedule');
const date = '2026-11-02';
const now = `${date}T12:50:00.000Z`;
let vite, browser, base;
const authModule = `import{createContext,useContext}from'react';export const FixtureAuth=createContext(null);export const useAuth=()=>useContext(FixtureAuth);`;
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route,Link}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{FixtureAuth}from'/src/contexts/AuthContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import TeachingToolsLayout from'/src/products/classpilot/components/TeachingToolsLayout.jsx';import TodaySchedule from'/src/products/classpilot/pages/TodaySchedule.jsx';import ManualToday from'/src/products/classpilot/pages/ManualToday.jsx';import ManualTodayDialog from'/src/products/classpilot/components/ManualTodayDialog.jsx';import{useManualToday}from'/src/products/classpilot/hooks/useManualToday.js';import'/src/index.css';
queryClient.setDefaultOptions({queries:{retry:false}});window.queryClient=queryClient;
const h=React.createElement;function Recovery(){const query=useManualToday({schoolId:'school-a',viewerId:'vatter',accessScope:'admin'});return h(ManualTodayDialog,{query,schoolId:'school-a',onClose:()=>{},startLabel:'Teach Class'});}function Harness(){const[viewer,setViewer]=useState('vatter'),[school,setSchool]=useState('school-a');window.fixtureViewer=setViewer;window.fixtureSchool=setSchool;
return h(FixtureAuth.Provider,{value:{user:{id:viewer,firstName:viewer,lastName:'Teacher'},activeSchoolId:school,activeMembership:{schoolId:school,schoolName:'Cedar Grove',role:'teacher',roles:['teacher'],status:'active'},loading:false}},h(Routes,null,h(Route,{path:'/classpilot/admin-recovery',element:h(Recovery)}),h(Route,{element:h(TeachingToolsLayout)},h(Route,{path:'/classpilot/my-settings/today',element:h(TodaySchedule)}),h(Route,{path:'/classpilot/my-settings/manual-today',element:h(ManualToday)}),h(Route,{path:'/classpilot/my-settings',element:h('h1',null,'Website tools')}),h(Route,{path:'/classpilot/my-settings/schedule-changes',element:h('h1',null,'Planned time swaps')})),h(Route,{path:'/classpilot',element:h(Link,{to:'/classpilot/my-settings/today'},'Teaching tools')})));}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(Harness)))));`;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-today-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'today-fixture', enforce: 'pre',
    transform(_code, id) { if (id.replaceAll('\\', '/').endsWith('/src/contexts/AuthContext.jsx')) return { code: authModule, map: null }; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/classpilot/')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
    }); },
  }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

const meetingKey = (groupId, hour) => `${groupId}:${date}T${hour}:00:00.000Z:${date}T${hour}:45:00.000Z`;
const window = (groupId, name, teacherId, teacherName, hour) => ({ groupId, name, teacherId, teacherName, startsAt: `${date}T${hour}:00:00.000Z`, endsAt: `${date}T${hour}:45:00.000Z` });
const beforeWindows = [window('v7', 'Vatter Seventh', 'vatter', 'Vatter', '13'), window('v8', 'Vatter Eighth', 'vatter', 'Vatter', '14'), window('w8', 'Wendell Eighth', 'wendell', 'Wendell', '13'), window('w7', 'Wendell Seventh', 'wendell', 'Wendell', '14')];
const afterWindows = beforeWindows.map((item, index) => ({ ...item, startsAt: beforeWindows[index ^ 1].startsAt, endsAt: beforeWindows[index ^ 1].endsAt }));

async function open(options = {}) {
  const page = await browser.newPage({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 960 } });
  page.setDefaultTimeout(10_000);
  await page.clock.install({ time: new Date(options.mode === 'remainder' ? `${date}T13:10:00.000Z` : now) });
  const state = { requests: [], errors: [], unexpected: [], enabled: options.enabled !== false, permission: options.permission !== false, viewer: 'vatter', changes: [], detailReads: 0, scheduleReads: 0, ...options };
  page.on('pageerror', error => state.errors.push(error.message));
  const change = () => ({ id: 'change-a', status: state.live ? 'pending' : 'applied', revision: 3, scheduledDate: date, requestedByUserId: 'vatter', counterpartTeacherId: 'wendell', before: beforeWindows, after: afterWindows, mode: state.mode || 'before_bell', requiresAcceptance: !!state.live, canAccept: state.viewer === 'wendell' && state.changes[0]?.status === 'pending', canDecline: state.viewer === 'wendell' && state.changes[0]?.status === 'pending', canCancel: state.viewer === 'vatter' && state.changes[0]?.status === 'pending' });
  const review = (body, accept = false) => ({ schoolDate: date, timeZone: 'UTC', action: body.action || 'swap', mode: state.mode || 'before_bell', canApply: !state.blocked && (!state.ambiguous || !!body.counterpartTeacherId), blockers: state.blocked ? [{ code: 'CONFLICT', message: 'Testing overlaps this period.' }] : [], eligibleCandidates: state.ambiguous ? [{ teacherId: 'wendell', teacherName: 'Wendell' }, { teacherId: 'other', teacherName: 'Other teacher' }] : [], requiresCounterpartSelection: state.ambiguous && !body.counterpartTeacherId, selectedCounterpartTeacherId: body.counterpartTeacherId || null, before: body.action === 'skip' ? [beforeWindows[0]] : beforeWindows, after: body.action === 'skip' ? [] : afterWindows, requiresAcceptance: !!state.live, requiredAcceptance: state.live ? { teacherId: 'wendell', teacherName: 'Wendell', liveSessionIds: ['live-wendell'] } : null, reviewToken: accept ? `accept-${state.detailReads}` : 'preview-a', expiresAt: `${date}T13:45:00.000Z` });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method(), body = request.postDataJSON();
    state.requests.push({ pathname, method, body, schoolId: request.headers()['x-school-id'] });
    if (pathname === '/api/auth/csrf') return route.fulfill({ json: { csrfToken: 'fixture-csrf' } });
    if (pathname === '/api/classpilot/groups/manual-today' && method === 'GET') return route.fulfill({ json: {
      schoolDate: date, timezone: 'UTC', resumesOn: '2026-11-03', resumesAt: '2026-11-03T00:00:00.000Z', canManageManualToday: true,
      classes: [{ id: 'v7', name: 'Vatter Seventh', isManualToday: true, hasTodayPlan: state.adminPlan !== false, todayRevision: state.adminRevision || 4, activeScheduledSessionIds: ['session-a', 'session-b'] }],
    } });
    if (pathname === '/api/classpilot/groups/v7/manual-today' && method === 'POST') {
      state.adminPlan = false;
      return route.fulfill({ json: { schoolDate: date, timezone: 'UTC', resumesOn: '2026-11-03', resumesAt: '2026-11-03T00:00:00.000Z', class: { id: 'v7', name: 'Vatter Seventh', isManualToday: true, hasTodayPlan: false, todayRevision: 5 } } });
    }
    if (pathname === '/api/classpilot/today-schedule' && method === 'GET') { state.scheduleReads++; return route.fulfill({ json: {
      enabled: state.enabled, schoolDate: state.schoolDate || date, timeZone: 'UTC', resumesAt: '2026-11-03T00:00:00.000Z', canRequest: state.permission && state.enabled,
      classes: (state.changes.some(item => item.status === 'applied') ? afterWindows : beforeWindows).filter(item => item.teacherId === state.viewer).map(item => ({ groupId: item.groupId, name: item.name, primaryTeacherId: state.coTeacher ? 'primary-teacher' : item.teacherId, primaryTeacherName: item.teacherName, studentCount: 12, meetings: [{ meetingRef: `${item.groupId}-meeting${state.renewRefs ? '-' + state.scheduleReads : ''}`, startsAt: item.startsAt, endsAt: item.endsAt, state: state.meetingStates?.[item.groupId] || (state.mode === 'remainder' && item.startsAt.includes('T13:') ? 'current' : 'future'), source: 'recurring' }] })),
      changes: state.changes.map(item => ({ ...item, ...change(), status: item.status })),
    } }); }
    if (pathname.endsWith('/preview') && method === 'POST') {
      if (state.holdPreview) await new Promise(resolve => { state.releasePreview = resolve; });
      return route.fulfill({ json: review(body) });
    }
    if (pathname === '/api/classpilot/today-schedule/changes' && method === 'POST') {
      if (state.reject) return route.fulfill({ status: state.reject, json: { error: 'The schedule changed. Review the latest periods.' } });
      if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
      const saved = change(); state.changes = [saved];
      return route.fulfill({ json: { change: saved } });
    }
    if (pathname === '/api/classpilot/today-schedule/changes/change-a' && method === 'GET') {
      state.detailReads++;
      if (state.holdDetail) await new Promise(resolve => { state.releaseDetail = resolve; });
      const current = { ...change(), status: state.changes[0]?.status || 'pending' };
      return route.fulfill({ json: { change: current, preview: review({}, true) } });
    }
    if (pathname.endsWith('/changes/change-a/actions') && method === 'POST') {
      const updated = { ...change(), status: { accept: 'applied', decline: 'declined', cancel: 'cancelled' }[body.action], revision: 4, canAccept: false, canDecline: false, canCancel: false };
      state.changes = [updated]; return route.fulfill({ json: { change: updated } });
    }
    state.unexpected.push(pathname); return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
  });
  await page.goto(`${base}${options.route || '/classpilot/my-settings/today'}`, { timeout: 30_000 });
  await page.getByRole('heading', { name: options.recovery ? 'Manual for today' : 'Today schedule', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  return { page, state };
}
const writes = state => state.requests.filter(request => request.method === 'POST' && request.pathname !== '/api/auth/csrf');
async function choose(page) { await page.getByTestId('select-today-selected').selectOption(meetingKey('v8', '14')); await page.getByTestId('button-preview-today-swap').click(); await page.getByTestId('today-swap-review').waitFor(); }
function clean(state) { assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []); }

test('Today schedule reviews all four entries and applies once without starting through Dashboard APIs', async () => {
  const { page, state } = await open({ route: '/classpilot/my-settings/manual-today' });
  try {
    assert.equal(new URL(page.url()).pathname, '/classpilot/my-settings/today');
    assert.equal(await page.getByRole('link', { name: 'Today schedule', exact: true }).getAttribute('aria-current'), 'page');
    await page.getByTestId('select-today-selected').selectOption(meetingKey('v8', '14')); assert.equal(writes(state).length, 0);
    await page.getByTestId('button-preview-today-swap').click(); await page.getByTestId('today-swap-review').waitFor();
    assert.deepEqual(writes(state)[0].body, { expectedSchoolDate: date, action: 'swap', currentGroupId: 'v7', currentMeetingRef: 'v7-meeting', selectedGroupId: 'v8', selectedMeetingRef: 'v8-meeting' });
    assert.equal(await page.getByTestId('today-window-review').locator('> div').count(), 4);
    assert.equal(await page.getByTestId('select-today-counterpart').count(), 0);
    await page.getByText('The other teacher has no affected Live class', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Apply today', exact: true }).click();
    await page.getByTestId('today-schedule-notice').waitFor();
    assert.equal(writes(state).length, 2); assert.equal(writes(state)[1].body.reviewToken, 'preview-a');
    assert.match(writes(state)[1].body.idempotencyKey, /^[a-f\d-]{36}$/);
    assert.equal(state.requests.some(request => /sessions\/start|manual-today/.test(request.pathname)), false);
    await page.reload(); await page.getByTestId('button-review-today-change-change-a').waitFor(); clean(state);
  } finally { await page.close(); }
});

test('remainder swap waits for live acceptance, uses a fresh receiver review, and fits keyboard/mobile', async () => {
  const { page, state } = await open({ live: true, mode: 'remainder', mobile: true });
  try {
    await page.getByTestId('select-today-selected').selectOption(meetingKey('v8', '14'));
    await page.getByTestId('button-preview-today-swap').focus(); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Swap the rest of this period and the later period?' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Swap the rest of this period and the later period?' }).evaluate(element => element === document.activeElement), true);
    await page.screenshot({ path: path.join(artifacts, 'today-swap-mobile-review.png'), fullPage: true, animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole('button', { name: 'Send to Wendell', exact: true }).click();
    await page.getByText('Request sent.', { exact: false }).waitFor(); assert.equal(state.changes[0].status, 'pending');
    assert.equal(state.requests.some(request => request.pathname.includes('/sessions/')), false);
    state.viewer = 'wendell'; await page.evaluate(() => window.fixtureViewer('wendell'));
    await page.getByTestId('button-review-today-change-change-a').click();
    await page.getByTestId('button-accept-today-swap').waitFor();
    await page.getByTestId('button-accept-today-swap').focus();
    state.holdDetail = true;
    await page.evaluate(() => { void window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/today-schedule/change'] }); });
    await page.getByText('Checking the latest request…', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('button-accept-today-swap').count(), 1, 'Background polls retain the reviewed controls and layout');
    assert.equal(await page.getByTestId('button-accept-today-swap').isDisabled(), true);
    assert.equal(await page.getByTestId('button-accept-today-swap').evaluate(element => element === document.activeElement), true, 'A pending refresh does not discard keyboard focus');
    const pendingWrites = writes(state).length;
    await page.keyboard.press('Enter');
    assert.equal(writes(state).length, pendingWrites, 'Keyboard activation cannot accept an in-flight review');
    state.holdDetail = false; state.releaseDetail();
    await page.waitForFunction(() => document.querySelector('[data-testid="button-accept-today-swap"]')?.getAttribute('aria-disabled') !== 'true');
    const reads = state.detailReads;
    await page.getByTestId('button-accept-today-swap').click();
    await page.getByTestId('today-schedule-notice').waitFor();
    assert.deepEqual(writes(state).at(-1).body, { action: 'accept', expectedRevision: 3, reviewToken: `accept-${reads}` });
    assert.equal(state.changes[0].status, 'applied'); clean(state);
  } finally { state.releaseDetail?.(); await page.close(); }
});

test('capability off and permission off keep the page read-only without preview calls', async () => {
  for (const options of [{ enabled: false }, { permission: false }]) {
    const { page, state } = await open(options);
    try { assert.equal(await page.getByTestId('button-preview-today-swap').count(), 0); assert.equal(await page.getByRole('button', { name: /Actions for/ }).count(), 0); assert.equal(writes(state).length, 0); clean(state); }
    finally { await page.close(); }
  }
});

test('ambiguous counterparts need explicit selection and blocked reviews cannot apply', async () => {
  const { page, state } = await open({ ambiguous: true });
  try {
    await choose(page); assert.equal(await page.getByTestId('button-apply-today-swap').isDisabled(), true);
    await page.getByTestId('select-today-counterpart').selectOption('wendell');
    await page.waitForFunction(() => document.querySelector('[data-testid="button-apply-today-swap"]')?.disabled === false);
    assert.equal(writes(state).at(-1).body.counterpartTeacherId, 'wendell');
    await page.getByRole('button', { name: 'Back to classes' }).click();
    state.blocked = true; await choose(page);
    await page.getByRole('alert').getByText('Testing overlaps this period.').waitFor();
    assert.equal(await page.getByTestId('button-apply-today-swap').isDisabled(), true); clean(state);
  } finally { await page.close(); }
});

test('Skip this period uses a named review and never starts or skips an entire day', async () => {
  const { page, state } = await open();
  try {
    await page.getByRole('button', { name: 'Actions for Vatter Seventh' }).click(); await page.getByRole('menuitem', { name: 'Skip this period' }).click();
    await page.getByRole('heading', { name: 'Skip this period today?' }).waitFor();
    assert.deepEqual(writes(state)[0].body, { expectedSchoolDate: date, action: 'skip', currentGroupId: 'v7', currentMeetingRef: 'v7-meeting' });
    await page.getByText('This cancels only this period.', { exact: false }).waitFor(); clean(state);
  } finally { await page.close(); }
});

test('stale reviews, revoked permission, and denied writes cannot apply a partial change', async () => {
  const { page, state } = await open();
  try {
    await choose(page); state.permission = false;
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/today-schedule'] }));
    await page.getByText('This review expired or your access changed.', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('button-apply-today-swap').isDisabled(), true);
    state.permission = true; await page.reload(); await choose(page); state.reject = 409;
    await page.getByTestId('button-apply-today-swap').click();
    await page.getByRole('alert').getByText('The schedule changed. Review the latest periods.').waitFor();
    assert.equal(await page.getByTestId('today-swap-review').count(), 0); assert.equal(state.changes.length, 0);
    assert.equal(await page.getByTestId('select-today-selected').inputValue(), meetingKey('v8', '14'));
    state.reject = 0; await choose(page); await page.clock.fastForward(56 * 60_000);
    assert.equal(await page.getByTestId('button-apply-today-swap').isDisabled(), true); clean(state);
  } finally { await page.close(); }
});

test('pending writes block navigation and old identity preview results never populate a new scope', async () => {
  const { page, state } = await open();
  try {
    await choose(page); state.holdSave = true; await page.getByTestId('button-apply-today-swap').click();
    await page.getByRole('button', { name: 'Saving…', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Website tools', exact: true }).click();
    await page.getByText('Wait for the current operation to finish before leaving.').waitFor();
    assert.equal(new URL(page.url()).pathname, '/classpilot/my-settings/today'); state.releaseSave();
    await page.getByTestId('today-schedule-notice').waitFor(); clean(state);
  } finally { state.releaseSave?.(); await page.close(); }
  const other = await open({ holdPreview: true });
  try {
    await other.page.getByTestId('select-today-selected').selectOption(meetingKey('v8', '14'));
    await other.page.getByTestId('button-preview-today-swap').click();
    while (!other.state.releasePreview) await new Promise(resolve => setTimeout(resolve, 10));
    other.state.viewer = 'wendell'; await other.page.evaluate(() => window.fixtureViewer('wendell'));
    await other.page.getByTestId('today-meeting-w8').waitFor(); other.state.releasePreview();
    await other.page.waitForLoadState('networkidle'); assert.equal(await other.page.getByTestId('today-swap-review').count(), 0); clean(other.state);
  } finally { other.state.releasePreview?.(); await other.page.close(); }
});

test('admin recovery remains available over a newer period plan and fences its exact revision', async () => {
  const { page, state } = await open({ route: '/classpilot/admin-recovery', recovery: true });
  try {
    await page.getByTestId('button-review-manual-today-v7').click();
    await page.getByText('This ends 2 running automatic class session(s).', { exact: false }).waitFor();
    await page.getByText("Today's period changes for this class will be replaced", { exact: false }).waitFor();
    state.adminRevision = 5;
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/groups/manual-today'] }));
    await page.getByRole('alert').getByText('The school date or period plan changed', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('button-confirm-manual-today').isDisabled(), true);
    assert.equal(writes(state).length, 0);
    await page.getByRole('button', { name: 'Back to classes', exact: true }).click();
    await page.getByTestId('button-review-manual-today-v7').click();
    await page.getByTestId('button-confirm-manual-today').click();
    await page.getByTestId('manual-today-success').waitFor();
    assert.deepEqual(writes(state)[0].body, { expectedSchoolDate: date, expectedTodayRevision: 5 });
    assert.equal(await page.getByTestId('button-review-manual-today-v7').count(), 0); clean(state);
  } finally { await page.close(); }
});

test('a retry reuses its reviewed idempotency key and yesterday notices disappear on server date change', async () => {
  const { page, state } = await open({ reject: 500 });
  try {
    await choose(page); await page.getByTestId('button-apply-today-swap').click();
    await page.getByRole('alert').getByText('The schedule changed. Review the latest periods.').waitFor();
    assert.equal(await page.getByTestId('today-swap-review').count(), 1);
    state.reject = 0;
    await page.waitForFunction(() => document.querySelector('[data-testid="button-apply-today-swap"]')?.disabled === false);
    await page.getByTestId('button-apply-today-swap').click(); await page.getByTestId('today-schedule-notice').waitFor();
    const commits = writes(state).filter(request => request.pathname.endsWith('/changes'));
    assert.deepEqual(commits[0].body, commits[1].body, 'An uncertain save retries the same reviewed operation');
    await page.screenshot({ path: path.join(artifacts, 'today-swap-desktop-applied.png'), fullPage: true, animations: 'disabled' });
    state.schoolDate = '2026-11-03';
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/today-schedule'] }));
    assert.equal(await page.getByTestId('today-schedule-notice').count(), 0); clean(state);
  } finally { await page.close(); }
});

test('polling renews signed references without losing selected windows or an open review', async () => {
  const { page, state } = await open({ renewRefs: true });
  try {
    await page.getByTestId('select-today-selected').selectOption(meetingKey('v8', '14'));
    const firstReads = state.scheduleReads;
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/today-schedule'] }));
    assert.ok(state.scheduleReads > firstReads);
    assert.equal(await page.getByTestId('select-today-selected').inputValue(), meetingKey('v8', '14'));
    const previewReads = state.scheduleReads;
    await page.getByTestId('button-preview-today-swap').click(); await page.getByTestId('today-swap-review').waitFor();
    assert.equal(writes(state)[0].body.currentMeetingRef, `v7-meeting-${previewReads}`);
    assert.equal(writes(state)[0].body.selectedMeetingRef, `v8-meeting-${previewReads}`);
    await page.evaluate(() => window.queryClient.invalidateQueries({ queryKey: ['/api/classpilot/today-schedule'] }));
    assert.equal(await page.getByTestId('select-today-selected').inputValue(), meetingKey('v8', '14'));
    assert.equal(await page.getByTestId('button-apply-today-swap').isEnabled(), true); clean(state);
  } finally { await page.close(); }
});

test('assigned co-teachers can review restoring skipped or ended meetings with time still remaining', async () => {
  const { page, state } = await open({ coTeacher: true, mode: 'remainder', meetingStates: { v7: 'ended', v8: 'skipped' } });
  try {
    await choose(page);
    await page.getByTestId('today-restore-notice').getByText('Vatter Seventh is currently ended.', { exact: false }).waitFor();
    await page.getByTestId('today-restore-notice').getByText('Vatter Eighth is currently skipped.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Swap and start my class', exact: true }).isEnabled(), true);
    assert.equal(writes(state)[0].body.currentGroupId, 'v7'); clean(state);
    await page.clock.setFixedTime(new Date(`${date}T15:00:00.000Z`)); await page.clock.runFor(1_000);
    assert.equal(await page.getByTestId('select-today-current').locator('option').count(), 1, 'Elapsed periods cannot be restored');
    assert.equal(await page.getByTestId('button-apply-today-swap').isDisabled(), true);
  } finally { await page.close(); }
});

test('feature off retains pending history and cancellation without creating or accepting a new plan', async () => {
  const { page, state } = await open({ enabled: false, live: true, changes: [{ id: 'change-a', status: 'pending' }] });
  try {
    await page.getByTestId('button-review-today-change-change-a').click();
    await page.getByRole('button', { name: 'Cancel request', exact: true }).click();
    await page.getByTestId('today-schedule-notice').waitFor();
    assert.deepEqual(writes(state).map(request => ({ pathname: request.pathname, body: request.body })), [{ pathname: '/api/classpilot/today-schedule/changes/change-a/actions', body: { action: 'cancel', expectedRevision: 3 } }]);
    assert.equal(state.changes[0].status, 'cancelled'); assert.equal(await page.getByTestId('button-preview-today-swap').count(), 0); clean(state);
  } finally { await page.close(); }
});

test('manual meeting recovery is explicit in the same review', async () => {
  const { page, state } = await open({ mode: 'remainder', meetingStates: { v7: 'manual' } });
  try {
    await choose(page); await page.getByTestId('today-restore-notice').getByText('Vatter Seventh is currently manual.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Swap and start my class', exact: true }).isEnabled(), true); clean(state);
  } finally { await page.close(); }
});
