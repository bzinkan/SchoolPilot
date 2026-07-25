#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const distIndex = path.join(projectRoot, 'dist', 'index.html');
const host = '127.0.0.1';
const port = Number(process.env.PREVIEW_SMOKE_PORT ?? '4173');
const baseUrl = `http://${host}:${port}`;
const timeoutMilliseconds = 30_000;

const personas = {
  anonymous: {
    schoolId: null,
    auth: {
      user: null,
      memberships: [],
      licenses: {},
    },
  },
  classpilotTeacher: {
    schoolId: 'preview-classpilot-school',
    auth: {
      user: {
        id: 'preview-classpilot-teacher',
        email: 'preview-classpilot-teacher@example.invalid',
        firstName: 'Preview',
        lastName: 'Teacher',
        isSuperAdmin: false,
      },
      memberships: [
        {
          id: 'preview-classpilot-membership',
          schoolId: 'preview-classpilot-school',
          schoolName: 'Preview ClassPilot School',
          schoolSlug: 'preview-classpilot-school',
          schoolTimezone: 'America/New_York',
          role: 'teacher',
        },
      ],
      licenses: {
        classPilot: true,
        passPilot: false,
        goPilot: false,
      },
    },
  },
  gopilotParent: {
    schoolId: 'preview-gopilot-school',
    auth: {
      user: {
        id: 'preview-gopilot-parent',
        email: 'preview-gopilot-parent@example.invalid',
        firstName: 'Preview Parent',
        lastName: 'User',
        isSuperAdmin: false,
      },
      memberships: [
        {
          id: 'preview-gopilot-membership',
          schoolId: 'preview-gopilot-school',
          schoolName: 'Preview GoPilot School',
          schoolSlug: 'preview-gopilot-school',
          schoolTimezone: 'America/New_York',
          dismissalTime: '15:00',
          carNumber: '42',
          role: 'parent',
          gopilotRole: 'parent',
        },
      ],
      licenses: {
        classPilot: false,
        passPilot: false,
        goPilot: true,
      },
    },
  },
};

async function assertClassPilotDashboard(page) {
  await page
    .getByRole('heading', { name: 'ClassPilot', exact: true })
    .waitFor({ state: 'visible' });
  await page
    .locator('header')
    .getByText('Teacher Dashboard', { exact: false })
    .waitFor({ state: 'visible' });
  await page.getByTestId('badge-connection-status').waitFor({ state: 'visible' });
}

const cases = [
  {
    requestedPath: '/classpilot',
    expectedPath: '/classpilot',
    persona: personas.classpilotTeacher,
    assertion: assertClassPilotDashboard,
    surface: 'licensed teacher dashboard',
  },
  {
    requestedPath: '/passpilot/kiosk',
    expectedPath: '/passpilot/kiosk',
    persona: personas.anonymous,
    assertion: async (page) => {
      await page
        .getByRole('heading', { name: 'Kiosk Setup Required', exact: true })
        .waitFor({ state: 'visible' });
      await page
        .getByText('?school=YOUR_SCHOOL_ID', { exact: true })
        .waitFor({ state: 'visible' });
    },
    surface: 'public kiosk setup guard',
  },
  {
    requestedPath: '/gopilot/parent',
    expectedPath: '/gopilot/parent',
    persona: personas.gopilotParent,
    assertion: async (page) => {
      await page
        .getByRole('heading', { name: 'Preview Parent', exact: true })
        .waitFor({ state: 'visible' });
      await page
        .getByRole('heading', { name: 'My Children', exact: true })
        .waitFor({ state: 'visible' });
      await page
        .getByText('Preview Child', { exact: true })
        .waitFor({ state: 'visible' });
    },
    surface: 'licensed parent application',
  },
  {
    requestedPath: '/preview-smoke/unknown-route',
    expectedPath: '/classpilot',
    expectCatchAllRedirect: true,
    persona: personas.classpilotTeacher,
    assertion: assertClassPilotDashboard,
    surface: 'authenticated catch-all redirect to licensed default',
  },
];

function fail(message) {
  throw new Error(`frontend_preview_smoke_failed: ${message}`);
}

function validateInputs() {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    fail('invalid preview port');
  }
  if (!existsSync(viteEntry)) fail('Vite entry point is missing');
  if (!existsSync(distIndex)) fail('dist/index.html is missing; build first');
}

