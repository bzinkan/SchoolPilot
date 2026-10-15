import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertExternalPaths, loadExternalConfig, preparePrivateOutputDirectory } from './load/prepare-classpilot-load-test.mjs';
import { hasLoadSessionCookie } from './load/session-cookie.mjs';
import { renderedDeadline } from './load/run-classpilot-rendered-dashboards.mjs';

const STAGING_ORIGIN = 'https://staging.school-pilot.net';
const STAGING_COOKIE = 'schoolpilot.staging.sid';
const PRODUCTION_COOKIE = 'schoolpilot.sid';
const SYNTHETIC_PRODUCTION_VALUE = 'synthetic-invalid-production-cookie-isolation-probe';

export async function bootstrapCookieIsolationProbe(page) {
  // API JSON documents deliberately use default-src 'none'. Run browser
  // fetches from the real frontend document, without executing its scripts.
  const bootstrap = await page.goto(STAGING_ORIGIN + '/classpilot', { waitUntil: 'domcontentloaded', timeout: 8000 });
  assert.equal(bootstrap.status(), 200);
  return renderedDeadline(page.evaluate(async () => (await fetch('/api/auth/me', { redirect: 'error' })).status));
}

export function unusedCookieIsolationActor(source, selected) {
  assert.equal(source.schemaVersion, 2);
  assert.equal(selected.schemaVersion, 2);
  assert.equal(source.baseUrl, STAGING_ORIGIN);
  assert.equal(selected.baseUrl, STAGING_ORIGIN);
  assert.equal(source.schoolId, selected.schoolId);
  assert.ok(typeof source.schoolId === 'string' && source.schoolId);
  assert.equal(source.teacherAuth?.length, 20, 'Full governed fixture required');
  assert.equal(selected.teacherAuth?.length, 1, 'Only the selected40-device campaign may supply this proof');
  const active = selected.teacherAuth[0];
  assert.equal(active.studentIds?.length, 40);
  const activeSource = source.teacherAuth.find(actor => actor.teacherId === active.teacherId);
  assert.ok(activeSource && activeSource.teacherCookie === active.teacherCookie, 'Source and selected campaign must share exact current credentials');
  assert.equal(new Set(source.teacherAuth.map(actor => actor.teacherId)).size, 20);
  const actor = source.teacherAuth.find(candidate => candidate.teacherId !== active.teacherId);
  assert.ok(actor && actor.role === 'teacher' && actor.schoolId === source.schoolId && typeof actor.teacherId === 'string');
  assert.ok(hasLoadSessionCookie(actor.teacherCookie, STAGING_COOKIE));
  assert.ok(typeof actor.csrfToken === 'string' && actor.csrfToken.length >= 16);
  assert.ok(Date.parse(actor.expiresAt) > Date.now() + 60_000);
  return actor;
}

export function assertStagingIssuedCookie(headers, logout = false) {
  const cookies = headers.filter(header => header.name.toLowerCase() === 'set-cookie').map(header => header.value);
  assert.ok(!cookies.some(value => value.startsWith(PRODUCTION_COOKIE + '=')), 'Staging must never set or clear the production cookie');
  const stage = cookies.filter(value => value.startsWith(STAGING_COOKIE + '='));
  assert.equal(stage.length, 1, 'Exactly one staging session cookie must be issued');
  assert.doesNotMatch(stage[0], /(?:^|;)\s*Domain=/i);
  assert.match(stage[0], /;\s*Path=\/(?:;|$)/i);
  assert.match(stage[0], /;\s*Secure(?:;|$)/i);
  assert.match(stage[0], /;\s*HttpOnly(?:;|$)/i);
  assert.match(stage[0], /;\s*SameSite=Lax(?:;|$)/i);
  if (logout) assert.match(stage[0], /^schoolpilot\.staging\.sid=;.*;\s*Expires=Thu, 01 Jan 1970/i);
  else assert.match(stage[0], /^schoolpilot\.staging\.sid=[^;\s]+;/);
}

