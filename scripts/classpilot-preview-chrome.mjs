// Serial database + real Chromium capture regression. Run with:
// node --env-file-if-exists=.env --import ./tests/test-environment.mjs --import tsx scripts/classpilot-preview-chrome.mjs
// Requires a ClassPilot checkout and schoolpilot-app's Playwright browser install.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRepo = resolve(process.env.CLASSPILOT_REPO_PATH || resolve(root, '../ClassPilot'));
const execFileAsync = promisify(execFile);
const extensionRef = (await execFileAsync('git', ['-C', extensionRepo, 'rev-parse', 'HEAD'])).stdout.trim();
const extensionChanges = (await execFileAsync('git', ['-C', extensionRepo, 'status', '--porcelain', '--', 'extension'])).stdout.trim();
assert.equal(extensionRef, 'ccaf2c8d1b0df3aa1f8ea74754e457990a74498a', 'capture contract must run against the pinned 2.9.3 runtime');
assert.equal(extensionChanges, '', 'capture runtime must match its clean pinned source');
const frontendRequire = createRequire(join(root, 'schoolpilot-app/package.json'));
const { chromium } = frontendRequire('playwright');
const { build } = frontendRequire('esbuild');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL || '').hostname),
  'This synthetic fixture may run only against a local test database');
const evidencePath = resolve(process.env.CLASSPILOT_PREVIEW_EVIDENCE || join(root, 'evidence-artifacts/preview-chrome'));
await mkdir(evidencePath, { recursive: true });
await Promise.all(['failure.txt', 'failed-preview.png', 'rendered-preview.png'].map(name => rm(join(evidencePath, name), { force: true })));
Object.assign(process.env, { NODE_ENV: 'test', SCHEDULER_ENABLED: 'false', REDIS_URL: '',
  ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENAI_API_KEY: '', SENDGRID_API_KEY: '',
  CLASSPILOT_PROTOCOL_V3_ENABLED: 'true', CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: 'true',
  CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1: 'true',
  CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1: 'true',
  CLASSPILOT_CAP_SCHEDULED_CLASSROOM_V1: 'true', CLASSPILOT_SUPERVISION_PREVIEW_MODE: 'on',
  CLASSPILOT_SCHEDULED_CLASSROOM_MODE: 'on', CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: '',
  CLASSPILOT_SUPERVISION_PREVIEW_EXCLUDED_SCHOOL_IDS: '', CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS: '' });
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { const timer = originalInterval(...args); timer.unref?.(); return timer; };
const { default: db, pool, sessionPool } = await import('../src/db.ts');
const { runWithTenantContext: tenant } = await import('../src/middleware/tenantContext.ts');
const storage = await import('../src/services/storage.ts');
const schema = await import('../src/schema/index.ts');
const { sql } = await import('drizzle-orm');
const { createApp } = await import('../src/app.ts');
const { createStudentToken } = await import('../src/services/deviceJwt.ts');
const { signUserToken } = await import('../src/services/jwt.ts');
const realtime = await import('../src/services/classpilotRealtimeStatus.ts');
const sockets = await import('../src/realtime/ws-broadcast.ts');
const { classpilotScreenshotFallback } = await import('../src/services/classpilotScreenshotFallback.ts');
const { resetClasspilotObservationLeasesForTests } = await import('../src/services/classpilotObservationLease.ts');
const { resetClasspilotScreenshotPolicyRefreshForTests } = await import('../src/services/classpilotScreenshotPolicyRefresh.ts');
const { serializeClasspilotStudentControlState } = await import('../src/services/classpilotClassroomState.ts');
const { syncClasspilotControlStatesToActiveDevices } = await import('../src/services/classpilotControlStateDelivery.ts');

