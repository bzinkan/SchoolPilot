import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// The PassPilot kiosk follows the theme the server resolved for the teacher it
// is bound to. Presentation only: sign-out and return keep working under a
// theme, the theme leaves when the server stops sending it, and an uploaded
// background is fetched with the kiosk's own credential and falls back to the
// flat theme color when it cannot be loaded.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function fixture(t) {
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await vite.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('pp_kiosk_pin', '4321'));
  return { page, errors, url: `http://127.0.0.1:${vite.httpServer.address().port}` };
}

function kioskServer(layout) {
  const students = [
    { id: 'ada', firstName: 'Ada', lastName: 'Student', studentIdNumber: '1234', canReturn: true },
    { id: 'max', firstName: 'Maximiliana-Jo', lastName: 'Long', studentIdNumber: '5678', canReturn: true },
  ];
  const state = { theme: { kind: 'preset', preset: 'halloween' }, revision: 1, passes: [], assetStatus: 200, assetHeaders: [], requests: [] };
  const activePass = id => state.passes.find(pass => pass.studentId === id) ?? null;
  const snapshot = () => ({
    kioskStyle: layout, theme: state.theme, source: 'classpilot_groups', classId: 'class-a', className: 'Biology', kioskName: 'Hall Kiosk',
    session: { id: 'session', status: 'active' }, revision: state.revision, assignmentRevision: 'assignment-1',
    students: students.map(student => ({ ...student, ...(activePass(student.id) ? { activePass: activePass(student.id) } : {}) })),
  });
  const handler = async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    state.requests.push({ method: request.method(), pathname });
    if (pathname === '/api/auth/me') return route.fulfill({ status: 401, json: { error: 'Not signed in' } });
    if (pathname.endsWith('/kiosk/auth')) return route.fulfill({ json: { token: 'fixture-token', expiresInSeconds: 900 } });
    if (pathname.endsWith('/kiosk/session')) {
      return route.fulfill({ json: { kioskStyle: layout, theme: state.theme,
        session: { id: 'session', status: 'active', source: 'classpilot_groups', classId: 'class-a', className: 'Biology', kioskName: 'Hall Kiosk' } } });
    }
    if (pathname.endsWith('/kiosk/snapshot')) return route.fulfill({ headers: { ETag: `"snapshot-${state.revision}"` }, json: snapshot() });
    if (pathname.includes('/kiosk/theme-asset/')) {
      state.assetHeaders.push(request.headers());
      if (state.assetStatus !== 200) return route.fulfill({ status: state.assetStatus, json: { error: 'Not available' } });
      return route.fulfill({ status: 200, contentType: 'image/png', body: TINY_PNG });
    }
    if (pathname.endsWith('/kiosk/lookup')) {
      const student = students.find(item => item.studentIdNumber === request.postDataJSON().studentIdNumber) ?? students[0];
      return route.fulfill({ json: { student, activePass: activePass(student.id), classId: 'class-a', assignmentRevision: 'assignment-1' } });
    }
    if (pathname.endsWith('/kiosk/checkout')) {
      const body = request.postDataJSON();
      const pass = { id: `pass-${body.studentId}`, studentId: body.studentId, destination: body.destination, status: 'active', duration: 5,
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), returnedAt: null };
      state.passes.push(pass); state.revision += 1;
      return route.fulfill({ status: 201, json: { pass } });
    }
    if (pathname.endsWith('/kiosk/checkin')) {
      state.passes = state.passes.filter(pass => pass.studentId !== request.postDataJSON().studentId); state.revision += 1;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  };
  return { state, handler };
}

const themeImage = page => page.locator('[data-kiosk-theme]').evaluate(element => element.style.getPropertyValue('--kiosk-image'));

