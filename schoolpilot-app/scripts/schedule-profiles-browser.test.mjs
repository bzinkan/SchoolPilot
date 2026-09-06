import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test('Schedule Profiles saves drafts, reviews exact dates and temporary testing, and protects unsaved changes', { timeout: 90_000 }, async context => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import {QueryClientProvider} from '@tanstack/react-query';import {queryClient as client} from '/src/lib/queryClient.js';import Scheduling from '/src/products/classpilot/pages/AdminScheduling.jsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(MemoryRouter,null,React.createElement('main',{className:'mx-auto max-w-6xl p-6'},React.createElement(Scheduling)))));`;
  const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'schedule-profile-browser-fixture', configureServer(server) { server.middlewares.use(async (req, res, next) => { if (req.url !== '/__schedule-profiles') return next(); res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__profiles-entry.jsx"></script></body></html>')); }); }, resolveId(id) { if (id === '/__profiles-entry.jsx') return '\0schedule-profiles-entry'; }, load(id) { if (id === '\0schedule-profiles-entry') return entry; } }] });
  await vite.listen();
  let browser;
  context.signal.addEventListener('abort', () => { void browser?.close(); void vite.close(); }, { once: true });
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
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith('/csrf')) return route.fulfill({ json: { csrfToken: 'fixture-token' } });
      if (url.pathname.endsWith('/instructional-calendar')) return route.fulfill({ json: { month: url.searchParams.get('month'), schoolTimezone: catalog.schoolTimezone, schoolLocalToday: catalog.schoolLocalToday, nonInstructionalDates: [], revision: 1, updatedAt: null } });
      if (url.pathname.endsWith('/admin/scheduling/preview')) { advancedPreviews.push(request.postDataJSON()); return route.fulfill({ json: { revision: catalog.revision, previewToken: 'advanced-preview', schoolTimezone: catalog.schoolTimezone, fromDate: catalog.schoolLocalToday, changedOccurrences: 0, blockers: [], changes: [], days: [] } }); }
      if (url.pathname.endsWith('/admin/scheduling')) {
        if (request.method() === 'PUT') { advancedSaves.push(request.postDataJSON()); config = request.postDataJSON().config; catalog.revision++; }
        return route.fulfill({ json: { revision: catalog.revision, config, schoolLocalToday: catalog.schoolLocalToday } });
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
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__schedule-profiles`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Profile name', { exact: true }).fill('MAP morning');
    await dialog.getByRole('button', { name: 'Select grades 1–8', exact: true }).click();
    assert.equal(await dialog.getByLabel('Include Grade 5 Grammar', { exact: true }).isChecked(), true);
    assert.equal(await dialog.getByRole('checkbox', { name: 'Grade 5', exact: true }).count(), 1);
    await dialog.getByRole('button', { name: 'Clear grades', exact: true }).click();
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
    await page.screenshot({ path: path.join(artifactDir, 'review-desktop.png') });
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
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(artifactDir, 'profiles-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('button', { name: 'Apply MAP afternoon', exact: true }).click(); dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Customize this use', exact: true }).check();
    await page.screenshot({ path: path.join(artifactDir, 'application-mobile.png') });
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    page.once('dialog', prompt => prompt.accept()); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await page.getByLabel('School year ends', { exact: true }).fill('2027-06-29');
    await page.getByText('Save or discard the advanced schedule or calendar draft before changing profiles or their applications.', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Create Schedule Profile', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click(); await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).waitFor();
    assert.deepEqual(advancedPreviews[0].config.scheduleProfiles, catalog.profiles); assert.deepEqual(advancedPreviews[0].config.profileApplications, catalog.applications);
    await page.getByRole('button', { name: 'Save reviewed schedule', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="schedule-profiles"] button')?.disabled);
    assert.deepEqual(advancedSaves[0].config.scheduleProfiles, catalog.profiles); assert.deepEqual(advancedSaves[0].config.profileApplications, catalog.applications);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await vite.close(); }
});
