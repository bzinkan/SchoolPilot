import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base;
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{QueryClientProvider}from'@tanstack/react-query';import{queryClient,apiRequest}from'/src/lib/queryClient.js';import Actions from'/src/products/classpilot/components/ClassroomActions.jsx';import'/src/index.css';const h=React.createElement;
function Harness(){const[scope,setScope]=useState('class-a');window.changeScope=()=>setScope('class-b');return h(Actions,{key:scope,scopeKey:scope,schoolId:'school-a',viewerId:'teacher-a',students:[{studentId:'a',studentName:'Alex Example',acceptedCapabilities:['scopedAuthorityChecksV1','focusTabV1']},{studentId:'b',studentName:'Blair Example',acceptedCapabilities:['scopedAuthorityChecksV1','focusTabV1']}],preciseResourcesEnabled:!location.search.includes('precise=off'),assertCurrent:()=>{},postCommand:(type,payload,ids)=>apiRequest('POST','/commands',{teachingSessionId:scope,targetScope:'students',targetStudentIds:ids,commandType:type,commandPayload:payload}),readCommand:(command,signal)=>apiRequest('GET','/classpilot/commands/'+command.id+'/status?teachingSessionId='+scope,undefined,{signal})});}createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(Harness)));`;
before(async () => {
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-classroom-actions-${process.pid}`, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'classroom-actions-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
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
  const state = { requests: [], commands: new Map(), polls: [], errors: [], ...options };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), body = req.method() === 'GET' ? undefined : req.postDataJSON();
    state.requests.push({ path: url.pathname, body }); const json = data => route.fulfill({ json: data });
    if (url.pathname.endsWith('/csrf')) return json({ csrfToken: 'synthetic' });
    if (url.pathname.endsWith('/classroom/courses')) return json({ courses: [{ id: 'course-a', name: 'Synthetic science course' }] });
    if (url.pathname.endsWith('/resources')) return json({ resources: [assignment] });
    if (url.pathname.endsWith('/preview-resources')) {
      if (state.holdPreview) await new Promise(resolve => { state.releasePreview = resolve; });
      const selected = body.resources.flatMap(item => item.links), website = body.boundary === 'website';
      const domains = website ? [...new Set(selected.map(item => new URL(item.url).hostname.replace(/^www\./, '')))] : [];
      const entries = website ? [] : selected.map(item => ({ url: item.url }));
      return json({ schemaVersion: 1, purpose: 'classroom', boundary: body.boundary,
        authoring: { allowedDomains: domains, resources: entries, resourceLinks: website ? domains.map(host => `https://${host}`) : selected.map(item => item.url) },
        scopes: website ? domains.map(hostname => ({ type: 'website', hostname, url: `https://${hostname}`, label: 'Entire website', description: 'Every page and subdomain is allowed.' }))
          : selected.map(item => ({ type: item.url === video.canonicalUrl ? 'resource' : 'section', url: item.url, label: item.url === video.canonicalUrl ? 'YouTube video' : 'Section', description: 'Only this reviewed boundary is allowed.' })),
        warnings: website ? domains.map(hostname => ({ hostname, message: `${hostname} allows other pages and subdomains.` })) : [], skipped: [],
      });
    }
    if (url.pathname.endsWith('/from-classroom')) return json({ reused: true, flightPath: { id: 'lesson-a', updatedAt: '2026-09-30T12:00:00.000Z',
      allowedDomains: body.boundary === 'website' ? body.resourceLinks.map(link => new URL(link).hostname) : [], blockedDomains: [],
      resources: body.boundary === 'website' ? [] : body.resourceLinks.map(link => link === video.canonicalUrl ? video : ({ type: 'section', hostname: 'science.example.test', includeSubdomains: false, pathPrefix: '/solar' })),
    } });
    if (url.pathname.endsWith('/commands') && req.method() === 'POST') {
      const value = command(body, `command-${state.commands.size + 1}`); state.commands.set(value.id, value);
      return json({ command: value });
    }
    if (url.pathname.endsWith('/status')) {
      const id = url.pathname.split('/').at(-2); state.polls.push(id);
      if (state.holdStatus) await new Promise(resolve => { state.releaseStatus = resolve; });
      const value = state.commands.get(id);
      const targets = value.targets.map(row => ({ ...row, status: value.commandType === 'apply-flight-path' && row.studentId === 'b' ? 'failed' : 'completed',
        result: value.commandType === 'apply-flight-path' ? { outcome: row.studentId === 'a' ? 'applied' : 'failed' }
          : value.commandPayload.focusAfterOpen ? { followUp: { kind: 'focus', state: 'refused' } } : {} }));
      return json({ command: { ...value, targets } });
    }
    return json({});
  });
  await page.goto(`${base}/__classroom_actions${options.preciseOff ? '?precise=off' : ''}`);
  await page.getByTestId('button-classroom-assignments').click();
  await page.getByLabel('Course', { exact: true }).selectOption('course-a');
  await page.getByLabel('Assignment or material').selectOption('assignment-a');
  return { page, state, close: async () => { state.releasePreview?.(); state.releaseStatus?.(); await page.unrouteAll({ behavior: 'wait' }); await page.close(); } };
}

