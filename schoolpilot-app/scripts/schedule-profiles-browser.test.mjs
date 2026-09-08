import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function createProfileFixture(context) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {QueryClientProvider} from '@tanstack/react-query';import {AuthProvider} from '/src/contexts/AuthContext.jsx';import {queryClient as client} from '/src/lib/queryClient.js';import Scheduling from '/src/products/classpilot/pages/AdminScheduling.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(AuthProvider,null,React.createElement(MemoryRouter,null,React.createElement('main',{className:'mx-auto max-w-6xl p-6'},React.createElement(Scheduling))))));`;
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'schedule-profile-browser-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== '/__schedule-profiles') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__profiles-entry.jsx"></script></body></html>')); }); }, resolveId(id) { if (id === '/__profiles-entry.jsx') return '\0schedule-profiles-entry'; }, load(id) { if (id === '\0schedule-profiles-entry') return entry; } }] });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  context.signal.addEventListener('abort', () => { void browser?.close(); void vite.close(); }, { once: true });
  return { root, vite, browser, page, url: `http://127.0.0.1:${vite.httpServer.address().port}/__schedule-profiles` };
}

function draftReviewFixture(catalog, definition, referenceDate, regularClasses = null) {
  const classes = catalog.classes.map(row => {
    const selected = definition.classIds.includes(row.id) || definition.grades.includes(String(row.gradeLevel));
    const rule = selected ? definition.classRules.find(rule => rule.classId === row.id) : null;
    const regular = regularClasses?.find(item => item.classId === row.id);
    const regularWindow = regular ? regular.window : row.blockStartTime && row.blockEndTime ? { startTime: row.blockStartTime, endTime: row.blockEndTime } : null;
    return { classId: row.id, name: row.name, gradeLevel: row.gradeLevel || null, staff: row.staff || [], selected, status: regular?.status || (row.scheduleEnabled ? 'meets' : 'schedule_off'), regularWindow, proposedWindow: rule?.action === 'skip' ? null : rule?.action === 'time' ? { startTime: rule.startTime, endTime: rule.endTime } : regularWindow, action: rule?.action || 'keep' };
  });
  const testingBlocks = definition.testingBlocks.map(block => {
    const group = catalog.supervisionGroups.find(row => row.id === block.coverageGroupId);
    return { blockId: block.id, name: block.name, coverageGroupId: block.coverageGroupId, groupName: group?.name || '', assignedStaffId: block.assignedStaffId, staffName: catalog.staff.find(row => row.id === block.assignedStaffId)?.name || '', startTime: block.startTime, endTime: block.endTime, status: 'ready', studentCount: group?.studentIds.length || 0, classParticipation: group?.classParticipation || [] };
  });
  return { referenceDate, revision: catalog.revision, schoolTimezone: catalog.schoolTimezone, day: { instructional: true, meetingWeekday: 2, cycleDay: 'A', bellProfile: { id: 'regular', name: 'Regular' }, overridden: false }, complete: true, classes, testingBlocks, issues: [], counts: { conflicts: 0, overlaps: 0, incomplete: 0 }, requestFingerprint: JSON.stringify({ referenceDate, definition }) };
}

