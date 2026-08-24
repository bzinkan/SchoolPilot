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
  const replacementMembershipId = 'membership-replacement';
  const formerMembershipId = 'membership-former';
  const adminMembershipId = 'membership-base-admin';
  const mutationPaths = [];
  const createBodies = [];
  const transitionBodies = [];
  let emailPatchCount = 0;
  let impactGetCount = 0;
  let transitionPostCount = 0;
  let updateBody = null;
  let adminUpdateBody = null;
  let staffRows = [
    {
      id: membershipId,
      userId,
      role: 'teacher',
      gopilotRole: null,
      status: 'active',
      user: { id: userId, email: 'avery.staff@example.invalid', firstName: 'Avery', lastName: 'Membership' },
    },
    {
      id: replacementMembershipId,
      userId: 'user-replacement',
      role: 'parent',
      gopilotRole: 'teacher',
      status: 'active',
      user: { id: 'user-replacement', email: 'bailey@example.invalid', firstName: 'Bailey', lastName: 'Replacement' },
    },
    {
      id: adminMembershipId,
      userId: 'user-base-admin',
      role: 'admin',
      gopilotRole: null,
      status: 'active',
      user: { id: 'user-base-admin', email: 'admin-base@example.invalid', firstName: 'Admin', lastName: 'Base' },
    },
  ];
  const formerRow = {
    id: formerMembershipId,
    membershipId: formerMembershipId,
    userId: 'user-former',
    role: 'teacher',
    gopilotRole: null,
    status: 'inactive',
    user: { id: 'user-former', email: 'former@example.invalid', firstName: 'Former', lastName: 'Teacher' },
  };
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
      const createBody = request.postDataJSON();
      createBodies.push(createBody);
      mutationPaths.push(`${request.method()} ${url.pathname}`);

      if (createBody.email === 'twin@example.invalid' && createBody.confirmDistinctPerson !== true) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'POSSIBLE_DUPLICATE_STAFF',
            error: 'A staff member with this name already exists.',
            candidates: [{ ...staffRows[0], membershipId }],
          }),
        });
        return;
      }
      if (createBody.email === 'former@example.invalid') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'STAFF_REACTIVATION_REQUIRED',
            error: 'Reactivate the existing staff identity.',
            membershipId: formerMembershipId,
            candidates: [formerRow],
          }),
        });
        return;
      }

      const distinctId = 'membership-distinct';
      const distinctUserId = 'user-distinct';
      const user = { id: distinctUserId, email: createBody.email, firstName: createBody.firstName, lastName: createBody.lastName };
      const membership = { id: distinctId, userId: distinctUserId, role: createBody.role, gopilotRole: createBody.gopilotRole || null, status: 'active' };
      staffRows = [...staffRows, { ...membership, user }];
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ user, membership }) });
      return;
    }
    const staffPutMatch = url.pathname.match(new RegExp(`^/api/schools/${schoolId}/staff/([^/]+)$`));
    if (staffPutMatch && request.method() === 'PUT') {
      const targetMembershipId = staffPutMatch[1];
      const body = request.postDataJSON();
      if (targetMembershipId === membershipId) updateBody = body;
      if (targetMembershipId === adminMembershipId) adminUpdateBody = body;
      staffRows = staffRows.map((current) => current.id === targetMembershipId ? {
        ...current,
        role: body.role || current.role,
        gopilotRole: Object.prototype.hasOwnProperty.call(body, 'gopilotRole') ? body.gopilotRole : current.gopilotRole,
        user: {
          ...current.user,
          firstName: body.firstName ?? current.user.firstName,
          lastName: body.lastName ?? current.user.lastName,
        },
      } : current);
      mutationPaths.push(`${request.method()} ${url.pathname}`);
      const { user: _user, ...membership } = staffRows.find((row) => row.id === targetMembershipId);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ membership }) });
      return;
    }

    if (url.pathname === `/api/schools/${schoolId}/staff/${membershipId}/email` && request.method() === 'PATCH') {
      emailPatchCount += 1;
      const body = request.postDataJSON();
      mutationPaths.push(`${request.method()} ${url.pathname}`);
      if (emailPatchCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ userId, email: 'server-returned-a-different-address@example.invalid' }),
        });
        return;
      }
      staffRows = staffRows.map((row) => row.id === membershipId
        ? { ...row, user: { ...row.user, email: body.email } }
        : row);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ userId, email: body.email }) });
      return;
    }

    if (url.pathname === `/api/schools/${schoolId}/staff/${formerMembershipId}/reactivate` && request.method() === 'POST') {
      staffRows = [...staffRows, { ...formerRow, status: 'active' }];
      mutationPaths.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ membership: { ...formerRow, status: 'active' } }) });
      return;
    }

    if (url.pathname === `/api/schools/${schoolId}/staff/${membershipId}/assignment-impact` && request.method() === 'GET') {
      impactGetCount += 1;
      const blocked = impactGetCount === 1;
      const revision = transitionPostCount > 0 ? 'revision-refreshed' : 'revision-reviewed';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          impact: {
            revision,
            assignments: [
              {
                assignmentType: 'gopilot_homeroom_primary',
                assignmentId: 'assignment-primary',
                resourceId: 'class-resource-primary',
                label: 'Grade 7 Math',
                required: true,
                allowedOperations: ['replace'],
              },
              {
                assignmentType: 'gopilot_homeroom_co_teacher',
                assignmentId: 'assignment-co',
                resourceId: 'class-resource-co',
                label: 'Grade 8 Science',
                required: false,
                allowedOperations: ['replace', 'remove'],
              },
            ],
            blockers: blocked ? [{
              blockerType: 'active_teaching_session',
              blockerId: 'blocker-session',
              resourceId: 'class-resource-primary',
              label: 'Grade 7 Math is active',
            }] : [],
          },
        }),
      });
      return;
    }

    if (url.pathname === `/api/schools/${schoolId}/staff/${membershipId}/transition` && request.method() === 'POST') {
      transitionPostCount += 1;
      transitionBodies.push(request.postDataJSON());
      mutationPaths.push(`${request.method()} ${url.pathname}`);
      if (transitionPostCount === 1) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'STAFF_ASSIGNMENT_IMPACT_STALE', error: 'The assignments changed.' }),
        });
        return;
      }
      staffRows = staffRows.filter((row) => row.id !== membershipId);
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
    await page.getByText('Avery Membership', { exact: true }).waitFor();
    await page.getByText(`Membership ID: ${membershipId}`, { exact: true }).waitFor();

    // A returned email mismatch must not be reported as success, and the retry
    // remains an email-only operation with no profile PUT.
    await page.getByRole('button', { name: 'Edit Avery Membership' }).click();
    await page.getByPlaceholder('First').fill('Ava');
    await page.getByLabel('Email for Avery Membership').fill('avery.corrected@example.invalid');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByTestId('staff-edit-error').filter({ hasText: /Save email, role, and profile changes separately/ }).waitFor();
    assert.equal(mutationPaths.filter((path) => path.includes('/email') || path.startsWith('PUT ')).length, 0);

    await page.getByPlaceholder('First').fill('Avery');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByTestId('staff-edit-error').filter({ hasText: /did not confirm the requested email/ }).waitFor();
    assert.equal(mutationPaths.filter((path) => path.includes('/email')).length, 1);
    assert.equal(mutationPaths.filter((path) => path.startsWith('PUT ')).length, 0);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Email corrected for avery.corrected@example.invalid. The staff member must sign in again.', { exact: true }).waitFor();
    assert.equal(mutationPaths.filter((path) => path.includes('/email')).length, 2);
    assert.equal(mutationPaths.filter((path) => path.startsWith('PUT ')).length, 0);

    await page.getByRole('button', { name: 'Edit Avery Membership' }).click();
    await page.getByPlaceholder('First').fill('Ava');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Ava Membership', { exact: true }).waitFor();
    assert.deepEqual(updateBody, {
      firstName: 'Ava',
      lastName: 'Membership',
    });

    // GoPilot Teacher is an override for a universal administrator; clearing
    // the override would leave the effective GoPilot role as administrator.
    await page.getByRole('button', { name: 'Edit Admin Base' }).click();
    const adminEditRow = page.getByText(`Membership ID: ${adminMembershipId}`, { exact: true }).locator('xpath=ancestor::tr');
    await adminEditRow.locator('select').selectOption('teacher');
    await adminEditRow.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(`Membership ID: ${adminMembershipId}`, { exact: true }).waitFor();
    assert.deepEqual(adminUpdateBody, { gopilotRole: 'teacher' });

    // Same-name creation must require an explicit distinct-person confirmation.
    await page.getByRole('button', { name: 'Add Staff', exact: true }).click();
    await page.getByPlaceholder('Email *').fill('twin@example.invalid');
    await page.getByPlaceholder('First Name *').fill('Ava');
    await page.getByPlaceholder('Last Name *').fill('Membership');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('A staff member with this name already exists', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'This is a different person' }).click();
    await page.getByText('Ava Membership', { exact: true }).nth(1).waitFor();
    assert.equal(createBodies.at(-1).confirmDistinctPerson, true);

    // An inactive identity must be reactivated instead of recreated.
    await page.getByRole('button', { name: 'Add Staff', exact: true }).click();
    await page.getByPlaceholder('Email *').fill('former@example.invalid');
    await page.getByPlaceholder('First Name *').fill('Former');
    await page.getByPlaceholder('Last Name *').fill('Teacher');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Use the existing former-staff identity').waitFor();
    await page.getByRole('button', { name: 'Reactivate', exact: true }).click();
    await page.getByText('Former Teacher', { exact: true }).waitFor();
    assert.equal(createBodies.filter((body) => body.email === 'former@example.invalid').length, 1);

    // Removal first shows immutable blocker/resource IDs and cannot proceed.
    await page.getByRole('button', { name: /Remove school access for Ava Membership/ }).first().click();
    await page.getByRole('heading', { name: 'Remove school access' }).waitFor();
    await page.getByText('Blocker ID: blocker-session · Resource ID: class-resource-primary', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('button-confirm-remove-access').isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Once clear, every dependency requires an explicit decision. A stale
    // revision resets those decisions and requires the operator to review again.
    await page.getByRole('button', { name: /Remove school access for Ava Membership/ }).first().click();
    await page.getByText('Assignment ID: assignment-primary · Resource ID: class-resource-primary', { exact: true }).waitFor();
    const chooseDecisions = async () => {
      await page.locator('#decision-action-assignment-primary').click();
      await page.getByRole('option', { name: 'Transfer to another staff member' }).click();
      await page.locator('#replacement-assignment-primary').click();
      await page.getByRole('option', { name: /Bailey Replacement/ }).click();
      await page.locator('#decision-action-assignment-co').click();
      await page.getByRole('option', { name: 'Remove this relationship' }).click();
    };
    await chooseDecisions();
    const refreshedImpact = page.waitForResponse((response) => (
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/schools/${schoolId}/staff/${membershipId}/assignment-impact`
    ));
    await page.getByTestId('button-confirm-remove-access').click();
    await refreshedImpact;
    await page.getByLabel('Notifications (F8)')
      .getByText('The impact review was refreshed. Review every assignment again before continuing.', { exact: true })
      .waitFor();
    await page.locator('#decision-action-assignment-primary').filter({ hasText: 'Choose an action' }).waitFor();
    await page.locator('#decision-action-assignment-co').filter({ hasText: 'Choose an action' }).waitFor();
    assert.equal(await page.getByTestId('button-confirm-remove-access').isDisabled(), true);
    await chooseDecisions();
    await page.getByTestId('button-confirm-remove-access').click();
    await page.getByTestId(`staff-membership-id-${membershipId}`).waitFor({ state: 'detached' });
    assert.equal(transitionBodies[0].expectedRevision, 'revision-reviewed');
    assert.equal(transitionBodies[1].expectedRevision, 'revision-refreshed');
    assert.deepEqual(transitionBodies[1].decisions, [
      {
        assignmentType: 'gopilot_homeroom_primary',
        assignmentId: 'assignment-primary',
        operation: 'replace',
        replacementMembershipId,
      },
      {
        assignmentType: 'gopilot_homeroom_co_teacher',
        assignmentId: 'assignment-co',
        operation: 'remove',
      },
    ]);
    assert.equal(mutationPaths.some((path) => path.startsWith('DELETE ')), false);
    assert.equal(mutationPaths.filter((path) => path.endsWith('/transition')).length, 2);
    assert.ok(mutationPaths.every((path) => !path.includes(userId)));
  } finally {
    await context.close();
  }
}

async function testWorkspaceStaffImportSelection(browser) {
  let importBody = null;
  const workspaceUsers = [
    {
      id: 'google-user-immutable-1',
      email: 'first.teacher@example.invalid',
      firstName: 'First',
      lastName: 'Teacher',
      suspended: false,
    },
    {
      id: 'google-user-immutable-2',
      email: 'second.teacher@example.invalid',
      firstName: 'Second',
      lastName: 'Teacher',
      suspended: false,
    },
  ];

  const { context, page } = await preparePage(browser, 'admin', async (route, request, url) => {
    const emptyResponses = new Map([
      ['/api/gopilot/students', { students: [] }],
      [`/api/schools/${schoolId}/homerooms`, { homerooms: [] }],
      [`/api/schools/${schoolId}/staff`, { staff: [] }],
    ]);
    if (emptyResponses.has(url.pathname) && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(emptyResponses.get(url.pathname)),
      });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/google/org-units` && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ orgUnits: [{ name: 'Faculty', orgUnitPath: '/Faculty' }] }),
      });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/google/workspace-users` && request.method() === 'GET') {
      assert.equal(url.searchParams.get('orgUnitPath'), '/Faculty');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ users: workspaceUsers }),
      });
      return;
    }
    if (url.pathname === `/api/schools/${schoolId}/google/import-staff` && request.method() === 'POST') {
      importBody = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ imported: 1, updated: 0, skipped: 0, errors: [] }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unexpected ${request.method()} ${url.pathname}` }),
    });
  });

  try {
    await page.goto('/gopilot/setup', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Import from Google Workspace', exact: true }).click();
    await page.getByRole('button', { name: /Faculty/ }).click();
    await page.getByText('First Teacher', { exact: true }).waitFor();
    await page.locator('label', { hasText: 'Second Teacher' }).locator('input[type="checkbox"]').uncheck();
    await page.getByRole('button', { name: 'Import 1 as Teachers', exact: true }).click();
    await page.getByTestId('gopilot-workspace-staff-import-result').waitFor();

    assert.deepEqual(importBody, {
      orgUnitPath: '/Faculty',
      userIds: ['google-user-immutable-1'],
      role: 'teacher',
      source: 'gopilot_setup',
    });
    assert.equal(Object.hasOwn(importBody, 'users'), false);
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
    process.stdout.write('gopilot_browser_passed staff email verification, duplicate review, reactivation, and revisioned transition\n');
    await testWorkspaceStaffImportSelection(browser);
    process.stdout.write('gopilot_browser_passed Workspace staff import immutable-ID selection\n');
  } finally {
    await browser?.close();
    await stopPreview(preview);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