test('Open uses explicit students and Open + Focus reports a refused continuation truthfully', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByLabel('Classroom action results').getByText(/Open: Confirmed/).first().waitFor();
    assert.deepEqual([...state.commands.values()][0].targetStudentIds, ['a', 'b']);
    assert.deepEqual([...state.commands.values()][0].commandPayload, { url: video.canonicalUrl });
    await page.getByRole('button', { name: 'Open + Focus', exact: true }).click();
    await page.getByLabel('Classroom action results').getByText(/Focus: Refused/).first().waitFor();
    assert.equal(state.requests.some(row => /allow-domain|lock-screen/.test(row.path)), false);
    assert.deepEqual(state.errors, []);
  } finally { await close(); }
});

test('Lesson keeps reviewed boundaries, pins source version and opens only the confirmed student', async () => {
  const { page, state, close } = await fixture({ mobile: true });
  try {
    const button = page.getByRole('button', { name: 'Open as Lesson', exact: true }); assert.equal(await button.isDisabled(), true);
    await page.getByTestId('button-review-restriction-scope').click();
    await page.getByLabel('Reviewed allowed scope').waitFor();
    assert.equal(await button.isEnabled(), true);
    if (process.env.CLASSROOM_UI_QA_DIR) { await mkdir(process.env.CLASSROOM_UI_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.CLASSROOM_UI_QA_DIR, 'classroom-mobile.png'), fullPage: true }); }
    assert.equal(await page.getByTestId('dialog-classroom-actions').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await button.click();
    await page.getByLabel('Classroom action results').getByText(/Open: Confirmed/).waitFor();
    const created = state.requests.find(row => row.path.endsWith('/from-classroom')).body;
    assert.equal(created.reuseReviewedSource, true); assert.equal(created.boundary, 'resource');
    assert.deepEqual(created.resources, [{ id: 'assignment-a' }]); assert.deepEqual(created.resourceLinks, assignment.links.map(link => link.url));
    const commands = [...state.commands.values()]; assert.equal(commands.length, 2);
    assert.deepEqual(commands[0].commandPayload, { flightPathId: 'lesson-a', expectedFlightPathUpdatedAt: '2026-09-30T12:00:00.000Z' });
    assert.deepEqual(commands[1].targetStudentIds, ['a']);
    assert.deepEqual(commands[1].commandPayload, { url: video.canonicalUrl, afterRestrictionCommandId: commands[0].id });
    await page.getByLabel('Classroom action results').getByText(/Open: not opened/).waitFor();
    assert.deepEqual(state.errors, []);
  } finally { await close(); }
});

test('broader Website warning is reviewed explicitly and any boundary edit invalidates it', async () => {
  const { page, state, close } = await fixture();
  try {
    await page.getByRole('radio', { name: 'Entire website and subdomains' }).check();
    await page.getByTestId('button-review-restriction-scope').click();
    await page.getByText('youtube.com allows other pages and subdomains.', { exact: true }).waitFor();
    await page.getByRole('radio', { name: 'Resource or Section' }).check();
    assert.equal(await page.getByRole('button', { name: 'Open as Lesson', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Reviewed allowed scope').count(), 0); assert.equal(state.commands.size, 0);
  } finally { await close(); }
});

test('authority retirement while a lesson acknowledgement is held cannot issue an open in the new scope', async () => {
  const { page, state, close } = await fixture({ holdStatus: true });
  try {
    await page.getByTestId('button-review-restriction-scope').click(); await page.getByLabel('Reviewed allowed scope').waitFor();
    await page.getByRole('button', { name: 'Open as Lesson', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Waiting for per-student browser results'));
    await page.waitForTimeout(1000); assert.ok(state.releaseStatus);
    await page.evaluate(() => window.changeScope()); state.releaseStatus(); state.holdStatus = false;
    await page.waitForTimeout(1000);
    assert.equal(await page.getByTestId('dialog-classroom-actions').count(), 0);
    assert.equal(state.commands.size, 1); assert.deepEqual(state.errors, []);
  } finally { await close(); }
});

test('precise mode off retains Open actions and blocks Lesson authoring', async () => {
  const { page, state, close } = await fixture({ preciseOff: true });
  try {
    assert.equal(await page.getByRole('button', { name: 'Open', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Open as Lesson', exact: true }).count(), 0);
    assert.equal(state.requests.some(row => row.path.endsWith('/preview-resources')), false);
  } finally { await close(); }
});
