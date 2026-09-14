import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function createProfileFixture(context) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {QueryClientProvider} from '@tanstack/react-query';import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';import {queryClient as client} from '/src/lib/queryClient.js';import Scheduling from '/src/products/classpilot/pages/AdminScheduling.jsx';import '/src/index.css';function ScopeBridge(){const auth=useAuth();window.switchFixtureSchool=auth.switchSchool;return null;}createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(AuthProvider,null,React.createElement(MemoryRouter,null,React.createElement('main',{className:'mx-auto max-w-6xl p-6'},React.createElement(ScopeBridge),React.createElement(Scheduling))))));`;
  const vite = await createServer({ root, cacheDir: path.join(root, 'node_modules', `.vite-schedule-profiles-${process.pid}`), logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'schedule-profile-browser-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== '/__schedule-profiles') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__profiles-entry.jsx"></script></body></html>')); }); }, resolveId(id) { if (id === '/__profiles-entry.jsx') return '\0schedule-profiles-entry'; }, load(id) { if (id === '\0schedule-profiles-entry') return entry; } }] });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  await page.clock.setFixedTime(new Date('2026-09-08T12:00:00Z'));
  // A failed Vite module load should be visible in CI instead of only surfacing
  // later as a missing first-render button. API errors are exercised separately.
  page.on('requestfailed', request => {
    if (request.resourceType() === 'script') context.diagnostic('Browser module request failed: ' + new URL(request.url()).pathname + ' ' + (request.failure()?.errorText || 'unknown'));
  });
  page.on('response', response => {
    if (response.status() >= 500 && response.request().resourceType() === 'script') context.diagnostic('Browser module response: ' + response.status() + ' ' + new URL(response.url()).pathname);
  });
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
  await dialog.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

const scheduleRow = (workspace, name) => workspace.getByRole('article', { name: `${name} schedule row`, exact: true });

async function editClass(workspace, name) {
  const control = workspace.getByLabel(`${name} schedule action`, { exact: true });
  if (!await control.isVisible()) await scheduleRow(workspace, name).getByRole('button', { name: `Edit affected class ${name}`, exact: true }).click();
}

async function includeClass(workspace, name, checked = true) {
  await editClass(workspace, name);
  await workspace.getByLabel(`Include ${name}`, { exact: true }).setChecked(checked);
}


async function classSelection(workspace) {
  const summary = workspace.locator('summary').filter({ hasText: /^Classes included/ });
  const details = summary.locator('..');
  if (!await details.evaluate(element => element.open)) await summary.click();
  return details;
}

async function editTesting(workspace, name) {
  await scheduleRow(workspace, name).getByRole('button', { name: `Edit testing block ${name}`, exact: true }).click();
}

const applicationRow = (page, id) => page.locator(`[data-application-id="${id}"]`);
const profileRow = (page, id) => page.locator(`[data-profile-id="${id}"]`);

async function showApplicationDetails(page, application) {
  const row = applicationRow(page, application.id);
  const expand = row.getByRole('button', { name: `View details ${application.profileName} ${application.dates.join(', ')}`, exact: true });
  if (await expand.isVisible()) await expand.click();
  return row;
}

async function showEarlierApplications(page) {
  const summary = page.locator('summary').filter({ hasText: /^Earlier and cancelled applications/ });
  if (!await summary.locator('..').evaluate(element => element.open)) await summary.click();
}

async function confirmCancellation(page, name) {
  await page.getByRole('button', { name: `Cancel application ${name}`, exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel application?', exact: true });
  await dialog.getByRole('button', { name: 'Cancel all applied dates', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

// Supply the additive, authoritative overview projection in fixtures. Specific
// overview scenarios override these records rather than asking the UI to infer
// lifecycle or cancellation permission from mutable profile definitions.
function overviewCatalog(catalog) {
  const applicationSummaries = Object.fromEntries((catalog.applications || []).map(application => {
    const dates = application.dates.map(date => {
      const testing = (application.testingWindows || []).filter(window => window.date === date);
      const rules = application.definition?.classRules || [];
      const testingOutcomes = { pending: 0, active: 0, ended: 0, failed: 0, missed: 0, cancelled: 0, releasing: 0, unknown: 0 };
      const testingStatusByBlock = {};
      for (const window of testing) {
        const outcome = (catalog.testingStatuses || []).find(status => status.applicationId === application.id && status.date === date && status.blockId === window.blockId)?.status;
        const key = application.status === 'cancelled' ? 'cancelled' : outcome || (date > catalog.schoolLocalToday ? 'pending' : 'unknown');
        testingOutcomes[Object.hasOwn(testingOutcomes, key) ? key : 'unknown']++;
        testingStatusByBlock[window.blockId] = Object.hasOwn(testingOutcomes, key) ? key : 'unknown';
      }
      return { date, phase: application.status === 'cancelled' ? 'cancelled' : date > catalog.schoolLocalToday ? 'future' : date === catalog.schoolLocalToday ? 'today' : 'past', customTimeCount: rules.filter(rule => rule.action === 'time').length, skippedClassCount: rules.filter(rule => rule.action === 'skip').length, testingBlockCount: testing.length, testingOutcomes, testingStatusByBlock };
    });
    const canRequest = application.status !== 'cancelled' && dates.some(date => ['today', 'future'].includes(date.phase));
    return [application.id, { dates, nextFutureDate: dates.filter(date => date.phase === 'future').map(date => date.date).sort()[0] || null, appliedToday: dates.some(date => date.phase === 'today'), cancellation: { canRequest, cutoffAt: canRequest ? `${application.dates.slice().sort()[0]}T13:00:00Z` : null, reason: canRequest ? null : application.status === 'cancelled' ? 'cancelled' : 'started' } }];
  }));
  return { ...catalog, applications: catalog.applications.map(application => ({ classWindows: {}, ...application })), applicationSummaries: { ...applicationSummaries, ...catalog.applicationSummaries }, summariesCheckedAt: catalog.summariesCheckedAt || '2026-09-08T12:00:00Z', nextSchoolDateAt: catalog.nextSchoolDateAt || '2026-09-09T04:00:00Z' };
}

function appliedSnapshot(profile, id, dates, options = {}) {
  const definition = structuredClone(profile.definition);
  return { id, profileId: profile.id, profileName: definition.name, status: 'scheduled', dates, definition,
    classWindows: Object.fromEntries(dates.map(date => [date, Object.fromEntries(definition.classRules.map(rule => [rule.classId, rule.action === 'skip' ? null : { startTime: rule.startTime, endTime: rule.endTime }]))])),
    testingWindows: dates.flatMap(date => definition.testingBlocks.map(block => ({ date, blockId: block.id, name: block.name, startTime: block.startTime, endTime: block.endTime, assignedStaffId: block.assignedStaffId, coverageGroupId: block.coverageGroupId }))), ...options };
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
  const reviews = [], saves = [], previews = [], applies = [], deletions = [], cancellations = [], errors = [];
  const control = { reviewResponse: null, saveResponse: null, saveTransform: definition => definition, previewDateTransform: value => value, staleCatalog: false, failCatalogRefresh: false, failOverviewRead: false, catalogResponse: null, catalogReads: [], catalogReadFailures: 0, failSavedReview: false, groupCreates: [], failGroupCreate: false, failDirectory: false, deleteResponse: null, cancelResponse: null, failDeleteRefresh: false, failApplicationRefresh: false, failCancellationRefresh: false, activeSchool: 'school' };
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
  const handleApi = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/auth/me')) { control.activeSchool = request.headers()['x-school-id'] || 'school'; return route.fulfill({ json: { user: { id: request.headers()['x-fixture-admin'] || 'admin', role: 'school_admin' }, activeSchoolId: control.activeSchool, memberships: ['school', 'other-school'].map(id => ({ id: `membership-${id}`, schoolId: id, role: 'school_admin' })), licenses: { classPilot: true } } }); }
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
    if (url.pathname.endsWith('/schedule-profiles/apply')) {
      const body = request.postDataJSON(); applies.push(body);
      const profile = catalog.profiles.find(row => row.id === body.profileId) || control.savedProfile;
      const application = appliedSnapshot({ ...profile, definition: body.definition || profile.definition }, 'applied', body.dates);
      catalog.applications.push(application);
      return route.fulfill({ json: { revision: ++catalog.revision, application } });
    }
    if (url.pathname.includes('/schedule-profiles/applications/') && url.pathname.endsWith('/cancel')) {
      const id = url.pathname.split('/').at(-2), body = request.postDataJSON();
      cancellations.push(body);
      const response = await control.cancelResponse?.(id, body);
      if (response) return route.fulfill(response);
      catalog.applications.find(application => application.id === id).status = 'cancelled';
      if (catalog.applicationSummaries?.[id]) delete catalog.applicationSummaries[id];
      return route.fulfill({ json: { revision: ++catalog.revision } });
    }
    if (request.method() === 'DELETE' && /\/schedule-profiles\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)), body = request.postDataJSON();
      deletions.push({ id, ...body, schoolId: request.headers()['x-school-id'] });
      const custom = await control.deleteResponse?.(id, body);
      if (custom) return route.fulfill(custom);
      const profile = catalog.profiles.find(row => row.id === id);
      if (!profile) return route.fulfill({ status: 404, json: { error: 'Schedule profile not found.' } });
      if (body.revision !== catalog.revision || body.profileRevision !== profile.revision) return route.fulfill({ status: 409, json: { error: 'The schedule changed. Refresh before deleting this profile.' } });
      catalog.profiles = catalog.profiles.filter(row => row.id !== id);
      return route.fulfill({ json: { deleted: true, profileId: id, revision: ++catalog.revision } });
    }
    if (url.pathname.endsWith('/schedule-profiles')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); saves.push(body);
        const existing = catalog.profiles.find(profile => profile.id === body.id);
        const response = await control.saveResponse?.(body, existing);
        if (response) return route.fulfill(response);
        const previewDate = control.previewDateTransform(body.previewDate ?? existing?.previewDate);
        const profile = { id: body.id || `saved-review-profile${saves.length === 1 ? '' : `-${saves.length}`}`, revision: saves.length + 6, definition: control.saveTransform(structuredClone(body.definition)), ...(previewDate ? { previewDate } : {}), updatedAt: '2026-09-08T13:00:00Z' };
        catalog.revision += 3;
        if (!control.staleCatalog) catalog.profiles = [...catalog.profiles.filter(row => row.id !== profile.id), profile];
        control.savedProfile = profile;
        return route.fulfill({ json: { revision: catalog.revision, profile } });
      }
      const schoolId = request.headers()['x-school-id'] || 'school';
      control.catalogReads.push({ schoolId });
      const response = await control.catalogResponse?.(schoolId);
      if (response) return route.fulfill(response);
      if (control.failOverviewRead || (control.failCatalogRefresh && saves.length) || control.failGroupCatalogRefresh || (control.failDeleteRefresh && deletions.length) || (control.failApplicationRefresh && applies.length) || (control.failCancellationRefresh && cancellations.length)) { control.catalogReadFailures++; return route.fulfill({ status: 503, json: { error: 'The profile list is temporarily unavailable.' } }); }
      return route.fulfill({ json: overviewCatalog(schoolId === 'school' ? catalog : { ...catalog, profiles: [], applications: [], testingStatuses: [], applicationSummaries: {}, classes: [], staff: [], supervisionGroups: [] }) });
    }
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture request ${url.pathname}` } });
  };
  await page.route('**/api/**', handleApi);
  await page.goto(fixture.url); await page.waitForLoadState('networkidle');
  return { ...fixture, catalog, reviews, saves, previews, applies, deletions, cancellations, errors, control, handleApi };
}

async function addTestingBlock(dialog, index, teacher) {    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
  await dialog.getByLabel(`Testing block ${index} name`, { exact: true }).fill(`${teacher[0].toUpperCase()}${teacher.slice(1)} MAP`);
  await dialog.getByLabel(`Testing block ${index} Supervision group`, { exact: true }).selectOption(`${teacher}-group`);
  await dialog.getByLabel(`Testing block ${index} assigned staff`, { exact: true }).selectOption(teacher);
}

test('Saved preview dates survive reopen and separate administrators while date-only actions preserve the saved schedule', { timeout: 120_000 }, async context => {
  const { root, browser, vite, page, catalog, control, saves, reviews, previews, applies, errors, handleApi, url } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const date = workspace.getByLabel('Preview schedule for', { exact: true });
  const saveDate = workspace.getByRole('button', { name: 'Save preview date', exact: true });
  const discardDate = workspace.getByRole('button', { name: 'Discard date change', exact: true });
  const focusIsDate = () => date.evaluate(element => element === document.activeElement);
  let secondContext;
  try {
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-08', 'New profiles default to the school-local today');
    await workspace.getByLabel('Profile name', { exact: true }).fill('September MAP');
    await date.fill('2026-09-14');
    await workspace.getByRole('button', { name: 'Load regular schedule', exact: true, disabled: false }).click();
    await editClass(workspace, 'Burba Reading');
    await workspace.getByLabel('Burba Reading schedule action').selectOption('skip');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    const firstSaved = structuredClone(catalog.profiles[0]);
    assert.equal(saves[0].previewDate, '2026-09-14');
    assert.equal(firstSaved.previewDate, '2026-09-14');
    assert.equal(await date.inputValue(), '2026-09-14');
    assert.equal(await saveDate.count(), 0, 'A successful save clears the date draft');
    await closeSavedReview(workspace);
    await page.getByRole('button', { name: 'Open profile September MAP', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-14');
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile September MAP', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-14', 'Reload uses persisted profile metadata');

    secondContext = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-admin': 'second-admin' } });
    const otherPage = await secondContext.newPage();
    await otherPage.route('**/api/**', handleApi);
    await otherPage.goto(url); await otherPage.waitForLoadState('networkidle');
    await otherPage.getByRole('button', { name: 'Open profile September MAP', exact: true }).click();
    assert.equal(await otherPage.getByLabel('Preview schedule for', { exact: true }).inputValue(), '2026-09-14', 'Another administrator in a new browser context reads the shared saved date');
    await secondContext.close(); secondContext = null;

    const applied = { id: 'already-applied', profileId: firstSaved.id, profileName: firstSaved.definition.name, dates: ['2026-09-21'], status: 'scheduled', definition: structuredClone(firstSaved.definition), testingWindows: [] };
    catalog.applications.push(structuredClone(applied));
    const review = workspace.getByRole('region', { name: 'Draft schedule review', exact: true });
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('3');
    await date.fill('2026-09-15');
    await saveDate.waitFor(); await discardDate.waitFor();
    await workspace.getByText('Save or discard the changed preview date before choosing application dates.', { exact: true }).waitFor();
    assert.equal(await workspace.getByRole('button', { name: 'Choose dates & apply', exact: true }).isDisabled(), true);
    page.once('dialog', prompt => prompt.dismiss());
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-15', 'Rejecting discard retains the unsaved date');
    const evidence = path.resolve(root, '../soc2-evidence/schedule-preview-date/browser'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark']) for (const [device, viewport] of Object.entries({ desktop: { width: 1365, height: 950 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport); await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await date.focus();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Date controls fit ${device}/${theme}`);
      assert.equal(await date.evaluate(element => element === document.activeElement && getComputedStyle(element).boxShadow !== 'none'), true, 'The preview-date control has visible keyboard focus');
      await page.screenshot({ path: path.join(evidence, `saved-date-${device}-${theme}.png`), animations: 'disabled' });
    }
    await discardDate.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.type === 'date');
    assert.equal(await focusIsDate(), true);
    assert.equal(await date.inputValue(), '2026-09-14');
    assert.equal(saves.length, 1, 'Discard makes no save request');
    assert.equal(await review.getByRole('combobox', { name: 'Review grade', exact: true }).inputValue(), '3');
    assert.equal(await workspace.getByRole('button', { name: 'Timeline', exact: true }).getAttribute('aria-pressed'), 'true');
    await date.fill('');
    assert.equal(await saveDate.isDisabled(), true, 'Empty preview dates cannot be saved');
    await discardDate.click();
    await date.fill('2026-09-16');
    control.saveResponse = () => ({ status: 503, json: { error: 'The profile save is temporarily unavailable.' } });
    await saveDate.click();
    await workspace.getByRole('alert').filter({ hasText: 'The profile save is temporarily unavailable.' }).waitFor();
    assert.equal(await date.inputValue(), '2026-09-16');
    assert.equal(catalog.profiles[0].previewDate, '2026-09-14');
    await workspace.getByRole('button', { name: 'Refresh regular schedule', exact: true }).click();
    await page.waitForLoadState('networkidle');
    assert.equal(await date.inputValue(), '2026-09-16', 'Advisory refresh must not replace a failed-save draft');
    control.saveResponse = null;
    const savedDayReview = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().referenceDate === '2026-09-16');
    await saveDate.focus(); await page.keyboard.press('Enter');
    await saveDate.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.type === 'date');
    assert.equal(await focusIsDate(), true);
    assert.equal(await date.inputValue(), '2026-09-16');
    assert.equal(await review.getByRole('combobox', { name: 'Review grade', exact: true }).inputValue(), '3');
    assert.equal(await workspace.getByRole('button', { name: 'Timeline', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(saves.at(-1).definition, firstSaved.definition, 'Date-only saving sends the unchanged saved rules');
    assert.equal(saves.at(-1).profileRevision, firstSaved.revision);
    assert.equal(catalog.profiles[0].previewDate, '2026-09-16');
    await savedDayReview;
    assert.deepEqual(catalog.applications, [applied], 'Saving a preview date leaves existing dates and snapshots intact');
    assert.equal(previews.length, 0); assert.equal(applies.length, 0);
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    await workspace.waitFor({ state: 'hidden' });
    assert.ok(reviews.some(body => body.referenceDate === '2026-09-16'));
    assert.deepEqual(errors, []);
  } finally { await secondContext?.close(); await browser.close(); await vite.close(); }
});

