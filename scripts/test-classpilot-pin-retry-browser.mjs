// Compatibility gate for a backend PIN-retry change against an unchanged extension.
// Usage: node scripts/test-classpilot-pin-retry-browser.mjs --extension-dir ../ClassPilot/extension --evidence-dir <directory>
// Requires Playwright from SchoolPilot or the supplied ClassPilot checkout, plus Chromium.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'extension-dir': { type: 'string' }, 'evidence-dir': { type: 'string' },
  'chrome-path': { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node scripts/test-classpilot-pin-retry-browser.mjs --extension-dir <unchanged-2.8.7-extension> --evidence-dir <output> [--chrome-path <chromium>]');
  process.exit(0);
}
assert.ok(values['extension-dir'] && values['evidence-dir'], '--extension-dir and --evidence-dir are required');
const source = resolve(values['extension-dir']), evidence = resolve(values['evidence-dir']);
assert.ok(!evidence.startsWith(source + sep) && evidence !== source, 'Evidence must be outside extension source');
mkdirSync(evidence, { recursive: true });
const manifestBytes = readFileSync(join(source, 'manifest.json'));
assert.equal(JSON.parse(manifestBytes).version, '2.8.7', 'This compatibility gate targets unchanged ClassPilot 2.8.7');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function hashes(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = join(relative, entry.name);
    return entry.isDirectory() ? hashes(root, name) : [{ path: name.replaceAll('\\', '/'), sha256: hash(readFileSync(join(root, name))) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
const sourceHashes = hashes(source);
let playwrightPath;
for (const root of [resolve(dirname(fileURLToPath(import.meta.url)), '..'), dirname(source)]) {
  try { playwrightPath = createRequire(join(root, 'package.json')).resolve('playwright'); break; } catch { /* Try the extension checkout's existing test dependency. */ }
}
assert.ok(playwrightPath, 'Install Playwright in SchoolPilot or the ClassPilot checkout');
const playwrightModule = await import(pathToFileURL(playwrightPath));
const { chromium } = playwrightModule.default ?? playwrightModule;
const executablePath = [values['chrome-path'], process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath()]
  .find(candidate => candidate && existsSync(candidate));
assert.ok(executablePath, 'Install Playwright Chromium or supply --chrome-path');

const WRONG_PIN = '0000', CORRECT_PIN = '2468', REJECTIONS = 50;
const REJECTION_MESSAGE = 'Incorrect PIN. Please try again.';
const state = { attempts: 0, wrong: 0, success: 0, active: 0, maxActive: 0, config: 0, roster: 0, heartbeat: 0, otherAuthMutations: 0, malformed: 0, statuses: [], held: null };
const json = (response, status, body) => {
  response.writeHead(status, { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); response.end(); return; }
  if (path.endsWith('/login-config')) {
    state.config++;
    json(response, 200, { sharedSignInEnabled: true, loginMethod: 'name_pin', schoolId: 'pin-retry-fixture-school', passpilotKioskAvailable: false }); return;
  }
  if (path.endsWith('/login-roster')) {
    state.roster++;
    json(response, 200, { loginMethod: 'name_pin', grades: [{ value: '5', label: 'Grade 5' }], students: [{ id: 'fixture-student', name: 'Fixture Student', gradeLevel: '5', hasPin: true }], refreshAfterMs: 30_000 }); return;
  }
  if (path.endsWith('/student-login')) {
    const chunks = []; let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size <= 32_768) chunks.push(chunk); else request.destroy(); });
    request.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { state.malformed++; json(response, 400, { error: 'Invalid request' }); return; }
      if (body.studentId !== 'fixture-student' || ![WRONG_PIN, CORRECT_PIN].includes(body.pin)) {
        state.malformed++; json(response, 400, { error: 'Invalid request' }); return;
      }
      state.attempts++; state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      const accepted = body.pin === CORRECT_PIN;
      const finish = () => {
        state.active--; state.statuses.push(accepted ? 200 : 401);
        if (!accepted) { state.wrong++; json(response, 401, { error: REJECTION_MESSAGE }); return; }
        state.success++;
        json(response, 200, {
          studentToken: 'local-fixture-token', studentSessionId: 'fixture-session',
          sessionRecovery: { token: 'R'.repeat(43) }, schoolId: 'pin-retry-fixture-school',
          student: { id: 'fixture-student', firstName: 'Fixture', lastName: 'Student', email: 'fixture@example.invalid' }, classroomState: null,
        });
      };
      // The first rejection stays pending so duplicate UI events can be tested deterministically.
      if (state.attempts === 1) state.held = finish; else setTimeout(finish, 100);
    });
    return;
  }
  if (path.endsWith('/session-gate-presence') || path.endsWith('/session-release')) { response.writeHead(204); response.end(); return; }
  if (path.endsWith('/device/heartbeat')) {
    state.heartbeat++;
    json(response, 200, { success: true, studentId: 'fixture-student', studentSessionId: 'fixture-session', schoolId: 'pin-retry-fixture-school', serverProtocolVersion: 3,
      acceptedCapabilities: ['scopedAuthorityChecksV1', 'screenshotTrackingWindowLeaseV1', 'screenshotObservationLeaseV1'],
      screenshotPolicy: { mode: 'tracking_window_lease', captureAllowed: false, expiresInSeconds: 90, serverTime: new Date().toISOString(), authority: { kind: 'student_session', controlRevision: 0 } } }); return;
  }
  if (path === '/api/school/status') { json(response, 200, { success: true, schoolActive: true, planStatus: 'active' }); return; }
  if (path === '/api/extension/settings') {
    json(response, 200, { studentId: 'fixture-student', studentSessionId: 'fixture-session', schoolId: 'pin-retry-fixture-school', enableTrackingHours: false, afterHoursMode: 'full', schoolTimezone: 'America/New_York' }); return;
  }
  if (/register-student|student-login|session-transfer/.test(path)) state.otherAuthMutations++;
  if (path.startsWith('/api/')) { json(response, 404, { error: 'Fixture route unavailable' }); return; }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><html><head><title>Local PIN retry fixture</title></head><body><button id="underlying-action" style="position:fixed;left:16px;top:16px;width:220px;height:64px">Underlying page</button><script>window.underlyingClicks=0;document.querySelector("#underlying-action").onclick=()=>window.underlyingClicks++;</script></body></html>');
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const origin = `http://127.0.0.1:${server.address().port}`;
const temporary = mkdtempSync(join(tmpdir(), 'schoolpilot-pin-retry-browser-'));
const extension = join(temporary, 'extension');
let context;
const startedAtUtc = new Date().toISOString();
async function until(check, message, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(done => setTimeout(done, 25)); }
  assert.fail(message);
}
async function authFrame(page) {
  let frame;
  await until(async () => {
    frame = page.frames().find(candidate => candidate.url().includes('/auth-gate-frame.html'));
    return frame && await frame.locator('#classpilot-auth-pin-form').count().catch(() => false);
  }, 'The actual extension secure PIN frame did not become ready');
  return frame;
}
async function protectedState(worker) {
  return worker.evaluate(async () => {
    const stored = await chrome.storage.session.get(['studentToken', 'activeStudentId', 'activeStudentSessionId', 'studentAuthCommitPendingV1']);
    const gate = getAuthGateState();
    return { authenticated: hasStudentAuth(), authRequired: gate.authRequired, phase: gate.phase,
      anyAuthStored: Boolean(stored.studentToken || stored.activeStudentId || stored.activeStudentSessionId), commitPending: stored.studentAuthCommitPendingV1 === true };
  });
}
async function assertPageAccessBlocked(pages) {
  for (const page of pages) {
    assert.equal(await page.locator('#classpilot-auth-gate').isVisible(), true, 'The authentication gate must be visibly protecting the page');
    const button = page.locator('#underlying-action');
    await assert.rejects(button.click({ trial: true, timeout: 500 }), error => error.name === 'TimeoutError', 'The gate must intercept underlying page actions');
    // The gate may hide the host body entirely, so a protected button need not
    // have a layout box. Its fixture position after release is fixed: click
    // that location without unhiding it or forcing through the gate.
    await page.mouse.click(126, 48);
    assert.equal(await page.evaluate(() => window.underlyingClicks), 0, 'A rejected PIN must not permit underlying page interaction');
    assert.equal(await page.locator('#classpilot-auth-gate').isVisible(), true);
  }
}
try {
  cpSync(source, extension, { recursive: true });
  // Same managed-mode shim used by ClassPilot's Chrome recovery suite. The
  // worker, frame, bootstrap, content and manifest bytes remain unchanged.
  writeFileSync(join(extension, 'config.js'), `
globalThis.CLASSPILOT_SERVER_URL = ${JSON.stringify(origin)};
isExplicitUnmanagedDevelopmentServer = () => false;
isExplicitUnmanagedDevelopmentRuntime = () => false;
globalThis.__pinRetryFixture = {managedReads:0,blockedExternalFetches:0};
chrome.storage.managed.get = (_keys, callback) => {
  globalThis.__pinRetryFixture.managedReads++;
  queueMicrotask(() => callback({fastAuthGateEnabled:true,serverUrl:${JSON.stringify(origin)},schoolId:'pin-retry-fixture-school',schoolSlug:'pin-retry-fixture-school',enrollmentKey:'local-fixture-enrollment'}));
};
const fixtureNativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const value = typeof input === 'string' ? input : input.url;
  if (new URL(value).origin !== ${JSON.stringify(origin)}) {
    globalThis.__pinRetryFixture.blockedExternalFetches++;
    return Promise.reject(new Error('FIXTURE_EXTERNAL_NETWORK_DENIED'));
  }
  return fixtureNativeFetch(input, options);
};
`);
  const criticalFiles = ['manifest.json', 'service-worker.js', 'auth-gate-frame.js', 'auth-gate-frame.html', 'auth-gate-bootstrap.js', 'content.js', 'auth-gate-transport.js'];
  for (const file of criticalFiles) assert.equal(hash(readFileSync(join(extension, file))), hash(readFileSync(join(source, file))), `${file} must remain unchanged`);
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), { executablePath, headless: true, viewport: { width: 1366, height: 768 },
    args: ['--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', route => {
    const protocol = new URL(route.request().url()).protocol;
    return ['chrome-extension:', 'chrome:', 'about:', 'data:'].includes(protocol) || new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), '2.8.7');
  assert.equal(await worker.evaluate(() => isExplicitUnmanagedDevelopmentRuntime()), false);
  assert.equal(await worker.evaluate(() => isExplicitUnmanagedDevelopmentServer(CONFIG.serverUrl)), false);
  const pages = [await context.newPage(), await context.newPage()];
  await Promise.all(pages.map((page, index) => page.goto(`${origin}/classroom-${index}`, { waitUntil: 'networkidle' })));
  const frame = await authFrame(pages[0]);
  await authFrame(pages[1]);
  await frame.locator('#classpilot-auth-grade').selectOption('5');
  await until(() => frame.locator('#classpilot-auth-student option[value="fixture-student"]').count(), 'Managed roster student did not load');
  await frame.locator('#classpilot-auth-student').selectOption('fixture-student');
  assert.equal(state.attempts, 0, 'Loading multiple gates must not submit credentials');

  for (let index = 1; index <= REJECTIONS; index++) {
    await frame.locator('#classpilot-auth-pin').fill(WRONG_PIN);
    await frame.locator('#classpilot-auth-pin-submit').click();
    await until(() => state.attempts === index, 'Each explicit click must produce exactly one request');
    if (index === 1) {
      assert.equal(await frame.locator('#classpilot-auth-pin-submit').isDisabled(), true);
      await frame.evaluate(() => {
        const form = document.getElementById('classpilot-auth-pin-form');
        for (let repeat = 0; repeat < 10; repeat++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        document.getElementById('classpilot-auth-pin-submit').click();
      });
      await new Promise(done => setTimeout(done, 750));
      assert.equal(state.attempts, 1, 'Pending submissions must suppress repeated events and disabled-button clicks');
      assert.equal(state.active, 1);
      assert.equal(await pages[1].locator('#classpilot-auth-gate').count(), 1);
      assert.equal((await protectedState(worker)).authenticated, false);
      state.held(); state.held = null;
    }
    await until(async () => state.wrong === index && !(await frame.locator('#classpilot-auth-pin-submit').isDisabled()), 'A 401 must restore an actionable sign-in button');
    assert.equal(await frame.locator('#classpilot-auth-error').textContent(), REJECTION_MESSAGE);
    const protectedSnapshot = await protectedState(worker);
    assert.equal(protectedSnapshot.authenticated, false); assert.equal(protectedSnapshot.authRequired, true); assert.equal(protectedSnapshot.anyAuthStored, false);
    for (const page of pages) {
      assert.equal(await page.locator('#classpilot-auth-gate').count(), 1, 'Wrong PIN must preserve exactly one gate per tab');
      assert.equal(await page.locator('#classpilot-auth-gate').isVisible(), true, 'Rejected credentials must leave a visible gate');
    }
    if (index === 1 || index === REJECTIONS) await assertPageAccessBlocked(pages);
    assert.equal(state.attempts, index, 'A rejected request must not automatically replay');
    if (index % 10 === 0) console.log(JSON.stringify({ phase: 'explicit_wrong_pin', verified401Responses: index }));
  }

  // Wait longer than the largest 30-second recovery delay and one roster
  // refresh cycle. Polling/recovery may read state but must not resend a PIN.
  await new Promise(done => setTimeout(done, 32_000));
  assert.equal(state.attempts, REJECTIONS, 'Recovery timers must never resubmit rejected credentials');
  await frame.locator('#classpilot-auth-pin').fill(CORRECT_PIN);
  await frame.locator('#classpilot-auth-pin-submit').click();
  await until(() => state.success === 1, 'The next explicit correct PIN must reach the API');
  for (const page of pages) await page.locator('#classpilot-auth-gate').waitFor({ state: 'detached', timeout: 15_000 });
  const committed = await worker.evaluate(async () => {
    const stored = await chrome.storage.session.get(['studentToken', 'activeStudentId', 'activeStudentSessionId', 'studentAuthCommitPendingV1']);
    const gate = getAuthGateState();
    return { authenticated: hasStudentAuth(), authRequired: gate.authRequired, correctBinding: stored.studentToken === 'local-fixture-token' && stored.activeStudentId === 'fixture-student' && stored.activeStudentSessionId === 'fixture-session', commitPending: stored.studentAuthCommitPendingV1 === true, inMemoryCommitPending: studentAuthCommitPending === true };
  });
  assert.deepEqual(committed, { authenticated: true, authRequired: false, correctBinding: true, commitPending: false, inMemoryCommitPending: false });
  await pages[0].locator('#underlying-action').click();
  assert.equal(await pages[0].evaluate(() => window.underlyingClicks), 1, 'Committed authentication must restore page access');
  await new Promise(done => setTimeout(done, 1_000));
  assert.equal(state.attempts, REJECTIONS + 1); assert.equal(state.maxActive, 1); assert.equal(state.malformed, 0); assert.equal(state.otherAuthMutations, 0);
  assert.deepEqual(state.statuses, [...Array(REJECTIONS).fill(401), 200]);
  assert.deepEqual(hashes(source), sourceHashes, 'The original extension checkout must remain byte-identical');
  const shim = await worker.evaluate(() => globalThis.__pinRetryFixture);
  assert.ok(shim.managedReads > 0);
  const receipt = { schemaVersion: 1, result: 'PASS', startedAtUtc, completedAtUtc: new Date().toISOString(), extensionVersion: '2.8.7', browserVersion: context.browser()?.version() ?? null,
    manifestSha256: hash(manifestBytes), unchangedSourceFiles: sourceHashes, fixtureOnlyModifiedCopyFiles: ['config.js'], managedMode: true,
    checks: { exactRejectionMessage: REJECTION_MESSAGE, explicitWrongPinResponses: state.wrong, subsequentCorrectResponses: state.success, totalLoginRequests: state.attempts, maximumConcurrentLoginRequests: state.maxActive, duplicateSubmissionAttemptsSuppressed: 11, idleNoReplayObservedMs: 32_000, tabsProtectedThenReleased: pages.length, blockedPointerTrialsAndClicks: pages.length * 2, authCommitted: committed, configRequests: state.config, rosterRequests: state.roster, heartbeatRequests: state.heartbeat, ...shim },
    limitations: ['Uses a local synthetic API response contract; backend route/database tests separately prove removal of lockout behavior.', 'Managed storage API is simulated in Chromium; this is not managed-Chromebook hardware validation.', 'No extension application files or manifest were changed and no production endpoint or credential was used.'] };
  writeFileSync(join(evidence, 'managed-pin-retry-browser.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ result: receipt.result, extensionVersion: receipt.extensionVersion, checks: receipt.checks, evidence: join(evidence, 'managed-pin-retry-browser.json') }));
} finally {
  state.held?.(); state.held = null;
  await context?.close(); server.closeAllConnections?.();
  await new Promise(done => server.close(done));
  const target = resolve(temporary);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('schoolpilot-pin-retry-browser-'));
  rmSync(target, { recursive: true, force: true });
}
