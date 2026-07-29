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
export const baseUrl = `http://${host}:${port}`;
const timeoutMilliseconds = 30_000;

export const personas = {
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
    childId: 'preview-child',
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
    requestedPath: '/',
    expectedPath: '/',
    persona: personas.anonymous,
    assertion: async (page) => {
      await page
        .getByRole('heading', {
          name: 'School management tools that work together',
          exact: true,
        })
        .waitFor({ state: 'visible' });
    },
    expectedCanonical: 'https://school-pilot.net/',
    expectedRobots: 'index, follow',
    expectedTitle: 'Schoolpilot | Student Safety and School Operations',
    surface: 'public indexable homepage',
  },
  {
    requestedPath: '/privacy',
    expectedPath: '/privacy',
    persona: personas.anonymous,
    assertion: async (page) => {
      await page
        .getByRole('heading', { name: 'Privacy Policy', exact: true })
        .waitFor({ state: 'visible' });
    },
    expectedCanonical: 'https://school-pilot.net/privacy',
    expectedRobots: 'index, follow',
    expectedTitle: 'Privacy Policy | Schoolpilot',
    surface: 'public indexable privacy policy',
  },
  {
    requestedPath: '/classpilot',
    expectedPath: '/classpilot',
    persona: personas.classpilotTeacher,
    assertion: assertClassPilotDashboard,
    expectedCanonical: null,
    expectedRobots: 'noindex, nofollow',
    expectedTitle: 'Schoolpilot',
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
    expectedCanonical: null,
    expectedRobots: 'noindex, nofollow',
    expectedTitle: 'Schoolpilot',
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
    expectedCanonical: null,
    expectedRobots: 'noindex, nofollow',
    expectedTitle: 'Schoolpilot',
    surface: 'licensed parent application',
  },
  {
    requestedPath: '/preview-smoke/unknown-route',
    expectedPath: '/classpilot',
    expectCatchAllRedirect: true,
    persona: personas.classpilotTeacher,
    assertion: assertClassPilotDashboard,
    expectedCanonical: null,
    expectedRobots: 'noindex, nofollow',
    expectedTitle: 'Schoolpilot',
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

function apiFailure(code) {
  throw new Error(code);
}

function requestHeaders(request) {
  return Object.fromEntries(
    Object.entries(request.headers()).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ])
  );
}

function assertExactQuery(requestUrl, expectedEntries) {
  const actualEntries = [...requestUrl.searchParams.entries()].sort();
  const normalizedExpected = [...expectedEntries].sort();
  if (
    actualEntries.length !== normalizedExpected.length ||
    actualEntries.some(
      ([name, value], index) =>
        name !== normalizedExpected[index][0] ||
        value !== normalizedExpected[index][1]
    )
  ) {
    apiFailure('preview_api_query_invalid');
  }
}

function dateInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function validateApiRequestEnvelope(testCase, request, requestUrl) {
  if (requestUrl.origin !== baseUrl) {
    apiFailure('preview_api_origin_invalid');
  }
  if (request.method() !== 'GET') {
    apiFailure('preview_api_method_invalid');
  }

  const actualSchoolId = requestHeaders(request)['x-school-id'];
  const expectedSchoolId = testCase.persona.schoolId;
  if (
    (expectedSchoolId === null && actualSchoolId !== undefined) ||
    (expectedSchoolId !== null && actualSchoolId !== expectedSchoolId)
  ) {
    apiFailure('preview_api_school_binding_invalid');
  }
}

export function responseBodyFor(
  testCase,
  request,
  { now = new Date() } = {}
) {
  const requestUrl = new URL(request.url());
  const { pathname } = requestUrl;
  validateApiRequestEnvelope(testCase, request, requestUrl);

  const noQuery = () => assertExactQuery(requestUrl, []);
  if (pathname === '/api/auth/me') {
    noQuery();
    return testCase.persona.auth;
  }

  if (testCase.persona === personas.anonymous) {
    apiFailure('preview_api_request_not_allowlisted');
  }

  if (testCase.persona === personas.gopilotParent) {
    if (pathname === '/api/me/children') {
      noQuery();
      return {
        children: [
          {
            id: testCase.persona.childId,
            firstName: 'Preview',
            lastName: 'Child',
            gradeLevel: '4',
            homeroom: 'Preview Homeroom',
            dismissalType: 'car',
          },
        ],
      };
    }
    if (pathname === `/api/students/${testCase.persona.childId}/pickups`) {
      noQuery();
      return { pickups: [] };
    }
    if (
      pathname ===
      `/api/schools/${testCase.persona.schoolId}/sessions/active`
    ) {
      noQuery();
      return { session: null };
    }
    if (
      pathname === `/api/schools/${testCase.persona.schoolId}/settings`
    ) {
      noQuery();
      return {};
    }
    if (
      /^\/api\/students\/[^/]+\/pickups$/.test(pathname) ||
      /^\/api\/schools\/[^/]+\/(?:sessions\/active|settings)$/.test(pathname)
    ) {
      apiFailure('preview_api_resource_binding_invalid');
    }
    apiFailure('preview_api_request_not_allowlisted');
  }

  if (testCase.persona !== personas.classpilotTeacher) {
    apiFailure('preview_api_persona_invalid');
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
    apiFailure('preview_api_request_not_allowlisted');
  }
  if (pathname === '/api/admin/attendance') {
    assertExactQuery(requestUrl, [
      [
        'date',
        dateInTimezone(
          now,
          testCase.persona.auth.memberships[0].schoolTimezone
        ),
      ],
    ]);
  } else {
    noQuery();
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
      `requestfailed:${url.origin === baseUrl ? url.pathname : 'cross-origin'}`
    );
  });

  await page.routeWebSocket('**/ws', (webSocket) => {
    webSocket.onMessage(() => {});
  });
  await page.route('**/api/**', async (route) => {
    try {
      const body = responseBodyFor(testCase, route.request());
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
          'preview_api_origin_invalid',
          'preview_api_method_invalid',
          'preview_api_school_binding_invalid',
          'preview_api_resource_binding_invalid',
          'preview_api_query_invalid',
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
    const canonical = page.locator('link[rel="canonical"]');
    const canonicalCount = await canonical.count();
    if (testCase.expectedCanonical === null) {
      if (canonicalCount !== 0) {
        fail(`${testCase.requestedPath} unexpectedly exposes a canonical URL`);
      }
    } else {
      const canonicalHref = await canonical.getAttribute('href');
      if (
        canonicalCount !== 1 ||
        canonicalHref !== testCase.expectedCanonical
      ) {
        fail(
          `${testCase.requestedPath} canonical mismatch: ${canonicalHref}`
        );
      }
    }
    const robots = await page
      .locator('meta[name="robots"]')
      .getAttribute('content');
    if (robots !== testCase.expectedRobots) {
      fail(`${testCase.requestedPath} robots mismatch: ${robots}`);
    }
    const title = await page.title();
    if (title !== testCase.expectedTitle) {
      fail(`${testCase.requestedPath} title mismatch: ${title}`);
    }
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

const isDirectExecution =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
