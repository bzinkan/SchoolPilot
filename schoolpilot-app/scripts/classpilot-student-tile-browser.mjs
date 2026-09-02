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

  // Student favicon URLs are rendered as <img>; keep the harness hermetic.
  await page.route(/^https:\/\//, (route) => route.abort());

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
  const signedOutRestrictionCheckbox = page.getByTestId('checkbox-select-student-signed-out-student');
  assert.equal(
    await signedOutRestrictionCheckbox.isDisabled(),
    false,
    'an operator-enabled signed-out student may be selected for persistent restrictions',
  );
  assert.equal(
    await signedOutRestrictionCheckbox.getAttribute('title'),
    'Select for restrictions that will apply after sign-in',
  );
  assert.equal(
    await page.getByTestId('checkbox-select-student-online-student').isDisabled(),
    false,
    'online students remain selectable into a mixed persistent-restriction cohort',
  );
  assert.equal(
    await page.getByTestId('button-manage-tabs-online-student').count(),
    0,
    'individual transient actions stay hidden while a deferred-restriction selection is active',
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

  const interactiveTile = page.getByTestId('card-student-interactive-student');
  await page.getByTestId('screenshot-current-interactive-student').waitFor();
  const interactiveDetailsButton = interactiveTile.getByRole('button', {
    name: 'Open details and activity for Interactive Student',
    exact: true,
  });
  assert.equal(await interactiveDetailsButton.count(), 1, 'the explicit Details action must be accessible by name');
  assert.equal(
    await interactiveDetailsButton.getAttribute('title'),
    'Open details and activity for Interactive Student',
  );

  const memoDetailsTile = page.getByTestId('card-student-memo-details-student');
  const memoDetailsButton = memoDetailsTile.getByRole('button', {
    name: 'Open details and activity for Memo Details Student',
    exact: true,
  });
  assert.equal(
    await memoDetailsButton.count(),
    1,
    'the memoized tile must initially render the authorized Details action',
  );
  await page.getByTestId('revoke-memo-details').click();
  await memoDetailsButton.waitFor({ state: 'detached' });
  assert.equal(
    await page.getByTestId('card-student-memo-details-student').count(),
    1,
    'revoking only the Details callback must rerender the memoized tile without removing the tile',
  );
  assert.equal(
    await page.getByTestId('button-student-details-memo-details-student').count(),
    0,
    'function-to-undefined callback availability must remove Details immediately',
  );

  await page.getByTestId('text-student-name-interactive-student').click();
  await page.getByTestId('screenshot-clicks').filter({ hasText: 'Screenshot clicks: 1' }).waitFor();
  assert.equal(
    await page.getByTestId('details-clicks').textContent(),
    'Details clicks: 0',
    'a non-control tile-body click must open only the enlarged screenshot',
  );

  await page.getByTestId('screenshot-current-interactive-student').click();
  await page.getByTestId('screenshot-clicks').filter({ hasText: 'Screenshot clicks: 2' }).waitFor();
  assert.equal(
    await page.getByTestId('details-clicks').textContent(),
    'Details clicks: 0',
    'the screenshot button must not also open student details',
  );

  await interactiveDetailsButton.click();
  await page.getByTestId('details-clicks').filter({ hasText: 'Details clicks: 1' }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-clicks').textContent(),
    'Screenshot clicks: 2',
    'the Details button must not bubble into the screenshot action',
  );
  await interactiveDetailsButton.focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('details-clicks').filter({ hasText: 'Details clicks: 2' }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-clicks').textContent(),
    'Screenshot clicks: 2',
    'keyboard activation of Details must remain isolated from the card action',
  );

  await page.getByTestId('checkbox-select-student-interactive-student').click();
  await page.getByTestId('selection-clicks').filter({ hasText: 'Selection clicks: 1' }).waitFor();
  await page.getByTestId('button-manage-tabs-interactive-student').click();
  await page.getByTestId('tab-clicks').filter({ hasText: 'Tab clicks: 1' }).waitFor();
  await page.getByTestId('button-lock-toggle-interactive-student').click();
  await page.getByTestId('command-clicks').filter({ hasText: 'Command clicks: 1' }).waitFor();
  await page.getByTestId('button-allow-domain-interactive-student').click();
  await page.getByTestId('allow-clicks').filter({ hasText: 'Allow clicks: 1' }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-clicks').textContent(),
    'Screenshot clicks: 2',
    'checkbox, View Tabs, lock, and allow-domain controls must not bubble into screenshot enlargement',
  );
  assert.equal(
    await page.getByTestId('details-clicks').textContent(),
    'Details clicks: 2',
    'other student controls must not open the details drawer',
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
  const readOnlyDetailsButton = readOnlyTile.getByRole('button', {
    name: 'Open details and activity for Observed Student',
    exact: true,
  });
  assert.equal(
    await readOnlyDetailsButton.count(),
    1,
    'Admin Observe must retain the read-only Details action',
  );
  await page.getByTestId('screenshot-read-only-student').click();
  await page.getByTestId('screenshot-clicks').filter({ hasText: 'Screenshot clicks: 3' }).waitFor();
  await readOnlyDetailsButton.click();
  await page.getByTestId('details-clicks').filter({ hasText: 'Details clicks: 3' }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-clicks').textContent(),
    'Screenshot clicks: 3',
    'read-only Details must not bubble into screenshot enlargement',
  );

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
  assert.equal(
    await page.getByTestId('button-student-details-supervised-student').count(),
    0,
    'supervised/suppressed tiles must not expose student details',
  );
  await page.getByTestId('button-return-to-class-supervised-student').click();
  await page.getByTestId('return-clicks').filter({ hasText: 'Return clicks: 1' }).waitFor();
  assert.equal(
    await page.getByTestId('details-clicks').textContent(),
    'Details clicks: 3',
    'the Return to Class action must not open student details',
  );
  assert.equal(
    await page.getByTestId('screenshot-clicks').textContent(),
    'Screenshot clicks: 3',
    'the Return to Class action must not bubble into screenshot enlargement',
  );

  const faviconStripTile = page.getByTestId('card-student-favicon-strip-student');
  await page.getByTestId('screenshot-current-favicon-strip-student').waitFor();
  const faviconStrip = page.getByTestId('tab-favicons-favicon-strip-student');
  await faviconStrip.waitFor();
  assert.equal(
    await faviconStrip.locator('[data-testid^="tab-favicon-favicon-strip-student-"]').count(),
    5,
    'the strip must show one chip per unique http(s) hostname and drop chrome:// tabs',
  );
  assert.equal(
    await page.getByTestId('tab-favicon-favicon-strip-student-0').getAttribute('title'),
    'Assignment · docs.example.test',
    'the active tab must be the first chip',
  );
  const faviconImages = faviconStrip.locator('img');
  assert.equal(
    await faviconImages.count(),
    3,
    'only https favicons may render as images; http and data favicons fall back to the placeholder dot',
  );
  assert.deepEqual(
    await faviconImages.evaluateAll((images) => images.map((image) => image.getAttribute('referrerpolicy'))),
    ['no-referrer', 'no-referrer', 'no-referrer'],
    'every favicon image must send no referrer',
  );
  assert.equal(
    await faviconImages.evaluateAll((images) => images.every((image) => /^https:\/\//.test(image.getAttribute('src') || ''))),
    true,
    'no favicon image may load an http: or data: source',
  );
  assert.equal(
    await faviconStripTile.getByText('Open', { exact: true }).count(),
    1,
  );
  const faviconMoreButton = page.getByTestId('button-tab-favicons-more-favicon-strip-student');
  assert.equal(
    (await faviconMoreButton.textContent())?.trim(),
    '+7…',
    'the overflow chip must count from the server openTabCount and mark a truncated snapshot',
  );
  await faviconMoreButton.click();
  await page.getByTestId('tab-clicks').filter({ hasText: 'Tab clicks: 2' }).waitFor();
  assert.equal(
    await page.getByTestId('screenshot-clicks').textContent(),
    'Screenshot clicks: 3',
    'the favicon overflow chip must open Manage Tabs without bubbling into screenshot enlargement',
  );

  const tempAllowTile = page.getByTestId('card-student-temp-allow-student');
  await tempAllowTile.getByTestId('badge-blocked-temp-allow-student').waitFor();
  const tempAllowChip = page.getByTestId('badge-temp-allow-temp-allow-student');
  await tempAllowChip.waitFor();
  assert.match(
    (await tempAllowChip.textContent()) || '',
    /^reading\.example\.test allowed· 9 min left$/,
    'the temporary allow chip must name the domain and count down on the shared minute clock',
  );
  const allowTemporarilyButton = page.getByTestId('button-allow-temporarily-temp-allow-student');
  assert.equal(await allowTemporarilyButton.getAttribute('title'), 'Allow this site for 10 minutes');
  assert.equal(await allowTemporarilyButton.isDisabled(), false);
  await allowTemporarilyButton.click();
  await page.getByTestId('command-clicks').filter({ hasText: 'Command clicks: 2' }).waitFor();
  assert.equal(
    await page.getByTestId('last-command').textContent(),
    JSON.stringify({
      commandType: 'temp-unblock',
      commandPayload: { domain: 'blocked.example.test', durationMinutes: 10 },
      studentIds: ['temp-allow-student'],
    }),
    'Allow 10 min must dispatch one exact temp-unblock command for the current hostname',
  );
  assert.equal(
    await page.getByTestId('allow-clicks').textContent(),
    'Allow clicks: 1',
    'the temporary allow must not also add a session-wide allow',
  );
  assert.equal(await page.getByTestId('screenshot-clicks').textContent(), 'Screenshot clicks: 3');
  assert.equal(await page.getByTestId('details-clicks').textContent(), 'Details clicks: 3');
  assert.equal(await page.getByTestId('tab-clicks').textContent(), 'Tab clicks: 2');
  assert.deepEqual(
    await page.evaluate(() => globalThis.__studentTileMinuteTimers()),
    { timeouts: 0, intervals: 1 },
    'the countdown leaf must reuse the shared minute interval',
  );

  const tabLimitBadge = page.getByTestId('badge-tab-limit-tab-limit-student');
  await tabLimitBadge.waitFor();
  assert.equal(
    (await tabLimitBadge.textContent())?.trim(),
    '7 / 5 tabs',
    'the tab-limit chip must show the realtime count against the authoritative limit',
  );
  assert.equal(
    (await tabLimitBadge.getAttribute('class') || '').includes('amber'),
    true,
    'an over-limit student must render the chip in the amber warning tone',
  );
  assert.equal(
    await page.getByTestId('badge-tab-limit-online-student').count(),
    0,
    'students without a classroom tab limit must not render the chip',
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
