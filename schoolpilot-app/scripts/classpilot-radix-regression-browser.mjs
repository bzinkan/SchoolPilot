#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const baseURL = 'http://127.0.0.1:4177';

function startServer() {
  return spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '4177', '--strictPort'], {
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
      const response = await fetch(`${baseURL}/classpilot-radix-regression.html`);
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

const server = startServer();
let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(`${baseURL}/classpilot-radix-regression.html`, { waitUntil: 'networkidle' });
  for (let expected = 1; expected <= 8; expected += 1) {
    await page.getByTestId('open-url-dialog').click();
    await page.getByTestId('open-url-dialog-content').waitFor();
    await page.getByTestId('confirm-open-url').click();
    await page.getByTestId('open-url-dialog-content').waitFor({ state: 'hidden' });
    await page.getByTestId('delivery-toast').waitFor();
    await page.getByTestId('ack-count').filter({ hasText: `Acknowledgements: ${expected}` }).waitFor();
    assert.equal(await page.getByTestId('dashboard-sentinel').isVisible(), true, 'dashboard must remain visible after the ACK closes the dialog');
  }
  await page.waitForTimeout(300);
  const refLoopErrors = [...pageErrors, ...consoleErrors].filter((message) => /maximum update depth|composeRefs|setRef/i.test(message));
  assert.deepEqual(refLoopErrors, [], `Radix/React ref loop detected: ${refLoopErrors.join('\n')}`);

  await page.getByTestId('trigger-boundary').click();
  await page.getByTestId('runtime-error-fallback').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reload dashboard' }).isVisible(), true);
  assert.equal(await page.getByRole('link', { name: 'Go to sign in' }).getAttribute('href'), '/login');
  console.log('ClassPilot Radix dialog/ACK and runtime boundary browser regression passed.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
