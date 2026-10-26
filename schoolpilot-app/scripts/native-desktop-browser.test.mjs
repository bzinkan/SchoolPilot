import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createDesktopMetadataRequests, desktopDeadline } from '../src/products/classpilot/lib/nativeDesktop.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, base, jpeg;
before(async () => {
  jpeg = `data:image/jpeg;base64,${(await sharp({ create: { width: 240, height: 135, channels: 3, background: '#194c63' } }).jpeg().toBuffer()).toString('base64')}`;
  vite = await createServer({ root, logLevel: 'error', cacheDir: `node_modules/.vite-native-desktop-${process.pid}`,
    optimizeDeps: { entries: ['scripts/native-desktop-fixture.jsx'] },
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'native-desktop-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__native-desktop')) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml('/__native-desktop', '<html><body><div id="root"></div><script type="module" src="/scripts/native-desktop-fixture.jsx"></script></body></html>'));
      });
    } }] });
  await vite.listen();
  base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await vite?.close(); });

async function open({ browserSource = true, enabled = true, imageTtl = 30_000, holdImage = false, holdDecode = false, holdGrant = false,
  initialMetadataState = 'available', initialBound = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  await page.clock.install();
  const requests = [], errors = [], held = [], heldGrants = [];
  let revision = 1;
  let delayImages = holdImage;
  let imageStatus = 200;
  let imageState = 'available';
  let metadataStatus = 200;
  let grantStatus = 200;
  let delayGrants = holdGrant;
  let featureEnabled = enabled;
  let metadataState = initialMetadataState;
  let metadataBound = initialBound;
  let missingMetadata = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ holdDecode }) => {
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visibility });
    window.setFixtureVisibility = value => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); };
    const decode = HTMLImageElement.prototype.decode;
    const decoders = [];
    window.releaseNativeDecodes = () => { for (const run of decoders.splice(0)) run(); };
    HTMLImageElement.prototype.decode = function () {
      return holdDecode && this.src.startsWith('data:image/jpeg') ? new Promise((resolve, reject) => {
        decoders.push(() => decode.call(this).then(resolve, reject));
      }) : decode.call(this);
    };
  }, { holdDecode });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON();
    requests.push({ method: request.method(), path: url.pathname, body });
    const now = Date.now();
    if (url.pathname.includes('/native/observation-leases/')) {
      if (request.method() === 'DELETE') return route.fulfill({ status: 204 });
      if (grantStatus !== 200) return route.fulfill({ status: grantStatus, json: { code: 'NATIVE_UNAVAILABLE' } });
      const reply = () => route.fulfill({ json: { serverTime: new Date(now).toISOString(), expiresAt: new Date(now + 45_000).toISOString(), renewAfterSeconds: 15 } }).catch(() => {});
      if (delayGrants) { heldGrants.push(reply); return; }
      return reply();
    }
    if (url.pathname.endsWith('/native/tiles/desktop')) {
      if (!body.selectedSources && metadataStatus !== 200) return route.fulfill({ status: metadataStatus, json: { code: 'NATIVE_UNAVAILABLE' } });
      const row = studentId => ({ studentId,
        ...(body.selectedSources || metadataBound ? { sourceRef: `source-${revision}`, bindingRevision: revision } : {}),
        state: body.selectedSources ? imageState : metadataState, sourceLabel: 'Selected source', platform: 'windows' });
      if (body.selectedSources && imageStatus !== 200) return route.fulfill({ status: imageStatus, json: { error: 'Observation unavailable' } });
      const response = { enabled: featureEnabled, serverTime: new Date(now).toISOString(), tiles: featureEnabled && (!missingMetadata || body.selectedSources) ? body.studentIds.map(studentId => ({ ...row(studentId),
        ...(body.selectedSources ? { screenshot: jpeg, sequence: 1, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + imageTtl).toISOString(),
          foregroundApplication: { id: 'synthetic-editor', displayName: 'Synthetic Editor', observedAt: new Date(now).toISOString() } } : {}),
      })) : [] };
      if (body.selectedSources && delayImages) { held.push(() => route.fulfill({ json: response }).catch(() => {})); return; }
      return route.fulfill({ json: response });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}/__native-desktop?browser=${browserSource}`, { timeout: 60_000 });
  await page.getByTestId('card-student-student-a').waitFor();
  if (enabled) await page.getByTestId('preview-source-desktop-student-a').waitFor();
  return { page, requests, errors, held, heldGrants,
    allowImages: () => { delayImages = false; },
    replaceBinding: () => { revision += 1; },
    denyImages: () => { imageStatus = 403; },
    setImageStatus: status => { imageStatus = status; },
    setImageState: state => { imageState = state; },
    setMetadataStatus: status => { metadataStatus = status; },
    setGrantStatus: status => { grantStatus = status; },
    delayGrants: value => { delayGrants = value; },
    disableFeature: () => { featureEnabled = false; },
    setMetadata: (state, bound = true) => { metadataState = state; metadataBound = bound; },
    omitMetadata: () => { missingMetadata = true; },
  };
}
const imageReads = requests => requests.filter(request => request.body?.selectedSources);
const leases = requests => requests.filter(request => request.method === 'PUT');

test('desktop metadata batches exact contexts and lease clock is monotonic and conservative', () => {
  const requests = createDesktopMetadataRequests(Array.from({ length: 51 }, (_, i) => ({ studentId: `s${i}` })), {
    schoolId: 'school', viewerId: 'staff', authority: { teachingSessionId: 'class' },
  });
  assert.deepEqual(requests.map(request => request.body.studentIds.length), [50, 1]);
  assert.ok(requests.every(request => request.body.teachingSessionId === 'class' && !('selectedSources' in request.body)));
  assert.deepEqual(createDesktopMetadataRequests([{ studentId: 's' }], { schoolId: 'school', viewerId: 'staff', authority: {} }), []);
  assert.equal(desktopDeadline('2026-10-26T12:00:45Z', '2026-10-26T12:00:00Z', 100, 300), 45_100);
  assert.equal(desktopDeadline('bad', 'bad', 100, 300), 300);
});

test('both sources default Browser; explicitly selecting Desktop starts its exact viewer and Browser retires it', async () => {
  const { page, requests, errors } = await open();
  try {
    assert.equal(await page.getByTestId('preview-source-browser-student-a').getAttribute('aria-pressed'), 'true');
    assert.equal(leases(requests).length, 0); assert.equal(imageReads(requests).length, 0);
    await page.getByTestId('preview-source-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.getByText(/Synthetic Editor/).waitFor();
    assert.equal(leases(requests).length, 1);
    assert.ok(imageReads(requests)[0].body.viewerInstanceId);
    await page.getByTestId('preview-source-browser-student-a').click();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    await page.waitForFunction(() => document.querySelector('[data-testid="preview-source-browser-student-a"]').getAttribute('aria-pressed') === 'true');
    await page.getByTestId('preview-source-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    assert.equal(leases(requests).length, 2);
    assert.ok(requests.some(request => request.method === 'DELETE'));
    assert.equal(JSON.stringify(await page.evaluate(() => window.nativeFixture.cache())).includes('data:image'), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('native-only signed-out browser still supports desktop without enabling browser controls', async () => {
  const { page, requests, errors } = await open({ browserSource: false });
  try {
    assert.equal(await page.getByTestId('preview-source-desktop-student-a').getAttribute('aria-pressed'), 'true');
    await page.getByText('Browser monitoring and controls unavailable.').waitFor();
    assert.equal(await page.getByTestId('button-manage-tabs-student-a').count(), 0);
    assert.equal(leases(requests).length, 0);
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.screenshot({ path: path.join(os.tmpdir(), 'schoolpilot-native-desktop-preview.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('hide clears native images and late responses; resume revalidates with a new viewer', async () => {
  const { page, requests, errors, held, allowImages } = await open({ browserSource: false, holdImage: true });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.waitForTimeout(100);
    assert.equal(held.length, 1);
    await page.evaluate(() => window.setFixtureVisibility('hidden'));
    await held.shift()();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    allowImages();
    await page.evaluate(() => window.setFixtureVisibility('visible'));
    await page.getByTestId('desktop-image-student-a').waitFor();
    assert.equal(new Set(leases(requests).map(request => request.path)).size, 2);
    await page.evaluate(() => window.setFixtureVisibility('hidden'));
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('native expiry removes tile, enlarged image and application despite local wall-clock rollback', async () => {
  const { page, requests, errors } = await open({ browserSource: false, imageTtl: 1500 });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.getByRole('button', { name: 'Enlarge desktop for Synthetic Student' }).click();
    await page.getByTestId('expanded-desktop-preview').waitFor();
    await page.clock.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    await page.clock.fastForward(2000);
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    assert.equal(await page.getByTestId('expanded-desktop-preview').locator('img').count(), 0);
    assert.equal(requests.some(request => request.method === 'DELETE'), false, 'Image expiry preserves the active viewer');
    await page.clock.fastForward(3_100);
    await page.getByTestId('expanded-desktop-preview').locator('img').waitFor();
    assert.equal(leases(requests).length, 1, 'Next scheduled frame does not require a new viewer or user click');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('a decode completing after source change never revives native pixels', async () => {
  const { page, requests, errors } = await open({ browserSource: false, holdDecode: true });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-state-student-a').filter({ hasText: 'Loading desktop thumbnail' }).waitFor();
    await page.getByTestId('preview-source-browser-student-a').click();
    await page.evaluate(() => window.releaseNativeDecodes());
    await page.getByTestId('preview-source-desktop-student-a').click();
    await page.getByTestId('desktop-state-student-a').filter({ hasText: 'Loading' }).waitFor();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(leases(requests).length, 2);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('replacement binding clears native pixels and requires a new explicit View', async () => {
  const { page, requests, errors, replaceBinding } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    replaceBinding();
    await page.evaluate(() => window.nativeFixture.refresh());
    await page.getByTestId('view-desktop-student-a').waitFor();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    assert.equal(leases(requests).length, 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('default-off metadata adds no UI and no lease or image requests', async () => {
  const { page, requests, errors } = await open({ enabled: false });
  try {
    await page.waitForTimeout(100);
    await page.clock.fastForward(60_000);
    assert.equal(await page.getByTestId('preview-source-desktop-student-a').count(), 0);
    assert.equal(leases(requests).length, 0); assert.equal(imageReads(requests).length, 0);
    assert.equal(requests.filter(request => request.path.endsWith('/native/tiles/desktop')).length, 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('a late grant response after source deselection is released and never requests pixels', async () => {
  const { page, requests, errors, heldGrants } = await open({ browserSource: false, holdGrant: true });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-state-student-a').filter({ hasText: 'Authorizing' }).waitFor();
    await page.waitForTimeout(50);
    assert.equal(heldGrants.length, 1);
    await page.getByTestId('preview-source-browser-student-a').click();
    await heldGrants.shift()();
    await page.waitForTimeout(50);
    assert.equal(imageReads(requests).length, 0);
    assert.ok(requests.filter(request => request.method === 'DELETE').length >= 2);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('read denial and feature disable clear native content without switching back to Browser', async () => {
  const { page, requests, errors, denyImages, disableFeature } = await open();
  try {
    await page.getByTestId('preview-source-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    denyImages();
    await page.clock.fastForward(5_100);
    await page.getByTestId('desktop-state-student-a').filter({ hasText: 'unavailable' }).waitFor();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByTestId('preview-source-desktop-student-a').getAttribute('aria-pressed'), 'true');
    const count = imageReads(requests).length;
    await page.clock.fastForward(20_000);
    assert.equal(imageReads(requests).length, count);
    disableFeature();
    await page.evaluate(() => window.nativeFixture.refresh());
    assert.equal(await page.getByTestId('preview-source-desktop-student-a').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('two viewers have independent grants; stopping one preserves the other viewer', async () => {
  const first = await open({ browserSource: false });
  const second = await open({ browserSource: false });
  try {
    for (const { page } of [first, second]) {
      await page.getByTestId('view-desktop-student-a').click();
      await page.getByTestId('desktop-image-student-a').waitFor();
    }
    const firstId = leases(first.requests)[0].path;
    const secondId = leases(second.requests)[0].path;
    assert.notEqual(firstId, secondId);
    await first.page.getByRole('button', { name: 'Stop viewing', exact: true }).click();
    assert.equal(await first.page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await second.page.getByTestId('desktop-image-student-a').count(), 1);
    assert.equal(second.requests.some(request => request.method === 'DELETE'), false);
    assert.deepEqual([...first.errors, ...second.errors], []);
  } finally { await first.page.close(); await second.page.close(); }
});

test('selected-read 503 retires intent across hide/show; explicit Retry creates a fresh viewer', async () => {
  const { page, requests, errors, setImageStatus } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.getByRole('button', { name: 'Enlarge desktop for Synthetic Student' }).click();
    setImageStatus(503);
    await page.clock.fastForward(5_100);
    await page.getByTestId('expanded-view-desktop').filter({ hasText: 'Retry desktop' }).waitFor();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    assert.ok(requests.some(request => request.method === 'DELETE'));
    const originalViewer = leases(requests)[0].path;
    const readCount = imageReads(requests).length;
    setImageStatus(200);
    await page.evaluate(() => window.setFixtureVisibility('hidden'));
    await page.evaluate(() => window.setFixtureVisibility('visible'));
    await page.clock.fastForward(60_000);
    await page.waitForTimeout(50);
    assert.equal(leases(requests).length, 1, 'Tab visibility must not restore failed observation intent');
    assert.equal(imageReads(requests).length, readCount);
    assert.equal(await page.getByTestId('preview-source-desktop-student-a').getAttribute('aria-pressed'), 'true');
    await page.getByTestId('expanded-view-desktop').click();
    await page.getByTestId('desktop-image-student-a').first().waitFor();
    assert.notEqual(leases(requests).at(-1).path, originalViewer);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('metadata 503 immediately clears all desktop surfaces and recovery requires explicit View', async () => {
  const { page, requests, errors, setMetadataStatus } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.getByRole('button', { name: 'Enlarge desktop for Synthetic Student' }).click();
    setMetadataStatus(503);
    await page.evaluate(() => window.nativeFixture.refresh());
    await page.getByTestId('desktop-state-student-a').filter({ hasText: 'unavailable' }).waitFor();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    assert.ok(requests.some(request => request.method === 'DELETE'));
    setMetadataStatus(200);
    await page.evaluate(() => window.nativeFixture.refresh());
    await page.getByTestId('expanded-view-desktop').filter({ hasText: 'View desktop' }).waitFor();
    await page.clock.fastForward(60_000);
    assert.equal(leases(requests).length, 1);
    await page.getByTestId('expanded-view-desktop').click();
    await page.getByTestId('desktop-image-student-a').first().waitFor();
    assert.notEqual(leases(requests)[0].path, leases(requests)[1].path);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('selected-read health denial releases immediately before the next metadata poll', async () => {
  for (const health of ['offline', 'policy_paused', 'permission_required']) {
    const { page, requests, errors, setImageState } = await open({ browserSource: false });
    try {
      await page.getByTestId('view-desktop-student-a').click();
      await page.getByTestId('desktop-image-student-a').waitFor();
      setImageState(health);
      await page.clock.fastForward(5_100);
      await page.waitForTimeout(50);
      assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
      assert.ok(requests.some(request => request.method === 'DELETE'), `${health} must release without waiting for metadata`);
      const readCount = imageReads(requests).length;
      setImageState('available');
      await page.evaluate(() => {
        window.setFixtureVisibility('hidden'); window.setFixtureVisibility('visible');
      });
      await page.clock.fastForward(30_000);
      assert.equal(imageReads(requests).length, readCount);
      assert.equal(leases(requests).length, 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('renewal 503 and offline retire intent until Retry, including visibility recovery', async () => {
  for (const failure of ['renewal', 'offline']) {
    const { page, requests, errors, setGrantStatus } = await open({ browserSource: false });
    try {
      await page.getByTestId('view-desktop-student-a').click();
      await page.getByTestId('desktop-image-student-a').waitFor();
      if (failure === 'renewal') {
        setGrantStatus(503);
        await page.clock.fastForward(15_100);
      } else await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.getByTestId('view-desktop-student-a').filter({ hasText: 'Retry desktop' }).waitFor();
      assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
      const grantCount = leases(requests).length;
      setGrantStatus(200);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        window.setFixtureVisibility('hidden');
        window.setFixtureVisibility('visible');
      });
      await page.clock.fastForward(60_000);
      await page.waitForTimeout(50);
      assert.equal(leases(requests).length, grantCount, `${failure} must not silently regrant`);
      await page.getByTestId('view-desktop-student-a').click();
      await page.getByTestId('desktop-image-student-a').waitFor();
      assert.notEqual(leases(requests)[0].path, leases(requests).at(-1).path);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('late successful renewal after read 503 is released without reviving content or the retired viewer', async () => {
  const { page, requests, errors, setImageStatus, delayGrants, heldGrants } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    delayGrants(true);
    await page.clock.fastForward(15_100);
    await page.waitForTimeout(50);
    assert.equal(heldGrants.length, 1);
    setImageStatus(503);
    await page.clock.fastForward(5_100);
    await page.getByTestId('view-desktop-student-a').filter({ hasText: 'Retry desktop' }).waitFor();
    const readCount = imageReads(requests).length;
    await heldGrants.shift()();
    await page.waitForTimeout(50);
    assert.ok(requests.filter(request => request.method === 'DELETE').length >= 2);
    assert.equal(imageReads(requests).length, readCount);
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    delayGrants(false);
    setImageStatus(200);
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    assert.notEqual(leases(requests)[0].path, leases(requests).at(-1).path);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('changing classroom context retires native work and requires a new View action', async () => {
  const { page, requests, errors } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.evaluate(() => window.nativeFixture.setContext('class-b'));
    await page.getByTestId('view-desktop-student-a').waitFor();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(leases(requests).length, 1);
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    assert.equal(leases(requests)[1].body.teachingSessionId, 'class-b');
    assert.notEqual(leases(requests)[0].path, leases(requests)[1].path);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Stop then View cannot display pixels authorized by the previous grant', async () => {
  const { page, requests, errors } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.getByRole('button', { name: 'Stop viewing', exact: true }).click();
    let completeGrant;
    await page.route('**/api/classpilot/native/observation-leases/*', async route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      completeGrant = () => route.fallback();
    });
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-state-student-a').filter({ hasText: 'Authorizing' }).waitFor();
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    await page.waitForTimeout(50);
    await completeGrant();
    await page.getByTestId('desktop-image-student-a').waitFor();
    assert.notEqual(leases(requests)[0].path, leases(requests)[1].path);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('native source arriving later changes only an untouched default and never starts collection', async () => {
  for (const chooseBrowser of [false, true]) {
    const { page, requests, errors, setMetadata } = await open({ browserSource: false, initialMetadataState: 'unbound', initialBound: false });
    try {
      if (chooseBrowser) await page.getByTestId('preview-source-browser-student-a').click();
      setMetadata('available');
      await page.evaluate(() => window.nativeFixture.refresh());
      assert.equal(await page.getByTestId(`preview-source-${chooseBrowser ? 'browser' : 'desktop'}-student-a`).getAttribute('aria-pressed'), 'true');
      if (!chooseBrowser) await page.getByTestId('view-desktop-student-a').waitFor();
      assert.equal(leases(requests).length, 0);
      assert.equal(imageReads(requests).length, 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('unhealthy same-binding metadata immediately clears pixels and lease; recovery requires explicit View', async () => {
  for (const state of ['offline', 'policy_paused', 'permission_required']) {
    const { page, requests, errors, setMetadata } = await open({ browserSource: false });
    try {
      await page.getByTestId('view-desktop-student-a').click();
      await page.getByTestId('desktop-image-student-a').waitFor();
      setMetadata(state);
      await page.evaluate(() => window.nativeFixture.refresh());
      assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
      assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
      assert.equal(await page.getByTestId('preview-source-desktop-student-a').getAttribute('aria-pressed'), 'true');
      assert.ok(requests.some(request => request.method === 'DELETE'));
      setMetadata('available');
      await page.evaluate(() => window.nativeFixture.refresh());
      await page.getByTestId('view-desktop-student-a').waitFor();
      assert.equal(leases(requests).length, 1);
      await page.getByTestId('view-desktop-student-a').click();
      await page.getByTestId('desktop-image-student-a').waitFor();
      assert.equal(leases(requests).length, 2);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test('an omitted metadata row preserves the selected Desktop as unavailable', async () => {
  const { page, requests, errors, omitMetadata } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    omitMetadata();
    await page.evaluate(() => window.nativeFixture.refresh());
    await page.getByTestId('desktop-state-student-a').filter({ hasText: 'unavailable' }).waitFor();
    assert.equal(await page.getByTestId('preview-source-desktop-student-a').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.ok(requests.some(request => request.method === 'DELETE'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('closing the native enlarged preview releases its shared viewer and clears tile pixels', async () => {
  const { page, requests, errors } = await open({ browserSource: false });
  try {
    await page.getByTestId('view-desktop-student-a').click();
    await page.getByTestId('desktop-image-student-a').waitFor();
    await page.getByRole('button', { name: 'Enlarge desktop for Synthetic Student' }).click();
    await page.getByTestId('expanded-desktop-dialog').waitFor();
    assert.equal(await page.getByTestId('expanded-native-source-desktop').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await page.getByTestId('expanded-desktop-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('desktop-image-student-a').count(), 0);
    assert.equal(await page.getByText(/Synthetic Editor/).count(), 0);
    assert.ok(requests.some(request => request.method === 'DELETE' && request.path === leases(requests)[0].path));
    await page.clock.fastForward(16_000);
    assert.equal(leases(requests).length, 1);
    await page.getByTestId('view-desktop-student-a').waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
