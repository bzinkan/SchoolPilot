import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gradeFiveIds = Array.from({ length: 23 }, (_, index) => `g5-${index + 1}`);
const students = [
  ...gradeFiveIds.map((id, index) => ({ id, studentName: `Fifth Student ${String(index + 1).padStart(2, '0')} ${index < 9 ? 'Amber' : 'Birch'}`, studentEmail: `${id}@fixture.example`, gradeLevel: '5' })),
  ...Array.from({ length: 3 }, (_, index) => ({ id: `g6-${index + 1}`, studentName: `Sixth Student ${index + 1}`, studentEmail: `g6-${index + 1}@fixture.example`, gradeLevel: '6' })),
];
const staff = Array.from({ length: 12 }, (_, index) => ({ userId: `staff-${index + 1}`, displayName: index === 11 ? 'Mr Fixture' : `Staff ${index + 1}`, email: `staff-${index + 1}@fixture.example`, role: 'teacher' }));

async function fixture(context) {
  const entry = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {QueryClientProvider} from '@tanstack/react-query';
    import {AuthProvider} from '/src/contexts/AuthContext.jsx';
    import {queryClient} from '/src/lib/queryClient.js';
    import Coverage from '/src/products/classpilot/pages/Coverage.jsx';
    import '/src/index.css';
    queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(MemoryRouter,null,React.createElement(Coverage)))));
  `;
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'coverage-group-editor-browser-fixture',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/__coverage-group-test') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__coverage-group-entry.jsx"></script></body></html>'));
      });
    },
    resolveId(id) { if (id === '/__coverage-group-entry.jsx') return '\0coverage-group-entry'; },
    load(id) { if (id === '\0coverage-group-entry') return entry; },
  }] });
  await vite.listen();
  let browser;
  context.after(async () => { await browser?.close(); await vite.close(); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 768 } });
  page.setDefaultTimeout(10_000);
  const state = { groups: [], writes: [], errors: [], membershipMode: 'success', membershipReads: 0, releaseMembership: null };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'admin', email: 'admin@fixture.example' }, activeSchoolId: 'school', memberships: [{ id: 'membership', schoolId: 'school', role: 'school_admin' }], licenses: { classPilot: true } } });
    if (pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture-csrf' } });
    if (pathname.endsWith('/admin/users') || pathname.endsWith('/coverage/setup/staff')) return route.fulfill({ json: { users: staff } });
    if (pathname.endsWith('/admin/teacher-students') || pathname.endsWith('/coverage/setup/students')) return route.fulfill({ json: { students } });
    if (pathname.endsWith('/coverage/setup/classes')) return route.fulfill({ json: { groups: [
      { id: 'math', name: 'Mixed Math', gradeLevel: '5' },
      { id: 'studio', name: 'Fifth Studio', gradeLevel: '5th' },
      { id: 'advisory', name: 'Fifth Advisory', gradeLevel: '05' },
      { id: 'science', name: 'Sixth Science', gradeLevel: 'Grade 6' },
    ] } });
    if (pathname.endsWith('/groups/math/students')) {
      state.membershipReads++;
      if (state.membershipMode === 'pending') await new Promise(resolve => { state.releaseMembership = resolve; });
      if (state.membershipMode === 'error') return route.fulfill({ status: 503, json: { error: 'Class roster is temporarily unavailable.' } });
      return route.fulfill({ json: { students: students.filter(student => [...gradeFiveIds.slice(0, 12), 'g6-1'].includes(student.id)) } });
    }
    if (pathname.endsWith('/coverage/supervision-groups') && request.method() === 'GET') return route.fulfill({ json: { groups: state.groups } });
    if (pathname.includes('/coverage/supervision-groups') && request.method() !== 'GET') {
      const body = request.postDataJSON();
      state.writes.push({ method: request.method(), pathname, body });
      if (request.method() === 'POST') {
        state.groups = [{ id: 'testing', ...body, students: body.studentIds.map(studentId => ({ studentId })), staff: body.staffIds.map(id => ({ id })), studentCount: body.studentIds.length }];
      } else if (request.method() === 'PATCH') {
        state.groups[0] = { ...state.groups[0], ...body };
      } else if (pathname.endsWith('/students')) {
        state.groups[0].students = body.studentIds.map(studentId => ({ studentId }));
        state.groups[0].studentCount = body.studentIds.length;
      } else if (pathname.endsWith('/staff')) {
        state.groups[0].staff = body.staffIds.map(id => ({ id }));
      }
      return route.fulfill({ json: { group: state.groups[0] } });
    }
    if (pathname.endsWith('/coverage/capabilities')) return route.fulfill({ json: { canManageSupervisionSetup: true } });
    if (pathname.endsWith('/coverage/summary')) return route.fulfill({ json: { claimedStudentCount: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__coverage-group-test`);
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  await page.getByRole('button', { name: 'New Group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Supervision Group', exact: true });
  await dialog.waitFor();
  return { page, state, dialog };
}

