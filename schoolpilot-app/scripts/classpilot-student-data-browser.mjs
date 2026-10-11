#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const baseURL = 'http://127.0.0.1:4178';

const MINE_SCOPE = Object.freeze({
  key: 'mine',
  kind: 'mine',
  label: 'My Classes',
  groupId: null,
  activeTeachingSessionId: null,
  isActive: false,
});
const MATH_SCOPE = Object.freeze({
  key: 'class:math',
  kind: 'class',
  label: 'Grade 5 Math',
  groupId: 'math',
  activeTeachingSessionId: 'session-math',
  isActive: true,
});
const SCIENCE_SCOPE = Object.freeze({
  key: 'class:science',
  kind: 'class',
  label: 'Grade 5 Science',
  groupId: 'science',
  activeTeachingSessionId: null,
  isActive: false,
});
const SCHOOL_SCOPE = Object.freeze({
  key: 'school',
  kind: 'school',
  label: 'Entire school',
  groupId: null,
  activeTeachingSessionId: null,
  isActive: false,
});
const INACTIVE_MATH_SCOPE = Object.freeze({
  ...MATH_SCOPE,
  activeTeachingSessionId: null,
  isActive: false,
});
const HISTORY_TODAY = '2026-10-10';
const HISTORY_THURSDAY = '2026-10-08';
const HISTORY_DENIED_DATE = '2026-10-07';
const HISTORY_EMPTY_PAGES_TEXT = 'No page details were recorded in the selected accessible dates. Include observations without page details to check for monitoring activity.';
const STUDENTS = Object.freeze([
  Object.freeze({
    studentId: 'student-a',
    name: 'Ada Student',
    monitoredSeconds: 90,
    siteCount: 1,
    topDomain: 'docs.google.com',
    domains: [{ domain: 'docs.google.com', seconds: 90 }],
    topDomains: [{ domain: 'docs.google.com', seconds: 90 }],
    topActivity: { kind: 'google_slides', domain: 'docs.google.com', seconds: 90 },
    topActivities: [{ kind: 'google_slides', domain: 'docs.google.com', seconds: 90 }],
    activities: [{ kind: 'google_slides', domain: 'docs.google.com', seconds: 90 }],
  }),
  Object.freeze({
    studentId: 'student-b',
    name: 'Grace Student',
    monitoredSeconds: 0,
    siteCount: 0,
    topDomain: null,
    domains: [],
    topDomains: [],
  }),
]);
const LARGE_STUDENTS = Object.freeze(Array.from({ length: 600 }, (_, index) => Object.freeze({
  studentId: `large-student-${String(index).padStart(3, '0')}`,
  name: `Student ${String(index).padStart(3, '0')}`,
  monitoredSeconds: index,
  siteCount: index > 0 ? 1 : 0,
  topDomain: index > 0 ? 'example.org' : null,
  domains: index > 0 ? [{ domain: 'example.org', seconds: index }] : [],
  topDomains: index > 0 ? [{ domain: 'example.org', seconds: index }] : [],
})));

