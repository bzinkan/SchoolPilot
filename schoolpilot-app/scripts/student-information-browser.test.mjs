import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.resolve(root, '../../artifacts');
let vite, browser, base;
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient}from'/src/lib/queryClient.js';import Page,{StudentInformationShell} from'/src/products/classpilot/pages/StudentInformation.jsx';import{ThemeProvider}from'/src/contexts/ThemeContext.jsx';import Profile from'/src/products/classpilot/components/StudentContactProfileEditor.jsx';import Import from'/src/products/classpilot/components/StudentInformationImport.jsx';import{clearMyDeskQueries}from'/src/products/classpilot/lib/myDeskModel.js';import'/src/index.css';const h=React.createElement;window.refreshInformation=()=>queryClient.invalidateQueries({queryKey:['mydesk-private']});window.informationCache=()=>queryClient.getQueriesData({queryKey:['mydesk-private']});function Harness(){const[who,setWho]=useState({schoolId:'school-a',viewerId:'teacher-a'});const mode=new URLSearchParams(location.search).get('mode');const change=(schoolId,viewerId)=>{clearMyDeskQueries(queryClient);localStorage.setItem('sp_activeSchoolId',schoolId);window.__viewer=viewerId;setWho({schoolId,viewerId});};return h(React.Fragment,null,h('button',{onClick:()=>change('school-b','teacher-a')},'Change school'),h('button',{onClick:()=>change('school-a','teacher-b')},'Change teacher'),mode==='directory'?h(Page):mode==='profile'?h(StudentInformationShell,null,h(Profile,{key:who.schoolId+who.viewerId,...who,studentId:'student-a'})):h(Import,{key:who.schoolId+who.viewerId,access:{...who,aiImportEnabled:true,limits:{teacherDailyUnits:100,schoolDailyUnits:500}},importId:'run-a'}));}createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(ThemeProvider,null,h(MemoryRouter,{initialEntries:['/classpilot/my-desk/student-information']},h(Harness)))));`;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-student-information-${process.pid}`, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'information-browser', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith('/__information?')) return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/__information-entry.jsx"></script></body></html>'));
  }); }, resolveId(id) { if (id === '/__information-entry.jsx') return '\0information-entry'; }, load(id) { if (id.replace(/\\/g,'/').endsWith('/products/classpilot/hooks/useMyDesk.js')) return `export const useMyDeskAccess=()=>({schoolId:'school-a',viewerId:'teacher-a',eligible:true,enabled:true,seatingEnabled:true,school:{name:'Synthetic School'}}); export const useMyDeskClasses=()=>({data:{current:[],grades:[{gradeLevel:'5',label:'Grade 5'},{gradeLevel:'6',label:'Grade 6'}],preferences:{revision:0,viewBy:'grades',preferredClasses:[]}},isPending:false,isError:false});`; if (id === '\0information-entry') return entry; } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`; browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

const contact = (patch = {}) => ({ id: 'contact-a', name: 'Alex Guardian', relationship: 'Guardian', phones: ['555-0100'], emails: ['alex@example.invalid'], preferred: null, emergency: null, preferredMethod: null, language: null, ...patch });
const profile = (patch = {}) => ({ student: { id: 'student-a', name: 'Synthetic Student', gradeLevel: '5' }, profile: { revision: 1, data: { contacts: [contact()] }, updatedByName: 'Teacher Example', updatedAt: '2026-09-26T12:00:00Z' }, ...patch });
const run = (patch = {}) => ({ id: 'run-a', revision: 1, status: 'uploading', selectedSectionIds: ['section-a'], expectedSourceCount: 1, expiresAt: '2026-10-03T12:00:00Z', assets: [{ id: 'source-a', kind: 'source', status: 'ready' }, { id: 'section-a', kind: 'section', status: 'ready', units: 1, label: 'Selected page', hidden: false, warnings: [] }, { id: 'section-b', kind: 'section', status: 'ready', units: 1, label: 'Hidden sheet', hidden: true, warnings: ['hidden_sheet'] }], items: [], ...patch });

async function setup(mode, overrides = {}) {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  const state = { profile: profile(), run: run(), denied: false, failSave: false, ...overrides }, requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('sp_activeSchoolId', 'school-a'); localStorage.setItem('sp_theme','light'); window.__viewer = 'teacher-a'; window.__revoked = []; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.__revoked.push(url); revoke(url); }; });
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method(), school = req.headers()['x-school-id'];
    const body = method === 'GET' ? undefined : req.postDataJSON(); requests.push({ path: url.pathname, search: url.search, method, school, body });
    const json = (value, status = 200) => route.fulfill({ json: value, status });
    if (url.pathname.endsWith('/capabilities')) return json({enabled:true,manager:false,aiImportEnabled:true,limits:{teacherDailyUnits:100,schoolDailyUnits:500}});
    if (url.pathname.endsWith('/imports')) return json({imports:[],nextCursor:null});
    if (url.pathname.endsWith('/csrf')) return json({ csrfToken: 'synthetic' });
    if (state.denied) return json({ error: 'Current student access has ended.' }, 403);
    if (url.pathname.endsWith('/history') && (school !== 'school-a' || await page.evaluate(() => window.__viewer) !== 'teacher-a')) return json({ versions: [], nextCursor: null });
    if (url.pathname.endsWith('/history')) return json({ versions: [{ id: 'version-a', revision: 1, authorName: 'Teacher Example', createdAt: '2026-09-26T12:00:00Z', reason: 'Historical contact reason', data: state.profile.profile.data }], nextCursor: null });
    if (url.pathname.endsWith('/students/student-a')) {
      if (method === 'PATCH') {
        if (state.holdSave) await new Promise(resolve => { state.releaseSave = resolve; });
        if (state.failSave) { state.failSave = false; return json({ error: 'Synthetic interrupted response' }, 503); }
        const data = structuredClone(state.profile.profile.data);
        for (const change of body.changes) if (change.kind === 'replace') { const current = data.contacts.find(value => value.id === change.contactId); Object.assign(current, change.fields); for (const field of change.clearFields) current[field] = ['phones', 'emails'].includes(field) ? [] : null; }
        state.profile.profile = { ...state.profile.profile, revision: 2, data }; return json(state.profile);
      }
      return json(school === 'school-a' && await page.evaluate(() => window.__viewer) === 'teacher-a' ? state.profile : profile({ student: { id: 'student-a', name: 'New scope student', gradeLevel: '6' }, profile: { revision: 0, data: { contacts: [] } } }));
    }
    if (url.pathname.endsWith('/search')) return json({ students: [{ id: 'student-a', name: 'Synthetic Student', gradeLevel: '5', status: 'active' }], nextCursor: null });
    if (url.pathname.endsWith('/imports/run-a')) return json({ import: state.run });
    if (url.pathname.endsWith('/content')) return route.fulfill({ contentType: 'text/plain', body: 'Synthetic source: student and guardian details.' });
    if (url.pathname.endsWith('/process')) { state.run.status = 'queued'; state.run.revision++; return json({ import: state.run }); }
    if (url.pathname.endsWith('/items/item-a') && method === 'PATCH') { Object.assign(state.run.items[0], { reviewed: body.reviewed, excluded: body.excluded, revision: state.run.items[0].revision + 1 }); state.run.revision++; return json({ import: state.run }); }
    if (url.pathname.endsWith('/commit')) { state.run.status = 'completed'; state.run.revision++; state.run.receipt = { profiles: [{ itemId: 'item-a', studentId: 'student-a' }] }; return json({ import: state.run }); }
    return json({ error: 'Unexpected fixture request' }, 404);
  });
  await page.goto(`${base}/__information?mode=${mode}`); return { page, requests, state, errors };
}

test('manual contact changes require a reason, preserve retry identity, and clear explicit fields only', async () => {
  const { page, state, requests, errors } = await setup('profile', { failSave: true });
  try {
    await page.getByRole('heading', { name: 'Synthetic Student' }).waitFor();
    await page.getByLabel('Phone numbers, one per line').first().fill('');
    assert.equal(await page.getByRole('button', { name: 'Save reviewed changes' }).isDisabled(), true);
    await page.getByLabel('Reason for this update').fill('Reviewed synthetic correction');
    await page.getByRole('button', { name: 'Save reviewed changes' }).click(); await page.getByRole('alert').filter({ hasText: 'Synthetic interrupted response' }).waitFor();
    await page.getByRole('button', { name: 'Save reviewed changes' }).click(); await page.waitForFunction(() => !document.querySelector('textarea[maxlength="500"]'));
    const saves = requests.filter(value => value.method === 'PATCH'); assert.equal(saves.length, 2); assert.deepEqual(saves[0].body, saves[1].body);
    assert.deepEqual(saves[0].body.changes, [{ kind: 'replace', contactId: 'contact-a', fields: {}, clearFields: ['phones'] }]);
    assert.equal(state.profile.profile.data.contacts[0].emails[0], 'alex@example.invalid'); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('denied student access removes cached profile, unsaved contact fields and history', async () => {
  const { page, state, errors } = await setup('profile');
  try {
    await page.getByRole('heading', { name: 'Synthetic Student' }).waitFor();
    await page.getByRole('button', { name: 'Add contact' }).click();
    await page.getByLabel('Contact name', { exact: true }).nth(1).fill('Unsaved contact');
    state.denied = true; await page.evaluate(() => window.refreshInformation());
    await page.getByText('Current student access has ended.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Contact name', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Historical contact reason').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save reviewed changes' }).count(), 0); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('school and same-school teacher changes abort old saves and remove private contact import state', async () => {
  const { page, state, requests, errors } = await setup('profile', { holdSave: true });
  try {
    await page.getByRole('heading', { name: 'Synthetic Student' }).waitFor(); await page.getByLabel('Contact name', { exact: true }).first().fill('Pending synthetic name');
    await page.getByLabel('Reason for this update').fill('Pending save'); await page.getByRole('button', { name: 'Save reviewed changes' }).click();
    await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.textContent === 'Saving…');
    await page.getByRole('button', { name: 'Change school' }).click(); await page.getByRole('heading', { name: 'New scope student' }).waitFor();
    state.releaseSave?.(); await page.waitForTimeout(80); assert.equal(await page.getByLabel('Contact name', { exact: true }).count(), 0);
    assert.ok(requests.some(value => value.school === 'school-b' && value.path.endsWith('/students/student-a')));
    await page.getByRole('button', { name: 'Change teacher' }).click(); await page.getByRole('heading', { name: 'New scope student' }).waitFor();
    assert.equal(await page.getByText('Pending synthetic name').count(), 0); assert.deepEqual(errors, []);
  } finally { state.releaseSave?.(); await page.close(); }
});

test('a denied manual save immediately removes profile fields and history without waiting for focus', async () => {
  const {page,state,errors}=await setup('profile');
  try {
    await page.getByRole('heading',{name:'Synthetic Student'}).waitFor();
    await page.getByLabel('Contact name',{exact:true}).first().fill('Unsaved contact');
    await page.getByLabel('Reason for this update').fill('Synthetic correction');
    state.denied=true;
    await page.getByRole('button',{name:'Save reviewed changes'}).click();
    await page.getByText('Current student access has ended.',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Contact name',{exact:true}).count(),0);
    assert.equal(await page.getByText('Historical contact reason').count(),0);
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
});

test('contact processing requires selected source sections, warning acknowledgement and provider confirmation', async () => {
  const { page, requests, errors } = await setup('import');
  try {
    const process = page.getByRole('button', { name: 'Read selected sections' }); await process.waitFor();
    assert.equal(await process.isDisabled(), true); await page.getByLabel('Selected page').check();
    await page.getByText('Preview Selected page', { exact: true }).click(); await page.getByText('Synthetic source: student and guardian details.', { exact: true }).waitFor();
    assert.equal(await process.isDisabled(), true); await page.getByLabel('I reviewed hidden and unsupported content warnings.', { exact: false }).check();
    assert.equal(await process.isDisabled(), true); await page.getByLabel('Send only these selected sections to Anthropic', { exact: false }).check();
    await process.click(); await page.getByText('Preparing contact suggestions.', { exact: false }).waitFor();
    const request = requests.find(value => value.path.endsWith('/process')); assert.deepEqual(request.body.sectionIds, ['section-a']); assert.equal(request.body.confirmedProvider, true); assert.equal(request.body.acknowledgedWarnings, true);
    assert.equal(requests.some(value => value.path.endsWith('/commit')), false); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('contact suggestions remain drafts until each decision is reviewed and the batch is saved', async () => {
  const { page, requests, errors } = await setup('import', { run: run({ status: 'review', items: [{ id: 'item-a', revision: 1, studentId: 'student-a', studentName: 'Synthetic Student', sourceSectionId: 'section-a', reviewed: false, excluded: false, warnings: ['uncertain_digit'], proposed: { contacts: [contact({ id: 'suggested-a', name: 'Suggested Guardian', phones: ['555-0101'] })] } }] }) });
  try {
    const commit = page.getByRole('button', { name: 'Save all reviewed profiles together' }); await commit.waitFor(); assert.equal(await commit.isDisabled(), true);
    await page.getByRole('button', { name: 'Synthetic Student — Needs review' }).click();
    await page.getByLabel('Decision for Suggested Guardian').selectOption('keep');
    const review = page.getByRole('button', { name: 'Mark profile reviewed' }); assert.equal(await review.isDisabled(), true);
    await page.getByLabel('I checked this student, adult associations', { exact: false }).check(); await review.click();
    await page.getByRole('button', { name: 'Synthetic Student — Reviewed' }).waitFor();
    const decision = requests.find(value => value.path.endsWith('/items/item-a')); assert.deepEqual(decision.body.changes, []); assert.equal(decision.body.baseRevision, 1); assert.equal(decision.body.studentId, 'student-a');
    await page.getByRole('button',{name:'Synthetic Student — Reviewed'}).click();
    await page.getByLabel('Decision for Suggested Guardian').selectOption('add');
    assert.equal(await commit.isDisabled(),true);
    assert.equal(await page.getByLabel('I checked this student, adult associations',{exact:false}).isChecked(),false);
    await page.getByLabel('I checked this student, adult associations',{exact:false}).check();
    await page.getByRole('button',{name:'Mark profile reviewed'}).click();
    await page.getByRole('button',{name:'Synthetic Student — Reviewed'}).waitFor();
    assert.equal(requests.some(value => value.path.endsWith('/commit')), false); await commit.click();
    await page.getByText('Reviewed profiles saved.', { exact: false }).waitFor(); assert.equal(requests.filter(value => value.path.endsWith('/commit')).length, 1); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


test('synthetic directory and profile remain usable at desktop and phone widths', async () => {
  for (const mode of ['directory', 'profile']) {
    const {page, errors} = await setup(mode);
    try {
      await page.getByRole('heading', {name: mode === 'directory' ? 'Student information' : 'Synthetic Student', exact:true}).waitFor();
      for (const [label, width, height] of [['desktop',1280,900],['mobile',430,932]]) {
        await page.setViewportSize({width,height});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
        await page.screenshot({path:path.join(artifacts,`student-information-${mode}-${label}.png`),fullPage:true,animations:'disabled'});
      }
      await page.getByTestId('button-theme-toggle').click();
      await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));
      const colors=await page.evaluate(()=>({background:getComputedStyle(document.querySelector('.mydesk-page')).backgroundColor,ink:getComputedStyle(document.querySelector('.student-information')).color,underline:getComputedStyle(document.querySelector('.mydesk-tabs a[aria-current=page]')).borderBottomColor}));
      assert.equal(colors.background,'rgb(16, 24, 39)'); assert.equal(colors.ink,'rgb(227, 233, 249)'); assert.equal(colors.underline,'rgb(170, 188, 245)');
      await page.screenshot({path:path.join(artifacts,`student-information-${mode}-mobile-dark.png`),fullPage:true,animations:'disabled'});
      assert.deepEqual(errors,[]);
    } finally { await page.close(); }
  }
});