const tag = `preview-chrome-${randomUUID()}`;
const sharedRealtime = new Map();
realtime.setClasspilotRealtimeStatusCommandForTests(async args => {
  if (args[0] === 'MGET') return args.slice(1).map(key => sharedRealtime.get(key) ?? null);
  if (args[0] === 'EVAL' && args[5]?.startsWith('{')) {
    const value = JSON.parse(args[5]);
    value.revision = Math.max(Number(value.revision || 0), Number(args[4] || 0), Number(JSON.parse(sharedRealtime.get(args[3]) || '{}').revision || 0) + 1);
    const encoded = JSON.stringify(value); sharedRealtime.set(args[3], encoded); return encoded;
  }
  return undefined;
});
let school, teacher, admin, student, studentSession, teachingSession, token, baseUrl;
let browser, server, studentPage, viewerPage, worker;
let fixtureSocket;
const watchdog = setTimeout(() => { void browser?.close(); server?.closeAllConnections(); }, 180_000);
watchdog.unref();
const profile = await mkdtemp(join(tmpdir(), 'classpilot-preview-chrome-'));
const uploads = [];
const frames = [];
const evidence = [];
const workerLog = [];
const inSchool = fn => tenant({ schoolId: school.id }, fn);
async function waitFor(fn, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(250); }
  throw new Error(`Timed out: ${label}`);
}
async function staffRequest(path, body, method = 'POST', actor = admin, revision = '0') {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: {
    'content-type': 'application/json', 'x-school-id': school.id,
    'X-ClassPilot-Context-Authority-Revision': revision,
    authorization: `Bearer ${signUserToken({ userId: actor.id, email: actor.email })}`,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function primeWorker() {
  const state = await inSchool(() => storage.getClasspilotStudentControlState(school.id, student.id));
  const serialized = serializeClasspilotStudentControlState(state);
  await worker.evaluate(async ({ baseUrl, schoolId, studentId, sessionId, deviceId, token, state }) => {
    await Promise.all([authStateRestorePromise, classroomStateRestorePromise]);
    await studentAuthMutationTail;
    scheduleHeartbeat(null);
    // The harness bridges the actual server-emitted WebSocket hint; only the
    // socket transport is replaced. Heartbeat HTTP, capture, and upload are real.
    connectWebSocket = async () => {};
    advanceStudentAuthMutationGeneration();
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    await studentAuthMutationTail;
    Object.assign(CONFIG, { serverUrl: baseUrl, schoolId, deviceId, activeStudentId: studentId,
      activeStudentSessionId: sessionId, studentToken: token, studentEmail: 'synthetic@example.test',
      identitySource: 'integration_test', autoRegistrationPaused: true, classId: 'auto' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    CONFIG.authContextId = generateAuthContextId();
    await chrome.storage.local.set({ config: persistedNonAuthConfig(CONFIG), deviceId, autoRegistrationPaused: true });
    await scheduleAuthGateRosterContextReconcile();
    await setManualAuthState({ authContextId: CONFIG.authContextId, studentToken: token, activeStudentId: studentId,
      activeStudentSessionId: sessionId, studentEmail: CONFIG.studentEmail, identitySource: CONFIG.identitySource, registered: true });
    activateAuthenticatedContext(CONFIG.authContextId);
    const auth = captureAuthenticatedContext('preview browser integration');
    adoptLicenseState(true, 'active', auth);
    trackingState = TRACKING_STATES.ACTIVE;
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'full' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
    await durableLocalKv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: [
      'scopedAuthorityChecksV1', 'scheduledClassroomV1', 'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1',
    ] }, auth);
    currentClassroomState = RuntimeCore.normalizeClassroomState(state);
    observeStudentControlRevision(state.revision, auth, 'preview browser integration');
    heartbeatBackoffUntilMs = 0; screenshotBackoffUntilMs = 0;
    screenshotCaptureInFlight = false; screenshotImmediateCapturePending = false;
    lastScreenshotPixelsAt = 0; lastScreenshotAttemptAt = 0;
  }, { baseUrl, schoolId: school.id, studentId: student.id, sessionId: studentSession.id,
    deviceId: `${tag}-device`, token, state: serialized });
  await realtime.writeClasspilotRealtimeStatus({ schoolId: school.id, studentId: student.id, studentSessionId: studentSession.id,
    deviceId: `${tag}-device`, heartbeatId: randomUUID(), activeTabUrl: `${baseUrl}/lesson`, activeTabTitle: 'Synthetic lesson',
    acceptedCapabilities: ['scopedAuthorityChecksV1', 'scheduledClassroomV1', 'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1'],
    classroomState: serialized });
}
async function deliverHint(frame) {
  return worker.evaluate(async frame => {
    const auth = captureAuthenticatedContext('emitted policy refresh');
    await handleWsMessage(JSON.stringify(frame), wsConnectionGeneration, auth);
  }, frame);
}
async function tile(authority, actor = admin) {
  const data = await staffRequest('/api/classpilot/tiles/screenshots', { ...authority, studentIds: [student.id] }, 'POST', actor);
  const entry = data.tiles.find(entry => entry.studentId === student.id);
  return entry?.screenshot ? { ...entry.screenshot, bindingVersion: entry.bindingVersion } : null;
}
async function renderTile(authority, screenshot, expectedColor) {
  const params = new URLSearchParams(authority);
  const rows = await staffRequest(`/api/students-aggregated?${params}`, undefined, 'GET');
  const row = rows.find(row => row.studentId === student.id);
  assert.ok(row, 'real aggregate must include synthetic student');
  await viewerPage.evaluate(({ row, screenshot }) => window.renderPreview({ student: row, screenshotData: screenshot }), { row, screenshot });
  const image = viewerPage.getByTestId(`screenshot-${student.id}`);
  await image.waitFor();
  await waitFor(() => image.evaluate(img => img.complete && img.naturalWidth > 0), 'StudentTile decodes actual screenshot');
  assert.equal(await image.getAttribute('src'), screenshot.screenshot);
  const pixels = await image.evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(canvas.width - 10, canvas.height - 10, 1, 1).data].slice(0, 3);
  });
  assert.ok(pixels.every((value, index) => Math.abs(value - expectedColor[index]) <= 25),
    `captured active lesson color ${pixels} must match ${expectedColor}, not another tab`);
}
try {
  school = await storage.createSchool({ name: tag, domain: `${tag}.example.test`, slug: tag, schoolTimezone: 'UTC', status: 'active', planStatus: 'active' });
  await inSchool(() => storage.upsertSettings(school.id, { schoolName: tag, wsSharedKey: tag, enableTrackingHours: false, afterHoursMode: 'full' }));
  await storage.createProductLicense({ schoolId: school.id, product: 'CLASSPILOT', status: 'active' });
  teacher = await storage.createUser({ email: `teacher@${tag}.example.test`, firstName: 'Synthetic', lastName: 'Teacher' });
  admin = await storage.createUser({ email: `admin@${tag}.example.test`, firstName: 'Synthetic', lastName: 'Admin' });
  for (const [user, role] of [[teacher, 'teacher'], [admin, 'school_admin']]) await storage.createMembership({ userId: user.id, schoolId: school.id, role, status: 'active' });
  await inSchool(async () => {
    [student] = await db.insert(schema.students).values({ schoolId: school.id, firstName: 'Synthetic', lastName: 'Preview', email: `student@${tag}.example.test`, status: 'active' }).returning();
    await db.insert(schema.devices).values({ deviceId: `${tag}-device`, deviceName: 'Synthetic Chrome', schoolId: school.id, classId: 'synthetic-class' });
    [studentSession] = await db.insert(schema.studentSessions).values({ studentId: student.id, deviceId: `${tag}-device`, authKind: 'managed_profile', isActive: true }).returning();
    const group = await storage.createGroup({ schoolId: school.id, teacherId: teacher.id, name: 'Synthetic classroom', groupType: 'admin_class', status: 'active' });
    await db.insert(schema.groupStudents).values({ groupId: group.id, studentId: student.id });
    teachingSession = await storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id, sessionMode: 'live' });
  });
  token = createStudentToken({ schoolId: school.id, studentId: student.id, deviceId: `${tag}-device`, sessionId: studentSession.id, studentEmail: student.email });
  const frontend = resolve(root, 'schoolpilot-app');
  const viewer = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import StudentTile from './src/products/classpilot/components/StudentTile.jsx';const root=createRoot(document.getElementById('root'));window.renderPreview=props=>root.render(React.createElement(StudentTile,{...props,screenshotObservationStatus:'observed',screenshotCaptureCadence:'active_view',freshnessNowMs:Date.now(),onToggleSelect:()=>{},onCommand:()=>{}}));`, resolveDir: frontend, loader: 'jsx' },
    bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' } });
  const app = createApp();
  const fixtureCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
  app.get('/lesson', (_req, res) => res.set('Content-Security-Policy', fixtureCsp).type('html').send('<!doctype html><title>Preview lesson</title><body style="background:#075985;color:white;font:72px sans-serif">FIRST CAPTURE</body>'));
  app.get('/preview-viewer', (_req, res) => res.set('Content-Security-Policy', fixtureCsp).type('html').send('<!doctype html><div id="root" style="width:320px"></div><script type="module" src="/preview-viewer.js"></script>'));
  app.get('/preview-viewer.js', (_req, res) => res.type('js').send(viewer.outputFiles[0].text));
  // Record completed uploads, never manufacture a screenshot response.
  server = createServer((req, res) => {
    if (req.url?.includes('/device/screenshot')) res.once('finish', () => uploads.push({ at: Date.now(), status: res.statusCode }));
    app(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(), headless: true,
    args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      `--disable-extensions-except=${resolve(extensionRepo, 'extension')}`, `--load-extension=${resolve(extensionRepo, 'extension')}`] });
  worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const recordWorkerConsole = current => current.on('console', message => workerLog.push(message.text().replaceAll(token, '[redacted]').slice(0, 1200)));
  recordWorkerConsole(worker);
  studentPage = browser.pages()[0] || await browser.newPage();
  await studentPage.goto(`${baseUrl}/lesson`);
  viewerPage = await browser.newPage(); await viewerPage.goto(`${baseUrl}/preview-viewer`);
  await viewerPage.waitForFunction(() => typeof window.renderPreview === 'function');
  await studentPage.bringToFront();
  // Let the extension's real delayed install initialization finish before the
  // one-time synthetic authentication fixture. No runtime is reset thereafter.
  await delay(5_500);
  await primeWorker();
  fixtureSocket = { readyState: 1, send: raw => frames.push(JSON.parse(raw)) };
  sockets.registerWsClient(fixtureSocket);
  sockets.authenticateWsClient(fixtureSocket, { role: 'student', schoolId: school.id, studentId: student.id,
    studentSessionId: studentSession.id, deviceId: `${tag}-device`, acceptedCapabilities: [
      'scopedAuthorityChecksV1', 'scheduledClassroomV1', 'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1',
    ] });
  const scenarios = [{ name: 'admin Observe teaching class', authority: { teachingSessionId: teachingSession.id } },
    { name: 'teacher-held claim observed by admin', contextType: 'direct_pickup' },
    { name: 'active testing block observed by admin', contextType: 'testing', scheduled: true },
    { name: 'missed claim refresh recovered by heartbeat', contextType: 'direct_pickup', dropHint: true }];
  for (const scenario of scenarios) {
    process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = scenario.contextType === 'direct_pickup' ? 'off' : 'on';
    resetClasspilotObservationLeasesForTests(); resetClasspilotScreenshotPolicyRefreshForTests(); frames.length = 0;
    if (!scenario.authority) {
      const context = await inSchool(() => storage.createSupervisionContextWithStudents({ context: {
        schoolId: school.id, name: scenario.name, contextType: scenario.contextType, status: 'active', assignedStaffId: teacher.id,
        createdBy: admin.id, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3_600_000),
        ...(scenario.scheduled ? { scheduleProfileApplicationId: tag, scheduleProfileDate: new Date().toISOString().slice(0, 10), scheduleProfileBlockId: randomUUID() } : {}),
      }, studentIds: [student.id], assignedBy: admin.id, source: 'manual' }));
      scenario.authority = { supervisionContextId: context.id };
      // Use the same production delivery service as a claim/transfer route;
      // preserve all extension state across class -> claim -> testing changes.
      await syncClasspilotControlStatesToActiveDevices(school.id, [student.id]);
      const transitionFrames = frames.splice(0);
      assert.ok(transitionFrames.some(frame => frame.type === 'classroom-state-sync'), 'transition must emit a real control snapshot');
      for (const frame of transitionFrames) await deliverHint(frame);
      await waitFor(() => worker.evaluate(expected => currentClassroomState?.supervisionContextId === expected, context.id),
        'extension naturally adopts new supervision authority');
    }
    await studentPage.bringToFront();
    await studentPage.evaluate(name => { document.body.textContent = `${name}: FIRST`; document.body.style.background = '#075985'; }, scenario.name);
    resetClasspilotScreenshotPolicyRefreshForTests(); frames.length = 0;
    if (scenario.dropHint) {
      await worker.evaluate(() => scheduleHeartbeat(0.5));
      await waitFor(() => tile(scenario.authority), 'initial background capture before missed hint');
      await studentPage.evaluate(() => { document.body.textContent = 'MISSED HINT: CHANGED AFTER BACKGROUND'; });
    }
    const parent = scenario.authority.supervisionContextId ? `supervision-contexts/${scenario.authority.supervisionContextId}` : `teaching-sessions/${scenario.authority.teachingSessionId}`;
    const started = Date.now();
    await staffRequest(`/api/classpilot/${parent}/observation-lease`, { viewerInstanceId: `preview-${randomUUID()}`, scope: { kind: 'class' } }, 'PUT');
    const emitted = await waitFor(() => frames.find(frame => frame.type === 'screenshot-policy-refresh'), 'real observation route emits refresh');
    assert.equal(emitted.studentId, student.id); assert.equal(emitted.studentSessionId, studentSession.id);
    assert.equal(emitted.deviceId, undefined);
    if (!scenario.dropHint) await deliverHint(emitted);
    const first = await waitFor(async () => { const screenshot = await tile(scenario.authority);
      return screenshot && Number(screenshot.timestamp) >= started ? screenshot : null;
    }, `${scenario.name} first actual capture`);
    const firstMs = Date.now() - started;
    assert.ok(firstMs <= 15_000, `first healthy capture took ${firstMs}ms`);
    assert.match(first.bindingVersion, scenario.authority.supervisionContextId ? /^v3:/ : /^v2:/);
    assert.equal((await tile(scenario.authority, teacher))?.screenshot, first.screenshot,
      'assigned teacher retains the same authorized pixels while an admin observes');
    await renderTile(scenario.authority, first, [7, 89, 133]);
    await studentPage.bringToFront();
    await studentPage.evaluate(name => { document.body.textContent = `${name}: SECOND`; document.body.style.background = '#9d174d'; }, scenario.name);
    const secondStarted = Date.now();
    const second = await waitFor(async () => { const frame = await tile(scenario.authority); return frame?.screenshot !== first.screenshot ? frame : null; }, `${scenario.name} active cadence capture`);
    assert.notEqual(second.screenshot, first.screenshot);
    await renderTile(scenario.authority, second, [157, 23, 77]);
    const digest = frame => createHash('sha256').update(frame.screenshot).digest('hex');
    evidence.push({ scenario: scenario.name, firstMs, nextMs: Date.now() - secondStarted,
      scheduledRollout: process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE, bindingVersion: first.bindingVersion,
      firstDigest: digest(first), secondDigest: digest(second) });
    console.log(JSON.stringify(evidence.at(-1)));
  }
  // Stop the actual MV3 worker while keeping session storage. Navigation wakes
  // a fresh worker; its ordinary heartbeat must restore capture authorization.
  const lastScenario = scenarios.at(-1);
  const beforeSuspend = await tile(lastScenario.authority);
  await staffRequest(`/api/classpilot/supervision-contexts/${lastScenario.authority.supervisionContextId}/observation-lease`,
    { viewerInstanceId: `preview-${randomUUID()}`, scope: { kind: 'class' } }, 'PUT');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}/`;
  const cdp = await browser.newCDPSession(studentPage);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const version of event.versions || []) versions.set(version.versionId, version); });
  await cdp.send('ServiceWorker.enable');
  await waitFor(() => [...versions.values()].some(version => version.scriptURL?.startsWith(extensionOrigin)), 'worker CDP identity');
  for (const version of versions.values()) if (version.scriptURL?.startsWith(extensionOrigin)) await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await waitFor(async () => { const { targetInfos } = await cdp.send('Target.getTargets');
    return !targetInfos.some(target => target.type === 'service_worker' && target.url.startsWith(extensionOrigin));
  }, 'real worker suspension');
  const restartAt = Date.now();
  await studentPage.goto(`${baseUrl}/lesson?after-suspension`); await studentPage.bringToFront();
  worker = await waitFor(async () => {
    for (const candidate of [...browser.serviceWorkers()].reverse()) {
      try { if (await candidate.evaluate(() => chrome.runtime.id)) return candidate; } catch { /* retired worker */ }
    }
    return null;
  }, 'worker navigation wake');
  recordWorkerConsole(worker);
  const afterSuspend = await waitFor(async () => { const frame = await tile(lastScenario.authority);
    return frame && frame.screenshot !== beforeSuspend.screenshot && Number(frame.timestamp) >= restartAt ? frame : null;
  }, 'fresh capture after worker suspension', 30_000);
  await renderTile(lastScenario.authority, afterSuspend, [7, 89, 133]);
  evidence.push({ scenario: 'MV3 suspension and navigation wake', firstMs: Date.now() - restartAt,
    screenshotDigest: createHash('sha256').update(afterSuspend.screenshot).digest('hex') });
  await cdp.detach();
  assert.ok(uploads.filter(upload => upload.status === 200).length >= 9, 'all captures reached the real upload endpoint');
  assert.equal(uploads.some(upload => upload.status >= 400), false, JSON.stringify(uploads));
  console.log('PASS: real observation route hints, existing extension capture/upload, exact-authority reads, and StudentTile pixel decoding.');
  await viewerPage.screenshot({ path: join(evidencePath, 'rendered-preview.png') });
} catch (error) {
  await writeFile(join(evidencePath, 'failure.txt'), String(error?.stack || error).replaceAll(token || '[no-token]', '[redacted]'));
  await viewerPage?.screenshot({ path: join(evidencePath, 'failed-preview.png'), timeout: 2_000 }).catch(() => {});
  throw error;
} finally {
  clearTimeout(watchdog);
  await writeFile(join(evidencePath, 'evidence.json'), JSON.stringify({ completedScenarios: evidence, uploadOutcomes: uploads,
    extensionRef, extensionChanges,
    transport: 'actual server hint bridged to existing extension handler; real HTTP heartbeat/upload/read; native browser capture',
  }, null, 2));
  await writeFile(join(evidencePath, 'worker.log'), workerLog.join('\n'));
  if (fixtureSocket) sockets.removeWsClient(fixtureSocket);
  await browser?.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  realtime.setClasspilotRealtimeStatusCommandForTests(undefined); classpilotScreenshotFallback.clear(); resetClasspilotObservationLeasesForTests();
  if (school) await tenant({ isSuper: true }, async () => {
    // Only the generated school is touched, including partial failed setup.
    for (const table of ['classpilot_monitoring_events', 'heartbeats', 'classpilot_chat_deliveries', 'chat_messages', 'classpilot_active_hands', 'session_settings',
      'classpilot_command_targets', 'classpilot_commands', 'classpilot_classroom_states', 'classpilot_student_control_states',
      'classpilot_supervision_students', 'classpilot_supervision_contexts', 'classpilot_session_students', 'classpilot_session_staff', 'teaching_sessions']) {
      await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${school.id}`);
    }
    await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id=${school.id})`);
    await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id=${school.id})`);
    await db.execute(sql`DELETE FROM groups WHERE school_id=${school.id}`);
    if (student) await db.execute(sql`DELETE FROM student_sessions WHERE student_id=${student.id}`);
    for (const table of ['student_devices', 'devices', 'students', 'settings', 'product_licenses', 'school_memberships', 'classpilot_school_schedules']) {
      if (table === 'student_devices') { if (student) await db.execute(sql`DELETE FROM student_devices WHERE student_id=${student.id}`); }
      else await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${school.id}`);
    }
    await db.execute(sql`UPDATE schools SET status='suspended',is_active=false,deleted_at=now() WHERE id=${school.id}`);
  });
  await (await import('../src/services/errorMonitor.ts')).default.disposeAndWait();
  const scheduler = await import('../src/services/schedulerDb.ts');
  await Promise.allSettled([pool.end(), sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
  // mkdtemp created this exact test-owned directory; its absolute path remains
  // inside the system temporary directory before recursive cleanup.
  assert.equal(dirname(profile), resolve(tmpdir()));
  await rm(profile, { recursive: true, force: true });
}
