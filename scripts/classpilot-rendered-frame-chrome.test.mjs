import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { stampReliabilityFrame, readReliabilityFrame } from './load/reliability-rendered-frame.mjs';
import { collectRenderedDashboardSample } from './load/run-classpilot-rendered-dashboards.mjs';
import { bootstrapCookieIsolationProbe } from './check-classpilot-staging-cookie-isolation.mjs';

test('cookie probe uses the frontend document because API JSON CSP blocks subsequent browser fetches', async () => {
  const { chromium } = createRequire(new URL('../schoolpilot-app/package.json', import.meta.url))('playwright');
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(path => path && existsSync(path));
  assert.ok(executablePath, 'Actual Chrome is required');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    let documents = 0, apiRequests = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, 'https://staging.school-pilot.net');
      if (url.pathname === '/classpilot') {
        documents += 1;
        return route.fulfill({ status: 200, contentType: 'text/html',
          headers: { 'Content-Security-Policy': "default-src 'none'; connect-src 'self'" }, body: '<!doctype html><title>Cookie probe fixture</title>' });
      }
      if (url.pathname !== '/api/auth/me') return route.abort();
      apiRequests += 1;
      return route.fulfill({ status: 401, contentType: 'application/json',
        headers: { 'Content-Security-Policy': "default-src 'none'" }, body: '{"error":"Unauthorized"}' });
    });
    const page = await context.newPage();
    await page.goto('https://staging.school-pilot.net/api/auth/me');
    await assert.rejects(page.evaluate(async () => (await fetch('/api/auth/me')).status));
    assert.equal(apiRequests, 1, 'CSP must prevent the request from leaving the JSON document');
    assert.equal(await bootstrapCookieIsolationProbe(page), 401);
    assert.equal(documents, 1);
    assert.equal(apiRequests, 2, 'The real helper must perform its fetch from the frontend document');
  } finally { await browser.close(); }
});
import { RenderedHttpMetrics, attachRenderedHttpMetrics } from './load/rendered-http-metrics.mjs';

test('twenty actual Chrome contexts remain visible and decode distinct40KiB capture identities without network', async () => {
  const { chromium } = createRequire(new URL('../schoolpilot-app/package.json', import.meta.url))('playwright');
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(path => path && existsSync(path));
  assert.ok(executablePath, 'Actual Chrome is required for the explicit browser instrumentation gate');
  const harness = readFileSync(new URL('./load/classpilot-load-test.mjs', import.meta.url), 'utf8');
  const encoded = harness.match(/const JPEG_1X1\s*=\s*"([^"]+)";/)?.[1];
  assert.ok(encoded, 'Use the harness actual valid JPEG source');
  const original = Buffer.from(encoded, 'base64'), padding = Buffer.alloc(40960 - original.length, 0x4c);
  padding[0] = 255; padding[1] = 254; padding.writeUInt16BE(padding.length - 2, 2);
  const fixture = 'data:image/jpeg;base64,' + Buffer.concat([original.subarray(0, -2), padding, original.subarray(-2)]).toString('base64');
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  try {
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const context = await browser.newContext();
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      const first = stampReliabilityFrame(fixture, Date.now(), index + 1);
      await page.setContent(`<article data-testid="card-student-synthetic-${index}"><img id="frame" data-testid="screenshot-synthetic-${index}" width="400" height="225"></article>`);
      await page.locator('#frame').evaluate((image, source) => { image.src = source; }, first);
      await page.locator('#frame').evaluate(image => image.decode());
      let paint = await page.evaluate(() => ({ visible: document.visibilityState, source: document.querySelector('#frame').currentSrc,
        width: document.querySelector('#frame').naturalWidth }));
      assert.equal(paint.visible, 'visible'); assert.equal(paint.width, 1);
      assert.equal(readReliabilityFrame(paint.source).ordinal, index + 1);
      let sample = await page.evaluate(collectRenderedDashboardSample);
      assert.equal(sample.visible, true);
      assert.equal(sample.cards[0].decoded, true);
      assert.equal(sample.cards[0].displayed, true);
      assert.equal(sample.cards[0].frame.ordinal, index + 1);
      const second = stampReliabilityFrame(fixture, Date.now(), index + 21);
      await page.locator('#frame').evaluate((image, source) => { image.src = source; }, second);
      await page.locator('#frame').evaluate(image => image.decode());
      paint = await page.evaluate(() => ({ visible: document.visibilityState, source: document.querySelector('#frame').currentSrc,
        width: document.querySelector('#frame').naturalWidth }));
      assert.equal(readReliabilityFrame(paint.source).ordinal, index + 21);
      assert.notEqual(first, paint.source);
      sample = await page.evaluate(collectRenderedDashboardSample);
      assert.equal(sample.cards[0].frame.ordinal, index + 21);
      // Decoding alone is insufficient: offscreen and clipped sources fail
      // the exact same geometry check used by the staging candidate driver.
      await page.locator('#frame').evaluate(image => { image.style.position = 'absolute'; image.style.top = '10000px'; });
      assert.equal((await page.evaluate(collectRenderedDashboardSample)).cards[0].displayed, false);
      await page.locator('#frame').evaluate(image => { image.style.position = ''; image.style.top = ''; });
      await page.locator('article').evaluate(card => { card.style.height = '20px'; card.style.overflow = 'hidden'; });
      assert.equal((await page.evaluate(collectRenderedDashboardSample)).cards[0].displayed, false);
      await page.locator('article').evaluate(card => { card.style.height = ''; card.style.overflow = ''; });
      // Capture native compositor output; synthetic pixels are not persisted.
      assert.ok((await page.screenshot()).length > 0);
      await context.close();
    }));
    console.log(JSON.stringify({ gate: 'rendered-frame-instrumentation', browser: browser.version(), contexts: 20,
      applicationDashboardsValidated: false, stagingCapacityValidated: false, managedDevicesValidated: false }));
  } finally { await browser.close(); }
});