function startServer() {
  return spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '4178', '--strictPort'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForServer(process) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Vite exited with ${process.exitCode}.`);
    try {
      const response = await fetch(`${baseURL}/classpilot-student-data-regression.html`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Vite did not become ready.');
}

async function stopServer(process) {
  if (!process || process.exitCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => process.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.exitCode === null) process.kill('SIGKILL');
}

function reportFor(scope, url, availableStudents = STUDENTS) {
  const studentId = url.searchParams.get('studentId');
  const students = studentId
    ? availableStudents.filter((student) => student.studentId === studentId)
    : [...availableStudents];
  const monitoredSeconds = students.reduce((sum, student) => sum + student.monitoredSeconds, 0);
  const dataState = scope.isActive ? 'live' : 'final';
  return {
    schemaVersion: 2,
    revision: `browser-${scope.key}-${url.searchParams.get('period')}-${studentId || 'all'}`,
    period: url.searchParams.get('period'),
    scope,
    dataState,
    asOf: '2026-08-28T12:00:00.000Z',
    provisionalAsOf: dataState === 'live' ? '2026-08-28T12:00:00.000Z' : null,
    monitoredSeconds,
    topDomains: monitoredSeconds > 0 ? [{ domain: 'docs.google.com', seconds: monitoredSeconds }] : [],
    ...(scope.key !== MINE_SCOPE.key && monitoredSeconds > 0
      ? {
          topActivities: [{
            kind: 'google_slides',
            domain: 'docs.google.com',
            seconds: monitoredSeconds,
          }],
        }
      : {}),
    students,
    student: studentId ? students[0] || null : null,
  };
}

async function preparePage(browser, scenario) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const requests = [];
  const historyRequests = [];
  const lookupRequests = [];
  const apiRequests = [];
  const errors = [];
  const isAdmin = ['admin', 'large-admin', 'history-admin'].includes(scenario);
  const isOffline = scenario.startsWith('history-');
  if (isOffline) {
    // UTC Sunday is still Saturday in the school's timezone, including when denied responses have no date metadata.
    await page.clock.setFixedTime(new Date('2026-10-11T01:00:00Z'));
  }
  let scienceRevoked = false;
  let mathRevoked = false;
  let scopesDenied = scenario === 'history-no-summary';
  let scopesDenialDelayMs = 0;
  let historyLookupDenied = false;
  let historyLookupDenialDelayMs = 0;
  let largeRosterShrunk = false;

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
  });

  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/auth/me', (route) => route.fulfill({
    json: {
      user: { id: isAdmin ? 'admin-browser' : 'teacher-browser' },
      activeSchoolId: 'school-browser',
      memberships: [{
        id: isAdmin ? 'admin-membership-browser' : 'teacher-membership-browser',
        schoolId: 'school-browser',
        schoolTimezone: 'America/New_York',
        role: isAdmin ? 'school_admin' : 'teacher',
      }],
      licenses: {},
    },
  }));
  await page.route(/\/api\/classpilot\/students\/browsing-history(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get('search') || '';
    const cursor = url.searchParams.get('cursor');
    lookupRequests.push({ search, cursor });
    if (historyLookupDenied) {
      if (historyLookupDenialDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, historyLookupDenialDelayMs));
      }
      await route.fulfill({ status: 403, json: { state: 'denied', error: 'Historical access revoked' } });
      return;
    }
    const allStudents = STUDENTS.map(({ studentId, name }) => ({ studentId, name }));
    const students = search
      ? allStudents.filter((student) => student.name.toLowerCase().includes(search.toLowerCase()))
      : cursor ? allStudents.slice(1) : allStudents.slice(0, 1);
    await route.fulfill({
      json: {
        students,
        nextCursor: !search && !cursor ? 'history-lookup-page2' : null,
        hasMore: !search && !cursor,
      },
    });
  });
  await page.route('**/api/classpilot/students/*/browsing-history**', async (route) => {
    const url = new URL(route.request().url());
    const studentId = decodeURIComponent(url.pathname.split('/')[4]);
    const startDate = url.searchParams.get('startDate') || HISTORY_TODAY;
    const endDate = url.searchParams.get('endDate') || HISTORY_TODAY;
    historyRequests.push({ studentId, startDate, endDate, path: url.pathname, query: url.search, view: url.searchParams.get('view') });
    if (startDate === HISTORY_DENIED_DATE || (!isAdmin && startDate === HISTORY_TODAY)) {
      await route.fulfill({ status: 403, json: { state: 'denied', code: 'HISTORY_DENIED', error: 'Historical supervision required' } });
      return;
    }
    const hasObservations = studentId === 'student-a'
      && startDate === HISTORY_THURSDAY && endDate === HISTORY_THURSDAY;
    const meta = {
      studentId,
      timeZone: 'America/New_York',
      today: HISTORY_TODAY,
      startDate,
      endDate,
      retentionDays: 30,
      partiallyExpired: false,
      scope: isAdmin ? 'school' : 'supervised_intervals',
      state: hasObservations ? 'available' : 'empty',
    };
    await route.fulfill({
      json: url.pathname.endsWith('/domains')
        ? {
            ...meta,
            days: hasObservations ? [{
              date: HISTORY_THURSDAY,
              domains: [{ domain: 'classroom.google.com', seconds: 45, contentCategory: null }],
            }] : [],
          }
        : {
            ...meta,
            entries: hasObservations ? [{
              id: `${studentId}-${HISTORY_THURSDAY}`,
              timestamp: '2026-10-08T13:00:00.123456Z',
              activeTabUrl: 'https://classroom.google.com/c/retained-lesson',
              activeTabTitle: isAdmin ? 'Ada retained school observation' : 'Ada supervised Thursday observation',
              aiCategory: 'educational',
              contentCategory: null,
              estimatedSeconds: 45,
            }] : [],
            nextCursor: null,
          },
    });
  });
  await page.route('**/api/classpilot/student-data**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/classpilot/student-data/scopes') {
      if (scopesDenied) {
        if (scopesDenialDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, scopesDenialDelayMs));
        }
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Insufficient permissions' }),
        });
        return;
      }
      const payload = isAdmin
        ? { schemaVersion: 1, defaultScopeKey: 'school', scopes: [SCHOOL_SCOPE, isOffline ? INACTIVE_MATH_SCOPE : MATH_SCOPE] }
        : scenario === 'no-classes'
          ? { schemaVersion: 1, defaultScopeKey: 'mine', scopes: [MINE_SCOPE] }
          : isOffline
            ? { schemaVersion: 1, defaultScopeKey: 'mine', scopes: [MINE_SCOPE] }
          : {
              schemaVersion: 1,
              defaultScopeKey: mathRevoked ? 'mine' : 'class:math',
              scopes: mathRevoked
                ? [MINE_SCOPE, SCIENCE_SCOPE]
                : scienceRevoked
                  ? [MINE_SCOPE, MATH_SCOPE]
                  : [MINE_SCOPE, MATH_SCOPE, SCIENCE_SCOPE],
            };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      return;
    }

    const scopeKind = url.searchParams.get('scope');
    const groupId = url.searchParams.get('groupId');
    if (scopeKind === 'class' && groupId === 'science') {
      scienceRevoked = true;
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Student Data scope not found',
          code: 'CLASSPILOT_STUDENT_DATA_SCOPE_NOT_FOUND',
        }),
      });
      return;
    }
    const scope = scopeKind === 'school'
      ? SCHOOL_SCOPE
      : scopeKind === 'mine'
        ? MINE_SCOPE
        : isOffline ? INACTIVE_MATH_SCOPE : MATH_SCOPE;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reportFor(
        scope,
        url,
        scenario === 'large-admin'
          ? largeRosterShrunk ? LARGE_STUDENTS.slice(0, 2) : LARGE_STUDENTS
          : isOffline
            ? STUDENTS.map((student) => ({
                ...student,
                monitoredSeconds: 0,
                siteCount: 0,
                topDomain: null,
                domains: [],
                topDomains: [],
                activities: [],
                topActivities: [],
                topActivity: null,
              }))
            : STUDENTS,
      )),
    });
  });

  return {
    context,
    page,
    requests,
    historyRequests,
    lookupRequests,
    apiRequests,
    errors,
    revokeMathAssignment: () => { mathRevoked = true; },
    denyScopeAccess: (delayMs = 0) => {
      scopesDenied = true;
      scopesDenialDelayMs = delayMs;
    },
    shrinkLargeRoster: () => { largeRosterShrunk = true; },
    denyHistoryLookup: (delayMs = 0) => {
      historyLookupDenied = true;
      historyLookupDenialDelayMs = delayMs;
    },
  };
}

async function teacherScenario(browser) {
  const { context, page, requests } = await preparePage(browser, 'teacher');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=teacher`, { waitUntil: 'networkidle' });
    const scopeSelect = page.getByTestId('select-student-data-scope');
    assert.equal(await scopeSelect.inputValue(), 'class:math', 'active owned class must be the teacher default');
    await page.getByTestId('student-data-state').filter({ hasText: 'Live' }).waitFor();
    assert.equal((await page.getByTestId('button-student-data-scope-root').innerText()).trim(), 'Grade 5 Math');
    await page.getByRole('heading', { name: 'Top Sites & Apps (Grade 5 Math)' }).waitFor();
    await page.getByText('Google Slides', { exact: true }).waitFor();
    await page.getByText('docs.google.com', { exact: true }).waitFor();
    assert.ok(requests.some((entry) => entry.includes('/api/classpilot/student-data?period=today&scope=class&groupId=math')));

    await page.getByTestId('button-student-data-student-student-a').click();
    await page.getByText('Ada Student', { exact: true }).last().waitFor();
    await page.getByRole('heading', { name: 'Top Sites & Apps', exact: true }).waitFor();
    assert.ok(requests.some((entry) => entry.includes('studentId=student-a')));
    await scopeSelect.selectOption('mine');
    await page.getByTestId('student-data-state').filter({ hasText: 'Final' }).waitFor();
    assert.equal((await page.getByTestId('button-student-data-scope-root').innerText()).trim(), 'My Classes');
    assert.equal(await page.getByText('Ada Student', { exact: true }).count(), 1, 'scope change must clear the selected-student breadcrumb');
    await page.getByTestId('student-data-workspace-legacy-note').waitFor();

    await page.getByTestId('button-student-data-period-week').click();
    await page.getByTestId('student-data-revision').filter({ hasText: 'browser-mine-week-all' }).waitFor();
    assert.ok(requests.some((entry) => entry.includes('period=week&scope=mine')));

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('button-export-student-data').click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const csv = await readFile(downloadPath, 'utf8');
    assert.match(csv, /"Scope","My Classes"/);
    assert.match(csv, /"Period","week"/);
    assert.match(csv, /"Data state","Final"/);
    assert.match(csv, /"As of","2026-08-28T12:00:00.000Z"/);
    assert.match(csv, /"Top site or app","Domain","Sites visited"/);
    assert.match(csv, /"Google Slides","docs.google.com","1"/);

    await scopeSelect.selectOption('class:science');
    await page.getByTestId('student-data-access-changed').waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('#student-data-scope option')]
      .some((option) => option.value === 'class:science'));
    assert.equal(await scopeSelect.inputValue(), 'class:math');
    assert.ok(requests.filter((entry) => entry.endsWith('/student-data/scopes')).length >= 2);
    assert.equal(requests.some((entry) => entry.includes('/student-analytics')), false);
  } finally {
    await context.close();
  }
}