test('the simple kiosk shows the bound teacher\'s theme, names on plates, drops it when the server stops sending it and gates uploaded images', async t => {
  const { page, url, errors } = await fixture(t);
  const { state, handler } = kioskServer('simple');
  await page.route('**/api/**', handler);
  await page.goto(`${url}/passpilot/kiosk/simple?school=school-a`);

  await page.locator('[data-kiosk-theme="halloween"]').waitFor();
  assert.equal(await themeImage(page), 'url("/themes/halloween.svg")');
  await page.getByRole('button', { name: /Student, Ada/ }).waitFor();
  assert.equal(await page.getByTestId('kiosk-theme-tag').count(), 2, 'one tag per roster row');
  assert.ok(await page.locator('header.kiosk-glass').isVisible());

  // Sign out: the plate carries the first name, the copy is unchanged.
  await page.getByRole('button', { name: /Student, Ada/ }).click();
  await page.getByRole('button', { name: 'General/Restroom', exact: true }).click();
  const feedback = page.getByTestId('kiosk-feedback');
  await feedback.filter({ hasText: 'Pass issued!' }).waitFor();
  const plate = feedback.getByTestId('kiosk-name-plate');
  assert.equal(await plate.getAttribute('aria-label'), 'Ada, carved on a jack-o-lantern');
  assert.equal(await plate.getAttribute('data-plate'), 'pumpkin');
  assert.equal(await plate.locator('text').textContent(), 'Ada');

  // Return: the greeting uses the first name.
  const outRow = page.getByRole('button', { name: /Student, Ada.*Tap to return/s });
  await outRow.waitFor();
  await outRow.click();
  await feedback.filter({ hasText: 'Happy Halloween, Ada!' }).waitFor();

  // A 14-character first name stays inside the plate.
  await page.getByRole('button', { name: /Long, Maximiliana-Jo/ }).click();
  await page.getByRole('button', { name: 'Nurse', exact: true }).click();
  await feedback.filter({ hasText: 'Pass issued!' }).waitFor();
  const longPlate = feedback.getByTestId('kiosk-name-plate');
  assert.equal(await longPlate.locator('text').textContent(), 'Maximiliana-Jo');
  const width = await longPlate.locator('text').evaluate(element => element.getBBox().width);
  assert.ok(width <= 152, `name width ${width} stays inside the 150-unit band`);

  // The server stops sending a theme (teacher switched to Default or the kiosk retargeted).
  state.theme = null; state.revision += 1;
  await page.locator('[data-kiosk-theme]').waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('kiosk-theme-tag').count(), 0);
  await page.getByRole('button', { name: /Student, Ada/ }).waitFor();

  // An uploaded background arrives through the kiosk credential, never a public URL.
  state.theme = { kind: 'image', imageAssetId: 'asset-1' }; state.revision += 1;
  await page.locator('[data-kiosk-theme="image"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-kiosk-theme]')?.style.getPropertyValue('--kiosk-image').startsWith('url("blob:'));
  assert.equal(state.assetHeaders.length, 1);
  assert.equal(state.assetHeaders[0]['x-kiosk-token'], 'fixture-token');
  assert.equal(state.assetHeaders[0]['x-kiosk-session'], 'session');
  assert.equal(state.assetHeaders[0]['x-kiosk-pin'], undefined);

  // A blocked image leaves the flat theme color; nothing breaks.
  state.assetStatus = 404; state.theme = { kind: 'image', imageAssetId: 'asset-2' }; state.revision += 1;
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-kiosk-theme="image"]');
    return element && element.style.getPropertyValue('--kiosk-image') === '';
  });
  assert.equal(state.assetHeaders.length, 2, 'the second asset was requested and refused');
  await page.getByRole('button', { name: /Student, Ada/ }).waitFor();

  assert.ok(!state.requests.some(row => row.pathname.includes('/commands')), 'themes never send a student command');
  assert.deepEqual(errors, []);
});

test('the badge kiosk puts its cards on glass and shows the plate on the confirmation', async t => {
  const { page, url, errors } = await fixture(t);
  const { handler } = kioskServer('badge');
  await page.route('**/api/**', handler);
  await page.goto(`${url}/passpilot/kiosk?school=school-a`);

  await page.locator('[data-kiosk-theme="halloween"]').waitFor();
  await page.getByPlaceholder('Student ID').waitFor();
  assert.ok((await page.locator('.kiosk-glass').count()) >= 1, 'the scan card sits on glass');

  await page.getByPlaceholder('Student ID').fill('1234');
  await page.getByPlaceholder('Student ID').press('Enter');
  await page.getByRole('heading', { name: 'Ada Student' }).waitFor();
  await page.getByRole('button', { name: /Bathroom/ }).click();
  await page.getByText('Pass issued! Heading to bathroom.', { exact: true }).waitFor();
  const plate = page.getByTestId('kiosk-name-plate');
  assert.equal(await plate.getAttribute('aria-label'), 'Ada, carved on a jack-o-lantern');

  // Back at the scan screen, the return greets by name.
  await page.getByPlaceholder('Student ID').waitFor();
  await page.getByPlaceholder('Student ID').fill('1234');
  await page.getByPlaceholder('Student ID').press('Enter');
  await page.getByRole('button', { name: 'Check In (Return Pass)' }).click();
  await page.getByText('Happy Halloween, Ada! Pass returned.', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('kiosk-name-plate').getAttribute('aria-label'), 'Ada, carved on a jack-o-lantern');
  assert.deepEqual(errors, []);
});
