import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roster = [{ studentId: 'one', studentName: 'Alex Example' }, { studentId: 'two', studentName: 'Sam Example' }];
async function fixture(t, { action = 'start', mobile = false } = {}) {
  const endsAt = new Date(Date.now() + 3_600_000).toISOString();
  const props = { action, ...(action === 'start' ? { group: { id: 'group', name: 'MAP saved roster' } } : {}), ...(action === 'send' ? { students: roster } : {}), ...(action === 'end_time' ? { context: { id: 'live', endsAt, name: 'Support' } } : {}) };
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClientProvider} from '@tanstack/react-query';import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';import {queryClient} from '/src/lib/queryClient.js';import Review from '/src/products/classpilot/components/SupervisionSessionDialog.jsx';import '/src/index.css';
  function Fixture(){const {switchSchool}=useAuth();React.useEffect(()=>{window.switchSchool=switchSchool;},[switchSchool]);const [open,setOpen]=React.useState(true);return React.createElement(Review,{...${JSON.stringify(props)},open,onOpenChange:setOpen,onSuccess:value=>window.done=value});}
  createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(Fixture))));`;
  const vite = await createServer({ root, cacheDir: path.join(root, 'node_modules/.cache', `supervision-review-${process.pid}`), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'supervision-review-fixture',
    configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== '/__review') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__review.jsx"></script></body></html>')); }); },
    resolveId(id) { if (id === '/__review.jsx') return '\0review-entry'; }, load(id) { if (id === '\0review-entry') return entry; },
  }] });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  const holds = [];
  t.after(async () => { holds.forEach(resolve => resolve()); await browser.close(); await vite.close(); });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 920 } });
  page.setDefaultTimeout(15_000);
  const state = { previews: [], commits: [], errors: [], unavailable: false, fail: 0, hold: false };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(); const pathname = new URL(request.url()).pathname; const schoolId = request.headers()['x-school-id'] || 'school';
    if (pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'teacher', firstName: 'Teacher', lastName: 'Example', email: 'teacher@fixture.test' }, activeSchoolId: schoolId, memberships: ['school', 'other-school'].map(id => ({ id, schoolId: id, role: 'teacher', schoolTimezone: 'America/New_York' })), licenses: { classPilot: true } } });
    if (pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture' } });
    if (pathname.endsWith('/coverage/session-options')) return route.fulfill({ json: { groups: [{ id: 'group', name: 'MAP saved roster' }], students: schoolId === 'school' ? roster : [], staff: [{ id: 'teacher', displayName: 'Teacher Example' }], defaultEndsAt: endsAt } });
    if (pathname.endsWith('/coverage/reroute-targets')) return route.fulfill({ json: { targets: [{ id: 'target', supervisionGroupId: 'group', assignedStaffId: 'receiver', name: 'Support', assignedStaff: { displayName: 'Receiver Example' }, activeContexts: [{ id: 'live', name: 'Active support', purpose: 'supervision', endsAt, revision: 3 }] }] } });
    if (pathname.endsWith('/coverage/preview')) {
      const body = request.postDataJSON(); state.previews.push(body);
      const rows = action === 'end_time' ? roster : roster.filter(row => body.studentIds.includes(row.studentId));
      return route.fulfill({ json: { request: body, reviewToken: `review-${state.previews.length}`, destination: { contextId: body.destinationContextId, name: 'Support', purpose: body.contextType === 'state_testing' ? 'testing' : 'supervision', assignedStaffId: 'receiver', supervisorName: 'Receiver Example', endsAt: body.endsAt || endsAt }, students: rows.map(row => ({ studentId: row.studentId, name: row.studentName, eligible: !(state.unavailable && row.studentId === 'two'), reason: state.unavailable && row.studentId === 'two' ? 'Student moved to another class' : null, currentOwner: 'Current class' })) } });
    }
    if (request.method() !== 'GET' && (pathname.endsWith('/coverage/contexts') || pathname.endsWith('/coverage/send') || pathname.endsWith('/coverage/contexts/live'))) {
      const body = request.postDataJSON(); state.commits.push({ body, schoolId });
      if (state.hold) { state.started?.(); await new Promise(resolve => { holds.push(resolve); state.release = resolve; }); }
      if (state.fail) return route.fulfill({ status: state.fail, json: { error: 'Supervision changed' } });
      return route.fulfill({ json: { context: { id: 'live', endsAt, assignedStaffId: 'teacher' }, outcomes: (body.studentIds || roster.map(row => row.studentId)).map(id => ({ studentId: id, name: roster.find(row => row.studentId === id).studentName, status: id === 'one' && action === 'send' ? 'already_assigned' : 'assigned' })) } });
    }
    return route.fulfill({ json: { contexts: [] } });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__review`);
  await page.getByTestId('review-supervision').waitFor();
  if (action !== 'end_time') await page.getByRole('checkbox').first().waitFor();
  return { page, state, endsAt };
}