async function noClassesScenario(browser) {
  const { context, page, requests } = await preparePage(browser, 'no-classes');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=teacher`, { waitUntil: 'networkidle' });
    await page.getByTestId('student-data-no-scopes').waitFor();
    await page.getByText('No classes are assigned to you yet', { exact: true }).waitFor();
    assert.deepEqual(
      requests.filter((entry) => !entry.endsWith('/student-data/scopes')),
      [],
      'an empty synthetic My Classes scope must not trigger an aggregate or per-student request',
    );
  } finally {
    await context.close();
  }
}

async function assignmentRevocationScenario(browser) {
  const {
    context,
    page,
    requests,
    revokeMathAssignment,
  } = await preparePage(browser, 'teacher');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=teacher`, { waitUntil: 'networkidle' });
    const scopeSelect = page.getByTestId('select-student-data-scope');
    assert.equal(await scopeSelect.inputValue(), 'class:math');

    revokeMathAssignment();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForFunction(() => ![...document.querySelectorAll('#student-data-scope option')]
      .some((option) => option.value === 'class:math'));
    assert.equal(await scopeSelect.inputValue(), 'mine');
    await page.getByTestId('student-data-revision').filter({ hasText: 'browser-mine-today-all' }).waitFor();
    assert.ok(
      requests.filter((entry) => entry.endsWith('/student-data/scopes')).length >= 2,
      'focus revalidation must refresh same-viewer authorization before the stale timer expires',
    );
  } finally {
    await context.close();
  }
}

