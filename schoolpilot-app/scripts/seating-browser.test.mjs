import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createLayout, emptyLayoutCopy } from '../src/products/classpilot/lib/seatingModel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = process.env.MYDESK_SCREENSHOT_DIR || path.resolve(root, '../../artifacts');
let server, browser, base;
const entry = `import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import{BrowserRouter,Routes,Route}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{AuthProvider,useAuth}from'/src/contexts/AuthContext.jsx';import{LicenseProvider}from'/src/contexts/LicenseContext.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import Seating from'/src/products/classpilot/pages/Seating.jsx';import'/src/index.css';const h=React.createElement;window.refreshSeatingQueries=()=>queryClient.invalidateQueries({queryKey:['mydesk-private']});function Harness(){const auth=useAuth();return h(React.Fragment,null,h('button',{onClick:()=>auth.refetchUser()},'Refresh account'),h(Routes,null,h(Route,{path:'/classpilot/my-desk/seating',element:h(Seating)}),h(Route,{path:'/classpilot/my-desk/seating/:chartId',element:h(Seating)}),h(Route,{path:'*',element:h('h1',null,'Another page')})));}createRoot(document.getElementById('root')).render(h(StrictMode,null,h(QueryClientProvider,{client:queryClient},h(BrowserRouter,null,h(ThemeProvider,null,h(AuthProvider,null,h(LicenseProvider,null,h(Harness))))))));`;
before(async () => {
  server = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-seating-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'seating-test', configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (!req.url.startsWith('/classpilot/my-desk/')) return next(); res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, '<html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__seating.jsx"></script></body></html>')); }); }, resolveId(id) { if (id === '/__seating.jsx') return '\0seating'; }, load(id) { if (id === '\0seating') return entry; } }] });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; browser = await chromium.launch({ headless: true }); await mkdir(artifactDir, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
const roster = [{ id: 'student-a', name: 'Avery Lee' }, { id: 'student-b', name: 'Blair Patel' }, { id: 'student-c', name: 'Casey Morgan' }];
const fixture = (patch = {}) => ({ id: 'chart-a', schoolId: 'school-a', authorId: 'teacher-a', classId: 'class-a', filingGroupId: 'class-a', className: 'Science 5', name: 'Morning seats', layout: createLayout('rows', 3), roster, rosterRevision: 'roster-1', revision: 1, isCurrent: true, canEdit: true, createdAt: '2026-09-25T12:00:00Z', updatedAt: '2026-09-25T12:00:00Z', ...patch });

async function setup({ charts = [], url = '', viewport, currentRoster = roster, enabled = true } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 1000 } });
  const state = { charts: structuredClone(charts), roster: structuredClone(currentRoster), rosterRevision: currentRoster === roster ? 'roster-1' : 'roster-2', viewer: 'teacher-a', enabled, failCreate: false, failUpdate: false, conflictUpdate: false, holdUpdate: false, notes: [] };
  const requests = [], errors = [], replay = new Map();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('sp_activeSchoolId', 'school-a'); window.printCalls = 0; window.print = () => { window.printCalls++; }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method();
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? request.postDataJSON() : null;
    requests.push({ path: pathname, method, body }); const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (pathname.endsWith('/auth/csrf')) return json({ csrfToken: 'test' });
    if (pathname.endsWith('/auth/me')) return json({ user: { id: state.viewer, firstName: 'Teacher', email: 'teacher@example.school' }, activeSchoolId: 'school-a', memberships: [{ schoolId: 'school-a', schoolName: 'School', schoolTimezone: 'America/New_York', role: 'teacher', roles: ['teacher'] }], licenses: { classPilot: true } });
    assert.equal(request.headers()['x-school-id'], 'school-a');
    if (pathname.endsWith('/capabilities')) return state.failCapability ? json({ error: 'Temporary capability outage' }, 503) : json({ enabled: true, seatingEnabled: state.enabled, schoolDate: '2026-09-25' });
    if (pathname.endsWith('/classes')) return json({ current: [{ id: 'class-a', name: 'Science 5' }, { id: 'class-b', name: 'Science 6' }], past: [{ id: 'past-class', name: 'Last year' }] });
    if (pathname.endsWith('/students')) return json({ students: state.roster, rosterRevision: state.rosterRevision });
    if (pathname.endsWith('/categories')) return json({ categories: [{ key: 'note', label: 'Note' }] });
    if (pathname.endsWith('/notes') && method === 'POST') { const note = { ...body, id: 'note-a', revision: 1, status: 'pending', attachments: [] }; state.notes.push(note); return json({ note }); }
    if (pathname.endsWith('/notes/note-a/complete')) { Object.assign(state.notes[0], body, { revision: 2, status: 'active' }); return json({ note: state.notes[0] }); }
    if (pathname.endsWith('/seating-charts') && method === 'GET') {
      const params = new URL(request.url()).searchParams;
      const charts = state.charts.filter(chart => !chart.deleted && chart.authorId === state.viewer && (params.get('scope') === 'past' ? !chart.canEdit : chart.canEdit)).map(({ layout: _layout, roster: _roster, rosterRevision: _rosterRevision, ...summary }) => summary);
      return json({ charts, nextCursor: null });
    }
    if (pathname.endsWith('/seating-charts') && method === 'POST') {
      if (replay.has(body.clientRequestId)) return json({ chart: replay.get(body.clientRequestId) });
      const chart = fixture({ ...body, id: `created-${state.charts.length}`, authorId: state.viewer, isCurrent: !state.charts.some(chart => chart.classId === body.classId), roster: state.roster, rosterRevision: state.rosterRevision }); state.charts.push(chart); replay.set(body.clientRequestId, structuredClone(chart));
      if (state.failCreate) { state.failCreate = false; return json({ error: 'Create response interrupted' }, 503); } return json({ chart });
    }
    const match = pathname.match(/\/seating-charts\/([^/]+)(.*)$/);
    if (match) {
      const chart = state.charts.find(item => item.id === match[1] && !item.deleted && item.authorId === state.viewer); if (!chart) return json({ error: 'Chart not found', code: 'MYDESK_SEATING_NOT_FOUND' }, 404);
      const action = match[2]; if (method === 'GET') return state.failChartRead ? json({ error: 'Temporary chart outage' }, 503) : json({ chart });
      const id = body.requestId || body.clientRequestId;
      if (replay.has(id)) return json({ chart: replay.get(id) });
      if (state.holdUpdate && method === 'PATCH') await new Promise(resolve => { state.releaseUpdate = resolve; });
      if (state.conflictUpdate && method === 'PATCH') { state.conflictUpdate = false; return json({ error: 'This chart changed in another tab.', code: 'MYDESK_SEATING_REVISION_CONFLICT' }, 409); }
      if (action === '/duplicate') { const copy = fixture({ ...chart, id: `copy-${state.charts.length}`, classId: body.targetClassId, filingGroupId: body.targetClassId, name: body.name, revision: 1, isCurrent: false, canEdit: true, layout: body.mode === 'layout' ? emptyLayoutCopy(chart.layout) : chart.layout, roster: state.roster, rosterRevision: state.rosterRevision }); state.charts.push(copy); replay.set(id, structuredClone(copy)); return json({ chart: copy }); }
      assert.equal(body.revision, chart.revision);
      if (method === 'DELETE') { chart.deleted = true; return json({ ok: true }); }
      if (action === '/current') { state.charts.forEach(item => { if (item.classId === chart.classId) item.isCurrent = item.id === chart.id; }); chart.revision++; }
      else Object.assign(chart, body, { revision: chart.revision + 1, roster: state.roster });
      replay.set(id, structuredClone(chart));
      if (state.failUpdate) { state.failUpdate = false; return json({ error: 'Save response interrupted' }, 503); } return json({ chart });
    }
    return json({ error: `Unexpected ${method} ${pathname}` }, 404);
  });
  await page.goto(`${base}/classpilot/my-desk/seating${url}`);
  try { await page.getByRole('heading', { name: enabled ? url ? charts.find(chart => `/${chart.id}` === url)?.name : 'Seating charts' : 'Seating charts are unavailable', exact: true }).waitFor({ timeout: 15000 }); }
  catch (failure) { throw new Error(`${failure.message}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`); }
  return { page, state, requests, errors };
}

