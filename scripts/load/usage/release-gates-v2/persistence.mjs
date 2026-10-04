import assert from 'node:assert/strict';
export function checkPersistence(before, after, traffic, fixture) {
  const key = row => `${row.school_id}:${row.student_id}`;
  const prior = new Map(before.rows.map(row => [key(row), row.count]));
  const expected = new Map();
  for (const result of [traffic.heartbeats ?? traffic, traffic.reconnect].filter(Boolean)) {
    assert.ok(result.bindings && typeof result.bindings === 'object');
    for (const [binding, counts] of Object.entries(result.bindings)) {
      const [schoolIndex, studentIndex] = binding.split(':').map(Number), school = fixture.schools[schoolIndex];
      assert.ok(school?.students[studentIndex]); assert.ok(Number.isSafeInteger(counts.acknowledged200) && counts.acknowledged200 >= 0);
      const identity = `${school.id}:${school.students[studentIndex]}`;
      expected.set(identity, (expected.get(identity) ?? 0) + counts.acknowledged200);
    }
  }
  let exact = true, total = 0;
  for (const row of after.rows) {
    const identity = key(row), delta = row.count - (prior.get(identity) ?? 0); total += delta;
    exact &&= delta === (expected.get(identity) ?? 0) && row.invalid === 0;
    expected.delete(identity); prior.delete(identity);
  }
  exact &&= [...expected.values()].every(count => count === 0) && [...prior.values()].every(count => count === 0);
  return { passed: exact && after.invalid === 0 && before.invalid === 0, total, perBindingCompared: true,
    fixtureBindings: 'exact school/student/device/active-session tuple', invalid: after.invalid };
}