async function scopeAccessDenialScenario(browser) {
  const {
    context,
    page,
    denyScopeAccess,
  } = await preparePage(browser, 'teacher');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=teacher`, { waitUntil: 'networkidle' });
    await page.getByTestId('button-student-data-student-student-a').waitFor();
    assert.equal(await page.getByTestId('button-export-student-data').isEnabled(), true);

    denyScopeAccess();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });

    await page.getByText('Your account is not authorized to view Student Data.', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('button-export-student-data').isDisabled(), true);
    assert.equal(
      await page.getByTestId('button-student-data-student-student-a').count(),
      0,
      'an explicit scopes denial must immediately hide cached report rows',
    );
  } finally {
    await context.close();
  }
}

async function unmountCachePurgeScenario(browser) {
  const {
    context,
    page,
    denyScopeAccess,
  } = await preparePage(browser, 'teacher');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=teacher`, { waitUntil: 'networkidle' });
    await page.getByTestId('button-student-data-student-student-a').waitFor();
    await page.getByTestId('button-close-student-data').click();
    await page.getByTestId('dialog-student-data').waitFor({ state: 'detached' });

    denyScopeAccess(500);
    await page.getByTestId('button-reopen-student-data').click();
    await page.waitForTimeout(100);
    assert.equal(
      await page.getByTestId('button-student-data-student-student-a').count(),
      0,
      'closing the dialog must purge cached private rows before a delayed reauthorization check',
    );
    await page.getByText('Your account is not authorized to view Student Data.', { exact: true }).waitFor();
  } finally {
    await context.close();
  }
}

