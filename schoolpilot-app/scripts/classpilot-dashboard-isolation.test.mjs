import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createSubgroupMembersQuery,
  subgroupMembersQueryKey,
} from '../src/products/classpilot/lib/subgroupMembersQuery.js';

test('subgroup membership queries are fenced by group and subgroup identity', async () => {
  assert.notDeepEqual(
    subgroupMembersQueryKey('group-a', 'subgroup-1'),
    subgroupMembersQueryKey('group-b', 'subgroup-1'),
  );
  assert.notDeepEqual(
    subgroupMembersQueryKey('group-a', 'subgroup-1'),
    subgroupMembersQueryKey('group-a', 'subgroup-2'),
  );

  const signal = new AbortController().signal;
  const calls = [];
  const query = createSubgroupMembersQuery({
    groupId: 'group-a',
    subgroupId: 'subgroup-1',
    requestApi: async (...args) => {
      calls.push(args);
      return { members: [{ studentId: 'student-1' }, 'student-2', null] };
    },
  });

  assert.equal(query.enabled, true);
  assert.deepEqual(await query.queryFn({ signal }), ['student-1', 'student-2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'GET');
  assert.equal(calls[0][1], '/subgroups/subgroup-1/members');
  assert.equal(calls[0][3].signal, signal);
});

test('dashboard owns one Live View portal without global video selectors', async () => {
  const [dashboard, tile, portal, sidebar] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/VideoPortal.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/ClassPilotSidebar.jsx', import.meta.url), 'utf8'),
  ]);

  assert.equal(dashboard.match(/<VideoPortal/g)?.length, 1, 'dashboard must render exactly one Live View portal');
  assert.doesNotMatch(tile, /<VideoPortal|querySelector|portal-video-slot/);
  assert.doesNotMatch(portal, /querySelector|portal-video-slot/);
  assert.match(portal, /stream=|srcObject = stream/);
  assert.match(sidebar, /isOpen \? \(/, 'closed sidebar must not mount polling mini views');
});

test('dashboard renews observation only for a visible exact scope and virtualizes tile work', async () => {
  const [dashboard, lease, viewport, tile] = await Promise.all([
    readFile(new URL('../src/products/classpilot/pages/Dashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/hooks/useObservationLease.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/hooks/useTileViewport.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/products/classpilot/components/StudentTile.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(dashboard, /useObservationLease\(/);
  assert.match(dashboard, /kind: 'class'/);
  assert.match(dashboard, /kind: 'students', studentIds/);
  assert.match(lease, /observation-lease/);
  assert.match(lease, /document\.visibilityState !== 'visible'/);
  assert.match(lease, /setTimeout\(renew/);
  assert.match(lease, /apiRequest\('DELETE'/);
  assert.match(dashboard, /paused_unobserved/);
  assert.match(viewport, /IntersectionObserver/);
  assert.match(viewport, /rootMargin: '100% 0px'/);
  assert.match(dashboard, /nearViewportStudentIds\.has/);
  assert.match(tile, /export default memo\(StudentTile, studentTilePropsEqual\)/);
});
