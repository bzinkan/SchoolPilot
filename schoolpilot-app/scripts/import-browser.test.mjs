import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.resolve(root, '../../artifacts');
const imagePath = path.join(root, 'scripts/fixtures/mydesk-synthetic-slips.png');
let server, browser, base, sourceBytes;
const entry = `import'/src/products/classpilot/lib/privateWorkspaceNavigation.js';import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{AuthProvider,useAuth}from'/src/contexts/AuthContext.jsx';import{LicenseProvider}from'/src/contexts/LicenseContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import Imports from'/src/products/classpilot/pages/Imports.jsx';import'/src/index.css';const h=React.createElement;window.importQueries=()=>queryClient.getQueryCache().getAll().map(q=>q.queryKey);function Harness(){const auth=useAuth();return h(React.Fragment,null,h('button',{onClick:()=>auth.refetchUser()},'Refresh account'),h(Routes,null,h(Route,{path:'/classpilot/my-desk/imports',element:h(Imports)}),h(Route,{path:'/classpilot/my-desk/imports/:importId',element:h(Imports)}),h(Route,{path:'*',element:h('h1',null,'Notebook')})));}createRoot(document.getElementById('root')).render(h(StrictMode,null,h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(AuthProvider,null,h(LicenseProvider,null,h(Harness))))))));`;
before(async () => {
  sourceBytes = await readFile(imagePath); await mkdir(artifacts, { recursive: true });
  server = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-import-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'import-test', configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (!req.url.startsWith('/classpilot/')) return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__imports.jsx"></script></body></html>')); }); }, resolveId(id) { if (id === '/__imports.jsx') return '\0imports'; }, load(id) { if (id === '\0imports') return entry; } }] });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
const roster = [{ id: 'student-a', name: 'Jordan Example' }, { id: 'student-b', name: 'Taylor Sample' }, { id: 'witness', name: 'Morgan Observer' }];
const region = (y = .035) => ({ assetId: 'page-a', x: .05, y, width: .9, height: .44, rotation: 0 });
const item = (id, ordinal, patch = {}) => ({ id, ordinal, revision: 1, regions: [region(ordinal ? .525 : .035)], subjectNames: [ordinal ? 'Taylor Sample' : 'Jordan Example'], groupId: null, studentId: null, rosterRevision: null, category: 'detention', title: ordinal ? 'Referral' : 'Detention', body: 'Please check these details.', entryDate: null, warnings: ['Check handwriting and distinguish witnesses from subjects.'], reviewed: false, excluded: false, extractionStatus: 'ready', approvedAssetId: `approved-${id}`, ...patch });
const fixture = (patch = {}) => ({ id: 'import-a', status: 'review', revision: 1, selectedGroupIds: ['class-a', 'class-b'], pageDecisions: [], expiresAt: '2026-10-02T12:00:00Z', pageCount: 1, assets: [{ id: 'page-a', kind: 'page', status: 'ready', contentType: 'image/jpeg', width: 1600, height: 2000, pageNumber: 1 }], items: [item('form-a', 0), item('form-b', 1)], ...patch });

async function setup({ batch = fixture(), url = '/import-a', viewport } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 1050 } });
  const state = { batch: structuredClone(batch), viewer: 'teacher-a', enabled: true, failCommit: false, failureCode: null, held: false, failProcess: false, failCreate: false, failCancel: false }, requests = [], errors = [], receipts = new Map();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('sp_activeSchoolId', 'school-a'); window.createdUrls = []; window.revokedUrls = []; const create = URL.createObjectURL, revoke = URL.revokeObjectURL; URL.createObjectURL = value => { const url = create(value); window.createdUrls.push(url); return url; }; URL.revokeObjectURL = value => { window.revokedUrls.push(value); revoke(value); }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method();
    const body = ['POST', 'PATCH', 'DELETE'].includes(method) ? request.postDataJSON() : null;
    requests.push({ path: pathname, method, body }); const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (pathname.endsWith('/auth/csrf')) return json({ csrfToken: 'test' });
    if (pathname.endsWith('/auth/me')) return json({ user: { id: state.viewer, firstName: 'Teacher', email: 'teacher@example.school' }, activeSchoolId: 'school-a', memberships: [{ schoolId: 'school-a', schoolName: 'School', schoolTimezone: 'America/New_York', role: 'teacher', roles: ['teacher'] }], licenses: { classPilot: true } });
    assert.equal(request.headers()['x-school-id'], 'school-a');
    if (pathname.endsWith('/capabilities')) return json({ enabled: true, aiImportEnabled: state.enabled, importProvider: 'Anthropic', importLimits: { teacherDailyPages: 123, schoolDailyPages: 456 }, schoolDate: '2026-09-25' });
    if (pathname.endsWith('/classes')) return json({ current: [{ id: 'class-a', name: 'Science 5' }, { id: 'class-b', name: 'Math 5' }], past: [] });
    if (pathname.endsWith('/students')) return json({ students: roster, rosterRevision: 'a'.repeat(64) });
    if (pathname.endsWith('/categories')) return json({ categories: [{ key: 'note', label: 'Note' }, { key: 'detention', label: 'Detention' }, { key: 'behavior', label: 'Behavior' }] });
    if (pathname.endsWith('/imports') && method === 'GET') return json({ imports: state.viewer === 'teacher-a' ? [state.batch] : [], nextCursor: null });
    if (pathname.endsWith('/imports') && method === 'POST') {
      assert.equal(body.expectedSourceCount, 1);
      if (!receipts.has(body.clientRequestId)) { state.batch = fixture({ status: 'uploading', revision: 1, selectedGroupIds: body.selectedGroupIds, assets: [], items: [] }); receipts.set(body.clientRequestId, true); }
      if (state.failCreate) { state.failCreate = false; return json({ error: 'Create response interrupted' }, 503); } return json({ import: state.batch });
    }
    const match = pathname.match(/\/imports\/([^/]+)(.*)$/); if (!match) return json({});
    if (state.viewer !== 'teacher-a') return json({ error: 'Import not found', code: 'MYDESK_IMPORT_NOT_FOUND' }, 404);
    const action = match[2];
    if (action.endsWith('/content') && method === 'GET') return route.fulfill({ contentType: 'image/png', body: sourceBytes });
    if (action.endsWith('/content') && method === 'PUT') { state.batch.revision++; return json({ asset: { id: 'source-a', status: 'ready' } }); }
    if (action === '/assets') { assert.match(body.sha256, /^[a-f0-9]{64}$/); state.batch.revision++; return json({ asset: { id: 'source-a' } }); }
    if (method === 'GET') return json({ import: state.batch });
    if (state.held && method === 'PATCH') await new Promise(resolve => { state.release = resolve; });
    if (receipts.has(body.requestId)) return json({ import: state.batch, receipt: state.batch.commitReceipt });
    if (state.failureCode) { const code = state.failureCode; state.failureCode = null; return json({ error: code === 'MYDESK_IMPORT_ROSTER_CHANGED' ? 'Roster changed. Check the subject again.' : 'This import changed in another tab.', code }, 409); }
    assert.equal(body.revision, state.batch.revision);
    state.batch.revision++;
    if (action === '/process') { state.batch = fixture({ revision: state.batch.revision }); if (state.failProcess) { state.failProcess = false; receipts.set(body.requestId, true); return json({ error: 'Process response interrupted' }, 503); } }
    else if (action === '/commit') { assert.deepEqual(body.itemIds, state.batch.items.filter(item => !item.excluded).map(item => item.id)); assert.ok(state.batch.items.every(item => item.excluded || item.reviewed)); assert.equal(state.batch.pageDecisions.length, state.batch.assets.filter(asset => asset.kind === 'page').length); state.batch.status = 'completed'; state.batch.commitReceipt = { notes: body.itemIds.map((itemId, index) => ({ itemId, noteId: `note-${index}` })) }; }
    else if (method === 'DELETE') { state.batch.status = 'cancelled'; }
    else if (action.startsWith('/items/')) {
      const parts = action.split('/'), current = state.batch.items.find(item => item.id === parts[2]); assert.equal(body.itemRevision, current.revision); current.revision++;
      if (parts[3] === 'reread') { current.title = 'New AI reading'; current.reviewed = false; }
      else if (parts[3] === 'join') { const source = state.batch.items.find(item => item.id === body.sourceItemId); assert.equal(body.sourceItemRevision, source.revision); current.regions.push(...source.regions); source.excluded = true; source.reviewed = false; source.revision++; current.reviewed = false; state.batch.pageDecisions = []; }
      else { Object.assign(current, body); current.reviewed = body.reviewed || false; if (body.regions || Object.hasOwn(body, 'excluded')) state.batch.pageDecisions = []; }
    } else if (action === '/items') state.batch.items.push(item(`new-${state.batch.items.length}`, state.batch.items.length, { regions: body.regions, title: '', body: '' }));
    else Object.assign(state.batch, body, { revision: state.batch.revision });
    receipts.set(body.requestId, true);
    if ((action === '/commit' && state.failCommit) || (method === 'DELETE' && state.failCancel)) { state.failCommit = false; state.failCancel = false; return json({ error: 'Response interrupted. Retry safely.' }, 503); }
    return json({ import: state.batch, receipt: state.batch.commitReceipt });
  });
  await page.goto(`${base}/classpilot/my-desk/imports${url}`); await page.getByRole('heading', { name: url ? 'Review your paperwork' : 'Paperwork', exact: true }).waitFor();
  return { page, state, requests, errors };
}
const forms = page => page.getByRole('button', { name: /2\. Review forms/ }).click();
async function chooseSubject(page, student = 'student-a') { await page.getByLabel('Subject class', { exact: true }).selectOption('class-a'); await page.getByLabel('Subject student', { exact: true }).selectOption(student); await page.getByLabel('Form date', { exact: true }).fill('2026-09-24'); }

