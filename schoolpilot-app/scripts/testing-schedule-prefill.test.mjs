import assert from 'node:assert/strict';
import test from 'node:test';
import { testingScheduleNavigation, readTestingSchedulePrefill, testingGroupDraft } from '../src/products/classpilot/lib/testingSchedulePrefill.js';

test('testing shortcut is bound to the school, actor, administrator role and a short lifetime', () => {
  const scope = { schoolId: 'school', actorId: 'admin', isAdmin: true };
  const navigation = testingScheduleNavigation({ ...scope, groupId: 'group' }, 1000);
  assert.equal(navigation.pathname, '/classpilot/admin/scheduling');
  assert.equal(readTestingSchedulePrefill(navigation.state, scope, 1001)?.groupId, 'group');
  for (const mismatch of [{ schoolId: 'other' }, { actorId: 'other' }, { isAdmin: false }]) {
    assert.equal(readTestingSchedulePrefill(navigation.state, { ...scope, ...mismatch }, 1001), null);
  }
  assert.equal(readTestingSchedulePrefill(navigation.state, scope, 1000 + 16 * 60_000), null);
  assert.equal(readTestingSchedulePrefill(navigation.state, scope, 999), null);
  assert.equal(testingScheduleNavigation({ ...scope, groupId: '' }), null);
});

test('fresh catalog seeds only a new testing draft with explicit times and unchanged class schedules', () => {
  const catalog = { supervisionGroups: [{ id: 'group', name: 'MAP test', staffIds: ['teacher'] }], staff: [{ id: 'teacher' }] };
  const before = structuredClone(catalog);
  const draft = testingGroupDraft(catalog, 'group', 'block');
  assert.deepEqual(draft.classIds, []);
  assert.deepEqual(draft.classRules, []);
  assert.deepEqual(draft.testingBlocks, [{ id: 'block', name: 'MAP test', coverageGroupId: 'group', assignedStaffId: 'teacher', startTime: '', endTime: '' }]);
  assert.equal(draft.dates, undefined);
  assert.deepEqual(catalog, before);
  assert.throws(() => testingGroupDraft(catalog, 'removed-group'), /no longer available/);
  catalog.supervisionGroups[0].staffIds = ['unavailable'];
  assert.equal(testingGroupDraft(catalog, 'group').testingBlocks[0].assignedStaffId, '');
});
