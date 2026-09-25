import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const entry = `import React,{StrictMode,useState} from 'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{MyDeskNotebook}from'/src/products/classpilot/pages/MyDesk.jsx';import'/src/index.css';const h=React.createElement;function Harness(){const[who,setWho]=useState({schoolId:'school-a',viewerId:'teacher-a'});return h(React.Fragment,null,h('button',{onClick:()=>setWho({schoolId:'school-a',viewerId:'teacher-b'})},'Switch author'),h('button',{onClick:()=>setWho({schoolId:'school-b',viewerId:'teacher-a'})},'Switch school'),h('div',{className:'mydesk-page'},h(MyDeskNotebook,{key:who.schoolId+who.viewerId,...who,today:'2026-09-25',timeZone:'America/New_York'})));}createRoot(document.getElementById('root')).render(h(StrictMode,null,h(QueryClientProvider,{client:queryClient},h(Harness))));`;
const authEntry = `import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{AuthProvider,useAuth}from'/src/contexts/AuthContext.jsx';import{LicenseProvider}from'/src/contexts/LicenseContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import MyDesk from'/src/products/classpilot/pages/MyDesk.jsx';import{myDeskApi}from'/src/products/classpilot/lib/myDesk.js';import'/src/index.css';const h=React.createElement;window.captureNotebookClient=()=>{const api=myDeskApi('school-a');return()=>api.get('/categories');};window.notebookCache=()=>queryClient.getQueriesData({queryKey:['mydesk-private']});window.refreshNotebookAccess=()=>queryClient.invalidateQueries({queryKey:['mydesk-private','school-a','teacher-a','capabilities']});function Harness(){const auth=useAuth();return h(React.Fragment,null,h('button',{onClick:()=>auth.refetchUser()},'Refresh account'),h('button',{onClick:async()=>{await auth.acceptToken('replacement-test-token');await auth.refetchUser();}},'Replace credential'),h('button',{onClick:()=>auth.logout()},'Sign out'),h('button',{onClick:()=>auth.switchSchool('school-b')},'Change school'),h(MyDesk));}createRoot(document.getElementById('root')).render(h(StrictMode,null,h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(AuthProvider,null,h(LicenseProvider,null,h(Harness))))))));`;

before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-my-desk-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'mydesk-browser-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (!['/__mydesk','/__mydesk-auth'].includes(req.url)) return next(); const script = req.url === '/__mydesk-auth' ? '/__mydesk-auth-entry.jsx' : '/__mydesk-entry.jsx'; res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, `<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`)); }); }, resolveId(id) { if (id === '/__mydesk-entry.jsx') return '\0mydesk-entry'; if (id === '/__mydesk-auth-entry.jsx') return '\0mydesk-auth-entry'; }, load(id) { if (id === '\0mydesk-entry') return entry; if (id === '\0mydesk-auth-entry') return authEntry; } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const fixtureNote = (patch = {}) => ({ id: 'saved', schoolId: 'school-a', authorId: 'teacher-a', targetKind: 'general', category: 'note', title: 'Remember the science trays', body: 'Set out the blue trays before class.', entryDate: '2026-09-25', status: 'active', revision: 1, pinned: false, attachments: [], ...patch });

