import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:4293';
const caseId = '340b5200-114d-4c68-b9b8-8a78c6e9d8a1';
const mergedCaseId = '340b5200-114d-4c68-b9b8-8a78c6e9d8a2';
const destination = `/classpilot/admin/safety?case=${caseId}`;
const key = 'sp_safety_login_return_v1';

async function scenario(browser, mode) {
  const context = await browser.newContext({ baseURL: base, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const direct = ['signed-in', 'closed-off-list', 'merged', 'missing', 'teacher', 'wrong-school'].includes(mode);
  const state = { signedIn: direct || mode === 'expired', expire: mode === 'expired', reports: [], reportIds: [] };
  const multiple = ['selection', 'wrong-school'].includes(mode);
  const memberships = [{ id: 'membership-a', schoolId: 'school-a', schoolName: 'School A', role: mode === 'teacher' ? 'teacher' : 'admin', status: 'active' }];
  if (multiple) memberships.push({ id: 'membership-b', schoolId: 'school-b', schoolName: 'School B', role: 'school_admin', status: 'active' });
  const report = { case: { id: mode === 'merged' ? mergedCaseId : caseId, student_id: 'student-a', first_name: 'Sample', last_name: 'Student', status: mode === 'closed-off-list' ? 'closed' : 'open', revision: 1,
    opened_at: '2026-09-05T14:00:00Z', assigned_to: null }, timezone: 'America/New_York', administrators: [],
    alerts: [], events: [], notifications: [], alertPage: { nextCursor: null }, eventPage: { nextCursor: null } };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const selected = request.headers()['x-school-id'];
    let body = {}, status = 200;
    if (['/api/auth/login', '/api/auth/exchange-code'].includes(pathname)) {
      state.signedIn = true;
      body = { token: 'fixture-token', memberships, schoolSelectionRequired: multiple };
    } else if (pathname === '/api/auth/me') {
      if (!state.signedIn) { status = 401; body = { error: 'Authentication required' }; }
      else {
        const selectionRequired = multiple && !selected;
        body = { user: { id: 'admin-a', email: 'admin@example.test', firstName: 'School', lastName: 'Admin' }, memberships,
          activeSchoolId: selectionRequired ? null : selected || 'school-a', schoolSelectionRequired: selectionRequired,
          licenses: selectionRequired ? {} : { classPilot: true }, token: 'fixture-token' };
      }
    } else if (pathname.includes('/safety-center/')) {
      if (state.expire) { state.expire = false; state.signedIn = false; status = 401; body = { error: 'Authentication required' }; }
      else if (!state.signedIn) { status = 401; body = { error: 'Authentication required' }; }
      else if (pathname.endsWith(`/cases/${caseId}`) || pathname.endsWith(`/cases/${mergedCaseId}`)) {
        state.reports.push(selected);
        state.reportIds.push(pathname.split('/').at(-1));
        if (mode === 'teacher') { status = 403; body = { error: 'Administrator access required' }; }
        else if (selected === 'school-b' || mode === 'missing') { status = 404; body = { error: 'Report not found' }; }
        else if (mode === 'merged' && pathname.endsWith(`/cases/${caseId}`)) body = { redirectCaseId: mergedCaseId };
        else body = report;
      } else if (pathname.endsWith('/cases') || pathname.endsWith('/approved-urls')) body = { items: [], nextCursor: null };
      else body = { count: 0 };
    } else if (pathname.endsWith('/csrf-token')) body = { csrfToken: 'fixture-csrf' };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '' }));
  await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
  if (mode === 'wrong-school') await context.addInitScript(() => localStorage.setItem('sp_activeSchoolId', 'school-b'));
  try {
    await page.goto(destination, { waitUntil: 'networkidle' });
    if (['wrong-school', 'missing', 'teacher'].includes(mode)) {
      await page.getByRole('alert').filter({ hasText: 'report is unavailable' }).waitFor();
      assert.ok(state.reports.length && state.reports.every(school => school === (mode === 'wrong-school' ? 'school-b' : 'school-a')));
      if (mode === 'wrong-school') assert.equal(await page.evaluate(() => localStorage.getItem('sp_activeSchoolId')), 'school-b');
      assert.equal(await page.getByRole('heading', { name: 'Sample Student', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      console.log(`Safety login browser: ${mode} report remains unavailable without exposing student details`);
      return;
    }
    if (!direct) {
    await page.waitForURL('**/login');
    assert.equal(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), key)).path, destination);
    if (mode === 'oauth-callback' || mode === 'oauth-login') {
      await page.goto(`${mode === 'oauth-callback' ? '/auth/callback' : '/login'}?code=fixture`, { waitUntil: 'networkidle' });
    } else {
      await page.getByRole('button', { name: 'Sign in with email instead', exact: true }).click();
      await page.getByPlaceholder('you@school.edu').fill('admin@example.test');
      await page.getByPlaceholder('Enter your password').fill('FixturePassword1!');
      await page.getByRole('button', { name: 'Sign In with Email', exact: true }).click();
    }
    if (mode === 'selection') {
      await page.getByRole('heading', { name: 'Choose a school', exact: true }).waitFor();
      assert.notEqual(await page.evaluate(key => sessionStorage.getItem(key), key), null);
      assert.equal(state.reports.length, 0, 'No report is requested before explicit school selection');
      await page.getByRole('button').filter({ hasText: 'School A' }).click();
    }
    }
    await page.getByRole('heading', { name: 'Sample Student', exact: true }).waitFor();
    if (mode === 'closed-off-list') await page.getByText('No reports match these filters.', { exact: true }).waitFor();
    if (mode === 'merged') assert.ok(state.reportIds.includes(mergedCaseId), 'The original email link follows the retained merged-case redirect');
    const actual = new URL(page.url());
    assert.equal(actual.pathname, '/classpilot/admin/safety');
    assert.equal(actual.searchParams.get('case'), caseId);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), null);
    assert.ok(state.reports.length && state.reports.every(school => school === 'school-a'));
    assert.deepEqual(errors, []);
    console.log(`Safety login browser: ${mode} opens the matching report with selected-school authority`);
  } finally { await context.close(); }
}

const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4293', '--strictPort'], {
  cwd: root, stdio: 'pipe', windowsHide: true,
});
let logs = '', browser;
server.stdout.on('data', value => { logs = (logs + value).slice(-8000); });
server.stderr.on('data', value => { logs = (logs + value).slice(-8000); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited before the browser gate: ${logs}`);
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* Wait for the owned Vite process. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, `Vite did not start: ${logs}`);
  browser = await chromium.launch({ headless: true });
  for (const mode of ['password', 'oauth-callback', 'oauth-login', 'selection', 'expired', 'signed-in', 'closed-off-list', 'merged', 'missing', 'teacher', 'wrong-school']) await scenario(browser, mode);
} finally { await browser?.close(); server.kill(); }
