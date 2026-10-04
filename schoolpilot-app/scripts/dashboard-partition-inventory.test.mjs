import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
function inventory(partition) {
  const child = spawnSync(process.execPath, ['scripts/classpilot-dashboard-load-state.test.mjs'], { encoding: 'utf8',
    env: { ...process.env, CLASSPILOT_DASHBOARD_LIST_ONLY: '1', CLASSPILOT_DASHBOARD_TEST_PARTITION: partition || '' } });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split(/\r?\n/).find(value => value.startsWith('DASHBOARD_TEST_INVENTORY '));
  assert.ok(line, 'the actual file lists its parent registrations without launching browsers');
  return JSON.parse(line.slice('DASHBOARD_TEST_INVENTORY '.length));
}
test('the two actual Dashboard partitions execute every registered parent exactly once', () => {
  const all = inventory(), first = inventory('1'), second = inventory('2');
  assert.deepEqual(first.registeredNames, all.registeredNames); assert.deepEqual(second.registeredNames, all.registeredNames);
  assert.ok(all.registeredNames.length > 60);
  const counts = new Map();
  for (const name of [...first.selectedNames, ...second.selectedNames]) counts.set(name, (counts.get(name) || 0) + 1);
  assert.equal(counts.size, all.registeredNames.length);
  for (const name of all.registeredNames) assert.equal(counts.get(name), 1, name);
  assert.ok(first.selectedNames.length > 0 && second.selectedNames.length > 0);
  console.log(`Dashboard parents: ${all.registeredNames.length}; partitions ${first.selectedNames.length}/${second.selectedNames.length}; nested cases remain with their parent.`);
});
