// Real, local synthetic lifecycle acceptance. No screenshots. Only the explicit
// fail-next-selected-read operator command injects a one-shot local HTTP fault.
// While running, write {"id":1,"action":"view"} to the printed private control
// path. Increase id for each command. OS lock/unlock remains an external action.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { attachNativeRequestDiagnostics } from './native-desktop-diagnostics.mjs';

assert.equal(process.env.CLASSPILOT_NATIVE_E2E_ACK, 'synthetic-local-only');
const apiOrigin = process.env.CLASSPILOT_NATIVE_E2E_API || 'http://127.0.0.1:4100';
const webOrigin = process.env.CLASSPILOT_NATIVE_E2E_WEB || 'http://127.0.0.1:5179';
for (const origin of [apiOrigin, webOrigin]) {
  const url = new URL(origin);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}
const privateRoot = process.env.CLASSPILOT_NATIVE_E2E_PRIVATE_DIR
  || path.join(process.env.LOCALAPPDATA, 'ClassPilotDesktop', 'synthetic-final');
const fixture = JSON.parse(await readFile(path.join(privateRoot, 'fixture.private.json'), 'utf8'));
const studentId = fixture.students[0].id;
const durationSeconds = Number(process.env.CLASSPILOT_NATIVE_E2E_SECONDS || 300);
assert.ok(Number.isInteger(durationSeconds) && durationSeconds > 0 && durationSeconds <= 3600);
const headless = process.env.CLASSPILOT_NATIVE_E2E_HEADLESS !== 'false';
const outputName = process.env.CLASSPILOT_NATIVE_E2E_OUTPUT_NAME || 'teacher-lifecycle';
assert.match(outputName, /^[A-Za-z0-9_-]+$/);
const output = path.join(privateRoot, outputName);
await mkdir(output, { recursive: true });
const metricsPath = path.join(output, 'lifecycle-metrics.json');
const controlPath = path.join(output, 'control.json');
await writeFile(controlPath, '{"id":0,"action":"none"}\n');
const started = performance.now();
const metrics = { schema: 2, kind: 'real-local-native-lifecycle', startedAt: new Date().toISOString(),
  processId: process.pid, durationSeconds, headless, status: 'starting', events: [], frames: [], reads: [], http: {}, pageErrorCount: 0,
  lifecycle: { navigations: 0, documentLoads: 0, reloads: 0, browserTimerGaps: 0, harnessTimerGaps: 0, visibility: 'unknown' },
  ui: { imageVisible: false, imageCount: 0, foregroundVisible: false, desktopSelected: false,
    expandedVisible: false, expandedImageVisible: false, expandedForegroundVisible: false }, lastControlId: 0 };
let browser, context, page, windowSession, windowId, stop = false, firstImage = false;
const frameKeys = new Set();
const activeViewers = new Set();
const actions = new Set(['view', 'stop', 'browser', 'desktop', 'enlarge', 'close-preview', 'offline', 'online', 'finish', 'fail-next-selected-read', 'minimize', 'restore']);
let failNextSelectedRead = false;
const elapsed = () => Math.round(performance.now() - started);
const announce = (type, extra = {}) => process.stdout.write(`${JSON.stringify({ type, ...extra })}\n`);
const event = (type, extra = {}) => metrics.events.push({ elapsedMs: elapsed(), type, ...extra });
const save = () => writeFile(metricsPath, JSON.stringify(metrics, null, 2));
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });

try {
  browser = await chromium.launch({ headless });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post(`${apiOrigin}/api/auth/login`, {
    data: { email: fixture.teacherEmail, password: fixture.staffPassword },
  });
  assert.equal(login.status(), 200, `LOGIN_HTTP_${login.status()}`);
  const auth = await login.json();
  assert.ok(auth.memberships?.some(member => member.schoolId === fixture.schoolId));
  await context.addInitScript(({ schoolId }) => localStorage.setItem('sp_activeSchoolId', schoolId), { schoolId: fixture.schoolId });
  page = await context.newPage();
  if (!headless) {
    windowSession = await context.newCDPSession(page);
    ({ windowId } = await windowSession.send('Browser.getWindowForTarget'));
  }
  attachNativeRequestDiagnostics(page, { metrics, event, elapsed });
  // Explicit operator-only fault fixture. All other requests reach the real
  // local API unchanged; normal runs never enable this one-shot interception.
  await page.route('**/api/classpilot/native/tiles/desktop', async route => {
    const request = route.request();
    let body;
    try { body = request.postDataJSON(); } catch { /* Leave malformed requests to the API. */ }
    if (failNextSelectedRead && request.method() === 'POST'
      && body?.selectedSources?.some(target => target.studentId === studentId)) {
      failNextSelectedRead = false;
      event('injected_fault', { operation: 'selected_read', status: 503, code: 'NATIVE_UNAVAILABLE' });
      await route.fulfill({ status: 503, json: { code: 'NATIVE_UNAVAILABLE' } });
    } else await route.continue();
  });
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
  page.setDefaultTimeout(5_000);
  page.on('pageerror', () => { metrics.pageErrorCount += 1; });
  page.on('requestfailed', request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/classpilot/native/')) return;
    const raw = request.failure()?.errorText || '';
    event('transport_error', { kind: pathname.includes('/observation-leases/') ? 'lease' : 'tiles',
      method: request.method(), code: /^net::ERR_[A-Z_]+$/.test(raw) ? raw : 'UNCLASSIFIED' });
  });
  page.on('response', async response => {
    try {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/classpilot/native/')) return;
      const request = response.request();
      const kind = url.pathname.includes('/observation-leases/') ? 'lease' : 'tiles';
      const key = `${kind}:${request.method()}:${response.status()}`;
      metrics.http[key] = (metrics.http[key] || 0) + 1;
      if (!response.ok()) {
        let body;
        try { body = await response.json(); } catch { /* Transport status remains useful. */ }
        const code = typeof body?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(body.code) ? body.code : 'UNCLASSIFIED';
        event('http_error', { kind, method: request.method(), status: response.status(), code,
          selectedRead: Boolean(request.postDataJSON()?.selectedSources) });
      }
      if (kind === 'lease') {
        if (request.method() === 'PUT' && response.ok()) activeViewers.add(url.pathname);
        if (request.method() === 'DELETE' && response.ok()) activeViewers.delete(url.pathname);
        let expiresInMs = null;
        if (request.method() === 'PUT' && response.ok()) {
          const body = await response.json();
          const remaining = Date.parse(body.expiresAt) - Date.parse(body.serverTime);
          if (Number.isFinite(remaining)) expiresInMs = remaining;
        }
        event('lease', { method: request.method(), status: response.status(), expiresInMs }); return;
      }
      if (!response.ok()) return;
      const result = await response.json();
      const row = result.tiles?.find(tile => tile.studentId === studentId);
      if (request.postDataJSON()?.selectedSources) {
        const remaining = Date.parse(row?.expiresAt) - Date.parse(result.serverTime);
        const age = Date.parse(result.serverTime) - Date.parse(row?.observedAt);
        metrics.reads.push({ elapsedMs: elapsed(), state: row?.state || 'unavailable', sequence: row?.sequence ?? null,
          expiresInMs: Number.isFinite(remaining) ? remaining : null, serverAgeMs: Number.isFinite(age) ? age : null });
      }
      if (!request.postDataJSON()?.selectedSources) {
        const state = row?.state || 'unavailable';
        if (metrics.metadataState !== state || metrics.bindingRevision !== (row?.bindingRevision ?? null)) {
          metrics.metadataState = state;
          metrics.bindingRevision = row?.bindingRevision ?? null;
          event('metadata', { state, bindingRevision: row?.bindingRevision ?? null });
        }
      }
      if (!row?.screenshot) return;
      const frameKey = `${row.sourceRef}:${row.bindingRevision}:${row.sequence}`;
      if (frameKeys.has(frameKey)) return;
      frameKeys.add(frameKey);
      const data = row.screenshot.slice(row.screenshot.indexOf(',') + 1);
      const jpegBytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      const serverAgeMs = Date.parse(result.serverTime) - Date.parse(row.observedAt);
      metrics.frames.push({ elapsedMs: elapsed(), bindingRevision: row.bindingRevision, sequence: row.sequence,
        jpegBytes, serverAgeMs: Number.isFinite(serverAgeMs) ? serverAgeMs : null });
    } catch { event('response_observation_failed'); }
  });
  await page.goto(`${webOrigin}/classpilot`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const desktop = page.getByTestId(`preview-source-desktop-${studentId}`);
  const browserSource = page.getByTestId(`preview-source-browser-${studentId}`);
  const image = page.getByTestId(`desktop-image-${studentId}`).first();
  const nativeDialog = page.getByTestId('expanded-desktop-dialog');
  await desktop.waitFor({ timeout: 60_000 });
  metrics.status = 'ready';
  await save();
  announce('ready', { processId: process.pid, controlPath, metricsPath });
  const activeStart = performance.now();
  const closePreview = async () => { if (await nativeDialog.isVisible()) await nativeDialog.getByRole('button', { name: 'Close', exact: true }).click(); };
  const stopViewing = async () => {
    const release = activeViewers.size ? page.waitForResponse(response => response.request().method() === 'DELETE'
      && response.url().includes('/api/classpilot/native/observation-leases/') && response.status() === 204,
    { timeout: 8_000 }).catch(() => null) : null;
    await closePreview();
    const button = page.getByRole('button', { name: 'Stop viewing', exact: true });
    if (await button.isVisible()) await button.click();
    if (release) event('stop_release_acknowledged', { acknowledged: Boolean(await release) });
  };
  let lastReport = 0;
  let previousSample = performance.now();
  while (!stop && performance.now() - activeStart < durationSeconds * 1000) {
    const sampleTime = performance.now();
    if (sampleTime - previousSample > 3_500) {
      metrics.lifecycle.harnessTimerGaps += 1;
      event('harness_timer_gap', { gapMs: Math.round(sampleTime - previousSample) });
    }
    previousSample = sampleTime;
    let command;
    try { command = JSON.parse(await readFile(controlPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (Number.isSafeInteger(command?.id) && command.id > metrics.lastControlId && actions.has(command.action)) {
      metrics.lastControlId = command.id;
      try {
        switch (command.action) {
          case 'view': {
            let acted = false;
            if (await desktop.getAttribute('aria-pressed') !== 'true') { await desktop.click(); acted = true; }
            const expandedButton = page.getByTestId('expanded-view-desktop');
            const button = await expandedButton.isVisible() ? expandedButton : page.getByTestId(`view-desktop-${studentId}`);
            if (await button.isVisible()) { await button.click(); acted = true; }
            assert.ok(acted, 'NO_ACTIONABLE_VIEW_CONTROL');
            break;
          }
          case 'stop': await stopViewing(); break;
          case 'browser': await closePreview(); await browserSource.click(); break;
          case 'desktop': await closePreview(); await desktop.click(); break;
          case 'enlarge': await page.getByRole('button', { name: /^Enlarge desktop for / }).click(); break;
          case 'close-preview': await closePreview(); break;
          case 'offline': await context.setOffline(true); break;
          case 'online': await context.setOffline(false); break;
          case 'minimize':
          case 'restore':
            assert.ok(windowSession, 'HEADED_BROWSER_REQUIRED');
            await windowSession.send('Browser.setWindowBounds', { windowId,
              bounds: { windowState: command.action === 'minimize' ? 'minimized' : 'normal' } });
            break;
          case 'fail-next-selected-read': failNextSelectedRead = true; break;
          case 'finish': stop = true; break;
        }
        event('control', { id: command.id, action: command.action, accepted: true });
        announce('control', { id: command.id, action: command.action, accepted: true });
      } catch {
        event('control', { id: command.id, action: command.action, accepted: false });
        announce('control', { id: command.id, action: command.action, accepted: false });
      }
    }
    const imageVisible = await image.isVisible();
    const ui = { imageVisible, imageCount: await page.getByTestId(`desktop-image-${studentId}`).count(),
      foregroundVisible: await page.getByTestId(`desktop-observation-${studentId}`).isVisible(),
      desktopSelected: await desktop.getAttribute('aria-pressed') === 'true',
      expandedVisible: await nativeDialog.isVisible(),
      expandedImageVisible: await page.getByTestId('expanded-desktop-preview').locator('img').isVisible(),
      expandedForegroundVisible: await nativeDialog.getByText(/Foreground app — computer session/).isVisible() };
    if (JSON.stringify(ui) !== JSON.stringify(metrics.ui)) { metrics.ui = ui; event('ui', ui); }
    if (imageVisible && !firstImage) {
      assert.ok(await image.evaluate(node => node.complete && node.naturalWidth > 0));
      firstImage = true;
      metrics.status = 'running';
      announce('first_image_decoded', { processId: process.pid, elapsedMs: elapsed() });
    }
    await save();
    if (elapsed() - lastReport >= 30_000) {
      announce('running', { elapsedSeconds: Math.round(elapsed() / 1000), frames: metrics.frames.length,
        metadataState: metrics.metadataState, ...metrics.ui, pageErrorCount: metrics.pageErrorCount });
      lastReport = elapsed();
    }
    if (!stop) await page.waitForTimeout(1_000);
  }
  await context.setOffline(false);
  await stopViewing();
  assert.equal(await image.count(), 0);
  metrics.status = 'completed';
  metrics.finishedAt = new Date().toISOString();
  event('stop_verified');
  await save();
  announce('completed', { frames: metrics.frames.length, pageErrorCount: metrics.pageErrorCount });
} catch (error) {
  metrics.status = 'failed';
  metrics.failureName = error?.name || 'Error';
  metrics.finishedAt = new Date().toISOString();
  await save();
  announce('failed', { errorName: metrics.failureName });
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
