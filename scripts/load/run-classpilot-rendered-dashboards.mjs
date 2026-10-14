import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { assertExternalPaths, loadExternalConfig, preparePrivateOutputDirectory } from './prepare-classpilot-load-test.mjs';
import { hasLoadSessionCookie, loadSessionCookieName } from './session-cookie.mjs';
import { reliabilityProfile, reliabilityScreenshotBindingMatches, RELIABILITY_ENDPOINT_SHA256 } from './classpilot-reliability-profile.mjs';
import { readReliabilityFrame } from './reliability-rendered-frame.mjs';
import { validateStagingRunManifest, waitForStagingStart } from './staging-start-barrier.mjs';
import { RenderedHttpMetrics, attachRenderedHttpMetrics } from './rendered-http-metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const RENDERED_VIEWPORT = Object.freeze({ width: 1920, height: 4320 });

export async function renderedDeadline(operation, milliseconds = 8000) {
  const controller = new AbortController();
  const timeout = delay(milliseconds, null, { signal: controller.signal, ref: false })
    .then(() => { throw new Error('Rendered instrumentation deadline exceeded'); });
  try { return await Promise.race([operation, timeout]); }
  finally { controller.abort(); }
}

// This function runs in the actual candidate page, after the compositor has
// had two animation frames. Mounted or decoded offscreen images do not count.
export async function collectRenderedDashboardSample() {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { visible: document.visibilityState === 'visible', sampledAt: Date.now(),
    cards: [...document.querySelectorAll('[data-testid^="card-student-"]')].map(card => {
      const studentId = card.getAttribute('data-testid').slice('card-student-'.length);
      const image = card.querySelector(`[data-testid="screenshot-${CSS.escape(studentId)}"]`);
      const source = image?.currentSrc || '';
      let frame = null;
      if (source.startsWith('data:image/jpeg;base64,')) {
        try {
          const bytes = atob(source.slice('data:image/jpeg;base64,'.length));
          const match = bytes.slice(-98, -2).match(/^CLP_REL_FRAME_V1:(\d{13}):(\d+):END/);
          if (match) frame = { capturedAt: Number(match[1]), ordinal: Number(match[2]) };
        } catch { /* Unreadable sources remain unavailable. */ }
      }
      const box = image?.getBoundingClientRect();
      let displayed = Boolean(box && box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0
        && box.right <= innerWidth && box.bottom <= innerHeight);
      for (let ancestor = image; displayed && ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) displayed = false;
        const ancestorBox = ancestor.getBoundingClientRect();
        if ((/(hidden|clip|scroll|auto)/.test(style.overflowX) && (box.left < ancestorBox.left || box.right > ancestorBox.right))
          || (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (box.top < ancestorBox.top || box.bottom > ancestorBox.bottom))) displayed = false;
      }
      return { studentId, frame, displayed, decoded: Boolean(image?.complete && image?.naturalWidth > 0) };
    }) };
}

export function observeRenderedCommandUpdate(runtime, message, observedAt) {
  if (message?.type !== 'classpilot-command-update') return false;
  const command = message.command;
  if (command?.teacherId !== runtime.actor.teacherId || command.teachingSessionId !== runtime.actor.teachingSessionId) return false;
  const id = message.commandId || command.id;
  if (typeof id !== 'string' || !Array.isArray(command.targets)) return false;
  let observed = runtime.commands.get(id);
  if (!observed) {
    observed = new Map(); runtime.commands.set(id, observed);
    if (runtime.commands.size > 32) runtime.commands.delete(runtime.commands.keys().next().value);
  }
  for (const target of command.targets) {
    if (!runtime.allowed.has(target.studentId)) return true;
    const timing = observed.get(target.studentId) || {};
    if ((target.receivedAt || ['received', 'completed'].includes(target.status)) && timing.receivedAt === undefined) timing.receivedAt = observedAt;
    if (target.status === 'completed' && timing.completedAt === undefined) timing.completedAt = observedAt;
    observed.set(target.studentId, timing);
  }
  return false;
}

