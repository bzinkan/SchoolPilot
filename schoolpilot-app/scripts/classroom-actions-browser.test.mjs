import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient,apiRequest}from'/src/lib/queryClient.js';import{snapshotCommandRecipients}from'/src/products/classpilot/lib/dashboardCommandContext.js';import Actions from'/src/products/classpilot/components/ClassroomActions.jsx';import'/src/index.css';const h=React.createElement;
const capabilities=location.search.includes('capabilities=off')?[]:['scopedAuthorityChecksV1','focusTabV1','preciseRestrictionResourcesV1'];
const restrictions=location.search.includes('restricted=on')?{screenLock:true,flightPath:{id:'existing-path'},focus:{active:true,assignmentId:'existing-focus'}}:{};
const rows=[{studentId:'a',studentName:'Alex Example'},{studentId:'b',studentName:'Blair Example'},{studentId:'c',studentName:'Casey Example'}].map(row=>({...row,acceptedCapabilities:capabilities,classroomState:{restrictions}}));
function Harness(){const[scope,setScope]=useState('class-a'),[ids,setIds]=useState(['a','b']),[available,setAvailable]=useState(['a','b','c']);window.changeScope=()=>setScope('class-b');window.changeRecipients=()=>setIds(['b','c']);window.setAvailable=ids=>setAvailable(ids);return h(Actions,{key:scope,scopeKey:scope,schoolId:'school-a',viewerId:'teacher-a',students:rows.filter(row=>ids.includes(row.studentId)),captureRecipients:()=>snapshotCommandRecipients({target:{targetStudentIds:ids},students:rows,scopeKey:scope,label:'Selected students'}),availableRecipientIds:()=>available,preciseResourcesEnabled:!location.search.includes('precise=off'),assertCurrent:()=>{},postCommand:(type,payload,ids)=>apiRequest('POST','/commands',{teachingSessionId:scope,targetScope:'students',targetStudentIds:ids,commandType:type,commandPayload:payload}),readCommand:(command,signal)=>apiRequest('GET','/classpilot/commands/'+command.id+'/status?teachingSessionId='+scope,undefined,{signal})});}createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(Harness)));`;
before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-classroom-actions-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [...(process.env.CLASSROOM_BASELINE_SOURCE ? [{ name: 'classroom-baseline-source', enforce: 'pre', load(id) { if (id.replaceAll('\\', '/').split('?')[0].endsWith('/src/products/classpilot/components/ClassroomActions.jsx')) return readFileSync(process.env.CLASSROOM_BASELINE_SOURCE, 'utf8'); } }] : []), { name: 'classroom-actions-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__classroom_actions')) return next();
      res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url,
        `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">${entry}</script></body></html>`));
    }); } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });
const video = { type: 'resource', provider: 'youtube', hostname: 'youtube.com', includeSubdomains: false,
  resourceId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
const assignment = { id: 'assignment-a', title: 'Synthetic solar lesson', dueDate: { year: 2026, month: 10, day: 1 },
  links: [{ url: video.canonicalUrl, title: 'Solar video' }, { url: 'https://science.example.test/solar', title: 'Solar reading' }] };
const command = (body, id) => ({ ...body, id, targets: body.targetStudentIds.map(studentId => ({ studentId, status: 'received' })) });
async function fixture(options = {}) {
  const page = await browser.newPage({ viewport: { width: options.mobile ? 390 : 1440, height: 920 } });
  const state = { requests: [], commands: new Map(), polls: [], errors: [], unexpectedRequests: [], ...options };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), body = req.method() === 'GET' ? undefined : req.postDataJSON();
    state.requests.push({ path: url.pathname, query: url.search, schoolId: req.headers()['x-school-id'], body }); const json = data => route.fulfill({ json: data });
    if (url.pathname.endsWith('/csrf')) return json({ csrfToken: 'synthetic' });
    if (url.pathname.endsWith('/classroom/courses')) return json({ courses: [{ id: 'course-a', name: 'Synthetic science course' }] });
    if (url.pathname.endsWith('/resources')) return state.resourceError
      ? route.fulfill({ status: state.resourceError.status, json: state.resourceError.data })
      : json({ resources: [assignment] });
    if (url.pathname.endsWith('/google/auth-url')) return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-client' });
    if (url.pathname.endsWith('/commands') && req.method() === 'POST') {
      const value = command(body, `command-${state.commands.size + 1}`); state.commands.set(value.id, value);
      return json({ command: value });
    }
    if (url.pathname.endsWith('/status')) {
      const id = url.pathname.split('/').at(-2); state.polls.push(id);
      if (state.holdStatus) await new Promise(resolve => { state.releaseStatus = resolve; });
      const value = state.commands.get(id);
      const targets = value.targets.map(row => ({ ...row, status: 'completed', result: {}, ...state.targetResults?.[row.studentId] }));
      return json({ command: { ...value, targets } });
    }
    state.unexpectedRequests.push(url.pathname);
    return route.fulfill({ status: 500, json: { error: 'Unexpected API request' } });
  });
  const query = new URLSearchParams({ precise: options.preciseOff ? 'off' : 'on', capabilities: options.capabilitiesOff ? 'off' : 'on', restricted: options.restricted ? 'on' : 'off' });
  await page.goto(`${base}/__classroom_actions?${query}`);
  await page.getByTestId('button-classroom-assignments').click();
  await page.getByLabel('Course', { exact: true }).selectOption('course-a');
  if (!options.resourceError) await page.getByLabel('Assignment or material').selectOption('assignment-a');
  return { page, state, close: async () => { state.releaseStatus?.(); await page.unrouteAll({ behavior: 'wait' }); await page.close(); } };
}

