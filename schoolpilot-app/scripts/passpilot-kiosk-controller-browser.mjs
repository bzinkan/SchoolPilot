import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const vite = await createServer({
  root: APP_ROOT,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
await vite.listen();
const address = vite.httpServer?.address();
assert.ok(address && typeof address !== 'string');

let browser;
let page;
let legacyPage;
let resumeRacePage;
let activeSnapshots = 0;
let maximumActiveSnapshots = 0;
let snapshotCalls = 0;
const snapshotStartedAt = [];
let firstSnapshotFinishedAt = 0;
const authenticatedHeaders = [];
const localDeviceId = '11111111-1111-4111-8111-111111111111';
const continuityDeviceId = '22222222-2222-4222-8222-222222222222';
let continuityCalls = 0;

try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem('pp_kiosk_pin', '2468');
    window.localStorage.setItem('pp_kiosk_device', '11111111-1111-4111-8111-111111111111');
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      await route.fulfill({ status: 401, json: { error: 'Not signed in' } });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/auth') {
      assert.equal(request.headers()['x-kiosk-pin'], '2468');
      await route.fulfill({ json: { token: 'signed-kiosk-token', expiresInSeconds: 900 } });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/launch-ticket/redeem') {
      continuityCalls += 1;
      authenticatedHeaders.push(request.headers());
      assert.deepEqual(request.postDataJSON(), { ticket: 'one-use-ticket' });
      await route.fulfill({ json: { continuityOnly: true, deviceId: continuityDeviceId } });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/session') {
      authenticatedHeaders.push(request.headers());
      await route.fulfill({
        json: {
          kioskStyle: 'simple',
          session: {
            id: 'session-1',
            status: 'active',
            source: 'classpilot_groups',
            classId: 'class-1',
            className: 'Biology',
            kioskName: 'Hall Kiosk',
          },
        },
      });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/snapshot') {
      snapshotCalls += 1;
      snapshotStartedAt.push(Date.now());
      activeSnapshots += 1;
      maximumActiveSnapshots = Math.max(maximumActiveSnapshots, activeSnapshots);
      authenticatedHeaders.push(request.headers());
      await new Promise((resolve) => setTimeout(resolve, 75));
      if (snapshotCalls === 1) {
        await route.fulfill({
          status: 200,
          headers: { ETag: '"snapshot-1"' },
          json: {
            revision: 1,
            kioskStyle: 'simple',
            config: {
              source: 'classpilot_groups',
              classId: 'class-1',
              className: 'Biology',
              kioskName: 'Hall Kiosk',
            },
            session: { id: 'session-1', status: 'active' },
            roster: {
              students: [{ id: 'student-1', firstName: 'Ada', lastName: 'Student' }],
            },
            passes: [],
          },
        });
        firstSnapshotFinishedAt = Date.now();
      } else {
        await route.fulfill({ status: 503, json: { error: 'Temporary outage' } });
      }
      activeSnapshots -= 1;
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'Not found' } });
  });

  await page.goto(`http://127.0.0.1:${address.port}/passpilot/kiosk/simple?school=school-1#launchTicket=one-use-ticket`);
  await page.getByText('Student, Ada', { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByTestId('kiosk-offline-banner').waitFor({ timeout: 10_000 });

  assert.equal(snapshotCalls >= 2, true);
  assert.equal(continuityCalls, 1, 'the one-use launch ticket must be redeemed exactly once');
  assert.equal(new URL(page.url()).hash, '', 'the launch ticket must be removed from the URL fragment');
  assert.equal(maximumActiveSnapshots, 1, 'snapshot polling must never overlap');
  assert.equal(
    snapshotStartedAt[1] - firstSnapshotFinishedAt >= 4_800,
    true,
    'the healthy delay must start after the prior response completes',
  );
  assert.equal(await page.getByText('Student, Ada', { exact: true }).isVisible(), true, 'last-known roster remains visible');
  assert.match(await page.getByTestId('kiosk-offline-banner').innerText(), /Showing information last updated/);
  for (const headers of authenticatedHeaders) {
    assert.equal(headers['x-kiosk-token'], 'signed-kiosk-token');
    assert.equal(headers['x-kiosk-pin'], undefined);
  }
  const sessionHeaders = authenticatedHeaders.find((headers) => headers['x-kiosk-session'] === undefined
    && headers['x-kiosk-device'] === continuityDeviceId);
  assert.ok(sessionHeaders, 'session bootstrap must adopt the opaque continuity id');
  assert.equal(sessionHeaders['x-kiosk-device-prev'], localDeviceId);

  await page.close();
  page = null;
  legacyPage = await browser.newPage();
  await legacyPage.addInitScript(() => {
    window.localStorage.setItem('pp_kiosk_pin', '1357');
  });
  const legacyPaths = [];
  await legacyPage.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      await route.fulfill({ status: 401, json: { error: 'Not signed in' } });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/auth' || pathname === '/api/passpilot/kiosk/snapshot') {
      legacyPaths.push(pathname);
      await route.fulfill({ status: 404, json: { error: 'Not found' } });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/session') {
      legacyPaths.push(pathname);
      assert.equal(request.headers()['x-kiosk-pin'], '1357');
      await route.fulfill({
        json: {
          kioskStyle: 'simple',
          session: {
            id: 'legacy-session',
            status: 'active',
            source: 'classpilot_groups',
            classId: 'legacy-class',
            className: 'Current Server Class',
          },
        },
      });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/config') {
      legacyPaths.push(pathname);
      assert.equal(request.headers()['x-kiosk-pin'], '1357');
      await route.fulfill({
        json: {
          source: 'classpilot_groups',
          classId: 'legacy-class',
          className: 'Current Server Class',
          session: { id: 'legacy-session', status: 'active' },
        },
      });
      return;
    }
    if (pathname === '/api/passpilot/kiosk/students') {
      legacyPaths.push(pathname);
      assert.equal(request.headers()['x-kiosk-pin'], '1357');
      await route.fulfill({
        json: { students: [{ id: 'legacy-student', firstName: 'Grace', lastName: 'Legacy' }] },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await legacyPage.goto(`http://127.0.0.1:${address.port}/passpilot/kiosk/simple?school=legacy-school`);
  await legacyPage.getByText('Legacy, Grace', { exact: true }).waitFor({ timeout: 10_000 });
  const legacySessionIndex = legacyPaths.indexOf('/api/passpilot/kiosk/session');
  const legacySnapshotIndex = legacyPaths.indexOf('/api/passpilot/kiosk/snapshot', legacySessionIndex + 1);
  const legacyConfigIndex = legacyPaths.indexOf('/api/passpilot/kiosk/config', legacySnapshotIndex + 1);
  const legacyStudentsIndex = legacyPaths.indexOf('/api/passpilot/kiosk/students', legacyConfigIndex + 1);
  assert.equal(legacyPaths.includes('/api/passpilot/kiosk/auth'), true);
  assert.equal(legacySessionIndex >= 0, true);
  assert.equal(legacySnapshotIndex > legacySessionIndex, true);
  assert.equal(legacyConfigIndex > legacySnapshotIndex, true);
  assert.equal(legacyStudentsIndex > legacyConfigIndex, true);

  await legacyPage.close();
  legacyPage = null;

  for (const layout of [
    {
      name: 'simple',
      path: '/passpilot/kiosk/simple',
      kioskStyle: 'simple',
      sessionStorageKey: 'pp_kiosk_session_simple',
    },
    {
      name: 'badge',
      path: '/passpilot/kiosk',
      kioskStyle: 'badge',
      sessionStorageKey: 'pp_kiosk_session_badge',
    },
  ]) {
    resumeRacePage = await browser.newPage();
    await resumeRacePage.addInitScript(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.localStorage.setItem('pp_kiosk_pin', '8642');
    });

    const schoolId = `resume-race-${layout.name}`;
    const bootSessionId = `boot-${layout.name}`;
    const resumedSessionId = `resumed-${layout.name}`;
    let releaseOldPoll;
    const oldPollRelease = new Promise((resolve) => { releaseOldPoll = resolve; });
    let markOldPollStarted;
    const oldPollStarted = new Promise((resolve) => { markOldPollStarted = resolve; });
    let markResumeReturned;
    const resumeReturned = new Promise((resolve) => { markResumeReturned = resolve; });
    let markFreshPollStarted;
    const freshPollStarted = new Promise((resolve) => { markFreshPollStarted = resolve; });

    await resumeRacePage.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const requestSessionId = request.headers()['x-kiosk-session'];
      if (pathname === '/api/auth/me') {
        await route.fulfill({ status: 401, json: { error: 'Not signed in' } });
        return;
      }
      if (pathname === '/api/passpilot/kiosk/auth') {
        await route.fulfill({ json: { token: `token-${layout.name}`, expiresInSeconds: 900 } });
        return;
      }
      if (pathname === '/api/passpilot/kiosk/session') {
        await route.fulfill({
          status: 201,
          json: {
            kioskStyle: layout.kioskStyle,
            session: {
              id: bootSessionId,
              status: 'unclaimed',
              claimCode: '321654',
              source: 'classpilot_groups',
              classId: layout.name === 'badge' ? 'old-class' : null,
            },
            resume: { kioskName: 'Current Kiosk', className: 'Current Class' },
          },
        });
        return;
      }
      if (pathname === '/api/passpilot/kiosk/session/resume') {
        await route.fulfill({
          status: 201,
          json: {
            kioskStyle: layout.kioskStyle,
            session: {
              id: resumedSessionId,
              status: 'active',
              claimCode: null,
              source: 'classpilot_groups',
              classId: 'new-class',
              className: 'New Class',
              kioskName: 'New Kiosk',
            },
          },
        });
        markResumeReturned();
        return;
      }
      if (
        requestSessionId === bootSessionId
        && (pathname === '/api/passpilot/kiosk/config' || pathname === '/api/passpilot/kiosk/snapshot')
      ) {
        markOldPollStarted();
        await oldPollRelease;
        await route.fulfill({
          status: 200,
          headers: pathname.endsWith('/snapshot') ? { ETag: '"stale-etag"' } : {},
          json: pathname.endsWith('/snapshot')
            ? {
                revision: 1,
                kioskStyle: layout.kioskStyle,
                config: {
                  source: 'classpilot_groups',
                  classId: 'old-class',
                  className: 'Stale Class',
                  kioskName: 'Stale Kiosk',
                },
                session: { id: bootSessionId, status: 'unclaimed', claimCode: '321654' },
                roster: { students: [] },
                passes: [],
              }
            : {
                revision: 1,
                kioskStyle: layout.kioskStyle,
                source: null,
                classId: null,
                session: { id: bootSessionId, status: 'unclaimed', claimCode: '321654' },
              },
        }).catch(() => {});
        return;
      }
      if (pathname === '/api/passpilot/kiosk/snapshot' && requestSessionId === resumedSessionId) {
        markFreshPollStarted();
        await route.fulfill({
          status: 200,
          headers: { ETag: '"fresh-etag"' },
          json: {
            revision: 2,
            kioskStyle: layout.kioskStyle,
            config: {
              source: 'classpilot_groups',
              classId: 'new-class',
              className: 'New Class',
              kioskName: 'New Kiosk',
            },
            session: {
              id: resumedSessionId,
              status: 'active',
              source: 'classpilot_groups',
              classId: 'new-class',
              className: 'New Class',
              kioskName: 'New Kiosk',
            },
            roster: { students: [] },
            passes: [],
          },
        });
        return;
      }
      await route.fulfill({ status: 404, json: { error: 'Not found' } });
    });

    await resumeRacePage.goto(`http://127.0.0.1:${address.port}${layout.path}?school=${schoolId}`);
    const resumeButton = resumeRacePage.getByTestId('kiosk-resume-button');
    await resumeButton.waitFor({ timeout: 10_000 });
    await oldPollStarted;
    await resumeButton.click();
    await resumeReturned;
    releaseOldPoll();
    await freshPollStarted;
    await resumeRacePage.getByText('New Class — New Kiosk', { exact: true }).waitFor({ timeout: 10_000 });
    await resumeRacePage.waitForTimeout(100);
    assert.equal(
      await resumeRacePage.evaluate((key) => window.localStorage.getItem(key), layout.sessionStorageKey),
      resumedSessionId,
      `${layout.name} resume must persist the new session before stale polling can settle`,
    );
    assert.equal(
      await resumeRacePage.getByTestId('kiosk-claim-code').count(),
      0,
      `${layout.name} stale polling must not restore the pre-resume claim screen`,
    );
    await resumeRacePage.close();
    resumeRacePage = null;
  }

  process.stdout.write('PassPilot kiosk controller browser regression passed.\n');
} finally {
  await page?.close().catch(() => {});
  await legacyPage?.close().catch(() => {});
  await resumeRacePage?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await vite.close();
}
