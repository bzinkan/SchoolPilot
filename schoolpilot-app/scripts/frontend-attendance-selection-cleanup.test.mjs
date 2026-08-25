import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('attendance authoring is hidden while passive absence context remains active', async () => {
  const [classPilotDashboard, goPilotTeacher] = await Promise.all([
    read('src/products/classpilot/pages/Dashboard.jsx'),
    read('src/products/gopilot/pages/TeacherView.jsx'),
  ]);

  for (const source of [classPilotDashboard, goPilotTeacher]) {
    assert.doesNotMatch(source, /AttendancePanel|showAttendance|button-attendance/);
    assert.match(source, /useAbsentStudents/);
  }

  assert.match(classPilotDashboard, /absentIds\.has\(student\.studentId\)/);
  assert.match(goPilotTeacher, /unavailableIds\.has\(student\.id\)/);
  assert.match(goPilotTeacher, /attendanceStatusByStudent\[student\.id\]/);
});

test('the retired ClassPilot attendance route redirects without loading its page', async () => {
  const app = await read('src/App.jsx');

  assert.doesNotMatch(app, /CPAdminAttendance|import\(['"]\.\/products\/classpilot\/pages\/AdminAttendance['"]\)/);
  assert.match(
    app,
    /path=["']\/classpilot\/admin\/attendance["'][^>]+<Navigate to=["']\/classpilot\/admin["'] replace/,
  );
});

test('ClassPilot classroom choices are restored per user and school and revalidated', async () => {
  const dashboard = await read('src/products/classpilot/pages/Dashboard.jsx');

  assert.match(dashboard, /classpilot:classroom-selection:v1/);
  assert.match(dashboard, /sessionStorage\?\.getItem\(storageKey\)/);
  assert.match(dashboard, /storage\.setItem\(storageKey, groupId\)/);
  assert.match(dashboard, /storage\.removeItem\(storageKey\)/);
  assert.match(dashboard, /classroomSelectionStorageKey\("teacher", currentUser\?\.id, school\?\.id\)/);
  assert.match(dashboard, /classroomSelectionStorageKey\("admin", currentUser\?\.id, school\?\.id\)/);
  assert.match(dashboard, /if \(!groupsLoaded \|\| !teacherClassroomSelectionKey\) return/);
  assert.match(dashboard, /if \(!isAdmin \|\| !adminTeachingGroupsLoaded \|\| !adminClassroomSelectionKey\) return/);
  assert.match(dashboard, /groups\.some\(\(group\) => group\.id === storedGroupId\)/);
  assert.match(dashboard, /adminTeachingGroups\.some\(\(group\) => group\.id === storedGroupId\)/);

  const keyBuilder = dashboard.slice(
    dashboard.indexOf('function classroomSelectionStorageKey'),
    dashboard.indexOf('function readClassroomSelection'),
  );
  assert.doesNotMatch(keyBuilder, /email|displayName|schoolName/);
});