function assertOpenOnly(state, expectedIds = ['a', 'b'], url = video.canonicalUrl) {
  assert.deepEqual([...state.commands.values()].map(({ commandType, commandPayload, targetStudentIds }) => ({ commandType, commandPayload, targetStudentIds })),
    [{ commandType: 'open-tab', commandPayload: { url }, targetStudentIds: expectedIds }]);
  assert.deepEqual(state.unexpectedRequests, []);
  assert.equal(state.requests.some(row => /flight-path|preview-resources|from-classroom/.test(row.path)), false);
  assert.deepEqual(state.errors, []);
}

test('assignment permission failures offer reconnect even when the course list loaded successfully', async () => {
  const { page, state, close } = await fixture({ resourceError: { status: 400,
    data: { code: 'MISSING_GOOGLE_SCOPE', error: 'MISSING_GOOGLE_SCOPE: Reconnect Google Classroom to grant resource access.' } } });
  try {
    await page.getByRole('alert').getByText(/allow access to courses, assignments, and materials/).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole('button', { name: 'Reconnect Google', exact: true }).isVisible(), true);
    assert.deepEqual(await page.getByTestId('command-recipients-list').locator('li').allInnerTexts(), ['Alex Example', 'Blair Example']);
    assert.equal(state.commands.size, 0);
    if (process.env.CLASSROOM_UI_QA_DIR) { await mkdir(process.env.CLASSROOM_UI_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.CLASSROOM_UI_QA_DIR, 'classroom-reconnect.png'), fullPage: true }); }
    await page.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic Google permission review</h1>' }));
    await page.getByRole('button', { name: 'Reconnect Google', exact: true }).click();
    await page.getByRole('heading', { name: 'Synthetic Google permission review' }).waitFor();
    const request = state.requests.find(row => row.path.endsWith('/google/auth-url'));
    const query = new URLSearchParams(request.query);
    assert.equal(query.get('purpose'), 'classroom_resources');
    assert.equal(query.get('returnTo'), `${base}/classpilot`);
    assert.equal(request.schoolId, 'school-a');
    assert.equal(state.commands.size, 0);
    assert.deepEqual(state.errors, []);
  } finally { await close(); }
});

test('temporary assignment failures retry without requesting a new Google grant', async () => {
  const { page, state, close } = await fixture({ resourceError: { status: 503, data: { error: 'Temporary provider failure' } } });
  try {
    await page.getByText('Assignments could not be loaded. Try again.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reconnect Google', exact: true }).count(), 0);
    state.resourceError = null;
    await page.getByRole('button', { name: 'Retry assignments', exact: true }).click();
    await page.getByLabel('Assignment or material').selectOption('assignment-a');
    assert.equal(await page.getByRole('button', { name: 'Open assignment', exact: true }).isEnabled(), true);
    assert.equal(state.requests.filter(row => row.path.endsWith('/resources')).length, 2);
    assert.equal(state.requests.some(row => row.path.endsWith('/google/auth-url')), false);
    assert.equal(state.commands.size, 0);
    assert.deepEqual(state.errors, []);
  } finally { await close(); }
});

test('Open assignment sends only a URL to the captured students', async () => {
  const { page, state, close } = await fixture();
  try {
    assert.equal(await page.getByRole('button', { name: 'Open + Focus', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Open as Lesson', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Classroom lesson scope').count(), 0);
    if (process.env.CLASSROOM_UI_QA_DIR) { await mkdir(process.env.CLASSROOM_UI_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.CLASSROOM_UI_QA_DIR, 'classroom-desktop.png'), fullPage: true }); }
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
    assertOpenOnly(state);
  } finally { await close(); }
});

test('the assignment picker fits mobile and opens the chosen attachment without restriction authoring', async () => {
  const { page, state, close } = await fixture({ mobile: true });
  try {
    const button = page.getByRole('button', { name: 'Open assignment', exact: true });
    assert.equal(await button.isEnabled(), true);
    await page.getByLabel('Link to open', { exact: true }).selectOption(assignment.links[1].url);
    if (process.env.CLASSROOM_UI_QA_DIR) { await mkdir(process.env.CLASSROOM_UI_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.CLASSROOM_UI_QA_DIR, 'classroom-mobile.png'), fullPage: true }); }
    assert.equal(await page.getByTestId('dialog-classroom-actions').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await button.click();
    await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
    assertOpenOnly(state, ['a', 'b'], assignment.links[1].url);
  } finally { await close(); }
});

