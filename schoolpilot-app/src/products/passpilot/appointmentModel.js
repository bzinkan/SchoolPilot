const DAY_MS = 24 * 60 * 60 * 1000;

function wallParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = type => Number(parts.find(part => part.type === type)?.value);
  return [get('year'), get('month'), get('day'), get('hour'), get('minute'), get('second')];
}

function partsEpoch(parts) {
  return Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5] || 0);
}

export function schoolWallTime(value, timeZone) {
  const [year, month, day, hour, minute] = wallParts(value, timeZone);
  const pad = number => String(number).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

// Find real instants for a school-local wall time. A gap has none; a fold has
// two. This never lets the workstation timezone silently choose an occurrence.
export function schoolWallTimeCandidates(value, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) return [];
  const parts = match.slice(1).map(Number);
  if (parts[0] < 1000 || parts[3] > 23 || parts[4] > 59) return [];
  const naive = partsEpoch(parts), date = new Date(naive);
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() + 1 !== parts[1] || date.getUTCDate() !== parts[2]) return [];
  const offsets = new Set();
  // Sampling either side discovers the offsets on both sides of a transition.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 60 * 60 * 1000;
    offsets.add(partsEpoch(wallParts(sample, timeZone)) - sample);
  }
  const candidates = [];
  for (const offset of offsets) {
    const instant = naive - offset;
    if (schoolWallTime(instant, timeZone) !== value) continue;
    const minutes = Math.abs(offset / 60000), pad = number => String(number).padStart(2, '0');
    candidates.push({ instant: new Date(instant).toISOString(), offset: `${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` });
  }
  return candidates.sort((a, b) => a.instant.localeCompare(b.instant));
}

export function chosenSchoolInstant(wallTime, selected, timeZone) {
  const candidates = schoolWallTimeCandidates(wallTime, timeZone);
  if (!candidates.length) throw new Error('Choose a real date and time in the school timezone. This time may fall in a daylight saving gap.');
  if (candidates.length === 1) return candidates[0].instant;
  if (!candidates.some(candidate => candidate.instant === selected)) throw new Error('This clock time occurs twice. Choose the intended UTC offset.');
  return selected;
}

export function appointmentReminderRange(now = Date.now()) {
  return { from: new Date(now - DAY_MS).toISOString(), through: new Date(now + 7 * DAY_MS).toISOString(), status: 'scheduled' };
}

export function shiftSchoolDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) throw new Error('Choose a valid date range.');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function schoolDateBoundary(date, timeZone) {
  // A date filter starts at the first real minute of the local date, including
  // zones whose daylight-saving gap occurs at midnight. Appointment wall times
  // still require an exact choice and are never adjusted this way.
  for (let minute = 0; minute < 1440; minute++) {
    const hour = String(Math.floor(minute / 60)).padStart(2, '0'), minutes = String(minute % 60).padStart(2, '0');
    const candidates = schoolWallTimeCandidates(`${date}T${hour}:${minutes}`, timeZone);
    if (candidates.length) return candidates[0].instant;
  }
  throw new Error('Choose a date that exists in the school timezone.');
}

export function currentClassReminders(rows, students, now = Date.now()) {
  const studentIds = new Set(students.map(student => student.id));
  return rows.filter(row => row.status === 'scheduled' && new Date(row.endsAt).getTime() > now && studentIds.has(row.studentId));
}

export async function loadAppointmentPages(request, params, signal) {
  const rows = [], seen = new Set();
  let cursor;
  for (let page = 0; page < 200; page++) {
    signal?.throwIfAborted();
    const result = await request({ ...params, limit: 100, ...(cursor ? { cursor } : {}) }, signal);
    if (!Array.isArray(result?.appointments)) throw new Error('Appointments could not be loaded. Try again.');
    rows.push(...result.appointments);
    if (result.nextCursor === null) return rows;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) throw new Error('Appointment pagination did not advance. Try again.');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new Error('Too many appointments to load safely. Choose a shorter date range.');
}
