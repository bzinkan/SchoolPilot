import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { teacherGuideTopics } from '../src/products/classpilot/guides/teacherGuideContent.js';
import { adminGuideTopics } from '../src/products/classpilot/guides/adminGuideContent.js';
import { apiFixture, SCHOOL_ID } from './classpilot-guide-fixtures.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEACHER_GUIDE = '/classpilot/my-settings/guide';
const ADMIN_GUIDE = '/classpilot/settings/guide';
const teacherHeading = 'Teach with a clear route from bell to wrap-up.';
const teacher = { role: 'teacher' };
const administrator = { role: 'school_admin', mailpilot: true };

async function fixture(browser, baseURL, identity = teacher) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(id => { localStorage.setItem('sp_activeSchoolId', id); if (!localStorage.getItem('sp_theme')) localStorage.setItem('sp_theme', 'light'); }, SCHOOL_ID);
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '' }));
  await context.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
  await context.routeWebSocket('**', socket => socket.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [], requests = [], unexpected = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname, search: url.search });
    if (request.method() !== 'GET') {
      unexpected.push(`Guide navigation attempted mutation: ${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, json: { error: 'Browser guide fixture forbids mutations' } });
    }
    if (identity.usageDisabled && url.pathname === '/api/classpilot/admin/usage') {
      return route.fulfill({ status: 404, json: { code: 'CLASSPILOT_USAGE_UNAVAILABLE', error: 'Not enabled' } });
    }
    const json = apiFixture(url, identity);
    if (json === undefined) {
      unexpected.push(`Missing explicit browser fixture: GET ${url.pathname}${url.search}`);
      return route.fulfill({ status: 501, json: { error: 'Unexpected guide browser request' } });
    }
    return route.fulfill({ json });
  });
  const healthy = () => { assert.deepEqual(unexpected, [], 'Every observed API read needs an explicit fixture'); assert.deepEqual(errors, [], 'No browser runtime errors'); };
  const goto = async route => { await page.goto(route, { waitUntil: 'networkidle' }); };
  return { context, page, requests, healthy, goto };
}

async function openGuide(f, path, topic = '') {
  await f.goto(`${path}${topic ? `?topic=${topic}` : ''}`);
  await f.page.getByRole('textbox', { name: 'Search the flight plan', exact: true }).waitFor();
  f.healthy();
}

function assertCurrentURL(page, destination) {
  const actual = new URL(page.url()), expected = new URL(destination, 'https://fixture.invalid');
  assert.equal(actual.pathname, expected.pathname, `CTA must render ${destination}, without a router fallback`);
  assert.deepEqual([...actual.searchParams].sort(), [...expected.searchParams].sort(), 'CTA must preserve its destination query');
}

async function assertGuideCopy(page) {
  const copy = (await page.locator('details[id^="topic-"]').allTextContents()).join(' ').toLowerCase();
  for (const term of ['live view', 'live-view', 'interactive streaming', 'camera monitoring', 'ip allowlist', 'manual device assignment', 'waypoint', 'open + focus', 'focus current tab', 'stop both']) {
    assert.ok(!copy.includes(term), `Retired user-facing guidance rendered: ${term}`);
  }
}

// Each distinct route AND query needs evidence that the real destination loaded.
// Titles are independent UI expectations; source topic titles are used only to
// find their current card, never as evidence that the CTA reached its page.
const destinations = new Map([
  ['/classpilot', async page => { await page.getByRole('heading', { name: 'ClassPilot', exact: true }).waitFor(); await page.getByTestId('button-my-settings').waitFor(); }],
  ['/classpilot/my-settings', async page => page.getByTestId('card-flight-paths').waitFor()],
  ['/classpilot/my-settings?section=websites', async page => { await page.getByRole('heading', { name: 'Website tools', exact: true }).waitFor(); await page.getByTestId('card-flight-paths').waitFor(); }],
  ['/classpilot/my-settings?section=classes', async page => { await page.getByRole('heading', { name: 'Class setup', exact: true }).waitFor(); await page.getByTestId('select-teaching-class').waitFor(); }],
  ['/classpilot/my-settings?section=appearance', async page => page.getByTestId('card-dashboard-theme').waitFor()],
  ['/classpilot/my-settings?section=defaults', async page => page.getByTestId('card-classroom-controls').waitFor()],
  ['/classpilot/my-settings/today', async page => page.getByRole('heading', { name: 'Today’s schedule', exact: true }).waitFor()],
  ['/classpilot/my-settings/schedule-changes', async page => page.getByRole('heading', { name: 'Planned time swaps', exact: true }).waitFor()],
  ['/classpilot/coverage', async page => { await page.getByRole('heading', { name: 'Supervision', exact: true }).waitFor(); assert.equal(await page.getByRole('tab', { name: 'Live now', exact: true }).getAttribute('data-state'), 'active'); }],
  ['/classpilot/admin', async page => page.getByTestId('admin-overview').waitFor()],
  ['/classpilot/admin?tab=staff', async page => page.getByRole('region', { name: 'Staff accounts', exact: true }).waitFor()],
  ['/classpilot/admin?tab=student-portal', async page => page.getByRole('region', { name: 'Student Portal & Sign-In', exact: true }).waitFor()],
  ['/classpilot/admin/scheduling?section=school-year', async page => { await page.getByLabel('School year starts', { exact: true }).waitFor(); assert.equal(await page.getByLabel('School year starts', { exact: true }).inputValue(), '2026-08-24'); }],
  ['/classpilot/admin/it-readiness', async page => { await page.getByTestId('google-workspace-policy-checklist').waitFor(); await page.getByRole('heading', { name: 'Google Workspace Roster Connector', exact: true }).waitFor(); }],
  ['/classpilot/students', async page => { await page.getByText('Current Student Roster', { exact: true }).waitFor(); await page.getByTestId('input-search-students').waitFor(); }],
  ['/classpilot/roster', async page => { await page.getByRole('heading', { name: 'Rosters', exact: true }).waitFor(); assert.equal(await page.getByTestId('tab-students').getAttribute('data-state'), 'active'); await page.getByRole('tab', { name: 'Chromebook Status', exact: true }).click(); assert.equal(await page.getByTestId('tab-extensions').getAttribute('data-state'), 'active'); }],
  ['/classpilot/admin/classes', async page => { await page.getByTestId('input-search-classes').waitFor(); await page.getByTestId('button-create-class').waitFor(); }],
  ['/classpilot/admin/classes/schedule-changes', async page => page.getByTestId('admin-schedule-needs-action').waitFor()],
  ['/classpilot/settings?section=browsing', async page => { await page.getByTestId('school-settings-workspace').waitFor(); await page.getByLabel('Maximum tabs per student', { exact: true }).waitFor(); }],
  ['/classpilot/settings?section=school', async page => { await page.getByTestId('school-settings-workspace').waitFor(); await page.getByText('School profile', { exact: true }).waitFor(); }],
  ['/classpilot/settings?section=appearance', async page => page.getByTestId('appearance-settings').waitFor()],
  ['/classpilot/coverage?entry=admin', async page => { await page.getByTestId('classpilot-admin-shell').waitFor(); assert.equal(await page.getByRole('tab', { name: 'Live now', exact: true }).getAttribute('data-state'), 'active'); await page.getByRole('tab', { name: 'Staff access', exact: true }).waitFor(); }],
  ['/classpilot/admin/analytics', async page => { await page.getByRole('heading', { name: 'Adoption & reporting health', exact: true }).waitFor(); await page.getByText('No active official classes are configured.', { exact: true }).waitFor(); }],
  ['/classpilot/admin/usage', async page => { await page.getByTestId('usage-report').waitFor(); assert.equal(await page.getByRole('combobox', { name: 'Scope', exact: true }).inputValue(), 'school'); }],
  ['/classpilot/admin/safety', async page => page.getByRole('button', { name: 'Student reports', exact: true }).waitFor()],
  ['/classpilot/admin/email-monitoring', async page => { await page.getByText('Email Monitoring is not yet enabled for your school.', { exact: false }).waitFor(); await page.getByRole('button', { name: 'Start setup', exact: true }).waitFor(); }],
]);

test('ClassPilot guides use the real app router and authorized entry points', { timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'classpilot-guide-browser-'));
  const vite = await createServer({ root: APP_ROOT, cacheDir: path.join(temporary, `vite-${process.pid}`),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  let browser;
  t.signal.addEventListener('abort', () => { void browser?.close().catch(() => {}); }, { once: true });
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    const baseURL = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    await t.test('Teaching tools Help opens the teacher guide without school writes', async () => {
      const f = await fixture(browser, baseURL);
      try {
        await f.goto('/classpilot/my-settings?section=websites');
        f.healthy();
        await f.page.getByRole('link', { name: 'Teacher guide', exact: true }).click();
        await f.page.getByRole('heading', { name: teacherHeading, exact: true }).waitFor();
        assert.equal(new URL(f.page.url()).pathname, TEACHER_GUIDE);
        f.healthy();
      } finally { await f.context.close(); }
    });
    await t.test('Admin Panel Help menu opens its guide and marks the active entry', async () => {
      const f = await fixture(browser, baseURL, administrator);
      try {
        await f.goto('/classpilot/admin');
        await f.page.getByTestId('admin-overview').waitFor();
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.getByRole('button', { name: 'Admin menu', exact: true }).click();
        await f.page.getByRole('dialog', { name: 'Admin Panel', exact: true }).getByRole('link', { name: 'Admin guide', exact: true }).click();
        await f.page.getByRole('textbox', { name: 'Search the flight plan', exact: true }).waitFor();
        assertCurrentURL(f.page, ADMIN_GUIDE);
        await f.page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(await f.page.getByRole('link', { name: 'Admin guide', exact: true }).getAttribute('aria-current'), 'page');
        f.healthy();
      } finally { await f.context.close(); }
    });
    await t.test('search, no results, topic history, focus, phone layout and theme survive real navigation', async () => {
      const f = await fixture(browser, baseURL);
      try {
        await openGuide(f, TEACHER_GUIDE);
        assert.equal(await f.page.locator('details[id^="topic-"]').count(), teacherGuideTopics.length);
        assert.equal(await f.page.locator('a[href^="/classpilot/admin"], a[href^="/classpilot/settings"]').count(), 0);
        const search = f.page.getByRole('textbox', { name: 'Search the flight plan', exact: true });
        await search.fill('signed out');
        // The router can update history before React commits the filtered view.
        // An already-visible topic cannot establish that the search rendered.
        await f.page.locator('#guide-search-results').filter({ hasText: 'matching “signed out”' }).waitFor();
        assert.equal(new URL(f.page.url()).searchParams.get('q'), 'signed out');
        await f.page.locator('#topic-waypoints-and-flight-paths').waitFor();
        assert.match(await f.page.locator('#guide-search-results').textContent(), /matching “signed out”/);
        await search.fill('no-route-should-match-this');
        await f.page.getByRole('heading', { name: 'No route matches that search', exact: true }).waitFor();
        assert.equal(await f.page.locator('details[id^="topic-"]').count(), 0);
        await f.page.getByRole('button', { name: 'Clear search', exact: true }).click();
        await f.page.locator('#guide-search-results').filter({ hasText: `${teacherGuideTopics.length} topics in this guide` }).waitFor();
        assert.equal(new URL(f.page.url()).searchParams.has('q'), false);
        const topic = teacherGuideTopics.find(item => item.id === 'open-url-and-tabs');
        await f.page.locator('aside').getByRole('button', { name: `${topic.phase} ${topic.title}`, exact: true }).click();
        assertCurrentURL(f.page, `${TEACHER_GUIDE}?topic=${topic.id}`);
        await f.page.waitForFunction(id => document.activeElement === document.querySelector(`#topic-${id} summary`), topic.id);
        await f.page.goBack();
        assertCurrentURL(f.page, TEACHER_GUIDE);
        await f.page.goForward();
        assertCurrentURL(f.page, `${TEACHER_GUIDE}?topic=${topic.id}`);
        await f.page.waitForFunction(id => document.activeElement === document.querySelector(`#topic-${id} summary`), topic.id);
        await f.page.getByTestId('button-theme-toggle').click();
        await f.page.waitForFunction(() => document.documentElement.classList.contains('dark'));
        await f.page.reload({ waitUntil: 'networkidle' });
        assert.equal(await f.page.locator('html').evaluate(node => node.classList.contains('dark')), true);
        await f.page.getByTestId('button-theme-toggle').click();
        await f.page.waitForFunction(() => document.documentElement.classList.contains('light'));
        await f.page.screenshot({ path: path.join(temporary, 'teacher-desktop.png'), fullPage: true });
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.getByLabel('Jump to a topic', { exact: true }).selectOption('coverage-workflow');
        assertCurrentURL(f.page, `${TEACHER_GUIDE}?topic=coverage-workflow`);
        await f.page.waitForFunction(() => document.activeElement === document.querySelector('#topic-coverage-workflow summary'));
        assert.equal(await f.page.locator('#topic-coverage-workflow').getAttribute('open'), '');
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Guide fits a phone viewport');
        await f.page.screenshot({ path: path.join(temporary, 'teacher-mobile.png'), fullPage: true });
        await assertGuideCopy(f.page);
        f.healthy();
      } finally { await f.context.close(); }
    });

    for (const identity of [teacher, { role: 'admin' }, administrator,
      { role: 'office_staff', roles: ['office_staff', 'teacher', 'school_admin'], mailpilot: true },
      { role: 'teacher', superAdmin: true, mailpilot: true }]) {
      const label = identity.superAdmin ? 'super administrator with an active school' : (identity.roles ? 'multi-role administrator' : identity.role);
      await t.test(`${label} has only its authorized teacher/admin guides`, async () => {
        const f = await fixture(browser, baseURL, identity);
        try {
          await openGuide(f, TEACHER_GUIDE, 'waypoints-and-flight-paths');
          await f.page.getByRole('heading', { name: teacherHeading, exact: true }).waitFor();
          await f.page.waitForFunction(() => document.activeElement === document.querySelector('#topic-waypoints-and-flight-paths summary'));
          if (identity === teacher) {
            await f.goto(ADMIN_GUIDE);
            await f.page.waitForURL(url => url.pathname === '/classpilot');
            assert.equal(await f.page.getByRole('textbox', { name: 'Search the flight plan', exact: true }).count(), 0);
          } else {
            await openGuide(f, ADMIN_GUIDE, 'student-sign-in-policy');
            await f.page.waitForFunction(() => document.activeElement === document.querySelector('#topic-student-sign-in-policy summary'));
            assert.equal(await f.page.locator('#topic-student-sign-in-policy').getAttribute('open'), '');
            assert.equal(await f.page.locator('#topic-email-monitoring').count(), identity.mailpilot ? 1 : 0);
            assert.equal(await f.page.locator('nav[aria-label="Admin navigation"] a[href="/classpilot/admin/email-monitoring"]').count(), identity.mailpilot ? 1 : 0);
            await assertGuideCopy(f.page);
          }
          f.healthy();
        } finally { await f.context.close(); }
      });
    }
    await t.test('office staff cannot open either guide by a saved URL', async () => {
      const f = await fixture(browser, baseURL, { role: 'office_staff' });
      try {
        for (const route of [TEACHER_GUIDE, ADMIN_GUIDE]) {
          await f.goto(route);
          await f.page.waitForURL(url => url.pathname === '/classpilot');
          assert.equal(await f.page.getByRole('textbox', { name: 'Search the flight plan', exact: true }).count(), 0);
        }
        f.healthy();
      } finally { await f.context.close(); }
    });
    await t.test('the new Launch connector instructions stay reachable without changing older topic links', async () => {
      const f = await fixture(browser, baseURL, administrator);
      try {
        await openGuide(f, ADMIN_GUIDE, 'workspace-roster-connector');
        const connector = f.page.locator('#topic-workspace-roster-connector');
        await connector.waitFor();
        assert.equal(await connector.getAttribute('open'), '');
        assert.match(await connector.textContent(), /Launch/);
        assert.match(await connector.textContent(), /Google Workspace Roster Connector/);
        await f.page.screenshot({ path: path.join(temporary, 'admin-desktop.png'), fullPage: true });
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.getByLabel('Jump to a topic', { exact: true }).selectOption('student-sign-in-policy');
        await f.page.waitForFunction(() => document.activeElement === document.querySelector('#topic-student-sign-in-policy summary'));
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Admin guide fits a phone viewport');
        await f.page.screenshot({ path: path.join(temporary, 'admin-mobile.png'), fullPage: true });
        f.healthy();
      } finally { await f.context.close(); }
    });

    for (const [edition, topics, identity, guidePath] of [
      ['teacher', teacherGuideTopics, teacher, TEACHER_GUIDE],
      ['administrator', adminGuideTopics, administrator, ADMIN_GUIDE],
    ]) {
      const byDestination = new Map();
      for (const topic of topics.filter(topic => topic.route)) {
        const route = new URL(topic.route, 'https://fixture.invalid');
        route.searchParams.sort();
        const key = `${route.pathname}${route.search}`;
        if (!byDestination.has(key)) byDestination.set(key, topic);
      }
      for (const [destination, topic] of byDestination) {
        await t.test(`${edition} CTA ${topic.id} reaches ${destination}`, async () => {
          const f = await fixture(browser, baseURL, identity);
          try {
            const assertDestination = destinations.get(destination);
            assert.ok(assertDestination, `New guide destination ${destination} needs a real-page assertion`);
            await openGuide(f, guidePath, topic.id);
            const card = f.page.locator(`#topic-${topic.id}`);
            await card.getByRole('heading', { name: topic.title, exact: true }).waitFor();
            await card.getByRole('link', { name: topic.routeLabel, exact: true }).click();
            await f.page.waitForURL(url => url.pathname === new URL(destination, baseURL).pathname);
            await f.page.waitForLoadState('networkidle');
            f.healthy();
            try { await assertDestination(f.page); }
            catch (error) { f.healthy(); throw error; }
            assertCurrentURL(f.page, destination);
            f.healthy();
          } finally { await f.context.close(); }
        });
      }
    }
    await t.test('a theme capability disabled by the school renders its honest destination state', async () => {
      const f = await fixture(browser, baseURL, { ...teacher, themes: false });
      try {
        const topic = teacherGuideTopics.find(topic => topic.id === 'dashboard-theme');
        await openGuide(f, TEACHER_GUIDE, topic.id);
        await f.page.locator(`#topic-${topic.id}`).getByRole('link', { name: topic.routeLabel, exact: true }).click();
        await f.page.getByTestId('dashboard-theme-disabled').waitFor();
        assertCurrentURL(f.page, '/classpilot/my-settings?section=appearance');
        f.healthy();
      } finally { await f.context.close(); }
    });
    await t.test('disabled Monitored Browser Time explains availability after the guide CTA', async () => {
      const f = await fixture(browser, baseURL, { ...administrator, usageDisabled: true });
      try {
        const topic = adminGuideTopics.find(topic => topic.id === 'monitored-browser-time');
        await openGuide(f, ADMIN_GUIDE, topic.id);
        await f.page.locator(`#topic-${topic.id}`).getByRole('link', { name: topic.routeLabel, exact: true }).click();
        await f.page.getByText('Monitored Browser Time is not turned on yet. Nothing is wrong, and no action is needed.', { exact: true }).waitFor();
        assert.equal(await f.page.getByTestId('usage-report').count(), 0);
        assertCurrentURL(f.page, '/classpilot/admin/usage');
        f.healthy();
      } finally { await f.context.close(); }
    });
  } finally {
    await browser?.close();
    await vite.close();
    await rm(path.join(temporary, `vite-${process.pid}`), { recursive: true, force: true });
    t.diagnostic(`Guide screenshots (temporary local files): ${temporary}`);
  }
});
