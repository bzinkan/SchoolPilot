import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base, jpeg;
before(async () => {
  jpeg = `data:image/jpeg;base64,${(await sharp({ create: { width: 100, height: 60, channels: 3, background: '#125050' } }).jpeg().toBuffer()).toString('base64')}`;
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-windows-${process.pid}`,
    optimizeDeps: { entries: ['scripts/windows-browsers-fixture.jsx'] }, server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'windows-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__windows')) return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/__windows', '<html><body><div id="root"></div><script type="module" src="/scripts/windows-browsers-fixture.jsx"></script></body></html>'));
    }); } }] });
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

async function fixture({ ttl = 30_000, delayChrome = false, holdDecode = false, discoveryStatus = 200, missingBrowsers = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  await page.clock.install();
  const requests = [], held = [], errors = [];
  let denied = false, revision = 1;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/login', route => route.fulfill({ contentType: 'text/html', body: '<p>Signed out</p>' }));
  await page.addInitScript(({ holdDecode }) => {
    let visible = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visible });
    window.fixtureVisibility = value => { visible = value; document.dispatchEvent(new Event('visibilitychange')); };
    const original = HTMLImageElement.prototype.decode, pending = [];
    window.releaseDecode = () => { for (const release of pending.splice(0)) release(); };
    HTMLImageElement.prototype.decode = function () {
      return holdDecode ? new Promise((resolve, reject) => pending.push(() => original.call(this).then(resolve, reject))) : original.call(this);
    };
  }, { holdDecode });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, body = request.postDataJSON();
    requests.push({ path: pathname, method: request.method(), body });
    const now = Date.now();
    if (pathname.endsWith('/windows/tiles')) {
      if (discoveryStatus !== 200) return route.fulfill({ status: discoveryStatus, json: { code: 'WINDOWS_UNAVAILABLE' } });
      if (denied) return route.fulfill({ status: 403, json: { code: 'WINDOWS_AUTHORITY_CHANGED' } });
      const sources = ['chrome', 'edge'].map(browserFamily => {
        const sourceRef = `opaque-${browserFamily}`, bindingRevision = browserFamily === 'chrome' ? revision : 1;
        const selected = body.selectedSources?.some(target => target.sourceRef === sourceRef && target.bindingRevision === bindingRevision);
        return { browserFamily, sourceRef, bindingRevision, isLoggedIn: true, lastSeenAt: new Date(now).toISOString(),
          acceptedCapabilities: browserFamily === 'chrome' ? { exactTabTargetV1: true } : {}, extensionVersion: '1.0.0',
          ...(selected ? { screenshot: jpeg, screenshotAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString(),
            activeTabTitle: `${browserFamily} synthetic title`, activeTabUrl: `https://${browserFamily}.example/`,
            tabSnapshot: { tabs: [{ tabRef: `${browserFamily}-tab`, url: `https://${browserFamily}.example/` }] }, tabSnapshotRevision: 2 } : {}) };
      });
      const response = { enabled: true, serverTime: new Date(now).toISOString(), tiles: [{ studentId: 'student-a', platform: 'windows',
        windowsSession: { state: 'active' }, browserCoverage: ['chrome', 'edge'].map(browserFamily => ({ browserFamily, state: missingBrowsers ? 'unpaired' : 'connected' })),
        browserSources: missingBrowsers ? [] : sources }] };
      if (delayChrome && body.selectedSources?.some(target => target.sourceRef === 'opaque-chrome')) {
        held.push(() => route.fulfill({ json: response }).catch(() => {})); return;
      }
      return route.fulfill({ json: response });
    }
    if (pathname.includes('/native/observation-leases/')) return route.fulfill({ status: request.method() === 'DELETE' ? 204 : 200,
      ...(request.method() === 'DELETE' ? {} : { json: { serverTime: new Date(now).toISOString(), expiresAt: new Date(now + 45_000).toISOString(), renewAfterSeconds: 15 } }) });
    if (pathname.endsWith('/native/tiles/desktop')) return route.fulfill({ json: { enabled: true, serverTime: new Date(now).toISOString(),
      tiles: [{ studentId: 'student-a', sourceRef: 'native-source', bindingRevision: 1, state: 'available', sourceLabel: 'Selected source', platform: 'windows',
        ...(body.selectedSources ? { screenshot: jpeg, sequence: 1, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString() } : {}) }] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/__windows`);
  if (discoveryStatus !== 401) await page.getByTestId('card-student-student-a').waitFor();
  if (discoveryStatus === 200) {
    await page.getByTestId('preview-source-chrome-student-a').waitFor();
    await page.getByTestId('preview-source-edge-student-a').waitFor();
  }
  return { page, requests, errors, held, deny: () => { denied = true; }, replace: () => { revision++; }, allow: () => { delayChrome = false; } };
}
const image = page => page.getByTestId('windows-browser-image-student-a');
const select = (page, family) => page.getByTestId(`preview-source-${family}-student-a`).click();
const waitFor = (page, predicate) => page.waitForFunction(predicate);

test('Chrome + Edge require explicit selection; selected tabs/capabilities and enlarged source handoff stay separate', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal(f.requests.filter(row => row.path.endsWith('/windows/tiles') && row.body.selectedSources).length, 0);
    assert.equal(f.requests.filter(row => row.method === 'PUT').length, 0);
    await select(f.page, 'chrome'); await image(f.page).waitFor();
    assert.match(await image(f.page).getAttribute('alt'), /Chrome/);
    assert.equal((await f.page.evaluate(() => window.windowsFixture.snapshot())).tabs[0].tabRef, 'chrome-tab');
    await f.page.getByRole('button', { name: 'Enlarge Chrome for Synthetic Student' }).click();
    await f.page.getByTestId('expanded-windows-source-edge-student-a').click();
    await f.page.waitForFunction(() => [...document.querySelectorAll('img[alt*="Edge browser preview"]')].length === 2);
    assert.deepEqual((await f.page.evaluate(() => window.windowsFixture.snapshot())).capabilities, {});
    assert.equal(await f.page.locator('img[alt*="Chrome browser preview"]').count(), 0);
    assert.equal(f.requests.filter(row => row.method === 'PUT').length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.page.close(); }
});
test('late Chrome read cannot replace the selected Edge frame', { timeout: 45_000 }, async () => {
  const f = await fixture({ delayChrome: true });
  try {
    const requested = f.page.waitForRequest(request => request.url().endsWith('/windows/tiles') && request.postData()?.includes('opaque-chrome'));
    await select(f.page, 'chrome'); await requested;
    await select(f.page, 'edge'); await image(f.page).waitFor();
    for (const release of f.held) await release();
    assert.match(await image(f.page).getAttribute('alt'), /Edge/);
    assert.equal((await f.page.evaluate(() => window.windowsFixture.snapshot())).tabs[0].tabRef, 'edge-tab');
  } finally { await f.page.close(); }
});
test('source replacement and read denial clear image/tabs without falling back to Edge', { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    await select(f.page, 'chrome'); await image(f.page).waitFor();
    f.replace(); await f.page.evaluate(() => window.windowsFixture.refresh());
    await image(f.page).waitFor({ state: 'detached' });
    assert.equal((await f.page.evaluate(() => window.windowsFixture.snapshot())).selected, undefined);
    await select(f.page, 'chrome'); await image(f.page).waitFor();
    f.deny(); await f.page.evaluate(() => window.windowsFixture.refresh());
    await image(f.page).waitFor({ state: 'detached' });
    assert.deepEqual((await f.page.evaluate(() => window.windowsFixture.snapshot())).tabs, []);
    assert.equal(await f.page.getByTestId('preview-source-edge-student-a').getAttribute('aria-pressed'), 'false');
  } finally { await f.page.close(); }
});
test('server expiry clears pixels and delayed decode cannot revive an expired source', { timeout: 45_000 }, async () => {
  const f = await fixture({ ttl: 1500, holdDecode: true });
  try {
    await select(f.page, 'chrome');
    await waitFor(f.page, () => window.windowsFixture.snapshot().tabs?.length === 1);
    await f.page.clock.fastForward(2000); await f.page.evaluate(() => window.releaseDecode());
    assert.equal(await image(f.page).count(), 0);
  } finally { await f.page.close(); }
});
test('hidden page and authority change clear images and exact source selection', { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    await select(f.page, 'chrome'); await image(f.page).waitFor();
    await f.page.evaluate(() => window.fixtureVisibility('hidden')); await image(f.page).waitFor({ state: 'detached' });
    await f.page.evaluate(() => window.fixtureVisibility('visible')); await image(f.page).waitFor();
    await f.page.evaluate(() => window.windowsFixture.setContext('class-b')); await image(f.page).waitFor({ state: 'detached' });
    assert.equal((await f.page.evaluate(() => window.windowsFixture.snapshot())).selected, undefined);
  } finally { await f.page.close(); }
});
test('Desktop starts only its explicit viewer and leaving it retires that viewer while browser reads stay independent', { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    await select(f.page, 'chrome'); await image(f.page).waitFor();
    await select(f.page, 'desktop'); await f.page.getByTestId('desktop-image-student-a').waitFor();
    const lease = f.requests.find(row => row.method === 'PUT'); assert.ok(lease);
    assert.equal(await image(f.page).count(), 0);
    const released = f.page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === lease.path);
    await select(f.page, 'edge'); await released; await image(f.page).waitFor();
    assert.match(await image(f.page).getAttribute('alt'), /Edge/);
  } finally { await f.page.close(); }
});
test('first discovery denials fail closed and missing browser coverage stays visible without capture', { timeout: 45_000 }, async () => {
  for (const discoveryStatus of [401, 403, 503]) {
    const f = await fixture({ discoveryStatus });
    try {
      if (discoveryStatus === 401) {
        await f.page.waitForURL('**/login');
        assert.equal(await image(f.page).count(), 0);
        assert.equal(f.requests.some(row => row.method === 'PUT'), false);
        continue;
      }
      await f.page.getByText('Browser sources unavailable', { exact: true }).waitFor();
      assert.equal(await image(f.page).count(), 0);
      assert.deepEqual((await f.page.evaluate(() => window.windowsFixture.snapshot())).tabs, []);
      assert.equal(f.requests.some(row => row.method === 'PUT'), false);
    } finally { await f.page.close(); }
  }
  const f = await fixture({ missingBrowsers: true });
  try {
    assert.equal(await f.page.getByTestId('preview-source-chrome-student-a').isDisabled(), true);
    assert.equal(await f.page.getByTestId('preview-source-edge-student-a').isDisabled(), true);
    assert.match(await f.page.getByTestId('browser-coverage-student-a').innerText(), /Chrome: not paired.*Edge: not paired/);
    assert.equal(f.requests.some(row => row.method === 'PUT'), false);
  } finally { await f.page.close(); }
});