function startPreview() {
  const output = [];
  const child = spawn(
    process.execPath,
    [
      viteEntry,
      'preview',
      '--host',
      host,
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  const remember = (chunk) => {
    output.push(String(chunk));
    if (output.length > 40) output.shift();
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);

  return { child, output };
}

async function waitForPreview(child, output) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(
        `preview exited before readiness with code ${child.exitCode}: ` +
          output.join('').trim().slice(-2_000)
      );
    }
    try {
      const response = await fetch(`${baseUrl}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {
      // The preview listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail('preview readiness timed out');
}

async function stopPreview(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function responseBodyFor(testCase, requestUrl) {
  const { pathname } = requestUrl;
  if (pathname === '/api/auth/me') return testCase.persona.auth;

  if (testCase.persona === personas.anonymous) {
    throw new Error('preview_api_request_not_allowlisted');
  }

  if (testCase.persona === personas.gopilotParent) {
    if (pathname === '/api/me/children') {
      return {
        children: [
          {
            id: 'preview-child',
            firstName: 'Preview',
            lastName: 'Child',
            gradeLevel: '4',
            homeroom: 'Preview Homeroom',
            dismissalType: 'car',
          },
        ],
      };
    }
    if (/^\/api\/students\/[^/]+\/pickups$/.test(pathname)) {
      return { pickups: [] };
    }
    if (/^\/api\/schools\/[^/]+\/sessions\/active$/.test(pathname)) {
      return { session: null };
    }
    if (/^\/api\/schools\/[^/]+\/settings$/.test(pathname)) {
      return {};
    }
    throw new Error('preview_api_request_not_allowlisted');
  }

  if (testCase.persona !== personas.classpilotTeacher) {
    throw new Error('preview_api_persona_invalid');
  }

  const classpilotResponses = {
    '/api/students-aggregated': { students: [] },
    '/api/settings': { settings: {} },
    '/api/flight-paths': { flightPaths: [] },
    '/api/block-lists': { blockLists: [] },
    '/api/sessions/active': { session: null },
    '/api/teacher/groups': { groups: [] },
    '/api/coverage/contexts': { contexts: [] },
    '/api/coverage/capabilities': {},
    '/api/coverage/available-students': {
      students: [],
      scheduledCoverageGroups: [],
    },
    '/api/coverage/claimed-students': { students: [] },
    '/api/coverage/reroute-targets': { targets: [] },
    '/api/classpilot/scheduled-conflicts': { conflicts: [] },
    '/api/admin/attendance': { records: [] },
  };
  if (!Object.hasOwn(classpilotResponses, pathname)) {
    throw new Error('preview_api_request_not_allowlisted');
  }
  return classpilotResponses[pathname];
}

async function verifyCase(browser, testCase) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    serviceWorkers: 'block',
  });
  await context.addInitScript((schoolId) => {
    if (schoolId) {
      window.localStorage.setItem('sp_activeSchoolId', schoolId);
    } else {
      window.localStorage.removeItem('sp_activeSchoolId');
    }
  }, testCase.persona.schoolId);
  const page = await context.newPage();
  const browserErrors = [];
  let apiFailureCode = null;

  const assertApiRequestsAllowlisted = () => {
    if (apiFailureCode) {
      fail(`${testCase.requestedPath} ${apiFailureCode}`);
    }
  };

  page.on('pageerror', (error) => {
    browserErrors.push(`pageerror:${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(`console:${message.text()}`);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      url.origin === baseUrl &&
      !url.pathname.startsWith('/api/') &&
      response.status() >= 400
    ) {
      browserErrors.push(`response:${response.status()}:${url.pathname}`);
    }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    browserErrors.push(
      `requestfailed:${url.origin === baseUrl ? url.pathname : url.origin}`
    );
  });

  await page.routeWebSocket('**/ws', (webSocket) => {
    webSocket.onMessage(() => {});
  });
  await page.route('**/api/**', async (route) => {
    try {
      const body = responseBodyFor(
        testCase,
        new URL(route.request().url())
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    } catch (error) {
      apiFailureCode =
        error instanceof Error &&
        [
          'preview_api_request_not_allowlisted',
          'preview_api_persona_invalid',
        ].includes(error.message)
          ? error.message
          : 'preview_api_stub_runtime_failure';
      await route.abort('blockedbyclient');
    }
  });
  await page.route('https://fonts.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: '',
    });
  });
  await page.route('https://fonts.gstatic.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: '',
    });
  });

  try {
    const response = await page.goto(testCase.requestedPath, {
      waitUntil: 'networkidle',
      timeout: timeoutMilliseconds,
    });
    if (!response || response.status() !== 200) {
      fail(`${testCase.requestedPath} did not return the production shell`);
    }
    assertApiRequestsAllowlisted();
    await page.waitForURL(
      (url) => url.pathname === testCase.expectedPath,
      { timeout: timeoutMilliseconds }
    );
    const finalPath = new URL(page.url()).pathname;
    const redirectedByCatchAll = finalPath !== testCase.requestedPath;
    if (redirectedByCatchAll !== (testCase.expectCatchAllRedirect === true)) {
      fail(
        `${testCase.requestedPath} ${
          testCase.expectCatchAllRedirect ? 'did not use' : 'unexpectedly used'
        } the catch-all redirect`
      );
    }
    await testCase.assertion(page);
    await page.waitForTimeout(250);
    assertApiRequestsAllowlisted();
    if (browserErrors.length > 0) {
      fail(
        `${testCase.requestedPath} emitted browser errors: ` +
          browserErrors.join(' | ').slice(0, 2_000)
      );
    }
    process.stdout.write(
      `preview_smoke_passed ${testCase.requestedPath} ` +
        `${testCase.surface}\n`
    );
  } finally {
    await context.close();
  }
}

async function main() {
  validateInputs();
  const { child, output } = startPreview();
  let browser;
  try {
    await waitForPreview(child, output);
    browser = await chromium.launch({ headless: true });
    for (const testCase of cases) {
      await verifyCase(browser, testCase);
    }
  } finally {
    await browser?.close();
    await stopPreview(child);
  }
  process.stdout.write('frontend_production_preview_smoke_passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