export function renderedAgeHistogram() {
  const bounds = [5000, 10000, 15000, 30000, Infinity], counts = bounds.map(() => 0);
  let total = 0, maximum = 0;
  return { observe(age) { total += 1; maximum = Math.max(maximum, age); counts[bounds.findIndex(bound => age <= bound)] += 1; },
    percentile(percent) { if (!total) return null; let cumulative = 0;
      for (let index = 0; index < bounds.length; index += 1) { cumulative += counts[index]; if (cumulative >= Math.ceil(total * percent / 100)) return Number.isFinite(bounds[index]) ? bounds[index] : maximum; }
      return maximum; }, summary() { return { count: total, boundsMs: bounds.map(bound => Number.isFinite(bound) ? bound : null), counts: [...counts], maxMs: maximum }; } };
}

export function validateRenderedDashboardInputs(auth, count, env = process.env, startAtMs = Date.now()) {
  const profile = reliabilityProfile(count);
  assert.equal(auth.schemaVersion, 2);
  assert.equal(auth.baseUrl, 'https://staging.school-pilot.net');
  assert.equal(env.LOAD_RELIABILITY_STAGING_ORIGIN, auth.baseUrl);
  assert.equal(loadSessionCookieName(env), 'schoolpilot.staging.sid');
  assert.equal(auth.teacherAuth?.length, profile.classrooms);
  const ids = auth.teacherAuth.flatMap(actor => actor.studentIds);
  assert.equal(ids.length, count);
  assert.equal(new Set(ids).size, count);
  assert.equal(new Set(auth.teacherAuth.map(actor => actor.teacherId)).size, profile.classrooms);
  assert.equal(new Set(auth.teacherAuth.map(actor => actor.teachingSessionId)).size, profile.classrooms);
  const until = startAtMs + profile.durationSeconds * 1000 + 60_000;
  assert.ok(Date.parse(auth.deviceManifestExpiresAt) > until && Date.parse(auth.expiresAt) > until);
  for (const actor of auth.teacherAuth) {
    assert.ok(actor.role === 'teacher' && actor.schoolId === auth.schoolId && actor.teacherId && actor.teachingSessionId);
    assert.equal(actor.studentIds.length, profile.studentsPerClass);
    assert.ok(hasLoadSessionCookie(actor.teacherCookie, 'schoolpilot.staging.sid') && actor.csrfToken && actor.teacherToken);
    assert.ok(Date.parse(actor.expiresAt) > until);
  }
  return profile;
}

export function validateRenderedManifest(authBytes, manifest, primaryDevices, startAt, now = Date.now()) {
  assert.equal(manifest.files?.auth?.bytes, authBytes.length, 'Rendered auth byte count must match the fleet manifest');
  return validateStagingRunManifest(manifest, { startAt: startAt === undefined ? manifest.startAt : startAt,
    primaryDevices, authSha256: hash(authBytes) }, now);
}

export function renderedCommandRequestPath(pathname) {
  return pathname === '/api/commands' || pathname === '/api/classpilot/commands';
}

export function renderedCommandMatches(request, actor, commandUrl) {
  if (request?.teachingSessionId !== actor.teachingSessionId || request.commandType !== 'open-tab'
    || request.commandPayload?.url !== commandUrl || 'deviceId' in request || 'deviceIds' in request) return false;
  if (request.targetScope === 'class') return !('targetStudentIds' in request) && !('subgroupId' in request);
  const targets = request.targetStudentIds;
  return request.targetScope === 'students' && Array.isArray(targets) && targets.length === actor.studentIds.length
    && new Set(targets).size === targets.length && targets.every(id => actor.studentIds.includes(id)) && !('subgroupId' in request);
}

function assetHashes(directory, relative = '') {
  return readdirSync(join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name);
    return entry.isDirectory() ? assetHashes(directory, name)
      : [{ path: '/' + name.replaceAll('\\', '/'), sha256: hash(readFileSync(join(directory, name))) }];
  });
}

