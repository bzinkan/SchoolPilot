import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer, transformWithEsbuild } from 'vite';

test('Nested admin connector and staff operations protect drafts and veto navigation while committing', { timeout: 60_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {MemoryRouter,useLocation} from 'react-router-dom';import {QueryClientProvider} from '@tanstack/react-query';
    import {queryClient} from '/src/lib/queryClient.js';
    import Provider from '/src/products/classpilot/components/admin/AdminNavigationProvider.jsx';
    import {useAdminNavigation} from '/src/products/classpilot/hooks/useAdminNavigation.js';
    import Connector from '/src/shared/components/GoogleRosterConnectorPanel.jsx';
    import Transition from '/src/shared/components/StaffAccessTransitionDialog.jsx';import '/src/index.css';
    function Harness(){const [open,setOpen]=useState(false);const navigation=useAdminNavigation();const location=useLocation();
      window.leaveFixture=()=>{window.navigationResult=null;void navigation.navigate('/classpilot/admin?tab=audit').then(value=>window.navigationResult=value);};
      return <main><output aria-label="Current route">{location.pathname+location.search}</output><Connector />
        <button onClick={()=>setOpen(true)}>Review staff access</button><Transition open={open} onOpenChange={setOpen}
        staff={{membershipId:'member',userId:'staff-user',email:'staff@example.edu',role:'teacher'}} allStaff={[]} /></main>;}
    function OutsideHarness(){return <main><Connector /><Transition open={false} onOpenChange={()=>{}} staff={null} allStaff={[]} /></main>;}
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}>{window.location.search ? <OutsideHarness /> : <MemoryRouter initialEntries={['/classpilot/admin']}><Provider scopeKey="school-admin"><Harness /></Provider></MemoryRouter>}</QueryClientProvider>);`;
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'admin-nested-guards',
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__nested-guards')) return next();
      res.setHeader('Content-Type', 'text/html');res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/__nested-entry.jsx"></script></body></html>'));
    }); },
    resolveId(id) { if (id === '/__nested-entry.jsx') return '\0nested-entry'; },
    async load(id) { if (id === '\0nested-entry') return (await transformWithEsbuild(entry, '/__nested-entry.jsx', { loader: 'jsx' })).code; },
  }] });
  await vite.listen();
  let browser, releaseVerify, releaseDisable, releaseTransition;
  const errors = [], writes = [];
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture' } });
      if (url.pathname.endsWith('/setup-info')) return route.fulfill({ json: { serviceAccount: { configured: true }, serviceAccountClientId: 'fixture-client', schoolDomain: 'example.edu', scopes: [], connector: { status: 'verified', delegatedAdminEmail: 'saved@example.edu' } } });
      if (url.pathname.endsWith('/verify')) { writes.push({ kind: 'verify', body: request.postDataJSON() }); await new Promise(resolve => { releaseVerify = resolve; }); return route.fulfill({ json: { verified: true } }); }
      if (request.method() === 'DELETE') { writes.push({ kind: 'disable' }); await new Promise(resolve => { releaseDisable = resolve; }); return route.fulfill({ json: { disabled: true } }); }
      if (url.pathname.endsWith('/assignment-impact')) return route.fulfill({ json: { impact: { revision: 'reviewed-staff', assignments: [], blockers: [] } } });
      if (url.pathname.endsWith('/transition')) { writes.push({ kind: 'transition', body: request.postDataJSON() }); await new Promise(resolve => { releaseTransition = resolve; }); return route.fulfill({ json: { success: true } }); }
      return route.fulfill({ json: {} });
    });
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__nested-guards`);
    const email = page.getByRole('textbox', { name: 'Delegated administrator email' });
    await email.fill('reviewer@example.edu');
    await page.evaluate(() => window.leaveFixture());
    await page.getByRole('alertdialog', { name: 'Leave with unsaved changes?' }).waitFor();
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await email.inputValue(), 'reviewer@example.edu');
    assert.equal(await page.getByLabel('Current route').textContent(), '/classpilot/admin');
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[type=email]')?.disabled);
    await page.evaluate(() => window.leaveFixture());
    await page.waitForFunction(() => window.navigationResult === false);
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'A pending operation vetoes instead of offering discard');
    assert.equal(await page.getByRole('button', { name: 'Disable', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Current route').textContent(), '/classpilot/admin');
    releaseVerify();
    await page.waitForFunction(() => !document.querySelector('input[type=email]')?.disabled);
    assert.equal(await email.inputValue(), '', 'Acknowledged verification clears only the submitted setup draft');
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[type=email]')?.disabled);
    await page.evaluate(() => window.leaveFixture());await page.waitForFunction(() => window.navigationResult === false);
    releaseDisable();await page.waitForFunction(() => !document.querySelector('input[type=email]')?.disabled);
    await page.getByRole('button', { name: 'Review staff access', exact: true }).click();
    await page.getByTestId('button-confirm-remove-access').click();
    await page.getByRole('button', { name: /Removing access/ }).waitFor();
    await page.evaluate(() => window.leaveFixture());await page.waitForFunction(() => window.navigationResult === false);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByTestId('dialog-staff-transition').isVisible(), true, 'Escape cannot hide a committing staff transition');
    releaseTransition();await page.getByTestId('dialog-staff-transition').waitFor({ state: 'hidden' });
    assert.deepEqual(writes.map(write => write.kind), ['verify', 'disable', 'transition']);
    assert.equal(writes[2].body.expectedRevision, 'reviewed-staff');
    assert.equal(writes[2].body.action, 'deactivate');
    await email.fill('another@example.edu');await page.evaluate(() => window.leaveFixture());
    await page.getByRole('button', { name: 'Discard changes and leave', exact: true }).click();
    await page.waitForFunction(() => window.navigationResult === true);
    // Acceptance precedes the router's asynchronous render of the destination.
    await page.waitForFunction(() => document.querySelector('[aria-label="Current route"]')?.textContent === '/classpilot/admin?tab=audit');
    assert.equal(await email.inputValue(), '');
    assert.equal(await page.getByLabel('Current route').textContent(), '/classpilot/admin?tab=audit');
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__nested-guards?outside=1`);
    await page.getByRole('textbox', { name: 'Delegated administrator email' }).fill('outside@example.edu');
    assert.equal(await page.getByRole('textbox', { name: 'Delegated administrator email' }).inputValue(), 'outside@example.edu', 'Shared components work without an Admin provider or router');
    assert.deepEqual(errors, []);
  } finally { releaseVerify?.();releaseDisable?.();releaseTransition?.();await browser?.close();await vite.close(); }
});
