import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { makeReliabilityJpegFixture, reliabilityFixtureEvidence, RELIABILITY_WORKLOAD_VERSION,
  stampCausalCapture, readCausalCapture, CapturePulseController, capturePulseMarker, measurementPlan, measurementPlanDigest } from './load/classpilot-reliability-profile.mjs';
import { collectRenderedDashboardSample } from './load/run-classpilot-rendered-dashboards.mjs';
import { bootstrapCookieIsolationProbe } from './check-classpilot-staging-cookie-isolation.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function localCaptureController(){
  return new CapturePulseController({account:'135775632425',bucket:'schoolpilot-staging-load-135775632425',origin:'https://staging.school-pilot.net',
    campaign:'classpilot-staging-20261014-012345abcdef',runId:'40-0123456789abcdef',primaryDevices:40,
    candidateApiImage:'135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:'+'a'.repeat(64),
    sourceArtifactSha256:'b'.repeat(64),scriptBundleSha256:'c'.repeat(64),cohortSha256:'d'.repeat(64),
    planSha256:measurementPlanDigest(40),maximumPulses:measurementPlan(40).maximumPulses,maximumNavigationRounds:measurementPlan(40).navigationRounds},{now:()=>performance.now()});
}
const localBinding=index=>createHash('sha256').update('local-codec-fixture-'+index).digest('base64url');
const sourceHash=source=>sha256(Buffer.from(source.slice('data:image/jpeg;base64,'.length),'base64'));

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
  const original = Buffer.from(encoded, 'base64');
  const controller=localCaptureController();let interceptedDocuments=0,otherRequests=0,secondPulse;
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  try {
    const firstPulse=controller.issue();
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const fixture = makeReliabilityJpegFixture(original),binding=localBinding(index);
      const context = await browser.newContext();
      await context.route('**/*', route => {
        if(route.request().isNavigationRequest()&&route.request().url()==='https://measurement.local.invalid/'){
          interceptedDocuments+=1;return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><body></body>'});
        }otherRequests+=1;return route.abort();
      });
      const page = await context.newPage();
      await page.goto('https://measurement.local.invalid/');assert.equal(await page.evaluate(()=>isSecureContext&&!!crypto.subtle),true);
      const first=stampCausalCapture(fixture,Date.now(),index+1,{pulseSequence:firstPulse.pulseSequence,pulseMarker:capturePulseMarker(firstPulse,binding)});
      await page.setContent(`<article data-testid="card-student-synthetic-${index}"><img id="frame" data-testid="screenshot-synthetic-${index}" width="400" height="225"></article>`);
      await page.locator('#frame').evaluate((image, source) => { image.src = source; }, first);
      await page.locator('#frame').evaluate(image => image.decode());
      let paint = await page.evaluate(() => ({ visible: document.visibilityState, source: document.querySelector('#frame').currentSrc,
        width: document.querySelector('#frame').naturalWidth }));
      assert.equal(paint.visible, 'visible'); assert.equal(paint.width, 1);
      assert.equal(readCausalCapture(paint.source).frameOrdinal, index + 1);
      let sample = await page.evaluate(collectRenderedDashboardSample);
      assert.equal(sample.visible, true);
      assert.equal(sample.cards[0].decoded, true);
      assert.equal(sample.cards[0].displayed, true);
      assert.equal(sample.cards[0].frame.ordinal, index + 1);
      assert.equal(sample.cards[0].frame.jpegSha256,sourceHash(first));assert.equal(sample.cards[0].frame.pulseSequence,firstPulse.pulseSequence);
      assert.equal(sample.cards[0].frame.pulseMarker,capturePulseMarker(firstPulse,binding));assert.ok(Number.isFinite(controller.ageUpper(sample.cards[0].frame,binding)));
      secondPulse??=controller.issue();const second=stampCausalCapture(fixture,Date.now(),index+21,{pulseSequence:secondPulse.pulseSequence,pulseMarker:capturePulseMarker(secondPulse,binding)});
      await page.locator('#frame').evaluate((image, source) => { image.src = source; }, second);
      await page.locator('#frame').evaluate(image => image.decode());
      paint = await page.evaluate(() => ({ visible: document.visibilityState, source: document.querySelector('#frame').currentSrc,
        width: document.querySelector('#frame').naturalWidth }));
      assert.equal(readCausalCapture(paint.source).frameOrdinal, index + 21);
      assert.notEqual(first, paint.source);
      sample = await page.evaluate(collectRenderedDashboardSample);
      assert.equal(sample.cards[0].frame.ordinal, index + 21);
      assert.equal(sample.cards[0].frame.jpegSha256,sourceHash(second));assert.equal(sample.cards[0].frame.pulseSequence,secondPulse.pulseSequence);
      assert.equal(sample.cards[0].frame.pulseMarker,capturePulseMarker(secondPulse,binding));assert.ok(Number.isFinite(controller.ageUpper(sample.cards[0].frame,binding)));
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
    assert.equal(interceptedDocuments,20);assert.equal(otherRequests,0);
    console.log(JSON.stringify({ gate: 'rendered-frame-instrumentation', browser: browser.version(), contexts: 20,
      applicationDashboardsValidated: false, stagingCapacityValidated: false, managedDevicesValidated: false }));
  } finally { await browser.close(); }
});