async function setup({ initial = [], failCreate = false, failUpload = false, delayUpload = false, viewport, auth = false } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 1280, height: 900 } });
  const errors = [], requests = [], creates = [], uploadBodies = [], completeBodies = [], revoked = [];
  const state = { notes: [...initial], viewer: 'teacher-a', failCreate, failUpload, delayUpload, releaseUpload: null, role: 'teacher', impersonating: false, enabled: true };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('sp_activeSchoolId', 'school-a'); window.__revokedUrls = []; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.__revokedUrls.push(url); revoke(url); }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    requests.push({ method, path: url.pathname, query: url.pathname.endsWith('/notes/search') || (url.pathname.endsWith('/export') && method === 'POST') ? request.postDataJSON() : Object.fromEntries(url.searchParams), school: request.headers()['x-school-id'] });
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (url.pathname.endsWith('/auth/csrf')) return json({ csrfToken: 'test' });
    if (url.pathname.endsWith('/auth/logout')) return json({ ok: true });
    if (url.pathname.endsWith('/auth/me')) {
      if (state.delayMe) await new Promise(resolve => { state.releaseMe = resolve; });
      return json({ user: { id: state.viewer, firstName: 'Teacher', lastName: 'Example', email: 'teacher@example.school', impersonating: state.impersonating }, activeSchoolId: request.headers()['x-school-id'] || 'school-a', memberships: ['school-a','school-b'].map(schoolId => ({ id: `${state.viewer}-${schoolId}`, schoolId, schoolName: 'Example School', schoolTimezone: 'America/New_York', role: state.role, roles: [state.role] })), licenses: { classPilot: true } });
    }
    assert.equal(request.headers()['x-school-id']?.startsWith('school-'), true);
    if (url.pathname.endsWith('/capabilities')) return state.denyCapability ? json({ error: 'Membership revoked' }, 403) : json({ enabled: state.enabled, schoolDate: '2026-09-25' });
    if (url.pathname.endsWith('/categories')) return json({ categories: [{ key: 'note', label: 'Note' }, { key: 'detention', label: 'Detention' }] });
    if (url.pathname.endsWith('/classes')) return json({ current: [{ id: 'class-a', name: 'Science 5' }], past: [{ id: 'past-class', name: 'Last year' }] });
    if (url.pathname.endsWith('/classes/class-a/students')) return json({ students: [{ id: 'student-a', firstName: 'Avery', lastName: 'Lee', name: 'Avery Lee' }] });
    if (url.pathname.endsWith('/note-students')) return json({ students: [{ id: 'student-a', name: 'Avery Lee' }, { id: 'past-student', name: 'Former classmate' }] });
    if (url.pathname.endsWith('/export')) { assert.equal(method, 'POST'); assert.equal(url.search, ''); return route.fulfill({ contentType: 'text/csv', body: 'title,body\nPrivate export,Only mine' }); }
    if (url.pathname.endsWith('/notes/search') && method === 'POST') {
      assert.equal(url.search, '');
      const search = new URLSearchParams(request.postDataJSON());
      for (const key of search.keys()) assert(['scope','classId','studentId','category','from','to','q','cursor','limit'].includes(key));
      let rows = state.notes.filter(note => note.status === 'active' && note.schoolId === request.headers()['x-school-id'] && note.authorId === state.viewer);
      if (search.get('category')) rows = rows.filter(note => note.category === search.get('category'));
      if (search.get('q')) rows = rows.filter(note => `${note.title} ${note.body}`.includes(search.get('q')));
      if (search.get('scope') === 'general') rows = rows.filter(note => note.targetKind === 'general');
      if (search.get('scope') === 'class') rows = rows.filter(note => note.groupId === search.get('classId'));
      if (search.get('scope') === 'past') rows = rows.filter(note => note.groupId === 'past-class');
      if (search.get('classId')) rows = rows.filter(note => (note.filingGroupId || note.groupId) === search.get('classId'));
      if (search.get('studentId')) rows = rows.filter(note => (note.filingStudentId || note.studentId) === search.get('studentId'));
      return json({ notes: rows.sort((a,b) => Number(b.pinned)-Number(a.pinned) || b.entryDate.localeCompare(a.entryDate)), nextCursor: null });
    }
    if (url.pathname.endsWith('/notes') && method === 'POST') {
      const body = request.postDataJSON(); creates.push(body); assert(body.clientRequestId); assert(!('visibility' in body));
      let note = state.notes.find(item => item.clientRequestId === body.clientRequestId);
      if (!note) { note = fixtureNote({ ...body, id: `new-${state.notes.length}`, schoolId: request.headers()['x-school-id'], authorId: state.viewer, status: 'pending', attachments: [] }); state.notes.push(note); }
      if (state.failCreate) { state.failCreate = false; return json({ error: 'Save response interrupted. Try again.' }, 503); }
      return json({ note });
    }
    const match = url.pathname.match(/\/notes\/([^/]+)(.*)$/);
    if (match) {
      const note = state.notes.find(item => item.id === match[1] && item.status !== 'deleted'); if (!note) return json({ error: 'Not found', code: 'MYDESK_NOTE_NOT_FOUND' }, 404);
      const suffix = match[2];
      if (!suffix && method === 'GET') return json({ note });
      if (!suffix && method === 'DELETE') { assert(request.postDataJSON().revision); note.status = 'deleted'; if (state.failDeleteResponse) { state.failDeleteResponse = false; return json({ error: 'Delete response interrupted' }, 503); } return json({ ok: true }); }
      if (!suffix && method === 'PATCH') { const body = request.postDataJSON(); assert.equal(body.revision, note.revision); Object.assign(note, body, { revision: note.revision + 1 }); return json({ note }); }
      if (suffix === '/complete') {
        const body = request.postDataJSON(); completeBodies.push(body); assert.equal(body.revision, note.revision);
        const attachments = note.attachments.filter(item => body.attachmentIds.includes(item.id)).map(item => ({ ...item, committedAt: '2026-09-25T12:00:00Z' })); Object.assign(note, body, { status: 'active', revision: note.revision+1, updatedAt: '2026-09-25T12:00:00Z', attachments }); if (state.failCompleteResponse) { state.failCompleteResponse = false; return json({ error: 'Complete response interrupted' }, 503); } return json({ note });
      }
      if (suffix === '/attachments' && method === 'POST') {
        const body = request.postDataJSON(); assert.match(body.sha256, /^[a-f0-9]{64}$/);
        let attachment = note.attachments.find(item => item.clientRequestId === body.clientRequestId);
        if (!attachment) { attachment = { id: `attachment-${note.attachments.length}`, noteId: note.id, ...body, originalFilename: body.filename, byteSize: body.size, status: 'pending' }; note.attachments.push(attachment); }
        return json({ attachment });
      }
      const attachmentId = suffix.split('/')[2], attachment = note.attachments.find(item => item.id === attachmentId);
      if (suffix.endsWith('/content') && method === 'PUT') {
        uploadBodies.push({ bytes: request.postDataBuffer(), contentType: request.headers()['content-type'], noteId: note.id, attachmentId });
        if (state.delayUpload) await new Promise(resolve => { state.releaseUpload = resolve; });
        if (state.failUpload || state.failUploadAt === uploadBodies.length) { state.failUpload = false; return json({ error: 'Upload interrupted' }, 503); }
        attachment.status = 'ready'; return json({ attachment });
      }
      if (suffix.endsWith('/content') && method === 'GET') return route.fulfill({ contentType: attachment.contentType, body: png });
      if (method === 'DELETE' && attachment) { note.attachments = note.attachments.filter(item => item.id !== attachment.id); note.revision++; return json({ ok: true }); }
    }
    return json({ error: `Unexpected route ${method} ${url.pathname}` }, 404);
  });
  await page.goto(`${base}/${auth ? '__mydesk-auth' : '__mydesk'}`);
  try { await page.getByRole('heading', { name: 'My Desk', exact: true }).waitFor({ timeout: 12000 }); }
  catch (failure) { throw new Error(`${failure.message}\nPage errors: ${errors.join('\n')}\n${await page.locator('body').innerText()}`); }
  return { page, state, errors, requests, creates, uploadBodies, completeBodies, revoked };
}