test('review each form with an exact subject and explicit date, then atomically commit with a lost-response retry', async () => {
  const { page, state, requests, errors } = await setup();
  await page.getByRole('img', { name: 'Original page 1', exact: true }).waitFor(); await page.screenshot({ path: path.join(artifacts, 'imports-pages-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'All forms on this page are accounted for' }).click(); await forms(page);
  assert.equal(await page.getByLabel('Form date', { exact: true }).inputValue(), ''); assert.equal(await page.getByLabel('Subject student', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: 'Reviewed → Next' }).click(); await page.getByRole('alert').filter({ hasText: 'exact subject' }).waitFor();
  await chooseSubject(page); await page.getByLabel('Form note text').fill('Teacher checked the original, not the witness.'); await page.getByRole('button', { name: 'Reviewed → Next' }).click();
  await page.getByRole('heading', { name: 'Form 2', exact: true }).waitFor(); await chooseSubject(page, 'student-b'); await page.getByRole('button', { name: 'Reviewed → Next' }).click();
  await page.getByRole('heading', { name: 'Save 2 notes together' }).waitFor(); await page.getByText('Science 5 · Jordan Example', { exact: true }).waitFor(); await page.getByText('Science 5 · Taylor Sample', { exact: true }).waitFor();
  state.failCommit = true; await page.getByRole('button', { name: 'Save all 2 notes' }).click(); await page.getByRole('button', { name: 'Retry last action' }).click(); await page.getByRole('heading', { name: 'Your notes are saved.' }).waitFor();
  const commits = requests.filter(request => request.path.endsWith('/commit')); assert.equal(commits.length, 2); assert.deepEqual(commits[0].body, commits[1].body);
  await page.getByRole('button', { name: 'Open saved note 1' }).click(); await page.waitForURL('**/my-desk?note=note-0'); assert.deepEqual(errors, []); await page.close();
});

test('crop controls clamp bounds, undo, rotate, and atomically join a detected continuation without changing teacher text', async () => {
  const { page, state, requests, errors } = await setup();
  await page.getByLabel('Select crop form').selectOption('form-a'); await page.getByRole('button', { name: 'Select form 1 region 1', exact: true }).press('ArrowRight'); assert.equal(await page.getByLabel('Left percent').inputValue(), '5.5'); await page.getByRole('button', { name: 'Undo crop change' }).click(); await page.getByLabel('Left percent').fill('99'); assert.ok(Number(await page.getByLabel('Width percent').inputValue()) <= 1.01);
  await page.getByRole('button', { name: 'Undo crop change' }).click(); assert.equal(await page.getByLabel('Left percent').inputValue(), '5');
  await page.getByRole('button', { name: 'Rotate form 90°' }).click(); await page.getByRole('button', { name: 'Save crop corrections' }).click();
  await page.getByLabel('Select crop form').selectOption('form-a'); await page.getByLabel('Continuation form').selectOption('form-b'); await page.getByRole('button', { name: 'Join continuation', exact: true }).click(); await page.getByRole('alertdialog').getByRole('button', { name: 'Join continuation' }).click();
  await page.getByRole('button', { name: 'All forms on this page are accounted for' }).click(); await forms(page);
  await page.getByRole('img', { name: 'Form 1, part 1', exact: true }).waitFor(); await page.getByRole('img', { name: 'Form 1, part 2', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Form note text').inputValue(), 'Please check these details.'); assert.equal(state.batch.items[1].excluded, true); assert.equal(state.batch.items[0].regions[0].rotation, 90);
  assert.match(await page.getByRole('img', { name: 'Form 1, part 1', exact: true }).locator('g').getAttribute('transform'), /rotate\(90\)/); assert.ok(requests.some(request => request.path.endsWith('/join')));
  await page.screenshot({ path: path.join(artifacts, 'imports-continuation-desktop.png'), fullPage: true }); assert.deepEqual(errors, []); await page.close();
});

test('phone review saves unfinished blank dates, resumes private progress, and explicitly rereads only after confirmation', async () => {
  const { page, state, requests } = await setup({ viewport: { width: 390, height: 844 } }); await forms(page); await page.getByRole('button', { name: 'Student and details', exact: true }).click();
  await page.getByLabel('Form title').fill('Checked later'); await page.getByRole('button', { name: 'Save for later', exact: true }).click(); await page.waitForURL('**/imports'); assert.equal(state.batch.items[0].entryDate, null);
  await page.getByRole('button', { name: 'Resume review' }).click(); await forms(page); await page.screenshot({ path: path.join(artifacts, 'imports-preview-mobile.png'), fullPage: true, animations: 'disabled' }); await page.getByRole('button', { name: 'Student and details', exact: true }).click(); assert.equal(await page.getByLabel('Form title').inputValue(), 'Checked later');
  await page.waitForFunction(() => { const active = document.querySelector('.import-mobile-pane-tabs button[aria-pressed=true]'); return active && getComputedStyle(active).backgroundColor === 'rgb(7, 89, 182)' && getComputedStyle(active).color === 'rgb(255, 255, 255)'; });
  const colors = await page.locator('.import-mobile-pane-tabs button').evaluateAll(buttons => buttons.map(button => { const style = getComputedStyle(button); return { label: button.textContent, active: button.getAttribute('aria-pressed') === 'true', color: style.color, background: style.backgroundColor, opacity: style.opacity, disabled: button.disabled }; }));
  assert.ok(colors.every(button => button.opacity === '1' && !button.disabled)); assert.equal(colors.find(button => button.active).background, 'rgb(7, 89, 182)');
  await writeFile(path.join(artifacts, 'imports-mobile-pane-colors.json'), JSON.stringify(colors, null, 2));
  await page.screenshot({ path: path.join(artifacts, 'imports-form-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Form image', exact: true }).click(); await page.getByRole('button', { name: 'Zoom in form' }).click(); await page.getByRole('button', { name: 'Student and details', exact: true }).click(); assert.equal(await page.getByLabel('Form title').inputValue(), 'Checked later'); await page.getByRole('button', { name: 'Form image', exact: true }).click(); await page.getByRole('button', { name: 'Re-read corrected form' }).click(); assert.equal(requests.filter(request => request.path.endsWith('/reread')).length, 0); await page.getByRole('button', { name: 'Replace draft with new reading' }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="Form title"]')?.value === 'New AI reading'); await page.close();
});

test('roster validation rejection preserves editable text; true revision conflicts preserve draft until explicit reload', async () => {
  const { page, state } = await setup(); await forms(page); await chooseSubject(page); await page.getByLabel('Form note text').fill('Do not lose this correction'); state.failureCode = 'MYDESK_IMPORT_ROSTER_CHANGED'; await page.getByRole('button', { name: 'Reviewed → Next' }).click(); await page.getByText('Roster changed. Check the subject again.').waitFor(); assert.equal(await page.getByLabel('Form note text').inputValue(), 'Do not lose this correction'); assert.equal(await page.getByLabel('Form note text').isEnabled(), true);
  await page.getByLabel('Form title').fill('Teacher edit'); state.failureCode = 'MYDESK_IMPORT_REVISION_CONFLICT'; await page.getByRole('button', { name: 'Save draft changes' }).click(); await page.getByRole('button', { name: 'Reload saved review', exact: true }).click(); await page.getByRole('alertdialog').waitFor(); assert.equal(await page.getByLabel('Form note text').inputValue(), 'Do not lose this correction'); await page.getByRole('button', { name: 'Keep reviewing' }).click(); assert.equal(await page.getByLabel('Form note text').inputValue(), 'Do not lose this correction'); await page.close();
});

test('account switch clears source blobs and refuses late callbacks from the old editor', async () => {
  const { page, state } = await setup(); await forms(page); await page.getByRole('img', { name: 'Form 1, part 1', exact: true }).waitFor(); await page.getByLabel('Form note text').fill('Private to Alice'); state.held = true; await page.getByRole('button', { name: 'Save draft changes' }).click(); await page.waitForTimeout(100); state.viewer = 'teacher-b'; await page.getByRole('button', { name: 'Refresh account' }).click(); await page.getByRole('heading', { name: 'Import unavailable' }).waitFor(); state.release(); await page.waitForTimeout(150);
  assert.equal(await page.getByText('Private to Alice').count(), 0); const urls = await page.evaluate(() => ({ created: window.createdUrls, revoked: window.revokedUrls, keys: window.importQueries() })); assert.ok(urls.created.length); assert.ok(urls.created.every(url => urls.revoked.includes(url))); assert.ok(!urls.keys.some(key => key[2] === 'teacher-a')); await page.close();
});

test('upload performs only explicit AI start and reuses process request after response loss; explicit cancellation removes reserved import', async () => {
  const { page, state, requests } = await setup({ url: '' }); await page.getByRole('button', { name: 'New import' }).click(); await page.getByText('123 pages per teacher', { exact: true }).waitFor(); await page.getByText('456 pages per school', { exact: true }).waitFor(); await page.getByLabel('Science 5', { exact: true }).check(); await page.locator('input[type=file][multiple]').setInputFiles(imagePath); await page.screenshot({ path: path.join(artifacts, 'imports-upload-desktop.png'), fullPage: true }); assert.equal(requests.filter(request => request.path.endsWith('/process')).length, 0);
  state.failProcess = true; await page.getByRole('button', { name: 'Send files and prepare drafts' }).click(); await page.getByRole('button', { name: 'Retry import' }).click(); await page.getByRole('heading', { name: 'Review your paperwork' }).waitFor(); const processes = requests.filter(request => request.path.endsWith('/process')); assert.equal(processes.length, 2); assert.deepEqual(processes[0].body, processes[1].body); await page.close();
  const second = await setup({ url: '' }); await second.page.getByRole('button', { name: 'New import' }).click(); await second.page.getByLabel('Science 5', { exact: true }).check(); await second.page.locator('input[type=file][multiple]').setInputFiles(imagePath); second.state.failCreate = true; await second.page.getByRole('button', { name: 'Send files and prepare drafts' }).click(); await second.page.getByRole('button', { name: 'Retry import' }).waitFor(); second.state.failCancel = true; await second.page.getByRole('button', { name: 'Cancel', exact: true }).click(); await second.page.getByRole('button', { name: 'Cancel upload' }).click(); await second.page.getByRole('button', { name: 'Retry cancellation' }).click(); await second.page.getByRole('heading', { name: 'Gather your paperwork' }).waitFor({ state: 'hidden' }); assert.equal(second.state.batch.status, 'cancelled'); const deletes = second.requests.filter(request => request.method === 'DELETE'); assert.deepEqual(deletes[0].body, deletes[1].body); await second.page.close();
});

test('a reopened fully uploaded source manifest needs an explicit start before processing', async () => {
  const { page, requests } = await setup({ batch: fixture({ status: 'uploading', expectedSourceCount: 1, items: [], assets: [{ id: 'source-a', kind: 'source', status: 'ready', contentType: 'application/pdf' }] }) });
  await page.getByRole('heading', { name: 'Your files are ready.' }).waitFor(); assert.equal(requests.filter(request => request.path.endsWith('/process')).length, 0);
  await page.getByRole('button', { name: 'Send files and prepare drafts' }).click(); await page.getByRole('button', { name: /1\. Check pages/ }).waitFor(); assert.equal(requests.filter(request => request.path.endsWith('/process')).length, 1); await page.close();
});
