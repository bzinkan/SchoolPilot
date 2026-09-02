#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  SCREENSHOT_ACTIVE_VIEW_STALE_MS,
  SCREENSHOT_STALE_MS,
  screenshotStaleThresholdMs,
} from '../src/products/classpilot/lib/studentMonitoringDisplay.js';

// The stale threshold is context-aware: an observing wall repaints about every
// five seconds, so its cue is due long before the background default.
assert.ok(
  SCREENSHOT_ACTIVE_VIEW_STALE_MS >= 15_000 && SCREENSHOT_ACTIVE_VIEW_STALE_MS <= 20_000,
  'the active-observation cue must land between 15 and 20 seconds',
);
assert.equal(screenshotStaleThresholdMs('background'), SCREENSHOT_STALE_MS);
assert.equal(screenshotStaleThresholdMs(undefined), SCREENSHOT_STALE_MS);
assert.equal(screenshotStaleThresholdMs('active_view'), SCREENSHOT_ACTIVE_VIEW_STALE_MS);
assert.equal(
  screenshotStaleThresholdMs('background', {}),
  SCREENSHOT_STALE_MS,
  'an unknown observation state keeps the 75-second default',
);
assert.equal(
  screenshotStaleThresholdMs('background', { observationActive: true }),
  SCREENSHOT_ACTIVE_VIEW_STALE_MS,
  'an observing wall tightens the cue to the active-view window',
);
assert.equal(
  screenshotStaleThresholdMs('active_view', { observationActive: false }),
  SCREENSHOT_ACTIVE_VIEW_STALE_MS,
  'the hint may only tighten: it can never loosen an already-active cadence',
);

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
  // A dev-server full reload mid-run hides every tile again and then surfaces as
  // an unrelated element timeout. Count main-frame navigations so that failure
  // names itself instead.
  let mainFrameNavigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });

  // Student favicon URLs are rendered as <img>; keep the harness hermetic.
  await page.route(/^https:\/\//, (route) => route.abort());

  // Hold the decode of the marked replacement frame open so the tile's double
  // buffer can be observed deterministically: the frame already on screen must
  // survive until its successor's pixels are ready.
  await page.addInitScript(() => {
    const nativeDecode = HTMLImageElement.prototype.decode;
    const held = { gatedframe: [], divergeframe: [] };
    HTMLImageElement.prototype.decode = function decode() {
      const marker = Object.keys(held).find((name) => (this.src || '').includes(name));
      if (marker) {
        return new Promise((resolve, reject) => {
          held[marker].push(() => nativeDecode.call(this).then(resolve, reject));
        });
      }
      return nativeDecode.call(this);
    };
    const release = (marker) => held[marker].splice(0).map((resume) => resume()).length;
    globalThis.__releaseGatedDecodes = () => release('gatedframe');
    globalThis.__releaseDivergedDecodes = () => release('divergeframe');
  });

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

  // ── Frame geometry: the whole student screen, letterboxed, never cropped.
  const frameSwapTile = page.getByTestId('card-student-frame-swap-student');
  const frameSwapImage = page.getByTestId('screenshot-frame-swap-student');
  await frameSwapImage.waitFor();
  assert.equal(
    await frameSwapImage.evaluate((image) => getComputedStyle(image).objectFit),
    'contain',
    'a tile frame must show the whole student screen instead of cropping it',
  );
  assert.equal(
    await frameSwapImage.evaluate((image) => image.getAttribute('loading')),
    null,
    'an already-delivered data: frame must never be deferred by lazy loading',
  );
  const frameSwapButton = page.getByTestId('screenshot-current-frame-swap-student');
  assert.equal(
    await frameSwapButton.evaluate((button) => {
      const background = getComputedStyle(button).backgroundColor;
      return background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent';
    }),
    true,
    'the letterbox must paint its own background token behind the frame',
  );
  assert.equal(
    await frameSwapButton.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return Math.abs(box.width / box.height - 16 / 9) < 0.02;
    }),
    true,
    'the frame box must hold a fixed 16:9 ratio so no state can resize it',
  );

  // ── A replacement frame replaces the visible one only after it decodes.
  const initialFrameSrc = await frameSwapImage.evaluate((image) => image.src);
  await page.evaluate(() => {
    globalThis.__sawPreviousDuringSwap = false;
    const host = document.querySelector('[data-testid="frame-swap-tile-host"]');
    const observer = new MutationObserver(() => {
      const current = host.querySelector('[data-testid="screenshot-frame-swap-student"]');
      const previous = host.querySelector('[data-testid="screenshot-previous-frame-swap-student"]');
      if (current && current.src.includes('gatedframe') && previous) {
        globalThis.__sawPreviousDuringSwap = true;
      }
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true });
  });
  await page.getByTestId('swap-frame').click();
  assert.equal(
    await frameSwapImage.evaluate((image) => image.src),
    initialFrameSrc,
    'the displayed frame must not change until its replacement has decoded',
  );
  assert.equal(
    await page.getByTestId('screenshot-frame-swap-student').count(),
    1,
    'the tile must never blank between frames',
  );
  assert.equal(
    await frameSwapTile.getByText('Screenshot unavailable or stale', { exact: true }).count(),
    0,
    'an in-flight replacement must not drop the tile to the unavailable state',
  );
  assert.equal(
    await page.evaluate(() => globalThis.__releaseGatedDecodes()),
    1,
    'exactly one replacement decode must have been in flight',
  );
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-testid="screenshot-frame-swap-student"]');
    return Boolean(image && image.src.includes('gatedframe'));
  });
  assert.equal(
    await page.evaluate(() => globalThis.__sawPreviousDuringSwap),
    true,
    'the outgoing frame must stay mounted beneath the incoming one across the swap',
  );
  assert.equal(
    await page.getByTestId('screenshot-frame-swap-student').evaluate(
      (image) => image.className.includes('classpilot-frame-in'),
    ),
    true,
    'the incoming frame must fade in rather than hard-swap',
  );
  // The fade releases the outgoing frame on animationend, so the buffer never
  // grows past the two layers a single crossfade needs.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="screenshot-previous-frame-swap-student"]').length === 0,
    null,
    { timeout: 5_000 },
  );

  // ── Preview state must never resize a tile.
  await page.getByTestId('screenshot-height-current-student').waitFor();
  await page.getByTestId('badge-offtask-height-badged-student').waitFor();
  await page.getByTestId('screenshot-stale-height-stale-student').waitFor();
  const tileHeights = await page.evaluate(() => [
    'height-current-student',
    'height-badged-student',
    'height-stale-student',
  ].map((studentId) => document
    .querySelector(`[data-testid="card-student-${studentId}"]`)
    .getBoundingClientRect().height));
  assert.equal(
    Math.max(...tileHeights) - Math.min(...tileHeights) < 1,
    true,
    `badge and stale states must not change tile height: ${tileHeights.join(', ')}`,
  );

  // ── The stale cue follows the cadence the wall is actually running.
  assert.match(
    await page.getByTestId('screenshot-updating-active-stale-student').textContent(),
    /^Updating… · Captured /,
    'an observing wall must flag a 16-second-old capture as updating',
  );
  await page.getByTestId('screenshot-retained-active-stale-student').waitFor();
  await page.getByTestId('screenshot-active-fresh-student').waitFor();
  await page.getByTestId('screenshot-current-active-fresh-student').waitFor();
  assert.equal(
    await page.getByTestId('screenshot-updating-active-fresh-student').count(),
    0,
    'a capture inside the active-observation window stays current',
  );
  await page.getByTestId('screenshot-background-stale-student').waitFor();
  await page.getByTestId('screenshot-current-background-stale-student').waitFor();
  assert.equal(
    await page.getByTestId('screenshot-updating-background-stale-student').count(),
    0,
    'without an observing wall the 75-second default still applies at 16 seconds',
  );

  // ── The age cue follows the frame on screen, not the frame in props. With a
  //    replacement decode held open, only the painted frame ages — and the memo
  //    comparator, whose props are otherwise identical, must still turn the tile
  //    over when it does.
  const divergedImage = page.getByTestId('screenshot-diverged-frame-student');
  await divergedImage.waitFor();
  const paintedFrameSrc = await divergedImage.evaluate((image) => image.src);
  await page.getByTestId('swap-diverged-frame').click();
  assert.equal(
    await page.getByTestId('screenshot-updating-diverged-frame-student').count(),
    0,
    'a 61-second-old painted frame is still inside its own fresh window',
  );
  await page.clock.runFor(20_000);
  await page.getByTestId('tick').click();
  await page.getByTestId('screenshot-updating-diverged-frame-student').waitFor();
  assert.equal(
    await divergedImage.evaluate((image) => image.src),
    paintedFrameSrc,
    'the replacement decode must still be in flight, so the aged frame is the one on screen',
  );
  assert.equal(
    await page.getByTestId('screenshot-current-diverged-frame-student').count(),
    1,
    'the props frame stays current: only the decoded frame crossed its stale bound',
  );
  assert.equal(
    await page.evaluate(() => globalThis.__releaseDivergedDecodes()),
    1,
    'exactly one diverged replacement decode must have been in flight',
  );
  await page.waitForFunction(() => {
    const image = document.querySelector('[data-testid="screenshot-diverged-frame-student"]');
    return Boolean(image && image.src.includes('divergeframe'));
  });
  assert.equal(
    await page.getByTestId('screenshot-updating-diverged-frame-student').count(),
    0,
    'the cue must clear as soon as the fresh replacement is the frame on screen',
  );

  // ── A frame already past its retention bound when it arrives is never
  //    painted, even while the caller's own clock still calls it current.
  await page.getByTestId('preview-unavailable-stale-clock-student').waitFor();
  assert.equal(
    await page.getByTestId('screenshot-stale-clock-student').count(),
    0,
    'a 130-second-old capture must not be decoded onto a tile whose clock stopped 100 seconds ago',
  );
  assert.equal(
    await page.getByTestId('screenshot-current-stale-clock-student').count()
      + await page.getByTestId('screenshot-retained-stale-clock-student').count(),
    0,
    'a stale caller clock must not even open the preview surface for an expired frame',
  );
  assert.equal(
    await page.getByTestId('screenshot-updating-stale-clock-student').count(),
    0,
    'no amber Updating… badge may describe pixels the tile is not allowed to show',
  );

  // ── Retention is self-enforcing: the frame drops itself at its own bound with
  //    no prop change at all, which is the one thing the memo cannot suppress.
  await page.getByTestId('screenshot-retention-expiry-student').waitFor();
  await page.getByTestId('screenshot-retained-retention-expiry-student').waitFor();
  assert.match(
    await page.getByTestId('screenshot-updating-retention-expiry-student').textContent(),
    /^Updating… · Captured /,
    'a 90-second-old capture starts inside its reconnect window',
  );
  const rendersBeforeRetentionExpiry = await page.getByTestId('parent-renders').textContent();
  await page.clock.runFor(30_500);
  await page.getByTestId('preview-unavailable-retention-expiry-student').waitFor();
  assert.equal(
    await page.getByTestId('screenshot-retention-expiry-student').count(),
    0,
    'the committed frame must expire itself at observedAt + 120s',
  );
  assert.equal(
    await page.getByTestId('screenshot-updating-retention-expiry-student').count(),
    0,
    'the amber Updating… badge must never outlive the pixels it timestamps',
  );
  assert.equal(
    await page.getByTestId('screenshot-retained-retention-expiry-student').count(),
    0,
    'the retained preview surface must give way to the unavailable card',
  );
  assert.equal(
    await page.getByTestId('parent-renders').textContent(),
    rendersBeforeRetentionExpiry,
    'expiry must come from the tile itself: no parent render, no changed prop, nothing for memo to compare',
  );

  // ── The enlarged viewer shares the decoder (crossfade: false) and must keep
  //    painting a frame that is still inside its own window.
  await page.getByTestId('toggle-dialog').click();
  const dialogImage = page.getByTestId('expanded-screenshot-image');
  await dialogImage.waitFor();
  assert.equal(
    await dialogImage.evaluate((image) => image.src.startsWith('data:image/svg+xml')),
    true,
    'the enlarged viewer must still paint its decoded frame',
  );
  assert.match(
    await page.getByTestId('expanded-screenshot-status').textContent(),
    /^Updated /,
    'a capture inside its retention window must not be aged out of the viewer',
  );
  assert.equal(
    await page.getByTestId('expanded-screenshot-unavailable').count(),
    0,
    'frame retention must not fail the enlarged viewer closed while its frame is in bounds',
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('expanded-screenshot-dialog').waitFor({ state: 'detached' });

  await page.getByTestId('toggle-tiles').click();
  assert.deepEqual(
    await page.evaluate(() => globalThis.__studentTileMinuteTimers()),
    { timeouts: 0, intervals: 0 },
    'the final relative-label unsubscribe must stop the shared minute clock',
  );
  assert.deepEqual(pageErrors, [], `student-tile runtime errors: ${pageErrors.join('\n')}`);
  assert.equal(
    mainFrameNavigations,
    1,
    'the harness must not reload mid-run; a dev-server reload invalidates every tile assertion',
  );

  console.log('ClassPilot rendered student-tile copy and action regression passed.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
