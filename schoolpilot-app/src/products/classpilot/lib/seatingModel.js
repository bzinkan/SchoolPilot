export const ROOM_WIDTH = 1200;
export const ROOM_HEIGHT = 900;
export const DESK_WIDTH = 100;
export const DESK_HEIGHT = 60;
export const GRID = 10;
export const MAX_SEATS = 100;
const uuid = () => crypto.randomUUID();
const overlap = (a, b) => a.x < b.x + DESK_WIDTH && a.x + DESK_WIDTH > b.x && a.y < b.y + DESK_HEIGHT && a.y + DESK_HEIGHT > b.y;
const copy = layout => ({ version: 1, seats: layout.seats.map(seat => ({ ...seat })) });

export function validateLayout(layout) {
  if (layout?.version !== 1 || !Array.isArray(layout.seats)) return 'This room layout is not supported.';
  if (layout.seats.length > MAX_SEATS) return 'A chart can have at most 100 desks.';
  const ids = new Set();
  const students = new Set();
  for (let i = 0; i < layout.seats.length; i++) {
    const seat = layout.seats[i];
    if (!seat.id || ids.has(seat.id)) return 'Each desk needs a unique ID.';
    ids.add(seat.id);
    if (!Number.isInteger(seat.x) || !Number.isInteger(seat.y) || seat.x % GRID || seat.y % GRID ||
      seat.x < 0 || seat.y < 0 || seat.x > ROOM_WIDTH - DESK_WIDTH || seat.y > ROOM_HEIGHT - DESK_HEIGHT) return 'Keep desks inside the room and on the grid.';
    if (seat.studentId && students.has(seat.studentId)) return 'A student can occupy only one desk.';
    if (seat.studentId) students.add(seat.studentId);
    if (seat.locked && !seat.studentId) return 'Only an assigned seat can be locked.';
    if (layout.seats.slice(0, i).some(other => overlap(seat, other))) return 'Desks cannot overlap.';
  }
  return null;
}
const checked = layout => {
  const error = validateLayout(layout);
  if (error) throw new Error(error);
  return layout;
};
const find = (layout, id) => {
  const seat = layout.seats.find(item => item.id === id);
  if (!seat) throw new Error('Select a desk first.');
  return seat;
};

export function createLayout(preset, count, idFactory = uuid) {
  if (!['rows', 'pairs', 'groups', 'blank'].includes(preset)) throw new Error('Choose a starting layout.');
  if (!Number.isInteger(count) || count < 0) throw new Error('The roster size is invalid.');
  if (preset === 'blank') return { version: 1, seats: [] };
  if (count > MAX_SEATS) throw new Error('A chart supports at most 100 desks. Start with a blank room for this roster.');
  return checked({ version: 1, seats: Array.from({ length: count }, (_, index) => {
    let x; let y;
    if (preset === 'groups') {
      const pod = Math.floor(index / 4); const place = index % 4;
      x = 10 + (pod % 5) * 240 + (place % 2) * 100;
      y = 30 + Math.floor(pod / 5) * 170 + Math.floor(place / 2) * 60;
    } else if (preset === 'pairs') {
      const pair = Math.floor(index / 2);
      x = 10 + (pair % 5) * 240 + (index % 2) * 100;
      y = 30 + Math.floor(pair / 5) * 80;
    } else {
      x = 50 + (index % 10) * 110;
      y = 30 + Math.floor(index / 10) * 80;
    }
    return { id: idFactory(), x, y, studentId: null, locked: false };
  }) });
}

export function addDesk(layout, idFactory = uuid) {
  if (layout.seats.length >= MAX_SEATS) throw new Error('A chart can have at most 100 desks.');
  for (let y = 0; y <= ROOM_HEIGHT - DESK_HEIGHT; y += GRID) {
    for (let x = 0; x <= ROOM_WIDTH - DESK_WIDTH; x += GRID) {
      const candidate = { x, y };
      if (!layout.seats.some(seat => overlap(candidate, seat))) return checked({ version: 1, seats: [...layout.seats, { id: idFactory(), x, y, studentId: null, locked: false }] });
    }
  }
  throw new Error('There is no free space for another desk. Move or remove a desk first.');
}
export function moveDesk(layout, seatId, x, y) {
  const next = copy(layout); const seat = find(next, seatId);
  seat.x = Math.round(x / GRID) * GRID; seat.y = Math.round(y / GRID) * GRID;
  return checked(next);
}
export function removeDesk(layout, seatId) {
  if (find(layout, seatId).locked) throw new Error('Unlock the seat before removing its desk.');
  return { version: 1, seats: layout.seats.filter(seat => seat.id !== seatId).map(seat => ({ ...seat })) };
}
export function assignStudent(layout, seatId, studentId) {
  if (!studentId) throw new Error('Choose a student.');
  const next = copy(layout); const target = find(next, seatId);
  const source = next.seats.find(seat => seat.studentId === studentId);
  if (source?.id === target.id) return next;
  if (target.locked || source?.locked) throw new Error('Unlock the seat before changing its student.');
  if (source) source.studentId = target.studentId;
  target.studentId = studentId;
  return checked(next);
}
export function unassignStudent(layout, seatId) {
  const next = copy(layout); const seat = find(next, seatId);
  if (seat.locked) throw new Error('Unlock the seat before returning its student to the tray.');
  seat.studentId = null;
  return next;
}
export function toggleSeatLock(layout, seatId) {
  const next = copy(layout); const seat = find(next, seatId);
  if (!seat.studentId) throw new Error('Place a student before locking this seat.');
  seat.locked = !seat.locked;
  return next;
}
export function shuffleSeats(layout, roster, random = Math.random) {
  if (layout.seats.length < roster.length) throw new Error('Add enough desks for the whole roster before shuffling.');
  const next = copy(layout);
  const locked = new Set(next.seats.filter(seat => seat.locked).map(seat => seat.studentId));
  const students = roster.filter(student => !locked.has(student.id)).map(student => student.id);
  const open = next.seats.filter(seat => !seat.locked);
  const slots = [...students, ...Array(Math.max(0, open.length - students.length)).fill(null)];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  open.forEach((seat, index) => { seat.studentId = slots[index]; });
  return checked(next);
}
export function emptyLayoutCopy(layout) {
  return { version: 1, seats: layout.seats.map(seat => ({ ...seat, studentId: null, locked: false })) };
}
export function unassignedStudents(layout, roster) {
  const assigned = new Set(layout.seats.map(seat => seat.studentId));
  return roster.filter(student => !assigned.has(student.id));
}
export function rosterChanges(saved, current) {
  const before = new Map(saved.map(student => [student.id, student]));
  const after = new Map(current.map(student => [student.id, student]));
  return {
    added: current.filter(student => !before.has(student.id)),
    removed: saved.filter(student => !after.has(student.id)),
    renamed: current.filter(student => before.has(student.id) && before.get(student.id).name !== student.name)
      .map(student => ({ id: student.id, before: before.get(student.id).name, after: student.name })),
  };
}
export function reconcileRoster(layout, saved, current) {
  const ids = new Set(current.map(student => student.id));
  return {
    layout: { version: 1, seats: layout.seats.map(seat => seat.studentId && !ids.has(seat.studentId)
      ? { ...seat, studentId: null, locked: false } : { ...seat }) },
    changes: rosterChanges(saved, current),
  };
}