test('Preview-date drafts retain revisions and selections, and duplication and Save as new keep application dates separate', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, control, saves, previews, applies, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const date = workspace.getByLabel('Preview schedule for', { exact: true });
  const legacy = { id: 'legacy-profile', revision: 4, definition: { name: 'Legacy MAP', grades: [], classIds: ['math'], classRules: [], testingBlocks: [] } };
  try {
    catalog.profiles.push(structuredClone(legacy)); catalog.revision = 10;
    catalog.schoolTimezone = 'Pacific/Honolulu'; catalog.schoolLocalToday = '2026-09-07';
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Legacy MAP', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-07', 'A legacy profile uses today from its school timezone, not the browser clock');
    assert.equal(await workspace.getByRole('button', { name: 'Save preview date', exact: true }).count(), 0, 'Legacy defaults do not pretend an edit occurred');
    await workspace.getByRole('button', { name: 'Edit profile', exact: true }).click();
    await date.fill('2026-09-14');
    await workspace.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('3');
    await workspace.getByLabel('Find a class or teacher', { exact: true }).fill('Zinkan');    assert.equal(await date.inputValue(), '2026-09-14');
    assert.equal(await workspace.getByLabel('Find a class or teacher', { exact: true }).inputValue(), 'Zinkan');
    assert.equal(await workspace.getByRole('combobox', { name: 'Review grade', exact: true }).inputValue(), '3');
    await workspace.getByRole('button', { name: 'List', exact: true }).click();
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    await editClass(workspace, 'Zinkan Math');
    assert.equal(await workspace.getByLabel('Include Zinkan Math', { exact: true }).isChecked(), true);
    assert.equal(await scheduleRow(workspace, 'Burba Reading').count(), 0, 'View switching preserves the display filter independently of selection');
    control.saveResponse = body => body.revision !== catalog.revision || body.profileRevision !== catalog.profiles[0].revision
      ? { status: 409, json: { error: 'Another administrator changed this profile. Reopen it before saving again.' } } : null;
    catalog.profiles[0].previewDate = '2026-09-15'; catalog.profiles[0].revision++; catalog.revision++;
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByRole('alert').filter({ hasText: 'Another administrator changed this profile.' }).waitFor();
    assert.equal(await date.inputValue(), '2026-09-14', 'A concurrent edit and catalog refresh must retain the local date draft');
    assert.equal(await workspace.getByLabel('Find a class or teacher', { exact: true }).inputValue(), 'Zinkan');
    assert.equal(saves[0].profileRevision, legacy.revision); assert.equal(saves[0].revision, 10);
    assert.equal(catalog.profiles[0].previewDate, '2026-09-15', 'A stale date save cannot overwrite the other administrator');
    page.once('dialog', prompt => prompt.accept());
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    await workspace.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Open profile Legacy MAP', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-15', 'Reopening after discard reads the current shared date');
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    control.saveResponse = null;
    await page.getByRole('button', { name: 'More actions for Legacy MAP', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Duplicate Legacy MAP', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-15');
    await workspace.getByLabel('Profile name', { exact: true }).fill('MAP copy');
    await date.fill('2026-09-14');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await closeSavedReview(workspace);
    assert.equal(saves.at(-1).id, undefined); assert.equal(saves.at(-1).previewDate, '2026-09-14');
    assert.equal(catalog.profiles.find(profile => profile.id === legacy.id).previewDate, '2026-09-15');
    await page.getByRole('button', { name: 'Choose dates & apply Legacy MAP', exact: true }).click();
    await workspace.getByRole('button', { name: 'Remove application date 2026-09-07', exact: true }).click();
    await workspace.getByLabel('Add an individual date', { exact: true }).fill('2026-09-21');
    await workspace.getByRole('button', { name: 'Add selected date', exact: true }).click();
    await workspace.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    assert.equal(await date.inputValue(), '2026-09-21', 'Customization begins with the first actual application date');
    await date.fill('2026-09-22');
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.deepEqual(previews[0].dates, ['2026-09-21']);
    assert.equal(Object.hasOwn(previews[0], 'previewDate'), false);
    assert.equal(catalog.profiles.find(profile => profile.id === legacy.id).previewDate, '2026-09-15');
    await workspace.getByLabel('Name for new profile', { exact: true }).fill('MAP customized');
    await workspace.getByRole('button', { name: 'Save as new profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves.at(-1).id, undefined); assert.equal(saves.at(-1).previewDate, '2026-09-22');
    assert.equal(await date.inputValue(), '2026-09-22');
    assert.equal(catalog.profiles.find(profile => profile.id === legacy.id).previewDate, '2026-09-15');
    assert.equal(applies.length, 0, 'Saving a date or customized profile never activates the application');
    await closeSavedReview(workspace);
    const latestProfile = catalog.profiles.find(profile => profile.definition.name === 'MAP customized');
    latestProfile.previewDate = '2026-09-23'; latestProfile.revision++; catalog.revision++;
    await page.getByRole('button', { name: 'Open profile MAP customized', exact: true }).click();
    assert.equal(await date.inputValue(), '2026-09-23', 'Opening a cached card refreshes a preview date saved by another administrator');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Testing groups retain explicit page selections, enforce the total limit, and add one editable block per group', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, saves } = await createDraftReviewFixture(context);
  try {
    for (let index = 0; index < 28; index++) catalog.supervisionGroups.push({ id: `team-${index}`, name: `Team ${String(index).padStart(2, '0')}`, staffIds: ['zinkan'], studentIds: [`fixture-${index}`] });
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await workspace.getByLabel('Profile name', { exact: true }).fill('Whole-school MAP');
    await workspace.getByRole('button', { name: 'Load regular schedule', exact: true }).click();    assert.equal(await workspace.locator('[data-class-editor-id]').count(), 0, 'Closed row editors have no reachable controls');
    await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).first().click();
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
    assert.equal(await workspace.locator('[data-schedule-row^="testing:"]').count(), 30);
    assert.equal(await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).first().isDisabled(), true);
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
    const timeline = workspace.getByRole('button', { name: 'Timeline', exact: true });
    const list = workspace.getByRole('button', { name: 'List', exact: true });
    assert.equal(await timeline.getAttribute('aria-pressed'), 'true');
    await list.focus(); await page.keyboard.press('Enter');
    assert.equal(await list.getAttribute('aria-pressed'), 'true');
    await timeline.focus(); await page.keyboard.press('Enter');
    assert.equal(await timeline.getAttribute('aria-pressed'), 'true');
    assert.equal(await workspace.getByRole('tab', { name: /Classes|Testing blocks|Review day/ }).count(), 0, 'The planner replaces the old separate editing sections');
    const opener = workspace.getByRole('button', { name: 'Add testing groups', exact: true }).first();
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
    await editTesting(workspace, 'Mixed MAP group');
    assert.equal(await workspace.getByLabel('Testing block 1 assigned staff').inputValue(), 'burba', 'Fresh directory assignments remain visible in the editor');
    await opener.click(); await picker.getByRole('checkbox', { name: /Mixed MAP group/ }).check();
    await picker.getByLabel('Mixed MAP group — assigned staff').selectOption('zinkan');
    await picker.getByLabel('Common testing start').fill('11:00'); await picker.getByLabel('Common testing end').fill('12:00');
    await picker.getByRole('button', { name: 'Add 1 testing block', exact: true }).click();
    await workspace.locator('[data-schedule-row^="testing:"]').first().getByRole('button', { name: 'Edit testing block Mixed MAP group', exact: true }).click();
    assert.equal(await workspace.getByLabel('Testing block 1 start').inputValue(), '09:00');
    await workspace.locator('[data-schedule-row^="testing:"]').last().getByRole('button', { name: 'Edit testing block Mixed MAP group', exact: true }).click();
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
    await workspace.getByRole('button', { name: 'Load regular schedule', exact: true }).click();    await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).first().click();
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
    await editTesting(workspace, 'New inline MAP');
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
        const application = { id: `application-${applies.length}`, profileId: profile.id, profileName: profile.definition.name, dates: body.dates, status: 'scheduled', definition: structuredClone(body.definition || profile.definition), classWindows: Object.fromEntries(body.dates.map(date => [date, { math: { startTime: '08:10', endTime: '09:00' }, reading: null }])), testingWindows: [{ date: body.dates[0], blockId: 'testing', name: 'MAP testing', startTime: '09:00', endTime: '10:00' }] };
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
          if (existing) { existing.definition = body.definition; existing.previewDate = body.previewDate ?? existing.previewDate; existing.revision++; }
          else catalog.profiles.push({ id: `profile-${saves.length}`, revision: 1, definition: body.definition, previewDate: body.previewDate, updatedAt: '2026-09-08T12:00:00Z' });
          config.scheduleProfiles = structuredClone(catalog.profiles); catalog.revision++; return route.fulfill({ json: { revision: catalog.revision, profile: existing || catalog.profiles.at(-1) } });
        }
        return route.fulfill({ json: overviewCatalog(catalog) });
      }
      return route.fulfill({ status: 404, json: { error: `Unexpected fixture request ${url.pathname}` } });
    });
    await page.goto(fixtureUrl);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    let dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByLabel('Profile name', { exact: true }).fill('MAP morning');
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click();
    const included = await classSelection(dialog);
    for (const grade of ['3', '4', '5']) await included.getByRole('checkbox', { name: 'Include Grade ' + grade, exact: true }).check();
    await editClass(dialog, 'Grade 5 Grammar');
    assert.equal(await dialog.getByLabel('Include Grade 5 Grammar', { exact: true }).isChecked(), true);
    assert.equal(await dialog.getByRole('checkbox', { name: 'Include Grade 5', exact: true }).count(), 1);
    await classSelection(dialog);
    await classSelection(dialog);
    await dialog.getByRole('button', { name: 'Clear class selection', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Include Grade 3', exact: true }).check();
    await editClass(dialog, 'Grade 3 Math');
    assert.equal(await dialog.getByLabel('Include Grade 3 Math', { exact: true }).isChecked(), true);
    assert.equal(await dialog.getByLabel('Include Grade 3 Math', { exact: true }).isDisabled(), true);
    await includeClass(dialog, 'Grade 4 Science');
    await editClass(dialog, 'Grade 3 Math');
    await dialog.getByLabel('Grade 3 Math schedule action').selectOption('time');
    await editClass(dialog, 'Grade 3 Math');
    await dialog.getByLabel('Grade 3 Math profile start').fill('08:15');
    await dialog.getByLabel('Grade 3 Math profile end').fill('09:00');
    await editClass(dialog, 'Grade 3 Reading');
    await dialog.getByLabel('Grade 3 Reading schedule action').selectOption('skip');    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
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
    await editClass(dialog, 'Grade 3 Math');
    await dialog.getByLabel('Grade 3 Math profile start').fill('08:00');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click();
    await dialog.getByText(/Ms. Rivera already supervises/).waitFor(); assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).isDisabled(), true);
    assert.deepEqual(previews[0].dates, ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-15']);
    assert.equal(previews[0].definition.classRules.find(row => row.classId === 'math').startTime, '08:00');
    assert.equal(catalog.profiles[0].definition.classRules.find(row => row.classId === 'math').startTime, '08:15');
    await editClass(dialog, 'Grade 3 Math');
    await dialog.getByLabel('Grade 3 Math profile start').fill('08:10'); assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    blocker = false;
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    const artifactDir = path.join(root, 'artifacts', 'schedule-profiles'); await mkdir(artifactDir, { recursive: true });
    await dialog.getByRole('region', { name: 'Profile application preview', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifactDir, 'review-desktop.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(applies[0].previewToken, 'preview-2'); assert.deepEqual(applies[0].dates, previews[1].dates); assert.deepEqual(applies[0].definition, previews[1].definition);
    await page.getByRole('region', { name: 'Schedule profile applications' }).getByText('Applied today', { exact: true }).first().waitFor();
    await showApplicationDetails(page, catalog.applications[0]);
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
    page.once('dialog', prompt => prompt.dismiss()); await dialog.getByRole('button', { name: 'Back to scheduling', exact: true }).click(); assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await closeSavedReview(dialog);
    assert.equal(saves[2].id, 'profile-1'); assert.equal(saves[2].profileRevision, 1); assert.equal(catalog.applications[0].profileName, 'MAP morning');
    await confirmCancellation(page, 'MAP morning');
    await showEarlierApplications(page);
    await page.getByRole('region', { name: 'Schedule profile applications' }).getByText('Cancelled', { exact: true }).first().waitFor(); assert.equal(cancellations.length, 1);
    assert.equal(await page.getByText(recoveryHint, { exact: true }).count(), 0);
    catalog.applications.push({ id: 'previous-application', profileId: 'profile-1', profileName: 'Previous testing day', dates: ['2026-09-07'], status: 'scheduled', classWindows: { '2026-09-07': { math: { startTime: '08:10', endTime: '09:00' } } }, testingWindows: [] }); config.profileApplications = structuredClone(catalog.applications);
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await showEarlierApplications(page);
    await page.getByText('Past date', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel application Previous testing day', exact: true }).count(), 0);

    await page.getByRole('button', { name: 'Choose dates & apply MAP revised', exact: true }).click(); dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor(); staleApply = true;
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: 'Reopen this profile' }).waitFor();
    assert.equal(await dialog.isVisible(), true); assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0); await dialog.getByRole('button', { name: 'Back to scheduling', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
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
    page.once('dialog', prompt => prompt.accept()); await dialog.getByRole('button', { name: 'Back to scheduling', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
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
  const releaseOld = []; let failReference = true, largeCatalog = false;
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
        if (date === '2026-09-10') await new Promise(resolve => { releaseOld.push(resolve); });
        return route.fulfill({ json: projection(date) });
      }
      if (url.pathname.endsWith('/schedule-profiles/draft-review')) { const body = request.postDataJSON(); if (body.referenceDate === '2026-09-10') await new Promise(resolve => releaseOld.push(resolve)); return route.fulfill({ json: draftReviewFixture(catalog, body.definition, body.referenceDate, projection(body.referenceDate).classes) }); }
      if (url.pathname.endsWith('/schedule-profiles')) {
        if (request.method() === 'POST') {
          const body = request.postDataJSON(); saves.push(body);
          const existing = catalog.profiles.find(row => row.id === body.id);
          if (existing) { existing.definition = body.definition; existing.previewDate = body.previewDate ?? existing.previewDate; existing.revision++; }
          else catalog.profiles.push({ id: `regular-${saves.length}`, revision: 1, definition: body.definition, previewDate: body.previewDate });
          catalog.revision++;
          return route.fulfill({ json: { revision: catalog.revision, profile: existing || catalog.profiles.at(-1) } });
        }
        return route.fulfill({ json: overviewCatalog(catalog) });
      }
      return route.fulfill({ status: 404, json: { error: `Unexpected fixture request ${url.pathname}` } });
    });
    await page.goto(fixtureUrl);
    await page.waitForLoadState('networkidle');
    const dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    const row = name => scheduleRow(dialog, name);
    const reference = dialog.getByLabel('Preview schedule for', { exact: true });
    const openNew = async name => {
      await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
      await dialog.getByLabel('Profile name', { exact: true }).fill(name);
    };
    const changeDate = async date => {
      const loaded = page.waitForResponse(response => response.url().includes('/schedule-profiles/regular-schedule?') && new URL(response.url()).searchParams.get('referenceDate') === date);
      await reference.fill(date); await loaded; await page.waitForLoadState('networkidle');
    };
    const cancel = async () => { await dialog.getByRole('button', { name: 'Back to scheduling', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };

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
    await dialog.getByRole('region', { name: 'Day planner', exact: true }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Keyboard navigation must remain inside the dialog after Load unmounts');
    for (const name of ['Fixed Math', 'Period Science']) { await editClass(dialog, name); assert.equal(await dialog.getByLabel(`Include ${name}`, { exact: true }).isChecked(), true); }
    await editClass(dialog, 'B-day Reading'); assert.equal(await dialog.getByLabel('Include B-day Reading', { exact: true }).isChecked(), false);
    assert.match(await row('Fixed Math').innerText(), /09:10–09:55/);
    assert.match(await row('Period Science').innerText(), /10:15–11:00/);
    assert.match(await row('B-day Reading').innerText(), /Does not meet on this preview date/);
    assert.match(await row('Schedule Disabled').innerText(), /Schedule off/);
    await editClass(dialog, 'Period Science');
    const scienceSelection = dialog.getByLabel('Include Period Science', { exact: true });
    await scienceSelection.focus(); await page.keyboard.press('Space'); assert.equal(await scienceSelection.isChecked(), false);
    await page.keyboard.press('Space'); assert.equal(await scienceSelection.isChecked(), true);
    await editClass(dialog, 'Period Science');
    await dialog.getByLabel('Period Science schedule action').selectOption('time');
    assert.equal(await dialog.getByLabel('Period Science profile start').inputValue(), '10:15', 'Custom period times must seed from the resolved reference window');
    assert.equal(await dialog.getByLabel('Period Science profile end').inputValue(), '11:00');
    for (const [size, viewport] of [['desktop', { width: 1365, height: 950 }], ['mobile', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        await dialog.getByRole('button', { name: size === 'mobile' ? 'List' : 'Timeline', exact: true }).click();
        await row('Period Science').scrollIntoViewIfNeeded();
        await dialog.getByLabel('Period Science schedule action').focus(); await page.keyboard.press('Tab');
        const start = dialog.getByLabel('Period Science profile start');
        assert.equal(await start.evaluate(element => element === document.activeElement), true, 'Inline custom-time controls are reachable in either view');
        const inputBounds = await start.boundingBox(), workspaceBounds = await dialog.boundingBox();
        assert.ok(inputBounds.x >= workspaceBounds.x && inputBounds.x + inputBounds.width <= workspaceBounds.x + workspaceBounds.width, 'Inline controls fit the mobile workspace');
        if (await dialog.evaluate(e => e.scrollWidth > e.clientWidth)) context.diagnostic(JSON.stringify(await dialog.evaluate(e => [...e.querySelectorAll('*')].filter(n => n.getBoundingClientRect().right > e.getBoundingClientRect().right + 1).slice(0,8).map(n => ({ tag:n.tagName, cls:n.className, width:n.getBoundingClientRect().width, text:n.textContent.slice(0,60) })))));
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.screenshot({ path: path.join(artifactDir, `regular-day-${size}-${theme}.png`), animations: 'disabled' });
      }
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark')); await page.setViewportSize({ width: 1365, height: 950 });
    await editClass(dialog, 'Period Science');
    await dialog.getByLabel('Period Science schedule action').selectOption('keep');
    await editClass(dialog, 'Fixed Math');
    await dialog.getByLabel('Fixed Math schedule action').selectOption('skip');
    await editClass(dialog, 'Fixed Math');
    await dialog.getByLabel('Fixed Math schedule action').selectOption('keep');
    assert.equal(await dialog.getByLabel('Period Science profile start').count(), 0);
    await editClass(dialog, 'Fixed Math');
    await dialog.getByLabel('Fixed Math schedule action').selectOption('time');
    await classSelection(dialog);
    await dialog.getByRole('button', { name: 'Clear class selection', exact: true }).click();
    assert.equal(await dialog.locator('input[aria-label^="Include "]:checked').count(), 0, 'Clear selection removes the imported whole-day selection');
    assert.equal(await dialog.getByLabel('Fixed Math profile start').count(), 0, 'Clearing the selection also removes its overrides');
    await includeClass(dialog, 'Fixed Math'); await includeClass(dialog, 'Period Science');
    assert.equal(mutations.length, 0, 'Selection and rule changes remain local until Save profile');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await closeSavedReview(dialog);
    assert.deepEqual(saves[0].definition.classIds.slice().sort(), ['math', 'science']);
    assert.deepEqual(saves[0].definition.classRules, [], 'Keeping every class saves no frozen time or skip overrides');
    assert.equal(saves[0].previewDate, '2026-09-08');
    assert.equal(JSON.stringify(saves[0].definition).includes('previewDate'), false, 'Preview metadata does not become a scheduling rule');

    await page.getByRole('button', { name: 'More actions for Whole day', exact: true }).click(); await page.getByRole('menuitem', { name: 'Edit Whole day', exact: true }).click();
    await page.waitForLoadState('networkidle');
    await editClass(dialog, 'Fixed Math');
    await dialog.getByLabel('Fixed Math schedule action').selectOption('time');
    await editClass(dialog, 'Fixed Math');
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '09:10', 'The comparison must not seed from raw stored block columns');
    await editClass(dialog, 'Fixed Math');
    await dialog.getByLabel('Fixed Math profile start').fill('08:00'); await dialog.getByLabel('Fixed Math profile end').fill('08:30');
    await includeClass(dialog, 'Period Science', false); await includeClass(dialog, 'B-day Reading');
    await editClass(dialog, 'Fixed Math');
    await changeDate('2026-09-09');
    await row('Period Science').getByText('Proposed: Does not meet on this preview date', { exact: true }).waitFor();
    assert.match(await row('Period Science').innerText(), /Does not meet on this preview date/);
    await editClass(dialog, 'Fixed Math');
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '08:00');
    await editClass(dialog, 'Period Science'); assert.equal(await scienceSelection.isChecked(), false);
    await editClass(dialog, 'B-day Reading'); assert.equal(await dialog.getByLabel('Include B-day Reading', { exact: true }).isChecked(), true);
    const oldRequest = page.waitForRequest(request => request.url().includes('regular-schedule?referenceDate=2026-09-10'));
    await reference.fill('2026-09-10'); await oldRequest;
    await dialog.getByRole('status').filter({ hasText: 'Loading regular schedule' }).waitFor();
    await editClass(dialog, 'B-day Reading');
    await row('B-day Reading').getByText('Regular: Unavailable', { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('B-day Reading schedule action').locator('option[value="time"]').evaluate(option => option.disabled), true, 'A pending comparison must not seed an override from the old date: ' + JSON.stringify({ date: await reference.inputValue(), action: await dialog.getByLabel('B-day Reading schedule action').inputValue(), option: await dialog.getByLabel('B-day Reading schedule action').locator('option[value="time"]').evaluate(element => ({ disabled: element.disabled, attribute: element.getAttribute('disabled') })), row: await row('B-day Reading').innerText(), pending: releaseOld.length }));
    const latestResponse = page.waitForResponse(response => response.url().includes('regular-schedule?referenceDate=2026-09-11'));
    await reference.fill('2026-09-11'); await latestResponse;
    await row('Fixed Math').getByText('Regular: 11:15–12:00', { exact: true }).waitFor();
    releaseOld.splice(0).forEach(resolve => resolve()); await page.waitForLoadState('networkidle');
    assert.equal(await reference.inputValue(), '2026-09-11');
    assert.match(await row('Fixed Math').innerText(), /11:15–12:00/); assert.doesNotMatch(await row('Fixed Math').innerText(), /13:15–14:00/);
    await editClass(dialog, 'Fixed Math');
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '08:00');
    assert.equal(mutations.length, 1, 'Refreshing and racing reference dates must not write a profile');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await closeSavedReview(dialog);
    assert.deepEqual(saves[1].definition.classIds.slice().sort(), ['math', 'reading']);
    assert.deepEqual(saves[1].definition.classRules, [{ classId: 'math', action: 'time', startTime: '08:00', endTime: '08:30' }]);
    assert.equal(saves[1].previewDate, '2026-09-11');
    assert.equal(JSON.stringify(saves[1].definition).includes('previewDate'), false);
    await page.getByRole('button', { name: 'More actions for Whole day', exact: true }).click(); await page.getByRole('menuitem', { name: 'Duplicate Whole day', exact: true }).click();
    await dialog.getByRole('region', { name: 'Day planner', exact: true }).waitFor();
    assert.equal(await reference.inputValue(), '2026-09-11', 'Duplicating preserves the saved preview date');
    await editClass(dialog, 'Fixed Math');
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
    await includeClass(dialog, 'Unmapped Period');
    assert.match(await row('Unmapped Period').innerText(), /This class needs a mapped bell period/);
    assert.equal(await dialog.getByLabel('Unmapped Period schedule action').locator('option[value="time"]').evaluate(option => option.disabled), true);
    await reference.fill(''); await dialog.getByText('Choose a valid preview date to see regular class times.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).isDisabled(), true, 'An invalid date also prevents a full profile save');
    assert.equal(await dialog.getByRole('button', { name: 'Refresh regular schedule', exact: true }).isDisabled(), true); await cancel();

    largeCatalog = true;
    catalog.classes = Array.from({ length: 501 }, (_, index) => ({ id: `class-${index}`, name: `Class ${index + 1}`, gradeLevel: '3', scheduleEnabled: true }));
    await page.reload(); await page.waitForLoadState('networkidle'); await openNew('Large day');
    await dialog.getByRole('alert').filter({ hasText: 'more than 500 classes' }).waitFor(); assert.equal(await load.isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Start blank', exact: true }).isEnabled(), true);
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click(); await includeClass(dialog, 'Class 1');
    assert.equal(await dialog.locator('input[aria-label^="Include "]:checked').count(), 1, 'Start blank must allow a smaller selection without silently truncating the day');
    await cancel();
    assert.equal(mutations.length, 2); assert.equal(mutations.every(mutation => mutation.path.endsWith('/schedule-profiles')), true);
    assert.equal(reads.includes('2026-09-10') && reads.includes('2026-09-11') && largeCatalog, true);
    assert.deepEqual(errors, []);
  } finally { releaseOld.splice(0).forEach(resolve => resolve()); await browser?.close(); await vite.close(); }
});

test('Day planner shows the whole day, resolves cross-grade issues inline, and preserves partial-class participation', { timeout: 120_000 }, async context => {
  const { root, vite, browser, page, catalog, reviews, saves, previews, applies, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const check = workspace.getByRole('region', { name: 'Draft schedule check', exact: true });
  const review = workspace.getByRole('region', { name: 'Draft schedule review', exact: true });
  try {
    // Zinkan also co-teaches an unselected class in another grade.
    catalog.classes[3].staff.push({ id: 'zinkan', name: 'Ms. Zinkan' });
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    await workspace.getByLabel('Profile name', { exact: true }).fill('Testing review');
    await workspace.getByRole('button', { name: 'Start blank', exact: true }).click();
    for (const name of ['Zinkan Math', 'Burba Reading', 'Vatter Science']) await includeClass(workspace, name);
    for (const [index, teacher] of ['zinkan', 'burba', 'vatter'].entries()) await addTestingBlock(workspace, index + 1, teacher);
    await check.getByText('4 conflicts need attention', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await workspace.getByRole('button', { name: 'Save profile', exact: true }).isEnabled(), true, 'Conflict feedback remains advisory');
    for (const name of ['Zinkan Math', 'Burba Reading', 'Vatter Science', 'Art Studio']) await scheduleRow(review, name).waitFor();
    assert.equal(saves.length, 0); assert.equal(previews.length, 0); assert.equal(applies.length, 0);

    await review.getByRole('combobox', { name: 'Schedule view', exact: true }).selectOption('classes');
    await review.getByRole('combobox', { name: 'Review class', exact: true }).selectOption('art');
    await scheduleRow(review, 'Art Studio').waitFor(); await scheduleRow(review, 'Zinkan MAP').waitFor();
    assert.equal(await scheduleRow(review, 'Burba MAP').count(), 0);
    assert.equal(await scheduleRow(review, 'Vatter MAP').count(), 0);
    assert.match(await scheduleRow(review, 'Zinkan MAP').innerText(), /2.*24|2 of 24/, 'Partial group participation accompanies the selected class');
    await review.getByRole('combobox', { name: 'Schedule view', exact: true }).selectOption('teachers');
    await review.getByRole('combobox', { name: 'Review teacher', exact: true }).selectOption('zinkan');
    await scheduleRow(review, 'Art Studio').waitFor();
    await scheduleRow(review, 'Zinkan Math').waitFor();
    assert.equal(await scheduleRow(review, 'Burba Reading').count(), 0);
    await editClass(workspace, 'Art Studio');
    assert.equal(await workspace.getByLabel('Include Art Studio', { exact: true }).isChecked(), false);
    assert.equal(await workspace.getByLabel('Art Studio schedule action', { exact: true }).isDisabled(), true, 'A visible outside-selection obligation needs explicit inclusion before editing');
    await includeClass(workspace, 'Art Studio');
    await workspace.getByLabel('Art Studio schedule action', { exact: true }).selectOption('skip');
    await check.getByText('3 conflicts need attention', { exact: true }).waitFor();

    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('4');
    await review.getByLabel('Find a class or teacher', { exact: true }).fill('Art');
    await review.getByLabel('Show conflicts only', { exact: true }).check();
    await workspace.getByRole('button', { name: 'List', exact: true }).click();
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    assert.equal(await review.getByLabel('Find a class or teacher', { exact: true }).inputValue(), 'Art');
    await review.getByRole('button', { name: 'Resolve issue for class Zinkan Math', exact: true }).first().click();
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).waitFor();
    assert.equal(await workspace.locator('[data-class-editor-id="math"]').evaluate(element => element.contains(document.activeElement)), true, 'Issue navigation clears obstructing display filters and focuses its editor');
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).selectOption('time');
    await workspace.getByLabel('Zinkan Math profile end', { exact: true }).fill('11:30');
    await workspace.getByLabel('Zinkan Math profile start', { exact: true }).fill('10:45');
    await check.getByText('2 conflicts need attention', { exact: true }).waitFor();
    await review.getByRole('button', { name: 'Resolve issue for class Burba Reading', exact: true }).first().click();
    await workspace.getByLabel('Burba Reading schedule action', { exact: true }).selectOption('skip');
    await check.getByText(/1 conflict.*need/).waitFor();
    assert.match(await scheduleRow(workspace, 'Burba Reading').innerText(), /Does not meet/);
    assert.equal(await workspace.locator('[data-class-editor-id]').count(), 1, 'Only one row has active form controls');

    const evidence = path.resolve(root, '../soc2-evidence/day-planner/browser'); await mkdir(evidence, { recursive: true });
    for (const [device, viewport] of Object.entries({ desktop: { width: 1365, height: 950 }, mobile: { width: 390, height: 844 } })) for (const theme of ['light', 'dark']) {
      await page.setViewportSize(viewport); await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await workspace.getByRole('button', { name: device === 'mobile' ? 'List' : 'Timeline', exact: true }).click();
      await scheduleRow(workspace, 'Burba Reading').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.match(await scheduleRow(workspace, 'Burba Reading').innerText(), /Does not meet/);
      await editClass(workspace, 'Zinkan Math');
      await workspace.getByLabel('Zinkan Math profile end', { exact: true }).focus();
      const focusBounds = await page.evaluate(() => { const target = document.activeElement?.getBoundingClientRect(); const header = document.querySelector('[data-testid="schedule-profile-workspace"] > header')?.getBoundingClientRect(); return { target: target && { top: target.top, bottom: target.bottom }, header: header && { bottom: header.bottom }, height: innerHeight }; });
      assert.ok(focusBounds.target && focusBounds.header && focusBounds.target.top >= focusBounds.header.bottom && focusBounds.target.bottom <= focusBounds.height, 'Inline keyboard focus is visible beneath the sticky toolbar: ' + JSON.stringify(focusBounds));
      await page.screenshot({ path: path.join(evidence, device + '-' + theme + '-focused.png'), animations: 'disabled' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(evidence, device + '-' + theme + '.png'), fullPage: true, animations: 'disabled' });
    }
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves.length, 1); assert.equal(previews.length, 0); assert.equal(applies.length, 0);
    assert.equal(saves[0].definition.classRules.some(rule => rule.classId === 'science'), false, 'Saving a conflict cannot invent a class change');
    assert.equal(saves[0].definition.classIds.includes('art'), true);
    await check.getByText(/1 conflict.*need/).waitFor();
    await closeSavedReview(workspace);
    await page.getByRole('button', { name: 'Open profile Testing review', exact: true }).click();
    assert.equal(await workspace.getByRole('button', { name: 'Save profile', exact: true }).count(), 0);
    await editClass(workspace, 'Vatter Science');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).waitFor();
    assert.ok(reviews.length > 3); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Draft review discards stale date and definition responses and keeps incomplete or failed checks honest', { timeout: 90_000 }, async context => {
  const { vite, browser, page, catalog, control, reviews, saves, errors } = await createDraftReviewFixture(context);
  const dialog = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const check = dialog.getByRole('region', { name: 'Draft schedule check', exact: true });
  const pending = [];
  try {
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    await dialog.getByLabel('Profile name', { exact: true }).fill('Draft checks');
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click();    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
    await check.getByText('Draft review is incomplete.', { exact: true }).waitFor();
    assert.equal(await check.getByText('No blocking conflicts on this preview date.', { exact: true }).count(), 0);
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
    await dialog.getByLabel('Preview schedule for', { exact: true }).fill('2026-09-10'); await sent;
    await check.getByText('Checking changes…', { exact: true }).waitFor();
    assert.equal(await check.getByText(/1 conflict.*need/).count(), 0, 'Old advisory findings must disappear while the current date is pending');
    let loaded = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().referenceDate === '2026-09-11');
    await dialog.getByLabel('Preview schedule for', { exact: true }).fill('2026-09-11'); await loaded;
    pending.splice(0).forEach(resolve => resolve()); await page.waitForLoadState('networkidle');
    await check.getByText(/1 conflict.*need/).waitFor();
    assert.equal(await check.getByText('Stale response must never be displayed.', { exact: true }).count(), 0);
    sent = page.waitForRequest(request => request.url().endsWith('/draft-review') && request.postDataJSON().definition.name === 'Delayed definition');
    await dialog.getByLabel('Profile name', { exact: true }).fill('Delayed definition'); await sent;
    loaded = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().definition.name === 'Current definition');
    await dialog.getByLabel('Profile name', { exact: true }).fill('Current definition'); await loaded;
    pending.splice(0).forEach(resolve => resolve()); await page.waitForLoadState('networkidle');
    assert.equal(await check.getByText('Stale response must never be displayed.', { exact: true }).count(), 0);
    await dialog.getByLabel('Preview schedule for', { exact: true }).fill('2026-09-12');
    await check.getByText('Could not review this draft schedule.', { exact: true }).waitFor();
    assert.equal(await check.getByText(/No blocking conflicts|1 conflict.*need/).count(), 0, 'A failed review cannot retain a reassuring or stale result');
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).isEnabled(), true);
    control.reviewResponse = null;
    await check.getByRole('button', { name: 'Retry draft review', exact: true }).click(); await check.getByText(/1 conflict.*need/).waitFor();
    assert.equal(await dialog.getByLabel('Profile name', { exact: true }).inputValue(), 'Current definition');
    assert.equal(await dialog.getByLabel('Preview schedule for', { exact: true }).inputValue(), '2026-09-12');
    const reviewsBeforeRefresh = reviews.length, unchangedRevision = catalog.revision;
    catalog.classes[0].blockStartTime = '11:00'; catalog.classes[0].blockEndTime = '12:00';
    loaded = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().referenceDate === '2026-09-12');
    await dialog.getByRole('button', { name: 'Refresh regular schedule', exact: true }).click(); await loaded;
    await check.getByText('No blocking conflicts on this preview date.', { exact: true }).waitFor();
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
    await dialog.getByLabel('Preview schedule for', { exact: true }).fill('2026-09-14');
    control.previewDateTransform = () => '2026-09-15';
    control.saveTransform = definition => ({ ...definition, name: 'Server-confirmed testing', classRules: [{ classId: 'math', action: 'time', startTime: '10:20', endTime: '11:20' }] });
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Day planner', exact: true }).first().waitFor();
    await dialog.getByText('Profile saved — not applied', { exact: true }).waitFor();
    const review = dialog.getByRole('region', { name: 'Draft schedule review', exact: true });
    const check = dialog.getByRole('region', { name: 'Draft schedule check', exact: true });
    await check.getByText('Saved schedule review is temporarily unavailable.', { exact: true }).waitFor();
    assert.ok(control.catalogReadFailures > 0, 'The saved profile remains reviewable after an actual catalog refresh failure');
    assert.equal(saves.length, 1); assert.equal(catalog.profiles.length, 0, 'The saved view must not depend on finding the new profile in a stale catalog');
    assert.deepEqual(reviews.at(-1).definition, control.savedProfile.definition, 'Automatic review must use the exact returned definition');
    assert.equal(saves[0].previewDate, '2026-09-14');
    assert.equal(await dialog.getByLabel('Preview schedule for', { exact: true }).inputValue(), '2026-09-15');
    assert.equal(reviews.at(-1).referenceDate, '2026-09-15', 'Automatic review uses the exact server-confirmed date');
    assert.equal(await dialog.getByRole('button', { name: 'Save profile', exact: true }).count(), 0, 'A failed advisory check must never imply the save failed');
    control.failSavedReview = false;
    await check.getByRole('button', { name: 'Retry draft review', exact: true }).click();
    await review.getByText('Proposed: 10:20–11:20', { exact: true }).first().waitFor();
    assert.equal(saves.length, 1);
    await dialog.getByRole('button', { name: /Choose dates & apply/ }).click();
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0, 'A reference-day review never authorizes an application');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.equal(previews[0].profileId, control.savedProfile.id); assert.equal(previews[0].profileRevision, control.savedProfile.revision); assert.equal(previews[0].revision, catalog.revision);    await dialog.getByLabel('Preview schedule for', { exact: true }).fill('2026-09-11');
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('4');
    assert.equal(await dialog.getByRole('region', { name: 'Profile application preview', exact: true }).count(), 1, 'Actual dates remain clearly labelled beside the profile preview');
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 1);    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.equal(previews.length, 1, 'Reference-date and view filters do not change an already reviewed application');
    await dialog.getByLabel('Add an individual date', { exact: true }).fill('2026-09-09'); await dialog.getByRole('button', { name: 'Add selected date', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    await review.getByRole('button', { name: 'Clear display filters', exact: true }).click();
    await editClass(dialog, 'Zinkan Math');
    await dialog.getByLabel('Zinkan Math profile start', { exact: true }).fill('10:25');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.equal(previews.at(-1).definition.classRules[0].startTime, '10:25');
    assert.deepEqual(previews.at(-1).dates, ['2026-09-08', '2026-09-09']);
    const beforeGroup = structuredClone(previews.at(-1)), reviewsBeforeGroup = reviews.length;
    control.failCatalogRefresh = false;    await dialog.getByRole('button', { name: 'Add testing groups', exact: true }).first().click();
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

function deletableProfile() {
  return { id: 'profile-to-delete', revision: 4, previewDate: '2026-09-14', definition: { name: 'Old MAP profile', grades: [], classIds: ['math'], classRules: [{ classId: 'math', action: 'skip' }], testingBlocks: [{ id: 'old-block', name: 'Old MAP', coverageGroupId: 'zinkan-group', assignedStaffId: 'zinkan', startTime: '09:00', endTime: '10:45' }] } };
}

async function openDelete(page, name = 'Old MAP profile') {
  await page.getByRole('button', { name: 'More actions for ' + name, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete profile ' + name, exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete profile?', exact: true });
  await dialog.waitFor(); return dialog;
}

test('Deleting a reusable profile retains every applied snapshot and restores list focus', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, deletions, errors } = await createDraftReviewFixture(context);
  try {
    const profile = deletableProfile(); catalog.profiles.push(profile); catalog.revision = 17;
    catalog.applications = [
      ['past', '2026-09-07', 'scheduled'], ['today', '2026-09-08', 'scheduled'], ['future', '2026-09-14', 'scheduled'], ['cancelled', '2026-09-21', 'cancelled'],
    ].map(([id, date, status]) => ({ id, profileId: profile.id, profileName: profile.definition.name, dates: [date], status, definition: structuredClone(profile.definition), testingWindows: [{ date, blockId: 'old-block', name: 'Old MAP', startTime: '09:00', endTime: '10:45' }] }));
    catalog.testingStatuses = [{ applicationId: 'today', date: '2026-09-08', blockId: 'old-block', status: 'active' }];
    const applications = structuredClone(catalog.applications), statuses = structuredClone(catalog.testingStatuses);
    await page.reload(); await page.waitForLoadState('networkidle');
    let dialog = await openDelete(page);
    await dialog.getByText('Applied schedules will remain scheduled. Deleting this profile does not cancel testing.', { exact: true }).waitFor();
    for (const date of ['2026-09-07', '2026-09-08', '2026-09-14', '2026-09-21']) assert.match(await dialog.innerText(), new RegExp(date));
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(deletions.length, 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More actions for Old MAP profile');
    dialog = await openDelete(page);
    await dialog.getByRole('button', { name: 'Delete profile', exact: true }).evaluate(button => { button.click(); button.click(); });
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(deletions.length, 1, 'Repeated confirmation clicks submit once');
    assert.deepEqual({ id: deletions[0].id, revision: deletions[0].revision, profileRevision: deletions[0].profileRevision }, { id: profile.id, revision: 17, profileRevision: 4 });
    assert.equal(catalog.profiles.length, 0);
    assert.deepEqual(catalog.applications, applications); assert.deepEqual(catalog.testingStatuses, statuses);
    assert.equal(await page.getByRole('button', { name: 'Open profile Old MAP profile', exact: true }).count(), 0);
    await page.waitForFunction(() => document.activeElement?.textContent.trim() === 'Schedule profiles');
    await showEarlierApplications(page);
    assert.equal(await page.getByText('Saved profile deleted', { exact: true }).count(), 4);
    assert.equal(await page.getByRole('button', { name: 'Cancel application Old MAP profile', exact: true }).count(), 2, 'Dated applications remain independently manageable');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Profile deletion handles stale and missing profiles without retrying a captured destructive request', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, deletions, control, errors } = await createDraftReviewFixture(context);
  try {
    catalog.profiles.push(deletableProfile()); catalog.revision = 12;
    await page.reload(); await page.waitForLoadState('networkidle');
    const dialog = await openDelete(page);
    catalog.revision++; catalog.profiles[0].revision++;
    await dialog.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'The schedule changed.' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Delete profile', exact: true }).isDisabled(), true);
    assert.equal(deletions.length, 1); assert.equal(catalog.profiles.length, 1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const reopened = await openDelete(page);
    control.deleteResponse = () => ({ status: 404, json: { error: 'Schedule profile not found.' } });
    await reopened.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await reopened.getByRole('alert').filter({ hasText: 'Schedule profile not found.' }).waitFor();
    assert.equal(deletions.length, 2);
    assert.equal(deletions[1].revision, catalog.revision); assert.equal(deletions[1].profileRevision, catalog.profiles[0].revision);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Successful deletion followed by list failure offers a read-only retry and never restores its removed card', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, deletions, control, errors } = await createDraftReviewFixture(context);
  try {
    catalog.profiles.push(deletableProfile()); await page.reload(); await page.waitForLoadState('networkidle');
    const dialog = await openDelete(page); control.failDeleteRefresh = true;
    await dialog.getByRole('button', { name: 'Delete profile', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('Profile deleted; list refresh unavailable', { exact: false }).waitFor();
    assert.equal(deletions.length, 1); assert.equal(catalog.profiles.length, 0);
    assert.equal(await page.getByRole('button', { name: 'Open profile Old MAP profile', exact: true }).count(), 0);
    control.failDeleteRefresh = false;
    await page.getByRole('button', { name: 'Retry profile list refresh', exact: true }).click();
    await page.getByText('Profile deleted; list refresh unavailable', { exact: false }).waitFor({ state: 'hidden' });
    assert.equal(deletions.length, 1); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('A delayed profile deletion response cannot populate or navigate another school', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, deletions, control, errors } = await createDraftReviewFixture(context);
  let finishDelete;
  try {
    catalog.profiles.push(deletableProfile()); await page.reload(); await page.waitForLoadState('networkidle');
    const dialog = await openDelete(page);
    control.deleteResponse = async id => {
      await new Promise(resolve => { finishDelete = resolve; });
      catalog.profiles = catalog.profiles.filter(profile => profile.id !== id);
      return { json: { deleted: true, profileId: id, revision: ++catalog.revision } };
    };
    const submitted = page.waitForRequest(request => request.method() === 'DELETE');
    await dialog.getByRole('button', { name: 'Delete profile', exact: true }).click(); await submitted;
    await page.evaluate(() => window.switchFixtureSchool('other-school'));
    await dialog.waitFor({ state: 'hidden' });
    finishDelete(); finishDelete = null; await page.waitForLoadState('networkidle');
    assert.equal(deletions.length, 1); assert.equal(deletions[0].schoolId, 'school');
    assert.equal(await page.getByText(/Profile deleted|list refresh unavailable/).count(), 0, 'Prior-school callbacks cannot set new-school success/error state');
    assert.equal(await page.getByRole('button', { name: 'Open profile Old MAP profile', exact: true }).count(), 0);
    assert.equal(control.activeSchool, 'other-school'); assert.deepEqual(errors, []);
  } finally { finishDelete?.(); await browser.close(); await vite.close(); }
});

test('Inline timeline edits update provisional windows, preserve skipped rows, and Undo restores grouped draft changes', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, control, saves, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const pending = [];
  try {
    catalog.classes[0].blockStartTime = '08:30'; catalog.classes[0].blockEndTime = '09:10';
    catalog.profiles = [{ id: 'visual-profile', revision: 8, previewDate: '2026-09-14', definition: { name: 'Visual MAP day', grades: [], classIds: ['math', 'reading'], classRules: [], testingBlocks: [] } }];
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Visual MAP day', exact: true }).click();
    const homeroom = scheduleRow(workspace, 'Zinkan Math');
    await homeroom.getByRole('button', { name: 'Change proposed time for Zinkan Math: 08:30–09:10', exact: true }).click();
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).waitFor();
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).selectOption('time');
    const end = workspace.getByLabel('Zinkan Math profile end', { exact: true });
    await end.focus(); await end.fill('09:05'); await end.fill('09:00'); await page.keyboard.press('Tab');
    assert.equal(await homeroom.locator('[data-regular-window]').getAttribute('data-regular-window'), '08:30–09:10');
    assert.equal(await homeroom.locator('[data-proposed-window]').getAttribute('data-proposed-window'), '08:30–09:00');
    const undo = workspace.getByRole('button', { name: 'Undo last change', exact: true });
    await undo.click();
    assert.equal(await end.inputValue(), '09:10', 'Typing in one focused field is one undo operation');

    control.reviewResponse = async (body, result) => {
      if (body.definition.classRules.some(rule => rule.classId === 'math' && rule.endTime === '09:00')) await new Promise(resolve => pending.push(resolve));
      return { json: result };
    };
    const submitted = page.waitForRequest(request => request.url().endsWith('/draft-review') && request.postDataJSON().definition.classRules.some(rule => rule.endTime === '09:00'));
    await end.fill('09:00'); await submitted;
    assert.equal(await homeroom.locator('[data-proposed-window]').getAttribute('data-proposed-window'), '08:30–09:00', 'The proposed bar updates before the server review completes');
    await workspace.getByRole('region', { name: 'Draft schedule check', exact: true }).getByText(/Checking/).waitFor();
    await end.fill('');
    assert.equal(await homeroom.locator('[data-proposed-window]').count(), 0, 'An invalid draft does not draw an invented time window');
    assert.match(await homeroom.innerText(), /Not checked yet|Custom time incomplete/);
    control.reviewResponse = null; pending.splice(0).forEach(resolve => resolve());
    await end.fill('09:00'); await page.keyboard.press('Tab');
    await editClass(workspace, 'Burba Reading');
    await workspace.getByLabel('Burba Reading schedule action', { exact: true }).selectOption('skip');
    assert.match(await scheduleRow(workspace, 'Burba Reading').innerText(), /Does not meet/);
    assert.equal(await scheduleRow(workspace, 'Burba Reading').locator('[data-proposed-window]').count(), 0);
    assert.equal(await scheduleRow(workspace, 'Burba Reading').locator('[data-regular-window]').count(), 1);
    await undo.click();
    assert.match(await scheduleRow(workspace, 'Burba Reading').innerText(), /09:00–10:00/);
    await includeClass(workspace, 'Art Studio'); await undo.click();
    assert.equal(await workspace.getByLabel('Include Art Studio', { exact: true }).isChecked(), false);

    await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).first().click();
    const picker = page.getByRole('dialog', { name: 'Add testing groups', exact: true });
    await picker.getByRole('checkbox', { name: /Mixed MAP group/ }).check();
    await picker.getByRole('checkbox', { name: /Reading MAP group/ }).check();
    await picker.getByLabel('Common testing start', { exact: true }).fill('09:00');
    await picker.getByLabel('Common testing end', { exact: true }).fill('10:45');
    await picker.getByRole('button', { name: 'Add 2 testing blocks', exact: true }).click();
    assert.equal(await workspace.locator('[data-schedule-row^="testing:"]').count(), 2);
    await undo.click();
    assert.equal(await workspace.locator('[data-schedule-row^="testing:"]').count(), 0, 'Bulk addition is one undo operation');
    await addTestingBlock(workspace, 1, 'zinkan');
    const savedBlockName = await workspace.getByLabel('Testing block 1 name').inputValue();
    await workspace.getByRole('button', { name: 'Remove testing block 1', exact: true }).click();
    assert.equal(await scheduleRow(workspace, savedBlockName).count(), 0);
    await undo.click(); await scheduleRow(workspace, savedBlockName).waitFor();
    const order = await workspace.locator('[data-schedule-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-schedule-row')));
    await editClass(workspace, 'Zinkan Math');
    await workspace.getByLabel('Zinkan Math profile start', { exact: true }).fill('07:00');
    assert.deepEqual(await workspace.locator('[data-schedule-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-schedule-row'))), order, 'Editing time does not reorder or unmount the focused row');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves[0].profileRevision, 8, 'Clicking the saved bar preserves its captured revision');
    assert.equal(saves[0].definition.classRules.find(rule => rule.classId === 'math').endTime, '09:00');
    assert.equal(saves[0].definition.classRules.some(rule => rule.classId === 'reading'), false);
    assert.equal(saves[0].definition.testingBlocks.length, 1);
    assert.equal(await undo.isDisabled(), true, 'Accepting the exact save response ends Undo history');
    assert.deepEqual(errors, []);
  } finally { pending.splice(0).forEach(resolve => resolve()); await browser.close(); await vite.close(); }
});