async function screenshot(page, name) {
  if (!process.env.MYDESK_SCREENSHOT_DIR) return;
  await mkdir(process.env.MYDESK_SCREENSHOT_DIR, { recursive: true });
  const target = await page.getByRole('dialog').count() ? page.getByRole('dialog') : page.locator('.mydesk-page');
  await target.screenshot({ path: path.join(process.env.MYDESK_SCREENSHOT_DIR, name) });
}

test('private photo-only save survives uncertain reservation and upload retries without duplication', { timeout: 60_000 }, async () => {
  const t = await setup({ failCreate: true, failUpload: true });
  try {
    await t.page.getByRole('button', { name: 'New note', exact: true }).click();
    await t.page.getByLabel('Choose photos or PDF').setInputFiles({ name: 'slip.png', mimeType: 'image/png', buffer: png });
    await t.page.getByRole('button', { name: 'Save note', exact: true }).click();
    await t.page.getByText('Save response interrupted. Try again.', { exact: true }).waitFor();
    await t.page.getByRole('button', { name: 'Retry save' }).click();
    await t.page.getByText('Failed: Upload interrupted', { exact: true }).waitFor();
    assert.equal(await t.page.getByRole('button', { name: 'Finish with uploaded files' }).count(), 0);
    await t.page.getByRole('button', { name: 'Retry save' }).click();
    await t.page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(t.state.notes.length, 1); assert.equal(t.state.notes[0].attachments.length, 1); assert.equal(t.state.notes[0].status, 'active');
    assert.equal(new Set(t.creates.map(item => item.clientRequestId)).size, 1); assert.equal(t.uploadBodies.length, 2); assert.deepEqual(t.uploadBodies[0].bytes, png);
    await t.page.getByRole('button', { name: 'View attachments (1)' }).click();
    try { await t.page.getByRole('img', { name: 'slip.png' }).waitFor({ timeout: 8000 }); } catch (failure) { throw new Error(`${failure.message}\n${await t.page.locator('body').innerText()}\n${t.errors.join('\n')}\n${JSON.stringify(t.requests)}`); }
    await t.page.getByRole('button', { name: 'Hide attachments (1)' }).click(); assert((await t.page.evaluate(() => window.__revokedUrls)).length > 0);
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); assert.equal(await t.page.getByLabel('Title optional', { exact: true }).inputValue(), ''); assert.equal(await t.page.getByRole('list', { name: 'Attachments' }).count(), 0);
    assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('notes can be filed, filtered, pinned, edited, exported and explicitly deleted', { timeout: 60_000 }, async () => {
  const t = await setup({ initial: [fixtureNote()] });
  try {
    const card = t.page.getByRole('article', { name: 'Remember the science trays' }); await card.waitFor();
    await screenshot(t.page, 'mydesk-desktop.png');
    await card.getByRole('button', { name: 'Pin', exact: true }).click(); await card.getByRole('button', { name: 'Unpin' }).waitFor();
    await card.getByRole('button', { name: 'Edit / refile' }).click();
    await t.page.getByLabel('File under', { exact: true }).selectOption('student'); await t.page.getByLabel('Class', { exact: true }).selectOption('class-a');
    await t.page.getByLabel('Student', { exact: true }).selectOption('student-a'); await t.page.getByLabel('Category', { exact: true }).last().selectOption('detention');
    await t.page.getByLabel('Title optional', { exact: true }).fill('Follow up with Avery'); await t.page.getByRole('button', { name: 'Save changes' }).click();
    await t.page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(t.state.notes[0].studentId, 'student-a');
    await t.page.getByRole('button', { name: 'Science 5', exact: true }).click(); await t.page.getByLabel('Category', { exact: true }).selectOption('detention');
    await t.page.getByRole('article', { name: 'Follow up with Avery' }).waitFor(); assert(t.requests.some(item => item.query.category === 'detention' && item.query.classId === 'class-a'));
    await t.page.getByLabel('Search notes', { exact: true }).fill('Follow up');
    const download = t.page.waitForEvent('download'); await t.page.getByRole('button', { name: 'Export CSV' }).click(); assert.equal((await download).suggestedFilename(), 'My-Desk-notes.csv');
    assert(t.requests.some(item => item.path.endsWith('/export') && item.query.q === 'Follow up'));
    await t.page.getByRole('article').getByRole('button', { name: 'Delete', exact: true }).click(); await t.page.getByRole('button', { name: 'Keep note' }).click(); assert.equal(t.state.notes[0].status, 'active');
    await t.page.getByRole('article').getByRole('button', { name: 'Delete', exact: true }).click(); await t.page.getByRole('button', { name: 'Delete note', exact: true }).click(); await t.page.getByRole('article').waitFor({ state: 'hidden' }); assert.equal(t.state.notes[0].status, 'deleted'); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('scope changes fence pending saves and never display the prior author notebook', { timeout: 60_000 }, async () => {
  const t = await setup({ initial: [fixtureNote()], delayUpload: true });
  try {
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); await t.page.getByLabel('Title optional', { exact: true }).fill('Delayed draft');
    await t.page.getByLabel('Choose photos or PDF').setInputFiles({ name: 'delayed.png', mimeType: 'image/png', buffer: png }); await t.page.getByRole('button', { name: 'Save note', exact: true }).click();
    await t.page.getByText('Uploading…', { exact: true }).waitFor();
    t.state.viewer = 'teacher-b'; await t.page.getByRole('button', { name: 'Switch author', exact: true, includeHidden: true }).evaluate(button => button.click());
    await t.page.getByRole('dialog').waitFor({ state: 'hidden' }); await t.page.getByText('A little space to remember.', { exact: true }).waitFor();
    t.state.releaseUpload?.(); assert.equal(await t.page.getByText('Remember the science trays', { exact: true }).count(), 0);
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); assert.equal(await t.page.getByLabel('Title optional', { exact: true }).inputValue(), '');
    assert.equal(t.completeBodies.length, 0); assert.deepEqual(t.errors, []);
  } finally { t.state.releaseUpload?.(); await t.page.close(); }
});

test('phone layout, file capture, PDF bytes and cancel preserve a single accessible save flow', { timeout: 60_000 }, async () => {
  const t = await setup({ viewport: { width: 390, height: 844 }, failUpload: true });
  try {
    assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); assert.equal(await t.page.getByLabel('Take a photo', { exact: true }).getAttribute('capture'), 'environment');
    const bounds = await t.page.getByRole('dialog').boundingBox(); assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844);
    await screenshot(t.page, 'mydesk-mobile-composer.png');
    const pdf = Buffer.from('%PDF-1.4\nprivate paper\n%%EOF');
    await t.page.getByLabel('Choose photos or PDF').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: pdf });
    await t.page.getByRole('button', { name: 'Save note', exact: true }).click(); await t.page.getByText('Failed: Upload interrupted', { exact: true }).waitFor();
    await t.page.getByRole('button', { name: 'Retry save' }).click(); await t.page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.deepEqual(t.uploadBodies.at(-1).bytes, pdf); assert.equal(t.uploadBodies.at(-1).contentType, 'application/pdf');
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); await t.page.getByLabel('Title optional', { exact: true }).fill('Discard me'); await t.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await t.page.getByRole('button', { name: 'Discard draft', exact: true }).click(); await t.page.getByRole('dialog').waitFor({ state: 'hidden' });
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); assert.equal(await t.page.getByLabel('Title optional', { exact: true }).inputValue(), ''); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('partial saves can finish only with frozen text or successfully uploaded attachments', { timeout: 60_000 }, async () => {
  for (const hasText of [true, false]) {
    const t = await setup({ failUpload: hasText });
    try {
      await t.page.getByRole('button', { name: 'New note', exact: true }).click();
      if (hasText) await t.page.getByLabel('Title optional', { exact: true }).fill('Keep this reminder');
      else t.state.failUploadAt = 2;
      const uploads = [{ name: 'first.png', mimeType: 'image/png', buffer: png }];
      if (!hasText) uploads.push({ name: 'second.png', mimeType: 'image/png', buffer: png });
      await t.page.getByLabel('Choose photos or PDF').setInputFiles(uploads);
      await t.page.getByRole('button', { name: 'Save note', exact: true }).click();
      await t.page.getByText('Failed: Upload interrupted', { exact: true }).waitFor();
      await t.page.getByRole('button', { name: 'Finish with uploaded files' }).click();
      await t.page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(t.state.notes[0].status, 'active'); assert.equal(t.state.notes[0].attachments.length, hasText ? 0 : 1);
      assert.equal(t.uploadBodies.length, hasText ? 1 : 2); assert.deepEqual(t.errors, []);
    } finally { await t.page.close(); }
  }
});

