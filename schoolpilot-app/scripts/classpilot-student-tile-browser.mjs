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
  await page.clock.install({ time: new Date('2026-08-24T12:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-08-24T12:00:00.000Z'));
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${baseURL}/classpilot-student-tile-regression.html`, { waitUntil: 'networkidle' });
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
  assert.equal(
    await page.getByTestId('screenshot-signed-out-student').count(),
    0,
    'signed-out state must hard-hide even a fresh cached screenshot',
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
  assert.equal(
    await tabsButton.count(),
    0,
    'signed-out authorization loss must remove the cached-history shortcut',
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
  await signalLostTile.getByText('Monitoring signal lost', { exact: true }).waitFor();
  await page.getByTestId('screenshot-current-signal-lost-student').waitFor();
  assert.equal(
    await signalLostTile.getByText('Preview unavailable', { exact: true }).count(),
    0,
    'signal loss must use its specific truth instead of the generic preview heading',
  );
  assert.equal(
    await page.getByTestId('checkbox-select-student-signal-lost-student').isDisabled(),
    true,
    'a fresh screenshot must not re-enable controls while heartbeat telemetry is stale',
  );
  assert.equal(
    await page.getByTestId('button-lock-toggle-signal-lost-student').isDisabled(),
    true,
    'signal-loss command controls remain disabled while the fresh screenshot stays visible',
  );

  const signOutOnlyTile = page.getByTestId('card-student-signal-lost-sign-out-student');
  const signOutOnlyCheckbox = page.getByTestId('checkbox-select-student-signal-lost-sign-out-student');
  assert.equal(
    await signOutOnlyCheckbox.isDisabled(),
    false,
    'an authoritative stale login may be selected specifically for Student Sign Out',
  );
  assert.equal(
    await signOutOnlyCheckbox.getAttribute('title'),
    'Select for Student Sign Out only',
  );
  assert.equal(
    await signOutOnlyTile.getByTestId('button-lock-toggle-signal-lost-sign-out-student').isDisabled(),
    true,
    'sign-out-only selection must not re-enable realtime device commands',
  );

  const retainedSignalLostTile = page.getByTestId('card-student-signal-lost-retained-student');
  await page.getByTestId('screenshot-retained-signal-lost-retained-student').waitFor();
  await page.getByTestId('screenshot-monitoring-warning-signal-lost-retained-student').waitFor();
  assert.match(
    await page.getByTestId('screenshot-updating-signal-lost-retained-student').textContent(),
    /^Updating… · Captured /,
    'the exact 75-second state must be dimmed and visibly age-labeled',
  );
  assert.equal(
    await retainedSignalLostTile.getByText('Monitoring signal lost', { exact: true }).count(),
    1,
  );

  const expiredSignalLostTile = page.getByTestId('card-student-signal-lost-expired-student');
  await page.getByTestId('preview-unavailable-signal-lost-expired-student').waitFor();
  assert.equal(
    await page.getByTestId('screenshot-signal-lost-expired-student').count(),
    0,
    'the exact 120-second boundary must remove cached pixels',
  );
  assert.equal(
    await expiredSignalLostTile.getByText('Monitoring signal lost', { exact: true }).count(),
    1,
  );

  const onlineTile = page.getByTestId('card-student-online-student');
  assert.equal(
    await onlineTile.getByText('Online', { exact: true }).count(),
    1,
    'available Online status must remain in the tile header',
  );

  const readOnlyTile = page.getByTestId('card-student-read-only-student');
  await page.getByTestId('screenshot-read-only-student').waitFor();
  await readOnlyTile.getByTitle('Research notes').waitFor();
  assert.equal(
    await readOnlyTile.getByText('Controls locked', { exact: true }).count(),
    0,
    'read-only actions must not suppress an authorized screenshot',
  );
  assert.equal(
    await readOnlyTile.getByText(/In supervision/).count(),
    0,
    'ordinary Observe must not be mislabeled as temporary supervision',
  );
  assert.equal(
    await page.getByTestId('checkbox-select-student-read-only-student').isDisabled(),
    true,
    'read-only selection must remain disabled',
  );
  const readOnlyLockButton = page.getByTestId('button-lock-toggle-read-only-student');
  assert.equal(await readOnlyLockButton.isDisabled(), true, 'read-only device commands must remain disabled');
  assert.equal(
    await readOnlyLockButton.getAttribute('title'),
    'Observe mode is read-only.',
    'disabled action tooltips must explain the read-only context',
  );
  const readOnlyAllowButton = page.getByTestId('button-allow-domain-read-only-student');
  assert.equal(await readOnlyAllowButton.isDisabled(), true, 'read-only allow-domain actions must remain disabled');
  assert.equal(
    await readOnlyAllowButton.getAttribute('title'),
    'Observe mode is read-only.',
    'secondary action tooltips must use the same read-only reason',
  );
  assert.equal(
    await page.getByTestId('button-manage-tabs-read-only-student').count(),
    0,
    'read-only tiles must not expose the tabs shortcut',
  );
  assert.equal(
    await page.getByTestId('button-live-view-read-only-student').count(),
    0,
    'read-only tiles must not expose Live View',
  );
  assert.equal(
    await page.getByTestId('video-live-read-only-student').count(),
    0,
    'a stale live stream must not replace the read-only screenshot',
  );
  assert.equal(
    await page.getByTestId('button-expand-read-only-student').count(),
    0,
    'a stale live stream must not expose its expand control',
  );
  assert.equal(
    (await readOnlyTile.getAttribute('class')).includes('border-dashed'),
    false,
    'read-only actions must retain normal monitoring status styling',
  );
  await page.getByTestId('screenshot-read-only-student').click();
  await page.getByTestId('card-clicks').filter({ hasText: 'Card clicks: 1' }).waitFor();

  const supervisedTile = page.getByTestId('card-student-supervised-student');
  await supervisedTile.getByText('In supervision: Ms. Rivera', { exact: true }).waitFor();
  await supervisedTile.getByText('Ms. Rivera is temporarily supervising this student.', { exact: true }).waitFor();
  await supervisedTile.getByText('Controls locked', { exact: true }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-supervised-student').count(),
    0,
    'true temporary supervision must continue suppressing the screenshot',
  );
  assert.equal(
    (await supervisedTile.getAttribute('class')).includes('border-dashed'),
    true,
    'true temporary supervision must retain suppressed styling',
  );
  await page.getByTestId('button-return-to-class-supervised-student').click();
  await page.getByTestId('return-clicks').filter({ hasText: 'Return clicks: 1' }).waitFor();
  assert.equal(
    await page.getByTestId('card-clicks').textContent(),
    'Card clicks: 1',
    'the Return to Class action must not open the student drawer',
  );

  const pausedTile = page.getByTestId('card-student-paused-student');
  await pausedTile.getByText('Screenshots paused', { exact: true }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-paused-student').count(),
    0,
    'releasing a paused observation lease must immediately hide a fresh legacy V1 screenshot',
  );
  assert.equal(
    await page.getByTestId('screenshot-retained-paused-student').count(),
    0,
    'a paused observation may not use reconnecting retention',
  );
  assert.equal(
    await page.getByTestId('video-live-paused-student').count(),
    0,
    'paused observation must also hide an existing live pixel stream',
  );

  const pendingTile = page.getByTestId('card-student-pending-student');
  await pendingTile.getByText('Authorizing screen preview…', { exact: true }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-pending-student').count(),
    0,
    'a cached A-context pixel must remain hidden until the current session lease is acknowledged',
  );
  assert.equal(
    await page.getByTestId('screenshot-retained-pending-student').count(),
    0,
    'pending authorization must not qualify for last-preview retention',
  );
  assert.equal(await page.getByTestId('video-live-pending-student').count(), 0);

  const pausedV2Tile = page.getByTestId('card-student-paused-v2-student');
  await page.getByTestId('screenshot-current-paused-v2-student').waitFor();
  assert.equal(
    await pausedV2Tile.getByText('Screenshots paused', { exact: true }).count(),
    0,
    'a valid class-bound V2 screenshot must not flap when the legacy observation lease pauses',
  );
  assert.equal(
    await page.getByTestId('video-live-paused-v2-student').count(),
    0,
    'V2 screenshot authority must not revive a separately lease-gated live stream',
  );

  const deniedTile = page.getByTestId('card-student-denied-student');
  await deniedTile.getByText('Screen preview unavailable', { exact: true }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-denied-student').count(),
    0,
    'claimed/denied observation context must hard-hide a fresh prior-context screenshot',
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
