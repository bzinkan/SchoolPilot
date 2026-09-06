import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test('import review exposes every named change and cannot carry a held approval into a new preview', { timeout: 60_000 }, async context => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {ImportReview} from '/src/products/classpilot/components/RosterIntegrations.jsx';const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(ImportReview,{runId:'run',connectionId:'connection',onComplete:()=>{}})));`;
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'roster-review-browser-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== '/__roster-review') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__roster-entry.jsx"></script></body></html>')); }); }, resolveId(id) { if (id === '/__roster-entry.jsx') return '\0roster-review-entry'; }, load(id) { if (id === '\0roster-review-entry') return entry; } }] });
  await vite.listen();
  let browser;
  context.signal.addEventListener('abort', () => { void browser?.close(); void vite.close(); }, { once: true });
  let hash = 'a'.repeat(64);
  let run = { id: 'run', connectionId: 'connection', status: 'held', planHash: hash, cursor: 0, totalSteps: 1, summary: { removeStudentMemberships: 51 }, mapping: { organizationIds: ['org'] }, organizations: [{ id: 'org', name: 'School', type: 'school' }], holds: ['large_removal_student_memberships'], unresolved: [], unresolvedCount: 0, warnings: [] };
  const writes = [], requests = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture-csrf' } });
      if (url.pathname.endsWith('/preview')) { hash = 'b'.repeat(64); run = { ...run, planHash: hash }; return route.fulfill({ json: { run } }); }
      if (url.pathname.endsWith('/apply')) { writes.push(request.postDataJSON()); run = { ...run, status: 'completed', planHash: null }; return route.fulfill({ json: { run } }); }
      if (url.pathname.endsWith('/rows')) { if (url.searchParams.get('planHash') !== hash) return route.fulfill({ status: 409, json: { error: 'This preview changed.' } }); return route.fulfill({ json: { planHash: hash, total: 1, rows: [{ kind: 'class', externalId: 'source-class', internalId: 'class', create: false, name: 'Math A', changes: { name: 'Math A' }, ownedFields: ['name'], studentCount: 3, coTeacherCount: 1 }] } }); }
      if (url.pathname.endsWith('/review')) {
        if (url.searchParams.get('planHash') !== hash) return route.fulfill({ status: 409, json: { error: 'This preview changed.' } }); const pageNumber = Number(url.searchParams.get('page')); requests.push({ hash, page: pageNumber });
        const rows = [{ stepIndex: 0, kind: 'class', name: 'Math A', type: 'field', field: { field: 'name', before: 'Old Math', after: 'Math A' } }, ...Array.from({ length: 51 }, (_, i) => ({ stepIndex: 0, kind: 'class', name: 'Math A', type: 'membership', member: { memberType: i === 0 ? 'teacher' : 'student', memberId: `person-${i}`, name: i === 0 ? 'Former Teacher' : `Removed Student ${i}`, beforeRole: i === 0 ? 'primary' : 'student', afterRole: i === 0 ? 'co-teacher' : null } }))];
        return route.fulfill({ json: { planHash: hash, page: pageNumber, pageSize: 50, total: rows.length, rows: rows.slice(pageNumber * 50, pageNumber * 50 + 50) } });
      }
      if (url.pathname.endsWith('/runs/run')) return route.fulfill({ json: { run } });
      return route.fulfill({ json: { candidates: [] } });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__roster-review`);
    const review = page.getByRole('region', { name: 'Named roster changes' });
    await review.getByText('Old Math', { exact: true }).waitFor();
    await review.getByText('Former Teacher', { exact: true }).waitFor();
    await review.getByText('Removed Student 1', { exact: true }).waitFor();
    const approval = page.getByRole('checkbox', { name: /I reviewed every page/ });
    assert.equal(await approval.isDisabled(), true); assert.equal(await page.getByRole('button', { name: 'Apply reviewed import', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Next changes', exact: true }).click();
    await review.getByText('Removed Student 50', { exact: true }).waitFor();
    await approval.check(); assert.equal(await page.getByRole('button', { name: 'Apply reviewed import', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await review.getByText('Old Math', { exact: true }).waitFor();
    assert.equal(await approval.isChecked(), false); assert.equal(await approval.isDisabled(), true);
    await page.getByRole('button', { name: 'Next changes', exact: true }).click();
    await review.getByText('Removed Student 50', { exact: true }).waitFor();
    await approval.check(); await page.getByRole('button', { name: 'Apply reviewed import', exact: true }).click();
    await page.getByText('Import completed. Existing student history and PINs were preserved.', { exact: true }).waitFor();
    assert.deepEqual(writes, [{ planHash: 'b'.repeat(64), approveHeld: true }]);
    assert(requests.some(row => row.hash === 'a'.repeat(64) && row.page === 1)); assert(requests.some(row => row.hash === 'b'.repeat(64) && row.page === 1)); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await vite.close(); }
});