test('class and past-class student filters retain filed notes after a roster change', { timeout: 60_000 }, async () => {
  const t = await setup({ initial: [
    fixtureNote({ id: 'former-current', title: 'A former classmate', targetKind: 'student', groupId: 'class-a', filingGroupId: 'class-a', studentId: null, filingStudentId: 'past-student', studentName: 'Former classmate' }),
    fixtureNote({ id: 'former-past', title: 'Last year reminder', targetKind: 'student', groupId: 'past-class', filingGroupId: 'past-class', studentId: null, filingStudentId: 'past-student', studentName: 'Former classmate' }),
  ] });
  try {
    await t.page.getByRole('button', { name: 'Science 5', exact: true }).click();
    await t.page.getByLabel('Student', { exact: true }).selectOption('past-student');
    await t.page.getByRole('article', { name: 'A former classmate' }).waitFor();
    await t.page.getByRole('button', { name: 'Past classes', exact: true }).click();
    await t.page.getByLabel('Past class', { exact: true }).selectOption('past-class');
    await t.page.getByLabel('Student', { exact: true }).selectOption('past-student');
    await t.page.getByRole('article', { name: 'Last year reminder' }).waitFor();
    assert(t.requests.some(item => item.query.scope === 'past' && item.query.classId === 'past-class' && item.query.studentId === 'past-student'));
    assert(!t.requests.some(item => item.path.endsWith('/students'))); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('credential handoff suspends private queries until the replacement identity is resolved', { timeout: 60_000 }, async () => {
  const t = await setup({ auth: true, initial: [fixtureNote()], delayUpload: true });
  try {
    await t.page.getByRole('article').waitFor();
    await t.page.evaluate(() => { window.retiredNotebookRequest = window.captureNotebookClient(); });
    await t.page.getByRole('button', { name: 'New note', exact: true }).click();
    await t.page.getByLabel('Choose photos or PDF').setInputFiles({ name: 'delayed.png', mimeType: 'image/png', buffer: png });
    await t.page.getByRole('button', { name: 'Save note', exact: true }).click(); await t.page.getByText('Uploading…', { exact: true }).waitFor();
    t.state.delayMe = true;
    const meRequest = t.page.waitForRequest(request => request.url().endsWith('/api/auth/me') && request.headers().authorization === 'Bearer replacement-test-token');
    await t.page.getByRole('button', { name: 'Replace credential', includeHidden: true }).evaluate(button => button.click()); await meRequest;
    await t.page.getByRole('heading', { name: 'My Desk is unavailable' }).waitFor();
    assert.equal(await t.page.getByRole('article').count(), 0);
    assert.equal(await t.page.evaluate(() => window.notebookCache().some(([, data]) => data !== undefined)), false);
    const privateRequestsBeforeIdentity = t.requests.filter(item => item.path.includes('/mydesk/')).length;
    assert.equal(await t.page.evaluate(() => window.retiredNotebookRequest().then(() => 'unexpected success', error => error.name)), 'AbortError');
    t.state.releaseUpload();
    await t.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(t.requests.filter(item => item.path.includes('/mydesk/')).length, privateRequestsBeforeIdentity);
    assert.equal(t.completeBodies.length, 0);
    t.state.viewer = 'teacher-b'; t.state.delayMe = false; t.state.releaseMe();
    await t.page.getByText('A little space to remember.', { exact: true }).waitFor();
    assert.equal(await t.page.evaluate(() => window.notebookCache().some(([key, data]) => key[2] === 'teacher-a' && data !== undefined)), false);
    assert.deepEqual(t.errors, []);
  } finally { t.state.releaseMe?.(); t.state.releaseUpload?.(); await t.page.close(); }
});

test('a denied capability refresh hides previously cached notes and revokes open blobs', { timeout: 60_000 }, async () => {
  const t = await setup({ auth: true, initial: [fixtureNote({ attachments: [{ id: 'photo', originalFilename: 'private.png', contentType: 'image/png', status: 'ready', committedAt: '2026-09-25T12:00:00Z' }] })] });
  try {
    await t.page.getByRole('button', { name: 'View attachments (1)' }).click(); await t.page.getByRole('img', { name: 'private.png' }).waitFor();
    t.state.denyCapability = true; await t.page.evaluate(() => window.refreshNotebookAccess());
    await t.page.getByRole('heading', { name: 'My Desk is unavailable' }).waitFor();
    assert.equal(await t.page.getByRole('article').count(), 0); assert((await t.page.evaluate(() => window.__revokedUrls)).length > 0); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('cancel recovers a lost delete response without trapping a discarded reservation', { timeout: 60_000 }, async () => {
  const t = await setup({ failUpload: true });
  try {
    await t.page.getByRole('button', { name: 'New note', exact: true }).click();
    await t.page.getByLabel('Choose photos or PDF').setInputFiles({ name: 'cancel.png', mimeType: 'image/png', buffer: png });
    assert.equal(await t.page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
    await t.page.getByRole('button', { name: 'Save note', exact: true }).click(); await t.page.getByText('Failed: Upload interrupted', { exact: true }).waitFor();
    t.state.failDeleteResponse = true;
    await t.page.getByRole('button', { name: 'Cancel', exact: true }).click(); await t.page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await t.page.getByText(/Could not cancel the saved draft/).waitFor(); assert.equal(t.state.notes[0].status, 'deleted');
    await t.page.getByRole('button', { name: 'Cancel', exact: true }).click(); await t.page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await t.page.getByRole('dialog').waitFor({ state: 'hidden' });
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); assert.equal(await t.page.getByRole('list', { name: 'Attachments' }).count(), 0); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('cancel after a lost complete response preserves committed new and edited notes', { timeout: 60_000 }, async () => {
  for (const editing of [false, true]) {
    const t = await setup({ initial: editing ? [fixtureNote({ revision: 2 })] : [] });
    try {
      await t.page.getByRole('button', { name: editing ? 'Edit / refile' : 'New note', exact: true }).click();
      await t.page.getByLabel('Title optional', { exact: true }).fill('Already saved');
      await t.page.getByLabel('Choose photos or PDF').setInputFiles({ name: 'saved.png', mimeType: 'image/png', buffer: png });
      t.state.failCompleteResponse = true;
      await t.page.getByRole('button', { name: editing ? 'Save changes' : 'Save note', exact: true }).click(); await t.page.getByText('Complete response interrupted', { exact: true }).waitFor();
      await t.page.getByRole('button', { name: 'Cancel', exact: true }).click(); await t.page.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await t.page.getByRole('dialog').waitFor({ state: 'hidden' }); await t.page.getByRole('article', { name: 'Already saved' }).waitFor();
      assert.equal(t.state.notes[0].attachments.length, 1); assert(t.state.notes[0].attachments[0].committedAt); assert(!t.requests.some(item => item.method === 'DELETE'));
      if (editing) assert.match(await t.page.getByRole('article').innerText(), /Updated/);
      assert.deepEqual(t.errors, []);
    } finally { await t.page.close(); }
  }
});

test('real auth transitions purge private caches, revoke blobs and gate impersonation and school changes', { timeout: 60_000 }, async () => {
  const attachment = { id: 'photo', noteId: 'saved', originalFilename: 'private.png', contentType: 'image/png', status: 'ready', committedAt: '2026-09-25T12:00:00Z' };
  const t = await setup({ auth: true, initial: [fixtureNote({ attachments: [attachment] })] });
  try {
    await t.page.getByRole('button', { name: 'View attachments (1)' }).click(); await t.page.getByRole('img', { name: 'private.png' }).waitFor();
    t.state.viewer = 'teacher-b'; await t.page.getByRole('button', { name: 'Refresh account' }).click();
    await t.page.getByText('A little space to remember.', { exact: true }).waitFor();
    assert.equal(await t.page.getByRole('article').count(), 0);
    assert((await t.page.evaluate(() => window.__revokedUrls)).length > 0);
    assert.equal(await t.page.evaluate(() => window.notebookCache().some(([key]) => key[2] === 'teacher-a')), false);
    await t.page.getByRole('button', { name: 'New note', exact: true }).click(); await t.page.getByLabel('Title optional', { exact: true }).fill('Must disappear');
    t.state.impersonating = true; await t.page.getByRole('button', { name: 'Refresh account', includeHidden: true }).evaluate(button => button.click());
    await t.page.getByRole('heading', { name: 'My Desk is unavailable' }).waitFor(); assert.equal(await t.page.getByRole('dialog').count(), 0);
    t.state.impersonating = false; await t.page.getByRole('button', { name: 'Refresh account' }).click(); await t.page.getByRole('button', { name: 'New note', exact: true }).click(); assert.equal(await t.page.getByLabel('Title optional', { exact: true }).inputValue(), '');
    await t.page.getByRole('button', { name: 'Cancel', exact: true }).click(); await t.page.getByRole('button', { name: 'Change school' }).click();
    await t.page.getByRole('heading', { name: 'My Desk', exact: true }).waitFor(); assert(t.requests.some(item => item.path.endsWith('/capabilities') && item.school === 'school-b'));
    assert.equal(await t.page.evaluate(() => window.notebookCache().some(([key]) => key[1] === 'school-a')), false);
    await t.page.getByRole('button', { name: 'Sign out' }).click(); await t.page.getByRole('heading', { name: 'My Desk is unavailable' }).waitFor(); assert.equal(await t.page.evaluate(() => window.notebookCache().filter(([,data])=>data !== undefined).length), 0); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});