async function closeSavedReview(dialog) {
  await dialog.getByText('Profile saved — not applied', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close schedule', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function createDraftReviewFixture(context) {
  const fixture = await createProfileFixture(context);
  const { page } = fixture;
  const catalog = { revision: 1, schoolTimezone: 'America/New_York', schoolLocalToday: '2026-09-08', profiles: [], applications: [], testingStatuses: [],
    staff: [{ id: 'zinkan', name: 'Ms. Zinkan' }, { id: 'burba', name: 'Ms. Burba' }, { id: 'vatter', name: 'Mr. Vatter' }, { id: 'art-teacher', name: 'Art Teacher' }],
    classes: [
      { id: 'math', name: 'Zinkan Math', gradeLevel: '3', teacherName: 'Ms. Zinkan', staff: [{ id: 'zinkan', name: 'Ms. Zinkan' }] },
      { id: 'reading', name: 'Burba Reading', gradeLevel: '3', teacherName: 'Ms. Burba', staff: [{ id: 'burba', name: 'Ms. Burba' }] },
      { id: 'science', name: 'Vatter Science', gradeLevel: '4', teacherName: 'Mr. Vatter', staff: [{ id: 'vatter', name: 'Mr. Vatter' }] },
      { id: 'art', name: 'Art Studio', gradeLevel: '4', teacherName: 'Art Teacher', staff: [{ id: 'art-teacher', name: 'Art Teacher' }] },
    ].map(row => ({ ...row, scheduleEnabled: true, blockStartTime: '09:00', blockEndTime: '10:00' })),
    supervisionGroups: [
      { id: 'zinkan-group', name: 'Mixed MAP group', staffIds: ['zinkan'], studentIds: ['synthetic-a', 'synthetic-b'], classParticipation: [{ classId: 'math', count: 2, total: 20 }, { classId: 'art', count: 2, total: 24 }] },
      { id: 'burba-group', name: 'Reading MAP group', staffIds: ['burba'], studentIds: ['synthetic-c', 'synthetic-d'], classParticipation: [{ classId: 'reading', count: 2, total: 18 }] },
      { id: 'vatter-group', name: 'Science MAP group', staffIds: ['vatter'], studentIds: ['synthetic-e', 'synthetic-f'], classParticipation: [{ classId: 'science', count: 2, total: 22 }] },
    ],
  };
  const reviews = [], saves = [], previews = [], applies = [], errors = [];
  const control = { reviewResponse: null, saveTransform: definition => definition, staleCatalog: false, failCatalogRefresh: false, catalogReadFailures: 0, failSavedReview: false, groupCreates: [], failGroupCreate: false, failDirectory: false };
  const groupSummary = group => ({ id: group.id, schoolId: 'school', name: group.name, active: group.active !== false, updatedAt: '2026-09-08T12:00:00Z', studentCount: group.studentIds.length, inactiveStudentCount: 0, categoryId: 'map-category', category: { id: 'map-category', name: 'NWEA MAP' }, gradeCounts: [{ gradeLevel: '3', count: group.studentIds.length }], staff: group.staffIds.map(id => ({ id, displayName: catalog.staff.find(person => person.id === id)?.name || id })) });
  const project = body => {
    const result = draftReviewFixture(catalog, body.definition, body.referenceDate);
    const overlaps = (a, b) => a && b && a.startTime < b.endTime && b.startTime < a.endTime;
    for (const block of result.testingBlocks) {
      if (!block.name.trim() || !block.coverageGroupId || !block.assignedStaffId || !block.startTime || !block.endTime || block.startTime >= block.endTime) {
        block.status = 'incomplete';
        result.issues.push({ id: `incomplete-${block.blockId}`, kind: 'incomplete', code: 'SCHEDULE_DRAFT_BLOCK_INCOMPLETE', message: 'Finish the testing block name, group, assigned staff and times.', classIds: [], blockIds: [block.blockId], staffIds: [] });
        continue;
      }
      for (const row of result.classes) {
        if (!overlaps(row.proposedWindow, block)) continue;
        if (row.staff.some(staff => staff.id === block.assignedStaffId)) result.issues.push({ id: `conflict-${row.classId}-${block.blockId}`, kind: 'conflict', code: 'SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT', message: `${block.staffName} is assigned to ${row.name} during ${block.name}.`, classIds: [row.classId], blockIds: [block.blockId], staffIds: [block.assignedStaffId] });
        else if (block.classParticipation.some(part => part.classId === row.classId)) result.issues.push({ id: `overlap-${row.classId}-${block.blockId}`, kind: 'overlap', code: 'SCHEDULE_DRAFT_TESTING_CLASS_OVERLAP', message: `${block.name} overlaps ${row.name} for part of the class; the other students keep their regular class.`, classIds: [row.classId], blockIds: [block.blockId], staffIds: [block.assignedStaffId, ...row.staff.map(staff => staff.id)] });
      }
    }
    for (const row of result.classes) if (row.action === 'time' && (!row.proposedWindow.startTime || !row.proposedWindow.endTime || row.proposedWindow.startTime >= row.proposedWindow.endTime)) result.issues.push({ id: `incomplete-${row.classId}`, kind: 'incomplete', code: 'SCHEDULE_DRAFT_CLASS_INCOMPLETE', message: 'Finish this class time with an end after its start.', classIds: [row.classId], blockIds: [], staffIds: [] });
    result.counts = { conflicts: result.issues.filter(issue => issue.kind === 'conflict').length, overlaps: result.issues.filter(issue => issue.kind === 'overlap').length, incomplete: result.issues.filter(issue => issue.kind === 'incomplete').length };
    result.complete = !result.counts.incomplete;
    return result;
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'admin', role: 'school_admin' }, activeSchoolId: 'school', memberships: [{ id: 'membership', schoolId: 'school', role: 'school_admin' }], licenses: { classPilot: true } } });
    if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture-token' } });
    if (url.pathname.endsWith('/coverage/supervision-groups/browse')) {
      if (control.failDirectory) return route.fulfill({ status: 503, json: { error: 'Directory unavailable' } });
      const search = (url.searchParams.get('search') || '').toLowerCase();
      const groups = catalog.supervisionGroups.map(groupSummary).filter(group => group.active && group.name.toLowerCase().includes(search)).sort((a, b) => a.name.localeCompare(b.name));
      const pageNumber = Number(url.searchParams.get('page') || 1);
      return route.fulfill({ json: { groups: groups.slice((pageNumber - 1) * 25, pageNumber * 25), page: pageNumber, pageSize: 25, total: groups.length, totalPages: Math.ceil(groups.length / 25), facets: { categories: [{ id: 'map-category', name: 'NWEA MAP' }], grades: [{ gradeLevel: '3', count: groups.length }], staff: catalog.staff.map(person => ({ id: person.id, displayName: person.name })) } } });
    }
    if (url.pathname.includes('/coverage/supervision-groups/')) {
      const group = catalog.supervisionGroups.find(row => row.id === url.pathname.split('/').at(-1));
      return route.fulfill(group ? { json: { group: groupSummary(group) } } : { status: 404, json: { error: 'Group unavailable' } });
    }
    if (url.pathname.endsWith('/coverage/supervision-group-categories')) return route.fulfill({ json: { categories: [{ id: 'map-category', name: 'NWEA MAP', updatedAt: '2026-09-08T12:00:00Z' }] } });
    if (url.pathname.endsWith('/coverage/setup/classes')) return route.fulfill({ json: { groups: catalog.classes } });
    if (url.pathname.endsWith('/admin/users')) return route.fulfill({ json: { users: catalog.staff.map(person => ({ userId: person.id, displayName: person.name, email: `${person.id}@example.test`, role: 'teacher' })) } });
    if (url.pathname.endsWith('/admin/teacher-students')) return route.fulfill({ json: { students: [{ id: 'new-student', studentName: 'Fixture Student', studentEmail: 'fixture@example.test', gradeLevel: '3' }] } });
    if (url.pathname.endsWith('/coverage/supervision-groups') && request.method() === 'POST') {
      const body = request.postDataJSON(); control.groupCreates.push(body);
      if (control.failGroupCreate) return route.fulfill({ status: 503, json: { error: 'Could not create the group. No group was saved.' } });
      const group = { id: 'new-inline-group', name: body.name, staffIds: body.staffIds, studentIds: body.studentIds };
      catalog.supervisionGroups.push(group);
      return route.fulfill({ json: { group: groupSummary(group) } });
    }
    if (url.pathname.endsWith('/instructional-calendar')) return route.fulfill({ json: { month: url.searchParams.get('month'), schoolTimezone: catalog.schoolTimezone, schoolLocalToday: catalog.schoolLocalToday, nonInstructionalDates: [], revision: 1, updatedAt: null } });
    if (url.pathname.endsWith('/admin/scheduling')) return route.fulfill({ json: { revision: catalog.revision, schoolTimezone: catalog.schoolTimezone, schoolLocalToday: catalog.schoolLocalToday, config: { schemaVersion: 1, yearStart: null, yearEnd: null, cycleAnchorDate: null, cycleAnchorDay: 'A', periods: [], profiles: [], defaultProfileId: null, weekdayProfiles: {}, dateOverrides: {}, scheduleProfiles: catalog.profiles, profileApplications: [] } } });
    if (url.pathname.endsWith('/schedule-profiles/regular-schedule')) return route.fulfill({ json: { referenceDate: url.searchParams.get('referenceDate'), revision: catalog.revision, schoolTimezone: catalog.schoolTimezone, day: { instructional: true, meetingWeekday: 2, cycleDay: 'A', bellProfile: null, overridden: false }, classes: catalog.classes.map(row => ({ classId: row.id, status: 'meets', window: { startTime: row.blockStartTime, endTime: row.blockEndTime } })) } });
    if (url.pathname.endsWith('/schedule-profiles/draft-review')) {
      const body = request.postDataJSON(); reviews.push(body);
      if (control.failSavedReview && saves.length) return route.fulfill({ status: 503, json: { error: 'Saved schedule review is temporarily unavailable.' } });
      const custom = await control.reviewResponse?.(body, project(body));
      return route.fulfill(custom || { json: project(body) });
    }
    if (url.pathname.endsWith('/schedule-profiles/preview')) { const body = request.postDataJSON(); previews.push(body); return route.fulfill({ json: { previewToken: `actual-date-${previews.length}`, schoolTimezone: catalog.schoolTimezone, affectedClasses: 1, blockers: [], changes: [], testingWindows: [] } }); }
    if (url.pathname.endsWith('/schedule-profiles/apply')) { applies.push(request.postDataJSON()); return route.fulfill({ json: { revision: ++catalog.revision, application: { id: 'applied', dates: applies.at(-1).dates } } }); }
    if (url.pathname.endsWith('/schedule-profiles')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); saves.push(body);
        const profile = { id: body.id || 'saved-review-profile', revision: saves.length + 6, definition: control.saveTransform(structuredClone(body.definition)), updatedAt: '2026-09-08T13:00:00Z' };
        catalog.revision += 3;
        if (!control.staleCatalog) catalog.profiles = [profile];
        control.savedProfile = profile;
        return route.fulfill({ json: { revision: catalog.revision, profile } });
      }
      if ((control.failCatalogRefresh && saves.length) || control.failGroupCatalogRefresh) { control.catalogReadFailures++; return route.fulfill({ status: 503, json: { error: 'The profile list is temporarily unavailable.' } }); }
      return route.fulfill({ json: catalog });
    }
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture request ${url.pathname}` } });
  });
  await page.goto(fixture.url); await page.waitForLoadState('networkidle');
  return { ...fixture, catalog, reviews, saves, previews, applies, errors, control };
}

async function addTestingBlock(dialog, index, teacher) {
  await dialog.getByRole('tab', { name: 'Testing blocks', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
  await dialog.getByLabel(`Testing block ${index} name`, { exact: true }).fill(`${teacher[0].toUpperCase()}${teacher.slice(1)} MAP`);
  await dialog.getByLabel(`Testing block ${index} Supervision group`, { exact: true }).selectOption(`${teacher}-group`);
  await dialog.getByLabel(`Testing block ${index} assigned staff`, { exact: true }).selectOption(teacher);
}

test('Testing groups retain explicit page selections, enforce the total limit, and add one editable block per group', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, saves } = await createDraftReviewFixture(context);
  try {
    for (let index = 0; index < 28; index++) catalog.supervisionGroups.push({ id: `team-${index}`, name: `Team ${String(index).padStart(2, '0')}`, staffIds: ['zinkan'], studentIds: [`fixture-${index}`] });
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await workspace.getByLabel('Profile name', { exact: true }).fill('Whole-school MAP');
    await workspace.getByRole('button', { name: 'Load regular schedule', exact: true }).click();
    await workspace.getByRole('tab', { name: 'Testing blocks', exact: true }).click();
    assert.equal(await workspace.getByLabel('Include Zinkan Math').isVisible(), false, 'Inactive classes must not be reachable while testing blocks are selected');
    await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add testing groups', exact: true });
    await picker.getByRole('button', { name: 'Select this page', exact: true }).click();
    await picker.getByText('25 groups selected', { exact: false }).waitFor();
    await picker.getByRole('button', { name: 'Next groups', exact: true }).click();
    await picker.getByRole('button', { name: 'Select this page', exact: true }).click();
    await picker.getByText('Select no more than 30 groups.', { exact: false }).waitFor();
    assert.equal(await picker.getByRole('button', { name: 'Add 31 testing blocks', exact: true }).isDisabled(), true);
    await picker.getByRole('button', { name: 'Remove selected group Team 27', exact: true }).click();
    await picker.getByLabel('Find a supervision group or staff', { exact: true }).fill('Mixed');
    await picker.getByText('1 matching groups', { exact: false }).waitFor();
    await picker.getByText('30 groups selected', { exact: false }).waitFor();
    await picker.getByLabel('Common testing start', { exact: true }).fill('09:00');
    await picker.getByLabel('Common testing end', { exact: true }).fill('10:45');
    const add = picker.getByRole('button', { name: 'Add 30 testing blocks', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent.includes('Add 30 testing blocks') && !button.disabled));
    await add.evaluate(button => { button.click(); button.click(); });
    await picker.waitFor({ state: 'hidden' });
    assert.equal(await workspace.locator('[data-block-editor-id]').count(), 30);
    assert.equal(await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).isDisabled(), true);
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].definition.testingBlocks.length, 30);
    assert.equal(new Set(saves[0].definition.testingBlocks.map(block => block.id)).size, 30);
    assert.ok(saves[0].definition.testingBlocks.every(block => block.startTime === '09:00' && block.endTime === '10:45'));
    assert.deepEqual(saves[0].definition.classRules, [], 'Bulk testing must not invent ordinary class changes');
  } finally { await browser.close(); await vite.close(); }
});

test('Workspace keyboard navigation and current staff choices preserve independent testing windows', { timeout: 90_000 }, async context => {
  const { root, browser, vite, page, catalog, saves } = await createDraftReviewFixture(context);
  try {
    // The directory may have fresher assignments than the already-loaded profile catalog.
    catalog.supervisionGroups[0].staffIds = ['zinkan', 'burba'];
    catalog.supervisionGroups[1].staffIds = [];
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await page.waitForFunction(() => document.activeElement?.closest('[data-testid="schedule-profile-workspace"]'));
    await workspace.getByLabel('Profile name', { exact: true }).fill('Two testing windows');
    await workspace.getByRole('button', { name: 'Load regular schedule', exact: true }).click();
    const classesTab = workspace.getByRole('tab', { name: 'Classes', exact: true });
    const testingTab = workspace.getByRole('tab', { name: 'Testing blocks', exact: true });
    await classesTab.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[data-testid="schedule-profile-workspace"] [role="tab"][aria-selected="true"]')?.textContent === 'Testing blocks');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Classes' && document.activeElement?.getAttribute('aria-selected') === 'true');
    assert.equal(await classesTab.evaluate(el => document.getElementById(el.getAttribute('aria-controls'))?.getAttribute('role')), 'tabpanel');
    await testingTab.click();
    const opener = workspace.getByRole('button', { name: 'Add testing groups', exact: true });
    const picker = page.getByRole('dialog', { name: 'Add testing groups', exact: true });
    await opener.click(); await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Add testing groups');
    await opener.click(); await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Add testing groups');
    await opener.click();
    await picker.getByRole('checkbox', { name: /Mixed MAP group/ }).check();
    await picker.getByRole('checkbox', { name: /Reading MAP group/ }).check();
    assert.equal(await picker.getByLabel('Mixed MAP group — assigned staff').inputValue(), '');
    assert.equal(await picker.getByRole('button', { name: 'Add 2 testing blocks', exact: true }).isDisabled(), true);
    await picker.getByRole('button', { name: 'Remove selected group Reading MAP group', exact: true }).click();
    await picker.getByLabel('Mixed MAP group — assigned staff').selectOption('burba');
    const evidence = path.resolve(root, '../soc2-evidence/schedule-workspace/browser'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark']) for (const [device, viewport] of Object.entries({ desktop: { width: 1365, height: 950 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport); await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await page.waitForFunction(() => { const box = document.querySelector('[role="dialog"]')?.getBoundingClientRect(); return box && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }, undefined, { timeout: 2500 });
      const bounds = await picker.evaluate(el => { const box = el.getBoundingClientRect(); return { right: box.right, left: box.left, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, maxHeight: getComputedStyle(el).maxHeight }; });
      assert.ok(bounds.right <= bounds.width && bounds.left >= 0 && bounds.top >= 0 && bounds.bottom <= bounds.height, `The picker stays inside the viewport: ${device}/${theme} ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: path.join(evidence, `bulk-${device}-${theme}.png`) });
    }
    await picker.getByRole('button', { name: 'Add 1 testing block', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Add testing groups');
    assert.equal(await workspace.getByLabel('Testing block 1 assigned staff').inputValue(), 'burba', 'Fresh directory assignments remain visible in the editor');
    await opener.click(); await picker.getByRole('checkbox', { name: /Mixed MAP group/ }).check();
    await picker.getByLabel('Mixed MAP group — assigned staff').selectOption('zinkan');
    await picker.getByLabel('Common testing start').fill('11:00'); await picker.getByLabel('Common testing end').fill('12:00');
    await picker.getByRole('button', { name: 'Add 1 testing block', exact: true }).click();
    assert.equal(await workspace.getByLabel('Testing block 1 start').inputValue(), '09:00');
    assert.equal(await workspace.getByLabel('Testing block 2 start').inputValue(), '11:00');
    for (const theme of ['light', 'dark']) for (const [device, viewport] of Object.entries({ desktop: { width: 1365, height: 950 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport); await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await page.evaluate(() => window.scrollTo({ top: 0 }));
      await page.screenshot({ path: path.join(evidence, `workspace-${device}-${theme}.png`), fullPage: true });
    }
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves[0].definition.testingBlocks.length, 2);
    assert.notEqual(saves[0].definition.testingBlocks[0].id, saves[0].definition.testingBlocks[1].id);
  } finally { await browser.close(); await vite.close(); }
});

