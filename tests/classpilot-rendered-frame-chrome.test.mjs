import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stampReliabilityFrame, readReliabilityFrame } from '../scripts/load/reliability-rendered-frame.mjs';
import { collectRenderedDashboardSample } from '../scripts/load/run-classpilot-rendered-dashboards.mjs';

test('twenty actual Chrome contexts remain visible and decode distinct40KiB capture identities without network', async () => {
  const { chromium } = createRequire(new URL('../schoolpilot-app/package.json', import.meta.url))('playwright');
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(path => path && existsSync(path));
  assert.ok(executablePath, 'Actual Chrome is required for the explicit browser instrumentation gate');
  const harness = readFileSync(new URL('../scripts/load/classpilot-load-test.mjs', import.meta.url), 'utf8');
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