test('choosing a different attachment clears the previous open result until it is sent', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
    await page.getByText(/Results show browser confirmations/).waitFor();
    await page.getByLabel('Link to open', { exact: true }).selectOption(assignment.links[1].url);
    assert.equal(await page.getByLabel('Classroom action results').count(), 0);
    assert.equal(await page.getByText(/Results show browser confirmations/).count(), 0);
    assertOpenOnly(state);
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
    assert.deepEqual([...state.commands.values()].map(({ commandType, commandPayload, targetStudentIds }) => ({ commandType, commandPayload, targetStudentIds })), [
      { commandType: 'open-tab', commandPayload: { url: video.canonicalUrl }, targetStudentIds: ['a', 'b'] },
      { commandType: 'open-tab', commandPayload: { url: assignment.links[1].url }, targetStudentIds: ['a', 'b'] },
    ]);
    assert.deepEqual(state.unexpectedRequests, []); assert.deepEqual(state.errors, []);
  } finally { await close(); }
});

test('authority retirement while an open acknowledgement is held cancels waiting without sending to the new scope', async () => {
  const { page, state, close } = await fixture({ holdStatus: true });
  try {
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Waiting for per-student browser results'));
    await page.waitForTimeout(1000); assert.ok(state.releaseStatus);
    await page.evaluate(() => window.changeScope()); state.releaseStatus(); state.holdStatus = false;
    await page.waitForTimeout(1000);
    assert.equal(await page.getByTestId('dialog-classroom-actions').count(), 0); assertOpenOnly(state);
    assert.equal([...state.commands.values()][0].teachingSessionId, 'class-a');
  } finally { await close(); }
});

for (const capabilitiesOff of [false, true]) {
  test(`opening with existing controls preserves them with optional capabilities ${capabilitiesOff ? 'off' : 'on'}`, async () => {
    const { page, state, close } = await fixture({ preciseOff: capabilitiesOff, capabilitiesOff, restricted: true });
    try {
      await page.getByText(/Existing browsing restrictions still apply/).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Open + Focus', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Open as Lesson', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
      await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
      assertOpenOnly(state);
    } finally { await close(); }
  });
}


test('a Classroom dialog keeps its original recipients across selection and subgroup inputs', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.evaluate(() => window.changeRecipients());
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
    assertOpenOnly(state);
    assert.deepEqual(await page.getByTestId('command-recipients-list').locator('li').allInnerTexts(), ['Alex Example', 'Blair Example']);
    assert.deepEqual(state.errors, []);
  } finally { await close(); }
});

test('a changed Classroom recipient list needs a separate confirmation and only sends the named subset', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.evaluate(() => window.setAvailable(['a', 'c']));
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    await page.getByTestId('command-recipients-unavailable').getByText(/Blair Example/).waitFor();
    assert.equal(state.commands.size, 0);
    await page.getByRole('button', { name: 'Send to 1 available', exact: true }).click();
    await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
    assertOpenOnly(state, ['a']);
  } finally { await close(); }
});

test('mixed browser results identify the failed student without claiming every assignment opened', async () => {
  const { page, state, close } = await fixture({ targetResults: { b: { status: 'failed', error: 'The assignment is blocked by an existing Flight Path.' } } });
  try {
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    const results = page.getByLabel('Classroom action results');
    await results.getByText('Failed', { exact: true }).waitFor();
    assert.equal(await results.getByText('Opened', { exact: true }).count(), 1);
    assert.match(await results.locator('div').filter({ has: page.getByText('Blair Example', { exact: true }) }).innerText(), /Failed.*The assignment is blocked/s);
    assertOpenOnly(state);
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.getByTestId('dialog-classroom-actions').waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(/Results show browser confirmations/).count(), 0, 'closing clears the obsolete toolbar notice');
  } finally { await close(); }
});

test('a held Classroom send ignores a repeated gesture', async () => {
  const { page, state, close } = await fixture({ holdStatus: true });
  try {
    await page.getByRole('button', { name: 'Open assignment', exact: true }).dblclick();
    const deadline = Date.now() + 10_000;
    while (!state.releaseStatus && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(state.releaseStatus); assertOpenOnly(state);
    state.holdStatus = false; state.releaseStatus();
    await page.getByLabel('Classroom action results').getByText('Opened', { exact: true }).first().waitFor();
  } finally { await close(); }
});

test('closing while an acknowledgement is held stops waiting and sends no follow-up command', async () => {
  const { page, state, close } = await fixture({ holdStatus: true });
  try {
    await page.getByRole('button', { name: 'Open assignment', exact: true }).click();
    const deadline = Date.now() + 10_000;
    while (!state.releaseStatus && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(state.releaseStatus);
    await page.getByRole('button', { name: 'Stop waiting and close', exact: true }).click();
    await page.getByTestId('dialog-classroom-actions').waitFor({ state: 'hidden' });
    state.holdStatus = false; state.releaseStatus();
    await page.waitForLoadState('networkidle'); assertOpenOnly(state);
  } finally { await close(); }
});