test('Inline group creation preserves the profile and picker drafts through cancel, failed save, and refresh failure', { timeout: 90_000 }, async context => {
  const { browser, vite, page, control, saves } = await createDraftReviewFixture(context);
  try {
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await workspace.getByLabel('Profile name', { exact: true }).fill('Inline MAP draft');
    await workspace.getByRole('button', { name: 'Load regular schedule', exact: true }).click();
    await workspace.getByRole('tab', { name: 'Testing blocks', exact: true }).click();
    await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add testing groups', exact: true });
    await picker.getByLabel('Common testing start', { exact: true }).fill('09:30');
    await picker.getByRole('button', { name: 'Create group', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Create Supervision Group', exact: true });
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await picker.getByLabel('Common testing start', { exact: true }).inputValue(), '09:30');
    await picker.getByRole('button', { name: 'Create group', exact: true }).click();
    await editor.getByLabel('Name', { exact: true }).fill('New inline MAP');
    await editor.getByRole('group', { name: 'Group staff', exact: true }).getByRole('checkbox', { name: /Ms. Zinkan/ }).check();
    await editor.getByRole('button', { name: 'Select all 1 matching students', exact: true }).click();
    control.failGroupCreate = true;
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.getByText('Could not create the group. No group was saved.', { exact: true }).waitFor();
    assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), 'New inline MAP');
    control.failGroupCreate = false; control.failDirectory = true; control.failGroupCatalogRefresh = true;
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await picker.getByText('Group saved; list refresh unavailable.', { exact: false }).waitFor();
    assert.equal(control.groupCreates.length, 2, 'Only the deliberate failed save and successful retry submit creation');
    await picker.getByRole('button', { name: 'Retry group refresh', exact: true }).waitFor();
    control.failDirectory = false; control.failGroupCatalogRefresh = false;
    await picker.getByRole('button', { name: 'Retry groups', exact: true }).click();
    await picker.getByRole('button', { name: 'Retry group refresh', exact: true }).click();
    await picker.getByRole('button', { name: 'Add 1 testing block', exact: true }).click();
    assert.equal(await workspace.getByLabel('Profile name', { exact: true }).inputValue(), 'Inline MAP draft');
    assert.equal(await workspace.getByLabel('Testing block 1 start', { exact: true }).inputValue(), '09:30');
    assert.equal(await workspace.getByLabel('Testing block 1 assigned staff', { exact: true }).inputValue(), 'zinkan');
    assert.equal(saves.length, 0, 'Creating a reusable group does not save the profile');
    assert.equal(control.groupCreates.length, 2, 'Refreshing never repeats the successful group creation');
  } finally { await browser.close(); await vite.close(); }
});

