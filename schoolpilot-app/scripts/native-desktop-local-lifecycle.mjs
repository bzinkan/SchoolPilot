// Real, local synthetic lifecycle acceptance. No API mocks or screenshots.
// While running, write {"id":1,"action":"view"} to the printed private control
// path. Increase id for each command. OS lock/unlock remains an external action.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

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
assert.ok(Number.isInteger(durationSeconds) && durationSeconds > 0 && durationSeconds <= 900);
const outputName = process.env.CLASSPILOT_NATIVE_E2E_OUTPUT_NAME || 'teacher-lifecycle';
assert.match(outputName, /^[A-Za-z0-9_-]+$/);
const output = path.join(privateRoot, outputName);
await mkdir(output, { recursive: true });
const metricsPath = path.join(output, 'lifecycle-metrics.json');
const controlPath = path.join(output, 'control.json');
await writeFile(controlPath, '{"id":0,"action":"none"}\n');
const started = performance.now();
const metrics = { schema: 1, kind: 'real-local-native-lifecycle', startedAt: new Date().toISOString(),
  processId: process.pid, durationSeconds, status: 'starting', events: [], frames: [], http: {}, pageErrorCount: 0,
  ui: { imageVisible: false, foregroundVisible: false, desktopSelected: false }, lastControlId: 0 };
let browser, context, page, stop = false, firstImage = false;
const frameKeys = new Set();
const activeViewers = new Set();
const actions = new Set(['view', 'stop', 'browser', 'desktop', 'enlarge', 'close-preview', 'offline', 'online', 'finish']);
const elapsed = () => Math.round(performance.now() - started);
const announce = (type, extra = {}) => process.stdout.write(`${JSON.stringify({ type, ...extra })}\n`);
const event = (type, extra = {}) => metrics.events.push({ elapsedMs: elapsed(), type, ...extra });
const save = () => writeFile(metricsPath, JSON.stringify(metrics, null, 2));
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });

try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const login = await context.request.post(`${apiOrigin}/api/auth/login`, {
    data: { email: fixture.teacherEmail, password: fixture.staffPassword },
  });
  assert.equal(login.status(), 200, `LOGIN_HTTP_${login.status()}`);
  const auth = await login.json();
  assert.ok(auth.memberships?.some(member => member.schoolId === fixture.schoolId));
  await context.addInitScript(({ schoolId }) => localStorage.setItem('sp_activeSchoolId', schoolId), { schoolId: fixture.schoolId });
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on('pageerror', () => { metrics.pageErrorCount += 1; });
  page.on('response', async response => {
    try {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/classpilot/native/')) return;
      const request = response.request();
      const kind = url.pathname.includes('/observation-leases/') ? 'lease' : 'tiles';
      const key = `${kind}:${request.method()}:${response.status()}`;
      metrics.http[key] = (metrics.http[key] || 0) + 1;
      if (kind === 'lease') {
        if (request.method() === 'PUT' && response.ok()) activeViewers.add(url.pathname);
        if (request.method() === 'DELETE' && response.ok()) activeViewers.delete(url.pathname);
        event('lease', { method: request.method(), status: response.status() }); return;
      }
      if (!response.ok()) return;
      const result = await response.json();
      const row = result.tiles?.find(tile => tile.studentId === studentId);
      if (!request.postDataJSON()?.selectedSources) {
        const state = row?.state || 'unavailable';
        if (metrics.metadataState !== state) {
          metrics.metadataState = state;
          event('metadata', { state, bindingRevision: row?.bindingRevision ?? null });
        }
      }
      if (!row?.screenshot) return;
      const frameKey = `${row.bindingRevision}:${row.sequence}`;
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
  while (!stop && performance.now() - activeStart < durationSeconds * 1000) {
    let command;
    try { command = JSON.parse(await readFile(controlPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (Number.isSafeInteger(command?.id) && command.id > metrics.lastControlId && actions.has(command.action)) {
      metrics.lastControlId = command.id;
      try {
        switch (command.action) {
          case 'view': {
            if (await desktop.getAttribute('aria-pressed') !== 'true') await desktop.click();
            const expandedButton = page.getByTestId('expanded-view-desktop');
            const button = await expandedButton.isVisible() ? expandedButton : page.getByTestId(`view-desktop-${studentId}`);
            if (await button.isVisible()) await button.click();
            break;
          }
          case 'stop': await stopViewing(); break;
          case 'browser': await closePreview(); await browserSource.click(); break;
          case 'desktop': await closePreview(); await desktop.click(); break;
          case 'enlarge': await page.getByRole('button', { name: /^Enlarge desktop for / }).click(); break;
          case 'close-preview': await closePreview(); break;
          case 'offline': await context.setOffline(true); break;
          case 'online': await context.setOffline(false); break;
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
    const ui = { imageVisible, foregroundVisible: await page.getByTestId(`desktop-observation-${studentId}`).isVisible(),
      desktopSelected: await desktop.getAttribute('aria-pressed') === 'true' };
    if (JSON.stringify(ui) !== JSON.stringify(metrics.ui)) { metrics.ui = ui; event('ui', ui); }
    if (imageVisible && !firstImage) {
      assert.ok(await image.evaluate(node => node.complete && node.naturalWidth > 0));
      firstImage = true;
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
