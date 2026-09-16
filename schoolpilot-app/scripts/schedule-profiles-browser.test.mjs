import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { tsImport } from 'tsx/esm/api';

const DEFAULT_SCHOOL_HOURS = { enableTrackingHours: true, trackingStartTime: '08:00', trackingEndTime: '16:00' };

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

const scheduleOccurrences = (workspace, name) => workspace.getByRole('article', { name: `${name} schedule row`, exact: true });
// A testing block can appear beside several grades while remaining one editable
// block. General scenarios use its first occurrence; linked-row scenarios check
// every occurrence explicitly.
const scheduleRow = (workspace, name) => scheduleOccurrences(workspace, name).first();
const canonicalTestingKeys = workspace => workspace.locator('[data-schedule-row^="testing:"]').evaluateAll(rows => [...new Set(rows.map(row => row.getAttribute('data-schedule-row')))]);

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

async function openPlannerIssues(workspace) {
  const summary = workspace.locator('summary').filter({ hasText: /^Schedule issues and overlaps/ });
  if (!await summary.locator('..').evaluate(element => element.open)) await summary.click();
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
    const allPast = application.dates.length > 0 && application.dates.every(date => date < catalog.schoolLocalToday);
    const unknown = dates.some(date => date.testingOutcomes.unknown > 0);
    const supervisionPending = dates.some(date => date.testingOutcomes.pending + date.testingOutcomes.active + date.testingOutcomes.releasing > 0);
    const historyReason = application.historyHiddenAt ? 'hidden' : !allPast ? 'not_past' : unknown ? 'unavailable' : supervisionPending ? 'supervision_pending' : 'available';
    return [application.id, { dates, nextFutureDate: dates.filter(date => date.phase === 'future').map(date => date.date).sort()[0] || null, appliedToday: dates.some(date => date.phase === 'today'), cancellation: { canRequest, cutoffAt: canRequest ? `${application.dates.slice().sort()[0]}T13:00:00Z` : null, reason: canRequest ? null : application.status === 'cancelled' ? 'cancelled' : 'started' }, historyRemoval: { canRequest: historyReason === 'available', reason: historyReason, checkedAt: catalog.summariesCheckedAt || '2026-09-08T12:00:00Z' } }];
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
  const reviews = [], saves = [], previews = [], applies = [], deletions = [], cancellations = [], historyDeletions = [], errors = [];
  const control = { reviewResponse: null, saveResponse: null, saveTransform: definition => definition, previewDateTransform: value => value, staleCatalog: false, failCatalogRefresh: false, failOverviewRead: false, catalogResponse: null, catalogReads: [], catalogReadFailures: 0, failSavedReview: false, groupCreates: [], failGroupCreate: false, failDirectory: false, deleteResponse: null, cancelResponse: null, failDeleteRefresh: false, failApplicationRefresh: false, failCancellationRefresh: false, activeSchool: 'school' };
  control.schoolHours = { ...DEFAULT_SCHOOL_HOURS };
  control.schoolHoursReads = [];
  control.schoolHoursResponse = null;
  control.failSchoolHours = false;
  control.historyDeleteResponse = null;
  control.failHistoryRefresh = false;
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
    if (url.pathname === '/api/settings') {
      const read = { method: request.method(), schoolId: request.headers()['x-school-id'] || null };
      control.schoolHoursReads.push(read);
      const response = await control.schoolHoursResponse?.(read);
      if (response) return route.fulfill(response);
      return route.fulfill(control.failSchoolHours ? { status: 503, json: { error: 'School hours are temporarily unavailable.' } } : { json: { ...control.schoolHours, schoolTimezone: catalog.schoolTimezone } });
    }
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
    if (url.pathname.endsWith('/schedule-profiles/regular-schedule')) {
      const referenceDate = url.searchParams.get('referenceDate');
      const response = await control.regularResponse?.(referenceDate);
      return route.fulfill(response || { json: { referenceDate, revision: catalog.revision, schoolTimezone: catalog.schoolTimezone, day: { instructional: true, meetingWeekday: 2, cycleDay: 'A', bellProfile: null, overridden: false }, classes: catalog.classes.map(row => ({ classId: row.id, status: 'meets', window: { startTime: row.blockStartTime, endTime: row.blockEndTime } })) } });
    }
    if (url.pathname.endsWith('/schedule-profiles/draft-review')) {
      const body = request.postDataJSON(); reviews.push(body);
      if (control.failSavedReview && saves.length) return route.fulfill({ status: 503, json: { error: 'Saved schedule review is temporarily unavailable.' } });
      const custom = await control.reviewResponse?.(body, project(body));
      return route.fulfill(custom || { json: project(body) });
    }
    if (url.pathname.endsWith('/schedule-profiles/preview')) {
      const body = request.postDataJSON(); previews.push(body);
      const response = await control.previewResponse?.(body);
      return route.fulfill(response || { json: { previewToken: `actual-date-${previews.length}`, schoolTimezone: catalog.schoolTimezone, affectedClasses: 1, blockers: [], changes: [], testingWindows: [] } });
    }
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
    if (request.method() === 'DELETE' && /\/schedule-profiles\/applications\/[^/]+\/history$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2)), body = request.postDataJSON();
      historyDeletions.push({ id, ...body, schoolId: request.headers()['x-school-id'] });
      const response = await control.historyDeleteResponse?.(id, body);
      if (response) return route.fulfill(response);
      const application = catalog.applications.find(row => row.id === id);
      if (!application) return route.fulfill({ status: 404, json: { error: 'Schedule application not found.' } });
      if (body.revision !== catalog.revision) return route.fulfill({ status: 409, json: { error: 'Schedules changed. Reload and reopen Delete from history.', code: 'SCHEDULE_PREVIEW_STALE' } });
      if (!overviewCatalog(catalog).applicationSummaries[id]?.historyRemoval?.canRequest) return route.fulfill({ status: 409, json: { error: 'History removal is unavailable.' } });
      application.historyHiddenAt = '2026-09-08T12:00:01.000Z';
      return route.fulfill({ json: { hidden: true, applicationId: id, revision: ++catalog.revision, historyHiddenAt: application.historyHiddenAt } });
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
      if (control.failOverviewRead || (control.failCatalogRefresh && saves.length) || control.failGroupCatalogRefresh || (control.failDeleteRefresh && deletions.length) || (control.failApplicationRefresh && applies.length) || (control.failCancellationRefresh && cancellations.length) || (control.failHistoryRefresh && historyDeletions.length)) { control.catalogReadFailures++; return route.fulfill({ status: 503, json: { error: 'The profile list is temporarily unavailable.' } }); }
      return route.fulfill({ json: overviewCatalog(schoolId === 'school' ? catalog : { ...catalog, profiles: [], applications: [], testingStatuses: [], applicationSummaries: {}, classes: [], staff: [], supervisionGroups: [] }) });
    }
    return route.fulfill({ status: 404, json: { error: `Unexpected fixture request ${url.pathname}` } });
  };
  await page.route('**/api/**', handleApi);
  await page.goto(fixture.url); await page.waitForLoadState('networkidle');
  return { ...fixture, catalog, reviews, saves, previews, applies, deletions, cancellations, historyDeletions, errors, control, handleApi };
}

let placementModules;
async function createClassPlacementFixture(context) {
  // These pure projections use synthetic server facts. Loading them does not
  // execute the database-backed review endpoints or expose rosters to the UI.
  // tsImport uses scoped loader registrations; initialize each scope serially.
  placementModules ||= (async () => [
    await tsImport('../../src/services/classpilotScheduleDraftReview.ts', import.meta.url),
    await tsImport('../../src/services/classpilotRegularSchedule.ts', import.meta.url),
    await tsImport('../../src/services/classpilotSchedulingRules.ts', import.meta.url),
  ])();
  const [{ projectScheduleDraftReview }, { projectClasspilotRegularSchedule }, { emptySchoolSchedulingConfig }] = await placementModules;
  const fixture = await createDraftReviewFixture(context);
  const { catalog, control } = fixture;
  const cohort = Array.from({ length: 12 }, (_, index) => `placement-student-${index + 1}`);
  const placement = { config: emptySchoolSchedulingConfig(), calendar: {}, rosters: new Map([
    ['math', cohort], ['reading', [...cohort]], ['science', ['science-student']], ['art', ['art-student']],
  ]), unavailableRosters: new Set(), reviewResponse: null };
  const windows = [['08:30', '09:10'], ['11:00', '11:45'], ['12:00', '12:45'], ['13:00', '13:45']];
  catalog.classes.forEach((row, index) => Object.assign(row, { blockStartTime: windows[index][0], blockEndTime: windows[index][1] }));
  const facts = referenceDate => ({ referenceDate, revision: catalog.revision, schoolTimezone: catalog.schoolTimezone,
    config: placement.config, calendar: placement.calendar,
    tracking: { ...control.schoolHours, trackingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], schoolTimezone: catalog.schoolTimezone },
    classes: catalog.classes.map(row => ({ ...row, studentIds: placement.rosters.get(row.id) || [], unavailableRoster: placement.unavailableRosters.has(row.id) })),
    supervisionGroups: catalog.supervisionGroups.map(group => ({ ...group, inactiveStudents: 0 })), staff: catalog.staff,
  });
  control.regularResponse = referenceDate => ({ json: projectClasspilotRegularSchedule(facts(referenceDate)) });
  control.reviewResponse = async body => {
    const reviewed = projectScheduleDraftReview(body.definition, facts(body.referenceDate));
    return await placement.reviewResponse?.(body, reviewed) || { json: reviewed };
  };
  return { ...fixture, placement, projectPlacement: (definition, referenceDate) => projectScheduleDraftReview(definition, facts(referenceDate)) };
}

function classPlacementProfile(patch = {}) {
  return { id: 'class-placement', revision: 3, previewDate: '2026-09-14', definition: {
    name: 'Class placement day', grades: [], classIds: ['math'], classRules: [], testingBlocks: [], ...patch,
  } };
}

async function openClassPlacement(page, workspace, name, { allowPending = false } = {}) {
  if (!allowPending) await workspace.getByRole('region', { name: 'Draft schedule check', exact: true }).getByText('No blocking conflicts on this preview date.', { exact: true }).waitFor();
  await editClass(workspace, name);
  const opener = workspace.getByRole('button', { name: `Class for this time for ${name}`, exact: true, disabled: false });
  await opener.click();
  const picker = page.getByRole('dialog', { name: 'Class for this time', exact: true });
  await picker.waitFor();
  return { picker, opener };
}

async function waitForClassEditorFocus(page, id) {
  await page.waitForFunction(classId => document.querySelector(`[data-class-editor-id="${classId}"]`)?.contains(document.activeElement), id);
}

async function addTestingBlock(dialog, index, teacher) {
    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
  await dialog.getByLabel(`Testing block ${index} name`, { exact: true }).fill(`${teacher[0].toUpperCase()}${teacher.slice(1)} MAP`);
  await dialog.getByLabel(`Testing block ${index} Supervision group`, { exact: true }).selectOption(`${teacher}-group`);
  await dialog.getByLabel(`Testing block ${index} assigned staff`, { exact: true }).selectOption(teacher);
}