test('Schedule Profiles saves drafts, reviews exact dates and temporary testing, and protects unsaved changes', { timeout: 90_000 }, async context => {
  const { root, vite, browser, page, url: fixtureUrl } = await createProfileFixture(context);
  const errors = [], saves = [], previews = [], applies = [], cancellations = [], advancedPreviews = [], advancedSaves = [];
  const catalog = { revision: 1, schoolTimezone: 'America/New_York', schoolLocalToday: '2026-09-08', profiles: [], applications: [], classes: [
    { id: 'math', name: 'Grade 3 Math', gradeLevel: '3', teacherName: 'Ms. Rivera', blockStartTime: '09:00', blockEndTime: '09:45', scheduleEnabled: true },
    { id: 'reading', name: 'Grade 3 Reading', gradeLevel: '3', teacherName: 'Mr. Lane', blockStartTime: '10:00', blockEndTime: '10:45', scheduleEnabled: true },
    { id: 'science', name: 'Grade 4 Science', gradeLevel: '4', teacherName: 'Ms. Chen', blockStartTime: '11:00', blockEndTime: '11:45', scheduleEnabled: true },
    { id: 'grammar', name: 'Grade 5 Grammar', gradeLevel: 'Grade 5', teacherName: 'Ms. Chen', blockStartTime: '12:00', blockEndTime: '12:45', scheduleEnabled: true },
  ], staff: [{ id: 'rivera', name: 'Ms. Rivera' }, { id: 'lane', name: 'Mr. Lane' }, { id: 'other', name: 'Other teacher' }], supervisionGroups: [{ id: 'map', name: 'MAP Small Group', studentIds: ['student1', 'student2'], staffIds: ['rivera', 'lane'] }], testingStatuses: [] };
  let config = { schemaVersion: 1, yearStart: '2026-09-01', yearEnd: '2027-06-30', cycleAnchorDate: null, cycleAnchorDay: 'A', periods: [], profiles: [], defaultProfileId: null, weekdayProfiles: {}, dateOverrides: {}, scheduleProfiles: [], profileApplications: [] };
  let blocker = true, staleApply = false;
  try {
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'admin', role: 'school_admin' }, activeSchoolId: 'school', memberships: [{ id: 'membership', schoolId: 'school', role: 'school_admin' }], licenses: { classPilot: true } } });
      if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture-token' } });
      if (url.pathname.endsWith('/instructional-calendar')) return route.fulfill({ json: { month: url.searchParams.get('month'), schoolTimezone: catalog.schoolTimezone, schoolLocalToday: catalog.schoolLocalToday, nonInstructionalDates: [], revision: 1, updatedAt: null } });
      if (url.pathname.endsWith('/schedule-profiles/regular-schedule')) return route.fulfill({ json: { referenceDate: url.searchParams.get('referenceDate'), revision: catalog.revision, schoolTimezone: catalog.schoolTimezone, day: { instructional: true, meetingWeekday: 2, cycleDay: 'A', bellProfile: { id: 'regular', name: 'Regular' }, overridden: false }, classes: catalog.classes.map(row => ({ classId: row.id, status: 'meets', window: { startTime: row.blockStartTime, endTime: row.blockEndTime } })) } });
      if (url.pathname.endsWith('/schedule-profiles/draft-review')) { const body = request.postDataJSON(); return route.fulfill({ json: draftReviewFixture(catalog, body.definition, body.referenceDate) }); }
      if (url.pathname.endsWith('/admin/scheduling/preview')) { advancedPreviews.push(request.postDataJSON()); return route.fulfill({ json: { revision: catalog.revision, previewToken: 'advanced-preview', schoolTimezone: catalog.schoolTimezone, fromDate: catalog.schoolLocalToday, changedOccurrences: 0, blockers: [], changes: [], days: [] } }); }
      if (url.pathname.endsWith('/admin/scheduling')) {
        if (request.method() === 'PUT') { advancedSaves.push(request.postDataJSON()); config = request.postDataJSON().config; catalog.revision++; }
        return route.fulfill({ json: { revision: catalog.revision, config, schoolTimezone: catalog.schoolTimezone, schoolLocalToday: catalog.schoolLocalToday } });
      }
      if (url.pathname.endsWith('/schedule-profiles/preview')) {
        const body = request.postDataJSON(); previews.push(body);
        const definition = body.definition || catalog.profiles.find(row => row.id === body.profileId).definition;
        const mathTime = definition.classRules.find(row => row.classId === 'math');
        return route.fulfill({ json: { previewToken: `preview-${previews.length}`, schoolTimezone: catalog.schoolTimezone, affectedClasses: 2, blockers: blocker ? [{ date: body.dates[0], message: 'Ms. Rivera already supervises another testing group at this time.' }] : [], changes: body.dates.flatMap(date => [{ date, classId: 'math', className: 'Grade 3 Math', before: { startTime: '09:00', endTime: '09:45' }, after: { startTime: mathTime.startTime, endTime: mathTime.endTime } }, { date, classId: 'reading', className: 'Grade 3 Reading', before: { startTime: '10:00', endTime: '10:45' }, after: null }]), testingWindows: body.dates.map(date => ({ date, blockId: 'testing', name: 'MAP testing', assignedStaffId: 'rivera', studentIds: ['student1', 'student2'], startTime: '09:00', endTime: '10:00' })) } });
      }
      if (url.pathname.endsWith('/schedule-profiles/apply')) {
        const body = request.postDataJSON(); applies.push(body);
        if (staleApply) { staleApply = false; catalog.revision++; return route.fulfill({ status: 409, json: { error: 'The schedule changed. Reopen this profile and preview its dates again.' } }); }
        const profile = catalog.profiles.find(row => row.id === body.profileId);
        const application = { id: `application-${applies.length}`, profileId: profile.id, profileName: profile.definition.name, dates: body.dates, status: 'scheduled', testingWindows: [{ date: body.dates[0], blockId: 'testing', name: 'MAP testing', startTime: '09:00', endTime: '10:00' }] };
        catalog.testingStatuses.push({ applicationId: application.id, date: body.dates[0], blockId: 'testing', status: 'failed', code: 'COVERAGE_ROSTER_CHANGED' });
        catalog.applications.push(application); config.profileApplications = structuredClone(catalog.applications); catalog.revision++; return route.fulfill({ json: { application, revision: catalog.revision } });
      }
      if (url.pathname.includes('/schedule-profiles/applications/') && url.pathname.endsWith('/cancel')) {
        cancellations.push(request.postDataJSON()); catalog.applications[0].status = 'cancelled'; catalog.testingStatuses[0].status = 'cancelled'; config.profileApplications = structuredClone(catalog.applications); catalog.revision++; return route.fulfill({ json: { revision: catalog.revision } });
      }
      if (url.pathname.endsWith('/schedule-profiles')) {
        if (request.method() === 'POST') {
          const body = request.postDataJSON(); saves.push(body);
          const existing = catalog.profiles.find(row => row.id === body.id);
          if (existing) { existing.definition = body.definition; existing.revision++; }
          else catalog.profiles.push({ id: `profile-${saves.length}`, revision: 1, definition: body.definition, updatedAt: '2026-09-08T12:00:00Z' });
          config.scheduleProfiles = structuredClone(catalog.profiles); catalog.revision++; return route.fulfill({ json: { revision: catalog.revision, profile: existing || catalog.profiles.at(-1) } });
        }
        return route.fulfill({ json: catalog });
      }
      return route.fulfill({ status: 404, json: { error: `Unexpected fixture request ${url.pathname}` } });
    });
    await page.goto(fixtureUrl);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    let dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByLabel('Profile name', { exact: true }).fill('MAP morning');
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click();
    await dialog.getByRole('button', { name: 'Select grades 1–8', exact: true }).click();
    assert.equal(await dialog.getByLabel('Include Grade 5 Grammar', { exact: true }).isChecked(), true);
    assert.equal(await dialog.getByRole('checkbox', { name: 'Grade 5', exact: true }).count(), 1);
    await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Grade 3', exact: true }).check();
    assert.equal(await dialog.getByLabel('Include Grade 3 Math', { exact: true }).isChecked(), true);
    assert.equal(await dialog.getByLabel('Include Grade 3 Math', { exact: true }).isDisabled(), true);
    await dialog.getByLabel('Include Grade 4 Science', { exact: true }).check();
    await dialog.getByLabel('Grade 3 Math schedule action').selectOption('time');
    await dialog.getByLabel('Grade 3 Math profile start').fill('08:15');
    await dialog.getByLabel('Grade 3 Math profile end').fill('09:00');
    await dialog.getByLabel('Grade 3 Reading schedule action').selectOption('skip');
    await dialog.getByRole('tab', { name: 'Testing blocks', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
    await dialog.getByLabel('Testing block 1 name', { exact: true }).fill('MAP testing');
    await dialog.getByLabel('Testing block 1 Supervision group', { exact: true }).selectOption('map');
    assert.deepEqual(await dialog.getByLabel('Testing block 1 assigned staff', { exact: true }).locator('option').allTextContents(), ['Choose group staff', 'Ms. Rivera', 'Mr. Lane']);
    await dialog.getByLabel('Testing block 1 assigned staff', { exact: true }).selectOption('rivera');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await closeSavedReview(dialog);
    assert.equal(saves.length, 1); assert.equal(applies.length, 0);
    assert.deepEqual(saves[0].definition.grades, ['3']); assert.deepEqual(saves[0].definition.classIds, ['science']);
    assert.deepEqual(saves[0].definition.classRules, [{ classId: 'math', action: 'time', startTime: '08:15', endTime: '09:00' }, { classId: 'reading', action: 'skip' }]);
    assert.equal(saves[0].definition.testingBlocks[0].coverageGroupId, 'map'); assert.equal(saves[0].definition.testingBlocks[0].assignedStaffId, 'rivera');

    await page.getByRole('button', { name: 'More actions for MAP morning', exact: true }).click(); await page.getByRole('menuitem', { name: 'Duplicate MAP morning', exact: true }).click();
    dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true }); await dialog.getByLabel('Profile name', { exact: true }).fill('Early release');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await closeSavedReview(dialog);
    assert.equal(saves[1].id, undefined); assert.equal(saves[1].definition.name, 'Early release');
    await page.getByRole('button', { name: 'Choose dates & apply MAP morning', exact: true }).click(); dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByLabel('Range starts', { exact: true }).fill('2026-09-09'); await dialog.getByLabel('Range ends', { exact: true }).fill('2026-10-15');
    await dialog.getByRole('button', { name: 'Add date range', exact: true }).click(); await dialog.getByText('Choose no more than 31 dates per application.', { exact: true }).waitFor();
    await dialog.getByLabel('Range ends', { exact: true }).fill('2026-09-10'); await dialog.getByRole('button', { name: 'Add date range', exact: true }).click();
    await dialog.getByLabel('Add an individual date', { exact: true }).fill('2026-09-15'); await dialog.getByRole('button', { name: 'Add selected date', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    await dialog.getByLabel('Grade 3 Math profile start').fill('08:00');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click();
    await dialog.getByText(/Ms. Rivera already supervises/).waitFor(); assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).isDisabled(), true);
    assert.deepEqual(previews[0].dates, ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-15']);
    assert.equal(previews[0].definition.classRules.find(row => row.classId === 'math').startTime, '08:00');
    assert.equal(catalog.profiles[0].definition.classRules.find(row => row.classId === 'math').startTime, '08:15');
    await dialog.getByLabel('Grade 3 Math profile start').fill('08:10'); assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    blocker = false;
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    const artifactDir = path.join(root, 'artifacts', 'schedule-profiles'); await mkdir(artifactDir, { recursive: true });
    await dialog.getByRole('region', { name: 'Profile application preview', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDir, 'review-desktop.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(applies[0].previewToken, 'preview-2'); assert.deepEqual(applies[0].dates, previews[1].dates); assert.deepEqual(applies[0].definition, previews[1].definition);
    await page.getByRole('region', { name: 'Schedule profile applications' }).getByText('Applied · Today', { exact: true }).waitFor();
    await page.getByText('The Supervision group roster changed.', { exact: true }).waitFor();
    const recoveryHint = 'Use Coverage to manage any testing still needed today. Failed or missed windows do not restart automatically.';
    await page.getByText(recoveryHint, { exact: true }).waitFor();
    for (const [code, expected] of [
      ['CLASSPILOT_NOT_ENTITLED', "ClassPilot access is unavailable for this school. Check the school's license."],
      ['NON_INSTRUCTIONAL_DATE', 'This is a non-instructional date. Review the school calendar before scheduling testing.'],
      ['MONITORING_NOT_FULL', 'Full classroom monitoring is unavailable. Review Monitoring Hours for this testing time.'],
      ['SCHEDULE_PROFILE_MONITORING_NOT_FULL', 'Full classroom monitoring is not available for the entire testing block. Review Monitoring Hours.'],
      ['SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT', 'The assigned staff member has an overlapping class. Review that class or choose another proctor.'],
      ['SCHEDULE_PROFILE_FROZEN_ROSTER_UNAVAILABLE', 'A class session has an incomplete saved roster. Resolve that session before assigning its teacher to testing.'],
      ['SCHEDULE_PROFILE_CLASS_WINDOW_UNAVAILABLE', 'A related class has an unresolved schedule. Review its period, calendar mapping or approved schedule change.'],
      ['SCHEDULE_PROFILE_VALIDATION_LIMIT', 'The testing selection is too large to validate. Narrow the selection before scheduling another application.'],
      ['ACTIVATION_FAILED', 'Testing supervision could not start. Review the schedule and Coverage setup.'],
    ]) {
      catalog.testingStatuses[0].code = code;
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await page.getByText(expected, { exact: true }).waitFor();
      assert.equal(await page.getByRole('region', { name: 'Schedule profile applications' }).getByText(code, { exact: true }).count(), 0);
      assert.equal(await page.getByText(recoveryHint, { exact: true }).isVisible(), true);
    }
    catalog.testingStatuses[0].status = 'missed'; catalog.testingStatuses[0].code = 'WINDOW_ELAPSED';
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByText('The testing window elapsed before it could start.', { exact: true }).waitFor();
    assert.equal(await page.getByText(recoveryHint, { exact: true }).isVisible(), true);

    await page.getByRole('button', { name: 'More actions for MAP morning', exact: true }).click(); await page.getByRole('menuitem', { name: 'Edit MAP morning', exact: true }).click(); dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByLabel('Profile name', { exact: true }).fill('MAP revised');
    page.once('dialog', prompt => prompt.dismiss()); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await closeSavedReview(dialog);
    assert.equal(saves[2].id, 'profile-1'); assert.equal(saves[2].profileRevision, 1); assert.equal(catalog.applications[0].profileName, 'MAP morning');
    page.once('dialog', prompt => prompt.accept()); await page.getByRole('button', { name: 'Cancel application MAP morning', exact: true }).click();
    await page.getByRole('region', { name: 'Schedule profile applications' }).getByText('Cancelled', { exact: true }).first().waitFor(); assert.equal(cancellations.length, 1);
    assert.equal(await page.getByText(recoveryHint, { exact: true }).count(), 0);
    catalog.applications.push({ id: 'previous-application', profileId: 'profile-1', profileName: 'Previous testing day', dates: ['2026-09-07'], status: 'scheduled', testingWindows: [] }); config.profileApplications = structuredClone(catalog.applications);
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await page.getByText('Completed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel application Previous testing day', exact: true }).count(), 0);

    await page.getByRole('button', { name: 'Choose dates & apply MAP revised', exact: true }).click(); dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor(); staleApply = true;
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: 'Reopen this profile' }).waitFor();
    assert.equal(await dialog.isVisible(), true); assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Choose dates & apply MAP revised', exact: true }).click(); dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check(); await dialog.getByLabel('Name for new profile', { exact: true }).fill('MAP afternoon');
    await dialog.getByRole('button', { name: 'Save as new profile', exact: true }).click(); await closeSavedReview(dialog); assert.equal(saves.at(-1).id, undefined); assert.equal(saves.at(-1).definition.name, 'MAP afternoon');
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(artifactDir, 'profiles-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('button', { name: 'Choose dates & apply MAP afternoon', exact: true }).click(); dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    await page.screenshot({ path: path.join(artifactDir, 'application-mobile.png'), animations: 'disabled' });
    if (await dialog.evaluate(e => e.scrollWidth > e.clientWidth)) context.diagnostic(JSON.stringify(await dialog.evaluate(e => [...e.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > e.getBoundingClientRect().right + 1).slice(0,8).map(n => ({ tag:n.tagName, cls:n.className, width:n.getBoundingClientRect().width, text:n.textContent.slice(0,60) })))));
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    page.once('dialog', prompt => prompt.accept()); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('tab', { name: 'Bells & rotation', exact: true }).click();
    await page.getByLabel('School year ends', { exact: true }).fill('2027-06-29');
    await page.getByRole('tab', { name: 'Schedule profiles', exact: true }).click();
    await page.getByText('Save or discard the bell, rotation, date-override or calendar draft before changing profiles or their applications.', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: 'Bells & rotation', exact: true }).click();
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click(); await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).waitFor();
    assert.deepEqual(advancedPreviews[0].config.scheduleProfiles, catalog.profiles); assert.deepEqual(advancedPreviews[0].config.profileApplications, catalog.applications);
    await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
    await page.getByRole('tab', { name: 'Schedule profiles', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="schedule-profiles"] button')?.disabled);
    assert.deepEqual(advancedSaves[0].config.scheduleProfiles, catalog.profiles); assert.deepEqual(advancedSaves[0].config.profileApplications, catalog.applications);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await vite.close(); }
});

