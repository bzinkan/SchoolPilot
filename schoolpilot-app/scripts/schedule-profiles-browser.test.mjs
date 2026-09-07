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
    let dialog = page.getByRole('dialog');
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
    await dialog.getByRole('button', { name: 'Add testing block', exact: true }).click();
    await dialog.getByLabel('Testing block 1 name', { exact: true }).fill('MAP testing');
    await dialog.getByLabel('Testing block 1 Coverage group', { exact: true }).selectOption('map');
    assert.deepEqual(await dialog.getByLabel('Testing block 1 assigned staff', { exact: true }).locator('option').allTextContents(), ['Choose group staff', 'Ms. Rivera', 'Mr. Lane']);
    await dialog.getByLabel('Testing block 1 assigned staff', { exact: true }).selectOption('rivera');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(saves.length, 1); assert.equal(applies.length, 0);
    assert.deepEqual(saves[0].definition.grades, ['3']); assert.deepEqual(saves[0].definition.classIds, ['science']);
    assert.deepEqual(saves[0].definition.classRules, [{ classId: 'math', action: 'time', startTime: '08:15', endTime: '09:00' }, { classId: 'reading', action: 'skip' }]);
    assert.equal(saves[0].definition.testingBlocks[0].coverageGroupId, 'map'); assert.equal(saves[0].definition.testingBlocks[0].assignedStaffId, 'rivera');

    await page.getByRole('button', { name: 'Duplicate MAP morning', exact: true }).click();
    dialog = page.getByRole('dialog'); await dialog.getByLabel('Profile name', { exact: true }).fill('Early release');
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(saves[1].id, undefined); assert.equal(saves[1].definition.name, 'Early release');
    await page.getByRole('button', { name: 'Apply MAP morning', exact: true }).click(); dialog = page.getByRole('dialog');
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
    await page.getByText('The Coverage group roster changed.', { exact: true }).waitFor();
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

    await page.getByRole('button', { name: 'Edit MAP morning', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByLabel('Profile name', { exact: true }).fill('MAP revised');
    page.once('dialog', prompt => prompt.dismiss()); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(saves[2].id, 'profile-1'); assert.equal(saves[2].profileRevision, 1); assert.equal(catalog.applications[0].profileName, 'MAP morning');
    page.once('dialog', prompt => prompt.accept()); await page.getByRole('button', { name: 'Cancel application MAP morning', exact: true }).click();
    await page.getByRole('region', { name: 'Schedule profile applications' }).getByText('Cancelled', { exact: true }).first().waitFor(); assert.equal(cancellations.length, 1);
    assert.equal(await page.getByText(recoveryHint, { exact: true }).count(), 0);
    catalog.applications.push({ id: 'previous-application', profileId: 'profile-1', profileName: 'Previous testing day', dates: ['2026-09-07'], status: 'scheduled', testingWindows: [] }); config.profileApplications = structuredClone(catalog.applications);
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); await page.getByText('Completed', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cancel application Previous testing day', exact: true }).count(), 0);

    await page.getByRole('button', { name: 'Apply MAP revised', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Preview application', exact: true }).click(); await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).waitFor(); staleApply = true;
    await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: 'Reopen this profile' }).waitFor();
    assert.equal(await dialog.isVisible(), true); assert.equal(await dialog.getByRole('button', { name: 'Apply reviewed dates', exact: true }).count(), 0); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Apply MAP revised', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check(); await dialog.getByLabel('Name for new profile', { exact: true }).fill('MAP afternoon');
    await dialog.getByRole('button', { name: 'Save as new profile', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); assert.equal(saves.at(-1).id, undefined); assert.equal(saves.at(-1).definition.name, 'MAP afternoon');
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(artifactDir, 'profiles-mobile.png'), fullPage: true, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('button', { name: 'Apply MAP afternoon', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    await page.screenshot({ path: path.join(artifactDir, 'application-mobile.png'), animations: 'disabled' });
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
      if (request.method() !== 'GET') mutations.push({ path: url.pathname, body: request.postDataJSON() });
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
    const dialog = page.getByRole('dialog');
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
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(saves[0].definition.classIds.slice().sort(), ['math', 'science']);
    assert.deepEqual(saves[0].definition.classRules, [], 'Keeping every class saves no frozen time or skip overrides');
    assert.equal(JSON.stringify(saves[0]).includes('referenceDate'), false);

    await page.getByRole('button', { name: 'Edit Whole day', exact: true }).click();
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
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(saves[1].definition.classIds.slice().sort(), ['math', 'reading']);
    assert.deepEqual(saves[1].definition.classRules, [{ classId: 'math', action: 'time', startTime: '08:00', endTime: '08:30' }]);
    assert.equal(JSON.stringify(saves[1]).includes('referenceDate'), false);
    await page.getByRole('button', { name: 'Duplicate Whole day', exact: true }).click();
    await dialog.getByRole('columnheader', { name: 'Regular schedule', exact: true }).waitFor();
    assert.equal(await dialog.getByLabel('Fixed Math profile start').inputValue(), '08:00'); await cancel();
    await page.getByRole('button', { name: 'Apply Whole day', exact: true }).click();
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