async function adminScenario(browser) {
  const { context, page } = await preparePage(browser, 'admin');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=school_admin`, { waitUntil: 'networkidle' });
    const scopeSelect = page.getByTestId('select-student-data-scope');
    assert.equal(await scopeSelect.inputValue(), 'school', 'admins must default to Entire school');
    assert.equal((await page.getByTestId('button-student-data-scope-root').innerText()).trim(), 'Entire school');
    await page.getByTestId('student-data-state').filter({ hasText: 'Final' }).waitFor();
  } finally {
    await context.close();
  }
}

async function largeAdminScenario(browser) {
  const { context, page, shrinkLargeRoster } = await preparePage(browser, 'large-admin');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=school_admin`, { waitUntil: 'networkidle' });
    const list = page.getByTestId('student-data-student-list');
    await list.waitFor();
    assert.ok(
      await list.locator('[role="listitem"]').count() < 30,
      'a 600-student school must render only the nearby virtual rows',
    );
    const firstStudent = page.getByTestId('button-student-data-student-large-student-000');
    await firstStudent.focus();
    await firstStudent.press('End');
    const lastStudent = page.getByTestId('button-student-data-student-large-student-599');
    await lastStudent.waitFor();
    assert.equal(
      await lastStudent.evaluate((element) => document.activeElement === element),
      true,
      'keyboard navigation must reach students outside the initially rendered virtual rows',
    );

    shrinkLargeRoster();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByTestId('button-student-data-student-large-student-001').waitFor();
    assert.equal(
      await list.locator('[role="listitem"]').count(),
      2,
      'a same-scope roster shrink must clamp the virtual offset instead of flashing an empty list',
    );
    assert.equal(await list.evaluate((element) => element.scrollTop), 0);
  } finally {
    await context.close();
  }
}

async function selectHistoryDate(page, date) {
  await page.getByLabel('History start date', { exact: true }).fill(date);
  await page.getByLabel('History end date', { exact: true }).fill(date);
}

