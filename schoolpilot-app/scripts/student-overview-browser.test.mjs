import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const entry = `import React from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import{StudentOverviewContent}from'/src/products/classpilot/pages/StudentOverview.jsx';import'/src/index.css';
const h=React.createElement;const params=new URLSearchParams(location.search);
const access={schoolId:'school-a',viewerId:'teacher-a',enabled:true,eligible:true,schoolDate:'2026-09-27',school:{timezone:'America/New_York'}};
const discipline={schoolId:'school-a',viewerId:'teacher-a',eligible:true,ready:params.get('discipline')!=='off',loading:false,capabilities:{canSubmit:true,canViewSchool:false},importsEnabled:false,school:{schoolTimezone:'America/New_York'}};
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(MemoryRouter,null,h('div',{className:'mydesk-page'},h(StudentOverviewContent,{access,discipline,studentId:'student-a',from:params.get('from')||'notes'})))));`;

before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-student-overview-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'student-overview-browser', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith('/__overview?')) return next(); res.setHeader('Content-Type', 'text/html');
    res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__overview-entry.jsx"></script></body></html>'));
  }); }, resolveId(id) { if (id === '/__overview-entry.jsx') return '\0overview-entry'; }, load(id) { if (id === '\0overview-entry') return entry; } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

const record = { id: 'record-a', status: 'submitted', submittedBy: { id: 'teacher-b', name: 'Synthetic Colleague' }, currentVersion: { title: 'Left class without a pass', category: 'referral', entryDate: '2026-09-24', className: 'Science 5' } };
const note = { id: 'note-a', targetKind: 'student', status: 'active', category: 'detention', title: 'Kept in at recess', entryDate: '2025-05-14', groupName: 'Science 4', attachments: [] };
const contact = { id: 'contact-a', name: 'Alex Guardian', relationship: 'Guardian', phones: ['555-0100'], emails: ['alex@example.invalid'], preferred: true, emergency: null, preferredMethod: 'Text', language: 'English' };

async function setup({ query = '', denied = false, former = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('sp_activeSchoolId', 'school-a'); });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    requests.push({ path: url.pathname, method, body: method === 'GET' ? undefined : request.postDataJSON() });
    const json = (value, status = 200) => route.fulfill({ json: value, status });
    if (url.pathname.endsWith('/csrf')) return json({ csrfToken: 'synthetic' });
    if (url.pathname.endsWith('/mydesk/categories')) return json({ categories: [{ key: 'detention', label: 'Detention' }] });
    if (url.pathname.endsWith('/mydesk/students/student-a/context')) return former ? json({ error: 'Choose a student in your current assignments', code: 'MYDESK_STUDENT_NOT_FOUND' }, 404)
      : json({ student: { id: 'student-a', name: 'Jordan Ellis', gradeLevel: '5', classes: [{ id: 'class-a', name: 'Science 5' }] } });
    if (url.pathname.endsWith('/mydesk/students/student-a/history')) return json({ student: { id: 'student-a', name: 'Jordan Ellis', current: !former, classes: [] }, notes: [note], nextCursor: null });
    if (url.pathname.endsWith('/discipline-records/students/student-a/history')) return denied ? json({ error: 'Current student access has ended.' }, 403)
      : json({ student: { id: 'student-a', name: 'Jordan Ellis', classes: [] }, records: [record], range: { period: 'school_year' }, nextCursor: null });
    if (url.pathname.endsWith('/student-information/students/student-a')) return denied ? json({ error: 'Current student access has ended.' }, 403)
      : json({ student: { id: 'student-a', name: 'Jordan Ellis', gradeLevel: '5' }, profile: { revision: 3, updatedByName: 'Front Office', data: { contacts: [contact] } } });
    return json({ error: `Unexpected fixture request ${method} ${url.pathname}` }, 404);
  });
  await page.goto(`${base}/__overview?${query}`); return { page, requests, errors };
}

test('one page shows incidents, private notes and contacts with their own visibility', async () => {
  const { page, requests, errors } = await setup({ query: 'from=discipline' });
  try {
    await page.getByRole('heading', { name: 'Jordan Ellis', level: 1 }).waitFor();
    await page.getByText('Grade 5 · Science 5', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Discipline logs', exact: true }).getAttribute('href'), '/classpilot/discipline-records');
    await page.getByText('Left class without a pass', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'All incidents' }).getAttribute('href'), '/classpilot/discipline-records?studentId=student-a');
    await page.getByText('Kept in at recess', { exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: 'Your private notes' }).innerText(), /May 14, 2025 · Detention · Science 4/);
    assert.equal(await page.getByRole('link', { name: 'All private notes' }).getAttribute('href'), '/classpilot/my-desk/notes/students/student-a');
    assert.equal(await page.getByRole('link', { name: '555-0100' }).getAttribute('href'), 'tel:555-0100');
    await page.getByText('Preferred contact', { exact: true }).waitFor();
    assert.equal(await page.getByText('School record', { exact: true }).count(), 2);
    assert.equal(await page.getByText('Private', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Add private note' }).waitFor();
    await page.getByRole('button', { name: 'Add incident' }).waitFor();
    assert.equal(requests.find(row => row.path.endsWith('/discipline-records/students/student-a/history')).body.scope, 'assigned');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('losing a class hides incidents and contacts but keeps your own notes', async () => {
  const { page, errors } = await setup({ denied: true, former: true });
  try {
    await page.getByRole('heading', { name: 'Jordan Ellis', level: 1 }).waitFor();
    await page.getByText('Kept in at recess', { exact: true }).waitFor();
    await page.getByText('Incidents are visible to teachers currently assigned to this student.', { exact: true }).waitFor();
    await page.getByText('Contacts are visible to staff currently assigned to this student.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add incident' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add private note' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Notes', exact: true }).getAttribute('href'), '/classpilot/my-desk');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('without discipline access the page never requests school incidents', async () => {
  const { page, requests, errors } = await setup({ query: 'discipline=off' });
  try {
    await page.getByText('Discipline logs are not available for your account.', { exact: true }).waitFor();
    await page.getByText('Kept in at recess', { exact: true }).waitFor();
    assert.equal(requests.some(row => row.path.includes('/discipline-records/')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
