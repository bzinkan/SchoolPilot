import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addDesk, assignStudent, createLayout, emptyLayoutCopy, moveDesk, reconcileRoster, removeDesk, rosterChanges, shuffleSeats, toggleSeatLock, unassignedStudents, unassignStudent, validateLayout } from '../src/products/classpilot/lib/seatingModel.js';

const roster = [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bea' }, { id: 'c', name: 'Cam' }];
const room = count => createLayout('rows', count, randomUUID);
test('all presets fit rosters from zero to 100 without collisions', () => {
  for (const preset of ['rows', 'pairs', 'groups']) for (let count = 0; count <= 100; count++) {
    const layout = createLayout(preset, count, randomUUID);
    assert.equal(layout.seats.length, count);
    assert.equal(validateLayout(layout), null);
  }
  assert.deepEqual(createLayout('blank', 150), { version: 1, seats: [] });
  assert.throws(() => room(101), /100 desks/);
});
test('manual assignment swaps seated students and displaces a tray target occupant', () => {
  const original = room(3); const [a, b, c] = original.seats.map(seat => seat.id);
  let layout = assignStudent(original, a, 'a');
  layout = assignStudent(layout, b, 'b');
  layout = assignStudent(layout, b, 'a');
  assert.deepEqual(layout.seats.map(seat => seat.studentId), ['b', 'a', null]);
  layout = assignStudent(layout, b, 'c');
  assert.deepEqual(unassignedStudents(layout, roster).map(student => student.id), ['a']);
  layout = assignStudent(layout, c, 'c');
  assert.deepEqual(layout.seats.map(seat => seat.studentId), ['b', null, 'c']);
  layout = unassignStudent(layout, a);
  assert.deepEqual(unassignedStudents(layout, roster).map(student => student.id), ['a', 'b']);
  assert.ok(original.seats.every(seat => !seat.studentId));
});
test('locks prevent changing the occupant but travel when moving the desk', () => {
  const original = room(3); const [a, b] = original.seats.map(seat => seat.id);
  const layout = toggleSeatLock(assignStudent(original, a, 'a'), a);
  assert.throws(() => assignStudent(layout, a, 'b'), /Unlock/);
  assert.throws(() => assignStudent(layout, b, 'a'), /Unlock/);
  assert.throws(() => unassignStudent(layout, a), /Unlock/);
  assert.throws(() => removeDesk(layout, a), /Unlock/);
  const moved = moveDesk(layout, a, 55, 206);
  assert.deepEqual(moved.seats[0], { ...layout.seats[0], x: 60, y: 210 });
  assert.equal(layout.seats[0].y, 30);
  assert.throws(() => toggleSeatLock(original, b), /Place a student/);
});
test('shuffle includes tray students and empty desks while preserving locked assignments', () => {
  const original = room(5); const a = original.seats[0].id;
  const layout = toggleSeatLock(assignStudent(original, a, 'a'), a);
  for (let run = 0; run < 50; run++) {
    const shuffled = shuffleSeats(layout, roster);
    assert.deepEqual(shuffled.seats[0], layout.seats[0]);
    assert.deepEqual(shuffled.seats.map(seat => seat.studentId).filter(Boolean).sort(), ['a', 'b', 'c']);
    assert.equal(unassignedStudents(shuffled, roster).length, 0);
    assert.equal(validateLayout(shuffled), null);
  }
  assert.throws(() => shuffleSeats(room(2), roster), /whole roster/);
  assert.equal(layout.seats[1].studentId, null);
});
test('desk geometry rejects collisions and edges and adding/removing retains other assignments', () => {
  const original = room(3); const id = original.seats[0].id;
  assert.throws(() => moveDesk(original, id, 160, 30), /overlap/);
  assert.throws(() => moveDesk(original, id, -20, 30), /inside/);
  assert.throws(() => moveDesk(original, id, 30, 850), /inside/);
  assert.throws(() => addDesk(room(100)), /100 desks/);
  const assigned = assignStudent(original, id, 'a');
  const next = addDesk(assigned, randomUUID);
  assert.equal(next.seats.length, 4);
  assert.equal(next.seats[0].studentId, 'a');
  const removed = removeDesk(next, id);
  assert.equal(removed.seats.length, 3);
  assert.deepEqual(unassignedStudents(removed, roster), roster);
  assert.equal(assigned.seats.length, 3);
});
test('roster reconciliation is a draft update preserving remaining seats and removing departed locks', () => {
  let layout = room(3); const [a, b] = layout.seats.map(seat => seat.id);
  layout = assignStudent(layout, a, 'a');
  layout = toggleSeatLock(assignStudent(layout, b, 'b'), b);
  const current = [{ id: 'a', name: 'Alexander' }, { id: 'c', name: 'Cam' }, { id: 'd', name: 'Dee' }];
  const expected = { added: [current[2]], removed: [roster[1]], renamed: [{ id: 'a', before: 'Alex', after: 'Alexander' }] };
  assert.deepEqual(rosterChanges(roster, current), expected);
  const result = reconcileRoster(layout, roster, current);
  assert.deepEqual(result.changes, expected);
  assert.equal(result.layout.seats[0].studentId, 'a');
  assert.equal(result.layout.seats[1].studentId, null);
  assert.equal(result.layout.seats[1].locked, false);
  assert.equal(layout.seats[1].locked, true);
  assert.deepEqual(unassignedStudents(result.layout, current).map(student => student.id), ['c', 'd']);
  const empty = emptyLayoutCopy(layout);
  assert.ok(empty.seats.every(seat => !seat.studentId && !seat.locked));
  assert.deepEqual(empty.seats.map(({ x, y }) => ({ x, y })), layout.seats.map(({ x, y }) => ({ x, y })));
});