test('create, tap placement, swap, lock, shuffle, undo and note keep edits private until explicit save', { timeout: 60_000 }, async () => {
  const t = await setup();
  try {
    await t.page.getByRole('button', { name: 'New chart', exact: true }).click(); await t.page.getByLabel('Class', { exact: true }).selectOption('class-a'); await t.page.getByLabel('Chart name', { exact: true }).fill('First period');
    t.state.failCreate = true; await t.page.getByRole('button', { name: 'Create chart', exact: true }).click(); await t.page.getByText('Create response interrupted').waitFor(); await t.page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await t.page.getByRole('heading', { name: 'First period', exact: true }).waitFor(); assert.equal(t.state.charts.length, 1);
    await t.page.getByRole('button', { name: 'Avery Lee', exact: true }).click(); await t.page.getByRole('button', { name: 'Seat 1, empty', exact: true }).click();
    await t.page.getByRole('button', { name: 'Blair Patel', exact: true }).click(); await t.page.getByRole('button', { name: 'Seat 2, empty', exact: true }).click();
    await t.page.getByRole('button', { name: 'Seat 1, Avery Lee', exact: true }).click(); await t.page.getByRole('button', { name: 'Move student', exact: true }).click(); await t.page.getByRole('button', { name: 'Seat 2, Blair Patel', exact: true }).click();
    await t.page.getByRole('button', { name: 'Seat 1, Blair Patel', exact: true }).click(); await t.page.getByRole('button', { name: 'Lock seat', exact: true }).click(); await t.page.getByRole('button', { name: 'Shuffle', exact: true }).click();
    await t.page.getByRole('button', { name: 'Seat 1, Blair Patel, locked', exact: true }).waitFor(); await t.page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(t.requests.filter(item => item.method === 'PATCH').length, 0); assert.equal(await t.page.getByRole('button', { name: 'Print', exact: true }).isDisabled(), true);
    await t.page.getByRole('button', { name: 'Add private note', exact: true }).click(); await t.page.getByRole('dialog').waitFor(); assert.equal(await t.page.getByLabel('Class', { exact: true }).inputValue(), 'class-a'); assert.equal(await t.page.getByLabel('Student', { exact: true }).inputValue(), 'student-b'); await t.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    t.state.failUpdate = true; await t.page.getByRole('button', { name: 'Save chart', exact: true }).click(); await t.page.getByText('Save response interrupted').waitFor(); await t.page.getByRole('button', { name: 'Retry save', exact: true }).click(); await t.page.getByRole('button', { name: 'Save chart', exact: true }).waitFor();
    const writes = t.requests.filter(item => item.method === 'PATCH'); assert.equal(writes.length, 2); assert.deepEqual(writes[0].body, writes[1].body); assert.equal(t.state.charts[0].layout.seats[0].studentId, 'student-b'); assert(t.state.charts[0].layout.seats[0].locked);
    await t.page.locator('.seating-page').screenshot({ path: path.join(artifactDir, 'seating-desktop.png') }); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('roster review and revision conflicts preserve the draft and support save as new', { timeout: 60_000 }, async () => {
  const chart = fixture(); chart.layout.seats[0].studentId = 'student-a'; chart.layout.seats[1].studentId = 'student-b'; chart.layout.seats[1].locked = true;
  const t = await setup({ charts: [chart], url: '/chart-a', currentRoster: [{ id: 'student-a', name: 'Avery Li' }, { id: 'student-c', name: 'Casey Morgan' }, { id: 'student-d', name: 'Devon Rivera' }] });
  try {
    await t.page.getByRole('heading', { name: 'The class roster has changed' }).waitFor(); assert(await t.page.getByRole('button', { name: 'Shuffle', exact: true }).isDisabled());
    await t.page.getByRole('button', { name: 'Review roster update' }).click(); await t.page.getByRole('button', { name: 'Update draft', exact: true }).click(); await t.page.getByRole('button', { name: 'Seat 2, empty', exact: true }).waitFor();
    t.state.conflictUpdate = true; await t.page.getByRole('button', { name: 'Save chart', exact: true }).click(); await t.page.getByRole('button', { name: 'Reload saved chart' }).click(); await t.page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await t.page.getByRole('button', { name: 'Save as new chart' }).click(); assert(await t.page.getByLabel('Class', { exact: true }).isDisabled()); await t.page.getByRole('dialog').getByLabel('Chart name', { exact: true }).fill('Roster update'); await t.page.getByRole('button', { name: 'Create chart', exact: true }).click();
    await t.page.getByRole('heading', { name: 'Roster update', exact: true }).waitFor(); assert.equal(t.state.charts.length, 2); assert.equal(t.state.charts[1].layout.seats[1].studentId, null); assert.equal(t.state.charts[1].rosterRevision, 'roster-2'); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('phone tap controls, browser history and setup cancellation preserve unsaved work', { timeout: 60_000 }, async () => {
  const t = await setup({ charts: [fixture()], viewport: { width: 390, height: 844 } });
  try {
    await t.page.getByRole('button', { name: 'Open chart', exact: true }).click(); await t.page.getByLabel('Selected seat').selectOption(t.state.charts[0].layout.seats[0].id);
    await t.page.getByRole('button', { name: 'Avery Lee', exact: true }).click(); await t.page.getByRole('button', { name: 'Place in selected seat', exact: true }).click(); await t.page.getByRole('button', { name: 'Move desk down', exact: true }).click();
    assert.equal(await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await t.page.locator('.seating-page').screenshot({ path: path.join(artifactDir, 'seating-mobile.png') });
    await t.page.goBack(); await t.page.getByRole('alertdialog').waitFor(); await t.page.getByRole('button', { name: 'Keep editing', exact: true }).click(); await t.page.getByRole('button', { name: 'Seat 1, Avery Lee', exact: true }).waitFor();
    await t.page.getByRole('button', { name: 'Cancel changes', exact: true }).click(); await t.page.getByRole('button', { name: 'Discard changes', exact: true }).click(); await t.page.getByRole('button', { name: 'Seat 1, empty', exact: true }).waitFor();
    await t.page.getByRole('button', { name: 'All charts', exact: true }).click(); await t.page.goBack(); await t.page.getByLabel('Chart name', { exact: true }).fill('Forward draft'); await t.page.goForward(); await t.page.getByRole('button', { name: 'Keep editing', exact: true }).click(); assert.equal(await t.page.getByLabel('Chart name', { exact: true }).inputValue(), 'Forward draft');
    await t.page.getByRole('button', { name: 'Cancel changes', exact: true }).click(); await t.page.getByRole('button', { name: 'Discard changes', exact: true }).click(); await t.page.getByRole('button', { name: 'All charts', exact: true }).click();
    await t.page.getByRole('button', { name: 'New chart', exact: true }).click(); await t.page.getByLabel('Chart name', { exact: true }).fill('Unsaved setup'); await t.page.goBack(); await t.page.getByRole('button', { name: 'Keep editing', exact: true }).click(); await t.page.getByRole('button', { name: 'Cancel', exact: true }).click(); await t.page.getByRole('button', { name: 'Discard setup' }).click(); assert.equal(t.state.charts.length, 1); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('past charts print saved names on one Letter or A4 page and can reuse empty layouts', { timeout: 60_000 }, async () => {
  const denseRoster = Array.from({ length: 100 }, (_, index) => ({ id: `student-${index}`, name: index === 0 ? 'Alexandertheexceptionallylongfirstname Montgomery-Wellington' : index === 1 ? 'W'.repeat(500) : `Student ${index + 1} Example` }));
  const layout = createLayout('rows', 100); layout.seats.forEach((seat, index) => { seat.studentId = denseRoster[index].id; seat.locked = index % 2 === 0; }); layout.seats[0].y = 0;
  const t = await setup({ charts: [fixture({ layout, roster: denseRoster, classId: null, filingGroupId: 'past-class', className: 'Last year', canEdit: false })], url: '/chart-a' });
  try {
    assert(!t.requests.some(item => item.path.endsWith('/students'))); assert.equal(await t.page.getByRole('button', { name: 'Save chart', exact: true }).count(), 0);
    for (const paper of ['letter', 'a4']) {
      await t.page.getByRole('button', { name: 'Print', exact: true }).click(); await t.page.getByLabel('Paper size', { exact: true }).selectOption(paper); await t.page.getByRole('button', { name: 'Open print preview', exact: true }).click();
      await t.page.waitForFunction(() => window.printCalls > 0); assert.equal(await t.page.locator('.seating-print button').count(), 0); assert.equal(await t.page.locator('.seating-print').getByText('Unassigned', { exact: true }).count(), 0);
      await t.page.emulateMedia({ media: 'print' });
      const nameBoxes = await t.page.locator('.seating-print g > text:last-child').evaluateAll(nodes => nodes.map(node => { const box = node.getBBox(); return { x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height }; }));
      assert(nameBoxes.every(box => box.x >= 0 && box.y >= 0 && box.right <= 100 && box.bottom <= 60));
      const pdf = await t.page.pdf({ path: path.join(artifactDir, `seating-100-${paper}.pdf`), preferCSSPageSize: true, printBackground: true }); assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1);
      await t.page.emulateMedia({ media: 'screen' });
      await t.page.evaluate(() => { window.printCalls = 0; window.dispatchEvent(new Event('afterprint')); });
    }
    await t.page.emulateMedia({ media: 'print' }); assert(await t.page.locator('#root').isVisible()); await t.page.emulateMedia({ media: 'screen' });
    await t.page.getByRole('button', { name: 'Reuse its empty layout' }).click(); await t.page.getByLabel('Class', { exact: true }).selectOption('class-b'); await t.page.getByRole('button', { name: 'Create chart', exact: true }).click(); await t.page.getByRole('heading', { name: 'Morning seats copy', exact: true }).waitFor();
    assert(t.state.charts[1].layout.seats.every(seat => !seat.studentId && !seat.locked)); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('transient chart and capability refresh failures keep an active draft mounted', { timeout: 60_000 }, async () => {
  const t = await setup({ charts: [fixture()], url: '/chart-a' });
  try {
    await t.page.getByLabel('Chart name', { exact: true }).fill('Keep my draft'); t.state.failCapability = true; t.state.failChartRead = true;
    await t.page.evaluate(() => window.refreshSeatingQueries()); assert.equal(await t.page.getByLabel('Chart name', { exact: true }).inputValue(), 'Keep my draft'); assert(await t.page.getByRole('button', { name: 'Undo', exact: true }).isEnabled());
    t.state.failCapability = false; t.state.failChartRead = false; await t.page.evaluate(() => window.refreshSeatingQueries()); assert.equal(await t.page.getByLabel('Chart name', { exact: true }).inputValue(), 'Keep my draft'); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('ordinary thirty-seat printouts use readable fitted names on Letter and A4', { timeout: 60_000 }, async () => {
  const names = Array.from({ length: 30 }, (_, index) => ({ id: `student-${index}`, name: ['Avery Lee', 'Blair Patel', 'Casey Morgan', 'Devon Rivera', 'Emerson Montgomery-Wellington'][index % 5] }));
  const layout = createLayout('rows', 30); layout.seats.forEach((seat, index) => { seat.studentId = names[index].id; });
  const t = await setup({ charts: [fixture({ layout, roster: names, canEdit: false, classId: null, name: 'Thirty-seat classroom' })], url: '/chart-a' });
  try {
    for (const paper of ['letter', 'a4']) {
      await t.page.getByRole('button', { name: 'Print', exact: true }).click(); await t.page.getByLabel('Paper size', { exact: true }).selectOption(paper); await t.page.getByRole('button', { name: 'Open print preview', exact: true }).click(); await t.page.waitForFunction(() => window.printCalls > 0);
      assert.equal(await t.page.locator('.seating-print g text').nth(1).getAttribute('font-size'), '16');
      const pdf = await t.page.pdf({ path: path.join(artifactDir, `seating-30-${paper}.pdf`), preferCSSPageSize: true, printBackground: true }); assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1);
      await t.page.evaluate(() => { window.printCalls = 0; window.dispatchEvent(new Event('afterprint')); });
    }
    assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('duplicate, current selection, keyboard and drag geometry, and confirmed deletion use saved revisions', { timeout: 60_000 }, async () => {
  const t = await setup({ charts: [fixture()] });
  try {
    await t.page.getByRole('button', { name: 'Duplicate', exact: true }).click(); await t.page.getByRole('button', { name: 'Create chart', exact: true }).click(); await t.page.getByRole('heading', { name: 'Morning seats copy', exact: true }).waitFor();
    const before = t.state.charts[1].layout.seats[0].y;
    await t.page.getByRole('button', { name: 'Seat 1, empty', exact: true }).focus(); await t.page.keyboard.press('ArrowDown');
    const handle = t.page.getByRole('button', { name: 'Drag desk 1', exact: true }); const bounds = await handle.boundingBox(); await t.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await t.page.mouse.down(); await t.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 20); await t.page.mouse.up();
    await t.page.getByRole('button', { name: 'Save chart', exact: true }).click(); await t.page.getByRole('button', { name: 'Make current', exact: true }).click(); await t.page.getByText('Current', { exact: true }).waitFor(); assert(t.state.charts[1].layout.seats[0].y > before); assert(t.state.charts[1].isCurrent); assert(!t.state.charts[0].isCurrent);
    await t.page.getByRole('button', { name: 'All charts', exact: true }).click(); await t.page.getByRole('article', { name: 'Morning seats copy', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click(); await t.page.getByRole('button', { name: 'Keep chart', exact: true }).click(); assert(!t.state.charts[1].deleted);
    await t.page.getByRole('article', { name: 'Morning seats copy', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click(); await t.page.getByRole('button', { name: 'Delete chart', exact: true }).click(); await t.page.getByRole('article', { name: 'Morning seats copy', exact: true }).waitFor({ state: 'hidden' }); assert(!t.state.charts.some(chart => !chart.deleted && chart.isCurrent)); assert.deepEqual(t.errors, []);
  } finally { await t.page.close(); }
});

test('account changes fence an in-flight chart save and capability-off hides seating', { timeout: 60_000 }, async () => {
  const disabled = await setup({ enabled: false }); assert.equal(disabled.requests.filter(item => item.path.includes('/seating-charts')).length, 0); await disabled.page.close();
  const t = await setup({ charts: [fixture()], url: '/chart-a' });
  try {
    await t.page.getByLabel('Chart name', { exact: true }).fill('Late old draft'); t.state.holdUpdate = true; await t.page.getByRole('button', { name: 'Save chart', exact: true }).click();
    await t.page.waitForFunction(() => document.body.textContent.includes('Saving…')); t.state.viewer = 'teacher-b'; await t.page.getByRole('button', { name: 'Refresh account', includeHidden: true }).evaluate(button => button.click());
    await t.page.getByRole('heading', { name: 'Chart unavailable', exact: true }).waitFor(); t.state.releaseUpdate?.(); assert.equal(await t.page.getByLabel('Chart name', { exact: true }).count(), 0); assert.deepEqual(t.errors, []);
  } finally { t.state.releaseUpdate?.(); await t.page.close(); }
});