test('native Chrome decodes forty distinctv3 frames and measures realistic gzip/Brotli cohort wire bytes', { timeout: 30000 }, async () => {
  const { chromium } = createRequire(new URL('../schoolpilot-app/package.json', import.meta.url))('playwright');
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(path => path && existsSync(path));
  assert.ok(executablePath);
  const harness = readFileSync(new URL('./load/classpilot-load-test.mjs', import.meta.url), 'utf8');
  const source = harness.match(/const JPEG_1X1\s*=\s*"([^"]+)";/)?.[1]; assert.ok(source);
  const creationStarted = performance.now(), creationCpu = process.cpuUsage(), beforeMemory = process.memoryUsage();
  const fixtures = Array.from({ length: 40 }, () => makeReliabilityJpegFixture(Buffer.from(source, 'base64')));
  const evidence = reliabilityFixtureEvidence(fixtures), usedCpu = process.cpuUsage(creationCpu);
  const creation = { elapsedMs: performance.now() - creationStarted, cpuUserMs: usedCpu.user / 1000,
    cpuSystemMs: usedCpu.system / 1000, decodedCacheBytes: fixtures.length * 40960,
    rssIncreaseBytes: Math.max(0, process.memoryUsage().rss - beforeMemory.rss) };
  const controller=localCaptureController(),pulse=controller.issue(),capturedAt=Date.now(),tiles=fixtures.map((fixture,index)=>({
    // Synthetic fixture labels are local only; none enter metrics or logs.
    studentId:`synthetic-${index}`,screenshot:stampCausalCapture(fixture,capturedAt,index+1,{pulseSequence:pulse.pulseSequence,pulseMarker:capturePulseMarker(pulse,localBinding(index))}),
  })),body=Buffer.from(JSON.stringify({tiles}));
  const expectedByStudent=new Map(tiles.map((tile,index)=>[tile.studentId,{sha256:sourceHash(tile.screenshot),binding:localBinding(index),frame:readCausalCapture(tile.screenshot)}]));
  assert.equal(new Set([...expectedByStudent.values()].map(value=>value.sha256)).size,40);
  const compressed = { gzip: gzipSync(body), br: brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }) };
  for (const value of Object.values(compressed)) assert.ok(value.length >= 40 * 40960 * 0.95);
  let actualRequests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/api/classpilot/tiles/screenshots') {
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><main id="cards" style="display:grid;grid-template-columns:repeat(8,100px)"></main>'); return;
    }
    actualRequests += 1;
    const codec = url.searchParams.get('encoding'); assert.ok(codec === 'gzip' || codec === 'br');
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': codec, 'content-length': compressed[codec].length });
    response.end(compressed[codec]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage(), metrics = new RenderedHttpMetrics({ origin });
    attachRenderedHttpMetrics(page, metrics);
    await page.goto(origin); metrics.startWindow(performance.now(), 10000);
    for (const codec of ['gzip', 'br']) {
      await page.evaluate(async encoding => {
        const response = await fetch(`/api/classpilot/tiles/screenshots?encoding=${encoding}`, { method: 'POST' });
        const body = await response.json(), cards = document.querySelector('#cards');
        cards.replaceChildren();
        for (const tile of body.tiles) {
          const article = document.createElement('article'); article.dataset.testid = 'card-student-' + tile.studentId;
          const image = new Image(); image.dataset.testid = 'screenshot-' + tile.studentId;
          image.width = 80; image.height = 80; image.src = tile.screenshot; article.append(image); cards.append(article);
        }
        await Promise.all([...cards.querySelectorAll('img')].map(image => image.decode()));
      }, codec);
      const sample = await page.evaluate(collectRenderedDashboardSample);
      assert.equal(sample.cards.length, 40);
      assert.equal(new Set(sample.cards.map(card => card.frame?.ordinal)).size, 40);
      for (const card of sample.cards) {
        assert.equal(card.decoded, true); assert.equal(card.displayed, true);
        assert.equal(card.frame.capturedAt, capturedAt);
        const expected=expectedByStudent.get(card.studentId);assert.ok(expected);assert.equal(card.frame.ordinal,expected.frame.frameOrdinal);
        assert.equal(card.frame.jpegSha256,expected.sha256);assert.equal(card.frame.pulseSequence,pulse.pulseSequence);
        assert.equal(card.frame.pulseMarker,capturePulseMarker(pulse,expected.binding));assert.ok(Number.isFinite(controller.ageUpper(card.frame,expected.binding)));
      }
    }
    await metrics.drain();
    const measured = metrics.summary(), endpoint = measured.diagnostics.endpoints['POST /api/classpilot/tiles/screenshots'];
    assert.equal(actualRequests, 2); assert.equal(measured.counters.requestsStarted, 2);
    assert.equal(measured.allStartedRequestsMeasured, true); assert.equal(measured.counters.failedMeasurements, 0);
    assert.equal(endpoint.contentEncoding.gzip, 1); assert.equal(endpoint.contentEncoding.br, 1);
    assert.equal(endpoint.encodedBodyBytes.count, 2);
    assert.equal(endpoint.encodedBodyBytes.totalBytes, compressed.gzip.length + compressed.br.length);
    assert.equal(measured.diagnostics.counters.bodySizeCaptured, 2);
    console.log(JSON.stringify({ gate: 'reliability-wire-v3-native', browser: browser.version(), workload: RELIABILITY_WORKLOAD_VERSION,
      decodedFixtures: 40, distinctCaptureIdentities: 40, syntheticWire: evidence.cohort, creation,
      actualGzipBytes: compressed.gzip.length, actualBrotliBytes: compressed.br.length,
      measuredEncodedBytes: endpoint.encodedBodyBytes.totalBytes, codecCostValidated: false, managedDevicesValidated: false }));
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('native browser census measures full bodies and retains an8s stalled-body deadline without changing requests', { timeout: 25000 }, async () => {
  const { chromium } = createRequire(new URL('../schoolpilot-app/package.json', import.meta.url))('playwright');
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(path => path && existsSync(path));
  assert.ok(executablePath);
  const privateBody = JSON.stringify({ privateCanaryContentMustNeverEnterEvidence: 'x'.repeat(100_000) });
  const gzipBody = gzipSync(privateBody);
  const server = createServer((request, response) => {
    if (request.url === '/api/teacher/raised-hands') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"raisedHands":');
      setTimeout(() => response.end('[]}'), 100);
    } else if (request.url === '/api/classpilot/tiles/screenshots') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"tiles":');
    } else if (request.url === '/api/commands') {
      response.writeHead(201, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gzipBody.length });
      response.end(gzipBody);
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
    await page.evaluate(async () => { await (await fetch('/api/commands', { method: 'POST' })).text(); });
    const metadataDeadline = performance.now() + 2000;
    while (metrics.diagnosticCounters.bodySizeCaptured < 2 && performance.now() < metadataDeadline) await delay(10);
    const diagnostics = metrics.summary().diagnostics, endpoint = 'POST /api/classpilot/commands';
    assert.equal(diagnostics.counters.bodySizeCaptured, 2);
    assert.equal(diagnostics.counters.networkTimingSamples, 2);
    assert.equal(diagnostics.endpoints[endpoint].statusCounts['201'], 1);
    assert.equal(diagnostics.endpoints[endpoint].contentEncoding.gzip, 1);
    assert.equal(diagnostics.endpoints[endpoint].encodedBodyBytes.totalBytes, gzipBody.length, 'Chromium reports encoded wire bytes, not decoded body size');
    assert.ok(gzipBody.length < privateBody.length);
    const handsHeaders = diagnostics.responseHeaderLatency.endpoints['GET /api/classpilot/teacher/raised-hands'];
    assert.ok(handsHeaders.p95Bounds.upperMs < hands.p95Bounds.upperMs, 'Header arrival and full body are measured independently');
    const transfer = diagnostics.browserNetworkTiming.responseHeadersToBodyEnd.endpoints['GET /api/classpilot/teacher/raised-hands'];
    assert.ok(transfer.p95Bounds.lowerMs >= 90, 'Chromium network timing preserves the delayed body phase');
    assert.doesNotMatch(JSON.stringify(diagnostics), /privateCanaryContentMustNeverEnterEvidence/);
    const headers = page.waitForResponse(response => response.url() === origin + '/api/classpilot/tiles/screenshots');
    await page.evaluate(() => { void fetch('/api/classpilot/tiles/screenshots', { method: 'POST' }).then(response => response.text()).catch(() => {}); });
    assert.equal((await headers).status(), 200);
    assert.equal(metrics.summary().counters.measurementsSettled, 2, 'stalled successful headers are not completion');
    const deadline = performance.now() + 11000;
    while (metrics.counters.deadlines === 0 && performance.now() < deadline) await delay(25);
    const summary = metrics.summary();
    assert.equal(summary.counters.requestsStarted, 3); assert.equal(summary.counters.deadlines, 1);
    assert.equal(summary.counters.measurementsSettled, 3); assert.equal(summary.rawInFlightAfterDrain, 1);
    assert.equal(summary.fineEndpointLatency.endpoints['POST /api/classpilot/tiles/screenshots'].overflowCount, 1);
    assert.equal(summary.wafAttributionEstablished, false);
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