export async function runRenderedDashboards(arguments_ = process.argv.slice(2)) {
  const { values } = parseArgs({ args: arguments_, options: { config: { type: 'string' }, auth: { type: 'string' },
    output: { type: 'string' }, devices: { type: 'string' }, 'frontend-dist': { type: 'string' },
    'input-manifest': { type: 'string' }, 'start-at': { type: 'string' },
    'chrome-path': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) return console.log('Usage: node scripts/load/run-classpilot-rendered-dashboards.mjs --config <external-staging-config> --auth <selected-private-auth> --input-manifest <exact-remote-input-manifest> --output <fresh-private-dir> --devices40|500|800 --frontend-dist <exact-candidate-dist> [--start-at <matching-manifest-UTC>] [--chrome-path <Chrome>] [--dry-run]. Loads real authenticated dashboards before the shared UTC start barrier. No mock API or shortened staging duration.');
  assert.ok(values.config && values.auth && values.output && values.devices && values['frontend-dist'] && values['input-manifest']);
  const paths = assertExternalPaths(values.config, values.output);
  const authPath = assertExternalPaths(values.auth, paths.outputPath).configPath;
  const manifestPath = assertExternalPaths(values['input-manifest'], paths.outputPath).configPath;
  const config = loadExternalConfig(paths.configPath);
  assert.equal(config.syntheticStaging, true);
  assert.equal(config.reliabilityDeviceCount, Number(values.devices));
  const authBytes = readFileSync(authPath), auth = JSON.parse(authBytes.toString('utf8'));
  const inputManifestBytes = readFileSync(manifestPath);
  const manifest = validateRenderedManifest(authBytes, JSON.parse(inputManifestBytes.toString('utf8')),
    Number(values.devices), values['start-at']);
  const profile = validateRenderedDashboardInputs(auth, Number(values.devices), process.env, Date.parse(manifest.startAt));
  const dist = resolve(values['frontend-dist']);
  assert.ok(existsSync(join(dist, 'index.html')));
  const assets = assetHashes(dist).sort((first, second) => first.path.localeCompare(second.path));
  const expectedAssets = new Map(assets.filter(asset => /\.(?:js|css)$/.test(asset.path)).map(asset => [asset.path, asset.sha256]));
  assert.ok(expectedAssets.size > 0);
  if (values['dry-run']) return console.log(JSON.stringify({ operation: 'rendered-browser-preflight', profile,
    runId: manifest.runId, plannedStartAt: manifest.startAt, candidateAssetCount: expectedAssets.size,
    browserPaintValidated: false, managedDevicesValidated: false, productionAccepted: false }));
  preparePrivateOutputDirectory(paths.outputPath);
  assert.equal(existsSync(join(paths.outputPath, 'rendered-summary.json')), false, 'Fresh browser evidence required');
  const { chromium } = createRequire(join(root, 'schoolpilot-app/package.json'))('playwright');
  const chrome = values['chrome-path'] || process.env.CLASSPILOT_CHROME_PATH || chromium.executablePath();
  assert.ok(existsSync(chrome), 'Real Chrome/Chromium executable required');
  let startedAt = null, startedMonotonic = null, endMonotonic = null, barrier = null;
  const counters = { samples: 0, unavailable: 0, wrongClass: 0, wrongBinding: 0, hidden: 0,
    httpErrors: 0, pageErrors: 0, assetMismatch: 0, commandRequested: 0, commandCompletedWithin5s: 0,
    commandReceivedWithin2s: 0, commandTargets: 0, commandScopeMismatch: 0, crossOriginSockets: 0,
    sampleRounds: 0, slowSampleRounds: 0 };
  const ages = renderedAgeHistogram(), actors = [], loadedAssets = new Set();
  const httpMetrics = new RenderedHttpMetrics({ origin: auth.baseUrl });
  const browser = await chromium.launch({ executablePath: chrome, headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  let thrown = false, interrupted = false, phase = 'preparing';
  const barrierAbort = new AbortController();
  const stop = () => { interrupted = true; barrierAbort.abort(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try {
    await Promise.all(auth.teacherAuth.map(async (actor, index) => {
      const context = await browser.newContext({ viewport: RENDERED_VIEWPORT });
      context.setDefaultTimeout(10_000);
      await context.route('**/*', route => new URL(route.request().url()).origin === auth.baseUrl ? route.continue() : route.abort());
      const pair = actor.teacherCookie.split(';').map(value => value.trim()).find(value => value.startsWith('schoolpilot.staging.sid='));
      await context.addCookies([{ name: 'schoolpilot.staging.sid', value: pair.slice('schoolpilot.staging.sid='.length),
        url: auth.baseUrl, secure: true, httpOnly: true, sameSite: 'Lax' }]);
      await context.addInitScript(schoolId => localStorage.setItem('sp_activeSchoolId', schoolId), actor.schoolId);
      const page = await context.newPage(), frames = new Map(), allowed = new Set(actor.studentIds);
      const runtime = { actor, context, page, frames, allowed, index, initialPaint: false, lastOrdinals: new Map(), freshUpdates: 0,
        bindings: new Map(), commands: new Map(), samples: 0, unavailable: 0, compositorSha256: null };
      actors.push(runtime);
      attachRenderedHttpMetrics(page, httpMetrics, index);
      page.on('pageerror', () => { counters.pageErrors += 1; });
      page.on('websocket', socket => {
        const url = new URL(socket.url());
        if (url.protocol !== 'wss:' || url.hostname !== new URL(auth.baseUrl).hostname) counters.crossOriginSockets += 1;
        socket.on('framereceived', event => {
          try {
            if (observeRenderedCommandUpdate(runtime, JSON.parse(String(event.payload)), performance.now())) counters.commandScopeMismatch += 1;
          } catch { /* Other transport frames cannot establish command completion. */ }
        });
      });
      page.on('response', async response => {
        let expectedAsset = false;
        try {
          const url = new URL(response.url());
          if (url.origin !== auth.baseUrl) return;
          if (/\.(?:js|css)$/.test(url.pathname) && !expectedAssets.has(url.pathname)) counters.assetMismatch += 1;
          expectedAsset = expectedAssets.has(url.pathname);
          if (expectedAsset) {
            if (response.status() !== 200 || hash(await renderedDeadline(response.body())) !== expectedAssets.get(url.pathname)) counters.assetMismatch += 1;
            else loadedAssets.add(url.pathname);
          }
          if (url.pathname !== '/api/classpilot/tiles/screenshots') return;
          if (!response.ok()) { counters.httpErrors += 1; return; }
          const body = await renderedDeadline(response.json());
          for (const tile of body.tiles || []) {
            if (!allowed.has(tile.studentId)) { counters.wrongClass += 1; continue; }
            if (runtime.bindings.get(tile.studentId) !== tile.bindingVersion) frames.delete(tile.studentId);
            runtime.bindings.set(tile.studentId, tile.bindingVersion);
            if (!tile.screenshot) continue;
            if (!reliabilityScreenshotBindingMatches(tile)) { counters.wrongBinding += 1; continue; }
            const capture = readReliabilityFrame(tile.screenshot.screenshot);
            if (!capture) continue;
            const recent = (frames.get(tile.studentId) || []).filter(frame => Date.now() - frame.seenAt < 30_000);
            recent.push({ ...capture, seenAt: Date.now() });
            frames.set(tile.studentId, recent.slice(-8));
          }
        } catch { counters.httpErrors += 1; if (expectedAsset) counters.assetMismatch += 1; }
      });
      await page.goto(auth.baseUrl + '/classpilot', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForFunction(expected => document.querySelectorAll('[data-testid^="card-student-"]').length === expected,
        profile.studentsPerClass, { timeout: 60_000 });
      await page.waitForFunction(expected => {
        const ids = [...document.querySelectorAll('[data-testid^="card-student-"]')].map(card => card.getAttribute('data-testid').slice('card-student-'.length));
        return document.visibilityState === 'visible' && ids.length === expected.length && new Set(ids).size === expected.length
          && ids.every(id => expected.includes(id))
          && document.querySelector('[data-testid="badge-connection-status"]')?.textContent.trim() === 'Live updates';
      }, actor.studentIds, { timeout: 30_000 });
    }));
    assert.equal(actors.length, profile.classrooms);
    phase = 'start-barrier';
    barrier = await waitForStagingStart({ startAt: manifest.startAt, origin: auth.baseUrl,
      inputCreatedAt: manifest.createdAt, signal: barrierAbort.signal,
      onReady: ready => writeFileSync(join(paths.outputPath, 'rendered-ready.json'), JSON.stringify({ schemaVersion: 1,
        runId: manifest.runId, startAt: manifest.startAt, ...ready,
        classrooms: actors.length, primaryDevices: profile.primaryDevices, candidateFrontendSha256: hash(JSON.stringify(assets)),
        authFileSha256: hash(authBytes), browserPaintValidated: false, managedDevicesValidated: false, productionAccepted: false })) });
    startedAt = Date.parse(barrier.actualStartedAt);
    startedMonotonic = barrier.monotonicStartedAt;
    endMonotonic = startedMonotonic + profile.durationSeconds * 1000;
    httpMetrics.startWindow(startedMonotonic, profile.durationSeconds * 1000);
    phase = 'warming';
    while (!interrupted && performance.now() < startedMonotonic + 60_000) await delay(1000);
    assert.equal(interrupted, false, 'Full campaign required');
    phase = 'classroom-command-burst';
    // All actors use the real candidate UI and submit once, concurrently.
    await Promise.all(actors.map(async ({ page }) => {
      await page.getByTestId('button-open-tab').click();
      await page.getByTestId('input-open-tab-url').fill(config.commandUrl);
    }));
    const burstStartedAt = performance.now(), commandSubmissionTimes = [];
    await Promise.all(actors.map(async runtime => {
      const { page, actor } = runtime;
      const requestPromise = page.waitForRequest(request => renderedCommandRequestPath(new URL(request.url()).pathname)
        && request.method() === 'POST', { timeout: 10_000 }).then(request => { commandSubmissionTimes.push(performance.now()); return request; });
      const responsePromise = page.waitForResponse(response => renderedCommandRequestPath(new URL(response.url()).pathname)
        && response.request().method() === 'POST', { timeout: 10_000 });
      const requestAt = performance.now();
      const [requestEvent, response] = await Promise.all([requestPromise, responsePromise,
        page.getByTestId('button-confirm-open-tab').click()]);
      counters.commandRequested += 1;
      const request = requestEvent.postDataJSON(), body = await renderedDeadline(response.json());
      if (response.status() !== 201 || !renderedCommandMatches(request, actor, config.commandUrl)
        || Number(body.summary?.sent) !== profile.studentsPerClass || !body.command?.id) {
        counters.commandScopeMismatch += 1; return;
      }
      counters.commandTargets += profile.studentsPerClass;
      // Timestamp the issuing teacher's observed socket frames. Poll response
      // arrival and server clocks must not substitute for UI receipt latency.
      while (performance.now() - requestAt < 7000) {
        const observed = runtime.commands.get(body.command.id);
        if (observed?.size === profile.studentsPerClass && [...observed.values()].every(target => target.completedAt !== undefined)) break;
        await delay(100);
      }
      for (const timing of runtime.commands.get(body.command.id)?.values() || []) {
        if (timing.receivedAt >= requestAt && timing.receivedAt - requestAt <= 2000) counters.commandReceivedWithin2s += 1;
        if (timing.completedAt >= requestAt && timing.completedAt - requestAt <= 5000) counters.commandCompletedWithin5s += 1;
      }
    }));
    const concurrentBurstElapsedMs = performance.now() - burstStartedAt;
    phase = 'sampling';
    let nextSampleAt = performance.now();
    while (!interrupted && performance.now() < endMonotonic) {
      const roundStartedAt = performance.now();
      counters.sampleRounds += 1;
      await Promise.all(actors.map(async runtime => {
        const sample = await renderedDeadline(runtime.page.evaluate(collectRenderedDashboardSample));
        if (!sample.visible) counters.hidden += 1;
        if (sample.cards.length !== profile.studentsPerClass || new Set(sample.cards.map(card => card.studentId)).size !== profile.studentsPerClass) counters.wrongClass += 1;
        for (const card of sample.cards) {
          counters.samples += 1;
          runtime.samples += 1;
          if (!runtime.allowed.has(card.studentId)) { counters.wrongClass += 1; continue; }
          const frame = card.frame;
          const authorized = frame && runtime.frames.get(card.studentId)?.some(candidate => candidate.ordinal === frame.ordinal && candidate.capturedAt === frame.capturedAt);
          if (!sample.visible || !card.displayed || !card.decoded || !frame || !authorized || frame.capturedAt > sample.sampledAt + 1000) {
            counters.unavailable += 1; runtime.unavailable += 1; continue;
          }
          ages.observe(Math.max(0, sample.sampledAt - frame.capturedAt));
          if (runtime.lastOrdinals.get(card.studentId) !== frame.ordinal) { runtime.freshUpdates += 1; runtime.lastOrdinals.set(card.studentId, frame.ordinal); }
        }
        if (!runtime.initialPaint) {
          // The native compositor output proves rendering without persisting
          // pixels or identifiers in the operational result artifacts.
          runtime.compositorSha256 = hash(await runtime.page.screenshot({ timeout: 8000 }));
          runtime.initialPaint = true;
        }
      }));
      writeFileSync(join(paths.outputPath, 'rendered-progress.json'), JSON.stringify({ runId: manifest.runId,
        plannedStartAt: manifest.startAt, elapsedSeconds: (performance.now() - startedMonotonic) / 1000,
        classrooms: actors.length, counters, http: httpMetrics.progress(), p95CaptureAgeMs: ages.percentile(95), p99CaptureAgeMs: ages.percentile(99) }));
      if (performance.now() - roundStartedAt > 5000) counters.slowSampleRounds += 1;
      nextSampleAt += 5000;
      if (nextSampleAt < performance.now()) nextSampleAt = performance.now();
      await delay(Math.min(Math.max(0, nextSampleAt - performance.now()), Math.max(0, endMonotonic - performance.now())));
    }
    httpMetrics.closeWindow();
    const measuredDurationMs = performance.now() - startedMonotonic;
    phase = 'draining-http-evidence';
    await httpMetrics.drain();
    const http = httpMetrics.summary();
    const failures = [];
    if (interrupted || performance.now() < endMonotonic) failures.push('full-duration campaign interrupted');
    if (actors.some(runtime => runtime.samples < profile.studentsPerClass * Math.floor((profile.durationSeconds - 90) / 5))) failures.push('rendered sample underrun');
    if (!counters.samples || counters.unavailable / counters.samples > 0.01) failures.push('more than1% rendered frames unavailable');
    if ((ages.percentile(95) ?? Infinity) > 10_000 || (ages.percentile(99) ?? Infinity) > 15_000) failures.push('rendered capture age exceeds p95=10s or p99=15s');
    if (counters.wrongClass || counters.wrongBinding || counters.commandScopeMismatch || counters.hidden || counters.assetMismatch
      || counters.pageErrors || counters.crossOriginSockets || !loadedAssets.size || actors.some(runtime => !runtime.compositorSha256)) failures.push('isolation, visibility, candidate asset or runtime error');
    if (counters.commandRequested !== profile.classrooms || counters.commandTargets !== profile.primaryDevices
      || counters.commandReceivedWithin2s / profile.primaryDevices < 0.99 || counters.commandCompletedWithin5s / profile.primaryDevices < 0.99) failures.push('concurrent UI command receipt/completion gate');
    const commandDispatchSpreadMs = Math.max(...commandSubmissionTimes) - Math.min(...commandSubmissionTimes);
    if (commandSubmissionTimes.length !== profile.classrooms || commandDispatchSpreadMs > 1000) failures.push('UI command dispatches did not form a one-second concurrent classroom burst');
    if (!http.allStartedRequestsMeasured || http.rawInFlightAfterDrain || http.counters.http403 || http.counters.http429
      || http.counters.otherHttpErrors) failures.push('incomplete or blocked browser API request evidence');
    if (!http.counters.requestsStarted || http.counters.failedMeasurements / http.counters.requestsStarted > 0.01) failures.push('browser API measurement failure rate exceeds one percent');
    for (const endpoint of ['GET /api/classpilot/commands/active-state', 'GET /api/classpilot/teacher/raised-hands']) {
      const latency = http.fineEndpointLatency.endpoints[endpoint];
      if (!latency?.p95Bounds.complete || !latency.p95Bounds.finite || latency.p95Bounds.upperMs > 1000) failures.push('classroom state or raised-hands p95 exceeds one second or is unmeasured');
      if (!latency?.count || latency.failedCount / latency.count > 0.01) failures.push('classroom state or raised-hands failure rate exceeds one percent');
      const counts = http.endpointRequestsPerActor[endpoint];
      if (!counts || actors.some(runtime => counts[runtime.index] < Math.max(1, Math.floor((profile.durationSeconds - 90) / 35)))) failures.push('classroom state or raised-hands read sample underrun');
    }
    const summary = { schemaVersion: 1, workload: profile.version, endpointShapeSha256: RELIABILITY_ENDPOINT_SHA256,
      runId: manifest.runId, startAt: manifest.startAt, candidateApiImage: manifest.candidateApiImage,
      inputManifestSha256: hash(inputManifestBytes), startBarrier: barrier, measuredDurationMs, http,
      browser: browser.version(), startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
      durationSeconds: profile.durationSeconds, primaryDevices: profile.primaryDevices, classrooms: profile.classrooms,
      candidateFrontendSha256: hash(JSON.stringify(assets)), verifiedLoadedAssets: loadedAssets.size,
      viewport: RENDERED_VIEWPORT, commandTimingBasis: 'issuing-teacher-observed-websocket-frame-from-UI-click',
      classroomSamples: actors.sort((left, right) => left.index - right.index).map(runtime => ({ samples: runtime.samples,
        unavailable: runtime.unavailable, compositorSha256: runtime.compositorSha256 })),
      counters, captureAge: { ...ages.summary(), p95Ms: ages.percentile(95), p99Ms: ages.percentile(99) },
      minimumFreshUpdatesPerClassroom: Math.min(...actors.map(runtime => runtime.freshUpdates)),
      concurrentBurstElapsedMs, commandDispatchSpreadMs, browserPaintValidated: failures.length === 0,
      managedDevicesValidated: false, productionAccepted: false, failures };
    writeFileSync(join(paths.outputPath, 'rendered-summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ operation: 'rendered-browser-finished', classrooms: profile.classrooms,
      browserPaintValidated: summary.browserPaintValidated, failures }));
    if (failures.length) process.exitCode = 1;
  } catch { thrown = true; throw new Error('Rendered dashboard campaign failed; no private response details emitted'); }
  finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
    await browser.close();
    if (thrown) writeFileSync(join(paths.outputPath, 'rendered-summary.json'), JSON.stringify({ browserPaintValidated: false,
      productionAccepted: false, managedDevicesValidated: false, failurePhase: phase, counters, http: httpMetrics.summary(), failures: ['incomplete rendered dashboard campaign'] }, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRenderedDashboards().catch(() => { console.error('[rendered-dashboards] Refused or failed; private credentials and responses omitted'); process.exitCode = 1; });
}
