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

async function fixture(context, options = {}) {
  const entry = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter} from 'react-router-dom';
    import {QueryClientProvider} from '@tanstack/react-query';
    import {AuthProvider,useAuth} from '/src/contexts/AuthContext.jsx';
    import {queryClient} from '/src/lib/queryClient.js';
    import Coverage from '/src/products/classpilot/pages/Coverage.jsx';
    import {Toaster} from '/src/components/ui/toaster.jsx';
    import '/src/index.css';
    queryClient.setDefaultOptions({queries:{retry:false,refetchOnWindowFocus:false}});
    window.__coverageTestClient = queryClient;
    function SchoolSwitchBridge() { const {switchSchool,refetchUser} = useAuth(); React.useEffect(() => { window.__switchCoverageSchool = switchSchool; window.__refreshCoverageAuth = refetchUser; }, [switchSchool,refetchUser]); return null; }
    createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:queryClient},React.createElement(AuthProvider,null,React.createElement(MemoryRouter,null,React.createElement(React.Fragment,null,React.createElement(SchoolSwitchBridge),React.createElement(Coverage),React.createElement(Toaster))))));
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
  page.setDefaultNavigationTimeout(30_000);
  const state = { groups: structuredClone(options.groups || []), otherGroups: structuredClone(options.otherGroups || []), assignments: structuredClone(options.assignments || []), otherAssignments: [], writes: [], deletes: [], reads: [], errors: [], membershipMode: 'success', membershipReads: 0, releaseMembership: null, deleteGroupMode: 'success', deletePermissionMode: 'success', releaseDeletion: null, activeSchoolId: 'school', role: options.role || 'school_admin', canManageSupervisionSetup: options.canManageSupervisionSetup ?? true, groupsMode: options.groupsMode || 'success', assignmentsMode: options.assignmentsMode || 'success', releaseGroups: null, releaseAssignments: null };
  state.groupsReadStarted = () => {};
  const assignmentsReadStarted = new Promise(resolve => { state.assignmentsReadStarted = resolve; });
  state.failGroupStudents = false;
  state.categories = structuredClone(options.categories || []);
  state.categoryWrites = [];
  state.categoryMode = 'success';
  state.detailMode = 'success';
  state.groupWriteMode = 'success';
  state.failAssignmentIds = new Set();
  state.holdAssignmentIds = new Set();
  context.after(() => { state.releaseDeletion?.(); state.releaseGroups?.(); state.releaseAssignments?.(); state.releaseAssignmentWrite?.(); state.releaseGroupWrite?.(); });
  const staffPayload = id => ({ id, ...staff.find(person => person.userId === id) });
  const syncGroupStaff = (schoolId, groupId) => {
    const group = (schoolId === 'school' ? state.groups : state.otherGroups).find(item => item.id === groupId);
    if (!group) return;
    const assignments = schoolId === 'school' ? state.assignments : state.otherAssignments;
    group.staff = [...new Set(assignments.filter(assignment => assignment.scopeType === 'coverage_group' && assignment.scopeValue === groupId && assignment.active !== false && (assignment.permissions?.claim || assignment.permissions?.observe)).map(assignment => assignment.staffId))].map(staffPayload);
  };
  const replaceGroupStaff = (schoolId, group, staffIds) => {
    const assignmentKey = schoolId === 'school' ? 'assignments' : 'otherAssignments';
    for (const assignment of state[assignmentKey].filter(item => item.scopeType === 'coverage_group' && item.scopeValue === group.id)) assignment.active = staffIds.includes(assignment.staffId);
    for (const staffId of staffIds) {
      if (!state[assignmentKey].some(item => item.scopeType === 'coverage_group' && item.scopeValue === group.id && item.staffId === staffId)) state[assignmentKey].push({ id: `group-${group.id}-${staffId}`, staffId, staff: staffPayload(staffId), scopeType: 'coverage_group', scopeValue: group.id, scopeLabel: `Supervision Group: ${group.name}`, active: true, permissions: { claim: true } });
    }
    syncGroupStaff(schoolId, group.id);
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const schoolId = request.headers()['x-school-id'] || state.activeSchoolId;
    if (request.method() === 'GET') state.reads.push({ pathname, schoolId, search: new URL(request.url()).search });
    if (pathname.endsWith('/auth/me')) { state.activeSchoolId = schoolId; return route.fulfill({ json: { user: { id: 'admin', email: 'admin@fixture.example' }, activeSchoolId: schoolId, memberships: [{ id: 'membership', schoolId: 'school', role: state.role }, { id: 'other-membership', schoolId: 'other-school', role: state.role }], licenses: { classPilot: true } } }); }
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
    if (pathname.includes('/coverage/supervision-group-categories')) {
      if (request.method() === 'GET') return route.fulfill({ status: state.categoryMode === 'error' ? 503 : 200, json: state.categoryMode === 'error' ? { error: 'Categories are temporarily unavailable.' } : { categories: state.categories.map(category => ({ ...category, groupCount: state.groups.filter(group => group.categoryId === category.id).length })) } });
      const body = request.postDataJSON(), id = pathname.split('/').at(-1);
      state.categoryWrites.push({ method: request.method(), pathname, body, schoolId });
      if (state.categoryMode === 'stale') return route.fulfill({ status: 409, json: { error: 'This category changed. Refresh categories and review it again.', code: 'COVERAGE_CATEGORY_STALE' } });
      if (request.method() === 'DELETE') { const movedGroupCount = state.groups.filter(group => group.categoryId === id).length; state.groups.forEach(group => { if (group.categoryId === id) { group.categoryId = null; group.category = null; } }); state.categories = state.categories.filter(category => category.id !== id); return route.fulfill({ json: { success: true, categoryId: id, movedGroupCount } }); }
      const category = request.method() === 'POST' ? { id: `category-${state.categoryWrites.length}`, ...body, updatedAt: '2026-09-08T13:00:00.000Z' } : state.categories.find(category => category.id === id);
      if (request.method() === 'POST') state.categories.push(category); else Object.assign(category, { name: body.name, updatedAt: '2026-09-08T13:00:00.001Z' });
      return route.fulfill({ json: { category } });
    }
    if (pathname.endsWith('/coverage/supervision-groups/browse')) {
      if (state.groupsMode === 'pending') await new Promise(resolve => { state.releaseGroups = resolve; state.groupsReadStarted?.(); });
      if (state.groupsMode === 'error') return route.fulfill({ status: 503, json: { error: 'Supervision groups are temporarily unavailable.' } });
      const all = (schoolId === 'school' ? state.groups : state.otherGroups).map(group => { const { students: members, ...summary } = group; const gradeCounts = group.gradeCounts || [...new Set((members || []).map(member => students.find(student => student.id === member.studentId)?.gradeLevel ?? null))].map(gradeLevel => ({ gradeLevel, count: (members || []).filter(member => (students.find(student => student.id === member.studentId)?.gradeLevel ?? null) === gradeLevel).length })); return { ...summary, category: state.categories.find(category => category.id === group.categoryId) || null, gradeCounts }; });
      const params = new URL(request.url()).searchParams, search = (params.get('search') || '').toLowerCase(), category = params.get('categoryId'), grade = params.get('grade'), staffId = params.get('staffId'), active = params.get('active');
      const filtered = all.filter(group => (!search || search.split(/\s+/).every(token => [group.name, group.description, ...(group.staff || []).flatMap(person => [person.displayName, person.email])].join(' ').toLowerCase().includes(token))) && (!category || (category === 'uncategorized' ? !group.categoryId : group.categoryId === category)) && (!grade || group.gradeCounts.some(item => String(item.gradeLevel ?? 'ungraded') === grade)) && (!staffId || (staffId === 'unassigned' ? !(group.staff || []).length : (group.staff || []).some(person => person.id === staffId))) && (!active || active === 'all' || String(group.active !== false) === active));
      const totalPages = Math.max(1, Math.ceil(filtered.length / 25)), requested = Number(params.get('page') || 1), pageNumber = Math.max(1, Math.min(requested, totalPages));
      return route.fulfill({ json: { groups: filtered.slice((pageNumber - 1) * 25, pageNumber * 25), page: pageNumber, pageSize: 25, total: filtered.length, totalPages, facets: { categories: state.categories, grades: [...new Set(all.flatMap(group => group.gradeCounts.map(item => item.gradeLevel)))].map(gradeLevel => ({ gradeLevel, count: 1 })), staff: [...new Map(all.flatMap(group => group.staff || []).map(person => [person.id, person])).values()] } } });
    }
    if (/\/coverage\/supervision-groups\/[^/]+$/.test(pathname) && request.method() === 'GET') {
      if (state.detailMode === 'error') return route.fulfill({ status: 503, json: { error: 'This group could not load.' } });
      const group = (schoolId === 'school' ? state.groups : state.otherGroups).find(group => group.id === decodeURIComponent(pathname.split('/').at(-1)));
      return route.fulfill({ json: { group } });
    }
    if (pathname.endsWith('/coverage/supervision-groups') && request.method() === 'GET') {
      if (state.groupsMode === 'pending') await new Promise(resolve => { state.releaseGroups = resolve; state.groupsReadStarted?.(); });
      if (state.groupsMode === 'error') return route.fulfill({ status: 503, json: { error: 'Supervision groups are temporarily unavailable.' } });
      return route.fulfill({ json: { groups: schoolId === 'school' ? state.groups : state.otherGroups } });
    }
    if (pathname.endsWith('/coverage/assignments') && request.method() === 'GET') {
      if (state.assignmentsMode === 'pending') await new Promise(resolve => { state.releaseAssignments = resolve; state.assignmentsReadStarted?.(); });
      if (state.assignmentsMode === 'error') return route.fulfill({ status: 503, json: { error: 'Staff access is temporarily unavailable.' } });
      return route.fulfill({ json: { assignments: schoolId === 'school' ? state.assignments : state.otherAssignments } });
    }
    if (pathname.includes('/coverage/supervision-groups/') && request.method() === 'DELETE') {
      const id = decodeURIComponent(pathname.split('/').at(-1));
      state.deletes.push({ method: request.method(), pathname, schoolId, body: request.postData() ? request.postDataJSON() : null });
      if (state.deleteGroupMode === 'pending') await new Promise(resolve => { state.releaseDeletion = resolve; state.pendingDeletionStarted?.(); });
      if (state.deleteGroupMode === 'blocked') return route.fulfill({ status: 409, json: { code: 'COVERAGE_DELETE_IN_USE', error: 'This group is used by a saved schedule profile. Remove that testing block from the profile before deleting the group.' } });
      if (state.deleteGroupMode === 'error') return route.fulfill({ status: 503, json: { error: 'The group could not be deleted. Try again when the connection is restored.' } });
      const groupKey = schoolId === 'school' ? 'groups' : 'otherGroups';
      const assignmentKey = schoolId === 'school' ? 'assignments' : 'otherAssignments';
      state[groupKey] = state[groupKey].filter(group => group.id !== id);
      state[assignmentKey] = state[assignmentKey].filter(assignment => !(assignment.scopeType === 'coverage_group' && assignment.scopeValue === id));
      return route.fulfill({ json: { deleted: true, groupId: id, deletedAssignments: 1, deletedMembers: 2 } });
    }
    if (pathname.includes('/coverage/assignments/staff/') && request.method() === 'DELETE') {
      const staffId = decodeURIComponent(pathname.split('/').at(-1)), body = request.postDataJSON();
      state.deletes.push({ method: request.method(), pathname, schoolId, body });
      if (state.deletePermissionMode === 'pending') await new Promise(resolve => { state.releaseDeletion = resolve; state.pendingDeletionStarted?.(); });
      if (state.deletePermissionMode === 'blocked') return route.fulfill({ status: 409, json: { code: 'COVERAGE_DELETE_STALE', error: 'These staff permissions changed. Close this dialog, review the current permissions and try again.' } });
      if (state.deletePermissionMode === 'error') return route.fulfill({ status: 503, json: { error: 'Staff permissions could not be removed. Try again.' } });
      const assignmentKey = schoolId === 'school' ? 'assignments' : 'otherAssignments';
      const affectedGroups = state[assignmentKey].filter(assignment => body.assignmentIds.includes(assignment.id) && assignment.scopeType === 'coverage_group').map(assignment => assignment.scopeValue);
      state[assignmentKey] = state[assignmentKey].filter(assignment => !(assignment.staffId === staffId && body.assignmentIds.includes(assignment.id)));
      for (const groupId of affectedGroups) syncGroupStaff(schoolId, groupId);
      return route.fulfill({ json: { deleted: true, staffId, deletedAssignments: body.assignmentIds.length } });
    }
    if (pathname.includes('/coverage/assignments') && ['POST', 'PATCH'].includes(request.method())) {
      const body = request.postDataJSON(), assignmentKey = schoolId === 'school' ? 'assignments' : 'otherAssignments';
      state.writes.push({ method: request.method(), pathname, body, schoolId });
      const assignmentId = pathname.split('/').at(-1);
      if (state.holdAssignmentIds.has(assignmentId)) await new Promise(resolve => { state.releaseAssignmentWrite = resolve; state.assignmentWriteStarted?.(); });
      if (state.failAssignmentIds.has(assignmentId)) return route.fulfill({ status: 503, json: { error: 'A staff permission could not be saved.' } });
      const existing = request.method() === 'PATCH' ? state[assignmentKey].find(assignment => assignment.id === pathname.split('/').at(-1)) : null;
      const previousGroupId = existing?.scopeType === 'coverage_group' ? existing.scopeValue : null;
      const assignment = { ...existing, ...body, id: existing?.id || `permission-${state.writes.length}`, active: body.active ?? existing?.active ?? true };
      assignment.staff = staffPayload(assignment.staffId);
      assignment.scopeLabel = assignment.scopeType === 'coverage_group' ? `Supervision Group: ${(schoolId === 'school' ? state.groups : state.otherGroups).find(group => group.id === assignment.scopeValue)?.name || assignment.scopeValue}` : assignment.scopeValue || 'Schoolwide';
      if (existing) Object.assign(existing, assignment); else state[assignmentKey].push(assignment);
      for (const groupId of [previousGroupId, assignment.scopeType === 'coverage_group' ? assignment.scopeValue : null].filter(Boolean)) syncGroupStaff(schoolId, groupId);
      return route.fulfill({ json: { assignment } });
    }
    if (pathname.includes('/coverage/supervision-groups') && request.method() !== 'GET') {
      const body = request.postDataJSON();
      state.writes.push({ method: request.method(), pathname, body, schoolId });
      if (state.groupWriteMode === 'pending') await new Promise(resolve => { state.releaseGroupWrite = resolve; state.groupWriteStarted?.(); });
      const groupKey = schoolId === 'school' ? 'groups' : 'otherGroups';
      let group = state[groupKey].find(item => item.id === pathname.split('/')[4]);
      if (request.method() === 'POST') {
        group = { id: 'testing', ...body, active: true, students: body.studentIds.map(studentId => ({ studentId })), staff: [], studentCount: body.studentIds.length, updatedAt: '2026-09-08T12:00:00.001Z' };
        state[groupKey].push(group);
        replaceGroupStaff(schoolId, group, body.staffIds);
      } else if (request.method() === 'PATCH') {
        if (state.failGroupStudents) return route.fulfill({ status: 503, json: { error: 'The group could not be saved. No changes were made.' } });
        Object.assign(group, body, { students: body.studentIds.map(studentId => ({ studentId })), studentCount: body.studentIds.length, updatedAt: '2026-09-08T12:00:00.002Z' });
        replaceGroupStaff(schoolId, group, body.staffIds);
        for (const assignment of (schoolId === 'school' ? state.assignments : state.otherAssignments).filter(item => item.scopeType === 'coverage_group' && item.scopeValue === group.id)) assignment.scopeLabel = `Supervision Group: ${group.name}`;
      } else if (pathname.endsWith('/students')) {
        if (state.failGroupStudents) return route.fulfill({ status: 503, json: { error: 'Student membership could not be saved.' } });
        group.students = body.studentIds.map(studentId => ({ studentId }));
        group.studentCount = body.studentIds.length;
      } else if (pathname.endsWith('/staff')) {
        replaceGroupStaff(schoolId, group, body.staffIds);
      }
      return route.fulfill({ json: { group } });
    }
    if (pathname.endsWith('/monitoring-interruptions')) return route.fulfill({ json: { asOf: new Date().toISOString(), lastScannedAt: new Date().toISOString(), scanStatus: 'healthy', counts: { open: 0, last24Hours: 0 } } });
    if (pathname.endsWith('/coverage/capabilities')) return route.fulfill({ json: { canManageSupervisionSetup: state.canManageSupervisionSetup } });
    if (pathname.endsWith('/coverage/summary')) return route.fulfill({ json: { claimedStudentCount: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__coverage-group-test`);
  const dialog = page.getByRole('dialog', { name: 'Create Supervision Group', exact: true });
  if (options.openCreate !== false) {
    await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
    await page.getByRole('button', { name: 'New Group', exact: true }).click();
    await dialog.waitFor();
  } else if (options.groupsMode === 'pending' || options.assignmentsMode === 'pending') {
    if (options.assignmentsMode === 'pending') await assignmentsReadStarted;
  } else await page.waitForLoadState('networkidle');
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
  ]);
  assert.deepEqual([...state.writes[1].body.studentIds].sort(), [...gradeFiveIds.slice(9), 'g6-1'].sort(), 'Only the grade/class/search intersection is cleared; selections outside it remain');
  assert.deepEqual(state.writes[1].body.staffIds, ['staff-12']);
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

const deletionGroup = (id, name) => ({ id, name, description: 'Synthetic supervision setup', active: true, studentCount: 2, students: [{ studentId: 'g5-1' }, { studentId: 'g5-2' }], staff: [{ id: 'staff-1' }], updatedAt: '2026-09-08T12:00:00.000Z' });

test('group deletion confirms the exact version, cancels without writes, retains blockers for retry and refreshes setup after success', { timeout: 90_000 }, async context => {
  const target = deletionGroup('delete-group', 'Testing Group to Delete');
  const survivor = deletionGroup('retained-group', 'Retained Library Group');
  const assignments = [{ id: 'linked-assignment', staffId: 'staff-1', staff: { displayName: 'Linked Group Staff' }, scopeType: 'coverage_group', scopeValue: target.id, scopeLabel: target.name, permissions: { claim: true }, active: true }];
  const { page, state } = await fixture(context, { openCreate: false, groups: [target, survivor], assignments });
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  const opener = page.getByRole('button', { name: `Delete group ${target.name}`, exact: true });
  const confirm = page.getByRole('alertdialog', { name: 'Delete supervision group?', exact: true });
  const artifactDir = path.resolve(root, '..', 'soc2-evidence', 'validation', 'supervision-setup-deletion', 'browser');
  await mkdir(artifactDir, { recursive: true });
  for (const [size, viewport] of [['desktop', { width: 1365, height: 768 }], ['mobile', { width: 390, height: 667 }]]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      await opener.focus(); await page.keyboard.press('Enter'); await confirm.waitFor();
      await confirm.getByText(target.name, { exact: false }).first().waitFor();
      const cancel = confirm.getByRole('button', { name: 'Cancel', exact: true });
      assert.equal(await cancel.evaluate(element => element === document.activeElement), true, 'The non-destructive action receives initial focus');
      const bounds = await confirm.boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1);
      assert.equal(await confirm.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await page.keyboard.press('Tab');
      assert.equal(await confirm.getByRole('button', { name: 'Delete group', exact: true }).evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true);
      await page.keyboard.press('Tab'); assert.equal(await cancel.evaluate(element => element === document.activeElement), true, 'Keyboard focus remains inside the confirmation');
      await page.screenshot({ path: path.join(artifactDir, `delete-group-${size}-${theme}.png`), animations: 'disabled' });
      await page.keyboard.press('Enter'); await confirm.waitFor({ state: 'hidden' });
      await page.waitForFunction(element => element === document.activeElement, await opener.elementHandle());
      assert.equal(await opener.evaluate(element => element === document.activeElement), true, 'Cancel restores focus to the original group');
    }
  }
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.writes, []);
  await page.setViewportSize({ width: 1365, height: 768 });
  state.deleteGroupMode = 'blocked';
  await opener.click(); await confirm.getByRole('button', { name: 'Delete group', exact: true }).click();
  await confirm.getByRole('alert').filter({ hasText: 'Remove that testing block from the profile before deleting the group.' }).waitFor();
  assert.equal(await confirm.isVisible(), true); assert.equal(state.groups.length, 2);
  assert.deepEqual(state.deletes[0], { method: 'DELETE', pathname: '/api/coverage/supervision-groups/delete-group', schoolId: 'school', body: { updatedAt: target.updatedAt } });
  state.deleteGroupMode = 'error';
  await confirm.getByRole('button', { name: 'Retry deletion', exact: true }).click();
  await confirm.getByRole('alert').filter({ hasText: 'Try again when the connection is restored.' }).waitFor();
  assert.equal(await confirm.isVisible(), true); assert.equal(state.groups.length, 2);
  const readsBefore = state.reads.length;
  await page.evaluate(() => {
    window.__coverageTestClient.setQueryData(['classpilot-schedule-profiles', 'school'], { profiles: [{ id: 'fixture-profile' }] });
    window.__coverageTestClient.setQueryData(['classpilot-school-scheduling', 'school'], { revision: 7 });
  });
  state.deleteGroupMode = 'pending';
  const started = new Promise(resolve => { state.pendingDeletionStarted = resolve; });
  await confirm.getByRole('button', { name: 'Retry deletion', exact: true }).click(); await started;
  assert.equal(await confirm.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  assert.equal(await confirm.getByRole('button').evaluateAll(buttons => buttons.every(button => button.disabled)), true, 'Pending deletion prevents repeat submission and dismissal');
  await page.keyboard.press('Escape'); assert.equal(await confirm.isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'New Group', exact: true, includeHidden: true }).isDisabled(), true);
  state.deleteGroupMode = 'success'; state.releaseDeletion(); state.releaseDeletion = null;
  await confirm.waitFor({ state: 'hidden' }); await opener.waitFor({ state: 'hidden' });
  await page.getByText(survivor.name, { exact: true }).waitFor();
  assert.deepEqual(state.groups.map(group => group.id), ['retained-group']);
  assert.deepEqual(state.assignments, []);
  const refreshed = state.reads.slice(readsBefore).map(read => read.pathname);
  assert(refreshed.includes('/api/coverage/supervision-groups/browse') && refreshed.includes('/api/coverage/assignments') && refreshed.includes('/api/coverage/capabilities'));
  assert.deepEqual(await page.evaluate(() => ['classpilot-schedule-profiles', 'classpilot-school-scheduling'].map(key => window.__coverageTestClient.getQueryState([key, 'school'])?.isInvalidated)), [true, true]);
  await page.waitForFunction(element => element === document.activeElement, await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).elementHandle());
  assert.equal(await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.getByRole('tab', { name: 'Staff access', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Staff access', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove permissions for Linked Group Staff', exact: true }).count(), 0, 'The linked permission is absent after opening its own tab');
  assert.equal(state.deletes.length, 3); assert.deepEqual(state.writes, []); assert.deepEqual(state.errors, []);
});

test('removing an orphaned staff permission package sends active and inactive IDs atomically and preserves supervision groups', { timeout: 60_000 }, async context => {
  const group = deletionGroup('preserved-group', 'Preserved Testing Group');
  const orphanAssignments = [
    { id: 'orphan-inactive-claim', staffId: 'orphan-staff', staff: null, scopeType: 'grade', scopeValue: '5', scopeLabel: 'Grade 5', permissions: { claim: true }, active: false },
    { id: 'orphan-inactive-setup', staffId: 'orphan-staff', staff: null, scopeType: 'setup', scopeLabel: 'School setup', permissions: { setup: true }, active: false },
  ];
  const remaining = { id: 'remaining-permission', staffId: 'staff-2', staff: { displayName: 'Remaining Staff' }, scopeType: 'grade', scopeValue: '6', scopeLabel: 'Grade 6', permissions: { claim: true }, active: true };
  const mixedAssignments = [true, false].map((active, index) => ({ id: `mixed-${index}`, staffId: 'staff-3', staff: { displayName: 'Mixed Staff' }, scopeType: 'grade', scopeValue: String(index + 3), permissions: { claim: true }, active }));
  const { page, state } = await fixture(context, { openCreate: false, groups: [group], assignments: [...orphanAssignments, remaining, ...mixedAssignments] });
  await page.getByRole('tab', { name: 'Staff access', exact: true }).click();
  const opener = page.getByRole('button', { name: 'Remove permissions for Unavailable staff member (orphan-staff)', exact: true });
  const confirm = page.getByRole('alertdialog', { name: 'Remove staff permissions?', exact: true });
  assert.equal(await opener.isEnabled(), true, 'Inactive and orphaned packages remain removable without selecting the staff member from the active picker');
  const artifactDir = path.resolve(root, '..', 'soc2-evidence', 'validation', 'supervision-setup-deletion', 'browser');
  await mkdir(artifactDir, { recursive: true });
  for (const [size, viewport] of [['desktop', { width: 1365, height: 768 }], ['mobile', { width: 390, height: 667 }]]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      await opener.focus(); await page.keyboard.press('Enter'); await confirm.waitFor();
      assert.equal(await confirm.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await confirm.getByRole('button', { name: 'Remove permissions', exact: true }).evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true);
      const bounds = await confirm.boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1);
      assert.equal(await confirm.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await page.screenshot({ path: path.join(artifactDir, `remove-permissions-${size}-${theme}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape'); await confirm.waitFor({ state: 'hidden' });
      await page.waitForFunction(element => element === document.activeElement, await opener.elementHandle());
      assert.equal(await opener.evaluate(element => element === document.activeElement), true);
    }
  }
  assert.deepEqual(state.deletes, []);
  await page.setViewportSize({ width: 1365, height: 768 });
  state.deletePermissionMode = 'error';
  await opener.click(); await confirm.getByRole('button', { name: 'Remove permissions', exact: true }).click();
  await confirm.getByRole('alert').filter({ hasText: 'Staff permissions could not be removed. Try again.' }).waitFor();
  assert.equal(await confirm.isVisible(), true); assert.equal(state.assignments.length, 5);
  assert.deepEqual(state.deletes[0].body.assignmentIds.slice().sort(), orphanAssignments.map(assignment => assignment.id).sort());
  assert.equal(state.deletes[0].schoolId, 'school');
  state.deletePermissionMode = 'success';
  await confirm.getByRole('button', { name: 'Retry removal', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' }); await opener.waitFor({ state: 'hidden' });
  await page.waitForFunction(element => element === document.activeElement, await page.getByRole('tab', { name: 'Staff access', exact: true }).elementHandle());
  assert.equal(await page.getByRole('tab', { name: 'Staff access', exact: true }).evaluate(element => element === document.activeElement), true, 'Permission removal returns focus to Staff access');
  await page.getByRole('button', { name: 'Remove permissions for Remaining Staff', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove permissions for Mixed Staff', exact: true }).click();
  await confirm.getByRole('button', { name: 'Remove permissions', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.deepEqual(state.deletes.at(-1).body.assignmentIds.slice().sort(), mixedAssignments.map(assignment => assignment.id).sort(), 'A mixed package sends both active and inactive rows in one request');
  assert.deepEqual(state.assignments.map(assignment => assignment.id), [remaining.id]);
  assert.deepEqual(state.groups, [group], 'Removing permissions must not delete groups, student membership or saved group staff');
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  await page.getByText(group.name, { exact: true }).waitFor();
  assert.equal(state.deletes.length, 3);
  assert.equal(state.deletes.slice(0, 2).every(request => request.pathname === '/api/coverage/assignments/staff/orphan-staff'), true, 'Each attempt is one exact package deletion, not multiple row writes');
  assert.deepEqual(state.writes, []); assert.deepEqual(state.errors, []);
});

test('switching school during deletion ignores the prior-school completion and never changes the new school setup', { timeout: 60_000 }, async context => {
  const oldGroup = deletionGroup('prior-group', 'Prior School Group');
  const otherGroup = deletionGroup('other-group', 'Other School Group');
  const { page, state } = await fixture(context, { openCreate: false, groups: [oldGroup], otherGroups: [otherGroup] });
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  await page.getByRole('button', { name: `Delete group ${oldGroup.name}`, exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete supervision group?', exact: true });
  state.deleteGroupMode = 'pending';
  const started = new Promise(resolve => { state.pendingDeletionStarted = resolve; });
  await confirm.getByRole('button', { name: 'Delete group', exact: true }).click(); await started;
  assert.equal(state.deletes[0].schoolId, 'school');
  await page.evaluate(() => window.__switchCoverageSchool('other-school'));
  await confirm.waitFor({ state: 'hidden' });
  await page.getByText(otherGroup.name, { exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  const readsBeforeCompletion = state.reads.filter(read => read.schoolId === 'other-school' && read.pathname.includes('/coverage/')).length;
  state.deleteGroupMode = 'success'; state.releaseDeletion(); state.releaseDeletion = null;
  await page.waitForLoadState('networkidle');
  assert.deepEqual(state.otherGroups, [otherGroup]);
  assert.equal(await page.getByRole('button', { name: `Delete group ${otherGroup.name}`, exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.equal(state.reads.filter(read => read.schoolId === 'other-school' && read.pathname.includes('/coverage/')).length, readsBeforeCompletion, 'A late prior-school result cannot invalidate or refetch the new school cache');
  assert.equal(await page.getByText(/group deleted|permissions removed/i).count(), 0, 'A prior-school completion must not display a misleading success notice in the new school');
  assert.deepEqual(state.errors, []);
});

test('deletion controls are administrator-only even when a teacher has delegated supervision setup', { timeout: 60_000 }, async context => {
  const group = deletionGroup('delegated-group', 'Delegated Setup Group');
  const { page, state } = await fixture(context, { openCreate: false, role: 'teacher', canManageSupervisionSetup: true, groups: [group] });
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  await page.getByText(group.name, { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New Group', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('tab', { name: 'Staff access', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Delete group / }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Remove permissions for / }).count(), 0);
  assert.equal(state.reads.some(read => read.pathname === '/api/coverage/assignments'), false);
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.writes, []); assert.deepEqual(state.errors, []);
});

test('setup tabs show assigned names, preserve group search, and remain accessible in both themes and viewport sizes', { timeout: 90_000 }, async context => {
  const named = { ...deletionGroup('named', 'Reading Room Testing'), description: 'Morning assessment group', staff: [
    { id: 'named-staff', displayName: 'Dr. Alexandra Morgan-James' },
    { id: 'named-staff', displayName: 'Dr. Alexandra Morgan-James' },
    { id: 'email-staff', displayName: 'email-staff', email: 'long.supervision.staff.label@fixture.example' },
    { id: 'unavailable-staff', displayName: 'unavailable-staff' },
  ] };
  const unstaffed = { ...deletionGroup('unstaffed', 'Library Practice'), staff: [] };
  const oneStaff = { ...deletionGroup('single', 'Math Testing'), active: false, staff: [{ id: 'single-staff', displayName: 'Ms. Single' }] };
  const assignment = { id: 'permission', staffId: 'staff-1', staff: { displayName: 'Staff 1' }, scopeType: 'grade', scopeValue: '5', scopeLabel: 'Roster Grade: 5', permissions: { claim: true }, active: true };
  const { page, state } = await fixture(context, { openCreate: false, groups: [named, unstaffed, oneStaff], assignments: [assignment] });
  const groupsTab = page.getByRole('tab', { name: 'Supervision Groups', exact: true });
  const accessTab = page.getByRole('tab', { name: 'Staff access', exact: true });
  assert.equal(await page.getByRole('tab', { name: 'Claimed', exact: true }).getAttribute('aria-selected'), 'true', 'The existing landing tab remains Claimed');
  await groupsTab.click();
  const groupsPanel = page.getByRole('tabpanel', { name: 'Supervision Groups', exact: true });
  const search = groupsPanel.getByRole('textbox', { name: 'Search supervision groups', exact: true });
  assert.equal(await groupsPanel.getByLabel('Filter group status', { exact: true }).inputValue(), 'true');
  await groupsPanel.getByLabel('Filter group status', { exact: true }).selectOption('all');
  const names = await groupsPanel.getByTestId('supervision-group-named').locator('p').filter({ hasText: /^Assigned staff:/ }).innerText();
  assert.equal(names.match(/Dr\. Alexandra Morgan-James/g)?.length, 1, 'Duplicate records for one staff ID are displayed once');
  assert(names.includes('long.supervision.staff.label@fixture.example'), 'Email replaces missing or ID-only names');
  assert(names.includes('Unavailable staff member'));
  assert(!names.includes('unavailable-staff'), 'Missing names do not expose an internal staff ID');
  await groupsPanel.getByTestId('supervision-group-unstaffed').getByText('Assigned staff: No staff assigned', { exact: true }).waitFor();
  await groupsPanel.getByTestId('supervision-group-single').getByText('Assigned staff: Ms. Single', { exact: true }).waitFor();
  await groupsPanel.getByTestId('supervision-group-single').getByText('Disabled', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Give Staff Access', exact: true }).count(), 0, 'Permission controls are absent from the group tab');

  await search.fill('Morning assessment');
  await groupsPanel.getByText('Showing 1–1 of 1 groups', { exact: true }).waitFor();
  assert.equal(await groupsPanel.locator('[data-testid^="supervision-group-"]').count(), 1, 'Existing description search still filters groups');
  await groupsTab.focus(); await page.keyboard.press('ArrowRight');
  await page.getByRole('tabpanel', { name: 'Staff access', exact: true }).waitFor();
  assert.equal(await accessTab.evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true);
  assert.equal(await page.getByRole('button', { name: 'New Group', exact: true }).count(), 0, 'The inactive group panel is excluded from accessible navigation');
  assert.equal(await page.getByRole('textbox', { name: 'Search supervision groups', exact: true }).count(), 0);
  await page.keyboard.press('ArrowLeft');
  await groupsPanel.waitFor();
  assert.equal(await search.inputValue(), 'Morning assessment', 'Switching tabs retains the group filter');
  await search.fill('');

  const artifactDir = path.resolve(root, '..', 'soc2-evidence', 'validation', 'supervision-setup-tabs', 'browser');
  await mkdir(artifactDir, { recursive: true });
  for (const [size, viewport] of [['desktop', { width: 1365, height: 768 }], ['mobile', { width: 390, height: 667 }]]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      for (const [label, tab] of [['groups', groupsTab], ['staff-access', accessTab]]) {
        await tab.click();
        const panel = page.getByRole('tabpanel', { name: label === 'groups' ? 'Supervision Groups' : 'Staff access', exact: true });
        await panel.waitFor();
        if (label === 'groups') await panel.getByTestId('supervision-group-named').waitFor();
        assert.equal(await page.getByRole('tabpanel').count(), 1, `${label}/${size}/${theme}: only the selected panel is accessible`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}/${size}/${theme}: page has no horizontal overflow`);
        assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true, `${label}/${size}/${theme}: rows and actions stay inside the panel`);
        await page.screenshot({ path: path.join(artifactDir, `${label}-${size}-${theme}.png`), fullPage: true, animations: 'disabled' });
      }
    }
  }
  assert.deepEqual(state.writes, []); assert.deepEqual(state.deletes, []); assert.deepEqual(state.errors, []);
});

test('group edits and staff access changes refresh the other tab and keep group membership intact', { timeout: 90_000 }, async context => {
  const group = { ...deletionGroup('paired', 'Paired Testing'), staff: [{ id: 'staff-1', displayName: 'Staff 1' }] };
  const assignments = [{ id: 'paired-staff-1', staffId: 'staff-1', staff: { displayName: 'Staff 1' }, scopeType: 'coverage_group', scopeValue: group.id, scopeLabel: `Supervision Group: ${group.name}`, permissions: { claim: true }, active: true }];
  const { page, state } = await fixture(context, { openCreate: false, groups: [group], assignments });
  const groupsTab = page.getByRole('tab', { name: 'Supervision Groups', exact: true });
  const accessTab = page.getByRole('tab', { name: 'Staff access', exact: true });
  const groupRow = page.getByTestId('supervision-group-paired');
  await groupsTab.click();
  await groupRow.getByRole('button', { name: 'Edit', exact: true }).click();
  const groupEditor = page.getByRole('dialog', { name: 'Edit Supervision Group', exact: true });
  await groupEditor.getByPlaceholder('Search staff by name, email, or role').fill('Staff 2');
  await groupEditor.getByRole('checkbox', { name: /Staff 2/ }).check();
  await groupEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await groupEditor.waitFor({ state: 'hidden' });
  await groupRow.getByText('Assigned staff: Staff 1, Staff 2', { exact: true }).waitFor();
  await accessTab.click();
  const staffTwo = page.getByTestId('staff-permissions-staff-2');
  await staffTwo.getByText(`Supervision Group: ${group.name}`, { exact: true }).waitFor();
  await staffTwo.getByRole('button', { name: 'Edit', exact: true }).click();
  const accessEditor = page.getByRole('dialog', { name: 'Edit Staff Access', exact: true });
  await accessEditor.getByRole('checkbox', { name: 'Active permission', exact: true }).uncheck();
  await accessEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await accessEditor.waitFor({ state: 'hidden' });
  await staffTwo.getByText('Disabled', { exact: true }).waitFor();
  await groupsTab.click();
  await groupRow.getByText('Assigned staff: Staff 1', { exact: true }).waitFor();
  await accessTab.click();
  await page.getByTestId('staff-permissions-staff-1').getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByTestId('staff-permissions-staff-1').getByText('Disabled', { exact: true }).waitFor();
  await groupsTab.click();
  await groupRow.getByText('Assigned staff: No staff assigned', { exact: true }).waitFor();
  await accessTab.click();
  await staffTwo.getByRole('button', { name: 'Edit', exact: true }).click();
  await accessEditor.getByRole('checkbox', { name: 'Active permission', exact: true }).check();
  await accessEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await accessEditor.waitFor({ state: 'hidden' });
  await groupsTab.click();
  await groupRow.getByText('Assigned staff: Staff 2', { exact: true }).waitFor();
  await accessTab.click();
  await staffTwo.getByRole('button', { name: 'Remove permissions for Staff 2', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove staff permissions?', exact: true });
  await confirm.getByRole('button', { name: 'Remove permissions', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await page.getByRole('tabpanel', { name: 'Staff access', exact: true }).getByRole('status').filter({ hasText: 'Supervision permissions for Staff 2 removed.' }).waitFor();
  await groupsTab.click();
  await groupRow.getByText('Assigned staff: No staff assigned', { exact: true }).waitFor();
  await groupRow.getByText(/^2 students ·/).waitFor();
  assert.equal(await page.getByText('Supervision permissions for Staff 2 removed.', { exact: true }).count(), 0, 'A permission removal notice belongs to Staff access');
  assert.deepEqual(state.groups[0].students, group.students);
  assert.deepEqual(state.writes.map(write => write.method), ['PATCH', 'PATCH', 'PATCH', 'PATCH']);
  assert.equal(state.deletes.length, 1); assert.deepEqual(state.errors, []);
});

test('setup loading and errors stay in the relevant tab and Refresh recovers without hiding cached rows', { timeout: 90_000 }, async context => {
  const group = deletionGroup('loadable', 'Loadable Testing');
  const assignment = { id: 'loadable-access', staffId: 'staff-1', staff: { displayName: 'Staff 1' }, scopeType: 'grade', scopeValue: '5', permissions: { claim: true }, active: true };
  const { page, state } = await fixture(context, { openCreate: false, groups: [group], assignments: [assignment], groupsMode: 'pending', assignmentsMode: 'pending' });
  const groupsTab = page.getByRole('tab', { name: 'Supervision Groups', exact: true });
  const accessTab = page.getByRole('tab', { name: 'Staff access', exact: true });
  const groupsPanel = page.getByRole('tabpanel', { name: 'Supervision Groups', exact: true });
  const accessPanel = page.getByRole('tabpanel', { name: 'Staff access', exact: true });
  await groupsTab.click();
  await groupsPanel.getByText('Loading supervision groups…', { exact: true }).waitFor();
  assert.equal(await groupsPanel.getByText('No supervision groups', { exact: true }).count(), 0);
  await accessTab.click();
  await accessPanel.getByText('Loading staff access…', { exact: true }).waitFor();
  assert.equal(await accessPanel.getByText('No staff permissions yet', { exact: true }).count(), 0);
  state.groupsMode = 'error'; state.releaseGroups(); state.releaseGroups = null;
  state.assignmentsMode = 'error'; state.releaseAssignments(); state.releaseAssignments = null;
  await accessPanel.getByRole('alert').filter({ hasText: 'Staff access could not load.' }).waitFor();
  assert.equal(await accessPanel.getByText(/Supervision groups could not load/).count(), 0);
  await groupsTab.click();
  await groupsPanel.getByRole('alert').filter({ hasText: 'Supervision groups could not load.' }).waitFor();
  assert.equal(await groupsPanel.getByText('No supervision groups', { exact: true }).count(), 0);
  state.groupsMode = 'success';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await groupsPanel.getByText(group.name, { exact: true }).waitFor();
  assert.equal(await groupsPanel.getByRole('alert').count(), 0, 'A staff access failure does not replace the groups view');
  await accessTab.click();
  await accessPanel.getByRole('alert').filter({ hasText: 'Staff access could not load.' }).waitFor();
  state.assignmentsMode = 'success';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await accessPanel.getByTestId('staff-permissions-staff-1').waitFor();
  state.assignmentsMode = 'error';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await accessPanel.getByRole('alert').filter({ hasText: 'Staff access could not load.' }).waitFor();
  assert.equal(await accessPanel.getByTestId('staff-permissions-staff-1').isVisible(), true, 'Previously loaded access remains visible on refetch failure');
  assert.equal(await accessPanel.getByRole('button', { name: 'Remove permissions for Staff 1', exact: true }).isDisabled(), true);
  state.groupsMode = 'error';
  await groupsTab.click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await groupsPanel.getByRole('alert').filter({ hasText: 'Supervision groups could not load.' }).waitFor();
  assert.equal(await groupsPanel.getByText(group.name, { exact: true }).isVisible(), true);
  assert.equal(await groupsPanel.getByRole('button', { name: `Delete group ${group.name}`, exact: true }).isDisabled(), true);
  assert.deepEqual(state.writes, []); assert.deepEqual(state.deletes, []); assert.deepEqual(state.errors, []);
});

test('losing administrator or setup access selects an available tab without exposing staff controls', { timeout: 60_000 }, async context => {
  const group = deletionGroup('role-fallback', 'Delegated Testing');
  const { page, state } = await fixture(context, { openCreate: false, groups: [group] });
  await page.getByRole('tab', { name: 'Staff access', exact: true }).click();
  await page.getByRole('button', { name: 'Give Staff Access', exact: true }).click();
  await page.getByRole('dialog', { name: 'Give Staff Access', exact: true }).waitFor();
  state.role = 'teacher';
  await page.evaluate(() => window.__refreshCoverageAuth());
  await page.getByRole('tabpanel', { name: 'Supervision Groups', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'Revoking administration closes an open staff access editor');
  assert.equal(await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tab', { name: 'Staff access', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Give Staff Access', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'New Group', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create Supervision Group', exact: true }).getByPlaceholder('State testing - 8th grade').fill('Draft retained until access changes');
  state.canManageSupervisionSetup = false;
  await page.evaluate(() => window.__coverageTestClient.invalidateQueries({ queryKey: ['/api/coverage/capabilities', 'school'] }));
  await page.getByRole('tabpanel', { name: 'Claimed', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Claimed', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'New Group', exact: true }).count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0, 'Revoking setup closes an open group editor');
  assert.deepEqual(state.writes, []); assert.deepEqual(state.deletes, []); assert.deepEqual(state.errors, []);
});

test('partial setup saves retain drafts and refresh both views only after outstanding permission writes settle', { timeout: 90_000 }, async context => {
  const group = { ...deletionGroup('partial', 'Original Testing Name'), staff: [{ id: 'staff-1', displayName: 'Staff 1' }] };
  const assignments = [
    { id: 'partial-group', staffId: 'staff-1', staff: { displayName: 'Staff 1' }, scopeType: 'coverage_group', scopeValue: group.id, scopeLabel: `Supervision Group: ${group.name}`, permissions: { claim: true }, active: true },
    { id: 'partial-grade', staffId: 'staff-1', staff: { displayName: 'Staff 1' }, scopeType: 'grade', scopeValue: '5', scopeLabel: 'Grade 5', permissions: { claim: true }, active: true },
  ];
  const { page, state } = await fixture(context, { openCreate: false, groups: [group], assignments });
  const groupsTab = page.getByRole('tab', { name: 'Supervision Groups', exact: true });
  const accessTab = page.getByRole('tab', { name: 'Staff access', exact: true });
  await groupsTab.click();
  await page.getByTestId('supervision-group-partial').getByRole('button', { name: 'Edit', exact: true }).click();
  const groupEditor = page.getByRole('dialog', { name: 'Edit Supervision Group', exact: true });
  await groupEditor.getByPlaceholder('State testing - 8th grade').fill('Partially Updated Testing');
  state.failGroupStudents = true;
  const beforeGroupSave = state.reads.length;
  await groupEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await groupEditor.getByRole('alert').filter({ hasText: 'No changes were made.' }).waitFor();
  assert.equal(await groupEditor.isVisible(), true, 'A failed atomic group save retains the editor');
  assert.equal(await groupEditor.getByPlaceholder('State testing - 8th grade').inputValue(), 'Partially Updated Testing');
  await groupEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('supervision-group-partial').getByText('Original Testing Name', { exact: true }).waitFor();
  await accessTab.click();
  const packageRow = page.getByTestId('staff-permissions-staff-1');
  await packageRow.getByText('Supervision Group: Original Testing Name', { exact: true }).waitFor();
  const groupSaveReads = state.reads.slice(beforeGroupSave).map(read => read.pathname);
  assert(groupSaveReads.includes('/api/coverage/supervision-groups/browse') && groupSaveReads.includes('/api/coverage/assignments'));
  assert.deepEqual(state.groups[0].students, group.students);

  await packageRow.getByRole('button', { name: 'Edit', exact: true }).click();
  const accessEditor = page.getByRole('dialog', { name: 'Edit Staff Access', exact: true });
  await accessEditor.getByRole('checkbox', { name: 'Active permission', exact: true }).uncheck();
  state.failAssignmentIds.add('partial-grade');
  state.holdAssignmentIds.add('partial-group');
  const writeStarted = new Promise(resolve => { state.assignmentWriteStarted = resolve; });
  const beforePermissionSave = state.reads.length;
  await accessEditor.getByRole('button', { name: 'Save', exact: true }).click();
  await writeStarted;
  await accessEditor.getByRole('button', { name: 'Save', exact: true, disabled: true }).waitFor();
  assert.equal(await accessEditor.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'A failed sibling write does not make the still-running save retryable');
  assert.equal(state.reads.slice(beforePermissionSave).some(read => ['/api/coverage/supervision-groups', '/api/coverage/assignments'].includes(read.pathname)), false, 'Lists are not refreshed before the last write finishes');
  state.releaseAssignmentWrite(); state.releaseAssignmentWrite = null;
  await page.getByText('Could not save assignment', { exact: true }).waitFor();
  assert.equal(await accessEditor.isVisible(), true);
  assert.equal(await accessEditor.getByRole('checkbox', { name: 'Active permission', exact: true }).isChecked(), false, 'The unfinished permission draft remains intact');
  await accessEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await groupsTab.click();
  await page.getByTestId('supervision-group-partial').getByText('Assigned staff: No staff assigned', { exact: true }).waitFor();
  await accessTab.click();
  await packageRow.getByText('Active', { exact: true }).waitFor();
  assert.equal(state.assignments.find(assignment => assignment.id === 'partial-grade').active, true);
  assert.equal(state.assignments.find(assignment => assignment.id === 'partial-group').active, false);
  const permissionSaveReads = state.reads.slice(beforePermissionSave).map(read => read.pathname);
  assert(permissionSaveReads.includes('/api/coverage/supervision-groups/browse') && permissionSaveReads.includes('/api/coverage/assignments'));
  assert.deepEqual(state.deletes, []); assert.deepEqual(state.errors, []);
});


test('group directory pages server results and combines category, grade, assigned staff, status and staff-name search without loading rosters', { timeout: 90_000 }, async context => {
  const categories = [{ id: 'testing-category', name: 'Testing', updatedAt: '2026-09-08T12:00:00.000Z' }, { id: 'clubs-category', name: 'Clubs', updatedAt: '2026-09-08T12:00:00.000Z' }];
  const groups = Array.from({ length: 52 }, (_, index) => ({ ...deletionGroup(`directory-${index + 1}`, `Room ${String(index + 1).padStart(2, '0')}`), categoryId: index < 30 ? 'testing-category' : index < 45 ? 'clubs-category' : null, active: index % 3 !== 0, gradeCounts: [{ gradeLevel: index % 2 ? '6' : '5', count: 2 }], staff: index % 4 ? [{ id: 'staff-12', displayName: 'Mr Fixture', email: 'fixture@school.example' }] : [] }));
  const { page, state } = await fixture(context, { openCreate: false, groups, categories });
  const heavyReads = () => state.reads.filter(read => ['/api/admin/users', '/api/admin/teacher-students', '/api/coverage/setup/classes', '/api/coverage/supervision-groups'].includes(read.pathname));
  assert.deepEqual(heavyReads(), [], 'Coverage landing avoids roster-heavy setup reads');
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Supervision Groups', exact: true });
  const rows = panel.locator('[data-testid^="supervision-group-"]');
  await panel.getByText('Showing 1–25 of 34 groups', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Filter group status', { exact: true }).inputValue(), 'true', 'The directory defaults to active groups');
  assert.equal(await panel.getByTestId('supervision-group-directory-1').count(), 0, 'Disabled groups are excluded until requested');
  await panel.getByLabel('Filter group status', { exact: true }).selectOption('all');
  await panel.getByText('Showing 1–25 of 52 groups', { exact: true }).waitFor();
  assert.equal(await rows.count(), 25);
  await panel.getByRole('button', { name: 'Next groups', exact: true }).click();
  await panel.getByText('Showing 26–50 of 52 groups', { exact: true }).waitFor();
  await panel.getByLabel('Filter group category', { exact: true }).selectOption('testing-category');
  await panel.getByText('Showing 1–25 of 30 groups', { exact: true }).waitFor();
  await panel.getByLabel('Filter group grade', { exact: true }).selectOption('5');
  await panel.getByText('Showing 1–15 of 15 groups', { exact: true }).waitFor();
  await panel.getByLabel('Filter assigned staff', { exact: true }).selectOption('staff-12');
  await panel.getByText('Showing 1–7 of 7 groups', { exact: true }).waitFor();
  await panel.getByLabel('Filter group status', { exact: true }).selectOption('false');
  await panel.getByText('Showing 1–2 of 2 groups', { exact: true }).waitFor();
  assert.equal(await rows.count(), 2);
  await page.getByRole('tab', { name: 'Staff access', exact: true }).click();
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  assert.equal(await panel.getByLabel('Filter group category', { exact: true }).inputValue(), 'testing-category');
  assert.equal(await panel.getByLabel('Filter group status', { exact: true }).inputValue(), 'false');
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await panel.getByLabel('Filter group status', { exact: true }).inputValue(), 'true', 'Clear filters restores active groups');
  await panel.getByLabel('Filter group status', { exact: true }).selectOption('all');
  await panel.getByRole('textbox', { name: 'Search supervision groups', exact: true }).fill('Mr Fixture');
  await panel.getByText('Showing 1–25 of 39 groups', { exact: true }).waitFor();
  assert.equal(state.reads.some(read => read.pathname.endsWith('/browse') && new URLSearchParams(read.search).get('search') === 'Mr Fixture'), true, 'Staff search is sent to the server and reaches beyond the current page');
  await panel.getByRole('textbox', { name: 'Search supervision groups', exact: true }).fill('No matching room');
  await panel.getByText('No supervision groups match these filters.', { exact: true }).waitFor();
  assert.deepEqual(heavyReads(), [], 'Directory filtering does not load group members, students, classes or the full group list');
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await panel.getByLabel('Filter group status', { exact: true }).selectOption('all');
  await panel.getByRole('button', { name: 'Next groups', exact: true }).click();
  await panel.getByRole('button', { name: 'Next groups', exact: true }).click();
  await panel.getByText('Showing 51–52 of 52 groups', { exact: true }).waitFor();
  // Clear applies search immediately. Its former 300ms debounce must not reset later pagination.
  await page.waitForTimeout(350);
  await panel.getByText('Showing 51–52 of 52 groups', { exact: true }).waitFor();
  for (const [name, showing] of [['Room 52', 'Showing 51–51 of 51 groups'], ['Room 51', 'Showing 26–50 of 50 groups']]) {
    await panel.getByRole('button', { name: `Delete group ${name}`, exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete supervision group?', exact: true });
    await confirm.getByRole('button', { name: 'Delete group', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    await panel.getByText(showing, { exact: true }).waitFor();
  }
  assert.equal(await panel.getByLabel('Filter group status', { exact: true }).inputValue(), 'all', 'Deleting the final row on a page preserves filters while returning to a populated page');
  state.groups.push(deletionGroup('later-51', 'Later Room 51'), deletionGroup('later-52', 'Later Room 52'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.getByText('Showing 26–50 of 52 groups', { exact: true }).waitFor();
  assert.equal(new URLSearchParams(state.reads.filter(read => read.pathname.endsWith('/browse')).at(-1).search).get('page'), '2', 'New matching groups do not restore the page removed by the earlier deletion');
  state.groups.splice(25);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.getByText('Showing 1–25 of 25 groups', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Next groups', exact: true }).isDisabled(), true, 'A shortened directory clamps a formerly valid last page');
  assert.deepEqual(state.errors, []);
});

test('school categories create, rename and delete with reviewable consequences; group category saves atomically and refresh failure never resubmits', { timeout: 90_000 }, async context => {
  const { page, state } = await fixture(context, { openCreate: false });
  await page.getByRole('tab', { name: 'Supervision Groups', exact: true }).click();
  await page.getByRole('button', { name: 'Manage categories', exact: true }).click();
  const categories = page.getByRole('dialog', { name: 'Manage categories', exact: true });
  await categories.getByRole('textbox', { name: 'New category', exact: true }).fill('Assessment');
  await categories.getByRole('button', { name: 'Add category', exact: true }).click();
  await categories.getByText('Category saved.', { exact: true }).waitFor();
  const categoryId = state.categories[0].id;
  await categories.getByRole('button', { name: 'Rename category Assessment', exact: true }).click();
  await categories.getByRole('textbox', { name: 'Rename category', exact: true }).fill('Testing');
  await categories.getByRole('button', { name: 'Save category', exact: true }).click();
  await categories.getByRole('button', { name: 'Rename category Testing', exact: true }).waitFor();
  const categoryArtifactDir = path.resolve(root, '..', 'soc2-evidence', 'validation', 'supervision-directory', 'browser');
  await mkdir(categoryArtifactDir, { recursive: true });
  for (const [size, viewport] of [['desktop', { width: 1365, height: 768 }], ['mobile', { width: 390, height: 667 }]]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      const bounds = await categories.boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1);
      assert.equal(await categories.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await page.screenshot({ path: path.join(categoryArtifactDir, `categories-${size}-${theme}.png`), animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1365, height: 768 });

  assert.deepEqual(state.categoryWrites[1].body, { name: 'Testing', updatedAt: '2026-09-08T13:00:00.000Z' });
  await categories.getByRole('button', { name: 'Close categories', exact: true }).click();
  await page.getByLabel('Filter group category', { exact: true }).selectOption('uncategorized');
  await page.getByRole('button', { name: 'New Group', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Create Supervision Group', exact: true });
  await editor.getByLabel('Name', { exact: true }).fill('Category Test Room');
  await editor.getByLabel('Category', { exact: true }).selectOption(categoryId);
  state.groupsMode = 'error';
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('status').filter({ hasText: 'Supervision group “Category Test Room” saved. Some lists could not refresh.' }).waitFor();
  assert.equal(state.writes.length, 1, 'A committed save with failed refresh closes and reports success separately');
  assert.equal(state.writes[0].body.categoryId, categoryId);
  state.groupsMode = 'success';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'The saved group is not on this page. Your filters are preserved' }).waitFor();
  assert.equal(await page.getByLabel('Filter group category', { exact: true }).inputValue(), 'uncategorized', 'Saving outside a filter keeps the administrator’s current view');
  await page.getByLabel('Filter group category', { exact: true }).selectOption('');
  await page.getByTestId('supervision-group-testing').getByText(/0 students · Testing/).waitFor();
  assert.equal(state.writes.length, 1, 'Refresh retries only reading the list');
  state.detailMode = 'error';
  const editOpener = page.getByTestId('supervision-group-testing').getByRole('button', { name: 'Edit', exact: true });
  await editOpener.click();
  const edit = page.getByRole('dialog', { name: 'Edit Supervision Group', exact: true });
  await edit.getByText('This group could not load.', { exact: true }).waitFor();
  assert.equal(await edit.getByRole('button', { name: 'Save', exact: true }).count(), 0, 'Editing never falls back to a rosterless summary');
  state.detailMode = 'success';
  await edit.getByRole('button', { name: 'Retry group', exact: true }).click();
  await edit.getByLabel('Name', { exact: true }).waitFor();
  assert.equal(await edit.getByLabel('Category', { exact: true }).inputValue(), categoryId);
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(element => element === document.activeElement, await editOpener.elementHandle());
  assert.equal(await editOpener.evaluate(element => element === document.activeElement), true, 'The detail loading step preserves the edit opener for focus restoration');
  await page.getByRole('button', { name: 'Manage categories', exact: true }).click();
  const deleteOpener = categories.getByRole('button', { name: 'Delete category Testing', exact: true });
  await deleteOpener.click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete category?', exact: true });
  await confirm.getByText(/Its 1 group will move to Uncategorized/).waitFor();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(state.categoryWrites.length, 2);
  await deleteOpener.click();
  state.categoryMode = 'stale';
  await confirm.getByRole('button', { name: 'Delete category', exact: true }).click();
  await confirm.getByRole('alert').filter({ hasText: 'This category changed.' }).waitFor();
  assert.equal(state.groups.length, 1);
  state.categoryMode = 'success';
  await confirm.getByRole('button', { name: 'Delete category', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await categories.getByText('Category deleted. Its groups are now Uncategorized.', { exact: true }).waitFor();
  await categories.getByRole('button', { name: 'Close categories', exact: true }).click();
  await page.getByTestId('supervision-group-testing').getByText(/0 students · Uncategorized/).waitFor();
  assert.equal(state.groups.length, 1); assert.equal(state.groups[0].categoryId, null);
  assert.deepEqual(state.errors, []);
});


test('a late group save stays scoped to its original school and cannot close or replace a new school group draft', { timeout: 60_000 }, async context => {
  const otherGroup = deletionGroup('other-group', 'Other School Group');
  const { page, state, dialog } = await fixture(context, { otherGroups: [otherGroup] });
  await dialog.getByLabel('Name', { exact: true }).fill('Prior School Creation');
  state.groupWriteMode = 'pending';
  const started = new Promise(resolve => { state.groupWriteStarted = resolve; });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await started;
  assert.equal(state.writes[0].schoolId, 'school');
  assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true);
  await page.evaluate(() => window.__switchCoverageSchool('other-school'));
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText(otherGroup.name, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New Group', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Current School Draft');
  const before = state.reads.filter(read => read.schoolId === 'other-school').length;
  state.groupWriteMode = 'success'; state.releaseGroupWrite(); state.releaseGroupWrite = null;
  await page.waitForLoadState('networkidle');
  assert.equal(await dialog.getByLabel('Name', { exact: true }).inputValue(), 'Current School Draft');
  assert.deepEqual(state.otherGroups, [otherGroup]);
  assert.equal(state.groups[0].name, 'Prior School Creation');
  assert.equal(state.reads.filter(read => read.schoolId === 'other-school').length, before, 'Original-school refresh cannot invalidate the new school editor data');
  assert.equal(await page.getByText(/Prior School Creation.*saved/).count(), 0);
  assert.deepEqual(state.errors, []);
});
