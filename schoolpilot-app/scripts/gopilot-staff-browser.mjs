#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const baseURL = 'http://127.0.0.1:4174';
const schoolId = 'browser-gopilot-school';

function startPreview() {
  if (!existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Build GoPilot before running browser tests.');
  return spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForPreview(process) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Preview exited with ${process.exitCode}.`);
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Preview did not become ready.');
}

async function stopPreview(process) {
  if (!process || process.exitCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => process.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.exitCode === null) process.kill('SIGKILL');
}

function auth(role) {
  return {
    activeSchoolId: schoolId,
    user: { id: `${role}-user`, email: `${role}@example.invalid`, firstName: 'Browser', lastName: 'Staff' },
    memberships: [{
      id: `${role}-membership`, schoolId, schoolName: 'Browser Test School', schoolSlug: 'browser-test-school',
      schoolTimezone: 'America/New_York', dismissalTime: '15:00', role: role === 'office_staff' ? 'teacher' : role,
      gopilotRole: role,
    }],
    licenses: { classPilot: false, passPilot: false, goPilot: true },
  };
}

async function preparePage(browser, role, handler, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ baseURL, viewport, serviceWorkers: 'block' });
  await context.addInitScript((id) => window.localStorage.setItem('sp_activeSchoolId', id), schoolId);
  const page = await context.newPage();
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(auth(role)) });
      return;
    }
    if (url.pathname === '/api/auth/csrf') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ csrfToken: 'browser-csrf' }) });
      return;
    }
    await handler(route, request, url);
  });
  return { context, page };
}

async function testSettings(browser) {
  let getCount = 0;
  let patchCount = 0;
  let lastPatch = null;
  let lastCalendarPut = null;
  const calendarStates = new Map();
  let latestSettings = {
    dismissalTime: null, schoolTimezone: 'America/New_York', autoStartEnabled: false, pickupZones: [{ id: 'main', name: 'Main loop' }], revision: 3,
  };

  const { context, page } = await preparePage(browser, 'admin', async (route, request, url) => {
    const emptyResponses = new Map([
      ['/api/gopilot/students', { students: [] }],
      [`/api/schools/${schoolId}/homerooms`, { homerooms: [] }],
      [`/api/schools/${schoolId}/staff`, { staff: [] }],
    ]);
    if (emptyResponses.has(url.pathname)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyResponses.get(url.pathname)) });
      return;
    }
    if (url.pathname === '/api/gopilot/settings' && request.method() === 'GET') {
      getCount += 1;
      if (getCount === 1) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Settings temporarily unavailable' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(latestSettings) });
      return;
    }
    if (url.pathname === '/api/gopilot/settings' && request.method() === 'PATCH') {
      patchCount += 1;
      lastPatch = request.postDataJSON();
      if (patchCount === 2) {
        latestSettings = { ...latestSettings, dismissalTime: '15:25', revision: 5 };
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Settings revision conflict' }) });
        return;
      }
      latestSettings = { ...lastPatch, revision: 4 };
      delete latestSettings.expectedRevision;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(latestSettings) });
      return;
    }
    if (url.pathname === '/api/gopilot/instructional-calendar' && request.method() === 'GET') {
      const month = url.searchParams.get('month');
      const current = calendarStates.get(month) || {
        month,
        schoolTimezone: 'America/New_York',
        schoolLocalToday: `${month}-01`,
        nonInstructionalDates: [],
        revision: 0,
        updatedAt: null,
      };
      calendarStates.set(month, current);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
      return;
    }
    if (url.pathname.startsWith('/api/gopilot/instructional-calendar/') && request.method() === 'PUT') {
      const month = url.pathname.split('/').at(-1);
      lastCalendarPut = request.postDataJSON();
      const current = calendarStates.get(month);
      const saved = {
        ...current,
        nonInstructionalDates: lastCalendarPut.nonInstructionalDates,
        revision: current.revision + 1,
        updatedAt: '2026-08-12T12:00:00.000Z',
      };
      calendarStates.set(month, saved);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected ${request.method()} ${url.pathname}` }) });
  });

  try {
    await page.goto('/gopilot/setup', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Dismissal settings are unavailable' }).waitFor();
    await page.getByText(/No settings can be edited or saved/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save settings' }).count(), 0);
    await page.getByRole('button', { name: 'Retry loading settings' }).click();
    await page.getByRole('heading', { name: 'Dismissal settings' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Remove Main loop' }).isDisabled(), true);
    assert.equal(await page.locator('#gopilot-dismissal-time').inputValue(), '');
    await page.getByRole('button', { name: 'Add zone' }).click();
    await page.getByPlaceholder('Pickup zone 2').fill('North lot');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved and verified (revision 4).').waitFor();
    assert.equal(lastPatch.expectedRevision, 3);
    assert.equal(lastPatch.autoStartEnabled, false);
    assert.equal(lastPatch.dismissalTime, null);
    assert.deepEqual(lastPatch.pickupZones.map((zone) => zone.name), ['Main loop', 'North lot']);
    assert.match(lastPatch.pickupZones[1].id, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    assert.ok(lastPatch.pickupZones[1].id.length <= 16, 'new pickup-zone ID must satisfy the API contract');

    await page.locator('#gopilot-dismissal-time').fill('15:20');
    await page.getByRole('switch', { name: 'Auto-start dismissal' }).click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText(/Another administrator saved settings first/).waitFor();
    await page.getByRole('button', { name: 'Reload latest settings' }).click();
    await page.getByText('Saved revision 5').waitFor();
    assert.equal(await page.locator('#gopilot-dismissal-time').inputValue(), '15:25');

    await page.getByRole('heading', { name: 'Instructional calendar' }).waitFor();
    const editableCalendarDay = page.locator('button[data-testid^="calendar-day-"]:not([disabled])').first();
    await editableCalendarDay.click();
    await page.getByText('Calendar has unsaved changes').waitFor();
    await page.getByRole('button', { name: 'Save Month' }).click();
    await page.getByText('Calendar changes saved').waitFor();
    assert.equal(lastCalendarPut.expectedRevision, 0);
    assert.equal(lastCalendarPut.nonInstructionalDates.length, 1);

    await page.locator('#gopilot-dismissal-time').fill('15:30');
    page.once('dialog', async (dialog) => {
      assert.match(dialog.message(), /Discard unsaved GoPilot settings/);
      await dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Authorized Pickups', exact: true }).click();
    await page.getByRole('heading', { name: 'Dismissal settings' }).waitFor();
    assert.equal(await page.locator('#gopilot-dismissal-time').inputValue(), '15:30');
  } finally {
    await context.close();
  }
}

async function testArrivals(browser) {
  const sessionId = 'browser-session';
  const arrivals = [];
  let queue = [];
  const { context, page } = await preparePage(browser, 'office_staff', async (route, request, url) => {
    const pathname = url.pathname;
    if (pathname === `/api/schools/${schoolId}/sessions/today`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: { id: sessionId, status: 'active' } }) });
    if (pathname === `/api/schools/${schoolId}/homerooms`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ homerooms: [] }) });
    if (pathname === `/api/schools/${schoolId}/custody-alerts`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ alerts: [] }) });
    if (pathname === '/api/gopilot/settings') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dismissalTime: '15:00', schoolTimezone: 'America/New_York', autoStartEnabled: false, pickupZones: [{ id: 'main', name: 'Main loop' }], revision: 1 }) });
    if (pathname === '/api/pickups/all') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pickups: [] }) });
    if (pathname === `/api/schools/${schoolId}/bus-routes`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [] }) });
    if (pathname === '/api/gopilot/students') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ students: [] }) });
    if (pathname === `/api/sessions/${sessionId}/queue`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ queue }) });
    if (pathname === `/api/sessions/${sessionId}/stats`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ waiting: queue.length, total: queue.length }) });
    if (pathname === `/api/sessions/${sessionId}/overrides`) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ overrides: [] }) });
    if (pathname === `/api/gopilot/dismissal/sessions/${sessionId}/arrival-candidates`) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ id: 'student-no-car', firstName: 'Noah', lastName: 'Walker', gradeLevel: '4', familyName: 'Walker family', carNumber: '' }] }) });
    }
    if (pathname === `/api/gopilot/dismissal/sessions/${sessionId}/arrivals` && request.method() === 'POST') {
      const body = request.postDataJSON();
      arrivals.push(body);
      const student = body.source === 'staff_search'
        ? { id: 'queue-search', studentId: 'student-no-car', firstName: 'Noah', lastName: 'Walker', pickupGroupLabel: 'Walker family', checkInMethod: 'staff_search' }
        : { id: 'queue-car', studentId: 'student-car', firstName: 'Casey', lastName: 'Car', pickupGroupLabel: 'Car #142', checkInMethod: 'staff_car_number' };
      if (!queue.some((entry) => entry.id === student.id)) queue = [...queue, { ...student, grade: '4', status: 'waiting', position: queue.length + 1, check_in_time: new Date().toISOString() }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outcome: 'created', groupLabel: body.source === 'staff_search' ? 'Selected students' : 'Car #142', entries: [{ ...student, studentName: `${student.firstName} ${student.lastName}` }], skippedAbsent: [] }) });
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected ${request.method()} ${pathname}` }) });
  });

  try {
    await page.goto('/gopilot', { waitUntil: 'networkidle' });
    await page.getByPlaceholder('e.g. 142').last().fill('142');
    await page.getByPlaceholder('e.g. 142').last().press('Enter');
    await page.getByText(/Car #142 — added: Casey Car/).last().waitFor();
    assert.deepEqual(arrivals[0], { source: 'staff_car_number', carNumber: '142' });

    await page.getByRole('button', { name: 'Search arrivals' }).last().click();
    await page.getByPlaceholder('Student, family, or car number').fill('Noah');
    await page.getByText('Noah Walker', { exact: true }).waitFor();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Add selected arrivals' }).click();
    await page.getByText('Noah Walker', { exact: true }).waitFor();
    assert.deepEqual(arrivals[1], { source: 'staff_search', studentIds: ['student-no-car'] });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Search arrivals' }).first().waitFor({ state: 'visible' });
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  } finally {
    await context.close();
  }
}

async function testOfficeRoleRouting(browser) {
  let narrowRosterCalls = 0;
  let genericRosterCalls = 0;
  const { context, page } = await preparePage(browser, 'office_staff', async (route, _request, url) => {
    if (url.pathname === '/api/pickups/all') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pickups: [] }) });
      return;
    }
    if (url.pathname === '/api/gopilot/students') {
      narrowRosterCalls += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ students: [{ id: 'safe-student', firstName: 'Safe', lastName: 'Roster', gradeLevel: '4', homeroomId: null, homeroomName: null }] }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/students`) genericRosterCalls += 1;
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected ${url.pathname}` }) });
  });

  try {
    await page.goto('/gopilot/setup', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Authorized pickups' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Staff', exact: true }).count(), 0);
    assert.equal(narrowRosterCalls, 1);
    assert.equal(genericRosterCalls, 0);
  } finally {
    await context.close();
  }
}

async function testCanonicalRosterCreate(browser) {
  let roster = [];
  let createBody = null;
  let genericRosterCalls = 0;
  const { context, page } = await preparePage(browser, 'admin', async (route, request, url) => {
    if (url.pathname === '/api/gopilot/students' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ students: roster }) });
      return;
    }
    if (url.pathname === '/api/gopilot/students' && request.method() === 'POST') {
      createBody = request.postDataJSON();
      const student = {
        id: 'canonical-student',
        ...createBody,
        homeroomId: null,
        homeroomName: null,
        status: 'active',
      };
      roster = [student];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ student }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/homerooms`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ homerooms: [] }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/staff`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/students`) genericRosterCalls += 1;
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected ${request.method()} ${url.pathname}` }) });
  });

  try {
    await page.goto('/gopilot/setup', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Student Roster', exact: true }).click();
    await page.getByRole('button', { name: 'Add Student', exact: true }).click();
    await page.getByLabel('First Name *').fill('Avery');
    await page.getByLabel('Last Name *').fill('Canonical');
    await page.getByLabel('Email').fill('avery@example.invalid');
    await page.getByLabel('Grade').selectOption('4');
    await page.getByLabel('Dismissal').selectOption('walker');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Avery Canonical', { exact: true }).waitFor();
    assert.deepEqual(createBody, {
      firstName: 'Avery',
      lastName: 'Canonical',
      email: 'avery@example.invalid',
      gradeLevel: '4',
      dismissalType: 'walker',
      busRoute: '',
    });
    assert.equal(genericRosterCalls, 0);
  } finally {
    await context.close();
  }
}

async function testStaffMembershipMutations(browser) {
  const membershipId = 'membership-created';
  const userId = 'user-created';
  const mutationPaths = [];
  let createBody = null;
  let updateBody = null;
  let staffRows = [];
  const { context, page } = await preparePage(browser, 'admin', async (route, request, url) => {
    if (url.pathname === '/api/gopilot/students') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ students: [] }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/homerooms`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ homerooms: [] }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/staff` && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: staffRows }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/staff` && request.method() === 'POST') {
      createBody = request.postDataJSON();
      const user = { id: userId, email: createBody.email, firstName: createBody.firstName, lastName: createBody.lastName };
      const membership = { id: membershipId, userId, role: createBody.role, gopilotRole: createBody.gopilotRole || null };
      staffRows = [{ ...membership, user }];
      mutationPaths.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ user, membership }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/staff/${membershipId}` && request.method() === 'PUT') {
      updateBody = request.postDataJSON();
      const current = staffRows[0];
      staffRows = [{
        ...current,
        role: updateBody.role || current.role,
        gopilotRole: Object.prototype.hasOwnProperty.call(updateBody, 'gopilotRole') ? updateBody.gopilotRole : current.gopilotRole,
        user: { ...current.user, firstName: updateBody.firstName, lastName: updateBody.lastName },
      }];
      mutationPaths.push(`${request.method()} ${url.pathname}`);
      const { user: _user, ...membership } = staffRows[0];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ membership }) });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/staff/${membershipId}` && request.method() === 'DELETE') {
      staffRows = [];
      mutationPaths.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    if (url.pathname.includes(userId)) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'User ID used where membership ID is required' }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected ${request.method()} ${url.pathname}` }) });
  });

  try {
    await page.goto('/gopilot/setup', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add Staff', exact: true }).click();
    await page.getByPlaceholder('Email *').fill('avery.staff@example.invalid');
    await page.getByPlaceholder('First Name *').fill('Avery');
    await page.getByPlaceholder('Last Name *').fill('Membership');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Avery Membership', { exact: true }).waitFor();
    assert.deepEqual(createBody, {
      email: 'avery.staff@example.invalid',
      firstName: 'Avery',
      lastName: 'Membership',
      role: 'teacher',
      password: '',
    });

    await page.getByRole('button', { name: 'Edit Avery Membership' }).click();
    await page.getByPlaceholder('First').fill('Ava');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Ava Membership', { exact: true }).waitFor();
    assert.deepEqual(updateBody, {
      firstName: 'Ava',
      lastName: 'Membership',
      gopilotRole: null,
    });

    page.once('dialog', async (dialog) => {
      assert.match(dialog.message(), /lose access to every SchoolPilot product at this school/);
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Remove Ava Membership' }).click();
    await page.getByText('Ava Membership', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(mutationPaths, [
      `POST /api/schools/${schoolId}/staff`,
      `PUT /api/schools/${schoolId}/staff/${membershipId}`,
      `DELETE /api/schools/${schoolId}/staff/${membershipId}`,
    ]);
    assert.ok(mutationPaths.every((path) => !path.includes(userId)));
  } finally {
    await context.close();
  }
}

async function main() {
  const preview = startPreview();
  let browser;
  try {
    await waitForPreview(preview);
    browser = await chromium.launch({ headless: true });
    await testSettings(browser);
    process.stdout.write('gopilot_browser_passed settings persistence, revision conflict, and instructional calendar\n');
    await testArrivals(browser);
    process.stdout.write('gopilot_browser_passed car-number and direct-search arrivals, mobile and keyboard\n');
    await testOfficeRoleRouting(browser);
    process.stdout.write('gopilot_browser_passed office role routing and narrow student DTO\n');
    await testCanonicalRosterCreate(browser);
    process.stdout.write('gopilot_browser_passed canonical staff roster create\n');
    await testStaffMembershipMutations(browser);
    process.stdout.write('gopilot_browser_passed staff create, edit, and remove use membership IDs\n');
  } finally {
    await browser?.close();
    await stopPreview(preview);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