async function offlineHistoryScenario(browser, role) {
  const isAdmin = role === 'school_admin';
  const defaultHistoryText = isAdmin
    ? HISTORY_EMPTY_PAGES_TEXT
    : 'You can view browsing only during classes or supervision you actually taught.';
  const { context, page, requests, historyRequests, lookupRequests, apiRequests, errors } = await preparePage(
    browser,
    isAdmin ? 'history-admin' : 'history-teacher',
  );
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=${role}`, { waitUntil: 'networkidle' });
    if (!isAdmin) {
      await page.getByTestId('student-data-no-scopes').waitFor();
      assert.deepEqual(
        requests.filter((entry) => !entry.endsWith('/student-data/scopes')),
        [],
        'a teacher with no current classes must not need an aggregate report to open retained history',
      );
    }
    await page.getByRole('tab', { name: 'Browsing history', exact: true }).click();
    await page.getByTestId('button-history-student-student-a').waitFor();
    assert.equal(historyRequests.length, 0, 'student lookup must not fetch browsing until a student is chosen');

    await page.getByRole('button', { name: 'Load more students', exact: true }).click();
    await page.getByTestId('button-history-student-student-b').waitFor();
    assert.ok(lookupRequests.some((request) => request.cursor === 'history-lookup-page2'), 'lookup must follow server pagination');

    await page.getByTestId('button-history-student-student-a').click();
    await page.getByText(defaultHistoryText, { exact: true }).last().waitFor();
    assert.equal(await page.getByLabel('History start date').inputValue(), HISTORY_TODAY);
    assert.equal(await page.getByLabel('History end date').inputValue(), HISTORY_TODAY);

    await selectHistoryDate(page, HISTORY_THURSDAY);
    const observationTitle = isAdmin ? 'Ada retained school observation' : 'Ada supervised Thursday observation';
    await page.getByText(observationTitle, { exact: true }).waitFor();
    assert.equal(await page.getByTestId('history-observation').count(), 1);
    const historyText = await page.getByTestId('student-browsing-history').innerText();
    assert.match(historyText, /America\/New_York/);
    assert.equal(historyText.includes('Only your supervised intervals are included.'), !isAdmin);
    assert.ok(historyRequests.some((request) => (
      request.studentId === 'student-a'
      && request.startDate === HISTORY_THURSDAY
      && request.endDate === HISTORY_THURSDAY
      && !request.path.endsWith('/domains')
      && request.view === 'pages'
    )), 'offline history must query the selected student and inclusive school-local date');
    const artifacts = path.join(root, 'artifacts', 'classpilot-roadmap');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: path.join(artifacts, `student-data-offline-browsing-${role}.png`),
      fullPage: true,
    });
    if (!isAdmin) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(artifacts, 'student-data-offline-browsing-mobile.png'),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Choose another student', exact: true }).click();
      await page.screenshot({
        path: path.join(artifacts, 'student-data-history-lookup-mobile.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: path.join(artifacts, 'student-data-history-lookup-desktop.png'),
        fullPage: true,
      });
      await page.getByTestId('button-history-student-student-a').click();
      await page.getByLabel('History start date').waitFor();
      await selectHistoryDate(page, HISTORY_THURSDAY);
      await page.getByText(observationTitle, { exact: true }).waitFor();
    }

    if (!isAdmin) {
      await selectHistoryDate(page, HISTORY_DENIED_DATE);
      await page.getByText('You can view browsing only during classes or supervision you actually taught.', { exact: true }).last().waitFor();
      assert.equal(await page.getByTestId('history-observation').count(), 0, 'denied dates must hide previously loaded observations');
      assert.equal(await page.getByText(observationTitle, { exact: true }).count(), 0);
    }

    await page.getByRole('tab', { name: 'Summary', exact: true }).click();
    assert.equal(await page.getByTestId('student-browsing-history').count(), 0, 'returning to Summary must unmount the private history view');
    await page.getByRole('tab', { name: 'Browsing history', exact: true }).click();
    const chooseAnother = page.getByRole('button', { name: 'Choose another student', exact: true });
    if (await chooseAnother.count()) await chooseAnother.click();
    await page.getByLabel('Search students for browsing history', { exact: true }).fill('Grace');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByTestId('button-history-student-student-b').waitFor();
    assert.equal(await page.getByTestId('button-history-student-student-a').count(), 0, 'search must replace earlier lookup rows');
    await page.getByTestId('button-history-student-student-b').click();
    await page.getByText(defaultHistoryText, { exact: true }).last().waitFor();
    await selectHistoryDate(page, HISTORY_THURSDAY);
    await page.getByText(HISTORY_EMPTY_PAGES_TEXT, { exact: true }).waitFor();
    assert.equal(await page.getByText(observationTitle, { exact: true }).count(), 0, 'a different student must never display the earlier student’s history');
    assert.equal(await page.getByTestId('history-observation').count(), 0);
    assert.ok(lookupRequests.some((request) => request.search === 'Grace'));
    assert.equal(
      apiRequests.some((request) => /\/(?:devices|teaching-sessions|commands|student-analytics)(?:[/?]|$)/.test(request)),
      false,
      'offline history lookup must not depend on devices, an active teaching session, or legacy analytics',
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function historyWithoutSummaryAccessScenario(browser) {
  const { context, page, historyRequests, errors } = await preparePage(browser, 'history-no-summary');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=teacher`, { waitUntil: 'networkidle' });
    await page.getByText('Your account is not authorized to view Student Data.', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Browsing history', exact: true }).click();
    await page.getByTestId('button-history-student-student-a').click();
    await page.getByLabel('History start date').waitFor();
    await selectHistoryDate(page, HISTORY_THURSDAY);
    await page.getByText('Ada supervised Thursday observation', { exact: true }).waitFor();
    assert.ok(historyRequests.some((request) => request.startDate === HISTORY_THURSDAY && request.endDate === HISTORY_THURSDAY));
    assert.deepEqual(errors, [], 'retained historical authority must work independently of current aggregate access');
  } finally {
    await context.close();
  }
}