test('Class placement swaps full proposed windows atomically, includes both classes, preserves rosters, and Undo restores the draft', { timeout: 120_000 }, async context => {
  const { root, browser, vite, page, catalog, placement, saves, applies, errors } = await createClassPlacementFixture(context);
  try {
    catalog.profiles = [classPlacementProfile({ classRules: [{ classId: 'math', action: 'time', startTime: '08:15', endTime: '08:55' }] })];
    catalog.classes[1].staff.push({ id: 'art-teacher', name: 'Art Teacher' });
    catalog.classes[2].scheduleEnabled = false;
    catalog.classes[3].scheduleRule = { weekdays: [2], startsOn: null, endsOn: null, cycleDay: 'all', periodId: null };
    catalog.inactiveClasses = [{ id: 'archived-class', name: 'Archived Class', gradeLevel: '3', active: false, status: 'inactive',
      scheduleEnabled: false, studentCount: null, staff: [{ id: 'art-teacher', name: 'Art Teacher' }] }];
    const classFacts = structuredClone(catalog.classes), rosters = structuredClone([...placement.rosters]);
    const original = structuredClone(catalog.profiles[0].definition);
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    assert.equal(await workspace.getByRole('button', { name: 'Archived Class', exact: true }).count(), 0, 'Inactive picker references do not become planner rows');
    let { picker } = await openClassPlacement(page, workspace, 'Zinkan Math');
    assert.equal(await picker.getByRole('radio', { name: 'Use Zinkan Math', exact: true }).isChecked(), true);
    assert.equal(await picker.getByRole('button', { name: 'Update draft', exact: true }).isDisabled(), true, 'Keeping the current class is not a mutation');
    assert.equal(await picker.getByRole('radio', { name: 'Use Vatter Science', exact: true }).isDisabled(), true, 'An inactive schedule is not offered as a placement');
    assert.equal(await picker.getByRole('radio', { name: 'Use Art Studio', exact: true }).isDisabled(), true, 'A class without an eligible preview-date meeting cannot be placed');
    assert.equal(await picker.getByRole('radio', { name: 'Use Archived Class', exact: true }).isDisabled(), true, 'Inactive classes remain disabled picker references');
    await picker.getByLabel('Find an existing class', { exact: true }).fill('Burba');
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    assert.match(await picker.innerText(), /12 students/);
    assert.match(await picker.innerText(), /Art Teacher/, 'Candidate metadata includes the co-teacher');
    assert.equal(await picker.getByRole('radio', { name: 'Swap class times', exact: true }).isChecked(), false);
    assert.equal(await picker.getByRole('radio', { name: 'Use selected class; original does not meet', exact: true }).isChecked(), false);
    assert.equal(await picker.getByRole('button', { name: 'Update draft', exact: true }).isDisabled(), true, 'Selecting a class never silently selects a destructive placement mode');
    await picker.getByRole('radio', { name: 'Swap class times', exact: true }).check();
    assert.match(await picker.innerText(), /08:15.*08:55/s);
    assert.match(await picker.innerText(), /11:00.*11:45/s);
    for (const id of ['math', 'reading']) {
      const change = picker.locator(`[data-placement-change="${id}"]`);
      assert.match(await change.innerText(), /12 students/, 'The before-and-after review retains each class roster count even when search hides the original');
      assert.match(await change.innerText(), id === 'math' ? /Zinkan/ : /Burba.*Art Teacher/s);
    }
    const evidence = path.resolve(root, '../soc2-evidence/day-planner-class-placement/browser'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await page.screenshot({ path: path.join(evidence, `class-placement-desktop-${theme}.png`), animations: 'disabled' });
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await picker.getByRole('button', { name: 'Update draft', exact: true }).click();
    await picker.waitFor({ state: 'hidden' }); await waitForClassEditorFocus(page, 'reading');
    assert.equal(await workspace.getByLabel('Burba Reading profile start', { exact: true }).inputValue(), '08:15');
    assert.equal(await workspace.getByLabel('Burba Reading profile end', { exact: true }).inputValue(), '08:55');
    await editClass(workspace, 'Zinkan Math');
    assert.equal(await workspace.getByLabel('Zinkan Math profile start', { exact: true }).inputValue(), '11:00');
    assert.equal(await workspace.getByLabel('Zinkan Math profile end', { exact: true }).inputValue(), '11:45');
    await workspace.getByRole('button', { name: 'Undo last change', exact: true }).click();
    assert.equal(await workspace.getByLabel('Zinkan Math profile start', { exact: true }).inputValue(), '08:15');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.deepEqual(saves[0].definition, original, 'One Undo restores both rules and both class selections');
    ({ picker } = await openClassPlacement(page, workspace, 'Zinkan Math'));
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    await picker.getByRole('radio', { name: 'Swap class times', exact: true }).check();
    await picker.getByRole('button', { name: 'Update draft', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.deepEqual([...saves[1].definition.classIds].sort(), ['math', 'reading']);
    assert.deepEqual([...saves[1].definition.classRules].sort((a, b) => a.classId.localeCompare(b.classId)), [
      { classId: 'math', action: 'time', startTime: '11:00', endTime: '11:45' },
      { classId: 'reading', action: 'time', startTime: '08:15', endTime: '08:55' },
    ]);
    assert.deepEqual(catalog.classes, classFacts, 'Placement does not rewrite class identities or permanent staff assignments');
    assert.deepEqual([...placement.rosters], rosters, 'Both permanent student rosters remain unchanged');
    assert.equal(applies.length, 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Class placement cancellation is a no-op and Move/skip can restore a skipped class with one complete Undo', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, saves, applies, errors } = await createClassPlacementFixture(context);
  try {
    catalog.profiles = [classPlacementProfile({ grades: ['3'], classIds: [], classRules: [{ classId: 'reading', action: 'skip' }] })];
    const original = structuredClone(catalog.profiles[0].definition);
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    let { picker } = await openClassPlacement(page, workspace, 'Zinkan Math');
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    assert.equal(await picker.getByRole('radio', { name: 'Swap class times', exact: true }).isDisabled(), true, 'A skipped class has no proposed window to exchange');
    await picker.getByRole('radio', { name: 'Use selected class; original does not meet', exact: true }).check();
    await picker.getByRole('button', { name: 'Cancel class placement', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Class for this time for Zinkan Math');
    assert.equal(await workspace.getByRole('button', { name: 'Undo last change', exact: true }).isDisabled(), true);
    ({ picker } = await openClassPlacement(page, workspace, 'Zinkan Math'));
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    await page.keyboard.press('Escape'); await picker.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Class for this time for Zinkan Math');
    assert.equal(await workspace.getByRole('button', { name: 'Undo last change', exact: true }).isDisabled(), true);
    ({ picker } = await openClassPlacement(page, workspace, 'Zinkan Math'));
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    await picker.getByRole('radio', { name: 'Use selected class; original does not meet', exact: true }).check();
    await picker.getByRole('button', { name: 'Update draft', exact: true }).click();
    await picker.waitFor({ state: 'hidden' }); await waitForClassEditorFocus(page, 'reading');
    assert.equal(await workspace.getByLabel('Burba Reading profile start', { exact: true }).inputValue(), '08:30');
    assert.equal(await workspace.getByLabel('Burba Reading profile end', { exact: true }).inputValue(), '09:10');
    await editClass(workspace, 'Zinkan Math');
    assert.equal(await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).inputValue(), 'skip');
    assert.equal(await scheduleRow(workspace, 'Zinkan Math').locator('[data-proposed-window]').count(), 0);
    assert.equal(await workspace.getByRole('button', { name: 'Class for this time for Zinkan Math', exact: true }).isDisabled(), true, 'A skipped original class has no destination window');
    await workspace.getByRole('button', { name: 'Undo last change', exact: true }).click();
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.deepEqual(saves[0].definition, original);
    ({ picker } = await openClassPlacement(page, workspace, 'Zinkan Math'));
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    await picker.getByRole('radio', { name: 'Use selected class; original does not meet', exact: true }).check();
    await picker.getByRole('button', { name: 'Update draft', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.deepEqual(saves[1].definition.grades, ['3']);
    assert.deepEqual([...saves[1].definition.classIds].sort(), ['math', 'reading'], 'Both affected IDs are explicit even when their grade already includes them');
    assert.deepEqual([...saves[1].definition.classRules].sort((a, b) => a.classId.localeCompare(b.classId)), [
      { classId: 'math', action: 'skip' }, { classId: 'reading', action: 'time', startTime: '08:30', endTime: '09:10' },
    ]);
    assert.equal(applies.length, 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Class placement searches across hidden grades and preserves focus and readable controls in mobile light and dark themes', { timeout: 120_000 }, async context => {
  const { root, browser, vite, page, catalog, saves, errors } = await createClassPlacementFixture(context);
  try {
    catalog.profiles = [classPlacementProfile()];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    assert.equal(await workspace.getByRole('button', { name: 'List', exact: true }).getAttribute('aria-pressed'), 'true');
    await workspace.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('3');
    const { picker } = await openClassPlacement(page, workspace, 'Zinkan Math');
    await picker.getByLabel('Find an existing class', { exact: true }).fill('Art Teacher');
    const candidate = picker.getByRole('radio', { name: 'Use Art Studio', exact: true });
    assert.equal(await candidate.isEnabled(), true, 'The picker searches real classes outside the display grade filter');
    await candidate.check(); await picker.getByRole('radio', { name: 'Swap class times', exact: true }).check();
    const evidence = path.resolve(root, '../soc2-evidence/day-planner-class-placement/browser'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      const confirm = picker.getByRole('button', { name: 'Update draft', exact: true });
      await confirm.focus(); await confirm.scrollIntoViewIfNeeded();
      const bounds = await confirm.evaluate(element => { const rect = element.getBoundingClientRect(); return { focused: element === document.activeElement, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }; });
      assert.ok(bounds.focused && bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, `The ${theme} mobile dialog keeps its focused action visible: ${JSON.stringify(bounds)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(evidence, `class-placement-mobile-${theme}.png`), animations: 'disabled' });
    }
    await picker.getByRole('button', { name: 'Update draft', exact: true }).press('Enter');
    await picker.waitFor({ state: 'hidden' }); await waitForClassEditorFocus(page, 'art');
    const target = workspace.locator('[data-class-editor-id="art"]');
    assert.equal(await target.isVisible(), true, 'Commit reveals the canonical destination class through the previous grade filter');
    assert.equal(await workspace.getByLabel('Art Studio profile start', { exact: true }).inputValue(), '08:30');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.deepEqual([...saves[0].definition.classIds].sort(), ['art', 'math']);
    assert.equal(saves[0].definition.classRules.length, 2); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Class placement rejects a changed review and an old-school response cannot revive its picker or draft', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, placement, saves, applies, errors } = await createClassPlacementFixture(context);
  let finishRead;
  try {
    catalog.profiles = [classPlacementProfile()];
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await workspace.getByText('No blocking conflicts on this preview date.', { exact: true }).waitFor();
    placement.reviewResponse = async (_body, reviewed) => {
      const updated = structuredClone(reviewed), candidate = updated.classes.find(row => row.classId === 'reading');
      candidate.rosterFingerprint = 'same-size-roster-replacement';
      await new Promise(resolve => { finishRead = resolve; });
      return { json: updated };
    };
    const read = page.waitForRequest(request => request.url().endsWith('/schedule-profiles/draft-review'));
    await workspace.getByRole('button', { name: 'Refresh regular schedule', exact: true }).click(); await read;
    let { picker } = await openClassPlacement(page, workspace, 'Zinkan Math', { allowPending: true });
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    await picker.getByRole('radio', { name: 'Swap class times', exact: true }).check();
    finishRead(); finishRead = null;
    await picker.getByRole('alert').filter({ hasText: 'The schedule changed while this review was open.' }).waitFor();
    assert.equal(await picker.getByRole('button', { name: 'Update draft', exact: true }).isDisabled(), true);
    await picker.getByRole('button', { name: 'Cancel class placement', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
    assert.equal(await workspace.getByRole('button', { name: 'Undo last change', exact: true }).isDisabled(), true);
    const oldSchoolRead = page.waitForRequest(request => request.url().endsWith('/schedule-profiles/draft-review'));
    await workspace.getByRole('button', { name: 'Refresh regular schedule', exact: true }).click(); await oldSchoolRead;
    ({ picker } = await openClassPlacement(page, workspace, 'Zinkan Math', { allowPending: true }));
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    await page.evaluate(() => window.switchFixtureSchool('other-school'));
    await picker.waitFor({ state: 'hidden' }); await workspace.waitFor({ state: 'hidden' });
    finishRead(); finishRead = null; await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('dialog', { name: 'Class for this time', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).count(), 0);
    assert.equal(saves.length, 0); assert.equal(applies.length, 0); assert.deepEqual(errors, []);
  } finally { finishRead?.(); await browser.close(); await vite.close(); }
});

test('After testing partitions the actual roster into class, gap, none, multiple and continuing-testing outcomes without changing assignments', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, placement, projectPlacement, saves, applies, errors } = await createClassPlacementFixture(context);
  try {
    catalog.staff.push({ id: 'proctor', name: 'MAP Proctor' }, { id: 'next-proctor', name: 'Next Proctor' });
    const students = ['returns', 'waits', 'no-later-class', 'ambiguous', 'continues'];
    placement.rosters = new Map([['math', ['returns']], ['reading', ['waits']], ['science', ['ambiguous']], ['art', ['ambiguous']]]);
    Object.assign(catalog.classes[0], { blockStartTime: '10:30', blockEndTime: '11:30' });
    Object.assign(catalog.classes[2], { blockStartTime: '10:30', blockEndTime: '11:30' });
    Object.assign(catalog.classes[3], { blockStartTime: '10:30', blockEndTime: '11:30' });
    catalog.supervisionGroups = [{ id: 'whole-mixed', name: 'Five destinations', staffIds: ['proctor'], studentIds: students }, { id: 'next-test', name: 'Next testing group', staffIds: ['next-proctor'], studentIds: ['continues'] }];
    catalog.profiles = [classPlacementProfile({ classIds: [], testingBlocks: [
      { id: 'source-testing', name: 'Mixed return MAP', coverageGroupId: 'whole-mixed', assignedStaffId: 'proctor', startTime: '09:00', endTime: '10:45' },
      { id: 'continued-testing', name: 'Continuing MAP', coverageGroupId: 'next-test', assignedStaffId: 'next-proctor', startTime: '10:45', endTime: '11:30' },
    ] })];
    const checked = projectPlacement(catalog.profiles[0].definition, '2026-09-14');
    assert.equal(checked.testingBlocks[0].afterTesting.status, 'ready', `Synthetic roster facts must be complete: ${JSON.stringify(checked.issues)}`);
    const frozenRoster = structuredClone(catalog.supervisionGroups);
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await editTesting(workspace, 'Mixed return MAP');
    const after = workspace.getByRole('region', { name: 'After testing for Mixed return MAP', exact: true });
    await page.waitForFunction(() => document.querySelector('[aria-label="After testing for Mixed return MAP"]')?.getAttribute('data-after-testing-status') === 'ready');
    assert.match(await after.innerText(), /5 students in this testing group/);
    for (const kind of ['class', 'gap', 'none', 'multiple', 'continuing_testing']) {
      assert.equal(await after.locator(`[data-after-testing-kind="${kind}"]`).count(), 1);
      assert.match(await after.locator(`[data-after-testing-kind="${kind}"]`).innerText(), /1 student/);
    }
    assert.match(await after.locator('[data-after-testing-kind="class"]').innerText(), /Zinkan Math.*10:45/s);
    assert.match(await after.locator('[data-after-testing-kind="gap"]').innerText(), /Burba Reading.*11:00/s);
    assert.match(await after.locator('[data-after-testing-kind="multiple"]').innerText(), /Art Studio|Vatter Science/);
    assert.match(await after.locator('[data-after-testing-kind="continuing_testing"]').innerText(), /Continuing MAP/);
    placement.unavailableRosters.add('math');
    await workspace.getByRole('button', { name: 'Refresh regular schedule', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="After testing for Mixed return MAP"]')?.getAttribute('data-after-testing-status') === 'unavailable');
    assert.match(await after.innerText(), /After testing is unavailable/);
    assert.doesNotMatch(await after.innerText(), /No later class scheduled|0 students|Zinkan Math.*10:45/);
    assert.deepEqual(catalog.supervisionGroups, frozenRoster);
    assert.equal(saves.length, 0); assert.equal(applies.length, 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('After testing clears stale destinations while checking, ignores an older response, and never treats failure as no later class', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, placement, errors } = await createClassPlacementFixture(context);
  let finishRead;
  try {
    catalog.staff.push({ id: 'proctor', name: 'MAP Proctor' });
    catalog.supervisionGroups = [{ id: 'return-group', name: 'Return group', staffIds: ['proctor'], studentIds: [...placement.rosters.get('math')] }];
    catalog.profiles = [classPlacementProfile({ testingBlocks: [{ id: 'return-testing', name: 'Return MAP', coverageGroupId: 'return-group', assignedStaffId: 'proctor', startTime: '09:15', endTime: '10:45' }] })];
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await editTesting(workspace, 'Return MAP');
    const after = workspace.getByRole('region', { name: 'After testing for Return MAP', exact: true });
    await after.locator('[data-after-testing-kind="gap"]').waitFor();
    assert.match(await after.innerText(), /Burba Reading.*11:00/s);
    placement.reviewResponse = async (body, reviewed) => {
      if (body.definition.testingBlocks[0].endTime !== '10:30') return { json: reviewed };
      await new Promise(resolve => { finishRead = resolve; }); return { json: reviewed };
    };
    const heldRead = page.waitForRequest(request => request.url().endsWith('/schedule-profiles/draft-review') && request.postDataJSON().definition.testingBlocks[0].endTime === '10:30');
    await workspace.getByLabel('Testing block 1 end', { exact: true }).fill('10:30'); await heldRead;
    assert.equal(await after.getAttribute('data-after-testing-status'), 'pending');
    assert.doesNotMatch(await after.innerText(), /Burba Reading|No later class scheduled/);
    await workspace.getByLabel('Testing block 1 end', { exact: true }).fill('12:00');
    await after.locator('[data-after-testing-kind="none"]').waitFor();
    finishRead(); finishRead = null; await page.waitForLoadState('networkidle');
    assert.equal(await after.getAttribute('data-after-testing-status'), 'ready');
    assert.match(await after.innerText(), /No later class scheduled/);
    assert.doesNotMatch(await after.innerText(), /Burba Reading/);
    placement.reviewResponse = () => ({ status: 503, json: { error: 'The roster-aware review is unavailable.' } });
    await workspace.getByLabel('Testing block 1 end', { exact: true }).fill('12:15');
    await workspace.getByText('Could not review this draft schedule.', { exact: true }).waitFor();
    assert.equal(await after.getAttribute('data-after-testing-status'), 'unavailable');
    assert.doesNotMatch(await after.innerText(), /No later class scheduled|0 students/);
    assert.deepEqual(errors, []);
  } finally { finishRead?.(); await browser.close(); await vite.close(); }
});

test('Class placement rules and After testing are reviewed independently on every application date without creating a missing meeting', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, placement, control, projectPlacement, saves, previews, applies, errors } = await createClassPlacementFixture(context);
  try {
    catalog.classes[0].scheduleRule = { weekdays: [1], startsOn: null, endsOn: null, cycleDay: 'all', periodId: null };
    catalog.staff.push({ id: 'proctor', name: 'MAP Proctor' });
    catalog.supervisionGroups = [{ id: 'date-group', name: 'Date-specific group', staffIds: ['proctor'], studentIds: [...placement.rosters.get('math')] }];
    catalog.profiles = [classPlacementProfile({ testingBlocks: [{ id: 'date-testing', name: 'Dated MAP', coverageGroupId: 'date-group', assignedStaffId: 'proctor', startTime: '09:15', endTime: '10:45' }] })];
    control.previewResponse = body => {
      const definition = body.definition || catalog.profiles.find(profile => profile.id === body.profileId).definition;
      const dates = body.dates.map(date => ({ date, reviewed: projectPlacement(definition, date) }));
      const classResults = dates.flatMap(({ date, reviewed }) => definition.classRules.map(rule => {
        const row = reviewed.classes.find(item => item.classId === rule.classId);
        return { date, classId: row.classId, className: row.name, status: row.status !== 'meets' ? 'does_not_meet' : rule.action === 'skip' ? 'skipped' : 'time', ...(row.proposedWindow || {}) };
      }));
      const testingWindows = dates.flatMap(({ date, reviewed }) => reviewed.testingBlocks.map(block => ({ ...block, date,
        afterTesting: { ...block.afterTesting, allocations: block.afterTesting.allocations.map(allocation => date === '2026-09-14' && allocation.classIds.includes('math') ? { ...allocation, classNames: ['Reviewed Monday Math'] } : allocation) },
      })));
      return { json: { previewToken: `date-outcomes-${previews.length}`, schoolTimezone: catalog.schoolTimezone, affectedClasses: 2, blockers: [], changes: [], classResults, testingWindows } };
    };
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    const { picker } = await openClassPlacement(page, workspace, 'Zinkan Math');
    await picker.getByRole('radio', { name: 'Use Burba Reading', exact: true }).check();
    await picker.getByRole('radio', { name: 'Swap class times', exact: true }).check();
    await picker.getByRole('button', { name: 'Update draft', exact: true }).click(); await picker.waitFor({ state: 'hidden' });
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    await workspace.getByRole('button', { name: 'Choose dates & apply', exact: true }).click();
    await workspace.getByRole('button', { name: 'Remove application date 2026-09-08', exact: true }).click();
    for (const date of ['2026-09-14', '2026-09-15']) {
      await workspace.getByLabel('Add an individual date', { exact: true }).fill(date);
      await workspace.getByRole('button', { name: 'Add selected date', exact: true }).click();
    }
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    const preview = workspace.getByRole('region', { name: 'Profile application preview', exact: true }); await preview.waitFor();
    assert.match(await preview.locator('[data-application-class-result="2026-09-14:math"]').innerText(), /Custom time: 11:00–11:45/);
    assert.match(await preview.locator('[data-application-class-result="2026-09-15:math"]').innerText(), /Does not meet on this date/);
    assert.match(await preview.locator('[data-application-class-result="2026-09-15:reading"]').innerText(), /Custom time: 08:30–09:10/);
    const monday = preview.locator('[data-after-testing-date="2026-09-14"]'), tuesday = preview.locator('[data-after-testing-date="2026-09-15"]');
    assert.match(await monday.innerText(), /Gap until Reviewed Monday Math at 11:00/, 'The destination label comes from this exact server review');
    assert.match(await tuesday.innerText(), /No later class scheduled/);
    assert.doesNotMatch(await tuesday.innerText(), /Gap until Zinkan Math/);
    await workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true }).click();
    await workspace.waitFor({ state: 'hidden' });
    assert.equal(saves.length, 1); assert.equal(applies.length, 1);
    assert.deepEqual(applies[0].dates, ['2026-09-14', '2026-09-15']);
    assert.equal(applies[0].previewToken, 'date-outcomes-1');
    assert.equal(catalog.profiles[0].previewDate, '2026-09-14');
    assert.deepEqual(catalog.profiles[0].definition.classRules, saves[0].definition.classRules);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

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
    await workspace.getByLabel('Find a class or teacher', { exact: true }).fill('Zinkan');
    assert.equal(await date.inputValue(), '2026-09-14');
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
    await workspace.getByRole('button', { name: 'Load regular schedule', exact: true }).click();
    assert.equal(await workspace.locator('[data-class-editor-id]').count(), 0, 'Closed row editors have no reachable controls');
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
    assert.equal((await canonicalTestingKeys(workspace)).length, 30, 'Linked grade occurrences do not count as extra testing blocks');
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
    const testingKeys = await canonicalTestingKeys(workspace);
    assert.equal(testingKeys.length, 2);
    await workspace.locator(`[data-schedule-row="${testingKeys[0]}"]`).first().getByRole('button', { name: 'Edit testing block Mixed MAP group', exact: true }).click();
    assert.equal(await workspace.getByLabel('Testing block 1 start').inputValue(), '09:00');
    await workspace.locator(`[data-schedule-row="${testingKeys[1]}"]`).first().getByRole('button', { name: 'Edit testing block Mixed MAP group', exact: true }).click();
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
    await workspace.getByRole('button', { name: 'Add testing groups', exact: true }).first().click();
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
      if (url.pathname === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SCHOOL_HOURS, schoolTimezone: catalog.schoolTimezone } });
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
    await dialog.getByLabel('Grade 3 Reading schedule action').selectOption('skip');
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
      if (url.pathname === '/api/settings') return route.fulfill({ json: { ...DEFAULT_SCHOOL_HOURS, schoolTimezone: catalog.schoolTimezone } });
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
    await editClass(dialog, 'Fixed Math');
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
    await openPlannerIssues(review);
    await review.getByRole('button', { name: 'Resolve issue for class Zinkan Math', exact: true }).first().click();
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).waitFor();
    assert.equal(await workspace.locator('[data-class-editor-id="math"]').evaluate(element => element.contains(document.activeElement)), true, 'Issue navigation clears obstructing display filters and focuses its editor');
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).selectOption('time');
    await workspace.getByLabel('Zinkan Math profile end', { exact: true }).fill('11:30');
    await workspace.getByLabel('Zinkan Math profile start', { exact: true }).fill('10:45');
    await check.getByText('2 conflicts need attention', { exact: true }).waitFor();
    assert.equal(await review.locator('summary').filter({ hasText: /^Schedule issues and overlaps/ }).locator('..').evaluate(element => element.open), true, 'The issue disclosure stays expanded after a pending review resolves');
    await openPlannerIssues(review);
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
      await page.waitForFunction(() => {
        const target = document.activeElement?.getBoundingClientRect(), toolbar = document.querySelector('[data-testid="schedule-profile-workspace"] > header')?.getBoundingClientRect();
        return target && toolbar && target.top >= toolbar.bottom && target.bottom <= innerHeight;
      }, undefined, { timeout: 3000 });
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
    await dialog.getByRole('button', { name: 'Start blank', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
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
    await review.locator('[data-proposed-window="10:20–11:20"]').first().waitFor();
    assert.equal(saves.length, 1);
    await dialog.getByRole('button', { name: /Choose dates & apply/ }).click();
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0, 'A reference-day review never authorizes an application');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
    assert.equal(previews[0].profileId, control.savedProfile.id); assert.equal(previews[0].profileRevision, control.savedProfile.revision); assert.equal(previews[0].revision, catalog.revision);
    await dialog.getByLabel('Preview schedule for', { exact: true }).fill('2026-09-11');
    await review.getByRole('combobox', { name: 'Review grade', exact: true }).selectOption('4');
    assert.equal(await dialog.getByRole('region', { name: 'Profile application preview', exact: true }).count(), 1, 'Actual dates remain clearly labelled beside the profile preview');
    assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 1);
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor();
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
    control.failCatalogRefresh = false;
    await dialog.getByRole('button', { name: 'Add testing groups', exact: true }).first().click();
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

const historyDeleteButton = (page, application) => applicationRow(page, application.id).getByRole('button', { name: `Delete from history ${application.profileName} ${application.dates.join(', ')}`, exact: true });

function completedHistoryFixture(catalog, id = 'completed-history', dates = ['2026-09-04', '2026-09-07']) {
  const profile = deletableProfile();
  const application = appliedSnapshot(profile, id, dates);
  catalog.profiles = [profile]; catalog.applications = [application];
  catalog.testingStatuses = application.testingWindows.map(window => ({ applicationId: id, date: window.date, blockId: window.blockId, status: 'ended' }));
  return { profile, application };
}

async function openHistoryDelete(page, application) {
  await showEarlierApplications(page);
  await historyDeleteButton(page, application).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete from history?', exact: true });
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
    assert.equal((await canonicalTestingKeys(workspace)).length, 2);
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
    const grade = workspace.getByRole('button', { name: /^Grade 3\b/ });
    await grade.click();
    assert.equal(await grade.getAttribute('aria-expanded'), 'false');
    assert.equal(await scheduleRow(workspace, 'Zinkan Math').count(), 0);
    await workspace.getByRole('button', { name: 'List', exact: true }).click();
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    assert.equal(await grade.getAttribute('aria-expanded'), 'false', 'View switching retains the collapsed grade');
    await openPlannerIssues(workspace);
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
    await dialog.waitFor({ state: 'hidden' });
    // Radix closes first; the production close handler restores focus in a RAF.
    await page.waitForFunction(() => document.activeElement?.closest('[data-application-id="cutoff-application"]') && document.activeElement.textContent.trim() === 'Cancel application Old MAP profile');
    assert.equal(await opener.evaluate(button => button === document.activeElement), true); assert.equal(cancellations.length, 0);
    await opener.click();
    control.cancelResponse = () => { catalog.revision++; return { status: 409, json: { error: 'The schedule changed. Refresh status before cancelling.' } }; };
    const confirm = dialog.getByRole('button', { name: 'Cancel all applied dates', exact: true });
    await confirm.evaluate(button => { button.click(); button.click(); });
    await dialog.getByRole('alert').filter({ hasText: 'Scheduling changed.' }).waitFor();
    assert.equal(cancellations.length, 1, 'Repeated confirmations send one mutation');
    assert.equal(cancellations[0].revision, 21); assert.equal(await confirm.isDisabled(), true);
    await dialog.getByRole('button', { name: 'Keep application', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
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
    await dialog.waitFor({ state: 'hidden' });
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
    const previousReceivedAt = await page.evaluate(async () => (await import('/src/lib/queryClient.js')).queryClient.getQueryData(['classpilot-schedule-profiles', 'school']).overviewReceivedAt);
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await request;
    await page.clock.fastForward(6_000);
    finishRead(); finishRead = null; await (await response).finished();
    // Response headers and an old enabled button can precede consuming the body.
    // Do not move performance.now() sixteen hours before the new read is anchored.
    await page.waitForFunction(async previous => {
      const state = (await import('/src/lib/queryClient.js')).queryClient.getQueryState(['classpilot-schedule-profiles', 'school']);
      return state?.fetchStatus === 'idle' && state.data.overviewReceivedAt > previous && state.data.overviewReceivedAt - state.data.overviewRequestStartedAt >= 6_000;
    }, previousReceivedAt);
    await page.getByRole('button', { name: 'Refresh status', exact: true, disabled: false }).waitFor();
    // Let the accepted overview render and its RAF-based clock update commit.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await row.getByRole('button', { name: /^Cancel application/ }).count(), 0, 'Time spent waiting for a response cannot create five extra seconds of cancellation');
    await row.getByText('Cancellation availability could not be checked. Refresh status to try again.', { exact: true }).waitFor();
    control.catalogResponse = null; control.failOverviewRead = true;
    const midnightRead = page.waitForResponse(response => response.url().endsWith('/schedule-profiles') && response.request().method() === 'GET' && response.status() === 503);
    await page.clock.fastForward(16 * 60 * 60 * 1000);
    await midnightRead;
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


test('Back to scheduling keeps the renamed profile opener focused and visible after alphabetical reordering', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, saves, errors } = await createDraftReviewFixture(context);
  try {
    const definition = { name: '', grades: [], classIds: ['math'], classRules: [], testingBlocks: [] };
    catalog.profiles = Array.from({ length: 32 }, (_, index) => ({ id: 'list-profile-' + index, revision: 1, previewDate: '2026-09-14', definition: { ...structuredClone(definition), name: 'Map plan ' + String(index + 1).padStart(2, '0') } }));
    catalog.profiles.push({ id: 'moving-profile', revision: 4, previewDate: '2026-09-14', definition: { ...structuredClone(definition), name: 'Zulu testing plan' } });
    await page.reload(); await page.waitForLoadState('networkidle');
    const originalOpener = profileRow(page, 'moving-profile').getByRole('button', { name: 'Open profile Zulu testing plan', exact: true });
    await originalOpener.scrollIntoViewIfNeeded();
    const initialScroll = await page.evaluate(() => ({ top: window.scrollY, height: window.innerHeight }));
    assert.ok(initialScroll.top > initialScroll.height * 2, 'The originating row begins several screens below the top');
    await originalOpener.click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await workspace.getByRole('button', { name: 'Edit profile', exact: true }).click();
    await workspace.getByLabel('Profile name', { exact: true }).fill('Aardvark testing plan');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await closeSavedReview(workspace);
    const renamedOpener = profileRow(page, 'moving-profile').getByRole('button', { name: 'Open profile Aardvark testing plan', exact: true });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Open profile Aardvark testing plan');
    assert.equal(await page.locator('[data-profile-id]').first().getAttribute('data-profile-id'), 'moving-profile', 'The saved rename moves the originating profile from the final row to the first');
    // Reading the bounds must not scroll the element: focus alone is insufficient
    // if restoring the former scroll offset hides the newly reordered row.
    const bounds = await renamedOpener.evaluate(button => { const rect = button.getBoundingClientRect(); return { focused: button === document.activeElement, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: window.innerWidth, height: window.innerHeight }; });
    assert.equal(bounds.focused, true);
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height && bounds.left >= 0 && bounds.right <= bounds.width, 'The focused originating button remains in the viewport: ' + JSON.stringify(bounds));
    assert.equal(saves.length, 1); assert.equal(saves[0].id, 'moving-profile');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Compact connected timeline aligns linked grades, shades exact overlaps, and edits one shared testing block', { timeout: 120_000 }, async context => {
  const { root, browser, vite, page, catalog, saves, applies, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    Object.assign(catalog.classes[0], { blockStartTime: '08:30', blockEndTime: '09:10' });
    Object.assign(catalog.classes[3], { blockStartTime: '08:50', blockEndTime: '09:20' });
    catalog.profiles = [{ id: 'compact-linked', revision: 4, previewDate: '2026-09-14', definition: {
      name: 'Connected MAP day', grades: [], classIds: ['math'], classRules: [],
      testingBlocks: [{ id: 'mixed-testing', name: 'Shared MAP', coverageGroupId: 'zinkan-group', assignedStaffId: 'zinkan', startTime: '09:00', endTime: '10:45' }],
    } }];
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Connected MAP day', exact: true }).click();
    await workspace.getByRole('region', { name: 'Draft schedule check', exact: true }).getByText(/1 conflict.*need/).waitFor();
    const timeline = workspace.getByRole('region', { name: 'Proposed day timeline', exact: true });
    const linked = workspace.locator('[data-schedule-row="testing:mixed-testing"]');
    const evidence = path.resolve(root, '../soc2-evidence/day-planner/browser'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await page.screenshot({ path: path.join(evidence, `compact-linked-desktop-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    assert.equal(await linked.count(), 2, 'A mixed-grade block has one linked occurrence beside each participating grade');
    assert.deepEqual(await canonicalTestingKeys(workspace), ['testing:mixed-testing']);
    assert.match(await workspace.getByLabel('Whole profile summary').innerText(), /1 testing blocks/);
    const occurrenceKeys = await linked.evaluateAll(rows => rows.map(row => row.getAttribute('data-row-occurrence')));
    assert.ok(occurrenceKeys.every(Boolean));
    assert.equal(new Set(occurrenceKeys).size, 2, 'Linked occurrences have distinct display identities');
    const orderedKeys = await timeline.locator('[data-schedule-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-schedule-row')));
    assert.ok(orderedKeys.indexOf('class:math') < orderedKeys.indexOf('testing:mixed-testing'));
    assert.ok(orderedKeys.indexOf('testing:mixed-testing') < orderedKeys.indexOf('class:art'), 'Grade 3 testing stays beside Grade 3 instead of moving to a trailing testing section');
    assert.ok(orderedKeys.indexOf('class:art') < orderedKeys.lastIndexOf('testing:mixed-testing'));

    const compactRows = await timeline.locator('[data-planner-compact-row]').evaluateAll(rows => rows.map(row => ({ key: row.closest('[data-schedule-row]')?.getAttribute('data-schedule-row'), height: row.getBoundingClientRect().height })));
    assert.equal(compactRows.length, 6);
    assert.ok(compactRows.every(row => row.height >= 52 && row.height <= 64), 'Closed desktop rows remain 52–64 px high: ' + JSON.stringify(compactRows));
    const tracks = await timeline.locator('[data-planner-track]').evaluateAll(rows => rows.map(row => { const bounds = row.getBoundingClientRect(); return { left: bounds.left, right: bounds.right }; }));
    assert.ok(tracks.length >= 6);
    assert.ok(tracks.every(track => Math.abs(track.left - tracks[0].left) <= 1 && Math.abs(track.right - tracks[0].right) <= 1), 'Class and linked testing tracks share exactly the same time-grid origin and width');
    const math = workspace.locator('[data-schedule-row="class:math"]');
    const conflict = math.locator('[data-overlap-interval="09:00–09:10"]');
    const classBar = math.locator('[data-proposed-window="08:30–09:10"]');
    const [conflictBounds, classBounds, testingBounds] = await Promise.all([conflict.boundingBox(), classBar.boundingBox(), linked.first().locator('[data-proposed-window="09:00–10:45"]').boundingBox()]);
    assert.ok(conflictBounds && classBounds && testingBounds);
    assert.ok(Math.abs(conflictBounds.x - testingBounds.x) <= 1, 'The conflict begins at the testing start on the shared time axis');
    assert.ok(Math.abs(conflictBounds.x + conflictBounds.width - classBounds.x - classBounds.width) <= 1, 'The conflict ends exactly at the ordinary class end: ' + JSON.stringify({ conflictBounds, classBounds, testingBounds }));
    assert.ok(Math.abs(conflictBounds.width / classBounds.width - 0.25) <= 0.015, 'Only the overlapping ten minutes of the forty-minute class are shaded');
    assert.equal(await workspace.locator('[data-schedule-row="class:art"] [data-overlap-interval]').count(), 0, 'An allowed student overlap is not painted as a blocking conflict');
    assert.match(await workspace.locator('[data-schedule-row="class:art"]').innerText(), /Allowed overlap/);
    const issueSummary = workspace.locator('summary').filter({ hasText: /^Schedule issues and overlaps/ });
    assert.equal(await issueSummary.locator('..').evaluate(element => element.open), false, 'Long issue details begin collapsed in the compact view');
    await classBar.click({ position: { x: classBounds.width - 3, y: classBounds.height / 2 } });
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).waitFor();
    assert.equal(await workspace.locator('[data-class-editor-id="math"]').evaluate(element => element.contains(document.activeElement)), true, 'Clicking the conflict portion opens its class editor inline');
    await workspace.getByRole('button', { name: 'Close class editor for Zinkan Math', exact: true }).click();

    await linked.last().getByRole('button', { name: 'Edit testing block Shared MAP', exact: true }).click();
    assert.equal(await workspace.locator('[data-block-editor-id]').count(), 1);
    assert.equal(await linked.last().locator('[data-block-editor-id="mixed-testing"]').count(), 1, 'The single editor opens at the clicked Grade 4 occurrence');
    await timeline.evaluate(element => {
      const toolbar = element.closest('[data-testid="schedule-profile-workspace"]').querySelector(':scope > header');
      window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - toolbar.getBoundingClientRect().height + 40 });
    });
    const stickyHeader = await workspace.locator('[data-planner-time-header]').evaluate(element => {
      const header = element.getBoundingClientRect(), toolbar = element.closest('[data-testid="schedule-profile-workspace"]').querySelector(':scope > header').getBoundingClientRect();
      const timeline = element.parentElement.querySelector('[aria-label="Proposed day timeline"]').getBoundingClientRect();
      return { top: header.top, bottom: header.bottom, toolbarBottom: toolbar.bottom, chartBottom: timeline.bottom };
    });
    assert.ok(Math.abs(stickyHeader.top - stickyHeader.toolbarBottom) <= 1 && stickyHeader.chartBottom > stickyHeader.bottom, 'While the chart is in view, the time header stays immediately beneath the sticky toolbar: ' + JSON.stringify(stickyHeader));
    const tickBounds = await workspace.locator('[data-planner-tick="540"]').boundingBox();
    const linkedBarBounds = await linked.first().locator('[data-proposed-window="09:00–10:45"]').boundingBox();
    assert.ok(Math.abs(tickBounds.x + tickBounds.width / 2 - linkedBarBounds.x) <= 1, 'The shared 9 AM header tick aligns with testing even while the header is sticky');
    await workspace.getByLabel('Testing block 1 end', { exact: true }).fill('10:30');
    await workspace.getByLabel('Testing block 1 name', { exact: true }).fill('Shared MAP revised');
    assert.equal(await linked.locator('[data-proposed-window="09:00–10:30"]').count(), 2, 'Editing one occurrence updates every linked bar');
    assert.equal(await scheduleOccurrences(workspace, 'Shared MAP revised').count(), 2);
    assert.deepEqual(await linked.evaluateAll(rows => rows.map(row => row.getAttribute('data-row-occurrence'))), occurrenceKeys, 'Typing preserves occurrence identities');

    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark']) for (const view of ['Timeline', 'List']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await workspace.getByRole('button', { name: view, exact: true }).click();
      if (view === 'Timeline') {
        await timeline.evaluate(element => { element.scrollLeft = 200; });
        await page.waitForFunction(() => {
          const timeline = document.querySelector('[aria-label="Proposed day timeline"]'), header = document.querySelector('[data-planner-time-header]');
          return timeline?.scrollLeft > 0 && Math.abs(timeline.scrollLeft - header?.scrollLeft) <= 1;
        });
        const labelBounds = await linked.last().locator('[data-row-opener]').boundingBox(), viewportBounds = await timeline.boundingBox();
        assert.ok(labelBounds.x >= viewportBounds.x && labelBounds.x + labelBounds.width <= viewportBounds.x + viewportBounds.width, 'Horizontal scrolling preserves visible pinned row labels');
      }
      const input = workspace.getByLabel('Testing block 1 end', { exact: true });
      await input.focus(); await input.scrollIntoViewIfNeeded();
      const bounds = await input.evaluate(element => { const rect = element.getBoundingClientRect(), toolbar = document.querySelector('[data-testid="schedule-profile-workspace"] > header').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, toolbarBottom: toolbar.bottom, width: innerWidth, height: innerHeight }; });
      await page.screenshot({ path: path.join(evidence, `compact-linked-mobile-${view.toLowerCase()}-${theme}.png`), fullPage: true, animations: 'disabled' });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= bounds.toolbarBottom && bounds.bottom <= bounds.height, `${view}/${theme} keeps the focused inline editor in the mobile viewport: ${JSON.stringify(bounds)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await workspace.locator('[data-block-editor-id]').count(), 1);
      await page.screenshot({ path: path.join(evidence, `compact-linked-mobile-${view.toLowerCase()}-${theme}-viewport.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1365, height: 950 });
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    await workspace.getByRole('button', { name: 'Remove testing block 1', exact: true }).click();
    assert.equal(await linked.count(), 0, 'Removing from the second-grade editor removes every occurrence of that block');
    assert.equal(await workspace.locator('[data-block-editor-id]').count(), 0);
    assert.equal(await workspace.getByRole('button', { name: 'Add testing block', exact: true }).evaluate(element => element === document.activeElement), true);
    await workspace.getByRole('button', { name: 'Undo last change', exact: true }).click();
    assert.equal(await linked.count(), 2);
    assert.equal(await linked.locator('[data-proposed-window="09:00–10:30"]').count(), 2);
    assert.equal(await workspace.locator('[data-block-editor-id]').count(), 1, 'Undo restores the one editor as well as the canonical block');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves.length, 1); assert.equal(applies.length, 0);
    assert.deepEqual(saves[0].definition.testingBlocks, [{ id: 'mixed-testing', name: 'Shared MAP revised', coverageGroupId: 'zinkan-group', assignedStaffId: 'zinkan', startTime: '09:00', endTime: '10:30' }]);
    assert.deepEqual(saves[0].definition.classRules, [], 'Visual links and conflict shading do not create class adjustments');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('An asynchronous grade-association change preserves the focused linked editor until it closes', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, saves, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  let releaseReview;
  let reviewHeld;
  const held = new Promise(resolve => { reviewHeld = resolve; });
  try {
    catalog.staff.push({ id: 'proctor', name: 'Available Proctor' });
    catalog.supervisionGroups[0].staffIds = ['proctor'];
    delete catalog.supervisionGroups[0].classParticipation;
    catalog.profiles = [{ id: 'moving-association', revision: 3, previewDate: '2026-09-14', definition: {
      name: 'Association changes', grades: [], classIds: [], classRules: [],
      testingBlocks: [{ id: 'moving-testing', name: 'Moving MAP', coverageGroupId: 'zinkan-group', assignedStaffId: 'proctor', startTime: '09:00', endTime: '10:45' }],
    } }];
    let moved = false;
    control.reviewResponse = async (body, result) => {
      if (body.definition.testingBlocks[0]?.name === 'Renamed across grades' && !moved) {
        await new Promise(resolve => { releaseReview = resolve; reviewHeld(); });
        moved = true;
      }
      result.testingBlocks[0].classParticipation = [{ classId: moved ? 'art' : 'math', count: 2, total: moved ? 24 : 20 }];
      return { json: result };
    };
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Association changes', exact: true }).click();
    await workspace.getByRole('region', { name: 'Draft schedule check', exact: true }).getByText('No blocking conflicts on this preview date.', { exact: true }).waitFor();
    const linked = workspace.locator('[data-schedule-row="testing:moving-testing"]');
    assert.equal(await linked.count(), 1);
    const originalOccurrence = await linked.getAttribute('data-row-occurrence');
    await editTesting(workspace, 'Moving MAP');
    const input = workspace.getByLabel('Testing block 1 name', { exact: true });
    const originalInput = await input.elementHandle();
    const sent = page.waitForRequest(request => request.url().endsWith('/draft-review') && request.postDataJSON().definition.testingBlocks[0]?.name === 'Renamed across grades');
    await input.fill('Renamed across grades'); await sent; await held;
    await workspace.getByRole('region', { name: 'Draft schedule check', exact: true }).getByText('Checking changes…', { exact: true }).waitFor();
    assert.equal(await originalInput.evaluate(element => element.isConnected && element === document.activeElement), true);
    const received = page.waitForResponse(response => response.url().endsWith('/draft-review') && response.request().postDataJSON().definition.testingBlocks[0]?.name === 'Renamed across grades');
    releaseReview(); releaseReview = null; await received;
    await workspace.getByRole('region', { name: 'Draft schedule check', exact: true }).getByText('No blocking conflicts on this preview date.', { exact: true }).waitFor();
    assert.equal(await originalInput.evaluate(element => element.isConnected && element === document.activeElement), true, 'A response relocating the group to another grade must not remount or blur the active editor');
    assert.equal(await input.inputValue(), 'Renamed across grades');
    assert.equal(await workspace.locator('[data-block-editor-id]').count(), 1);
    assert.equal(await workspace.locator('[data-block-editor-id="moving-testing"]').evaluate(element => element.closest('[data-row-occurrence]')?.getAttribute('data-row-occurrence')), originalOccurrence, 'The active occurrence remains pinned until the editor closes');
    await workspace.getByRole('button', { name: 'Close testing editor for Renamed across grades', exact: true }).click();
    assert.equal(await linked.count(), 1, 'Closing removes the obsolete pinned occurrence');
    assert.notEqual(await linked.getAttribute('data-row-occurrence'), originalOccurrence);
    const order = await workspace.locator('[data-schedule-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-schedule-row')));
    assert.ok(order.indexOf('testing:moving-testing') > order.indexOf('class:art'), 'The remaining occurrence belongs beside its newly associated Grade 4 class');
    assert.equal(await linked.locator('[data-row-opener]').evaluate(element => element === document.activeElement), true, 'Closing transfers focus to the current linked row when its old occurrence disappears');
    await editTesting(workspace, 'Renamed across grades');
    assert.equal(await input.inputValue(), 'Renamed across grades');
    await workspace.getByRole('button', { name: 'Save profile', exact: true }).click();
    await workspace.getByText('Profile saved — not applied', { exact: true }).waitFor();
    assert.equal(saves[0].definition.testingBlocks.length, 1);
    assert.equal(saves[0].definition.testingBlocks[0].name, 'Renamed across grades');
    assert.deepEqual(errors, []);
  } finally { releaseReview?.(); await browser.close(); await vite.close(); }
});

test('A newer regular-day projection cannot display an older review as globally conflict-free', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, saves, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  const check = workspace.getByRole('region', { name: 'Draft schedule check', exact: true });
  try {
    catalog.profiles = [{ id: 'review-freshness', revision: 2, previewDate: '2026-09-14', definition: {
      name: 'Fresh regular-day review', grades: [], classIds: [], classRules: [],
      testingBlocks: [{ id: 'later-testing', name: 'Later MAP', coverageGroupId: 'zinkan-group', assignedStaffId: 'zinkan', startTime: '10:00', endTime: '10:45' }],
    } }];
    let capturedReview;
    control.reviewResponse = async (_body, result) => {
      capturedReview ||= structuredClone(result);
      return { json: capturedReview };
    };
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Fresh regular-day review', exact: true }).click();
    await check.getByText('No blocking conflicts on this preview date.', { exact: true }).waitFor();
    assert.equal(capturedReview.revision, 1);
    catalog.revision = 2;
    catalog.classes[0].blockEndTime = '10:30';
    const staleResponse = page.waitForResponse(response => response.url().endsWith('/draft-review'));
    const regularResponse = page.waitForResponse(response => response.url().includes('/regular-schedule?'));
    await workspace.getByRole('button', { name: 'Refresh regular schedule', exact: true }).click();
    assert.equal((await (await regularResponse).json()).revision, 2);
    assert.equal((await (await staleResponse).json()).revision, 1);
    await workspace.locator('[data-schedule-row="class:math"] [data-proposed-window="09:00–10:30"]').waitFor();
    await check.getByText('Could not review this draft schedule.', { exact: true }).waitFor();
    await check.getByText('The schedule comparison changed. Refresh the preview-day check before relying on conflict results.', { exact: true }).waitFor();
    assert.equal(await check.getByText('No blocking conflicts on this preview date.', { exact: true }).count(), 0, 'The global status must not reuse a conflict-free verdict for the superseded regular schedule');
    assert.equal(await workspace.locator('[data-overlap-interval]').count(), 0, 'Until rechecked, fresh clocks have no invented conflict shading');
    control.reviewResponse = null;
    await check.getByRole('button', { name: 'Retry draft review', exact: true }).click();
    await check.getByText('1 conflict needs attention', { exact: true }).waitFor();
    await workspace.locator('[data-schedule-row="class:math"] [data-overlap-interval="10:00–10:30"]').waitFor();
    assert.equal(saves.length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Configured school hours keep exact fixed bounds during time edits and clip outside meetings without hiding their editors', { timeout: 90_000 }, async context => {
  const { root, browser, vite, page, catalog, control, saves, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    control.schoolHours = { enableTrackingHours: true, trackingStartTime: '08:30', trackingEndTime: '15:10' };
    Object.assign(catalog.classes[0], { blockStartTime: '12:00', blockEndTime: '14:00' });
    Object.assign(catalog.classes[1], { blockStartTime: '16:00', blockEndTime: '17:00' });
    Object.assign(catalog.classes[2], { blockStartTime: '06:00', blockEndTime: '07:00' });
    Object.assign(catalog.classes[3], { blockStartTime: '07:45', blockEndTime: '09:15' });
    catalog.profiles = [{ id: 'configured-hours', revision: 2, previewDate: '2026-09-14', definition: {
      name: 'Configured school hours', grades: [], classIds: catalog.classes.map(row => row.id), classRules: [], testingBlocks: [
        { id: 'partial-late', name: 'Partly late testing', coverageGroupId: 'vatter-group', assignedStaffId: 'vatter', startTime: '14:50', endTime: '16:00' },
        { id: 'fully-late', name: 'Fully late testing', coverageGroupId: 'burba-group', assignedStaffId: 'burba', startTime: '16:00', endTime: '17:00' },
      ],
    } }];
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile Configured school hours', exact: true }).click();
    const header = workspace.locator('[data-planner-time-header][data-school-hours-source="configured"]');
    await header.waitFor();
    const assertAxis = async () => {
      assert.equal(await header.getAttribute('data-axis-start'), '510');
      assert.equal(await header.getAttribute('data-axis-end'), '910');
      assert.equal(await header.locator('[data-planner-tick]').first().getAttribute('data-planner-tick'), '510');
      assert.equal(await header.locator('[data-planner-tick]').last().getAttribute('data-planner-tick'), '910');
    };
    await assertAxis();
    assert.match(await header.locator('[data-planner-tick="510"]').innerText(), /8:30 AM/);
    assert.match(await header.locator('[data-planner-tick="910"]').innerText(), /3:10 PM/);
    const evidence = path.resolve(root, '../soc2-evidence/school-hours-planner/browser'); await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'configured-hours-desktop-light.png'), fullPage: true, animations: 'disabled' });

    const earlyPartial = scheduleRow(workspace, 'Art Studio');
    assert.match(await earlyPartial.innerText(), /Outside school hours/);
    assert.match(await earlyPartial.innerText(), /07:45–09:15/);
    const [earlyBar, earlyTrack] = await Promise.all([earlyPartial.locator('[data-proposed-window="07:45–09:15"]').boundingBox(), earlyPartial.locator('[data-planner-track]').boundingBox()]);
    assert.ok(earlyBar && earlyTrack && Math.abs(earlyBar.x - earlyTrack.x) <= 1);
    assert.ok(Math.abs(earlyBar.width / earlyTrack.width - 45 / 400) <= 0.003, 'Only the 45 minutes inside school hours are drawn for the early class');
    await earlyPartial.getByRole('button', { name: 'Change proposed time for Art Studio: 07:45–09:15', exact: true }).click();
    assert.equal(await workspace.getByLabel('Art Studio schedule action', { exact: true }).isEnabled(), true, 'The visible portion of a clipped bar opens its inline editor');
    const latePartial = scheduleRow(workspace, 'Partly late testing');
    assert.match(await latePartial.innerText(), /Outside school hours/);
    const [lateBar, lateTrack] = await Promise.all([latePartial.locator('[data-proposed-window="14:50–16:00"]').boundingBox(), latePartial.locator('[data-planner-track]').boundingBox()]);
    assert.ok(lateBar && lateTrack && Math.abs(lateBar.x + lateBar.width - lateTrack.x - lateTrack.width) <= 1);
    assert.ok(Math.abs(lateBar.width / lateTrack.width - 20 / 400) <= 0.003, 'The late testing block stops precisely at 3:10 PM');
    for (const name of ['Burba Reading', 'Vatter Science', 'Fully late testing']) {
      const row = scheduleRow(workspace, name);
      assert.match(await row.innerText(), /Outside school hours/);
      assert.equal(await row.locator('[data-proposed-window]').count(), 0, `${name} remains visible without a fabricated in-range bar`);
      assert.equal(await row.locator('[data-regular-window]').count(), 0);
    }
    await editClass(workspace, 'Burba Reading');
    await workspace.getByLabel('Burba Reading schedule action', { exact: true }).selectOption('time');
    assert.equal(await workspace.getByLabel('Burba Reading profile start', { exact: true }).inputValue(), '16:00');
    assert.equal(await workspace.getByLabel('Burba Reading profile end', { exact: true }).inputValue(), '17:00');
    await workspace.getByLabel('Burba Reading profile end', { exact: true }).fill('14:00');
    await workspace.getByLabel('Burba Reading profile start', { exact: true }).fill('13:00');
    assert.match(await scheduleRow(workspace, 'Burba Reading').innerText(), /Regular time outside school hours/);
    assert.equal(await scheduleRow(workspace, 'Burba Reading').getByText('Outside school hours', { exact: true }).count(), 0, 'A corrected proposal distinguishes its out-of-hours regular baseline');
    assert.equal(await scheduleRow(workspace, 'Burba Reading').locator('[data-proposed-window="13:00–14:00"]').count(), 1);
    await editTesting(workspace, 'Fully late testing');
    assert.equal(await workspace.getByLabel('Testing block 2 start', { exact: true }).inputValue(), '16:00');
    assert.equal(await workspace.getByLabel('Testing block 2 end', { exact: true }).inputValue(), '17:00');

    await editClass(workspace, 'Zinkan Math');
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).selectOption('time');
    const start = workspace.getByLabel('Zinkan Math profile start', { exact: true });
    await start.fill('01:00');
    await assertAxis();
    assert.match(await scheduleRow(workspace, 'Zinkan Math').innerText(), /Outside school hours/);
    assert.equal(await scheduleRow(workspace, 'Zinkan Math').locator('[data-proposed-window]').getAttribute('data-proposed-window'), '01:00–14:00');
    await start.fill('13:00');
    await assertAxis();
    assert.equal(await scheduleRow(workspace, 'Zinkan Math').locator('[data-proposed-window]').getAttribute('data-proposed-window'), '13:00–14:00');
    assert.doesNotMatch(await scheduleRow(workspace, 'Zinkan Math').innerText(), /Outside school hours/);
    await workspace.getByRole('button', { name: 'List', exact: true }).click();
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    await assertAxis();
    assert.equal(await start.inputValue(), '13:00');
    assert.ok(control.schoolHoursReads.length > 0);
    assert.ok(control.schoolHoursReads.every(read => read.method === 'GET' && read.schoolId === 'school'), 'School-hour reads use the active school context and do not write settings');
    assert.equal(saves.length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Disabled school hours use a labeled default while invalid and overnight hours keep the planner editable in List', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, saves, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    catalog.profiles = [{ id: 'hours-fallback', revision: 2, previewDate: '2026-09-14', definition: { name: 'School hours fallback', grades: [], classIds: ['math'], classRules: [], testingBlocks: [] } }];
    control.schoolHours = { enableTrackingHours: false, trackingStartTime: '22:00', trackingEndTime: '06:00' };
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile School hours fallback', exact: true }).click();
    const defaultHeader = workspace.locator('[data-planner-time-header][data-school-hours-source="default"]');
    await defaultHeader.waitFor();
    assert.equal(await defaultHeader.getAttribute('data-axis-start'), '480');
    assert.equal(await defaultHeader.getAttribute('data-axis-end'), '960');
    const defaultNotice = await workspace.locator('[data-school-hours-notice]').innerText();
    assert.match(defaultNotice, /default/i);
    assert.match(defaultNotice, /0?8:00/);
    assert.match(defaultNotice, /16:00|4:00/);

    for (const settings of [
      { enableTrackingHours: true, trackingStartTime: 'invalid', trackingEndTime: '15:00' },
      { enableTrackingHours: true, trackingStartTime: '22:00', trackingEndTime: '06:00' },
    ]) {
      control.schoolHours = settings;
      await page.reload(); await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'Open profile School hours fallback', exact: true }).click();
      await workspace.getByRole('region', { name: 'Proposed day timetable', exact: true }).waitFor();
      const notice = workspace.locator('[data-school-hours-notice]');
      await notice.waitFor();
      assert.match(await notice.innerText(), /school[- ]hours/i);
      assert.match(await notice.innerText(), /List/i);
      assert.match(await notice.innerText(), /invalid|valid|overnight|same.day|daytime.*unavailable|start.*end|end.*start/i);
      assert.equal(await workspace.locator('[data-planner-time-header]').count(), 0, 'Unavailable configured hours do not silently present the default as school hours');
      const timeline = workspace.getByRole('button', { name: 'Timeline', exact: true });
      if (await timeline.isEnabled()) await timeline.click();
      await workspace.getByRole('region', { name: 'Proposed day timetable', exact: true }).waitFor();
      await editClass(workspace, 'Zinkan Math');
      assert.equal(await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).isEnabled(), true);
      assert.equal(await workspace.getByLabel('Preview schedule for', { exact: true }).inputValue(), '2026-09-14');
    }
    assert.equal(saves.length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('A school-hours read failure offers List and an explicit retry without discarding inline draft changes', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, saves, errors } = await createDraftReviewFixture(context);
  const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
  try {
    catalog.profiles = [{ id: 'hours-retry', revision: 2, previewDate: '2026-09-14', definition: { name: 'School hours retry', grades: [], classIds: ['math'], classRules: [], testingBlocks: [] } }];
    control.failSchoolHours = true;
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Open profile School hours retry', exact: true }).click();
    const retry = workspace.getByRole('button', { name: 'Retry school hours', exact: true });
    await retry.waitFor();
    await workspace.getByRole('region', { name: 'Proposed day timetable', exact: true }).waitFor();
    assert.match(await workspace.locator('[data-school-hours-notice]').innerText(), /school hours/i);
    assert.equal(await workspace.locator('[data-planner-time-header]').count(), 0);
    await editClass(workspace, 'Zinkan Math');
    await workspace.getByLabel('Zinkan Math schedule action', { exact: true }).selectOption('time');
    await workspace.getByLabel('Zinkan Math profile end', { exact: true }).fill('14:00');
    await workspace.getByLabel('Zinkan Math profile start', { exact: true }).fill('13:00');
    const readsBefore = control.schoolHoursReads.length;
    control.failSchoolHours = false;
    control.schoolHours = { enableTrackingHours: true, trackingStartTime: '08:30', trackingEndTime: '15:10' };
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.status() === 200);
    await retry.click(); await loaded;
    await workspace.getByRole('button', { name: 'Timeline', exact: true }).click();
    const header = workspace.locator('[data-planner-time-header][data-school-hours-source="configured"]');
    await header.waitFor();
    assert.equal(await header.getAttribute('data-axis-start'), '510');
    assert.equal(await header.getAttribute('data-axis-end'), '910');
    assert.equal(control.schoolHoursReads.length, readsBefore + 1, 'Retry performs exactly one additional read');
    assert.equal(await workspace.getByLabel('Zinkan Math profile start', { exact: true }).inputValue(), '13:00');
    assert.equal(await workspace.getByLabel('Zinkan Math profile end', { exact: true }).inputValue(), '14:00');
    assert.equal(await workspace.locator('[data-class-editor-id]').count(), 1);
    assert.equal(await retry.count(), 0);
    assert.equal(saves.length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('History deletion confirms every past date, supports mobile keyboard cancellation, and hides only the history entry once', { timeout: 120_000 }, async context => {
  const { root, browser, vite, page, catalog, historyDeletions, deletions, cancellations, saves, applies, errors } = await createDraftReviewFixture(context);
  try {
    const { profile, application } = completedHistoryFixture(catalog); catalog.revision = 19;
    const saved = structuredClone(profile), snapshot = structuredClone(application), statuses = structuredClone(catalog.testingStatuses);
    await page.reload(); await page.waitForLoadState('networkidle');
    await showEarlierApplications(page);
    const opener = historyDeleteButton(page, application);
    await opener.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Delete from history?', exact: true });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Old MAP profile/);
    assert.match(await dialog.innerText(), /September 4, 2026/);
    assert.match(await dialog.innerText(), /September 7, 2026/);
    assert.match(await dialog.innerText(), /reusable profile.*applied schedule records.*student activity reports.*audit records.*preserved/is);
    const keep = dialog.getByRole('button', { name: 'Keep history entry', exact: true });
    const confirm = dialog.getByRole('button', { name: 'Delete from history', exact: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const evidence = path.resolve(root, '../soc2-evidence/schedule-history/browser'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      await page.screenshot({ path: path.join(evidence, `delete-history-mobile-${theme}.png`), fullPage: true, animations: 'disabled' });
      const bounds = await dialog.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y >= 0 && bounds.y + bounds.height <= 845, 'All confirmation content and actions fit a narrow screen: ' + JSON.stringify(bounds));
    }
    await keep.focus(); await page.keyboard.press('Tab');
    assert.equal(await confirm.evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await keep.evaluate(button => button === document.activeElement), true, 'Keyboard focus remains inside the confirmation');
    await page.keyboard.press('Enter'); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent.includes('Delete from history'));
    assert.equal(await opener.evaluate(button => button === document.activeElement), true);
    assert.equal(historyDeletions.length, 0);
    await opener.click();
    await confirm.evaluate(button => { button.click(); button.click(); });
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('History entry deleted. Saved profiles, activity reports, and audit records were preserved.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent.trim() === 'Applied dates');
    assert.deepEqual(historyDeletions, [{ id: application.id, revision: 19, schoolId: 'school' }], 'Double confirmation submits one frozen, explicitly scoped request');
    assert.equal(await applicationRow(page, application.id).count(), 0);
    assert.equal(application.historyHiddenAt, '2026-09-08T12:00:01.000Z');
    const { historyHiddenAt, ...retained } = catalog.applications[0];
    assert.equal(historyHiddenAt, application.historyHiddenAt); assert.deepEqual(retained, snapshot);
    assert.deepEqual(catalog.profiles, [saved]); assert.deepEqual(catalog.testingStatuses, statuses);
    await page.reload(); await page.waitForLoadState('networkidle');
    assert.equal(await applicationRow(page, application.id).count(), 0, 'The hidden entry stays absent after a fresh catalog read');
    await page.getByRole('button', { name: 'Open profile Old MAP profile', exact: true }).click();
    await page.getByRole('region', { name: 'Schedule profile workspace', exact: true }).waitFor();
    assert.deepEqual(catalog.profiles[0], saved, 'The reusable profile remains independently openable');
    assert.equal(deletions.length + cancellations.length + saves.length + applies.length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('History deletion stays unavailable for nonpast dates, unsettled supervision, unknown outcomes, and missing server metadata', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, historyDeletions, errors } = await createDraftReviewFixture(context);
  try {
    const profile = deletableProfile(); catalog.profiles = [profile];
    const cases = [
      ['today', ['2026-09-08'], 'ended'], ['future', ['2026-09-10'], 'ended'], ['mixed-dates', ['2026-09-07', '2026-09-10'], 'ended'],
      ['active', ['2026-09-07'], 'active'], ['pending', ['2026-09-07'], 'pending'], ['releasing', ['2026-09-07'], 'releasing'],
      ['unknown', ['2026-09-07'], 'unknown'], ['missing-permission', ['2026-09-07'], 'ended'], ['missing-check', ['2026-09-07'], 'ended'],
      ['contradictory-permission', ['2026-09-07'], 'ended'], ['coverage-running', ['2026-09-07'], 'ended'], ['already-hidden', ['2026-09-07'], 'ended'],
    ];
    catalog.applications = cases.map(([id, dates]) => appliedSnapshot(profile, id, dates, id === 'already-hidden' ? { historyHiddenAt: '2026-09-08T11:00:00Z' } : {}));
    catalog.testingStatuses = cases.flatMap(([id, dates, status]) => dates.map(date => ({ applicationId: id, date, blockId: 'old-block', status })));
    const summaries = overviewCatalog(catalog).applicationSummaries;
    delete summaries['missing-permission'].historyRemoval;
    delete summaries['missing-check'].historyRemoval.checkedAt;
    summaries['contradictory-permission'].historyRemoval = { canRequest: true, reason: 'unavailable', checkedAt: '2026-09-08T12:00:00Z' };
    summaries['coverage-running'].historyRemoval = { canRequest: false, reason: 'supervision_pending', checkedAt: '2026-09-08T12:00:00Z' };
    catalog.applicationSummaries = summaries;
    await page.reload(); await page.waitForLoadState('networkidle'); await showEarlierApplications(page);
    for (const [id] of cases.filter(([id]) => id !== 'already-hidden')) {
      await applicationRow(page, id).waitFor();
      assert.equal(await applicationRow(page, id).getByRole('button', { name: /^Delete from history/ }).count(), 0, id + ' must not expose a destructive action without affirmative server permission');
    }
    for (const id of ['active', 'pending', 'releasing', 'coverage-running']) await applicationRow(page, id).getByText('History can be removed after all supervision has ended and testing status is settled.', { exact: true }).waitFor();
    for (const id of ['unknown', 'missing-permission', 'missing-check', 'contradictory-permission']) await applicationRow(page, id).getByText('History removal availability could not be confirmed. Refresh status to check again.', { exact: true }).waitFor();
    assert.equal(await applicationRow(page, 'already-hidden').count(), 0);
    assert.equal(catalog.applications.length, cases.length);
    assert.equal(historyDeletions.length, 0); assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('History deletion freezes revisions and requires a fresh confirmation after stale or missing application responses', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, control, historyDeletions, errors } = await createDraftReviewFixture(context);
  try {
    for (const status of [409, 404]) {
      const { application } = completedHistoryFixture(catalog, 'stale-history-' + status); catalog.revision = status;
      await page.reload(); await page.waitForLoadState('networkidle');
      const dialog = await openHistoryDelete(page, application);
      const beforeRequests = historyDeletions.length, beforeReads = control.catalogReads.length;
      control.historyDeleteResponse = () => {
        catalog.revision++;
        if (status === 404) catalog.applications = [];
        return { status, json: { error: status === 409 ? 'Schedules changed. Reload and reopen Delete from history.' : 'Schedule application not found.' } };
      };
      const confirm = dialog.getByRole('button', { name: 'Delete from history', exact: true });
      await confirm.evaluate(button => { button.click(); button.click(); });
      await dialog.getByText('Scheduling changed. Close this confirmation, refresh status, and reopen it before deleting from history.', { exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(await confirm.isDisabled(), true); assert.equal(historyDeletions.length, beforeRequests + 1);
      assert.equal(historyDeletions.at(-1).revision, status, 'The request retains the revision from opening the dialog');
      assert.ok(control.catalogReads.length > beforeReads, 'A rejected confirmation refreshes the authoritative overview');
      assert.equal(application.historyHiddenAt, undefined);
      await dialog.getByRole('button', { name: 'Keep history entry', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await page.waitForLoadState('networkidle');
      assert.equal(historyDeletions.length, beforeRequests + 1, 'Refresh performs no automatic destructive retry');
      control.historyDeleteResponse = null;
      if (status === 409) {
        const reopened = await openHistoryDelete(page, application);
        await reopened.getByRole('button', { name: 'Delete from history', exact: true }).click();
        await reopened.waitFor({ state: 'hidden' });
        assert.equal(historyDeletions.length, beforeRequests + 2);
        assert.equal(historyDeletions.at(-1).revision, status + 1, 'Only an explicitly reopened confirmation captures the fresh revision');
      } else assert.equal(await applicationRow(page, application.id).count(), 0);
      assert.equal(catalog.profiles.length, 1);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('Committed history deletion survives a failed list refresh and retries only the read', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, historyDeletions, errors } = await createDraftReviewFixture(context);
  try {
    const { profile, application } = completedHistoryFixture(catalog); const snapshot = structuredClone(application);
    await page.reload(); await page.waitForLoadState('networkidle');
    const dialog = await openHistoryDelete(page, application); control.failHistoryRefresh = true;
    await dialog.getByRole('button', { name: 'Delete from history', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByText('History entry deleted; list refresh unavailable.', { exact: true }).waitFor();
    assert.equal(await applicationRow(page, application.id).count(), 0, 'The committed hidden timestamp removes the row even before a successful list refresh');
    assert.equal(historyDeletions.length, 1); assert.equal(catalog.applications.length, 1);
    const { historyHiddenAt, ...retained } = catalog.applications[0];
    assert.equal(historyHiddenAt, '2026-09-08T12:00:01.000Z'); assert.deepEqual(retained, snapshot);
    const reads = control.catalogReads.length; control.failHistoryRefresh = false;
    await page.getByRole('button', { name: 'Retry schedule list refresh', exact: true }).click();
    await page.getByText('History entry deleted. Saved profiles, activity reports, and audit records were preserved.', { exact: true }).waitFor();
    assert.ok(control.catalogReads.length > reads); assert.equal(historyDeletions.length, 1);
    assert.equal(await applicationRow(page, application.id).count(), 0);
    await profileRow(page, profile.id).getByRole('button', { name: 'Open profile Old MAP profile', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});

test('A delayed history deletion response cannot alter the new school after a school switch', { timeout: 90_000 }, async context => {
  const { browser, vite, page, catalog, control, historyDeletions, errors } = await createDraftReviewFixture(context);
  let finishDelete;
  try {
    const { application } = completedHistoryFixture(catalog);
    await page.reload(); await page.waitForLoadState('networkidle');
    const dialog = await openHistoryDelete(page, application);
    control.historyDeleteResponse = async () => {
      await new Promise(resolve => { finishDelete = resolve; });
      application.historyHiddenAt = '2026-09-08T12:00:01.000Z';
      return { json: { hidden: true, applicationId: application.id, revision: ++catalog.revision, historyHiddenAt: application.historyHiddenAt } };
    };
    const request = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith('/history'));
    await dialog.getByRole('button', { name: 'Delete from history', exact: true }).click();
    assert.equal((await request).headers()['x-school-id'], 'school');
    await page.evaluate(() => window.switchFixtureSchool('other-school'));
    await dialog.waitFor({ state: 'hidden' });
    finishDelete(); finishDelete = null; await page.waitForLoadState('networkidle');
    await page.getByRole('region', { name: 'Saved profiles', exact: true }).getByText(/No profiles yet/).waitFor();
    assert.equal(historyDeletions.length, 1); assert.equal(control.activeSchool, 'other-school');
    assert.equal(await page.locator('[data-application-id]').count(), 0);
    assert.equal(await page.locator('[data-profile-id]').count(), 0);
    assert.equal(await page.getByText(/History entry deleted|list refresh unavailable/).count(), 0, 'A completed old-school request cannot write a success or refresh-error notice in the new school');
    assert.deepEqual(errors, []);
  } finally { finishDelete?.(); await browser.close(); await vite.close(); }
});

test('Applying onto a date that already has custom schedules needs an explicit acknowledgement', { timeout: 120_000 }, async context => {
  const { browser, vite, page, catalog, control, previews, applies, errors } = await createClassPlacementFixture(context);
  try {
    catalog.profiles = [classPlacementProfile()];
    // A varying token models a genuinely new preview; an identical one would
    // legitimately keep the acknowledgement, because nothing changed.
    control.previewResponse = () => ({ json: { previewToken: `occupied-${previews.length}`, schoolTimezone: catalog.schoolTimezone,
      affectedClasses: 1, blockers: [], changes: [], testingWindows: [],
      warnings: [
        { code: 'SCHEDULE_APPLICATION_ALREADY_APPLIED', message: 'Fall MAP Day 1 is already applied to this date.',
          date: '2026-09-11', applicationId: 'application_existing', profileName: 'Fall MAP Day 1', testingBlockNames: ['MAP Reading'] },
      ] } });
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Choose dates & apply Class placement day', exact: true }).click();
    const workspace = page.getByRole('region', { name: 'Schedule profile workspace', exact: true });
    await workspace.getByLabel('Add an individual date', { exact: true }).fill('2026-09-11');
    await workspace.getByRole('button', { name: 'Add selected date', exact: true }).click();
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    const warning = workspace.getByRole('region', { name: 'Custom schedules already applied', exact: true });
    await warning.waitFor();
    // The weekday is what an administrator recognises, and the existing testing
    // block is named so they can tell which schedule is already there.
    assert.match(await warning.innerText(), /Friday, September 11, 2026/);
    assert.match(await warning.innerText(), /Fall MAP Day 1/);
    assert.match(await warning.innerText(), /MAP Reading/);
    const applyButton = workspace.getByRole('button', { name: 'Apply reviewed dates', exact: true });
    await applyButton.waitFor();
    assert.equal(await applyButton.isDisabled(), true, 'Apply stays blocked until the existing schedules are acknowledged');
    const acknowledgement = warning.getByRole('checkbox');
    await acknowledgement.check();
    assert.equal(await applyButton.isDisabled(), false);
    // Re-previewing must clear the acknowledgement: it is keyed to the token.
    await workspace.getByRole('button', { name: 'Preview application', exact: true }).click();
    await warning.waitFor();
    assert.equal(await warning.getByRole('checkbox').isChecked(), false, 'A fresh preview must be acknowledged again');
    assert.equal(await applyButton.isDisabled(), true);
    await warning.getByRole('checkbox').check();
    await applyButton.click();
    await workspace.waitFor({ state: 'hidden' });
    assert.equal(applies.length, 1);
    assert.equal(applies[0].acknowledgeExistingApplications, true, 'The server re-checks, so the acknowledgement must be sent');
    assert.deepEqual(applies[0].dates, ['2026-09-08', '2026-09-11']);
    assert.ok(previews.length >= 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await vite.close(); }
});