test('Regular-day profile comparison loads eligible classes without freezing times or replacing edits', { timeout: 90_000 }, async context => {
  const { root, vite, browser, page, url: fixtureUrl } = await createProfileFixture(context);
  const errors = [], reads = [], mutations = [], saves = [];
  const catalog = { revision: 1, schoolTimezone: 'America/New_York', schoolLocalToday: '2026-09-08', profiles: [], applications: [], staff: [], supervisionGroups: [], testingStatuses: [], classes: [
    { id: 'science', name: 'Period Science', gradeLevel: '4', teacherName: 'Ms. Chen', scheduleEnabled: true, blockStartTime: null, blockEndTime: null },
    { id: 'math', name: 'Fixed Math', gradeLevel: '3', teacherName: 'Ms. Rivera', scheduleEnabled: true, blockStartTime: '07:00', blockEndTime: '07:30' },
    { id: 'reading', name: 'B-day Reading', gradeLevel: '3', teacherName: 'Mr. Lane', scheduleEnabled: true, blockStartTime: '13:00', blockEndTime: '13:45' },
    { id: 'off', name: 'Schedule Disabled', gradeLevel: '5', scheduleEnabled: false, blockStartTime: '14:00', blockEndTime: '14:30' },
    { id: 'missing', name: 'Unmapped Period', gradeLevel: '5', scheduleEnabled: true, blockStartTime: null, blockEndTime: null },
  ] };
  let releaseOld, failReference = true, largeCatalog = false;
  const projection = referenceDate => ({
    referenceDate, revision: catalog.revision, schoolTimezone: catalog.schoolTimezone,
    day: { instructional: referenceDate !== '2026-09-12', meetingWeekday: new Date(`${referenceDate}T12:00:00Z`).getUTCDay(), cycleDay: referenceDate === '2026-09-09' ? 'B' : 'A', bellProfile: { id: 'regular', name: 'Regular' }, overridden: false },
    classes: catalog.classes.map(row => {
      if (row.id === 'off') return { classId: row.id, status: 'schedule_off', window: null };
      if (referenceDate === '2026-09-12' || referenceDate === '2026-09-13') return { classId: row.id, status: 'not_scheduled', window: null };
      if (row.id === 'missing') return referenceDate === '2026-09-15' ? { classId: row.id, status: 'unavailable', window: null, code: 'SCHEDULE_PERIOD_UNAVAILABLE', message: 'This class needs a mapped bell period.' } : { classId: row.id, status: 'not_scheduled', window: null };
      if (row.id === 'reading') return referenceDate === '2026-09-09' ? { classId: row.id, status: 'meets', window: { startTime: '11:30', endTime: '12:15' } } : { classId: row.id, status: 'not_scheduled', window: null };
      if (row.id === 'science' && referenceDate === '2026-09-09') return { classId: row.id, status: 'not_scheduled', window: null };
      const window = row.id === 'science' ? { startTime: '10:15', endTime: '11:00' } : referenceDate === '2026-09-11' ? { startTime: '11:15', endTime: '12:00' } : referenceDate === '2026-09-10' ? { startTime: '13:15', endTime: '14:00' } : { startTime: '09:10', endTime: '09:55' };
      return { classId: row.id, status: 'meets', window };
    }),
  });
  try {
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', prompt => prompt.accept());
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' && !url.pathname.endsWith('/schedule-profiles/draft-review')) mutations.push({ path: url.pathname, body: request.postDataJSON() });
      if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { user: { id: 'admin', role: 'school_admin' }, activeSchoolId: 'school', memberships: [{ id: 'membership', schoolId: 'school', role: 'school_admin' }], licenses: { classPilot: true } } });
      if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture-token' } });
      if (url.pathname.endsWith('/instructional-calendar')) return route.fulfill({ json: { month: url.searchParams.get('month'), schoolTimezone: catalog.schoolTimezone, schoolLocalToday: catalog.schoolLocalToday, nonInstructionalDates: [], revision: 1, updatedAt: null } });
      if (url.pathname.endsWith('/admin/scheduling')) return route.fulfill({ json: { revision: catalog.revision, schoolTimezone: catalog.schoolTimezone, schoolLocalToday: catalog.schoolLocalToday, config: { schemaVersion: 1, yearStart: null, yearEnd: null, cycleAnchorDate: null, cycleAnchorDay: 'A', periods: [], profiles: [], defaultProfileId: null, weekdayProfiles: {}, dateOverrides: {}, scheduleProfiles: catalog.profiles, profileApplications: [] } } });
      if (url.pathname.endsWith('/schedule-profiles/regular-schedule')) {
        const date = url.searchParams.get('referenceDate'); reads.push(date);
        if (date === '2026-09-14' && failReference) return route.fulfill({ status: 503, json: { error: 'Reference schedule is temporarily unavailable.' } });
        if (date === '2026-09-10') await new Promise(resolve => { releaseOld = resolve; });
        return route.fulfill({ json: projection(date) });
      }
      if (url.pathname.endsWith('/schedule-profiles/draft-review')) { const body = request.postDataJSON(); return route.fulfill({ json: draftReviewFixture(catalog, body.definition, body.referenceDate, projection(body.referenceDate).classes) }); }
      if (url.pathname.endsWith('/schedule-profiles')) {
        if (request.method() === 'POST') {
          const body = request.postDataJSON(); saves.push(body);
          const existing = catalog.profiles.find(row => row.id === body.id);
          if (existing) { existing.definition = body.definition; existing.revision++; }
          else catalog.profiles.push({ id: `regular-${saves.length}`, revision: 1, definition: body.definition });
          catalog.revision++;
          return route.fulfill({ json: { revision: catalog.revision, profile: existing || catalog.profiles.at(-1) } });
        }
        return route.fulfill({ json: catalog });
      }
      return route.fulfill({ status: 404, json: { error: `Unexpected fixture request ${url.pathname}` } });
    });
    await page.goto(fixtureUrl);
    await page.waitForLoadState('networkidle');
    const dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    const row = name => dialog.getByRole('row').filter({ has: page.getByLabel(`Include ${name}`, { exact: true }) });
    const reference = dialog.getByLabel('Reference date', { exact: true });
    const openNew = async name => {
      await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
      await dialog.getByLabel('Profile name', { exact: true }).fill(name);
    };
    const changeDate = async date => {
      const loaded = page.waitForResponse(response => response.url().includes('/schedule-profiles/regular-schedule?') && new URL(response.url()).searchParams.get('referenceDate') === date);
      await reference.fill(date); await loaded; await page.waitForLoadState('networkidle');
    };
    const cancel = async () => { await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };

    await openNew('Whole day');
    assert.equal(await reference.inputValue(), catalog.schoolLocalToday);
    const load = dialog.getByRole('button', { name: 'Load regular schedule', exact: true });
    await load.waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).isDisabled(), true);
    assert.equal(mutations.length, 0, 'Opening and comparing a day must use read-only requests');
    const artifactDir = path.join(root, 'artifacts', 'schedule-profiles'); await mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, 'regular-setup-desktop-light.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.documentElement.classList.add('dark'));
    if (await dialog.evaluate(e => e.scrollWidth > e.clientWidth)) context.diagnostic(JSON.stringify(await dialog.evaluate(e => [...e.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > e.getBoundingClientRect().right + 1).slice(0,8).map(n => ({ tag:n.tagName, cls:n.className, width:n.getBoundingClientRect().width, text:n.textContent.slice(0,60) })))));
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: path.join(artifactDir, 'regular-setup-mobile-dark.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.classList.remove('dark')); await page.setViewportSize({ width: 1365, height: 950 });
    await load.focus(); await page.keyboard.press('Enter');
    await dialog.getByRole('columnheader', { name: 'Regular schedule', exact: true }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Keyboard navigation must remain inside the dialog after Load unmounts');
    assert.deepEqual(await dialog.locator('input[aria-label^="Include "]').evaluateAll(inputs => inputs.filter(input => input.checked).map(input => input.getAttribute('aria-label')).sort()), ['Include Fixed Math', 'Include Period Science']);
    assert.match(await row('Fixed Math').innerText(), /09:10–09:55/);
    assert.match(await row('Period Science').innerText(), /10:15–11:00/);
    assert.match(await row('B-day Reading').innerText(), /Does not meet on this reference date/);
    assert.match(await row('Schedule Disabled').innerText(), /Schedule off/);
    const scienceSelection = dialog.getByLabel('Include Period Science', { exact: true });
    await scienceSelection.focus(); await page.keyboard.press('Space'); assert.equal(await scienceSelection.isChecked(), false);
    await page.keyboard.press('Space'); assert.equal(await scienceSelection.isChecked(), true);
    await dialog.getByLabel('Period Science schedule action').selectOption('time');
    assert.equal(await dialog.getByLabel('Period Science profile start').inputValue(), '10:15', 'Custom period times must seed from the resolved reference window');
    assert.equal(await dialog.getByLabel('Period Science profile end').inputValue(), '11:00');
    for (const [size, viewport] of [['desktop', { width: 1365, height: 950 }], ['mobile', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        await dialog.getByRole('table').scrollIntoViewIfNeeded();
        if (size === 'mobile' && theme === 'dark') {
          await dialog.getByText('Scroll the timetable sideways to see profile adjustments.', { exact: true }).waitFor();
          const comparison = dialog.getByRole('region', { name: 'Class schedule comparison', exact: true });
          assert.equal(await comparison.evaluate(element => element.scrollWidth > element.clientWidth), true, 'The mobile table must overflow within its labelled scroll region');
          await comparison.evaluate(element => { element.scrollLeft = 0; });
          await comparison.focus();
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(() => document.querySelector('[aria-label="Class schedule comparison"]')?.scrollLeft > 0, undefined, { timeout: 5000 });
          assert.equal(await comparison.evaluate(element => element === document.activeElement && getComputedStyle(element).boxShadow !== 'none'), true, 'The labelled table scroller must show keyboard focus');
          await dialog.getByLabel('Period Science schedule action').focus(); await page.keyboard.press('Tab');
          const start = dialog.getByLabel('Period Science profile start');
          assert.equal(await start.evaluate(element => element === document.activeElement), true, 'The mobile table must allow keyboard access to custom-time controls');
          const inputBounds = await start.boundingBox(), dialogBounds = await dialog.boundingBox();
          assert.ok(inputBounds.x >= dialogBounds.x && inputBounds.x + inputBounds.width <= dialogBounds.x + dialogBounds.width, 'Focused controls must scroll into the mobile dialog viewport');
        }
        if (await dialog.evaluate(e => e.scrollWidth > e.clientWidth)) context.diagnostic(JSON.stringify(await dialog.evaluate(e => [...e.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > e.getBoundingClientRect().right + 1).slice(0,8).map(n => ({ tag:n.tagName, cls:n.className, width:n.getBoundingClientRect().width, text:n.textContent.slice(0,60) })))));
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: path.join(artifactDir, `regular-day-${size}-${theme}.png`), animations: 'disabled' });
      }
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark')); await page.setViewportSize({ width: 1365, height: 950 });
    await dialog.getByLabel('Period Science schedule action').selectOption('keep');
    await dialog.getByLabel('Fixed Math schedule action').selectOption('skip');
    await dialog.getByLabel('Fixed Math schedule action').selectOption('keep');
    assert.equal(await dialog.getByLabel('Period Science profile start').count(), 0);
    await dialog.getByLabel('Fixed Math schedule action').selectOption('time');
    await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click();
    assert.equal(await dialog.locator('input[aria-label^="Include "]:checked').count(), 0, 'Clear selection removes the imported whole-day selection');
    assert.equal(await dialog.getByLabel('Fixed Math profile start').count(), 0, 'Clearing the selection also removes its overrides');
    await dialog.getByLabel('Include Fixed Math', { exact: true }).check(); await scienceSelection.check();
    assert.equal(mutations.length, 0, 'Selection and rule changes remain local until Save profile');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await closeSavedReview(dialog);
    assert.deepEqual(saves[0].definition.classIds.slice().sort(), ['math', 'science']);
    assert.deepEqual(saves[0].definition.classRules, [], 'Keeping every class saves no frozen time or skip overrides');
    assert.equal(JSON.stringify(saves[0]).includes('referenceDate'), false);

    await page.getByRole('button', { name: 'More actions for Whole day', exact: true }).click(); await page.getByRole('menuitem', { name: 'Edit Whole day', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await dialog.getByLabel('Fixed Math schedule action').selectOption('time');
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '09:10', 'The comparison must not seed from raw stored block columns');
    await dialog.getByLabel('Fixed Math profile start').fill('08:00'); await dialog.getByLabel('Fixed Math profile end').fill('08:30');
    await scienceSelection.uncheck(); await dialog.getByLabel('Include B-day Reading', { exact: true }).check();
    await changeDate('2026-09-09');
    assert.match(await row('Period Science').innerText(), /Does not meet on this reference date/);
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '08:00');
    assert.equal(await scienceSelection.isChecked(), false); assert.equal(await dialog.getByLabel('Include B-day Reading', { exact: true }).isChecked(), true);
    const oldRequest = page.waitForRequest(request => request.url().includes('regular-schedule?referenceDate=2026-09-10'));
    await reference.fill('2026-09-10'); await oldRequest;
    await dialog.getByRole('status').filter({ hasText: 'Loading regular schedule' }).waitFor();
    assert.equal(await dialog.getByLabel('B-day Reading schedule action').locator('option[value="time"]').isDisabled(), true, 'A pending comparison must not seed an override from the old date');
    const latestResponse = page.waitForResponse(response => response.url().includes('regular-schedule?referenceDate=2026-09-11'));
    await reference.fill('2026-09-11'); await latestResponse;
    await row('Fixed Math').getByText('11:15–12:00', { exact: true }).waitFor();
    releaseOld?.(); releaseOld = null; await page.waitForLoadState('networkidle');
    assert.equal(await reference.inputValue(), '2026-09-11');
    assert.match(await row('Fixed Math').innerText(), /11:15–12:00/); assert.doesNotMatch(await row('Fixed Math').innerText(), /13:15–14:00/);
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '08:00');
    assert.equal(mutations.length, 1, 'Refreshing and racing reference dates must not write a profile');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await closeSavedReview(dialog);
    assert.deepEqual(saves[1].definition.classIds.slice().sort(), ['math', 'reading']);
    assert.deepEqual(saves[1].definition.classRules, [{ classId: 'math', action: 'time', startTime: '08:00', endTime: '08:30' }]);
    assert.equal(JSON.stringify(saves[1]).includes('referenceDate'), false);
    await page.getByRole('button', { name: 'More actions for Whole day', exact: true }).click(); await page.getByRole('menuitem', { name: 'Duplicate Whole day', exact: true }).click();
    await dialog.getByRole('columnheader', { name: 'Regular schedule', exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '08:00'); await cancel();
    await page.getByRole('button', { name: 'Choose dates & apply Whole day', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove application date 2026-09-08', exact: true }).click();
    await dialog.getByLabel('Add an individual date', { exact: true }).fill('2026-09-11'); await dialog.getByRole('button', { name: 'Add selected date', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    assert.equal(await reference.inputValue(), '2026-09-11', 'An application comparison starts from its first selected date'); await cancel();

    await openNew('Reference checks'); await changeDate('2026-09-12');
    await dialog.getByRole('status').filter({ hasText: 'non-instructional day' }).waitFor(); assert.equal(await load.isDisabled(), true);
    await changeDate('2026-09-13'); await dialog.getByRole('status').filter({ hasText: 'No scheduled classes meet' }).waitFor(); assert.equal(await load.isDisabled(), true);
    await changeDate('2026-09-14'); await dialog.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor(); assert.equal(await load.isDisabled(), true);
    failReference = false;
    const retried = page.waitForResponse(response => response.url().includes('regular-schedule?referenceDate=2026-09-14') && response.status() === 200);
    await dialog.getByRole('button', { name: 'Retry regular schedule', exact: true }).click(); await retried;
    await dialog.getByRole('button', { name: 'Load regular schedule', exact: true, disabled: false }).waitFor();
    await changeDate('2026-09-15'); await dialog.getByRole('alert').filter({ hasText: 'Some regular times are unavailable' }).waitFor(); assert.equal(await load.isDisabled(), true);
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click();
    await dialog.getByLabel('Include Unmapped Period', { exact: true }).check();
    assert.match(await row('Unmapped Period').innerText(), /This class needs a mapped bell period/);
    assert.equal(await dialog.getByLabel('Unmapped Period schedule action').locator('option[value="time"]').isDisabled(), true);
    await reference.fill(''); await dialog.getByText('Choose a valid reference date to see regular class times.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Refresh regular schedule', exact: true }).isDisabled(), true); await cancel();

    largeCatalog = true;
    catalog.classes = Array.from({ length: 501 }, (_, index) => ({ id: `class-${index}`, name: `Class ${index + 1}`, gradeLevel: '3', scheduleEnabled: true }));
    await page.reload(); await page.waitForLoadState('networkidle'); await openNew('Large day');
    await dialog.getByRole('alert').filter({ hasText: 'more than 500 classes' }).waitFor(); assert.equal(await load.isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Start blank', exact: true }).isEnabled(), true);
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click(); await dialog.getByLabel('Include Class 1', { exact: true }).check();
    assert.equal(await dialog.locator('input[aria-label^="Include "]:checked').count(), 1, 'Start blank must allow a smaller selection without silently truncating the day');
    await cancel();
    assert.equal(mutations.length, 2); assert.equal(mutations.every(mutation => mutation.path.endsWith('/schedule-profiles')), true);
    assert.equal(reads.includes('2026-09-10') && reads.includes('2026-09-11') && largeCatalog, true);
    assert.deepEqual(errors, []);
  } finally { releaseOld?.(); await browser?.close(); await vite.close(); }
});

test('Draft review keeps conflicts advisory, shows the whole day and partial groups, and preserves editing context', { timeout: 120_000 }, async context => {
  const { root, vite, browser, page, reviews, saves, previews, applies, errors } = await createDraftReviewFixture(context);
  const dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const check = dialog.getByRole('region', { name: 'Draft schedule check', exact: true });
  const review = dialog.getByRole('region', { name: 'Draft schedule review', exact: true });
  const reviewRow = name => review.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
  const capture = async (label, region) => {
    const directory = path.resolve(root, '..', 'soc2-evidence', 'validation', 'schedule-profile-draft-review', 'browser');
    await mkdir(directory, { recursive: true });
    for (const [size, viewport] of [['desktop', { width: 1365, height: 950 }], ['mobile', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        await region.scrollIntoViewIfNeeded();
        assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Review content must fit the dialog at every viewport');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: path.join(directory, `${label}-${size}-${theme}.png`), animations: 'disabled' });
        if (label === 'saved-review') {
          await review.getByRole('region', { name: 'Proposed day timetable', exact: true }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(directory, `saved-timetable-${size}-${theme}.png`), animations: 'disabled' });
        }
      }
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark')); await page.setViewportSize({ width: 1365, height: 950 });
  };
  try {
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    await dialog.getByLabel('Profile name', { exact: true }).fill('Testing review');
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click();
    for (const name of ['Zinkan Math', 'Burba Reading', 'Vatter Science']) await dialog.getByLabel(`Include ${name}`, { exact: true }).check();
    for (const [index, teacher] of ['zinkan', 'burba', 'vatter'].entries()) await addTestingBlock(dialog, index + 1, teacher);
    await check.getByText('3 conflicts need attention', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'Advisory conflicts must never interrupt typing with another modal');
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).isEnabled(), true, 'Complete drafts remain saveable while conflicts remain');
    await dialog.getByRole('region', { name: 'Testing blocks', exact: true }).getByText(/other students keep their regular class/).first().waitFor();
    await dialog.getByRole('tab', { name: 'Classes', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'View grade', exact: true }).selectOption('3');
    await dialog.getByLabel('Find a class or teacher', { exact: true }).fill('Zinkan');
    await dialog.getByLabel('Reference date', { exact: true }).fill('2026-09-09');
    await page.waitForResponse(response => response.url().endsWith('/schedule-profiles/draft-review') && response.request().postDataJSON().referenceDate === '2026-09-09');
    await dialog.getByRole('button', { name: 'Review draft schedule', exact: true }).click();
    await review.waitFor();
    assert.equal(await review.getByRole('combobox', { name: 'Review grade', exact: true }).inputValue(), '3', 'The first review starts from the editor grade');
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('all');
    for (const name of ['Zinkan Math', 'Burba Reading', 'Vatter Science', 'Art Studio']) await reviewRow(name).first().waitFor();
    assert.equal(saves.length, 0); assert.equal(previews.length, 0); assert.equal(applies.length, 0);
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('4');
    await review.getByRole('combobox', { name: 'Review class', exact: true }).selectOption('art');
    await reviewRow('Art Studio').waitFor(); await reviewRow('Zinkan MAP').waitFor();
    assert.equal(await reviewRow('Burba MAP').count(), 0, 'Class filtering excludes unrelated groups');
    assert.equal(await reviewRow('Vatter MAP').count(), 0);
    assert.match(await reviewRow('Zinkan MAP').innerText(), /2.*24|2 of 24/, 'A partial Supervision group remains visible for its participating class');
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('all');
    await review.getByRole('combobox', { name: 'Review class', exact: true }).selectOption('all');
    await review.getByRole('combobox', { name: 'Schedule view', exact: true }).selectOption('teachers');
    await review.getByRole('combobox', { name: 'Review teacher', exact: true }).selectOption('zinkan');
    await review.getByText('Zinkan MAP', { exact: true }).first().waitFor();
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('4');
    await review.getByRole('combobox', { name: 'Review class', exact: true }).selectOption('art');
    await reviewRow('Zinkan MAP').waitFor();
    assert.equal(await reviewRow('Art Studio').count(), 0, 'The selected proctor need not teach the participating regular class');
    await dialog.getByRole('button', { name: 'Back to editing', exact: true }).click();
    assert.equal(await dialog.getByLabel('Profile name', { exact: true }).inputValue(), 'Testing review');
    assert.equal(await dialog.getByLabel('Reference date', { exact: true }).inputValue(), '2026-09-09');
    assert.equal(await dialog.getByRole('combobox', { name: 'View grade', exact: true }).inputValue(), '3');
    assert.equal(await dialog.getByLabel('Find a class or teacher', { exact: true }).inputValue(), 'Zinkan');
    await dialog.getByRole('button', { name: 'Review draft schedule', exact: true }).click();
    assert.equal(await review.getByRole('combobox', { name: 'Schedule view', exact: true }).inputValue(), 'teachers');
    assert.equal(await review.getByRole('combobox', { name: 'Review teacher', exact: true }).inputValue(), 'zinkan');
    assert.equal(await review.getByRole('combobox', { name: 'Review grade', exact: true }).inputValue(), '4');
    assert.equal(await review.getByRole('combobox', { name: 'Review class', exact: true }).inputValue(), 'art');
    await review.getByRole('combobox', { name: 'Schedule view', exact: true }).selectOption('classes');
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('all');
    await review.getByRole('button', { name: 'Edit affected class Zinkan Math', exact: true }).first().click();
    await dialog.getByLabel('Zinkan Math schedule action', { exact: true }).waitFor();
    assert.equal(await dialog.locator('[data-class-editor-id="math"]').evaluate(element => element.contains(document.activeElement)), true);
    await dialog.getByLabel('Zinkan Math schedule action', { exact: true }).selectOption('time');
    await dialog.getByLabel('Zinkan Math profile end', { exact: true }).fill('11:15');
    await dialog.getByLabel('Zinkan Math profile start', { exact: true }).fill('10:15');
    await check.getByText('2 conflicts need attention', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Review draft schedule', exact: true }).click();
    await review.getByRole('button', { name: 'Edit affected class Burba Reading', exact: true }).first().click();
    assert.equal(await dialog.locator('[data-class-editor-id="reading"]').evaluate(element => element.contains(document.activeElement)), true);
    await dialog.getByLabel('Burba Reading schedule action', { exact: true }).selectOption('skip');
    await check.getByText(/1 conflict.*need/).waitFor();
    await dialog.getByRole('button', { name: 'Review draft schedule', exact: true }).click();
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('4');
    await review.getByLabel('Show conflicts only', { exact: true }).check();
    await reviewRow('Vatter Science').waitFor();
    assert.equal(await reviewRow('Art Studio').count(), 0, 'Allowed overlap must not be presented as a blocking conflict');
    await review.getByRole('button', { name: 'Edit testing block Vatter MAP', exact: true }).first().click();
    assert.equal(await dialog.getByLabel('Testing block 3 name', { exact: true }).evaluate(element => element === document.activeElement), true);
    assert.equal(await dialog.getByLabel('Zinkan Math profile start', { exact: true }).inputValue(), '10:15');
    assert.equal(await dialog.getByLabel('Burba Reading schedule action', { exact: true }).inputValue(), 'skip');
    await capture('editor-notices', check);
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Schedule for Testing review', exact: true }).waitFor();
    await dialog.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves.length, 1); assert.equal(previews.length, 0); assert.equal(applies.length, 0);
    assert.equal(saves[0].definition.classRules.some(rule => rule.classId === 'science'), false, 'Saving a conflict must preserve Keep without inventing a fix');
    await check.getByText(/1 conflict.*need/).waitFor();
    await capture('saved-review', review);
    await closeSavedReview(dialog);
    assert.equal(await page.getByRole('button', { name: 'Apply Testing review', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Open profile Testing review', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Schedule for Testing review', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Close schedule', exact: true }).click();
    assert.equal(saves.length, 1); assert.ok(reviews.length > 3); assert.deepEqual(errors, []);
  } catch (error) { context.diagnostic(await dialog.ariaSnapshot()); throw error; }
  finally { await browser.close(); await vite.close(); }
});

test('Draft review discards stale date and definition responses and keeps incomplete or failed checks honest', { timeout: 90_000 }, async context => {
  const { vite, browser, page, catalog, control, reviews, saves, errors } = await createDraftReviewFixture(context);
  const dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const check = dialog.getByRole('region', { name: 'Draft schedule check', exact: true });
  const pending = [];
  try {
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    await dialog.getByLabel('Profile name', { exact: true }).fill('Draft checks');
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Testing blocks', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
    await check.getByText('Draft review is incomplete.', { exact: true }).waitFor();
    assert.equal(await check.getByText('No blocking conflicts on this reference date.', { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Each testing block needs a name' }).waitFor(); assert.equal(saves.length, 0);
    await dialog.getByLabel('Testing block 1 name', { exact: true }).fill('Zinkan MAP');
    await dialog.getByLabel('Testing block 1 Supervision group', { exact: true }).selectOption('zinkan-group');
    await dialog.getByLabel('Testing block 1 assigned staff', { exact: true }).selectOption('zinkan');
    await check.getByText(/1 conflict.*need/).waitFor();
    control.reviewResponse = async (body, result) => {
      if (body.referenceDate === '2026-09-10' || body.definition.name === 'Delayed definition') {
        await new Promise(resolve => pending.push(resolve));
        result.issues = [{ id: 'stale', kind: 'conflict', code: 'SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT', message: 'Stale response must never be displayed.', classIds: ['math'], blockIds: [], staffIds: ['zinkan'] }];
        result.counts = { conflicts: 99, overlaps: 0, incomplete: 0 };
      }
      if (body.referenceDate === '2026-09-12') return { status: 503, json: { error: 'Draft comparison is temporarily unavailable.' } };
      return { json: result };
    };
    let sent = page.waitForRequest(request => request.url().endsWith('/draft-review') && request.postDataJSON().referenceDate === '2026-09-10');
    await dialog.getByLabel('Reference date', { exact: true }).fill('2026-09-10'); await sent;
    await check.getByText('Checking draft schedule…', { exact: true }).waitFor();
    assert.equal(await check.getByText(/1 conflict.*need/).count(), 0, 'Old advisory findings must disappear while the current date is pending');
    let loaded = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().referenceDate === '2026-09-11');
    await dialog.getByLabel('Reference date', { exact: true }).fill('2026-09-11'); await loaded;
    pending.splice(0).forEach(resolve => resolve()); await page.waitForLoadState('networkidle');
    await check.getByText(/1 conflict.*need/).waitFor();
    assert.equal(await check.getByText('Stale response must never be displayed.', { exact: true }).count(), 0);
    sent = page.waitForRequest(request => request.url().endsWith('/draft-review') && request.postDataJSON().definition.name === 'Delayed definition');
    await dialog.getByLabel('Profile name', { exact: true }).fill('Delayed definition'); await sent;
    loaded = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().definition.name === 'Current definition');
    await dialog.getByLabel('Profile name', { exact: true }).fill('Current definition'); await loaded;
    pending.splice(0).forEach(resolve => resolve()); await page.waitForLoadState('networkidle');
    assert.equal(await check.getByText('Stale response must never be displayed.', { exact: true }).count(), 0);
    await dialog.getByLabel('Reference date', { exact: true }).fill('2026-09-12');
    await check.getByText('Could not review this draft schedule.', { exact: true }).waitFor();
    assert.equal(await check.getByText(/No blocking conflicts|1 conflict.*need/).count(), 0, 'A failed review cannot retain a reassuring or stale result');
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).isEnabled(), true);
    control.reviewResponse = null;
    await check.getByRole('button', { name: 'Retry draft review', exact: true }).click(); await check.getByText(/1 conflict.*need/).waitFor();
    assert.equal(await dialog.getByLabel('Profile name', { exact: true }).inputValue(), 'Current definition');
    assert.equal(await dialog.getByLabel('Reference date', { exact: true }).inputValue(), '2026-09-12');
    const reviewsBeforeRefresh = reviews.length, unchangedRevision = catalog.revision;
    catalog.classes[0].blockStartTime = '11:00'; catalog.classes[0].blockEndTime = '12:00';
    loaded = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().referenceDate === '2026-09-12');
    await dialog.getByRole('button', { name: 'Refresh regular schedule', exact: true }).click(); await loaded;
    await check.getByText('No blocking conflicts on this reference date.', { exact: true }).waitFor();
    assert.equal(catalog.revision, unchangedRevision);
    assert.ok(reviews.length > reviewsBeforeRefresh, 'Refreshing regular clocks must refresh advisory findings even without a scheduling revision change');
    assert.equal(saves.length, 0); assert.ok(reviews.length > 4); assert.deepEqual(errors, []);
  } finally { pending.splice(0).forEach(resolve => resolve()); await browser.close(); await vite.close(); }
});

test('Saving opens the exact returned profile even if catalog refresh or saved review fails, while apply still requires new dated preview', { timeout: 90_000 }, async context => {
  const { vite, browser, page, catalog, control, reviews, saves, previews, applies, errors } = await createDraftReviewFixture(context);
  const dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    await dialog.getByLabel('Profile name', { exact: true }).fill('Before server normalization');
    await dialog.getByRole('button', { name: 'Load regular schedule', exact: true }).click();
    control.staleCatalog = true; control.failCatalogRefresh = true; control.failSavedReview = true;
    control.saveTransform = definition => ({ ...definition, name: 'Server-confirmed testing', classRules: [{ classId: 'math', action: 'time', startTime: '10:20', endTime: '11:20' }] });
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Schedule for Server-confirmed testing', exact: true }).waitFor();
    await dialog.getByText('Profile saved — not applied', { exact: true }).waitFor();
    const review = dialog.getByRole('region', { name: 'Draft schedule review', exact: true });
    const check = dialog.getByRole('region', { name: 'Draft schedule check', exact: true });
    await check.getByText('Saved schedule review is temporarily unavailable.', { exact: true }).waitFor();
    assert.ok(control.catalogReadFailures > 0, 'The saved profile remains reviewable after an actual catalog refresh failure');
    assert.equal(saves.length, 1); assert.equal(catalog.profiles.length, 0, 'The saved view must not depend on finding the new profile in a stale catalog');
    assert.deepEqual(reviews.at(-1).definition, control.savedProfile.definition, 'Automatic review must use the exact returned definition');
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).count(), 0, 'A failed advisory check must never imply the save failed');
    control.failSavedReview = false;
    await check.getByRole('button', { name: 'Retry draft review', exact: true }).click();
    await review.getByText('10:20–11:20', { exact: true }).first().waitFor();
    assert.equal(saves.length, 1);
    await dialog.getByRole('button', { name: /Choose dates & apply/ }).click();
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0, 'A reference-day review never authorizes an application');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.equal(previews[0].profileId, control.savedProfile.id); assert.equal(previews[0].profileRevision, control.savedProfile.revision); assert.equal(previews[0].revision, catalog.revision);
    await dialog.getByRole('button', { name: 'Review draft schedule', exact: true }).click();
    await dialog.getByLabel('Reference date', { exact: true }).fill('2026-09-11');
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('4');
    assert.equal(await dialog.getByRole('region', { name: 'Profile application preview', exact: true }).count(), 0, 'Actual-date approval must not be visually conflated with the advisory day');
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Back to editing', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.equal(previews.length, 1, 'Reference-date and view filters do not change an already reviewed application');
    await dialog.getByLabel('Add an individual date', { exact: true }).fill('2026-09-09'); await dialog.getByRole('button', { name: 'Add selected date', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    await dialog.getByLabel('Zinkan Math profile start', { exact: true }).fill('10:25');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.equal(previews.at(-1).definition.classRules[0].startTime, '10:25');
    assert.deepEqual(previews.at(-1).dates, ['2026-09-08', '2026-09-09']);
    const beforeGroup = structuredClone(previews.at(-1)), reviewsBeforeGroup = reviews.length;
    control.failCatalogRefresh = false;
    await dialog.getByRole('tab', { name: 'Testing blocks', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add testing groups', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add testing groups', exact: true });
    await picker.getByRole('button', { name: 'Create group', exact: true }).click();
    const groupEditor = page.getByRole('dialog', { name: 'Create Supervision Group', exact: true });
    await groupEditor.getByLabel('Name', { exact: true }).fill('Reusable group during customization');
    await groupEditor.getByRole('group', { name: 'Group staff', exact: true }).getByRole('checkbox', { name: /Ms. Zinkan/ }).check();
    await groupEditor.getByRole('button', { name: 'Select all 1 matching students', exact: true }).click();
    await groupEditor.getByRole('button', { name: 'Save', exact: true }).click();
    await picker.getByText('Group saved.', { exact: false }).waitFor();
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0, 'Independent group creation invalidates dated approval');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.deepEqual(previews.at(-1), beforeGroup, 'Group metadata refresh preserves the profile definition, dates and captured revisions');
    assert.ok(reviews.length > reviewsBeforeGroup, 'Group changes rerun advisory review without a scheduling revision change');
    assert.equal(applies.length, 0); assert.equal(saves.length, 1); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});