async function historyLookupRevocationScenario(browser) {
  const { context, page, denyHistoryLookup, errors } = await preparePage(browser, 'history-teacher');
  try {
    await page.goto(`${baseURL}/classpilot-student-data-regression.html?role=teacher`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Browsing history', exact: true }).click();
    await page.getByTestId('button-history-student-student-a').click();
    await page.getByLabel('History start date').waitFor();
    await selectHistoryDate(page, HISTORY_THURSDAY);
    await page.getByText('Ada supervised Thursday observation', { exact: true }).waitFor();

    denyHistoryLookup();
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await page.getByText('Your account is not authorized to look up browsing history.', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('history-observation').count(), 0, 'lookup access revocation must hide a selected student’s loaded history');
    assert.equal(await page.getByTestId('button-history-student-student-a').count(), 0, 'lookup denial must hide cached private student rows');

    await page.getByTestId('button-close-student-data').click();
    await page.getByTestId('dialog-student-data').waitFor({ state: 'detached' });
    denyHistoryLookup(500);
    await page.getByTestId('button-reopen-student-data').click();
    await page.getByRole('tab', { name: 'Browsing history', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId('button-history-student-student-a').count(), 0, 'reopening must not flash cached lookup rows during delayed authorization');
    assert.equal(await page.getByTestId('history-observation').count(), 0, 'reopening must not flash cached observations during delayed authorization');
    await page.getByText('Your account is not authorized to look up browsing history.', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

const server = startServer();
let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch({ headless: true });
  await teacherScenario(browser);
  await noClassesScenario(browser);
  await assignmentRevocationScenario(browser);
  await scopeAccessDenialScenario(browser);
  await unmountCachePurgeScenario(browser);
  await adminScenario(browser);
  await largeAdminScenario(browser);
  await offlineHistoryScenario(browser, 'teacher');
  await offlineHistoryScenario(browser, 'school_admin');
  await historyWithoutSummaryAccessScenario(browser);
  await historyLookupRevocationScenario(browser);
  console.log('ClassPilot Student Data browser checks passed, including offline browsing lookup and historical access.');
} finally {
  await browser?.close();
  await stopServer(server);
}