async function chooseFilter(page, dialog, label, option) {
  await dialog.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function selectedCount(group, count) {
  await group.getByText(`${count} selected`, { exact: true }).waitFor();
}

test('group student bulk selection spans every filtered page, preserves other students and staff, and saves create/edit payloads', { timeout: 90_000 }, async context => {
  const { page, state, dialog } = await fixture(context);
  await dialog.getByPlaceholder('State testing - 8th grade').fill('Fifth Grade Testing');
  await dialog.getByPlaceholder('Search staff by name, email, or role').fill('Mr Fixture');
  await dialog.getByRole('checkbox', { name: /Mr Fixture/ }).check();
  const studentGroup = dialog.getByRole('group', { name: 'Group students', exact: true });
  await chooseFilter(page, dialog, 'Roster grade', 'Grade 6 (3)');
  await studentGroup.getByRole('checkbox', { name: /Sixth Student 1/ }).check();
  await chooseFilter(page, dialog, 'Roster grade', 'Grade 5 (23)');
  await dialog.getByLabel('Class Management class', { exact: true }).click();
  assert.deepEqual((await page.getByRole('option').allTextContents()).sort(), ['All classes', 'Mixed Math - Grade 5', 'Fifth Studio - Grade 5th', 'Fifth Advisory - Grade 05'].sort(), 'The class menu follows the selected roster grade, including ordinal and leading-zero grade aliases');
  await page.keyboard.press('Escape');
  await studentGroup.getByRole('button', { name: 'Select all 23 matching students', exact: true }).click();
  await selectedCount(studentGroup, 24);

  for (const [pageNumber, visibleCount] of [[1, 8], [2, 8], [3, 7]]) {
    assert.equal(await studentGroup.getByRole('checkbox').count(), visibleCount);
    assert.equal(await studentGroup.getByRole('checkbox').evaluateAll(elements => elements.every(element => element.getAttribute('aria-checked') === 'true')), true, `Every student on page ${pageNumber} was selected, including offscreen pages`);
    if (pageNumber < 3) await studentGroup.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await studentGroup.getByRole('checkbox', { name: /Fifth Student 23/ }).uncheck();
  await selectedCount(studentGroup, 23);
  await studentGroup.getByRole('button', { name: 'Clear matching students', exact: true }).click();
  await selectedCount(studentGroup, 1);
  await studentGroup.getByRole('button', { name: 'Select all 23 matching students', exact: true }).click();
  await selectedCount(studentGroup, 24);
  await dialog.getByPlaceholder('Search staff by name, email, or role').fill('');
  await dialog.getByPlaceholder('Search staff by name, email, or role').fill('Mr Fixture');
  assert.equal(await dialog.getByRole('checkbox', { name: /Mr Fixture/ }).isChecked(), true);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(state.writes.length, 1);
  const created = state.writes[0];
  assert.equal(created.method, 'POST');
  assert.equal(created.body.name, 'Fifth Grade Testing');
  assert.deepEqual([...created.body.studentIds].sort(), [...gradeFiveIds, 'g6-1'].sort());
  assert.deepEqual(created.body.staffIds, ['staff-12']);
  assert.equal(new Set(created.body.studentIds).size, 24, 'Bulk selection does not duplicate previously selected IDs');

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Supervision Group', exact: true });
  const editedStudents = edit.getByRole('group', { name: 'Group students', exact: true });
  await selectedCount(editedStudents, 24);
  await chooseFilter(page, edit, 'Roster grade', 'Grade 5 (23)');
  await chooseFilter(page, edit, 'Class Management class', 'Mixed Math - Grade 5');
  await editedStudents.getByText('Showing 1-8 of 12', { exact: true }).waitFor();
  await edit.getByPlaceholder('Search students by name or email').fill('Fifth Amber');
  await editedStudents.getByRole('button', { name: 'Clear matching students', exact: true }).click();
  await selectedCount(editedStudents, 15);
  await editedStudents.getByRole('button', { name: 'Select all 9 matching students', exact: true }).click();
  await selectedCount(editedStudents, 24);
  await editedStudents.getByRole('button', { name: 'Clear matching students', exact: true }).click();
  await selectedCount(editedStudents, 15);
  await edit.getByPlaceholder('Search students by name or email').fill('');
  await chooseFilter(page, edit, 'Roster grade', 'Grade 6 (3)');
  assert.equal(await edit.getByLabel('Class Management class', { exact: true }).textContent(), 'All classes', 'Changing grades resets a class that no longer matches');
  await selectedCount(editedStudents, 15);
  await edit.getByLabel('Class Management class', { exact: true }).click();
  const sixthOptions = await page.getByRole('option').allTextContents();
  assert.equal(sixthOptions.length, 2);
  assert(sixthOptions[1].includes('Sixth Science'), 'Prefixed class grades match the corresponding numeric roster grade');
  assert.equal(sixthOptions.some(option => option.includes('Mixed Math')), false);
  await page.keyboard.press('Escape');
  await edit.getByPlaceholder('Search students by name or email').fill('No matching student');
  await editedStudents.getByText('No students match these filters', { exact: true }).waitFor();
  assert.equal(await editedStudents.getByRole('button', { name: /^Select all/ }).isDisabled(), true);
  assert.equal(await editedStudents.getByRole('button', { name: 'Clear matching students', exact: true }).isDisabled(), true);
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.deepEqual(state.writes.slice(1).map(write => [write.method, write.pathname]), [
    ['PATCH', '/api/coverage/supervision-groups/testing'],
    ['PUT', '/api/coverage/supervision-groups/testing/students'],
    ['PUT', '/api/coverage/supervision-groups/testing/staff'],
  ]);
  assert.deepEqual([...state.writes[2].body.studentIds].sort(), [...gradeFiveIds.slice(9), 'g6-1'].sort(), 'Only the grade/class/search intersection is cleared; selections outside it remain');
  assert.deepEqual(state.writes[3].body.staffIds, ['staff-12']);
  assert.deepEqual(state.errors, []);
});

test('class membership loading and errors cannot bulk-select or clear cached matches', { timeout: 60_000 }, async context => {
  const { page, state, dialog } = await fixture(context);
  const studentGroup = dialog.getByRole('group', { name: 'Group students', exact: true });
  await chooseFilter(page, dialog, 'Class Management class', 'Mixed Math - Grade 5');
  await studentGroup.getByRole('button', { name: 'Select all 13 matching students', exact: true }).click();
  await selectedCount(studentGroup, 13);
  await chooseFilter(page, dialog, 'Class Management class', 'All classes');
  state.membershipMode = 'pending';
  await chooseFilter(page, dialog, 'Class Management class', 'Mixed Math - Grade 5');
  await studentGroup.getByText('Loading student roster...', { exact: true }).waitFor();
  assert.equal(await studentGroup.getByRole('button', { name: /^Select all/ }).isDisabled(), true);
  assert.equal(await studentGroup.getByRole('button', { name: 'Clear matching students', exact: true }).isDisabled(), true);
  assert.equal(await studentGroup.getByRole('checkbox').count(), 0, 'Cached roster rows cannot be edited while their filter is unresolved');
  state.membershipMode = 'error';
  state.releaseMembership();
  await studentGroup.getByRole('alert').waitFor();
  assert.equal(await studentGroup.getByRole('button', { name: /^Select all/ }).isDisabled(), true);
  assert.equal(await studentGroup.getByRole('button', { name: 'Clear matching students', exact: true }).isDisabled(), true);
  await selectedCount(studentGroup, 13);
  state.membershipMode = 'success';
  await studentGroup.getByRole('button', { name: /Retry/i }).click();
  await studentGroup.getByText('Showing 1-8 of 13', { exact: true }).waitFor();
  assert.equal(await studentGroup.getByRole('button', { name: 'Clear matching students', exact: true }).isEnabled(), true);
  await selectedCount(studentGroup, 13);
  assert.equal(state.membershipReads, 3);
  assert.deepEqual(state.writes, [], 'Loading, changing filters and retrying never write group membership');
  assert.deepEqual(state.errors, []);
});

test('new and edit group dialogs keep roster pagination and footer reachable at desktop/mobile sizes in both themes', { timeout: 90_000 }, async context => {
  const { page, state, dialog } = await fixture(context);
  const artifactDir = path.join(root, 'artifacts', 'coverage-group-editor');
  await mkdir(artifactDir, { recursive: true });
  await dialog.getByPlaceholder('State testing - 8th grade').fill('Viewport Testing');
  for (const [size, viewport] of [['desktop', { width: 1365, height: 768 }], ['mobile', { width: 390, height: 667 }], ['narrow-mobile', { width: 320, height: 568 }]]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const element = document.querySelector('[role="dialog"]');
      const rect = element.getBoundingClientRect();
      return rect.y >= 0 && rect.bottom <= window.innerHeight + 1;
    }, null, { timeout: 3000 });
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.getAnimations().forEach(animation => animation.finish());
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      const body = dialog.getByTestId('supervision-group-editor-body');
      await body.evaluate(element => { element.scrollTop = 0; });
      const bounds = await dialog.boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `${size}/${theme}: the entire dialog fits inside the viewport (${JSON.stringify(bounds)})`);
      const headerBefore = await dialog.getByRole('heading').boundingBox();
      const footerBefore = await dialog.getByRole('button', { name: 'Save', exact: true }).boundingBox();
      assert(footerBefore.y >= bounds.y && footerBefore.y + footerBefore.height <= viewport.height, `${size}/${theme}: Save is visible before scrolling`);
      const metrics = await body.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
      assert(metrics.scrollHeight > metrics.height, `${size}/${theme}: the form has an internal scroll area`);
      await body.hover();
      await page.mouse.wheel(0, 2500);
      await page.waitForFunction(() => document.querySelector('[data-testid="supervision-group-editor-body"]').scrollTop > 0);
      const studentsGroup = dialog.getByRole('group', { name: 'Group students', exact: true });
      await studentsGroup.getByRole('button', { name: 'Next', exact: true }).click();
      await studentsGroup.getByText('Showing 9-16 of 26', { exact: true }).waitFor();
      await studentsGroup.getByRole('button', { name: 'Previous', exact: true }).click();
      const headerAfter = await dialog.getByRole('heading').boundingBox();
      const footerAfter = await dialog.getByRole('button', { name: 'Save', exact: true }).boundingBox();
      assert(Math.abs(headerBefore.y - headerAfter.y) < 1, `${size}/${theme}: header stays fixed while the roster scrolls (${headerBefore.y} to ${headerAfter.y})`);
      assert(Math.abs(footerBefore.y - footerAfter.y) < 1, `${size}/${theme}: footer stays fixed while the roster scrolls`);
      assert.equal(await body.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${size}/${theme}: form controls do not overflow horizontally`);
      await dialog.getByPlaceholder('State testing - 8th grade').focus();
      let reachedSave = false;
      let reachedBulkSelect = false;
      for (let stop = 0; stop < 55; stop++) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          const element = document.activeElement;
          const rect = element.getBoundingClientRect();
          return { text: element.textContent?.trim(), inDialog: !!element.closest('[role="dialog"]'), focusVisible: element.matches(':focus-visible'), top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
        });
        assert.equal(focused.inDialog, true, 'Keyboard navigation stays inside the dialog');
        assert(focused.top >= -1 && focused.bottom <= focused.viewport + 1, `${size}/${theme}: keyboard focus scrolls into view`);
        if (focused.text?.startsWith('Select all')) {
          reachedBulkSelect = true;
          assert.equal(focused.focusVisible, true, 'The bulk action has visible keyboard focus');
        }
        if (focused.text === 'Save') { reachedSave = true; break; }
      }
      assert.equal(reachedBulkSelect && reachedSave, true, `${size}/${theme}: keyboard users can reach bulk selection and Save`);
      await page.screenshot({ path: path.join(artifactDir, `new-${size}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Supervision Group', exact: true });
  await edit.getByRole('checkbox', { name: 'Active supervision group', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await edit.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await edit.getByRole('button', { name: 'Save', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.screenshot({ path: path.join(artifactDir, 'edit-mobile-dark.png'), fullPage: true, animations: 'disabled' });
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(state.writes.length, 1, 'Opening and canceling edit does not save changes');
  assert.deepEqual(state.errors, []);
});
