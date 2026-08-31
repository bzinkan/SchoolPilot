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
const baseUrl = `http://127.0.0.1:${address.port}`;

let browser;
try {
  browser = await chromium.launch({ headless: true });

  for (const kioskPath of ['/passpilot/kiosk', '/passpilot/kiosk/simple']) {
    const page = await browser.newPage();
    await page.route('**/api/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/auth/me') {
        await route.fulfill({ status: 401, json: { error: 'Not signed in' } });
        return;
      }
      await route.fulfill({ status: 503, json: { error: 'Offline for exit regression' } });
    });

    await page.goto(baseUrl);
    await page.evaluate(() => {
      window.sessionStorage.setItem('pp_kiosk_pin', '2468');
      window.sessionStorage.setItem('pp_kiosk_session_simple', 'simple-session');
      window.sessionStorage.setItem('pp_kiosk_session_badge', 'badge-session');
      window.localStorage.setItem('pp_kiosk_device:school-1', '11111111-1111-4111-8111-111111111111');
      window.localStorage.setItem('unrelated-kiosk-continuity', 'keep-me');
    });

    await page.goto(`${baseUrl}${kioskPath}?school=school-1&launch=gate#launchTicket=temporary-ticket`);
    const exitButton = page.getByTestId('gate-kiosk-exit');
    await exitButton.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(
      await exitButton.getAttribute('aria-label'),
      'Exit kiosk mode and return to ClassPilot sign-in',
    );
    const box = await exitButton.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, 'the exit control must have a 44px touch target');

    await Promise.all([
      page.waitForURL(`${baseUrl}/`, { timeout: 10_000 }),
      exitButton.click(),
    ]);

    const storage = await page.evaluate(() => ({
      pin: window.sessionStorage.getItem('pp_kiosk_pin'),
      simpleSession: window.sessionStorage.getItem('pp_kiosk_session_simple'),
      badgeSession: window.sessionStorage.getItem('pp_kiosk_session_badge'),
      device: window.localStorage.getItem('pp_kiosk_device:school-1'),
      unrelated: window.localStorage.getItem('unrelated-kiosk-continuity'),
    }));
    assert.deepEqual(storage, {
      pin: null,
      simpleSession: null,
      badgeSession: null,
      device: '11111111-1111-4111-8111-111111111111',
      unrelated: 'keep-me',
    });
    await page.close();
  }

  const normalKioskPage = await browser.newPage();
  await normalKioskPage.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: pathname === '/api/auth/me' ? 401 : 503,
      json: { error: 'Not signed in' },
    });
  });
  await normalKioskPage.goto(`${baseUrl}/passpilot/kiosk/simple?school=school-1`);
  assert.equal(
    await normalKioskPage.getByTestId('gate-kiosk-exit').count(),
    0,
    'normal kiosk pages must not gain the ClassPilot gate exit control',
  );
  await normalKioskPage.close();

  process.stdout.write('PassPilot gate kiosk exit browser regression passed.\n');
} finally {
  await browser?.close().catch(() => {});
  await vite.close();
}