test('native browser census measures full bodies and retains an8s stalled-body deadline without changing requests', { timeout: 25000 }, async () => {
  const { chromium } = createRequire(new URL('../schoolpilot-app/package.json', import.meta.url))('playwright');
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(path => path && existsSync(path));
  assert.ok(executablePath);
  const server = createServer((request, response) => {
    if (request.url === '/api/teacher/raised-hands') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"raisedHands":');
      setTimeout(() => response.end('[]}'), 100);
    } else if (request.url === '/api/classpilot/tiles/screenshots') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"tiles":');
    } else response.end('<html><body>Local synthetic instrumentation</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const metrics = new RenderedHttpMetrics({ origin });
    attachRenderedHttpMetrics(page, metrics);
    await page.goto(origin);
    metrics.startWindow(performance.now(), 20000);
    await page.evaluate(async () => { await (await fetch('/api/teacher/raised-hands')).text(); });
    const finished = performance.now() + 2000;
    while (metrics.counters.measurementsSettled === 0 && performance.now() < finished) await delay(10);
    const hands = metrics.summary().fineEndpointLatency.endpoints['GET /api/classpilot/teacher/raised-hands'];
    assert.equal(hands.count, 1); assert.ok(hands.p95Bounds.lowerMs >= 90, 'headers cannot stand in for body completion');
    const headers = page.waitForResponse(response => response.url() === origin + '/api/classpilot/tiles/screenshots');
    await page.evaluate(() => { void fetch('/api/classpilot/tiles/screenshots', { method: 'POST' }).then(response => response.text()).catch(() => {}); });
    assert.equal((await headers).status(), 200);
    assert.equal(metrics.summary().counters.measurementsSettled, 1, 'stalled successful headers are not completion');
    const deadline = performance.now() + 11000;
    while (metrics.counters.deadlines === 0 && performance.now() < deadline) await delay(25);
    const summary = metrics.summary();
    assert.equal(summary.counters.requestsStarted, 2); assert.equal(summary.counters.deadlines, 1);
    assert.equal(summary.counters.measurementsSettled, 2); assert.equal(summary.rawInFlightAfterDrain, 1);
    assert.equal(summary.fineEndpointLatency.endpoints['POST /api/classpilot/tiles/screenshots'].overflowCount, 1);
    assert.equal(summary.wafAttributionEstablished, false);
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