test('Application scope edits and Undo retain the customized definition while display search keeps keyboard focus', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, previews, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    const profile = deletableProfile(); catalog.profiles.push(profile);
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Choose dates & apply Old MAP profile', exact: true }).click();
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    const selection = await classSelection(workspace);
    await selection.getByRole('checkbox', { name: 'Include Grade 4', exact: true }).check();
    const customize = workspace.getByRole('checkbox', { name: 'Customize this use', exact: true });
    assert.equal(await customize.isChecked(), true, 'Editing the class scope starts application customization without requiring a row click');
    assert.equal(await workspace.getByLabel('Preview schedule for', { exact: true }).inputValue(), '2026-09-08');
    assert.equal(await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.deepEqual(previews.at(-1).definition.grades, ['4']);
    const intended = structuredClone(previews.at(-1).definition);
    page.once('dialog', prompt => prompt.accept());
    await customize.uncheck();
    assert.equal(await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0);
    await workspace.getByRole('button', { name: 'Undo last change', exact: true }).click();
    assert.equal(await customize.isChecked(), true, 'Undo restores the customization flag together with its definition');
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.deepEqual(previews.at(-1).definition, intended);
    await editClass(workspace, 'Zinkan Math');
    const search = workspace.getByLabel('Find a class or teacher', { exact: true });
    await search.focus(); await search.pressSequentially('Zinkan', { delay: 30 });
    assert.equal(await search.inputValue(), 'Zinkan');
    assert.equal(await search.evaluate(element => document.activeElement === element), true, 'Closing the former row through filtering must not steal focus from the search field');
    assert.equal(await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 1, 'Display-only filtering does not invalidate the authoritative preview');
    assert.deepEqual(catalog.profiles[0], profile); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Committed applications and cancellations survive list failures with read-only retries', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, applies, cancellations, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    catalog.profiles.push(deletableProfile()); await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Choose dates & apply Old MAP profile', exact: true }).click();
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    control.failApplicationRefresh = true;
    await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).click();
    await workspace.waitFor({ state: 'hidden' });
    await page.getByText('Schedule applied; list refresh unavailable.', { exact: true }).waitFor();
    assert.equal(applies.length, 1); assert.equal(catalog.applications.length, 1);
    await page.getByRole('region', { name: 'Schedule profile applications' }).waitFor();
    control.failApplicationRefresh = false;
    await page.getByRole('button', { name: 'Retry schedule list refresh', exact: true }).click();
    await page.getByText('Schedule profile applied to the reviewed dates.', { exact: true }).waitFor();
    assert.equal(applies.length, 1, 'Recovering the list never repeats the application');
    control.failCancellationRefresh = true;
    await confirmCancellation(page, 'Old MAP profile');
    await showEarlierApplications(page);
    await page.getByText('Schedule application cancelled; list refresh unavailable.', { exact: true }).waitFor();
    await page.getByRole('region', { name: 'Schedule profile applications' }).getByText('Cancelled', { exact: true }).waitFor();
    assert.equal(cancellations.length, 1); assert.equal(catalog.applications[0].status, 'cancelled');
    control.failCancellationRefresh = false;
    await page.getByRole('button', { name: 'Retry schedule list refresh', exact: true }).click();
    await page.getByText('Schedule application cancelled.', { exact: true }).waitFor();
    assert.equal(cancellations.length, 1); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Narrow screens default to List and keep the chosen planner view across profiles', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    catalog.profiles.push(deletableProfile());
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Old MAP profile', exact: true }).click();
    assert.equal(await workspace.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed'), 'true');
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    const scroller = workspace.getByRole('region', { name: 'Proposed day timeline', exact: true });
    assert.equal(await scroller.evaluate(element => element.scrollWidth > element.clientWidth), true);
    await scroller.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[aria-label="Proposed day timeline"]')?.scrollLeft > 0);
    assert.equal(await scroller.evaluate(element => document.activeElement === element && getComputedStyle(element).boxShadow !== 'none'), true);
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    await page.getByRole('button', { name: 'Open profile Old MAP profile', exact: true }).click();
    assert.equal(await workspace.getByRole('button', { name: 'Timeline', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Grade collapse survives display changes and issue navigation reveals its class before returning to scheduling', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, saves, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    const profile = deletableProfile(); profile.definition.classRules = []; catalog.profiles.push(profile);
    await page.reload(); await page.waitForLoadState('networkidle');
    const opener = page.getByRole('button', { name: 'Open profile Old MAP profile', exact: true });
    await opener.click();
    await workspace.getByRole('region', { name: 'Draft schedule check', exact: true }).getByText(/1 conflict.*need/).waitFor();
    const grade = workspace.getByRole('button', { name: /^Grade 3\s*\(2\)$/ });
    await grade.click();
    assert.equal(await grade.getAttribute('aria-expanded'), 'false');
    assert.equal(await scheduleRow(workspace, 'Zinkan Math').count(), 0);
    await workspace.getByRole('button', { name: 'List', exact: true }).click();
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    assert.equal(await grade.getAttribute('aria-expanded'), 'false', 'View switching retains the collapsed grade');
    await workspace.getByRole('button', { name: 'Resolve issue for class Zinkan Math', exact: true }).click();
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).waitFor();
    assert.equal(await grade.getAttribute('aria-expanded'), 'true');
    assert.equal(await workspace.locator('[data-class-editor-id="math"]').evaluate(element => element.contains(document.activeElement)), true);
    assert.equal(await workspace.getByLabel('Whole profile summary').innerText(), '1 classes included · 0 custom-time rules · 0 skipped-class rules · 1 testing blocks');
    let prompts = 0; page.on('dialog', async prompt => { prompts++; await prompt.dismiss(); });
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    await workspace.waitFor({ state: 'hidden' });
    assert.equal(prompts, 0, 'Opening a row without making changes requires no discard prompt');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Open profile Old MAP profile');
    assert.equal(saves.length, 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});


test('Scheduling overview separates reusable changes from dated snapshots and preserves expanded details on return', { timeout: 120_000 }, async context => {
  const { root, browser, vite, page, catalog, errors } = await createDraftReviewFixture(context);
  try {
    const alpha = deletableProfile(); alpha.id = 'alpha'; alpha.definition.name = 'Alpha MAP';
    alpha.definition.classIds.push('reading');
    alpha.definition.classRules.push({ classId: 'reading', action: 'time', startTime: '10:45', endTime: '11:30' });
    const application = appliedSnapshot(alpha, 'alpha-dates', ['2026-09-08', '2026-09-10']);
    const empty = { id: 'zulu', revision: 1, definition: { name: 'Zulu unchanged', grades: ['3', '4'], classIds: [], classRules: [], testingBlocks: [] } };
    const duplicate = structuredClone(alpha); duplicate.id = 'alpha-2';
    catalog.profiles = [empty, duplicate, alpha];
    const cancelled = appliedSnapshot(alpha, 'cancelled-nearer-date', ['2026-09-09'], { status: 'cancelled' });
    const past = appliedSnapshot(alpha, 'earlier', ['2026-09-07']);
    const noChange = appliedSnapshot(alpha, 'no-change', ['2026-09-09'], { classWindows: {}, testingWindows: [] });
    catalog.applications = [cancelled, application, past, noChange];
    catalog.testingStatuses = [
      { applicationId: application.id, date: '2026-09-08', blockId: 'old-block', status: 'active' },
      { applicationId: application.id, date: '2026-09-10', blockId: 'old-block', status: 'pending' },
    ];
    const emptySummary = overviewCatalog(catalog).applicationSummaries[noChange.id];
    emptySummary.dates = emptySummary.dates.map(day => ({ ...day, phase: 'no_changes', customTimeCount: 0, skippedClassCount: 0, testingBlockCount: 0 }));
    emptySummary.nextFutureDate = null; emptySummary.appliedToday = false;
    emptySummary.cancellation = { canRequest: false, cutoffAt: null, reason: 'no_changes' };
    const activeSummary = overviewCatalog(catalog).applicationSummaries[application.id];
    activeSummary.cancellation = { canRequest: false, cutoffAt: '2026-09-08T13:00:00Z', reason: 'started' };
    catalog.summariesCheckedAt = '2026-09-08T13:30:00Z';
    catalog.applicationSummaries = { [noChange.id]: emptySummary, [application.id]: activeSummary };
    // A later profile edit must not rewrite the dated display or its counts.
    alpha.definition.classRules[1].startTime = '11:00';
    alpha.definition.classIds.push('science');
    alpha.definition.classRules.push({ classId: 'science', action: 'time', startTime: '12:00', endTime: '12:45' });
    alpha.definition.testingBlocks.push({ ...alpha.definition.testingBlocks[0], id: 'newer-block', name: 'Later profile-only block' });
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('region', { name: 'Saved profiles', exact: true }).waitFor();
    assert.deepEqual(await page.locator('[data-profile-id]').evaluateAll(rows => rows.map(row => row.dataset.profileId)), ['alpha', 'alpha-2', 'zulu'], 'Alphabetical names use a stable ID tie-breaker');
    const reusable = profileRow(page, 'alpha');
    assert.match(await reusable.innerText(), /2 testing blocks/);
    assert.match(await reusable.innerText(), /2 custom class times/);
    assert.match(await reusable.innerText(), /1 skipped class/);
    assert.match(await reusable.innerText(), /September 10, 2026/);
    assert.doesNotMatch(await reusable.innerText(), /September 9, 2026/);
    await reusable.getByText('Applied today', { exact: true }).waitFor();
    await profileRow(page, 'zulu').getByText('No schedule changes configured', { exact: true }).waitFor();
    await profileRow(page, 'zulu').getByText('4 classes included', { exact: true }).waitFor();
    await profileRow(page, 'zulu').getByText('No future dates', { exact: true }).waitFor();
    const applied = applicationRow(page, application.id);
    assert.equal(await applied.getByRole('region', { name: 'Applied date 2026-09-08', exact: true }).count(), 0, 'Collapsed details are absent from accessible navigation');
    assert.equal(await applicationRow(page, 'earlier').isVisible(), false);
    assert.equal(await applicationRow(page, cancelled.id).isVisible(), false);
    const toggle = applied.getByRole('button', { name: /^View details/ });
    await toggle.focus(); await page.keyboard.press('Enter');
    assert.equal(await applied.getByRole('button', { name: /^Hide details/ }).getAttribute('aria-expanded'), 'true');
    const day = applied.getByRole('region', { name: 'Applied date 2026-09-08', exact: true });
    assert.match(await day.innerText(), /10:45 AM/);
    assert.doesNotMatch(await day.innerText(), /11:00 AM|Later profile-only block/);
    assert.match(await applied.innerText(), /2 custom class times/);
    assert.doesNotMatch(await applied.innerText(), /4 custom class times/);
    const savedSnapshot = structuredClone(application);
    await reusable.getByRole('button', { name: 'Open profile Alpha MAP', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await workspace.getByRole('button', { name: 'Back to scheduling', exact: true }).click();
    await workspace.waitFor({ state: 'hidden' });
    assert.equal(await applied.getByRole('button', { name: /^Hide details/ }).getAttribute('aria-expanded'), 'true');
    assert.equal(await reusable.getByRole('button', { name: 'Open profile Alpha MAP', exact: true }).evaluate(button => button === document.activeElement), true);
    assert.deepEqual(catalog.applications.find(row => row.id === application.id), savedSnapshot);
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await day.waitFor();
    assert.equal(await applied.getByRole('button', { name: /^Hide details/ }).getAttribute('aria-expanded'), 'true');
    await showEarlierApplications(page);
    assert.equal(await applicationRow(page, 'earlier').isVisible(), true);
    assert.equal(await applicationRow(page, cancelled.id).isVisible(), true);
    const artifactDir = path.join(root, 'artifacts', 'scheduling-overview'); await mkdir(artifactDir, { recursive: true });
    await applied.getByRole('button', { name: /^Hide details/ }).click();
    await page.locator('summary').filter({ hasText: /^Earlier and cancelled applications/ }).click();
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(artifactDir, size + '-' + theme + '.png'), fullPage: true, animations: 'disabled' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, size + ' ' + theme + ' has no page overflow');
        assert.equal(await reusable.getByRole('button', { name: 'More actions for Alpha MAP', exact: true }).isVisible(), true);
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Applied date summaries expose failures and unknown outcomes without declaring the whole schedule finished', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, errors } = await createDraftReviewFixture(context);
  try {
    const profile = deletableProfile(); profile.definition.name = 'Mixed testing outcomes';
    const states = ['pending', 'active', 'ended', 'failed', 'missed', 'cancelled', 'releasing', 'unknown'];
    profile.definition.testingBlocks = states.map((status, index) => ({ ...profile.definition.testingBlocks[0], id: 'block-' + index, name: status + ' testing' }));
    profile.definition.classRules = [{ classId: 'math', action: 'time', startTime: '13:00', endTime: '14:00' }];
    const application = appliedSnapshot(profile, 'mixed-outcomes', ['2026-09-08']);
    catalog.profiles = [profile]; catalog.applications = [application];
    catalog.testingStatuses = states.flatMap((status, index) => status === 'unknown' ? [] : [{ applicationId: application.id, date: '2026-09-08', blockId: 'block-' + index, status, code: status === 'failed' ? 'COVERAGE_ROSTER_CHANGED' : status === 'missed' ? 'WINDOW_ELAPSED' : undefined }]);
    const summary = overviewCatalog(catalog).applicationSummaries[application.id];
    summary.cancellation = { canRequest: false, cutoffAt: '2026-09-08T11:00:00Z', reason: 'started' };
    catalog.applicationSummaries = { [application.id]: summary };
    await page.reload(); await page.waitForLoadState('networkidle');
    const row = applicationRow(page, application.id);
    for (const label of ['awaiting start', 'active', 'finished', 'could not start', 'missed', 'cancelled', 'ending', 'status unavailable']) await row.getByText('1 testing block ' + label, { exact: true }).waitFor();
    await row.getByText('Applied today', { exact: true }).waitFor();
    assert.equal(await row.getByText('Completed', { exact: true }).count(), 0);
    assert.equal(await row.getByRole('button', { name: /^Cancel application/ }).count(), 0);
    assert.match(await page.getByRole('region', { name: 'Schedule profile applications', exact: true }).innerText(), /Testing status is separate from class changes/);
    await showApplicationDetails(page, application);
    await row.getByText('The Supervision group roster changed.', { exact: true }).waitFor();
    await row.getByText('The testing window elapsed before it could start.', { exact: true }).waitFor();
    assert.match(await row.getByRole('region', { name: 'Applied date 2026-09-08', exact: true }).innerText(), /1:00 PM.*2:00 PM/);
    assert.equal(await row.getByText('Status unavailable', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Cancellation confirms every date, prevents stale resubmission, and expires an open confirmation at the server cutoff', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, control, cancellations, errors } = await createDraftReviewFixture(context);
  try {
    const profile = deletableProfile(); const application = appliedSnapshot(profile, 'cutoff-application', ['2026-09-08', '2026-09-10']);
    catalog.profiles = [profile]; catalog.applications = [application]; catalog.revision = 21;
    await page.reload(); await page.waitForLoadState('networkidle');
    const opener = applicationRow(page, application.id).getByRole('button', { name: 'Cancel application Old MAP profile', exact: true });
    await opener.click();
    const dialog = page.getByRole('alertdialog', { name: 'Cancel application?', exact: true });
    assert.match(await dialog.innerText(), /September 8, 2026/); assert.match(await dialog.innerText(), /September 10, 2026/);
    await dialog.getByRole('button', { name: 'Keep application', exact: true }).click();
    assert.equal(await opener.evaluate(button => button === document.activeElement), true); assert.equal(cancellations.length, 0);
    await opener.click();
    control.cancelResponse = () => { catalog.revision++; return { status: 409, json: { error: 'The schedule changed. Refresh status before cancelling.' } }; };
    const confirm = dialog.getByRole('button', { name: 'Cancel all applied dates', exact: true });
    await confirm.evaluate(button => { button.click(); button.click(); });
    await dialog.getByRole('alert').filter({ hasText: 'Scheduling changed.' }).waitFor();
    assert.equal(cancellations.length, 1, 'Repeated confirmations send one mutation');
    assert.equal(cancellations[0].revision, 21); assert.equal(await confirm.isDisabled(), true);
    await dialog.getByRole('button', { name: 'Keep application', exact: true }).click();
    const summary = overviewCatalog(catalog).applicationSummaries[application.id];
    summary.cancellation = { canRequest: true, cutoffAt: '2026-09-08T12:01:00Z', reason: null };
    catalog.applicationSummaries = { [application.id]: summary };
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await page.waitForLoadState('networkidle');
    await opener.click();
    control.failOverviewRead = true;
    const readsBefore = control.catalogReads.length;
    await page.clock.setSystemTime(new Date('2026-09-08T12:00:00Z'));
    await page.clock.fastForward(61_000);
    await page.waitForFunction(() => document.querySelector('[role="alertdialog"] button:last-child')?.disabled === true);
    assert.ok(control.catalogReads.length > readsBefore, 'The known cutoff triggers a status read without another user action');
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(cancellations.length, 1, 'An expired confirmation never posts another cancellation');
    await dialog.getByRole('button', { name: 'Keep application', exact: true }).click();
    assert.equal(await opener.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Overview read failures remain explicit and delayed old-school status cannot populate another school', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, control, cancellations, errors } = await createDraftReviewFixture(context);
  let finishRead;
  try {
    const profile = deletableProfile(); const application = appliedSnapshot(profile, 'read-failure', ['2026-09-10']);
    catalog.profiles = [profile]; catalog.applications = [application];
    await page.reload(); await page.waitForLoadState('networkidle');
    await showApplicationDetails(page, application);
    control.failOverviewRead = true;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByText('Current application status is unavailable. Refresh status to check again.', { exact: true }).waitFor();
    await profileRow(page, profile.id).getByText('Schedule dates unavailable', { exact: true }).waitFor();
    assert.equal(await applicationRow(page, application.id).getByRole('button', { name: /^Cancel application/ }).count(), 0);
    assert.equal(await applicationRow(page, application.id).getByText('No testing blocks', { exact: true }).count(), 0);
    control.failOverviewRead = false;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await profileRow(page, profile.id).getByText('September 10, 2026', { exact: true }).waitFor();
    assert.equal(await applicationRow(page, application.id).getByRole('button', { name: /^Hide details/ }).getAttribute('aria-expanded'), 'true');
    catalog.applicationSummaries = { [application.id]: null };
    const missingSummaryRead = page.waitForResponse(response => response.url().endsWith('/schedule-profiles') && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    assert.equal((await (await missingSummaryRead).json()).applicationSummaries[application.id], null);
    await profileRow(page, profile.id).getByText('Schedule dates unavailable', { exact: true }).waitFor();
    await applicationRow(page, application.id).getByText('Date status unavailable', { exact: true }).waitFor();
    assert.equal(await applicationRow(page, application.id).getByRole('button', { name: /^Cancel application/ }).count(), 0, 'A missing additive summary does not imply cancellation permission');
    catalog.applicationSummaries = {};
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await profileRow(page, profile.id).getByText('September 10, 2026', { exact: true }).waitFor();
    const captured = overviewCatalog(catalog);
    control.catalogResponse = async schoolId => {
      if (schoolId !== 'school') return null;
      await new Promise(resolve => { finishRead = resolve; });
      return { json: captured };
    };
    const read = page.waitForRequest(request => request.url().endsWith('/schedule-profiles') && request.method() === 'GET');
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await read;
    await page.evaluate(() => window.switchFixtureSchool('other-school'));
    await page.getByRole('region', { name: 'Saved profiles', exact: true }).getByText(/No profiles yet/).waitFor();
    finishRead(); finishRead = null; await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('[data-profile-id]').count(), 0); assert.equal(await page.locator('[data-application-id]').count(), 0);
    assert.equal(await page.getByText('Old MAP profile', { exact: true }).count(), 0);
    assert.equal(cancellations.length, 0); assert.deepEqual(errors, []);
  } finally { finishRead?.(); await browser.close(); await vite.close(); }
});


test('Unavailable cancellation cutoffs and a slow status response cannot extend the cancellation window', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, cancellations, errors } = await createDraftReviewFixture(context);
  let finishRead;
  try {
    const profile = deletableProfile(); const application = appliedSnapshot(profile, 'uncertain-cutoff', ['2026-09-08']);
    catalog.profiles = [profile]; catalog.applications = [application];
    const summary = overviewCatalog(catalog).applicationSummaries[application.id];
    summary.cancellation = { canRequest: true, cutoffAt: null, reason: null };
    catalog.applicationSummaries = { [application.id]: summary };
    await page.reload(); await page.waitForLoadState('networkidle');
    const row = applicationRow(page, application.id);
    await row.getByText('Cancellation availability could not be checked. Refresh status to try again.', { exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: /^Cancel application/ }).count(), 0, 'A missing cutoff is unknown even if canRequest was true');
    summary.cancellation.cutoffAt = '2026-09-08T12:00:05Z';
    const captured = overviewCatalog(catalog);
    control.catalogResponse = async () => {
      await new Promise(resolve => { finishRead = resolve; });
      return { json: captured };
    };
    const response = page.waitForResponse(response => response.url().endsWith('/schedule-profiles') && response.request().method() === 'GET');
    const request = page.waitForRequest(request => request.url().endsWith('/schedule-profiles') && request.method() === 'GET');
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await request;
    await page.clock.fastForward(6_000);
    finishRead(); finishRead = null; await response;
    await page.getByRole('button', { name: 'Refresh status', exact: true, disabled: false }).waitFor();
    assert.equal(await row.getByRole('button', { name: /^Cancel application/ }).count(), 0, 'Time spent waiting for a response cannot create five extra seconds of cancellation');
    await row.getByText('Cancellation availability could not be checked. Refresh status to try again.', { exact: true }).waitFor();
    control.catalogResponse = null; control.failOverviewRead = true;
    await page.clock.fastForward(16 * 60 * 60 * 1000);
    await page.getByText('Current application status is unavailable. Refresh status to check again.', { exact: true }).waitFor();
    await profileRow(page, profile.id).getByText('Schedule dates unavailable', { exact: true }).waitFor();
    assert.equal(await row.getByText('Applied today', { exact: true }).count(), 0, 'An unrefreshed school-date boundary does not present yesterday as today');
    assert.equal(cancellations.length, 0); assert.deepEqual(errors, []);
  } finally { finishRead?.(); await browser.close(); await vite.close(); }
});


test('A cancellation response arriving after a school switch cannot update or navigate the new school', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, cancellations, errors } = await createDraftReviewFixture(context);
  let finishCancel;
  try {
    const profile = deletableProfile(); const application = appliedSnapshot(profile, 'scope-cancellation', ['2026-09-10']);
    catalog.profiles = [profile]; catalog.applications = [application];
    await page.reload(); await page.waitForLoadState('networkidle');
    await applicationRow(page, application.id).getByRole('button', { name: 'Cancel application Old MAP profile', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Cancel application?', exact: true });
    control.cancelResponse = async () => {
      await new Promise(resolve => { finishCancel = resolve; });
      application.status = 'cancelled';
      return { json: { revision: ++catalog.revision } };
    };
    const submission = page.waitForRequest(request => request.url().endsWith('/cancel') && request.method() === 'POST');
    await dialog.getByRole('button', { name: 'Cancel all applied dates', exact: true }).click();
    const submitted = await submission; assert.equal(submitted.headers()['x-school-id'], 'school');
    await page.evaluate(() => window.switchFixtureSchool('other-school'));
    await dialog.waitFor({ state: 'hidden' });
    finishCancel(); finishCancel = null; await page.waitForLoadState('networkidle');
    assert.equal(cancellations.length, 1);
    assert.equal(await page.locator('[data-application-id]').count(), 0);
    assert.equal(await page.getByText(/Schedule application cancelled/).count(), 0, 'The successful old-school action must not write a new-school notice');
    await page.getByRole('region', { name: 'Saved profiles', exact: true }).getByText(/No profiles yet/).waitFor();
    assert.deepEqual(errors, []);
  } finally { finishCancel?.(); await browser.close(); await vite.close(); }
});
