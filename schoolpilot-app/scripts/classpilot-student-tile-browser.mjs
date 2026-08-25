#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const baseURL = 'http://127.0.0.1:4179';

function startServer() {
  return spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '4179', '--strictPort'], {
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
      const response = await fetch(`${baseURL}/classpilot-student-tile-regression.html`);
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
  const page = await browser.newPage({ locale: 'en-US', timezoneId: 'UTC' });
  await page.clock.install({ time: new Date('2026-08-24T11:59:50.000Z') });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${baseURL}/classpilot-student-tile-regression.html`, { waitUntil: 'networkidle' });
  await page.clock.pauseAt(new Date('2026-08-24T12:00:00.000Z'));
  await page.evaluate(() => {
    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const nativeSetInterval = globalThis.setInterval.bind(globalThis);
    const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
    const minuteTimeouts = new Set();
    const minuteIntervals = new Set();

    globalThis.setTimeout = (callback, delay, ...args) => {
      let timerId;
      const wrapped = (...callbackArgs) => {
        minuteTimeouts.delete(timerId);
        callback(...callbackArgs);
      };
      timerId = nativeSetTimeout(wrapped, delay, ...args);
      if (Number(delay) === 60_000) minuteTimeouts.add(timerId);
      return timerId;
    };
    globalThis.clearTimeout = (timerId) => {
      minuteTimeouts.delete(timerId);
      return nativeClearTimeout(timerId);
    };
    globalThis.setInterval = (callback, delay, ...args) => {
      const timerId = nativeSetInterval(callback, delay, ...args);
      if (Number(delay) === 60_000) minuteIntervals.add(timerId);
      return timerId;
    };
    globalThis.clearInterval = (timerId) => {
      minuteIntervals.delete(timerId);
      return nativeClearInterval(timerId);
    };
    globalThis.__studentTileMinuteTimers = () => ({
      timeouts: minuteTimeouts.size,
      intervals: minuteIntervals.size,
    });
  });
  await page.getByTestId('toggle-tiles').click();

  const signedOutTile = page.getByTestId('card-student-signed-out-student');
  assert.equal(
    await signedOutTile.getByText('Not logged in', { exact: true }).count(),
    1,
    'signed-out truth must be rendered exactly once',
  );
  assert.equal(
    await signedOutTile.getByText('Preview unavailable', { exact: true }).count(),
    0,
    'the tile must not render a redundant preview-unavailable heading',
  );
  assert.equal(
    await signedOutTile.getByText(/Controls:/).count(),
    0,
    'device-control health must not appear in the teacher tile',
  );
  assert.equal(
    await page.getByTestId('text-unavailable-status-signed-out-student').evaluate(
      (element) => getComputedStyle(element).textAlign,
    ),
    'center',
    'the unavailable-state truth must remain centered in the preview',
  );
  await signedOutTile.getByText('Last seen just now', { exact: true }).waitFor();
  assert.deepEqual(
    await page.evaluate(() => globalThis.__studentTileMinuteTimers()),
    { timeouts: 1, intervals: 0 },
    'all relative labels must share one minute-boundary timer',
  );
  const rendersBeforeMinuteTick = await page.getByTestId('parent-renders').textContent();
  await page.clock.runFor(61_000);
  await signedOutTile.getByText('Last seen 1 minute ago', { exact: true }).waitFor();
  assert.equal(
    await page.getByTestId('parent-renders').textContent(),
    rendersBeforeMinuteTick,
    'the shared minute clock must update only timestamp leaves, not the tile-grid parent',
  );
  assert.deepEqual(
    await page.evaluate(() => globalThis.__studentTileMinuteTimers()),
    { timeouts: 0, intervals: 1 },
    'the boundary timeout must become one shared minute interval',
  );

  const tabsButton = signedOutTile.getByRole('button', { name: 'View Tabs', exact: true });
  await tabsButton.click();
  await page.getByTestId('tab-clicks').filter({ hasText: 'Tab clicks: 1' }).waitFor();
  assert.equal(
    await page.getByTestId('card-clicks').textContent(),
    'Card clicks: 0',
    'the tile Tabs shortcut must not open the student drawer',
  );

  await page.getByTestId('age-last-seen').click();
  await signedOutTile.getByText('Last seen 2 hours ago', { exact: true }).waitFor();

  const neverObservedTile = page.getByTestId('card-student-never-observed-student');
  assert.equal(
    await neverObservedTile.getByText('Not logged in', { exact: true }).count(),
    1,
    'a never-observed signed-out student must render signed-out truth exactly once',
  );
  await neverObservedTile.getByText('Never observed', { exact: true }).waitFor();
  assert.equal(
    await neverObservedTile.getByText(/1969|1970/).count(),
    0,
    'a student without monitoring history must not render the Unix epoch',
  );

  const signalLostTile = page.getByTestId('card-student-signal-lost-student');
  await signalLostTile.getByText('Monitoring signal lost — cause unknown', { exact: true }).waitFor();
  await signalLostTile.getByText('Last seen 2 hours ago', { exact: true }).waitFor();
  assert.equal(
    await signalLostTile.getByText('Preview unavailable', { exact: true }).count(),
    0,
    'signal loss must use its specific truth instead of the generic preview heading',
  );

  const onlineTile = page.getByTestId('card-student-online-student');
  assert.equal(
    await onlineTile.getByText('Online', { exact: true }).count(),
    1,
    'available Online status must remain in the tile header',
  );
  await page.getByTestId('toggle-tiles').click();
  assert.deepEqual(
    await page.evaluate(() => globalThis.__studentTileMinuteTimers()),
    { timeouts: 0, intervals: 0 },
    'the final relative-label unsubscribe must stop the shared minute clock',
  );
  assert.deepEqual(pageErrors, [], `student-tile runtime errors: ${pageErrors.join('\n')}`);

  console.log('ClassPilot rendered student-tile copy and action regression passed.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