export async function checkStagingCookieIsolation(arguments_ = process.argv.slice(2)) {
  const { values } = parseArgs({ args: arguments_, options: {
    config: { type: 'string' }, 'source-auth': { type: 'string' }, 'selected-auth': { type: 'string' },
    output: { type: 'string' }, 'chrome-path': { type: 'string' }, 'dry-run': { type: 'boolean' },
    'consume-unused-fixture-session': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return console.log('Usage: node scripts/check-classpilot-staging-cookie-isolation.mjs --config <private40-device-config> --source-auth <full-private-auth> --selected-auth <selected-private-auth> --output <fresh-private-dir> --consume-unused-fixture-session [--chrome-path <Chrome>] [--dry-run]. Uses an unused teacher session, performs no login, and contacts staging only.');
  assert.ok(values.config && values['source-auth'] && values['selected-auth'] && values.output && values['consume-unused-fixture-session']);
  const paths = assertExternalPaths(values.config, values.output);
  for (const path of [values['source-auth'], values['selected-auth']]) assertExternalPaths(values.config, dirname(resolve(path)));
  const config = loadExternalConfig(paths.configPath);
  assert.equal(config.syntheticStaging, true);
  assert.equal(config.reliabilityDeviceCount, 40);
  assert.equal(config.baseUrl, STAGING_ORIGIN);
  const source = JSON.parse(readFileSync(values['source-auth'], 'utf8'));
  const selected = JSON.parse(readFileSync(values['selected-auth'], 'utf8'));
  const actor = unusedCookieIsolationActor(source, selected);
  if (values['dry-run']) return console.log(JSON.stringify({ operation: 'staging-cookie-isolation-preflight',
    unusedTeacherSession: true, loginRequests: 0, productionRequests: 0, nativeBrowserValidated: false }));
  preparePrivateOutputDirectory(paths.outputPath);
  const output = join(paths.outputPath, 'cookie-isolation-summary.json');
  assert.equal(existsSync(output), false, 'Fresh cookie proof required');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { chromium } = createRequire(join(root, 'schoolpilot-app/package.json'))('playwright');
  const executablePath = values['chrome-path'] || process.env.CLASSPILOT_CHROME_PATH || chromium.executablePath();
  assert.ok(existsSync(executablePath));
  const browser = await chromium.launch({ executablePath, headless: true });
  const summary = { schemaVersion: 1, operation: 'staging-cookie-isolation', checkedAt: new Date().toISOString(),
    browser: browser.version(), loginRequests: 0, productionRequests: 0, requests: 0, bootstrapRequests: 0, phase: 'bootstrap',
    unusedTeacherSession: true, syntheticProductionCookieIgnored: false, mixedIdentityAuthenticated: false,
    stagingIssuedHostOnlyCookie: false, stagingLogoutClearsOnlyStaging: false,
    syntheticProductionCookieRetained: false, postLogoutUnauthorized: false, nativeBrowserValidated: false };
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(8000);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== STAGING_ORIGIN) return route.abort();
      if (url.pathname === '/classpilot' && route.request().method() === 'GET') {
        summary.bootstrapRequests += 1;
        return route.continue();
      }
      if (!['/api/auth/me', '/api/auth/logout'].includes(url.pathname)) return route.abort();
      summary.requests += 1;
      return route.continue();
    });
    await context.addCookies([{ name: PRODUCTION_COOKIE, value: SYNTHETIC_PRODUCTION_VALUE,
      domain: '.school-pilot.net', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    summary.phase = 'synthetic-production-cookie';
    const fakeOnly = await bootstrapCookieIsolationProbe(page);
    assert.equal(fakeOnly, 401);
    summary.syntheticProductionCookieIgnored = true;
    const pair = actor.teacherCookie.split(';').map(value => value.trim()).find(value => value.startsWith(STAGING_COOKIE + '='));
    await context.addCookies([{ name: STAGING_COOKIE, value: pair.slice(STAGING_COOKIE.length + 1),
      url: STAGING_ORIGIN, secure: true, httpOnly: true, sameSite: 'Lax' }]);
    summary.phase = 'mixed-cookie-identity';
    const [identityResponse, identity] = await renderedDeadline(Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/me'),
      page.evaluate(async schoolId => {
      const response = await fetch('/api/auth/me', { headers: { 'X-School-Id': schoolId }, redirect: 'error' });
      const body = await response.json();
      return { status: response.status, userId: body.user?.id, schoolId: body.activeSchoolId, role: body.primaryRole };
      }, actor.schoolId),
    ]));
    assert.deepEqual(identity, { status: 200, userId: actor.teacherId, schoolId: actor.schoolId, role: 'teacher' });
    assertStagingIssuedCookie(await renderedDeadline(identityResponse.headersArray()));
    summary.mixedIdentityAuthenticated = true;
    summary.stagingIssuedHostOnlyCookie = true;
    summary.phase = 'staging-logout';
    const [logoutResponse, logoutStatus] = await renderedDeadline(Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout'),
      page.evaluate(async csrfToken => {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, redirect: 'error' });
      await response.text();
      return response.status;
      }, actor.csrfToken),
    ]));
    assert.equal(logoutStatus, 200);
    assertStagingIssuedCookie(await renderedDeadline(logoutResponse.headersArray()), true);
    summary.stagingLogoutClearsOnlyStaging = true;
    const cookies = await context.cookies(STAGING_ORIGIN);
    assert.equal(cookies.some(cookie => cookie.name === STAGING_COOKIE), false);
    const fake = cookies.filter(cookie => cookie.name === PRODUCTION_COOKIE);
    assert.equal(fake.length, 1);
    assert.equal(fake[0].value, SYNTHETIC_PRODUCTION_VALUE);
    assert.equal(fake[0].domain, '.school-pilot.net');
    summary.syntheticProductionCookieRetained = true;
    summary.phase = 'post-logout';
    assert.equal(await renderedDeadline(page.evaluate(async () => (await fetch('/api/auth/me', { redirect: 'error' })).status)), 401);
    summary.postLogoutUnauthorized = true;
    assert.equal(summary.requests, 4);
    assert.equal(summary.bootstrapRequests, 1);
    summary.nativeBrowserValidated = true;
    summary.phase = 'completed';
  } finally {
    writeFileSync(output, JSON.stringify(summary, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkStagingCookieIsolation().catch(() => {
    console.error('[staging-cookie-isolation] Refused or failed; private credentials and response details omitted');
    process.exitCode = 1;
  });
}
