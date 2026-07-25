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

const cases = [
  {
    requestedPath: '/classpilot',
    expectedPath: '/',
    assertion: async (page) => {
      await page
        .getByRole('link', { name: 'Sign In', exact: true })
        .waitFor({ state: 'visible' });
    },
    surface: 'unauthenticated landing guard',
  },
  {
    requestedPath: '/passpilot/kiosk',
    expectedPath: '/passpilot/kiosk',
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
    expectedPath: '/',
    assertion: async (page) => {
      await page
        .getByRole('link', { name: 'Sign In', exact: true })
        .waitFor({ state: 'visible' });
    },
    surface: 'unauthenticated landing guard',
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

async function verifyCase(browser, testCase) {
  const context = await browser.newContext({
    baseURL: baseUrl,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const browserErrors = [];

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

  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"user":null,"memberships":[],"licenses":{}}',
    });
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
    await page.waitForURL(
      (url) => url.pathname === testCase.expectedPath,
      { timeout: timeoutMilliseconds }
    );
    await testCase.assertion(page);
    await page.waitForTimeout(250);
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
