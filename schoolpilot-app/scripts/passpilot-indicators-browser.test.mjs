import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('staff selects an exact kiosk or fixed class and keeps the gateway credential private', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import Setup from '/src/products/passpilot/pages/IndicatorSetup.jsx';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(Setup,{user:{id:'staff-a',schoolId:'school-a'}})));`;
  let vite, browser;
  try {
    vite = await createServer({ root, logLevel: 'error', cacheDir: 'node_modules/.vite-indicator-tests', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'indicator-test', configureServer(server) {
      server.middlewares.use(async (req, res, next) => { if (req.url !== '/__indicator') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__indicator-entry.jsx"></script></body></html>')); });
    }, resolveId(id) { if (id === '/__indicator-entry.jsx') return '\0indicator-entry'; }, load(id) { if (id === '\0indicator-entry') return entry; } }] });
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 430, height: 900 } });
    const requests = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('sp_activeSchoolId', 'school-a'));
    const token = `ppi_${'a'.repeat(43)}`;
    const pairingId = '9801f5da-6f71-4c88-a370-2ea2112c114a';
    const kioskSessionId = '5f0a1994-c142-40f8-9332-58af90d578a1';
    const deviceId = 'private-kiosk-device';
    const displayToken = 'private-kiosk-display-credential';
    const expiresAt = '2099-01-01T00:00:00Z';
    let kioskListResponse = 'error';
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      requests.push({ path: url.pathname, method: req.method(), body: req.postData(), headers: req.headers() });
      if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'synthetic-csrf' } });
      if (url.pathname.endsWith('/pairings/kiosks')) {
        if (kioskListResponse === 'error') return route.fulfill({ status: 503, json: {} });
        return route.fulfill({ json: { kiosks: kioskListResponse === 'empty' ? [] : [{
          kioskSessionId, className: 'Homeroom', lastSeenAt: '2026-11-20T15:12:00Z', deviceId, displayToken,
        }] } });
      }
      if (url.pathname.endsWith('/classes')) return route.fulfill({ json: { source: 'legacy_grades', classes: [{ id: 'class-a', name: 'Homeroom', status: 'active' }, { id: 'archived', name: 'Archived', status: 'archived' }] } });
      if (req.method() === 'POST') return route.fulfill({ status: 201, json: { pairingId, token, expiresAt, deviceId, displayToken } });
      if (req.method() === 'DELETE') return route.fulfill({ status: 204 });
      return route.fulfill({ status: 404, json: {} });
    });
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    await page.goto(`${origin}/__indicator`);
    await page.getByRole('radio', { name: 'Follow a kiosk' }).waitFor({ timeout: 4000 });
    assert.ok(await page.getByRole('radio', { name: 'Follow a kiosk' }).isChecked());
    await page.getByRole('alert').filter({ hasText: 'Kiosks could not be loaded' }).waitFor();
    kioskListResponse = 'empty';
    await page.getByRole('button', { name: 'Refresh kiosk list' }).click();
    await page.getByText('No active kiosks found.', { exact: false }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Create pairing' }).isDisabled());
    kioskListResponse = 'ready';
    await page.getByRole('button', { name: 'Refresh kiosk list' }).click();
    await page.getByRole('option', { name: /D578A1.*Homeroom.*last seen/i }).waitFor({ state: 'attached', timeout: 4000 });
    assert.ok(await page.getByText(/Match the light pairing code shown on the kiosk/i).isVisible());
    const kioskSelect = page.getByRole('combobox', { name: 'Kiosk', exact: true });
    assert.equal(await kioskSelect.inputValue(), '');
    assert.ok(await page.getByRole('button', { name: 'Create pairing' }).isDisabled());
    assert.ok(!requests.some(r => r.path.endsWith('/classes')));
    assert.ok(!await page.locator('body').innerHTML().then(html => html.includes(deviceId) || html.includes(displayToken)));
    await kioskSelect.selectOption(kioskSessionId);
    await page.getByRole('button', { name: 'Create pairing' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download private pairing file' }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), `pairing-${pairingId}.json`);
    const stream = await download.createReadStream();
    let downloaded = ''; for await (const chunk of stream) downloaded += chunk;
    assert.deepEqual(JSON.parse(downloaded), { pairingId, token, expiresAt, apiUrl: `${origin}/api/passpilot/indicators/state` });
    const post = requests.find(r => r.method === 'POST');
    assert.deepEqual(JSON.parse(post.body), { kioskSessionId });
    assert.equal(post.headers['x-passpilot-class-model'], 'classpilot-groups-v1');
    assert.equal(post.headers['x-csrf-token'], 'synthetic-csrf');
    assert.ok(!await page.locator('body').innerText().then(t => t.includes(token)));
    assert.ok(!page.url().includes(token));
    const browserStorage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    for (const credential of [token, deviceId, displayToken]) assert.ok(!browserStorage.includes(credential));
    await page.getByRole('button', { name: 'Revoke pairing' }).click();
    await page.getByRole('status').filter({ hasText: 'Pairing revoked' }).waitFor();
    assert.ok(requests.some(r => r.method === 'DELETE' && r.path.endsWith(`/${pairingId}`)));
    assert.equal(await page.getByRole('button', { name: 'Download private pairing file' }).count(), 0);

    await page.getByRole('radio', { name: 'Follow one class' }).check();
    await page.getByRole('combobox', { name: 'Class', exact: true }).selectOption('class-a');
    assert.equal(await page.getByRole('option', { name: 'Archived', exact: true }).count(), 0);
    await page.getByLabel('Water destination (optional)').fill(' Water Fountain ');
    await page.getByRole('button', { name: 'Create pairing' }).click();
    await page.getByRole('button', { name: 'Download private pairing file' }).waitFor();
    assert.deepEqual(JSON.parse(requests.filter(r => r.method === 'POST').at(-1).body), { classId: 'class-a', waterCustomDestination: ' Water Fountain ' });
    assert.ok(requests.every(r => !JSON.stringify(r).includes(deviceId) && !JSON.stringify(r).includes(displayToken)));
    assert.ok(requests.every(r => !r.path.includes(token)));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await vite?.close(); }
});
