#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const baseURL = 'http://127.0.0.1:4175';
const schoolId = 'classpilot-removal-browser-school';

function startPreview() {
  if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    throw new Error('Build the standard frontend before running the ClassPilot student-removal browser test.');
  }
  return spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], {
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
    } catch {
      // Preview is still starting.
    }
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

function auth() {
  return {
    activeSchoolId: schoolId,
    user: {
      id: 'classpilot-removal-admin',
      email: 'admin@example.invalid',
      firstName: 'Roster',
      lastName: 'Admin',
    },
    memberships: [{
      id: 'classpilot-removal-membership',
      schoolId,
      schoolName: 'ClassPilot Browser School',
      schoolSlug: 'classpilot-browser-school',
      schoolTimezone: 'America/New_York',
      role: 'school_admin',
    }],
    licenses: { classPilot: true, passPilot: false, goPilot: false },
  };
}

async function preparePage(browser, handler) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript((id) => window.localStorage.setItem('sp_activeSchoolId', id), schoolId);
  const page = await context.newPage();
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(auth()) });
      return;
    }
    if (url.pathname === '/api/auth/csrf') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ csrfToken: 'classpilot-removal-csrf' }) });
      return;
    }
    await handler(route, request, url);
  });
  return { context, page };
}

async function testSingleRemoval(browser) {
  let deleteAttempts = 0;
  let students = [
    { id: 'student-one', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.invalid', gradeLevel: '8', status: 'active' },
    { id: 'student-inactive', firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.invalid', gradeLevel: '8', status: 'inactive' },
  ];

  const { context, page } = await preparePage(browser, async (route, request, url) => {
    if (url.pathname === '/api/students' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ students }) });
      return;
    }
    if (url.pathname === '/api/devices' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ devices: [] }) });
      return;
    }
    if (url.pathname === '/api/settings' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ gradeLevels: ['8'] }) });
      return;
    }
    if (url.pathname === '/api/students/student-one' && request.method() === 'DELETE') {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Roster service temporarily unavailable' }),
        });
        return;
      }
      students = students.map((student) => (
        student.id === 'student-one' ? { ...student, status: 'inactive' } : student
      ));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unexpected ${request.method()} ${url.pathname}` }),
    });
  });

  try {
    await page.goto('/classpilot/roster', { waitUntil: 'networkidle' });
    await page.getByTestId('row-student-student-one').waitFor();
    assert.equal(await page.getByTestId('row-student-student-inactive').count(), 0, 'inactive students must stay out of the roster');

    const removeButton = page.getByTestId('button-delete-student-student-one');
    assert.equal((await removeButton.innerText()).trim(), 'Remove Student');
    await removeButton.click();
    await page.getByRole('heading', { name: 'Remove Student?', exact: true }).waitFor();
    await page.getByText(/class assignments and activity history are retained/).waitFor();
    await page.getByTestId('button-cancel-delete').click();
    await page.getByRole('heading', { name: 'Remove Student?', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(deleteAttempts, 0, 'cancel must not call the delete endpoint');

    await removeButton.click();
    await page.getByTestId('button-confirm-delete').click();
    const retryableError = page.getByTestId('remove-student-error');
    await retryableError.waitFor();
    assert.equal((await retryableError.innerText()).trim(), 'Roster service temporarily unavailable');
    assert.equal(await page.getByRole('heading', { name: 'Remove Student?', exact: true }).isVisible(), true, '500 response must keep confirmation open');
    assert.equal(await page.getByTestId('row-student-student-one').isVisible(), true, 'failed removal must not optimistically hide the student');

    await page.getByTestId('button-confirm-delete').click();
    await page.getByRole('heading', { name: 'Remove Student?', exact: true }).waitFor({ state: 'hidden' });
    await page.getByTestId('row-student-student-one').waitFor({ state: 'detached' });
    assert.equal(deleteAttempts, 2, 'the same dialog must support a successful retry');
    await page.getByText('The student was removed from active rosters. Their history is retained.').waitFor();
  } finally {
    await context.close();
  }
}

async function testBulkRemoval(browser) {
  let bulkAttempts = 0;
  let lastStudentIds = [];
  let students = [
    { id: 'student-two', studentName: 'Katherine Johnson', studentEmail: 'katherine@example.invalid', gradeLevel: '7', status: 'active' },
    { id: 'student-three', studentName: 'Dorothy Vaughan', studentEmail: 'dorothy@example.invalid', gradeLevel: '7', status: 'active' },
    { id: 'student-four', studentName: 'Mary Jackson', studentEmail: 'mary@example.invalid', gradeLevel: '7', status: 'inactive' },
  ];

  const { context, page } = await preparePage(browser, async (route, request, url) => {
    if (url.pathname === '/api/admin/teacher-students' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ students }) });
      return;
    }
    if (url.pathname === '/api/settings' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ gradeLevels: ['7'] }) });
      return;
    }
    if (url.pathname === '/api/admin/students/bulk-delete' && request.method() === 'POST') {
      bulkAttempts += 1;
      lastStudentIds = request.postDataJSON().studentIds;
      if (bulkAttempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Bulk roster update failed' }),
        });
        return;
      }
      const removedIds = new Set(lastStudentIds);
      students = students.map((student) => (
        removedIds.has(student.id) ? { ...student, status: 'inactive' } : student
      ));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: lastStudentIds.length, deactivated: lastStudentIds.length }),
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
    await page.goto('/classpilot/students', { waitUntil: 'networkidle' });
    await page.getByTestId('row-student-student-two').waitFor();
    assert.equal(await page.getByTestId('row-student-student-four').count(), 0, 'inactive students must stay out of the management roster');
    await page.getByTestId('checkbox-student-student-two').click();
    await page.getByTestId('checkbox-student-student-three').click();
    const bulkButton = page.getByTestId('button-bulk-delete');
    assert.equal((await bulkButton.innerText()).trim(), 'Remove Selected');

    await bulkButton.click();
    await page.getByRole('heading', { name: 'Remove Selected Students?', exact: true }).waitFor();
    await page.getByText(/Remove 2 selected students from active rosters/).waitFor();
    await page.getByTestId('button-cancel-bulk-remove').click();
    await page.getByRole('heading', { name: 'Remove Selected Students?', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(bulkAttempts, 0, 'bulk cancel must not call the endpoint');
    assert.equal(await page.getByTestId('selection-bar').isVisible(), true, 'bulk cancel must preserve selection');

    await bulkButton.click();
    await page.getByTestId('button-confirm-bulk-remove').click();
    const retryableError = page.getByTestId('bulk-remove-students-error');
    await retryableError.waitFor();
    assert.equal((await retryableError.innerText()).trim(), 'Bulk roster update failed');
    assert.equal(await page.getByRole('heading', { name: 'Remove Selected Students?', exact: true }).isVisible(), true, 'bulk 500 response must keep confirmation open');
    assert.equal(await page.getByTestId('selection-bar').isVisible(), true, 'bulk 500 response must preserve selection');

    await page.getByTestId('button-confirm-bulk-remove').click();
    await page.getByRole('heading', { name: 'Remove Selected Students?', exact: true }).waitFor({ state: 'hidden' });
    await page.getByTestId('selection-bar').waitFor({ state: 'detached' });
    await page.getByTestId('row-student-student-two').waitFor({ state: 'detached' });
    await page.getByTestId('row-student-student-three').waitFor({ state: 'detached' });
    assert.deepEqual(new Set(lastStudentIds), new Set(['student-two', 'student-three']));
    assert.equal(bulkAttempts, 2, 'bulk removal must retry the same selected IDs');
    await page.getByText('Removed 2 students from active rosters. Their history is retained.', { exact: true }).first().waitFor();
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
    await testSingleRemoval(browser);
    await testBulkRemoval(browser);
    console.log('ClassPilot student-removal browser checks passed.');
  } finally {
    await browser?.close();
    await stopPreview(preview);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
