// Real local synthetic acceptance only. No intercepted API routes or auth mocks.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const apiOrigin = process.env.CLASSPILOT_NATIVE_E2E_API || 'http://127.0.0.1:4100';
const webOrigin = process.env.CLASSPILOT_NATIVE_E2E_WEB || 'http://127.0.0.1:5179';
for (const origin of [apiOrigin, webOrigin]) {
  const url = new URL(origin);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local synthetic origins required');
}
assert.equal(process.env.CLASSPILOT_NATIVE_E2E_ACK, 'synthetic-local-only', 'Explicit local synthetic test acknowledgement required');
const privateRoot = process.env.CLASSPILOT_NATIVE_E2E_PRIVATE_DIR
  || path.join(process.env.LOCALAPPDATA, 'ClassPilotDesktop', 'synthetic-demo');
const fixture = JSON.parse(await readFile(path.join(privateRoot, 'fixture.private.json'), 'utf8'));
const durationSeconds = Number(process.env.CLASSPILOT_NATIVE_E2E_SECONDS || 1800);
assert.ok(Number.isInteger(durationSeconds) && durationSeconds > 0 && durationSeconds <= 3600, 'Duration must be 1–3600 seconds');
const outputName = process.env.CLASSPILOT_NATIVE_E2E_OUTPUT_NAME || 'teacher-e2e';
assert.match(outputName, /^[A-Za-z0-9_-]+$/, 'Safe private output folder name required');
const outputDirectory = path.join(privateRoot, outputName);
await mkdir(outputDirectory, { recursive: true });
const metricsPath = path.join(outputDirectory, 'desktop-metrics.json');
const screenshotPath = path.join(outputDirectory, 'synthetic-teacher-desktop.png');
const studentId = fixture.students[0].id;
const metrics = {
  schema: 1, kind: 'real-local-synthetic-native-desktop', startedAt: new Date().toISOString(),
  requestedDurationSeconds: durationSeconds, processId: process.pid, status: 'starting',
  frames: [], events: [], http: {}, ui: { decodedImages: 0, missingImageSamples: 0, foregroundObserved: false,
    browserControlsUnavailable: false, sourceLabelObserved: false, expiryGaps: [] }, pageErrorCount: 0,
  lifecycle: { navigations: 0, documentLoads: 0, reloads: 0, requestFailures: 0, browserTimerGaps: 0,
    harnessTimerGaps: 0, visibility: 'unknown', maxRequestMs: 0 },
};
const event = (type, extra = {}) => metrics.events.push({ elapsedMs: Math.round(performance.now() - started), type, ...extra });
const started = performance.now();
let browser, context, page, stopping = false, firstFrameAt = null;
const frameKeys = new Set();
const activeViewers = new Set();
const requestStarts = new WeakMap();
let lastSequence = null;
let lastMetadata = '';
const save = async () => writeFile(metricsPath, JSON.stringify(metrics, null, 2));
const announce = (type, extra = {}) => process.stdout.write(`${JSON.stringify({ type, ...extra })}\n`);
const summarize = () => ({ frames: metrics.frames.length, elapsedSeconds: Math.round((performance.now() - started) / 1000),
  missingImageSamples: metrics.ui.missingImageSamples, pageErrorCount: metrics.pageErrorCount });
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York' });
  const login = await context.request.post(`${apiOrigin}/api/auth/login`, {
    data: { email: fixture.teacherEmail, password: fixture.staffPassword },
  });
  assert.equal(login.status(), 200, `LOGIN_HTTP_${login.status()}`);
  const auth = await login.json();
  assert.ok(auth.memberships?.some(member => member.schoolId === fixture.schoolId), 'Teacher must be admitted to synthetic school');
  await context.addInitScript(({ schoolId }) => { localStorage.setItem('sp_activeSchoolId', schoolId); }, { schoolId: fixture.schoolId });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', () => { metrics.pageErrorCount += 1; });
  await page.exposeBinding('nativeE2EReportLifecycle', (_source, sample) => {
    if (!['visibility', 'pageshow', 'pagehide', 'browser_timer_gap'].includes(sample?.type)) return;
    const visibility = ['visible', 'hidden', 'prerender'].includes(sample.visibility) ? sample.visibility : 'unknown';
    metrics.lifecycle.visibility = visibility;
    if (sample.type === 'browser_timer_gap') metrics.lifecycle.browserTimerGaps += 1;
    event(sample.type, { visibility, ...(Number.isFinite(sample.gapMs) ? { gapMs: Math.round(sample.gapMs) } : {}) });
  });
  await page.addInitScript(() => {
    const report = (type, extra = {}) => void window.nativeE2EReportLifecycle({ type, visibility: document.visibilityState, ...extra }).catch(() => {});
    document.addEventListener('visibilitychange', () => report('visibility'));
    window.addEventListener('pageshow', () => report('pageshow'));
    window.addEventListener('pagehide', () => report('pagehide'));
    let previous = performance.now();
    setInterval(() => {
      const now = performance.now(), gapMs = now - previous;
      previous = now;
      if (gapMs > 3_500) report('browser_timer_gap', { gapMs });
    }, 1_000);
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) { metrics.lifecycle.navigations += 1; event('main_frame_navigation'); }
  });
  page.on('domcontentloaded', async () => {
    try {
      const raw = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type);
      const navigationType = ['navigate', 'reload', 'back_forward', 'prerender'].includes(raw) ? raw : 'unknown';
      metrics.lifecycle.documentLoads += 1;
      if (navigationType === 'reload') metrics.lifecycle.reloads += 1;
      event('document_loaded', { navigationType });
    } catch { event('document_load_observation_failed'); }
  });
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/classpilot/native/')) requestStarts.set(request, performance.now());
  });
  page.on('requestfailed', request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/classpilot/native/')) return;
    const raw = request.failure()?.errorText || '';
    const code = /^net::ERR_[A-Z_]+$/.test(raw) ? raw : 'unclassified';
    metrics.lifecycle.requestFailures += 1;
    event('native_request_failed', { kind: pathname.includes('/observation-leases/') ? 'lease' : 'tiles', method: request.method(), code });
  });
  page.on('response', async response => {
    try {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/classpilot/native/')) return;
      const kind = url.pathname.includes('/observation-leases/') ? 'lease' : url.pathname.endsWith('/tiles/desktop') ? 'tiles' : 'other';
      const request = response.request();
      const requestStart = requestStarts.get(request);
      if (Number.isFinite(requestStart)) {
        const requestMs = Math.round(performance.now() - requestStart);
        metrics.lifecycle.maxRequestMs = Math.max(metrics.lifecycle.maxRequestMs, requestMs);
        if (requestMs > 2_000) event('native_request_slow', { kind, method: request.method(), requestMs });
      }
      const key = `${kind}:${request.method()}:${response.status()}`;
      metrics.http[key] = (metrics.http[key] || 0) + 1;
      if (kind === 'lease') {
        if (request.method() === 'PUT' && response.ok()) activeViewers.add(url.pathname);
        if (request.method() === 'DELETE' && response.ok()) activeViewers.delete(url.pathname);
        event(request.method() === 'PUT' ? 'lease_response' : 'lease_release', { status: response.status() });
        if (!firstFrameAt) announce('lease_response', { method: request.method(), status: response.status() });
        return;
      }
      if (kind !== 'tiles' || !response.ok()) return;
      const requestBody = request.postDataJSON();
      const result = await response.json();
      const row = result.tiles?.find(tile => tile.studentId === studentId);
      if (!requestBody?.selectedSources) {
        const metadata = JSON.stringify([row?.state, row?.bindingRevision]);
        if (metadata !== lastMetadata) {
          lastMetadata = metadata;
          event('metadata_changed', { state: row?.state || 'unavailable', bindingRevision: row?.bindingRevision ?? null });
          announce('metadata_changed', { state: row?.state || 'unavailable', bindingRevision: row?.bindingRevision ?? null });
        }
        return;
      }
      if (!row?.screenshot) { event('selected_read_without_image', { state: row?.state || 'unavailable' }); return; }
      const frameKey = `${row.bindingRevision}:${row.sequence}`;
      if (frameKeys.has(frameKey)) return;
      frameKeys.add(frameKey);
      const data = row.screenshot.slice(row.screenshot.indexOf(',') + 1);
      const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      const serverAgeMs = Date.parse(result.serverTime) - Date.parse(row.observedAt);
      metrics.frames.push({ sequence: row.sequence, bindingRevision: row.bindingRevision,
        elapsedMs: Math.round(performance.now() - started), jpegBytes: bytes,
        serverAgeMs: Number.isFinite(serverAgeMs) ? serverAgeMs : null,
        hasForegroundApplication: Boolean(row.foregroundApplication?.displayName) });
      if (lastSequence !== null && row.sequence <= lastSequence) event('sequence_reset_or_regression');
      lastSequence = row.sequence;
      await save();
      announce('new_frame', { sequence: row.sequence, jpegBytes: bytes, serverAgeMs: Number.isFinite(serverAgeMs) ? serverAgeMs : null });
    } catch { event('response_observation_failed'); }
  });
  announce('authenticated', { processId: process.pid });
  metrics.status = 'waiting_for_native_source';
  await save();
  await page.goto(`${webOrigin}/classpilot`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const desktopSelector = page.getByTestId(`preview-source-desktop-${studentId}`);
  await desktopSelector.waitFor({ timeout: 180_000 });
  const studentCard = page.getByTestId(`card-student-${studentId}`);
  assert.equal(await studentCard.count(), 1, 'One student tile required');
  if (await desktopSelector.getAttribute('aria-pressed') !== 'true') await desktopSelector.click();
  announce('waiting_for_native_source');
  await page.getByTestId(`desktop-state-${studentId}`).filter({ hasText: 'Desktop available' }).waitFor({ timeout: 180_000 });
  await page.getByTestId(`view-desktop-${studentId}`).click();
  event('view_desktop_clicked');
  announce('view_desktop_clicked');
  const image = page.getByTestId(`desktop-image-${studentId}`).first();
  const imageWaitDeadline = performance.now() + 120_000;
  let sourceRevalidations = 0;
  while (!await image.isVisible() && performance.now() < imageWaitDeadline) {
    await page.waitForTimeout(2_000);
    // The actual agent may replace its initially selected synthetic source.
    // Product UI correctly retires that binding. The acceptance operator makes
    // a new explicit View action rather than inheriting the old grant.
    const restart = page.getByTestId(`view-desktop-${studentId}`);
    if (sourceRevalidations < 3 && await restart.isVisible()
      && await restart.textContent() === 'View desktop'
      && await page.getByTestId(`desktop-state-${studentId}`).textContent() === 'Desktop available') {
      sourceRevalidations += 1;
      event('source_revalidated_by_operator');
      announce('source_revalidated_by_operator');
      await restart.click();
    }
  }
  assert.ok(await image.isVisible(), 'NO_DECODED_NATIVE_IMAGE_WITHIN_120_SECONDS');
  await image.evaluate(node => { if (!node.complete || node.naturalWidth < 1) throw new Error('Native JPEG not decoded'); });
  firstFrameAt = performance.now();
  metrics.ui.decodedImages += 1;
  metrics.ui.foregroundObserved = await page.getByTestId(`desktop-observation-${studentId}`).isVisible();
  metrics.ui.sourceLabelObserved = await studentCard.getByText(/Windows · .*Screenshots, not live video/).isVisible();
  metrics.ui.browserControlsUnavailable = await studentCard.getByText('Browser monitoring and controls unavailable.', { exact: true }).isVisible()
    && await page.getByTestId(`button-manage-tabs-${studentId}`).count() === 0;
  assert.ok(metrics.ui.foregroundObserved && metrics.ui.sourceLabelObserved && metrics.ui.browserControlsUnavailable, 'Independent desktop/source/browser states required');
  // Explicit synthetic-only evidence action: one private screenshot, never a history.
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
  metrics.status = 'running';
  metrics.firstDecodedImageAfterMs = Math.round(firstFrameAt - started);
  event('first_image_decoded');
  await save();
  announce('first_image_decoded', { processId: process.pid, metricsPath, screenshotPath, ...summarize() });

  let lastReport = firstFrameAt;
  let lastSample = firstFrameAt;
  let gap = null;
  while (!stopping && performance.now() - firstFrameAt < durationSeconds * 1000) {
    await page.waitForTimeout(2_000);
    const sampleAt = performance.now();
    if (sampleAt - lastSample > 5_000) {
      metrics.lifecycle.harnessTimerGaps += 1;
      event('harness_timer_gap', { gapMs: Math.round(sampleAt - lastSample) });
    }
    lastSample = sampleAt;
    const visible = await image.isVisible();
    if (visible) {
      metrics.ui.decodedImages += 1;
      if (gap) {
        metrics.ui.expiryGaps.push({ ...gap, recoveredAfterMs: Math.round(performance.now() - firstFrameAt),
          sampledDurationMs: Math.round(performance.now() - firstFrameAt - gap.startedAfterMs) });
        gap = null;
      }
    } else {
      metrics.ui.missingImageSamples += 1;
      gap ||= { startedAfterMs: Math.round(performance.now() - firstFrameAt), samples: 0 };
      gap.samples += 1;
    }
    metrics.ui.openGap = gap ? { ...gap } : null;
    assert.equal(await desktopSelector.getAttribute('aria-pressed'), 'true', 'Desktop must remain the selected source');
    if (performance.now() - lastReport >= 30_000) {
      await save();
      announce('running', summarize());
      lastReport = performance.now();
    }
  }
  if (gap) metrics.ui.expiryGaps.push({ ...gap, recoveredAfterMs: null,
    sampledDurationMs: Math.round(performance.now() - firstFrameAt - gap.startedAfterMs) });
  const stop = page.getByRole('button', { name: 'Stop viewing', exact: true });
  const release = activeViewers.size ? page.waitForResponse(response => response.request().method() === 'DELETE'
    && response.url().includes('/api/classpilot/native/observation-leases/') && response.status() === 204,
  { timeout: 8_000 }).catch(() => null) : null;
  if (await stop.isVisible()) await stop.click();
  if (release) event('stop_release_acknowledged', { acknowledged: Boolean(await release) });
  assert.equal(await image.count(), 0, 'Stopping must remove desktop pixels');
  event('stop_verified');
  metrics.status = stopping ? 'stopped' : 'completed';
  metrics.actualObservationSeconds = Math.round((performance.now() - firstFrameAt) / 1000);
  metrics.finishedAt = new Date().toISOString();
  await save();
  announce(metrics.status, summarize());
} catch (error) {
  metrics.status = 'failed';
  metrics.failure = { name: error?.name || 'Error', message: String(error?.message || '').split('\n')[0].slice(0, 160) };
  metrics.finishedAt = new Date().toISOString();
  await save();
  announce('failed', { errorName: metrics.failure.name, error: metrics.failure.message, ...summarize() });
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