test('Start defaults to supervision and commits only the reviewed explicit participants', { timeout: 60_000 }, async t => {
  const { page, state } = await fixture(t);
  assert.equal(await page.getByLabel('Purpose', { exact: true }).inputValue(), 'other');
  await page.getByLabel('Saved group', { exact: true }).selectOption('group');
  await page.getByRole('checkbox', { name: 'Sam Example' }).uncheck();
  await page.getByTestId('review-supervision').click();
  await page.getByTestId('supervision-review').waitFor();
  assert.deepEqual(state.previews[0].studentIds, ['one']);
  assert.equal(state.previews[0].supervisionGroupId, 'group');
  assert.equal(state.commits.length, 0);
  await page.getByTestId('confirm-supervision-review').click();
  await page.getByTestId('supervision-results').waitFor();
  assert.deepEqual(state.commits[0].body.studentIds, ['one']);
  assert.equal(state.commits[0].body.reviewToken, 'review-1');
  assert.equal(state.commits[0].body.contextType, 'other');
  assert.deepEqual(state.errors, []);
});

test('Send explicitly chooses the active session and retains already-assigned outcomes', { timeout: 60_000 }, async t => {
  const { page, state } = await fixture(t, { action: 'send' });
  await page.getByLabel('Send to', { exact: true }).selectOption('target');
  await page.getByLabel('Session', { exact: true }).selectOption('live');
  assert.equal(await page.locator('input[type="datetime-local"]').count(), 0);
  await page.getByTestId('review-supervision').click();
  await page.getByTestId('confirm-supervision-review').click();
  await page.getByTestId('supervision-results').waitFor();
  assert.equal(state.commits[0].body.destinationContextId, 'live');
  assert.equal(state.commits[0].body.endsAt, undefined);
  assert.equal(await page.getByText('Already in this session', { exact: true }).count(), 1);
  assert.deepEqual(state.errors, []);
});

test('Unavailable participants require explicit exclusion and a new review', { timeout: 60_000 }, async t => {
  const { page, state } = await fixture(t); state.unavailable = true;
  await page.getByTestId('review-supervision').click();
  assert.equal(await page.getByTestId('confirm-supervision-review').isDisabled(), true);
  assert.equal(state.commits.length, 0);
  await page.getByRole('button', { name: 'Continue with 1 available student', exact: true }).click();
  await page.getByText('Student moved to another class', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByTestId('confirm-supervision-review').click();
  await page.getByTestId('supervision-results').waitFor();
  assert.deepEqual(state.previews.map(row => row.studentIds), [['one', 'two'], ['one']]);
  assert.deepEqual(state.commits[0].body.studentIds, ['one']);
});

test('A stale review returns to configuration and never automatically retries the mutation', { timeout: 60_000 }, async t => {
  const { page, state } = await fixture(t); state.fail = 409;
  await page.getByTestId('review-supervision').click();
  await page.getByTestId('confirm-supervision-review').click();
  await page.getByTestId('review-supervision').waitFor();
  assert.equal(state.commits.length, 1);
  assert.equal(await page.getByTestId('confirm-supervision-review').count(), 0);
  state.fail = 0;
  await page.getByTestId('review-supervision').click();
  await page.getByTestId('confirm-supervision-review').click();
  await page.getByTestId('supervision-results').waitFor();
  assert.equal(state.commits[1].body.reviewToken, 'review-2');
});

test('An uncertain response requires reconciliation without offering a duplicate commit', { timeout: 60_000 }, async t => {
  const { page, state } = await fixture(t); state.fail = 500;
  await page.getByTestId('review-supervision').click();
  await page.getByTestId('confirm-supervision-review').click();
  await page.getByRole('button', { name: 'Refresh supervision', exact: true }).waitFor();
  assert.equal(await page.getByTestId('confirm-supervision-review').count(), 0);
  await page.getByRole('button', { name: 'Refresh supervision', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(state.commits.length, 1);
  assert.equal(await page.evaluate(() => window.done.uncertain), true);
});

test('A late commit response cannot restore old-school students or navigate the replacement school', { timeout: 60_000 }, async t => {
  const { page, state } = await fixture(t); state.hold = true;
  const started = new Promise(resolve => { state.started = resolve; });
  await page.getByTestId('review-supervision').click();
  await page.getByTestId('confirm-supervision-review').click();
  await started;
  await page.evaluate(() => window.switchSchool('other-school'));
  await page.getByText('No students available in this scope.', { exact: true }).waitFor();
  state.release();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.getByTestId('supervision-results').count(), 0);
  assert.equal(await page.evaluate(() => window.done), undefined);
  assert.equal(state.commits[0].schoolId, 'school');
  assert.deepEqual(state.errors, []);
});

test('Changing an end time reviews all affected students and remains usable on a narrow screen', { timeout: 60_000 }, async t => {
  const { page, state } = await fixture(t, { action: 'end_time', mobile: true });
  await page.getByTestId('review-supervision').click();
  await page.getByTestId('supervision-review').waitFor();
  assert.equal(await page.getByText('Alex Example', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Sam Example', { exact: true }).count(), 1);
  const artifacts = path.join(root, 'artifacts', 'supervision-flow'); await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, 'review-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByTestId('confirm-supervision-review').focus(); await page.keyboard.press('Enter');
  await page.getByTestId('supervision-results').waitFor();
  assert.equal(state.commits[0].body.action, 'end_time');
  assert.equal(state.commits[0].body.destinationContextId, 'live');
  assert.deepEqual(state.errors, []);
});
