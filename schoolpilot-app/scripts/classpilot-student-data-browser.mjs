#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
const STUDENTS = Object.freeze([
  Object.freeze({
    studentId: 'student-a',
    name: 'Ada Student',
    monitoredSeconds: 90,
    siteCount: 1,
    topDomain: 'example.org',
    domains: [{ domain: 'example.org', seconds: 90 }],
    topDomains: [{ domain: 'example.org', seconds: 90 }],
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
  const dataState = scope.key === MATH_SCOPE.key ? 'live' : 'final';
  return {
    schemaVersion: 1,
    revision: `browser-${scope.key}-${url.searchParams.get('period')}-${studentId || 'all'}`,
    period: url.searchParams.get('period'),
    scope,
    dataState,
    asOf: '2026-08-28T12:00:00.000Z',
    provisionalAsOf: dataState === 'live' ? '2026-08-28T12:00:00.000Z' : null,
    monitoredSeconds,
    topDomains: monitoredSeconds > 0 ? [{ domain: 'example.org', seconds: monitoredSeconds }] : [],
    students,
    student: studentId ? students[0] || null : null,
  };
}

async function preparePage(browser, scenario) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const requests = [];
  let scienceRevoked = false;
  let mathRevoked = false;
  let scopesDenied = false;
  let scopesDenialDelayMs = 0;
  let largeRosterShrunk = false;

  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
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
      const payload = scenario === 'admin' || scenario === 'large-admin'
        ? { schemaVersion: 1, defaultScopeKey: 'school', scopes: [SCHOOL_SCOPE, MATH_SCOPE] }
        : scenario === 'no-classes'
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
        : MATH_SCOPE;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(reportFor(
        scope,
        url,
        scenario === 'large-admin'
          ? largeRosterShrunk ? LARGE_STUDENTS.slice(0, 2) : LARGE_STUDENTS
          : STUDENTS,
      )),
    });
  });

  return {
    context,
    page,
    requests,
    revokeMathAssignment: () => { mathRevoked = true; },
    denyScopeAccess: (delayMs = 0) => {
      scopesDenied = true;
      scopesDenialDelayMs = delayMs;
    },
    shrinkLargeRoster: () => { largeRosterShrunk = true; },
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
    assert.ok(requests.some((entry) => entry.includes('/api/classpilot/student-data?period=today&scope=class&groupId=math')));

    await page.getByTestId('button-student-data-student-student-a').click();
    await page.getByText('Ada Student', { exact: true }).last().waitFor();
    assert.ok(requests.some((entry) => entry.includes('studentId=student-a')));
    await scopeSelect.selectOption('mine');
    await page.getByTestId('student-data-state').filter({ hasText: 'Final' }).waitFor();
    assert.equal((await page.getByTestId('button-student-data-scope-root').innerText()).trim(), 'My Classes');
    assert.equal(await page.getByText('Ada Student', { exact: true }).count(), 1, 'scope change must clear the selected-student breadcrumb');

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
  console.log('ClassPilot teacher-scoped Student Data browser checks passed.');
} finally {
  await browser?.close();
  await stopServer(server);
}
